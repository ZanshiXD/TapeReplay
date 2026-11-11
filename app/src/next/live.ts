// The screens' heartbeat. The replay runs on animation frames; charts draw on every frame (frameHooks), while the
// panels (prices, P&L, the clock) re-render about ten times a second through useLive(). Screens that show nothing that
// moves with the prices (the page around the charts, the drawing tools) use useShape(): they re-render when something
// changes (a trade, a setting, a drawing), not ten times a second, which on a slow computer or phone is what leaves
// the charts time to draw smoothly.
import { useSyncExternalStore } from 'react';
import type { Store } from '../core/store';

let version = 0, shape = 0;
const subs = new Set<() => void>(), shapeSubs = new Set<() => void>();
/** tells every screen to re-render: something changed */
export function bump() { version++; shape++; for (const f of subs) f(); for (const f of shapeSubs) f(); }
/** tells the live panels (useLive) to re-render: the prices and the clock moved */
export function pulse() { version++; for (const f of subs) f(); }
/** re-renders the component when bump() or pulse() is called */
export function useLive() {
  return useSyncExternalStore(f => { subs.add(f); return () => { subs.delete(f); }; }, () => version);
}
/** re-renders the component when bump() is called (not on every pulse while the tape plays) */
export function useShape() {
  return useSyncExternalStore(f => { shapeSubs.add(f); return () => { shapeSubs.delete(f); }; }, () => shape);
}
/** called on every animation frame, after the replay moved */
export const frameHooks = new Set<(now: number) => void>();

/* ---- preferences ----
 * Kept with the app's settings (under "next"), so they survive however the
 * app is opened; a copy in this browser makes them available at once while the app's copy loads. */
let P: Record<string, unknown> = {};
try { P = JSON.parse(localStorage.getItem('tr-next-prefs') || 'null') || {}; } catch { /* private window */ }
// older keys, one per preference
try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i)!; if (k.startsWith('tr-next-') && k !== 'tr-next-prefs' && !(k.slice(8) in P)) P[k.slice(8)] = JSON.parse(localStorage.getItem(k)!); } } catch { /* */ }
let storeRef: Store | null = null, whole: Record<string, unknown> = {}, timer = 0;
/** when the preferences last changed (in both copies), so the newer copy wins at the next start */
const STAMP = '_changed';
/** loads the preferences kept by the app (they win over this browser's copy) */
export async function initPrefs(store: Store) {
  storeRef = store;
  try {
    whole = (await store.getPrefs()) || {};
    const n = whole.next as Record<string, unknown> | undefined;
    // the newer copy wins: a change made just before the page closed is in this browser's copy before the app's
    // (which is written a moment later), and must not be undone by the older one on the next start
    if (n) { if (((P[STAMP] as number) || 0) > ((n[STAMP] as number) || 0)) { P = { ...n, ...P }; save(); } else P = { ...P, ...n }; }
  } catch { /* first run */ }
}
export function pref<T>(key: string, def: T): T { return key in P ? P[key] as T : def; }
export function setPref(key: string, v: unknown) {
  P[key] = JSON.parse(JSON.stringify(v ?? null));
  P[STAMP] = Date.now();
  try { localStorage.setItem('tr-next-prefs', JSON.stringify(P)); } catch { /* private window */ }
  clearTimeout(timer);
  timer = window.setTimeout(save, 600);
}
/** writes the preferences to the app's copy (soon after a change, and at once when the page is hidden or closed) */
async function save() {
  clearTimeout(timer); timer = 0;
  if (!storeRef) return;
  try { whole = { ...((await storeRef.getPrefs()) || {}), next: P }; await storeRef.savePrefs(whole); } catch { /* kept in this browser */ }
}
const flush = () => { if (timer) save(); };
if (typeof window !== 'undefined') {
  addEventListener('pagehide', flush);
  addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
}
