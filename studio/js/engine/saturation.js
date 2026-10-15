// Analogue style saturation: a smooth soft clipper run at 2x the sample rate
// through linear phase halfband filters, with the filter latency removed so
// the output stays sample aligned with every other stem.

const HB_TAPS = 31; // halfband length, centre index 15
const HB_C = 15;
let hb = null;

function besselI0(x) {
  let sum = 1;
  let term = 1;
  for (let k = 1; k < 30; k++) {
    term *= (x / (2 * k)) * (x / (2 * k));
    sum += term;
    if (term < 1e-12 * sum) break;
  }
  return sum;
}

// Kaiser windowed halfband lowpass; even indexed taps are the side taps
// (the centre tap 15 is odd and equals 0.5).
function halfband() {
  if (hb) return hb;
  const beta = 7;
  const i0 = besselI0(beta);
  const h = new Float64Array(HB_TAPS);
  for (let k = 0; k < HB_TAPS; k++) {
    const m = k - HB_C;
    const s = m === 0 ? 0.5 : Math.sin((Math.PI * m) / 2) / (Math.PI * m);
    const x = m / (HB_C + 1);
    const w = besselI0(beta * Math.sqrt(Math.max(0, 1 - x * x))) / i0;
    h[k] = s * w;
  }
  // Each polyphase branch must pass DC at exactly half gain (unity after the
  // x2 interpolation gain): centre tap 0.5, side taps summing to 0.5.
  const even = new Float64Array(16); // taps k = 0, 2, ..., 30
  let sideSum = 0;
  for (let j = 0; j < 16; j++) {
    even[j] = h[2 * j];
    sideSum += even[j];
  }
  for (let j = 0; j < 16; j++) even[j] *= 0.5 / sideSum;
  hb = { even, centre: 0.5 };
  return hb;
}

export const SATURATION_LATENCY = 15;

// Smooth odd symmetric clipper (Pade approximant of tanh, exact limit 1).
function soft(x) {
  if (x > 3) return 1;
  if (x < -3) return -1;
  const x2 = x * x;
  return (x * (27 + x2)) / (27 + 9 * x2);
}

function softSlope(x) {
  const h = 1e-4;
  return (soft(x + h) - soft(x - h)) / (2 * h);
}

// Run `shape` on one channel at 2x the sample rate, in place, with the
// halfband latency removed.
function shapeOversampled(x, shape) {
  const n = x.length;
  const { even, centre } = halfband();
  const L = SATURATION_LATENCY;
  const xin = new Float64Array(16);
  const z0 = new Float64Array(16);
  const z1 = new Float64Array(9);
  let xi = 0;
  let zi0 = 0;
  let zi1 = 0;
  for (let m = 0; m < n + L; m++) {
    xin[xi] = m < n ? x[m] : 0;
    // Upsample: even phase = interpolated value, odd phase = x[m-7].
    let v0 = 0;
    for (let j = 0; j < 16; j++) v0 += even[j] * xin[(xi - j + 16) & 15];
    v0 *= 2;
    const v1 = 2 * centre * xin[(xi - 7 + 16) & 15];
    xi = (xi + 1) & 15;
    z0[zi0] = shape(v0);
    z1[zi1] = shape(v1);
    // Downsample: y[m] = centre * z1[m-8] + sum even[j] * z0[m-j].
    let y = 0;
    for (let j = 0; j < 16; j++) y += even[j] * z0[(zi0 - j + 16) & 15];
    y += centre * z1[(zi1 + 1) % 9];
    zi0 = (zi0 + 1) & 15;
    zi1 = (zi1 + 1) % 9;
    if (m >= L) x[m - L] = y;
  }
}

// Saturate one channel in place.
// p: { drive (dB), bias (0..0.5 asymmetry for even harmonics), mix (0..1),
//      inGain (linear gain applied before drive, undone after) }
export function saturate(x, p) {
  const drive = Math.pow(10, (p.drive || 0) / 20) * (p.inGain || 1);
  const bias = p.bias || 0;
  const mix = p.mix ?? 1;
  const b0 = soft(bias);
  const norm = 1 / (drive * softSlope(bias));
  shapeOversampled(x, (v) => {
    const wet = (soft(v * drive + bias) - b0) * norm;
    return v + mix * (wet - v);
  });
}

// Transparent below `knee`, then a smooth curve that never exceeds
// `threshold` (linear amplitude). Used to shave the tallest transients
// before the limiter.
export function clipper(x, threshold, kneeDb = 2) {
  const a = threshold * Math.pow(10, -kneeDb / 20);
  const span = threshold - a;
  shapeOversampled(x, (v) => {
    const m = v < 0 ? -v : v;
    if (m <= a) return v;
    const y = a + span * soft((m - a) / span);
    return v < 0 ? -y : y;
  });
}

// Linear gain needed so that a signal whose loud peaks sit at `peakDb`
// lands at `targetDb` going into the shaper.
export function driveNormaliser(peakDb, targetDb = -6) {
  return Math.pow(10, (targetDb - peakDb) / 20);
}
