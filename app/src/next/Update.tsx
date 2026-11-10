// The Windows app's updates: a button in the sidebar when a new version is waiting; installing saves the session,
// then the app downloads the release, checks it and restarts.
import { useEffect, useState } from 'react';
import type { UpdateInfo } from '../core/store';
import { store } from './appstore';

export function UpdateButton({ beforeInstall }: { beforeInstall: () => Promise<void> }) {
  const [u, setU] = useState<UpdateInfo | null>(null);
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (store.kind !== 'app') return;
    let tries = 0, timer = 0;
    const poll = async () => {
      const x = await store.update();
      if (x && x.state === 'available') return setU(x);
      if ((!x || x.state === 'checking') && ++tries < 120) timer = window.setTimeout(poll, 2000);
    };
    poll();
    return () => clearTimeout(timer);
  }, []);
  if (!u) return null;
  const go = async () => {
    setBusy(true); setMsg('Saving…');
    try { await beforeInstall(); await store.installUpdate(); } catch (e) { setMsg((e as Error).message); setBusy(false); return; }
    const tick = async () => {
      const x = await store.update();
      if (x?.state === 'failed') { setMsg(x.error || 'The update failed.'); setBusy(false); return; }
      if (x) setMsg(x.state === 'downloading' ? `Downloading ${Math.round((x.progress || 0) * 100)}%` : 'Restarting…');
      setTimeout(tick, 400);
    };
    tick();
  };
  return (
    <div style={{ position: 'relative' }}>
      <button className="updbtn" title={`Version ${u.version} is ready`} onClick={() => setOpen(!open)}>Update</button>
      {open && <div className="pop" role="dialog" aria-label="Update" style={{ left: 64, bottom: 0, width: 320, padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <button hidden data-dismiss onClick={() => setOpen(false)} />
        <b>What's new in {u.version}</b>
        <div className="muted" style={{ fontSize: 12.5, whiteSpace: 'pre-wrap', maxHeight: 200, overflow: 'auto' }}>{u.notes || 'Fixes and improvements.'}</div>
        <span className="muted" style={{ fontSize: 12 }}>You have {u.current}. The app saves your session, downloads the update and restarts. Your sessions and data are kept.</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><span className="muted" style={{ flex: 1, fontSize: 12 }} aria-live="polite">{msg}{msg && u.page && /fail|could/i.test(msg) && <> <a href={u.page} target="_blank" rel="noopener">Download it instead</a></>}</span>
          <button className="btn primary sm" disabled={busy} onClick={go}>Restart and update</button></div>
      </div>}
    </div>
  );
}
