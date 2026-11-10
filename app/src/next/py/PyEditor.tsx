// The Python indicator editor: the code, its settings (the NAME = value lines at the top, changed here without
// editing), and a console with what it printed and any error. Apply puts it on the charts (or updates it there);
// the code is kept in "Your scripts" as you type. Full screen on phones.
import { openGuide } from '../guide/Guide';
import { useEffect, useRef, useState } from 'react';
import { useLive } from '../live';
import { IClose } from '../icons';
import { pyCall, pyLibs, pyLoad, pyStatus } from './client';
import { pyBusy, pyClear, pyCons, pyErrs, pyLog } from './console';
import { pyInds, pyScripts, setPyInds, setPyScripts } from './prefs';
import './py.css';

interface Param { name: string; kind: 'int' | 'float' | 'bool' | 'choice'; value: number | boolean | string; comment?: string; choices?: string[] }
export interface PyOpen { name: string; code: string; id?: string }

export function PyEditor({ open, onClose }: { open: PyOpen; onClose: () => void }) {
  useLive();
  const [name, setName] = useState(open.name);
  const [code, setCode] = useState(open.code);
  const [params, setParams] = useState<Param[] | string>('');
  const [stat, setStat] = useState('');
  const [busy, setBusy] = useState(false);
  const chartId = useRef(open.id || pyInds().find(x => x.name === open.name)?.id || '');
  const ta = useRef<HTMLTextAreaElement>(null), cons = useRef<HTMLDivElement>(null);
  const nm = (name.trim() || 'Indicator').slice(0, 60);
  const onChart = pyInds().find(x => x.id === chartId.current) || pyInds().find(x => x.name === nm);

  // Escape closes; Python starts loading so the settings can show
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    addEventListener('keydown', k, true);
    pyLoad().catch(() => {});
    return () => removeEventListener('keydown', k, true);
  }, [onClose]);
  // the settings again shortly after the code changes; the code kept in Your scripts
  useEffect(() => {
    const t = setTimeout(async () => {
      try { await pyLoad(); } catch { return setParams('Settings show here once Python has loaded.'); }
      const r = JSON.parse(await pyCall<string>('_tr_params', [code]) || '{}') as { error?: string; params?: Param[] };
      setParams(p => r.error ? (Array.isArray(p) ? p : 'Settings show here when the code has no syntax errors.') : r.params?.length ? r.params : 'Settings at the top of the code, like LENGTH = 14, show here to change without editing.');
    }, pyStatus.state === 'ready' ? 300 : 0);
    return () => clearTimeout(t);
  }, [code]);
  const lines = pyCons.lines.filter(l => l.tag === nm);
  useEffect(() => { const c = cons.current; if (c) c.scrollTop = c.scrollHeight; }, [lines.length, pyCons.ver]);

  const save = (c = code, n = nm) => { setPyScripts({ ...pyScripts(), [n]: c }); };
  const saveT = useRef(0);
  const edit = (c: string) => { setCode(c); setStat(''); clearTimeout(saveT.current); saveT.current = window.setTimeout(() => save(c), 800); };
  /** the copy on the chart gets this code (it starts again) */
  const toChart = (c: string, n: string) => {
    const l = pyInds(), x = l.find(y => y.id === chartId.current) || l.find(y => y.name === n);
    if (x) { chartId.current = x.id; setPyInds(l.map(y => y === x ? { ...y, name: n, code: c, on: true } : y)); }
    else { const id = Date.now().toString(36); chartId.current = id; setPyInds([...l, { id, name: n, code: c, on: true }]); }
  };
  async function apply() {
    setName(nm); save(code, nm); clearTimeout(saveT.current);
    pyClear(nm); setBusy(true);
    try {
      setStat(pyStatus.state === 'ready' ? 'Checking…' : 'Loading Python…');
      try { await pyLoad(pyLibs(code)); }
      catch (e) { setStat('Python did not load'); pyLog(nm, (e as Error).message, 'er'); return; }
      const syn = await pyCall('_ti_check', [code]);
      if (syn) { setStat('Fix the error and try again'); pyLog(nm, syn, 'er'); return; }
      toChart(code, nm); setStat('');
    } finally { setBusy(false); }
  }
  async function setParam(p: Param, raw: string | boolean) {
    const v = p.kind === 'bool' ? !!raw : p.kind === 'int' ? Math.round(+raw) : p.kind === 'float' ? +raw : String(raw);
    if ((p.kind === 'int' || p.kind === 'float') && (raw === '' || !isFinite(v as number))) return;
    if (v === p.value) return;
    const r = JSON.parse(await pyCall<string>('_tr_setvals', [code, JSON.stringify({ [p.name]: v })]) || '{}') as { code?: string; error?: string };
    if (r.error || r.code == null) { pyLog(nm, r.error || 'That setting could not be changed.', 'er'); return; }
    setCode(r.code); save(r.code);
    if (onChart) toChart(r.code, nm);
  }
  // Tab puts in spaces; Enter keeps the indent (four more after a line ending in ":"); Ctrl or Cmd+Enter applies
  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget, a = el.selectionStart, b = el.selectionEnd, v = el.value;
    const put = (s: string) => { const c = v.slice(0, a) + s + v.slice(b); edit(c); requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = a + s.length; }); };
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); apply(); }
    else if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); put('    '); }
    else if (e.key === 'Enter') { const ln = v.slice(v.lastIndexOf('\n', a - 1) + 1, a), ind = /^ */.exec(ln)![0]; e.preventDefault(); put('\n' + ind + (/:\s*$/.test(ln) ? '    ' : '')); }
  };
  const status = stat || (onChart && pyErrs.has(nm) ? 'Stopped with an error: see the console' : pyBusy.get(nm) || (onChart ? (onChart.on ? 'On the chart' : 'On the chart, hidden') : ''));
  return (
    <div className="modal-back pyback" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal pyed" role="dialog" aria-modal="true" aria-label="Python indicator">
        <header>
          <b className="pyed-t">Python</b>
          <input className="in ui" aria-label="Indicator name" placeholder="Indicator name" maxLength={60} value={name} onChange={e => setName(e.target.value)} onBlur={() => { if (name.trim()) save(code, nm); }} />
          <span className="spacer" />
          <button className="btn sm" title="How to write an indicator, and everything ctx can do" onClick={() => openGuide('pyind-api')}>Guide</button>
          <button className="ib" aria-label="Close" onClick={onClose}><IClose width={14} height={14} /></button>
        </header>
        <div className="body pyed-body">
          <textarea ref={ta} className="pycode" aria-label="Python code" spellCheck={false} autoCapitalize="off" autoCorrect="off" value={code} onKeyDown={onKey}
            onChange={e => edit(e.target.value.replace(/[‘’]/g, "'").replace(/[“”]/g, '"'))} />
          <div className="pyside">
            <section>
              <div className="cap">Settings</div>
              {typeof params === 'string' ? <p className="muted note">{params || (pyStatus.state === 'failed' ? 'Settings show here once Python has loaded.' : 'Loading Python…')}</p> : (
                <div className="pysets">{params.map(p => (
                  <label key={p.name} title={p.comment || undefined}>
                    <span>{p.name}</span>
                    {p.kind === 'bool' ? <input type="checkbox" aria-label={p.name} checked={!!p.value} onChange={e => setParam(p, e.target.checked)} />
                      : p.kind === 'choice' && p.choices && p.choices.length > 1 ? <select className="in ui" aria-label={p.name} value={String(p.value)} onChange={e => setParam(p, e.target.value)}>{p.choices.map(c => <option key={c}>{c}</option>)}</select>
                      : <input key={String(p.value)} className="in" aria-label={p.name} type={p.kind === 'choice' ? 'text' : 'number'} step={p.kind === 'int' ? 1 : 'any'} defaultValue={String(p.value)}
                        onBlur={e => setParam(p, e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur(); } }} />}
                  </label>))}</div>
              )}
            </section>
            <section className="grow">
              <div className="cap" style={{ display: 'flex', alignItems: 'center' }}>Console<span className="spacer" />{lines.length > 0 && <button className="ib txt" onClick={() => pyClear(nm)}>Clear</button>}</div>
              <div className="pycons" ref={cons} role="log" aria-label="Console">
                {lines.length ? lines.map((l, k) => <div key={k} className={l.kind}>{l.text || ' '}</div>)
                  : <div className="muted">{pyStatus.state === 'ready' ? 'What the indicator prints shows here.' : 'Python loads the first time you add an indicator, in a few seconds.'}</div>}
              </div>
            </section>
          </div>
        </div>
        <footer>
          <span className={'pystat' + (/error|Fix|not load/.test(status) ? ' bad' : '')} role="status">{status}</span>
          <span className="spacer" />
          <button className="btn" onClick={() => { save(code, nm); setName(nm); setStat('Saved to your scripts'); }}>Save</button>
          <button className="btn primary" disabled={busy} title="Ctrl+Enter" onClick={apply}>{onChart ? 'Apply to chart' : 'Add to chart'}</button>
        </footer>
      </div>
    </div>
  );
}
