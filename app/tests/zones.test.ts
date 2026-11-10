// Chart studies (src/core/zones.ts, src/core/sessions-studies.ts): price zones match the classic app's algorithm on the
// same candles, grow candle by candle without looking ahead, and session opens land at each city's own hours.
//   npx tsx tests/zones.test.ts
import { practiceSeries } from '../src/core/practice';
import { Session } from '../src/core/session';
import { Feed } from '../src/core/feed';
import { parseTF, setZone, fmtHM } from '../src/core/time';
import { ZoneFinder, TfCandles, shownZones, zonePrefs, zoneLabel, type Bar, type Zone } from '../src/core/zones';
import { SESS_DEF, SESS_STD, cityTimeFor, nextOpen, normHM, sessPrefs, sessionAt, sessionRanges, sessionsVisible, type SessDef } from '../src/core/sessions-studies';
import { localToUtc } from '../src/core/time';

let passed = 0;
const check = (c: unknown, m: string) => { if (!c) throw new Error('FAILED: ' + m); passed++; };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/* ---- the classic app's price zones (app.ts zoneStep), verbatim but for the state object and the tick ---- */
function classicZones(cs: Bar[], z: { swing: number; minTicks: number }, mintick: number) {
  const Z = { zones: [] as any[], swH: null as any, swL: null as any };
  const addZone = (type: string, dir: number, top: number, bot: number, t0: number) => { Z.zones.push({ type, dir, top, bot, t0, t1: null }); };
  function zoneStep(cs: Bar[], k: number) {
    const c = cs[k], live = Z.zones.filter(q => q.t1 == null);
    for (const q of live) {
      const through = q.dir > 0 ? c.c < q.bot : c.c > q.top;
      if ((q.type === 'fvg' || q.type === 'ob') && through) Object.assign(q, { type: q.type === 'fvg' ? 'ifvg' : 'bb', dir: -q.dir, flipT: c.time });
      else if (q.type === 'fvg') { if (q.dir > 0 ? c.l <= q.bot : c.h >= q.top) q.t1 = c.time; }
      else if (q.type !== 'ob' && through && q.flipT !== c.time) q.t1 = c.time;
    }
    if (k >= 2) {
      const a = cs[k - 2], min = (z.minTicks || 0) * mintick + 1e-9;
      let dir = 0, top = 0, bot = 0;
      if (c.l - a.h > min) { dir = 1; top = c.l; bot = a.h; } else if (a.l - c.h > min) { dir = -1; top = a.l; bot = c.h; }
      if (dir) {
        const t0 = cs[k - 1].time;
        for (let i = Z.zones.length - 1; i >= 0; i--) {
          const q = Z.zones[i];
          const open = (q.type === 'fvg' && q.dir === -dir && (q.t1 == null || q.t1 === c.time)) || (q.type === 'ifvg' && q.flipT === c.time && q.dir === dir);
          if (!open) continue;
          const hi = Math.min(q.top, top), lo = Math.max(q.bot, bot);
          if (hi > lo) { addZone('bpr', dir, hi, lo, t0); break; }
        }
        addZone('fvg', dir, top, bot, t0);
      }
    }
    const L = z.swing, j = k - L;
    if (j >= L) {
      let hi = true, lo = true;
      for (let m = j - L; m <= j + L; m++) { if (m === j) continue; if (cs[m].h >= cs[j].h) hi = false; if (cs[m].l <= cs[j].l) lo = false; }
      if (hi) Z.swH = { p: cs[j].h, i: j };
      if (lo) Z.swL = { p: cs[j].l, i: j };
    }
    if (Z.swH && c.c > Z.swH.p) {
      let m = Z.swH.i; for (let n = Z.swH.i; n < k; n++) if (cs[n].l < cs[m].l) m = n;
      addZone('ob', 1, cs[m].h, cs[m].l, cs[m].time); Z.swH = null;
    }
    if (Z.swL && c.c < Z.swL.p) {
      let m = Z.swL.i; for (let n = Z.swL.i; n < k; n++) if (cs[n].h > cs[m].h) m = n;
      addZone('ob', -1, cs[m].h, cs[m].l, cs[m].time); Z.swL = null;
    }
    if (Z.zones.length > 600) { let drop = 200; Z.zones = Z.zones.filter(q => !(q.t1 != null && drop-- > 0)); }
  }
  for (let k = 0; k < cs.length; k++) zoneStep(cs, k);
  return Z.zones as Zone[];
}
const run = (cs: Bar[], swing: number, minMove: number) => { const f = new ZoneFinder(swing, minMove); f.update(cs); return f.zones; };

const t0 = Date.UTC(2026, 2, 2) / 1000, t1 = Date.UTC(2026, 2, 21) / 1000;
const [nq] = await practiceSeries(['NQ'], t0, t1);
const tick = nq.inst.tick;
const at = Date.UTC(2026, 2, 9, 13, 30) / 1000;

/* ---- the same zones as the classic app, on 1m and 5m candles, with several settings ---- */
for (const tf of ['1m', '5m', '15m']) {
  const F = new Feed(nq, nq.n, parseTF(tf)!), cs = F.candles;
  check(cs.length > 1000, `${tf}: candles to test on (${cs.length})`);
  for (const [swing, minTicks] of [[3, 0], [1, 0], [5, 4], [20, 1000]]) {
    const ours = run(cs, swing, minTicks * tick), theirs = classicZones(cs, { swing, minTicks }, tick);
    check(ours.length === theirs.length && same(ours, theirs), `${tf} swing ${swing} min ${minTicks}: same zones as the classic app (${ours.length} vs ${theirs.length})`);
  }
  const zs = run(cs, 3, 0), kinds = new Set(zs.map(q => q.type));
  console.log(`${tf}: ${cs.length} candles, ${zs.length} zones:`, ['fvg', 'ifvg', 'bpr', 'ob', 'bb'].map(k => `${k} ${zs.filter(q => q.type === k).length}`).join(', '));
  check(['fvg', 'ifvg', 'bpr', 'ob', 'bb'].every(k => kinds.has(k as Zone['type'])), `${tf}: every kind of zone found`);
  check(zs.length <= 600, 'the list stays bounded');
  check(zs.every(q => q.top > q.bot && (q.t1 == null || q.t1 >= q.t0)), 'zones are well formed');
}
// a huge minimum leaves no FVGs (nor BPRs), order blocks still form
{
  const cs = new Feed(nq, nq.n, parseTF('5m')!).candles, zs = run(cs, 3, 1e6);
  check(!zs.some(q => q.type === 'fvg' || q.type === 'ifvg' || q.type === 'bpr') && zs.some(q => q.type === 'ob' || q.type === 'bb'), 'smallest FVG filters gaps only');
}

/* ---- during a replay: zones grow as candles close, from closed candles only, as if computed fresh each time ---- */
{
  const S = new Session({ name: 'z', markets: [nq], start: at, tf: parseTF('5m')!, balance: 50000 });
  const f = S.feeds[0], zf = new ZoneFinder(3, 0);
  zf.update(f.candles);
  let checks = 0, grew = 0;
  for (let k = 1; k <= 60; k++) {
    const n0 = zf.n;
    S.advanceTo(at + k * 397); // not on candle boundaries: a candle is forming at each check
    zf.update(f.candles);
    if (zf.n > n0) grew++;
    const last = f.candles[f.candles.length - 1].time;
    // nothing from the forming candle, nor from any bar after it
    check(zf.n === f.candles.length && f.F && f.F.time > last, 'only closed candles are used');
    check(zf.zones.every(q => q.t0 <= last && (q.t1 == null || q.t1 <= last) && (q.flipT == null || q.flipT <= last)), 'no zone uses a candle that has not closed');
    if (k % 10 === 0) { check(same(zf.zones, classicZones(f.candles, { swing: 3, minTicks: 0 }, tick)), `step ${k}: same as computing from scratch (classic)`); checks++; }
  }
  check(grew > 40 && checks === 6, `zones updated as candles closed (${grew} times)`);
  // a step back rebuilds the candles; computing again from them matches
  S.stepBack();
  const again = new ZoneFinder(3, 0); again.update(f.candles);
  check(same(again.zones, classicZones(f.candles, { swing: 3, minTicks: 0 }, tick)), 'after a step back');
}

/* ---- zones of another timeframe: candles built from the bars already played, the forming one held back ---- */
{
  const S = new Session({ name: 'z', markets: [nq], start: at, tf: parseTF('1m')!, balance: 50000 });
  S.advanceTo(at + 3 * 3600 + 450);
  const f = S.feeds[0], agg = new TfCandles(f.s, parseTF('15m')!, f.i);
  const cs = agg.advance(f.i);
  const ref = new Feed(nq, f.i, parseTF('15m')!).candles; // the same bars at 15 minutes
  const k0 = ref.findIndex(c => c.time === cs[0].time);
  check(cs.length > 100 && k0 >= 0, `15m candles from 1m play (${cs.length})`);
  check(same(cs.map(c => [c.time, c.o, c.h, c.l, c.c]), ref.slice(k0).map(c => [c.time, c.o, c.h, c.l, c.c])), '15m candles match the bars, without the forming one');
  check(cs[cs.length - 1].time + 900 <= f.time, 'the last 15m candle has closed');
  // grows with the replay, one bar at a time
  const n = cs.length; S.advanceTo(at + 3 * 3600 + 450 + 1800);
  check(agg.advance(f.i).length === n + 2, '15m candles added as they close');
}

/* ---- what is drawn: the newest few of each kind, finished ones hidden or not ---- */
{
  const zs = run(new Feed(nq, nq.n, parseTF('5m')!).candles, 3, 0);
  const z = zonePrefs({ max: 3 });
  const sh = shownZones(zs, z);
  check(['fvg', 'ifvg', 'bpr', 'ob', 'bb'].every(k => sh.filter(q => q.type === k).length <= 3) && sh.every(q => q.t1 == null), 'at most 3 of each kind, none finished');
  const live = (k: string) => zs.filter(q => q.type === k && q.t1 == null);
  check(same(sh.filter(q => q.type === 'fvg'), live('fvg').slice(-3).reverse()), 'the newest ones, newest first');
  const all = shownZones(zs, zonePrefs({ max: 50, hideDone: false }));
  check(all.some(q => q.t1 != null), 'finished zones shown when asked');
  check(!shownZones(zs, zonePrefs({ fvg: { on: false, up: '#000000', dn: '#000000' } })).some(q => q.type === 'fvg'), 'a kind turned off is not drawn');
  check(zoneLabel({ type: 'ifvg', dir: -1, top: 2, bot: 1, t0: 0, t1: null }, '15m ') === '15m ▼ iFVG', 'label');
  const d = zonePrefs();
  check(!d.on && !d.added && d.tf === 'chart' && d.max === 8 && d.swing === 3 && d.minTicks === 0 && d.hideDone && d.labels && d.bpr.up === '#e2a63c', 'classic defaults');
  check(zonePrefs({ max: 500, swing: 0, minTicks: -3 }).max === 50 && zonePrefs({ swing: 99 }).swing === 20 && zonePrefs({ minTicks: -3 }).minTicks === 0, 'settings kept in range');
}

/* ---- session opens ---- */
{
  const H = (s: number) => new Date(s * 1000).toISOString().slice(0, 16);
  const sp = sessPrefs();
  check(sp.sessions.length === 4 && sp.sessions.every(s => s.on) && !sp.shade && sp.labels, 'classic defaults: four cities, exchange hours');
  // Wednesday 1 April 2026: Sydney still on daylight time (UTC+11), London BST, New York EDT
  const day0 = Date.UTC(2026, 3, 1) / 1000, r = sessionRanges(sp.sessions, day0, day0 + 86400 - 1);
  const get = (name: string) => r.filter(x => x.s.name === name).map(x => `${H(x.o)}-${H(x.c)}`);
  check(get('New York').includes('2026-04-01T13:30-2026-04-01T20:00'), 'New York 09:30-16:00 EDT');
  check(get('London').includes('2026-04-01T07:00-2026-04-01T15:30'), 'London 08:00-16:30 BST');
  check(get('Tokyo').includes('2026-04-01T00:00-2026-04-01T06:30'), 'Tokyo 09:00-15:30 JST');
  check(get('Sydney').includes('2026-03-31T23:00-2026-04-01T05:00'), 'Sydney 10:00-16:00 AEDT');
  // each city's own daylight saving: between the US and UK changes, London opens at 04:00 New York, not 03:00
  const mar = sessionRanges(sp.sessions, Date.UTC(2026, 2, 27) / 1000, Date.UTC(2026, 2, 27, 23) / 1000).find(x => x.s.name === 'London')!;
  check(H(mar.o) === '2026-03-27T08:00', 'London 08:00 GMT before the UK clocks change');
  // no opens on the city's Saturday or Sunday
  const wk = sessionRanges(sp.sessions, Date.UTC(2026, 3, 4, 6) / 1000, Date.UTC(2026, 3, 5, 12) / 1000);
  check(!wk.length, `none on the weekend (${wk.map(x => x.s.name + ' ' + H(x.o))})`);
  check(!sessionRanges(sp.sessions.map(s => ({ ...s, on: false })), day0, day0 + 86400).length, 'sessions turned off are not drawn');
  // the classic drawing loop (drawSessions), over a week: the same opens and closes
  const classic = (list: SessDef[], t0: number, t1: number) => {
    const out: string[] = [];
    for (let day = Math.floor(t0 / 86400) - 1; day <= Math.floor(t1 / 86400) + 1; day++) {
      const dt = new Date(day * 86400000), wd = dt.getUTCDay(); if (wd === 0 || wd === 6) continue;
      for (const s of list.filter(s => s.on && s.open)) {
        const [oh, om] = s.open.split(':').map(Number), o = localToUtc(s.tz, dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate(), oh, om);
        let c = o; if (s.close) { const [ch, cm] = s.close.split(':').map(Number); c = localToUtc(s.tz, dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate(), ch, cm); if (c <= o) c += 86400; }
        if (c < t0 || o > t1) continue; out.push(`${s.name} ${o} ${c}`);
      }
    }
    return out;
  };
  const fx = SESS_DEF.map(s => ({ ...s, open: SESS_STD.forex.hours[s.name][0], close: SESS_STD.forex.hours[s.name][1] }));
  for (const list of [sp.sessions, fx, [{ ...SESS_DEF[3], open: '18:00', close: '17:00' }]]) {
    const a = Date.UTC(2026, 2, 5) / 1000, b = Date.UTC(2026, 3, 9) / 1000;
    check(same(sessionRanges(list, a, b).map(x => `${x.s.name} ${x.o} ${x.c}`), classic(list, a, b)), 'same sessions as the classic app over five weeks (DST changes included)');
  }
  const ov = sessionRanges([{ ...SESS_DEF[3], open: '18:00', close: '17:00' }], day0, day0 + 86400)[0];
  check(ov.c - ov.o === 23 * 3600, 'a session past midnight closes the next day');
  check(sessionsVisible(300, 0, 86400 * 30) && !sessionsVisible(86400, 0, 86400) && !sessionsVisible(300, 0, 86400 * 91), 'below daily candles, 90 days at most');
  // next open and typing a time in the chart zone (New York): kept in the city's own clock
  setZone('America/New_York');
  const ny = sp.sessions[3], lon = sp.sessions[2];
  check(H(nextOpen(ny, Date.UTC(2026, 3, 3, 14) / 1000)) === '2026-04-06T13:30', 'the next New York open after Friday is Monday');
  const occ = sessionAt(lon, Date.UTC(2026, 3, 1, 12) / 1000 - 86400)!;
  check(fmtHM(occ[0]) === '03:00' && fmtHM(occ[1]) === '11:30', `London shown in New York time (${fmtHM(occ[0])}-${fmtHM(occ[1])})`);
  check(cityTimeFor(lon, 'open', '02:30', Date.UTC(2026, 3, 1, 12) / 1000) === '07:30', 'typed 02:30 New York = 07:30 London');
  check(normHM('8:30') === '08:30' && normHM('0915') === '09:15' && normHM('25:00') === '' && normHM('x') === '', 'times typed as HH:MM');
}

console.log(`zones: ${passed} checks passed`);
