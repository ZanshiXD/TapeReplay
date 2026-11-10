// The new Tape Replay (next.html): fonts and styles bundled so it works offline, then the React app.
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
import { setCandleCap } from '../core/feed';

// touch screens and small screens: html.touch (fingers: bigger targets, no hover tips), html.m (the phone layout:
// one screen at a time, with a tab bar)
const root = document.documentElement;
const TOUCH = !!(window as unknown as { TAPE_IOS?: boolean }).TAPE_IOS || matchMedia('(hover: none) and (pointer: coarse)').matches;
root.classList.toggle('touch', TOUCH);
if (TOUCH) setCandleCap(8000, 1500);
const layout = () => root.classList.toggle('m', innerWidth < 900 || innerHeight < 500);
layout(); addEventListener('resize', layout);

createRoot(document.getElementById('root')!).render(<App />);

// fingers never leave a menu the way a mouse does: a tap outside an open menu closes it (menus close on mouse leave)
if (TOUCH) addEventListener('pointerdown', e => {
  for (const p of document.querySelectorAll('.pop')) if (!p.contains(e.target as Node)) p.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
}, true);
