// Backtest speed: the classic app's way (one Python call per candle, tick and fill with the state each time, bars
// skipped only when flat, print one line at a time) against the new runner (batched Python) and JavaScript, on the
// same engine and data: practice NQ, 1-second bars.
//   npx tsx tests/backtest.bench.ts [days]
import { runBacktest, type Bridge, type RunConfig } from '../src/core/backtest';
import { jsStrategy } from '../src/core/jsstrategy';
import { practiceSeries } from '../src/core/practice';
import { pyClassicStrategy, pyStrategy } from '../src/core/pybridge';
import { parseTF, setZone } from '../src/core/time';
import { python } from './helpers';

setZone('America/New_York');
const days = +((globalThis as any).process?.argv?.[2] || 3);
const t0 = Date.UTC(2026, 3, 1, 4) / 1000, t1 = t0 + days * 86400;
const [nq] = await practiceSeries(['NQ'], t0, t1);
const host = await python();
console.log(`practice NQ, ${nq.n.toLocaleString('en-US')} 1-second bars (${days} days)\n`);

const S: Array<{ name: string; mode: 'bar' | 'tick'; tf: string; py: string; js: string }> = [
  { name: 'MA cross, 1m candles, stop and target', mode: 'bar', tf: '1m',
    py: `
FAST, SLOW = 9, 21
def on_bar(ctx, bar):
    c = ctx.closes(SLOW)
    if len(c) < SLOW or ctx.position or ctx.orders:
        return
    f, s = c[-FAST:].mean(), c.mean()
    if f > s: ctx.buy(sl=ctx.round(bar.close - 40 * ctx.tick_size), tp=ctx.round(bar.close + 80 * ctx.tick_size))
    elif f < s: ctx.sell(sl=ctx.round(bar.close + 40 * ctx.tick_size), tp=ctx.round(bar.close - 80 * ctx.tick_size))
`, js: `
const FAST = 9, SLOW = 21;
function on_bar(ctx, bar) {
  const c = ctx.closes(SLOW);
  if (c.length < SLOW || ctx.position || ctx.orders.length) return;
  let f = 0, s = 0; for (let k = 0; k < SLOW; k++) { s += c[k]; if (k >= SLOW - FAST) f += c[k]; }
  f /= FAST; s /= SLOW;
  if (f > s) ctx.buy({ sl: ctx.round(bar.close - 40 * ctx.tick_size), tp: ctx.round(bar.close + 80 * ctx.tick_size) });
  else if (f < s) ctx.sell({ sl: ctx.round(bar.close + 40 * ctx.tick_size), tp: ctx.round(bar.close - 80 * ctx.tick_size) });
}` },
  { name: 'flat, prints every 1m candle', mode: 'bar', tf: '1m',
    py: `
def on_bar(ctx, bar):
    print(bar.index, bar.close, len(ctx.orders))
`, js: `
function on_bar(ctx, bar) { print(bar.index, bar.close, ctx.orders.length); }` },
  { name: 'breakout stop orders, 5m candles, flat at night', mode: 'bar', tf: '5m',
    py: `
def on_bar(ctx, bar):
    h = ctx.highs(12)
    if len(h) < 12 or ctx.position:
        return
    ctx.cancel_all()
    if bar.time.hour in (10, 11, 13, 14):
        ctx.buy_stop(ctx.round(h.max() + ctx.tick_size), sl=ctx.round(ctx.lows(12).min()), tp=ctx.round(h.max() + 60 * ctx.tick_size))
`, js: `
function on_bar(ctx, bar) {
  const h = ctx.highs(12);
  if (h.length < 12 || ctx.position) return;
  ctx.cancel_all();
  if ([10, 11, 13, 14].includes(bar.time.hour)) { let mx = -Infinity, mn = Infinity; for (const x of h) mx = Math.max(mx, x); for (const x of ctx.lows(12)) mn = Math.min(mn, x);
    ctx.buy_stop(ctx.round(mx + ctx.tick_size), { sl: ctx.round(mn), tp: ctx.round(mx + 60 * ctx.tick_size) }); }
}` },
  { name: 'every tick, trailing stop', mode: 'tick', tf: '1m',
    py: `
def init(ctx):
    ctx.n = 0
def on_bar(ctx, bar):
    if not ctx.position and bar.index % 30 == 0:
        ctx.buy(sl=ctx.round(bar.close - 20))
def on_tick(ctx, tick):
    ctx.n += 1
    if ctx.position and ctx.n % 50 == 0:
        ctx.set_bracket(sl=ctx.round(tick.price - 20))
`, js: `
function init(ctx) { ctx.n = 0; }
function on_bar(ctx, bar) { if (!ctx.position && bar.index % 30 === 0) ctx.buy({ sl: ctx.round(bar.close - 20) }); }
function on_tick(ctx, tick) { ctx.n++; if (ctx.position && ctx.n % 50 === 0) ctx.set_bracket({ sl: ctx.round(tick.price - 20) }); }` },
];

const time = async (cfg: Partial<RunConfig>, b: Bridge) => {
  const t = performance.now();
  let printed = 0;
  const r = await runBacktest({ series: nq, tf: parseTF('1m')!, mode: 'bar', balance: 50000, ...cfg } as RunConfig, b, { slice: null, log: ls => { printed += ls.length; } });
  if (r.fail) throw new Error(r.fail);
  return { s: (performance.now() - t) / 1000, trades: r.account.hist.length, net: r.stats.net, printed };
};
for (const x of S) {
  const cfg = { mode: x.mode, tf: parseTF(x.tf)! };
  const c = await time({ ...cfg, classicPath: true }, pyClassicStrategy(host, x.py));
  const p = await time(cfg, pyStrategy(host, x.py));
  const j = await time(cfg, jsStrategy(x.js));
  const us = (r: { s: number }) => (r.s * 1e6 / nq.n).toFixed(2).padStart(6);
  console.log(`${x.name} (${p.trades} trades${p.printed > 10 ? `, ${p.printed.toLocaleString('en-US')} lines printed` : ''}${c.trades !== p.trades || Math.abs(c.net - p.net) > 1e-6 ? ', RESULTS DIFFER' : ''})`);
  console.log(`  classic-equivalent Python ${c.s.toFixed(2).padStart(6)} s  ${us(c)} us/bar`);
  console.log(`  new Python                ${p.s.toFixed(2).padStart(6)} s  ${us(p)} us/bar  ${(c.s / p.s).toFixed(1)}x`);
  console.log(`  JavaScript                ${j.s.toFixed(2).padStart(6)} s  ${us(j)} us/bar  ${(c.s / j.s).toFixed(1)}x${j.trades !== p.trades ? ` (${j.trades} trades)` : ''}\n`);
}
