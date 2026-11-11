// Reading data files: the continuous series of a Databento CSV whose contract symbols come round again every ten years
// (NQH0 is March 2010 and March 2020). Run with: npx tsx tests/data.test.ts
import { readSource, rollMap, cacheKey, type Source } from '../src/core/data';

let passed = 0;
const check = (ok: unknown, what: string) => { if (!ok) throw new Error('FAILED: ' + what); passed++; };

// quarterly contracts, each busiest from about a week before the previous one expires, 2009-09 to 2021-03, one bar a
// weekday at 14:30 UTC per live contract (the front one with the volume)
const code = 'HMUZ', rows: string[] = ['ts_event,rtype,publisher_id,instrument_id,open,high,low,close,volume,symbol'];
const qStart = (y: number, q: number) => Date.UTC(y, q * 3 - 1, 12);   // the contract for quarter q takes over mid-month before
let px = 1500;
for (let y = 2009; y <= 2021; y++) for (let q = 0; q < 4; q++) {
  const from = qStart(y, q), to = q === 3 ? qStart(y + 1, 0) : qStart(y, q + 1);
  if (from < Date.UTC(2009, 8, 1) || from > Date.UTC(2021, 2, 1)) continue;
  const sym = `NQ${code[q]}${y % 10}`, next = `NQ${code[(q + 1) % 4]}${(q === 3 ? y + 1 : y) % 10}`;
  for (let t = from; t < to; t += 864e5) {
    const wd = new Date(t).getUTCDay(); if (wd === 0 || wd === 6) continue;
    px += 1; const ts = new Date(t + 14.5 * 3600e3).toISOString().replace('.000Z', '.000000000Z');
    rows.push(`${ts},33,1,1,${px},${px + 2},${px - 2},${px + 1},5000,${sym}`);
    rows.push(`${ts},33,1,2,${px},${px + 2},${px - 2},${px + 1},40,${next}`);   // the next contract, thin
  }
}
const text = rows.join('\n') + '\n', bytes = new TextEncoder().encode(text);
const src: Source = { kind: 'file', name: 'glbx-mdp3-test.ohlcv-1m.csv', size: bytes.length, async *bytes() { yield bytes.buffer.slice(0) as ArrayBuffer; } };

const r = await readSource(src, { pick: '*auto' });
check(!!r.C && r.C.list.some(x => x.sym === 'NQH0'), 'the census has the contracts');
const last = new Date(r.d.t[r.d.n - 1] * 1000).toISOString().slice(0, 10);
check(last >= '2021-02-26', `the continuous series runs to the end of the file, past the first reused symbol (last bar ${last})`);
check(r.d.n === rows.length / 2 - 1 || Math.abs(r.d.n - (rows.length - 1) / 2) <= 2, `one bar a day, from the busiest contract (${r.d.n} bars, ${(rows.length - 1) / 2} days)`);
check([...r.d.c].every((c, i) => i === 0 || c > r.d.c[i - 1]), 'never the thin next contract: prices only go up');
const map = rollMap(r.C!);
check(map.get('2010-02-01') === 'NQH0' && map.get('2020-02-03') === 'NQH0' && map.get('2020-04-01') === 'NQM0', 'NQH0 in 2010 and again in 2020, then NQM0');
check(map.get('2010-03-15') === 'NQM0' && map.get('2010-03-22') === 'NQM0', 'no going back to a contract just rolled off');
check(cacheKey('*auto') !== 'auto', 'continuous copies kept before the fix are read again');
console.log(`data: ${passed} checks passed`);
