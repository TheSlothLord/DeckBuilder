import { useState } from 'react';
import type { DeckLayout, Result } from '../model/types';
import { DeckCanvas } from './DeckCanvas';
import { ZoomView } from './ZoomView';

interface Props {
  result: Result;
  endGap: number;
}

const m = (mm: number) => `${(mm / 1000).toFixed(2)} m`;

export function Results({ result, endGap }: Props) {
  const { stats, layouts, cutList, bom, shoppingList, warnings } = result;
  const shoppingTotal = shoppingList.reduce((s, l) => s + (l.cost ?? 0), 0);
  const shoppingCount = shoppingList.reduce((s, l) => s + l.count, 0);
  const [zoomed, setZoomed] = useState<DeckLayout | null>(null);

  return (
    <div className="main">
      {warnings.length > 0 && (
        <div className="warnings">
          <strong>Notes</strong>
          <ul>
            {[...new Set(warnings)].map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="stats">
        <Stat k="Stock bars" v={String(stats.totalBars)} />
        <Stat k="From inventory" v={String(stats.barsFromInventory)} />
        <Stat k="To buy" v={String(stats.barsToBuy)} cls={stats.barsToBuy > 0 ? 'warn' : 'good'} />
        <Stat k="Deck surface" v={m(stats.surfaceLength)} />
        <Stat k="Waste" v={`${stats.wastePct}%`} cls={stats.wastePct <= 12 ? 'good' : 'warn'} />
        <Stat k="Kerf loss" v={m(stats.kerfLoss)} />
        <Stat k="Scrap" v={m(stats.scrap)} />
        {stats.cost != null && <Stat k="Buy cost" v={stats.cost.toFixed(2)} />}
      </div>

      {layouts.map((layout) => (
        <div className="deck-card" key={layout.deckId}>
          <h3>
            {layout.label} — {m(layout.lengthMm)} × {m(layout.widthMm)}
            <button className="zoom-open" onClick={() => setZoomed(layout)} title="Open a zoomable, full-screen view of this plan">🔍 View / zoom</button>
          </h3>
          <DeckCanvas layout={layout} endGap={endGap} />
          <div className="legend">
            <span><i className="sw" style={{ background: 'var(--plank)' }} /> fresh plank</span>
            <span><i className="sw" style={{ background: 'var(--plank-alt)' }} /> cut from offcut</span>
            <span><i className="sw" style={{ background: 'var(--seam)', width: 4 }} /> seam (on joist)</span>
            <span><i className="sw" style={{ background: 'var(--joist)' }} /> backing board</span>
            <span><i className="sw" style={{ background: 'var(--muted)', opacity: 0.4 }} /> cut-off / gap / overhang</span>
          </div>
        </div>
      ))}

      <h2 style={{ marginTop: 8 }}>Shopping list</h2>
      {shoppingList.length === 0 ? (
        <p className="tagline">Nothing to buy — your inventory covers the whole job. 🎉</p>
      ) : (
        <table className="cuts">
          <thead>
            <tr><th>Buy length</th><th>Qty</th><th>Cost</th></tr>
          </thead>
          <tbody>
            {shoppingList.map((l) => (
              <tr key={l.length}>
                <td>{l.length} mm</td>
                <td>{l.count}</td>
                <td>{l.cost != null ? l.cost.toFixed(2) : '—'}</td>
              </tr>
            ))}
            <tr>
              <td><strong>Total</strong></td>
              <td><strong>{shoppingCount}</strong></td>
              <td><strong>{shoppingTotal > 0 ? shoppingTotal.toFixed(2) : '—'}</strong></td>
            </tr>
          </tbody>
        </table>
      )}

      <h2>Materials used</h2>
      <table className="cuts">
        <thead>
          <tr><th>Stock length</th><th>Source</th><th>Qty</th><th>Cost</th></tr>
        </thead>
        <tbody>
          {bom.map((b) => (
            <tr key={`${b.source}-${b.stockLength}`}>
              <td>{b.stockLength} mm</td>
              <td>{b.source === 'onhand' ? 'inventory' : 'bought'}</td>
              <td>{b.count}</td>
              <td>{b.cost != null ? b.cost.toFixed(2) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Cut list</h2>
      <p className="tagline">Each stock plank below, and the boards A(row,index) to cut from it.</p>
      <table className="cuts">
        <thead>
          <tr><th>Stock</th><th>Length</th><th>Cuts</th><th>Boards (length)</th><th>Remainder</th></tr>
        </thead>
        <tbody>
          {cutList.map((c) => (
            <tr key={c.barId}>
              <td>{c.barId}</td>
              <td>{c.stockLength} mm <span className={`src ${c.source}`}>{c.source === 'onhand' ? 'inv' : 'buy'}</span></td>
              <td>{c.cuts}</td>
              <td>
                {c.pieces.map((p, i) => (
                  <span className={`tag${i > 0 ? ' reuse' : ''}`} key={i}>
                    {p.usedIn} <span className="tag-len">{p.lengthMm}</span>
                  </span>
                ))}
              </td>
              <td className={c.isScrap ? 'scrap' : ''}>
                {c.endRemainder} mm{c.isScrap ? ' (scrap)' : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {zoomed && <ZoomView layout={zoomed} endGap={endGap} onClose={() => setZoomed(null)} />}
    </div>
  );
}

function Stat({ k, v, cls }: { k: string; v: string; cls?: string }) {
  return (
    <div className="stat">
      <div className={`v ${cls ?? ''}`}>{v}</div>
      <div className="k">{k}</div>
    </div>
  );
}
