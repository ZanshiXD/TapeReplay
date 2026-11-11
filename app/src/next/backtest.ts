// The Backtest page's workings apart from the screen: the strategy templates, saved strategies, Python (loaded only
// when a Python strategy runs), the market a run trades, and the prop simulation inside a run.
import RUNTIME from '../python/runtime.py?raw';
import RUNNER from '../python/runner.py?raw';
import { loadPython, type PyHost } from '../core/pybridge';
import type { PropConfig } from '../core/prop';
import type { Mode } from '../core/backtest';
import { PRACTICE } from '../core/practice';
import { parseTF, tfLabel, tfValid, zoneToUtc, zp, p2 } from '../core/time';
import { store } from './appstore';
import { pref, setPref } from './live';
import { loadMarket, type MarketSource } from './sessions';
import type { Instrument, Series } from '../core/series';

export type Lang = 'py' | 'js';
export interface Strat { code: string; lang: Lang }

/* ---- templates: four in Python and two in JavaScript ---- */
export const TEMPLATES: Record<string, Strat> = {
  'MA cross': { lang: 'py', code: `# Moving-average cross: long when the fast average is above the slow one, short when below.
# Orders use the order size on the Run panel unless you give one, like ctx.buy(2).
FAST, SLOW = 9, 21
STOP, TARGET = 40, 80   # in ticks

def on_bar(ctx, bar):
    closes = ctx.closes(SLOW)          # numpy array, oldest first
    if len(closes) < SLOW:
        return
    fast, slow = closes[-FAST:].mean(), closes.mean()

    if fast > slow and ctx.position <= 0:
        ctx.close()
        ctx.buy(sl=bar.close - ctx.ticks(STOP), tp=bar.close + ctx.ticks(TARGET))
    elif fast < slow and ctx.position >= 0:
        ctx.close()
        ctx.sell(sl=bar.close + ctx.ticks(STOP), tp=bar.close - ctx.ticks(TARGET))

def on_fill(ctx, fill):
    print(f"{fill.time:%m-%d %H:%M}  {fill.side} {fill.qty:g} @ {fill.price}  {fill.reason}")
` },
  'Opening range breakout': { lang: 'py', code: `# Opening range breakout: the high and low of the first 30 minutes after the open (chart time zone),
# then a stop order on each side. The first one to fill cancels the other. Flat before the close.
OPEN, RANGE_END, FLAT_BY = "09:30", "10:00", "15:55"

def init(ctx):
    ctx.in_session = False

def on_bar(ctx, bar):
    t = bar.time.time()
    # ctx.between handles windows that run across midnight (OPEN "18:00", FLAT_BY "14:30")
    if not ctx.between(t, OPEN, FLAT_BY):
        ctx.in_session = False
        if ctx.position or ctx.orders:
            ctx.cancel_all()
            ctx.close()
        return
    if not ctx.in_session:                       # the session opens: a new day
        ctx.in_session, ctx.hi, ctx.lo, ctx.armed = True, None, None, False
    if ctx.between(t, OPEN, RANGE_END):
        ctx.hi = bar.high if ctx.hi is None else max(ctx.hi, bar.high)
        ctx.lo = bar.low if ctx.lo is None else min(ctx.lo, bar.low)
    elif ctx.hi is not None and not ctx.armed:
        size = ctx.hi - ctx.lo
        up, down = ctx.round(ctx.hi + ctx.tick_size), ctx.round(ctx.lo - ctx.tick_size)
        if up > ctx.ask:                         # a buy stop must be above the ask
            ctx.buy_stop(up, sl=ctx.lo, tp=ctx.hi + size)
        if down < ctx.bid:                       # a sell stop below the bid
            ctx.sell_stop(down, sl=ctx.hi, tp=ctx.lo - size)
        ctx.armed = True

def on_fill(ctx, fill):
    if fill.kind == "entry":
        ctx.cancel_all()                         # one breakout a day
` },
  'Breakout with trailing stop': { lang: 'py', code: `# Choose "Every tick". A buy stop above the last 20 candles' high; once in, the stop trails
# 40 ticks behind the best price, checked on every tick.
LOOKBACK, TRAIL = 20, 40

def init(ctx):
    ctx.best = None

def on_bar(ctx, bar):
    if ctx.position != 0:
        return
    ctx.cancel_all()
    if len(ctx.closes()) < LOOKBACK:
        return
    level = ctx.round(ctx.highs(LOOKBACK).max() + ctx.tick_size)
    if level > ctx.ask:                          # a buy stop must be above the ask
        ctx.buy_stop(level, sl=ctx.lows(LOOKBACK).min())

def on_tick(ctx, tick):
    if ctx.position > 0:
        if ctx.best is None or tick.price > ctx.best:
            ctx.best = tick.price
            ctx.set_bracket(sl=ctx.best - ctx.ticks(TRAIL))
    else:
        ctx.best = None
` },
  'Blank': { lang: 'py', code: `def init(ctx):
    pass

def on_bar(ctx, bar):
    # bar.time, bar.open, bar.high, bar.low, bar.close, bar.volume
    # ctx.position, ctx.equity, ctx.closes(n) ... see the guide
    pass
` },
  'MA cross (JavaScript)': { lang: 'js', code: `// Moving-average cross: long when the fast average is above the slow one, short when below.
// Orders use the order size on the Run panel unless you give one, like ctx.buy({ qty: 2 }).
const FAST = 9, SLOW = 21;
const STOP = 40, TARGET = 80;   // in ticks

const mean = a => a.reduce((s, x) => s + x, 0) / a.length;

function on_bar(ctx, bar) {
  const closes = ctx.closes(SLOW);         // oldest first
  if (closes.length < SLOW) return;
  const fast = mean(closes.subarray(SLOW - FAST)), slow = mean(closes);

  if (fast > slow && ctx.position <= 0) {
    ctx.close();
    ctx.buy({ sl: bar.close - ctx.ticks(STOP), tp: bar.close + ctx.ticks(TARGET) });
  } else if (fast < slow && ctx.position >= 0) {
    ctx.close();
    ctx.sell({ sl: bar.close + ctx.ticks(STOP), tp: bar.close - ctx.ticks(TARGET) });
  }
}

function on_fill(ctx, fill) {
  print(\`\${fill.time.hm().slice(5)}  \${fill.side} \${fill.qty} @ \${fill.price}  \${fill.reason}\`);
}
` },
  'Blank (JavaScript)': { lang: 'js', code: `function init(ctx) {
}

function on_bar(ctx, bar) {
  // bar.time, bar.open, bar.high, bar.low, bar.close, bar.volume
  // ctx.position, ctx.equity, ctx.closes(n) ... see the guide
}
` },
};
/** which template a template-named strategy switches the mode to */
export const TICK_TEMPLATES = new Set(['Breakout with trailing stop']);

/* ---- saved strategies: pref('strategies'), name -> {code, lang} (or plain Python text, from older versions) ---- */
export function loadStrats(): Record<string, Strat> {
  const raw = pref<Record<string, Strat | string>>('strategies', {}), out: Record<string, Strat> = {};
  for (const [k, v] of Object.entries(raw)) out[k] = typeof v === 'string' ? { code: v, lang: 'py' } : { code: v.code, lang: v.lang === 'js' ? 'js' : 'py' };
  if (!Object.keys(out).length) out['MA cross'] = { ...TEMPLATES['MA cross'] };
  return out;
}
export const saveStrats = (s: Record<string, Strat>) => setPref('strategies', s);
/** a name not taken yet: "MA cross", "MA cross 2"... */
export const freeName = (base: string, taken: Record<string, unknown>) => { let n = base, k = 2; while (n in taken) n = `${base} ${k++}`; return n; };

/* ---- Python, loaded the first time a Python strategy needs it ---- */
const PYODIDE_VER = '0.27.7'; // keep in step with desktop/build.py
const PY_CDN = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VER}/full/`;
let base: Promise<string> | null = null, host: Promise<PyHost> | null = null;
/** where Python is: bundled next to the page; a page opened on its own in a browser falls back to the CDN */
export function pyBase(): Promise<string> {
  return base ||= (async () => {
    const here = new URL('pyodide/', location.href).href;
    try { const r = await fetch(here + 'pyodide.mjs', { method: 'HEAD' }); if (r.ok && !/html/.test(r.headers.get('content-type') || '')) return here; } catch { /* not there */ }
    if (store.kind === 'app') { base = null; throw new Error('Python is missing from this copy of the app. Build it again with desktop/build.py (Windows) or ios/sync_web.py (iOS).'); }
    return PY_CDN;
  })();
}
export const pyReady = () => !!host;
/** the page's Python (numpy, the strategy runtime), with libs loaded too */
export async function python(libs: string[] = []): Promise<PyHost> {
  if (!host) host = (async () => loadPython({ indexURL: await pyBase(), runtime: RUNTIME, runner: RUNNER }))();
  let h: PyHost;
  try { h = await host; } catch (e) { host = null; throw e; }
  await h.need(libs);
  return h;
}

/* ---- dates and timeframes ---- */
export const STRAT_TFS = ['1m', '2m', '3m', '5m', '10m', '15m', '30m', '1h', '2h', '4h', '1D', '1W'];
/** the timeframes a strategy can use on data of this bar size: the usual list, plus the bars' own */
export function stratTfs(base: number): string[] {
  const own = tfLabel({ kind: 's', sec: base }), out = STRAT_TFS.filter(t => tfValid(parseTF(t)!, base));
  return out.includes(own) ? out : [own, ...out];
}
/** YYYY-MM-DD in the chart zone */
export const ymd = (t: number) => { const p = zp(t); return `${p.y}-${p2(p.mo + 1)}-${p2(p.d)}`; };
/** midnight (chart zone) of a YYYY-MM-DD, plus days */
export const ymdUtc = (s: string, addDays = 0) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ''); return m ? zoneToUtc(+m[1], +m[2] - 1, +m[3] + addDays) : NaN; };

/* ---- the market a run trades ---- */
/** what the Run panel says to trade */
export type DataChoice = { kind: 'practice'; sym: string } | { kind: 'dataset'; id: string; name: string; pick: string; inst: Instrument; long: boolean };
export interface RunCosts { comm: number; spreadTicks: number; slipTicks: number }
const HIST_DAYS = 3;
/** the bars to load for a run from t0 to t1: a few days of history before (the chart shows them), a day after */
export function marketFor(d: DataChoice, t0: number, t1: number, costs: RunCosts): MarketSource {
  if (d.kind === 'practice') return { kind: 'practice', sym: d.sym, t0: t0 - HIST_DAYS * 86400, t1: t1 + 86400, costs };
  return { kind: 'dataset', id: d.id, name: d.name, pick: d.pick, inst: { ...d.inst, ...costs }, window: d.long ? { from: t0 - HIST_DAYS * 86400, to: t1 + 86400 } : null, cont: null };
}
/** everything a run needs (the Run panel's settings with the code), also kept with an optimization */
export interface RunSetup {
  name: string; lang: Lang; code: string; mode: Mode; libs: string[]; tf: string; data: DataChoice; market: MarketSource;
  /** the dates traded: from inclusive, to exclusive (UTC seconds) */
  t0: number; t1: number;
  balance: number; qty: number; costs: RunCosts; dataName: string;
  prop: { cfg: PropConfig; rebuy: boolean; maxEvals: number } | null;
}
export const instOf = (d: DataChoice) => d.kind === 'practice' ? PRACTICE[d.sym] : d.inst;
// the last market loaded, kept for the next run on the same bars
let cache: { key: string; s: Promise<Series> } | null = null;
export function seriesFor(m: MarketSource, progress?: (f: number, step?: string) => void): Promise<Series> {
  const key = JSON.stringify({ ...m, costs: 0, inst: m.kind === 'dataset' ? m.inst.sym : 0 });
  if (!cache || cache.key !== key) { cache = { key, s: loadMarket(store, m, progress) }; cache.s.catch(() => { cache = null; }); }
  const costs = m.kind === 'practice' ? m.costs : { comm: m.inst.comm, spreadTicks: m.inst.spreadTicks, slipTicks: m.inst.slipTicks };
  return cache.s.then(s => ({ ...s, inst: { ...s.inst, ...costs } }));
}

/* ---- the prop simulation in a run: in core (the optimizer's workers use it too) ---- */
export { simRules, type SimRun } from '../core/prop';
