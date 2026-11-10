// The guide's example scripts. Every one is run by app/tests/guide.test.ts (indicators on practice candles, strategies
// through the backtest runner), so what the guide shows works as written.

/** US Central Time from any aware datetime, without a time zone database (none in the app) */
export const PY_TO_CT = `def to_ct(dt):
    """Any aware datetime -> US Central Time (CST/CDT), whatever the chart's time zone."""
    u = dt.astimezone(timezone.utc)
    mar = datetime(u.year, 3, 8, 8, tzinfo=timezone.utc)      # 2nd Sunday of March, 2:00 CST
    start = mar + timedelta(days=(6 - mar.weekday()) % 7)
    nov = datetime(u.year, 11, 1, 7, tzinfo=timezone.utc)     # 1st Sunday of November, 2:00 CDT
    end = nov + timedelta(days=(6 - nov.weekday()) % 7)
    return u.astimezone(timezone(timedelta(hours=-5 if start <= u < end else -6)))`;

export const PY_SIZE_FOR = `def size_for(ctx, entry, stop):
    """Contracts that lose RISK_USD at the stop, rounded down and capped at MAX_QTY; None if under one step."""
    per_unit = abs(entry - stop) * ctx.point_value
    if per_unit <= 0:
        return None
    q = math.floor(RISK_USD / per_unit / QTY_STEP + 1e-9) * QTY_STEP
    if MAX_QTY:
        q = min(q, math.floor(MAX_QTY / QTY_STEP + 1e-9) * QTY_STEP)
    return round(q, 8) if q >= QTY_STEP else None`;

export const JS_TO_CT = `// US Central Time from a bar's time (any chart time zone): the same instant, at CST or CDT
function toCT(t) {
  const u = t.timestamp(), y = new Date(u * 1000).getUTCFullYear();
  const sunday = (month, day, hour) => { const x = Date.UTC(y, month, day, hour) / 1000; return x + ((7 - new Date(x * 1000).getUTCDay()) % 7) * 86400; };
  const start = sunday(2, 8, 8), end = sunday(10, 1, 7);   // 2nd Sunday of March, 1st Sunday of November
  return t.tz(start <= u && u < end ? -5 * 3600 : -6 * 3600);
}`;

export interface Example { id: string; title: string; what: string; code: string }

/* ---- indicators ---- */
export const IND_FIRST: Example = { id: 'ind-first', title: 'Your first indicator', what: 'A 20-candle average of the close, drawn on the price.', code: `# A 20-candle average of the close, drawn on the price.
LENGTH = 20   # candles

def init(ctx):
    ctx.avg = ta.SMA(LENGTH)

def on_bar(ctx, bar):
    ctx.plot(ctx.avg.update(bar.close), "Average", "accent")
` };

export const IND_RSI: Example = { id: 'ind-rsi', title: 'RSI with signals', what: 'RSI in a pane under the chart, its two levels, and an arrow on the candle where it turns back from one.', code: `# RSI in a pane under the chart, with its levels, and an arrow where it turns back from one.
LENGTH = 14       # candles
OB, OS = 70, 30   # overbought and oversold

def init(ctx):
    ctx.rsi = ta.RSI(LENGTH)
    ctx.prev = None
    ctx.hline(OB, "Overbought", color="down", pane="lower")
    ctx.hline(OS, "Oversold", color="up", pane="lower")

def on_bar(ctx, bar):
    r = ctx.rsi.update(bar.close)
    ctx.plot(r, "RSI", "#c158dc", pane="lower")
    if r is not None and ctx.prev is not None:
        if ctx.prev > OB >= r:                  # back down through 70
            ctx.marker("", shape="arrow_down", position="above", color="down")
        elif ctx.prev < OS <= r:                # back up through 30
            ctx.marker("", shape="arrow_up", position="below", color="up")
    ctx.prev = r
` };

export const IND_BANDS: Example = { id: 'ind-bands', title: 'Bands with a fill', what: 'An average with bands two deviations away, shaded between, and the candles tinted when price closes outside.', code: `# An average with bands two standard deviations away, shaded between them; candles that close
# outside a band get a tint behind them.
LENGTH = 20      # candles
MULT = 2.0       # band width, in standard deviations

def init(ctx):
    ctx.avg, ctx.dev = ta.SMA(LENGTH), ta.STDEV(LENGTH)

def on_bar(ctx, bar):
    m, d = ctx.avg.update(bar.close), ctx.dev.update(bar.close)
    if m is None:
        return
    up, dn = m + MULT * d, m - MULT * d
    ctx.plot(m, "Basis", "muted", style="dashed")
    ctx.plot(up, "Upper", "#26c6da")
    ctx.plot(dn, "Lower", "#26c6da")
    ctx.fill("Upper", "Lower", rgba("#26c6da", 0.08))
    if bar.close > up:
        ctx.bgcolor(rgba("up", 0.12))
    elif bar.close < dn:
        ctx.bgcolor(rgba("down", 0.12))
` };

export const IND_ORB: Example = { id: 'ind-orb', title: 'Opening range box', what: 'The first 30 minutes of the New York session as a box that runs on until the afternoon, and a label where price first closes outside it.', code: `# The opening range (Central Time) as a box that runs on through the day, and a label where price
# first closes outside it.
from datetime import datetime, timedelta, timezone

OPEN_TIME = "08:30"   # Central Time
RANGE_END = "09:00"   # Central Time
FLAT_TIME = "15:00"   # Central Time

${PY_TO_CT}

def init(ctx):
    ctx.open_t, ctx.range_t, ctx.flat_t = ctx.at(OPEN_TIME), ctx.at(RANGE_END), ctx.at(FLAT_TIME)
    ctx.day, ctx.box_, ctx.broke = None, None, False

def on_bar(ctx, bar):
    ct = to_ct(bar.time)
    day, t = ct.date(), ct.time()
    if day != ctx.day:                                  # a new day in Central Time
        ctx.day, ctx.box_, ctx.broke = day, None, False
    if ctx.open_t <= t < ctx.range_t:                   # building the range
        if ctx.box_ is None:
            ctx.box_ = ctx.box(bar.index, bar.high, bar.index, bar.low, text="Opening range")
        else:
            b = ctx.box_
            b.set(top=max(b.top, bar.high), bottom=min(b.bottom, bar.low), right=bar.index)
    elif ctx.box_ is not None and ctx.range_t <= t < ctx.flat_t:
        b = ctx.box_
        b.right = bar.index                             # the box runs on with the day
        if not ctx.broke and (bar.close > b.top or bar.close < b.bottom):
            ctx.broke = True
            above = bar.close > b.top
            ctx.label(bar.index, bar.high if above else bar.low, "Breakout",
                      color="up" if above else "down", style="down" if above else "up")
` };

export const IND_LEVELS: Example = { id: 'ind-levels', title: "Yesterday's high and low", what: "The last trading day's high and low as lines running to the right, replaced each new day. A day starts at 5 PM Central, as futures do.", code: `# The previous trading day's high and low as lines running right, replaced each day.
# A trading day starts at 5 PM Central Time, as futures do.
from datetime import datetime, timedelta, timezone

DAY_STARTS = 17       # hour, Central Time
SHOW_LABELS = True    # names on the lines

${PY_TO_CT}

def init(ctx):
    ctx.day, ctx.hi, ctx.lo = None, None, None
    ctx.drawn = []

def on_bar(ctx, bar):
    day = (to_ct(bar.time) - timedelta(hours=DAY_STARTS)).date()
    if day != ctx.day:
        if ctx.day is not None:                         # yesterday is complete: draw it
            for d in ctx.drawn:
                d.delete()
            ctx.drawn = [
                ctx.line(bar.index, ctx.hi, bar.index + 1, ctx.hi, color="up", style="dashed", extend="right"),
                ctx.line(bar.index, ctx.lo, bar.index + 1, ctx.lo, color="down", style="dashed", extend="right"),
            ]
            if SHOW_LABELS:
                ctx.drawn.append(ctx.label(bar.index, ctx.hi, "Yesterday's high", color="up", style="text"))
                ctx.drawn.append(ctx.label(bar.index, ctx.lo, "Yesterday's low", color="down", style="text"))
        ctx.day, ctx.hi, ctx.lo = day, bar.high, bar.low
    else:
        ctx.hi, ctx.lo = max(ctx.hi, bar.high), min(ctx.lo, bar.low)
` };

export const INDICATORS = [IND_FIRST, IND_RSI, IND_BANDS, IND_ORB, IND_LEVELS];

/* ---- strategies ---- */
export const STRAT_FIRST: Example = { id: 'st-first', title: 'Your first strategy', what: 'Buys when the close crosses above its 20-candle average, with a stop and a target in ticks. One position at a time.', code: `# Buy when the close crosses above its 20-candle average, with a stop and a target in ticks.
LENGTH = 20               # candles
STOP, TARGET = 40, 80     # ticks

def on_bar(ctx, bar):
    closes = ctx.closes(LENGTH + 1)                 # the last 21 closes, oldest first
    if len(closes) < LENGTH + 1 or ctx.position != 0:
        return
    avg_now, avg_before = closes[1:].mean(), closes[:-1].mean()
    if closes[-2] <= avg_before and closes[-1] > avg_now:
        ctx.buy(sl=bar.close - ctx.ticks(STOP), tp=bar.close + ctx.ticks(TARGET))
` };

export const STRAT_ORB: Example = { id: 'st-orb', title: 'Opening range breakout, sized by risk', what: 'The full pattern: settings at the top, Central Time, a dollar risk per trade, a cap on contracts and on trades per day, flat before the close.', code: `# Opening range breakout: stop orders above and below the first candles after the open. Each trade
# risks RISK_USD at its stop; one trade a day; flat (and orders cancelled) at FLAT_TIME.
import math
from datetime import datetime, timedelta, timezone

RISK_USD    = 200      # $ risked per trade (the loss at the stop)
QTY_STEP    = 1        # 1 for futures contracts, 0.01 for forex lots
MAX_QTY     = 5        # most contracts per trade, 0 = off
MAX_TRADES  = 1        # entries per day, 0 = off
RANGE_BARS  = 3        # candles that make the opening range
STOP_TICKS  = 2        # beyond the range, for the stop
RR          = 2.0      # target = RR x the risk
DIRECTION   = "both"   # "both", "long" or "short"
OPEN_TIME   = "08:30"  # Central Time
FLAT_TIME   = "14:55"  # Central Time

${PY_TO_CT}

${PY_SIZE_FOR}

def init(ctx):
    ctx.day, ctx.trades_today = None, 0
    ctx.open_t, ctx.flat_t = ctx.at(OPEN_TIME), ctx.at(FLAT_TIME)

def on_bar(ctx, bar):
    ct = to_ct(bar.time)
    day, t = ct.date(), ct.time()
    if day != ctx.day:                                  # a new day in Central Time
        ctx.day, ctx.trades_today, ctx.count, ctx.hi, ctx.lo = day, 0, 0, None, None
    if t >= ctx.flat_t:
        ctx.cancel_all()
        if ctx.position:
            ctx.close()
        return
    if t < ctx.open_t:
        return
    if ctx.count < RANGE_BARS:                          # building the range
        ctx.hi = bar.high if ctx.hi is None else max(ctx.hi, bar.high)
        ctx.lo = bar.low if ctx.lo is None else min(ctx.lo, bar.low)
        ctx.count += 1
        return
    if MAX_TRADES and ctx.trades_today >= MAX_TRADES:
        return
    if ctx.position or ctx.orders:
        return
    hi, lo, pad = ctx.hi, ctx.lo, ctx.ticks(STOP_TICKS)
    if DIRECTION in ("both", "long") and ctx.ask < hi:
        entry, sl = ctx.round(hi + ctx.tick_size), ctx.round(lo - pad)
        qty = size_for(ctx, entry, sl)
        if qty:
            ctx.buy_stop(entry, qty=qty, sl=sl, tp=ctx.round(entry + (entry - sl) * RR))
    if DIRECTION in ("both", "short") and ctx.bid > lo:
        entry, sl = ctx.round(lo - ctx.tick_size), ctx.round(hi + pad)
        qty = size_for(ctx, entry, sl)
        if qty:
            ctx.sell_stop(entry, qty=qty, sl=sl, tp=ctx.round(entry - (sl - entry) * RR))

def on_fill(ctx, fill):
    if fill.kind == "entry":
        ctx.trades_today += 1
        ctx.cancel_all()                                # drop the other side
` };

export const STRAT_TRAIL: Example = { id: 'st-trail', title: 'Trailing stop on every tick', what: 'Run it with "Every tick". A breakout of the last candles, then a stop that follows the best price tick by tick.', code: `# Run with "Every tick". A buy stop above the last LOOKBACK candles' high, sized by risk; once in,
# the stop trails TRAIL ticks behind the best price, checked on every tick.
import math

RISK_USD = 200     # $ risked per trade
QTY_STEP = 1       # 1 for futures contracts
MAX_QTY  = 5       # most contracts per trade, 0 = off
LOOKBACK = 20      # candles
TRAIL    = 40      # ticks behind the best price

${PY_SIZE_FOR}

def init(ctx):
    ctx.best = None

def on_bar(ctx, bar):
    if ctx.position != 0 or len(ctx.closes()) < LOOKBACK:
        return
    ctx.cancel_all()
    entry = ctx.round(ctx.highs(LOOKBACK).max() + ctx.tick_size)
    stop = ctx.round(ctx.lows(LOOKBACK).min())
    qty = size_for(ctx, entry, stop)
    if qty and entry > ctx.ask:                         # a buy stop must be above the ask
        ctx.buy_stop(entry, qty=qty, sl=stop)

def on_tick(ctx, tick):
    if ctx.position > 0:
        if ctx.best is None or tick.price > ctx.best:
            ctx.best = tick.price
            new_sl = ctx.round(ctx.best - ctx.ticks(TRAIL))
            if new_sl > (ctx.trades[0]["sl"] or 0):     # only ever tighten it
                ctx.set_bracket(sl=new_sl)
    else:
        ctx.best = None
` };

export const STRAT_JS: Example = { id: 'st-js', title: 'The same idea in JavaScript', what: 'A moving-average cross sized by risk, flat at a time in Central Time. JavaScript runs much faster than Python, which helps long optimizations.', code: `// Moving-average cross, sized so a stop costs RISK_USD, flat at FLAT_TIME (Central Time).
const RISK_USD = 200;      // $ risked per trade
const MAX_QTY = 5;         // most contracts per trade, 0 = off
const FAST = 9, SLOW = 21; // candles
const STOP = 40;           // ticks
const RR = 2;              // target = RR x the risk
const FLAT_TIME = "14:55"; // Central Time

${JS_TO_CT}

function sizeFor(ctx, entry, stop) {
  const perUnit = Math.abs(entry - stop) * ctx.point_value;
  if (perUnit <= 0) return null;
  let q = Math.floor(RISK_USD / perUnit + 1e-9);
  if (MAX_QTY) q = Math.min(q, MAX_QTY);
  return q >= 1 ? q : null;
}

const mean = a => a.reduce((s, x) => s + x, 0) / a.length;

function init(ctx) {
  ctx.flat = ctx.at(FLAT_TIME);
}

function on_bar(ctx, bar) {
  if (toCT(bar.time).time() >= ctx.flat) {
    ctx.cancel_all();
    if (ctx.position) ctx.close();
    return;
  }
  const c = ctx.closes(SLOW + 1);
  if (c.length < SLOW + 1 || ctx.position !== 0) return;
  const fastNow = mean(c.subarray(c.length - FAST)), slowNow = mean(c.subarray(1));
  const fastBefore = mean(c.subarray(c.length - FAST - 1, c.length - 1)), slowBefore = mean(c.subarray(0, SLOW));
  if (fastBefore <= slowBefore && fastNow > slowNow) {
    const sl = ctx.round(ctx.ask - ctx.ticks(STOP)), qty = sizeFor(ctx, ctx.ask, sl);
    if (qty) ctx.buy({ qty, sl, tp: ctx.round(ctx.ask + (ctx.ask - sl) * RR) });
  } else if (fastBefore >= slowBefore && fastNow < slowNow) {
    const sl = ctx.round(ctx.bid + ctx.ticks(STOP)), qty = sizeFor(ctx, ctx.bid, sl);
    if (qty) ctx.sell({ qty, sl, tp: ctx.round(ctx.bid - (sl - ctx.bid) * RR) });
  }
}
` };

export const STRATEGIES = [STRAT_FIRST, STRAT_ORB, STRAT_TRAIL, STRAT_JS];
