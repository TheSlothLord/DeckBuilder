// Stage C — 1D cutting stock with saw kerf and offcut reuse.
// First-Fit-Decreasing with a best-fit placement rule: each required piece goes
// into the shortest open bar/offcut that still fits (including kerf), so offcuts
// are consumed before fresh stock is opened.

import type { AngledCut, CutConfig, CutInstruction, StockOption, StockSource } from '../model/types';

const EPS = 1e-6;

export interface DemandPiece {
  id: string;
  length: number;
  label: string;
  cuts?: AngledCut[]; // bevelled ends, passed through to the cut plan
}

export interface Placement {
  barId: string;
  reusedOffcut: boolean;
}

export interface PackResult {
  bars: CutInstruction[];
  placement: Record<string, Placement>;
  warnings: string[];
}

interface Bar {
  id: string;
  stockLength: number;
  remaining: number; // usable length left
  pieces: { length: number; label: string; cuts?: AngledCut[] }[];
  price?: number;
  source: StockSource;
}

const keyOf = (s: StockOption) => `${s.source}:${s.length}`;

export function packCutStock(
  demand: DemandPiece[],
  stock: StockOption[],
  cut: CutConfig,
): PackResult {
  const leadTrim = cut.squareLeadingEnd ? cut.kerf : 0;
  const bars: Bar[] = [];
  const placement: Record<string, Placement> = {};
  const warnings: string[] = [];
  const opened = new Map<string, number>(); // source:length → count opened

  // Largest pieces first.
  const order = [...demand].sort((a, b) => b.length - a.length);

  for (const piece of order) {
    const need = piece.length + cut.kerf;

    // Best fit among open bars: smallest remaining that still fits.
    let target: Bar | undefined;
    for (const bar of bars) {
      if (bar.remaining + EPS >= need && (!target || bar.remaining < target.remaining)) {
        target = bar;
      }
    }

    if (!target) {
      target = openBar(piece.length, leadTrim, cut.kerf, stock, opened, bars.length);
      if (!target) {
        warnings.push(
          `No stock length fits a ${piece.length} mm piece (${piece.label}).`,
        );
        continue;
      }
      bars.push(target);
    }

    const reusedOffcut = target.pieces.length > 0;
    target.pieces.push({ length: piece.length, label: piece.label, cuts: piece.cuts });
    target.remaining -= need;
    placement[piece.id] = { barId: target.id, reusedOffcut };
  }

  return { bars: bars.map((b) => toInstruction(b, cut)), placement, warnings };
}

/**
 * Open a new bar for the piece. Prefer on-hand inventory (already owned) before
 * buying from the store; within a source, take the shortest length that fits,
 * tie-breaking on price.
 */
function openBar(
  pieceLen: number,
  leadTrim: number,
  kerf: number,
  stock: StockOption[],
  opened: Map<string, number>,
  index: number,
): Bar | undefined {
  const need = pieceLen + kerf + leadTrim;
  const eligible = stock
    .filter((s) => s.length + EPS >= need)
    .filter((s) => s.quantity == null || (opened.get(keyOf(s)) ?? 0) < s.quantity)
    .sort(
      (a, b) =>
        (a.source === 'onhand' ? 0 : 1) - (b.source === 'onhand' ? 0 : 1) || // use what I have first
        a.length - b.length ||
        (a.pricePerUnit ?? 0) - (b.pricePerUnit ?? 0),
    );

  const chosen = eligible[0];
  if (!chosen) return undefined;
  opened.set(keyOf(chosen), (opened.get(keyOf(chosen)) ?? 0) + 1);
  return {
    id: `S${index + 1}`,
    stockLength: chosen.length,
    remaining: chosen.length - leadTrim,
    pieces: [],
    price: chosen.source === 'store' ? chosen.pricePerUnit : undefined,
    source: chosen.source,
  };
}

function toInstruction(bar: Bar, cut: CutConfig): CutInstruction {
  const used = bar.pieces.reduce((s, p) => s + p.length, 0);
  const cuts = bar.pieces.length; // one cut per piece; trailing remainder is free
  const kerfLoss = round((cuts + (cut.squareLeadingEnd ? 1 : 0)) * cut.kerf);
  const endRemainder = round(bar.stockLength - used - kerfLoss);
  return {
    barId: bar.id,
    stockLength: bar.stockLength,
    source: bar.source,
    pieces: bar.pieces.map((p) => ({ lengthMm: p.length, usedIn: p.label, cuts: p.cuts })),
    cuts,
    kerfLoss,
    endRemainder,
    isScrap: endRemainder < cut.minReusableOffcut,
  };
}

function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}
