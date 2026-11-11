// Every example script in the in-app guide (src/next/guide/examples.ts) runs as the guide says: the indicators on
// a few days of candles through Python, the strategies through the backtest runner, without errors, and each does
// what it is there to show (draws, trades).
//   npx tsx tests/guide.test.ts        (Python: public/pyodide, from npm run pyodide)
import { runBacktest, type Bridge, type RunConfig } from '../src/core/backtest';
import { jsCheck, jsStrategy } from '../src/core/jsstrategy';
import { pyStrategy } from '../src/core/pybridge';
import { parseTF, setZone } from '../src/core/time';
import { INDICATORS, STRATEGIES, STRAT_JS, STRAT_TRAIL, IND_ORB, IND_LEVELS, IND_RSI, IND_BANDS } from '../src/next/guide/examples';
import { check, passed, python, walk } from './helpers';

setZone('America/Chicago');
const t0 = Date.UTC(2026, 0, 5, 0, 0) / 1000; // a Monday, midnight UTC
const S = walk(5 * 1440, 11, t0); // five days of 1-minute candles
const host = await python();
const g = host.py.globals;
const OFF = -6 * 3600; // the chart's zone: Central (January)

/* ---- indicators: started and fed like the chart feeds them (5-minute candles) ---- */
function candles5() {
  const out: number[] = [];
  for (let i = 0; i + 5 <= S.n; i += 5) {
    let h = -Infinity, l = Infinity, v = 0;
    for (let k = i; k < i + 5; k++) { h = Math.max(h, S.h[k]); l = Math.min(l, S.l[k]); v += S.v[k]; }
    out.push(S.t[i], S.o[i], h, l, S.c[i + 4], v, OFF);
  }
  return Float64Array.from(out);
}
const buf = candles5();
for (const ex of INDICATORS) {
  const info = JSON.stringify({ name: 'Test market', tf: '5m', tfs: 300, tick: 0.25, pv: 20, prec: 2 });
  const start = JSON.parse(g.get('_ti_start')(ex.id, ex.code, info));
  check(!start.error, `${ex.title}: starts (${start.error})`);
  // fed in a few slices, as the chart does while the tape plays
  const outs: any[] = [start];
  for (let k = 0; k < buf.length; k += 7 * 300) outs.push(JSON.parse(g.get('_ti_feed')(ex.id, buf.subarray(k, k + 7 * 300))));
  const err = outs.find(o => o.error);
  check(!err, `${ex.title}: runs on every candle (${err?.error})`);
  const plots = outs.reduce((n, o) => n + Object.values(o.plots || {}).reduce((m: number, p: any) => m + p.filter((x: any) => x[1] != null).length, 0), 0);
  const draws = outs.reduce((n, o) => n + (o.draw?.length || 0), 0), marks = outs.reduce((n, o) => n + (o.marks?.length || 0), 0);
  if (ex === IND_ORB || ex === IND_LEVELS) check(draws > 0, `${ex.title}: draws boxes, lines or labels (${draws})`);
  else check(plots > 100, `${ex.title}: plots values (${plots})`);
  if (ex === IND_RSI) check(marks > 0 && outs.some(o => o.hlines?.length === 2), `${ex.title}: levels and markers (${marks})`);
  if (ex === IND_BANDS) check(outs.some(o => o.fills?.length) && outs.some(o => o.bg?.length), `${ex.title}: a fill and tinted candles`);
  if (ex === IND_ORB) check(outs.some(o => o.draw?.some((d: any) => d.kind === 'label')), `${ex.title}: a breakout label`);
  g.get('_ti_stop')(ex.id);
}

/* ---- strategies: on the same five days, as the Backtest page runs them ---- */
for (const ex of STRATEGIES) {
  const js = ex === STRAT_JS || ex.id.startsWith('st-js');
  if (js) check(jsCheck(ex.code) === null, `${ex.title}: compiles`);
  const b: Bridge = js ? jsStrategy(ex.code) : pyStrategy(host, ex.code);
  const cfg = { series: S, tf: parseTF(ex.id === 'st-first' ? '5m' : '5m')!, mode: ex === STRAT_TRAIL ? 'tick' : 'bar', balance: 50000, qty: 1 } as RunConfig;
  const r = await runBacktest(cfg, b, { slice: null });
  const errs = r.log.filter(x => x[1] === 'er' && !/^\d+ trades, net/.test(x[0])).map(x => x[0]);
  check(!r.fail && !errs.length, `${ex.title}: runs without errors (${r.fail || errs.join(' ')})`);
  check(r.account.hist.length > 0, `${ex.title}: trades (${r.account.hist.length})`);
  if (ex.id === 'st-orb' || ex.id === 'st-js-orb') {
    // never more than one entry a day, never more than MAX_QTY, every trade with a stop
    const days = new Map<string, number>();
    for (const h of r.account.hist) { const d = new Date((h.time + OFF) * 1000).toISOString().slice(0, 10); days.set(d, (days.get(d) || 0) + 1); }
    check([...days.values()].every(n => n <= 1), `${ex.title}: one trade a day at most`);
    check(r.account.hist.every(h => h.qty >= 1 && h.qty <= 5), `${ex.title}: sizes within MAX_QTY`);
  }
}
console.log(`guide: ${passed} checks passed`);
