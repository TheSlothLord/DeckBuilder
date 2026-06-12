import type { CutConfig, CutInstruction } from '../model/types';

interface Props {
  bar: CutInstruction;
  cut: CutConfig;
  highlight?: string; // a piece's usedIn label (or deck plank name) to emphasize
}

const TARGET_W = 760; // px the stock length is scaled to
const BAR_H = 56;
const PAD = 10;

/** Visualises one stock plank and exactly where to cut it: pieces in cut order,
 *  the saw kerf between them, and the trailing remainder (offcut or scrap). */
export function BarView({ bar, cut, highlight }: Props) {
  const lead = cut.squareLeadingEnd ? cut.kerf : 0;
  const s = TARGET_W / Math.max(1, bar.stockLength);
  const X = (mm: number) => PAD + mm * s;

  let cursor = lead;
  const segs = bar.pieces.map((p) => {
    const x0 = cursor;
    const x1 = cursor + p.lengthMm;
    cursor = x1 + cut.kerf; // one saw kerf after each piece
    const hot = highlight != null && (p.usedIn === highlight || p.usedIn.startsWith(`${highlight} `));
    return { ...p, x0, x1, hot };
  });
  const remStart = cursor;
  const remLen = Math.max(0, bar.stockLength - remStart);

  const w = bar.stockLength * s + PAD * 2;
  const h = BAR_H + PAD * 2;
  const srcLabel = bar.source === 'onhand' ? 'inventory' : 'to buy';

  return (
    <div className="barview">
      <div className="barview-cap">
        <strong>{bar.barId}</strong> · {bar.stockLength} mm stock ({srcLabel}) · {bar.cuts} cut{bar.cuts === 1 ? '' : 's'} · kerf {cut.kerf} mm ·{' '}
        <span className={bar.isScrap ? 'scrap' : ''}>
          remainder {bar.endRemainder} mm{bar.isScrap ? ' (scrap)' : ' (offcut)'}
        </span>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" style={{ maxWidth: w, display: 'block' }} role="img" aria-label={`Cut plan for ${bar.barId}`}>
        {/* stock outline */}
        <rect x={PAD} y={PAD} width={bar.stockLength * s} height={BAR_H} rx={2} fill="none" stroke="var(--line)" />

        {/* squared leading end (a kerf trimmed off the rough end) */}
        {lead > 0 && (
          <rect x={PAD} y={PAD} width={lead * s} height={BAR_H} fill="var(--muted)" fillOpacity={0.3}>
            <title>Squared leading end · {cut.kerf} mm trimmed</title>
          </rect>
        )}

        {/* pieces */}
        {segs.map((seg, i) => {
          const px = X(seg.x0);
          const pw = Math.max(0, (seg.x1 - seg.x0) * s);
          const top = PAD;
          const bot = PAD + BAR_H;
          const cx = px + pw / 2;
          const ink = seg.hot ? '#1a1206' : 'var(--plank-text)';
          const fillC = seg.hot ? 'var(--accent)' : 'var(--plank)';
          const name = seg.usedIn.split(' ·')[0].split(' bevel')[0];
          const showName = pw > 46;

          // Bevelled piece: long edge on top, short on bottom; each bevelled end
          // slants in proportion to its cut angle. Makes the angle and the
          // measured (long) edge explicit.
          const bevels = seg.cuts ?? [];
          if (bevels.length > 0) {
            const long = seg.lengthMm;
            const short = Math.min(long, ...bevels.map((c) => c.shortMm));
            const delta = Math.max(0, long - short);
            const cutL = bevels.find((c) => c.side === 'L');
            const cutR = bevels.find((c) => c.side === 'R');
            const tL = cutL ? Math.tan((cutL.angleDeg * Math.PI) / 180) : 0;
            const tR = cutR ? Math.tan((cutR.angleDeg * Math.PI) / 180) : 0;
            const tsum = tL + tR || 1;
            const cbL = (delta * tL) / tsum; // mm cut back at the left, on the short (bottom) edge
            const cbR = (delta * tR) / tsum;
            const pts = `${X(seg.x0)},${top} ${X(seg.x1)},${top} ${X(seg.x1 - cbR)},${bot} ${X(seg.x0 + cbL)},${bot}`;
            const angleText = bevels.map((c) => `${c.side} ${c.angleDeg}°`).join(', ');
            return (
              <g key={i}>
                <polygon points={pts} fill={fillC} stroke="var(--plank-edge)" strokeWidth={seg.hot ? 1.4 : 0.6}>
                  <title>{seg.usedIn} · long {long} mm / short {short} mm · bevel {angleText}</title>
                </polygon>
                {showName && (
                  <>
                    <text x={cx} y={top + 13} fontSize={11} fill={ink} textAnchor="middle" pointerEvents="none">{name}</text>
                    <text x={cx} y={top + 26} fontSize={9.5} fill={ink} textAnchor="middle" pointerEvents="none" opacity={0.9}>long {long}</text>
                    <text x={(X(seg.x0 + cbL) + X(seg.x1 - cbR)) / 2} y={bot - 6} fontSize={9.5} fill={ink} textAnchor="middle" pointerEvents="none" opacity={0.9}>short {short}</text>
                  </>
                )}
                {/* angle tag at each bevelled end */}
                {cutL && <text x={X(seg.x0) + 2} y={top - 3} fontSize={9.5} fill="var(--accent)" textAnchor="start" pointerEvents="none">∡{cutL.angleDeg}°</text>}
                {cutR && <text x={X(seg.x1) - 2} y={top - 3} fontSize={9.5} fill="var(--accent)" textAnchor="end" pointerEvents="none">∡{cutR.angleDeg}°</text>}
                <rect x={X(seg.x1)} y={top} width={Math.max(1, cut.kerf * s)} height={BAR_H} fill="var(--seam)">
                  <title>Saw cut · kerf {cut.kerf} mm</title>
                </rect>
              </g>
            );
          }

          return (
            <g key={i}>
              <rect x={px} y={top} width={pw} height={BAR_H} rx={2}
                fill={fillC} stroke="var(--plank-edge)" strokeWidth={seg.hot ? 1.4 : 0.6}>
                <title>{seg.usedIn} · {seg.lengthMm} mm</title>
              </rect>
              {showName && (
                <>
                  <text x={cx} y={PAD + BAR_H / 2 - 4} fontSize={11} fill={ink} textAnchor="middle" dominantBaseline="central" pointerEvents="none">
                    {name}
                  </text>
                  <text x={cx} y={PAD + BAR_H / 2 + 11} fontSize={10} fill={ink} textAnchor="middle" dominantBaseline="central" pointerEvents="none" opacity={0.85}>
                    {seg.lengthMm} mm
                  </text>
                </>
              )}
              {/* kerf cut line after this piece */}
              <rect x={X(seg.x1)} y={top} width={Math.max(1, cut.kerf * s)} height={BAR_H} fill="var(--seam)">
                <title>Saw cut · kerf {cut.kerf} mm</title>
              </rect>
            </g>
          );
        })}

        {/* trailing remainder */}
        {remLen > 0.5 && (
          <rect x={X(remStart)} y={PAD} width={remLen * s} height={BAR_H}
            fill={bar.isScrap ? 'var(--muted)' : 'var(--plank-alt)'} fillOpacity={bar.isScrap ? 0.25 : 0.55}
            stroke="var(--muted)" strokeOpacity={0.6} strokeDasharray="4 3" strokeWidth={0.8}>
            <title>{bar.isScrap ? `Scrap · ${bar.endRemainder} mm (below min reusable ${cut.minReusableOffcut} mm)` : `Reusable offcut · ${bar.endRemainder} mm`}</title>
          </rect>
        )}
      </svg>
      <div className="barview-legend">
        <span><i className="sw" style={{ background: 'var(--plank)' }} /> piece</span>
        <span><i className="sw" style={{ background: 'var(--accent)' }} /> selected</span>
        <span><i className="sw" style={{ background: 'var(--seam)', width: 4 }} /> saw kerf</span>
        <span><i className="sw" style={{ background: 'var(--plank-alt)', opacity: 0.55 }} /> offcut / scrap</span>
      </div>
    </div>
  );
}
