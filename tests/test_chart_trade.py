"""Trading on the chart in the new app (app/index.html), in Chromium: right-click for an order at a price, the order's
tag and its × to cancel, a position's TP handle dragged out onto the chart, the stop typed into the positions table,
then the Performance tab (stats, equity curve) and Copy trades. Build the page first (desktop/web), then:
    python tests/test_chart_trade.py [folder for screenshots]
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
    class H(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a):
            pass
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(H, directory=os.path.join(ROOT, "desktop", "web")))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{srv.server_address[1]}/index.html"


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={"width": 1440, "height": 900}, color_scheme="dark", permissions=["clipboard-read", "clipboard-write"])
        pg = await ctx.new_page()
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        await pg.goto(serve())
        await pg.click(".summary button:has-text('Start with these now')")
        await pg.wait_for_selector(".pane .lw canvas", timeout=30000)
        await pg.click(".tip .acts button:nth-child(2)")
        for _ in range(10):
            await pg.keyboard.press("Shift+ArrowRight")
        box = await pg.locator(".pane .lw").bounding_box()
        # right-click above the price: a sell limit there, with its tag on the chart
        await pg.mouse.click(box["x"] + 400, box["y"] + 120, button="right")
        await pg.click(".chartmenu button:has-text('Sell limit')")
        check(await pg.locator(".ttag.order").count() == 1, "the order has a tag on the chart")
        check(await pg.locator(".dock .tabs button:has-text('Orders (1)')").count() == 1, "the order is listed")
        await pg.click(".ttag.order .tx")
        check(await pg.locator(".ttag.order").count() == 0, "× on the tag canceled it")
        # a market buy with no stop or target, then a target dragged out of its tag
        await pg.fill(".field:has-text('Stop loss') input", "0")
        await pg.fill(".field:has-text('Take profit') input", "0")
        await pg.click("button:has-text('Contracts')")
        await pg.click(".qbtn.buy")
        await pg.wait_for_selector(".ttag.long")
        tp = pg.locator(".ttag.long .th.tp")
        tb = await tp.bounding_box()
        await pg.mouse.move(tb["x"] + 8, tb["y"] + 8)
        await pg.mouse.down()
        await pg.mouse.move(tb["x"] + 8, tb["y"] - 60, steps=5)
        await pg.screenshot(path=f"{OUT}/ct-1-drag.png")
        await pg.mouse.up()
        check(await pg.locator(".ttag.small.tp").count() == 1, "the take profit was dragged out of the tag")
        # a stop typed in the positions table
        entry = float(await pg.locator(".dock tbody tr td:nth-child(4)").inner_text())
        await pg.fill("input[aria-label='Stop loss price']", f"{entry - 10:.2f}")
        await pg.keyboard.press("Enter")
        check(await pg.locator(".ttag.small.sl").count() == 1, "the stop typed in the table is on the chart")
        await pg.screenshot(path=f"{OUT}/ct-2-tags.png")
        # close it, then the Performance tab
        await pg.click(".ttag.long .tx")
        await pg.click(".dock .tabs button:has-text('Performance')")
        check(await pg.locator(".perf .sgrid > div").count() >= 15, "the Performance tab lists the stats")
        check(await pg.locator(".perf .eqchart canvas").count() >= 1, "and the equity curve")
        await pg.click("button:has-text('Copy trades (CSV)')")
        clip = await pg.evaluate("() => navigator.clipboard.readText()")
        check(clip.startswith("id,side,size,entry_time") and len(clip.splitlines()) == 2, f"the trades are copied as CSV: {clip[:80]}")
        await pg.screenshot(path=f"{OUT}/ct-3-perf.png")
        check(not errors, f"no page errors: {errors}")
        await b.close()
    print(f"chart trade: {passed} checks passed; screenshots in {OUT}")


asyncio.run(main())
