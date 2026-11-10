// A market's bars, as columns. Times are UTC seconds of each bar's open; `base` is the bar length in seconds.

export interface Instrument {
  sym: string;          // short code shown in badges, e.g. "NQ"
  name: string;         // e.g. "Practice Nasdaq-100"
  tick: number;         // smallest price step
  pv: number;           // dollars per 1.0 of price per contract
  prec: number;         // decimals shown
  comm: number;         // commission per contract per side, dollars
  spreadTicks: number;  // the spread buys pay, in ticks
  slipTicks: number;    // slippage on stop fills, in ticks
}

export interface Series {
  id: string;
  inst: Instrument;
  n: number;
  t: Float64Array;
  o: ArrayLike<number>;
  h: ArrayLike<number>;
  l: ArrayLike<number>;
  c: ArrayLike<number>;
  v: ArrayLike<number>;
  base: number;
  hasVol: boolean;
  synthetic: boolean;
}

export interface Candle { time: number; o: number; h: number; l: number; c: number; v: number }

/** growable columns for generated bars */
export function barColumns(cap: number) {
  const B = {
    n: 0, t: new Float64Array(cap), o: new Float32Array(cap), h: new Float32Array(cap), l: new Float32Array(cap), c: new Float32Array(cap), v: new Float32Array(cap),
    push(t: number, o: number, h: number, l: number, c: number, v: number) {
      if (B.n === B.t.length) {
        const grow = <A extends Float32Array | Float64Array>(a: A): A => { const b = new (a.constructor as any)(Math.ceil(B.n * 1.5) + 16); b.set(a); return b; };
        B.t = grow(B.t); B.o = grow(B.o); B.h = grow(B.h); B.l = grow(B.l); B.c = grow(B.c); B.v = grow(B.v);
      }
      const j = B.n++; B.t[j] = t; B.o[j] = o; B.h[j] = h; B.l[j] = l; B.c[j] = c; B.v[j] = v;
    },
  };
  return B;
}
export type Bars = ReturnType<typeof barColumns>;
