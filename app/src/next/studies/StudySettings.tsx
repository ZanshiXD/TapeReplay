// The chart studies in the Indicators popover: price zones and session lines, each with show/hide, its settings, and
// a way to take it off the charts. Settings are the classic app's.
import type { Session } from '../../core/session';
import { parseTF, tfValid, fmtHM, zoneAbbr } from '../../core/time';
import { ZONE_TFS, ZONE_TYPES, type ZonePrefs } from '../../core/zones';
import { CITY, SESS_STD, cityTimeFor, normHM, sessionAt, type SessDef } from '../../core/sessions-studies';
import { IClose } from '../icons';
import { setSess, setZones, studies } from './prefs';

export const STUDY_CATALOG = [
  { id: 'zones', name: 'Price zones (FVG, order blocks)', what: 'Fair value gaps, inverse FVGs, balanced price ranges, order blocks and breakers, from finished candles. Z shows or hides them.' },
  { id: 'sess', name: 'Session lines', what: 'A line at each Sydney, Tokyo, London and New York open, in each city’s own hours, with optional shading to the close.' },
] as const;
export type StudyId = typeof STUDY_CATALOG[number]['id'];
export const studyAdded = (id: StudyId) => id === 'zones' ? studies.zones.added : studies.sess.added;
export function addStudy(id: StudyId) { if (id === 'zones') setZones({ added: true, on: true }); else setSess({ added: true, on: true }); }

const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, padding: '7px 16px' };
const sub: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 10, padding: '4px 16px 12px 36px', fontSize: 12.5 };
const num = (v: string, lo: number, hi: number, def: number) => { const n = Math.round(+v); return isFinite(n) && v.trim() !== '' ? Math.max(lo, Math.min(hi, n)) : def; };

/** the studies on the charts, as rows like the indicators' */
export function StudyRows({ session, edit, setEdit }: { session: Session; edit: string | null; setEdit: (id: string | null) => void }) {
  const z = studies.zones, s = studies.sess;
  const head = (id: StudyId, name: string, color: string, on: boolean, flip: () => void, remove: () => void) => (
    <div style={{ ...row, opacity: on ? 1 : 0.5 }}>
      <span style={{ width: 10, height: 10, borderRadius: 3, background: color, flex: 'none' }} />
      <span style={{ flex: 1, fontWeight: 600 }}>{name}</span>
      <button className="ib txt" onClick={flip}>{on ? 'Hide' : 'Show'}</button>
      <button className="ib txt" aria-expanded={edit === id} onClick={() => setEdit(edit === id ? null : id)}>Edit</button>
      <button className="ib" title="Take it off the charts" aria-label={`Remove ${name}`} onClick={remove}><IClose width={13} height={13} /></button>
    </div>
  );
  return <>
    {z.added && <div>
      {head('zones', 'Price zones', z.fvg.up, z.on, () => setZones({ on: !z.on }), () => { setZones({ added: false, on: false }); if (edit === 'zones') setEdit(null); })}
      {edit === 'zones' && <ZoneForm session={session} z={z} />}
    </div>}
    {s.added && <div>
      {head('sess', 'Session lines', s.sessions.find(x => x.on)?.color || '#4c9be8', s.on, () => setSess({ on: !s.on }), () => { setSess({ added: false }); if (edit === 'sess') setEdit(null); })}
      {edit === 'sess' && <SessForm session={session} />}
    </div>}
  </>;
}

function ZoneForm({ session, z }: { session: Session; z: ZonePrefs }) {
  const base = Math.min(...session.feeds.map(f => f.s.base));
  const tfs = ZONE_TFS.filter(t => t === 'chart' || tfValid(parseTF(t)!, base));
  return (
    <div style={sub}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <label className="field">Find zones on<select className="in ui sel" style={{ width: '100%' }} aria-label="Timeframe for price zones" value={z.tf} onChange={e => setZones({ tf: e.target.value })}>
          {tfs.map(t => <option key={t} value={t}>{t === 'chart' ? 'Chart timeframe' : t}</option>)}</select></label>
        <label className="field">Newest of each kind<input key={'m' + z.max} className="in sm" style={{ width: '100%' }} inputMode="numeric" aria-label="Newest of each kind" defaultValue={z.max} onBlur={e => setZones({ max: num(e.target.value, 1, 50, z.max) })} /></label>
        <label className="field" title="Candles on each side that make a swing high or low">OB swing length<input key={'s' + z.swing} className="in sm" style={{ width: '100%' }} inputMode="numeric" aria-label="OB swing length" defaultValue={z.swing} onBlur={e => setZones({ swing: num(e.target.value, 1, 20, z.swing) })} /></label>
        <label className="field">Smallest FVG (ticks)<input key={'t' + z.minTicks} className="in sm" style={{ width: '100%' }} inputMode="numeric" aria-label="Smallest FVG in ticks" defaultValue={z.minTicks} onBlur={e => setZones({ minTicks: num(e.target.value, 0, 1000, z.minTicks) })} /></label>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: '6px 10px', alignItems: 'center' }}>
        <span className="muted">Zone</span><span className="muted">Bullish</span><span className="muted">Bearish</span>
        {ZONE_TYPES.map(([k, name, short]) => [
          <label key={k} className="chk"><input type="checkbox" checked={z[k].on} onChange={e => setZones({ [k]: { ...z[k], on: e.target.checked } })} />{name} ({short})</label>,
          <input key={k + 'u'} type="color" value={z[k].up} aria-label={`${name} bullish color`} onChange={e => setZones({ [k]: { ...z[k], up: e.target.value } })} />,
          <input key={k + 'd'} type="color" value={z[k].dn} aria-label={`${name} bearish color`} onChange={e => setZones({ [k]: { ...z[k], dn: e.target.value } })} />,
        ])}
      </div>
      <label className="chk"><input type="checkbox" checked={z.hideDone} onChange={e => setZones({ hideDone: e.target.checked })} />Hide zones once filled or broken</label>
      <label className="chk"><input type="checkbox" checked={z.labels} onChange={e => setZones({ labels: e.target.checked })} />Label zones</label>
      <p className="muted" style={{ margin: 0, fontSize: 12 }}>Zones come only from finished candles of the timeframe chosen here. FVG: the gap between candles one and three. iFVG: an FVG a candle closed through, now facing the other way. BPR: a new FVG overlapping an opposite one still open. OB: after a close beyond the last swing, the candle with the extreme low (or high) since that swing. BB: an order block a candle closed through.</p>
    </div>
  );
}

function SessForm({ session }: { session: Session }) {
  const sp = studies.sess, ref = session.now, zn = zoneAbbr(ref);
  const upd = (i: number, p: Partial<SessDef>) => setSess({ sessions: sp.sessions.map((x, j) => j === i ? { ...x, ...p } : x) });
  // open and close are typed in the chart time zone and kept in the city's own clock
  const setTime = (i: number, k: 'open' | 'close', v: string) => { const hm = normHM(v); if (hm) upd(i, { [k]: cityTimeFor(sp.sessions[i], k, hm, ref) }); else setSess({}); };
  return (
    <div style={sub}>
      <select className="in ui sel" aria-label="Standard session hours" value="" onChange={e => { const std = SESS_STD[e.target.value]; if (std) setSess({ sessions: sp.sessions.map(x => std.hours[x.name] ? { ...x, open: std.hours[x.name][0], close: std.hours[x.name][1] } : x) }); }}>
        <option value="">Set standard hours…</option>{Object.entries(SESS_STD).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
      </select>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 64px 64px auto', gap: '6px 8px', alignItems: 'center' }}>
        <span className="muted">Session</span><span className="muted">Opens ({zn})</span><span className="muted">Closes ({zn})</span><span className="muted">Color</span>
        {sp.sessions.map((s, i) => {
          const occ = s.open ? sessionAt(s, ref - 86400) : null, o = occ ? fmtHM(occ[0]) : '', c = occ && s.close ? fmtHM(occ[1]) : '';
          const city = CITY[s.tz] || s.tz.split('/').pop()!.replace(/_/g, ' ');
          const time = (k: 'open' | 'close', v: string) => <input key={k + i + v} className="in sm" style={{ width: '100%', padding: '0 6px' }} defaultValue={v} maxLength={5} inputMode="numeric" aria-label={`${s.name} ${k === 'open' ? 'opens' : 'closes'}, 24-hour, chart time zone`}
            onBlur={e => { if (e.target.value !== v) setTime(i, k, e.target.value); }} onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />;
          return [
            <label key={'n' + i} className="chk" title={`${s.open || '--:--'}–${s.close || '--:--'} ${city} time`}><input type="checkbox" checked={s.on} onChange={e => upd(i, { on: e.target.checked })} />{s.name}</label>,
            time('open', o), time('close', c),
            <input key={'c' + i} type="color" value={s.color} aria-label={`${s.name} color`} onChange={e => upd(i, { color: e.target.value })} />,
          ];
        })}
      </div>
      <label className="chk"><input type="checkbox" checked={sp.shade} onChange={e => setSess({ shade: e.target.checked })} />Shade each session from open to close</label>
      <label className="chk"><input type="checkbox" checked={sp.labels} onChange={e => setSess({ labels: e.target.checked })} />Name the lines</label>
      <p className="muted" style={{ margin: 0, fontSize: 12 }}>Times are in the chart time zone for the trading day of the replay. Each session keeps its own city’s hours, so they move when either place changes its clocks. Lines show on timeframes below one day and are skipped on weekends.</p>
    </div>
  );
}
