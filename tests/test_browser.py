"""End to end: the bundled page (desktop/web, as the apps ship it) with real Python, driven through the
Strategy panel in Chromium. Build the page and Python first, then run:
    python -c "import sys; sys.path.insert(0, 'desktop'); import build; build.web()"
    python tests/test_browser.py [folder for screenshots]
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
OUT = sys.argv[1] if len(sys.argv) > 1 else tempfile.mkdtemp(prefix="tape-shots-")  # screenshots
passed = 0


def serve():
    """desktop/web on a free local port; the page has no app token here, so it opens on the sample data."""
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=os.path.join(ROOT, "desktop", "web"))
    handler.extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, ".wasm": "application/wasm"}
    handler.log_message = lambda *a: None
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{srv.server_address[1]}/classic.html"


URL = serve()


def check(cond, msg):
    global passed
    if not cond:
        raise AssertionError(msg)
    passed += 1


async def set_code(pg, code):
    await pg.evaluate("c => { const t = document.querySelector('#stSrc'); t.value = c; t.dispatchEvent(new Event('input')); }", code)


async def run(pg, timeout=120000):
    await pg.click("#stRun")
    await pg.wait_for_function("() => !document.querySelector('#stRun').disabled && document.querySelector('#stStat').textContent !== 'Loading Python…'", timeout=timeout)
    await pg.wait_for_timeout(200)
    return await cons_text(pg)


async def cons_text(pg):
    return await pg.evaluate("() => [...document.querySelector('#stCons').children].map(d => d.textContent).join('\\n')")


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={"width": 1400, "height": 900}, device_scale_factor=2, color_scheme="dark")
        await ctx.add_init_script("try { localStorage.setItem('tape-replay-prefs', JSON.stringify({ tourDone: true })) } catch (e) {}")
        pg = await ctx.new_page()
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        await pg.goto(URL)
        await pg.wait_for_function("() => document.querySelector('#clock').textContent !== '—'", timeout=30000)
        await pg.click("#bStrat")
        check(await pg.is_visible("#strat"), "panel opens")
        await pg.screenshot(path=f"{OUT}/1-code.png")

        # 1. the MA cross template, at bar close, numpy
        cons = await run(pg)
        print("--- MA cross\n" + cons[-400:])
        check("Finished in" in cons, "ran to the end")
        check(await pg.is_visible("#stRes"), "results tab shown")
        kpi = await pg.inner_text("#stKpi")
        trades = int(re.search(r"Trades\s+(\d+)", kpi).group(1))
        check(trades > 5, f"trades {kpi}")
        check(re.search(r"Net P&L\s+[+−]\$[1-9]", kpi), f"orders use the session size: {kpi}")
        check(re.search(r"\d\d-\d\d \d\d:\d\d\s+(buy|sell) [0-9]+ @", cons), "on_fill printed fills")
        hist = await pg.inner_text("#tabHist")
        check(f"({trades})" in hist, f"chart history matches: {hist} vs {trades}")
        await pg.screenshot(path=f"{OUT}/2-results.png")
        await pg.click("#stChart")
        await pg.wait_for_timeout(500)
        check(not await pg.is_visible("#strat"), "show on chart closes the panel")
        await pg.screenshot(path=f"{OUT}/3-chart.png")

        # 2. fill timing: a market order from on_bar fills at the next bar's open (plus the spread on a buy)
        await pg.click("#bStrat")
        await pg.click("#stTabs [data-st=code]")
        await pg.fill("#stName", "Timing test")
        await set_code(pg, """
def init(ctx):
    ctx.done = False
def on_bar(ctx, bar):
    if bar.index == 3:
        print("bar3-open", bar.open)
    if bar.index == 2 and not ctx.done:
        ctx.buy(1)
        ctx.done = True
        ctx.mark = bar.index
def on_fill(ctx, fill):
    o = ctx.opens(1)
    print("fill", fill.side, fill.price, "bars-seen", len(ctx.closes()), "open-of-last", o[-1] if len(o) else None)
""")
        await pg.select_option("#stTf", label=(await pg.eval_on_selector("#stTf", "s => s.options[0].text")))
        cons = await run(pg)
        print("--- timing\n" + cons[-500:])
        m = re.search(r"fill buy ([\d.]+) bars-seen (\d+)", cons)
        check(m and m.group(2) == "3", f"filled during bar 4, before on_bar for it: {cons}")
        o3 = float(re.search(r"bar3-open ([\d.]+)", cons).group(1))
        check(abs(float(m.group(1)) - (o3 + 0.00006)) < 1e-9, f"fill = next open + spread: {m.group(1)} vs {o3}")

        # 3. errors show the line and stop the run
        await pg.click("#stTabs [data-st=code]")
        await pg.fill("#stName", "Broken")
        await set_code(pg, "def on_bar(ctx, bar):\n    if bar.index == 30:\n        x = 1 / 0\n")
        cons = await run(pg)
        print("--- error\n" + cons[-400:])
        check("ZeroDivisionError" in cons and "line 3, in on_bar" in cons and "x = 1 / 0" in cons, "traceback")
        check("error" in (await pg.inner_text("#stStat")).lower(), "status says error")
        await set_code(pg, "def on_bar(ctx, bar)\n    pass\n")
        cons = await run(pg)
        check("SyntaxError" in cons, "syntax error")

        # 4. pandas: refused under numpy only, works with numpy + pandas
        pd_code = """import pandas as pd
def on_bar(ctx, bar):
    if bar.index == 60:
        df = ctx.df(50)
        print("df", type(df).__name__, len(df), round(df.close.rolling(10).mean().iloc[-1], 6), df.index.tz is not None)
    if bar.index == 61:
        ctx.sell(2, limit=bar.close - 1)      # wrong side: rejected
        ctx.sell(2, limit=bar.close - 2)
"""
        await pg.fill("#stName", "Pandas test")
        await set_code(pg, pd_code)
        await pg.click("#stLibs [data-v=numpy]")
        cons = await run(pg)
        check("choose \"numpy + pandas\"" in cons, "pandas needs the selection")
        await pg.click("#stLibs [data-v=pandas]")
        cons = await run(pg, 180000)
        print("--- pandas\n" + cons[-600:])
        check(re.search(r"df DataFrame 50 [\d.]+ True", cons), "pandas DataFrame")
        check(cons.count("Order rejected: A sell limit must be above the bid") == 1, "rejection shown once")
        await pg.click("#stTabs [data-st=code]")
        await pg.click("#stLibs [data-v=numpy]")

        # 5. every tick: the trailing-stop template
        await pg.click("#stTabs [data-st=code]")
        await pg.select_option("#stTpl", "t:Breakout with trailing stop")
        check(await pg.get_attribute("#stMode [data-v=tick]", "aria-pressed") == "true", "template picks Every tick")
        cons = await run(pg, 300000)
        print("--- every tick\n" + cons[-400:])
        check("every tick" in cons and "Finished in" in cons, "tick run finished")
        check("buy stop must be above the ask" not in cons, "template keeps stops outside the spread")
        kpi = await pg.inner_text("#stKpi")
        check(int(re.search(r"Trades\s+(\d+)", kpi).group(1)) > 0, f"tick trades {kpi}")

        # 6. Stop part way
        await pg.click("#stTabs [data-st=code]")
        await pg.click("#stRun")
        await pg.wait_for_function("() => /\\d+%/.test(document.querySelector('#stPct').textContent) && parseInt(document.querySelector('#stPct').textContent) > 5", timeout=60000)
        await pg.click("#stStop")
        await pg.wait_for_function("() => !document.querySelector('#stRun').disabled", timeout=60000)
        cons = await cons_text(pg)
        check("Stopped at" in cons, "stop")
        await pg.click("#stTabs [data-st=code]")
        await pg.click("#stMode [data-v=bar]")

        # smart quotes from a phone keyboard become straight quotes
        await pg.click("#stTabs [data-st=code]")
        await set_code(pg, "def on_bar(ctx, bar):\n    if bar.index == 3:\n        print(\u201cquotes ok\u201d, \u2018x\u2019)\n")
        await pg.fill("#stTo", await pg.input_value("#stFrom"))
        cons = await run(pg)
        check("quotes ok x" in cons, cons[-200:])

        # 7. saved strategies are listed
        opts = await pg.inner_text("#stTpl")
        check("Timing test" in opts and "Pandas test" in opts, "saved list")
        check(not errors, f"page errors: {errors}")
        await pg.click("#stTabs [data-st=help]")
        await pg.screenshot(path=f"{OUT}/4-help.png")

        # 8. phone layout
        ph = await b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True, color_scheme="dark")
        await ph.add_init_script("try { localStorage.setItem('tape-replay-prefs', JSON.stringify({ tourDone: true })) } catch (e) {}")
        await ph.add_init_script("document.addEventListener('DOMContentLoaded',()=>{const m=document.createElement('meta');m.name='viewport';m.content='width=device-width, initial-scale=1, viewport-fit=cover';document.head.appendChild(m)})")
        pp = await ph.new_page()
        await pp.goto(URL)
        await pp.wait_for_function("() => document.documentElement.classList.contains('m')", timeout=30000)
        await pp.wait_for_timeout(800)
        check(await pp.locator("#mnav button").count() == 5 and not await pp.is_visible("#bStrat"), "Strategy is not on the phone's bars")
        await pp.click("#mnav [data-mv=more]")
        await pp.click("#mmore [data-go=bStrat]")
        await pp.wait_for_timeout(300)
        await pp.screenshot(path=f"{OUT}/5-phone-code.png")
        await pp.click("#stRun")
        await pp.wait_for_function("() => !document.querySelector('#stRun').disabled && document.querySelector('#stStat').textContent !== 'Loading Python…'", timeout=120000)
        await pp.wait_for_timeout(300)
        await pp.screenshot(path=f"{OUT}/6-phone-results.png")
        await pp.click("#stChart")
        await pp.wait_for_timeout(600)
        await pp.screenshot(path=f"{OUT}/7-phone-chart.png")
        await b.close()
    print(f"browser: {passed} checks passed")


asyncio.run(main())
