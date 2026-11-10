"""The new app (app/index.html) in Chromium: a two-market session, smooth playback, trading both markets, the journal,
stepping back and jumping. Build the page first (see test_browser.py), then:
    python tests/test_next.py [folder for screenshots]
"""
import asyncio
import functools
import http.server
import os
import sys
import tempfile
import threading

from playwright.async_api import async_playwright

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
OUT = sys.argv[1] if len(sys.argv) > 1 else tempfile.mkdtemp(prefix="tape-shots-")
os.makedirs(OUT, exist_ok=True)
passed = 0


def check(cond, msg):
    global passed
    if not cond:
        raise AssertionError(msg)
    passed += 1


def serve():
    web = os.path.join(ROOT, "desktop", "web")
    h = functools.partial(http.server.SimpleHTTPRequestHandler, directory=web)
    h.extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, ".wasm": "application/wasm", ".mjs": "text/javascript"}
    h.log_message = lambda *a: None
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), h)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{srv.server_address[1]}/index.html"


URL = serve()
CLOCK = "() => document.querySelector('.rbar .lbl .num').textContent"


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={"width": 1440, "height": 900}, color_scheme="dark")
        pg = await ctx.new_page()
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        await pg.goto(URL)
        await pg.click("text=Both, side by side")
        await pg.click("button:has-text('Start with these now')")
        await pg.wait_for_selector(".pane .lw canvas", timeout=30000)
        check(await pg.locator(".pane").count() == 2, "two charts side by side")
        check(await pg.locator(".tip").count() == 1, "the first-time tip shows")
        c0 = await pg.evaluate(CLOCK)
        await pg.click(".tip .acts button:first-child")  # Play
        await pg.wait_for_timeout(1500)
        c1 = await pg.evaluate(CLOCK)
        check(c1 != c0, f"the clock runs: {c0} -> {c1}")
        await pg.click(".chips button:has-text('300×')")
        perf = await pg.evaluate("""() => new Promise(r => { let n = 0, t0 = performance.now(), worst = 0, last = t0;
            const f = now => { n++; worst = Math.max(worst, now - last); last = now; if (now - t0 < 2000) requestAnimationFrame(f); else r({ fps: n / ((now - t0) / 1000), worst }); };
            requestAnimationFrame(f); })""")
        print("playback:", perf)
        check(perf["fps"] > 50, f"smooth playback at 300x: {perf}")
        # trade both markets at real-time speed: buy NQ (the active chart), then sell ES from its chart
        await pg.click(".chips button:has-text('1×')")
        await pg.click(".qbtn.buy")
        await pg.wait_for_timeout(200)
        await pg.click(".pane:nth-child(2) .legend >> xpath=..")
        await pg.click("button:has-text('Risk %')")
        await pg.fill("input[aria-label='Size']", "1")
        await pg.click(".qbtn.sell")
        await pg.wait_for_timeout(300)
        rows = await pg.locator(".dock tbody tr").count()
        check(rows >= 1, f"positions listed ({rows})")
        await pg.screenshot(path=f"{OUT}/next-1-trading.png")
        # play until the trades close by their stops or targets
        await pg.click(".chips button:has-text('300×')")
        for _ in range(40):
            if await pg.locator(".dock tbody tr").count() == 0:
                break
            await pg.wait_for_timeout(500)
        await pg.keyboard.press("Space")
        jn = await pg.evaluate("() => [...document.querySelectorAll('.dock .tabs button')].find(b => b.textContent.startsWith('Journal')).textContent")
        check("Journal (" in jn and not jn.endswith("(0)"), f"closed trades went to the journal: {jn}")
        await pg.click("button.item:has-text('Journal')")
        await pg.wait_for_selector(".snap svg")
        check(await pg.locator(".snap").count() == 2, "the journal entry has both markets' snapshots")
        await pg.click(".card .seg button:has-text('Followed my plan')")
        await pg.fill("input[placeholder^='+ Tag']", "SMT")
        await pg.keyboard.press("Enter")
        check(await pg.locator(".pill:has-text('SMT')").count() == 1, "a tag added")
        await pg.screenshot(path=f"{OUT}/next-2-journal.png")
        # back to the chart: step back, then jump ahead an hour
        await pg.click("button.item:has-text('Replay')")
        before = await pg.evaluate(CLOCK)
        await pg.click("button[aria-label='Back one candle']")
        after = await pg.evaluate(CLOCK)
        check(after != before, f"step back moves the clock: {before} -> {after}")
        await pg.click("button:has-text('Jump to')")
        await pg.click(".pop.menu button:has-text('1 hour')")
        await pg.wait_for_function("() => !document.querySelector('.busy')", timeout=30000)
        later = await pg.evaluate(CLOCK)
        check(later != after, f"jumped ahead: {after} -> {later}")
        # one chart, then indicators: add an SMA and take it off again
        await pg.click("button[aria-label='One chart']")
        check(await pg.locator(".pane").count() == 1, "one chart")
        await pg.click("button:has-text('Indicators')")
        await pg.click("text=+ Simple moving average (SMA)")
        check(await pg.locator(".legend .inds span:has-text('SMA 50')").count() == 1, "SMA added to the chart")
        await pg.click("button[aria-label='Remove SMA 50']")
        check(await pg.locator(".legend .inds span:has-text('SMA 50')").count() == 0, "SMA taken off")
        await pg.screenshot(path=f"{OUT}/next-3-one.png")
        check(not errors, f"no page errors: {errors}")
        await b.close()
    print(f"next: {passed} checks passed; screenshots in {OUT}")


asyncio.run(main())
