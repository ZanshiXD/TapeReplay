// The journal: when a trade closes, a snapshot of its chart (and of the other markets open at the time) and its
// numbers are saved with it, so it can be reviewed later without replaying.
import type { Closed } from './account';
import type { Feed } from './feed';
import { tfLabel, tradingDay } from './time';

export interface JournalSnap {
  sym: string; name: string; tf: string; prec: number;
  /** candles as [time, open, high, low, close], oldest first */
  candles: number[][];
}
export interface JournalEntry {
  id: string; tradeId: number; sym: string; side: 1 | -1; qty: number;
  entry: number; exit: number; time: number; exitTime: number; sl: number | null; tp: number | null;
  net: number; gross: number; comm: number; reason: string; balanceAfter: number;
  /** what the trade risked at its first stop, in dollars, and its result in units of that risk */
  risk: number | null; r: number | null;
  /** the furthest it went for and against you, in dollars */
  mfe: number; mae: number;
  heldSec: number; bars: number; dayNo: number;
  snaps: JournalSnap[];
  tags: string[]; rating: '' | 'plan' | 'broke' | 'unsure'; notes: string;
}

/** the snapshot of one market around a trade: some candles before the entry, through the exit */
function snapOf(f: Feed, t0: number, t1: number): JournalSnap {
  const all = f.F ? [...f.candles, f.F] : f.candles;
  let a = all.findIndex(c => c.time >= f.bucket(t0)); if (a < 0) a = all.length - 1;
  let b = all.length; for (let j = all.length - 1; j >= 0; j--) if (all[j].time <= t1) { b = j + 1; break; }
  // some context before the entry, and at least 40 candles in all
  const to = Math.min(all.length, b), from = Math.max(0, Math.min(a - 30, to - 40));
  return { sym: f.s.inst.sym, name: f.s.inst.name, tf: tfLabel(f.tf), prec: f.s.inst.prec, candles: all.slice(from, to).map(c => [c.time, c.o, c.h, c.l, c.c]) };
}

export function journalEntry(x: Closed, feeds: Feed[], hist: Closed[]): JournalEntry {
  const f = feeds.find(y => y.s.inst.sym === x.sym)!, pv = f.s.inst.pv;
  const risk = x.sl0 != null ? Math.abs(x.entry - x.sl0) * x.qty * pv : null;
  const mfe = (x.best - x.entry) * x.side * x.qty * pv, mae = (x.worst - x.entry) * x.side * x.qty * pv;
  const day = tradingDay(x.exitTime), dayNo = hist.filter(h => tradingDay(h.exitTime) === day).length;
  const tfs = f.tf.kind === 's' ? f.tf.sec : 86400;
  return {
    id: `${x.id}-${Math.round(x.exitTime)}`, tradeId: x.id, sym: x.sym, side: x.side, qty: x.qty, entry: x.entry, exit: x.exit, time: x.time, exitTime: x.exitTime,
    sl: x.sl0, tp: x.tp, net: x.net, gross: x.gross, comm: x.comm, reason: x.reason, balanceAfter: x.balanceAfter,
    risk, r: risk ? x.net / risk : null, mfe: Math.max(0, mfe), mae: Math.min(0, mae),
    heldSec: x.exitTime - x.time, bars: Math.max(1, Math.round((x.exitTime - x.time) / tfs)), dayNo,
    // the traded market first, then the others at the same moment
    snaps: [f, ...feeds.filter(y => y !== f)].map(y => snapOf(y, x.time, x.exitTime)),
    tags: [], rating: '', notes: '',
  };
}
