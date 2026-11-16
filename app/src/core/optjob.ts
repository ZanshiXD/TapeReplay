// One optimization worker's work, apart from the worker itself so it also runs in the page and in tests. Messages:
//   {type:'warm', pyBase, libs}         start Python now                      -> {type:'warmed'}
//   {type:'init', job}                  the data and strategy for the runs    -> {type:'ready'} or {type:'error', error}
//   {type:'run', idx, overrides, trades} one run (trades: every closed trade's exit time and net, for robustness)
//                                                                             -> {type:'result', idx, res} or {type:'error', idx, error}
import { runBacktest, STOPPED_EARLY, type Bridge } from './backtest';
import { jsStrategy } from './jsstrategy';
import { simRes, totals, type Combo, type OptJob, type OptRes } from './optimizer';
import { simRules, type SimRun } from './prop';
import { pyStrategy, type PyHost } from './pybridge';
import { parseTF, setZone } from './time';

/** one run of an optimization job with these settings (the same runner and engine as a backtest on the chart) */
export async function runCombo(job: OptJob, bridge: Bridge, overrides: Combo, withTrades = false, ddStop?: number): Promise<OptRes> {
  const tf = parseTF(job.tf);
  if (!tf) return { fail: `Unknown timeframe ${job.tf}.` };
  const P = job.prop, sim: SimRun | null = P ? { sim: null, cfg: P.cfg } : null;
  const r = await runBacktest({ series: job.data, startIdx: job.start, endIdx: job.end, tf, mode: job.mode, balance: P ? P.cfg.size : job.balance, qty: job.qty, ticksPerBar: job.ticksPerBar,
    hedge: job.hedge, costs: job.costs, name: job.name, overrides, quiet: true, rules: P && sim ? simRules(P.cfg, P.rebuy, P.maxEvals, sim) : undefined, ddStop }, bridge, { slice: null, sliceMs: 0 });
  if (r.fail) return { fail: r.fail };
  if (r.ended.startsWith(STOPPED_EARLY)) return { fail: r.ended, cut: true }; // clearly beaten: not ranked
  const res = totals(r.account.hist, r.account.trades.length, job.splitT, withTrades);
  if (sim?.sim) res.sim = simRes(sim.sim.stats(), sim.sim.label());
  res.mdd = r.account.maxDD;
  return res;
}

/** the message handler: python(base, libs) gives a Python with those packages (loaded once per worker) */
export function jobHandler(env: { python: (base: string, libs: string[]) => Promise<PyHost> }) {
  let job: OptJob | null = null, host: PyHost | null = null;
  return async (m: any, post: (m: unknown) => void) => {
    try {
      if (m.type === 'warm') { await env.python(m.pyBase, m.libs || ['numpy']); post({ type: 'warmed' }); }
      else if (m.type === 'init') {
        job = m.job as OptJob;
        setZone(job.zone);
        host = job.lang === 'py' ? await env.python(job.pyBase || '', job.libs || ['numpy']) : null;
        post({ type: 'ready' });
      } else if (m.type === 'run') {
        if (!job) throw new Error('The worker has no job.');
        const bridge = job.lang === 'py' ? pyStrategy(host!, job.code) : jsStrategy(job.code);
        post({ type: 'result', idx: m.idx, res: await runCombo(job, bridge, m.overrides || {}, !!m.trades, m.ddStop || undefined) });
      }
    } catch (e) {
      post({ type: 'error', idx: m.type === 'run' ? m.idx : null, error: String((e as Error)?.message || e) });
    }
  };
}
