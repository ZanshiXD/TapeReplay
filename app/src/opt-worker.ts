// An optimization worker: the app's engine and strategy runner with no screen. The app code still expects a page,
// so the few page objects it touches while starting get harmless stand-ins before it runs.
// @ts-nocheck
import { app } from './app';

const stub = new Proxy(function () {}, {
  get: (t, k) => (k === 'then' || typeof k === 'symbol') ? undefined : stub,
  apply: () => stub, construct: () => stub, set: () => true,
});
Object.assign(self, {
  window: self, __TAPE_WORKER: true, document: stub, screen: { width: 1600, height: 1000 },
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  requestAnimationFrame: () => 0,
});

// the page sends 'boot' first; app() then installs its own message handler (workerMain)
self.onmessage = e => {
  if (e.data.type !== 'boot') return;
  app(null);
  postMessage({ type: 'booted' });
};
