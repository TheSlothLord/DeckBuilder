import type { DeckLayout, Notch, Row } from '../model/types';

interface Props {
  layout: DeckLayout;
  endGap: number;
}

const TARGET_W = 820; // px the deck length is scaled to
const EPS = 1e-6;

/** Corner-notched (L-shape) outline as point pairs in deck coords, clockwise. */
function lOutlinePoints(L: number, W: number, n: Notch): Array<[number, number]> {
  const left = n.x < EPS; // notch hugs the left edge
  const top = n.y < EPS; // notch hugs the top edge
  const w = n.w;
  const h = n.h;
  if (top && left) return [[w, 0], [L, 0], [L, W], [0, W], [0, h], [w, h]];
  if (top && !left) return [[0, 0], [L - w, 0], [L - w, h], [L, h], [L, W], [0, W]];
  if (!top && left) return [[0, 0], [L, 0], [L, W], [w, W], [w, W - h], [0, W - h]];
  return [[0, 0], [L, 0], [L, W - h], [L - w, W - h], [L - w, W], [0, W]]; // bottom-right
}

export function DeckCanvas({ layout, endGap }: Props) {
  // A degenerate deck (e.g. a custom polygon mid-edit) has no drawable size.
  if (!(layout.lengthMm > 0) || !(layout.widthMm > 0)) {
    return (
      <svg viewBox="0 0 400 60" width="100%" style={{ maxWidth: 400, display: 'block' }} role="img" aria-label={`Plank layout for ${layout.label}`}>
        <text x={8} y={34} fontSize={13} fill="var(--muted)">No drawable area — check this deck's size or corner points.</text>
      </svg>
    );
  }
  const s = TARGET_W / layout.lengthMm; // px per mm
  const padX = 8;
  const padTop = 8;
  const pw = layout.plankWidthMm;
  const fi = layout.fieldInsetMm || 0; // border depth
  const fieldW = layout.widthMm - 2 * fi;

  // field origin in px, and helpers to map field-local mm -> px
  const fox = padX + fi * s;
  const foy = padTop + fi * s;
  const fieldBottomY = foy + fieldW * s;

  // The drawing can extend past the field (rip cut-off / overhanging extra board).
  const fieldContentBottom = layout.rows.reduce((b, r) => {
    const extent = r.kind === 'rip' || r.kind === 'extra' ? r.yStartMm + pw : r.yStartMm + r.widthMm;
    return Math.max(b, extent);
  }, fieldW);
  const contentBottom = Math.max(layout.widthMm, fi + fieldContentBottom);

  const w = layout.lengthMm * s + padX * 2;
  const h = contentBottom * s + padTop * 2;
  const seamGapPx = Math.max(1.5, endGap * s);
  const planks = layout.rows.filter((r) => r.kind !== 'gap');
  const outlinePts = layout.polygon
    ? layout.polygon.map((p) => `${padX + p.x * s},${padTop + p.y * s}`).join(' ')
    : layout.notch
    ? lOutlinePoints(layout.lengthMm, layout.widthMm, layout.notch)
        .map(([x, y]) => `${padX + x * s},${padTop + y * s}`)
        .join(' ')
    : null;
  // Custom polygons clip the planking/seam/joist layer to the outline.
  const clipId = `deckclip-${layout.deckId}`;
  const clip = layout.polygon ? `url(#${clipId})` : undefined;

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      width="100%"
      style={{ maxWidth: w, display: 'block' }}
      role="img"
      aria-label={`Plank layout for ${layout.label}`}
    >
      {layout.polygon && (
        <defs>
          <clipPath id={clipId}>
            <polygon points={outlinePts ?? ''} />
          </clipPath>
        </defs>
      )}

      {/* deck outline (L-shape = notched polygon; custom = arbitrary polygon) */}
      {outlinePts ? (
        <polygon points={outlinePts} fill="none" stroke="var(--line)" />
      ) : (
        <rect x={padX} y={padTop} width={layout.lengthMm * s} height={layout.widthMm * s} fill="none" stroke="var(--line)" />
      )}

      {/* perimeter border boards (mitred = polygon, butt = rect) */}
      {layout.borderBoards.map((bb, i) => {
        const x = padX + bb.x * s;
        const y = padTop + bb.y * s;
        const bw = bb.w * s;
        const bh = bb.h * s;
        const vertical = bb.h > bb.w;
        const thin = Math.min(bw, bh);
        const fs = Math.min(11, thin * 0.5);
        const showName = thin > 9 && Math.max(bw, bh) > bb.name.length * fs * 0.62;
        const cx = x + bw / 2;
        const cy = y + bh / 2;
        const fill = bb.reusedOffcut ? 'var(--plank-alt)' : 'var(--plank)';
        const title = <title>{bb.name} (border) · {bb.lengthMm} mm · stock {bb.barId}{bb.reusedOffcut ? ' (offcut)' : ''}</title>;
        const ptsPx = bb.points
          ? bb.points.split(' ').map((p) => { const [mx, my] = p.split(',').map(Number); return `${padX + mx * s},${padTop + my * s}`; }).join(' ')
          : null;
        return (
          <g key={`bb${i}`}>
            {ptsPx ? (
              <polygon points={ptsPx} fill={fill} stroke="var(--plank-edge)" strokeWidth={0.6}>{title}</polygon>
            ) : (
              <rect x={x} y={y} width={bw} height={bh} rx={1} fill={fill} stroke="var(--plank-edge)" strokeWidth={0.6}>{title}</rect>
            )}
            {showName && (
              <text x={cx} y={cy} fontSize={fs} fill="var(--plank-text)" textAnchor="middle" dominantBaseline="central"
                pointerEvents="none" transform={vertical ? `rotate(-90 ${cx} ${cy})` : undefined}>
                {bb.name}
              </text>
            )}
          </g>
        );
      })}

      {/* clipped layer: planks, edge overlays, joists and seams.
          For a custom polygon this trims everything to the outline. */}
      <g clipPath={clip}>
      {/* plank rows (everything except gaps) */}
      {planks.map((row) => {
        const y = foy + row.yStartMm * s;
        const rh = row.widthMm * s;
        const rowEnd = row.xStartMm + row.runLengthMm; // shortened for L-shape notch rows
        return (
          <g key={`r${row.index}`}>
            {row.segments.map((seg, i) => {
              // Custom shapes carry physical draw extents (incl. bevel overhang).
              const x0 = seg.drawStartMm ?? seg.startMm;
              const x1 = seg.drawEndMm ?? (i < row.segments.length - 1 ? row.segments[i + 1].startMm : rowEnd);
              const left = fox + x0 * s + (i === 0 ? 0 : seamGapPx / 2);
              const right = fox + x1 * s - (i === row.segments.length - 1 ? 0 : seamGapPx / 2);
              const segW = Math.max(0, right - left);
              const fs = Math.min(11, (rh - 1) * 0.5);
              const showName = rh > 9 && segW > seg.name.length * fs * 0.62;
              return (
                <g key={`s${i}`}>
                  <rect x={left} y={y + 0.5} width={segW} height={rh - 1} rx={1}
                    fill={seg.reusedOffcut ? 'var(--plank-alt)' : 'var(--plank)'} stroke="var(--plank-edge)" strokeWidth={0.6}>
                    <title>
                      {seg.name} · {seg.lengthMm} mm · {seg.bays} bay{seg.bays === 1 ? '' : 's'} · stock {seg.barId}
                      {seg.reusedOffcut ? ' (offcut)' : ''}
                      {seg.cuts?.length ? ` · bevel ${seg.cuts.map((c) => `${c.side} ${c.angleDeg}°`).join(', ')}` : ''}
                    </title>
                  </rect>
                  {showName && (
                    <text x={(left + right) / 2} y={y + 0.5 + (rh - 1) / 2} fontSize={fs} fill="var(--plank-text)"
                      textAnchor="middle" dominantBaseline="central" pointerEvents="none">
                      {seg.name}
                    </text>
                  )}
                </g>
              );
            })}
          </g>
        );
      })}

      {/* width-fit overlays: rip cut-off, extra overhang + edge, gap placeholder */}
      {layout.rows.map((row) => (
        <EdgeOverlay key={`o${row.index}`} row={row} s={s} foy={foy} pw={pw} X0={fox + row.xStartMm * s} X1={fox + (row.xStartMm + row.runLengthMm) * s} fieldBottomY={fieldBottomY} />
      ))}

      {/* backing boards (joists) — in deck coords, across the whole deck or the field */}
      {layout.joists.map((j, i) => {
        const x = padX + j * s;
        let jy1 = layout.joistSpanWhole ? padTop : foy;
        let jy2 = layout.joistSpanWhole ? padTop + layout.widthMm * s : fieldBottomY;
        // L-shape: a joist passing through the notch x-span stops at the notch edge.
        const n = layout.notch;
        if (n && j > n.x + EPS && j < n.x + n.w - EPS) {
          if (n.y < EPS) jy1 = padTop + n.h * s; // notch on top
          else jy2 = padTop + (layout.widthMm - n.h) * s; // notch on bottom
        }
        return (
          <g key={`j${i}`}>
            <line x1={x} x2={x} y1={jy1} y2={jy2} stroke="var(--joist)" strokeWidth={1.6} strokeDasharray="7 5" strokeOpacity={0.9}>
              <title>Backing board @ {Math.round(j)} mm</title>
            </line>
            <circle cx={x} cy={jy1} r={2.6} fill="var(--joist-pin)" />
            <circle cx={x} cy={jy2} r={2.6} fill="var(--joist-pin)" />
          </g>
        );
      })}

      {/* seams — on top of the backing boards */}
      {planks.map((row) => {
        const y = foy + row.yStartMm * s;
        const rh = row.widthMm * s;
        return row.seams.map((sx, i) => (
          <line key={`sm${row.index}-${i}`} x1={fox + sx * s} x2={fox + sx * s} y1={y + 0.5} y2={y + rh - 0.5} stroke="var(--seam)" strokeWidth={3.4} strokeLinecap="round" />
        ));
      })}
      </g>
    </svg>
  );
}

function EdgeOverlay({
  row, s, foy, pw, X0, X1, fieldBottomY,
}: {
  row: Row; s: number; foy: number; pw: number; X0: number; X1: number; fieldBottomY: number;
}) {
  const y = foy + row.yStartMm * s;
  const fadeFill = 'var(--muted)';

  if (row.kind === 'rip') {
    const cutTop = y + row.widthMm * s;
    const cutH = (pw - row.widthMm) * s;
    return (
      <rect x={X0} y={cutTop} width={X1 - X0} height={Math.max(0, cutH)} fill={fadeFill} fillOpacity={0.2} stroke={fadeFill} strokeOpacity={0.5} strokeDasharray="4 3" strokeWidth={0.8}>
        <title>Cut off ~{Math.round(pw - row.widthMm)} mm (ripped to {Math.round(row.widthMm)} mm wide)</title>
      </rect>
    );
  }
  if (row.kind === 'extra') {
    const boardBottom = y + pw * s;
    return (
      <g>
        <rect x={X0} y={fieldBottomY} width={X1 - X0} height={Math.max(0, boardBottom - fieldBottomY)} fill={fadeFill} fillOpacity={0.2}>
          <title>Overhang ~{Math.round((boardBottom - fieldBottomY) / s)} mm beyond the field edge</title>
        </rect>
        <line x1={X0} x2={X1} y1={fieldBottomY} y2={fieldBottomY} stroke="var(--ink)" strokeWidth={1.4} strokeDasharray="5 3">
          <title>Field edge</title>
        </line>
      </g>
    );
  }
  if (row.kind === 'gap') {
    return (
      <rect x={X0} y={y} width={X1 - X0} height={row.widthMm * s} fill={fadeFill} fillOpacity={0.14} stroke={fadeFill} strokeOpacity={0.5} strokeDasharray="4 3" strokeWidth={0.8}>
        <title>No board here ({Math.round(row.widthMm)} mm uncovered)</title>
      </rect>
    );
  }
  return null;
}
