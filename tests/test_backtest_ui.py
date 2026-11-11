"""The new app's Backtest page (app/index.html) in Chromium: the MA cross template (Python) and its JavaScript version on
practice NQ, a syntax error in the console, Show on chart (the run as a replay session with its trades), a smart
optimization of two settings and Use in code, robustness tests, and the phone layout. Builds the page and copies it
to desktop/web first (set TAPE_SKIP_BUILD=1 to use the copy already there); the server sends the desktop app's
cross-origin isolation headers, so the optimizer's workers share the bars:
    python tests/test_backtest_ui.py [folder for screenshots]
"""
import asyncio
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import http.server

from playwright.async_api import async_playwright

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
APP = os.path.join(ROOT, "app")
WEB = os.path.join(ROOT, "desktop", "web")
OUT = sys.argv[1] if len(sys.argv) > 1 else tempfile.mkdtemp(prefix="tape-shots-")
os.makedirs(OUT, exist_ok=True)
passed = 0


def check(cond, msg):
    global passed
    if not cond:
        raise AssertionError(msg)
    passed += 1


def build():
    if os.environ.get("TAPE_SKIP_BUILD") != "1":
        subprocess.check_call([shutil.which("npm") or "npm", "run", "build", "--", "--logLevel", "warn"], cwd=APP)
        shutil.rmtree(WEB, ignore_errors=True)
        shutil.copytree(os.path.join(APP, "dist"), WEB)
    # Python for strategies: the build copies app/public/pyodide (npm run pyodide) when it is there
    if not os.path.exists(os.path.join(WEB, "pyodide", "pyodide.mjs")):
        src = os.path.join(APP, "public", "pyodide")
        if not os.path.exists(os.path.join(src, "pyodide.mjs")):
            raise SystemExit("Python is missing: run `npm run pyodide` in app/ first.")
        shutil.copytree(src, os.path.join(WEB, "pyodide"), dirs_exist_ok=True)


def serve():
    class H(http.server.SimpleHTTPRequestHandler):
        extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, ".wasm": "application/wasm", ".mjs": "text/javascript"}

        def __init__(self, *a, **k):
            super().__init__(*a, directory=WEB, **k)

        def end_headers(self):  # as desktop/app.py: shared memory for the optimizer's workers
            self.send_header("Cross-Origin-Opener-Policy", "same-origin")
            self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
            self.send_header("Cross-Origin-Resource-Policy", "same-origin")
            super().end_headers()

        def log_message(self, *a):
            pass

    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{srv.server_address[1]}/index.html"


CONSOLE = "() => [...document.querySelectorAll('.bt-cons .bt-lines > div')].map(d => d.textContent)"
TILE = "(k) => [...document.querySelectorAll('.bt-tiles .stat')].find(s => s.querySelector('span').textContent === k)?.querySelector('b').textContent"


async def run_and_wait(pg, timeout=180000):
    await pg.click(".bt-run button:has-text('Run backtest')")
    # a finished run shows its results; anything else stays on the code and its console
    await pg.wait_for_function("() => { const s = document.querySelector('.bt-cons .bt-status span'); return document.querySelector('.bt-results') || (s && /^(Done|Stopped|Fix|Could|Check|Ended)/.test(s.textContent)) }", timeout=timeout)
    if await pg.locator(".bt-results").count():
        await pg.click(".bt-head .tabs button:has-text('Code')")
    return await pg.evaluate("() => document.querySelector('.bt-cons .bt-status span').textContent")


async def set_dates(pg, a, b):
    await pg.fill("input[aria-label='From']", a)
    await pg.fill("input[aria-label='To']", b)


async def main():
    build()
    url = serve()
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={"width": 1440, "height": 900}, color_scheme="dark")
        await ctx.grant_permissions(["clipboard-read", "clipboard-write"])
        pg = await ctx.new_page()
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        await pg.goto(url)
        await pg.click("nav.nav button.item:has-text('Backtest')")
        await pg.wait_for_selector(".bt-ta")
        check(await pg.evaluate("() => crossOriginIsolated"), "the page is cross-origin isolated (shared memory for the workers)")
        check("MA cross" in await pg.locator(".bt-name").inner_text(), "the MA cross template is ready")

        # ---- the layout: the code folds, the run settings fill the page, the New menu fits on screen ----
        rw = (await pg.locator(".bt-runcard").bounding_box())["width"]
        check(rw > 600, f"the run settings are in the main area, not a narrow column ({rw:.0f}px)")
        check(await pg.locator(".bt-run .field:has-text('Commission') input").is_visible(), "the costs show without asking")
        await pg.click(".bt-code .bt-foldhead")
        check(await pg.locator(".bt-ta").count() == 0 and "Moving-average cross" in await pg.locator(".bt-code .bt-sum").inner_text(), "the code folds to a one-line summary")
        await pg.reload()
        await pg.click("nav.nav button.item:has-text('Backtest')")
        await pg.wait_for_selector(".bt-code .bt-foldhead")
        check(await pg.locator(".bt-ta").count() == 0, "and stays folded after a reload")
        await pg.click(".bt-code .bt-foldhead")
        await pg.wait_for_selector(".bt-ta")
        h0 = (await pg.locator(".bt-editor").bounding_box())["height"]
        g = await pg.locator(".bt-grip").bounding_box()
        await pg.mouse.move(g["x"] + g["width"] / 2, g["y"] + 4)
        await pg.mouse.down()
        await pg.mouse.move(g["x"] + g["width"] / 2, g["y"] + 124, steps=6)
        await pg.mouse.up()
        h1 = (await pg.locator(".bt-editor").bounding_box())["height"]
        check(abs(h1 - h0 - 120) < 3, f"the code is taller after dragging its edge ({h0:.0f} -> {h1:.0f})")
        await pg.click(".bt-listhead button:has-text('New')")
        mb = await pg.locator(".bt-newmenu").bounding_box()
        nav = await pg.locator("nav.nav").bounding_box()
        check(mb["x"] >= nav["x"] + nav["width"] and mb["x"] + mb["width"] <= 1440 and mb["y"] + mb["height"] <= 900, f"the New menu opens fully on screen ({mb})")
        await pg.keyboard.press("Escape")
        check(await pg.locator(".bt-newmenu").count() == 0, "Escape closes the New menu")
        await pg.click(".bt-listhead button:has-text('New')")
        await pg.mouse.click(900, 500)
        check(await pg.locator(".bt-newmenu").count() == 0, "a click outside closes it")
        await pg.screenshot(path=f"{OUT}/backtest-0-layout.png")

        # ---- the Python template on three days of practice NQ ----
        await set_dates(pg, "2026-04-07", "2026-04-09")
        st = await run_and_wait(pg)
        lines = await pg.evaluate(CONSOLE)
        check(st == "Done", f"the run finishes ({st}): {lines[-5:]}")
        check(any(l.startswith("Python ready in") for l in lines), "Python loads on the first run")
        check(any(l.startswith("Running ") and "on 5m candles" in l for l in lines), f"the Running line ({[l for l in lines if l.startswith('Running')]})")
        check(any(l.startswith("Finished in") for l in lines) and any(" trades, net " in l for l in lines), "Finished and the summary line")
        check(any("Market" in l and "@" in l for l in lines), "on_fill prints reach the console")
        await pg.click(".bt-head .tabs button:has-text('Results')")
        await pg.wait_for_selector(".bt-tiles")
        trades = int((await pg.evaluate(TILE, "Trades")).split(" ")[0])
        net = await pg.evaluate(TILE, "Net P&L")
        check(trades > 5, f"MA cross makes trades ({trades}, net {net})")
        rows = await pg.locator(".bt-trades tbody tr").count()
        check(rows == min(trades, 500), f"the trade list ({rows} rows for {trades} trades)")
        check(await pg.locator(".bt-eq canvas").count() > 0, "the equity curve")
        await pg.click("button:has-text('Copy trades (CSV)')")
        csv = await pg.evaluate("() => navigator.clipboard.readText()")
        check(csv.startswith("id,side,size,entry_time") and len(csv.strip().split("\n")) == trades + 1, "Copy trades: every trade as CSV")
        await pg.screenshot(path=f"{OUT}/backtest-1-results.png")

        # ---- Show on chart: the run as a replay session with its trades ----
        await pg.click("button:has-text('Show on chart')")
        await pg.wait_for_selector(".pane .lw canvas", timeout=60000)
        await pg.wait_for_timeout(500)
        title = await pg.locator(".ctx .title").first.inner_text()
        check("MA cross" in title and "Automated" in title, f"the session is named after the strategy ({title})")
        hist = await pg.locator(".dock .tabs button:has-text('History')").inner_text()
        check(f"({trades})" in hist, f"the run's trades are the session's history ({hist} vs {trades})")
        await pg.screenshot(path=f"{OUT}/backtest-2-chart.png")
        await pg.click("nav.nav button.item:has-text('Backtest')")
        await pg.wait_for_selector(".bt-tiles")
        check(await pg.evaluate(TILE, "Net P&L") == net, "the results are still there after the chart")

        # ---- a syntax error shows in the console ----
        await pg.click(".bt-head .tabs button:has-text('Code')")
        code = await pg.input_value(".bt-ta")
        await pg.fill(".bt-ta", code.replace("def on_bar(ctx, bar):", "def on_bar(ctx, bar)"))
        await pg.click(".bt-code .bt-foldhead")  # folded: the error opens it
        st = await run_and_wait(pg)
        lines = await pg.evaluate(CONSOLE)
        check(st.startswith("Fix the error") and any(l.startswith("SyntaxError") for l in lines) and any("line" in l for l in lines), f"a syntax error in the console ({st}: {lines})")
        sel = await pg.evaluate("() => { const t = document.querySelector('.bt-ta'); return t.value.slice(t.selectionStart, t.selectionEnd) }")
        check(sel.strip() == "def on_bar(ctx, bar)", f"the code shows the failing line selected ({sel!r})")
        await pg.fill(".bt-ta", code)

        # ---- the JavaScript template ----
        await pg.click("button:has-text('New')")
        await pg.click(".bt-newmenu button:has-text('MA cross'):has-text('JavaScript')")
        check("JavaScript" in await pg.locator(".bt-codehead .tag").inner_text(), "a JavaScript strategy from its template")
        st = await run_and_wait(pg)
        check(st == "Done", f"the JavaScript run finishes ({st})")
        await pg.click(".bt-head .tabs button:has-text('Results')")
        await pg.wait_for_selector(".bt-tiles")
        jt = int((await pg.evaluate(TILE, "Trades")).split(" ")[0])
        check(jt == trades and await pg.evaluate(TILE, "Net P&L") == net, f"JavaScript MA cross makes the same trades as Python ({jt}, {await pg.evaluate(TILE, 'Net P&L')} vs {trades}, {net})")
        # a runtime error with the strategy's line
        await pg.click(".bt-head .tabs button:has-text('Code')")
        jcode = await pg.input_value(".bt-ta")
        await pg.fill(".bt-ta", jcode.replace("if (closes.length < SLOW) return;", "if (closes.length < SLOW) return;\n  if (bar.index === 30) null.boom();"))
        st = await run_and_wait(pg)
        lines = await pg.evaluate(CONSOLE)
        check("error" in st and any(l.startswith("TypeError") for l in lines) and any("null.boom()" in l for l in lines), f"a runtime error with its line ({st}: {lines[-4:]})")
        await pg.fill(".bt-ta", jcode)
        # rename, then delete with a confirmation
        await pg.click(".bt-codehead button:has-text('Rename')")
        await pg.fill("input[aria-label='Strategy name']", "My JS cross")
        await pg.press("input[aria-label='Strategy name']", "Enter")
        check(await pg.locator(".bt-item.on .nm").inner_text() == "My JS cross", "renamed")
        await pg.click("button[aria-label='Delete My JS cross']")
        check(await pg.locator(".bt-item:has-text('My JS cross')").count() == 1, "deleting asks first")
        await pg.click("button:has-text('Delete it')")
        check(await pg.locator(".bt-item:has-text('My JS cross')").count() == 0, "deleted")
        await pg.click(".bt-item:has-text('MA cross')")

        # ---- a smart optimization of FAST and SLOW, then Use in code ----
        await pg.click(".bt-head .tabs button:has-text('Optimize')")
        await pg.wait_for_selector("input[aria-label='Try FAST']", timeout=60000)
        names = await pg.locator(".bt-ptable tbody td.ui b").all_inner_texts()
        check(names == ["FAST", "SLOW", "STOP", "TARGET"], f"the settings are found ({names})")
        await pg.check("input[aria-label='Try FAST']")
        await pg.check("input[aria-label='Try SLOW']")
        await pg.fill("input[aria-label='Values for FAST']", "3..12")
        await pg.fill("input[aria-label='Values for SLOW']", "15..60 step 5")
        await pg.fill(".bt-rules", "FAST < SLOW")
        await pg.click(".seg button:has-text('Smart')")
        count = await pg.locator(".bt-optrun span").inner_text()
        check("100 combinations" in count and "trying 60" in count, f"the count line ({count})")
        await pg.click("button:has-text('Run optimization')")
        await pg.wait_for_function("() => /Optimization done|Stopped|failed|more than/.test(document.querySelector('.bt-optstat span')?.textContent || '')", timeout=600000)
        st = await pg.locator(".bt-optstat span").first.inner_text()
        check(st.startswith("Optimization done") and "failed" not in st, f"the optimization finishes ({st})")
        n = await pg.locator(".bt-rtable tbody tr").count()
        check(50 <= n <= 60, f"a results table ({n} rows)")
        heads = await pg.locator(".bt-rtable thead th").all_inner_texts()
        check(any("Check: net" in h for h in heads) and any("Net ÷ max drawdown" in h for h in heads), f"columns with the Check period ({heads})")
        first = await pg.locator(".bt-rtable tbody tr").first.locator("td").all_inner_texts()
        await pg.locator(".bt-rtable tbody tr").first.click()
        before = await pg.input_value(".bt-ta") if await pg.locator(".bt-ta").count() else code
        await pg.click(".bt-selbar button:has-text('Use in code')")
        await pg.click(".bt-head .tabs button:has-text('Code')")
        after = await pg.input_value(".bt-ta")
        want = f"FAST, SLOW = {first[1]}, {first[2]}"
        check(want in after and after != code, f"Use in code writes the best settings ({want})")
        await pg.screenshot(path=f"{OUT}/backtest-3-code.png")

        # ---- robustness on the best half ----
        await pg.click(".bt-head .tabs button:has-text('Robustness')")
        await pg.fill("input[aria-label='Test the best percent']", "20")
        await pg.fill("input[aria-label='Walk-forward windows']", "3")
        await pg.fill("input[aria-label='Simulations']", "300")
        await pg.click("button:has-text('Run robustness tests')")
        await pg.wait_for_function("() => /Robustness tests done|must|Pick|ends|No ranked|Tick/.test(document.querySelector('.bt-optrun [role=status]')?.textContent || '')", timeout=600000)
        st = await pg.locator(".bt-optrun [role=status]").inner_text()
        check(st.startswith("Robustness tests done"), f"robustness finishes ({st})")
        rr = await pg.locator(".bt-robtable tbody tr").count()
        check(rr >= 5, f"robustness rows ({rr})")
        heads = await pg.locator(".bt-robtable thead th").all_inner_texts()
        check(any("Holdout net" in h for h in heads) and any("WF windows" in h for h in heads) and any("MC in profit" in h for h in heads) and any("Passed" in h for h in heads), f"robustness columns ({heads})")
        cell = await pg.locator(".bt-robtable tbody tr").first.locator("td").last.inner_text()
        check(" of " in cell, f"passes as 'k of n' ({cell})")
        check("candidates passed every test" in await pg.locator(".bt-optres .bt-reshead p").inner_text(), "the summary")
        check(await pg.locator(".bt-wf tbody tr").count() == 3, "three walk-forward windows")
        await pg.screenshot(path=f"{OUT}/backtest-4-robust.png")

        # ---- the saved optimization in the Library ----
        await pg.click("nav.nav button.item:has-text('Library')")
        await pg.click(".tabs button:has-text('Optimizations')")
        await pg.wait_for_selector(".bt-saved .librow:has-text('MA cross optimization')", timeout=10000)
        check(await pg.locator(".bt-saved .librow").count() >= 1, "the optimization is saved to the Library")
        await pg.click(".bt-saved .librow button:has-text('Open')")
        await pg.wait_for_selector(".bt-rtable tbody tr")
        try:  # the rows come in as the saved results load
            await pg.wait_for_function(f"() => document.querySelectorAll('.bt-rtable tbody tr').length === {n}", timeout=10000)
        except Exception:
            pass
        check(await pg.locator(".bt-rtable tbody tr").count() == n, f"it reopens with its results ({await pg.locator('.bt-rtable tbody tr').count()} of {n} rows)")

        # ---- a prop challenge in the run (JavaScript, buying new evaluations) ----
        await pg.click(".bt-head .tabs button:has-text('Code')")
        await pg.click("button:has-text('New')")
        await pg.click(".bt-newmenu button:has-text('MA cross'):has-text('JavaScript')")
        await pg.check(".bt-run label:has-text('Practice a prop firm challenge') input")
        await pg.check(".bt-run label:has-text('Buy a new evaluation') input")
        st = await run_and_wait(pg)
        lines = await pg.evaluate(CONSOLE)
        check(st == "Done" and any(l.startswith("Prop simulation: ") for l in lines), f"the prop simulation's summary ({st}: {lines[-2:]})")
        await pg.click(".bt-head .tabs button:has-text('Results')")
        ev = await pg.evaluate(TILE, "Evaluations")
        check(await pg.evaluate(TILE, "Your result") is not None and ev and "passed" in ev, f"prop tiles ({ev})")
        await pg.screenshot(path=f"{OUT}/backtest-5-prop.png")
        check(not errors, f"no page errors: {errors}")
        await ctx.close()

        # ---- phones: one part at a time ----
        ctx = await b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True, color_scheme="dark")
        pg = await ctx.new_page()
        await pg.goto(url)
        await pg.click(".mnav button:has-text('More')")
        await pg.click(".msheet button:has-text('Backtest')")
        await pg.wait_for_selector(".bt-ta")
        w = await pg.evaluate("() => document.querySelector('.bt-ta').getBoundingClientRect().width")
        check(w > 300 and not await pg.locator(".bt-run").is_visible() and not await pg.locator(".bt-list").is_visible(), f"phones: the editor full width, alone ({w})")
        await pg.click(".bt-head .tabs button:has-text('Run')")
        check(await pg.locator(".bt-run").is_visible() and not await pg.locator(".bt-ta").is_visible(), "phones: the Run panel on its own")
        await pg.click(".bt-head .tabs button:has-text('Strategies')")
        check(await pg.locator(".bt-list").is_visible(), "phones: the strategy list")
        await pg.screenshot(path=f"{OUT}/backtest-6-phone.png")
        await b.close()
    print(f"backtest page: {passed} checks passed")


asyncio.run(main())
