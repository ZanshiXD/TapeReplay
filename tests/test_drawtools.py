"""Reaching the drawing tools on a computer (app/index.html), in Chromium at 1280x720: each group's arrow is visible
without hovering; a right-click or a long press on a group opens all its tools beside the rail, inside the window
(a long group has a search); "All drawing tools" opens every tool in one panel whose search finds them and whose
tiles arm a tool and close it; a star puts a tool on the favourites bar on the chart, which arms it and stays shown
after a reload. Build the page first (desktop/web), then:
    python tests/test_drawtools.py [folder for screenshots]
"""
import asyncio
import functools
import http.server
import os
import sys
import tempfile
import threading

from playwright.async_api import async_playwright

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
OUT = sys.argv[1] if len(sys.argv) > 1 else tempfile.mkdtemp(prefix="tape-shots-")
os.makedirs(OUT, exist_ok=True)
W, H = 1280, 720
passed = 0


def check(cond, msg):
    global passed
    if not cond:
        raise AssertionError(msg)
    passed += 1


def serve():
    class H(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a):
            pass
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(H, directory=os.path.join(ROOT, "desktop", "web")))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{srv.server_address[1]}/index.html"


async def inside(pg, sel):
    b = await pg.locator(sel).first.bounding_box()
    return b and b["x"] >= 0 and b["y"] >= 0 and b["x"] + b["width"] <= W + 0.5 and b["y"] + b["height"] <= H + 0.5, b


async def armed(pg):
    return await pg.evaluate("() => document.querySelector('.drawhint')?.textContent || ''")


async def main():
    url = serve()
    async with async_playwright() as p:
        b = await p.chromium.launch()
        for scheme in ("dark", "light"):
            ctx = await b.new_context(viewport={"width": W, "height": H}, color_scheme=scheme)
            pg = await ctx.new_page()
            errors = []
            pg.on("pageerror", lambda e: errors.append(str(e)))
            await pg.goto(url)
            await pg.click(".summary button:has-text('Start with these now')")
            await pg.wait_for_selector(".pane .lw canvas", timeout=30000)
            tip = pg.locator(".tip .acts button:nth-child(2)")
            if await tip.count():
                await tip.click()
            # the arrows: visible without hovering, a strip as tall as the button
            arrow = pg.locator(".drawrail button[aria-label='More: Trend line tools']")
            op = float(await arrow.evaluate("e => getComputedStyle(e).opacity"))
            ab = await arrow.bounding_box()
            check(op >= 0.75 and ab["width"] >= 12 and ab["height"] >= 30, f"{scheme}: the group arrow shows without hovering ({op}, {ab})")
            await pg.screenshot(path=f"{OUT}/dt-{scheme}-1-rail.png")
            rb, cb = await pg.locator(".drawrail").bounding_box(), await pg.locator(".chartrow").bounding_box()
            check(rb["y"] + rb["height"] <= cb["y"] + cb["height"] + 1, f"{scheme}: the rail stays beside the chart (it scrolls when the chart is short)")
            # right-click on a group: its tools beside the rail, inside the window, with names and keys
            await pg.click(".drawrail .rgroup:has(button[aria-label='More: Trend line tools']) .rb", button="right")
            check(await pg.locator(".flyout[aria-label='Trend line tools']").is_visible(), f"{scheme}: right-click opened the group")
            ok, fb = await inside(pg, ".flyout")
            check(ok, f"{scheme}: the group is inside the window ({fb})")
            check(await pg.locator(".flyout .fsearch").count() == 1, f"{scheme}: a long group has a search")
            await pg.fill(".flyout .fsearch", "pitch")
            check(await pg.locator(".flyout .frow").count() >= 2 and await pg.locator(".flyout .frow:has-text('Ray')").count() == 0, f"{scheme}: the group's search keeps pitchforks")
            await pg.screenshot(path=f"{OUT}/dt-{scheme}-2-flyout.png")
            await pg.locator(".flyout .frow button:has-text('Pitchfork')").first.click()
            check("itchfork" in await armed(pg), f"{scheme}: picking from the group armed it: {await armed(pg)}")
            await pg.keyboard.press("Escape")
            # a group near the bottom of the rail opens upward to stay inside the window
            await pg.click(".drawrail button[aria-label='More: Annotation tools']")
            ok, fb = await inside(pg, ".flyout")
            check(ok, f"{scheme}: a group low on the rail stays inside the window ({fb})")
            await pg.keyboard.press("Escape")
            check(await pg.locator(".flyout").count() == 0, f"{scheme}: Esc closed the group")
            # a long press on a group
            g = await pg.locator(".drawrail .rgroup:has(button[aria-label='More: Geometric shapes']) .rb").bounding_box()
            await pg.mouse.move(g["x"] + 10, g["y"] + 10)
            await pg.mouse.down()
            await pg.wait_for_timeout(650)
            await pg.mouse.up()
            check(await pg.locator(".flyout[aria-label='Geometric shapes']").is_visible(), f"{scheme}: a long press opened the group")
            await pg.mouse.click(700, 300)
            check(await pg.locator(".flyout").count() == 0, f"{scheme}: a click elsewhere closed it")
            # all the tools in one panel, with a search
            await pg.click(".drawrail button[aria-label='All drawing tools']")
            check(await pg.locator(".dpanel").is_visible(), f"{scheme}: the All drawing tools panel")
            ok, pb = await inside(pg, ".dpanel")
            check(ok and pb["width"] >= 480, f"{scheme}: the panel is big and inside the window ({pb})")
            check(await pg.evaluate("() => document.activeElement?.classList.contains('dsearch')"), f"{scheme}: the search has the focus")
            await pg.keyboard.type("fib")
            n = await pg.locator(".dpanel .dtile").count()
            names = await pg.locator(".dpanel .dtile span").all_inner_texts()
            check(n >= 4 and all("fib" in x.lower() for x in names), f"{scheme}: the search finds the Fib tools ({names})")
            await pg.screenshot(path=f"{OUT}/dt-{scheme}-3-panel.png")
            await pg.keyboard.press("ArrowDown")
            await pg.keyboard.press("ArrowRight")
            focused = await pg.evaluate("() => document.activeElement?.textContent")
            check(focused == names[1], f"{scheme}: the arrow keys move between tools ({focused})")
            await pg.keyboard.press("Enter")
            check(await pg.locator(".dpanel").count() == 0 and names[1].lower()[:6] in (await armed(pg)).lower(), f"{scheme}: picking a tool armed it and closed the panel ({await armed(pg)})")
            await pg.keyboard.press("Escape")
            await pg.click(".drawrail button[aria-label='All drawing tools']")
            await pg.keyboard.press("Escape")
            check(await pg.locator(".dpanel").count() == 0, f"{scheme}: Esc closes the panel")
            # the favourites bar: star a tool, show the bar, use it
            await pg.click(".drawrail button[aria-label='All drawing tools']")
            await pg.click(".dpanel .dtabs button:has-text('Patterns')")
            await pg.click(".dpanel .dtw:has(.dtile:has-text('XABCD')) .dstar")
            await pg.keyboard.press("Escape")
            await pg.click(".drawrail button[aria-label='Favourites bar']")
            check(await pg.locator(".favbar").is_visible(), f"{scheme}: the favourites bar")
            ok, fb = await inside(pg, ".favbar")
            lw = await pg.locator(".pane .lw").bounding_box()
            check(ok and fb["x"] >= lw["x"] - 1, f"{scheme}: the favourites bar is on the chart ({fb})")
            check(await pg.locator(".favbar button[aria-label='XABCD pattern']").count() == 1, f"{scheme}: the starred tool is on it: {await pg.locator('.favbar').inner_text()}")
            await pg.click(".favbar button[aria-label='XABCD pattern']")
            check("XABCD" in await armed(pg), f"{scheme}: the favourites bar armed it ({await armed(pg)})")
            await pg.keyboard.press("Escape")
            # dragged by its grip, kept on the chart
            gb = await pg.locator(".favbar .grip").bounding_box()
            await pg.mouse.move(gb["x"] + 6, gb["y"] + 10)
            await pg.mouse.down()
            await pg.mouse.move(gb["x"] + 306, gb["y"] + 160, steps=8)
            await pg.mouse.up()
            fb2 = await pg.locator(".favbar").bounding_box()
            check(abs(fb2["x"] - fb["x"] - 300) < 4 and abs(fb2["y"] - fb["y"] - 150) < 4, f"{scheme}: the bar moved where it was dragged ({fb} -> {fb2})")
            await pg.mouse.move(gb["x"] + 306, gb["y"] + 160)
            await pg.mouse.down()
            await pg.mouse.move(W + 400, H + 400, steps=6)
            await pg.mouse.up()
            ok, fb3 = await inside(pg, ".favbar")
            check(ok, f"{scheme}: dragged too far, it stays inside the chart ({fb3})")
            await pg.screenshot(path=f"{OUT}/dt-{scheme}-4-favbar.png")
            # after a reload: still shown, the star still there
            await pg.wait_for_timeout(600)
            await pg.reload()
            res = pg.locator(".resume button:has-text('Continue')")
            await pg.wait_for_selector(".resume button:has-text('Continue'), .summary", timeout=15000)
            if await res.count():
                await res.click()
            else:
                await pg.click(".summary button:has-text('Start with these now')")
            await pg.wait_for_selector(".pane .lw canvas", timeout=30000)
            check(await pg.locator(".favbar button[aria-label='XABCD pattern']").count() == 1, f"{scheme}: the favourites bar is back after a reload")
            check(not errors, f"{scheme}: no page errors: {errors}")
            await ctx.close()
        await b.close()
    print(f"drawing tools: {passed} checks passed; screenshots in {OUT}")


asyncio.run(main())
