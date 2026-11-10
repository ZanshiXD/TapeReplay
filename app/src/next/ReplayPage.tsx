// The Replay screen: one, two or four charts on one clock, the replay bar, the trade panel and the positions.
import { useState } from 'react';
import type { Session } from '../core/session';
import { parseTF, tfLabel, tfValid, tfSeconds } from '../core/time';
const tfSec = (t: string) => tfSeconds(parseTF(t)!);
import { ChartPane } from './ChartPane';
import { ReplayBar } from './ReplayBar';
import { TradePanel } from './TradePanel';
import { BottomPanel } from './BottomPanel';
import { IndicatorsPanel } from './IndicatorsPanel';
import { pref, setPref, useLive } from './live';
import { IInd, ILayout1, ILayout2, ILayout4, IPlus } from './icons';
import { DrawRail } from './draw/DrawRail';
import { DrawSettings } from './draw/DrawSettings';
import { ObjectTree } from './draw/ObjectTree';
import { useDrawKeys } from './draw/keys';
import { ds } from './draw/state';
import { TOOL, isDrawTool } from './draw/tools';

/** what to do with the tool just picked, in a few words */
function drawHint(id: string) {
  if (id === 'measure') return 'Measure: click where to start, then where to end';
  if (id === 'zoom') return 'Zoom in: drag over the bars you want to see';
  if (id === 'eraser') return 'Eraser: click a drawing to remove it';
  const t = TOOL[id]; if (!t || !isDrawTool(id)) return '';
  const how = t.n === 1 ? 'click on the chart' : t.n === 2 ? 'click two points, or press and drag' : t.n === 'path' ? 'click each point, double-click to finish' : t.n === 'free' ? 'press and drag to draw' : `click ${t.n} points`;
  return `${t.name}: ${how}`;
}

const TFS = ['1m', '5m', '15m', '1h', '4h', '1D'];
export type Layout = 'one' | 'two' | 'four';

export type MView = 'chart' | 'trade' | 'pos';
export function ReplayPage({ session, saveState, available, onAddMarket, onRemoveMarket, onJump, onToast, openJournal, mview = 'chart' }: {
  mview?: MView;
  session: Session; saveState: string; available: Array<{ key: string; sym: string; name: string }>; onAddMarket: (key: string) => void; onRemoveMarket: (sym: string) => void;
  onJump: (t: number) => void; onToast: (m: string, k?: string) => void; openJournal: () => void;
}) {
  useLive();
  const [layout, setLayout] = useState<Layout>(() => pref<Layout>('layout', session.feeds.length > 1 ? 'two' : 'one'));
  const [indOpen, setIndOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [tip, setTip] = useState(() => pref('tipPlay', true));
  const [tfs, setTfs] = useState<string[]>(() => pref('tfs', TFS));
  const [tfAdd, setTfAdd] = useState<string | null>(null);
  const [drawOpen, setDrawOpen] = useState(false);
  const s = session, slots = layout === 'one' ? 1 : layout === 'two' ? 2 : 4;
  const shown = layout === 'one' ? [s.activeFeed] : s.feeds.slice(0, slots);
  const free = slots - shown.length;
  const grid = layout === 'four' ? { gridTemplateColumns: '1fr 1fr', gridTemplateRows: '1fr 1fr' } : layout === 'two' ? { gridTemplateColumns: '1fr 1fr' } : { gridTemplateColumns: '1fr' };
  const pick = (l: Layout) => { setLayout(l); setPref('layout', l); };
  const hideTip = () => { setTip(false); setPref('tipPlay', false); };
  const base = Math.min(...s.feeds.map(f => f.s.base));
  useDrawKeys(s, true);
  return (
    <>
      <header className="ctx">
        <span className="title">{s.name}</span>
        <span className="muted" style={{ fontSize: 12 }}>{s.feeds.map(f => f.s.inst.sym).join(' + ')}</span>
        <div className="sep" />
        <div className="seg" role="group" aria-label="Timeframe">
          {tfs.filter(t => parseTF(t) && tfValid(parseTF(t)!, base)).map(t => <button key={t} className={tfLabel(s.tf) === t ? 'on' : ''} title={TFS.includes(t) ? undefined : 'Right-click to remove'} onContextMenu={e => { if (TFS.includes(t)) return; e.preventDefault(); const l = tfs.filter(x => x !== t); setTfs(l); setPref('tfs', l); }} onClick={() => { s.setTf(parseTF(t)!); setPref('tf', t); }}>{t}</button>)}
          {tfAdd == null ? <button title="Another timeframe (like 2m, 45m, 2h, 1W, 15s)" aria-label="Add a timeframe" onClick={() => setTfAdd('')}>+</button>
            : <input className="in" autoFocus style={{ height: 26, width: 64, fontSize: 12 }} placeholder="e.g. 2h" aria-label="New timeframe" value={tfAdd} onChange={e => setTfAdd(e.target.value)}
              onKeyDown={e => { if (e.key === 'Escape') setTfAdd(null); if (e.key !== 'Enter') return; const tf = parseTF(tfAdd.trim()); if (!tf) return onToast('Write a timeframe like 2m, 45m, 2h, 1D, 1W or 15s.', 'err'); if (!tfValid(tf, base)) return onToast('That is shorter than the bars in this data.', 'err'); const lbl = tfLabel(tf); const l = tfs.includes(lbl) ? tfs : [...tfs, lbl].sort((a, b) => (parseTF(a) ? tfSec(a) : 0) - (parseTF(b) ? tfSec(b) : 0)); setTfs(l); setPref('tfs', l); setTfAdd(null); s.setTf(tf); setPref('tf', lbl); }}
              onBlur={() => setTfAdd(null)} />}
        </div>
        <button className="btn" onClick={() => setIndOpen(!indOpen)} aria-expanded={indOpen}><IInd /> Indicators</button>
        <div className="seg" role="group" aria-label="Chart layout">
          <button className={layout === 'one' ? 'on' : ''} title="One chart" aria-label="One chart" onClick={() => pick('one')}><ILayout1 width={16} height={16} /></button>
          <button className={layout === 'two' ? 'on' : ''} title="Two charts side by side" aria-label="Two charts" onClick={() => pick('two')}><ILayout2 width={16} height={16} /></button>
          <button className={layout === 'four' ? 'on' : ''} title="Four charts" aria-label="Four charts" onClick={() => pick('four')}><ILayout4 width={16} height={16} /></button>
        </div>
        <div style={{ position: 'relative' }}>
          <button className="btn sm" disabled={!available.length} title={available.length ? 'Add another market on the same clock, to compare or trade both' : 'Every market that covers these dates is open'} onClick={() => setAddOpen(!addOpen)}><IPlus width={13} height={13} /> Add market</button>
          {addOpen && (
            <div className="pop menu" role="menu" style={{ top: 40, left: 0 }} onMouseLeave={() => setAddOpen(false)}>
              {available.map(m => <button key={m.key} role="menuitem" onClick={() => { setAddOpen(false); onAddMarket(m.key); if (layout === 'one') pick('two'); }}>{m.name}<span>{m.sym}</span></button>)}
            </div>
          )}
        </div>
        <span className="spacer" />
        {saveState && <span className="muted savestate" title="Sessions save themselves to the Library">{saveState}</span>}
        {indOpen && <IndicatorsPanel session={s} onClose={() => setIndOpen(false)} />}
      </header>
      <div className="work" data-mview={mview}>
        <div className="col">
          <div className={'chartrow' + (drawOpen ? ' drawing' : '')}>
          <button className="pencil" aria-label={drawOpen ? 'Hide the drawing tools' : 'Drawing tools'} aria-pressed={drawOpen} onClick={() => setDrawOpen(!drawOpen)}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M4 20l4-1 11-11-3-3L5 16zM14 6l3 3" /></svg></button>
          <DrawRail session={s} />
          <div className="charts" style={grid}>
            {shown.map(f => <ChartPane key={f.s.inst.sym} session={s} feed={f} active={f.s.inst.sym === s.active && shown.length > 1}
              onToast={onToast} onRemove={s.feeds.length > 1 && layout !== 'one' ? () => onRemoveMarket(f.s.inst.sym) : undefined} />)}
            {Array.from({ length: free }, (_, k) => (
              <div key={'free' + k} className="pane pane-empty">
                {available.length ? <button className="btn" onClick={() => setAddOpen(true)}><IPlus width={13} height={13} /> Add a market to compare</button> : <span>Open another market here to compare</span>}
              </div>
            ))}
            {tip && !s.playing && (
              <div className="tip" role="note">
                <span className="n">1</span>
                <span style={{ flex: 1 }}>
                  <b style={{ fontSize: 13.5 }}>Press play to start the market</b>
                  <p>Prices move as if it were live. Click <b className="up">Buy</b> if you think the price will rise, <b className="down">Sell</b> if you think it will fall. The stop loss limits what you can lose.</p>
                  <span className="acts"><button onClick={() => { hideTip(); s.play(); }}>Play</button><button onClick={hideTip}>Don't show this again</button></span>
                </span>
              </div>
            )}
            <ReplayBar session={s} onJump={onJump} />
            {drawHint(ds.tool) && <div className="drawhint" role="status">{drawHint(ds.tool)}<span>Esc to cancel</span></div>}
          </div>
          </div>
          <DrawSettings session={s} onToast={onToast} />
          <BottomPanel session={s} onToast={onToast} openJournal={openJournal} />
        </div>
        {ds.tree && <ObjectTree session={s} />}
        <TradePanel session={s} onToast={onToast} />
      </div>
    </>
  );
}
