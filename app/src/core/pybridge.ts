// Python strategies for the backtest runner. Pyodide (CPython in WebAssembly) runs runtime.py, the strategy API
// (ctx, Bar, Tick, Fill, ta, param, the settings parser), and runner.py, the
// batched entry points the new runner calls (_tb_*). The per-call entry points (_tr_*) are kept as a second
// bridge: the same engine with one crossing per call, for comparisons and benchmarks.
import type { Bridge, LogLine, StratApi, StratInfo } from './backtest';

export interface Pyodide {
  runPython(code: string): unknown;
  globals: { get(name: string): any };
  loadPackage(names: string | string[], opts?: { messageCallback?: (m: string) => void; errorCallback?: (m: string) => void }): Promise<unknown>;
  setStdout(o: { batched: (s: string) => void }): void;
  setStderr(o: { batched: (s: string) => void }): void;
}
/** a Python ready for strategies: its entry points, the packages loaded, and console text not yet taken */
export interface PyHost {
  py: Pyodide;
  fn: Record<string, any>;
  libs: Set<string>;
  out: LogLine[];
  /** loads packages not loaded yet (pandas) */
  need(libs: string[]): Promise<void>;
}

/** Pyodide from indexURL (a folder holding pyodide.mjs) with numpy, the strategy runtime and the runner. The page
 * passes the texts of runtime.py and runner.py (imported with ?raw). */
export async function loadPython(opts: { indexURL: string; runtime: string; runner: string; libs?: string[]; quiet?: boolean }): Promise<PyHost> {
  const { loadPyodide } = await import(/* @vite-ignore */ opts.indexURL + 'pyodide.mjs');
  const py: Pyodide = await loadPyodide({ indexURL: opts.indexURL });
  return pythonHost(py, opts.runtime, opts.runner, opts.libs || ['numpy'], opts.quiet);
}
export async function pythonHost(py: Pyodide, runtime: string, runner: string, libs: string[] = ['numpy'], quiet = false): Promise<PyHost> {
  const host: PyHost = {
    py, fn: {}, libs: new Set(), out: [],
    async need(ls) {
      for (const l of ls) {
        if (host.libs.has(l)) continue;
        await py.loadPackage(l, { messageCallback: () => {}, errorCallback: m => { if (!quiet) host.out.push([m, 'er']); } });
        host.libs.add(l);
      }
    },
  };
  // print() in the per-call functions, and anything else written to stdout or stderr, one line at a time
  py.setStdout({ batched: s => { if (!quiet) host.out.push([s, 'pr']); } });
  py.setStderr({ batched: s => { if (!quiet) host.out.push([s, 'er']); } });
  await host.need(['numpy', ...libs]);
  py.runPython(runtime);
  py.runPython(runner);
  for (const n of ['_tr_check', '_tr_start', '_tr_bar', '_tr_tick', '_tr_fill', '_tr_end', '_tr_params', '_tr_combos', '_tr_setvals',
                   '_tb_start', '_tb_bars', '_tb_ticks', '_tb_fills', '_tb_end', '_tb_flush']) host.fn[n] = py.globals.get(n);
  return host;
}

/** the code's syntax error (with its line), or null */
export const pyCheck = (host: PyHost, code: string): string | null => host.fn._tr_check(code) ?? null;
/** the settings at the top of the code (_tr_params): {params} or {error} */
export const pyParams = (host: PyHost, code: string) => JSON.parse(host.fn._tr_params(code));
/** the code with settings written in (Use in code): {code} or {error} */
export const pySetValues = (host: PyHost, code: string, values: Record<string, unknown>) => JSON.parse(host.fn._tr_setvals(code, JSON.stringify(values)));
/** the combinations in Python (grid, or random with Python's random.Random(seed)) */
export const pyCombos = (host: PyHost, spec: unknown) => JSON.parse(host.fn._tr_combos(JSON.stringify(spec)));
/** pandas is loaded only when asked for: the refusal */
export const pandasErr = (code: string, libs: string[]) => !libs.includes('pandas') && /^\s*(import\s+pandas|from\s+pandas\b)/m.test(code) ? 'This strategy uses pandas: choose "numpy + pandas" under Libraries.' : null;

const drainHost = (host: PyHost): LogLine[] => host.out.length ? host.out.splice(0) : [];
// the api as Python calls it: JSON text answers (runtime.py parses them)
function jsonApi(api: StratApi) {
  return {
    submit: (side: number, type: string, price: number | null, sl: number | null, tp: number | null, qty: number) => JSON.stringify(api.submit(side, type, price, sl, tp, qty)),
    close_all: () => { api.closeAll(); },
    cancel: (id: number) => JSON.stringify({ ok: api.cancel(id) }),
    bracket: (sl: number | null, tp: number | null) => JSON.stringify({ ok: api.bracket(sl, tp) }),
    orders: () => JSON.stringify(api.orders()),
    trades: () => JSON.stringify(api.trades()),
    history: (from: number) => JSON.stringify(api.history(from)),
    state: () => JSON.stringify(api.state()),
    sync: (i: number) => { api.sync(i); },
  };
}

/** a Python strategy, batched (runner.py) */
export function pyStrategy(host: PyHost, code: string): Bridge {
  const fn = host.fn;
  return {
    batch: true,
    start(api: StratApi, info: StratInfo) { return JSON.parse(fn._tb_start(jsonApi(api), code, JSON.stringify(info))); },
    bars: (buf, n, ver) => fn._tb_bars(buf, n, ver),
    ticks: (buf, n, ver) => fn._tb_ticks(buf, n, ver),
    fills: (list, ver, px) => fn._tb_fills(JSON.stringify(list), ver, px) ?? null,
    end: (ver, px) => fn._tb_end(ver, px) ?? null,
    flush() {
      const out = drainHost(host), x: string | undefined = fn._tb_flush();
      if (x) for (const [kind, text] of JSON.parse(x) as Array<[LogLine[1], string]>) for (const line of text.replace(/\n$/, '').split('\n')) out.push([line, kind]);
      return out;
    },
  };
}

/** a Python strategy through the per-call functions: one crossing per candle, tick and fill, the state with each */
export function pyPerCallStrategy(host: PyHost, code: string): Bridge {
  const fn = host.fn;
  let api: StratApi;
  return {
    batch: false,
    start(a: StratApi, info: StratInfo) {
      api = a;
      const j = jsonApi(a);
      const r = JSON.parse(fn._tr_start({ ...j, bracket: (sl: number | null, tp: number | null) => { a.bracket(sl, tp); } }, code, JSON.stringify(info)));
      return r.error ? r : { on_bar: true, ...r };
    },
    bars: (b, n) => { let k = 0; for (; k < n; k++) { const e = fn._tr_bar(b[7 * k], b[7 * k + 1], b[7 * k + 2], b[7 * k + 3], b[7 * k + 4], b[7 * k + 5], b[7 * k + 6], ...api.state4()); if (e) return e; } return n; },
    ticks: (b, n) => { let k = 0; for (; k < n; k++) { const e = fn._tr_tick(b[3 * k], b[3 * k + 1], b[3 * k + 2], ...api.state4()); if (e) return e; } return n; },
    fills(list) { for (const f of list) { const e = fn._tr_fill(JSON.stringify(f), ...api.state4()); if (e) return e; } return null; },
    end: () => fn._tr_end(...api.state4()) ?? null,
    flush: () => drainHost(host),
  };
}
