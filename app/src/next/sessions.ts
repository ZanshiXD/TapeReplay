// A replay session as the app keeps it: the markets it plays (practice markets or Library data, and how much was
// loaded), the account, and everything the session did, saved to the Library and reopened exactly.
import { Session, type PropSetup, type SessionState } from '../core/session';
import { practiceSeries, PRACTICE } from '../core/practice';
import { asSeries, instrumentFor } from '../core/data';
import { loadSection, openDataset, slice, type Progress } from '../core/library';
import type { Instrument, Series } from '../core/series';
import type { DatasetMeta, Store } from '../core/store';
import { parseTF, tfLabel } from '../core/time';
import type { IndSpec } from '../core/indicators';

export type Costs = Pick<Instrument, 'comm' | 'spreadTicks' | 'slipTicks'>;
export type MarketSource =
  | { kind: 'practice'; sym: string; t0: number; t1: number; costs: Costs }
  | { kind: 'dataset'; id: string; name: string; pick: string; inst: Instrument;
      /** the bars loaded: everything (null) or a section of a long series */
      window: { from: number; to: number } | null;
      /** plays on to the end of a long series, loading a month at a time, keeping this many days of history */
      cont: { hist: number } | null };

/** a session as it is open in the app */
export interface Live {
  session: Session;
  id: string;
  created: number;
  name: string;
  start: number;
  balance: number;
  risk: number;
  markets: MarketSource[];
}

export const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/** loads one market's bars */
export async function loadMarket(store: Store, m: MarketSource, progress?: Progress): Promise<Series> {
  if (m.kind === 'practice') {
    const [s] = await practiceSeries([m.sym], m.t0, m.t1, f => progress?.(f, 'Preparing the market data'));
    return { ...s, inst: { ...s.inst, ...m.costs } };
  }
  const metas = await store.listDatasets();
  const meta = metas.find(x => x.id === m.id);
  if (!meta) throw new Error(`The data file ${m.name} is no longer in the Library.`);
  const op = await openDataset(store, meta, m.pick, progress);
  let d = op.d;
  if (!d) {
    if (!op.index || !m.window) throw new Error('This session has no saved date range, so it cannot be reopened.');
    d = await loadSection(store, meta.id, op.index, m.window.from, m.window.to, progress);
  } else if (m.window) d = slice(d, m.window.from, m.window.to);
  return asSeries(meta.id + ':' + (m.pick || 'all'), d, m.inst);
}

/** a practice market's place in the list of markets, with its costs */
export const practiceSource = (sym: string, t0: number, t1: number, costs: Costs): MarketSource => ({ kind: 'practice', sym, t0, t1, costs });

/** the instrument for a Library data file, with the costs remembered for it */
export function datasetInstrument(meta: DatasetMeta, pick: string, contracts: string[], prec: number, costs?: Partial<Instrument>) {
  return instrumentFor({ name: meta.name, pick, contracts, prec }, costs);
}

export interface Opening { name: string; start: number; balance: number; risk: number; tf: string; inds: IndSpec[]; markets: MarketSource[]; id?: string; created?: number; prop?: PropSetup | null }
export async function openLive(store: Store, x: Opening, progress?: Progress, restore?: SessionState): Promise<Live> {
  const series: Series[] = [];
  for (const [k, m] of x.markets.entries()) series.push(await loadMarket(store, m, (f, step) => progress?.((k + f) / x.markets.length, step)));
  // two markets with the same code (two NQ files) get told apart
  const seen = new Set<string>();
  for (const s of series) { let sym = s.inst.sym, j = 2; while (seen.has(sym)) sym = `${s.inst.sym}${j++}`; seen.add(sym); if (sym !== s.inst.sym) s.inst = { ...s.inst, sym }; }
  const session = new Session({ name: x.name, markets: series, start: x.start, tf: parseTF(restore ? tfLabel(restore.tf) : x.tf) || parseTF('5m')!, balance: x.balance, inds: restore?.inds || x.inds, prop: restore ? null : x.prop });
  if (restore) session.load(restore);
  return { session, id: x.id || newId(), created: x.created || Date.now(), name: x.name, start: x.start, balance: x.balance, risk: x.risk, markets: x.markets };
}

/** what a session saves: enough to reopen it exactly, and a summary for the Library's list */
export function sessionDoc(L: Live) {
  const s = L.session, a = s.account, h = a.hist, wins = h.filter(x => x.net > 0).length;
  const first = L.markets[0], ds = first.kind === 'dataset' ? first : null;
  return {
    v: 2, app: 'next', id: L.id, name: L.name, created: L.created, updated: Date.now(),
    status: s.atEnd ? 'finished' : 'in progress', tf: tfLabel(s.tf),
    datasetId: ds ? ds.id : 'practice-generated', datasetName: ds ? ds.name : 'Practice markets',
    start: L.start, balance: L.balance, risk: L.risk, markets: L.markets, state: s.state(),
    summary: {
      app: 'next', markets: s.feeds.map(f => f.s.inst.sym).join(' + '), from: L.start, to: s.now, tf: tfLabel(s.tf),
      trades: h.length, net: a.balance - a.start, winRate: h.length ? wins / h.length : null, maxDD: a.maxDD,
    },
  };
}
export type SessionDoc = ReturnType<typeof sessionDoc>;

/** reopens a saved session */
export function reopen(store: Store, doc: SessionDoc, progress?: Progress) {
  return openLive(store, { id: doc.id, created: doc.created, name: doc.name, start: doc.start, balance: doc.balance, risk: doc.risk, tf: doc.tf, inds: doc.state.inds, markets: doc.markets }, progress, doc.state);
}

export const PRACTICE_SYMS = Object.keys(PRACTICE);

/* ---- playing on to the end of a long series, a month at a time ---- */
const KEEP = () => (import.meta.env.MODE === 'test' && (window as unknown as { __TAPE_CONT_KEEP?: number }).__TAPE_CONT_KEEP) || 24e6;
const loading = new WeakMap<object, Promise<void>>();
/** called now and then while a session plays: loads the next month of any market that plays on, once the replay
 * is within two days of the end of what is loaded, and lets go of old bars so memory stays level */
export function contAhead(store: Store, L: Live, onError: (m: string) => void) {
  L.markets.forEach((m, k) => {
    if (m.kind !== 'dataset' || !m.cont || !m.window || loading.has(m)) return;
    const f = L.session.feeds[k]; if (!f) return;
    const s = f.s, lastT = s.t[s.n - 1];
    if (lastT - f.time > 2 * 86400) return;
    const p = (async () => {
      const ix = await store.seriesIndex(m.id);
      while (m.window!.to < ix.to) {
        const t0 = m.window!.to + 1, t1 = Math.min(ix.to, m.window!.to + 31 * 86400);
        let part = null;
        try { part = await loadSection(store, m.id, ix, t0, t1); } catch (e) { if (!/no bars/i.test((e as Error).message)) throw e; }
        m.window!.to = t1;
        if (part && part.n) {
          if (s.n + part.n > KEEP()) L.session.trim(f.s.inst.sym, f.time - m.cont!.hist * 86400);
          L.session.extend(f.s.inst.sym, part);
          break;
        }
      }
    })().catch(e => onError('Could not load the next month: ' + (e as Error).message)).finally(() => loading.delete(m));
    loading.set(m, p);
  });
}
