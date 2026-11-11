// The Library: saved sessions to pick up again, and the data files sessions are made from. Everything can be
// opened, renamed or removed from here, and new data added (a file dialog, or drop files anywhere on the page).
import { useEffect, useRef, useState } from 'react';
import type { DatasetMeta, SessionMeta } from '../core/store';
import { smoney } from '../core/account';
import { store } from './appstore';
import { addData, fmtBars, fmtBase, fmtDay, joinFiles } from './library';
import { IPlus, ITrash } from './icons';

type Tab = 'sessions' | 'data';
const ago = (ms: number) => { const s = (Date.now() - ms) / 1000; return s < 90 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : s < 86400 * 30 ? `${Math.round(s / 86400)} days ago` : fmtDay(ms / 1000); };

export function LibraryPage({ onOpen, onNewWith, onBusy, onToast, current, extra }: {
  onOpen: (id: string) => void; onNewWith: (ds: DatasetMeta) => void;
  onBusy: (b: { text: string; p: number } | null) => void; onToast: (m: string, k?: string) => void;
  current: string | null; extra?: { tab: string; label: string; node: React.ReactNode };
}) {
  const [tab, setTab] = useState<Tab | string>('sessions');
  const [sessions, setSessions] = useState<SessionMeta[] | null>(null);
  const [data, setData] = useState<DatasetMeta[] | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [canPick, setCanPick] = useState(false);
  const fileIn = useRef<HTMLInputElement>(null);
  const load = () => {
    store.listSessions().then(l => setSessions(l.filter(s => s.summary?.app === 'next').sort((a, b) => b.updated - a.updated))).catch(e => { setSessions([]); onToast(e.message, 'err'); });
    store.listDatasets().then(l => setData(l.sort((a, b) => (b.added || 0) - (a.added || 0)))).catch(() => setData([]));
  };
  useEffect(() => { load(); store.caps().then(c => setCanPick(c.pick)); addEventListener('tape:datasets', load); return () => removeEventListener('tape:datasets', load); }, []);
  const add = async (from: { file: File } | 'pick') => {
    try {
      let src: { file: File } | { picked: NonNullable<Awaited<ReturnType<typeof store.pick>>> };
      if (from === 'pick') { const p = await store.pick(); if (!p) return; src = { picked: p }; } else src = from;
      const name = 'file' in src ? src.file.name : src.picked.name;
      onBusy({ text: `Adding ${name}`, p: 0 });
      const m = await addData(store, src, (p, step) => onBusy({ text: `${name}: ${step}`, p }));
      onToast(`${m.name} is in your Library.`, 'up'); setTab('data'); load();
    } catch (e) { onToast((e as Error).message, 'err'); }
    finally { onBusy(null); }
  };
  // drop files anywhere on the page
  useEffect(() => {
    const over = (e: DragEvent) => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); };
    const drop = (e: DragEvent) => { const fs = e.dataTransfer?.files; if (!fs || !fs.length) return; e.preventDefault(); add({ file: joinFiles([...fs]) }); };
    addEventListener('dragover', over); addEventListener('drop', drop);
    return () => { removeEventListener('dragover', over); removeEventListener('drop', drop); };
  });
  const rename = async (id: string, name: string) => {
    setRenaming(null); name = name.trim(); if (!name) return;
    try { await store.renameSession(id, name); load(); } catch (e) { onToast('Could not rename: ' + (e as Error).message, 'err'); }
  };
  const remove = async (kind: Tab, id: string) => {
    setConfirm(null);
    try { if (kind === 'sessions') await store.deleteSession(id); else await store.deleteDataset(id); load(); onToast('Removed.'); }
    catch (e) { onToast((e as Error).message, 'err'); }
  };
  const tabs: Array<[string, string, number | undefined]> = [['sessions', 'Sessions', sessions?.length], ['data', 'Data files', data?.length]];
  if (extra) tabs.push([extra.tab, extra.label, undefined]);
  return (
    <div className="page">
      <header className="ctx" style={{ gap: 14 }}>
        <b style={{ fontSize: 15 }}>Library</b>
        <nav className="tabs" style={{ border: 0, padding: 0 }}>{tabs.map(([k, l, n]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}{n != null ? ` (${n})` : ''}</button>)}</nav>
        <span className="spacer" />
        <input ref={fileIn} type="file" multiple hidden accept=".csv,.txt,.tsv,.dbn,.zst,text/csv" onChange={e => { const f = e.target.files; if (f && f.length) add({ file: joinFiles([...f]) }); e.target.value = ''; }} />
        <button className="btn primary sm" onClick={() => canPick ? add('pick') : fileIn.current?.click()}><IPlus width={13} height={13} /> Add a data file</button>
      </header>
      <div className="page-in">
        {tab === 'sessions' && <>
          {sessions && !sessions.length && <div className="emptycard"><b>No saved sessions yet</b><p>Sessions save themselves as you replay. Start one with the + button.</p></div>}
          {!!sessions?.length && <div className="libtable">
            {sessions.map(s => {
              const sum = s.summary || {};
              const net = typeof sum.net === 'number' ? sum.net : null;
              return (
                <div key={s.id} className={'librow' + (s.id === current ? ' cur' : '')}>
                  <div className="main">
                    {renaming === s.id ? <input className="in ui" autoFocus defaultValue={s.name} aria-label="Session name" onBlur={e => rename(s.id, e.target.value)} onKeyDown={e => { if (e.key === 'Enter') rename(s.id, (e.target as HTMLInputElement).value); if (e.key === 'Escape') setRenaming(null); }} />
                      : <b className="nm" title="Rename" onDoubleClick={() => setRenaming(s.id)}>{s.name}</b>}
                    <span className="muted">{sum.markets || s.datasetName}{s.tf ? ` · ${s.tf}` : ''}{sum.from ? ` · from ${fmtDay(sum.from)}` : ''}</span>
                  </div>
                  <span className="cell">{sum.trades != null ? `${sum.trades} trade${sum.trades === 1 ? '' : 's'}` : ''}</span>
                  <span className={'cell num ' + (net == null ? '' : net >= 0 ? 'up' : 'down')}>{net != null ? smoney(net) : ''}</span>
                  <span className="cell muted">{s.status === 'finished' ? 'Finished' : ago(s.updated)}</span>
                  <span className="acts">
                    <button className="btn sm primary" onClick={() => onOpen(s.id)}>{s.id === current ? 'Back to it' : 'Open'}</button>
                    <button className="btn sm" onClick={() => setRenaming(s.id)}>Rename</button>
                    {confirm === s.id ? <button className="btn sm danger" onClick={() => remove('sessions', s.id)}>Delete it</button>
                      : <button className="ib" aria-label={`Delete ${s.name}`} title="Delete" disabled={s.id === current} onClick={() => setConfirm(s.id)}><ITrash width={16} height={16} /></button>}
                  </span>
                </div>
              );
            })}
          </div>}
        </>}
        {tab === 'data' && <>
          <div className="dropzone" onClick={() => canPick ? add('pick') : fileIn.current?.click()} role="button" tabIndex={0}>
            <b>Drop CSV or Databento (DBN) files here</b><span>or click to choose. Any bar size; files with several contracts can follow the busiest one (continuous).</span>
          </div>
          {data && !data.length && <p className="muted">No data files yet. The practice markets are always there, in New session.</p>}
          {!!data?.length && <div className="libtable">
            {data.map(d => (
              <div key={d.id} className="librow">
                <div className="main"><b className="nm">{d.name}</b>
                  <span className="muted">{[fmtBars(d.bars), fmtBase(d.base), d.from ? `${fmtDay(d.from)} → ${fmtDay(d.to)}` : '', d.contracts && d.contracts > 1 ? `${d.contracts} contracts` : ''].filter(Boolean).join(' · ')}{d.builtin && <span className="tag" style={{ marginLeft: 8, background: 'var(--accent-soft)', color: 'var(--accent-fg)' }}>Built in</span>}</span>
                </div>
                <span className="acts">
                  <button className="btn sm primary" onClick={() => onNewWith(d)}>New session with it</button>
                  {!d.builtin && (confirm === d.id ? <button className="btn sm danger" onClick={() => remove('data', d.id)}>Delete it</button>
                    : <button className="ib" aria-label={`Delete ${d.name}`} title="Delete" onClick={() => setConfirm(d.id)}><ITrash width={16} height={16} /></button>)}
                </span>
              </div>
            ))}
          </div>}
        </>}
        {extra && tab === extra.tab && extra.node}
        {confirm && <p className="muted" style={{ fontSize: 12 }}>Click “Delete it” to confirm. <button className="linkbtn" onClick={() => setConfirm(null)}>Keep it</button></p>}
      </div>
    </div>
  );
}
