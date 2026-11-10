// The order ticket's settings and the order they make. Shared by the trade panel and the keyboard (B and S).
import type { Session } from '../core/session';
import { pref, setPref, bump } from './live';

export type SizeMode = 'risk' | 'pct' | 'qty';
export interface Ticket { type: 'market' | 'limit' | 'stop'; mode: SizeMode; risk: number; pct: number; qty: number; slTicks: number; tpTicks: number; price: string }
export const ticket: Ticket = { type: 'market', mode: 'risk', risk: 150, pct: 0.5, qty: 1, slTicks: 15, tpTicks: 30, price: '', ...pref<Partial<Ticket>>('ticket', {}) };
export function setTicket(p: Partial<Ticket>) { Object.assign(ticket, p); const { price: _, ...keep } = ticket; setPref('ticket', keep); bump(); }

/** what the ticket would do on the active market now */
export function plan(s: Session, side: 1 | -1) {
  const f = s.activeFeed, inst = f.s.inst, acc = s.account;
  const perTick = inst.tick * inst.pv;
  const entry = ticket.type === 'market' ? (side > 0 ? acc.ask(inst.sym) : acc.bid(inst.sym)) : parseFloat(ticket.price);
  const riskPer = ticket.slTicks > 0 ? ticket.slTicks * perTick : 0;
  let qty = ticket.qty, note = '';
  if (ticket.mode !== 'qty') {
    const want = ticket.mode === 'risk' ? ticket.risk : acc.equity() * ticket.pct / 100;
    if (!riskPer) { qty = 0; note = 'Sizing by risk needs a stop loss.'; }
    else { qty = Math.floor(want / riskPer + 1e-9); if (qty < 1) note = `One contract with this stop risks $${riskPer.toFixed(0)}, more than you set. Risk more or tighten the stop.`; }
  }
  const sl = entry != null && isFinite(entry) && ticket.slTicks > 0 ? f.round(entry - side * ticket.slTicks * inst.tick) : null;
  const tp = entry != null && isFinite(entry) && ticket.tpTicks > 0 ? f.round(entry + side * ticket.tpTicks * inst.tick) : null;
  return { entry, qty, sl, tp, lose: qty * riskPer, win: qty * ticket.tpTicks * perTick, note, sym: inst.sym };
}

/** places the ticket's order; returns an error in plain words, or null */
export function place(s: Session, side: 1 | -1): string | null {
  const p = plan(s, side);
  if (p.entry == null || !isFinite(p.entry)) return ticket.type === 'market' ? 'Press play or step forward first, so the market has a price.' : 'Enter the price for the order.';
  if (p.note && p.qty < 1) return p.note;
  if (p.qty < 1) return 'The size must be at least one contract.';
  return s.order(side, ticket.type, p.entry, p.sl, p.tp, p.qty);
}
