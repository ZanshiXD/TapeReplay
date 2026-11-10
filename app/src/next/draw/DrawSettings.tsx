// A drawing's settings, as on TradingView: Style, Text, Coordinates and Visibility tabs. Changes show on the chart
// straight away; Cancel puts everything back, OK keeps it (one undo step).
import { useEffect, useRef, useState } from 'react';
import type { Session } from '../../core/session';
import type { Drawing, DrawStyle, Level } from '../../core/drawings';
import { fmtShortDay, fmtHM } from '../../core/time';
import { useLive, bump } from '../live';
import { TOOL } from './tools';
import { ds, resetTemplate, saveTemplate, setDs } from './state';
import { Swatch, ToolIcon } from './ui';

const OPT: Record<string, string> = {
  stats: 'Show price change, bars and angle', middle: 'Middle line', dev: 'Deviation (standard deviations)', rows: 'Rows', widthPct: 'Width (% of the range)', risk: 'Risk per trade ($)',
  mode: 'Draw as', flip: 'Flip upside down', mirror: 'Mirror left to right', ccw: 'Counter-clockwise', full: 'Full circles', angles: 'Diagonals', closed: 'Closed shape', border: 'Border',
  upColor: 'Up color', downColor: 'Down color',
};
const TFS: Array<[Drawing['tfs'][number], string]> = [['sec', 'Seconds'], ['min', 'Minutes'], ['hour', 'Hours'], ['day', 'Days and up']];

export function DrawSettings({ session, onToast }: { session: Session; onToast: (m: string) => void }) {
  useLive();
  const ed = ds.editing, s = session, st = s.drawings, d = st.get(ed?.id ?? null);
  const began = useRef<string | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const [tab, setTab] = useState(ed?.tab || 'style');
  useEffect(() => { if (ed && began.current !== ed.id) { began.current = ed.id; st.begin(); setTab(ed.tab); } }, [ed, st]);
  useEffect(() => { if (tab === 'text') setTimeout(() => textRef.current?.focus(), 30); }, [tab, ed?.id]);
  if (!ed || !d) return null;
  const tool = TOOL[d.tool], has = tool?.has || {}, sty = d.style, textTool = tool?.group === 'notes';
  const close = (keep: boolean) => { if (keep) st.commit(); else st.rollback(); began.current = null; setDs({ editing: null }); };
  /** a change shown live; OK keeps it */
  const set = (p: Partial<DrawStyle>) => { Object.assign(d.style, p); st.live(); bump(); };
  const setOpt = (k: string, v: string | number | boolean) => { d.style.opt = { ...d.style.opt, [k]: v }; st.live(); bump(); };
  const setLevels = (ls: Level[]) => set({ levels: ls });
  const tabs: Array<[typeof tab, string]> = [['style', 'Style'], ...(has.text ? [['text', 'Text'] as [typeof tab, string]] : []), ...(!tool?.screen ? [['coords', 'Coordinates'] as [typeof tab, string]] : []), ['vis', 'Visibility']];
  const optKeys = Object.keys(sty.opt).filter(k => k in OPT);
  const inst = s.feeds.find(f => f.s.inst.sym === d.sym)?.s.inst;
  return (
    <div className="modal-back" onMouseDown={() => close(true)}>
      <div className="modal drawset" role="dialog" aria-label={`${tool?.name} settings`} onMouseDown={e => e.stopPropagation()} onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); close(false); } if (e.key === 'Enter' && (e.target as HTMLElement).tagName !== 'TEXTAREA') close(true); }}>
        <header><ToolIcon id={d.tool} size={20} /><b>{tool?.name}</b><span className="spacer" /><button className="ib" aria-label="Close" onClick={() => close(true)}>✕</button></header>
        <nav className="tabs">{tabs.map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}</nav>
        <div className="body">
          {tab === 'style' && <>
            {!textTool && d.tool !== 'long' && d.tool !== 'short' && <div className="frow"><span>Line</span>
              <Swatch color={sty.color} label="Line color" onPick={c => set({ color: c })} />
              <select className="in ui sel" value={sty.width} aria-label="Line width" onChange={e => set({ width: +e.target.value })}>{[1, 2, 3, 4, 6, 8, 14].map(w => <option key={w} value={w}>{w}px</option>)}</select>
              <select className="in ui sel" value={sty.dash} aria-label="Line style" onChange={e => set({ dash: +e.target.value })}><option value={0}>Solid</option><option value={1}>Dashed</option><option value={2}>Dotted</option></select>
            </div>}
            {textTool && <div className="frow"><span>Color</span><Swatch color={sty.color} label="Color" onPick={c => set({ color: c })} /></div>}
            {has.fill && <div className="frow"><label className="chk"><input type="checkbox" checked={sty.fill} onChange={e => set({ fill: e.target.checked })} />Background</label>
              {has.levels ? <><input type="range" min={0} max={60} aria-label="Background opacity" value={Math.round(sty.fillAlpha * 100)} onChange={e => set({ fillAlpha: +e.target.value / 100, fill: true })} /><span className="muted num">{Math.round(sty.fillAlpha * 100)}%</span></>
                : <Swatch color={sty.fillColor} alpha={sty.fillAlpha} label="Background color" onPick={c => set({ fillColor: c, fill: true })} onAlpha={a => set({ fillAlpha: a, fill: true })} />}</div>}
            {has.ext && <div className="frow"><span>Extend</span><label className="chk"><input type="checkbox" checked={sty.extL} onChange={e => set({ extL: e.target.checked })} />Left</label><label className="chk"><input type="checkbox" checked={sty.extR} onChange={e => set({ extR: e.target.checked })} />Right</label></div>}
            {has.levels && <>
              <div className="frow"><span>Labels</span><label className="chk"><input type="checkbox" checked={sty.labels} onChange={e => set({ labels: e.target.checked })} />Levels</label><label className="chk"><input type="checkbox" checked={sty.prices} onChange={e => set({ prices: e.target.checked })} />Prices</label>
                {(d.tool === 'fib') && <label className="chk"><input type="checkbox" checked={sty.reverse} onChange={e => set({ reverse: e.target.checked })} />Reverse</label>}</div>
              <div className="levels">
                {sty.levels.map((l, k) => <span key={k} className="lvl">
                  <input type="checkbox" checked={l.on} aria-label={`Show level ${l.v}`} onChange={e => setLevels(sty.levels.map((x, j) => j === k ? { ...x, on: e.target.checked } : x))} />
                  <input className="in" inputMode="decimal" defaultValue={l.v} aria-label="Level" onBlur={e => { const v = parseFloat(e.target.value); if (isFinite(v)) setLevels(sty.levels.map((x, j) => j === k ? { ...x, v } : x)); }} />
                  <Swatch color={l.color} label="Level color" onPick={c => setLevels(sty.levels.map((x, j) => j === k ? { ...x, color: c } : x))} />
                  <button className="ib" aria-label="Remove level" onClick={() => setLevels(sty.levels.filter((_, j) => j !== k))}>✕</button>
                </span>)}
                <button className="btn sm" onClick={() => setLevels([...sty.levels, { v: +(Math.max(0, ...sty.levels.map(l => l.v)) + 0.5).toFixed(3), color: '#2962ff', on: true }])}>+ Add level</button>
              </div>
            </>}
            {!has.levels && has.labels && <div className="frow"><span>Labels</span><label className="chk"><input type="checkbox" checked={sty.labels} onChange={e => set({ labels: e.target.checked })} />Show</label></div>}
            {optKeys.map(k => {
              const v = sty.opt[k];
              if (k === 'mode') return <div className="frow" key={k}><span>{OPT[k]}</span><select className="in ui sel" value={String(v)} onChange={e => setOpt(k, e.target.value)}><option value="candles">Candles</option><option value="hl">Bars (high to low)</option><option value="line">Line (closes)</option></select></div>;
              if (typeof v === 'boolean') return <div className="frow" key={k}><label className="chk"><input type="checkbox" checked={v} onChange={e => setOpt(k, e.target.checked)} />{OPT[k]}</label></div>;
              if (typeof v === 'string' && v.startsWith('#')) return <div className="frow" key={k}><span>{OPT[k]}</span><Swatch color={v} label={OPT[k]} onPick={c => setOpt(k, c)} /></div>;
              return <div className="frow" key={k}><span>{OPT[k]}</span><input className="in sm" inputMode="decimal" defaultValue={String(v)} onBlur={e => { const n = parseFloat(e.target.value); if (isFinite(n) && n > 0) setOpt(k, n); }} /></div>;
            })}
          </>}
          {tab === 'text' && <>
            <textarea ref={textRef} className="in ui" rows={4} placeholder="Type your text" value={sty.text} onChange={e => set({ text: e.target.value })} />
            <div className="frow">
              {!textTool && <Swatch color={sty.textColor} label="Text color" onPick={c => set({ textColor: c })}><b style={{ fontSize: 13 }}>T</b></Swatch>}
              <select className="in ui sel" value={sty.fontSize} aria-label="Font size" onChange={e => set({ fontSize: +e.target.value })}>{[10, 11, 12, 14, 16, 20, 24, 28, 32, 40].map(f => <option key={f} value={f}>{f}</option>)}</select>
              <button className={'ib txt' + (sty.bold ? ' on' : '')} aria-pressed={sty.bold} onClick={() => set({ bold: !sty.bold })}><b>B</b></button>
              <button className={'ib txt' + (sty.italic ? ' on' : '')} aria-pressed={sty.italic} onClick={() => set({ italic: !sty.italic })}><i>I</i></button>
              {(d.tool === 'text' || d.tool === 'atext') && <label className="chk"><input type="checkbox" checked={!!sty.opt.border} onChange={e => setOpt('border', e.target.checked)} />Border</label>}
            </div>
          </>}
          {tab === 'coords' && <div className="coords">
            {d.pts.map((p, k) => <div className="frow" key={k}>
              <span>Point {k + 1}</span>
              <input className="in sm" inputMode="decimal" aria-label={`Point ${k + 1} price`} defaultValue={p.p.toFixed(inst?.prec ?? 2)} onBlur={e => { const v = parseFloat(e.target.value); if (isFinite(v)) { d.pts[k] = { ...d.pts[k], p: v }; st.live(); bump(); } }} />
              <span className="muted num" style={{ fontSize: 12 }}>{fmtShortDay(p.t)} {fmtHM(p.t)}</span>
            </div>)}
            <p className="muted" style={{ margin: 0, fontSize: 12 }}>Drag a point on the chart to move it in time.</p>
          </div>}
          {tab === 'vis' && <>
            <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>Show this drawing on these chart timeframes. With none ticked it shows on all.</p>
            {TFS.map(([k, l]) => <label key={k} className="chk"><input type="checkbox" checked={d.tfs.includes(k)} onChange={e => { d.tfs = e.target.checked ? [...d.tfs, k] : d.tfs.filter(x => x !== k); st.live(); bump(); }} />{l}</label>)}
          </>}
        </div>
        <footer>
          <button className="btn sm" onClick={() => { saveTemplate(d.tool, d.style); onToast(`New ${tool?.name.toLowerCase()} drawings will look like this`); }}>Save as default</button>
          <button className="btn sm" onClick={() => { resetTemplate(d.tool); const base = tool?.style || {}; set({ ...base, opt: { ...d.style.opt, ...(base.opt || {}) } } as Partial<DrawStyle>); }}>Reset</button>
          <span className="spacer" />
          <button className="btn" onClick={() => close(false)}>Cancel</button>
          <button className="btn primary" onClick={() => close(true)}>OK</button>
        </footer>
      </div>
    </div>
  );
}
