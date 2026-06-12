// Orchestrator — runs the full pipeline and assembles the Result.
// Grid → Stage A (candidates) → Stage B (stagger) → Stage C (cut stock) → stats.

import type {
  AngledCut,
  BomLine,
  BorderBoard,
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
import { edgeNormals, normalizePolygon, offsetPolygon, polygonArea, rowSpans, type Pt } from './polygon';

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
  const borderIndex = new Map<string, BorderBoard>();

  for (let deckIndex = 0; deckIndex < decks.length; deckIndex++) {
    const deck = decks[deckIndex];
    const deckLetter = deckLabel(deckIndex);
    const deckWarnings: string[] = [];

    const shape = deck.shape ?? 'rect';

    // ---- Custom polygon shape ------------------------------------------------
    // Lay planks across the bounding box; each plank row is clipped to the
    // polygon (sampled at the row centreline, so non-convex decks split into
    // several runs), and boundary planks get an angled (bevelled) end cut.
    if (shape === 'custom') {
      const { poly, width: polyW, height: polyH } = normalizePolygon(deck.points ?? []);
      const joists = joistPositions({ ...deck, length: polyW }, backingBoardWidth);
      const seams = joists.filter((j) => j > EPS && j < polyW - EPS);
      const slots = rowSlots({ ...deck, width: polyH, length: polyW }, plank.width, gaps, widthFit);

      // Picture-frame border: inset the planking field by the border depth (the
      // polygon offset inward), and frame the original outline ring by ring.
      const Nc = Math.max(0, Math.floor(deck.borderBoards || 0));
      const pwB = plank.width;
      const stepB = pwB + gaps.sideGap;
      let bdC = Nc > 0 ? Nc * pwB + Nc * gaps.sideGap : 0;
      let normals: Pt[] = [];
      let fieldPoly = poly;
      if (bdC > 0 && poly.length >= 3) {
        normals = edgeNormals(poly);
        const inner = offsetPolygon(poly, normals, bdC);
        const a0 = polygonArea(poly);
        const a1 = polygonArea(inner);
        if (Math.sign(a1) !== Math.sign(a0) || Math.abs(a1) < Math.abs(a0) * 0.04) {
          deckWarnings.push(`"${deck.label}": ${Nc} border ring(s) are too wide for this shape — border ignored.`);
          bdC = 0;
        } else {
          fieldPoly = inner;
        }
      }

      let guard = stockLengths.length === 0;
      if (!guard && (poly.length < 3 || polyW <= 0 || polyH <= 0)) {
        deckWarnings.push(`"${deck.label}": add at least 3 corner points enclosing an area to lay out a custom shape.`);
        guard = true;
      }
      if (!guard && !deck.noSeams && deck.spacing <= 0) {
        deckWarnings.push(`"${deck.label}": enter a backing-board spacing greater than 0 so seams have a board to land on.`);
        guard = true;
      }
      if (!guard && seams.length > 600) {
        deckWarnings.push(`"${deck.label}": a ${deck.spacing} mm spacing creates ${seams.length} seam positions — too many to lay out. Increase the board spacing.`);
        guard = true;
      }

      // One "unit" (independent plank run) per covered span of each row.
      type Unit = { slotIdx: number; slot: (typeof slots)[number]; leftTop: number; leftBot: number; rightTop: number; rightBot: number; innerL: number; innerR: number; drawL: number; drawR: number; bandH: number };
      const units: Unit[] = [];
      if (!guard) {
        slots.forEach((slot, slotIdx) => {
          if (slot.kind === 'gap') return;
          const yTop = slot.yStartMm;
          const bandH = slot.widthMm;
          for (const sp of rowSpans(fieldPoly, yTop, Math.min(yTop + bandH, polyH))) {
            const innerL = Math.max(sp.leftTop, sp.leftBot);
            const innerR = Math.min(sp.rightTop, sp.rightBot);
            const drawL = Math.min(sp.leftTop, sp.leftBot, sp.xL);
            const drawR = Math.max(sp.rightTop, sp.rightBot, sp.xR);
            if (drawR - drawL < 1) continue;
            units.push({ slotIdx, slot, leftTop: sp.leftTop, leftBot: sp.leftBot, rightTop: sp.rightTop, rightBot: sp.rightBot, innerL, innerR, drawL, drawR, bandH });
          }
        });
      }

      const candsPerUnit: RowCandidate[][] = units.map((u) => {
        const usable = round(u.innerR - u.innerL);
        if (deck.noSeams || usable < stagger.minPieceLength) {
          return [{ seams: [], cutLengths: [Math.max(0, usable)], estWaste: 0 }];
        }
        const localSeams = seams.filter((s) => s > u.innerL + EPS && s < u.innerR - EPS).map((s) => round(s - u.innerL));
        const local = generateRowCandidates({ length: usable, legalSeams: localSeams, endGap: gaps.endGap, minPieceLength: stagger.minPieceLength, maxUsable, stockLengths, kerf: cut.kerf });
        if (local.length === 0) return [{ seams: [], cutLengths: [usable], estWaste: 0 }];
        return local.map((c) => ({ ...c, seams: c.seams.map((s) => round(s + u.innerL)) }));
      });

      const selections = guard ? [] : chooseLayout(candsPerUnit, stagger, rng, polyW || 1);

      const rows: Row[] = [];
      let rowCounter = 0;
      const segBaseBySlot = new Map<number, number>();
      selections.forEach((sel, ui) => {
        const u = units[ui];
        const angledLeft = Math.abs(u.leftTop - u.leftBot) > EPS;
        const angledRight = Math.abs(u.rightTop - u.rightBot) > EPS;
        const boundaries = [u.innerL, ...sel.seams, u.innerR];
        const last = boundaries.length - 2;
        const segBase = segBaseBySlot.get(u.slotIdx) ?? 0;
        const segments: Segment[] = [];
        for (let i = 0; i <= last; i++) {
          const startPos = boundaries[i];
          const endPos = boundaries[i + 1];
          const isFirst = i === 0;
          const isLast = i === last;
          const drawStart = isFirst ? u.drawL : startPos;
          const drawEnd = isLast ? u.drawR : endPos;
          const lTop = isFirst && angledLeft ? u.leftTop : drawStart;
          const lBot = isFirst && angledLeft ? u.leftBot : drawStart;
          const rTop = isLast && angledRight ? u.rightTop : drawEnd;
          const rBot = isLast && angledRight ? u.rightBot : drawEnd;
          const longMm = round(Math.max(rTop - lTop, rBot - lBot));
          const shortMm = round(Math.min(rTop - lTop, rBot - lBot));
          const segCuts: AngledCut[] = [];
          if (isFirst && angledLeft) segCuts.push({ side: 'L', longMm, shortMm, angleDeg: round((Math.atan2(Math.abs(u.leftTop - u.leftBot), u.bandH) * 180) / Math.PI) });
          if (isLast && angledRight) segCuts.push({ side: 'R', longMm, shortMm, angleDeg: round((Math.atan2(Math.abs(u.rightTop - u.rightBot), u.bandH) * 180) / Math.PI) });
          const lengthMm = segCuts.length ? longMm : round(endPos - startPos);
          const bays = deck.spacing > 0 ? Math.max(1, Math.round((endPos - startPos) / deck.spacing)) : 1;
          const name = `${deckLetter}(${u.slotIdx + 1},${segBase + i + 1})`;
          const seg: Segment = { name, startMm: round(startPos), lengthMm, bays, barId: '', reusedOffcut: false, drawStartMm: round(drawStart), drawEndMm: round(drawEnd), cuts: segCuts.length ? segCuts : undefined };
          segments.push(seg);
          const id = `${deck.id}#${ui}#${i}`;
          // Record the bevel in the cut-list label so angled ends are called out.
          const bevel = segCuts.length
            ? ` · bevel ${segCuts.map((c) => `${c.side} ${c.angleDeg}°`).join(', ')} (short ${shortMm} mm)`
            : '';
          demand.push({ id, length: lengthMm, label: name + bevel, cuts: segCuts.length ? segCuts : undefined });
          segIndex.set(id, seg);
        }
        segBaseBySlot.set(u.slotIdx, segBase + last + 1);
        rows.push({ index: rowCounter++, widthMm: u.slot.widthMm, yStartMm: u.slot.yStartMm, xStartMm: round(u.drawL), runLengthMm: round(u.drawR - u.drawL), kind: u.slot.kind, overhangMm: u.slot.overhangMm, seams: sel.seams, segments });
      });

      // Mitred picture frame following the polygon outline, ring by ring. Each
      // edge board is the quad between the outline offset by o and by o+pw; long
      // edges split into stock pieces (interior joints square).
      const borderBoards: BorderBoard[] = [];
      if (bdC > 0 && !guard) {
        const splitLenC = (len: number): number[] => {
          if (maxUsable <= 0 || len <= maxUsable) return [round(len)];
          const k = Math.ceil(len / maxUsable);
          return Array.from({ length: k }, () => round((len - (k - 1) * gaps.endGap) / k));
        };
        const lerp = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
        const n = poly.length;
        for (let ring = 0; ring < Nc; ring++) {
          const o = ring * stepB;
          const outer = offsetPolygon(poly, normals, o);
          const inner = offsetPolygon(poly, normals, o + pwB);
          for (let i = 0; i < n; i++) {
            const oS = outer[i], oE = outer[(i + 1) % n];
            const iS = inner[i], iE = inner[(i + 1) % n];
            const edgeLen = Math.hypot(oE.x - oS.x, oE.y - oS.y);
            if (edgeLen < 1) continue;
            const pieces = splitLenC(edgeLen);
            let cum = 0;
            pieces.forEach((plen, pi) => {
              const f0 = cum / edgeLen;
              const f1 = (cum + plen) / edgeLen;
              const q = [lerp(oS, oE, f0), lerp(oS, oE, f1), lerp(iE, iS, 1 - f1), lerp(iE, iS, 1 - f0)];
              const xs = q.map((p) => p.x);
              const ys = q.map((p) => p.y);
              const bx = Math.min(...xs), by = Math.min(...ys);
              const pts = q.map((p) => `${round(p.x)},${round(p.y)}`).join(' ');
              const base = `${deckLetter}·F${ring + 1}.${i + 1}`;
              const name = pieces.length > 1 ? `${base}-${pi + 1}` : base;
              const bb: BorderBoard = { name, lengthMm: round(plen), x: round(bx), y: round(by), w: round(Math.max(...xs) - bx), h: round(Math.max(...ys) - by), points: pts, barId: '', reusedOffcut: false };
              borderBoards.push(bb);
              const idk = `${deck.id}#F#${ring}e${i}#${pi}`;
              demand.push({ id: idk, length: bb.lengthMm, label: name });
              borderIndex.set(idk, bb);
              cum += plen + gaps.endGap;
            });
          }
        }
      }

      layouts.push({
        deckId: deck.id,
        label: deck.label,
        lengthMm: polyW,
        widthMm: polyH,
        plankWidthMm: plank.width,
        fieldInsetMm: 0,
        joistSpanWhole: true,
        polygon: poly,
        clipPolygon: bdC > 0 ? fieldPoly : undefined,
        borderBoards,
        joists,
        rows,
        warnings: deckWarnings,
      });
      warnings.push(...deckWarnings);
      continue;
    }

    // Framed border: N rings of boards around the perimeter; the planking field
    // shrinks by the border depth on all sides. For an L-shape the frame follows
    // the full 6-edge outline (including the concave notch corner), and the field
    // is the same L inset by the border depth — the notch keeps its size.
    const N = Math.max(0, Math.floor(deck.borderBoards || 0));
    let bd = N > 0 ? N * plank.width + N * gaps.sideGap : 0;
    if (bd > 0 && (deck.length - 2 * bd < plank.width || deck.width - 2 * bd < plank.width)) {
      deckWarnings.push(
        `"${deck.label}": ${N} border board(s) leave no room for the planking field — reduce the border count.`,
      );
      bd = 0;
    }
    const field = bd > 0 ? { ...deck, length: round(deck.length - 2 * bd), width: round(deck.width - 2 * bd) } : deck;

    // Backing boards: under the whole deck, or only under the field (inside the frame).
    // `joists` are centre positions in DECK coords (for drawing); `seams` are the
    // field-local legal seam positions the planks may butt on.
    const wholeSpan = deck.backingSpan === 'whole';
    let joists: number[];
    let seams: number[];
    if (wholeSpan) {
      joists = joistPositions(deck, backingBoardWidth);
      seams = joists.filter((j) => j > bd + EPS && j < deck.length - bd - EPS).map((j) => round(j - bd));
    } else {
      const fieldJoists = joistPositions(field, backingBoardWidth);
      joists = fieldJoists.map((j) => round(j + bd));
      seams = legalSeams(field, backingBoardWidth);
    }
    const slots = rowSlots(field, plank.width, gaps, widthFit);

    // L-shape: a rectangular notch removed from one corner. The notch must fit
    // inside the (possibly bordered) field. `notch` is in DECK coords for drawing
    // the outline; the per-row run uses the same nl0/nw0 against the field.
    const nl0 = round(deck.notchLength || 0);
    const nw0 = round(deck.notchWidth || 0);
    const hasNotch =
      shape === 'lshape' &&
      nl0 > 0 &&
      nw0 > 0 &&
      nl0 < field.length - EPS &&
      nw0 < field.width - EPS;
    if (shape === 'lshape' && !hasNotch && (nl0 > 0 || nw0 > 0))
      deckWarnings.push(
        `"${deck.label}": the notch (${nl0}×${nw0} mm) doesn't fit inside the ${field.length}×${field.width} mm planking field — showing a plain rectangle. Reduce the notch size or the border.`,
      );
    const corner = deck.notchCorner ?? 'TR';
    const onLeft = corner === 'TL' || corner === 'BL';
    const onTop = corner === 'TL' || corner === 'TR';
    const notch = hasNotch
      ? {
          x: onLeft ? 0 : round(deck.length - nl0),
          y: onTop ? 0 : round(deck.width - nw0),
          w: nl0,
          h: nw0,
        }
      : undefined;
    // Per-row plank run: full deck length, unless the row meets the notch band.
    const rowRun = (slot: { yStartMm: number; widthMm: number }) => {
      if (!hasNotch) return { xStart: 0, runLength: field.length };
      const mid = slot.yStartMm + slot.widthMm / 2;
      const inBand = onTop ? mid < nw0 - EPS : mid > field.width - nw0 + EPS;
      if (!inBand) return { xStart: 0, runLength: field.length };
      return { xStart: onLeft ? nl0 : 0, runLength: round(field.length - nl0) };
    };

    // Friendly, deck-level diagnostics — computed BEFORE the expensive candidate
    // enumeration so a bad value (e.g. a tiny spacing) can't blow up the engine.
    const MAX_SEAMS = 600;
    const fullPlankFits = stockLengths.length > 0 && field.length - gaps.endGap <= maxUsable;
    const seamlessFits = stockLengths.length > 0 && field.length <= maxUsable;
    let guard = stockLengths.length === 0; // global message already added
    if (guard) {
      // no stock — message already added globally
    } else if (field.noSeams) {
      // Seamless decks ignore the joist grid for layout; they only need a plank
      // long enough to span the whole field.
      if (!seamlessFits) {
        deckWarnings.push(
          `"${deck.label}": "No seams" is on, but the planking field is ${field.length} mm long — longer than your longest plank (${maxStock} mm). Turn off "No seams" or add a longer stock length.`,
        );
        guard = true;
      }
    } else if (field.spacing <= 0) {
      deckWarnings.push(
        `"${deck.label}": enter a backing-board spacing greater than 0 so seams have a board to land on.`,
      );
      guard = true;
    } else if (seams.length > MAX_SEAMS) {
      deckWarnings.push(
        `"${deck.label}": a ${field.spacing} mm spacing creates ${seams.length} seam positions on a ${field.length} mm field — too many to lay out. Increase the board spacing.`,
      );
      guard = true;
    } else if (seams.length === 0 && !fullPlankFits) {
      deckWarnings.push(
        `"${deck.label}": no backing boards fall inside the deck, and it is longer than your longest plank (${maxStock} mm). Reduce the board spacing or add a longer stock length.`,
      );
      guard = true;
    }

    // Each row is laid out in its own local 0..runLength frame (so cut-length and
    // min-piece logic are run-relative), then seam positions are shifted to
    // absolute deck coords so the cross-row stagger rules stay aligned.
    const runs = slots.map(rowRun);
    const candidatesPerRow: RowCandidate[][] = slots.map((slot, i) => {
      if (guard || slot.kind === 'gap') return []; // gap rows are intentionally empty
      const { xStart, runLength } = runs[i];
      if (field.noSeams) return [{ seams: [] as number[], cutLengths: [runLength], estWaste: 0 }];
      const localSeams = seams.filter((s) => s > xStart + EPS && s < xStart + runLength - EPS).map((s) => round(s - xStart));
      const local = generateRowCandidates({
        length: runLength,
        legalSeams: localSeams,
        endGap: gaps.endGap,
        minPieceLength: stagger.minPieceLength,
        maxUsable,
        stockLengths,
        kerf: cut.kerf,
      });
      if (xStart === 0) return local;
      return local.map((c) => ({ ...c, seams: c.seams.map((s) => round(s + xStart)) }));
    });

    if (!guard) {
      candidatesPerRow.forEach((c, i) => {
        if (c.length === 0 && slots[i].kind !== 'gap')
          deckWarnings.push(
            `Row ${i + 1}: no valid plank layout — check the min-piece length against your stock lengths.`,
          );
      });
    }

    const selections = chooseLayout(candidatesPerRow, stagger, rng, field.length);

    const rows: Row[] = selections.map((sel, r) => {
      const slot = slots[r];
      const { xStart, runLength } = runs[r];
      // Unsolvable row (no candidate fit): render an empty band, emit no demand.
      if (candidatesPerRow[r].length === 0) {
        return {
          index: r,
          widthMm: slot.widthMm,
          yStartMm: slot.yStartMm,
          xStartMm: xStart,
          runLengthMm: runLength,
          kind: slot.kind,
          overhangMm: slot.overhangMm,
          seams: [],
          segments: [],
        };
      }
      // sel.seams are absolute deck coords; boundaries span the row's own run.
      const boundaries = [xStart, ...sel.seams, round(xStart + runLength)];
      const segments: Segment[] = [];
      for (let i = 0; i < boundaries.length - 1; i++) {
        const startPos = boundaries[i];
        const endPos = boundaries[i + 1];
        const lengthMm = sel.cutLengths[i] ?? round(endPos - startPos);
        const bays = field.spacing > 0 ? Math.max(1, Math.round((endPos - startPos) / field.spacing)) : 1;
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
        xStartMm: xStart,
        runLengthMm: runLength,
        kind: slot.kind,
        overhangMm: slot.overhangMm,
        seams: sel.seams,
        segments,
      };
    });

    // Perimeter (picture-frame) border boards, in full-deck coordinates.
    // A side longer than a stock plank is split into butt-jointed pieces.
    const borderBoards: BorderBoard[] = [];
    if (bd > 0) {
      const pw = plank.width;
      const step = pw + gaps.sideGap;
      const splitLen = (len: number): number[] => {
        if (maxUsable <= 0 || len <= maxUsable) return [round(len)];
        const k = Math.ceil(len / maxUsable);
        return Array.from({ length: k }, () => round((len - (k - 1) * gaps.endGap) / k));
      };
      const emit = (name: string, idKey: string, pi: number, len: number, x: number, y: number, w: number, h: number, points?: string) => {
        const bb: BorderBoard = { name, lengthMm: round(len), x: round(x), y: round(y), w: round(w), h: round(h), points, barId: '', reusedOffcut: false };
        borderBoards.push(bb);
        demand.push({ id: `${deck.id}#F#${idKey}#${pi}`, length: bb.lengthMm, label: name });
        borderIndex.set(`${deck.id}#F#${idKey}#${pi}`, bb);
      };
      // Butt-jointed side: a straight run split into pieces.
      const addButt = (base: string, idKey: string, x: number, y: number, cross: number, len: number, horizontal: boolean) => {
        const pieces = splitLen(len);
        let cursor = horizontal ? x : y;
        pieces.forEach((plen, pi) => {
          const name = pieces.length > 1 ? `${base}.${pi + 1}` : base;
          emit(name, idKey, pi, plen, horizontal ? cursor : x, horizontal ? y : cursor, horizontal ? plen : cross, horizontal ? cross : plen);
          cursor += plen + gaps.endGap;
        });
      };
      // Mitred side: 45° cuts at the true corners; interior joints (when split) are square.
      const addMitred = (base: string, idKey: string, side: 'T' | 'B' | 'L' | 'R', o: number) => {
        const horizontal = side === 'T' || side === 'B';
        const len = horizontal ? deck.length - 2 * o : deck.width - 2 * o;
        const pieces = splitLen(len);
        let cur = o;
        pieces.forEach((plen, pi) => {
          const a = cur;
          const b = cur + plen;
          const ms = pi === 0; // mitre at the starting corner
          const me = pi === pieces.length - 1; // mitre at the ending corner
          const name = pieces.length > 1 ? `${base}.${pi + 1}` : base;
          let pts = '';
          let bx = 0, by = 0, bw = 0, bh = 0;
          if (side === 'T') {
            const iL = ms ? a + pw : a, iR = me ? b - pw : b;
            pts = `${a},${o} ${b},${o} ${iR},${o + pw} ${iL},${o + pw}`;
            bx = a; by = o; bw = plen; bh = pw;
          } else if (side === 'B') {
            const yb = deck.width - o, yt = deck.width - o - pw;
            const iL = ms ? a + pw : a, iR = me ? b - pw : b;
            pts = `${a},${yb} ${b},${yb} ${iR},${yt} ${iL},${yt}`;
            bx = a; by = yt; bw = plen; bh = pw;
          } else if (side === 'L') {
            const iT = ms ? a + pw : a, iB = me ? b - pw : b;
            pts = `${o},${a} ${o},${b} ${o + pw},${iB} ${o + pw},${iT}`;
            bx = o; by = a; bw = pw; bh = plen;
          } else {
            const xr = deck.length - o, xl = deck.length - o - pw;
            const iT = ms ? a + pw : a, iB = me ? b - pw : b;
            pts = `${xr},${a} ${xr},${b} ${xl},${iB} ${xl},${iT}`;
            bx = xl; by = a; bw = pw; bh = plen;
          }
          emit(name, idKey, pi, plen, bx, by, bw, bh, pts);
          cur += plen + gaps.endGap;
        });
      };

      // General edge board for the L-shape outline: a trapezoid bounded by the
      // edge's outer/inner offset lines and the two end (mitre or butt) lines,
      // split into stock-length pieces. Mitres at true corners; interior splits
      // are square. Works for convex and concave (notch) corners alike.
      const emitEdge = (
        base: string,
        idKey: string,
        horiz: boolean,
        oS: [number, number],
        oE: [number, number],
        iS: [number, number],
        iE: [number, number],
      ) => {
        const ai = horiz ? 0 : 1; // index of the along-edge coordinate
        const ci = horiz ? 1 : 0; // index of the cross-edge coordinate
        const cOut = oS[ci];
        const cIn = iS[ci];
        const a0o = oS[ai], a1o = oE[ai], a0i = iS[ai], a1i = iE[ai];
        const total = Math.abs(a1o - a0o);
        if (total < EPS) return;
        const dir = a1o >= a0o ? 1 : -1;
        const P = (along: number, cross: number) =>
          horiz ? `${round(along)},${round(cross)}` : `${round(cross)},${round(along)}`;
        const pieces = splitLen(total);
        let cum = 0;
        pieces.forEach((plen, pi) => {
          const first = pi === 0, last = pi === pieces.length - 1;
          const outStart = a0o + dir * cum;
          const outEnd = a0o + dir * (cum + plen);
          const inStart = first ? a0i : outStart; // square at interior joints
          const inEnd = last ? a1i : outEnd;
          const pts = `${P(outStart, cOut)} ${P(outEnd, cOut)} ${P(inEnd, cIn)} ${P(inStart, cIn)}`;
          const alongs = [outStart, outEnd, inStart, inEnd];
          const aMin = Math.min(...alongs), aMax = Math.max(...alongs);
          const cMin = Math.min(cOut, cIn), cMax = Math.max(cOut, cIn);
          const bx = horiz ? aMin : cMin;
          const by = horiz ? cMin : aMin;
          const bw = horiz ? aMax - aMin : cMax - cMin;
          const bh = horiz ? cMax - cMin : aMax - aMin;
          const cut = Math.max(Math.abs(outEnd - outStart), Math.abs(inEnd - inStart));
          emit(pieces.length > 1 ? `${base}-${pi + 1}` : base, idKey, pi, cut, bx, by, bw, bh, pts);
          cum += plen + gaps.endGap;
        });
      };

      if (!hasNotch) {
        // Rectangle (4 sides) — original corner-style layout.
        for (let ring = 0; ring < N; ring++) {
          const o = ring * step;
          const F = (side: string) => `${deckLetter}·F${ring + 1}${side}`;
          if (deck.cornerStyle === 'mitered') {
            addMitred(F('T'), `${ring}T`, 'T', o);
            addMitred(F('B'), `${ring}B`, 'B', o);
            addMitred(F('L'), `${ring}L`, 'L', o);
            addMitred(F('R'), `${ring}R`, 'R', o);
          } else if (deck.cornerStyle === 'staggered') {
            // Pinwheel: each board butts the side of the next, rotating around — so all
            // four are the same length on a square deck.
            const longH = deck.length - 2 * o - pw;
            const longV = deck.width - 2 * o - pw;
            if (longH > 0 && longV > 0) {
              addButt(F('T'), `${ring}T`, o, o, pw, longH, true);
              addButt(F('R'), `${ring}R`, deck.length - o - pw, o, pw, longV, false);
              addButt(F('B'), `${ring}B`, o + pw, deck.width - o - pw, pw, longH, true);
              addButt(F('L'), `${ring}L`, o, o + pw, pw, longV, false);
            }
          } else if (deck.cornerStyle === 'topBottom') {
            const longLen = deck.length - 2 * o;
            const sideLen = deck.width - 2 * o - 2 * pw;
            addButt(F('T'), `${ring}T`, o, o, pw, longLen, true);
            addButt(F('B'), `${ring}B`, o, deck.width - o - pw, pw, longLen, true);
            if (sideLen > 0) {
              addButt(F('L'), `${ring}L`, o, o + pw, pw, sideLen, false);
              addButt(F('R'), `${ring}R`, deck.length - o - pw, o + pw, pw, sideLen, false);
            }
          } else {
            // 'sides' — left & right run full width
            const longLen = deck.width - 2 * o;
            const midLen = deck.length - 2 * o - 2 * pw;
            addButt(F('L'), `${ring}L`, o, o, pw, longLen, false);
            addButt(F('R'), `${ring}R`, deck.length - o - pw, o, pw, longLen, false);
            if (midLen > 0) {
              addButt(F('T'), `${ring}T`, o + pw, o, pw, midLen, true);
              addButt(F('B'), `${ring}B`, o + pw, deck.width - o - pw, pw, midLen, true);
            }
          }
        }
      } else {
        // L-shape — one board per outline edge per ring. Offset each edge inward
        // by the ring depth and intersect with its neighbours' offset lines; that
        // single rule yields correct mitres at every corner, concave included.
        const verts = lOutlineVerts(deck.length, deck.width, onLeft, onTop, nl0, nw0);
        const mE = verts.length;
        const inside = (x: number, y: number) => pointInPoly(x, y, verts);
        const edges = verts.map((v, i) => {
          const v2 = verts[(i + 1) % mE];
          const horizontal = Math.abs(v[1] - v2[1]) < EPS;
          const mx = (v[0] + v2[0]) / 2, my = (v[1] + v2[1]) / 2;
          const nx = horizontal ? 0 : inside(mx + 1, my) ? 1 : -1;
          const ny = horizontal ? (inside(mx, my + 1) ? 1 : -1) : 0;
          return { ax: v[0], ay: v[1], horizontal, nx, ny };
        });
        type E = (typeof edges)[number];
        const coordAt = (e: E, t: number) => (e.horizontal ? e.ay + e.ny * t : e.ax + e.nx * t);
        const isect = (ei: E, ti: number, ej: E, tj: number): [number, number] =>
          ei.horizontal ? [coordAt(ej, tj), coordAt(ei, ti)] : [coordAt(ei, ti), coordAt(ej, tj)];
        for (let ring = 0; ring < N; ring++) {
          const o = ring * step;
          // Butt styles: which orientation runs long (mitered handled separately).
          const horizLong = deck.cornerStyle === 'topBottom' || (deck.cornerStyle === 'staggered' && ring % 2 === 0);
          const vertLong = deck.cornerStyle === 'sides' || (deck.cornerStyle === 'staggered' && ring % 2 === 1);
          for (let i = 0; i < mE; i++) {
            const e = edges[i], prev = edges[(i - 1 + mE) % mE], next = edges[(i + 1) % mE];
            const base = `${deckLetter}·F${ring + 1}.${i + 1}`;
            const idKey = `${ring}e${i}`;
            if (deck.cornerStyle === 'mitered') {
              emitEdge(base, idKey, e.horizontal,
                isect(e, o, prev, o), isect(e, o, next, o),
                isect(e, o + pw, prev, o + pw), isect(e, o + pw, next, o + pw));
            } else {
              // Long boards cover the corner (neighbour's outer face); short boards
              // butt against the long board's inner face.
              const isLong = e.horizontal ? horizLong : vertLong;
              const t = isLong ? o : o + pw;
              emitEdge(base, idKey, e.horizontal,
                isect(e, o, prev, t), isect(e, o, next, t),
                isect(e, o + pw, prev, t), isect(e, o + pw, next, t));
            }
          }
        }
      }
    }

    layouts.push({
      deckId: deck.id,
      label: deck.label,
      lengthMm: deck.length,
      widthMm: deck.width,
      plankWidthMm: plank.width,
      fieldInsetMm: bd,
      joistSpanWhole: wholeSpan,
      notch,
      borderBoards,
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
    const target = segIndex.get(id) ?? borderIndex.get(id);
    if (target) {
      target.barId = place.barId;
      target.reusedOffcut = place.reusedOffcut;
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

/** L-shape outline vertices (deck coords), clockwise — matches DeckCanvas. */
function lOutlineVerts(
  L: number,
  W: number,
  onLeft: boolean,
  onTop: boolean,
  w: number,
  h: number,
): Array<[number, number]> {
  if (onTop && onLeft) return [[w, 0], [L, 0], [L, W], [0, W], [0, h], [w, h]];
  if (onTop && !onLeft) return [[0, 0], [L - w, 0], [L - w, h], [L, h], [L, W], [0, W]];
  if (!onTop && onLeft) return [[0, 0], [L, 0], [L, W], [w, W], [w, W - h], [0, W - h]];
  return [[0, 0], [L, 0], [L, W - h], [L - w, W - h], [L - w, W], [0, W]]; // bottom-right
}

/** Ray-cast point-in-polygon test (used to find each edge's inward normal). */
function pointInPoly(x: number, y: number, verts: Array<[number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = verts.length - 1; i < verts.length; j = i++) {
    const [xi, yi] = verts[i];
    const [xj, yj] = verts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
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
