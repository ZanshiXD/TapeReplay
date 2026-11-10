// The screens' heartbeat. The replay runs on animation frames; charts draw on every frame (frameHooks), while the
// panels (prices, P&L, the clock) re-render about ten times a second through useLive().
import { useSyncExternalStore } from 'react';
import type { Store } from '../core/store';

let version = 0;
const subs = new Set<() => void>();
/** tells the panels to re-render */
export function bump() { version++; for (const f of subs) f(); }
/** re-renders the component when bump() is called */
export function useLive() {
  return useSyncExternalStore(f => { subs.add(f); return () => { subs.delete(f); }; }, () => version);
}
/** called on every animation frame, after the replay moved */
export const frameHooks = new Set<(now: number) => void>();

/* ---- preferences ----
 * Kept with the app's settings (the same file the classic view uses, under "next"), so they survive however the
 * app is opened; a copy in this browser makes them available at once while the app's copy loads. */
let P: Record<string, unknown> = {};
try { P = JSON.parse(localStorage.getItem('tr-next-prefs') || 'null') || {}; } catch { /* private window */ }
// older keys, one per preference
try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i)!; if (k.startsWith('tr-next-') && k !== 'tr-next-prefs' && !(k.slice(8) in P)) P[k.slice(8)] = JSON.parse(localStorage.getItem(k)!); } } catch { /* */ }
let storeRef: Store | null = null, whole: Record<string, unknown> = {}, timer = 0;
/** loads the preferences kept by the app (they win over this browser's copy) */
export async function initPrefs(store: Store) {
  storeRef = store;
  try { whole = (await store.getPrefs()) || {}; const n = whole.next as Record<string, unknown> | undefined; if (n) P = { ...P, ...n }; } catch { /* first run */ }
}
export function pref<T>(key: string, def: T): T { return key in P ? P[key] as T : def; }
export function setPref(key: string, v: unknown) {
  P[key] = JSON.parse(JSON.stringify(v ?? null));
  try { localStorage.setItem('tr-next-prefs', JSON.stringify(P)); } catch { /* private window */ }
  clearTimeout(timer);
  timer = window.setTimeout(async () => {
    if (!storeRef) return;
    try { whole = { ...((await storeRef.getPrefs()) || {}), next: P }; await storeRef.savePrefs(whole); } catch { /* kept in this browser */ }
  }, 600);
}
