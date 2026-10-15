// Applies a planned channel strip to one stem:
// collapse -> polarity/alignment -> gate -> EQ -> compressor -> de-esser ->
// saturation -> pan/width -> fader. Works in place on worker-local copies.

import { BiquadChain, designOnePole } from './biquad.js';
import { compress, expand, deEss } from './dynamics.js';
import { saturate } from './saturation.js';
import { eqCoefficients } from './planner.js';
import { unpackInto } from './bfp.js';

// Unpack [start, end) of packed channels into new Float32Arrays (samples
// outside the stem read as silence).
export function unpackRange(packed, start, end) {
  return packed.map((p) => {
    const out = new Float32Array(end - start);
    const s = Math.max(0, start);
    const e = Math.min(p.length, end);
    if (e > s) unpackInto(p, out, s, e, s - start);
    return out;
  });
}

function collapse(chs, mode) {
  if (chs.length < 2 || !mode) return chs;
  if (mode === 'L') return [chs[0]];
  if (mode === 'R') return [chs[1]];
  const a = chs[0];
  const b = chs[1];
  for (let i = 0; i < a.length; i++) a[i] = 0.5 * (a[i] + b[i]);
  return [a];
}

// Shift samples by d (positive = later) in place, filling with silence.
function shift(x, d) {
  if (!d) return;
  if (d > 0) {
    x.copyWithin(d, 0, x.length - d);
    x.fill(0, 0, Math.min(d, x.length));
  } else {
    const k = -d;
    x.copyWithin(0, k);
    x.fill(0, Math.max(0, x.length - k));
  }
}

// Process channels with strip settings `st`. Returns stereo output at the
// given fader gain (dB) and some statistics for the report.
export function processStrip(input, fs, st, gainDb = 0) {
  let chs = collapse(input, st.collapse);
  const stats = {};
  if (st.polarity < 0) for (const x of chs) for (let i = 0; i < x.length; i++) x[i] = -x[i];
  if (st.delay) for (const x of chs) shift(x, st.delay);
  if (st.gate) stats.gate = expand(chs, fs, st.gate);
  if (st.eq) {
    const chain = new BiquadChain(eqCoefficients(st.eq, fs), chs.length);
    chs.forEach((x, c) => chain.process(x, c));
  }
  if (st.comp) stats.comp = compress(chs, fs, st.comp);
  if (st.deEss) stats.deEss = deEss(chs, fs, st.deEss);
  if (st.sat) {
    const dc = new BiquadChain([designOnePole('highpass', 8, fs)], chs.length);
    chs.forEach((x, c) => {
      saturate(x, st.sat);
      dc.process(x, c);
    });
  }
  const g = Math.pow(10, gainDb / 20);
  const n = chs[0].length;
  let L;
  let R;
  if (chs.length === 1) {
    const x = chs[0];
    const th = ((Math.max(-1, Math.min(1, st.pan || 0)) + 1) * Math.PI) / 4;
    const gl = Math.cos(th) * g;
    const gr = Math.sin(th) * g;
    L = new Float32Array(n);
    R = x; // reuse the input buffer for the right channel
    for (let i = 0; i < n; i++) {
      const v = x[i];
      L[i] = v * gl;
      R[i] = v * gr;
    }
  } else {
    L = chs[0];
    R = chs[1];
    const w = st.width ?? 1;
    const p = Math.max(-1, Math.min(1, st.pan || 0));
    const bl = (p > 0 ? Math.cos((p * Math.PI) / 2) : 1) * g;
    const br = (p < 0 ? Math.cos((-p * Math.PI) / 2) : 1) * g;
    for (let i = 0; i < n; i++) {
      const m = 0.5 * (L[i] + R[i]);
      const s = 0.5 * (L[i] - R[i]) * w;
      L[i] = (m + s) * bl;
      R[i] = (m - s) * br;
    }
  }
  return { L, R, stats };
}
