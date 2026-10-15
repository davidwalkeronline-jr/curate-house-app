// Biquad filters (RBJ Audio EQ Cookbook) with transposed direct form II
// processing. Coefficients are stored normalised (a0 = 1) as
// Float64Array [b0, b1, b2, a1, a2].

import { TAU } from './util.js';

export function designBiquad(type, f0, fs, q = Math.SQRT1_2, gainDb = 0) {
  const f = Math.min(Math.max(f0, 1), fs * 0.4999);
  const w0 = (TAU * f) / fs;
  const cosw = Math.cos(w0);
  const sinw = Math.sin(w0);
  const alpha = sinw / (2 * q);
  const A = Math.pow(10, gainDb / 40);
  let b0;
  let b1;
  let b2;
  let a0;
  let a1;
  let a2;
  switch (type) {
    case 'lowpass':
      b0 = (1 - cosw) / 2; b1 = 1 - cosw; b2 = (1 - cosw) / 2;
      a0 = 1 + alpha; a1 = -2 * cosw; a2 = 1 - alpha;
      break;
    case 'highpass':
      b0 = (1 + cosw) / 2; b1 = -(1 + cosw); b2 = (1 + cosw) / 2;
      a0 = 1 + alpha; a1 = -2 * cosw; a2 = 1 - alpha;
      break;
    case 'bandpass':
      b0 = alpha; b1 = 0; b2 = -alpha;
      a0 = 1 + alpha; a1 = -2 * cosw; a2 = 1 - alpha;
      break;
    case 'notch':
      b0 = 1; b1 = -2 * cosw; b2 = 1;
      a0 = 1 + alpha; a1 = -2 * cosw; a2 = 1 - alpha;
      break;
    case 'allpass':
      b0 = 1 - alpha; b1 = -2 * cosw; b2 = 1 + alpha;
      a0 = 1 + alpha; a1 = -2 * cosw; a2 = 1 - alpha;
      break;
    case 'peaking':
      b0 = 1 + alpha * A; b1 = -2 * cosw; b2 = 1 - alpha * A;
      a0 = 1 + alpha / A; a1 = -2 * cosw; a2 = 1 - alpha / A;
      break;
    case 'lowshelf': {
      const sq = 2 * Math.sqrt(A) * alpha;
      b0 = A * (A + 1 - (A - 1) * cosw + sq);
      b1 = 2 * A * (A - 1 - (A + 1) * cosw);
      b2 = A * (A + 1 - (A - 1) * cosw - sq);
      a0 = A + 1 + (A - 1) * cosw + sq;
      a1 = -2 * (A - 1 + (A + 1) * cosw);
      a2 = A + 1 + (A - 1) * cosw - sq;
      break;
    }
    case 'highshelf': {
      const sq = 2 * Math.sqrt(A) * alpha;
      b0 = A * (A + 1 + (A - 1) * cosw + sq);
      b1 = -2 * A * (A - 1 + (A + 1) * cosw);
      b2 = A * (A + 1 + (A - 1) * cosw - sq);
      a0 = A + 1 - (A - 1) * cosw + sq;
      a1 = 2 * (A - 1 - (A + 1) * cosw);
      a2 = A + 1 - (A - 1) * cosw - sq;
      break;
    }
    default:
      throw new Error('Unknown biquad type ' + type);
  }
  return Float64Array.of(b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0);
}

// One pole low/high pass as a biquad (first order sections use b2 = a2 = 0).
export function designOnePole(type, f0, fs) {
  const k = Math.tan((Math.PI * Math.min(f0, fs * 0.49)) / fs);
  if (type === 'lowpass') {
    const n = 1 / (1 + k);
    return Float64Array.of(k * n, k * n, 0, (k - 1) * n, 0);
  }
  const n = 1 / (1 + k);
  return Float64Array.of(n, -n, 0, (k - 1) * n, 0);
}

// Squared magnitude response of one section at frequency f.
export function biquadMag2(c, f, fs) {
  const w = (TAU * f) / fs;
  const cw = Math.cos(w);
  const sw = Math.sin(w);
  const c2 = Math.cos(2 * w);
  const s2 = Math.sin(2 * w);
  const nr = c[0] + c[1] * cw + c[2] * c2;
  const ni = -(c[1] * sw + c[2] * s2);
  const dr = 1 + c[3] * cw + c[4] * c2;
  const di = -(c[3] * sw + c[4] * s2);
  return (nr * nr + ni * ni) / (dr * dr + di * di);
}

export function biquadDb(c, f, fs) {
  return 10 * Math.log10(Math.max(biquadMag2(c, f, fs), 1e-30));
}

// Summed dB response of a list of sections over a frequency grid.
export function cascadeDb(sections, freqs, fs) {
  const out = new Float64Array(freqs.length);
  for (const c of sections) {
    for (let i = 0; i < freqs.length; i++) out[i] += biquadDb(c, freqs[i], fs);
  }
  return out;
}

// Process one section in place over buf[start, end). State s = [z1, z2].
export function biquadRun(buf, c, s, start = 0, end = buf.length) {
  const b0 = c[0];
  const b1 = c[1];
  const b2 = c[2];
  const a1 = c[3];
  const a2 = c[4];
  let z1 = s[0];
  let z2 = s[1];
  for (let i = start; i < end; i++) {
    const x = buf[i];
    const y = b0 * x + z1;
    z1 = b1 * x - a1 * y + z2;
    z2 = b2 * x - a2 * y;
    buf[i] = y;
  }
  // Flush tiny states so long silences never fall into denormal territory.
  s[0] = Math.abs(z1) < 1e-30 ? 0 : z1;
  s[1] = Math.abs(z2) < 1e-30 ? 0 : z2;
}

// Process one section from src into dst (may be the same array).
export function biquadRunTo(src, dst, c, s, start = 0, end = src.length) {
  const b0 = c[0];
  const b1 = c[1];
  const b2 = c[2];
  const a1 = c[3];
  const a2 = c[4];
  let z1 = s[0];
  let z2 = s[1];
  for (let i = start; i < end; i++) {
    const x = src[i];
    const y = b0 * x + z1;
    z1 = b1 * x - a1 * y + z2;
    z2 = b2 * x - a2 * y;
    dst[i] = y;
  }
  s[0] = Math.abs(z1) < 1e-30 ? 0 : z1;
  s[1] = Math.abs(z2) < 1e-30 ? 0 : z2;
}

// Filter src[srcStart, srcStart+len) into dst[dstStart, dstStart+len).
export function biquadRunOffset(src, srcStart, dst, dstStart, len, c, s) {
  const b0 = c[0];
  const b1 = c[1];
  const b2 = c[2];
  const a1 = c[3];
  const a2 = c[4];
  let z1 = s[0];
  let z2 = s[1];
  for (let i = 0; i < len; i++) {
    const x = src[srcStart + i];
    const y = b0 * x + z1;
    z1 = b1 * x - a1 * y + z2;
    z2 = b2 * x - a2 * y;
    dst[dstStart + i] = y;
  }
  s[0] = Math.abs(z1) < 1e-30 ? 0 : z1;
  s[1] = Math.abs(z2) < 1e-30 ? 0 : z2;
}

// A chain of sections with independent state per channel.
export class BiquadChain {
  constructor(sections, channels = 1) {
    this.sections = sections.filter(Boolean);
    this.states = [];
    for (let ch = 0; ch < channels; ch++) {
      this.states.push(this.sections.map(() => new Float64Array(2)));
    }
  }

  get length() {
    return this.sections.length;
  }

  // Process channel `ch` of buf in place, block by block for cache locality.
  process(buf, ch = 0, start = 0, end = buf.length) {
    const st = this.states[ch];
    const BLOCK = 4096;
    for (let b = start; b < end; b += BLOCK) {
      const e = Math.min(end, b + BLOCK);
      for (let k = 0; k < this.sections.length; k++) biquadRun(buf, this.sections[k], st[k], b, e);
    }
  }

  reset() {
    for (const st of this.states) for (const s of st) s.fill(0);
  }
}

// Butterworth sections of a given (even) order. Order 2 is one section.
export function butterworth(type, f0, fs, order = 2) {
  const sections = [];
  const n = Math.max(2, order - (order % 2));
  for (let k = 0; k < n / 2; k++) {
    const q = 1 / (2 * Math.cos((Math.PI * (2 * k + 1)) / (2 * n)));
    sections.push(designBiquad(type, f0, fs, q));
  }
  return sections;
}

// Linkwitz-Riley 4th order crossover sections: two cascaded Butterworth
// 2nd order filters. Low + high sums to an allpass (flat magnitude).
export function lr4(f0, fs) {
  const lp = designBiquad('lowpass', f0, fs, Math.SQRT1_2);
  const hp = designBiquad('highpass', f0, fs, Math.SQRT1_2);
  return { low: [lp, lp], high: [hp, hp] };
}
