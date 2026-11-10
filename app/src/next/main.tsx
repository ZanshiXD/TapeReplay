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

// touch screens and small screens: html.touch (fingers: bigger targets, no hover tips), html.m (the phone layout:
// one screen at a time, with a tab bar)
const root = document.documentElement;
const TOUCH = !!(window as unknown as { TAPE_IOS?: boolean }).TAPE_IOS || matchMedia('(hover: none) and (pointer: coarse)').matches;
root.classList.toggle('touch', TOUCH);
if (TOUCH) setCandleCap(8000, 1500);
const layout = () => root.classList.toggle('m', innerWidth < 900 || innerHeight < 500);
layout(); addEventListener('resize', layout);

applyLook(); // from this browser's copy of the settings; again once the app's copy has loaded
createRoot(document.getElementById('root')!).render(<App />);

// fingers never leave a menu the way a mouse does: a tap outside an open menu closes it (menus close on mouse leave,
// panels through their close button, the drawing flyouts on a mouse press elsewhere). On phones menus are bottom sheets
// over a dimmed screen, so that tap only closes the sheet: it doesn't also press what was under it.
if (TOUCH) {
  let swallowUntil = 0;
  addEventListener('pointerdown', e => {
    swallowUntil = 0; // a new tap: only the rest of the one that closed a sheet is swallowed
    const t = e.target as Node; let sheet = false;
    for (const p of document.querySelectorAll<HTMLElement>('.pop, .drawrail .flyout')) {
      if (p.contains(t) || (p.classList.contains('colorpop') && p.parentElement?.closest('.pop')?.contains(t))) continue;
      p.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
      p.querySelector<HTMLElement>(':scope > * [data-dismiss], [data-dismiss]')?.click();
      if (p.classList.contains('flyout')) document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      if (root.classList.contains('m') && !p.classList.contains('colorpop')) sheet = true;
    }
    if (sheet) { swallowUntil = e.timeStamp + 700; e.stopPropagation(); e.preventDefault(); }
  }, true);
  const swallow = (e: Event) => { if (e.timeStamp < swallowUntil) { e.stopPropagation(); e.preventDefault(); if (e.type === 'click') swallowUntil = 0; } };
  for (const ev of ['pointerup', 'mousedown', 'mouseup', 'click']) addEventListener(ev, swallow, true);
}
