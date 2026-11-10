// The drawing layer over one chart. It draws every drawing of the chart's market on a canvas above the candles, and
// handles the mouse the way TradingView does: pick a tool, click the points (or press and drag for two-point tools),
// the tool goes back to the cursor (unless "stay in drawing mode" is on), click a drawing to select it, drag its
// handles to change it or its body to move it, double-click for its settings. The magnet snaps points to the bar's
// open, high, low or close (hold Ctrl or Cmd to flip it), Shift keeps lines at 0, 45 or 90 degrees, Shift+click
// measures, Esc cancels, Delete removes.
import type { IChartApi, ISeriesApi, Logical } from 'lightweight-charts';
import type { Session } from '../../core/session';
import type { Feed } from '../../core/feed';
import type { Candle } from '../../core/series';
import type { Drawing, Pt } from '../../core/drawings';
import { fmtShortDay, fmtHM, spanText, tfSeconds } from '../../core/time';
import { Painter, dist, hitPrims, type Geo, type Prim, type XY } from './paint';
import { MEASURE, TOOL, isDrawTool, styleFor, type ToolDef } from './tools';
import { cursorTool, ds, setDs, templates } from './state';
import { ticket } from '../ticket';
import { C, hexA } from '../look';

/** every chart's layer, so the keyboard can reach whichever is drawing */
export const layers = new Set<DrawLayer>();

const HANDLE_R = 5.5;
type Placing = { tool: ToolDef; d: Drawing; fixed: number; down: XY | null; lastClick: { at: number; p: XY } | null };
type DragS = { id: string; k: number | 'body'; l0: number; p0: number; at: XY; orig: Pt[]; moved: boolean };

export class DrawLayer {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private times: number[] = [];
  private tVer = -1;
  private hits = new Map<string, Prim[]>();
  private handlesOf = new Map<string, XY[]>();
  hover: string | null = null;
  private hoverH = -1;
  placing: Placing | null = null;
  private drag: DragS | null = null;
  measure: { pts: Pt[]; done: boolean } | null = null;
  private zoomBox: { a: XY; b: XY } | null = null;
  private zoomStack: Array<{ from: number; to: number }> = [];
  private mouse: XY | null = null;
  private key = '';
  private crossFor = '';
  private w = 0; private h = 0;
  private finishedAt = 0;
  /** a right-click on a drawing: the chart shows its menu */
  onMenu: ((x: number, y: number, id: string) => void) | null = null;

  constructor(private el: HTMLElement, private chart: IChartApi, private series: ISeriesApi<'Candlestick'>, private session: Session, private feed: Feed) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'drawlayer';
    el.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    layers.add(this);
  }
  dispose() { layers.delete(this); this.canvas.remove(); }
  get sym() { return this.feed.s.inst.sym; }
  get store() { return this.session.drawings; }
  /** placing, dragging, measuring or zooming: the mouse belongs to the drawing layer until it's done */
  get busy() { return !!(this.placing || this.drag || this.zoomBox || (this.measure && !this.measure.done)); }

  /* ---- times, prices and screen positions ---- */
  private updateTimes() {
    const f = this.feed, c = f.candles;
    if (f.version !== this.tVer || this.times.length - 1 > c.length) { this.times = c.map(x => x.time); this.tVer = f.version; }
    else { if (this.times.length > c.length) this.times.length = c.length; for (let j = this.times.length; j < c.length; j++) this.times.push(c[j].time); }
    if (f.F && (!c.length || f.F.time > c[c.length - 1].time)) this.times.push(f.F.time);
  }
  private get tf() { return tfSeconds(this.feed.tf); }
  logical(t: number) {
    const T = this.times, n = T.length; if (!n) return 0;
    if (t <= T[0]) return (t - T[0]) / this.tf;
    if (t >= T[n - 1]) return n - 1 + (t - T[n - 1]) / this.tf;
    let a = 0, b = n - 1; while (b - a > 1) { const m = (a + b) >> 1; if (T[m] <= t) a = m; else b = m; }
    return a + (t - T[a]) / (T[b] - T[a]);
  }
  tOf(l: number) {
    const T = this.times, n = T.length; if (!n) return this.feed.time;
    if (l <= 0) return T[0] + l * this.tf;
    if (l >= n - 1) return T[n - 1] + (l - (n - 1)) * this.tf;
    const j = Math.floor(l); return T[j] + (l - j) * (T[j + 1] - T[j]);
  }
  private scale() {
    const ts = this.chart.timeScale(), x0 = ts.logicalToCoordinate(0 as Logical), x1 = ts.logicalToCoordinate(1 as Logical);
    return { x0: x0 ?? 0, bs: x0 != null && x1 != null ? x1 - x0 : 6 };
  }
  private bars(t0: number, t1: number): Candle[] {
    const c = this.feed.candles, F = this.feed.F, out: Candle[] = [];
    let a = 0, b = c.length; while (a < b) { const m = (a + b) >> 1; if (c[m].time < t0) a = m + 1; else b = m; }
    for (let j = a; j < c.length && c[j].time <= t1; j++) out.push(c[j]);
    if (F && F.time >= t0 && F.time <= t1 && (!c.length || F.time > c[c.length - 1].time)) out.push(F);
    return out;
  }
  geo(focus = false): Geo {
    const { x0, bs } = this.scale(), s = this.series, inst = this.feed.s.inst, prec = inst.prec, acc = this.session.account;
    const L = (t: number) => this.logical(t);
    const risk = ticket.mode === 'risk' ? ticket.risk : ticket.mode === 'pct' ? acc.balance * ticket.pct / 100 : 0;
    return {
      w: this.w, h: this.h,
      x: t => x0 + L(t) * bs,
      y: p => s.priceToCoordinate(p) ?? NaN,
      t: x => this.tOf((x - x0) / bs),
      p: y => s.coordinateToPrice(y) ?? NaN,
      xy: pt => ({ x: x0 + L(pt.t) * bs, y: s.priceToCoordinate(pt.p) ?? NaN }),
      logical: L, tOf: l => this.tOf(l), barW: bs, tfSec: this.tf,
      bars: (t0, t1) => this.bars(t0, t1),
      tick: inst.tick, prec, pv: inst.pv, sym: inst.sym,
      fp: p => p.toFixed(prec),
      ft: t => `${fmtShortDay(t)} ${fmtHM(t)}`,
      span: sec => spanText(sec),
      now: this.session.now,
      ticket: { risk: risk || 200, sl: ticket.slTicks, tp: ticket.tpTicks },
      focus,
    };
  }
  private xyOf(d: Drawing, g: Geo) { const t = TOOL[d.tool]; return d.pts.map(p => t?.screen ? { x: p.t * g.w, y: p.p * g.h } : g.xy(p)); }
  private logicalAtX(x: number) { const { x0, bs } = this.scale(); return (x - x0) / bs; }

  /* ---- drawing ---- */
  render() {
    const ps = this.chart.paneSize(); this.w = ps.width; this.h = ps.height;
    this.updateTimes();
    const F = this.feed.F, { x0, bs } = this.scale(), s = this.series, st = this.store;
    const key = [st.version, ds.version, x0.toFixed(2), bs.toFixed(4), s.priceToCoordinate(0)?.toFixed(2), s.priceToCoordinate(1000)?.toFixed(3), this.w, this.h, this.times.length,
      F ? `${F.time},${F.o},${F.h},${F.l},${F.c}` : '', this.hover, this.hoverH, this.busy || ds.tool === 'dot' || this.measure ? `${this.mouse?.x},${this.mouse?.y}` : '', this.el.clientWidth, this.el.clientHeight].join('|');
    if (key === this.key) return;
    this.key = key;
    this.applyCursorMode();
    const dpr = window.devicePixelRatio || 1, cw = this.el.clientWidth, ch = this.el.clientHeight, cv = this.canvas;
    if (cv.width !== Math.round(cw * dpr) || cv.height !== Math.round(ch * dpr)) { cv.width = Math.round(cw * dpr); cv.height = Math.round(ch * dpr); cv.style.width = cw + 'px'; cv.style.height = ch + 'px'; }
    const c = this.ctx; c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, cw, ch);
    c.save(); c.beginPath(); c.rect(0, 0, this.w, this.h); c.clip();
    this.hits.clear(); this.handlesOf.clear();
    const axis: Painter['axis'] = [];
    const tfKind = this.tf < 60 ? 'sec' : this.tf < 3600 ? 'min' : this.tf < 86400 ? 'hour' : 'day';
    const sel = this.store.get(ds.selected);
    if (!ds.hideAll) for (const d of st.items) {
      if (d.sym !== this.sym || d.hidden || (d.tfs.length && !d.tfs.includes(tfKind))) continue;
      const tool = TOOL[d.tool]; if (!tool) continue;
      const focus = d.id === ds.selected || d.id === this.hover, g = this.geo(focus), x = this.xyOf(d, g);
      const P = new Painter(c, this.w, this.h);
      try { tool.draw(P, d, x, g); } catch (e) { console.warn('drawing', d.tool, e); }
      this.hits.set(d.id, P.prims);
      this.handlesOf.set(d.id, tool.handles ? tool.handles(d, x, g) : x);
      axis.push(...P.axis);
    }
    // the drawing being placed, the measure, the zoom box
    if (this.placing) { const { tool, d } = this.placing, g = this.geo(true), P = new Painter(c, this.w, this.h); try { tool.draw(P, d, this.xyOf(d, g), g); } catch { /* not enough points yet */ } axis.push(...P.axis); for (const p of this.xyOf(d, g).slice(0, this.placing.fixed)) this.handle(p, d.style.color, false, false); }
    if (this.measure && this.measure.pts.length > 1) { const g = this.geo(true), md = { id: 'measure', tool: 'measure', sym: this.sym, pts: this.measure.pts, style: styleFor('dprange'), locked: false, hidden: false, tfs: [], created: 0 } as Drawing; MEASURE.draw(new Painter(c, this.w, this.h), md, this.xyOf(md, g), g); }
    if (this.zoomBox) { const { a, b } = this.zoomBox; c.fillStyle = hexA(C.accent, 0.12); c.strokeStyle = hexA(C.accent, 0.7); c.setLineDash([4, 3]); c.lineWidth = 1; c.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y)); c.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y)); c.setLineDash([]); }
    // handles of the selected and the hovered drawing
    for (const id of [this.hover, ds.selected]) {
      const d = this.store.get(id); if (!d || d.sym !== this.sym || d.hidden || ds.hideAll) continue;
      const hs = this.handlesOf.get(d.id) || [];
      hs.forEach((p, k) => this.handle(p, d.locked ? '#787b86' : C.accent, id === ds.selected && k === this.hoverH && this.hover === d.id, id !== ds.selected));
    }
    if (ds.tool === 'dot' && this.mouse && !this.busy) { c.beginPath(); c.arc(this.mouse.x, this.mouse.y, 2.5, 0, Math.PI * 2); c.fillStyle = C.fg; c.fill(); }
    c.restore();
    // axis labels: the ones tools asked for, then the selected drawing's range on both axes
    if (sel && sel.sym === this.sym && !sel.hidden && !TOOL[sel.tool]?.screen) {
      const g = this.geo(), hs = this.handlesOf.get(sel.id) || this.xyOf(sel, g);
      if (hs.length) {
        const ys = hs.map(p => p.y).filter(isFinite), xs = hs.map(p => p.x).filter(isFinite);
        c.fillStyle = hexA(C.accent, 0.18);
        if (ys.length) c.fillRect(this.w, Math.min(...ys), cw - this.w, Math.max(1, Math.max(...ys) - Math.min(...ys)));
        if (xs.length) c.fillRect(Math.min(...xs), this.h, Math.max(1, Math.max(...xs) - Math.min(...xs)), ch - this.h);
        for (const p of sel.pts) { axis.push({ k: 'p', at: g.y(p.p), text: g.fp(p.p), color: C.accent }); axis.push({ k: 't', at: g.x(p.t), text: g.ft(p.t), color: C.accent }); }
      }
    }
    c.font = '500 11px Inter, system-ui, sans-serif'; c.textBaseline = 'middle';
    for (const a of axis) {
      if (a.k === 'p') { if (a.at < 0 || a.at > this.h) continue; c.fillStyle = a.color; c.fillRect(this.w, a.at - 9, cw - this.w, 18); c.fillStyle = a.color === C.accent ? C.onAccent : '#fff'; c.textAlign = 'left'; c.fillText(a.text, this.w + 6, a.at); }
      else { if (a.at < 0 || a.at > this.w) continue; const tw = c.measureText(a.text).width + 12; c.fillStyle = a.color; c.fillRect(a.at - tw / 2, this.h, tw, ch - this.h); c.fillStyle = a.color === C.accent ? C.onAccent : '#fff'; c.textAlign = 'center'; c.fillText(a.text, a.at, this.h + (ch - this.h) / 2); }
    }
  }
  private handle(p: XY, color: string, big: boolean, faint: boolean) {
    if (!isFinite(p.x) || !isFinite(p.y)) return;
    const c = this.ctx; c.setLineDash([]); c.beginPath(); c.arc(p.x, p.y, big ? HANDLE_R + 1.5 : HANDLE_R, 0, Math.PI * 2);
    c.fillStyle = faint ? hexA(C.bg, 0.85) : C.bg; c.fill(); c.lineWidth = faint ? 1 : 1.6; c.strokeStyle = faint ? hexA(C.accent, 0.6) : color; c.stroke();
  }
  private applyCursorMode() {
    const mode = ds.tool === 'dot' || ds.tool === 'arrow' ? ds.tool : 'cross';
    if (mode === this.crossFor) return; this.crossFor = mode;
    const show = mode === 'cross';
    this.chart.applyOptions({ crosshair: { vertLine: { visible: show }, horzLine: { visible: show } } });
  }
  invalidate() { this.key = ''; }

  /* ---- hit testing ---- */
  private pos(e: MouseEvent): XY { const r = this.el.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  private inPane(p: XY) { return p.x >= 0 && p.y >= 0 && p.x < this.w && p.y < this.h; }
  hitTest(p: XY): string | null {
    const items = this.store.items;
    for (let i = items.length - 1; i >= 0; i--) { const d = items[i], pr = this.hits.get(d.id); if (pr && hitPrims(pr, p)) return d.id; }
    return null;
  }
  private handleAt(p: XY): { id: string; k: number } | null {
    for (const id of [ds.selected, this.hover]) {
      const hs = id && this.handlesOf.get(id); if (!hs) continue;
      for (let k = hs.length - 1; k >= 0; k--) if (dist(hs[k], p) <= HANDLE_R + 3) return { id, k };
    }
    return null;
  }

  /* ---- where a click lands: magnet, Shift for angles ---- */
  private toPt(p: XY, e: MouseEvent, tool: ToolDef | null, ref: XY | null, free = false): Pt {
    let { x, y } = p;
    if (tool?.screen) return { t: x / this.w, p: y / this.h };
    if (e.shiftKey && ref && tool?.angled) {
      const dx = x - ref.x, dy = y - ref.y, r = Math.hypot(dx, dy), a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      x = ref.x + r * Math.cos(a); y = ref.y + r * Math.sin(a);
      if (Math.abs(Math.sin(a)) < 1e-6) y = ref.y;
    }
    let l = this.logicalAtX(x); if (!free) l = Math.round(l);
    let price = this.series.coordinateToPrice(y) ?? 0;
    let mode = ds.magnet; if (e.ctrlKey || e.metaKey) mode = mode === 'off' ? 'strong' : 'off';
    if (mode !== 'off' && !free) {
      const t = this.tOf(Math.round(l)), bar = this.bars(t, t)[0];
      if (bar) {
        let best = price, bd = Infinity;
        for (const v of [bar.o, bar.h, bar.l, bar.c]) { const vy = this.series.priceToCoordinate(v); if (vy == null) continue; const dd = Math.abs(vy - y); if (dd < bd) { bd = dd; best = v; } }
        if (mode === 'strong' || bd < 30) price = best;
      }
    }
    return { t: this.tOf(l), p: price };
  }

  /* ---- the mouse ---- */
  down(e: MouseEvent): boolean {
    const p = this.pos(e); if (!this.inPane(p)) return false;
    this.mouse = p;
    if (e.button === 2) { if (this.placing) { this.cancel(); return true; } return false; }
    const toolId = ds.tool;
    if (this.placing || isDrawTool(toolId)) { this.placeDown(p, e); return true; }
    if (toolId === 'zoom') { this.zoomBox = { a: p, b: p }; return true; }
    if (this.measure?.done) { this.measure = null; this.invalidate(); if (toolId === 'measure') setDs({ tool: cursorTool() }); return true; }
    if (this.measure && !this.measure.done) { this.measure.pts[1] = this.toPt(p, e, null, null); this.measure.done = true; this.invalidate(); return true; }
    if (toolId === 'measure' || e.shiftKey) { const pt = this.toPt(p, e, null, null); this.measure = { pts: [pt, pt], done: false }; return true; }
    if (toolId === 'eraser') { const id = this.hitTest(p); if (id) { this.store.remove(id); this.hover = null; if (ds.selected === id) setDs({ selected: null }); } return true; }
    const h = this.handleAt(p), d = this.store.get(h?.id ?? null);
    if (h && d && !d.locked && h.id === ds.selected) { this.startDrag(d, h.k, p); return true; }
    const id = this.hitTest(p);
    if (id) {
      const d2 = this.store.get(id)!;
      if (ds.selected !== id) setDs({ selected: id });
      if (h && h.id === id && !d2.locked) this.startDrag(d2, h.k, p);
      else if (!d2.locked) this.startDrag(d2, 'body', p);
      return true;
    }
    if (ds.selected) setDs({ selected: null });
    return false;
  }
  private startDrag(d: Drawing, k: number | 'body', p: XY) {
    this.store.begin();
    this.drag = { id: d.id, k, l0: this.logicalAtX(p.x), p0: this.series.coordinateToPrice(p.y) ?? 0, at: p, orig: JSON.parse(JSON.stringify(d.pts)), moved: false };
  }
  move(e: MouseEvent) {
    const p = this.pos(e), inside = p.x >= 0 && p.y >= 0 && p.x < this.el.clientWidth && p.y < this.el.clientHeight;
    this.mouse = inside ? p : null;
    if (this.placing) {
      const pl = this.placing, t = pl.tool;
      if (t.n === 'free') { const last = this.geo().xy(pl.d.pts[pl.d.pts.length - 1]); if (dist(last, p) >= 2) pl.d.pts.push(this.toPt(p, e, t, null, true)); }
      else { const ref = pl.fixed > 0 ? this.xyOf(pl.d, this.geo())[pl.fixed - 1] : null; pl.d.pts[pl.d.pts.length - 1] = this.toPt(p, e, t, ref); }
      this.invalidate(); return;
    }
    if (this.zoomBox) { this.zoomBox.b = p; this.invalidate(); return; }
    if (this.measure && !this.measure.done) { this.measure.pts[1] = this.toPt(p, e, null, null); this.invalidate(); return; }
    if (this.drag) { this.dragTo(p, e); return; }
    // hovering
    if (!inside || !this.inPane(p)) { if (this.hover) { this.hover = null; this.hoverH = -1; } this.setCursor(''); return; }
    const h = this.handleAt(p), id = h?.id && this.hits.has(h.id) ? h.id : this.hitTest(p);
    this.hover = id; this.hoverH = h && h.id === id ? h.k : -1;
    const tool = ds.tool;
    this.setCursor(tool === 'eraser' ? (id ? 'eraser' : 'default') : isDrawTool(tool) || tool === 'measure' || tool === 'zoom' ? 'crosshair' : id ? (this.hoverH >= 0 ? 'grab' : 'pointer') : tool === 'dot' ? 'none' : tool === 'arrow' ? 'default' : '');
  }
  private dragTo(p: XY, e: MouseEvent) {
    const dg = this.drag!, d = this.store.get(dg.id); if (!d) { this.drag = null; return; }
    if (!dg.moved && dist(p, dg.at) < 3) return;
    dg.moved = true;
    const tool = TOOL[d.tool], g = this.geo();
    if (dg.k === 'body') {
      if (tool.screen) { const dx = (p.x - dg.at.x) / this.w, dy = (p.y - dg.at.y) / this.h; d.pts = dg.orig.map(q => ({ t: q.t + dx, p: q.p + dy })); }
      else {
        const dl = Math.round(this.logicalAtX(p.x) - dg.l0), dp = (this.series.coordinateToPrice(p.y) ?? dg.p0) - dg.p0;
        d.pts = dg.orig.map(q => ({ t: this.tOf(this.logical(q.t) + dl), p: q.p + dp }));
      }
      this.setCursor('grabbing');
    } else {
      const k = dg.k, x = this.xyOf(d, g), ref = x.length === 2 ? x[1 - k] ?? null : x[k - 1] ?? x[k + 1] ?? null;
      const pt = this.toPt(p, e, tool, ref);
      const handled = tool.drag?.(d, k, pt, g, p);
      if (!handled && k < d.pts.length) d.pts[k] = pt;
      this.setCursor('grabbing');
    }
    this.store.live(); this.invalidate();
  }
  up(e: MouseEvent) {
    const p = this.pos(e);
    if (this.placing) {
      const pl = this.placing;
      if (pl.tool.n === 'free') { this.finish(); return; }
      // press, drag, release: the second point goes where the mouse was let go
      if (pl.down && pl.fixed === 1 && dist(pl.down, p) > 6) { pl.down = null; this.placeDown(p, e); }
      else pl.down = null;
      return;
    }
    if (this.zoomBox) {
      const { a, b } = this.zoomBox; this.zoomBox = null; this.invalidate();
      if (Math.abs(b.x - a.x) > 8) { const ts = this.chart.timeScale(), r = ts.getVisibleLogicalRange(); if (r) this.zoomStack.push({ from: r.from, to: r.to }); ts.setVisibleLogicalRange({ from: this.logicalAtX(Math.min(a.x, b.x)), to: this.logicalAtX(Math.max(a.x, b.x)) }); }
      if (!ds.stay) setDs({ tool: cursorTool() });
      return;
    }
    if (this.drag) { this.drag = null; this.store.commit(); this.invalidate(); }
  }
  dbl(e: MouseEvent): boolean {
    const p = this.pos(e); if (!this.inPane(p)) return false;
    // the double-click that finished a path is not a request for its settings
    if (this.placing || performance.now() - this.finishedAt < 500) return true;
    const id = this.hitTest(p); if (!id) return false;
    setDs({ selected: id, editing: { id, tab: 'style' } });
    return true;
  }
  context(e: MouseEvent): boolean {
    const p = this.pos(e); if (!this.inPane(p)) return false;
    if (this.placing) { this.cancel(); return true; }
    const id = this.hitTest(p); if (!id) return false;
    setDs({ selected: id }); this.onMenu?.(p.x, p.y, id);
    return true;
  }
  private setCursor(c: string) { if (this.el.dataset.cur !== c) this.el.dataset.cur = c; }

  /* ---- placing ---- */
  private draft(tool: ToolDef, pts: Pt[]): Drawing {
    return { id: 'draft', tool: tool.id, sym: this.sym, pts, style: styleFor(tool.id, templates()[tool.id]), locked: false, hidden: false, tfs: [], created: 0 };
  }
  private placeDown(p: XY, e: MouseEvent) {
    const tool = this.placing?.tool || TOOL[ds.tool];
    if (!tool) return;
    if (!this.placing) {
      if (ds.selected) setDs({ selected: null });
      if (tool.n === 'free') { this.placing = { tool, d: this.draft(tool, [this.toPt(p, e, tool, null, true)]), fixed: 0, down: p, lastClick: null }; return; }
      const pt = this.toPt(p, e, tool, null);
      this.placing = { tool, d: this.draft(tool, tool.n === 1 ? [pt] : [pt, { ...pt }]), fixed: 1, down: p, lastClick: { at: performance.now(), p } };
      if (tool.n === 1) this.finish();
      this.invalidate();
      return;
    }
    const pl = this.placing, now = performance.now(), x = this.xyOf(pl.d, this.geo());
    if (tool.n === 'path') {
      const dbl = pl.lastClick && now - pl.lastClick.at < 350 && dist(pl.lastClick.p, p) < 6;
      const closing = tool.id === 'polyline' && pl.fixed >= 3 && dist(x[0], p) < 8;
      if (dbl || closing) { if (closing) pl.d.style.opt.closed = true; if (dbl) this.finishedAt = now; this.finish(); return; }
      pl.d.pts[pl.fixed] = this.toPt(p, e, tool, x[pl.fixed - 1]); pl.fixed++; pl.d.pts.push({ ...pl.d.pts[pl.fixed - 1] });
      pl.lastClick = { at: now, p };
      this.invalidate(); return;
    }
    pl.d.pts[pl.fixed] = this.toPt(p, e, tool, x[pl.fixed - 1]); pl.fixed++;
    pl.lastClick = { at: now, p };
    if (pl.fixed >= (tool.n as number)) this.finish();
    else pl.d.pts.push({ ...pl.d.pts[pl.fixed - 1] });
    this.invalidate();
  }
  /** done placing: the drawing is added and selected, and the tool goes back to the cursor */
  finish() {
    const pl = this.placing; if (!pl) return;
    this.placing = null;
    const { tool, d } = pl;
    if (tool.n === 'path') d.pts = d.pts.slice(0, Math.max(pl.fixed, 1));
    else if (typeof tool.n === 'number') d.pts = d.pts.slice(0, tool.n);
    if ((tool.n === 'path' && d.pts.length < 2) || (tool.n === 'free' && d.pts.length < 2)) { this.invalidate(); return; }
    tool.init?.(d, this.geo());
    const { id: _id, created: _c, ...rest } = d; void _id; void _c;
    const nd = this.store.add(rest);
    setDs({ selected: nd.id, tool: ds.stay ? ds.tool : cursorTool(), editing: tool.editText ? { id: nd.id, tab: 'text' } : ds.editing });
    this.invalidate();
  }
  cancel() { this.placing = null; this.measure = null; this.zoomBox = null; this.invalidate(); }
  zoomOut() {
    const r = this.zoomStack.pop(), ts = this.chart.timeScale();
    if (r) ts.setVisibleLogicalRange(r); else { ts.applyOptions({ barSpacing: 6 }); ts.scrollToRealTime(); }
  }
}
