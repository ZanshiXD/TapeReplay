// Opening the Library's data for a replay: a data file (from its cached copy when there is one, else read and then
// cached), or a section of a long series kept in monthly blocks (the apps' built-in data and DBN imports).
import { cacheKey, censusFromJSON, censusToJSON, defaultPick, fromBin, readSource, toBlob, type Census, type Parsed, type Source } from './data';
import type { DatasetMeta, SeriesIndex, Store } from './store';

export type Progress = (f: number, step: string) => void;
/** what a data file holds: its bars (or, for a long series, only its index) and its contracts */
export interface Opened {
  meta: DatasetMeta;
  /** null for a long series: load a section with loadSection() */
  d: Parsed | null;
  index: SeriesIndex | null;
  C: Census | null;
  pick: string;
  /** contract names, for the instrument */
  contracts: string[];
  prec: number;
  base: number;
  from: number;
  to: number;
}

/** bars one section may hold: phones have far less memory than a PC */
export const MAX_BARS = typeof window !== 'undefined' && (window as unknown as { TAPE_IOS?: boolean }).TAPE_IOS ? 12e6 : 40e6;

export async function openDataset(store: Store, meta: DatasetMeta, pick: string | null, progress?: Progress): Promise<Opened> {
  if (meta.chunked) {
    const index = await store.seriesIndex(meta.id);
    return { meta, d: null, index, C: null, pick: '', contracts: [index.symbol || '', ...(index.rolls || []).map(r => r[1])].filter(Boolean), prec: index.prec, base: index.base, from: index.from, to: index.to };
  }
  let C: Census | null = null;
  const j = await store.getCensus(meta.id); if (j) C = censusFromJSON(j);
  if (pick == null) pick = defaultPick(C);
  const hit = await store.getCache(meta.id, cacheKey(pick)).catch(() => null);
  if (hit) {
    progress?.(1, 'Opening the saved copy');
    const d = fromBin(hit);
    return { meta, d, index: null, C, pick, contracts: C ? C.list.map(x => x.sym) : [], prec: d.prec, base: d.base, from: d.t[0], to: d.t[d.n - 1] };
  }
  return readInto(store, store.datasetSource(meta), meta, C, pick, progress);
}
/** reads a source and keeps the parsed copy (and the contract list) with the Library entry */
export async function readInto(store: Store | null, src: Source, meta: DatasetMeta, C: Census | null, pick: string | null, progress?: Progress): Promise<Opened> {
  const r = await readSource(src, { C, pick, onProgress: progress });
  if (store && meta.id) {
    if (r.C) await store.putCensus(meta.id, censusToJSON(r.C)).catch(() => {});
    await store.putCache(meta.id, cacheKey(r.pick), toBlob(r.d)).catch(() => {});
  }
  const contracts = r.C ? r.C.list.map(x => x.sym) : r.names;
  return { meta, d: r.d, index: null, C: r.C, pick: r.pick, contracts, prec: r.d.prec, base: r.d.base, from: r.d.t[0], to: r.d.t[r.d.n - 1] };
}

const lowerBound = (a: Float64Array, x: number) => { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < x) lo = m + 1; else hi = m; } return lo; };

/** bars a section of a long series would hold (from the monthly block sizes) */
export function sectionBars(ix: SeriesIndex, t0: number, t1: number) {
  return ix.blocks.reduce((s, b) => s + (b.t1 < t0 || b.t0 > t1 ? 0 : b.n * Math.min(1, (Math.min(b.t1, t1) - Math.max(b.t0, t0)) / Math.max(1, b.t1 - b.t0))), 0);
}
/** the bars between t0 and t1 of a long series, one month at a time */
export async function loadSection(store: Store, dsId: string, ix: SeriesIndex, t0: number, t1: number, progress?: Progress): Promise<Parsed> {
  const blocks = ix.blocks.map((b, i) => ({ ...b, i })).filter(b => b.t1 >= t0 && b.t0 <= t1);
  if (!blocks.length) throw new Error('There are no bars in that date range.');
  const cap = blocks.reduce((s, b) => s + b.n, 0);
  if (cap > MAX_BARS * 1.1) throw new Error('That span is too long to load at once. Pick a shorter span or less history.');
  const t = new Float64Array(cap), o = new Float32Array(cap), h = new Float32Array(cap), l = new Float32Array(cap), c = new Float32Array(cap), v = new Float32Array(cap);
  let k = 0;
  for (const [j, b] of blocks.entries()) {
    progress?.(j / blocks.length, `Month ${j + 1} of ${blocks.length}`);
    const buf = await store.seriesBlock(dsId, b.i), n = b.n;
    const bt = new Float64Array(buf, 0, n), col = (i: number) => new Float32Array(buf, n * 8 + i * n * 4, n);
    const lo = lowerBound(bt, t0), hi = lowerBound(bt, t1 + 1), m = hi - lo;
    if (m <= 0) continue;
    t.set(bt.subarray(lo, hi), k); o.set(col(0).subarray(lo, hi), k); h.set(col(1).subarray(lo, hi), k);
    l.set(col(2).subarray(lo, hi), k); c.set(col(3).subarray(lo, hi), k); v.set(col(4).subarray(lo, hi), k);
    k += m;
  }
  if (k < 2) throw new Error('There are no bars in that date range.');
  return { n: k, t: t.subarray(0, k), o: o.subarray(0, k), h: h.subarray(0, k), l: l.subarray(0, k), c: c.subarray(0, k), v: v.subarray(0, k), base: ix.base, prec: ix.prec, bad: 0, hasVol: ix.hasVol };
}
/** a parsed file cut to the bars between t0 and t1 (no copy) */
export function slice(d: Parsed, t0: number, t1: number): Parsed {
  const a = lowerBound(d.t, t0), b = lowerBound(d.t, t1 + 1);
  return { ...d, n: b - a, t: d.t.subarray(a, b), o: d.o.subarray(a, b), h: d.h.subarray(a, b), l: d.l.subarray(a, b), c: d.c.subarray(a, b), v: d.v.subarray(a, b) };
}
