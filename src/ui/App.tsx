import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Capacitor } from '@capacitor/core';
import type { BackingSpan, CornerStyle, Deck, Project, StaggerMode, WidthFit } from '../model/types';
import { defaultProject } from '../model/defaults';
import { optimize } from '../engine/optimize';
import { saveFile } from '../platform/save';
import { listProjects, loadProject, saveProject, deleteProject } from '../platform/library';
import { APP_VERSION, checkForUpdate, type UpdateInfo } from '../platform/updates';
import { Results } from './Results';

const MODES: { value: StaggerMode; label: string; desc: string }[] = [
  { value: 'trueRandom', label: 'True random', desc: 'Seams placed at random legal joists with no aesthetic rules. Can look messy or accidentally aligned — useful only as a baseline.' },
  { value: 'randomWithRules', label: 'Random with rules', desc: "Random placement, but enforces the minimum seam offset and avoids aligned seams, staircases and repeating patterns. The natural, 'not too structured' look." },
  { value: 'jitteredBrick', label: 'Jittered brick', desc: 'Aims for a roughly consistent offset between rows, with random jitter so it never becomes an exact running-bond pattern.' },
  { value: 'staggered', label: 'Staggered', desc: 'A regular, deterministic offset step between rows — the classic orderly running-bond look.' },
  { value: 'maxScatter', label: 'Maximum scatter', desc: 'Pushes every seam as far as possible from seams in nearby rows. The most chaotic, least patterned result.' },
];

const WIDTH_FITS: { value: WidthFit; label: string; desc: string }[] = [
  { value: 'rip', label: 'Cut board to fit', desc: 'Rip the last board down to the leftover width. The cut-off strip is shown faded grey.' },
  { value: 'extra', label: 'Extra board (overhang)', desc: 'Add a full extra board that overhangs the deck; the deck edge is drawn through it.' },
  { value: 'gap', label: 'Leave a gap (no board)', desc: 'Leave the leftover strip uncovered; a faded grey board marks where it would have gone.' },
];

const isNative = Capacitor.isNativePlatform();

/** Merge a loaded/partial project over defaults so older files and saves still open. */
function normalizeProject(data: Partial<Project>): Project {
  const deckBase = (i: number): Deck => ({
    id: `deck${i + 1}`, label: `Deck ${i + 1}`, length: 4000, width: 3000,
    spacing: 600, firstOffset: defaultProject.decks[0].firstOffset, noSeams: false, borderBoards: 0,
    cornerStyle: 'mitered', backingSpan: 'whole',
  });
  const srcDecks = Array.isArray(data.decks) && data.decks.length ? data.decks : defaultProject.decks;
  const decks: Deck[] = srcDecks.map((d, i) => ({ ...deckBase(i), ...d }));
  return {
    ...defaultProject,
    ...data,
    plank: { ...defaultProject.plank, ...data.plank },
    gaps: { ...defaultProject.gaps, ...data.gaps },
    cut: { ...defaultProject.cut, ...data.cut },
    stagger: { ...defaultProject.stagger, ...data.stagger },
    widthFit: data.widthFit ?? defaultProject.widthFit,
    backingBoardWidth: data.backingBoardWidth ?? defaultProject.backingBoardWidth,
    decks,
  };
}

export function App() {
  const [project, setProject] = useState<Project>(defaultProject);
  const result = useMemo(() => optimize(project), [project]);
  const fileRef = useRef<HTMLInputElement>(null);

  // Check GitHub for a newer release (public repo, unauthenticated).
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [updateDismissed, setUpdateDismissed] = useState(false);
  useEffect(() => { checkForUpdate().then(setUpdate); }, []);

  // ---- internal library ----
  const [saved, setSaved] = useState<string[]>([]);
  const [projName, setProjName] = useState('');
  const [picked, setPicked] = useState('');
  const refresh = () => listProjects().then(setSaved);
  useEffect(() => { refresh(); }, []);

  const doSaveProject = async () => {
    const name = (projName.trim() || project.decks[0]?.label || 'Untitled').trim();
    await saveProject(name, project);
    setProjName(name);
    await refresh();
    setPicked(name);
  };
  const doLoadProject = async () => {
    if (!picked) return;
    const p = await loadProject(picked);
    if (p) setProject(normalizeProject(p));
  };
  const doDeleteProject = async () => {
    if (!picked) return;
    if (!window.confirm(`Delete saved project "${picked}"? This can't be undone.`)) return;
    await deleteProject(picked);
    setPicked('');
    await refresh();
  };

  // ---- .deck import / export ----
  const exportDeck = () => {
    const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
    const name = (project.decks[0]?.label || 'deckbuilder').replace(/[^a-z0-9_-]+/gi, '-').toLowerCase();
    void saveFile(`${name}.deck`, blob);
  };
  const importDeck = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result)) as Partial<Project>;
        if (!Array.isArray(data.decks) || !data.plank || !data.stagger) throw new Error('not a DeckBuilder file');
        setProject(normalizeProject(data));
      } catch (err) {
        alert(`Could not load this .deck file: ${(err as Error).message}`);
      }
    };
    reader.readAsText(file);
  };

  // ---- editors ----
  const patch = (p: Partial<Project>) => setProject((cur) => ({ ...cur, ...p }));
  const patchPlank = (p: Partial<Project['plank']>) => patch({ plank: { ...project.plank, ...p } });
  const patchGaps = (p: Partial<Project['gaps']>) => patch({ gaps: { ...project.gaps, ...p } });
  const patchCut = (p: Partial<Project['cut']>) => patch({ cut: { ...project.cut, ...p } });
  const patchStag = (p: Partial<Project['stagger']>) => patch({ stagger: { ...project.stagger, ...p } });
  const setSeed = (seed: number) => patchStag({ seed: Math.max(1, seed) });

  const updateDeck = (i: number, p: Partial<Deck>) =>
    patch({ decks: project.decks.map((d, idx) => (idx === i ? { ...d, ...p } : d)) });
  const addDeck = () =>
    patch({ decks: [...project.decks, { id: `deck${Date.now()}`, label: `Deck ${project.decks.length + 1}`, length: 4000, width: 3000, spacing: 600, firstOffset: defaultProject.decks[0].firstOffset, noSeams: false, borderBoards: 0, cornerStyle: 'mitered', backingSpan: 'whole' }] });
  const removeDeck = (i: number) => {
    if (!window.confirm(`Delete deck "${project.decks[i]?.label}"? This can't be undone.`)) return;
    patch({ decks: project.decks.filter((_, idx) => idx !== i) });
  };

  const autoFitSpacing = (i: number) => {
    const d = project.decks[i];
    const target = d.spacing > 0 ? d.spacing : 600;
    // When the joists sit inside the frame, even-fit the FIELD length (deck minus border).
    const bd = d.borderBoards > 0 ? d.borderBoards * (project.plank.width + project.gaps.sideGap) : 0;
    const len = d.backingSpan === 'field' ? d.length - 2 * bd : d.length;
    if (len <= 0) return;
    const bays = Math.max(1, Math.ceil(len / target));
    updateDeck(i, { spacing: Math.ceil(len / bays) });
  };

  const updateOnHand = (i: number, field: 'length' | 'quantity', v: number) =>
    patchPlank({ onHand: project.plank.onHand.map((l, idx) => (idx === i ? { ...l, [field]: v } : l)) });
  const addOnHand = () => patchPlank({ onHand: [...project.plank.onHand, { length: 4800, quantity: 1 }] });
  const removeOnHand = (i: number) => patchPlank({ onHand: project.plank.onHand.filter((_, idx) => idx !== i) });

  const updateStore = (i: number, field: 'length' | 'pricePerUnit', v: number) =>
    patchPlank({ store: project.plank.store.map((l, idx) => (idx === i ? { ...l, [field]: v } : l)) });
  const addStore = () => patchPlank({ store: [...project.plank.store, { length: 4200, pricePerUnit: 0 }] });
  const removeStore = (i: number) => patchPlank({ store: project.plank.store.filter((_, idx) => idx !== i) });

  const mode = MODES.find((m) => m.value === project.stagger.mode)!;
  const widthFit = WIDTH_FITS.find((w) => w.value === project.widthFit)!;
  const minInset = project.backingBoardWidth / 2;

  return (
    <div className="app">
      <aside className="sidebar">
        <h1>DeckBuilder <span className="ver">v{APP_VERSION}</span></h1>
        <p className="tagline">Plank layout & cut optimizer</p>

        {update && !updateDismissed && (
          <div className="update-banner">
            <span>Update available: <strong>v{update.latest}</strong></span>
            <a className="btn" href={update.url} target="_blank" rel="noreferrer">Get it</a>
            <button className="x" onClick={() => setUpdateDismissed(true)} aria-label="Dismiss">✕</button>
          </div>
        )}

        <h2>Projects</h2>
        <Field label="Name" hint="Name to save the current project under, in the app's own storage.">
          <input type="text" value={projName} placeholder="my patio" onChange={(e) => setProjName(e.target.value)} />
        </Field>
        <div className="session-row">
          <button className="btn secondary" onClick={doSaveProject}>💾 Save</button>
          <button className="btn secondary" onClick={doLoadProject} disabled={!picked}>📂 Load</button>
          <button className="btn secondary" onClick={doDeleteProject} disabled={!picked} title="Delete the selected saved project">🗑</button>
        </div>
        <Field label="Saved" hint="Projects stored inside the app (on this device). Pick one, then Load or Delete.">
          <select value={picked} onChange={(e) => setPicked(e.target.value)}>
            <option value="">— {saved.length} saved —</option>
            {saved.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </Field>
        <div className="session-row">
          <button className="btn secondary" onClick={exportDeck} title="Export the current project to a .deck file you can share or back up.">⬇ Export .deck</button>
          <button className="btn secondary" onClick={() => fileRef.current?.click()} title="Import a .deck file.">⬆ Import .deck</button>
          <input ref={fileRef} type="file" accept={isNative ? undefined : '.deck,application/json'} onChange={importDeck} style={{ display: 'none' }} />
        </div>

        <h2>Pattern seed</h2>
        <div className="seed-nav">
          <button onClick={() => setSeed(project.stagger.seed - 1)} disabled={project.stagger.seed <= 1} title="Previous pattern">◀</button>
          <div className="seed-label"><span>seed {project.stagger.seed}</span><small>pattern</small></div>
          <button onClick={() => setSeed(project.stagger.seed + 1)} title="Next pattern">▶</button>
          <button onClick={() => setSeed(Math.floor(Math.random() * 99999) + 1)} title="Random pattern">🎲</button>
        </div>

        <h2>Decks</h2>
        {project.decks.map((d, i) => (
          <div key={d.id} className="deck-edit">
            <Text label="Name" hint="A label for this deck, shown above its plan." value={d.label} onChange={(v) => updateDeck(i, { label: v })} />
            <Num label="Length (mm)" hint="Deck size in the direction the planks run." value={d.length} onChange={(v) => updateDeck(i, { length: v })} />
            <Num label="Width (mm)" hint="Deck size across the planks (the number of rows)." value={d.width} onChange={(v) => updateDeck(i, { width: v })} />
            <Num label="Board spacing (mm)" hint="Backing-board (joist) spacing for THIS deck, centre to centre. Seams may only land on a board." value={d.spacing} onChange={(v) => updateDeck(i, { spacing: v })} />
            <Num label="Edge board inset (mm)" hint={`Centre of the edge backing boards, measured in from each deck edge. Minimum ${minInset} mm (half the backing-board width).`} value={d.firstOffset} onChange={(v) => updateDeck(i, { firstOffset: Math.max(minInset, v) })} />
            <Field label="No seams (single boards)" hint="For short decks: lay one full-length board per row with no butt joints. Each board must be at least as long as the deck; board spacing is then ignored for the layout.">
              <input type="checkbox" checked={d.noSeams} onChange={(e) => updateDeck(i, { noSeams: e.target.checked })} />
            </Field>
            <Num label="Border boards" hint="Picture-frame border: number of decking boards run around the whole deck perimeter (0 = none). The planking field shrinks to fit inside the border." value={d.borderBoards} onChange={(v) => updateDeck(i, { borderBoards: Math.max(0, Math.round(v)) })} />
            {d.borderBoards > 0 && (
              <Field label="Corner style" hint="How the border boards meet at the corners. Mitered = 45° cuts; the butt options choose which pair of sides runs full-length (staggered alternates ring by ring).">
                <select value={d.cornerStyle} onChange={(e) => updateDeck(i, { cornerStyle: e.target.value as CornerStyle })}>
                  <option value="mitered">Mitered (45°)</option>
                  <option value="topBottom">Butt — top/bottom long</option>
                  <option value="sides">Butt — sides long</option>
                  <option value="staggered">Butt — staggered</option>
                </select>
              </Field>
            )}
            {d.borderBoards > 0 && (
              <Field label="Backing boards" hint="Where the joists run: only under the planking field (inside the frame) or under the whole deck including beneath the border. With 'Inside frame', Auto-fit even spacing divides the field length, not the whole deck.">
                <select value={d.backingSpan} onChange={(e) => updateDeck(i, { backingSpan: e.target.value as BackingSpan })}>
                  <option value="whole">Under whole deck</option>
                  <option value="field">Inside frame only</option>
                </select>
              </Field>
            )}
            <button className="btn secondary" style={{ fontSize: 12, padding: 6 }} disabled={d.noSeams} onClick={() => autoFitSpacing(i)} title="Set the board spacing to the largest value at or below the current one that splits the deck length into equal bays.">⚙ Auto-fit even spacing</button>
            {project.decks.length > 1 && (
              <button className="btn secondary" onClick={() => removeDeck(i)} style={{ fontSize: 12, padding: 6 }}>Remove deck</button>
            )}
          </div>
        ))}
        <button className="btn secondary" onClick={addDeck}>+ Add deck</button>

        <h2>Plank</h2>
        <Num label="Width (mm)" hint="Face width of a single decking board." value={project.plank.width} onChange={(v) => patchPlank({ width: v })} />
        <Num label="Thickness (mm)" hint="Board thickness (used for the bill of materials only)." value={project.plank.thickness} onChange={(v) => patchPlank({ thickness: v })} />
        <div className="lengths">
          <Field label="On hand · length · qty" hint="Planks you already own. These are used first, before buying anything." />
          {project.plank.onHand.map((l, i) => (
            <div className="row" key={i}>
              <NumberBox value={l.length} title="Length of planks you have (mm)" onCommit={(v) => updateOnHand(i, 'length', v)} />
              <NumberBox value={l.quantity} title="How many of this length you have" onCommit={(v) => updateOnHand(i, 'quantity', v)} />
              <button onClick={() => removeOnHand(i)} title="Remove this inventory line">✕</button>
            </div>
          ))}
          <button className="btn secondary" onClick={addOnHand}>+ Add on-hand</button>
        </div>
        <div className="lengths">
          <Field label="Store · length · price" hint="Plank lengths the store sells (assumed unlimited), each with a unit price. Bought only to cover what your inventory can't." />
          {project.plank.store.map((l, i) => (
            <div className="row" key={i}>
              <NumberBox value={l.length} title="Store plank length (mm)" onCommit={(v) => updateStore(i, 'length', v)} />
              <NumberBox value={l.pricePerUnit ?? 0} title="Price per plank" onCommit={(v) => updateStore(i, 'pricePerUnit', v)} />
              <button onClick={() => removeStore(i)} title="Remove this store length">✕</button>
            </div>
          ))}
          <button className="btn secondary" onClick={addStore}>+ Add store length</button>
        </div>

        <h2>Backing boards, gaps & cutting</h2>
        <Num label="Backing board width (mm)" hint="Physical width of a backing board (joist). The edge boards' centre can't be closer to the edge than half this." value={project.backingBoardWidth} onChange={(v) => patch({ backingBoardWidth: v })} />
        <Num label="Side gap (mm)" hint="Gap between adjacent rows of boards (along the width)." value={project.gaps.sideGap} onChange={(v) => patchGaps({ sideGap: v })} />
        <Num label="End gap (mm)" hint="Expansion gap at a butt joint where two boards meet over a backing board." value={project.gaps.endGap} onChange={(v) => patchGaps({ endGap: v })} />
        <Num label="Kerf (mm)" hint="Material removed by the saw blade on every cut — real waste." value={project.cut.kerf} onChange={(v) => patchCut({ kerf: v })} />
        <Num label="Min reusable (mm)" hint="Offcuts shorter than this are treated as scrap rather than reusable stock." value={project.cut.minReusableOffcut} onChange={(v) => patchCut({ minReusableOffcut: v })} />
        <Field label="Square lead end" hint="If on, a kerf is also spent squaring the rough leading end of every fresh plank.">
          <input type="checkbox" checked={project.cut.squareLeadingEnd} onChange={(e) => patchCut({ squareLeadingEnd: e.target.checked })} />
        </Field>
        <Field label="Edge fit">
          <select value={project.widthFit} onChange={(e) => patch({ widthFit: e.target.value as WidthFit })}>
            {WIDTH_FITS.map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}
          </select>
        </Field>
        <div className="mode-help">{widthFit.desc}</div>

        <h2>Pattern</h2>
        <Field label="Stagger mode">
          <select value={project.stagger.mode} onChange={(e) => patchStag({ mode: e.target.value as StaggerMode })}>
            {MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </Field>
        <div className="mode-help">{mode.desc}</div>
        <Num label="Min seam offset (mm)" hint="Minimum horizontal distance a seam must keep from any seam in an adjacent row." value={project.stagger.minSeamOffset} onChange={(v) => patchStag({ minSeamOffset: v })} />
        <Num label="Min piece (mm)" hint="No board piece may be shorter than this (anti-stub rule), for looks and strength." value={project.stagger.minPieceLength} onChange={(v) => patchStag({ minPieceLength: v })} />
        <Num label="Lookahead rows" hint="How many neighbouring rows the alignment check considers (e.g. 2 = compare against the two rows above)." value={project.stagger.lookahead} onChange={(v) => patchStag({ lookahead: v })} />
        <Field label="Waste ↔ Looks" hint="Trade off material waste against the look of the pattern.">
          <input type="range" min={0} max={1} step={0.05} value={project.stagger.wasteVsLooks} onChange={(e) => patchStag({ wasteVsLooks: +e.target.value })} />
        </Field>
        <div className="tagline" style={{ textAlign: 'right' }}>
          {project.stagger.wasteVsLooks < 0.4 ? 'favour low waste' : project.stagger.wasteVsLooks > 0.6 ? 'favour looks' : 'balanced'}
        </div>
      </aside>

      <Results result={result} endGap={project.gaps.endGap} />
    </div>
  );
}

/** Field row with a label, an optional tap-to-show info tooltip (works on touch), and a control. */
function Field({ label, hint, children }: { label: string; hint?: string; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="fieldwrap">
      <div className="field">
        <label>
          <span>{label}</span>
          {hint && (
            <button type="button" className="info" aria-label="More info" aria-expanded={open} onClick={() => setOpen((o) => !o)}>i</button>
          )}
        </label>
        {children}
      </div>
      {hint && open && <div className="hint">{hint}</div>}
    </div>
  );
}

/**
 * Number input that commits only on blur, Enter, or a stepper click — never on
 * each keystroke — so a half-typed value can't trigger a recompute.
 */
function NumberBox({ value, onCommit, title, className }: { value: number; onCommit: (v: number) => void; title?: string; className?: string }) {
  const [text, setText] = useState(String(value));
  const focused = useRef(false);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => { if (!focused.current) setText(String(value)); }, [value]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const handler = () => {
      const n = parseFloat(el.value);
      if (!Number.isNaN(n)) { if (n !== value) onCommit(n); } else setText(String(value));
    };
    el.addEventListener('change', handler);
    return () => el.removeEventListener('change', handler);
  }, [value, onCommit]);

  return (
    <input
      ref={ref}
      type="number"
      className={className}
      value={text}
      title={title}
      onChange={(e) => setText(e.target.value)}
      onFocus={() => (focused.current = true)}
      onBlur={() => (focused.current = false)}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
    />
  );
}

function Num({ label, hint, value, onChange }: { label: string; hint?: string; value: number; onChange: (v: number) => void }) {
  return <Field label={label} hint={hint}><NumberBox value={value} onCommit={onChange} title={hint} /></Field>;
}

function Text({ label, hint, value, onChange }: { label: string; hint?: string; value: string; onChange: (v: string) => void }) {
  const [text, setText] = useState(value);
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setText(value); }, [value]);
  return (
    <Field label={label} hint={hint}>
      <input
        type="text"
        value={text}
        title={hint}
        onChange={(e) => setText(e.target.value)}
        onFocus={() => (focused.current = true)}
        onBlur={() => { focused.current = false; if (text !== value) onChange(text); }}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      />
    </Field>
  );
}
