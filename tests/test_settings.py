"""Settings in the new app (app/index.html), in Chromium: the time zone moves the clock, a light theme changes the page
and the chart, "Match my system" follows the system as it changes, "?" opens the shortcuts, the credit line shows,
and everything is still set after a reload. Build the page first (desktop/web), then:
    python tests/test_settings.py [folder for screenshots]
"""
import asyncio
import functools
import http.server
import os
import re
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


CLOCK = "() => document.querySelector('.rbar .lbl .num').textContent"
BODY_BG = "() => getComputedStyle(document.body).backgroundColor"
# the chart's background: the color most of a row of pixels near the top of the first chart has
CHART_BG = """() => { const cv = [...document.querySelectorAll('.pane .lw canvas')].find(c => c.width > 200 && c.height > 200);
  const x = cv.getContext('2d'), n = {}; for (let i = 0; i < 40; i++) { const d = x.getImageData(Math.round(cv.width * (0.2 + i * 0.012)), Math.round(cv.height * 0.45), 1, 1).data; const k = d[0] + ',' + d[1] + ',' + d[2]; n[k] = (n[k] || 0) + 1; }
  return Object.entries(n).sort((a, b) => b[1] - a[1])[0][0]; }"""


def hour(clock):
    return int(re.search(r"(\d\d):\d\d:\d\d", clock).group(1))


async def settings(pg):
    await pg.click(".nav .item:has-text('Settings')")
    await pg.wait_for_selector(".settings")


async def replay(pg):
    await pg.click(".nav .item:has-text('Replay')")
    await pg.wait_for_selector(".pane .lw canvas")
    await pg.wait_for_timeout(300)


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={"width": 1440, "height": 950}, color_scheme="dark")
        pg = await ctx.new_page()
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        await pg.goto(serve())
        await pg.wait_for_selector(".page-foot .credit")
        credit = await pg.locator(".page-foot .credit").inner_text()
        check(credit == "Charts by TradingView Lightweight Charts™, © TradingView, Inc.", f"the chart credit on New session: {credit}")
        check(await pg.locator(".page-foot .credit a[href='https://www.tradingview.com/']").count() == 1, "the credit links to TradingView")
        check(await pg.evaluate(BODY_BG) == "rgb(11, 14, 19)", "a dark system starts with the app's own dark theme")
        await pg.click("button:has-text('Start with these now')")
        await pg.wait_for_selector(".pane .lw canvas", timeout=30000)
        tip = pg.locator(".tip .acts button:nth-child(2)")
        if await tip.count():
            await tip.click()

        # time zone: UTC, then Tokyo (nine hours ahead, no daylight saving) moves the clock by nine hours
        await settings(pg)
        await pg.select_option("select[aria-label='Time zone']", "UTC")
        await replay(pg)
        c0 = await pg.evaluate(CLOCK)
        check("UTC" in await pg.locator(".rbar .lbl .num .muted").inner_text(), "the clock says UTC")
        await settings(pg)
        await pg.select_option("select[aria-label='Time zone']", "Asia/Tokyo")
        await replay(pg)
        c1 = await pg.evaluate(CLOCK)
        check(c1 != c0 and (hour(c1) - hour(c0)) % 24 == 9, f"Tokyo time is nine hours on: {c0} -> {c1}")
        check(await pg.locator(".rbar .lbl .num .muted").inner_text() != "UTC", "the clock names the new zone")
        dark_chart = await pg.evaluate(CHART_BG)
        check(dark_chart == "16,19,26", f"the dark chart background: {dark_chart}")

        # a light theme: the page and the chart
        await settings(pg)
        await pg.click(".palcard:has(b:text-is('Paper'))")
        check(await pg.evaluate(BODY_BG) == "rgb(238, 241, 245)", "Paper makes the page light")
        check(await pg.locator(".palcard[aria-checked='true']").inner_text() != "", "the chosen theme is marked")
        await pg.screenshot(path=f"{OUT}/settings-1-paper.png", full_page=True)
        await replay(pg)
        check(await pg.evaluate(CHART_BG) == "255,255,255", "Paper makes the chart white")
        await pg.screenshot(path=f"{OUT}/settings-2-chart-paper.png")

        # Match my system follows the system while the chart is open
        await settings(pg)
        await pg.click(".palcard:has(b:text-is('Match my system'))")
        await replay(pg)
        check(await pg.evaluate(CHART_BG) == "16,19,26", "Match my system on a dark system: the dark chart")
        await pg.emulate_media(color_scheme="light")
        await pg.wait_for_timeout(300)
        check(await pg.evaluate(CHART_BG) == "255,255,255", "the system turned light: the open chart turned light")
        check(await pg.evaluate(BODY_BG) == "rgb(238, 241, 245)", "and the page too")
        await pg.emulate_media(color_scheme="dark")
        await pg.wait_for_timeout(300)
        check(await pg.evaluate(CHART_BG) == "16,19,26", "and back to dark")

        # "?" opens the shortcuts anywhere; Esc closes them
        await pg.click(".pane .lw")
        await pg.keyboard.press("Shift+Slash")
        await pg.wait_for_selector(".modal.keysheet")
        text = await pg.locator(".modal.keysheet").inner_text()
        check("Keyboard shortcuts" in text and "Play or pause the replay" in text and "Trend line" in text, "the sheet lists replay and drawing keys")
        check("TradingView" in text, "with the credit")
        await pg.screenshot(path=f"{OUT}/settings-3-keys.png")
        await pg.keyboard.press("Escape")
        await pg.wait_for_timeout(100)
        check(await pg.locator(".modal.keysheet").count() == 0, "Esc closes the sheet")

        # replay settings, then Paper again, then a reload keeps them all
        await settings(pg)
        await pg.click(".palcard:has(b:text-is('Paper'))")
        await pg.select_option("select[aria-label='Candle colors']", label="Blue and orange (color-blind friendly)")
        await pg.fill("input[aria-label='Ticks per bar']", "40")
        await pg.keyboard.press("Enter")
        await pg.click("text=Pause the replay when an order fills")
        await pg.select_option("select[aria-label='Trading day starts at']", "17")
        check(await pg.locator(".settings a:has-text('Open the classic view')").count() == 1, "About links to the classic view")
        check(await pg.locator("#sAbout ~ .credit a[href='https://www.tradingview.com/'], .sgroup .credit a[href='https://www.tradingview.com/']").count() >= 1, "About has the credit")
        await pg.wait_for_timeout(900)  # saved after a moment
        await pg.reload()
        await pg.wait_for_selector(".page-foot .credit")
        check(await pg.evaluate(BODY_BG) == "rgb(238, 241, 245)", "Paper is still on after a reload")
        await settings(pg)
        check(await pg.locator("select[aria-label='Time zone']").input_value() == "Asia/Tokyo", "the time zone is kept")
        check(await pg.locator("select[aria-label='Trading day starts at']").input_value() == "17", "the trading day start is kept")
        check(await pg.locator("input[aria-label='Ticks per bar']").input_value() == "40", "ticks per bar is kept")
        check(await pg.locator("label:has-text('Pause the replay when an order fills') input").is_checked(), "pause on fill is kept")
        check(await pg.locator("select[aria-label='Candle colors']").input_value() == "0", "the candle colors are kept")
        await pg.screenshot(path=f"{OUT}/settings-4-reloaded.png", full_page=True)
        # the reopened session plays on Tokyo time with the blue and orange candles
        await pg.click(".nav .logo")
        await pg.click(".resume button:has-text('Continue')", timeout=15000)
        await pg.wait_for_selector(".pane .lw canvas", timeout=30000)
        await pg.wait_for_timeout(300)
        check(await pg.evaluate(CLOCK) == c1, f"the reopened session's clock is on Tokyo time: {await pg.evaluate(CLOCK)}")
        await pg.screenshot(path=f"{OUT}/settings-5-reopened.png")
        check(not errors, f"no page errors: {errors}")
        await b.close()
    print(f"settings: {passed} checks passed; screenshots in {OUT}")


asyncio.run(main())
