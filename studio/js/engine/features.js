// Per stem analysis. Everything the planner needs to make mixing decisions
// is measured here once per stem: activity, level statistics, loudness,
// tonal balance, sibilance, transients, periodicity and stereo image.

import { designBiquad, biquadRunOffset } from './biquad.js';
import { kPowerBlocks, integratedFromBlocks, windowSeries, loudnessRangeFromShortTerm } from './loudness.js';
import { ltas, totalPower, tonalCurve, smoothToGrid, bandPower, widthProfile, stereoCorrelation, ANALYSIS_GRID } from './spectrum.js';
import { percentiles, OCTAVE_CENTRES, powToDb } from './util.js';

const LOG10_10 = 10 / Math.LN10;

// Stereo relationship of a two channel stem: dual mono, one sided or real
// stereo. Measured on a decimated read.
export function stereoCheck(L, R) {
  let ll = 0;
  let rr = 0;
  let lr = 0;
  let dd = 0;
  let inv = 0;
  for (let i = 0; i < L.length; i += 3) {
    const a = L[i];
    const b = R[i];
    ll += a * a;
    rr += b * b;
    lr += a * b;
    const d = a - b;
    dd += d * d;
    const s = a + b;
    inv += s * s;
  }
  const tot = ll + rr;
  if (tot === 0) return { kind: 'silent', correlation: 1, balanceDb: 0 };
  const corr = ll > 0 && rr > 0 ? lr / Math.sqrt(ll * rr) : 1;
  const balanceDb = powToDb(ll) - powToDb(rr);
  let kind = 'stereo';
  if (rr < ll * 1e-5) kind = 'left-only';
  else if (ll < rr * 1e-5) kind = 'right-only';
  else if (dd < tot * 1e-4) kind = 'dual-mono';
  else if (inv < tot * 1e-4) kind = 'inverted-mono';
  return { kind, correlation: corr, balanceDb };
}

// 10 ms RMS and peak envelopes (dB).
function envelopes(chs, fs) {
  const hop = Math.round(fs * 0.01);
  const n = chs[0].length;
  const frames = Math.floor(n / hop);
  const rms = new Float32Array(frames);
  const peak = new Float32Array(frames);
  const nch = chs.length;
  for (let f = 0; f < frames; f++) {
    let e = 0;
    let pk = 0;
    const s = f * hop;
    for (let c = 0; c < nch; c++) {
      const x = chs[c];
      for (let i = s; i < s + hop; i++) {
        const v = x[i];
        e += v * v;
        const a = v < 0 ? -v : v;
        if (a > pk) pk = a;
      }
    }
    rms[f] = LOG10_10 * Math.log(e / (hop * nch) + 1e-20);
    peak[f] = 20 * Math.log10(pk + 1e-10);
  }
  return { rms, peak, hop };
}

// Relative energy of the 5 to 10 kHz band, frame by frame (5 ms), for
// planning the de-esser.
function sibilanceStats(mono, fs, activeMask, envHop) {
  const hp = designBiquad('highpass', 5000, fs, 0.7);
  const lp = designBiquad('lowpass', 10000, fs, 0.7);
  const s1 = new Float64Array(2);
  const s2 = new Float64Array(2);
  const hop = Math.round(fs * 0.005);
  const tmp = new Float32Array(hop);
  const rel = [];
  const n = mono.length;
  for (let s = 0; s + hop <= n; s += hop) {
    biquadRunOffset(mono, s, tmp, 0, hop, hp, s1);
    biquadRunOffset(tmp, 0, tmp, 0, hop, lp, s2);
    let eh = 0;
    let ef = 0;
    for (let i = 0; i < hop; i++) {
      eh += tmp[i] * tmp[i];
      ef += mono[s + i] * mono[s + i];
    }
    const f10 = Math.floor(s / envHop);
    if (ef > 1e-9 && activeMask[f10]) rel.push(LOG10_10 * Math.log((eh + 1e-20) / ef));
  }
  const p = percentiles(rel, [50, 90, 95, 99]);
  return { p50: p[50], p90: p[90], p95: p[95], p99: p[99] };
}

// Onset strength from the RMS envelope (positive log energy flux), plus
// measures of how percussive and how periodic the stem is.
function onsetFeatures(envRms, hopSec) {
  const n = envRms.length;
  const flux = new Float32Array(n);
  for (let i = 1; i < n; i++) {
    const d = envRms[i] - envRms[i - 1];
    flux[i] = d > 0 && envRms[i] > -60 ? d : 0;
  }
  // Peak picking: local maxima above an adaptive threshold.
  const onsets = [];
  const W = 5;
  for (let i = W; i < n - W; i++) {
    const v = flux[i];
    if (v < 6) continue;
    let isMax = true;
    for (let k = i - W; k <= i + W; k++) if (flux[k] > v) { isMax = false; break; }
    if (isMax) {
      onsets.push(i);
      i += W;
    }
  }
  // Percussive: average drop in level 120 ms after each onset peak.
  let dropSum = 0;
  let dropCnt = 0;
  const after = Math.round(0.12 / hopSec);
  for (const o of onsets) {
    let pk = -Infinity;
    for (let k = o; k < Math.min(n, o + 3); k++) if (envRms[k] > pk) pk = envRms[k];
    if (o + after < n) {
      dropSum += Math.max(0, pk - envRms[o + after]);
      dropCnt++;
    }
  }
  const percussive = dropCnt ? Math.min(1, dropSum / dropCnt / 18) : 0;
  // Periodicity via autocorrelation of the flux between 0.25 s and 1.5 s.
  const minLag = Math.round(0.25 / hopSec);
  const maxLag = Math.round(1.5 / hopSec);
  let zero = 0;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += flux[i];
  mean /= Math.max(1, n);
  for (let i = 0; i < n; i++) zero += (flux[i] - mean) * (flux[i] - mean);
  let best = 0;
  let bestLag = 0;
  if (zero > 0 && n > maxLag * 4) {
    for (let lag = minLag; lag <= maxLag; lag++) {
      let acc = 0;
      for (let i = 0; i + lag < n; i += 1) acc += (flux[i] - mean) * (flux[i + lag] - mean);
      const r = acc / zero;
      if (r > best) {
        best = r;
        bestLag = lag;
      }
    }
  }
  return {
    flux,
    onsetCount: onsets.length,
    percussive,
    periodicity: best,
    beatPeriod: bestLag * hopSec,
  };
}

// Frequency below which the stem's spectrum has fallen 12 dB under its body
// level: a hint for where a high pass filter can sit without thinning it.
function lowCutHint(curve) {
  let bodyMax = -Infinity;
  for (let i = 0; i < ANALYSIS_GRID.length; i++) {
    const f = ANALYSIS_GRID[i];
    if (f >= 60 && f <= 2000 && curve[i] > bodyMax) bodyMax = curve[i];
  }
  let hint = 20;
  for (let i = 0; i < ANALYSIS_GRID.length; i++) {
    const f = ANALYSIS_GRID[i];
    if (f > 1000) break;
    if (curve[i] < bodyMax - 15) hint = f;
    else break;
  }
  return hint;
}

export function analyseStem(chs, fs) {
  const n = chs[0].length;
  const nch = chs.length;
  const out = { length: n, seconds: n / fs, channels: nch };
  // Stereo relationship.
  out.stereo = nch > 1 ? stereoCheck(chs[0], chs[1]) : { kind: 'mono', correlation: 1, balanceDb: 0 };
  // Mono analysis signal.
  let mono;
  if (nch === 1) mono = chs[0];
  else {
    mono = new Float32Array(n);
    const a = chs[0];
    const b = chs[1];
    for (let i = 0; i < n; i++) mono[i] = 0.5 * (a[i] + b[i]);
  }
  // Envelopes and activity.
  const env = envelopes(chs, fs);
  let maxRms = -Infinity;
  let maxPeak = -Infinity;
  for (let i = 0; i < env.rms.length; i++) {
    if (env.rms[i] > maxRms) maxRms = env.rms[i];
    if (env.peak[i] > maxPeak) maxPeak = env.peak[i];
  }
  out.peakDb = maxPeak;
  out.silent = !(maxPeak > -80);
  if (out.silent) return out;
  const activeThr = Math.max(-62, maxRms - 45);
  const mask = new Uint8Array(env.rms.length);
  const actRms = [];
  const actPeak = [];
  let first = -1;
  let last = -1;
  for (let i = 0; i < env.rms.length; i++) {
    if (env.rms[i] > activeThr) {
      mask[i] = 1;
      actRms.push(env.rms[i]);
      actPeak.push(env.peak[i]);
      if (first < 0) first = i;
      last = i;
    }
  }
  out.activity = {
    ratio: actRms.length / Math.max(1, env.rms.length),
    firstSec: first * 0.01,
    lastSec: (last + 1) * 0.01,
  };
  const pr = percentiles(actRms, [5, 10, 20, 50, 80, 90, 95, 99]);
  const pp = percentiles(actPeak, [50, 90, 95, 99]);
  out.env = { p5: pr[5], p10: pr[10], p20: pr[20], p50: pr[50], p80: pr[80], p90: pr[90], p95: pr[95], p99: pr[99], max: maxRms };
  out.peakEnv = { p50: pp[50], p90: pp[90], p95: pp[95], p99: pp[99] };
  out.crestDb = pp[99] - pr[50];
  // Noise floor: quietest non silent frames (bleed / hiss level).
  const nonSilent = [];
  for (let i = 0; i < env.rms.length; i++) if (env.rms[i] > -100) nonSilent.push(env.rms[i]);
  out.floorDb = percentiles(nonSilent, [10])[10];
  // Loudness (K weighted, 100 ms blocks kept for window searches).
  const blocks = kPowerBlocks(chs, fs);
  out.lufs = integratedFromBlocks(blocks);
  const st = windowSeries(blocks, 30);
  out.lra = loudnessRangeFromShortTerm(st);
  out.kBlocks = new Float32Array(blocks.sums.length);
  for (let i = 0; i < blocks.sums.length; i++) out.kBlocks[i] = blocks.sums[i] / blocks.n100;
  // Spectrum.
  const spec = ltas(chs, fs, { gateDb: 30 });
  const pw = totalPower(spec);
  const curve = tonalCurve(pw, fs, spec.n, 1 / 3);
  const fine = tonalCurve(pw, fs, spec.n, 1 / 12);
  out.spectrum = {
    curve: Float32Array.from(curve),
    fine: Float32Array.from(fine),
    octave: Array.from(smoothToGrid(pw, fs, spec.n, OCTAVE_CENTRES, 1)),
  };
  const total = bandPower(pw, fs, spec.n, 20, 20000) || 1e-20;
  const band = (lo, hi) => bandPower(pw, fs, spec.n, lo, hi) / total;
  out.bands = {
    sub: band(20, 60),
    bass: band(60, 250),
    lowmid: band(250, 1000),
    mid: band(1000, 4000),
    high: band(4000, 10000),
    air: band(10000, 20000),
  };
  let num = 0;
  let den = 0;
  const df = fs / spec.n;
  for (let k = 1; k < pw.length; k++) {
    num += k * df * pw[k];
    den += pw[k];
  }
  out.centroid = den > 0 ? num / den : 0;
  out.lowCutHint = lowCutHint(curve);
  if (nch > 1) {
    out.width = widthProfile(spec);
    out.correlation = stereoCorrelation(chs[0], chs[1], 0, n, 4);
  }
  out.sibilance = sibilanceStats(mono, fs, mask, env.hop);
  const on = onsetFeatures(env.rms, 0.01);
  out.onsets = {
    rate: on.onsetCount / Math.max(1, out.activity.ratio * out.seconds),
    percussive: on.percussive,
    periodicity: on.periodicity,
    beatPeriod: on.beatPeriod,
  };
  out.flux = on.flux;
  return out;
}

// Loudest window of `secs` seconds from 100 ms K-weighted block powers.
// Returns [startSample, endSample).
export function loudestWindow(kBlocks, fs, secs = 20) {
  const n100 = Math.round(fs * 0.1);
  const w = Math.round(secs * 10);
  if (kBlocks.length <= w) return [0, kBlocks.length * n100];
  let acc = 0;
  for (let i = 0; i < w; i++) acc += kBlocks[i];
  let best = acc;
  let bestStart = 0;
  for (let i = w; i < kBlocks.length; i++) {
    acc += kBlocks[i] - kBlocks[i - w];
    if (acc > best) {
      best = acc;
      bestStart = i - w + 1;
    }
  }
  return [bestStart * n100, (bestStart + w) * n100];
}

// Tempo from an onset flux envelope (10 ms hop): autocorrelation weighted
// toward 120 BPM, with octave error checks. Returns BPM or 0.
export function estimateTempo(flux, hopSec = 0.01) {
  const n = flux.length;
  if (n < 1000) return 0;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += flux[i];
  mean /= n;
  const minLag = Math.round(60 / 200 / hopSec);
  const maxLag = Math.round(60 / 60 / hopSec);
  const ac = new Float64Array(maxLag + 2);
  for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
    let acc = 0;
    for (let i = 0; i + lag < n; i++) acc += (flux[i] - mean) * (flux[i + lag] - mean);
    ac[lag] = acc;
  }
  let best = -Infinity;
  let bestLag = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = 60 / (lag * hopSec);
    const w = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.9, 2));
    const v = ac[lag] * w;
    if (v > best) {
      best = v;
      bestLag = lag;
    }
  }
  if (!bestLag || best <= 0) return 0;
  // Parabolic interpolation for sub-frame accuracy.
  const a = ac[bestLag - 1];
  const b = ac[bestLag];
  const c = ac[bestLag + 1];
  const den = a - 2 * b + c;
  const shift = den !== 0 ? (0.5 * (a - c)) / den : 0;
  const lag = bestLag + Math.max(-0.5, Math.min(0.5, shift));
  return 60 / (lag * hopSec);
}
