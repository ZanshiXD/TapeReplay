// What the drawing toolbar has chosen, shared by every chart: the tool, the magnet, "stay in drawing mode", the
// selected drawing, the last tool used in each group, and the saved templates.
import type { DrawStyle } from '../../core/drawings';
import { bump, pref, setPref } from '../live';
import type { Group } from './tools';

export type Magnet = 'off' | 'weak' | 'strong';
export interface DrawUi {
  tool: string;
  magnet: Magnet;
  stay: boolean;
  selected: string | null;
  /** the settings dialog: which drawing, which tab */
  editing: { id: string; tab: 'style' | 'text' | 'coords' | 'vis' } | null;
  tree: boolean;
  hideAll: boolean;
  last: Partial<Record<Group, string>>;
  favs: string[];
  /** bumps on every change, so the charts redraw */
  version: number;
}

export const ds: DrawUi = {
  tool: pref('drawCursor', 'cross'), magnet: pref<Magnet>('magnet', 'off'), stay: pref('drawStay', false), selected: null, editing: null, tree: false, hideAll: false,
  last: pref('drawLast', {}), favs: pref('drawFavs', ['trend', 'hline', 'fib', 'rect', 'long', 'short']), version: 0,
};
export function setDs(p: Partial<DrawUi>) {
  Object.assign(ds, p); ds.version++;
  if ('magnet' in p) setPref('magnet', ds.magnet);
  if ('stay' in p) setPref('drawStay', ds.stay);
  if ('last' in p) setPref('drawLast', ds.last);
  if ('favs' in p) setPref('drawFavs', ds.favs);
  if ('tool' in p && ['cross', 'dot', 'arrow'].includes(ds.tool)) setPref('drawCursor', ds.tool);
  bump();
}
/** the cursor to go back to after drawing */
export const cursorTool = () => pref('drawCursor', 'cross');

/* templates: a style saved as a tool's default, used for every new drawing of that tool */
export function templates(): Record<string, Partial<DrawStyle>> { return pref('drawTpl', {}); }
export function saveTemplate(tool: string, style: DrawStyle) { const t = templates(); t[tool] = JSON.parse(JSON.stringify(style)); setPref('drawTpl', t); }
export function resetTemplate(tool: string) { const t = templates(); delete t[tool]; setPref('drawTpl', t); }
