"""The in-app guide (app/index.html), in Chromium: the Guide page from the sidebar with every chapter, the contents
jumping to a section, the search, the guide opened over the Python indicator editor (and Esc closing only the guide),
from the Backtest code panel and from Settings, a Copy button on every code block; then on a phone (iPhone 13 with the
iOS app's shim): More > Guide, the Contents sheet, and nothing in the guide moving sideways. Build the page first
(desktop/web), then:
    python tests/test_guide.py [folder for screenshots]
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
CHAPTERS = ["Getting started", "Trading", "Drawing, indicators and the journal", "Your sessions and data", "Python indicators", "Strategies and backtesting", "More"]


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


# where a section's heading sits from the top of the guide's scrolling part (0 = at the top)
AT = """(id) => { const b = document.querySelector('.guide .gbody'), el = b.querySelector(`[data-sec="${id}"]`);
  return el.getBoundingClientRect().top - b.getBoundingClientRect().top }"""
SHOWN = "() => [...document.querySelectorAll('.guide [data-sec]')].filter(e => !e.hidden).map(e => e.dataset.sec)"
SIDEWAYS = """() => [...document.querySelectorAll('.guide, .guide *')].filter(e => { const cs = getComputedStyle(e);
  return /auto|scroll/.test(cs.overflowX) && e.scrollWidth > e.clientWidth + 1 }).map(e => e.className)"""


async def desktop(p, url):
    b = await p.chromium.launch()
    pg = await (await b.new_context(viewport={"width": 1440, "height": 900}, color_scheme="dark", permissions=["clipboard-read", "clipboard-write"])).new_page()
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    await pg.goto(url)
    # the Guide page, from the sidebar
    await pg.click("nav.nav button.item:has-text('Guide')")
    await pg.wait_for_selector(".guide .gbody")
    heads = await pg.locator(".guide .gchap h2").all_inner_texts()
    check(heads == CHAPTERS, f"every chapter: {heads}")
    n = await pg.locator(".guide [data-sec]").count()
    check(n >= 30 and await pg.locator(".gtoc button").count() == n, f"{n} sections, each in the contents")
    blocks = await pg.locator(".guide .gcode").count()
    check(blocks >= 10 and await pg.locator(".guide .gcode > .btn:has-text('Copy')").count() == blocks, f"a Copy button on each of the {blocks} code blocks")
    await pg.locator(".guide .gcode > .btn").first.click()
    check((await pg.evaluate("() => navigator.clipboard.readText()")).startswith("# A 20-candle"), "Copy copies the code")
    # the contents jump to a section, and follow the reading
    for sec, title in (("pyind-api", "Indicator reference"), ("optimize", "The optimizer"), ("trouble", "When something goes wrong")):
        await pg.click(f".gtoc button:has-text('{title}')")
        await pg.wait_for_timeout(150)
        at = await pg.evaluate(AT, sec)
        check(-2 <= at <= 30, f"{title}: its heading is at the top ({at:.0f} px)")
        check((await pg.locator(".gtoc button.on").inner_text()) == title, f"{title}: marked in the contents")
    await pg.screenshot(path=f"{OUT}/guide-1-page.png")
    # search
    await pg.fill(".ghead input", "set_bracket")
    await pg.wait_for_timeout(150)
    shown = await pg.evaluate(SHOWN)
    check("st-api" in shown and "welcome" not in shown and len(shown) <= 6, f"set_bracket keeps the sections that mention it: {shown}")
    check(await pg.locator(".gtoc button").count() == len(shown), "and only those in the contents")
    await pg.screenshot(path=f"{OUT}/guide-2-search.png")
    await pg.fill(".ghead input", "zzqx nothing like this")
    check(await pg.locator(".guide .empty:has-text('Nothing in the guide mentions')").count() == 1, "nothing found says so")
    await pg.fill(".ghead input", "")
    await pg.wait_for_timeout(150)
    check(len(await pg.evaluate(SHOWN)) == n, f"clearing the search shows everything again ({len(await pg.evaluate(SHOWN))} of {n})")
    # Settings > Open the guide: the guide over the page
    await pg.click("nav.nav button.item:has-text('Settings')")
    await pg.click("button:has-text('Open the guide')")
    check(await pg.locator(".guide.over").count() == 1, "Settings opens the guide")
    await pg.click(".guide.over [aria-label='Close the guide']")
    check(await pg.locator(".guide.over").count() == 0, "and it closes")
    # over the Python indicator editor: at the indicator reference, Esc closes only the guide
    await pg.click("button.new")
    await pg.click(".summary button:has-text('Start with these now')")
    await pg.wait_for_selector(".pane .lw canvas", timeout=30000)
    tip = pg.locator(".tip .acts button:nth-child(2)")
    if await tip.count():
        await tip.click()
    await pg.click("button:has-text('Indicators')")
    await pg.click(".pytpl:has-text('New indicator')")
    await pg.click("[aria-label='Python templates'] button:has-text('RSI')")
    await pg.wait_for_selector(".pyed")
    await pg.click(".pyed button:has-text('Guide')")
    await pg.wait_for_selector(".guide.over")
    at = await pg.evaluate(AT, "pyind-api")
    check(-2 <= at <= 30, f"the editor's Guide opens at the indicator reference ({at:.0f} px)")
    check(await pg.locator(".pyed").count() == 1, "with the editor still there underneath")
    await pg.screenshot(path=f"{OUT}/guide-3-over-editor.png")
    await pg.keyboard.press("Escape")
    check(await pg.locator(".guide.over").count() == 0 and await pg.locator(".pyed").count() == 1, "Esc closes the guide, not the editor")
    await pg.click(".pyed [aria-label='Close']")
    # the Backtest code panel's Guide: the strategy reference
    await pg.click("nav.nav button.item:has-text('Backtest')")
    await pg.click(".bt-codehead button:has-text('Guide')")
    await pg.wait_for_selector(".guide.over")
    at = await pg.evaluate(AT, "st-api")
    check(-2 <= at <= 30, f"the Backtest Guide opens at the strategy reference ({at:.0f} px)")
    await pg.keyboard.press("Escape")
    check(await pg.locator(".guide.over").count() == 0, "and Esc closes it")
    # light theme: the notes are plain boxes, readable
    await pg.emulate_media(color_scheme="light")
    await pg.click("nav.nav button.item:has-text('Guide')")
    pos = await pg.locator(".guide .gnote").first.evaluate("e => getComputedStyle(e).position")
    check(pos == "static", f"notes are plain boxes ({pos})")
    await pg.screenshot(path=f"{OUT}/guide-4-light.png")
    check(not errors, f"desktop: no page errors: {errors}")
    await b.close()


async def phone(p, url):
    b = await p.chromium.launch()
    ctx = await b.new_context(**p.devices["iPhone 13"])
    await ctx.add_init_script(SHIM)
    pg = await ctx.new_page()
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    await pg.goto(url)
    await pg.tap(".mnav button:has-text('More')")
    await pg.tap(".msheet button:has-text('Guide')")
    await pg.wait_for_selector(".guide .gbody")
    check(await pg.locator(".guide .gtoc").count() == 0, "phone: the contents are not beside the text")
    bad = await pg.evaluate(SIDEWAYS)
    check(not bad and await pg.evaluate("() => document.documentElement.scrollWidth <= innerWidth + 1"), f"phone: nothing in the guide moves sideways: {bad}")
    await pg.tap(".ghead button:has-text('Contents')")
    check(await pg.locator(".gtocpop .gtoc button").count() >= 30, "phone: the Contents sheet")
    await pg.screenshot(path=f"{OUT}/guide-5-phone-contents.png")
    await pg.tap(".gtocpop button:has-text('Strategy examples')")
    await pg.wait_for_timeout(200)
    check(await pg.locator(".gtocpop").count() == 0, "phone: picking a section closes the sheet")
    at = await pg.evaluate(AT, "st-examples")
    check(-2 <= at <= 30, f"phone: and lands on it ({at:.0f} px)")
    await pg.screenshot(path=f"{OUT}/guide-6-phone-section.png")
    # a tap outside closes the Contents sheet
    await pg.tap(".ghead button:has-text('Contents')")
    await pg.touchscreen.tap(195, 30)
    await pg.wait_for_timeout(250)
    check(await pg.locator(".gtocpop").count() == 0, "phone: a tap outside closes the Contents sheet")
    check(not errors, f"phone: no page errors: {errors}")
    await b.close()


async def main():
    url = serve()
    async with async_playwright() as p:
        await desktop(p, url)
        await phone(p, url)
    print(f"guide: {passed} checks passed; screenshots in {OUT}")


asyncio.run(main())
