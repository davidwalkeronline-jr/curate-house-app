// Synthetic multitrack session for tests: a 120 BPM song in G with drums
// (multi mic, snare bottom polarity flipped), bass, guitars, keys, pad,
// a formant synthesised lead vocal with sibilance, BGVs, click and guide.
// Stems are recorded at deliberately inconsistent "raw" levels.

import { makeRng } from '../js/engine/util.js';
import { designBiquad, BiquadChain } from '../js/engine/biquad.js';

export const SYNTH_BPM = 120;

function filt(x, sections) {
  new BiquadChain(sections, 1).process(x);
  return x;
}

function scale(x, peakDb) {
  let pk = 0;
  for (let i = 0; i < x.length; i++) pk = Math.max(pk, Math.abs(x[i]));
  const g = pk > 0 ? Math.pow(10, peakDb / 20) / pk : 1;
  for (let i = 0; i < x.length; i++) x[i] *= g;
  return x;
}

const NOTE = (m) => 440 * Math.pow(2, (m - 69) / 12);
// G D Em C, two bars each; MIDI roots and triads.
const CHORDS = [
  { root: 43, tri: [55, 59, 62] },
  { root: 38, tri: [50, 54, 57] },
  { root: 40, tri: [52, 55, 59] },
  { root: 36, tri: [48, 52, 55] },
];
const MELODY = [67, 69, 71, 74, 72, 71, 69, 67, 66, 67, 69, 71, 69, 67, 64, 62];

export function synthSession({ fs = 48000, bars = 24, seed = 1 } = {}) {
  const rng = makeRng(seed);
  const beat = 60 / SYNTH_BPM;
  const bar = beat * 4;
  const n = Math.round(bars * bar * fs) + fs;
  const chorusFrom = Math.floor(bars / 2);
  const make = () => new Float32Array(n);
  const noise = () => rng() * 2 - 1;
  const chordAt = (b) => CHORDS[Math.floor(b / 2) % 4];

  // Drums -------------------------------------------------------------
  const kickIn = make();
  const kickOut = make();
  const snTop = make();
  const snBot = make();
  const hats = make();
  const ohL = make();
  const ohR = make();
  for (let b = 0; b < bars; b++) {
    const chorus = b >= chorusFrom;
    for (let q = 0; q < 8; q++) {
      const t0 = Math.round((b * bar + q * beat * 0.5) * fs);
      const vel = 0.8 + 0.2 * rng();
      // Kick on 1, 3 (+ the "and" of 3 in choruses).
      if (q === 0 || q === 4 || (chorus && q === 5)) {
        let ph = 0;
        for (let i = 0; i < 0.35 * fs && t0 + i < n; i++) {
          const t = i / fs;
          const f = 45 + 80 * Math.exp(-t * 30);
          ph += (2 * Math.PI * f) / fs;
          const v = Math.sin(ph) * Math.exp(-t * 9) * vel;
          const click = i < 0.004 * fs ? noise() * 0.5 * (1 - i / (0.004 * fs)) : 0;
          kickIn[t0 + i] += v + click;
          if (t0 + i + 96 < n) kickOut[t0 + i + 96] += v * 1.2 + click * 0.1; // ~2 ms later, darker
          ohL[t0 + i + 300] += v * 0.15;
          ohR[t0 + i + 330] += v * 0.15;
        }
      }
      // Snare on 2 and 4.
      if (q === 2 || q === 6) {
        for (let i = 0; i < 0.25 * fs && t0 + i < n; i++) {
          const t = i / fs;
          const tone = Math.sin(2 * Math.PI * 190 * t) * Math.exp(-t * 25) * 0.7;
          const wires = noise() * Math.exp(-t * 14) * 0.6;
          snTop[t0 + i] += (tone + wires * 0.6) * vel;
          // Bottom mic faces the other way: tone arrives inverted.
          snBot[t0 + i] += (-tone * 0.7 + wires * 0.9) * vel;
          ohL[t0 + i + 250] += (tone + wires) * 0.25;
          ohR[t0 + i + 230] += (tone + wires) * 0.25;
        }
      }
      // Hats on eighths.
      for (let i = 0; i < 0.06 * fs && t0 + i < n; i++) {
        const v = noise() * Math.exp(-(i / fs) * 60) * (q % 2 ? 0.5 : 0.8);
        hats[t0 + i] += v;
        ohL[t0 + i + 200] += v * 0.5;
        ohR[t0 + i + 260] += v * 0.3;
      }
    }
    if (b === chorusFrom) {
      const t0 = Math.round(b * bar * fs);
      for (let i = 0; i < 2.5 * fs && t0 + i < n; i++) {
        const v = noise() * Math.exp(-(i / fs) * 1.6) * 0.6;
        ohL[t0 + i] += v;
        ohR[t0 + i] += v * 0.8;
      }
    }
  }
  filt(hats, [designBiquad('highpass', 6000, fs, 0.7), designBiquad('highpass', 6000, fs, 0.7)]);
  filt(kickOut, [designBiquad('lowpass', 1200, fs, 0.7)]);
  // Bleed: drums leak into each other's mics.
  for (let i = 0; i < n; i++) {
    const kit = 0.04 * (snTop[i] + hats[i]);
    kickIn[i] += kit * 0.5;
    snTop[i] += 0.05 * (hats[i] + kickIn[i]);
  }
  filt(ohL, [designBiquad('highpass', 150, fs, 0.7)]);
  filt(ohR, [designBiquad('highpass', 150, fs, 0.7)]);

  // Bass DI ------------------------------------------------------------
  const bass = make();
  for (let b = 0; b < bars; b++) {
    const f0 = NOTE(chordAt(b).root - 12 + 12);
    for (let q = 0; q < 8; q++) {
      const t0 = Math.round((b * bar + q * beat * 0.5) * fs);
      const len = Math.round(beat * 0.5 * fs);
      for (let i = 0; i < len && t0 + i < n; i++) {
        const t = i / fs;
        let v = 0;
        for (let h = 1; h <= 6; h++) v += Math.sin(2 * Math.PI * f0 * h * t) / h;
        bass[t0 + i] += v * (0.4 + 0.6 * Math.exp(-t * 6)) * Math.min(1, i / 60);
      }
    }
  }
  filt(bass, [designBiquad('lowpass', 900, fs, 0.7)]);

  // Guitars (double tracked, distorted) ---------------------------------
  const gtrL = make();
  const gtrR = make();
  for (const [g, jitterSeed] of [[gtrL, 1], [gtrR, 2]]) {
    const jr = makeRng(seed * 10 + jitterSeed);
    for (let b = chorusFrom - 4; b < bars; b++) {
      const ch = chordAt(b);
      for (let q = 0; q < 8; q++) {
        const t0 = Math.round((b * bar + q * beat * 0.5 + (jr() - 0.5) * 0.012) * fs);
        const len = Math.round(beat * 0.5 * fs);
        for (let i = 0; i < len && t0 + i < n; i++) {
          const t = i / fs;
          let v = 0;
          for (const m of [ch.root, ch.root + 7, ch.root + 12]) {
            const f = NOTE(m + 12) * (1 + (jr() - 0.5) * 0.0005);
            v += 2 * ((t * f) % 1) - 1;
          }
          g[t0 + i] += Math.tanh(v * 2.5) * (0.6 + 0.4 * Math.exp(-t * 8));
        }
      }
    }
    filt(g, [designBiquad('highpass', 100, fs, 0.7), designBiquad('lowpass', 5000, fs, 0.7), designBiquad('peaking', 300, fs, 1, 5)]);
  }

  // Acoustic guitar (Karplus-Strong strums) -----------------------------
  const ag = make();
  for (let b = 0; b < bars; b++) {
    const ch = chordAt(b);
    for (let q = 0; q < 4; q++) {
      const t0 = Math.round((b * bar + q * beat) * fs);
      ch.tri.concat([ch.root + 12]).forEach((m, k) => {
        const f = NOTE(m);
        const period = Math.round(fs / f);
        const buf = new Float32Array(period).map(() => noise());
        const start = t0 + k * 180;
        const len = Math.round(beat * 1.2 * fs);
        let idx = 0;
        for (let i = 0; i < len && start + i < n; i++) {
          const nxt = (idx + 1) % period;
          const v = 0.996 * 0.5 * (buf[idx] + buf[nxt]);
          buf[idx] = v;
          idx = nxt;
          ag[start + i] += v * 0.5;
        }
      });
    }
  }
  filt(ag, [designBiquad('peaking', 180, fs, 1.5, 6)]); // boomy body resonance

  // Piano (stereo) -------------------------------------------------------
  const pnoL = make();
  const pnoR = make();
  for (let b = 0; b < bars; b += 1) {
    const ch = chordAt(b);
    const t0 = Math.round(b * bar * fs);
    for (const m of ch.tri.map((x) => x + 12)) {
      const f = NOTE(m);
      const pan = (m % 12) / 12;
      for (let i = 0; i < bar * fs && t0 + i < n; i++) {
        const t = i / fs;
        const env = Math.exp(-t * 1.5);
        const v = (Math.sin(2 * Math.PI * f * t) + 0.4 * Math.sin(4 * Math.PI * f * t) + 0.15 * Math.sin(6 * Math.PI * f * t)) * env * 0.3;
        pnoL[t0 + i] += v * (1 - pan * 0.5);
        pnoR[t0 + i] += v * (0.5 + pan * 0.5);
      }
    }
  }

  // Pad (stereo, detuned saws) ------------------------------------------
  const padL = make();
  const padR = make();
  for (let b = 0; b < bars; b++) {
    const ch = chordAt(b);
    const t0 = Math.round(b * bar * fs);
    for (let i = 0; i < bar * fs && t0 + i < n; i++) {
      const t = (t0 + i) / fs;
      const env = Math.min(1, i / (0.3 * fs)) * Math.min(1, (bar * fs - i) / (0.2 * fs));
      let l = 0;
      let r = 0;
      for (const m of ch.tri) {
        const f = NOTE(m);
        l += 2 * ((t * f * 1.003) % 1) - 1;
        r += 2 * ((t * f * 0.997) % 1) - 1;
      }
      padL[t0 + i] += l * env * 0.2;
      padR[t0 + i] += r * env * 0.2;
    }
  }
  filt(padL, [designBiquad('lowpass', 2500, fs, 0.7)]);
  filt(padR, [designBiquad('lowpass', 2500, fs, 0.7)]);

  // Vocals (formant synthesis) -------------------------------------------
  const vowel = [[700, 1220, 2600], [400, 2000, 2550], [300, 870, 2240]];
  function voice(out, transpose, fromBar, gainV) {
    const src = new Float32Array(n);
    let ph = 0;
    for (let b = fromBar; b < bars; b++) {
      for (let k = 0; k < 2; k++) {
        const noteIdx = (b * 2 + k) % MELODY.length;
        const f0 = NOTE(MELODY[noteIdx] - 12 + transpose);
        const t0 = Math.round((b * bar + k * bar * 0.5) * fs);
        const len = Math.round(bar * 0.42 * fs);
        for (let i = 0; i < len && t0 + i < n; i++) {
          const t = i / fs;
          const f = f0 * (1 + 0.012 * Math.sin(2 * Math.PI * 5.5 * t) * Math.min(1, t * 3));
          ph += f / fs;
          const pulse = 2 * (ph % 1) - 1;
          const env = Math.min(1, i / 1200) * Math.min(1, (len - i) / 2400);
          src[t0 + i] += pulse * env;
        }
        // Sibilant "s" at the phrase start.
        if (k === 0) {
          for (let i = 0; i < 0.09 * fs && t0 - 4500 + i < n; i++) {
            if (t0 - 4500 + i >= 0) out[t0 - 4500 + i] += noise() * 0.25 * Math.sin((Math.PI * i) / (0.09 * fs)) * gainV;
          }
        }
      }
    }
    const v = vowel[transpose % 3 === 0 ? 0 : 1];
    for (let fi = 0; fi < 3; fi++) {
      const y = Float32Array.from(src);
      filt(y, [designBiquad('bandpass', v[fi], fs, 6)]);
      const gF = [1, 0.6, 0.35][fi];
      for (let i = 0; i < n; i++) out[i] += y[i] * gF * gainV;
    }
  }
  const lead = make();
  voice(lead, 0, 2, 1);
  const sib = make();
  for (let i = 0; i < n; i++) sib[i] = lead[i];
  filt(lead, [designBiquad('highpass', 70, fs, 0.7), designBiquad('peaking', 250, fs, 1, 4)]); // muddy mic
  const sibOnly = filt(sib, [designBiquad('highpass', 4000, fs, 0.7)]);
  for (let i = 0; i < n; i++) lead[i] += sibOnly[i] * 1.5;
  const bgv1 = make();
  voice(bgv1, 4, chorusFrom, 0.8);
  const bgv2 = make();
  voice(bgv2, 7, chorusFrom, 0.8);

  // Click and guide --------------------------------------------------------
  const click = make();
  for (let k = 0; k * beat * fs < n - fs; k++) {
    const t0 = Math.round(k * beat * fs);
    const f = k % 4 === 0 ? 1500 : 1000;
    for (let i = 0; i < 0.03 * fs; i++) click[t0 + i] += Math.sin((2 * Math.PI * f * i) / fs) * Math.exp(-i / (0.006 * fs));
  }
  const guide = make();
  for (const b of [0, chorusFrom - 1]) {
    const t0 = Math.round((b * bar + beat * 2) * fs);
    for (let i = 0; i < 0.8 * fs; i++) guide[t0 + i] += noise() * 0.3 * Math.abs(Math.sin((2 * Math.PI * 4 * i) / fs));
  }
  filt(guide, [designBiquad('bandpass', 1200, fs, 0.8)]);

  // Raw recording levels (deliberately inconsistent).
  const stems = [
    ['Kick In', [scale(kickIn, -4)]],
    ['Kick Out', [scale(kickOut, -9)]],
    ['Snare Top', [scale(snTop, -3)]],
    ['Snare Bottom', [scale(snBot, -14)]],
    ['HiHat', [scale(hats, -18)]],
    ['OH L', [ohL]],
    ['OH R', [ohR]],
    ['Bass DI', [scale(bass, -12)]],
    ['Gtr L', [scale(gtrL, -10)]],
    ['Gtr R', [scale(gtrR, -6)]],
    ['Acoustic', [scale(ag, -8)]],
    ['Piano', [pnoL, pnoR]],
    ['Pad', [padL, padR]],
    ['Lead Vox', [scale(lead, -7)]],
    ['BGV 1', [scale(bgv1, -16)]],
    ['BGV 2', [scale(bgv2, -12)]],
    ['Click', [scale(click, -6)]],
    ['Guide', [scale(guide, -10)]],
  ];
  // Stereo pairs share a scale so their image survives.
  for (const pair of [[ohL, ohR, -10], [pnoL, pnoR, -9], [padL, padR, -20]]) {
    let pk = 0;
    for (const x of pair.slice(0, 2)) for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(x[i]));
    const g = Math.pow(10, pair[2] / 20) / pk;
    for (const x of pair.slice(0, 2)) for (let i = 0; i < n; i++) x[i] *= g;
  }
  return { fs, n, stems };
}

// Minimal WAV writer for mono or stereo 24 bit test files.
export function wavBytes(chs, fs) {
  const n = chs[0].length;
  const nc = chs.length;
  const data = n * nc * 3;
  const buf = new ArrayBuffer(44 + data);
  const dv = new DataView(buf);
  const w = (o, s) => [...s].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF');
  dv.setUint32(4, 36 + data, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, nc, true);
  dv.setUint32(24, fs, true);
  dv.setUint32(28, fs * nc * 3, true);
  dv.setUint16(32, nc * 3, true);
  dv.setUint16(34, 24, true);
  w(36, 'data');
  dv.setUint32(40, data, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nc; c++) {
      let q = Math.round(Math.max(-1, Math.min(1, chs[c][i])) * 8388607);
      dv.setUint8(o++, q & 0xff);
      dv.setUint8(o++, (q >> 8) & 0xff);
      dv.setUint8(o++, (q >> 16) & 0xff);
    }
  }
  return new Uint8Array(buf);
}

