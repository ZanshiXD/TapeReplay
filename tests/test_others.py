"""Other instruments loaded with the session (XS) in Python scripts: ctx.other("ES") / ctx.others() in strategies,
indicators and optimization workers. Two parts:
 1. the runtime alone in CPython, with a fake page API that answers like the page's xsApi (no lookahead, the same
    candles as an independent aggregation however often other() is called, indicators, no other instruments);
 2. end to end in Chromium through the desktop app's server: two synthetic instruments injected into XS beside the
    practice data, then a backtest, an indicator, the optimizer (workers) and a session with none.
Build the page and Python first (see test_browser.py), then:
    python tests/test_others.py [folder for screenshots]
Needs numpy, pandas and playwright. Set OTHERS_NO_BROWSER=1 for part 1 only.
"""
import asyncio
import json
import os
import re
import sys
import tempfile
import threading
import types

import numpy as np

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
PAGE = os.path.join(ROOT, "tape-replay.html")
OUT = sys.argv[1] if len(sys.argv) > 1 else tempfile.mkdtemp(prefix="tape-shots-")
passed = 0


def check(cond, msg):
    global passed
    if not cond:
        raise AssertionError(msg)
    passed += 1


# ---------------------------------------------------------------- 1. the runtime in CPython
src = re.search(r'<script type="text/x-python" id="trRuntime">\n(.*?)</script>', open(PAGE, encoding="utf-8").read(), re.S).group(1)
rt = types.ModuleType("rt")
exec(compile(src, "trRuntime", "exec"), rt.__dict__)
TFS = {"1m": 60, "5m": 300, "15m": 900}


class FakeXs:
    """The page's xsApi: bars after `after` complete at tc, each with its candle's start (intraday: a plain floor)."""

    def __init__(self, inst):
        self.inst, self.calls = inst, 0

    def list(self):
        return json.dumps([{"key": k, "sym": x["sym"], "name": x["name"], "base": x["base"], "prec": 2} for k, x in self.inst.items()])

    def bars(self, key, tf, after, tc, n):
        self.calls += 1
        x, s = self.inst.get(key), TFS[tf]
        t = x["t"]
        i, j = np.searchsorted(t, after, "right"), np.searchsorted(t + x["base"], tc, "right")
        j = min(j, i + n)
        if j <= i:
            return []
        k = slice(i, j)
        return np.column_stack((t[k], np.floor(t[k] / s) * s, x["o"][k], x["h"][k], x["l"][k], x["c"][k], x["v"][k])).ravel().tolist()


class FakeApi:
    def submit(self, *a):
        return json.dumps({"ok": True, "id": 1})

    def close_all(self):
        pass

    def cancel(self, oid):
        return json.dumps({"ok": True})

    def bracket(self, sl, tp):
        pass

    def orders(self):
        return "[]"

    def trades(self):
        return "[]"

    def history(self, start=0):
        return "[]"


def series(rng, t0, n, base, keep, drift):
    t = t0 + np.arange(n) * base
    t = t[rng.random(n) < keep].astype(float)
    c = 100 + np.cumsum(rng.normal(drift, 1, len(t)))
    o = np.concatenate(([c[0]], c[:-1]))
    h, l = np.maximum(o, c) + rng.random(len(t)), np.minimum(o, c) - rng.random(len(t))
    return {"t": t, "o": o, "h": h, "l": l, "c": c, "v": rng.integers(1, 50, len(t)).astype(float), "base": float(base)}


def agg(x, t0, tc, s):
    """Independent: the candles of bars with t >= t0 and t + base <= tc, by floor(t / s) * s."""
    out = {}
    for t, o, h, l, c, v in zip(x["t"], x["o"], x["h"], x["l"], x["c"], x["v"]):
        if t < t0 or t + x["base"] > tc:
            continue
        b = np.floor(t / s) * s
        if b not in out:
            out[b] = [b, o, h, l, c, v]
        else:
            r = out[b]
            r[2], r[3], r[4], r[5] = max(r[2], h), min(r[3], l), c, r[5] + v
    return np.array([out[b] for b in sorted(out)]).T.reshape(6, -1)


rng = np.random.default_rng(7)
T0 = 1_700_000_040.0  # not on a 5-minute boundary: the first candle is partial
MAIN = series(rng, T0, 2400, 60, 0.9, 0.0)
INST = {"x1": dict(series(rng, T0 - 600, 2600, 60, 0.85, 0.01), sym="ES", name="ES futures, 1m"),
        "x2": dict(series(rng, T0, 4800, 30, 0.8, -0.01), sym="YM", name="YM 30s")}

STRAT = """
EVERY = 1
START = 0
def init(ctx):
    ctx.log, ctx.names = [], ctx.others()
def on_bar(ctx, bar):
    if bar.index < START or bar.index % EVERY:
        return
    for s in ("ES", "ym"):
        o = ctx.other(s)
        ctx.log.append((bar.index, o.symbol, ctx._tc, bar.time.timestamp(), np.vstack((o.times(), o.opens(), o.highs(), o.lows(), o.closes(), o.volumes())),
                        None if o.time is None else o.time.timestamp(), o.price, len(o)))
"""


def candles(m, s):
    """The main series' candles: (open time, o, h, l, c, v, close time = the last bar's end)."""
    out, cur = [], None
    for t, o, h, l, c, v in zip(m["t"], m["o"], m["h"], m["l"], m["c"], m["v"]):
        b = np.floor(t / s) * s
        if cur and cur[0] == b:
            cur[2], cur[3], cur[4], cur[5], cur[6] = max(cur[2], h), min(cur[3], l), c, cur[5] + v, t + m["base"]
        else:
            if cur:
                out.append(cur)
            cur = [b, o, h, l, c, v, t + m["base"]]
    out.append(cur)
    return out


CANDLES = candles(MAIN, 300)


def run_strat(every, start, api):
    rt._tr_xs_init(api)
    code = STRAT.replace("EVERY = 1", f"EVERY = {every}").replace("START = 0", f"START = {start}")
    r = json.loads(rt._tr_start(FakeApi(), code, json.dumps({"name": "NQ", "tf": "5m", "tick": 0.25, "pv": 20, "mode": "bar", "balance": 1, "prec": 2})))
    check("error" not in r, r)
    for b, o, h, l, c, v, tc in CANDLES:
        e = rt._tr_bar(b, o, h, l, c, v, 0, 0, None, 1, 1, tc)
        check(e is None, e)
    ctx = rt._S["ctx"]
    log, names, first = ctx.log, ctx.names, float(ctx.times()[0])
    rt._tr_end(0, None, 1, 1)
    return log, names, first


for every, start in ((1, 0), (7, 0), (1, 150), (40, 3)):
    api = FakeXs(INST)
    log, names, first = run_strat(every, start, api)
    check(names == ["ES", "YM"], names)
    check(len(log) == 2 * len([1 for i in range(len(CANDLES)) if i >= start and i % every == 0]), len(log))
    full = 0
    for idx, sym, tc, bt, got, ot, price, n in log:
        x = INST["x1" if sym == "ES" else "x2"]
        want = agg(x, first, tc, 300)
        check(got.shape == want.shape and np.allclose(got, want), f"every={every} start={start} bar {idx} {sym}: {got.shape} vs {want.shape}")
        check(n == got.shape[1], "len()")
        if n:
            # no lookahead: no candle after this one, every bar in it ended by the close, a whole earlier candle
            check(got[0, -1] <= bt and ot == got[0, -1] and price == got[4, -1], f"last candle at {got[0, -1]} vs bar {bt}")
            if tc == bt + 300:
                full += 1
                check(got[0, -1] + 300 <= tc, f"candle {got[0, -1]} + 5m > close {tc}")
    check(full > len(log) // 2, f"{full} of {len(log)} on whole candles")
    check(api.calls <= len(log) + 4, f"one page call per other() per candle at most: {api.calls} for {len(log)}")

# the same candle asked for twice on one bar: one page call
api = FakeXs(INST)
rt._tr_xs_init(api)
rt._tr_start(FakeApi(), "def on_bar(ctx, bar):\n    ctx.other('ES'); ctx.other('ES'); ctx.other(0)\n", json.dumps({"tf": "5m"}))
for b, o, h, l, c, v, tc in CANDLES[:20]:
    rt._tr_bar(b, o, h, l, c, v, 0, 0, None, 1, 1, tc)
check(api.calls == 20, f"{api.calls} calls for 20 candles")

# names, indexes, errors, pandas
ctx = rt._S["ctx"]
check(ctx.other("es") is ctx.other(0) is ctx.other() is ctx.other("ES futures, 1m") is ctx.other("x1"), "by symbol, index, name, key")
check(ctx.other(-1).symbol == "YM" and ctx.other(1).name == "YM 30s", "by index")
try:
    ctx.other("NQ")
    check(False, "an unknown symbol is an error")
except ValueError as e:
    check('No other instrument "NQ"' in str(e) and "ES, YM" in str(e), str(e))
try:
    ctx.other(2)
    check(False, "an index past the end is an error")
except IndexError as e:
    check("other(0) to other(1)" in str(e), str(e))
df = ctx.other("ES").df()
check(list(df.columns) == ["open", "high", "low", "close", "volume"] and len(df) == len(ctx.other("ES")), "df")
check("Other('ES' 5m" in repr(ctx.other("ES")), repr(ctx.other("ES")))
e = rt._tr_bar(*CANDLES[20][:6], 0, 0, None, 1, 1, CANDLES[20][6])
rt._tr_end(0, None, 1, 1)
r = json.loads(rt._tr_start(FakeApi(), "def on_bar(ctx, bar):\n    ctx.other('NQ')\n", json.dumps({"tf": "5m"})))
e = rt._tr_bar(*CANDLES[0][:6], 0, 0, None, 1, 1, CANDLES[0][6])
check(e.startswith('ValueError: No other instrument "NQ"') and "line 2, in on_bar" in e, e)
rt._tr_end(0, None, 1, 1)

# no other instruments: empty, never an error
for api in (None, FakeXs({})):
    rt._tr_xs_init(api)
    rt._tr_start(FakeApi(), "def on_bar(ctx, bar):\n    ctx.seen = (ctx.others(), len(ctx.other('ES')), len(ctx.other()), len(ctx.other(0).closes(5)), ctx.other('ES').time, ctx.other().price)\n", json.dumps({"tf": "5m"}))
    for b, o, h, l, c, v, tc in CANDLES[:5]:
        check(rt._tr_bar(b, o, h, l, c, v, 0, 0, None, 1, 1, tc) is None, "no others: no error")
    check(rt._S["ctx"].seen == ([], 0, 0, 0, None, None), rt._S["ctx"].seen)
    rt._tr_end(0, None, 1, 1)

# indicators: 8 numbers per candle, the 8th its close; 7 (no close times) still works
rt._tr_xs_init(FakeXs(INST))
IND = """
def init(ctx):
    ctx.log = []
def on_bar(ctx, bar):
    o = ctx.other("YM")
    ctx.log.append((ctx._tc, o.times().copy(), o.closes().copy()))
    ctx.plot(o.price, "YM", pane="lower")
"""
out = json.loads(rt._ti_start("a", IND, json.dumps({"name": "NQ", "tf": "5m", "tfs": 300, "tick": 0.25, "prec": 2})))
check("error" not in out, out)
rows = np.array([[b, o, h, l, c, v, 0, tc] for b, o, h, l, c, v, tc in CANDLES])
for i in range(0, len(rows), 100):
    out = json.loads(rt._ti_feed("a", rows[i:i + 100].ravel().tolist(), 8))
    check("error" not in out, out)
ind = rt._TI["a"].ctx
first = float(ind.times()[0])
check(len(ind.log) == len(CANDLES), len(ind.log))
for tc, t, c in ind.log[::25]:
    want = agg(INST["x2"], first, tc, 300)
    check(np.allclose(t, want[0]) and np.allclose(c, want[4]), f"indicator at {tc}")
rt._ti_stop("a")
rt._ti_start("b", IND, json.dumps({"tf": "5m", "tfs": 300}))
json.loads(rt._ti_feed("b", rows[:50, :7].ravel().tolist()))
check(rt._TI["b"].ctx.log[-1][0] == rows[49, 0] + 300, "7 numbers: a candle closes a timeframe after its open")
rt._ti_stop("b")
rt._tr_xs_init(None)
print(f"others (runtime): {passed} checks passed")


# ---------------------------------------------------------------- 2. end to end in Chromium
if os.environ.get("OTHERS_NO_BROWSER"):
    sys.exit(0)
from playwright.async_api import async_playwright  # noqa: E402

os.makedirs(OUT, exist_ok=True)


def serve():
    os.environ["APPDATA"] = tempfile.mkdtemp(prefix="tape-appdata-")
    sys.path.insert(0, os.path.join(ROOT, "desktop"))
    import app
    for d in (app.DATASETS, app.SESSIONS):
        os.makedirs(d, exist_ok=True)
    srv = app.ExclusiveServer(("127.0.0.1", 0), app.Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{srv.server_address[1]}/index.html?t={app.TOKEN}"


URL = serve()
# the page as served, with a handle on its state for this test only (XS and D live inside the page's closure)
HOOK = "let XS = [];   // [{ key: 'x1'"
PROBE = "window.__tapeTest = { get D() { return D; }, get XS() { return XS; }, set XS(v) { XS = v; } };\n"

# two instruments over the loaded data: ES on the same 1-second times with some missing (and some of its own where
# the main one has none), YM as 30-second bars; prices follow the main one, with noise
MAKE_XS = """() => {
  const T = window.__tapeTest, D = T.D, n = D.n, F = Float64Array, G = Float32Array;
  let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const a = { t: [], o: [], h: [], l: [], c: [], v: [] };
  for (let i = 0; i < n; i++) {
    if (i % 9 === 4) continue;
    const t = D.t[i], k = 0.7 + 0.01 * Math.sin(t / 5000), w = rnd() * 0.5;
    a.t.push(t); a.o.push(D.o[i] * k); a.h.push(D.h[i] * k + w); a.l.push(D.l[i] * k - w); a.c.push(D.c[i] * k); a.v.push(D.v[i] + 1);
    if (i + 1 < n && D.t[i + 1] - t > 2 && i % 5 === 0) { const p = D.c[i] * k; a.t.push(t + 1); a.o.push(p); a.h.push(p + 0.25); a.l.push(p - 0.25); a.c.push(p); a.v.push(3); }
  }
  const b = { t: [], o: [], h: [], l: [], c: [], v: [] };
  for (let i = 0; i < n; i++) {
    const t = Math.floor(D.t[i] / 30) * 30, j = b.t.length - 1, p = 40000 - D.c[i] * 3;
    if (j >= 0 && b.t[j] === t) { b.h[j] = Math.max(b.h[j], p + 1); b.l[j] = Math.min(b.l[j], p - 1); b.c[j] = p; b.v[j] += D.v[i]; }
    else { b.t.push(t); b.o.push(p); b.h.push(p + 1); b.l.push(p - 1); b.c.push(p); b.v.push(D.v[i]); }
  }
  const mk = (s, base) => ({ n: s.t.length, t: F.from(s.t), o: G.from(s.o), h: G.from(s.h), l: G.from(s.l), c: G.from(s.c), v: G.from(s.v), base, prec: 2, hasVol: true });
  T.XS = [{ key: 'x1', dsId: 'es', name: 'ES synthetic, 1s', sym: 'ES', d: mk(a, 1) }, { key: 'x2', dsId: 'ym', name: 'YM synthetic, 30s', sym: 'YM', d: mk(b, 30) }];
  return [T.XS[0].d.n, T.XS[1].d.n, n];
}"""

# independent of the page's xsApi: candles of the bars with t >= t0 and t + base <= tc, by floor(t / tfs) * tfs
AGG_JS = """([key, t0, tc, tfs]) => {
  const x = window.__tapeTest.XS.find(y => y.key === key).d, out = [];
  for (let i = 0; i < x.n; i++) {
    const t = x.t[i]; if (t < t0 || t + x.base > tc) continue;
    const b = Math.floor(t / tfs) * tfs, r = out[out.length - 1];
    if (r && r[0] === b) { r[2] = Math.max(r[2], x.h[i]); r[3] = Math.min(r[3], x.l[i]); r[4] = x.c[i]; r[5] += x.v[i]; }
    else out.push([b, x.o[i], x.h[i], x.l[i], x.c[i], x.v[i]]);
  }
  return [out.length, out.length ? out[out.length - 1] : null, out.reduce((s, r) => s + r[4], 0), out.reduce((s, r) => s + r[5], 0)];
}"""

STRAT_JS = """# logs what other() gives, and trades on it (so the optimizer's results show what its workers saw)
import json
STOP = 30          # ticks
def init(ctx):
    ctx.log, ctx.first = [], None
    print("OTHERS", ctx.others())
def on_bar(ctx, bar):
    if ctx.first is None:
        ctx.first = float(ctx.times()[0])
    es, ym = ctx.other("ES"), ctx.other("ym")
    for o in (es, ym):
        if len(o):
            assert o.times()[-1] <= bar.time.timestamp(), "a candle after this one"
    if bar.index % 37 == 0:
        ctx.log.append([ctx._tc, bar.time.timestamp()] + [[len(o), o.times()[-1] if len(o) else None, o.opens()[-1] if len(o) else None, o.highs()[-1] if len(o) else None,
                        o.lows()[-1] if len(o) else None, o.closes()[-1] if len(o) else None, o.volumes()[-1] if len(o) else None,
                        float(o.closes().sum()), float(o.volumes().sum())] for o in (es, ym)])
    c = es.closes(3)
    if len(c) == 3 and not ctx.orders:
        if c[-1] > c[-2] > c[-3] and ctx.position <= 0:
            ctx.close(); ctx.buy(sl=ctx.round(bar.close - ctx.ticks(STOP)), tp=ctx.round(bar.close + ctx.ticks(STOP)))
        elif c[-1] < c[-2] < c[-3] and ctx.position >= 0:
            ctx.close(); ctx.sell(sl=ctx.round(bar.close + ctx.ticks(STOP)), tp=ctx.round(bar.close - ctx.ticks(STOP)))
def on_end(ctx):
    print("DIGEST " + json.dumps({"first": ctx.first, "log": ctx.log}))
"""

IND_JS = """import json

def on_bar(ctx, bar):
    es = ctx.other("ES")
    ctx.plot(es.price if es.time == bar.time else None, "ES", pane="lower")
    if len(es):
        assert es.times()[-1] <= bar.time.timestamp(), "a candle after this one"
    if bar.index % 97 == 0 or bar.index == 1:
        print("IND " + json.dumps([ctx._tc, ctx._tfs, float(ctx.times()[0]), len(es), float(es.times()[-1]) if len(es) else None, float(es.closes().sum()), float(es.volumes().sum())]))
"""


async def set_code(pg, sel, code):
    await pg.evaluate("([s, c]) => { const t = document.querySelector(s); t.value = c; t.dispatchEvent(new Event('input')); }", [sel, code])


async def run_strat(pg, code, name, tf="1m"):
    if await pg.is_hidden("#strat"):
        await pg.click("#bStrat")
    await pg.click("#stTabs [data-st=code]")
    await pg.fill("#stName", name)
    await set_code(pg, "#stSrc", code)
    await pg.select_option("#stTf", tf)
    await pg.evaluate("() => { const f = document.querySelector('#stFrom'), t = document.querySelector('#stTo'); const d = new Date(f.value); d.setDate(d.getDate() + 2); t.value = d.toISOString().slice(0, 10); }")
    await pg.click("#stRun")
    await pg.wait_for_function("() => !document.querySelector('#stRun').disabled && /Done|Ended|Stopped|error|Fix/.test(document.querySelector('#stStat').textContent)", timeout=600000)
    await pg.wait_for_timeout(300)
    return await pg.evaluate("() => [...document.querySelector('#stCons').children].map(d => d.textContent).join('\\n')")


def close(a, b, tol=1e-6):
    return (a is None and b is None) or (a is not None and b is not None and abs(a - b) <= tol * max(1.0, abs(a), abs(b)))


async def check_digest(pg, out, tfs):
    m = re.search(r"^DIGEST (.*)$", out, re.M)
    check(m, out[-2000:])
    dg = json.loads(m.group(1))
    check(len(dg["log"]) > 20, f"{len(dg['log'])} samples")
    full = 0
    for tc, bt, *per in dg["log"]:
        for key, p in zip(("x1", "x2"), per):
            n, last, s_c, s_v = await pg.evaluate(AGG_JS, [key, dg["first"], tc, tfs])
            check(p[0] == n and n > 0, f"{key} at {tc}: {p[0]} candles vs {n}")
            check(all(close(a, b) for a, b in zip(p[1:7], last)), f"{key} at {tc}: last candle {p[1:7]} vs {last}")
            check(close(p[7], s_c, 1e-9) and close(p[8], s_v, 1e-9), f"{key} at {tc}: sums {p[7:9]} vs {s_c, s_v}")
            check(p[1] <= bt, "no candle after this one")
            if tc == bt + tfs:
                full += 1
                check(p[1] + tfs <= tc, f"{key}: candle {p[1]} + tf after the close {tc}")
    check(full >= 10, f"{full} samples on whole candles")
    return dg


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={"width": 1500, "height": 950}, color_scheme="dark")

        async def page_with_probe(route):
            r = await route.fetch()
            body = await r.text()
            check(body.count(HOOK) == 1, "the XS line is in the page")
            await route.fulfill(response=r, body=body.replace(HOOK, PROBE + HOOK))
        await ctx.route(re.compile(r".*/index\.html(\?.*)?$"), page_with_probe)
        pg = await ctx.new_page()
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        await pg.goto(URL)
        await pg.wait_for_selector("#home:not([hidden])", timeout=30000)
        check(await pg.evaluate("crossOriginIsolated"), "isolated: the workers share memory")
        await pg.click("#hNew")
        await pg.wait_for_selector("#modal:not([hidden])", timeout=30000)
        await pg.click("#mStart")
        await pg.wait_for_function("() => document.querySelector('#modal').hidden && document.querySelector('#clock').textContent !== '—'", timeout=120000)
        await pg.wait_for_timeout(1300)
        await pg.evaluate("document.querySelector('.tour [data-t=skip]')?.click()")
        sizes = await pg.evaluate(MAKE_XS)
        check(sizes[0] > 1000 and sizes[1] > 100, sizes)

        # (a, b) a backtest: only finished candles, the same as an independent aggregation
        out = await run_strat(pg, STRAT_JS, "Others test")
        check("OTHERS ['ES', 'YM']" in out, out[:500])
        check("rror" not in out.split("DIGEST")[0], out[-1500:])
        await check_digest(pg, out, 60)
        kpi = await pg.inner_text("#stKpi")
        trades = int(re.search(r"Trades\s+(\d+)", kpi).group(1))
        check(trades > 5, f"{trades} trades on the other's candles")
        # on 5-minute candles too
        out5 = await run_strat(pg, STRAT_JS, "Others test 5m", "5m")
        await check_digest(pg, out5, 300)
        # an unknown symbol stops the run with the list of what is loaded
        out = await run_strat(pg, "def on_bar(ctx, bar):\n    ctx.other('NQ')\n", "Others unknown")
        check('No other instrument "NQ" in this session. Loaded with it: ES, YM.' in out, out[-800:])

        # the indicator: catches up on the chart's candles, then follows the replay
        await pg.click("#stClose")
        await pg.click("#bInd")
        await pg.click("[data-pnew]")
        await pg.wait_for_selector("#pind:not([hidden])")
        await pg.fill("#piName", "Others ind")
        await set_code(pg, "#piSrc", IND_JS)
        await pg.click("#piRun")
        await pg.wait_for_function("() => !document.querySelector('#piRun').disabled && !/^(Loading|Checking|Running)/.test(document.querySelector('#piStat').textContent)", timeout=180000)
        await pg.wait_for_timeout(500)
        cons = await pg.evaluate("() => [...document.querySelector('#piCons').children].map(d => d.textContent).join('\\n')")
        check("stopped" not in cons and "Error" not in cons, cons[-1500:])
        lines = [json.loads(x) for x in re.findall(r"^IND (.*)$", cons, re.M)]
        check(len(lines) > 3, cons[-800:])
        check(all(x[1] <= 3600 for x in lines), "an intraday chart (a plain floor buckets it)")
        for tc, tfs, first, n, last, s_c, s_v in lines:
            wn, wl, wc, wv = await pg.evaluate(AGG_JS, ["x1", first, tc, tfs])
            check(n == wn and close(last, wl[0] if wl else None) and close(s_c, wc, 1e-9) and close(s_v, wv, 1e-9), f"indicator at {tc}: {n, last} vs {wn, wl}")
        await pg.click("#piClose")

        # (c) the optimizer: the workers get the other instruments (only the run's dates) and see the same candles
        if await pg.is_hidden("#strat"):
            await pg.click("#bStrat")
        await pg.click("#stTabs [data-st=code]")
        await pg.fill("#stName", "Others opt")
        await set_code(pg, "#stSrc", STRAT_JS)
        await pg.select_option("#stTf", "1m")
        await pg.evaluate("() => { const f = document.querySelector('#stFrom'), t = document.querySelector('#stTo'); const d = new Date(f.value); d.setDate(d.getDate() + 2); t.value = d.toISOString().slice(0, 10); }")
        await pg.click("#stTabs [data-st=opt]")
        await pg.wait_for_selector("#optRows tr[data-n=STOP]", timeout=120000)
        row = pg.locator("#optRows tr[data-n=STOP]")
        if not await row.locator("[data-on]").is_checked():
            await row.locator("[data-on]").click()
        await row.locator("[data-v]").fill("20, 30")
        await pg.select_option("#optSplit", "0")
        await pg.click("#optRun")
        await pg.wait_for_function("() => !document.querySelector('#optRun').disabled && /done|Stopped/i.test(document.querySelector('#stStat').textContent)", timeout=600000)
        await pg.wait_for_timeout(300)
        check(not await pg.locator("#optBody td.err").count(), await pg.inner_text("#optBody"))
        rows = pg.locator("#optBody tr[data-i]")
        check(await rows.count() == 2, "two combinations")
        money = lambda s: float(s.replace("−", "-").replace("+", "").replace("$", "").replace(",", ""))
        opt = {}
        for k in range(2):
            cells = await rows.nth(k).locator("td").all_inner_texts()
            opt[cells[1].strip()] = (int(cells[3]), money(cells[4]))
        check(opt.get("30", (0,))[0] == trades, f"optimizer STOP=30: {opt} vs the backtest's {trades} trades")
        # the optimizer's worker sees what the chart run sees: open one of its rows on the chart
        first = rows.first
        cells = await first.locator("td").all_inner_texts()
        await first.locator("button[data-chart]").click()
        await pg.wait_for_function("() => !document.querySelector('#stRun').disabled && /Done|Ended|Stopped/.test(document.querySelector('#stStat').textContent)", timeout=300000)
        await pg.wait_for_timeout(300)
        kpi = await pg.inner_text("#stKpi")
        check(int(re.search(r"Trades\s+(\d+)", kpi).group(1)) == int(cells[3]), f"chart {kpi} vs optimizer {cells}")
        check(abs(money(re.search(r"Net P&L\s+(\S+)", kpi).group(1)) - money(cells[4])) < 0.02, f"net: {kpi} vs {cells}")
        await pg.screenshot(path=f"{OUT}/others-opt.png")

        # (d) no other instruments: others() is [], other() is empty, nothing fails
        await pg.evaluate("() => { window.__tapeTest.XS = []; }")
        out = await run_strat(pg, "def on_bar(ctx, bar):\n    if bar.index == 3:\n        print('NONE', ctx.others(), len(ctx.other('ES')), len(ctx.other().closes(5)), ctx.other(0).time)\n", "Others none")
        check("NONE [] 0 0 None" in out and "rror" not in out, out[-800:])
        out = await run_strat(pg, STRAT_JS, "Others none 2")
        check("OTHERS []" in out and "DIGEST" in out and "rror" not in out, out[-800:])
        check(not errors, errors)
        await b.close()
    print(f"others: {passed} checks passed")


asyncio.run(main())
