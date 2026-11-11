"""A Library entry saved with the wrong dates (a 2009-2021 Databento CSV whose continuous series stopped at the first
reused contract symbol, March 2020, before 2.0.9): with it already chosen on the Backtest page, the page reads the
file again, its Dates reach 2021, a run covers them, and the Library entry is put right (the Library shows 2021).
Runs the desktop app's server (desktop/app.py, Python 3.14) on the built page in desktop/web.
    python tests/test_stale_range.py
"""
import asyncio, json, os, sys, tempfile, threading, time
from datetime import datetime, timedelta, timezone
from playwright.async_api import async_playwright

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
os.environ["APPDATA"] = tempfile.mkdtemp(prefix="tape-appdata-")
sys.path.insert(0, os.path.join(ROOT, "desktop"))
import app  # noqa: E402

for d in (app.DATASETS, app.SESSIONS, app.OPTIMS):
    os.makedirs(d, exist_ok=True)
# quarterly NQ contracts with one-digit years, 2009-09 to 2021-03: one bar a weekday from the front contract, and a
# thin one from the next
CODE, rows, px = "HMUZ", ["ts_event,rtype,publisher_id,instrument_id,open,high,low,close,volume,symbol"], 1500.0
def q_start(y, q):
    return datetime(y - 1, 12, 12, tzinfo=timezone.utc) if q == 0 else datetime(y, q * 3, 12, tzinfo=timezone.utc)
for y in range(2009, 2022):
    for q in range(4):
        a, b = q_start(y, q), (q_start(y + 1, 0) if q == 3 else q_start(y, q + 1))
        if a < datetime(2009, 9, 1, tzinfo=timezone.utc) or a > datetime(2021, 3, 1, tzinfo=timezone.utc):
            continue
        sym, nxt = f"NQ{CODE[q]}{y % 10}", f"NQ{CODE[(q + 1) % 4]}{(y + 1 if q == 3 else y) % 10}"
        t = a
        while t < b:
            if t.weekday() < 5:
                px += 1
                ts = (t + timedelta(hours=14, minutes=30)).strftime("%Y-%m-%dT%H:%M:%S.000000000Z")
                rows.append(f"{ts},33,1,1,{px},{px + 2},{px - 2},{px + 1},5000,{sym}")
                rows.append(f"{ts},33,1,2,{px},{px + 2},{px - 2},{px + 1},40,{nxt}")
            t += timedelta(days=1)
DS = "staleds"
with open(os.path.join(app.DATASETS, DS + ".csv"), "w") as f:
    f.write("\n".join(rows) + "\n")
t0 = datetime(2009, 9, 14, 14, 30, tzinfo=timezone.utc).timestamp()
stale_to = datetime(2020, 3, 20, 14, 30, tzinfo=timezone.utc).timestamp()
meta = {"id": DS, "name": "glbx-mdp3-test.ohlcv-1m.csv", "size": os.path.getsize(os.path.join(app.DATASETS, DS + ".csv")),
        "bars": 2700, "base": 86400, "from": t0, "to": stale_to, "contracts": 48, "added": time.time() * 1000}
with open(os.path.join(app.DATASETS, DS + ".json"), "w") as f:
    json.dump(meta, f)
inst = {"sym": "NQ", "name": "NQ", "tick": 0.25, "pv": 20, "prec": 2, "comm": 2.1, "spreadTicks": 1, "slipTicks": 0}
strat = {"name": "MA cross", "mode": "bar", "libs": "numpy", "tf": "1D", "data": {"kind": "dataset", "id": DS, "name": meta["name"], "pick": "*auto", "inst": inst, "long": False},
         "range": [t0, stale_to], "base": 86400, "balance": 50000, "qty": 1, "costs": None, "propOn": False, "prop": None, "rebuy": False, "maxEvals": 0}
with open(os.path.join(app.DATA_DIR, "prefs.json"), "w") as f:
    json.dump({"next": {"_changed": int(time.time() * 1000), "strat": strat}}, f)

srv = app.ExclusiveServer(("127.0.0.1", 0), app.Handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()
URL = f"http://127.0.0.1:{srv.server_address[1]}/index.html?t={app.TOKEN}"
passed = 0
def check(c, m):
    global passed
    if not c:
        raise AssertionError(m)
    passed += 1


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        pg = await b.new_page(viewport={"width": 1440, "height": 900})
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        await pg.goto(URL)
        await pg.click("nav.nav button.item:has-text('Backtest')")
        await pg.wait_for_selector(".bt-ta", timeout=60000)
        check(await pg.input_value("select[aria-label='Market']") == "ds:" + DS, "the file is the market, as left")
        await pg.wait_for_function("() => /to 2021-/.test(document.querySelector('.bt-range')?.textContent || '')", timeout=120000)
        rng = await pg.text_content(".bt-range")
        print("Dates:", rng, flush=True)
        check(rng.startswith("2009-09-") and "to 2021-0" in rng, f"the Dates reach 2021 ({rng})")
        saved = json.load(open(os.path.join(app.DATASETS, DS + ".json")))
        check(datetime.fromtimestamp(saved["to"], timezone.utc).year == 2021 and saved.get("rollV") == 2, f"the Library entry is put right ({saved.get('to')}, {saved.get('rollV')})")
        await pg.click(".bt-listhead button:has-text('New')")
        await pg.click(".bt-newmenu button:has-text('MA cross'):has-text('JavaScript')")
        await pg.click(".bt-run button:has-text('Run backtest')")
        await pg.wait_for_function("() => { const s = document.querySelector('.bt-cons .bt-status span'); return document.querySelector('.bt-results') || (s && /^(Done|Stopped|Fix|Could|Check|Ended)/.test(s.textContent)) }", timeout=300000)
        if await pg.locator(".bt-results").count():
            await pg.click(".bt-head .tabs button:has-text('Code')")
        lines = await pg.evaluate("() => [...document.querySelectorAll('.bt-cons .bt-lines > div')].map(d => d.textContent)")
        run = next((l for l in lines if l.startswith("Running")), "")
        check("to 2021-0" in run, f"the run goes on past March 2020 ({run} {lines[-3:]})")
        await pg.click("nav.nav button.item:has-text('Library')")
        await pg.click(".page nav.tabs button:has-text('Data')")
        await pg.wait_for_timeout(500)
        lib = await pg.inner_text(".page")
        check("2021" in lib, "the Library shows the file's real end")
        check(not errs, f"no page errors {errs}")
        await b.close()

asyncio.run(main())
print(f"stale Library dates: {passed} checks passed")
