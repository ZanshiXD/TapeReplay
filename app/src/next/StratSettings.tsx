// The strategy's settings on the Backtest page: the constants at the top of its code (the ones the optimizer reads,
// plus times of day like "09:30", which the optimizer leaves out), each with an editor. Changing one rewrites that
// line of the code (only its value, keeping comments and layout), as "Use in code" does; the code saves as typing does.
import { useEffect, useRef, useState } from 'react';
import type { Setting } from '../core/backtest';
import { jsApply, jsParams } from '../core/jsstrategy';
import { pyParams, pySetValues } from '../core/pybridge';
import type { Lang } from './backtest';
import { python } from './backtest';
import { pref, setPref } from './live';
import { IChev } from './icons';
import { copyLine, copySettings } from './copysettings';
import { pyInds, pyScripts, scriptLang, setPyInds, setPyScripts } from './py/prefs';

/** the indicators to copy into: Your scripts and the ones on the charts, by name */
function indicatorNames(): string[] { return [...new Set([...Object.keys(pyScripts()), ...pyInds().map(x => x.name)])].sort((a, b) => a.localeCompare(b)); }
/** this strategy's settings into an indicator (its saved script and every copy of it on the charts); what happened */
async function toIndicator(code: string, lang: Lang, stratName: string, ind: string): Promise<{ text: string; ok: boolean }> {
  const saved = pyScripts()[ind], onCharts = pyInds().filter(x => x.name === ind);
  const target = saved != null ? { code: saved, lang: scriptLang(ind) } : onCharts[0] ? { code: onCharts[0].code, lang: onCharts[0].lang || 'py' as const } : null;
  if (!target) return { text: `There is no indicator called “${ind}”.`, ok: false };
  const r = await copySettings({ code, lang }, target);
  if ('error' in r) return { text: r.error, ok: false };
  if (r.code !== target.code) {
    if (saved != null) setPyScripts({ ...pyScripts(), [ind]: r.code });
    if (onCharts.length) setPyInds(pyInds().map(x => x.name === ind && (x.lang || 'py') === target.lang ? { ...x, code: r.code } : x));
  }
  const where = onCharts.length ? ' and its chart copy' : '';
  return { text: copyLine(r, stratName).replace(/^Copied (\d+) settings? from “[^”]*”/, m => m.replace(' from', ` to “${ind}”${where} from`)), ok: r.copied.length > 0 };
}

export interface SetRow { name: string; kind: 'int' | 'float' | 'bool' | 'choice' | 'time'; value: Setting; line: number; comment: string; money: boolean; choices?: Setting[] }

const PY_TIME = /^([A-Z][A-Z0-9_]*)\s*=\s*(["'])(\d{1,2}:\d{2}(?::\d{2})?)\2\s*(?:#\s*(.*))?$/;
const JS_TIME = /^(?:const|let|var)\s+([A-Z][A-Z0-9_]*)\s*=\s*(["'])(\d{1,2}:\d{2}(?::\d{2})?)\2\s*;?\s*(?:\/\/\s*(.*))?$/;
const TIME_OK = /^([01]?\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

/** time-of-day settings (one per line, at the top level), which the optimizer's reader skips */
export function timeSettings(code: string, lang: Lang): SetRow[] {
  const re = lang === 'py' ? PY_TIME : JS_TIME, out: SetRow[] = [];
  code.split('\n').forEach((l, k) => { const m = l.match(re); if (m) out.push({ name: m[1], kind: 'time', value: m[3], line: k + 1, comment: (m[4] || '').trim(), money: false }); });
  return out;
}
/** the code with a time setting's value replaced (only the text between its quotes) */
export function setTime(code: string, lang: Lang, name: string, v: string): string | null {
  const re = lang === 'py' ? PY_TIME : JS_TIME, ls = code.split('\n');
  for (let k = 0; k < ls.length; k++) {
    const m = ls[k].match(re); if (!m || m[1] !== name) continue;
    const q = m[2], at = ls[k].indexOf(q + m[3] + q);
    ls[k] = ls[k].slice(0, at) + q + v + q + ls[k].slice(at + m[3].length + 2);
    return ls.join('\n');
  }
  return null;
}
/** what is typed for a setting, checked: the value to write, or what is wrong */
export function readValue(r: SetRow, text: string): { v: Setting } | { error: string } {
  const t = text.trim();
  if (r.kind === 'int') return /^-?\d+$/.test(t) ? { v: parseInt(t, 10) } : { error: 'A whole number, like 20' };
  if (r.kind === 'float') { const x = Number(t); return t !== '' && isFinite(x) ? { v: x } : { error: 'A number, like 2.5' }; }
  if (r.kind === 'time') return TIME_OK.test(t) ? { v: t.length === 4 ? '0' + t : t } : { error: 'A time like 09:30' };
  return { v: text };
}
const show = (r: SetRow, v: Setting) => r.kind === 'float' && typeof v === 'number' && Number.isInteger(v) ? v.toFixed(1) : String(v);

export function StratSettings({ code, lang, onCode, readOnly, name = 'this strategy' }: { code: string; lang: Lang; onCode: (c: string) => void; readOnly?: boolean; name?: string }) {
  const [copied, setCopied] = useState<{ text: string; ok: boolean } | null>(null);
  const [rows, setRows] = useState<SetRow[]>([]);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [bad, setBad] = useState<Record<string, string>>({});
  const [open, setOpenS] = useState(() => pref('btSetOpen', true));
  const setOpen = (b: boolean) => { setOpenS(b); setPref('btSetOpen', b); };
  const first = useRef(true);
  const codeRef = useRef(code); codeRef.current = code;

  // read the settings again as the code changes (at once the first time, then after typing pauses)
  useEffect(() => {
    let gone = false;
    const t = setTimeout(async () => {
      try {
        if (lang === 'py') setLoading(true);
        const r = lang === 'py' ? pyParams(await python(), code) : jsParams(code);
        if (gone) return;
        setLoading(false);
        if ('error' in r) { setErr(String(r.error).split('\n')[0]); return; }
        setErr('');
        const ps: SetRow[] = (r.params as Array<{ name: string; kind: SetRow['kind']; value: Setting; line: number; comment?: string; money?: boolean; choices?: Setting[] }>)
          .map(p => ({ name: p.name, kind: p.kind, value: p.value, line: p.line, comment: p.comment || '', money: !!p.money, choices: p.choices }));
        setRows([...ps, ...timeSettings(code, lang).filter(x => !ps.some(p => p.name === x.name))].sort((a, b) => a.line - b.line));
      } catch (e) { if (!gone) { setLoading(false); setErr((e as Error).message); } }
    }, first.current ? 0 : 400);
    first.current = false;
    return () => { gone = true; clearTimeout(t); };
  }, [code, lang]);
  // a new strategy: start again
  useEffect(() => { setDraft({}); setBad({}); }, [lang]);

  async function write(r: SetRow, v: Setting) {
    try {
      const h = lang === 'py' && r.kind !== 'time' ? await python() : null, c = codeRef.current;
      let out: string | null;
      if (r.kind === 'time') out = setTime(c, lang, r.name, String(v));
      else { const res = h ? pySetValues(h, c, { [r.name]: v }) : jsApply(c, { [r.name]: v }); if ('error' in res) { setBad(b => ({ ...b, [r.name]: res.error })); return; } out = res.code; }
      if (out == null) { setBad(b => ({ ...b, [r.name]: `${r.name} is not in the code any more.` })); return; }
      setBad(b => { const n = { ...b }; delete n[r.name]; return n; });
      setRows(rs => rs.map(x => x.name === r.name ? { ...x, value: v } : x));
      if (out !== c) { codeRef.current = out; onCode(out); }
    } catch (e) { setBad(b => ({ ...b, [r.name]: (e as Error).message })); }
  }
  const typed = (r: SetRow, text: string) => {
    setDraft(d => ({ ...d, [r.name]: text }));
    const x = readValue(r, text);
    if ('error' in x) setBad(b => ({ ...b, [r.name]: x.error }));
    else write(r, x.v);
  };
  const done = (r: SetRow) => setDraft(d => { const n = { ...d }; delete n[r.name]; return n; });
  const locked = readOnly || !!err;
  const editor = (r: SetRow) => {
    const label = `Value of ${r.name}`, b = bad[r.name];
    if (r.kind === 'bool') return <input type="checkbox" aria-label={label} disabled={locked} checked={!!r.value} onChange={e => write(r, e.target.checked)} />;
    if (r.kind === 'choice' && r.choices && r.choices.length > 1) return <select className="in ui bt-setin" aria-label={label} disabled={locked} value={String(r.value)} onChange={e => write(r, e.target.value)}>{r.choices.map(c => <option key={String(c)} value={String(c)}>{String(c)}</option>)}</select>;
    return <input className={'in bt-setin' + (b ? ' bad' : '') + (r.kind === 'choice' ? ' ui' : '')} aria-label={label} aria-invalid={!!b} title={b || undefined} disabled={locked}
      inputMode={r.kind === 'int' ? 'numeric' : r.kind === 'float' ? 'decimal' : undefined} value={draft[r.name] ?? show(r, r.value)}
      onChange={e => typed(r, e.target.value)} onBlur={() => { if (!bad[r.name]) done(r); }} onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { done(r); setBad(x => { const n = { ...x }; delete n[r.name]; return n; }); } }} />;
  };
  const how = lang === 'py' ? 'NAME = value at the top of the code, like FAST = 9  # candles' : 'const NAME = value; at the top of the code, like const FAST = 9;  // candles';
  return (
    <section className="card bt-set bt-fold" aria-label="Settings" data-open={open}>
      <button className="bt-foldhead" aria-expanded={open} onClick={() => setOpen(!open)}>
        <IChev className="chev" /><b>Settings</b>
        {!open && rows.length > 0 && <span className="muted bt-sum">{rows.slice(0, 6).map(r => `${r.name} ${show(r, r.value)}`).join(' · ')}{rows.length > 6 ? ' …' : ''}</span>}
        <span className="spacer" /><span className="muted bt-meta">{loading && !rows.length ? 'Loading Python to read the settings…' : `${rows.length} setting${rows.length === 1 ? '' : 's'}`}</span>
      </button>
      {open && <div className="bt-setcopy">
        <select className="in ui" aria-label="Copy these settings to an indicator" title="Set an indicator's settings to these, for every setting with the same name" value=""
          disabled={!rows.length || !!err} onChange={async e => { const v = e.target.value; e.target.value = ''; if (!v) return; setCopied({ text: 'Copying…', ok: true }); try { setCopied(await toIndicator(codeRef.current, lang, name, v)); } catch (x) { setCopied({ text: (x as Error).message, ok: false }); } }}>
          <option value="">Copy to an indicator…</option>{indicatorNames().map(n => <option key={n} value={n}>{n}</option>)}
        </select>
        {copied && <span className={'bt-copied ' + (copied.ok ? 'up' : 'down')} role="status">{copied.text}</span>}
      </div>}
      {open && <div className="bt-setbody">
        {err && <div className="bt-seterr" role="status">The code has an error ({err}). {rows.length ? 'The settings below can be changed again once it is fixed.' : 'The settings show once it is fixed.'}</div>}
        {!rows.length ? (!err && <div className="empty">{loading ? 'Loading Python to read the settings…' : `No settings yet. Put the numbers you may want to change as ${how}. They show here, and the optimizer can try values for them.`}</div>) :
          <table className="t bt-settable"><thead><tr><th>Setting</th><th>Value</th></tr></thead>
            <tbody>{rows.map(r => <tr key={r.name} className={locked ? 'off' : ''}>
              <td className="ui"><b>{r.name}</b>{r.money && <span className="tag bt-size" title="Sets the size or money">size</span>}{r.kind === 'time' && <span className="tag bt-size">time</span>}{r.comment && <div className="muted bt-cmt">{r.comment}</div>}</td>
              <td>{editor(r)}{bad[r.name] && <div className="down bt-setbad">{bad[r.name]}</div>}</td>
            </tr>)}</tbody></table>}
      </div>}
    </section>
  );
}
