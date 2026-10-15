// Curate Studio UI controller.

import { StudioSession, GENRES, getGenre } from './engine/studio.js';
import { ROLES, ROLE_ORDER } from './engine/classify.js';
import { ANALYSIS_GRID } from './engine/spectrum.js';
import { formatDb } from './engine/util.js';
import { Player, fmtTime } from './ui/player.js';
import { waveformPeaks, drawWaveform, drawTonal } from './ui/charts.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) e.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids) if (kid !== null && kid !== undefined) e.append(kid);
  return e;
};

const TUNES = [
  { key: 'vocal', label: 'Vocal level', ends: ['Tucked in', 'Upfront'] },
  { key: 'punch', label: 'Drum punch', ends: ['Soft', 'Hard hitting'] },
  { key: 'lowEnd', label: 'Low end', ends: ['Lean', 'Heavy'] },
  { key: 'brightness', label: 'Brightness', ends: ['Warm', 'Bright'] },
  { key: 'width', label: 'Stereo width', ends: ['Narrow', 'Wide'] },
  { key: 'space', label: 'Space (reverb)', ends: ['Dry', 'Big'] },
  { key: 'warmth', label: 'Analogue warmth', ends: ['Clean', 'Saturated'] },
];

const state = {
  mode: 'genre',
  genreId: 'modern-worship',
  refStyleId: null,
  adjust: Object.fromEntries(TUNES.map((t) => [t.key, 0])),
  match: null,
  result: null,
  peaks: {},
  rendering: false,
  dirty: false,
};

const session = new StudioSession({ onChange: renderStems, onReference: renderReference });
const player = new Player({ onTime: onTime, onEnded: () => setPlayIcon(false) });

// ------------------------------------------------------------------ utils

let toastTimer = 0;
function toast(msg, ms = 4200) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

function secs(s) {
  return fmtTime(s);
}

// Files from a drop, including folders.
async function filesFromDrop(dt) {
  const items = Array.from(dt.items || []);
  const entries = items.map((i) => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
  if (!entries.length) return Array.from(dt.files || []);
  const out = [];
  const walk = async (entry) => {
    if (entry.isFile) {
      await new Promise((res) => entry.file((f) => (out.push(f), res()), res));
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      let batch;
      do {
        batch = await new Promise((res) => reader.readEntries(res, () => res([])));
        for (const e of batch) await walk(e);
      } while (batch.length);
    }
  };
  for (const e of entries) await walk(e);
  return out;
}

function wireDrop(zone, input, onFiles) {
  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('over');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', async (e) => {
    e.preventDefault();
    zone.classList.remove('over');
    onFiles(await filesFromDrop(e.dataTransfer));
  });
  zone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      input.click();
    }
  });
  input.addEventListener('change', () => {
    onFiles(Array.from(input.files));
    input.value = '';
  });
}

// ------------------------------------------------------------------ stems

function stemMeta(s) {
  if (!s.frames) return s.status === 'error' ? '' : 'Reading…';
  const ch = s.collapse ? 'Mono (from stereo)' : s.channels > 1 ? 'Stereo' : 'Mono';
  return [ch, s.bits, secs(s.seconds)].filter(Boolean).join(' · ');
}

function stemStatus(s) {
  if (s.status === 'error') return el('span', { class: 'warn', text: s.error });
  if (s.status !== 'ready') return document.createTextNode(s.status === 'analysing' ? 'Listening…' : s.status === 'decoding' ? 'Reading…' : 'Waiting…');
  const frag = document.createDocumentFragment();
  if (s.role === 'click' || s.role === 'guide') frag.append(el('span', { class: 'ok', text: 'Kept out of the mix. ' }));
  else if (s.confidence < 0.65 && s.roleSource === 'audio') frag.append(el('span', { class: 'warn', text: 'Best guess from the audio, please check. ' }));
  if (s.notes.length) frag.append(document.createTextNode(s.notes.join(' ')));
  return frag;
}

function renderStems() {
  const stems = session.stems;
  $('#stem-list').hidden = !stems.length;
  const table = $('#stem-table');
  table.replaceChildren(
    el('div', { class: 'stem-row head', role: 'row' }, el('span', { text: 'Stem' }), el('span', { text: 'Part' }), el('span', { text: 'Format' }), el('span', { text: 'Notes' }), el('span')),
  );
  for (const s of stems) {
    const select = el('select', { 'aria-label': `Part for ${s.name}`, disabled: s.status !== 'ready' });
    for (const r of ROLE_ORDER) select.append(el('option', { value: r, text: ROLES[r].label, selected: r === s.role }));
    if (s.status === 'ready' && s.confidence < 0.65) select.classList.add('low-confidence');
    select.addEventListener('change', () => {
      session.setRole(s.id, select.value);
      markDirty();
    });
    const row = el(
      'div',
      { class: 'stem-row' + (s.status === 'analysing' || s.status === 'decoding' ? ' analysing' : '') + (s.role === 'click' || s.role === 'guide' || s.analysis?.silent ? ' muted' : ''), role: 'row' },
      el('span', { class: 'stem-name', title: s.fileName || s.name, text: s.name }),
      select,
      el('span', { class: 'stem-meta', text: stemMeta(s) }),
      el('span', { class: 'stem-status' }, stemStatus(s)),
      el('button', {
        class: 'icon-btn',
        type: 'button',
        'aria-label': `Remove ${s.name}`,
        title: 'Remove',
        text: '×',
        onclick: () => {
          session.removeStem(s.id);
          markDirty();
        },
      }),
    );
    table.append(row);
  }
  const ready = session.readyStems.length;
  $('#stem-count').textContent = `${stems.length} stem${stems.length === 1 ? '' : 's'}${session.projectRate ? ` · ${session.projectRate / 1000} kHz` : ''}${session.tempo ? ` · ${Math.round(session.tempo)} BPM` : ''}`;
  const notes = [];
  const mem = session.memoryEstimate();
  if (mem > 2.5e9) notes.push('This is a very large session. If the browser runs out of memory, bounce fewer stems (group drums or BGVs into buses) or a shorter section.');
  if (ready && session.lrPairs?.length) notes.push(`Paired ${session.lrPairs.length} left/right stem${session.lrPairs.length > 1 ? 's' : ''} into stereo.`);
  $('#stem-note').textContent = notes.join(' ');
  updateRunState();
}

async function addStems(files) {
  if (!files.length) return;
  const n = await session.addFiles(files);
  if (!n) toast('Those files are not audio. Try WAV, AIFF, MP3, FLAC or M4A.');
  markDirty();
}

// ------------------------------------------------------------------ sound

function renderGenres() {
  const grid = $('#genre-grid');
  grid.replaceChildren();
  for (const g of GENRES) {
    const btn = el(
      'button',
      { class: 'genre' + (g.id === state.genreId ? ' active' : ''), type: 'button', 'aria-pressed': g.id === state.genreId ? 'true' : 'false', title: g.examples },
      el('span', { class: 'genre-name', text: g.name }),
      el('span', { class: 'genre-blurb', text: g.blurb }),
      el('span', { class: 'genre-meta', text: `Master ${g.master.lufs} LUFS` }),
    );
    btn.addEventListener('click', () => {
      state.genreId = g.id;
      renderGenres();
      markDirty();
    });
    grid.append(btn);
  }
}

function setMode(mode) {
  state.mode = mode;
  for (const t of $$('.tab')) {
    const on = t.dataset.mode === mode;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', on ? 'true' : 'false');
  }
  $('#mode-genre').hidden = mode !== 'genre';
  $('#mode-reference').hidden = mode !== 'reference';
  const loud = $('#opt-loudness');
  if (mode === 'reference' && loud.value === 'genre') loud.value = 'reference';
  if (mode === 'genre' && loud.value === 'reference') loud.value = 'genre';
  markDirty();
}

function renderReference() {
  const r = session.reference;
  const box = $('#ref-summary');
  const styleRow = $('#ref-style-row');
  if (!r) {
    box.hidden = true;
    styleRow.hidden = true;
    updateRunState();
    return;
  }
  box.hidden = false;
  if (r.status === 'analysing') {
    box.replaceChildren(el('div', { class: 'cell wide' }, el('span', { class: 'hint', text: `Listening to “${r.name}”…` })));
    styleRow.hidden = true;
  } else if (r.status === 'error') {
    box.replaceChildren(el('div', { class: 'cell wide' }, el('span', { class: 'hint', text: r.error })));
    styleRow.hidden = true;
  } else {
    const a = r.analysis;
    const cell = (label, value, sub) =>
      el('div', { class: 'cell' }, el('div', { class: 'stat-label', text: label }), el('div', { class: 'stat-value' }, value), sub ? el('div', { class: 'stat-sub', text: sub }) : null);
    const val = (v, unit) => {
      const f = document.createDocumentFragment();
      f.append(v, el('small', { text: unit }));
      return f;
    };
    box.replaceChildren(
      el(
        'div',
        { class: 'cell wide' },
        el('span', {}, el('span', { class: 'stat-label', text: 'Reference' }), el('div', { class: 'genre-name', text: r.name })),
        el('button', { class: 'btn-text', type: 'button', text: 'Remove', onclick: () => { session.clearReference(); markDirty(); } }),
      ),
      cell('Loudness', val(a.lufs.toFixed(1), 'LUFS')),
      cell('True peak', val(a.truePeakDb.toFixed(1), 'dBTP')),
      cell('Dynamics', val(a.plr.toFixed(1), 'dB PLR'), a.plr < 8.5 ? 'Very loud and dense' : a.plr < 11 ? 'Modern and punchy' : 'Open and dynamic'),
      cell('Width', val(a.width.mid.toFixed(1), 'dB side'), a.width.mid > -8 ? 'Wide' : a.width.mid > -12 ? 'Moderate' : 'Narrow'),
    );
    styleRow.hidden = false;
    const sel = $('#ref-style');
    if (!state.refStyleId) state.refStyleId = r.closest?.id || state.genreId;
    sel.replaceChildren(...GENRES.map((g) => el('option', { value: g.id, text: g.name, selected: g.id === state.refStyleId })));
    $('#ref-style-hint').textContent = r.closest ? `Closest match: ${r.closest.name}. This sets how your stems are treated; the master follows the song.` : '';
  }
  updateRunState();
}

// ------------------------------------------------------------- fine-tune

function renderTune() {
  const grid = $('#tune-grid');
  grid.replaceChildren();
  for (const t of TUNES) {
    const out = el('span', { class: 'tune-val', text: '0' });
    const input = el('input', { type: 'range', min: -3, max: 3, step: 1, value: state.adjust[t.key], 'aria-label': t.label });
    const show = () => (out.textContent = (input.value > 0 ? '+' : '') + input.value);
    show();
    input.addEventListener('input', () => {
      state.adjust[t.key] = Number(input.value);
      show();
      markDirty();
    });
    grid.append(
      el('div', { class: 'tune' }, el('div', { class: 'tune-top' }, el('span', { class: 'tune-label', text: t.label }), out), input, el('div', { class: 'tune-ends' }, el('span', { text: t.ends[0] }), el('span', { text: t.ends[1] }))),
    );
  }
  // Tonal match strength.
  const out = el('span', { class: 'tune-val', text: 'Auto' });
  const input = el('input', { type: 'range', min: 30, max: 100, step: 5, value: 75, 'aria-label': 'Tonal match strength' });
  input.addEventListener('input', () => {
    state.match = Number(input.value) / 100;
    out.textContent = input.value + '%';
    markDirty();
  });
  grid.append(
    el('div', { class: 'tune' }, el('div', { class: 'tune-top' }, el('span', { class: 'tune-label', text: 'Tonal match' }), out), input, el('div', { class: 'tune-ends' }, el('span', { text: 'Gentle' }), el('span', { text: 'Exact' }))),
  );
}

function options() {
  const loud = $('#opt-loudness').value;
  return {
    mode: state.mode,
    loudness: loud,
    customLufs: Number($('#opt-custom-lufs').value),
    ceiling: Number($('#opt-ceiling').value),
    intensity: $('#opt-intensity').value,
    adjust: { ...state.adjust },
    ...(state.match !== null ? { match: state.match } : {}),
  };
}

// ------------------------------------------------------------------- run

function updateRunState() {
  const ready = session.readyStems.filter((s) => !s.analysis?.silent && s.role !== 'click' && s.role !== 'guide').length;
  const busy = session.busy;
  const needRef = state.mode === 'reference' && session.reference?.status !== 'ready';
  const btn = $('#run');
  btn.disabled = state.rendering || busy || !ready || needRef;
  let hint;
  if (state.rendering) hint = 'Working…';
  else if (!session.stems.length) hint = 'Add your stems to begin.';
  else if (busy) hint = 'Listening to your stems…';
  else if (!ready) hint = 'No usable stems yet.';
  else if (needRef) hint = 'Drop a reference song, or switch back to a genre.';
  else hint = `${ready} stem${ready === 1 ? '' : 's'} ready · ${state.mode === 'reference' ? 'matching “' + session.reference.name + '”' : getGenre(state.genreId).name}`;
  $('#run-hint').textContent = hint;
  $('#rerender').disabled = !state.result || state.rendering || !state.dirty || busy;
}

function markDirty() {
  state.dirty = true;
  updateRunState();
}

function showProgress(p) {
  const box = $('#progress');
  box.hidden = false;
  $('#progress-title').textContent = p.label || p.steps[p.stage];
  $('#progress-pct').textContent = Math.round(p.frac * 100) + '%';
  $('#bar-fill').style.width = (p.frac * 100).toFixed(1) + '%';
  const list = $('#progress-steps');
  if (list.children.length !== p.steps.length) list.replaceChildren(...p.steps.map((s) => el('li', { text: s })));
  [...list.children].forEach((li, i) => {
    li.className = i < p.stage ? 'done' : i === p.stage ? 'active' : '';
  });
}

async function run() {
  if (state.rendering) return;
  state.rendering = true;
  updateRunState();
  const genreId = state.mode === 'reference' ? $('#ref-style').value || state.refStyleId || state.genreId : state.genreId;
  const keep = state.result ? { current: player.current, pos: player.offset } : null;
  player.pause();
  showProgress({ stage: 0, steps: ['Preparing'], frac: 0, label: 'Preparing' });
  $('#progress').scrollIntoView({ behavior: 'smooth', block: 'center' });
  try {
    const res = await session.render({ genreId, options: options() }, showProgress);
    state.result = res;
    state.dirty = false;
    state.peaks = {};
    for (const [k, t] of Object.entries(res.tracks)) if (t) state.peaks[k] = waveformPeaks(t.L, t.R);
    player.load(res.tracks, res.fs);
    if (keep) {
      player.select(keep.current);
      player.offset = Math.min(keep.pos, player.duration);
    }
    showResults(res);
    $('#progress').hidden = true;
    if (!keep) $('#results').scrollIntoView({ behavior: 'smooth', block: 'start' });
    else toast('Updated. The new version is ready to play.');
  } catch (err) {
    console.error(err);
    $('#progress').hidden = true;
    toast('Something went wrong while mixing: ' + (err.message || err).toString().split('\n')[0]);
  } finally {
    state.rendering = false;
    updateRunState();
  }
}

// --------------------------------------------------------------- results

function statTile(label, value, unit, sub) {
  return el('div', { class: 'stat' }, el('div', { class: 'stat-label', text: label }), el('div', { class: 'stat-value' }, value, el('small', { text: unit })), sub ? el('div', { class: 'stat-sub', text: sub }) : null);
}

function showResults(res) {
  $('#results').hidden = false;
  const f = res.master.final;
  const target = res.mode === 'reference' ? `“${res.referenceName}” with ${res.genre.name} mix style` : res.genre.name;
  $('#result-sub').textContent = `Mixed and mastered toward ${target}. Rendered in ${res.elapsed.toFixed(1)} s.`;
  $('[data-src="reference"]').hidden = !res.tracks.reference;
  for (const b of $$('.ab-btn')) b.classList.toggle('active', b.dataset.src === player.current);
  // Stats.
  const w = res.master.widthAfter;
  const tiles = [
    statTile('Loudness', f.lufs.toFixed(1), 'LUFS', `Target ${f.targetLufs.toFixed(1)}`),
    statTile('True peak', f.truePeakDb.toFixed(1), 'dBTP', `Ceiling ${res.master.limiter.ceilingDb.toFixed(1)}`),
    statTile('Dynamics', f.plr.toFixed(1), 'dB', 'Peak to loudness ratio'),
    statTile('Loudness range', f.lra.toFixed(1), 'LU', f.lra < 4 ? 'Steady' : f.lra < 8 ? 'Some movement' : 'Very dynamic'),
    statTile('Width', w.mid.toFixed(1), 'dB', 'Side vs mid energy'),
  ];
  if (res.tempo) tiles.push(statTile('Tempo', Math.round(res.tempo), 'BPM', 'Delays follow it'));
  $('#stats').replaceChildren(...tiles);
  drawCharts();
  renderMixer(res);
  renderReport();
  onTime(player.position, player.duration);
}

function drawCharts() {
  const res = state.result;
  if (!res) return;
  const c = res.master.curves;
  const css = getComputedStyle(document.documentElement);
  const curves = [
    { data: c.target, color: css.getPropertyValue('--curve-target').trim(), dash: [5, 4], width: 1.5, label: res.mode === 'reference' ? 'Reference' : 'Genre target' },
    { data: c.before, color: css.getPropertyValue('--curve-before').trim(), width: 1.5, label: 'Mix before mastering' },
    { data: c.after, color: css.getPropertyValue('--curve-after').trim(), width: 2, label: 'Master' },
  ];
  drawTonal($('#tonal'), ANALYSIS_GRID, curves);
  $('#tonal-legend').replaceChildren(
    ...curves.map((cv) => el('span', {}, el('i', { style: `background:${cv.color}` }), cv.label)),
  );
  drawWave();
}

function drawWave() {
  const res = state.result;
  if (!res) return;
  const peaks = state.peaks[player.current];
  const scale = player.levelMatch ? player.gainFor(player.current) : 1;
  drawWaveform($('#wave'), peaks, player.duration ? player.position / player.duration : 0, scale);
}

function onTime(pos, dur) {
  $('#time').textContent = `${fmtTime(pos)} / ${fmtTime(dur)}`;
  drawWave();
}

function setPlayIcon(playing) {
  $('.i-play').hidden = playing;
  $('.i-pause').hidden = !playing;
  $('#play').setAttribute('aria-label', playing ? 'Pause' : 'Play');
}

function renderMixer(res) {
  const box = $('#mixer');
  box.replaceChildren(el('div', { class: 'mix-row head' }, el('span', { text: 'Stem' }), el('span', { text: 'Level (vs auto)' }), el('span', { text: 'Pan' }), el('span', { text: '' })));
  const stemById = new Map(session.stems.map((s) => [s.id, s]));
  for (const st of res.plan.strips) {
    const s = stemById.get(st.id);
    if (!s || st.reason === 'click' || st.reason === 'guide' || st.reason === 'silent') continue;
    const lvl = el('input', { type: 'range', min: -12, max: 12, step: 0.5, value: s.user.level || 0, 'aria-label': `Level for ${s.name}` });
    const lvlOut = el('output', { text: formatDb(Number(lvl.value)) });
    lvl.addEventListener('input', () => {
      lvlOut.textContent = formatDb(Number(lvl.value));
      session.setUser(s.id, { level: Number(lvl.value) });
      markDirty();
    });
    const panVal = s.user.pan ?? st.pan ?? 0;
    const pan = el('input', { type: 'range', min: -100, max: 100, step: 5, value: Math.round(panVal * 100), 'aria-label': `Pan for ${s.name}` });
    const panTxt = (v) => (Math.abs(v) < 3 ? 'C' : (v < 0 ? 'L' : 'R') + Math.abs(v));
    const panOut = el('output', { text: panTxt(Math.round(panVal * 100)) });
    pan.addEventListener('input', () => {
      panOut.textContent = panTxt(Number(pan.value));
      session.setUser(s.id, { pan: Number(pan.value) / 100 });
      markDirty();
    });
    const mute = el('button', { class: 'mute-btn' + (s.user.mute ? ' on' : ''), type: 'button', text: 'Mute', 'aria-pressed': s.user.mute ? 'true' : 'false' });
    mute.addEventListener('click', () => {
      s.user.mute = !s.user.mute;
      mute.classList.toggle('on', s.user.mute);
      mute.setAttribute('aria-pressed', s.user.mute ? 'true' : 'false');
      markDirty();
    });
    box.append(
      el(
        'div',
        { class: 'mix-row' },
        el('span', { class: 'mix-name', title: s.name }, s.name, el('span', { class: 'mix-role', text: ROLES[st.role]?.label || st.role })),
        el('div', { class: 'mix-ctl' }, lvl, lvlOut),
        el('div', { class: 'mix-ctl' }, pan, panOut),
        mute,
      ),
    );
  }
}

function renderReport() {
  const rep = session.reportLines();
  const box = $('#report');
  if (!rep) return box.replaceChildren();
  const section = (title, meta, lines, open = false) =>
    el('details', { open }, el('summary', {}, title, meta ? el('span', { text: meta }) : null), el('ul', {}, ...lines.map((l) => el('li', { text: l }))));
  box.replaceChildren(
    section('Overview', null, rep.summary, true),
    section('Master', null, rep.master),
    section('Reverb & delay', null, rep.buses),
    ...rep.strips.map((s) => section(s.name, s.role, s.lines)),
  );
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function exportFile(kind) {
  const res = state.result;
  if (!res) return;
  const base = (res.mode === 'reference' ? 'Curate Studio - ' + res.referenceName + ' match' : 'Curate Studio - ' + res.genre.name).replace(/[\\/:*?"<>|]/g, '');
  if (kind === 'report') {
    download(new Blob([session.reportText()], { type: 'text/plain' }), base + ' - mix report.txt');
    return;
  }
  const trim = $('#trim').checked;
  const blob = session.exportWav(kind, { trim });
  const label = kind === 'mix24' ? 'unmastered mix 24bit' : kind === 'master16' ? 'master 16bit' : 'master 24bit';
  download(blob, `${base} - ${label}.wav`);
}

// ----------------------------------------------------------------- wiring

function init() {
  renderGenres();
  renderTune();
  renderStems();
  wireDrop($('#stem-drop'), $('#stem-input'), addStems);
  wireDrop($('#ref-drop'), $('#ref-input'), async (files) => {
    const f = files.find((x) => /\.(wav|wave|aif|aiff|mp3|flac|m4a|aac|ogg|opus)$/i.test(x.name) || (x.type || '').startsWith('audio/'));
    if (!f) return toast('Drop an audio file (WAV, MP3, FLAC, M4A).');
    state.refStyleId = null;
    await session.setReference(f);
    markDirty();
  });
  $('#clear-stems').addEventListener('click', () => {
    session.clear();
    markDirty();
  });
  for (const t of $$('.tab')) t.addEventListener('click', () => setMode(t.dataset.mode));
  $('#ref-style').addEventListener('change', (e) => {
    state.refStyleId = e.target.value;
    markDirty();
  });
  $('#opt-loudness').addEventListener('change', (e) => {
    $('#custom-lufs-field').hidden = e.target.value !== 'custom';
    markDirty();
  });
  for (const id of ['#opt-custom-lufs', '#opt-ceiling', '#opt-intensity']) $(id).addEventListener('change', markDirty);
  $('#run').addEventListener('click', run);
  $('#rerender').addEventListener('click', run);
  $('#play').addEventListener('click', async () => {
    await player.toggle();
    setPlayIcon(player.playing);
  });
  for (const b of $$('.ab-btn')) {
    b.addEventListener('click', () => {
      player.select(b.dataset.src);
      for (const x of $$('.ab-btn')) x.classList.toggle('active', x === b);
      $('#ab-hint').textContent = player.matchCapped(b.dataset.src)
        ? 'This version is played a little quieter than the master so it does not clip.'
        : 'Level-matched playback compares versions at equal loudness, so you hear the mix decisions rather than volume.';
      drawWave();
    });
  }
  $('#level-match').addEventListener('change', (e) => {
    player.setLevelMatch(e.target.checked);
    drawWave();
  });
  $('#wave').addEventListener('click', (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    player.seek((e.clientX - r.left) / r.width);
  });
  for (const b of $$('[data-export]')) b.addEventListener('click', () => exportFile(b.dataset.export));
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && state.result && !/INPUT|SELECT|TEXTAREA|BUTTON/.test(document.activeElement?.tagName || '')) {
      e.preventDefault();
      $('#play').click();
    }
  });
  let rz = 0;
  window.addEventListener('resize', () => {
    cancelAnimationFrame(rz);
    rz = requestAnimationFrame(drawCharts);
  });
}

init();

// Handles for automated tests and debugging.
window.__studio = { session, state, player, run, showResults };
