import { analyze } from '../core/analyze.js';
import type { Snapshot } from '../core/types.js';

self.addEventListener('message', (event: MessageEvent<Snapshot>) => {
  try {
    self.postMessage({ result: analyze(event.data) });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : 'Analysis failed.' });
  }
});
