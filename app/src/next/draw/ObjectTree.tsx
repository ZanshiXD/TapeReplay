// Every drawing in the session, by market: click one to select it, and show, hide, lock or remove it.
import type { Session } from '../../core/session';
import { useLive } from '../live';
import { ds, setDs } from './state';
import { drawingName, removeDrawing, toggleHide, toggleLock } from './actions';
import { Ic, ToolIcon, UI } from './ui';

export function ObjectTree({ session }: { session: Session }) {
  useLive();
  const s = session, st = s.drawings, syms = s.feeds.map(f => f.s.inst.sym);
  return (
    <aside className="otree" aria-label="Object tree" onMouseDown={e => e.stopPropagation()}>
      <header><b>Object tree</b><span className="muted">{st.items.length}</span><span className="spacer" /><button className="ib" aria-label="Close the object tree" onClick={() => setDs({ tree: false })}>✕</button></header>
      <div className="list">
        {!st.items.length && <p className="empty">No drawings yet. Pick a tool on the left, then click on the chart.</p>}
        {syms.map(sym => {
          const items = st.forSym(sym).slice().reverse(); if (!items.length) return null;
          return <div key={sym}>
            <h5>{sym}</h5>
            {items.map(d => (
              <div key={d.id} className={'orow' + (ds.selected === d.id ? ' on' : '') + (d.hidden ? ' off' : '')} onClick={() => { s.setActive(sym); setDs({ selected: d.id }); }}>
                <ToolIcon id={d.tool} size={18} /><span className="nm">{drawingName(d)}</span>
                <button className="ib" aria-label={d.hidden ? 'Show' : 'Hide'} title={d.hidden ? 'Show' : 'Hide'} onClick={e => { e.stopPropagation(); toggleHide(s, d); }}><Ic d={d.hidden ? UI.eyeoff : UI.eye} size={16} sw={1.6} /></button>
                <button className={'ib' + (d.locked ? ' on' : '')} aria-label={d.locked ? 'Unlock' : 'Lock'} title={d.locked ? 'Unlock' : 'Lock'} onClick={e => { e.stopPropagation(); toggleLock(s, d); }}><Ic d={d.locked ? UI.lock : UI.unlock} size={16} sw={1.6} /></button>
                <button className="ib danger" aria-label={`Remove ${drawingName(d)}`} title="Remove" onClick={e => { e.stopPropagation(); removeDrawing(s, d.id); }}><Ic d={UI.trash} size={16} sw={1.6} /></button>
              </div>
            ))}
          </div>;
        })}
      </div>
    </aside>
  );
}
