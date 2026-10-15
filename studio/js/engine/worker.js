// Web Worker entry: runs jobs from jobs.js and posts results back.
import { runJob } from './jobs.js';

self.onmessage = (e) => {
  const { id, type, payload } = e.data;
  try {
    const progress = (p, label) => self.postMessage({ id, progress: p, label });
    const { result, transfer } = runJob(type, payload, progress);
    self.postMessage({ id, result }, transfer || []);
  } catch (err) {
    self.postMessage({ id, error: (err && err.stack) || String(err) });
  }
};
