// WAV writer: 16 bit (with TPDF dither) or 24 bit PCM, optional trim.

import { makeRng } from './util.js';

// First/last sample index above `thresholdDb` (with small margins).
export function trimPoints(L, R, fs, thresholdDb = -60) {
  const thr = Math.pow(10, thresholdDb / 20);
  const n = L.length;
  let first = 0;
  while (first < n && Math.abs(L[first]) < thr && Math.abs(R[first]) < thr) first++;
  let last = n - 1;
  while (last > first && Math.abs(L[last]) < thr && Math.abs(R[last]) < thr) last--;
  if (first >= n) return [0, n];
  const pre = Math.round(0.05 * fs);
  const post = Math.round(0.5 * fs);
  return [Math.max(0, first - pre), Math.min(n, last + post)];
}

export function encodeWav(L, R, fs, bits = 24, { trim = false } = {}) {
  let [start, end] = trim ? trimPoints(L, R, fs) : [0, L.length];
  const n = end - start;
  const bps = bits / 8;
  const dataBytes = n * 2 * bps;
  const buf = new ArrayBuffer(44 + dataBytes);
  const dv = new DataView(buf);
  const str = (o, s) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  dv.setUint32(4, 36 + dataBytes, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 2, true);
  dv.setUint32(24, fs, true);
  dv.setUint32(28, fs * 2 * bps, true);
  dv.setUint16(32, 2 * bps, true);
  dv.setUint16(34, bits, true);
  str(36, 'data');
  dv.setUint32(40, dataBytes, true);
  const bytes = new Uint8Array(buf);
  const fadeIn = trim ? Math.min(n, Math.round(0.005 * fs)) : 0;
  const fadeOut = trim ? Math.min(n, Math.round(0.4 * fs)) : 0;
  const rng = makeRng(7);
  let o = 44;
  const max = bits === 16 ? 32767 : 8388607;
  for (let i = 0; i < n; i++) {
    let g = 1;
    if (i < fadeIn) g = i / fadeIn;
    else if (i >= n - fadeOut) g = (n - i) / fadeOut;
    for (let c = 0; c < 2; c++) {
      let v = (c ? R : L)[start + i] * g * max;
      if (bits === 16) v += rng() - rng(); // TPDF dither, +-1 LSB
      let q = Math.round(v);
      if (q > max) q = max;
      else if (q < -max - 1) q = -max - 1;
      if (bits === 16) {
        bytes[o++] = q & 0xff;
        bytes[o++] = (q >> 8) & 0xff;
      } else {
        bytes[o++] = q & 0xff;
        bytes[o++] = (q >> 8) & 0xff;
        bytes[o++] = (q >> 16) & 0xff;
      }
    }
  }
  return new Blob([buf], { type: 'audio/wav' });
}
