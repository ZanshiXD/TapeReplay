// Whether the phone layout is on (html.m, set in main.tsx from the window size), for parts laid out differently there.
import { useEffect, useState } from 'react';

export const isPhone = () => document.documentElement.classList.contains('m');

export function usePhone() {
  const [p, setP] = useState(isPhone);
  useEffect(() => {
    const f = () => setP(isPhone());
    addEventListener('resize', f); f();
    return () => removeEventListener('resize', f);
  }, []);
  return p;
}

/** Phones: the app's data tables (backtest trades, optimization results...) read as cards, each value with its
 *  column's name beside it, instead of a table wider than the screen. Labels come from the header row. */
export function labelTables(root: ParentNode) {
  for (const t of root.querySelectorAll<HTMLTableElement>('.page table.t:not(.cards)')) {
    const heads = [...t.querySelectorAll('thead th')].map(th => (th.textContent || '').replace(/[▲▼↑↓]/g, '').trim());
    t.classList.add('mcards');
    for (const tr of t.querySelectorAll('tbody tr')) [...tr.children].forEach((td, i) => {
      const h = heads[i];
      if (h) { if (td.getAttribute('data-l') !== h) td.setAttribute('data-l', h); } else td.removeAttribute('data-l');
    });
  }
}
