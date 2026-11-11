// Prop firm challenge: the settings in New session, and the card beside the chart that follows the account through
// the evaluation, funded and live stages.
import { useState } from 'react';
import type { Session } from '../core/session';
import { PROP_PRESETS, SIM_DEF, applyPreset, dptNote, simConfig, type PropConfig, type PropSim, type PropRules } from '../core/prop';
import { money, smoney } from '../core/account';
import { useLive, pref, setPref } from './live';

/* ---- New session: the challenge's settings ---- */
type Field = [keyof PropConfig, string, string?];
const MAIN: Field[] = [['size', 'Account size'], ['fee', 'Evaluation fee'], ['ePt', 'Profit target'], ['eMll', 'Max loss (trails the day’s high)'], ['eCons', 'Consistency (best day, % of profit)', 'Your best day may be at most this share of the total profit. 0 turns it off.'], ['eMax', 'Max contracts (minis)'], ['eMin', 'Minimum trading days'], ['dll', 'Daily loss limit', 'Closes everything and stops trading for the day; never fails the account. 0 turns it off.'], ['eDpt', 'Your daily profit target']];
const FUNDED: Field[] = [['fMll', 'Funded max loss'], ['fTiers', 'Contracts by profit (profit:minis)'], ['fDays', 'Payout days per cycle'], ['fDayMin', 'A payout day makes at least'], ['fPayMin', 'Smallest payout'], ['fPayMax', 'Largest payout'], ['fPayPct', 'Payout: % of profit'], ['split', 'Your share (%)'], ['fPayouts', 'Payouts before live']];
const LIVE: Field[] = [['lMll', 'Live max loss'], ['lMax', 'Live max contracts (minis)'], ['lBonusPt', 'Bonus: profit needed'], ['lBonusDays', 'Bonus: trading days'], ['lBonus', 'Bonus amount']];

/** run: in a backtest's settings, where nobody is there to ask for payouts, so they are taken as soon as allowed */
export function PropSetupCard({ value, onChange, run }: { value: PropConfig; onChange: (c: PropConfig) => void; run?: boolean }) {
  const [more, setMore] = useState(false);
  const [naming, setNaming] = useState<string | null>(null);
  const saved = pref<Record<string, Partial<PropConfig>>>('propPresets', {});
  const c = value, set = (p: Partial<PropConfig>) => onChange({ ...c, ...p, preset: 'preset' in p ? p.preset! : c.preset && Object.keys(p).some(k => k !== 'unit' && k !== 'auto' && k !== 'fee') ? '' : c.preset });
  const field = ([k, l, tip]: Field) => (
    <label key={k} className="field"><span className="lbl">{l}{tip && <span className="q" title={tip}>?</span>}</span>
      <input className="in" aria-label={l} inputMode={k === 'fTiers' ? 'text' : 'decimal'} value={String(c[k])} onChange={e => set({ [k]: k === 'fTiers' ? e.target.value : Math.max(0, parseFloat(e.target.value) || 0) } as Partial<PropConfig>)} /></label>
  );
  const presets = { ...PROP_PRESETS, ...saved };
  return (
    <div className="card" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 760 }}>
      <label className="chk" style={{ fontSize: 14 }}><input type="checkbox" checked={c.on} onChange={e => onChange({ ...c, on: e.target.checked })} /><b>Practice a prop firm challenge</b></label>
      <span className="muted" style={{ fontSize: 12.5, marginTop: -6 }}>Pass the evaluation, get funded, take payouts, go live. The rules are checked on every tick, as the firm would.</span>
      {c.on && <>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label className="field" style={{ width: 240 }}>Rules<select className="in ui" value={c.preset in presets ? c.preset : ''} onChange={e => { const n = e.target.value; if (n) onChange(applyPreset(c, n, presets[n])); }}>
            <option value="">Your own</option>{Object.keys(presets).map(n => <option key={n} value={n}>{n}</option>)}</select></label>
          <div className="field">Contracts you trade<span className="seg"><button className={c.unit === 'micro' ? 'on' : ''} onClick={() => set({ unit: 'micro' })}>Micros</button><button className={c.unit === 'mini' ? 'on' : ''} onClick={() => set({ unit: 'mini' })}>Minis</button></span></div>
          {run ? <span className="muted" style={{ fontSize: 12.5, alignSelf: 'center' }}>Funded payouts are taken as soon as they are allowed.</span>
            : <label className="chk"><input type="checkbox" checked={c.auto} onChange={e => set({ auto: e.target.checked })} />Take payouts as soon as allowed</label>}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 12 }}>{MAIN.map(field)}</div>
        {c.eDpt > 0 || c.ePt > 0 ? <span className="muted" style={{ fontSize: 12 }}>{dptNote(c)}</span> : null}
        <button className="linkbtn" style={{ alignSelf: 'flex-start' }} onClick={() => setMore(!more)}>{more ? 'Hide' : 'Show'} the funded and live rules</button>
        {more && <>
          <b style={{ fontSize: 13 }}>Funded</b><div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 12 }}>{FUNDED.map(field)}</div>
          <b style={{ fontSize: 13 }}>Live</b><div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 12 }}>{[...LIVE, ['lockPad', 'Max loss locks at start +'] as Field, ['resetNY', 'Trading day starts (hour, New York)'] as Field].map(field)}</div>
        </>}
        <div style={{ display: 'flex', gap: 8 }}>
          {naming == null ? <button className="btn sm" onClick={() => setNaming('')}>Save as my rules</button>
            : <><input className="in ui" style={{ height: 28, width: 200 }} autoFocus placeholder="Name these rules" value={naming} onChange={e => setNaming(e.target.value)} />
              <button className="btn sm primary" disabled={!naming.trim()} onClick={() => { const n = naming.trim(); const { on: _o, preset: _p, ...rules } = c; void _o; void _p; setPref('propPresets', { ...saved, [n]: rules }); onChange({ ...c, preset: n }); setNaming(null); }}>Save</button></>}
          {c.preset in saved && <button className="btn sm" onClick={() => { const s2 = { ...saved }; delete s2[c.preset]; setPref('propPresets', s2); onChange({ ...c, preset: '' }); }}>Delete “{c.preset}”</button>}
        </div>
      </>}
    </div>
  );
}
export const defaultProp = () => simConfig(pref<Partial<PropConfig> | null>('propLast', null) || { ...SIM_DEF, ...applyPreset(SIM_DEF, 'L Flex 50K'), on: false });

/* ---- the card beside the chart ---- */
export function PropCard({ session, onToast }: { session: Session; onToast: (m: string, k?: string) => void }) {
  useLive();
  const [amount, setAmount] = useState('');
  const p = session.prop; if (!p) return null;
  if (p.kind === 'rules') return <RulesCard p={p as PropRules} />;
  const sim = p as PropSim, v = sim.view();
  const act = () => {
    if (!v.action) return;
    if (v.action.kind === 'restart') sim.restart();
    else { const e = sim.payout(v.action.kind === 'payoutAmount' ? parseFloat(amount) || undefined : undefined); if (e) onToast(e, 'err'); }
    session.changed();
  };
  return (
    <div className="sec propcard">
      <h3>{v.label}<span className={'pill ' + v.statusKind}>{v.status}</span></h3>
      <div className="track">{v.track.map(t => <span key={t.name} className={t.state}>{t.name}</span>)}</div>
      {v.rows.map(r => (
        <div key={r.label} className="prow">
          <span className="row"><span className="muted">{r.label}</span><b className={'num ' + (r.state === 'bad' ? 'down' : r.state === 'ok' ? 'up' : '')}>{r.value}</b></span>
          {r.frac != null && <span className="pbar"><i className={r.state} style={{ width: `${Math.round(r.frac * 100)}%` }} /></span>}
        </div>
      ))}
      {v.action && <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        {v.action.kind === 'payoutAmount' && <span className="suffix" style={{ flex: 1 }}><input className="in" inputMode="decimal" placeholder={String(v.action.amount ?? '')} value={amount} onChange={e => setAmount(e.target.value)} /><span>dollars</span></span>}
        <button className={'btn' + (v.action.kind === 'restart' ? '' : ' primary')} disabled={!v.action.enabled} title={v.action.hint} onClick={act}>{v.action.label}</button>
      </div>}
      {v.action?.hint && !v.action.enabled && <span className="muted" style={{ fontSize: 12 }}>{v.action.hint}</span>}
      <div className="grid2">{v.summary.slice(0, 4).map(([k, val]) => <div key={k} className="stat"><span>{k}</span><b>{val}</b></div>)}</div>
      {v.log.length > 0 && <div className="plog">{v.log.map((l, i) => <span key={i}>{l.text}</span>)}</div>}
    </div>
  );
}
function RulesCard({ p }: { p: PropRules }) {
  const v = p.view();
  return (
    <div className="sec propcard">
      <h3>Prop rules<span className={'pill ' + v.statusKind}>{v.status}</span></h3>
      <span className="row"><span className="muted">Equity</span><b className="num">{money(v.equity)}</b></span>
      <span className="row"><span className="muted">Today</span><b className={'num ' + (v.today >= 0 ? 'up' : 'down')}>{smoney(v.today)}</b></span>
      {v.reason && <span className="warnline">{v.reason}</span>}
    </div>
  );
}
