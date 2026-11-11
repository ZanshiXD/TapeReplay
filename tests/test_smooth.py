"""How smoothly the replay plays: on a heavy session (30+ closed trades, open positions with a stop and a target, about
20 drawings, EMA, VWAP, price zones, session lines, a JavaScript and a Python indicator), on a computer and a phone,
with the CPU slowed down (as on a slower Windows laptop or an older iPhone), at 1x, 10x, 60x and 300x.

For each run it records, while the tape plays:
  - how often the price moves (changes a second, and the longest wait between two moves)
  - the gaps between animation frames (frames a second, p50/p95/p99/max, how many over 50 and 100 ms)
  - long tasks (and with --profile, which code the time went to, from the CDP profiler)
  - the clock: whether it ever goes back, how long it stands still on screen, how far behind the speed it plays
  - the candle countdown against the clock shown beside it (the clock plus the countdown is the candle's close)

Builds its own test copy of the page (vite build --mode test). Then:
    python tests/test_smooth.py [folder for results] [--long] [--profile] [--trace] [--no-check]
The short run (CI) plays a few scenarios for a few seconds each; --long plays the whole set: NQ practice and a 1-minute
CSV with gaps, 1m and 5m charts, CPU 4x and 6x slower, all four speeds, on a computer and a phone.
TAPE_SKIP_BUILD=1 uses the last build; TAPE_WEB=folder plays another build (to compare before and after).
"""
import asyncio
import functools
import http.server
import json
import math
import os
import random
import re
import shutil
import subprocess
import sys
import tempfile
import threading

from playwright.async_api import async_playwright

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
APP = os.path.join(ROOT, "app")
ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
LONG = "--long" in sys.argv
PROFILE = "--profile" in sys.argv
TRACE = "--trace" in sys.argv
CHECK = "--no-check" not in sys.argv
OUT = ARGS[0] if ARGS else tempfile.mkdtemp(prefix="tape-smooth-")
os.makedirs(OUT, exist_ok=True)
SHIM = open(os.path.join(ROOT, "ios", "Sources", "TapeReplay", "ios-shim.js")).read()
N = "window.__next"
passed = 0
failures = []


def check(cond, msg):
    global passed
    if not cond:
        failures.append(msg)
        print("  FAIL:", msg)
    else:
        passed += 1


def build():
    if os.environ.get("TAPE_WEB"):  # a copy built before, to compare with
        return os.environ["TAPE_WEB"]
    if os.environ.get("TAPE_SKIP_BUILD") != "1":
        subprocess.check_call([shutil.which("npm") or "npm", "run", "build", "--", "--mode", "test", "--outDir", "dist-test", "--logLevel", "warn"], cwd=APP)
    return os.path.join(APP, "dist-test")


def serve(web):
    class H(http.server.SimpleHTTPRequestHandler):
        extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, ".wasm": "application/wasm", ".mjs": "text/javascript"}

        def log_message(self, *a):
            pass
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(H, directory=web))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{srv.server_address[1]}/index.html"


def make_csv():
    """15 weekdays of 1-minute E-mini bars with gaps: the overnight hour closed, and minutes and short stretches missing"""
    path = os.path.join(tempfile.mkdtemp(), "ESZ6_gaps_1m.csv")
    rnd = random.Random(7)
    t0 = 1775001600  # 2026-04-01 00:00 UTC (a Wednesday)
    lines, p, day, days = ["time,open,high,low,close,volume"], 6500.0, 0, 0
    while days < 15:
        d0 = t0 + day * 86400
        day += 1
        if (3 + day - 1) % 7 in (6, 0):  # weekends
            continue
        days += 1
        i = 0
        while i < 1440:
            t = d0 + i * 60
            h = i // 60
            if h == 21:  # the daily close
                i += 60
                continue
            r = rnd.random()
            if r < 0.08:  # a missing minute
                i += 1
                continue
            if r < 0.09:  # a quiet stretch
                i += rnd.randint(3, 20)
                continue
            o = p
            p = round((p + rnd.gauss(0, 1.6)) * 4) / 4
            hi, lo = max(o, p) + rnd.randint(0, 3) * .25, min(o, p) - rnd.randint(0, 3) * .25
            lines.append(f"{t},{o:.2f},{hi:.2f},{lo:.2f},{p:.2f},{50 + rnd.randint(0, 400)}")
            i += 1
    with open(path, "w") as f:
        f.write("\n".join(lines))
    return path


# In the page: on every animation frame the clock (the session's), the active market's price and whether it plays;
# ten times a second the clock and the candle countdown as shown; long tasks. W.on starts and stops a recording, and
# W.keep plays on again if a fill paused the tape.
PROBE = f"""(() => {{
  const s = {N}.session;
  const W = window.__sm = {{ on: false, keep: false, fr: [], dom: [], long: [] }};
  try {{ new PerformanceObserver(l => {{ for (const e of l.getEntries()) if (W.on) W.long.push([Math.round(e.startTime), Math.round(e.duration)]); }}).observe({{ type: 'longtask' }}); }} catch (e) {{}}
  const loop = t => {{ requestAnimationFrame(loop); if (W.on) {{ const nt = Math.min(...s.feeds.map(f => f.nextTickTime())); W.fr.push([t, s.now, s.activeFeed.price, s.playing ? 1 : 0, isFinite(nt) ? Math.max(0, s.now - nt) : 0]); }} }};
  requestAnimationFrame(loop);
  setInterval(() => {{
    if (!W.on) return;
    const c = document.querySelector('.mclock .num, .rbar .lbl .num');
    const k = [...document.querySelectorAll('[title="Time left in this candle"]')].map(e => e.textContent).find(x => /^\\d+:\\d\\d(:\\d\\d)?$/.test(x || ''));
    W.dom.push([performance.now(), c ? c.textContent : '', k || '', s.playing ? 1 : 0]);
  }}, 100);
  setInterval(() => {{ if (W.keep && !s.playing && !s.atEnd) s.play(); }}, 200);
}})()"""


async def heavy_session(pg, phone):
    """30+ closed trades, two open positions with a stop and a target, ~20 drawings, zones, session lines, JS + Python RSI"""
    act = pg.tap if phone else pg.click
    tip = pg.locator(".tip .acts button:nth-child(2)")
    if await tip.count():
        await tip.first.click()
    # trades: in and out a few bars apart
    await pg.evaluate(f"""() => {{
      const s = {N}.session; s.account.pauseOnFill = false;
      for (let k = 0; k < 34; k++) {{
        const side = k % 2 ? -1 : 1;
        s.order(side, 'market', 0, null, null, 1); s.stepBar(); s.stepBar();
        s.order(-side, 'market', 0, null, null, 1); s.stepBar();
      }}
      for (let k = 0; k < 40; k++) s.stepBar();
      const p = s.activeFeed.price, w = Math.max(40 * s.activeFeed.s.inst.tick, p * 0.02);
      s.order(1, 'market', 0, p - w, p + w, 1);
      s.order(1, 'limit', p - w / 2, p - w, p + w / 3, 1);
      s.changed();
    }}""")
    # indicators: price zones, session lines, an RSI in JavaScript and one in Python
    await act(".mctx [aria-label='Indicators']" if phone else "button:has-text('Indicators')")
    await act("text=+ Price zones (FVG, order blocks)")
    await act("text=+ Session lines")
    for lang in ("JavaScript", "Python"):
        await act("button:has-text('+ New indicator')")
        await act(f"[aria-label='{lang} templates'] button:has-text('RSI')")
        await act(".pyed button:has-text('Add to chart')")
        await pg.wait_for_function("() => !document.querySelector('.pyed') || /On the chart/.test(document.querySelector('.pyed').textContent)", timeout=90000)
        if await pg.locator(".pyed [aria-label='Close']").count():
            await act(".pyed [aria-label='Close']")
    if await pg.locator(".pop[aria-label='Indicators'] [aria-label='Close']").count():
        await act(".pop[aria-label='Indicators'] [aria-label='Close']")
    # about 20 drawings around the price
    await pg.evaluate(f"""() => {{
      const s = {N}.session, f = s.activeFeed, now = s.now, p = f.price, tk = f.s.inst.tick * 40;
      const kinds = ['trend', 'hline', 'rect', 'fib', 'ray', 'text'].filter(id => {N}.tools.some(t => t.id === id));
      const n = id => ({N}.tools.find(t => t.id === id) || {{ n: 2 }}).n;
      for (let k = 0; k < 20; k++) {{
        const id = kinds[k % kinds.length], pts = [];
        for (let j = 0; j < Math.max(1, n(id)); j++) pts.push({{ t: now - 3600 * (1 + k % 5) + j * 1200, p: p + (k - 10) * tk / 4 + j * tk }});
        s.drawings.add({{ tool: id, sym: s.active, pts, style: {N}.styleFor(id) }});
      }}
    }}""")


def pct(xs, q):
    if not xs:
        return 0
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(q * (len(xs) - 1) + 0.5))]


def secs_of(text):
    m = re.search(r"(\d{1,2}):(\d\d):(\d\d)", text or "")
    return int(m[1]) * 3600 + int(m[2]) * 60 + int(m[3]) if m else None


def cd_secs(text):
    parts = [int(x) for x in (text or "").split(":") if x.isdigit()]
    if len(parts) == 2:
        return parts[0] * 60 + parts[1]
    if len(parts) == 3:
        return parts[0] * 3600 + parts[1] * 60 + parts[2]
    return None


def analyse(W, speed, tf):
    fr = W["fr"]
    gaps, moves, last_move, longest_wait = [], 0, None, 0
    adv, wall, back, still, still_from = 0.0, 0.0, 0, 0, None
    for a, b in zip(fr, fr[1:]):
        if not (a[3] and b[3]):
            last_move, still_from = None, None
            continue
        if last_move is None:
            last_move = a[0]  # the wait for the first move counts too
        dt = b[0] - a[0]
        gaps.append(dt)
        dn = b[1] - a[1]
        if dn < -1e-6:
            back += 1
        if dn < 600:  # not a jump over a closed market
            adv += dn
            wall += dt / 1000
        if dn <= 1e-9:
            still_from = still_from if still_from is not None else a[0]
            still = max(still, b[0] - still_from)
        else:
            still_from = None
        if b[2] != a[2]:
            moves += 1
            longest_wait = max(longest_wait, b[0] - last_move)
            last_move = b[0]
        else:
            longest_wait = max(longest_wait, b[0] - last_move)
    play_s = sum(gaps) / 1000 or 1e-9
    lag = max([x[4] for x in fr if x[3]] or [0])  # how far the ticks played trail the clock (replay seconds)
    # what the screen showed: the clock standing still, going back, and the countdown against it
    dom = [d for d in W["dom"] if d[3]]
    shown_still, shown_back, cd_err, since, prev = 0, 0, [], None, None
    for t, c, k, _ in dom:
        cs = secs_of(c)
        if cs is None:
            continue
        if prev is not None:
            if cs != prev[1]:
                d = (cs - prev[1]) % 86400
                if d > 43200:
                    shown_back += 1
                since = t
            elif since is not None:
                shown_still = max(shown_still, t - since)
        else:
            since = t
        prev = (t, cs)
        ks = cd_secs(k)
        if ks is not None:
            e = (cs + ks) % tf
            cd_err.append(e - tf if e > tf / 2 else e)
    return {
        "fps": round(len(gaps) / play_s, 1),
        "gap_p50": round(pct(gaps, .5), 1), "gap_p95": round(pct(gaps, .95), 1), "gap_p99": round(pct(gaps, .99), 1), "gap_max": round(max(gaps or [0])),
        "gaps_50": sum(g > 50 for g in gaps), "gaps_100": sum(g > 100 for g in gaps),
        "moves_s": round(moves / play_s, 1), "move_wait_max": round(longest_wait),
        "pace": round(adv / max(1e-9, wall * speed), 2), "tape_lag": round(lag, 1), "tape_lag_wall": round(lag / speed, 2), "clock_back": back, "clock_still_max": round(still),
        "shown_still_max": round(shown_still), "shown_back": shown_back,
        "cd_err_max": max([abs(e) for e in cd_err] or [0]), "cd_err_mean": round(sum(cd_err) / len(cd_err), 1) if cd_err else None,
        "long": len(W["long"]), "long_max": max([d for _, d in W["long"]] or [0]), "long_total": sum(d for _, d in W["long"]),
        "play_s": round(play_s, 1),
    }


def profile_top(prof, k=14):
    """self time by function (and by where it lives) from a CDP profile"""
    nodes = {n["id"]: n for n in prof["nodes"]}
    dts = prof.get("timeDeltas") or []
    self_t = {}
    for sid, dt in zip(prof.get("samples") or [], dts):
        n = nodes.get(sid)
        if n:
            self_t[sid] = self_t.get(sid, 0) + dt
    by_fn, by_src = {}, {}
    total = sum(self_t.values()) or 1
    for sid, t in self_t.items():
        cf = nodes[sid]["callFrame"]
        url = cf.get("url", "").rsplit("/", 1)[-1]
        name = f"{cf.get('functionName') or '(anon)'} {url}:{cf.get('lineNumber', 0) + 1}:{cf.get('columnNumber', 0) + 1}" if url else cf.get("functionName") or "(native)"
        by_fn[name] = by_fn.get(name, 0) + t
        src = url or cf.get("functionName") or "?"
        by_src[src] = by_src.get(src, 0) + t
    top = sorted(by_fn.items(), key=lambda x: -x[1])[:k]
    srcs = sorted(by_src.items(), key=lambda x: -x[1])[:8]
    return {"total_ms": round(total / 1000), "top": [(n, round(t / 1000), round(100 * t / total, 1)) for n, t in top], "by_source": [(n, round(100 * t / total, 1)) for n, t in srcs]}


def trace_top(evs, k=14):
    """time on the page's main thread by kind of work (the outermost events of each kind), from a CDP trace"""
    main = None
    for e in evs:
        if e.get("name") == "thread_name" and e.get("args", {}).get("name") == "CrRendererMain":
            main = (e["pid"], e["tid"])
    tot = {}
    for e in evs:
        if e.get("ph") != "X" or (e["pid"], e["tid"]) != main or "dur" not in e:
            continue
        tot[e["name"]] = tot.get(e["name"], 0) + e["dur"] / 1000
    return [(n, round(t)) for n, t in sorted(tot.items(), key=lambda x: -x[1])[:k]]


async def run_device(p, url, phone, data, plan, results, csv):
    label = ("phone" if phone else "desktop") + "-" + data
    b = await p.chromium.launch()
    ctx = await b.new_context(**p.devices["iPhone 13"]) if phone else await b.new_context(viewport={"width": 1440, "height": 900}, color_scheme="dark")
    if phone:
        await ctx.add_init_script(SHIM)
    pg = await ctx.new_page()
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.on("console", lambda m: errors.append(m.text) if m.type == "error" and "Failed to load resource" not in m.text else None)
    pg.set_default_timeout(30000)
    cdp = await ctx.new_cdp_session(pg)
    await pg.goto(url)
    if data == "csv":  # added in the Library (on a computer)
        await pg.click("button.item:has-text('Library')")
        await pg.click(".tabs button:has-text('Data files')")
        await pg.set_input_files("input[type=file]", csv)
        await pg.wait_for_selector(".librow", timeout=30000)
        await pg.click("button:has-text('New session with it')")
        await pg.wait_for_selector(".dsitem.on")
    if phone:
        await pg.tap(".wizacts .mstart")
    else:
        await pg.click("button:has-text('Start with these now')")
    await pg.wait_for_selector(".pane .lw canvas", timeout=30000)
    await pg.wait_for_function(f"() => !!{N}", timeout=30000)
    await heavy_session(pg, phone)
    await pg.evaluate(PROBE)
    if not phone:
        await pg.mouse.move(720, 2)  # off the chart, so the legend shows the live candle
    print(f"{label}: set up ({await pg.evaluate(f'() => {N}.session.account.hist.length')} closed trades, "
          f"{await pg.evaluate(f'() => {N}.session.drawings.items.length')} drawings)")
    await pg.screenshot(path=f"{OUT}/smooth-{label}-setup.png")
    # what a save writes out, and how long turning it into text takes (CPU slowed as in the runs)
    await cdp.send("Emulation.setCPUThrottlingRate", {"rate": plan[0][1]})
    sz = await pg.evaluate(f"""() => {{ const s = {N}.session, t = performance.now(); const j = JSON.stringify(s.state(false)); const d = performance.now() - t;
      return [j.length, Math.round(d), JSON.stringify(s.journal).length]; }}""")
    await cdp.send("Emulation.setCPUThrottlingRate", {"rate": 1})
    print(f"  a save: {sz[0] // 1024} KB ({sz[2] // 1024} KB of it the journal), {sz[1]} ms to write out at cpu {plan[0][1]}x")
    for tf, rate, speeds, secs in plan:
        await pg.evaluate(f"() => {{ const s = {N}.session; s.pause(); s.setTf({{ kind: 's', sec: {tf} }}); }}")
        await cdp.send("Emulation.setCPUThrottlingRate", {"rate": rate})
        for sp in speeds:
            await pg.evaluate(f"() => {{ const s = {N}.session; s.speed = {sp}; s.changed(); __sm.keep = true; s.play(); }}")
            await pg.wait_for_timeout(1200)  # settle at the new speed
            prof = None
            if PROFILE:
                await cdp.send("Profiler.enable")
                await cdp.send("Profiler.setSamplingInterval", {"interval": 500})
                await cdp.send("Profiler.start")
            if TRACE:
                trace_ev = []
                cdp.on("Tracing.dataCollected", lambda e: trace_ev.extend(e["value"]))
                done = asyncio.get_event_loop().create_future()
                cdp.on("Tracing.tracingComplete", lambda e: done.done() or done.set_result(1))
                await cdp.send("Tracing.start", {"categories": "devtools.timeline,blink,v8.execute", "transferMode": "ReportEvents"})
            await pg.evaluate("() => { __sm.fr = []; __sm.dom = []; __sm.long = []; __sm.on = true; }")
            await pg.wait_for_timeout(int(secs * 1000))
            await pg.evaluate("() => { __sm.on = false; }")
            if PROFILE:
                prof = profile_top((await cdp.send("Profiler.stop"))["profile"])
                await cdp.send("Profiler.disable")
            if TRACE:
                await cdp.send("Tracing.end")
                await asyncio.wait_for(done, 30)
                prof = prof or {}
                prof["trace"] = trace_top(trace_ev)
                with open(os.path.join(OUT, f"trace-{label}-{tf}-{rate}-{sp}.json"), "w") as tf_:
                    json.dump(trace_ev, tf_)
            W = json.loads(await pg.evaluate("() => JSON.stringify(__sm)"))
            r = analyse(W, sp, tf)
            name = f"{label} {tf // 60}m cpu{rate}x {sp}x"
            r["name"] = name
            if prof:
                r["profile"] = prof
            results.append(r)
            print(f"  {name:32} fps {r['fps']:5} gaps p50/p95/p99/max {r['gap_p50']}/{r['gap_p95']}/{r['gap_p99']}/{r['gap_max']} >100ms {r['gaps_100']:3} | "
                  f"moves/s {r['moves_s']:5} wait max {r['move_wait_max']:5} | pace {r['pace']:4} lag {r['tape_lag']}s back {r['clock_back']} still {r['clock_still_max']:4} "
                  f"shown still {r['shown_still_max']:4} | countdown err max {r['cd_err_max']} mean {r['cd_err_mean']} | long {r['long']} max {r['long_max']} total {r['long_total']}")
            if prof and "by_source" in prof:
                print("    by source:", prof["by_source"])
                for fn, ms, pc in prof["top"][:10]:
                    print(f"      {pc:5}% {ms:6} ms  {fn}")
            if prof and "trace" in prof:
                print("    main thread (ms):", prof["trace"])
            await pg.evaluate(f"() => {{ __sm.keep = false; {N}.session.pause(); }}")
            if await pg.evaluate(f"() => {N}.session.atEnd"):
                print("  (the data ran out)")
                break
    await cdp.send("Emulation.setCPUThrottlingRate", {"rate": 1})
    await pg.screenshot(path=f"{OUT}/smooth-{label}-end.png")
    errors = [e for e in errors if "canvas failed once" not in e]
    check(not errors, f"{label}: no page errors: {errors[:5]}")
    await b.close()


def judge(results):
    """what smooth means, on a computer slowed 4x and a phone slowed 6x"""
    for r in results:
        n, sp = r["name"], int(r["name"].split()[-1][:-1])
        if r["play_s"] < 1:
            continue
        check(r["clock_back"] == 0 and r["shown_back"] == 0, f"{n}: the clock never goes back ({r['clock_back']}, shown {r['shown_back']})")
        check(r["cd_err_max"] <= 1, f"{n}: the candle countdown agrees with the clock ({r['cd_err_max']} s)")
        check(r["shown_still_max"] <= (1700 if sp == 1 else 900), f"{n}: the clock on screen doesn't stand still ({r['shown_still_max']} ms)")
        check(r["long_max"] < 500, f"{n}: no task blocks the page for half a second ({r['long_max']} ms)")
        if sp == 1 and " 1m " in n:
            check(r["move_wait_max"] <= 800, f"{n}: at 1x on a 1-minute chart the price moves at least every 0.8 s ({r['move_wait_max']} ms)")
        check(r["pace"] >= (0.9 if sp <= 60 else 0.5), f"{n}: the replay keeps its speed ({r['pace']})")
        check(r["tape_lag_wall"] <= 1.5, f"{n}: the prices keep up with the clock ({r['tape_lag']} s of replay behind)")


async def main():
    url = serve(build())
    csv = make_csv()
    results = []
    sp_all = [1, 10, 60, 300]
    async with async_playwright() as p:
        if LONG:
            for data in ("nq", "csv"):
                plan = [(tf, rate, sp_all, 8) for tf in (60, 300) for rate in (4, 6)]
                await run_device(p, url, False, data, plan, results, csv)
            await run_device(p, url, True, "nq", [(tf, rate, sp_all, 8) for tf in (60, 300) for rate in (4, 6)], results, csv)
        else:
            if os.environ.get("ONLY") == "desktop":
                await run_device(p, url, False, "nq", [(60, 4, sp_all, 4)], results, csv)
            elif os.environ.get("ONLY") != "phone":
                await run_device(p, url, False, "nq", [(60, 4, sp_all, 4)], results, csv)
                await run_device(p, url, False, "csv", [(60, 4, [1, 60], 4)], results, csv)
            if os.environ.get("ONLY") != "desktop":
                await run_device(p, url, True, "nq", [(60, 6, [1, 60], 4)], results, csv)
    with open(os.path.join(OUT, "smooth.json"), "w") as f:
        json.dump(results, f, indent=1)
    if CHECK:
        judge(results)
    print(f"smooth: {passed} checks passed, {len(failures)} failed; results in {OUT}/smooth.json")
    if CHECK and failures:
        sys.exit(1)


asyncio.run(main())
