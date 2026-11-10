// The trade panel: buy or sell the chart you're on, sized by what you're willing to lose, with the order spelled out.
import type { Session } from '../core/session';
import { money, smoney } from '../core/account';
import { useLive } from './live';
import { place, plan, setTicket, ticket, type SizeMode } from './ticket';
import { PropCard } from './PropPanel';

const TYPES = { market: 'Buys or sells right away at the current price.', limit: 'Waits for the price to come to you, then fills at your price or better.', stop: 'Fills once the price breaks through your level.' } as const;
const MODES: Array<[SizeMode, string]> = [['risk', 'Risk $'], ['pct', 'Risk %'], ['qty', 'Contracts']];

export function TradePanel({ session, onToast }: { session: Session; onToast: (m: string, kind?: string) => void }) {
  useLive();
  const s = session, acc = s.account, f = s.activeFeed, inst = f.s.inst, prec = inst.prec;
  const bid = acc.bid(inst.sym), ask = acc.ask(inst.sym);
  const pb = plan(s, 1);
  const go = (side: 1 | -1) => { const e = place(s, side); if (e) onToast(e, 'err'); };
  const pos = acc.netPosition(inst.sym);
  const open = acc.openPnl(), closed = acc.balance - acc.start;
  const setType = (t: keyof typeof TYPES) => setTicket({ type: t, price: t === 'market' ? '' : ticket.price || (bid != null ? bid.toFixed(prec) : '') });
  const sizeVal = ticket.mode === 'risk' ? ticket.risk : ticket.mode === 'pct' ? ticket.pct : ticket.qty;
  const verb = ticket.type === 'market' ? 'now' : `at ${ticket.price || '…'}`;
  return (
    <aside className="side" aria-label="Trade">
      <div className="sec">
        <h3>Trade
          {s.feeds.length > 1 && <span className="seg" role="group" aria-label="Market to trade">
            {s.feeds.map(x => <button key={x.s.inst.sym} className={x.s.inst.sym === s.active ? 'on' : ''} onClick={() => s.setActive(x.s.inst.sym)}>{x.s.inst.sym}</button>)}
          </span>}
        </h3>
        <div className="grid2">
          <button className="qbtn sell" title="Sell: you make money if the price falls (S)" onClick={() => go(-1)}><span>SELL · price falls</span><b>{ticket.type === 'market' ? (bid != null ? bid.toFixed(prec) : '—') : ticket.price || '—'}</b></button>
          <button className="qbtn buy" title="Buy: you make money if the price rises (B)" onClick={() => go(1)}><span>BUY · price rises</span><b>{ticket.type === 'market' ? (ask != null ? ask.toFixed(prec) : '—') : ticket.price || '—'}</b></button>
        </div>
        <div className="seg full" role="group" aria-label="Order type">
          {(Object.keys(TYPES) as Array<keyof typeof TYPES>).map(t => <button key={t} className={ticket.type === t ? 'on' : ''} title={TYPES[t]} onClick={() => setType(t)}>{t[0].toUpperCase() + t.slice(1)}</button>)}
        </div>
        <span className="muted" style={{ fontSize: 12, marginTop: -6 }}>{TYPES[ticket.type]}</span>
        {ticket.type !== 'market' && (
          <label className="field"><span className="lbl">{ticket.type === 'limit' ? 'Limit price' : 'Stop price'} <span className="muted">· now {bid?.toFixed(prec)}</span></span>
            <input className="in" inputMode="decimal" value={ticket.price} onChange={e => setTicket({ price: e.target.value })} /></label>
        )}
        <div className="field">
          <span className="lbl" style={{ justifyContent: 'space-between' }}>
            <span className="lbl">{ticket.mode === 'qty' ? 'Contracts' : 'Risk per trade'} <span className="q" title="The most you lose if the price reaches your stop. The app works out how many contracts that is.">?</span></span>
            <span className="chips" role="group" aria-label="Size by">{MODES.map(([m, l]) => <button key={m} className={ticket.mode === m ? 'on' : ''} onClick={() => setTicket({ mode: m })}>{l}</button>)}</span>
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <span className="suffix" style={{ flex: 1 }}>
              <input className="in" inputMode="decimal" aria-label="Size" value={String(sizeVal)} onChange={e => { const v = parseFloat(e.target.value) || 0; setTicket(ticket.mode === 'risk' ? { risk: v } : ticket.mode === 'pct' ? { pct: v } : { qty: Math.floor(v) }); }} />
              <span>{ticket.mode === 'risk' ? 'dollars' : ticket.mode === 'pct' ? '% of account' : 'contracts'}</span>
            </span>
            {ticket.mode !== 'qty' && <span className="btn" style={{ cursor: 'default', height: 38 }}>= {pb.qty} {pb.qty === 1 ? 'contract' : 'contracts'}</span>}
          </div>
        </div>
        <div className="grid2">
          <label className="field"><span className="lbl">Stop loss <span className="q" title="Where the trade closes if it goes against you, so the loss stays small. 0 means no stop.">?</span></span>
            <span className="suffix"><input className="in" inputMode="numeric" value={ticket.slTicks} onChange={e => setTicket({ slTicks: Math.max(0, parseInt(e.target.value) || 0) })} /><span>ticks</span></span></label>
          <label className="field"><span className="lbl">Take profit <span className="q" title="Where the trade closes with a profit. 0 means no target.">?</span></span>
            <span className="suffix"><input className="in" inputMode="numeric" value={ticket.tpTicks} onChange={e => setTicket({ tpTicks: Math.max(0, parseInt(e.target.value) || 0) })} /><span>ticks</span></span></label>
        </div>
        {pb.note ? <div className="warnline">{pb.note}{ticket.mode === 'risk' && ticket.slTicks > 0 && <> <button className="btn sm" style={{ marginTop: 8 }} onClick={() => setTicket({ risk: Math.ceil(ticket.slTicks * inst.tick * inst.pv) })}>Risk ${Math.ceil(ticket.slTicks * inst.tick * inst.pv)} for 1 contract</button></>}</div> : (
          <div className="plain">
            <span className="muted">If you buy or sell {pb.qty} {pb.qty === 1 ? 'contract' : 'contracts'} of {inst.sym} {verb}:</span>
            <span className="row"><span>Price reaches your target</span><b className="num up">{ticket.tpTicks ? smoney(pb.win) : 'no target'}</b></span>
            <span className="row"><span>Price reaches your stop</span><b className="num down">{ticket.slTicks ? smoney(-pb.lose) : 'no stop: no limit'}</b></span>
            {ticket.slTicks > 0 && ticket.tpTicks > 0 && <span className="row" style={{ alignItems: 'center' }}><span className="muted">Win {(ticket.tpTicks / ticket.slTicks).toFixed(1)}× what you risk</span>
              <span className="rr" style={{ maxWidth: 110 }}><span style={{ flex: ticket.slTicks, background: 'var(--down)' }} /><span style={{ flex: ticket.tpTicks, background: 'var(--up)' }} /></span></span>}
          </div>
        )}
        {pos.q !== 0 && <div className="plain"><span className="row"><span>Your {inst.sym} position</span><b className={pos.q > 0 ? 'up' : 'down'}>{pos.q > 0 ? 'Long' : 'Short'} {Math.abs(pos.q)}</b></span>
          <span className="row"><span className="muted">Open profit / loss</span><b className={'num ' + (acc.openPnl(inst.sym) >= 0 ? 'up' : 'down')}>{smoney(acc.openPnl(inst.sym))}</b></span></div>}
      </div>
      <PropCard session={s} onToast={onToast} />
      <div className="sec">
        <h3>Account</h3>
        <div className="grid2">
          <div className="stat"><span>Balance</span><b>{money(acc.balance)}</b></div>
          <div className="stat"><span>Open trades</span><b className={open >= 0 ? 'up' : 'down'}>{smoney(open)}</b></div>
          <div className="stat"><span>Made so far</span><b className={closed >= 0 ? 'up' : 'down'}>{smoney(closed)}</b></div>
          <div className="stat" title="The most the account has fallen from its highest point"><span>Biggest drop</span><b>{money(acc.maxDD)}</b></div>
        </div>
        <div className="grid2">
          <button className="btn" disabled={!acc.trades.length} onClick={() => { acc.closeAll(); s.changed(); }}>Close all</button>
          <button className="btn" disabled={!acc.orders.length} onClick={() => { acc.cancelAll(); s.changed(); }}>Cancel orders</button>
        </div>
      </div>
    </aside>
  );
}
