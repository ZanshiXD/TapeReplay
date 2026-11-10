// An optimization worker for the new core: runs one combination at a time for the page (optimizer.ts OptPool).
// The page starts it with spawnOptWorker(); see optjob.ts for the messages.
import RUNTIME from '../python/runtime.py?raw';
import RUNNER from '../python/runner.py?raw';
import { jobHandler } from './optjob';
import { loadPython, type PyHost } from './pybridge';

let py: Promise<PyHost> | null = null;
const handle = jobHandler({
  async python(base, libs) {
    const h = await (py ||= loadPython({ indexURL: base, runtime: RUNTIME, runner: RUNNER, quiet: true }));
    await h.need(libs);
    return h;
  },
});
self.onmessage = (e: MessageEvent) => { handle(e.data, m => (self as unknown as Worker).postMessage(m)); };
