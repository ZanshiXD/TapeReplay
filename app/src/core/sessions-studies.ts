// Session opens (Sydney, Tokyo, London, New York). Each session
// keeps its own city's hours, so it follows that city's daylight saving; screens show them in the chart time zone.
import { localToUtc, tzOffset, zoneToUtc, zp, p2 } from './time';

export interface SessDef { name: string; tz: string; color: string; on: boolean; open: string; close: string }
export interface SessPrefs {
  /** listed under "On the charts" in Indicators */
  added: boolean;
  /** shown */
  on: boolean;
  sessions: SessDef[];
  /** shade each session from open to close */
  shade: boolean;
  /** name the lines */
  labels: boolean;
}

export const SESS_STD: Record<string, { label: string; hours: Record<string, [string, string]> }> = {
  exchange: { label: 'Stock exchange hours (ASX, Tokyo, LSE, NYSE)', hours: { Sydney: ['10:00', '16:00'], Tokyo: ['09:00', '15:30'], London: ['08:00', '16:30'], 'New York': ['09:30', '16:00'] } },
  forex: { label: 'Forex session hours', hours: { Sydney: ['07:00', '16:00'], Tokyo: ['09:00', '18:00'], London: ['08:00', '17:00'], 'New York': ['08:00', '17:00'] } },
};
export const SESS_DEF: SessDef[] = [
  { name: 'Sydney', tz: 'Australia/Sydney', color: '#9b7bd4', on: true },
  { name: 'Tokyo', tz: 'Asia/Tokyo', color: '#e0a43a', on: true },
  { name: 'London', tz: 'Europe/London', color: '#4c9be8', on: true },
  { name: 'New York', tz: 'America/New_York', color: '#2db38a', on: true },
].map(s => ({ ...s, open: SESS_STD.exchange.hours[s.name][0], close: SESS_STD.exchange.hours[s.name][1] }));
export const CITY: Record<string, string> = { 'Australia/Sydney': 'Sydney', 'Asia/Tokyo': 'Tokyo', 'Europe/London': 'London', 'America/New_York': 'New York' };

/** settings with the defaults filled in */
export function sessPrefs(p: Partial<SessPrefs> = {}): SessPrefs {
  return { added: p.added ?? false, on: p.on ?? true, sessions: Array.isArray(p.sessions) && p.sessions.length ? p.sessions.map(s => ({ ...s })) : SESS_DEF.map(s => ({ ...s })), shade: p.shade ?? false, labels: p.labels ?? true };
}

/** "8:30", "0830", "08:30" -> "08:30"; '' when it is not a time */
export function normHM(s: string): string { const m = String(s || '').trim().match(/^(\d{1,2}):?(\d{2})$/); return m && +m[1] < 24 && +m[2] < 60 ? `${p2(+m[1])}:${m[2]}` : ''; }
/** the city's clock time at UTC time t */
export const cityHM = (tz: string, t: number) => { const d = new Date((t + tzOffset(tz, t)) * 1000); return `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`; };

const cache = new Map<string, [number, number]>();
/** a session's open and close (UTC) on calendar day `day` (days since 1970) of its city */
export function sessionOn(s: SessDef, day: number): [number, number] {
  const key = s.tz + '|' + day + '|' + s.open + '|' + s.close;
  let v = cache.get(key);
  if (!v) {
    const dt = new Date(day * 86400000), [oh, om] = s.open.split(':').map(Number);
    const o = localToUtc(s.tz, dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate(), oh, om);
    let c = o;
    if (s.close) { const [ch, cm] = s.close.split(':').map(Number); c = localToUtc(s.tz, dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate(), ch, cm); if (c <= o) c += 86400; }
    v = [o, c]; if (cache.size > 4000) cache.clear(); cache.set(key, v);
  }
  return v;
}
const weekend = (day: number) => { const wd = new Date(day * 86400000).getUTCDay(); return wd === 0 || wd === 6; };

export interface SessRange { s: SessDef; o: number; c: number }
/** the sessions that are on and touch [t0, t1], in time order of the days; none on the city's Saturday or Sunday */
export function sessionRanges(list: SessDef[], t0: number, t1: number): SessRange[] {
  const out: SessRange[] = [], on = list.filter(s => s.on && s.open);
  if (!on.length || !(t1 >= t0)) return out;
  for (let day = Math.floor(t0 / 86400) - 1; day <= Math.floor(t1 / 86400) + 1; day++) {
    if (weekend(day)) continue;
    for (const s of on) { const [o, c] = sessionOn(s, day); if (c < t0 || o > t1) continue; out.push({ s, o, c }); }
  }
  return out;
}
/** session lines show below daily candles, and not when more than 90 days are in view (too zoomed out to read) */
export const sessionsVisible = (tfSec: number, t0: number, t1: number) => tfSec < 86400 && t1 - t0 <= 86400 * 90;

/** the next time a session opens after t */
export function nextOpen(s: SessDef, t: number): number {
  for (let i = -1; i < 10; i++) { const day = Math.floor(t / 86400) + i; if (weekend(day)) continue; const o = sessionOn(s, day)[0]; if (o > t) return o; }
  return NaN;
}
/** one session (open and close, in UTC) on the city's trading day at or after t */
export function sessionAt(s: SessDef, t: number): [number, number] | null {
  const o = nextOpen(s, t); if (!isFinite(o)) return null;
  return sessionOn(s, Math.floor((o + tzOffset(s.tz, o)) / 86400));
}
/** a time typed in the chart zone ("HH:MM"), on the session's trading day around `ref`, as that city's own clock time */
export function cityTimeFor(s: SessDef, k: 'open' | 'close', hm: string, ref: number): string {
  const occ = s.open ? sessionAt(s, ref - 86400) : null;
  const p = zp(occ ? (k === 'open' ? occ[0] : occ[1]) : ref);
  return cityHM(s.tz, zoneToUtc(p.y, p.mo, p.d, +hm.slice(0, 2), +hm.slice(3)));
}
