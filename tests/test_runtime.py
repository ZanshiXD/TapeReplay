"""The Python strategy runtime (the <script id="trRuntime"> block in tape-replay.html), run by CPython with a
fake page API standing in for Pyodide and the replay engine. Needs numpy and pandas.
    python tests/test_runtime.py
"""
import io
import json
import os
import re
import sys
import types
from contextlib import redirect_stdout

PAGE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tape-replay.html")
src = re.search(r'<script type="text/x-python" id="trRuntime">\n(.*?)</script>', open(PAGE, encoding="utf-8").read(), re.S).group(1)
rt = types.ModuleType("rt")
exec(compile(src, "trRuntime", "exec"), rt.__dict__)


class FakeApi:
    def __init__(self):
        self.calls = []
        self.reject = None

    def submit(self, side, kind, price, sl, tp, qty):
        self.calls.append(("submit", side, kind, price, sl, tp, qty))
        if self.reject:
            return json.dumps({"error": self.reject})
        return json.dumps({"ok": True, "id": len(self.calls)})

    def close_all(self):
        self.calls.append(("close_all",))

    def cancel(self, oid):
        self.calls.append(("cancel", oid))
        return json.dumps({"ok": True})

    def bracket(self, sl, tp):
        self.calls.append(("bracket", sl, tp))

    def orders(self):
        return "[]"

    def trades(self):
        return "[]"

    def history(self):
        return "[]"


INFO = json.dumps({"name": "ES", "tf": "5m", "tick": 0.25, "pv": 50, "mode": "bar", "balance": 50000, "qty": 3, "spread": 0.25, "prec": 2})
MA = """
FAST, SLOW = 3, 5
def init(ctx):
    ctx.seen = 0
def on_bar(ctx, bar):
    ctx.seen += 1
    c = ctx.closes(SLOW + 1)
    if len(c) <= SLOW:
        return
    if c[-FAST:].mean() > c[-SLOW:].mean() and ctx.position <= 0:
        ctx.buy(1, sl=bar.close - ctx.ticks(8), tp=bar.close + ctx.ticks(16))
    elif c[-FAST:].mean() < c[-SLOW:].mean() and ctx.position >= 0:
        ctx.sell(2, limit=bar.close + 1)
def on_fill(ctx, fill):
    print(fill)
def on_end(ctx):
    print("end", ctx.seen)
"""

ok = 0


def start(api, code, info):
    r = json.loads(rt._tr_start(api, code, info))
    return r.get("error")


def check(cond, msg):
    global ok
    assert cond, msg
    ok += 1


api = FakeApi()
check(start(api, MA, INFO) is None, "start")
prices = [100, 101, 102, 103, 104, 105, 104, 103, 101, 99, 98, 99, 101]
for i, p in enumerate(prices):
    r = rt._tr_bar(1_700_000_000 + i * 300, p, p + 1, p - 1, p, 10, -18000, 0, None, 50000, 50000)
    check(r is None, f"bar {i}: {r}")
subs = [c for c in api.calls if c[0] == "submit"]
check(subs[0][1:3] == (1, "market") and subs[0][4] == 105 - 2 and subs[0][5] == 105 + 4, f"buy bracket {subs[0]}")
check(any(c[1] == -1 and c[2] == "limit" and c[6] == 2 for c in subs), "sell limit")
ctx = rt._S["ctx"]
check(ctx.closes().tolist() == [float(x) for x in prices], "closes")
check(len(ctx.closes(3)) == 3 and not ctx.closes(3).flags.writeable, "view")
check(ctx.time.utcoffset().total_seconds() == -18000, "zone")
check(ctx.at("09:30").hour == 9, "at")
df = ctx.df(4)
check(list(df.columns) == ["open", "high", "low", "close", "volume"] and len(df) == 4 and str(df.index.tz) == "UTC-05:00", "df")
buf = io.StringIO()
with redirect_stdout(buf):
    check(rt._tr_fill(json.dumps({"time": 1_700_000_000, "off": 0, "side": "sell", "qty": 1, "price": 101.5, "kind": "exit", "reason": "Stop loss", "id": 3, "pnl": -230.5}), 0, None, 49769.5, 49769.5) is None, "fill")
    check(rt._tr_end(0, None, 49769.5, 49769.5) is None, "end")
check("Stop loss" in buf.getvalue() and "pnl=-230.50" in buf.getvalue() and "end 13" in buf.getvalue(), buf.getvalue())

# many bars: the buffer grows
api = FakeApi()
start(api, "def on_bar(ctx, bar):\n    pass\n", INFO)
for i in range(10000):
    rt._tr_bar(i * 60.0, 1, 2, 0.5, 1.5, 3, 0, 0, None, 1, 1)
check(rt._S["ctx"]._k == 10000 and rt._S["ctx"].closes(2).tolist() == [1.5, 1.5], "grow")
rt._tr_end(0, None, 1, 1)

# errors point at the user's line
api = FakeApi()
check(start(api, "def on_bar(ctx, bar):\n    x = 1\n    return 1 / 0\n", INFO) is None, "start2")
e = rt._tr_bar(0, 1, 1, 1, 1, 1, 0, 0, None, 1, 1)
check(e.startswith("ZeroDivisionError") and "line 3, in on_bar" in e and "return 1 / 0" in e, e)
e = start(api, "def on_bar(ctx, bar)\n    pass\n", INFO)
check(e.startswith("SyntaxError") and "line 1" in e, e)
check("on_bar" in start(api, "x = 1\n", INFO), "no on_bar")
check("Every tick" in start(api, "def on_tick(ctx, t):\n    pass\n", INFO), "tick-only in bar mode")
e = start(api, "def init(ctx):\n    ctx.nope()\ndef on_bar(ctx, bar):\n    pass\n", INFO)
check(e.startswith("AttributeError") and "line 2, in init" in e, e)

# tick mode
api = FakeApi()
info = json.loads(INFO); info["mode"] = "tick"
check(start(api, "def on_tick(ctx, tick):\n    if tick.price > 10: ctx.close()\n", json.dumps(info)) is None, "tick start")
check(rt._tr_bar(0, 1, 1, 1, 1, 1, 0, 0, None, 1, 1) is None, "bar w/o on_bar in tick mode")
check(rt._tr_tick(1.5, 11, 0, 1, 10, 1, 1) is None and api.calls[-1] == ("close_all",), "tick close")

# rejected orders are printed once, then counted
api = FakeApi(); api.reject = "Prop rules: max size"
start(api, "def on_bar(ctx, bar):\n    r = ctx.buy(1)\n    assert r is None\n", INFO)
buf = io.StringIO()
with redirect_stdout(buf):
    for i in range(12):
        check(rt._tr_bar(i, 1, 1, 1, 1, 1, 0, 0, None, 1, 1) is None, "reject bar")
out = buf.getvalue().strip().splitlines()
check(len(out) == 2 and "Order rejected: Prop rules" in out[0] and "10 times" in out[1], out)

# bad arguments become errors on the user's line
api = FakeApi()
start(api, "def on_bar(ctx, bar):\n    ctx.buy(1, limit=1, stop=2)\n", INFO)
e = rt._tr_bar(0, 1, 1, 1, 1, 1, 0, 0, None, 1, 1)
check(e.startswith("ValueError") and "line 2" in e, e)
check(rt._tr_check("def f(:\n") .startswith("SyntaxError") and rt._tr_check("x = 1\n") is None, "check")
r = json.loads(rt._tr_start(FakeApi(), "def on_bar(c, b): pass\ndef on_fill(c, f): pass\n", INFO))
check(r == {"on_tick": False, "on_fill": True}, r)
# rejections that differ only in price are one kind
api = FakeApi()
start(api, "def on_bar(ctx, bar):\n    ctx.buy(1)\n", INFO)
buf = io.StringIO()
with redirect_stdout(buf):
    for i in range(10):
        api.reject = f"A buy limit must be below the ask ({100 + i})."
        rt._tr_bar(i, 1, 1, 1, 1, 1, 0, 0, None, 1, 1)
out = buf.getvalue().strip().splitlines()
check(len(out) == 2 and "(100)" in out[0] and "10 times" in out[1], out)
api = FakeApi()
start(api, "def on_bar(ctx, bar):\n    ctx.buy()\n    ctx.sell_stop(bar.low - ctx.spread, sl=bar.high)\n", INFO)
rt._tr_bar(0, 10, 11, 9, 10, 1, 0, 0, None, 1, 1)
check(api.calls[0][6] == 3 and api.calls[1][1:4] == (-1, "stop", 8.75) and api.calls[1][6] == 3, api.calls)
c = rt._S["ctx"]
check(c.bid == 10 and c.ask == 10.25 and c.round(1.0000001) == 1.0, (c.bid, c.ask))
print(f"runtime: {ok} checks passed")
