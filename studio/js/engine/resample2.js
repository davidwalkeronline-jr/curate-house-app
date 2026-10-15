// Zero phase 2x decimation and interpolation with a Kaiser windowed halfband
// filter. Used to run the reverbs at half rate (their returns are low passed
// well below the half rate Nyquist), which halves their cost.

let taps = null;

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

// Side taps of a 31 tap halfband (offsets +-1, +-3, ..., +-15 from centre),
// stored as even[j] for tap index 2j (offset 15 - 2j). Centre tap is 0.5.
function halfbandTaps() {
  if (taps) return taps;
  const beta = 7;
  const i0 = besselI0(beta);
  const even = new Float64Array(16);
  let sum = 0;
  for (let j = 0; j < 16; j++) {
    const m = 2 * j - 15;
    const s = Math.sin((Math.PI * m) / 2) / (Math.PI * m);
    const x = m / 16;
    even[j] = s * (besselI0(beta * Math.sqrt(1 - x * x)) / i0);
    sum += even[j];
  }
  for (let j = 0; j < 16; j++) even[j] *= 0.5 / sum;
  taps = even;
  return taps;
}

// y[m] = 0.5 x[2m] + sum_j even[j] x[2m + 15 - 2j]
export function decimate2(x) {
  const even = halfbandTaps();
  const n = x.length;
  const m = Math.ceil(n / 2);
  const y = new Float32Array(m);
  // The halfband is symmetric: even[j] == even[15 - j].
  const e0 = even[0], e1 = even[1], e2 = even[2], e3 = even[3];
  const e4 = even[4], e5 = even[5], e6 = even[6], e7 = even[7];
  for (let k = 0; k < m; k++) {
    const c = 2 * k;
    let acc = 0.5 * x[c];
    if (c - 15 >= 0 && c + 15 < n) {
      acc +=
        e0 * (x[c + 15] + x[c - 15]) + e1 * (x[c + 13] + x[c - 13]) + e2 * (x[c + 11] + x[c - 11]) +
        e3 * (x[c + 9] + x[c - 9]) + e4 * (x[c + 7] + x[c - 7]) + e5 * (x[c + 5] + x[c - 5]) +
        e6 * (x[c + 3] + x[c - 3]) + e7 * (x[c + 1] + x[c - 1]);
    } else {
      for (let j = 0; j < 16; j++) {
        const idx = c + 15 - 2 * j;
        if (idx >= 0 && idx < n) acc += even[j] * x[idx];
      }
    }
    y[k] = acc;
  }
  return y;
}

// z[2m] = y[m], z[2m+1] = sum_j 2 even[j] y[m + 8 - j]
export function interpolate2(y, n) {
  const even = halfbandTaps();
  const m = y.length;
  const z = new Float32Array(n);
  const e0 = even[0], e1 = even[1], e2 = even[2], e3 = even[3];
  const e4 = even[4], e5 = even[5], e6 = even[6], e7 = even[7];
  for (let k = 0; k < m; k++) {
    const t = 2 * k;
    if (t < n) z[t] = y[k];
    if (t + 1 < n) {
      let acc = 0;
      if (k - 7 >= 0 && k + 8 < m) {
        acc =
          e0 * (y[k + 8] + y[k - 7]) + e1 * (y[k + 7] + y[k - 6]) + e2 * (y[k + 6] + y[k - 5]) +
          e3 * (y[k + 5] + y[k - 4]) + e4 * (y[k + 4] + y[k - 3]) + e5 * (y[k + 3] + y[k - 2]) +
          e6 * (y[k + 2] + y[k - 1]) + e7 * (y[k + 1] + y[k]);
      } else {
        for (let j = 0; j < 16; j++) {
          const idx = k + 8 - j;
          if (idx >= 0 && idx < m) acc += even[j] * y[idx];
        }
      }
      z[t + 1] = 2 * acc;
    }
  }
  return z;
}
