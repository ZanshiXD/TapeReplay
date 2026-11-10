// Under the charts: open positions, working orders, closed trades, and the way into the journal.
import { useEffect, useRef, useState } from 'react';
import { createChart, type UTCTimestamp } from 'lightweight-charts';
import type { Session } from '../core/session';
import { money, smoney, fmtQty, type Trade } from '../core/account';
import { fmtClock, fmtHM, spanText } from '../core/time';
import { computeStats, tradesCsv, type Stats } from '../core/stats';
import { useLive, pref, setPref } from './live';

/** a stop or target typed into the positions table */
function BracketInput({ tr, k, n, onSet }: { tr: Trade; k: 'sl' | 'tp'; n: number; onSet: (p: number | null) => void }) {
  const v = tr[k];
  return <input className="in" inputMode="decimal" aria-label={k === 'sl' ? 'Stop loss price' : 'Take profit price'} placeholder="none" key={String(v)} defaultValue={v != null ? v.toFixed(n) : ''}
    onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
    onBlur={e => { const t = e.target.value.trim(), x = parseFloat(t); if (t === '' && v != null) onSet(null); else if (isFinite(x) && x !== v) onSet(x); }} />;
}

function EquityCurve({ st }: { st: Stats }) {
  const el = useRef<HTMLDivElement>(null);
  const series = useRef<ReturnType<ReturnType<typeof createChart>['addAreaSeries']> | null>(null);
  const chart = useRef<ReturnType<typeof createChart> | null>(null);
  useEffect(() => {
    const ch = createChart(el.current!, { autoSize: true, layout: { background: { color: 'transparent' }, textColor: '#8a91a0', fontSize: 10 }, grid: { vertLines: { visible: false }, horzLines: { color: '#161a22' } },
      rightPriceScale: { borderVisible: false }, timeScale: { visible: false, borderVisible: false }, handleScroll: false, handleScale: false, crosshair: { horzLine: { visible: false } } });
    chart.current = ch;
    series.current = ch.addAreaSeries({ lineColor: '#2962ff', topColor: 'rgba(41,98,255,.3)', bottomColor: 'rgba(41,98,255,0)', lineWidth: 2, priceLineVisible: false });
    return () => ch.remove();
  }, []);
  // one point per closed trade, on an even axis (trades are hours or days apart)
  useEffect(() => { series.current?.setData(st.curve.map((p, i) => ({ time: (i + 1) as UTCTimestamp, value: p.v }))); chart.current?.timeScale().fitContent(); }, [st]);
  return <div className="eqchart" ref={el} />;
}

export function BottomPanel({ session, onToast, openJournal }: { session: Session; onToast: (m: string, k?: string) => void; openJournal: () => void }) {
  useLive();
  const [tab, setTabS] = useState<'pos' | 'ord' | 'hist' | 'perf'>(() => pref('dockTab', 'pos'));
  const setTab = (t: typeof tab) => { setTabS(t); setPref('dockTab', t); };
  const s = session, acc = s.account;
  const prec = (sym: string) => s.feed(sym)?.s.inst.prec ?? 2;
  const tabs: Array<[typeof tab, string]> = [['pos', `Positions (${acc.trades.length})`], ['ord', `Orders (${acc.orders.length})`], ['hist', `History (${acc.hist.length})`], ['perf', 'Performance']];
  const st = tab === 'perf' ? computeStats(acc.hist, acc.start) : null;
  const copy = async () => { try { await navigator.clipboard.writeText(tradesCsv(acc.hist, prec)); onToast('The trades are copied, as CSV: paste them into a spreadsheet.', 'up'); } catch { onToast('Could not copy: the browser blocked the clipboard.', 'err'); } };
  return (
    <section className="dock" aria-label="Positions, orders and history">
      <div className="tabs" role="tablist">
        {tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}
        <button onClick={openJournal}>Journal ({s.journal.length})</button>
        <span className="spacer" />
        {(tab === 'hist' || tab === 'perf') && acc.hist.length > 0 && <button className="btn sm" style={{ height: 26 }} onClick={copy}>Copy trades (CSV)</button>}
      </div>
      <div className="body">
        {tab === 'pos' && (acc.trades.length ? (
          <table className="t"><thead><tr><th>Market</th><th>Side</th><th>Size</th><th>Entry</th><th>Stop</th><th>Target</th><th className="r">Profit / loss</th><th /></tr></thead>
            <tbody>{acc.trades.map(tr => { const p = acc.unreal(tr), n = prec(tr.sym); return (
              <tr key={tr.id}>
                <td className="ui"><b>{tr.sym}</b></td><td className={'ui ' + (tr.side > 0 ? 'up' : 'down')}><b>{tr.side > 0 ? 'Long' : 'Short'}</b></td><td>{fmtQty(tr.qty)}</td><td>{tr.entry.toFixed(n)}</td>
                {(['sl', 'tp'] as const).map(k => <td key={k}><BracketInput tr={tr} k={k} n={n} onSet={p => { const e = acc.setBracket(tr, k, p); if (e) onToast(e, 'err'); s.changed(); }} /></td>)}
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
        {tab === 'perf' && st && (st.trades ? <div className="perf">
          <div className="sgrid">{([
            ['Net profit / loss', <span className={st.net >= 0 ? 'up' : 'down'}>{smoney(st.net)}</span>], ['Return', `${st.ret >= 0 ? '+' : ''}${st.ret.toFixed(2)}%`], ['Trades', st.trades],
            ['Win rate', st.winRate != null ? (st.winRate * 100).toFixed(1) + '%' : '—'], ['Profit factor', st.profitFactor == null ? '—' : isFinite(st.profitFactor) ? st.profitFactor.toFixed(2) : '∞'],
            ['Average win', st.avgWin != null ? money(st.avgWin) : '—'], ['Average loss', st.avgLoss != null ? money(st.avgLoss) : '—'], ['Expectancy a trade', st.expectancy != null ? smoney(st.expectancy) : '—'],
            ['Largest win', st.largestWin != null ? money(st.largestWin) : '—'], ['Largest loss', st.largestLoss != null ? money(st.largestLoss) : '—'], ['Longest losing streak', st.maxLosingStreak],
            ['Long / short', `${st.longs} / ${st.shorts}`], ['Average hold', st.avgHold != null ? spanText(st.avgHold) : '—'], ['Costs paid', money(st.costs)],
            ['Biggest drop', st.maxDD ? `${money(st.maxDD)} (${st.maxDDpct.toFixed(1)}%)` : '$0.00'],
            ...(s.prop && 'statRows' in s.prop ? (s.prop as { statRows(): Array<[string, string]> }).statRows() : []),
          ] as Array<[string, React.ReactNode]>).map(([k, v]) => <div key={k}><span>{k}</span><b>{v}</b></div>)}</div>
          <EquityCurve st={st} />
        </div> : <div className="empty">Your results show here once a trade closes: win rate, profit factor, the biggest drop and how your account grew.</div>)}
      </div>
    </section>
  );
}
