// The optimizer: a strategy run many times with different settings, in parallel workers (opt.worker.ts), ranked by
// a goal: the values tried for each setting, the rules combinations
// must meet, grid and random search with caps on their size, the goals, scores, minimum trades, Check period (out of
// sample by exit time), sorting, zoom-in and CSV. New: a smart search (coarse grid, then a pattern search around the
// best, then crossover of the best) that finds about the grid's best with about a tenth of the runs; the default.
// Everything is deterministic for a seed: the smart search decides each batch from the results of the batches
// before it, never from which worker finished first.
import { optFmt, optLabel, type Mode, type Costs, type Setting } from './backtest';
import type { Closed } from './account';
import type { Series } from './series';
import type { PropConfig, PropStats } from './prop';
import { parseWhen, stripWhen, sameVal, type When } from './when';
export { parseWhen, stripWhen, type When };

export { optFmt, optLabel };
export const OPT_CAP = 20000, OPT_CAP_SMALL = 300;
export const OPT_GOALS = { ndd: 'Net ÷ max drawdown', net: 'Net P&L', pf: 'Profit factor', take: 'Payouts − fees' } as const;
/** a run's prop challenge in an optimization's results */
export function simRes(st: PropStats, label: string): SimRes {
  return { attempts: st.attempts, fees: st.fees, income: st.income, take: st.take, label, passed: st.passed, live: st.live, nPay: st.nPay, avgPay: st.avgPay ?? 0, maxPay: st.maxPay ?? 0 };
}
export type Goal = keyof typeof OPT_GOALS;
export type Combo = Record<string, Setting>;

/* ---- values to try ---- */
export interface ParamInfo { name: string; kind: 'int' | 'float' | 'bool' | 'choice'; value: Setting; choices?: Setting[]; zero_off?: boolean; param?: boolean; lo?: number; hi?: number; step?: number; values?: Setting[] }
export const niceStep = (x: number) => { if (!(x > 0)) return 1; const e = 10 ** Math.floor(Math.log10(x)); for (const m of [1, 2, 2.5, 5, 10]) if (x <= m * e * 1.0001) return m * e; return 10 * e; };
export const roundTo = (x: number, step: number) => +x.toFixed(Math.min(10, Math.max(0, -Math.floor(Math.log10(step)) + 2)));
/** values to try for a setting: centered on its value with a round step (narrow, normal or wide), or param()'s range */
export function optValues(p: ParamInfo, preset: 'narrow' | 'normal' | 'wide' | 'param' = 'normal'): Setting[] {
  if (p.kind === 'bool') return [true, false];
  if (p.kind === 'choice') return (p.choices && p.choices.length ? p.choices : [p.value]).slice();
  if (preset === 'param' && p.values) return p.values.slice();
  const isInt = p.kind === 'int', v = p.value as number, out: number[] = [];
  if (preset === 'param' && p.lo != null && p.hi != null) {
    const lo = Math.min(p.lo, p.hi), hi = Math.max(p.lo, p.hi);
    let step = p.step! > 0 ? p.step! : niceStep((hi - lo) / 6); if (isInt) step = Math.max(1, Math.round(step));
    for (let n = 0; n < 2000; n++) { const x = lo + n * step; if (x > hi + step * 1e-9) break; out.push(isInt ? Math.round(x) : roundTo(x, step)); }
  } else {
    const [fa, fb, k] = ({ narrow: [0.75, 1.25, 5], normal: [0.5, 1.5, 7], wide: [0.25, 3, 9] } as Record<string, number[]>)[preset] || [0.5, 1.5, 7];
    let lo: number, hi: number;
    if (v === 0) { lo = 0; hi = isInt ? k - 1 : 1; } else { lo = Math.min(v * fa, v * fb); hi = Math.max(v * fa, v * fb); }
    let step = niceStep((hi - lo) / (k - 1)); if (isInt) step = Math.max(1, Math.round(step));
    if ((hi - lo) / step < 2) { lo = Math.min(lo, v - step); hi = Math.max(hi, v + step); } // at least three values
    for (let n = -1000; n <= 1000; n++) {
      const x = v + n * step;
      if (x < lo - step * 1e-9 || x > hi + step * 1e-9) continue;
      if (isInt && v >= 1 && x < 1) continue;
      out.push(isInt ? Math.round(x) : roundTo(x, step));
    }
  }
  if (!out.includes(v)) out.push(isInt ? Math.round(v) : v);
  if (p.zero_off && !out.includes(0)) out.push(0);
  return [...new Set(out)].sort((x, y) => x - y);
}
/** the values as text for the table: "5..30 step 5" for an even run of more than 8, else a list */
export function optText(p: ParamInfo, vals: Setting[]): string {
  if (p.kind === 'bool') return vals.map(optFmt).join(', ');
  if (p.kind === 'choice') return vals.join(', ');
  const v = vals as number[];
  if (v.length > 8) { const d = v[1] - v[0]; if (v.every((x, k) => !k || Math.abs(x - v[k - 1] - d) < Math.abs(d) * 1e-6)) return `${optFmt(v[0])}..${optFmt(v[v.length - 1])} step ${optFmt(d)}`; }
  return v.map(optFmt).join(', ');
}
/** what was typed: "5, 10, 20", "5..30 step 5" (or "5..30/5"); True/False; text choices */
export function optParse(p: ParamInfo, text: string): { vals: Setting[] } | { error: string } {
  const s = String(text || '').trim();
  if (!s) return { error: 'no values' };
  if (p.kind === 'bool') {
    const v = s.split(/[\s,]+/).filter(Boolean).map(x => /^(true|yes|on|1)$/i.test(x) ? true : /^(false|no|off|0)$/i.test(x) ? false : null);
    return v.includes(null) ? { error: 'use True and False' } : { vals: [...new Set(v as boolean[])] };
  }
  if (p.kind === 'choice') return { vals: [...new Set(s.split(',').map(x => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean))] };
  const m = s.match(/^(-?\d*\.?\d+)\s*\.\.\s*(-?\d*\.?\d+)(?:\s*(?:step|\/)\s*(\d*\.?\d+))?$/i);
  if (m) {
    let lo = +m[1], hi = +m[2]; if (lo > hi) [lo, hi] = [hi, lo];
    const step = m[3] ? +m[3] : p.kind === 'int' ? 1 : niceStep((hi - lo) / 6);
    if (!(step > 0)) return { error: 'the step must be more than 0' };
    if ((hi - lo) / step > 5000) return { error: 'too many values' };
    const vals: number[] = [];
    for (let n = 0; ; n++) { const x = lo + n * step; if (x > hi + step * 1e-9) break; vals.push(p.kind === 'int' && Number.isInteger(step) ? Math.round(x) : roundTo(x, step)); }
    return { vals };
  }
  const vals = s.split(/[\s,;]+/).filter(Boolean).map(Number);
  return vals.some(x => !isFinite(x)) ? { error: 'numbers, separated by commas' } : { vals: [...new Set(vals)] };
}
/** Zoom in: around the chosen combination, each numeric setting from its neighbouring tried values in steps of a
 * quarter of the smallest gap (up to 200 values); the others just their value */
export function optZoom(combo: Combo, spec: Array<{ name: string; values: Setting[] }>, kinds: Record<string, ParamInfo['kind']>): Array<{ name: string; values: Setting[] }> {
  return spec.map(sp => {
    const v = combo[sp.name], vals = sp.values;
    if (typeof v !== 'number' || vals.length < 2) return { name: sp.name, values: [v] };
    const s = (vals as number[]).slice().sort((a, b) => a - b), k = s.indexOf(v);
    const lo = k > 0 ? s[k - 1] : v, hi = k < s.length - 1 ? s[k + 1] : v;
    const gap = Math.min(...s.slice(1).map((x, j) => x - s[j]).filter(d => d > 0));
    let step = (isFinite(gap) ? gap : Math.abs(v) || 1) / 4;
    step = kinds[sp.name] === 'int' ? Math.max(1, Math.round(step)) : niceStep(step);
    const out: number[] = [];
    for (let n = 0; n < 200; n++) { const x = lo + n * step; if (x > hi + step * 1e-9) break; out.push(kinds[sp.name] === 'int' ? Math.round(x) : roundTo(x, step)); }
    if (!out.includes(v)) out.push(v);
    return { name: sp.name, values: [...new Set(out)].sort((a, b) => a - b) };
  });
}

/* ---- rules: Python expressions over the ticked settings (FAST < SLOW), evaluated here so no Python is needed ---- */
type Ev = (env: Combo) => any;
class RuleSyntax extends Error {}
const truthy = (x: any) => !(x === false || x === 0 || x === '' || x == null);
const num = (x: any) => typeof x === 'boolean' ? +x : x;
function pyRound(x: number, nd?: number) {
  if (nd != null) return +(+x).toFixed(Math.max(0, nd));
  const r = Math.round(x); return Math.abs(x % 1) === 0.5 ? 2 * Math.round(x / 2) : r; // halves to even, as Python
}
const FUNCS: Record<string, (...a: any[]) => any> = { abs: (x: any) => Math.abs(num(x)), min: (...a: any[]) => a.reduce((x, y) => (num(y) < num(x) ? y : x)), max: (...a: any[]) => a.reduce((x, y) => (num(y) > num(x) ? y : x)), round: pyRound };
function cmp(op: string, a: any, b: any): boolean {
  const sa = typeof a === 'string', sb = typeof b === 'string';
  if (op === '==' || op === '!=') { const eq = sa || sb ? a === b : num(a) === num(b); return op === '==' ? eq : !eq; }
  if (sa !== sb) throw new TypeError('not comparable');
  a = num(a); b = num(b);
  return op === '<' ? a < b : op === '<=' ? a <= b : op === '>' ? a > b : a >= b;
}
function arith(op: string, a: any, b: any) {
  if (typeof a === 'string' || typeof b === 'string') { if (op === '+' && typeof a === 'string' && typeof b === 'string') return a + b; throw new TypeError('text'); }
  a = num(a); b = num(b);
  if ((op === '/' || op === '//' || op === '%') && b === 0) throw new Error('division by zero');
  switch (op) { case '+': return a + b; case '-': return a - b; case '*': return a * b; case '/': return a / b; case '//': return Math.floor(a / b); case '%': return ((a % b) + b) % b; default: return a ** b; }
}
/** compiles one rule; names collects the names it uses (functions included), in order */
function compileRule(src: string, names: string[]): Ev {
  const toks = src.match(/\s*(\d+\.\d*(?:[eE][-+]?\d+)?|\.\d+(?:[eE][-+]?\d+)?|\d+(?:[eE][-+]?\d+)?|[A-Za-z_]\w*|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\*\*|\/\/|[<>!=]=|[-+*/%<>(),]|\S)/g)?.map(t => t.trim()) || [];
  let p = 0;
  const peek = () => toks[p], eat = (t?: string) => { const x = toks[p]; if (t != null && x !== t) throw new RuleSyntax(); p++; return x; };
  const KW = new Set(['and', 'or', 'not', 'True', 'False', 'None', 'in', 'is', 'if', 'else', 'lambda']);
  const atom = (): Ev => {
    const t = eat(); if (t == null) throw new RuleSyntax();
    if (t === '(') { const e = or(); eat(')'); return e; }
    if (/^[\d.]/.test(t)) { const v = +t; if (isNaN(v)) throw new RuleSyntax(); return () => v; }
    if (/^["']/.test(t)) { const v = t.slice(1, -1).replace(/\\(.)/g, '$1'); return () => v; }
    if (t === 'True' || t === 'False' || t === 'None') { const v = t === 'None' ? null : t === 'True'; return () => v; }
    if (/^[A-Za-z_]/.test(t) && !KW.has(t)) {
      if (!names.includes(t)) names.push(t);
      if (peek() === '(') {
        eat('('); const args: Ev[] = [];
        if (peek() !== ')') { args.push(or()); while (peek() === ',') { eat(); args.push(or()); } }
        eat(')');
        return env => { const f = FUNCS[t]; if (!f) throw new Error('not callable'); return f(...args.map(a => a(env))); };
      }
      return env => { if (!(t in env)) throw new Error('name'); return env[t]; };
    }
    throw new RuleSyntax();
  };
  const power = (): Ev => { const a = atom(); if (peek() === '**') { eat(); const b = unary(); return env => arith('**', a(env), b(env)); } return a; };
  const unary = (): Ev => { if (peek() === '-' || peek() === '+') { const op = eat(), a = unary(); return env => { const v = num(a(env)); if (typeof v !== 'number') throw new TypeError(); return op === '-' ? -v : v; }; } return power(); };
  const bin = (next: () => Ev, ops: string[]) => (): Ev => {
    let a = next();
    while (ops.includes(peek())) { const op = eat(), l = a, r = next(); a = env => arith(op, l(env), r(env)); }
    return a;
  };
  const term = bin(unary, ['*', '/', '//', '%']), sum = bin(term, ['+', '-']);
  const comp = (): Ev => {
    const first = sum(), rest: Array<[string, Ev]> = [];
    while (['<', '>', '<=', '>=', '==', '!='].includes(peek())) { const op = eat(); rest.push([op, sum()]); }
    if (!rest.length) return first;
    return env => { let a = first(env); for (const [op, e] of rest) { const b = e(env); if (!cmp(op, a, b)) return false; a = b; } return true; };
  };
  const not = (): Ev => { if (peek() === 'not') { eat(); const a = not(); return env => !truthy(a(env)); } return comp(); };
  const and = (): Ev => { let a = not(); while (peek() === 'and') { eat(); const l = a, r = not(); a = env => { const x = l(env); return truthy(x) ? r(env) : x; }; } return a; };
  const or = (): Ev => { let a = and(); while (peek() === 'or') { eat(); const l = a, r = and(); a = env => { const x = l(env); return truthy(x) ? x : r(env); }; } return a; };
  const e = or();
  if (p !== toks.length) throw new RuleSyntax();
  return e;
}
/** the rules (one per line; blank and # lines ignored) as a test of a combination, or the error */
export function parseRules(rules: string[], ticked: string[]): { ok: (c: Combo) => boolean } | { error: string } {
  const list = rules.map(r => r.trim()).filter(r => r && !r.startsWith('#'));
  const fns: Ev[] = [];
  for (const r of list) {
    const names: string[] = [];
    try { fns.push(compileRule(r, names)); } catch { return { error: `This rule is not valid Python: ${r}` }; }
    const unknown = names.filter(n => !ticked.includes(n) && !(n in FUNCS));
    if (unknown.length) return { error: `The rule "${r}" uses ${unknown.join(', ')}, which is not a ticked setting.` };
  }
  return { ok: c => { try { return fns.every(f => truthy(f(c))); } catch { return false; } } };
}

/* ---- combinations ---- */
/* ---- settings that only matter for some values of another: a note in the setting's comment, like
 *   const CHOP_ATR_LEN = 35;  // only when CHOP_MODE is "ATR" or "both"
 *   USE_TRAIL_TICKS = 8       # only when USE_TRAIL
 * ("only when NAME", "only when not NAME", "only when NAME is X or Y", "only when NAME is not X"; "only if" too).
 * Where it is off, a combination keeps the setting at its value in the code, so combinations that differ only there
 * are one run. ---- */
/** whether a setting with this note is used when the setting it names has value v */
export function whenOn(w: When, v: Setting): boolean { const m = w.vals ? w.vals.some(x => sameVal(x, v)) : truthy(v); return w.not ? !m : m; }
/** the notes of a script's settings, by name, keeping those that name another setting there is */
export function whenOf(params: Array<{ name: string; comment?: string }>): Record<string, When> {
  const names = new Set(params.map(p => p.name)), out: Record<string, When> = {};
  for (const p of params) { const w = parseWhen(p.comment); if (w && w.on !== p.name && names.has(w.on)) out[p.name] = w; }
  return out;
}
/** a combination with every setting that is off (by its note) back at its value in the code (base) */
export function settle(c: Combo, when?: Record<string, When>, base?: Combo): Combo {
  if (!when || !base) return c;
  let out = c;
  for (let pass = 0; pass < 4; pass++) { // a note can name a setting that has a note of its own
    let changed = false;
    for (const name in when) {
      if (!(name in out) || !(name in base)) continue;
      const w = when[name], v = w.on in out ? out[w.on] : base[w.on];
      if (v === undefined || whenOn(w, v) || sameVal(out[name], base[name])) continue;
      if (out === c) out = { ...c };
      out[name] = base[name]; changed = true;
    }
    if (!changed) break;
  }
  return out;
}
/** the note that makes a setting off in a combination (for showing it so), or null */
export function offBy(name: string, c: Combo, when?: Record<string, When>, base?: Combo): When | null {
  const w = when?.[name]; if (!w || !base) return null;
  const v = w.on in c ? c[w.on] : base[w.on];
  return v === undefined || whenOn(w, v) ? null : w;
}

export interface Space { params: Array<{ name: string; values: Setting[] }>; rules?: string[]; when?: Record<string, When>; base?: Combo }
export const comboTotal = (sp: Space) => sp.params.reduce((s, p) => s * p.values.length, 1);
/** how many different combinations there are once settings that are off are left at their value (null: too many to
 *  count, over `limit`) */
export function distinctTotal(sp: Space, limit = 300000): number | null {
  const total = comboTotal(sp);
  if (!sp.when || !Object.keys(sp.when).length) return total;
  if (total > limit) return null;
  const seen = new Set<string>();
  for (let i = 0; i < total; i++) seen.add(optLabel(settle(comboAt(sp, i), sp.when, sp.base)));
  return seen.size;
}
/** combination number i, the last setting varying fastest */
export function comboAt(sp: Space, i: number): Combo {
  const d: Combo = {};
  for (let k = sp.params.length - 1; k >= 0; k--) { const p = sp.params[k], s = p.values.length; d[p.name] = p.values[i % s]; i = Math.floor(i / s); }
  const out: Combo = {}; for (const p of sp.params) out[p.name] = d[p.name];
  return out;
}
export const mulberry32 = (seed: number) => { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
/** grid or random combinations, as Python's _tr_combos: {combos, total, skipped} or {error}. Random order comes
 * from mulberry32(seed) (Python's version uses random.Random: the same idea, other picks). */
export function combos(sp: Space & { mode: 'grid' | 'random'; n?: number; seed?: number; cap?: number }): { combos: Combo[]; idx: number[]; total: number; skipped: number; repeats: number } | { error: string; total?: number } {
  const params = sp.params.filter(p => p.values.length);
  const space = { params }, total = comboTotal(space), cap = sp.cap ?? OPT_CAP;
  const r = parseRules(sp.rules || [], params.map(p => p.name)); if ('error' in r) return r;
  const out: Combo[] = [], idx: number[] = [], seen = new Set<string>(); let skipped = 0, repeats = 0;
  // a combination that differs from one taken only in settings that are off is the same run: not taken again
  const take = (i: number) => {
    const c = settle(comboAt(space, i), sp.when, sp.base);
    if (sp.when) { const k = optLabel(c); if (seen.has(k)) { repeats++; return; } seen.add(k); }
    if (r.ok(c)) { out.push(c); idx.push(i); } else skipped++;
  };
  if (sp.mode === 'random') {
    const n = Math.max(1, Math.round(sp.n ?? 100)), rnd = mulberry32(sp.seed ?? 1);
    if (total <= 200000) { // a lazy shuffle of every index
      const a = new Int32Array(total); for (let k = 0; k < total; k++) a[k] = k;
      for (let k = 0; k < total && out.length < n; k++) { const j = k + Math.floor(rnd() * (total - k)), t = a[k]; a[k] = a[j]; a[j] = t; take(a[k]); }
    } else {
      const seen = new Set<number>();
      for (let k = 0; k < n * 20 && out.length < n; k++) { const i = Math.floor(rnd() * total); if (!seen.has(i)) { seen.add(i); take(i); } }
    }
    return { combos: out, idx, total, skipped, repeats };
  }
  const tooMany = (n: number) => ({ error: `${n.toLocaleString('en-US')} combinations is more than ${cap.toLocaleString('en-US')}. Narrow the ranges, or use a random sample.`, total });
  if (total > cap && (!sp.when || total > 5e6)) return tooMany(total);
  for (let i = 0; i < total; i++) { take(i); if (out.length > cap) return tooMany(distinctTotal({ ...space, when: sp.when, base: sp.base }, 5e6) ?? total); }
  return { combos: out, idx, total, skipped, repeats };
}

/* ---- results and scores ---- */
export interface Seg { trades: number; net: number; win: number | null; pf: number | null; dd: number }
export interface SimRes { attempts: number; fees: number; income: number; take: number; label: string; passed: number; live: number; nPay: number; avgPay: number; maxPay: number }
/** one run's figures: a = closed trades exiting before the Check period, b = in it (null without one) */
export interface OptRes { fail?: string; a?: Seg; b?: Seg | null; sim?: SimRes | null; open?: number; tr?: number[];
  /** the trades' fingerprint (every trade's times, size and net): runs with the same one made exactly the same trades */
  fp?: string }
/** a fingerprint of closed trades: entry and exit times, size and net of each, in order */
export function tradesPrint(hist: ArrayLike<Closed>): string {
  let h1 = 0xdeadbeef ^ hist.length, h2 = 0x41c6ce57 ^ hist.length;
  const mix = (x: number) => { h1 = Math.imul(h1 ^ x, 2654435761); h2 = Math.imul(h2 ^ x, 1597334677); };
  for (let k = 0; k < hist.length; k++) { const x = hist[k]; mix(x.time | 0); mix(x.exitTime | 0); mix(Math.round(x.qty * 1e4)); mix(Math.round(x.net * 100)); mix(x.side); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36) + ':' + hist.length;
}
/** closed trades exiting in [lo, hi): count, net, win %, profit factor (1e9 for no losses), and the max drawdown of
 * their running net (from 0), not the account's */
export function seg(hist: ArrayLike<Closed> | Closed[], lo: number, hi: number): Seg {
  let trades = 0, net = 0, w = 0, gw = 0, gl = 0, cum = 0, peak = 0, dd = 0;
  for (let k = 0; k < hist.length; k++) {
    const x = hist[k]; if (!(x.exitTime >= lo && x.exitTime < hi)) continue;
    trades++; net += x.net; cum += x.net;
    if (x.net > 0) { w++; gw += x.net; } else gl -= x.net;
    if (cum > peak) peak = cum;
    if (peak - cum > dd) dd = peak - cum;
  }
  return { trades, net, win: trades ? w / trades * 100 : null, pf: gl > 0 ? gw / gl : gw > 0 ? 1e9 : null, dd };
}
/** a worker run's result (the totals) */
export function totals(hist: Closed[], open: number, splitT: number | null, withTrades = false): OptRes {
  const a = seg(hist, -Infinity, splitT == null ? Infinity : splitT), b = splitT == null ? null : seg(hist, splitT, Infinity);
  const res: OptRes = { a, b, sim: null, open, fp: tradesPrint(hist) };
  if (withTrades) { const tr: number[] = []; for (const x of hist) tr.push(x.exitTime, Math.round(x.net * 100) / 100); res.tr = tr; }
  return res;
}
/** the ranking score; -Infinity for a failed run or fewer than minT trades (before the Check period) */
export function optScore(res: OptRes | null | undefined, goal: Goal, minT: number): number {
  if (!res || res.fail || !res.a) return -Infinity;
  const a = res.a;
  if (a.trades < minT) return -Infinity;
  if (goal === 'net') return a.net;
  if (goal === 'pf') return a.pf == null ? -1 : a.pf;
  if (goal === 'take') return res.sim ? res.sim.take : a.net;
  return a.dd > 0 ? a.net / a.dd : a.net > 0 ? 1e9 : a.net;
}
export interface OptRow { i: number; res: OptRes; score?: number }
/** rows sorted for the results table: failures last, then by key (score, p:NAME, a.net, b.pf, sim.take...), ties by
 * combination number; dir -1 descending */
export function optSorted(rows: OptRow[], combos: Combo[], goal: Goal, minT: number, key = 'score', dir = -1): OptRow[] {
  for (const r of rows) r.score = optScore(r.res, goal, minT);
  const val = (r: OptRow): number | string => {
    if (key === 'score') return r.score!;
    if (key.startsWith('p:')) { const v = combos[r.i][key.slice(2)]; return typeof v === 'number' ? v : String(v); }
    const [sg, f] = key.split('.'), s = r.res && (r.res as any)[sg];
    return s && s[f] != null ? s[f] : -Infinity;
  };
  return rows.slice().sort((x, y) => {
    if (!!x.res.fail !== !!y.res.fail) return x.res.fail ? 1 : -1;
    const a = val(x), b = val(y);
    return (a < b ? -1 : a > b ? 1 : x.i - y.i) * dir;
  });
}
export const optScoreTxt = (x: number, goal: Goal, money: (x: number) => string) => !isFinite(x) ? '—' : x >= 1e8 ? '∞' : goal === 'net' || goal === 'take' ? money(x) : x.toFixed(2);
/** all results as CSV, in the order given */
export function optCsv(sorted: OptRow[], combos: Combo[], names: string[], split: boolean): string {
  const head = ['rank', ...names, 'goal', 'trades', 'net', 'win_pct', 'profit_factor', 'max_dd', ...(split ? ['check_trades', 'check_net', 'check_pf', 'check_dd'] : []), 'evaluations', 'passed', 'went_live', 'payouts', 'avg_payout', 'largest_payout', 'payouts_minus_fees', 'error'];
  const f = (x: number | null | undefined) => x == null || !isFinite(x) ? '' : x >= 1e8 ? 'inf' : +x.toFixed(4);
  const rows = sorted.map((r, k) => {
    const c = combos[r.i], a = r.res.a || {} as Partial<Seg>, b = r.res.b || {} as Partial<Seg>, s = r.res.sim || {} as Partial<SimRes>;
    return [k + 1, ...names.map(n => optFmt(c[n])), f(r.score), a.trades ?? '', f(a.net), f(a.win), f(a.pf), f(a.dd), ...(split ? [b.trades ?? '', f(b.net), f(b.pf), f(b.dd)] : []),
      s.attempts ?? '', s.passed ?? '', s.live ?? '', s.nPay ?? '', f(s.avgPay), f(s.maxPay), f(s.take), r.res.fail ? JSON.stringify(String(r.res.fail).split('\n')[0]) : ''];
  });
  return [head, ...rows].map(r => r.join(',')).join('\n');
}

/* ---- the smart search ---- */
// Settings are axes of indexes into their values (numbers sorted; True/False and text choices are categories).
//  1. a coarse grid at the centers of even cells, sized to about a third of the budget (or a Latin hypercube sample
//     when even two levels per setting are too many)
//  2. a pattern search around the best few: each tries one step up and down each axis (and every other choice); a
//     point with nothing new around it halves its steps, down to one; better points inherit the step
//  3. when the best have all converged: children of the best (each setting from one of two parents, sometimes moved
//     a random distance), refined in turn by step 2
// Batches have a fixed size (cfg.batch, default 16) whatever the number of workers, so the result depends on the
// seed only.
export interface SmartOpts { budget: number; seed: number; batch?: number }
type Pt = number[];
export async function smartSearch(sizes: number[], categorical: boolean[], key: (p: Pt) => number, ok: (p: Pt) => boolean, evaluate: (pts: Pt[]) => Promise<number[]>, o: SmartOpts, stopped: () => boolean = () => false): Promise<void> {
  const D = sizes.length, rnd = mulberry32(o.seed), B = o.batch ?? 16;
  const seen = new Map<number, number | null>(); // key -> score (null: refused by the rules or not run)
  const done: Array<{ p: Pt; k: number; s: number }> = [];
  const steps = new Map<number, number[]>();
  let used = 0;
  const fresh = (p: Pt) => { const k = key(p); if (seen.has(k)) return false; if (!ok(p)) { seen.set(k, null); return false; } return true; };
  const run = async (pts: Pt[]) => {
    pts = pts.slice(0, o.budget - used); if (!pts.length) return;
    for (const p of pts) seen.set(key(p), null);
    const sc = await evaluate(pts);
    pts.forEach((p, j) => { const k = key(p); seen.set(k, sc[j]); done.push({ p, k, s: sc[j] }); });
    used += pts.length;
  };
  const ranked = () => done.filter(x => isFinite(x.s)).sort((a, b) => b.s - a.s || a.k - b.k);
  // 1. coarse
  const target = Math.max(Math.min(o.budget, 8), Math.round(o.budget * 0.3));
  const L = sizes.map((m, d) => categorical[d] ? m : 1);
  let prod = L.reduce((a, b) => a * b, 1);
  for (;;) {
    let best = -1, gap = 1;
    for (let d = 0; d < D; d++) if (!categorical[d] && L[d] < sizes[d] && prod / L[d] * (L[d] + 1) <= target && sizes[d] / L[d] > gap) { gap = sizes[d] / L[d]; best = d; }
    if (best < 0) break;
    prod = prod / L[best] * (L[best] + 1); L[best]++;
  }
  const level = (d: number, j: number) => Math.min(sizes[d] - 1, Math.round((j + 0.5) * sizes[d] / L[d] - 0.5));
  let coarse: Pt[] = [];
  if (prod <= target && L.every((l, d) => categorical[d] || l >= 2 || sizes[d] <= 2)) {
    for (let i = 0; i < prod; i++) { const p: Pt = []; let r = i; for (let d = D - 1; d >= 0; d--) { p[d] = level(d, r % L[d]); r = Math.floor(r / L[d]); } coarse.push(p); }
  } else { // Latin hypercube: each axis cut into `target` strata, one point in each, in a seeded order
    const perms = sizes.map(() => { const a = Array.from({ length: target }, (_, k) => k); for (let k = target - 1; k > 0; k--) { const j = Math.floor(rnd() * (k + 1)); [a[k], a[j]] = [a[j], a[k]]; } return a; });
    for (let k = 0; k < target; k++) coarse.push(sizes.map((m, d) => Math.min(m - 1, Math.floor((perms[d][k] + rnd()) * m / target))));
    for (let d = 0; d < D; d++) L[d] = Math.min(sizes[d], target);
  }
  const step0 = sizes.map((m, d) => categorical[d] ? 1 : Math.max(1, Math.round(m / L[d] / 2)));
  coarse = coarse.filter((p, j) => fresh(p) && coarse.findIndex(q => key(q) === key(p)) === j);
  await run(coarse);
  // 2 and 3
  let stale = 0;
  while (used < o.budget && !stopped()) {
    const top = ranked(), batch: Pt[] = [], inBatch = new Set<number>();
    const add = (p: Pt) => { const k = key(p); if (!inBatch.has(k) && fresh(p)) { inBatch.add(k); batch.push(p); } };
    const elites = top.slice(0, Math.max(3, Math.ceil(top.length * 0.1)));
    for (const e of elites) {
      if (batch.length >= B) break;
      let st = steps.get(e.k) || step0.slice();
      for (;;) {
        const nb: Pt[] = [];
        for (let d = 0; d < D; d++) {
          if (categorical[d]) { for (let v = 0; v < sizes[d]; v++) if (v !== e.p[d]) { const q = e.p.slice(); q[d] = v; nb.push(q); } continue; }
          for (const s of [-st[d], st[d]]) { const v = e.p[d] + s; if (v >= 0 && v < sizes[d]) { const q = e.p.slice(); q[d] = v; nb.push(q); } }
        }
        const n0 = batch.length;
        for (const q of nb) { add(q); if (!steps.has(key(q))) steps.set(key(q), st.slice()); }
        if (batch.length > n0 || st.every((s, d) => s <= 1 || categorical[d])) break;
        st = st.map(s => Math.max(1, Math.floor(s / 2))); // nothing new at this distance: closer
      }
      steps.set(e.k, st);
    }
    if (batch.length < B && top.length) { // the best have converged: children of the best
      const par = top.slice(0, Math.max(2, Math.min(8, top.length)));
      for (let t = 0; t < B * 20 && batch.length < B; t++) {
        const a = par[Math.floor(rnd() * par.length)].p, b = par[Math.floor(rnd() * par.length)].p;
        const c = a.map((x, d) => rnd() < 0.5 ? x : b[d]);
        for (let d = 0; d < D; d++) if (rnd() < 1.5 / D) {
          if (categorical[d]) c[d] = Math.floor(rnd() * sizes[d]);
          else { const span = Math.max(1, Math.round(sizes[d] / 4)); c[d] = Math.max(0, Math.min(sizes[d] - 1, c[d] + Math.round((rnd() * 2 - 1) * span))); }
        }
        add(c);
      }
    }
    for (let t = 0; t < B * 20 && batch.length < (top.length ? 1 : B); t++) add(sizes.map(m => Math.floor(rnd() * m))); // nothing ranked yet, or stuck
    if (!batch.length) { if (++stale > 3) break; continue; }
    stale = 0;
    await run(batch);
  }
}

/* ---- running an optimization ---- */
export interface Task { idx: number; overrides: Combo; trades?: boolean }
/** runs tasks (in workers), calling onResult for each as it comes; resolves when all are done or it was stopped */
export type RunTasks = (tasks: Task[], onResult: (idx: number, res: OptRes) => void) => Promise<{ firstErr: string }>;
export interface OptConfig extends Space {
  search: 'smart' | 'grid' | 'random';
  /** random: combinations to try (default 200); smart: the budget (default a tenth of the grid, at least 60) */
  n?: number;
  seed: number; cap?: number; goal: Goal; minTrades: number;
  /** smart: combinations per batch (default 16) */
  batch?: number;
  /** results already known (resume, zoom): by optLabel(combo); these are not run again */
  cache?: Map<string, OptRes>;
  /** settings that are only used for some values of another (their notes), and every setting's value in the code */
  when?: Record<string, When>; base?: Combo;
}
export interface OptOutput {
  /** what ran, in order: combos[i] has rows' result i (the saved document's combos and rows) */
  combos: Combo[]; rows: OptRow[];
  total: number; skipped: number; error?: string; firstErr: string; stopped: boolean;
  best: OptRow | null;
  /** combinations not run because they differ from one that was only in settings that are off */
  repeats: number;
}
export interface OptProgress { done: number; planned: number; best: OptRow | null }
/** the default smart budget for a grid of `total` */
export const smartBudget = (total: number, cap = OPT_CAP) => Math.min(cap, total, Math.max(60, Math.ceil(total / 10)));

export async function optimize(cfg: OptConfig, runTasks: RunTasks, hooks: { progress?: (p: OptProgress) => void; stopped?: () => boolean } = {}): Promise<OptOutput> {
  const params = cfg.params.filter(p => p.values.length), space = { params, rules: cfg.rules, when: cfg.when, base: cfg.base }, total = comboTotal(space), cap = cfg.cap ?? OPT_CAP;
  const out: OptOutput = { combos: [], rows: [], total, skipped: 0, firstErr: '', stopped: false, best: null, repeats: 0 };
  if (!params.length) return { ...out, error: 'Tick at least one setting to try.' };
  const stopped = () => !!(hooks.stopped && hooks.stopped());
  const better = (r: OptRow) => { r.score = optScore(r.res, cfg.goal, cfg.minTrades); if (isFinite(r.score) && (!out.best || r.score > out.best.score! || (r.score === out.best.score && r.i < out.best.i))) out.best = r; };
  // runs combinations (known ones from the cache), keeping rows in the order given
  const exec = async (list: Combo[], planned: number): Promise<OptRes[]> => {
    const base = out.combos.length, res: OptRes[] = new Array(list.length), tasks: Task[] = [];
    list.forEach((c, j) => { out.combos.push(c); const hit = cfg.cache && cfg.cache.get(optLabel(c)); if (hit) res[j] = hit; else tasks.push({ idx: base + j, overrides: c }); });
    const pushRow = (j: number) => { const r: OptRow = { i: base + j, res: res[j] }; out.rows.push(r); better(r); };
    list.forEach((_, j) => { if (res[j]) pushRow(j); });
    if (tasks.length && !stopped()) {
      const { firstErr } = await runTasks(tasks, (idx, r) => {
        if (r.fail) out.firstErr ||= r.fail;
        res[idx - base] = r; pushRow(idx - base);
        if (hooks.progress) hooks.progress({ done: out.rows.length, planned, best: out.best });
      });
      out.firstErr ||= firstErr;
    }
    // a stop leaves some not run: they have no row
    for (let j = 0; j < list.length; j++) if (!res[j]) out.stopped = true;
    return res;
  };
  if (cfg.search !== 'smart') {
    const cr = combos({ ...space, mode: cfg.search, n: Math.min(cfg.n ?? 200, cap), seed: cfg.seed, cap });
    if ('error' in cr) return { ...out, error: cr.error };
    if (!cr.combos.length) return { ...out, error: 'No combinations are left after the rules.' };
    out.skipped = cr.skipped; out.repeats = cr.repeats;
    await exec(cr.combos, cr.combos.length);
    out.stopped ||= stopped();
    return out;
  }
  const rules = parseRules(cfg.rules || [], params.map(p => p.name)); if ('error' in rules) return { ...out, error: rules.error };
  // axes: numbers in ascending order, the rest as categories; a point's key is its grid number
  const order = params.map(p => p.values.every(v => typeof v === 'number') ? p.values.map((_, j) => j).sort((a, b) => (p.values[a] as number) - (p.values[b] as number)) : p.values.map((_, j) => j));
  const categorical = params.map(p => !p.values.every(v => typeof v === 'number'));
  const sizes = params.map(p => p.values.length);
  const gridIdx = (pt: Pt) => { let i = 0; for (let d = 0; d < pt.length; d++) i = i * sizes[d] + order[d][pt[d]]; return i; };
  const rawCombo = (pt: Pt) => { const c: Combo = {}; params.forEach((p, d) => { c[p.name] = p.values[order[d][pt[d]]]; }); return c; };
  const comboOf = (pt: Pt) => settle(rawCombo(pt), cfg.when, cfg.base);
  // a point's key: settings that are off count as their first value, so points differing only there are one run
  const keyOf = !cfg.when ? gridIdx : (pt: Pt) => { const c = comboOf(pt); return gridIdx(params.map((p, d) => offBy(p.name, c, cfg.when, cfg.base) ? 0 : pt[d])); };
  const distinct = distinctTotal(space) ?? total;
  const budget = Math.min(cap, distinct, Math.max(1, Math.round(cfg.n ?? smartBudget(distinct, cap))));
  let refused = 0;
  if (budget >= distinct) { // small enough to try everything: the grid
    const cr = combos({ ...space, mode: 'grid', cap: Infinity });
    if ('error' in cr) return { ...out, error: cr.error };
    if (!cr.combos.length) return { ...out, error: 'No combinations are left after the rules.' };
    out.skipped = cr.skipped; out.repeats = cr.repeats;
    await exec(cr.combos, cr.combos.length);
    out.stopped ||= stopped();
    return out;
  }
  await smartSearch(sizes, categorical, keyOf, pt => { const okk = rules.ok(comboOf(pt)); if (!okk) refused++; return okk; }, async pts => {
    const res = await exec(pts.map(comboOf), budget);
    return res.map(r => optScore(r, cfg.goal, cfg.minTrades));
  }, { budget, seed: cfg.seed, batch: cfg.batch }, () => stopped() || out.stopped);
  out.skipped = refused; out.repeats = total - distinct;
  if (!out.combos.length) return { ...out, error: 'No combinations are left after the rules.' };
  out.stopped ||= stopped();
  return out;
}

/* ---- workers ---- */
/** runs at once: one less than the processor count (at most 32); phones 2 (1 without shared memory); without shared
 * memory each holds its own copy of the data (1.5 GB in all); Python's each hold a Python (about 200 MB) */
export function workerCount(o: { bytes?: number; shared?: boolean; phone?: boolean; python?: boolean; cores?: number; memGB?: number } = {}): number {
  const nav = typeof navigator !== 'undefined' ? navigator as Navigator & { deviceMemory?: number } : null;
  let n = Math.max(1, Math.min(32, (o.cores ?? nav?.hardwareConcurrency ?? 4) - 1));
  if (o.phone) n = Math.min(n, o.shared ? 2 : 1);
  if (!o.shared) n = Math.max(1, Math.min(n, Math.floor(1.5e9 / ((o.bytes ?? 0) + 1))));
  const mem = o.memGB ?? nav?.deviceMemory;
  if (o.python && mem) n = Math.max(1, Math.min(n, Math.floor(mem * 1024 / 200)));
  return n;
}
/** the bars a run needs, from the bar before the start to end (exclusive): shared memory
 * when the page is cross-origin isolated, else copies. The job then runs from bar 1 to data.n. */
export function seriesSlice(s: Series, start: number, end: number): { data: Series; bytes: number; shared: boolean } {
  const a = Math.max(0, start - 1), n = end - a, shared = (globalThis as any).crossOriginIsolated === true && typeof SharedArrayBuffer === 'function';
  let bytes = 0;
  const col = (src: ArrayLike<number>): any => {
    const C: any = ArrayBuffer.isView(src) ? (src as any).constructor : Float64Array, size = n * C.BYTES_PER_ELEMENT;
    bytes += size;
    const arr = new C(shared ? new SharedArrayBuffer(size) : new ArrayBuffer(size));
    if (ArrayBuffer.isView(src)) arr.set((src as any).subarray(a, end)); else for (let k = 0; k < n; k++) arr[k] = src[a + k] || 0;
    return arr;
  };
  return { data: { id: s.id, inst: { ...s.inst }, n, t: col(s.t), o: col(s.o), h: col(s.h), l: col(s.l), c: col(s.c), v: col(s.v), base: s.base, hasVol: s.hasVol, synthetic: s.synthetic }, bytes, shared };
}
/** what every run of an optimization shares (sent to each worker once) */
export interface OptJob {
  lang: 'py' | 'js'; code: string; mode: Mode; tf: string; libs?: string[];
  /** where pyodide.mjs is (Python jobs) */
  pyBase?: string;
  data: Series; start: number; end: number; splitT: number | null;
  balance: number; qty?: number; ticksPerBar?: number; hedge?: boolean; costs?: Partial<Costs>;
  /** the chart time zone (setZone), so candles longer than an hour and bar.time follow it */
  zone: string; name?: string;
  /** a prop firm challenge in every run (payouts taken as soon as allowed): its result is the Payouts − fees goal */
  prop?: { cfg: PropConfig; rebuy: boolean; maxEvals: number } | null;
}
/** a worker, or anything that talks like one (tests run the job handler in the page) */
export interface Endpoint { postMessage(m: unknown): void; onmessage: ((e: { data: any }) => void) | null; onerror?: ((e: any) => void) | null; terminate(): void }
/** a new optimization worker (Vite bundles opt.worker.ts from this line) */
export const spawnOptWorker = (): Endpoint => new Worker(new URL('./opt.worker.ts', import.meta.url), { type: 'module' }) as unknown as Endpoint;

/** Workers kept ready between runs (each start loads Python: seconds of CPU), closed after idleMs unused. exec()
 * gives each worker the next task as soon as it returns a result (no fixed chunks). */
export class OptPool {
  private list: Array<{ ep: Endpoint; busy: boolean; dead: boolean; job: OptJob | null; handler: ((m: any) => void) | null }> = [];
  private idleT: ReturnType<typeof setTimeout> | null = null;
  private stopFlag = false;
  private wake: (() => void) | null = null;
  constructor(private spawn: () => Endpoint = spawnOptWorker, private idleMs = 10 * 60 * 1000) {}
  get size() { return this.list.length; }
  private grow(n: number) {
    this.list = this.list.filter(e => !e.dead);
    while (this.list.length < n) {
      const ep = this.spawn(), e = { ep, busy: false, dead: false, job: null as OptJob | null, handler: null as ((m: any) => void) | null };
      ep.onmessage = ev => { if (e.handler) e.handler(ev.data); };
      ep.onerror = ev => { try { ev?.preventDefault?.(); } catch { /* */ } e.dead = true; if (e.handler) e.handler({ type: 'crash', error: ev?.message || 'A worker stopped.' }); };
      this.list.push(e);
    }
    return this.list.slice(0, n);
  }
  /** start n workers now (Python loads while the settings are being chosen) */
  warm(n: number, msg?: unknown) { this.pause(); for (const e of this.grow(n)) if (msg) e.ep.postMessage(msg); this.idle(); }
  private pause() { if (this.idleT) clearTimeout(this.idleT); this.idleT = null; }
  private idle() { this.pause(); if (this.idleMs > 0 && isFinite(this.idleMs)) this.idleT = setTimeout(() => this.close(), this.idleMs); }
  /** runs tasks on n workers (a worker that has this job already is not sent it again) */
  async exec(job: OptJob, tasks: Task[], n: number, onResult: (idx: number, res: OptRes) => void): Promise<{ firstErr: string; t0: number }> {
    if (!tasks.length) return { firstErr: '', t0: 0 };
    this.pause(); this.stopFlag = false;
    const pool = this.grow(Math.max(1, Math.min(n, tasks.length)));
    let next = 0, firstErr = '', t0 = 0;
    await new Promise<void>(resolve => {
      let alive = pool.length;
      this.wake = resolve;
      for (const e of pool) {
        let fin = false;
        const finish = () => { if (fin) return; fin = true; e.handler = null; e.busy = false; if (--alive === 0) resolve(); };
        const give = () => { if (this.stopFlag || next >= tasks.length) return finish(); const t = tasks[next++]; e.busy = true; e.ep.postMessage({ type: 'run', idx: t.idx, overrides: t.overrides, trades: !!t.trades }); };
        e.handler = m => {
          if (m.type === 'crash') { e.dead = true; firstErr ||= m.error; return finish(); }
          if (m.type === 'error' && m.idx == null) e.job = null;
          if (m.type === 'ready') { t0 ||= performance.now(); return give(); }
          if (m.type === 'error' && m.idx == null) { firstErr ||= m.error; return finish(); }
          if (m.type === 'result' || m.type === 'error') {
            const res: OptRes = m.type === 'error' ? { fail: m.error } : m.res;
            if (res.fail) firstErr ||= res.fail;
            onResult(m.idx, res); give();
          }
        };
        if (e.job === job) { t0 ||= performance.now(); give(); }
        else { e.job = job; e.ep.postMessage({ type: 'init', job }); }
      }
    });
    this.wake = null;
    if (this.stopFlag) for (const e of pool) if (e.busy) { e.dead = true; try { e.ep.terminate(); } catch { /* */ } } // cut off mid-run
    this.list = this.list.filter(e => !e.dead);
    for (const e of this.list) { e.handler = null; e.busy = false; }
    this.idle();
    return { firstErr, t0 };
  }
  /** a RunTasks for optimize(): this pool, this job, n workers */
  runner(job: OptJob, n: number): RunTasks { return (tasks, onResult) => this.exec(job, tasks, n, onResult); }
  /** stops the runs in progress: busy workers are terminated (and replaced next time) */
  stop() { this.stopFlag = true; if (this.wake) this.wake(); }
  close() { this.pause(); for (const e of this.list) { e.dead = true; try { e.ep.terminate(); } catch { /* */ } } this.list = []; }
}
