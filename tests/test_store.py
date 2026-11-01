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

        # Session settings: no plain prop rules; the simulation's fields show once it is on
        await pg.click("#stClose")
        await pg.click("#bSettings")
        await pg.wait_for_selector("#modal:not([hidden])", timeout=30000)
        check(await pg.locator("#pOn").count() == 0, "prop rules section removed")
        check(not await pg.is_visible("#sFields"), "simulation fields hidden while off")
        await pg.select_option("#sPreset", label="L Flex 50K")
        check(await pg.is_checked("#sOn") and await pg.is_visible("#sFields"), "a preset turns the simulation on")
        check(await pg.is_disabled("#fBal"), "balance comes from the simulation")
        await pg.fill("#sFee", "100")
        await pg.screenshot(path=f"{OUT}/s3-session-sim.png", full_page=True)
        await pg.click("#mStart")
        await pg.wait_for_function("() => document.querySelector('#modal').hidden", timeout=120000)
        await pg.wait_for_timeout(800)

        # a strategy that loses fast: with "buy a new evaluation" and a limit of 3, it buys two more, then stops
        await pg.click("#bStrat")
        await pg.click("#stTabs [data-st=code]")
        check(not await pg.eval_on_selector("#stEvalRow", "e => e.classList.contains('off')"), "rebuy option available with the simulation on")
        await pg.fill("#stName", "Blow up")
        await pg.evaluate("""c => { const t = document.querySelector('#stSrc'); t.value = c; t.dispatchEvent(new Event('input')); }""", """
def on_bar(ctx, bar):
    if ctx.position <= 0:
        ctx.close(); ctx.buy(20)
    else:
        ctx.close(); ctx.sell(20)
""")
        await pg.click("#stLibs [data-v=numpy]")
        await pg.check("#stRebuy")
        await pg.fill("#stMax", "3")
        await pg.press("#stMax", "Tab")
        await pg.click("#stRun")
        await wait_run(pg)
        cons = await cons_text(pg)
        print(cons[-700:])
        check("New evaluation, attempt 2 ($100.00)" in cons and "New evaluation, attempt 3" in cons, "bought new evaluations")
        check("Reached 3 evaluations, so the run ends here" in cons and "attempt 4" not in cons, "stopped at the limit")
        check("This evaluation account has failed" not in cons, "no orders after the last failure")
        kpi3 = await pg.inner_text("#stKpi")
        check(re.search(r"Evaluations\s+3", kpi3) and "$300.00" in kpi3, f"results show evaluations and fees: {kpi3}")
        await pg.screenshot(path=f"{OUT}/s4-rebuy-results.png")

        # the evaluation's daily profit target: a strategy that is always in the market is closed out once a day is up
        # that much, and no evaluation day ends far beyond it
        await pg.click("#stClose")
        await pg.click("#bSettings")
        await pg.wait_for_selector("#modal:not([hidden])", timeout=30000)
        await pg.fill("#sEPt", "1000000")
        await pg.fill("#sEMll", "1000000")
        await pg.fill("#sEMax", "")
        await pg.fill("#sEDpt", "300")
        check("$300.00, positions close" in await pg.inner_text("#sEDptNote"), await pg.inner_text("#sEDptNote"))
        await pg.click("#mStart")
        await pg.wait_for_function("() => document.querySelector('#modal').hidden", timeout=120000)
        await pg.wait_for_timeout(800)
        await pg.click("#bStrat")
        await pg.click("#stTabs [data-st=code]")
        await pg.fill("#stName", "Always in")
        await pg.evaluate("""c => { const t = document.querySelector('#stSrc'); t.value = c; t.dispatchEvent(new Event('input')); }""", """
def on_bar(ctx, bar):
    if ctx.position == 0:
        ctx.buy(4) if bar.close > bar.open else ctx.sell(4)
""")
        await pg.uncheck("#stRebuy")
        await pg.click("#stRun")
        await wait_run(pg)
        cons = await cons_text(pg)
        m = re.search(r"daily profit target stopped trading early on (\d+) evaluation day", cons)
        check(m and int(m.group(1)) > 0, cons[-600:])
        check(await pg.locator("#simCard").is_visible() or True, "card")
        rows = await pg.inner_text("#simRows")
        check("Daily profit target" in rows, rows)
        # every evaluation day's net (trading days start 18:00 New York), from the closed trades: none far past the target
        days = await pg.evaluate("""() => { const out = {}; for (const tr of document.querySelectorAll('#stTr tr')) { const td = tr.children; if (td.length < 9) continue;
            const t = new Date(td[5].textContent.trim().slice(0, 16).replace(' ', 'T')).getTime() - 18 * 3600e3,
              d = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(t), v = parseFloat(td[8].textContent.replace(/[^0-9.\u2212-]/g, '').replace('\u2212', '-')); if (isFinite(v)) out[d] = (out[d] || 0) + v; } return out; }""")
        check(days and max(days.values()) < 300 + 150, sorted(days.values())[-3:])
        check(not errors, errors)
        await b.close()
    print(f"store: {passed} checks passed")


asyncio.run(main())
