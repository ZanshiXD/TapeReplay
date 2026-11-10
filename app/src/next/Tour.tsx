// A short tour the first time the Replay screen opens: what each part is for, in a few words, pointing at it.
import { useEffect, useLayoutEffect, useState } from 'react';
import { pref, setPref } from './live';

const STEPS: Array<{ sel: string; title: string; text: string }> = [
  { sel: '.rbar .play', title: 'Play the market', text: 'Prices move as if it were live. Pause any time; the arrows step a bar forward or back, and the timeline jumps.' },
  { sel: '.qbtn.buy', title: 'Buy or sell', text: 'Buy if you think the price will rise, sell if you think it will fall. The ticket sizes the trade from what you are willing to lose, and says what happens at your stop and target.' },
  { sel: '.ctrade, .pane .lw', title: 'Trade on the chart', text: 'Each trade has a tag on its line: drag the SL and TP out of it, or press × to close it. Right-click (or hold a finger) on the chart for an order at that price.' },
  { sel: '.drawrail, .pencil', title: 'Draw like on TradingView', text: 'Trend lines, Fibonacci, boxes, long and short positions and more. Pick a tool, then click on the chart.' },
  { sel: '.dock .tabs, .mnav', title: 'Your trades', text: 'Open positions, orders, history and your results. Every closed trade goes to the journal with a picture of the chart.' },
  { sel: '.nav .item:nth-child(5), .mnav button:last-child', title: 'Saved as you go', text: 'Sessions save themselves. Find them, and your own data files, in the Library.' },
];

export const tourDone = () => pref('tourDone', false);
export function Tour({ onEnd }: { onEnd: () => void }) {
  const [k, setK] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const step = STEPS[k];
  useLayoutEffect(() => {
    const find = () => { const el = step.sel.split(', ').map(s => document.querySelector(s)).find(e => e && (e as HTMLElement).offsetParent !== null) as HTMLElement | undefined; setRect(el ? el.getBoundingClientRect() : null); };
    find(); const t = setInterval(find, 300); return () => clearInterval(t);
  }, [step]);
  useEffect(() => { const f = (e: KeyboardEvent) => { if (e.key === 'Escape') end(); }; addEventListener('keydown', f); return () => removeEventListener('keydown', f); });
  const end = () => { setPref('tourDone', true); onEnd(); };
  const W = 320, vw = innerWidth, vh = innerHeight;
  let left = vw / 2 - W / 2, top = vh / 2 - 80;
  if (rect) {
    left = Math.min(vw - W - 12, Math.max(12, rect.left + rect.width / 2 - W / 2));
    top = rect.bottom + 12 + 170 < vh ? rect.bottom + 12 : Math.max(12, rect.top - 12 - 170);
  }
  return (
    <div className="tour" role="dialog" aria-label="Tour">
      {rect && <div className="tour-ring" style={{ left: rect.left - 6, top: rect.top - 6, width: rect.width + 12, height: rect.height + 12 }} />}
      <div className="tour-card" style={{ left, top, width: W }}>
        <span className="muted" style={{ fontSize: 11.5 }}>{k + 1} of {STEPS.length}</span>
        <b>{step.title}</b>
        <p>{step.text}</p>
        <span className="acts">
          <button className="linkbtn" onClick={end}>{k === STEPS.length - 1 ? '' : 'Skip the tour'}</button>
          <span className="spacer" />
          {k > 0 && <button className="btn sm" onClick={() => setK(k - 1)}>Back</button>}
          <button className="btn sm primary" onClick={() => k === STEPS.length - 1 ? end() : setK(k + 1)}>{k === STEPS.length - 1 ? 'Start trading' : 'Next'}</button>
        </span>
      </div>
    </div>
  );
}
