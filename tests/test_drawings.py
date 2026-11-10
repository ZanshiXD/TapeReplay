"""Drawings in the new app (app/index.html), in Chromium, used the way TradingView's are: pick a tool, click the points
(or press and drag), the tool goes back to the cursor, select, drag handles and bodies, undo and redo, the magnet,
Shift+click to measure, the settings dialog, lock, clone, the eraser, removing, a position turned into an order, every
tool in the catalog, and the replay staying smooth with all of them on the chart.

Builds its own test copy of the page (vite build --mode test), which exposes the session to the test:
    python tests/test_drawings.py [folder for screenshots]
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
OUT = sys.argv[1] if len(sys.argv) > 1 else tempfile.mkdtemp(prefix="tape-draw-")
os.makedirs(OUT, exist_ok=True)
passed = 0


def check(cond, msg):
    global passed
    if not cond:
        raise AssertionError(msg)
    passed += 1


def build():
    if os.environ.get("TAPE_SKIP_BUILD") != "1":
        subprocess.check_call([shutil.which("npm") or "npm", "run", "build", "--", "--mode", "test", "--outDir", "dist-test", "--logLevel", "warn"], cwd=APP)
    return os.path.join(APP, "dist-test")


def serve(web):
    class H(http.server.SimpleHTTPRequestHandler):
        extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, ".wasm": "application/wasm", ".mjs": "text/javascript"}

        def log_message(self, *a):
            pass
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(H, directory=web))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{srv.server_address[1]}/index.html"


URL = serve(build())
N = "window.__next"
ITEMS = f"() => {N}.session.drawings.items.length"


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        pg = await (await b.new_context(viewport={"width": 1440, "height": 900}, color_scheme="dark")).new_page()
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.on("console", lambda m: errors.append(m.text) if m.type == "error" or "drawing" in m.text else None)
        await pg.goto(URL)
        await pg.click("button:has-text('Start with these now')")
        await pg.wait_for_selector(".pane .lw canvas", timeout=30000)
        await pg.click(".tip .acts button:nth-child(2)")
        for _ in range(30):
            await pg.keyboard.press("ArrowRight")
        lw = await pg.locator(".pane .lw").bounding_box()
        pane = await pg.evaluate(f"() => {{ const l = [...{N}.layers][0]; l.render(); return {{ w: l.geo().w, h: l.geo().h }}; }}")
        W, H = pane["w"], pane["h"]

        def at(fx, fy):
            return lw["x"] + W * fx, lw["y"] + 60 + (H - 190) * fy

        async def screen(i, k):
            """where drawing i's point k is on the page"""
            xy = await pg.evaluate(f"([i, k]) => {{ const l = [...{N}.layers][0], d = {N}.session.drawings.items[i]; return l.geo().xy(d.pts[k]); }}", [i, k])
            return lw["x"] + xy["x"], lw["y"] + xy["y"]

        async def pts(i):
            return await pg.evaluate(f"(i) => {N}.session.drawings.items[i].pts", i)

        async def tool():
            return await pg.evaluate(f"() => {N}.ds.tool")

        # 1. Alt+T, two clicks: a trend line, selected, and the tool back to the cursor
        await pg.keyboard.press("Alt+t")
        check(await tool() == "trend", "Alt+T picks the trend line")
        await pg.mouse.click(*at(.2, .7))
        await pg.mouse.move(*at(.3, .5))
        check(await pg.evaluate(f"() => [...{N}.layers][0].placing != null"), "the trend line follows the mouse after the first click")
        await pg.mouse.click(*at(.4, .3))
        check(await pg.evaluate(ITEMS) == 1, "a trend line was drawn")
        check(await tool() == "cross", "the tool went back to the cursor")
        check(await pg.locator(".drawbar").count() == 1, "the new drawing is selected, with its toolbar")
        await pg.screenshot(path=f"{OUT}/draw-1-trend.png")

        # 2. press, drag, release: a rectangle from the rail's flyout
        await pg.click(".drawrail button[aria-label='More: Geometric shapes']")
        await pg.click(".drawrail .flyout button:has-text('Rectangle')")
        x0, y0 = at(.5, .2)
        x1, y1 = at(.65, .45)
        await pg.mouse.move(x0, y0)
        await pg.mouse.down()
        await pg.mouse.move((x0 + x1) / 2, (y0 + y1) / 2)
        await pg.mouse.move(x1, y1)
        await pg.mouse.up()
        r = await pts(1)
        check(await pg.evaluate(ITEMS) == 2 and r[0]["t"] != r[1]["t"] and r[0]["p"] != r[1]["p"], f"press-drag-release drew a rectangle: {r}")

        # 3. drag a handle of the trend line, then its body; undo and redo
        await pg.keyboard.press("Escape")
        before = await pts(0)
        hx, hy = await screen(0, 1)
        await pg.mouse.click(*(await screen(0, 0)))  # select it
        await pg.mouse.move(hx, hy)
        await pg.mouse.down()
        await pg.mouse.move(hx + 40, hy + 30, steps=4)
        await pg.mouse.up()
        moved = await pts(0)
        check(moved[0] == before[0] and moved[1] != before[1], "dragging a handle moves only that point")
        mx, my = (await screen(0, 0))[0] * .5 + (await screen(0, 1))[0] * .5, (await screen(0, 0))[1] * .5 + (await screen(0, 1))[1] * .5
        await pg.mouse.move(mx, my)
        await pg.mouse.down()
        await pg.mouse.move(mx - 60, my + 20, steps=4)
        await pg.mouse.up()
        body = await pts(0)
        check(body[0]["t"] < moved[0]["t"] and body[1]["t"] < moved[1]["t"] and abs((body[1]["p"] - body[0]["p"]) - (moved[1]["p"] - moved[0]["p"])) < 1e-6, "dragging the body moves the whole line")
        await pg.keyboard.press("Control+z")
        check(await pts(0) == moved, "Ctrl+Z undoes the move")
        await pg.keyboard.press("Control+z")
        check(await pts(0) == before, "Ctrl+Z again undoes the handle drag")
        await pg.keyboard.press("Control+y")
        check(await pts(0) == moved, "Ctrl+Y redoes")

        # 4. the strong magnet puts a horizontal line on a bar's open, high, low or close
        await pg.click(".drawrail button[aria-label='Magnet mode']")
        await pg.click(".drawrail .flyout button:has-text('Strong magnet')")
        await pg.keyboard.press("Alt+h")
        await pg.mouse.click(*at(.3, .5))
        snapped = await pg.evaluate(f"""() => {{ const s = {N}.session, d = s.drawings.items[s.drawings.items.length - 1], l = [...{N}.layers][0];
            const bar = l.geo().bars(d.pts[0].t, d.pts[0].t)[0]; return bar && [bar.o, bar.h, bar.l, bar.c].includes(d.pts[0].p); }}""")
        check(snapped, "the magnet snapped the line to the bar")
        await pg.click(".drawrail button[aria-label='Magnet mode']")
        await pg.click(".drawrail .flyout button:has-text('Off')")

        # 5. Shift+click measures; the next click clears it
        await pg.keyboard.down("Shift")
        await pg.mouse.click(*at(.1, .2))
        await pg.keyboard.up("Shift")
        await pg.mouse.move(*at(.25, .5))
        await pg.mouse.click(*at(.25, .5))
        check(await pg.evaluate(f"() => [...{N}.layers][0].measure?.done === true"), "Shift+click measured a range")
        await pg.screenshot(path=f"{OUT}/draw-2-measure.png")
        await pg.mouse.click(*at(.25, .5))
        check(await pg.evaluate(f"() => [...{N}.layers][0].measure == null") and await pg.evaluate(ITEMS) == 3, "the next click clears the measure without drawing anything")

        # 6. double-click: settings; Cancel puts things back, OK keeps them
        await pg.mouse.dblclick(*(await screen(1, 0)))
        await pg.wait_for_selector(".modal.drawset")
        await pg.click(".modal .tabs button:has-text('Text')")
        await pg.fill(".modal textarea", "Supply")
        check(await pg.evaluate(f"() => {N}.session.drawings.items[1].style.text") == "Supply", "the text shows while typing")
        await pg.click(".modal button:has-text('Cancel')")
        check(await pg.evaluate(f"() => {N}.session.drawings.items[1].style.text") == "", "Cancel put the text back")
        await pg.mouse.dblclick(*(await screen(1, 0)))
        await pg.click(".modal .tabs button:has-text('Text')")
        await pg.fill(".modal textarea", "Supply")
        await pg.click(".modal button:has-text('OK')")
        check(await pg.evaluate(f"() => {N}.session.drawings.items[1].style.text") == "Supply", "OK kept the text")

        # 7. lock: a locked drawing doesn't move; right-click menu: clone
        await pg.mouse.click(*(await screen(1, 0)))
        await pg.click(".drawbar button[aria-label='Lock']")
        lp = await pts(1)
        sx, sy = await screen(1, 0)
        await pg.mouse.move(sx + 30, sy + 1)
        await pg.mouse.down()
        await pg.mouse.move(sx + 80, sy + 40, steps=4)
        await pg.mouse.up()
        check(await pts(1) == lp, "a locked drawing stays put")
        await pg.mouse.click(sx + 30, sy + 1, button="right")
        await pg.click(".pane .pop.menu button:has-text('Clone')")
        check(await pg.evaluate(ITEMS) == 4, "Clone from the right-click menu")
        await pg.keyboard.press("Delete")
        check(await pg.evaluate(ITEMS) == 3, "Delete removes the selected drawing")

        # 8. eraser
        await pg.click(".drawrail button[aria-label='More: Cursors']")
        await pg.click(".drawrail .flyout button:has-text('Eraser')")
        ex, ey = await screen(2, 0)
        await pg.mouse.click(ex + 200, ey)
        check(await pg.evaluate(ITEMS) == 2, "the eraser removed the horizontal line")
        await pg.keyboard.press("Escape")
        check(await tool() == "cross", "Esc puts the cursor back")

        # 9. a long position turned into an order
        await pg.click(".drawrail button[aria-label='More: Forecasting and measurement tools']")
        await pg.click(".drawrail .flyout button:has-text('Long position')")
        price = await pg.evaluate(f"() => {N}.session.activeFeed.price")
        ly = await pg.evaluate(f"(p) => [...{N}.layers][0].geo().y(p - 8)", price)
        lx = await pg.evaluate(f"() => [...{N}.layers][0].geo().x({N}.session.activeFeed.F.time)")
        await pg.mouse.click(lw["x"] + lx, lw["y"] + ly)
        pos = await pg.evaluate(f"() => {{ const d = {N}.session.drawings.items.at(-1); return {{ tool: d.tool, n: d.pts.length }}; }}")
        check(pos == {"tool": "long", "n": 4}, f"a long position from one click: {pos}")
        await pg.click(".drawbar button:has-text('Place order')")
        orders = await pg.evaluate(f"() => {N}.session.account.orders.map(o => ({{ type: o.type, side: o.side, sl: o.sl, tp: o.tp }}))")
        check(len(orders) == 1 and orders[0]["type"] == "limit" and orders[0]["side"] == 1 and orders[0]["sl"] and orders[0]["tp"], f"Place order sent a buy limit with its stop and target: {orders}")
        await pg.screenshot(path=f"{OUT}/draw-3-position.png")
        await pg.click("button:has-text('Cancel orders')")

        # 10. the timeframe changes and stepping back keep the drawings, still clickable
        await pg.click(".seg button:has-text('15m')")
        await pg.keyboard.press("ArrowLeft")
        await pg.wait_for_timeout(100)
        await pg.mouse.click(5, 880)
        hit = await pg.evaluate(f"() => {{ const l = [...{N}.layers][0]; l.render(); const d = {N}.session.drawings.items[0], g = l.geo(), a = g.xy(d.pts[0]), b = g.xy(d.pts[1]); return l.hitTest({{ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }}) === d.id; }}")
        check(hit, "on 15 minutes the trend line is still there and clickable")
        await pg.click(".seg button:has-text('5m')")

        # 11. every tool in the catalog, placed by clicking its points
        cat = await pg.evaluate(f"() => {N}.tools")
        check(len(cat) >= 70, f"the catalog has TradingView's tools ({len(cat)})")
        await pg.evaluate(f"() => {N}.session.drawings.clear()")
        n0 = 0
        for k, t in enumerate(cat):
            tid, n = t["id"], t["n"]
            await pg.evaluate(f"(id) => {N}.setDs({{ tool: id, selected: null, editing: null }})", tid)
            fx = .08 + .84 * (k % 12) / 11
            fy = .15 + .7 * ((k // 12) % 6) / 5
            if n == "free":
                x, y = at(fx, fy)
                await pg.mouse.move(x, y)
                await pg.mouse.down()
                for s in range(8):
                    await pg.mouse.move(x + s * 5, y + (s % 3) * 4)
                await pg.mouse.up()
            elif n == "path":
                await pg.mouse.click(*at(fx, fy))
                await pg.mouse.click(*at(fx + .03, fy - .05))
                await pg.mouse.dblclick(*at(fx + .05, fy + .02))
            else:
                for j in range(int(n)):
                    await pg.mouse.click(*at(fx + .012 * j, fy + (.06 if j % 2 else -.04)))
            if await pg.locator(".modal").count():
                check(await pg.locator(".modal textarea").count() == 1, f"{tid}: only text tools open a dialog when placed")
                await pg.fill(".modal textarea", tid)
                await pg.click(".modal button:has-text('OK')")
            count = await pg.evaluate(ITEMS)
            check(count == n0 + 1, f"{tid}: drawn ({count})")
            n0 = count
            hits = await pg.evaluate(f"() => {{ const l = [...{N}.layers][0]; l.invalidate(); l.render(); const d = {N}.session.drawings.items.at(-1); return l['hits'].get(d.id)?.length || 0; }}")
            check(hits > 0, f"{tid}: drew something that can be clicked")
        await pg.keyboard.press("Escape")
        await pg.mouse.click(5, 880)
        await pg.screenshot(path=f"{OUT}/draw-4-catalog.png")

        # 12. the replay stays smooth with every tool on the chart
        await pg.click(".chips button:has-text('300×')")
        await pg.keyboard.press("Space")
        perf = await pg.evaluate("""() => new Promise(r => { let n = 0, t0 = performance.now(), worst = 0, last = t0;
            const f = now => { n++; worst = Math.max(worst, now - last); last = now; if (now - t0 < 3000) requestAnimationFrame(f); else r({ fps: n / ((now - t0) / 1000), worst }); };
            requestAnimationFrame(f); })""")
        await pg.keyboard.press("Space")
        print("playback with", n0, "drawings:", perf)
        check(perf["fps"] > 50, f"smooth playback at 300x with every drawing: {perf}")

        # 13. remove all, then undo brings them back
        await pg.click(".drawrail button[aria-label='Remove drawings']")
        await pg.click(".drawrail .flyout button >> nth=0")
        check(await pg.evaluate(ITEMS) == 0, "remove all")
        await pg.keyboard.press("Control+z")
        check(await pg.evaluate(ITEMS) == n0, "undo brings them all back")
        check(not errors, f"no page errors: {errors[:5]}")
        await b.close()
    print(f"drawings: {passed} checks passed; screenshots in {OUT}")


asyncio.run(main())
