// Studio session: owns the stems and the reference, and runs the full
// mix + master pipeline through the worker pool.

import { Pool } from './pool.js';
import { readHeader, canParseDirectly, parseToPacked } from './decode.js';
import { packChannel, slicePacked, unpackInto, BFP_BLOCK, packedBytes } from './bfp.js';
import { classifyStem, findLrPairs } from './classify.js';
import { planMix, applyLevels, describeStrip, roleLabel } from './planner.js';
import { GENRES, getGenre, genreCurve } from './genres.js';
import { estimateTempo, loudestWindow } from './features.js';
import { encodeWav } from './wav.js';
import { normaliseCurve, curveMean, ANALYSIS_GRID } from './spectrum.js';
import { formatDb, formatHz } from './util.js';

const AUDIO_EXT = /\.(wav|wave|bwf|aif|aiff|aifc|mp3|flac|m4a|aac|ogg|oga|opus|webm|caf)$/i;
const PAIR_ROLES = new Set(['kick', 'snare', 'bass', 'acousticGuitar', 'electricGuitar']);
const PREROLL_S = 2;

let uid = 0;

async function decodeWithBrowser(buf, rate) {
  const AC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const ctx = new AC(1, 1, rate);
  return new Promise((resolve, reject) => {
    const p = ctx.decodeAudioData(buf, resolve, reject);
    if (p && p.then) p.then(resolve, reject);
  });
}

function collapseFor(kind) {
  if (kind === 'dual-mono' || kind === 'left-only' || kind === 'inverted-mono') return 'L';
  if (kind === 'right-only') return 'R';
  return null;
}

export class StudioSession {
  constructor({ onChange, onReference } = {}) {
    this.pool = new Pool();
    this.stems = [];
    this.reference = null;
    this.projectRate = null;
    this.tempo = 0;
    this.onChange = onChange || (() => {});
    this.onReference = onReference || (() => {});
    this.pairCache = new Map();
    this.last = null;
  }

  // ---------------------------------------------------------------- stems

  get readyStems() {
    return this.stems.filter((s) => s.status === 'ready');
  }

  get busy() {
    return this.stems.some((s) => s.status === 'queued' || s.status === 'decoding' || s.status === 'analysing');
  }

  memoryEstimate() {
    let b = 0;
    for (const s of this.stems) if (s.packed) for (const p of s.packed) b += packedBytes(p);
    const frames = Math.max(0, ...this.stems.map((s) => s.frames || 0));
    return b + frames * 4 * 2 * 8; // stems + render buses and results
  }

  async addFiles(fileList) {
    const files = Array.from(fileList).filter((f) => AUDIO_EXT.test(f.name) || (f.type || '').startsWith('audio/'));
    if (!files.length) return 0;
    files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const batch = files.map((file) => ({
      id: 'stem' + ++uid,
      file,
      name: file.name.replace(/\.[^.]+$/, ''),
      fileName: file.name,
      size: file.size,
      status: 'queued',
      notes: [],
      user: { level: 0, pan: null, mute: false },
    }));
    this.stems.push(...batch);
    this.onChange();
    if (!this.projectRate) {
      // Pick the session rate from the WAV/AIFF headers (most common rate).
      const rates = {};
      for (const s of batch) {
        try {
          const head = await s.file.slice(0, 262144).arrayBuffer();
          const h = readHeader(head);
          if (h?.sampleRate) rates[h.sampleRate] = (rates[h.sampleRate] || 0) + 1;
        } catch {
          /* ignore unreadable headers */
        }
      }
      const best = Object.entries(rates).sort((a, b) => b[1] - a[1])[0];
      if (best) this.projectRate = Number(best[0]);
    }
    const inflight = [];
    for (const s of batch) {
      if (!this.stems.includes(s)) continue;
      await this.decodeStem(s);
      const p = this.analyseStem(s);
      inflight.push(p);
      if (inflight.length >= this.pool.size + 1) await Promise.race(inflight.map((x) => x.done));
    }
    await Promise.all(inflight.map((x) => x.done));
    await this.alignByTimestamp();
    this.updateSession();
    this.onChange();
    return batch.length;
  }

  async decodeStem(s) {
    s.status = 'decoding';
    this.onChange();
    try {
      const buf = await s.file.arrayBuffer();
      const h = readHeader(buf);
      let packed;
      if (h && canParseDirectly(h) && (!this.projectRate || h.sampleRate === this.projectRate)) {
        this.projectRate = this.projectRate || h.sampleRate;
        packed = parseToPacked(buf, h);
        s.bits = h.format === 'float' ? h.bits + '-bit float' : h.bits + '-bit';
      } else {
        this.projectRate = this.projectRate || h?.sampleRate || 48000;
        const ab = await decodeWithBrowser(buf, this.projectRate);
        packed = [];
        for (let c = 0; c < ab.numberOfChannels; c++) packed.push(packChannel(ab.getChannelData(c)));
        if (h?.sampleRate && h.sampleRate !== this.projectRate) {
          s.notes.push(`Converted from ${h.sampleRate / 1000} kHz to the session rate.`);
        }
      }
      if (packed.length > 2) {
        s.notes.push(`Used the first 2 of ${packed.length} channels.`);
        packed = packed.slice(0, 2);
      }
      s.packed = packed;
      s.channels = packed.length;
      s.frames = packed[0].length;
      s.fs = this.projectRate;
      s.seconds = s.frames / this.projectRate;
      s.bext = h?.bextTimeRef ?? null;
      s.srcRate = h?.sampleRate || this.projectRate;
      s.file = null; // release the File reference
    } catch (err) {
      console.error(err);
      s.status = 'error';
      s.error = 'Could not read this file. Try exporting it as WAV.';
      this.onChange();
    }
  }

  analyseStem(s) {
    const job = {};
    job.done = (async () => {
      if (s.status === 'error' || !s.packed) return;
      s.status = 'analysing';
      this.onChange();
      try {
        const a = await this.pool.run('analyze', { packed: s.packed, fs: this.projectRate });
        if (!this.stems.includes(s)) return;
        this.applyAnalysis(s, a);
      } catch (err) {
        console.error(err);
        s.status = 'error';
        s.error = 'Analysis failed for this file.';
      }
      this.onChange();
    })();
    return job;
  }

  applyAnalysis(s, a) {
    s.analysis = a;
    s.stereoKind = a.stereo?.kind || 'mono';
    s.collapse = collapseFor(s.stereoKind);
    s.notes = s.notes.filter((n) => !n.startsWith('Stereo file') && !n.startsWith('Only the'));
    if (s.stereoKind === 'dual-mono') s.notes.push('Stereo file with identical sides: treated as mono so it can be panned.');
    if (s.stereoKind === 'left-only' || s.stereoKind === 'right-only') s.notes.push('Only the ' + (s.stereoKind === 'left-only' ? 'left' : 'right') + ' side has audio: treated as mono.');
    if (a.silent) {
      s.role = 'other';
      s.confidence = 1;
      s.notes.push('This file is silent and will be skipped.');
    } else if (!s.roleLocked) {
      const c = classifyStem(s.fileName || s.name, a);
      s.role = c.role;
      s.confidence = c.confidence;
      s.roleSource = c.source;
      s.hints = c.hints;
    }
    if (!a.silent && a.peakEnv && a.peakDb > -0.1) s.notes.push('Peaks hit 0 dBFS: the bounce may be clipped.');
    s.status = 'ready';
  }

  // Line stems up using Broadcast WAV timestamps when every stem has one and
  // they differ (stems bounced from different start points).
  async alignByTimestamp() {
    const ready = this.readyStems;
    if (ready.length < 2 || !ready.every((s) => s.bext !== null && Number.isFinite(s.bext))) return;
    const min = Math.min(...ready.map((s) => s.bext / s.srcRate));
    for (const s of ready) {
      const off = Math.round((s.bext / s.srcRate - min) * this.projectRate);
      const already = s.alignedOffset || 0;
      if (off === already || off <= 0 || off > this.projectRate * 600) continue;
      const pad = off - already;
      s.packed = s.packed.map((p) => {
        const f = new Float32Array(p.length + pad);
        unpackInto(p, f, 0, p.length, pad);
        return packChannel(f);
      });
      s.frames = s.packed[0].length;
      s.seconds = s.frames / this.projectRate;
      s.alignedOffset = off;
      s.notes.push(`Lined up using its Broadcast WAV timestamp (+${(off / this.projectRate).toFixed(2)} s).`);
      const a = await this.pool.run('analyze', { packed: s.packed, fs: this.projectRate });
      this.applyAnalysis(s, a);
    }
  }

  updateSession() {
    const ready = this.readyStems.filter((s) => !s.analysis.silent);
    // Left/right halves bounced as two mono files.
    this.lrPairs = findLrPairs(ready);
    // Tempo: a click track is the most reliable source, then the drums.
    const click = ready.find((s) => s.role === 'click');
    let flux = null;
    const add = (f) => {
      if (!flux) flux = Float32Array.from(f);
      else for (let i = 0; i < Math.min(flux.length, f.length); i++) flux[i] += f[i];
    };
    if (click) add(click.analysis.flux);
    else {
      const perc = ready.filter((s) => ['kick', 'snare', 'hats', 'drumKit', 'percussion', 'backingTrack'].includes(s.role));
      for (const s of perc.length ? perc : ready) add(s.analysis.flux);
    }
    this.tempo = flux ? Math.round(estimateTempo(flux) * 10) / 10 : 0;
  }

  setRole(id, role) {
    const s = this.stems.find((x) => x.id === id);
    if (!s) return;
    s.role = role;
    s.roleLocked = true;
    s.confidence = 1;
    s.roleSource = 'user';
    this.updateSession();
    this.onChange();
  }

  setUser(id, patch) {
    const s = this.stems.find((x) => x.id === id);
    if (s) Object.assign(s.user, patch);
  }

  removeStem(id) {
    this.stems = this.stems.filter((s) => s.id !== id);
    if (!this.stems.length) this.projectRate = null;
    this.updateSession();
    this.onChange();
  }

  clear() {
    this.stems = [];
    this.projectRate = null;
    this.pairCache.clear();
    this.last = null;
    this.onChange();
  }

  // ------------------------------------------------------------- reference

  async setReference(file) {
    this.reference = { name: file.name.replace(/\.[^.]+$/, ''), status: 'analysing' };
    this.onReference();
    try {
      const buf = await file.arrayBuffer();
      const h = readHeader(buf);
      let L;
      let R;
      let fs;
      if (h && canParseDirectly(h)) {
        const packed = parseToPacked(buf, h);
        fs = h.sampleRate;
        L = new Float32Array(packed[0].length);
        unpackInto(packed[0], L);
        R = new Float32Array(L.length);
        unpackInto(packed[1] || packed[0], R);
      } else {
        fs = this.projectRate || 48000;
        const ab = await decodeWithBrowser(buf, fs);
        L = Float32Array.from(ab.getChannelData(0));
        R = Float32Array.from(ab.getChannelData(Math.min(1, ab.numberOfChannels - 1)));
      }
      const analysis = await this.pool.run('analyzeReference', { L, R, fs });
      analysis.curve = Float64Array.from(analysis.curve);
      this.reference = { name: this.reference.name, status: 'ready', L, R, fs, analysis };
      this.reference.closest = this.closestGenre(analysis);
    } catch (err) {
      console.error(err);
      this.reference = { name: this.reference?.name, status: 'error', error: 'Could not read this song. Try a WAV or MP3.' };
    }
    this.onReference();
  }

  clearReference() {
    this.reference = null;
    this.onReference();
  }

  closestGenre(a) {
    const ref = normaliseCurve(a.curve3 ? Float64Array.from(a.curve3) : a.curve);
    const bands = [
      [30, 60, 1],
      [60, 150, 1.2],
      [150, 500, 1],
      [2000, 5000, 1],
      [8000, 14000, 0.8],
    ];
    let best = null;
    for (const g of GENRES) {
      const gc = normaliseCurve(genreCurve(g));
      let score = 0;
      for (const [lo, hi, w] of bands) {
        const d = curveMean(ref, lo, hi) - curveMean(gc, lo, hi);
        score += w * d * d;
      }
      const dl = (a.lufs - g.master.lufs) / 1.5;
      score += dl * dl;
      if (!best || score < best.score) best = { id: g.id, name: g.name, score };
    }
    return best;
  }

  // ---------------------------------------------------------------- render

  async render({ genreId, options = {} }, onProgress = () => {}) {
    const fs = this.projectRate;
    const stems = this.readyStems;
    if (!stems.length) throw new Error('No stems ready');
    const genre = getGenre(genreId);
    const useRef = options.mode === 'reference' && this.reference?.status === 'ready';
    const refAnalysis = useRef ? this.reference.analysis : null;
    const steps = ['Checking phase between mics', 'Measuring balance', 'Mixing stems', 'Adding space', 'Mastering', 'Finishing'];
    const report = (stage, frac, label) => onProgress({ stage, steps, frac, label });
    const t0 = performance.now();

    // 1. Phase and alignment between mics on the same source.
    report(0, 0.01, steps[0]);
    const alignment = await this.checkPairs(stems, fs);

    // 2. Plan.
    const planStems = stems.map((s) => ({
      id: s.id,
      name: s.name,
      role: s.role,
      hints: s.hints || {},
      analysis: s.analysis,
      stereoKind: s.collapse ? 'mono' : s.stereoKind,
      collapse: s.collapse,
      user: s.user,
    }));
    const plan = planMix({
      stems: planStems,
      genre,
      reference: refAnalysis,
      options,
      fs,
      tempo: this.tempo,
      pairs: this.lrPairs || [],
      alignment,
    });

    // 3. Balance: measure each group on its loudest passage.
    report(1, 0.08, steps[1]);
    const byId = new Map(stems.map((s) => [s.id, s]));
    const stripById = new Map(plan.strips.map((st) => [st.id, st]));
    const preroll = Math.round(PREROLL_S * fs);
    let doneGroups = 0;
    const results = {};
    await Promise.all(
      plan.groups.map(async (g) => {
        const [ws, we] = g.window;
        const members = g.members.map((id) => {
          const s = byId.get(id);
          const sl = s.packed.map((p) => slicePacked(p, Math.max(0, ws - preroll), Math.min(p.length, we)));
          return { packed: sl.map((x) => x.packed), start: ws - sl[0].origin, strip: stripById.get(id) };
        });
        results[g.key] = await this.pool.run('group', { members, fs, preroll, length: we - ws });
        doneGroups++;
        report(1, 0.08 + 0.12 * (doneGroups / plan.groups.length), steps[1]);
      }),
    );
    applyLevels(plan, results);

    // 4. Full render of every stem, summed into the mix and the send buses.
    report(2, 0.2, steps[2]);
    const active = plan.strips.filter((st) => !st.mute);
    const maxLen = Math.max(...active.map((st) => byId.get(st.id).frames));
    const tail = Math.round(Math.min(6, (plan.buses.space.rt60 || 2) + 1.5) * fs);
    const N = maxLen + tail;
    const mixL = new Float32Array(N);
    const mixR = new Float32Array(N);
    const buses = {};
    const busFor = (name) => (buses[name] ||= { L: new Float32Array(N), R: new Float32Array(N) });
    let rendered = 0;
    const stripStats = {};
    await Promise.all(
      active.map(async (st) => {
        const s = byId.get(st.id);
        const r = await this.pool.run('render', { packed: s.packed, fs, strip: st, length: s.frames });
        const { L, R } = r;
        const n = L.length;
        for (let i = 0; i < n; i++) {
          mixL[i] += L[i];
          mixR[i] += R[i];
        }
        for (const bus of ['plate', 'space', 'delay']) {
          const db = st.sends?.[bus];
          if (db === null || db === undefined) continue;
          const g = Math.pow(10, db / 20);
          const b = busFor(bus);
          for (let i = 0; i < n; i++) {
            b.L[i] += L[i] * g;
            b.R[i] += R[i] * g;
          }
        }
        stripStats[st.id] = { ...r.stats, peakDb: r.peakDb };
        rendered++;
        report(2, 0.2 + 0.45 * (rendered / active.length), `Mixing stems (${rendered} of ${active.length})`);
      }),
    );

    // 5. Effects returns.
    report(3, 0.66, steps[3]);
    await Promise.all(
      Object.entries(buses).map(async ([name, b]) => {
        const params = plan.buses[name];
        const out = await this.pool.run('reverb', { kind: name, L: b.L, R: b.R, fs, params }, [b.L.buffer, b.R.buffer]);
        for (let i = 0; i < N; i++) {
          mixL[i] += out.L[i];
          mixR[i] += out.R[i];
        }
      }),
    );

    // 6. Original (static sum of the raw stems) for comparison.
    const original = this.rawSum(stems, N);

    // 7. Master.
    report(4, 0.74, steps[4]);
    const mastered = await this.pool.run(
      'master',
      { L: mixL, R: mixR, fs, master: plan.master },
      [mixL.buffer, mixR.buffer],
      (p, label) => report(4, 0.74 + 0.22 * p, label || steps[4]),
    );

    // 8. Measurements for level matched playback.
    report(5, 0.97, steps[5]);
    const origMeas = await this.pool.run('measure', { L: original.L, R: original.R, fs });
    const rep = mastered.report;
    const result = {
      fs,
      seconds: N / fs,
      genre,
      mode: useRef ? 'reference' : 'genre',
      referenceName: useRef ? this.reference.name : null,
      tempo: this.tempo,
      plan,
      stripStats,
      master: rep,
      tracks: {
        master: { L: mastered.master.L, R: mastered.master.R, lufs: rep.final.lufs, peakDb: rep.final.truePeakDb },
        mix: { L: mastered.mix.L, R: mastered.mix.R, lufs: rep.mix.lufs, peakDb: rep.mix.peakDb },
        original: { L: original.L, R: original.R, lufs: origMeas.lufs, peakDb: origMeas.peakDb },
        reference: useRef
          ? {
              L: this.reference.L,
              R: this.reference.R,
              sampleRate: this.reference.fs,
              lufs: refAnalysis.lufs,
              peakDb: refAnalysis.truePeakDb,
              startAt: refAnalysis.loudestStart,
            }
          : null,
      },
      elapsed: (performance.now() - t0) / 1000,
    };
    this.last = result;
    report(5, 1, 'Done');
    return result;
  }

  async checkPairs(stems, fs) {
    const alignment = {};
    const inPair = new Set((this.lrPairs || []).flat());
    const groups = {};
    for (const s of stems) {
      if (!PAIR_ROLES.has(s.role) || s.analysis.silent || inPair.has(s.id) || s.hints?.double) continue;
      if (s.channels > 1 && !s.collapse) continue;
      (groups[s.role] ||= []).push(s);
    }
    const jobs = [];
    for (const list of Object.values(groups)) {
      if (list.length < 2) continue;
      // Primary: inside kick / snare top / bass DI or simply the loudest.
      list.sort((a, b) => {
        const pa = (a.hints?.inside || a.hints?.top || a.hints?.di ? 1 : 0) * 100 + a.analysis.lufs;
        const pb = (b.hints?.inside || b.hints?.top || b.hints?.di ? 1 : 0) * 100 + b.analysis.lufs;
        return pb - pa;
      });
      const primary = list[0];
      for (const other of list.slice(1)) {
        const key = primary.id + '|' + other.id;
        if (this.pairCache.has(key)) {
          const c = this.pairCache.get(key);
          if (c) alignment[other.id] = c;
          continue;
        }
        const kb = Float64Array.from(primary.analysis.kBlocks);
        const ob = other.analysis.kBlocks;
        for (let i = 0; i < Math.min(kb.length, ob.length); i++) kb[i] += ob[i];
        const [ws, we] = loudestWindow(kb, fs, 2.5);
        const sliceOf = (s) => {
          const sl = s.packed.map((p) => slicePacked(p, ws, Math.min(p.length, we)));
          return { packed: sl.map((x) => x.packed), start: ws - sl[0].origin, end: we - sl[0].origin };
        };
        jobs.push(
          this.pool
            .run('pair', { a: sliceOf(primary), b: sliceOf(other), maxLag: Math.round(0.006 * fs) })
            .then(({ r, lag }) => {
              let res = null;
              if (Math.abs(r) >= 0.3 && (r < 0 || Math.abs(lag) >= 2)) {
                res = { polarity: r < 0 ? -1 : 1, delay: Math.abs(lag) >= 2 ? -lag : 0, r };
                alignment[other.id] = res;
              }
              this.pairCache.set(key, res);
            }),
        );
      }
    }
    await Promise.all(jobs);
    return alignment;
  }

  rawSum(stems, N) {
    const L = new Float32Array(N);
    const R = new Float32Array(N);
    const CH = 65536;
    const tmp = new Float32Array(CH);
    const tmp2 = new Float32Array(CH);
    for (const s of stems) {
      if (s.role === 'click' || s.role === 'guide' || s.analysis.silent) continue;
      const p = s.packed;
      const mono = p.length === 1 || s.collapse;
      for (let off = 0; off < s.frames; off += CH) {
        const len = Math.min(CH, s.frames - off);
        if (mono) {
          const src = s.collapse === 'R' ? p[1] : p[0];
          unpackInto(src, tmp, off, off + len, 0);
          for (let i = 0; i < len; i++) {
            const v = tmp[i] * Math.SQRT1_2;
            L[off + i] += v;
            R[off + i] += v;
          }
        } else {
          unpackInto(p[0], tmp, off, off + len, 0);
          unpackInto(p[1], tmp2, off, off + len, 0);
          for (let i = 0; i < len; i++) {
            L[off + i] += tmp[i];
            R[off + i] += tmp2[i];
          }
        }
      }
    }
    return { L, R };
  }

  // --------------------------------------------------------------- outputs

  exportWav(kind, { trim = true } = {}) {
    const r = this.last;
    if (!r) return null;
    const t = kind.startsWith('mix') ? r.tracks.mix : r.tracks.master;
    const bits = kind.endsWith('16') ? 16 : 24;
    return encodeWav(t.L, t.R, r.fs, bits, { trim });
  }

  reportLines() {
    const r = this.last;
    if (!r) return null;
    const m = r.master;
    const out = { summary: [], master: [], buses: [], strips: [] };
    const target = r.mode === 'reference' ? `the reference "${r.referenceName}"` : `the ${r.genre.name} profile`;
    out.summary.push(`Mixed and mastered toward ${target}${r.mode === 'reference' ? ` (stem mix style: ${r.genre.name})` : ''}.`);
    if (r.tempo) out.summary.push(`Detected tempo: about ${Math.round(r.tempo)} BPM (delays are timed to it).`);
    out.summary.push(
      `Final master: ${m.final.lufs.toFixed(1)} LUFS integrated, ${m.final.truePeakDb.toFixed(1)} dBTP true peak, ` +
        `${m.final.lra.toFixed(1)} LU loudness range.`,
    );
    if (m.glue) out.master.push(`Bus glue: ${m.glue.targetGr.toFixed(1)} dB of gentle 2:1 style compression with the low end kept out of the detector.`);
    if (m.eq?.length) {
      out.master.push(
        'Tonal match EQ: ' +
          m.eq
            .map((s) => `${formatDb(s.gain)} dB ${s.type === 'lowshelf' ? 'low shelf' : s.type === 'highshelf' ? 'high shelf' : 'bell'} at ${formatHz(s.f)}`)
            .join(', ') +
          '.',
      );
    } else out.master.push('Tonal match EQ: the mix already sat close to the target, so no master EQ was needed.');
    if (m.width) {
      out.master.push(
        `Stereo: low end kept mono below ${formatHz(m.width.bassMonoHz)}; side level ${formatDb(m.width.sideMidDb)} dB in the mids, ` +
          `${formatDb(m.width.sideHighDb)} dB in the highs.`,
      );
    }
    if (m.warmth) out.master.push(`Analogue warmth: ${Math.round(m.warmth * 100)}% gentle saturation.`);
    out.master.push(
      `Limiter: ceiling ${m.limiter.ceilingDb.toFixed(1)} dBTP, peaks reduced by up to ${m.limiter.maxGr.toFixed(1)} dB to reach ` +
        `${m.final.targetLufs.toFixed(1)} LUFS.`,
    );
    const b = r.plan.buses;
    out.buses.push(`Plate reverb: ${b.plate.rt60.toFixed(1)} s decay, ${Math.round(b.plate.preDelay * 1000)} ms pre-delay.`);
    out.buses.push(`${b.space.type[0].toUpperCase() + b.space.type.slice(1)} reverb: ${b.space.rt60.toFixed(1)} s decay.`);
    out.buses.push(`Delay: ${b.delay.note} note${b.delay.bpm ? ` at ${Math.round(b.delay.bpm)} BPM` : ''} (${Math.round(b.delay.time * 1000)} ms), ${Math.round(b.delay.feedback * 100)}% feedback.`);
    for (const st of r.plan.strips) {
      out.strips.push({ id: st.id, name: st.name, role: roleLabel(st.role), lines: describeStrip(st) });
    }
    return out;
  }

  reportText() {
    const rep = this.reportLines();
    if (!rep) return '';
    const lines = ['CURATE STUDIO · MIX REPORT', ''];
    lines.push(...rep.summary, '', 'MASTER', ...rep.master.map((l) => '- ' + l), '', 'SPACE', ...rep.buses.map((l) => '- ' + l), '');
    for (const s of rep.strips) {
      lines.push(`${s.name.toUpperCase()} (${s.role})`, ...s.lines.map((l) => '- ' + l), '');
    }
    return lines.join('\n');
  }
}

export { GENRES, getGenre, BFP_BLOCK };
