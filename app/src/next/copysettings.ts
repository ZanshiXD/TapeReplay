// Copying a strategy's settings into an indicator: the NAME = value lines at the top of both, matched by name (times
// like "18:00" included). Only the values change in the indicator's code; its comments and layout stay. Python code
// is read and written by the indicators' Python (the worker), JavaScript here.
import type { Setting } from '../core/backtest';
import { jsApply, jsParams } from '../core/jsstrategy';
import { pyCall, pyLoad } from './py/client';
import { setTime, timeSettings } from './StratSettings';

type Lang = 'py' | 'js';
export interface Script { code: string; lang: Lang }
interface Found { name: string; value: Setting; kind: string; time: boolean }
export interface Copied { code: string; copied: string[]; same: string[]; missing: string[]; skipped: string[] }

/** the settings at the top of a script, times included; or what stops them being read */
async function settingsOf(s: Script): Promise<Found[] | string> {
  let r: { error?: string; params?: Array<{ name: string; value: Setting; kind: string }> };
  if (s.lang === 'js') r = jsParams(s.code) as typeof r;
  else { await pyLoad(); r = JSON.parse(await pyCall<string>('_tr_params', [s.code]) || '{}'); }
  if (r.error) return r.error.split('\n')[0];
  const out: Found[] = (r.params || []).map(p => ({ name: p.name, value: p.value, kind: p.kind, time: false }));
  for (const t of timeSettings(s.code, s.lang)) if (!out.some(p => p.name === t.name)) out.push({ name: t.name, value: t.value, kind: 'time', time: true });
  return out;
}

/** the indicator's code with every setting the strategy also has set to the strategy's value */
export async function copySettings(from: Script, to: Script): Promise<Copied | { error: string }> {
  const src = await settingsOf(from);
  if (typeof src === 'string') return { error: `The strategy's settings can't be read: ${src}` };
  const dst = await settingsOf(to);
  if (typeof dst === 'string') return { error: `The indicator's settings can't be read: ${dst}` };
  const vals: Record<string, Setting> = {}, times: Array<[string, string]> = [], out: Copied = { code: to.code, copied: [], same: [], missing: [], skipped: [] };
  for (const s of src) {
    const d = dst.find(x => x.name === s.name);
    if (!d) { out.missing.push(s.name); continue; }
    if (d.value === s.value) { out.same.push(s.name); continue; }
    // the indicator's setting must be able to take the value: a number for a number, a time for a time...
    const ok = d.time ? s.time : d.kind === 'bool' ? typeof s.value === 'boolean' : d.kind === 'int' ? typeof s.value === 'number' && Number.isInteger(s.value)
      : d.kind === 'float' ? typeof s.value === 'number' : typeof s.value === 'string' && !s.time;
    if (!ok) { out.skipped.push(s.name); continue; }
    if (d.time) times.push([s.name, String(s.value)]); else vals[s.name] = s.value;
    out.copied.push(s.name);
  }
  let code = to.code;
  if (Object.keys(vals).length) {
    const r = (to.lang === 'js' ? jsApply(code, vals) : JSON.parse(await pyCall<string>('_tr_setvals', [code, JSON.stringify(vals)]) || '{}')) as { code?: string; error?: string };
    if (r.error || r.code == null) return { error: r.error || 'The settings could not be written into the indicator.' };
    code = r.code;
  }
  for (const [n, v] of times) code = setTime(code, to.lang, n, v) ?? code;
  out.code = code;
  return out;
}

/** a one-line account of a copy, for the console or a status line */
export function copyLine(r: Copied, from: string): string {
  const list = (a: string[]) => a.length > 6 ? `${a.slice(0, 6).join(', ')} and ${a.length - 6} more` : a.join(', ');
  if (!r.copied.length && !r.same.length) return `“${from}” has no settings with the same names as this indicator's.`;
  return [r.copied.length ? `Copied ${r.copied.length} setting${r.copied.length === 1 ? '' : 's'} from “${from}”: ${list(r.copied)}.` : `The settings shared with “${from}” already match.`,
    r.same.length && r.copied.length ? `${r.same.length} already matched.` : '',
    r.skipped.length ? `Not copied (a different kind of value): ${list(r.skipped)}.` : '',
    r.missing.length ? `Only in the strategy: ${list(r.missing)}.` : ''].filter(Boolean).join(' ');
}
