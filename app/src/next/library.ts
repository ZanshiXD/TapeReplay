// Adding data files to the Library: read once (to learn their bars, dates and contracts), then kept by the app (or
// the browser) with a parsed copy, so a session starts from them at once.
import { fileSource } from '../core/data';
import { readInto, type Progress } from '../core/library';
import type { DatasetMeta, Picked, Store } from '../core/store';

/** files the person chose or dropped: one, or several read back to back as one (a batch download) */
export function joinFiles(list: File[]): File {
  const files = [...list].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (files.length === 1) return files[0];
  const sep = files.every(f => /\.dbn$/i.test(f.name)) ? [] : [new Blob(['\n'])];
  return new File([new Blob(files.flatMap(f => [f, ...sep]))], `${files[0].name} + ${files.length - 1} more`);
}

/** a file into the Library; returns its entry */
export async function addData(store: Store, from: { file: File } | { picked: Picked }, progress: Progress): Promise<DatasetMeta> {
  const caps = await store.caps();
  if ('picked' in from && from.picked.dbn && caps.importDbn) return store.importDbn(from.picked, (f, m) => progress(f, m));
  const name = 'file' in from ? from.file.name : from.picked.name;
  const src = 'file' in from ? fileSource(from.file) : store.pickedSource(from.picked);
  const r = await readInto(null, src, { id: '', name }, null, null, (f, s) => progress(f * 0.85, s));
  const d = r.d!;
  const meta: Partial<DatasetMeta> = { name, bars: d.n, base: d.base, from: d.t[0], to: d.t[d.n - 1], contracts: r.C ? r.C.list.length : 1 };
  progress(0.9, 'Saving it to your Library');
  const m = 'file' in from ? await store.addFile(from.file, meta) : await store.adopt(from.picked.id, meta);
  // the parsed copy goes with it, so opening it later is instant
  await readIntoCache(store, m, r);
  progress(1, 'Done');
  return m;
}
async function readIntoCache(store: Store, m: DatasetMeta, r: Awaited<ReturnType<typeof readInto>>) {
  const { cacheKey, censusToJSON, toBlob } = await import('../core/data');
  if (r.C) await store.putCensus(m.id, censusToJSON(r.C)).catch(() => {});
  if (r.d) await store.putCache(m.id, cacheKey(r.pick), toBlob(r.d)).catch(() => {});
}

export const fmtBars = (n?: number) => n == null ? '' : n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M bars` : n >= 1e3 ? `${Math.round(n / 1e3)}k bars` : `${n} bars`;
export const fmtBase = (b?: number) => !b ? '' : b < 60 ? `${b}-second bars` : b < 3600 ? `${b / 60}-minute bars` : b < 86400 ? `${b / 3600}-hour bars` : 'daily bars';
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const fmtDay = (t?: number) => { if (t == null || !isFinite(t)) return ''; const d = new Date(t * 1000); return `${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
