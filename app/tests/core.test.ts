// The new core (src/core): practice data, replay on two markets, orders, the journal, stepping back and jumping.
//   npx tsx tests/core.test.ts
import { practiceSeries } from '../src/core/practice';
import { Session } from '../src/core/session';
import { parseTF } from '../src/core/time';

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
console.log(`core: ${passed} checks passed`);
