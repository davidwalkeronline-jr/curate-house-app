// Long term average spectrum (LTAS), fractional octave smoothing and stereo
// width analysis.

import { fft, hann, accumulatePair } from './fft.js';
import { logGrid, powToDb } from './util.js';

export function fftSizeFor(fs) {
  return fs > 50000 ? 16384 : 8192;
}

// Average power spectra of the loud part of a signal.
// channels: [x] or [L, R]. Frames quieter than `gateDb` below the loudest
// frame are skipped so silence and fades do not dilute the average.
export function ltas(channels, fs, opts = {}) {
  const n = opts.fftSize || fftSizeFor(fs);
  const hop = n >> 1;
  const start = opts.start || 0;
  const end = opts.end ?? channels[0].length;
  const gateDb = opts.gateDb ?? 25;
  const maxFrames = opts.maxFrames ?? 700;
  const L = channels[0];
  const R = channels[1] || channels[0];
  const stereo = channels.length > 1;
  const half = n >> 1;
  const accL = new Float64Array(half + 1);
  const accR = stereo ? new Float64Array(half + 1) : null;
  const accM = stereo ? new Float64Array(half + 1) : null;
  const accS = stereo ? new Float64Array(half + 1) : null;

  // Frame energies (on a decimated read to keep this cheap).
  const positions = [];
  const energies = [];
  for (let p = start; p + n <= end; p += hop) {
    let e = 0;
    for (let i = p; i < p + n; i += 4) {
      const a = L[i];
      const b = R[i];
      e += a * a + b * b;
    }
    positions.push(p);
    energies.push(e);
  }
  if (!positions.length) {
    return { n, fs, frames: 0, L: accL, R: accR, M: accM, S: accS };
  }
  let maxE = 0;
  for (const e of energies) if (e > maxE) maxE = e;
  const thr = maxE * Math.pow(10, -gateDb / 10);
  let chosen = [];
  for (let i = 0; i < positions.length; i++) if (energies[i] >= thr && energies[i] > 0) chosen.push(positions[i]);
  if (chosen.length > maxFrames) {
    const step = chosen.length / maxFrames;
    const sub = [];
    for (let i = 0; i < maxFrames; i++) sub.push(chosen[Math.floor(i * step)]);
    chosen = sub;
  }
  const w = hann(n);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (const p of chosen) {
    for (let i = 0; i < n; i++) {
      re[i] = L[p + i] * w[i];
      im[i] = R[p + i] * w[i];
    }
    fft(re, im);
    accumulatePair(re, im, accL, accR, accM, accS);
  }
  // Normalise to mean power per bin with window power compensation.
  let wp = 0;
  for (let i = 0; i < n; i++) wp += w[i] * w[i];
  const norm = chosen.length ? 1 / (chosen.length * wp) : 0;
  for (const acc of [accL, accR, accM, accS]) {
    if (!acc) continue;
    for (let k = 0; k <= half; k++) acc[k] *= norm;
  }
  return { n, fs, frames: chosen.length, L: accL, R: accR, M: accM, S: accS };
}

// Combined (L+R power) spectrum of an LTAS result.
export function totalPower(spec) {
  if (!spec.R) return spec.L;
  const out = new Float64Array(spec.L.length);
  for (let k = 0; k < out.length; k++) out[k] = spec.L[k] + spec.R[k];
  return out;
}

// Pink referenced level (dB) of a power spectrum averaged over a band of
// `widthOct` octaves around each grid frequency. Pink noise reads flat.
export function smoothToGrid(power, fs, n, gridFreqs, widthOct = 1 / 3) {
  const df = fs / n;
  const maxK = power.length - 1;
  const out = new Float64Array(gridFreqs.length);
  const g = Math.pow(2, widthOct / 2);
  for (let i = 0; i < gridFreqs.length; i++) {
    const f = gridFreqs[i];
    const lo = f / g;
    const hi = f * g;
    let k0 = Math.ceil(lo / df);
    let k1 = Math.floor(hi / df);
    let mean;
    if (k1 < k0) {
      // Band narrower than a bin: interpolate the nearest two bins.
      const kf = f / df;
      const ka = Math.min(maxK, Math.max(1, Math.floor(kf)));
      const kb = Math.min(maxK, ka + 1);
      const t = kf - ka;
      mean = power[ka] * (1 - t) + power[kb] * t;
    } else {
      k0 = Math.max(1, k0);
      k1 = Math.min(maxK, k1);
      let s = 0;
      for (let k = k0; k <= k1; k++) s += power[k];
      mean = s / Math.max(1, k1 - k0 + 1);
    }
    out[i] = powToDb(mean * f);
  }
  return out;
}

export const ANALYSIS_GRID = logGrid(20, 20000, 12);

// Smoothed tonal balance curve on the shared analysis grid (1/12 octave
// spacing), with the given smoothing width.
export function tonalCurve(power, fs, n, widthOct = 1 / 3) {
  return smoothToGrid(power, fs, n, ANALYSIS_GRID, widthOct);
}

// Mean of a curve between two frequencies (on ANALYSIS_GRID).
export function curveMean(curve, fLo, fHi, grid = ANALYSIS_GRID) {
  let s = 0;
  let c = 0;
  for (let i = 0; i < grid.length; i++) {
    if (grid[i] >= fLo && grid[i] <= fHi) {
      s += curve[i];
      c++;
    }
  }
  return c ? s / c : 0;
}

// Curve shifted so its mean over the body of the spectrum is 0 dB.
export function normaliseCurve(curve, fLo = 250, fHi = 4000, grid = ANALYSIS_GRID) {
  const m = curveMean(curve, fLo, fHi, grid);
  return Float64Array.from(curve, (v) => v - m);
}

// Band power (sum over bins) between two frequencies.
export function bandPower(power, fs, n, fLo, fHi) {
  const df = fs / n;
  const k0 = Math.max(1, Math.ceil(fLo / df));
  const k1 = Math.min(power.length - 1, Math.floor(fHi / df));
  let s = 0;
  for (let k = k0; k <= k1; k++) s += power[k];
  return s;
}

export const WIDTH_BANDS = [
  { id: 'low', lo: 20, hi: 150 },
  { id: 'mid', lo: 150, hi: 2500 },
  { id: 'high', lo: 2500, hi: 16000 },
];

// Side to mid power ratio (dB) per band; -inf for mono.
export function widthProfile(spec) {
  const out = {};
  for (const b of WIDTH_BANDS) {
    if (!spec.M) {
      out[b.id] = -60;
      continue;
    }
    const m = bandPower(spec.M, spec.fs, spec.n, b.lo, b.hi);
    const s = bandPower(spec.S, spec.fs, spec.n, b.lo, b.hi);
    out[b.id] = Math.max(-60, powToDb(s) - powToDb(m));
  }
  return out;
}

// Time domain correlation between L and R (1 = mono, 0 = uncorrelated).
export function stereoCorrelation(L, R, start = 0, end = L.length, step = 2) {
  let lr = 0;
  let ll = 0;
  let rr = 0;
  for (let i = start; i < end; i += step) {
    lr += L[i] * R[i];
    ll += L[i] * L[i];
    rr += R[i] * R[i];
  }
  if (ll === 0 || rr === 0) return 1;
  return lr / Math.sqrt(ll * rr);
}
