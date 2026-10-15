// Shared numeric helpers for the Curate Studio audio engine.
// Every engine module is plain ES module code with no DOM access, so it runs
// on the main thread, inside Web Workers, and under Node for tests.

export const TAU = Math.PI * 2;

export function dbToLin(db) {
  return Math.pow(10, db / 20);
}

export function linToDb(x) {
  return 20 * Math.log10(Math.max(Math.abs(x), 1e-12));
}

export function powToDb(p) {
  return 10 * Math.log10(Math.max(p, 1e-24));
}

export function dbToPow(db) {
  return Math.pow(10, db / 10);
}

export function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

// Percentile of a numeric array (does not modify the input).
export function percentile(values, p) {
  const n = values.length;
  if (!n) return NaN;
  const sorted = Float64Array.from(values).sort();
  const idx = clamp((p / 100) * (n - 1), 0, n - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// Several percentiles from one sort.
export function percentiles(values, ps) {
  const n = values.length;
  const out = {};
  if (!n) {
    for (const p of ps) out[p] = NaN;
    return out;
  }
  const sorted = Float64Array.from(values).sort();
  for (const p of ps) {
    const idx = clamp((p / 100) * (n - 1), 0, n - 1);
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    out[p] = sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  }
  return out;
}

// Log spaced frequency grid, `perOctave` points per octave from fLo to fHi.
export function logGrid(fLo = 20, fHi = 20000, perOctave = 12) {
  const octaves = Math.log2(fHi / fLo);
  const n = Math.round(octaves * perOctave) + 1;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = fLo * Math.pow(2, i / perOctave);
  return out;
}

// Standard 1/3 octave band centres (nominal) from 20 Hz to 20 kHz.
export const THIRD_OCTAVE_CENTRES = [
  20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800,
  1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000, 20000,
];

// Octave band centres used for instrument tonal templates.
export const OCTAVE_CENTRES = [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

// Linear interpolation of y(x) at xq where x is ascending. Values outside the
// range clamp to the end points.
export function interp(xs, ys, xq) {
  const n = xs.length;
  if (xq <= xs[0]) return ys[0];
  if (xq >= xs[n - 1]) return ys[n - 1];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= xq) lo = mid;
    else hi = mid;
  }
  const t = (xq - xs[lo]) / (xs[hi] - xs[lo]);
  return ys[lo] + (ys[hi] - ys[lo]) * t;
}

// Interpolate a curve defined at (freqs, dbs) onto another frequency grid,
// interpolating in log frequency.
export function interpLogCurve(freqs, dbs, gridFreqs) {
  const lx = Array.from(freqs, (f) => Math.log2(f));
  const out = new Float64Array(gridFreqs.length);
  for (let i = 0; i < gridFreqs.length; i++) out[i] = interp(lx, dbs, Math.log2(gridFreqs[i]));
  return out;
}

// Smoothstep shaped weight between two log frequencies (0 below f0, 1 above f1).
export function logRamp(f, f0, f1) {
  if (f <= f0) return 0;
  if (f >= f1) return 1;
  const t = Math.log(f / f0) / Math.log(f1 / f0);
  return t * t * (3 - 2 * t);
}

// Raised cosine bump in log frequency centred at fc, `widthOct` octaves wide
// (full width at zero), peak 1.
export function logBump(f, fc, widthOct) {
  const d = Math.abs(Math.log2(f / fc));
  const half = widthOct / 2;
  if (d >= half) return 0;
  return 0.5 * (1 + Math.cos((Math.PI * d) / half));
}

export function mean(arr) {
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += arr[i];
  return arr.length ? s / arr.length : 0;
}

// Deterministic pseudo random generator (mulberry32) so renders are repeatable.
export function makeRng(seed = 1) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function formatDb(db, digits = 1) {
  if (!Number.isFinite(db)) return '−∞';
  const s = db.toFixed(digits);
  return db > 0 ? '+' + s : s.replace('-', '−');
}

export function formatHz(f) {
  if (f >= 1000) {
    const k = f / 1000;
    return (k >= 10 ? k.toFixed(0) : k.toFixed(1).replace(/\.0$/, '')) + ' kHz';
  }
  return Math.round(f) + ' Hz';
}
