"""End to end: Python indicators in the bundled page (desktop/web, as the apps ship it) with real Python, driven
through the Indicators pop-up and the Indicator panel in Chromium. Build the page and Python first, then run:
    python -c "import sys; sys.path.insert(0, 'desktop'); import build; build.vendor(); build.page()"
    python tests/test_indicator_browser.py [folder for screenshots]
Needs playwright (python -m playwright install chromium).
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


def serve():
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=os.path.join(ROOT, "desktop", "web"))
    handler.extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, ".wasm": "application/wasm"}
    handler.log_message = lambda *a: None
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{srv.server_address[1]}/index.html"


URL = serve()


def check(cond, msg):
    global passed
    if not cond:
        raise AssertionError(msg)
    passed += 1


async def settle(pg, timeout=120000):
    """Wait until the panel's button is back and the indicators have caught up."""
    await pg.wait_for_function("() => !document.querySelector('#piRun').disabled", timeout=timeout)
    await pg.wait_for_function("() => !/^(Loading|Checking|Running)/.test(document.querySelector('#piStat').textContent)", timeout=timeout)
    await pg.wait_for_timeout(300)


async def cons(pg):
    return await pg.evaluate("() => [...document.querySelector('#piCons').children].map(d => d.textContent).join('\\n')")


async def legend(pg):
    await pg.mouse.move(5, 5)
    await pg.wait_for_timeout(100)
    return await pg.inner_text("#legend")


async def add_template(pg, name):
    await pg.select_option("#piTpl", "t:" + name)
    await pg.click("#piRun")
    await settle(pg)


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={"width": 1400, "height": 900}, device_scale_factor=2, color_scheme="dark")
        await ctx.add_init_script("try { if (!localStorage.getItem('tape-replay-prefs')) localStorage.setItem('tape-replay-prefs', JSON.stringify({ tourDone: true })) } catch (e) {}")
        pg = await ctx.new_page()
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        await pg.goto(URL)
        await pg.wait_for_function("() => document.querySelector('#clock').textContent !== '—'", timeout=30000)

        # 1. the Indicators pop-up opens the Indicator panel
        await pg.click("#bInd")
        check(await pg.is_visible("[data-pnew]"), "the pop-up offers a Python indicator")
        await pg.click("[data-pnew]")
        check(await pg.is_visible("#pind"), "the panel opens")
        check(await pg.inner_text("#piRunLbl") == "Add to chart", "nothing on the chart yet")

        # 2. templates: lines, fills and markers on the candles; a band under the chart; boxes, labels, lines
        await add_template(pg, "EMA cross")
        check((await pg.inner_text("#piStat")).startswith("On the chart"), f"added: {await pg.inner_text('#piStat')}")
        check(await pg.inner_text("#piRunLbl") == "Update chart", "the button now updates it")
        check("EMA cross" in await pg.inner_text("#piOn"), "listed as on the chart")
        sets = await pg.inner_text("#piSet")
        check("FAST" in sets and "SLOW" in sets, f"settings found: {sets}")
        await add_template(pg, "RSI")
        await add_template(pg, "Opening range box")
        await add_template(pg, "Swing levels")
        check(not re.search(r"error|Error", await cons(pg)), f"console: {await cons(pg)}")
        await pg.screenshot(path=f"{OUT}/i1-panel.png")
        await pg.click("#piClose")
        lg = await legend(pg)
        check(re.search(r"Fast \d", lg) and re.search(r"Slow \d", lg) and re.search(r"RSI \d", lg), f"legend shows the plots: {lg}")
        await pg.screenshot(path=f"{OUT}/i2-chart.png")

        # 3. a setting changed on the Settings card rewrites the code and updates the chart
        await pg.click("#bInd")
        await pg.click("[data-pe='1']")  # RSI
        check(await pg.input_value("#piName") == "RSI", "opened from the pop-up")
        await pg.fill("#piSet input[data-n=LENGTH]", "7")
        await pg.press("#piSet input[data-n=LENGTH]", "Enter")
        await settle(pg)
        check("LENGTH = 7" in await pg.input_value("#piSrc"), "the code has the new value")
        check((await pg.inner_text("#piStat")).startswith("On the chart"), "and the chart is updated")

        # 4. an error stops that indicator, shows the line, and the others carry on
        bad = 'def on_bar(ctx, bar):\n    ctx.plot(bar.close, "C")\n    if bar.index == 30:\n        ctx.box(bar.index, 1, "later", 0)\n'
        await pg.select_option("#piTpl", "t:Blank")
        await pg.fill("#piName", "Broken")
        await pg.evaluate("c => { const t = document.querySelector('#piSrc'); t.value = c; t.dispatchEvent(new Event('input')); }", bad)
        await pg.click("#piRun")
        await settle(pg)
        c = await cons(pg)
        check("Broken stopped" in c and "line 4" in c and "TypeError" in c, f"error shown: {c}")
        check("error" in await pg.inner_text("#piOn"), "marked in the list")
        await pg.evaluate("c => { const t = document.querySelector('#piSrc'); t.value = c; t.dispatchEvent(new Event('input')); }", "def on_bar(ctx, bar)\n    pass\n")
        await pg.click("#piRun")
        await settle(pg)
        check("SyntaxError" in await cons(pg), "a syntax error is caught before it goes on the chart")
        await pg.click("#piOff")
        check("Broken" not in await pg.inner_text("#piOn"), "removed from the chart")

        # 5. the Help tab is the guide; the strategy guide is one click away
        await pg.click("#piTabs [data-pt=help]")
        help_ = await pg.inner_text("#piHelp")
        check("How an indicator runs" in help_ and "ctx.box(" in help_ and "Coming from Pine Script" in help_, "indicator guide")
        await pg.click("#piHelp [data-g=strat]")
        check("ctx.buy(" in await pg.inner_text("#piHelp .gbody"), "strategy guide")
        await pg.screenshot(path=f"{OUT}/i3-help.png")
        await pg.click("#piClose")

        # 6. another timeframe starts them again; playing on updates them; nothing fails along the way
        await pg.click("#tfChips button:has-text('15m')")
        await pg.wait_for_timeout(2500)
        lg = await legend(pg)
        check(re.search(r"Fast \d", lg) and re.search(r"RSI \d", lg), f"after the timeframe change: {lg}")
        before = await pg.inner_text("#clock")
        await pg.keyboard.press("Space")
        await pg.wait_for_timeout(3000)
        await pg.keyboard.press("Space")
        check(await pg.inner_text("#clock") != before, "the replay moved")
        await pg.screenshot(path=f"{OUT}/i4-played.png")

        # 7. the guide from the pop-up; the Strategy panel's Help tab is the strategy guide
        await pg.click("#bInd")
        await pg.click("[data-pguide]")
        check(await pg.is_visible("#docs") and "How an indicator runs" in await pg.inner_text("#docBody"), "guide window")
        await pg.keyboard.press("Escape")
        check(not await pg.is_visible("#docs"), "Escape closes it")
        await pg.click("#bStrat")
        await pg.click("#stTabs [data-st=help]")
        check("How a run works" in await pg.inner_text("#stHelp"), "strategy Help tab")
        w = await pg.evaluate("() => { const b = document.querySelector('#stHelp .gbody'); return [b.scrollWidth, b.clientWidth]; }")
        check(w[0] <= w[1] + 1, f"the guide's text wraps inside it {w}")
        await pg.click("#stClose")

        # 8. they stay on the chart after the page is opened again
        await pg.wait_for_timeout(1500)
        await pg.reload()
        await pg.wait_for_function("() => document.querySelector('#clock').textContent !== '—'", timeout=30000)
        await pg.wait_for_function("() => /Fast \\d/.test(document.querySelector('#legend').textContent)", timeout=120000)
        await pg.click("#bInd")
        pop = await pg.inner_text(".indpop")
        check("EMA cross" in pop and "RSI" in pop and "Swing levels" in pop, f"kept: {pop}")
        await pg.screenshot(path=f"{OUT}/i5-reopened.png")
        await pg.keyboard.press("Escape")

        # 9. phones: the panel from the More menu
        m = await b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=3, is_mobile=True, has_touch=True, color_scheme="dark")
        await m.add_init_script("try { localStorage.setItem('tape-replay-prefs', JSON.stringify({ tourDone: true })) } catch (e) {}")
        mp = await m.new_page()
        mp.on("pageerror", lambda e: errors.append(str(e)))
        await mp.goto(URL)
        await mp.wait_for_function("() => document.querySelector('#clock').textContent !== '—'", timeout=30000)
        await mp.click('#mnav [data-mv="more"]')
        await mp.click('#mmore [data-go="pind"]')
        check(await mp.is_visible("#pind"), "phone: panel opens from More")
        await mp.select_option("#piTpl", "t:RSI")
        await mp.click("#piRun")
        await settle(mp)
        check((await mp.inner_text("#piStat")).startswith("On the chart"), "phone: added")
        await mp.screenshot(path=f"{OUT}/i6-phone-panel.png")
        await mp.click("#piTabs [data-pt=help]")
        w = await mp.evaluate("() => [document.querySelector('#pind .sheet').scrollWidth, innerWidth]")
        check(w[0] <= w[1], f"phone: the guide fits the screen {w}")
        await mp.click("#piTabs [data-pt=code]")
        await mp.click("#piClose")
        await mp.wait_for_timeout(500)
        await mp.screenshot(path=f"{OUT}/i7-phone-chart.png")
        await mp.click('#mnav [data-mv="more"]')
        await mp.click('#mmore [data-go="guide"]')
        for g in ("ind", "strat"):
            await mp.click(f"#docBody [data-g={g}]")
            w = await mp.evaluate("() => [document.querySelector('#docs .sheet').scrollWidth, innerWidth]")
            check(w[0] <= w[1], f"phone: the {g} guide window fits the screen {w}")
        await mp.screenshot(path=f"{OUT}/i8-phone-guide.png")
        await mp.click("#docClose")

        check(not errors, f"page errors: {errors}")
        await b.close()
    print(f"indicator browser: {passed} checks passed; screenshots in {OUT}")


asyncio.run(main())
