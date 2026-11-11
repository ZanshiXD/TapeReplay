// Backtest: write a strategy (Python or JavaScript), run it over past data in seconds, and see what it would have
// done: the trades, the equity curve and the numbers. Then try many settings at once (Optimize) and check the best
// ones hold up on dates they were not chosen on (Robustness). A run can open as a replay session, its trades on the
// chart, to keep replaying from where it stopped.
import { openGuide } from './guide/Guide';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createChart, LineStyle, type UTCTimestamp } from 'lightweight-charts';
import { runBacktest, statsRows, tradesCsv, fmtDay, optLabel, yieldTask, type LogLine, type Mode, type RunResult, type Setting } from '../core/backtest';
import { jsApply, jsCheck, jsStrategy } from '../core/jsstrategy';
import { pandasErr, pyCheck, pySetValues, pyStrategy } from '../core/pybridge';
import { money, smoney, fmtQty } from '../core/account';
import { PRACTICE, PRACTICE_FROM, PRACTICE_TO } from '../core/practice';
import { openDataset } from '../core/library';
import { parseTF } from '../core/time';
import type { DatasetMeta } from '../core/store';
import type { SessionState } from '../core/session';
import type { PropConfig } from '../core/prop';
import { store } from './appstore';
import { pref, setPref } from './live';
import { C } from './look';
import { datasetInstrument, type Live, type Opening } from './sessions';
import { defaultProp, PropSetupCard } from './PropPanel';
import { IChev, IPlus, ITrash } from './icons';
import { usePhone } from './phone';
import { TEMPLATES, TICK_TEMPLATES, freeName, instOf, loadStrats, marketFor, python, pyReady, saveStrats, seriesFor, simRules, stratTfs, ymd, ymdUtc,
         type DataChoice, type Lang, type RunCosts, type RunSetup, type SimRun, type Strat } from './backtest';
import { OptimizePanel } from './OptimizePanel';
import './backtest.css';

type Tab = 'list' | 'code' | 'run' | 'results' | 'opt' | 'rob';
interface Prefs { name: string; mode: Mode; libs: 'numpy' | 'pandas'; tf: string; rebuy: boolean; maxEvals: number; data: DataChoice; range: [number, number]; base: number;
  from: string; to: string; balance: number; qty: number; costs: RunCosts | null; propOn: boolean; prop: PropConfig | null }
/** a finished run, as the Results tab shows it */
export interface RunView { r: RunResult; setup: RunSetup; overrides: Record<string, Setting> | null; sim: SimRun | null; tf: string }

const PRACTICE_RANGE: [number, number] = [PRACTICE_FROM, PRACTICE_TO];
const MAX_PRACTICE_DAYS = 62;
const MAX_LINES = 1500;
const phone = () => document.documentElement.classList.contains('m');
const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';

function defaults(live: Live | null): Prefs {
  const saved = pref<Partial<Prefs>>('strat', {});
  const p: Prefs = { name: 'MA cross', mode: 'bar', libs: 'numpy', tf: '5m', rebuy: false, maxEvals: 0, data: { kind: 'practice', sym: 'NQ' }, range: PRACTICE_RANGE, base: 1,
    from: '2026-04-06', to: '2026-04-10', balance: 50000, qty: 1, costs: null, propOn: false, prop: null, ...saved };
  // with a session open, its market and its first days
  const m = live?.markets[0];
  if (m) {
    const t = live!.start, days = 4;
    if (m.kind === 'practice') { p.data = { kind: 'practice', sym: m.sym }; p.range = PRACTICE_RANGE; p.base = 1; p.costs = { ...m.costs }; }
    else { const s = live!.session.feeds[0]?.s; p.data = { kind: 'dataset', id: m.id, name: m.name, pick: m.pick, inst: m.inst, long: !!m.window }; p.costs = { comm: m.inst.comm, spreadTicks: m.inst.spreadTicks, slipTicks: m.inst.slipTicks };
      if (s) { p.range = [s.t[0], s.t[s.n - 1]]; p.base = s.base; } }
    p.from = ymd(t); p.to = ymd(Math.min(t + days * 86400, p.range[1]));
  }
  return p;
}

export function BacktestPage({ hidden, live, onShow, onToast, onBusy, openOptim, onOptimOpened }: {
  hidden: boolean; live: Live | null;
  onShow: (x: Omit<Opening, 'inds'>, st: Omit<SessionState, 'inds'>) => Promise<void>;
  onToast: (m: string, k?: string) => void; onBusy: (b: { text: string; p: number } | null) => void;
  openOptim: string | null; onOptimOpened: () => void;
}) {
  const [strats, setStrats] = useState<Record<string, Strat>>(loadStrats);
  const [P, setP] = useState<Prefs>(() => defaults(live));
  const cur = P.name in strats ? P.name : Object.keys(strats)[0];
  const [code, setCode] = useState(strats[cur].code);
  const lang: Lang = strats[cur].lang;
  const [tab, setTab] = useState<Tab>('code');
  const [datasets, setDatasets] = useState<DatasetMeta[]>([]);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<{ text: string; p: number | null; kind?: string }>({ text: 'Ready', p: null });
  const [view, setView] = useState<RunView | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [newMenu, setNewMenu] = useState(false);
  const [codeOpen, setCodeOpenS] = useState(() => pref('btCodeOpen', true));
  const setCodeOpen = (b: boolean) => { setCodeOpenS(b); setPref('btCodeOpen', b); };
  const [codeH, setCodeH] = useState(() => pref('btCodeH', 420));
  const [consOpen, setConsOpenS] = useState(() => pref('btConsOpen', true));
  const setConsOpen = (b: boolean) => { setConsOpenS(b); setPref('btConsOpen', b); };
  /** a line of the code to show (an error's), and a counter so the same line can be shown again */
  const [goto, setGoto] = useState<{ line: number; n: number } | null>(null);
  const isPhone = usePhone();
  const newRef = useRef<HTMLDivElement>(null);
  const lines = useRef<LogLine[]>([]);
  const [, setCv] = useState(0);
  const stopRef = useRef(false);
  const saveT = useRef(0);

  const set = (x: Partial<Prefs>) => setP(p => { const n = { ...p, ...x }; setPref('strat', n); return n; });
  useDismiss(newRef, newMenu, () => setNewMenu(false));
  useEffect(() => { store.listDatasets().then(setDatasets).catch(() => {}); }, [hidden]);
  // a saved optimization opened from the Library
  useEffect(() => { if (openOptim) setTab('opt'); }, [openOptim]);

  /* ---- strategies ---- */
  const storeStrats = (s: Record<string, Strat>) => { setStrats(s); saveStrats(s); };
  const editCode = (c: string) => {
    setCode(c);
    clearTimeout(saveT.current);
    saveT.current = window.setTimeout(() => storeStrats({ ...strats, [cur]: { code: c, lang } }), 500);
  };
  const flushCode = () => { clearTimeout(saveT.current); if (strats[cur].code !== code) { const s = { ...strats, [cur]: { code, lang } }; storeStrats(s); return s; } return strats; };
  const pick = (name: string, s = strats) => { flushCode(); set({ name }); setCode(s[name].code); setConfirmDel(false); setRenaming(false); if (phone()) setTab('code'); };
  const addNew = (tpl: string) => {
    const s = { ...flushCode() }, name = freeName(tpl, s);
    s[name] = { ...TEMPLATES[tpl] }; storeStrats(s);
    set({ name, ...(TICK_TEMPLATES.has(tpl) ? { mode: 'tick' as Mode } : {}) }); setCode(s[name].code); setNewMenu(false); setTab('code');
  };
  const rename = (to: string) => {
    setRenaming(false); to = to.trim(); if (!to || to === cur) return;
    if (to in strats) return onToast(`There is a strategy called “${to}” already.`, 'err');
    const s: Record<string, Strat> = {};
    for (const [k, v] of Object.entries(strats)) s[k === cur ? to : k] = k === cur ? { code, lang } : v;
    storeStrats(s); set({ name: to });
  };
  const remove = () => {
    setConfirmDel(false);
    const s = { ...strats }; delete s[cur];
    if (!Object.keys(s).length) s[freeName('MA cross', s)] = { ...TEMPLATES['MA cross'] };
    storeStrats(s); const next = Object.keys(s)[0]; set({ name: next }); setCode(s[next].code);
    onToast(`Deleted “${cur}”.`);
  };

  /* ---- the console ---- */
  const log = (ls: LogLine[]) => {
    const L = lines.current; for (const l of ls) for (const t of l[0].split('\n')) L.push([t, l[1]]); if (L.length > MAX_LINES) L.splice(0, L.length - MAX_LINES);
    if (ls.length) setConsOpenS(true); // what the run says is shown, without changing the remembered choice
    setCv(v => v + 1);
  };
  /** an error in the strategy: the code opens at its line (the last line of the strategy the traceback names) */
  const showErr = (text: string) => { const m = [...text.matchAll(/line (\d+)/g)].pop(); if (!m) return; setCodeOpenS(true); setGoto(g => ({ line: +m[1], n: (g?.n || 0) + 1 })); };
  const clearLog = () => { lines.current = []; setCv(v => v + 1); };

  /* ---- the market and the run's settings ---- */
  const inst = instOf(P.data);
  const costs: RunCosts = P.costs || { comm: inst.comm, spreadTicks: inst.spreadTicks, slipTicks: inst.slipTicks };
  const tfs = useMemo(() => stratTfs(P.base), [P.base]);
  const prop = P.prop || defaultProp();
  async function chooseData(v: string) {
    if (v.startsWith('practice:')) { const sym = v.slice(9), i = PRACTICE[sym]; return set({ data: { kind: 'practice', sym }, range: PRACTICE_RANGE, base: 1, costs: { comm: i.comm, spreadTicks: i.spreadTicks, slipTicks: i.slipTicks } }); }
    const meta = datasets.find(d => d.id === v.slice(3)); if (!meta) return;
    try {
      onBusy({ text: `Opening ${meta.name}`, p: 0 });
      const o = await openDataset(store, meta, null, (p, s) => onBusy({ text: `${meta.name}: ${s}`, p }));
      const i0 = datasetInstrument(meta, o.pick, o.contracts, o.prec), mem = pref<Record<string, { pv?: number; comm: number; spread: number; slip: number }>>('costs', {})[i0.sym];
      const i = datasetInstrument(meta, o.pick, o.contracts, o.prec, mem ? { pv: mem.pv } : undefined);
      const c = { comm: mem?.comm ?? (i.pv > 1 ? 2.1 : 0), spreadTicks: mem?.spread ?? i.spreadTicks, slipTicks: mem?.slip ?? 0 };
      const to = Math.min(o.to, o.from + 365 * 86400 * 10), from = Math.max(o.from, o.to - 30 * 86400);
      set({ data: { kind: 'dataset', id: meta.id, name: meta.name, pick: o.pick, inst: { ...i, ...c }, long: !!o.index }, range: [o.from, o.to], base: o.base, costs: c,
            from: ymd(from), to: ymd(to), tf: stratTfs(o.base).includes(P.tf) ? P.tf : stratTfs(o.base)[0] });
    } catch (e) { onToast(`${meta.name}: ${(e as Error).message}`, 'err'); }
    finally { onBusy(null); }
  }
  /** the run's settings, or what is wrong with them */
  function setupNow(c = code, name = cur, lg = lang): RunSetup | string {
    const t0 = ymdUtc(P.from), t1 = ymdUtc(P.to, 1);
    if (!isFinite(t0) || !isFinite(t1)) return 'Pick the From and To dates.';
    if (t0 >= t1) return 'Pick a From date on or before the To date.';
    if (t1 <= P.range[0] || t0 > P.range[1]) return `The data runs from ${ymd(P.range[0])} to ${ymd(P.range[1])}. Pick dates in between.`;
    if (P.data.kind === 'practice' && t1 - t0 > MAX_PRACTICE_DAYS * 86400) return `Practice data is made as you ask for it: pick at most ${MAX_PRACTICE_DAYS} days.`;
    const libs = lg === 'py' && P.libs === 'pandas' ? ['numpy', 'pandas'] : ['numpy'];
    const pe = lg === 'py' ? pandasErr(c, libs) : null; if (pe) return pe;
    const tf = tfs.includes(P.tf) ? P.tf : tfs[0];
    return { name, lang: lg, code: c, mode: P.mode, libs, tf, data: P.data, market: marketFor(P.data, t0, t1, costs), t0, t1, balance: P.propOn ? prop.size : P.balance, qty: P.qty, costs,
             dataName: P.data.kind === 'practice' ? PRACTICE[P.data.sym].name : P.data.name, prop: P.propOn ? { cfg: prop, rebuy: P.rebuy, maxEvals: P.maxEvals } : null };
  }

  /* ---- a run ---- */
  async function run(o: { setup?: RunSetup; overrides?: Record<string, Setting> | null; chart?: boolean } = {}) {
    if (running) return;
    flushCode();
    const su = o.setup || setupNow();
    clearLog(); setTab(phone() ? 'run' : 'code');
    if (typeof su === 'string') { log([[su, 'er']]); setStatus({ text: 'Check the settings', p: null, kind: 'er' }); return; }
    stopRef.current = false; setRunning(true);
    try {
      let bridge;
      if (su.lang === 'py') {
        const first = !pyReady(), t0 = performance.now();
        setStatus({ text: first ? 'Loading Python…' : 'Starting…', p: null });
        const host = await python(su.libs);
        if (first) log([[`Python ready in ${((performance.now() - t0) / 1000).toFixed(1)} s`, 'pr']]);
        const err = pyCheck(host, su.code);
        if (err) { log([[err, 'er']]); showErr(err); setStatus({ text: 'Fix the error and run again', p: null, kind: 'er' }); return; }
        bridge = pyStrategy(host, su.code);
      } else {
        const err = jsCheck(su.code);
        if (err) { log([[err, 'er']]); showErr(err); setStatus({ text: 'Fix the error and run again', p: null, kind: 'er' }); return; }
        bridge = jsStrategy(su.code);
      }
      setStatus({ text: 'Preparing the market data…', p: 0 });
      const series = await seriesFor(su.market, f => setStatus({ text: 'Preparing the market data…', p: f }));
      const tf = parseTF(su.tf)!;
      const sim: SimRun | null = su.prop ? { sim: null, cfg: su.prop.cfg } : null;
      setStatus({ text: 'Running…', p: 0 });
      const r = await runBacktest({ series, from: su.t0, to: su.t1, tf, mode: su.mode, balance: su.balance, qty: su.qty, costs: su.costs, overrides: o.overrides || undefined,
        rules: sim && su.prop ? simRules(su.prop.cfg, su.prop.rebuy, su.prop.maxEvals, sim) : undefined },
        bridge, { log, stopped: () => stopRef.current, slice: async p => { setStatus({ text: p.status, p: p.done }); await yieldTask(); } });
      if (sim?.sim) log([[sim.sim.summaryLine(), sim.sim.stats().take >= 0 ? 'ok' : 'er']]);
      const v: RunView = { r, setup: su, overrides: o.overrides || null, sim, tf: su.tf };
      setStatus(r.stopped ? { text: 'Stopped', p: null } : r.ended ? { text: 'Ended: the account failed', p: null, kind: 'er' } : r.fail ? { text: 'Stopped by an error in the strategy', p: null, kind: 'er' } : { text: 'Done', p: null, kind: 'ok' });
      if (r.fail) showErr(r.fail);
      if (!r.fail || r.account.hist.length) setView(v);
      if (!r.fail && !r.ended) { if (o.chart) await showOnChart(v); else setTab('results'); }
    } catch (e) {
      log([[(e as Error).message, 'er']]); setStatus({ text: 'Could not run', p: null, kind: 'er' });
    } finally { setRunning(false); }
  }
  /** the run as a replay session: the same market and dates, its account, the tape at the run's end */
  async function showOnChart(v: RunView) {
    const r = v.r, a = r.account, su = v.setup;
    try {
      onBusy({ text: 'Opening the run on the chart', p: 0 });
      const s = await seriesFor(su.market), sym = s.inst.sym, endI = r.start + r.bars;
      const tf = parseTF(v.tf)!, name = `${su.name}${v.overrides ? ` (${optLabel(v.overrides)})` : ''} · Automated`;
      const propSetup = v.sim?.sim ? { sim: v.sim.cfg } : null;
      await onShow({ name, start: r.from, balance: a.start, risk: pref('risk', 200), tf: v.tf, markets: [su.market], prop: propSetup },
        { v: 2, simTime: endI < s.n ? s.t[endI] : s.t[s.n - 1] + s.base, active: sym, speed: pref('speed', 60), tf, feeds: [{ sym, at: endI < s.n ? s.t[endI] : null }],
          account: a.state(), journal: [], drawings: [], prop: propSetup && v.sim?.sim ? { setup: propSetup, state: v.sim.sim.state() } : null });
    } catch (e) { onToast((e as Error).message, 'err'); }
    finally { onBusy(null); }
  }
  /** Use in code: the settings written into the strategy (the editor's, or the one saved under that name) */
  async function useInCode(name: string, lg: Lang, docCode: string, combo: Record<string, Setting>) {
    const s0 = flushCode(), base = s0[name]?.code ?? docCode;
    try {
      const r = lg === 'py' ? pySetValues(await python(), base, combo) : jsApply(base, combo);
      if ('error' in r) return onToast(r.error, 'err');
      const s = { ...s0, [name]: { code: r.code, lang: lg } }; storeStrats(s);
      set({ name }); setCode(r.code);
      onToast(`${optLabel(combo)} written into “${name}”.`, 'up');
    } catch (e) { onToast((e as Error).message, 'err'); }
  }

  const edit = () => { if (view && view.setup.name in strats && view.setup.name !== cur) pick(view.setup.name); setTab('code'); };
  const tabs: Array<[Tab, string, string]> = [['list', 'Strategies', 'mo'], ['code', 'Code', ''], ['run', 'Run', 'mo'], ['results', 'Results', ''], ['opt', 'Optimize', ''], ['rob', 'Robustness', '']];
  const codeView = tab === 'list' || tab === 'code' || tab === 'run';
  const nLines = code.split('\n').length;
  const summary = (code.split('\n').find(l => /^\s*(#|\/\/)/.test(l)) || '').replace(/^\s*(#|\/\/)\s*/, '').slice(0, 140) || 'Show the code';
  return (
    <div className="page bt" style={hidden ? { display: 'none' } : undefined}>
      <header className="ctx bt-head">
        <b style={{ fontSize: 15 }}>Backtest</b>
        <nav className="tabs" style={{ border: 0, padding: 0 }}>{tabs.map(([k, l, c]) => <button key={k} className={(tab === k || (k === 'code' && codeView && !phone()) ? 'on ' : '') + c} onClick={() => setTab(k)}>{l}</button>)}</nav>
        <span className="spacer" />
        {running ? <button className="btn sm danger" onClick={() => { stopRef.current = true; }}>Stop</button>
          : <button className="btn sm primary bt-runbtn" onClick={() => run()}>Run backtest</button>}
      </header>
      {codeView && <div className="bt-work" data-mv={tab}>
        <aside className="bt-list" aria-label="Strategies">
          <div className="bt-listhead" ref={newRef}><b>Strategies</b>
            <button className="btn sm" aria-haspopup="menu" aria-expanded={newMenu} onClick={() => setNewMenu(!newMenu)}><IPlus width={13} height={13} /> New</button>
            {newMenu && <div className="pop menu bt-newmenu" role="menu">
              <h5>Start from</h5>
              {Object.entries(TEMPLATES).map(([k, t]) => <button key={k} role="menuitem" onClick={() => addNew(k)}>{k.replace(' (JavaScript)', '')}<span>{t.lang === 'py' ? 'Python' : 'JavaScript'}</span></button>)}
            </div>}
          </div>
          <div className="bt-items">
            {Object.entries(strats).map(([k, s]) => <button key={k} className={'bt-item' + (k === cur ? ' on' : '')} onClick={() => pick(k)}><span className="nm">{k}</span><span className={'tag ' + s.lang}>{s.lang === 'py' ? 'Py' : 'JS'}</span></button>)}
          </div>
          <p className="muted bt-hint">Strategies are saved as you type. Python strategies can use numpy (and pandas); JavaScript ones run faster.</p>
        </aside>
        <div className="bt-main">
          <div className="page-in bt-mainin">
            <div className="bt-codehead">
              {renaming ? <input className="in ui" autoFocus defaultValue={cur} aria-label="Strategy name" style={{ height: 34, maxWidth: 320 }} onBlur={e => rename(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') rename((e.target as HTMLInputElement).value); if (e.key === 'Escape') setRenaming(false); }} />
                : <h1 className="bt-name" title="Double-click to rename" onDoubleClick={() => setRenaming(true)}>{cur}</h1>}
              <span className="tag" style={{ background: 'var(--hover)' }}>{lang === 'py' ? 'Python' : 'JavaScript'}</span>
              <span className="spacer" />
              <button className="btn sm" title="How to write a strategy, and everything ctx can do" onClick={() => openGuide(lang === 'js' ? 'st-js' : 'st-api')}>Guide</button>
              <button className="btn sm" onClick={() => setRenaming(true)}>Rename</button>
              {confirmDel ? <><button className="btn sm danger" onClick={remove}>Delete it</button><button className="btn sm" onClick={() => setConfirmDel(false)}>Keep it</button></>
                : <button className="ib" aria-label={`Delete ${cur}`} title="Delete this strategy" onClick={() => setConfirmDel(true)}><ITrash width={16} height={16} /></button>}
            </div>
            {confirmDel && <div className="warnline">Delete “{cur}”? Its code is gone for good.</div>}
            <section className="card bt-code bt-fold" aria-label="Code" data-open={codeOpen || isPhone}>
              <button className="bt-foldhead" aria-expanded={codeOpen || isPhone} onClick={() => setCodeOpen(!codeOpen)}>
                <IChev className="chev" /><b>Code</b>
                {!codeOpen && !isPhone && <span className="muted bt-sum">{summary}</span>}
                <span className="spacer" /><span className="muted bt-meta">{lang === 'py' ? 'Python' : 'JavaScript'} · {nLines} lines</span>
              </button>
              {(codeOpen || isPhone) && <>
                <Editor code={code} lines={nLines} height={isPhone ? null : codeH} indent={lang === 'py' ? '    ' : '  '} opener={lang === 'py' ? /:\s*(#.*)?$/ : /[{(\[]\s*$/} onChange={editCode} onRun={() => run()} goto={goto} />
                {!isPhone && <div className="bt-grip" role="separator" aria-orientation="horizontal" aria-label="Drag to resize the code" title="Drag to make the code taller or shorter"
                  onPointerDown={e => { e.preventDefault(); const y0 = e.clientY, h0 = codeH;
                    const mv = (ev: PointerEvent) => setCodeH(Math.max(140, Math.min(1400, Math.round(h0 + ev.clientY - y0))));
                    const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); setCodeH(h => { setPref('btCodeH', h); return h; }); };
                    addEventListener('pointermove', mv); addEventListener('pointerup', up); }} />}
              </>}
            </section>
            <div className="bt-run" aria-label="Run settings">
              <section className="card bt-runcard">
                <h3>Run</h3>
                <div className="bt-form">
                  <label className="field bt-wide">Market<select className="in ui" aria-label="Market" value={P.data.kind === 'practice' ? 'practice:' + P.data.sym : 'ds:' + P.data.id} onChange={e => chooseData(e.target.value)}>
                    <option value="practice:NQ">Practice Nasdaq-100 (NQ)</option><option value="practice:ES">Practice S&amp;P 500 (ES)</option>
                    {P.data.kind === 'dataset' && !datasets.some(d => d.id === (P.data as { id: string }).id) && <option value={'ds:' + P.data.id}>{P.data.name}</option>}
                    {datasets.map(d => <option key={d.id} value={'ds:' + d.id}>{d.name}</option>)}
                  </select></label>
                  <label className="field">From<input className="in" type="date" aria-label="From" value={P.from} min={ymd(P.range[0])} max={ymd(P.range[1])} onChange={e => set({ from: e.target.value })} /></label>
                  <label className="field">To<input className="in" type="date" aria-label="To" value={P.to} min={ymd(P.range[0])} max={ymd(P.range[1])} onChange={e => set({ to: e.target.value })} /></label>
                  <label className="field"><span className="lbl">Candles <span className="q" title="The strategy's on_bar runs when each candle of this size closes.">?</span></span>
                    <select className="in ui" aria-label="Candles" value={tfs.includes(P.tf) ? P.tf : tfs[0]} onChange={e => set({ tf: e.target.value })}>{tfs.map(t => <option key={t} value={t}>{t}</option>)}</select></label>
                  <div className="field bt-wide"><span className="lbl">The strategy runs <span className="q" title="At bar close: on_bar when each candle closes (fast). Every tick: on_tick on every simulated price move too, for trailing stops and the like (slower).">?</span></span>
                    <span className="seg full"><button className={P.mode === 'bar' ? 'on' : ''} onClick={() => set({ mode: 'bar' })}>At bar close</button><button className={P.mode === 'tick' ? 'on' : ''} onClick={() => set({ mode: 'tick' })}>Every tick</button></span></div>
                  {lang === 'py' && <div className="field bt-wide">Libraries<span className="seg full"><button className={P.libs === 'numpy' ? 'on' : ''} onClick={() => set({ libs: 'numpy' })}>numpy</button><button className={P.libs === 'pandas' ? 'on' : ''} onClick={() => set({ libs: 'pandas' })}>numpy + pandas</button></span></div>}
                  <label className="field">Starting balance<span className="suffix"><input className="in" inputMode="numeric" aria-label="Starting balance" disabled={P.propOn} value={P.propOn ? prop.size : P.balance} onChange={e => set({ balance: Math.max(100, parseFloat(e.target.value) || 0) })} /><span>$</span></span></label>
                  <label className="field"><span className="lbl">Order size <span className="q" title="Contracts per order when the strategy gives no size (ctx.default_qty).">?</span></span><input className="in" inputMode="decimal" aria-label="Order size" value={P.qty} onChange={e => set({ qty: Math.max(0.0001, parseFloat(e.target.value) || 1) })} /></label>
                  <label className="field">Commission<span className="suffix"><input className="in" inputMode="decimal" aria-label="Commission" value={costs.comm} onChange={e => set({ costs: { ...costs, comm: Math.max(0, parseFloat(e.target.value) || 0) } })} /><span>$ a side</span></span></label>
                  <label className="field"><span className="lbl">Spread <span className="q" title="Buys pay this many ticks above the price.">?</span></span><span className="suffix"><input className="in" inputMode="numeric" aria-label="Spread" value={costs.spreadTicks} onChange={e => set({ costs: { ...costs, spreadTicks: Math.max(0, parseInt(e.target.value) || 0) } })} /><span>ticks</span></span></label>
                  <label className="field"><span className="lbl">Slippage <span className="q" title="Market orders, closes and stop fills are this many ticks worse.">?</span></span><span className="suffix"><input className="in" inputMode="numeric" aria-label="Slippage" value={costs.slipTicks} onChange={e => set({ costs: { ...costs, slipTicks: Math.max(0, parseInt(e.target.value) || 0) } })} /><span>ticks</span></span></label>
                </div>
                <span className="muted" style={{ fontSize: 12 }}>{inst.sym}: ${inst.pv} a point, ticks of {+inst.tick.toPrecision(6)}</span>
              </section>
              <section className="bt-propcard">
                <PropSetupCard value={{ ...prop, on: P.propOn }} onChange={c => set({ propOn: c.on, prop: c })} />
                {P.propOn && <div className="card bt-rebuy">
                  <label className="chk"><input type="checkbox" checked={P.rebuy} onChange={e => set({ rebuy: e.target.checked })} />Buy a new evaluation when one fails</label>
                  {P.rebuy && <label className="field">At most this many evaluations (blank: no limit)<input className="in" inputMode="numeric" value={P.maxEvals || ''} onChange={e => set({ maxEvals: Math.max(0, parseInt(e.target.value) || 0) })} /></label>}
                  <span className="muted" style={{ fontSize: 12 }}>Each new evaluation costs {money(prop.fee || 0)} (the fee above).</span>
                </div>}
              </section>
              <div className="bt-runbar">
                {running ? <button className="btn danger" onClick={() => { stopRef.current = true; }}>Stop</button>
                  : <button className="btn primary" title={`Run backtest (${MOD}+Enter in the code)`} onClick={() => run()}>Run backtest</button>}
                <Status status={status} />
              </div>
            </div>
            <Console lines={lines.current} status={status} running={running} open={consOpen || isPhone} onToggle={() => setConsOpen(!consOpen)} onClear={clearLog} />
          </div>
        </div>
      </div>}
      {tab === 'results' && <Results view={view} running={running} onShow={() => view && showOnChart(view)} onEdit={edit} onRun={() => run()} onToast={onToast} />}
      <OptimizePanel active={tab === 'opt' || tab === 'rob'} which={tab === 'rob' ? 'rob' : 'opt'} code={code} lang={lang} name={cur} setup={setupNow} busy={running}
        onUse={useInCode} onShow={(su, combo) => run({ setup: su, overrides: combo, chart: true })} onToast={onToast}
        openId={openOptim} onOpened={onOptimOpened} goRob={() => setTab('rob')} />
    </div>
  );
}

/* ---- the code editor: a plain text area with line numbers; Tab indents, Enter keeps the indent ---- */
function Editor({ code, lines, height, indent, opener, onChange, onRun, goto }: { code: string; lines: number; height: number | null; indent: string; opener: RegExp;
  onChange: (c: string) => void; onRun: () => void; goto: { line: number; n: number } | null }) {
  const ta = useRef<HTMLTextAreaElement>(null), gut = useRef<HTMLDivElement>(null);
  // an error's line: selected and scrolled into view
  useEffect(() => {
    const el = ta.current; if (!el || !goto) return;
    const ls = el.value.split('\n'), k = Math.max(0, Math.min(ls.length - 1, goto.line - 1));
    let a = 0; for (let i = 0; i < k; i++) a += ls[i].length + 1;
    el.focus({ preventScroll: true }); el.setSelectionRange(a, a + ls[k].length);
    const lh = parseFloat(getComputedStyle(el).lineHeight) || 19;
    el.scrollTop = Math.max(0, k * lh - el.clientHeight / 3);
    if (gut.current) gut.current.scrollTop = el.scrollTop;
    el.closest('.bt-code')?.scrollIntoView({ block: 'nearest' });
  }, [goto]);
  const insert = (text: string) => {
    const el = ta.current!; el.focus();
    // execCommand keeps the browser's undo; setRangeText where it is gone
    if (!document.execCommand('insertText', false, text)) { el.setRangeText(text, el.selectionStart, el.selectionEnd, 'end'); onChange(el.value); }
  };
  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); onRun(); return; }
    if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      const a = el.selectionStart, b = el.selectionEnd, v = el.value;
      if (a === b && !e.shiftKey) return insert(indent);
      // indent or outdent the selected lines
      const s = v.lastIndexOf('\n', a - 1) + 1, end = b > a && v[b - 1] === '\n' ? b - 1 : b;
      const block = v.slice(s, end), out = block.split('\n').map(l => e.shiftKey ? l.replace(new RegExp(`^( {1,${indent.length}}|\\t)`), '') : indent + l).join('\n');
      el.setSelectionRange(s, end); insert(out); el.setSelectionRange(s, s + out.length);
    } else if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const a = el.selectionStart, v = el.value, line = v.slice(v.lastIndexOf('\n', a - 1) + 1, a);
      const lead = (line.match(/^[ \t]*/) || [''])[0];
      if (!lead && !opener.test(line)) return;
      e.preventDefault(); insert('\n' + lead + (opener.test(line) ? indent : ''));
    }
  };
  return (
    <div className="bt-editor" style={height ? { height } : undefined}>
      <div className="bt-gutter" ref={gut} aria-hidden="true">{Array.from({ length: lines }, (_, i) => <div key={i}>{i + 1}</div>)}</div>
      <textarea ref={ta} className="bt-ta" aria-label="Strategy code" value={code} spellCheck={false} autoCorrect="off" autoCapitalize="off" autoComplete="off" wrap="off"
        onChange={e => onChange(e.target.value)} onKeyDown={onKey} onScroll={e => { if (gut.current) gut.current.scrollTop = e.currentTarget.scrollTop; }} />
    </div>
  );
}

function Status({ status }: { status: { text: string; p: number | null; kind?: string } }) {
  return (
    <div className="bt-status" role="status">
      <span className={status.kind === 'er' ? 'down' : status.kind === 'ok' ? 'up' : 'muted'}>{status.text}</span>
      {status.p != null && <><div className="bar" style={{ flex: 1 }}><i style={{ width: `${(status.p * 100).toFixed(1)}%` }} /></div><span className="muted num">{Math.round(status.p * 100)}%</span></>}
    </div>
  );
}
function Console({ lines, status, running, open, onToggle, onClear }: { lines: LogLine[]; status: { text: string; p: number | null; kind?: string }; running: boolean;
  open: boolean; onToggle: () => void; onClear: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { const b = box.current; if (b) b.scrollTop = b.scrollHeight; });
  return (
    <section className="card bt-cons bt-fold" aria-label="Console" data-open={open}>
      <div className="bt-conshead">
        <button className="bt-foldhead" aria-expanded={open} onClick={onToggle}><IChev className="chev" /><b>Console</b>{!open && lines.length > 0 && <span className="muted bt-sum">{lines.length} line{lines.length === 1 ? '' : 's'}</span>}</button>
        <span className="spacer" /><Status status={status} />{running && <span className="muted" style={{ fontSize: 11.5 }}>running</span>}
        {open && lines.length > 0 && !running && <button className="btn sm" onClick={onClear}>Clear</button>}
      </div>
      {open && <div className="bt-lines" ref={box} aria-label="Console output" aria-live="off">
        {lines.length ? lines.map((l, i) => <div key={i} className={l[1]}>{l[0] || ' '}</div>) : <div className="muted">print() output, errors and the run's summary show here.</div>}
      </div>}
    </section>
  );
}

/** closes a menu on a press outside its box (the box holds its button too) and on Escape */
function useDismiss(ref: React.RefObject<HTMLElement | null>, open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const down = (e: Event) => { if (ref.current && !ref.current.contains(e.target as Node)) close(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    addEventListener('mousedown', down); addEventListener('touchstart', down); addEventListener('keydown', key, true);
    return () => { removeEventListener('mousedown', down); removeEventListener('touchstart', down); removeEventListener('keydown', key, true); };
  }, [open]);
}

/* ---- results ---- */
function EqCurve({ eq, start }: { eq: Array<{ time: number; value: number }>; start: number }) {
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (eq.length < 2) return;
    const up = eq[eq.length - 1].value >= start, col = up ? C.up : C.down;
    const ch = createChart(el.current!, { autoSize: true, layout: { background: { color: 'transparent' }, textColor: C.text, fontSize: 10 }, grid: { vertLines: { visible: false }, horzLines: { color: C.grid } },
      rightPriceScale: { borderVisible: false }, timeScale: { visible: false, borderVisible: false }, handleScroll: false, handleScale: false, crosshair: { horzLine: { visible: false } } });
    const s = ch.addAreaSeries({ lineColor: col, topColor: col + '33', bottomColor: col + '00', lineWidth: 2, priceLineVisible: false, lastValueVisible: true });
    // evenly spaced, as the classic curve (the market is closed half the time)
    s.setData(eq.map((p, i) => ({ time: (i + 1) as UTCTimestamp, value: p.value })));
    s.createPriceLine({ price: start, color: C.text, lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: false, title: '' });
    ch.timeScale().fitContent();
    return () => ch.remove();
  }, [eq, start]);
  return eq.length < 2 ? <div className="empty">No equity curve yet.</div> : <div className="eqchart bt-eq" ref={el} />;
}
function Results({ view, running, onShow, onEdit, onRun, onToast }: { view: RunView | null; running: boolean; onShow: () => void; onEdit: () => void; onRun: () => void; onToast: (m: string, k?: string) => void }) {
  if (!view) return <div className="page-in"><div className="emptycard"><b>No results yet</b><p>Run a strategy and its trades, equity curve and numbers show here.</p>
    <button className="btn primary" disabled={running} onClick={onRun}>Run backtest</button></div></div>;
  const { r, setup: su } = view, a = r.account, st = r.stats, prec = su.data.kind === 'practice' ? PRACTICE[su.data.sym].prec : su.data.inst.prec;
  const sim = view.sim?.sim, ss = sim?.stats();
  const tiles: Array<[string, string, string?]> = sim && ss ? [
    ['Your result', smoney(ss.take), ss.take >= 0 ? 'up' : 'down'], ['Payouts to you', money(ss.income)], ['Evaluation fees', money(ss.fees)],
    ['Evaluations', `${ss.attempts} · ${ss.passed} passed`], ['Trades', `${st.trades}${st.open ? ` +${st.open}` : ''}`], ['Account now', sim.label()],
  ] : [
    ['Net P&L', smoney(st.net), st.net >= 0 ? 'up' : 'down'], ['Trades', `${st.trades}${st.open ? ` +${st.open}` : ''}`], ['Win rate', st.winRate == null ? '—' : st.winRate.toFixed(1) + '%'],
    ['Profit factor', st.pf === 'inf' ? '∞' : st.pf == null ? '—' : st.pf.toFixed(2)], ['Max drawdown', st.maxDD ? `${money(st.maxDD)} (${st.maxDDpct.toFixed(1)}%)` : '$0.00'],
    ['Avg trade', st.trades ? smoney(st.net / st.trades) : '—'],
  ];
  const shown = a.hist.slice(-500).reverse();
  const copy = async () => { try { await navigator.clipboard.writeText(tradesCsv(a.hist)); onToast(`Copied ${a.hist.length} trades as CSV: paste them into a spreadsheet.`, 'up'); } catch { onToast('Could not copy: the browser blocked the clipboard.', 'err'); } };
  return (
    <div className="page-in bt-results">
      <div className="bt-reshead">
        <div><h1 style={{ fontSize: 20 }}>{su.name}{view.overrides ? <span className="muted" style={{ fontWeight: 500 }}> ({optLabel(view.overrides)})</span> : null}</h1>
          <p className="lead" style={{ fontSize: 13 }}>{su.dataName}, {ymd(r.from)} to {ymd(r.to)} · {view.tf} candles · {su.mode === 'tick' ? 'every tick' : 'at bar close'} · {money(a.start)} start · {r.secs.toFixed(1)} s{r.stopped ? ' · stopped early' : ''}</p></div>
        <span className="spacer" />
        <div className="bt-acts">
          <button className="btn primary" disabled={running} onClick={onShow} title="Open this run as a replay session: its trades on the chart, and keep replaying from where it ended">Show on chart</button>
          <button className="btn" onClick={onEdit}>Edit and run again</button>
          <button className="btn" disabled={!a.hist.length} onClick={copy}>Copy trades (CSV)</button>
        </div>
      </div>
      <div className="bt-tiles">{tiles.map(([k, v, c]) => <div key={k} className="stat"><span>{k}</span><b className={c}>{v}</b></div>)}</div>
      {r.ended && <div className="warnline">{r.ended}</div>}
      <div className="bt-perf">
        <EqCurve eq={r.eq} start={a.start} />
        <div className="perf" style={{ padding: 0, display: 'block' }}><div className="sgrid">{[...statsRows(st), ...(sim ? sim.statRows() : [])].map(([k, v]) => <div key={k}><span>{k}</span><b>{v}</b></div>)}</div></div>
      </div>
      <div className="card bt-trades">
        {shown.length ? <table className="t"><thead><tr><th>#</th><th>Side</th><th>Size</th><th>Opened</th><th>Entry</th><th>Closed</th><th>Exit</th><th>Exit by</th><th className="r">Net P&amp;L</th></tr></thead>
          <tbody>{shown.map(h => <tr key={h.id + ':' + h.exitTime}>
            <td>{h.id}</td><td className={'ui ' + (h.side > 0 ? 'up' : 'down')}>{h.side > 0 ? 'LONG' : 'SHORT'}</td><td>{fmtQty(h.qty)}</td><td>{fmtDay(h.time)}</td><td>{h.entry.toFixed(prec)}</td>
            <td>{fmtDay(h.exitTime)}</td><td>{h.exit.toFixed(prec)}</td><td className="ui muted">{h.reason}</td><td className={'r ' + (h.net >= 0 ? 'up' : 'down')}>{smoney(h.net)}</td></tr>)}</tbody></table>
          : <div className="empty">No closed trades.</div>}
      </div>
      <p className="muted" style={{ fontSize: 12, margin: 0 }}>{a.hist.length > 500 ? `The latest 500 of ${a.hist.length} trades; Copy trades has them all. ` : ''}Show on chart opens the run as a replay session (saved to your Library), with its trades on the chart.</p>
    </div>
  );
}
