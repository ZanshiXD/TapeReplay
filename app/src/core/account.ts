// The trading account: orders, open trades and closed ones, on one or more markets. Ported from the classic app's
// trading code, which it follows exactly in how orders fill: market orders at the bid or ask (buys pay the spread),
// limits at their price, stops at their price plus slippage, a gap through either at the price it gapped to; stop
// losses checked before take profits. Netting: one position per market, like futures brokers.

export type Side = 1 | -1;
export interface Quote { price: number | null; spread: number; slip: number; pv: number; comm: number; time: number; barTime: number; round(x: number): number }
export interface Order { id: number; sym: string; side: Side; type: 'limit' | 'stop'; price: number; qty: number; sl: number | null; tp: number | null; time: number }
export interface Trade {
  id: number; sym: string; side: Side; qty: number; entry: number; time: number; sl: number | null; tp: number | null; comm: number; how: string;
  /** the stop when the trade opened, for its result in units of risk */
  sl0: number | null;
  /** the best and worst prices it has seen since it opened */
  best: number; worst: number;
}
export interface Closed extends Trade { exit: number; exitTime: number; gross: number; net: number; reason: string; balanceAfter: number }
export interface Mark { sym: string; t: number; side: Side; kind: 'in' | 'out'; id: number; reason?: string }
export interface AccountEvent { kind: 'entry' | 'exit' | 'placed' | 'cancelled' | 'error' | 'pause'; text: string; sym?: string; up?: boolean; closed?: Closed }
/** one fill, as strategies see it: side of the fill (1 buy, -1 sell), entry or exit, its reason, the trade it belongs
 * to and, on exits, the net P&L of the part closed */
export interface FillEvent { sym: string; side: Side; qty: number; price: number; kind: 'entry' | 'exit'; reason: string; id: number; pnl: number | null; time: number }

const nf2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const money = (x: number) => (x < 0 ? '−$' : '$') + nf2.format(Math.abs(x));
export const smoney = (x: number) => (x > 0.004 ? '+$' : x < -0.004 ? '−$' : '$') + nf2.format(Math.abs(x));
export const fmtQty = (q: number) => String(+(+q).toPrecision(8));

export interface AccountState {
  balance: number; start: number; orders: Order[]; trades: Trade[]; hist: Closed[]; marks: Mark[]; nextId: number; peak: number; maxDD: number; maxDDpct?: number;
}

export class Account {
  balance: number; start: number;
  orders: Order[] = []; trades: Trade[] = []; hist: Closed[] = []; marks: Mark[] = [];
  nextId = 1; peak: number; maxDD = 0;
  /** the largest drawdown as a percent of the peak it fell from (when it was the largest in dollars) */
  maxDDpct = 0;
  /** 'classic': the classic app's order messages and fill reasons (Limit fill, Stop fill), for strategy runs */
  wording: 'app' | 'classic' = 'app';
  /** every fill is its own trade instead of netting into one position per market */
  hedge = false;
  /** pause the replay when an order or a stop or target fills */
  pauseOnFill = false;
  /** bumps on every change, so the screens know to redraw the tables and lines */
  version = 0;
  quote: (sym: string) => Quote = () => { throw new Error('no market'); };
  onEvent: (e: AccountEvent) => void = () => {};
  /** every fill as it happens (backtests hand these to the strategy's on_fill) */
  onFill: ((f: FillEvent) => void) | null = null;

  constructor(balance: number) { this.balance = this.start = this.peak = balance; }

  bid(sym: string) { return this.quote(sym).price; }
  ask(sym: string) { const q = this.quote(sym); return q.price == null ? null : q.round(q.price + q.spread); }
  unreal(tr: Trade) { const q = this.quote(tr.sym); return q.price == null ? 0 : ((tr.side > 0 ? q.price : q.price + q.spread) - tr.entry) * tr.side * tr.qty * q.pv; }
  equity() { let e = this.balance; for (const tr of this.trades) e += this.unreal(tr); return e; }
  openPnl(sym?: string) { let e = 0; for (const tr of this.trades) if (!sym || tr.sym === sym) e += this.unreal(tr); return e; }
  netPosition(sym: string) {
    let q = 0, cost = 0;
    for (const t of this.trades) if (t.sym === sym) { q += t.side * t.qty; cost += t.side * t.qty * t.entry; }
    return { q, avg: q ? cost / q : null };
  }
  private commOf(sym: string, q: number) { return Math.abs(q) * this.quote(sym).comm; }
  trackDD() { const eq = this.equity(); if (eq > this.peak) this.peak = eq; const dd = this.peak - eq; if (dd > this.maxDD) { this.maxDD = dd; this.maxDDpct = this.peak > 0 ? dd / this.peak * 100 : 0; } }
  private changed(auto: boolean) { this.version++; if (auto && this.pauseOnFill) this.onEvent({ kind: 'pause', text: '' }); }

  // Netting: an opposite fill reduces, closes or flips the position (oldest trade first); a same-side fill adds to it at
  // the average price and keeps its stop and target.
  openTrade(sym: string, side: Side, qty: number, px: number, sl: number | null, tp: number | null, how: string, auto: boolean, id?: number): Trade | null {
    if (this.hedge) return this.addTrade(sym, side, qty, px, sl, tp, how, auto, id);
    let left = qty;
    for (const tr of this.trades.filter(t => t.sym === sym && t.side === -side)) {
      if (left <= 1e-9) break;
      if (tr.qty <= left + 1e-9) { left -= tr.qty; this.closeTrade(tr, px, how, auto); }
      else { this.reduceTrade(tr, left, px, how, auto); left = 0; }
    }
    if (left <= 1e-9) return null;
    const same = this.trades.find(t => t.sym === sym && t.side === side);
    return same ? this.growTrade(same, left, px, sl, tp, how, auto) : this.addTrade(sym, side, left, px, sl, tp, how, auto, id);
  }
  private addTrade(sym: string, side: Side, qty: number, px: number, sl: number | null, tp: number | null, how: string, auto: boolean, id?: number): Trade {
    const q = this.quote(sym); px = q.round(px);
    const c = this.commOf(sym, qty); this.balance -= c;
    const tr: Trade = { id: id || this.nextId++, sym, side, qty, entry: px, time: q.time, sl, tp, comm: c, how, sl0: sl, best: px, worst: px };
    this.trades.push(tr);
    if (this.onFill) this.onFill({ sym, side, qty, price: px, kind: 'entry', reason: how, id: tr.id, pnl: null, time: q.time });
    this.marks.push({ sym, t: q.barTime, side, kind: 'in', id: tr.id });
    this.onEvent({ kind: 'entry', sym, up: side > 0, text: `${side > 0 ? 'Bought' : 'Sold'} ${fmtQty(qty)} ${sym} at ${px.toFixed(this.prec(sym))}` });
    this.changed(auto);
    return tr;
  }
  private growTrade(tr: Trade, qn: number, px: number, sl: number | null, tp: number | null, how: string, auto: boolean): Trade {
    const q = this.quote(tr.sym); px = q.round(px);
    const c = this.commOf(tr.sym, qn); this.balance -= c;
    tr.entry = (tr.entry * tr.qty + px * qn) / (tr.qty + qn);
    tr.qty += qn; tr.comm += c;
    if (this.onFill) this.onFill({ sym: tr.sym, side: tr.side, qty: qn, price: px, kind: 'entry', reason: how, id: tr.id, pnl: null, time: q.time });
    if (tr.sl == null && sl != null) { tr.sl = sl; tr.sl0 ??= sl; }
    if (tr.tp == null && tp != null) tr.tp = tp;
    this.marks.push({ sym: tr.sym, t: q.barTime, side: tr.side, kind: 'in', id: tr.id });
    this.onEvent({ kind: 'entry', sym: tr.sym, up: tr.side > 0, text: `${tr.side > 0 ? 'Bought' : 'Sold'} ${fmtQty(qn)} more ${tr.sym}: ${fmtQty(tr.qty)} at ${tr.entry.toFixed(this.prec(tr.sym))} on average` });
    this.changed(auto);
    return tr;
  }
  private reduceTrade(tr: Trade, qn: number, px: number, reason: string, auto: boolean) {
    const q = this.quote(tr.sym); px = q.round(px);
    const share = tr.comm * qn / tr.qty, c2 = this.commOf(tr.sym, qn), gross = (px - tr.entry) * tr.side * qn * q.pv, net = gross - share - c2;
    this.balance += gross - c2;
    tr.qty -= qn; tr.comm -= share;
    const closed: Closed = { ...tr, qty: qn, comm: share + c2, exit: px, exitTime: q.time, gross, net, reason, balanceAfter: this.balance };
    this.hist.push(closed);
    if (this.onFill) this.onFill({ sym: tr.sym, side: (-tr.side) as Side, qty: qn, price: px, kind: 'exit', reason, id: tr.id, pnl: net, time: q.time });
    this.marks.push({ sym: tr.sym, t: q.barTime, side: (-tr.side) as Side, kind: 'out', id: tr.id, reason });
    this.trackDD();
    this.onEvent({ kind: 'exit', sym: tr.sym, up: net >= 0, closed, text: `${reason}: closed ${fmtQty(qn)} of ${tr.sym} at ${px.toFixed(this.prec(tr.sym))}, ${smoney(net)}` });
    this.changed(auto);
  }
  closeTrade(tr: Trade, px: number, reason: string, auto: boolean) {
    const q = this.quote(tr.sym); px = q.round(px);
    const c2 = this.commOf(tr.sym, tr.qty), gross = (px - tr.entry) * tr.side * tr.qty * q.pv;
    this.balance += gross - c2;
    this.trades.splice(this.trades.indexOf(tr), 1);
    const net = gross - tr.comm - c2;
    const closed: Closed = { ...tr, exit: px, exitTime: q.time, gross, comm: tr.comm + c2, net, reason, balanceAfter: this.balance };
    this.hist.push(closed);
    if (this.onFill) this.onFill({ sym: tr.sym, side: (-tr.side) as Side, qty: tr.qty, price: px, kind: 'exit', reason, id: tr.id, pnl: net, time: q.time });
    this.marks.push({ sym: tr.sym, t: q.barTime, side: (-tr.side) as Side, kind: 'out', id: tr.id, reason });
    this.trackDD();
    this.onEvent({ kind: 'exit', sym: tr.sym, up: net >= 0, closed, text: `${reason}: ${tr.sym} ${tr.side > 0 ? 'long' : 'short'} closed at ${px.toFixed(this.prec(tr.sym))}, ${smoney(net)}` });
    this.changed(auto);
  }
  private prec(sym: string) { const r = this.quote(sym).round(1 / 3); return Math.max(0, (String(r).split('.')[1] || '').length); }

  /** a tick on one market: working orders fill, stops and targets close trades */
  onTick(sym: string, from: number, to: number, jump: boolean) {
    for (const tr of this.trades) if (tr.sym === sym) {
      const lo = Math.min(from, to), hi = Math.max(from, to);
      if (tr.side > 0) { if (hi > tr.best) tr.best = hi; if (lo < tr.worst) tr.worst = lo; }
      else { if (lo < tr.best) tr.best = lo; if (hi > tr.worst) tr.worst = hi; }
    }
    if (!this.orders.length && !this.trades.length) return;
    const qt = this.quote(sym), sp = qt.spread, sl_ = qt.slip;
    const bLo = Math.min(from, to), bHi = Math.max(from, to), aLo = bLo + sp, aHi = bHi + sp, bTo = to, aTo = to + sp;
    for (const o of this.orders.slice()) {
      if (o.sym !== sym) continue;
      let fill: number | null = null;
      if (o.side > 0) {
        if (o.type === 'limit') { if (jump ? aTo <= o.price : aLo <= o.price) fill = jump ? aTo : o.price; }
        else if (jump ? aTo >= o.price : aHi >= o.price) fill = (jump ? aTo : o.price) + sl_;
      } else {
        if (o.type === 'limit') { if (jump ? bTo >= o.price : bHi >= o.price) fill = jump ? bTo : o.price; }
        else if (jump ? bTo <= o.price : bLo <= o.price) fill = (jump ? bTo : o.price) - sl_;
      }
      if (fill != null) { this.orders.splice(this.orders.indexOf(o), 1); this.openTrade(sym, o.side, o.qty, fill, o.sl, o.tp, this.fillHow(o.type), true, o.id); }
    }
    for (const tr of this.trades.slice()) {
      if (tr.sym !== sym) continue;
      if (tr.side > 0) {
        if (tr.sl != null && (jump ? bTo <= tr.sl : bLo <= tr.sl)) this.closeTrade(tr, (jump ? bTo : tr.sl) - sl_, 'Stop loss', true);
        else if (tr.tp != null && (jump ? bTo >= tr.tp : bHi >= tr.tp)) this.closeTrade(tr, jump ? bTo : tr.tp, 'Take profit', true);
      } else {
        if (tr.sl != null && (jump ? aTo >= tr.sl : aHi >= tr.sl)) this.closeTrade(tr, (jump ? aTo : tr.sl) + sl_, 'Stop loss', true);
        else if (tr.tp != null && (jump ? aTo <= tr.tp : aLo <= tr.tp)) this.closeTrade(tr, jump ? aTo : tr.tp, 'Take profit', true);
      }
    }
  }

  private fillHow(type: 'limit' | 'stop') { return this.wording === 'classic' ? (type === 'limit' ? 'Limit fill' : 'Stop fill') : (type === 'limit' ? 'Limit order' : 'Stop order'); }
  /** true when a tick from `from` to `to` would fill a working order or hit a stop or target on this market (the
   * same tests as onTick, changing nothing): backtests batch the ticks before it */
  wouldFill(sym: string, from: number, to: number, jump: boolean): boolean {
    if (!this.orders.length && !this.trades.length) return false;
    const qt = this.quote(sym), sp = qt.spread;
    const bLo = Math.min(from, to), bHi = Math.max(from, to), aLo = bLo + sp, aHi = bHi + sp, bTo = to, aTo = to + sp;
    for (const o of this.orders) {
      if (o.sym !== sym) continue;
      if (o.side > 0 ? (o.type === 'limit' ? (jump ? aTo : aLo) <= o.price : (jump ? aTo : aHi) >= o.price)
        : (o.type === 'limit' ? (jump ? bTo : bHi) >= o.price : (jump ? bTo : bLo) <= o.price)) return true;
    }
    for (const tr of this.trades) {
      if (tr.sym !== sym) continue;
      if (tr.side > 0 ? (tr.sl != null && (jump ? bTo : bLo) <= tr.sl) || (tr.tp != null && (jump ? bTo : bHi) >= tr.tp)
        : (tr.sl != null && (jump ? aTo : aHi) >= tr.sl) || (tr.tp != null && (jump ? aTo : aLo) <= tr.tp)) return true;
    }
    return false;
  }
  /** why an order can't be placed, in plain words, or null */
  check(sym: string, side: Side, type: 'market' | 'limit' | 'stop', price: number, sl: number | null, tp: number | null): string | null {
    const b = this.bid(sym), a = this.ask(sym);
    if (b == null || a == null) return 'Press play or step forward first, so the market has a price.';
    if (this.wording === 'classic') return this.checkClassic(sym, side, type, price, sl, tp, b, a);
    const ref = side > 0 ? a : b;
    if (type === 'limit' && (side > 0 ? price >= ref : price <= ref)) return side > 0 ? `A buy limit waits below the price (${ref}). To buy above it, use a stop order.` : `A sell limit waits above the price (${ref}). To sell below it, use a stop order.`;
    if (type === 'stop' && (side > 0 ? price <= ref : price >= ref)) return side > 0 ? `A buy stop goes above the price (${ref}). To buy below it, use a limit order.` : `A sell stop goes below the price (${ref}). To sell above it, use a limit order.`;
    const entry = type === 'market' ? ref : price;
    if (sl != null && (side > 0 ? sl >= entry : sl <= entry)) return side > 0 ? 'When buying, the stop loss goes below the entry.' : 'When selling, the stop loss goes above the entry.';
    if (tp != null && (side > 0 ? tp <= entry : tp >= entry)) return side > 0 ? 'When buying, the take profit goes above the entry.' : 'When selling, the take profit goes below the entry.';
    return null;
  }
  // the classic app's wording (orderErr, then bracketErr for market orders), which strategies and their tests expect
  private checkClassic(sym: string, side: Side, type: 'market' | 'limit' | 'stop', price: number, sl: number | null, tp: number | null, b: number, a: number): string | null {
    const ref = side > 0 ? a : b, nm = side > 0 ? 'ask' : 'bid', S = side > 0 ? 'buy' : 'sell', fp = (x: number) => x.toFixed(this.prec(sym));
    if (type === 'market') price = ref;
    if (type === 'limit' && (side > 0 ? price >= ref : price <= ref)) return `A ${S} limit must be ${side > 0 ? 'below' : 'above'} the ${nm} (${fp(ref)}). Use a stop order to ${S} ${side > 0 ? 'above' : 'below'} it.`;
    if (type === 'stop' && (side > 0 ? price <= ref : price >= ref)) return `A ${S} stop must be ${side > 0 ? 'above' : 'below'} the ${nm} (${fp(ref)}). Use a limit order to ${S} ${side > 0 ? 'below' : 'above'} it.`;
    if (sl != null && (side > 0 ? sl >= price : sl <= price)) return `The stop loss must be ${side > 0 ? 'below' : 'above'} the order price.`;
    if (tp != null && (side > 0 ? tp <= price : tp >= price)) return `The take profit must be ${side > 0 ? 'above' : 'below'} the order price.`;
    if (type !== 'market') return null;
    if (side > 0) {
      if (sl != null && sl >= b) return `A buy's stop loss must be below the bid (${fp(b)}).`;
      if (tp != null && tp <= b) return `A buy's take profit must be above the bid (${fp(b)}).`;
    } else {
      if (sl != null && sl <= a) return `A sell's stop loss must be above the ask (${fp(a)}).`;
      if (tp != null && tp >= a) return `A sell's take profit must be below the ask (${fp(a)}).`;
    }
    return null;
  }
  /** places an order; returns an error in plain words, or null */
  submit(sym: string, side: Side, type: 'market' | 'limit' | 'stop', price: number, sl: number | null, tp: number | null, qty: number): string | null {
    if (!(qty > 0)) return 'The size must be more than zero.';
    const err = this.check(sym, side, type, price, sl, tp);
    if (err) { this.onEvent({ kind: 'error', text: err }); return err; }
    const qt = this.quote(sym);
    if (type === 'market') {
      const px = side > 0 ? this.ask(sym)! + qt.slip : this.bid(sym)! - qt.slip;
      this.openTrade(sym, side, qty, px, sl, tp, 'Market', false);
    } else {
      const o: Order = { id: this.nextId++, sym, side, type, price: qt.round(price), qty, sl, tp, time: qt.time };
      this.orders.push(o);
      this.onEvent({ kind: 'placed', sym, text: `Placed a ${side > 0 ? 'buy' : 'sell'} ${type} for ${fmtQty(qty)} ${sym} at ${o.price}` });
      this.changed(false);
    }
    return null;
  }
  closeMarket(tr: Trade, reason = 'Closed by you') {
    const qt = this.quote(tr.sym);
    this.closeTrade(tr, tr.side > 0 ? this.bid(tr.sym)! - qt.slip : this.ask(tr.sym)! + qt.slip, reason, false);
  }
  closeAll(sym?: string, reason?: string) { for (const tr of this.trades.slice()) if (!sym || tr.sym === sym) this.closeMarket(tr, reason); }
  cancel(id: number) {
    const o = this.orders.find(x => x.id === id); if (!o) return;
    this.orders.splice(this.orders.indexOf(o), 1);
    this.onEvent({ kind: 'cancelled', sym: o.sym, text: `Cancelled the ${o.side > 0 ? 'buy' : 'sell'} ${o.type} at ${o.price}` });
    this.changed(false);
  }
  cancelAll(sym?: string) { const n = this.orders.length; this.orders = this.orders.filter(o => sym && o.sym !== sym); if (n !== this.orders.length) { this.onEvent({ kind: 'cancelled', text: 'Cancelled the working orders' }); this.changed(false); } }
  /** moves a trade's stop or target, or an order's price; returns an error in plain words, or null */
  setBracket(tr: Trade, which: 'sl' | 'tp', price: number | null): string | null {
    const b = this.bid(tr.sym)!, a = this.ask(tr.sym)!;
    if (price != null) {
      price = this.quote(tr.sym).round(price);
      const ref = tr.side > 0 ? b : a;
      if (which === 'sl' && (tr.side > 0 ? price >= ref : price <= ref)) return 'That stop is past the current price, so it would close the trade now. Close it instead, or move the stop further away.';
      if (which === 'tp' && (tr.side > 0 ? price <= ref : price >= ref)) return 'That target is past the current price. Close the trade instead, or move the target further away.';
    }
    tr[which] = price;
    this.version++;
    return null;
  }
  breakeven(tr: Trade): string | null { return this.setBracket(tr, 'sl', tr.entry); }
  moveOrder(o: Order, price: number) { o.price = this.quote(o.sym).round(price); this.version++; }

  state(): AccountState {
    return JSON.parse(JSON.stringify({ balance: this.balance, start: this.start, orders: this.orders, trades: this.trades, hist: this.hist, marks: this.marks, nextId: this.nextId, peak: this.peak, maxDD: this.maxDD, maxDDpct: this.maxDDpct }));
  }
  load(s: AccountState) { this.maxDDpct = 0; Object.assign(this, JSON.parse(JSON.stringify(s))); this.version++; }
}
