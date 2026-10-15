// Block floating point storage for long audio channels.
//
// Each block of 512 samples (about 10 ms) stores one float scale plus 16 bit
// mantissas, halving memory compared with Float32 while keeping roughly
// 96 dB of resolution relative to the local signal level. Raw stems are kept
// in this form so large sessions fit comfortably in a browser tab.

export const BFP_BLOCK = 512;

export function packChannel(f32) {
  const n = f32.length;
  const nb = Math.ceil(n / BFP_BLOCK);
  const scales = new Float32Array(nb);
  const data = new Int16Array(n);
  for (let b = 0; b < nb; b++) {
    const s = b * BFP_BLOCK;
    const e = Math.min(n, s + BFP_BLOCK);
    let pk = 0;
    for (let i = s; i < e; i++) {
      const a = f32[i] < 0 ? -f32[i] : f32[i];
      if (a > pk) pk = a;
    }
    if (!(pk > 1e-30)) continue; // silent block (also catches NaN)
    const sc = pk / 32767;
    const inv = 1 / sc;
    scales[b] = sc;
    for (let i = s; i < e; i++) {
      const v = Math.round(f32[i] * inv);
      data[i] = v > 32767 ? 32767 : v < -32767 ? -32767 : v;
    }
  }
  return { length: n, scales, data };
}

// Write samples [start, end) of a packed channel into out[outOffset ...].
export function unpackInto(p, out, start = 0, end = p.length, outOffset = 0) {
  const { scales, data } = p;
  let i = start;
  let o = outOffset;
  while (i < end) {
    const b = (i / BFP_BLOCK) | 0;
    const be = Math.min(end, (b + 1) * BFP_BLOCK);
    const sc = scales[b];
    if (sc === 0) {
      for (; i < be; i++, o++) out[o] = 0;
    } else {
      for (; i < be; i++, o++) out[o] = data[i] * sc;
    }
  }
  return out;
}

export function unpackChannel(p, start = 0, end = p.length) {
  const out = new Float32Array(Math.max(0, end - start));
  return unpackInto(p, out, start, end, 0);
}

// Copy of a packed channel restricted to [start, end). The slice starts on a
// block boundary at or before `start`; the returned offset tells where the
// requested start sits inside the slice.
export function slicePacked(p, start, end) {
  const s = Math.max(0, Math.floor(start / BFP_BLOCK) * BFP_BLOCK);
  const e = Math.min(p.length, end);
  const b0 = s / BFP_BLOCK;
  const b1 = Math.ceil(e / BFP_BLOCK);
  return {
    packed: {
      length: e - s,
      scales: p.scales.slice(b0, b1),
      data: p.data.slice(s, e),
    },
    offset: start - s,
    origin: s,
  };
}

export function packedBytes(p) {
  return p.data.byteLength + p.scales.byteLength;
}
