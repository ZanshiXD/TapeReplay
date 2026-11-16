// The optimizer (src/core/optimizer.ts, optjob.ts) and robustness tests (robust.ts) on the new core.
//   npx tsx tests/optimizer.test.ts
import { runBacktest, optLabel } from '../src/core/backtest';
import { jsStrategy } from '../src/core/jsstrategy';
import { distinctTotal, parseWhen, settle, offBy, stripWhen, tradesPrint, whenOf } from '../src/core/optimizer';
import { jsParams } from '../src/core/jsstrategy';
import { combos, comboAt, niceStep, OptPool, optCsv, optimize, optParse, optScore, optSorted, optText, optValues, optZoom, parseRules, seriesSlice, smartBudget, workerCount,
         type Combo, type Endpoint, type OptJob, type OptRes, type RunTasks } from '../src/core/optimizer';
import { jobHandler, runCombo } from '../src/core/optjob';
import { pyCombos, pyStrategy } from '../src/core/pybridge';
import { robCandidates, robCompute, robHash, robMC, robPlan, robRanked, robSeg, robWindows, type RobSpec } from '../src/core/robust';
import { parseTF, setZone } from '../src/core/time';
import { check, near, passed, python, walk } from './helpers';

setZone('America/New_York');
const t0 = performance.now();
const host = await python();

/* ---- values to try, rules, combinations ---- */
check(niceStep(1.5) === 2 && niceStep(0.333) === 0.5 && niceStep(7) === 10 && niceStep(0.02) === 0.02, 'niceStep');
check(optValues({ name: 'FAST', kind: 'int', value: 9 }).join() === '5,7,9,11,13', 'int setting, normal: 5..13 step 2');
check(optValues({ name: 'RR', kind: 'float', value: 2.0 }).join() === '1,1.5,2,2.5,3', 'float setting, normal');
check(optValues({ name: 'N', kind: 'int', value: 0, zero_off: true }).join() === '0,1,2,3,4,5,6', 'zero: 0..6');
check(optValues({ name: 'L', kind: 'int', value: 20, param: true, lo: 10, hi: 40, step: 5 }, 'param').join() === '10,15,20,25,30,35,40', "param()'s range");
check(optValues({ name: 'F', kind: 'int', value: 9 }, 'wide').join() === '4,9,14,19,24' && optValues({ name: 'F', kind: 'int', value: 9, zero_off: true }, 'narrow').includes(0), 'wide; 0 = off adds 0');
const pint = { name: 'X', kind: 'int' as const, value: 5 };
check(JSON.stringify(optParse(pint, '5..30 step 5')) === '{"vals":[5,10,15,20,25,30]}' && JSON.stringify(optParse(pint, '5, 10;20')) === '{"vals":[5,10,20]}', 'parsing ranges and lists');
check((optParse(pint, '1..2 step 0') as any).error === 'the step must be more than 0' && (optParse(pint, 'a, b') as any).error === 'numbers, separated by commas' && (optParse({ name: 'B', kind: 'bool', value: true }, 'yes, maybe') as any).error === 'use True and False', 'parse errors');
check(optText(pint, Array.from({ length: 20 }, (_, k) => k + 1)) === '1..20 step 1' && optText(pint, [1, 2, 5]) === '1, 2, 5', 'values as text');
const rules = ['FAST < SLOW', '# a comment', '', 'abs(FAST - SLOW) >= 5 or not LONG', '1 <= FAST < SLOW // 2 + 30', 'FAST % 2 == 1 or FAST / (SLOW - SLOW) > 1'];
const rr = parseRules(rules, ['FAST', 'SLOW', 'LONG']);
check('ok' in rr && rr.ok({ FAST: 5, SLOW: 10, LONG: true }) && !rr.ok({ FAST: 10, SLOW: 10, LONG: true }) && !rr.ok({ FAST: 4, SLOW: 10, LONG: false }), 'rules: comparisons, chains, and/or/not, an error counts as failing');
check((parseRules(['FAST <'], ['FAST']) as any).error === 'This rule is not valid Python: FAST <', 'invalid rule');
check((parseRules(['FAST < SLOWW and max(FAST, Q) > 1'], ['FAST', 'SLOW']) as any).error === 'The rule "FAST < SLOWW and max(FAST, Q) > 1" uses SLOWW, Q, which is not a ticked setting.', 'unknown names');
// Python's _tr_combos grid, exactly; rules give the same answers as Python's eval
const spec = { params: [{ name: 'FAST', values: [5, 10, 20] }, { name: 'SLOW', values: [10, 20, 30] }, { name: 'ALLOW_SHORT', values: [true, false] }], rules: ['FAST < SLOW'] };
const g = combos({ ...spec, mode: 'grid' }) as any, pg = pyCombos(host, { ...spec, mode: 'grid' });
check(g.total === 18 && g.skipped === 6 && g.combos.length === 12 && JSON.stringify(g.combos[0]) === '{"FAST":5,"SLOW":10,"ALLOW_SHORT":true}', 'grid: 18, 6 skipped by the rules, 12 left, first FAST=5 SLOW=10 ALLOW_SHORT=True');
check(JSON.stringify(g.combos) === JSON.stringify(pg.combos) && g.skipped === pg.skipped, 'the same combinations, in the same order, as _tr_combos in Python');
const many = { params: [{ name: 'A', values: Array.from({ length: 30 }, (_, k) => k) }, { name: 'B', values: Array.from({ length: 30 }, (_, k) => k * 0.5) }, { name: 'C', values: ['x', 'y', 'z'] }],
               rules: ['A % 3 != 1 and (B >= A / 4 or C == "y")', 'not (A > 20 and C != "x")', 'round(B) % 2 == 0 or A < 5', 'min(A, B) <= 10 and abs(A - 2 * B) != 3'] };
const tsg = combos({ ...many, mode: 'grid' }) as any, pyg = pyCombos(host, { ...many, mode: 'grid' });
check(tsg.combos.length > 100 && JSON.stringify(tsg.combos) === JSON.stringify(pyg.combos), `rules with arithmetic, chains and functions: the same as Python (${tsg.combos.length} of ${tsg.total})`);
const r1 = combos({ ...spec, mode: 'random', n: 5, seed: 42 }) as any, r2 = combos({ ...spec, mode: 'random', n: 5, seed: 42 }) as any, r3 = combos({ ...spec, mode: 'random', n: 5, seed: 43 }) as any;
check(r1.combos.length === 5 && new Set(r1.combos.map(optLabel)).size === 5 && JSON.stringify(r1) === JSON.stringify(r2) && JSON.stringify(r1) !== JSON.stringify(r3), 'random: unique, repeatable for a seed');
const big = { params: [{ name: 'A', values: Array.from({ length: 300 }, (_, k) => k) }, { name: 'B', values: Array.from({ length: 300 }, (_, k) => k) }] };
const over = combos({ ...big, mode: 'grid', cap: 20000 }) as any;
check(over.error === '90,000 combinations is more than 20,000. Narrow the ranges, or use a random sample.' && over.error === pyCombos(host, { ...big, mode: 'grid', cap: 20000 }).error, 'over the cap, in the same words');
const huge = { params: [{ name: 'A', values: Array.from({ length: 1000 }, (_, k) => k) }, { name: 'B', values: Array.from({ length: 1000 }, (_, k) => k) }] };
check((combos({ ...huge, mode: 'random', n: 50, seed: 1 }) as any).combos.length === 50, 'random from a huge grid');
check(JSON.stringify(comboAt(spec, 17)) === '{"FAST":20,"SLOW":30,"ALLOW_SHORT":false}', 'combination by number: the last setting fastest');

/* ---- scores and the table ---- */
const seg = (trades: number, net: number, dd: number, pf: number | null = 1) => ({ trades, net, win: 50, pf, dd });
check(optScore({ a: seg(20, 500, 250) }, 'ndd', 10) === 2 && optScore({ a: seg(20, 500, 0) }, 'ndd', 10) === 1e9 && optScore({ a: seg(5, 500, 1) }, 'ndd', 10) === -Infinity && optScore({ fail: 'x' }, 'net', 0) === -Infinity, 'scores: net ÷ drawdown, no drawdown, too few trades, failed');
check(optScore({ a: seg(20, 5, 1, null) }, 'pf', 0) === -1 && optScore({ a: seg(20, -5, 1) }, 'take', 0) === -5, 'profit factor with no trades closed at a loss or win; payouts fall back to net');
const rows = [{ i: 0, res: { a: seg(20, 100, 50) } }, { i: 1, res: { fail: 'boom' } }, { i: 2, res: { a: seg(20, 300, 50) } }, { i: 3, res: { a: seg(2, 900, 1) } }, { i: 4, res: { a: seg(20, 100, 50) } }];
const cmb: Combo[] = [{ F: 3 }, { F: 1 }, { F: 2 }, { F: 9 }, { F: 0 }];
check(optSorted(rows, cmb, 'ndd', 10).map(r => r.i).join() === '2,4,0,3,1', 'sorted by score (ties by number, in the same direction), failures last');
check(optSorted(rows, cmb, 'ndd', 10, 'p:F', 1).map(r => r.i).join() === '4,2,0,3,1', 'sorted by a setting');
const csv = optCsv(optSorted(rows, cmb, 'ndd', 10), cmb, ['F'], true).split('\n');
check(csv[0] === 'rank,F,goal,trades,net,win_pct,profit_factor,max_dd,check_trades,check_net,check_pf,check_dd,evaluations,passed,went_live,payouts,avg_payout,largest_payout,payouts_minus_fees,error' && csv[5].endsWith(',"boom"'), 'CSV, its columns');
const z = optZoom({ FAST: 10, SLOW: 30, ON: true }, [{ name: 'FAST', values: [5, 10, 15, 20] }, { name: 'SLOW', values: [10, 30, 50] }, { name: 'ON', values: [true, false] }], { FAST: 'int', SLOW: 'int', ON: 'bool' });
check(z[0].values.join() === '5,6,7,8,9,10,11,12,13,14,15' && z[1].values.join() === '10,15,20,25,30,35,40,45,50' && z[2].values.join() === 'true', 'zoom in around a combination');
check(workerCount({ cores: 64, shared: true }) === 32 && workerCount({ cores: 4, shared: true }) === 3 && workerCount({ cores: 12, shared: true, phone: true }) === 2 && workerCount({ cores: 12, shared: false, phone: true }) === 1 &&
      workerCount({ cores: 16, shared: false, bytes: 5e8 }) === 2 && workerCount({ cores: 64, shared: true, python: true, memGB: 4 }) === 20, 'workers: cores - 1 up to 32 (no 8 cap); phones; memory');

/* ---- runs in workers: the job handler behind fake workers that answer out of order ---- */
const MA = `
const FAST = 9, SLOW = 30;   // fast and slow averages
const STOP = 20;  // ticks
const LONG_ONLY = false;
function on_bar(ctx, bar) {
  const c = ctx.closes(SLOW);
  if (c.length < SLOW) return;
  let f = 0, s = 0;
  for (let k = 0; k < SLOW; k++) { s += c[k]; if (k >= SLOW - FAST) f += c[k]; }
  f /= FAST; s /= SLOW;
  if (f > s && ctx.position <= 0) { if (ctx.position) ctx.close(); ctx.buy({ sl: bar.close - ctx.ticks(STOP) }); }
  else if (f < s && ctx.position >= 0) { if (ctx.position) ctx.close(); if (!LONG_ONLY) ctx.sell({ sl: bar.close + ctx.ticks(STOP) }); }
}`;
const PY_MA = `
FAST, SLOW = 9, 30  # fast and slow averages
STOP = 20  # ticks
LONG_ONLY = False
def on_bar(ctx, bar):
    c = ctx.closes(SLOW)
    if len(c) < SLOW:
        return
    f, s = c[-FAST:].mean(), c.mean()
    if f > s and ctx.position <= 0:
        if ctx.position: ctx.close()
        ctx.buy(sl=bar.close - ctx.ticks(STOP))
    elif f < s and ctx.position >= 0:
        if ctx.position: ctx.close()
        if not LONG_ONLY: ctx.sell(sl=bar.close + ctx.ticks(STOP))
`;
let wid = 0;
const fake = (): Endpoint => {
  const h = jobHandler({ python: async () => host }), me = ++wid;
  const ep: Endpoint = {
    onmessage: null, terminate() { ep.onmessage = null; },
    postMessage(m: any) { setTimeout(() => h(structuredClone(m), r => setTimeout(() => ep.onmessage && ep.onmessage({ data: r }), (me * 7 + (m.idx ?? 0) * 3) % 11)), 0); },
  };
  return ep;
};
const s = walk(4000, 13), start = 300, end = 3800, tf5 = parseTF('5m')!;
const sl = seriesSlice(s, start, end);
const job: OptJob = { lang: 'js', code: MA, mode: 'bar', tf: '5m', data: sl.data, start: 1, end: sl.data.n, splitT: s.t[start + Math.floor((end - start) * 0.7)], balance: 50000, zone: 'America/New_York' };
const space = { params: [{ name: 'FAST', values: [3, 5, 8, 12, 16] }, { name: 'SLOW', values: [10, 20, 30, 45, 60] }, { name: 'LONG_ONLY', values: [false, true] }], rules: ['FAST < SLOW'] };
{
  const pool1 = new OptPool(fake, 0), pool4 = new OptPool(fake, 0);
  const a = await optimize({ ...space, search: 'grid', seed: 1, goal: 'ndd', minTrades: 5 }, pool1.runner(job, 1));
  const b = await optimize({ ...space, search: 'grid', seed: 1, goal: 'ndd', minTrades: 5 }, pool4.runner(job, 4));
  const key = (o: typeof a) => o.rows.slice().sort((x, y) => x.i - y.i).map(r => `${r.i} ${optLabel(o.combos[r.i])} ${JSON.stringify(r.res)}`).join('\n');
  check(!a.error && a.rows.length === 46 && a.skipped === 4 && key(a) === key(b), `grid: 46 runs (4 skipped by the rule), the same results on 1 and 4 workers`);
  check(a.best != null && a.best.score === b.best!.score && a.best.i === b.best!.i && isFinite(a.best.score!), 'the same best');
  // the optimization's figures are the chart's: trades and net of a + b
  const best = a.combos[a.best!.i], res = a.best!.res;
  const chart = await runBacktest({ series: s, startIdx: start, endIdx: end, tf: tf5, mode: 'bar', balance: 50000, overrides: best }, jsStrategy(MA), { slice: null });
  check(chart.account.hist.length === res.a!.trades + res.b!.trades && near(chart.stats.net, res.a!.net + res.b!.net, 0.01), `a run on the chart gives the optimization's trades and net (${chart.account.hist.length}, ${chart.stats.net.toFixed(2)})`);
  // Python in the workers: the same figures as JavaScript for the same strategy
  const pj = { ...job, lang: 'py' as const, code: PY_MA };
  const some = [{ FAST: 5, SLOW: 20, LONG_ONLY: false }, { FAST: 12, SLOW: 45, LONG_ONLY: true }];
  const pr: OptRes[] = [];
  await new OptPool(fake, 0).runner(pj, 2)(some.map((o, k) => ({ idx: k, overrides: o })), (i, r) => { pr[i] = r; });
  const jr = await Promise.all(some.map(o => runCombo(job, jsStrategy(MA), o)));
  check(JSON.stringify(pr) === JSON.stringify(jr), 'Python and JavaScript workers agree');
  // robustness: the candidates' trades give the optimization's segments
  const tr = await runCombo(job, jsStrategy(MA), best, true);
  const ra = robSeg(tr.tr!, -Infinity, job.splitT!), rb = robSeg(tr.tr!, job.splitT!, Infinity);
  check(ra.trades === res.a!.trades && near(ra.net, res.a!.net, 0.01 * ra.trades) && rb.trades === res.b!.trades && near(rb.net, res.b!.net, 0.01 * rb.trades), 'robustness segments == the optimization\'s (ranked and Check)');
  // resume: results known are not run again
  let ran = 0;
  const cache = new Map(a.rows.slice(0, 30).map(r => [optLabel(a.combos[r.i]), r.res] as [string, OptRes]));
  const c = await optimize({ ...space, search: 'grid', seed: 1, goal: 'ndd', minTrades: 5, cache }, (tasks, on) => { ran += tasks.length; return pool1.runner(job, 2)(tasks, on); });
  check(ran === 16 && key(c) === key(a), 'resume runs only what is missing');
  // stop: the pool resolves and the rest is left out
  const pool = new OptPool(fake, 0);
  let n = 0;
  const st = await optimize({ ...space, search: 'grid', seed: 1, goal: 'ndd', minTrades: 5 }, pool.runner(job, 2), { progress: () => { if (++n === 5) pool.stop(); } });
  check(st.stopped && st.rows.length >= 5 && st.rows.length < 46, `stopped after ${st.rows.length}`);
  pool1.close(); pool4.close(); pool.close();
}

/* ---- the smart search ---- */
// a known objective: a broad hill with ripples on a 60 x 50 grid, and a categorical setting that matters
const synth = (f: (c: Combo) => number): RunTasks => async (tasks, on) => { for (const t of tasks) on(t.idx, { a: { trades: 50, net: f(t.overrides), win: 50, pf: 1, dd: 1 }, b: null }); return { firstErr: '' }; };
const hill = (c: Combo) => { const x = c.X as number, y = c.Y as number; return 100 - ((x - 41) ** 2) / 30 - ((y - 13) ** 2) / 20 + 6 * Math.sin(x / 2.3) * Math.cos(y / 3.1) + (c.M === 'b' ? 8 : 0); };
const hs = { params: [{ name: 'X', values: Array.from({ length: 60 }, (_, k) => k) }, { name: 'Y', values: Array.from({ length: 50 }, (_, k) => k) }, { name: 'M', values: ['a', 'b', 'c'] }] };
{
  const grid = await optimize({ ...hs, search: 'grid', seed: 1, goal: 'net', minTrades: 0 }, synth(hill));
  let calls = 0;
  const counted = (f: (c: Combo) => number): RunTasks => async (t, on) => { calls += t.length; return synth(f)(t, on); };
  const sm = await optimize({ ...hs, search: 'smart', seed: 7, goal: 'net', minTrades: 0 }, counted(hill));
  const sm2 = await optimize({ ...hs, search: 'smart', seed: 7, goal: 'net', minTrades: 0 }, synth(hill));
  const ratio = sm.best!.score! / grid.best!.score!;
  console.log(`smart search on a known objective: ${calls} runs for ${grid.rows.length} in the grid; best ${sm.best!.score!.toFixed(2)} vs ${grid.best!.score!.toFixed(2)} (${optLabel(sm.combos[sm.best!.i])} vs ${optLabel(grid.combos[grid.best!.i])})`);
  check(calls === smartBudget(grid.rows.length) && calls <= grid.rows.length / 9, `smart: about a tenth of the runs (${calls} of ${grid.rows.length})`);
  check(ratio > 0.99, `smart: about the grid's best (${(ratio * 100).toFixed(2)}%)`);
  check(JSON.stringify(sm.combos) === JSON.stringify(sm2.combos) && sm.best!.i === sm2.best!.i, 'smart: the same runs for the same seed');
  let wins = 0, worst = 1;
  for (let seed = 1; seed <= 20; seed++) { const r = await optimize({ ...hs, search: 'smart', seed, goal: 'net', minTrades: 0 }, synth(hill)); const q = r.best!.score! / grid.best!.score!; worst = Math.min(worst, q); if (q > 0.995) wins++; }
  console.log(`  over 20 seeds: ${wins} within 0.5% of the grid's best, the worst at ${(worst * 100).toFixed(2)}%`);
  check(wins >= 15 && worst > 0.97, 'smart: reliably near the best over seeds');
  // rules are honoured, and nothing runs twice
  const ruled = await optimize({ ...hs, rules: ['X + Y < 70'], search: 'smart', seed: 3, goal: 'net', minTrades: 0 }, synth(hill));
  check(ruled.combos.every(c => (c.X as number) + (c.Y as number) < 70) && new Set(ruled.combos.map(optLabel)).size === ruled.combos.length && ruled.skipped > 0, 'smart: rules honoured, no combination twice');
}
// a real backtest: MA cross on 20 x 20 settings
{
  const ms = { params: [{ name: 'FAST', values: Array.from({ length: 20 }, (_, k) => k + 2) }, { name: 'SLOW', values: Array.from({ length: 20 }, (_, k) => 10 + 5 * k) }, { name: 'STOP', values: [10, 20, 40] }], rules: ['FAST < SLOW'] };
  const s2 = walk(2000, 17), sl2 = seriesSlice(s2, 1, s2.n), j2: OptJob = { ...job, data: sl2.data, end: sl2.data.n, splitT: null };
  const local: RunTasks = async (tasks, on) => { for (const t of tasks) on(t.idx, await runCombo(j2, jsStrategy(MA), t.overrides)); return { firstErr: '' }; };
  const tg = performance.now(), grid = await optimize({ ...ms, search: 'grid', seed: 1, goal: 'ndd', minTrades: 10 }, local), tgs = (performance.now() - tg) / 1000;
  const ts = performance.now(), sm = await optimize({ ...ms, search: 'smart', seed: 5, goal: 'ndd', minTrades: 10 }, local), tss = (performance.now() - ts) / 1000;
  const sorted = optSorted(grid.rows, grid.combos, 'ndd', 10), rank = sorted.findIndex(r => optLabel(grid.combos[r.i]) === optLabel(sm.combos[sm.best!.i]));
  console.log(`smart search on a backtest: ${sm.rows.length} runs (${tss.toFixed(1)} s) for ${grid.rows.length} (${tgs.toFixed(1)} s); best ${sm.best!.score!.toFixed(2)} vs ${grid.best!.score!.toFixed(2)}, rank ${rank + 1} of ${sorted.length} in the grid`);
  check(sm.rows.length <= grid.rows.length / 8 && rank < sorted.length * 0.02, `smart on a backtest: in the grid's top 2% with an eighth of the runs (rank ${rank + 1})`);
}

/* ---- robustness ---- */
{
  const w = robWindows(0, 7000, 4, 75, 'rolling');
  check(w.length === 4 && near(w[0].isFrom, 0) && near(w[0].isTo, 3000) && near(w[0].oosTo, 4000) && near(w[3].oosFrom, 6000) && w[3].oosTo === 7000 && near(w[1].isFrom, 1000), 'walk-forward windows: 3000 in sample, then 1000 out of sample, rolling');
  check(robWindows(0, 7000, 4, 75, 'anchored').every(x => x.isFrom === 0), 'anchored windows start at the start');
  check(robHash('a') === 0xe40c292c && robHash('doc1:3') === robHash('doc1:3') && robHash('doc1:3') !== robHash('doc1:4'), 'FNV-1a seeds');
  const nets = [120, -80, 45, -30, 200, -150, 60, 10, -5, 90];
  const m1 = robMC(nets, 1000, 'resample', 0, 300, 99), m2 = robMC(nets, 1000, 'resample', 0, 300, 99), m3 = robMC(nets, 1000, 'resample', 0, 300, 100);
  check(JSON.stringify(m1) === JSON.stringify(m2) && JSON.stringify(m1) !== JSON.stringify(m3) && m1.p5 <= m1.p50 && m1.dd50 <= m1.dd95 && m1.ruin != null, 'Monte Carlo: repeatable for a seed, ordered percentiles');
  const sh = robMC(nets, 500, 'shuffle', 0, 0, 1);
  check((sh.profit === 0 || sh.profit === 1) && near(sh.p5, 260) && sh.ruin === null, 'shuffling keeps the total: in profit in 0% or 100%');
  const sk = robMC(nets, 2000, 'shuffle', 0.2, 0, 1);
  check(sk.profit > 0 && sk.profit < 1, 'skipping trades moves the total');
  // a whole run: candidates from the grid above, 30% Check as the holdout
  const opt = await optimize({ ...space, search: 'grid', seed: 1, goal: 'ndd', minTrades: 5 }, async (tasks, on) => { for (const t of tasks) on(t.idx, await runCombo(job, jsStrategy(MA), t.overrides)); return { firstErr: '' }; });
  const sorted = optSorted(opt.rows, opt.combos, 'ndd', 5), cand = robCandidates(sorted, 50);
  check(cand.cands.length === Math.ceil(cand.ranked / 2) && cand.cands[0] === sorted[0].i, 'candidates: the best half of those ranked');
  const doc = { from: s.t[start], to: s.t[end - 1], splitT: job.splitT };
  const rk = robRanked(doc, s.t, s.base);
  const sp: RobSpec = { pct: 50, goal: 'ndd', minT: 5, oos: true, oFrom: job.splitT!, oTo: s.t[end - 1] + 60, wf: true, wfN: 3, wfIs: 70, wfMode: 'rolling', mc: true, mcN: 500, mcMode: 'resample', mcSkip: 0, ruin: 0 };
  const ymd = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
  const plan = robPlan(sp, rk, s.t[s.n - 1], s.base, ymd) as { runTo: number };
  check(plan.runTo === s.t[end - 1] + 60 && (robPlan({ ...sp, oos: false, wf: false, mc: false }, rk, 0, 60, ymd) as any).error === 'Tick at least one test.', 'the plan: run through the holdout');
  check((robPlan({ ...sp, oFrom: rk.from }, rk, s.t[s.n - 1], 60, ymd) as any).error?.startsWith('The holdout must start on or after '), 'a holdout inside the ranked dates is refused');
  const trades: Record<number, number[]> = {};
  for (const i of cand.cands) trades[i] = (await runCombo({ ...job, splitT: null }, jsStrategy(MA), opt.combos[i], true)).tr!;
  const v = await robCompute({ docId: 'doc-1', spec: sp, cands: cand.cands, trades, runTo: plan.runTo, rk });
  const v2 = await robCompute({ docId: 'doc-1', spec: sp, cands: cand.cands, trades, runTo: plan.runTo, rk });
  check(JSON.stringify(v) === JSON.stringify(v2) && v.rows.length === cand.cands.length && v.wf!.wins.length === 3 && v.oosOk, `${v.message} Repeatable; 3 windows`);
  for (const r of v.rows) {
    const res = opt.rows.find(x => x.i === r.i)!.res;
    check(r.is.trades === res.a!.trades && near(r.is.net, res.a!.net, 0.01 * r.is.trades) && r.oos!.trades === res.b!.trades && near(r.oos!.net, res.b!.net, 0.01 * r.oos!.trades), `candidate ${r.i}: ranked and holdout figures == the optimization's`);
    const t = (r.oos!.trades > 0 && r.oos!.net > 0 && (r.oos!.pf == null || r.oos!.pf >= 1) ? 1 : 0) + (r.wfUp! >= 2 ? 1 : 0) + (r.mc && r.mc.profit >= 0.7 ? 1 : 0);
    check(r.tests === (r.mc ? 3 : 2) && r.pass === t, `candidate ${r.i}: passes ${r.pass} of ${r.tests}`);
  }
  const shuf = await robCompute({ docId: 'doc-1', spec: { ...sp, mcMode: 'shuffle', wfN: 4 }, cands: cand.cands, trades, runTo: plan.runTo, rk });
  check(shuf.rows.every(r => !r.mc || r.mc.profit === 0 || r.mc.profit === 1) && shuf.rows.every(r => r.tests === 2) && shuf.wf!.wins.length === 4, 'shuffle without skips is not a Monte Carlo test; 4 windows, no new runs');
}

/* ---- "only when" notes: settings that are off in a combination are not tried at other values ---- */
{
  const w = parseWhen('ATR length, only when CHOP_MODE is "ATR" or "both"')!;
  check(w.on === 'CHOP_MODE' && JSON.stringify(w.vals) === '["ATR","both"]' && !w.not, 'a note: the setting it needs and the values');
  check(parseWhen('only when USE_TRAIL')!.vals === null && parseWhen('only when not USE_TRAIL')!.not && parseWhen('only if MODE is not "off"')!.not, 'only when NAME, not NAME, is not X');
  check(JSON.stringify(parseWhen('only when SIDE is 1 or -1')!.vals) === '[1,-1]' && parseWhen('no note here') === null, 'numbers; no note');
  check(stripWhen('ticks, only when MODE is "a" or "b"') === 'ticks, ', 'a comment without its note');
  const ps = [{ name: 'MODE', comment: '"EMA", "ATR", "both" or "off"' }, { name: 'ATR_LEN', comment: 'only when MODE is "ATR" or "both"' },
    { name: 'EMA_LEN', comment: 'only when MODE is "EMA" or "both"' }, { name: 'ATR_X', comment: 'only when ATR_LEN is 20' }, { name: 'BAD', comment: 'only when NOPE is 1' }];
  const when = whenOf(ps), base = { MODE: 'both', ATR_LEN: 14, EMA_LEN: 5, ATR_X: 1.5, BAD: 2 };
  check(Object.keys(when).join() === 'ATR_LEN,EMA_LEN,ATR_X', 'notes naming a setting there is (not one that is not)');
  const c1 = settle({ MODE: 'EMA', ATR_LEN: 20, EMA_LEN: 9, ATR_X: 3 }, when, base);
  check(c1.ATR_LEN === 14 && c1.EMA_LEN === 9 && c1.ATR_X === 1.5, 'EMA: the ATR settings back at their values, and one that needs ATR_LEN = 20 (a chain)');
  check(!!offBy('ATR_LEN', { MODE: 'EMA', ATR_LEN: 14 }, when, base) && !offBy('ATR_LEN', { MODE: 'ATR', ATR_LEN: 14 }, when, base), 'off in EMA, on in ATR');
  check(offBy('ATR_LEN', { ATR_LEN: 20 }, when, base) === null, 'MODE not tried: its value in the code (both) uses ATR_LEN');
  // 4 modes x 5 ATR lengths x 5 EMA lengths = 100; EMA 5, ATR 5, both 25, off 1 = 36
  const space = { params: [{ name: 'MODE', values: ['EMA', 'ATR', 'both', 'off'] }, { name: 'ATR_LEN', values: [10, 14, 20, 30, 40] }, { name: 'EMA_LEN', values: [3, 5, 9, 13, 21] }], when, base };
  check(distinctTotal(space) === 36, `36 different runs of 100 (${distinctTotal(space)})`);
  const g = combos({ ...space, mode: 'grid' }) as Exclude<ReturnType<typeof combos>, { error: string }>;
  check(g.combos.length === 36 && g.repeats === 64 && new Set(g.combos.map(optLabel)).size === 36, `the grid runs each once (${g.combos.length}, ${g.repeats} repeats)`);
  check(g.combos.filter(c => c.MODE === 'off').length === 1, '"off": one run');
  const rnd = combos({ ...space, mode: 'random', n: 50, seed: 3 }) as Exclude<ReturnType<typeof combos>, { error: string }>;
  check(rnd.combos.length === 36 && new Set(rnd.combos.map(optLabel)).size === 36, 'a random sample: no repeats either');
  check('error' in combos({ ...space, params: space.params, when: undefined, mode: 'grid', cap: 50 }) && !('error' in combos({ ...space, mode: 'grid', cap: 50 })), 'the cap counts different runs');
  // smart: never the same run twice, and repeats don't use up its budget
  const big = { params: [{ name: 'MODE', values: ['EMA', 'ATR', 'both', 'off'] }, { name: 'ATR_LEN', values: Array.from({ length: 20 }, (_, k) => 5 + k) }, { name: 'EMA_LEN', values: Array.from({ length: 20 }, (_, k) => 2 + k) }], when, base };
  const ran: string[] = [];
  const fake = async (tasks: Array<{ idx: number; overrides: Record<string, unknown> }>, on: (i: number, r: { a: { trades: number; net: number; win: number; pf: number; dd: number } }) => void) => {
    for (const t of tasks) { ran.push(optLabel(t.overrides as never)); const o = t.overrides as { MODE: string; ATR_LEN: number; EMA_LEN: number };
      const net = (o.MODE === 'both' ? 500 : o.MODE === 'off' ? 0 : 200) - Math.abs(o.ATR_LEN - 17) * 10 - Math.abs(o.EMA_LEN - 9) * 10;
      on(t.idx, { a: { trades: 50, net, win: 50, pf: 1.5, dd: 100 } }); }
    return { firstErr: '' };
  };
  const out = await optimize({ ...big, search: 'smart', n: 120, seed: 5, goal: 'net', minTrades: 1 }, fake as never);
  check(new Set(ran).size === ran.length && ran.length === 120, `smart: 120 different runs, none twice (${ran.length}, ${new Set(ran).size} different)`);
  check(out.repeats === 1600 - (distinctTotal(big) ?? 0) && distinctTotal(big) === 20 + 20 + 400 + 1, `smart: ${out.repeats} repeats of 1,600 not counted`);
  check(out.best != null && out.combos[out.best.i].MODE === 'both', 'smart: finds the best mode');
}
/* ---- the same trades: a fingerprint ---- */
{
  const tr = (net: number, t = 100) => ({ time: t, exitTime: t + 60, qty: 1, net, side: 1 } as never);
  check(tradesPrint([tr(10), tr(-5, 200)]) === tradesPrint([tr(10), tr(-5, 200)]), 'same trades, same fingerprint');
  check(tradesPrint([tr(10), tr(-5, 200)]) !== tradesPrint([tr(10), tr(-6, 200)]) && tradesPrint([tr(10)]) !== tradesPrint([tr(10), tr(0, 200)]), 'other trades, another');
}
/* ---- a choice's options: not the values in a note ---- */
{
  const r = jsParams('const MODE = "a";  // "a" or "b"\nconst SIDE = "long";  // only when MODE is "b" or "c"\nfunction on_bar(ctx, bar) {}\n') as { params: Array<{ name: string; choices?: unknown[] }> };
  const side = r.params.find(p => p.name === 'SIDE')!, mode = r.params.find(p => p.name === 'MODE')!;
  check(JSON.stringify(side.choices) === '["long"]' && JSON.stringify(mode.choices) === '["a","b"]', `a note's values are not options (${JSON.stringify(side.choices)})`);
}
console.log(`optimizer: ${passed} checks passed in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
void pyStrategy;
