// The page's side of the Python worker (worker.ts): one worker for the whole page, started the first time Python is
// wanted. pyCall() runs one of the runtime's functions there and resolves with its result; print() output comes back
// with each answer and goes to the console (console.ts) under the caller's tag. Shared by the Python indicators and
// anything else that runs the runtime (strategies can use the same calls).
import { store } from '../appstore';
import { pyLog } from './console';

export const PY_CDN = 'https://cdn.jsdelivr.net/pyodide/v0.27.7/full/';
/** pandas loads only for code that imports it */
export const PY_PANDAS = /^\s*(import\s+pandas|from\s+pandas\b)/m;
export const pyLibs = (code: string) => PY_PANDAS.test(code) ? ['numpy', 'pandas'] : ['numpy'];

/** where Python is: idle (not asked for yet), loading, ready, or failed (with the reason) */
export const pyStatus = { state: 'idle' as 'idle' | 'loading' | 'ready' | 'failed', error: '' };
type Wait = { ok: (v: unknown) => void; bad: (e: Error) => void };
let w: Worker | null = null, seq = 0, loaded: Promise<void> | null = null;
const waits = new Map<number, Wait>();

function worker(): Worker {
  if (w) return w;
  w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  w.onmessage = e => {
    const m = e.data as { id: number; ok: boolean; res?: unknown; error?: string; out?: Array<[string, string, string]> };
    if (m.out) for (const [tag, text, kind] of m.out) pyLog(tag, text, kind);
    const x = waits.get(m.id); if (!x) return;
    waits.delete(m.id);
    if (m.ok) x.ok(m.res); else x.bad(new Error(m.error || 'Python failed.'));
  };
  w.onerror = e => {
    e.preventDefault();
    const err = new Error(e.message || 'The Python worker stopped.');
    for (const x of waits.values()) x.bad(err);
    waits.clear(); w?.terminate(); w = null; loaded = null;
    pyStatus.state = 'failed'; pyStatus.error = err.message;
  };
  return w;
}
function send(m: Record<string, unknown>, transfer: Transferable[] = []): Promise<unknown> {
  const id = ++seq, wk = worker();
  return new Promise((ok, bad) => { waits.set(id, { ok, bad }); wk.postMessage({ ...m, id }, transfer); });
}

/** starts Python (once) with these packages. In the apps Python is bundled; a page opened on its own may use the CDN. */
export function pyLoad(libs: string[] = ['numpy']): Promise<void> {
  if (!loaded) {
    pyStatus.state = 'loading';
    loaded = send({ op: 'load', base: new URL('pyodide/', location.href).href, cdn: store.kind === 'app' ? null : PY_CDN, libs: ['numpy'] })
      .then(() => { pyStatus.state = 'ready'; pyStatus.error = ''; })
      .catch((e: Error) => { pyStatus.state = 'failed'; pyStatus.error = e.message; loaded = null; throw e; });
  }
  return libs.some(l => l !== 'numpy') ? loaded.then(() => send({ op: 'load', libs }) as Promise<unknown> as Promise<void>) : loaded;
}

/** runs the runtime's function fn(...args) in the worker; print() output is logged under tag */
export async function pyCall<T = string | null>(fn: string, args: unknown[], o: { tag?: string; libs?: string[]; transfer?: Transferable[] } = {}): Promise<T> {
  await pyLoad();
  return send({ op: 'call', fn, args, tag: o.tag || '', libs: o.libs || [] }, o.transfer) as Promise<T>;
}
