// Menus, popovers and pickers (.pop), for every one of them in one place:
//  - kept inside the window and inside any scrolling box that would cut them off: moved just enough (translate), and
//    given a scroll of their own when taller than the room there is (desktop; phones show them as bottom sheets);
//  - closed by a press outside them (menus close on mouse leave, panels through their close button, data-dismiss,
//    pickers on a mouse press elsewhere: all three are triggered), and by Escape, the topmost first;
//  - on phones the sheet's dimmed backdrop (its ::after) catches the tap that closes it, so that tap doesn't also press,
//    pan or draw on what is under it. On a desktop the click that closes a menu through its own button doesn't reopen it.
const OPEN = '.pop, .drawrail .flyout, html.m .otree';
/** what sits over the app: a press there doesn't close menus underneath it, and Escape is theirs */
const OVER = '.modal-back, .guide.over';
const M = 8;
const root = document.documentElement;
const phone = () => root.classList.contains('m');

/** the room a menu has: the window, less any box around it that clips (overflow) */
function room(p: HTMLElement) {
  let L = M, T = M, R = innerWidth - M, B = innerHeight - M;
  if (getComputedStyle(p).position !== 'fixed') {
    for (let a = p.parentElement; a && a !== document.body; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (cs.position === 'fixed') break;
      if (/(hidden|auto|scroll|clip)/.test(cs.overflowX + cs.overflowY)) {
        const q = a.getBoundingClientRect();
        L = Math.max(L, q.left); T = Math.max(T, q.top); R = Math.min(R, q.right); B = Math.min(B, q.bottom);
      }
    }
  }
  return { L, T, R, B };
}

const mine = new WeakMap<HTMLElement, { mh: boolean }>();
/** moves a menu back inside its room, and lets it scroll when it is taller than the room */
export function fitPop(p: HTMLElement) {
  if (!p.isConnected) return;
  const st = mine.get(p) || { mh: false };
  mine.set(p, st);
  p.style.translate = '';
  if (phone()) { if (st.mh) { p.style.maxHeight = ''; st.mh = false; } return; }
  let r = p.getBoundingClientRect();
  if (!r.width && !r.height) return;
  let box = room(p);
  // a box too small to hold it can't be respected: the window then
  if (box.R - box.L < r.width || box.B - box.T < Math.min(r.height, 160)) box = { L: M, T: M, R: innerWidth - M, B: innerHeight - M };
  const tall = box.B - box.T;
  if (r.height > tall + 1) {
    p.style.maxHeight = tall + 'px'; p.style.overflowY = 'auto'; st.mh = true;
    r = p.getBoundingClientRect();
  }
  let dx = 0, dy = 0;
  if (r.right > box.R) dx = box.R - r.right;
  if (r.left + dx < box.L) dx = box.L - r.left;
  if (r.bottom > box.B) dy = box.B - r.bottom;
  if (r.top + dy < box.T) dy = box.T - r.top;
  if (dx || dy) p.style.translate = `${Math.round(dx)}px ${Math.round(dy)}px`;
}

/** closes one menu, whichever way it listens */
export function closePop(p: HTMLElement) {
  p.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
  p.querySelector<HTMLElement>('[data-dismiss]')?.click();
  document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
}

const shown = (p: HTMLElement) => p.isConnected && p.getClientRects().length > 0;

export function installPops() {
  // fit each menu when it opens, when its size changes, and when the window does
  const ro = new ResizeObserver(es => { for (const e of es) fitPop(e.target as HTMLElement); });
  const seen = new WeakSet<HTMLElement>();
  let queued: HTMLElement[] = [], raf = 0;
  const flush = () => { raf = 0; const q = queued; queued = []; for (const p of q) fitPop(p); };
  const take = (p: HTMLElement) => { if (seen.has(p)) return; seen.add(p); ro.observe(p); queued.push(p); if (!raf) raf = requestAnimationFrame(flush); };
  new MutationObserver(ms => {
    for (const m of ms) for (const n of m.addedNodes) {
      if (!(n instanceof HTMLElement)) continue;
      if (n.matches('.pop')) take(n);
      if (n.firstElementChild) for (const p of n.querySelectorAll<HTMLElement>('.pop')) take(p);
    }
  }).observe(document.body, { childList: true, subtree: true });
  addEventListener('resize', () => { for (const p of document.querySelectorAll<HTMLElement>('.pop')) fitPop(p); });

  // a press outside closes
  let swallowUntil = 0, swallowToggle: Element | null = null;
  const outside = (p: HTMLElement, e: PointerEvent) => {
    const t = e.target as Node;
    if (!p.contains(t)) return true;
    if (t !== p) return false;
    const r = p.getBoundingClientRect(); // the sheet itself, or its dimmed backdrop
    return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  };
  addEventListener('pointerdown', (e: PointerEvent) => {
    swallowUntil = 0; swallowToggle = null; // a new press: only the rest of the one that closed a menu is swallowed
    const t = e.target as Element;
    const over = t instanceof Element ? t.closest(OVER) : null;
    let any = false, sheet = false;
    for (const p of document.querySelectorAll<HTMLElement>(OPEN)) {
      if (!outside(p, e)) continue;
      if (over && !over.contains(p)) continue; // a press in the editor or the guide leaves the menus under it alone
      any = true;
      p.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
      p.querySelector<HTMLElement>('[data-dismiss]')?.click();
      if (phone() && !p.classList.contains('colorpop')) sheet = true;
    }
    if (any) document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    if (sheet) { swallowUntil = e.timeStamp + 700; e.stopPropagation(); e.preventDefault(); }
    else if (any && t instanceof Element) {
      // pressing an open menu's own button closes it: its click must not open it again
      const tog = t.closest('[aria-expanded="true"]');
      if (tog) { swallowToggle = tog; swallowUntil = e.timeStamp + 1500; }
    }
  }, true);
  const swallow = (e: Event) => {
    if (e.timeStamp >= swallowUntil) return;
    if (swallowToggle) { if (e.type !== 'click') return; if (!swallowToggle.contains(e.target as Node)) { swallowToggle = null; return; } }
    e.stopPropagation(); e.preventDefault();
    if (e.type === 'click') { swallowUntil = 0; swallowToggle = null; }
  };
  for (const ev of ['pointerup', 'mousedown', 'mouseup', 'click', 'touchstart', 'touchend']) addEventListener(ev, swallow, { capture: true, passive: false });

  // Escape closes the topmost menu (over an editor or the guide, only menus inside it)
  addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    const overs = [...document.querySelectorAll<HTMLElement>(OVER)];
    const top = overs[overs.length - 1];
    const pops = [...document.querySelectorAll<HTMLElement>(OPEN)].filter(p => shown(p) && (!top || top.contains(p)));
    const p = pops[pops.length - 1];
    if (!p) return;
    e.stopImmediatePropagation(); e.preventDefault();
    closePop(p);
  }, true);
}
