// Small parts the drawing screens share: tool icons, the color picker, the floating toolbar of the selected drawing,
// and its right-click menu.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Session } from '../../core/session';
import type { Drawing, DrawStyle } from '../../core/drawings';
import { useLive } from '../live';
import { ICONS, TOOL } from './tools';
import { resetTemplate, saveTemplate, setDs } from './state';
import { cloneDrawing, placeFromPosition, removeDrawing, toggleHide, toggleLock } from './actions';

export const Ic = ({ d, size = 22, sw = 1.3 }: { d: string; size?: number; sw?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);
export const ToolIcon = ({ id, size = 22 }: { id: string; size?: number }) => <Ic d={TOOL[id]?.icon || ICONS[id] || ''} size={size} />;
export const UI = {
  gear: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1',
  lock: 'M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3', unlock: 'M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 6.8-1.2', trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  copy: 'M8 8h12v12H8zM16 8V4H4v12h4', eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z', eyeoff: 'M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3.2 3.9M6.6 6.6C3.8 8.4 2 12 2 12s4 7 10 7a9.6 9.6 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2',
  magnet: 'M5 4h4v8a3 3 0 0 0 6 0V4h4v8a7 7 0 0 1-14 0zM5 8h4M15 8h4', pencil: 'M4 20l4-1 11-11-3-3L5 16zM14 6l3 3', tree: 'M4 5h5v4H4zM4 15h5v4H4zM13 5h7M13 7h4M13 15h7M13 17h4',
  undo: 'M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3', redo: 'M15 14l5-5-5-5M20 9H10a6 6 0 0 0 0 12h3', more: 'M5 12h.01M12 12h.01M19 12h.01', front: 'M4 4h11v11H4zM9 9h11v11H9z',
  chev: 'M9 6l6 6-6 6', zoomout: 'M10 10m-6 0a6 6 0 1 0 12 0a6 6 0 1 0-12 0M15 15l6 6M7 10h6', grip: 'M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01', star: 'M12 4l2.4 5 5.6.6-4.2 3.8 1.2 5.6L12 16.2 7 19l1.2-5.6L4 9.6 9.6 9z',
};

/* ---- colors ---- */
const HUES = ['#f23645', '#ff9800', '#ffeb3b', '#4caf50', '#089981', '#00bcd4', '#2962ff', '#673ab7', '#9c27b0', '#e91e63'];
const mix = (c: string, to: number, f: number) => { const n = parseInt(c.slice(1), 16), ch = [n >> 16, (n >> 8) & 255, n & 255].map(v => Math.round(v + (to - v) * f)); return '#' + ch.map(v => v.toString(16).padStart(2, '0')).join(''); };
const PALETTE = [
  ['#ffffff', '#d1d4dc', '#b2b5be', '#9598a1', '#787b86', '#5d606b', '#434651', '#2a2e39', '#131722', '#000000'],
  ...[0.8, 0.6, 0.4, 0.2].map(f => HUES.map(h => mix(h, 255, f))), HUES, ...[0.2, 0.4].map(f => HUES.map(h => mix(h, 0, f))),
];
export function ColorPop({ value, alpha, onPick, onAlpha, onClose }: { value: string; alpha?: number; onPick: (c: string) => void; onAlpha?: (a: number) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { const f = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); }; setTimeout(() => addEventListener('mousedown', f)); return () => removeEventListener('mousedown', f); }, [onClose]);
  return (
    <div className="pop colorpop" ref={ref} onMouseDown={e => e.stopPropagation()}>
      <div className="swatches">{PALETTE.flat().map((c, i) => <button key={i} title={c} aria-label={`Color ${c}`} className={c.toLowerCase() === value.toLowerCase() ? 'on' : ''} style={{ background: c }} onClick={() => onPick(c)} />)}</div>
      <label className="row"><span>Custom</span><input type="color" value={value.slice(0, 7)} onChange={e => onPick(e.target.value)} /></label>
      {onAlpha && alpha != null && <label className="row"><span>Opacity</span><input type="range" min={0} max={100} value={Math.round(alpha * 100)} onChange={e => onAlpha(+e.target.value / 100)} /><b className="num">{Math.round(alpha * 100)}%</b></label>}
    </div>
  );
}
export function Swatch({ color, alpha, label, onPick, onAlpha, children }: { color: string; alpha?: number; label: string; onPick: (c: string) => void; onAlpha?: (a: number) => void; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <span style={{ position: 'relative', display: 'inline-flex' }}>
      <button className="ib swatchbtn" title={label} aria-label={label} onClick={() => setOpen(!open)}>{children || <i style={{ background: color, opacity: alpha != null ? Math.max(0.25, alpha * 2) : 1 }} />}<u style={{ background: color }} /></button>
      {open && <ColorPop value={color} alpha={alpha} onPick={c => onPick(c)} onAlpha={onAlpha} onClose={() => setOpen(false)} />}
    </span>
  );
}

/** changes a drawing's style as one undo step */
export const restyle = (s: Session, d: Drawing, st: Partial<DrawStyle>) => s.drawings.update(d.id, { style: st });

/* ---- the floating toolbar of the selected drawing ---- */
export function DrawBar({ session, d, onToast }: { session: Session; d: Drawing; onToast: (m: string, k?: string) => void }) {
  useLive();
  const tool = TOOL[d.tool], has = tool?.has || {}, s = session, st = d.style;
  const [menu, setMenu] = useState<'' | 'width' | 'dash' | 'more' | 'tpl'>('');
  const isPos = d.tool === 'long' || d.tool === 'short', textTool = tool?.group === 'notes';
  const line = has.line || has.levels || (!textTool && !isPos);
  const toggle = (m: typeof menu) => setMenu(menu === m ? '' : m);
  return (
    <div className="drawbar" role="toolbar" aria-label="Selected drawing" onMouseDown={e => e.stopPropagation()}>
      <span className="name"><ToolIcon id={d.tool} size={18} />{tool?.name}</span>
      <span style={{ position: 'relative' }}>
        <button className="ib txt tplbtn" title="Template" onClick={() => toggle('tpl')}>Template</button>
        {menu === 'tpl' && <div className="pop menu" style={{ top: 36, left: 0 }} onMouseLeave={() => setMenu('')}>
          <button onClick={() => { saveTemplate(d.tool, st); setMenu(''); onToast(`New ${tool?.name.toLowerCase()} drawings will look like this`); }}>Save as default</button>
          <button onClick={() => { resetTemplate(d.tool); restyle(s, d, { ...tool?.style, opt: { ...st.opt, ...(tool?.style?.opt || {}) } } as Partial<DrawStyle>); setMenu(''); }}>Reset to the original look</button>
        </div>}
      </span>
      <span className="sep" />
      {!isPos && <Swatch color={st.color} label={textTool ? 'Color' : 'Line color'} onPick={c => restyle(s, d, { color: c })} />}
      {has.fill && !has.levels && <Swatch color={st.fillColor} alpha={st.fillAlpha} label="Background" onPick={c => restyle(s, d, { fillColor: c, fill: true })} onAlpha={a => restyle(s, d, { fillAlpha: a, fill: true })}><i style={{ background: st.fill ? st.fillColor : 'transparent', border: '1px dashed var(--line2)', opacity: st.fill ? 0.7 : 1 }} /></Swatch>}
      {has.text && !textTool && <Swatch color={st.textColor} label="Text color" onPick={c => restyle(s, d, { textColor: c })}><b style={{ fontSize: 13 }}>T</b></Swatch>}
      {line && !textTool && <span style={{ position: 'relative' }}>
        <button className="ib txt" title="Line width" onClick={() => toggle('width')}><svg width="18" height="12"><line x1="1" x2="17" y1="6" y2="6" stroke="currentColor" strokeWidth={st.width} /></svg>{st.width}px</button>
        {menu === 'width' && <div className="pop menu" style={{ top: 36, left: 0, minWidth: 120 }} onMouseLeave={() => setMenu('')}>{[1, 2, 3, 4].map(w => <button key={w} onClick={() => { restyle(s, d, { width: w }); setMenu(''); }}><svg width="40" height="10"><line x1="0" x2="40" y1="5" y2="5" stroke="currentColor" strokeWidth={w} /></svg><span>{w}px</span></button>)}</div>}
      </span>}
      {line && !textTool && <span style={{ position: 'relative' }}>
        <button className="ib" title="Line style" onClick={() => toggle('dash')}><svg width="20" height="12"><line x1="1" x2="19" y1="6" y2="6" stroke="currentColor" strokeWidth={2} strokeDasharray={st.dash === 1 ? '5 3' : st.dash === 2 ? '1.5 3' : undefined} /></svg></button>
        {menu === 'dash' && <div className="pop menu" style={{ top: 36, left: 0, minWidth: 140 }} onMouseLeave={() => setMenu('')}>{['Solid', 'Dashed', 'Dotted'].map((n, k) => <button key={n} onClick={() => { restyle(s, d, { dash: k }); setMenu(''); }}><svg width="40" height="10"><line x1="0" x2="40" y1="5" y2="5" stroke="currentColor" strokeWidth={2} strokeDasharray={k === 1 ? '5 3' : k === 2 ? '1.5 3' : undefined} /></svg><span>{n}</span></button>)}</div>}
      </span>}
      {isPos && <button className="btn sm primary" title="Send this as a real order: entry, stop and target from the drawing" onClick={() => { const e = placeFromPosition(s, d); if (e) onToast(e, 'err'); }}>Place order</button>}
      <span className="sep" />
      <button className="ib" title="Settings (double-click the drawing)" aria-label="Settings" onClick={() => setDs({ editing: { id: d.id, tab: 'style' } })}><Ic d={UI.gear} size={18} sw={1.6} /></button>
      <button className={'ib' + (d.locked ? ' on' : '')} title={d.locked ? 'Unlock' : 'Lock (stops it moving by accident)'} aria-label={d.locked ? 'Unlock' : 'Lock'} onClick={() => toggleLock(s, d)}><Ic d={d.locked ? UI.lock : UI.unlock} size={18} sw={1.6} /></button>
      <button className="ib" title="Clone" aria-label="Clone" onClick={() => cloneDrawing(s, d.id)}><Ic d={UI.copy} size={18} sw={1.6} /></button>
      <span style={{ position: 'relative' }}>
        <button className="ib" title="More" aria-label="More" onClick={() => toggle('more')}><Ic d={UI.more} size={18} sw={2.6} /></button>
        {menu === 'more' && <DrawMenu session={s} d={d} style={{ top: 36, right: 0 }} onClose={() => setMenu('')} />}
      </span>
      <button className="ib danger" title="Remove (Delete)" aria-label="Remove drawing" onClick={() => removeDrawing(s, d.id)}><Ic d={UI.trash} size={18} sw={1.6} /></button>
    </div>
  );
}

/** the drawing's menu: right-click on it, or "More" on its toolbar */
export function DrawMenu({ session, d, style, onClose }: { session: Session; d: Drawing; style: React.CSSProperties; onClose: () => void }) {
  const s = session, act = (f: () => void) => () => { f(); onClose(); };
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { const f = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); }; setTimeout(() => addEventListener('mousedown', f)); return () => removeEventListener('mousedown', f); }, [onClose]);
  return (
    <div className="pop menu" style={style} ref={ref} role="menu" onMouseDown={e => e.stopPropagation()}>
      <button role="menuitem" onClick={act(() => setDs({ editing: { id: d.id, tab: 'style' } }))}>Settings…</button>
      {TOOL[d.tool]?.has?.text && <button role="menuitem" onClick={act(() => setDs({ editing: { id: d.id, tab: 'text' } }))}>Edit text…</button>}
      <button role="menuitem" onClick={act(() => cloneDrawing(s, d.id))}>Clone</button>
      <button role="menuitem" onClick={act(() => toggleLock(s, d))}>{d.locked ? 'Unlock' : 'Lock'}</button>
      <button role="menuitem" onClick={act(() => toggleHide(s, d))}>{d.hidden ? 'Show' : 'Hide'}</button>
      <button role="menuitem" onClick={act(() => s.drawings.order(d.id, 2))}>Bring to front</button>
      <button role="menuitem" onClick={act(() => s.drawings.order(d.id, -2))}>Send to back</button>
      <button role="menuitem" onClick={act(() => setDs({ editing: { id: d.id, tab: 'vis' } }))}>Show on timeframes…</button>
      <button role="menuitem" className="danger" onClick={act(() => removeDrawing(s, d.id))}>Remove<span>Del</span></button>
    </div>
  );
}
