"""Python indicators in the new app (app/index.html), in Chromium with Pyodide in a worker: a template added from
Indicators, its plot series, levels, markers and boxes drawn on both charts (the Python layer notes what it drew on
its canvas), a lower pane, the legend, print() and a runtime error with its traceback in the console, a setting
changed and applied, a script deleted, and the replay staying smooth at 300x with indicators on. Builds the page and
copies it to desktop/web first (set TAPE_SKIP_BUILD=1 to use the copy already there):
    python tests/test_pyind.py [folder for screenshots]
"""
import asyncio
import functools
import http.server
import os
import shutil
import subprocess
import sys
import tempfile
import threading

from playwright.async_api import async_playwright

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
APP = os.path.join(ROOT, "app")
WEB = os.path.join(ROOT, "desktop", "web")
OUT = sys.argv[1] if len(sys.argv) > 1 else tempfile.mkdtemp(prefix="tape-pyind-")
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
    # Python comes with the page (app/public/pyodide, fetched by app/scripts/fetch_pyodide.py)
    if not os.path.exists(os.path.join(WEB, "pyodide", "pyodide.mjs")):
        src = os.path.join(APP, "public", "pyodide")
        if not os.path.exists(os.path.join(src, "pyodide.mjs")):
            sys.exit("Python (Pyodide) is not in app/public/pyodide: run python3 app/scripts/fetch_pyodide.py first")
        shutil.rmtree(os.path.join(WEB, "pyodide"), ignore_errors=True)
        shutil.copytree(src, os.path.join(WEB, "pyodide"))


def serve():
    class H(http.server.SimpleHTTPRequestHandler):
        extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, ".wasm": "application/wasm", ".mjs": "text/javascript"}

        def log_message(self, *a):
            pass
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(H, directory=WEB))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{srv.server_address[1]}/index.html"


build()
URL = serve()
# what each chart's Python layer drew last (it notes the counts on its canvas)
LAYERS = """() => [...document.querySelectorAll('.pane .lw canvas.pylayer')].map(c => {
    const d = c.dataset, n = k => +(d[k] || 0);
    return { plots: n('plots'), hlines: n('hlines'), fills: n('fills'), bg: n('bg'), boxes: n('boxes'), lines: n('lines'), labels: n('labels'),
             marks: n('marks'), bands: n('bands'), levels: (d.levels || '').split(',').filter(Boolean).map(Number),
             under: !!(c.nextElementSibling && c.nextElementSibling.classList.contains('drawlayer')),
             over: !!(c.previousElementSibling && c.previousElementSibling.classList.contains('studylayer')) };
})"""
FPS = """() => new Promise(r => { let n = 0, t0 = performance.now(), worst = 0, last = t0;
    const f = now => { n++; worst = Math.max(worst, now - last); last = now; if (now - t0 < 2000) requestAnimationFrame(f); else r({ fps: n / ((now - t0) / 1000), worst }); };
    requestAnimationFrame(f); })"""
POP = ".pop[aria-label='Indicators']"
ED = ".modal.pyed"
# a box over the last few candles, a level, a print on the first candle, and a division by zero on candle 40
CUSTOM = '''# a test indicator
N = 5

def init(ctx):
    ctx.b = None

def on_bar(ctx, bar):
    if bar.index == 0:
        print("hello from", ctx.symbol)
    ctx.plot(bar.close, "Close", "fg", style="points")
    if ctx.b is None:
        ctx.b = ctx.box(bar.index, bar.high, bar.index, bar.low, text="Box")
    ctx.b.set(left=bar.index - N, right=bar.index, top=bar.high + 1, bottom=bar.low - 1)
    ctx.hline(bar.close, "Last")
    if bar.index == 40 and STOP:
        x = 1 / 0
'''


async def wait_for(pg, fn, what, timeout=60000):
    """polls the layers until fn(layers) holds"""
    t = 0
    ls = None
    while t < timeout:
        ls = await pg.evaluate(LAYERS)
        if ls and fn(ls):
            return ls
        await pg.wait_for_timeout(250)
        t += 250
    raise AssertionError(f"{what}: {ls}")


async def new_from(pg, tpl):
    await pg.click(f"{POP} button:has-text('+ New indicator')")
    await pg.click(f"{POP} [aria-label='Python templates'] button:has-text('{tpl}')")
    await pg.wait_for_selector(ED)


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={"width": 1440, "height": 900}, color_scheme="dark")
        pg = await ctx.new_page()
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        await pg.goto(URL)
        await pg.click("text=Both, side by side")
        await pg.click("button:has-text('Start with these now')")
        await pg.wait_for_selector(".pane .lw canvas.pylayer", timeout=30000)
        ls = await pg.evaluate(LAYERS)
        check(len(ls) == 2 and all(x["under"] and x["over"] for x in ls), f"a Python layer on each chart, over the studies and under the drawings: {ls}")

        # RSI from the templates: a plot in a pane under the chart, three levels, the legend
        await pg.click("button:has-text('Indicators')")
        await new_from(pg, "RSI")
        check(await pg.input_value(f"{ED} input[aria-label='Indicator name']") == "RSI", "the template's name")
        check("ta.RSI(LENGTH)" in await pg.input_value(f"{ED} textarea[aria-label='Python code']"), "the template's code")
        await pg.click(f"{ED} button:has-text('Add to chart')")
        ls = await wait_for(pg, lambda ls: all(x["plots"] >= 1 and x["bands"] == 1 and sorted(x["levels"]) == [30, 50, 70] for x in ls), "RSI drawn in a lower pane with its levels")
        print("RSI:", ls)
        check(any(x["bg"] > 0 for x in ls), "background tints at the extremes (on whichever chart reaches one)")
        await pg.wait_for_selector(".pane .legend [data-py='RSI']")
        check(await pg.locator(".pane .legend [data-py='RSI']").count() == 2, "RSI value in both legends")
        await pg.wait_for_selector(f"{ED} input[aria-label='HIGH']", timeout=60000)
        check(await pg.input_value(f"{ED} input[aria-label='LENGTH']") == "14", "settings from the code")
        check("Apply to chart" in await pg.inner_text(f"{ED} footer"), "the button reads Apply once it is on the chart")
        # a setting changed: the code is rewritten and the chart's copy runs again
        await pg.fill(f"{ED} input[aria-label='HIGH']", "80")
        await pg.press(f"{ED} input[aria-label='HIGH']", "Enter")
        ls = await wait_for(pg, lambda ls: all(sorted(x["levels"]) == [30, 50, 80] for x in ls), "the new level after HIGH = 80")
        check("HIGH = 80" in await pg.input_value(f"{ED} textarea[aria-label='Python code']"), "the code has the new value")
        await pg.screenshot(path=f"{OUT}/pyind-1-rsi.png")
        await pg.click(f"{ED} button[aria-label='Close']")
        check(await pg.locator(f"{POP} [data-pyind='RSI']").count() == 1, "RSI listed on the charts")
        check(await pg.locator(f"{POP} [data-pyscript='RSI']").count() == 1, "RSI saved in your scripts")

        # EMA cross: two plots, a fill between them and markers where they cross
        await new_from(pg, "EMA cross")
        await pg.click(f"{ED} button:has-text('Add to chart')")
        ls = await wait_for(pg, lambda ls: all(x["plots"] >= 3 and x["fills"] >= 1 and x["marks"] > 0 for x in ls), "EMA cross plots, fill and markers")
        print("EMA cross:", ls)
        await pg.click(f"{ED} button[aria-label='Close']")
        legend = await pg.locator(".pane").first.locator(".legend [data-py]").all_inner_texts()
        check(any(t.startswith("Fast · ") for t in legend) and any(t.startswith("Slow · ") for t in legend), f"plot values in the legend: {legend}")

        # our own: a box, a level, print() in the console, then a runtime error with its traceback
        await new_from(pg, "Blank")
        await pg.fill(f"{ED} input[aria-label='Indicator name']", "Test box")
        await pg.fill(f"{ED} textarea[aria-label='Python code']", CUSTOM.replace("N = 5", "N = 5\nSTOP = False"))
        await pg.click(f"{ED} button:has-text('Add to chart')")
        ls = await wait_for(pg, lambda ls: all(x["boxes"] >= 1 and x["hlines"] >= 4 and x["plots"] >= 4 for x in ls), "the box and the level")
        print("custom:", ls)
        await pg.wait_for_selector(f"{ED} .pycons div:has-text('hello from')")
        check(await pg.locator(f"{ED} .pycons div:has-text('hello from')").count() >= 1, "print() in the console")
        await pg.wait_for_selector(f"{ED} input[aria-label='STOP']")
        await pg.click(f"{ED} input[aria-label='STOP']")  # a bool setting: the division by zero now runs
        await pg.wait_for_selector(f"{ED} .pycons .er:has-text('ZeroDivisionError')", timeout=30000)
        tb = await pg.locator(f"{ED} .pycons .er").all_inner_texts()
        print("console errors:", tb)
        check(any("stopped:" in t for t in tb), "the stop is in the console")
        check(any("line 17, in on_bar" in t for t in tb), f"the traceback names the line: {tb}")
        check(any("x = 1 / 0" in t for t in tb), "and shows the code")
        await pg.wait_for_selector(".toast.err:has-text('Test box stopped: ZeroDivisionError')")
        check("error" in (await pg.inner_text(f"{ED} .pystat")).lower(), "status: stopped with an error")
        await pg.screenshot(path=f"{OUT}/pyind-2-error.png")
        await pg.click(f"{ED} button[aria-label='Close']")
        check(await pg.locator(f"{POP} [data-pyind='Test box'] .err").count() == 1, "error tag in the list")
        # a syntax error is caught before it goes on the chart
        await pg.click(f"{POP} [data-pyscript='Test box'] button:has-text('Edit')")
        await pg.fill(f"{ED} textarea[aria-label='Python code']", "def on_bar(ctx, bar)\n    pass\n")
        await pg.click(f"{ED} button:has-text('Apply to chart')")
        await pg.wait_for_selector(f"{ED} .pystat:has-text('Fix the error')")
        check(await pg.locator(f"{ED} .pycons .er:has-text('SyntaxError')").count() == 1, "the syntax error in the console")
        await pg.click(f"{ED} button[aria-label='Close']")
        # take it off the charts, then delete its script (asked first)
        await pg.click(f"{POP} button[aria-label='Remove Test box']")
        check(await pg.locator(f"{POP} [data-pyind='Test box']").count() == 0, "removed from the charts")
        await pg.click(f"{POP} button[aria-label='Delete Test box']")
        check(await pg.locator(f"{POP} [role='alertdialog']").count() == 1, "delete asks first")
        await pg.click(f"{POP} [role='alertdialog'] button:has-text('Cancel')")
        check(await pg.locator(f"{POP} [data-pyscript='Test box']").count() == 1, "cancel keeps it")
        await pg.click(f"{POP} button[aria-label='Delete Test box']")
        await pg.click(f"{POP} [role='alertdialog'] button:has-text('Delete')")
        check(await pg.locator(f"{POP} [data-pyscript='Test box']").count() == 0, "the script is deleted")
        ls = await wait_for(pg, lambda ls: all(x["boxes"] == 0 for x in ls), "its box is gone")
        # hide and show
        await pg.click(f"{POP} [data-pyind='RSI'] button:has-text('Hide')")
        await wait_for(pg, lambda ls: all(x["bands"] == 0 and 70 not in x["levels"] for x in ls), "RSI hidden")
        await pg.click(f"{POP} [data-pyind='RSI'] button:has-text('Show')")
        await wait_for(pg, lambda ls: all(x["bands"] == 1 for x in ls), "RSI shown again")
        await pg.click(f"{POP} button[aria-label='Close']")
        # a new timeframe: they start again on its candles
        n5 = (await pg.evaluate(LAYERS))[0]["marks"]
        await pg.click(".seg[aria-label='Timeframe'] button:has-text('15m')")
        ls = await wait_for(pg, lambda ls: all(x["bands"] == 1 and x["plots"] >= 3 and x["marks"] > 0 for x in ls) and ls[0]["marks"] != n5, "run again on 15m candles")
        print("15m:", ls)
        await pg.click(".seg[aria-label='Timeframe'] button:has-text('5m')")
        await wait_for(pg, lambda ls: ls[0]["marks"] == n5, "back on 5m")

        # smooth playback at 300x with RSI and EMA cross on, and they keep up with the new candles
        await pg.click(".tip .acts button:first-child")  # Play
        await pg.click(".chips button:has-text('300×')")
        await pg.wait_for_timeout(500)
        perf = await pg.evaluate(FPS)
        print("playback with Python indicators:", perf)
        check(perf["fps"] > 50, f"smooth playback at 300x with Python indicators: {perf}")
        await pg.keyboard.press("Space")
        ls = await wait_for(pg, lambda ls: all(x["plots"] >= 3 and x["bands"] == 1 for x in ls), "still drawn after playing")
        await pg.screenshot(path=f"{OUT}/pyind-3-played.png")
        # kept for the next session
        await pg.goto(URL)
        await pg.click("text=Both, side by side")
        await pg.click("button:has-text('Start with these now')")
        await wait_for(pg, lambda ls: len(ls) == 2 and all(x["plots"] >= 3 and x["bands"] == 1 for x in ls), "Python indicators kept for the next session")
        check(not errors, f"no page errors: {errors}")
        await b.close()
    print(f"python indicators: {passed} checks passed; screenshots in {OUT}")


asyncio.run(main())
