"""JavaScript indicators in the new app (app/index.html), in Chromium: a JavaScript template added from Indicators (offered
before the Python ones) and drawn on both charts with nothing to load, its setting changed on the card (the code
rewritten), print() and an error with its line in the console, the replay smooth at 300x with it on, and a script
stuck in a loop stopped by itself while the chart keeps playing and the other indicators carry on. Build the page
first (desktop/web; set TAPE_SKIP_BUILD=1 to use the copy there), then:
    python tests/test_jsind.py [folder for screenshots]
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
OUT = sys.argv[1] if len(sys.argv) > 1 else tempfile.mkdtemp(prefix="tape-jsind-")
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
LAYERS = """() => [...document.querySelectorAll('.pane .lw canvas.pylayer')].map(c => {
    const d = c.dataset, n = k => +(d[k] || 0);
    return { plots: n('plots'), hlines: n('hlines'), fills: n('fills'), bg: n('bg'), boxes: n('boxes'), lines: n('lines'), labels: n('labels'),
             marks: n('marks'), bands: n('bands'), levels: (d.levels || '').split(',').filter(Boolean).map(Number) };
})"""
FPS = """() => new Promise(r => { let n = 0, t0 = performance.now(), worst = 0, last = t0;
    const f = now => { n++; worst = Math.max(worst, now - last); last = now; if (now - t0 < 2000) requestAnimationFrame(f); else r({ fps: n / ((now - t0) / 1000), worst }); };
    requestAnimationFrame(f); })"""
CLOCK = "() => document.querySelector('.rbar .lbl .num').textContent"
POP = ".pop[aria-label='Indicators']"
ED = ".modal.pyed"
CUSTOM = """// a test indicator
const N = 5;
const STOP = false;

function init(ctx) {
  ctx.b = null;
}

function on_bar(ctx, bar) {
  if (bar.index === 0) print("hello from", ctx.symbol);
  ctx.plot(bar.close, "Close", { color: "fg", style: "points" });
  if (ctx.b === null) ctx.b = ctx.box(bar.index, bar.high, bar.index, bar.low, { text: "Box" });
  ctx.b.set({ left: bar.index - N, right: bar.index, top: bar.high + 1, bottom: bar.low - 1 });
  if (bar.index === 40 && STOP) {
    const x = null;
    x.y = 1;
  }
}
"""
STUCK = """function on_bar(ctx, bar) {
  if (bar.index > 10) while (true) {}
  ctx.plot(bar.close, "Stuck");
}
"""


async def wait_for(pg, fn, what, timeout=60000):
    t, ls = 0, None
    while t < timeout:
        ls = await pg.evaluate(LAYERS)
        if ls and fn(ls):
            return ls
        await pg.wait_for_timeout(250)
        t += 250
    raise AssertionError(f"{what}: {ls}")


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        pg = await (await b.new_context(viewport={"width": 1440, "height": 900}, color_scheme="dark")).new_page()
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        await pg.goto(URL)
        await pg.click("text=Both, side by side")
        await pg.click("button:has-text('Start with these now')")
        await pg.wait_for_selector(".pane .lw canvas.pylayer", timeout=30000)
        await pg.click(".tip .acts button:nth-child(2)")
        # the frame rate at 300x with no indicators of your own, on this machine now, to compare with
        await pg.click(".chips button:has-text('300×')")
        await pg.keyboard.press("Space")
        await pg.wait_for_timeout(500)
        base = await pg.evaluate(FPS)
        await pg.keyboard.press("Space")
        print("playback without:", base)
        smooth = lambda f: f["fps"] > 50 or f["fps"] >= 0.8 * base["fps"]

        # JavaScript first among the templates
        await pg.click("button:has-text('Indicators')")
        await pg.click(f"{POP} button:has-text('+ New indicator')")
        groups = await pg.locator(f"{POP} [aria-label='Templates'] [role='list']").evaluate_all("els => els.map(e => e.getAttribute('aria-label'))")
        check(groups == ["JavaScript templates", "Python templates"], f"JavaScript templates first: {groups}")
        await pg.click(f"{POP} [aria-label='JavaScript templates'] button:has-text('RSI')")
        await pg.wait_for_selector(ED)
        check(await pg.inner_text(f"{ED} .pyed-t") == "JavaScript", "the editor says JavaScript")
        check("ta.RSI(LENGTH)" in await pg.input_value(f"{ED} textarea[aria-label='JavaScript code']"), "the template's code")
        await pg.wait_for_selector(f"{ED} input[aria-label='HIGH']", timeout=5000)
        check(await pg.input_value(f"{ED} input[aria-label='LENGTH']") == "14", "settings from the code, without loading Python")
        await pg.click(f"{ED} button:has-text('Add to chart')")
        ls = await wait_for(pg, lambda ls: all(x["plots"] >= 1 and x["bands"] == 1 and sorted(x["levels"]) == [30, 50, 70] for x in ls), "JS RSI drawn in a lower pane with its levels", 15000)
        await pg.wait_for_function("() => document.querySelectorAll(\".pane .legend [data-py='RSI']\").length === 2", timeout=10000)
        check(True, "RSI value in both legends")
        await pg.fill(f"{ED} input[aria-label='HIGH']", "80")
        await pg.press(f"{ED} input[aria-label='HIGH']", "Enter")
        await wait_for(pg, lambda ls: all(sorted(x["levels"]) == [30, 50, 80] for x in ls), "the new level after HIGH = 80", 15000)
        check("const HIGH = 80;" in await pg.input_value(f"{ED} textarea[aria-label='JavaScript code']"), "the code has the new value")
        await pg.screenshot(path=f"{OUT}/jsind-1-rsi.png")
        await pg.click(f"{ED} button[aria-label='Close']")
        check(await pg.locator(f"{POP} [data-pyind='RSI'] .pylang").inner_text() == "JS", "listed as JavaScript on the charts")
        check(await pg.locator(f"{POP} [data-pyscript='RSI'] .pylang").inner_text() == "JS", "and in your scripts")

        # one of your own: print(), then an error with its line once the STOP switch is on
        await pg.click(f"{POP} button:has-text('+ New indicator')")
        await pg.click(f"{POP} [aria-label='JavaScript templates'] button:has-text('Blank')")
        await pg.fill(f"{ED} input[aria-label='Indicator name']", "Test box")
        await pg.fill(f"{ED} textarea[aria-label='JavaScript code']", CUSTOM)
        await pg.click(f"{ED} button:has-text('Add to chart')")
        await wait_for(pg, lambda ls: all(x["boxes"] == 1 for x in ls), "its box", 15000)
        await pg.wait_for_selector(f"{ED} .pycons div:has-text('hello from')")
        check(True, "print() in the console")
        await pg.click(f"{ED} input[aria-label='STOP']")
        await pg.wait_for_selector(f"{ED} .pycons .er:has-text('TypeError')", timeout=15000)
        cons = await pg.locator(f"{ED} .pycons").inner_text()
        check("line 16, in on_bar" in cons and "x.y = 1" in cons, f"the error's line in the console: {cons[-300:]}")
        check(await pg.locator(f"{ED} .pystat").inner_text() == "Stopped with an error: see the console", "the status says so")
        await pg.click(f"{ED} button[aria-label='Close']")
        check(await pg.locator(f"{POP} [data-pyind='Test box'] .err").count() == 1, "marked in the list")
        await pg.click(f"{POP} button[aria-label='Remove Test box']")
        await pg.click(f"{POP} button[aria-label='Close']")

        # smooth at 300x with a JS indicator on, and it keeps up
        await pg.click(".chips button:has-text('300×')")
        await pg.keyboard.press("Space")
        await pg.wait_for_timeout(500)
        perf = await pg.evaluate(FPS)
        print("playback with JS indicators:", perf)
        check(smooth(perf), f"smooth playback at 300x with JavaScript indicators: {perf} (without: {base})")
        await pg.keyboard.press("Space")
        await wait_for(pg, lambda ls: all(x["plots"] >= 1 and x["bands"] == 1 for x in ls), "still drawn after playing")

        # a script stuck in a loop: the chart keeps playing, the script is stopped, RSI starts again and carries on
        await pg.click("button:has-text('Indicators')")
        await pg.click(f"{POP} button:has-text('+ New indicator')")
        await pg.click(f"{POP} [aria-label='JavaScript templates'] button:has-text('Blank')")
        await pg.fill(f"{ED} input[aria-label='Indicator name']", "Stuck")
        await pg.fill(f"{ED} textarea[aria-label='JavaScript code']", STUCK)
        await pg.click(f"{ED} button:has-text('Add to chart')")
        await pg.click(f"{ED} button[aria-label='Close']")
        await pg.click(f"{POP} button[aria-label='Close']")
        clock = await pg.evaluate(CLOCK)
        await pg.keyboard.press("Space")
        perf = await pg.evaluate(FPS)
        # (a script spinning takes a whole core: on a busy two-core machine that slows the page a little, never stops it)
        check(perf["fps"] > 20 and await pg.evaluate(CLOCK) != clock, f"the replay plays on while a script is stuck: {perf} (without: {base})")
        await pg.wait_for_selector(".toast.err:has-text('took more than 20 seconds')", timeout=40000)
        await pg.keyboard.press("Space")
        check(True, "the stuck script was stopped")
        await wait_for(pg, lambda ls: all(x["bands"] == 1 and 80 in x["levels"] for x in ls), "RSI started again in a fresh worker", 20000)
        await pg.screenshot(path=f"{OUT}/jsind-2-after-stuck.png")
        await pg.click("button:has-text('Indicators')")
        check(await pg.locator(f"{POP} [data-pyind='Stuck'] .err").count() == 1, "the stuck one is marked")
        await pg.click(f"{POP} button[aria-label='Remove Stuck']")
        await pg.click(f"{POP} button[aria-label='Close']")

        # kept for the next session, still in JavaScript
        await pg.goto(URL)
        await pg.click("text=Both, side by side")
        await pg.click("button:has-text('Start with these now')")
        await wait_for(pg, lambda ls: len(ls) == 2 and all(x["bands"] == 1 for x in ls), "kept for the next session", 20000)
        check(not errors, f"no page errors: {errors}")
        await b.close()
    print(f"js indicators: {passed} checks passed; screenshots in {OUT}")


asyncio.run(main())
