// The drawing toolbar down the left of the charts, laid out like TradingView's: cursors, then the six groups of tools
// (each shows the last one used; the arrow beside it, a right-click or a long press opens the whole group), measure
// and zoom, then magnet, stay in drawing mode, lock all, hide all, remove, and the object tree. "All drawing tools"
// opens every tool in one panel with a search; the star shows the favorites bar, a small toolbar of the starred
// tools that floats on the chart and can be dragged anywhere on it.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Session } from '../../core/session';
import { bump, pref, setPref, useLive } from '../live';
import { GROUPS, ICONS, TOOL, TOOLS, isDrawTool, type Group } from './tools';
import { cursorTool, ds, setDs, type Magnet } from './state';
import { layers } from './overlay';
import { Ic, ToolIcon, UI } from './ui';
import { DrawSheet, Star, armTool } from './DrawSheet';

const tip = (name: string, key?: string) => key ? `${name} (${key})` : name;
const HOLD_MS = 450;
const ALL_ICON = 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z';

/** places a popup beside the rail, level with its button, inside the window (moved up near the bottom). It is fixed
 * to the window so the rail can scroll when the chart is short without cutting it off. */
function useFit(ref: React.RefObject<HTMLElement | null>, on: unknown) {
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    const rail = el.closest('.drawrail'), anchor = el.parentElement;
    if (!rail || !anchor) return;
    const rr = rail.getBoundingClientRect(), ar = anchor.getBoundingClientRect();
    el.style.left = `${rr.right + 4}px`;
    const h = el.offsetHeight;
    el.style.top = `${Math.max(8, Math.min(ar.top - 6, innerHeight - 8 - h))}px`;
  });
  return on;
}

function Flyout({ name, children, search }: { name: string; children: React.ReactNode; search?: { q: string; set: (q: string) => void } }) {
  const ref = useRef<HTMLDivElement>(null);
  useFit(ref, name);
  useEffect(() => { ref.current?.querySelector<HTMLInputElement>('input')?.focus(); }, []);
  return (
    <div className="flyout" role="menu" aria-label={name} ref={ref}>
      {search && <input className="in fsearch" type="search" placeholder={`Search ${name.toLowerCase()}`} aria-label={`Search ${name}`} value={search.q} onChange={e => search.set(e.target.value)} />}
      {children}
    </div>
  );
}

export function DrawRail({ session }: { session: Session }) {
  useLive();
  const [open, setOpen] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const hold = useRef<{ t: number; fired: boolean } | null>(null);
  const allRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const f = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(null); };
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && open !== 'all') { e.stopPropagation(); setOpen(null); } };
    const r = () => setOpen(null);
    addEventListener('mousedown', f); addEventListener('keydown', k, true); addEventListener('resize', r);
    return () => { removeEventListener('mousedown', f); removeEventListener('keydown', k, true); removeEventListener('resize', r); };
  }, [open]);
  useEffect(() => { setQ(''); }, [open]);
  useFit(allRef, open);
  const [, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  const s = session, st = s.drawings, here = st.forSym(s.active).length, all = st.items.length;
  const allLocked = all > 0 && st.items.every(d => d.locked);
  const pick = (id: string) => {
    if (ds.tool === id && id !== 'cross' && !['dot', 'arrow'].includes(id)) { for (const l of layers) l.cancel(); setDs({ tool: cursorTool(), selected: null }); }
    else armTool(s, id);
    setOpen(null);
  };
  const activeLayer = () => [...layers].find(l => l.sym === s.active) || [...layers][0];
  const toggle = (g: string) => setOpen(open === g ? null : g);
  // a long press on a group's button opens the group (a click still picks its tool)
  const press = (g: string) => ({
    onPointerDown: (e: React.PointerEvent) => { if (e.button !== 0) return; const h = { t: window.setTimeout(() => { h.fired = true; setOpen(g); }, HOLD_MS), fired: false }; hold.current = h; },
    onPointerUp: () => { if (hold.current) clearTimeout(hold.current.t); },
    onPointerLeave: () => { if (hold.current) clearTimeout(hold.current.t); },
    onContextMenu: (e: React.MouseEvent) => { e.preventDefault(); toggle(g); },
  });
  const fired = () => { const f = !!hold.current?.fired; if (hold.current) hold.current.fired = false; return f; };
  const group = (g: Group) => {
    const items = TOOLS.filter(t => t.group === g);
    const shown = g === 'cursor' ? (TOOL[ds.tool]?.group === 'cursor' ? ds.tool : cursorTool()) : (TOOL[ds.tool]?.group === g ? ds.tool : ds.last[g] || items[0].id);
    const on = TOOL[ds.tool]?.group === g, name = GROUPS.find(x => x.id === g)!.name;
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const vis = items.filter(t => words.every(w => t.name.toLowerCase().includes(w) || (t.sec || '').toLowerCase().includes(w)));
    const secs = [...new Set(vis.map(t => t.sec))];
    return (
      <div className="rgroup" key={g}>
        <button className={'rb' + (on ? ' on' : '')} title={`${tip(TOOL[shown].name, TOOL[shown].key)} · right-click or hold for all ${name.toLowerCase()}`} aria-label={TOOL[shown].name} aria-pressed={on}
          {...press(g)} onClick={() => { if (!fired()) pick(shown); }}><ToolIcon id={shown} /></button>
        <button className={'rarrow' + (open === g ? ' open' : '')} title={`All ${name.toLowerCase()}`} aria-label={`More: ${name}`} aria-expanded={open === g} onClick={() => toggle(g)}><Ic d={UI.chev} size={10} sw={2.4} /></button>
        {open === g && (
          <Flyout name={name} search={items.length > 8 ? { q, set: setQ } : undefined}>
            {secs.map(sec => <div key={sec || 'x'}>
              {sec && <h5>{sec}</h5>}
              {vis.filter(t => t.sec === sec).map(t => (
                <div key={t.id} className={'frow' + (ds.tool === t.id ? ' on' : '')}>
                  <button role="menuitemradio" aria-checked={ds.tool === t.id} className={ds.tool === t.id ? 'on' : ''} onClick={() => pick(t.id)}>
                    <ToolIcon id={t.id} size={20} /><span className="nm">{t.name}</span>{t.key && <span className="k">{t.key}</span>}
                  </button>
                  {g !== 'cursor' && <Star id={t.id} name={t.name} />}
                </div>
              ))}
            </div>)}
            {!vis.length && <span className="hint">No tool is called “{q}”.</span>}
          </Flyout>
        )}
      </div>
    );
  };
  const magnet = (m: Magnet) => { setDs({ magnet: m }); setOpen(null); };
  const favBar = pref('drawFavBar', false);
  return (
    <div className="drawrail" ref={ref} aria-label="Drawing tools" role="toolbar" onMouseDown={e => e.stopPropagation()} onScroll={() => { if (open) setOpen(null); }}>
      {group('cursor')}
      <div className="rgroup">
        <button className={'rb' + (open === 'all' ? ' on' : '')} title="All drawing tools: every tool in one panel, with a search" aria-label="All drawing tools" aria-expanded={open === 'all'} onClick={() => toggle('all')}><Ic d={ALL_ICON} size={18} sw={1.5} /></button>
        <button className={'rarrow fav' + (favBar ? ' open' : '')} title={favBar ? 'Hide the favorites bar' : 'Show the favorites bar: your starred tools on the chart'} aria-label="Favorites bar" aria-pressed={favBar} onClick={() => { setPref('drawFavBar', !favBar); bump(); }}>
          <svg width="10" height="10" viewBox="0 0 24 24" fill={favBar ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2.4" strokeLinejoin="round"><path d={UI.star} /></svg></button>
        {open === 'all' && <div className="allpanel" ref={allRef}><DrawSheet session={s} panel onClose={() => setOpen(null)} /></div>}
      </div>
      <span className="rsep" />
      {(['lines', 'fib', 'patterns', 'forecast', 'shapes', 'notes'] as Group[]).map(group)}
      <span className="rsep" />
      <button className={'rb' + (ds.tool === 'measure' ? ' on' : '')} title="Measure (or Shift+click the chart)" aria-label="Measure" onClick={() => pick('measure')}><Ic d={ICONS.measure} /></button>
      <div className="rgroup">
        <button className={'rb' + (ds.tool === 'zoom' ? ' on' : '')} title="Zoom in: drag over the bars to see" aria-label="Zoom in" onClick={() => pick('zoom')}><Ic d={ICONS.zoom} /></button>
        <button className="rarrow" title="Zoom out" aria-label="Zoom out" onClick={() => activeLayer()?.zoomOut()}><Ic d={UI.chev} size={10} sw={2.4} /></button>
      </div>
      <span className="rsep" />
      <div className="rgroup">
        <button className={'rb' + (ds.magnet !== 'off' ? ' on' : '')} title={`Magnet: ${ds.magnet === 'off' ? 'off' : ds.magnet === 'weak' ? 'weak (snaps when close)' : 'strong (always snaps)'} — points snap to the bar's open, high, low or close. Hold Ctrl to flip it.`} aria-label="Magnet" aria-pressed={ds.magnet !== 'off'}
          onContextMenu={e => { e.preventDefault(); toggle('magnet'); }} onClick={() => magnet(ds.magnet === 'off' ? 'weak' : 'off')}><Ic d={UI.magnet} /></button>
        <button className={'rarrow' + (open === 'magnet' ? ' open' : '')} aria-label="Magnet mode" title="Magnet mode" onClick={() => toggle('magnet')}><Ic d={UI.chev} size={10} sw={2.4} /></button>
        {open === 'magnet' && <Flyout name="Magnet">
          <h5>Magnet</h5>
          {([['off', 'Off'], ['weak', 'Weak magnet: snaps when close'], ['strong', 'Strong magnet: always snaps']] as Array<[Magnet, string]>).map(([m, l]) => <div key={m} className="frow"><button className={ds.magnet === m ? 'on' : ''} onClick={() => magnet(m)}><Ic d={UI.magnet} size={20} /><span className="nm">{l}</span></button></div>)}
        </Flyout>}
      </div>
      <button className={'rb' + (ds.stay ? ' on' : '')} title="Stay in drawing mode: keep the tool after drawing" aria-label="Stay in drawing mode" aria-pressed={ds.stay} onClick={() => setDs({ stay: !ds.stay })}><Ic d={UI.pencil} /></button>
      <button className={'rb' + (allLocked ? ' on' : '')} disabled={!all} title={allLocked ? 'Unlock all drawings' : 'Lock all drawings'} aria-label="Lock all drawings" aria-pressed={allLocked} onClick={() => st.setAll(null, { locked: !allLocked })}><Ic d={allLocked ? UI.lock : UI.unlock} /></button>
      <button className={'rb' + (ds.hideAll ? ' on' : '')} disabled={!all} title={ds.hideAll ? 'Show all drawings' : 'Hide all drawings'} aria-label="Hide all drawings" aria-pressed={ds.hideAll} onClick={() => setDs({ hideAll: !ds.hideAll })}><Ic d={ds.hideAll ? UI.eyeoff : UI.eye} /></button>
      <div className="rgroup">
        <button className="rb" disabled={!all} title="Remove drawings" aria-label="Remove drawings" onClick={() => toggle('remove')}><Ic d={UI.trash} /></button>
        {open === 'remove' && <Flyout name="Remove">
          <h5>Remove</h5>
          <div className="frow"><button disabled={!here} onClick={() => { st.clear(s.active); setDs({ selected: null }); setOpen(null); }}><span className="nm">{here} drawing{here === 1 ? '' : 's'} on {s.active}</span></button></div>
          {s.feeds.length > 1 && <div className="frow"><button disabled={!all} onClick={() => { st.clear(); setDs({ selected: null }); setOpen(null); }}><span className="nm">All {all} drawings, every market</span></button></div>}
          <span className="hint">Undo with Ctrl+Z</span>
        </Flyout>}
      </div>
      <span className="rsep" />
      <button className={'rb' + (ds.tree ? ' on' : '')} title="Object tree: every drawing, to find, hide, lock or remove" aria-label="Object tree" aria-pressed={ds.tree} onClick={() => setDs({ tree: !ds.tree })}><Ic d={UI.tree} /></button>
      <span className="spacer" />
      <button className="rb" disabled={!st.canUndo} title="Undo (Ctrl+Z)" aria-label="Undo" onClick={() => { st.undo(); setDs({ selected: null }); }}><Ic d={UI.undo} /></button>
      <button className="rb" disabled={!st.canRedo} title="Redo (Ctrl+Y)" aria-label="Redo" onClick={() => { st.redo(); setDs({ selected: null }); }}><Ic d={UI.redo} /></button>
      {isDrawTool(ds.tool) && <span className="sr-only" aria-live="polite">{TOOL[ds.tool].name}: click on the chart</span>}
      {favBar && ref.current?.parentElement && createPortal(<FavBar session={s} rail={ref} />, ref.current.parentElement)}
    </div>
  );
}

/** the favorites bar: the starred tools as a small toolbar on the chart, dragged by its grip, kept where it was left */
function FavBar({ session, rail }: { session: Session; rail: React.RefObject<HTMLDivElement | null> }) {
  const [pos, setPos] = useState<{ x: number; y: number }>(() => pref('drawFavPos', { x: 12, y: 54 }));
  const bar = useRef<HTMLDivElement>(null);
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  const favs = ds.favs.filter(id => TOOL[id]);
  // inside the chart area (the rail's row, right of the rail)
  const clamp = (p: { x: number; y: number }) => {
    const row = rail.current?.parentElement, b = bar.current, rw = rail.current?.offsetWidth || 52;
    if (!row || !b) return p;
    return { x: Math.max(4, Math.min(row.clientWidth - rw - b.offsetWidth - 4, p.x)), y: Math.max(4, Math.min(row.clientHeight - b.offsetHeight - 4, p.y)) };
  };
  useLayoutEffect(() => { const c = clamp(pos); if (c.x !== pos.x || c.y !== pos.y) setPos(c); });
  useEffect(() => { const f = () => setPos(p => clamp(p)); addEventListener('resize', f); return () => removeEventListener('resize', f); }, []);
  const down = (e: React.PointerEvent) => { (e.target as HTMLElement).setPointerCapture(e.pointerId); drag.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y }; };
  const move = (e: React.PointerEvent) => { if (drag.current) setPos(clamp({ x: e.clientX - drag.current.dx, y: e.clientY - drag.current.dy })); };
  const up = () => { if (drag.current) { drag.current = null; setPref('drawFavPos', pos); } };
  return (
    <div className="favbar" ref={bar} role="toolbar" aria-label="Favorite drawing tools" style={{ left: (rail.current?.offsetWidth || 52) + pos.x, top: pos.y }}>
      <span className="grip" title="Drag to move" onPointerDown={down} onPointerMove={move} onPointerUp={up}><Ic d={UI.grip} size={14} /></span>
      {favs.map(id => <button key={id} className={'rb' + (ds.tool === id ? ' on' : '')} title={tip(TOOL[id].name, TOOL[id].key)} aria-label={TOOL[id].name} aria-pressed={ds.tool === id}
        onClick={() => { if (ds.tool === id) { for (const l of layers) l.cancel(); setDs({ tool: cursorTool(), selected: null }); } else armTool(session, id); }}><ToolIcon id={id} size={20} /></button>)}
      {!favs.length && <span className="empty-fav">Star tools to put them here</span>}
    </div>
  );
}
