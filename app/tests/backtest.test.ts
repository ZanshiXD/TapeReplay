// Backtests on the new core (src/core/backtest.ts) with Python (Pyodide) and JavaScript strategies.
//   npx tsx tests/backtest.test.ts        (Python: public/pyodide, from npm run pyodide)
import { computeStats, runBacktest, statsRows, tradesCsv, type Bridge, type RunConfig, type RunResult } from '../src/core/backtest';
import { jsApply, jsCheck, jsParams, jsStrategy } from '../src/core/jsstrategy';
import { pyClassicStrategy, pyParams, pySetValues, pyStrategy, type PyHost } from '../src/core/pybridge';
import { Feed } from '../src/core/feed';
import { parseTF, setZone } from '../src/core/time';
import { INST, check, near, passed, python, series, walk } from './helpers';

setZone('America/New_York');
const tf = (s: string) => parseTF(s)!;
const run = (cfg: Partial<RunConfig> & { series: RunConfig['series'] }, b: Bridge, hooks = {}) => runBacktest({ tf: tf('1m'), mode: 'bar', balance: 50000, ...cfg } as RunConfig, b, { slice: null, ...hooks });
const sig = (r: RunResult) => r.account.hist.map(h => `${h.id} ${h.side} ${h.qty} ${h.entry} ${h.time.toFixed(3)} ${h.exit} ${h.exitTime.toFixed(3)} ${h.reason} ${h.net.toFixed(2)}`).join('\n');
const lines = (r: RunResult) => r.log.map(x => x[0]).filter(l => !/^Finished in/.test(l));
const t0 = performance.now();
const host: PyHost = await python();
console.log(`Python ready in ${((performance.now() - t0) / 1000).toFixed(1)} s`);

/* ---- a hand-worked run: market entry and close, a limit entry and its take profit ---- */
{
  const T = Date.UTC(2026, 0, 5, 14, 30) / 1000;
  const s = series([
    [T, 100, 100.5, 99.5, 100, 10], [T + 60, 100, 101, 99.75, 100.75, 10], [T + 120, 101, 102, 100.5, 101.5, 10], [T + 180, 101.5, 103, 101.25, 102.75, 10],
    [T + 240, 102.5, 102.75, 102, 102.25, 10], [T + 300, 102.25, 103.5, 102, 103.25, 10], [T + 360, 103, 103.25, 100.5, 100.75, 10], [T + 420, 100.75, 101, 100.5, 100.75, 10]]);
  const py = `
def init(ctx):
    ctx.seen = []
def on_bar(ctx, bar):
    if bar.index == 0: ctx.buy(sl=98)
    if bar.index == 2: ctx.close()
    if bar.index == 3: ctx.sell_limit(103, tp=101)
def on_fill(ctx, fill):
    print(fill, len(ctx.closes()))
`;
  const js = `
function on_bar(ctx, bar) {
  if (bar.index === 0) ctx.buy({ sl: 98 });
  if (bar.index === 2) ctx.close();
  if (bar.index === 3) ctx.sell_limit(103, { tp: 101 });
}
function on_fill(ctx, fill) { print(String(fill), ctx.closes().length); }
`;
  for (const [name, b] of [['python', pyStrategy(host, py)], ['classic python', pyClassicStrategy(host, py)], ['js', jsStrategy(js)]] as const) {
    const r = await run({ series: s, startIdx: 1, ticksPerBar: 4 }, b);
    const h = r.account.hist, st = r.stats;
    check(!r.fail, `${name}: runs (${r.fail})`);
    check(h.length === 2 && h[0].entry === 101.5 && h[0].reason === 'Strategy close' && h[0].exit === 102.25, `${name}: market buy at the next open + spread + slippage, closed at the open - slippage (${sig(r)})`);
    check(near(h[0].net, 11) && h[0].time === T + 120 && h[0].exitTime === T + 240, `${name}: (102.25 - 101.5) x 20 - 2 x $2 = $11`);
    check(h[1].how === 'Limit fill' && h[1].entry === 103 && h[1].exit === 101 && h[1].reason === 'Take profit' && near(h[1].net, 36), `${name}: sell limit filled at its price, out at the target: (103 - 101) x 20 - $4 = $36`);
    check(near(st.net, 47) && st.trades === 2 && st.winRate === 100 && st.pf === 'inf' && near(st.costs, 8) && st.longs === 1 && st.shorts === 1, `${name}: stats`);
    check(near(st.maxDD, 24) && near(st.maxDDpct, 24 / 50023 * 100), `${name}: max drawdown $24 from the $50,023 peak (${st.maxDD}, ${st.maxDDpct})`);
    const fl = r.log.filter(x => x[0].startsWith('Fill(')).map(x => x[0]);
    check(fl.length === 4 && /^Fill\(2026-01-05 09:32 buy 1 @ 101\.5 entry Market\)? 1$/.test(fl[0].replace(/\) 1$/, ') 1')), `${name}: on_fill before on_bar of the candle it filled in (${fl[0]})`);
    check(fl[1].includes('exit Strategy close pnl=+11.00') && fl[3].includes('exit Take profit pnl=+36.00'), `${name}: exits with their reasons and net P&L (${fl[3]})`);
  }
}

/* ---- the classic checks: a market order fills at the next open + spread; on_fill sees 3 candles; rejections ---- */
{
  const s = walk(400);
  const py = `
def on_bar(ctx, bar):
    if bar.index == 2:
        ctx.buy()
    if bar.index == 5:
        ctx.sell_limit(ctx.bid - 5)
    if bar.index in (6, 7, 8):
        ctx.sell_limit(ctx.bid - 1)
def on_fill(ctx, fill):
    print("fill", fill.price, len(ctx.closes()))
`;
  for (const b of [pyStrategy(host, py), pyClassicStrategy(host, py)]) {
    const r = await run({ series: s, startIdx: 10, endIdx: 30 }, b);
    const fill = r.account.trades[0];
    check(fill.entry === s.o[13] + 0.25 + 0.25, `market buy from on_bar fills at the next bar's open + spread + slippage (${fill.entry} vs ${s.o[13]})`);
    check(r.log.some(x => x[0] === `fill ${fill.entry} 3`), 'on_fill sees 3 candles');
    const rej = r.log.filter(x => x[0].includes('Order rejected: A sell limit must be above the bid'));
    check(rej.length === 1 && /^\d{4}-\d\d-\d\d \d\d:\d\d Order rejected: A sell limit must be above the bid \(\d+\.\d\d\)\. Use a stop order to sell below it\.$/.test(rej[0][0]), `wrong-side limit rejected exactly once, in the classic words (${rej[0]?.[0]})`);
  }
}

/* ---- parity: batched Python == classic Python == JavaScript, with orders of every kind ---- */
const PY_SINK = `
FAST, SLOW = 5, 20
STOP, TARGET = 12, 24
def init(ctx):
    ctx.n_fills = 0
def on_bar(ctx, bar):
    c = ctx.closes(SLOW)
    if len(c) < SLOW:
        return
    f, s = c[-FAST:].mean(), c.mean()
    if bar.index % 50 == 0:
        print(bar.index, ctx.position, f"{ctx.equity:.2f}", f"{ctx.balance:.2f}", len(ctx.orders), len(ctx.trades), len(ctx.history), [f"{t['pnl']:.2f}" for t in ctx.trades])
    if ctx.position == 0 and not ctx.orders:
        if f > s:
            ctx.buy(sl=ctx.round(bar.close - ctx.ticks(STOP)), tp=ctx.round(bar.close + ctx.ticks(TARGET)))
        elif f < s:
            ctx.sell_limit(ctx.round(bar.close + ctx.ticks(2)), sl=ctx.round(bar.close + ctx.ticks(STOP)), tp=ctx.round(bar.close - ctx.ticks(TARGET)))
        if bar.index % 7 == 0:
            ctx.sell_limit(bar.close - 5)
    elif ctx.orders and bar.index % 3 == 0:
        ctx.cancel_all()
    elif ctx.position > 0 and f < s:
        ctx.close()
    elif ctx.position < 0 and bar.index % 5 == 0:
        ctx.set_bracket(sl=ctx.round(bar.high + ctx.ticks(4)))
    if ctx.position > 0 and bar.index % 11 == 0:
        ctx.buy_stop(ctx.round(bar.high + ctx.ticks(2)), qty=2)
def on_fill(ctx, fill):
    ctx.n_fills += 1
    if ctx.n_fills <= 5:
        print(fill)
def on_end(ctx):
    print("fills", ctx.n_fills, "history", len(ctx.history))
`;
const JS_SINK = `
const FAST = 5, SLOW = 20;
const STOP = 12;  // ticks
const TARGET = 24;
function init(ctx) { ctx.n_fills = 0; }
function on_bar(ctx, bar) {
  const c = ctx.closes(SLOW);
  if (c.length < SLOW) return;
  let f = 0, s = 0;
  for (let k = 0; k < SLOW; k++) { s += c[k]; if (k >= SLOW - FAST) f += c[k]; }
  f /= FAST; s /= SLOW;
  if (ctx.position === 0 && !ctx.orders.length) {
    if (f > s) ctx.buy({ sl: ctx.round(bar.close - ctx.ticks(STOP)), tp: ctx.round(bar.close + ctx.ticks(TARGET)) });
    else if (f < s) ctx.sell_limit(ctx.round(bar.close + ctx.ticks(2)), { sl: ctx.round(bar.close + ctx.ticks(STOP)), tp: ctx.round(bar.close - ctx.ticks(TARGET)) });
    if (bar.index % 7 === 0) ctx.sell_limit(bar.close - 5);
  } else if (ctx.orders.length && bar.index % 3 === 0) ctx.cancel_all();
  else if (ctx.position > 0 && f < s) ctx.close();
  else if (ctx.position < 0 && bar.index % 5 === 0) ctx.set_bracket({ sl: ctx.round(bar.high + ctx.ticks(4)) });
  if (ctx.position > 0 && bar.index % 11 === 0) ctx.buy_stop(ctx.round(bar.high + ctx.ticks(2)), { qty: 2 });
}
function on_fill(ctx, fill) { ctx.n_fills++; }
`;
{
  const s = walk(6000, 11);
  for (const mode of ['bar', 'tick'] as const) for (const t of ['1m', '5m']) {
    const cfg = { series: s, tf: tf(t), mode, startIdx: 50 };
    const a = await run(cfg, pyStrategy(host, PY_SINK)), b = await run(cfg, pyClassicStrategy(host, PY_SINK)), c = await run(cfg, jsStrategy(JS_SINK));
    check(!a.fail && !b.fail && !c.fail, `${mode} ${t}: all run (${a.fail || b.fail || c.fail})`);
    check(a.account.hist.length > 30 && sig(a) === sig(b), `${mode} ${t}: batched Python makes the same trades as the classic calls (${a.account.hist.length} trades)`);
    check(sig(a) === sig(c), `${mode} ${t}: and so does the JavaScript strategy`);
    check(lines(a).join('\n') === lines(b).join('\n'), `${mode} ${t}: and prints the same, in the same order`);
    check(a.account.hist.some(h => h.how === 'Stop fill') && a.account.hist.some(h => h.reason === 'Stop loss') && a.account.hist.some(h => h.reason === 'Strategy close'), `${mode} ${t}: stops, stop losses and closes all happened`);
    check(a.account.maxDD === b.account.maxDD && a.eq.length === b.eq.length && a.eq.every((p, k) => p.value === b.eq[k].value), `${mode} ${t}: same drawdown and equity curve`);
  }
}

/* ---- bars where nothing can fill are skipped whole: the same as the classic path, best and worst prices too ---- */
{
  const s = walk(8000, 23);
  const always = `
const FAST = 5, SLOW = 20;
function on_bar(ctx, bar) {
  const c = ctx.closes(SLOW); if (c.length < SLOW) return;
  let f = 0, s = 0; for (let k = 0; k < SLOW; k++) { s += c[k]; if (k >= SLOW - FAST) f += c[k]; }
  if (f / FAST > s / SLOW && ctx.position <= 0) { if (ctx.position) ctx.close(); ctx.buy({ sl: bar.close - 15, tp: bar.close + 30 }); }
  else if (f / FAST < s / SLOW && ctx.position >= 0) { if (ctx.position) ctx.close(); ctx.sell_stop(bar.low - 1, { sl: bar.close + 15 }); }
}`;
  for (const code of [always, JS_SINK]) {
    const a = await run({ series: s, tf: tf('5m') }, jsStrategy(code)), b = await run({ series: s, tf: tf('5m'), classicPath: true }, jsStrategy(code));
    const mx = (r: RunResult) => r.account.hist.map(h => `${h.best} ${h.worst}`).join();
    check(a.account.hist.length > 20 && sig(a) === sig(b) && mx(a) === mx(b) && a.account.maxDD === b.account.maxDD && JSON.stringify(a.eq) === JSON.stringify(b.eq), `quiet bars skipped == played tick by tick (${a.account.hist.length} trades)`);
  }
}

/* ---- every tick: on_tick on each tick, before on_bar on a candle's last; the fast path changes nothing ---- */
{
  const s = walk(300, 5);
  const py = `
def init(ctx):
    ctx.ticks_seen = 0
    ctx.log = []
def on_tick(ctx, tick):
    ctx.ticks_seen += 1
    if ctx.position == 0 and ctx.ticks_seen % 97 == 0:
        ctx.buy(sl=ctx.round(tick.price - 3), tp=ctx.round(tick.price + 3))
    if ctx.ticks_seen % 50 == 0:
        print("t", tick, f"{ctx.equity:.2f}", ctx.position)
def on_bar(ctx, bar):
    print("b", bar.index, ctx.ticks_seen, str(ctx.time))
def on_fill(ctx, fill):
    print("f", fill, ctx.ticks_seen)
`;
  const cfg = { series: s, mode: 'tick' as const, startIdx: 1, tf: tf('5m'), ticksPerBar: 10 };
  const a = await run(cfg, pyStrategy(host, py)), b = await run(cfg, pyClassicStrategy(host, py));
  check(!a.fail && sig(a) === sig(b) && a.account.hist.length > 3, `every tick: batched == classic (${a.account.hist.length} trades)`);
  check(lines(a).join('\n') === lines(b).join('\n'), 'every tick: the same hooks in the same order');
  // on_tick ran on every tick: as many as the feed plays
  const lastBar = lines(a).filter(l => l.startsWith('b ')).pop()!, fd = new Feed(s, 1, tf('5m'), 10, [], false);
  let nt = 0; while (fd.step()) nt++;
  check(+lastBar.split(' ')[2] === nt && nt > 299 * 9, `on_tick ran on every tick (${lastBar}, ${nt} ticks)`);
  // a strategy that never trades: skipping flat bars gives the same as playing every tick
  const quietPy = `
def on_bar(ctx, bar):
    if bar.index % 40 == 0: ctx.buy(sl=ctx.round(bar.close - 2), tp=ctx.round(bar.close + 2))
def on_tick(ctx, tick):
    pass
`;
  const x = await run({ series: s, startIdx: 1, mode: 'bar' }, pyStrategy(host, quietPy)), y = await run({ series: s, startIdx: 1, mode: 'tick' }, pyClassicStrategy(host, quietPy));
  check(sig(x) === sig(y) && x.account.maxDD === y.account.maxDD && x.account.hist.length > 3, 'skipping flat bars == playing their ticks (trades, drawdown)');
}

/* ---- settings, overrides and errors ---- */
{
  const s = walk(200);
  const code = `
FAST, SLOW = 5, 30
SPAN = SLOW - FAST
VOL = 2.5  # 0 = off
MODE = "range"  # "range" or "candle"
def on_bar(ctx, bar):
    if bar.index == 0: print("cfg", FAST, SLOW, SPAN, VOL, MODE)
`;
  const r = await run({ series: s, overrides: { FAST: 7, VOL: 3.0, MODE: 'candle' } }, pyStrategy(host, code));
  check(r.log.some(x => x[0] === 'cfg 7 30 23 3 candle'), 'overrides rewrite the settings, and constants follow them (3.0 arrives as JSON 3, as in the classic app)');
  check(r.log[0][0].endsWith('with FAST=7, VOL=3, MODE=candle.'), `the start line names the overrides (${r.log[0][0]})`);
  const bad = await run({ series: s, overrides: { NOPE: 1 } }, pyStrategy(host, code));
  check(bad.fail === 'NameError: The setting NOPE is not in the code any more.', `unknown setting (${bad.fail})`);
  const ps = pyParams(host, code).params;
  check(ps.map((p: any) => p.name).join() === 'FAST,SLOW,VOL,MODE' && ps[2].zero_off && ps[3].choices.join() === 'range,candle', 'settings found by _tr_params');
  check(pySetValues(host, code, { FAST: 9 }).code.includes('FAST, SLOW = 9, 30'), 'Use in code');

  const zero = await run({ series: s }, pyStrategy(host, 'def on_bar(ctx, bar):\n    x = 1\n    return 1 / 0\n'));
  check(zero.fail === 'ZeroDivisionError: division by zero\n  line 3, in on_bar\n    return 1 / 0', `traceback with the strategy's line (${zero.fail})`);
  check(zero.log.some(x => x[1] === 'er' && x[0].startsWith('ZeroDivisionError')), 'the error is in the console in red');
  const syn = await run({ series: s }, pyStrategy(host, 'def on_bar(ctx, bar)\n    pass\n'));
  check(/^SyntaxError: .*\n  line 1\n    def on_bar\(ctx, bar\)$/.test(syn.fail || ''), `syntax error (${syn.fail})`);
  const none = await run({ series: s }, pyStrategy(host, 'x = 1\n'));
  check(none.fail === 'The strategy needs an on_bar(ctx, bar) function.', 'no on_bar');
  const tickOnly = await run({ series: s }, pyStrategy(host, 'def on_tick(ctx, tick):\n    pass\n'));
  check(tickOnly.fail === "on_tick only runs with 'Every tick'. Add on_bar(ctx, bar), or choose Every tick.", 'on_tick only in bar mode');
  const both = await run({ series: s }, pyStrategy(host, 'def on_bar(ctx, bar):\n    ctx.buy(1, limit=1, stop=2)\n'));
  check(both.fail === 'ValueError: Give either limit= or stop=, not both.\n  line 2, in on_bar\n    ctx.buy(1, limit=1, stop=2)', 'limit and stop together');
  const initErr = await run({ series: s }, pyStrategy(host, 'def init(ctx):\n    ctx.x = undefined_name\ndef on_bar(ctx, bar):\n    pass\n'));
  check(initErr.fail === "NameError: name 'undefined_name' is not defined\n  line 2, in init\n    ctx.x = undefined_name", `init error (${initErr.fail})`);
  // JavaScript: the same messages
  const jz = await run({ series: s }, jsStrategy('function on_bar(ctx, bar) {\n  helper(ctx);\n}\nfunction helper(ctx) {\n  return ctx.nope.x;\n}\n'));
  check(jz.fail === "TypeError: Cannot read properties of undefined (reading 'x')\n  line 2, in on_bar\n    helper(ctx);\n  line 5, in helper\n    return ctx.nope.x;", `JS traceback, outermost first (${jz.fail})`);
  const jv = await run({ series: s }, jsStrategy('function on_bar(ctx, bar) {\n  ctx.buy({ qty: 0 });\n}'));
  check(jv.fail === 'ValueError: qty must be more than 0.\n  line 2, in on_bar\n    ctx.buy({ qty: 0 });', `JS ValueError (${jv.fail})`);
  check(/^SyntaxError: /.test(jsCheck('function on_bar(ctx, bar) {') || ''), 'JS syntax error');
  const jn = await run({ series: s }, jsStrategy('const X = 1;'));
  check(jn.fail === 'The strategy needs an on_bar(ctx, bar) function.', 'JS: no on_bar');
  const jsCode = 'const FAST = 9;  // fast average\nconst RR = 2.0;\nconst DIR = "both";  // "both", "long" or "short"\nconst OPEN = "08:30";\nconst LONG_ONLY = false;\nconst LEN = param(20, 10, 40, 5);\nfunction on_bar(ctx, bar) { if (bar.index === 0) print(FAST, RR, DIR, LEN); }\n';
  const jp = jsParams(jsCode);
  check('params' in jp && jp.params.map(p => `${p.name}:${p.kind}`).join() === 'FAST:int,RR:float,DIR:choice,LONG_ONLY:bool,LEN:int', `JS settings (${JSON.stringify(jp)})`);
  check('params' in jp && jp.params[2].choices!.join() === 'both,long,short' && jp.params[4].lo === 10 && jp.params[4].step === 5 && jp.params[4].param, 'JS choices and param() ranges');
  const ja = jsApply(jsCode, { FAST: 12, RR: 3, DIR: 'long', LEN: 25 });
  check('code' in ja && ja.code.startsWith('const FAST = 12;  // fast average\nconst RR = 3.0;\nconst DIR = "long";') && ja.code.includes('param(25, 10, 40, 5)'), 'JS settings written in, comments kept');
  const jr = await run({ series: s, overrides: { FAST: 12, LEN: 25 } }, jsStrategy(jsCode));
  check(jr.log.some(x => x[0] === '12 2 both 25'), 'JS overrides');
}

/* ---- rejections: each kind once, then counted; ctx.history; progress and stop ---- */
{
  const s = walk(3000, 3);
  const code = `
def on_bar(ctx, bar):
    ctx.buy_limit(ctx.ask + 1 + bar.index * 0.25)
    if bar.index == 3:
        ctx.buy(sl=ctx.bid + 1)
    h = ctx.history
    if bar.index % 500 == 0: print("history", len(h))
`;
  const r = await run({ series: s }, pyStrategy(host, code));
  const L = lines(r);
  check(L.filter(l => l.includes('Order rejected: A buy limit must be below the ask')).length === 1, 'a rejection kind is printed once');
  check(L.some(l => l === 'Order rejected 10 times so far: A buy limit must be below the ask (' + l.split('(')[1]) && L.some(l => l.startsWith('Order rejected 1000 times so far')), 'then counted at 10, 100, 1000');
  check(L.some(l => /^\d{4}-\d\d-\d\d \d\d:\d\d Order rejected: The stop loss must be below the order price\.$/.test(l)), 'a market order checked when it executes, in the classic words');
  const T = Date.UTC(2026, 0, 5, 14, 30) / 1000, s2 = walk(20000, 9, T);
  let slices = 0, stopAt = 0;
  const stopped = await runBacktest({ series: s2, tf: tf('1m'), mode: 'tick', balance: 50000 }, pyStrategy(host, 'def on_bar(ctx, bar):\n    pass\ndef on_tick(ctx, tick):\n    pass\n'),
    { sliceMs: 5, slice: p => { slices++; check(p.done > 0 && p.done < 1 && /^\d{4}-\d\d-\d\d · 0 trades$/.test(p.status), 'progress'); }, stopped: () => (stopAt ||= slices >= 3 ? 1 : 0) > 0 });
  check(stopped.stopped && slices >= 3 && stopped.done < 1 && stopped.log.some(x => x[0].startsWith('Stopped at ')), `stops between slices (${slices} slices, ${(stopped.done * 100).toFixed(1)}%)`);
}

/* ---- results: stats grid, CSV, equity curve ---- */
{
  const s = walk(20000, 21);
  const r = await run({ series: s, eqPoints: 200 }, jsStrategy(JS_SINK));
  const st = computeStats(r.account), h = r.account.hist;
  const wins = h.filter(x => x.net > 0), losses = h.filter(x => x.net <= 0);
  check(near(st.net, h.reduce((a, x) => a + x.net, 0), 1e-6) && st.wins === wins.length && near(st.avgLoss!, losses.reduce((a, x) => a + x.net, 0) / losses.length), 'net, wins, average loss');
  let streak = 0, mx = 0; for (const x of h) { streak = x.net <= 0 ? streak + 1 : 0; mx = Math.max(mx, streak); }
  check(st.maxLosingStreak === mx && st.largestLoss === Math.min(...losses.map(x => x.net)) && st.longs + st.shorts === h.length, 'streak, largest loss, long / short');
  check(near(st.avgHold!, h.reduce((a, x) => a + x.exitTime - x.time, 0) / h.length) && near(st.costs, h.reduce((a, x) => a + x.comm, 0)), 'average hold, costs');
  check(statsRows(st).map(x => x[0]).join() === 'Net P&L,Trades,Win rate,Profit factor,Avg win,Avg loss,Expectancy / trade,Largest win,Largest loss,Max losing streak,Long / short,Avg hold,Costs paid,Max drawdown', 'the classic stats grid');
  check(r.eq.length >= 200 && r.eq.length <= 205 && r.eq[0].value === 50000 && r.eq.every((p, k) => !k || p.time > r.eq[k - 1].time), `equity curve, about 200 points (${r.eq.length})`);
  const csv = tradesCsv(h).split('\n');
  check(csv[0] === 'id,side,size,entry_time,entry,exit_time,exit,exit_by,stop_loss,take_profit,gross,costs,net' && csv.length === h.length + 1 && /^\d+,(long|short),\d+,2026-\d\d-\d\d \d\d:\d\d:\d\d,/.test(csv[1]), 'trades as CSV, the classic columns');
  check(r.log[r.log.length - 1][0] === `${st.trades} trades, net ${st.net >= 0 ? '+' : '−'}$${Math.abs(st.net).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${st.open ? `, ${st.open} still open` : ''}.`, 'the summary line');
}

console.log(`backtest: ${passed} checks passed in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
void INST;
