import type { Deck, Gaps, RowKind, WidthFit } from '../model/types';

const EPS = 1e-6;

/**
 * Backing-board (joist) centre positions along the deck length: an edge board
 * near each end (inset to its centre line by `firstOffset`, clamped to at least
 * half a board width so it can't hang off the edge), with field boards every
 * `spacing` in between.
 */
export function joistPositions(deck: Deck, boardWidth = 0): number[] {
  const { spacing } = deck;
  const L = deck.length;
  if (spacing <= 0 || L <= 0) return [];
  const inset = Math.max(deck.firstOffset, boardWidth / 2);

  const out: number[] = [];
  if (inset < L - EPS) out.push(round(inset)); // near edge board
  for (let x = inset + spacing; x < L - inset - EPS; x += spacing) out.push(round(x));
  const far = L - inset;
  if (far > inset + EPS) out.push(round(far)); // far edge board
  return out;
}

/** Seams may land on any backing board (the min-piece rule rejects edge-hugging ones). */
export function legalSeams(deck: Deck, boardWidth = 0): number[] {
  return joistPositions(deck, boardWidth).filter((x) => x > EPS && x < deck.length - EPS);
}

export interface RowSlot {
  index: number;
  widthMm: number;
  yStartMm: number;
  kind: RowKind;
  overhangMm?: number;
}

const MIN_REMAINDER = 1; // mm — ignore a sliver this small (it's just the trailing gap)

/**
 * Lay rows across the deck width: as many full-width boards as fit, then handle
 * the leftover strip according to `widthFit` — rip a board to fit, add an extra
 * overhanging board, or leave a gap.
 */
export function rowSlots(deck: Deck, plankWidth: number, gaps: Gaps, widthFit: WidthFit): RowSlot[] {
  const pitch = plankWidth + gaps.sideGap;
  if (pitch <= 0 || deck.width <= 0) return [];

  const full = Math.max(1, Math.floor((deck.width + gaps.sideGap) / pitch));
  const used = full * plankWidth + (full - 1) * gaps.sideGap;
  const leftover = deck.width - used; // includes the gap before any remainder board
  const remWidth = round(leftover - gaps.sideGap); // width available for a partial board

  const slots: RowSlot[] = [];
  let y = 0;
  for (let i = 0; i < full; i++) {
    slots.push({ index: i, widthMm: plankWidth, yStartMm: round(y), kind: 'full' });
    y += plankWidth + gaps.sideGap;
  }

  if (remWidth > MIN_REMAINDER) {
    const i = full;
    if (widthFit === 'extra') {
      // A full board that overhangs the far edge.
      slots.push({ index: i, widthMm: plankWidth, yStartMm: round(y), kind: 'extra', overhangMm: round(plankWidth - remWidth) });
    } else if (widthFit === 'gap') {
      slots.push({ index: i, widthMm: remWidth, yStartMm: round(y), kind: 'gap' });
    } else {
      slots.push({ index: i, widthMm: remWidth, yStartMm: round(y), kind: 'rip' });
    }
  }
  return slots;
}

function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}
