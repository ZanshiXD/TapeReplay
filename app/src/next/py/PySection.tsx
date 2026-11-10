// The Python part of the Indicators popover: the Python indicators on the charts (hide, edit, remove), your saved
// scripts (add to the charts, edit, delete), and a new one from a template. The editor opens over the page.
import { useState } from 'react';
import { createPortal } from 'react-dom';
import type { Session } from '../../core/session';
import { useLive } from '../live';
import { IClose } from '../icons';
import { pyErrs } from './console';
import { freeName, pyInds, pyScripts, setPyInds, setPyScripts, PY_TEMPLATES, PY_TEMPLATE_INFO } from './prefs';
import { PyEditor, type PyOpen } from './PyEditor';

export function PySection({ session }: { session: Session }) {
  useLive();
  const [open, setOpen] = useState<PyOpen | null>(null);
  const [tpl, setTpl] = useState(false);
  const [ask, setAsk] = useState<string | null>(null);
  const list = pyInds(), scripts = pyScripts(), names = Object.keys(scripts).sort((a, b) => a.localeCompare(b));
  const edit = (o: PyOpen) => { session.pause(); setOpen(o); setTpl(false); };
  const add = (name: string) => setPyInds([...list, { id: Date.now().toString(36), name, code: scripts[name], on: true }]);
  const del = (name: string) => { const s = { ...scripts }; delete s[name]; setPyScripts(s); setAsk(null); };
  return <>
    <div style={{ height: 1, background: 'var(--line2)', margin: '8px 0' }} />
    <div className="cap" style={{ padding: '4px 16px 6px' }}>Python</div>
    {list.map(x => (
      <div key={x.id} className="pyrow" data-pyind={x.name} style={{ opacity: x.on ? 1 : 0.5 }}>
        <span className="dot" />
        <span className="nm" title={x.name}>{x.name}</span>
        {pyErrs.has(x.name) && x.on && <span className="err" title="Stopped with an error: open it to see the console">error</span>}
        <button className="ib txt" onClick={() => setPyInds(list.map(y => y.id === x.id ? { ...y, on: !y.on } : y))}>{x.on ? 'Hide' : 'Show'}</button>
        <button className="ib txt" onClick={() => edit({ name: x.name, code: x.code, id: x.id })}>Edit</button>
        <button className="ib" title="Take it off the charts (your script stays)" aria-label={`Remove ${x.name}`} onClick={() => setPyInds(list.filter(y => y.id !== x.id))}><IClose width={13} height={13} /></button>
      </div>
    ))}
    {names.length > 0 && <div className="muted" style={{ padding: '8px 16px 2px', fontSize: 12 }}>Your scripts</div>}
    {names.map(n => ask === n ? (
      <div key={n} className="pyrow ask" role="alertdialog" aria-label={`Delete ${n}?`}>
        <span className="nm">Delete “{n}”?</span>
        <button className="btn sm danger" onClick={() => del(n)}>Delete</button>
        <button className="btn sm" onClick={() => setAsk(null)}>Cancel</button>
      </div>
    ) : (
      <div key={n} className="pyrow" data-pyscript={n}>
        <span className="nm" title={n}>{n}</span>
        {list.some(x => x.name === n) ? <span className="muted" style={{ fontSize: 12, padding: '0 10px' }}>On the chart</span> : <button className="ib txt" onClick={() => add(n)}>Add to chart</button>}
        <button className="ib txt" onClick={() => edit({ name: n, code: scripts[n] })}>Edit</button>
        <button className="ib txt" aria-label={`Delete ${n}`} onClick={() => setAsk(n)}>Delete</button>
      </div>
    ))}
    <button className="pytpl" style={{ paddingLeft: 16 }} aria-expanded={tpl} onClick={() => setTpl(!tpl)}>
      <b>+ New Python indicator</b><span className="muted" style={{ fontSize: 12 }}>Write your own: lines, levels, fills, markers, boxes and labels, or a pane under the chart for something like RSI.</span>
    </button>
    {tpl && <div role="list" aria-label="Templates">
      {Object.keys(PY_TEMPLATES).map(t => (
        <button key={t} role="listitem" className="pytpl" onClick={() => edit({ name: freeName(t === 'Blank' ? 'My indicator' : t), code: PY_TEMPLATES[t] })}>
          <b>{t}</b><span className="muted" style={{ fontSize: 12 }}>{PY_TEMPLATE_INFO[t]}</span>
        </button>
      ))}
    </div>}
    {open && createPortal(<PyEditor key={open.id || open.name} open={open} onClose={() => setOpen(null)} />, document.body)}
  </>;
}
