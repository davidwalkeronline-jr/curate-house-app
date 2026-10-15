// Mix bus and mastering chain.
//
//  1. Normalise the summed mix to -18 LUFS and glue it with a gentle bus
//     compressor (side chain high passed so the kick does not pump it).
//  2. Tonal match: EQ the mix toward the genre or reference tonal balance.
//  3. Stereo: keep the low end mono, move side level toward the target width.
//  4. Optional analogue warmth.
//  5. True peak lookahead limiting with the input gain searched so the master
//     lands on the loudness target.

import { BiquadChain, butterworth, designBiquad } from './biquad.js';
import { compress, prepareLimiter, limiterEnvelope, applyEnvelope, envelopeStats } from './dynamics.js';
import { kWeightingSections, integratedFromBlocks, measureLoudness, truePeak, samplePeak, integratedLoudness } from './loudness.js';
import { biquadRunOffset, biquadRun } from './biquad.js';
import { ltas, totalPower, tonalCurve, normaliseCurve, widthProfile, ANALYSIS_GRID, curveMean } from './spectrum.js';
import { fitEq, smoothCurve, sectionCoefs, totalResponse } from './eqfit.js';
import { saturate, clipper } from './saturation.js';
import { clamp, linToDb, percentiles } from './util.js';

function gainInPlace(chs, g) {
  for (const x of chs) for (let i = 0; i < x.length; i++) x[i] *= g;
}

// 10 ms RMS percentiles of active frames (dB) of a stereo signal.
function rmsStats(L, R, fs) {
  const hop = Math.round(fs * 0.01);
  const vals = [];
  let max = -Infinity;
  const frames = Math.floor(L.length / hop);
  const levels = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let e = 0;
    for (let i = f * hop; i < (f + 1) * hop; i++) e += L[i] * L[i] + R[i] * R[i];
    const db = 10 * Math.log10(e / (2 * hop) + 1e-20);
    levels[f] = db;
    if (db > max) max = db;
  }
  for (let f = 0; f < frames; f++) if (levels[f] > max - 30) vals.push(levels[f]);
  return percentiles(vals, [50, 90, 95]);
}

function kWeighted(x, fs) {
  const [k1, k2] = kWeightingSections(fs);
  const out = new Float32Array(x.length);
  biquadRunOffset(x, 0, out, 0, x.length, k1, new Float64Array(2));
  biquadRun(out, k2, new Float64Array(2));
  return out;
}

const DEC = 8;

// Per sample K weighted power (L^2 + R^2), the input to loudness estimates.
function kPower(L, R, fs) {
  const kL = kWeighted(L, fs);
  const kR = kWeighted(R, fs);
  for (let i = 0; i < kL.length; i++) kL[i] = kL[i] * kL[i] + kR[i] * kR[i];
  return kL;
}

// Integrated loudness of G * x * env estimated from the K weighted power of
// x (the K filter is applied before the slowly varying limiter gain). `env`
// may be decimated by `dec` (each value covers dec samples).
function loudnessWithEnvelope(kp, env, G, fs, dec = 1) {
  const n100 = Math.round(fs * 0.1);
  const nb = Math.floor(Math.min(kp.length, env.length * dec) / n100);
  const sums = new Float64Array(nb);
  const g2 = G * G;
  for (let b = 0; b < nb; b++) {
    let acc = 0;
    const s = b * n100;
    for (let i = s; i < s + n100; i++) {
      const e = env[(i / dec) | 0];
      acc += e * e * kp[i];
    }
    sums[b] = acc * g2;
  }
  return integratedFromBlocks({ sums, n100 });
}

// Peak track decimated by DEC (max over each group) for fast searches.
function decimatePeaks(pk) {
  const m = Math.ceil(pk.length / DEC);
  const out = new Float32Array(m);
  for (let j = 0; j < m; j++) {
    let v = 0;
    const e = Math.min(pk.length, (j + 1) * DEC);
    for (let i = j * DEC; i < e; i++) if (pk[i] > v) v = pk[i];
    out[j] = v;
  }
  return { pk: out };
}

function tonalMatch(L, R, fs, m, report) {
  const spec = ltas([L, R], fs, { gateDb: 25 });
  const pw = totalPower(spec);
  const smoothing = m.smoothing ?? 1 / 3;
  const mixCurve = tonalCurve(pw, fs, spec.n, smoothing);
  const target = normaliseCurve(m.curve);
  const mix = normaliseCurve(mixCurve);
  let diff = new Float64Array(ANALYSIS_GRID.length);
  for (let i = 0; i < diff.length; i++) diff[i] = target[i] - mix[i];
  diff = smoothCurve(diff, smoothing >= 1 / 3 ? 1 / 2 : 1 / 3);
  const body = curveMean(mix, 250, 4000);
  for (let i = 0; i < diff.length; i++) {
    const f = ANALYSIS_GRID[i];
    let d = diff[i] * m.matchStrength;
    let hi = m.maxBoost;
    if (f < 32) hi = Math.min(hi, 1.5);
    if (f > 16000) hi = Math.min(hi, 2);
    // Nothing to lift where the mix has (almost) no content.
    if (mix[i] < body - 28) hi = Math.min(hi, 1);
    d = clamp(d, m.maxCut, hi);
    diff[i] = d;
  }
  const sections = fitEq(diff, fs, {
    maxBands: 7,
    maxBoost: m.maxBoost,
    maxCut: m.maxCut,
    qMin: 0.5,
    qMax: 2.5,
    fMin: 25,
    fMax: Math.min(18000, fs * 0.45),
    lowShelfRange: [50, 220],
    highShelfRange: [4000, 13000],
    minGain: 0.3,
  });
  if (sections.length) {
    const chain = new BiquadChain(sections.map((s) => sectionCoefs(s, fs)), 2);
    chain.process(L, 0);
    chain.process(R, 1);
  }
  report.eq = sections;
  report.curves = {
    target: Float32Array.from(target),
    before: Float32Array.from(mix),
    eqResponse: Float32Array.from(totalResponse(sections, ANALYSIS_GRID, fs)),
  };
  report.widthBefore = widthProfile(spec);
  return spec;
}

function stereoStage(L, R, fs, m, widthBefore, report) {
  const target = m.width;
  const amt = m.widthAmount ?? 0.5;
  const gMid = clamp((target.mid - widthBefore.mid) * amt, -3, 3);
  const gHigh = clamp((target.high - widthBefore.high) * amt, -3, 3);
  // A mono or near mono mix cannot be meaningfully widened.
  const canWiden = widthBefore.mid > -30;
  const sideMid = canWiden ? gMid : Math.min(gMid, 0);
  const sideHigh = canWiden ? gHigh : Math.min(gHigh, 0);
  const n = L.length;
  const S = new Float32Array(n);
  for (let i = 0; i < n; i++) S[i] = 0.5 * (L[i] - R[i]);
  const sections = [...butterworth('highpass', m.bassMono || 120, fs, 2)];
  if (Math.abs(sideHigh - sideMid) > 0.2) sections.push(designBiquad('highshelf', 3500, fs, Math.SQRT1_2, sideHigh - sideMid));
  new BiquadChain(sections, 1).process(S, 0);
  const gs = Math.pow(10, sideMid / 20);
  for (let i = 0; i < n; i++) {
    const mid = 0.5 * (L[i] + R[i]);
    const s = S[i] * gs;
    L[i] = mid + s;
    R[i] = mid - s;
  }
  report.width = { sideMidDb: sideMid, sideHighDb: sideHigh, bassMonoHz: m.bassMono || 120 };
}

// Main entry. L/R are consumed (modified in place). Returns new arrays for
// the unmastered mix (glued) and the master, plus a report.
export function masterMix(L, R, fs, m, progress = () => {}) {
  const report = {};
  // 1. Normalise and glue.
  const pre = integratedLoudness([L, R], fs);
  const norm = Number.isFinite(pre) ? Math.pow(10, (-18 - pre) / 20) : 1;
  gainInPlace([L, R], norm);
  progress(0.08, 'Gluing the mix bus');
  const glue = m.glue || { targetGr: 1.5, ratio: 2, attack: 30, release: 150 };
  if (glue.targetGr > 0.2) {
    const st = rmsStats(L, R, fs);
    const threshold = st[90] - glue.targetGr / (1 - 1 / glue.ratio);
    report.glue = compress([L, R], fs, {
      threshold,
      ratio: glue.ratio,
      knee: 6,
      attack: glue.attack,
      release: glue.release,
      rms: 10,
      scHpf: 90,
    });
    report.glue.targetGr = glue.targetGr;
  }
  // Unmastered mix copy (headroom guarded).
  const mixPeak = samplePeak([L, R]);
  const mixGain = mixPeak > 0.7 ? 0.7 / mixPeak : 1;
  const mixL = new Float32Array(L.length);
  const mixR = new Float32Array(R.length);
  for (let i = 0; i < L.length; i++) {
    mixL[i] = L[i] * mixGain;
    mixR[i] = R[i] * mixGain;
  }
  progress(0.2, 'Matching tonal balance');
  // 2. Tonal match.
  tonalMatch(L, R, fs, m, report);
  progress(0.35, 'Setting stereo width');
  // 3. Stereo.
  stereoStage(L, R, fs, m, report.widthBefore, report);
  // 4. Warmth.
  if (m.warmth > 0.02) {
    const pk = samplePeak([L, R]);
    const inGain = pk > 0 ? Math.pow(10, -6 / 20) / pk : 1;
    for (const x of [L, R]) saturate(x, { drive: 2 + 6 * m.warmth, mix: Math.min(0.6, m.warmth * 1.2), bias: 0.08, inGain });
    report.warmth = m.warmth;
  }
  progress(0.45, 'Limiting to the loudness target');
  // 5. Limiter with loudness search.
  const ceiling = Math.pow(10, (m.ceiling ?? -1) / 20);
  const target = m.lufs;
  const xLufs = integratedLoudness([L, R], fs);
  const look = Math.round(0.004 * fs);
  const rel = Math.round(((m.release ?? 120) / 1000) * fs);
  const G0db = target - xLufs;
  // Search the input gain on a decimated envelope (fast), then compute the
  // exact full rate envelope once at the chosen gain.
  const search = (startDb) => {
    const prep = prepareLimiter([L, R], ceiling / (Math.pow(10, (startDb + 8) / 20) * 1.6));
    const fast = decimatePeaks(prep.pk);
    const kp = kPower(L, R, fs);
    const lookD = Math.max(1, Math.round(look / DEC));
    const relD = Math.max(1, Math.round(rel / DEC));
    const evalAt = (gdb) => {
      const G = Math.pow(10, gdb / 20);
      const env = limiterEnvelope(fast, G, ceiling, lookD, relD);
      return { lufs: loudnessWithEnvelope(kp, env, G, fs, DEC), G, gdb };
    };
    let g1 = startDb;
    let r1 = evalAt(g1);
    let e1 = target - r1.lufs;
    let g0 = null;
    let e0 = null;
    for (let it = 0; it < 10 && Math.abs(e1) > 0.03; it++) {
      let next;
      if (g0 === null || Math.abs(e1 - e0) < 1e-6) next = g1 + e1 * 1.2;
      else next = g1 - (e1 * (g1 - g0)) / (e1 - e0);
      next = clamp(next, G0db - 6, G0db + 16);
      g0 = g1;
      e0 = e1;
      g1 = next;
      r1 = evalAt(g1);
      e1 = target - r1.lufs;
    }
    r1.env = limiterEnvelope(prep, r1.G, ceiling, look, rel);
    return r1;
  };
  let r1 = search(G0db + 0.5);
  progress(0.62, 'Limiting to the loudness target');
  // Heavy limiting: let a clean oversampled clipper shave the tallest
  // transients first, then search again with the limiter doing less.
  // Shave only what the limiter would otherwise struggle with (above ~5 dB
  // of peak reduction), up to the genre's cap.
  const firstGr = envelopeStats(r1.env).maxGr;
  const clipDb = Math.min(m.clip ?? 0, Math.max(0, firstGr - 5));
  if (clipDb >= 0.5) {
    const thr = (ceiling / r1.G) * Math.pow(10, (firstGr - clipDb) / 20);
    clipper(L, thr, 2);
    clipper(R, thr, 2);
    report.clipper = { shaveDb: clipDb, limiterBefore: firstGr };
    r1 = search(r1.gdb);
  }
  const g1 = r1.gdb;
  const out = applyEnvelope([L, R], r1.G, r1.env);
  report.limiter = { inputGainDb: g1, ...envelopeStats(r1.env), ceilingDb: m.ceiling ?? -1 };
  // Final checks: exact loudness and true peak.
  progress(0.85, 'Checking loudness and true peak');
  let tp = truePeak(out);
  if (tp > ceiling * 1.003) {
    const trim = (ceiling / tp) * 0.999;
    gainInPlace(out, trim);
    tp *= trim;
  }
  const meas = measureLoudness(out, fs);
  const outSpec = ltas(out, fs, { gateDb: 25 });
  report.curves.after = Float32Array.from(normaliseCurve(tonalCurve(totalPower(outSpec), fs, outSpec.n, m.smoothing ?? 1 / 3)));
  report.widthAfter = widthProfile(outSpec);
  report.final = {
    lufs: meas.integrated,
    lra: meas.lra,
    shortTermMax: meas.shortTermMax,
    truePeakDb: linToDb(tp),
    plr: linToDb(tp) - meas.integrated,
    targetLufs: target,
  };
  const mixMeas = integratedLoudness([mixL, mixR], fs);
  report.mix = { lufs: mixMeas, peakDb: linToDb(samplePeak([mixL, mixR])) };
  progress(1, 'Done');
  return { mix: { L: mixL, R: mixR }, master: { L: out[0], R: out[1] }, report };
}
