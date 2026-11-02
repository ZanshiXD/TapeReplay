"""Windows app: a session on a long series that plays on to the end of the data. It loads the next month as the
replay reaches it, lets go of the oldest bars (here sooner than in the app), stops at the real end, and reopens from
the Library with the same bars. Uses the generated practice data through the desktop app's server.
Build the page first (see test_browser.py), then:
    python tests/test_playon.py [folder for screenshots]
"""
import asyncio
import os
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
    for d in (app.DATASETS, app.SESSIONS):
        os.makedirs(d, exist_ok=True)
    srv = app.ExclusiveServer(("127.0.0.1", 0), app.Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{srv.server_address[1]}/index.html?t={app.TOKEN}"


URL = serve()
# the page's inner functions, reached by a line added to the page as it is served (the page itself is unchanged)
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
        async def patch(route):
            r = await route.fetch(); body = await r.text()
            body = body.replace("\n})();\n</script>", "\nwindow.__dbg = s => eval(s);\n})();\n</script>")
            body = body.replace("CONT_KEEP = () => MAX_BARS * 0.6", "CONT_KEEP = () => 0.9e6")  # let go of old bars sooner, so the test sees it
            await route.fulfill(response=r, body=body)
        await pg.route("**/index.html*", patch)
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
        check(not errs, errs)
        await b.close()
    print(f"playon: {n} checks passed")
asyncio.run(main())
