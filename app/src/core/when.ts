// "only when …" notes in a setting's comment (see the optimizer): parsed here, apart from the optimizer, so the
// settings readers can leave them out of a choice's options without importing it.
import type { Setting } from './backtest';
export interface When { on: string; vals: Setting[] | null; not: boolean; text: string }
const W_TOKEN = String.raw`(?:"[^"\n]*"|'[^'\n]*'|-?\d+(?:\.\d+)?|[A-Za-z_]\w*)`;
const WHEN_SRC = String.raw`\bonly (?:when|if) (not )?([A-Za-z_]\w*)(?:\s+is\s+(not\s+)?(${W_TOKEN}(?:\s*(?:,|\bor\b)\s*${W_TOKEN})*))?`;
const wToken = (t: string): Setting => /^["']/.test(t) ? t.slice(1, -1) : /^-?\d/.test(t) ? +t : /^true$/i.test(t) ? true : /^false$/i.test(t) ? false : t;
/** the "only when …" note in a setting's comment, if it has one */
export function parseWhen(comment: string | undefined): When | null {
  const m = comment ? new RegExp(WHEN_SRC, 'i').exec(comment) : null;
  if (!m) return null;
  const vals = m[4] ? (m[4].match(new RegExp(W_TOKEN, 'g')) || []).filter(t => !/^or$/i.test(t)).map(wToken) : null;
  return { on: m[2], vals, not: !!m[1] !== !!m[3] ? true : false, text: m[0] };
}
/** a comment without its "only when …" note (so its quoted values are not taken for a choice's options) */
export const stripWhen = (comment: string) => comment.replace(new RegExp(WHEN_SRC, 'gi'), '');
export const sameVal = (a: Setting, b: Setting) => a === b || (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 1e-9) || (typeof a === 'string' && typeof b === 'string' && a.trim().toLowerCase() === b.trim().toLowerCase());
