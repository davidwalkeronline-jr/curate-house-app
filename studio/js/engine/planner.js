// The mix planner: turns stem analysis + a genre (or reference) into concrete
// processing decisions for every stem, the buses and the master.
//
// Phase A (planMix) decides processing, panning, sends and the measurement
// windows. Phase B (applyLevels) sets the faders from loudness measured on
// the processed stems, so balance targets hold regardless of how hot or
// quiet each stem was recorded.

import { butterworth, designBiquad } from './biquad.js';
import { fitEq, smoothCurve, levelChangeDb, sectionCoefs } from './eqfit.js';
import { ANALYSIS_GRID, normaliseCurve, curveMean } from './spectrum.js';
import { OCTAVE_CENTRES, clamp, interpLogCurve, formatDb, formatHz } from './util.js';
import { genreCurve, makeCurve } from './genres.js';
import { ROLES } from './classify.js';
import { loudestWindow } from './features.js';

export const ANCHOR_LUFS = -20;

// Channel strip defaults per role. comp.gr is the target gain reduction (dB)
// on the stem's loud passages; rms is the detector time (0 = peak).
export const ROLE_PROC = {
  leadVocal: { hpf: 80, hpfRange: [60, 130], hpfOrder: 4, tmpl: 'vocal', deEss: true, res: 'high', comp: { ratio: 3.5, attack: 5, release: 90, gr: 5, rms: 4, knee: 6, scHpf: 100 } },
  bgv: { hpf: 130, hpfRange: [100, 220], hpfOrder: 4, tmpl: 'bgv', deEss: true, res: 'high', comp: { ratio: 4, attack: 5, release: 100, gr: 6, rms: 4, knee: 6, scHpf: 120 } },
  kick: { hpf: 30, hpfRange: [25, 45], hpfOrder: 2, lpf: 14000, tmpl: 'kick', gate: 'auto', res: 'all', comp: { ratio: 4, attack: 15, release: 80, gr: 4, rms: 0, knee: 4 } },
  snare: { hpf: 80, hpfRange: [60, 110], hpfOrder: 2, tmpl: 'snare', gate: 'auto', res: 'all', comp: { ratio: 4, attack: 8, release: 90, gr: 4, rms: 0, knee: 4 } },
  hats: { hpf: 300, hpfRange: [200, 500], hpfOrder: 2, tmpl: 'hats', comp: { ratio: 2.5, attack: 5, release: 80, gr: 2, rms: 2, knee: 6 } },
  toms: { hpf: 60, hpfRange: [45, 90], hpfOrder: 2, tmpl: 'toms', gate: 'always', res: 'all', comp: { ratio: 4, attack: 10, release: 120, gr: 4, rms: 0, knee: 4 } },
  overheads: { hpf: 150, hpfRange: [80, 300], hpfOrder: 2, tmpl: 'overheads', comp: { ratio: 2.5, attack: 15, release: 150, gr: 2, rms: 5, knee: 8 } },
  room: { hpf: 80, hpfRange: [60, 140], hpfOrder: 2, lpf: 11000, tmpl: 'room', res: 'all', comp: { ratio: 6, attack: 3, release: 70, gr: 6, rms: 2, knee: 4 } },
  drumKit: { hpf: 30, hpfRange: [25, 45], hpfOrder: 2, tmpl: 'drumKit', comp: { ratio: 3, attack: 20, release: 120, gr: 3, rms: 5, knee: 6 } },
  percussion: { hpf: 200, hpfRange: [120, 400], hpfOrder: 2, tmpl: 'percussion', comp: { ratio: 3, attack: 8, release: 100, gr: 3, rms: 2, knee: 6 } },
  bass: { hpf: 32, hpfRange: [28, 45], hpfOrder: 2, tmpl: 'bass', comp: { ratio: 4, attack: 15, release: 120, gr: 5, rms: 8, knee: 6 } },
  subBass: { hpf: 25, hpfRange: [20, 32], hpfOrder: 2, tmpl: 'subBass', comp: { ratio: 3, attack: 20, release: 150, gr: 3, rms: 10, knee: 6 } },
  electricGuitar: { hpf: 90, hpfRange: [70, 140], hpfOrder: 2, lpf: 12000, tmpl: 'electricGuitar', comp: { ratio: 3, attack: 15, release: 150, gr: 3, rms: 8, knee: 6 } },
  acousticGuitar: { hpf: 90, hpfRange: [70, 150], hpfOrder: 2, tmpl: 'acousticGuitar', res: 'all', comp: { ratio: 3, attack: 10, release: 120, gr: 4, rms: 5, knee: 6, scHpf: 100 } },
  piano: { hpf: 50, hpfRange: [35, 90], hpfOrder: 2, tmpl: 'piano', comp: { ratio: 2.5, attack: 15, release: 150, gr: 2.5, rms: 8, knee: 8 } },
  organ: { hpf: 60, hpfRange: [40, 100], hpfOrder: 2, lpf: 12000, tmpl: 'organ', comp: { ratio: 2.5, attack: 20, release: 200, gr: 2, rms: 10, knee: 8 } },
  synthPad: { hpf: 140, hpfRange: [90, 250], hpfOrder: 2, tmpl: 'synthPad', width: 1.15, comp: { ratio: 2, attack: 30, release: 300, gr: 1.5, rms: 20, knee: 8 } },
  synthLead: { hpf: 120, hpfRange: [80, 200], hpfOrder: 2, tmpl: 'synthLead', comp: { ratio: 2.5, attack: 10, release: 120, gr: 2, rms: 5, knee: 8 } },
  strings: { hpf: 70, hpfRange: [40, 120], hpfOrder: 2, tmpl: 'strings', width: 1.1, comp: { ratio: 2, attack: 30, release: 250, gr: 1.5, rms: 15, knee: 8 } },
  brass: { hpf: 90, hpfRange: [60, 140], hpfOrder: 2, tmpl: 'brass', comp: { ratio: 3, attack: 10, release: 120, gr: 3, rms: 5, knee: 6 } },
  fx: { hpf: 100, hpfRange: [40, 200], hpfOrder: 2, width: 1.1, comp: null },
  backingTrack: { hpf: 25, hpfRange: [20, 35], hpfOrder: 2, comp: { ratio: 1.5, attack: 30, release: 200, gr: 1, rms: 20, knee: 10 } },
  crowd: { hpf: 180, hpfRange: [120, 300], hpfOrder: 2, lpf: 9000, width: 1.2, comp: { ratio: 2, attack: 30, release: 300, gr: 2, rms: 20, knee: 8 } },
  other: { hpf: 60, hpfRange: [30, 120], hpfOrder: 2, res: 'all', comp: { ratio: 2.5, attack: 15, release: 150, gr: 2.5, rms: 8, knee: 8 } },
  click: { mute: true },
  guide: { mute: true },
};

// Octave band tonal templates (31.5 Hz .. 16 kHz) of a well mixed part,
// with the bands used to align the stem to the template and the cut/boost
// limits allowed per band. Corrections are partial and bounded so a stem's
// character survives; only clear imbalances get fixed.
const T = (t, core, limits) => ({ t, core, limits });
const VOCAL_LIM = [[0, 0], [0, 0], [-3, 0], [-4, 0.5], [-3, 1], [-2, 1.5], [-2.5, 2.5], [-3, 3], [-3, 3], [-1, 3.5]];
const GEN_LIM = [[-2, 1], [-3, 1.5], [-3, 1.5], [-4, 1.5], [-4, 1.5], [-3, 2], [-3, 2], [-3, 2.5], [-3, 2.5], [-2, 2.5]];
export const TEMPLATES = {
  vocal: T([-40, -24, -8, -2, 0, -3, -6, -9, -12, -20], [3, 7], VOCAL_LIM),
  bgv: T([-45, -30, -14, -4, 0, -3, -6, -8, -11, -18], [3, 7], VOCAL_LIM),
  kick: T([-6, 0, -5, -14, -20, -21, -19, -18, -24, -34], [0, 2], [[-2, 1.5], [-1, 3], [-4, 1], [-6, 0], [-5, 0], [-3, 1], [-2, 2], [-2, 3], [-3, 2], [-3, 1]]),
  snare: T([-30, -14, -4, 0, -1, -3, -4, -6, -9, -16], [2, 6], [[0, 0], [-3, 0], [-3, 2], [-3, 2], [-5, 0.5], [-3, 1.5], [-2, 3], [-2, 3], [-2, 2], [-2, 2]]),
  hats: T([-50, -45, -35, -22, -14, -9, -5, -2, 0, -5], [6, 9], [[0, 0], [0, 0], [0, 0], [-4, 0], [-4, 0.5], [-3, 1], [-3, 1], [-3, 1.5], [-2, 2], [-2, 2]]),
  toms: T([-18, -4, 0, -6, -11, -14, -14, -16, -22, -32], [1, 3], [[-2, 1], [-2, 2], [-2, 2], [-5, 0], [-5, 0], [-3, 1], [-2, 2.5], [-2, 2.5], [-3, 1], [-3, 0.5]]),
  overheads: T([-30, -20, -10, -6, -5, -4, -3, -3, -4, -9], [4, 8], GEN_LIM),
  room: T([-20, -8, -3, -2, -3, -5, -7, -10, -15, -24], [2, 6], GEN_LIM),
  drumKit: T([-6, 0, -3, -6, -8, -9, -9, -10, -12, -18], [1, 7], GEN_LIM),
  percussion: T([-40, -30, -16, -8, -4, -2, -1, -1, -3, -9], [4, 8], GEN_LIM),
  bass: T([-4, 0, -2, -8, -14, -18, -22, -28, -36, -48], [0, 3], [[-2, 1.5], [-2, 2], [-3, 1.5], [-4, 0.5], [-3, 1], [-2, 2], [-2, 2], [-3, 1.5], [-3, 0.5], [-3, 0]]),
  subBass: T([0, -2, -8, -16, -24, -30, -36, -42, -50, -60], [0, 2], [[-2, 1.5], [-2, 1.5], [-3, 1], [-4, 0], [-4, 0], [-3, 0], [-3, 0], [-3, 0], [-3, 0], [-3, 0]]),
  electricGuitar: T([-40, -22, -10, -4, -1, 0, -2, -7, -16, -30], [3, 7], GEN_LIM),
  acousticGuitar: T([-30, -16, -5, -2, 0, -2, -4, -6, -9, -15], [3, 8], [[0, 0], [-3, 0], [-4, 0.5], [-4, 1], [-3, 1], [-2, 1.5], [-2, 2], [-2, 2.5], [-2, 3], [-1, 3]]),
  piano: T([-24, -10, -3, 0, 0, -3, -6, -9, -14, -22], [2, 7], GEN_LIM),
  organ: T([-22, -10, -4, -1, 0, -3, -6, -11, -18, -28], [2, 6], GEN_LIM),
  synthPad: T([-30, -18, -8, -3, 0, -2, -4, -6, -9, -14], [3, 8], GEN_LIM),
  synthLead: T([-36, -24, -12, -5, -1, 0, -2, -4, -7, -13], [3, 8], GEN_LIM),
  strings: T([-30, -14, -5, -1, 0, -2, -5, -9, -14, -22], [2, 7], GEN_LIM),
  brass: T([-40, -26, -12, -3, 0, 0, -2, -6, -12, -22], [3, 7], GEN_LIM),
};

const BRIGHT_ROLES = new Set(['leadVocal', 'bgv', 'hats', 'overheads', 'acousticGuitar', 'snare', 'percussion']);

// Intra group balance offsets (dB) from sub role hints.
function memberOffset(role, hints) {
  if (role === 'kick') {
    if (hints.sub) return -3;
    if (hints.outside) return -1;
  }
  if (role === 'snare' && hints.bottom) return -8;
  if (role === 'leadVocal' && hints.double) return -7;
  if (role === 'bgv' && hints.double) return -3;
  return 0;
}

// ---------------------------------------------------------------------------
// EQ decisions

function templateCorrection(stem, role, genre, strength) {
  const proc = ROLE_PROC[role];
  if (!proc?.tmpl) return null;
  const tpl = TEMPLATES[proc.tmpl];
  const oct = stem.analysis.spectrum.octave;
  const target = tpl.t.slice();
  if (BRIGHT_ROLES.has(role)) {
    const b = genre.mix.brightness || 0;
    target[7] += 0.5 * b;
    target[8] += b;
    target[9] += b;
  }
  // Align the stem to the template on the core bands.
  let off = 0;
  let cnt = 0;
  for (let i = tpl.core[0]; i <= tpl.core[1]; i++) {
    off += oct[i] - target[i];
    cnt++;
  }
  off /= cnt;
  const corr = new Array(10);
  for (let i = 0; i < 10; i++) {
    const want = target[i] - (oct[i] - off);
    const [cut, boost] = tpl.limits[i];
    corr[i] = clamp(want * strength, cut, boost);
  }
  return corr;
}

function resonanceCuts(stem, role, fs) {
  const mode = ROLE_PROC[role]?.res;
  if (!mode) return [];
  const fine = stem.analysis.spectrum.fine;
  const smooth = smoothCurve(fine, 1);
  const lo = mode === 'high' ? 2000 : 150;
  const hi = 6000;
  const thr = mode === 'high' ? 6 : 4.5;
  const cand = [];
  for (let i = 2; i < ANALYSIS_GRID.length - 2; i++) {
    const f = ANALYSIS_GRID[i];
    if (f < lo || f > hi) continue;
    const r = fine[i] - smooth[i];
    if (r > thr && r >= fine[i - 1] - smooth[i - 1] && r >= fine[i + 1] - smooth[i + 1]) cand.push({ f, r });
  }
  cand.sort((a, b) => b.r - a.r);
  return cand.slice(0, 2).map(({ f, r }) => ({
    type: 'peaking',
    f: Math.round(f),
    q: 4,
    gain: -Math.round(Math.min(4, 0.6 * (r - 2)) * 10) / 10,
    why: 'resonance',
  })).filter((s) => s.f < fs * 0.45);
}

function planEq(stem, role, genre, opts, fs) {
  const proc = ROLE_PROC[role] || ROLE_PROC.other;
  const a = stem.analysis;
  const intensity = opts.intensity === 'processed' ? 0.5 : 1;
  // High pass: role default nudged up toward where the stem's own low end
  // has already died away, never above the role's range.
  let hpf = proc.hpf;
  if (a.lowCutHint > hpf * 1.3) hpf = Math.min(proc.hpfRange[1], 0.75 * a.lowCutHint);
  hpf = clamp(hpf, proc.hpfRange[0], proc.hpfRange[1]);
  if (opts.intensity === 'processed') hpf = Math.min(hpf, proc.hpfRange[0] * 1.1);
  const strength = 0.5 * (genre.mix.eqStrength ?? 1) * intensity;
  const corr = templateCorrection(stem, role, genre, strength);
  let fitted = [];
  if (corr && corr.some((v) => Math.abs(v) >= 0.5)) {
    const curve = interpLogCurve(OCTAVE_CENTRES, corr, ANALYSIS_GRID);
    // Ignore the region the high pass already handles.
    for (let i = 0; i < ANALYSIS_GRID.length; i++) if (ANALYSIS_GRID[i] < hpf * 1.5) curve[i] = Math.min(curve[i], 0);
    fitted = fitEq(curve, fs, {
      maxBands: 4,
      maxBoost: 3.5,
      maxCut: -5,
      qMin: 0.6,
      qMax: 2.5,
      fMin: Math.max(30, hpf * 1.2),
      fMax: 15000,
      lowShelfRange: [Math.max(60, hpf * 1.5), 250],
      highShelfRange: [5000, 12000],
      minGain: 0.6,
    });
  }
  const res = intensity === 1 ? resonanceCuts(stem, role, fs) : [];
  const lpf = proc.lpf && fs > proc.lpf * 2.2 ? proc.lpf : null;
  const sections = [...fitted.map((s) => ({ ...s, why: 'tone' })), ...res];
  return { hpf: Math.round(hpf), hpfOrder: proc.hpfOrder || 2, lpf, sections };
}

export function eqCoefficients(eq, fs) {
  const out = [];
  if (eq.hpf) out.push(...butterworth('highpass', eq.hpf, fs, eq.hpfOrder || 2));
  for (const s of eq.sections) out.push(sectionCoefs(s, fs));
  if (eq.lpf) out.push(designBiquad('lowpass', eq.lpf, fs, Math.SQRT1_2));
  return out;
}

// ---------------------------------------------------------------------------
// Dynamics decisions

function planGate(stem, role) {
  const mode = ROLE_PROC[role]?.gate;
  if (!mode) return null;
  const a = stem.analysis;
  const hits = a.peakEnv.p99;
  const bleedPeak = a.floorDb + 11; // noise like bleed peaks ~11 dB over RMS
  const window = hits - bleedPeak;
  const live = window < 34; // bleed within ~34 dB of the hits
  if (mode === 'auto' && !live) return null;
  if (window < 12) return null; // too little separation to gate safely
  const threshold = Math.min(bleedPeak + 6, hits - 12);
  return {
    threshold,
    ratio: 3,
    range: role === 'toms' ? 18 : 10,
    attack: 0.3,
    hold: role === 'toms' ? 150 : 60,
    release: role === 'toms' ? 250 : 110,
  };
}

function planComp(stem, role, genre, opts, eqDelta) {
  const proc = ROLE_PROC[role];
  if (!proc?.comp) return null;
  const c = proc.comp;
  const a = stem.analysis;
  let gr = c.gr * (genre.mix.comp ?? 1) * (opts.intensity === 'processed' ? 0.45 : 1);
  if ((role === 'kick' || role === 'snare') && opts.adjust?.punch) gr *= 1 - 0.08 * opts.adjust.punch;
  if (gr < 0.5) return null;
  const R = c.ratio;
  const level = (c.rms > 0 ? a.env.p90 : a.peakEnv.p90) + eqDelta;
  let threshold = level - gr / (1 - 1 / R);
  threshold = Math.max(threshold, a.floorDb + 8);
  return { threshold, ratio: R, knee: c.knee, attack: c.attack, release: c.release, rms: c.rms, scHpf: c.scHpf || 0, targetGr: gr };
}

function planDeEss(stem, role, genre, opts) {
  if (!ROLE_PROC[role]?.deEss) return null;
  const s = stem.analysis.sibilance;
  if (!Number.isFinite(s.p95)) return null;
  const bright = (genre.mix.brightness || 0) + (opts.adjust?.brightness || 0) * 0.5;
  const thresholdRel = clamp(s.p95 - 4 - 0.5 * bright, -18, -5);
  return {
    freq: stem.analysis.centroid > 2200 ? 6500 : 5500,
    thresholdRel,
    ratio: 4,
    range: opts.intensity === 'processed' ? 5 : 8,
    attack: 1,
    release: 60,
  };
}

function planSat(stem, role, genre, opts, eqDelta, comp) {
  let amt = genre.mix.sat?.[role] ?? 0;
  amt *= 1 + (opts.adjust?.warmth || 0) / 3;
  if (opts.intensity === 'processed') amt *= 0.5;
  if (amt < 0.03) return null;
  const a = stem.analysis;
  const peak = a.peakEnv.p99 + eqDelta - (comp ? comp.targetGr * 0.6 : 0);
  return {
    amount: Math.round(amt * 100) / 100,
    drive: 3 + amt * 12,
    mix: clamp(0.3 + amt, 0, 0.8),
    bias: 0.15,
    inGain: Math.pow(10, (-8 - peak) / 20),
  };
}

// ---------------------------------------------------------------------------
// Panning

function spreadPositions(n, width) {
  if (n === 1) return [0];
  const out = [];
  for (let i = 0; i < n; i++) out.push(-width + (2 * width * i) / (n - 1));
  return out;
}

function planPans(stems, genre, opts, pairs) {
  const spread = clamp((genre.mix.spread ?? 0.85) * (1 + (opts.adjust?.width || 0) * 0.05), 0.4, 1);
  const pans = {};
  const pairOf = new Map();
  for (const [l, r] of pairs) {
    pairOf.set(l, -1);
    pairOf.set(r, 1);
  }
  const byRole = {};
  for (const s of stems) (byRole[s.role] ||= []).push(s);
  let altSide = 1;
  for (const [role, list] of Object.entries(byRole)) {
    const mono = [];
    for (const s of list) {
      if (pairOf.has(s.id)) {
        const side = pairOf.get(s.id);
        const w = role === 'overheads' || role === 'room' || role === 'crowd' || role === 'piano' || role === 'synthPad' || role === 'strings' ? 1 : spread;
        pans[s.id] = side * w;
      } else if (s.stereoKind === 'stereo') {
        pans[s.id] = 0;
      } else if (s.hints?.left && !s.hints?.right) {
        pans[s.id] = -spread * (role === 'overheads' ? 1 : 0.9);
      } else if (s.hints?.right && !s.hints?.left) {
        pans[s.id] = spread * (role === 'overheads' ? 1 : 0.9);
      } else mono.push(s);
    }
    if (!mono.length) continue;
    // Order members by their number in the name (Tom 1, Tom 2...).
    mono.sort((a, b) => (a.hints?.number ?? 99) - (b.hints?.number ?? 99) || a.name.localeCompare(b.name));
    const n = mono.length;
    let pos;
    switch (role) {
      case 'leadVocal': {
        pos = mono.map((s, i) => (s.hints?.double ? (i % 2 ? 0.25 : -0.25) : 0));
        break;
      }
      case 'kick':
      case 'snare':
      case 'bass':
      case 'subBass':
      case 'backingTrack':
      case 'drumKit':
        pos = mono.map(() => 0);
        break;
      case 'hats':
        pos = mono.map((_, i) => (i === 0 ? -0.3 : 0.4));
        break;
      case 'toms':
        pos = n === 1 ? [-0.2] : mono.map((_, i) => -0.4 + (0.9 * i) / (n - 1));
        break;
      case 'overheads':
      case 'crowd':
        pos = n === 1 ? [0] : spreadPositions(n, 0.95);
        break;
      case 'room':
        pos = n === 1 ? [0] : spreadPositions(n, 0.8);
        break;
      case 'bgv':
        pos = n === 1 ? [0.35] : n === 2 ? [-0.55, 0.55] : spreadPositions(n, Math.min(0.85, 0.5 + 0.1 * n) * spread / 0.85);
        break;
      case 'electricGuitar':
        pos = n === 1 ? [-0.35] : n === 2 ? [-spread, spread] : spreadPositions(n, spread);
        break;
      case 'acousticGuitar':
        pos = n === 1 ? [0.25] : n === 2 ? [-0.7 * spread, 0.7 * spread] : spreadPositions(n, 0.75 * spread);
        break;
      case 'piano':
        pos = n === 1 ? [0.2] : spreadPositions(n, 0.6);
        break;
      case 'organ':
        pos = n === 1 ? [0.3] : spreadPositions(n, 0.6);
        break;
      case 'synthPad':
        pos = n === 1 ? [-0.2] : spreadPositions(n, 0.7);
        break;
      case 'synthLead':
        pos = n === 1 ? [0.2] : spreadPositions(n, 0.5);
        break;
      case 'strings':
        pos = n === 1 ? [0.35] : spreadPositions(n, 0.7);
        break;
      case 'brass':
        pos = n === 1 ? [-0.35] : spreadPositions(n, 0.6);
        break;
      case 'percussion':
      case 'fx':
        pos = mono.map((_, i) => (i % 2 ? -1 : 1) * (0.45 + 0.1 * Math.floor(i / 2)));
        break;
      default:
        pos = mono.map(() => {
          altSide = -altSide;
          return altSide * 0.3;
        });
    }
    mono.forEach((s, i) => (pans[s.id] = clamp(pos[i], -1, 1)));
  }
  return pans;
}

// ---------------------------------------------------------------------------
// Sends and buses

function noteSeconds(note, bpm) {
  const q = 60 / (bpm || 120);
  switch (note) {
    case '1/4': return q;
    case '1/8': return q / 2;
    case '1/8d': return q * 0.75;
    case '1/16': return q / 4;
    default: return q * 0.75;
  }
}

function planSends(role, genre, opts) {
  const s = genre.mix.sends;
  const adj = (opts.adjust?.space || 0) * 2;
  const pick = (table) => (table && table[role] !== undefined ? table[role] + adj : null);
  return { plate: pick(s.plate), space: pick(s.space), delay: pick(s.delay) };
}

// ---------------------------------------------------------------------------
// Reference hints and master targets

export function referenceHints(reference, genre) {
  if (!reference) return { vocal: 0, low: 0 };
  const ref = normaliseCurve(reference.curve);
  const gen = normaliseCurve(genreCurve(genre));
  const presence = curveMean(ref, 1500, 5000) - curveMean(gen, 1500, 5000);
  const low = curveMean(ref, 40, 120) - curveMean(gen, 40, 120);
  return { vocal: clamp(0.4 * presence, -1.5, 1.5), low: clamp(0.3 * low, -2, 2), presenceDiff: presence, lowDiff: low };
}

function masterTargets(genre, reference, opts) {
  const adj = opts.adjust || {};
  let lufs;
  if (opts.loudness === 'streaming') lufs = -14;
  else if (opts.loudness === 'custom' && Number.isFinite(opts.customLufs)) lufs = opts.customLufs;
  else if (reference && opts.loudness !== 'genre') lufs = clamp(reference.lufs, -16, -6);
  else lufs = genre.master.lufs;
  // Target tonal curve: reference curve, or genre curve, with user tweaks.
  let curve;
  if (reference) curve = Float64Array.from(reference.curve);
  else curve = Float64Array.from(genreCurve(genre));
  const tweak = makeCurve({ sub: 0.7 * (adj.lowEnd || 0), bass: 0.6 * (adj.lowEnd || 0), presence: 0.4 * (adj.brightness || 0), air: 0.9 * (adj.brightness || 0) });
  const flat = makeCurve({});
  for (let i = 0; i < curve.length; i++) curve[i] += tweak[i] - flat[i];
  const width = reference?.width ? { ...reference.width } : { ...genre.master.width };
  const wAdj = (adj.width || 0) * 1.5;
  width.mid += wAdj;
  width.high += wAdj;
  return {
    lufs,
    ceiling: opts.ceiling ?? -1,
    curve,
    curveSource: reference ? 'reference' : 'genre',
    matchStrength: opts.match ?? (reference ? 0.85 : 0.7),
    maxBoost: reference ? 5 : 3.5,
    maxCut: reference ? -6 : -4.5,
    smoothing: reference ? 1 / 6 : 1 / 3,
    width,
    widthAmount: reference ? 0.8 : 0.5,
    bassMono: genre.master.bassMono ?? 120,
    warmth: clamp((genre.master.warmth ?? 0.15) * (1 + (adj.warmth || 0) / 3), 0, 0.8),
    release: genre.master.release ?? 120,
    clip: reference ? (reference.plr < 8.5 ? 3.5 : reference.plr < 10.5 ? 2 : 0) : genre.master.clip ?? 0,
    glue: {
      targetGr: (genre.mix.bus.glueGr ?? 1.5) * (opts.intensity === 'processed' ? 0.6 : 1),
      ratio: genre.mix.bus.ratio ?? 2,
      attack: genre.mix.bus.attack ?? 30,
      release: genre.mix.bus.release ?? 150,
    },
  };
}

// ---------------------------------------------------------------------------
// Phase A

// stems: [{ id, name, role, hints, analysis, stereoKind, user: { level, pan, mute } }]
export function planMix({ stems, genre, reference = null, options = {}, fs, tempo = 0, pairs = [], alignment = {} }) {
  const opts = { adjust: {}, intensity: 'raw', ...options };
  const active = stems.filter((s) => !s.analysis?.silent);
  const pans = planPans(active, genre, opts, pairs);
  const hints = referenceHints(reference, genre);
  const strips = [];
  for (const s of stems) {
    const role = s.role;
    const proc = ROLE_PROC[role] || ROLE_PROC.other;
    const silent = !!s.analysis?.silent;
    const mute = silent || !!proc.mute || !!s.user?.mute;
    const strip = {
      id: s.id,
      name: s.name,
      role,
      mute,
      reason: silent ? 'silent' : proc.mute ? role : s.user?.mute ? 'user' : null,
      collapse: s.collapse || null,
      polarity: alignment[s.id]?.polarity ?? 1,
      delay: alignment[s.id]?.delay ?? 0,
      pan: s.user?.pan ?? pans[s.id] ?? 0,
      width: proc.width ?? 1,
      offset: memberOffset(role, s.hints || {}),
      userLevel: s.user?.level || 0,
    };
    if (!mute) {
      strip.eq = planEq(s, role, genre, opts, fs);
      const coefs = eqCoefficients(strip.eq, fs);
      const eqDelta = levelChangeDb(s.analysis.spectrum.curve, coefs, fs);
      strip.eqDelta = eqDelta;
      strip.gate = planGate(s, role);
      strip.comp = planComp(s, role, genre, opts, eqDelta);
      strip.deEss = planDeEss(s, role, genre, opts);
      strip.sat = planSat(s, role, genre, opts, eqDelta, strip.comp);
      strip.sends = planSends(role, genre, opts);
    }
    strips.push(strip);
  }
  // Groups: all stems sharing a role are balanced together, except "other".
  const groups = [];
  const byKey = new Map();
  for (const st of strips) {
    if (st.mute) continue;
    const key = st.role === 'other' ? 'other:' + st.id : st.role;
    if (!byKey.has(key)) {
      const g = { key, role: st.role, members: [] };
      byKey.set(key, g);
      groups.push(g);
    }
    byKey.get(key).members.push(st.id);
  }
  // Measurement window per group: loudest 20 s of the members combined.
  const stemById = new Map(stems.map((s) => [s.id, s]));
  for (const g of groups) {
    let kb = null;
    for (const id of g.members) {
      const b = stemById.get(id).analysis.kBlocks;
      if (!kb) kb = Float64Array.from(b);
      else for (let i = 0; i < Math.min(kb.length, b.length); i++) kb[i] += b[i];
    }
    g.window = loudestWindow(kb, fs, 20);
    const adj = opts.adjust || {};
    let target = ANCHOR_LUFS + (genre.mix.levels[g.role] ?? -10);
    if (g.role === 'leadVocal' || g.role === 'bgv') target += (adj.vocal || 0) + hints.vocal;
    if (g.role === 'kick' || g.role === 'snare') target += 0.7 * (adj.punch || 0);
    if (g.role === 'kick' || g.role === 'bass' || g.role === 'subBass') target += 0.8 * (adj.lowEnd || 0) + hints.low;
    g.target = target;
  }
  const bpm = tempo > 40 && tempo < 220 ? tempo : 0;
  const delayTime = clamp(noteSeconds(genre.mix.delay?.note, bpm || 120), 0.08, 1.2);
  return {
    fs,
    genreId: genre.id,
    strips,
    groups,
    buses: {
      plate: { ...genre.mix.plate },
      space: { ...genre.mix.space },
      delay: { time: delayTime, feedback: genre.mix.delay?.feedback ?? 0.3, note: genre.mix.delay?.note, bpm },
    },
    master: masterTargets(genre, reference, opts),
    referenceHints: hints,
  };
}

// Phase B: faders from measured excerpt loudness.
// results: { [groupKey]: { members: { [id]: { lufs, gain } }, groupLufs } }
export function applyLevels(plan, results) {
  const byId = new Map(plan.strips.map((s) => [s.id, s]));
  for (const g of plan.groups) {
    const r = results[g.key];
    if (!r) continue;
    const fader = Number.isFinite(r.groupLufs) ? g.target - r.groupLufs : 0;
    g.fader = fader;
    g.measured = r.groupLufs;
    for (const id of g.members) {
      const st = byId.get(id);
      const m = r.members[id];
      const memberGain = m && Number.isFinite(m.gain) ? m.gain : 0;
      st.measured = m?.lufs;
      st.gain = clamp(memberGain + fader + (st.userLevel || 0), -60, 40);
    }
  }
  return plan;
}

// ---------------------------------------------------------------------------
// Plain language description of a strip for the mix report.

export function describeStrip(st) {
  if (st.mute) {
    if (st.reason === 'click') return ['Muted: click track (kept out of the mix).'];
    if (st.reason === 'guide') return ['Muted: guide / cue track (kept out of the mix).'];
    if (st.reason === 'silent') return ['Skipped: the file is silent.'];
    return ['Muted.'];
  }
  const lines = [];
  if (st.polarity < 0) lines.push('Polarity flipped to stay in phase with the other mics on this source.');
  if (st.delay) lines.push(`Time aligned by ${Math.abs(st.delay)} samples to tighten the phase with its partner mic.`);
  if (st.gate) lines.push(`Gate: tames bleed between hits (up to ${st.gate.range} dB quieter).`);
  const eqBits = [`high pass at ${formatHz(st.eq.hpf)}`];
  for (const s of st.eq.sections) {
    const kind = s.type === 'lowshelf' ? 'low shelf' : s.type === 'highshelf' ? 'high shelf' : s.why === 'resonance' ? 'notch' : 'bell';
    eqBits.push(`${formatDb(s.gain)} dB ${kind} at ${formatHz(s.f)}`);
  }
  if (st.eq.lpf) eqBits.push(`low pass at ${formatHz(st.eq.lpf)}`);
  lines.push('EQ: ' + eqBits.join(', ') + '.');
  if (st.comp) {
    lines.push(
      `Compression: ${st.comp.ratio}:1, about ${st.comp.targetGr.toFixed(1)} dB on the loudest parts ` +
        `(attack ${st.comp.attack} ms, release ${st.comp.release} ms).`,
    );
  }
  if (st.deEss) lines.push(`De-esser above ${formatHz(st.deEss.freq)} to soften harsh S and T sounds.`);
  if (st.sat) lines.push(`Saturation: ${Math.round(st.sat.amount * 100)}% analogue warmth.`);
  const panTxt = Math.abs(st.pan) < 0.05 ? 'centre' : `${Math.round(Math.abs(st.pan) * 100)}% ${st.pan < 0 ? 'left' : 'right'}`;
  lines.push(`Pan: ${panTxt}. Level: ${formatDb(st.gain ?? 0)} dB fader.`);
  const sends = [];
  if (st.sends?.plate !== null && st.sends?.plate !== undefined) sends.push(`plate ${st.sends.plate} dB`);
  if (st.sends?.space !== null && st.sends?.space !== undefined) sends.push(`room/hall ${st.sends.space} dB`);
  if (st.sends?.delay !== null && st.sends?.delay !== undefined) sends.push(`delay ${st.sends.delay} dB`);
  if (sends.length) lines.push('Space: ' + sends.join(', ') + '.');
  return lines;
}

export function roleLabel(role) {
  return ROLES[role]?.label || role;
}
