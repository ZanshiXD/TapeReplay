// The replay controls: back, play, forward, a timeline to drag, the speed, and Jump to.
import { useRef, useState } from 'react';
import type { Session } from '../core/session';
import { fmtClock, localToUtc, zoneAbbr, nyOff, spanText } from '../core/time';
import { useLive, setPref } from './live';
import { IBack, IChev, IFwd, IPause, IPlay } from './icons';

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
  const [ghost, setGhost] = useState<number | null>(null);
  const track = useRef<HTMLDivElement>(null);
  const s = session, now = s.now, p = s.progress;
  const timeAt = (x: number) => s.startTime + x * (s.endTime - s.startTime);
  const frac = (e: React.PointerEvent) => { const r = track.current!.getBoundingClientRect(); return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)); };
  const jumps: Array<[string, number]> = [
    ['5 minutes', now + 300], ['15 minutes', now + 900], ['1 hour', now + 3600],
    ['New York open (9:30)', nextLocal('America/New_York', now, 9, 30)], ['London open (8:00)', nextLocal('Europe/London', now, 8, 0)],
    ['Next trading day (6 PM)', nextLocal('America/New_York', now, 18, 0)],
  ];
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
        <div className="track" ref={track} title="Drag to jump forward or back"
          onPointerDown={e => { (e.target as HTMLElement).setPointerCapture(e.pointerId); setGhost(frac(e)); s.pause(); }}
          onPointerMove={e => { if (ghost != null) setGhost(frac(e)); }}
          onPointerUp={e => { if (ghost == null) return; const t = timeAt(frac(e)); setGhost(null); if (Math.abs(t - now) > 1) onJump(t); }}>
          <div className="fill" style={{ width: `${p * 100}%` }} />
          {ghost != null && <div className="ghost" style={{ left: `${ghost * 100}%` }} />}
          <div className="knob" style={{ left: `${p * 100}%` }} />
        </div>
      </div>
      <div className="sep" />
      <div className="chips" role="group" aria-label="Speed">
        {SPEEDS.map(([v, l]) => <button key={v} className={s.speed === v ? 'on' : ''} title={`${l}: ${v === 1 ? 'real time' : `${v} seconds of market per second`}`} onClick={() => { s.speed = v; setPref('speed', v); s.changed(); }}>{l}</button>)}
      </div>
      <div style={{ position: 'relative' }}>
        <button className="ib txt" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>Jump to <IChev /></button>
        {menu && (
          <div className="pop menu" role="menu" style={{ bottom: 44, right: 0 }} onMouseLeave={() => setMenu(false)}>
            <h5>Jump ahead</h5>
            {jumps.map(([l, t]) => <button key={l} role="menuitem" onClick={() => { setMenu(false); onJump(t); }}>{l}<span>{fmtClock(t, false).slice(4)}</span></button>)}
          </div>
        )}
      </div>
    </div>
  );
}
