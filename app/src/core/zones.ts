// Price zones (ICT). They come
// from finished candles of the chosen timeframe only, so nothing is taken from a candle that has not closed.
//  FVG   three candles where the first and third do not overlap: the gap between them.
//  iFVG  an FVG that a candle closed through: the same zone flips direction (support becomes resistance).
//  BPR   where a new FVG overlaps an opposite FVG that was still open.
//  OB    after a close beyond the last swing high (low), the candle with the lowest low (highest high) since that swing.
//  BB    an order block that a candle closed through: the same zone flips direction.
// Flipped zones keep drawing from where the FVG or order block formed, with a dashed mark where they flipped.
// Zones run right until filled (FVG) or closed through (the rest).
import { makeBucket, tfLabel, type TF } from './time';

export type ZoneType = 'fvg' | 'ifvg' | 'bpr' | 'ob' | 'bb';
/** kind, name, short name, bullish color, bearish color */
export const ZONE_TYPES: Array<[ZoneType, string, string, string, string]> = [
  ['fvg', 'Fair value gap', 'FVG', '#2db38a', '#e5554c'],
  ['ifvg', 'Inverse FVG', 'iFVG', '#26c6da', '#ff8a50'],
  ['bpr', 'Balanced price range', 'BPR', '#e2a63c', '#e2a63c'],
  ['ob', 'Order block', 'OB', '#4c9be8', '#c158dc'],
  ['bb', 'Breaker block', 'BB', '#8c9eff', '#f48fb1'],
];
export const ZONE_NAME = Object.fromEntries(ZONE_TYPES.map(z => [z[0], z[2]])) as Record<ZoneType, string>;
export const ZONE_TFS = ['chart', '1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '1D', '1W'];

export interface ZoneStyle { on: boolean; up: string; dn: string }
export interface ZonePrefs extends Record<ZoneType, ZoneStyle> {
  /** listed under "On the charts" in Indicators */
  added: boolean;
  /** shown (the Z key) */
  on: boolean;
  /** 'chart' or a timeframe such as '15m' */
  tf: string;
  /** the newest few of each kind */
  max: number;
  /** candles on each side that make a swing high or low */
  swing: number;
  /** the smallest FVG, in ticks */
  minTicks: number;
  hideDone: boolean;
  labels: boolean;
}
const clampI = (v: unknown, lo: number, hi: number, def: number) => { const n = Math.round(Number(v)); return isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def; };
/** settings with the defaults filled in */
export function zonePrefs(z: Partial<ZonePrefs> = {}): ZonePrefs {
  const out = {
    added: z.added ?? false, on: z.on ?? false, tf: z.tf || 'chart', hideDone: z.hideDone ?? true, labels: z.labels ?? true,
    max: z.max ? clampI(z.max, 1, 50, 8) : 8, swing: z.swing ? clampI(z.swing, 1, 20, 3) : 3, minTicks: z.minTicks == null ? 0 : clampI(z.minTicks, 0, 1000, 0),
  } as ZonePrefs;
  for (const [k, , , up, dn] of ZONE_TYPES) out[k] = { on: true, up, dn, ...(z[k] || {}) };
  return out;
}

export interface Bar { time: number; h: number; l: number; c: number }
export interface Zone { type: ZoneType; dir: number; top: number; bot: number; t0: number; t1: number | null; flipT?: number }

/** the zones found so far, one finished candle at a time */
export class ZoneFinder {
  zones: Zone[] = [];
  swH: { p: number; i: number } | null = null;
  swL: { p: number; i: number } | null = null;
  /** candles seen */
  n = 0;
  /** bumps when the zones change */
  version = 0;
  /** swing: candles each side of a swing; minMove: an FVG must be wider than this (price) */
  constructor(readonly swing = 3, readonly minMove = 0) {}
  private add(type: ZoneType, dir: number, top: number, bot: number, t0: number) { this.zones.push({ type, dir, top, bot, t0, t1: null }); }
  /** one more finished candle: existing zones react to it, then new ones form */
  step(cs: Bar[], k: number) {
    const c = cs[k], live = this.zones.filter(q => q.t1 == null);
    // a close through an FVG or order block flips that same zone (still drawn from where it formed)
    // into an iFVG or breaker facing the other way; flipT marks where it turned
    for (const q of live) {
      const through = q.dir > 0 ? c.c < q.bot : c.c > q.top;
      if ((q.type === 'fvg' || q.type === 'ob') && through) Object.assign(q, { type: q.type === 'fvg' ? 'ifvg' : 'bb', dir: -q.dir, flipT: c.time });
      else if (q.type === 'fvg') { if (q.dir > 0 ? c.l <= q.bot : c.h >= q.top) q.t1 = c.time; } // filled
      else if (q.type !== 'ob' && through && q.flipT !== c.time) q.t1 = c.time; // iFVG, breaker and BPR end on a close through
    }
    if (k >= 2) {
      const a = cs[k - 2], min = this.minMove + 1e-9;
      let dir = 0, top = 0, bot = 0;
      if (c.l - a.h > min) { dir = 1; top = c.l; bot = a.h; } else if (a.l - c.h > min) { dir = -1; top = a.l; bot = c.h; }
      if (dir) {
        const t0 = cs[k - 1].time;
        // an opposite gap still open before this candle: their overlap is a balanced price range
        for (let i = this.zones.length - 1; i >= 0; i--) {
          const q = this.zones[i];
          const open = (q.type === 'fvg' && q.dir === -dir && (q.t1 == null || q.t1 === c.time)) || (q.type === 'ifvg' && q.flipT === c.time && q.dir === dir);
          if (!open) continue;
          const hi = Math.min(q.top, top), lo = Math.max(q.bot, bot);
          if (hi > lo) { this.add('bpr', dir, hi, lo, t0); break; }
        }
        this.add('fvg', dir, top, bot, t0);
      }
    }
    // swings confirmed L candles later; a close beyond the last one marks the order block behind the move
    const L = this.swing, j = k - L;
    if (j >= L) {
      let hi = true, lo = true;
      for (let m = j - L; m <= j + L; m++) { if (m === j) continue; if (cs[m].h >= cs[j].h) hi = false; if (cs[m].l <= cs[j].l) lo = false; }
      if (hi) this.swH = { p: cs[j].h, i: j };
      if (lo) this.swL = { p: cs[j].l, i: j };
    }
    if (this.swH && c.c > this.swH.p) {
      let m = this.swH.i; for (let n = this.swH.i; n < k; n++) if (cs[n].l < cs[m].l) m = n;
      this.add('ob', 1, cs[m].h, cs[m].l, cs[m].time); this.swH = null;
    }
    if (this.swL && c.c < this.swL.p) {
      let m = this.swL.i; for (let n = this.swL.i; n < k; n++) if (cs[n].h > cs[m].h) m = n;
      this.add('ob', -1, cs[m].h, cs[m].l, cs[m].time); this.swL = null;
    }
    // keep the list bounded: drop the oldest finished zones
    if (this.zones.length > 600) { let drop = 200; this.zones = this.zones.filter(q => !(q.t1 != null && drop-- > 0)); }
  }
  /** takes in the candles not seen yet; true when there were some */
  update(cs: Bar[]): boolean {
    if (this.n >= cs.length) return false;
    for (; this.n < cs.length; this.n++) this.step(cs, this.n);
    this.version++;
    return true;
  }
}

/** the zones to draw, newest first: the newest `max` of each kind that is on, without finished ones if they are hidden */
export function shownZones(zones: Zone[], z: ZonePrefs): Zone[] {
  const out: Zone[] = [], count: Partial<Record<ZoneType, number>> = {};
  for (let i = zones.length - 1; i >= 0; i--) {
    const q = zones[i], st = z[q.type];
    if (!st || !st.on || (q.t1 != null && z.hideDone)) continue;
    if ((count[q.type] = (count[q.type] || 0) + 1) > z.max) continue;
    out.push(q);
  }
  return out;
}

/** the label on a zone, e.g. "15m ▲ FVG" */
export const zoneLabel = (q: Zone, tfTag: string) => `${tfTag}${q.dir > 0 ? '▲' : '▼'} ${ZONE_NAME[q.type]}`;

export interface BarCols { t: ArrayLike<number>; h: ArrayLike<number>; l: ArrayLike<number>; c: ArrayLike<number>; o: ArrayLike<number> }
/** finished candles of another timeframe, built from base bars already played (bars before index `upTo`) */
export class TfCandles {
  list: Array<Bar & { o: number }> = [];
  cur: (Bar & { o: number }) | null = null;
  i: number;
  readonly label: string;
  private bucket: (t: number) => number;
  constructor(readonly s: BarCols, tf: TF, upTo: number) {
    this.label = tfLabel(tf); this.bucket = makeBucket(tf);
    // up to 1500 candles (at most 120 days) back from where the replay is
    const span = tf.kind === 's' ? tf.sec : tf.kind === 'W' ? 604800 * tf.n : 2629800 * tf.n;
    const from = s.t[Math.max(0, upTo - 1)] - Math.min(span * 1500, 86400 * 120);
    let a = 0, b = s.t.length; while (a < b) { const m = (a + b) >> 1; if (s.t[m] < from) a = m + 1; else b = m; }
    this.i = a;
  }
  /** takes in the bars before index upTo; the candle still forming is kept back */
  advance(upTo: number) {
    const s = this.s;
    for (; this.i < upTo; this.i++) {
      const i = this.i, b = this.bucket(s.t[i]);
      if (!this.cur || this.cur.time !== b) { if (this.cur) this.list.push(this.cur); this.cur = { time: b, o: s.o[i], h: s.h[i], l: s.l[i], c: s.c[i] }; }
      else { const c = this.cur; if (s.h[i] > c.h) c.h = s.h[i]; if (s.l[i] < c.l) c.l = s.l[i]; c.c = s.c[i]; }
    }
    if (this.list.length > 4000) this.list.splice(0, 1500);
    return this.list;
  }
}
