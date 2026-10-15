// Audio file reading. WAV (PCM / float, incl. extensible, RF64 and Broadcast
// WAV timestamps) and AIFF/AIFC are parsed directly so sessions keep their
// native sample rate and bit depth; anything else (MP3, FLAC, M4A, OGG...)
// falls back to the browser's decoder. Samples are packed straight into
// block floating point storage to keep memory low.

import { BFP_BLOCK } from './bfp.js';

function fourcc(dv, off) {
  return String.fromCharCode(dv.getUint8(off), dv.getUint8(off + 1), dv.getUint8(off + 2), dv.getUint8(off + 3));
}

// IEEE 754 80 bit extended (AIFF sample rate).
function readExtended(dv, off) {
  const expon = dv.getUint16(off) & 0x7fff;
  const sign = dv.getUint16(off) & 0x8000 ? -1 : 1;
  const hi = dv.getUint32(off + 2);
  const lo = dv.getUint32(off + 6);
  if (expon === 0 && hi === 0 && lo === 0) return 0;
  const mant = hi * Math.pow(2, -31) + lo * Math.pow(2, -63);
  return sign * mant * Math.pow(2, expon - 16383);
}

// Returns a header description or null if the file is not WAV/AIFF.
export function readHeader(buf) {
  if (buf.byteLength < 12) return null;
  const dv = new DataView(buf);
  const id = fourcc(dv, 0);
  if (id === 'RIFF' || id === 'RF64' || id === 'BW64') return readWavHeader(dv, id !== 'RIFF');
  if (id === 'FORM') return readAiffHeader(dv);
  return null;
}

function readWavHeader(dv, isRf64) {
  if (fourcc(dv, 8) !== 'WAVE') return null;
  let off = 12;
  const len = dv.byteLength;
  const h = { container: 'wav', bigEndian: false, bextTimeRef: null };
  let ds64DataSize = null;
  while (off + 8 <= len) {
    const cid = fourcc(dv, off);
    let size = dv.getUint32(off + 4, true);
    const body = off + 8;
    if (cid === 'ds64' && isRf64) {
      const lo = dv.getUint32(body + 8, true);
      const hi = dv.getUint32(body + 12, true);
      ds64DataSize = hi * 4294967296 + lo;
    } else if (cid === 'fmt ') {
      let format = dv.getUint16(body, true);
      h.channels = dv.getUint16(body + 2, true);
      h.sampleRate = dv.getUint32(body + 4, true);
      h.blockAlign = dv.getUint16(body + 12, true);
      h.bits = dv.getUint16(body + 14, true);
      if (format === 0xfffe && size >= 26) format = dv.getUint16(body + 24, true);
      h.format = format === 3 ? 'float' : format === 1 ? 'pcm' : 'unsupported';
    } else if (cid === 'bext' && size >= 346) {
      const lo = dv.getUint32(body + 338, true);
      const hi = dv.getUint32(body + 342, true);
      h.bextTimeRef = hi * 4294967296 + lo;
    } else if (cid === 'data') {
      if (ds64DataSize !== null && (size === 0xffffffff || isRf64)) size = ds64DataSize;
      if (size === 0 || size === 0xffffffff || body + size > len) size = len - body;
      h.dataOffset = body;
      h.dataBytes = size;
      break;
    }
    if (size === 0xffffffff) break;
    off = body + size + (size & 1);
  }
  if (!h.dataOffset || !h.channels || !h.sampleRate || !h.bits) return null;
  h.bytesPerSample = h.bits / 8;
  if (!h.blockAlign) h.blockAlign = h.bytesPerSample * h.channels;
  h.frames = Math.floor(h.dataBytes / h.blockAlign);
  return h;
}

function readAiffHeader(dv) {
  const kind = fourcc(dv, 8);
  if (kind !== 'AIFF' && kind !== 'AIFC') return null;
  const h = { container: 'aiff', bigEndian: true, bextTimeRef: null, format: 'pcm' };
  let off = 12;
  const len = dv.byteLength;
  while (off + 8 <= len) {
    const cid = fourcc(dv, off);
    let size = dv.getUint32(off + 4);
    const body = off + 8;
    if (cid === 'COMM') {
      h.channels = dv.getUint16(body);
      h.frames = dv.getUint32(body + 2);
      h.bits = dv.getUint16(body + 6);
      h.sampleRate = readExtended(dv, body + 8);
      if (kind === 'AIFC' && size >= 22) {
        const comp = fourcc(dv, body + 18);
        if (comp === 'sowt') h.bigEndian = false;
        else if (comp === 'fl32' || comp === 'FL32') {
          h.format = 'float';
          h.bits = 32;
        } else if (comp === 'fl64' || comp === 'FL64') {
          h.format = 'float';
          h.bits = 64;
        } else if (comp !== 'NONE' && comp !== 'twos' && comp !== 'in24' && comp !== 'in32') {
          h.format = 'unsupported';
        }
      }
    } else if (cid === 'SSND') {
      const ssOff = dv.getUint32(body);
      h.dataOffset = body + 8 + ssOff;
      if (size === 0 || body + size > len) size = len - body;
      h.dataBytes = size - 8 - ssOff;
    }
    off = body + size + (size & 1);
  }
  if (!h.dataOffset || !h.channels || !h.sampleRate) return null;
  h.bytesPerSample = h.bits / 8;
  h.blockAlign = h.bytesPerSample * h.channels;
  h.frames = Math.min(h.frames ?? Infinity, Math.floor(h.dataBytes / h.blockAlign));
  return h;
}

export function canParseDirectly(h) {
  if (!h || h.format === 'unsupported') return false;
  if (h.format === 'float') return h.bits === 32 || h.bits === 64;
  return h.bits === 8 || h.bits === 16 || h.bits === 24 || h.bits === 32;
}

// Read `count` frames of channel `ch` starting at `frame` into out (Float32).
function readSamples(dv, h, ch, frame, count, out) {
  const ba = h.blockAlign;
  const bps = h.bytesPerSample;
  const le = !h.bigEndian;
  let p = h.dataOffset + frame * ba + ch * bps;
  if (h.format === 'float') {
    if (h.bits === 32) for (let i = 0; i < count; i++, p += ba) out[i] = dv.getFloat32(p, le);
    else for (let i = 0; i < count; i++, p += ba) out[i] = dv.getFloat64(p, le);
    return;
  }
  switch (h.bits) {
    case 8:
      // WAV 8 bit is unsigned, AIFF 8 bit is signed.
      if (h.container === 'wav') for (let i = 0; i < count; i++, p += ba) out[i] = (dv.getUint8(p) - 128) / 128;
      else for (let i = 0; i < count; i++, p += ba) out[i] = dv.getInt8(p) / 128;
      break;
    case 16:
      for (let i = 0; i < count; i++, p += ba) out[i] = dv.getInt16(p, le) / 32768;
      break;
    case 24:
      if (le) {
        for (let i = 0; i < count; i++, p += ba) {
          const v = dv.getUint8(p) | (dv.getUint8(p + 1) << 8) | (dv.getInt8(p + 2) << 16);
          out[i] = v / 8388608;
        }
      } else {
        for (let i = 0; i < count; i++, p += ba) {
          const v = (dv.getInt8(p) << 16) | (dv.getUint8(p + 1) << 8) | dv.getUint8(p + 2);
          out[i] = v / 8388608;
        }
      }
      break;
    case 32:
      for (let i = 0; i < count; i++, p += ba) out[i] = dv.getInt32(p, le) / 2147483648;
      break;
    default:
      throw new Error('Unsupported bit depth ' + h.bits);
  }
}

// Parse a WAV/AIFF buffer directly into packed (block floating point)
// channels.
export function parseToPacked(buf, h) {
  const dv = new DataView(buf);
  const n = h.frames;
  const nb = Math.ceil(n / BFP_BLOCK);
  const tmp = new Float32Array(BFP_BLOCK);
  const channels = [];
  for (let ch = 0; ch < h.channels; ch++) {
    const scales = new Float32Array(nb);
    const data = new Int16Array(n);
    for (let b = 0; b < nb; b++) {
      const s = b * BFP_BLOCK;
      const cnt = Math.min(BFP_BLOCK, n - s);
      readSamples(dv, h, ch, s, cnt, tmp);
      let pk = 0;
      for (let i = 0; i < cnt; i++) {
        const a = tmp[i] < 0 ? -tmp[i] : tmp[i];
        if (a > pk) pk = a;
      }
      if (!(pk > 1e-30)) continue;
      const sc = pk / 32767;
      const inv = 1 / sc;
      scales[b] = sc;
      for (let i = 0; i < cnt; i++) {
        const v = Math.round(tmp[i] * inv);
        data[s + i] = v > 32767 ? 32767 : v < -32767 ? -32767 : v;
      }
    }
    channels.push({ length: n, scales, data });
  }
  return channels;
}
