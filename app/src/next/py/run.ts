// The indicators people write (Python or JavaScript) on one chart, run in their workers (Python's, or the JS one). Each one sees the chart's closed candles once each,
// oldest first, never the candle forming now: at most the newest 40,000 (8,000 on touch screens) when it starts, then
// each new candle as it closes. While the tape plays fast the candles that closed meanwhile go together, one request
// in flight per indicator, so the page never waits for Python. It starts again from scratch when the candles are
// rebuilt differently (a new timeframe or time zone, a step or jump back) and when its code or settings change.
import type { Feed } from '../../core/feed';
import type { Candle } from '../../core/series';
import { tfLabel, tfSeconds, zone, zoneOff } from '../../core/time';
import { pyCall, pyLibs, pyLoad } from './client';
import { jsCall, jsStuck, jsWorker } from './jsclient';
import { pyBusy, pyErrs, pyLog } from './console';
import { pyInds, pyState, type PyInd } from './prefs';
import { bump } from '../live';

export interface Meta { title: string; style: string; pane: string; width: number; color: string | null }
export interface Plot { m: Meta; base: string; t: number[]; v: Array<number | null>; c: Array<string | null> }
export interface HLine { price: number; title: string | null; color: string; width: number; style: string; pane: string }
export interface Fill { a: string; b: string; t: number[]; va: number[]; vb: number[]; c: Array<string | null> }
export type Mark = [number, string, string, string, string, number];
export interface PyDraw { id: number; kind: 'box' | 'line' | 'label'; [k: string]: unknown }
interface Out { meta?: Meta[]; plots?: Record<string, Array<[number, number | null, string?]>>; hlines?: HLine[]; fills?: Array<[string, string, Array<[number, number, number, string | null]>]>;
  bg?: Array<[number, string]>; marks?: Mark[]; draw?: PyDraw[]; del?: number[]; error?: string }

/** the classic app's indicator colors: a plot without a color takes the next one */
const COLORS = ['#e2a63c', '#7f9cf5', '#2db38a', '#e5554c', '#c158dc', '#26c6da'];
let nextIid = 1, bumpT = 0, lastToast = '';
/** the legend and the lists again soon (not on every answer while the tape plays fast) */
const soon = () => { if (!bumpT) bumpT = window.setTimeout(() => { bumpT = 0; bump(); }, 200); };

/** one indicator running on one chart */
export class Inst {
  iid = 'p' + nextIid++;
  started = false; busy = false; err: string | null = null;
  /** the candles it is fed from, the last one fed (time and values), how many so far */
  arr: Candle[] | null = null; lastT = -Infinity; last: Candle | null = null; fed = 0; zk = '';
  plots = new Map<string, Plot>(); hl: HLine[] = []; fills = new Map<string, Fill>(); bg = { t: [] as number[], c: [] as string[] };
  marks: Mark[] = []; draws = new Map<number, PyDraw>();
  /** bumps whenever what it draws changed */
  ver = 0;
  /** JavaScript indicators: the worker it was started in (a stuck worker is replaced, and its indicators start again) */
  gen = -1;
  get js() { return this.x.lang === 'js'; }
  constructor(readonly x: PyInd) {}
  get name() { return this.x.name; }
  get lower() { for (const p of this.plots.values()) if (p.m.pane === 'lower') return true; return false; }
}

const same = (a: Candle, b: Candle) => a.time === b.time && a.o === b.o && a.h === b.h && a.l === b.l && a.c === b.c && a.v === b.v;
/** the first candle after time t */
const after = (c: Candle[], t: number) => { let a = 0, b = c.length; while (a < b) { const m = (a + b) >> 1; if (c[m].time <= t) a = m + 1; else b = m; } return a; };

export class PyRun {
  list: Inst[] = [];
  /** bumps when an indicator starts, stops or draws something new */
  ver = 0;
  marksVer = 0;
  private listVer = -1;
  private chunk = 1024;
  private dead = false;
  private total = new Map<Inst, { n: number; t0: number }>();
  constructor(private feed: Feed, private onToast?: (m: string, k?: string) => void) {}

  private get cap() { return document.documentElement.classList.contains('touch') ? 8000 : 40000; }
  private get zk() { return `${tfLabel(this.feed.tf)}|${zone.id}|${zone.dayStart}`; }

  /** called on every frame: picks up changes to the list, and sends each indicator the candles that closed */
  pump() {
    if (this.dead) return;
    if (pyState.ver !== this.listVer) this.sync();
    for (const ins of this.list) this.step(ins);
  }
  dispose() { this.dead = true; for (const ins of this.list) this.stop(ins); this.list = []; }

  /** the indicators shown: unchanged ones keep running, new or changed ones start */
  private sync() {
    this.listVer = pyState.ver;
    const want = pyInds().filter(x => x.on), keep: Inst[] = [];
    for (const x of want) {
      const old = this.list.find(i => i.x.id === x.id && i.x.code === x.code && i.x.name === x.name);
      if (!old) { pyErrs.delete(x.name); jsStuck.delete(x.name); }
      keep.push(old || new Inst(x));
    }
    for (const ins of this.list) if (!keep.includes(ins)) this.stop(ins);
    this.list = keep; this.ver++; this.marksVer++;
  }
  private stop(ins: Inst) {
    if (ins.started) (ins.js ? jsCall('_ti_stop', [ins.iid]) : pyCall('_ti_stop', [ins.iid])).catch(() => {});
    ins.started = false; this.total.delete(ins); pyBusy.delete(ins.name);
  }
  /** the same indicator again from scratch (a new instance in Python) */
  private restart(ins: Inst) {
    const k = this.list.indexOf(ins); if (k < 0) return;
    this.stop(ins);
    const n = new Inst(ins.x); this.list[k] = n; this.ver++; this.marksVer++;
    if (ins.err) pyErrs.delete(ins.name);
    return n;
  }

  private step(ins: Inst) {
    if (ins.busy) return;
    const f = this.feed, zk = this.zk;
    if (!ins.started) { if (!ins.err) this.start(ins, zk); return; }
    // its worker was replaced (another script got stuck): start again
    if (ins.js && ins.gen !== jsWorker.gen) { const n = this.restart(ins); if (n) this.start(n, zk); return; }
    // the candles were rebuilt: carry on if the last one fed is still there unchanged, else start again (one that
    // stopped with an error gets another go too)
    if (f.candles !== ins.arr || zk !== ins.zk) {
      let ok = zk === ins.zk && ins.fed > 0 && !!ins.last;
      if (ok) { const j = after(f.candles, ins.lastT) - 1; ok = j >= 0 && same(f.candles[j], ins.last!); }
      if (!ok) { const n = this.restart(ins); if (n) this.start(n, zk); return; }
      ins.arr = f.candles;
    }
    if (ins.err) return;
    const arr = ins.arr!, j = after(arr, ins.lastT), left = arr.length - j;
    if (left <= 0) return;
    // far behind (skipped a long way ahead): start over on the newest candles
    if (left > this.cap && ins.fed > 0) { const n = this.restart(ins); if (n) this.start(n, zk); return; }
    this.send(ins, arr, j, Math.min(left, this.chunk));
  }
  private start(ins: Inst, zk: string) {
    const f = this.feed, inst = f.s.inst, arr = f.candles;
    ins.started = true; ins.busy = true; ins.arr = arr; ins.zk = zk;
    const from = Math.max(0, arr.length - this.cap);
    ins.lastT = from > 0 ? arr[from - 1].time : -Infinity;
    const info = { name: inst.name, tf: tfLabel(f.tf), tfs: tfSeconds(f.tf), tick: inst.tick, pv: inst.pv, prec: inst.prec };
    ins.gen = jsWorker.gen;
    // stopped for taking too long (on this chart or another): not again until its code changes
    if (ins.js && jsStuck.has(ins.name)) { ins.busy = false; this.fail(ins, jsStuck.get(ins.name)!, false); return; }
    (ins.js ? jsCall<string>('_ti_start', [ins.iid, ins.x.code, JSON.stringify(info)], { tag: ins.name })
      : pyLoad(pyLibs(ins.x.code)).then(() => pyCall<string>('_ti_start', [ins.iid, ins.x.code, JSON.stringify(info)], { tag: ins.name, libs: pyLibs(ins.x.code) })))
      .then(r => { ins.busy = false; if (this.live(ins)) this.apply(ins, JSON.parse(r)); })
      .catch((e: Error & { restart?: boolean }) => { ins.busy = false; if (!this.live(ins) || e.restart) return; this.fail(ins, e.message, !ins.js); });
  }
  private live(ins: Inst) { return !this.dead && this.list.includes(ins) && ins.started; }
  private send(ins: Inst, arr: Candle[], j: number, k: number) {
    const buf = new Float64Array(7 * k);
    for (let q = 0; q < k; q++) {
      const b = arr[j + q], o = 7 * q;
      buf[o] = b.time; buf[o + 1] = b.o; buf[o + 2] = b.h; buf[o + 3] = b.l; buf[o + 4] = b.c; buf[o + 5] = b.v || 0; buf[o + 6] = zoneOff(b.time);
    }
    const end = arr[j + k - 1];
    ins.busy = true; ins.lastT = end.time; ins.last = { ...end }; ins.fed += k;
    const left = arr.length - j - k;
    // progress, for a long catch-up
    let tot = this.total.get(ins);
    if (!tot && left + k > 2000) this.total.set(ins, tot = { n: left + k, t0: performance.now() });
    if (tot) { if (left) pyBusy.set(ins.name, `Running on ${tot.n.toLocaleString('en-US')} candles… ${Math.round((1 - left / tot.n) * 100)}%`); else { this.total.delete(ins); pyBusy.delete(ins.name); } soon(); }
    const t0 = performance.now();
    (ins.js ? jsCall<string>('_ti_feed', [ins.iid, buf], { tag: ins.name, transfer: [buf.buffer] }) : pyCall<string>('_ti_feed', [ins.iid, buf], { tag: ins.name, transfer: [buf.buffer] }))
      .then(r => {
        ins.busy = false;
        // a bigger batch next time while Python keeps up, a smaller one when it takes long
        const dt = performance.now() - t0;
        if (k >= this.chunk) this.chunk = dt < 60 ? Math.min(8192, this.chunk * 2) : dt > 200 ? Math.max(128, this.chunk >> 1) : this.chunk;
        if (this.live(ins)) this.apply(ins, JSON.parse(r));
      })
      .catch((e: Error & { restart?: boolean }) => { ins.busy = false; if (this.live(ins) && !e.restart) this.fail(ins, e.message, false); });
  }
  private fail(ins: Inst, err: string, load: boolean) {
    if (ins.err) return;
    ins.err = err; ins.ver++; this.ver++; pyErrs.set(ins.name, err); pyBusy.delete(ins.name); soon();
    // said once, not once per chart
    const said = `${ins.name}|${err}`;
    if (said === lastToast) return;
    lastToast = said; setTimeout(() => { if (lastToast === said) lastToast = ''; }, 3000);
    if (load) { pyLog(ins.name, err, 'er'); this.onToast?.('Python did not load, so the Python indicators are not shown.', 'err'); return; }
    pyLog(ins.name, `${ins.name} stopped:\n${err}`, 'er');
    this.onToast?.(`${ins.name} stopped: ${err.split('\n')[0]}`, 'err');
  }

  /** what Python sent: added to what the indicator draws */
  private apply(ins: Inst, o: Out) {
    let any = false;
    if (o.meta) for (const m of o.meta) { ins.plots.set(m.title, { m, base: m.color || COLORS[(ins.plots.size + 2) % COLORS.length], t: [], v: [], c: [] }); any = true; }
    if (o.plots) for (const [k, pts] of Object.entries(o.plots)) {
      const p = ins.plots.get(k); if (!p) continue;
      for (const q of pts) {
        const last = p.t.length - 1;
        if (last >= 0 && p.t[last] === q[0]) { p.v[last] = q[1]; p.c[last] = q[2] ?? null; }
        else { p.t.push(q[0]); p.v.push(q[1]); p.c.push(q[2] ?? null); }
      }
      any = true;
    }
    if (o.hlines) { ins.hl = o.hlines; any = true; }
    if (o.fills) for (const [a, b, pts] of o.fills) {
      const key = a + '\u0000' + b;
      let f = ins.fills.get(key);
      if (!f) ins.fills.set(key, f = { a, b, t: [], va: [], vb: [], c: [] });
      for (const q of pts) { f.t.push(q[0]); f.va.push(q[1]); f.vb.push(q[2]); f.c.push(q[3]); }
      any = true;
    }
    if (o.bg && o.bg.length) { for (const q of o.bg) { ins.bg.t.push(q[0]); ins.bg.c.push(q[1]); } any = true; }
    if (o.marks && o.marks.length) { ins.marks.push(...o.marks); if (ins.marks.length > 6000) ins.marks.splice(0, ins.marks.length - 3000); this.marksVer++; any = true; }
    if (o.draw) { for (const d of o.draw) ins.draws.set(d.id, d); any = true; }
    if (o.del) { for (const id of o.del) ins.draws.delete(id); any = true; }
    if (any) { ins.ver++; this.ver++; soon(); }
    if (o.error) this.fail(ins, o.error, false);
  }
}
