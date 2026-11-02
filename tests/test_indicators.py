"""The Python indicator runtime and ta helpers (in the <script id="trRuntime"> block in tape-replay.html), run by
CPython standing in for Pyodide. Needs numpy.
    python tests/test_indicators.py
"""
import json
import math
import os
import re
import types

import numpy as np

PAGE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tape-replay.html")
src = re.search(r'<script type="text/x-python" id="trRuntime">\n(.*?)</script>', open(PAGE, encoding="utf-8").read(), re.S).group(1)
rt = types.ModuleType("rt")
exec(compile(src, "trRuntime", "exec"), rt.__dict__)
ta = rt.ta
passed = 0


def check(cond, msg):
    global passed
    if not cond:
        raise AssertionError(msg)
    passed += 1


def close(a, b, tol=1e-9):
    return (a is None and b is None) or (a is not None and b is not None and abs(a - b) <= tol * max(1, abs(b)))


# ---- candles: a random walk, 5-minute bars from 2026-01-05 14:30 UTC, chart zone UTC-5
rng = np.random.default_rng(7)
N = 400
c = 5000 + np.cumsum(rng.normal(0, 2, N))
o = np.concatenate(([5000], c[:-1]))
h = np.maximum(o, c) + rng.uniform(0, 2, N)
lo = np.minimum(o, c) - rng.uniform(0, 2, N)
t = 1767623400 + 300 * np.arange(N)
rows = np.column_stack([t, o, h, lo, c, rng.uniform(100, 900, N), np.full(N, -18000)])
INFO = json.dumps({"name": "ES", "tf": "5m", "tfs": 300, "tick": 0.25, "pv": 50, "prec": 2})


def run(code, chunks=(N,), iid="a"):
    """Start an instance and feed the candles in chunks; the outputs, merged."""
    outs = [json.loads(rt._ti_start(iid, code, INFO))]
    i = 0
    for n in chunks:
        outs.append(json.loads(rt._ti_feed(iid, rows[i:i + n].ravel().tolist())))
        i += n
    rt._ti_stop(iid)
    return outs


def merged(outs, key):
    m = {}
    for x in outs:
        items = x.get(key) or {}
        for k, v in (items.items() if isinstance(items, dict) else (("|".join(f[:2]), f[2]) for f in items)):
            m.setdefault(k, []).extend(v)
    return m


# ---- ta: whole-array functions agree with the one-value-at-a-time classes, and with plain definitions
for n in (1, 5, 20):
    s = ta.sma(c, n)
    check(np.isnan(s[:n - 1]).all() and close(s[n - 1], c[:n].mean()) and close(s[-1], c[-n:].mean()), f"sma {n}")
    e, st = ta.ema(c, n), ta.EMA(n)
    vals = [st.update(x) for x in c]
    check(all(close(a, None if math.isnan(b) else b) for a, b in zip(vals, e)), f"EMA class matches ema() for {n}")
    check(close(e[n - 1], c[:n].mean()), "ema seeds with the simple average")
r = ta.rsi(c, 14)
rs = ta.RSI(14)
rv = [rs.update(x) for x in c]
check(all(close(a, None if math.isnan(b) else b) for a, b in zip(rv, r)), "RSI class matches rsi()")
check(np.nanmin(r) >= 0 and np.nanmax(r) <= 100 and np.isnan(r[:14]).all() and not np.isnan(r[14]), "rsi range and warm-up")
check(ta.rsi(np.arange(50.0), 14)[-1] == 100, "rsi of a rising line is 100")
a = ta.atr(h, lo, c, 14)
at = ta.ATR(14)
av = [at.update(*x) for x in zip(h, lo, c)]
check(all(close(x, None if math.isnan(y) else y) for x, y in zip(av, a)), "ATR class matches atr()")
check(close(ta.stdev(c, 10)[-1], c[-10:].std()) and close(ta.STDEV(10).update(1.0) or 0, 0), "stdev")
check(ta.highest(c, 10)[-1] == c[-10:].max() and ta.lowest(c, 10)[-1] == c[-10:].min(), "highest, lowest")
hi = ta.HIGHEST(3)
check([hi.update(x) for x in (1, 5, 2, 1, 0)] == [None, None, 5, 5, 2], "HIGHEST class")
check(ta.crossover([1, 3], [2, 2]) and not ta.crossover([3, 3], [2, 2]) and ta.crossunder([3, 1], 2), "crosses")
check(ta.sma([1, 2], 5).shape == (2,) and np.isnan(ta.ema([], 3)).all(), "short input")

# ---- plots, levels, fills, background and markers
CODE = '''
FAST, SLOW = 9, 21

def init(ctx):
    ctx.f, ctx.s = ta.EMA(FAST), ta.EMA(SLOW)
    ctx.hline(5000, "Round", color="muted")
    ctx.hline(70, pane="lower")

def on_bar(ctx, bar):
    f, s = ctx.f.update(bar.close), ctx.s.update(bar.close)
    ctx.plot(f, "Fast", "orange")
    ctx.plot(s, "Slow", "up" if (s or 0) < (f or 0) else "down", width=2)
    ctx.plot(ta.rsi(ctx.closes(30), 14)[-1], "RSI", pane="lower")
    if f is not None and s is not None:
        ctx.fill("Fast", "Slow", rgba("up" if f > s else "down", 0.15))
    if bar.index % 50 == 0:
        ctx.bgcolor(rgba("accent", 0.1))
        ctx.marker("50", shape="arrow_up", position="below", color="up")
'''
outs = run(CODE)
check(not any("error" in x for x in outs), f"no errors {[x.get('error') for x in outs]}")
meta = [m for x in outs for m in x.get("meta", [])]
check([m["title"] for m in meta] == ["Fast", "Slow", "RSI"] and meta[2]["pane"] == "lower" and meta[1]["width"] == 2, f"meta {meta}")
pl = merged(outs, "plots")
check(len(pl["Fast"]) == N and pl["Fast"][0][0] == t[0] and pl["Fast"][-1][0] == t[-1], "one point per candle, at its time")
check(pl["Fast"][7][1] is None and close(pl["Fast"][8][1], c[:9].mean()), "warm-up is a gap, then the EMA")
check(all(len(p) == 2 for p in pl["Fast"]), "a plot in its own color sends no color per point")
check(any(len(p) == 3 for p in pl["Slow"]), "a plot whose color changes sends it per point")
hl = outs[0]["hlines"]
check(len(hl) == 2 and hl[0]["price"] == 5000 and hl[0]["title"] == "Round" and hl[1]["pane"] == "lower", f"hlines {hl}")
check(not any("hlines" in x for x in outs[1:]), "levels are sent once, when they change")
fl = merged(outs, "fills")["Fast|Slow"]
check(len(fl) == N - 20 and fl[0][0] == t[20] and fl[0][3].startswith(("up@", "down@")), f"fill points {fl[:1]}")
bg = [b for x in outs for b in x.get("bg", [])]
mk = [m for x in outs for m in x.get("marks", [])]
check(len(bg) == 8 and bg[0] == [t[0], "accent@0.1"], f"bg {bg[:2]}")
check(len(mk) == 8 and mk[1][:5] == [t[50], "arrow_up", "below", "up", "50"], f"marks {mk[:2]}")

# fed a few candles at a time (as the replay plays), the same as all at once: nothing depends on later candles
outs2 = run(CODE, chunks=[1] * 100 + [37, 63, 200])
check(merged(outs2, "plots") == pl and merged(outs2, "fills") == merged(outs, "fills"), "chunked feed gives the same result")

# ---- boxes, lines, labels: created, changed, deleted, capped
DRAW = '''
def init(ctx):
    ctx.box_ = None

def on_bar(ctx, bar):
    if bar.index == 10:
        ctx.box_ = ctx.box(bar.index, bar.high, bar.index + 5, bar.low, color="#3b82f6", text="range")
        ctx.ln = ctx.line(bar.time, bar.close, bar.index + 3, bar.close + 1, extend="right")
    if bar.index == 12:
        ctx.box_.right = bar.index
        ctx.box_.set(top=bar.high + 1, text="moved")
    if bar.index == 14:
        ctx.ln.delete()
    if bar.index >= 20:
        for k in range(3):
            ctx.label(bar.index, bar.high + k, f"{bar.index}", style="down")
'''
outs = run(DRAW, chunks=[11, 2, 2, N - 15])
d1 = {d["kind"]: d for d in outs[1]["draw"]}
check(d1["box"]["left"] == t[10] and d1["box"]["right"] == t[10] + 5 * 300 and d1["box"]["fill"] == "#3b82f6@0.15", f"box {d1['box']}")
check(d1["line"]["x1"] == t[10] and d1["line"]["extend"] == "right", "line at a time and an index")
d2 = outs[2]["draw"]
check(len(d2) == 1 and d2[0]["id"] == d1["box"]["id"] and d2[0]["right"] == t[12] and d2[0]["text"] == "moved", f"only the changed box is sent {d2}")
check(outs[3]["del"] == [d1["line"]["id"]] and "draw" not in outs[3], "deleted line")
labels = [d for d in outs[4]["draw"] if d["kind"] == "label"]
check(len(labels) == 500 and len(outs[4]["del"]) == 3 * (N - 20) - 500, "labels capped at 500, oldest deleted")

# ---- errors: the line in the user's code, and the indicator stops
err = json.loads(rt._ti_start("e", "def on_bar(ctx, bar):\n    x = 1 +\n", INFO))
check(err["error"].startswith("SyntaxError") and "line 2" in err["error"], f"syntax error {err}")
err = json.loads(rt._ti_start("e", "X = 1\n", INFO))
check("on_bar" in err["error"], "needs on_bar")
BAD = 'def on_bar(ctx, bar):\n    ctx.plot(bar.close, "C")\n    if bar.index == 3:\n        ctx.box(bar.index, 1, "later", 0)\n'
outs = run(BAD, iid="b")
check("TypeError" in outs[1]["error"] and "line 4" in outs[1]["error"], f"runtime error {outs[1]['error']}")
check(len(outs[1]["plots"]["C"]) == 4, "what was plotted before the error is kept")
check(json.loads(rt._ti_start("c", 'def on_bar(ctx, bar):\n    ctx.plot(1, style="zigzag")\n', INFO)).get("error") is None, "starts")
check("style must be" in json.loads(rt._ti_feed("c", rows[:1].ravel().tolist()))["error"], "bad style named")
check(json.loads(rt._ti_feed("c", rows[1:2].ravel().tolist())) == {}, "a stopped indicator does nothing")
check(rt._ti_check("def on_bar(ctx, bar) pass") .startswith("SyntaxError") and rt._ti_check(CODE) is None, "check")

# ---- ctx: history, time zone and helpers
SEE = '''
def on_bar(ctx, bar):
    if bar.index == 5:
        ctx.plot(len(ctx.closes()), "n")
        ctx.plot(ctx.closes(3)[-1] - bar.close, "same")
        ctx.plot(bar.time.utcoffset().total_seconds(), "off")
        ctx.plot(ctx.round(1.23456), "round")
'''
pl = merged(run(SEE), "plots")
check(pl["n"][0][1] == 6 and pl["same"][0][1] == 0 and pl["off"][0][1] == -18000 and pl["round"][0][1] == 1.23, f"ctx {pl}")
# strategies get ta too
STRAT = 'def init(ctx):\n    ctx.e = ta.EMA(2)\ndef on_bar(ctx, bar):\n    ctx.v = ctx.e.update(bar.close)\n'
check(json.loads(rt._tr_start(None, STRAT, INFO)).get("error") is None, "a strategy can use ta")
rt._tr_bar(t[0], 1, 1, 1, 10.0, 0, 0, 0, None, 0, 0)
rt._tr_bar(t[1], 1, 1, 1, 20.0, 0, 0, 0, None, 0, 0)
check(rt._S["ctx"].v == 15, "ta.EMA in a strategy")
rt._tr_end(0, None, 0, 0)
print(f"indicators: {passed} checks passed")
