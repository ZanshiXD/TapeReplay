"""Through the desktop app's own server (desktop/app.py, without its window, on any OS): a run on the built-in
practice data is saved to the Library as an automated backtest and reopens with its results.
Build the page and Python first (see test_browser.py), then:
    python tests/test_store.py [folder for screenshots]
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
    """The app's server with its data in a temporary folder; returns the page's address with its token."""
    os.environ["APPDATA"] = tempfile.mkdtemp(prefix="tape-appdata-")
    sys.path.insert(0, os.path.join(ROOT, "desktop"))
    import app
    for d in (app.DATASETS, app.SESSIONS):
        os.makedirs(d, exist_ok=True)
    srv = app.ExclusiveServer(("127.0.0.1", 0), app.Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{srv.server_address[1]}/index.html?t={app.TOKEN}"


URL = serve()


def check(cond, msg):
    global passed
    if not cond:
        raise AssertionError(msg)
    passed += 1


async def cons_text(pg):
    return await pg.evaluate("() => [...document.querySelector('#stCons').children].map(d => d.textContent).join('\\n')")


async def wait_run(pg, timeout=180000):
    await pg.wait_for_function("() => !document.querySelector('#stRun').disabled && !/Loading|Starting/.test(document.querySelector('#stStat').textContent)", timeout=timeout)
    await pg.wait_for_timeout(300)


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={"width": 1400, "height": 900}, device_scale_factor=2, color_scheme="dark")
        pg = await ctx.new_page()
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        await pg.goto(URL)
        await pg.wait_for_selector("#home:not([hidden])", timeout=30000)
        # the strategy button needs a session
        await pg.evaluate("document.querySelector('#bStrat').click()")
        check(not await pg.is_visible("#strat"), "no panel without a session")
        await pg.click("#hNew")
        await pg.wait_for_selector("#modal:not([hidden])", timeout=30000)
        await pg.click("#mStart")
        await pg.wait_for_function("() => document.querySelector('#modal').hidden && document.querySelector('#clock').textContent !== '—'", timeout=120000)
        await pg.wait_for_timeout(500)
        # skip the first-run tour if it appeared
        await pg.evaluate("document.querySelector('.tour [data-t=skip]')?.click()")
        await pg.click("#bStrat")
        check(await pg.is_visible("#strat"), "panel")
        await pg.select_option("#stTpl", "t:Opening range breakout")
        await pg.select_option("#stTf", "5m")
        await pg.click("#stRun")
        await wait_run(pg)
        cons = await cons_text(pg)
        print(cons[-700:])
        check("Finished in" in cons, "ORB ran")
        kpi = await pg.inner_text("#stKpi")
        trades = int(re.search(r"Trades\s+(\d+)", kpi).group(1))
        check(trades > 3, kpi)
        check("Order rejected" not in cons, "ORB template places valid orders")
        saved = await pg.inner_text("#stSaved")
        check('Saved to the Library as "Opening range breakout · Automated"' in saved, saved)
        await pg.screenshot(path=f"{OUT}/s1-orb-results.png")
        # pandas through the app's server (.whl files)
        await pg.click("#stTabs [data-st=code]")
        await pg.click("#stLibs [data-v=pandas]")
        await pg.fill("#stName", "Pandas EMA")
        await pg.evaluate("""c => { const t = document.querySelector('#stSrc'); t.value = c; t.dispatchEvent(new Event('input')); }""", """
def on_bar(ctx, bar):
    df = ctx.df(60)
    if len(df) < 60:
        return
    fast = df.close.ewm(span=12).mean().iloc[-1]
    slow = df.close.ewm(span=48).mean().iloc[-1]
    if fast > slow and ctx.position <= 0:
        ctx.close(); ctx.buy()
    elif fast < slow and ctx.position >= 0:
        ctx.close(); ctx.sell()
""")
        await pg.fill("#stTo", await pg.input_value("#stFrom"))   # one day is enough here
        await pg.click("#stRun")
        await wait_run(pg)
        cons = await cons_text(pg)
        print(cons[-300:])
        check("Finished in" in cons, "pandas run through the app server")
        await pg.click("#stClose")
        await pg.wait_for_timeout(1500)  # the save finishes
        # the Library lists both runs; reopening one shows its results
        await pg.click("#bLib")
        await pg.wait_for_function("() => [...document.querySelectorAll('#libBody input.nm')].some(i => /Automated/.test(i.value))", timeout=30000)
        lib = await pg.inner_text("#libBody")
        check("Opening range breakout · Automated" in await pg.evaluate("() => [...document.querySelectorAll('#libBody input.nm')].map(i => i.value).join('|')"), "ORB in Library")
        await pg.screenshot(path=f"{OUT}/s2-library.png")
        sid = await pg.evaluate("() => [...document.querySelectorAll('#libBody tr')].find(r => r.querySelector('input.nm')?.value.startsWith('Opening range')).querySelector('[data-open]').dataset.open")
        await pg.click(f"[data-open='{sid}']")
        await pg.wait_for_function("() => document.querySelector('#lib').hidden", timeout=30000)
        await pg.wait_for_timeout(800)
        await pg.click("#bStrat")
        check(await pg.is_visible("#stRes"), "reopened automated session shows results")
        kpi2 = await pg.inner_text("#stKpi")
        check(re.search(r"Trades\s+(\d+)", kpi2).group(1) == str(trades), f"same trades {kpi2} vs {trades}")
        check(await pg.input_value("#stName") == "Opening range breakout", "its code is loaded")
        check(not errors, errors)
        await b.close()
    print(f"store: {passed} checks passed")


asyncio.run(main())
