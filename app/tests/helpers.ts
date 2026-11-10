// Shared by the backtest tests and the benchmark: small deterministic series on a tick grid, Python in Node.
import type { Instrument, Series } from '../src/core/series';
import { pythonHost, type PyHost } from '../src/core/pybridge';

// Node's modules, without @types/node in the project
const node = (m: string): Promise<any> => import(m);
export const { readFileSync, writeFileSync } = await node('fs');
export const APP = decodeURIComponent(new URL('..', import.meta.url).pathname);

export let passed = 0;
export const check = (c: unknown, m: string) => { if (!c) throw new Error('FAILED: ' + m); passed++; };
export const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;

export const INST: Instrument = { sym: 'TST', name: 'Test market', tick: 0.25, pv: 20, prec: 2, comm: 2, spreadTicks: 1, slipTicks: 1 };

/** a series from rows [t, o, h, l, c, v] */
export function series(rows: number[][], inst: Instrument = INST, base = 60): Series {
  const col = (j: number) => Float64Array.from(rows, r => r[j]);
  return { id: 'test', inst, n: rows.length, t: col(0), o: col(1), h: col(2), l: col(3), c: col(4), v: col(5), base, hasVol: true, synthetic: true };
}
const mulberry = (seed: number) => { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
/** a random walk of n bars on the 0.25 grid with trends now and then, from UTC t0, every `base` seconds */
export function walk(n: number, seed = 7, t0 = Date.UTC(2026, 0, 5, 14, 30) / 1000, base = 60, inst: Instrument = INST): Series {
  const r = mulberry(seed), rows: number[][] = [];
  let p = 1000, drift = 0;
  for (let i = 0; i < n; i++) {
    if (i % 200 === 0) drift = (r() - 0.5) * 0.6;
    const o = p, steps = 1 + Math.floor(r() * 8);
    let h = o, l = o, c = o;
    for (let k = 0; k < steps; k++) { c += Math.round((r() - 0.5 + drift * 0.3) * 4) * 0.25; if (c > h) h = c; if (c < l) l = c; }
    rows.push([t0 + i * base, o, h, l, c, Math.round(r() * 100)]);
    p = c + (r() < 0.05 ? Math.round((r() - 0.5) * 8) * 0.25 : 0); // a gap now and then
  }
  return series(rows, inst, base);
}

let host: Promise<PyHost> | null = null;
/** Pyodide from public/pyodide (npm run pyodide), with runtime.py and runner.py, shared by the tests */
export function python(): Promise<PyHost> {
  return host ||= (async () => {
    const base = APP + 'public/pyodide/';
    // pyodide.asm.js expects CommonJS globals when it runs in Node
    (globalThis as any).require = (await node('module')).createRequire(import.meta.url); (globalThis as any).__dirname = base;
    const { loadPyodide } = await import(base + 'pyodide.mjs');
    const py = await loadPyodide({ indexURL: base });
    return pythonHost(py, readFileSync(APP + 'src/python/runtime.py', 'utf8'), readFileSync(APP + 'src/python/runner.py', 'utf8'));
  })();
}
