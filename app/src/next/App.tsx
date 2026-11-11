// The new app: a sidebar of pages, and the replay session they work on. Sessions save themselves to the Library
// as they go, and reopen exactly where they were left.
import { useEffect, useRef, useState } from 'react';
import { PRACTICE } from '../core/practice';
import type { IndSpec } from '../core/indicators';
import type { DatasetMeta } from '../core/store';
import { openDataset } from '../core/library';
import { ReplayPage, type MView } from './ReplayPage';
import { NewSessionPage, type ResumeInfo } from './NewSessionPage';
import { JournalPage } from './JournalPage';
import { LibraryPage } from './LibraryPage';
import { KeysSheet, SettingsPage, applyReplayPrefs, startTicket } from './SettingsPage';
import { applyLook, onLook } from './look';
import { bump, frameHooks, initPrefs, pref, pulse, setPref } from './live';
import { place, setTicket } from './ticket';
import { ds, setDs } from './draw/state';
import { layers } from './draw/overlay';
import { TOOLS, styleFor } from './draw/tools';
import { store } from './appstore';
import { contAhead, datasetInstrument, loadMarket, openLive, practiceSource, reopen, sessionDoc, type Live, type MarketSource, type Opening, type SessionDoc } from './sessions';
import { UpdateButton } from './Update';
import { BacktestPage } from './BacktestPage';
import { OptimList } from './OptimizePanel';
import type { SessionState } from '../core/session';
import { IBacktest, IGuide, IJournal, ILibrary, IPlus, IReplay, ISettings, Logo } from './icons';
import { Guide } from './guide/Guide';

type Page = 'replay' | 'journal' | 'backtest' | 'library' | 'settings' | 'new' | 'guide';
interface Toast { id: number; text: string; kind: string }

const DEFAULT_INDS: IndSpec[] = [{ id: 'ema20', type: 'ema', len: 20, color: '#f0b54a', on: true }, { id: 'vwap', type: 'vwap', len: 0, color: '#b9bec9', on: true }];
/** saved every so often while something changes, when the replay pauses, and as the window closes */
const SAVE_EVERY = 10000, PLAY_SAVE_EVERY = 30000;

/** runs one part of a frame; a failure is logged (once per part and message) and does not stop the frame */
const failed = new Set<string>();
function guard(part: string, f: () => unknown) {
  try { f(); } catch (e) { const k = part + ': ' + (e instanceof Error ? e.message : String(e)); if (!failed.has(k)) { failed.add(k); console.warn('Tape Replay kept playing after an error in the ' + k, e); } }
}

export function App() {
  const [ready, setReady] = useState(false);
  const [page, setPage] = useState<Page>('new');
  // the guide over whatever is open (from the code editors), so nothing being written is lost
  const [guideAt, setGuideAtS] = useState<string | null>(null);
  const guideOpen = useRef(false);
  const setGuideAt = (g: string | null) => { guideOpen.current = g != null; setGuideAtS(g); };
  useEffect(() => {
    const f = (e: Event) => setGuideAt((e as CustomEvent<string>).detail || '');
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && guideOpen.current) { e.stopImmediatePropagation(); setGuideAt(null); } };
    addEventListener('tape:guide', f); addEventListener('keydown', k, true);
    return () => { removeEventListener('tape:guide', f); removeEventListener('keydown', k, true); };
  }, []);
  const [live, setLive] = useState<Live | null>(null);
  const [busy, setBusyS] = useState<{ text: string; p: number } | null>(null);
  const busyT0 = useRef(0), busyOn = useRef(false);
  const setBusy = (b: { text: string; p: number } | null) => { if (b && !busyOn.current) busyT0.current = performance.now(); busyOn.current = !!b; setBusyS(b); };
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [withData, setWithData] = useState<DatasetMeta | null>(null);
  const [resume, setResume] = useState<ResumeInfo | null>(null);
  const [saveState, setSaveState] = useState('');
  const [libList, setLibList] = useState<DatasetMeta[]>([]);
  const [mview, setMview] = useState<MView>('chart');
  const [more, setMore] = useState(false);
  const [keys, setKeys] = useState(false);
  const [btSeen, setBtSeen] = useState(false);
  const [optimId, setOptimId] = useState<string | null>(null);
  const tid = useRef(0);
  const session = live?.session || null;

  const toast = (text: string, kind = '') => {
    const id = ++tid.current;
    setToasts(t => [...t.slice(-3), { id, text, kind }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), kind === 'err' ? 6000 : 3500);
  };

  // preferences, then the last session to offer to continue
  useEffect(() => {
    initPrefs(store).finally(() => { applyLook(); setReady(true); });
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
    if (import.meta.env.MODE === 'test') (window as unknown as { __next: unknown }).__next = { session: s, live, ds, layers, setDs, store, tools: TOOLS.filter(t => t.group !== 'cursor').map(t => ({ id: t.id, n: t.n })), styleFor };
    let last = performance.now(), lastBump = 0, raf = 0, wasPlaying = false, lastCont = 0;
    // the next frame is asked for first, and each part runs on its own: a part that fails (a chart that can't draw,
    // a panel) is reported once and the replay, the clock and the other charts carry on
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const dt = (now - last) / 1000; last = now;
      guard('replay', () => s.frame(dt));
      for (const f of frameHooks) guard('chart', () => f(now));
      // the panels: the prices and the clock ten times a second while playing; everything once when it stops
      if (wasPlaying && !s.playing) { lastBump = now; guard('panels', bump); }
      else if (s.playing && now - lastBump > 100) { lastBump = now; guard('panels', pulse); }
      if (s.playing && now - lastCont > 1000) { lastCont = now; guard('data', () => contAhead(store, live, m => toast(m, 'err'))); }
      wasPlaying = s.playing;
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
    // a new time zone or trading day start: the candles are rebuilt on the new clock
    const offLook = onLook(w => { if (w.time) s.setTf(s.tf); });
    return () => { cancelAnimationFrame(raf); off(); offLook(); };
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
    // while the tape plays, a save every PLAY_SAVE_EVERY (writing a long session out takes a moment), started when the
    // page is idle between frames so it doesn't hold up the next one; paused, as soon as anything changed, and at once
    // when it pauses or the app goes to the background
    let lastSave = 0;
    const idle = (f: () => void) => { const ric = (window as unknown as { requestIdleCallback?: (f: () => void, o: { timeout: number }) => number }).requestIdleCallback; if (ric) ric(f, { timeout: 3000 }); else setTimeout(f, 0); };
    const timer = setInterval(() => {
      const now = Date.now();
      if (s.playing && now - lastSave >= PLAY_SAVE_EVERY) { lastSave = now; idle(() => { if (s.playing) save(); }); }
      else if (!s.playing) { lastSave = now; save(); }
      if (wasPlaying && !s.playing) save(true);
      wasPlaying = s.playing;
    }, SAVE_EVERY);
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
      else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const steps = [1, 2, 5, 10, 30, 60, 120, 300, 600, 1000, 1800, 3600], k = steps.findIndex(v => v >= session.speed);
        session.speed = steps[Math.max(0, Math.min(steps.length - 1, (k < 0 ? steps.length - 1 : k) + (e.key === 'ArrowUp' ? 1 : -1)))]; setPref('speed', session.speed); session.changed();
      }
      else if (e.key === 'b' || e.key === 'B') { const err = place(session, 1); if (err) toast(err, 'err'); }
      else if (e.key === 's' || e.key === 'S') { const err = place(session, -1); if (err) toast(err, 'err'); }
      else if (e.key === 'x' || e.key === 'X') { session.account.closeAll(); session.changed(); }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [session, page]);
  // ? anywhere: the keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key !== '?' || e.ctrlKey || e.metaKey || e.altKey || (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable))) return;
      if (document.querySelector('.modal')) return;
      e.preventDefault(); setKeys(true);
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  const progress = (text: string) => (p: number, step?: string) => setBusy({ text: step ? `${text}: ${step}` : text, p });
  async function start(x: Opening, restore?: SessionState) {
    setBusy({ text: 'Preparing the market data', p: 0 });
    try {
      const L = await openLive(store, x, progress('Preparing the market data'), restore);
      L.session.speed = pref('speed', 60);
      applyReplayPrefs(L.session, true);
      setTicket(startTicket(x.risk));
      setLive(L); setPage('replay'); setWithData(null); setResume(null);
    } catch (e) { toast((e as Error).message, 'err'); }
    finally { setBusy(null); }
  }
  async function open(id: string) {
    if (live?.id === id) return setPage('replay');
    setBusy({ text: 'Opening the session', p: 0 });
    try {
      const doc = await store.getSession(id) as SessionDoc;
      if (doc.app !== 'next') throw new Error('This session was saved by an older version of Tape Replay and cannot be opened.');
      const L = await reopen(store, doc, progress('Opening the session'));
      applyReplayPrefs(L.session, true);
      setTicket(startTicket(L.risk));
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

  useEffect(() => { if (page === 'backtest') setBtSeen(true); }, [page]);
  if (!ready) return null;
  const nav: Array<[Page, string, React.ReactNode]> = [['replay', 'Replay', <IReplay />], ['backtest', 'Backtest', <IBacktest />], ['journal', 'Journal', <IJournal />], ['library', 'Library', <ILibrary />], ['guide', 'Guide', <IGuide />], ['settings', 'Settings', <ISettings />]];
  return (
    <div className="app">
      <nav className="nav" aria-label="Main">
        <button className="logo" aria-label="Tape Replay" onClick={() => setPage(session ? 'replay' : 'new')}><Logo /></button>
        {nav.map(([k, l, ic]) => <button key={k} className={'item' + (page === k ? ' on' : '')} aria-current={page === k ? 'page' : undefined} disabled={!session && (k === 'replay' || k === 'journal')} onClick={() => setPage(k)}>{ic}{l}</button>)}
        <span className="spacer" />
        <UpdateButton beforeInstall={async () => { if (live) { live.session.pause(); await store.saveSession(live.id, sessionDoc(live)); } }} />
        <button className="new" aria-label="New session" title="New session" onClick={() => { setWithData(null); setPage('new'); }}><IPlus /></button>
      </nav>
      <div className="main">
        {page === 'new' && <NewSessionPage key={withData?.id || 'new'} onStart={start} onCancel={() => setPage(session ? 'replay' : 'library')} canCancel={!!session} onBusy={setBusy} onToast={toast}
          withData={withData} resume={session ? null : resume} onResume={open} inds={pref('inds', DEFAULT_INDS)} />}
        {page === 'replay' && live && <ReplayPage mview={mview} session={live.session} saveState={saveState} available={available()} onAddMarket={addMarket} onRemoveMarket={removeMarket} onJump={jump} onToast={toast} openJournal={() => setPage('journal')} />}
        {page === 'journal' && session && <JournalPage session={session} onReplay={() => setPage('replay')} />}
        {page === 'library' && <LibraryPage current={live?.id || null} onOpen={open} onNewWith={d => { setWithData(d); setPage('new'); }} onBusy={setBusy} onToast={toast}
          extra={{ tab: 'optims', label: 'Optimizations', node: <OptimList onOpen={id => { setOptimId(id); setPage('backtest'); }} onToast={toast} /> }} />}
        {page === 'guide' && <div className="page gpage" style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}><Guide /></div>}
        {page === 'settings' && <SettingsPage session={session} onKeys={() => setKeys(true)} onToast={toast} />}
        {(page === 'backtest' || btSeen) && <BacktestPage hidden={page !== 'backtest'} live={live} onToast={toast} onBusy={setBusy} openOptim={optimId} onOptimOpened={() => setOptimId(null)}
          onShow={(x, st) => { const inds = pref('inds', DEFAULT_INDS); return start({ ...x, inds }, { ...st, inds }); }} />}
      </div>
      {guideAt != null && <Guide at={guideAt || undefined} onClose={() => setGuideAt(null)} />}
      <PhoneNav page={page} mview={mview} hasSession={!!session} badge={session ? session.account.trades.length + session.account.orders.length : 0}
        go={(p, v) => { setMore(false); setPage(p); if (v) setMview(v); }} more={more} setMore={setMore} />
      {busy && <div className="busy" role="status"><div className="box"><b>{busy.text}</b><div className="bar"><i style={{ width: `${Math.round(busy.p * 100)}%` }} /></div><span className="muted" style={{ fontSize: 12 }}>{timeLeft(busy.p, (performance.now() - busyT0.current) / 1000)}</span></div></div>}
      {keys && <KeysSheet onClose={() => setKeys(false)} />}
      <div className="toasts" aria-live="polite">{toasts.map(t => <div key={t.id} className={'toast ' + t.kind}>{t.text}</div>)}</div>
    </div>
  );
}

/** phones: a tab bar instead of the sidebar, the replay screen one part at a time, the rest under More */
function PhoneNav({ page, mview, hasSession, badge, go, more, setMore }: { page: Page; mview: MView; hasSession: boolean; badge: number; go: (p: Page, v?: MView) => void; more: boolean; setMore: (b: boolean) => void }) {
  const on = (p: Page, v?: MView) => !more && page === p && (!v || mview === v) ? ' on' : '';
  return <>
    {more && <div className="msheet-back" onClick={() => setMore(false)}><div className="pop menu msheet" onClick={e => e.stopPropagation()}>
      <button hidden data-dismiss onClick={() => setMore(false)} />
      <h5>Go to</h5>
      <button onClick={() => go('new')}>New session</button>
      <button onClick={() => go('library')}>Library: sessions and data</button>
      {hasSession && <button onClick={() => go('journal')}>Journal</button>}
      <button onClick={() => go('backtest')}>Backtest</button>
      <button onClick={() => go('guide')}>Guide: how everything works</button>
      <button onClick={() => go('settings')}>Settings</button>
    </div></div>}
    <nav className="mnav" aria-label="Main">
      {hasSession ? <>
        <button className={on('replay', 'chart')} onClick={() => go('replay', 'chart')}><IReplay />Chart</button>
        <button className={on('replay', 'trade')} onClick={() => go('replay', 'trade')}><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M7 17V7M4 10l3-3 3 3M17 7v10M14 14l3 3 3-3" /></svg>Trade</button>
        <button className={on('replay', 'pos')} onClick={() => go('replay', 'pos')}><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M4 6h16M4 12h16M4 18h10" /></svg>Positions{badge > 0 && <i className="mbadge">{badge}</i>}</button>
        <button className={on('journal')} onClick={() => go('journal')}><IJournal />Journal</button>
      </> : <>
        <button className={on('new')} onClick={() => go('new')}><IPlus />New</button>
        <button className={on('library')} onClick={() => go('library')}><ILibrary />Library</button>
      </>}
      <button className={more ? ' on' : ''} onClick={() => setMore(!more)}><ISettings />More</button>
    </nav>
  </>;
}

/** a long job's time left, from its pace so far */
function timeLeft(f: number, el: number) {
  if (f >= 1 || el < 2 || f < 0.02) return f > 0 ? `${Math.floor(f * 100)}%` : '';
  const s = el * (1 - f) / f;
  return `${Math.floor(f * 100)}% · ${s < 50 ? `about ${Math.max(5, Math.round(s / 5) * 5)} s left` : s < 90 ? 'about a minute left' : s < 3600 ? `about ${Math.round(s / 60)} min left` : `about ${(s / 3600).toFixed(1)} h left`}`;
}
