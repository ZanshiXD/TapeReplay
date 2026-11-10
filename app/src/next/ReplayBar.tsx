// The replay controls: back, play, forward, a timeline to drag, the speed, and Jump to.
import { useRef, useState } from 'react';
import type { Session } from '../core/session';
import { fmtClock, fmtShortDay, localToUtc, zoneAbbr, nyOff, spanText } from '../core/time';
import { useLive, setPref } from './live';
import { IBack, IChev, IFwd, IPause, IPlay } from './icons';
import { usePhone } from './phone';

const SPEEDS: Array<[number, string]> = [[1, '1×'], [10, '10×'], [60, '60×'], [300, '300×'], [1000, '1000×']];

/** the next time a city's clock reads hh:mm (on a weekday), after t */
function nextLocal(tz: string, t: number, hh: number, mm: number) {
  for (let d = 0; d < 8; d++) {
    const x = new Date((t + nyOff(t)) * 1000 + d * 86400000);
    const u = localToUtc(tz, x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate(), hh, mm);
    const wd = new Date(u * 1000).getUTCDay();
    if (u > t + 30 && wd !== 6 && !(wd === 0 && hh < 18)) return u;
  }
  return t + 86400;
}

export function ReplayBar({ session, onJump }: { session: Session; onJump: (t: number) => void }) {
  useLive();
  const [menu, setMenu] = useState(false);
  const [pickT, setPickT] = useState('');
  const [custom, setCustom] = useState(false);
  const [ghost, setGhost] = useState<number | null>(null);
  const track = useRef<HTMLDivElement>(null);
  const s = session, now = s.now, p = s.progress;
  const timeAt = (x: number) => s.startTime + x * (s.endTime - s.startTime);
  const frac = (e: React.PointerEvent) => { const r = track.current!.getBoundingClientRect(); return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)); };
  const jumps: Array<[string, number]> = [
    ['5 minutes', now + 300], ['15 minutes', now + 900], ['1 hour', now + 3600], ['4 hours', now + 4 * 3600],
    ['New York open (9:30)', nextLocal('America/New_York', now, 9, 30)], ['London open (8:00)', nextLocal('Europe/London', now, 8, 0)],
    ['Next trading day (6 PM)', nextLocal('America/New_York', now, 18, 0)], ['1 week', now + 7 * 86400],
  ];
  const isPreset = SPEEDS.some(([v]) => v === s.speed);
  const setSpeed = (v: number) => { s.speed = v; setPref('speed', v); s.changed(); };
  // the custom speed: a slider on a log scale, 1× to an hour a second
  const toSlider = (v: number) => Math.round(Math.log(v) / Math.log(3600) * 1000), fromSlider = (x: number) => Math.max(1, Math.round(Math.exp(x / 1000 * Math.log(3600))));
  const phone = usePhone();
  const trackEl = (
    <div className="track" ref={track} title="Drag to jump forward or back"
      onPointerDown={e => { (e.target as HTMLElement).setPointerCapture(e.pointerId); setGhost(frac(e)); s.pause(); }}
      onPointerMove={e => { if (ghost != null) setGhost(frac(e)); }}
      onPointerUp={e => { if (ghost == null) return; const t = timeAt(frac(e)); setGhost(null); if (Math.abs(t - now) > 1) onJump(t); }}>
      <div className="fill" style={{ width: `${p * 100}%` }} />
      {ghost != null && <div className="ghost" style={{ left: `${ghost * 100}%` }} />}
      <div className="knob" style={{ left: `${p * 100}%` }} />
    </div>
  );
  const speedPop = (style: React.CSSProperties) => (
    <div className="pop speedpop" style={{ ...style, minWidth: 260, padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }} onMouseLeave={() => setCustom(false)}>
      {phone && <div className="chips" role="group" aria-label="Speed presets">{SPEEDS.map(([v, l]) => <button key={v} className={s.speed === v ? 'on' : ''} onClick={() => { setSpeed(v); setCustom(false); }}>{l}</button>)}</div>}
      <span className="row" style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5 }}><span className="muted">Speed</span><b className="num">{s.speed}× · {s.speed < 60 ? `${s.speed} s` : spanText(s.speed)} a second</b></span>
      <input type="range" min={0} max={1000} value={toSlider(s.speed)} aria-label="Speed" onChange={e => setSpeed(fromSlider(+e.target.value))} style={{ accentColor: 'var(--accent)' }} />
    </div>
  );
  const jumpMenu = (style: React.CSSProperties) => (
    <div className="pop menu" role="menu" style={style} onMouseLeave={() => setMenu(false)}>
      <h5>Jump ahead</h5>
      {jumps.map(([l, t]) => <button key={l} role="menuitem" onClick={() => { setMenu(false); onJump(t); }}>{l}<span>{fmtClock(t, false).slice(4)}</span></button>)}
      <h5>Go to</h5>
      <div style={{ display: 'flex', gap: 6, padding: '2px 8px 6px' }}>
        <input className="in" type="datetime-local" style={{ height: phone ? 40 : 32, fontSize: phone ? 16 : 12.5, flex: 1, minWidth: 0 }} aria-label="Date and time to go to" value={pickT} onChange={e => setPickT(e.target.value)} />
        <button className="btn sm primary" disabled={!pickT} onClick={() => { const [d, hm] = pickT.split('T'), [y, mo, da] = d.split('-').map(Number), [h, mi] = hm.split(':').map(Number); setMenu(false); onJump(localToUtc('America/New_York', y, mo - 1, da, h, mi)); }}>Go</button>
      </div>
      <button role="menuitem" onClick={() => { setMenu(false); onJump(s.startTime); }}>Back to the start<span>{fmtClock(s.startTime, false).slice(4)}</span></button>
    </div>
  );
  if (phone) return (
    // phones: docked under the chart, one row, with a thin timeline along its top; the speed and the jumps open as sheets
    <div className="rbar mrbar" role="toolbar" aria-label="Replay">
      {trackEl}
      <div className="mrow">
        <button className="ib" aria-label="Back one candle" disabled={!s.canStepBack} onClick={() => s.stepBack()}><IBack /></button>
        <button className="play" aria-label={s.playing ? 'Pause' : 'Play'} onClick={() => s.toggle()}>{s.playing ? <IPause /> : <IPlay />}</button>
        <button className="ib" aria-label="Forward one candle" onClick={() => s.stepCandle()}><IFwd /></button>
        <div className="mclock">
          <span className="num">{fmtClock(ghost != null ? timeAt(ghost) : now).split(' · ')[1]} <i>{zoneAbbr(now)}</i></span>
          <span className="muted">{ghost != null ? (timeAt(ghost) < now ? 'release to go back' : 'release to jump ahead') : `${fmtShortDay(ghost != null ? timeAt(ghost) : now)} · ${spanText(Math.max(0, s.endTime - now))} left`}</span>
        </div>
        <button className="mbtn num" aria-label="Speed" aria-expanded={custom} onClick={() => { setMenu(false); setCustom(!custom); }}>{s.speed}×</button>
        <button className="mbtn" aria-haspopup="menu" aria-expanded={menu} onClick={() => { setCustom(false); setMenu(!menu); }}>Jump <IChev /></button>
      </div>
      {custom && speedPop({})}
      {menu && jumpMenu({})}
    </div>
  );
  return (
    <div className="rbar" role="toolbar" aria-label="Replay">
      <button className="ib" title="Back one candle (←)" aria-label="Back one candle" disabled={!s.canStepBack} onClick={() => s.stepBack()}><IBack /></button>
      <button className="play" aria-label={s.playing ? 'Pause' : 'Play'} title={s.playing ? 'Pause (Space)' : 'Play (Space)'} onClick={() => s.toggle()}>{s.playing ? <IPause /> : <IPlay />}</button>
      <button className="ib" title="Forward one candle (→)" aria-label="Forward one candle" onClick={() => s.stepCandle()}><IFwd /></button>
      <div className="sep" />
      <div className="tl">
        <div className="lbl">
          <span className="num" style={{ fontWeight: 500 }}>{fmtClock(ghost != null ? timeAt(ghost) : now)} <span className="muted">{zoneAbbr(now)}</span></span>
          <span className="muted">{ghost != null ? (timeAt(ghost) < now ? 'release to go back' : 'release to jump ahead') : `${spanText(Math.max(0, s.endTime - now))} left`}</span>
        </div>
        {trackEl}
      </div>
      <div className="sep" />
      <div className="chips" role="group" aria-label="Speed">
        {SPEEDS.map(([v, l]) => <button key={v} className={s.speed === v ? 'on' : ''} title={`${l}: ${v === 1 ? 'real time' : `${v} seconds of market per second`}`} onClick={() => setSpeed(v)}>{l}</button>)}
        <button className={!isPreset ? 'on' : ''} title="Any speed (↑ and ↓ change it too)" aria-label="Custom speed" onClick={() => setCustom(!custom)}>{isPreset ? '…' : `${s.speed}×`}</button>
      </div>
      {custom && speedPop({ bottom: 64, right: 120 })}
      <div style={{ position: 'relative' }}>
        <button className="ib txt" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>Jump to <IChev /></button>
        {menu && jumpMenu({ bottom: 44, right: 0 })}
      </div>
    </div>
  );
}
