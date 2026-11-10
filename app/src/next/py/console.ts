// What Python printed, and how each Python indicator is doing: the editor's console shows the lines of the indicator
// open in it (by name); the Indicators list shows which ones stopped with an error.
import { bump } from '../live';

export interface PyLine { tag: string; text: string; kind: string }
export const pyCons = { lines: [] as PyLine[], ver: 0 };
/** name -> the error it stopped with (any chart) */
export const pyErrs = new Map<string, string>();
/** name -> what it is doing, e.g. "Running on 12,000 candles… 40%" */
export const pyBusy = new Map<string, string>();

export function pyLog(tag: string, text: string, kind = '') {
  for (const t of text.split('\n')) pyCons.lines.push({ tag, text: t, kind });
  if (pyCons.lines.length > 1500) pyCons.lines.splice(0, pyCons.lines.length - 1500);
  pyCons.ver++; bump();
}
export function pyClear(tag: string) { pyCons.lines = pyCons.lines.filter(l => l.tag !== tag); pyCons.ver++; bump(); }
