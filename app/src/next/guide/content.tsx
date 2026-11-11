// The guide's words: how to use every part of the app, and the full reference for Python indicators and for
// strategies (Python and JavaScript). Kept with the app so it always describes the version it ships with. The
// example scripts are in examples.ts, where a test runs each of them.
import type { ReactNode } from 'react';
import { JS_IND_SECTION } from './jsind';
import { IND_BANDS, IND_FIRST, IND_LEVELS, IND_ORB, IND_RSI, JS_TO_CT, PY_SIZE_FOR, PY_TO_CT, STRAT_FIRST, STRAT_JS, STRAT_ORB, STRAT_TRAIL, type Example } from './examples';

export interface Section { id: string; title: string; body: ReactNode }
export interface Chapter { id: string; title: string; sections: Section[] }

/* ---- the building blocks the pages use ---- */
export function Code({ code, lang = 'python' }: { code: string; lang?: 'python' | 'javascript' | 'text' }) {
  const copy = async (e: React.MouseEvent<HTMLButtonElement>) => {
    const b = e.currentTarget;
    try { await navigator.clipboard.writeText(code); b.textContent = 'Copied'; } catch { b.textContent = 'Select and copy'; }
    setTimeout(() => { b.textContent = 'Copy'; }, 1500);
  };
  return <div className="gcode"><button className="btn sm" onClick={copy}>Copy</button><pre data-lang={lang}><code>{code.replace(/\n$/, '')}</code></pre></div>;
}
const C = ({ children }: { children: ReactNode }) => <code className="gc">{children}</code>;
/** an API list: a signature (or name), then what it does */
function Api({ items }: { items: Array<[string, ReactNode]> }) {
  return <dl className="gapi">{items.map(([k, v]) => <div key={k}><dt><code>{k}</code></dt><dd>{v}</dd></div>)}</dl>;
}
function Steps({ items }: { items: ReactNode[] }) { return <ol className="gsteps">{items.map((x, i) => <li key={i}>{x}</li>)}</ol>; }
function Note({ children, kind = 'tip' }: { children: ReactNode; kind?: 'tip' | 'warn' }) { return <div className={'gnote' + (kind === 'warn' ? ' gwarn' : '')}>{children}</div>; }
function Ex({ ex, lang = 'python' }: { ex: Example; lang?: 'python' | 'javascript' }) {
  return <div className="gex"><h4>{ex.title}</h4><p>{ex.what}</p><Code code={ex.code} lang={lang} /></div>;
}
function Keys({ rows }: { rows: Array<[string, string]> }) {
  return <dl className="gkeys">{rows.map(([k, v]) => <div key={k}><dt>{k.split(' + ').map((x, i) => <span key={i}>{i > 0 && ' + '}<kbd>{x}</kbd></span>)}</dt><dd>{v}</dd></div>)}</dl>;
}

/* ---- the chapters ---- */
export const CHAPTERS: Chapter[] = [
  { id: 'start', title: 'Getting started', sections: [
    { id: 'welcome', title: 'What Tape Replay does', body: <>
      <p>Tape Replay plays past market data back to you as if it were live, so you can practise trading without risking money and without knowing what comes next. You buy and sell while the candles form, the app tracks your account, and every closed trade goes to a journal with a picture of the chart.</p>
      <p>It also tests ideas automatically: write a strategy in Python or JavaScript, backtest it over months of data, let the optimizer try its settings, then check the best ones on dates they were not chosen on.</p>
      <h4>Your first session in a minute</h4>
      <Steps items={[
        <>Press <b>+</b> (New session). Pick <b>Practice Nasdaq-100</b> and press <b>Start with these now</b>.</>,
        <>Press <b>Play</b> (or <kbd>Space</kbd>). The candles start moving.</>,
        <>Press <b>Buy</b> if you think the price will rise, <b>Sell</b> if you think it will fall. The order ticket puts a stop loss and a take profit on the trade for you.</>,
        <>Watch the trade play out. When it closes, open the <b>Journal</b> to see it with its chart.</>,
      ]} />
      <Note>Practice markets are generated: they move like the real Nasdaq and S&amp;P futures but are not real prices. To replay real history, add your own data file (see <i>Your own data</i>). Trades are simulated; nothing here is financial advice.</Note>
    </> },
    { id: 'new-session', title: 'Starting a session', body: <>
      <p>A session is one replay: a market, a starting moment, an account and everything you do in it. New session (the <b>+</b> button) asks three things; the summary on the right shows your choices, and <b>Start with these now</b> skips the rest at any point.</p>
      <h4>1. Market</h4>
      <ul>
        <li><b>Practice Nasdaq-100</b> (NQ) is busy and moves a lot, so trades play out quickly. The best place to start.</li>
        <li><b>Practice S&amp;P 500</b> (ES) is calmer, with bigger contracts.</li>
        <li><b>Both, side by side</b> puts NQ and ES on one clock in two charts, to compare them (SMT divergence) and trade either.</li>
        <li><b>Your data</b> lists the files in your Library, or adds a new one. A file with several contracts can follow the busiest one (continuous), or you pick a contract.</li>
      </ul>
      <h4>2. Start</h4>
      <p>Where the tape starts. The chart shows the history up to that moment; everything after it stays hidden until you play it. Pick a date and a time (New York time), use a quick pick (New York open, London open, Day start), or choose <b>A random day</b> (it starts at 9:30 New York) so you have no hindsight.</p>
      <h4>3. Account</h4>
      <ul>
        <li><b>Starting balance</b>: play money.</li>
        <li><b>Risk per trade</b>: what you lose if a trade hits its stop. The order ticket sizes trades from it.</li>
        <li><b>Costs per contract</b>: commission per side, the spread (buys pay this many ticks above the price) and slippage (stop orders, stop losses and orders at the market fill this many ticks worse). They are filled in for the market; change anything that does not match your broker.</li>
        <li><b>Practise a prop firm challenge</b>: see <i>Prop firm challenges</i>.</li>
      </ul>
    </> },
    { id: 'play', title: 'Playing the tape', body: <>
      <p>The replay bar under the chart runs the clock. Prices move tick by tick inside each candle, as they would live.</p>
      <Api items={[
        ['Play / Pause', <>Starts and stops the market. <kbd>Space</kbd>.</>],
        ['Back one candle', <>Steps back to the start of the candle, and puts your trades, orders and journal back as they were then. <kbd>←</kbd>.</>],
        ['Forward one candle', <>Plays to the end of the current candle on the chart. <kbd>Shift</kbd> + <kbd>→</kbd>; <kbd>→</kbd> alone plays to the end of the current bar of data (one minute with 1-minute data), <kbd>.</kbd> plays one tick.</>],
        ['Speed', <>1× is real time; 60× plays a minute of market each second. The <b>…</b> button (or the speed button on a phone) has a slider from 1× to 3600× (an hour a second). <kbd>↑</kbd> and <kbd>↓</kbd> go faster and slower.</>],
        ['Timeline', 'Drag it to jump forward or back: the clock shows where you will land, and letting go jumps there.'],
        ['Jump to', <>Jumps ahead 5 or 15 minutes, 1 or 4 hours, to the next New York open (9:30), London open (8:00), the next trading day (6 PM New York) or a week; or to any date and time you type; or back to the start. Going forward plays the market through quickly, so orders, stops and targets fill on the way as they would have. Going back returns your account to how it was at that time.</>],
      ]} />
      <Note>Settings › Replay and orders sets how finely each bar of data is replayed (ticks per bar, 4 to 600) and whether the tape pauses whenever an order fills, so you never miss what happened. The keys work on the chart screen, not while you type in a box.</Note>
    </> },
    { id: 'charts', title: 'The chart', body: <>
      <ul>
        <li><b>Timeframe</b>: the buttons above the chart (1m, 5m, 15m, 1h, 4h, 1D). <b>+</b> adds another, like 2m, 45m, 2h, 1W or 15s; right-click one you added to remove it. On a phone, the timeframe button opens the list.</li>
        <li><b>Move and zoom</b>: drag to scroll back, use the wheel or pinch to zoom, drag the price scale to stretch it. Double-click the price scale to fit it again.</li>
        <li><b>Legend</b>: the market, the candle under your cursor (open, high, low, close, change, volume), how long the current candle has left, and each indicator's value.</li>
        <li><b>Two or four charts</b>: the layout buttons (or Chart options on a phone) show one, two or four charts on the same clock. <b>Add market</b> adds another market on the same clock: the other practice market in a practice session, or one of your data files that covers the moment you are at. Click a chart to trade it: it says <i>Trading this chart</i>, and the ticket trades that market (or pick it at the top of the Trade panel). The × on a chart takes its market off.</li>
        <li><b>Time zone</b>: the chart, the clock and the tables use the zone set in Settings (your computer's, by default).</li>
        <li>The chart keeps the newest 40,000 candles (8,000 on phones and tablets); scrolling further back than that needs a bigger timeframe.</li>
      </ul>
    </> },
  ] },

  { id: 'trading', title: 'Trading', sections: [
    { id: 'ticket', title: 'The order ticket', body: <>
      <p>The Trade panel (on the right, or the Trade tab on a phone) places orders on the market you are trading.</p>
      <ul>
        <li><b>Sell · price falls</b> and <b>Buy · price rises</b> show the price you would get: sells at the bid, buys at the ask (the bid plus the spread). <kbd>B</kbd> and <kbd>S</kbd> do the same.</li>
        <li><b>Market</b> fills right away. <b>Limit</b> waits for the price to come to you, then fills at your price or better (buy below the market, sell above it). <b>Stop</b> fills once the price breaks through your level (buy above the market, sell below it). Limit and stop orders need a price.</li>
        <li><b>Risk per trade</b>: <b>Risk $</b> sizes the trade so that your stop loss costs at most that many dollars, rounded down to whole contracts; <b>Risk %</b> does the same with a share of your equity; <b>Contracts</b> is a fixed size. The ticket shows how many contracts that comes to. Sizing by risk needs a stop loss, and if even one contract would risk more, the ticket says so instead of trading.</li>
        <li><b>Stop loss</b> and <b>Take profit</b> in ticks from the entry. 0 means none.</li>
        <li>With two markets on the charts, the buttons at the top of the panel choose which one the ticket trades.</li>
        <li>Underneath, the ticket says what happens if the price reaches your target or your stop, and how many times your risk the target pays.</li>
      </ul>
      <p>Close all (<kbd>X</kbd>) closes every position at the market; Cancel orders cancels every working order.</p>
    </> },
    { id: 'chart-trading', title: 'Trading on the chart', body: <>
      <ul>
        <li><b>One-tap buttons</b>: Sell, the size and Buy on each chart (under the chart on a phone). They place the ticket's order on that chart's market, with its size, stop and target. Settings › Replay and orders turns them off.</li>
        <li><b>Tags</b>: each position has a tag on its entry line with its profit or loss. Drag <b>SL</b> or <b>TP</b> out of the tag to add a stop or a target, and drag a stop or target line to move it. <b>×</b> on a tag closes the position, or removes that stop or target.</li>
        <li><b>Orders</b>: working limit and stop orders have tags too, with SL and TP to drag out. Drag the order's line to move it; <b>×</b> cancels it.</li>
        <li><b>An order at a price</b>: right-click the chart (or hold a finger on it) for a buy or sell at that price (a limit or a stop, whichever fits where the price is), with or without a stop and target (the ticket's stop distance and its target-to-stop ratio), to use the price in the ticket, or to cancel all orders. The size comes from the ticket.</li>
        <li>A <b>long or short position</b> drawing has a <b>Place order</b> button on its toolbar: it sends a real order with the drawing's entry, stop and target.</li>
      </ul>
    </> },
    { id: 'positions', title: 'Positions, orders and results', body: <>
      <p>The panel under the chart (the Positions tab on a phone) has four tabs:</p>
      <ul>
        <li><b>Positions</b>: open trades. Type a stop or target price straight in; <b>Breakeven</b> moves the stop to the entry so the trade can't lose (apart from costs); <b>Close</b> closes it.</li>
        <li><b>Orders</b>: limit and stop orders waiting to fill. Cancel any of them.</li>
        <li><b>History</b>: closed trades, why each closed (stop loss, take profit, closed by you) and the result after costs. <b>Copy trades (CSV)</b> copies them for a spreadsheet.</li>
        <li><b>Performance</b>: net profit / loss, return, trades, win rate, profit factor (gross profit ÷ gross loss), average win and loss, expectancy a trade, the largest win and loss, the longest losing streak, longs and shorts, the average hold, the costs paid, the biggest drop from a high (in dollars and %), the prop challenge's numbers when there is one, and the equity curve. Copy trades (CSV) is here too.</li>
      </ul>
    </> },
    { id: 'fills', title: 'How orders fill', body: <>
      <ul>
        <li>Each bar of data is replayed as a path of ticks (the ticks per bar in Settings): open, then low, then high, then close for a rising bar (open, high, low, close for a falling one). Orders, stop losses and take profits fill when that path touches them.</li>
        <li>Sells fill at the bid (the price you see), buys at the ask (the bid plus the spread). Limit orders and take profits fill at their price. Market orders, closes, stop orders and stop losses fill the slippage you set worse. Commission is charged on each side.</li>
        <li>If a stop loss and a take profit could both fill on the same tick, the stop loss wins, as the cautious assumption.</li>
        <li>If the price gaps past an order or a stop (between two bars of data), it fills at the price it gapped to, as it would live.</li>
        <li><b>Netting</b>: like most futures brokers, a sell against a long position reduces or closes it. Settings › Replay and orders can keep every order as its own trade instead, so a long and a short can be open at once.</li>
      </ul>
    </> },
    { id: 'prop', title: 'Prop firm challenges', body: <>
      <p>Tick <b>Practise a prop firm challenge</b> in New session (Account) to trade under a funding firm's rules. They are checked on every tick, on your equity (balance plus open profit or loss), as the firm would.</p>
      <ul>
        <li><b>Rules</b>: a preset (L Flex 25K or 50K) or your own. Change any number and <b>Save as my rules</b>. Choose whether you trade <b>Micros</b> or <b>Minis</b>: size limits are in minis, and each mini allows 10 micros.</li>
        <li><b>Evaluation</b>: a <b>profit target</b> to pass; a <b>max loss</b> that trails the highest end-of-day balance and stops trailing once it reaches the starting balance plus a small amount (it "locks"); a <b>consistency</b> rule (your best day may be at most this share of the total profit; 0 turns it off); <b>minimum trading days</b>; a <b>max contracts</b> limit; and the <b>evaluation fee</b>.</li>
        <li><b>Daily loss limit</b> (optional): reaching it closes everything and stops trading for the day; it never fails the account.</li>
        <li><b>Your daily profit target</b>: once a day is up this much, positions close and trading stops until the next trading day (evaluation only). The app suggests a number that keeps every day inside the consistency rule.</li>
        <li><b>Show the funded and live rules</b> opens the rest: the funded max loss, more contracts as profit grows, how many winning days (of at least a set amount) earn a payout, the smallest and largest payout and the share of profit one may take, your split, how many payouts before live, and the live account's max loss, size and bonus.</li>
        <li>The card beside the chart follows the account: <b>Evaluation</b>, then <b>Funded</b> (a fresh account of the same size), then <b>Live</b> after the last payout. It shows each rule and how close you are to it. When a payout is allowed, the card's button requests it (type an amount, or take the most allowed); tick <i>Take payouts as soon as allowed</i> to take them automatically. Payouts come out of the balance.</li>
        <li>Breaking the max loss fails the account. The card's button starts a new evaluation (the fee is counted again); the card counts evaluations, passes, accounts that went live and fees paid.</li>
      </ul>
      <Note>Rules are checked on every tick; the end-of-day things (the trailing high, payouts, minimum days) on the first tick of the next trading day. Trading days start at 6 PM New York, as futures do; the rules have their own setting for it.</Note>
    </> },
  ] },

  { id: 'analysis', title: 'Drawing, indicators and the journal', sections: [
    { id: 'drawing', title: 'Drawing tools', body: <>
      <p>The toolbar down the left of the chart has TradingView's tools, grouped the same way: cursors; lines (trend line, ray, extended, horizontal and vertical lines, channels, pitchforks); Fibonacci and Gann tools; patterns (XABCD, head and shoulders, Elliott waves, cycles); forecasting and measuring (long and short positions, price and date ranges, anchored VWAP, volume profile); shapes and brushes; and text and notes. Each group's button shows the tool you used last.</p>
      <ul>
        <li><b>A whole group</b>: click the arrow strip on the right of a group's button, right-click the button, or hold it down. The list opens beside the toolbar with each tool's name and shortcut (and a search box in the long groups).</li>
        <li><b>All drawing tools</b>: the button under the cursors opens every tool in one panel: search by name (Enter picks the first match), your recent tools, then the groups as tabs. The magnet, keep drawing, lock, hide, the list of drawings, remove, undo and redo are there too.</li>
        <li><b>Favourites</b>: star any tool (in a group's list or the panel) and the star button on the toolbar shows your starred tools as a small toolbar on the chart. Drag it by its grip; it stays where you put it.</li>
      </ul>
      <ul>
        <li>Pick a tool, then click on the chart: once for a one-point tool, twice (or press and drag) for a line, more for patterns. A path ends with a double-click or <kbd>Enter</kbd>. The hint at the top says what to do; <kbd>Esc</kbd> cancels.</li>
        <li><b>Magnet</b> snaps points to a candle's open, high, low or close (weak: when close; strong: always). Hold <kbd>Ctrl</kbd> (<kbd>⌘</kbd> on a Mac) to flip it while you place a point.</li>
        <li><b>Stay in drawing mode</b> keeps the tool after each drawing. <b>Lock all</b>, <b>Hide all</b> and <b>Remove drawings</b> (this market's, or every market's) act on all of them; the <b>object tree</b> lists them to find, hide, lock or delete one. <b>Undo</b> and <b>redo</b> are at the bottom of the toolbar.</li>
        <li>Also on the toolbar: <b>Measure</b> (a price move and how long it took), <b>Zoom in</b> (drag over the bars to see; its arrow zooms out), and the cursors, including an <b>Eraser</b> that removes the drawing you click.</li>
        <li>Click a drawing to select it: drag its handles, or use its toolbar for color, text, line width and style, the settings, lock, clone and delete. Double-click it (or the gear) for its settings: style, text, exact coordinates, and on which timeframes it shows (none ticked: all). Right-click it for its menu (clone, lock, hide, bring to front, send to back). The template button on its toolbar saves its look as the tool's default (Save as default) or puts the original back.</li>
        <li><kbd>Ctrl</kbd> + <kbd>Z</kbd> undoes, <kbd>Ctrl</kbd> + <kbd>C</kbd> / <kbd>V</kbd> copies a drawing, <kbd>Delete</kbd> removes the selected one, <kbd>Shift</kbd> + click measures a move. On a Mac, use <kbd>⌘</kbd> for <kbd>Ctrl</kbd>.</li>
      </ul>
      <p>On a phone, the pencil button opens the tools as one panel: your recent tools, then the groups as tabs. Picking one closes the panel so the whole chart is free to draw on, and the hint at the bottom has a Cancel button.</p>
      <Note>Drawings belong to the market they were drawn on and are saved with the session. Stepping or jumping back leaves them where they are.</Note>
    </> },
    { id: 'indicators', title: 'Indicators', body: <>
      <p>The <b>Indicators</b> button lists what is on the charts (hide, edit or remove each one) and what you can add; the search box finds one by name:</p>
      <ul>
        <li><b>EMA</b> and <b>SMA</b>: the average price over a number of candles. Above it, the price is trending up.</li>
        <li><b>VWAP</b>: the day's average price, weighted by volume. It resets at the start of the trading day (6 PM New York unless you change it in Settings).</li>
        <li><b>Price zones</b>: fair value gaps, inverse FVGs, balanced price ranges, order blocks and breakers, from finished candles. <kbd>Z</kbd> shows or hides them.</li>
        <li><b>Session lines</b>: a line at each Sydney, Tokyo, London and New York open, in each city's own hours, with optional shading to its close.</li>
        <li><b>Your own</b>: write one in JavaScript or Python, or start from a template (EMA cross, RSI, Bollinger Bands, opening range box, swing levels). See the <i>Your own indicators</i> chapter.</li>
      </ul>
    </> },
    { id: 'journal', title: 'The journal', body: <>
      <p>Every trade you close is saved to the journal automatically, with a picture of the chart from entry to exit (and of the other market at the same time, when you trade two). Nothing to fill in, but you can add more.</p>
      <ul>
        <li>For each trade: the result after commission; the result in units of risk (R: the result divided by what the trade risked at its first stop); entry and exit; the amount risked; how far it went your way (best) and against you (worst); how long it was held; and the balance after.</li>
        <li><b>Setup</b> tags (like <i>SMT</i> or <i>ORB</i>), <b>How it went</b> (followed my plan, broke a rule, unsure) and <b>Notes</b> for what you'd do differently.</li>
        <li>The totals at the top: trades, win rate, profit, average win and loss, expectancy in R, and your most profitable setup. Filter by wins or losses.</li>
      </ul>
    </> },
  ] },

  { id: 'data', title: 'Your sessions and data', sections: [
    { id: 'library', title: 'The Library', body: <>
      <ul>
        <li><b>Sessions</b> save themselves every 10 seconds, when you pause and when you leave; the chart's header (Chart options on a phone) says when it last saved. <b>Back to it</b> reopens one exactly where you left it: the clock, the trades, the orders, the drawings, the indicators and the journal. Rename or delete them here. The New session page also offers to pick up where you left off. Sessions saved in the classic view open there.</li>
        <li><b>Data files</b> are your own market data, kept in the app and read only once. <b>New session with it</b> starts a replay on it.</li>
        <li><b>Optimizations</b> are saved automatically when they finish; open one to look at its results again or test its robustness.</li>
      </ul>
    </> },
    { id: 'files', title: 'Your own data', body: <>
      <p><b>Add a data file</b> (Library, or New session › Market), or drop files on the Library's Data files tab. It reads CSV files and Databento DBN files of candles (OHLCV, not zstd-compressed), of any size and any bar size, from 1-second to daily.</p>
      <ul>
        <li><b>CSV</b>: one candle per row with a time, open, high, low and close; volume is optional. Headers are recognised by name (time, date, datetime, timestamp, open, high, low, close, volume and the usual variants); without a header the columns are read in that order. Commas, semicolons, tabs and pipes all work, as do separate date and time columns.</li>
        <li><b>Times</b>: ISO dates (<C>2026-04-01 13:30:00</C>), US or European dates (AM and PM included), compact ones (<C>20260401 133000</C>) and Unix timestamps in seconds, milliseconds, microseconds or nanoseconds. Day and month are told apart by the dates themselves (a first number over 12 means day first). Times without a zone are read as UTC; ISO times with <C>Z</C> or an offset like <C>-05:00</C> are converted. If your file is in another zone without saying so, convert it to UTC first.</li>
        <li><b>Contracts</b>: the app recognises futures by their symbol (ES, NQ, MNQ, CL, GC, ZN, 6E and others, with months like ESM6 or NQZ25) and fills in the point value and tick size. A file with several contracts can follow the busiest one each day (a continuous series), or you pick one.</li>
        <li>Several files of one market (a batch download, a month each, say) can be chosen or dropped together: they are read one after the other in name order, as one data set, so name them so they sort by date (Databento's do).</li>
      </ul>
      <Note>A file is read once and kept in a fast form, so it reopens in a moment. Deleting it from the Library removes that copy, not your original file.</Note>
    </> },
    { id: 'settings', title: 'Settings', body: <>
      <ul>
        <li><b>Time zone</b> for the chart's time axis, the clock, the tables, the journal and where 4-hour candles start.</li>
        <li><b>Trading day starts at</b> (New York time, 6 PM for futures): where daily, weekly and monthly candles and VWAP begin, and prop challenge days from your next session.</li>
        <li><b>Theme and colors</b>: dark and light themes (or match your system), candle colors including a color-blind friendly pair, candle outlines, and your own chart background and grid.</li>
        <li><b>Replay and orders</b>: ticks per bar (4 to 600: more is smoother and fills more precisely, a little slower), pause when an order fills, separate trades (no netting), the buy and sell buttons on each chart, and how the ticket sizes trades when a session starts (by risk, or a fixed number of contracts). They apply to new sessions, and to the open one where it is safe.</li>
        <li><b>Keyboard shortcuts</b>: the full list (<kbd>?</kbd> shows it anywhere).</li>
      </ul>
      <p>Changes save as you make them and apply to every session.</p>
    </> },
  ] },

  { id: 'pyind', title: 'Your own indicators', sections: [
    { id: 'pyind-start', title: 'Writing an indicator', body: <>
      <p>An indicator is a short script, in JavaScript or Python, that runs once on every closed candle of the chart and draws on it: lines, levels, shaded areas, markers, boxes, lines and labels, or a pane of its own under the chart.</p>
      <Steps items={[
        <>Open <b>Indicators</b>, press <b>+ New indicator</b> and pick a template (EMA cross, RSI, Bollinger Bands, Opening range box, Swing levels) or Blank: the JavaScript ones come first, the Python ones under them.</>,
        <>Write the code (or paste one of the examples below), give it a name and press <b>Add to chart</b> (<kbd>Ctrl</kbd> + <kbd>Enter</kbd>). Python loads the first time, in a few seconds.</>,
        <>Change it and press <b>Apply to chart</b>. The code is kept in <i>Your scripts</i> as you type (<b>Save</b> does it at once), so you can add it again any time from the Indicators list.</>,
      ]} />
      <Ex ex={IND_FIRST} />
      <p>Every indicator has:</p>
      <ul>
        <li><b>Settings at the top</b>: UPPERCASE names set to a plain number, True/False or quoted text (<C>LENGTH = 20</C>, <C>OB, OS = 70, 30</C>). They appear on the editor's <b>Settings</b> card: a box for numbers, a tick box for True/False, a list for text whose line's comment has quoted words (<C>SOURCE = "close"  # "close" or "hl2"</C>). Changing one rewrites that line of the code and, when the indicator is on the chart, redraws it at once. Times written as <C>"HH:MM"</C> text stay in the code.</li>
        <li><C>init(ctx)</C> (optional): runs once before the first candle. Make your <C>ta</C> averages and set up anything you keep (<C>ctx.count = 0</C>) here.</li>
        <li><C>on_bar(ctx, bar)</C> (required): runs on each closed candle, oldest first.</li>
      </ul>
      <p>The <b>Console</b> shows what the script prints and, if it fails, the error and the line it failed on.</p>
      <p>Your indicators on the chart stay there in every session, on every chart, until you hide them or take them off (×) in the Indicators list. <b>Edit</b> opens one again.</p>
    </> },
    JS_IND_SECTION,
    { id: 'pyind-run', title: 'How an indicator runs', body: <>
      <ul>
        <li><C>on_bar</C> sees closed candles of the chart's timeframe only, never the one forming and never the future. Its values change when a candle closes.</li>
        <li>When it starts it catches up on the newest 40,000 candles (8,000 on phones and tablets), then each new candle as it closes. <C>bar.index</C> counts from 0 at the first candle it saw.</li>
        <li>It starts again from scratch when the timeframe or time zone changes, when you step or jump back, and when its code or settings change.</li>
        <li>If it raises an error it stops (what it drew stays) and the Indicators list marks it; open it to see the console.</li>
        <li>It runs on Python 3.12 (Pyodide) with numpy. <C>np</C>, <C>ta</C> and <C>rgba</C> are ready without importing. <C>import pandas</C> loads pandas (a few seconds the first time). There is no network, no files and no other packages.</li>
      </ul>
      <Note>Keep each <C>on_bar</C> quick: use the one-value-at-a-time <C>ta</C> classes (<C>ta.EMA(20)</C> made in init, <C>.update(bar.close)</C> on each bar), not a whole-array function over all the history on every candle. Keep what changes on <C>ctx</C>, not in global variables.</Note>
    </> },
    { id: 'pyind-api', title: 'Indicator reference', body: <>
      <h4>The candle: bar</h4>
      <Api items={[
        ['bar.time', 'When the candle opened: a Python datetime in the chart\'s time zone.'],
        ['bar.open, bar.high, bar.low, bar.close, bar.volume', 'Its prices and volume.'],
        ['bar.index', 'Its number: 0 for the first candle the indicator saw, then 1, 2, …'],
      ]} />
      <h4>History and the market: ctx</h4>
      <Api items={[
        ['ctx.closes(n)  ctx.opens(n)  ctx.highs(n)  ctx.lows(n)  ctx.volumes(n)', <>The last <i>n</i> closed candles (all of them without <i>n</i>) as a read-only numpy array, oldest first, the current candle last. <C>ctx.closes(2)[0]</C> is the previous close. Check the length before using it.</>],
        ['ctx.times(n)', 'Their open times as Unix seconds (UTC).'],
        ['ctx.df(n)', 'The candles as a pandas DataFrame indexed by time (needs import pandas).'],
        ['ctx.time, ctx.price, ctx.bar_index', 'The current candle\'s time, close and index.'],
        ['ctx.symbol, ctx.timeframe', 'The market\'s name and the chart\'s timeframe, like "5m".'],
        ['ctx.tick_size, ctx.point_value', 'The smallest price step, and dollars per 1.0 of price per contract.'],
        ['ctx.ticks(n)', 'n ticks as a price distance.'],
        ['ctx.round(price)', 'A price rounded to the market\'s precision.'],
        ['ctx.at("09:30")', 'A time of day (datetime.time), to compare with bar.time.time().'],
      ]} />
      <h4>Plots and levels</h4>
      <Api items={[
        ['ctx.plot(value, title, color=None, width=1, style="line", pane="price")', <>One point a candle on the line called <i>title</i>: call it on every candle with the same title. <C>None</C> or NaN leaves a gap. <b>style</b>: line, step, dashed, dotted, points or histogram. <b>pane="lower"</b> puts it in a band under the chart with its own scale, for things like RSI; all of an indicator's lower plots share one band. The style and pane are fixed by the first call; the color may change on each candle. Up to 64 plots.</>],
        ['ctx.hline(price, title=None, color="muted", width=1, style="dashed", pane="price")', <>A level across the chart. Call it in init; calling it again with the same title moves it. A lower-pane level shows once the indicator has a lower plot. Styles: solid, dashed, dotted.</>],
        ['ctx.fill(title1, title2, color)', 'Shades between two plots on this candle (both need a value on it). Call it on each candle; the color may change.'],
        ['ctx.bgcolor(color)', 'Tints the chart behind this candle. Use a see-through color.'],
        ['ctx.marker(text="", shape="circle", position="above", color="accent", at=None, size=1)', <>A mark on this candle. <b>shape</b>: arrow_up, arrow_down, circle, square. <b>position</b>: above, below, inside. <b>at</b> (a bar index or time) puts it on an earlier candle, for something confirmed later, like a swing high. Text up to 40 characters.</>],
      ]} />
      <h4>Boxes, lines and labels</h4>
      <Api items={[
        ['ctx.box(left, top, right, bottom, color="accent", fill=None, width=1, style="solid", text="", text_color=None, extend=False)', 'A rectangle. The fill defaults to the color at 15%. extend=True runs it to the right edge.'],
        ['ctx.line(x1, y1, x2, y2, color="accent", width=1, style="solid", extend="none")', 'A line between two points. extend: none, right, left or both.'],
        ['ctx.label(x, y, text, color="accent", text_color=None, style="up")', 'Text at a point. style up sits below the price and points up at it (for lows), down sits above and points down (for highs), center sits on it, text has no background.'],
        ['x positions', <>Bar indexes (<C>bar.index</C>, <C>bar.index - 5</C>, and future ones like <C>bar.index + 10</C>) or times (<C>bar.time</C>). y positions are prices.</>],
        ['changing one', <>Each call returns the drawing. Keep it on ctx and change it later: <C>ctx.box_.right = bar.index</C> or <C>ctx.box_.set(top=…, bottom=…)</C>. <C>.delete()</C> removes it.</>],
        ['limits', <>Up to 500 boxes, 500 lines and 500 labels per indicator; past that the oldest of that kind goes. <C>ctx.boxes</C>, <C>ctx.lines</C> and <C>ctx.labels</C> list the ones still there; <C>ctx.clear()</C> removes them all.</>],
      ]} />
      <h4>Colors</h4>
      <p>Any CSS color (<C>"#22c55e"</C>, <C>"orange"</C>) or a theme color that follows light and dark themes: <C>"up"</C>, <C>"down"</C>, <C>"accent"</C>, <C>"muted"</C>, <C>"fg"</C>. <C>rgba(color, alpha)</C> makes any of them see-through, from 0 (clear) to 1 (solid); about 0.08 to 0.2 suits fills, tints and boxes.</p>
    </> },
    { id: 'ta', title: 'The ta library', body: <>
      <p><C>ta</C> has the usual indicator math, the same for indicators and strategies (Python and JavaScript). It matches the chart's own EMA and SMA.</p>
      <h4>One value at a time (fast; use these in on_bar)</h4>
      <p>Make one in init and call <C>.update(…)</C> on each candle. It returns the value, or <C>None</C> while it warms up; <C>.value</C> holds the last one.</p>
      <Api items={[
        ['ta.SMA(n), ta.EMA(n), ta.RMA(n)', 'Simple, exponential (seeded with the simple average of the first n, like the chart) and Wilder\'s average. .update(x).'],
        ['ta.RSI(n=14)', 'Relative strength index. .update(close).'],
        ['ta.ATR(n=14)', 'Average true range. .update(high, low, close).'],
        ['ta.STDEV(n)', 'Standard deviation of the last n values (population, as most charting tools). .update(x).'],
        ['ta.HIGHEST(n), ta.LOWEST(n)', 'The highest and lowest of the last n values. .update(x).'],
      ]} />
      <h4>Whole arrays</h4>
      <p>Give them an array (like <C>ctx.closes(100)</C>); they return an array of the same length, NaN where there is not enough data yet.</p>
      <Api items={[
        ['ta.sma(x, n), ta.ema(x, n), ta.rma(x, n)', 'The averages over an array.'],
        ['ta.rsi(x, n=14), ta.atr(highs, lows, closes, n=14), ta.stdev(x, n)', 'RSI, ATR, standard deviation.'],
        ['ta.highest(x, n), ta.lowest(x, n)', 'Rolling highest and lowest.'],
        ['ta.crossover(a, b), ta.crossunder(a, b)', 'True when a crossed above (below) b on the last value. b may be a number.'],
      ]} />
      <Note kind="warn">A whole-array function over all the history on every candle gets slower with every candle. Pass a window instead: <C>ta.rsi(ctx.closes(100), 14)[-1]</C>, or better, a <C>ta.RSI</C> made in init.</Note>
    </> },
    { id: 'pyind-time', title: 'Times of day', body: <>
      <p><C>bar.time</C> is in the chart's time zone, which you can change in Settings. To make a script work the same whatever the zone, convert to one zone before comparing times. The app has no time zone database, so copy this helper for US Central Time (it knows when daylight saving starts and ends):</p>
      <Code code={`from datetime import datetime, timedelta, timezone\n\n${PY_TO_CT}`} />
      <p>Then <C>ct = to_ct(bar.time)</C>; <C>ct.date()</C> tells a new day and <C>ct.time()</C> compares with <C>ctx.at("08:30")</C>. Work out <C>ctx.at(…)</C> once in init. Change -5 and -6 for another zone, or drop the helper and use <C>bar.time</C> directly if you keep the chart's zone fixed.</p>
    </> },
    { id: 'pyind-examples', title: 'Indicator examples', body: <>
      <p>Each one works as it is: copy it into a new Python indicator and add it to the chart.</p>
      <Ex ex={IND_RSI} />
      <Ex ex={IND_BANDS} />
      <Ex ex={IND_ORB} />
      <Ex ex={IND_LEVELS} />
    </> },
    { id: 'pine', title: 'Coming from Pine Script', body: <>
      <Api items={[
        ['plot(x)', <><C>ctx.plot(x, "Title")</C> on every candle</>],
        ['indicator(overlay=false)', <><C>pane="lower"</C> on the plots</>],
        ['hline(70)', <><C>ctx.hline(70, pane="lower")</C> in init</>],
        ['fill(p1, p2, color)', <><C>ctx.fill("Title 1", "Title 2", color)</C> on every candle</>],
        ['bgcolor(c)', <><C>ctx.bgcolor(c)</C></>],
        ['plotshape(cond, …)', <><C>if cond: ctx.marker(…)</C></>],
        ['box.new / box.set_right(b, x)', <><C>b = ctx.box(…)</C> / <C>b.right = x</C></>],
        ['line.new, label.new', <><C>ctx.line(…)</C>, <C>ctx.label(…)</C></>],
        ['close[1]', <><C>ctx.closes(2)[0]</C></>],
        ['ta.ema(close, 20)', <><C>ctx.e = ta.EMA(20)</C> in init, <C>ctx.e.update(bar.close)</C> in on_bar</>],
        ['var x = 0', <><C>ctx.x = 0</C> in init</>],
        ['bar_index, time', <><C>bar.index</C>, <C>bar.time</C></>],
        ['color.new(c, 80)', <><C>rgba(c, 0.2)</C>: transparency t becomes alpha 1 − t/100</>],
        ['input.int(14)', 'A setting at the top: LENGTH = 14'],
        ['request.security', 'No equivalent: build higher-timeframe values from the chart\'s own candles.'],
      ]} />
    </> },
  ] },

  { id: 'backtest', title: 'Strategies and backtesting', sections: [
    { id: 'bt-start', title: 'The Backtest page', body: <>
      <p>A strategy is a script that trades by itself. The Backtest page runs it over the dates you choose, as fast as it can, and shows how it did.</p>
      <ul>
        <li>On a computer your strategies are listed on the left; beside them, one page has the code, the Run settings and the console, each in a card you can fold, with Results, Optimize and Robustness as tabs. On a phone the strategies, the code and the Run settings are tabs of their own.</li>
        <li><b>Strategies</b>: your scripts, saved as you type. <b>New</b> starts one from a template (MA cross, Opening range breakout, Breakout with trailing stop, or Blank in Python; MA cross or Blank in JavaScript). Double-click a name (or <b>Rename</b>) to rename it; the bin deletes it.</li>
        <li><b>Code</b>: the editor. Fold it to a one-line summary to give the settings the room, or drag its bottom edge to make it taller; it remembers both. <kbd>Ctrl</kbd> + <kbd>Enter</kbd> runs. JavaScript strategies run several times faster than Python, which helps long optimizations; Python ones can use numpy (and pandas). <b>Guide</b> opens this reference beside it.</li>
        <li><b>Run</b>: the market (a practice market or one of your data files), the dates (from and to), the candle size the strategy sees, and:
          <ul>
            <li><b>The strategy runs</b>: <i>At bar close</i> calls on_bar when each candle closes (fast). <i>Every tick</i> also calls on_tick on every simulated price move, for trailing stops and the like (slower).</li>
            <li><b>Libraries</b>: numpy, or numpy + pandas (pandas takes a few seconds to load).</li>
            <li><b>Starting balance</b>, and the <b>order size</b> used when the strategy gives none.</li>
            <li><b>Costs</b>: commission per side, spread and slippage.</li>
            <li><b>Prop challenge</b>, in its own card: a prop challenge the run trades under, with the same rules as in a session. Tick <i>Buy a new evaluation when one fails</i> to keep going after a failure (at most a number of evaluations, if you set one); the results then show your payouts, the fees and the evaluations bought.</li>
          </ul>
        </li>
        <li><b>Run backtest</b> runs it; <b>Stop</b> stops it part way. The <b>console</b> card opens when the run prints: print() output, errors and a summary. An error opens the code at the line that failed.</li>
        <li><b>Results</b>: net P&amp;L, trades, win rate, profit factor, max drawdown, average trade and more, the equity curve and the trades (the latest 500; <b>Copy trades (CSV)</b> has them all). <b>Edit and run again</b> goes back to the code.</li>
        <li><b>Show on chart</b> opens the run as a new replay session (its name ends in "Automated"): the same market, its trades on the chart and in the account, the tape at the point where the run ended, so you can see what it did and keep replaying from there.</li>
      </ul>
    </> },
    { id: 'st-write', title: 'Writing a strategy', body: <>
      <Ex ex={STRAT_FIRST} />
      <p>A strategy has the same shape as an indicator: settings at the top, then functions the runner calls (it needs <C>on_bar</C> or, with Every tick, <C>on_tick</C>).</p>
      <Api items={[
        ['init(ctx)', 'Once, before the first candle.'],
        ['on_bar(ctx, bar)', 'When each candle closes: bar.time (its open, in the chart\'s time zone), open, high, low, close, volume, index.'],
        ['on_tick(ctx, tick)', 'On every price move, with Every tick only: tick.time, tick.price. on_bar still runs at each close.'],
        ['on_fill(ctx, fill)', 'When an order fills: fill.side ("buy" or "sell"), qty, price, time, kind ("entry" or "exit"), reason ("Market", "Limit fill" or "Stop fill" for entries; "Stop loss", "Take profit" or "Strategy close" for exits), trade_id, and pnl on exits (after costs).'],
        ['on_end(ctx)', 'Once, after the last candle.'],
      ]} />
      <p>Keep what changes on <C>ctx</C> (<C>ctx.count = 0</C> in init); read settings as plain names. <C>print()</C> writes to the console (it is silent during optimizations).</p>
    </> },
    { id: 'st-api', title: 'Strategy reference', body: <>
      <h4>Market data</h4>
      <Api items={[
        ['ctx.closes(n)  ctx.opens(n)  ctx.highs(n)  ctx.lows(n)  ctx.volumes(n)  ctx.times(n)', 'The last n closed candles, oldest first (all without n), as read-only numpy arrays. Check the length before using them.'],
        ['ctx.df(n)', 'A pandas DataFrame of the candles (numpy + pandas only).'],
        ['ctx.price, ctx.bid, ctx.ask, ctx.spread', 'The price now (the close in on_bar). Sells fill at the bid, buys at the ask (the bid plus the spread).'],
        ['ctx.time, ctx.bar_index', 'The current time and candle number.'],
        ['ctx.symbol, ctx.timeframe, ctx.tick_size, ctx.point_value', 'The market, the candle size, the smallest price step, and dollars per 1.0 of price per contract.'],
        ['ctx.ticks(n), ctx.round(price), ctx.at("HH:MM")', 'n ticks as a price distance; a price rounded to the market\'s precision; a time of day.'],
        ['ctx.mode, ctx.default_qty', '"bar" or "tick"; the Run panel\'s order size.'],
      ]} />
      <h4>Orders</h4>
      <Api items={[
        ['ctx.buy(qty=None, sl=None, tp=None, limit=None, stop=None)', 'Buys at the market, or as a limit or stop order when you give limit= or stop=. sl and tp are prices for the stop loss and take profit.'],
        ['ctx.sell(…)', 'The same, selling.'],
        ['ctx.buy_limit(price, qty=None, sl=None, tp=None)', 'And buy_stop, sell_limit, sell_stop: the same as buy(limit=price) and the others.'],
        ['ctx.close()', 'Closes every open position at the market.'],
        ['ctx.cancel(order_id), ctx.cancel_all()', 'Cancels one working order, or all of them.'],
        ['ctx.set_bracket(sl=None, tp=None)', 'Moves the stop loss and/or take profit of the open position.'],
      ]} />
      <p>Every order call returns the order's id, or <C>None</C> if it was rejected (the console says why, once per kind). Without qty it uses the Run panel's order size. A buy stop must be above the ask and a sell stop below the bid.</p>
      <h4>The account</h4>
      <Api items={[
        ['ctx.position, ctx.position_price', 'Contracts held (positive long, negative short, 0 flat) and their average price.'],
        ['ctx.orders', 'Working orders: dicts with id, side, type, price, qty, sl, tp.'],
        ['ctx.trades', 'Open trades: dicts with id, side, qty, entry, sl, tp, pnl.'],
        ['ctx.history', 'Closed trades: dicts with id, side, qty, entry, exit, reason, pnl, entry_time, exit_time.'],
        ['ctx.balance, ctx.equity', 'The balance after closed trades, and with the open ones counted.'],
      ]} />
      <h4>How a run fills orders</h4>
      <ul>
        <li>Market orders and <C>close()</C> fill on the next tick: from on_bar, at the <b>next candle's open</b>. Size a market entry from <C>ctx.ask</C> (buys) or <C>ctx.bid</C> (sells).</li>
        <li>Each bar of data is replayed as 20 ticks: open → low → high → close (rising) or open → high → low → close (falling); limits, stops and brackets fill when touched, a stop loss before a take profit on the same tick. Costs come from the Run panel, filled as in a session (see <i>How orders fill</i>).</li>
        <li>One position at a time (netting): to reverse, <C>ctx.close()</C> then enter the other way.</li>
        <li>Prop rules, when the run has a challenge, are applied by the app (an order over the size limit is rejected, a broken max loss ends the account); the strategy doesn't code them.</li>
        <li>Positions still open at the end stay open: the summary says how many.</li>
      </ul>
    </> },
    { id: 'st-risk', title: 'Sizing by risk, times and daily limits', body: <>
      <p>Strategies that trade like a person usually risk a fixed amount per trade, trade at set times of day, and stop after a number of trades. This helper sizes a trade so the loss at its stop is <C>RISK_USD</C>, rounded down, and never more than <C>MAX_QTY</C>:</p>
      <Code code={`import math\n\nRISK_USD = 200   # $ risked per trade (the loss at the stop)\nQTY_STEP = 1     # 1 for futures contracts, 0.01 for forex lots\nMAX_QTY  = 5     # most contracts per trade, 0 = off\n\n${PY_SIZE_FOR}`} />
      <ul>
        <li>Pass <C>qty=size_for(ctx, entry, stop)</C> with every entry, and skip the trade when it returns <C>None</C> (the stop is too wide for your risk).</li>
        <li>For times of day, use the <C>to_ct</C> helper from <i>Times of day</i> and compare <C>to_ct(bar.time).time()</C> with <C>ctx.at("08:30")</C>. Reset daily counters when <C>to_ct(bar.time).date()</C> changes.</li>
        <li>Count entries in on_fill (<C>fill.kind == "entry"</C>) to limit trades per day, and flatten with <C>ctx.cancel_all()</C> and <C>ctx.close()</C> at a set time.</li>
      </ul>
      <p>The example below puts all of it together.</p>
    </> },
    { id: 'st-examples', title: 'Strategy examples', body: <>
      <Ex ex={STRAT_ORB} />
      <Ex ex={STRAT_TRAIL} />
    </> },
    { id: 'st-js', title: 'JavaScript strategies', body: <>
      <p>JavaScript strategies have the same functions, the same ctx and the same ta, and run several times faster than Python. The differences:</p>
      <ul>
        <li>Settings are top-level <C>const NAME = value;  // comment</C> lines (let and var work too).</li>
        <li>Options go in an object: <C>ctx.buy({'{'} qty: 2, sl: 99.5, tp: 101 {'}'})</C>, <C>ctx.buy_stop(price, {'{'} sl {'}'})</C>, <C>ctx.set_bracket({'{'} sl {'}'})</C>. Positional arguments work too, in Python's order: <C>ctx.buy(2, 99.5, 101)</C>.</li>
        <li>Candle arrays are <C>Float64Array</C>s: <C>c[c.length - 1]</C> is the last close; <C>c.subarray(a, b)</C> takes part of one.</li>
        <li>Times are not Python datetimes: <C>bar.time.date()</C> gives <C>"YYYY-MM-DD"</C> text to spot a new day, <C>bar.time.time()</C> the seconds since midnight to compare with <C>ctx.at("09:30")</C> (also seconds), and <C>bar.time.hour</C>, <C>.minute</C>, <C>.weekday()</C> (Monday 0), <C>.timestamp()</C> and <C>.tz(offsetSeconds)</C>.</li>
        <li><C>ctx.df()</C> needs pandas, so it is Python only. <C>print()</C> writes to the console. Errors show the line of your code, as in Python.</li>
      </ul>
      <p>For Central Time in JavaScript:</p>
      <Code lang="javascript" code={JS_TO_CT} />
      <Ex ex={STRAT_JS} lang="javascript" />
    </> },
    { id: 'optimize', title: 'The optimizer', body: <>
      <p>The optimizer runs a strategy many times with different settings, on the market and dates of the Run panel, and ranks the results.</p>
      <Steps items={[
        <>Tick the settings to try and say which values: a range (<C>5..30</C>), a range with a step (<C>15..60 step 5</C>, or <C>15..60/5</C>), or a list (<C>9, 14, 21</C>); True/False and text settings list their choices. <b>Narrow</b>, <b>Normal</b> and <b>Wide</b> fill in ranges around the current values. Settings that set money or size (names with RISK, USD, DOLLAR, CASH, BALANCE, ACCOUNT, QTY, SIZE, LOTS, CONTRACTS, or ending in STEP) are marked <i>size</i> and left unticked.</>,
        <>Choose <b>how to search</b>: <i>Smart</i> finds a near-best in about a tenth of the runs (a coarse look over the whole range, then closer looks around the best); <i>All combinations</i> tries every one (up to 20,000); <i>Random sample</i> tries as many as you say.</>,
        <>Optionally add <b>rules</b> combinations must meet, one per line, written like Python over the ticked settings (<C>FAST &lt; SLOW</C>, <C>abs(A - B) &gt;= 2</C>); combinations that fail one are not run. This works for JavaScript strategies too.</>,
        <>Pick the <b>goal</b> (net ÷ max drawdown prefers steady gains over lucky ones; or net P&amp;L, profit factor, or payouts − fees when the run has a prop challenge) and the <b>minimum trades</b> a combination needs to be ranked.</>,
        <><b>Check on the last</b> 20–40% keeps the end of the dates out of the ranking and shows how each combination did there (the Check columns): a guard against settings that only fit the past.</>,
        <>Run it. On a computer with several cores it runs several combinations at once, and shows the best so far as it goes. Click a column to sort by it; click a row to select it: <b>Use in code</b> writes its values into the strategy, <b>Show on chart</b> opens it as a replay session. <b>Copy results (CSV)</b> exports the table; <b>Test robustness</b> checks the best ones.</>,
      ]} />
      <p>How the code tells the optimizer about settings:</p>
      <ul>
        <li>Only plain values are found: numbers, True/False and quoted text. Times (<C>"09:30"</C>), <C>None</C> and anything computed are left out. Don't compute one setting from another at the top: use a ratio setting such as <C>RR = 2</C> instead.</li>
        <li>Quoted words in a text setting's comment are the choices to try: <C>DIRECTION = "both"  # "both", "long" or "short"</C>.</li>
        <li><C># 0 = off</C> in the comment makes 0 one of the values always tried.</li>
        <li>For an exact range: <C>LOOKBACK = param(20, 10, 40, step=5)</C> or <C>MODE = param("break", values=["break", "retest"])</C> (in JavaScript, <C>param(20, 10, 40, 5)</C> and <C>param("break", {'{'} values: […] {'}'})</C>). In a normal run, param() is just its first value.</li>
      </ul>
      <p>Each optimization saves itself to Library › Optimizations when it finishes; open it there to see its results again.</p>
    </> },
    { id: 'robust', title: 'Robustness tests', body: <>
      <p>Good results on the dates the settings were picked on can be luck. <b>Test robustness</b> (or the Robustness tab) takes the best combinations of an optimization and checks them on other dates and other orders of their trades:</p>
      <ul>
        <li><b>Test the best</b>: what share of the ranked combinations to test (up to 200 of them).</li>
        <li><b>Out of sample</b>: each candidate on dates the optimization did not rank on (the holdout, From and To; the Check period by default), with its trades, net, profit factor and drawdown there, and how that compares with the ranked dates. It passes when it made money there with a profit factor of at least 1.</li>
        <li><b>Walk-forward</b>: the ranked dates cut into windows (how many, and the in-sample share of each); the best settings on each window's first part trade its next part. Rolling windows move along; anchored ones always start at the beginning. A candidate passes when at least half its windows made money.</li>
        <li><b>Monte Carlo</b>: each candidate's trades redrawn many times (Simulations; resampled, or shuffled), optionally skipping some, to see how bad the drawdown could have been and how often it stayed in profit; with <i>Ruin at a drawdown of</i>, how often a drawdown reached that many dollars. It passes when at least 70% of the draws end in profit and at most 5% are ruined.</li>
        <li><b>Passed</b> counts the tests each candidate passed, of the ones it took. Prefer settings that pass them all to the one with the biggest backtest. Changing the windows or the Monte Carlo settings updates the table without running anything again.</li>
      </ul>
    </> },
  ] },

  { id: 'more', title: 'More', sections: [
    { id: 'phone', title: 'Phones and tablets', body: <>
      <ul>
        <li>The tab bar at the bottom has the <b>Chart</b>, the <b>Trade</b> ticket, your <b>Positions</b>, the <b>Journal</b>, and <b>More</b> (new session, Library, Backtest, this guide, Settings and the classic view).</li>
        <li>The chart's header has the timeframe, indicators, drawing tools and chart options (one or two charts, adding a market, which market to trade).</li>
        <li>The replay bar sits under the chart: back, play, forward, the clock, the speed and Jump. Drag the thin timeline along its top to move in time.</li>
        <li>Buy and sell from the row under the chart. Hold a finger on the chart for an order at that price. Pinch to zoom, drag to scroll.</li>
        <li>Menus open from the bottom of the screen; tap outside one to close it.</li>
        <li>Phones and tablets keep fewer candles on the chart and in your indicators (8,000) so everything stays smooth.</li>
      </ul>
    </> },
    { id: 'keys', title: 'Keyboard shortcuts', body: <>
      <h4>Replay</h4>
      <Keys rows={[['Space', 'Play or pause'], ['→', 'Play to the end of the current bar of data'], ['Shift + →', 'Play to the end of the current candle'], ['←', 'Go back one candle'], ['.', 'Play one tick'], ['↑', 'Faster'], ['↓', 'Slower']]} />
      <h4>Trading</h4>
      <Keys rows={[['B', 'Buy with the order ticket'], ['S', 'Sell with the order ticket'], ['X', 'Close all positions']]} />
      <h4>Drawing</h4>
      <Keys rows={[['Alt + T', 'Trend line'], ['Alt + H', 'Horizontal line'], ['Alt + J', 'Horizontal ray'], ['Alt + V', 'Vertical line'], ['Alt + C', 'Cross line'], ['Alt + F', 'Fibonacci retracement'], ['Alt + Shift + R', 'Rectangle'], ['Shift + drag', 'Keep a line flat, upright or at 45°'], ['Shift + click', 'Measure a move'], ['Ctrl', 'Hold to flip the magnet'], ['Enter', 'Finish a path'], ['Delete', 'Delete the selected drawing'], ['Esc', 'Stop drawing, deselect'], ['Ctrl + Z', 'Undo'], ['Ctrl + Shift + Z', 'Redo (Ctrl + Y too)'], ['Ctrl + C', 'Copy a drawing (Ctrl + V pastes)']]} />
      <h4>Anywhere</h4>
      <Keys rows={[['Z', 'Show or hide price zones'], ['?', 'The list of shortcuts']]} />
      <p>On a Mac, use <kbd>⌘</kbd> where this says <kbd>Ctrl</kbd>. The replay and trading keys work on the chart screen, not while you type in a box.</p>
    </> },
    { id: 'trouble', title: 'When something goes wrong', body: <>
      <Api items={[
        ['Python did not load', 'It downloads nothing: it comes with the app. Close the editor and try again; if it keeps failing, restart the app.'],
        ['An indicator stopped', 'Its name is marked in the Indicators list. Open it: the console shows the error and the line. Fix it and press Apply to chart.'],
        ['"Order rejected" in the console', 'The message says why: a stop on the wrong side of the price, a size of 0, or a prop rule. Each kind is printed once, then counted.'],
        ['Times look an hour off', 'Check Settings › Time zone, and that your file\'s times are UTC or carry their offset. Scripts comparing times should convert with to_ct.'],
        ['My file was not recognised', 'It needs a time column and open, high, low and close. The error names the header it found; rename the columns if they are unusual.'],
        ['A strategy runs slowly', 'Use At bar close unless you need ticks, avoid whole-array ta functions on every candle, prefer numpy to loops, or write it in JavaScript.'],
        ['The optimizer says too many combinations', 'Narrow the ranges, add a rule, use Smart, or a random sample.'],
      ]} />
    </> },
  ] },
];

/** the section ids, in order */
export const SECTION_IDS = CHAPTERS.flatMap(c => c.sections.map(s => s.id));
