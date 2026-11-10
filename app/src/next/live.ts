// The screens' heartbeat. The replay runs on animation frames; charts draw on every frame (frameHooks), while the
// panels (prices, P&L, the clock) re-render about ten times a second through useLive().
import { useSyncExternalStore } from 'react';

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

/** small persistent preferences (tips seen, layout), in this browser */
export function pref<T>(key: string, def: T): T {
  try { const v = localStorage.getItem('tr-next-' + key); return v == null ? def : JSON.parse(v); } catch { return def; }
}
export function setPref(key: string, v: unknown) { try { localStorage.setItem('tr-next-' + key, JSON.stringify(v)); } catch { /* private window */ } }
