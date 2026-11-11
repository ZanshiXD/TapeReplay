// A replay session: one or more markets on one clock, one account trading all of them, and the journal. The screens
// drive it with play/pause and the step buttons, and call frame() on every animation frame while playing.
import { Account, type AccountEvent, type AccountSnap, type AccountState, type Quote, type Side } from './account';
import { Feed, type FeedSnap } from './feed';
import { DrawStore, type Drawing } from './drawings';
import { startProp, type PropConfig, type PropState, type RulesConfig, type RulesState, type PropSim, type PropRules } from './prop';
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
  /** prop firm rules: the simulation (evaluation, funded, live) or the plain rules of older sessions */
  prop?: PropSetup | null;
}
export interface PropSetup { sim?: Partial<PropConfig> | null; prop?: Partial<RulesConfig> | null }
export interface SessionEvent extends Omit<AccountEvent, 'kind'> { kind: AccountEvent['kind'] | 'prop'; at: number }
/** everything needed to reopen a session where it was left, given the same markets */
export interface SessionState {
  v: 2; simTime: number; active: string; speed: number; tf: TF; inds: IndSpec[];
  /** each market's place: the time of the next bar to play (null at the end) */
  feeds: Array<{ sym: string; at: number | null }>;
  account: AccountState; journal: JournalEntry[]; drawings: Drawing[];
  prop?: { setup: PropSetup; state: PropState | RulesState } | null;
}
interface Snapshot { time: number; feeds: FeedSnap[]; account: AccountSnap; journal: number; prop: PropState | RulesState | null }

/** a quiet stretch this long (the daily break, nights, weekends) is jumped over rather than played in real time */
const CLOSED_GAP = 600;
/** most of a frame (ms) the replay may spend playing ticks; the charts draw in the rest */
const FRAME_BUDGET = 10;
/** while playing, at least one tick about this often (real seconds): at slow speeds bars get more ticks (up to 600;
 *  the setting in Settings is the least), so a 1-minute bar at 1x moves several times a second, not every 3 seconds */
const TICK_EVERY = 0.15;

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
  /** the time of the last tick played */
  private lastTick = -Infinity;
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
    this.propSetup = x.prop || null;
    this.startProp();
    this.takeSnap();
  }
  /** the prop rules in effect (null when none) */
  prop: PropSim | PropRules | null = null;
  propSetup: PropSetup | null = null;
  private startProp(state?: PropState | RulesState) {
    this.prop = this.propSetup ? startProp(this.propSetup, this.account, { state }) : null;
    if (this.prop) this.prop.onEvent = e => {
      if (e.pause) { this.stop = true; this.playing = false; }
      this.emit({ kind: 'prop', text: e.text, up: e.up ?? (e.kind === 'pass' || e.kind === 'payout' || e.kind === 'live'), at: this.now } as SessionEvent);
    };
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
  /** tells the screens; a screen that fails can't stop the replay half-way through a tick */
  private emit(e: SessionEvent | null) {
    this.version++;
    for (const fn of this.listeners) { try { fn(e); } catch (err) { console.warn('Tape Replay: a screen failed to update', err); } }
  }
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
    this.lastTick = f.nextTickTime();
    const m = f.step();
    if (m) { this.account.onTick(f.s.inst.sym, m.from, m.to, m.jump); this.prop?.onTick(f.time); }
  }
  /** plays every tick up to time `target`, on all markets in time order, and moves the clock there. With a time budget
   *  (ms) it stops when the budget is spent and the clock waits at the last tick played (it never runs ahead of the
   *  prices, and never goes back), so one frame never blocks the page: at a speed the computer can't keep up with,
   *  the tape plays as fast as it can, evenly, instead of piling up a backlog. A fill that pauses stops it there too. */
  advanceTo(target: number, budgetMs = Infinity) {
    let budget = 400000, n = 0, cut = false; this.stop = false;
    const until = budgetMs < Infinity ? performance.now() + budgetMs : Infinity;
    while (!this.stop) {
      const [f, t] = this.next();
      if (!f || t > target) break;
      this.tickOne(f);
      if (--budget <= 0 || ((++n & 7) === 0 && performance.now() > until)) { cut = true; break; }
    }
    this.simTime = Math.max(this.simTime, cut || this.stop ? Math.min(target, this.lastTick) : target);
    this.account.trackDD();
    if (this.atEnd && this.playing) { this.playing = false; this.emit({ kind: 'placed', text: 'That is the end of the data.', at: this.now }); }
  }
  /** called on every animation frame; dt in seconds */
  frame(dt: number) {
    if (!this.playing) return false;
    // at slow speeds, more ticks in each bar so the price keeps moving (a new speed applies to the bar playing at once)
    for (const f of this.feeds) f.setPace(Math.min(600, Math.ceil(f.s.base / (Math.max(0.01, this.speed) * TICK_EVERY))));
    const [, t] = this.next();
    // jump the clock over the market being closed
    if (isFinite(t) && t - this.simTime >= CLOSED_GAP) this.simTime = t;
    this.advanceTo(this.simTime + Math.min(0.25, dt) * this.speed, FRAME_BUDGET);
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
    this.snaps.push({ time: isFinite(t) ? t : this.now, feeds: this.feeds.map(f => f.snap()), account: this.account.snap(), journal: this.journal.length, prop: this.prop ? this.prop.state() : null });
    if (this.snaps.length > 3000) this.snaps.splice(1, 500); // keep the very first (the session start)
  }
  private restore(x: Snapshot) {
    this.feeds.forEach((f, k) => f.restore(x.feeds[k]));
    this.account.restoreSnap(x.account);
    if (this.prop && x.prop) (this.prop.load as (s: PropState | RulesState) => void)(x.prop);
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
    for (const f of this.feeds) f.setPace(0); // the bars on the way get the usual ticks (a jump plays them unseen)
    if (t < this.now) {
      let j = this.snaps.length - 1;
      while (j > 0 && this.snaps[j].time > t) j--;
      this.snaps.length = j + 1;
      this.restore(this.snaps[j]);
    }
    const from = this.now; this.stop = false;
    while (!this.stop && !this.atEnd) {
      const [f, tn] = this.next(); if (!f || tn > t) break;
      let budget = 80000; const until = performance.now() + 40;
      while (budget-- > 0 && !this.stop && ((budget & 63) !== 0 || performance.now() < until)) {
        const [g, tg] = this.next(); if (!g || tg > t) break;
        const sym = g.s.inst.sym;
        // nothing can fill on this market: play its bar in one step
        if (g.k === 0 && !this.account.trades.some(x => x.sym === sym) && !this.account.orders.some(x => x.sym === sym) && g.s.t[g.i] + g.s.base <= t && (!this.prop || this.prop.canSkipBar(g.s.t[g.i] + g.s.base))) {
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
    const rule = this.prop?.check(sym, side, qty);
    if (rule) { this.emit({ kind: 'error', text: rule, at: this.now }); return rule; }
    const err = this.account.submit(sym, side, type, price, sl, tp, qty);
    this.changed();
    return err;
  }

  /* ---- saving and reopening ---- */
  /** what to save: copied by default; with copy=false the parts are the session's own (for writing out at once) */
  state(copy = true): SessionState {
    return {
      v: 2, simTime: this.simTime, active: this.active, speed: this.speed, tf: this.tf, inds: this.inds,
      feeds: this.feeds.map(f => ({ sym: f.s.inst.sym, at: f.i < f.s.n ? f.s.t[f.i] : null })),
      account: copy ? this.account.state() : this.account.plain(), journal: this.journal, drawings: this.drawings.state(),
      prop: this.prop && this.propSetup ? { setup: this.propSetup, state: this.prop.state() } : null,
    };
  }
  /** puts a session back where state() left it (its markets already loaded the same way) */
  load(x: SessionState) {
    this.tf = x.tf; this.inds = x.inds; this.speed = x.speed || this.speed;
    for (const f of this.feeds) {
      const p = x.feeds.find(q => q.sym === f.s.inst.sym);
      f.configure(x.tf, x.inds);
      f.seek(p ? (p.at == null ? Infinity : p.at) : f.time);
    }
    if (this.feeds.some(f => f.s.inst.sym === x.active)) this.active = x.active;
    this.account.load(x.account);
    if (x.prop) { this.propSetup = x.prop.setup; this.startProp(x.prop.state); } else { this.propSetup = null; this.prop = null; }
    this.journal = x.journal || [];
    this.drawings.load(x.drawings || []);
    this.simTime = Math.max(x.simTime, ...this.feeds.map(f => f.time));
    this.snaps = []; this.takeSnap();
    this.changed();
  }
  /** more bars for a market that plays on past what was loaded (a long series, a month at a time) */
  extend(sym: string, more: { t: Float64Array; o: ArrayLike<number>; h: ArrayLike<number>; l: ArrayLike<number>; c: ArrayLike<number>; v: ArrayLike<number>; n: number }) {
    const f = this.feeds.find(x => x.s.inst.sym === sym); if (!f || !more.n) return;
    f.append(more);
  }
  /** lets go of a market's bars before time t (memory stays level however long the replay plays) */
  trim(sym: string, t: number) {
    const f = this.feeds.find(x => x.s.inst.sym === sym); if (!f) return;
    if (f.dropBefore(t) > 0) { this.snaps = []; this.takeSnap(); }
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
