// Heavy work units. Each job takes plain data (typed arrays, settings) and
// returns plain data, so it runs identically inside a Web Worker or inline
// on the main thread. Large outputs list their buffers for transfer.

import { analyseStem, loudestWindow } from './features.js';
import { unpackRange, processStrip } from './strip.js';
import { integratedLoudness, measureLoudness, truePeak, samplePeak } from './loudness.js';
import { renderReverb, delay } from './reverb.js';
import { masterMix } from './master.js';
import { ltas, totalPower, tonalCurve, widthProfile } from './spectrum.js';
import { linToDb } from './util.js';

function transferOf(...arrays) {
  return arrays.filter(Boolean).map((a) => a.buffer);
}

// Mono mix of packed channels over [start, end).
function monoRange(packed, start, end) {
  const chs = unpackRange(packed, start, end);
  if (chs.length === 1) return chs[0];
  const out = chs[0];
  for (let i = 0; i < out.length; i++) out[i] = 0.5 * (out[i] + chs[1][i]);
  return out;
}

const handlers = {
  ping() {
    return { result: 'pong' };
  },

  analyze({ packed, fs }) {
    const chs = unpackRange(packed, 0, packed[0].length);
    const a = analyseStem(chs, fs);
    const t = [];
    if (!a.silent) t.push(...transferOf(a.kBlocks, a.flux, a.spectrum?.curve, a.spectrum?.fine));
    return { result: a, transfer: t };
  },

  analyzeReference({ L, R, fs }) {
    const chs = R ? [L, R] : [L];
    const m = measureLoudness(chs, fs);
    const tp = truePeak(chs);
    const spec = ltas(chs, fs, { gateDb: 22 });
    const pw = totalPower(spec);
    const curve = Float32Array.from(tonalCurve(pw, fs, spec.n, 1 / 6));
    const curve3 = Float32Array.from(tonalCurve(pw, fs, spec.n, 1 / 3));
    const width = chs.length > 1 ? widthProfile(spec) : { low: -60, mid: -60, high: -60 };
    const win = loudestWindow(m.blocks.sums, fs, 30);
    return {
      result: {
        lufs: m.integrated,
        lra: m.lra,
        shortTermMax: m.shortTermMax,
        truePeakDb: linToDb(tp),
        plr: linToDb(tp) - m.integrated,
        curve,
        curve3,
        width,
        loudestStart: win[0] / fs,
        seconds: L.length / fs,
      },
      transfer: transferOf(curve, curve3),
    };
  },

  // Polarity / time alignment between two mics on one source.
  pair({ a, b, maxLag }) {
    const x = monoRange(a.packed, a.start, a.end);
    const y = monoRange(b.packed, b.start, b.end);
    const n = Math.min(x.length, y.length);
    let xx = 0;
    let yy = 0;
    for (let i = 0; i < n; i++) {
      xx += x[i] * x[i];
      yy += y[i] * y[i];
    }
    if (xx === 0 || yy === 0) return { result: { r: 0, lag: 0 } };
    let best = 0;
    let bestLag = 0;
    const norm = 1 / Math.sqrt(xx * yy);
    for (let lag = -maxLag; lag <= maxLag; lag++) {
      let acc = 0;
      const s = Math.max(0, -lag);
      const e = Math.min(n, n - lag);
      for (let i = s; i < e; i++) acc += x[i] * y[i + lag];
      const r = acc * norm;
      if (Math.abs(r) > Math.abs(best)) {
        best = r;
        bestLag = lag;
      }
    }
    return { result: { r: best, lag: bestLag } };
  },

  // Process every member of a group over its measurement window, balance the
  // members, and measure the group's combined loudness.
  group({ members, fs, preroll, length }) {
    const out = {};
    let sumL = null;
    let sumR = null;
    for (const m of members) {
      const chs = unpackRange(m.packed, m.start - preroll, m.start + length);
      const { L, R } = processStrip(chs, fs, m.strip, 0);
      const lufs = integratedLoudness([L, R], fs, preroll, preroll + length);
      const gain = Number.isFinite(lufs) ? (m.strip.offset || 0) - lufs : NaN;
      out[m.strip.id] = { lufs, gain };
      if (!Number.isFinite(gain)) continue;
      const g = Math.pow(10, gain / 20);
      if (!sumL) {
        sumL = new Float32Array(L.length);
        sumR = new Float32Array(L.length);
      }
      for (let i = 0; i < L.length; i++) {
        sumL[i] += L[i] * g;
        sumR[i] += R[i] * g;
      }
    }
    const groupLufs = sumL ? integratedLoudness([sumL, sumR], fs, preroll, preroll + length) : -Infinity;
    return { result: { members: out, groupLufs } };
  },

  // Full length render of one stem through its strip at its final gain.
  render({ packed, fs, strip, length }) {
    const chs = unpackRange(packed, 0, length ?? packed[0].length);
    const { L, R, stats } = processStrip(chs, fs, strip, strip.gain || 0);
    return { result: { L, R, stats, peakDb: linToDb(samplePeak([L, R])) }, transfer: transferOf(L, R) };
  },

  reverb({ kind, L, R, fs, params }) {
    const out = kind === 'delay' ? delay(L, R, fs, params) : renderReverb(kind, L, R, fs, params);
    return { result: out, transfer: transferOf(out.L, out.R) };
  },

  master({ L, R, fs, master }, progress) {
    const res = masterMix(L, R, fs, master, progress);
    const c = res.report.curves;
    return {
      result: res,
      transfer: transferOf(res.mix.L, res.mix.R, res.master.L, res.master.R, c?.target, c?.before, c?.after, c?.eqResponse),
    };
  },

  // Loudness and peak of a stereo signal (for level matched playback).
  measure({ L, R, fs }) {
    return { result: { lufs: integratedLoudness([L, R], fs), peakDb: linToDb(samplePeak([L, R])) } };
  },
};

export function runJob(type, payload, progress = () => {}) {
  const h = handlers[type];
  if (!h) throw new Error('Unknown job ' + type);
  return h(payload, progress);
}
