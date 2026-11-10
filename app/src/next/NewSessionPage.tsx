// A new session in three steps: the market, where the tape starts, and the account. Sensible choices are made
// already, so "Start session" works straight away.
import { useState } from 'react';
import { PRACTICE, PRACTICE_FROM, PRACTICE_TO } from '../core/practice';
import { fmtClock, localToUtc } from '../core/time';
import { money } from '../core/account';
import { ICheck } from './icons';

export interface NewSetup { syms: string[]; start: number | 'random'; balance: number; risk: number; comm: number; spreadTicks: number; slipTicks: number; name: string }

const MARKETS = [
  { id: 'NQ', syms: ['NQ'], badge: 'NQ', cls: '', name: 'Practice Nasdaq-100', d: 'A busy futures market. Moves a lot, so trades play out quickly.', tag: 'Best to start' },
  { id: 'ES', syms: ['ES'], badge: 'ES', cls: ' b1', name: 'Practice S&P 500', d: 'Calmer than the Nasdaq, with bigger contracts.', tag: '' },
  { id: 'SMT', syms: ['NQ', 'ES'], badge: 'NQ+ES', cls: ' b3', name: 'Both, side by side', d: 'Two charts on one clock, to compare them (SMT divergence) and trade either.', tag: '' },
];
const nyDate = (iso: string, hh: number, mm: number) => { const [y, m, d] = iso.split('-').map(Number); return localToUtc('America/New_York', y, m - 1, d, hh, mm); };

export function NewSessionPage({ onStart, onCancel, canCancel }: { onStart: (x: NewSetup) => void; onCancel: () => void; canCancel: boolean }) {
  const [step, setStep] = useState(1);
  const [mk, setMk] = useState('NQ');
  const [when, setWhen] = useState<'date' | 'random'>('date');
  const [date, setDate] = useState('2026-04-01');
  const [time, setTime] = useState('09:30');
  const [balance, setBalance] = useState(50000);
  const [risk, setRisk] = useState(200);
  const [comm, setComm] = useState(2.1);
  const [spread, setSpread] = useState(1);
  const [slip, setSlip] = useState(1);
  const m = MARKETS.find(x => x.id === mk)!;
  const [hh, mm] = time.split(':').map(Number);
  const start = when === 'random' ? 'random' as const : nyDate(date, hh || 9, mm || 0);
  const okDate = start === 'random' || (start > PRACTICE_FROM + 7 * 86400 && start < PRACTICE_TO - 86400);
  const steps = ['Market', 'Start', 'Account'];
  const go = () => onStart({ syms: m.syms, start, balance, risk, comm, spreadTicks: spread, slipTicks: slip, name: m.id === 'SMT' ? 'SMT practice' : `${m.name}` });
  return (
    <div className="page">
      <header className="ctx" style={{ gap: 14 }}>
        {canCancel && <button className="btn sm" onClick={onCancel}>Back</button>}
        <b style={{ fontSize: 15 }}>New session</b>
        <span className="spacer" />
        <nav className="steps" aria-label="Steps">
          {steps.map((l, i) => <button key={l} className={step === i + 1 ? 'on' : step > i + 1 ? 'done' : ''} onClick={() => setStep(i + 1)}><i>{step > i + 1 ? <ICheck width={12} height={12} /> : i + 1}</i>{l}</button>)}
        </nav>
      </header>
      <div className="page-in" style={{ flexDirection: 'row', gap: 32, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <main style={{ flex: '999 1 560px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 22 }}>
          {step === 1 && <>
            <div><h1>What do you want to replay?</h1><p className="lead">These practice markets are generated and act like the real ones. Costs and contract sizes fill in from your pick.</p></div>
            <div className="choices">
              {MARKETS.map(x => (
                <button key={x.id} className={'choice' + (mk === x.id ? ' on' : '')} onClick={() => setMk(x.id)}>
                  <span style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}><span className={'badge' + x.cls}>{x.badge}</span>{x.tag && <span className="tag" style={{ background: 'var(--up-soft)', color: 'var(--up-fg)' }}>{x.tag}</span>}</span>
                  <b>{x.name}</b><span className="d">{x.d}</span>
                </button>
              ))}
            </div>
            <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>Your own data (Databento or CSV) opens in the classic view for now: <a href="./index.html">open the classic view</a>.</p>
          </>}
          {step === 2 && <>
            <div><h1>Where should the tape start?</h1><p className="lead">The chart shows the history up to this moment. Everything after it stays hidden until you play it.</p></div>
            <div className="choices">
              <button className={'choice' + (when === 'date' ? ' on' : '')} style={{ minHeight: 90 }} onClick={() => setWhen('date')}><b>A date I pick</b><span className="d">Replay a day you want to study.</span></button>
              <button className={'choice' + (when === 'random' ? ' on' : '')} style={{ minHeight: 90 }} onClick={() => setWhen('random')}><b>A random day</b><span className="d">No hindsight: you won't know what's coming.</span></button>
            </div>
            {when === 'date' && <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
              <label className="field" style={{ width: 220 }}>Date<input className="in" type="date" value={date} min="2019-01-15" max="2026-09-28" onChange={e => setDate(e.target.value)} /></label>
              <label className="field" style={{ width: 160 }}>Time (New York)<input className="in" type="time" value={time} onChange={e => setTime(e.target.value)} /></label>
              <div className="field">Quick picks<span className="seg">
                <button className={time === '09:30' ? 'on' : ''} onClick={() => setTime('09:30')}>New York open</button>
                <button className={time === '03:00' ? 'on' : ''} onClick={() => setTime('03:00')}>London open</button>
                <button className={time === '18:00' ? 'on' : ''} onClick={() => setTime('18:00')}>Day start</button>
              </span></div>
            </div>}
            {!okDate && <div className="warnline">Practice data runs from January 2019 to September 2026. Pick a date in between.</div>}
          </>}
          {step === 3 && <>
            <div><h1>Account and costs</h1><p className="lead">Play money. Costs are filled in for {m.syms.join(' and ')}; change anything that doesn't match your broker.</p></div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 16, maxWidth: 760 }}>
              <label className="field">Starting balance<span className="suffix"><input className="in" inputMode="numeric" value={balance} onChange={e => setBalance(Math.max(100, parseInt(e.target.value) || 0))} /><span>dollars</span></span></label>
              <label className="field"><span className="lbl">Risk per trade <span className="q" title="What you lose if a trade hits its stop. The order ticket sizes trades from it.">?</span></span><span className="suffix"><input className="in" inputMode="numeric" value={risk} onChange={e => setRisk(Math.max(1, parseInt(e.target.value) || 0))} /><span>dollars</span></span></label>
            </div>
            <div className="card" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 760 }}>
              <b>Costs per contract</b>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 14 }}>
                <label className="field">Commission per side<span className="suffix"><input className="in" inputMode="decimal" value={comm} onChange={e => setComm(Math.max(0, parseFloat(e.target.value) || 0))} /><span>dollars</span></span></label>
                <label className="field"><span className="lbl">Spread <span className="q" title="Buys pay this much above the last price.">?</span></span><span className="suffix"><input className="in" inputMode="numeric" value={spread} onChange={e => setSpread(Math.max(0, parseInt(e.target.value) || 0))} /><span>ticks</span></span></label>
                <label className="field"><span className="lbl">Slippage on stops <span className="q" title="Stop orders and stop losses fill this much worse than their price.">?</span></span><span className="suffix"><input className="in" inputMode="numeric" value={slip} onChange={e => setSlip(Math.max(0, parseInt(e.target.value) || 0))} /><span>ticks</span></span></label>
              </div>
              <span className="muted" style={{ fontSize: 12 }}>{m.syms.map(sm => `${sm}: $${PRACTICE[sm].pv} per point, ticks of ${PRACTICE[sm].tick}`).join(' · ')}</span>
            </div>
          </>}
          <div style={{ display: 'flex', gap: 10 }}>
            {step > 1 && <button className="btn" style={{ height: 42 }} onClick={() => setStep(step - 1)}>Back</button>}
            {step < 3 ? <button className="btn primary" style={{ height: 42, padding: '0 22px' }} disabled={step === 2 && !okDate} onClick={() => setStep(step + 1)}>Continue</button>
              : <button className="btn primary" style={{ height: 42, padding: '0 22px' }} disabled={!okDate} onClick={go}>Start session</button>}
          </div>
        </main>
        <aside style={{ flex: '1 1 300px', maxWidth: 360 }}>
          <div className="summary">
            <span className="cap">Your session</span>
            <div className="row"><span className="muted">Market</span><b>{m.name}</b></div>
            <div className="row"><span className="muted">Starts</span><b>{start === 'random' ? 'A random day, 9:30' : fmtClock(start, false)}</b></div>
            <div className="row"><span className="muted">Account</span><b>{money(balance)}</b></div>
            <div className="row"><span className="muted">Risk per trade</span><b>{money(risk)}</b></div>
            <div className="row"><span className="muted">Costs</span><b>${comm.toFixed(2)} a side · {spread} tick spread</b></div>
            <div style={{ height: 1, background: 'var(--line)' }} />
            <button className="btn" disabled={!okDate} onClick={go}>Start with these now</button>
          </div>
        </aside>
      </div>
    </div>
  );
}
