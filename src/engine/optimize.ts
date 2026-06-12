// Orchestrator — runs the full pipeline and assembles the Result.
// Grid → Stage A (candidates) → Stage B (stagger) → Stage C (cut stock) → stats.

import type {
  BomLine,
  CutInstruction,
  DeckLayout,
  Project,
  Result,
  Row,
  Segment,
  ShoppingLine,
  StockOption,
  Stats,
} from '../model/types';
import { joistPositions, legalSeams, rowSlots } from './grid';
import { generateRowCandidates, type RowCandidate } from './candidates';
import { chooseLayout } from './stagger';
import { packCutStock, type DemandPiece } from './cutstock';
import { makeRng } from './rng';

const EPS = 1e-6;

export function optimize(project: Project): Result {
  const { plank, gaps, cut, stagger, widthFit, backingBoardWidth, decks } = project;
  const rng = makeRng(stagger.seed);
  const warnings: string[] = [];

  // Unified stock pool: on-hand inventory (finite, free) + store lengths (unlimited, priced).
  const stockOptions: StockOption[] = [
    ...plank.onHand
      .filter((o) => o.quantity > 0 && o.length > 0)
      .map((o) => ({ length: o.length, quantity: o.quantity, source: 'onhand' as const })),
    ...plank.store
      .filter((o) => o.length > 0)
      .map((o) => ({ length: o.length, pricePerUnit: o.pricePerUnit, source: 'store' as const })),
  ];

  const stockLengths = [...new Set(stockOptions.map((s) => s.length))].sort((a, b) => a - b);
  const maxStock = stockLengths.length ? Math.max(...stockLengths) : 0;
  const maxUsable = maxStock - cut.kerf - (cut.squareLeadingEnd ? cut.kerf : 0);

  if (stockOptions.length === 0)
    warnings.push('Add at least one plank length — on hand or in the store — to generate a layout.');

  const layouts: DeckLayout[] = [];
  const demand: DemandPiece[] = [];
  // Keep a handle from each demand id back to its Segment so we can attach the bar.
  const segIndex = new Map<string, Segment>();

  for (let deckIndex = 0; deckIndex < decks.length; deckIndex++) {
    const deck = decks[deckIndex];
    const deckLetter = deckLabel(deckIndex);
    const joists = joistPositions(deck, backingBoardWidth);
    const seams = legalSeams(deck, backingBoardWidth);
    const slots = rowSlots(deck, plank.width, gaps, widthFit);
    const deckWarnings: string[] = [];

    // Friendly, deck-level diagnostics — computed BEFORE the expensive candidate
    // enumeration so a bad value (e.g. a tiny spacing) can't blow up the engine.
    const MAX_SEAMS = 600;
    const fullPlankFits = stockLengths.length > 0 && deck.length - gaps.endGap <= maxUsable;
    const seamlessFits = stockLengths.length > 0 && deck.length <= maxUsable;
    let guard = stockLengths.length === 0; // global message already added
    if (guard) {
      // no stock — message already added globally
    } else if (deck.noSeams) {
      // Seamless decks ignore the joist grid for layout; they only need a plank
      // long enough to span the whole deck.
      if (!seamlessFits) {
        deckWarnings.push(
          `"${deck.label}": "No seams" is on, but the deck is ${deck.length} mm long — longer than your longest plank (${maxStock} mm). Turn off "No seams" or add a longer stock length.`,
        );
        guard = true;
      }
    } else if (deck.spacing <= 0) {
      deckWarnings.push(
        `"${deck.label}": enter a backing-board spacing greater than 0 so seams have a board to land on.`,
      );
      guard = true;
    } else if (seams.length > MAX_SEAMS) {
      deckWarnings.push(
        `"${deck.label}": a ${deck.spacing} mm spacing creates ${seams.length} seam positions on a ${deck.length} mm deck — too many to lay out. Increase the board spacing.`,
      );
      guard = true;
    } else if (seams.length === 0 && !fullPlankFits) {
      deckWarnings.push(
        `"${deck.label}": no backing boards fall inside the deck, and it is longer than your longest plank (${maxStock} mm). Reduce the board spacing or add a longer stock length.`,
      );
      guard = true;
    }

    const candidatesPerRow: RowCandidate[][] = slots.map((slot) => {
      if (guard || slot.kind === 'gap') return []; // gap rows are intentionally empty
      if (deck.noSeams) return [{ seams: [] as number[], cutLengths: [deck.length], estWaste: 0 }];
      return generateRowCandidates({
        length: deck.length,
        legalSeams: seams,
        endGap: gaps.endGap,
        minPieceLength: stagger.minPieceLength,
        maxUsable,
        stockLengths,
        kerf: cut.kerf,
      });
    });

    if (!guard) {
      candidatesPerRow.forEach((c, i) => {
        if (c.length === 0 && slots[i].kind !== 'gap')
          deckWarnings.push(
            `Row ${i + 1}: no valid plank layout — check the min-piece length against your stock lengths.`,
          );
      });
    }

    const selections = chooseLayout(candidatesPerRow, stagger, rng, deck.length);

    const rows: Row[] = selections.map((sel, r) => {
      const slot = slots[r];
      // Unsolvable row (no candidate fit): render an empty band, emit no demand.
      if (candidatesPerRow[r].length === 0) {
        return {
          index: r,
          widthMm: slot.widthMm,
          yStartMm: slot.yStartMm,
          kind: slot.kind,
          seams: [],
          segments: [],
        };
      }
      const boundaries = [0, ...sel.seams, deck.length];
      const segments: Segment[] = [];
      for (let i = 0; i < boundaries.length - 1; i++) {
        const startPos = boundaries[i];
        const endPos = boundaries[i + 1];
        const lengthMm = sel.cutLengths[i] ?? round(endPos - startPos);
        const bays = deck.spacing > 0 ? Math.max(1, Math.round((endPos - startPos) / deck.spacing)) : 1;
        const seg: Segment = {
          name: `${deckLetter}(${r + 1},${i + 1})`,
          startMm: round(startPos),
          lengthMm,
          bays,
          barId: '',
          reusedOffcut: false,
        };
        segments.push(seg);
        const id = `${deck.id}#${r}#${i}`;
        demand.push({ id, length: lengthMm, label: seg.name });
        segIndex.set(id, seg);
      }
      if (sel.relaxed)
        deckWarnings.push(`Row ${r + 1}: min seam offset relaxed (no layout satisfied it).`);
      return {
        index: r,
        widthMm: slot.widthMm,
        yStartMm: slot.yStartMm,
        kind: slot.kind,
        seams: sel.seams,
        segments,
      };
    });

    layouts.push({
      deckId: deck.id,
      label: deck.label,
      lengthMm: deck.length,
      widthMm: deck.width,
      plankWidthMm: plank.width,
      joists,
      rows,
      warnings: deckWarnings,
    });
    warnings.push(...deckWarnings);
  }

  // Stage C — pack everything into stock, then attach bars back to segments.
  const pack = packCutStock(demand, stockOptions, cut);
  warnings.push(...pack.warnings);
  for (const [id, place] of Object.entries(pack.placement)) {
    const seg = segIndex.get(id);
    if (seg) {
      seg.barId = place.barId;
      seg.reusedOffcut = place.reusedOffcut;
    }
  }

  const stats = computeStats(demand, pack.bars, stockOptions);
  const bom = computeBom(pack.bars, stockOptions);
  const shoppingList = computeShoppingList(pack.bars, stockOptions);

  return { layouts, cutList: pack.bars, bom, shoppingList, stats, warnings };
}

const storePriceOf = (stock: StockOption[], len: number) =>
  stock.find((s) => s.source === 'store' && s.length === len)?.pricePerUnit;

function computeStats(demand: DemandPiece[], bars: CutInstruction[], stock: StockOption[]): Stats {
  const surfaceLength = round(demand.reduce((s, d) => s + d.length, 0));
  const purchasedLength = round(bars.reduce((s, b) => s + b.stockLength, 0));
  const kerfLoss = round(bars.reduce((s, b) => s + b.kerfLoss, 0));
  const scrap = round(bars.filter((b) => b.isScrap).reduce((s, b) => s + b.endRemainder, 0));
  const leftover = round(
    bars.filter((b) => !b.isScrap).reduce((s, b) => s + Math.max(0, b.endRemainder), 0),
  );
  const wastePct =
    purchasedLength > EPS ? round(((purchasedLength - surfaceLength) / purchasedLength) * 100) : 0;

  const storeBars = bars.filter((b) => b.source === 'store');
  const barsToBuy = storeBars.length;
  const barsFromInventory = bars.length - barsToBuy;

  // Cost counts only planks to buy; inventory is already owned.
  let cost: number | undefined = 0;
  if (barsToBuy > 0) {
    const prices = storeBars.map((b) => storePriceOf(stock, b.stockLength));
    cost = prices.every((p) => p != null)
      ? round(prices.reduce((s, p) => s + (p as number), 0))
      : undefined;
  }

  return {
    totalBars: bars.length,
    surfaceLength,
    purchasedLength,
    kerfLoss,
    scrap,
    leftover,
    wastePct,
    barsFromInventory,
    barsToBuy,
    cost,
  };
}

function computeBom(bars: CutInstruction[], stock: StockOption[]): BomLine[] {
  const counts = new Map<string, { stockLength: number; source: BomLine['source']; count: number }>();
  for (const b of bars) {
    const k = `${b.source}:${b.stockLength}`;
    const cur = counts.get(k) ?? { stockLength: b.stockLength, source: b.source, count: 0 };
    cur.count++;
    counts.set(k, cur);
  }
  return [...counts.values()]
    .sort((a, b) => (a.source === 'onhand' ? 0 : 1) - (b.source === 'onhand' ? 0 : 1) || b.stockLength - a.stockLength)
    .map(({ stockLength, source, count }) => {
      const price = source === 'store' ? storePriceOf(stock, stockLength) : undefined;
      return { stockLength, source, count, cost: price != null ? round(price * count) : undefined };
    });
}

/** What to buy from the store to cover the shortfall. */
function computeShoppingList(bars: CutInstruction[], stock: StockOption[]): ShoppingLine[] {
  const counts = new Map<number, number>();
  for (const b of bars) if (b.source === 'store') counts.set(b.stockLength, (counts.get(b.stockLength) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([length, count]) => {
      const price = storePriceOf(stock, length);
      return { length, count, cost: price != null ? round(price * count) : undefined };
    });
}

function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}

/** Deck index → spreadsheet-style letter: 0→A, 1→B, … 25→Z, 26→AA. */
function deckLabel(i: number): string {
  let n = i + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}
