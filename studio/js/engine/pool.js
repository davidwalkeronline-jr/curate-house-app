// Worker pool. Jobs run in parallel across CPU cores; if module workers are
// unavailable (old browser, sandboxed page) jobs run inline on the main
// thread instead, with the same results.

import { runJob } from './jobs.js';

const yieldToUI = () => new Promise((r) => setTimeout(r, 0));

export class Pool {
  constructor(size) {
    const hc = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
    this.size = size || Math.max(1, Math.min(4, hc - 1));
    this.workers = [];
    this.queue = [];
    this.pending = new Map();
    this.nextId = 1;
    this.inline = false;
    this.ready = this.init();
  }

  async init() {
    if (typeof Worker === 'undefined') {
      this.inline = true;
      return;
    }
    try {
      const url = new URL('./worker.js', import.meta.url);
      for (let i = 0; i < this.size; i++) {
        const w = new Worker(url, { type: 'module' });
        const slot = { w, busy: false };
        w.onmessage = (e) => this.onMessage(slot, e.data);
        w.onerror = (e) => this.onError(slot, e);
        this.workers.push(slot);
      }
      // Confirm the module workers actually start.
      const ok = await Promise.race([
        this.dispatchTo(this.workers[0], 'ping', {}).then(() => true),
        new Promise((r) => setTimeout(() => r(false), 4000)),
      ]);
      if (!ok) throw new Error('worker start timeout');
    } catch (err) {
      console.warn('Curate Studio: running without workers', err);
      for (const s of this.workers) s.w.terminate();
      this.workers = [];
      this.pending.clear();
      this.inline = true;
    }
  }

  dispatchTo(slot, type, payload, transfer = [], onProgress) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      slot.busy = true;
      this.pending.set(id, { resolve, reject, slot, onProgress });
      slot.w.postMessage({ id, type, payload }, transfer);
    });
  }

  onMessage(slot, msg) {
    const p = this.pending.get(msg.id);
    if (!p) return;
    if (msg.progress !== undefined && !('result' in msg) && !msg.error) {
      p.onProgress?.(msg.progress, msg.label);
      return;
    }
    this.pending.delete(msg.id);
    slot.busy = false;
    if (msg.error) p.reject(new Error(msg.error));
    else p.resolve(msg.result);
    this.pump();
  }

  onError(slot, e) {
    for (const [id, p] of this.pending) {
      if (p.slot === slot) {
        this.pending.delete(id);
        p.reject(new Error(e.message || 'Worker error'));
      }
    }
    slot.busy = false;
    this.pump();
  }

  pump() {
    while (this.queue.length) {
      const slot = this.workers.find((s) => !s.busy);
      if (!slot) return;
      const job = this.queue.shift();
      this.dispatchTo(slot, job.type, job.payload, job.transfer, job.onProgress).then(job.resolve, job.reject);
    }
  }

  // Run a job. `transfer` lists ArrayBuffers in the payload to move rather
  // than copy (they become unusable on the caller side).
  async run(type, payload, transfer = [], onProgress) {
    await this.ready;
    if (this.inline) {
      await yieldToUI();
      const { result } = runJob(type, payload, onProgress);
      await yieldToUI();
      return result;
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ type, payload, transfer, onProgress, resolve, reject });
      this.pump();
    });
  }

  terminate() {
    for (const s of this.workers) s.w.terminate();
    this.workers = [];
  }
}
