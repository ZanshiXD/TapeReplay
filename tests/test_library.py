"""The new app's Library (app/index.html), in Chromium, two ways: through the desktop app's own server (as in the
Windows app) and in a plain browser (IndexedDB). A CSV is added to the Library, a session made from it, a trade and a
drawing made, the page closed and opened again: the session continues exactly where it was. Then rename and delete.
Build the page first (desktop/web, see test_browser.py), then:
    python tests/test_library.py [folder for screenshots]
"""
import asyncio
import functools
import http.server
import math
import os
import sys
import tempfile
import threading

from playwright.async_api import async_playwright

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
WEB = os.path.join(ROOT, "desktop", "web")
OUT = sys.argv[1] if len(sys.argv) > 1 else tempfile.mkdtemp(prefix="tape-shots-")
os.makedirs(OUT, exist_ok=True)
passed = 0


def check(cond, msg):
    global passed
    if not cond:
        raise AssertionError(msg)
    passed += 1


def app_server():
    os.environ["APPDATA"] = tempfile.mkdtemp(prefix="tape-appdata-")
    sys.path.insert(0, os.path.join(ROOT, "desktop"))
    import app
    for d in (app.DATASETS, app.SESSIONS):
        os.makedirs(d, exist_ok=True)
    srv = app.ExclusiveServer(("127.0.0.1", 0), app.Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{srv.server_address[1]}/index.html?t={app.TOKEN}"


def plain_server():
    class H(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a):
            pass
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(H, directory=WEB))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{srv.server_address[1]}/index.html"


def make_csv():
    """three weekdays of 1-minute E-mini bars (an ES contract, so the app knows its point value and tick)"""
    path = os.path.join(tempfile.mkdtemp(), "ESM6_1m.csv")
    t0 = 1775001600  # 2026-04-01 00:00 UTC
    lines, p = ["time,open,high,low,close,volume"], 6500.0
    for i in range(3 * 1440):
        t = t0 + i * 60
        o = p
        p = round((p + 2.5 * math.sin(i / 37) + 1.75 * math.sin(i / 7.3)) * 4) / 4
        hi, lo = max(o, p) + 0.5, min(o, p) - 0.5
        lines.append(f"{t},{o:.2f},{hi:.2f},{lo:.2f},{p:.2f},{100 + i % 50}")
    with open(path, "w") as f:
        f.write("\n".join(lines))
    return path


CSV = make_csv()
PAGE = None
PAGE_ERRORS = []


async def run(p, url, label):
    b = await p.chromium.launch()
    ctx = await b.new_context(viewport={"width": 1440, "height": 900}, color_scheme="dark")
    pg = await ctx.new_page()
    errors = PAGE_ERRORS
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.on("console", lambda m: errors.append(m.text) if m.type == "error" and "Failed to load resource" not in m.text else None)
    pg.set_default_timeout(30000)
    global PAGE
    PAGE = pg
    await pg.goto(url)
    # add the CSV in the Library
    await pg.click("button.item:has-text('Library')")
    await pg.click(".tabs button:has-text('Data files')")
    await pg.set_input_files("input[type=file]", CSV)
    await pg.wait_for_selector(".librow:has-text('ESM6_1m.csv')", timeout=30000)
    check(await pg.locator(".librow").count() == 1, f"{label}: the file is in the Library")
    check("1-minute bars" in await pg.locator(".librow").inner_text(), f"{label}: its bar size is known")
    await pg.screenshot(path=f"{OUT}/lib-{label}-1-data.png")
    # a session from it
    await pg.click("button:has-text('New session with it')")
    await pg.wait_for_selector(".dsitem.on")
    await pg.click("button:has-text('Start with these now')")
    await pg.wait_for_selector(".pane .lw canvas", timeout=30000)
    check(await pg.locator(".pane .legend .badge").inner_text() == "ES", f"{label}: the chart shows the market (ES)")
    tip = pg.locator(".tip .acts button:nth-child(2)")
    if await tip.count():
        await tip.click()
    for _ in range(20):
        await pg.keyboard.press("Shift+ArrowRight")
    await pg.click(".qbtn.buy")
    await pg.wait_for_timeout(200)
    check(await pg.locator(".dock tbody tr").count() == 1, f"{label}: a position")
    box = await pg.locator(".pane .lw").bounding_box()
    await pg.keyboard.press("Alt+h")
    await pg.mouse.click(box["x"] + 300, box["y"] + 200)
    await pg.keyboard.press("Escape")
    clock = await pg.evaluate("() => document.querySelector('.rbar .lbl .num').textContent")
    await pg.wait_for_function("() => /Saved/.test(document.querySelector('.savestate')?.textContent || '')", timeout=20000)
    await pg.wait_for_timeout(11000)  # the next save, after the trade and the drawing
    await pg.screenshot(path=f"{OUT}/lib-{label}-2-session.png")
    # the page again: continue where it was left
    await pg.goto(url)
    await pg.click(".resume button:has-text('Continue')", timeout=15000)
    await pg.wait_for_selector(".pane .lw canvas", timeout=30000)
    check(await pg.evaluate("() => document.querySelector('.rbar .lbl .num').textContent") == clock, f"{label}: the clock is where it was ({clock})")
    check(await pg.locator(".dock tbody tr").count() == 1, f"{label}: the position is still open")
    await pg.click(".drawrail button[aria-label='Object tree']")
    check(await pg.locator(".otree .orow").count() == 1, f"{label}: the drawing is back")
    await pg.screenshot(path=f"{OUT}/lib-{label}-3-continued.png")
    # rename, then delete from the Library
    await pg.click("button.item:has-text('Library')")
    await pg.click(".librow button:has-text('Rename')")
    await pg.fill(".librow input", "My ES study")
    await pg.keyboard.press("Enter")
    await pg.wait_for_selector(".librow:has-text('My ES study')")
    check(True, f"{label}: renamed")
    await pg.click("button.new")
    await pg.wait_for_selector(".dslist .dsitem:has-text('ESM6')")
    await pg.click(".summary button:has-text('Start with these now')")  # a practice session, so the ES one can be deleted
    await pg.wait_for_selector(".pane .lw canvas", timeout=30000)
    await pg.click("button.item:has-text('Library')")
    await pg.click(".librow:has-text('My ES study') button[aria-label^='Delete']")
    await pg.click(".librow:has-text('My ES study') button:has-text('Delete it')")
    await pg.wait_for_function("() => ![...document.querySelectorAll('.librow')].some(r => r.textContent.includes('My ES study'))")
    check(True, f"{label}: deleted")
    check(not errors, f"{label}: no page errors: {errors}")
    await b.close()


async def main():
    async with async_playwright() as p:
        for url, label in ((app_server(), "app"), (plain_server(), "browser")):
            try:
                await run(p, url, label)
            except Exception:
                await PAGE.screenshot(path=f"{OUT}/lib-{label}-failed.png")
                print("console:", PAGE_ERRORS[-5:])
                raise
    print(f"library: {passed} checks passed; screenshots in {OUT}")


asyncio.run(main())
