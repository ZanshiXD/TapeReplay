"""Long backtests on a long series (a .tapeseries of 1-second bars, as the built-in data), through the desktop app's
server (desktop/app.py, without its window; Python 3.14 for compression.zstd):
- with the bar cap lowered for the test (window.__TAPE_MAX_BARS, a test build only), the whole span loads grouped
  into 1-minute bars as each month is read, and the backtest runs from its first day to its last
- with the normal cap, the same file runs on its 1-second bars as before
Builds its own test copy of the page (vite build --mode test; set TAPE_SKIP_BUILD=1 to use the one there).
    python tests/test_long_backtest.py
"""
import asyncio, json, os, shutil, struct, subprocess, sys, tempfile, threading, time
import numpy as np
from compression import zstd
from playwright.async_api import async_playwright

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
APP_DIR = os.path.join(ROOT, "app")
if os.environ.get("TAPE_SKIP_BUILD") != "1":
    subprocess.check_call([shutil.which("npm") or "npm", "run", "build", "--", "--mode", "test", "--outDir", "dist-test", "--logLevel", "warn"], cwd=APP_DIR)
os.environ["APPDATA"] = tempfile.mkdtemp(prefix="tape-appdata-")
sys.path.insert(0, os.path.join(ROOT, "desktop"))
import app  # noqa: E402

pack_dir = tempfile.mkdtemp(prefix="tape-pack-")
rng = np.random.default_rng(7)
with open(os.path.join(pack_dir, "nqsec.tapeseries"), "wb") as out:
    out.write(b"TAPESER1")
    blocks, px = [], 20000.0
    for m in (1, 2, 3):
        a = np.datetime64(f"2026-{m:02d}-01"); days = np.arange(a, (a.astype("datetime64[M]") + np.timedelta64(1, "M")).astype("datetime64[D]"))
        days = days[np.is_busday(days)]
        t = (days.astype("datetime64[s]").astype(np.int64)[:, None] + 13 * 3600 + np.arange(0, 8 * 3600)[None, :]).ravel().astype(np.float64)
        c = np.round((rng.normal(0, 0.35, len(t)).cumsum() + px) * 4) / 4; px = float(c[-1])
        o = np.r_[c[0], c[:-1]]; h = np.maximum(o, c); l = np.minimum(o, c)
        cols = [t, o.astype(np.float32), h.astype(np.float32), l.astype(np.float32), c.astype(np.float32), np.ones(len(t), np.float32)]
        blk = {"t0": float(t[0]), "t1": float(t[-1]), "n": int(len(t)), "cols": []}
        for col in cols:
            z = zstd.compress(np.ascontiguousarray(col).view(np.uint8).reshape(-1, col.dtype.itemsize).T.tobytes(), 1)
            blk["cols"].append([out.tell(), len(z)]); out.write(z)
        blocks.append(blk)
    N = sum(b["n"] for b in blocks)
    hdr = {"v": 1, "id": "nqsec", "name": "NQ seconds test", "n": N, "base": 1, "prec": 2, "hasVol": True, "from": blocks[0]["t0"], "to": blocks[-1]["t1"],
           "contracts": 1, "rolls": [[blocks[0]["t0"], "NQ"]], "symbol": "NQ", "blocks": blocks, "pointValue": 20}
    hj = json.dumps(hdr).encode(); out.write(hj + struct.pack("<I", len(hj)) + b"TAPESER1")
print(f"series: {N:,} one-second bars", flush=True)

for d in (app.DATASETS, app.SESSIONS, app.OPTIMS):
    os.makedirs(d, exist_ok=True)
app.PACK_DIR = pack_dir
app.WEB_DIR = os.path.join(APP_DIR, "dist-test")
app.register_series()
srv = app.ExclusiveServer(("127.0.0.1", 0), app.Handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()
URL = f"http://127.0.0.1:{srv.server_address[1]}/index.html?t={app.TOKEN}"
passed = 0
def check(c, m):
    global passed
    if not c: raise AssertionError(m)
    passed += 1


async def run(b, cap, short=False):
    ctx = await b.new_context(viewport={"width": 1440, "height": 900})
    if cap: await ctx.add_init_script(f"window.__TAPE_MAX_BARS = {cap}")
    pg = await ctx.new_page(); errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    await pg.goto(URL)
    await pg.click("nav.nav button.item:has-text('Backtest')")
    await pg.wait_for_selector(".bt-ta", timeout=60000)
    await pg.click(".bt-listhead button:has-text('New')")
    await pg.click(".bt-newmenu button:has-text('MA cross'):has-text('JavaScript')")
    await pg.select_option("select[aria-label='Market']", "ds:nqsec")
    await pg.wait_for_function("() => /2026-01-01/.test(document.querySelector('.bt-range')?.textContent || '')", timeout=60000)
    if short:  # a short span of the same file: it fits, so every 1-second bar
        await pg.fill("input[aria-label='Start date']", "2026-03-23")
        await pg.wait_for_function("() => /2026-03-23/.test(document.querySelector('.bt-range')?.textContent || '')", timeout=10000)
    rng_txt = await pg.text_content(".bt-range")
    t1 = time.time()
    await pg.click(".bt-run button:has-text('Run backtest')")
    await pg.wait_for_function("() => { const s = document.querySelector('.bt-cons .bt-status span'); return document.querySelector('.bt-results') || (s && /^(Done|Stopped|Fix|Could|Check|Ended)/.test(s.textContent)) }", timeout=900000)
    secs = time.time() - t1
    await pg.click(".bt-head .tabs button:has-text('Code')")
    lines = await pg.evaluate("() => [...document.querySelectorAll('.bt-cons .bt-lines > div')].map(d => d.textContent)")
    run_line = next((l for l in lines if l.startswith("Running")), "")
    status = await pg.text_content(".bt-cons .bt-status span")
    await ctx.close()
    return rng_txt, run_line, status, secs, errs, lines


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        rng_txt, run_line, status, secs, errs, lines = await run(b, 500000)
        print("long:", rng_txt, "|", run_line, "|", status, f"{secs:.0f}s", flush=True)
        check("as 1-minute bars" in rng_txt and rng_txt.startswith("2026-01-01") and "2026-03-31" in rng_txt, f"a long span: all of it, as 1-minute bars ({rng_txt})")
        check(status == "Done" and "of 1m data" in run_line and "2026-01-01" in run_line and "2026-03-31" in run_line, f"it runs on the whole span in 1-minute bars ({status}: {run_line} {lines[-3:]})")
        check(not errs, f"no page errors {errs}")
        rng_txt, run_line, status, secs, errs, lines = await run(b, 500000, short=True)
        print("short span:", rng_txt, "|", run_line, "|", status, lines[-4:], flush=True)
        check("minute" not in rng_txt and status == "Done" and "of 1s data" in run_line and "2026-03-23" in run_line, f"a short span of the long file runs on its 1-second bars ({rng_txt}: {run_line})")
        rng_txt, run_line, status, secs, errs, lines = await run(b, 0)
        print("normal:", rng_txt, "|", run_line, "|", status, f"{secs:.0f}s", flush=True)
        check("2026-03-31" in rng_txt and "minute" not in rng_txt, f"a span that fits is unchanged ({rng_txt})")
        check(status == "Done" and "of 1s data" in run_line, f"it runs on the 1-second bars ({status}: {run_line})")
        check(not errs, f"no page errors {errs}")
        await b.close()

asyncio.run(main())
print(f"long backtests: {passed} checks passed")
