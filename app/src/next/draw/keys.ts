// Drawing shortcuts, as on TradingView: Alt+T trend line, Alt+H horizontal line, Alt+J horizontal ray, Alt+V vertical
// line, Alt+C cross line, Alt+F fib retracement, Alt+Shift+R rectangle; Esc cancels or deselects; Delete removes;
// Enter finishes a path; Ctrl+Z / Ctrl+Y undo and redo; Ctrl+C / Ctrl+V copy and paste a drawing.
import { useEffect } from 'react';
import type { Session } from '../../core/session';
import type { Drawing } from '../../core/drawings';
import { layers } from './overlay';
import { cursorTool, ds, setDs } from './state';
import { TOOL, isDrawTool } from './tools';
import { removeDrawing } from './actions';

const ALT: Record<string, string> = { KeyT: 'trend', KeyH: 'hline', KeyJ: 'hray', KeyV: 'vline', KeyC: 'crossline', KeyF: 'fib' };
let clip: Drawing | null = null;

export function useDrawKeys(session: Session | null, on: boolean) {
  useEffect(() => {
    if (!session || !on) return;
    const st = session.drawings;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (ds.editing) return;
      const mod = e.ctrlKey || e.metaKey;
      if (e.altKey && !mod) {
        const id = e.shiftKey && e.code === 'KeyR' ? 'rect' : !e.shiftKey ? ALT[e.code] : undefined;
        if (id) { e.preventDefault(); for (const l of layers) l.cancel(); setDs({ tool: id, selected: null, last: { ...ds.last, [TOOL[id].group]: id } }); }
        return;
      }
      if (e.key === 'Escape') {
        let busy = false; for (const l of layers) if (l.placing || l.measure) { l.cancel(); busy = true; }
        if (!busy) { if (ds.selected) setDs({ selected: null }); else if (isDrawTool(ds.tool) || ['eraser', 'measure', 'zoom'].includes(ds.tool)) setDs({ tool: cursorTool() }); }
        return;
      }
      if (e.key === 'Enter') { for (const l of layers) if (l.placing?.tool.n === 'path') { e.preventDefault(); l.finish(); } return; }
      if ((e.key === 'Delete' || e.key === 'Backspace') && ds.selected) { e.preventDefault(); removeDrawing(session, ds.selected); return; }
      if (mod && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); if (e.shiftKey) st.redo(); else st.undo(); if (ds.selected && !st.get(ds.selected)) setDs({ selected: null }); else setDs({}); return; }
      if (mod && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); st.redo(); setDs({}); return; }
      if (mod && (e.key === 'c' || e.key === 'C') && ds.selected) { clip = JSON.parse(JSON.stringify(st.get(ds.selected))); return; }
      if (mod && (e.key === 'v' || e.key === 'V') && clip) {
        e.preventDefault();
        const layer = [...layers].find(l => l.sym === session.active), screen = TOOL[clip.tool]?.screen;
        const pts = clip.pts.map(p => screen ? { t: Math.min(0.95, p.t + 0.03), p: Math.min(0.95, p.p + 0.03) } : layer ? { t: layer.tOf(layer.logical(p.t) + 5), p: p.p } : p);
        const d = st.add({ tool: clip.tool, sym: session.active, pts, style: clip.style });
        clip = { ...clip, pts };
        setDs({ selected: d.id });
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [session, on]);
}
