import type { DeckLayout, OverhangFrom, Row } from '../model/types';

interface Props {
  layout: DeckLayout;
  endGap: number;
}

const TARGET_W = 820; // px the deck length is scaled to

export function DeckCanvas({ layout, endGap }: Props) {
  const s = TARGET_W / layout.lengthMm; // px per mm
  const padX = 8;
  const padTop = 8;
  const pw = layout.plankWidthMm;
  const fi = layout.fieldInsetMm || 0; // border depth
  const fieldL = layout.lengthMm - 2 * fi;
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

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      width="100%"
      style={{ maxWidth: w, display: 'block' }}
      role="img"
      aria-label={`Plank layout for ${layout.label}`}
    >
      {/* deck outline */}
      <rect x={padX} y={padTop} width={layout.lengthMm * s} height={layout.widthMm * s} fill="none" stroke="var(--line)" />

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

      {/* plank rows (everything except gaps) */}
      {planks.map((row) => {
        const y = foy + row.yStartMm * s;
        const rh = row.widthMm * s;
        return (
          <g key={`r${row.index}`}>
            {row.segments.map((seg, i) => {
              const x0 = seg.startMm;
              const x1 = i < row.segments.length - 1 ? row.segments[i + 1].startMm : fieldL;
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
        <EdgeOverlay key={`o${row.index}`} row={row} s={s} foy={foy} pw={pw} X0={fox} X1={fox + fieldL * s} fieldBottomY={fieldBottomY} overhangFrom={layout.overhangFrom} />
      ))}

      {/* backing boards (joists) — across the field area */}
      {layout.joists.map((j, i) => {
        const x = fox + j * s;
        return (
          <g key={`j${i}`}>
            <line x1={x} x2={x} y1={foy} y2={fieldBottomY} stroke="var(--joist)" strokeWidth={1.6} strokeDasharray="7 5" strokeOpacity={0.9}>
              <title>Backing board @ {Math.round(j)} mm (field)</title>
            </line>
            <circle cx={x} cy={foy} r={2.6} fill="var(--joist-pin)" />
            <circle cx={x} cy={fieldBottomY} r={2.6} fill="var(--joist-pin)" />
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
    </svg>
  );
}

function EdgeOverlay({
  row, s, foy, pw, X0, X1, fieldBottomY, overhangFrom,
}: {
  row: Row; s: number; foy: number; pw: number; X0: number; X1: number; fieldBottomY: number; overhangFrom: OverhangFrom;
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
    const overhang = (row.overhangMm ?? 0) * s;
    if (overhangFrom === 'inside') {
      // board sits flush to the field edge and overhangs inward — fade the inner strip
      return (
        <g>
          <rect x={X0} y={y} width={X1 - X0} height={Math.max(0, overhang)} fill={fadeFill} fillOpacity={0.2}>
            <title>Overhang ~{Math.round(row.overhangMm ?? 0)} mm inward (from inside the border)</title>
          </rect>
          <line x1={X0} x2={X1} y1={y + overhang} y2={y + overhang} stroke="var(--ink)" strokeWidth={1.4} strokeDasharray="5 3" />
        </g>
      );
    }
    // outward: board overhangs past the field edge
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
