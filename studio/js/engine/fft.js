// In-place iterative radix-2 complex FFT with cached twiddle tables.

const cache = new Map();

function tables(n) {
  let t = cache.get(n);
  if (t) return t;
  const levels = Math.log2(n);
  if (levels !== Math.floor(levels)) throw new Error('FFT size must be a power of 2');
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = Math.sin((2 * Math.PI * i) / n);
  }
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let x = i;
    let r = 0;
    for (let b = 0; b < levels; b++) {
      r = (r << 1) | (x & 1);
      x >>>= 1;
    }
    rev[i] = r;
  }
  t = { cos, sin, rev };
  cache.set(n, t);
  return t;
}

// Forward FFT (sign -1) of re/im in place. Pass inverse=true for the inverse
// transform (unscaled; divide by n yourself).
export function fft(re, im, inverse = false) {
  const n = re.length;
  const { cos, sin, rev } = tables(n);
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  const sgn = inverse ? 1 : -1;
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let start = 0; start < n; start += size) {
      let k = 0;
      for (let j = start; j < start + half; j++) {
        const wr = cos[k];
        const wi = sgn * sin[k];
        const l = j + half;
        const xr = re[l] * wr - im[l] * wi;
        const xi = re[l] * wi + im[l] * wr;
        re[l] = re[j] - xr;
        im[l] = im[j] - xi;
        re[j] += xr;
        im[j] += xi;
        k += step;
      }
    }
  }
}

const windowCache = new Map();

export function hann(n) {
  let w = windowCache.get(n);
  if (w) return w;
  w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  windowCache.set(n, w);
  return w;
}

// Given the FFT (re, im) of x + i*y where x and y are real frames, accumulate
// spectra into the accumulators. Each accumulator is a Float64Array(n/2 + 1)
// or null. X and Y are separated with the conjugate symmetry trick:
// X[k] = (Z[k] + conj(Z[n-k])) / 2, Y[k] = (Z[k] - conj(Z[n-k])) / 2i.
// accM and accS receive |(X+Y)/2|^2 and |(X-Y)/2|^2 (mid and side).
export function accumulatePair(re, im, accX, accY, accM, accS) {
  const n = re.length;
  const half = n >> 1;
  for (let k = 0; k <= half; k++) {
    const nk = (n - k) & (n - 1);
    const zr = re[k];
    const zi = im[k];
    const cr = re[nk];
    const ci = -im[nk];
    const xr = 0.5 * (zr + cr);
    const xi = 0.5 * (zi + ci);
    // (Z - conj(Z[n-k])) / 2i  =>  real = (zi - ci)/2, imag = -(zr - cr)/2
    const yr = 0.5 * (zi - ci);
    const yi = -0.5 * (zr - cr);
    if (accX) accX[k] += xr * xr + xi * xi;
    if (accY) accY[k] += yr * yr + yi * yi;
    if (accM) {
      const mr = 0.5 * (xr + yr);
      const mi = 0.5 * (xi + yi);
      accM[k] += mr * mr + mi * mi;
    }
    if (accS) {
      const sr = 0.5 * (xr - yr);
      const si = 0.5 * (xi - yi);
      accS[k] += sr * sr + si * si;
    }
  }
}
