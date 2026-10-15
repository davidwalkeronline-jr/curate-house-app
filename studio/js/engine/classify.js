// Stem role detection from file names (the most reliable signal in real
// sessions) with an audio feature fallback, plus detection of sub roles
// (kick in/out, snare top/bottom, doubles), left/right pairs and ordering.

export const ROLES = {
  leadVocal: { label: 'Lead Vocal', family: 'vocals' },
  bgv: { label: 'Backing Vocals', family: 'vocals' },
  kick: { label: 'Kick', family: 'drums' },
  snare: { label: 'Snare', family: 'drums' },
  hats: { label: 'Hi-Hat / Cymbals', family: 'drums' },
  toms: { label: 'Toms', family: 'drums' },
  overheads: { label: 'Overheads', family: 'drums' },
  room: { label: 'Drum Room', family: 'drums' },
  drumKit: { label: 'Drum Kit (full)', family: 'drums' },
  percussion: { label: 'Percussion', family: 'drums' },
  bass: { label: 'Bass', family: 'bass' },
  subBass: { label: '808 / Sub Bass', family: 'bass' },
  electricGuitar: { label: 'Electric Guitar', family: 'guitars' },
  acousticGuitar: { label: 'Acoustic Guitar', family: 'guitars' },
  piano: { label: 'Piano / Keys', family: 'keys' },
  organ: { label: 'Organ', family: 'keys' },
  synthPad: { label: 'Pad / Synth', family: 'keys' },
  synthLead: { label: 'Synth Lead / Arp', family: 'keys' },
  strings: { label: 'Strings', family: 'orchestral' },
  brass: { label: 'Brass / Winds', family: 'orchestral' },
  fx: { label: 'FX / Ambience', family: 'fx' },
  backingTrack: { label: 'Backing Track / Loop', family: 'tracks' },
  crowd: { label: 'Crowd / Audience', family: 'fx' },
  other: { label: 'Other Instrument', family: 'other' },
  click: { label: 'Click (muted)', family: 'utility' },
  guide: { label: 'Guide / Cues (muted)', family: 'utility' },
};

export const ROLE_ORDER = [
  'leadVocal', 'bgv', 'kick', 'snare', 'hats', 'toms', 'overheads', 'room', 'drumKit', 'percussion',
  'bass', 'subBass', 'electricGuitar', 'acousticGuitar', 'piano', 'organ', 'synthPad', 'synthLead',
  'strings', 'brass', 'fx', 'backingTrack', 'crowd', 'other', 'click', 'guide',
];

// Normalise a file name into lower case tokens. Splits camelCase, digits and
// separators: "LeadVox_Dbl2.wav" -> ["lead", "vox", "dbl", "2"].
export function tokenize(name) {
  const base = name.replace(/\.[a-z0-9]{2,5}$/i, '');
  const spaced = base
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .replace(/(\d)([A-Za-z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return spaced ? spaced.split(' ') : [];
}

// Rules: [role, weight, tokens | phrases]. A phrase "a b" matches adjacent
// tokens or the joined form "ab".
const RULES = [
  ['click', 10, ['click', 'clk', 'metronome', 'metro', 'met', 'clicktrack']],
  ['guide', 9, ['guide', 'guides', 'cue', 'cues', 'countin', 'count', 'counts', 'talkback', 'spoken', 'vocal guide', 'scratch']],
  ['kick', 8, ['kick', 'kik', 'kck', 'kic', 'bd', 'bass drum', 'bassdrum', 'subkick', 'sub kick', 'kickin', 'kickout']],
  ['snare', 8, ['snare', 'snr', 'sn', 'sd', 'snaretop', 'snarebottom', 'snarebot']],
  ['hats', 7, ['hat', 'hats', 'hihat', 'hi hat', 'hh', 'hhat', 'ride', 'crash', 'cymbal', 'cymbals', 'cym', 'china', 'splash']],
  ['toms', 7, ['tom', 'toms', 'floortom', 'floor tom', 'racktom', 'rack tom', 'rack', 'ft', 'hitom', 'lotom', 'midtom']],
  ['overheads', 7, ['oh', 'ohs', 'ovh', 'ovhd', 'ohd', 'overhead', 'overheads', 'ohl', 'ohr']],
  ['room', 5, ['room', 'rooms', 'rm', 'kitroom', 'drumroom', 'drum room', 'trash', 'mono room']],
  ['crowd', 6, ['crowd', 'audience', 'aud', 'amb', 'ambience', 'ambient mic', 'congregation', 'cong', 'house mic']],
  ['percussion', 6, ['perc', 'percussion', 'shaker', 'shk', 'tamb', 'tambourine', 'conga', 'congas', 'bongo', 'bongos', 'cajon', 'clap', 'claps', 'snap', 'snaps', 'cowbell', 'timbales', 'djembe', 'triangle', 'guiro', 'chimes', 'glock', 'glockenspiel', 'woodblock', 'tabla']],
  ['subBass', 7, ['808', '808s', 'sub', 'subbass', 'sub bass', 'subs']],
  ['acousticGuitar', 7, ['ag', 'acoustic', 'acou', 'acgtr', 'ac gtr', 'aco', 'acous', 'nylon', 'steel string', 'uke', 'ukulele', 'mandolin', 'banjo', '12 string', 'agtr']],
  ['bass', 6, ['bass', 'bs', 'bas', 'bassdi', 'bass di', 'bassamp', 'bass amp', 'upright', 'ubass', 'synthbass', 'synth bass', 'basssynth', 'bgtr', 'bass gtr']],
  ['electricGuitar', 5, ['gtr', 'gtrs', 'guitar', 'guitars', 'guit', 'egtr', 'eg', 'elec', 'electric', 'rhythm', 'rhy', 'crunch', 'dist', 'tele', 'strat', 'lp', 'ebow', 'leadgtr', 'lead gtr', 'gtr lead']],
  ['organ', 6, ['organ', 'b3', 'hammond', 'leslie', 'org']],
  ['piano', 5, ['piano', 'pno', 'pian', 'keys', 'key', 'kbd', 'keyboard', 'keyboards', 'rhodes', 'wurli', 'wurlitzer', 'ep', 'epiano', 'e piano', 'grand', 'nord', 'clav', 'upright piano', 'keys 1', 'pianos']],
  ['synthPad', 5, ['pad', 'pads', 'synth', 'synths', 'syn', 'atmos', 'atmosphere', 'swell', 'swells', 'texture', 'textures', 'drone', 'ambient', 'string pad', 'warm pad', 'choir pad']],
  ['synthLead', 5, ['arp', 'arps', 'pluck', 'plucks', 'seq', 'sequence', 'sequencer', 'synth lead', 'synthlead', 'bell', 'bells', 'lead synth', 'leadsynth', 'hook']],
  ['strings', 6, ['str', 'strings', 'string', 'vln', 'violin', 'violins', 'vla', 'viola', 'violas', 'cello', 'cellos', 'vc', 'orch', 'orchestra', 'orchestral', 'ensemble', 'ens', 'quartet', 'contrabass']],
  ['brass', 6, ['brass', 'horn', 'horns', 'tpt', 'trumpet', 'trumpets', 'tbn', 'trombone', 'sax', 'saxophone', 'flute', 'flutes', 'clarinet', 'winds', 'woodwind', 'woodwinds', 'oboe', 'bassoon', 'tuba', 'french horn', 'flugel', 'flugelhorn']],
  ['bgv', 7, ['bgv', 'bgvs', 'bv', 'bvs', 'bgvox', 'backing vocal', 'backing vocals', 'backing vox', 'backups', 'backup', 'harm', 'harmony', 'harmonies', 'choir', 'gang', 'gang vox', 'alto', 'tenor', 'soprano', 'sop', 'baritone', 'adlib', 'adlibs', 'ad lib', 'ad libs', 'ooh', 'oohs', 'aah', 'aahs', 'stack', 'stacks', 'group vocal', 'group vox', 'background', 'bkg', 'bg', 'bgs', 'vocal stack', 'response']],
  ['leadVocal', 6, ['vox', 'vocal', 'vocals', 'voc', 'vcl', 'lv', 'ld', 'lead', 'leadvox', 'lead vox', 'leadvocal', 'lead vocal', 'singer', 'mainvox', 'main vox', 'main vocal', 'wl', 'worship leader', 'rap', 'verse vox', 'hook vox']],
  ['fx', 6, ['fx', 'sfx', 'efx', 'effect', 'effects', 'riser', 'risers', 'impact', 'impacts', 'sweep', 'sweeps', 'whoosh', 'noise', 'uplifter', 'downlifter', 'reverse', 'verb', 'reverb', 'delay', 'dly', 'throw', 'throws', 'transition', 'transitions', 'boom', 'hit', 'hits']],
  ['backingTrack', 5, ['tracks', 'backing track', 'backingtrack', 'bt', 'playback', 'pb', 'instrumental', 'inst', 'beat', 'loop', 'loops', 'sample', 'samples', 'mtk', 'multitrack', 'stem mix', 'mix stem', 'karaoke']],
  ['drumKit', 4, ['drums', 'drum', 'kit', 'drumbus', 'drum bus', 'drumkit', 'drm', 'drms', 'drumloop', 'drum loop', 'percussion bus']],
];

const DAW_DEFAULT = /^(audio|track|trk|channel|ch|input|in|bounce|untitled|mix|stem|new|recording|rec)\s*\d*$/;

function matchPhrase(tokens, joined, phrase) {
  if (!phrase.includes(' ')) {
    return tokens.includes(phrase);
  }
  const parts = phrase.split(' ');
  for (let i = 0; i + parts.length <= tokens.length; i++) {
    let ok = true;
    for (let k = 0; k < parts.length; k++) if (tokens[i + k] !== parts[k]) { ok = false; break; }
    if (ok) return true;
  }
  return joined.includes(parts.join(''));
}

export function nameScores(name) {
  const tokens = tokenize(name);
  const joined = tokens.join('');
  const scores = {};
  for (const [role, w, phrases] of RULES) {
    for (const ph of phrases) {
      if (matchPhrase(tokens, joined, ph)) {
        scores[role] = Math.max(scores[role] || 0, w + (ph.includes(' ') ? 2 : 0));
      }
    }
  }
  // Context fixes for ambiguous words.
  const has = (t) => tokens.includes(t);
  if (scores.subBass && (scores.kick || has('kick'))) delete scores.subBass; // "sub kick"
  if (scores.bass && scores.kick && (has('drum') || joined.includes('bassdrum'))) delete scores.bass;
  if (scores.leadVocal && (scores.electricGuitar || has('gtr') || has('guitar'))) delete scores.leadVocal; // lead guitar
  if (scores.leadVocal && (has('synth') || has('arp'))) delete scores.leadVocal; // lead synth
  if (scores.bgv && scores.brass && (has('sax'))) delete scores.bgv; // tenor sax
  if (scores.bgv && scores.leadVocal) scores.bgv += 3; // "vox harm 1" is a backing part
  if (scores.fx && scores.leadVocal && (has('verb') || has('reverb') || has('delay') || has('dly') || has('throw') || has('throws'))) {
    scores.fx += 4; // printed vocal effects return
  }
  if (scores.drumKit && (scores.kick || scores.snare || scores.toms || scores.hats || scores.overheads || scores.room)) {
    delete scores.drumKit; // "drum room", "kick drum"
  }
  if (scores.room && scores.crowd) delete scores.room;
  if (scores.piano && scores.synthPad && has('pad')) delete scores.piano; // "keys pad"
  if (scores.strings && scores.synthPad && has('pad')) delete scores.strings; // "string pad"
  if (scores.bass && scores.acousticGuitar && (has('di') || has('ag'))) delete scores.bass;
  if (scores.bass && scores.strings && has('contrabass')) delete scores.bass;
  if (scores.backingTrack && scores.drumKit) delete scores.backingTrack;
  if (scores.guide && scores.leadVocal && !has('guide') && !has('scratch')) delete scores.guide;
  return { scores, tokens, isDefaultName: DAW_DEFAULT.test(tokens.join(' ')) };
}

// Audio feature based scores (weak evidence, used when the name says
// nothing useful).
export function featureScores(f) {
  const s = {};
  if (!f || f.silent) return s;
  const low = f.bands.sub + f.bands.bass;
  const hi = f.bands.high + f.bands.air;
  const perc = f.onsets.percussive;
  const act = f.activity.ratio;
  const stereo = f.channels > 1 && f.stereo.kind === 'stereo';
  if (f.onsets.periodicity > 0.75 && perc > 0.6 && act > 0.5 && f.onsets.rate > 0.8) s.click = 3.5;
  if (low > 0.6 && perc > 0.55) s.kick = 3;
  if (low > 0.55 && perc < 0.45) s.bass = 3;
  if (low > 0.75 && f.bands.sub > 0.3 && perc < 0.6) s.subBass = 2.5;
  if (hi > 0.55 && perc > 0.4) s.hats = 3;
  if (perc > 0.55 && low < 0.35 && f.centroid > 700 && f.centroid < 4500 && hi < 0.5) s.snare = 2.2;
  if (stereo && perc > 0.4 && low > 0.2 && hi > 0.15) s.drumKit = 2;
  if (perc < 0.35 && act > 0.6 && f.crestDb < 18) s.synthPad = 2;
  if (perc < 0.45 && act > 0.15 && act < 0.85 && f.centroid > 500 && f.centroid < 3000 && low < 0.3) s.leadVocal = 1.8;
  if (stereo && act > 0.8 && low > 0.15 && hi > 0.05 && perc < 0.5) s.backingTrack = 1.6;
  s.other = 1.5;
  return s;
}

const SUB_PATTERNS = {
  inside: ['in', 'inside', 'beater', 'kickin'],
  outside: ['out', 'outside', 'reso', 'front', 'kickout'],
  sub: ['sub', 'subkick', 'nskick'],
  top: ['top', 'up', 'upper', 'snaretop'],
  bottom: ['bottom', 'bot', 'btm', 'under', 'snarebottom', 'snarebot', 'wires'],
  double: ['dbl', 'double', 'doubles', 'dub', 'dbls', 'doubled', 'octave', 'oct'],
  di: ['di', 'direct', 'dry'],
  amp: ['amp', 'cab', 'mic', 'mic d', 'micd'],
  left: ['l', 'left', 'lt', 'lft'],
  right: ['r', 'right', 'rt', 'rgt'],
};

export function subRoleHints(tokens) {
  const t = new Set(tokens);
  const hints = {};
  for (const [k, list] of Object.entries(SUB_PATTERNS)) hints[k] = list.some((w) => t.has(w));
  const nums = tokens.filter((x) => /^\d+$/.test(x)).map(Number);
  hints.number = nums.length ? nums[nums.length - 1] : null;
  return hints;
}

// Classify one stem. Returns { role, confidence (0..1), source, hints }.
export function classifyStem(name, features) {
  const { scores: ns, tokens, isDefaultName } = nameScores(name);
  const hints = subRoleHints(tokens);
  let best = null;
  let bestScore = 0;
  let second = 0;
  for (const [role, sc] of Object.entries(ns)) {
    if (sc > bestScore) {
      second = bestScore;
      bestScore = sc;
      best = role;
    } else if (sc > second) second = sc;
  }
  if (best && !isDefaultName) {
    const confidence = Math.min(0.97, 0.7 + 0.04 * (bestScore - second));
    return { role: refineRole(best, features), confidence, source: 'name', hints };
  }
  const fs = featureScores(features);
  let fb = 'other';
  let fbs = 0;
  let fs2 = 0;
  for (const [role, sc] of Object.entries(fs)) {
    if (sc > fbs) {
      fs2 = fbs;
      fbs = sc;
      fb = role;
    } else if (sc > fs2) fs2 = sc;
  }
  return {
    role: fb,
    confidence: Math.min(0.6, 0.3 + 0.1 * (fbs - fs2)),
    source: 'audio',
    hints,
  };
}

// Audio sanity checks on top of a name match.
function refineRole(role, f) {
  if (!f || f.silent) return role;
  // A stereo "drums" stem stays a kit; a mono one named drums is likely a kit
  // mic or loop; keep as kit.
  if (role === 'bass' && f.bands.sub > 0.45 && f.bands.sub + f.bands.bass > 0.85) return 'subBass';
  return role;
}

// Pair up stems that are two halves of one stereo source, bounced as two
// mono files ("Keys L" + "Keys R", "OH L"/"OH R", "Gtr Left"/"Gtr Right").
export function findLrPairs(stems) {
  const key = (s) =>
    tokenize(s.name)
      .filter((t) => !SUB_PATTERNS.left.includes(t) && !SUB_PATTERNS.right.includes(t))
      .join(' ');
  const pairs = [];
  const used = new Set();
  for (const a of stems) {
    if (used.has(a.id) || !a.hints?.left) continue;
    for (const b of stems) {
      if (used.has(b.id) || a === b || !b.hints?.right) continue;
      if (a.role === b.role && key(a) === key(b)) {
        pairs.push([a.id, b.id]);
        used.add(a.id);
        used.add(b.id);
        break;
      }
    }
  }
  return pairs;
}
