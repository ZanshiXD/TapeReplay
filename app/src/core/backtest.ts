// Backtests on the new core: a strategy (Python in Pyodide, or JavaScript) trading one market, its Feed and an
// Account driven directly (not through Session, which snapshots the account at every candle). What a strategy
// sees and when:
//   - per tick: the engine's fills (working orders, stops, targets), then the strategy's queued market orders and
//     close() at this tick's price, then on_fill for every fill of the tick, then on_tick, then on_bar when the tick
//     closed a candle of the strategy's timeframe
//   - market orders and ctx.close() fill on the next tick: from on_bar, the next base bar's open
//   - strategy candles are made from the bars' own columns, from the run's start (no warm-up history)
// and adds batching so the strategy is called far less often (see Bridge.batch): candles while nothing can fill,
// ticks up to the first one that could, fills of a tick together, console text once per slice.
import { Account, smoney, money, type Closed, type FillEvent, type Quote, type Side } from './account';
import { Feed } from './feed';
import type { Series } from './series';
import { lowerBound, makeBucket, tfLabel, zoneOff, type TF } from './time';

export type Mode = 'bar' | 'tick';
export type Setting = number | boolean | string;
export type LogKind = 'pr' | 'er' | 'ok';
export type LogLine = [text: string, kind: LogKind];

/** costs per side: commission in dollars per contract; spread and slippage in ticks of the instrument. Price-unit
 * settings convert as spreadTicks = spread / tick and slipTicks = slip / tick (a percent
 * commission has no equivalent here: per contract only). */
export interface Costs { comm: number; spreadTicks: number; slipTicks: number }

/** prop rules and the prop simulation, when they come to the core: checked at each tick like a replay's */
export interface RunRules {
  /** once, before the first bar: the run's account (its quote has the price and time), and the console (lines get
   * the time in front) */
  start?(account: Account, log?: (text: string, kind: LogKind) => void): void;
  /** true when nothing can change for the rules from now to t1 while flat (the fast path's gate) */
  idle(t1: number): boolean;
  /** after each tick's engine fills, before the strategy's queued orders: a message ends the run; {restarted} carries
   * on with a fresh account (a new prop evaluation): the queued orders are dropped and the text logged */
  afterTick(): string | { restarted: string } | null;
  /** why an order that adds `adds` contracts is refused, or null */
  block(adds: number): string | null;
}

export interface RunConfig {
  series: Series;
  /** the dates traded, UTC seconds: from inclusive, to exclusive (or bar indexes: startIdx, endIdx exclusive) */
  from?: number; to?: number; startIdx?: number; endIdx?: number;
  /** the strategy's candles */
  tf: TF;
  mode: Mode;
  balance: number;
  /** ctx.default_qty (Session size) */
  qty?: number;
  /** simulated ticks per base bar (4..600), default 20 */
  ticksPerBar?: number;
  hedge?: boolean;
  costs?: Partial<Costs>;
  /** ctx.symbol, default the instrument's code */
  name?: string;
  overrides?: Record<string, Setting>;
  /** optimizer runs: print() does nothing and no console lines are kept */
  quiet?: boolean;
  /** about how many points the equity curve keeps, default 5000 */
  eqPoints?: number;
  rules?: RunRules;
  /** skip bars whole only when there are no orders and no trades, the plain path (comparisons, benchmarks) */
  plainPath?: boolean;
}

export interface Progress { done: number; time: number; trades: number; status: string }
export interface RunHooks {
  /** between slices of work: progress, then this is awaited (yield to the page here; the default yields a task) */
  slice?: ((p: Progress) => void | Promise<void>) | null;
  /** console lines, as they come (once per slice) */
  log?: (lines: LogLine[]) => void;
  /** checked between slices: true stops the run */
  stopped?: () => boolean;
  /** milliseconds of work per slice, default 30; 0 runs to the end without yielding (workers) */
  sliceMs?: number;
}

export interface EqPoint { time: number; value: number }
export interface RunResult {
  fail: string | null; stopped: boolean; ended: string; secs: number;
  /** bar indexes [start, end) and their times; bars run; how far it got (0..1) */
  start: number; end: number; from: number; to: number; bars: number; candles: number; done: number;
  account: Account; stats: Stats; eq: EqPoint[];
  /** order rejections by kind (prices replaced by ()), with counts */
  rejects: Array<[string, number]>;
  /** the console, when no log hook took it (the last 1500 lines) */
  log: LogLine[];
}

/* ---- the bridge: what a strategy implementation offers the runner ---- */
export interface StratInfo { name: string; tf: string; tick: number; pv: number; spread: number; qty: number; prec: number; mode: Mode; balance: number; quiet: boolean; overrides: Record<string, Setting> }
export interface FillOut { side: 'buy' | 'sell'; qty: number; price: number; kind: 'entry' | 'exit'; reason: string; id: number; pnl: number | null; time: number; off: number }
export interface OrderOut { id: number; side: 'buy' | 'sell'; type: 'limit' | 'stop'; price: number; qty: number; sl: number | null; tp: number | null }
export interface TradeOut { id: number; side: 'long' | 'short'; qty: number; entry: number; sl: number | null; tp: number | null; pnl: number }
export interface HistOut { id: number; side: 'long' | 'short'; qty: number; entry: number; exit: number; reason: string; pnl: number; entry_time: number; exit_time: number }
/** the account for a strategy: version, net position and average, balance, closed trade count, open trades
 * [id, side, qty, entry, sl, tp] and working orders [id, side, type, price, qty, sl, tp] */
export interface StateOut { v: number; pos: number; avg: number | null; bal: number; nh: number; tr: Array<[number, number, number, number, number | null, number | null]>; od: Array<[number, number, string, number, number, number | null, number | null]> }
/** what the strategy's ctx calls (objects, not JSON) */
export interface StratApi {
  submit(side: number, type: string, price: number | null | undefined, sl: number | null | undefined, tp: number | null | undefined, qty: number): { ok?: boolean; id?: number; error?: string };
  closeAll(): void;
  cancel(id: number): boolean;
  bracket(sl: number | null | undefined, tp: number | null | undefined): boolean;
  orders(): OrderOut[];
  trades(): TradeOut[];
  history(from: number): HistOut[];
  state(): StateOut;
  /** [position, average or null, equity, balance], as the per-call _tr_* functions take it */
  state4(): [number, number | null, number, number];
  /** inside a batch: play the engine up to item i (candle or tick) before an order is checked */
  sync(i: number): void;
}
export interface Bridge {
  /** true: takes many candles or ticks per call and stops after the first whose hook acted (calling api.sync first) */
  readonly batch: boolean;
  start(api: StratApi, info: StratInfo): { error?: string; on_bar?: boolean; on_tick?: boolean; on_fill?: boolean };
  /** candles, 7 numbers each: open time, open, high, low, close, volume, zone offset; the number run, or an error */
  bars(buf: Float64Array, n: number, ver: number): number | string;
  /** ticks, 3 numbers each: time, price, zone offset; the number run, or an error */
  ticks(buf: Float64Array, n: number, ver: number): number | string;
  fills(list: FillOut[], ver: number, px: number | null): string | null;
  end(ver: number, px: number | null): string | null;
  /** console text since the last call */
  flush(): LogLine[];
}

/* ---- formatting ---- */
/** "YYYY-MM-DD HH:MM:SS" in the chart zone */
export const fmtDT = (s: number) => isFinite(s) ? new Date((s + zoneOff(s)) * 1000).toISOString().slice(0, 19).replace('T', ' ') : '—';
export const fmtDay = (s: number) => isFinite(s) ? fmtDT(s).slice(0, 16) : '—';
export const optFmt = (v: Setting) => typeof v === 'boolean' ? (v ? 'True' : 'False') : typeof v === 'string' ? v : String(+(+v).toPrecision(10));
export const optLabel = (o: Record<string, Setting>) => Object.entries(o).map(([k, v]) => `${k}=${optFmt(v)}`).join(', ');
const round2 = (x: number) => Math.round(x * 100) / 100;
const now = () => performance.now();
/** a macrotask: lets the page paint and handle input between slices */
export const yieldTask: () => Promise<void> = (() => {
  if (typeof MessageChannel !== 'function' || (globalThis as any).process?.versions?.node) return () => new Promise<void>(r => setTimeout(r, 0));
  const ch = new MessageChannel(), waiting: Array<() => void> = [];
  ch.port1.onmessage = () => { const r = waiting.shift(); if (r) r(); };
  return () => new Promise<void>(r => { waiting.push(r); ch.port2.postMessage(0); });
})();

/* ---- statistics ---- */
export interface Stats {
  trades: number; net: number; winRate: number | null; pf: number | 'inf' | null; ret: number; equity: number; balance: number; start: number;
  maxDD: number; maxDDpct: number; open: number;
  wins: number; losses: number; grossWin: number; grossLoss: number;
  avgWin: number | null; avgLoss: number | null; expectancy: number | null; largestWin: number | null; largestLoss: number | null;
  maxLosingStreak: number; maxWinningStreak: number; longs: number; shorts: number;
  /** mean seconds from entry to exit */
  avgHold: number | null; costs: number;
}
/** the stats over closed trades; losses are trades with net <= 0 */
export function computeStats(acc: Account): Stats {
  const h = acc.hist, n = h.length;
  let wins = 0, gw = 0, gl = 0, lw: number | null = null, ll: number | null = null, streak = 0, maxL = 0, ws = 0, maxW = 0, longs = 0, hold = 0, costs = 0;
  for (const x of h) {
    if (x.net > 0) { wins++; gw += x.net; if (lw == null || x.net > lw) lw = x.net; ws++; streak = 0; }
    else { gl -= x.net; if (ll == null || x.net < ll) ll = x.net; streak++; ws = 0; }
    if (streak > maxL) maxL = streak; if (ws > maxW) maxW = ws;
    if (x.side > 0) longs++;
    hold += x.exitTime - x.time; costs += x.comm;
  }
  const net = gw - gl, eq = acc.equity(), losses = n - wins;
  return {
    trades: n, net, winRate: n ? wins / n * 100 : null, pf: gl > 0 ? gw / gl : (gw > 0 ? 'inf' : null),
    ret: (eq - acc.start) / acc.start * 100, equity: eq, balance: acc.balance, start: acc.start, maxDD: acc.maxDD, maxDDpct: acc.maxDDpct, open: acc.trades.length,
    wins, losses, grossWin: gw, grossLoss: gl,
    avgWin: wins ? gw / wins : null, avgLoss: losses ? -gl / losses : null, expectancy: n ? net / n : null, largestWin: lw, largestLoss: ll,
    maxLosingStreak: maxL, maxWinningStreak: maxW, longs, shorts: n - longs, avgHold: n ? hold / n : null, costs,
  };
}
/** the stats of some closed trades (one prop account's) from a starting balance; the drawdown is on closed P&L */
export function histStats(hist: Closed[], start: number): Stats {
  let bal = start, peak = start, dd = 0, ddp = 0;
  for (const x of hist) { bal += x.net; if (bal > peak) peak = bal; if (peak - bal > dd) { dd = peak - bal; ddp = dd / peak * 100; } }
  return computeStats({ hist, start, balance: bal, equity: () => bal, maxDD: dd, maxDDpct: ddp, trades: [] } as unknown as Account);
}
/** the stats grid as [label, text] rows */
export function statsRows(s: Stats): Array<[string, string]> {
  const dur = (x: number) => x >= 86400 ? (x / 86400).toFixed(1) + 'd' : x >= 3600 ? (x / 3600).toFixed(1) + 'h' : Math.round(x / 60) + 'm';
  return [
    ['Net P&L', smoney(s.net)], ['Trades', String(s.trades)], ['Win rate', s.winRate == null ? '—' : s.winRate.toFixed(1) + '%'],
    ['Profit factor', s.pf === 'inf' ? '∞' : s.pf == null ? '—' : s.pf.toFixed(2)],
    ['Avg win', s.avgWin == null ? '—' : money(s.avgWin)], ['Avg loss', s.avgLoss == null ? '—' : money(s.avgLoss)],
    ['Expectancy / trade', s.expectancy == null ? '—' : smoney(s.expectancy)], ['Largest win', s.largestWin == null ? '—' : money(s.largestWin)],
    ['Largest loss', s.largestLoss == null ? '—' : money(s.largestLoss)], ['Max losing streak', String(s.maxLosingStreak)],
    ['Long / short', `${s.longs} / ${s.shorts}`], ['Avg hold', s.avgHold == null ? '—' : dur(s.avgHold)], ['Costs paid', money(s.costs)],
    ['Max drawdown', s.maxDD ? `${money(s.maxDD)} (${s.maxDDpct.toFixed(1)}%)` : '$0.00'],
  ];
}
/** closed trades as CSV: times in the chart zone */
export function tradesCsv(hist: Closed[]): string {
  const rows: Array<Array<string | number>> = [['id', 'side', 'size', 'entry_time', 'entry', 'exit_time', 'exit', 'exit_by', 'stop_loss', 'take_profit', 'gross', 'costs', 'net']];
  for (const h of hist) rows.push([h.id, h.side > 0 ? 'long' : 'short', h.qty, fmtDT(h.time), h.entry, fmtDT(h.exitTime), h.exit, h.reason, h.sl ?? '', h.tp ?? '', h.gross.toFixed(2), h.comm.toFixed(2), h.net.toFixed(2)]);
  return rows.map(r => r.join(',')).join('\n');
}
/** the run's summary line, the console's last line */
export const summaryLine = (s: Stats): LogLine => [`${s.trades} trades, net ${smoney(s.net)}${s.open ? `, ${s.open} still open` : ''}.`, s.net >= 0 ? 'ok' : 'er'];

const MAX_LOG = 1500, SLICE_MS = 30;

/** one backtest: the strategy behind `bridge` from cfg's start to its end */
export async function runBacktest(cfg: RunConfig, bridge: Bridge, hooks: RunHooks = {}): Promise<RunResult> {
  const s = cfg.series, inst = s.inst, sym = inst.sym, prec = inst.prec, pow = 10 ** prec;
  const costs: Costs = { comm: inst.comm, spreadTicks: inst.spreadTicks, slipTicks: inst.slipTicks, ...cfg.costs };
  const spread = costs.spreadTicks * inst.tick, slip = costs.slipTicks * inst.tick;
  const rp = (x: number) => Math.round(x * pow) / pow;
  const start = Math.max(1, Math.min(cfg.startIdx ?? lowerBound(s.t, cfg.from ?? -Infinity), s.n - 1));
  const end = Math.max(start + 1, Math.min(cfg.endIdx ?? lowerBound(s.t, cfg.to ?? Infinity), s.n));
  const total = end - start, quiet = !!cfg.quiet, tf = cfg.tf, mode = cfg.mode, rules = cfg.rules || null;
  const sliceMs = hooks.sliceMs ?? SLICE_MS, slice = hooks.slice === undefined ? (sliceMs > 0 ? yieldTask : null) : hooks.slice;
  const t0 = now();

  const feed = new Feed(s, start, tf, cfg.ticksPerBar ?? 20, [], false);
  const account = new Account(cfg.balance);
  account.hedge = !!cfg.hedge; account.wording = 'strategy';
  const q: Quote = { price: feed.price, spread, slip, pv: inst.pv, comm: costs.comm, time: feed.time, barTime: feed.barTime, round: x => feed.round(x) };
  const sync = () => { q.price = feed.price; q.time = feed.time; q.barTime = feed.barTime; };
  account.quote = () => q;
  const fills: FillEvent[] = [];
  account.onFill = f => fills.push(f);
  type Pend = { k: 'mkt'; side: Side; qty: number; sl: number | null; tp: number | null; id: number } | { k: 'close' };
  let pending: Pend[] = [];

  // the console: lines are kept (or handed to hooks.log) once per slice; the strategy's own text is drained first
  // whenever a line is added here, so the two stay in order
  const out: LogLine[] = [], logged: LogLine[] = [];
  const drain = () => { for (const x of bridge.flush()) out.push(x); };
  const log = (text: string, kind: LogKind) => { if (quiet) return; drain(); out.push([text, kind]); };
  const emit = () => {
    drain();
    if (!out.length) return;
    if (hooks.log) hooks.log(out.splice(0));
    else { for (const x of out) logged.push(x); out.length = 0; if (logged.length > MAX_LOG) logged.splice(0, logged.length - MAX_LOG); }
  };
  const rejects = new Map<string, number>();
  let shown = 0;
  const reject = (msg: string) => {
    const key = msg.replace(/\([^)]*\)/g, '()'), n = (rejects.get(key) || 0) + 1;
    rejects.set(key, n);
    if (n === 1 && shown++ < 20) log(`${fmtDay(feed.time)} ${msg}`, 'er');
  };

  // the equity curve: the start, then about eqPoints points (the end of every stride-th base bar)
  const eq: EqPoint[] = [], eqStride = Math.max(1, Math.floor(total / (cfg.eqPoints ?? 5000)));
  const pushEq = (t: number, v: number) => { const last = eq[eq.length - 1]; if (!last || t > last.time) eq.push({ time: t, value: round2(v) }); else last.value = round2(v); };
  pushEq(s.t[start - 1], account.balance);
  const barEnd = (i: number) => { account.trackDD(); if ((i - start) % eqStride === 0) pushEq(s.t[i], account.equity()); };

  /* ---- what the strategy calls ---- */
  const orderOut = (): OrderOut[] => account.orders.map(o => ({ id: o.id, side: o.side > 0 ? 'buy' : 'sell', type: o.type, price: o.price, qty: o.qty, sl: o.sl ?? null, tp: o.tp ?? null }));
  let batch: { bars: boolean; ends: number[]; done: number } | null = null;
  const api: StratApi = {
    submit(side, type, price, sl, tp, qty) {
      const sd = (side > 0 ? 1 : -1) as Side, s2 = sl == null ? null : rp(sl), t2 = tp == null ? null : rp(tp);
      if (type === 'market') { // fills on the next tick, like close()
        const id = account.nextId++;
        pending.push({ k: 'mkt', side: sd, qty, sl: s2, tp: t2, id });
        return { ok: true, id };
      }
      const adds = addsOf(sd, qty), pb = rules && rules.block(adds);
      if (pb) return { error: pb };
      const id = account.nextId, err = account.submit(sym, sd, type as 'limit' | 'stop', rp(price ?? NaN), s2, t2, qty);
      return err ? { error: err } : account.orders.some(o => o.id === id) ? { ok: true, id } : { error: 'The order was not placed.' };
    },
    closeAll() { pending.push({ k: 'close' }); },
    cancel(id) {
      const n = account.orders.length;
      account.orders = id < 0 ? [] : account.orders.filter(o => o.id !== id);
      if (account.orders.length === n) return false;
      account.version++; return true;
    },
    bracket(sl, tp) {
      for (const tr of account.trades) { if (sl != null) { tr.sl = rp(sl); tr.sl0 ??= tr.sl; } if (tp != null) tr.tp = rp(tp); }
      if (!account.trades.length || (sl == null && tp == null)) return false;
      account.version++; return true;
    },
    orders: orderOut,
    trades: () => account.trades.map(t => ({ id: t.id, side: t.side > 0 ? 'long' : 'short', qty: t.qty, entry: t.entry, sl: t.sl ?? null, tp: t.tp ?? null, pnl: account.unreal(t) })),
    history: from => account.hist.slice(from || 0).map(h => ({ id: h.id, side: h.side > 0 ? 'long' : 'short', qty: h.qty, entry: h.entry, exit: h.exit, reason: h.reason, pnl: h.net, entry_time: h.time, exit_time: h.exitTime })),
    state() {
      const n = account.netPosition(sym);
      return { v: account.version, pos: n.q, avg: n.q ? n.avg : null, bal: account.balance, nh: account.hist.length,
               tr: account.trades.map(t => [t.id, t.side, t.qty, t.entry, t.sl ?? null, t.tp ?? null]),
               od: account.orders.map(o => [o.id, o.side, o.type, o.price, o.qty, o.sl ?? null, o.tp ?? null]) };
    },
    state4() { const n = account.netPosition(sym); return [n.q, n.q ? n.avg : null, account.equity(), account.balance]; },
    sync(i) { if (batch) (batch.bars ? playBars : playTicks)(i); },
  };
  const addsOf = (side: Side, qty: number) => { const n = account.netPosition(sym).q; return account.hedge ? qty : Math.max(0, Math.abs(n + side * qty) - Math.abs(n)); };
  // market orders and closes the strategy queued, at this tick's price (the same checks as an order ticket)
  const execPending = () => {
    const list = pending; pending = [];
    for (const p of list) {
      if (p.k === 'close') { account.closeAll(sym, 'Strategy close'); continue; }
      const err = (rules && rules.block(addsOf(p.side, p.qty))) || account.check(sym, p.side, 'market', 0, p.sl, p.tp);
      if (err) { reject('Order rejected: ' + err); continue; }
      account.openTrade(sym, p.side, p.qty, p.side > 0 ? account.ask(sym)! + slip : account.bid(sym)! - slip, p.sl, p.tp, 'Market', false, p.id);
    }
  };
  const deliverFills = (on: boolean): string | null => {
    const list = fills.splice(0);
    if (!on) return null;
    const off = zoneOff(feed.time);
    return bridge.fills(list.map(f => ({ side: f.side > 0 ? 'buy' : 'sell', qty: f.qty, price: f.price, kind: f.kind, reason: f.reason, id: f.id, pnl: f.pnl, time: feed.time, off })), account.version, q.price);
  };

  /* ---- bars where nothing can fill, and batches ---- */
  // A bar is quiet when no working order, stop or target lies within its price range (its rounded high and low, the
  // close before it): its ticks can fill nothing, so it is skipped whole (Feed.skipBar), the same end state as
  // playing them. cfg.plainPath skips only bars with no orders and no trades.
  const quiet0 = (j: number, pLo: number, pHi: number) => {
    if (!account.orders.length && !account.trades.length) return true;
    if (cfg.plainPath) return false;
    const l = s.l[j], h = s.h[j];
    return !account.wouldFill(sym, Math.min(pLo, l, feed.round(l)), Math.max(pHi, h, feed.round(h)), false);
  };
  const quietNow = () => quiet0(feed.i, feed.prevClose ?? feed.price ?? s.o[feed.i], feed.prevClose ?? feed.price ?? s.o[feed.i]);
  // skips bar feed.i; open trades see its lowest and highest tick (best and worst prices, as onTick would)
  const skip = () => {
    const x = feed.i;
    if (account.trades.length) { // a bar's ticks reach its low and high exactly (rounded, unless the bar is flat)
      const h = s.h[x], l = s.l[x], fl = h === l, p0 = feed.prevClose ?? s.o[x];
      const lo = Math.min(p0, fl ? l : feed.round(l)), hi = Math.max(p0, fl ? h : feed.round(h));
      for (const tr of account.trades) if (tr.side > 0) { if (hi > tr.best) tr.best = hi; if (lo < tr.worst) tr.worst = lo; } else { if (lo < tr.best) tr.best = lo; if (hi > tr.worst) tr.worst = hi; }
    }
    feed.skipBar(); sync(); barEnd(x);
  };
  let buf = new Float64Array(7 * 64);
  const room = (n: number) => { if (buf.length < n) { const b = new Float64Array(Math.max(n, buf.length * 2)); b.set(buf); buf = b; } };
  // quiet bars ahead: the candles that close in them, to the strategy all at once
  // a batch grows while the strategy lets whole batches pass, and starts small again after it acts (scanning bars
  // ahead that a strategy acting on the next candle never reaches would cost more than it saves)
  const BATCH_BARS = 20000, BATCH_CANDLES = 512;
  let want = 2;
  let C: { time: number; o: number; h: number; l: number; c: number; v: number } | null = null;
  const bucketOf = makeBucket(tf);
  const ends: number[] = [];
  function playBars(ci: number) { // the base bars of candles up to ci, skipped (nothing can fill)
    const b = batch!, to = ends[ci];
    while (feed.i < to) skip();
    sync(); b.done = Math.max(b.done, ci + 1); C = null;
  }
  const flatBatch = (): string | null => {
    let j = feed.i, nc = 0, c = C ? { ...C } : null;
    ends.length = 0;
    while (j < end && j - feed.i < BATCH_BARS && nc < want) {
      if (rules && !rules.idle(s.t[j] + s.base)) break;
      if (j > feed.i) { const pc = s.c[j - 1], rc = feed.round(pc); if (!quiet0(j, Math.min(pc, rc), Math.max(pc, rc))) break; }
      const v = s.v[j] || 0;
      if (!c) c = { time: bucketOf(s.t[j]), o: s.o[j], h: s.h[j], l: s.l[j], c: s.c[j], v };
      else { if (s.h[j] > c.h) c.h = s.h[j]; if (s.l[j] < c.l) c.l = s.l[j]; c.c = s.c[j]; c.v += v; }
      j++;
      if (j >= end || bucketOf(s.t[j]) !== c.time) {
        room(7 * (nc + 1));
        const k = 7 * nc; buf[k] = c.time; buf[k + 1] = c.o; buf[k + 2] = c.h; buf[k + 3] = c.l; buf[k + 4] = c.c; buf[k + 5] = c.v; buf[k + 6] = zoneOff(c.time);
        ends[nc++] = j; c = null;
      }
    }
    if (!nc) { // no candle closes within reach: skip the bars, the candle keeps forming
      while (feed.i < j) skip();
      sync(); C = c; return null;
    }
    batch = { bars: true, ends, done: 0 };
    try {
      const r = bridge.bars(buf.subarray(0, 7 * nc), nc, account.version);
      if (typeof r === 'string') return r;
      playBars(r - 1);
      candles += r;
      want = r === nc ? Math.min(BATCH_CANDLES, want * 2) : 2;
    } finally { batch = null; }
    return null;
  };
  // ticks of the bar playing now that can fill nothing, from the next one: [time, price, zone offset] each
  function playTicks(j: number) {
    const b = batch!;
    while (b.done <= j) {
      const i = feed.i, mv = feed.step()!; sync();
      account.onTick(sym, mv.from, mv.to, mv.jump);
      if (feed.i !== i) barEnd(i);
      afterTick();
      b.done++;
    }
  }
  const safeTicks = (): number => {
    feed.nextTickTime(); // builds the bar's ticks
    const k0 = feed.k, nt = feed.nt, P = feed.tkP;
    let from = k0 === 0 ? (feed.prevClose ?? P[0]) : feed.price!, k = k0;
    for (; k < nt; k++) { if (account.wouldFill(sym, from, P[k], k === 0)) break; from = P[k]; }
    return k - k0;
  };
  const tickBatch = (m: number): string | null => {
    const i = feed.i, k0 = feed.k, F = feed.tkF, P = feed.tkP, t = s.t[i];
    room(3 * m);
    const z0 = zoneOff(t), z1 = zoneOff(t + s.base); // one offset for the bar, unless the clocks change inside it
    for (let k = 0; k < m; k++) { const tt = t + F[k0 + k] * s.base; buf[3 * k] = tt; buf[3 * k + 1] = P[k0 + k]; buf[3 * k + 2] = z0 === z1 ? z0 : zoneOff(tt); }
    batch = { bars: false, ends, done: 0 };
    try {
      const r = bridge.ticks(buf.subarray(0, 3 * m), m, account.version);
      if (typeof r === 'string') return r;
      playTicks(r - 1);
    } finally { batch = null; }
    return null;
  };
  // base bar i finished: into the strategy's candle; on_bar when that candle closed (the candle goes to Python's
  // history even with no on_bar: on_tick reads ctx.closes())
  let candles = 0;
  const addBar = (i: number): string | null => {
    const v = s.v[i] || 0;
    if (!C) C = { time: bucketOf(s.t[i]), o: s.o[i], h: s.h[i], l: s.l[i], c: s.c[i], v };
    else { if (s.h[i] > C.h) C.h = s.h[i]; if (s.l[i] < C.l) C.l = s.l[i]; C.c = s.c[i]; C.v += v; }
    if (feed.i < end && bucketOf(s.t[feed.i]) === C.time) return null;
    buf[0] = C.time; buf[1] = C.o; buf[2] = C.h; buf[3] = C.l; buf[4] = C.c; buf[5] = C.v; buf[6] = zoneOff(C.time);
    C = null; candles++;
    const r = bridge.bars(buf.subarray(0, 7), 1, account.version);
    return typeof r === 'string' ? r : null;
  };

  /* ---- the run ---- */
  let fail: string | null = null, started = false, stopped = false, ended = '';
  // the prop rules after a tick's fills: a message ends the run
  function afterTick() {
    if (!rules || ended) return;
    const m = rules.afterTick(); if (!m) return;
    if (typeof m === 'string') { ended = m; log(`${fmtDay(feed.time)} ${m}`, 'er'); }
    else { pending = []; log(`${fmtDay(feed.time)} ${m.restarted}`, 'ok'); }
  }
  const info: StratInfo = { name: cfg.name ?? sym, tf: tfLabel(tf), tick: inst.tick, pv: inst.pv, spread, qty: cfg.qty ?? 1, prec, mode, balance: account.start, quiet, overrides: cfg.overrides || {} };
  const done = () => (feed.i - start) / total;
  const progress = (): Progress => ({ done: done(), time: feed.time, trades: account.hist.length, status: `${fmtDT(feed.time).slice(0, 10)} · ${account.hist.length} trades` });
  try {
    if (rules && rules.start) rules.start(account, (text, kind) => log(`${fmtDay(feed.time)} ${text}`, kind));
    const r = bridge.start(api, info);
    started = true;
    if (r.error) fail = r.error;
    else {
      const tickMode = mode === 'tick' && !!r.on_tick, onFill = !!r.on_fill;
      const ov = cfg.overrides && Object.keys(cfg.overrides).length ? cfg.overrides : null;
      log(`Running ${total.toLocaleString('en-US')} bars of ${tfLabel({ kind: 's', sec: s.base })} data on ${tfLabel(tf)} candles, ${fmtDay(s.t[start])} to ${fmtDay(s.t[end - 1])}${mode === 'tick' ? ', every tick' : ''}${ov ? `, with ${optLabel(ov)}` : ''}.`, 'pr');
      while (!fail && !ended && feed.i < end) {
        const until = sliceMs > 0 ? now() + sliceMs : Infinity;
        let n = 0;
        while (feed.i < end && !fail && !ended) {
          const i = feed.i, queued = pending.length > 0;
          if (feed.k === 0 && !queued && !fills.length && !tickMode && (!rules || rules.idle(s.t[i] + s.base)) && quietNow()) {
            // nothing can fill: step over the bars' ticks (the same end state); candles to the strategy in batches
            if (bridge.batch) fail = flatBatch();
            else { skip(); fail = addBar(i); }
          } else {
            let m = 0;
            if (tickMode && bridge.batch && !queued && !fills.length && (!rules || rules.idle(s.t[i] + s.base)) && (m = safeTicks()) > 0) fail = tickBatch(m);
            else {
              const mv = feed.step()!; sync();
              account.onTick(sym, mv.from, mv.to, mv.jump);
              if (feed.i !== i) barEnd(i);
              afterTick();
              if (queued) execPending();
              if (fills.length) fail = deliverFills(onFill);
              if (!fail && tickMode) {
                buf[0] = feed.time; buf[1] = feed.price!; buf[2] = zoneOff(feed.time);
                const x = bridge.ticks(buf.subarray(0, 3), 1, account.version);
                if (typeof x === 'string') fail = x;
              }
            }
            if (!fail && feed.i !== i) fail = addBar(i);
          }
          if (((++n & 63) === 0 || feed.i - i > 16) && now() > until) break;
        }
        emit();
        if (slice && feed.i < end && !fail) await slice(progress());
        if (hooks.stopped && hooks.stopped()) { stopped = feed.i < end; break; }
      }
    }
  } catch (e) {
    fail = fail || (e instanceof Error ? e.message : String(e));
  } finally {
    if (started) { const x = bridge.end(account.version, q.price); fail = fail || x || null; }
    account.onFill = null;
  }
  const secs = (now() - t0) / 1000;
  if (!quiet) {
    if (stopped) log(`Stopped at ${fmtDay(feed.time)}.`, 'er');
    else if (!fail) log(`Finished in ${secs.toFixed(1)} s.`, 'ok');
    if (fail) log(fail, 'er');
    for (const [k, n] of rejects) if (n > 1) log(`${n} times: ${k.replace(/\(\)/g, '').replace(/\s+\./g, '.')}`, 'er');
  }
  // the curve ends where the run did
  if (feed.i > start) pushEq(s.t[feed.i - 1], account.equity());
  const stats = computeStats(account);
  if (!quiet) { const [t, k] = summaryLine(stats); log(t, k); }
  emit();
  return { fail, stopped, ended, secs, start, end, from: s.t[start], to: s.t[end - 1], bars: feed.i - start, candles, done: done(), account, stats, eq, rejects: [...rejects], log: logged };
}
