// What can be done to a drawing from its toolbar, its menu, the object tree and the keyboard.
import type { Session } from '../../core/session';
import type { Drawing } from '../../core/drawings';
import { ds, setDs } from './state';
import { TOOL } from './tools';
import { layers } from './overlay';

export function removeDrawing(s: Session, id: string) {
  s.drawings.remove(id);
  if (ds.selected === id) setDs({ selected: null, editing: null });
}
/** a copy a few bars to the right, selected */
export function cloneDrawing(s: Session, id: string) {
  const src = s.drawings.get(id); if (!src) return;
  const layer = [...layers].find(l => l.sym === src.sym);
  const d = s.drawings.clone(id, p => TOOL[src.tool]?.screen ? { t: Math.min(0.95, p.t + 0.03), p: Math.min(0.95, p.p + 0.03) } : layer ? { t: layer.tOf(layer.logical(p.t) + 5), p: p.p } : { ...p });
  if (d) setDs({ selected: d.id });
}
export const toggleLock = (s: Session, d: Drawing) => s.drawings.update(d.id, { locked: !d.locked });
export const toggleHide = (s: Session, d: Drawing) => s.drawings.update(d.id, { hidden: !d.hidden });

/** the plain-English name of a drawing in lists */
export function drawingName(d: Drawing) {
  const t = TOOL[d.tool], txt = d.style.text?.trim();
  return `${t?.name || d.tool}${txt ? ` · “${txt.length > 24 ? txt.slice(0, 24) + '…' : txt}”` : ''}`;
}

/** a long or short position drawing turned into a real order: limit or stop at its entry (market when the price is
 * there), with its stop and target, sized by its risk */
export function placeFromPosition(s: Session, d: Drawing): string | null {
  if ((d.tool !== 'long' && d.tool !== 'short') || d.pts.length < 4) return null;
  const f = s.feeds.find(x => x.s.inst.sym === d.sym); if (!f || f.price == null) return 'This market has no price yet. Press play first.';
  const side = d.tool === 'long' ? 1 : -1, [E, , T, S] = d.pts, inst = f.s.inst;
  const entry = f.round(E.p), sl = f.round(S.p), tp = f.round(T.p), per = Math.abs(entry - sl) * inst.pv;
  const qty = per > 0 ? Math.max(1, Math.floor(+(d.style.opt.risk || 200) / per)) : 1;
  const now = f.price, near = Math.abs(entry - now) < inst.tick / 2;
  const type = near ? 'market' : (side > 0) === (entry < now) ? 'limit' : 'stop';
  return s.order(side as 1 | -1, type, entry, sl, tp, qty, d.sym);
}
