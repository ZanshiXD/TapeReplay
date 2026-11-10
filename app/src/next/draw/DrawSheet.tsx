// Phones: the drawing tools as one bottom sheet instead of the rail down the side. Recent tools first, then the tool
// groups as tabs with big, named tiles; picking one closes the sheet so the whole chart is free to draw on. Below,
// the switches the rail has (magnet, keep drawing, lock, hide, the list of drawings, undo, redo, remove).
import { useState } from 'react';
import type { Session } from '../../core/session';
import { pref, setPref, useLive } from '../live';
import { ICONS, TOOL, TOOLS, type Group } from './tools';
import { cursorTool, ds, setDs, type Magnet } from './state';
import { layers } from './overlay';
import { Ic, ToolIcon, UI } from './ui';

type Tab = 'recent' | Group;
const TABS: Array<[Tab, string]> = [['recent', 'Recent'], ['lines', 'Lines'], ['fib', 'Fib & Gann'], ['patterns', 'Patterns'], ['forecast', 'Forecast'], ['shapes', 'Shapes'], ['notes', 'Text'], ['cursor', 'Cursor']];
const MAG: Record<Magnet, string> = { off: 'Magnet', weak: 'Magnet: weak', strong: 'Magnet: strong' };

/** the tools used last, newest first (the favourites until there are some) */
export function recentTools(): string[] {
  const r = pref<string[]>('drawRecent', []).filter(id => TOOL[id]);
  return (r.length ? r : ds.favs.filter(id => TOOL[id])).slice(0, 8);
}
function noteRecent(id: string) {
  if (!TOOL[id] || TOOL[id].group === 'cursor') return;
  setPref('drawRecent', [id, ...pref<string[]>('drawRecent', []).filter(x => x !== id)].slice(0, 8));
}

export function DrawSheet({ session, onClose }: { session: Session; onClose: () => void }) {
  useLive();
  const [tab, setTabS] = useState<Tab>(() => pref<Tab>('drawTab', 'recent'));
  const [sure, setSure] = useState(false);
  const setTab = (t: Tab) => { setTabS(t); setPref('drawTab', t); };
  const s = session, st = s.drawings, here = st.forSym(s.active).length, all = st.items.length;
  const allLocked = all > 0 && st.items.every(d => d.locked);
  const pick = (id: string) => {
    const g = TOOL[id]?.group;
    for (const l of layers) l.cancel();
    noteRecent(id);
    setDs({ tool: id, selected: null, ...(g && g !== 'cursor' ? { last: { ...ds.last, [g]: id } } : {}) });
    onClose();
  };
  const tile = (id: string, name = TOOL[id]?.name, icon = <ToolIcon id={id} size={26} />, onClick = () => pick(id)) => (
    <button key={id} className={'dtile' + (ds.tool === id ? ' on' : '')} aria-pressed={ds.tool === id} onClick={onClick}>{icon}<span>{name}</span></button>
  );
  const list = tab === 'recent' ? null : TOOLS.filter(t => t.group === tab);
  const secs = list ? [...new Set(list.map(t => t.sec))] : [];
  const sw = (on: boolean, label: string, icon: string, onClick: () => void, disabled = false, sub?: string) => (
    <button className={'dsw' + (on ? ' on' : '')} aria-pressed={on} aria-label={label} title={sub} disabled={disabled} onClick={onClick}><Ic d={icon} size={20} /><span>{label}{sub && <i>{sub}</i>}</span></button>
  );
  const nextMag: Magnet = ds.magnet === 'off' ? 'weak' : ds.magnet === 'weak' ? 'strong' : 'off';
  return (
    <div className="pop dsheet" role="dialog" aria-label="Drawing tools">
      <header>
        <b>Drawing tools</b>
        <span className="spacer" />
        <button className="ib" aria-label="Undo" disabled={!st.canUndo} onClick={() => { st.undo(); setDs({ selected: null }); }}><Ic d={UI.undo} size={20} /></button>
        <button className="ib" aria-label="Redo" disabled={!st.canRedo} onClick={() => { st.redo(); setDs({ selected: null }); }}><Ic d={UI.redo} size={20} /></button>
        <button className="ib" aria-label="Close" data-dismiss onClick={onClose}><Ic d="M6 6l12 12M18 6L6 18" size={20} sw={1.8} /></button>
      </header>
      <nav className="dtabs" role="tablist">{TABS.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}</nav>
      <div className="dbody">
        {tab === 'recent' && <div className="dgrid">{recentTools().map(id => tile(id))}</div>}
        {list && secs.map(sec => <section key={sec || 'x'}>
          {sec && <h5>{sec}</h5>}
          <div className="dgrid">
            {list.filter(t => t.sec === sec).map(t => tile(t.id))}
            {tab === 'cursor' && !sec && <>
              {tile('measure', 'Measure', <Ic d={ICONS.measure} size={26} />)}
              {tile('zoom', 'Zoom in', <Ic d={ICONS.zoom} size={26} />)}
              {tile('zoomout', 'Zoom out', <Ic d={UI.zoomout} size={26} />, () => { const l = [...layers].find(x => x.sym === s.active) || [...layers][0]; l?.zoomOut(); onClose(); })}
            </>}
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
