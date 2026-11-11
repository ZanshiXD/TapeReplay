// The drag handles on the Replay screen: the top edge of the panel under the charts (its height) and the left edge of
// the trade panel (its width). The size lives in a CSS variable on the screen (.work), set straight on the element while
// dragging, so nothing re-renders and the charts (autoSize) simply follow; it is saved as a preference when the drag ends.
import { useLayoutEffect, useRef } from 'react';
import { pref, setPref } from './live';

export type SplitKind = 'dock' | 'side';
const CFG = {
  dock: { key: 'dockH', v: '--dock-h', def: 210, min: 120, label: 'Resize the panel under the chart', orient: 'horizontal', grow: 'ArrowUp', shrink: 'ArrowDown' },
  side: { key: 'sideW', v: '--side-w', def: 330, min: 280, label: 'Resize the trade panel', orient: 'vertical', grow: 'ArrowLeft', shrink: 'ArrowRight' },
} as const;
const STEP = 16;
/** what the charts keep at least */
const CHART_H = 200, CHART_W = 320;

export function Splitter({ kind }: { kind: SplitKind }) {
  const el = useRef<HTMLDivElement>(null);
  const c = CFG[kind];
  // everything the handlers share, kept out of React state so a drag never re-renders anything
  const st = useRef({ cur: c.def as number, work: null as HTMLElement | null, drag: null as null | { at: number; size: number; max: number; id: number }, raf: 0, next: 0 });

  /** the largest size now: what leaves the charts CHART_H tall (CHART_W wide), measured with the panel at its smallest
   *  (a panel too big for a window just made smaller squeezes the charts to nothing, which would measure wrong), and at
   *  most 70% of the window's height (the panel under the charts) or half its width (the trade panel). Measured once a
   *  drag starts, not while it moves. */
  const maxNow = () => {
    const s = st.current, work = s.work, charts = work?.querySelector<HTMLElement>('.charts');
    let room = Infinity;
    if (work && charts) {
      work.style.setProperty(c.v, c.min + 'px');
      room = c.min + (kind === 'dock' ? charts.clientHeight - CHART_H : charts.clientWidth - CHART_W);
      work.style.setProperty(c.v, s.cur + 'px');
    }
    const cap = kind === 'dock' ? innerHeight * 0.7 : innerWidth * 0.5;
    return Math.max(c.min, Math.floor(Math.min(cap, room)));
  };
  const apply = (v: number, max: number) => {
    const s = st.current, h = el.current;
    v = Math.round(Math.max(c.min, Math.min(max, v)));
    s.cur = v;
    s.work?.style.setProperty(c.v, v + 'px');
    if (h) { h.setAttribute('aria-valuenow', String(v)); h.setAttribute('aria-valuemax', String(max)); }
    return v;
  };
  const wanted = () => pref<number | null>(c.key, null) ?? c.def;

  useLayoutEffect(() => {
    const s = st.current, work = el.current!.closest<HTMLElement>('.work');
    s.work = work;
    if (!work) return;
    // the saved size, within what fits; again whenever the screen changes size (the window, the sidebar...)
    const fit = () => { if (!s.drag) apply(wanted(), maxNow()); };
    work.style.setProperty(c.v, Math.max(c.min, wanted()) + 'px'); s.cur = Math.max(c.min, wanted());
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(work);
    return () => { ro.disconnect(); cancelAnimationFrame(s.raf); work.style.removeProperty(c.v); document.documentElement.classList.remove('resizing-' + kind); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);

  const pos = (e: React.PointerEvent) => kind === 'dock' ? e.clientY : e.clientX;
  const end = (e: React.PointerEvent) => {
    const s = st.current;
    if (!s.drag || e.pointerId !== s.drag.id) return;
    cancelAnimationFrame(s.raf); s.raf = 0;
    const moved = s.next !== s.drag.size;
    apply(s.next, s.drag.max);
    s.drag = null;
    document.documentElement.classList.remove('resizing-' + kind);
    if (el.current?.hasPointerCapture(e.pointerId)) el.current.releasePointerCapture(e.pointerId);
    if (moved) setPref(c.key, s.cur);
  };
  const key = (e: React.KeyboardEvent) => {
    const max = maxNow(), cur = st.current.cur;
    const to = e.key === c.grow ? cur + STEP : e.key === c.shrink ? cur - STEP : e.key === 'Home' ? c.min : e.key === 'End' ? max : null;
    if (to == null) return;
    e.preventDefault(); e.stopPropagation(); // not the replay's arrow keys
    setPref(c.key, apply(to, max));
  };
  return (
    <div ref={el} className={'rsz rsz-' + kind} role="separator" tabIndex={0} aria-orientation={c.orient} aria-label={c.label}
      aria-valuemin={c.min} title="Drag to resize; double-click for the usual size"
      onPointerDown={e => {
        if (e.button !== 0) return;
        // no focus from the mouse: the arrow keys stay the replay's (Tab reaches the handle for the keyboard)
        e.preventDefault();
        const s = st.current;
        el.current!.setPointerCapture(e.pointerId);
        s.drag = { at: pos(e), size: s.cur, max: maxNow(), id: e.pointerId }; s.next = s.cur;
        document.documentElement.classList.add('resizing-' + kind);
      }}
      onPointerMove={e => {
        const s = st.current, d = s.drag;
        if (!d || e.pointerId !== d.id) return;
        // up (or left) makes the panel bigger; one update a frame however fast the pointer moves
        s.next = Math.round(Math.max(c.min, Math.min(d.max, d.size - (pos(e) - d.at))));
        if (!s.raf) s.raf = requestAnimationFrame(() => { s.raf = 0; if (s.drag) apply(s.next, s.drag.max); });
      }}
      onMouseDown={e => e.preventDefault()}
      onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}
      onDoubleClick={() => { setPref(c.key, null); apply(c.def, maxNow()); }}
      onKeyDown={key} />
  );
}
