// A replay session: one or more markets on one clock, one account trading all of them, and the journal. The screens
// drive it with play/pause and the step buttons, and call frame() on every animation frame while playing.
import { Account, type AccountEvent, type AccountState, type Quote, type Side } from './account';
import { Feed, type FeedSnap } from './feed';
import { DrawStore } from './drawings';
import type { IndSpec } from './indicators';
import { journalEntry, type JournalEntry } from './journal';
import type { Series } from './series';
import type { TF } from './time';

export interface SessionSetup {
  name: string;
  markets: Series[];
  /** UTC time the tape starts at: before it is history, shown but not traded */
  start: number;
  tf: TF;
  balance: number;
  ticksPerBar?: number;
  inds?: IndSpec[];
}
export interface SessionEvent extends AccountEvent { at: number }
interface Snapshot { time: number; feeds: FeedSnap[]; account: AccountState; journal: number }

/** a quiet stretch this long (the daily break, nights, weekends) is jumped over rather than played in real time */
const CLOSED_GAP = 600;

export class Session {
  readonly name: string;
  feeds: Feed[];
  account: Account;
  /** replay time: keeps moving between trades, so the clock runs evenly */
  simTime: number;
  readonly startTime: number;
  playing = false;
  /** replay seconds per real second */
  speed = 60;
  /** the market the trade panel and the step buttons work on */
  active: string;
  journal: JournalEntry[] = [];
  /** bumps on anything the screens show */
  version = 0;
  private stop = false;
  private snaps: Snapshot[] = [];
  private listeners = new Set<(e: SessionEvent | null) => void>();
  private quotes = new Map<string, Quote>();
  tf: TF;
  inds: IndSpec[];
  ticksPerBar: number;

  /** drawings on the charts, per market; they stay put when the replay steps back or jumps */
  readonly drawings = new DrawStore();

  constructor(x: SessionSetup) {
    this.name = x.name; this.tf = x.tf; this.inds = x.inds || []; this.ticksPerBar = x.ticksPerBar || 20;
    this.drawings.onChange = () => this.changed();
    this.feeds = x.markets.map(s => this.makeFeed(s, x.start));
    this.active = this.feeds[0].s.inst.sym;
    this.startTime = this.simTime = Math.max(...this.feeds.map(f => f.time));
    this.account = new Account(x.balance);
    this.account.quote = sym => this.quote(sym);
    this.account.onEvent = e => this.onAccount(e);
    this.takeSnap();
  }
  private makeFeed(s: Series, t: number) {
    let j = 0, b = s.n;
    while (j < b) { const m = (j + b) >> 1; if (s.t[m] < t) j = m + 1; else b = m; }
    return new Feed(s, j, this.tf, this.ticksPerBar, this.inds);
  }
  feed(sym: string) { return this.feeds.find(f => f.s.inst.sym === sym)!; }
  get activeFeed() { return this.feed(this.active); }
  quote(sym: string): Quote {
    const f = this.feed(sym), inst = f.s.inst;
    let q = this.quotes.get(sym);
    if (!q) { q = { price: null, spread: inst.spreadTicks * inst.tick, slip: inst.slipTicks * inst.tick, pv: inst.pv, comm: inst.comm, time: 0, barTime: 0, round: x => f.round(x) }; this.quotes.set(sym, q); }
    q.price = f.price; q.time = f.time; q.barTime = f.barTime;
    return q;
  }
  get endTime() { return Math.max(...this.feeds.map(f => f.s.t[f.s.n - 1] + f.s.base)); }
  get atEnd() { return this.feeds.every(f => f.done); }
  /** how far through the replay, 0 to 1 */
  get progress() { return Math.min(1, Math.max(0, (this.simTime - this.startTime) / Math.max(1, this.endTime - this.startTime))); }
  /** the time on the clock */
  get now() { return Math.max(this.simTime, ...this.feeds.map(f => f.time)); }

  subscribe(fn: (e: SessionEvent | null) => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  private emit(e: SessionEvent | null) { this.version++; for (const fn of this.listeners) fn(e); }
  changed() { this.emit(null); }
  private onAccount(e: AccountEvent) {
    if (e.kind === 'pause') { this.stop = true; this.playing = false; return; }
    if (e.kind === 'exit' && e.closed) this.journal.push(journalEntry(e.closed, this.feeds, this.account.hist));
    this.emit({ ...e, at: this.now });
  }

  /** the market whose tick comes next, and when */
  private next(): [Feed | null, number] {
    let best: Feed | null = null, bt = Infinity;
    for (const f of this.feeds) { const t = f.nextTickTime(); if (t < bt) { bt = t; best = f; } }
    return [best, bt];
  }
  private tickOne(f: Feed) {
    if (f.s.inst.sym === this.active && f.atCandleStart) this.takeSnap();
    const m = f.step();
    if (m) this.account.onTick(f.s.inst.sym, m.from, m.to, m.jump);
  }
  /** plays every tick up to time `target`, on all markets in time order */
  advanceTo(target: number) {
    let budget = 400000; this.stop = false;
    while (budget-- > 0 && !this.stop) {
      const [f, t] = this.next();
      if (!f || t > target) break;
      this.tickOne(f);
    }
    if (budget <= 0) this.simTime = this.now;
    this.account.trackDD();
    if (this.atEnd && this.playing) { this.playing = false; this.emit({ kind: 'placed', text: 'That is the end of the data.', at: this.now }); }
  }
  /** called on every animation frame; dt in seconds */
  frame(dt: number) {
    if (!this.playing) return false;
    const [, t] = this.next();
    // jump the clock over the market being closed
    if (isFinite(t) && t - this.simTime >= CLOSED_GAP) this.simTime = t;
    this.simTime += Math.min(0.25, dt) * this.speed;
    this.advanceTo(this.simTime);
    return true;
  }
  play() { if (this.atEnd) return; this.playing = true; this.changed(); }
  pause() { this.playing = false; this.changed(); }
  toggle() { this.playing ? this.pause() : this.play(); }

  /** one tick of the active market (the others catch up to its time) */
  stepTick() { this.playing = false; const f = this.activeFeed; if (f.done) return; const t = f.nextTickTime(); this.advanceTo(t); this.simTime = this.now; this.changed(); }
  /** to the end of the active market's current base bar */
  stepBar() {
    this.playing = false; const f = this.activeFeed; if (f.done) return;
    const i = f.i; this.stop = false;
    while (!this.stop && f.i === i && !f.done) { const [g] = this.next(); if (!g) break; this.tickOne(g); }
    this.simTime = this.now; this.changed();
  }
  /** to the close of the active market's current candle */
  stepCandle() {
    this.playing = false; const f = this.activeFeed; if (f.done) return;
    let n = 0; this.stop = false;
    while (!f.done && !this.stop) {
      if (n > 0 && f.atCandleStart) break;
      const [g] = this.next(); if (!g) break;
      this.tickOne(g); if (g === f) n++;
    }
    this.simTime = this.now; this.changed();
  }

  /* ---- going back: a snapshot at the start of each candle of the active market ---- */
  private takeSnap() {
    const last = this.snaps[this.snaps.length - 1], t = this.activeFeed.nextTickTime();
    if (last && last.time >= t) return;
    this.snaps.push({ time: isFinite(t) ? t : this.now, feeds: this.feeds.map(f => f.snap()), account: this.account.state(), journal: this.journal.length });
    if (this.snaps.length > 3000) this.snaps.splice(1, 500); // keep the very first (the session start)
  }
  private restore(x: Snapshot) {
    this.feeds.forEach((f, k) => f.restore(x.feeds[k]));
    this.account.load(x.account);
    this.journal.length = Math.min(this.journal.length, x.journal);
    this.simTime = x.time;
  }
  get canStepBack() { return this.snaps.length > 0 && this.snaps[0].time < this.now - 1e-6; }
  /** back one candle of the active market (trades and orders return to how they were then) */
  stepBack() {
    this.playing = false;
    // the latest candle start before now: the candle playing (or just finished) comes off the chart
    const now = this.activeFeed.time;
    let j = this.snaps.length - 1;
    while (j > 0 && this.snaps[j].time >= now) j--;
    const s = this.snaps[j]; if (!s) return;
    this.snaps.length = j + 1;
    this.restore(s);
    this.changed();
  }
  /** jumps to time t: forward plays there quickly (orders still fill), back returns to the closest snapshot first */
  async jumpTo(t: number, progress?: (f: number) => void): Promise<void> {
    this.playing = false;
    if (t < this.now) {
      let j = this.snaps.length - 1;
      while (j > 0 && this.snaps[j].time > t) j--;
      this.snaps.length = j + 1;
      this.restore(this.snaps[j]);
    }
    const from = this.now; this.stop = false;
    while (!this.stop && !this.atEnd) {
      const [f, tn] = this.next(); if (!f || tn > t) break;
      let budget = 80000;
      while (budget-- > 0 && !this.stop) {
        const [g, tg] = this.next(); if (!g || tg > t) break;
        const sym = g.s.inst.sym;
        // nothing can fill on this market: play its bar in one step
        if (g.k === 0 && !this.account.trades.some(x => x.sym === sym) && !this.account.orders.some(x => x.sym === sym) && g.s.t[g.i] + g.s.base <= t) {
          if (sym === this.active && g.atCandleStart) this.takeSnap();
          g.skipBar();
        } else this.tickOne(g);
      }
      progress?.(Math.min(1, (this.now - from) / Math.max(1, t - from)));
      await new Promise(r => setTimeout(r, 0));
    }
    this.simTime = Math.max(this.now, Math.min(t, this.endTime));
    this.account.trackDD();
    this.changed();
  }

  /* ---- trading ---- */
  order(side: Side, type: 'market' | 'limit' | 'stop', price: number, sl: number | null, tp: number | null, qty: number, sym = this.active) {
    const err = this.account.submit(sym, side, type, price, sl, tp, qty);
    this.changed();
    return err;
  }

  /* ---- what the charts show ---- */
  setTf(tf: TF) { this.tf = tf; for (const f of this.feeds) f.setTf(tf); this.changed(); }
  setInds(inds: IndSpec[]) { this.inds = inds; for (const f of this.feeds) f.setInds(inds); this.changed(); }
  setActive(sym: string) { if (this.active !== sym) { this.active = sym; this.changed(); } }
  /** another market on the same clock, from now on */
  addMarket(s: Series) {
    if (this.feeds.some(f => f.s.inst.sym === s.inst.sym)) return;
    this.feeds.push(this.makeFeed(s, this.now));
    this.snaps = []; this.takeSnap(); // older snapshots don't know this market
    this.changed();
  }
  removeMarket(sym: string) {
    if (this.feeds.length < 2) return;
    this.account.closeAll(sym); this.account.cancelAll(sym);
    this.feeds = this.feeds.filter(f => f.s.inst.sym !== sym);
    if (this.active === sym) this.active = this.feeds[0].s.inst.sym;
    this.snaps = []; this.takeSnap();
    this.changed();
  }
}
