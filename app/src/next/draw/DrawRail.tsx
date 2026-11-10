// The drawing toolbar down the left of the charts, laid out like TradingView's: cursors, then the six groups of tools
// (each shows the last one used; the arrow opens the whole group), measure and zoom, then magnet, stay in drawing
// mode, lock all, hide all, remove, and the object tree.
import { useEffect, useRef, useState } from 'react';
import type { Session } from '../../core/session';
import { useLive } from '../live';
import { GROUPS, ICONS, TOOL, TOOLS, isDrawTool, type Group } from './tools';
import { cursorTool, ds, setDs, type Magnet } from './state';
import { layers } from './overlay';
import { Ic, ToolIcon, UI } from './ui';

const tip = (name: string, key?: string) => key ? `${name} (${key})` : name;

export function DrawRail({ session }: { session: Session }) {
  useLive();
  const [open, setOpen] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const f = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(null); };
    addEventListener('mousedown', f); return () => removeEventListener('mousedown', f);
  }, [open]);
  const s = session, st = s.drawings, here = st.forSym(s.active).length, all = st.items.length;
  const allLocked = all > 0 && st.items.every(d => d.locked);
  const pick = (id: string) => {
    const g = TOOL[id]?.group;
    for (const l of layers) l.cancel();
    setDs({ tool: ds.tool === id && id !== 'cross' && !['dot', 'arrow'].includes(id) ? cursorTool() : id, selected: null, ...(g && g !== 'cursor' ? { last: { ...ds.last, [g]: id } } : {}) });
    setOpen(null);
  };
  const activeLayer = () => [...layers].find(l => l.sym === s.active) || [...layers][0];
  const group = (g: Group) => {
    const items = TOOLS.filter(t => t.group === g);
    const shown = g === 'cursor' ? (TOOL[ds.tool]?.group === 'cursor' ? ds.tool : cursorTool()) : (TOOL[ds.tool]?.group === g ? ds.tool : ds.last[g] || items[0].id);
    const on = TOOL[ds.tool]?.group === g, name = GROUPS.find(x => x.id === g)!.name;
    const secs = [...new Set(items.map(t => t.sec))];
    return (
      <div className="rgroup" key={g}>
        <button className={'rb' + (on ? ' on' : '')} title={tip(TOOL[shown].name, TOOL[shown].key)} aria-label={TOOL[shown].name} aria-pressed={on} onClick={() => pick(shown)}><ToolIcon id={shown} /></button>
        <button className={'rarrow' + (open === g ? ' open' : '')} title={name} aria-label={`More: ${name}`} aria-expanded={open === g} onClick={() => setOpen(open === g ? null : g)}><Ic d={UI.chev} size={10} sw={2.4} /></button>
        {open === g && (
          <div className="flyout" role="menu" aria-label={name}>
            {secs.map(sec => <div key={sec || 'x'}>
              {sec && <h5>{sec}</h5>}
              {items.filter(t => t.sec === sec).map(t => (
                <button key={t.id} role="menuitemradio" aria-checked={ds.tool === t.id} className={ds.tool === t.id ? 'on' : ''} onClick={() => pick(t.id)}>
                  <ToolIcon id={t.id} size={20} /><span className="nm">{t.name}</span>{t.key && <span className="k">{t.key}</span>}
                </button>
              ))}
            </div>)}
          </div>
        )}
      </div>
    );
  };
  const magnet = (m: Magnet) => { setDs({ magnet: m }); setOpen(null); };
  return (
    <div className="drawrail" ref={ref} aria-label="Drawing tools" role="toolbar" onMouseDown={e => e.stopPropagation()}>
      {group('cursor')}
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
        <button className={'rb' + (ds.magnet !== 'off' ? ' on' : '')} title={`Magnet: ${ds.magnet === 'off' ? 'off' : ds.magnet === 'weak' ? 'weak (snaps when close)' : 'strong (always snaps)'} — points snap to the bar's open, high, low or close. Hold Ctrl to flip it.`} aria-label="Magnet" aria-pressed={ds.magnet !== 'off'} onClick={() => magnet(ds.magnet === 'off' ? 'weak' : 'off')}><Ic d={UI.magnet} /></button>
        <button className={'rarrow' + (open === 'magnet' ? ' open' : '')} aria-label="Magnet mode" onClick={() => setOpen(open === 'magnet' ? null : 'magnet')}><Ic d={UI.chev} size={10} sw={2.4} /></button>
        {open === 'magnet' && <div className="flyout" role="menu">
          <h5>Magnet</h5>
          {([['off', 'Off'], ['weak', 'Weak magnet: snaps when close'], ['strong', 'Strong magnet: always snaps']] as Array<[Magnet, string]>).map(([m, l]) => <button key={m} className={ds.magnet === m ? 'on' : ''} onClick={() => magnet(m)}><Ic d={UI.magnet} size={20} /><span className="nm">{l}</span></button>)}
        </div>}
      </div>
      <button className={'rb' + (ds.stay ? ' on' : '')} title="Stay in drawing mode: keep the tool after drawing" aria-label="Stay in drawing mode" aria-pressed={ds.stay} onClick={() => setDs({ stay: !ds.stay })}><Ic d={UI.pencil} /></button>
      <button className={'rb' + (allLocked ? ' on' : '')} disabled={!all} title={allLocked ? 'Unlock all drawings' : 'Lock all drawings'} aria-label="Lock all drawings" aria-pressed={allLocked} onClick={() => st.setAll(null, { locked: !allLocked })}><Ic d={allLocked ? UI.lock : UI.unlock} /></button>
      <button className={'rb' + (ds.hideAll ? ' on' : '')} disabled={!all} title={ds.hideAll ? 'Show all drawings' : 'Hide all drawings'} aria-label="Hide all drawings" aria-pressed={ds.hideAll} onClick={() => setDs({ hideAll: !ds.hideAll })}><Ic d={ds.hideAll ? UI.eyeoff : UI.eye} /></button>
      <div className="rgroup">
        <button className="rb" disabled={!all} title="Remove drawings" aria-label="Remove drawings" onClick={() => setOpen(open === 'remove' ? null : 'remove')}><Ic d={UI.trash} /></button>
        {open === 'remove' && <div className="flyout" role="menu">
          <h5>Remove</h5>
          <button disabled={!here} onClick={() => { st.clear(s.active); setDs({ selected: null }); setOpen(null); }}><span className="nm">{here} drawing{here === 1 ? '' : 's'} on {s.active}</span></button>
          {s.feeds.length > 1 && <button disabled={!all} onClick={() => { st.clear(); setDs({ selected: null }); setOpen(null); }}><span className="nm">All {all} drawings, every market</span></button>}
          <span className="hint">Undo with Ctrl+Z</span>
        </div>}
      </div>
      <span className="rsep" />
      <button className={'rb' + (ds.tree ? ' on' : '')} title="Object tree: every drawing, to find, hide, lock or remove" aria-label="Object tree" aria-pressed={ds.tree} onClick={() => setDs({ tree: !ds.tree })}><Ic d={UI.tree} /></button>
      <span className="spacer" />
      <button className="rb" disabled={!st.canUndo} title="Undo (Ctrl+Z)" aria-label="Undo" onClick={() => { st.undo(); setDs({ selected: null }); }}><Ic d={UI.undo} /></button>
      <button className="rb" disabled={!st.canRedo} title="Redo (Ctrl+Y)" aria-label="Redo" onClick={() => { st.redo(); setDs({ selected: null }); }}><Ic d={UI.redo} /></button>
      {isDrawTool(ds.tool) && <span className="sr-only" aria-live="polite">{TOOL[ds.tool].name}: click on the chart</span>}
    </div>
  );
}
