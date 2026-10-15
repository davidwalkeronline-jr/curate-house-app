// Loudness and peak metering per ITU-R BS.1770-4 / EBU R128 (Tech 3341/3342).

import { biquadRun, biquadRunOffset } from './biquad.js';
import { percentile } from './util.js';

// K-weighting filter (pre filter shelf + RLB high pass) for any sample rate,
// using the analogue prototype parameters (as libebur128 does).
export function kWeightingSections(fs) {
  let f0 = 1681.974450955533;
  const G = 3.999843853973347;
  let Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / fs);
  const Vh = Math.pow(10, G / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const s1 = Float64Array.of(
    (Vh + (Vb * K) / Q + K * K) / a0,
    (2 * (K * K - Vh)) / a0,
    (Vh - (Vb * K) / Q + K * K) / a0,
    (2 * (K * K - 1)) / a0,
    (1 - K / Q + K * K) / a0,
  );
  f0 = 38.13547087602444;
  Q = 0.5003270373238773;
  K = Math.tan((Math.PI * f0) / fs);
  a0 = 1 + K / Q + K * K;
  const s2 = Float64Array.of(1, -2, 1, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0);
  return [s1, s2];
}

const LOUDNESS_OFFSET = -0.691;

// Sum over channels of K-weighted squared samples in 100 ms sub-blocks.
// sums[k] covers samples [start + k*n100, start + (k+1)*n100). A trailing
// partial sub-block is dropped, as BS.1770 ignores incomplete blocks.
export function kPowerBlocks(channels, fs, start = 0, end = channels[0].length) {
  const n100 = Math.round(fs * 0.1);
  const nBlocks = Math.max(0, Math.floor((end - start) / n100));
  const sums = new Float64Array(nBlocks);
  if (!nBlocks) return { sums, n100, fs };
  const [k1, k2] = kWeightingSections(fs);
  const tmp = new Float32Array(n100);
  for (const x of channels) {
    const st1 = new Float64Array(2);
    const st2 = new Float64Array(2);
    for (let b = 0; b < nBlocks; b++) {
      biquadRunOffset(x, start + b * n100, tmp, 0, n100, k1, st1);
      biquadRun(tmp, k2, st2, 0, n100);
      let acc = 0;
      for (let i = 0; i < n100; i++) acc += tmp[i] * tmp[i];
      sums[b] += acc;
    }
  }
  return { sums, n100, fs };
}

function blockLoudness(sum, n) {
  return LOUDNESS_OFFSET + 10 * Math.log10(Math.max(sum / n, 1e-30));
}

// Gated integrated loudness from 100 ms sub-block sums.
export function integratedFromBlocks({ sums, n100 }) {
  const nb = sums.length - 3;
  if (nb <= 0) return -Infinity;
  const z = new Float64Array(nb);
  const n400 = 4 * n100;
  for (let j = 0; j < nb; j++) z[j] = (sums[j] + sums[j + 1] + sums[j + 2] + sums[j + 3]) / n400;
  let acc = 0;
  let cnt = 0;
  for (let j = 0; j < nb; j++) {
    if (LOUDNESS_OFFSET + 10 * Math.log10(z[j] + 1e-30) > -70) {
      acc += z[j];
      cnt++;
    }
  }
  if (!cnt) return -Infinity;
  const rel = LOUDNESS_OFFSET + 10 * Math.log10(acc / cnt) - 10;
  acc = 0;
  cnt = 0;
  for (let j = 0; j < nb; j++) {
    const l = LOUDNESS_OFFSET + 10 * Math.log10(z[j] + 1e-30);
    if (l > -70 && l > rel) {
      acc += z[j];
      cnt++;
    }
  }
  if (!cnt) return -Infinity;
  return LOUDNESS_OFFSET + 10 * Math.log10(acc / cnt);
}

// Loudness series over a sliding window of `win` sub-blocks (hop 100 ms).
// win = 4 gives momentary loudness, win = 30 gives short-term loudness.
export function windowSeries({ sums, n100 }, win) {
  const nb = sums.length - win + 1;
  if (nb <= 0) return new Float32Array(0);
  const out = new Float32Array(nb);
  let acc = 0;
  for (let k = 0; k < win; k++) acc += sums[k];
  const n = win * n100;
  out[0] = blockLoudness(acc, n);
  for (let j = 1; j < nb; j++) {
    acc += sums[j + win - 1] - sums[j - 1];
    out[j] = blockLoudness(Math.max(acc, 0), n);
  }
  return out;
}

// Loudness range (EBU Tech 3342) from short-term loudness values.
export function loudnessRangeFromShortTerm(st) {
  const abs = [];
  for (let i = 0; i < st.length; i++) if (st[i] > -70) abs.push(st[i]);
  if (abs.length < 2) return 0;
  let acc = 0;
  for (const l of abs) acc += Math.pow(10, l / 10);
  const rel = 10 * Math.log10(acc / abs.length) - 20;
  const kept = abs.filter((l) => l > rel);
  if (kept.length < 2) return 0;
  return percentile(kept, 95) - percentile(kept, 10);
}

// Full loudness summary of a set of channels.
export function measureLoudness(channels, fs, start = 0, end = channels[0].length) {
  const blocks = kPowerBlocks(channels, fs, start, end);
  const integrated = integratedFromBlocks(blocks);
  const st = windowSeries(blocks, 30);
  const mom = windowSeries(blocks, 4);
  let stMax = -Infinity;
  for (let i = 0; i < st.length; i++) if (st[i] > stMax) stMax = st[i];
  let mMax = -Infinity;
  for (let i = 0; i < mom.length; i++) if (mom[i] > mMax) mMax = mom[i];
  return {
    integrated,
    shortTermMax: stMax,
    momentaryMax: mMax,
    lra: loudnessRangeFromShortTerm(st),
    blocks,
  };
}

// Quick integrated loudness only.
export function integratedLoudness(channels, fs, start = 0, end = channels[0].length) {
  return integratedFromBlocks(kPowerBlocks(channels, fs, start, end));
}

export function samplePeak(channels, start = 0, end = channels[0].length) {
  let pk = 0;
  for (const x of channels) {
    for (let i = start; i < end; i++) {
      const a = x[i] < 0 ? -x[i] : x[i];
      if (a > pk) pk = a;
    }
  }
  return pk;
}

// ---------------------------------------------------------------------------
// True peak: 4x oversampled interpolation with a Kaiser windowed sinc.

const TP_HALF = 8; // taps either side, 16 taps per phase
let tpTable = null;

function besselI0(x) {
  let sum = 1;
  let term = 1;
  for (let k = 1; k < 30; k++) {
    term *= (x / (2 * k)) * (x / (2 * k));
    sum += term;
    if (term < 1e-12 * sum) break;
  }
  return sum;
}

function truePeakTable() {
  if (tpTable) return tpTable;
  const beta = 6;
  const i0b = besselI0(beta);
  const taps = 2 * TP_HALF;
  tpTable = [];
  for (let p = 1; p <= 3; p++) {
    const t = p / 4;
    const h = new Float64Array(taps);
    let sum = 0;
    for (let j = 0; j < taps; j++) {
      const k = j - TP_HALF + 1; // k from -7 .. 8
      const tau = t - k;
      const x = tau / TP_HALF;
      const w = Math.abs(x) >= 1 ? 0 : besselI0(beta * Math.sqrt(1 - x * x)) / i0b;
      const s = tau === 0 ? 1 : Math.sin(Math.PI * tau) / (Math.PI * tau);
      h[j] = s * w;
      sum += h[j];
    }
    for (let j = 0; j < taps; j++) h[j] /= sum;
    tpTable.push(h);
  }
  return tpTable;
}

// Largest absolute value of the 4x oversampled signal on the interval
// [n, n+1) of channel x. Assumes n is at least TP_HALF from the ends,
// otherwise out of range samples count as zero.
export function intersamplePeakAt(x, n) {
  const tbl = truePeakTable();
  const len = x.length;
  let pk = x[n] < 0 ? -x[n] : x[n];
  const base = n - TP_HALF + 1;
  const safe = base >= 0 && base + 2 * TP_HALF <= len;
  for (let p = 0; p < 3; p++) {
    const h = tbl[p];
    let acc = 0;
    if (safe) {
      for (let j = 0; j < 2 * TP_HALF; j++) acc += h[j] * x[base + j];
    } else {
      for (let j = 0; j < 2 * TP_HALF; j++) {
        const idx = base + j;
        if (idx >= 0 && idx < len) acc += h[j] * x[idx];
      }
    }
    const a = acc < 0 ? -acc : acc;
    if (a > pk) pk = a;
  }
  return pk;
}

// True peak (linear) of a set of channels. Interpolation is only evaluated
// near samples within `searchDb` of the sample peak, which is where any
// inter-sample over can occur for real programme material.
export function truePeak(channels, start = 0, end = channels[0].length, searchDb = 9) {
  const sp = samplePeak(channels, start, end);
  if (sp === 0) return 0;
  const thr = sp * Math.pow(10, -searchDb / 20);
  let pk = sp;
  for (const x of channels) {
    for (let n = start; n < end; n++) {
      const a = x[n] < 0 ? -x[n] : x[n];
      const b = n + 1 < end ? (x[n + 1] < 0 ? -x[n + 1] : x[n + 1]) : 0;
      if (a < thr && b < thr) continue;
      const v = intersamplePeakAt(x, n);
      if (v > pk) pk = v;
    }
  }
  return pk;
}
