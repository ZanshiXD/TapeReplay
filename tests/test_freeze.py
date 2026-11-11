"""The replay never freezes: the clock and the chart keep moving while the tape plays, at every speed, on a slow
computer and on a phone, with trades, drawings, price zones and a Python indicator on the chart and the session saving
itself; after the page is frozen and woken (as iOS does to an app in the background); and when something drawing the
chart fails once. Build the page first (desktop/web), then:
    python tests/test_freeze.py [folder for screenshots] [--soak]
--soak plays much longer at each speed (a few minutes in all) instead of the short CI run.
"""
import asyncio
import functools
import http.server
import json
import os
import sys
import tempfile
import threading

from playwright.async_api import async_playwright

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
SOAK = "--soak" in sys.argv
OUT = ARGS[0] if ARGS else tempfile.mkdtemp(prefix="tape-shots-")
os.makedirs(OUT, exist_ok=True)
SHIM = open(os.path.join(ROOT, "ios", "Sources", "TapeReplay", "ios-shim.js")).read()
passed = 0


def check(cond, msg):
    global passed
    if not cond:
        raise AssertionError(msg)
    passed += 1


def serve():
    class H(http.server.SimpleHTTPRequestHandler):
        extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, ".wasm": "application/wasm", ".mjs": "text/javascript"}

        def log_message(self, *a):
            pass
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(H, directory=os.path.join(ROOT, "desktop", "web")))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{srv.server_address[1]}/index.html"


# In the page: every 250 ms the clock's text, whether the tape plays, and the chart's last candle time; long tasks.
PROBE = """(() => {
  const W = window.__probe = { samples: [], long: [], t0: performance.now() };
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) W.long.push([Math.round(e.startTime), Math.round(e.duration)]); }).observe({ type: 'longtask', buffered: true }); } catch (e) {}
  setInterval(() => {
    const c = document.querySelector('.mclock .num, .rbar .lbl .num');
    const p = document.querySelector('.rbar .play');
    W.samples.push([Math.round(performance.now()), c ? c.textContent : '', p ? p.getAttribute('aria-label') === 'Pause' : false]);
  }, 250);
})()"""


def stalls(samples, since=0, limit_ms=1200):
    """stretches while playing that the clock didn't move (or the page didn't run) for longer than limit_ms"""
    out, last_t, last_c, run_from = [], None, None, None
    for t, c, playing in samples:
        if t < since:
            continue
        if last_t is not None and t - last_t > limit_ms:
            out.append(("page blocked", last_t, t - last_t))
        if playing:
            if c != last_c:
                run_from = t
            elif run_from is not None and t - run_from > limit_ms:
                out.append(("clock stuck", run_from, t - run_from))
                run_from = t
        else:
            run_from = None
        last_t, last_c = t, c
    return out


async def setup(pg, phone):
    """a practice session with zones, a Python indicator, a drawing and a trade"""
    if phone:
        await pg.tap(".wizacts .mstart")
    else:
        await pg.click(".summary button:has-text('Start with these now')")
    await pg.wait_for_selector(".pane .lw canvas", timeout=30000)
    tip = pg.locator(".tip .acts button:nth-child(2)")
    if await tip.count():
        await tip.first.click()
    act = pg.tap if phone else pg.click
    # price zones and an RSI in Python
    await act(".mctx [aria-label='Indicators']" if phone else "button:has-text('Indicators')")
    await act("button:has-text('Price zones')")
    await act("button:has-text('+ New Python indicator')")
    await act(".pytpl[role=listitem]:has-text('RSI')")
    await act(".pyed button:has-text('Add to chart')")
    await pg.wait_for_function("() => !document.querySelector('.pyed') || /On the chart/.test(document.querySelector('.pyed').textContent)", timeout=60000)
    await act(".pyed [aria-label='Close']")
    if await pg.locator(".pop[aria-label='Indicators'] [aria-label='Close']").count():
        await act(".pop[aria-label='Indicators'] [aria-label='Close']")
    # a horizontal line
    box = await pg.locator(".pane .lw").first.bounding_box()
    if not phone:
        await pg.keyboard.press("Alt+h")
        await pg.mouse.click(box["x"] + 200, box["y"] + box["height"] / 2)
        await pg.keyboard.press("Escape")
    await pg.evaluate(PROBE)


async def play_speeds(pg, phone, speeds, secs):
    """plays at each speed for secs seconds, buying and selling now and then; returns when each speed started"""
    marks = []
    for sp in speeds:
        if phone:
            await pg.tap(".mrbar button[aria-label='Speed']")
            if sp in ("1×", "10×", "60×", "300×", "1000×"):
                await pg.tap(f".speedpop button:has-text('{sp}')")
            else:
                await pg.locator(".speedpop input[type=range]").fill(sp)
                await pg.touchscreen.tap(195, 30)
        else:
            if sp in ("1×", "10×", "60×", "300×", "1000×"):
                await pg.click(f".rbar .chips button:has-text('{sp}')")
            else:
                await pg.click(".rbar [aria-label='Custom speed']")
                await pg.locator(".speedpop input[type=range]").fill(sp)
                await pg.mouse.click(5, 5)
        t = await pg.evaluate("performance.now()")
        marks.append((sp, t))
        if not await pg.locator(".rbar .play[aria-label='Pause']").count():
            await (pg.tap if phone else pg.click)(".rbar .play")
        for k in range(int(secs)):
            await pg.wait_for_timeout(1000)
            if k % 3 == 1:
                await (pg.tap(".onetap .buy") if phone else pg.keyboard.press("b"))
            elif k % 3 == 2:
                await (pg.tap(".onetap .sell") if phone else pg.keyboard.press("s"))
            if not await pg.locator(".rbar .play[aria-label='Pause']").count():  # an order filled and paused it, or a toast
                await (pg.tap if phone else pg.click)(".rbar .play")
    return marks


async def run(p, url, label, phone):
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
    await setup(pg, phone)
    await cdp.send("Emulation.setCPUThrottlingRate", {"rate": 4})
    secs = 25 if SOAK else 5
    marks = await play_speeds(pg, phone, ["60×", "300×", "1000×", "1000"], secs)  # the last: the slider's top (an hour a second)
    W = json.loads(await pg.evaluate("JSON.stringify(window.__probe)"))
    st = stalls(W["samples"])
    longest = max([d for _, d in W["long"]] or [0])
    print(f"{label}: {len(W['samples'])} samples, {len(st)} stalls {st[:4]}, long tasks {len(W['long'])} (longest {longest} ms)")
    await pg.screenshot(path=f"{OUT}/freeze-{label}-1.png")
    check(not st, f"{label}: the clock keeps moving at every speed: {st[:4]}")
    check(longest < 1000, f"{label}: no task blocks the page for a second ({longest} ms)")
    # frozen and woken, as iOS does in the background: playing again within a moment, no backlog
    t_wake = await pg.evaluate("performance.now()")
    await cdp.send("Page.setWebLifecycleState", {"state": "frozen"})
    await asyncio.sleep(3)
    await cdp.send("Page.setWebLifecycleState", {"state": "active"})
    await pg.wait_for_timeout(3000)
    W = json.loads(await pg.evaluate("JSON.stringify(window.__probe)"))
    after = [s for s in W["samples"] if s[0] > t_wake + 3500]
    check(len({c for _, c, _ in after}) > 2 and all(pl for _, _, pl in after), f"{label}: plays on after being frozen and woken ({after[-3:]})")
    longest = max([d for t, d in W["long"] if t > t_wake] or [0])
    check(longest < 1000, f"{label}: waking doesn't replay a backlog in one go ({longest} ms)")
    # something drawing the chart fails once: the replay carries on
    t_err = await pg.evaluate("""() => { const f = CanvasRenderingContext2D.prototype.fillText; let n = 0;
      CanvasRenderingContext2D.prototype.fillText = function (...a) { if (++n === 40) throw new Error('canvas failed once'); return f.apply(this, a); };
      return performance.now(); }""")
    await pg.wait_for_timeout(4000)
    W = json.loads(await pg.evaluate("JSON.stringify(window.__probe)"))
    st = stalls(W["samples"], since=t_err)
    check(not st, f"{label}: an error drawing the chart doesn't stop the replay: {st[:3]}")
    errors[:] = [e for e in errors if "canvas failed once" not in e]
    await cdp.send("Emulation.setCPUThrottlingRate", {"rate": 1})
    await pg.screenshot(path=f"{OUT}/freeze-{label}-2.png")
    check(not errors, f"{label}: no page errors: {errors[:5]}")
    await b.close()


async def main():
    url = serve()
    async with async_playwright() as p:
        if os.environ.get("ONLY") != "phone":
            await run(p, url, "desktop", False)
        await run(p, url, "phone", True)
    print(f"freeze: {passed} checks passed; screenshots in {OUT}")


asyncio.run(main())
