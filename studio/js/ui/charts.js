// Canvas charts: waveform overview and tonal balance curves.

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function setupCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

// Min/max envelope with `cols` columns from stereo channels.
export function waveformPeaks(L, R, cols = 1200) {
  const n = L.length;
  const step = Math.max(1, Math.floor(n / cols));
  const out = new Float32Array(cols * 2);
  for (let c = 0; c < cols; c++) {
    const s = c * step;
    const e = Math.min(n, s + step);
    let lo = 0;
    let hi = 0;
    for (let i = s; i < e; i += 2) {
      const v = 0.5 * (L[i] + R[i]);
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    out[2 * c] = lo;
    out[2 * c + 1] = hi;
  }
  return out;
}

export function drawWaveform(canvas, peaks, progress = 0, scale = 1) {
  const { ctx, w, h } = setupCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  if (!peaks) return;
  const cols = peaks.length / 2;
  const mid = h / 2;
  const gold = css('--gold');
  const dim = '#3d3a35';
  const px = Math.max(1, Math.floor(w / cols));
  for (let x = 0; x < w; x += px) {
    const c = Math.min(cols - 1, Math.floor((x / w) * cols));
    const lo = Math.max(-1, peaks[2 * c] * scale);
    const hi = Math.min(1, peaks[2 * c + 1] * scale);
    ctx.fillStyle = x / w <= progress ? gold : dim;
    const y0 = mid - hi * (mid - 2);
    const y1 = mid - lo * (mid - 2);
    ctx.fillRect(x, y0, Math.max(1, px - (px > 2 ? 1 : 0)), Math.max(1, y1 - y0));
  }
  // Playhead.
  ctx.fillStyle = '#fff';
  ctx.fillRect(Math.round(progress * w), 0, 1, h);
}

// curves: [{ data: Float64Array (dB on grid), color, dash, width, label }]
export function drawTonal(canvas, grid, curves, opts = {}) {
  const { ctx, w, h } = setupCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  const padL = 36;
  const padR = 10;
  const padT = 10;
  const padB = 22;
  const fMin = 20;
  const fMax = 20000;
  const yMin = opts.yMin ?? -18;
  const yMax = opts.yMax ?? 12;
  const X = (f) => padL + ((Math.log10(f) - Math.log10(fMin)) / (Math.log10(fMax) - Math.log10(fMin))) * (w - padL - padR);
  const Y = (db) => padT + ((yMax - db) / (yMax - yMin)) * (h - padT - padB);
  ctx.font = '10px Lato, sans-serif';
  ctx.fillStyle = '#7d796f';
  ctx.strokeStyle = '#242424';
  ctx.lineWidth = 1;
  for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
    const x = Math.round(X(f)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, padT);
    ctx.lineTo(x, h - padB);
    ctx.stroke();
    ctx.textAlign = 'center';
    ctx.fillText(f >= 1000 ? f / 1000 + 'k' : String(f), x, h - 7);
  }
  for (let db = Math.ceil(yMin / 6) * 6; db <= yMax; db += 6) {
    const y = Math.round(Y(db)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(w - padR, y);
    ctx.stroke();
    ctx.textAlign = 'right';
    ctx.fillText((db > 0 ? '+' : '') + db, padL - 6, y + 3);
  }
  for (const c of curves) {
    if (!c.data) continue;
    ctx.strokeStyle = c.color;
    ctx.lineWidth = c.width || 1.5;
    ctx.setLineDash(c.dash || []);
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < grid.length; i++) {
      const f = grid[i];
      if (f < fMin || f > fMax) continue;
      const v = Math.max(yMin - 2, Math.min(yMax + 2, c.data[i]));
      const x = X(f);
      const y = Y(v);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.setLineDash([]);
}
