// Robustness tests of an optimization's best combinations. The
// candidates run once each (opt workers, with trades: every closed trade's exit time and net, flat), from the
// optimization's start through the holdout; the tests are worked out from those trades, so changing the
// walk-forward windows or the Monte Carlo settings needs no new runs:
//   out of sample  each candidate on the holdout: dates the optimization did not rank on
//   walk-forward   the ranked dates cut into windows; in each, the candidate best on its in-sample part is the one
//                  traded on the next out-of-sample part, and those parts joined are the walk-forward result
//   Monte Carlo    each candidate's ranked-date trades resampled (or reshuffled, or with some skipped) many times:
//                  the spread of net P&L and drawdown, and how often a drawdown reaches the ruin level
import { optScore, mulberry32, type Goal, type OptRow, type Seg } from './optimizer';
import { lowerBound } from './time';

export const ROB_CAP = 200, ROB_CAP_SMALL = 30;

/** a candidate's trades between lo and hi (by exit time): the same figures as an optimization run's */
export function robSeg(tr: ArrayLike<number>, lo: number, hi: number): Seg {
  let trades = 0, net = 0, w = 0, gw = 0, gl = 0, cum = 0, peak = 0, dd = 0;
  for (let k = 0; k < tr.length; k += 2) {
    const t = tr[k]; if (t < lo || t >= hi) continue;
    const x = tr[k + 1]; trades++; net += x; cum += x;
    if (x > 0) { w++; gw += x; } else gl -= x;
    if (cum > peak) peak = cum;
    if (peak - cum > dd) dd = peak - cum;
  }
  return { trades, net, win: trades ? w / trades * 100 : null, pf: gl > 0 ? gw / gl : gw > 0 ? 1e9 : null, dd };
}
/** windows score as the optimization ranked (payouts need the whole run, so that goal scores as net ÷ max drawdown) */
export const robScore = (s: Seg, goal: Goal, minT: number) => optScore({ a: s }, goal === 'take' ? 'ndd' : goal, minT);
export const robDays = (a: number, b: number) => Math.max(1 / 24, (b - a) / 86400);
/** FNV-1a, 32 bits: a candidate's Monte Carlo seed is robHash(docId + ':' + i) */
export const robHash = (s: string) => { let h = 2166136261; for (let k = 0; k < s.length; k++) h = Math.imul(h ^ s.charCodeAt(k), 16777619); return h >>> 0; };
export { mulberry32 };

export interface Window { isFrom: number; isTo: number; oosFrom: number; oosTo: number; pick?: number | null; isSeg?: Seg | null; oos?: Seg | null }
/** n windows over [from, to): out-of-sample parts back to back after the first in-sample part (isPct of a window) */
export function robWindows(from: number, to: number, n: number, isPct: number, mode: 'rolling' | 'anchored'): Window[] {
  const r = isPct / 100, lo = (to - from) / (n + r / (1 - r)), li = lo * r / (1 - r), out: Window[] = [];
  for (let k = 0; k < n; k++) {
    const os = from + li + k * lo;
    out.push({ isFrom: mode === 'anchored' ? from : os - li, isTo: os, oosFrom: os, oosTo: k === n - 1 ? to : os + lo });
  }
  return out;
}
export interface MC { p5: number; p50: number; dd50: number; dd95: number; profit: number; ruin: number | null }
/** Monte Carlo of a list of trade nets: resample (with replacement) or shuffle, skipping a share of trades */
export function robMC(nets: number[], sims: number, mode: 'resample' | 'shuffle', skip: number, ruin: number, seed: number): MC {
  const rnd = mulberry32(seed), m = nets.length, buf = Float64Array.from(nets);
  const finals = new Float64Array(sims), dds = new Float64Array(sims);
  let ruined = 0;
  for (let s = 0; s < sims; s++) {
    if (mode === 'shuffle') for (let k = m - 1; k > 0; k--) { const j = Math.floor(rnd() * (k + 1)), t = buf[k]; buf[k] = buf[j]; buf[j] = t; }
    let cum = 0, peak = 0, dd = 0;
    for (let k = 0; k < m; k++) {
      if (skip && rnd() < skip) continue;
      cum += mode === 'shuffle' ? buf[k] : nets[Math.floor(rnd() * m)];
      if (cum > peak) peak = cum; else if (peak - cum > dd) dd = peak - cum;
    }
    finals[s] = cum; dds[s] = dd;
    if (ruin > 0 && dd >= ruin) ruined++;
  }
  finals.sort(); dds.sort();
  const at = (a: Float64Array, p: number) => a[Math.min(a.length - 1, Math.floor(p * a.length))];
  let up = 0; for (const x of finals) if (x > 0) up++;
  return { p5: at(finals, 0.05), p50: at(finals, 0.5), dd50: at(dds, 0.5), dd95: at(dds, 0.95), profit: up / sims, ruin: ruin > 0 ? ruined / sims : null };
}

/* ---- the settings and the candidates ---- */
export interface RobSpec {
  /** test the best pct % of ranked combinations (1..100, default 10), at most cap (200; 30 on phones) */
  pct: number;
  goal: Goal; minT: number;
  oos: boolean; oFrom: number; oTo: number;
  wf: boolean; wfN: number; wfIs: number; wfMode: 'rolling' | 'anchored';
  mc: boolean; mcN: number; mcMode: 'resample' | 'shuffle'; mcSkip: number; ruin: number;
}
export const ROB_DEFAULTS = { pct: 10, wfN: 6, wfIs: 70, wfMode: 'rolling', mcN: 1000, mcMode: 'resample', mcSkip: 0 } as const;
/** the candidates: the first pct % of the ranked rows (finite score, not failed), at most cap; rows sorted by score */
export function robCandidates(sorted: OptRow[], pct: number, cap = ROB_CAP): { cands: number[]; ranked: number; capped: boolean } {
  pct = Math.max(1, Math.min(100, Math.round(pct || 10)));
  const ranked = sorted.filter(r => isFinite(r.score ?? -Infinity) && !r.res.fail);
  const n = Math.min(ranked.length, cap, Math.max(1, Math.ceil(ranked.length * pct / 100)));
  return { cands: ranked.slice(0, n).map(r => r.i), ranked: ranked.length, capped: Math.ceil(ranked.length * pct / 100) > cap };
}
/** the dates the optimization ranked on: up to the Check period when there is one, else its whole range (to the first
 * bar after its last one) */
export function robRanked(doc: { from: number; to: number; splitT: number | null }, t?: ArrayLike<number>, base = 60): { from: number; to: number } {
  if (doc.splitT != null) return { from: doc.from, to: doc.splitT };
  const i = t && t.length ? Math.min(t.length - 1, lowerBound(t, doc.to) + 1) : -1;
  return { from: doc.from, to: i >= 0 && t![i] > doc.to ? t![i] : doc.to + base };
}
/** checks before running: {runTo} (how far the candidates must run) or {error}. oFrom may
 * move to the ranked end when the holdout starts on that same day (ymd: a time as YYYY-MM-DD in the chart zone). */
export function robPlan(sp: RobSpec, rk: { from: number; to: number }, lastBar: number, base: number, ymd: (t: number) => string): { runTo: number; oFrom: number } | { error: string } {
  if (!sp.oos && !sp.wf && !sp.mc) return { error: 'Tick at least one test.' };
  let runTo = rk.to, oFrom = sp.oFrom;
  if (sp.oos) {
    if (!isFinite(sp.oFrom) || !isFinite(sp.oTo) || sp.oTo <= sp.oFrom) return { error: 'Pick the holdout’s From and To dates.' };
    if (oFrom < rk.to && ymd(oFrom) === ymd(rk.to)) oFrom = rk.to;
    if (oFrom < rk.to) return { error: `The holdout must start on or after ${ymd(rk.to)}: the optimization ranked on the dates before that.` };
    if (oFrom > lastBar) return { error: `The loaded data ends on ${ymd(lastBar)}. Load more data to test out of sample, or untick it.` };
    runTo = Math.max(runTo, Math.min(sp.oTo, lastBar + base));
  }
  return { runTo, oFrom };
}

/* ---- the tests ---- */
export interface RobRow { i: number; is: Seg; isScore: number; oos?: Seg; eff?: number | null; wfUp?: number; mc?: MC | null; tests: number; pass: number }
export interface RobWF { wins: Window[]; all: Seg; up: number; picked: number; eff: number | null }
export interface RobView { rows: RobRow[]; wf: RobWF | null; oosOk: boolean; oFrom: number; oTo: number; rk: { from: number; to: number }; passAll: number; fails: Record<number, string>; message: string }
/** works out the tests: trades[i] = candidate i's flat [exitTime, net, ...]; docId seeds the Monte Carlo. Yields to
 * the page every 8 candidates of Monte Carlo when `yieldTo` is given. */
export async function robCompute(input: { docId: string; spec: RobSpec; cands: number[]; trades: Record<number, number[]>; runTo: number; rk: { from: number; to: number }; fails?: Record<number, string> },
                                 yieldTo?: (msg: string) => Promise<void> | void): Promise<RobView> {
  const { spec: sp, rk, trades: T } = input, cands = input.cands.filter(i => T[i]);
  const oosOk = sp.oos && isFinite(sp.oFrom) && input.runTo > sp.oFrom;
  const oTo = oosOk ? Math.min(sp.oTo, input.runTo) : 0;
  const rows: RobRow[] = cands.map(i => {
    const is = robSeg(T[i], rk.from, rk.to), row: RobRow = { i, is, isScore: robScore(is, sp.goal, sp.minT), tests: 0, pass: 0 };
    if (oosOk) {
      row.oos = robSeg(T[i], sp.oFrom, oTo);
      const isRate = is.net / robDays(rk.from, rk.to), oosRate = row.oos.net / robDays(sp.oFrom, oTo);
      row.eff = isRate > 0 ? oosRate / isRate * 100 : null;
    }
    return row;
  });
  let wf: RobWF | null = null;
  if (sp.wf && rows.length) {
    const wins = robWindows(rk.from, rk.to, sp.wfN, sp.wfIs, sp.wfMode), span = rk.to - rk.from, flat: number[] = [];
    let isNet = 0, isDays = 0, oosDays = 0;
    for (const w of wins) {
      const minT = sp.minT ? Math.max(1, Math.round(sp.minT * (w.isTo - w.isFrom) / span)) : 0;
      let best: { i: number; s: Seg; sc: number } | null = null;
      for (const r of rows) {
        const s = robSeg(T[r.i], w.isFrom, w.isTo), sc = robScore(s, sp.goal, minT);
        if (isFinite(sc) && (!best || sc > best.sc)) best = { i: r.i, s, sc };
      }
      w.pick = best ? best.i : null; w.isSeg = best ? best.s : null;
      w.oos = best ? robSeg(T[best.i], w.oosFrom, w.oosTo) : null;
      if (best) {
        const tr = T[best.i];
        for (let k = 0; k < tr.length; k += 2) if (tr[k] >= w.oosFrom && tr[k] < w.oosTo) flat.push(tr[k], tr[k + 1]);
        isNet += best.s.net / robDays(w.isFrom, w.isTo); isDays++;
      }
      oosDays += robDays(w.oosFrom, w.oosTo);
    }
    const all = robSeg(flat, -Infinity, Infinity), picked = wins.filter(w => w.pick != null);
    wf = { wins, all, up: picked.filter(w => w.oos!.net > 0).length, picked: picked.length, eff: isDays && isNet > 0 ? (all.net / oosDays) / (isNet / isDays) * 100 : null };
    for (const r of rows) r.wfUp = wins.filter(w => robSeg(T[r.i], w.oosFrom, w.oosTo).net > 0).length;
  }
  if (sp.mc) {
    for (const [k, r] of rows.entries()) {
      const tr = T[r.i], nets: number[] = [];
      for (let j = 0; j < tr.length; j += 2) if (tr[j] >= rk.from && tr[j] < rk.to) nets.push(tr[j + 1]);
      r.mc = nets.length ? robMC(nets, sp.mcN, sp.mcMode, sp.mcSkip / 100, sp.ruin, robHash(input.docId + ':' + r.i)) : null;
      if (yieldTo && k % 8 === 7) await yieldTo(`Monte Carlo: ${k + 1} of ${rows.length}…`);
    }
  }
  // what passes: holdout in profit with a profit factor of at least 1; profitable in at least half the walk-forward
  // windows; Monte Carlo in profit in 70% of simulations (when the method can change the total) and ruined in 5% at most
  for (const r of rows) {
    const t: boolean[] = [];
    if (r.oos) t.push(r.oos.trades > 0 && r.oos.net > 0 && (r.oos.pf == null || r.oos.pf >= 1));
    if (wf) t.push(r.wfUp! >= Math.ceil(sp.wfN / 2));
    if (r.mc) {
      const totalMoves = sp.mcMode === 'resample' || sp.mcSkip > 0;
      if (totalMoves || r.mc.ruin != null) t.push((!totalMoves || r.mc.profit >= 0.7) && (r.mc.ruin == null || r.mc.ruin <= 0.05));
    }
    r.tests = t.length; r.pass = t.filter(Boolean).length;
  }
  const fails = input.fails || {}, nf = Object.keys(fails).length;
  return { rows, wf, oosOk, oFrom: sp.oFrom, oTo, rk, passAll: rows.filter(r => r.tests && r.pass === r.tests).length, fails,
           message: `${rows.length} candidate${rows.length === 1 ? '' : 's'} tested.${nf ? ` ${nf} failed to run.` : ''}` };
}
/** the summary line above the table (ymd: YYYY-MM-DD in the chart zone) */
export function robSummary(v: RobView, ymd: (t: number) => string): string {
  return `${v.passAll} of ${v.rows.length} candidates passed every test they took. Ranked dates ${ymd(v.rk.from)} to ${ymd(v.rk.to - 1)}` +
    (v.oosOk ? `; holdout ${ymd(v.oFrom)} to ${ymd(v.oTo - 1)}` : '') + '. Passing: holdout in profit with a profit factor of 1 or more; profitable in at least half the walk-forward windows; ' +
    'Monte Carlo in profit in 70% of simulations and ruined in 5% at most.' +
    (v.wf ? ' Walk-forward picks from these candidates, which were chosen on the whole ranked range, so its windows are not unseen: the holdout is.' : '');
}
/** sorting the table: pass (default, descending), p:NAME, is.net, oos.pf, eff, wfUp, mc.p5... */
export function robSorted(v: RobView, combos: Array<Record<string, unknown>>, key = 'pass', dir = -1): RobRow[] {
  const val = (r: RobRow, k: string): number | string => {
    if (k === 'pass') return r.tests ? r.pass / r.tests + r.pass * 1e-3 : -1;
    if (k.startsWith('p:')) { const x = combos[r.i][k.slice(2)]; return typeof x === 'number' ? x : String(x); }
    const [a, b] = k.split('.'); const o: any = a === 'eff' || a === 'wfUp' || a === 'isScore' ? (r as any)[a] : (r as any)[a] && (r as any)[a][b];
    return o == null || (typeof o === 'number' && !isFinite(o)) ? -Infinity : o;
  };
  return v.rows.slice().sort((x, y) => { const a = val(x, key), b = val(y, key); return (a < b ? -1 : a > b ? 1 : x.i - y.i) * dir; });
}
/** the first click on a column sorts ascending for settings, drawdowns and ruin, else descending */
export const robSortDir = (key: string) => key.startsWith('p:') || key.endsWith('.dd') || key.endsWith('dd95') || key.endsWith('ruin') ? 1 : -1;
/** all candidates as CSV */
export function robCsv(v: RobView, combos: Array<Record<string, any>>, names: string[], fmt: (x: any) => string): string {
  const f = (x: number | null | undefined) => x == null || !isFinite(x) ? '' : x >= 1e8 ? 'inf' : +x.toFixed(4);
  const head = [...names, 'ranked_net', 'ranked_pf', 'ranked_dd', 'holdout_trades', 'holdout_net', 'holdout_pf', 'holdout_dd', 'holdout_vs_ranked_pct', 'wf_windows_in_profit', 'mc_in_profit', 'mc_net_p5', 'mc_net_p50', 'mc_dd_p50', 'mc_dd_p95', 'mc_ruin', 'passed', 'tests'];
  const rows = v.rows.map(r => { const c = combos[r.i], o: Partial<Seg> = r.oos || {}, m: Partial<MC> = r.mc || {};
    return [...names.map(n => fmt(c[n])), f(r.is.net), f(r.is.pf), f(r.is.dd), o.trades ?? '', f(o.net), f(o.pf), f(o.dd), f(r.eff), r.wfUp ?? '', f(m.profit), f(m.p5), f(m.p50), f(m.dd50), f(m.dd95), f(m.ruin), r.pass, r.tests]; });
  return [head, ...rows].map(r => r.join(',')).join('\n');
}
