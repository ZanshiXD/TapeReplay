// Reading market data: CSV files of any layout and Databento DBN files, of any size, in chunks; the contracts a file
// holds and a continuous series that rolls to the busiest contract; a binary cache so a file reopens without being
// read again; and the futures contracts the app knows (point value, tick). Ported from the classic app, unchanged
// in what it reads and how.
import type { Instrument, Series } from './series';

/* ---- sources: a file in the browser, or a file the app holds ---- */
export interface Source { kind: string; id?: string; name: string; size: number; bytes(): AsyncGenerator<ArrayBuffer> }
export const CHUNK = 8 << 20;
export function fileSource(file: Blob & { name?: string }, name = file.name || 'data'): Source {
  return { kind: 'file', name, size: file.size, async *bytes() { for (let p = 0; p < file.size; p += CHUNK) yield await file.slice(p, p + CHUNK).arrayBuffer(); } };
}
/** a file the desktop or iOS app holds, read through its server in chunks */
export function blobSource(read: (start: number, len: number) => Promise<ArrayBuffer>, kind: string, id: string, size: number, name: string): Source {
  return { kind, id, name, size, async *bytes() { for (let p = 0; p < size; p += CHUNK) yield await read(p, CHUNK); } };
}

/* ---- dates ---- */
let isoKey = '', isoVal = 0;
export function parseDT(s: string, dmy = false): number {
  if (s.length >= 19 && s.charCodeAt(4) === 45 && s.charCodeAt(7) === 45 && (s.charCodeAt(10) === 84 || s.charCodeAt(10) === 32) && s.charCodeAt(13) === 58) {
    const tail = s.length === 19 ? '' : s.slice(19);
    if (tail === '' || tail === 'Z' || /^\.\d+Z?$/.test(tail)) {
      const day = s.slice(0, 10);
      if (day !== isoKey) { isoKey = day; isoVal = Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10)) / 1000; }
      return isoVal + (+s.slice(11, 13)) * 3600 + (+s.slice(14, 16)) * 60 + (+s.slice(17, 19));
    }
  }
  s = s.trim();
  let m = s.match(/^(\d{4})(\d{2})(\d{2})(?:[ T]?(\d{2})(\d{2})(\d{2})?)?$/);
  if (m && +m[1] >= 1900 && +m[1] <= 2200 && +m[2] >= 1 && +m[2] <= 12 && +m[3] >= 1 && +m[3] <= 31)
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)) / 1000;
  if (/^\d+(\.\d+)?$/.test(s)) {
    let n = parseFloat(s);
    if (n > 1e17) n /= 1e9; else if (n > 1e14) n /= 1e6; else if (n > 1e11) n /= 1e3;
    return Math.floor(n);
  }
  m = s.match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,]\d+)?)?)?\s*(Z|UTC|GMT|[+-]\d{2}:?\d{2})?$/i);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)) / 1000 - tzOff(m[7]);
  m = s.match(/^(\d{1,2})[-./](\d{1,2})[-./](\d{2,4})(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,]\d+)?)?\s*(AM|PM)?)?$/i);
  if (m) {
    let y = +m[3]; if (y < 100) y += 2000;
    const d = dmy ? +m[1] : +m[2], mo = dmy ? +m[2] : +m[1];
    let hh = +(m[4] || 0); const ap = (m[7] || '').toUpperCase();
    if (ap === 'PM' && hh < 12) hh += 12; if (ap === 'AM' && hh === 12) hh = 0;
    return Date.UTC(y, mo - 1, d, hh, +(m[5] || 0), +(m[6] || 0)) / 1000;
  }
  let ms = /([zZ]|[+-]\d{2}:?\d{2}|UTC|GMT)\s*$/.test(s) ? Date.parse(s) : Date.parse(s + ' UTC');
  if (!isFinite(ms)) ms = Date.parse(s);
  return isFinite(ms) ? Math.floor(ms / 1000) : NaN;
}
function tzOff(z?: string) {
  if (!z || /^(z|utc|gmt)$/i.test(z)) return 0;
  const m = z.match(/([+-])(\d{2}):?(\d{2})/)!;
  return (m[1] === '-' ? -1 : 1) * (+m[2] * 3600 + +m[3] * 60);
}
const normTime = (s: string) => /^\d{6}$/.test(s) ? s.slice(0, 2) + ':' + s.slice(2, 4) + ':' + s.slice(4) : /^\d{4}$/.test(s) ? s.slice(0, 2) + ':' + s.slice(2) : s;

/* ---- lines of text, never the whole file at once ---- */
function pickDecoder(b: Uint8Array) {
  if (b[0] === 0xFF && b[1] === 0xFE) return new TextDecoder('utf-16le');
  if (b[0] === 0xFE && b[1] === 0xFF) return new TextDecoder('utf-16be');
  if (b.length > 3 && b[1] === 0 && b[3] === 0) return new TextDecoder('utf-16le');
  try { new TextDecoder('utf-8', { fatal: true }).decode(b.subarray(0, 1 << 20), { stream: true }); return new TextDecoder('utf-8'); }
  catch { return new TextDecoder('windows-1252'); }
}
async function* lineBatches(src: Source, onProgress?: (f: number) => void) {
  let dec: TextDecoder | null = null, carry = '', done = 0;
  for await (const buf of src.bytes()) {
    const b = new Uint8Array(buf);
    if (!dec) dec = pickDecoder(b);
    done += b.length; onProgress?.(src.size ? done / src.size : 0);
    const parts = (carry + dec.decode(b, { stream: true })).split(/\r\n|\n|\r/);
    carry = parts.pop()!;
    yield parts;
  }
  const tail = carry + (dec ? dec.decode() : '');
  if (tail) yield [tail];
}

/* ---- CSV layout ---- */
export interface Head {
  dbn?: false; split: (l: string) => string[]; headLine: string | null;
  ix: { o: number; h: number; l: number; c: number; v: number; sym: number; dt?: number; date?: number; time?: number };
  getDT: (f: string[]) => string; dmy: boolean; num: (x: string) => number; scale: number;
}
export interface DbnHead { dbn: true; recStart: number; names: Map<number, string>; ix: { sym: number; v: number }; headLine: null }
type AnyHead = Head | DbnHead;

async function scanHead(src: Source): Promise<Head> {
  const sample: string[] = [];
  for await (const batch of lineBatches(src)) {
    for (const line of batch) { if (line.trim()) sample.push(line); if (sample.length > 3000) break; }
    if (sample.length > 3000) break;
  }
  if (!sample.length) throw new Error('The file is empty.');
  const first = sample[0];
  let delim: string | RegExp = ',', best = 0;
  for (const d of [',', ';', '\t', '|']) { const n = first.split(d).length; if (n > best) { best = n; delim = d; } }
  if (best < 5) {
    if (first.trim().split(/\s+/).length >= 5) delim = /\s+/;
    else throw new Error('Could not find the columns. Use a comma, semicolon or tab between values, with at least time, open, high, low and close.');
  }
  const unquote = (x: string) => x.trim().replace(/^"(.*)"$/, '$1').trim();
  const dl = delim;
  const split = dl instanceof RegExp ? (l: string) => l.trim().split(dl).map(unquote) : (l: string) => l.indexOf('"') < 0 ? l.split(dl) : l.split(dl).map(unquote);
  const head = split(first).map(x => x.trim());
  const nm = head.map(h => h.toLowerCase().replace(/[^a-z]/g, ''));
  const hasHeader = nm.some(n => /open|high|low|close|date|time|vol/.test(n) || /^[ohlcv]$/.test(n));
  let ix: Head['ix'];
  if (hasHeader) {
    const find = (re: RegExp) => nm.findIndex(n => re.test(n));
    const d = find(/^(date|day|tradedate|tradingday)$/), tm = find(/^(time|hour|timeofday)$/);
    ix = { o: find(/^(open|o|openprice|openbid|bidopen|openmid)$/), h: find(/^(high|h|highprice|highbid|bidhigh|highmid)$/),
      l: find(/^(low|l|lowprice|lowbid|bidlow|lowmid)$/), c: find(/^(close|c|closeprice|closebid|bidclose|closemid|last)$/),
      v: find(/^(volume|vol|v|tickvol|tickvolume|realvolume|basevolume|vols)$/), sym: -1 };
    for (const [k, re] of [['o', /open/], ['h', /high/], ['l', /low/], ['c', /close/]] as const) if (ix[k] < 0) ix[k] = find(re);
    if (ix.v < 0) ix.v = find(/vol/);
    if (d >= 0 && tm >= 0) { ix.date = d; ix.time = tm; }
    else {
      ix.dt = nm.indexOf('tsevent');
      if (ix.dt < 0) ix.dt = find(/^(datetime|timestamp|ts|t|unix|unixtime|epoch|opentime|gmttime|localtime|timeutc|datetimeutc|dateutc|timegmt|datetimegmt|tsrecv)$/);
      if (ix.dt < 0) ix.dt = d >= 0 ? d : tm >= 0 ? tm : find(/date|time/);
      if (ix.dt < 0) ix.dt = 0;
    }
    if ([ix.o, ix.h, ix.l, ix.c].some(x => x < 0)) throw new Error('Could not find Open, High, Low and Close columns. Header found: ' + head.join(', '));
    ix.sym = nm.findIndex(n => n === 'symbol' || n === 'ticker' || n === 'rawsymbol');
    if (ix.sym < 0) ix.sym = nm.indexOf('instrumentid');
  } else {
    const n = head.length;
    const timeIn1 = /^\d{1,2}:\d{2}(:\d{2})?$/.test(head[1]) || (/^\d{8}$/.test(head[0]) && /^\d{4,6}$/.test(head[1]) && n >= 6);
    ix = timeIn1 ? { date: 0, time: 1, o: 2, h: 3, l: 4, c: 5, v: n > 6 ? 6 : -1, sym: -1 } : { dt: 0, o: 1, h: 2, l: 3, c: 4, v: n > 5 ? 5 : -1, sym: -1 };
  }
  const getDT = (f: string[]) => ix.time != null ? f[ix.date!] + ' ' + normTime(f[ix.time]) : f[ix.dt!];
  const rows = sample.slice(hasHeader ? 1 : 0);
  let dmy = false;
  for (const r of rows) {
    const m = (getDT(split(r)) || '').trim().match(/^(\d{1,2})[-./](\d{1,2})[-./]\d{2,4}/);
    if (m) { if (+m[1] > 12) { dmy = true; break; } if (+m[2] > 12) break; }
  }
  const num = delim !== ',' ? (x: string) => parseFloat(x.replace(',', '.')) : (x: string) => parseFloat(x);
  let scale = 1;
  if (nm.includes('rtype') || nm.includes('tsevent')) {
    const cl = rows.slice(0, 200).map(r => num(split(r)[ix.c] || '')).filter(isFinite).sort((a, b) => a - b);
    if (cl.length && cl.every(Number.isInteger) && cl[cl.length >> 1] > 1e6) scale = 1e-9;
  }
  return { split, headLine: hasHeader ? first : null, ix, getDT, dmy, num, scale };
}

/* ---- contracts in a file, and the continuous roll ---- */
export interface Census { list: Array<{ sym: string; rows: number; vol: number }>; days: Map<string, Map<string, [number, number]>>; names?: Array<[number, string]> }
const isSpread = (s: string) => /[-:\s]/.test(s) && !/^\d+$/.test(s);
const dayOf = (H: Head, f: string[]) => { const s = H.getDT(f) || ''; return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : String(Math.floor(parseDT(s, H.dmy) / 86400)).padStart(8, '0'); };
async function census(src: Source, H: Head, onProgress?: (f: number) => void): Promise<Census> {
  const syms = new Map<string, { sym: string; rows: number; vol: number }>(), days = new Map<string, Map<string, [number, number]>>(), si = H.ix.sym, vi = H.ix.v;
  for await (const batch of lineBatches(src, onProgress)) for (const line of batch) {
    if (!line || line === H.headLine) continue;
    const f = H.split(line), s = f[si]; if (!s || f.length < 5) continue;
    const v = vi >= 0 ? (H.num(f[vi] || '') || 0) : 1;
    let e = syms.get(s); if (!e) syms.set(s, e = { sym: s, rows: 0, vol: 0 }); e.rows++; e.vol += v;
    const dk = dayOf(H, f); let m = days.get(dk); if (!m) days.set(dk, m = new Map());
    const c = m.get(s); if (c) { c[0] += v; c[1]++; } else m.set(s, [v, 1]);
  }
  return { list: [...syms.values()].sort((a, b) => b.vol - a.vol), days };
}
export const censusToJSON = (C: Census) => ({ list: C.list, days: Object.fromEntries([...C.days].map(([k, m]) => [k, Object.fromEntries(m)])), names: C.names });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const censusFromJSON = (j: any): Census => ({ list: j.list || [], days: new Map(Object.entries(j.days || {}).map(([k, o]) => [k, new Map(Object.entries(o as Record<string, [number, number]>))])), names: j.names });
/** each day follows the outright contract with the most volume, never rolling back to an older one */
export function rollMap(C: Census) {
  const map = new Map<string, string>(), left = new Set<string>(); let cur: string | null = null;
  for (const k of [...C.days.keys()].sort()) {
    let best: string | null = null, bv = -1;
    for (const [s, c] of C.days.get(k)!) if (!isSpread(s) && !left.has(s) && c[0] > bv) { best = s; bv = c[0]; }
    if (best && best !== cur) { if (cur) left.add(cur); cur = best; }
    if (cur) map.set(k, cur);
  }
  return map;
}
export const defaultPick = (C: Census | null) => !C || C.list.length < 2 ? '' : C.list.filter(x => !isSpread(x.sym)).length > 1 ? '*auto' : C.list[0].sym;
export const pickLabel = (p: string) => p === '*auto' ? 'continuous' : p;
export const cacheKey = (p: string) => p === '*auto' ? 'auto' : p ? p.replace(/[^A-Za-z0-9-]/g, '_').slice(0, 40) : 'all';
function decimalsOf(x: number) { for (let d = 0; d <= 8; d++) { const m = x * 10 ** d; if (Math.abs(m - Math.round(m)) < 1e-6) return d; } return 8; }
const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));

/** bars read from a file: the columns, the bar interval, the price precision */
export interface Parsed { n: number; t: Float64Array; o: Float32Array; h: Float32Array; l: Float32Array; c: Float32Array; v: Float32Array; base: number; prec: number; bad: number; hasVol: boolean }

async function parseAll(src: Source, H: Head, pick: string, C: Census | null, onProgress?: (f: number) => void): Promise<Parsed> {
  const roll = pick === '*auto' && C ? rollMap(C) : null, ix = H.ix, sc = H.scale;
  let exact = 0;
  if (C && pick) {
    if (roll) for (const [k, m] of C.days) { const c = m.get(roll.get(k)!); if (c) exact += c[1]; }
    else exact = (C.list.find(x => x.sym === pick) || { rows: 0 }).rows;
  }
  let cap = exact || Math.max(4096, Math.floor((src.size || 4e6) / 80));
  let t = new Float64Array(cap), o = new Float32Array(cap), h = new Float32Array(cap), l = new Float32Array(cap), c = new Float32Array(cap), v = new Float32Array(cap);
  const grow = () => {
    cap = Math.ceil(cap * 1.6);
    const g = <T extends Float64Array | Float32Array>(a: T, K: new (n: number) => T) => { const b = new K(cap); b.set(a); return b; };
    t = g(t, Float64Array); o = g(o, Float32Array); h = g(h, Float32Array); l = g(l, Float32Array); c = g(c, Float32Array); v = g(v, Float32Array);
  };
  let k = 0, bad = 0, dec = 0;
  for await (const batch of lineBatches(src, onProgress)) for (const line of batch) {
    if (!line || line === H.headLine) continue;
    const f = H.split(line);
    if (f.length < 5) { if (line.trim()) bad++; continue; }
    if (pick) { const s = f[ix.sym]; if (roll ? roll.get(dayOf(H, f)) !== s : s !== pick) continue; }
    const ts = parseDT(H.getDT(f) || '', H.dmy);
    let O = H.num(f[ix.o] || ''), Hh = H.num(f[ix.h] || ''), L = H.num(f[ix.l] || ''), Cc = H.num(f[ix.c] || '');
    if (!isFinite(ts) || !isFinite(O) || !isFinite(Hh) || !isFinite(L) || !isFinite(Cc)) { bad++; continue; }
    if (sc !== 1) { O *= sc; Hh *= sc; L *= sc; Cc *= sc; }
    if (k < 400) dec = Math.max(dec, decimalsOf(O), decimalsOf(Cc));
    if (k === cap) grow();
    t[k] = ts; o[k] = O; c[k] = Cc; h[k] = Math.max(Hh, O, Cc); l[k] = Math.min(L, O, Cc);
    v[k] = ix.v >= 0 ? (H.num(f[ix.v] || '') || 0) : 0;
    k++;
  }
  if (k < 2) throw new Error(pick ? `Found fewer than two bars for ${pickLabel(pick)}.` : 'Found fewer than two readable rows. Check that the file has a time column and Open, High, Low, Close values.');
  return finishSeries({ t, o, h, l, c, v }, k, { bad, prec: clamp(dec || 2, 0, 8), hasVol: ix.v >= 0 });
}
/** sorted by time, duplicate timestamps dropped (the last kept), the bar interval worked out */
export function finishSeries(a: { t: Float64Array; o: Float32Array; h: Float32Array; l: Float32Array; c: Float32Array; v: Float32Array }, k: number, info: { bad: number; prec: number; hasVol: boolean }): Parsed {
  let { t, o, h, l, c, v } = a;
  let sorted = true; for (let i = 1; i < k; i++) if (t[i] < t[i - 1]) { sorted = false; break; }
  if (!sorted) {
    const order = new Uint32Array(k).map((_, i) => i).sort((x, y) => t[x] - t[y]);
    const re = <T extends Float64Array | Float32Array>(arr: T, K: new (n: number) => T) => { const b = new K(k); for (let q = 0; q < k; q++) b[q] = arr[order[q]]; return b; };
    t = re(t, Float64Array); o = re(o, Float32Array); h = re(h, Float32Array); l = re(l, Float32Array); c = re(c, Float32Array); v = re(v, Float32Array);
  }
  let n = 0;
  for (let i = 0; i < k; i++) {
    if (n > 0 && t[n - 1] === t[i]) n--;
    t[n] = t[i]; o[n] = o[i]; h[n] = h[i]; l[n] = l[i]; c[n] = c[i]; v[n] = v[i]; n++;
  }
  const hist = new Map<number, number>();
  for (let i = 1; i < Math.min(n, 50000); i++) { const d = t[i] - t[i - 1]; if (d > 0) hist.set(d, (hist.get(d) || 0) + 1); }
  let base = 0, bc = 0; for (const [d, cnt] of hist) if (cnt > bc || (cnt === bc && d < base)) { base = d; bc = cnt; }
  if (!base) throw new Error('Could not work out the bar interval from the timestamps.');
  return { n, t: t.subarray(0, n), o: o.subarray(0, n), h: h.subarray(0, n), l: l.subarray(0, n), c: c.subarray(0, n), v: v.subarray(0, n), base, ...info } as Parsed;
}

/* ---- DBN (Databento binary encoding), versions 1 to 3 ---- */
const DBN_OHLCV = new Set([0x11, 0x20, 0x21, 0x22, 0x23, 0x24]);
export const isDbn = (b: Uint8Array) => b[0] === 0x44 && b[1] === 0x42 && b[2] === 0x4E;
function dbnCstr(b: Uint8Array, pos: number, len: number) { let e = pos; while (e < pos + len && b[e]) e++; return new TextDecoder().decode(b.subarray(pos, e)); }
function dbnMeta(b: Uint8Array, at: number, names: Map<number, string>) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const version = b[at + 3], len = dv.getUint32(at + 4, true), end = at + 8 + len;
  let p = at + 8 + 16 + 2 + 8 + 8 + 8;
  if (version === 1) p += 8;
  p += 3;
  let cl = 22;
  if (version >= 2) { cl = dv.getUint16(p, true); p += 2 + 53; } else p += 47;
  try {
    p += 4 + dv.getUint32(p, true);
    for (let i = 0; i < 3; i++) p += 4 + dv.getUint32(p, true) * cl;
    const raw2ids = new Map<string, Set<number>>(), nm = dv.getUint32(p, true); p += 4;
    for (let i = 0; i < nm && p < end; i++) {
      const raw = dbnCstr(b, p, cl); p += cl;
      const ni = dv.getUint32(p, true); p += 4;
      for (let j = 0; j < ni; j++) {
        p += 8; const sym = dbnCstr(b, p, cl); p += cl;
        if (/^\d+$/.test(sym)) { const s = raw2ids.get(raw) || new Set(); s.add(+sym); raw2ids.set(raw, s); }
        else if (/^\d+$/.test(raw)) names.set(+raw, sym);
      }
    }
    for (const [raw, ids] of raw2ids) for (const id of ids) if (!names.has(id)) names.set(id, ids.size === 1 ? raw : `${raw}#${id}`);
  } catch { /* symbol map unreadable: contracts are shown by instrument id */ }
  return end;
}
async function dbnHead(src: Source): Promise<DbnHead> {
  for await (const buf of src.bytes()) {
    const b = new Uint8Array(buf), names = new Map<number, string>();
    if (b[3] > 3) throw new Error(`This is DBN version ${b[3]}, which this app does not read yet.`);
    const recStart = dbnMeta(b, 0, names);
    return { dbn: true, recStart, names, ix: { sym: 0, v: 1 }, headLine: null };
  }
  throw new Error('The file is empty.');
}
async function dbnScan(src: Source, H: DbnHead, onProgress: ((f: number) => void) | undefined, fn: (dv: DataView, p: number, id: number, sec: number) => void) {
  let carry: Uint8Array | null = null, first = true, done = 0;
  for await (const chunk of src.bytes()) {
    let b = new Uint8Array(chunk); done += b.length; onProgress?.(src.size ? done / src.size : 0);
    if (carry && carry.length) { const m = new Uint8Array(carry.length + b.length); m.set(carry); m.set(b, carry.length); b = m; }
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength), end = b.length;
    let pos = first ? H.recStart : 0; first = false;
    while (pos < end) {
      if (isDbn(b.subarray(pos, pos + 3)) && pos + 8 <= end) {
        const need = pos + 8 + dv.getUint32(pos + 4, true); if (need > end) break;
        pos = dbnMeta(b, pos, H.names); continue;
      }
      const L = b[pos] * 4;
      if (L < 16) throw new Error('This DBN file looks damaged (a record has no length).');
      if (pos + L > end) break;
      if (DBN_OHLCV.has(b[pos + 1]) && L >= 56) {
        const ts = dv.getUint32(pos + 12, true) * 4294967296 + dv.getUint32(pos + 8, true);
        fn(dv, pos, dv.getUint32(pos + 4, true), Math.round(ts / 1e9));
      }
      pos += L;
    }
    carry = pos < end ? b.slice(pos) : null;
  }
}
const dbnPx = (dv: DataView, p: number) => (dv.getInt32(p + 4, true) * 4294967296 + dv.getUint32(p, true)) / 1e9;
const dbnName = (H: DbnHead, id: number) => H.names.get(id) || `ID ${id}`;
async function dbnCensus(src: Source, H: DbnHead, onProgress?: (f: number) => void): Promise<Census> {
  const ids = new Map<number, { rows: number; vol: number }>(), days = new Map<string, Map<number, [number, number]>>();
  await dbnScan(src, H, onProgress, (dv, p, id, sec) => {
    const vol = dv.getUint32(p + 52, true) * 4294967296 + dv.getUint32(p + 48, true);
    let e = ids.get(id); if (!e) ids.set(id, e = { rows: 0, vol: 0 }); e.rows++; e.vol += vol;
    const dk = String(Math.floor(sec / 86400)).padStart(8, '0');
    let m = days.get(dk); if (!m) days.set(dk, m = new Map());
    const c = m.get(id); if (c) { c[0] += vol; c[1]++; } else m.set(id, [vol, 1]);
  });
  const name = (id: number) => dbnName(H, id);
  return { list: [...ids].map(([id, e]) => ({ sym: name(id), rows: e.rows, vol: e.vol })).sort((a, b) => b.vol - a.vol),
    days: new Map([...days].map(([k, m]) => [k, new Map([...m].map(([id, c]) => [name(id), c] as [string, [number, number]]))])),
    names: [...H.names] };
}
async function dbnParse(src: Source, H: DbnHead, pick: string, C: Census | null, onProgress?: (f: number) => void): Promise<Parsed> {
  const roll = pick === '*auto' && C ? rollMap(C) : null;
  let exact = 0;
  if (C && pick) {
    if (roll) for (const [k, m] of C.days) { const c = m.get(roll.get(k)!); if (c) exact += c[1]; }
    else exact = (C.list.find(x => x.sym === pick) || { rows: 0 }).rows;
  }
  const cap = exact || Math.max(4096, Math.floor((src.size || 4e6) / 56));
  const t = new Float64Array(cap), o = new Float32Array(cap), h = new Float32Array(cap), l = new Float32Array(cap), c = new Float32Array(cap), v = new Float32Array(cap);
  let k = 0, bad = 0, dec = 0;
  await dbnScan(src, H, onProgress, (dv, p, id, sec) => {
    if (pick) { const nm = dbnName(H, id); if (roll ? roll.get(String(Math.floor(sec / 86400)).padStart(8, '0')) !== nm : nm !== pick) return; }
    if (dv.getInt32(p + 20, true) === 2147483647) { bad++; return; }
    if (k === cap) return;
    const O = dbnPx(dv, p + 16), Hh = dbnPx(dv, p + 24), L = dbnPx(dv, p + 32), Cc = dbnPx(dv, p + 40);
    if (k < 400) dec = Math.max(dec, decimalsOf(O), decimalsOf(Cc));
    t[k] = sec; o[k] = O; c[k] = Cc; h[k] = Math.max(Hh, O, Cc); l[k] = Math.min(L, O, Cc);
    v[k] = dv.getUint32(p + 52, true) * 4294967296 + dv.getUint32(p + 48, true);
    k++;
  });
  if (k < 2) throw new Error(pick ? `Found fewer than two bars for ${pickLabel(pick)}.` : 'Found no OHLCV bars. DBN files of other schemas (trades, MBO, quotes) are not supported.');
  return finishSeries({ t, o, h, l, c, v }, k, { bad, prec: clamp(dec || 2, 0, 8), hasVol: true });
}
async function firstBytes(src: Source) { for await (const b of src.bytes()) return new Uint8Array(b, 0, Math.min(4, b.byteLength)); return new Uint8Array(0); }

/* ---- binary cache: a parsed series reopens without re-reading the file ---- */
export function toBlob(d: Parsed): Blob {
  const head = new TextEncoder().encode(JSON.stringify({ v: 1, n: d.n, base: d.base, prec: d.prec, bad: d.bad, hasVol: d.hasVol }));
  const hl = Math.ceil((4 + head.length) / 8) * 8, pre = new Uint8Array(hl);
  new DataView(pre.buffer).setUint32(0, head.length, true); pre.set(head, 4);
  return new Blob([pre, d.t, d.o, d.h, d.l, d.c, d.v] as BlobPart[]);
}
export function fromBin(buf: ArrayBuffer): Parsed {
  const len = new DataView(buf).getUint32(0, true);
  const m = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, len)));
  const n = m.n; let off = Math.ceil((4 + len) / 8) * 8;
  const t = new Float64Array(buf, off, n); off += n * 8;
  const f = () => { const a = new Float32Array(buf, off, n); off += n * 4; return a; };
  return { ...m, t, o: f(), h: f(), l: f(), c: f(), v: f() };
}

/** reads a file: its layout, its contracts (a first pass when it holds several), then the bars of one contract or
 * the continuous roll. With a census already known (from the cache) the file is read once. */
export async function readSource(src: Source, o: { C?: Census | null; pick?: string | null; onProgress?: (f: number, step: string) => void } = {}) {
  const prog = (step: string, a = 0, b = 1) => (f: number) => o.onProgress?.(a + f * (b - a), step);
  o.onProgress?.(0, 'Reading the file layout');
  const H: AnyHead = isDbn(await firstBytes(src)) ? await dbnHead(src) : await scanHead(src);
  let C = o.C || null, pick = o.pick ?? null;
  if (H.dbn && C?.names) for (const [id, nm] of C.names) H.names.set(id, nm);
  const twoPass = !C && H.ix.sym >= 0;
  if (twoPass) C = H.dbn ? await dbnCensus(src, H, prog('Finding the contracts (pass 1 of 2)', 0, 0.5)) : await census(src, H, prog('Finding the contracts (pass 1 of 2)', 0, 0.5));
  if (C && C.list.length < 2) C = null;
  if (pick == null || (pick && !C)) pick = defaultPick(C);
  const step = twoPass ? prog('Reading the bars (pass 2 of 2)', 0.5, 1) : prog('Reading the bars');
  const d = H.dbn ? await dbnParse(src, H, pick, C, step) : await parseAll(src, H as Head, pick, C, step);
  const names = H.dbn ? [...H.names.values()] : [];
  return { d, C, pick, names };
}

/* ---- futures contracts: point value, tick, name ---- */
export const INSTR: Record<string, [number, number, string]> = {
  ES: [50, 0.25, 'E-mini S&P 500'], MES: [5, 0.25, 'Micro E-mini S&P 500'], NQ: [20, 0.25, 'E-mini Nasdaq-100'], MNQ: [2, 0.25, 'Micro E-mini Nasdaq-100'],
  YM: [5, 1, 'E-mini Dow'], MYM: [0.5, 1, 'Micro E-mini Dow'], RTY: [50, 0.1, 'E-mini Russell 2000'], M2K: [5, 0.1, 'Micro E-mini Russell 2000'],
  EMD: [100, 0.1, 'E-mini S&P MidCap 400'],
  CL: [1000, 0.01, 'Crude oil'], MCL: [100, 0.01, 'Micro crude oil'], QM: [500, 0.025, 'E-mini crude oil'], NG: [10000, 0.001, 'Natural gas'],
  RB: [42000, 0.0001, 'RBOB gasoline'], HO: [42000, 0.0001, 'Heating oil'],
  GC: [100, 0.1, 'Gold'], MGC: [10, 0.1, 'Micro gold'], SI: [5000, 0.005, 'Silver'], SIL: [1000, 0.005, 'Micro silver'],
  HG: [25000, 0.0005, 'Copper'], MHG: [2500, 0.0005, 'Micro copper'], PL: [50, 0.1, 'Platinum'],
  ZB: [1000, 1 / 32, '30-year T-bond'], UB: [1000, 1 / 32, 'Ultra T-bond'], ZN: [1000, 1 / 64, '10-year T-note'], TN: [1000, 1 / 64, 'Ultra 10-year T-note'],
  ZF: [1000, 1 / 128, '5-year T-note'], ZT: [2000, 1 / 256, '2-year T-note'],
  '6E': [125000, 0.00005, 'Euro FX'], M6E: [12500, 0.0001, 'Micro EUR/USD'], '6B': [62500, 0.0001, 'British pound'], '6J': [12500000, 0.0000005, 'Japanese yen'],
  '6A': [100000, 0.00005, 'Australian dollar'], '6C': [100000, 0.00005, 'Canadian dollar'], '6S': [125000, 0.0001, 'Swiss franc'],
  ZC: [50, 0.25, 'Corn, in cents'], ZS: [50, 0.25, 'Soybeans, in cents'], ZW: [50, 0.25, 'Wheat, in cents'],
  BTC: [5, 5, 'Bitcoin'], MBT: [0.1, 5, 'Micro bitcoin'], ETH: [50, 0.5, 'Ether'], MET: [0.1, 0.5, 'Micro ether'],
};
/** "MNQH5", "MNQH25", "MNQ.FUT", "MNQ.c.0", "CME:MNQ1!", "/MNQ" -> "MNQ"; '' when it is not a known contract */
export function instrRoot(sym: string) {
  let x = String(sym || '').toUpperCase().trim().replace(/#.*$/, '').replace(/^.*:/, '').replace(/^\//, '');
  x = x.replace(/\.(FUT|[CVN]\.\d+)$/, '').replace(/\d!$/, '');
  if (INSTR[x]) return x;
  const m = x.match(/^([A-Z0-9]{1,4}?)[FGHJKMNQUVXZ]\d{1,2}$/);
  return m && INSTR[m[1]] ? m[1] : '';
}
const NAME_NOISE = /^(glbx|mdp3|xcme|xnas|xnys|dbeq|opra|ifeu|ndex|basic|itch|ohlcv?|bars?|data|export|exports|history|historical|hist|candles?|trades?|ticks?|continuous|cont|futures?|fut|min|mins|minute|minutes|seconds?|hour|hourly|daily|weekly|sample|test|file|copy|part|all|from|to|and|more)$/i;
/** the contract a data set holds, from its symbols or a word of its name */
export function instrumentOf(x: { name: string; pick?: string; contracts?: string[] }) {
  const syms = [x.pick && x.pick !== '*auto' ? x.pick : '', ...(x.contracts || [])];
  let root = syms.map(instrRoot).find(Boolean) || '';
  if (!root) for (const w of (x.name || '').split(/[^A-Za-z0-9!.]+/)) if ((root = instrRoot(w))) break;
  if (!root) return null;
  const [pv, tick, name] = INSTR[root];
  return { root, pv, tick, name };
}
/** the name the chart shows for a data set: the asset, not the file name */
export function assetName(x: { name: string; pick?: string; contracts?: string[] }) {
  const one = String(x.pick && x.pick !== '*auto' ? x.pick : x.contracts?.length === 1 ? x.contracts[0] : '').replace(/#\d+$/, '');
  if (one) return /[.:/!]/.test(one) && instrRoot(one) ? instrRoot(one) : one;
  const inst = instrumentOf(x); if (inst) return inst.root;
  const base = String(x.name || '').replace(/ \+ \d+ more$/, '').replace(/(\.(csv|txt|tsv|dbn|zst|gz))+$/i, '');
  const w = base.split(/[\s_.,\-()[\]]+/).find(s => /^[A-Za-z][A-Za-z0-9!]{1,11}$/.test(s) && !NAME_NOISE.test(s) && !/^[mhdw]\d+$|^\d|^[a-z]\d$/i.test(s));
  return w ? w.toUpperCase() : base.length > 22 ? base.slice(0, 21) + '…' : base || 'Data';
}
/** an instrument for a data set: a known contract's point value and tick, else $1 a point and the data's own precision */
export function instrumentFor(x: { name: string; pick?: string; contracts?: string[]; prec: number }, costs?: Partial<Pick<Instrument, 'comm' | 'spreadTicks' | 'slipTicks' | 'pv'>>): Instrument {
  const known = instrumentOf(x), sym = assetName(x);
  const tick = known ? known.tick : 10 ** -x.prec;
  const prec = Math.max(x.prec, known ? decimalsOf(known.tick) : 0);
  return { sym, name: known ? known.name : sym, tick, pv: costs?.pv ?? (known ? known.pv : 1), prec, comm: costs?.comm ?? 0, spreadTicks: costs?.spreadTicks ?? (known ? 1 : 0), slipTicks: costs?.slipTicks ?? 0 };
}
/** a parsed file as a market for the replay */
export function asSeries(id: string, d: Parsed, inst: Instrument): Series {
  return { id, inst, n: d.n, t: d.t, o: d.o, h: d.h, l: d.l, c: d.c, v: d.v, base: d.base, hasVol: d.hasVol, synthetic: false };
}
