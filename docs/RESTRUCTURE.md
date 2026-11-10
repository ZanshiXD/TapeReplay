# Restructure plan

Goal: one standard TypeScript project for the page, Tauri for the Windows and iOS apps, and faster backtests and
optimizations. Each step keeps the app working and the tests passing; nothing changes for users until a step
says so.

## Where things stand

| Before | After step 0 (this branch) |
|---|---|
| `tape-replay.html`, 10,300 lines: markup, CSS, Python runtime and all the JavaScript | `app/`: Vite + TypeScript project, `npm run dev` / `npm run build` |
| Copies committed in `desktop/web/` and `ios/Sources/TapeReplay/web/` | Built by `desktop/build.py` and `ios/sync_web.py` from `app/dist`, not kept in git |
| Chart library and fonts downloaded by `build.py` | npm packages, bundled |
| Optimizer workers re-ran the page's script text, read back out of the page with `eval` | A real worker module (`src/opt-worker.ts`) |
| Python runtime in a `<script type="text/x-python">` tag | `app/src/python/runtime.py`, imported as text |

`app/src/app.ts` is still the old script, moved as is inside one `app()` function with `// @ts-nocheck`.

## Steps

0. **Project and build** (this branch). Same behavior; all existing tests pass on the built page.
1. **Split `app.ts` into modules**, in this order so each move is small and testable:
   `state` (D, E, T, cfg, RUN, OPT), `engine` (ticks, orders, trades, prop rules, evaluations),
   `strategy` (Python bridge, `stratCore`), `optimizer` (search, workers, robustness), `chart`, `ui/*` panels,
   `platform` (the calls to the app's server). The worker then imports only `engine` and `strategy`, so the
   fake-page stand-ins in `opt-worker.ts` go away. About a week.
2. **Types**: strict TypeScript module by module, removing `@ts-nocheck`. Engine first. About a week, can overlap 1.
3. **Platform layer**: one interface for what the page asks the apps for (datasets, sessions, DBN and CSV import,
   file pickers, updates), today `fetch('/api/...')` to `desktop/app.py` or the iOS Swift server. The Tauri apps
   then implement the same interface with `invoke`. A few days.
4. **Tauri on Windows**, replacing `desktop/app.py` + pywebview + PyInstaller: storage, DBN import (Databento's
   `dbn` Rust crate), zstd series files, signed updates (Tauri updater), the cross-origin isolation headers the
   optimizer's shared memory needs. Tests that drive `app.py` move to the Tauri backend. Two to three weeks.
5. **Tauri on iOS**, replacing the Swift app once Windows is done. To check first: shared memory
   (cross-origin isolation) in WKWebView with Tauri's custom scheme, Pyodide's memory use on phones, and the App
   Store workflow. The Swift app stays until the Tauri one matches it. Two to three weeks.
6. **Speed**, on the clean engine:
   - batch the strategy console (each `print` currently forces a page layout; about 5× on chart backtests that print),
   - fewer Python calls per tick (`tick.time` built only when read, a bar's ticks in one call),
   - JavaScript strategies next to Python (about 4–6× per run at bar close, more on every tick),
   - smarter optimizer search (coarse-to-fine or genetic: about 10× fewer runs than 20,000 combinations),
   - raise the 8-worker cap on machines with more cores.

## Working on the page

```bash
cd app
npm install
npm run pyodide   # once: Python for strategies into public/pyodide/
npm run dev       # http://localhost:5173
npm run build     # type check, then dist/
```

The desktop and iOS builds run the same build (`desktop/build.py`, `ios/sync_web.py`), so Node.js is now needed
for them too.

## The UI overhaul (from the clickable prototype)

The new app is built next to the classic one: `app/next.html` (React) on a new core in `app/src/core`, while
`app/index.html` stays the classic app the Windows and iOS builds ship. When the new app does everything the classic
one does, it becomes `index.html` and the classic code goes.

The core keeps the classic engine's replay exactly — each bar plays open, then the low and high in the likely order,
then the close, on an even grid of ticks — and its fill rules (spread on buys, slippage on stops, gaps fill at the
gapped price, stop losses before targets, netting per market). New in the core: several markets on one clock with
one account, stepping back a candle, jumping back or ahead on the timeline, intrabar ticks on the market's tick
grid, and a journal entry with chart snapshots for every closed trade.

| Milestone | What | Status |
|---|---|---|
| 1 | Core (`src/core`), Replay screen (one, two or four charts, replay bar with step back and timeline, trade panel sized by risk with the order in plain words, positions, orders, history), indicators manager (EMA, SMA, VWAP), Journal, New session (practice markets) | done |
| 2 | Drawings (trend, lines, boxes, fib, long and short positions, text, measure) with templates and lock; price zones | next |
| 3 | Real data: Library (saved sessions, Databento and CSV imports, through the apps' storage), sessions saved and reopened | |
| 4 | Prop rules and the prop simulation (evaluation, funded, live) on the new account | |
| 5 | Backtest: the Python strategy runner on the core, the Backtest page, the optimizer (with smart search) and robustness | |
| 6 | Python indicators, Settings (themes, time zone, sessions, shortcuts), phone and tablet layouts | |
| 7 | Switch: `next.html` becomes `index.html`; remove the classic code | |

Tests: `npx tsx tests/core.test.ts` (in `app/`) and `python tests/test_next.py`.
