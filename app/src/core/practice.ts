// Practice markets: generated 1-second bars, not real market data, the same every time (sessions reopen exactly).
// The Nasdaq-style market is the original practice futures: daily levels drift from about 6,500
// to 25,500 with changing volatility, and each futures day (6 PM to 5 PM New York) is busy in US hours and quiet
// overnight. The S&P-style market moves with it, with its own slow wander, so the two diverge now and then — enough
// to practice SMT divergences on.
import { barColumns, type Bars, type Instrument, type Series } from './series';
import { localToUtc, tzOffset } from './time';

export const PRACTICE_FROM = Date.UTC(2019, 0, 7) / 1000;
export const PRACTICE_TO = Date.UTC(2026, 8, 30) / 1000;

export const PRACTICE: Record<string, Instrument> = {
  NQ: { sym: 'NQ', name: 'Practice Nasdaq-100', tick: 0.25, pv: 20, prec: 2, comm: 2.1, spreadTicks: 1, slipTicks: 1 },
  ES: { sym: 'ES', name: 'Practice S&P 500', tick: 0.25, pv: 50, prec: 2, comm: 2.1, spreadTicks: 1, slipTicks: 1 },
};

const mulberry = (seed: number) => { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const gaussOf = (r: () => number) => { let u = 0; while (!u) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); };
// how busy each minute of the New York day is (relative; 1 = a normal regular-hours minute)
const ACT = (() => {
  const a = new Float32Array(1440);
  for (let m = 0; m < 1440; m++) {
    let v;
    if (m >= 570 && m < 960) v = 0.62 + 0.95 * Math.exp(-(m - 570) / 22) + 0.55 * Math.exp(-(959 - m) / 28);
    else if (m >= 510 && m < 570) v = 0.3 + 0.8 * Math.exp(-(m - 510) / 5);
    else if (m >= 180 && m < 510) v = 0.2;
    else if (m >= 960 && m < 1020) v = 0.16;
    else v = 0.08 + 0.2 * Math.exp(-(((m - 1080) + 1440) % 1440) / 15);
    a[m] = v;
  }
  return a;
})();
const tradeChance = (a: number) => 1 - Math.exp(-1.7 * a);

interface Day { t0: number; t1: number; off: number }
let DAYS: { days: Day[]; lc: Float64Array; sig: Float32Array } | null = null;
function practiceDays() {
  if (DAYS) return DAYS;
  const days: Day[] = [], NY = 'America/New_York';
  for (let d = PRACTICE_FROM; d <= PRACTICE_TO; d += 86400) {
    const dt = new Date(d * 1000), wd = dt.getUTCDay(), mo = dt.getUTCMonth(), da = dt.getUTCDate();
    if (wd === 0 || wd === 6 || (mo === 0 && da === 1) || (mo === 11 && da === 25)) continue;
    const t0 = localToUtc(NY, dt.getUTCFullYear(), mo, da - 1, 18, 0), t1 = localToUtc(NY, dt.getUTCFullYear(), mo, da, 17, 0);
    days.push({ t0, t1, off: tzOffset(NY, t0 + 3600) });
  }
  const r = mulberry(20190107), n = days.length, lc = new Float64Array(n + 1), sig = new Float32Array(n);
  let lv = Math.log(0.0115);
  lc[0] = Math.log(6500);
  for (let i = 0; i < n; i++) {
    lv = 0.965 * lv + 0.035 * Math.log(0.0115) + 0.16 * gaussOf(r);
    const s = Math.min(0.05, Math.exp(lv)), g = gaussOf(r) * (r() < 0.03 ? 2.6 : 1);
    sig[i] = s; lc[i + 1] = lc[i] + 0.0006 + s * g;
  }
  const fix = Math.log(25500) - lc[n];
  for (let i = 1; i <= n; i++) lc[i] += fix * i / n;
  DAYS = { days, lc, sig };
  return DAYS;
}

/** the futures trading days that hold bars, as [open, close] in UTC */
export function practiceDayList(): Array<[number, number]> { return practiceDays().days.map(d => [d.t0, d.t1]); }

// one futures day of 1-second bars of the Nasdaq-style market, appended to out (only bars between t0 and t1)
function practiceDay(i: number, out: Bars, t0: number, t1: number) {
  const { days, lc, sig } = practiceDays(), d = days[i], n = d.t1 - d.t0;
  const r = mulberry(0x9E3779B1 ^ Math.imul(i + 1, 2654435761)), p0 = Math.exp(lc[i]), p1 = Math.exp(lc[i + 1]);
  const act = new Float32Array(n), inc = new Float32Array(n);
  let sumA = 0;
  for (let s = 0; s < n; s++) { const a = ACT[Math.floor((((d.t0 + s + d.off) / 60) % 1440 + 1440) % 1440)]; act[s] = a; sumA += a; }
  const k = p0 * sig[i] / Math.sqrt(sumA);
  let burst = 1, sumInc = 0;
  for (let s = 0; s < n; s++) {
    if (s % 60 === 0) burst = 0.9 * burst + 0.1 * (0.6 + 0.8 * Math.abs(gaussOf(r)) * 1.25);
    const x = k * Math.sqrt(act[s]) * burst * gaussOf(r); inc[s] = x; sumInc += x;
  }
  const drift = (p1 - p0 - sumInc) / sumA, tick = 0.25;
  let p = p0, cumA = 0, last = Math.round(p0 / tick) * tick;
  for (let s = 0; s < n; s++) {
    p += inc[s]; cumA += act[s];
    const t = d.t0 + s;
    if (r() >= tradeChance(act[s])) continue;
    const c = Math.round((p + drift * cumA) / tick) * tick, o = last, sd = k * Math.sqrt(act[s]) / tick;
    last = c;
    if (t < t0 || t > t1) continue;
    const hi = Math.max(o, c) + tick * Math.floor(Math.abs(gaussOf(r)) * sd * 0.45), lo = Math.min(o, c) - tick * Math.floor(Math.abs(gaussOf(r)) * sd * 0.45);
    out.push(t, o, hi, lo, c, 1 + Math.floor(Math.exp(gaussOf(r) * 0.9) * (1 + 5 * act[s])));
  }
}

/** the trading days whose bars fall between t0 and t1 */
function daysIn(t0: number, t1: number): number[] {
  const { days } = practiceDays(), want: number[] = [];
  for (let i = 0; i < days.length; i++) if (days[i].t1 >= t0 && days[i].t0 <= t1) want.push(i);
  return want;
}

/** the S&P-style market from the Nasdaq-style bars: the same moves scaled to its level, through a ratio that wanders
 * slowly and comes back, so most swings match and some don't */
function companion(nq: Bars, seed: number): Bars {
  const out = barColumns(nq.n + 16), r = mulberry(seed), tick = 0.25;
  let lr = 0, prevDay = -1;
  for (let j = 0; j < nq.n; j++) {
    const t = nq.t[j], day = Math.floor(t / 86400);
    if (day !== prevDay) { prevDay = day; lr *= 0.5; }
    lr = lr * 0.99995 + gaussOf(r) * 0.000045;
    const k = 0.2509 * Math.exp(lr);
    const q = (x: number) => Math.round(x * k / tick) * tick;
    const o = q(nq.o[j]), c = q(nq.c[j]);
    out.push(t, o, Math.max(o, c, q(nq.h[j])), Math.min(o, c, q(nq.l[j])), c, Math.max(1, Math.round(nq.v[j] * (0.6 + r() * 0.8))));
  }
  return out;
}

const asSeries = (B: Bars, inst: Instrument): Series => {
  const k = B.n;
  return { id: 'practice-' + inst.sym, inst, n: k, t: B.t.subarray(0, k), o: B.o.subarray(0, k), h: B.h.subarray(0, k), l: B.l.subarray(0, k), c: B.c.subarray(0, k), v: B.v.subarray(0, k), base: 1, hasVol: true, synthetic: true };
};

/** the practice markets between t0 and t1 (the Nasdaq-style market is always built, the others follow it) */
export async function practiceSeries(syms: string[], t0: number, t1: number, progress?: (f: number) => void): Promise<Series[]> {
  const want = daysIn(t0, t1);
  if (!want.length) throw new Error('There is no practice data in that date range.');
  const nq = barColumns(want.length * 30000);
  for (const [j, i] of want.entries()) {
    practiceDay(i, nq, t0, t1);
    if (progress && j % 2 === 1) { progress((j + 1) / want.length); await new Promise(r => setTimeout(r, 0)); }
  }
  if (nq.n < 2) throw new Error('There is no practice data in that date range.');
  return syms.map(s => s === 'NQ' ? asSeries(nq, PRACTICE.NQ) : asSeries(companion(nq, 4242), PRACTICE.ES));
}

/** a random trading day's New York open, for "a random day" (no hindsight) */
export function randomPracticeStart(rnd = Math.random): number {
  const { days } = practiceDays();
  const d = days[Math.floor(rnd() * (days.length - 30)) + 20];
  return d.t0 + (15.5 * 3600); // 6 PM + 15.5 h = 9:30 New York
}
