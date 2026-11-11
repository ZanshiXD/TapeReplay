// Prop firm rules on the account. Two engines; a session runs one of them:
//  - PropSim, the prop simulation: one account's whole course in one session. Pass the evaluation and a fresh funded
//    account opens at the same size; each funded payout comes out of the balance and locks the max loss; after the
//    last one the account moves to live (opening at $0 profit, payouts any day). Breaking a max loss ends that account;
//    a new evaluation costs the fee again. The max loss trails the end-of-day high and locks at start + lockPad.
//    Size limits are in minis; trading micros, each mini allows 10.
//  - PropRules, the older plain prop rules: one evaluation with a static, trailing or end-of-day trailing max loss, a
//    daily loss limit that locks or fails, target, consistency, minimum days, max size and a flat-by time. New
//    sessions don't offer them; sessions saved with them on still reopen with them. The simulation turns them off.
// Both check after every tick, on equity (balance plus open P&L at the bid or ask): the limits intraday, the end-of-day
// things (the trailing high, the lock, scaling, payout days, the live bonus) on the first tick of the next trading day,
// with the equity of that tick. Trading days start at the reset hour, New York time (18:00 by default).
//
// How a Session uses it (session.ts is not changed here; this is the wiring):
//  - Make it right after the Account and before the first takeSnap: `startProp({ sim, prop }, account, opts)` gives
//    the engine in effect (the simulation when sim.on, else the plain rules when prop.on, else null). A new PropSim
//    funds the account at sim.size and counts the first fee; pass `opts.state` to reopen a saved one (the account is
//    then left as it is).
//  - prop.onEvent = e => { if (e.pause) { this.stop = true; this.playing = false; } this.emit(...e.text as a toast...) }
//    (pause is set where the replay pauses; strategy runs ignore it).
//  - tickOne: right after `this.account.onTick(sym, from, to, jump)`, call `this.prop?.onTick(f.time)`, f being the
//    feed that just ticked (its time is the tick's).
//  - order(): before account.submit, `const err = this.prop?.check(sym, side, qty)`; if err, report it as an
//    'error' event and return it without placing the order. Limit and stop orders are checked only when placed.
//  - Snapshots: add `prop: prop.state()` in takeSnap and `prop.load(x.prop)` in restore, so stepping or jumping back
//    puts the rules back with the account (the plain rules count trading days from account.hist and account.marks,
//    so the two must be restored together). Saved sessions keep prop.state() and prop.cfg.
//  - jumpTo's bar skip: also require `!this.prop || this.prop.canSkipBar(g.s.t[g.i] + g.s.base)`: a bar is safe to
//    skip only when it ends on the same trading day and no pass, payout or flat-by check is waiting.
//  - The card: view() for the rows, prop.restart() for "Start a new evaluation", prop.payout(amount?) for "Request
//    payout" (returns an error to show, or null). Strategy runs: after each tick, `prop.rebuy(rebuy, maxEvals)`.
//  - Payouts and the live bonus add account marks of kind 'payout' with sym '' (the whole account's), net and bonus.
import { fmtQty, money, smoney, type Account, type Side } from './account';
import { nyOff, tradingDay, zoneOff as chartZoneOff } from './time';
import type { RunRules } from './backtest';

export type Stage = 'eval' | 'funded' | 'live';
export const STAGES: Record<Stage, string> = { eval: 'Evaluation', funded: 'Funded', live: 'Live' };

/** the simulation's settings: e* the evaluation, f* funded, l* live; money in dollars, contract limits in minis */
export interface PropConfig {
  on: boolean;
  /** the preset last chosen, for show */
  preset: string;
  /** every account's starting balance (it replaces the session's balance) */
  size: number;
  /** what each evaluation costs, the first included */
  fee: number;
  /** the contracts you trade: micros (10 per mini allowed) or minis */
  unit: 'micro' | 'mini';
  /** the trading day starts at this hour, New York time */
  resetNY: number;
  /** daily loss limit, every stage: closes everything and locks the day, never fails the account; 0 = off */
  dll: number;
  /** the max loss locks at start + this */
  lockPad: number;
  /** take funded payouts as soon as they are allowed */
  auto: boolean;
  /** evaluation: profit target, max loss, consistency (best day max % of profit, 0 = off), max minis (0 = no limit),
   *  minimum trading days, and your own daily profit target (stop for the day once up this much; 0 = off) */
  ePt: number; eMll: number; eCons: number; eMax: number; eMin: number; eDpt: number;
  /** funded: max loss, size tiers "profit:minis, …", winning days per payout cycle and the least a day must make to
   *  count, the smallest and largest payout (0 = no cap), the most of the profit one payout may take (%), your
   *  profit split (%), payouts before live */
  fMll: number; fTiers: string; fDays: number; fDayMin: number; fPayMin: number; fPayMax: number; fPayPct: number; split: number; fPayouts: number;
  /** live: max loss, max minis, and the bonus: profit and trading days needed, and its amount (0 = none) */
  lMll: number; lMax: number; lBonusPt: number; lBonusDays: number; lBonus: number;
}
export const SIM_DEF: PropConfig = {
  on: false, preset: '', size: 50000, fee: 0, unit: 'micro', resetNY: 18, dll: 0, lockPad: 100, auto: false,
  ePt: 3000, eMll: 2000, eCons: 50, eMax: 4, eMin: 0, eDpt: 0,
  fMll: 2000, fTiers: '0:2, 1000:3, 2000:4', fDays: 5, fDayMin: 150, fPayMin: 500, fPayMax: 2000, fPayPct: 50, split: 90, fPayouts: 5,
  lMll: 2000, lMax: 4, lBonusPt: 4000, lBonusDays: 20, lBonus: 2000,
};
// "L Flex": a futures prop firm's Flex accounts as published in October 2026 (payout rules, live structure). No daily
// loss limit; fees vary at checkout, so the fee is left to you. A preset leaves fee, eDpt, resetNY, unit and auto alone.
export const PROP_PRESETS: Record<string, Partial<PropConfig>> = {
  'L Flex 25K': { size: 25000, ePt: 1250, eMll: 1000, eCons: 50, eMax: 2, eMin: 0, fMll: 1000, fTiers: '0:1, 1000:2', fDays: 5, fDayMin: 100,
    fPayMin: 500, fPayMax: 1000, fPayPct: 50, split: 90, fPayouts: 5, lMll: 1000, lMax: 2, lBonusPt: 2000, lBonusDays: 20, lBonus: 1000, dll: 0, lockPad: 100 },
  'L Flex 50K': { size: 50000, ePt: 3000, eMll: 2000, eCons: 50, eMax: 4, eMin: 0, fMll: 2000, fTiers: '0:2, 1000:3, 2000:4', fDays: 5, fDayMin: 150,
    fPayMin: 500, fPayMax: 2000, fPayPct: 50, split: 90, fPayouts: 5, lMll: 2000, lMax: 4, lBonusPt: 4000, lBonusDays: 20, lBonus: 2000, dll: 0, lockPad: 100 },
};
/** saved settings with the defaults filled in; presets saved under their old names ('Lucid Flex …') get the new ones */
export function simConfig(saved?: Partial<PropConfig> | null): PropConfig {
  const s = { ...SIM_DEF, ...(saved || {}) };
  if (/^Lucid Flex /.test(s.preset || '')) s.preset = s.preset.replace(/^Lucid Flex /, 'L Flex ');
  return s;
}
/** choosing a preset in the settings: its rules over the current ones, the simulation on; the current fee, unit, auto
 *  and reset hour stay unless the preset has its own */
export function applyPreset(cur: PropConfig, name: string, rules = PROP_PRESETS[name]): PropConfig {
  return { ...cur, ...rules, on: true, unit: cur.unit, fee: rules.fee ?? cur.fee, auto: cur.auto, resetNY: rules.resetNY ?? cur.resetNY, preset: name };
}
/** the note under the daily profit target: what it does, and the largest one that keeps every day inside the
 *  consistency rule */
export function dptNote(c: Pick<PropConfig, 'ePt' | 'eCons' | 'eDpt'>): string {
  const pt = c.ePt || 0, cons = c.eCons || 0, dpt = c.eDpt || 0;
  const safe = pt > 0 && cons > 0 && cons < 100 ? Math.floor(pt * cons / 100) : 0;
  return (dpt > 0 ? `Evaluation only: once a day is up ${money(dpt)}, positions close and trading stops until the next trading day.`
    : 'Daily profit target: once a day is up this much, positions close and trading stops until the next trading day (evaluation only).') +
    (safe ? ` With a ${money(pt)} target and ${cons}% consistency, ${money(safe)} or less keeps every day inside the rule${dpt > safe ? `; ${money(dpt)} can still leave one day too big` : ''}.` : '');
}

/** what reaches the screens: a breach ends an account (sim) and 'fail' ends the plain-rules evaluation; 'pass' an
 *  evaluation passed; 'payout' a payout or the live bonus; 'live' the move to live; 'lock' trading locked for the day
 *  (daily loss limit, daily profit target); 'info' the rest (max loss locked, contract limit, a new evaluation,
 *  flat-by). up: true good news, false bad, unset neutral. pause: stop the replay. */
export interface PropEvent { kind: 'breach' | 'pass' | 'payout' | 'live' | 'lock' | 'fail' | 'info'; text: string; up?: boolean; pause?: boolean }
export interface PropOpts<S> {
  /** the trading day's start hour, New York time; by default the config's */
  resetHour?: number;
  /** the chart zone's offset from UTC in seconds (the plain rules' flat-by time is in chart time) */
  zoneOff?: (t: number) => number;
  /** reopen a saved state instead of starting fresh */
  state?: S;
}
/** a row of a rules card: label, value, a meter (frac 0..1, none when null) marked ok (green) or bad (red), and the
 *  sign to color the value by */
export interface PropRow { label: string; value: string; frac: number | null; state: 'ok' | 'bad' | ''; sign?: number }
/** what Session needs from either engine */
export interface PropEngine {
  readonly kind: 'sim' | 'rules';
  onEvent?: (e: PropEvent) => void;
  onTick(now: number): void;
  check(sym: string, side: Side, qty: number): string | null;
  canOpen(adds: number): string | null;
  canSkipBar(t: number): boolean;
  state(): PropState | RulesState;
  load(s: PropState | RulesState): void;
  label(): string;
}

const round2 = (x: number) => Math.round(x * 100) / 100;
const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const row = (label: string, value: string, frac: number | null = null, state: PropRow['state'] = '', sign?: number): PropRow =>
  ({ label, value, frac: frac == null ? null : clamp(frac || 0, 0, 1), state, ...(sign != null ? { sign } : {}) });
/** gross open size: every open trade and every working order, any side or market */
const openQtyOf = (A: Account) => A.trades.reduce((s, x) => s + x.qty, 0) + A.orders.reduce((s, x) => s + x.qty, 0);
/** what an order adds to the position: only what grows the net position (all of it when hedging) */
const addsOf = (A: Account, sym: string, side: Side, qty: number) => { const n = A.netPosition(sym).q; return A.hedge ? qty : Math.max(0, Math.abs(n + side * qty) - Math.abs(n)); };
const flatten = (A: Account, reason: string) => { A.cancelAll(); A.closeAll(undefined, reason); };

/* ---------------- the prop simulation ---------------- */
export interface PropPayout { t: number; stage: Stage; n: number; amount: number; net: number; bonus?: boolean }
/** one account of the course (an evaluation, a funded or a live account): when it ran, the closed trades it holds
 *  (account.hist from h0 to h1), how it ended, and what it paid out */
export interface PropAcct {
  stage: Stage; attempt: number; from: number; to: number | null; h0: number; h1: number | null;
  /** how it ended: failed, passed (evaluation), went live (funded), or still open */
  end: 'failed' | 'passed' | 'live' | 'open'; why: string;
  /** taken from it, how many times, and paid to you (payouts and the bonus, after the split) */
  paid: number; nPay: number; income: number;
}
export interface PropLogLine { t: number; text: string }
export interface PropState {
  // the course, kept across accounts
  stage: Stage; attempt: number; fees: number;
  /** what you have been paid: payouts and the bonus after the split */
  income: number;
  payouts: PropPayout[]; log: PropLogLine[];
  /** why the account failed; '' while it is alive */
  over: string;
  nPassed: number; nLive: number; nFail: Record<Stage, number>;
  /** evaluation days stopped by the daily profit target */
  dptHits: number;
  // the account now (reset by each new account)
  start: number; day: number | null;
  /** the closed balance at the day's first tick */
  dayStart: number;
  /** the highest equity seen at a day's end */
  eodPeak: number;
  /** the max loss is locked at start + lockPad */
  locked: boolean;
  /** why trading is locked for the rest of the day ('' = not locked), and whether that was the daily profit target */
  lockedDay: string; dptDay: boolean;
  /** trading day -> closed P&L that day (nonzero days only, to the cent) */
  days: Record<string, number>;
  /** funded: qualifying days this payout cycle, the balance the cycle started at, the profit scaling goes by */
  cycle: number; cycleStart: number; tierProfit: number;
  /** taken out of this account, and how many times */
  paid: number; nPay: number; bonusPaid: boolean;
  /** the balance at the last pass or payout check */
  checked: number | null;
  /** the time of the last tick seen */
  t: number;
  /** every account so far, the open one last (missing in states saved before it was kept) */
  accts?: PropAcct[];
}
const newStage = (start: number) => ({ start, day: null as number | null, dayStart: start, eodPeak: start, locked: false, lockedDay: '', dptDay: false,
  days: {} as Record<string, number>, cycle: 0, cycleStart: start, tierProfit: 0, paid: 0, nPay: 0, bonusPaid: false, checked: null as number | null });
export const newSimState = (cfg: PropConfig, t = 0): PropState => ({ stage: 'eval', attempt: 1, fees: cfg.fee || 0, income: 0, payouts: [], log: [], over: '',
  nPassed: 0, nLive: 0, nFail: { eval: 0, funded: 0, live: 0 }, dptHits: 0, ...newStage(cfg.size), t });
// a state saved by an older version: the counters it lacks are counted from its log
function normSim(x: Partial<PropState>, cfg: PropConfig): PropState {
  const log = x.log || [], has = (re: RegExp) => log.filter(l => re.test(l.text)).length;
  const s = { ...newSimState(cfg), ...clone(x) } as PropState;
  if (x.nPassed == null) s.nPassed = has(/^Evaluation passed/);
  if (x.nLive == null) s.nLive = has(/moves to live/);
  if (x.nFail == null) s.nFail = { eval: has(/^Evaluation account failed/), funded: has(/^Funded account failed/), live: has(/^Live account failed/) };
  if (x.fees == null) s.fees = 0;
  return s;
}
export interface PayoutInfo { ok: boolean; amount: number; max: number; why: string }
export interface PropStats {
  attempts: number; passed: number; live: number; failEval: number; failFunded: number; failLive: number;
  nPay: number; nPayFunded: number; nPayLive: number; paid: number; avgPay: number | null; maxPay: number | null; minPay: number | null;
  firstPay: number | null; bonus: number; fees: number; income: number; take: number; passRate: number | null;
}
/** the course in numbers: accounts bought, passed, lost at each stage and taken live; payouts to you (after the split) */
export function simStats(sim: PropState): PropStats {
  const pays = (sim.payouts || []).filter(x => !x.bonus), nets = pays.map(x => x.net), bonus = (sim.payouts || []).filter(x => x.bonus).reduce((a, x) => a + x.net, 0);
  const paid = nets.reduce((a, x) => a + x, 0), fees = sim.fees || 0, income = sim.income || 0, attempts = sim.attempt || 1;
  return { attempts, passed: sim.nPassed, live: sim.nLive, failEval: sim.nFail.eval || 0, failFunded: sim.nFail.funded || 0, failLive: sim.nFail.live || 0,
    nPay: pays.length, nPayFunded: pays.filter(x => x.stage === 'funded').length, nPayLive: pays.filter(x => x.stage === 'live').length,
    paid, avgPay: pays.length ? paid / pays.length : null, maxPay: pays.length ? Math.max(...nets) : null, minPay: pays.length ? Math.min(...nets) : null,
    firstPay: pays.length ? pays[0].t : null, bonus, fees, income, take: income - fees, passRate: sim.nPassed / attempts * 100 };
}
export const parseTiers = (s: string) => String(s || '').split(/[,;]+/).map(x => x.split(':').map(Number)).filter(a => a.length === 2 && a.every(isFinite)).sort((a, b) => a[0] - b[0]);

export interface SimView {
  stage: Stage; stageName: string;
  /** "Evaluation", "Funded failed", … */
  label: string;
  /** the status tag: Failed / Target hit today / Locked today / the stage; kind for its color */
  status: string; statusKind: 'neg' | 'pos' | 'warn' | '';
  /** Evaluation → Funded → Live: earlier stages done, this one on */
  track: Array<{ name: string; state: 'done' | 'on' | '' }>;
  /** why the account failed, or '' */
  over: string; lockedDay: string;
  balance: number; equity: number; start: number; profit: number;
  /** today's P&L, open trades included */
  today: number;
  /** the max loss: the floor, what is left above it, the stage's max loss, locked or trailing, and how much is used (0..1) */
  floor: number; room: number; mll: number; mllLocked: boolean; mllUsed: number;
  /** the daily loss limit (0 = off) and how much of it today has used (0..1) */
  dll: number; dllUsed: number;
  /** evaluation: target and progress, consistency (best day % of profit, null before any profit), trading days, the
   *  daily profit target and whether today hit it (0 when not the evaluation or off) */
  target: number; targetFrac: number; ptOk: boolean; consPct: number | null; cons: number; consOk: boolean;
  nDays: number; minDays: number; daysOk: boolean; dpt: number; dptDay: boolean; dptFrac: number;
  /** funded: payout days this cycle, payouts taken of those needed for live */
  cycle: number; fDays: number; cycleFrac: number; nPay: number; fPayouts: number; payoutsFrac: number;
  /** live: profit since it opened (payouts included) toward the bonus, its trading days, progress */
  bonus: number; bonusPaid: boolean; bonusProfit: number; bonusDays: number; bonusFrac: number;
  /** the size limit now (0 = none), in `unit`, and the gross open size */
  maxSize: number; unit: 'micros' | 'minis'; openQty: number;
  payout: PayoutInfo;
  income: number; fees: number; take: number;
  /** the button the card offers: restart (failed), payout (funded, the full allowed amount), payoutAmount (live,
   *  amount box prefilled with `amount`) */
  action: { kind: 'restart' | 'payout' | 'payoutAmount'; label: string; enabled: boolean; hint: string; amount: number | null } | null;
  /** the card's rows */
  rows: PropRow[];
  /** the summary under the card: [label, value] */
  summary: Array<[string, string]>;
  /** the last five log lines, newest first */
  log: PropLogLine[];
}

export class PropSim implements PropEngine {
  readonly kind = 'sim';
  cfg: PropConfig;
  readonly account: Account;
  s: PropState;
  onEvent?: (e: PropEvent) => void;
  private hour: number;
  private tierKey = '\0'; private tierV: number[][] = [];

  constructor(cfg: PropConfig, account: Account, opts: PropOpts<PropState> = {}) {
    this.cfg = cfg; this.account = account;
    this.hour = opts.resetHour ?? (cfg.resetNY || 0);
    if (opts.state) this.s = normSim(opts.state, cfg);
    else { this.s = newSimState(cfg); account.reopen(cfg.size); this.s.accts = [this.acctRec('eval')]; }
  }
  private acctRec(stage: Stage): PropAcct {
    return { stage, attempt: this.s.attempt, from: this.s.t || 0, to: null, h0: this.account.hist.length, h1: null, end: 'open', why: '', paid: 0, nPay: 0, income: 0 };
  }
  /** the open account's record (null for states saved before records were kept) */
  private cur(): PropAcct | null { const a = this.s.accts; return a && a.length ? a[a.length - 1] : null; }
  private closeRec(end: PropAcct['end'], why = '') { const c = this.cur(); if (c && c.end === 'open') { c.end = end; c.why = why; c.to = this.s.t; c.h1 = this.account.hist.length; } }
  /** every account with its trades counted to now: the open one's end is the last trade so far */
  accounts(): PropAcct[] { return (this.s.accts || []).map(a => a.h1 == null ? { ...a, to: this.s.t, h1: this.account.hist.length } : { ...a }); }
  /** the trading day of time t */
  day(t: number) { return tradingDay(t, this.hour); }
  openQty() { return openQtyOf(this.account); }
  /** funded contract limit in minis: the first tier below its threshold, none without tiers */
  tier() {
    if (this.tierKey !== this.cfg.fTiers) { this.tierV = parseTiers(this.cfg.fTiers); this.tierKey = this.cfg.fTiers; }
    const tiers = this.tierV; let n = tiers.length ? tiers[0][1] : 0;
    for (const [p, c] of tiers) if (this.s.tierProfit >= p) n = c;
    return n;
  }
  /** this stage's max loss, size limit (in the contracts you trade) and the end-of-day high that locks the floor */
  rules() {
    const G = this.cfg, mult = G.unit === 'micro' ? 10 : 1;
    if (this.s.stage === 'eval') return { mll: G.eMll, max: G.eMax * mult, lockAt: G.eMll + G.lockPad };
    if (this.s.stage === 'funded') return { mll: G.fMll, max: this.tier() * mult, lockAt: G.fMll + G.lockPad };
    return { mll: G.lMll, max: G.lMax * mult, lockAt: G.lMll };
  }
  /** the equity the account fails at: the end-of-day high less the max loss, never above start + lockPad */
  floor() { const s = this.s; return s.locked ? s.start + this.cfg.lockPad : Math.min(s.eodPeak - this.rules().mll, s.start + this.cfg.lockPad); }
  /** the evaluation's pass test, on closed P&L; today's closed P&L counts, so it can pass mid-day */
  progress() {
    const G = this.cfg, s = this.s, A = this.account, today = A.balance - s.dayStart;
    const vals = Object.values(s.days).concat(today ? [today] : []);
    const profit = A.balance - s.start, best = Math.max(0, ...vals);
    const consPct = profit > 0 ? best / profit * 100 : null, nDays = vals.filter(v => v).length;
    const ptOk = profit >= G.ePt, consOk = !G.eCons || (consPct != null && consPct <= G.eCons + 1e-9), daysOk = nDays >= (G.eMin || 0);
    return { profit, best, consPct, nDays, ptOk, consOk, daysOk, passed: ptOk && consOk && daysOk };
  }
  /** whether a payout can be taken now, how much, and why not */
  payoutInfo(): PayoutInfo {
    const G = this.cfg, s = this.s, A = this.account, profit = A.balance - s.start, flat = !A.trades.length && !A.orders.length;
    if (s.over || (s.stage !== 'funded' && s.stage !== 'live')) return { ok: false, amount: 0, max: 0, why: '' };
    if (s.stage === 'funded') {
      const amount = Math.floor(Math.min(G.fPayMax > 0 ? G.fPayMax : Infinity, profit * G.fPayPct / 100) * 100) / 100;
      const why = s.cycle < G.fDays ? `${s.cycle} of ${G.fDays} days of ${money(G.fDayMin)} or more this cycle`
        : A.balance - s.cycleStart <= 0 ? 'this payout cycle is not in profit'
        : amount < Math.max(G.fPayMin, 0.01) ? `it would be ${money(Math.max(0, amount))}, under the ${money(G.fPayMin)} minimum`
        : !flat ? 'close positions and cancel orders first' : '';
      return { ok: !why, amount, max: amount, why };
    }
    // live: any day, leaving the balance at least the lock amount above the locked floor
    const max = Math.floor((profit - 2 * G.lockPad) * 100) / 100;
    const why = max < 1 ? `needs more than ${money(2 * G.lockPad)} of live profit` : !flat ? 'close positions and cancel orders first' : '';
    return { ok: !why, amount: max, max, why };
  }
  /** takes a payout (funded: the full allowed amount; live: `amount`, up to the most allowed); an error, or null */
  payout(amount?: number): string | null {
    const G = this.cfg, s = this.s, A = this.account, info = this.payoutInfo();
    if (!info.ok) return info.why ? `No payout yet: ${info.why}.` : 'No payout yet.';
    amount = round2(clamp(amount != null && isFinite(amount) ? amount : info.amount, 0.01, info.max));
    if (s.stage === 'live' && amount < 1) return 'Enter a payout amount.';
    const net = Math.round(amount * G.split) / 100;
    A.withdraw(amount); s.dayStart -= amount; // money taken out is not a drawdown or a losing day
    s.income += net; s.paid += amount; s.nPay++;
    s.payouts.push({ t: s.t, stage: s.stage, n: s.nPay, amount, net });
    { const c = this.cur(); if (c) { c.paid += amount; c.nPay++; c.income += net; } }
    A.marks.push({ sym: '', t: s.t, side: 1, kind: 'payout', id: 0, net });
    s.locked = true; s.cycle = 0; s.cycleStart = A.balance; s.tierProfit = Math.min(s.tierProfit, A.balance - s.start); s.checked = null;
    this.log(`${STAGES[s.stage]} payout ${s.nPay}: ${money(amount)} taken from the account, ${money(net)} to you after the ${G.split}% split.`, 'payout', true);
    if (s.stage === 'funded' && s.nPay >= G.fPayouts) {
      s.nLive++;
      this.closeRec('live', `${s.nPay} payouts taken`);
      this.newAccount('live');
      this.log(`That was the last funded payout: the account moves to live, opening with a ${money(G.lMll)} max loss.`, 'live', true, true);
    }
    return null;
  }
  /** a new evaluation (its fee counted): from the card once an account has failed, or a strategy run's re-buy */
  restart() {
    const s = this.s, A = this.account;
    if (A.trades.length || A.orders.length) flatten(A, 'New evaluation');
    s.attempt++; s.fees += this.cfg.fee || 0;
    this.newAccount('eval');
    this.log(`Evaluation attempt ${s.attempt} started${this.cfg.fee ? `, fee ${money(this.cfg.fee)}` : ''}.`, 'info');
  }
  /** strategy runs, after each tick: once the account has failed, buy a new evaluation (while fewer than maxEvals,
   *  0 = no limit) or say why the run ends; null while the account is alive. The run drops its queued orders on a
   *  re-buy and prints `text` after the time. */
  rebuy(on: boolean, maxEvals = 0): { restarted: boolean; text: string } | null {
    const s = this.s; if (!s.over) return null;
    if (on && s.attempt < (maxEvals || Infinity)) {
      this.restart();
      return { restarted: true, text: `New evaluation, attempt ${s.attempt}${this.cfg.fee ? ` (${money(this.cfg.fee)})` : ''}.` };
    }
    return { restarted: false, text: on ? `Reached ${s.attempt} evaluations, so the run ends here.` : 'The account failed, so the run ends here. Tick "buy a new evaluation" to keep going.' };
  }
  // a fresh account at the same size for the next stage (or a new evaluation); the trading day carries on
  private newAccount(stage: Stage) {
    const s = this.s, day = s.day;
    Object.assign(s, newStage(this.cfg.size), { stage, over: '', day, dayStart: this.cfg.size });
    this.account.reopen(this.cfg.size);
    if (s.accts) { this.closeRec('failed'); s.accts.push(this.acctRec(stage)); }
  }
  private emit(kind: PropEvent['kind'], text: string, up?: boolean, pause?: boolean) {
    this.onEvent?.({ kind, text, ...(up != null ? { up } : {}), ...(pause ? { pause } : {}) });
  }
  private log(text: string, kind: PropEvent['kind'], up?: boolean, pause?: boolean) { this.s.log.push({ t: this.s.t, text }); this.emit(kind, text, up, pause); }
  private breach(reason: string) {
    const s = this.s; s.over = reason; s.nFail[s.stage] = (s.nFail[s.stage] || 0) + 1;
    flatten(this.account, 'Rule breach');
    this.closeRec('failed', reason);
    this.log(`${STAGES[s.stage]} account failed. ${reason}`, 'breach', false, true);
  }
  // the trading day closes: record it, trail or lock the max loss, update scaling, payout days and the live bonus
  private endDay() {
    const G = this.cfg, s = this.s, A = this.account, pnl = round2(A.balance - s.dayStart), r = this.rules();
    if (pnl) s.days[s.day!] = pnl;
    const e = A.equity(); if (e > s.eodPeak) s.eodPeak = e;
    if (!s.locked && s.eodPeak >= s.start + r.lockAt) { s.locked = true; this.log(`Max loss locked at ${money(s.start + G.lockPad)}.`, 'info'); }
    if (s.stage === 'funded') {
      if (pnl >= G.fDayMin && pnl > 0) s.cycle++;
      const was = this.tier(); s.tierProfit = A.balance - s.start;
      const n = this.tier();
      if (n !== was) this.log(`Contract limit is now ${n} mini${n === 1 ? '' : 's'}${G.unit === 'micro' ? ` (${n * 10} micros)` : ''}.`, 'info');
    }
    if (s.stage === 'live' && !s.bonusPaid && G.lBonus > 0 && A.balance - s.start + s.paid >= G.lBonusPt && Object.keys(s.days).length >= G.lBonusDays) {
      const net = Math.round(G.lBonus * G.split) / 100;
      s.bonusPaid = true; s.income += net; // the bonus is paid to you, not taken from the balance
      { const c = this.cur(); if (c) c.income += net; }
      s.payouts.push({ t: s.t, stage: 'live', n: 0, amount: G.lBonus, net, bonus: true });
      A.marks.push({ sym: '', t: s.t, side: 1, kind: 'payout', id: 0, net, bonus: true }); A.version++;
      this.log(`Live bonus released: ${money(G.lBonus)}, ${money(net)} to you after the split.`, 'payout', true);
    }
  }
  /** after every account tick: the day roll, the max loss, the daily loss limit and profit target, then (when the
   *  closed balance has moved and no trade is open) the pass check or an automatic payout */
  onTick(now: number) {
    const G = this.cfg, s = this.s, A = this.account, k = this.day(now);
    s.t = now;
    { const c = this.cur(); if (c && !c.from) c.from = now; }
    if (s.day !== k) { if (s.day != null) this.endDay(); s.day = k; s.dayStart = A.balance; s.lockedDay = ''; s.dptDay = false; s.checked = null; }
    if (s.over) return;
    const eq = A.equity(), floor = this.floor();
    if (eq <= floor + 1e-9) return this.breach(`Max loss: equity fell to ${money(eq)}, at or below the floor of ${money(floor)}.`);
    if (G.dll > 0 && !s.lockedDay && eq - s.dayStart <= -G.dll + 1e-9) {
      flatten(A, 'Daily loss limit');
      s.lockedDay = `daily loss limit, down ${money(s.dayStart - A.equity())}`;
      this.emit('lock', 'Daily loss limit hit. Positions closed and trading locked until the next trading day.', false, true); // not logged
    }
    // the evaluation's daily profit target: bank the day and stop, so no single day grows past the consistency rule
    if (s.stage === 'eval' && G.eDpt > 0 && !s.lockedDay && eq - s.dayStart >= G.eDpt - 1e-9) {
      flatten(A, 'Daily profit target');
      const up = A.balance - s.dayStart;
      s.lockedDay = `daily profit target reached, up ${money(up)} today`; s.dptDay = true; s.dptHits++;
      s.log.push({ t: s.t, text: `Daily profit target reached: up ${money(up)} today. Positions closed; trading resumes next trading day.` });
      this.emit('lock', `Daily profit target reached: up ${money(up)} today. Positions closed and trading paused until the next trading day.`, true, true);
    }
    // stage checks only when the closed balance has moved and no trade is open (working orders don't matter)
    if (s.checked === A.balance || A.trades.length) return;
    s.checked = A.balance;
    if (s.stage === 'eval' && this.progress().passed) {
      const p = A.balance - s.start;
      s.nPassed++;
      this.closeRec('passed', `${money(p)} profit`);
      this.newAccount('funded');
      this.log(`Evaluation passed with ${money(p)} profit. A funded ${money(G.size)} account is open.`, 'pass', true, true);
    } else if (s.stage === 'funded' && G.auto && this.payoutInfo().ok) this.payout();
  }
  /** why an order for `qty` on `sym` can't be placed, or null: checked before the order's own checks */
  check(sym: string, side: Side, qty: number) { return this.canOpen(addsOf(this.account, sym, side, qty)); }
  /** the same, given what the order adds to the position */
  canOpen(adds: number): string | null {
    const s = this.s, r = this.rules(), unit = this.cfg.unit === 'micro' ? 'micros' : 'minis', oq = this.openQty();
    if (s.over) return `This ${STAGES[s.stage].toLowerCase()} account has failed. Start a new evaluation from the Prop simulation card.`;
    if (s.lockedDay) return `Trading is locked until the next trading day: ${s.lockedDay}.`;
    if (r.max > 0 && oq + adds > r.max + 1e-9) return `That would make your position ${fmtQty(oq + adds)}, above the ${STAGES[s.stage].toLowerCase()} limit of ${fmtQty(r.max)} ${unit}.`;
    return null;
  }
  /** whether a bar ending at time t on a market with nothing open or working can be skipped without onTick calls: the
   *  same trading day, and no pass or payout check waiting (that check waits anyway while a trade is open elsewhere,
   *  and that market's own ticks run it) */
  canSkipBar(t: number) {
    const s = this.s, A = this.account;
    return s.day != null && this.day(t) === s.day && (!!s.over || s.checked === A.balance || A.trades.length > 0);
  }
  label() { return this.s.over ? `${STAGES[this.s.stage]} failed` : STAGES[this.s.stage]; }
  stats() { return simStats(this.s); }
  /** the stats page's rows */
  statRows(): Array<[string, string]> {
    const st = this.stats();
    return [['Payout income', money(this.s.income)], ['Payouts taken', String(st.nPay)], ['Average payout', st.nPay ? money(st.avgPay!) : '—'],
      ['Largest payout', st.nPay ? money(st.maxPay!) : '—'], ['Evaluation fees', money(this.s.fees)], ['Evaluations passed', `${st.passed} of ${st.attempts}`], ['Went live', String(st.live)]];
  }
  /** the line a strategy run prints at its end */
  summaryLine() {
    const s = this.s, st = this.stats();
    return `Prop simulation: ${s.attempt} evaluation${s.attempt > 1 ? 's' : ''} (${st.passed} passed, ${st.live} went live), ${money(s.fees)} in fees, ${st.nPay} payout${st.nPay === 1 ? '' : 's'}${st.nPay ? ` (average ${money(st.avgPay!)}, largest ${money(st.maxPay!)})` : ''}, ${money(s.income)} paid out to you: ${smoney(st.take)}. Account now: ${this.label()}.${s.dptHits ? ` The daily profit target stopped trading early on ${s.dptHits} evaluation day${s.dptHits > 1 ? 's' : ''}.` : ''}`;
  }
  view(): SimView {
    const G = this.cfg, s = this.s, A = this.account, r = this.rules(), eq = A.equity(), floor = this.floor(), profit = A.balance - s.start;
    const today = eq - s.dayStart, ev = this.progress(), pay = this.payoutInfo(), oq = this.openQty(), unit = G.unit === 'micro' ? 'micros' as const : 'minis' as const;
    const room = eq - floor, rows: PropRow[] = [], st = this.stats();
    const [status, statusKind] = (s.over ? ['Failed', 'neg'] : s.lockedDay ? (s.dptDay ? ['Target hit today', 'pos'] : ['Locked today', 'warn'])
      : [STAGES[s.stage], s.stage === 'eval' ? '' : 'pos']) as [string, SimView['statusKind']];
    const order: Stage[] = ['eval', 'funded', 'live'], at = order.indexOf(s.stage);
    const isEval = s.stage === 'eval', dptFrac = s.dptDay ? 1 : G.eDpt > 0 ? clamp(today / G.eDpt, 0, 1) : 0;
    const lp = profit + s.paid, nd = Object.keys(s.days).length, bonusFrac = s.bonusPaid ? 1 : G.lBonus > 0 ? clamp(Math.min(lp / G.lBonusPt, nd / Math.max(1, G.lBonusDays)) || 0, 0, 1) : 0;
    if (isEval) {
      rows.push(row('Profit target', `${smoney(ev.profit)} of ${money(G.ePt)}`, ev.profit / G.ePt, ev.ptOk ? 'ok' : '', ev.profit));
      if (G.eCons) rows.push(row('Consistency', ev.consPct == null ? `no profit yet · max ${G.eCons}%` : `best day ${ev.consPct.toFixed(1)}% · max ${G.eCons}%`, ev.consPct == null ? 0 : ev.consPct / G.eCons, ev.consPct != null && !ev.consOk ? 'bad' : ''));
      if (G.eMin) rows.push(row('Trading days', `${ev.nDays} of ${G.eMin}`, ev.nDays / G.eMin, ev.daysOk ? 'ok' : ''));
      if (G.eDpt > 0) rows.push(row('Daily profit target', s.dptDay ? `reached · ${smoney(today)} today` : `${smoney(today)} today · stop at ${money(G.eDpt)}`, s.dptDay ? 1 : today / G.eDpt, s.dptDay ? 'ok' : '', today));
    } else if (s.stage === 'funded') {
      rows.push(row('Profit', smoney(profit), null, '', profit));
      rows.push(row('Payout days this cycle', `${s.cycle} of ${G.fDays} · ${money(G.fDayMin)}+ each`, G.fDays ? s.cycle / G.fDays : 1, s.cycle >= G.fDays ? 'ok' : ''));
      rows.push(row('Next payout', pay.amount > 0 ? money(pay.amount) : '—'));
      rows.push(row('Payouts', `${s.nPay} of ${G.fPayouts} before live`, s.nPay / G.fPayouts, 'ok'));
    } else {
      rows.push(row('Live P&L (opened at $0)', smoney(profit), null, '', profit));
      if (G.lBonus > 0) rows.push(row('Live bonus', s.bonusPaid ? `released · ${money(G.lBonus)}` : `${smoney(lp)} of ${money(G.lBonusPt)} · ${nd} of ${G.lBonusDays} days`, bonusFrac, s.bonusPaid ? 'ok' : ''));
    }
    rows.push(row(`Max loss (EOD trailing${s.locked ? ', locked' : ''})`, `floor ${money(floor)} · ${money(Math.max(0, room))} left`, 1 - room / r.mll, room / r.mll < 0.3 ? 'bad' : ''));
    if (G.dll > 0) { const u = -today / G.dll; rows.push(row('Daily loss', `${smoney(today)} today · limit ${money(G.dll)}`, u, u > 0.7 ? 'bad' : '', today)); }
    if (r.max > 0) rows.push(row('Position size', `${fmtQty(oq)} of ${fmtQty(r.max)} ${unit}`, oq / r.max));
    const action: SimView['action'] = s.over ? { kind: 'restart', label: `Start a new evaluation${G.fee ? ` (${money(G.fee)})` : ''}`, enabled: true, hint: '', amount: null }
      : s.stage === 'funded' ? { kind: 'payout', label: `Request payout${pay.amount > 0 ? ' ' + money(pay.amount) : ''}`, enabled: pay.ok, hint: pay.ok ? '' : `Payout not available yet: ${pay.why}.`, amount: pay.amount }
      : s.stage === 'live' ? { kind: 'payoutAmount', label: 'Request payout', enabled: pay.ok, hint: pay.ok ? `Up to ${money(pay.max)} today.` : `Payout not available yet: ${pay.why}.`, amount: pay.ok ? Math.floor(pay.amount) : null }
      : null;
    const summary: Array<[string, string]> = [['Evaluations', String(s.attempt)], ['Passed', `${st.passed}${s.attempt ? ` (${Math.round(st.passRate!)}%)` : ''}`],
      ['Went live', String(st.live)], ['Fees paid', money(s.fees)], ['Payouts', String(st.nPay)],
      ...(st.nPay ? [['Average payout', money(st.avgPay!)], ['Largest payout', money(st.maxPay!)]] as Array<[string, string]> : []),
      ['Payout income', money(s.income)], ['Income less fees', smoney(s.income - s.fees)]];
    return {
      stage: s.stage, stageName: STAGES[s.stage], label: this.label(), status, statusKind,
      track: order.map((x, i) => ({ name: STAGES[x], state: i < at ? 'done' : i === at ? 'on' : '' })),
      over: s.over, lockedDay: s.lockedDay, balance: A.balance, equity: eq, start: s.start, profit, today,
      floor, room, mll: r.mll, mllLocked: s.locked, mllUsed: clamp(1 - room / r.mll, 0, 1), dll: G.dll, dllUsed: G.dll > 0 ? clamp(-today / G.dll, 0, 1) : 0,
      target: isEval ? G.ePt : 0, targetFrac: isEval ? clamp(ev.profit / G.ePt || 0, 0, 1) : 0, ptOk: ev.ptOk, consPct: ev.consPct, cons: G.eCons, consOk: ev.consOk,
      nDays: ev.nDays, minDays: G.eMin, daysOk: ev.daysOk, dpt: isEval ? G.eDpt : 0, dptDay: s.dptDay, dptFrac: isEval ? dptFrac : 0,
      cycle: s.cycle, fDays: G.fDays, cycleFrac: G.fDays ? clamp(s.cycle / G.fDays, 0, 1) : 1, nPay: s.nPay, fPayouts: G.fPayouts, payoutsFrac: clamp(s.nPay / G.fPayouts || 0, 0, 1),
      bonus: G.lBonus, bonusPaid: s.bonusPaid, bonusProfit: lp, bonusDays: nd, bonusFrac,
      maxSize: r.max, unit, openQty: oq, payout: pay, income: s.income, fees: s.fees, take: s.income - s.fees,
      action, rows, summary, log: s.log.slice(-5).reverse(),
    };
  }
  state(): PropState { return clone(this.s); }
  load(s: PropState) { this.s = normSim(s, this.cfg); }
}

/* ---------------- the prop simulation in a strategy run (the runner's hook points) ---------------- */
export interface SimRun { sim: PropSim | null; cfg: PropConfig }
/** rules for runBacktest: a fresh prop simulation on the run's account; a failed account buys a new evaluation when
 * rebuy is on (up to maxEvals, 0 = no limit), else the run ends there */
export function simRules(c: PropConfig, rebuy: boolean, maxEvals: number, out: SimRun): RunRules {
  let sim: PropSim, acc: Account;
  const cfg = simConfig({ ...c, on: true, auto: true }); // nobody is there to ask for payouts in a run
  out.cfg = cfg;
  return {
    start(a, log) {
      acc = a; sim = new PropSim(cfg, a, { resetHour: cfg.resetNY }); out.sim = sim;
      if (log) sim.onEvent = e => log(e.text, e.up === false ? 'er' : e.up ? 'ok' : 'pr');
    },
    idle: t1 => sim.canSkipBar(t1),
    afterTick() {
      sim.onTick(acc.quote('').time);
      const r = sim.rebuy(rebuy, maxEvals);
      return !r ? null : r.restarted ? { restarted: r.text } : r.text;
    },
    block: adds => sim.canOpen(adds),
  };
}

/* ---------------- the plain prop rules (legacy) ---------------- */
export interface RulesConfig {
  on: boolean;
  /** profit target on closed P&L (0 = none, and then it never passes) */
  pt: number;
  /** daily loss limit (0 = off): 'lock' closes everything and locks the day, 'fail' fails the evaluation */
  dll: number; dllAct: 'lock' | 'fail';
  /** max loss (0 = off): from the start balance, the highest equity (trailing) or the highest end-of-day equity */
  mll: number; mllType: 'static' | 'trailing' | 'eod';
  /** a trailing floor never goes above the start balance */
  mllLock: boolean;
  /** consistency: best day max % of the days' total (0 = off); minimum trading days; max open size (0 = off) */
  cons: number; minDays: number; maxSize: number;
  /** the trading day starts at this hour, New York time */
  resetNY: number;
  /** 'HH:MM' in the chart time zone: be flat from then until the next trading day ('' = off) */
  flatBy: string;
}
export const PROP_DEF: RulesConfig = { on: false, pt: 0, dll: 0, dllAct: 'lock', mll: 0, mllType: 'static', mllLock: true, cons: 0, minDays: 0, maxSize: 0, resetNY: 18, flatBy: '' };
/** older settings kept the hour in the chart time zone ('reset', default 0 = local midnight): the untouched default
 *  becomes 18:00 New York; an hour someone chose (or a saved session's, `faithful`) keeps meaning the same moment */
export function migrateReset<P extends { resetNY?: number; reset?: number }>(p: P | null | undefined, faithful: boolean, t = Date.now() / 1000, zoneOff = chartZoneOff): P {
  if (!p || p.resetNY != null) return p || ({} as P);
  const r = +(p.reset || 0) || 0;
  if (!r && !faithful) p.resetNY = 18;
  else p.resetNY = ((Math.round(r - zoneOff(t) / 3600 + nyOff(t) / 3600) % 24) + 24) % 24;
  delete p.reset; return p;
}
/** saved plain-rules settings with the defaults filled in */
export const rulesConfig = (saved?: Partial<RulesConfig> & { reset?: number } | null, faithful = false, t?: number): RulesConfig =>
  ({ ...PROP_DEF, ...migrateReset(saved ? { ...saved } : null, faithful, t) });

export interface RulesState {
  day: number | null; dayStart: number;
  /** the highest equity on any tick, and at any day's end */
  peak: number; eodPeak: number;
  failed: boolean; reason: string;
  /** why trading is locked for the rest of the day, or '' */
  locked: string;
  /** trading day -> net of the trades closed that day; days with any fill */
  days: Record<string, number>; tdays: Record<string, number>;
  passedAt: number | null;
  /** the last tick's time; how many of account.hist and account.marks are counted into days and tdays */
  t: number; nh: number; nm: number;
}
export interface RulesView {
  status: string; statusKind: 'neg' | 'pos' | 'warn' | '';
  failed: boolean; reason: string; passed: boolean; locked: string; pastFlatBy: boolean;
  equity: number; closed: number; today: number;
  target: number; targetFrac: number; ptOk: boolean;
  dll: number; dllUsed: number;
  mll: number; floor: number | null; room: number | null; mllUsed: number;
  cons: number; consPct: number | null; consOk: boolean;
  nDays: number; minDays: number; daysOk: boolean;
  maxSize: number; openQty: number; flatBy: string;
  rows: PropRow[];
}

export class PropRules implements PropEngine {
  readonly kind = 'rules';
  cfg: RulesConfig;
  readonly account: Account;
  s: RulesState;
  onEvent?: (e: PropEvent) => void;
  private hour: number;
  private zoneOff: (t: number) => number;
  // what the last pass check saw (kept out of the saved state)
  private memo: { s: RulesState | null; m: number; b: number; c: RulesConfig | null } = { s: null, m: -1, b: NaN, c: null };

  constructor(cfg: RulesConfig, account: Account, opts: PropOpts<RulesState> = {}) {
    this.cfg = cfg; this.account = account;
    this.hour = opts.resetHour ?? cfg.resetNY ?? 18; this.zoneOff = opts.zoneOff || chartZoneOff;
    const st = account.balance;
    this.s = { day: null, dayStart: st, peak: st, eodPeak: st, failed: false, reason: '', locked: '', days: {}, tdays: {}, passedAt: null, t: 0, nh: account.hist.length, nm: account.marks.length };
    if (opts.state) this.load(opts.state);
  }
  day(t: number) { return tradingDay(t, this.hour); }
  openQty() { return openQtyOf(this.account); }
  /** inside the flat-by window: from the flat-by time (chart zone) to the next trading day's start */
  inFlat(t: number) {
    const P = this.cfg; if (!P.flatBy) return false;
    const [h, m] = P.flatBy.split(':').map(Number), f = h * 60 + m, zo = this.zoneOff(t);
    const r = ((Math.round(this.hour * 60 - nyOff(t) / 60 + zo / 60) % 1440) + 1440) % 1440; // the day start, in chart time
    const tod = Math.floor(((((t + zo) % 86400) + 86400) % 86400) / 60);
    if (f === r) return false;
    return f < r ? (tod >= f && tod < r) : (tod >= f || tod < r);
  }
  floor() {
    const P = this.cfg, s = this.s, start = this.account.start;
    if (P.mllType === 'static') return start - P.mll;
    const f = (P.mllType === 'eod' ? s.eodPeak : s.peak) - P.mll;
    return P.mllLock ? Math.min(f, start) : f;
  }
  // closed trades and fills into the per-day books (written as trades close)
  private book() {
    const s = this.s, A = this.account;
    if (s.nh > A.hist.length) s.nh = A.hist.length;
    if (s.nm > A.marks.length) s.nm = A.marks.length;
    for (; s.nh < A.hist.length; s.nh++) { const c = A.hist[s.nh], k = this.day(c.exitTime); s.days[k] = (s.days[k] || 0) + c.net; s.tdays[k] = 1; }
    for (; s.nm < A.marks.length; s.nm++) { const m = A.marks[s.nm]; if (m.kind === 'in') s.tdays[this.day(m.t)] = 1; }
  }
  progress() {
    const P = this.cfg, s = this.s, A = this.account, eq = A.equity(), closed = A.balance - A.start;
    this.book();
    const vals = Object.values(s.days), total = vals.reduce((a, b) => a + b, 0), best = Math.max(0, ...vals);
    const consPct = total > 0 ? best / total * 100 : null, nDays = Object.keys(s.tdays).length;
    const consOk = !P.cons || (consPct != null && consPct <= P.cons), ptOk = P.pt > 0 && closed >= P.pt, daysOk = nDays >= (P.minDays || 0);
    return { eq, closed, best, consPct, consOk, nDays, daysOk, ptOk, today: s.day != null ? eq - s.dayStart : 0,
      floor: P.mll > 0 ? this.floor() : null, openQty: this.openQty(), passed: !s.failed && ptOk && daysOk && consOk };
  }
  private emit(kind: PropEvent['kind'], text: string, up?: boolean, pause?: boolean) {
    this.onEvent?.({ kind, text, ...(up != null ? { up } : {}), ...(pause ? { pause } : {}) });
  }
  private fail(reason: string) {
    const s = this.s; s.failed = true; s.reason = reason;
    flatten(this.account, 'Rule breach');
    this.emit('fail', 'Evaluation failed. ' + reason, false, true);
  }
  /** after every account tick: day rollover, loss limits, the flat-by time and the pass check */
  onTick(now: number) {
    const P = this.cfg, s = this.s, A = this.account, k = this.day(now);
    s.t = now; this.book();
    if (s.day !== k) {
      if (s.day != null) { const e = A.equity(); if (e > s.eodPeak) s.eodPeak = e; }
      s.day = k; s.dayStart = A.balance; s.locked = '';
    }
    if (s.failed) return;
    const eq = A.equity();
    if (eq > s.peak) s.peak = eq;
    if (P.mll > 0 && eq <= this.floor() + 1e-9) return this.fail(`Max loss limit: equity fell to ${money(eq)}, below the floor of ${money(this.floor())}.`);
    if (P.dll > 0 && !s.locked && eq - s.dayStart <= -P.dll + 1e-9) {
      if (P.dllAct === 'fail') return this.fail(`Daily loss limit: down ${money(s.dayStart - eq)} today.`);
      flatten(A, 'Daily loss limit');
      s.locked = `daily loss limit hit, down ${money(s.dayStart - A.equity())}`;
      this.emit('lock', 'Daily loss limit hit. Positions closed and trading locked until the next trading day.', false, true);
    }
    if (P.flatBy && this.inFlat(now) && (A.trades.length || A.orders.length)) {
      flatten(A, 'Flat-by time');
      this.emit('info', `It is past the ${P.flatBy} flat-by time: positions closed and orders canceled.`);
    }
    // passing changes only with the settings, a fill or the balance: checked then, not on every tick
    const K = this.memo;
    if (!s.passedAt && (K.s !== s || K.m !== A.marks.length || K.b !== A.balance || K.c !== P)) {
      Object.assign(K, { s, m: A.marks.length, b: A.balance, c: P });
      if (this.progress().passed) { s.passedAt = now; this.emit('pass', 'Profit target reached with every rule met. Evaluation passed.', true, true); }
    }
  }
  check(sym: string, side: Side, qty: number) { return this.canOpen(addsOf(this.account, sym, side, qty)); }
  canOpen(adds: number): string | null {
    const P = this.cfg, s = this.s, oq = this.openQty();
    if (s.failed) return 'This evaluation has failed. Start a new session from Session settings to try again.';
    if (s.locked) return `Trading is locked until the next trading day: ${s.locked}.`;
    if (P.flatBy && this.inFlat(s.t)) return `New trades are blocked after the flat-by time (${P.flatBy}) until the next trading day.`;
    if (P.maxSize > 0 && oq + adds > P.maxSize + 1e-9) return `That would make your position ${fmtQty(oq + adds)}, above the max size of ${fmtQty(P.maxSize)}.`;
    return null;
  }
  /** a flat market's bar ending at t can be skipped: same trading day, and failed, passed or nothing new to check */
  canSkipBar(t: number) {
    const s = this.s, A = this.account, K = this.memo;
    return s.day != null && this.day(t) === s.day && (s.failed || s.passedAt != null || (K.s === s && K.m === A.marks.length && K.b === A.balance && K.c === this.cfg));
  }
  label() { return this.s.failed ? 'Failed' : this.progress().passed ? 'Passed' : 'Active'; }
  view(): RulesView {
    const P = this.cfg, s = this.s, ev = this.progress(), pastFlatBy = !!P.flatBy && this.inFlat(s.t), rows: PropRow[] = [];
    const [status, statusKind] = (s.failed ? ['Failed', 'neg'] : ev.passed ? ['Passed', 'pos'] : s.locked ? ['Locked today', 'warn']
      : pastFlatBy ? ['Past flat-by time', 'warn'] : ['In evaluation', '']) as [string, RulesView['statusKind']];
    const room = ev.floor != null ? ev.eq - ev.floor : null;
    if (P.pt > 0) rows.push(row('Profit target', `${smoney(ev.closed)} of ${money(P.pt)}`, ev.closed / P.pt, ev.ptOk ? 'ok' : '', ev.closed));
    if (P.dll > 0) { const u = -ev.today / P.dll; rows.push(row('Daily loss', `${smoney(ev.today)} today · limit ${money(P.dll)}`, u, u > 0.7 ? 'bad' : '', ev.today)); }
    if (P.mll > 0) rows.push(row(`Max loss (${{ static: 'static', trailing: 'trailing', eod: 'EOD trailing' }[P.mllType]})`, `floor ${money(ev.floor!)} · ${money(Math.max(0, room!))} left`, 1 - room! / P.mll, room! / P.mll < 0.3 ? 'bad' : ''));
    if (P.cons > 0) rows.push(row('Consistency', ev.consPct == null ? `no profit yet · max ${P.cons}%` : `best day ${ev.consPct.toFixed(1)}% · max ${P.cons}%`, ev.consPct == null ? 0 : ev.consPct / P.cons, ev.consPct != null && !ev.consOk ? 'bad' : ''));
    if (P.minDays > 0) rows.push(row('Trading days', `${ev.nDays} of ${P.minDays}`, ev.nDays / P.minDays, ev.daysOk ? 'ok' : ''));
    if (P.maxSize > 0) rows.push(row('Position size', `${fmtQty(ev.openQty)} of ${fmtQty(P.maxSize)}`, ev.openQty / P.maxSize));
    if (P.flatBy) rows.push(row('Flat by', P.flatBy)); // the screen adds the chart zone's abbreviation
    return {
      status, statusKind, failed: s.failed, reason: s.reason, passed: ev.passed, locked: s.locked, pastFlatBy,
      equity: ev.eq, closed: ev.closed, today: ev.today, target: P.pt, targetFrac: P.pt > 0 ? clamp(ev.closed / P.pt, 0, 1) : 0, ptOk: ev.ptOk,
      dll: P.dll, dllUsed: P.dll > 0 ? clamp(-ev.today / P.dll, 0, 1) : 0, mll: P.mll, floor: ev.floor, room, mllUsed: room != null ? clamp(1 - room / P.mll, 0, 1) : 0,
      cons: P.cons, consPct: ev.consPct, consOk: ev.consOk, nDays: ev.nDays, minDays: P.minDays, daysOk: ev.daysOk,
      maxSize: P.maxSize, openQty: ev.openQty, flatBy: P.flatBy, rows,
    };
  }
  state(): RulesState { this.book(); return clone(this.s); }
  load(x: RulesState) {
    const A = this.account;
    this.s = { ...this.s, ...clone(x), nh: x.nh ?? A.hist.length, nm: x.nm ?? A.marks.length, t: x.t ?? 0 };
  }
}

/** the engine a session runs: the simulation when it is on, else the plain rules when they are on, else none */
export function startProp(c: { sim?: Partial<PropConfig> | null; prop?: Partial<RulesConfig> | null }, account: Account,
  opts: { resetHour?: number; zoneOff?: (t: number) => number; state?: PropState | RulesState } = {}): PropSim | PropRules | null {
  if (c.sim && c.sim.on) return new PropSim(simConfig(c.sim), account, { ...opts, state: opts.state as PropState | undefined });
  if (c.prop && c.prop.on) return new PropRules({ ...PROP_DEF, ...c.prop }, account, { ...opts, state: opts.state as RulesState | undefined });
  return null;
}
