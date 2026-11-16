// Optimize: the strategy run many times with different settings, side by side in background workers, ranked by a
// goal; the best can be written into the code or opened on the chart. Robustness: the best few checked on dates they
// were not chosen on (a holdout), in walk-forward windows, and by reshuffling their trades (Monte Carlo).
import { openGuide } from './guide/Guide';
import { useEffect, useMemo, useRef, useState } from 'react';
import { optimize, optValues, optText, optParse, optSorted, optCsv, optScoreTxt, comboTotal, distinctTotal, whenOf, offBy, smartBudget, workerCount, seriesSlice, OptPool, type When,
         OPT_CAP, OPT_CAP_SMALL, OPT_GOALS, type Combo, type Goal, type OptJob, type OptRow, type ParamInfo, type RunTasks } from '../core/optimizer';
import { robCandidates, robCompute, robCsv, robPlan, robRanked, robSorted, robSortDir, robSummary, ROB_CAP, ROB_CAP_SMALL, ROB_DEFAULTS, type RobSpec, type RobView } from '../core/robust';
import { optFmt, optLabel, type Mode } from '../core/backtest';
import { pyParams } from '../core/pybridge';
import { jsParams } from '../core/jsstrategy';
import { money, smoney } from '../core/account';
import { lowerBound, zone } from '../core/time';
import { store } from './appstore';
import { pref, setPref } from './live';
import { newId, type MarketSource } from './sessions';
import { python, pyBase, seriesFor, ymd, ymdUtc, type DataChoice, type Lang, type RunCosts, type RunSetup } from './backtest';
import { ITrash } from './icons';

/** a saved optimization (the Library keeps them): what ran, on what, and every result */
export interface OptDoc {
  v: 1; id: string; name: string; strategy: string; lang: Lang; code: string; mode: Mode; libs: string[]; tf: string;
  data: DataChoice; market: MarketSource; datasetName: string;
  /** the run's dates (t0 inclusive, t1 exclusive) and its first and last bars */
  t0: number; t1: number; from: number; to: number;
  balance: number; qty: number; costs: RunCosts;
  /** the prop challenge every run took (payouts as soon as allowed), or none */
  prop?: RunSetup['prop'];
  created: number; updated: number; goal: Goal; minTrades: number; split: number; splitT: number | null;
  spec: { params: Array<{ name: string; values: Combo[string][] }>; rules: string[]; search: 'smart' | 'grid' | 'random'; n?: number; seed: number;
    /** settings only used for some values of another (their "only when" notes), and every setting's value in the code */
    when?: Record<string, When>; base?: Combo };
  /** combinations not run: they differ from one that was only in settings that are off */
  repeats?: number;
  kinds: Record<string, ParamInfo['kind']>;
  combos: Combo[]; rows: OptRow[]; total: number; skipped: number; done: number; best: string; stopped?: boolean;
  robust?: { code: string; runTo: number; trades: Record<number, number[]>; fails: Record<number, string>; spec: RobSpec };
}
type PRow = { p: ParamInfo & { comment?: string; money?: boolean }; on: boolean; text: string };

const pool = new OptPool();
const touch = () => document.documentElement.classList.contains('touch');
const small = () => touch() || document.documentElement.classList.contains('m');
const shared = () => (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true && typeof SharedArrayBuffer === 'function';
const dur = (s: number) => s < 60 ? `${Math.max(1, Math.round(s))} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`;
const f2 = (x: number | null | undefined) => x == null || !isFinite(x) ? '—' : x >= 1e8 ? '∞' : x.toFixed(2);
const copyText = async (text: string, ok: string, onToast: (m: string, k?: string) => void) => { try { await navigator.clipboard.writeText(text); onToast(ok, 'up'); } catch { onToast('Could not copy: the browser blocked the clipboard.', 'err'); } };
export const docSetup = (d: OptDoc): RunSetup => ({ name: d.strategy, lang: d.lang, code: d.code, mode: d.mode, libs: d.libs, tf: d.tf, data: d.data, market: d.market, t0: d.t0, t1: d.t1,
  balance: d.balance, qty: d.qty, costs: d.costs, dataName: d.datasetName, prop: d.prop ?? null });

export function OptimizePanel({ active, which, code, lang, name, setup, busy, onUse, onShow, onToast, openId, onOpened, goRob, propOn }: {
  active: boolean; propOn: boolean; which: 'opt' | 'rob'; code: string; lang: Lang; name: string; setup: () => RunSetup | string; busy: boolean;
  onUse: (name: string, lang: Lang, docCode: string, combo: Combo) => void; onShow: (su: RunSetup, combo: Combo) => void; onToast: (m: string, k?: string) => void;
  openId: string | null; onOpened: () => void; goRob: () => void;
}) {
  const O = pref<{ search?: 'smart' | 'grid' | 'random'; n?: number; goal?: Goal; minT?: number; split?: number }>('opt', {});
  const [rows, setRows] = useState<PRow[]>([]);
  const [detectErr, setDetectErr] = useState('');
  const [search, setSearch] = useState(O.search || 'smart');
  const [nRandom, setNRandom] = useState(O.n || 200);
  const [rules, setRules] = useState('');
  const [goal, setGoal] = useState<Goal>(O.goal || 'ndd');
  const [minT, setMinT] = useState(O.minT ?? 10);
  const [split, setSplit] = useState(O.split ?? 30);
  const [doc, setDoc] = useState<OptDoc | null>(null);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<{ text: string; kind?: string }>({ text: '' });
  const [prog, setProg] = useState<{ done: number; planned: number; best: string; left: string; n: number } | null>(null);
  const [sort, setSort] = useState<{ key: string; dir: number }>({ key: 'score', dir: -1 });
  const [sel, setSel] = useState<number | null>(null);
  const [savedV, setSavedV] = useState(0);
  const stopRef = useRef(false);
  const remember = (x: Record<string, unknown>) => setPref('opt', { ...pref('opt', {}), ...x });

  /* ---- the settings at the top of the code, read again as it changes ---- */
  useEffect(() => {
    if (!active || which !== 'opt') return;
    let gone = false;
    const t = setTimeout(async () => {
      try {
        if (lang === 'py') setStatus(s => s.text ? s : { text: 'Loading Python to read the settings…' });
        const r = lang === 'py' ? pyParams(await python(), code) : jsParams(code);
        if (gone) return;
        setStatus(s => s.text === 'Loading Python to read the settings…' ? { text: '' } : s);
        if ('error' in r) return setDetectErr(r.error);
        setDetectErr('');
        setRows(old => (r.params as PRow['p'][]).map(p => {
          const o = old.find(x => x.p.name === p.name);
          if (o && o.p.kind === p.kind && o.p.value === p.value) return { ...o, p };
          return { p, on: !!p.param, text: optText(p, optValues(p, p.param ? 'param' : 'normal')) };
        }));
      } catch (e) { if (!gone) setStatus({ text: (e as Error).message, kind: 'er' }); }
    }, rows.length ? 700 : 0);
    return () => { gone = true; clearTimeout(t); };
  }, [code, lang, active, which]); // eslint-disable-line react-hooks/exhaustive-deps
  // Python workers start loading while the settings are chosen
  useEffect(() => {
    if (!active || lang !== 'py' || running) return;
    pyBase().then(b => pool.warm(Math.min(2, workerCount({ phone: small(), shared: shared(), python: true })), { type: 'warm', pyBase: b, libs: ['numpy'] })).catch(() => {});
  }, [active, lang]); // eslint-disable-line react-hooks/exhaustive-deps
  // a saved optimization opened from the Library
  useEffect(() => { if (openId) { open(openId); onOpened(); } }, [openId]); // eslint-disable-line react-hooks/exhaustive-deps

  const parsed = rows.map(r => r.on ? optParse(r.p, r.text) : null);
  const ticked = rows.map((r, k) => ({ r, v: parsed[k] })).filter(x => x.r.on);
  const params = ticked.filter(x => x.v && 'vals' in x.v).map(x => ({ name: x.r.p.name, values: (x.v as { vals: Combo[string][] }).vals }));
  // settings that are off in a combination (by their "only when" notes) stay at their value: fewer different runs
  const when = useMemo(() => whenOf(rows.map(r => r.p)), [rows]);
  const codeVals = useMemo(() => Object.fromEntries(rows.map(r => [r.p.name, r.p.value])) as Combo, [rows]);
  const raw = comboTotal({ params });
  const total = useMemo(() => distinctTotal({ params, when, base: codeVals }) ?? raw, [JSON.stringify(params), when, codeVals]); // eslint-disable-line react-hooks/exhaustive-deps
  const cap = small() ? OPT_CAP_SMALL : OPT_CAP;
  const nWorkers = workerCount({ phone: small(), shared: shared(), python: lang === 'py' });
  const runs = search === 'grid' ? total : search === 'random' ? Math.min(nRandom, total, cap) : smartBudget(total, cap);
  const countLine = !ticked.length ? 'Tick the settings to try.'
    : `${total.toLocaleString('en-US')} combination${total === 1 ? '' : 's'}${raw > total ? ` (${(raw - total).toLocaleString('en-US')} more only change settings that are off, so are not run)` : ''}${search !== 'grid' && runs < total ? `; trying ${runs.toLocaleString('en-US')} of them` : ''}${rules.trim() ? ', fewer after the rules' : ''}.`;
  const overCap = search === 'grid' && total > cap;
  const preset = (k: 'narrow' | 'normal' | 'wide') => setRows(rows.map(r => r.on && (r.p.kind === 'int' || r.p.kind === 'float') ? { ...r, text: optText(r.p, optValues(r.p, k)) } : r));

  /* ---- a run ---- */
  async function start() {
    if (running || busy) return;
    const su = setup();
    if (typeof su === 'string') return setStatus({ text: su, kind: 'er' });
    const bad = ticked.find(x => !x.v || 'error' in x.v);
    if (bad) return setStatus({ text: `Values to try for ${bad.r.p.name}: ${(bad.v as { error: string } | null)?.error || 'no values'}.`, kind: 'er' });
    if (!params.length) return setStatus({ text: 'Tick at least one setting to try.', kind: 'er' });
    if (goal === 'take' && !su.prop) return setStatus({ text: 'Payouts − fees ranks by a prop challenge: tick “Practice a prop firm challenge” in the Run settings, or pick another goal.', kind: 'er' });
    if (overCap) return setStatus({ text: `${total.toLocaleString('en-US')} combinations is more than ${cap.toLocaleString('en-US')}. Narrow the ranges, or use Smart or a random sample.`, kind: 'er' });
    stopRef.current = false; setRunning(true); setSel(null); setProg(null);
    if (touch()) store.awake(true);
    try {
      setStatus({ text: 'Preparing the market data…' });
      const s = await seriesFor(su.market);
      const startI = Math.max(1, Math.min(lowerBound(s.t, su.t0), s.n - 1)), endI = Math.max(startI + 1, Math.min(lowerBound(s.t, su.t1), s.n));
      const sl = seriesSlice(s, startI, endI);
      const splitT = split ? s.t[startI + Math.floor((endI - startI) * (1 - split / 100))] : null;
      const job: OptJob = { lang: su.lang, code: su.code, mode: su.mode, tf: su.tf, libs: su.libs, pyBase: su.lang === 'py' ? await pyBase() : undefined, data: sl.data, start: 1, end: sl.data.n, splitT,
        balance: su.balance, qty: su.qty, costs: su.costs, zone: zone.id, prop: su.prop };
      const n = workerCount({ bytes: sl.bytes, shared: sl.shared, phone: small(), python: su.lang === 'py' });
      const seed = Math.floor(Math.random() * 1e9);
      const kinds = Object.fromEntries(rows.map(r => [r.p.name, r.p.kind]));
      const d: OptDoc = { v: 1, id: newId(), name: `${su.name} optimization`, strategy: su.name, lang: su.lang, code: su.code, mode: su.mode, libs: su.libs, tf: su.tf, data: su.data, market: su.market,
        datasetName: su.dataName, t0: su.t0, t1: su.t1, from: s.t[startI], to: s.t[endI - 1], balance: su.balance, qty: su.qty, costs: su.costs, prop: su.prop, created: Date.now(), updated: Date.now(),
        goal, minTrades: minT, split, splitT, spec: { params, rules: rules.split('\n'), search, n: search === 'random' ? nRandom : undefined, seed, ...(Object.keys(when).length ? { when, base: codeVals } : {}) }, kinds,
        combos: [], rows: [], total, skipped: 0, done: 0, best: '' };
      const seen = new Map<number, Combo>(), base = pool.runner(job, n);
      const runTasks: RunTasks = (tasks, on) => { for (const t of tasks) seen.set(t.idx, t.overrides); return base(tasks, on); };
      const t0 = performance.now();
      setStatus({ text: `Starting ${n} parallel run${n === 1 ? '' : 's'}…` });
      const out = await optimize({ params, rules: d.spec.rules, search, n: search === 'random' ? nRandom : undefined, seed, cap, goal, minTrades: minT, when: d.spec.when, base: d.spec.base }, runTasks, {
        stopped: () => stopRef.current,
        progress: p => {
          const el = (performance.now() - t0) / 1000, left = p.done ? el / p.done * Math.max(0, p.planned - p.done) : 0;
          const bc = p.best ? seen.get(p.best.i) : null;
          setProg({ done: p.done, planned: p.planned, n, left: p.done > 1 ? `about ${dur(left)} left` : '', best: bc ? `${optLabel(bc)}: ${optScoreTxt(p.best!.score!, goal, smoney)}` : '' });
          setStatus({ text: `${p.done} of ${p.planned} · ${n} at a time` });
        },
      });
      if (out.error) { setStatus({ text: out.error, kind: 'er' }); return; }
      Object.assign(d, { combos: out.combos, rows: out.rows.map(r => ({ i: r.i, res: r.res })), skipped: out.skipped, repeats: out.repeats, done: out.rows.length, stopped: out.stopped, updated: Date.now(),
        best: out.best ? `${optLabel(out.combos[out.best.i])}: ${optScoreTxt(out.best.score!, goal, smoney)}` : '' });
      setDoc(d); setSort({ key: 'score', dir: -1 });
      const allFailed = out.rows.length && out.rows.every(r => r.res.fail);
      setStatus(allFailed ? { text: `Every run failed: ${out.firstErr.split('\n')[0]}`, kind: 'er' }
        : { text: (out.stopped ? `Stopped: ${out.rows.length} of ${search === 'grid' ? out.combos.length : runs} done` : 'Optimization done') + (out.firstErr ? `. Some runs failed: ${out.firstErr.split('\n')[0]}` : '') + ` (${dur((performance.now() - t0) / 1000)}).`, kind: out.firstErr ? 'er' : 'ok' });
      try { await store.saveOptim(d.id, d); setSavedV(v => v + 1); } catch (e) { onToast('Could not save the optimization: ' + (e as Error).message, 'err'); }
    } catch (e) { setStatus({ text: (e as Error).message, kind: 'er' }); }
    finally { setRunning(false); setProg(null); if (touch()) store.awake(false); }
  }
  async function open(id: string) {
    try {
      const d = await store.getOptim(id) as OptDoc;
      if (!d || d.v !== 1 || !d.market) throw new Error('This optimization was saved by an older version of Tape Replay and cannot be opened.');
      setDoc(d); setGoal(d.goal || 'ndd'); setMinT(d.minTrades ?? 10); setSplit(d.split ?? 30); setRules((d.spec?.rules || []).join('\n')); setSel(null); setSort({ key: 'score', dir: -1 });
      setStatus({ text: `Opened “${d.name}” from your Library.` });
    } catch (e) { onToast((e as Error).message, 'err'); }
  }
  const saveDoc = async (d: OptDoc) => { d.updated = Date.now(); try { await store.saveOptim(d.id, d); setSavedV(v => v + 1); } catch { /* kept on screen */ } };

  if (!active) return null;
  if (which === 'rob') return <RobustPanel doc={doc} busy={running || busy} onSave={saveDoc} onUse={c => doc && onUse(doc.strategy, doc.lang, doc.code, c)} onShow={c => doc && onShow(docSetup(doc), c)} onToast={onToast} />;
  return (
    <div className="page-in bt-opt">
      <div><h1 style={{ fontSize: 20 }}>Optimize “{name}”</h1>
        <p className="lead" style={{ fontSize: 13 }}>Runs the strategy many times with different settings, {nWorkers} at a time, on the market and dates of the Run panel, and ranks the results. Tick the settings to try and say which values. <button className="linkbtn" onClick={() => openGuide('optimize')}>How the optimizer works</button></p></div>
      <div className="card bt-ptable">
        {detectErr ? <div className="empty down">{detectErr}</div> : !rows.length ? <div className="empty">No settings found. Put them at the top of the code as {lang === 'py' ? 'NAME = value, like FAST = 9' : 'const NAME = value, like const FAST = 9;'}.</div> :
          <table className="t"><thead><tr><th /><th>Setting</th><th>Now</th><th>Values to try</th><th className="r">Count</th></tr></thead>
            <tbody>{rows.map((r, k) => { const v = parsed[k], err = v && 'error' in v ? v.error : ''; return (
              <tr key={r.p.name} className={r.on ? '' : 'off'}>
                <td><input type="checkbox" aria-label={`Try ${r.p.name}`} checked={r.on} onChange={e => setRows(rows.map((x, j) => j === k ? { ...x, on: e.target.checked } : x))} /></td>
                <td className="ui"><b>{r.p.name}</b>{r.p.money && <span className="tag bt-size" title="Sets the size or money: not usually optimized">size</span>}{r.p.kind === 'choice' && <span className="tag bt-size">choice</span>}{when[r.p.name] && <span className="tag bt-when" title={`Only used ${when[r.p.name].text.replace(/^only /i, '')}: combinations where it is off keep its value in the code`}>needs {when[r.p.name].on}</span>}{r.p.comment && <div className="muted bt-cmt">{r.p.comment}</div>}</td>
                <td>{optFmt(r.p.value)}</td>
                <td><input className={'in bt-vals' + (err ? ' bad' : '')} aria-label={`Values for ${r.p.name}`} title={err || undefined} value={r.text} disabled={!r.on} onChange={e => setRows(rows.map((x, j) => j === k ? { ...x, text: e.target.value } : x))} /></td>
                <td className="r">{r.on ? (v && 'vals' in v ? v.vals.length : '—') : ''}</td>
              </tr>); })}</tbody></table>}
      </div>
      <div className="bt-optrow">
        <div className="field">Ranges of the ticked settings<span className="seg"><button onClick={() => preset('narrow')}>Narrow</button><button onClick={() => preset('normal')}>Normal</button><button onClick={() => preset('wide')}>Wide</button></span></div>
        <div className="field">How to search<span className="seg">
          {([['smart', 'Smart'], ['grid', 'All combinations'], ['random', 'Random sample']] as const).map(([k, l]) => <button key={k} className={search === k ? 'on' : ''} onClick={() => { setSearch(k); remember({ search: k }); }}>{l}</button>)}</span></div>
        {search === 'random' && <label className="field" style={{ width: 150 }}>Combinations to try<input className="in" inputMode="numeric" value={nRandom} onChange={e => { const v = Math.max(1, parseInt(e.target.value) || 1); setNRandom(v); remember({ n: v }); }} /></label>}
      </div>
      <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>{search === 'smart' ? 'Smart finds a near-best in about a tenth of the runs: a coarse look over the whole range, then closer looks around the best.'
        : search === 'grid' ? 'Every combination of the values: thorough, but the count multiplies with each setting.' : 'A random sample of the combinations: a quick look over large ranges.'}</p>
      <div className="bt-optrow">
        <label className="field" style={{ flex: '1 1 260px' }}><span className="lbl">Rules combinations must meet (optional, one per line) <span className="q" title="Python expressions over the ticked settings, like FAST < SLOW. Combinations that fail a rule are not run.">?</span></span>
          <textarea className="in bt-rules" spellCheck={false} placeholder="FAST < SLOW" value={rules} onChange={e => setRules(e.target.value)} /></label>
        <label className="field" style={{ width: 210 }}><span className="lbl">Goal <span className="q" title="What the ranking favors. Net ÷ max drawdown prefers steady gains over lucky ones. Payouts − fees ranks by what a prop challenge paid you, less its evaluation fees (tick the prop challenge in the Run settings).">?</span></span>
          <select className="in ui" value={goal} onChange={e => { const g = e.target.value as Goal; setGoal(g); remember({ goal: g }); }}>{(Object.keys(OPT_GOALS) as Goal[]).map(g => <option key={g} value={g} disabled={g === 'take' && !propOn && goal !== 'take'}>{OPT_GOALS[g]}{g === 'take' ? (propOn ? ' (prop challenge)' : ' (needs the prop challenge)') : ''}</option>)}</select></label>
        <label className="field" style={{ width: 130 }}><span className="lbl">Minimum trades <span className="q" title="Combinations with fewer trades are not ranked: a handful of trades proves little.">?</span></span>
          <input className="in" inputMode="numeric" value={minT} onChange={e => { const v = Math.max(0, parseInt(e.target.value) || 0); setMinT(v); remember({ minT: v }); }} /></label>
        <div className="field"><span className="lbl">Check on the last <span className="q" title="Keeps the last part of the dates out of the ranking, and shows how each combination did there (the Check columns): a guard against settings that only fit the past.">?</span></span>
          <span className="seg">{[0, 20, 30, 40].map(v => <button key={v} className={split === v ? 'on' : ''} onClick={() => { setSplit(v); remember({ split: v }); }}>{v ? v + '%' : 'Off'}</button>)}</span></div>
      </div>
      <div className="bt-optrun">
        {running ? <button className="btn danger" onClick={() => { stopRef.current = true; pool.stop(); }}>Stop</button>
          : <button className="btn primary" style={{ height: 40, padding: '0 20px' }} disabled={busy || !params.length || overCap} onClick={start}>Run optimization</button>}
        <span className={overCap ? 'down' : 'muted'} style={{ fontSize: 12.5 }}>{countLine}{overCap ? ` That is more than ${cap.toLocaleString('en-US')}${small() ? ' (the most on phones and tablets)' : ''}: narrow the ranges, or use Smart or a random sample.` : ''}</span>
      </div>
      {(prog || status.text) && <div className="bt-optstat" role="status">
        {prog && <div className="bar"><i style={{ width: `${(prog.done / Math.max(1, prog.planned) * 100).toFixed(1)}%` }} /></div>}
        <span className={status.kind === 'er' ? 'down' : status.kind === 'ok' ? 'up' : 'muted'}>{status.text}{prog?.left ? ` · ${prog.left}` : ''}</span>
        {prog?.best && <span>Best so far: <b className="num">{prog.best}</b></span>}
      </div>}
      {doc && <OptResults doc={doc} sort={sort} setSort={setSort} sel={sel} setSel={setSel} busy={running || busy}
        onUse={c => onUse(doc.strategy, doc.lang, doc.code, c)} onShow={c => onShow(docSetup(doc), c)} onToast={onToast} goRob={goRob} />}
      <OptimList key={savedV} onOpen={open} onToast={onToast} current={doc?.id} />
    </div>
  );
}

/* ---- the results table ---- */
function OptResults({ doc, sort, setSort, sel, setSel, busy, onUse, onShow, onToast, goRob }: {
  doc: OptDoc; sort: { key: string; dir: number }; setSort: (s: { key: string; dir: number }) => void; sel: number | null; setSel: (i: number | null) => void; busy: boolean;
  onUse: (c: Combo) => void; onShow: (c: Combo) => void; onToast: (m: string, k?: string) => void; goRob: () => void;
}) {
  const names = doc.spec.params.map(p => p.name), split = doc.splitT != null, prop = !!doc.prop;
  const [allSame, setAllSame] = useState(false);
  const sortedAll = optSorted(doc.rows, doc.combos, doc.goal, doc.minTrades, sort.key, sort.dir);
  // runs that made exactly the same trades (other settings, same result): one row, the rest counted on it
  const same = new Map<string, number[]>();
  for (const r of sortedAll) if (r.res.fp && !r.res.fail) { const g = same.get(r.res.fp); if (g) g.push(r.i); else same.set(r.res.fp, [r.i]); }
  const hiddenN = [...same.values()].reduce((n, g) => n + g.length - 1, 0);
  const sorted = allSame ? sortedAll : sortedAll.filter(r => !r.res.fp || r.res.fail || same.get(r.res.fp)![0] === r.i);
  const limit = small() ? 50 : 300, shown = sorted.slice(0, limit);
  const when = doc.spec.when, base = doc.spec.base;
  const click = (key: string) => setSort(sort.key === key ? { key, dir: -sort.dir } : { key, dir: key.startsWith('p:') || key === 'a.dd' ? 1 : -1 });
  const th = (key: string, label: string, r = true) => <th className={(r ? 'r ' : '') + 'bt-sort' + (sort.key === key ? ' on' : '')} onClick={() => click(key)} title="Sort">{label}{sort.key === key ? (sort.dir < 0 ? ' ▾' : ' ▴') : ''}</th>;
  const selC = sel != null ? doc.combos[sel] : null;
  const csv = () => copyText(optCsv(sorted, doc.combos, names, split), `Copied ${sorted.length} results as CSV.`, onToast);
  const end = doc.splitT ?? doc.to;
  return (
    <section className="bt-optres">
      <div className="bt-reshead">
        <p className="muted" style={{ margin: 0, fontSize: 12.5, flex: '1 1 320px' }}>
          {doc.spec.search === 'smart' ? `Smart search: ${doc.done} runs over ${doc.total.toLocaleString('en-US')} combinations` : `${doc.done} of ${doc.combos.length} combinations`}{doc.skipped ? ` (${doc.skipped} skipped by the rules)` : ''}{doc.repeats ? ` (${doc.repeats.toLocaleString('en-US')} not run: they only changed settings that were off)` : ''}, ranked by {OPT_GOALS[doc.goal]} on {ymd(doc.from)} to {ymd(end - 1)}{split ? `; Check columns: ${ymd(doc.splitT!)} to ${ymd(doc.to)}` : ''}{prop ? `. Each run took the prop challenge (${doc.prop!.cfg.preset || 'your own rules'}${doc.prop!.rebuy ? ', buying new evaluations' : ''}) over all its dates` : ''}. Click a column to sort, a row to select it.
          {hiddenN > 0 && <label className="chk bt-same" title="Runs with other settings that made exactly the same trades are counted on one row"><input type="checkbox" checked={allSame} onChange={e => setAllSame(e.target.checked)} />Show {hiddenN.toLocaleString('en-US')} with the same trades as another</label>}
        </p>
        {(() => { const top = optSorted(doc.rows, doc.combos, doc.goal, doc.minTrades).find(x => !x.res.fail && isFinite(x.score ?? -Infinity)); return top ?
          <button className="btn sm primary" title={`Write the best by ${OPT_GOALS[doc.goal]} into the strategy's code: ${optLabel(doc.combos[top.i])}`} onClick={() => onUse(doc.combos[top.i])}>Use the best in code</button> : null; })()}
        <button className="btn sm" onClick={csv}>Copy results (CSV)</button>
        <button className="btn sm" onClick={goRob}>Test robustness</button>
      </div>
      {selC && <div className="bt-selbar">
        <b className="num">{optLabel(selC)}</b><span className="spacer" />
        <button className="btn sm primary" title="Write these settings into the strategy's code" onClick={() => onUse(selC)}>Use these in code</button>
        <button className="btn sm" disabled={busy} onClick={() => onShow(selC)}>Show on chart</button>
      </div>}
      <div className="card bt-tablewrap">
        <table className="t bt-rtable"><thead><tr><th>#</th>{names.map(n => th('p:' + n, n, false))}{th('score', OPT_GOALS[doc.goal])}{th('a.trades', 'Trades')}{th('a.net', 'Net')}{th('a.win', 'Win %')}{th('a.pf', 'PF')}{th('a.dd', 'Max DD')}
          {prop && <>{doc.goal !== 'take' && th('sim.take', 'Payouts − fees')}{th('sim.income', 'Payouts to you')}{th('sim.nPay', 'Payouts')}{th('sim.maxPay', 'Largest payout')}{th('sim.passed', 'Evals passed')}{th('sim.attempts', 'Evals')}</>}
          {split && <>{th('b.net', 'Check: net')}{th('b.pf', 'Check: PF')}{th('b.trades', 'Check: trades')}</>}</tr></thead>
          <tbody>{shown.map((r, k) => { const c = doc.combos[r.i], a = r.res.a, b = r.res.b, low = !isFinite(r.score ?? -Infinity); return (
            <tr key={r.i} className={(sel === r.i ? 'sel ' : '') + (low ? 'low' : '')} onClick={() => setSel(sel === r.i ? null : r.i)}>
              <td>{k + 1}{(() => { const g = !allSame && r.res.fp && !r.res.fail ? same.get(r.res.fp) : null; return g && g.length > 1 ? <span className="tag bt-samen" title={`${g.length - 1} other combination${g.length > 2 ? 's' : ''} made exactly these trades:\n${g.slice(1, 13).map(i => optLabel(doc.combos[i])).join('\n')}${g.length > 13 ? '\n…' : ''}`}>+{g.length - 1}</span> : null; })()}</td>
              {names.map(n => { const w = offBy(n, c, when, base); return <td key={n} className={w ? 'bt-off' : undefined} title={w ? `Not used here: only ${w.text.replace(/^only /i, '')}` : undefined}>{optFmt(c[n])}</td>; })}
              {r.res.fail ? <td className="ui down" colSpan={6 + (split ? 3 : 0) + (prop ? (doc.goal !== 'take' ? 6 : 5) : 0)}>{String(r.res.fail).split('\n')[0]}</td> : <>
                <td className="r"><b>{optScoreTxt(r.score!, doc.goal, smoney)}</b></td><td className="r">{a?.trades}</td><td className={'r ' + ((a?.net ?? 0) >= 0 ? 'up' : 'down')}>{a ? smoney(a.net) : ''}</td>
                <td className="r">{a?.win == null ? '—' : a.win.toFixed(0)}</td><td className="r">{f2(a?.pf)}</td><td className="r">{a ? money(a.dd) : ''}</td>
                {prop && (() => { const m = r.res.sim; return <>{doc.goal !== 'take' && <td className={'r ' + ((m?.take ?? 0) >= 0 ? 'up' : 'down')}>{m ? smoney(m.take) : '—'}</td>}
                  <td className="r">{m ? money(m.income) : '—'}</td><td className="r">{m?.nPay ?? '—'}</td><td className="r">{m?.nPay ? money(m.maxPay) : '—'}</td><td className="r">{m?.passed ?? '—'}</td><td className="r">{m?.attempts ?? '—'}</td></>; })()}
                {split && <><td className={'r ' + ((b?.net ?? 0) >= 0 ? 'up' : 'down')}>{b ? smoney(b.net) : ''}</td><td className="r">{f2(b?.pf)}</td><td className="r">{b?.trades}</td></>}</>}
            </tr>); })}</tbody></table>
      </div>
      {sorted.length > limit && <p className="muted" style={{ fontSize: 12, margin: 0 }}>The best {limit} of {sorted.length} are shown. Copy as CSV for all of them.</p>}
    </section>
  );
}

/* ---- saved optimizations (here and in the Library) ---- */
export function OptimList({ onOpen, onToast, current }: { onOpen: (id: string) => void; onToast: (m: string, k?: string) => void; current?: string | null }) {
  const [list, setList] = useState<Array<Record<string, any>> | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const load = () => store.listOptims().then(l => setList((l as Array<Record<string, any>>).sort((a, b) => (b.updated || 0) - (a.updated || 0)))).catch(() => setList([]));
  useEffect(() => { load(); }, []);
  const remove = async (id: string) => { setConfirm(null); try { await store.deleteOptim(id); load(); onToast('Removed.'); } catch (e) { onToast((e as Error).message, 'err'); } };
  return (
    <section className="bt-saved">
      <h2 className="h2" style={{ margin: 0 }}>Saved optimizations</h2>
      {list && !list.length && <p className="muted" style={{ margin: 0 }}>None yet. Each optimization saves itself to your Library when it finishes.</p>}
      {!!list?.length && <div className="libtable">{list.map(o => (
        <div key={o.id} className={'librow' + (o.id === current ? ' cur' : '')}>
          <div className="main"><b className="nm">{o.name}</b>
            <span className="muted">{[o.datasetName, o.tf, o.from ? `${ymd(o.from)} → ${ymd(o.to)}` : '', o.done != null ? `${o.done} runs` : ''].filter(Boolean).join(' · ')}{o.best ? ` · best ${o.best}` : ''}</span></div>
          <span className="acts">
            <button className="btn sm primary" onClick={() => onOpen(o.id)}>Open</button>
            {confirm === o.id ? <><button className="btn sm danger" onClick={() => remove(o.id)}>Delete it</button><button className="btn sm" onClick={() => setConfirm(null)}>Keep it</button></>
              : <button className="ib" aria-label={`Delete ${o.name}`} title="Delete" onClick={() => setConfirm(o.id)}><ITrash width={16} height={16} /></button>}
          </span>
        </div>))}</div>}
    </section>
  );
}

/* ---- robustness ---- */
function RobustPanel({ doc, busy, onSave, onUse, onShow, onToast }: { doc: OptDoc | null; busy: boolean; onSave: (d: OptDoc) => Promise<void>; onUse: (c: Combo) => void; onShow: (c: Combo) => void; onToast: (m: string, k?: string) => void }) {
  const R0 = doc?.robust?.spec;
  const def = () => {
    const o = doc?.splitT != null ? { on: true, from: ymd(doc.splitT), to: ymd(doc.t1 - 1) } : doc ? { on: false, from: ymd(doc.t1), to: ymd(doc.t1 + 6 * 86400) } : { on: false, from: '', to: '' };
    return { pct: R0?.pct ?? ROB_DEFAULTS.pct, oos: R0?.oos ?? o.on, oFrom: R0 ? ymd(R0.oFrom) : o.from, oTo: R0 ? ymd(R0.oTo - 1) : o.to, wf: R0?.wf ?? true, wfN: R0?.wfN ?? ROB_DEFAULTS.wfN,
      wfIs: R0?.wfIs ?? ROB_DEFAULTS.wfIs, wfMode: R0?.wfMode ?? ROB_DEFAULTS.wfMode as 'rolling' | 'anchored', mc: R0?.mc ?? true, mcN: R0?.mcN ?? ROB_DEFAULTS.mcN,
      mcMode: R0?.mcMode ?? ROB_DEFAULTS.mcMode as 'resample' | 'shuffle', mcSkip: R0?.mcSkip ?? ROB_DEFAULTS.mcSkip, ruin: R0?.ruin ? String(R0.ruin) : '' };
  };
  const [F, setF] = useState(def);
  const [view, setView] = useState<RobView | null>(null);
  const [running, setRunning] = useState(false);
  const [msg, setMsg] = useState<{ text: string; kind?: string }>({ text: '' });
  const [sort, setSort] = useState<{ key: string; dir: number }>({ key: 'pass', dir: -1 });
  const [sel, setSel] = useState<number | null>(null);
  const docId = useRef<string | null>(null);
  useEffect(() => { if (doc && doc.id !== docId.current) { docId.current = doc.id; setF(def()); setView(null); setMsg({ text: '' }); } }, [doc]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (x: Partial<ReturnType<typeof def>>) => setF({ ...F, ...x });
  if (!doc) return <div className="page-in"><div className="emptycard"><b>Run an optimization first</b><p>Robustness tests check the best combinations of an optimization on dates they were not chosen on. Run one on the Optimize tab, or open a saved one there.</p></div></div>;
  const d = doc, names = d.spec.params.map(p => p.name);

  async function run() {
    if (running || busy) return;
    const sp: RobSpec = { pct: Math.max(1, Math.min(100, F.pct)), goal: d.goal, minT: d.minTrades, oos: F.oos, oFrom: ymdUtc(F.oFrom), oTo: ymdUtc(F.oTo, 1), wf: F.wf, wfN: Math.max(2, Math.min(24, F.wfN)), wfIs: F.wfIs, wfMode: F.wfMode,
      mc: F.mc, mcN: Math.max(100, Math.min(20000, F.mcN)), mcMode: F.mcMode, mcSkip: F.mcSkip, ruin: parseFloat(F.ruin) || 0 };
    const sorted = optSorted(d.rows, d.combos, d.goal, d.minTrades), cand = robCandidates(sorted, sp.pct, small() ? ROB_CAP_SMALL : ROB_CAP);
    if (!cand.cands.length) return setMsg({ text: 'No ranked combinations to test yet.', kind: 'er' });
    setRunning(true); setSel(null);
    if (touch()) store.awake(true);
    try {
      // the bars through the holdout
      let m = d.market;
      if (sp.oos && isFinite(sp.oTo)) m = m.kind === 'practice' ? { ...m, t1: Math.max(m.t1, sp.oTo + 86400) } : m.window ? { ...m, window: { ...m.window, to: Math.max(m.window.to, sp.oTo + 86400) } } : m;
      setMsg({ text: 'Preparing the market data…' });
      const s = await seriesFor(m);
      const rk = robRanked({ from: d.from, to: d.to, splitT: d.splitT }, s.t, s.base);
      const plan = robPlan(sp, rk, s.t[s.n - 1], s.base, ymd);
      if ('error' in plan) return setMsg({ text: plan.error, kind: 'er' });
      sp.oFrom = plan.oFrom;
      const R = d.robust && d.robust.code === d.code && d.robust.runTo >= plan.runTo ? d.robust : null;
      const trades: Record<number, number[]> = R ? { ...R.trades } : {}, fails: Record<number, string> = R ? { ...R.fails } : {};
      const todo = cand.cands.filter(i => !trades[i] && !fails[i]);
      const runTo = R ? R.runTo : plan.runTo;
      if (todo.length) {
        const a = lowerBound(s.t, d.from), sl = seriesSlice(s, Math.max(1, a), Math.max(a + 1, lowerBound(s.t, runTo)));
        const job: OptJob = { lang: d.lang, code: d.code, mode: d.mode, tf: d.tf, libs: d.libs, pyBase: d.lang === 'py' ? await pyBase() : undefined, data: sl.data, start: 1, end: sl.data.n, splitT: null,
          balance: d.balance, qty: d.qty, costs: d.costs, zone: zone.id };
        const n = workerCount({ bytes: sl.bytes, shared: sl.shared, phone: small(), python: d.lang === 'py' });
        setMsg({ text: `Running ${todo.length} candidate${todo.length === 1 ? '' : 's'} from ${ymd(d.from)} to ${ymd(runTo - 1)}, ${n} at a time.` });
        let k = 0;
        await pool.exec(job, todo.map(i => ({ idx: i, overrides: d.combos[i], trades: true })), n, (idx, res) => {
          if (res.fail) fails[idx] = res.fail; else trades[idx] = res.tr || [];
          setMsg({ text: `Robustness: ${++k} of ${todo.length} candidates run` });
        });
      }
      const v = await robCompute({ docId: d.id, spec: sp, cands: cand.cands, trades, runTo, rk, fails: Object.fromEntries(cand.cands.filter(i => fails[i]).map(i => [i, fails[i]])) },
        async t => { setMsg({ text: t }); await new Promise(r => setTimeout(r, 0)); });
      setView(v); setSort({ key: 'pass', dir: -1 });
      setMsg({ text: `Robustness tests done. ${v.message}`, kind: 'ok' });
      d.robust = { code: d.code, runTo, trades, fails, spec: sp };
      await onSave(d);
    } catch (e) { setMsg({ text: (e as Error).message, kind: 'er' }); }
    finally { setRunning(false); if (touch()) store.awake(false); }
  }

  const sorted = view ? robSorted(view, d.combos, sort.key, sort.dir) : [];
  const click = (key: string) => setSort(sort.key === key ? { key, dir: -sort.dir } : { key, dir: robSortDir(key) });
  const th = (key: string, label: string) => <th className={'r bt-sort' + (sort.key === key ? ' on' : '')} onClick={() => click(key)}>{label}{sort.key === key ? (sort.dir < 0 ? ' ▾' : ' ▴') : ''}</th>;
  const pct = (x: number | null | undefined) => x == null || !isFinite(x) ? '—' : `${Math.round(x * 100)}%`;
  const selC = sel != null ? d.combos[sel] : null;
  const hasMC = !!view?.rows.some(r => r.mc), hasRuin = !!view?.rows.some(r => r.mc?.ruin != null);
  return (
    <div className="page-in bt-opt">
      <div><h1 style={{ fontSize: 20 }}>Robustness of “{d.name}”</h1>
        <p className="lead" style={{ fontSize: 13 }}>Good results on the dates settings were picked on can be luck. These tests take the best combinations and check them on other dates and other orders of their trades. <button className="linkbtn" onClick={() => openGuide('robust')}>About the tests</button></p></div>
      <div className="bt-robgrid">
        <div className="card bt-robcard">
          <label className="field">Test the best (% of ranked combinations)<span className="suffix"><input className="in" inputMode="numeric" aria-label="Test the best percent" value={F.pct} onChange={e => set({ pct: parseInt(e.target.value) || 0 })} /><span>%</span></span></label>
        </div>
        <div className="card bt-robcard">
          <label className="chk"><input type="checkbox" checked={F.oos} onChange={e => set({ oos: e.target.checked })} /><b>Out of sample</b></label>
          <span className="muted">Each candidate on dates the optimization did not rank on (the holdout).</span>
          <div className="bt-2"><label className="field">From<input className="in" type="date" aria-label="Holdout from" value={F.oFrom} disabled={!F.oos} onChange={e => set({ oFrom: e.target.value })} /></label>
            <label className="field">To<input className="in" type="date" aria-label="Holdout to" value={F.oTo} disabled={!F.oos} onChange={e => set({ oTo: e.target.value })} /></label></div>
        </div>
        <div className="card bt-robcard">
          <label className="chk"><input type="checkbox" checked={F.wf} onChange={e => set({ wf: e.target.checked })} /><b>Walk-forward</b></label>
          <span className="muted">The ranked dates cut into windows: the best on each window’s first part trades its next part.</span>
          <div className="bt-3"><label className="field">Windows<input className="in" inputMode="numeric" aria-label="Walk-forward windows" value={F.wfN} disabled={!F.wf} onChange={e => set({ wfN: parseInt(e.target.value) || 2 })} /></label>
            <label className="field">In sample<select className="in ui" value={F.wfIs} disabled={!F.wf} onChange={e => set({ wfIs: +e.target.value })}>{[60, 70, 75, 80].map(v => <option key={v} value={v}>{v}%</option>)}</select></label>
            <label className="field">Windows are<select className="in ui" value={F.wfMode} disabled={!F.wf} onChange={e => set({ wfMode: e.target.value as 'rolling' | 'anchored' })}><option value="rolling">Rolling</option><option value="anchored">Anchored</option></select></label></div>
        </div>
        <div className="card bt-robcard">
          <label className="chk"><input type="checkbox" checked={F.mc} onChange={e => set({ mc: e.target.checked })} /><b>Monte Carlo</b></label>
          <span className="muted">Each candidate’s trades redrawn many times: how bad could it have gone?</span>
          <div className="bt-2"><label className="field">Simulations<input className="in" inputMode="numeric" aria-label="Simulations" value={F.mcN} disabled={!F.mc} onChange={e => set({ mcN: parseInt(e.target.value) || 100 })} /></label>
            <label className="field">Method<select className="in ui" aria-label="Monte Carlo method" value={F.mcMode} disabled={!F.mc} onChange={e => set({ mcMode: e.target.value as 'resample' | 'shuffle' })}><option value="resample">Resample</option><option value="shuffle">Shuffle</option></select></label>
            <label className="field">Skip trades<select className="in ui" value={F.mcSkip} disabled={!F.mc} onChange={e => set({ mcSkip: +e.target.value })}>{[0, 5, 10, 20].map(v => <option key={v} value={v}>{v ? v + '%' : 'None'}</option>)}</select></label>
            <label className="field"><span className="lbl">Ruin at a drawdown of <span className="q" title="Counts how often a drawdown reaches this many dollars. Blank: off.">?</span></span><span className="suffix"><input className="in" inputMode="numeric" value={F.ruin} disabled={!F.mc} placeholder="off" onChange={e => set({ ruin: e.target.value })} /><span>$</span></span></label></div>
        </div>
      </div>
      <div className="bt-optrun">
        <button className="btn primary" style={{ height: 40, padding: '0 20px' }} disabled={running || busy} onClick={run}>{running ? 'Testing…' : 'Run robustness tests'}</button>
        {msg.text && <span role="status" className={msg.kind === 'er' ? 'down' : msg.kind === 'ok' ? 'up' : 'muted'} style={{ fontSize: 12.5 }}>{msg.text}</span>}
      </div>
      {view && <section className="bt-optres">
        <div className="bt-reshead"><p className="muted" style={{ margin: 0, fontSize: 12.5, flex: '1 1 320px' }}>{robSummary(view, ymd)}</p>
          <button className="btn sm" onClick={() => copyText(robCsv(view, d.combos, names, optFmt), `Copied ${view.rows.length} candidates as CSV.`, onToast)}>Copy results (CSV)</button></div>
        {selC && <div className="bt-selbar"><b className="num">{optLabel(selC)}</b><span className="spacer" />
          <button className="btn sm primary" onClick={() => onUse(selC)}>Use in code</button><button className="btn sm" disabled={busy} onClick={() => onShow(selC)}>Show on chart</button></div>}
        <div className="card bt-tablewrap">
          <table className="t bt-rtable bt-robtable"><thead><tr>{names.map(n => <th key={n} className={'bt-sort' + (sort.key === 'p:' + n ? ' on' : '')} onClick={() => click('p:' + n)}>{n}</th>)}
            {th('is.net', 'Ranked net')}{th('is.pf', 'Ranked PF')}{th('is.dd', 'Ranked max DD')}
            {view.oosOk && <>{th('oos.trades', 'Holdout trades')}{th('oos.net', 'Holdout net')}{th('oos.pf', 'Holdout PF')}{th('oos.dd', 'Holdout max DD')}{th('eff', 'Holdout vs ranked')}</>}
            {view.wf && th('wfUp', 'WF windows in profit')}
            {hasMC && <>{th('mc.profit', 'MC in profit')}{th('mc.p5', 'MC net, worst 5%')}{th('mc.dd95', 'MC max DD, worst 5%')}{hasRuin && th('mc.ruin', 'MC ruin')}</>}
            {th('pass', 'Passed')}</tr></thead>
            <tbody>{sorted.map(r => { const c = d.combos[r.i]; return (
              <tr key={r.i} className={sel === r.i ? 'sel' : ''} onClick={() => setSel(sel === r.i ? null : r.i)}>
                {names.map(n => <td key={n}>{optFmt(c[n])}</td>)}
                <td className={'r ' + (r.is.net >= 0 ? 'up' : 'down')}>{smoney(r.is.net)}</td><td className="r">{f2(r.is.pf)}</td><td className="r">{money(r.is.dd)}</td>
                {view.oosOk && <><td className="r">{r.oos?.trades}</td><td className={'r ' + ((r.oos?.net ?? 0) > 0 ? 'up' : 'down')}>{r.oos ? smoney(r.oos.net) : ''}</td><td className="r">{f2(r.oos?.pf)}</td><td className="r">{r.oos ? money(r.oos.dd) : ''}</td><td className="r">{r.eff == null ? '—' : `${Math.round(r.eff)}%`}</td></>}
                {view.wf && <td className={'r ' + (r.wfUp! >= Math.ceil(view.wf.wins.length / 2) ? 'up' : 'down')}>{r.wfUp} of {view.wf.wins.length}</td>}
                {hasMC && <><td className={'r ' + (r.mc ? (r.mc.profit >= 0.7 ? 'up' : r.mc.profit < 0.5 ? 'down' : '') : '')}>{pct(r.mc?.profit)}</td><td className="r">{r.mc ? smoney(r.mc.p5) : '—'}</td><td className="r">{r.mc ? money(r.mc.dd95) : '—'}</td>
                  {hasRuin && <td className={'r ' + (r.mc?.ruin != null ? (r.mc.ruin <= 0.05 ? 'up' : 'down') : '')}>{pct(r.mc?.ruin)}</td>}</>}
                <td className={'r ' + (r.tests && r.pass === r.tests ? 'up' : '')}><b>{r.pass} of {r.tests}</b></td>
              </tr>); })}</tbody></table>
        </div>
        {Object.keys(view.fails).length > 0 && <p className="down" style={{ fontSize: 12, margin: 0 }}>Failed to run: {Object.entries(view.fails).map(([i, e]) => `${optLabel(d.combos[+i])} (${String(e).split('\n')[0]})`).join('; ')}</p>}
        {view.wf && <div className="card bt-wf">
          <p style={{ margin: 0, fontSize: 12.5 }}>Walk-forward, {view.wf.wins.length} {F.wfMode} windows, {F.wfIs}% in sample: out-of-sample net {smoney(view.wf.all.net)} over {view.wf.all.trades} trades, profit factor {f2(view.wf.all.pf)}, max drawdown {money(view.wf.all.dd)}; in profit in {view.wf.up} of {view.wf.picked} windows; efficiency {view.wf.eff == null ? '—' : Math.round(view.wf.eff) + '%'} (out-of-sample profit per day as a share of in-sample).</p>
          <div className="bt-tablewrap"><table className="t"><thead><tr><th>Window</th><th>In sample</th><th>Out of sample</th><th>Picked</th><th className="r">In-sample net</th><th className="r">Out-of-sample trades</th><th className="r">Net</th></tr></thead>
            <tbody>{view.wf.wins.map((w, k) => <tr key={k}><td>{k + 1}</td><td>{ymd(w.isFrom)} → {ymd(w.isTo - 1)}</td><td>{ymd(w.oosFrom)} → {ymd(w.oosTo - 1)}</td>
              {w.pick == null ? <td className="ui muted" colSpan={4}>no candidate met the minimum trades</td> : <><td>{optLabel(d.combos[w.pick])}</td><td className="r">{w.isSeg ? smoney(w.isSeg.net) : ''}</td><td className="r">{w.oos?.trades}</td><td className={'r ' + ((w.oos?.net ?? 0) >= 0 ? 'up' : 'down')}>{w.oos ? smoney(w.oos.net) : ''}</td></>}</tr>)}</tbody></table></div>
        </div>}
      </section>}
    </div>
  );
}
