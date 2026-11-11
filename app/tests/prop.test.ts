// Prop rules (src/core/prop.ts): the prop simulation (evaluation, funded with payouts, live) and the plain prop rules,
// on an Account driven tick by tick on one made-up market.
//   npx tsx tests/prop.test.ts
import { Account, type Quote } from '../src/core/account';
import { PROP_DEF, PROP_PRESETS, PropRules, PropSim, SIM_DEF, applyPreset, dptNote, simConfig, startProp, type PropConfig, type PropEvent, type RulesConfig } from '../src/core/prop';

let passed = 0;
const check = (c: unknown, m: string) => { if (!c) throw new Error('FAILED: ' + m); passed++; };
const near = (a: number | null | undefined, b: number) => a != null && Math.abs(a - b) < 1e-6;

// day n of the test at hour h, New York time (April 2026: New York is UTC-4); trading days start at 18:00 New York
const D = (n: number, h: number, m = 0) => Date.UTC(2026, 3, 6 + n, h + 4, m) / 1000;

// one market, X: $10 a point per contract, no costs; 10 contracts make $100 a point
interface Rig<E> {
  A: Account; p: E; q: Quote; ev: PropEvent[]; t: number;
  tick(px?: number, t?: number): void; day(n: number): void; buy(qty?: number): string | null; trade(dollars: number, qty?: number): void; last(): PropEvent;
}
function rig<E extends PropSim | PropRules>(make: (A: Account) => E): Rig<E> {
  const A = new Account(50000);
  const q: Quote = { price: 1000, spread: 0, slip: 0, pv: 10, comm: 0, time: D(0, 8), barTime: D(0, 8), round: x => Math.round(x * 4) / 4 };
  A.quote = () => q;
  const p = make(A), ev: PropEvent[] = [];
  p.onEvent = e => ev.push(e);
  const h: Rig<E> = {
    A, p, q, ev, t: D(0, 8),
    /** a tick: the account, then the rules */
    tick(px = q.price!, t = h.t + 60) { h.t = t; const from = q.price!; q.price = px; q.time = q.barTime = t; A.onTick('X', from, px, false); p.onTick(t); },
    /** the first tick of day n (9:00 New York) */
    day(n: number) { h.tick(q.price!, D(n, 9)); },
    buy(qty = 10) { return A.submit('X', 1, 'market', 0, null, null, qty); },
    /** a round trip of qty contracts making `dollars`: buy, the price moves, close, one more tick */
    trade(dollars: number, qty = 10) { h.buy(qty); h.tick(q.price! + dollars / (qty * 10)); A.closeAll(); h.tick(); },
    last: () => ev[ev.length - 1],
  };
  return h;
}
const simRig = (cfg: Partial<PropConfig> = {}, opts: { resetHour?: number } = {}) => rig(A => new PropSim(simConfig({ on: true, ...cfg }), A, opts));
const rulesRig = (cfg: Partial<RulesConfig>, zone = 0) => rig(A => new PropRules({ ...PROP_DEF, on: true, ...cfg }, A, { zoneOff: () => zone }));

/* ---- settings and presets ---- */
{
  check(simConfig({ preset: 'Lucid Flex 50K' }).preset === 'L Flex 50K' && simConfig(null).ePt === 3000, 'old preset names are renamed; defaults filled in');
  const p = applyPreset({ ...SIM_DEF, fee: 100, unit: 'mini', auto: true, resetNY: 17 }, 'L Flex 25K');
  check(p.on && p.size === 25000 && p.ePt === 1250 && p.fTiers === '0:1, 1000:2' && p.fee === 100 && p.unit === 'mini' && p.auto && p.resetNY === 17 && p.preset === 'L Flex 25K', 'a preset turns the simulation on and keeps fee, unit, auto and the reset hour');
  check(PROP_PRESETS['L Flex 50K'].lBonus === 2000 && PROP_PRESETS['L Flex 25K'].fPayMax === 1000, 'both built-in presets');
  const note = dptNote({ ePt: 3000, eCons: 50, eDpt: 300 });
  check(note.includes('$300.00, positions close') && note.includes('$1,500.00 or less keeps every day inside the rule'), 'the daily profit target note');
  check(dptNote({ ePt: 3000, eCons: 50, eDpt: 2000 }).endsWith('; $2,000.00 can still leave one day too big.'), 'and its warning');
  const h = simRig({ ...PROP_PRESETS['L Flex 50K'], fee: 100 });
  check(h.A.balance === 50000 && h.A.start === 50000 && h.p.s.fees === 100 && h.p.s.attempt === 1 && h.p.label() === 'Evaluation', 'a new course: account at the size, the first fee counted');
  const h2 = simRig({ size: 25000 });
  check(h2.A.balance === 25000 && h2.A.peak === 25000, 'the account size replaces the balance');
}

/* ---- size limits ---- */
{
  const h = simRig({ eMax: 4 });
  h.day(0);
  const sim = h.p;
  check(sim.check('X', 1, 41) === 'That would make your position 41, above the evaluation limit of 40 micros.', 'micros: 10 per mini');
  check(sim.check('X', 1, 40) === null, 'up to the limit is fine');
  h.buy(30);
  check(sim.check('X', 1, 15) === 'That would make your position 45, above the evaluation limit of 40 micros.', 'adding to a position counts what is open');
  check(sim.check('X', -1, 15) === null && sim.check('X', -1, 70) === null, 'reducing or flipping within the limit is fine');
  check(sim.check('X', -1, 71) !== null, 'flipping past the limit is not');
  h.A.submit('X', -1, 'limit', h.q.price! + 10, null, null, 5);
  check(sim.openQty() === 35 && sim.check('X', 1, 6) === 'That would make your position 41, above the evaluation limit of 40 micros.', 'working orders count too, any side');
  check(sim.view().rows.some(r => r.label === 'Position size' && r.value === '35 of 40 micros'), 'the card shows the size');
  const m = simRig({ unit: 'mini', eMax: 4 });
  m.day(0);
  check(m.p.check('X', 1, 5) === 'That would make your position 5, above the evaluation limit of 4 minis.', 'minis');
  const n = simRig({ eMax: 0 });
  n.day(0);
  check(n.p.check('X', 1, 1000) === null, 'no limit');
}

/* ---- the trading day ---- */
{
  const h = simRig();
  h.tick(1000, D(0, 17, 59));
  const d0 = h.p.s.day!;
  h.tick(1000, D(0, 18));
  check(h.p.s.day === d0 + 1, 'the trading day rolls at 18:00 New York');
  h.tick(1000, D(0, 23, 59));
  check(h.p.s.day === d0 + 1, 'and not at midnight');
  const m = simRig({}, { resetHour: 0 });
  m.tick(1000, D(0, 23, 59)); const e0 = m.p.s.day!;
  m.tick(1000, D(1, 0));
  check(m.p.s.day === e0 + 1, 'another reset hour: midnight');
  const z = simRig({ resetNY: 9 });
  z.tick(1000, D(0, 8, 59)); const z0 = z.p.s.day!; z.tick(1000, D(0, 9));
  check(z.p.s.day === z0 + 1, 'the hour comes from the settings');
}

/* ---- daily loss limit: flatten and lock for the day ---- */
{
  const h = simRig({ dll: 500 });
  h.day(0); h.buy(10);
  h.tick(h.q.price! - 4);
  check(h.A.trades.length === 1 && !h.p.s.lockedDay, 'down $400: still trading');
  h.tick(h.q.price! - 2);
  check(h.A.trades.length === 0 && h.A.hist[h.A.hist.length - 1].reason === 'Daily loss limit', 'down $600: positions closed');
  check(h.p.s.lockedDay === 'daily loss limit, down $600.00' && !h.p.s.over, 'locked for the day, not failed');
  const e = h.last();
  check(e.kind === 'lock' && e.up === false && e.pause && e.text === 'Daily loss limit hit. Positions closed and trading locked until the next trading day.', 'the lock message pauses');
  check(h.p.check('X', 1, 1) === 'Trading is locked until the next trading day: daily loss limit, down $600.00.', 'orders refused while locked');
  check(h.p.view().status === 'Locked today' && h.p.view().statusKind === 'warn', 'card status');
  check(h.p.view().rows.some(r => r.label === 'Daily loss' && r.state === 'bad'), 'daily loss row');
  check(!h.p.s.log.some(l => /Daily loss/.test(l.text)), 'the daily loss limit is not logged');
  h.day(1);
  check(h.p.s.lockedDay === '' && h.p.check('X', 1, 1) === null, 'unlocked the next trading day');
}

/* ---- max loss breach, a new evaluation, re-buys ---- */
{
  const h = simRig({ fee: 100, eMll: 2000 });
  h.day(0); h.buy(10);
  h.tick(h.q.price! - 19);
  check(!h.p.s.over, 'above the floor');
  h.tick(h.q.price! - 1);
  const e = h.last();
  check(h.p.s.over === 'Max loss: equity fell to $48,000.00, at or below the floor of $48,000.00.', 'breach at the floor');
  check(e.kind === 'breach' && e.pause && e.up === false && e.text === 'Evaluation account failed. Max loss: equity fell to $48,000.00, at or below the floor of $48,000.00.', 'breach message');
  check(h.A.trades.length === 0 && h.A.hist[h.A.hist.length - 1].reason === 'Rule breach' && h.p.s.nFail.eval === 1, 'flattened, counted');
  check(h.p.check('X', 1, 1) === 'This evaluation account has failed. Start a new evaluation from the Prop simulation card.', 'no orders on a failed account');
  check(h.p.label() === 'Evaluation failed' && h.p.view().status === 'Failed', 'label');
  const act = h.p.view().action!;
  check(act.kind === 'restart' && act.label === 'Start a new evaluation ($100.00)', 'the card offers a new evaluation');
  const nh = h.A.hist.length;
  h.p.restart();
  check(h.p.s.attempt === 2 && h.p.s.fees === 200 && h.A.balance === 50000 && h.A.start === 50000 && !h.p.s.over && h.A.hist.length === nh, 'a new evaluation: fee counted, fresh balance, history kept');
  check(h.p.s.log[h.p.s.log.length - 1].text === 'Evaluation attempt 2 started, fee $100.00.', 'logged');
  check(h.p.rebuy(true, 3) === null, 'no re-buy while alive');
  const lose = () => { h.buy(10); h.tick(h.q.price! - 25); };
  lose();
  const r1 = h.p.rebuy(true, 3)!;
  check(r1.restarted && r1.text === 'New evaluation, attempt 3 ($100.00).' && h.p.s.attempt === 3, 're-buy');
  lose();
  const r2 = h.p.rebuy(true, 3)!;
  check(!r2.restarted && r2.text === 'Reached 3 evaluations, so the run ends here.' && h.p.s.attempt === 3, 're-buys stop at the limit');
  check(h.p.rebuy(false)!.text === 'The account failed, so the run ends here. Tick "buy a new evaluation" to keep going.', 'no re-buy');
  const st = h.p.stats();
  check(st.attempts === 3 && st.failEval === 3 && st.fees === 300 && st.passed === 0 && st.nPay === 0 && st.take === -300, 'stats');
  check(h.p.summaryLine() === 'Prop simulation: 3 evaluations (0 passed, 0 went live), $300.00 in fees, 0 payouts, $0.00 paid out to you: −$300.00. Account now: Evaluation failed.', 'end-of-run line');
  // each account on its own: three evaluations, each failed, holding its own trades
  const ac = h.p.accounts();
  check(ac.length === 3 && ac.every((x, i) => x.stage === 'eval' && x.attempt === i + 1 && x.end === 'failed' && x.why.startsWith('Max loss')), 'three failed evaluations, in order');
  check(ac[0].h0 === 0 && ac[0].h1 === ac[1].h0 && ac[1].h1 === ac[2].h0 && ac[2].h1 === h.A.hist.length, 'their trades follow on from each other');
  check(ac[1].h1! - ac[1].h0 >= 1 && h.A.hist[ac[1].h1! - 1].reason === 'Rule breach', 'an account ends with the trade its breach closed');
}

/* ---- the max loss trails the end-of-day high and locks at start + lockPad ---- */
{
  const h = simRig({ ePt: 100000, eCons: 0, eMll: 2000, lockPad: 100 });
  h.day(0); h.trade(1500);
  check(near(h.p.floor(), 48000), 'the floor moves only at the day end');
  h.day(1);
  check(near(h.p.s.eodPeak, 51500) && near(h.p.floor(), 49500) && !h.p.s.locked, 'trails the end-of-day high');
  h.buy(10); h.tick(h.q.price! + 20); h.tick(h.q.price! - 20); h.A.closeAll(); h.tick();
  check(near(h.p.floor(), 49500), 'an intraday high does not move it');
  h.trade(700);
  h.day(2);
  check(h.p.s.locked && near(h.p.floor(), 50100), 'locks at start + lockPad once the end-of-day high is that far above the max loss');
  check(h.ev.some(e => e.kind === 'info' && e.text === 'Max loss locked at $50,100.00.'), 'lock logged');
  check(h.p.view().rows.some(r => r.label === 'Max loss (EOD trailing, locked)' && r.value === 'floor $50,100.00 · $2,100.00 left'), 'max loss row');
  h.day(3); h.trade(3000); h.day(4);
  check(near(h.p.floor(), 50100), 'and stays there');
  h.buy(10); h.tick(h.q.price! - 51);
  check(h.p.s.over === 'Max loss: equity fell to $50,100.00, at or below the floor of $50,100.00.', 'breach at the locked floor');
}

/* ---- passing: the profit target and consistency ---- */
{
  const h = simRig({ ePt: 3000, eCons: 50 });
  h.day(0); h.trade(3000);
  const v = h.p.view();
  check(h.p.s.stage === 'eval' && v.ptOk && !v.consOk && near(v.consPct, 100), 'target reached in one day: consistency blocks the pass');
  check(v.rows.some(r => r.label === 'Consistency' && r.value === 'best day 100.0% · max 50%' && r.state === 'bad'), 'consistency row');
  check(v.rows.some(r => r.label === 'Profit target' && r.value === '+$3,000.00 of $3,000.00' && r.state === 'ok' && r.frac === 1), 'target row');
  h.day(1); h.trade(2000);
  check(h.p.s.stage === 'eval' && near(h.p.progress().consPct, 60), 'still too much in one day');
  h.trade(1000);
  const e = h.ev.find(x => x.kind === 'pass')!;
  check(h.p.s.stage === 'funded' && h.p.s.nPassed === 1, 'passed: funded');
  check(e && e.pause && e.up && e.text === 'Evaluation passed with $6,000.00 profit. A funded $50,000.00 account is open.', 'pass message');
  check(h.A.balance === 50000 && h.A.start === 50000 && h.p.s.cycle === 0 && !h.p.s.locked && Object.keys(h.p.s.days).length === 0, 'a fresh funded account');
  check(h.p.view().track.map(x => x.state).join() === 'done,on,', 'the stage track');
  // no pass while a trade is open
  const o = simRig({ ePt: 1000, eCons: 0 });
  o.day(0); o.buy(10); o.tick(o.q.price! + 11); o.A.closeTrade(o.A.trades[0], o.q.price!, 'Closed by you', false); o.buy(1); o.tick();
  check(o.p.s.stage === 'eval', 'no pass while a trade is open');
  o.A.closeAll(); o.tick();
  check(o.p.s.stage === 'funded', 'passes once flat');
}

/* ---- minimum trading days ---- */
{
  const h = simRig({ ePt: 1000, eCons: 0, eMin: 3 });
  h.day(0); h.trade(1500);
  check(h.p.s.stage === 'eval' && h.p.view().rows.some(r => r.label === 'Trading days' && r.value === '1 of 3'), 'one day of three');
  h.day(1); h.trade(100);
  check(h.p.s.stage === 'eval' && h.p.progress().nDays === 2, 'two');
  h.day(2); h.trade(0);
  check(h.p.s.stage === 'eval' && h.p.progress().nDays === 2, 'a day with no closed P&L does not count');
  h.day(3); h.trade(100);
  check(h.p.s.stage === 'funded', 'passes on the third trading day');
}

/* ---- the daily profit target (evaluation only) ---- */
{
  const h = simRig({ eDpt: 300 });
  h.day(0); h.buy(10); h.tick(h.q.price! + 2);
  check(h.A.trades.length === 1, 'up $200: still trading');
  h.tick(h.q.price! + 2);
  check(h.A.trades.length === 0 && h.A.hist[h.A.hist.length - 1].reason === 'Daily profit target', 'up $400: closed');
  check(h.p.s.lockedDay === 'daily profit target reached, up $400.00 today' && h.p.s.dptDay && h.p.s.dptHits === 1, 'locked for the day');
  const e = h.last();
  check(e.kind === 'lock' && e.up === true && e.pause && e.text === 'Daily profit target reached: up $400.00 today. Positions closed and trading paused until the next trading day.', 'message');
  check(h.p.s.log[h.p.s.log.length - 1].text === 'Daily profit target reached: up $400.00 today. Positions closed; trading resumes next trading day.', 'logged');
  check(h.p.check('X', 1, 1) === 'Trading is locked until the next trading day: daily profit target reached, up $400.00 today.', 'orders refused');
  const v = h.p.view();
  check(v.status === 'Target hit today' && v.statusKind === 'pos' && v.rows.some(r => r.label === 'Daily profit target' && r.value === 'reached · +$400.00 today' && r.frac === 1), 'card');
  check(h.p.summaryLine().endsWith(' The daily profit target stopped trading early on 1 evaluation day.'), 'counted in the run summary');
  h.day(1);
  check(!h.p.s.lockedDay && !h.p.s.dptDay && h.p.check('X', 1, 1) === null, 'trading resumes the next day');
}

/* ---- funded: scaling, payout days, payouts ---- */
const toFunded = (cfg: Partial<PropConfig> = {}) => { const h = simRig({ ePt: 100, eCons: 0, ...cfg }); h.day(0); h.trade(100); check(h.p.s.stage === 'funded', 'to funded'); return h; };
{
  const h = toFunded();
  check(h.p.check('X', 1, 21) === 'That would make your position 21, above the funded limit of 20 micros.', 'funded: the first tier below its threshold');
  check(h.p.payout() === 'No payout yet: 0 of 5 days of $150.00 or more this cycle.', 'no payout before the days');
  h.day(1); h.trade(1000); h.day(2);
  check(h.p.tier() === 3 && h.ev.some(e => e.text === 'Contract limit is now 3 minis (30 micros).'), 'scaling up at the day end');
  check(h.p.check('X', 1, 30) === null && h.p.check('X', 1, 31) !== null, 'the new limit');
  check(h.p.s.cycle === 1, 'a qualifying day');
  h.trade(100); h.day(3);
  check(h.p.s.cycle === 1, 'a day under the minimum does not count');
  for (let d = 3; d < 7; d++) { h.trade(300); h.day(d + 1); }
  check(h.p.s.cycle === 5, 'five qualifying days');
  const profit = h.A.balance - h.A.start; // 1000 + 100 + 4 * 300
  const info = h.p.payoutInfo();
  check(info.ok && near(info.amount, Math.min(2000, profit / 2)), `payout amount: half the profit, up to the cap (${info.amount})`);
  check(h.p.view().action!.label === `Request payout $1,150.00` && h.p.view().action!.enabled, 'the card offers it');
  h.buy(1);
  check(h.p.payoutInfo().why === 'close positions and cancel orders first', 'only when flat');
  h.A.closeAll(); h.tick();
  const bal = h.A.balance, peak = h.A.peak, amt = h.p.payoutInfo().amount;
  check(h.p.payout() === null, 'payout taken');
  check(near(h.A.balance, bal - amt) && near(h.A.peak, peak - amt) && near(h.p.s.income, Math.round(amt * 90) / 100) && h.p.s.nPay === 1, 'out of the balance, 90% to you');
  check(h.p.s.locked && h.p.s.cycle === 0 && near(h.p.floor(), 50100), 'the max loss locks, a new cycle starts');
  const mk = h.A.marks[h.A.marks.length - 1];
  check(mk.kind === 'payout' && near(mk.net!, h.p.s.income) && mk.sym === '', 'a payout mark');
  const e = h.last();
  check(e.kind === 'payout' && e.up && e.text === `Funded payout 1: $1,150.00 taken from the account, $1,035.00 to you after the 90% split.`, 'payout message');
  check(h.p.payoutInfo().why === '0 of 5 days of $150.00 or more this cycle', 'the next cycle needs its days');
  const st = h.p.stats();
  check(st.nPay === 1 && st.nPayFunded === 1 && near(st.avgPay!, 1035) && near(st.maxPay!, 1035) && near(st.income, 1035), 'stats');
  check(h.p.statRows().map(r => r.join(': ')).join(' | ') === 'Payout income: $1,035.00 | Payouts taken: 1 | Average payout: $1,035.00 | Largest payout: $1,035.00 | Evaluation fees: $0.00 | Evaluations passed: 1 of 1 | Went live: 0', 'stats rows');
  // under the minimum, and a cycle not in profit
  const m = toFunded({ fDays: 1 });
  m.day(1); m.trade(600); m.day(2);
  check(m.p.payoutInfo().why === 'it would be $300.00, under the $500.00 minimum', 'under the minimum');
  const c = toFunded({ fDays: 1, fPayPct: 100, fPayMin: 100 });
  c.day(1); c.trade(600); c.day(2); c.trade(-700);
  check(c.p.payoutInfo().why === 'this payout cycle is not in profit', 'the cycle not in profit');
  // automatic payouts, on the first tick after the day that completes the cycle
  const a = toFunded({ auto: true, fDays: 1 });
  a.day(1); a.trade(1200);
  check(a.p.s.nPay === 0, 'not before the day ends');
  a.day(2);
  check(a.p.s.nPay === 1 && near(a.p.s.paid, 600), 'taken automatically');
}

/* ---- live ---- */
{
  const h = toFunded({ fDays: 1, fPayouts: 1, lMll: 2000, lBonusPt: 2000, lBonusDays: 2, lBonus: 1000 });
  h.day(1); h.trade(1200); h.day(2);
  check(h.p.payout() === null && h.p.s.stage === 'live' && h.p.s.nLive === 1, 'the last funded payout moves the account to live');
  const e = h.last();
  check(e.kind === 'live' && e.pause && e.text === 'That was the last funded payout: the account moves to live, opening with a $2,000.00 max loss.', 'live message');
  check(h.A.balance === 50000 && h.A.start === 50000 && near(h.p.floor(), 48000) && h.p.label() === 'Live', 'live opens at $0 profit with the live max loss');
  check(h.p.payoutInfo().why === 'needs more than $200.00 of live profit' && h.p.view().action!.kind === 'payoutAmount', 'live payouts need some profit');
  h.trade(1000);
  const v = h.p.view();
  check(v.payout.ok && near(v.payout.max, 800) && v.action!.hint === 'Up to $800.00 today.' && v.action!.amount === 800, 'any day, up to profit less twice the pad');
  check(h.p.payout(5000) === null && near(h.p.s.paid, 800) && near(h.A.balance, 50200), 'clamped to the most allowed');
  check(h.p.stats().nPayLive === 1, 'a live payout');
  check(near(h.p.floor(), 50100), 'locked by the payout');
  h.day(3); h.trade(500); h.day(4);
  check(!h.p.s.bonusPaid && h.p.view().bonusDays === 2 && near(h.p.view().bonusProfit, 1500), 'no bonus yet: two days, but $1,500 of the $2,000 (payouts count)');
  h.trade(500); const inc = h.p.s.income, bal = h.A.balance; h.day(5);
  check(h.p.s.bonusPaid && near(h.p.s.income - inc, 900) && h.A.balance === bal, 'the live bonus: paid to you, not from the balance');
  check(h.ev.some(x => x.kind === 'payout' && x.text === 'Live bonus released: $1,000.00, $900.00 to you after the split.'), 'bonus message');
  check(h.p.stats().bonus === 900 && h.p.stats().nPay === 2 && h.A.marks.some(m => m.kind === 'payout' && m.bonus), 'the bonus is not a payout in the stats');
  check(h.p.view().rows.some(r => r.label === 'Live bonus' && r.value === 'released · $1,000.00'), 'bonus row');
  // the live lock: once profit reaches the max loss (no pad), the floor jumps to start + lockPad
  const l = toFunded({ fDays: 1, fPayouts: 1 });
  l.day(1); l.trade(1200); l.day(2); l.p.payout();
  l.trade(1975); l.day(3);
  check(!l.p.s.locked && near(l.p.floor(), 50000 - 25), 'live: trailing under the threshold');
  l.trade(25); l.day(4);
  check(l.p.s.locked && near(l.p.floor(), 50100), 'live locks at the max loss and the floor jumps to start + pad');
  check(l.p.stats().live === 1, 'went live');
}

/* ---- saving and step back: state() and load() ---- */
{
  const h = simRig({ ePt: 5000, eCons: 50, dll: 1000 });
  h.day(0); h.trade(1200); h.day(1); h.trade(-300); h.buy(10); h.tick(h.q.price! + 1);
  const st = JSON.parse(JSON.stringify(h.p.state())), acc = h.A.state(), view = JSON.stringify(h.p.view()), px0 = h.q.price;
  check(st.day != null && Object.keys(st.days).length === 1 && st.stage === 'eval', 'mid-evaluation state is plain JSON');
  h.tick(h.q.price! - 40);
  check(h.p.s.over !== '', 'then the account fails');
  h.A.load(acc); h.p.load(st); h.q.price = px0; // a session restores the market too
  check(JSON.stringify(h.p.state()) === JSON.stringify(st) && JSON.stringify(h.p.view()) === view, 'load puts it back exactly');
  h.tick(h.q.price! + 1); h.A.closeAll(); h.tick();
  check(!h.p.s.over && h.p.s.stage === 'eval', 'and it carries on');
  const A2 = new Account(12345); A2.quote = () => h.q;
  const r = new PropSim(simConfig({ on: true }), A2, { state: st });
  check(A2.balance === 12345 && r.s.attempt === 1 && JSON.stringify(r.state()) === JSON.stringify(st), 'reopening a saved state leaves the account alone');
  const old = { ...st, log: [{ t: 0, text: 'Evaluation passed with $1.00 profit.' }, { t: 1, text: 'Funded account failed. x' }] };
  delete old.nPassed; delete old.nFail;
  const o = new PropSim(simConfig({ on: true }), A2, { state: old });
  check(o.stats().passed === 1 && o.stats().failFunded === 1, 'older states are counted from their log');
}

/* ---- skipping bars in a jump ---- */
{
  const h = simRig({ ePt: 100000 });
  check(!h.p.canSkipBar(D(0, 10)), 'not before the first tick');
  h.day(0);
  check(h.p.canSkipBar(D(0, 12)) && !h.p.canSkipBar(D(0, 18)), 'idle within the day; a day roll is not skippable');
  h.buy(10); h.tick(h.q.price! + 1); h.A.closeAll();
  check(!h.p.canSkipBar(D(0, 12)), 'not with a check waiting');
  h.tick();
  check(h.p.canSkipBar(D(0, 12)), 'idle again once checked');
  h.buy(10);
  check(h.p.canSkipBar(D(0, 12)), 'a trade open elsewhere: its own ticks run the rules');
}

/* ---- the plain prop rules ---- */
{
  const s = rulesRig({ mll: 1000 });
  s.day(0); s.buy(10); s.tick(s.q.price! - 10);
  const e = s.last();
  check(s.p.s.failed && e.kind === 'fail' && e.pause && e.text === 'Evaluation failed. Max loss limit: equity fell to $49,000.00, below the floor of $49,000.00.', 'static max loss fails');
  check(s.A.trades.length === 0 && s.p.check('X', 1, 1) === 'This evaluation has failed. Start a new session from Session settings to try again.' && s.p.label() === 'Failed', 'and stays failed');

  const t = rulesRig({ mll: 1000, mllType: 'trailing' });
  t.day(0); t.buy(10); t.tick(t.q.price! + 5);
  check(near(t.p.floor(), 49500), 'trailing: follows the highest equity intraday');
  t.tick(t.q.price! + 10);
  check(near(t.p.floor(), 50000), 'and locks at the start balance');
  const u = rulesRig({ mll: 1000, mllType: 'trailing', mllLock: false });
  u.day(0); u.buy(10); u.tick(u.q.price! + 15);
  check(near(u.p.floor(), 50500), 'unless the lock is off');
  const eod = rulesRig({ mll: 1000, mllType: 'eod' });
  eod.day(0); eod.trade(700);
  check(near(eod.p.floor(), 49000), 'end-of-day: not intraday');
  eod.day(1);
  check(near(eod.p.floor(), 49700), 'moves at the day roll');

  const d = rulesRig({ dll: 500 });
  d.day(0); d.buy(10); d.tick(d.q.price! - 6);
  check(d.p.s.locked === 'daily loss limit hit, down $600.00' && d.A.trades.length === 0 && !d.p.s.failed, 'daily loss limit locks');
  check(d.p.check('X', 1, 1) === 'Trading is locked until the next trading day: daily loss limit hit, down $600.00.', 'orders refused');
  d.day(1);
  check(d.p.s.locked === '', 'until the next day');
  const df = rulesRig({ dll: 500, dllAct: 'fail' });
  df.day(0); df.buy(10); df.tick(df.q.price! - 6);
  check(df.p.s.failed && df.p.s.reason === 'Daily loss limit: down $600.00 today.', 'or fails');

  const p = rulesRig({ pt: 500, minDays: 2, cons: 80 });
  p.day(0); p.trade(600);
  check(!p.p.s.passedAt && p.p.view().rows.some(r => r.label === 'Trading days' && r.value === '1 of 2'), 'target met, one day');
  p.day(1); p.trade(0);
  check(!p.p.s.passedAt && p.p.progress().nDays === 2 && !p.p.progress().consOk, 'a day with a fill counts; consistency is over the days\' total');
  p.trade(200);
  check(p.p.s.passedAt != null && p.last().kind === 'pass' && p.last().text === 'Profit target reached with every rule met. Evaluation passed.' && p.p.label() === 'Passed', 'passes');
  check(p.p.view().status === 'Passed', 'card status');

  const z = rulesRig({ maxSize: 5 });
  z.day(0);
  check(z.p.check('X', 1, 6) === 'That would make your position 6, above the max size of 5.' && z.p.check('X', 1, 5) === null, 'max size');

  // flat by 20:00 UTC (16:00 New York) until the trading day starts at 22:00 UTC
  const f = rulesRig({ flatBy: '20:00' }, 0);
  f.tick(1000, D(0, 15, 50)); f.buy(10); f.tick(1000, D(0, 15, 59));
  check(f.A.trades.length === 1, 'before the flat-by time');
  f.tick(1000, D(0, 16));
  check(f.A.trades.length === 0 && f.last().text === 'It is past the 20:00 flat-by time: positions closed and orders canceled.' && !f.last().pause, 'flattened at the flat-by time');
  check(f.p.check('X', 1, 1) === 'New trades are blocked after the flat-by time (20:00) until the next trading day.' && f.p.view().status === 'Past flat-by time', 'blocked');
  f.tick(1000, D(0, 18, 1));
  check(f.p.check('X', 1, 1) === null, 'open again when the next day starts');

  const sv = rulesRig({ pt: 1000, minDays: 3 });
  sv.day(0); sv.trade(400); sv.day(1); sv.trade(100);
  const st = JSON.parse(JSON.stringify(sv.p.state())), acc = sv.A.state();
  sv.trade(-200);
  sv.A.load(acc); sv.p.load(st);
  check(JSON.stringify(sv.p.state()) === JSON.stringify(st) && sv.p.progress().nDays === 2 && near(sv.p.progress().closed, 500), 'plain rules round trip');
  check(sv.p.canSkipBar(D(1, 12)) === false, 'a fresh load is checked once');
}

/* ---- which engine ---- */
{
  const A = new Account(10000);
  check(startProp({ sim: { on: true, size: 25000 }, prop: { on: true } }, A) instanceof PropSim && A.balance === 25000, 'the simulation wins over the plain rules');
  check(startProp({ sim: { on: false }, prop: { on: true, pt: 100 } }, A) instanceof PropRules, 'plain rules');
  check(startProp({ sim: SIM_DEF, prop: PROP_DEF }, A) === null, 'none');
}

console.log(`prop: ${passed} checks passed`);
