import type { Project } from './types';

export const defaultProject: Project = {
  plank: {
    width: 120,
    thickness: 28,
    onHand: [{ length: 4800, quantity: 6 }],
    store: [
      { length: 3600, pricePerUnit: 9 },
      { length: 4800, pricePerUnit: 13 },
      { length: 5400, pricePerUnit: 15 },
    ],
  },
  gaps: { sideGap: 5, endGap: 3 },
  cut: { kerf: 3, squareLeadingEnd: false, minReusableOffcut: 580 },
  stagger: {
    mode: 'randomWithRules',
    minSeamOffset: 300,
    minPieceLength: 1160,
    lookahead: 2,
    seed: 1,
    wasteVsLooks: 0.5,
  },
  widthFit: 'rip',
  backingBoardWidth: 48,
  decks: [
    { id: 'deck1', label: 'Patio', length: 6000, width: 4000, spacing: 600, firstOffset: 24, noSeams: false, borderBoards: 0, cornerStyle: 'mitered', backingSpan: 'whole' },
  ],
};
