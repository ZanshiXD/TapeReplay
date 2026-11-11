// What the Python indicators draw on one chart: plots are chart series (lines, steps,
// dashes, dots, points or histograms, with per-candle colors and gaps); plots with pane="lower" share a pane of their
// own under the candles; levels, fills, background tints, boxes, lines and labels go on a canvas under the drawings;
// markers join the trade markers (ChartPane asks for them). The canvas redraws only when something it shows changed.
// Colors may be theme names (up, down, accent, muted, fg), each with "@alpha", and follow the theme.
import type { IChartApi, ISeriesApi, Logical, SeriesMarker, SeriesType, Time, UTCTimestamp, AutoscaleInfo } from 'lightweight-charts';
import type { Feed } from '../../core/feed';
import type { TimeMap } from '../studies/layer';
import { C } from '../look';
import { PyRun, type Inst, type Plot, type Fill, type HLine, type PyDraw } from './run';

const MONO = '"JetBrains Mono", Consolas, monospace';
const DASH: Record<string, number[]> = { solid: [], dashed: [7, 5], dotted: [2, 4] };
const SHAPE: Record<string, SeriesMarker<Time>['shape']> = { arrow_up: 'arrowUp', arrow_down: 'arrowDown', circle: 'circle', square: 'square' };
const POS: Record<string, SeriesMarker<Time>['position']> = { above: 'aboveBar', below: 'belowBar', inside: 'inBar' };
const THEME: Record<string, () => string> = { up: () => C.up, down: () => C.down, accent: () => C.accent, muted: () => C.text, fg: () => C.fg };

/* ---- colors: CSS colors or theme names, each with an optional "@alpha" from rgba() ---- */
const hexC = new Map<string, string>();
let cg: CanvasRenderingContext2D | null = null;
/** any CSS color as #rrggbb */
export function pyHex(c: string): string {
  if (/^#[0-9a-f]{6}$/i.test(c)) return c;
  let v = hexC.get(c); if (v) return v;
  cg ||= document.createElement('canvas').getContext('2d')!;
  cg.fillStyle = '#000000'; cg.fillStyle = c; v = String(cg.fillStyle);
  if (!/^#[0-9a-f]{6}$/i.test(v)) { const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(v); v = m ? '#' + [m[1], m[2], m[3]].map(x => (+x).toString(16).padStart(2, '0')).join('') : '#888888'; }
  hexC.set(c, v); return v;
}
const hexA = (hex: string, a: number) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; };
export function pyColor(s: string | null | undefined, def: string): string;
export function pyColor(s: string | null | undefined): string | null;
export function pyColor(s: string | null | undefined, def: string | null = null): string | null {
  if (!s) return def;
  let a: number | null = null;
  const i = s.lastIndexOf('@');
  if (i > 0) { a = parseFloat(s.slice(i + 1)); s = s.slice(0, i); }
  const base = THEME[s] ? THEME[s]() : s;
  return a == null || !isFinite(a) ? base : hexA(pyHex(base), a);
}
const textOn = (hex: string) => { const n = parseInt(hex.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255; return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6 ? '#111418' : '#ffffff'; };
const lowerBound = (a: number[], x: number) => { let i = 0, j = a.length; while (i < j) { const m = (i + j) >> 1; if (a[m] < x) i = m + 1; else j = m; } return i; };
const T = (t: number) => t as UTCTimestamp;

type S = ISeriesApi<SeriesType>;
interface Ser { s: S; sent: number; ins: Inst; lower: boolean }
export interface PyLegend { key: string; title: string; color: string; text: string }

export class PyLayer {
  readonly canvas: HTMLCanvasElement;
  readonly run: PyRun;
  private g: CanvasRenderingContext2D;
  private ser = new Map<Plot, Ser>();
  private insVer = new Map<Inst, number>();
  private bands: Array<{ ins: Inst; y0: number; y1: number }> = [];
  private bandKey = '';
  private bandTotal = 0;
  private key = '';
  private fVer = -1;
  private look = 0;
  private marksSeen = -1;
  private blank = true;

  constructor(private el: HTMLElement, private chart: IChartApi, private cs: ISeriesApi<'Candlestick'>, private feed: Feed, private map: TimeMap, onToast?: (m: string, k?: string) => void) {
    const cv = this.canvas = document.createElement('canvas');
    cv.className = 'pylayer';
    cv.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;z-index:2';
    const dl = el.querySelector(':scope > .drawlayer'); // under the drawings, over the studies
    if (dl) el.insertBefore(cv, dl); else el.appendChild(cv);
    this.g = cv.getContext('2d')!;
    this.run = new PyRun(feed, onToast);
  }
  dispose() {
    this.run.dispose();
    for (const x of this.ser.values()) this.chart.removeSeries(x.s);
    this.ser.clear(); this.canvas.remove();
  }
  /** a new theme: colors resolved again, everything redrawn */
  relook() { this.look++; this.run.marksVer++; for (const [p, x] of this.ser) { x.s.applyOptions({ color: pyColor(p.base, C.accent) }); x.sent = 0; } }
  /** true once after new markers came (ChartPane then sets the markers again) */
  marksChanged() { if (this.run.marksVer === this.marksSeen) return false; this.marksSeen = this.run.marksVer; return true; }

  /** the first candle on the chart: plots and markers before it are left out */
  private first() { const f = this.feed; return f.candles.length ? f.candles[0].time : f.F ? f.F.time : 0; }

  /** every frame: run the indicators, then update the series and the canvas if anything changed */
  render() { this.sync(); this.draw(); }
  /** the indicators run, and their series on the chart brought up to date (with the candles, before the chart draws) */
  sync() {
    const run = this.run;
    run.pump();
    if (!run.list.length && !this.ser.size && this.blank && !this.bandKey) return;
    if (this.feed.version !== this.fVer) { this.fVer = this.feed.version; for (const x of this.ser.values()) x.sent = 0; }
    this.syncSeries();
    this.layout();
  }
  /** the canvas (levels, fills, boxes, labels), if anything changed: after the chart drew, so it lines up with it */
  draw() {
    if (!this.run.list.length && !this.ser.size && this.blank && !this.bandKey) return;
    this.paint();
  }

  /* ---- plots ---- */
  private syncSeries() {
    const live = new Set<Plot>(), first = this.first();
    for (const ins of this.run.list) {
      const fresh = this.insVer.get(ins) !== ins.ver; this.insVer.set(ins, ins.ver);
      for (const p of ins.plots.values()) {
        live.add(p);
        let x = this.ser.get(p);
        if (!x) { x = { s: this.addSeries(ins, p), sent: 0, ins, lower: p.m.pane === 'lower' }; this.ser.set(p, x); }
        else if (!fresh && x.sent === p.t.length) continue;
        const n = p.t.length;
        if (!x.sent || n - x.sent > 64) {
          const d = []; for (let j = lowerBound(p.t, first); j < n; j++) d.push(this.pt(p, j));
          x.s.setData(d);
        } else for (let j = x.sent - 1; j < n; j++) if (p.t[j] >= first) x.s.update(this.pt(p, j));
        x.sent = n;
      }
    }
    for (const [p, x] of this.ser) if (!live.has(p)) { this.chart.removeSeries(x.s); this.ser.delete(p); }
    for (const ins of this.insVer.keys()) if (!this.run.list.includes(ins)) this.insVer.delete(ins);
  }
  private pt(p: Plot, j: number) {
    const v = p.v[j], c = p.c[j];
    if (v == null) return { time: T(p.t[j]) };
    return c ? { time: T(p.t[j]), value: v, color: pyColor(c, C.accent) } : { time: T(p.t[j]), value: v };
  }
  private addSeries(ins: Inst, p: Plot): S {
    const m = p.m, lower = m.pane === 'lower', prec = this.feed.s.inst.prec, lp = Math.max(2, prec), w = Math.max(1, Math.min(4, Math.round(m.width))) as 1 | 2 | 3 | 4;
    const o: Record<string, unknown> = { color: pyColor(p.base, C.accent), priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
      priceFormat: lower ? { type: 'price', precision: lp, minMove: 10 ** -lp } : { type: 'price', precision: prec, minMove: this.feed.tick } };
    if (lower) { o.priceScaleId = 'pi' + ins.iid; o.autoscaleInfoProvider = (orig: () => AutoscaleInfo | null) => this.autoscale(ins, orig()); }
    if (m.style === 'histogram') return this.chart.addHistogramSeries({ ...o, base: 0 }) as S;
    o.lineWidth = w;
    if (m.style === 'step') o.lineType = 1;
    if (m.style === 'dashed') o.lineStyle = 2;
    if (m.style === 'dotted') o.lineStyle = 1;
    if (m.style === 'points') { o.lineVisible = false; o.pointMarkersVisible = true; o.pointMarkersRadius = w + 1; }
    return this.chart.addLineSeries(o) as S;
  }
  /** a lower pane's scale also takes in its levels (70 and 30 on an RSI) */
  private autoscale(ins: Inst, r: AutoscaleInfo | null): AutoscaleInfo | null {
    const hs = ins.hl.filter(h => h.pane === 'lower');
    if (!r || !r.priceRange || !hs.length) return r;
    let lo = r.priceRange.minValue, hi = r.priceRange.maxValue;
    for (const h of hs) { lo = Math.min(lo, h.price); hi = Math.max(hi, h.price); }
    return { ...r, priceRange: { minValue: lo, maxValue: hi } };
  }

  /* ---- lower panes: under the candles and the volume; up to three get a good share of the height ---- */
  private layout() {
    const list = this.run.list.filter(i => i.lower), key = list.map(i => i.iid).join(',');
    if (key === this.bandKey) return;
    this.bandKey = key; this.key = '';
    const k = list.length, b = !k ? 0 : k === 1 ? 0.22 : k === 2 ? 0.17 : k === 3 ? 0.13 : 0.42 / k, tot = b * k;
    this.bandTotal = tot;
    this.cs.priceScale().applyOptions({ scaleMargins: k ? { top: 0.1, bottom: tot + 0.1 } : { top: 0.14, bottom: 0.18 } });
    this.chart.priceScale('vol').applyOptions({ scaleMargins: k ? { top: 1 - tot - 0.1, bottom: tot + 0.005 } : { top: 0.86, bottom: 0 } });
    this.bands = list.map((ins, j) => {
      const y0 = 1 - tot + j * b;
      this.chart.priceScale('pi' + ins.iid).applyOptions({ scaleMargins: { top: y0 + 0.035, bottom: 1 - (y0 + b) + 0.012 } });
      return { ins, y0, y1: y0 + b };
    });
    this.canvas.dataset.bands = String(k);
  }
  private lowerSeries(ins: Inst): S | null { for (const [p, x] of this.ser) if (x.ins === ins && p.m.pane === 'lower') return x.s; return null; }

  /* ---- markers, for ChartPane's syncMarkers: the newest 3000 of each indicator, on candles still on the chart ---- */
  markers(first: number): SeriesMarker<Time>[] {
    const ms: SeriesMarker<Time>[] = [];
    for (const ins of this.run.list) for (const q of ins.marks.slice(-3000)) {
      if (q[0] < first) continue;
      ms.push({ time: T(q[0]), position: POS[q[2]] || 'aboveBar', shape: SHAPE[q[1]] || 'circle', color: pyColor(q[3], C.accent), text: q[4], size: q[5] });
    }
    this.canvas.dataset.marks = String(ms.length);
    return ms;
  }

  /* ---- the legend: each plot's value on the candle under the pointer (the last closed one otherwise) ---- */
  legend(time: number | null): PyLegend[] {
    const out: PyLegend[] = [], prec = this.feed.s.inst.prec;
    for (const ins of this.run.list) {
      let k = 0;
      for (const p of ins.plots.values()) {
        if (k++ >= 6) break;
        const j = time == null ? p.t.length - 1 : lowerBound(p.t, time);
        if (j < 0 || j >= p.t.length || (time != null && p.t[j] !== time)) continue;
        const v = p.v[j]; if (v == null) continue;
        out.push({ key: ins.iid + '\u0000' + p.m.title, title: p.m.title, color: pyHex(pyColor(p.c[j] || p.base, C.accent)), text: p.m.pane === 'lower' ? (Math.abs(v) >= 1 ? v.toFixed(2) : v.toPrecision(3)) : v.toFixed(prec) });
      }
    }
    return out;
  }

  /* ---- the canvas: background, fills, levels, boxes, lines and labels; then the lower panes ---- */
  private paint() {
    const ps = this.chart.paneSize(), w = ps.width, h = ps.height, ts = this.chart.timeScale(), cs = this.cs;
    const a = ts.logicalToCoordinate(0 as Logical), b = ts.logicalToCoordinate(1 as Logical), x0 = a ?? 0, bs = a != null && b != null ? b - a : 6;
    const f = this.feed, nT = f.candles.length + (f.F ? 1 : 0);
    const bandY = this.bands.map(x => { const s = this.lowerSeries(x.ins); return s ? `${s.priceToCoordinate(0)?.toFixed(2)},${s.priceToCoordinate(100)?.toFixed(3)}` : ''; }).join(';');
    const key = [this.run.ver, this.look, this.bandKey, bandY, x0.toFixed(2), bs.toFixed(4), cs.priceToCoordinate(0)?.toFixed(2), cs.priceToCoordinate(1000)?.toFixed(3), w, h, nT, this.el.clientWidth, this.el.clientHeight].join('|');
    if (key === this.key) return;
    this.key = key; this.blank = !this.run.list.length;
    const dpr = window.devicePixelRatio || 1, cw = this.el.clientWidth, ch = this.el.clientHeight, cv = this.canvas;
    if (cv.width !== Math.round(cw * dpr) || cv.height !== Math.round(ch * dpr)) { cv.width = Math.round(cw * dpr); cv.height = Math.round(ch * dpr); cv.style.width = cw + 'px'; cv.style.height = ch + 'px'; }
    const g = this.g; g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, cw, ch);
    const n = { plots: 0, hlines: 0, fills: 0, bg: 0, boxes: 0, lines: 0, labels: 0 }, lv: number[] = [];
    for (const x of this.ser.values()) if (x.sent) n.plots++;
    const lr = ts.getVisibleLogicalRange();
    if (this.run.list.length && lr) {
      const X = (t: number) => x0 + this.map.logical(t) * bs, Y = (p: number) => cs.priceToCoordinate(p);
      const tA = this.map.tOf(lr.from - 2), tB = this.map.tOf(lr.to + 2), top = h * (1 - this.bandTotal);
      g.save(); g.beginPath(); g.rect(0, 0, w, top); g.clip();
      for (const ins of this.run.list) {
        const B = ins.bg;
        for (let j = lowerBound(B.t, tA); j < B.t.length && B.t[j] <= tB; j++) { g.fillStyle = pyColor(B.c[j], C.accent); g.fillRect(X(B.t[j]) - bs / 2, 0, bs, top); n.bg++; }
      }
      for (const ins of this.run.list) for (const fl of ins.fills.values()) if (ins.plots.get(fl.a)?.m.pane !== 'lower') n.fills += this.fill(g, ins, fl, tA, tB, x0, bs);
      for (const ins of this.run.list) {
        n.hlines += this.levels(g, ins.hl, 'price', w, Y, lv);
        const order = { box: 0, line: 1, label: 2 };
        const ds = [...ins.draws.values()].sort((p, q) => order[p.kind] - order[q.kind] || p.id - q.id);
        for (const d of ds) if (this.obj(g, d, w, top, X, Y)) n[d.kind === 'box' ? 'boxes' : d.kind === 'line' ? 'lines' : 'labels']++;
      }
      g.restore();
      for (const band of this.bands) {
        const ins = band.ins, s = this.lowerSeries(ins);
        const y0 = Math.round(h * band.y0) + 0.5, y1 = h * band.y1;
        g.save();
        g.strokeStyle = C.line; g.lineWidth = 1; g.setLineDash([]);
        g.beginPath(); g.moveTo(0, y0); g.lineTo(w, y0); g.stroke();
        g.beginPath(); g.rect(0, y0, w, y1 - y0); g.clip();
        for (const fl of ins.fills.values()) if (ins.plots.get(fl.a)?.m.pane === 'lower') n.fills += this.fill(g, ins, fl, tA, tB, x0, bs);
        if (s) n.hlines += this.levels(g, ins.hl, 'lower', w, p => s.priceToCoordinate(p), lv);
        g.font = `11px ${MONO}`; g.textBaseline = 'middle'; g.textAlign = 'left';
        g.fillStyle = hexA(pyHex(C.bg), 0.75);
        const title = ins.name + (ins.err ? ' (stopped)' : '');
        g.fillRect(4, y0 + 3, g.measureText(title).width + 8, 15);
        g.fillStyle = ins.err ? C.down : C.text; g.fillText(title, 8, y0 + 11);
        g.restore();
      }
    }
    Object.assign(cv.dataset, Object.fromEntries(Object.entries(n).map(([k, v]) => [k, String(v)])), { levels: lv.join(',') });
  }
  /** shading between two plots, a quad per pair of neighbouring candles (not across a gap) */
  private fill(g: CanvasRenderingContext2D, ins: Inst, f: Fill, tA: number, tB: number, x0: number, bs: number) {
    const pa = ins.plots.get(f.a), pb = ins.plots.get(f.b), sa = pa && this.ser.get(pa)?.s, sb = pb && this.ser.get(pb)?.s;
    if (!sa || !sb) return 0;
    let n = 0;
    for (let j = Math.max(0, lowerBound(f.t, tA) - 1); j < f.t.length - 1 && f.t[j] <= tB; j++) {
      const l0 = this.map.logical(f.t[j]), l1 = this.map.logical(f.t[j + 1]);
      if (l1 - l0 > 1.01) continue;
      const xa = x0 + l0 * bs, xb = x0 + l1 * bs;
      const a0 = sa.priceToCoordinate(f.va[j]), a1 = sa.priceToCoordinate(f.va[j + 1]), b0 = sb.priceToCoordinate(f.vb[j]), b1 = sb.priceToCoordinate(f.vb[j + 1]);
      if (a0 == null || a1 == null || b0 == null || b1 == null) continue;
      g.fillStyle = pyColor(f.c[j + 1], hexA(pyHex(C.accent), 0.15));
      g.beginPath(); g.moveTo(xa, a0); g.lineTo(xb, a1); g.lineTo(xb, b1); g.lineTo(xa, b0); g.closePath(); g.fill();
      n++;
    }
    return n ? 1 : 0;
  }
  /** levels across the pane, with the title and price at the right */
  private levels(g: CanvasRenderingContext2D, hl: HLine[], pane: string, w: number, Y: (p: number) => number | null, lv: number[]) {
    let n = 0;
    const prec = this.feed.s.inst.prec;
    for (const h of hl) {
      if (h.pane !== pane) continue;
      const y = Y(h.price); if (y == null) continue;
      lv.push(h.price);
      const col = pyColor(h.color, C.text), yy = Math.round(y) + 0.5;
      g.strokeStyle = col; g.lineWidth = h.width; g.setLineDash(DASH[h.style] || []);
      g.beginPath(); g.moveTo(0, yy); g.lineTo(w, yy); g.stroke();
      g.setLineDash([]); g.font = `10.5px ${MONO}`; g.textBaseline = 'bottom'; g.textAlign = 'right';
      g.fillStyle = col; g.fillText(`${h.title ? h.title + ' ' : ''}${pane === 'lower' ? +h.price.toFixed(4) : h.price.toFixed(prec)}`, w - 6, yy - 2);
      g.textAlign = 'left';
      n++;
    }
    return n;
  }
  /** a box, a line or a label; false when it is out of view */
  private obj(g: CanvasRenderingContext2D, d: PyDraw, pw: number, ph: number, X: (t: number) => number, Y: (p: number) => number | null): boolean {
    const q = d as Record<string, unknown> & PyDraw, num = (k: string) => q[k] as number, str = (k: string) => q[k] as string | null;
    const col = pyColor(str('color'), C.accent);
    g.lineWidth = num('width') || 1; g.strokeStyle = col; g.setLineDash(DASH[str('style') || 'solid'] || []);
    g.font = `11px ${MONO}`; g.textBaseline = 'middle';
    if (d.kind === 'box') {
      const xa = X(num('left')), xb = q.extend ? pw + 2 : X(num('right')), ya = Y(num('top')), yb = Y(num('bottom'));
      if (ya == null || yb == null) return false;
      const l = Math.min(xa, xb), t = Math.min(ya, yb), w = Math.abs(xb - xa), h = Math.abs(yb - ya);
      if (l + w < -2 || l > pw + 2) return false;
      if (q.fill) { g.fillStyle = pyColor(str('fill'), C.accent); g.fillRect(l, t, w, h); }
      g.strokeRect(l, t, w, h);
      // the text sits in the middle of the part of the box in view
      const vl = Math.max(l, 0), vr = Math.min(l + w, pw), text = str('text');
      if (text && vr > vl) { g.setLineDash([]); g.textAlign = 'center'; g.fillStyle = pyColor(str('text_color'), col); g.fillText(text, (vl + vr) / 2, t + h / 2); g.textAlign = 'left'; }
      return true;
    }
    if (d.kind === 'line') {
      let x1 = X(num('x1')), x2 = X(num('x2'));
      const ya = Y(num('y1')), yb = Y(num('y2')), ext = str('extend') || 'none';
      if (ya == null || yb == null) return false;
      let y1 = ya, y2 = yb;
      if (ext === 'none' && (Math.max(x1, x2) < -2 || Math.min(x1, x2) > pw + 2)) return false;
      const far = (xa: number, yA: number, xb: number, yB: number): [number, number] => { // past (xb, yB), away from (xa, yA), to the edge
        if (Math.abs(xb - xa) < 1e-6) return [xb, yB > yA ? ph + 2 : -2];
        const x = xb > xa ? pw + 2 : -2; return [x, yA + (yB - yA) * (x - xa) / (xb - xa)];
      };
      if (ext === 'right' || ext === 'both') [x2, y2] = far(x1, y1, x2, y2);
      if (ext === 'left' || ext === 'both') [x1, y1] = far(x2, y2, x1, y1);
      g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
      return true;
    }
    const x = X(num('x')), y = Y(num('y')), text = str('text');
    if (y == null || !text) return false;
    g.setLineDash([]);
    const w = g.measureText(text).width + 10, h = 18, tc = pyColor(str('text_color')), st = str('style');
    if (x + w / 2 < 0 || x - w / 2 > pw) return false;
    if (st === 'text') { g.textAlign = 'center'; g.fillStyle = tc || col; g.fillText(text, x, y); g.textAlign = 'left'; return true; }
    const y0 = st === 'up' ? y + 7 : st === 'down' ? y - 7 - h : y - h / 2;
    g.fillStyle = col; g.beginPath();
    if (g.roundRect) g.roundRect(x - w / 2, y0, w, h, 3); else g.rect(x - w / 2, y0, w, h);
    g.fill();
    if (st === 'up' || st === 'down') {
      const e = st === 'up' ? y0 : y0 + h, tip = st === 'up' ? y + 1 : y - 1;
      g.beginPath(); g.moveTo(x - 5, e); g.lineTo(x + 5, e); g.lineTo(x, tip); g.closePath(); g.fill();
    }
    g.fillStyle = tc || textOn(pyHex(col)); g.textAlign = 'center'; g.fillText(text, x, y0 + h / 2 + 0.5); g.textAlign = 'left';
    return true;
  }
}
