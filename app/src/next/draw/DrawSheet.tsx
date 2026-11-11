// Every drawing tool in one panel: Recent first, then the tool groups as tabs of big, named tiles, and below the
// switches the rail has (magnet, keep drawing, lock, hide, the list of drawings, remove). On phones it is a bottom
// sheet (the pencil in the chart's header); on a computer the rail's "All drawing tools" button opens it beside the
// rail as a panel with a search over every tool and a star on each tile for the favorites bar. Picking a tool
// closes it, so the whole chart is free to draw on.
import { useEffect, useRef, useState } from 'react';
import type { Session } from '../../core/session';
import { pref, setPref, useShape } from '../live';
import { ICONS, TOOL, TOOLS, type Group } from './tools';
import { cursorTool, ds, setDs, type Magnet } from './state';
import { layers } from './overlay';
import { Ic, ToolIcon, UI } from './ui';

type Tab = 'recent' | Group;
const TABS: Array<[Tab, string]> = [['recent', 'Recent'], ['lines', 'Lines'], ['fib', 'Fib & Gann'], ['patterns', 'Patterns'], ['forecast', 'Forecast'], ['shapes', 'Shapes'], ['notes', 'Text'], ['cursor', 'Cursor']];
const MAG: Record<Magnet, string> = { off: 'Magnet', weak: 'Magnet: weak', strong: 'Magnet: strong' };
/** the tools that are not drawings: measure and zoom (zoom out acts at once) */
const EXTRA: Array<{ id: string; name: string; icon: string }> = [{ id: 'measure', name: 'Measure', icon: ICONS.measure }, { id: 'zoom', name: 'Zoom in', icon: ICONS.zoom }, { id: 'zoomout', name: 'Zoom out', icon: UI.zoomout }];

/** the tools used last, newest first (the favorites until there are some) */
export function recentTools(): string[] {
  const r = pref<string[]>('drawRecent', []).filter(id => TOOL[id]);
  return (r.length ? r : ds.favs.filter(id => TOOL[id])).slice(0, 8);
}
export function noteRecent(id: string) {
  if (!TOOL[id] || TOOL[id].group === 'cursor') return;
  setPref('drawRecent', [id, ...pref<string[]>('drawRecent', []).filter(x => x !== id)].slice(0, 8));
}
/** star or unstar a tool for the favorites bar */
export function toggleFav(id: string) { setDs({ favs: ds.favs.includes(id) ? ds.favs.filter(x => x !== id) : [...ds.favs, id] }); }
/** arm a tool (or zoom out at once), as the rail and the panels do */
export function armTool(session: Session, id: string) {
  if (id === 'zoomout') { const l = [...layers].find(x => x.sym === session.active) || [...layers][0]; l?.zoomOut(); return; }
  const g = TOOL[id]?.group;
  for (const l of layers) l.cancel();
  noteRecent(id);
  setDs({ tool: id, selected: null, ...(g && g !== 'cursor' ? { last: { ...ds.last, [g]: id } } : {}) });
}
/** a star button: on (a favorite) or off */
export function Star({ id, name }: { id: string; name: string }) {
  const on = ds.favs.includes(id);
  return <button className={'dstar' + (on ? ' on' : '')} aria-pressed={on} title={on ? `Take ${name} off the favorites bar` : `Put ${name} on the favorites bar`} aria-label={on ? `Unstar ${name}` : `Star ${name}`}
    onClick={e => { e.stopPropagation(); toggleFav(id); }}><svg width="14" height="14" viewBox="0 0 24 24" fill={on ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"><path d={UI.star} /></svg></button>;
}

export function DrawSheet({ session, onClose, panel = false }: { session: Session; onClose: () => void; panel?: boolean }) {
  useShape();
  const [tab, setTabS] = useState<Tab>(() => pref<Tab>('drawTab', 'recent'));
  const [sure, setSure] = useState(false);
  const [q, setQ] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const setTab = (t: Tab) => { setTabS(t); setPref('drawTab', t); };
  const s = session, st = s.drawings, here = st.forSym(s.active).length, all = st.items.length;
  const allLocked = all > 0 && st.items.every(d => d.locked);
  const pick = (id: string) => { armTool(s, id); onClose(); };
  // the panel: the search first, Esc closes, the arrow keys move between tiles
  useEffect(() => {
    if (!panel) return;
    root.current?.querySelector<HTMLInputElement>('.dsearch')?.focus();
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); onClose(); } };
    addEventListener('keydown', k, true);
    return () => removeEventListener('keydown', k, true);
  }, [panel, onClose]);
  const onKey = (e: React.KeyboardEvent) => {
    if (panel) e.stopPropagation(); // the replay's keys (arrows, space, B, S) don't act while choosing a tool
    const tiles = [...(root.current?.querySelectorAll<HTMLButtonElement>('.dbody .dtile') || [])];
    if (!tiles.length) return;
    const at = tiles.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Enter' && (e.target as HTMLElement).classList.contains('dsearch')) { e.preventDefault(); tiles[0].click(); return; }
    const cols = Math.max(1, Math.round((root.current?.querySelector('.dgrid')?.clientWidth || 400) / (tiles[0].offsetWidth || 100)));
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowDown' ? cols : e.key === 'ArrowUp' ? -cols : 0;
    if (!step) return;
    if (at < 0) { if (e.key === 'ArrowDown') { e.preventDefault(); tiles[0].focus(); } return; }
    e.preventDefault();
    const n = at + step;
    if (n < 0 && (e.key === 'ArrowUp')) { root.current?.querySelector<HTMLInputElement>('.dsearch')?.focus(); return; }
    tiles[Math.max(0, Math.min(tiles.length - 1, n))].focus();
  };
  const tile = (id: string, name = TOOL[id]?.name, icon = <ToolIcon id={id} size={26} />) => (
    <div key={id} className="dtw">
      <button className={'dtile' + (ds.tool === id ? ' on' : '')} aria-pressed={ds.tool === id} title={TOOL[id]?.key ? `${name} (${TOOL[id].key})` : name} onClick={() => pick(id)}>{icon}<span>{name}</span></button>
      {panel && id !== 'zoomout' && <Star id={id} name={name} />}
    </div>
  );
  const extra = (x: typeof EXTRA[number]) => tile(x.id, x.name, <Ic d={x.icon} size={26} />);
  // the search: every tool whose name has every word typed
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const match = (name: string) => words.every(w => name.toLowerCase().includes(w));
  const found = words.length ? [...TOOLS.filter(t => match(t.name)), ...EXTRA.filter(x => match(x.name))] : null;
  const list = tab === 'recent' ? null : TOOLS.filter(t => t.group === tab);
  const secs = list ? [...new Set(list.map(t => t.sec))] : [];
  const sw = (on: boolean, label: string, icon: string, onClick: () => void, disabled = false, sub?: string) => (
    <button className={'dsw' + (on ? ' on' : '')} aria-pressed={on} aria-label={label} title={sub} disabled={disabled} onClick={onClick}><Ic d={icon} size={20} /><span>{label}{sub && <i>{sub}</i>}</span></button>
  );
  const nextMag: Magnet = ds.magnet === 'off' ? 'weak' : ds.magnet === 'weak' ? 'strong' : 'off';
  return (
    <div className={'pop dsheet' + (panel ? ' dpanel' : '')} role="dialog" aria-label="Drawing tools" ref={root} onKeyDown={onKey} onMouseDown={e => e.stopPropagation()}>
      <header>
        <b>Drawing tools</b>
        {panel && <input className="in dsearch" type="search" placeholder="Search every tool" aria-label="Search the drawing tools" value={q} onChange={e => setQ(e.target.value)} />}
        <span className="spacer" />
        <button className="ib" aria-label="Undo" title="Undo" disabled={!st.canUndo} onClick={() => { st.undo(); setDs({ selected: null }); }}><Ic d={UI.undo} size={20} /></button>
        <button className="ib" aria-label="Redo" title="Redo" disabled={!st.canRedo} onClick={() => { st.redo(); setDs({ selected: null }); }}><Ic d={UI.redo} size={20} /></button>
        <button className="ib" aria-label="Close" data-dismiss onClick={onClose}><Ic d="M6 6l12 12M18 6L6 18" size={20} sw={1.8} /></button>
      </header>
      {!found && <nav className="dtabs" role="tablist">{TABS.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}</nav>}
      <div className="dbody">
        {found && (found.length ? <div className="dgrid">{found.map(t => 'group' in t ? tile(t.id) : extra(t))}</div> : <p className="dnone">No tool is called “{q}”.</p>)}
        {!found && tab === 'recent' && <div className="dgrid">{recentTools().map(id => tile(id))}</div>}
        {!found && list && secs.map(sec => <section key={sec || 'x'}>
          {sec && <h5>{sec}</h5>}
          <div className="dgrid">
            {list.filter(t => t.sec === sec).map(t => tile(t.id))}
            {tab === 'cursor' && !sec && EXTRA.map(extra)}
          </div>
        </section>)}
      </div>
      <div className="dsws">
        {sw(ds.magnet !== 'off', MAG[ds.magnet], UI.magnet, () => setDs({ magnet: nextMag }))}
        {sw(ds.stay, 'Keep tool', UI.pencil, () => setDs({ stay: !ds.stay }))}
        {sw(allLocked, allLocked ? 'Unlock' : 'Lock all', allLocked ? UI.lock : UI.unlock, () => st.setAll(null, { locked: !allLocked }), !all)}
        {sw(ds.hideAll, ds.hideAll ? 'Show all' : 'Hide all', ds.hideAll ? UI.eyeoff : UI.eye, () => setDs({ hideAll: !ds.hideAll }), !all)}
        {sw(ds.tree, `List (${all})`, UI.tree, () => { setDs({ tree: true }); onClose(); }, !all)}
        {!sure ? sw(false, 'Remove', UI.trash, () => setSure(true), !here)
          : <span className="dsure">Remove {here} drawing{here === 1 ? '' : 's'}? <button className="btn sm" onClick={() => setSure(false)}>Keep</button><button className="btn sm danger" onClick={() => { st.clear(s.active); setDs({ selected: null }); setSure(false); }}>Remove</button></span>}
      </div>
      {ds.tool !== cursorTool() && TOOL[ds.tool]?.group !== 'cursor' && <span className="sr-only" aria-live="polite">{TOOL[ds.tool]?.name || ds.tool}</span>}
    </div>
  );
}
