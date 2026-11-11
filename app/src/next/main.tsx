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
import { installPops } from './popfit';

// touch screens and small screens: html.touch (fingers: bigger targets, no hover tips), html.m (the phone layout:
// one screen at a time, with a tab bar)
const root = document.documentElement;
const TOUCH = !!(window as unknown as { TAPE_IOS?: boolean }).TAPE_IOS || matchMedia('(hover: none) and (pointer: coarse)').matches;
root.classList.toggle('touch', TOUCH);
if (TOUCH) setCandleCap(8000, 1500);
const layout = () => root.classList.toggle('m', innerWidth < 900 || innerHeight < 500);
layout(); addEventListener('resize', layout);

// phones: tables on the pages read as cards (labeled again whenever the pages change)
let labelling = 0;
new MutationObserver(() => { if (!labelling && isPhone()) labelling = requestAnimationFrame(() => { labelling = 0; labelTables(document); }); })
  .observe(document.getElementById('root')!, { childList: true, subtree: true });

applyLook(); // from this browser's copy of the settings; again once the app's copy has loaded
createRoot(document.getElementById('root')!).render(<App />);

// menus and popovers: kept on screen, closed by a press outside them or by Escape (popfit.ts)
installPops();
