// Strategies in JavaScript: the Python strategy API (runtime.py) in JS, for the same runner, many times faster (no
// crossing into WebAssembly). The same hooks with the same arguments, on_bar(ctx, bar), on_tick(ctx, tick),
// on_fill(ctx, fill), init(ctx), on_end(ctx); the same ctx members, order calls, rejections and errors (with the
// lines of the strategy that failed); settings as top-level `const NAME = literal` lines the optimizer can vary.
// Differences forced by the language: keyword arguments are an options object (ctx.buy({ qty: 2, sl: 99 }), or
// positional as in Python: ctx.buy(2, 99)); times are ZTime values (bar.time.time() >= ctx.at("09:30") compares
// seconds since midnight); ctx.df() needs pandas, so it is Python only.
import type { Bridge, FillOut, LogLine, Setting, StateOut, StratApi, StratInfo } from './backtest';

/* ---- time ---- */
const p2 = (n: number) => String(n).padStart(2, '0');
/** an instant in a fixed zone offset (seconds east of UTC), like Python's aware datetime */
export class ZTime {
  private d: Date | null = null;
  constructor(readonly t: number, readonly off: number) {}
  private get w() { return this.d ||= new Date((this.t + this.off) * 1000); }
  get year() { return this.w.getUTCFullYear(); }
  /** 1..12 */
  get month() { return this.w.getUTCMonth() + 1; }
  get day() { return this.w.getUTCDate(); }
  get hour() { return this.w.getUTCHours(); }
  get minute() { return this.w.getUTCMinutes(); }
  get second() { return this.w.getUTCSeconds(); }
  /** Monday 0 .. Sunday 6, as Python */
  weekday() { return (this.w.getUTCDay() + 6) % 7; }
  /** "YYYY-MM-DD": compare to spot a new day */
  date() { return `${this.year}-${p2(this.month)}-${p2(this.day)}`; }
  /** seconds since midnight, to compare with ctx.at("HH:MM") */
  time() { return this.hour * 3600 + this.minute * 60 + this.second; }
  /** UTC epoch seconds */
  timestamp() { return this.t; }
  /** the same instant at another offset (seconds east of UTC) */
  tz(off: number) { return new ZTime(this.t, off); }
  toString() { return `${this.date()} ${p2(this.hour)}:${p2(this.minute)}:${p2(this.second)}`; }
  hm() { return `${this.date()} ${p2(this.hour)}:${p2(this.minute)}`; }
}

/* ---- ta: the same indicator math as Python's ---- */
const nan = (n: number) => new Float64Array(n).fill(NaN);
class SMA { value: number | null = null; private w: number[] = []; private s = 0; constructor(readonly n: number) {} update(x: number) { this.w.push(+x); this.s += +x; if (this.w.length > this.n) this.s -= this.w.shift()!; return this.value = this.w.length === this.n ? this.s / this.n : null; } }
class EMA {
  value: number | null = null; private seed = 0; private cnt = 0; private a: number;
  constructor(readonly n: number, alpha?: number) { this.a = alpha ?? 2 / (n + 1); }
  update(x: number) { x = +x; if (this.value === null) { this.cnt++; this.seed += x; if (this.cnt === this.n) this.value = this.seed / this.n; return this.value; } return this.value += this.a * (x - this.value); }
}
class RMA extends EMA { constructor(n: number) { super(n, 1 / n); } }
class RSI {
  value: number | null = null; private prev: number | null = null; private up: RMA; private dn: RMA;
  constructor(readonly n = 14) { this.up = new RMA(n); this.dn = new RMA(n); }
  update(x: number) { x = +x; if (this.prev !== null) { const d = x - this.prev, u = this.up.update(Math.max(d, 0)), v = this.dn.update(Math.max(-d, 0)); if (u !== null) this.value = v === 0 ? 100 : 100 - 100 / (1 + u / v!); } this.prev = x; return this.value; }
}
class ATR {
  value: number | null = null; private prev: number | null = null; private r: RMA;
  constructor(readonly n = 14) { this.r = new RMA(n); }
  update(h: number, l: number, c: number) { const tr = this.prev === null ? h - l : Math.max(h - l, Math.abs(h - this.prev), Math.abs(l - this.prev)); this.prev = +c; return this.value = this.r.update(tr); }
}
class Win {
  value: number | null = null; private w: number[] = [];
  constructor(readonly n: number, private f: (w: number[]) => number) {}
  update(x: number) { this.w.push(+x); if (this.w.length > this.n) this.w.shift(); return this.value = this.w.length === this.n ? this.f(this.w) : null; }
}
const std = (w: ArrayLike<number>) => { let m = 0; for (let k = 0; k < w.length; k++) m += w[k]; m /= w.length; let v = 0; for (let k = 0; k < w.length; k++) v += (w[k] - m) ** 2; return Math.sqrt(v / w.length); };
const ewm = (x: ArrayLike<number>, n: number, alpha: number) => {
  const out = nan(x.length); if (x.length < n) return out;
  let v = 0; for (let k = 0; k < n; k++) v += x[k]; v /= n; out[n - 1] = v;
  for (let k = n; k < x.length; k++) { v += alpha * (x[k] - v); out[k] = v; }
  return out;
};
const roll = (x: ArrayLike<number>, n: number, f: (a: ArrayLike<number>) => number) => {
  const out = nan(x.length), a = Float64Array.from(x);
  if (n >= 1) for (let k = n - 1; k < a.length; k++) out[k] = f(a.subarray(k - n + 1, k + 1));
  return out;
};
const last2 = (a: ArrayLike<number>, b: number | ArrayLike<number>) => {
  const B = typeof b === 'number' ? [b, b] : [b[b.length - 2], b[b.length - 1]];
  return a.length >= 2 && (typeof b === 'number' || b.length >= 2) ? [a[a.length - 2], a[a.length - 1], B[0], B[1]] : null;
};
/** a class usable as in Python, ta.EMA(20), and with new, new ta.EMA(20) */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const either = <C extends new (...a: any[]) => any>(K: C) => function (...a: ConstructorParameters<C>) { return new K(...a); } as unknown as C & ((...a: ConstructorParameters<C>) => InstanceType<C>);
class STDEV extends Win { constructor(n: number) { super(n, std); } }
export const ta = {
  SMA: either(SMA), EMA: either(EMA), RMA: either(RMA), RSI: either(RSI), ATR: either(ATR), STDEV: either(STDEV),
  HIGHEST: function (n: number) { return new Win(n, w => Math.max(...w)); }, LOWEST: function (n: number) { return new Win(n, w => Math.min(...w)); },
  sma: (x: ArrayLike<number>, n: number) => roll(x, n, a => { let s = 0; for (let k = 0; k < a.length; k++) s += a[k]; return s / a.length; }),
  ema: (x: ArrayLike<number>, n: number) => ewm(x, n, 2 / (n + 1)),
  rma: (x: ArrayLike<number>, n: number) => ewm(x, n, 1 / n),
  stdev: (x: ArrayLike<number>, n: number) => roll(x, n, std),
  highest: (x: ArrayLike<number>, n: number) => roll(x, n, a => Math.max(...Array.from(a))),
  lowest: (x: ArrayLike<number>, n: number) => roll(x, n, a => Math.min(...Array.from(a))),
  rsi(x: ArrayLike<number>, n = 14) {
    const out = nan(x.length); if (x.length <= n) return out;
    const d = new Float64Array(x.length - 1); for (let k = 1; k < x.length; k++) d[k - 1] = x[k] - x[k - 1];
    const up = ewm(d.map(v => Math.max(v, 0)), n, 1 / n), dn = ewm(d.map(v => Math.max(-v, 0)), n, 1 / n);
    for (let k = 0; k < d.length; k++) out[k + 1] = isNaN(up[k]) ? NaN : dn[k] === 0 ? 100 : 100 - 100 / (1 + up[k] / dn[k]);
    return out;
  },
  atr(h: ArrayLike<number>, l: ArrayLike<number>, c: ArrayLike<number>, n = 14) {
    if (!c.length) return new Float64Array(0);
    const tr = new Float64Array(c.length); tr[0] = h[0] - l[0];
    for (let k = 1; k < c.length; k++) tr[k] = Math.max(h[k] - l[k], Math.abs(h[k] - c[k - 1]), Math.abs(l[k] - c[k - 1]));
    return ewm(tr, n, 1 / n);
  },
  crossover(a: ArrayLike<number>, b: number | ArrayLike<number>) { const x = last2(a, b); return !!x && x[0] <= x[2] && x[1] > x[3]; },
  crossunder(a: ArrayLike<number>, b: number | ArrayLike<number>) { const x = last2(a, b); return !!x && x[0] >= x[2] && x[1] < x[3]; },
};
/** a setting the optimizer may vary: param(9, 5, 30, 5) or param("range", { values: ["range", "candle"] }); just
 * the default in a normal run */
export const param = (v: Setting, ..._rest: unknown[]) => v;

/* ---- what hooks receive ---- */
const pyf = (x: number) => Number.isInteger(x) ? x.toFixed(1) : String(x);
const g = (x: number) => String(+x.toPrecision(6));
export class Bar {
  private z: ZTime | null = null;
  constructor(private t: number, private off: number, readonly open: number, readonly high: number, readonly low: number, readonly close: number, readonly volume: number, readonly index: number) {}
  get time() { return this.z ||= new ZTime(this.t, this.off); }
  toString() { return `Bar(${this.time.hm()} O=${pyf(this.open)} H=${pyf(this.high)} L=${pyf(this.low)} C=${pyf(this.close)} V=${g(this.volume)})`; }
}
export class Tick {
  private z: ZTime | null = null;
  constructor(private t: number, private off: number, readonly price: number) {}
  get time() { return this.z ||= new ZTime(this.t, this.off); }
  toString() { return `Tick(${this.time} ${pyf(this.price)})`; }
}
export class Fill {
  readonly side: 'buy' | 'sell'; readonly qty: number; readonly price: number; readonly kind: 'entry' | 'exit'; readonly reason: string; readonly trade_id: number; readonly pnl: number | null;
  private z: ZTime | null = null; private t: number; private off: number;
  constructor(f: FillOut) { this.side = f.side; this.qty = f.qty; this.price = f.price; this.kind = f.kind; this.reason = f.reason || ''; this.trade_id = f.id; this.pnl = f.pnl; this.t = f.time; this.off = f.off; }
  get time() { return this.z ||= new ZTime(this.t, this.off); }
  toString() { return `Fill(${this.time.hm()} ${this.side} ${g(this.qty)} @ ${pyf(this.price)} ${this.kind} ${this.reason}${this.pnl != null ? ` pnl=${this.pnl >= 0 ? '+' : ''}${this.pnl.toFixed(2)}` : ''})`; }
}
export class ValueError extends Error { constructor(m: string) { super(m); this.name = 'ValueError'; } }
type Num = number | null | undefined;
type OrderOpts = { qty?: Num; sl?: Num; tp?: Num; limit?: Num; stop?: Num };
const finite = (x: Num) => { if (x == null) return null; x = +x; if (!isFinite(x)) throw new ValueError('Prices must be finite numbers.'); return x; };

/** what a JS strategy sees and does: the Python ctx's members */
export class Ctx {
  [k: string]: unknown;
  readonly symbol: string; readonly timeframe: string; readonly tick_size: number; readonly point_value: number; readonly spread: number; readonly default_qty: number; readonly mode: string;
  price: number | null = null; bar_index = -1;
  /** @internal */ _t: number | null = null; /** @internal */ _off = 0; /** @internal */ _z: ZTime | null = null;
  /** @internal */ _k = 0; /** @internal */ _a: Float64Array[] = [];
  /** @internal */ _want = 0; /** @internal */ _have = -1; /** @internal */ _st: StateOut | null = null; /** @internal */ _eqpx: number | null = null;
  /** @internal */ _batch = false; /** @internal */ _i = 0; /** @internal */ _acted = false;
  /** @internal */ _hist: ReturnType<StratApi['history']> = [];
  /** @internal */ _rejects = new Map<string, number>();
  private _prec: number;
  constructor(private _api: StratApi, info: StratInfo, private _print: (s: string) => void) {
    this.symbol = info.name; this.timeframe = info.tf; this.tick_size = info.tick; this.point_value = info.pv; this.spread = info.spread;
    this.default_qty = info.qty; this.mode = info.mode; this._prec = info.prec;
    for (let j = 0; j < 6; j++) this._a.push(new Float64Array(4096));
  }
  get time() { return this._z ||= this._t == null ? null : new ZTime(this._t, this._off); }
  get bid() { return this.price; }
  get ask() { return this.price == null ? null : this.round(this.price + this.spread); }
  // ---- candles: the last n closed ones (all without n), oldest first; views, do not write into them
  private col(j: number, n?: number | null) { return this._a[j].subarray(n ? Math.max(0, this._k - n) : 0, this._k); }
  times(n?: number) { return this.col(0, n); }
  opens(n?: number) { return this.col(1, n); }
  highs(n?: number) { return this.col(2, n); }
  lows(n?: number) { return this.col(3, n); }
  closes(n?: number) { return this.col(4, n); }
  volumes(n?: number) { return this.col(5, n); }
  df(): never { throw new Error('ctx.df() needs pandas, so it works in Python strategies only. Use ctx.closes() and the others.'); }
  /** @internal room for n more candles */
  _room(n: number) {
    if (this._k + n <= this._a[0].length) return;
    let cap = this._a[0].length; while (this._k + n > cap) cap *= 2;
    this._a = this._a.map(a => { const b = new Float64Array(cap); b.set(a.subarray(0, this._k)); return b; });
  }
  round(p: number) { const m = 10 ** this._prec; return Math.round(p * m) / m; }
  ticks(n: number) { return n * this.tick_size; }
  /** "09:30" as seconds since midnight, to compare with bar.time.time() */
  at(hhmm: string) { const [h, m] = String(hhmm).trim().split(':'); return +h * 3600 + +m * 60; }
  /** whether a time of day is in the window [start, end): t a time (bar.time or its .time() seconds), start and end
   *  "HH:MM" or seconds. When end is before start the window runs across midnight: between(t, "18:00", "14:30") is
   *  true from 18:00 to 14:30 the next day. The same start and end mean all day. */
  between(t: number | { time(): number }, start: string | number, end: string | number) {
    const x = typeof t === 'number' ? t : t.time(), a = typeof start === 'number' ? start : this.at(start), b = typeof end === 'number' ? end : this.at(end);
    return a === b ? true : a < b ? x >= a && x < b : x >= a || x < b;
  }
  // ---- the account, as of the start of this call
  private pull() { if (this._have !== this._want || !this._st) { this._st = this._api.state(); this._have = this._want = this._st.v; } return this._st; }
  get position() { return this.pull().pos; }
  get position_price() { const s = this.pull(); return s.pos ? s.avg : null; }
  get balance() { return this.pull().bal; }
  private unreal(side: number, qty: number, entry: number) { const p = this._eqpx; return p == null ? 0 : ((side > 0 ? p : p + this.spread) - entry) * side * qty * this.point_value; }
  get equity() { const s = this.pull(); let e = s.bal; for (const t of s.tr) e += this.unreal(t[1], t[2], t[3]); return e; }
  get orders() { return this.pull().od.map(o => ({ id: o[0], side: o[1] > 0 ? 'buy' : 'sell', type: o[2], price: o[3], qty: o[4], sl: o[5], tp: o[6] })); }
  get trades() { return this.pull().tr.map(t => ({ id: t[0], side: t[1] > 0 ? 'long' : 'short', qty: t[2], entry: t[3], sl: t[4], tp: t[5], pnl: this.unreal(t[1], t[2], t[3]) })); }
  get history() { const s = this.pull(); if (this._hist.length < s.nh) this._hist.push(...this._api.history(this._hist.length)); return this._hist.map(h => ({ ...h })); }
  // ---- orders: market orders and close() fill on the next tick (from on_bar: the next bar's open)
  private sync() { if (this._batch) this._api.sync(this._i); }
  private send(side: number, a: unknown[], fixed?: { limit?: Num; stop?: Num }): number | null {
    let o: OrderOpts;
    if (fixed) o = a[1] != null && typeof a[1] === 'object' ? { ...(a[1] as OrderOpts), ...fixed } : { qty: a[1] as Num, sl: a[2] as Num, tp: a[3] as Num, ...fixed };
    else o = a[0] != null && typeof a[0] === 'object' ? a[0] as OrderOpts : { qty: a[0] as Num, sl: a[1] as Num, tp: a[2] as Num, limit: a[3] as Num, stop: a[4] as Num };
    if (o.limit != null && o.stop != null) throw new ValueError('Give either limit= or stop=, not both.');
    const kind = o.limit != null ? 'limit' : o.stop != null ? 'stop' : 'market', price = finite(o.limit ?? o.stop);
    const qty = o.qty == null ? this.default_qty : +o.qty;
    if (!(qty > 0)) throw new ValueError('qty must be more than 0.');
    const sl = finite(o.sl), tp = finite(o.tp);
    this.sync();
    const r = this._api.submit(side, kind, price, sl, tp, qty);
    this._have = -1;
    if (r.error) { this.reject(r.error); return null; }
    this._acted = true;
    return r.id ?? null;
  }
  private reject(msg: string) {
    const key = msg.replace(/\([^)]*\)/g, '()'), n = (this._rejects.get(key) || 0) + 1;
    this._rejects.set(key, n);
    const z = this.time, when = z ? z.hm() + ' ' : '';
    if (n === 1 && this._rejects.size <= 20) this._print(`${when}Order rejected: ${msg}`);
    else if (n === 10 || n === 100 || n === 1000 || n === 10000) this._print(`Order rejected ${n} times so far: ${msg}`);
  }
  buy(...a: unknown[]) { return this.send(1, a); }
  sell(...a: unknown[]) { return this.send(-1, a); }
  buy_limit(price: number, ...a: unknown[]) { return this.send(1, [null, ...a], { limit: price }); }
  sell_limit(price: number, ...a: unknown[]) { return this.send(-1, [null, ...a], { limit: price }); }
  buy_stop(price: number, ...a: unknown[]) { return this.send(1, [null, ...a], { stop: price }); }
  sell_stop(price: number, ...a: unknown[]) { return this.send(-1, [null, ...a], { stop: price }); }
  close() { this.sync(); this._api.closeAll(); this._acted = true; }
  cancel(id: number) { this.sync(); const ok = this._api.cancel(id); if (ok) { this._have = -1; this._acted = true; } return ok; }
  cancel_all() { this.sync(); if (this._api.cancel(-1)) { this._have = -1; this._acted = true; } }
  set_bracket(sl?: Num | { sl?: Num; tp?: Num }, tp?: Num) {
    if (sl != null && typeof sl === 'object') ({ sl, tp } = sl);
    const s = finite(sl as Num), t = finite(tp);
    this.sync();
    if (this._api.bracket(s, t)) { this._have = -1; this._acted = true; }
  }
}

/* ---- errors, with the strategy's own lines ---- */
const HEAD = 3; // lines new Function puts before the code: "function anonymous(...", ") {", "use strict"
const SRC = '<strategy>';
export function jsError(e: unknown, code: string): string {
  const err = e instanceof Error ? e : new Error(String(e));
  const lines = code.split('\n'), frames: string[] = [];
  for (const l of String(err.stack || '').split('\n')) {
    const m = l.match(/<strategy>:(\d+)(?::\d+)?/); if (!m) continue;
    const n = +m[1] - HEAD; if (n < 1 || n > lines.length) continue;
    let fn = (l.match(/^\s*at\s+(?:new\s+)?([^\s(]+)\s+\(/) || l.match(/^\s*([^@\s]*)@/) || [])[1] || '';
    fn = fn.replace(/^Object\./, '').replace(/^Ctx\./, '');
    if (!fn || fn === 'eval' || fn === 'anonymous' || fn === '<anonymous>') fn = '<module>';
    frames.push(`  line ${n}, in ${fn}\n    ${lines[n - 1].trim()}`);
  }
  frames.reverse(); // outermost first, like Python
  const ln = (err as any).lineNumber ?? (err as any).line; // a syntax error's line, where the engine gives it
  if (err.name === 'SyntaxError' && !frames.length && ln != null && +ln - HEAD >= 1) frames.push(`  line ${+ln - HEAD}\n    ${(lines[+ln - HEAD - 1] || '').trim()}`);
  return `${err.name}: ${err.message}` + (frames.length ? '\n' + frames.join('\n') : '');
}
type Hooks = { init?: Function; on_bar?: Function; on_tick?: Function; on_fill?: Function; on_end?: Function };
function compile(code: string): (param: unknown, ta: unknown, print: unknown) => Hooks {
  return new Function('param', 'ta', 'print', '"use strict";\n' + code +
    '\n;return { init: typeof init === "function" ? init : undefined, on_bar: typeof on_bar === "function" ? on_bar : undefined, on_tick: typeof on_tick === "function" ? on_tick : undefined, on_fill: typeof on_fill === "function" ? on_fill : undefined, on_end: typeof on_end === "function" ? on_end : undefined };\n//# sourceURL=' + SRC) as any;
}
/** the code's syntax error, or null */
export function jsCheck(code: string): string | null { try { compile(code); return null; } catch (e) { return jsError(e, code); } }

/* ---- settings: top-level `const NAME = literal;  // comment` lines (let and var too) ---- */
export interface JsParam {
  name: string; kind: 'int' | 'float' | 'bool' | 'choice'; value: Setting; line: number; comment: string; zero_off: boolean; money: boolean; param: boolean;
  choices?: Setting[]; lo?: number; hi?: number; step?: number; values?: Setting[];
}
const DECL_RE = /^(?:const|let|var)\s+/, NAME_RE = /^([A-Z][A-Z0-9_]*)\s*=\s*/;
const TIME_RE = /^\s*\d{1,2}:\d{2}(:\d{2})?\s*$/, MONEY_RE = /RISK|USD|DOLLAR|CASH|BALANCE|ACCOUNT|QTY|SIZE|LOTS?$|CONTRACTS?|STEP$/, OFF_RE = /(^|[^\d.])0\s*=\s*off/i;
// the value's text up to the end of the statement, and the comment after it (outside quotes)
function splitLine(rest: string): { expr: string; comment: string } {
  let q = '', depth = 0;
  for (let k = 0; k < rest.length; k++) {
    const ch = rest[k];
    if (q) { if (ch === '\\') k++; else if (ch === q) q = ''; continue; }
    if (ch === '"' || ch === "'" || ch === '`') q = ch;
    else if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === '/' && rest[k + 1] === '/') return { expr: rest.slice(0, k).trim().replace(/;$/, '').trim(), comment: rest.slice(k + 2).trim() };
    else if (ch === ';' && depth === 0) { const after = rest.slice(k + 1), c = after.indexOf('//'); return { expr: rest.slice(0, k).trim(), comment: c >= 0 ? after.slice(c + 2).trim() : '' }; }
  }
  return { expr: rest.trim(), comment: '' };
}
// a JS literal: number (possibly negative), true/false, or quoted text
function lit(s: string): { ok: boolean; v?: Setting; int?: boolean } {
  s = s.trim();
  if (/^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return { ok: true, v: +s, int: /^-?\d+$/.test(s) };
  if (s === 'true' || s === 'false') return { ok: true, v: s === 'true' };
  const m = s.match(/^(["'])((?:\\.|(?!\1).)*)\1$/);
  if (m) return { ok: true, v: m[2].replace(/\\(.)/g, '$1') };
  return { ok: false };
}
function splitArgs(s: string): string[] {
  const out: string[] = []; let q = '', depth = 0, from = 0;
  for (let k = 0; k < s.length; k++) {
    const ch = s[k];
    if (q) { if (ch === '\\') k++; else if (ch === q) q = ''; continue; }
    if (ch === '"' || ch === "'") q = ch;
    else if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    else if (ch === ',' && depth === 0) { out.push(s.slice(from, k).trim()); from = k + 1; }
  }
  if (s.slice(from).trim()) out.push(s.slice(from).trim());
  return out;
}
// where each setting's value sits on a declaration line (const FAST = 9, SLOW = 21;): the literal, or param()'s
// first argument
type Site = { name: string; at: number; len: number; expr: string; comment: string; isParam: boolean; args: string[] };
function sites(line: string): Site[] {
  const m = line.match(DECL_RE); if (!m) return [];
  const { expr: stmt, comment } = splitLine(line.slice(m[0].length)), out: Site[] = [];
  let cur = m[0].length;
  for (const part of splitArgs(stmt)) {
    const p0 = line.indexOf(part, cur); cur = p0 + part.length;
    const nm = part.match(NAME_RE); if (!nm) continue;
    const expr = part.slice(nm[0].length), at = p0 + nm[0].length, pm = expr.match(/^param\s*\(([\s\S]*)\)$/);
    if (pm) {
      const args = splitArgs(pm[1]); if (!args.length) continue;
      out.push({ name: nm[1], at: line.indexOf(args[0], at + expr.indexOf('(') + 1), len: args[0].length, expr, comment, isParam: true, args });
    } else out.push({ name: nm[1], at, len: expr.length, expr, comment, isParam: false, args: [] });
  }
  return out;
}
/** the settings at the top of a JS strategy, in the shape Python's _tr_params gives */
export function jsParams(code: string): { params: JsParam[] } | { error: string } {
  const syn = jsCheck(code); if (syn) return { error: syn.split('\n')[0] };
  const out: JsParam[] = [];
  code.split('\n').forEach((line, k) => { for (const st of sites(line)) {
    const v = lit(st.isParam ? st.args[0] : st.expr); if (!v.ok) continue;
    if (typeof v.v === 'string' && TIME_RE.test(v.v)) continue;
    const kind = typeof v.v === 'boolean' ? 'bool' : typeof v.v === 'number' ? (v.int ? 'int' : 'float') : 'choice';
    const p: JsParam = { name: st.name, kind, value: v.v!, line: k + 1, comment: st.comment, zero_off: OFF_RE.test(st.comment), money: MONEY_RE.test(st.name), param: st.isParam };
    if (kind === 'choice') {
      const quoted = [...st.comment.matchAll(/"([^"\n]+)"|'([^'\n]+)'/g)].map(x => x[1] || x[2]).filter(c => !TIME_RE.test(c));
      p.choices = [...new Set([v.v!, ...quoted])];
    }
    if (st.isParam) {
      const names = ['lo', 'hi', 'step'] as const;
      st.args.slice(1).forEach((a, j) => {
        if (a.startsWith('{')) { // an options object: { lo, hi, step, values }
          try { const o = JSON.parse(a.replace(/'/g, '"').replace(/([{,]\s*)([A-Za-z_]\w*)\s*:/g, '$1"$2":').replace(/,\s*([}\]])/g, '$1')); for (const key of ['lo', 'hi', 'step']) if (typeof o[key] === 'number') (p as any)[key] = o[key]; if (Array.isArray(o.values)) p.values = o.values; } catch { /* not literal */ }
        } else if (j < 3) { const x = lit(a); if (x.ok && typeof x.v === 'number') p[names[j]] = x.v; }
      });
    }
    out.push(p);
  } });
  return { params: out };
}
/** the code with the chosen settings written in (the optimizer's runs, and Use in code) */
export function jsApply(code: string, values: Record<string, Setting>): { code: string } | { error: string } {
  const lines = code.split('\n'), seen = new Set<string>();
  for (let k = 0; k < lines.length; k++) for (const st of sites(lines[k]).reverse()) { // from the right, so positions hold
    if (!(st.name in values) || seen.has(st.name)) continue;
    seen.add(st.name);
    const v = values[st.name], old = lit(st.isParam ? st.args[0] : st.expr);
    let text = typeof v === 'string' ? JSON.stringify(v) : typeof v === 'boolean' ? String(v) : String(v);
    if (typeof v === 'number' && old.ok && typeof old.v === 'number' && !old.int && Number.isInteger(v)) text = v.toFixed(1); // a float setting stays one
    if (typeof v === 'string' && old.ok && typeof old.v === 'string') { const qch = (st.isParam ? st.args[0] : st.expr)[0]; if (qch === "'") text = "'" + v.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'"; }
    lines[k] = lines[k].slice(0, st.at) + text + lines[k].slice(st.at + st.len);
  }
  for (const n of Object.keys(values)) if (!seen.has(n)) return { error: `The setting ${n} is not in the code any more.` };
  return { code: lines.join('\n') };
}

/** a JavaScript strategy for the runner */
export function jsStrategy(code: string): Bridge {
  let ctx!: Ctx, H: Hooks = {}, quiet = false, src = code;
  const out: LogLine[] = [];
  const show = (x: unknown): string => Array.isArray(x) || ArrayBuffer.isView(x) ? '[' + Array.from(x as ArrayLike<unknown>).map(show).join(', ') + ']'
    : x !== null && typeof x === 'object' && (x as object).toString === Object.prototype.toString ? JSON.stringify(x) : String(x);
  const print = (...a: unknown[]) => { if (!quiet) out.push([a.map(show).join(' '), 'pr']); };
  const call = (f: Function | undefined, ...a: unknown[]): string | null => { if (!f) return null; try { f(...a); return null; } catch (e) { return jsError(e, src); } };
  return {
    batch: true,
    start(api: StratApi, info: StratInfo) {
      quiet = info.quiet;
      try {
        if (info.overrides && Object.keys(info.overrides).length) { const r = jsApply(code, info.overrides); if ('error' in r) return { error: 'NameError: ' + r.error }; src = r.code; }
        ctx = new Ctx(api, info, s => print(s));
        ctx._eqpx = null;
        H = compile(src)(param, ta, print);
        if (!H.on_bar && !H.on_tick) return { error: 'The strategy needs an on_bar(ctx, bar) function' + (info.mode === 'tick' ? ' or an on_tick(ctx, tick) function.' : '.') };
        if (info.mode === 'bar' && !H.on_bar) return { error: "on_tick only runs with 'Every tick'. Add on_bar(ctx, bar), or choose Every tick." };
        const e = call(H.init, ctx); if (e) return { error: e };
      } catch (e) { return { error: jsError(e, src) }; }
      return { on_bar: !!H.on_bar, on_tick: !!H.on_tick, on_fill: !!H.on_fill };
    },
    bars(b, n, ver) {
      const c = ctx; c._room(n); c._want = ver; c._batch = true; c._acted = false;
      const A = c._a, k0 = c._k;
      for (let j = 0; j < n; j++) for (let f = 0; f < 6; f++) A[f][k0 + j] = b[7 * j + f];
      try {
        for (let j = 0; j < n; j++) {
          const x = 7 * j; c._k++; c.bar_index++;
          c._t = b[x]; c._off = b[x + 6]; c._z = null; c.price = c._eqpx = b[x + 4]; c._i = j;
          if (H.on_bar) { H.on_bar(c, new Bar(b[x], b[x + 6], b[x + 1], b[x + 2], b[x + 3], b[x + 4], b[x + 5], c.bar_index)); if (c._acted) return j + 1; }
        }
      } catch (e) { return jsError(e, src); } finally { c._batch = false; }
      return n;
    },
    ticks(b, n, ver) {
      const c = ctx; c._want = ver; c._batch = true; c._acted = false;
      try {
        for (let j = 0; j < n; j++) {
          const x = 3 * j; c._t = b[x]; c._off = b[x + 2]; c._z = null; c.price = c._eqpx = b[x + 1]; c._i = j;
          H.on_tick!(c, new Tick(b[x], b[x + 2], b[x + 1]));
          if (c._acted) return j + 1;
        }
      } catch (e) { return jsError(e, src); } finally { c._batch = false; }
      return n;
    },
    fills(list, ver, px) {
      ctx._want = ver; ctx._eqpx = px;
      for (const f of list) { const e = call(H.on_fill, ctx, new Fill(f)); if (e) return e; }
      return null;
    },
    end(ver, px) { if (!ctx) return null; ctx._want = ver; ctx._eqpx = px; return call(H.on_end, ctx); },
    flush: () => out.splice(0),
  };
}
