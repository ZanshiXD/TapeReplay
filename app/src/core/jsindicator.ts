// Indicators in JavaScript: the Python indicator API (runtime.py, IndContext and _Ind) in JS, giving the same output
// the page draws from (_ti_start / _ti_feed's JSON: meta, plots, hlines, fills, bg, marks, draw, del, error), with the
// same rules, limits, checks and error texts. Run in a worker of its own (next/py/jsworker.ts) so a slow script
// never holds up the chart. Differences forced by the language, as in JS strategies: keyword arguments are an options
// object (ctx.plot(v, "EMA", { color: "orange", pane: "lower" })), or positional in Python's order; times are ZTime
// values; the candle arrays are Float64Array views; there is no numpy or pandas.
import { Bar, ZTime, jsError, param, ta, ValueError } from './jsstrategy';

/* ---- small things Python gives for free ---- */
class AttributeError extends Error { constructor(m: string) { super(m); this.name = 'AttributeError'; } }
class NameError extends Error { constructor(m: string) { super(m); this.name = 'NameError'; } }
/** Python's round(): halves go to the even neighbour */
const pyRound = (x: number) => { const r = Math.round(x); return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r; };
/** Python's int(): toward zero */
const pyInt = (x: number) => Math.trunc(x);
/** Python's format(x, "g") */
function fmtG(x: number) {
  if (x === 0) return '0';
  const e = Math.floor(Math.log10(Math.abs(x)));
  if (e < -4 || e >= 6) { const [m, ex] = x.toExponential(5).split('e'); const mm = m.replace(/\.?0+$/, ''); const n = +ex; return `${mm}e${n < 0 ? '-' : '+'}${String(Math.abs(n)).padStart(2, '0')}`; }
  return String(+x.toPrecision(6));
}
const str = (v: unknown) => v === true ? 'True' : v === false ? 'False' : v == null ? 'None' : String(v);
const isPlain = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x) && !ArrayBuffer.isView(x) && !(x instanceof ZTime) && !(x instanceof Date) && Object.getPrototypeOf(x) === Object.prototype;
/** positional arguments in Python's order, then an options object at the end (if one is given) */
function kw(a: unknown[], names: string[], defaults: Record<string, unknown>): Record<string, any> {
  const out: Record<string, any> = { ...defaults };
  const last = a.length ? a[a.length - 1] : undefined, o = isPlain(last) ? last : null, pos = o ? a.slice(0, -1) : a;
  pos.forEach((v, i) => { if (i < names.length && v !== undefined) out[names[i]] = v; });
  if (o) for (const [k, v] of Object.entries(o)) {
    if (!names.includes(k)) throw new TypeError(`got an unexpected keyword argument '${k}'`);
    if (v !== undefined) out[k] = v;
  }
  return out;
}
const finite = (x: unknown): number | null => {
  if (x == null) return null;
  const v = +(x as number);
  if (!isFinite(v)) throw new ValueError('Prices must be finite numbers.');
  return v;
};
function color(c: unknown, what = 'color'): string | null {
  if (c == null) return null;
  if (typeof c !== 'string' || !c.trim()) throw new ValueError(`${what} must be text such as "#22c55e", "red", "up" or rgba("#22c55e", 0.2).`);
  return c.trim();
}
/** a color with transparency: rgba("#22c55e", 0.2), or a theme color: rgba("up", 0.3) */
export function rgba(c: unknown, alpha: unknown) {
  const a = +(alpha as number);
  if (!(a >= 0 && a <= 1)) throw new ValueError('alpha goes from 0 (clear) to 1 (solid).');
  return `${color(c)}@${fmtG(a)}`;
}
const clampW = (w: unknown, hi = 10) => Math.max(0.5, Math.min(hi, +(w as number)));

const MAX_OBJ = 500; // boxes, lines and labels kept per indicator, each kind; the oldest go first (as TradingView)
const STYLES = ['line', 'step', 'dashed', 'dotted', 'points', 'histogram'];
const SHAPES = ['arrow_up', 'arrow_down', 'circle', 'square'];
const LINE_STYLES = ['solid', 'dashed', 'dotted'];
const FIELDS: Record<string, string[]> = {
  box: ['left', 'top', 'right', 'bottom', 'color', 'fill', 'width', 'style', 'text', 'text_color', 'extend'],
  line: ['x1', 'y1', 'x2', 'y2', 'color', 'width', 'style', 'extend'],
  label: ['x', 'y', 'text', 'color', 'text_color', 'style'],
};
const XF = new Set(['left', 'right', 'x1', 'x2', 'x']), YF = new Set(['top', 'bottom', 'y1', 'y2', 'y']), CF = new Set(['color', 'fill', 'text_color']);
const one = (s: string) => s.split(', ').length > 1 ? s.replace(/, ([^,]*)$/, ' or $1') : s;

type Kind = 'box' | 'line' | 'label';
/** a box, line or label: change it by setting fields (b.right = bar.index) or with set({...}); remove it with delete() */
export interface Drawing { readonly kind: Kind; readonly id: number; readonly alive: boolean; set(o: Record<string, unknown>): Drawing; delete(): void; [k: string]: any }

class Ind {
  ctx: IndCtx; onBar: ((c: IndCtx, b: Bar) => void) | null = null; err: string | null = null; code = '';
  private id = 0;
  objs = new Map<number, Drawing>();
  dirty = new Map<number, Drawing>();
  gone: number[] = [];
  meta = new Map<string, any>();
  newMeta: any[] = [];
  pts = new Map<string, any[]>();
  now = new Map<string, number | null>();
  hl = new Map<string, any>(); hlKeys = new Map<string, string>(); hlDirty = false;
  fills = new Map<string, [string, string, string | null]>();
  fillPts = new Map<string, [string, string, any[]]>();
  bgs: Array<[number, string]> = [];
  marks: any[] = [];
  auto = 0;
  constructor(info: any, print: (s: string) => void) { this.ctx = new IndCtx(this, info, print); }
  nextId() { return ++this.id; }
  t() { return this.ctx._a[0][this.ctx._k - 1]; }
  /** a bar index, a time (ZTime or Date) -> UTC seconds (indexes past the last candle are extended by the timeframe) */
  x(x: unknown): number {
    if (x instanceof ZTime) return x.timestamp();
    if (x instanceof Date) return x.getTime() / 1000;
    if (typeof x !== 'number' || !isFinite(x)) throw new TypeError('x positions are bar indexes (bar.index, ctx.bar_index - 5) or times (bar.time).');
    const i = pyRound(x), k = this.ctx._k, a = this.ctx._a[0], tfs = this.ctx._tfs;
    if (k === 0) throw new ValueError('No candles yet.');
    if (i >= 0 && i < k) return a[i];
    if (i >= k) return a[k - 1] + (i - k + 1) * tfs;
    return a[0] + i * tfs;
  }
  plot(value: unknown, title: unknown, col: unknown, width: unknown, style: unknown, pane: unknown) {
    if (title == null) { this.auto++; title = `Plot ${this.auto}`; }
    const tt = str(title).slice(0, 60);
    if (!this.meta.has(tt)) {
      if (!STYLES.includes(style as string)) throw new ValueError(`style must be one of ${STYLES.join(', ')}.`);
      if (pane !== 'price' && pane !== 'lower') throw new ValueError('pane must be "price" or "lower".');
      if (this.meta.size >= 64) throw new ValueError('An indicator can have up to 64 plots.');
      const m = { title: tt, style, pane, width: clampW(width), color: color(col) };
      this.meta.set(tt, m); this.newMeta.push(m);
    }
    let v: number | null = value == null ? null : +(value as number);
    if (v !== null && !isFinite(v)) v = null;
    this.now.set(tt, v);
    const t = this.t(), c = color(col);
    let pts = this.pts.get(tt); if (!pts) this.pts.set(tt, pts = []);
    const pt = c === null || c === this.meta.get(tt).color ? [t, v] : [t, v, c];
    if (pts.length && pts[pts.length - 1][0] === t) pts[pts.length - 1] = pt; else pts.push(pt);
  }
  hline(price: unknown, title: unknown, col: unknown, width: unknown, style: unknown, pane: unknown) {
    if (!LINE_STYLES.includes(style as string)) throw new ValueError(`style must be one of ${LINE_STYLES.join(', ')}.`);
    if (pane !== 'price' && pane !== 'lower') throw new ValueError('pane must be "price" or "lower".');
    const p = finite(price);
    const key = title != null ? str(title) : `${pane}:${p}`;
    const h = { price: p, title: title == null ? null : str(title).slice(0, 60), color: color(col), width: clampW(width), style, pane };
    const j = JSON.stringify(h);
    if (this.hlKeys.get(key) !== j) { this.hl.set(key, h); this.hlKeys.set(key, j); this.hlDirty = true; }
  }
  fill(a: unknown, b: unknown, c: unknown) { const A = str(a), B = str(b); this.fills.set(A + '\u0000' + B, [A, B, color(c)]); }
  bg(c: unknown) { const col = color(c); if (col) this.bgs.push([this.t(), col]); }
  marker(text: unknown, shape: unknown, position: unknown, col: unknown, at: unknown, size: unknown) {
    if (!SHAPES.includes(shape as string)) throw new ValueError(`shape must be one of ${SHAPES.join(', ')}.`);
    if (!['above', 'below', 'inside'].includes(position as string)) throw new ValueError('position must be "above", "below" or "inside".');
    let t: number;
    if (at == null) t = this.t();
    else {
      if (!(at instanceof ZTime) && !(at instanceof Date)) at = Math.max(0, Math.min(this.ctx._k - 1, pyInt(+(at as number)))); // markers sit on candles that exist
      t = this.x(at);
    }
    this.marks.push([t, shape, position, color(col), (!text ? '' : str(text)).slice(0, 40), Math.max(0.5, Math.min(4, +(size as number)))]);
  }
  make(kind: Kind, fields: Record<string, unknown>): Drawing {
    if (kind === 'line' && !['none', 'right', 'left', 'both'].includes(fields.extend as string)) throw new ValueError('extend must be "none", "right", "left" or "both".');
    if (kind === 'label' && !['up', 'down', 'center', 'text'].includes(fields.style as string)) throw new ValueError('style must be "up", "down", "center" or "text".');
    if ((kind === 'box' || kind === 'line') && !LINE_STYLES.includes(fields.style as string)) throw new ValueError(`style must be one of ${LINE_STYLES.join(', ')}.`);
    const d = drawing(this, kind, fields);
    this.objs.set(d.id, d);
    const same = [...this.objs.values()].filter(x => x.kind === kind);
    if (same.length > MAX_OBJ) same[0].delete();
    return d;
  }
  remove(d: Drawing) { this.objs.delete(d.id); this.dirty.delete(d.id); this.gone.push(d.id); }
  endBar() {
    const t = this.t();
    for (const [key, [a, b, c]] of this.fills) {
      const va = this.now.get(a), vb = this.now.get(b);
      if (va != null && vb != null) { let f = this.fillPts.get(key); if (!f) this.fillPts.set(key, f = [a, b, []]); f[2].push([t, va, vb, c]); }
    }
    this.fills.clear(); this.now.clear(); this.auto = 0;
  }
  drawingOut(d: Drawing) {
    const f: Record<string, unknown> = { ...(d as any)._f };
    for (const k of XF) if (k in f) f[k] = this.x(f[k]);
    f.id = d.id; f.kind = d.kind;
    return f;
  }
  out(err?: string | null): string {
    const o: Record<string, unknown> = {};
    if (this.newMeta.length) { o.meta = this.newMeta; this.newMeta = []; }
    if (this.pts.size) { o.plots = Object.fromEntries(this.pts); this.pts = new Map(); }
    if (this.hlDirty) { o.hlines = [...this.hl.values()]; this.hlDirty = false; }
    if (this.fillPts.size) { o.fills = [...this.fillPts.values()]; this.fillPts = new Map(); }
    if (this.bgs.length) { o.bg = this.bgs; this.bgs = []; }
    if (this.marks.length) { o.marks = this.marks; this.marks = []; }
    if (this.dirty.size) { o.draw = [...this.dirty.values()].map(d => this.drawingOut(d)); this.dirty = new Map(); }
    if (this.gone.length) { o.del = this.gone; this.gone = []; }
    if (err) o.error = err;
    return JSON.stringify(o);
  }
}

/** a drawing as Python's Drawing: fields read and set as properties, each set checked as Python checks it */
function drawing(ind: Ind, kind: Kind, fields: Record<string, unknown>): Drawing {
  const allowed = FIELDS[kind], f: Record<string, unknown> = {};
  const base = { kind, id: ind.nextId(), alive: true, _f: f } as any;
  const setOne = (k: string, v: unknown) => {
    if (!allowed.includes(k)) throw new AttributeError(`A ${kind} has no '${k}'. It has: ${allowed.join(', ')}.`);
    if (XF.has(k)) ind.x(v); // checks it now, so the error points at this line
    else if (YF.has(k)) v = finite(v);
    else if (CF.has(k)) v = color(v, k);
    else if (k === 'width') v = clampW(v);
    else if (k === 'text') v = v == null ? '' : str(v).slice(0, 200);
    f[k] = v;
  };
  let proxy: Drawing;
  base.set = (o: Record<string, unknown>) => { for (const [k, v] of Object.entries(o || {})) setOne(k, v); if (base.alive) ind.dirty.set(base.id, proxy); return proxy; };
  base.delete = () => { if (base.alive) { base.alive = false; ind.remove(proxy); } };
  base.toString = () => `${kind[0].toUpperCase() + kind.slice(1)}(${Object.entries(f).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')})`;
  proxy = new Proxy(base, {
    get(o, k) { if (typeof k === 'string' && k in f && !(k in o)) return f[k]; return o[k as any]; },
    set(o, k, v) {
      if (typeof k !== 'string') return false;
      if (k === 'kind' || k === 'id' || k === 'alive' || k === 'set' || k === 'delete' || k === '_f') throw new AttributeError(`A ${kind}'s ${k} can't be changed.`);
      base.set({ [k]: v }); return true;
    },
    has(o, k) { return (typeof k === 'string' && k in f) || k in o; },
  }) as Drawing;
  base.set(fields);
  return proxy;
}

/** what an indicator sees and draws: on_bar runs when each candle of the chart closes */
export class IndCtx {
  readonly symbol: string; readonly timeframe: string; readonly tick_size: number; readonly point_value: number;
  price: number | null = null; bar_index = -1;
  /** @internal */ _k = 0; /** @internal */ _a: Float64Array[] = []; /** @internal */ _tfs: number;
  /** @internal */ _t: number | null = null; /** @internal */ _off = 0; /** @internal */ _z: ZTime | null = null;
  private _prec: number;
  [k: string]: unknown;
  constructor(private _ind: Ind, info: any, readonly _print: (s: string) => void) {
    this.symbol = info.name ?? ''; this.timeframe = info.tf ?? ''; this.tick_size = info.tick ?? 0.01; this.point_value = info.pv ?? 1;
    this._prec = Math.trunc(info.prec ?? 2); this._tfs = +(info.tfs ?? 60);
    for (let j = 0; j < 6; j++) this._a.push(new Float64Array(4096));
  }
  get time() { return this._z ||= this._t == null ? null : new ZTime(this._t, this._off); }
  /** @internal */
  _push(t: number, o: number, h: number, l: number, c: number, v: number) {
    if (this._k >= this._a[0].length) this._a = this._a.map(a => { const b = new Float64Array(a.length * 2); b.set(a); return b; });
    const k = this._k; this._a[0][k] = t; this._a[1][k] = o; this._a[2][k] = h; this._a[3][k] = l; this._a[4][k] = c; this._a[5][k] = v; this._k++;
  }
  // ---- candles: the last n closed ones (all without n), oldest first; views, do not write into them
  private col(j: number, n?: number | null) { return this._a[j].subarray(n ? Math.max(0, this._k - n) : 0, this._k); }
  times(n?: number) { return this.col(0, n); }
  opens(n?: number) { return this.col(1, n); }
  highs(n?: number) { return this.col(2, n); }
  lows(n?: number) { return this.col(3, n); }
  closes(n?: number) { return this.col(4, n); }
  volumes(n?: number) { return this.col(5, n); }
  df(): never { throw new Error('ctx.df() needs pandas, so it works in Python indicators only. Use ctx.closes() and the others.'); }
  round(p: number) { const m = 10 ** this._prec; return Math.round(p * m) / m; }
  ticks(n: number) { return n * this.tick_size; }
  /** "09:30" as seconds since midnight, to compare with bar.time.time() */
  at(hhmm: string) { const [h, m] = String(hhmm).trim().split(':'); return +h * 3600 + +m * 60; }

  /** a line through this value on each bar: plot(ema, "EMA 20", { color: "orange" }). null or NaN leaves a gap. */
  plot(value: unknown, ...a: unknown[]) { const o = kw(a, ['title', 'color', 'width', 'style', 'pane'], { title: null, color: null, width: 1, style: 'line', pane: 'price' }); this._ind.plot(value, o.title, o.color, o.width, o.style, o.pane); }
  /** a horizontal level across the chart: hline(70, { pane: "lower" }) */
  hline(price: unknown, ...a: unknown[]) { const o = kw(a, ['title', 'color', 'width', 'style', 'pane'], { title: null, color: 'muted', width: 1, style: 'dashed', pane: 'price' }); this._ind.hline(price, o.title, o.color, o.width, o.style, o.pane); }
  /** shade between two plots on this bar, given by their titles */
  fill(plot1: unknown, plot2: unknown, c?: unknown) { const o = kw(c === undefined ? [] : [c], ['color'], { color: null }); this._ind.fill(plot1, plot2, o.color); }
  /** tint the chart's background behind this candle */
  bgcolor(c: unknown) { this._ind.bg(c); }
  /** a marker on this candle (or on bar index or time `at`) */
  marker(...a: unknown[]) { const o = kw(a, ['text', 'shape', 'position', 'color', 'at', 'size'], { text: '', shape: 'circle', position: 'above', color: 'accent', at: null, size: 1 }); this._ind.marker(o.text, o.shape, o.position, o.color, o.at, o.size); }
  /** a rectangle from (left, top) to (right, bottom); returns it */
  box(left: unknown, top: unknown, right: unknown, bottom: unknown, ...a: unknown[]) {
    const o = kw(a, ['color', 'fill', 'width', 'style', 'text', 'text_color', 'extend'], { color: 'accent', fill: null, width: 1, style: 'solid', text: '', text_color: null, extend: false });
    return this._ind.make('box', { left, top, right, bottom, color: o.color, fill: o.fill == null ? rgba(o.color, 0.15) : o.fill, width: o.width, style: o.style, text: o.text, text_color: o.text_color, extend: !!o.extend });
  }
  /** a line from (x1, y1) to (x2, y2); extend: none, right, left or both */
  line(x1: unknown, y1: unknown, x2: unknown, y2: unknown, ...a: unknown[]) {
    const o = kw(a, ['color', 'width', 'style', 'extend'], { color: 'accent', width: 1, style: 'solid', extend: 'none' });
    return this._ind.make('line', { x1, y1, x2, y2, color: o.color, width: o.width, style: o.style, extend: o.extend });
  }
  /** text at bar index or time x and price y; style up, down, center or text */
  label(x: unknown, y: unknown, text: unknown, ...a: unknown[]) {
    const o = kw(a, ['color', 'text_color', 'style'], { color: 'accent', text_color: null, style: 'up' });
    return this._ind.make('label', { x, y, text, color: o.color, text_color: o.text_color, style: o.style });
  }
  get boxes() { return [...this._ind.objs.values()].filter(d => d.kind === 'box'); }
  get lines() { return [...this._ind.objs.values()].filter(d => d.kind === 'line'); }
  get labels() { return [...this._ind.objs.values()].filter(d => d.kind === 'label'); }
  /** delete every box, line and label this indicator drew */
  clear() { for (const d of [...this._ind.objs.values()]) d.delete(); }
}

/* ---- compiling: the same wrapper as JS strategies, so errors point at the user's lines ---- */
type Hooks = { init?: (c: IndCtx) => void; on_bar?: (c: IndCtx, b: Bar) => void };
function compile(code: string): (param: unknown, ta: unknown, print: unknown, rgba: unknown) => Hooks {
  return new Function('param', 'ta', 'print', 'rgba', '"use strict";\n' + code +
    '\n;return { init: typeof init === "function" ? init : undefined, on_bar: typeof on_bar === "function" ? on_bar : undefined };\n//# sourceURL=<strategy>') as any;
}
/** the indicator's syntax error, or null */
export function jsIndCheck(code: string): string | null { try { compile(code); return null; } catch (e) { return jsError(e, code); } }

/* ---- the instances, by id, as the page runs them (the worker calls these, like Python's _ti_*) ---- */
const INST = new Map<string, Ind>();
const show = (x: unknown): string => Array.isArray(x) || ArrayBuffer.isView(x) ? '[' + Array.from(x as ArrayLike<unknown>).map(show).join(', ') + ']'
  : x !== null && typeof x === 'object' && (x as object).toString === Object.prototype.toString ? JSON.stringify(x) : String(x);

/** start instance iid: JSON like Python's _ti_start. print() output goes to log. */
export function jsIndStart(iid: string, code: string, infoJson: string, log: (s: string) => void = () => {}): string {
  const print = (...a: unknown[]) => log(a.map(show).join(' '));
  const ind = new Ind(JSON.parse(infoJson), print);
  ind.code = code;
  INST.set(iid, ind);
  try {
    const H = compile(code)(param, ta, print, rgba);
    if (typeof H.on_bar !== 'function') throw new NameError('An indicator needs an on_bar(ctx, bar) function.');
    ind.onBar = H.on_bar;
    if (typeof H.init === 'function') H.init(ind.ctx);
  } catch (e) {
    ind.err = e instanceof NameError ? `NameError: ${e.message}` : jsError(e, code);
    return ind.out(ind.err);
  }
  return ind.out();
}
/** closed candles for instance iid, 7 numbers each (time, open, high, low, close, volume, zone offset): JSON of what
 *  to draw since the last call, with "error" if on_bar failed (it then stops) */
export function jsIndFeed(iid: string, buf: ArrayLike<number>): string {
  const ind = INST.get(iid);
  if (!ind || ind.err) return '{}';
  const c = ind.ctx, f = ind.onBar!;
  try {
    for (let x = 0; x + 7 <= buf.length; x += 7) {
      c._push(buf[x], buf[x + 1], buf[x + 2], buf[x + 3], buf[x + 4], buf[x + 5]);
      c.bar_index++; c._t = buf[x]; c._off = buf[x + 6]; c._z = null; c.price = buf[x + 4];
      f(c, new Bar(buf[x], buf[x + 6], buf[x + 1], buf[x + 2], buf[x + 3], buf[x + 4], buf[x + 5], c.bar_index));
      ind.endBar();
    }
  } catch (e) {
    ind.err = jsError(e, ind.code);
    ind.endBar();
  }
  return ind.out(ind.err);
}
export function jsIndStop(iid: string) { INST.delete(iid); }
