import test from 'node:test';
import assert from 'node:assert/strict';
import { synthSession, wavBytes } from './synth.js';
import { StudioSession } from '../js/engine/studio.js';
import { ANALYSIS_GRID } from '../js/engine/spectrum.js';

function rmsDiff(a, b, lo = 40, hi = 14000) {
  let s = 0;
  let c = 0;
  for (let i = 0; i < ANALYSIS_GRID.length; i++) {
    const f = ANALYSIS_GRID[i];
    if (f < lo || f > hi) continue;
    s += (a[i] - b[i]) ** 2;
    c++;
  }
  return Math.sqrt(s / c);
}

test('full pipeline on a synthetic session', { timeout: 600000 }, async () => {
  const { fs, stems } = synthSession({ bars: 16 });
  const files = stems.map(([name, chs]) => new File([wavBytes(chs, fs)], name + '.wav', { type: 'audio/wav' }));
  const session = new StudioSession();
  const t0 = performance.now();
  await session.addFiles(files);
  const tAnalyse = performance.now() - t0;
  const byName = Object.fromEntries(session.stems.map((s) => [s.name, s]));
  const roles = Object.fromEntries(session.stems.map((s) => [s.name, s.role]));
  console.log('roles', JSON.stringify(roles));
  console.log('tempo', session.tempo, 'analyse ms', tAnalyse.toFixed(0));
  assert.equal(roles['Kick In'], 'kick');
  assert.equal(roles['Snare Bottom'], 'snare');
  assert.equal(roles['OH L'], 'overheads');
  assert.equal(roles['Bass DI'], 'bass');
  assert.equal(roles['Gtr L'], 'electricGuitar');
  assert.equal(roles['Acoustic'], 'acousticGuitar');
  assert.equal(roles['Lead Vox'], 'leadVocal');
  assert.equal(roles['BGV 1'], 'bgv');
  assert.equal(roles['Click'], 'click');
  assert.equal(roles['Guide'], 'guide');
  assert.ok(Math.abs(session.tempo - 120) < 2, 'tempo from click');

  const t1 = performance.now();
  const stages = [];
  const res = await session.render({ genreId: 'modern-worship', options: { mode: 'genre' } }, (p) => stages.push(p.label));
  const tRender = performance.now() - t1;
  const f = res.master.final;
  console.log('render ms', tRender.toFixed(0), 'final', JSON.stringify(f));
  console.log('master eq', JSON.stringify(res.master.eq), 'limiter', JSON.stringify(res.master.limiter));
  const strip = (name) => res.plan.strips.find((s) => s.name === name);
  console.log('snare bottom', JSON.stringify({ pol: strip('Snare Bottom').polarity, delay: strip('Snare Bottom').delay }));
  console.log('kick out', JSON.stringify({ pol: strip('Kick Out').polarity, delay: strip('Kick Out').delay }));
  for (const s of res.plan.strips) {
    console.log(`  ${s.name.padEnd(13)} ${s.role.padEnd(15)} gain ${s.mute ? 'muted' : (s.gain ?? 0).toFixed(1).padStart(6)} pan ${(s.pan || 0).toFixed(2)} comp ${s.comp ? s.comp.targetGr.toFixed(1) : '-'} eq ${s.eq ? JSON.stringify(s.eq.sections.map((x) => [x.type[0] + x.type[1], x.f, x.gain])) : ''}`);
  }
  assert.ok(Math.abs(f.lufs - -9) < 0.5, `loudness ${f.lufs}`);
  assert.ok(f.truePeakDb <= -0.95, `true peak ${f.truePeakDb}`);
  assert.equal(strip('Click').mute, true);
  assert.equal(strip('Guide').mute, true);
  assert.equal(strip('Snare Bottom').polarity, -1, 'snare bottom polarity fixed');
  assert.ok(Math.abs(strip("Kick Out").delay + 100) <= 12, `kick out aligned ${strip('Kick Out').delay}`);
  const c = res.master.curves;
  const before = rmsDiff(c.before, c.target);
  const after = rmsDiff(c.after, c.target);
  console.log('tonal distance before', before.toFixed(2), 'after', after.toFixed(2));
  assert.ok(after < before, 'master moved toward the target curve');
  assert.ok(res.tracks.master.L.length === res.tracks.mix.L.length);
  for (const x of [res.tracks.master.L, res.tracks.master.R]) {
    for (let i = 0; i < x.length; i += 997) assert.ok(Number.isFinite(x[i]));
  }
  const rep = session.reportText();
  assert.ok(rep.includes('LEAD VOX'));
  const wav = session.exportWav('master24', { trim: true });
  assert.ok(wav.size > 1000);
});
