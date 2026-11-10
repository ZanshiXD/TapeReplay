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
| 2 | Drawings: TradingView's tools (lines, channels, pitchforks, Fibonacci and Gann, patterns, Elliott waves, cycles, long and short positions, forecast, bars pattern, ghost feed, anchored VWAP, volume profiles, ranges, shapes, brushes, text and notes), drawn the way TradingView draws them (see below) | done |
| 3 | Real data: the Library (saved sessions, CSV and Databento imports, through the apps' storage or IndexedDB in a browser), sessions saved as you go and reopened exactly, long series a month at a time | done |
| 4 | Prop firm challenge (evaluation, funded, live) on the new account, as the classic simulation | done |
| 5 | Backtest: Python and JavaScript strategies on the core, the Backtest page, the optimizer (smart search, grid, random) and robustness tests | engine done; page in progress |
| 6 | Python indicators, chart studies (price zones, session lines), Settings (themes, time zone, trading day, replay, shortcuts), trading on the chart, Performance, phones, tablets and touch | done except Python indicators (in progress) |
| 7 | Switch: `next.html` becomes `index.html`; remove the classic code | |

Tests, in `app/`: `npx tsx tests/<name>.test.ts` for core, prop, zones, backtest and optimizer (`tests/backtest.bench.ts`
measures speed). In the browser (build first, then copy `app/dist` to `desktop/web`): `python tests/test_<name>.py` for
next, drawings, library, prop_ui, chart_trade, studies and settings.

### Where things are

| Area | Core (`src/core`) | Screens (`src/next`) |
|---|---|---|
| Replay | `feed.ts`, `session.ts`, `account.ts`, `time.ts` | `ReplayPage`, `ChartPane`, `ReplayBar`, `TradePanel`, `BottomPanel`, `ChartTrade` |
| Data and saving | `data.ts` (CSV, DBN, contracts, cache, futures table), `store.ts` (apps' server or IndexedDB), `library.ts` | `LibraryPage`, `NewSessionPage`, `sessions.ts`, `library.ts` |
| Prop challenge | `prop.ts` | `PropPanel` |
| Drawings | `drawings.ts` | `draw/` |
| Studies | `zones.ts`, `sessions-studies.ts` | `studies/` |
| Backtests | `backtest.ts`, `pybridge.ts`, `jsstrategy.ts`, `optimizer.ts`, `opt.worker.ts`, `optjob.ts`, `robust.ts` | `BacktestPage` |
| Look | — | `look.ts`, `SettingsPage`, `theme.css`, `phone.css` |

Speed: a Python strategy is called about 1 µs per tick inside a batch (4.5 µs a call before); on 10 days of 1-second
bars an MA cross runs 1.4× faster than the classic bridge in Python and 5× faster as a JavaScript strategy, a trailing
stop on every tick 1.9× and 14×. The smart search finds a near-best with about a tenth of the runs of a full grid, and
the optimizer uses every core but one.

### Drawings

`src/core/drawings.ts` keeps the drawings per market in the session (anchored to time and price, so they stay on their
bars across timeframes and when the replay steps back), with undo and redo; it also has the numbers some tools need
(fib levels, regression, volume profile, anchored VWAP, how a long or short position played out). `src/next/draw/`
draws and edits them:

- `tools.ts`: the catalog, grouped as on TradingView's left toolbar. Each tool says how many points it takes, its
  starting style and how it draws.
- `paint.ts`: the painter the tools draw with. It records what it draws (segments, areas, boxes), so clicks are tested
  against exactly what is on the screen.
- `overlay.ts`: one canvas per chart, above the candles, redrawn only when something it shows changed. The mouse works
  as on TradingView: pick a tool, click the points (or press and drag), the tool goes back to the cursor unless "stay
  in drawing mode" is on; click to select, drag handles or the body, double-click for settings, right-click for the
  menu. The magnet (weak or strong; Ctrl or Cmd flips it) snaps to the bar's open, high, low or close; Shift keeps
  lines at 0, 45 or 90 degrees; Shift+click measures.
- `DrawRail.tsx` (the toolbar, with flyouts that remember the last tool of each group), `ui.tsx` (the selected
  drawing's toolbar and menu, the color picker), `DrawSettings.tsx` (Style, Text, Coordinates, Visibility; Cancel
  puts everything back), `ObjectTree.tsx`, `keys.ts` (Alt+T, Alt+H, Alt+J, Alt+V, Alt+C, Alt+F, Alt+Shift+R, Esc,
  Delete, Enter, Ctrl+Z / Ctrl+Y, Ctrl+C / Ctrl+V).

A long or short position drawing shows how it would have played out as the replay moves on, and "Place order" on its
toolbar sends it as a real order (limit or stop at its entry, its stop and target, sized by its risk).
