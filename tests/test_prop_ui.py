"""A prop firm challenge in the new app (app/index.html), in Chromium: set up in New session, followed by the card beside
the chart, a size limit rejecting an order, and a trade big enough to break the max loss failing the evaluation;
then a new evaluation. Build the page first (desktop/web), then:
    python tests/test_prop_ui.py [folder for screenshots]
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


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        pg = await (await b.new_context(viewport={"width": 1440, "height": 950}, color_scheme="dark")).new_page()
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        await pg.goto(serve())
        await pg.click(".steps button:has-text('Account')")
        await pg.click("text=Practise a prop firm challenge")
        await pg.select_option(".card select", "L Flex 50K")
        await pg.click(".seg button:has-text('Minis')")
        check(await pg.locator(".summary:has-text('L Flex 50K')").count() == 1, "the summary names the challenge")
        await pg.screenshot(path=f"{OUT}/prop-1-setup.png", full_page=True)
        await pg.click(".summary button:has-text('Start with these now')")
        await pg.wait_for_selector(".propcard", timeout=30000)
        tip = pg.locator(".tip .acts button:nth-child(2)")
        if await tip.count():
            await tip.click()
        check("Evaluation" in await pg.locator(".propcard h3").inner_text(), "the card shows the evaluation")
        check(await pg.locator(".stat:has-text('Balance') b").inner_text() == "$50,000.00", "the account is the challenge's size")
        # more than 4 minis is refused
        await pg.click("button:has-text('Contracts')")
        await pg.fill("input[aria-label='Size']", "6")
        await pg.click(".qbtn.buy")
        await pg.wait_for_timeout(200)
        check(await pg.locator(".dock tbody tr").count() == 0, "6 minis refused (the limit is 4)")
        # 4 minis with no stop, played fast until the max loss breaks (or the target is hit)
        await pg.fill("input[aria-label='Size']", "4")
        await pg.fill("input[aria-label='Stop loss'], .field:has-text('Stop loss') input", "0")
        await pg.fill(".field:has-text('Take profit') input", "0")
        await pg.click(".qbtn.sell")
        await pg.wait_for_timeout(200)
        check(await pg.locator(".dock tbody tr").count() == 1, "4 minis allowed")
        await pg.click(".chips button:has-text('1000×')")
        await pg.keyboard.press("Space")
        state = ""
        for _ in range(120):
            state = await pg.locator(".propcard").inner_text()
            if "Failed" in state or "Funded" in state.split("\n")[0]:
                break
            if await pg.locator(".dock tbody tr").count() == 0:
                await pg.click(".qbtn.sell")
            await pg.wait_for_timeout(500)
        await pg.keyboard.press("Space")
        await pg.screenshot(path=f"{OUT}/prop-2-result.png")
        check("Failed" in state or "Funded" in state, f"the evaluation ended one way or the other: {state[:120]}")
        if "Failed" in state:
            await pg.click(".propcard button:has-text('evaluation')")
            await pg.wait_for_timeout(200)
            check("Failed" not in (await pg.locator(".propcard h3").inner_text()), "a new evaluation started")
        check(not errors, f"no page errors: {errors}")
        await b.close()
    print(f"prop ui: {passed} checks passed; screenshots in {OUT}")


asyncio.run(main())
