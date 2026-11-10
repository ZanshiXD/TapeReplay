// The numbers a set of closed trades adds up to, as the classic Performance tab shows them.
import type { Closed } from './account';

export interface Stats {
  trades: number; net: number; winRate: number | null; profitFactor: number | null; avgWin: number | null; avgLoss: number | null;
  expectancy: number | null; largestWin: number | null; largestLoss: number | null; maxLosingStreak: number; longs: number; shorts: number;
  avgHold: number | null; costs: number; maxDD: number; maxDDpct: number; ret: number;
  /** equity after each closed trade, from the start */
  curve: Array<{ t: number; v: number }>;
}
export function computeStats(hist: Closed[], start: number): Stats {
  const n = hist.length, w = hist.filter(x => x.net > 0), lo = hist.filter(x => x.net <= 0);
  const gw = w.reduce((s, x) => s + x.net, 0), gl = -lo.reduce((s, x) => s + x.net, 0), net = gw - gl;
  let streak = 0, maxL = 0, eq = start, peak = start, dd = 0, ddp = 0;
  const curve = [{ t: hist[0]?.time ?? 0, v: start }];
  for (const x of hist) {
    streak = x.net <= 0 ? streak + 1 : 0; maxL = Math.max(maxL, streak);
    eq += x.net; curve.push({ t: x.exitTime, v: eq });
    if (eq > peak) peak = eq;
    if (peak - eq > dd) { dd = peak - eq; ddp = peak > 0 ? dd / peak * 100 : 0; }
  }
  return {
    trades: n, net, winRate: n ? w.length / n : null, profitFactor: gl > 0 ? gw / gl : gw > 0 ? Infinity : null,
    avgWin: w.length ? gw / w.length : null, avgLoss: lo.length ? -gl / lo.length : null, expectancy: n ? net / n : null,
    largestWin: w.length ? Math.max(...w.map(x => x.net)) : null, largestLoss: lo.length ? Math.min(...lo.map(x => x.net)) : null,
    maxLosingStreak: maxL, longs: hist.filter(x => x.side > 0).length, shorts: hist.filter(x => x.side < 0).length,
    avgHold: n ? hist.reduce((s, x) => s + (x.exitTime - x.time), 0) / n : null, costs: hist.reduce((s, x) => s + (x.gross - x.net), 0),
    maxDD: dd, maxDDpct: ddp, ret: start ? net / start * 100 : 0, curve,
  };
}
/** the trades as CSV, with the classic columns */
export function tradesCsv(hist: Closed[], prec: (sym: string) => number) {
  const iso = (t: number) => new Date(t * 1000).toISOString().replace('.000Z', 'Z');
  const rows = hist.map((h, k) => { const n = prec(h.sym); return [k + 1, h.side > 0 ? 'long' : 'short', h.qty, iso(h.time), h.entry.toFixed(n), iso(h.exitTime), h.exit.toFixed(n), JSON.stringify(h.reason || ''), h.sl0 != null ? h.sl0.toFixed(n) : '', h.tp != null ? h.tp.toFixed(n) : '', h.gross.toFixed(2), (h.gross - h.net).toFixed(2), h.net.toFixed(2), h.sym].join(','); });
  return ['id,side,size,entry_time,entry,exit_time,exit,exit_by,stop_loss,take_profit,gross,costs,net,market', ...rows].join('\n');
}
