// Domain types for DeckBuilder. All measurements in millimetres.

export type mm = number;

/** Planks you already own (finite quantities, no purchase cost). */
export interface OnHandStock {
  length: mm;
  quantity: number;
}

/** Plank lengths the store sells (assumed unlimited, with a unit price). */
export interface StoreStock {
  length: mm;
  pricePerUnit?: number;
}

export type StockSource = 'onhand' | 'store';

/** Unified option the cut-stock packer draws from. */
export interface StockOption {
  length: mm;
  quantity?: number; // finite for on-hand; undefined = unlimited (store)
  pricePerUnit?: number; // store price; undefined for on-hand
  source: StockSource;
}

export interface PlankSpec {
  width: mm;
  thickness: mm;
  onHand: OnHandStock[]; // what I have
  store: StoreStock[]; // what I can buy
}

/** How border boards meet at the corners. */
export type CornerStyle =
  | 'mitered' // 45° mitre cuts (default)
  | 'topBottom' // top & bottom boards run the full length; sides butt between
  | 'sides' // left & right run the full width; top & bottom butt between
  | 'staggered'; // alternate which runs long, ring by ring (woven look)

/** Where the backing boards (joists) run when the deck has a border. */
export type BackingSpan =
  | 'field' // joists only under the planking field (inside the frame)
  | 'whole'; // joists under the whole deck, including beneath the border

export interface Deck {
  id: string;
  label: string;
  length: mm; // run direction (planks)
  width: mm; // across rows
  spacing: mm; // backing-board (joist) spacing, centre-to-centre — per deck
  firstOffset: mm; // edge-board inset: centre of the edge backing boards, this far in from each edge
  noSeams: boolean; // force single full-length boards per row (no butt joints)
  borderBoards: number; // picture-frame border: number of perimeter rings (0 = none)
  cornerStyle: CornerStyle; // how the border boards meet at the corners
  backingSpan: BackingSpan; // whether joists run only under the field or under the whole deck
}

export interface Gaps {
  sideGap: mm; // between rows
  endGap: mm; // butt-joint gap at a seam
}

export interface CutConfig {
  kerf: mm; // saw blade width removed per cut
  squareLeadingEnd: boolean; // trim the rough end of each fresh stock plank
  minReusableOffcut: mm; // shorter remainders are scrap
}

export type StaggerMode =
  | 'trueRandom'
  | 'randomWithRules'
  | 'jitteredBrick'
  | 'staggered'
  | 'maxScatter';

export interface StaggerConfig {
  mode: StaggerMode;
  minSeamOffset: mm; // min horizontal gap between seams in adjacent rows
  minPieceLength: mm; // anti-stub rule
  lookahead: number; // rows window for alignment checks
  seed: number; // reproducible; Reroll bumps it
  wasteVsLooks: number; // 0 = waste-first … 1 = looks-first
}

/** How to handle the leftover deck width that doesn't fill a whole board. */
export type WidthFit =
  | 'rip' // cut a board to the leftover width (mark the cut-off part)
  | 'extra' // add a full extra board that overhangs (mark the deck edge)
  | 'gap'; // leave the strip uncovered (mark a faded "missing" board)

export interface Project {
  plank: PlankSpec;
  gaps: Gaps;
  cut: CutConfig;
  stagger: StaggerConfig;
  widthFit: WidthFit;
  backingBoardWidth: mm; // physical width of a backing board; min edge inset = half this
  decks: Deck[];
}

// ---------------- results ----------------

export interface Segment {
  name: string; // board label, e.g. "A(3,2)" = deck A, row 3, 2nd plank in the row
  startMm: mm; // position of segment start along the row (0 = deck edge)
  lengthMm: mm; // cut length of the plank
  bays: number; // number of joist bays spanned
  barId: string; // which physical stock bar it came from
  reusedOffcut: boolean; // cut from a reused offcut rather than a fresh bar
}

/** What a row physically is, for the width-direction layout. */
export type RowKind =
  | 'full' // a normal full-width board
  | 'rip' // a board ripped narrower to fit the leftover width
  | 'extra' // a full board that overhangs the deck edge
  | 'gap'; // no board here — a faded placeholder

export interface Row {
  index: number;
  widthMm: mm; // the board's actual width as laid (plank width, or the rip width)
  yStartMm: mm; // position across the deck
  kind: RowKind;
  overhangMm?: mm; // for 'extra' rows: how much the board overhangs
  seams: mm[]; // joist positions of interior seams
  segments: Segment[];
}

/** A perimeter (picture-frame) board, in deck coordinates. */
export interface BorderBoard {
  name: string;
  lengthMm: mm;
  x: mm; // top-left, deck coords
  y: mm;
  w: mm; // drawn width  (= board length or plank width depending on orientation)
  h: mm; // drawn height
  points?: string; // SVG polygon points (deck coords) for mitred boards; rect used if absent
  barId: string;
  reusedOffcut: boolean;
}

export interface DeckLayout {
  deckId: string;
  label: string;
  lengthMm: mm; // full deck (incl. any border)
  widthMm: mm;
  plankWidthMm: mm; // full board width, for drawing rips / overhangs
  fieldInsetMm: mm; // border depth: the planking field is inset this far on all sides
  joistSpanWhole: boolean; // joists drawn across the whole deck (true) or the field only (false)
  borderBoards: BorderBoard[];
  joists: mm[]; // joist centre positions in DECK coordinates (for drawing)
  rows: Row[]; // field-local rows
  warnings: string[];
}

export interface CutPiece {
  lengthMm: mm;
  usedIn: string; // human label e.g. "Patio · row 3 · seg 2"
}

export interface CutInstruction {
  barId: string;
  stockLength: mm;
  source: StockSource; // from inventory or bought
  pieces: CutPiece[];
  cuts: number;
  kerfLoss: mm;
  endRemainder: mm;
  isScrap: boolean; // remainder below minReusableOffcut
}

export interface BomLine {
  stockLength: mm;
  count: number;
  source: StockSource;
  cost?: number;
}

/** A line in the shopping list — store planks to buy to cover the shortfall. */
export interface ShoppingLine {
  length: mm;
  count: number;
  cost?: number;
}

export interface Stats {
  totalBars: number;
  surfaceLength: mm; // actual deck surface laid
  purchasedLength: mm; // total stock opened
  kerfLoss: mm;
  scrap: mm;
  leftover: mm; // usable offcuts unused at job end (counts as waste)
  wastePct: number;
  barsFromInventory: number;
  barsToBuy: number;
  cost?: number; // cost of planks to buy (inventory is already owned)
}

export interface Result {
  layouts: DeckLayout[];
  cutList: CutInstruction[];
  bom: BomLine[];
  shoppingList: ShoppingLine[];
  stats: Stats;
  warnings: string[];
}
