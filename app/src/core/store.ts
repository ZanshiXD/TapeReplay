// Where sessions, data files, settings and optimizations are kept. In the Windows and iOS apps the page talks to
// the app's own server (the same /api on both); in a plain browser everything is kept in IndexedDB, so the Library
// works there too (without the native file dialog and the large DBN import, which need the app).
import { blobSource, type Source } from './data';

export interface DatasetMeta {
  id: string; name: string; size?: number; bars?: number; base?: number; from?: number; to?: number; contracts?: number;
  added?: number; builtin?: boolean; chunked?: boolean; symbol?: string; [k: string]: unknown;
}
export interface SessionMeta {
  id: string; name: string; datasetId?: string; datasetName?: string; created: number; updated: number; status?: string; tf?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  summary?: any; renamed?: boolean;
}
export interface Caps { pick: boolean; importDbn: boolean; ios: boolean; update: boolean; optimize: boolean; version?: string }
export interface Picked { id: string; name: string; size: number; dbn?: boolean }
export interface SeriesIndex { n: number; base: number; prec: number; hasVol: boolean; from: number; to: number; rolls?: Array<[number, string]>; symbol?: string; blocks: Array<{ t0: number; t1: number; n: number }> }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = any;

export interface Store {
  kind: 'app' | 'browser';
  caps(): Promise<Caps>;
  listSessions(): Promise<SessionMeta[]>;
  getSession(id: string): Promise<Doc>;
  saveSession(id: string, doc: Doc): Promise<void>;
  /** the closing window's last save, which must finish before the page goes */
  saveSessionNow(id: string, doc: Doc): void;
  renameSession(id: string, name: string): Promise<void>;
  deleteSession(id: string): Promise<void>;
  last(): Promise<{ id?: string }>;
  getPrefs(): Promise<Doc>;
  savePrefs(p: Doc): Promise<void>;
  listDatasets(): Promise<DatasetMeta[]>;
  deleteDataset(id: string): Promise<void>;
  /** a file the person dropped or chose in the browser, added to the Library */
  addFile(file: Blob, meta: Partial<DatasetMeta>): Promise<DatasetMeta>;
  /** the app's own file dialog (null when canceled) */
  pick(): Promise<Picked | null>;
  /** a file chosen in the app's dialog, added to the Library */
  adopt(pick: string, meta: Partial<DatasetMeta>): Promise<DatasetMeta>;
  /** DBN files of any size, converted by the app into monthly blocks */
  importDbn(pick: Picked, onProgress: (f: number, msg: string) => void): Promise<DatasetMeta>;
  pickedSource(p: Picked): Source;
  datasetSource(m: DatasetMeta): Source;
  getCache(dsId: string, key: string): Promise<ArrayBuffer | null>;
  putCache(dsId: string, key: string, blob: Blob): Promise<void>;
  getCensus(dsId: string): Promise<Doc | null>;
  putCensus(dsId: string, c: Doc): Promise<void>;
  seriesIndex(dsId: string): Promise<SeriesIndex>;
  seriesBlock(dsId: string, i: number): Promise<ArrayBuffer>;
  listOptims(): Promise<Doc[]>;
  getOptim(id: string): Promise<Doc>;
  saveOptim(id: string, doc: Doc): Promise<void>;
  deleteOptim(id: string): Promise<void>;
  /** keeps the phone's screen on during a long run */
  awake(on: boolean): void;
  /** the Windows app's own updates: what it found at launch (null in a browser or on iOS) */
  update(): Promise<UpdateInfo | null>;
  /** downloads, checks and installs the update, then the app restarts */
  installUpdate(): Promise<void>;
}
export interface UpdateInfo { current: string; state: 'checking' | 'none' | 'available' | 'downloading' | 'installing' | 'failed' | string; version?: string; notes?: string; progress?: number; error?: string; page?: string }

/* ---- the Windows and iOS apps' server ---- */
function appStore(token: string): Store {
  const call = async (method: string, path: string, body?: BodyInit, headers: Record<string, string> = {}) => {
    const r = await fetch('/api/' + path, { method, headers: { 'X-Token': token, ...headers }, body });
    if (!r.ok) throw new Error((await r.text()) || r.statusText);
    if (r.status === 204) return null;
    return (r.headers.get('content-type') || '').includes('json') ? r.json() : r.text();
  };
  const bin = async (path: string) => { const r = await fetch('/api/' + path, { headers: { 'X-Token': token } }); if (!r.ok) throw new Error((await r.text()) || r.statusText); return r.arrayBuffer(); };
  const json = { 'Content-Type': 'application/json' };
  const read = (kind: string, id: string) => (start: number, len: number) => bin(`blob/${kind}/${id}?start=${start}&len=${len}`);
  let capsP: Promise<Caps> | null = null;
  return {
    kind: 'app',
    caps: () => capsP ||= call('GET', 'caps').then(c => ({ pick: !!c.pick, importDbn: !!c.importDbn, ios: !!c.ios, update: !!c.update, optimize: !!c.optimize, version: c.version })),
    listSessions: () => call('GET', 'sessions'),
    getSession: id => call('GET', 'sessions/' + id),
    saveSession: (id, doc) => call('PUT', 'sessions/' + id, JSON.stringify(doc), json),
    saveSessionNow: (id, doc) => {
      try { const x = new XMLHttpRequest(); x.open('PUT', '/api/sessions/' + id, false); x.setRequestHeader('X-Token', token); x.setRequestHeader('Content-Type', 'application/json'); x.send(JSON.stringify(doc)); } catch { /* closing anyway */ }
    },
    renameSession: (id, name) => call('PATCH', 'sessions/' + id, JSON.stringify({ name }), json),
    deleteSession: id => call('DELETE', 'sessions/' + id),
    last: () => call('GET', 'last'),
    getPrefs: () => call('GET', 'prefs'),
    savePrefs: p => call('PUT', 'prefs', JSON.stringify(p), json),
    listDatasets: () => call('GET', 'datasets'),
    deleteDataset: id => call('DELETE', 'datasets/' + id),
    addFile: (file, meta) => call('POST', 'datasets', file, { 'Content-Type': 'application/octet-stream', 'X-Meta': encodeURIComponent(JSON.stringify(meta)) }),
    pick: () => call('POST', 'pick'),
    adopt: (pick, meta) => call('POST', 'datasets/adopt', JSON.stringify({ pick, meta }), json),
    async importDbn(p, onProgress) {
      const { job } = await call('POST', 'import', JSON.stringify({ pick: p.id, name: p.name }), json);
      for (;;) {
        await new Promise(r => setTimeout(r, 700));
        const s = await call('GET', 'import/' + job);
        if (s.state === 'error') throw new Error(s.message || 'The import failed.');
        if (s.state === 'done') return s.dataset;
        onProgress(s.progress || 0, s.message || 'Importing');
      }
    },
    pickedSource: p => blobSource(read('picked', p.id), 'picked', p.id, p.size, p.name),
    datasetSource: m => blobSource(read('dataset', m.id), 'dataset', m.id, m.size || 0, m.name),
    async getCache(dsId, key) {
      const st = await call('GET', `stat/cache/${dsId}_${key}`).catch(() => null); if (!st) return null;
      const all = new Uint8Array(st.size);
      for (let p = 0; p < st.size; p += 8 << 20) all.set(new Uint8Array(await bin(`blob/cache/${dsId}_${key}?start=${p}&len=${8 << 20}`)), p);
      return all.buffer;
    },
    putCache: (dsId, key, blob) => call('PUT', `cache/${dsId}_${key}`, blob, { 'Content-Type': 'application/octet-stream' }),
    getCensus: id => call('GET', 'census/' + id).catch(() => null),
    putCensus: (id, c) => call('PUT', 'census/' + id, JSON.stringify(c), json),
    seriesIndex: id => call('GET', 'series/' + id),
    seriesBlock: (id, i) => bin(`series/${id}/${i}`),
    listOptims: () => call('GET', 'optims'),
    getOptim: id => call('GET', 'optims/' + id),
    saveOptim: (id, doc) => call('PUT', 'optims/' + id, JSON.stringify(doc), json),
    deleteOptim: id => call('DELETE', 'optims/' + id),
    awake: on => { call('POST', 'awake', JSON.stringify({ on }), json).catch(() => {}); },
    update: () => call('GET', 'update').catch(() => null),
    installUpdate: () => call('POST', 'update').then(() => {}),
  };
}

/* ---- a plain browser: IndexedDB ---- */
const STORES = ['kv', 'sessions', 'sessionMeta', 'datasets', 'files', 'caches', 'optims', 'optimMeta'] as const;
function idb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open('tape-replay', 1);
    r.onupgradeneeded = () => { for (const s of STORES) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
function browserStore(): Store {
  let dbP: Promise<IDBDatabase> | null = null;
  const db = () => dbP ||= idb();
  const tx = async <T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T> => {
    const d = await db();
    return new Promise((res, rej) => {
      const t = d.transaction(store, mode), s = t.objectStore(store), r = fn(s);
      t.oncomplete = () => res(r ? r.result : undefined as T); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error || new Error('The browser would not save this (is it out of space?).'));
    });
  };
  const get = <T>(s: string, k: string) => tx<T>(s, 'readonly', st => st.get(k) as IDBRequest<T>);
  const put = (s: string, k: string, v: unknown) => tx(s, 'readwrite', st => { st.put(v, k); }).then(() => {});
  const del = (s: string, k: string) => tx(s, 'readwrite', st => { st.delete(k); }).then(() => {});
  const all = <T>(s: string) => tx<T[]>(s, 'readonly', st => st.getAll() as IDBRequest<T[]>);
  const keys = (s: string) => tx<IDBValidKey[]>(s, 'readonly', st => st.getAllKeys());
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const metaOf = (doc: Doc) => ({ id: doc.id, name: doc.name, datasetId: doc.datasetId, datasetName: doc.datasetName, created: doc.created, updated: doc.updated, status: doc.status, tf: doc.tf, summary: doc.summary });
  const self: Store = {
    kind: 'browser',
    caps: async () => ({ pick: false, importDbn: false, ios: false, update: false, optimize: typeof SharedArrayBuffer !== 'undefined' }),
    listSessions: () => all<SessionMeta>('sessionMeta'),
    async getSession(id) { const d = await get('sessions', id); if (!d) throw new Error('That session no longer exists.'); return d; },
    async saveSession(id, doc) {
      const old = await get<SessionMeta>('sessionMeta', id);
      if (old?.renamed) doc = { ...doc, name: old.name };
      await put('sessions', id, doc); await put('sessionMeta', id, { ...metaOf(doc), id, renamed: old?.renamed }); await put('kv', 'last', { id });
    },
    saveSessionNow: (id, doc) => { self.saveSession(id, doc).catch(() => {}); },
    async renameSession(id, name) {
      const m = await get<SessionMeta>('sessionMeta', id), d = await get<Doc>('sessions', id); if (!m || !d) throw new Error('That session no longer exists.');
      await put('sessions', id, { ...d, name }); await put('sessionMeta', id, { ...m, name, renamed: true });
    },
    async deleteSession(id) { await del('sessions', id); await del('sessionMeta', id); },
    last: async () => (await get<{ id?: string }>('kv', 'last')) || {},
    getPrefs: async () => (await get('kv', 'prefs')) || {},
    savePrefs: p => put('kv', 'prefs', JSON.parse(JSON.stringify(p))),
    listDatasets: () => all<DatasetMeta>('datasets'),
    async deleteDataset(id) {
      await del('datasets', id); await del('files', id); await del('kv', 'census:' + id);
      for (const k of await keys('caches')) if (String(k).startsWith(id + '_')) await del('caches', String(k));
    },
    async addFile(file, meta) {
      const m: DatasetMeta = { name: 'Data', ...meta, id: newId(), size: file.size, added: Date.now() } as DatasetMeta;
      await put('files', m.id, file); await put('datasets', m.id, m);
      return m;
    },
    pick: async () => { throw new Error('The file dialog needs the Tape Replay app. Drop a file here or use Choose a file.'); },
    adopt: async () => { throw new Error('Not available in a browser.'); },
    importDbn: async () => { throw new Error('Large DBN imports need the Tape Replay app. Smaller DBN files open directly.'); },
    pickedSource: () => { throw new Error('Not available in a browser.'); },
    datasetSource(m) {
      return { kind: 'dataset', id: m.id, name: m.name, size: m.size || 0, async *bytes() {
        const f = await get<Blob>('files', m.id); if (!f) throw new Error('That data file is no longer in this browser.');
        for (let p = 0; p < f.size; p += 8 << 20) yield await f.slice(p, p + (8 << 20)).arrayBuffer();
      } };
    },
    async getCache(dsId, key) { const b = await get<Blob>('caches', `${dsId}_${key}`); return b ? b.arrayBuffer() : null; },
    putCache: (dsId, key, blob) => put('caches', `${dsId}_${key}`, blob),
    getCensus: async id => (await get('kv', 'census:' + id)) || null,
    putCensus: (id, c) => put('kv', 'census:' + id, c),
    seriesIndex: async () => { throw new Error('Not available in a browser.'); },
    seriesBlock: async () => { throw new Error('Not available in a browser.'); },
    listOptims: () => all('optimMeta'),
    getOptim: async id => { const d = await get('optims', id); if (!d) throw new Error('That optimization no longer exists.'); return d; },
    async saveOptim(id, doc) {
      await put('optims', id, doc);
      const meta = Object.fromEntries(['id', 'name', 'strategy', 'datasetName', 'created', 'updated', 'total', 'done', 'goal', 'best', 'from', 'to', 'tf'].map(k => [k, doc[k]]));
      await put('optimMeta', id, { ...meta, id });
    },
    async deleteOptim(id) { await del('optims', id); await del('optimMeta', id); },
    awake: () => {},
    update: async () => null,
    installUpdate: async () => { throw new Error('Updates come with the app.'); },
  };
  return self;
}

/** the store for this page: the app's server when the app opened the page (it passes a token), else the browser */
export function openStore(): Store {
  const token = new URLSearchParams(location.search).get('t');
  if (token && location.protocol === 'http:') return appStore(token);
  return browserStore();
}
