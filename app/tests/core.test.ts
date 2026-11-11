// The new core (src/core): practice data, replay on two markets, orders, the journal, stepping back and jumping.
//   npx tsx tests/core.test.ts
import { practiceSeries } from '../src/core/practice';
import { Session } from '../src/core/session';
import { parseTF } from '../src/core/time';
import { barColumns } from '../src/core/series';
import { DrawStore, anchoredVwap, fibExtPrice, fibPrice, makeStyle, positionOutcome, regression, volumeProfile } from '../src/core/drawings';

let passed = 0;
const check = (c: unknown, m: string) => { if (!c) throw new Error('FAILED: ' + m); passed++; };

const t0 = Date.UTC(2026, 3, 1, 4) / 1000, t1 = Date.UTC(2026, 3, 4) / 1000;
const t = performance.now();
const [nq, es] = await practiceSeries(['NQ', 'ES'], t0, t1);
console.log(`generated ${nq.n} + ${es.n} bars in ${((performance.now() - t) / 1000).toFixed(2)} s`);
check(nq.n > 50000 && es.n === nq.n, 'two markets with bars');
// the two move together: correlation of 5-minute returns
const r = (s: typeof nq) => { const out: number[] = []; let last = s.c[0], next = s.t[0] + 300; for (let j = 0; j < s.n; j++) if (s.t[j] >= next) { out.push(Math.log(s.c[j] / last)); last = s.c[j]; next = s.t[j] + 300; } return out; };
const a = r(nq), b = r(es), n = Math.min(a.length, b.length);
const ma = a.slice(0, n).reduce((x, y) => x + y) / n, mb = b.slice(0, n).reduce((x, y) => x + y) / n;
let sab = 0, saa = 0, sbb = 0; for (let j = 0; j < n; j++) { sab += (a[j] - ma) * (b[j] - mb); saa += (a[j] - ma) ** 2; sbb += (b[j] - mb) ** 2; }
const corr = sab / Math.sqrt(saa * sbb);
console.log('correlation of 5m returns', corr.toFixed(3));
check(corr > 0.8 && corr < 0.995, 'correlated but not identical');
check(es.c[0] > 1000 && es.c[0] < 9000, 'S&P-style level');

const start = Date.UTC(2026, 3, 1, 13, 30) / 1000; // 9:30 New York
const S = new Session({ name: 'test', markets: [nq, es], start, tf: parseTF('5m')!, balance: 50000 });
const f = S.feed('NQ'), g = S.feed('ES');
check(f.candles.length > 100, 'history before the start is on the chart');
const hist0 = f.candles.length;
S.advanceTo(start + 3600);
check(Math.abs(f.time - (start + 3600)) < 5 && Math.abs(g.time - (start + 3600)) < 5, 'both markets on one clock');
check(f.candles.length >= hist0 + 11, 'an hour of 5m candles');
// replayed candles match the bars they are made of
const c = f.candles[f.candles.length - 2];
let hi = -Infinity, lo = Infinity;
for (let j = 0; j < nq.n; j++) if (nq.t[j] >= c.time && nq.t[j] < c.time + 300) { hi = Math.max(hi, nq.h[j]); lo = Math.min(lo, nq.l[j]); }
check(Math.abs(c.h - hi) < 1e-6 && Math.abs(c.l - lo) < 1e-6, `candle high/low match the bars (${c.h}/${hi}, ${c.l}/${lo})`);

// a market buy with a stop and a target, on NQ
const px = S.account.ask('NQ')!;
check(S.order(1, 'market', px, px - 10, px + 10, 1) === null, 'market buy accepted');
check(S.account.trades.length === 1 && S.account.trades[0].entry === px + 0.25, 'filled at the ask plus slippage');
check(S.order(-1, 'limit', S.account.bid('ES')! - 5, null, null, 1, 'ES') !== null, 'a sell limit below the price is refused');
const errEs = S.order(-1, 'market', S.account.bid('ES')!, S.account.bid('ES')! + 5, S.account.bid('ES')! - 5, 2, 'ES');
check(errEs === null && S.account.trades.length === 2, 'short ES at the same time');
const bal0 = S.account.balance;
const snapNow = S.now;
S.advanceTo(start + 6 * 3600);
check(S.account.trades.length === 0 && S.account.hist.length === 2, 'both trades closed by stop or target');
check(S.journal.length === 2, 'two journal entries');
const j0 = S.journal[0];
check(j0.snaps.length === 2 && j0.snaps[0].candles.length >= 20, 'journal entry has a snapshot of both markets');
check(j0.risk != null && j0.r != null && Math.abs(Math.abs(j0.r!) - Math.abs(j0.net / j0.risk!)) < 1e-9, 'result in units of risk');
console.log('journal:', S.journal.map(e => `${e.sym} ${e.side > 0 ? 'long' : 'short'} ${e.reason} ${e.net.toFixed(2)} (${e.r!.toFixed(2)} R, best ${e.mfe.toFixed(0)}, worst ${e.mae.toFixed(0)})`).join(' | '));
check(S.account.balance !== bal0, 'balance changed');

// stepping back undoes the candle (and trades closed in it)
const before = f.candles.length, tNow = f.time;
S.stepBack();
check(f.time < tNow && f.candles.length <= before, 'step back moves the clock back');
// jump back before the trades: they are gone, the account is as it was
await S.jumpTo(snapNow - 60);
check(S.account.hist.length === 0 && S.journal.length === 0, 'jumping back before the trades undoes them');
// jump forward a day, quickly
const tj = performance.now();
await S.jumpTo(start + 86400);
console.log(`jumped a day in ${((performance.now() - tj) / 1000).toFixed(2)} s`);
check(Math.abs(f.time - (start + 86400)) < 600 || f.done, 'jumped forward a day');
// playing at speed: frames
S.play(); let frames = 0; const tp = performance.now();
while (frames < 600) { S.frame(1 / 60); frames++; }
const ms = (performance.now() - tp) / frames;
console.log(`frame cost at 60x: ${ms.toFixed(3)} ms`);
check(ms < 4, 'a frame of playback is cheap');
S.speed = 1000; const tp2 = performance.now(); for (let k = 0; k < 120; k++) S.frame(1 / 60);
console.log(`frame cost at 1000x: ${((performance.now() - tp2) / 120).toFixed(3)} ms`);

/* ---- smooth playback: 1-minute bars with gaps, at 1x and at a speed the computer can't keep up with ---- */
{
  const B = barColumns(4000), m0 = Date.UTC(2026, 3, 1, 13, 30) / 1000;
  let p = 6500;
  for (let j = 0; j < 3000; j++) {
    if (j % 37 === 5 || (j > 400 && j < 412)) continue; // missing minutes, and a quiet stretch
    const o = p; p = Math.round((p + Math.sin(j / 7) * 1.5 + Math.cos(j / 3.1)) * 4) / 4;
    B.push(m0 + j * 60, o, Math.max(o, p) + 0.75, Math.min(o, p) - 0.5, p, 100 + j % 40);
  }
  const ES = { sym: 'ES', name: 'E-mini S&P 500', tick: 0.25, pv: 50, prec: 2, comm: 2, spreadTicks: 1, slipTicks: 1 };
  const one = { id: 'es1m', inst: ES, n: B.n, t: B.t.slice(0, B.n), o: B.o, h: B.h, l: B.l, c: B.c, v: B.v, base: 60, hasVol: true, synthetic: false };
  const Q = new Session({ name: 'smooth', markets: [one], start: m0 + 60 * 30, tf: parseTF('1m')!, balance: 50000 });
  const q = Q.feed('ES');
  Q.speed = 1; Q.play();
  // 3 minutes at 1x, 60 frames a second: the price moves several times a second, inside each bar's range
  let moves = 0, last = q.price, wait = 0, longest = 0, back = 0, prevNow = Q.now, outside = 0;
  for (let k = 0; k < 180 * 60; k++) {
    Q.frame(1 / 60);
    if (Q.now < prevNow - 1e-9) back++;
    prevNow = Q.now;
    if (q.price !== last) { moves++; longest = Math.max(longest, wait); wait = 0; last = q.price; } else wait++;
    const P = q.P, j = q.i;
    if (P && j < one.n && (P.h > one.h[j] + 1e-6 || P.l < one.l[j] - 1e-6)) outside++;
    if (q.k === 0 && j < one.n && q.i > 0 && one.t[j] - one.t[j - 1] > 60) wait = 0; // a minute missing from the data: nothing to play
  }
  check(outside === 0, 'the extra ticks stay inside the bar');
  console.log(`1x on 1-minute bars: ${(moves / 180).toFixed(1)} moves a second, longest still ${(longest / 60).toFixed(2)} s`);
  check(moves / 180 >= 2, 'at 1x the price moves a few times a second');
  check(longest / 60 < 1.2, 'and never stands still for long inside a bar');
  check(back === 0, 'the clock never goes back');
  // a minute at 10x (still more ticks than set, with the jitter)
  Q.speed = 10; for (let k = 0; k < 60 * 60; k++) Q.frame(1 / 60);
  // the candles are the data's: open, high, low, close and volume unchanged by the extra ticks
  const done = q.candles.filter(c => c.time >= m0 + 60 * 30);
  const at = (t: number) => { let a = 0, b = one.n - 1; while (a < b) { const m = (a + b) >> 1; if (one.t[m] < t) a = m + 1; else b = m; } return a; };
  check(done.length >= 10 && done.every(c => { const j = at(c.time); return one.t[j] === c.time && c.o === one.o[j] && c.h === one.h[j] && c.l === one.l[j] && c.c === one.c[j] && Math.abs(c.v - one.v[j]) < 1e-3; }), 'candles keep the data\'s open, high, low, close and volume');
  // the countdown's clock and the ticks agree: after each frame no tick before the clock is left unplayed
  check(q.nextTickTime() > Q.now - 1e-9, 'the prices keep up with the clock at 1x');
  // more than a frame's time budget can play (here no budget at all): the clock waits at the last tick played, never
  // ahead of the prices and never back
  let ahead = 0; back = 0; prevNow = Q.now;
  for (let k = 0; k < 30; k++) {
    const target = Q.now + 3600; Q.advanceTo(target, 0);
    if (q.nextTickTime() < Q.now - 1e-6 || Q.now >= target) ahead++;
    if (Q.now < prevNow - 1e-9) back++; prevNow = Q.now;
  }
  check(ahead === 0 && back === 0, `out of time, the clock stays with the prices (${ahead} ahead, ${back} back)`);
  // speeding up takes effect at once: fewer ticks for the rest of the bar
  Q.speed = 1; Q.frame(1 / 60); const n1 = q.nt; Q.speed = 300; Q.frame(1 / 60);
  check(n1 >= 200 && q.nt < n1, `a new speed changes the ticks of the bar playing now (${n1} -> ${q.nt})`);
}

/* ---- drawings ---- */
{
  const st = new DrawStore();
  const a = st.add({ tool: 'trend', sym: 'NQ', pts: [{ t: 0, p: 1 }, { t: 60, p: 2 }], style: makeStyle({ color: '#ff0000' }) });
  st.add({ tool: 'hline', sym: 'ES', pts: [{ t: 0, p: 5 }], style: makeStyle() });
  check(st.forSym('NQ').length === 1 && st.items.length === 2, 'drawings are kept per market');
  st.update(a.id, { style: { width: 3 } });
  check(st.get(a.id)!.style.width === 3 && st.get(a.id)!.style.color === '#ff0000', 'a style change keeps the rest of the style');
  st.begin(); st.get(a.id)!.pts[1].p = 9; st.live(); st.get(a.id)!.pts[1].p = 10; st.live(); st.commit();
  st.undo();
  check(st.get(a.id)!.pts[1].p === 2, 'a drag made of many moves undoes in one step');
  st.redo();
  check(st.get(a.id)!.pts[1].p === 10, 'and redoes');
  st.begin(); st.get(a.id)!.style.text = 'x'; st.rollback();
  check(st.get(a.id)!.style.text === '', 'Cancel in the settings puts the drawing back');
  check(st.clear('NQ') === 1 && st.items.length === 1, 'remove all on one market');
  st.undo();
  check(st.items.length === 2, 'and undo brings them back');
  const c = st.clone(a.id, p => ({ t: p.t + 60, p: p.p }))!;
  check(c.id !== a.id && c.pts[0].t === 60 && st.items.length === 3, 'clone');
  st.order(c.id, -2);
  check(st.items[0].id === c.id, 'send to back');
  st.setAll(null, { locked: true });
  check(st.items.every(d => d.locked), 'lock all');
  check(fibPrice(100, 200, 0.5) === 150 && fibPrice(100, 200, 1) === 100 && fibPrice(100, 200, 0) === 200, 'fib retracement: 1 at the first point, 0 at the second');
  check(fibExtPrice(100, 150, 120, 1) === 170, 'trend-based extension projects the first move from the third point');
  const r = regression([1, 2, 3, 4, 5])!;
  check(Math.abs(r.b - 1) < 1e-9 && Math.abs(r.a - 1) < 1e-9 && r.sd < 1e-9, 'regression of a straight line');
  const vp = volumeProfile([{ o: 10, h: 12, l: 10, c: 12, v: 100 }, { o: 12, h: 12, l: 11, c: 11, v: 300 }], 4)!;
  check(vp.up.reduce((x, y) => x + y) + vp.dn.reduce((x, y) => x + y) === 400 && vp.poc >= 2, 'volume profile keeps all the volume, its point of control where most traded');
  const vw = anchoredVwap([{ h: 3, l: 1, c: 2, v: 1 }, { h: 6, l: 4, c: 5, v: 3 }]);
  check(vw[0] === 2 && Math.abs(vw[1] - (2 + 15) / 4) < 1e-9, 'anchored VWAP');
  const bars = [{ time: 0, h: 101, l: 99, c: 100 }, { time: 60, h: 103, l: 100, c: 102 }, { time: 120, h: 106, l: 101, c: 105 }];
  check(positionOutcome(1, 100, 98, 105, bars).state === 'target', 'a long reaching its target');
  check(positionOutcome(-1, 100, 102, 95, bars).state === 'stop', 'a short reaching its stop');
  check(positionOutcome(1, 90, 88, 95, bars).state === 'waiting', 'a long never filled');
  check(positionOutcome(1, 100, 99, 104.5, [bars[0], { time: 60, h: 105, l: 98, c: 100 }]).state === 'stop', 'stop first when one bar reaches both');
}
console.log(`core: ${passed} checks passed`);
