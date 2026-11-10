// The journal: every closed trade, saved with a snapshot of the charts and its numbers, to tag, rate and annotate.
import { useMemo, useState } from 'react';
import type { Session } from '../core/session';
import type { JournalEntry, JournalSnap } from '../core/journal';
import { money, smoney, fmtQty } from '../core/account';
import { fmtClock, fmtHM, spanText } from '../core/time';
import { useLive } from './live';
import { ICheck, ITrash } from './icons';

/** a snapshot as a small candle chart, with the entry, the exit and the stop and target zones */
function SnapChart({ x, e, main }: { x: JournalSnap; e: JournalEntry; main: boolean }) {
  const W = 600, H = 300, cs = x.candles;
  if (!cs.length) return null;
  const lo0 = Math.min(...cs.map(c => c[3])), hi0 = Math.max(...cs.map(c => c[2]));
  const ext = main ? [e.entry, e.exit, ...(e.sl != null ? [e.sl] : []), ...(e.tp != null ? [e.tp] : [])] : [];
  const lo = Math.min(lo0, ...ext), hi = Math.max(hi0, ...ext), pad = (hi - lo) * 0.08 || 1;
  const Y = (p: number) => 14 + (hi + pad - p) / (hi - lo + 2 * pad) * (H - 28), step = W / (cs.length + 2);
  const X = (t: number) => { let k = cs.findIndex(c => c[0] > t); if (k < 0) k = cs.length; return (k - 1) * step + step / 2; };
  const xe = X(e.time), xx = X(e.exitTime);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ display: 'block', width: '100%', height: 'auto' }} role="img" aria-label={`${x.sym} chart around the trade`}>
      {main && e.sl != null && <rect x={xe} y={Math.min(Y(e.entry), Y(e.sl))} width={Math.max(4, xx - xe)} height={Math.abs(Y(e.sl) - Y(e.entry))} fill="rgba(239,83,80,.16)" />}
      {main && e.tp != null && <rect x={xe} y={Math.min(Y(e.entry), Y(e.tp))} width={Math.max(4, xx - xe)} height={Math.abs(Y(e.tp) - Y(e.entry))} fill="rgba(38,166,154,.16)" />}
      {cs.map((c, k) => {
        const x0 = k * step + step * 0.2, w = step * 0.6, up = c[4] >= c[1], col = up ? '#26a69a' : '#ef5350';
        return <g key={k}><line x1={x0 + w / 2} x2={x0 + w / 2} y1={Y(c[2])} y2={Y(c[3])} stroke={col} strokeWidth={1} /><rect x={x0} y={Y(Math.max(c[1], c[4]))} width={w} height={Math.max(1, Math.abs(Y(c[1]) - Y(c[4])))} fill={col} /></g>;
      })}
      {main && <>
        <line x1={xe} x2={xx} y1={Y(e.entry)} y2={Y(e.exit)} stroke="#d1d4dc" strokeWidth={1} strokeDasharray="3 3" />
        <circle cx={xe} cy={Y(e.entry)} r={5} fill={e.side > 0 ? '#26a69a' : '#ef5350'} stroke="#0d1016" strokeWidth={2} />
        <circle cx={xx} cy={Y(e.exit)} r={5} fill={e.net >= 0 ? '#26a69a' : '#ef5350'} stroke="#0d1016" strokeWidth={2} />
        <text x={Math.max(4, xe - 100)} y={Y(e.entry) - 9} fill="#d1d4dc" fontSize="11" fontWeight="600" fontFamily="Inter, sans-serif">{e.side > 0 ? 'Bought' : 'Sold'} {e.entry.toFixed(x.prec)}</text>
        <text x={Math.min(W - 90, xx + 8)} y={Math.min(H - 6, Y(e.exit) + (Math.abs(xx - xe) < 60 ? 18 : 4))} fill={e.net >= 0 ? '#4fd1c0' : '#ff8a86'} fontSize="11" fontWeight="600" fontFamily="Inter, sans-serif">{e.reason}</text>
      </>}
      {!main && <><line x1={xe} x2={xe} y1={10} y2={H - 10} stroke="#7aa2ff" strokeDasharray="3 4" opacity={0.6} /><line x1={xx} x2={xx} y1={10} y2={H - 10} stroke="#7aa2ff" strokeDasharray="3 4" opacity={0.6} /></>}
    </svg>
  );
}

const RATINGS: Array<[JournalEntry['rating'], string]> = [['plan', 'Followed my plan'], ['broke', 'Broke a rule'], ['unsure', 'Unsure']];

export function JournalPage({ session, onReplay }: { session: Session; onReplay: () => void }) {
  useLive();
  const [filter, setFilter] = useState<'all' | 'wins' | 'losses'>('all');
  const [sel, setSel] = useState<string | null>(null);
  const [newTag, setNewTag] = useState('');
  const [confirmDel, setConfirmDel] = useState(false);
  const all = session.journal;
  const list = all.filter(e => filter === 'all' || (filter === 'wins') === (e.net >= 0)).slice().reverse();
  const e = list.find(x => x.id === sel) || list[0];
  const tot = useMemo(() => {
    const n = all.length, wins = all.filter(x => x.net >= 0), losses = all.filter(x => x.net < 0);
    const rs = all.filter(x => x.r != null).map(x => x.r!);
    const tags = new Map<string, number[]>(); for (const x of all) for (const t of x.tags) { const a = tags.get(t) || []; a.push(x.net); tags.set(t, a); }
    let best = ''; let bestV = -Infinity; for (const [t, a] of tags) { const v = a.reduce((p, q) => p + q, 0); if (v > bestV) { bestV = v; best = `${t} · ${a.filter(v2 => v2 >= 0).length} of ${a.length}`; } }
    return { n, win: n ? wins.length / n * 100 : 0, net: all.reduce((p, q) => p + q.net, 0), avgW: wins.length ? wins.reduce((p, q) => p + q.net, 0) / wins.length : 0, avgL: losses.length ? losses.reduce((p, q) => p + q.net, 0) / losses.length : 0, exp: rs.length ? rs.reduce((p, q) => p + q, 0) / rs.length : null, best };
  }, [all.length, all.map(x => x.tags.join()).join('|')]);
  const upd = (p: Partial<JournalEntry>) => { if (e) { Object.assign(e, p); session.changed(); } };
  if (!all.length) return (
    <div className="page"><div className="page-in" style={{ alignItems: 'center', textAlign: 'center', paddingTop: 80 }}>
      <h1>Your journal</h1>
      <p className="lead" style={{ maxWidth: 520 }}>Every trade you close is saved here automatically, with a picture of the chart, what it made, how far it went for and against you, and room for your notes.</p>
      <button className="btn primary" style={{ height: 42, padding: '0 20px' }} onClick={onReplay}>Back to the chart</button>
    </div></div>
  );
  const prec = e ? e.snaps[0]?.prec ?? 2 : 2;
  const stats: Array<[string, string, string, string]> = e ? [
    ['Result', smoney(e.net), e.net >= 0 ? 'up' : 'down', `After ${money(e.comm)} in commission`],
    ['In units of risk', e.r != null ? `${e.r >= 0 ? '+' : ''}${e.r.toFixed(2)} R` : 'no stop', e.r != null ? (e.r >= 0 ? 'up' : 'down') : '', 'The result divided by what the trade risked at its stop'],
    ['Entry → exit', `${e.entry.toFixed(prec)} → ${e.exit.toFixed(prec)}`, '', ''],
    ['Risked', e.risk != null ? money(e.risk) : 'no stop', '', 'What you would have lost at the first stop'],
    ['Best it got', smoney(e.mfe), 'up', 'The furthest the trade went your way'],
    ['Worst it got', smoney(e.mae), 'down', 'The furthest the trade went against you'],
    ['Held', `${spanText(e.heldSec)} · ${e.bars} ${e.bars === 1 ? 'candle' : 'candles'}`, '', ''],
    ['Balance after', money(e.balanceAfter), '', ''],
  ] : [];
  return (
    <div className="page" style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <header className="ctx" style={{ height: 'auto', padding: '12px 20px', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginRight: 8 }}><b style={{ fontSize: 18 }}>Journal</b><span className="muted" style={{ fontSize: 12 }}>Every closed trade, saved automatically with a snapshot and its numbers.</span></div>
        <span className="seg" role="group" aria-label="Show">
          {(['all', 'wins', 'losses'] as const).map(k => <button key={k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>{k[0].toUpperCase() + k.slice(1)}</button>)}
        </span>
      </header>
      <div className="totals">
        <div><span>Trades</span><b>{tot.n}</b></div>
        <div title="How many trades made money"><span>Win rate</span><b>{tot.win.toFixed(0)}%</b></div>
        <div><span>Profit</span><b className={tot.net >= 0 ? 'up' : 'down'}>{smoney(tot.net)}</b></div>
        <div title="A typical winner against a typical loser"><span>Avg win / loss</span><b>{money(tot.avgW)} / {money(Math.abs(tot.avgL))}</b></div>
        <div title="What an average trade earns, in units of risk"><span>Expectancy</span><b className={(tot.exp ?? 0) >= 0 ? 'up' : 'down'}>{tot.exp == null ? '—' : `${tot.exp >= 0 ? '+' : ''}${tot.exp.toFixed(2)} R`}</b></div>
        <div title="Your most profitable tag"><span>Best setup</span><b style={{ fontSize: 14 }}>{tot.best || '—'}</b></div>
      </div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <div className="jlist">
          {list.map(x => (
            <button key={x.id} className={x === e ? 'on' : ''} onClick={() => { setSel(x.id); setConfirmDel(false); }}>
              <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
                <span><b>{x.sym} {x.side > 0 ? 'long' : 'short'}</b> <span className="muted" style={{ fontSize: 11.5 }}>{fmtClock(x.exitTime, false).slice(4)}</span></span>
                <span className="muted" style={{ fontSize: 11.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{x.tags.join(' · ') || x.reason}</span>
              </span>
              <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3 }}>
                <b className={'num ' + (x.net >= 0 ? 'up' : 'down')}>{smoney(x.net)}</b>
                <span className="num muted" style={{ fontSize: 11.5 }}>{x.r != null ? `${x.r >= 0 ? '+' : ''}${x.r.toFixed(1)} R` : ''}</span>
              </span>
            </button>
          ))}
          {!list.length && <div className="empty">No {filter} yet.</div>}
        </div>
        {e && <main style={{ flex: 1, minWidth: 0, overflow: 'auto', padding: '18px 22px 28px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <span className="tag" style={{ background: e.side > 0 ? 'var(--up)' : 'var(--down)', color: '#fff', fontSize: 12, padding: '3px 9px' }}>{e.side > 0 ? 'LONG' : 'SHORT'}</span>
            <b style={{ fontSize: 18 }}>{e.sym} · {fmtQty(e.qty)} {e.qty === 1 ? 'contract' : 'contracts'}</b>
            <span className="muted" style={{ fontSize: 12.5 }}>{fmtClock(e.time, false)} → {fmtHM(e.exitTime)} · trade #{e.dayNo} of the day</span>
            <span className="spacer" />
            <span className="up" style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}><ICheck width={14} height={14} />Saved automatically</span>
            {!confirmDel ? <button className="ib" title="Delete this entry" aria-label="Delete this entry" onClick={() => setConfirmDel(true)}><ITrash /></button>
              : <span style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5 }}>Delete this entry? <button className="btn sm" onClick={() => setConfirmDel(false)}>Cancel</button><button className="btn sm danger" onClick={() => { session.journal.splice(session.journal.indexOf(e), 1); setConfirmDel(false); setSel(null); session.changed(); }}>Delete</button></span>}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: e.snaps.length > 1 ? 'minmax(0,1.4fr) minmax(0,1fr)' : '1fr', gap: 12 }}>
            {e.snaps.map((x, k) => (
              <figure key={x.sym} className="snap"><SnapChart x={x} e={e} main={k === 0} />
                <figcaption><span>{x.sym} · {x.tf}{k > 0 ? ' · the other market at the same time' : ''}</span><span>{k === 0 ? 'entry to exit' : 'dashed: entry and exit'}</span></figcaption></figure>
            ))}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: 10 }}>
            {stats.map(([l, v, c, t]) => <div key={l} className="stat" title={t}><span>{l}</span><b className={c}>{v}</b></div>)}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 12 }}>
            <div className="card" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <span className="cap">Setup</span>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {e.tags.map(t => <button key={t} className="pill" title="Remove this tag" onClick={() => upd({ tags: e.tags.filter(x => x !== t) })}>{t} ×</button>)}
                <form onSubmit={ev => { ev.preventDefault(); const t = newTag.trim(); if (t && !e.tags.includes(t)) upd({ tags: [...e.tags, t] }); setNewTag(''); }}>
                  <input className="pill add" placeholder="+ Tag (e.g. SMT)" value={newTag} onChange={ev => setNewTag(ev.target.value)} style={{ width: 130 }} />
                </form>
              </div>
              <span className="cap" style={{ marginTop: 6 }}>How it went</span>
              <span className="seg">{RATINGS.map(([k, l]) => <button key={k} className={e.rating === k ? 'on' : ''} onClick={() => upd({ rating: e.rating === k ? '' : k })}>{l}</button>)}</span>
            </div>
            <label className="card" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <span className="cap">Notes</span>
              <textarea rows={5} placeholder="Why did you take it? What would you do differently?" value={e.notes} onChange={ev => upd({ notes: ev.target.value })} style={{ resize: 'vertical', background: 'transparent', border: 0, outline: 'none', lineHeight: 1.6 }} />
            </label>
          </div>
        </main>}
      </div>
    </div>
  );
}
