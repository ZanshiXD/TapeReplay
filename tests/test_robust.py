"""Robustness tests after an optimization, through the desktop app's own server: the best combinations run again and
are tested out of sample (the Check period), by walk-forward and by Monte Carlo. Their figures must agree with the
optimization's (the same runs, so the same trades); changing only the test settings needs no new runs; the results
are saved with the optimization and come back when it is reopened.
Build the page and Python first (see test_browser.py), then:
    python tests/test_robust.py [folder for screenshots]
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
    for d in (app.DATASETS, app.SESSIONS, app.OPTIMS):
        os.makedirs(d, exist_ok=True)
    srv = app.ExclusiveServer(("127.0.0.1", 0), app.Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{srv.server_address[1]}/classic.html?t={app.TOKEN}"


URL = serve()
CODE = """FAST, SLOW = 9, 21
STOP, TARGET = 40, 80
def on_bar(ctx, bar):
    c = ctx.closes(SLOW)
    if len(c) < SLOW:
        return
    fast, slow = c[-FAST:].mean(), c.mean()
    if fast > slow and ctx.position <= 0:
        ctx.close(); ctx.buy(sl=bar.close - ctx.ticks(STOP), tp=bar.close + ctx.ticks(TARGET))
    elif fast < slow and ctx.position >= 0:
        ctx.close(); ctx.sell(sl=bar.close + ctx.ticks(STOP), tp=bar.close - ctx.ticks(TARGET))
"""
money = lambda s: float(s.replace("−", "-").replace("+", "").replace("$", "").replace(",", "")) if s.strip() not in ("—", "") else None


async def set_row(pg, name, values):
    row = pg.locator(f"#optRows tr[data-n={name}]")
    if not await row.locator("[data-on]").is_checked():
        await row.locator("[data-on]").click()
    await row.locator("[data-v]").fill(values)


async def table(pg, head, body):
    heads = await pg.eval_on_selector_all(f"{head} th", "ths => ths.map(t => t.textContent.replace(/[↓↑]/g, '').trim())")
    rows = await pg.eval_on_selector_all(f"{body} tr[data-i]", "rs => rs.map(r => [r.dataset.i, [...r.children].map(td => td.textContent.trim())])")
    return heads, {i: dict(zip(heads, cells)) for i, cells in rows}


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        pg = await b.new_page(viewport={"width": 1500, "height": 950})
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        await pg.goto(URL)
        await pg.wait_for_selector("#home:not([hidden])", timeout=30000)
        await pg.click("#hNew")
        await pg.wait_for_selector("#modal:not([hidden])", timeout=30000)
        await pg.click("#mStart")
        await pg.wait_for_function("() => document.querySelector('#modal').hidden && document.querySelector('#clock').textContent !== '—'", timeout=120000)
        await pg.wait_for_selector(".tour [data-t=skip]", timeout=10000)
        await pg.evaluate("document.querySelector('.tour [data-t=skip]')?.click()")
        await pg.click("#bStrat")
        await pg.click("#stTabs [data-st=code]")
        await pg.fill("#stName", "MA robust")
        await pg.evaluate("c => { const t = document.querySelector('#stSrc'); t.value = c; t.dispatchEvent(new Event('input')); }", CODE)
        await pg.select_option("#stTf", "5m")
        await pg.evaluate("() => { const f = document.querySelector('#stFrom'), t = document.querySelector('#stTo'); const d = new Date(f.value); d.setDate(d.getDate() + 9); t.value = d.toISOString().slice(0, 10); }")

        # an optimization with a Check period (the last 30%)
        await pg.click("#stTabs [data-st=opt]")
        await pg.wait_for_selector("#optRows tr[data-n=FAST]", timeout=120000)
        await set_row(pg, "FAST", "5, 9, 13")
        await set_row(pg, "SLOW", "21, 30, 40")
        await pg.fill("#optMin", "1")
        await pg.select_option("#optSplit", "30")
        await pg.click("#optRun")
        await pg.wait_for_function("() => !document.querySelector('#optRun').disabled && /done/i.test(document.querySelector('#stStat').textContent)", timeout=600000)
        _, opt = await table(pg, "#optHead", "#optBody")
        check(len(opt) == 9, f"{len(opt)} optimization rows")

        # the panel: candidates, and the Check period offered as the holdout
        check(await pg.is_visible("#robBox"), "robustness panel under the results")
        await pg.fill("#robPct", "50")
        cand = await pg.inner_text("#robCand")
        check(cand.startswith("5 of 9"), cand)
        check(await pg.input_value("#robFrom") != "" and await pg.is_checked("#robOos"), "holdout dates filled in")
        check("Check period" in await pg.inner_text("#robOosNote"), await pg.inner_text("#robOosNote"))
        await pg.fill("#robWfN", "3")
        await pg.fill("#robMcN", "500")
        await pg.fill("#robRuin", "400")
        await pg.evaluate("() => { window.__rm = []; new MutationObserver(() => window.__rm.push(document.querySelector('#robMsg').textContent)).observe(document.querySelector('#robMsg'), { childList: true, characterData: true, subtree: true }); }")
        await pg.click("#robRun")
        await pg.wait_for_function("() => !document.querySelector('#robOut').hidden && !document.querySelector('#robRun').disabled", timeout=600000)
        msgs = await pg.evaluate("window.__rm")
        check(any(m.startswith("Running 5 candidates") for m in msgs), msgs)
        heads, rob = await table(pg, "#robHead", "#robBody")
        check(len(rob) == 5, f"{len(rob)} candidates tested")
        for h in ("Ranked net", "Holdout trades", "Holdout vs ranked", "WF windows in profit", "MC in profit", "MC net, worst 5%", "MC max DD, worst 5%", "MC ruin", "Passed"):
            check(h in heads, f"column {h}: {heads}")

        # the same runs: ranked-date and holdout figures match the optimization's (net and Check: net)
        for i, r in rob.items():
            o = opt[i]
            check(abs(money(r["Ranked net"]) - money(o["Net"])) < 0.02, f"#{i} ranked net {r['Ranked net']} vs optimization {o['Net']}")
            check(int(r["Holdout trades"]) == int(o["Check: trades"]), f"#{i} holdout trades {r['Holdout trades']} vs {o['Check: trades']}")
            if int(o["Check: trades"]):
                check(abs(money(r["Holdout net"]) - money(o["Check: net"])) < 0.02, f"#{i} holdout net {r['Holdout net']} vs Check {o['Check: net']}")
            check(re.fullmatch(r"\d of 3", r["WF windows in profit"]), r["WF windows in profit"])
            check(re.fullmatch(r"\d+%", r["MC in profit"]) and re.fullmatch(r"\d+%", r["MC ruin"]), (r["MC in profit"], r["MC ruin"]))
            check(re.fullmatch(r"\d of 3", r["Passed"]), r["Passed"])
        # the candidates are the five best by the goal
        best5 = [i for i, _ in sorted(opt.items(), key=lambda kv: int(kv[1]["#"]))][:5]
        check(sorted(rob) == sorted(best5), f"candidates {sorted(rob)} vs best {sorted(best5)}")
        # walk-forward: three windows, each with a pick and out-of-sample result, and the joined result
        wf = await pg.inner_text("#robWfOut")
        check("Walk-forward" in wf and "efficiency" in wf, wf[:200])
        check(await pg.locator("#robWfOut tbody tr").count() == 3, "three windows")
        await pg.evaluate("document.querySelector('#robBox').scrollIntoView()")
        await pg.screenshot(path=f"{OUT}/robust-1.png")

        # new test settings, same candidates and dates: worked out again without new runs, and the same out-of-sample figures
        await pg.evaluate("window.__rm = []")
        await pg.fill("#robWfN", "4")
        await pg.select_option("#robMcMode", "shuffle")
        await pg.click("#robRun")
        await pg.wait_for_function("() => document.querySelectorAll('#robWfOut tbody tr').length === 4 && !document.querySelector('#robRun').disabled", timeout=60000)
        msgs = await pg.evaluate("window.__rm")
        check(not any(m.startswith("Running") for m in msgs), f"no new runs: {msgs}")
        _, rob2 = await table(pg, "#robHead", "#robBody")
        check(all(rob2[i]["Holdout net"] == rob[i]["Holdout net"] and rob2[i]["Ranked net"] == rob[i]["Ranked net"] for i in rob), "same figures")
        # reshuffling keeps the total: in profit in all or none of the simulations
        check(all(r["MC in profit"] in ("0%", "100%") for r in rob2.values()), [r["MC in profit"] for r in rob2.values()])

        # a candidate opens on the chart
        first = next(iter(rob2))
        await pg.locator(f"#robBody tr[data-i='{first}'] button[data-chart]").click()
        await pg.wait_for_function("() => !document.querySelector('#stRun').disabled && /Done|Ended|Stopped/.test(document.querySelector('#stStat').textContent)", timeout=300000)
        check("MA robust (" in await pg.inner_text("#stSaved"), "opened on the chart")

        # saved with the optimization: reopening it from the Library brings the results back
        await pg.click("#stClose")
        await pg.click("#bLib")
        await pg.click("#libTabs [data-lt=op]")
        await pg.wait_for_selector("#libBody [data-opopen]", timeout=30000)
        await pg.locator("#libBody [data-opopen]").first.click()
        await pg.wait_for_selector("#stOpt:not([hidden])", timeout=30000)
        await pg.wait_for_function("() => !document.querySelector('#robOut').hidden && document.querySelectorAll('#robBody tr[data-i]').length === 5", timeout=60000)
        check(await pg.locator("#robWfOut tbody tr").count() == 4, "walk-forward settings restored")
        check(not errors, errors)

        # iPhone: the same panel, one card per row, results in a scrolling table
        shim = open(os.path.join(ROOT, "ios", "Sources", "TapeReplay", "ios-shim.js"), encoding="utf-8").read()
        ph = await b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True, color_scheme="dark")
        await ph.add_init_script(shim)
        pp = await ph.new_page()
        pp.on("pageerror", lambda e: errors.append(str(e)))
        await pp.goto(URL)
        await pp.wait_for_selector("#home:not([hidden])", timeout=30000)
        await pp.click("#hNew")
        await pp.wait_for_selector("#modal:not([hidden])", timeout=30000)
        await pp.click("#mStart")
        await pp.wait_for_function("() => document.querySelector('#modal').hidden", timeout=120000)
        await pp.wait_for_timeout(1300)
        await pp.evaluate("document.querySelector('.tour [data-t=skip]')?.click()")
        await pp.click("#mnav [data-mv=more]")
        await pp.click("#mmore [data-go=bStrat]")
        await pp.click("#stTabs [data-st=code]")
        await pp.fill("#stName", "MA phone robust")
        await pp.evaluate("c => { const t = document.querySelector('#stSrc'); t.value = c; t.dispatchEvent(new Event('input')); }", CODE)
        await pp.select_option("#stTf", "5m")
        await pp.evaluate("() => { const f = document.querySelector('#stFrom'), t = document.querySelector('#stTo'); const d = new Date(f.value); d.setDate(d.getDate() + 5); t.value = d.toISOString().slice(0, 10); }")
        await pp.click("#stTabs [data-st=opt]")
        await pp.wait_for_selector("#optRows tr[data-n=FAST]", timeout=120000)
        await set_row(pp, "FAST", "5, 9")
        await set_row(pp, "SLOW", "21, 30")
        await pp.fill("#optMin", "1")
        await pp.click("#optRun")
        await pp.wait_for_function("() => !document.querySelector('#optRun').disabled && /done/i.test(document.querySelector('#stStat').textContent)", timeout=600000)
        await pp.fill("#robPct", "100")
        await pp.fill("#robWfN", "2")
        await pp.fill("#robMcN", "200")
        await pp.click("#robRun")
        await pp.wait_for_function("() => !document.querySelector('#robOut').hidden && !document.querySelector('#robRun').disabled", timeout=600000)
        check(await pp.locator("#robBody tr[data-i]").count() == 4, "phone: four candidates")
        cards = await pp.eval_on_selector_all("#robBox .robgrid .stcard", "cs => cs.map(c => Math.round(c.getBoundingClientRect().width))")
        check(len(set(cards)) == 1 and cards[0] > 300, f"phone: cards full width {cards}")
        await pp.evaluate("document.querySelector('#robBox').scrollIntoView()")
        await pp.screenshot(path=f"{OUT}/robust-2-phone.png")
        check(not errors, errors)
        await b.close()
    print(f"robust: {passed} checks passed")


asyncio.run(main())
