"""The Windows app's update prompt, through the desktop app's own server (desktop/app.py, without its window): while
the launch check runs the page waits; once a newer release is found, a button in the top bar and a line on Home
offer it, the dialog shows the notes, and "Restart and update" asks the app to install it (reporting a failure).
Build the page first (see test_browser.py), then:
    python tests/test_update.py [folder for screenshots]
"""
import asyncio
import os
import sys
import tempfile
import threading
import time

from playwright.async_api import async_playwright

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
OUT = sys.argv[1] if len(sys.argv) > 1 else tempfile.mkdtemp(prefix="tape-shots-")
os.makedirs(OUT, exist_ok=True)
os.environ["APPDATA"] = tempfile.mkdtemp(prefix="tape-appdata-")
sys.path.insert(0, os.path.join(ROOT, "desktop"))
import app  # noqa: E402

passed = 0


def check(cond, msg):
    global passed
    if not cond:
        raise AssertionError(msg)
    passed += 1


for d in (app.DATASETS, app.SESSIONS, app.OPTIMS):
    os.makedirs(d, exist_ok=True)
sys.frozen = True  # the installed app: it offers updates
app.VERSION = "1.4.2"
MANIFEST = {"version": "1.4.3", "url": "https://github.com/ZanshiXD/TapeReplay-releases/releases/download/v1.4.3/TapeReplay.exe",
            "size": 1, "sha256": "0" * 64, "notes": "Faster imports. | Fixed the update prompt."}
installs = []


def fake_install():
    installs.append(time.time())
    app.UPDATE.update(state="downloading", progress=0.5)
    time.sleep(0.5)
    app.UPDATE.update(state="failed", error="This folder cannot be written to.")


app.install_update = fake_install
srv = app.ExclusiveServer(("127.0.0.1", 0), app.Handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()
URL = f"http://127.0.0.1:{srv.server_address[1]}/index.html?t={app.TOKEN}"


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        pg = await b.new_page(viewport={"width": 1400, "height": 900})
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))

        # nothing newer: no prompt
        app.UPDATE.update(state="idle", manifest=None)
        await pg.goto(URL)
        await pg.wait_for_selector("#home:not([hidden])", timeout=30000)
        await pg.wait_for_timeout(1500)
        check(not await pg.locator("#bUpdate").count() and not await pg.locator("#hUpdate").count(), "no prompt without an update")

        # the launch check is slow: the page waits for it
        app.UPDATE.update(state="checking", manifest=None)
        await pg.goto(URL)
        await pg.wait_for_selector("#home:not([hidden])", timeout=30000)
        await pg.wait_for_timeout(3000)
        check(not await pg.locator("#hUpdate").count(), "nothing shown while checking")
        app.UPDATE.update(state="available", manifest=MANIFEST)
        await pg.wait_for_selector("#hUpdate", timeout=15000)
        home = await pg.inner_text("#hUpdate")
        check("1.4.3" in home and "1.4.2" in home, home)
        check(await pg.inner_text("#bUpdate") == "Update to 1.4.3", await pg.inner_text("#bUpdate"))
        await pg.screenshot(path=f"{OUT}/update-1-home.png")

        # the dialog: notes, then install (the fake install fails, offering the download page)
        await pg.click("#hUpdate button")
        await pg.wait_for_selector(".updpop", timeout=5000)
        notes = await pg.inner_text(".updpop .unotes")
        check("Faster imports" in notes and "What's new in 1.4.3" in await pg.text_content(".updpop h5"), notes)
        await pg.screenshot(path=f"{OUT}/update-2-dialog.png")
        await pg.click("#updGo")
        await pg.wait_for_function("() => /cannot be written/.test(document.querySelector('#updMsg').textContent)", timeout=10000)
        check(len(installs) == 1, "the app was asked to install")
        check(await pg.locator("#updMsg a[href*='TapeReplay-releases']").count() == 1, "download link after a failure")
        check(not await pg.is_disabled("#updGo"), "can try again")

        # the top-bar button in a session opens the same dialog
        await pg.keyboard.press("Escape")
        await pg.click("#hNew")
        await pg.wait_for_selector("#modal:not([hidden])", timeout=30000)
        await pg.click("#mStart")
        await pg.wait_for_function("() => document.querySelector('#modal').hidden && document.querySelector('#clock').textContent !== '—'", timeout=120000)
        await pg.evaluate("document.querySelector('.tour [data-t=skip]')?.click()")
        check(await pg.is_visible("#bUpdate"), "top-bar button in a session")
        await pg.click("#bUpdate")
        await pg.wait_for_selector(".updpop", timeout=5000)
        await pg.screenshot(path=f"{OUT}/update-3-bar.png")
        check(not errors, errors)
        await b.close()
    print(f"update: {passed} checks passed")


asyncio.run(main())
