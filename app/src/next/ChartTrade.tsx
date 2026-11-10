// Trading on the chart, as on TradingView: each position and order has a tag on its line with its profit or loss
// and a × to close or cancel it; a position or order with no stop or target has SL and TP handles to drag out onto
// the chart; right-click (or long-press) at a price for a limit or stop order there.
import { useEffect, useRef, useState } from 'react';
import type { Session } from '../core/session';
import { fmtQty, smoney, type Order, type Trade } from '../core/account';
import { frameHooks, useLive } from './live';
import { place, plan, setTicket, ticket } from './ticket';
import { pref } from './live';

export interface ChartGeom { y(p: number): number | null; p(y: number): number | null; round(p: number): number; paneW(): number; paneH(): number }
type Drag = { kind: 'sl' | 'tp'; tr?: Trade; o?: Order; y: number; side: 1 | -1 } | null;

export function ChartTrade({ session, sym, geom, menuAt, onCloseMenu, onToast }: {
  session: Session; sym: string; geom: ChartGeom; menuAt: { x: number; y: number } | null; onCloseMenu: () => void; onToast: (m: string, k?: string) => void;
}) {
  useLive();
  const box = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag>(null);
  const s = session, acc = s.account, f = s.feed(sym), inst = f.s.inst, prec = inst.prec;
  // the tags follow their lines on every frame (the chart scrolls and zooms between renders)
  useEffect(() => {
    const move = () => {
      const el = box.current; if (!el) return;
      const h = geom.paneH();
      for (const t of el.querySelectorAll<HTMLElement>('[data-price]')) {
        const y = geom.y(+t.dataset.price!);
        if (y == null || y < 0 || y > h) { t.style.visibility = 'hidden'; continue; }
        t.style.visibility = ''; t.style.top = `${Math.round(y)}px`;
      }
    };
    frameHooks.add(move); move();
    return () => { frameHooks.delete(move); };
  }, [geom]);

  const trades = acc.trades.filter(t => t.sym === sym), orders = acc.orders.filter(o => o.sym === sym);
  const startDrag = (e: React.PointerEvent, d: NonNullable<Drag>) => {
    e.preventDefault(); e.stopPropagation(); (e.target as HTMLElement).setPointerCapture(e.pointerId); setDrag(d);
  };
  const yOf = (e: React.PointerEvent) => e.clientY - box.current!.getBoundingClientRect().top;
  const endDrag = (e: React.PointerEvent) => {
    if (!drag) return;
    const p = geom.p(yOf(e)); setDrag(null);
    if (p == null) return;
    const price = geom.round(p);
    if (drag.tr) { const err = acc.setBracket(drag.tr, drag.kind, price); if (err) onToast(err, 'err'); }
    else if (drag.o) {
      const ok = drag.kind === 'sl' ? (drag.o.side > 0 ? price < drag.o.price : price > drag.o.price) : (drag.o.side > 0 ? price > drag.o.price : price < drag.o.price);
      if (!ok) onToast(drag.kind === 'sl' ? 'A stop loss goes on the losing side of the order.' : 'A take profit goes on the winning side of the order.', 'err');
      else { drag.o[drag.kind] = price; acc.version++; }
    }
    s.changed();
  };
  const handles = (x: { sl: number | null; tp: number | null }, d: Omit<NonNullable<Drag>, 'kind' | 'y'>) => <>
    {x.tp == null && <button className="th tp" title="Drag up or down to set a take profit" onPointerDown={e => startDrag(e, { ...d, kind: 'tp', y: yOf(e) })} onPointerMove={e => drag && setDrag({ ...drag, y: yOf(e) })} onPointerUp={endDrag}>TP</button>}
    {x.sl == null && <button className="th sl" title="Drag up or down to set a stop loss" onPointerDown={e => startDrag(e, { ...d, kind: 'sl', y: yOf(e) })} onPointerMove={e => drag && setDrag({ ...drag, y: yOf(e) })} onPointerUp={endDrag}>SL</button>}
  </>;

  // the order menu at a price
  const mp = menuAt ? geom.p(menuAt.y) : null, price = mp != null ? geom.round(mp) : null;
  const now = f.price;
  const orderAt = (side: 1 | -1, bracket: boolean) => {
    onCloseMenu(); if (price == null) return;
    const type = now == null ? 'limit' : (side > 0) === (price < now) ? 'limit' : 'stop';
    const pl = plan(s, side), qty = Math.max(1, pl.qty || ticket.qty || 1);
    let sl: number | null = null, tp: number | null = null;
    if (bracket) {
      const ticks = ticket.slTicks || 20, d = ticks * inst.tick;
      sl = f.round(price - side * d); tp = f.round(price + side * d * (ticket.tpTicks && ticket.slTicks ? ticket.tpTicks / ticket.slTicks : 2));
    }
    const err = s.order(side, type, price, sl, tp, qty, sym);
    if (err) onToast(err, 'err');
  };
  const lineY = drag ? drag.y : 0;
  const dragPrice = drag ? geom.p(lineY) : null;
  const strip = pref('oneTap', true), bid = acc.bid(sym), ask = acc.ask(sym);
  const tap = (side: 1 | -1) => { s.setActive(sym); const e = place(s, side); if (e) onToast(e, 'err'); };
  return (
    <div className="ctrade" ref={box} onPointerMove={e => drag && setDrag({ ...drag, y: yOf(e) })} onPointerUp={endDrag} style={{ pointerEvents: drag ? 'auto' : 'none' }}>
      {trades.map(tr => { const pnl = acc.unreal(tr); return (
        <div key={'t' + tr.id} className={'ttag ' + (tr.side > 0 ? 'long' : 'short')} data-price={tr.entry}>
          <span className="q">{tr.side > 0 ? '+' : '−'}{fmtQty(tr.qty)}</span><b className={pnl >= 0 ? 'up' : 'down'}>{smoney(pnl)}</b>
          {handles(tr, { tr, side: tr.side as 1 | -1 })}
          <button className="tx" title="Close this position" aria-label={`Close the ${sym} position`} onClick={() => { acc.closeMarket(tr); s.changed(); }}>×</button>
        </div>); })}
      {trades.flatMap(tr => (['sl', 'tp'] as const).filter(k => tr[k] != null).map(k => (
        <div key={k + tr.id} className={'ttag small ' + k} data-price={tr[k]!}>
          <span>{k.toUpperCase()}</span>
          <button className="tx" title={k === 'sl' ? 'Remove the stop loss' : 'Remove the take profit'} aria-label={`Remove the ${k === 'sl' ? 'stop loss' : 'take profit'}`} onClick={() => { acc.setBracket(tr, k, null); s.changed(); }}>×</button>
        </div>)))}
      {orders.map(o => (
        <div key={'o' + o.id} className="ttag order" data-price={o.price}>
          <span className="q">{o.side > 0 ? 'Buy' : 'Sell'} {o.type} {fmtQty(o.qty)}</span>
          {handles(o, { o, side: o.side as 1 | -1 })}
          <button className="tx" title="Cancel this order" aria-label="Cancel the order" onClick={() => { acc.cancel(o.id); s.changed(); }}>×</button>
        </div>))}
      {strip && <div className="onetap" role="group" aria-label={`Trade ${sym}`}>
        <button className="sell" title="Sell now, with the trade panel's size, stop and target (S)" onClick={() => tap(-1)}><span>SELL</span>{bid != null ? bid.toFixed(prec) : '—'}</button>
        <span className="qty" title="Contracts, from the trade panel">{Math.max(0, plan(s, 1).qty)}</span>
        <button className="buy" title="Buy now, with the trade panel's size, stop and target (B)" onClick={() => tap(1)}><span>BUY</span>{ask != null ? ask.toFixed(prec) : '—'}</button>
      </div>}
      {drag && dragPrice != null && <div className={'dragline ' + drag.kind} style={{ top: lineY }}><span>{drag.kind.toUpperCase()} {dragPrice.toFixed(prec)}</span></div>}
      {menuAt && price != null && (
        <div className="pop menu chartmenu" style={{ left: Math.min(menuAt.x, geom.paneW() - 260), top: menuAt.y, pointerEvents: 'auto' }} onMouseLeave={onCloseMenu} onMouseDown={e => e.stopPropagation()}>
          <h5>At {price.toFixed(prec)}</h5>
          <button onClick={() => orderAt(1, false)}>Buy {now != null && price > now ? 'stop' : 'limit'}<span>{price.toFixed(prec)}</span></button>
          <button onClick={() => orderAt(-1, false)}>Sell {now != null && price < now ? 'stop' : 'limit'}<span>{price.toFixed(prec)}</span></button>
          <button onClick={() => orderAt(1, true)}>Buy with stop and target</button>
          <button onClick={() => orderAt(-1, true)}>Sell with stop and target</button>
          <button onClick={() => { onCloseMenu(); setTicket({ type: now != null && price < now ? 'limit' : 'stop', price: price.toFixed(prec) }); }}>Use as the ticket's order price</button>
          {acc.orders.length > 0 && <button onClick={() => { onCloseMenu(); acc.cancelAll(); s.changed(); }}>Cancel all orders</button>}
        </div>
      )}
    </div>
  );
}
