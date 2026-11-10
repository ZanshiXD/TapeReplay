"""Windows app: a session on a long series that plays on to the end of the data. It loads the next month as the
replay reaches it, lets go of the oldest bars (here sooner than in the app), stops at the real end, and reopens from
the Library with the same bars. Uses the generated practice data through the desktop app's server.
Builds its own test copy of the page (vite build --mode test: unminified, with a hook to reach the app's inner
state), then:
    python tests/test_playon.py [folder for screenshots]
"""
import asyncio
import os
import shutil
import subprocess
import sys
import tempfile
import threading

from playwright.async_api import async_playwright

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
OUT = sys.argv[1] if len(sys.argv) > 1 else tempfile.mkdtemp(prefix="tape-shots-")
os.makedirs(OUT, exist_ok=True)


def serve():
    os.environ["APPDATA"] = tempfile.mkdtemp(prefix="tape-appdata-")
    sys.path.insert(0, os.path.join(ROOT, "desktop"))
    import app
    # the test build (needs app/node_modules and app/public/pyodide, as for desktop/build.py)
    app_dir = os.path.join(ROOT, "app")
    subprocess.check_call([shutil.which("npm") or "npm", "run", "build", "--", "--mode", "test", "--outDir", "dist-test"], cwd=app_dir)
    app.WEB_DIR = os.path.join(app_dir, "dist-test")
    for d in (app.DATASETS, app.SESSIONS):
        os.makedirs(d, exist_ok=True)
    srv = app.ExclusiveServer(("127.0.0.1", 0), app.Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{srv.server_address[1]}/classic.html?t={app.TOKEN}"


URL = serve()
MA = """
FAST, SLOW = 9, 21
def on_bar(ctx, bar):
    c = ctx.closes(SLOW)
    if len(c) < SLOW:
        return
    f, s = c[-FAST:].mean(), c.mean()
    if f > s and ctx.position <= 0:
        ctx.close(); ctx.buy(1)
    elif f < s and ctx.position >= 0:
        ctx.close(); ctx.sell(1)
"""
# the page's inner functions, through the test build's __dbg hook
n = 0
def check(c, m):
    global n
    if not c: raise AssertionError(m)
    n += 1
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={"width": 1400, "height": 900}, color_scheme="dark")
        pg = await ctx.new_page(); errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
        await ctx.add_init_script("window.__TAPE_CONT_KEEP = 0.9e6")  # let go of old bars sooner, so the test sees it
        await pg.goto(URL); await pg.wait_for_selector("#home:not([hidden])")
        await pg.click("#hNew"); await pg.wait_for_selector("#modal:not([hidden])")
        opts = await pg.eval_on_selector_all("#fSpan option", "o => o.map(x => x.textContent)")
        check("To the end of the data" in opts, opts)
        await pg.select_option("#fSpan", "-1"); await pg.select_option("#fHist", "1")
        await pg.evaluate("__dbg(\"setStart(Date.UTC(2026, 6, 20, 14) / 1000)\")")
        note = await pg.inner_text("#fSecNote"); print(note)
        check("Plays on from the start to the end of the data" in note, note)
        await pg.click("#mStart")
        await pg.wait_for_function("() => document.querySelector('#modal').hidden && document.querySelector('#clock').textContent !== '—'", timeout=120000)
        await pg.evaluate("document.querySelector('.tour [data-t=skip]')?.click()")
        st = await pg.evaluate("__dbg('({n: D.n, last: D.t[D.n-1], to: D.window.to, end: D.V.to, i: E.i})')"); print(st)
        # a trade, to see it survive loads and trimming
        await pg.evaluate("__dbg('document.querySelector(\"#bBar\").click()')")
        await pg.keyboard.press("b"); await pg.wait_for_timeout(300)
        # playing (not skipping) across the end of the first month: the next one loads ahead and play carries on
        await pg.evaluate("__dbg('skipTo(D.t[D.n - 1] - 4 * 3600)')")
        await pg.wait_for_function("() => !document.querySelector('#bSkip').disabled", timeout=300000)
        last1 = await pg.evaluate("__dbg('D.t[D.n - 1]')")
        await pg.evaluate("__dbg('(document.querySelector(\"#speed\").value = 1000, applySpeed(), setPlaying(true))')")
        await pg.wait_for_function(f"() => window.__dbg('E.time') > {last1} + 3600", timeout=180000)
        check(await pg.evaluate("__dbg('E.playing')"), "still playing after the month loaded")
        await pg.evaluate("__dbg('setPlaying(false)')")
        # skip ahead past the loaded month: the next months load on the way
        await pg.evaluate("__dbg('skipTo(Date.UTC(2026, 8, 25) / 1000)')")
        await pg.wait_for_function("() => !document.querySelector('#bSkip').disabled", timeout=300000)
        st2 = await pg.evaluate("__dbg('({n: D.n, first: D.t[0], last: D.t[D.n-1], to: D.window.to, time: E.time, start: E.start, startT: E.startT, i: E.i})')"); print(st2)
        check(st2["time"] >= 1790294400 - 86400, st2)
        check(st2["last"] > st["last"], "more months loaded")
        check(st2["startT"] is not None and st2["first"] > st["last"] - 40 * 86400, "old bars let go, start time kept")
        check(st2["n"] < 0.9e6 + 0.8e6, st2["n"])
        # play to the end: run fast and stop at the real end of the data
        await pg.evaluate("__dbg('skipTo(D.V.to + 3600)')")
        await pg.wait_for_function("() => !document.querySelector('#bSkip').disabled", timeout=300000)
        st3 = await pg.evaluate("__dbg('({time: E.time, end: D.V.to, i: E.i, n: D.n, more: contMore(), status: snapshot().status, name: snapshot().name})')"); print(st3)
        check(not st3["more"] and st3["i"] >= st3["n"] and st3["status"] == "finished", st3)
        check("2026-07-20" in st3["name"], st3["name"])
        # saved and reopened: plays on from where it was, with its start kept
        before = await pg.evaluate("__dbg('({first: D.t[0], last: D.t[D.n-1], w: D.window, n: D.n, gaps: (() => { let g = 0; for (let k = 1; k < D.n; k++) if (D.t[k] <= D.t[k-1]) g++; return g; })()})')"); print(before); check(before["gaps"] == 0, before)
        await pg.evaluate("__dbg('saveSession(true)')"); await pg.wait_for_timeout(800)
        sid = await pg.evaluate("__dbg('S.sid')")
        await pg.evaluate(f"__dbg('resumeSession(\"{sid}\")')"); await pg.wait_for_timeout(3000)
        st4 = await pg.evaluate("__dbg('({cont: !!D.cont, startT: E.startT, i: E.i, n: D.n, first: D.t[0], last: D.t[D.n-1], w: D.window})')"); print(st4)
        check(st4["cont"] and st4["startT"] == st2["startT"], st4)
        check(st4["n"] == before["n"] and st4["first"] == before["first"], (st4, before))
        await pg.screenshot(path=f"{OUT}/playon-end.png")

        # a strategy over dates outside the loaded section: the months load as the run goes (and old bars are let go),
        # with the same trades as a run on a section that holds all of those dates
        async def new_session(start_ms, span):
            await pg.evaluate("__dbg('endTour()')")
            await pg.evaluate("__dbg('openSetup(D.V || D)')")
            await pg.wait_for_selector("#modal:not([hidden])")
            await pg.select_option("#fSpan", str(span)); await pg.select_option("#fHist", "7")
            await pg.evaluate(f"__dbg('setStart({start_ms} / 1000)')")
            await pg.click("#mStart")
            await pg.wait_for_function("() => document.querySelector('#modal').hidden", timeout=120000)
            await pg.wait_for_timeout(800)
            await pg.evaluate("__dbg('endTour()')")
        async def run(frm, to):
            await pg.evaluate("__dbg('openStrat()')")
            await pg.click("#stTabs [data-st=code]")
            await pg.fill("#stName", "MA test")
            await pg.evaluate("c => { const t = document.querySelector('#stSrc'); t.value = c; t.dispatchEvent(new Event('input')); }", MA)
            await pg.select_option("#stTf", "5m")
            await pg.fill("#stFrom", frm); await pg.fill("#stTo", to)
            await pg.click("#stRun")
            await pg.wait_for_function("() => !document.querySelector('#stRun').disabled && !/Loading|Starting/.test(document.querySelector('#stStat').textContent)", timeout=600000)
            await pg.wait_for_timeout(300)
            cons = await pg.evaluate("() => [...document.querySelector('#stCons').children].map(d => d.textContent).join('\\n')")
            got = await pg.evaluate("__dbg('({n: T.hist.length, net: computeStats().net, first: T.hist[0] && T.hist[0].time, last: T.hist.length && T.hist[T.hist.length - 1].exitTime, startT: E.startT ?? D.t[E.start], dn: D.n})')")
            await pg.evaluate("__dbg('closeStrat()')")
            return cons, got
        await new_session("Date.UTC(2026, 3, 25)", 182)          # Apr 25 to Sep 30 loaded: holds all the dates
        cons1, r1 = await run("2026-05-04", "2026-07-24")
        check("loaded a month at a time" not in cons1, cons1[-400:])
        await new_session("Date.UTC(2026, 7, 20)", 30)           # only Aug 13 to Sep 19 loaded
        rng = await pg.evaluate("__dbg('fillStrat(), document.querySelector(\"#stRange\").textContent')")
        check("loaded a month at a time as the run goes" in rng, rng)
        cons2, r2 = await run("2026-05-04", "2026-07-24")
        print(r1, r2)
        check("loaded a month at a time" in cons2, cons2[-600:])
        check(r1["n"] > 20 and r1["n"] == r2["n"] and abs(r1["net"] - r2["net"]) < 0.01 and r1["first"] == r2["first"] and r1["last"] == r2["last"], (r1, r2))
        check(r2["dn"] < 0.9e6 + 0.8e6, "old bars let go during the run")
        # the optimizer keeps to the loaded data
        await pg.evaluate("__dbg('openStrat()')"); await pg.click("#stTabs [data-st=opt]")
        await pg.wait_for_selector("#optRows tr[data-n=FAST]", timeout=120000)
        await pg.locator("#optRows tr[data-n=FAST] [data-on]").check()
        await pg.evaluate("__dbg('(document.querySelector(\"#stFrom\").value = \"2026-05-04\", document.querySelector(\"#stTo\").value = \"2026-05-20\")')")
        await pg.click("#optRun")
        check("runs on the loaded data" in await pg.inner_text("#optCount"), await pg.inner_text("#optCount"))
        check(not errs, errs)
        await b.close()
    print(f"playon: {n} checks passed")
asyncio.run(main())
