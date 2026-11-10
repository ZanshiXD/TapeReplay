// The new Tape Replay (next.html): fonts and styles bundled so it works offline, then the React app.
import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-600.css';
import '@fontsource/inter/latin-700.css';
import '@fontsource/jetbrains-mono/latin-400.css';
import '@fontsource/jetbrains-mono/latin-500.css';
import '@fontsource/jetbrains-mono/latin-600.css';
import './theme.css';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { applyLook } from './look';

applyLook(); // from this browser's copy of the settings; again once the app's copy has loaded
createRoot(document.getElementById('root')!).render(<App />);
