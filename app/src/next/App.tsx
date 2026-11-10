// The new app: a sidebar of pages, and the replay session they work on. Sessions save themselves to the Library
// as they go, and reopen exactly where they were left.
import { useEffect, useRef, useState } from 'react';
import { PRACTICE } from '../core/practice';
import type { IndSpec } from '../core/indicators';
import type { DatasetMeta } from '../core/store';
import { openDataset } from '../core/library';
import { ReplayPage } from './ReplayPage';
import { NewSessionPage, type ResumeInfo } from './NewSessionPage';
import { JournalPage } from './JournalPage';
import { LibraryPage } from './LibraryPage';
import { bump, frameHooks, initPrefs, pref } from './live';
import { place, setTicket } from './ticket';
import { ds, setDs } from './draw/state';
import { layers } from './draw/overlay';
import { TOOLS } from './draw/tools';
import { store, classicHref } from './appstore';
import { contAhead, datasetInstrument, loadMarket, openLive, practiceSource, reopen, sessionDoc, type Live, type MarketSource, type Opening, type SessionDoc } from './sessions';
import { IBacktest, IClassic, IJournal, ILibrary, IPlus, IReplay, ISettings, Logo } from './icons';

type Page = 'replay' | 'journal' | 'backtest' | 'library' | 'settings' | 'new';
interface Toast { id: number; text: string; kind: string }

const DEFAULT_INDS: IndSpec[] = [{ id: 'ema20', type: 'ema', len: 20, color: '#f0b54a', on: true }, { id: 'vwap', type: 'vwap', len: 0, color: '#b9bec9', on: true }];
/** saved every so often while something changes, when the replay pauses, and as the window closes */
const SAVE_EVERY = 10000;

export function App() {
  const [ready, setReady] = useState(false);
  const [page, setPage] = useState<Page>('new');
  const [live, setLive] = useState<Live | null>(null);
  const [busy, setBusy] = useState<{ text: string; p: number } | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [withData, setWithData] = useState<DatasetMeta | null>(null);
  const [resume, setResume] = useState<ResumeInfo | null>(null);
  const [saveState, setSaveState] = useState('');
  const [libList, setLibList] = useState<DatasetMeta[]>([]);
  const tid = useRef(0);
  const session = live?.session || null;

  const toast = (text: string, kind = '') => {
    const id = ++tid.current;
    setToasts(t => [...t.slice(-3), { id, text, kind }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), kind === 'err' ? 6000 : 3500);
  };

  // preferences, then the last session to offer to continue
  useEffect(() => {
    initPrefs(store).finally(() => setReady(true));
    store.last().then(async l => {
      if (!l.id) return;
      const m = (await store.listSessions()).find(x => x.id === l.id && x.summary?.app === 'next');
      if (m) setResume({ id: m.id, name: m.name, updated: m.updated });
    }).catch(() => {});
  }, []);

  // the replay loop: the session moves on every animation frame; charts draw every frame, panels ten times a second
  useEffect(() => {
    if (!live) return;
    const s = live.session;
    if (import.meta.env.MODE === 'test') (window as unknown as { __next: unknown }).__next = { session: s, live, ds, layers, setDs, store, tools: TOOLS.filter(t => t.group !== 'cursor').map(t => ({ id: t.id, n: t.n })) };
    let last = performance.now(), lastBump = 0, raf = 0, wasPlaying = false, lastCont = 0;
    const loop = (now: number) => {
      const dt = (now - last) / 1000; last = now;
      s.frame(dt);
      for (const f of frameHooks) f(now);
      if ((s.playing || wasPlaying) && now - lastBump > 100) { lastBump = now; bump(); }
      if (s.playing && now - lastCont > 1000) { lastCont = now; contAhead(store, live, m => toast(m, 'err')); }
      wasPlaying = s.playing;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    const off = s.subscribe(e => {
      bump();
      if (!e) return;
      if (e.kind === 'error') toast(e.text, 'err');
      else if (e.kind === 'entry' || e.kind === 'exit' || e.kind === 'prop') toast(e.text, e.up ? 'up' : 'down');
      else if (e.text) toast(e.text);
    });
    store.listDatasets().then(setLibList).catch(() => {});
    return () => { cancelAnimationFrame(raf); off(); };
  }, [live]);

  // saving: whenever something changed, every few seconds and when the replay pauses; at once as the window closes
  useEffect(() => {
    if (!live) return;
    const s = live.session;
    let savedAt = -1, saving = false, wasPlaying = false;
    const save = async (force = false) => {
      if (saving || (!force && s.version === savedAt)) return;
      saving = true; const v = s.version;
      try { await store.saveSession(live.id, sessionDoc(live)); savedAt = v; setSaveState('Saved ' + new Date().toTimeString().slice(0, 5)); }
      catch { setSaveState('Not saved'); }
      finally { saving = false; }
    };
    const timer = setInterval(() => { save(); if (wasPlaying && !s.playing) save(true); wasPlaying = s.playing; }, SAVE_EVERY);
    const flush = () => { store.saveSessionNow(live.id, sessionDoc(live)); return true; };
    (window as unknown as { __tapeFlush?: () => boolean }).__tapeFlush = flush;
    const hide = () => { if (document.visibilityState === 'hidden') save(true); };
    document.addEventListener('visibilitychange', hide);
    addEventListener('pagehide', flush);
    save(true);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', hide); removeEventListener('pagehide', flush); save(); };
  }, [live]);

  // keys: Space play, → a bar (Shift+→ a candle), ← back, . one tick, B / S trade, X close all
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!session || page !== 'replay') return;
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (e.ctrlKey || e.metaKey || e.altKey || document.querySelector('.modal')) return; // drawing shortcuts and dialogs
      if (e.key === ' ') { e.preventDefault(); session.toggle(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); if (e.shiftKey) session.stepCandle(); else session.stepBar(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); session.stepBack(); }
      else if (e.key === '.') session.stepTick();
      else if (e.key === 'b' || e.key === 'B') { const err = place(session, 1); if (err) toast(err, 'err'); }
      else if (e.key === 's' || e.key === 'S') { const err = place(session, -1); if (err) toast(err, 'err'); }
      else if (e.key === 'x' || e.key === 'X') { session.account.closeAll(); session.changed(); }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [session, page]);

  const progress = (text: string) => (p: number, step?: string) => setBusy({ text: step ? `${text}: ${step}` : text, p });
  async function start(x: Opening) {
    setBusy({ text: 'Preparing the market data', p: 0 });
    try {
      const L = await openLive(store, x, progress('Preparing the market data'));
      L.session.speed = pref('speed', 60);
      setTicket({ mode: 'risk', risk: x.risk, type: 'market' });
      setLive(L); setPage('replay'); setWithData(null); setResume(null);
    } catch (e) { toast((e as Error).message, 'err'); }
    finally { setBusy(null); }
  }
  async function open(id: string) {
    if (live?.id === id) return setPage('replay');
    setBusy({ text: 'Opening the session', p: 0 });
    try {
      const doc = await store.getSession(id) as SessionDoc;
      if (doc.app !== 'next') throw new Error('This session was made in the classic view. Open it there.');
      const L = await reopen(store, doc, progress('Opening the session'));
      setTicket({ mode: 'risk', risk: L.risk, type: 'market' });
      setLive(L); setPage('replay'); setResume(null);
    } catch (e) { toast((e as Error).message, 'err'); }
    finally { setBusy(null); }
  }
  /** markets that can join the session on the same clock */
  const available = (): Array<{ key: string; name: string; sym: string }> => {
    if (!live) return [];
    const isOpen = new Set(live.session.feeds.map(f => f.s.inst.sym));
    const prac = live.markets.some(m => m.kind === 'practice') ? Object.values(PRACTICE).filter(i => !isOpen.has(i.sym)).map(i => ({ key: 'practice:' + i.sym, name: i.name, sym: i.sym })) : [];
    const now = live.session.now;
    const data = libList.filter(d => !live.markets.some(m => m.kind === 'dataset' && m.id === d.id) && (d.from == null || (now >= d.from && now <= (d.to ?? Infinity))));
    return [...prac, ...data.map(d => ({ key: 'ds:' + d.id, name: d.name, sym: '' }))];
  };
  async function addMarket(key: string) {
    if (!live) return;
    const s = live.session, now = s.now;
    setBusy({ text: 'Preparing the market', p: 0 });
    try {
      let m: MarketSource;
      if (key.startsWith('practice:')) {
        const first = live.markets.find(x => x.kind === 'practice') as Extract<MarketSource, { kind: 'practice' }>;
        m = practiceSource(key.slice(9), first.t0, first.t1, first.costs);
      } else {
        const meta = libList.find(d => d.id === key.slice(3))!;
        const o = await openDataset(store, meta, null, progress(`Opening ${meta.name}`));
        if (now < o.from || now > o.to) throw new Error(`${meta.name} has no bars at this time.`);
        const inst = datasetInstrument(meta, o.pick, o.contracts, o.prec);
        m = { kind: 'dataset', id: meta.id, name: meta.name, pick: o.pick, inst, window: o.index ? { from: now - 7 * 86400, to: Math.min(o.to, now + 31 * 86400) } : null, cont: null };
      }
      const series = await loadMarket(store, m, progress('Preparing the market'));
      if (s.feeds.some(f => f.s.inst.sym === series.inst.sym)) series.inst = { ...series.inst, sym: series.inst.sym + '2' };
      live.markets.push(m);
      s.addMarket(series);
    } catch (e) { toast((e as Error).message, 'err'); }
    finally { setBusy(null); }
  }
  function removeMarket(sym: string) {
    if (!live) return;
    const k = live.session.feeds.findIndex(f => f.s.inst.sym === sym); if (k < 0) return;
    live.markets.splice(k, 1); live.session.removeMarket(sym);
  }
  async function jump(t: number) {
    if (!session) return;
    const back = t < session.now, text = back ? 'Going back' : 'Jumping ahead (orders still fill on the way)';
    setBusy({ text, p: 0 });
    try { await session.jumpTo(t, p => setBusy({ text, p })); }
    finally { setBusy(null); }
  }

  if (!ready) return null;
  const nav: Array<[Page, string, React.ReactNode]> = [['replay', 'Replay', <IReplay />], ['backtest', 'Backtest', <IBacktest />], ['journal', 'Journal', <IJournal />], ['library', 'Library', <ILibrary />], ['settings', 'Settings', <ISettings />]];
  return (
    <div className="app">
      <nav className="nav" aria-label="Main">
        <button className="logo" aria-label="Tape Replay" onClick={() => setPage(session ? 'replay' : 'new')}><Logo /></button>
        {nav.map(([k, l, ic]) => <button key={k} className={'item' + (page === k ? ' on' : '')} aria-current={page === k ? 'page' : undefined} disabled={!session && (k === 'replay' || k === 'journal')} onClick={() => setPage(k)}>{ic}{l}</button>)}
        <span className="spacer" />
        <a className="item" href={classicHref} title="The classic Tape Replay, with everything not moved over yet" style={{ textDecoration: 'none' }}><IClassic />Classic</a>
        <button className="new" aria-label="New session" title="New session" onClick={() => { setWithData(null); setPage('new'); }}><IPlus /></button>
      </nav>
      <div className="main">
        {page === 'new' && <NewSessionPage key={withData?.id || 'new'} onStart={start} onCancel={() => setPage(session ? 'replay' : 'library')} canCancel={!!session} onBusy={setBusy} onToast={toast}
          withData={withData} resume={session ? null : resume} onResume={open} inds={pref('inds', DEFAULT_INDS)} />}
        {page === 'replay' && live && <ReplayPage session={live.session} saveState={saveState} available={available()} onAddMarket={addMarket} onRemoveMarket={removeMarket} onJump={jump} onToast={toast} openJournal={() => setPage('journal')} />}
        {page === 'journal' && session && <JournalPage session={session} onReplay={() => setPage('replay')} />}
        {page === 'library' && <LibraryPage current={live?.id || null} onOpen={open} onNewWith={d => { setWithData(d); setPage('new'); }} onBusy={setBusy} onToast={toast} />}
        {(page === 'backtest' || page === 'settings') && <Classic page={page} />}
      </div>
      {busy && <div className="busy" role="status"><div className="box"><b>{busy.text}</b><div className="bar"><i style={{ width: `${Math.round(busy.p * 100)}%` }} /></div></div></div>}
      <div className="toasts" aria-live="polite">{toasts.map(t => <div key={t.id} className={'toast ' + t.kind}>{t.text}</div>)}</div>
    </div>
  );
}

const CLASSIC: Record<string, [string, string]> = {
  backtest: ['Backtest', 'Python strategies, the optimizer and the robustness tests are being moved into this screen. Until then they work as before in the classic view.'],
  settings: ['Settings', 'Themes, time zone and shortcuts are being moved into this screen. Until then they work as before in the classic view.'],
};
function Classic({ page }: { page: string }) {
  const [title, text] = CLASSIC[page];
  return (
    <div className="page"><div className="page-in" style={{ alignItems: 'center', textAlign: 'center', paddingTop: 80 }}>
      <h1>{title}</h1>
      <p className="lead" style={{ maxWidth: 520 }}>{text}</p>
      <a className="btn primary" style={{ height: 42, padding: '0 20px' }} href={classicHref}>Open the classic view</a>
    </div></div>
  );
}
