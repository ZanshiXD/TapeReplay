// The Python indicators people keep: their saved scripts (pref pyScripts: name -> code) and the ones on the charts
// (pref pyInds: [{ id, name, code, on }], each with its own copy of the code). The templates are the classic app's.
import { bump, pref, setPref } from '../live';

export interface PyInd { id: string; name: string; code: string; on: boolean }
export const pyState = { ver: 0 };
export const pyInds = () => pref<PyInd[]>('pyInds', []);
export const pyScripts = () => pref<Record<string, string>>('pyScripts', {});
export function setPyInds(l: PyInd[]) { setPref('pyInds', l); pyState.ver++; bump(); }
export function setPyScripts(s: Record<string, string>) { setPref('pyScripts', s); pyState.ver++; bump(); }
/** a name not used yet by a saved script or one on the charts: "RSI", "RSI 2", ... */
export function freeName(base: string) {
  const s = pyScripts(), l = pyInds(), used = (n: string) => n in s || l.some(x => x.name === n);
  if (!used(base)) return base;
  for (let k = 2; ; k++) if (!used(`${base} ${k}`)) return `${base} ${k}`;
}

/** what each template does, in a few words */
export const PY_TEMPLATE_INFO: Record<string, string> = {
  'EMA cross': 'Two EMAs, shaded between, with an arrow where they cross.',
  'RSI': 'RSI in a pane under the chart, with 70 and 30 levels.',
  'Bollinger Bands': 'An average with bands two deviations away.',
  'Opening range box': 'The first 30 minutes as a box, and where price breaks out.',
  'Swing levels': 'Swing highs and lows as levels until price closes through.',
  'Blank': 'Start from scratch.',
};

export const PY_TEMPLATES: Record<string, string> = {
  'EMA cross': `# Two EMAs, the gap between them shaded green or red, and an arrow where they cross.
FAST = 9     # candles
SLOW = 21    # candles

def init(ctx):
    ctx.fast, ctx.slow = ta.EMA(FAST), ta.EMA(SLOW)
    ctx.was_above = None

def on_bar(ctx, bar):
    f, s = ctx.fast.update(bar.close), ctx.slow.update(bar.close)
    ctx.plot(f, "Fast", "#e2a63c")
    ctx.plot(s, "Slow", "#7f9cf5", width=2)
    if f is None or s is None:          # still warming up
        return
    above = f > s
    ctx.fill("Fast", "Slow", rgba("up" if above else "down", 0.15))
    if ctx.was_above is not None and above != ctx.was_above:
        if above:
            ctx.marker("Up", shape="arrow_up", position="below", color="up")
        else:
            ctx.marker("Down", shape="arrow_down", position="above", color="down")
    ctx.was_above = above
`,
  'RSI': `# RSI in a band under the chart, with 70 and 30 levels; the price chart is tinted at the extremes.
LENGTH = 14
HIGH = 70
LOW = 30

def init(ctx):
    ctx.rsi = ta.RSI(LENGTH)
    ctx.hline(HIGH, "Overbought", color="down", pane="lower")
    ctx.hline(LOW, "Oversold", color="up", pane="lower")
    ctx.hline(50, color="muted", style="dotted", pane="lower")

def on_bar(ctx, bar):
    r = ctx.rsi.update(bar.close)
    ctx.plot(r, "RSI", "#c158dc", pane="lower")
    if r is not None and r > HIGH:
        ctx.bgcolor(rgba("down", 0.08))
    elif r is not None and r < LOW:
        ctx.bgcolor(rgba("up", 0.08))
`,
  'Bollinger Bands': `# A moving average with bands MULT standard deviations above and below it.
LENGTH = 20
MULT = 2.0

def on_bar(ctx, bar):
    closes = ctx.closes(LENGTH)          # the last LENGTH closes, a numpy array
    if len(closes) < LENGTH:
        return
    mid, dev = closes.mean(), closes.std()
    ctx.plot(mid, "Basis", "muted", style="dashed")
    ctx.plot(mid + MULT * dev, "Upper", "#26c6da")
    ctx.plot(mid - MULT * dev, "Lower", "#26c6da")
    ctx.fill("Upper", "Lower", rgba("#26c6da", 0.08))
`,
  'Opening range box': `# The high and low of the first 30 minutes after the open (in the chart's time zone) as a box that
# runs with the session, and a label where price first closes outside it.
OPEN = "09:30"
RANGE_END = "10:00"
SESSION_END = "16:00"

def init(ctx):
    ctx.day, ctx.range, ctx.broke = None, None, False

def on_bar(ctx, bar):
    t = bar.time.time()
    if bar.time.date() != ctx.day:                 # a new day
        ctx.day, ctx.range, ctx.broke = bar.time.date(), None, False
    if ctx.at(OPEN) <= t < ctx.at(RANGE_END):
        if ctx.range is None:
            ctx.range = ctx.box(bar.index, bar.high, bar.index, bar.low, color="accent", text="Opening range")
        else:
            r = ctx.range
            r.set(top=max(r.top, bar.high), bottom=min(r.bottom, bar.low), right=bar.index)
    elif ctx.range is not None and ctx.at(RANGE_END) <= t < ctx.at(SESSION_END):
        r = ctx.range
        r.right = bar.index                        # the box keeps running with the session
        if not ctx.broke and bar.close > r.top:
            ctx.broke = True
            ctx.label(bar.index, bar.high, "Breakout", color="up", style="down")
        elif not ctx.broke and bar.close < r.bottom:
            ctx.broke = True
            ctx.label(bar.index, bar.low, "Breakdown", color="down", style="up")
`,
  'Swing levels': `# Swing highs and lows: a candle higher (or lower) than the SIDE candles on each side of it.
# Each one is a level that runs right until a candle closes through it, then turns dotted.
SIDE = 5    # candles on each side

def init(ctx):
    ctx.live = []                              # (line, "high" or "low")

def on_bar(ctx, bar):
    for ln, kind in list(ctx.live):
        ln.x2 = bar.index
        if (kind == "high" and bar.close > ln.y1) or (kind == "low" and bar.close < ln.y1):
            ln.style = "dotted"
            ctx.live.remove((ln, kind))
    n = 2 * SIDE + 1
    highs, lows = ctx.highs(n), ctx.lows(n)
    if len(highs) < n:
        return
    i = bar.index - SIDE                       # the candle in the middle: confirmed SIDE candles later
    if highs[SIDE] == highs.max():
        ctx.live.append((ctx.line(i, highs[SIDE], bar.index, highs[SIDE], color="down"), "high"))
        ctx.marker("H", shape="arrow_down", position="above", color="down", at=i)
    if lows[SIDE] == lows.min():
        ctx.live.append((ctx.line(i, lows[SIDE], bar.index, lows[SIDE], color="up"), "low"))
        ctx.marker("L", shape="arrow_up", position="below", color="up", at=i)
`,
  'Blank': `# Runs on every closed candle of the chart, oldest first. Help lists everything ctx can draw.
def init(ctx):
    pass

def on_bar(ctx, bar):
    # bar.time, bar.open, bar.high, bar.low, bar.close, bar.volume, bar.index
    ctx.plot(bar.close, "Close")
`,
};
