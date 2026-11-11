// Built-in indicators, computed one candle at a time: push() a closed candle and get its value; peek() the value the
// forming candle would give.
import type { Candle } from './series';
import { tradingDay } from './time';

export type IndType = 'ema' | 'sma' | 'vwap';
export interface IndSpec { id: string; type: IndType; len: number; color: string; on: boolean }
export interface Ind { push(b: Candle): number | null; peek(b: Candle): number | null }

export const indLabel = (x: IndSpec) => x.type === 'vwap' ? 'VWAP' : `${x.type.toUpperCase()} ${x.len}`;
export const IND_COLORS = ['#f0b54a', '#7aa2ff', '#26a69a', '#ef5350', '#c3aef7', '#26c6da'];

export function makeInd(x: IndSpec, opts: { daily: boolean; hasVol: boolean }): Ind {
  const n = Math.max(1, Math.round(x.len) || 1);
  if (x.type === 'sma') {
    const w: number[] = []; let sum = 0;
    return {
      push(b) { w.push(b.c); sum += b.c; if (w.length > n) sum -= w.shift()!; return w.length === n ? sum / n : null; },
      peek(b) { if (w.length === n) return (sum - w[0] + b.c) / n; if (w.length === n - 1) return (sum + b.c) / n; return null; },
    };
  }
  if (x.type === 'vwap') {
    // typical price weighted by volume, from the start of each trading day (6 PM New York); none on daily candles
    let d: number | null = null, pv = 0, vol = 0;
    const add = (b: Candle, p0: number, v0: number) => { const w = opts.hasVol ? b.v : 1, tp = (b.h + b.l + b.c) / 3; return [p0 + tp * w, v0 + w, tp]; };
    return {
      push(b) { if (opts.daily) return null; const k = tradingDay(b.time); if (k !== d) { d = k; pv = 0; vol = 0; } const [p, v, tp] = add(b, pv, vol); pv = p; vol = v; return v > 0 ? p / v : tp; },
      peek(b) { if (opts.daily) return null; const same = tradingDay(b.time) === d, [p, v, tp] = add(b, same ? pv : 0, same ? vol : 0); return v > 0 ? p / v : tp; },
    };
  }
  const a = 2 / (n + 1); let e: number | null = null, cnt = 0, seed = 0;
  return {
    push(b) { const c = b.c; if (e === null) { cnt++; seed += c; if (cnt === n) e = seed / n; return e; } e += a * (c - e); return e; },
    peek(b) { const c = b.c; if (e === null) return cnt === n - 1 ? (seed + c) / n : null; return e + a * (c - e); },
  };
}
