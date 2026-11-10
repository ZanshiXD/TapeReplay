// The new app: a sidebar of pages, and the replay session they work on.
import { useEffect, useRef, useState } from 'react';
import { Session } from '../core/session';
import { practiceSeries, randomPracticeStart, PRACTICE } from '../core/practice';
import type { Series } from '../core/series';
import { parseTF } from '../core/time';
import type { IndSpec } from '../core/indicators';
import { ReplayPage } from './ReplayPage';
import { NewSessionPage, type NewSetup } from './NewSessionPage';
import { JournalPage } from './JournalPage';
import { bump, frameHooks, pref } from './live';
import { place, setTicket } from './ticket';
import { ds, setDs } from './draw/state';
import { layers } from './draw/overlay';
import { TOOLS } from './draw/tools';
import { IBacktest, IClassic, IJournal, ILibrary, IPlus, IReplay, ISettings, Logo } from './icons';

type Page = 'replay' | 'journal' | 'backtest' | 'library' | 'settings' | 'new';
interface Toast { id: number; text: string; kind: string }
interface Range { t0: number; t1: number; costs: Pick<NewSetup, 'comm' | 'spreadTicks' | 'slipTicks'> }

const DEFAULT_INDS: IndSpec[] = [{ id: 'ema20', type: 'ema', len: 20, color: '#f0b54a', on: true }, { id: 'vwap', type: 'vwap', len: 0, color: '#b9bec9', on: true }];

function withCosts(s: Series, c: Range['costs']): Series { return { ...s, inst: { ...s.inst, comm: c.comm, spreadTicks: c.spreadTicks, slipTicks: c.slipTicks } }; }

export function App() {
  const [page, setPage] = useState<Page>('new');
  const [session, setSession] = useState<Session | null>(null);
  const [busy, setBusy] = useState<{ text: string; p: number } | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const range = useRef<Range | null>(null);
  const tid = useRef(0);

  const toast = (text: string, kind = '') => {
    const id = ++tid.current;
    setToasts(t => [...t.slice(-3), { id, text, kind }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), kind === 'err' ? 6000 : 3500);
  };

  // the replay loop: the session moves on every animation frame; charts draw every frame, panels ten times a second
  useEffect(() => {
    if (!session) return;
    if (import.meta.env.MODE === 'test') (window as unknown as { __next: unknown }).__next = { session, ds, layers, setDs, tools: TOOLS.filter(t => t.group !== 'cursor').map(t => ({ id: t.id, n: t.n })) };
    let last = performance.now(), lastBump = 0, raf = 0, wasPlaying = false;
    const loop = (now: number) => {
      const dt = (now - last) / 1000; last = now;
      session.frame(dt);
      for (const f of frameHooks) f(now);
      if ((session.playing || wasPlaying) && now - lastBump > 100) { lastBump = now; bump(); }
      wasPlaying = session.playing;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    const off = session.subscribe(e => {
      bump();
      if (!e) return;
      if (e.kind === 'error') toast(e.text, 'err');
      else if (e.kind === 'entry' || e.kind === 'exit') toast(e.text, e.up ? 'up' : 'down');
      else if (e.text) toast(e.text);
    });
    return () => { cancelAnimationFrame(raf); off(); };
  }, [session]);

  // keys: Space play, arrows step, B / S trade, X close all
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!session || page !== 'replay') return;
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (e.ctrlKey || e.metaKey || e.altKey || document.querySelector('.modal')) return; // drawing shortcuts and dialogs
      if (e.key === ' ') { e.preventDefault(); session.toggle(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); if (e.shiftKey) session.stepBar(); else session.stepCandle(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); session.stepBack(); }
      else if (e.key === '.') session.stepTick();
      else if (e.key === 'b' || e.key === 'B') { const err = place(session, 1); if (err) toast(err, 'err'); }
      else if (e.key === 's' || e.key === 'S') { const err = place(session, -1); if (err) toast(err, 'err'); }
      else if (e.key === 'x' || e.key === 'X') { session.account.closeAll(); session.changed(); }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [session, page]);

  async function start(x: NewSetup) {
    setBusy({ text: 'Preparing the market data', p: 0 });
    try {
      const startT = x.start === 'random' ? randomPracticeStart() : x.start;
      const t0 = startT - 4 * 86400, t1 = startT + 8 * 86400;
      const costs = { comm: x.comm, spreadTicks: x.spreadTicks, slipTicks: x.slipTicks };
      const markets = (await practiceSeries(x.syms, t0, t1, p => setBusy({ text: 'Preparing the market data', p }))).map(s => withCosts(s, costs));
      range.current = { t0, t1, costs };
      const s = new Session({ name: x.name, markets, start: startT, tf: parseTF(pref('tf', '5m')) || parseTF('5m')!, balance: x.balance, inds: pref('inds', DEFAULT_INDS) });
      s.speed = pref('speed', 60);
      setTicket({ mode: 'risk', risk: x.risk, type: 'market' });
      setSession(s); setPage('replay');
    } catch (e) { toast((e as Error).message, 'err'); }
    finally { setBusy(null); }
  }
  async function addMarket(sym: string) {
    if (!session || !range.current) return;
    setBusy({ text: `Preparing ${sym}`, p: 0 });
    try {
      const [s] = await practiceSeries([sym], range.current.t0, range.current.t1);
      session.addMarket(withCosts(s, range.current.costs));
    } finally { setBusy(null); }
  }
  async function jump(t: number) {
    if (!session) return;
    const back = t < session.now;
    setBusy({ text: back ? 'Going back' : 'Jumping ahead (orders still fill on the way)', p: 0 });
    try { await session.jumpTo(t, p => setBusy({ text: back ? 'Going back' : 'Jumping ahead (orders still fill on the way)', p })); }
    finally { setBusy(null); }
  }

  const available = session ? Object.values(PRACTICE).filter(i => !session.feeds.some(f => f.s.inst.sym === i.sym)).map(i => ({ sym: i.sym, name: i.name })) : [];
  const nav: Array<[Page, string, React.ReactNode]> = [['replay', 'Replay', <IReplay />], ['backtest', 'Backtest', <IBacktest />], ['journal', 'Journal', <IJournal />], ['library', 'Library', <ILibrary />], ['settings', 'Settings', <ISettings />]];
  return (
    <div className="app">
      <nav className="nav" aria-label="Main">
        <button className="logo" aria-label="Tape Replay" onClick={() => setPage(session ? 'replay' : 'new')}><Logo /></button>
        {nav.map(([k, l, ic]) => <button key={k} className={'item' + (page === k ? ' on' : '')} aria-current={page === k ? 'page' : undefined} disabled={!session && (k === 'replay' || k === 'journal')} onClick={() => setPage(k)}>{ic}{l}</button>)}
        <span className="spacer" />
        <a className="item" href="./index.html" title="The classic Tape Replay, with everything not moved over yet" style={{ textDecoration: 'none' }}><IClassic />Classic</a>
        <button className="new" aria-label="New session" title="New session" onClick={() => setPage('new')}><IPlus /></button>
      </nav>
      <div className="main">
        {page === 'new' && <NewSessionPage onStart={start} onCancel={() => setPage('replay')} canCancel={!!session} />}
        {page === 'replay' && session && <ReplayPage session={session} available={available} onAddMarket={addMarket} onJump={jump} onToast={toast} openJournal={() => setPage('journal')} />}
        {page === 'journal' && session && <JournalPage session={session} onReplay={() => setPage('replay')} />}
        {(page === 'backtest' || page === 'library' || page === 'settings') && <Classic page={page} />}
      </div>
      {busy && <div className="busy" role="status"><div className="box"><b>{busy.text}</b><div className="bar"><i style={{ width: `${Math.round(busy.p * 100)}%` }} /></div></div></div>}
      <div className="toasts" aria-live="polite">{toasts.map(t => <div key={t.id} className={'toast ' + t.kind}>{t.text}</div>)}</div>
    </div>
  );
}

const CLASSIC: Record<string, [string, string]> = {
  backtest: ['Backtest', 'Python strategies, the optimizer and the robustness tests are being moved into this screen. Until then they work as before in the classic view.'],
  library: ['Library', 'Saved sessions, your data files and imports are being moved into this screen. Until then they work as before in the classic view.'],
  settings: ['Settings', 'Themes, time zone, prop rules and shortcuts are being moved into this screen. Until then they work as before in the classic view.'],
};
function Classic({ page }: { page: string }) {
  const [title, text] = CLASSIC[page];
  return (
    <div className="page"><div className="page-in" style={{ alignItems: 'center', textAlign: 'center', paddingTop: 80 }}>
      <h1>{title}</h1>
      <p className="lead" style={{ maxWidth: 520 }}>{text}</p>
      <a className="btn primary" style={{ height: 42, padding: '0 20px' }} href="./index.html">Open the classic view</a>
    </div></div>
  );
}
