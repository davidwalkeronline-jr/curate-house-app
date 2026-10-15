import test from 'node:test';
import assert from 'node:assert/strict';
import {
  integratedLoudness,
  measureLoudness,
  truePeak,
  samplePeak,
} from '../js/engine/loudness.js';
import { linToDb } from '../js/engine/util.js';

function sine(fs, secs, freq, ampDb, phase = 0) {
  const n = Math.round(fs * secs);
  const a = Math.pow(10, ampDb / 20);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = a * Math.sin((2 * Math.PI * freq * i) / fs + phase);
  return out;
}

function concat(...arrs) {
  const n = arrs.reduce((s, a) => s + a.length, 0);
  const out = new Float32Array(n);
  let o = 0;
  for (const a of arrs) {
    out.set(a, o);
    o += a.length;
  }
  return out;
}

test('full scale 997 Hz sine on one channel reads -3.01 LUFS', () => {
  for (const fs of [44100, 48000, 96000]) {
    const x = sine(fs, 10, 997, 0);
    const l = integratedLoudness([x], fs);
    assert.ok(Math.abs(l - -3.01) < 0.05, `fs=${fs} got ${l}`);
  }
});

test('EBU 3341 case 1/2: stereo 1 kHz at -23 and -33 dBFS', () => {
  const fs = 48000;
  for (const lvl of [-23, -33]) {
    const x = sine(fs, 20, 1000, lvl);
    const l = integratedLoudness([x, x], fs);
    assert.ok(Math.abs(l - lvl) < 0.1, `level ${lvl} got ${l}`);
  }
});

test('EBU 3341 case 3: relative gate ignores quiet sections', () => {
  const fs = 48000;
  const x = concat(sine(fs, 10, 1000, -36), sine(fs, 60, 1000, -23), sine(fs, 10, 1000, -36));
  const l = integratedLoudness([x, x], fs);
  assert.ok(Math.abs(l - -23) < 0.1, `got ${l}`);
});

test('EBU 3341 case 5: absolute and relative gating combined', () => {
  const fs = 48000;
  const x = concat(sine(fs, 20, 1000, -26), sine(fs, 20.1, 1000, -20), sine(fs, 20, 1000, -26));
  const l = integratedLoudness([x, x], fs);
  assert.ok(Math.abs(l - -23) < 0.1, `got ${l}`);
});

test('loudness range of a two level programme', () => {
  const fs = 48000;
  // EBU 3342 case 1: 20 s at -20 then 20 s at -30 dBFS, LRA 10 +/- 1
  const x = concat(sine(fs, 20, 1000, -20), sine(fs, 20, 1000, -30));
  const m = measureLoudness([x, x], fs);
  assert.ok(Math.abs(m.lra - 10) < 1, `got LRA ${m.lra}`);
});

test('true peak finds inter-sample peaks of a quarter rate sine', () => {
  const fs = 48000;
  // fs/4 sine with 45 degree phase: samples sit at +-0.707, true peak is 1.0
  const x = sine(fs, 1, fs / 4, 0, Math.PI / 4);
  const sp = linToDb(samplePeak([x]));
  const tp = linToDb(truePeak([x]));
  assert.ok(Math.abs(sp - -3.01) < 0.05, `sample peak ${sp}`);
  assert.ok(Math.abs(tp - 0) < 0.3, `true peak ${tp}`);
});

test('true peak of a low frequency sine matches its amplitude', () => {
  const fs = 44100;
  const x = sine(fs, 1, 1000, -6, 0.3);
  const tp = linToDb(truePeak([x]));
  assert.ok(Math.abs(tp - -6) < 0.05, `true peak ${tp}`);
});
