// The in-app guide: every chapter on one scrolling page with its contents beside it (in a sheet on phones) and a
// search that keeps the sections mentioning what you typed. It opens as a page (the sidebar's Guide, More on a
// phone) or over whatever you are doing (openGuide, from the code editors), so nothing you were writing is lost.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { CHAPTERS } from './content';
import { usePhone } from '../phone';
import './guide.css';

/** opens the guide over the app at a section (App listens) */
export function openGuide(at?: string) { dispatchEvent(new CustomEvent('tape:guide', { detail: at || '' })); }

export function Guide({ at, onClose }: { at?: string; onClose?: () => void }) {
  const [q, setQ] = useState('');
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [cur, setCur] = useState(at || CHAPTERS[0].sections[0].id);
  const [toc, setToc] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const phone = usePhone();
  const go = (id: string) => {
    setToc(false);
    const el = body.current?.querySelector<HTMLElement>(`[data-sec="${id}"]`);
    if (el && body.current) body.current.scrollTop = el.offsetTop - 8; // at once: a smooth scroll can be cut short
    setCur(id);
  };
  // open at the section asked for
  useLayoutEffect(() => { if (at) { const el = body.current?.querySelector<HTMLElement>(`[data-sec="${at}"]`); if (el && body.current) body.current.scrollTop = el.offsetTop - 8; } }, [at]);
  // the search: keep the sections whose words include every word typed
  useEffect(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean), out = new Set<string>();
    if (words.length) for (const el of body.current?.querySelectorAll<HTMLElement>('[data-sec]') || []) {
      const t = (el.textContent || '').toLowerCase();
      if (!words.every(w => t.includes(w))) out.add(el.dataset.sec!);
    }
    setHidden(out);
    if (words.length && body.current) body.current.scrollTop = 0;
  }, [q]);
  // the section being read, for the contents
  const onScroll = () => {
    const b = body.current; if (!b) return;
    let id = cur;
    for (const el of b.querySelectorAll<HTMLElement>('[data-sec]')) { if (el.offsetParent && el.offsetTop - b.scrollTop <= 80) id = el.dataset.sec!; }
    if (id !== cur) setCur(id);
  };
  const shown = (id: string) => !hidden.has(id);
  const contents = (
    <nav className="gtoc" aria-label="Contents">
      {CHAPTERS.filter(c => c.sections.some(s => shown(s.id))).map(c => <div key={c.id}>
        <h5>{c.title}</h5>
        {c.sections.filter(s => shown(s.id)).map(s => <button key={s.id} className={cur === s.id ? 'on' : ''} aria-current={cur === s.id ? 'true' : undefined} onClick={() => go(s.id)}>{s.title}</button>)}
      </div>)}
    </nav>
  );
  const none = hidden.size === CHAPTERS.reduce((n, c) => n + c.sections.length, 0);
  return (
    <div className={'guide' + (onClose ? ' over' : '')} role={onClose ? 'dialog' : undefined} aria-label="Guide">
      <header className="ghead">
        <b>Guide</b>
        <input className="in" type="search" placeholder="Search the guide" aria-label="Search the guide" value={q} onChange={e => setQ(e.target.value)} />
        {phone && <button className="btn sm" aria-expanded={toc} onClick={() => setToc(!toc)}>Contents</button>}
        {onClose && <button className="ib" aria-label="Close the guide" onClick={onClose}>✕</button>}
      </header>
      <div className="gwrap">
        {!phone && contents}
        <div className="gbody" ref={body} onScroll={onScroll}>
          {none && <div className="empty">Nothing in the guide mentions “{q}”.</div>}
          {CHAPTERS.map(c => <section key={c.id} className="gchap" hidden={c.sections.every(s => !shown(s.id))}>
            <h2>{c.title}</h2>
            {c.sections.map(s => <article key={s.id} data-sec={s.id} id={'guide-' + s.id} hidden={!shown(s.id)}>
              <h3>{s.title}</h3>
              {s.body}
            </article>)}
          </section>)}
        </div>
      </div>
      {phone && toc && <div className="pop menu gtocpop" onMouseLeave={() => setToc(false)}><button hidden data-dismiss onClick={() => setToc(false)} />{contents}</div>}
    </div>
  );
}
