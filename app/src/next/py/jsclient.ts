// The page's side of the JavaScript indicators' worker (jsworker.ts), shaped like pyCall: jsCall('_ti_feed', [iid,
// buf]) resolves with the same JSON Python gives. print() output goes to the console under the caller's tag. A call
// that takes too long (a script stuck in a loop) ends the worker: every indicator waiting gets an error, and the next
// call starts a fresh worker (those indicators then start again from scratch).
import { pyLog } from './console';

type Wait = { ok: (v: unknown) => void; bad: (e: Error) => void; t: number };
let w: Worker | null = null, seq = 0;
const waits = new Map<number, Wait>();
/** bumps each time the worker is replaced, so the indicators know to start again */
export const jsWorker = { gen: 0 };
/** indicator name -> why it was stopped for taking too long: not started again (on any chart) until its code changes */
export const jsStuck = new Map<string, string>();
const LIMIT = 20000;

/** ends the worker: the stuck call fails with msg; the others waiting behind it are only asked to start again */
function kill(msg: string, stuck?: number) {
  for (const [id, x] of waits) { clearTimeout(x.t); x.bad(id === stuck || stuck == null ? new Error(msg) : Object.assign(new Error('restart'), { restart: true })); }
  waits.clear(); w?.terminate(); w = null; jsWorker.gen++;
}
function worker(): Worker {
  if (w) return w;
  w = new Worker(new URL('./jsworker.ts', import.meta.url), { type: 'module' });
  w.onmessage = e => {
    const m = e.data as { id: number; ok: boolean; res?: unknown; error?: string; out?: Array<[string, string, string]> };
    if (m.out) for (const [tag, text, kind] of m.out) pyLog(tag, text, kind);
    const x = waits.get(m.id); if (!x) return;
    waits.delete(m.id); clearTimeout(x.t);
    if (m.ok) x.ok(m.res); else x.bad(new Error(m.error || 'The indicator failed.'));
  };
  w.onerror = e => { e.preventDefault(); kill(e.message || 'The indicators’ worker stopped.'); };
  return w;
}

/** runs fn(...args) in the JS indicators' worker; print() output is logged under tag */
export function jsCall<T = string | null>(fn: string, args: unknown[], o: { tag?: string; transfer?: Transferable[] } = {}): Promise<T> {
  const id = ++seq, wk = worker();
  return new Promise<T>((ok, bad) => {
    const t = window.setTimeout(() => {
      const msg = `${o.tag || 'An indicator'} took more than ${LIMIT / 1000} seconds on its candles, so it was stopped (a loop that never ends?).`;
      if (o.tag) jsStuck.set(o.tag, msg);
      kill(msg, id);
    }, LIMIT);
    waits.set(id, { ok: ok as (v: unknown) => void, bad, t });
    wk.postMessage({ id, fn, args, tag: o.tag || '' }, o.transfer || []);
  });
}
