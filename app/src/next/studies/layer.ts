// The study layer of one chart: price zones and session lines, on a canvas under the drawings and over the candles.
// It redraws only when something it shows changed (new zones, the settings, scrolling or zooming, the price scale),
// so it costs nothing on most frames while the tape plays. Times map to x through the drawing layer's logical
// indices, which cope with the gaps (nights, weekends) the chart leaves out.
import type { IChartApi, ISeriesApi, Logical } from 'lightweight-charts';
import type { Feed } from '../../core/feed';
import { parseTF, tfLabel, tfSeconds, tfValid, type TF } from '../../core/time';
import { ZoneFinder, TfCandles, shownZones, zoneLabel, type Bar, type Zone } from '../../core/zones';
import { sessionRanges, sessionsVisible } from '../../core/sessions-studies';
import { ds } from '../draw/state';
import { sessShown, studies, toggleZones, zonesShown } from './prefs';

/** time <-> logical index (the drawing layer has these) */
export interface TimeMap { logical(t: number): number; tOf(l: number): number }

const hexA = (hex: string, a: number) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; };
const FONT = '10px "JetBrains Mono", Consolas, monospace';

/** every chart's study layer */
export const studyLayers = new Set<StudyLayer>();

export class StudyLayer {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private key = '';
  private finder: ZoneFinder | null = null;
  private fKey = '';
  private fSrc: Bar[] | null = null;
  private fGen = 0;
  private agg: TfCandles | null = null;
  private aggKey = '';
  private blank = true;
  /** what the last redraw showed */
  drawn = { zones: 0, sessions: 0 };

  constructor(private el: HTMLElement, private chart: IChartApi, private series: ISeriesApi<'Candlestick'>, private feed: Feed, private map: TimeMap, private onToast?: (m: string) => void) {
    const cv = this.canvas = document.createElement('canvas');
    cv.className = 'studylayer';
    cv.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;z-index:2';
    // under the drawings: same stacking level, earlier in the page
    const dl = el.querySelector(':scope > .drawlayer');
    if (dl) el.insertBefore(cv, dl); else el.appendChild(cv);
    this.ctx = cv.getContext('2d')!;
    if (!studyLayers.size) addEventListener('keydown', onKey);
    studyLayers.add(this);
  }
  dispose() {
    studyLayers.delete(this); this.canvas.remove();
    if (!studyLayers.size) removeEventListener('keydown', onKey);
  }
  toast(m: string) { this.onToast?.(m); }

  /* ---- zones: from finished candles of the zone timeframe only ---- */
  private zoneTf(): TF {
    const z = studies.zones, tf = z.tf === 'chart' ? null : parseTF(z.tf);
    return tf && tfValid(tf, this.feed.s.base) ? tf : this.feed.tf;
  }
  private zoneCandles(tf: TF): Bar[] {
    const f = this.feed, label = tfLabel(tf);
    if (label === tfLabel(f.tf)) { this.agg = null; return f.candles; }
    // bars before f.i have been played in full; the bar playing now is not used until it closes
    const key = `${label}|${f.s.id}|${f.version}`;
    if (!this.agg || this.aggKey !== key || f.i < this.agg.i) { this.agg = new TfCandles(f.s, tf, f.i); this.aggKey = key; }
    return this.agg.advance(f.i);
  }
  private updateZones(): ZoneFinder {
    const z = studies.zones, tf = this.zoneTf(), cs = this.zoneCandles(tf);
    const key = `${tfLabel(tf)}|${z.swing}|${z.minTicks}|${this.feed.tick}|${cs.length ? cs[0].time : 0}`;
    if (!this.finder || this.fKey !== key || this.fSrc !== cs || cs.length < this.finder.n) {
      this.finder = new ZoneFinder(z.swing, z.minTicks * this.feed.tick); this.fKey = key; this.fSrc = cs; this.fGen++;
    }
    this.finder.update(cs);
    return this.finder;
  }

  /* ---- drawing ---- */
  render() {
    const zOn = zonesShown(), sOn = sessShown();
    if (!zOn && !sOn) { if (!this.blank) this.clear(); return; }
    const zf = zOn ? this.updateZones() : null;
    const f = this.feed, F = f.F, c0 = f.candles, ps = this.chart.paneSize(), w = ps.width, h = ps.height;
    const ts = this.chart.timeScale(), a = ts.logicalToCoordinate(0 as Logical), b = ts.logicalToCoordinate(1 as Logical);
    const x0 = a ?? 0, bs = a != null && b != null ? b - a : 6, s = this.series;
    const nT = c0.length + (F && (!c0.length || F.time > c0[c0.length - 1].time) ? 1 : 0);
    const key = [studies.ver, zf ? `${this.fGen},${zf.version}` : '', sOn ? f.version : '', x0.toFixed(2), bs.toFixed(4), s.priceToCoordinate(0)?.toFixed(2), s.priceToCoordinate(1000)?.toFixed(3),
      w, h, nT, this.el.clientWidth, this.el.clientHeight].join('|');
    if (key === this.key) return;
    this.key = key; this.blank = false;
    const dpr = window.devicePixelRatio || 1, cw = this.el.clientWidth, ch = this.el.clientHeight, cv = this.canvas;
    if (cv.width !== Math.round(cw * dpr) || cv.height !== Math.round(ch * dpr)) { cv.width = Math.round(cw * dpr); cv.height = Math.round(ch * dpr); cv.style.width = cw + 'px'; cv.style.height = ch + 'px'; }
    const g = this.ctx; g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, cw, ch);
    const X = (t: number) => x0 + this.map.logical(t) * bs, Y = (p: number) => s.priceToCoordinate(p);
    const n = { zones: 0, sessions: 0 };
    g.save(); g.beginPath(); g.rect(0, 0, w, h); g.clip();
    if (sOn) n.sessions = this.drawSessions(g, X, w, h);
    if (zf) n.zones = this.drawZones(g, zf.zones, X, Y, w);
    g.restore();
    this.drawn = n;
    cv.dataset.zones = String(n.zones); cv.dataset.sessions = String(n.sessions);
  }
  private clear() {
    const cv = this.canvas; this.ctx.setTransform(1, 0, 0, 1, 0, 0); this.ctx.clearRect(0, 0, cv.width, cv.height);
    this.blank = true; this.key = ''; this.drawn = { zones: 0, sessions: 0 }; cv.dataset.zones = cv.dataset.sessions = '0';
  }
  /** a dashed line at each open, the session shaded to its close if asked, its name at the bottom */
  private drawSessions(g: CanvasRenderingContext2D, X: (t: number) => number, pw: number, ph: number): number {
    const sp = studies.sess, lr = this.chart.timeScale().getVisibleLogicalRange(); if (!lr) return 0;
    const t0 = this.map.tOf(lr.from), t1 = this.map.tOf(lr.to);
    if (!sessionsVisible(tfSeconds(this.feed.tf), t0, t1)) return 0;
    g.lineWidth = 1; g.font = FONT; g.textBaseline = 'alphabetic'; g.textAlign = 'left';
    let n = 0;
    for (const { s, o, c } of sessionRanges(sp.sessions, t0, t1)) {
      const xo = X(o);
      if (sp.shade && c > o) { const xc = X(c); g.fillStyle = hexA(s.color, 0.07); g.fillRect(xo, 0, xc - xo, ph); n++; }
      if (xo < 0 || xo > pw) continue;
      g.strokeStyle = hexA(s.color, 0.85); g.setLineDash([4, 4]);
      g.beginPath(); g.moveTo(Math.round(xo) + 0.5, 0); g.lineTo(Math.round(xo) + 0.5, ph); g.stroke();
      if (sp.labels) { g.setLineDash([]); g.fillStyle = s.color; g.fillText(s.name, xo + 4, ph - 6); }
      n++;
    }
    g.setLineDash([]);
    return n;
  }
  /** boxes from where each zone formed to where it ended (or the right edge), the newest few of each kind */
  private drawZones(g: CanvasRenderingContext2D, zones: Zone[], X: (t: number) => number, Y: (p: number) => number | null, pw: number): number {
    const z = studies.zones, tag = z.tf === 'chart' ? '' : tfLabel(this.zoneTf()) + ' ';
    g.font = FONT; g.textBaseline = 'top'; g.textAlign = 'left'; g.lineWidth = 1;
    let n = 0;
    for (const q of shownZones(zones, z)) {
      const st = z[q.type], x0 = X(q.t0), x1 = q.t1 != null ? X(q.t1) : pw, yT = Y(q.top), yB = Y(q.bot);
      if (yT == null || yB == null || !isFinite(x0) || !isFinite(x1) || x1 < 0 || x0 > pw) continue;
      const col = q.dir > 0 ? st.up : st.dn, done = q.t1 != null;
      g.fillStyle = hexA(col, done ? 0.06 : 0.15); g.fillRect(x0, yT, x1 - x0, yB - yT);
      g.strokeStyle = hexA(col, done ? 0.3 : 0.65); g.setLineDash(q.type === 'bpr' ? [4, 3] : done ? [2, 3] : []);
      g.strokeRect(Math.round(x0) + 0.5, Math.round(yT) + 0.5, Math.round(x1 - x0), Math.round(yB - yT));
      if (q.flipT != null) { // where the FVG or order block flipped
        const xf = X(q.flipT);
        if (xf > x0 && xf < x1) { g.setLineDash([2, 3]); g.beginPath(); g.moveTo(Math.round(xf) + 0.5, yT); g.lineTo(Math.round(xf) + 0.5, yB); g.stroke(); }
      }
      if (z.labels && x1 - x0 > 40) { g.fillStyle = col; g.fillText(zoneLabel(q, tag), Math.max(x0, 0) + 3, yB - yT >= 12 ? yT + 2 : yT - 11); }
      n++;
    }
    g.setLineDash([]);
    return n;
  }
}

// Z shows or hides the price zones, from any chart (not while typing, in a dialog, or with Ctrl, Cmd or Alt held)
function onKey(e: KeyboardEvent) {
  if (e.key !== 'z' && e.key !== 'Z') return;
  if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
  const t = e.target as HTMLElement;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
  if (ds.editing || document.querySelector('.modal')) return;
  const on = toggleZones();
  studyLayers.values().next().value?.toast(on ? 'Price zones on.' : 'Price zones off.');
}
