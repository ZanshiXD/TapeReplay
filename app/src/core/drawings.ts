// Drawings on the charts: what each one is (a tool, its anchor points in time and price, its style) and the store that
// keeps them per market, with undo and redo. Points are anchored to time and price, like TradingView, so a drawing
// stays on the same bars when the timeframe changes and when the replay moves on.

export interface Pt { t: number; p: number }
export interface Level { v: number; color: string; on: boolean }
export interface DrawStyle {
  color: string;
  width: number;
  /** 0 solid, 1 dashed, 2 dotted */
  dash: number;
  fill: boolean;
  fillColor: string;
  fillAlpha: number;
  text: string;
  textColor: string;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  extL: boolean;
  extR: boolean;
  levels: Level[];
  labels: boolean;
  prices: boolean;
  reverse: boolean;
  /** anything else a tool keeps (the risk on a position, how many columns a volume profile has, …) */
  opt: Record<string, number | string | boolean>;
}
export interface Drawing {
  id: string;
  tool: string;
  sym: string;
  pts: Pt[];
  style: DrawStyle;
  locked: boolean;
  hidden: boolean;
  /** shown on these chart timeframes only (empty: all) */
  tfs: Array<'sec' | 'min' | 'hour' | 'day'>;
  created: number;
}

export const BASE_STYLE: DrawStyle = {
  color: '#2962ff', width: 2, dash: 0, fill: false, fillColor: '#2962ff', fillAlpha: 0.15,
  text: '', textColor: '#d1d4dc', fontSize: 14, bold: false, italic: false,
  extL: false, extR: false, levels: [], labels: true, prices: true, reverse: false, opt: {},
};

export function makeStyle(over: Partial<DrawStyle> = {}): DrawStyle {
  return { ...BASE_STYLE, ...over, levels: (over.levels || BASE_STYLE.levels).map(l => ({ ...l })), opt: { ...BASE_STYLE.opt, ...(over.opt || {}) } };
}
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

let seq = 0;
const newId = () => 'd' + Date.now().toString(36) + (seq++).toString(36);

export class DrawStore {
  items: Drawing[] = [];
  /** bumps on every change, so the charts know to redraw */
  version = 0;
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private pending: string | null = null;
  onChange: (() => void) | null = null;

  forSym(sym: string) { return this.items.filter(d => d.sym === sym); }
  get(id: string | null) { return id ? this.items.find(d => d.id === id) || null : null; }

  private changed() { this.version++; this.onChange?.(); }
  /** remembers the state before a change, for undo */
  private save() { this.undoStack.push(JSON.stringify(this.items)); if (this.undoStack.length > 200) this.undoStack.shift(); this.redoStack = []; }
  /** for a change made in many small steps (dragging): begin() before, commit() after; one undo step */
  begin() { if (this.pending == null) this.pending = JSON.stringify(this.items); }
  commit() {
    if (this.pending == null) return;
    if (this.pending !== JSON.stringify(this.items)) { this.undoStack.push(this.pending); this.redoStack = []; }
    this.pending = null; this.changed();
  }
  /** undoes everything since begin() (a settings dialog's Cancel) */
  rollback() { if (this.pending == null) return; this.items = JSON.parse(this.pending); this.pending = null; this.changed(); }
  /** a change shown while it is being made (moving a point while dragging); begin() and commit() around it */
  live() { this.version++; }

  add(x: Omit<Drawing, 'id' | 'created' | 'locked' | 'hidden' | 'tfs'> & Partial<Pick<Drawing, 'locked' | 'hidden' | 'tfs'>>): Drawing {
    this.save();
    const d: Drawing = { locked: false, hidden: false, tfs: [], ...clone(x), id: newId(), created: Date.now() };
    this.items.push(d); this.changed();
    return d;
  }
  update(id: string, patch: Partial<Omit<Drawing, 'id' | 'style'>> & { style?: Partial<DrawStyle> }) {
    const d = this.get(id); if (!d) return;
    this.save();
    const { style, ...rest } = patch;
    Object.assign(d, clone(rest));
    if (style) d.style = { ...d.style, ...clone(style), opt: { ...d.style.opt, ...(style.opt || {}) } };
    this.changed();
  }
  remove(id: string) {
    const k = this.items.findIndex(d => d.id === id); if (k < 0) return;
    this.save(); this.items.splice(k, 1); this.changed();
  }
  /** removes every drawing on a market (or all markets); returns how many */
  clear(sym?: string) {
    const n = sym ? this.forSym(sym).length : this.items.length; if (!n) return 0;
    this.save(); this.items = sym ? this.items.filter(d => d.sym !== sym) : []; this.changed();
    return n;
  }
  clone(id: string, shift?: (p: Pt) => Pt): Drawing | null {
    const d = this.get(id); if (!d) return null;
    return this.add({ ...clone(d), pts: d.pts.map(p => shift ? shift(p) : { ...p }), locked: false, hidden: false });
  }
  /** brings forward (+1) or sends back (-1), or to the very front / back (+2 / -2) */
  order(id: string, dir: -2 | -1 | 1 | 2) {
    const k = this.items.findIndex(d => d.id === id); if (k < 0) return;
    this.save();
    const [d] = this.items.splice(k, 1);
    const j = dir === 2 ? this.items.length : dir === -2 ? 0 : Math.max(0, Math.min(this.items.length, k + dir));
    this.items.splice(j, 0, d); this.changed();
  }
  setAll(sym: string | null, patch: { locked?: boolean; hidden?: boolean }) {
    this.save();
    for (const d of this.items) if (!sym || d.sym === sym) Object.assign(d, patch);
    this.changed();
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
  undo() { const s = this.undoStack.pop(); if (s == null) return false; this.redoStack.push(JSON.stringify(this.items)); this.items = JSON.parse(s); this.changed(); return true; }
  redo() { const s = this.redoStack.pop(); if (s == null) return false; this.undoStack.push(JSON.stringify(this.items)); this.items = JSON.parse(s); this.changed(); return true; }

  /** everything, to save with a session */
  state() { return clone(this.items); }
  load(items: Drawing[]) { this.items = clone(items); this.undoStack = []; this.redoStack = []; this.changed(); }
}

/* ---- the numbers behind some tools (pure, so they can be tested) ---- */

export const FIB_RETRACE = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.618, 2.618, 3.618, 4.236];
export const FIB_ON = new Set([0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.618]);
export const FIB_COLORS = ['#787b86', '#f23645', '#ff9800', '#4caf50', '#089981', '#00bcd4', '#787b86', '#2962ff', '#f23645', '#9c27b0', '#e91e63'];
export function fibLevels(vals = FIB_RETRACE, on = FIB_ON): Level[] { return vals.map((v, k) => ({ v, color: FIB_COLORS[k % FIB_COLORS.length], on: on.has(v) })); }

/** the price of a fib level between p1 (level 1) and p2 (level 0), as TradingView draws a retracement */
export const fibPrice = (p1: number, p2: number, v: number) => p2 + (p1 - p2) * v;
/** trend-based extension: the move p0→p1, projected from p2 */
export const fibExtPrice = (p0: number, p1: number, p2: number, v: number) => p2 + (p1 - p0) * v;

/** a least-squares line through closes, with the largest distance above and below it */
export function regression(closes: number[]): { a: number; b: number; up: number; dn: number; sd: number } | null {
  const n = closes.length; if (n < 2) return null;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += i; sy += closes[i]; sxx += i * i; sxy += i * closes[i]; }
  const b = (n * sxy - sx * sy) / (n * sxx - sx * sx || 1), a = (sy - b * sx) / n;
  let up = 0, dn = 0, ss = 0;
  for (let i = 0; i < n; i++) { const r = closes[i] - (a + b * i); up = Math.max(up, r); dn = Math.min(dn, r); ss += r * r; }
  return { a, b, up, dn: -dn, sd: Math.sqrt(ss / n) };
}

/** volume at price: rows of [low, high, volume up, volume down], spreading each bar's volume over its range */
export function volumeProfile(bars: Array<{ o: number; h: number; l: number; c: number; v: number }>, rows: number) {
  if (!bars.length) return null;
  let lo = Infinity, hi = -Infinity;
  for (const b of bars) { lo = Math.min(lo, b.l); hi = Math.max(hi, b.h); }
  if (!(hi > lo)) hi = lo + 1e-9;
  const step = (hi - lo) / rows, up = new Float64Array(rows), dn = new Float64Array(rows);
  for (const b of bars) {
    const v = b.v || 1, a = Math.max(0, Math.floor((b.l - lo) / step)), z = Math.min(rows - 1, Math.floor((b.h - lo) / step)), share = v / (z - a + 1);
    for (let r = a; r <= z; r++) (b.c >= b.o ? up : dn)[r] += share;
  }
  let poc = 0, max = 0, total = 0;
  for (let r = 0; r < rows; r++) { const t = up[r] + dn[r]; total += t; if (t > max) { max = t; poc = r; } }
  // value area: 70% of the volume around the point of control
  let va0 = poc, va1 = poc, inVa = up[poc] + dn[poc];
  while (inVa < total * 0.7 && (va0 > 0 || va1 < rows - 1)) {
    const below = va0 > 0 ? up[va0 - 1] + dn[va0 - 1] : -1, above = va1 < rows - 1 ? up[va1 + 1] + dn[va1 + 1] : -1;
    if (above >= below) { va1++; inVa += above; } else { va0--; inVa += below; }
  }
  return { lo, hi, step, up: Array.from(up), dn: Array.from(dn), poc, max, va0, va1 };
}

/** anchored VWAP from a bar on: one value per bar */
export function anchoredVwap(bars: Array<{ h: number; l: number; c: number; v: number }>) {
  let pv = 0, vv = 0; const out: number[] = [];
  for (const b of bars) { const v = b.v || 1; pv += (b.h + b.l + b.c) / 3 * v; vv += v; out.push(pv / vv); }
  return out;
}

/** how a long or short position drawn on the chart played out on the bars after it */
export function positionOutcome(side: 1 | -1, entry: number, stop: number, target: number, bars: Array<{ time: number; h: number; l: number; c: number }>) {
  let filled = -1;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (filled < 0) { if (b.l <= entry && b.h >= entry) filled = i; else continue; }
    // the stop first when a bar reaches both, like the replay's fills
    const hitStop = side > 0 ? b.l <= stop : b.h >= stop, hitTarget = side > 0 ? b.h >= target : b.l <= target;
    if (hitStop) return { state: 'stop' as const, filled, at: i, exit: stop };
    if (hitTarget) return { state: 'target' as const, filled, at: i, exit: target };
  }
  if (filled < 0) return { state: 'waiting' as const, filled, at: -1, exit: null };
  return { state: 'open' as const, filled, at: bars.length - 1, exit: bars[bars.length - 1].c };
}
