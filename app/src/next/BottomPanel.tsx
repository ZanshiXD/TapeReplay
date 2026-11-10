// Under the charts: open positions, working orders, closed trades, and the way into the journal.
import { useState } from 'react';
import type { Session } from '../core/session';
import { smoney, fmtQty } from '../core/account';
import { fmtClock, fmtHM } from '../core/time';
import { useLive } from './live';

export function BottomPanel({ session, onToast, openJournal }: { session: Session; onToast: (m: string, k?: string) => void; openJournal: () => void }) {
  useLive();
  const [tab, setTab] = useState<'pos' | 'ord' | 'hist'>('pos');
  const s = session, acc = s.account;
  const prec = (sym: string) => s.feed(sym)?.s.inst.prec ?? 2;
  const tabs: Array<[typeof tab, string]> = [['pos', `Positions (${acc.trades.length})`], ['ord', `Orders (${acc.orders.length})`], ['hist', `History (${acc.hist.length})`]];
  return (
    <section className="dock" aria-label="Positions, orders and history">
      <div className="tabs" role="tablist">
        {tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}
        <button onClick={openJournal}>Journal ({s.journal.length})</button>
        <span className="spacer" />
      </div>
      <div className="body">
        {tab === 'pos' && (acc.trades.length ? (
          <table className="t"><thead><tr><th>Market</th><th>Side</th><th>Size</th><th>Entry</th><th>Stop</th><th>Target</th><th className="r">Profit / loss</th><th /></tr></thead>
            <tbody>{acc.trades.map(tr => { const p = acc.unreal(tr), n = prec(tr.sym); return (
              <tr key={tr.id}>
                <td className="ui"><b>{tr.sym}</b></td><td className={'ui ' + (tr.side > 0 ? 'up' : 'down')}><b>{tr.side > 0 ? 'Long' : 'Short'}</b></td><td>{fmtQty(tr.qty)}</td><td>{tr.entry.toFixed(n)}</td>
                <td>{tr.sl?.toFixed(n) ?? <span className="muted">none</span>}</td><td>{tr.tp?.toFixed(n) ?? <span className="muted">none</span>}</td>
                <td className={'r ' + (p >= 0 ? 'up' : 'down')}>{smoney(p)}</td>
                <td className="r ui" style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                  <button className="btn sm" title="Move the stop to your entry price, so this trade can't lose (apart from costs)" onClick={() => { const e = acc.breakeven(tr); if (e) onToast(e, 'err'); s.changed(); }}>Breakeven</button>
                  <button className="btn sm" onClick={() => { acc.closeMarket(tr); s.changed(); }}>Close</button>
                </td>
              </tr>); })}</tbody></table>
        ) : <div className="empty">No open positions. Use Buy or Sell on the right, or press B or S.</div>)}
        {tab === 'ord' && (acc.orders.length ? (
          <table className="t"><thead><tr><th>Market</th><th>Order</th><th>Size</th><th>Price</th><th>Stop</th><th>Target</th><th>Placed</th><th /></tr></thead>
            <tbody>{acc.orders.map(o => { const n = prec(o.sym); return (
              <tr key={o.id}>
                <td className="ui"><b>{o.sym}</b></td><td className={'ui ' + (o.side > 0 ? 'up' : 'down')}>{o.side > 0 ? 'Buy' : 'Sell'} {o.type}</td><td>{fmtQty(o.qty)}</td><td>{o.price.toFixed(n)}</td>
                <td>{o.sl?.toFixed(n) ?? '—'}</td><td>{o.tp?.toFixed(n) ?? '—'}</td><td className="muted">{fmtHM(o.time)}</td>
                <td className="r ui"><button className="btn sm" onClick={() => { acc.cancel(o.id); s.changed(); }}>Cancel</button></td>
              </tr>); })}</tbody></table>
        ) : <div className="empty">No working orders. Limit and stop orders wait here until the price reaches them; you can also drag them on the chart.</div>)}
        {tab === 'hist' && (acc.hist.length ? (
          <table className="t"><thead><tr><th>Market</th><th>Side</th><th>Size</th><th>Entry</th><th>Exit</th><th>Why it closed</th><th>Closed</th><th className="r">Result</th></tr></thead>
            <tbody>{acc.hist.slice().reverse().map((h, k) => { const n = prec(h.sym); return (
              <tr key={k}>
                <td className="ui"><b>{h.sym}</b></td><td className={'ui ' + (h.side > 0 ? 'up' : 'down')}>{h.side > 0 ? 'Long' : 'Short'}</td><td>{fmtQty(h.qty)}</td><td>{h.entry.toFixed(n)}</td><td>{h.exit.toFixed(n)}</td>
                <td className="ui muted">{h.reason}</td><td className="muted">{fmtClock(h.exitTime).slice(4, -3)}</td><td className={'r ' + (h.net >= 0 ? 'up' : 'down')}>{smoney(h.net)}</td>
              </tr>); })}</tbody></table>
        ) : <div className="empty">No closed trades yet. Each one also goes to the journal with a snapshot of the chart.</div>)}
      </div>
    </section>
  );
}
