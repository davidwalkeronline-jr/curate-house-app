// Dynamics processors: compressor, downward expander (gate), split band
// de-esser and a lookahead true peak limiter. All work offline on arrays of
// channels (Float32Array), so there is no hidden latency: anything with
// lookahead compensates for it before returning.

import { biquadRunOffset, designBiquad, lr4, BiquadChain } from './biquad.js';
import { intersamplePeakAt, samplePeak } from './loudness.js';

const LOG10_20 = 20 / Math.LN10; // dB = LOG10_20 * ln(amplitude)
const LOG10_10 = 10 / Math.LN10;
const DB_TO_LN = Math.LN10 / 20;

function coef(ms, fs, step = 1) {
  if (ms <= 0) return 0;
  return Math.exp(-step / ((ms / 1000) * fs));
}

// Static compression curve with a soft knee (Giannoulis et al., 2012).
// Returns the desired gain reduction in dB (>= 0) for an input level x (dB).
function reductionDb(x, T, R, W) {
  const d = x - T;
  if (2 * d < -W) return 0;
  if (W > 0 && 2 * Math.abs(d) <= W) {
    const q = d + W / 2;
    return (1 - 1 / R) * ((q * q) / (2 * W));
  }
  return d * (1 - 1 / R);
}

// Feed forward compressor.
// p: { threshold (dB), ratio, knee (dB), attack (ms), release (ms),
//      rms (ms, 0 = peak detection), scHpf (Hz, 0 = off), mix (0..1),
//      makeup (dB) }
// Stereo is linked. Returns gain reduction statistics.
export function compress(chs, fs, p, start = 0, end = chs[0].length) {
  const T = p.threshold;
  const R = Math.max(1, p.ratio);
  const W = p.knee ?? 6;
  const D = 8; // gain computer runs every D samples, gain is interpolated
  const aA = coef(p.attack ?? 10, fs, D);
  const aR = coef(p.release ?? 100, fs, D);
  const aRms = p.rms > 0 ? coef(p.rms, fs, 1) : 0;
  const mix = p.mix ?? 1;
  const makeup = Math.pow(10, (p.makeup || 0) / 20);
  const nch = chs.length;
  const sc = p.scHpf > 0 ? designBiquad('highpass', p.scHpf, fs, Math.SQRT1_2) : null;
  const scState = chs.map(() => new Float64Array(2));
  const BLOCK = 4096;
  const det = new Float32Array(BLOCK);
  const scBuf = new Float32Array(BLOCK);
  let env = 0; // smoothed power for RMS mode
  let y1 = 0;
  let yL = 0;
  let gPrev = 1;
  let grSum = 0;
  let grCount = 0;
  let grMax = 0;
  for (let b = start; b < end; b += BLOCK) {
    const e = Math.min(end, b + BLOCK);
    const len = e - b;
    if (env < 1e-20) env = 0;
    if (y1 < 1e-9) y1 = 0;
    if (yL < 1e-9) yL = 0;
    // Detector input: per sample max over channels (peak) or mean power.
    det.fill(0, 0, len);
    for (let c = 0; c < nch; c++) {
      const x = chs[c];
      let src = x;
      let off = b;
      if (sc) {
        biquadRunOffset(x, b, scBuf, 0, len, sc, scState[c]);
        src = scBuf;
        off = 0;
      }
      if (p.rms > 0) {
        const w = 1 / nch;
        for (let i = 0; i < len; i++) {
          const v = src[off + i];
          det[i] += v * v * w;
        }
      } else {
        for (let i = 0; i < len; i++) {
          const v = src[off + i] < 0 ? -src[off + i] : src[off + i];
          if (v > det[i]) det[i] = v;
        }
      }
    }
    for (let i0 = 0; i0 < len; i0 += D) {
      const i1 = Math.min(len, i0 + D);
      let level;
      if (p.rms > 0) {
        for (let i = i0; i < i1; i++) env = aRms * env + (1 - aRms) * det[i];
        level = LOG10_10 * Math.log(env + 1e-20);
      } else {
        let pk = 0;
        for (let i = i0; i < i1; i++) if (det[i] > pk) pk = det[i];
        level = LOG10_20 * Math.log(pk + 1e-10);
      }
      const xL = reductionDb(level, T, R, W);
      const r1 = aR * y1 + (1 - aR) * xL;
      y1 = xL > r1 ? xL : r1;
      yL = aA * yL + (1 - aA) * y1;
      const g = Math.exp(-yL * DB_TO_LN);
      if (level > -60) {
        grSum += yL;
        grCount++;
      }
      if (yL > grMax) grMax = yL;
      // Interpolate gain across the D samples.
      const n = i1 - i0;
      const step = (g - gPrev) / n;
      for (let c = 0; c < nch; c++) {
        const x = chs[c];
        let gg = gPrev;
        for (let i = i0; i < i1; i++) {
          gg += step;
          const v = x[b + i];
          x[b + i] = (v * (1 - mix) + v * gg * mix) * makeup;
        }
      }
      gPrev = g;
    }
  }
  return { avgGr: grCount ? grSum / grCount : 0, maxGr: grMax };
}

// Downward expander / gate.
// p: { threshold (dB), ratio (>1), range (dB, max attenuation),
//      attack (ms, opening), hold (ms), release (ms, closing) }
export function expand(chs, fs, p, start = 0, end = chs[0].length) {
  const T = p.threshold;
  const ratio = Math.max(1, p.ratio ?? 3);
  const range = p.range ?? 15;
  const D = 4;
  const aOpen = coef(p.attack ?? 0.5, fs, D);
  const aClose = coef(p.release ?? 120, fs, D);
  const holdSteps = Math.round(((p.hold ?? 50) / 1000) * fs / D);
  const nch = chs.length;
  let gr = range; // start closed
  let hold = 0;
  let gPrev = Math.exp(-gr * DB_TO_LN);
  let closedSteps = 0;
  let steps = 0;
  for (let i0 = start; i0 < end; i0 += D) {
    const i1 = Math.min(end, i0 + D);
    let pk = 0;
    for (let c = 0; c < nch; c++) {
      const x = chs[c];
      for (let i = i0; i < i1; i++) {
        const v = x[i] < 0 ? -x[i] : x[i];
        if (v > pk) pk = v;
      }
    }
    const level = LOG10_20 * Math.log(pk + 1e-10);
    let target;
    if (level >= T) {
      target = 0;
      hold = holdSteps;
    } else if (hold > 0) {
      target = 0;
      hold--;
    } else {
      target = Math.min(range, (T - level) * (ratio - 1));
    }
    const a = target < gr ? aOpen : aClose;
    gr = a * gr + (1 - a) * target;
    if (gr < 1e-9) gr = 0;
    if (gr > range * 0.5) closedSteps++;
    steps++;
    const g = Math.exp(-gr * DB_TO_LN);
    const n = i1 - i0;
    const step = (g - gPrev) / n;
    for (let c = 0; c < nch; c++) {
      const x = chs[c];
      let gg = gPrev;
      for (let i = i0; i < i1; i++) {
        gg += step;
        x[i] *= gg;
      }
    }
    gPrev = g;
  }
  return { closedRatio: steps ? closedSteps / steps : 0 };
}

// Split band de-esser in relative mode: the high band is turned down when its
// share of the total energy rises above `thresholdRel` dB, which catches
// sibilance regardless of the overall vocal level.
// p: { freq (Hz), thresholdRel (dB, e.g. -8), ratio, range (dB),
//      attack (ms), release (ms) }
export function deEss(chs, fs, p, start = 0, end = chs[0].length) {
  const { low, high } = lr4(p.freq ?? 5500, fs);
  const nch = chs.length;
  const lowChain = new BiquadChain(low, nch);
  const highChain = new BiquadChain(high, nch);
  const thr = p.thresholdRel ?? -8;
  const R = Math.max(1, p.ratio ?? 3);
  const range = p.range ?? 8;
  const aDet = coef(3, fs, 1);
  const DS = 4;
  const aA = coef(p.attack ?? 1, fs, DS);
  const aR = coef(p.release ?? 60, fs, DS);
  const BLOCK = 4096;
  const lows = chs.map(() => new Float32Array(BLOCK));
  const highs = chs.map(() => new Float32Array(BLOCK));
  let eFull = 0;
  let eHigh = 0;
  let gr = 0;
  let gPrev = 1;
  let grMax = 0;
  let active = 0;
  let total = 0;
  for (let b = start; b < end; b += BLOCK) {
    const e = Math.min(end, b + BLOCK);
    const len = e - b;
    for (let c = 0; c < nch; c++) {
      lows[c].set(chs[c].subarray(b, e));
      highs[c].set(chs[c].subarray(b, e));
      lowChain.process(lows[c], c, 0, len);
      highChain.process(highs[c], c, 0, len);
    }
    for (let i0 = 0; i0 < len; i0 += DS) {
      const i1 = Math.min(len, i0 + DS);
      for (let i = i0; i < i1; i++) {
        let pf = 0;
        let ph = 0;
        for (let c = 0; c < nch; c++) {
          const v = chs[c][b + i];
          const h = highs[c][i];
          pf += v * v;
          ph += h * h;
        }
        eFull = aDet * eFull + (1 - aDet) * pf;
        eHigh = aDet * eHigh + (1 - aDet) * ph;
      }
      let target = 0;
      if (eFull > 1e-7) {
        const rel = LOG10_10 * Math.log((eHigh + 1e-20) / eFull);
        if (rel > thr) target = Math.min(range, (rel - thr) * (1 - 1 / R));
      }
      const a = target > gr ? aA : aR;
      gr = a * gr + (1 - a) * target;
      if (gr < 1e-9) gr = 0;
      if (gr > grMax) grMax = gr;
      if (gr > 1) active++;
      total++;
      const g = Math.exp(-gr * DB_TO_LN);
      const step = (g - gPrev) / (i1 - i0);
      for (let c = 0; c < nch; c++) {
        const x = chs[c];
        const lo = lows[c];
        const hi = highs[c];
        let gg = gPrev;
        for (let i = i0; i < i1; i++) {
          gg += step;
          x[b + i] = lo[i] + hi[i] * gg;
        }
      }
      gPrev = g;
    }
    if (eFull < 1e-20) eFull = 0;
    if (eHigh < 1e-20) eHigh = 0;
  }
  return { maxGr: grMax, activeRatio: total ? active / total : 0 };
}

// ---------------------------------------------------------------------------
// Lookahead true peak limiter.
//
// prepareLimiter() computes, once, the per sample oversampled peak (max over
// channels of the 4x interpolated signal on [n, n+1)). limiterEnvelope() then
// turns that into a smooth gain curve for any input gain cheaply, which lets
// the mastering stage search for the input gain that hits a loudness target.

// `minLevel` (linear) is the lowest sample level that could reach the
// ceiling at the largest input gain the caller will try; inter-sample peaks
// are only interpolated at or above it (they only matter where limiting
// happens), which keeps preparation cheap.
export function prepareLimiter(chs, minLevel = 0) {
  const n = chs[0].length;
  const pk = new Float32Array(n);
  const sp = samplePeak(chs);
  const thr = Math.max(minLevel, sp * 1e-3);
  for (const x of chs) {
    for (let i = 0; i < n; i++) {
      const a = x[i] < 0 ? -x[i] : x[i];
      const nb = i + 1 < n ? (x[i + 1] < 0 ? -x[i + 1] : x[i + 1]) : 0;
      let v = a > nb ? a : nb;
      if (v >= thr) {
        const t = intersamplePeakAt(x, i);
        if (t > v) v = t;
      }
      if (v > pk[i]) pk[i] = v;
    }
  }
  return { pk, samplePeak: sp };
}

// Gain envelope g (length n) to apply as out[j] = G * x[j] * g[j], keeping
// the (oversampled) output peaks at or below `ceiling`.
//  * required gain r = min(1, ceiling / (G * peak)) with instant attack and
//    exponential release of the reduction (linear domain),
//  * a sliding minimum over the lookahead window,
//  * a box average over the same window, which ramps the gain down smoothly
//    ahead of each peak and provably never exceeds the required gain.
export function limiterEnvelope(prep, G, ceiling, lookahead, release) {
  const pk = prep.pk;
  const n = pk.length;
  const L = Math.max(1, lookahead | 0);
  const total = n + L - 1;
  const env = new Float32Array(n);
  const aRel = Math.exp(-1 / Math.max(1, release));
  const cg = ceiling / G;
  const cap = L + 1;
  const dqIdx = new Int32Array(cap);
  const dqVal = new Float64Array(cap);
  let head = 0;
  let tail = 0;
  const boxBuf = new Float64Array(L).fill(1);
  let boxSum = L;
  let boxPos = 0;
  let red = 0; // current reduction 1 - gain
  const invL = 1 / L;
  for (let i = 0; i < total; i++) {
    const p = i < n ? pk[i] : 0;
    const need = p > cg ? 1 - cg / p : 0;
    red *= aRel;
    if (red < 1e-9) red = 0;
    if (need > red) red = need;
    const r = 1 - red;
    while (tail !== head) {
      const last = tail === 0 ? cap - 1 : tail - 1;
      if (dqVal[last] >= r) tail = last;
      else break;
    }
    dqIdx[tail] = i;
    dqVal[tail] = r;
    tail = tail + 1 === cap ? 0 : tail + 1;
    while (dqIdx[head] <= i - L) head = head + 1 === cap ? 0 : head + 1;
    const m = dqVal[head];
    boxSum += m - boxBuf[boxPos];
    boxBuf[boxPos] = m;
    boxPos = boxPos + 1 === L ? 0 : boxPos + 1;
    const j = i - (L - 1);
    if (j >= 0) {
      const g = boxSum * invL;
      env[j] = g > 1 ? 1 : g;
    }
  }
  return env;
}

export function applyEnvelope(chs, G, env, out) {
  const n = env.length;
  const res = out || chs.map(() => new Float32Array(n));
  for (let c = 0; c < chs.length; c++) {
    const x = chs[c];
    const y = res[c];
    for (let i = 0; i < n; i++) y[i] = G * x[i] * env[i];
  }
  return res;
}

export function envelopeStats(env) {
  let min = 1;
  let sumDb = 0;
  let cnt = 0;
  for (let i = 0; i < env.length; i += 16) {
    const g = env[i];
    if (g < min) min = g;
    if (g < 0.9999) {
      sumDb += -20 * Math.log10(g);
      cnt++;
    }
  }
  return {
    maxGr: -20 * Math.log10(Math.max(min, 1e-6)),
    avgGrWhenActive: cnt ? sumDb / cnt : 0,
    activeRatio: cnt / Math.max(1, Math.ceil(env.length / 16)),
  };
}
