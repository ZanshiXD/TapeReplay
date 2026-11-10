// The Python worker: Pyodide, numpy and the app's runtime (python/runtime.py), off the page's thread so the replay
// stays smooth while Python works. It answers one request at a time, in the order they came:
//   { id, op: 'load', base, cdn, libs }           start Python (once) and load packages; answers { id, ok, res: null }
//   { id, op: 'call', fn, args, tag?, libs? }     calls the runtime's global fn(*args) (strings, numbers, a Float64Array)
//                                                 after loading libs; answers { id, ok, res, out }
// out is what print() and stderr wrote during the call: [[tag, text, 'pr' | 'er'], ...] (the newest 1500 lines).
// A failed request answers { id, ok: false, error }. A request after a failed load fails with the same error.
import RUNTIME from '../../python/runtime.py?raw';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Py = any;
const W = self as unknown as { onmessage: ((e: MessageEvent) => void) | null; postMessage: (m: unknown) => void };
const MISSING = 'Python is missing from this copy of the app. Build it again with desktop/build.py (Windows) or ios/sync_web.py (iOS).';
let py: Py = null, loading: Promise<void> | null = null, failed = '';
const libs = new Set<string>();
let tag = '', out: Array<[string, string, string]> = [];
const log = (text: string, kind: string) => { out.push([tag, text, kind]); if (out.length > 3000) out = out.slice(-1500); };

async function load(base: string, cdn: string | null) {
  if (py) return;
  if (failed) throw new Error(failed);
  loading ||= (async () => {
    let mod: Py;
    try { mod = await import(/* @vite-ignore */ base + 'pyodide.mjs'); }
    catch { if (!cdn) throw new Error(MISSING); base = cdn; mod = await import(/* @vite-ignore */ base + 'pyodide.mjs'); }
    const p = await mod.loadPyodide({ indexURL: base });
    p.setStdout({ batched: (s: string) => log(s, 'pr') });
    p.setStderr({ batched: (s: string) => log(s, 'er') });
    await p.loadPackage('numpy', { messageCallback: () => {}, errorCallback: () => {} });
    p.runPython(RUNTIME);
    libs.add('numpy'); py = p;
  })().catch(e => { failed = (e && e.message) || String(e); throw e; });
  await loading;
}
async function need(want: string[]) {
  for (const l of want) if (!libs.has(l)) { await py.loadPackage(l, { messageCallback: () => {}, errorCallback: () => {} }); libs.add(l); }
}

async function handle(m: { id: number; op: string; [k: string]: any }) {
  try {
    if (m.op === 'load') { await load(m.base, m.cdn); await need(m.libs || []); W.postMessage({ id: m.id, ok: true, res: null }); return; }
    if (!py) throw new Error(failed || 'Python is not loaded.');
    if (m.op === 'call') {
      await need(m.libs || []);
      const f = py.globals.get(m.fn);
      if (!f) throw new Error('No Python function ' + m.fn);
      tag = m.tag || ''; out = [];
      let res: unknown;
      try { res = f(...(m.args || [])); } finally { tag = ''; }
      if (res && typeof (res as Py).toJs === 'function') { const r = res as Py; res = r.toJs(); r.destroy?.(); }
      f.destroy?.();
      const o = out.slice(-1500); out = [];
      W.postMessage({ id: m.id, ok: true, res: res ?? null, out: o });
      return;
    }
    throw new Error('Unknown request ' + m.op);
  } catch (e) {
    W.postMessage({ id: m.id, ok: false, error: (e && (e as Error).message) || String(e), out: out.splice(0) });
  }
}

let chain: Promise<void> = Promise.resolve();
W.onmessage = e => { const m = e.data; chain = chain.then(() => handle(m)); };
