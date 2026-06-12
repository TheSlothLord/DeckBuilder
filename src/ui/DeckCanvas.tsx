import type { DeckLayout, Row } from '../model/types';

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

  // The drawing can extend past the deck (rip cut-off / overhanging extra board).
  const contentBottom = layout.rows.reduce((b, r) => {
    const extent = r.kind === 'rip' || r.kind === 'extra' ? r.yStartMm + pw : r.yStartMm + r.widthMm;
    return Math.max(b, extent);
  }, layout.widthMm);

  const w = layout.lengthMm * s + padX * 2;
  const h = contentBottom * s + padTop * 2;
  const seamGapPx = Math.max(1.5, endGap * s);
  const deckEdgeY = padTop + layout.widthMm * s; // bottom edge of the actual deck
  const X0 = padX;
  const X1 = padX + layout.lengthMm * s;

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
      <rect x={X0} y={padTop} width={layout.lengthMm * s} height={layout.widthMm * s} fill="none" stroke="var(--line)" />

      {/* plank rows (everything except gaps) */}
      {planks.map((row) => {
        const y = padTop + row.yStartMm * s;
        const rh = row.widthMm * s;
        return (
          <g key={`r${row.index}`}>
            {row.segments.map((seg, i) => {
              const x0 = seg.startMm;
              const x1 = i < row.segments.length - 1 ? row.segments[i + 1].startMm : layout.lengthMm;
              const left = padX + x0 * s + (i === 0 ? 0 : seamGapPx / 2);
              const right = padX + x1 * s - (i === row.segments.length - 1 ? 0 : seamGapPx / 2);
              const w = Math.max(0, right - left);
              const fs = Math.min(11, (rh - 1) * 0.5);
              const showName = rh > 9 && w > seg.name.length * fs * 0.62;
              return (
                <g key={`s${i}`}>
                  <rect
                    x={left}
                    y={y + 0.5}
                    width={w}
                    height={rh - 1}
                    rx={1}
                    fill={seg.reusedOffcut ? 'var(--plank-alt)' : 'var(--plank)'}
                    stroke="var(--plank-edge)"
                    strokeWidth={0.6}
                  >
                    <title>
                      {seg.name} · {seg.lengthMm} mm · {seg.bays} bay{seg.bays === 1 ? '' : 's'} · stock {seg.barId}
                      {seg.reusedOffcut ? ' (offcut)' : ''}
                    </title>
                  </rect>
                  {showName && (
                    <text
                      x={(left + right) / 2}
                      y={y + 0.5 + (rh - 1) / 2}
                      fontSize={fs}
                      fill="var(--plank-text)"
                      textAnchor="middle"
                      dominantBaseline="central"
                      pointerEvents="none"
                    >
                      {seg.name}
                    </text>
                  )}
                </g>
              );
            })}
          </g>
        );
      })}

      {/* width-fit overlays: rip cut-off, extra overhang + deck edge, gap placeholder */}
      {layout.rows.map((row) => <EdgeOverlay key={`o${row.index}`} row={row} s={s} padTop={padTop} pw={pw} X0={X0} X1={X1} deckEdgeY={deckEdgeY} />)}

      {/* backing boards (joists) — across the deck area only */}
      {layout.joists.map((j, i) => {
        const x = padX + j * s;
        return (
          <g key={`j${i}`}>
            <line x1={x} x2={x} y1={padTop} y2={deckEdgeY} stroke="var(--joist)" strokeWidth={1.6} strokeDasharray="7 5" strokeOpacity={0.9}>
              <title>Backing board @ {Math.round(j)} mm</title>
            </line>
            <circle cx={x} cy={padTop} r={2.6} fill="var(--joist-pin)" />
            <circle cx={x} cy={deckEdgeY} r={2.6} fill="var(--joist-pin)" />
          </g>
        );
      })}

      {/* seams — drawn last so they sit on top of the backing boards */}
      {planks.map((row) => {
        const y = padTop + row.yStartMm * s;
        const rh = row.widthMm * s;
        return row.seams.map((sx, i) => (
          <line key={`sm${row.index}-${i}`} x1={padX + sx * s} x2={padX + sx * s} y1={y + 0.5} y2={y + rh - 0.5} stroke="var(--seam)" strokeWidth={3.4} strokeLinecap="round" />
        ));
      })}
    </svg>
  );
}

function EdgeOverlay({
  row,
  s,
  padTop,
  pw,
  X0,
  X1,
  deckEdgeY,
}: {
  row: Row;
  s: number;
  padTop: number;
  pw: number;
  X0: number;
  X1: number;
  deckEdgeY: number;
}) {
  const y = padTop + row.yStartMm * s;
  const fadeFill = 'var(--muted)';

  if (row.kind === 'rip') {
    // The board occupies row.widthMm; the discarded strip runs up to the full plank width.
    const cutTop = y + row.widthMm * s;
    const cutH = (pw - row.widthMm) * s;
    return (
      <g>
        <rect x={X0} y={cutTop} width={X1 - X0} height={Math.max(0, cutH)} fill={fadeFill} fillOpacity={0.2} stroke={fadeFill} strokeOpacity={0.5} strokeDasharray="4 3" strokeWidth={0.8}>
          <title>Cut off ~{Math.round(pw - row.widthMm)} mm (ripped to {Math.round(row.widthMm)} mm wide)</title>
        </rect>
      </g>
    );
  }

  if (row.kind === 'extra') {
    // Full board overhangs the deck; fade the part beyond the deck edge and mark the edge.
    const boardBottom = y + pw * s;
    return (
      <g>
        <rect x={X0} y={deckEdgeY} width={X1 - X0} height={Math.max(0, boardBottom - deckEdgeY)} fill={fadeFill} fillOpacity={0.2}>
          <title>Overhang ~{Math.round((boardBottom - deckEdgeY) / s)} mm beyond the deck edge</title>
        </rect>
        <line x1={X0} x2={X1} y1={deckEdgeY} y2={deckEdgeY} stroke="var(--ink)" strokeWidth={1.4} strokeDasharray="5 3">
          <title>Deck edge</title>
        </line>
      </g>
    );
  }

  if (row.kind === 'gap') {
    // No board — a faded placeholder showing where one would have gone.
    return (
      <rect x={X0} y={y} width={X1 - X0} height={row.widthMm * s} fill={fadeFill} fillOpacity={0.14} stroke={fadeFill} strokeOpacity={0.5} strokeDasharray="4 3" strokeWidth={0.8}>
        <title>No board here ({Math.round(row.widthMm)} mm uncovered)</title>
      </rect>
    );
  }

  return null;
}
