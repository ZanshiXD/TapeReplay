"""Chart studies in the new app (app/next.html), in Chromium: price zones and session lines added from Indicators, drawn
on each chart's study layer, Z to show and hide the zones, their settings, kept after a reload, taken off again, and
the replay staying smooth at 300x with both on. Builds the page and copies it to desktop/web first (set
TAPE_SKIP_BUILD=1 to use the copy already there):
    python tests/test_studies.py [folder for screenshots]
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
OUT = sys.argv[1] if len(sys.argv) > 1 else tempfile.mkdtemp(prefix="tape-studies-")
os.makedirs(OUT, exist_ok=True)
passed = 0


def check(cond, msg):
    global passed
    if not cond:
        raise AssertionError(msg)
    passed += 1


def build():
    if os.environ.get("TAPE_SKIP_BUILD") == "1":
        return
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
    return f"http://127.0.0.1:{srv.server_address[1]}/next.html"


build()
URL = serve()
# what each chart's study layer drew last (it notes the counts on the canvas), and how many of its pixels are painted
LAYERS = """() => [...document.querySelectorAll('.pane .lw canvas.studylayer')].map(c => {
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let px = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i]) px++;
    return { zones: +(c.dataset.zones || 0), sessions: +(c.dataset.sessions || 0), px,
             under: !!c.parentElement.querySelector(':scope > canvas.studylayer ~ canvas.drawlayer') };  // drawn before (under) the drawings
})"""
FPS = """() => new Promise(r => { let n = 0, t0 = performance.now(), worst = 0, last = t0;
    const f = now => { n++; worst = Math.max(worst, now - last); last = now; if (now - t0 < 2000) requestAnimationFrame(f); else r({ fps: n / ((now - t0) / 1000), worst }); };
    requestAnimationFrame(f); })"""


async def start(pg):
    await pg.goto(URL)
    await pg.click("text=Both, side by side")
    await pg.click("button:has-text('Start with these now')")
    await pg.wait_for_selector(".pane .lw canvas", timeout=30000)
    await pg.wait_for_timeout(300)


async def layers(pg):
    await pg.wait_for_timeout(150)  # a frame or two to redraw
    return await pg.evaluate(LAYERS)


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={"width": 1440, "height": 900}, color_scheme="dark")
        pg = await ctx.new_page()
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        await start(pg)
        ls = await layers(pg)
        check(len(ls) == 2 and all(x["under"] for x in ls), f"a study layer on each chart, under the drawings: {ls}")
        check(all(x["px"] == 0 for x in ls), "nothing drawn before a study is added")
        # add both from Indicators
        await pg.click("button:has-text('Indicators')")
        await pg.click("text=+ Price zones (FVG, order blocks)")
        await pg.click("text=+ Session lines")
        check(await pg.locator(".pop[aria-label='Indicators'] button[aria-label='Remove Price zones']").count() == 1, "price zones listed on the charts")
        check(await pg.locator(".pop[aria-label='Indicators'] button[aria-label='Remove Session lines']").count() == 1, "session lines listed on the charts")
        await pg.click(".pop[aria-label='Indicators'] button[aria-label='Close']")
        ls = await layers(pg)
        print("drawn:", ls)
        check(all(x["zones"] > 0 and x["sessions"] > 0 and x["px"] > 500 for x in ls), f"zones and session lines drawn on both charts: {ls}")
        await pg.screenshot(path=f"{OUT}/studies-1-on.png")
        # Z hides the zones and shows them again
        await pg.mouse.click(700, 400)
        await pg.keyboard.press("z")
        off = await layers(pg)
        check(all(x["zones"] == 0 and x["sessions"] > 0 for x in off), f"Z hides the zones: {off}")
        check(all(o["px"] < x["px"] for o, x in zip(off, ls)), "fewer pixels without the zones")
        check(await pg.locator(".toast:has-text('Price zones off.')").count() == 1, "toast: zones off")
        await pg.keyboard.press("z")
        on = await layers(pg)
        check(all(x["zones"] > 0 for x in on), f"Z shows them again: {on}")
        # settings: shading the sessions paints more; fewer zones of each kind draws fewer; a higher timeframe still finds zones
        await pg.click("button:has-text('Indicators')")
        pop = ".pop[aria-label='Indicators']"
        await pg.click(f"{pop} button[aria-label='Remove Session lines'] >> xpath=preceding-sibling::button[1]")  # Edit
        before = await layers(pg)
        await pg.click(f"{pop} label:has-text('Shade each session') input")
        shaded = await layers(pg)
        check(all(s["px"] > x["px"] for s, x in zip(shaded, before)), f"shading paints the sessions: {before} -> {shaded}")
        await pg.click(f"{pop} button[aria-label='Remove Price zones'] >> xpath=preceding-sibling::button[1]")  # Edit
        await pg.fill(f"{pop} input[aria-label='Newest of each kind']", "1")
        await pg.press(f"{pop} input[aria-label='Newest of each kind']", "Tab")
        one = await layers(pg)
        check(all(0 < x["zones"] <= 5 for x in one), f"one of each kind at most: {one}")
        await pg.select_option(f"{pop} select[aria-label='Timeframe for price zones']", "15m")
        tf15 = await layers(pg)
        check(all(x["zones"] > 0 for x in tf15), f"zones on 15m candles: {tf15}")
        await pg.fill(f"{pop} input[aria-label='Newest of each kind']", "8")
        await pg.press(f"{pop} input[aria-label='Newest of each kind']", "Tab")
        await pg.select_option(f"{pop} select[aria-label='Timeframe for price zones']", "chart")
        await pg.screenshot(path=f"{OUT}/studies-2-settings.png")
        await pg.click(f"{pop} button[aria-label='Close']")
        # smooth playback at 300x with both on, and the zones keep up with the new candles
        await pg.click(".tip .acts button:first-child")  # Play
        await pg.click(".chips button:has-text('300×')")
        await pg.wait_for_timeout(500)
        perf = await pg.evaluate(FPS)
        print("playback with studies:", perf)
        check(perf["fps"] > 50, f"smooth playback at 300x with zones and sessions: {perf}")
        await pg.keyboard.press("Space")
        played = await layers(pg)
        check(all(x["zones"] > 0 and x["sessions"] > 0 for x in played), f"still drawn after playing: {played}")
        await pg.screenshot(path=f"{OUT}/studies-3-played.png")
        # kept after a reload
        await start(pg)
        again = await layers(pg)
        check(all(x["zones"] > 0 and x["sessions"] > 0 for x in again), f"studies kept for the next session: {again}")
        # taken off the charts
        await pg.click("button:has-text('Indicators')")
        await pg.click(f"{pop} button[aria-label='Remove Price zones']")
        await pg.click(f"{pop} button[aria-label='Remove Session lines']")
        check(await pg.locator(f"{pop} >> text=+ Price zones (FVG, order blocks)").count() == 1, "price zones can be added again")
        gone = await layers(pg)
        check(all(x["px"] == 0 for x in gone), f"nothing drawn once removed: {gone}")
        check(not errors, f"no page errors: {errors}")
        await b.close()
    print(f"studies: {passed} checks passed; screenshots in {OUT}")


asyncio.run(main())
