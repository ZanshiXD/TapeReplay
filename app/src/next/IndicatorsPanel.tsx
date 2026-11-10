// The indicators on the charts: add one, change its length or color, hide it, or take it off.
import { useState } from 'react';
import type { Session } from '../core/session';
import { IND_COLORS, indLabel, type IndSpec, type IndType } from '../core/indicators';
import { setPref } from './live';
import { IClose, ISearch } from './icons';

const CATALOG: Array<{ type: IndType; len: number; name: string; what: string }> = [
  { type: 'ema', len: 20, name: 'Exponential moving average (EMA)', what: 'The average price, leaning on recent candles. Price above it: an uptrend.' },
  { type: 'sma', len: 50, name: 'Simple moving average (SMA)', what: 'The plain average of the last candles.' },
  { type: 'vwap', len: 0, name: 'VWAP', what: 'The day’s average price, weighted by volume. Resets at 6 PM New York.' },
];

export function IndicatorsPanel({ session, onClose }: { session: Session; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [edit, setEdit] = useState<string | null>(null);
  const list = session.inds;
  const save = (next: IndSpec[]) => { session.setInds(next); setPref('inds', next); };
  const add = (type: IndType, len: number) => save([...list, { id: Math.random().toString(36).slice(2, 8), type, len, color: IND_COLORS[list.length % IND_COLORS.length], on: true }]);
  const upd = (id: string, p: Partial<IndSpec>) => save(list.map(x => x.id === id ? { ...x, ...p } : x));
  const shown = CATALOG.filter(c => !q || (c.name + c.what).toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="pop" role="dialog" aria-label="Indicators" style={{ top: 48, left: 300, width: 400, padding: 0, maxHeight: 'calc(100vh - 120px)', overflow: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px 10px' }}>
        <b style={{ fontSize: 14 }}>Indicators</b>
        <button className="ib" aria-label="Close" onClick={onClose}><IClose width={14} height={14} /></button>
      </div>
      <div style={{ padding: '0 16px 12px' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, height: 38, padding: '0 12px', borderRadius: 9, background: 'var(--field)', border: '1px solid var(--line2)', color: 'var(--muted)' }}>
          <ISearch width={15} height={15} />
          <input autoFocus placeholder="Find an indicator" aria-label="Find an indicator" value={q} onChange={e => setQ(e.target.value)} style={{ flex: 1, minWidth: 0, background: 'none', border: 0, outline: 'none' }} />
        </label>
      </div>
      <div className="cap" style={{ padding: '0 16px 6px' }}>On the charts</div>
      {!list.length && <div className="muted" style={{ padding: '4px 16px 10px', fontSize: 12.5 }}>None yet. Add one below.</div>}
      {list.map(x => (
        <div key={x.id}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 16px', opacity: x.on ? 1 : 0.5 }}>
            <span style={{ width: 10, height: 10, borderRadius: 3, background: x.color, flex: 'none' }} />
            <span style={{ flex: 1, fontWeight: 600 }}>{indLabel(x)}</span>
            <button className="ib txt" onClick={() => upd(x.id, { on: !x.on })}>{x.on ? 'Hide' : 'Show'}</button>
            <button className="ib txt" aria-expanded={edit === x.id} onClick={() => setEdit(edit === x.id ? null : x.id)}>Edit</button>
            <button className="ib" title="Take it off the charts" aria-label={`Remove ${indLabel(x)}`} onClick={() => save(list.filter(y => y.id !== x.id))}><IClose width={13} height={13} /></button>
          </div>
          {edit === x.id && (
            <div style={{ display: 'flex', gap: 10, padding: '4px 16px 12px 36px', alignItems: 'flex-end' }}>
              {x.type !== 'vwap' && <label className="field" style={{ width: 110 }}>Length<input className="in" inputMode="numeric" defaultValue={x.len} onBlur={e => upd(x.id, { len: Math.max(1, parseInt(e.target.value) || x.len) })} /></label>}
              <div className="field">Color<span style={{ display: 'flex', gap: 6 }}>{IND_COLORS.map(c => <button key={c} aria-label={c} onClick={() => upd(x.id, { color: c })} style={{ width: 24, height: 24, borderRadius: 6, background: c, border: x.color === c ? '2px solid #fff' : '0', cursor: 'pointer' }} />)}</span></div>
            </div>
          )}
        </div>
      ))}
      <div style={{ height: 1, background: 'var(--line2)', margin: '8px 0' }} />
      <div className="cap" style={{ padding: '4px 16px 6px' }}>Add</div>
      {shown.map(c => (
        <button key={c.type} onClick={() => add(c.type, c.len)} style={{ display: 'flex', flexDirection: 'column', gap: 2, width: '100%', textAlign: 'left', padding: '8px 16px', background: 'none', border: 0, cursor: 'pointer' }}>
          <b>+ {c.name}</b><span className="muted" style={{ fontSize: 12 }}>{c.what}</span>
        </button>
      ))}
      <div style={{ height: 10 }} />
    </div>
  );
}
