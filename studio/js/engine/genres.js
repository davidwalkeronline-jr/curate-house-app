// Genre profiles: what a finished record in each style tends to look like
// (master loudness, tonal balance, stereo width) and how it is usually mixed
// (relative levels, compression, space, saturation).
//
// Levels are loudness offsets in LU relative to the lead vocal, measured on
// each part's loudest passage. Sends are dB below the dry signal.

import { ANALYSIS_GRID } from './spectrum.js';
import { THIRD_OCTAVE_CENTRES, interpLogCurve, logBump, logRamp } from './util.js';

// Tonal balance of a typical modern master in 1/3 octave bands, pink noise
// referenced, 0 dB at 1 kHz.
const BASE_CURVE = [
  -6.0, -1.5, 2.0, 4.0, 5.0, 5.5, 5.5, 5.0, 4.0, 3.0, 2.0, 1.2, 0.6, 0.2, 0.0, 0.0, 0.0,
  0.0, -0.4, -0.9, -1.5, -2.1, -2.8, -3.5, -4.3, -5.2, -6.2, -7.4, -8.8, -11.0, -17.0,
];

// Build a genre target curve on the analysis grid from broad adjustments (dB).
export function makeCurve(adj = {}) {
  const base = interpLogCurve(THIRD_OCTAVE_CENTRES, BASE_CURVE, ANALYSIS_GRID);
  const out = new Float64Array(ANALYSIS_GRID.length);
  for (let i = 0; i < ANALYSIS_GRID.length; i++) {
    const f = ANALYSIS_GRID[i];
    out[i] =
      base[i] +
      (adj.sub || 0) * logBump(f, 36, 2.0) +
      (adj.bass || 0) * logBump(f, 90, 1.8) +
      (adj.lowmid || 0) * logBump(f, 260, 1.8) +
      (adj.mid || 0) * logBump(f, 1000, 2.0) +
      (adj.presence || 0) * logBump(f, 3400, 1.8) +
      (adj.air || 0) * logRamp(f, 6500, 13000);
  }
  return out;
}

const space = (type, rt60, extra = {}) => ({ type, rt60, ...extra });

export const GENRES = [
  {
    id: 'modern-worship',
    name: 'Modern Worship',
    blurb: 'Wide, atmospheric and anthemic. Deep low end, shimmering pads and delays, vocal front and centre.',
    examples: 'Think Elevation Worship, Hillsong UNITED, Bethel Music',
    master: {
      lufs: -9, curve: { sub: 1, bass: 1.2, lowmid: -0.3, presence: 0.5, air: 1.5 },
      width: { low: -22, mid: -8, high: -6 }, bassMono: 120, warmth: 0.15, release: 120, clip: 3,
    },
    mix: {
      levels: {
        leadVocal: 0, bgv: -5, kick: -5, snare: -6, hats: -14, toms: -9, overheads: -11, room: -15, drumKit: -3,
        percussion: -13, bass: -5, subBass: -5, electricGuitar: -8, acousticGuitar: -8, piano: -7, organ: -11,
        synthPad: -8, synthLead: -10, strings: -10, brass: -11, fx: -13, backingTrack: -5, crowd: -16, other: -10,
      },
      comp: 1.0, eqStrength: 1.0, brightness: 1,
      sat: { bass: 0.2, subBass: 0.2, leadVocal: 0.1, kick: 0.1, snare: 0.1 },
      space: space('hall', 2.8, { preDelay: 0.025, size: 1.2, hfRatio: 0.55, er: 0.25 }),
      plate: { rt60: 2.0, preDelay: 0.045, damping: 0.2 },
      sends: {
        plate: { leadVocal: -13, bgv: -11, snare: -18, acousticGuitar: -22, piano: -20 },
        space: {
          leadVocal: -16, bgv: -12, synthPad: -12, electricGuitar: -14, acousticGuitar: -18, piano: -14,
          strings: -12, synthLead: -14, toms: -20, snare: -22, overheads: -24, organ: -16, brass: -16,
        },
        delay: { leadVocal: -18, electricGuitar: -20, synthLead: -20 },
      },
      delay: { note: '1/8d', feedback: 0.32 },
      bus: { glueGr: 1.5, ratio: 2, attack: 30, release: 150 },
      spread: 0.85,
    },
  },
  {
    id: 'live-worship',
    name: 'Live Worship',
    blurb: 'A live album sound: the room and the congregation are part of the mix, with honest dynamics.',
    examples: 'Think live records from Bethel, Elevation and Maverick City',
    master: {
      lufs: -10, curve: { sub: 0.5, bass: 1, presence: 0.3, air: 1 },
      width: { low: -20, mid: -7, high: -5 }, bassMono: 110, warmth: 0.15, release: 150, clip: 2,
    },
    mix: {
      levels: {
        leadVocal: 0, bgv: -5, kick: -5, snare: -6, hats: -14, toms: -9, overheads: -10, room: -12, drumKit: -3,
        percussion: -13, bass: -5, subBass: -6, electricGuitar: -8, acousticGuitar: -8, piano: -7, organ: -10,
        synthPad: -9, synthLead: -11, strings: -10, brass: -11, fx: -14, backingTrack: -6, crowd: -11, other: -10,
      },
      comp: 0.9, eqStrength: 0.9, brightness: 0.5,
      sat: { bass: 0.15, leadVocal: 0.1 },
      space: space('hall', 2.4, { preDelay: 0.02, size: 1.3, hfRatio: 0.5, er: 0.3 }),
      plate: { rt60: 1.8, preDelay: 0.04, damping: 0.25 },
      sends: {
        plate: { leadVocal: -15, bgv: -13, snare: -20 },
        space: {
          leadVocal: -18, bgv: -14, synthPad: -14, electricGuitar: -16, acousticGuitar: -20, piano: -16,
          strings: -13, synthLead: -16, toms: -22, organ: -18, brass: -18,
        },
        delay: { leadVocal: -20, electricGuitar: -22 },
      },
      delay: { note: '1/8d', feedback: 0.3 },
      bus: { glueGr: 1.2, ratio: 2, attack: 30, release: 180 },
      spread: 0.8,
    },
  },
  {
    id: 'gospel',
    name: 'Gospel',
    blurb: 'Punchy drums, big bass and Hammond, with the choir forward and bright.',
    examples: 'Think Kirk Franklin, Tye Tribbett, Maverick City Music',
    master: {
      lufs: -8.5, curve: { sub: 1.5, bass: 1.5, mid: 0.3, presence: 0.5, air: 1 },
      width: { low: -22, mid: -9, high: -7 }, bassMono: 120, warmth: 0.2, release: 110, clip: 3,
    },
    mix: {
      levels: {
        leadVocal: 0, bgv: -2, kick: -4, snare: -4, hats: -12, toms: -8, overheads: -11, room: -15, drumKit: -2,
        percussion: -12, bass: -4, subBass: -4, electricGuitar: -10, acousticGuitar: -11, piano: -7, organ: -7,
        synthPad: -11, synthLead: -10, strings: -11, brass: -8, fx: -15, backingTrack: -5, crowd: -15, other: -10,
      },
      comp: 1.1, eqStrength: 1.0, brightness: 1,
      sat: { bass: 0.25, organ: 0.2, kick: 0.1, snare: 0.15, leadVocal: 0.1 },
      space: space('chamber', 1.8, { preDelay: 0.02, size: 1.0, hfRatio: 0.55, er: 0.35 }),
      plate: { rt60: 1.7, preDelay: 0.04, damping: 0.25 },
      sends: {
        plate: { leadVocal: -15, bgv: -13, snare: -18 },
        space: { bgv: -14, organ: -18, piano: -18, strings: -14, brass: -16, leadVocal: -20 },
        delay: { leadVocal: -24 },
      },
      delay: { note: '1/8', feedback: 0.25 },
      bus: { glueGr: 2, ratio: 2, attack: 25, release: 120 },
      spread: 0.8,
    },
  },
  {
    id: 'acoustic-worship',
    name: 'Acoustic Worship',
    blurb: 'Intimate and warm. Natural dynamics, acoustic instruments and close vocals.',
    examples: 'Think Housefires, Rivers & Robots, All Sons & Daughters',
    master: {
      lufs: -11, curve: { sub: -3, bass: -1, lowmid: 0.8, mid: 0.3, presence: 0.3, air: 0.5 },
      width: { low: -22, mid: -9, high: -7 }, bassMono: 110, warmth: 0.2, release: 180, clip: 0,
    },
    mix: {
      levels: {
        leadVocal: 0, bgv: -6, kick: -8, snare: -9, hats: -16, toms: -12, overheads: -12, room: -14, drumKit: -6,
        percussion: -12, bass: -8, subBass: -10, electricGuitar: -11, acousticGuitar: -5, piano: -6, organ: -12,
        synthPad: -13, synthLead: -14, strings: -10, brass: -12, fx: -16, backingTrack: -7, crowd: -16, other: -9,
      },
      comp: 0.8, eqStrength: 0.85, brightness: 0.5,
      sat: { leadVocal: 0.1, bass: 0.1 },
      space: space('chamber', 1.6, { preDelay: 0.02, size: 0.9, hfRatio: 0.6, er: 0.35 }),
      plate: { rt60: 1.6, preDelay: 0.04, damping: 0.3 },
      sends: {
        plate: { leadVocal: -15, bgv: -13, acousticGuitar: -22 },
        space: { leadVocal: -20, bgv: -16, piano: -18, strings: -14, acousticGuitar: -22 },
        delay: { leadVocal: -26 },
      },
      delay: { note: '1/4', feedback: 0.22 },
      bus: { glueGr: 1.0, ratio: 1.8, attack: 30, release: 200 },
      spread: 0.75,
    },
  },
  {
    id: 'pop',
    name: 'Pop',
    blurb: 'Polished and vocal forward. Tight, punchy low end with a bright, glossy top.',
    examples: 'Think Taylor Swift, Dua Lipa, Ed Sheeran',
    master: {
      lufs: -8.5, curve: { sub: 1, bass: 0.8, lowmid: -0.5, presence: 0.6, air: 1.8 },
      width: { low: -24, mid: -9, high: -7 }, bassMono: 130, warmth: 0.1, release: 100, clip: 3,
    },
    mix: {
      levels: {
        leadVocal: 0, bgv: -6, kick: -4, snare: -5, hats: -13, toms: -10, overheads: -12, room: -16, drumKit: -3,
        percussion: -12, bass: -4, subBass: -3, electricGuitar: -9, acousticGuitar: -9, piano: -8, organ: -12,
        synthPad: -11, synthLead: -8, strings: -11, brass: -10, fx: -14, backingTrack: -5, crowd: -20, other: -10,
      },
      comp: 1.2, eqStrength: 1.1, brightness: 1.5,
      sat: { bass: 0.15, subBass: 0.2, leadVocal: 0.1 },
      space: space('chamber', 1.4, { preDelay: 0.02, size: 0.9, hfRatio: 0.6, er: 0.3 }),
      plate: { rt60: 1.6, preDelay: 0.06, damping: 0.15 },
      sends: {
        plate: { leadVocal: -16, bgv: -13, snare: -20 },
        space: { bgv: -18, synthPad: -16, piano: -18, synthLead: -18, strings: -16 },
        delay: { leadVocal: -20 },
      },
      delay: { note: '1/4', feedback: 0.25 },
      bus: { glueGr: 2, ratio: 2, attack: 30, release: 120 },
      spread: 0.85,
    },
  },
  {
    id: 'hip-hop',
    name: 'Hip-Hop / Trap',
    blurb: '808s that hit hard, crisp drums and an upfront, mostly dry vocal.',
    examples: 'Think Lecrae, Kendrick Lamar, Travis Scott',
    master: {
      lufs: -7.5, curve: { sub: 4, bass: 2.5, lowmid: -0.8, mid: -0.3, presence: 0.2, air: 0.8 },
      width: { low: -26, mid: -11, high: -8 }, bassMono: 140, warmth: 0.15, release: 80, clip: 4,
    },
    mix: {
      levels: {
        leadVocal: 0, bgv: -6, kick: -3, snare: -5, hats: -11, toms: -12, overheads: -14, room: -18, drumKit: -2,
        percussion: -11, bass: -3, subBass: -1, electricGuitar: -12, acousticGuitar: -12, piano: -9, organ: -12,
        synthPad: -12, synthLead: -8, strings: -11, brass: -10, fx: -13, backingTrack: -3, crowd: -20, other: -10,
      },
      comp: 1.3, eqStrength: 1.1, brightness: 1,
      sat: { subBass: 0.35, bass: 0.25, leadVocal: 0.15, kick: 0.15, snare: 0.1 },
      space: space('room', 0.9, { preDelay: 0.01, size: 0.7, hfRatio: 0.6, er: 0.3 }),
      plate: { rt60: 1.3, preDelay: 0.03, damping: 0.25 },
      sends: {
        plate: { leadVocal: -24, bgv: -18 },
        space: { bgv: -20, synthPad: -16, synthLead: -18, piano: -18 },
        delay: { leadVocal: -22, bgv: -22 },
      },
      delay: { note: '1/4', feedback: 0.22 },
      bus: { glueGr: 2.5, ratio: 2.5, attack: 20, release: 100 },
      spread: 0.8,
    },
  },
  {
    id: 'rnb',
    name: 'R&B / Soul',
    blurb: 'Smooth and warm with deep low end, silky vocals and lush space.',
    examples: 'Think H.E.R., Daniel Caesar, Brandy',
    master: {
      lufs: -9, curve: { sub: 2.5, bass: 2, lowmid: 0.3, mid: -0.3, presence: -0.5, air: 0.5 },
      width: { low: -24, mid: -9, high: -7 }, bassMono: 130, warmth: 0.25, release: 140, clip: 2,
    },
    mix: {
      levels: {
        leadVocal: 0, bgv: -5, kick: -4, snare: -6, hats: -14, toms: -11, overheads: -13, room: -17, drumKit: -3,
        percussion: -12, bass: -4, subBass: -3, electricGuitar: -10, acousticGuitar: -11, piano: -7, organ: -10,
        synthPad: -9, synthLead: -10, strings: -10, brass: -11, fx: -14, backingTrack: -4, crowd: -20, other: -10,
      },
      comp: 1.1, eqStrength: 1.0, brightness: 0,
      sat: { bass: 0.25, subBass: 0.25, leadVocal: 0.15, piano: 0.15 },
      space: space('hall', 2.2, { preDelay: 0.03, size: 1.1, hfRatio: 0.5, er: 0.25 }),
      plate: { rt60: 2.0, preDelay: 0.05, damping: 0.25 },
      sends: {
        plate: { leadVocal: -15, bgv: -11, snare: -18 },
        space: { leadVocal: -20, bgv: -13, synthPad: -13, piano: -16, strings: -13, electricGuitar: -18 },
        delay: { leadVocal: -22 },
      },
      delay: { note: '1/8d', feedback: 0.28 },
      bus: { glueGr: 1.5, ratio: 2, attack: 30, release: 150 },
      spread: 0.85,
    },
  },
  {
    id: 'rock',
    name: 'Rock',
    blurb: 'Guitars up, drums big and punchy, and a vocal that cuts through the wall.',
    examples: 'Think Foo Fighters, Switchfoot, Kings of Leon',
    master: {
      lufs: -8.5, curve: { sub: -1, lowmid: 0.8, mid: 1, presence: 1 },
      width: { low: -22, mid: -8, high: -7 }, bassMono: 120, warmth: 0.2, release: 100, clip: 3,
    },
    mix: {
      levels: {
        leadVocal: 0, bgv: -6, kick: -3, snare: -3, hats: -13, toms: -7, overheads: -9, room: -10, drumKit: -2,
        percussion: -13, bass: -5, subBass: -6, electricGuitar: -4, acousticGuitar: -10, piano: -10, organ: -10,
        synthPad: -13, synthLead: -11, strings: -12, brass: -11, fx: -15, backingTrack: -5, crowd: -18, other: -10,
      },
      comp: 1.1, eqStrength: 1.0, brightness: 0.5,
      sat: { bass: 0.3, snare: 0.15, kick: 0.15, leadVocal: 0.15, room: 0.3, toms: 0.1 },
      space: space('room', 1.1, { preDelay: 0.012, size: 0.8, hfRatio: 0.55, er: 0.5 }),
      plate: { rt60: 1.6, preDelay: 0.04, damping: 0.25 },
      sends: {
        plate: { leadVocal: -18, bgv: -15, snare: -16, toms: -20 },
        space: { overheads: -22, snare: -20, toms: -18, electricGuitar: -22, leadVocal: -24 },
        delay: { leadVocal: -22 },
      },
      delay: { note: '1/4', feedback: 0.22 },
      bus: { glueGr: 2, ratio: 2, attack: 20, release: 120 },
      spread: 0.95,
    },
  },
  {
    id: 'indie',
    name: 'Indie / Alternative',
    blurb: 'Character over polish: roomy drums, textured guitars and a vocal that feels close.',
    examples: 'Think The Lumineers, Bon Iver, Arcade Fire',
    master: {
      lufs: -9.5, curve: { sub: -1, bass: 0.3, lowmid: 0.8, mid: 0.3 },
      width: { low: -20, mid: -7, high: -6 }, bassMono: 110, warmth: 0.25, release: 140, clip: 2,
    },
    mix: {
      levels: {
        leadVocal: 0, bgv: -5, kick: -5, snare: -5, hats: -14, toms: -9, overheads: -9, room: -9, drumKit: -3,
        percussion: -11, bass: -6, subBass: -8, electricGuitar: -6, acousticGuitar: -7, piano: -7, organ: -10,
        synthPad: -10, synthLead: -10, strings: -10, brass: -10, fx: -13, backingTrack: -5, crowd: -16, other: -9,
      },
      comp: 0.9, eqStrength: 0.9, brightness: 0,
      sat: { room: 0.3, bass: 0.25, leadVocal: 0.2, piano: 0.2, kick: 0.15, snare: 0.15 },
      space: space('chamber', 1.8, { preDelay: 0.015, size: 1.0, hfRatio: 0.5, er: 0.45 }),
      plate: { rt60: 1.9, preDelay: 0.03, damping: 0.3 },
      sends: {
        plate: { leadVocal: -14, bgv: -12, snare: -18 },
        space: {
          leadVocal: -18, bgv: -14, piano: -16, electricGuitar: -16, acousticGuitar: -18, synthPad: -14,
          strings: -13, overheads: -22,
        },
        delay: { leadVocal: -22 },
      },
      delay: { note: '1/8', feedback: 0.3 },
      bus: { glueGr: 1.5, ratio: 2, attack: 30, release: 150 },
      spread: 0.85,
    },
  },
  {
    id: 'country',
    name: 'Country',
    blurb: 'Vocal forward and clear, crisp acoustic and electric guitars, punchy but natural.',
    examples: 'Think Chris Stapleton, Carrie Underwood, Zach Bryan',
    master: {
      lufs: -9, curve: { sub: -1.5, bass: -0.3, lowmid: 0.4, mid: 0.4, presence: 0.9, air: 1 },
      width: { low: -22, mid: -8, high: -7 }, bassMono: 110, warmth: 0.15, release: 120, clip: 2,
    },
    mix: {
      levels: {
        leadVocal: 0, bgv: -6, kick: -5, snare: -5, hats: -14, toms: -9, overheads: -11, room: -14, drumKit: -3,
        percussion: -13, bass: -6, subBass: -8, electricGuitar: -8, acousticGuitar: -7, piano: -9, organ: -12,
        synthPad: -14, synthLead: -13, strings: -11, brass: -12, fx: -16, backingTrack: -5, crowd: -18, other: -9,
      },
      comp: 1.0, eqStrength: 1.0, brightness: 1,
      sat: { bass: 0.2, leadVocal: 0.1 },
      space: space('room', 1.3, { preDelay: 0.015, size: 0.9, hfRatio: 0.55, er: 0.4 }),
      plate: { rt60: 1.7, preDelay: 0.05, damping: 0.25 },
      sends: {
        plate: { leadVocal: -16, bgv: -13, snare: -18 },
        space: { leadVocal: -22, electricGuitar: -18, acousticGuitar: -22, piano: -18, strings: -14, overheads: -24 },
        delay: { leadVocal: -22, electricGuitar: -20 },
      },
      delay: { note: '1/4', feedback: 0.25 },
      bus: { glueGr: 1.5, ratio: 2, attack: 30, release: 150 },
      spread: 0.85,
    },
  },
  {
    id: 'edm',
    name: 'EDM / Electronic',
    blurb: 'Massive sub, wide synths and a loud, dense master built for big systems.',
    examples: 'Think Avicii, Martin Garrix, Zedd',
    master: {
      lufs: -7, curve: { sub: 3.5, bass: 2, lowmid: -1, mid: -0.3, presence: 0.3, air: 1.8 },
      width: { low: -26, mid: -7, high: -5 }, bassMono: 140, warmth: 0.1, release: 70, clip: 4,
    },
    mix: {
      levels: {
        leadVocal: 0, bgv: -6, kick: -2, snare: -5, hats: -12, toms: -12, overheads: -14, room: -18, drumKit: -2,
        percussion: -11, bass: -3, subBass: -2, electricGuitar: -11, acousticGuitar: -12, piano: -9, organ: -12,
        synthPad: -8, synthLead: -5, strings: -10, brass: -10, fx: -10, backingTrack: -3, crowd: -20, other: -9,
      },
      comp: 1.3, eqStrength: 1.1, brightness: 1.5,
      sat: { subBass: 0.3, bass: 0.3, synthLead: 0.15, kick: 0.1 },
      space: space('hall', 2.6, { preDelay: 0.03, size: 1.2, hfRatio: 0.55, er: 0.2 }),
      plate: { rt60: 1.8, preDelay: 0.04, damping: 0.2 },
      sends: {
        plate: { leadVocal: -15, bgv: -12, snare: -16 },
        space: { synthPad: -12, synthLead: -16, leadVocal: -18, bgv: -14, piano: -16, fx: -14 },
        delay: { leadVocal: -18, synthLead: -18 },
      },
      delay: { note: '1/8d', feedback: 0.35 },
      bus: { glueGr: 3, ratio: 2.5, attack: 20, release: 100 },
      spread: 0.9,
    },
  },
  {
    id: 'folk',
    name: 'Folk / Singer-Songwriter',
    blurb: 'Honest and dynamic. The voice and the instrument, with just enough space.',
    examples: 'Think Phoebe Bridgers, Josh Garrels, Gregory Alan Isakov',
    master: {
      lufs: -12, curve: { sub: -3.5, bass: -1.5, lowmid: 1, mid: 0.5, presence: 0.4, air: 0.3 },
      width: { low: -20, mid: -8, high: -7 }, bassMono: 100, warmth: 0.2, release: 200, clip: 0,
    },
    mix: {
      levels: {
        leadVocal: 0, bgv: -6, kick: -8, snare: -9, hats: -16, toms: -12, overheads: -12, room: -13, drumKit: -6,
        percussion: -11, bass: -8, subBass: -11, electricGuitar: -9, acousticGuitar: -4, piano: -5, organ: -11,
        synthPad: -13, synthLead: -14, strings: -9, brass: -11, fx: -16, backingTrack: -7, crowd: -16, other: -8,
      },
      comp: 0.75, eqStrength: 0.8, brightness: 0.3,
      sat: { leadVocal: 0.1, acousticGuitar: 0.05 },
      space: space('chamber', 1.7, { preDelay: 0.02, size: 0.95, hfRatio: 0.55, er: 0.35 }),
      plate: { rt60: 1.7, preDelay: 0.04, damping: 0.3 },
      sends: {
        plate: { leadVocal: -16, bgv: -14 },
        space: { leadVocal: -20, acousticGuitar: -22, piano: -18, strings: -14, bgv: -16 },
        delay: { leadVocal: -28 },
      },
      delay: { note: '1/4', feedback: 0.2 },
      bus: { glueGr: 0.8, ratio: 1.6, attack: 30, release: 200 },
      spread: 0.75,
    },
  },
  {
    id: 'jazz',
    name: 'Jazz',
    blurb: 'Natural and dynamic: a true stereo picture of a band in a room, minimal compression.',
    examples: 'Think Norah Jones, Esperanza Spalding, Snarky Puppy',
    master: {
      lufs: -14, curve: { sub: -3, bass: -1, lowmid: 1.2, mid: 0.5, presence: -0.5, air: -0.8 },
      width: { low: -18, mid: -6, high: -5 }, bassMono: 90, warmth: 0.15, release: 250, clip: 0,
    },
    mix: {
      levels: {
        leadVocal: 0, bgv: -6, kick: -8, snare: -8, hats: -13, toms: -10, overheads: -7, room: -10, drumKit: -4,
        percussion: -10, bass: -4, subBass: -8, electricGuitar: -6, acousticGuitar: -6, piano: -4, organ: -6,
        synthPad: -12, synthLead: -10, strings: -8, brass: -4, fx: -16, backingTrack: -5, crowd: -16, other: -6,
      },
      comp: 0.5, eqStrength: 0.6, brightness: -0.5,
      sat: { bass: 0.05 },
      space: space('room', 1.3, { preDelay: 0.012, size: 0.9, hfRatio: 0.6, er: 0.5 }),
      plate: { rt60: 1.6, preDelay: 0.03, damping: 0.3 },
      sends: {
        plate: { leadVocal: -18, brass: -22 },
        space: {
          leadVocal: -22, piano: -20, brass: -18, overheads: -22, strings: -16, acousticGuitar: -20,
          electricGuitar: -20,
        },
        delay: {},
      },
      delay: { note: '1/4', feedback: 0.2 },
      bus: { glueGr: 0.6, ratio: 1.5, attack: 40, release: 250 },
      spread: 0.8,
    },
  },
  {
    id: 'cinematic',
    name: 'Cinematic / Ambient',
    blurb: 'Huge spaces, wide stereo and real dynamics. Built to swell.',
    examples: 'Think Hans Zimmer, Ólafur Arnalds, M83',
    master: {
      lufs: -14, curve: { sub: 1, bass: 0.5, mid: -0.3, presence: -0.3, air: 0.8 },
      width: { low: -20, mid: -5, high: -4 }, bassMono: 100, warmth: 0.1, release: 220, clip: 0,
    },
    mix: {
      levels: {
        leadVocal: 0, bgv: -4, kick: -6, snare: -8, hats: -15, toms: -6, overheads: -12, room: -12, drumKit: -4,
        percussion: -8, bass: -6, subBass: -5, electricGuitar: -8, acousticGuitar: -8, piano: -4, organ: -8,
        synthPad: -4, synthLead: -8, strings: -3, brass: -5, fx: -7, backingTrack: -4, crowd: -14, other: -7,
      },
      comp: 0.6, eqStrength: 0.8, brightness: 0.5,
      sat: {},
      space: space('cathedral', 4.2, { preDelay: 0.04, size: 1.5, hfRatio: 0.45, er: 0.15 }),
      plate: { rt60: 2.6, preDelay: 0.05, damping: 0.2 },
      sends: {
        plate: { leadVocal: -13, bgv: -10 },
        space: {
          synthPad: -8, strings: -9, piano: -11, brass: -11, toms: -14, percussion: -14, leadVocal: -13,
          bgv: -10, electricGuitar: -12, fx: -10,
        },
        delay: { leadVocal: -20, piano: -22 },
      },
      delay: { note: '1/4', feedback: 0.35 },
      bus: { glueGr: 1.0, ratio: 1.8, attack: 40, release: 250 },
      spread: 0.95,
    },
  },
  {
    id: 'lofi',
    name: 'Lo-fi / Chill',
    blurb: 'Warm, soft and a little dusty: rolled off highs, gentle transients and tape character.',
    examples: 'Think Tom Misch, FKJ and chill beat playlists',
    master: {
      lufs: -11, curve: { sub: 0.5, bass: 1.5, lowmid: 1.5, presence: -2.5, air: -5 },
      width: { low: -22, mid: -9, high: -8 }, bassMono: 120, warmth: 0.45, release: 180, clip: 1.5,
    },
    mix: {
      levels: {
        leadVocal: 0, bgv: -5, kick: -4, snare: -6, hats: -14, toms: -10, overheads: -12, room: -12, drumKit: -3,
        percussion: -10, bass: -4, subBass: -4, electricGuitar: -7, acousticGuitar: -7, piano: -4, organ: -8,
        synthPad: -8, synthLead: -8, strings: -9, brass: -9, fx: -12, backingTrack: -4, crowd: -16, other: -7,
      },
      comp: 1.0, eqStrength: 0.8, brightness: -2,
      sat: {
        leadVocal: 0.25, bass: 0.3, subBass: 0.3, piano: 0.35, electricGuitar: 0.25, kick: 0.3, snare: 0.3,
        drumKit: 0.35, synthPad: 0.25, other: 0.25,
      },
      space: space('room', 1.2, { preDelay: 0.015, size: 0.85, hfRatio: 0.35, er: 0.4 }),
      plate: { rt60: 1.6, preDelay: 0.03, damping: 0.5 },
      sends: {
        plate: { leadVocal: -16, piano: -20 },
        space: { piano: -16, electricGuitar: -16, synthPad: -14, leadVocal: -20 },
        delay: { leadVocal: -22 },
      },
      delay: { note: '1/8d', feedback: 0.3 },
      bus: { glueGr: 2, ratio: 2, attack: 30, release: 150 },
      spread: 0.8,
    },
  },
  {
    id: 'metal',
    name: 'Metal / Heavy',
    blurb: 'Tight low end, a wall of guitars, cutting drums and a dense, loud master.',
    examples: 'Think Metallica, Bring Me The Horizon, Sleep Token',
    master: {
      lufs: -7.5, curve: { sub: -0.5, bass: 0.5, lowmid: -0.8, mid: 0.3, presence: 1.5, air: 0.3 },
      width: { low: -24, mid: -7, high: -6 }, bassMono: 130, warmth: 0.15, release: 70, clip: 4,
    },
    mix: {
      levels: {
        leadVocal: 0, bgv: -6, kick: -2, snare: -2, hats: -13, toms: -6, overheads: -10, room: -12, drumKit: -2,
        percussion: -14, bass: -4, subBass: -6, electricGuitar: -2, acousticGuitar: -11, piano: -11, organ: -12,
        synthPad: -12, synthLead: -10, strings: -10, brass: -12, fx: -14, backingTrack: -4, crowd: -18, other: -10,
      },
      comp: 1.2, eqStrength: 1.0, brightness: 0.5,
      sat: { bass: 0.35, snare: 0.15, kick: 0.1 },
      space: space('room', 1.0, { preDelay: 0.01, size: 0.8, hfRatio: 0.55, er: 0.45 }),
      plate: { rt60: 1.5, preDelay: 0.04, damping: 0.25 },
      sends: {
        plate: { leadVocal: -18, snare: -18, toms: -20 },
        space: { leadVocal: -22, snare: -22, overheads: -24 },
        delay: { leadVocal: -22 },
      },
      delay: { note: '1/4', feedback: 0.2 },
      bus: { glueGr: 2.5, ratio: 2.5, attack: 15, release: 100 },
      spread: 1.0,
    },
  },
];

export function getGenre(id) {
  return GENRES.find((g) => g.id === id) || GENRES[0];
}

const curveCache = new Map();
export function genreCurve(genre) {
  let c = curveCache.get(genre.id);
  if (!c) {
    c = makeCurve(genre.master.curve);
    curveCache.set(genre.id, c);
  }
  return c;
}
