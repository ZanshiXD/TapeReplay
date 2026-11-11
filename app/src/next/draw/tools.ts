// Every drawing tool, grouped as on TradingView's left toolbar. A tool says how many points it is placed with, its
// starting style, and how it draws; the overlay does the rest (placing, selecting, dragging, hit testing).
import { anchoredVwap, fibExtPrice, fibLevels, fibPrice, makeStyle, positionOutcome, regression, volumeProfile, type DrawStyle, type Drawing, type Level, type Pt } from '../../core/drawings';
import { add, circle3, dist, lerp, mid, rgba, sub, type Geo, type Painter, type Stroke, type XY } from './paint';

export type Group = 'cursor' | 'lines' | 'fib' | 'patterns' | 'forecast' | 'shapes' | 'notes';
export interface ToolDef {
  id: string; name: string; group: Group; sec: string;
  /** points placed by clicking; 'path': click until double-click or Enter; 'free': press and drag */
  n: number | 'path' | 'free';
  key?: string;
  icon: string;
  style?: Partial<DrawStyle>;
  /** which settings make sense for it */
  has?: { text?: boolean; fill?: boolean; levels?: boolean; ext?: boolean; labels?: boolean; line?: boolean };
  /** Shift keeps it at 0, 45 or 90 degrees */
  angled?: boolean;
  /** anchored to the pane rather than to time and price */
  screen?: boolean;
  /** opens the text box as soon as it is placed */
  editText?: boolean;
  /** fills in the rest when placing is done (a position from one click, a curve's control points) */
  init?(d: Drawing, g: Geo): void;
  draw(P: Painter, d: Drawing, x: XY[], g: Geo): void;
  /** where the handles of a selected drawing are (default: its points) */
  handles?(d: Drawing, x: XY[], g: Geo): XY[];
  /** moving handle k to pt; return false to let the default (set point k) happen */
  drag?(d: Drawing, k: number, pt: Pt, g: Geo, at: XY): boolean | void;
}

/* ---- helpers ---- */
const S = (d: Drawing): Stroke => ({ color: d.style.color, width: d.style.width, dash: d.style.dash });
const S2 = (color: string, width = 1, dash = 0): Stroke => ({ color, width, dash });
const FILL = (d: Drawing) => d.style.fill ? rgba(d.style.fillColor, d.style.fillAlpha) : null;
const fv = (v: number) => String(+v.toFixed(3));
const lvlText = (d: Drawing, v: number, price: number, g: Geo) => `${d.style.labels ? fv(v) : ''}${d.style.prices ? `${d.style.labels ? ' ' : ''}(${g.fp(price)})` : ''}`;
const on = (d: Drawing) => d.style.levels.filter(l => l.on);
const TXT = (d: Drawing, over: Partial<{ color: string; size: number }> = {}) => ({ color: over.color || d.style.textColor, size: over.size || d.style.fontSize, bold: d.style.bold, italic: d.style.italic });
/** a price on the market's tick grid (positions and orders trade there) */
const onTick = (p: number, g: Geo) => +(Math.round(p / g.tick) * g.tick).toFixed(g.prec);
const signed = (x: number, s: string) => (x >= 0 ? '+' : '−') + s;
const money = (x: number) => (x < 0 ? '−$' : '$') + Math.abs(x).toLocaleString('en-US', { maximumFractionDigits: 0 });
const linePrice = (a: Pt, b: Pt, t: number, g: Geo) => { const la = g.logical(a.t), lb = g.logical(b.t); return lb === la ? a.p : a.p + (b.p - a.p) * (g.logical(t) - la) / (lb - la); };
/** a point moved by a number of bars and a price */
const shiftPt = (g: Geo, p: Pt, bars: number, dp: number): Pt => ({ t: g.tOf(g.logical(p.t) + bars), p: p.p + dp });

/** text written along a line, above its middle */
function lineText(P: Painter, d: Drawing, a: XY, b: XY) {
  if (!d.style.text) return;
  let ang = Math.atan2(b.y - a.y, b.x - a.x); if (ang > Math.PI / 2) ang -= Math.PI; if (ang < -Math.PI / 2) ang += Math.PI;
  const m = mid(a, b), c = P.ctx; c.save(); c.translate(m.x, m.y); c.rotate(ang);
  P.text(d.style.text, 0, -4, { ...TXT(d, { color: d.style.color }), align: 'center', base: 'bottom' }, false); c.restore();
}
/** the stats a trend line or info line shows: change, bars, time, angle */
function lineStats(d: Drawing, g: Geo, x: XY[]) {
  const [A, B] = d.pts, dp = B.p - A.p, pct = A.p ? dp / A.p * 100 : 0, ticks = Math.round(dp / g.tick);
  const bars = Math.round(g.logical(B.t) - g.logical(A.t)), ang = Math.atan2(-(x[1].y - x[0].y), x[1].x - x[0].x) * 180 / Math.PI;
  return [`${signed(dp, g.fp(Math.abs(dp)))} (${signed(pct, Math.abs(pct).toFixed(2))}%) ${ticks} ticks`, `${bars} bars, ${g.span(Math.abs(B.t - A.t))}`, `∠ ${ang.toFixed(1)}°`];
}
function labelAt(P: Painter, p: XY, text: string, color: string, up: boolean) {
  P.text(text, p.x, p.y + (up ? -8 : 8), { color: '#fff', size: 12, bold: true, align: 'center', base: up ? 'bottom' : 'top', bg: color, pad: 4, radius: 4 }, false);
}
/** pattern points labeled above when they are peaks, below when troughs */
function pointLabels(P: Painter, d: Drawing, x: XY[], names: string[]) {
  x.forEach((p, i) => {
    const prev = x[i - 1] || x[i + 1], next = x[i + 1] || x[i - 1];
    const peak = !prev ? true : p.y <= Math.min(prev.y, next ? next.y : prev.y);
    if (names[i]) labelAt(P, p, names[i], d.style.color, peak);
  });
}
function ratioLabel(P: Painter, a: XY, b: XY, r: number, color: string) {
  if (!isFinite(r)) return;
  const m = mid(a, b); P.line(a, b, S2(color, 1, 1), false);
  P.text(fv(r), m.x, m.y, { color: '#fff', size: 11, align: 'center', base: 'middle', bg: rgba(color, 0.85), pad: 3 }, false);
}
const ratio = (a: number, b: number) => b ? Math.abs(a / b) : NaN;

/* ---- icons: 24×24, drawn with lines; dots mark anchor points ---- */
const o = (x: number, y: number) => `M${x - 1.6} ${y}a1.6 1.6 0 1 0 3.2 0a1.6 1.6 0 1 0-3.2 0`;
const L = (...p: number[]) => 'M' + p.reduce((s, v, i) => s + (i && i % 2 === 0 ? 'L' : i ? ' ' : '') + v, '');
const IC = {
  cross: 'M12 3v18M3 12h18', dot: 'M12 3v6M12 15v6M3 12h6M15 12h6' + o(12, 12), arrow: 'M6 4l12 7-5 1.5 3.5 6-2 1-3.5-6L7 17z', eraser: 'M4 16l8-8 6 6-5 5H8zM10 10l6 6M13 19h7',
  trend: L(5, 19, 19, 5) + o(5, 19) + o(19, 5), ray: L(5, 19, 22, 2) + o(5, 19) + o(13, 11), info: L(4, 19, 14, 9) + o(4, 19) + o(14, 9) + 'M14 3h7v5h-7z', ext: L(2, 22, 22, 2) + o(9, 15) + o(15, 9),
  angle: L(4, 18, 20, 6) + L(4, 18, 20, 18) + 'M12 18a8 8 0 0 0-1.6-4.8' + o(4, 18), hline: L(2, 12, 22, 12) + o(12, 12), hray: L(8, 12, 22, 12) + o(8, 12), vline: L(12, 2, 12, 22) + o(12, 12), crossl: L(2, 12, 22, 12) + L(12, 2, 12, 22) + o(12, 12),
  channel: L(3, 14, 17, 4) + L(7, 20, 21, 10) + o(3, 14) + o(17, 4) + o(21, 10), regr: L(3, 16, 21, 8) + 'M3 12l18-8M3 20l18-8' + o(3, 16) + o(21, 8), flat: L(3, 18, 21, 8) + L(3, 5, 21, 5) + o(3, 18) + o(21, 8) + o(12, 5), disjoint: L(3, 9, 21, 4) + L(3, 15, 21, 20) + o(3, 9) + o(21, 4) + o(3, 15),
  fork: L(3, 12, 21, 12) + L(8, 6, 21, 6) + L(8, 18, 21, 18) + L(8, 6, 8, 18) + o(3, 12) + o(8, 6) + o(8, 18), schiff: L(3, 15, 21, 11) + L(8, 6, 21, 4) + L(8, 18, 21, 16) + o(3, 15) + o(8, 6) + o(8, 18), mschiff: L(5, 13, 21, 11) + L(9, 6, 21, 4) + L(9, 18, 21, 17) + o(5, 13) + o(9, 6) + o(9, 18), inside: L(6, 12, 21, 12) + L(10, 7, 21, 7) + L(10, 17, 21, 17) + o(6, 12) + o(10, 7) + o(10, 17),
  fib: L(3, 5, 21, 5) + L(3, 10, 21, 10) + L(3, 14, 21, 14) + L(3, 19, 21, 19) + o(4, 19) + o(20, 5), fibext: L(3, 18, 8, 6, 13, 14) + L(13, 4, 21, 4) + L(13, 9, 21, 9) + L(13, 14, 21, 14) + o(3, 18) + o(8, 6) + o(13, 14), fibch: L(3, 16, 21, 8) + L(3, 11, 21, 3) + L(3, 21, 21, 13) + o(3, 16) + o(21, 8), fibtz: L(4, 3, 4, 21) + L(7, 3, 7, 21) + L(11, 3, 11, 21) + L(17, 3, 17, 21) + o(4, 12) + o(7, 12),
  fibfan: L(3, 20, 21, 4) + L(3, 20, 21, 10) + L(3, 20, 21, 15) + L(3, 20, 10, 3) + o(3, 20), fibtime: L(3, 18, 8, 6, 12, 14) + L(12, 3, 12, 21) + L(16, 3, 16, 21) + L(20, 3, 20, 21) + o(3, 18), fibcirc: 'M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0-18 0M12 12m-5 0a5 5 0 1 0 10 0a5 5 0 1 0-10 0' + o(12, 12), fibspiral: 'M12 12a2 2 0 0 1 2 2 4 4 0 0 1-4 4 6 6 0 0 1-6-6 8 8 0 0 1 8-8 10 10 0 0 1 10 10' + o(12, 12),
  fibarcs: 'M3 20a9 9 0 0 1 18 0M7 20a5 5 0 0 1 10 0' + o(12, 20), fibwedge: L(3, 12, 21, 4) + L(3, 12, 21, 20) + 'M13 7.5a10 10 0 0 1 0 9M17 6a14 14 0 0 1 0 12' + o(3, 12), pitchfan: L(4, 12, 20, 3) + L(4, 12, 20, 8) + L(4, 12, 20, 13) + L(4, 12, 20, 20) + L(20, 3, 20, 20) + o(4, 12),
  gannbox: 'M3 4h18v16H3zM3 12h18M12 4v16M3 8h18M7 4v16', gannsqf: 'M4 4h16v16H4zM4 20L20 4M4 12h16M12 4v16' + o(4, 20), gannsq: 'M4 4h16v16H4zM4 20L20 4M4 20l16-8M4 20l8-16', gannfan: L(3, 20, 21, 3) + L(3, 20, 21, 9) + L(3, 20, 21, 15) + L(3, 20, 9, 3) + L(3, 20, 15, 3) + o(3, 20),
  xabcd: L(2, 16, 7, 5, 11, 13, 16, 7, 22, 19) + 'M2 16L11 13M11 13L22 19', cypher: L(2, 18, 7, 6, 11, 12, 16, 3, 22, 16) + 'M2 18L11 12M11 12L22 16', hs: L(2, 18, 6, 10, 9, 15, 12, 4, 15, 15, 18, 10, 22, 18) + L(2, 15, 22, 15), abcd: L(3, 18, 9, 6, 14, 13, 21, 4) + 'M3 18L14 13', triangle: L(3, 6, 8, 18, 13, 8, 17, 15) + L(3, 6, 20, 12) + L(8, 18, 20, 12), drives: L(2, 18, 5, 13, 8, 16, 12, 9, 15, 13, 19, 4, 22, 9),
  eimp: L(2, 19, 6, 11, 9, 15, 14, 4, 17, 9, 22, 2), ecorr: L(3, 4, 9, 16, 14, 9, 21, 20), etri: L(2, 6, 7, 18, 11, 8, 15, 15, 18, 10, 22, 13), edbl: L(3, 4, 9, 14, 14, 9, 21, 19) + o(14, 9), etrip: L(2, 3, 6, 11, 9, 7, 13, 15, 16, 11, 22, 20),
  cyclic: L(4, 3, 4, 21) + L(10, 3, 10, 21) + L(16, 3, 16, 21) + L(22, 3, 22, 21) + o(4, 12) + o(10, 12), timecyc: 'M2 16a5 5 0 0 1 10 0a5 5 0 0 1 10 0M2 16h20' + o(2, 16) + o(12, 16), sine: 'M2 12c3-9 6-9 9 0s6 9 9 0' + o(2, 12) + o(11, 12),
  long: 'M4 4h16v8H4zM4 12h16v8H4z' + L(4, 12, 20, 12) + 'M7 9l3-3 3 3', short: 'M4 4h16v8H4zM4 12h16v8H4z' + L(4, 12, 20, 12) + 'M7 15l3 3 3-3', forecast: L(3, 17, 11, 11) + 'M11 11l9-6' + o(3, 17) + o(20, 5) + 'M14 4h6v6', barsp: 'M5 8v8M5 10h2v4H5M10 5v10M10 7h2v6h-2M15 9v9M15 11h2v5h-2M20 6v9', ghost: 'M5 13v6M4.5 14.5h1.5v3H4.5M10 9v8M9.5 10.5h1.5v4H9.5M15 5v9M14.5 7h1.5v4h-1.5' + 'M19 3v7',
  projection: L(3, 18, 10, 6, 21, 14) + 'M14 9a6 6 0 0 1 2 7' + o(3, 18) + o(10, 6), avwap: 'M3 18c4-1 5-8 9-8s6 4 9 2' + o(3, 18), frvp: 'M4 4v16M4 6h7M4 9h12M4 12h16M4 15h10M4 18h5M4 4h16v16', avp: 'M4 3v18M4 6h6M4 9h10M4 12h14M4 15h8M4 18h4' + o(4, 21),
  prange: 'M5 4h14M5 20h14M12 5v14M9 8l3-3 3 3M9 16l3 3 3-3', drange: 'M4 5v14M20 5v14M5 12h14M8 9l-3 3 3 3M16 9l3 3-3 3', dprange: 'M4 4h16v16H4zM12 7v10M7 12h10',
  brush: 'M4 19c2-1 3-5 6-6s3 2 6 0 3-6 4-8', hl: 'M4 18l10-10 4 4-10 10H4zM13 7l4-4 4 4-4 4', amarker: 'M3 15l10-6-1-3 9 1-4 8-1-3-10 6z', arrowt: L(4, 20, 19, 5) + 'M11 5h8v8', aup: 'M12 4l6 7h-4v8h-4v-8H6z', adown: 'M12 20l6-7h-4V5h-4v8H6z',
  rect: 'M4 6h16v12H4z' + o(4, 6) + o(20, 18), rotrect: 'M4 14l9-10 7 6-9 10z', path: L(3, 18, 8, 8, 14, 15, 20, 6) + 'M17 5h4v4', circle: 'M12 12m-8 0a8 8 0 1 0 16 0a8 8 0 1 0-16 0' + o(12, 12), ellipse: 'M12 12m-9 0a9 6 0 1 0 18 0a9 6 0 1 0-18 0', polyline: L(3, 17, 8, 5, 15, 9, 21, 19) + 'Z', tri: L(4, 19, 12, 4, 20, 19) + 'Z',
  arc: 'M3 18a10 10 0 0 1 18 0' + o(3, 18) + o(21, 18), curve: 'M3 18Q12 0 21 18' + o(3, 18) + o(21, 18), dcurve: 'M2 14c4-12 8-12 10 0s6 12 10 0' + o(2, 14) + o(22, 14),
  text: 'M5 5h14M12 5v14M9 19h6', atext: 'M5 5h14M12 5v11M9 16h6M3 21h18', note: 'M5 4h14v12l-4 4H5zM15 20v-4h4', pnote: L(4, 18, 14, 8) + 'M14 4h7v8h-7z' + o(4, 18), pin: 'M12 21s-6-6-6-11a6 6 0 0 1 12 0c0 5-6 11-6 11zM12 10m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0',
  callout: 'M3 4h18v11H11l-5 5v-5H3z', comment: 'M4 5h16v11h-8l-5 4v-4H4z', plabel: 'M3 12l5-6h13v12H8z', signpost: 'M12 21V10M6 3h12v7H6z', flag: 'M6 21V4M6 4h12l-3 4 3 4H6',
  measure: 'M3 17L17 3l4 4L7 21zM7 13l2 2M10 10l2 2M13 7l2 2', zoom: 'M10 10m-6 0a6 6 0 1 0 12 0a6 6 0 1 0-12 0M15 15l6 6M10 7v6M7 10h6',
};
export const ICONS: Record<string, string> = IC;

/* ---- level presets ---- */
const lv = (vals: number[], onSet: number[], colors?: string[]): Level[] => vals.map((v, k) => ({ v, color: colors ? colors[k % colors.length] : ['#787b86', '#f23645', '#ff9800', '#4caf50', '#089981', '#00bcd4', '#2962ff', '#9c27b0', '#e91e63', '#787b86'][k % 10], on: onSet.includes(v) }));
const FIB_EXT = lv([0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.272, 1.414, 1.618, 2, 2.618, 3.618, 4.236], [0, 0.382, 0.618, 1, 1.272, 1.618, 2, 2.618]);
const FAN = lv([0.25, 0.382, 0.5, 0.618, 0.75], [0.25, 0.382, 0.5, 0.618, 0.75]);
const PITCH = lv([0.25, 0.382, 0.5, 0.618, 0.75, 1, 1.5, 1.75, 2], [0.5, 1]);
const TIMEZ = lv([0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144], [0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144]);
const FIBTIME = lv([0, 0.382, 0.5, 0.618, 1, 1.382, 1.618, 2, 2.382, 2.618, 3, 3.618, 4.236], [0, 0.382, 0.5, 0.618, 1, 1.382, 1.618, 2, 2.382, 2.618]);
const CIRC = lv([0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.618, 2.618], [0.382, 0.5, 0.618, 1, 1.618]);
const GANN = lv([0, 0.25, 0.382, 0.5, 0.618, 0.75, 1], [0, 0.25, 0.382, 0.5, 0.618, 0.75, 1]);
const GANNFAN: Array<[string, number]> = [['1/8', 8], ['1/4', 4], ['1/3', 3], ['1/2', 2], ['1/1', 1], ['2/1', 1 / 2], ['3/1', 1 / 3], ['4/1', 1 / 4], ['8/1', 1 / 8]];

/* ---- renderers shared by several tools ---- */
function fibRetr(P: Painter, d: Drawing, x: XY[], g: Geo) {
  const [a, b] = x; if (!b) return P.line(a, a, S(d));
  const [A, B] = d.pts, p1 = d.style.reverse ? B.p : A.p, p2 = d.style.reverse ? A.p : B.p;
  const x0 = d.style.extL ? 0 : Math.min(a.x, b.x), x1 = d.style.extR ? g.w : Math.max(a.x, b.x);
  P.line(a, b, S2(d.style.color, 1, 1));
  const ls = on(d).sort((u, v) => u.v - v.v);
  ls.forEach((l, k) => {
    const y = g.y(fibPrice(p1, p2, l.v));
    if (d.style.fill && k < ls.length - 1) { const y2 = g.y(fibPrice(p1, p2, ls[k + 1].v)); P.band([{ x: x0, y }, { x: x1, y }, { x: x1, y: y2 }, { x: x0, y: y2 }], rgba(l.color, d.style.fillAlpha)); }
  });
  for (const l of ls) {
    const pr = fibPrice(p1, p2, l.v), y = g.y(pr);
    P.hline(y, x0, x1, S2(l.color, d.style.width, d.style.dash));
    const t = lvlText(d, l.v, pr, g); if (t) P.text(t, x0 - 4, y, { color: l.color, size: 11, align: 'right', base: 'middle' }, false);
  }
}
function fibVerticals(P: Painter, d: Drawing, g: Geo, at: (v: number) => number, label = true) {
  const ls = on(d).sort((u, v) => u.v - v.v);
  ls.forEach((l, k) => {
    const xx = at(l.v); if (!isFinite(xx)) return;
    if (d.style.fill && k < ls.length - 1) { const x2 = at(ls[k + 1].v); P.band([{ x: xx, y: 0 }, { x: x2, y: 0 }, { x: x2, y: g.h }, { x: xx, y: g.h }], rgba(l.color, d.style.fillAlpha * 0.6)); }
    P.vline(xx, S2(l.color, d.style.width, d.style.dash));
    if (label && d.style.labels) P.text(fv(l.v), xx + 4, g.h - 6, { color: l.color, size: 11, base: 'bottom' }, false);
  });
}
function pitchfork(kind: 'std' | 'schiff' | 'mschiff' | 'inside') {
  return (P: Painter, d: Drawing, x: XY[], g: Geo) => {
    const [a, b, c] = x; if (!c) return P.poly(x, S(d), false);
    let s = a;
    if (kind === 'schiff') s = { x: a.x, y: (a.y + b.y) / 2 };
    if (kind === 'mschiff') s = mid(a, b);
    if (kind === 'inside') s = mid(a, mid(b, c));
    const m = mid(b, c), dir = sub(m, s);
    if (Math.hypot(dir.x, dir.y) < 1) return;
    const half = sub(b, m), ls = on(d).sort((u, v) => u.v - v.v);
    const tine = (v: number) => add(m, { x: half.x * v, y: half.y * v });
    // background between the tines
    if (d.style.fill) {
      const all = [...ls.map(l => -l.v).reverse(), ...ls.map(l => l.v)];
      for (let k = 0; k < all.length - 1; k++) {
        const p = tine(all[k]), q = tine(all[k + 1]), far = 4 * (g.w + g.h) / Math.hypot(dir.x, dir.y);
        const col = ls.find(l => l.v === Math.abs(all[k]) || l.v === Math.abs(all[k + 1]))?.color || d.style.color;
        P.band([p, q, add(q, { x: dir.x * far, y: dir.y * far }), add(p, { x: dir.x * far, y: dir.y * far })], rgba(col, d.style.fillAlpha * 0.6));
      }
    }
    P.lineX(s, m, S(d), false, true);
    P.line(b, c, S(d));
    for (const l of ls) for (const sg of [1, -1]) { const p = tine(l.v * sg); P.lineX(p, add(p, dir), S2(l.color, d.style.width, d.style.dash), false, true); }
    if (kind !== 'std') P.line(a, s, S2(d.style.color, 1, 1));
  };
}
/** price, date, or date-and-price range (also the measure tool) */
function range(kind: 'p' | 't' | 'pt') {
  return (P: Painter, d: Drawing, x: XY[], g: Geo) => {
    const [a, b] = x; if (!b) return;
    const [A, B] = d.pts, dp = B.p - A.p, up = dp >= 0, col = kind === 't' ? d.style.color : up ? d.style.color : '#f23645';
    P.rect(a, b, null, rgba(col, 0.18));
    const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2, st = S2(col, 1);
    if (kind !== 't') { P.line({ x: cx, y: a.y }, { x: cx, y: b.y }, st); P.arrowHead({ x: cx, y: a.y }, { x: cx, y: b.y }, col, 8); P.hline(a.y, Math.min(a.x, b.x), Math.max(a.x, b.x), st); P.hline(b.y, Math.min(a.x, b.x), Math.max(a.x, b.x), st); }
    if (kind !== 'p') { P.line({ x: a.x, y: cy }, { x: b.x, y: cy }, st); P.arrowHead({ x: a.x, y: cy }, { x: b.x, y: cy }, col, 8); P.line({ x: a.x, y: Math.min(a.y, b.y) }, { x: a.x, y: Math.max(a.y, b.y) }, st); P.line({ x: b.x, y: Math.min(a.y, b.y) }, { x: b.x, y: Math.max(a.y, b.y) }, st); }
    const lines: string[] = [];
    if (kind !== 't') { const pct = A.p ? dp / A.p * 100 : 0; lines.push(`${signed(dp, g.fp(Math.abs(dp)))} (${signed(pct, Math.abs(pct).toFixed(2))}%) ${Math.round(dp / g.tick)} ticks`); lines.push(`${signed(dp, money(Math.abs(dp * g.pv)))} per contract`); }
    if (kind !== 'p') {
      const t0 = Math.min(A.t, B.t), t1 = Math.max(A.t, B.t), bars = g.bars(t0, t1), vol = bars.reduce((s, c) => s + c.v, 0);
      lines.push(`${Math.round(Math.abs(g.logical(B.t) - g.logical(A.t)))} bars, ${g.span(t1 - t0)}`); if (vol > 0) lines.push(`Volume ${Math.round(vol).toLocaleString('en-US')}`);
    }
    const below = kind === 't' ? true : !up;
    P.text(lines.join('\n'), cx, (below ? Math.max(a.y, b.y) + 8 : Math.min(a.y, b.y) - 8), { color: '#fff', size: 12, align: 'center', base: below ? 'top' : 'bottom', bg: rgba(col, 0.9), pad: 7, radius: 5 });
  };
}
function elliott(names: string[]) {
  return (P: Painter, d: Drawing, x: XY[]) => {
    P.poly(x, S(d), false);
    x.forEach((p, i) => {
      const prev = x[i - 1], next = x[i + 1], peak = prev ? (next ? p.y <= Math.min(prev.y, next.y) : p.y < prev.y) : (next ? p.y < next.y : true);
      const n = names[i]; if (!n) return;
      P.text(`(${n})`, p.x, p.y + (peak ? -6 : 6), { color: d.style.color, size: 13, bold: true, align: 'center', base: peak ? 'bottom' : 'top' }, false);
    });
  };
}
function harmonic(names: string[], cypher: boolean) {
  return (P: Painter, d: Drawing, x: XY[]) => {
    const f = rgba(d.style.color, d.style.fillAlpha), pr = d.pts.map(p => p.p);
    if (x.length >= 3) P.band([x[0], x[1], x[2]], f);
    if (x.length >= 5) P.band([x[2], x[3], x[4]], f);
    P.poly(x, S(d), false);
    const col = d.style.color;
    if (x.length >= 3) ratioLabel(P, x[0], x[2], ratio(pr[2] - pr[1], pr[1] - pr[0]), col);
    if (x.length >= 4) ratioLabel(P, x[1], x[3], cypher ? ratio(pr[3] - pr[0], pr[1] - pr[0]) : ratio(pr[3] - pr[2], pr[2] - pr[1]), col);
    if (x.length >= 5) { ratioLabel(P, x[2], x[4], ratio(pr[4] - pr[3], pr[3] - pr[2]), col); ratioLabel(P, x[0], x[4], cypher ? ratio(pr[4] - pr[3], pr[3] - pr[0]) : ratio(pr[4] - pr[1], pr[1] - pr[0]), col); }
    pointLabels(P, d, x, names);
  };
}
/** long or short position: entry, right edge, target, stop */
function position(side: 1 | -1) {
  return {
    init(d: Drawing, g: Geo) {
      const tk = g.tick, e = { t: d.pts[0].t, p: onTick(d.pts[0].p, g) }, sl = g.ticket.sl || 20, tp = g.ticket.tp || sl * 2;
      d.pts = [e, { t: g.tOf(g.logical(e.t) + 16), p: e.p }, { t: e.t, p: onTick(e.p + side * tp * tk, g) }, { t: e.t, p: onTick(e.p - side * sl * tk, g) }];
      if (!d.style.opt.risk) d.style.opt.risk = g.ticket.risk || 200;
    },
    draw(P: Painter, d: Drawing, x: XY[], g: Geo) {
      if (d.pts.length < 4) return;
      const [E, R, T, Sx] = d.pts, x0 = x[0].x, x1 = g.x(R.t), yE = x[0].y, yT = g.y(T.p), yS = g.y(Sx.p);
      const green = '#089981', red = '#f23645';
      P.rect({ x: x0, y: yE }, { x: x1, y: yT }, null, rgba(green, 0.2));
      P.rect({ x: x0, y: yE }, { x: x1, y: yS }, null, rgba(red, 0.2));
      P.hline(yE, x0, x1, S2('#787b86', 1));
      const risk = +(d.style.opt.risk || 200), per = Math.abs(E.p - Sx.p) * g.pv, qty = per > 0 ? Math.max(1, Math.floor(risk / per)) : 1;
      const win = Math.abs(T.p - E.p) * g.pv * qty, lose = per * qty, rr = per ? Math.abs(T.p - E.p) / Math.abs(E.p - Sx.p) : 0;
      // how it played out on the bars since
      const bars = g.bars(E.t, R.t), out = positionOutcome(side, E.p, Sx.p, T.p, bars);
      let status = 'Waiting for the price to reach the entry';
      if (out.filled >= 0 && out.exit != null) {
        const xa = g.x(bars[out.filled].time), xb = g.x(bars[out.at].time), pnl = (out.exit - E.p) * side * g.pv * qty;
        P.rect({ x: Math.max(x0, xa), y: yE }, { x: Math.min(x1, Math.max(xb, xa + 2)), y: g.y(out.exit) }, null, rgba(pnl >= 0 ? green : red, 0.35));
        P.line({ x: Math.max(x0, xa), y: yE }, { x: Math.min(x1, xb), y: g.y(out.exit) }, S2('#d1d4dc', 1, 1), false);
        status = out.state === 'target' ? `Target hit ${money(win)}` : out.state === 'stop' ? `Stop hit ${money(-lose)}` : `Open ${money(pnl)}`;
      }
      // labels stay on screen when the box runs off the right edge
      const lw = Math.max(P.measure(`Target ${g.fp(T.p)} (0.00%) 000 ticks · $0,000`, 11.5), 140) / 2 + 6;
      const lx = Math.max(Math.min((x0 + x1) / 2, g.w - lw), Math.min(g.w - lw, lw)), pct = (p: number) => (Math.abs(p - E.p) / E.p * 100).toFixed(2);
      const top = side > 0 ? yT : yS, bottom = side > 0 ? yS : yT;
      const tText = `Target ${g.fp(T.p)} (${pct(T.p)}%) ${Math.round(Math.abs(T.p - E.p) / g.tick)} ticks · ${money(win)}`;
      const sText = `Stop ${g.fp(Sx.p)} (${pct(Sx.p)}%) ${Math.round(Math.abs(Sx.p - E.p) / g.tick)} ticks · ${money(-lose)}`;
      P.text(side > 0 ? tText : sText, lx, top - 6, { color: '#fff', size: 11.5, align: 'center', base: 'bottom', bg: side > 0 ? green : red, pad: 5 });
      P.text(side > 0 ? sText : tText, lx, bottom + 6, { color: '#fff', size: 11.5, align: 'center', base: 'top', bg: side > 0 ? red : green, pad: 5 });
      // the summary sits on the entry line, or beside the box when the box is too thin to hold it
      const thin = Math.abs(yT - yS) < 70;
      P.text(`${side > 0 ? 'Long' : 'Short'} ${qty} · Risk/reward ${rr.toFixed(2)}\n${status}`, thin ? Math.min(Math.max(x0, x1) + 6, g.w - 2 * lw) : lx, yE, { color: '#fff', size: 11.5, align: thin ? 'left' : 'center', base: 'middle', bg: out.state === 'stop' ? red : out.state === 'target' ? green : '#363a45', pad: 5 });
      P.axisP(yT, g.fp(T.p), green); P.axisP(yS, g.fp(Sx.p), red); P.axisP(yE, g.fp(E.p), '#787b86');
    },
    handles(d: Drawing, x: XY[], g: Geo) { if (d.pts.length < 4) return x; const x0 = x[0].x; return [x[0], { x: g.x(d.pts[1].t), y: x[0].y }, { x: x0, y: g.y(d.pts[2].p) }, { x: x0, y: g.y(d.pts[3].p) }]; },
    drag(d: Drawing, k: number, raw: Pt, g: Geo) {
      const E = d.pts[0], tk = g.tick, pt = { t: raw.t, p: onTick(raw.p, g) };
      if (k === 0) { const w = g.logical(d.pts[1].t) - g.logical(E.t); d.pts[0] = pt; d.pts[1] = { t: g.tOf(g.logical(pt.t) + Math.max(1, w)), p: pt.p }; d.pts[2].t = d.pts[3].t = pt.t; }
      else if (k === 1) d.pts[1] = { t: g.logical(pt.t) > g.logical(E.t) ? pt.t : g.tOf(g.logical(E.t) + 1), p: E.p };
      else if (k === 2) d.pts[2] = { t: E.t, p: side > 0 ? Math.max(pt.p, E.p + tk) : Math.min(pt.p, E.p - tk) };
      else if (k === 3) d.pts[3] = { t: E.t, p: side > 0 ? Math.min(pt.p, E.p - tk) : Math.max(pt.p, E.p + tk) };
      return true;
    },
  };
}
function volProfile(anchored: boolean) {
  return (P: Painter, d: Drawing, x: XY[], g: Geo) => {
    const A = d.pts[0], B = anchored ? { t: g.now, p: A.p } : d.pts[1]; if (!B) return;
    const t0 = Math.min(A.t, B.t), t1 = Math.max(A.t, B.t), bars = g.bars(t0, t1), vp = volumeProfile(bars, Math.max(4, +(d.style.opt.rows || 24)));
    const xa = g.x(t0), xb = Math.max(g.x(t1), xa + 20);
    if (!vp) { P.rect({ x: xa, y: 0 }, { x: xb, y: g.h }, S2('#787b86', 1, 1)); return; }
    const W = (xb - xa) * +(d.style.opt.widthPct || 30) / 100, upC = d.style.opt.upColor as string || '#26a69a', dnC = d.style.opt.downColor as string || '#ef5350';
    P.rect({ x: xa, y: g.y(vp.hi) }, { x: xb, y: g.y(vp.lo) }, null, rgba('#2962ff', 0.06));
    for (let r = 0; r < vp.up.length; r++) {
      const ya = g.y(vp.lo + r * vp.step), yb = g.y(vp.lo + (r + 1) * vp.step), inVa = r >= vp.va0 && r <= vp.va1, a = inVa ? 0.7 : 0.3;
      const lu = vp.up[r] / vp.max * W, ld = vp.dn[r] / vp.max * W, top = Math.min(ya, yb) + 0.5, hh = Math.max(1, Math.abs(yb - ya) - 1);
      P.ctx.fillStyle = rgba(upC, a); P.ctx.fillRect(xa, top, lu, hh);
      P.ctx.fillStyle = rgba(dnC, a); P.ctx.fillRect(xa + lu, top, ld, hh);
    }
    const yp = g.y(vp.lo + (vp.poc + 0.5) * vp.step);
    P.hline(yp, xa, xb, S2('#f23645', 2));
    P.rect({ x: xa, y: g.y(vp.hi) }, { x: xb, y: g.y(vp.lo) }, S2(rgba('#787b86', 0.6), 1, 1));
    P.axisP(yp, g.fp(vp.lo + (vp.poc + 0.5) * vp.step), '#f23645');
  };
}
const textTool = (box: 'none' | 'note' | 'comment' | 'callout' | 'pin' | 'signpost' | 'plabel' | 'pnote' | 'flag' | 'aup' | 'adown') => (P: Painter, d: Drawing, x: XY[], g: Geo) => {
  const a = x[0], st = d.style, t = st.text || '', tx = TXT(d);
  if (box === 'none') { if (t) P.text(t, a.x, a.y, { ...tx, color: st.color, base: 'middle', bg: st.fill ? rgba(st.fillColor, st.fillAlpha) : undefined, border: st.opt.border ? st.color : undefined, pad: st.fill || st.opt.border ? 6 : 0 }); else P.text('Text', a.x, a.y, { ...tx, color: rgba(st.color, 0.5), base: 'middle' }); return; }
  if (box === 'note') { const b = P.text(t || 'Note', a.x - 10, a.y - 12, { ...tx, color: '#131722', base: 'bottom', bg: st.fillColor, pad: 8, radius: 3, maxW: 240 }); P.poly([{ x: a.x - 4, y: b.y + b.h }, a, { x: a.x + 6, y: b.y + b.h }], null, true, st.fillColor); P.dot(a, st.color, 3); return; }
  if (box === 'comment') { const b = P.text(t || 'Comment', a.x, a.y - 14, { ...tx, color: '#fff', base: 'bottom', bg: st.color, pad: 8, radius: 12 }); P.poly([{ x: a.x, y: b.y + b.h - 2 }, a, { x: a.x + 14, y: b.y + b.h - 2 }], null, true, st.color); return; }
  if (box === 'callout') { const b = x[1] || a; const bx = P.text(t || 'Callout', b.x, b.y, { ...tx, color: '#fff', align: 'center', base: 'middle', bg: st.color, pad: 8, radius: 4 }); const c = { x: bx.x + bx.w / 2, y: bx.y + bx.h / 2 }; const n = { x: -(a.y - c.y), y: a.x - c.x }, ln = Math.hypot(n.x, n.y) || 1, k = 7 / ln; P.poly([{ x: c.x + n.x * k, y: c.y + n.y * k }, a, { x: c.x - n.x * k, y: c.y - n.y * k }], null, true, st.color); P.text(t || 'Callout', b.x, b.y, { ...tx, color: '#fff', align: 'center', base: 'middle', pad: 8 }, false); return; }
  if (box === 'pin') {
    const c = P.ctx, top = { x: a.x, y: a.y - 26 };
    c.beginPath(); c.moveTo(a.x, a.y); c.bezierCurveTo(a.x - 4, a.y - 10, a.x - 10, a.y - 14, a.x - 10, top.y); c.arc(a.x, top.y, 10, Math.PI, 0); c.bezierCurveTo(a.x + 10, a.y - 14, a.x + 4, a.y - 10, a.x, a.y); c.fillStyle = st.color; c.fill();
    P.dot(top, '#fff', 3.5); P.prims.push({ k: 'box', x: a.x - 10, y: a.y - 36, w: 20, h: 36 });
    if (g.focus && t) P.text(t, a.x + 14, top.y, { ...tx, color: '#131722', base: 'middle', bg: '#fff', pad: 8, radius: 6 }, false);
    return;
  }
  if (box === 'signpost') { const top = { x: a.x, y: a.y - 44 }; P.line(a, top, S2(st.color, 1)); P.dot(a, st.color, 3); P.text(t || 'Signpost', top.x, top.y, { ...tx, color: '#fff', align: 'center', base: 'bottom', bg: st.color, pad: 6, radius: 12 }); return; }
  if (box === 'plabel') { const s = t || g.fp(d.pts[0].p), w = P.measure(s, tx.size) + 14, h = tx.size + 10; P.poly([a, { x: a.x + 8, y: a.y - h / 2 }, { x: a.x + 8 + w, y: a.y - h / 2 }, { x: a.x + 8 + w, y: a.y + h / 2 }, { x: a.x + 8, y: a.y + h / 2 }], null, true, st.color); P.text(s, a.x + 15, a.y, { ...tx, color: '#fff', base: 'middle' }, false); return; }
  if (box === 'pnote') { const b = x[1]; if (!b) return P.dot(a, st.color, 3); P.line(a, b, S(d)); P.dot(a, st.color, 3); P.text(`${g.fp(d.pts[0].p)}${t ? '  ' + t : ''}`, b.x + (b.x >= a.x ? 4 : -4), b.y, { ...tx, color: '#fff', align: b.x >= a.x ? 'left' : 'right', base: 'middle', bg: st.color, pad: 5 }); return; }
  if (box === 'flag') { const c = P.ctx; c.fillStyle = st.color; c.fillRect(a.x - 1, a.y - 26, 2, 26); c.beginPath(); c.moveTo(a.x + 1, a.y - 26); c.lineTo(a.x + 18, a.y - 26); c.lineTo(a.x + 13, a.y - 20); c.lineTo(a.x + 18, a.y - 14); c.lineTo(a.x + 1, a.y - 14); c.closePath(); c.fill(); P.prims.push({ k: 'box', x: a.x - 3, y: a.y - 27, w: 22, h: 28 }); if (t) P.text(t, a.x + 22, a.y - 20, { ...tx, base: 'middle' }); return; }
  if (box === 'aup' || box === 'adown') {
    const s = box === 'aup' ? 1 : -1, y0 = a.y + s * 4, pts = [{ x: a.x, y: y0 }, { x: a.x + 9, y: y0 + s * 11 }, { x: a.x + 4, y: y0 + s * 11 }, { x: a.x + 4, y: y0 + s * 22 }, { x: a.x - 4, y: y0 + s * 22 }, { x: a.x - 4, y: y0 + s * 11 }, { x: a.x - 9, y: y0 + s * 11 }];
    P.poly(pts, null, true, st.color);
    if (t) P.text(t, a.x, y0 + s * 26, { ...tx, align: 'center', base: s > 0 ? 'top' : 'bottom' });
  }
};

/* ---- the catalog ---- */
const T = (x: Omit<ToolDef, 'sec'> & { sec?: string }): ToolDef => ({ sec: '', ...x });
const fibStyle = (levels: Level[], o: Partial<DrawStyle> = {}): Partial<DrawStyle> => ({ color: '#787b86', width: 1, fill: true, fillAlpha: 0.12, levels, labels: true, prices: true, ...o });
const LINE = { ext: true, text: true, line: true };

export const TOOLS: ToolDef[] = [
  // cursors
  T({ id: 'cross', name: 'Cross', group: 'cursor', n: 0, icon: IC.cross, draw: () => {} }),
  T({ id: 'dot', name: 'Dot', group: 'cursor', n: 0, icon: IC.dot, draw: () => {} }),
  T({ id: 'arrow', name: 'Arrow', group: 'cursor', n: 0, icon: IC.arrow, draw: () => {} }),
  T({ id: 'eraser', name: 'Eraser', group: 'cursor', n: 0, icon: IC.eraser, draw: () => {} }),

  // lines
  T({ id: 'trend', name: 'Trend line', group: 'lines', sec: 'Lines', n: 2, key: 'Alt+T', icon: IC.trend, angled: true, has: LINE, style: { opt: { stats: false } },
    draw(P, d, x, g) { const [a, b] = x; if (!b) return; P.lineX(a, b, S(d), d.style.extL, d.style.extR); lineText(P, d, a, b); if (d.style.opt.stats) P.text(lineStats(d, g, x).join('\n'), b.x + 8, b.y + 8, { color: '#fff', size: 11.5, bg: 'rgba(30,34,45,.92)', pad: 6 }, false); } }),
  T({ id: 'ray', name: 'Ray', group: 'lines', sec: 'Lines', n: 2, icon: IC.ray, angled: true, has: LINE,
    draw(P, d, x) { const [a, b] = x; if (!b) return; P.lineX(a, b, S(d), false, true); lineText(P, d, a, b); } }),
  T({ id: 'info', name: 'Info line', group: 'lines', sec: 'Lines', n: 2, icon: IC.info, angled: true, has: LINE,
    draw(P, d, x, g) { const [a, b] = x; if (!b) return; P.lineX(a, b, S(d), d.style.extL, d.style.extR); P.text(lineStats(d, g, x).join('\n'), b.x + 8, b.y + 8, { color: '#fff', size: 11.5, bg: 'rgba(30,34,45,.92)', pad: 6 }); } }),
  T({ id: 'extended', name: 'Extended line', group: 'lines', sec: 'Lines', n: 2, icon: IC.ext, angled: true, has: LINE,
    draw(P, d, x) { const [a, b] = x; if (!b) return; P.lineX(a, b, S(d), true, true); lineText(P, d, a, b); } }),
  T({ id: 'angle', name: 'Trend angle', group: 'lines', sec: 'Lines', n: 2, icon: IC.angle, angled: true, has: { text: true, line: true },
    draw(P, d, x) {
      const [a, b] = x; if (!b) return; P.line(a, b, S(d));
      const ang = Math.atan2(-(b.y - a.y), b.x - a.x), r = Math.min(40, dist(a, b));
      P.line(a, { x: a.x + r + 10, y: a.y }, S2(d.style.color, 1, 1), false);
      const c = P.ctx; c.beginPath(); c.setLineDash([]); c.lineWidth = 1; c.strokeStyle = d.style.color; c.arc(a.x, a.y, r * 0.7, 0, -ang, ang > 0); c.stroke();
      P.text(`${(ang * 180 / Math.PI).toFixed(1)}°`, a.x + r + 14, a.y, { color: d.style.color, size: 12, base: 'middle' }, false);
    } }),
  T({ id: 'hline', name: 'Horizontal line', group: 'lines', sec: 'Lines', n: 1, key: 'Alt+H', icon: IC.hline, has: { text: true, line: true }, style: { width: 1 },
    draw(P, d, x, g) { const a = x[0]; P.hline(a.y, 0, g.w, S(d)); if (d.style.text) P.text(d.style.text, g.w - 8, a.y - 4, { ...TXT(d, { color: d.style.color }), align: 'right', base: 'bottom' }, false); P.axisP(a.y, g.fp(d.pts[0].p), d.style.color); },
    handles: (d, x, g) => [{ x: g.w / 2, y: x[0].y }] }),
  T({ id: 'hray', name: 'Horizontal ray', group: 'lines', sec: 'Lines', n: 1, key: 'Alt+J', icon: IC.hray, has: { text: true, line: true }, style: { width: 1 },
    draw(P, d, x, g) { const a = x[0]; P.hline(a.y, a.x, g.w, S(d)); if (d.style.text) P.text(d.style.text, a.x + 4, a.y - 4, { ...TXT(d, { color: d.style.color }), base: 'bottom' }, false); P.axisP(a.y, g.fp(d.pts[0].p), d.style.color); } }),
  T({ id: 'vline', name: 'Vertical line', group: 'lines', sec: 'Lines', n: 1, key: 'Alt+V', icon: IC.vline, has: { text: true, line: true }, style: { width: 1 },
    draw(P, d, x, g) { const a = x[0]; P.vline(a.x, S(d)); if (d.style.text) { const c = P.ctx; c.save(); c.translate(a.x - 4, g.h - 10); c.rotate(-Math.PI / 2); P.text(d.style.text, 0, 0, { ...TXT(d, { color: d.style.color }), base: 'bottom' }, false); c.restore(); } P.axisT(a.x, g.ft(d.pts[0].t), d.style.color); },
    handles: (d, x, g) => [{ x: x[0].x, y: g.h / 2 }] }),
  T({ id: 'crossline', name: 'Cross line', group: 'lines', sec: 'Lines', n: 1, key: 'Alt+C', icon: IC.crossl, has: { line: true }, style: { width: 1 },
    draw(P, d, x, g) { const a = x[0]; P.hline(a.y, 0, g.w, S(d)); P.vline(a.x, S(d)); P.axisP(a.y, g.fp(d.pts[0].p), d.style.color); P.axisT(a.x, g.ft(d.pts[0].t), d.style.color); } }),

  T({ id: 'channel', name: 'Parallel channel', group: 'lines', sec: 'Channels', n: 3, icon: IC.channel, has: { fill: true, ext: true, line: true, text: true }, style: { fill: true, fillAlpha: 0.12, opt: { middle: true } },
    draw(P, d, x, g) {
      const [a, b] = x; if (!b) return; if (!x[2]) return void P.line(a, b, S(d));
      const [A, B, C] = d.pts, off = C.p - linePrice(A, B, C.t, g), a2 = g.xy({ t: A.t, p: A.p + off }), b2 = g.xy({ t: B.t, p: B.p + off });
      const [p, q] = P.lineX(a, b, S(d), d.style.extL, d.style.extR), [p2, q2] = P.lineX(a2, b2, S(d), d.style.extL, d.style.extR);
      const f = FILL(d); if (f) P.poly([p, q, q2, p2], null, true, f);
      if (d.style.opt.middle) P.lineX(mid(a, a2), mid(b, b2), S2(d.style.color, 1, 1), d.style.extL, d.style.extR);
      lineText(P, d, a, b);
    },
    handles(d, x, g) { if (x.length < 3) return x; const [A, B, C] = d.pts, off = C.p - linePrice(A, B, C.t, g); return [x[0], x[1], g.xy({ t: A.t, p: A.p + off }), g.xy({ t: B.t, p: B.p + off })]; },
    drag(d, k, pt, g) { if (k < 2) return false; const [A, B] = d.pts, ref = k === 2 ? A : B; d.pts[2] = { t: A.t, p: A.p + (pt.p - (k === 2 ? A.p : linePrice(A, B, ref.t, g))) }; return true; } }),
  T({ id: 'regression', name: 'Regression trend', group: 'lines', sec: 'Channels', n: 2, icon: IC.regr, has: { fill: true, line: true }, style: { color: '#2962ff', width: 1, fill: true, fillAlpha: 0.12, opt: { dev: 2, upColor: '#2962ff', downColor: '#f23645' } },
    draw(P, d, x, g) {
      const [A, B] = d.pts; if (!B) return void P.line(x[0], x[0], S(d));
      const bars = g.bars(Math.min(A.t, B.t), Math.max(A.t, B.t)), r = regression(bars.map(c => c.c));
      if (!r) return void P.line(x[0], x[1], S2(d.style.color, 1, 1));
      const n = bars.length - 1, xa = g.x(bars[0].time), xb = g.x(bars[n].time), dev = +(d.style.opt.dev ?? 2) * r.sd;
      const at = (i: number, off: number) => ({ x: i === 0 ? xa : xb, y: g.y(r.a + r.b * i + off) });
      const c0 = at(0, 0), c1 = at(n, 0), u0 = at(0, dev), u1 = at(n, dev), l0 = at(0, -dev), l1 = at(n, -dev);
      if (d.style.fill) { P.band([u0, u1, c1, c0], rgba(d.style.opt.upColor as string, d.style.fillAlpha)); P.band([c0, c1, l1, l0], rgba(d.style.opt.downColor as string, d.style.fillAlpha)); }
      P.lineX(u0, u1, S2(d.style.opt.upColor as string, d.style.width), false, d.style.extR); P.lineX(l0, l1, S2(d.style.opt.downColor as string, d.style.width), false, d.style.extR);
      P.lineX(c0, c1, S2(d.style.color, d.style.width, 1), false, d.style.extR);
    },
    handles(d, x, g) { const [A, B] = d.pts; if (!B) return x; const bars = g.bars(Math.min(A.t, B.t), Math.max(A.t, B.t)), r = regression(bars.map(c => c.c)); if (!r) return x; const n = bars.length - 1, first = A.t <= B.t; const ya = g.y(r.a), yb = g.y(r.a + r.b * n); return first ? [{ x: g.x(bars[0].time), y: ya }, { x: g.x(bars[n].time), y: yb }] : [{ x: g.x(bars[n].time), y: yb }, { x: g.x(bars[0].time), y: ya }]; } }),
  T({ id: 'flat', name: 'Flat top/bottom', group: 'lines', sec: 'Channels', n: 3, icon: IC.flat, has: { fill: true, ext: true, line: true }, style: { fill: true, fillAlpha: 0.12 },
    draw(P, d, x) { const [a, b, c] = x; if (!b) return; if (!c) return void P.line(a, b, S(d)); const a2 = { x: a.x, y: c.y }, b2 = { x: b.x, y: c.y }; const [p, q] = P.lineX(a, b, S(d), d.style.extL, d.style.extR), [p2, q2] = P.lineX(a2, b2, S(d), d.style.extL, d.style.extR); const f = FILL(d); if (f) P.poly([p, q, q2, p2], null, true, f); },
    handles(d, x) { return x.length < 3 ? x : [x[0], x[1], { x: x[0].x, y: x[2].y }, { x: x[1].x, y: x[2].y }]; },
    drag(d, k, pt) { if (k < 2) return false; d.pts[2] = { t: d.pts[0].t, p: pt.p }; return true; } }),
  T({ id: 'disjoint', name: 'Disjoint channel', group: 'lines', sec: 'Channels', n: 3, icon: IC.disjoint, has: { fill: true, ext: true, line: true }, style: { fill: true, fillAlpha: 0.12 },
    draw(P, d, x, g) { const [a, b, c] = x; if (!b) return; if (!c) return void P.line(a, b, S(d)); const [A, B, C] = d.pts; const a2 = g.xy({ t: A.t, p: C.p }), b2 = g.xy({ t: B.t, p: C.p - (B.p - A.p) }); const [p, q] = P.lineX(a, b, S(d), d.style.extL, d.style.extR), [p2, q2] = P.lineX(a2, b2, S(d), d.style.extL, d.style.extR); const f = FILL(d); if (f) P.poly([p, q, q2, p2], null, true, f); },
    handles(d, x, g) { if (x.length < 3) return x; const [A, B, C] = d.pts; return [x[0], x[1], g.xy({ t: A.t, p: C.p }), g.xy({ t: B.t, p: C.p - (B.p - A.p) })]; },
    drag(d, k, pt) { if (k < 2) return false; const [A, B] = d.pts; d.pts[2] = { t: A.t, p: k === 2 ? pt.p : pt.p + (B.p - A.p) }; return true; } }),
  T({ id: 'pitchfork', name: 'Pitchfork', group: 'lines', sec: 'Pitchforks', n: 3, icon: IC.fork, has: { levels: true, fill: true, line: true }, style: { fill: true, fillAlpha: 0.12, levels: PITCH, color: '#f23645' }, draw: pitchfork('std') }),
  T({ id: 'schiff', name: 'Schiff pitchfork', group: 'lines', sec: 'Pitchforks', n: 3, icon: IC.schiff, has: { levels: true, fill: true, line: true }, style: { fill: true, fillAlpha: 0.12, levels: PITCH, color: '#f23645' }, draw: pitchfork('schiff') }),
  T({ id: 'mschiff', name: 'Modified Schiff pitchfork', group: 'lines', sec: 'Pitchforks', n: 3, icon: IC.mschiff, has: { levels: true, fill: true, line: true }, style: { fill: true, fillAlpha: 0.12, levels: PITCH, color: '#f23645' }, draw: pitchfork('mschiff') }),
  T({ id: 'insidefork', name: 'Inside pitchfork', group: 'lines', sec: 'Pitchforks', n: 3, icon: IC.inside, has: { levels: true, fill: true, line: true }, style: { fill: true, fillAlpha: 0.12, levels: PITCH, color: '#f23645' }, draw: pitchfork('inside') }),

  // fibonacci and gann
  T({ id: 'fib', name: 'Fib retracement', group: 'fib', sec: 'Fibonacci', n: 2, key: 'Alt+F', icon: IC.fib, has: { levels: true, fill: true, ext: true, labels: true, line: true }, style: fibStyle(fibLevels()), draw: fibRetr }),
  T({ id: 'fibext', name: 'Trend-based fib extension', group: 'fib', sec: 'Fibonacci', n: 3, icon: IC.fibext, has: { levels: true, fill: true, ext: true, labels: true, line: true }, style: fibStyle(FIB_EXT),
    draw(P, d, x, g) {
      const [a, b, c] = x; if (!c) return void P.poly(x, S2('#787b86', 1, 1), false);
      P.poly([a, b, c], S2('rgba(120,123,134,.8)', 1, 1), false);
      const [A, B, C] = d.pts, x0 = d.style.extL ? 0 : Math.min(b.x, c.x), x1 = d.style.extR ? g.w : Math.max(c.x + Math.abs(b.x - a.x), x0 + 40);
      const ls = on(d).sort((u, v) => u.v - v.v);
      ls.forEach((l, k) => { const y = g.y(fibExtPrice(A.p, B.p, C.p, l.v)); if (d.style.fill && k < ls.length - 1) { const y2 = g.y(fibExtPrice(A.p, B.p, C.p, ls[k + 1].v)); P.band([{ x: x0, y }, { x: x1, y }, { x: x1, y: y2 }, { x: x0, y: y2 }], rgba(l.color, d.style.fillAlpha)); } });
      for (const l of ls) { const pr = fibExtPrice(A.p, B.p, C.p, l.v), y = g.y(pr); P.hline(y, x0, x1, S2(l.color, d.style.width, d.style.dash)); const t = lvlText(d, l.v, pr, g); if (t) P.text(t, x0 - 4, y, { color: l.color, size: 11, align: 'right', base: 'middle' }, false); }
    } }),
  T({ id: 'fibchannel', name: 'Fib channel', group: 'fib', sec: 'Fibonacci', n: 3, icon: IC.fibch, has: { levels: true, fill: true, ext: true, labels: true, line: true }, style: fibStyle(fibLevels(), { extR: true }),
    draw(P, d, x, g) {
      const [a, b] = x; if (!b) return; if (!x[2]) return void P.line(a, b, S2('#787b86', 1));
      const [A, B, C] = d.pts, off = C.p - linePrice(A, B, C.t, g), ls = on(d).sort((u, v) => u.v - v.v);
      const at = (v: number): [XY, XY] => [g.xy({ t: A.t, p: A.p + off * v }), g.xy({ t: B.t, p: B.p + off * v })];
      ls.forEach((l, k) => { if (d.style.fill && k < ls.length - 1) { const [p, q] = at(l.v), [p2, q2] = at(ls[k + 1].v); P.band([p, q, q2, p2], rgba(l.color, d.style.fillAlpha)); } });
      for (const l of ls) { const [p, q] = at(l.v); P.lineX(p, q, S2(l.color, d.style.width, d.style.dash), d.style.extL, d.style.extR); if (d.style.labels) P.text(fv(l.v), p.x - 4, p.y, { color: l.color, size: 11, align: 'right', base: 'middle' }, false); }
    },
    handles(d, x, g) { if (x.length < 3) return x; const [A, B, C] = d.pts, off = C.p - linePrice(A, B, C.t, g); return [x[0], x[1], g.xy({ t: A.t, p: A.p + off })]; },
    drag(d, k, pt, g) { if (k < 2) return false; const [A, B] = d.pts; d.pts[2] = { t: A.t, p: A.p + (pt.p - linePrice(A, B, pt.t, g)) }; return true; } }),
  T({ id: 'fibtz', name: 'Fib time zone', group: 'fib', sec: 'Fibonacci', n: 2, icon: IC.fibtz, has: { levels: true, fill: true, labels: true, line: true }, style: fibStyle(TIMEZ, { fill: false }),
    draw(P, d, x, g) { const [a, b] = x; if (!b) return void P.vline(a.x, S(d)); fibVerticals(P, d, g, v => a.x + (b.x - a.x) * v); P.line(a, b, S2('#787b86', 1, 1)); } }),
  T({ id: 'fibfan', name: 'Fib speed resistance fan', group: 'fib', sec: 'Fibonacci', n: 2, icon: IC.fibfan, has: { levels: true, fill: true, labels: true, line: true }, style: fibStyle(FAN, { fill: false }),
    draw(P, d, x) {
      const [a, b] = x; if (!b) return;
      P.rect(a, b, S2(rgba('#787b86', 0.5), 1));
      for (const l of on(d)) {
        const pp = { x: b.x, y: a.y + (b.y - a.y) * l.v }, pt = { x: a.x + (b.x - a.x) * l.v, y: b.y };
        P.lineX(a, pp, S2(l.color, d.style.width, d.style.dash), false, true); P.lineX(a, pt, S2(l.color, d.style.width, d.style.dash), false, true);
        P.hline(pp.y, Math.min(a.x, b.x), Math.max(a.x, b.x), S2(rgba(l.color, 0.4), 1), false); P.line({ x: pt.x, y: a.y }, { x: pt.x, y: b.y }, S2(rgba(l.color, 0.4), 1), false);
        if (d.style.labels) { P.text(fv(l.v), b.x + 4, pp.y, { color: l.color, size: 11, base: 'middle' }, false); P.text(fv(l.v), pt.x, b.y + (b.y > a.y ? 4 : -4), { color: l.color, size: 11, align: 'center', base: b.y > a.y ? 'top' : 'bottom' }, false); }
      }
      P.lineX(a, b, S2('#787b86', d.style.width), false, true);
    } }),
  T({ id: 'fibtime', name: 'Trend-based fib time', group: 'fib', sec: 'Fibonacci', n: 3, icon: IC.fibtime, has: { levels: true, fill: true, labels: true, line: true }, style: fibStyle(FIBTIME, { fill: false }),
    draw(P, d, x, g) { const [a, b, c] = x; if (!c) return void P.poly(x, S2('#787b86', 1, 1), false); P.poly([a, b, c], S2('rgba(120,123,134,.8)', 1, 1), false); fibVerticals(P, d, g, v => c.x + (b.x - a.x) * v); } }),
  T({ id: 'fibcircles', name: 'Fib circles', group: 'fib', sec: 'Fibonacci', n: 2, icon: IC.fibcirc, has: { levels: true, fill: true, labels: true, line: true }, style: fibStyle(CIRC, { fill: false }),
    draw(P, d, x) { const [a, b] = x; if (!b) return; const r = dist(a, b); P.line(a, b, S2('#787b86', 1, 1)); for (const l of on(d)) { P.circle(a, r * l.v, S2(l.color, d.style.width, d.style.dash), d.style.fill ? rgba(l.color, 0.04) : null); if (d.style.labels) P.text(fv(l.v), a.x, a.y - r * l.v - 2, { color: l.color, size: 11, align: 'center', base: 'bottom' }, false); } } }),
  T({ id: 'fibspiral', name: 'Fib spiral', group: 'fib', sec: 'Fibonacci', n: 2, icon: IC.fibspiral, has: { line: true }, style: { color: '#f23645', width: 1, opt: { ccw: false } },
    draw(P, d, x, g) {
      const [a, b] = x; if (!b) return; const r0 = dist(a, b), a0 = Math.atan2(b.y - a.y, b.x - a.x), dir = d.style.opt.ccw ? -1 : 1, pts: XY[] = [], lim = 4 * (g.w + g.h);
      for (let th = -6 * Math.PI; th <= 3 * Math.PI; th += 0.05) { const r = r0 * Math.pow(1.618034, th / (Math.PI / 2)); if (r > lim) break; pts.push({ x: a.x + r * Math.cos(a0 + dir * th), y: a.y + r * Math.sin(a0 + dir * th) }); }
      P.poly(pts, S(d), false); P.line(a, b, S2('#787b86', 1, 1));
    } }),
  T({ id: 'fibarcs', name: 'Fib speed resistance arcs', group: 'fib', sec: 'Fibonacci', n: 2, icon: IC.fibarcs, has: { levels: true, labels: true, line: true }, style: fibStyle(CIRC, { fill: false, opt: { full: false } }),
    draw(P, d, x) { const [a, b] = x; if (!b) return; const r = dist(a, b), base = Math.atan2(b.y - a.y, b.x - a.x); P.line(a, b, S2('#787b86', 1, 1)); for (const l of on(d)) { if (d.style.opt.full) P.circle(a, r * l.v, S2(l.color, d.style.width, d.style.dash)); else P.ellipse(a.x, a.y, r * l.v, r * l.v, 0, S2(l.color, d.style.width, d.style.dash), null, base - Math.PI / 2, base + Math.PI / 2); if (d.style.labels) { const p = { x: a.x + Math.cos(base) * r * l.v, y: a.y + Math.sin(base) * r * l.v }; P.text(fv(l.v), p.x + 3, p.y, { color: l.color, size: 11, base: 'middle' }, false); } } } }),
  T({ id: 'fibwedge', name: 'Fib wedge', group: 'fib', sec: 'Fibonacci', n: 3, icon: IC.fibwedge, has: { levels: true, fill: true, labels: true, line: true }, style: fibStyle(CIRC, { fill: true, fillAlpha: 0.08 }),
    draw(P, d, x) {
      const [a, b, c] = x; if (!c) return void P.poly(x, S(d), false);
      const r = dist(a, b), t0 = Math.atan2(b.y - a.y, b.x - a.x); let t1 = Math.atan2(c.y - a.y, c.x - a.x); if (t1 - t0 > Math.PI) t1 -= 2 * Math.PI; if (t0 - t1 > Math.PI) t1 += 2 * Math.PI;
      P.line(a, b, S2('#787b86', 1)); P.line(a, { x: a.x + Math.cos(t1) * r, y: a.y + Math.sin(t1) * r }, S2('#787b86', 1));
      const ls = on(d).sort((u, v) => u.v - v.v);
      for (const l of ls) { P.ellipse(a.x, a.y, r * l.v, r * l.v, 0, S2(l.color, d.style.width, d.style.dash), null, Math.min(t0, t1), Math.max(t0, t1)); if (d.style.labels) P.text(fv(l.v), a.x + Math.cos(t0) * r * l.v + 3, a.y + Math.sin(t0) * r * l.v, { color: l.color, size: 11, base: 'middle' }, false); }
    },
    handles: (d, x) => x }),
  T({ id: 'pitchfan', name: 'Pitchfan', group: 'fib', sec: 'Fibonacci', n: 3, icon: IC.pitchfan, has: { levels: true, labels: true, line: true }, style: fibStyle(lv([0, 0.25, 0.382, 0.5, 0.618, 0.75, 1], [0, 0.25, 0.382, 0.5, 0.618, 0.75, 1]), { fill: false }),
    draw(P, d, x) { const [a, b, c] = x; if (!c) return void P.poly(x, S(d), false); P.line(b, c, S2('#787b86', 1)); for (const l of on(d)) { const p = lerp(b, c, l.v); P.lineX(a, p, S2(l.color, d.style.width, d.style.dash), false, true); if (d.style.labels) P.text(fv(l.v), p.x + 4, p.y, { color: l.color, size: 11, base: 'middle' }, false); } } }),
  T({ id: 'gannbox', name: 'Gann box', group: 'fib', sec: 'Gann', n: 2, icon: IC.gannbox, has: { levels: true, fill: true, labels: true, line: true }, style: fibStyle(GANN, { fill: true, fillAlpha: 0.08, opt: { angles: false } }),
    draw(P, d, x) {
      const [a, b] = x; if (!b) return; const ls = on(d).sort((u, v) => u.v - v.v);
      ls.forEach((l, k) => { if (d.style.fill && k < ls.length - 1) { const y = a.y + (b.y - a.y) * l.v, y2 = a.y + (b.y - a.y) * ls[k + 1].v; P.band([{ x: a.x, y }, { x: b.x, y }, { x: b.x, y: y2 }, { x: a.x, y: y2 }], rgba(l.color, d.style.fillAlpha)); } });
      for (const l of ls) {
        const y = a.y + (b.y - a.y) * l.v, xx = a.x + (b.x - a.x) * l.v;
        P.line({ x: a.x, y }, { x: b.x, y }, S2(l.color, d.style.width, d.style.dash)); P.line({ x: xx, y: a.y }, { x: xx, y: b.y }, S2(l.color, d.style.width, d.style.dash));
        if (d.style.labels) { P.text(fv(l.v), Math.min(a.x, b.x) - 4, y, { color: l.color, size: 10.5, align: 'right', base: 'middle' }, false); P.text(fv(l.v), xx, Math.max(a.y, b.y) + 3, { color: l.color, size: 10.5, align: 'center' }, false); }
      }
      if (d.style.opt.angles) { P.line(a, b, S2('#787b86', 1, 1)); P.line({ x: a.x, y: b.y }, { x: b.x, y: a.y }, S2('#787b86', 1, 1)); }
    } }),
  T({ id: 'gannsqfixed', name: 'Gann square fixed', group: 'fib', sec: 'Gann', n: 2, icon: IC.gannsqf, has: { line: true, fill: true }, style: { color: '#ff9800', width: 1, fill: true, fillAlpha: 0.06 },
    draw(P, d, x) {
      const [a, bb] = x; if (!bb) return; const side = bb.x - a.x, b = { x: bb.x, y: a.y + Math.sign(bb.y - a.y || -1) * Math.abs(side) };
      P.rect(a, b, S(d), FILL(d));
      for (const f of [0.25, 0.5, 0.75]) { P.line({ x: a.x + side * f, y: a.y }, { x: a.x + side * f, y: b.y }, S2(rgba(d.style.color, 0.5), 1), false); P.line({ x: a.x, y: a.y + (b.y - a.y) * f }, { x: b.x, y: a.y + (b.y - a.y) * f }, S2(rgba(d.style.color, 0.5), 1), false); }
      P.line(a, b, S(d)); P.line({ x: a.x, y: b.y }, { x: b.x, y: a.y }, S(d));
      for (const f of [0.5, 1]) P.ellipse(a.x, a.y, Math.abs(side) * f, Math.abs(side) * f, 0, S2(rgba(d.style.color, 0.6), 1), null, ...(b.y < a.y ? (side > 0 ? [-Math.PI / 2, 0] : [Math.PI, Math.PI * 1.5]) : (side > 0 ? [0, Math.PI / 2] : [Math.PI / 2, Math.PI])) as [number, number]);
    },
    handles(d, x) { if (!x[1]) return x; const side = x[1].x - x[0].x; return [x[0], { x: x[1].x, y: x[0].y + Math.sign(x[1].y - x[0].y || -1) * Math.abs(side) }]; } }),
  T({ id: 'gannsq', name: 'Gann square', group: 'fib', sec: 'Gann', n: 2, icon: IC.gannsq, has: { line: true, fill: true }, style: { color: '#ff9800', width: 1, fill: true, fillAlpha: 0.06 },
    draw(P, d, x) {
      const [a, b] = x; if (!b) return; P.rect(a, b, S(d), FILL(d));
      for (const f of [0.25, 0.5, 0.75]) { P.line({ x: lerp(a, b, f).x, y: a.y }, { x: lerp(a, b, f).x, y: b.y }, S2(rgba(d.style.color, 0.4), 1), false); P.line({ x: a.x, y: lerp(a, b, f).y }, { x: b.x, y: lerp(a, b, f).y }, S2(rgba(d.style.color, 0.4), 1), false); }
      for (const f of [0.25, 0.5, 0.75, 1]) { P.line(a, { x: b.x, y: a.y + (b.y - a.y) * f }, S2(d.style.color, 1), false); P.line(a, { x: a.x + (b.x - a.x) * f, y: b.y }, S2(d.style.color, 1), false); }
      P.line({ x: a.x, y: b.y }, { x: b.x, y: a.y }, S2(d.style.color, 1, 1), false);
    } }),
  T({ id: 'gannfan', name: 'Gann fan', group: 'fib', sec: 'Gann', n: 2, icon: IC.gannfan, has: { labels: true, fill: true, line: true }, style: { color: '#2962ff', width: 1, fill: true, fillAlpha: 0.06, labels: true },
    draw(P, d, x) {
      const [a, b] = x; if (!b) return; const cols = ['#ff9800', '#4caf50', '#089981', '#00bcd4', '#2962ff', '#9c27b0', '#e91e63', '#f23645', '#787b86'];
      const ends = GANNFAN.map(([, r]) => r >= 1 ? { x: b.x, y: a.y + (b.y - a.y) / r } : { x: a.x + (b.x - a.x) * r, y: b.y });
      ends.forEach((e, k) => { if (d.style.fill && k < ends.length - 1 && k % 2 === 0) { const far = 6; P.band([a, add(a, { x: (e.x - a.x) * far, y: (e.y - a.y) * far }), add(a, { x: (ends[k + 1].x - a.x) * far, y: (ends[k + 1].y - a.y) * far })], rgba(cols[k], d.style.fillAlpha)); } });
      ends.forEach((e, k) => { P.lineX(a, e, S2(cols[k], d.style.width, d.style.dash), false, true); if (d.style.labels) P.text(GANNFAN[k][0], e.x + 3, e.y, { color: cols[k], size: 10.5, base: 'middle' }, false); });
    } }),

  // patterns
  T({ id: 'xabcd', name: 'XABCD pattern', group: 'patterns', sec: 'Chart patterns', n: 5, icon: IC.xabcd, has: { text: false, line: true, fill: true }, style: { color: '#2962ff', fillColor: '#2962ff', fillAlpha: 0.15, width: 2 }, draw: harmonic(['X', 'A', 'B', 'C', 'D'], false) }),
  T({ id: 'cypher', name: 'Cypher pattern', group: 'patterns', sec: 'Chart patterns', n: 5, icon: IC.cypher, has: { line: true, fill: true }, style: { color: '#2962ff', fillColor: '#2962ff', fillAlpha: 0.15, width: 2 }, draw: harmonic(['X', 'A', 'B', 'C', 'D'], true) }),
  T({ id: 'hs', name: 'Head and shoulders', group: 'patterns', sec: 'Chart patterns', n: 7, icon: IC.hs, has: { line: true, fill: true }, style: { color: '#089981', fillColor: '#089981', fillAlpha: 0.15, width: 2 },
    draw(P, d, x) {
      const f = rgba(d.style.color, d.style.fillAlpha);
      for (const [i, j, k] of [[0, 1, 2], [2, 3, 4], [4, 5, 6]]) if (x[k]) P.band([x[i], x[j], x[k]], f);
      P.poly(x, S(d), false);
      if (x[4]) { const [p, q] = [x[2], x[4]]; const ext = (xx: number) => ({ x: xx, y: p.y + (q.y - p.y) * (xx - p.x) / ((q.x - p.x) || 1) }); P.line(ext(x[0].x), ext((x[6] || x[4]).x), S2(d.style.color, 1, 1)); }
      const names = ['', 'Left shoulder', '', 'Head', '', 'Right shoulder', ''];
      x.forEach((p, i) => { if (names[i]) labelAt(P, p, names[i], d.style.color, i % 2 === 1 ? p.y < (x[i - 1]?.y ?? p.y + 1) : false); });
    } }),
  T({ id: 'abcd', name: 'ABCD pattern', group: 'patterns', sec: 'Chart patterns', n: 4, icon: IC.abcd, has: { line: true }, style: { color: '#089981', width: 2 },
    draw(P, d, x) { P.poly(x, S(d), false); const pr = d.pts.map(p => p.p); if (x[2]) ratioLabel(P, x[0], x[2], ratio(pr[2] - pr[1], pr[1] - pr[0]), d.style.color); if (x[3]) ratioLabel(P, x[1], x[3], ratio(pr[3] - pr[2], pr[2] - pr[1]), d.style.color); pointLabels(P, d, x, ['A', 'B', 'C', 'D']); } }),
  T({ id: 'trianglepat', name: 'Triangle pattern', group: 'patterns', sec: 'Chart patterns', n: 4, icon: IC.triangle, has: { line: true, fill: true }, style: { color: '#9c27b0', fillColor: '#9c27b0', fillAlpha: 0.12, width: 2 },
    draw(P, d, x, g) {
      P.poly(x, S(d), false);
      if (x[3]) {
        const [a, b, c, e] = x, d1 = sub(c, a), d2 = sub(e, b), den = d1.x * d2.y - d1.y * d2.x;
        let apex: XY | null = null; if (Math.abs(den) > 1e-6) { const t = ((b.x - a.x) * d2.y - (b.y - a.y) * d2.x) / den; if (t > 1) apex = add(a, { x: d1.x * t, y: d1.y * t }); }
        const end = apex && apex.x < g.w * 3 ? apex : null;
        if (end) { P.band([a, end, b], rgba(d.style.color, d.style.fillAlpha)); P.line(a, end, S2(d.style.color, 1, 1)); P.line(b, end, S2(d.style.color, 1, 1)); }
        else { P.lineX(a, c, S2(d.style.color, 1, 1), false, true); P.lineX(b, e, S2(d.style.color, 1, 1), false, true); }
      }
      pointLabels(P, d, x, ['A', 'B', 'C', 'D']);
    } }),
  T({ id: 'drives', name: 'Three drives pattern', group: 'patterns', sec: 'Chart patterns', n: 7, icon: IC.drives, has: { line: true }, style: { color: '#2962ff', width: 2 },
    draw(P, d, x) { P.poly(x, S(d), false); const pr = d.pts.map(p => p.p); if (x[3]) ratioLabel(P, x[1], x[3], ratio(pr[3] - pr[2], pr[1] - pr[2]), d.style.color); if (x[5]) ratioLabel(P, x[3], x[5], ratio(pr[5] - pr[4], pr[3] - pr[4]), d.style.color); pointLabels(P, d, x, ['', 'Drive 1', '', 'Drive 2', '', 'Drive 3', '']); } }),
  T({ id: 'eimpulse', name: 'Elliott impulse wave (12345)', group: 'patterns', sec: 'Elliott waves', n: 6, icon: IC.eimp, has: { line: true }, style: { color: '#2962ff', width: 2 }, draw: elliott(['0', '1', '2', '3', '4', '5']) }),
  T({ id: 'ecorrection', name: 'Elliott correction wave (ABC)', group: 'patterns', sec: 'Elliott waves', n: 4, icon: IC.ecorr, has: { line: true }, style: { color: '#2962ff', width: 2 }, draw: elliott(['0', 'A', 'B', 'C']) }),
  T({ id: 'etriangle', name: 'Elliott triangle wave (ABCDE)', group: 'patterns', sec: 'Elliott waves', n: 6, icon: IC.etri, has: { line: true }, style: { color: '#ff9800', width: 2 }, draw: elliott(['0', 'A', 'B', 'C', 'D', 'E']) }),
  T({ id: 'edouble', name: 'Elliott double combo wave (WXY)', group: 'patterns', sec: 'Elliott waves', n: 4, icon: IC.edbl, has: { line: true }, style: { color: '#4caf50', width: 2 }, draw: elliott(['0', 'W', 'X', 'Y']) }),
  T({ id: 'etriple', name: 'Elliott triple combo wave (WXYXZ)', group: 'patterns', sec: 'Elliott waves', n: 6, icon: IC.etrip, has: { line: true }, style: { color: '#4caf50', width: 2 }, draw: elliott(['0', 'W', 'X', 'Y', 'X', 'Z']) }),
  T({ id: 'cyclic', name: 'Cyclic lines', group: 'patterns', sec: 'Cycles', n: 2, icon: IC.cyclic, has: { line: true }, style: { color: '#2962ff', width: 1 },
    draw(P, d, x, g) { const [a, b] = x; if (!b) return void P.vline(a.x, S(d)); const dx = Math.abs(b.x - a.x); if (dx < 3) return void P.vline(a.x, S(d)); for (let xx = a.x, k = 0; xx <= g.w + 1 && k < 400; xx += dx, k++) P.vline(xx, S(d), k < 2); P.line(a, b, S2(d.style.color, 1, 1)); } }),
  T({ id: 'timecycles', name: 'Time cycles', group: 'patterns', sec: 'Cycles', n: 2, icon: IC.timecyc, has: { line: true, fill: true }, style: { color: '#9c27b0', width: 1, fill: true, fillColor: '#9c27b0', fillAlpha: 0.1 },
    draw(P, d, x, g) { const [a, b] = x; if (!b) return; const D = b.x - a.x; if (Math.abs(D) < 3) return; const r = Math.abs(D) / 2; for (let k = -Math.ceil(a.x / Math.abs(D)) - 1; k < 400; k++) { const x0 = a.x + k * Math.abs(D); if (x0 > g.w) break; P.ellipse(x0 + r, a.y, r, r, 0, S(d), FILL(d), Math.PI, Math.PI * 2); } P.hline(a.y, 0, g.w, S2(rgba(d.style.color, 0.5), 1), false); } }),
  T({ id: 'sine', name: 'Sine line', group: 'patterns', sec: 'Cycles', n: 2, icon: IC.sine, has: { line: true }, style: { color: '#2962ff', width: 2 },
    draw(P, d, x, g) { const [a, b] = x; if (!b) return; const dx = b.x - a.x; if (Math.abs(dx) < 2) return; const yc = (a.y + b.y) / 2, A = (b.y - a.y) / 2, pts: XY[] = []; for (let xx = 0; xx <= g.w; xx += 2) pts.push({ x: xx, y: yc - A * Math.cos(Math.PI * (xx - a.x) / dx) }); P.poly(pts, S(d), false); } }),

  // forecasting and measuring
  T({ id: 'long', name: 'Long position', group: 'forecast', sec: 'Projection', n: 1, icon: IC.long, style: { color: '#089981' }, ...position(1) }),
  T({ id: 'short', name: 'Short position', group: 'forecast', sec: 'Projection', n: 1, icon: IC.short, style: { color: '#f23645' }, ...position(-1) }),
  T({ id: 'forecast', name: 'Forecast', group: 'forecast', sec: 'Projection', n: 2, icon: IC.forecast, has: { line: true }, style: { color: '#2962ff', width: 2, dash: 1 },
    draw(P, d, x, g) {
      const [a, b] = x; if (!b) return; const [A, B] = d.pts; P.line(a, b, S(d)); P.arrowHead(a, b, d.style.color, 10); P.dot(a, d.style.color, 4);
      const up = B.p >= A.p, bars = g.bars(Math.min(A.t, B.t), Math.max(A.t, B.t)), hit = bars.slice(1).some(c => up ? c.h >= B.p : c.l <= B.p);
      const state = hit ? 'Success' : g.now >= B.t ? 'Failure' : 'Waiting', col = hit ? '#089981' : state === 'Failure' ? '#f23645' : d.style.color;
      const dp = B.p - A.p;
      P.text(`${state}\n${signed(dp, g.fp(Math.abs(dp)))} (${signed(dp, Math.abs(dp / A.p * 100).toFixed(2))}%)\n${g.span(Math.abs(B.t - A.t))}`, b.x + 8, b.y, { color: '#fff', size: 11.5, base: 'middle', bg: col, pad: 6 });
    } }),
  T({ id: 'barspattern', name: 'Bars pattern', group: 'forecast', sec: 'Projection', n: 2, icon: IC.barsp, has: { line: true }, style: { color: '#2962ff', opt: { mode: 'candles', flip: false, mirror: false, src: '[]' } },
    init(d, g) {
      const [A, B] = d.pts, bars = g.bars(Math.min(A.t, B.t), Math.max(A.t, B.t)); if (!bars.length) return;
      const o0 = bars[0].o; d.style.opt.src = JSON.stringify(bars.map(b => [b.o - o0, b.h - o0, b.l - o0, b.c - o0]));
      d.pts = [{ t: g.tOf(g.logical(bars[bars.length - 1].time) + 1), p: bars[bars.length - 1].c }];
    },
    draw(P, d, x, g) {
      if (d.pts.length > 1) { const [a, b] = x; P.rect(a, b, S2(d.style.color, 1, 1), rgba(d.style.color, 0.1)); return; }
      let src: number[][] = []; try { src = JSON.parse(String(d.style.opt.src || '[]')); } catch { /* */ }
      const A = d.pts[0], L0 = g.logical(A.t), bw = Math.max(1, g.barW * 0.6), fl = d.style.opt.flip ? -1 : 1, mi = !!d.style.opt.mirror;
      const pts: XY[] = [];
      src.forEach((r, k) => {
        const i = mi ? src.length - 1 - k : k, [o, h, l, c] = r.map(v => A.p + fl * v), xx = g.x(g.tOf(L0 + i)), up = c >= o;
        if (d.style.opt.mode === 'line') { pts.push({ x: xx, y: g.y(c) }); return; }
        P.line({ x: xx, y: g.y(h) }, { x: xx, y: g.y(l) }, S2(rgba(d.style.color, 0.6), 1), false);
        if (d.style.opt.mode !== 'hl') { const y0 = g.y(o), y1 = g.y(c); P.ctx.fillStyle = rgba(d.style.color, up ? 0.25 : 0.6); P.ctx.fillRect(xx - bw / 2, Math.min(y0, y1), bw, Math.max(1, Math.abs(y1 - y0))); }
      });
      if (pts.length) P.poly(pts, S(d), false);
      if (src.length) { const x0 = g.x(g.tOf(L0)), x1 = g.x(g.tOf(L0 + src.length - 1)); const ys = src.flatMap(r => [g.y(A.p + fl * r[1]), g.y(A.p + fl * r[2])]); P.prims.push({ k: 'box', x: x0 - bw, y: Math.min(...ys), w: x1 - x0 + bw * 2, h: Math.max(...ys) - Math.min(...ys) }); }
    } }),
  T({ id: 'ghostfeed', name: 'Ghost feed', group: 'forecast', sec: 'Projection', n: 'path', icon: IC.ghost, has: { line: true }, style: { color: '#787b86', opt: { seed: 7 } },
    draw(P, d, x, g) {
      if (x.length < 2) return void P.dot(x[0], d.style.color);
      const bw = Math.max(1, g.barW * 0.6); let seed = +(d.style.opt.seed || 7);
      const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
      for (let i = 1; i < d.pts.length; i++) {
        const A = d.pts[i - 1], B = d.pts[i], la = g.logical(A.t), lb = g.logical(B.t), n = Math.max(1, Math.round(Math.abs(lb - la))); let prev = A.p;
        for (let k = 1; k <= n; k++) {
          const c = A.p + (B.p - A.p) * k / n + (k < n ? (rnd() - 0.5) * Math.abs(B.p - A.p) / n * 1.5 : 0), o = prev, w = Math.abs(c - o) * 0.6 + g.tick * 2;
          const h = Math.max(o, c) + rnd() * w, l = Math.min(o, c) - rnd() * w, xx = g.x(g.tOf(la + (lb - la) * k / n));
          P.line({ x: xx, y: g.y(h) }, { x: xx, y: g.y(l) }, S2(rgba(d.style.color, 0.8), 1));
          P.ctx.fillStyle = rgba(c >= o ? '#26a69a' : '#ef5350', 0.45); P.ctx.fillRect(xx - bw / 2, Math.min(g.y(o), g.y(c)), bw, Math.max(1, Math.abs(g.y(c) - g.y(o))));
          prev = c;
        }
      }
    } }),
  T({ id: 'projection', name: 'Projection', group: 'forecast', sec: 'Projection', n: 3, icon: IC.projection, has: { line: true, fill: true }, style: { color: '#9c27b0', width: 1, fill: true, fillColor: '#9c27b0', fillAlpha: 0.15 },
    draw(P, d, x) {
      const [a, b, c] = x; if (!c) return void P.poly(x, S(d), false);
      P.poly([a, b, c], S(d), false); const r = dist(b, c), t0 = Math.atan2(a.y - b.y, a.x - b.x) + Math.PI, t1 = Math.atan2(c.y - b.y, c.x - b.x);
      let s = t0, e = t1; if (e - s > Math.PI) e -= 2 * Math.PI; if (s - e > Math.PI) e += 2 * Math.PI;
      P.ellipse(b.x, b.y, r, r, 0, S(d), null, Math.min(s, e), Math.max(s, e));
      if (d.style.fill) { const pts: XY[] = [b]; for (let i = 0; i <= 32; i++) { const t = s + (e - s) * i / 32; pts.push({ x: b.x + Math.cos(t) * r, y: b.y + Math.sin(t) * r }); } P.band(pts, rgba(d.style.fillColor, d.style.fillAlpha)); }
      const [A, B, C] = d.pts; P.text(`${fv(ratio(C.p - B.p, B.p - A.p) * 100)}%`, c.x + 6, c.y, { color: d.style.color, size: 12, base: 'middle' }, false);
    } }),
  T({ id: 'avwap', name: 'Anchored VWAP', group: 'forecast', sec: 'Volume-based', n: 1, icon: IC.avwap, has: { line: true }, style: { color: '#2962ff', width: 2 },
    draw(P, d, x, g) {
      const A = d.pts[0], bars = g.bars(A.t, Infinity), v = anchoredVwap(bars);
      if (!bars.length) return void P.dot(x[0], d.style.color, 4);
      P.poly(bars.map((b, i) => ({ x: g.x(b.time), y: g.y(v[i]) })), S(d), false);
      const last = bars.length - 1; P.text('VWAP', g.x(bars[last].time) + 6, g.y(v[last]), { color: d.style.color, size: 11, base: 'middle' }, false);
      P.axisP(g.y(v[last]), g.fp(v[last]), d.style.color);
    },
    handles(d, x, g) { const bars = g.bars(d.pts[0].t, d.pts[0].t + g.tfSec); return bars.length ? [{ x: g.x(bars[0].time), y: g.y((bars[0].h + bars[0].l + bars[0].c) / 3) }] : x; } }),
  T({ id: 'frvp', name: 'Fixed range volume profile', group: 'forecast', sec: 'Volume-based', n: 2, icon: IC.frvp, has: {}, style: { color: '#2962ff', opt: { rows: 24, widthPct: 30, upColor: '#26a69a', downColor: '#ef5350' } }, draw: volProfile(false),
    handles(d, x) { return x.length < 2 ? x : [{ x: x[0].x, y: Math.min(x[0].y, x[1].y) }, { x: x[1].x, y: Math.max(x[0].y, x[1].y) }]; } }),
  T({ id: 'avp', name: 'Anchored volume profile', group: 'forecast', sec: 'Volume-based', n: 1, icon: IC.avp, has: {}, style: { color: '#2962ff', opt: { rows: 24, widthPct: 30, upColor: '#26a69a', downColor: '#ef5350' } }, draw: volProfile(true) }),
  T({ id: 'pricerange', name: 'Price range', group: 'forecast', sec: 'Measurer', n: 2, icon: IC.prange, style: { color: '#2962ff' }, draw: range('p') }),
  T({ id: 'daterange', name: 'Date range', group: 'forecast', sec: 'Measurer', n: 2, icon: IC.drange, style: { color: '#2962ff' }, draw: range('t') }),
  T({ id: 'dprange', name: 'Date and price range', group: 'forecast', sec: 'Measurer', n: 2, icon: IC.dprange, style: { color: '#2962ff' }, draw: range('pt') }),

  // shapes
  T({ id: 'brush', name: 'Brush', group: 'shapes', sec: 'Brushes', n: 'free', icon: IC.brush, has: { line: true, fill: true }, style: { color: '#2962ff', width: 2, fillAlpha: 0.15 },
    draw(P, d, x) { if (x.length < 2) return; P.poly(x, { ...S(d), dash: 0 }, false, d.style.fill ? rgba(d.style.fillColor, d.style.fillAlpha) : null); } }),
  T({ id: 'highlighter', name: 'Highlighter', group: 'shapes', sec: 'Brushes', n: 'free', icon: IC.hl, has: { line: true }, style: { color: '#ffeb3b', width: 14 },
    draw(P, d, x) { if (x.length < 2) return; const c = P.ctx; c.save(); c.lineJoin = 'round'; P.poly(x, { color: rgba(d.style.color, 0.4), width: d.style.width, dash: 0 }, false); c.restore(); } }),
  T({ id: 'arrowmarker', name: 'Arrow marker', group: 'shapes', sec: 'Arrows', n: 2, icon: IC.amarker, has: { text: true }, style: { color: '#2962ff' },
    draw(P, d, x) {
      const [a, b] = x; if (!b) return; const ang = Math.atan2(b.y - a.y, b.x - a.x), len = dist(a, b), hl = Math.min(22, len * 0.5), sw = 5, hw = 12;
      const r = (u: number, v: number) => ({ x: a.x + u * Math.cos(ang) - v * Math.sin(ang), y: a.y + u * Math.sin(ang) + v * Math.cos(ang) });
      P.poly([r(0, -sw), r(len - hl, -sw), r(len - hl, -hw), r(len, 0), r(len - hl, hw), r(len - hl, sw), r(0, sw)], null, true, d.style.color);
      if (d.style.text) P.text(d.style.text, a.x - Math.cos(ang) * 8, a.y - Math.sin(ang) * 8, { ...TXT(d, { color: d.style.color }), align: Math.cos(ang) > 0 ? 'right' : 'left', base: 'middle' });
    } }),
  T({ id: 'arrowline', name: 'Arrow', group: 'shapes', sec: 'Arrows', n: 2, icon: IC.arrowt, angled: true, has: { line: true, text: true }, style: { color: '#2962ff' },
    draw(P, d, x) { const [a, b] = x; if (!b) return; P.line(a, b, S(d)); P.arrowHead(a, b, d.style.color, 8 + d.style.width * 3); lineText(P, d, a, b); } }),
  T({ id: 'arrowup', name: 'Arrow mark up', group: 'shapes', sec: 'Arrows', n: 1, icon: IC.aup, has: { text: true }, style: { color: '#089981' }, draw: textTool('aup') }),
  T({ id: 'arrowdown', name: 'Arrow mark down', group: 'shapes', sec: 'Arrows', n: 1, icon: IC.adown, has: { text: true }, style: { color: '#f23645' }, draw: textTool('adown') }),
  T({ id: 'rect', name: 'Rectangle', group: 'shapes', sec: 'Shapes', n: 2, key: 'Alt+Shift+R', icon: IC.rect, has: { line: true, fill: true, text: true, ext: true }, style: { color: '#9c27b0', fillColor: '#9c27b0', fill: true, fillAlpha: 0.2, width: 1, textColor: '#d1d4dc', opt: { middle: false } },
    draw(P, d, x, g) {
      const [a, b] = x; if (!b) return; const x0 = d.style.extL ? 0 : Math.min(a.x, b.x), x1 = d.style.extR ? g.w : Math.max(a.x, b.x);
      P.rect({ x: x0, y: a.y }, { x: x1, y: b.y }, S(d), FILL(d));
      if (d.style.opt.middle) P.hline((a.y + b.y) / 2, x0, x1, S2(d.style.color, 1, 1));
      if (d.style.text) P.text(d.style.text, (Math.min(a.x, b.x) + Math.max(a.x, b.x)) / 2, (a.y + b.y) / 2, { ...TXT(d), align: 'center', base: 'middle' }, false);
    },
    handles(d, x) { if (x.length < 2) return x; const [a, b] = x; return [a, b, { x: a.x, y: b.y }, { x: b.x, y: a.y }, { x: (a.x + b.x) / 2, y: a.y }, { x: b.x, y: (a.y + b.y) / 2 }, { x: (a.x + b.x) / 2, y: b.y }, { x: a.x, y: (a.y + b.y) / 2 }]; },
    drag(d, k, pt) { const [A, B] = d.pts; if (k === 2) { A.t = pt.t; B.p = pt.p; } else if (k === 3) { B.t = pt.t; A.p = pt.p; } else if (k === 4) A.p = pt.p; else if (k === 5) B.t = pt.t; else if (k === 6) B.p = pt.p; else if (k === 7) A.t = pt.t; else return false; return true; } }),
  T({ id: 'rotrect', name: 'Rotated rectangle', group: 'shapes', sec: 'Shapes', n: 3, icon: IC.rotrect, has: { line: true, fill: true }, style: { color: '#9c27b0', fillColor: '#9c27b0', fill: true, fillAlpha: 0.2, width: 1 },
    draw(P, d, x) { const [a, b, c] = x; if (!b) return; if (!c) return void P.line(a, b, S(d)); const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy) || 1, n = { x: -dy / l, y: dx / l }, w = (c.x - a.x) * n.x + (c.y - a.y) * n.y; P.poly([a, b, { x: b.x + n.x * w, y: b.y + n.y * w }, { x: a.x + n.x * w, y: a.y + n.y * w }], S(d), true, FILL(d)); },
    handles(d, x) { const [a, b, c] = x; if (!c) return x; const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy) || 1, n = { x: -dy / l, y: dx / l }, w = (c.x - a.x) * n.x + (c.y - a.y) * n.y, m = mid(a, b); return [a, b, { x: m.x + n.x * w, y: m.y + n.y * w }]; } }),
  T({ id: 'path', name: 'Path', group: 'shapes', sec: 'Shapes', n: 'path', icon: IC.path, has: { line: true }, style: { color: '#2962ff' },
    draw(P, d, x) { if (x.length < 2) return void P.dot(x[0], d.style.color); P.poly(x, S(d), false); P.arrowHead(x[x.length - 2], x[x.length - 1], d.style.color, 8 + d.style.width * 3); } }),
  T({ id: 'circle', name: 'Circle', group: 'shapes', sec: 'Shapes', n: 2, icon: IC.circle, has: { line: true, fill: true, text: true }, style: { color: '#ff9800', fillColor: '#ff9800', fill: true, fillAlpha: 0.2 },
    draw(P, d, x) { const [a, b] = x; if (!b) return; P.circle(a, dist(a, b), S(d), FILL(d)); if (d.style.text) P.text(d.style.text, a.x, a.y, { ...TXT(d), align: 'center', base: 'middle' }, false); } }),
  T({ id: 'ellipse', name: 'Ellipse', group: 'shapes', sec: 'Shapes', n: 2, icon: IC.ellipse, has: { line: true, fill: true, text: true }, style: { color: '#f23645', fillColor: '#f23645', fill: true, fillAlpha: 0.2 },
    draw(P, d, x) { const [a, b] = x; if (!b) return; const c = mid(a, b); P.ellipse(c.x, c.y, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, 0, S(d), FILL(d)); if (d.style.text) P.text(d.style.text, c.x, c.y, { ...TXT(d), align: 'center', base: 'middle' }, false); } }),
  T({ id: 'polyline', name: 'Polyline', group: 'shapes', sec: 'Shapes', n: 'path', icon: IC.polyline, has: { line: true, fill: true }, style: { color: '#00bcd4', fillColor: '#00bcd4', fill: true, fillAlpha: 0.15 },
    draw(P, d, x) { if (x.length < 2) return void P.dot(x[0], d.style.color); P.poly(x, S(d), x.length > 2 && !!d.style.opt.closed, d.style.opt.closed ? FILL(d) : null); } }),
  T({ id: 'triangle', name: 'Triangle', group: 'shapes', sec: 'Shapes', n: 3, icon: IC.tri, has: { line: true, fill: true }, style: { color: '#ff9800', fillColor: '#ff9800', fill: true, fillAlpha: 0.2 },
    draw(P, d, x) { P.poly(x, S(d), x.length === 3, x.length === 3 ? FILL(d) : null); } }),
  T({ id: 'arc', name: 'Arc', group: 'shapes', sec: 'Shapes', n: 3, icon: IC.arc, has: { line: true, fill: true }, style: { color: '#e91e63', fillColor: '#e91e63', fill: true, fillAlpha: 0.15 },
    draw(P, d, x) {
      const [a, b, c] = x; if (!b) return; if (!c) return void P.line(a, b, S(d));
      const k = circle3(a, c, b); if (!k) return void P.poly([a, c, b], S(d), false);
      const ta = Math.atan2(a.y - k.y, a.x - k.x), tb = Math.atan2(b.y - k.y, b.x - k.x), tc = Math.atan2(c.y - k.y, c.x - k.x);
      const norm = (t: number) => (t - ta + 4 * Math.PI) % (2 * Math.PI); let e = norm(tb); if (norm(tc) > e) e = e - 2 * Math.PI;
      P.ellipse(k.x, k.y, k.r, k.r, 0, S(d), FILL(d), ta, ta + e);
    },
    handles: (d, x) => x }),
  T({ id: 'curve', name: 'Curve', group: 'shapes', sec: 'Shapes', n: 2, icon: IC.curve, has: { line: true }, style: { color: '#2962ff' },
    init(d, g) { const [A, B] = d.pts, m = mid(g.xy(A), g.xy(B)); d.pts.push({ t: g.t(m.x), p: g.p(m.y - 60) }); },
    draw(P, d, x) { if (x.length < 3) { if (x[1]) P.line(x[0], x[1], S(d)); return; } P.bezier([x[0], x[2], x[1]], S(d)); },
    handles(d, x) { if (x.length < 3) return x; return [x[0], x[1], { x: 0.25 * x[0].x + 0.5 * x[2].x + 0.25 * x[1].x, y: 0.25 * x[0].y + 0.5 * x[2].y + 0.25 * x[1].y }]; },
    drag(d, k, pt, g, at) { if (k !== 2) return false; const a = g.xy(d.pts[0]), b = g.xy(d.pts[1]), c = { x: 2 * at.x - (a.x + b.x) / 2, y: 2 * at.y - (a.y + b.y) / 2 }; d.pts[2] = { t: g.t(c.x), p: g.p(c.y) }; return true; } }),
  T({ id: 'dcurve', name: 'Double curve', group: 'shapes', sec: 'Shapes', n: 2, icon: IC.dcurve, has: { line: true }, style: { color: '#2962ff' },
    init(d, g) { const a = g.xy(d.pts[0]), b = g.xy(d.pts[1]), p = lerp(a, b, 1 / 3), q = lerp(a, b, 2 / 3); d.pts.push({ t: g.t(p.x), p: g.p(p.y - 60) }, { t: g.t(q.x), p: g.p(q.y + 60) }); },
    draw(P, d, x) { if (x.length < 4) { if (x[1]) P.line(x[0], x[1], S(d)); return; } P.bezier([x[0], x[2], x[3], x[1]], S(d)); } }),

  // text and notes
  T({ id: 'text', name: 'Text', group: 'notes', sec: 'Text', n: 1, icon: IC.text, editText: true, has: { text: true, fill: true }, style: { color: '#2962ff', fontSize: 14, fill: false, fillColor: '#2962ff', fillAlpha: 0.15 }, draw: textTool('none') }),
  T({ id: 'atext', name: 'Anchored text', group: 'notes', sec: 'Text', n: 1, icon: IC.atext, screen: true, editText: true, has: { text: true, fill: true }, style: { color: '#2962ff', fontSize: 14, fill: false, fillColor: '#2962ff', fillAlpha: 0.15 }, draw: textTool('none') }),
  T({ id: 'note', name: 'Note', group: 'notes', sec: 'Text', n: 1, icon: IC.note, editText: true, has: { text: true }, style: { color: '#ff9800', fillColor: '#ffe0a3', fontSize: 13 }, draw: textTool('note') }),
  T({ id: 'pricenote', name: 'Price note', group: 'notes', sec: 'Text', n: 2, icon: IC.pnote, has: { text: true, line: true }, style: { color: '#2962ff', width: 1, fontSize: 12 }, draw: textTool('pnote') }),
  T({ id: 'pin', name: 'Pin', group: 'notes', sec: 'Text', n: 1, icon: IC.pin, editText: true, has: { text: true }, style: { color: '#f23645', fontSize: 13 }, draw: textTool('pin') }),
  T({ id: 'callout', name: 'Callout', group: 'notes', sec: 'Text', n: 2, icon: IC.callout, editText: true, has: { text: true }, style: { color: '#2962ff', fontSize: 13 }, draw: textTool('callout') }),
  T({ id: 'comment', name: 'Comment', group: 'notes', sec: 'Text', n: 1, icon: IC.comment, editText: true, has: { text: true }, style: { color: '#2962ff', fontSize: 13 }, draw: textTool('comment') }),
  T({ id: 'pricelabel', name: 'Price label', group: 'notes', sec: 'Text', n: 1, icon: IC.plabel, has: { text: true }, style: { color: '#2962ff', fontSize: 12 }, draw: textTool('plabel') }),
  T({ id: 'signpost', name: 'Signpost', group: 'notes', sec: 'Text', n: 1, icon: IC.signpost, editText: true, has: { text: true }, style: { color: '#2962ff', fontSize: 12 }, draw: textTool('signpost') }),
  T({ id: 'flag', name: 'Flag mark', group: 'notes', sec: 'Text', n: 1, icon: IC.flag, has: { text: true }, style: { color: '#f23645', fontSize: 12 }, draw: textTool('flag') }),
];

export const TOOL: Record<string, ToolDef> = Object.fromEntries(TOOLS.map(t => [t.id, t]));
/** the measure tool: a date-and-price range that goes away on the next click */
export const MEASURE: ToolDef = T({ id: 'measure', name: 'Measure', group: 'forecast', n: 2, icon: IC.measure, style: { color: '#2962ff' }, draw: range('pt') });
export const GROUPS: Array<{ id: Group; name: string }> = [
  { id: 'cursor', name: 'Cursors' }, { id: 'lines', name: 'Trend line tools' }, { id: 'fib', name: 'Gann and Fibonacci tools' },
  { id: 'patterns', name: 'Patterns' }, { id: 'forecast', name: 'Forecasting and measurement tools' }, { id: 'shapes', name: 'Geometric shapes' }, { id: 'notes', name: 'Annotation tools' },
];
export const isDrawTool = (id: string) => !!TOOL[id] && TOOL[id].group !== 'cursor';

/** a new drawing's style: the tool's own defaults, then the saved template */
export function styleFor(id: string, tpl?: Partial<DrawStyle>) { return makeStyle({ ...TOOL[id]?.style, ...(tpl || {}) }); }
