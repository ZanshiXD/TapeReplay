// A new session in three steps: the market (practice markets, or your own data from the Library), where the tape
// starts, and the account. Sensible choices are made already, so "Start session" works straight away.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { PRACTICE, PRACTICE_FROM, PRACTICE_TO, randomPracticeStart } from '../core/practice';
import { fmtClock, localToUtc, tzOffset } from '../core/time';
import { money } from '../core/account';
import { openDataset, MAX_BARS, sectionBars, type Opened } from '../core/library';
import { pickLabel } from '../core/data';
import type { DatasetMeta } from '../core/store';
import { ICheck, IPlus } from './icons';
import { store } from './appstore';
import { addData, fmtBars, fmtBase, fmtDay, joinFiles } from './library';
import { datasetInstrument, practiceSource, type MarketSource, type Opening } from './sessions';
import { pref, setPref } from './live';
import type { IndSpec } from '../core/indicators';
import { PropSetupCard, defaultProp } from './PropPanel';
import { Credit } from './SettingsPage';

const MARKETS = [
  { id: 'NQ', syms: ['NQ'], badge: 'NQ', cls: '', name: 'Practice Nasdaq-100', d: 'A busy futures market. Moves a lot, so trades play out quickly.', tag: 'Best to start' },
  { id: 'ES', syms: ['ES'], badge: 'ES', cls: ' b1', name: 'Practice S&P 500', d: 'Calmer than the Nasdaq, with bigger contracts.', tag: '' },
  { id: 'SMT', syms: ['NQ', 'ES'], badge: 'NQ+ES', cls: ' b3', name: 'Both, side by side', d: 'Two charts on one clock, to compare them (SMT divergence) and trade either.', tag: '' },
];
const NY = 'America/New_York';
const nyDate = (iso: string, hh: number, mm: number) => { const [y, m, d] = iso.split('-').map(Number); return localToUtc(NY, y, m - 1, d, hh, mm); };
const isoNY = (t: number) => { const d = new Date((t + tzOffset(NY, t)) * 1000); return d.toISOString().slice(0, 10); };
const SPANS: Array<[number, string]> = [[7, '1 week'], [30, '1 month'], [91, '3 months'], [182, '6 months'], [365, '1 year']];
const HISTS: Array<[number, string]> = [[1, '1 day'], [7, '1 week'], [30, '1 month']];
type CostMem = { pv?: number; comm: number; spread: number; slip: number };

export interface ResumeInfo { id: string; name: string; updated: number }

export function NewSessionPage({ onStart, onCancel, canCancel, onBusy, onToast, withData, resume, onResume, inds }: {
  onStart: (x: Opening) => void; onCancel: () => void; canCancel: boolean;
  onBusy: (b: { text: string; p: number } | null) => void; onToast: (m: string, k?: string) => void;
  withData?: DatasetMeta | null; resume?: ResumeInfo | null; onResume: (id: string) => void; inds: IndSpec[];
}) {
  const [step, setStep] = useState(1);
  const [kind, setKind] = useState<'practice' | 'data'>(withData ? 'data' : 'practice');
  const [mk, setMk] = useState('NQ');
  const [list, setList] = useState<DatasetMeta[]>([]);
  const [canPick, setCanPick] = useState(false);
  const [desktop, setDesktop] = useState(false);
  const [op, setOp] = useState<Opened | null>(null);
  const [pick, setPick] = useState('');
  const [op2, setOp2] = useState<Opened | null>(null);
  const [when, setWhen] = useState<'date' | 'random'>('date');
  const [date, setDate] = useState('2026-04-01');
  const [time, setTime] = useState('09:30');
  const [span, setSpan] = useState(30);
  const [hist, setHist] = useState(7);
  const [cont, setCont] = useState(false);
  const [balance, setBalance] = useState(50000);
  const [risk, setRisk] = useState(200);
  const [comm, setComm] = useState(2.1);
  const [spread, setSpread] = useState(1);
  const [slip, setSlip] = useState(1);
  const [pv, setPv] = useState(1);
  const [prop, setProp] = useState(defaultProp);
  const fileIn = useRef<HTMLInputElement>(null);

  const refresh = () => store.listDatasets().then(l => setList(l.sort((a, b) => (b.added || 0) - (a.added || 0)))).catch(() => {});
  useEffect(() => { refresh(); store.caps().then(c => { setCanPick(c.pick); setDesktop(store.kind === 'app' && !c.ios); }); }, []);
  useEffect(() => { if (withData) choose(withData); }, [withData]); // eslint-disable-line react-hooks/exhaustive-deps

  /** opens a data file to learn its dates, contracts and instrument */
  async function choose(m: DatasetMeta, second = false) {
    try {
      onBusy({ text: `Opening ${m.name}`, p: 0 });
      const o = await openDataset(store, m, null, (p, s) => onBusy({ text: `${m.name}: ${s}`, p }));
      if (second) { setOp2(o); return; }
      setOp(o); setPick(o.pick); setKind('data'); setOp2(null);
      const inst = datasetInstrument(m, o.pick, o.contracts, o.prec);
      const mem = pref<Record<string, CostMem>>('costs', {})[inst.sym];
      setPv(mem?.pv ?? inst.pv); setComm(mem?.comm ?? (inst.pv > 1 ? 2.1 : 0)); setSpread(mem?.spread ?? inst.spreadTicks); setSlip(mem?.slip ?? 0);
      // a start a little way in, so there is history on the chart
      const t = o.index ? Math.max(o.from + 7 * 86400, o.to - 45 * 86400) : o.from + Math.max(86400, (o.to - o.from) * 0.3);
      setDate(isoNY(Math.min(t, o.to - 3600)));
      if (o.base >= 86400) setTime('00:00');
    } catch (e) { onToast(`${m.name}: ${(e as Error).message}`, 'err'); }
    finally { onBusy(null); }
  }
  async function add(from: { file: File } | 'pick') {
    try {
      let src: { file: File } | { picked: NonNullable<Awaited<ReturnType<typeof store.pick>>> };
      if (from === 'pick') { const p = await store.pick(); if (!p) return; src = { picked: p }; } else src = from;
      const nm = 'file' in src ? src.file.name : src.picked.name;
      onBusy({ text: `Adding ${nm}`, p: 0 });
      const m = await addData(store, src, (p, s) => onBusy({ text: `${nm}: ${s}`, p }));
      await refresh(); onBusy(null); await choose(m);
    } catch (e) { onBusy(null); onToast((e as Error).message, 'err'); }
  }

  const m = MARKETS.find(x => x.id === mk)!;
  const [hh, mm] = time.split(':').map(Number);
  const dataRange = op ? [op.from, op.to] : [PRACTICE_FROM + 7 * 86400, PRACTICE_TO - 86400];
  const start = when === 'random' ? 'random' as const : nyDate(date, hh || 0, mm || 0);
  const okDate = start === 'random' || (start > dataRange[0] && start < dataRange[1]);
  const isData = kind === 'data' && op;
  const tooBig = !!(isData && op.index && start !== 'random' && sectionBars(op.index, start - hist * 86400, cont ? start + 31 * 86400 : start + span * 86400) > MAX_BARS);
  const instr = isData ? datasetInstrument(op.meta, pick, op.contracts, op.prec, { pv }) : null;
  const ready = kind === 'practice' || !!op;
  const steps = ['Market', 'Start', 'Account'];
  const dayStart = `${String(pref('dayStart', 18)).padStart(2, '0')}:00`;

  function go() {
    let t = start;
    if (t === 'random') {
      if (!isData) t = randomPracticeStart();
      else { const a = op.from + Math.max(hist, 2) * 86400, b = op.to - 86400; const day = a + Math.random() * Math.max(0, b - a); t = nyDate(isoNY(day), 9, 30); }
    }
    const costs = { comm, spreadTicks: spread, slipTicks: slip };
    let markets: MarketSource[], name: string;
    if (!isData) {
      markets = m.syms.map(s => practiceSource(s, t - 4 * 86400, t + 8 * 86400, costs));
      name = m.id === 'SMT' ? 'SMT practice' : m.name;
    } else {
      const window = (o: Opened) => o.index ? { from: t - hist * 86400, to: cont ? Math.min(o.to, t + 31 * 86400) : t + span * 86400 } : null;
      const src = (o: Opened, p: string, inst: ReturnType<typeof datasetInstrument>): MarketSource => ({ kind: 'dataset', id: o.meta.id, name: o.meta.name, pick: p, inst, window: window(o), cont: o.index && cont ? { hist } : null });
      markets = [src(op, pick, { ...instr!, ...costs, pv })];
      if (op2) { const i2 = datasetInstrument(op2.meta, op2.pick, op2.contracts, op2.prec); markets.push(src(op2, op2.pick, { ...i2, ...costs, spreadTicks: i2.spreadTicks ? spread : 0 })); }
      const mem = pref<Record<string, CostMem>>('costs', {}); mem[instr!.sym] = { pv, comm, spread, slip }; setPref('costs', mem);
      name = `${markets.map(x => x.kind === 'dataset' ? x.inst.sym : '').join(' + ')} from ${fmtDay(t)}`;
    }
    if (prop.on) setPref('propLast', prop);
    onStart({ name: prop.on ? `${name} · ${prop.preset || 'prop challenge'}` : name, start: t, balance: prop.on ? prop.size : balance, risk, tf: pref('tf', '5m'), inds, markets, prop: prop.on ? { sim: { ...prop, resetNY: pref('dayStart', 18) } } : null });
  }

  const card = (on: boolean, onClick: () => void, children: ReactNode, key?: string) => <button key={key} className={'choice' + (on ? ' on' : '')} onClick={onClick}>{children}</button>;
  return (
    <div className="page">
      <header className="ctx" style={{ gap: 14 }}>
        {canCancel && <button className="btn sm" onClick={onCancel}>Back</button>}
        <b style={{ fontSize: 15 }}>New session</b>
        <span className="spacer" />
        <nav className="steps" aria-label="Steps">
          {steps.map((l, i) => <button key={l} className={step === i + 1 ? 'on' : step > i + 1 ? 'done' : ''} disabled={!ready && i > 0} onClick={() => setStep(i + 1)}><i>{step > i + 1 ? <ICheck width={12} height={12} /> : i + 1}</i>{l}</button>)}
        </nav>
      </header>
      <div className="page-in" style={{ flexDirection: 'row', gap: 32, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <main style={{ flex: '999 1 560px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 22 }}>
          {step === 1 && <>
            {resume && <div className="resume"><span className="t"><b>Pick up where you left off</b><span className="muted" style={{ fontSize: 12.5 }}>{resume.name}</span></span><button className="btn primary" onClick={() => onResume(resume.id)}>Continue</button></div>}
            <div><h1>What do you want to replay?</h1><p className="lead">Practice markets are generated and act like the real ones. Or replay your own data: CSV or Databento files.</p></div>
            <div className="choices">
              {MARKETS.map(x => card(kind === 'practice' && mk === x.id, () => { setKind('practice'); setMk(x.id); }, <>
                <span style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}><span className={'badge' + x.cls}>{x.badge}</span>{x.tag && <span className="tag" style={{ background: 'var(--up-soft)', color: 'var(--up-fg)' }}>{x.tag}</span>}</span>
                <b>{x.name}</b><span className="d">{x.d}</span></>, x.id))}
            </div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}><h2 className="h2">Your data</h2><span className="muted" style={{ fontSize: 12.5 }}>From your Library</span></div>
            <input ref={fileIn} type="file" multiple hidden accept=".csv,.txt,.tsv,.dbn,.zst,text/csv" onChange={e => { const f = e.target.files; if (f && f.length) add({ file: joinFiles([...f]) }); e.target.value = ''; }} />
            <div className="dslist">
              {list.map(d => (
                <button key={d.id} className={'dsitem' + (kind === 'data' && op?.meta.id === d.id ? ' on' : '')} onClick={() => choose(d)}>
                  <span className="badge b2">{(d.name.match(/[A-Za-z0-9]+/) || ['DATA'])[0].slice(0, 5).toUpperCase()}</span>
                  <span className="t"><b>{d.name}</b><span>{[fmtBars(d.bars), fmtBase(d.base), d.from ? `${fmtDay(d.from)} → ${fmtDay(d.to)}` : ''].filter(Boolean).join(' · ')}</span></span>
                </button>
              ))}
              <button className="dsitem" style={{ borderStyle: 'dashed' }} onClick={() => canPick ? add('pick') : fileIn.current?.click()}><IPlus width={16} height={16} /><span className="t"><b>Add a data file</b><span>CSV with time, open, high, low, close (volume optional), or Databento DBN</span></span></button>
            </div>
            {isData && op.C && op.C.list.length > 1 && <label className="field" style={{ maxWidth: 420 }}>Contract
              <select className="in ui" value={pick} onChange={e => setPick(e.target.value)}>
                <option value="*auto">Continuous: follows the busiest contract each day</option>
                {op.C.list.map(c => <option key={c.sym} value={c.sym}>{c.sym} · {fmtBars(c.rows)}</option>)}
              </select></label>}
            {isData && list.length > 1 && <label className="field" style={{ maxWidth: 420 }}>Compare with a second market (optional)
              <select className="in ui" value={op2?.meta.id || ''} onChange={e => { const d = list.find(x => x.id === e.target.value); if (d) choose(d, true); else setOp2(null); }}>
                <option value="">No second market</option>
                {list.filter(d => d.id !== op.meta.id).map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select></label>}
          </>}
          {step === 2 && <>
            <div><h1>Where should the tape start?</h1><p className="lead">The chart shows the history up to this moment. Everything after it stays hidden until you play it.</p></div>
            <div className="choices">
              {card(when === 'date', () => setWhen('date'), <><b>A date I pick</b><span className="d">Replay a day you want to study.</span></>)}
              {card(when === 'random', () => setWhen('random'), <><b>A random day</b><span className="d">No hindsight: you won't know what's coming.</span></>)}
            </div>
            {when === 'date' && <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
              <label className="field" style={{ width: 220 }}>Date<input className="in" type="date" value={date} min={isoNY(dataRange[0])} max={isoNY(dataRange[1])} onChange={e => setDate(e.target.value)} /></label>
              <label className="field" style={{ width: 160 }}>Time (New York)<input className="in" type="time" value={time} onChange={e => setTime(e.target.value)} /></label>
              <div className="field">Quick picks<span className="seg">
                <button className={time === '09:30' ? 'on' : ''} onClick={() => setTime('09:30')}>New York open</button>
                <button className={time === '03:00' ? 'on' : ''} onClick={() => setTime('03:00')}>London open</button>
                <button className={time === dayStart ? 'on' : ''} title="When a trading day starts (see Settings)" onClick={() => setTime(dayStart)}>Day start</button>
              </span></div>
            </div>}
            {isData && op.index && <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
              <label className="field" style={{ width: 220 }}>History before the start<select className="in ui" value={hist} onChange={e => setHist(+e.target.value)}>{HISTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
              <label className="field" style={{ width: 240 }}>How much to replay<select className="in ui" value={cont ? -1 : span} onChange={e => { const v = +e.target.value; setCont(v < 0); if (v > 0) setSpan(v); }}>
                {SPANS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}{desktop && <option value={-1}>To the end of the data</option>}</select></label>
            </div>}
            {!okDate && <div className="warnline">{isData ? `This data runs from ${fmtDay(op.from)} to ${fmtDay(op.to)}. Pick a date in between.` : 'Practice data runs from January 2019 to September 2026. Pick a date in between.'}</div>}
            {tooBig && <div className="warnline">That is too much to load at once. Pick less history or a shorter span.</div>}
          </>}
          {step === 3 && <>
            <div><h1>Account and costs</h1><p className="lead">Play money. Costs are filled in for {isData ? instr!.name : m.syms.join(' and ')}; change anything that doesn't match your broker.</p></div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 16, maxWidth: 760 }}>
              <label className="field">Starting balance<span className="suffix"><input className="in" inputMode="numeric" disabled={prop.on} title={prop.on ? 'The challenge sets the account size' : undefined} value={prop.on ? prop.size : balance} onChange={e => setBalance(Math.max(100, parseInt(e.target.value) || 0))} /><span>dollars</span></span></label>
              <label className="field"><span className="lbl">Risk per trade <span className="q" title="What you lose if a trade hits its stop. The order ticket sizes trades from it.">?</span></span><span className="suffix"><input className="in" inputMode="numeric" value={risk} onChange={e => setRisk(Math.max(1, parseInt(e.target.value) || 0))} /><span>dollars</span></span></label>
            </div>
            <div className="card" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 760 }}>
              <b>Costs per contract</b>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 14 }}>
                {isData && <label className="field"><span className="lbl">Point value <span className="q" title="Dollars made or lost per contract when the price moves by 1.0.">?</span></span><span className="suffix"><input className="in" inputMode="decimal" value={pv} onChange={e => setPv(Math.max(1e-9, parseFloat(e.target.value) || 0))} /><span>$ a point</span></span></label>}
                <label className="field">Commission per side<span className="suffix"><input className="in" inputMode="decimal" value={comm} onChange={e => setComm(Math.max(0, parseFloat(e.target.value) || 0))} /><span>dollars</span></span></label>
                <label className="field"><span className="lbl">Spread <span className="q" title="Buys pay this much above the last price.">?</span></span><span className="suffix"><input className="in" inputMode="numeric" value={spread} onChange={e => setSpread(Math.max(0, parseInt(e.target.value) || 0))} /><span>ticks</span></span></label>
                <label className="field"><span className="lbl">Slippage on stops <span className="q" title="Stop orders and stop losses fill this much worse than their price.">?</span></span><span className="suffix"><input className="in" inputMode="numeric" value={slip} onChange={e => setSlip(Math.max(0, parseInt(e.target.value) || 0))} /><span>ticks</span></span></label>
              </div>
              <span className="muted" style={{ fontSize: 12 }}>{isData ? `${instr!.sym}: $${pv} per point, ticks of ${+instr!.tick.toPrecision(6)}` : m.syms.map(sm => `${sm}: $${PRACTICE[sm].pv} per point, ticks of ${PRACTICE[sm].tick}`).join(' · ')}</span>
            </div>
            <PropSetupCard value={prop} onChange={setProp} />
          </>}
          <div style={{ display: 'flex', gap: 10 }}>
            {step > 1 && <button className="btn" style={{ height: 42 }} onClick={() => setStep(step - 1)}>Back</button>}
            {step < 3 ? <button className="btn primary" style={{ height: 42, padding: '0 22px' }} disabled={!ready || (step === 2 && (!okDate || tooBig))} onClick={() => setStep(step + 1)}>Continue</button>
              : <button className="btn primary" style={{ height: 42, padding: '0 22px' }} disabled={!okDate || tooBig || !ready} onClick={go}>Start session</button>}
          </div>
        </main>
        <aside style={{ flex: '1 1 300px', maxWidth: 360 }}>
          <div className="summary">
            <span className="cap">Your session</span>
            <div className="row"><span className="muted">Market</span><b>{isData ? `${instr!.sym}${pick && pick !== '*auto' ? '' : pick === '*auto' ? ' (continuous)' : ''}${op2 ? ' + ' + datasetInstrument(op2.meta, op2.pick, op2.contracts, op2.prec).sym : ''}` : m.name}</b></div>
            {isData && <div className="row"><span className="muted">Data</span><b style={{ fontWeight: 500 }}>{fmtBase(op.base)}{pick ? ` · ${pickLabel(pick)}` : ''}</b></div>}
            <div className="row"><span className="muted">Starts</span><b>{start === 'random' ? 'A random day, 9:30' : fmtClock(start, false)}</b></div>
            <div className="row"><span className="muted">Account</span><b>{money(prop.on ? prop.size : balance)}</b></div>
            {prop.on && <div className="row"><span className="muted">Challenge</span><b>{prop.preset || 'Your own rules'}</b></div>}
            <div className="row"><span className="muted">Risk per trade</span><b>{money(risk)}</b></div>
            <div className="row"><span className="muted">Costs</span><b>${comm.toFixed(2)} a side · {spread} tick spread</b></div>
            <div style={{ height: 1, background: 'var(--line)' }} />
            <button className="btn" disabled={!okDate || tooBig || !ready} onClick={go}>Start with these now</button>
          </div>
        </aside>
      </div>
      <footer className="page-foot"><Credit /></footer>
    </div>
  );
}
