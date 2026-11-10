// What every drawing tool draws with. The painter draws on the overlay canvas and, at the same time, records simple
// shapes (segments, filled areas, boxes) so a click can be tested against exactly what was drawn.
import type { Candle } from '../../core/series';

export interface XY { x: number; y: number }
export interface Stroke { color: string; width: number; dash: number }
export type Prim = { k: 'seg'; a: XY; b: XY; w: number } | { k: 'area'; pts: XY[] } | { k: 'box'; x: number; y: number; w: number; h: number };

/** the chart a drawing is drawn on: screen positions for times and prices, and the bars */
export interface Geo {
  w: number; h: number;
  x(t: number): number; y(p: number): number;
  t(x: number): number; p(y: number): number;
  xy(pt: { t: number; p: number }): XY;
  /** a bar's logical index for a time (fractional between bars, extrapolated past either end) and back */
  logical(t: number): number;
  tOf(logical: number): number;
  barW: number;
  tfSec: number;
  /** the candles from t0 to t1 (inclusive), the forming one too */
  bars(t0: number, t1: number): Candle[];
  tick: number; prec: number; pv: number; sym: string;
  fp(p: number): string;
  ft(t: number): string;
  span(sec: number): string;
  now: number;
  /** the trade panel's risk, stop and target, which a new long or short position starts from */
  ticket: { risk: number; sl: number; tp: number };
  /** whether this drawing is hovered or selected (some tools show more then) */
  focus: boolean;
}

export const rgba = (c: string, a: number) => {
  if (c.startsWith('rgba')) return c;
  const n = parseInt(c.slice(1, 7), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
};
export const mid = (a: XY, b: XY): XY => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
export const dist = (a: XY, b: XY) => Math.hypot(a.x - b.x, a.y - b.y);
export const lerp = (a: XY, b: XY, f: number): XY => ({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f });
export const add = (a: XY, b: XY): XY => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: XY, b: XY): XY => ({ x: a.x - b.x, y: a.y - b.y });

/** the part of the line a→b (extended left and/or right) inside the box w×h */
export function extend(a: XY, b: XY, left: boolean, right: boolean, w: number, h: number): [XY, XY] {
  const dx = b.x - a.x, dy = b.y - a.y;
  if (!left && !right) return [a, b];
  const big = (w + h) * 4;
  const len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len;
  let p = a, q = b;
  if (left) p = { x: a.x - ux * big, y: a.y - uy * big };
  if (right) q = { x: b.x + ux * big, y: b.y + uy * big };
  return clip(p, q, w, h) || [a, b];
}
/** Liang–Barsky clip to the pane (with a margin) */
export function clip(a: XY, b: XY, w: number, h: number): [XY, XY] | null {
  const m = 2, x0 = -m, y0 = -m, x1 = w + m, y1 = h + m;
  let t0 = 0, t1 = 1; const dx = b.x - a.x, dy = b.y - a.y;
  const P = [-dx, dx, -dy, dy], Q = [a.x - x0, x1 - a.x, a.y - y0, y1 - a.y];
  for (let i = 0; i < 4; i++) {
    if (P[i] === 0) { if (Q[i] < 0) return null; continue; }
    const r = Q[i] / P[i];
    if (P[i] < 0) { if (r > t1) return null; if (r > t0) t0 = r; } else { if (r < t0) return null; if (r < t1) t1 = r; }
  }
  return [{ x: a.x + t0 * dx, y: a.y + t0 * dy }, { x: a.x + t1 * dx, y: a.y + t1 * dy }];
}
export function segDist(p: XY, a: XY, b: XY) {
  const dx = b.x - a.x, dy = b.y - a.y, l = dx * dx + dy * dy;
  const t = l ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l)) : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}
export function inPoly(p: XY, pts: XY[]) {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y || 1e-9) + a.x) c = !c;
  }
  return c;
}
export function hitPrims(prims: Prim[], p: XY, tol = 5): boolean {
  for (const q of prims) {
    if (q.k === 'seg') { if (segDist(p, q.a, q.b) <= Math.max(tol, q.w / 2 + 2)) return true; }
    else if (q.k === 'area') { if (inPoly(p, q.pts)) return true; }
    else if (p.x >= q.x - 2 && p.x <= q.x + q.w + 2 && p.y >= q.y - 2 && p.y <= q.y + q.h + 2) return true;
  }
  return false;
}
/** a circle through three points (for arcs) */
export function circle3(a: XY, b: XY, c: XY): { x: number; y: number; r: number } | null {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y)); if (Math.abs(d) < 1e-6) return null;
  const a2 = a.x * a.x + a.y * a.y, b2 = b.x * b.x + b.y * b.y, c2 = c.x * c.x + c.y * c.y;
  const x = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d, y = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d;
  return { x, y, r: Math.hypot(a.x - x, a.y - y) };
}

export interface TextOpts { color?: string; size?: number; bold?: boolean; italic?: boolean; align?: CanvasTextAlign; base?: 'top' | 'middle' | 'bottom'; bg?: string; border?: string; pad?: number; radius?: number; maxW?: number }

export class Painter {
  prims: Prim[] = [];
  /** labels for the price axis (y) and the time axis (x), drawn after the pane is unclipped */
  axis: Array<{ k: 'p' | 't'; at: number; text: string; color: string }> = [];
  axisP(y: number, text: string, color: string) { if (isFinite(y)) this.axis.push({ k: 'p', at: y, text, color }); }
  axisT(x: number, text: string, color: string) { if (isFinite(x)) this.axis.push({ k: 't', at: x, text, color }); }
  constructor(public ctx: CanvasRenderingContext2D, public w: number, public h: number) {}
  private setStroke(s: Stroke) {
    const c = this.ctx; c.strokeStyle = s.color; c.lineWidth = s.width;
    c.setLineDash(s.dash === 1 ? [Math.max(5, s.width * 3), Math.max(4, s.width * 2)] : s.dash === 2 ? [Math.max(1.5, s.width), Math.max(3, s.width * 2)] : []);
    c.lineCap = s.dash === 2 ? 'round' : 'butt';
  }
  line(a: XY, b: XY, s: Stroke, hit = true) {
    if (![a.x, a.y, b.x, b.y].every(isFinite)) return;
    const c = this.ctx; this.setStroke(s);
    c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke();
    if (hit) this.prims.push({ k: 'seg', a, b, w: s.width });
  }
  /** a line, extended to the pane's edges if asked */
  lineX(a: XY, b: XY, s: Stroke, left: boolean, right: boolean, hit = true) { const [p, q] = extend(a, b, left, right, this.w, this.h); this.line(p, q, s, hit); return [p, q] as [XY, XY]; }
  hline(y: number, x0: number, x1: number, s: Stroke, hit = true) { this.line({ x: x0, y }, { x: x1, y }, s, hit); }
  vline(x: number, s: Stroke, hit = true) { this.line({ x, y: 0 }, { x, y: this.h }, s, hit); }
  poly(pts: XY[], s: Stroke | null, close: boolean, fill?: string | null, hitFill = true) {
    if (pts.length < 2 || !pts.every(p => isFinite(p.x) && isFinite(p.y))) return;
    const c = this.ctx;
    c.beginPath(); c.moveTo(pts[0].x, pts[0].y); for (let i = 1; i < pts.length; i++) c.lineTo(pts[i].x, pts[i].y);
    if (close) c.closePath();
    if (fill) { c.fillStyle = fill; c.fill(); if (hitFill) this.prims.push({ k: 'area', pts }); }
    if (s) {
      this.setStroke(s); c.stroke();
      for (let i = 1; i < pts.length; i++) this.prims.push({ k: 'seg', a: pts[i - 1], b: pts[i], w: s.width });
      if (close) this.prims.push({ k: 'seg', a: pts[pts.length - 1], b: pts[0], w: s.width });
    }
  }
  rect(a: XY, b: XY, s: Stroke | null, fill?: string | null) {
    const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
    this.poly([{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }], s, true, fill);
  }
  /** a filled band with no outline and no hit area (level backgrounds) */
  band(pts: XY[], fill: string) { this.poly(pts, null, true, fill, false); }
  ellipse(cx: number, cy: number, rx: number, ry: number, rot: number, s: Stroke | null, fill?: string | null, a0 = 0, a1 = Math.PI * 2) {
    const n = Math.max(24, Math.min(160, Math.round((Math.abs(rx) + Math.abs(ry)) / 3))), pts: XY[] = [];
    const cr = Math.cos(rot), sr = Math.sin(rot);
    for (let i = 0; i <= n; i++) {
      const t = a0 + (a1 - a0) * i / n, ex = Math.cos(t) * rx, ey = Math.sin(t) * ry;
      pts.push({ x: cx + ex * cr - ey * sr, y: cy + ex * sr + ey * cr });
    }
    const full = Math.abs(a1 - a0) >= Math.PI * 2 - 1e-6;
    this.poly(pts, s, full, fill);
  }
  circle(c: XY, r: number, s: Stroke | null, fill?: string | null) { this.ellipse(c.x, c.y, r, r, 0, s, fill); }
  /** a quadratic or cubic curve through control points */
  bezier(p: XY[], s: Stroke, fill?: string | null) {
    const pts: XY[] = [];
    for (let i = 0; i <= 48; i++) {
      const t = i / 48, u = 1 - t;
      if (p.length === 3) pts.push({ x: u * u * p[0].x + 2 * u * t * p[1].x + t * t * p[2].x, y: u * u * p[0].y + 2 * u * t * p[1].y + t * t * p[2].y });
      else pts.push({ x: u * u * u * p[0].x + 3 * u * u * t * p[1].x + 3 * u * t * t * p[2].x + t * t * t * p[3].x, y: u * u * u * p[0].y + 3 * u * u * t * p[1].y + 3 * u * t * t * p[2].y + t * t * t * p[3].y });
    }
    this.poly(pts, s, false, fill);
  }
  arrowHead(from: XY, to: XY, color: string, size: number) {
    const ang = Math.atan2(to.y - from.y, to.x - from.x), c = this.ctx;
    const a = { x: to.x - size * Math.cos(ang - 0.45), y: to.y - size * Math.sin(ang - 0.45) }, b = { x: to.x - size * Math.cos(ang + 0.45), y: to.y - size * Math.sin(ang + 0.45) };
    c.setLineDash([]); c.beginPath(); c.moveTo(to.x, to.y); c.lineTo(a.x, a.y); c.lineTo(b.x, b.y); c.closePath(); c.fillStyle = color; c.fill();
    this.prims.push({ k: 'area', pts: [to, a, b] });
  }
  /** text, optionally on a rounded box; returns the box */
  text(str: string, x: number, y: number, o: TextOpts = {}, hit = true) {
    const c = this.ctx, size = o.size || 12, pad = o.pad ?? (o.bg ? 5 : 0);
    c.font = `${o.italic ? 'italic ' : ''}${o.bold ? 700 : 500} ${size}px Inter, system-ui, sans-serif`;
    const lines = String(str).split('\n'), lh = Math.round(size * 1.3);
    const tw = Math.max(...lines.map(l => c.measureText(l).width)), th = lines.length * lh;
    const bw = tw + pad * 2, bh = th + pad * 2;
    let bx = o.align === 'center' ? x - bw / 2 : o.align === 'right' ? x - bw : x;
    let by = o.base === 'middle' ? y - bh / 2 : o.base === 'bottom' ? y - bh : y;
    if (!isFinite(bx) || !isFinite(by)) return { x: 0, y: 0, w: 0, h: 0 };
    bx = Math.round(bx); by = Math.round(by);
    if (o.bg || o.border) {
      c.beginPath(); c.roundRect(bx, by, bw, bh, o.radius ?? 4);
      if (o.bg) { c.fillStyle = o.bg; c.fill(); }
      if (o.border) { c.setLineDash([]); c.strokeStyle = o.border; c.lineWidth = 1; c.stroke(); }
    }
    c.fillStyle = o.color || '#d1d4dc'; c.textBaseline = 'top'; c.textAlign = 'left';
    lines.forEach((l, i) => c.fillText(l, bx + pad, by + pad + i * lh + (lh - size) / 2));
    const box = { x: bx, y: by, w: bw, h: bh };
    if (hit) this.prims.push({ k: 'box', ...box });
    return box;
  }
  measure(str: string, size = 12, bold = false) { this.ctx.font = `${bold ? 700 : 500} ${size}px Inter, system-ui, sans-serif`; return this.ctx.measureText(str).width; }
  /** a dot with a ring, where a point is labelled (patterns, waves) */
  dot(p: XY, color: string, r = 3) { const c = this.ctx; c.beginPath(); c.arc(p.x, p.y, r, 0, Math.PI * 2); c.fillStyle = color; c.fill(); }
}
