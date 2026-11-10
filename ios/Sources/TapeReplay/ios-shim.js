// Added by the iOS app before the page's own script runs. The page is the desktop one; this adapts it to touch.
window.TAPE_IOS = true;
(() => {
  'use strict';

  // ---- layout: no page zoom (the chart pinches itself), room for the notch and home bar, bigger targets ----
  const CSS = `
    html, body { -webkit-text-size-adjust: 100%; -webkit-tap-highlight-color: transparent; overscroll-behavior: none; }
    body { box-sizing: border-box; padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left); }
    button, select, input, label.btn, .tab { touch-action: manipulation; }
    #chart, #draw, .dtools, .dsplit { -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; }
    .dsplit { top: -14px; height: 20px; }
    @media (pointer: coarse) {
      .dtools button { min-height: 34px; }
      .hbig, .hitem { min-height: 44px; }
      .menu button { padding: 10px 12px; }
    }
    @media (hover: none) { .tip { display: none !important; } }
  `;
  document.addEventListener('DOMContentLoaded', () => {
    let meta = document.querySelector('meta[name=viewport]');
    if (!meta) { meta = document.createElement('meta'); meta.name = 'viewport'; document.head.appendChild(meta); }
    meta.content = 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover';
    // the new app (one React root) handles safe areas, touch and its own layout itself; these are for the classic page
    if (document.getElementById('root') && !document.getElementById('chart')) { document.documentElement.classList.add('ios'); return; }
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
  });

  // ---- touch: the chart's drawing and order-line code listens for the mouse ----
  // A finger on the chart is offered to that code as a mouse press. When the app takes it (a drawing tool is
  // active, or a line, tag or drawing is under the finger) the touch drags that thing and the chart stays still;
  // otherwise the chart pans and pinches as usual. Holding still for a moment opens the order menu
  // (the right-click menu on a desktop). The bottom panel's top edge drags the same way.
  const HOSTS = '#chart, .dsplit';
  const HOLD_MS = 550, SLOP = 9;
  let active = null; // { id, host, x, y, taken, moved, timer, last }

  const fire = (type, host, t) => {
    const ev = new MouseEvent(type, {
      bubbles: true, cancelable: true, view: window,
      clientX: t.clientX, clientY: t.clientY, screenX: t.screenX, screenY: t.screenY,
      button: type === 'contextmenu' ? 2 : 0, buttons: type === 'mousedown' || type === 'mousemove' ? 1 : 0,
    });
    host.dispatchEvent(ev);
    return ev;
  };
  const finish = () => { if (active) { clearTimeout(active.timer); active = null; } };
  const ours = e => active && [...e.changedTouches].find(t => t.identifier === active.id);

  document.addEventListener('touchstart', e => {
    if (active) { // a second finger: hand the gesture back to the chart (pinch)
      if (active.taken) fire('mouseup', active.host, active.last);
      finish();
      return;
    }
    const host = e.target.closest ? e.target.closest(HOSTS) : null;
    if (!host || e.touches.length !== 1) return;
    const t = e.touches[0];
    fire('mousemove', host, t);
    const down = fire('mousedown', host, t);
    active = { id: t.identifier, host, x: t.clientX, y: t.clientY, taken: down.defaultPrevented || host.classList.contains('dsplit'), moved: false, timer: 0, last: t };
    if (active.taken) { e.preventDefault(); e.stopPropagation(); }
    if (host.id === 'chart' && !active.taken) {
      active.timer = setTimeout(() => {
        if (!active || active.moved) return;
        const { host: h, last } = active;
        fire('mouseup', h, last);
        finish();
        fire('contextmenu', h, last);
      }, HOLD_MS);
    }
  }, { capture: true, passive: false });

  document.addEventListener('touchmove', e => {
    const t = ours(e); if (!t) return;
    active.last = t;
    if (!active.moved && Math.hypot(t.clientX - active.x, t.clientY - active.y) > SLOP) { active.moved = true; clearTimeout(active.timer); }
    if (active.taken) { fire('mousemove', active.host, t); e.preventDefault(); e.stopPropagation(); }
  }, { capture: true, passive: false });

  const end = e => {
    const t = ours(e); if (!t) return;
    fire('mouseup', active.host, t);
    if (active.taken) { e.preventDefault(); e.stopPropagation(); }
    finish();
  };
  document.addEventListener('touchend', end, { capture: true, passive: false });
  document.addEventListener('touchcancel', end, { capture: true, passive: false });
})();
