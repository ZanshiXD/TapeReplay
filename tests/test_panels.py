"""Resizing the Replay screen's panels, in Chromium: the top edge of the panel under the charts (positions, orders,
history...) and the left edge of the trade panel drag to change their size, with the chart following while the tape
plays; the sizes survive a reload; a double-click puts them back; the arrow keys move them by 16px (and not the
replay); they stay within what fits, also when the window shrinks; a phone has no handles.
    python tests/test_panels.py [folder for screenshots]
Builds the page into desktop/web first (TAPE_SKIP_BUILD=1 to use the one there).
"""
import asyncio
import functools
import http.server
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading

from playwright.async_api import async_playwright

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
APP, WEB = os.path.join(ROOT, "app"), os.path.join(ROOT, "desktop", "web")
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


def serve():
    class H(http.server.SimpleHTTPRequestHandler):
        extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, ".wasm": "application/wasm", ".mjs": "text/javascript"}

        def log_message(self, *a):
            pass
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(H, directory=WEB))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{srv.server_address[1]}/index.html"


# the sizes that matter, in one go: the two panels, the charts' area, and the first chart's canvas (lightweight-charts
# sizes its canvases itself, so a changed canvas means the chart really resized)
SIZES = """() => {
  const r = s => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { w: b.width, h: b.height }; };
  const cv = [...document.querySelectorAll('.pane .lw canvas')].reduce((m, c) => c.width * c.height > m.width * m.height ? c : m, { width: 0, height: 0 });
  const cb = cv.getBoundingClientRect ? cv.getBoundingClientRect() : { width: 0, height: 0 };
  return { dock: r('.dock'), side: r('aside.side'), charts: r('.charts'), canvas: { w: cb.width, h: cb.height } };
}"""


async def sizes(pg):
    await pg.wait_for_timeout(250)  # a frame or two for the charts' own resize
    return await pg.evaluate(SIZES)


async def edge(pg, kind):
    """the middle of a handle (an element with no height, or no width, on the panel's edge)"""
    b = await pg.locator(f".rsz-{kind}").bounding_box()
    return b["x"] + b["width"] / 2, b["y"] + b["height"] / 2


async def drag(pg, kind, dx, dy, steps=12, mid=None):
    x, y = await edge(pg, kind)
    await pg.mouse.move(x, y)
    await pg.mouse.down()
    await pg.mouse.move(x + dx, y + dy, steps=steps)
    if mid:
        await mid()
    await pg.mouse.up()


async def prefs(pg):
    return await pg.evaluate("() => JSON.parse(localStorage.getItem('tr-next-prefs') || '{}')")


async def start(pg):
    await pg.click(".summary button:has-text('Start with these now')")
    await pg.wait_for_selector(".pane .lw canvas", timeout=60000)
    await pg.wait_for_timeout(400)
    await pg.evaluate("document.querySelector('.tour [data-t=skip]')?.click()")
    tip = pg.locator(".tip .acts button:nth-child(2)")
    if await tip.count():
        await tip.click()


async def clock(pg):
    return await pg.locator(".rbar .lbl .num").first.inner_text()


async def main():
    build()
    url = serve()
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={"width": 1400, "height": 900}, color_scheme="dark")
        pg = await ctx.new_page()
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        await pg.goto(url)
        await start(pg)

        # the handles: separators, labeled, with their value
        dk, sd = pg.locator(".rsz-dock"), pg.locator(".rsz-side")
        check(await dk.count() == 1 and await sd.count() == 1, "a handle on each panel")
        check(await dk.get_attribute("role") == "separator" and await dk.get_attribute("aria-orientation") == "horizontal", "the panel under the charts: a horizontal separator")
        check(await sd.get_attribute("role") == "separator" and await sd.get_attribute("aria-orientation") == "vertical", "the trade panel: a vertical separator")
        check(await dk.get_attribute("aria-valuenow") == "210" and await sd.get_attribute("aria-valuenow") == "330", "the usual sizes")
        check(await dk.get_attribute("tabindex") == "0" and await dk.get_attribute("aria-label"), "reachable with Tab, and named")
        s0 = await sizes(pg)
        check(abs(s0["dock"]["h"] - 210) < 1 and abs(s0["side"]["w"] - 330) < 1, f"the usual sizes on screen: {s0}")
        # the hit area and the cursor: 4px above the edge is still the handle
        x, y = await edge(pg, "dock")
        hit = await pg.evaluate(f"() => {{ const e = document.elementFromPoint({x}, {y - 3}); return [e.className, getComputedStyle(e, '::before').cursor]; }}")
        check(hit[0].startswith("rsz") and hit[1] == "row-resize", f"a few pixels above the edge is the handle, with a row-resize cursor: {hit}")
        x, y = await edge(pg, "side")
        hit = await pg.evaluate(f"() => {{ const e = document.elementFromPoint({x - 3}, {y}); return [e.className, getComputedStyle(e, '::before').cursor]; }}")
        check(hit[0].startswith("rsz") and hit[1] == "col-resize", f"left of the trade panel's edge too, col-resize: {hit}")

        # drag the panel under the charts up by 150px, over the chart, while the tape plays
        await pg.click(".rbar .play")
        c0 = await clock(pg)
        during = {}

        async def mid():
            during["cls"] = await pg.evaluate("() => document.documentElement.className")
            during["s"] = await pg.evaluate(SIZES)
        await drag(pg, "dock", 0, -150, steps=30, mid=mid)
        check("resizing-dock" in during["cls"], f"while dragging, the page says so (the cursor stays): {during['cls']}")
        check(abs(during["s"]["dock"]["h"] - 360) < 2, f"the panel follows the pointer during the drag: {during['s']}")
        s1 = await sizes(pg)
        check(abs(s1["dock"]["h"] - 360) < 1, f"the panel is 150px taller: {s1['dock']}")
        check(abs((s0["charts"]["h"] - s1["charts"]["h"]) - 150) < 2, f"the charts gave up the 150px: {s0['charts']} {s1['charts']}")
        check(s1["canvas"]["h"] < s0["canvas"]["h"] - 100, f"and the chart itself resized: {s0['canvas']} {s1['canvas']}")
        check("resizing-dock" not in await pg.evaluate("() => document.documentElement.className"), "the drag is over")
        await pg.wait_for_timeout(600)
        check(await clock(pg) != c0, "the replay kept playing through the drag")
        await pg.click(".rbar .play")  # pause

        # the trade panel 100px wider
        await drag(pg, "side", -100, 0)
        s2 = await sizes(pg)
        check(abs(s2["side"]["w"] - 430) < 1, f"the trade panel is 100px wider: {s2['side']}")
        check(abs((s1["charts"]["w"] - s2["charts"]["w"]) - 100) < 2 and s2["canvas"]["w"] < s1["canvas"]["w"] - 60, f"the chart is narrower: {s1} {s2}")
        check(await sd.get_attribute("aria-valuenow") == "430", "its value says so")
        await pg.screenshot(path=f"{OUT}/panels-1-resized.png")
        pr = await prefs(pg)
        check(pr.get("dockH") == 360 and pr.get("sideW") == 430, f"both sizes are saved: {pr.get('dockH')} {pr.get('sideW')}")

        # after a reload, the same sizes
        await pg.reload()
        await pg.wait_for_selector(".summary button:has-text('Start with these now')", timeout=30000)
        await start(pg)
        s3 = await sizes(pg)
        check(abs(s3["dock"]["h"] - 360) < 1 and abs(s3["side"]["w"] - 430) < 1, f"the sizes survived the reload: {s3}")
        check(await dk.get_attribute("aria-valuenow") == "360", "and the handle's value")

        # the keyboard: 16px a press; the arrows don't step the replay while a handle has the focus
        t0 = await clock(pg)
        await dk.focus()
        await pg.keyboard.press("ArrowUp")
        check(await dk.get_attribute("aria-valuenow") == "376", "ArrowUp: 16px taller")
        await pg.keyboard.press("ArrowDown")
        await pg.keyboard.press("ArrowDown")
        check(await dk.get_attribute("aria-valuenow") == "344", "ArrowDown twice: 32px shorter")
        check(abs((await sizes(pg))["dock"]["h"] - 344) < 1, "on screen too")
        await sd.focus()
        await pg.keyboard.press("ArrowLeft")
        check(await sd.get_attribute("aria-valuenow") == "446", "ArrowLeft: the trade panel 16px wider")
        await pg.keyboard.press("ArrowRight")
        await pg.keyboard.press("ArrowRight")
        check(await sd.get_attribute("aria-valuenow") == "414", "ArrowRight twice: 32px narrower")
        check(await clock(pg) == t0, "the arrows didn't move the replay")
        pr = await prefs(pg)
        check(pr.get("dockH") == 344 and pr.get("sideW") == 414, f"keyboard sizes saved: {pr.get('dockH')} {pr.get('sideW')}")
        await pg.keyboard.press("Home")
        check(await sd.get_attribute("aria-valuenow") == "280", "Home: the smallest")
        await pg.evaluate("document.activeElement.blur()")

        # a double-click puts each back
        x, y = await edge(pg, "dock")
        await pg.mouse.dblclick(x, y)
        x, y = await edge(pg, "side")
        await pg.mouse.dblclick(x, y)
        s4 = await sizes(pg)
        check(abs(s4["dock"]["h"] - 210) < 1 and abs(s4["side"]["w"] - 330) < 1, f"double-click: the usual sizes again: {s4}")
        pr = await prefs(pg)
        check(pr.get("dockH") is None and pr.get("sideW") is None, f"and no size saved: {pr.get('dockH')} {pr.get('sideW')}")

        # within what fits: the charts keep 200px of height and 320px of width; at most 70% of the height, half the width
        await drag(pg, "dock", 0, -2000)
        s5 = await sizes(pg)
        check(s5["dock"]["h"] <= 900 * 0.7 + 1 and s5["charts"]["h"] >= 199, f"the panel stops where the chart would get too short: {s5}")
        check(s5["dock"]["h"] > 400, f"but grows a lot: {s5['dock']}")
        await drag(pg, "side", -2000, 0)
        s6 = await sizes(pg)
        check(s6["side"]["w"] <= 700 + 1 and s6["charts"]["w"] >= 319, f"the trade panel stops at half the width / the chart's 320px: {s6}")
        await pg.screenshot(path=f"{OUT}/panels-2-largest.png")
        await drag(pg, "dock", 0, 2000)
        await drag(pg, "side", 2000, 0)
        s7 = await sizes(pg)
        check(abs(s7["dock"]["h"] - 120) < 1 and abs(s7["side"]["w"] - 280) < 1, f"and the smallest: 120px and 280px: {s7}")
        await pg.screenshot(path=f"{OUT}/panels-2-smallest.png")

        # a smaller window: the saved size is held back to what fits, and comes back with the room
        await drag(pg, "dock", 0, -480)   # 600px
        await drag(pg, "side", -320, 0)   # 600px
        big = await sizes(pg)
        check(abs(big["dock"]["h"] - 600) < 1 and abs(big["side"]["w"] - 600) < 1, f"600 by 600: {big}")
        await pg.set_viewport_size({"width": 1000, "height": 640})
        small = await sizes(pg)
        check(small["charts"]["h"] >= 199 and small["dock"]["h"] <= 640 * 0.7 + 1, f"a shorter window: the panel shrinks to fit: {small}")
        check(small["charts"]["w"] >= 319 and small["side"]["w"] <= 500 + 1, f"a narrower window: the trade panel too: {small}")
        check(not await pg.evaluate("() => document.documentElement.scrollWidth > innerWidth"), "nothing scrolls sideways")
        await pg.screenshot(path=f"{OUT}/panels-3-small-window.png")
        await pg.set_viewport_size({"width": 1400, "height": 900})
        back = await sizes(pg)
        check(abs(back["dock"]["h"] - 600) < 1 and abs(back["side"]["w"] - 600) < 1, f"back to the bigger window: the saved sizes again: {back}")

        # phone width (html.m): no handles, the phone layout as before; and back
        await pg.set_viewport_size({"width": 820, "height": 900})
        await pg.wait_for_timeout(300)
        check(await pg.evaluate("() => document.documentElement.classList.contains('m')"), "the phone layout is on")
        check(await pg.locator(".rsz").count() == 0, "no handles on the phone layout")
        await pg.set_viewport_size({"width": 1400, "height": 900})
        await pg.wait_for_timeout(300)
        check(await pg.locator(".rsz").count() == 2, "the handles come back on a wide window")
        check(abs((await sizes(pg))["dock"]["h"] - 600) < 1, "with the saved size")
        check(not errors, f"no page errors: {errors}")
        await ctx.close()

        # a phone: no handles at all
        ctx = await b.new_context(**p.devices["iPhone 13"])
        pg = await ctx.new_page()
        perr = []
        pg.on("pageerror", lambda e: perr.append(str(e)))
        await pg.goto(url)
        await pg.tap(".wizacts .mstart")
        await pg.wait_for_selector(".pane .lw canvas", timeout=60000)
        check(await pg.locator(".rsz").count() == 0, "a phone has no resize handles")
        await pg.screenshot(path=f"{OUT}/panels-4-phone.png")
        check(not perr, f"no page errors on the phone: {perr}")
        await b.close()
    print(f"panels: {passed} checks passed; screenshots in {OUT}")


asyncio.run(main())
