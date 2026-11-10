"""The new app on a phone (app/index.html), in Chromium emulating an iPhone 13 with the iOS app's shim: the chart's own
header and its sheets (timeframe, chart options, indicators), the replay bar docked under the chart, the one-tap
Buy / Sell row, a tap outside a sheet closing only the sheet, drawing from the header, positions as cards, the
new-session buttons in reach; then landscape, and an iPad. Build the page first (desktop/web), then:
    python tests/test_mobile.py [folder for screenshots]
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
SHIM = open(os.path.join(ROOT, "ios", "Sources", "TapeReplay", "ios-shim.js")).read()
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


async def box(pg, sel):
    return await pg.locator(sel).first.bounding_box()


async def no_sideways_scroll(pg):
    return await pg.evaluate("() => document.documentElement.scrollWidth <= innerWidth + 1")


PAGE = None


async def phone(p, url):
    global PAGE
    b = await p.chromium.launch()
    ctx = await b.new_context(**p.devices["iPhone 13"])
    await ctx.add_init_script(SHIM)
    pg = PAGE = await ctx.new_page()
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.set_default_timeout(20000)
    await pg.goto(url)
    # the new-session buttons are on screen without scrolling
    acts = await box(pg, ".wizacts")
    check(acts and acts["y"] + acts["height"] <= 844 - 50, f"the wizard's buttons are in reach: {acts}")
    check(await pg.locator(".wizacts .mstart").is_visible(), "and Start now is one of them")
    await pg.tap(".wizacts .mstart")
    await pg.wait_for_selector(".pane .lw canvas", timeout=30000)
    tip = pg.locator(".tip .acts button:nth-child(2)")
    if await tip.count():
        await pg.tap(".tip .acts button:nth-child(2)")
    await pg.screenshot(path=f"{OUT}/m-1-chart.png")
    # the layout: the phone header, the chart, the one-tap row, the replay bar, the tab bar; nothing on top of another
    check(await pg.locator(".mctx").is_visible() and await pg.locator("header.ctx:not(.mctx)").count() == 0, "the phone's chart header")
    check(await no_sideways_scroll(pg), "nothing scrolls sideways")
    lw, tap, bar, nav = await box(pg, ".pane .lw"), await box(pg, ".onetap"), await box(pg, ".mrbar"), await box(pg, ".mnav")
    check(lw["y"] + lw["height"] <= tap["y"] + 1, f"the one-tap row is under the chart, not over it: {lw} {tap}")
    check(tap["y"] + tap["height"] <= bar["y"] + 1, "the replay bar is under the one-tap row")
    check(bar["y"] + bar["height"] <= nav["y"] + 1, "and above the tab bar")
    check(tap["width"] >= 380 and bar["width"] >= 380, "both span the screen")
    check(lw["height"] >= 380, f"the chart keeps most of the screen: {lw['height']}")
    # the timeframe sheet
    await pg.tap(".mctx [aria-label='Timeframe']")
    await pg.tap(".pop.menu button:has-text('15m')")
    check((await pg.locator(".mctx .tfbtn").inner_text()).strip().startswith("15m"), "15m picked from the sheet")
    check(await pg.locator(".pop").count() == 0, "the sheet closed")
    # a tap outside a sheet closes it, and doesn't also press what was under it
    await pg.tap(".mctx [aria-label='Timeframe']")
    ind = await box(pg, ".mctx [aria-label='Indicators']")
    await pg.touchscreen.tap(ind["x"] + 20, ind["y"] + 20)  # the Indicators button, under the dimmed screen
    await pg.wait_for_timeout(250)
    check(await pg.locator(".pop").count() == 0, "a tap outside closed the timeframe sheet")
    check(await pg.locator(".pop[aria-label='Indicators']").count() == 0, "and did not also open the indicators")
    check((await pg.locator(".mctx .tfbtn").inner_text()).strip().startswith("15m"), "nor change the timeframe")
    await pg.tap(".mctx [aria-label='Indicators']")
    check(await pg.locator(".pop[aria-label='Indicators']").is_visible(), "the indicators sheet")
    await pg.touchscreen.tap(200, 120)
    await pg.wait_for_timeout(250)
    check(await pg.locator(".pop[aria-label='Indicators']").count() == 0, "a tap outside closed the indicators")
    # chart options: the layout and another market
    await pg.tap(".mctx [aria-label='Chart options']")
    check(await pg.locator(".pop.menu button:has-text('Practice S&P 500')").count() == 1, "another market can be added from the options")
    await pg.tap(".pop.menu button:has-text('Practice S&P 500')")
    await pg.wait_for_function("() => document.querySelectorAll('.pane .lw').length === 2", timeout=30000)
    p1, p2 = await box(pg, ".pane >> nth=0"), await box(pg, ".pane >> nth=1")
    check(p2["y"] >= p1["y"] + p1["height"] - 1 and p2["width"] >= 380, "the two charts are one above the other")
    await pg.screenshot(path=f"{OUT}/m-2-two.png")
    await pg.tap(".mctx [aria-label='Chart options']")
    await pg.tap(".pop.menu button:has-text('One chart')")
    await pg.wait_for_function("() => document.querySelectorAll('.pane .lw').length === 1")
    # speed and jumps from the replay bar's sheets
    await pg.tap(".mrbar button[aria-label='Speed']")
    await pg.tap(".speedpop button:has-text('300×')")
    check((await pg.locator(".mrbar button[aria-label='Speed']").inner_text()).strip() == "300×", "the speed is 300×")
    check(await pg.locator(".speedpop").count() == 0, "and the sheet closed")
    clock = await pg.locator(".mclock .num").inner_text()
    await pg.tap(".mrbar button:has-text('Jump')")
    await pg.tap(".pop.menu button:has-text('1 hour')")
    await pg.wait_for_function(f"() => document.querySelector('.mclock .num').textContent !== {clock!r}", timeout=30000)
    check(True, "Jump to moved the clock")
    # play and pause
    await pg.tap(".mrbar .play")
    await pg.wait_for_timeout(800)
    await pg.tap(".mrbar .play")
    check(await pg.locator(".mrbar .play[aria-label='Play']").count() == 1, "played and paused")
    # trade from the one-tap row, then the position as a card
    await pg.tap(".onetap .buy")
    await pg.wait_for_selector(".ttag.long")
    await pg.tap(".mnav button:has-text('Positions')")
    card = pg.locator(".dock table.cards tbody tr").first
    check(await card.is_visible(), "the position is a card")
    sl = await box(pg, "input[aria-label='Stop loss price']")
    check(sl["width"] >= 120, f"its stop box is wide enough to read: {sl['width']}")
    check(await no_sideways_scroll(pg), "the positions don't scroll sideways")
    await pg.screenshot(path=f"{OUT}/m-3-positions.png")
    await pg.tap(".dock table.cards button:has-text('Close')")
    check(await pg.locator(".dock table.cards tbody tr").count() == 0, "closed from the card")
    # drawing: the header's pencil opens one sheet of named tools; picking one closes it and says how, with Cancel
    await pg.tap(".mnav button:has-text('Chart')")
    check(await pg.locator(".drawrail").count() == 0, "no drawing rail down the side on a phone")
    await pg.tap(".mctx [aria-label='Drawing tools']")
    sheet = await box(pg, ".dsheet")
    check(sheet and sheet["width"] >= 380, "the drawing tools are a sheet across the screen")
    await pg.tap(".dsheet .dtabs button:has-text('Lines')")
    tile = await box(pg, ".dsheet .dtile:has-text('Trend line')")
    check(tile["width"] >= 70 and tile["height"] >= 70, f"tools are big named tiles: {tile}")
    await pg.tap(".dsheet .dtile:has-text('Trend line')")
    await pg.wait_for_selector(".dsheet", state="detached", timeout=5000)
    check(True, "picking a tool closed the sheet")
    check(await pg.locator(".drawhint button:has-text('Cancel')").is_visible(), "the hint has Cancel (no Esc key on a phone)")
    lw = await box(pg, ".pane .lw")
    await pg.touchscreen.tap(lw["x"] + 80, lw["y"] + 200)
    await pg.touchscreen.tap(lw["x"] + 250, lw["y"] + 140)
    await pg.wait_for_timeout(200)
    check(await pg.evaluate("() => document.querySelectorAll('.drawhint').length") == 0, "two taps drew it")
    await pg.screenshot(path=f"{OUT}/m-4-drawn.png")
    await pg.tap(".mctx [aria-label='Drawing tools']")
    check(await pg.locator(".dsheet .dsw:has-text('List (1)')").count() == 1, "one drawing")
    check(await pg.locator(".dsheet .dtabs button.on:has-text('Lines')").count() == 1, "the sheet opens on the last tab")
    await pg.tap(".dsheet .dtabs button:has-text('Recent')")
    check((await pg.locator(".dsheet .dtile").first.inner_text()).strip() == "Trend line", "the trend line is first in Recent")
    await pg.tap(".dsheet .dsw:has-text('List')")
    check(await pg.locator(".otree .orow").count() == 1, "the list of drawings, as a sheet")
    await pg.touchscreen.tap(195, 30)
    await pg.wait_for_timeout(250)
    check(await pg.locator(".otree").count() == 0, "a tap outside closed the list")
    await pg.tap(".mctx [aria-label='Drawing tools']")
    await pg.tap(".dsheet .dsw:has-text('Remove')")
    await pg.tap(".dsheet .dsure button:has-text('Remove')")
    check(await pg.locator(".dsheet .dsw:has-text('List (0)')").count() == 1, "removed from the sheet")
    await pg.tap(".dsheet button[aria-label='Undo']")
    check(await pg.locator(".dsheet .dsw:has-text('List (1)')").count() == 1, "and back with Undo")
    await pg.tap(".dsheet button[aria-label='Close']")
    # every sheet closes with a tap outside it, without pressing what is under the dimmed part
    for name, opener in (("timeframe", ".mctx [aria-label='Timeframe']"), ("options", ".mctx [aria-label='Chart options']"),
                         ("indicators", ".mctx [aria-label='Indicators']"), ("drawing", ".mctx [aria-label='Drawing tools']"),
                         ("speed", ".mrbar button[aria-label='Speed']"), ("jump", ".mrbar button:has-text('Jump')"), ("more", ".mnav button:has-text('More')")):
        await pg.tap(opener)
        await pg.wait_for_timeout(200)
        check(await pg.locator(".pop").count() >= 1, f"the {name} sheet opened")
        await pg.touchscreen.tap(195, 30)
        await pg.wait_for_timeout(250)
        check(await pg.locator(".pop").count() == 0, f"a tap outside closed the {name} sheet")
    # the pages: nothing on them is wider than the screen
    SIDEWAYS = """() => [...document.querySelectorAll('.page, .page *')].filter(el => { const cs = getComputedStyle(el);
      return cs.display !== 'none' && /auto|scroll/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 1 && !el.matches('textarea, .tabs, .dtabs, .steps') }).map(el => el.className)"""
    for page in ("Library", "Backtest", "Settings", "New session"):
        await pg.tap(".mnav button:has-text('More')")
        await pg.tap(f".msheet button:has-text('{page}')")
        await pg.wait_for_timeout(300)
        bad = await pg.evaluate(SIDEWAYS)
        check(not bad and await no_sideways_scroll(pg), f"{page}: nothing moves sideways: {bad}")
        if page == "Backtest":
            for tab in ("Run", "Optimize", "Robustness", "Strategies"):
                await pg.tap(f".bt-head .tabs button:has-text('{tab}')")
                bad = await pg.evaluate(SIDEWAYS)
                check(not bad, f"Backtest {tab}: nothing moves sideways: {bad}")
            await pg.tap(".bt-head .tabs button:has-text('Optimize')")
            cb = await box(pg, "input[aria-label='Try FAST']")
            check(cb and cb["height"] > 0 and await pg.locator(".bt-ptable").evaluate("e => e.getBoundingClientRect().height") > 60, "the optimizer's settings are there to tick")
    await pg.tap(".mnav button:has-text('Journal')")
    bad = await pg.evaluate(SIDEWAYS)
    check(not bad, f"Journal: nothing moves sideways: {bad}")
    await pg.tap(".jlist button >> nth=0")
    check(await pg.locator(".jlist").is_hidden() and await pg.locator(".jback").is_visible(), "the journal shows one trade, with a way back")
    check(not await pg.evaluate(SIDEWAYS), "a journal entry doesn't move sideways")
    await pg.tap(".jback")
    check(await pg.locator(".jlist").is_visible(), "back to the list")
    await pg.tap(".mnav button:has-text('Chart')")
    # landscape: still everything on screen
    await pg.set_viewport_size({"width": 844, "height": 390})
    await pg.wait_for_timeout(300)
    check(await no_sideways_scroll(pg), "landscape: nothing scrolls sideways")
    lw, bar, nav = await box(pg, ".pane .lw"), await box(pg, ".mrbar"), await box(pg, ".mnav")
    check(lw["height"] >= 180 and bar["y"] + bar["height"] <= nav["y"] + 1, f"landscape: the chart and the bar fit: {lw} {bar}")
    await pg.screenshot(path=f"{OUT}/m-5-landscape.png")
    check(not errors, f"phone: no page errors: {errors}")
    await b.close()


async def ipad(p, url):
    b = await p.chromium.launch()
    ctx = await b.new_context(**p.devices["iPad Pro 11 landscape"])
    await ctx.add_init_script(SHIM)
    pg = await ctx.new_page()
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    await pg.goto(url)
    await pg.tap(".summary button:has-text('Start with these now')")
    await pg.wait_for_selector(".pane .lw canvas", timeout=30000)
    check(await pg.locator(".mctx").count() == 0 and await pg.locator(".nav").is_visible(), "iPad: the full layout")
    check(await no_sideways_scroll(pg), "iPad: nothing scrolls sideways")
    await pg.screenshot(path=f"{OUT}/m-6-ipad.png")
    check(not errors, f"iPad: no page errors: {errors}")
    await b.close()


async def main():
    url = serve()
    async with async_playwright() as p:
        try:
            await phone(p, url)
        except Exception:
            await PAGE.screenshot(path=f"{OUT}/m-failed.png")
            raise
        await ipad(p, url)
    print(f"mobile: {passed} checks passed; screenshots in {OUT}")


asyncio.run(main())
