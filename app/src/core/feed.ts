// One market's replay: a cursor over its bars, the simulated ticks inside each bar, and the candles at the chart's
// timeframe. Ported from the classic app's replay engine (buildTicks, processTick, rebuild), unchanged in how a bar
// plays: open, then low and high (in the order the bar's direction makes likely), then close, on an even grid of
// ticks with the turning points kept exactly.
import type { Candle, Series } from './series';
import { makeBucket, tfSeconds, type TF } from './time';
import { makeInd, type Ind, type IndSpec } from './indicators';

/** the chart keeps the most recent candles only (indicators still see all of history) */
const MAX_CANDLES = 40000, CANDLE_SLACK = 5000;

export interface TickMove { from: number; to: number; jump: boolean }
export interface FeedSnap { i: number }

export class Feed {
  readonly s: Series;
  tf: TF;
  bucket: (t: number) => number;
  ticksPerBar: number;
  i: number; k = 0; nt = 0;
  readonly tkF = new Float64Array(608);
  readonly tkP = new Float64Array(608);
  time: number; price: number | null; prevClose: number | null; barTime: number;
  /** the candle forming now, and the base bar playing now */
  F: Candle | null = null;
  P: Candle | null = null;
  candles: Candle[] = [];
  /** bumps whenever the candles are rebuilt rather than added to, so the chart redraws them all */
  version = 0;
  inds: Array<{ spec: IndSpec; ind: Ind; vals: Array<number | null> }> = [];
  private indSpecs: IndSpec[] = [];
  /** the first bar of the replay: what is before it is history, shown but not traded */
  readonly start: number;
  /** false: no chart candles kept (backtests aggregate their own), so nothing is built from the history either */
  readonly chart: boolean;

  constructor(s: Series, startIdx: number, tf: TF, ticksPerBar = 20, inds: IndSpec[] = [], chart = true) {
    this.s = s; this.tf = tf; this.bucket = makeBucket(tf); this.ticksPerBar = ticksPerBar; this.chart = chart;
    this.start = this.i = Math.max(0, Math.min(startIdx, s.n));
    const prevT = this.i > 0 ? s.t[this.i - 1] : s.t[0] - s.base;
    this.price = this.prevClose = this.i > 0 ? s.c[this.i - 1] : null;
    this.time = prevT + s.base; this.barTime = prevT;
    this.indSpecs = inds;
    this.rebuild();
  }

  get done() { return this.i >= this.s.n; }
  get tick() { return this.s.inst.tick; }
  // to the tick grid, then to the decimals shown (as toFixed would, without making text: this runs for every tick)
  round(x: number) { const tk = this.s.inst.tick, m = 10 ** this.s.inst.prec; return Math.round(Math.round(x / tk) * tk * m) / m; }

  /** the ticks of bar i (open, then the near extreme, the far one, the close), written to F and P; returns how many */
  private buildTicks(i: number): number {
    const s = this.s, F = this.tkF, P = this.tkP;
    const o = s.o[i], h = s.h[i], l = s.l[i], c = s.c[i];
    const p0 = o, p1 = c >= o ? l : h, p2 = c >= o ? h : l, p3 = c;
    const s0 = Math.abs(p1 - p0), s1 = Math.abs(p2 - p1), s2 = Math.abs(p3 - p2), tot = s0 + s1 + s2;
    if (tot === 0) { F[0] = 0; P[0] = o; F[1] = 1; P[1] = c; return 2; }
    const at = (f: number) => {
      const d = f * tot;
      if (d <= s0) return s0 ? p0 + (p1 - p0) * d / s0 : p0;
      if (d <= s0 + s1) return s1 ? p1 + (p2 - p1) * (d - s0) / s1 : p1;
      return s2 ? p2 + (p3 - p2) * Math.min(1, (d - s0 - s1) / s2) : p2;
    };
    const N = Math.max(4, Math.min(600, this.ticksPerBar)), ta = s0 / tot, tb = (s0 + s1) / tot;
    let n = 0, j = 0;
    const put = (f: number) => { if (n === 0 || F[n - 1] !== f) F[n++] = f; };
    for (let k = 0; k < N; k++) {
      const g = k / (N - 1);
      for (; j < 2; j++) { const x = j ? tb : ta; if (x < g) put(x); else break; }
      put(g);
    }
    for (; j < 2; j++) put(j ? tb : ta);
    for (let k = 0; k < n; k++) P[k] = this.round(at(F[k]));
    return n;
  }

  nextTickTime(): number {
    if (this.i >= this.s.n) return Infinity;
    if (!this.nt) this.nt = this.buildTicks(this.i);
    return this.s.t[this.i] + this.tkF[this.k] * this.s.base;
  }

  /** plays one tick; returns how the price moved (jump: the first tick of a bar, which may gap) */
  step(): TickMove | null {
    const s = this.s, i = this.i; if (i >= s.n) return null;
    if (!this.nt) this.nt = this.buildTicks(i);
    const f = this.tkF[this.k], p = this.tkP[this.k];
    this.barTime = s.t[i];
    this.time = s.t[i] + f * s.base;
    let move: TickMove;
    if (this.k === 0) {
      const b = this.F ? Math.max(this.bucket(s.t[i]), this.F.time) : this.bucket(s.t[i]);
      if (!this.F || this.F.time !== b) { if (this.F) this.completeForming(); this.F = { time: b, o: p, h: p, l: p, c: p, v: 0 }; }
      else { const F = this.F; if (p > F.h) F.h = p; if (p < F.l) F.l = p; F.c = p; }
      this.P = { time: s.t[i], o: p, h: p, l: p, c: p, v: 0 };
      move = { from: this.prevClose == null ? p : this.prevClose, to: p, jump: true };
      this.price = p;
    } else {
      move = { from: this.price!, to: p, jump: false };
      this.price = p;
      const F = this.F!, P = this.P!;
      if (p > F.h) F.h = p; if (p < F.l) F.l = p; F.c = p;
      if (p > P.h) P.h = p; if (p < P.l) P.l = p; P.c = p;
    }
    const dv = s.v[i] * (f - (this.k ? this.tkF[this.k - 1] : 0));
    this.F!.v += dv; this.P!.v += dv;
    this.k++;
    if (this.k >= this.nt) { this.prevClose = p; this.i++; this.k = 0; this.nt = 0; this.P = null; }
    return move;
  }

  /** true when the tick about to play starts a new candle at the chart timeframe */
  get atCandleStart() { return this.k === 0 && this.i < this.s.n && (!this.F || this.bucket(this.s.t[this.i]) > this.F.time); }

  private aggBar(t: number, o: number, h: number, l: number, c: number, v: number) {
    const F = this.F, b = F ? Math.max(this.bucket(t), F.time) : this.bucket(t);
    if (!F || F.time !== b) { if (F) this.completeForming(); this.F = { time: b, o, h, l, c, v }; }
    else { if (h > F.h) F.h = h; if (l < F.l) F.l = l; F.c = c; F.v += v; }
  }
  private completeForming() {
    if (!this.chart) return;
    const F = this.F!; this.candles.push(F);
    for (const x of this.inds) x.vals.push(x.ind.push(F));
    if (this.candles.length > MAX_CANDLES + CANDLE_SLACK) {
      const drop = this.candles.length - MAX_CANDLES;
      this.candles.splice(0, drop); for (const x of this.inds) x.vals.splice(0, drop);
      this.version++;
    }
  }
  /** the candles again from the first bar up to the cursor (after a timeframe change, a step back, new indicators) */
  rebuild() {
    const s = this.s;
    this.candles = []; this.F = null;
    const daily = tfSeconds(this.tf) >= 86400;
    this.inds = this.indSpecs.filter(x => x.on).map(spec => ({ spec, ind: makeInd(spec, { daily, hasVol: s.hasVol }), vals: [] }));
    if (this.chart) for (let j = 0; j < this.i; j++) this.aggBar(s.t[j], s.o[j], s.h[j], s.l[j], s.c[j], s.v[j]);
    if (this.P) this.aggBar(s.t[this.i], this.P.o, this.P.h, this.P.l, this.P.c, this.P.v);
    this.version++;
  }
  setTf(tf: TF) { this.tf = tf; this.bucket = makeBucket(tf); this.rebuild(); }
  setInds(specs: IndSpec[]) { this.indSpecs = specs; this.rebuild(); }
  /** an indicator's value on the forming candle */
  peek(k: number): number | null { const x = this.inds[k]; return x && this.F ? x.ind.peek(this.F) : null; }

  /** where the cursor is, to come back to with restore(): the start of the bar playing now */
  snap(): FeedSnap { return { i: this.i }; }
  restore(x: FeedSnap) { this.moveTo(x.i); }
  private moveTo(j: number) {
    const s = this.s;
    this.i = Math.max(0, Math.min(j, s.n)); this.k = 0; this.nt = 0; this.P = null;
    this.price = this.prevClose = this.i > 0 ? s.c[this.i - 1] : null;
    this.barTime = this.i > 0 ? s.t[this.i - 1] : s.t[0] - s.base; this.time = this.barTime + s.base;
    this.rebuild();
  }
  /** a whole base bar in one step, when nothing can happen inside it (no orders or trades on this market): the same
   * end state as playing its ticks, without the work. Used to skip ahead quickly. */
  skipBar() {
    const s = this.s, i = this.i; if (i >= s.n) return;
    if (this.k) { while (this.k && this.i === i) this.step(); return; }
    if (!this.chart) { // no candles to keep: only where the bar ends (its last tick is the close, rounded unless flat)
      const o = s.o[i], h = s.h[i], l = s.l[i], c = s.c[i], up = c >= o;
      const flat = Math.abs((up ? l : h) - o) + Math.abs(h - l) + Math.abs(c - (up ? h : l)) === 0;
      this.barTime = s.t[i]; this.time = s.t[i] + s.base;
      this.price = this.prevClose = flat ? c : this.round(c); this.i++; this.k = 0; this.nt = 0; this.P = null;
      return;
    }
    const n = this.nt || this.buildTicks(i), f = this.tkF, P = this.tkP, v = s.v[i], p0 = P[0];
    this.barTime = s.t[i];
    const b = this.F ? Math.max(this.bucket(s.t[i]), this.F.time) : this.bucket(s.t[i]);
    if (!this.F || this.F.time !== b) { if (this.F) this.completeForming(); this.F = { time: b, o: p0, h: p0, l: p0, c: p0, v: 0 }; }
    else { const F = this.F; if (p0 > F.h) F.h = p0; if (p0 < F.l) F.l = p0; F.c = p0; }
    const F = this.F; F.v += v * f[0];
    for (let k = 1; k < n; k++) { const p = P[k]; if (p > F.h) F.h = p; if (p < F.l) F.l = p; F.c = p; F.v += v * (f[k] - f[k - 1]); }
    const p = P[n - 1];
    this.time = s.t[i] + f[n - 1] * s.base;
    this.price = p; this.prevClose = p; this.i++; this.k = 0; this.nt = 0; this.P = null;
  }
  /** jump the cursor (forward or back) to the first bar at or after t, without playing the bars in between */
  seek(t: number) {
    const s = this.s; let j = 0, b = s.n;
    while (j < b) { const m = (j + b) >> 1; if (s.t[m] < t) j = m + 1; else b = m; }
    this.moveTo(j);
  }
}
