"""The Windows app's own server (desktop/app.py, without its window): the page it opens (index.html with its token)
is cross-origin isolated and uses the app's storage; a session saved by an older version is left out of the Library;
and the update prompt: while the launch check runs nothing shows, once a newer release is found the sidebar's Update
button offers it, the dialog shows the notes, and "Restart and update" saves the session and asks the app to install
it (reporting a failure, with a link to download it instead).
Build the page first (cd app && npm run build), then:
    python tests/test_desktop.py [folder for screenshots]
"""
import asyncio
import json
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
# a session saved by an older version of the app (no app: 'next'): not listed, since it cannot be opened
OLD = {"id": "oldsession1", "name": "Old format session", "datasetName": "practice", "updated": time.time() * 1000, "summary": {}}
with open(os.path.join(app.SESSIONS, "oldsession1.meta.json"), "w") as f:
    json.dump(OLD, f)
with open(os.path.join(app.SESSIONS, "oldsession1.json"), "w") as f:
    json.dump({**OLD, "app": "old"}, f)

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
NAV = "nav.nav"


def saved_sessions():
    return [n for n in os.listdir(app.SESSIONS) if n.endswith(".meta.json") and n != "oldsession1.meta.json"]


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        # the installed app offers updates (set after the browser starts: Playwright itself looks for its browsers
        # beside the program when sys.frozen is set)
        sys.frozen = True
        pg = await b.new_page(viewport={"width": 1400, "height": 900})
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))

        # nothing newer: no prompt; the page is isolated and reads the app's storage
        app.UPDATE.update(state="idle", manifest=None)
        await pg.goto(URL)
        await pg.wait_for_selector(NAV, timeout=30000)
        check(await pg.evaluate("() => crossOriginIsolated"), "the app's page is cross-origin isolated")
        await pg.wait_for_timeout(1500)
        check(not await pg.locator(".updbtn").count(), "no prompt without an update")
        await pg.click(f"{NAV} .item:has-text('Library')")
        await pg.wait_for_selector(".emptycard, .librow", timeout=15000)
        check(not await pg.locator(".librow:has-text('Old format session')").count(), "an old-format session is not listed")
        check(not await pg.locator("a[href*='.html']").count(), "no link to a removed page")

        # the launch check is slow: the page waits for it
        app.UPDATE.update(state="checking", manifest=None)
        await pg.goto(URL)
        await pg.wait_for_selector(NAV, timeout=30000)
        await pg.wait_for_timeout(3000)
        check(not await pg.locator(".updbtn").count(), "nothing shown while checking")
        app.UPDATE.update(state="available", manifest=MANIFEST)
        await pg.wait_for_selector(".updbtn", timeout=15000)
        check("1.4.3" in (await pg.get_attribute(".updbtn", "title") or ""), await pg.get_attribute(".updbtn", "title"))

        # in a session: the dialog shows the notes; installing saves the session first, then the (fake) install
        # fails and offers the download page
        await pg.click(".summary button:has-text('Start with these now')")
        await pg.wait_for_selector(".pane .lw canvas", timeout=60000)
        await pg.wait_for_timeout(500)
        await pg.evaluate("document.querySelector('.tour [data-t=skip]')?.click()")
        await pg.click(".updbtn")
        dlg = pg.locator(".pop[aria-label=Update]")
        await dlg.wait_for(timeout=5000)
        text = await dlg.inner_text()
        check("What's new in 1.4.3" in text and "Faster imports" in text and "You have 1.4.2" in text, text)
        await pg.screenshot(path=f"{OUT}/desktop-update-dialog.png")
        await dlg.locator("button:has-text('Restart and update')").click()
        await pg.wait_for_function("() => /cannot be written/.test(document.querySelector('.pop[aria-label=Update]')?.textContent || '')", timeout=15000)
        check(len(installs) == 1, "the app was asked to install")
        check(saved_sessions(), "the session was saved before installing")
        check(await dlg.locator("a[href*='TapeReplay-releases']:has-text('Download it instead')").count() == 1, "download link after a failure")
        check(not await dlg.locator("button:has-text('Restart and update')").is_disabled(), "can try again")
        await pg.screenshot(path=f"{OUT}/desktop-update-failed.png")
        check(not errors, errors)
        await b.close()
    print(f"desktop: {passed} checks passed")


asyncio.run(main())
