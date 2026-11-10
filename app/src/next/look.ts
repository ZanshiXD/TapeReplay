// How the app looks and tells time: the theme (the classic view's palettes, light or dark, or following the system),
// the candle and chart colors, the chart time zone and when a trading day starts. Kept with the preferences; applyLook()
// puts them in force: CSS tokens on <html>, the chart colors in C, the zone in core/time. Charts and pages that draw
// with colors or times call onLook() to hear of a change (most just re-render, which bump() already does).
import { setDayStart, setZone } from '../core/time';
import { bump, pref } from './live';

export interface Palette { id: string; name: string; kind: 'dark' | 'light'; note?: string; v: Record<string, string> }
/** the palettes: this app's own dark look, then the classic view's 14 (same ids, names and colors) */
export const PALETTES: Palette[] = [
  { id: 'tape', name: 'Tape', kind: 'dark', note: 'This app’s own dark look', v: { bg: '#0b0e13', panel: '#10131a', raise: '#191d26', line: '#232833', grid: '#161a22', fg: '#d1d4dc', muted: '#8a91a0', accent: '#2962ff', 'accent-ink': '#ffffff', up: '#26a69a', down: '#ef5350' } },
  { id: 'terminal', name: 'Terminal', kind: 'dark', v: { bg: '#0c1016', panel: '#121820', raise: '#18202b', line: '#242e3b', grid: '#161d26', fg: '#d6dce6', muted: '#8692a4', accent: '#e2a63c', 'accent-ink': '#1b1306', up: '#2db38a', down: '#e5554c' } },
  { id: 'midnight', name: 'Midnight', kind: 'dark', v: { bg: '#0a101d', panel: '#0f182a', raise: '#152036', line: '#22304b', grid: '#121c30', fg: '#dbe4f3', muted: '#8a98b4', accent: '#5b9cf5', 'accent-ink': '#06101f', up: '#26b48c', down: '#ef5b5b' } },
  { id: 'graphite', name: 'Graphite', kind: 'dark', v: { bg: '#141414', panel: '#1c1c1c', raise: '#252525', line: '#343434', grid: '#202020', fg: '#e6e6e6', muted: '#9b9b9b', accent: '#4fb3bf', 'accent-ink': '#061a1d', up: '#3cb371', down: '#e0544f' } },
  { id: 'oled', name: 'True black', kind: 'dark', note: 'For OLED screens', v: { bg: '#000000', panel: '#000000', raise: '#0e0e0e', line: '#262626', grid: '#0d0d0d', fg: '#ececec', muted: '#8c8c8c', accent: '#e2a63c', 'accent-ink': '#1b1306', up: '#22c58b', down: '#ff5a52' } },
  { id: 'forest', name: 'Forest', kind: 'dark', v: { bg: '#0c1411', panel: '#111c17', raise: '#17251e', line: '#24362c', grid: '#14201a', fg: '#d6e4da', muted: '#87a294', accent: '#8bc97e', 'accent-ink': '#08160a', up: '#43c08f', down: '#e8735a' } },
  { id: 'dusk', name: 'Dusk', kind: 'dark', v: { bg: '#131019', panel: '#1a1623', raise: '#221d2e', line: '#312a42', grid: '#1a1623', fg: '#e3ddef', muted: '#998fae', accent: '#c38bf2', 'accent-ink': '#1a0b28', up: '#2fbf9b', down: '#f2668b' } },
  { id: 'mocha', name: 'Mocha', kind: 'dark', note: 'Warm brown', v: { bg: '#1b1510', panel: '#231b15', raise: '#2c231b', line: '#3d3127', grid: '#251d16', fg: '#ecdfcc', muted: '#a8957d', accent: '#d4a373', 'accent-ink': '#22160a', up: '#6fbf8a', down: '#e07a5f' } },
  { id: 'espresso', name: 'Espresso', kind: 'dark', note: 'Deep brown', v: { bg: '#110c08', panel: '#18110c', raise: '#211811', line: '#33261b', grid: '#19120d', fg: '#f3e8d6', muted: '#b09a80', accent: '#c8956b', 'accent-ink': '#1d120a', up: '#5fb383', down: '#d96a4f' } },
  { id: 'contrast', name: 'High contrast', kind: 'dark', v: { bg: '#000000', panel: '#000000', raise: '#141414', line: '#7a7a7a', grid: '#1f1f1f', fg: '#ffffff', muted: '#d0d0d0', accent: '#ffd400', 'accent-ink': '#000000', up: '#00e08a', down: '#ff5c5c' } },
  { id: 'paper', name: 'Paper', kind: 'light', v: { bg: '#eef1f5', panel: '#ffffff', raise: '#f5f7fa', line: '#d5dbe4', grid: '#eef1f5', fg: '#161e2a', muted: '#5a6678', accent: '#a86a0c', 'accent-ink': '#ffffff', up: '#0e8c66', down: '#cc3a31' } },
  { id: 'arctic', name: 'Arctic', kind: 'light', v: { bg: '#e8eff6', panel: '#ffffff', raise: '#f1f5fa', line: '#cddae6', grid: '#edf2f7', fg: '#0f1f2e', muted: '#516478', accent: '#1f6fd1', 'accent-ink': '#ffffff', up: '#0f9a72', down: '#d23f3f' } },
  { id: 'cream', name: 'Cream', kind: 'light', note: 'Soft cream', v: { bg: '#f5efe3', panel: '#fffaf1', raise: '#f3ebdc', line: '#e2d5bf', grid: '#f0e8d9', fg: '#2e241a', muted: '#7a6955', accent: '#9a6232', 'accent-ink': '#fff8ee', up: '#2f7a4f', down: '#b6463a' } },
  { id: 'latte', name: 'Latte', kind: 'light', note: 'Cream and brown', v: { bg: '#eadfcd', panel: '#f6eddd', raise: '#ede1cc', line: '#d3c0a2', grid: '#e9ddca', fg: '#36271a', muted: '#7a634b', accent: '#7b4a26', 'accent-ink': '#fff4e6', up: '#2e6c45', down: '#a5402d' } },
  { id: 'sand', name: 'Sand', kind: 'light', v: { bg: '#f1ebdf', panel: '#fbf8f2', raise: '#f3ede2', line: '#ddd2bf', grid: '#efe8db', fg: '#2a2319', muted: '#756856', accent: '#b0601a', 'accent-ink': '#ffffff', up: '#2b8a57', down: '#c0392b' } },
];
export const palOf = (id: string) => PALETTES.find(p => p.id === id);
/** up and down pairs that work on any palette (as the classic view's) */
export const CANDLE_SETS: Array<[string, string, string]> = [['#2f7fe0', '#f08a24', 'Blue and orange (color-blind friendly)'], ['#00b386', '#ff3b30', 'Bright green and red'],
  ['#26a69a', '#ef5350', 'Teal and coral'], ['#5b8def', '#e05ca8', 'Blue and pink']];

/** mode: 'system' (the palettes picked for a dark and a light system) or a palette id; empty colors follow the palette */
export interface Theme { mode: string; dark: string; light: string; up: string; down: string; wickUp: string; wickDown: string; border: boolean; chartBg: string; grid: string }
export const THEME_DEF: Theme = { mode: 'system', dark: 'tape', light: 'paper', up: '', down: '', wickUp: '', wickDown: '', border: false, chartBg: '', grid: '' };
export const theme = (): Theme => ({ ...THEME_DEF, ...pref<Partial<Theme>>('theme', {}) });

/* ---- time zones (as the classic view's) ---- */
export const ZONES: Array<[string, string]> = [['local', 'Your computer’s time'], ['UTC', 'UTC'], ['America/New_York', 'New York'], ['America/Chicago', 'Chicago'],
  ['America/Los_Angeles', 'Los Angeles'], ['Europe/London', 'London'], ['Europe/Berlin', 'Frankfurt'], ['Asia/Tokyo', 'Tokyo'], ['Asia/Hong_Kong', 'Hong Kong'], ['Australia/Sydney', 'Sydney']];
export const FIXED_OFFSETS = [-12, -11, -10, -9, -8, -7, -6, -5, -4, -3, -2, -1, 1, 2, 3, 4, 5, 5.5, 6, 7, 8, 9, 9.5, 10, 11, 12, 13, 14];
export const fixedId = (h: number) => `UTC${h < 0 ? '-' : '+'}${Math.abs(h)}`;

/* ---- colors ---- */
const rgb = (h: string) => { const m = h.replace('#', ''), f = m.length === 3 ? m.split('').map(x => x + x).join('') : m; const n = parseInt(f.slice(0, 6), 16); return [n >> 16, (n >> 8) & 255, n & 255]; };
/** a + (b - a) * t, as #rrggbb */
export const mix = (a: string, b: string, t: number) => { const x = rgb(a), y = rgb(b); return '#' + x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join(''); };
export const hexA = (h: string, a: number) => { const [r, g, b] = rgb(h); return `rgba(${r},${g},${b},${a})`; };

/** the chart's colors now (read them when drawing: they change with the theme) */
export const C = { bg: '#10131a', grid: '#161a22', line: '#232833', text: '#8a91a0', fg: '#d1d4dc', up: '#26a69a', down: '#ef5350', wickUp: '#26a69a', wickDown: '#ef5350', border: false,
  accent: '#2962ff', accentFg: '#7aa2ff', onAccent: '#ffffff', warn: '#f0b54a', upFg: '#4fd1c0', downFg: '#ff8a86', field: '#0d1016', light: false };

/** every CSS token of theme.css for a palette, with the up and down colors given */
function tokens(p: Palette, up: string, down: string): Record<string, string> {
  const v = p.v, dk = p.kind === 'dark';
  if (p.id === 'tape') return {}; // theme.css's own values
  return {
    bg: v.bg, nav: dk ? mix(v.bg, v.panel, 0.5) : v.panel, panel: v.panel, raise: v.raise, raise2: mix(v.raise, v.fg, dk ? 0.04 : 0.05), field: dk ? mix(v.bg, v.panel, 0.5) : v.panel,
    line: v.line, line2: mix(v.line, v.fg, dk ? 0.05 : 0.08), 'line-soft': mix(v.line, v.panel, 0.45), edge: mix(v.line, v.fg, dk ? 0.15 : 0.25), grid: v.grid,
    fg: v.fg, fg2: mix(v.fg, v.muted, 0.35), strong: dk ? mix(v.fg, '#ffffff', 0.6) : mix(v.fg, '#000000', 0.4), muted: v.muted, faint: mix(v.muted, v.bg, 0.45),
    accent: v.accent, 'accent-fg': dk ? mix(v.accent, '#ffffff', 0.3) : mix(v.accent, '#000000', 0.1), 'accent-soft': hexA(v.accent, dk ? 0.16 : 0.12), 'on-accent': v['accent-ink'],
    up, 'up-fg': dk ? mix(up, '#ffffff', 0.25) : mix(up, '#000000', 0.1), 'up-soft': hexA(up, dk ? 0.14 : 0.12),
    down, 'down-fg': dk ? mix(down, '#ffffff', 0.25) : mix(down, '#000000', 0.1), 'down-soft': hexA(down, dk ? 0.12 : 0.1),
    warn: dk ? '#f0b54a' : '#a8670a', 'warn-soft': dk ? 'rgba(240,181,74,.14)' : 'rgba(168,103,10,.12)', py: dk ? '#c3aef7' : '#6b4fc9', 'py-soft': dk ? 'rgba(171,140,242,.14)' : 'rgba(107,79,201,.1)',
    hover: hexA(v.fg, dk ? 0.08 : 0.06), tip: dk ? mix(v.raise, v.accent, 0.08) : mix(v.panel, v.accent, 0.06), 'tip-line': mix(v.line, v.accent, dk ? 0.25 : 0.3), toast: dk ? mix(v.raise, v.fg, 0.06) : v.panel,
    shadow: dk ? '0 16px 40px rgba(0,0,0,.45), 0 2px 8px rgba(0,0,0,.25)' : '0 12px 32px rgba(15,23,42,.14), 0 2px 6px rgba(15,23,42,.08)',
  };
}
/** the palette in use */
export function activePalette(th = theme()): Palette {
  const dark = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)').matches : true;
  return palOf(th.mode === 'system' ? (dark ? th.dark : th.light) : th.mode) || palOf(th.mode === 'system' && !dark ? 'paper' : 'tape')!;
}
const vars = (th: Theme, p: Palette) => {
  const up = th.up || p.v.up, down = th.down || p.v.down, t = tokens(p, up, down);
  if (p.id === 'tape' && (th.up || th.down)) Object.assign(t, { up, down, 'up-fg': mix(up, '#ffffff', 0.25), 'down-fg': mix(down, '#ffffff', 0.25), 'up-soft': hexA(up, 0.14), 'down-soft': hexA(down, 0.12) });
  return t;
};

const subs = new Set<(what: { time: boolean; colors: boolean }) => void>();
/** hears of a change of theme or colors (colors) or of time zone or day start (time); returns the unsubscribe */
export function onLook(fn: (what: { time: boolean; colors: boolean }) => void) { subs.add(fn); return () => { subs.delete(fn); }; }
let lastTime = '', lastColors = '';

/** puts the saved look in force; tells the charts and re-renders the pages when something changed */
export function applyLook() {
  const tz = pref('tz', 'local'), day = pref('dayStart', 18), th = theme(), p = activePalette(th);
  const timeKey = `${tz}|${day}`, colorKey = JSON.stringify([th, p.id]);
  const what = { time: timeKey !== lastTime, colors: colorKey !== lastColors };
  if (what.time) { setZone(tz); setDayStart(day); lastTime = timeKey; }
  if (what.colors) {
    lastColors = colorKey;
    const root = document.documentElement, t = vars(th, p);
    for (const k of [...root.style].filter(x => x.startsWith('--'))) if (!(k.slice(2) in t)) root.style.removeProperty(k);
    for (const [k, v] of Object.entries(t)) root.style.setProperty('--' + k, v);
    root.dataset.theme = p.kind; root.dataset.pal = p.id; root.style.colorScheme = p.kind;
    const css = (n: string) => getComputedStyle(root).getPropertyValue('--' + n).trim();
    const up = css('up'), down = css('down');
    Object.assign(C, { bg: th.chartBg || css('panel'), grid: th.grid || css('grid'), line: css('line'), text: css('muted'), fg: css('fg'), up, down, wickUp: th.wickUp || up, wickDown: th.wickDown || down, border: th.border,
      accent: css('accent'), accentFg: css('accent-fg'), onAccent: css('on-accent'), warn: css('warn'), upFg: css('up-fg'), downFg: css('down-fg'), field: css('field'), light: p.kind === 'light' });
    // remembered for the next start, so a light theme does not open with a flash of the dark one (see next.html)
    try {
      const one = (q: Palette) => ({ kind: q.kind, v: vars(th, q) });
      localStorage.setItem('tr-next-look', JSON.stringify(th.mode === 'system' ? { sys: true, dark: one(palOf(th.dark) || p), light: one(palOf(th.light) || p) } : { dark: one(p), light: one(p) }));
    } catch { /* private window */ }
  }
  if (what.time || what.colors) { for (const f of subs) f(what); bump(); }
}
/** the candle series' colors now */
export const candleColors = () => ({ upColor: C.up, downColor: C.down, wickUpColor: C.wickUp, wickDownColor: C.wickDown, borderVisible: C.border, borderUpColor: C.wickUp, borderDownColor: C.wickDown });
// "Match my system" follows the system's light or dark setting as it changes
try { matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyLook()); } catch { /* old browser */ }
