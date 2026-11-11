// The JavaScript indicators' worker: core/jsindicator.ts off the page's thread, so a slow or stuck script never holds
// up the chart. It answers like the Python worker (worker.ts): { id, fn, args, tag } with { id, ok, res, out }, fn
// being _ti_start(iid, code, info), _ti_feed(iid, buf) or _ti_stop(iid), and out what print() wrote.
import { jsIndFeed, jsIndStart, jsIndStop } from '../../core/jsindicator';

const W = self as unknown as { onmessage: ((e: MessageEvent) => void) | null; postMessage: (m: unknown) => void };
let out: Array<[string, string, string]> = [];
const tags = new Map<string, string>();
W.onmessage = e => {
  const m = e.data as { id: number; fn: string; args: any[]; tag?: string };
  out = [];
  try {
    let res: unknown = null;
    if (m.fn === '_ti_start') {
      const iid = m.args[0] as string;
      tags.set(iid, m.tag || '');
      res = jsIndStart(iid, m.args[1], m.args[2], s => { out.push([tags.get(iid) || '', s, 'pr']); if (out.length > 3000) out = out.slice(-1500); });
    } else if (m.fn === '_ti_feed') res = jsIndFeed(m.args[0], m.args[1]);
    else if (m.fn === '_ti_stop') { jsIndStop(m.args[0]); tags.delete(m.args[0]); }
    else throw new Error('Unknown request ' + m.fn);
    W.postMessage({ id: m.id, ok: true, res, out: out.slice(-1500) });
  } catch (err) {
    W.postMessage({ id: m.id, ok: false, error: (err as Error)?.message || String(err), out: out.slice(-1500) });
  }
};
