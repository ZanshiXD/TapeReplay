// Settings: the time the app shows, the theme and chart colors, how the replay plays and orders fill, the keyboard
// shortcuts and the credits. Each change is saved at once (pref) and put in force (applyLook, applyReplayPrefs).
import { useEffect, useState, type ReactNode } from 'react';
import type { Session } from '../core/session';
import { LOCAL_TZ, tzOffset } from '../core/time';
import { bump, pref, setPref, useLive } from './live';
import { setTicket } from './ticket';
import { CANDLE_SETS, C, FIXED_OFFSETS, PALETTES, THEME_DEF, ZONES, activePalette, applyLook, fixedId, palOf, theme, type Palette, type Theme } from './look';
import { store, classicHref } from './appstore';

/* ---- replay and orders ---- */
export const ticksPref = () => Math.max(4, Math.min(600, Math.round(pref('ticks', 20)) || 20));
/** the replay and order settings on a session: when it starts or opens (fresh), or as they change (netting only
 *  switches while nothing is open, so open trades keep the rule they were made under) */
export function applyReplayPrefs(s: Session, fresh: boolean) {
  const n = ticksPref();
  s.ticksPerBar = n; for (const f of s.feeds) f.ticksPerBar = n; // from the next bar on
  s.account.pauseOnFill = pref('pauseFill', false);
  if (fresh || (!s.account.trades.length && !s.account.orders.length)) s.account.hedge = pref('hedge', false);
}
/** the order ticket a new session starts with */
export const startTicket = (risk: number) => ({ type: 'market' as const, risk, mode: pref<'risk' | 'qty'>('sizeBy', 'risk'), qty: Math.max(1, pref('qty', 1)) });

/* ---- the credit the chart library asks for ---- */
export const Credit = ({ style }: { style?: React.CSSProperties }) =>
  <p className="credit" style={style}>Charts by <a href="https://www.tradingview.com/" target="_blank" rel="noopener">TradingView</a> Lightweight Charts™, © TradingView, Inc.</p>;

/* ---- keyboard shortcuts ---- */
const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';
const KEYS: Array<[string, Array<[string, string]>]> = [
  ['Replay', [['Space', 'Play or pause the replay'], ['→', 'Play to the end of the current bar of data'], ['Shift + →', 'Play to the end of the current candle on the chart'],
    ['←', 'Go back one candle'], ['.', 'Play one tick (the smallest price move the replay makes)']]],
  ['Trading', [['B', 'Buy with the order ticket'], ['S', 'Sell with the order ticket'], ['X', 'Close all positions at the market price'],
    ['Drag a line', 'Move an order, a stop loss or a take profit on the chart']]],
  ['Drawing', [['Alt + T', 'Trend line'], ['Alt + H', 'Horizontal line'], ['Alt + J', 'Horizontal ray'], ['Alt + V', 'Vertical line'], ['Alt + C', 'Cross line'],
    ['Alt + F', 'Fibonacci retracement'], ['Alt + Shift + R', 'Rectangle'], ['Shift + drag', 'Keep a line flat, upright or at 45 degrees'], ['Shift + click', 'Measure a price move and how long it took'],
    [`Hold ${MOD}`, 'Turn the magnet on or off while you place points (it snaps to the candle’s open, high, low or close)'], ['Enter', 'Finish a path'],
    ['Double-click', 'A drawing’s settings'], ['Right-click', 'A drawing’s menu'], ['Delete', 'Delete the selected drawing (Backspace too)'],
    ['Esc', 'Stop drawing, deselect, or go back to the cursor'], [`${MOD} + Z`, 'Undo'], [`${MOD} + Shift + Z`, `Redo (${MOD} + Y too)`], [`${MOD} + C, ${MOD} + V`, 'Copy and paste a drawing']]],
  ['Anywhere', [['?', 'Show this list'], ['Esc', 'Close this list']]],
];
export function KeysList() {
  return <div className="keys">{KEYS.map(([g, ks]) => <section key={g}><h5>{g}</h5>{ks.map(([k, d]) => <div key={g + k} className="krow"><span>{k.split(/( \+ |, )/).map((x, i) => / \+ |, /.test(x) ? <i key={i}>{x.trim()}</i> : <kbd key={i}>{x}</kbd>)}</span><span>{d}</span></div>)}</section>)}</div>;
}
export function KeysSheet({ onClose }: { onClose: () => void }) {
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }; addEventListener('keydown', k, true); return () => removeEventListener('keydown', k, true); }, [onClose]);
  return (
    <div className="modal-back" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal keysheet" role="dialog" aria-modal="true" aria-labelledby="keysT">
        <header><b id="keysT">Keyboard shortcuts</b><span className="spacer" /><button className="btn sm primary" onClick={onClose}>Done</button></header>
        <div className="body"><KeysList /><Credit /></div>
      </div>
    </div>
  );
}

/* ---- the page ---- */
const hourName = (h: number) => `${h === 0 ? '12 AM (midnight)' : h === 12 ? '12 PM (noon)' : h < 12 ? `${h} AM` : `${h - 12} PM`} · ${String(h).padStart(2, '0')}:00`;
const offName = (s: number) => `UTC${s < 0 ? '−' : '+'}${Math.floor(Math.abs(s) / 3600)}${Math.abs(s) % 3600 ? ':' + String(Math.round(Math.abs(s) % 3600 / 60)).padStart(2, '0') : ''}`;
function zoneLabel(id: string, name: string) {
  const tz = id === 'local' ? LOCAL_TZ : id, now = Math.floor(Date.now() / 1000);
  let ab = '';
  try { ab = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(new Date()).find(x => x.type === 'timeZoneName')?.value || ''; } catch { /* */ }
  const off = offName(tzOffset(tz, now));
  return `${name}${id === 'local' ? ` (${tz.replace(/_/g, ' ')})` : ''} · ${ab && ab !== off && !/^GMT/.test(ab) ? ab + ' · ' : ''}${off}`;
}

function Row({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return <div className="srow"><div className="t"><b>{title}</b>{hint && <span>{hint}</span>}</div><div className="c">{children}</div></div>;
}
function Group({ id, title, lead, children }: { id: string; title: string; lead?: string; children: ReactNode }) {
  return <section className="card sgroup" aria-labelledby={id}><header><h2 id={id}>{title}</h2>{lead && <p>{lead}</p>}</header>{children}</section>;
}
function Preview({ p }: { p: Palette }) {
  const v = p.v, cs = [[.55, .3, 1], [.35, .5, 0], [.5, .35, 1], [.3, .6, 1], [.55, .25, 0]];
  return <span className="pv" style={{ background: v.panel, borderColor: v.line }}>
    {cs.map(([top, h, up], k) => <i key={k} style={{ marginTop: `${top * 30}px`, height: `${h * 30}px`, background: up ? v.up : v.down }} />)}
    <u style={{ background: v.accent }} />
  </span>;
}

export function SettingsPage({ session, onKeys, onToast }: { session: Session | null; onKeys: () => void; onToast: (m: string, k?: string) => void }) {
  useLive();
  const [, setV] = useState(0);
  const [version, setVersion] = useState('');
  useEffect(() => { store.caps().then(c => setVersion(store.kind === 'app' ? (c.version ? `Version ${c.version}` : 'The desktop app') : 'In a web browser: nothing to install')).catch(() => {}); }, []);
  const put = (k: string, v: unknown) => { setPref(k, v); setV(x => x + 1); };
  const look = (k: string, v: unknown) => { put(k, v); applyLook(); };
  const th = theme(), pal = activePalette(th);
  const setTh = (p: Partial<Theme>) => look('theme', { ...th, ...p });
  const tz = pref('tz', 'local'), day = pref('dayStart', 18);
  const replay = (k: string, v: unknown) => { put(k, v); if (session) { applyReplayPrefs(session, false); session.changed(); } };
  const setIdx = th.up && th.down ? CANDLE_SETS.findIndex(([u, d]) => u === th.up && d === th.down) : -2;
  const candles = !th.up && !th.down && !th.wickUp && !th.wickDown ? 'theme' : setIdx >= 0 && !th.wickUp && !th.wickDown ? String(setIdx) : 'own';
  const [own, setOwn] = useState(candles === 'own');
  const hedgeLater = session && session.account.hedge !== pref('hedge', false);

  const palCard = (id: string, name: string, note: ReactNode, prev: Palette) => (
    <button key={id} role="radio" aria-checked={th.mode === id} className={'palcard' + (th.mode === id ? ' on' : '')} onClick={() => setTh({ mode: id })}>
      <Preview p={prev} /><b>{name}</b><span>{note}</span></button>
  );
  const colorIn = (label: string, val: string, def: string, set: (v: string) => void) => (
    <label className="colorin" title={label}><input type="color" aria-label={label} value={val || def} onChange={e => set(e.target.value)} /><span>{label}</span></label>
  );
  return (
    <div className="page">
      <div className="page-in settings">
        <div><h1>Settings</h1><p className="lead">Changes are saved as you make them, and kept for every session.</p></div>

        <Group id="sTime" title="Time" lead="Prices are stored in universal time (UTC). Choose which clock the app shows them in.">
          <Row title="Time zone" hint="Used for the chart’s time axis, the clock, the tables, the journal, and the start of 4-hour candles.">
            <select className="in ui" aria-label="Time zone" value={tz} onChange={e => { look('tz', e.target.value); onToast(`Times now show in ${e.target.selectedOptions[0].text.split(' · ')[0]}`); }}>
              {ZONES.map(([id, n]) => <option key={id} value={id}>{zoneLabel(id, n)}</option>)}
              <optgroup label="Fixed offset (no daylight saving)">{FIXED_OFFSETS.map(h => <option key={h} value={fixedId(h)}>{offName(h * 3600)}</option>)}</optgroup>
            </select>
          </Row>
          <Row title="Trading day starts at" hint="In New York time. Futures trade almost around the clock and their day starts at 6 PM New York. Daily, weekly and monthly candles, VWAP, and the days of a prop challenge (from your next session) start here.">
            <select className="in ui" aria-label="Trading day starts at" value={day} onChange={e => look('dayStart', +e.target.value)}>
              {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hourName(h)}{h === 18 ? ' (futures)' : ''}</option>)}
            </select>
          </Row>
        </Group>

        <Group id="sTheme" title="Theme and colors" lead="Dark themes are easy on the eyes at night; light ones read well in a bright room.">
          <div className="palgrid" role="radiogroup" aria-label="Theme">
            {palCard('system', 'Match my system', `${palOf(th.dark)?.name || 'Tape'} when dark, ${palOf(th.light)?.name || 'Paper'} when light`, activePalette({ ...th, mode: 'system' }))}
            {PALETTES.map(p => palCard(p.id, p.name, p.note || (p.kind === 'dark' ? 'Dark' : 'Light'), p))}
          </div>
          {th.mode === 'system' && <Row title="With Match my system" hint="The theme to use when your computer is set to dark, and when it is set to light.">
            <div className="duo">
              <label className="field">When dark<select className="in ui" value={th.dark} onChange={e => setTh({ dark: e.target.value })}>{PALETTES.filter(p => p.kind === 'dark').map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
              <label className="field">When light<select className="in ui" value={th.light} onChange={e => setTh({ light: e.target.value })}>{PALETTES.filter(p => p.kind === 'light').map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
            </div>
          </Row>}
          <Row title="Candle colors" hint="Rising candles (the price went up) and falling ones. The color-blind friendly pair avoids red and green. Profits and losses use the same colors.">
            <select className="in ui" aria-label="Candle colors" value={own ? 'own' : candles} onChange={e => {
              const v = e.target.value; setOwn(v === 'own');
              if (v === 'theme') setTh({ up: '', down: '', wickUp: '', wickDown: '' });
              else if (v !== 'own') setTh({ up: CANDLE_SETS[+v][0], down: CANDLE_SETS[+v][1], wickUp: '', wickDown: '' });
            }}>
              <option value="theme">The theme’s own</option>
              {CANDLE_SETS.map(([, , n], k) => <option key={k} value={String(k)}>{n}</option>)}
              <option value="own">Your own colors</option>
            </select>
          </Row>
          {own && <Row title="Your candle colors" hint="The body of each candle, and its wick (the thin line to the high and low).">
            <div className="swatches">
              {colorIn('Up', th.up, C.up, v => setTh({ up: v }))}{colorIn('Down', th.down, C.down, v => setTh({ down: v }))}
              {colorIn('Up wick', th.wickUp, C.wickUp, v => setTh({ wickUp: v }))}{colorIn('Down wick', th.wickDown, C.wickDown, v => setTh({ wickDown: v }))}
            </div>
          </Row>}
          <Row title="Candle outlines" hint="A thin border around each candle, in the wick color.">
            <label className="chk"><input type="checkbox" checked={th.border} onChange={e => setTh({ border: e.target.checked })} />Outline the candles</label>
          </Row>
          <Row title="Chart background and grid" hint="Leave them to the theme, or pick your own.">
            <div className="swatches">
              {colorIn('Background', th.chartBg, C.bg, v => setTh({ chartBg: v }))}{colorIn('Grid', th.grid, C.grid, v => setTh({ grid: v }))}
              {(th.chartBg || th.grid) && <button className="linkbtn" onClick={() => setTh({ chartBg: '', grid: '' })}>Use the theme’s</button>}
            </div>
          </Row>
          <div><button className="btn sm" disabled={JSON.stringify({ ...th, mode: '', dark: '', light: '' }) === JSON.stringify({ ...THEME_DEF, mode: '', dark: '', light: '' })} onClick={() => { setOwn(false); setTh({ up: '', down: '', wickUp: '', wickDown: '', border: false, chartBg: '', grid: '' }); }}>Reset colors to the theme’s</button>
            <span className="muted" style={{ fontSize: 12, marginLeft: 12 }}>Now showing: {pal.name}</span></div>
        </Group>

        <Group id="sReplay" title="Replay and orders" lead="How the tape plays and how your orders are handled. These apply to new sessions, and to the open one where it is safe.">
          <Row title="Ticks per bar" hint="Each bar of data (one minute, say) is replayed as this many price steps, from 4 to 600. More ticks move the price more smoothly and fill orders more precisely, but play a little slower.">
            <span className="suffix" style={{ maxWidth: 200 }}><input className="in" inputMode="numeric" aria-label="Ticks per bar" defaultValue={ticksPref()}
              onBlur={e => { const n = Math.max(4, Math.min(600, parseInt(e.target.value) || 20)); e.target.value = String(n); replay('ticks', n); }}
              onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} /><span>ticks</span></span>
          </Row>
          <Row title="Pause when an order fills" hint="Stops the replay whenever an order fills or a stop loss or take profit is hit, so you never miss what happened.">
            <label className="chk"><input type="checkbox" checked={pref('pauseFill', false)} onChange={e => replay('pauseFill', e.target.checked)} />Pause the replay when an order fills</label>
          </Row>
          <Row title="Separate trades" hint={<>Normally a sell against a long position closes it (netting), as most futures brokers do. With this on, every order is its own trade, so you can hold a long and a short at once.{hedgeLater && <b className="warnline" style={{ display: 'block', marginTop: 4 }}>The open session keeps its way until nothing is open in it.</b>}</>}>
            <label className="chk"><input type="checkbox" checked={pref('hedge', false)} onChange={e => replay('hedge', e.target.checked)} />Keep each order as a separate trade (no netting)</label>
            <label className="chk"><input type="checkbox" checked={pref('oneTap', true)} onChange={e => { setPref('oneTap', e.target.checked); bump(); }} />Buy and sell buttons on each chart</label>
          </Row>
          <Row title="Order size" hint="How the order ticket sizes a trade when a session starts. By risk: the app works out the number of contracts so that a stop loss costs about what you chose. Fixed: always the same number of contracts.">
            <div className="duo">
              <span className="seg" role="group" aria-label="Size orders by">
                <button className={pref<string>('sizeBy', 'risk') === 'risk' ? 'on' : ''} onClick={() => put('sizeBy', 'risk')}>By risk</button>
                <button className={pref<string>('sizeBy', 'risk') === 'qty' ? 'on' : ''} onClick={() => put('sizeBy', 'qty')}>Fixed contracts</button>
              </span>
              <span className="suffix" style={{ maxWidth: 160 }}><input className="in" inputMode="numeric" aria-label="Contracts per order" value={pref('qty', 1)}
                onChange={e => { const n = Math.max(1, parseInt(e.target.value) || 1); put('qty', n); if (session) setTicket({ qty: n }); }} /><span>contracts</span></span>
            </div>
          </Row>
        </Group>

        <Group id="sKeys" title="Keyboard shortcuts" lead="Press ? anywhere in the app to see this list.">
          <KeysList />
          <div><button className="btn sm" onClick={onKeys}>Open as a sheet</button></div>
        </Group>

        <Group id="sAbout" title="About">
          <Row title="Tape Replay" hint={version || ' '}>
            <a className="btn sm" href={classicHref}>Open the classic view</a>
          </Row>
          <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>The classic view has everything not moved over yet: Python strategies, the optimizer and the robustness tests. Practice markets are generated, not real market data. Trades are simulated; nothing here is financial advice.</p>
          <Credit />
        </Group>
      </div>
    </div>
  );
}
