// Algorithmic reverbs and delay for the mix buses.
//
//  * plate(): Jon Dattorro's plate (JAES "Effect Design Part 1", 1997).
//  * space(): 8 line feedback delay network (Jot style) with frequency
//    dependent decay and early reflections, for rooms, halls and cathedrals.
//  * delay(): filtered stereo ping-pong delay.
//
// Each returns new stereo arrays the same length as the input; reverb
// returns are energy normalised so a send level of X dB places the reverb
// roughly X dB below the dry signal.

import { designBiquad, BiquadChain } from './biquad.js';
import { makeRng } from './util.js';
import { decimate2, interpolate2 } from './resample2.js';

class Delay {
  constructor(len) {
    this.size = 1;
    while (this.size < len + 2) this.size <<= 1;
    this.mask = this.size - 1;
    this.buf = new Float64Array(this.size);
    this.w = 0;
  }

  write(v) {
    this.buf[this.w] = v;
    this.w = (this.w + 1) & this.mask;
  }

  // Sample written `d` steps ago (d >= 1 means before the latest write).
  read(d) {
    return this.buf[(this.w - d) & this.mask];
  }

  readFrac(d) {
    const i = Math.floor(d);
    const f = d - i;
    const a = this.buf[(this.w - i) & this.mask];
    const b = this.buf[(this.w - i - 1) & this.mask];
    return a + (b - a) * f;
  }
}

function flushTiny(v) {
  return v > -1e-25 && v < 1e-25 ? 0 : v;
}

function applyReturnEq(L, R, fs, hpf, lpf) {
  const sections = [];
  if (hpf) sections.push(designBiquad('highpass', hpf, fs, Math.SQRT1_2));
  if (lpf) sections.push(designBiquad('lowpass', lpf, fs, Math.SQRT1_2));
  if (!sections.length) return;
  const chain = new BiquadChain(sections, 2);
  chain.process(L, 0);
  chain.process(R, 1);
}

// ---------------------------------------------------------------------------
// Dattorro plate

const DAT_FS = 29761;

function pow2(n) {
  let s = 1;
  while (s < n + 2) s <<= 1;
  return s;
}

export function plate(inL, inR, fs, p = {}) {
  const n = inL.length;
  const s = fs / DAT_FS;
  const sc = (v) => Math.max(1, Math.round(v * s));
  const rt60 = p.rt60 ?? 1.8;
  // The tank loop is about 21589 samples at 29761 Hz with four decay
  // multiplications per trip, which gives this coefficient for a target RT60.
  const decay = Math.min(0.97, Math.pow(10, (-3 * (21589 / DAT_FS)) / (4 * rt60)));
  const damping = p.damping ?? 0.25;
  const bandwidth = p.bandwidth ?? 0.9995;
  const preD = Math.round((p.preDelay ?? 0.03) * fs);
  const dd2 = Math.min(0.5, Math.max(0.25, decay + 0.15));
  const exc = 16 * s;
  // Delay lengths.
  const lId1 = sc(142), lId2 = sc(107), lId3 = sc(379), lId4 = sc(277);
  const base1L = sc(672), base1R = sc(908);
  const l1L = sc(4453), l1R = sc(4217), lAp2L = sc(1800), lAp2R = sc(2656);
  const l2L = sc(3720), l2R = sc(3163);
  // Buffers (power of two sizes) sharing one write counter t.
  const mk = (len) => new Float32Array(pow2(len));
  const bPre = mk(preD + 1), bId1 = mk(lId1), bId2 = mk(lId2), bId3 = mk(lId3), bId4 = mk(lId4);
  const bAp1L = mk(base1L + Math.ceil(exc) + 2), bAp1R = mk(base1R + Math.ceil(exc) + 2);
  const b1L = mk(l1L), b1R = mk(l1R), bAp2L = mk(lAp2L), bAp2R = mk(lAp2R), b2L = mk(l2L), b2R = mk(l2R);
  const mPre = bPre.length - 1, mId1 = bId1.length - 1, mId2 = bId2.length - 1, mId3 = bId3.length - 1;
  const mId4 = bId4.length - 1, mAp1L = bAp1L.length - 1, mAp1R = bAp1R.length - 1;
  const m1L = b1L.length - 1, m1R = b1R.length - 1, mAp2L = bAp2L.length - 1, mAp2R = bAp2R.length - 1;
  const m2L = b2L.length - 1, m2R = b2R.length - 1;
  const TL0 = sc(266), TL1 = sc(2974), TL2 = sc(1913), TL3 = sc(1996), TL4 = sc(1990), TL5 = sc(187), TL6 = sc(1066);
  const TR0 = sc(353), TR1 = sc(3627), TR2 = sc(1228), TR3 = sc(2673), TR4 = sc(2111), TR5 = sc(335), TR6 = sc(121);
  let bw = 0, dampL = 0, dampR = 0, fbL = 0, fbR = 0;
  const lfoInc = (2 * Math.PI * (p.modRate ?? 0.9)) / fs;
  const cosD = Math.cos(lfoInc);
  const sinD = Math.sin(lfoInc);
  let lfoC = 1;
  let lfoS = 0;
  const outL = new Float32Array(n);
  const outR = new Float32Array(n);
  for (let t = 0; t < n; t++) {
    // Pre delay and input bandwidth filter.
    bPre[t & mPre] = 0.5 * (inL[t] + inR[t]);
    const xd = preD > 0 ? bPre[(t - preD) & mPre] : bPre[t & mPre];
    bw = bandwidth * xd + (1 - bandwidth) * bw;
    if (bw > -1e-25 && bw < 1e-25) bw = 0;
    // Input diffusers (allpass: z = delayed v, v = x - g z, y = z + g v).
    let z = bId1[(t - lId1) & mId1];
    let v = bw - 0.75 * z;
    bId1[t & mId1] = v;
    let y = z + 0.75 * v;
    z = bId2[(t - lId2) & mId2];
    v = y - 0.75 * z;
    bId2[t & mId2] = v;
    y = z + 0.75 * v;
    z = bId3[(t - lId3) & mId3];
    v = y - 0.625 * z;
    bId3[t & mId3] = v;
    y = z + 0.625 * v;
    z = bId4[(t - lId4) & mId4];
    v = y - 0.625 * z;
    bId4[t & mId4] = v;
    const diffused = z + 0.625 * v;
    // Modulation LFO (quadrature rotation).
    const nc = lfoC * cosD - lfoS * sinD;
    lfoS = lfoS * cosD + lfoC * sinD;
    lfoC = nc;
    if ((t & 4095) === 0) {
      const norm = 1 / Math.sqrt(lfoC * lfoC + lfoS * lfoS);
      lfoC *= norm;
      lfoS *= norm;
    }
    const dL = base1L + exc * (1 + lfoS) * 0.5;
    const dR = base1R + exc * (1 + lfoC) * 0.5;
    // Left tank: modulated allpass (g = -0.7), delay, damping, allpass, delay.
    let di = dL | 0;
    let fr = dL - di;
    let za = bAp1L[(t - di) & mAp1L];
    z = za + (bAp1L[(t - di - 1) & mAp1L] - za) * fr;
    v = diffused + fbR + 0.7 * z;
    bAp1L[t & mAp1L] = v;
    b1L[t & m1L] = z - 0.7 * v;
    let a = b1L[(t - l1L) & m1L];
    dampL = (1 - damping) * a + damping * dampL;
    if (dampL > -1e-25 && dampL < 1e-25) dampL = 0;
    z = bAp2L[(t - lAp2L) & mAp2L];
    v = dampL * decay - dd2 * z;
    bAp2L[t & mAp2L] = v;
    b2L[t & m2L] = z + dd2 * v;
    const halfL = b2L[(t - l2L) & m2L] * decay;
    // Right tank.
    di = dR | 0;
    fr = dR - di;
    za = bAp1R[(t - di) & mAp1R];
    z = za + (bAp1R[(t - di - 1) & mAp1R] - za) * fr;
    v = diffused + fbL + 0.7 * z;
    bAp1R[t & mAp1R] = v;
    b1R[t & m1R] = z - 0.7 * v;
    a = b1R[(t - l1R) & m1R];
    dampR = (1 - damping) * a + damping * dampR;
    if (dampR > -1e-25 && dampR < 1e-25) dampR = 0;
    z = bAp2R[(t - lAp2R) & mAp2R];
    v = dampR * decay - dd2 * z;
    bAp2R[t & mAp2R] = v;
    b2R[t & m2R] = z + dd2 * v;
    const halfR = b2R[(t - l2R) & m2R] * decay;
    fbL = halfL;
    fbR = halfR;
    // Output taps (Dattorro table 2).
    const l =
      b1R[(t - TL0) & m1R] + b1R[(t - TL1) & m1R] - bAp2R[(t - TL2) & mAp2R] + b2R[(t - TL3) & m2R] -
      b1L[(t - TL4) & m1L] - bAp2L[(t - TL5) & mAp2L] - b2L[(t - TL6) & m2L];
    const r =
      b1L[(t - TR0) & m1L] + b1L[(t - TR1) & m1L] - bAp2L[(t - TR2) & mAp2L] + b2L[(t - TR3) & m2L] -
      b1R[(t - TR4) & m1R] - bAp2R[(t - TR5) & mAp2R] - b2R[(t - TR6) & m2R];
    outL[t] = 0.6 * l;
    outR[t] = 0.6 * r;
  }
  applyReturnEq(outL, outR, fs, p.hpf ?? 250, p.lpf ?? 9000);
  return { L: outL, R: outR };
}

// ---------------------------------------------------------------------------
// FDN space (room / hall / cathedral)

const FDN_BASE_MS = [31.71, 37.11, 41.13, 43.93, 47.63, 53.33, 59.17, 67.07];
const ER_TAPS_MS = [7.1, 11.3, 16.9, 23.7, 29.3, 37.1, 43.9, 53.3];
const ER_GAINS = [0.84, 0.72, 0.66, 0.55, 0.47, 0.39, 0.33, 0.27];

function dampingCoef(r, fs, fd) {
  // One pole lowpass y = (1-b)x + b y[-1] whose gain at fd equals r.
  if (r >= 0.9999) return 0;
  const w = (2 * Math.PI * fd) / fs;
  const c = Math.cos(w);
  const r2 = r * r;
  const A = 1 - r2;
  const B = 1 - r2 * c;
  const disc = Math.max(0, B * B - A * A);
  return Math.min(0.95, Math.max(0, (B - Math.sqrt(disc)) / A));
}

export function space(inL, inR, fs, p = {}) {
  const n = inL.length;
  const size = p.size ?? 1;
  const rt60 = p.rt60 ?? 2.2;
  const hfRatio = p.hfRatio ?? 0.5; // RT60 at ~6 kHz relative to low/mid
  const erLevel = p.er ?? 0.35;
  const preD = Math.round((p.preDelay ?? 0.02) * fs);
  // Eight feedback lines in one buffer, each S long.
  const lens = new Int32Array(8);
  for (let j = 0; j < 8; j++) lens[j] = Math.max(8, Math.round(((FDN_BASE_MS[j] * size) / 1000) * fs) + 2 * j);
  let S = 1;
  while (S < lens[7] + 4) S <<= 1;
  const SM = S - 1;
  const lines = new Float32Array(8 * S);
  const gains = new Float64Array(8);
  const damp = new Float64Array(8);
  for (let j = 0; j < 8; j++) {
    gains[j] = Math.pow(10, (-3 * lens[j]) / (rt60 * fs));
    const gHi = Math.pow(10, (-3 * lens[j]) / (rt60 * hfRatio * fs));
    damp[j] = dampingCoef(gHi / gains[j], fs, 6000);
  }
  const ds = new Float64Array(8);
  // Input diffusers: 4 allpasses per side in one buffer each.
  const dLen = [4.7, 3.6, 12.7, 9.3].map((ms) => Math.max(2, Math.round(((ms * Math.sqrt(size)) / 1000) * fs)));
  let DS = 1;
  while (DS < Math.max(...dLen) + 12) DS <<= 1;
  const DM = DS - 1;
  const diffL = new Float32Array(4 * DS);
  const diffR = new Float32Array(4 * DS);
  const dl0 = dLen[0], dl1 = dLen[1], dl2 = dLen[2], dl3 = dLen[3];
  const dr0 = dl0 + 7, dr1 = dl1 + 7, dr2 = dl2 + 7, dr3 = dl3 + 7;
  const G = 0.68;
  // Pre delay and early reflections.
  let PS = 1;
  const erMax = Math.round(((ER_TAPS_MS[ER_TAPS_MS.length - 1] * size) / 1000) * fs) + 4;
  while (PS < Math.max(preD, erMax) + 4) PS <<= 1;
  const PM = PS - 1;
  const preL = new Float32Array(PS);
  const preR = new Float32Array(PS);
  const er = new Float32Array(PS);
  const erTaps = new Int32Array(ER_TAPS_MS.map((ms) => Math.max(1, Math.round(((ms * size) / 1000) * fs))));
  const erG = Float64Array.from(ER_GAINS);
  const outL = new Float32Array(n);
  const outR = new Float32Array(n);
  const y = new Float64Array(8);
  const k = 1 / Math.sqrt(8);
  const SL = Float64Array.of(1, -1, 1, -1, 1, -1, 1, -1);
  const SR = Float64Array.of(1, 1, -1, -1, 1, 1, -1, -1);
  const ap = (buf, base, len, t, x) => {
    const z = buf[base + ((t - len) & DM)];
    const v = x - G * z;
    buf[base + (t & DM)] = v;
    return z + G * v;
  };
  for (let t = 0; t < n; t++) {
    preL[t & PM] = inL[t];
    preR[t & PM] = inR[t];
    const xl = preD > 0 ? preL[(t - preD) & PM] : inL[t];
    const xr = preD > 0 ? preR[(t - preD) & PM] : inR[t];
    er[t & PM] = 0.5 * (xl + xr);
    let dl = ap(diffL, 0, dl0, t, xl);
    dl = ap(diffL, DS, dl1, t, dl);
    dl = ap(diffL, 2 * DS, dl2, t, dl);
    dl = ap(diffL, 3 * DS, dl3, t, dl);
    let dr = ap(diffR, 0, dr0, t, xr);
    dr = ap(diffR, DS, dr1, t, dr);
    dr = ap(diffR, 2 * DS, dr2, t, dr);
    dr = ap(diffR, 3 * DS, dr3, t, dr);
    let l = 0;
    let r = 0;
    for (let j = 0; j < 8; j++) {
      const v = lines[j * S + ((t - lens[j]) & SM)];
      l += SL[j] * v;
      r += SR[j] * v;
      const b = damp[j];
      let d = (1 - b) * v + b * ds[j];
      if (d > -1e-25 && d < 1e-25) d = 0;
      ds[j] = d;
      y[j] = d * gains[j];
    }
    // Fast Walsh-Hadamard transform (orthogonal feedback matrix), unrolled.
    const a0 = y[0] + y[1], a1 = y[0] - y[1], a2 = y[2] + y[3], a3 = y[2] - y[3];
    const a4 = y[4] + y[5], a5 = y[4] - y[5], a6 = y[6] + y[7], a7 = y[6] - y[7];
    const b0 = a0 + a2, b1 = a1 + a3, b2 = a0 - a2, b3 = a1 - a3;
    const b4 = a4 + a6, b5 = a5 + a7, b6 = a4 - a6, b7 = a5 - a7;
    const w = t & SM;
    lines[w] = (b0 + b4) * k + dl * 0.5;
    lines[S + w] = (b1 + b5) * k - dl * 0.5;
    lines[2 * S + w] = (b2 + b6) * k + dl * 0.5;
    lines[3 * S + w] = (b3 + b7) * k - dl * 0.5;
    lines[4 * S + w] = (b0 - b4) * k + dr * 0.5;
    lines[5 * S + w] = (b1 - b5) * k - dr * 0.5;
    lines[6 * S + w] = (b2 - b6) * k + dr * 0.5;
    lines[7 * S + w] = (b3 - b7) * k - dr * 0.5;
    let el = 0;
    let erv = 0;
    for (let q = 0; q < 8; q += 2) {
      el += er[(t - erTaps[q]) & PM] * erG[q];
      erv += er[(t - erTaps[q + 1]) & PM] * erG[q + 1];
    }
    outL[t] = l * k + erLevel * el;
    outR[t] = r * k + erLevel * erv;
  }
  applyReturnEq(outL, outR, fs, p.hpf ?? 220, p.lpf ?? 9500);
  return { L: outL, R: outR };
}

// ---------------------------------------------------------------------------
// Ping-pong delay

export function delay(inL, inR, fs, p = {}) {
  const n = inL.length;
  const time = Math.max(0.01, p.time ?? 0.375);
  const fb = Math.min(0.85, p.feedback ?? 0.3);
  const d = Math.round(time * fs);
  const lineL = new Delay(d + 2);
  const lineR = new Delay(d + 2);
  const hp = designBiquad('highpass', p.hpf ?? 300, fs, Math.SQRT1_2);
  const lp = designBiquad('lowpass', p.lpf ?? 5000, fs, Math.SQRT1_2);
  // Per channel state of the two feedback filters [hp z1, hp z2, lp z1, lp z2].
  const st = [new Float64Array(4), new Float64Array(4)];
  const filt = (x, s) => {
    let y = hp[0] * x + s[0];
    s[0] = hp[1] * x - hp[3] * y + s[1];
    s[1] = hp[2] * x - hp[4] * y;
    const x2 = y;
    y = lp[0] * x2 + s[2];
    s[2] = lp[1] * x2 - lp[3] * y + s[3];
    s[3] = lp[2] * x2 - lp[4] * y;
    return flushTiny(y);
  };
  const outL = new Float32Array(n);
  const outR = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = 0.5 * (inL[i] + inR[i]);
    const yl = lineL.read(d);
    const yr = lineR.read(d);
    const fl = filt(yl, st[0]);
    const fr = filt(yr, st[1]);
    lineL.write(x + fr * fb);
    lineR.write(fl * fb);
    outL[i] = fl;
    outR[i] = fr;
  }
  return { L: outL, R: outR };
}

// ---------------------------------------------------------------------------

// Energy of the reverb impulse response for a parameter set, used to
// normalise the return level. Measured on a short impulse render.
export function impulseEnergy(kind, fs, p) {
  const secs = Math.min(8, (p.rt60 ?? 2) * 1.6 + (p.preDelay ?? 0) + 0.2);
  const len = Math.round(secs * fs);
  const imp = new Float32Array(len);
  imp[0] = 1;
  const fn = kind === 'plate' ? plate : space;
  const { L, R } = fn(imp, imp, fs, p);
  let e = 0;
  for (let i = 0; i < len; i++) e += L[i] * L[i] + R[i] * R[i];
  return e / 2;
}

// Run a reverb over a send bus and scale the return so its energy matches
// the energy of the input (for broadband material). At 44.1 kHz and above the
// reverb runs at half rate; returns are low passed well below that Nyquist.
export function renderReverb(kind, inL, inR, fs, p) {
  const fn = kind === 'plate' ? plate : space;
  const half = fs >= 44100;
  const rate = half ? fs / 2 : fs;
  const params = { ...p, lpf: Math.min(p.lpf ?? 9500, rate * 0.45) };
  const a = half ? decimate2(inL) : inL;
  const b = half ? decimate2(inR) : inR;
  const out = fn(a, b, rate, params);
  const e = impulseEnergy(kind, rate, params);
  const g = e > 0 ? 1 / Math.sqrt(e) : 1;
  for (let i = 0; i < out.L.length; i++) {
    out.L[i] *= g;
    out.R[i] *= g;
  }
  if (!half) return out;
  return { L: interpolate2(out.L, inL.length), R: interpolate2(out.R, inR.length) };
}

// Stereo decorrelated noise, handy for tests.
export function noise(n, seed = 1) {
  const rng = makeRng(seed);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = rng() * 2 - 1;
  return out;
}
