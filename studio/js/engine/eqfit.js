// Fit a small set of parametric EQ bands (shelves and bells) to a desired
// correction curve. Greedy placement followed by coordinate descent on the
// gains and a local frequency/Q search. The result is a handful of moves an
// engineer would recognise ("-2.5 dB at 320 Hz, Q 1.4").

import { designBiquad, biquadDb } from './biquad.js';
import { ANALYSIS_GRID } from './spectrum.js';

export function sectionCoefs(s, fs) {
  return designBiquad(s.type, s.f, fs, s.q, s.gain);
}

function responseDb(s, grid, fs) {
  const c = sectionCoefs(s, fs);
  const out = new Float64Array(grid.length);
  for (let i = 0; i < grid.length; i++) out[i] = biquadDb(c, grid[i], fs);
  return out;
}

export function totalResponse(sections, grid, fs) {
  const out = new Float64Array(grid.length);
  for (const s of sections) {
    const r = responseDb(s, grid, fs);
    for (let i = 0; i < grid.length; i++) out[i] += r[i];
  }
  return out;
}

function defaultWeight(f) {
  if (f < 30) return 0.25;
  if (f < 45) return 0.6;
  if (f > 17000) return 0.3;
  if (f > 13000) return 0.6;
  return 1;
}

// Least squares optimal gain for one section shape given the residual.
// The dB response of a bell/shelf is close to proportional to its gain, so
// project using the unit (1 dB) shape, then clamp.
function bestGain(s, residual, w, grid, fs, lo, hi) {
  const unit = responseDb({ ...s, gain: 1 }, grid, fs);
  let num = 0;
  let den = 0;
  for (let i = 0; i < grid.length; i++) {
    num += w[i] * residual[i] * unit[i];
    den += w[i] * unit[i] * unit[i];
  }
  if (den <= 0) return 0;
  return Math.max(lo, Math.min(hi, num / den));
}

function weightedSq(residual, w) {
  let e = 0;
  for (let i = 0; i < residual.length; i++) e += w[i] * residual[i] * residual[i];
  return e;
}

function qFromWidth(octaves) {
  const bw = Math.max(0.15, Math.min(4, octaves));
  return 1 / (2 * Math.sinh((Math.LN2 / 2) * bw));
}

// opts: { maxBands, maxBoost, maxCut (negative), qMin, qMax, fMin, fMax,
//         shelves (bool), lowShelfRange [lo, hi], highShelfRange [lo, hi],
//         minGain (drop smaller moves), grid, weight(f) }
export function fitEq(target, fs, opts = {}) {
  const grid = opts.grid || ANALYSIS_GRID;
  const maxBands = opts.maxBands ?? 5;
  const maxBoost = opts.maxBoost ?? 4;
  const maxCut = opts.maxCut ?? -6;
  const qMin = opts.qMin ?? 0.5;
  const qMax = opts.qMax ?? 4;
  const fMin = opts.fMin ?? 25;
  const fMax = Math.min(opts.fMax ?? 16000, fs * 0.45);
  const minGain = opts.minGain ?? 0.4;
  const wfn = opts.weight || defaultWeight;
  const w = new Float64Array(grid.length);
  for (let i = 0; i < grid.length; i++) w[i] = grid[i] < fMin * 0.7 || grid[i] > fMax * 1.2 ? 0 : wfn(grid[i]);
  const residual = Float64Array.from(target);
  const sections = [];
  const subtract = (s, sign = 1) => {
    const r = responseDb(s, grid, fs);
    for (let i = 0; i < grid.length; i++) residual[i] -= sign * r[i];
  };

  // Shelves first: they capture broad tilts at the extremes.
  if (opts.shelves !== false) {
    for (const kind of ['lowshelf', 'highshelf']) {
      if (sections.length >= maxBands) break;
      const range = kind === 'lowshelf' ? opts.lowShelfRange || [60, 250] : opts.highShelfRange || [3500, 12000];
      let best = null;
      let bestGainV = 0;
      let bestErr = weightedSq(residual, w);
      const base = bestErr;
      for (let f = range[0]; f <= range[1]; f *= Math.pow(2, 1 / 6)) {
        const s = { type: kind, f, q: Math.SQRT1_2, gain: 0 };
        const g = bestGain(s, residual, w, grid, fs, maxCut, maxBoost);
        if (Math.abs(g) < minGain) continue;
        s.gain = g;
        const r = responseDb(s, grid, fs);
        let e = 0;
        for (let i = 0; i < grid.length; i++) {
          const d = residual[i] - r[i];
          e += w[i] * d * d;
        }
        if (e < bestErr) {
          bestErr = e;
          best = s;
          bestGainV = g;
        }
      }
      if (best && bestErr < base * 0.85) {
        best.gain = bestGainV;
        sections.push(best);
        subtract(best);
      }
    }
  }

  // Greedy bells at the largest remaining deviations.
  while (sections.length < maxBands) {
    let iMax = -1;
    let vMax = 0;
    for (let i = 0; i < grid.length; i++) {
      if (grid[i] < fMin || grid[i] > fMax) continue;
      const v = Math.abs(residual[i]) * w[i];
      if (v > vMax) {
        vMax = v;
        iMax = i;
      }
    }
    if (iMax < 0 || vMax < Math.max(0.5, minGain)) break;
    const peak = residual[iMax];
    const half = peak / 2;
    let lo = iMax;
    let hi = iMax;
    while (lo > 0 && Math.sign(residual[lo - 1]) === Math.sign(peak) && Math.abs(residual[lo - 1]) > Math.abs(half)) lo--;
    while (hi < grid.length - 1 && Math.sign(residual[hi + 1]) === Math.sign(peak) && Math.abs(residual[hi + 1]) > Math.abs(half)) hi++;
    const octaves = Math.log2(grid[hi] / grid[lo]) + 1 / 12;
    const q = Math.max(qMin, Math.min(qMax, qFromWidth(octaves)));
    const s = { type: 'peaking', f: grid[iMax], q, gain: 0 };
    s.gain = bestGain(s, residual, w, grid, fs, maxCut, maxBoost);
    if (Math.abs(s.gain) < minGain) {
      // Cannot improve here (e.g. clamped); stop to avoid looping.
      break;
    }
    sections.push(s);
    subtract(s);
  }

  // Refinement: re-optimise each band with the others fixed.
  for (let pass = 0; pass < 3; pass++) {
    for (const s of sections) {
      subtract(s, -1); // add back
      // Local search over frequency and Q (bells) or frequency (shelves).
      let best = { ...s };
      let bestErr = Infinity;
      const fSteps = [-2, -1, 0, 1, 2].map((k) => s.f * Math.pow(2, k / 12));
      const qSteps = s.type === 'peaking' ? [s.q / 1.3, s.q, s.q * 1.3].map((q) => Math.max(qMin, Math.min(qMax, q))) : [s.q];
      for (const f of fSteps) {
        if (f < fMin * 0.8 || f > fMax * 1.05) continue;
        for (const q of qSteps) {
          const c = { type: s.type, f, q, gain: 0 };
          c.gain = bestGain(c, residual, w, grid, fs, maxCut, maxBoost);
          const r = responseDb(c, grid, fs);
          let e = 0;
          for (let i = 0; i < grid.length; i++) {
            const d = residual[i] - r[i];
            e += w[i] * d * d;
          }
          if (e < bestErr) {
            bestErr = e;
            best = c;
          }
        }
      }
      Object.assign(s, best);
      subtract(s);
    }
  }
  const kept = sections.filter((s) => Math.abs(s.gain) >= minGain);
  kept.sort((a, b) => a.f - b.f);
  return kept.map((s) => ({ type: s.type, f: Math.round(s.f), q: Math.round(s.q * 100) / 100, gain: Math.round(s.gain * 10) / 10 }));
}

// Smooth a curve on a log grid with a moving average `widthOct` wide.
export function smoothCurve(curve, widthOct, perOctave = 12) {
  const half = Math.max(0, Math.round((widthOct * perOctave) / 2));
  if (!half) return Float64Array.from(curve);
  const out = new Float64Array(curve.length);
  for (let i = 0; i < curve.length; i++) {
    let s = 0;
    let c = 0;
    for (let k = i - half; k <= i + half; k++) {
      if (k < 0 || k >= curve.length) continue;
      s += curve[k];
      c++;
    }
    out[i] = s / c;
  }
  return out;
}

// Change in overall level (dB) a filter set causes on a signal whose pink
// referenced tonal curve is `curve` (on ANALYSIS_GRID). Used to predict the
// level a compressor will see after EQ.
export function levelChangeDb(curve, sectionsCoefs, fs, grid = ANALYSIS_GRID) {
  let num = 0;
  let den = 0;
  for (let i = 0; i < grid.length; i++) {
    const wgt = Math.pow(10, curve[i] / 10);
    let h = 0;
    for (const c of sectionsCoefs) h += biquadDb(c, grid[i], fs);
    num += wgt * Math.pow(10, h / 10);
    den += wgt;
  }
  return den > 0 ? 10 * Math.log10(num / den) : 0;
}
