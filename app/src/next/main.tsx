// The new Tape Replay (index.html): fonts and styles bundled so it works offline, then the React app.
import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-600.css';
import '@fontsource/inter/latin-700.css';
import '@fontsource/jetbrains-mono/latin-400.css';
import '@fontsource/jetbrains-mono/latin-500.css';
import '@fontsource/jetbrains-mono/latin-600.css';
import './theme.css';
import './phone.css';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { applyLook } from './look';
import { setCandleCap } from '../core/feed';
import { isPhone, labelTables } from './phone';

// touch screens and small screens: html.touch (fingers: bigger targets, no hover tips), html.m (the phone layout:
// one screen at a time, with a tab bar)
const root = document.documentElement;
const TOUCH = !!(window as unknown as { TAPE_IOS?: boolean }).TAPE_IOS || matchMedia('(hover: none) and (pointer: coarse)').matches;
root.classList.toggle('touch', TOUCH);
if (TOUCH) setCandleCap(8000, 1500);
const layout = () => root.classList.toggle('m', innerWidth < 900 || innerHeight < 500);
layout(); addEventListener('resize', layout);

// phones: tables on the pages read as cards (labelled again whenever the pages change)
let labelling = 0;
new MutationObserver(() => { if (!labelling && isPhone()) labelling = requestAnimationFrame(() => { labelling = 0; labelTables(document); }); })
  .observe(document.getElementById('root')!, { childList: true, subtree: true });

applyLook(); // from this browser's copy of the settings; again once the app's copy has loaded
createRoot(document.getElementById('root')!).render(<App />);

// Fingers never leave a menu the way a mouse does, so a tap outside an open menu, sheet or panel closes it, whatever it
// listens for: menus close on mouse leave, panels through their close button (data-dismiss), pickers on a mouse
// press elsewhere. On phones they are bottom sheets over a dimmed screen whose dim part catches the tap (the sheet's
// ::after), so that tap only closes the sheet: it doesn't also press, pan or draw on what is under it.
if (TOUCH) {
  let swallowUntil = 0;
  const OPEN = '.pop, .drawrail .flyout, html.m .otree';
  const outside = (p: HTMLElement, e: PointerEvent) => {
    const t = e.target as Node;
    if (!p.contains(t)) return true;
    if (t !== p) return false;
    const r = p.getBoundingClientRect(); // the sheet itself, or its dimmed backdrop
    return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  };
  addEventListener('pointerdown', (e: PointerEvent) => {
    swallowUntil = 0; // a new tap: only the rest of the one that closed a sheet is swallowed
    // a dialog opened from a menu (the Python editor from Indicators) sits above it: taps in it leave the menu be
    if ((e.target as Element).closest?.('.modal-back')) return;
    let any = false, sheet = false;
    for (const p of document.querySelectorAll<HTMLElement>(OPEN)) {
      if (!outside(p, e)) continue;
      any = true;
      p.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
      p.querySelector<HTMLElement>('[data-dismiss]')?.click();
      if (root.classList.contains('m') && !p.classList.contains('colorpop')) sheet = true;
    }
    if (any) document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    if (sheet) { swallowUntil = e.timeStamp + 700; e.stopPropagation(); e.preventDefault(); }
  }, true);
  const swallow = (e: Event) => { if (e.timeStamp < swallowUntil) { e.stopPropagation(); e.preventDefault(); if (e.type === 'click') swallowUntil = 0; } };
  for (const ev of ['pointerup', 'mousedown', 'mouseup', 'click', 'touchstart', 'touchend']) addEventListener(ev, swallow, { capture: true, passive: false });
}
