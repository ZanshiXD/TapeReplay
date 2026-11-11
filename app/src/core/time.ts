// Time: bars are stored in UTC seconds; what people see (the chart axis, the clock, day and week candles) follows the
// chart time zone.

const tzFmt: Record<string, Intl.DateTimeFormat> = {};
/** seconds east of UTC in time zone `tz` at UTC time `utc` */
export function tzOffset(tz: string, utc: number): number {
  const f = tzFmt[tz] || (tzFmt[tz] = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }));
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(new Date(utc * 1000))) p[x.type] = x.value;
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) / 1000 - utc;
}
/** a wall-clock time in `tz` to UTC seconds */
export function localToUtc(tz: string, y: number, m: number, d: number, hh: number, mm: number): number {
  const wall = Date.UTC(y, m, d, hh, mm) / 1000;
  const t = wall - tzOffset(tz, wall);
  return wall - tzOffset(tz, t);
}
const nyCache = new Map<number, number>();
/** New York's offset: trading days (and prop days) start at 6 PM New York */
export function nyOff(t: number): number {
  const h = Math.floor(t / 3600);
  let v = nyCache.get(h);
  if (v === undefined) { v = tzOffset('America/New_York', h * 3600); nyCache.set(h, v); }
  return v;
}
/** the futures trading day a time belongs to (days start at zone.dayStart, 18:00 New York unless set otherwise) */
export const tradingDay = (t: number, resetHour = zone.dayStart) => Math.floor((t + nyOff(t) - resetHour * 3600) / 86400);
/** the date a trading day is named by (days since 1970): one that starts in the evening is the next day's */
export const tradingDate = (t: number) => tradingDay(t) + (zone.dayStart >= 12 ? 1 : 0);

export const LOCAL_TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } })();
/** the chart time zone (switchable at run time with setZone), and the hour in New York a trading day starts */
export const zone = { id: 'America/New_York', tz: 'America/New_York', fixed: null as number | null, dayStart: 18 };
const zoneCache = new Map<number, number>();
export function setZone(id: string) {
  zone.id = id || 'local'; zone.fixed = null;
  if (zone.id === 'local') zone.tz = LOCAL_TZ;
  else if (/^UTC[+-]\d/.test(zone.id)) { zone.tz = 'UTC'; zone.fixed = Math.round(parseFloat(zone.id.slice(3)) * 3600); }
  else zone.tz = zone.id;
  zoneCache.clear();
}
export function setDayStart(h: number) { zone.dayStart = Math.max(0, Math.min(23, Math.round(h) || 0)); }
/** seconds east of UTC in the chart zone at UTC time t */
export function zoneOff(t: number): number {
  if (zone.fixed != null) return zone.fixed;
  if (zone.tz === 'UTC') return 0;
  const k = Math.floor(t / 3600);
  let v = zoneCache.get(k);
  if (v === undefined) { if (zoneCache.size > 50000) zoneCache.clear(); v = tzOffset(zone.tz, k * 3600); zoneCache.set(k, v); }
  return v;
}
export interface Parts { y: number; mo: number; d: number; h: number; mi: number; s: number; wd: number }
export function zp(t: number): Parts {
  const d = new Date((t + zoneOff(t)) * 1000);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth(), d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds(), wd: d.getUTCDay() };
}
export function zoneToUtc(y: number, mo: number, d: number, h = 0, mi = 0): number {
  const wall = Date.UTC(y, mo, d, h, mi) / 1000; const t = wall - zoneOff(wall); return wall - zoneOff(t);
}
export const p2 = (n: number) => String(n).padStart(2, '0');
export const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const WDN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export function zoneAbbr(t: number): string {
  if (zone.fixed != null || zone.tz === 'UTC') return 'UTC';
  try {
    const n = new Intl.DateTimeFormat('en-US', { timeZone: zone.tz, timeZoneName: 'short' }).formatToParts(new Date(t * 1000)).find(x => x.type === 'timeZoneName')!.value;
    return n;
  } catch { return ''; }
}
export function fmtClock(t: number, secs = true): string {
  if (!isFinite(t)) return '—';
  const p = zp(t);
  return `${WDN[p.wd]} ${p.d} ${MON[p.mo]} ${p.y} · ${p2(p.h)}:${p2(p.mi)}${secs ? ':' + p2(p.s) : ''}`;
}
export function fmtHM(t: number): string { const p = zp(t); return `${p2(p.h)}:${p2(p.mi)}`; }
export function fmtShortDay(t: number): string { const p = zp(t); return `${WDN[p.wd]} ${p.d} ${MON[p.mo]}`; }
/** chart axis: a date where the chart zone's day starts, otherwise the time */
export function tickLabel(t: number): string {
  const p = zp(t);
  if (p.h === 0 && p.mi === 0 && p.s === 0) return p.d === 1 ? (p.mo === 0 ? String(p.y) : `${MON[p.mo]} ${p.y}`) : `${p.d} ${MON[p.mo]}`;
  return p.s ? `${p2(p.h)}:${p2(p.mi)}:${p2(p.s)}` : `${p2(p.h)}:${p2(p.mi)}`;
}
export function crossLabel(t: number): string { const p = zp(t); return `${WDN[p.wd]} ${p.d} ${MON[p.mo]} '${String(p.y).slice(2)}  ${p2(p.h)}:${p2(p.mi)}${p.s ? ':' + p2(p.s) : ''}`; }
export function spanText(s: number): string {
  if (s < 90) return `${Math.round(s)} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  if (s < 172800) return `${(s / 3600).toFixed(s < 36000 ? 1 : 0)} h`;
  return `${Math.round(s / 86400)} days`;
}

/* ---------------- timeframes ---------------- */
export type TF = { kind: 's'; sec: number } | { kind: 'W'; n: number } | { kind: 'M'; n: number };
export function tfLabel(tf: TF): string {
  if (tf.kind === 'W') return tf.n + 'W';
  if (tf.kind === 'M') return tf.n + 'M';
  const s = tf.sec;
  if (s % 86400 === 0) return s / 86400 + 'D';
  if (s % 3600 === 0) return s / 3600 + 'h';
  if (s % 60 === 0) return s / 60 + 'm';
  return s + 's';
}
export function parseTF(str: string): TF | null {
  const m = String(str).trim().match(/^(\d+)\s*(s|sec|m|min|h|hr|H|d|D|w|W|M|mo|mon)$/);
  if (!m) return null;
  const n = +m[1]; if (!n) return null;
  const u = m[2];
  if (u === 'M' || u === 'mo' || u === 'mon') return { kind: 'M', n };
  if (u === 'w' || u === 'W') return { kind: 'W', n };
  const mult = ({ s: 1, sec: 1, m: 60, min: 60, h: 3600, hr: 3600, H: 3600, d: 86400, D: 86400 } as Record<string, number>)[u];
  return { kind: 's', sec: n * mult };
}
export const tfValid = (tf: TF, base: number) => tf.kind === 's' ? (tf.sec >= base && tf.sec % base === 0) : (base <= 86400 && 86400 % base === 0);
export const tfSeconds = (tf: TF) => tf.kind === 's' ? tf.sec : tf.kind === 'W' ? 604800 * tf.n : 2592000 * tf.n;
/** candle start times; candles longer than an hour follow the chart zone's clock. Days, weeks and months follow the
 *  trading day (Sunday 6 PM New York is Monday's), each candle at its date's midnight in the chart zone. */
export function makeBucket(tf: TF): (t: number) => number {
  if (tf.kind === 's' && tf.sec % 86400) {
    const s = tf.sec;
    if (s <= 3600) return t => Math.floor(t / s) * s;
    return t => { const off = zoneOff(t); return Math.floor((t + off) / s) * s - off; };
  }
  // the first day of the candle a trading date belongs to (days since 1970; day 4 was a Monday)
  const first: (k: number) => number = tf.kind === 's' ? (n => k => Math.floor(k / n) * n)(tf.sec / 86400)
    : tf.kind === 'W' ? (n => k => Math.floor((k - 4) / n) * n + 4)(7 * tf.n)
    : (n => k => { const d = new Date(k * 86400000), mm = Math.floor((d.getUTCFullYear() * 12 + d.getUTCMonth()) / n) * n; return Date.UTC(Math.floor(mm / 12), mm % 12, 1) / 86400000; })(tf.n);
  let lastK = NaN, val = 0;
  return t => {
    const k = tradingDate(t);
    if (k === lastK) return val;
    const d = new Date(first(k) * 86400000);
    lastK = k; val = zoneToUtc(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    return val;
  };
}
export function lowerBound(arr: ArrayLike<number>, x: number): number {
  let a = 0, b = arr.length;
  while (a < b) { const m = (a + b) >> 1; if (arr[m] < x) a = m + 1; else b = m; }
  return a;
}
