"""Strategy optimization (Windows app) through the desktop app's own server: settings found in the code, a parallel
run in workers, results, the heatmap, a combination opened on the chart giving the same trades as in the
optimization (one engine), zoom in, stop and resume, CSV, the Library tab, and no Optimize tab on iPhone.
Build the page and Python first (see test_browser.py), then:
    python tests/test_optimize.py [folder for screenshots]
"""
import asyncio
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
    os.environ["APPDATA"] = tempfile.mkdtemp(prefix="tape-appdata-")
    sys.path.insert(0, os.path.join(ROOT, "desktop"))
    import app
    for d in (app.DATASETS, app.SESSIONS):
        os.makedirs(d, exist_ok=True)
    srv = app.ExclusiveServer(("127.0.0.1", 0), app.Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{srv.server_address[1]}/classic.html?t={app.TOKEN}"


URL = serve()
SHIM = open(os.path.join(ROOT, "ios", "Sources", "TapeReplay", "ios-shim.js"), encoding="utf-8").read()
CODE = """# MA cross, settings at the top
FAST, SLOW = 9, 21
STOP, TARGET = 40, 80   # in ticks
LONG_ONLY = False
OPEN = "08:30"          # a time: not offered
RISK_USD = 500          # a money setting: listed, not ticked

def on_bar(ctx, bar):
    c = ctx.closes(SLOW)
    if len(c) < SLOW:
        return
    fast, slow = c[-FAST:].mean(), c.mean()
    if fast > slow and ctx.position <= 0:
        ctx.close(); ctx.buy(sl=bar.close - ctx.ticks(STOP), tp=bar.close + ctx.ticks(TARGET))
    elif fast < slow and ctx.position >= 0:
        ctx.close()
        if not LONG_ONLY:
            ctx.sell(sl=bar.close + ctx.ticks(STOP), tp=bar.close - ctx.ticks(TARGET))
"""


async def set_code(pg, code):
    await pg.evaluate("c => { const t = document.querySelector('#stSrc'); t.value = c; t.dispatchEvent(new Event('input')); }", code)


async def wait_opt(pg, timeout=600000):
    await pg.wait_for_function("() => !document.querySelector('#optRun').disabled && /done|Stopped/i.test(document.querySelector('#stStat').textContent)", timeout=timeout)
    await pg.wait_for_timeout(300)


async def set_row(pg, name, values=None, on=True):
    row = pg.locator(f"#optRows tr[data-n={name}]")
    cb = row.locator("[data-on]")
    if await cb.is_checked() != on:
        await cb.click()
    if values is not None:
        await row.locator("[data-v]").fill(values)


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={"width": 1500, "height": 950}, device_scale_factor=1.5, color_scheme="dark")
        await ctx.grant_permissions(["clipboard-read", "clipboard-write"])
        pg = await ctx.new_page()
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        await pg.goto(URL)
        await pg.wait_for_selector("#home:not([hidden])", timeout=30000)
        check(await pg.evaluate("crossOriginIsolated"), "the desktop server makes the page cross-origin isolated")
        await pg.click("#hNew")
        await pg.wait_for_selector("#modal:not([hidden])", timeout=30000)
        await pg.click("#mStart")
        await pg.wait_for_function("() => document.querySelector('#modal').hidden && document.querySelector('#clock').textContent !== '—'", timeout=120000)
        await pg.wait_for_timeout(1300)
        await pg.evaluate("document.querySelector('.tour [data-t=skip]')?.click()")

        await pg.click("#bStrat")
        check(await pg.is_visible("#stTabOpt"), "Optimize tab on the desktop app")
        await pg.click("#stTabs [data-st=code]")
        await pg.fill("#stName", "MA opt test")
        await set_code(pg, CODE)
        await pg.select_option("#stTf", "5m")
        await pg.evaluate("() => { const f = document.querySelector('#stFrom'), t = document.querySelector('#stTo'); const d = new Date(f.value); d.setDate(d.getDate() + 5); t.value = d.toISOString().slice(0, 10); }")

        # the settings found in the code
        await pg.click("#stTabs [data-st=opt]")
        await pg.wait_for_selector("#optRows tr[data-n=FAST]", timeout=120000)
        names = await pg.eval_on_selector_all("#optRows tr[data-n]", "rs => rs.map(r => r.dataset.n)")
        check(names == ["FAST", "SLOW", "STOP", "TARGET", "LONG_ONLY", "RISK_USD"], names)
        check("size" in await pg.inner_text("#optRows tr[data-n=RISK_USD]"), "money setting marked")
        check(await pg.input_value("#optRows tr[data-n=LONG_ONLY] [data-v]") == "True, False", "True/False tries both")
        check(re.search(r"Tick the settings", await pg.inner_text("#optCount")), "nothing ticked yet")
        await set_row(pg, "FAST", "5, 9, 13")
        await set_row(pg, "SLOW", "13, 21, 30")
        await pg.fill("#optRules", "FAST < SLOW")
        check("9 combinations" in await pg.inner_text("#optCount"), await pg.inner_text("#optCount"))
        await set_row(pg, "SLOW", "13, abc")
        check("bad" in (await pg.get_attribute("#optRows tr[data-n=SLOW] [data-v]", "class")), "bad values flagged")
        await set_row(pg, "SLOW", "13, 21, 30")
        await pg.fill("#optMin", "1")
        await pg.select_option("#optSplit", "30")

        # run: workers, results, heatmap
        await pg.click("#optRun")
        await wait_opt(pg)
        summ = await pg.inner_text("#optSummary")
        check("8 of 8" in summ and "1 skipped by the rules" in summ, summ)
        rows = await pg.eval_on_selector_all("#optBody tr[data-i]", "rs => rs.length")
        check(rows == 8, f"{rows} rows")
        check(await pg.is_visible("#optHeat") and await pg.locator("#optHeat td[data-i]").count() == 8, "heatmap")
        check(not await pg.locator("#optBody td.err").count(), await pg.inner_text("#optBody"))
        await pg.screenshot(path=f"{OUT}/opt-1-results.png")

        # the best combination on the chart gives the same trades and net as its optimization run (one engine)
        first = pg.locator("#optBody tr[data-i]").first
        cells = await first.locator("td").all_inner_texts()
        a_trades, a_net, b_net, b_trades = int(cells[4]), cells[5], cells[9], int(cells[11])
        money = lambda s: float(s.replace("−", "-").replace("+", "").replace("$", "").replace(",", "")) if s.strip() not in ("—", "") else 0.0
        await first.locator("button[data-chart]").click()
        await pg.wait_for_function("() => !document.querySelector('#stRun').disabled && /Done|Ended|Stopped/.test(document.querySelector('#stStat').textContent)", timeout=300000)
        await pg.wait_for_timeout(500)
        kpi = await pg.inner_text("#stKpi")
        chart_trades = int(re.search(r"Trades\s+(\d+)", kpi).group(1))
        chart_net = money(re.search(r"Net P&L\s+(\S+)", kpi).group(1))
        check(chart_trades == a_trades + b_trades, f"trades: chart {chart_trades} vs optimization {a_trades}+{b_trades}")
        check(abs(chart_net - (money(a_net) + money(b_net))) < 0.02, f"net: chart {chart_net} vs {a_net} + {b_net}")
        saved = await pg.inner_text("#stSaved")
        check("MA opt test (FAST=" in saved and "Automated" in saved, saved)

        # zoom in on the best: a finer search
        await pg.click("#stTabs [data-st=opt]")
        await pg.wait_for_selector("#optRows tr[data-n=FAST]")
        await pg.click("#optZoom")
        await wait_opt(pg)
        fast_vals = await pg.input_value("#optRows tr[data-n=FAST] [data-v]")
        fast_n = int(await pg.inner_text("#optRows tr[data-n=FAST] [data-c]"))
        check(fast_n > 3 and await pg.locator("#optBody tr[data-i]").count() > 1, f"zoomed values {fast_vals}")

        # stop part way, then resume
        await set_row(pg, "FAST", "3..9")
        await set_row(pg, "SLOW", "16..30 step 2")
        await set_row(pg, "LONG_ONLY")
        await pg.fill("#optRules", "")
        await pg.click("#optRun")
        await pg.wait_for_function("() => /of \\d+/.test(document.querySelector('#stStat').textContent) && parseInt(document.querySelector('#stStat').textContent) >= 20", timeout=600000)
        await pg.click("#optStop")
        await wait_opt(pg)
        check(await pg.is_visible("#optResume"), "resume offered after a stop")
        done_before = await pg.locator("#optBody tr[data-i]").count()
        await pg.click("#optResume")
        await wait_opt(pg, 900000)
        summ = await pg.inner_text("#optSummary")
        total = re.search(r"([\d,]+) of ([\d,]+)", summ)
        check(total and total.group(1) == total.group(2) and int(total.group(2).replace(",", "")) == 7 * 8 * 2, summ)
        check(done_before < 300, "it was stopped part way")
        check(not await pg.is_visible("#optResume"), "nothing left to resume")
        await pg.screenshot(path=f"{OUT}/opt-2-resumed.png")

        # CSV
        await pg.click("#optCsv")
        await pg.wait_for_timeout(300)
        csv = await pg.evaluate("navigator.clipboard.readText()")
        lines = csv.strip().split("\n")
        check(lines[0].startswith("rank,FAST,SLOW,LONG_ONLY,goal,trades") and len(lines) == 7 * 8 * 2 + 1, lines[0])

        # the Library keeps them
        await pg.click("#stClose")
        await pg.click("#bLib")
        await pg.click("#libTabs [data-lt=op]")
        await pg.wait_for_selector("#libBody [data-opopen]", timeout=30000)
        n_saved = await pg.locator("#libBody [data-opopen]").count()
        check(n_saved == 3, f"{n_saved} optimizations saved")
        await pg.screenshot(path=f"{OUT}/opt-3-library.png")
        await pg.locator("#libBody [data-opopen]").last.click()
        await pg.wait_for_selector("#stOpt:not([hidden])", timeout=30000)
        await pg.wait_for_timeout(500)
        check("8 of 8" in await pg.inner_text("#optSummary"), "the first optimization reopened")
        check(not errors, errors)

        # iPhone: Strategy under More, the optimizer with a phone layout and phone limits
        ph = await b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True, color_scheme="dark")
        await ph.add_init_script(SHIM)
        pp = await ph.new_page()
        await pp.goto(URL)
        await pp.wait_for_selector("#home:not([hidden])", timeout=30000)
        await pp.click("#hNew")
        await pp.wait_for_selector("#modal:not([hidden])", timeout=30000)
        await pp.click("#mStart")
        await pp.wait_for_function("() => document.querySelector('#modal').hidden", timeout=120000)
        await pp.wait_for_timeout(1300)
        await pp.evaluate("document.querySelector('.tour [data-t=skip]')?.click()")
        check(await pp.locator("#mnav button").count() == 5 and not await pp.is_visible("#bStrat"), "Strategy only under More")
        await pp.click("#mnav [data-mv=more]")
        await pp.click("#mmore [data-go=bStrat]")
        check(await pp.is_visible("#strat") and await pp.is_visible("#stTabOpt"), "Optimize tab on iPhone")
        await pp.click("#stTabs [data-st=code]")
        await pp.fill("#stName", "MA phone")
        await set_code(pp, CODE)
        await pp.select_option("#stTf", "5m")
        await pp.evaluate("() => { const f = document.querySelector('#stFrom'), t = document.querySelector('#stTo'); const d = new Date(f.value); d.setDate(d.getDate() + 5); t.value = d.toISOString().slice(0, 10); }")
        await pp.click("#stTabs [data-st=opt]")
        await pp.wait_for_selector("#optRows tr[data-n=FAST]", timeout=120000)
        # more than the phone's 300: told to narrow or sample
        await set_row(pp, "FAST", "2..30")
        await set_row(pp, "SLOW", "10..40")
        check("most on iPhone and iPad" in await pp.inner_text("#optCount"), await pp.inner_text("#optCount"))
        await set_row(pp, "FAST", "5, 9")
        await set_row(pp, "SLOW", "21, 30")
        await pp.fill("#optMin", "1")
        await pp.screenshot(path=f"{OUT}/opt-4-phone-settings.png", full_page=False)
        await pp.click("#optRun")
        await pp.wait_for_function("() => /at a time/.test(document.querySelector('#optCount').textContent)", timeout=60000)
        at = re.search(r"(\d+) at a time", await pp.inner_text("#optCount"))
        check(at and int(at.group(1)) <= 2, f"phone runs at most 2 at a time: {await pp.inner_text('#optCount')}")
        await wait_opt(pp)
        cards = await pp.locator("#optCards .optcard").count()
        check(cards == 4 and await pp.locator("#optBody").is_hidden(), f"{cards} result cards")
        await pp.evaluate("document.querySelector('#optCards').scrollIntoView()")
        await pp.screenshot(path=f"{OUT}/opt-5-phone-results.png", full_page=False)
        await pp.locator("#optCards .optcard button[data-chart]").first.click()
        await pp.wait_for_function("() => !document.querySelector('#stRun').disabled && /Done|Ended|Stopped/.test(document.querySelector('#stStat').textContent)", timeout=300000)
        check("MA phone (FAST=" in await pp.inner_text("#stSaved"), "a phone result opens on the chart")
        await pp.click("#stClose")
        await pp.click("#mnav [data-mv=more]")
        await pp.click("#mmore [data-go=bLib]")
        check(await pp.is_visible("#libOpTab"), "Optimizations in the iPhone Library")
        await b.close()
    print(f"optimize: {passed} checks passed")


asyncio.run(main())
