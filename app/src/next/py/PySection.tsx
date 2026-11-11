// Your own indicators, in the Indicators popover: the ones on the charts (hide, edit, remove), your saved scripts
// (add to the charts, edit, delete), and a new one from a template, JavaScript first, then Python. The editor opens
// over the page.
import { useState } from 'react';
import { createPortal } from 'react-dom';
import type { Session } from '../../core/session';
import { useLive } from '../live';
import { IClose } from '../icons';
import { pyErrs } from './console';
import { freeName, pyInds, pyScripts, scriptLang, setPyInds, setPyScripts, JS_TEMPLATES, LANG_NAME, PY_TEMPLATES, PY_TEMPLATE_INFO, type Lang } from './prefs';
import { PyEditor, type PyOpen } from './PyEditor';

export function PySection({ session }: { session: Session }) {
  useLive();
  const [open, setOpen] = useState<PyOpen | null>(null);
  const [tpl, setTpl] = useState(false);
  const [ask, setAsk] = useState<string | null>(null);
  const list = pyInds(), scripts = pyScripts(), names = Object.keys(scripts).sort((a, b) => a.localeCompare(b));
  const edit = (o: PyOpen) => { session.pause(); setOpen(o); setTpl(false); };
  const add = (name: string) => setPyInds([...list, { id: Date.now().toString(36), name, code: scripts[name], on: true, lang: scriptLang(name) }]);
  const del = (name: string) => { const s = { ...scripts }; delete s[name]; setPyScripts(s); setAsk(null); };
  const tag = (l: Lang) => <span className="pylang" title={LANG_NAME[l]}>{l === 'js' ? 'JS' : 'Py'}</span>;
  const templates = (lang: Lang, T: Record<string, string>) => (
    <div role="list" aria-label={`${LANG_NAME[lang]} templates`}>
      <div className="muted pytplh">{LANG_NAME[lang]}{lang === 'js' ? ': fast, nothing to load' : ': with numpy (and pandas); loads in a few seconds the first time'}</div>
      {Object.keys(T).map(t => (
        <button key={t} role="listitem" className="pytpl" onClick={() => edit({ name: freeName(t === 'Blank' ? 'My indicator' : t), code: T[t], lang })}>
          <b>{t}</b><span className="muted" style={{ fontSize: 12 }}>{PY_TEMPLATE_INFO[t]}</span>
        </button>
      ))}
    </div>
  );
  return <>
    <div style={{ height: 1, background: 'var(--line2)', margin: '8px 0' }} />
    <div className="cap" style={{ padding: '4px 16px 6px' }}>Your own</div>
    {list.map(x => (
      <div key={x.id} className="pyrow" data-pyind={x.name} style={{ opacity: x.on ? 1 : 0.5 }}>
        <span className="dot" />
        <span className="nm" title={x.name}>{x.name}</span>
        {tag(x.lang || 'py')}
        {pyErrs.has(x.name) && x.on && <span className="err" title="Stopped with an error: open it to see the console">error</span>}
        <button className="ib txt" onClick={() => setPyInds(list.map(y => y.id === x.id ? { ...y, on: !y.on } : y))}>{x.on ? 'Hide' : 'Show'}</button>
        <button className="ib txt" onClick={() => edit({ name: x.name, code: x.code, id: x.id, lang: x.lang || 'py' })}>Edit</button>
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
        {tag(scriptLang(n))}
        {list.some(x => x.name === n) ? <span className="muted" style={{ fontSize: 12, padding: '0 10px' }}>On the chart</span> : <button className="ib txt" onClick={() => add(n)}>Add to chart</button>}
        <button className="ib txt" onClick={() => edit({ name: n, code: scripts[n], lang: scriptLang(n) })}>Edit</button>
        <button className="ib txt" aria-label={`Delete ${n}`} onClick={() => setAsk(n)}>Delete</button>
      </div>
    ))}
    <button className="pytpl" style={{ paddingLeft: 16 }} aria-expanded={tpl} onClick={() => setTpl(!tpl)}>
      <b>+ New indicator</b><span className="muted" style={{ fontSize: 12 }}>Write your own in JavaScript or Python: lines, levels, fills, markers, boxes and labels, or a pane under the chart for something like RSI.</span>
    </button>
    {tpl && <div aria-label="Templates">
      {templates('js', JS_TEMPLATES)}
      {templates('py', PY_TEMPLATES)}
    </div>}
    {open && createPortal(<PyEditor key={open.id || open.name} open={open} onClose={() => setOpen(null)} />, document.body)}
  </>;
}
