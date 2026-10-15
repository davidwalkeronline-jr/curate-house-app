import test from 'node:test';
import assert from 'node:assert/strict';
import { designBiquad, biquadDb, BiquadChain, butterworth, lr4 } from '../js/engine/biquad.js';
import { ltas, totalPower, tonalCurve, ANALYSIS_GRID, widthProfile } from '../js/engine/spectrum.js';
import { compress, expand, deEss, prepareLimiter, limiterEnvelope, applyEnvelope } from '../js/engine/dynamics.js';
import { truePeak, integratedLoudness } from '../js/engine/loudness.js';
import { saturate } from '../js/engine/saturation.js';
import { plate, space, delay, renderReverb, noise } from '../js/engine/reverb.js';
import { packChannel, unpackChannel, slicePacked } from '../js/engine/bfp.js';
import { linToDb, makeRng } from '../js/engine/util.js';

const FS = 48000;

function sine(n, f, amp = 1, phase = 0) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * f * i) / FS + phase);
  return out;
}

function rms(x, s = 0, e = x.length) {
  let a = 0;
  for (let i = s; i < e; i++) a += x[i] * x[i];
  return Math.sqrt(a / (e - s));
}

function pinkNoise(n, seed = 3) {
  // Paul Kellet's economy pink filter on white noise.
  const rng = makeRng(seed);
  const out = new Float32Array(n);
  let b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < n; i++) {
    const w = rng() * 2 - 1;
    b0 = 0.99765 * b0 + w * 0.099046;
    b1 = 0.963 * b1 + w * 0.2965164;
    b2 = 0.57 * b2 + w * 1.0526913;
    out[i] = (b0 + b1 + b2 + w * 0.1848) * 0.1;
  }
  return out;
}

test('peaking and shelf filters hit their gain at the design frequency', () => {
  const pk = designBiquad('peaking', 1000, FS, 1.2, 6);
  assert.ok(Math.abs(biquadDb(pk, 1000, FS) - 6) < 0.01);
  assert.ok(Math.abs(biquadDb(pk, 50, FS)) < 0.1);
  const ls = designBiquad('lowshelf', 100, FS, Math.SQRT1_2, -4);
  assert.ok(Math.abs(biquadDb(ls, 20, FS) - -4) < 0.2);
  assert.ok(Math.abs(biquadDb(ls, 5000, FS)) < 0.05);
  const hs = designBiquad('highshelf', 8000, FS, Math.SQRT1_2, 3);
  assert.ok(Math.abs(biquadDb(hs, 19000, FS) - 3) < 0.3);
});

test('butterworth high pass is -3 dB at cutoff (4th order -24 dB/oct)', () => {
  const secs = butterworth('highpass', 100, FS, 4);
  const at = (f) => secs.reduce((s, c) => s + biquadDb(c, f, FS), 0);
  assert.ok(Math.abs(at(100) - -3.01) < 0.05);
  assert.ok(Math.abs(at(50) - -24.1) < 0.6);
});

test('LR4 low and high bands sum to a flat magnitude', () => {
  const { low, high } = lr4(2000, FS);
  const x = sine(FS, 2000, 0.5);
  const a = x.slice();
  const b = x.slice();
  new BiquadChain(low, 1).process(a);
  new BiquadChain(high, 1).process(b);
  const sum = a.map((v, i) => v + b[i]);
  const ratio = rms(sum, FS / 2) / rms(x, FS / 2);
  assert.ok(Math.abs(linToDb(ratio)) < 0.05, `sum ratio ${linToDb(ratio)}`);
});

test('block floating point round trip is transparent', () => {
  const x = pinkNoise(100000);
  for (let i = 50000; i < 60000; i++) x[i] *= 0.001; // a quiet passage
  const p = packChannel(x);
  const y = unpackChannel(p);
  let err = 0;
  let sig = 0;
  // Interior of the quiet passage (whole blocks only).
  for (let i = 50176; i < 59904; i++) {
    err += (x[i] - y[i]) ** 2;
    sig += x[i] ** 2;
  }
  assert.ok(10 * Math.log10(sig / err) > 85, 'SNR in quiet passage');
  const sl = slicePacked(p, 1000, 5000);
  const z = unpackChannel(sl.packed);
  assert.equal(z[sl.offset], y[1000]);
});

test('pink noise produces a flat tonal curve', () => {
  const x = pinkNoise(FS * 20);
  const spec = ltas([x], FS);
  const curve = tonalCurve(totalPower(spec), FS, spec.n, 1 / 3);
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < ANALYSIS_GRID.length; i++) {
    const f = ANALYSIS_GRID[i];
    if (f < 50 || f > 15000) continue;
    lo = Math.min(lo, curve[i]);
    hi = Math.max(hi, curve[i]);
  }
  assert.ok(hi - lo < 3, `pink curve spread ${hi - lo} dB`);
});

test('width profile: mono reads very narrow, independent channels wide', () => {
  const a = pinkNoise(FS * 5, 1);
  const b = pinkNoise(FS * 5, 2);
  const mono = widthProfile(ltas([a, a], FS));
  const wide = widthProfile(ltas([a, b], FS));
  assert.ok(mono.mid < -40);
  assert.ok(Math.abs(wide.mid) < 1.5, `wide mid ${wide.mid}`);
});

test('compressor reduces a loud tone by the static curve amount', () => {
  // -6 dBFS peak tone, threshold -20, ratio 4, hard knee: GR = 14 * 0.75 = 10.5
  const x = sine(FS * 2, 1000, 0.5);
  const st = compress([x], FS, { threshold: -20, ratio: 4, knee: 0, attack: 5, release: 50 });
  const gr = linToDb(0.5) - linToDb(Math.max(...x.subarray(FS, FS * 2).map(Math.abs)));
  assert.ok(Math.abs(gr - 10.5) < 0.6, `GR ${gr}`);
  assert.ok(st.maxGr > 9);
});

test('expander attenuates bleed between hits but keeps hits', () => {
  const n = FS * 2;
  const x = new Float32Array(n);
  const rng = makeRng(5);
  for (let i = 0; i < n; i++) x[i] = (rng() * 2 - 1) * 0.01; // -40 dB bleed
  for (const t of [0.2, 0.8, 1.4]) {
    const s = Math.round(t * FS);
    for (let i = 0; i < 4000; i++) x[s + i] += 0.8 * Math.exp(-i / 800) * Math.sin(i * 0.05);
  }
  const before = rms(x, Math.round(0.5 * FS), Math.round(0.7 * FS));
  expand([x], FS, { threshold: -25, ratio: 4, range: 18, attack: 0.3, hold: 40, release: 80 });
  const after = rms(x, Math.round(0.5 * FS), Math.round(0.7 * FS));
  assert.ok(linToDb(after / before) < -12, `bleed reduction ${linToDb(after / before)}`);
  const hit = Math.max(...x.subarray(Math.round(0.8 * FS), Math.round(0.8 * FS) + 2000).map(Math.abs));
  assert.ok(hit > 0.6, 'hit preserved');
});

test('de-esser turns down sibilant bursts but not voiced sound', () => {
  const n = FS * 2;
  const voiced = sine(n, 220, 0.3);
  const x = voiced.slice();
  const rng = makeRng(9);
  const hp = new BiquadChain([designBiquad('highpass', 6000, FS, 0.7), designBiquad('highpass', 6000, FS, 0.7)], 1);
  const hiss = new Float32Array(n);
  for (let i = 0; i < n; i++) hiss[i] = (rng() * 2 - 1) * 0.6;
  hp.process(hiss);
  const s0 = FS;
  const s1 = FS + 6000;
  for (let i = s0; i < s1; i++) x[i] += hiss[i];
  const sibBefore = rms(hiss, s0, s1);
  const y = x.slice();
  deEss([y], FS, { freq: 5000, thresholdRel: -12, ratio: 4, range: 10 });
  // Estimate remaining sibilance by high passing the output.
  const out = y.slice();
  new BiquadChain([designBiquad('highpass', 6000, FS, 0.7), designBiquad('highpass', 6000, FS, 0.7)], 1).process(out);
  const sibAfter = rms(out, s0 + 500, s1);
  assert.ok(linToDb(sibAfter / sibBefore) < -4, `sibilance change ${linToDb(sibAfter / sibBefore)}`);
  const voicedRatio = rms(y, 10000, 40000) / rms(voiced, 10000, 40000);
  assert.ok(Math.abs(linToDb(voicedRatio)) < 0.5, 'voiced part untouched');
});

test('limiter output never exceeds the true peak ceiling', () => {
  const n = FS * 6;
  const x = pinkNoise(n, 4).map((v) => v * 2);
  const y = pinkNoise(n, 6).map((v) => v * 2);
  for (let i = 100000; i < 100050; i++) x[i] = 1.8; // sharp transient
  const prep = prepareLimiter([x, y]);
  const ceiling = Math.pow(10, -1 / 20);
  const G = 3;
  const env = limiterEnvelope(prep, G, ceiling, Math.round(0.005 * FS), Math.round(0.08 * FS));
  const out = applyEnvelope([x, y], G, env);
  const tp = linToDb(truePeak(out));
  assert.ok(tp <= -0.95, `true peak ${tp}`);
  const l = integratedLoudness(out, FS);
  assert.ok(Number.isFinite(l));
});

test('saturation at zero drive is transparent and sample aligned', () => {
  const x = sine(FS, 997, 0.3, 0.4);
  const y = x.slice();
  saturate(y, { drive: 0, mix: 0 });
  let err = 0;
  for (let i = 100; i < x.length - 100; i++) err = Math.max(err, Math.abs(y[i] - x[i]));
  assert.ok(err < 1e-3, `max error ${err}`);
  // With drive the fundamental stays in phase (correlation high).
  const z = x.slice();
  saturate(z, { drive: 12, mix: 1 });
  let c = 0, xx = 0, zz = 0;
  for (let i = 1000; i < x.length - 1000; i++) {
    c += x[i] * z[i];
    xx += x[i] * x[i];
    zz += z[i] * z[i];
  }
  assert.ok(c / Math.sqrt(xx * zz) > 0.95);
});

test('reverbs decay and return energy normalised output', () => {
  const n = FS * 4;
  const imp = new Float32Array(n);
  imp[0] = 1;
  const p = plate(imp, imp, FS, { rt60: 1.5, preDelay: 0 });
  const early = rms(p.L, 2000, 12000);
  const late = rms(p.L, Math.round(1.6 * FS), Math.round(1.8 * FS));
  assert.ok(early > 0 && linToDb(late / early) < -40, `plate decay ${linToDb(late / early)}`);
  const s = space(imp, imp, FS, { rt60: 2, preDelay: 0 });
  const e2 = rms(s.L, 2000, 12000);
  const l2 = rms(s.L, Math.round(2.1 * FS), Math.round(2.3 * FS));
  assert.ok(e2 > 0 && linToDb(l2 / e2) < -35, `space decay ${linToDb(l2 / e2)}`);
  // Normalised return of noise sits near the input level.
  const wn = noise(FS * 6, 2).map((v) => v * 0.2);
  const ret = renderReverb('space', wn, wn, FS, { rt60: 1.8, preDelay: 0.01 });
  const ratio = linToDb(rms(ret.L, FS * 3, FS * 6) / rms(wn, FS * 3, FS * 6));
  assert.ok(Math.abs(ratio) < 4, `space return level ${ratio}`);
  const d = delay(imp, imp, FS, { time: 0.25, feedback: 0.4 });
  const at = Math.round(0.25 * FS);
  assert.ok(Math.max(...d.L.subarray(at - 10, at + 200).map(Math.abs)) > 0.05, 'first echo present');
});

test('performance: 4 minute mono stem through a full channel strip', () => {
  const n = FS * 240;
  const x = pinkNoise(n, 8);
  const t0 = performance.now();
  const chain = new BiquadChain([
    ...butterworth('highpass', 80, FS, 4),
    designBiquad('peaking', 300, FS, 1, -3),
    designBiquad('peaking', 3000, FS, 1, 2),
    designBiquad('highshelf', 10000, FS, 0.7, 2),
    designBiquad('lowshelf', 120, FS, 0.7, 1),
  ], 1);
  chain.process(x);
  const t1 = performance.now();
  compress([x], FS, { threshold: -24, ratio: 4, knee: 6, attack: 5, release: 80, rms: 5, scHpf: 100 });
  const t2 = performance.now();
  deEss([x], FS, { freq: 5500, thresholdRel: -10 });
  const t3 = performance.now();
  saturate(x, { drive: 6, mix: 0.5, bias: 0.1 });
  const t4 = performance.now();
  const prep = prepareLimiter([x, x], 0.89 / (2 * 1.6));
  const t5 = performance.now();
  limiterEnvelope(prep, 2, 0.89, 240, 4800);
  const t6 = performance.now();
  integratedLoudness([x], FS);
  const t7 = performance.now();
  console.log(
    `eq ${(t1 - t0).toFixed(0)}ms comp ${(t2 - t1).toFixed(0)}ms deess ${(t3 - t2).toFixed(0)}ms ` +
      `sat ${(t4 - t3).toFixed(0)}ms limPrep(st) ${(t5 - t4).toFixed(0)}ms limEnv ${(t6 - t5).toFixed(0)}ms ` +
      `lufs ${(t7 - t6).toFixed(0)}ms`,
  );
  assert.ok(true);
});

test('performance: 4 minute stereo reverbs', () => {
  const n = FS * 240;
  const a = noise(n, 1).map((v) => v * 0.1);
  const t0 = performance.now();
  renderReverb('plate', a, a, FS, { rt60: 1.8 });
  const t1 = performance.now();
  renderReverb('space', a, a, FS, { rt60: 2.4 });
  const t2 = performance.now();
  delay(a, a, FS, { time: 0.375 });
  const t3 = performance.now();
  console.log(`plate ${(t1 - t0).toFixed(0)}ms space ${(t2 - t1).toFixed(0)}ms delay ${(t3 - t2).toFixed(0)}ms`);
  assert.ok(true);
});
