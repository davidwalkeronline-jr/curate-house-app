// A/B player. Master, mix and original start together and are switched by
// gain, so comparisons are instant and sample aligned. The reference song
// plays on its own timeline. Optional level matching plays every version at
// the same loudness (capped so nothing clips).

export class Player {
  constructor({ onTime, onEnded }) {
    this.onTime = onTime;
    this.onEnded = onEnded;
    this.ctx = null;
    this.tracks = {}; // name -> { buffer, lufs, peakDb }
    this.current = 'master';
    this.levelMatch = true;
    this.playing = false;
    this.offset = 0; // seconds into the shared timeline
    this.refOffset = 0;
    this.nodes = [];
    this.raf = 0;
  }

  ensureContext(sampleRate) {
    if (this.ctx && this.ctx.sampleRate === sampleRate) return this.ctx;
    if (this.ctx) this.ctx.close();
    const AC = window.AudioContext || window.webkitAudioContext;
    try {
      this.ctx = new AC({ sampleRate, latencyHint: 'playback' });
    } catch {
      this.ctx = new AC();
    }
    return this.ctx;
  }

  // tracks: { master: {L, R, lufs, peakDb}, mix: ..., original: ..., reference: ... }
  load(tracks, sampleRate) {
    this.stop();
    const ctx = this.ensureContext(sampleRate);
    this.tracks = {};
    for (const [name, t] of Object.entries(tracks)) {
      if (!t) continue;
      let buffer = t.buffer;
      if (!buffer) {
        buffer = ctx.createBuffer(2, t.L.length, t.sampleRate || sampleRate);
        buffer.copyToChannel(t.L, 0);
        buffer.copyToChannel(t.R, 1);
      }
      this.tracks[name] = { buffer, lufs: t.lufs, peakDb: t.peakDb };
    }
    if (!this.tracks[this.current]) this.current = 'master';
    this.offset = 0;
    this.refOffset = this.tracks.reference?.startAt || 0;
  }

  get duration() {
    const t = this.current === 'reference' ? this.tracks.reference : this.tracks.master;
    return t ? t.buffer.duration : 0;
  }

  get position() {
    const base = this.current === 'reference' ? this.refOffset : this.offset;
    if (!this.playing) return base;
    return Math.min(this.duration, base + (this.ctx.currentTime - this.startedAt));
  }

  gainFor(name) {
    const t = this.tracks[name];
    if (!t) return 0;
    if (!this.levelMatch) return 1;
    const target = Math.min(-14, this.tracks.master?.lufs ?? -14);
    let db = Number.isFinite(t.lufs) ? target - t.lufs : 0;
    if (Number.isFinite(t.peakDb)) db = Math.min(db, -0.5 - t.peakDb);
    return Math.pow(10, db / 20);
  }

  matchCapped(name) {
    const t = this.tracks[name];
    if (!t || !this.levelMatch || !Number.isFinite(t.lufs)) return false;
    const target = Math.min(-14, this.tracks.master?.lufs ?? -14);
    return Number.isFinite(t.peakDb) && target - t.lufs > -0.5 - t.peakDb + 0.05;
  }

  async play() {
    if (!this.tracks.master) return;
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    this.startNodes();
    this.playing = true;
    this.tick();
  }

  pause() {
    if (!this.playing) return;
    const pos = this.position;
    if (this.current === 'reference') this.refOffset = pos;
    else this.offset = pos;
    this.stopNodes();
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.onTime?.(this.position, this.duration);
  }

  stop() {
    this.stopNodes();
    this.playing = false;
    cancelAnimationFrame(this.raf);
  }

  toggle() {
    return this.playing ? this.pause() : this.play();
  }

  seek(fraction) {
    const t = Math.max(0, Math.min(1, fraction)) * this.duration;
    const was = this.playing;
    if (was) this.stopNodes();
    if (this.current === 'reference') this.refOffset = t;
    else this.offset = t;
    if (was) this.startNodes();
    this.onTime?.(this.position, this.duration);
  }

  select(name) {
    if (!this.tracks[name] || name === this.current) return;
    const wasRef = this.current === 'reference';
    const toRef = name === 'reference';
    if (this.playing && (wasRef || toRef)) {
      // Switching timelines: remember where each one was.
      const pos = this.position;
      if (wasRef) this.refOffset = pos;
      else this.offset = pos;
      this.stopNodes();
      this.current = name;
      this.startNodes();
    } else {
      this.current = name;
      this.applyGains();
    }
    this.onTime?.(this.position, this.duration);
  }

  setLevelMatch(on) {
    this.levelMatch = on;
    this.applyGains();
  }

  startNodes() {
    const ctx = this.ctx;
    this.stopNodes();
    const when = ctx.currentTime + 0.03;
    this.startedAt = when;
    const names = this.current === 'reference' ? ['reference'] : ['master', 'mix', 'original'];
    for (const name of names) {
      const t = this.tracks[name];
      if (!t) continue;
      const src = ctx.createBufferSource();
      src.buffer = t.buffer;
      const g = ctx.createGain();
      g.gain.value = name === this.current ? this.gainFor(name) : 0;
      src.connect(g).connect(ctx.destination);
      const off = name === 'reference' ? this.refOffset : this.offset;
      if (off >= t.buffer.duration) continue;
      src.start(when, off);
      if (name === this.current || name === 'master' || name === 'reference') {
        src.onended = () => {
          if (this.playing && this.position >= this.duration - 0.05) {
            this.playing = false;
            if (this.current === 'reference') this.refOffset = 0;
            else this.offset = 0;
            cancelAnimationFrame(this.raf);
            this.onEnded?.();
          }
        };
      }
      this.nodes.push({ name, src, g });
    }
  }

  applyGains() {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    for (const n of this.nodes) {
      const v = n.name === this.current ? this.gainFor(n.name) : 0;
      n.g.gain.cancelScheduledValues(now);
      n.g.gain.setTargetAtTime(v, now, 0.008);
    }
  }

  stopNodes() {
    for (const n of this.nodes) {
      n.src.onended = null;
      try {
        n.src.stop();
      } catch {
        /* already stopped */
      }
      n.src.disconnect();
    }
    this.nodes = [];
  }

  tick() {
    this.onTime?.(this.position, this.duration);
    if (this.playing) this.raf = requestAnimationFrame(() => this.tick());
  }
}

export function fmtTime(s) {
  if (!Number.isFinite(s)) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}
