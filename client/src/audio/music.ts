/**
 * Adaptive procedural score: a 16th-note step sequencer in D minor.
 *
 * States: menu (sparse bells over a pad), calm (draft / doors interlude), combat, elite (more drive),
 * boss (most intense, three phases). Changing state crossfades two concurrently running tracks.
 * Every state walks a 16-bar chord cycle, alternates A/B sections and uses hashed per-bar variation,
 * so nothing repeats exactly for well over 32 bars. Victory / defeat are one-shot stingers.
 */
import { MIX, midiToHz, noise, tone, type AudioGraph } from './engine.ts';

export type MusicState = 'none' | 'menu' | 'calm' | 'combat' | 'elite' | 'boss';

export const MUSIC = {
  CROSSFADE: 1.5,
  STINGER_FADE: 0.5,
  /** Scheduler look-ahead (s) and timer period (ms). */
  LOOKAHEAD: 0.14,
  TICK_MS: 25,
  START_DELAY: 0.08,
  /** A track that fell this far behind (tab was throttled) skips ahead instead of bursting. */
  MAX_LAG: 0.3,
  STEPS_PER_BAR: 16,
  STEPS_PER_BEAT: 4,
  BARS_PER_CYCLE: 16,
  MAX_BOSS_PHASE: 3,
  STINGER_SECONDS: 4.6,
} as const;

/** D2. Everything is expressed as scale degrees of D natural minor above it. */
const TONIC = 38;
const SCALE = [0, 2, 3, 5, 7, 8, 10];
const OCTAVE = 12;

interface Chord {
  /** Scale degree of the root (0 = i, 2 = III, 3 = iv, 4 = v, 5 = VI, 6 = VII). */
  root: number;
  /** Raise the leading tone (major V). */
  sharp7?: boolean;
}

const I: Chord = { root: 0 };
const II: Chord = { root: 1 };
const III: Chord = { root: 2 };
const IV: Chord = { root: 3 };
const Vm: Chord = { root: 4 };
const V: Chord = { root: 4, sharp7: true };
const VI: Chord = { root: 5 };
const VII: Chord = { root: 6 };

const PROGRESSION: Record<Exclude<MusicState, 'none'>, Chord[]> = {
  menu: [I, I, VI, VI, IV, IV, I, I, III, III, VII, VII, IV, IV, V, V],
  calm: [I, VI, III, VII, I, VI, IV, V, I, III, VI, VII, IV, I, IV, V],
  combat: [I, I, VI, VII, I, I, IV, Vm, I, VI, III, VII, IV, IV, V, V],
  elite: [I, I, II, V, I, I, VI, V, IV, IV, I, I, VI, VII, V, V],
  boss: [I, I, I, I, VI, VI, V, V, I, I, IV, IV, II, II, V, V],
};

/** Semitones above TONIC for `offset` scale steps above the chord root, `octave` octaves up. */
function note(chord: Chord, offset: number, octave: number): number {
  const d = chord.root + offset;
  const index = ((d % SCALE.length) + SCALE.length) % SCALE.length;
  const raise = chord.sharp7 && index === SCALE.length - 1 ? 1 : 0;
  return TONIC + SCALE[index] + raise + OCTAVE * (Math.floor(d / SCALE.length) + octave);
}

const TRIAD = [0, 2, 4];

/** Deterministic 0..1 hash: the same bar always gets the same variation. */
function rnd(a: number, b: number): number {
  let x = Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263);
  x = Math.imul(x ^ (x >>> 13), 1274126177);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

const _ = null;
/** Lead phrases: scale steps above the chord root per 16th, null = rest. */
const PHRASES: (number | null)[][] = [
  [7, _, _, 4, _, _, 2, _, 4, _, _, _, 2, _, 0, _],
  [0, _, 2, _, 4, _, _, 7, _, _, 6, _, 4, _, _, _],
  [4, _, _, _, _, _, 4, 5, 4, _, 2, _, _, _, _, _],
  [7, _, 8, _, 7, _, 4, _, _, _, 2, _, 4, _, _, _],
];
const KICKS = [[0, 6, 8], [0, 3, 8, 10], [0, 6, 8], [0, 6, 8, 11, 14]];
const BASS_A = [1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 0, 0];
const BASS_B = [1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 0, 1, 0, 1, 1, 0];
const DRIVE_OFFSETS = [0, 0, 7, 0, 0, 0, 7, 0, 0, 7, 0, 0, 7, 0, 0, 4];
const ARP_A = [0, 2, 4, 7, 4, 2, 9, 4];
const ARP_B = [0, 4, 7, 9, 7, 4, 2, 4];
const RUN_ARP = [0, 2, 4, 7, 4, 2];
const BELL_STEPS = [0, 2, 4, 7, 9, 11];
const FILL_TOMS = [57, 55, 53, 50];

type Kit = ReturnType<typeof createKit>;

function createKit(g: AudioGraph, out: AudioNode) {
  return {
    kick(t: number, gain: number): void {
      tone(g, out, t, { freq: 150, freqEnd: 42, dur: 0.24, gain });
      tone(g, out, t, { type: 'triangle', freq: 1100, freqEnd: 300, dur: 0.016, gain: gain * 0.3 });
    },
    snare(t: number, gain: number): void {
      noise(g, out, t, { dur: 0.15, gain, filter: 'bandpass', freq: 1700, q: 0.7, send: 0.15 });
      tone(g, out, t, { type: 'triangle', freq: 200, freqEnd: 130, dur: 0.1, gain: gain * 0.7 });
    },
    hat(t: number, gain: number, open = false): void {
      noise(g, out, t, { dur: open ? 0.17 : 0.035, gain, filter: 'highpass', freq: 7800 });
    },
    tom(t: number, midi: number, gain: number): void {
      const f = midiToHz(midi);
      tone(g, out, t, { freq: f * 1.5, freqEnd: f * 0.8, dur: 0.28, gain, send: 0.2 });
    },
    bass(t: number, midi: number, dur: number, gain: number, cutoff: number): void {
      const f = midiToHz(midi);
      tone(g, out, t, { type: 'sawtooth', freq: f, dur, gain, lpf: cutoff * 2.6, lpfEnd: cutoff, q: 2.2 });
      tone(g, out, t, { freq: f, dur, gain: gain * 0.7 });
    },
    pad(t: number, midis: number[], dur: number, gain: number, cutoff: number): void {
      const attack = Math.min(1.2, dur * 0.35);
      for (const m of midis) {
        for (const detune of [-7, 7]) {
          tone(g, out, t, {
            type: 'sawtooth', freq: midiToHz(m), detune, dur: dur * 1.2, gain, attack, hold: dur * 0.4, lpf: cutoff, send: 0.35,
          });
        }
      }
    },
    lead(t: number, midi: number, dur: number, gain: number, bright: number): void {
      const f = midiToHz(midi);
      tone(g, out, t, { type: 'square', freq: f, dur, gain: gain * 0.55, lpf: bright, lpfEnd: bright * 0.5, attack: 0.008, send: 0.3 });
      tone(g, out, t, { type: 'triangle', freq: f, dur, gain, attack: 0.008, send: 0.3 });
    },
    bell(t: number, midi: number, gain: number): void {
      const f = midiToHz(midi);
      tone(g, out, t, { freq: f, dur: 2.6, gain, send: 0.6 });
      tone(g, out, t, { freq: f * 2.76, dur: 1.1, gain: gain * 0.28, send: 0.4 });
      tone(g, out, t, { freq: f * 5.4, dur: 0.5, gain: gain * 0.1 });
    },
    pluck(t: number, midi: number, gain: number): void {
      tone(g, out, t, { type: 'triangle', freq: midiToHz(midi), dur: 0.34, gain, lpf: 2600, lpfEnd: 500, send: 0.35 });
    },
    stab(t: number, midis: number[], gain: number): void {
      for (const m of midis) tone(g, out, t, { type: 'sawtooth', freq: midiToHz(m), dur: 0.15, gain, lpf: 1900, lpfEnd: 600 });
    },
    drone(t: number, midi: number, dur: number, gain: number): void {
      tone(g, out, t, { freq: midiToHz(midi), dur: dur * 1.15, gain, attack: Math.min(0.8, dur * 0.3), hold: dur * 0.5 });
    },
  };
}

interface StepCtx {
  kit: Kit;
  bar: number;
  /** Step inside the bar, 0..15. */
  s: number;
  t: number;
  /** Step duration (s). */
  sd: number;
  chord: Chord;
  /** 0 = A section, 1 = B section (flips every 16 bars). */
  section: number;
  phase: number;
}

interface TrackDef {
  gain: number;
  bpm(phase: number): number;
  step(c: StepCtx): void;
}

const chordPad = (chord: Chord, octave: number): number[] => TRIAD.map((o) => note(chord, o, octave));

const DEFS: Record<Exclude<MusicState, 'none'>, TrackDef> = {
  // -------------------------------------------------------------- menu / lobby: sparse, atmospheric
  menu: {
    gain: 1,
    bpm: () => 66,
    step({ kit, bar, s, t, sd, chord }) {
      const barLen = sd * MUSIC.STEPS_PER_BAR;
      if (s === 0) {
        kit.pad(t, chordPad(chord, 1), barLen, 0.034, 620 + 260 * Math.sin(bar * 0.7));
        kit.drone(t, note(chord, 0, 0), barLen, 0.1);
        if (bar % 4 === 0) kit.bell(t, TONIC + OCTAVE, 0.1); // the Last Bell
        if (bar % 2 === 1) kit.kick(t, 0.09);
      }
      if (s === 3 && bar % 2 === 1) kit.kick(t, 0.07);
      if (s % 2 === 0 && rnd(bar * MUSIC.STEPS_PER_BAR + s, 1) < 0.13) {
        const pick = BELL_STEPS[Math.floor(rnd(bar * MUSIC.STEPS_PER_BAR + s, 2) * BELL_STEPS.length)];
        kit.bell(t, note(chord, pick, 2), 0.05);
      }
      if (s === 8 && rnd(bar, 3) < 0.6) kit.bell(t, note(chord, 4, 2), 0.04);
    },
  },
  // -------------------------------------------------------------- draft / doors: calm interlude
  calm: {
    gain: 1,
    bpm: () => 84,
    step({ kit, bar, s, t, sd, chord, section }) {
      const barLen = sd * MUSIC.STEPS_PER_BAR;
      if (s === 0) {
        kit.pad(t, chordPad(chord, 1), barLen, 0.03, 900);
        kit.drone(t, note(chord, 0, 0), barLen, 0.08);
        if (bar % 2 === 0) kit.tom(t, TONIC + OCTAVE, 0.07);
      }
      if (s % 2 === 0 && rnd(bar * MUSIC.STEPS_PER_BAR + s, 4) >= 0.18) {
        const arp = (section + bar) % 2 === 0 ? ARP_A : ARP_B;
        kit.pluck(t, note(chord, arp[(s / 2 + (bar % 2) * 3) % arp.length], 2), 0.07);
      }
      if (s === 12 && bar % 4 === 3) kit.bell(t, note(chord, 4, 2), 0.045);
    },
  },
  // -------------------------------------------------------------- combat: dark, pulsing
  combat: {
    gain: 1,
    bpm: () => 114,
    step({ kit, bar, s, t, sd, chord, section }) {
      const idx = bar * MUSIC.STEPS_PER_BAR + s;
      if (KICKS[bar % KICKS.length].includes(s)) kit.kick(t, 0.34);
      if (s === 4 || s === 12) kit.snare(t, 0.19);
      if (bar % 8 === 7 && s >= 13) kit.snare(t, 0.1 + 0.035 * (s - 13));
      if (bar % 16 === 15 && s >= 8 && s < 12) kit.tom(t, FILL_TOMS[s - 8], 0.16);
      if (s % 2 === 0) kit.hat(t, 0.045);
      else if (rnd(idx, 5) < 0.28) kit.hat(t, 0.028);
      if (bar % 2 === 1 && s === 14) kit.hat(t, 0.05, true);
      if ((section === 0 ? BASS_A : BASS_B)[s] === 1) {
        const offset = s === 10 ? 7 : s === 13 ? 4 : 0;
        kit.bass(t, note(chord, offset, 0), sd * 1.6, 0.2, 360 + 220 * ((bar % 8) / 8));
      }
      if (s === 0) kit.pad(t, chordPad(chord, 1), sd * MUSIC.STEPS_PER_BAR, 0.024, 1000);
      const leading = bar % 8 >= 4 || (section === 1 && bar % 4 >= 2);
      if (leading) {
        const step = PHRASES[Math.floor(rnd(bar, 7) * PHRASES.length)][s];
        if (step !== null) kit.lead(t, note(chord, step, 2), sd * 1.8, 0.05, 1700);
      }
    },
  },
  // -------------------------------------------------------------- elite: more drive
  elite: {
    gain: 1,
    bpm: () => 124,
    step({ kit, bar, s, t, sd, chord, section }) {
      const idx = bar * MUSIC.STEPS_PER_BAR + s;
      if (s % 4 === 0) kit.kick(t, 0.36);
      if ((s === 10 && bar % 2 === 1) || (s === 15 && bar % 4 === 3)) kit.kick(t, 0.26);
      if (s === 4 || s === 12) kit.snare(t, 0.21);
      if ((s === 7 || s === 9) && rnd(idx, 6) < 0.4) kit.snare(t, 0.07);
      if (bar % 4 === 3 && s >= 12) kit.tom(t, FILL_TOMS[s - 12], 0.17);
      kit.hat(t, s % 4 === 2 ? 0.055 : 0.03, bar % 2 === 1 && (s === 6 || s === 14));
      const sweep = Math.abs(((bar % 8) / 4) - 1);
      kit.bass(t, note(chord, DRIVE_OFFSETS[s], 0), sd * 1.1, s % 4 === 0 ? 0.19 : 0.13, 430 + 300 * (1 - sweep));
      if (s === 0) kit.pad(t, chordPad(chord, 1), sd * MUSIC.STEPS_PER_BAR, 0.022, 1200);
      const stabs = section === 0 ? [3, 6, 11] : [0, 3, 6, 10, 13];
      if (stabs.includes(s)) kit.stab(t, chordPad(chord, 2), 0.034);
      if (bar % 4 >= 2) {
        const step = PHRASES[(bar + Math.floor(rnd(bar, 8) * 2)) % PHRASES.length][s];
        if (step !== null) kit.lead(t, note(chord, step, 2), sd * 1.6, 0.055, 2200);
      }
    },
  },
  // -------------------------------------------------------------- boss: most intense, three phases
  boss: {
    gain: 1,
    bpm: (phase) => (phase >= 3 ? 146 : phase === 2 ? 138 : 132),
    step({ kit, bar, s, t, sd, chord, section, phase }) {
      if (s % 4 === 0) kit.kick(t, 0.38);
      if (s === 14 || s === 15) kit.kick(t, 0.24);
      if (phase >= 2 && bar % 2 === 1 && (s === 6 || s === 7)) kit.kick(t, 0.22);
      if (phase >= 3 && (s === 2 || s === 10)) kit.kick(t, 0.2);
      if (s === 4 || s === 12) kit.snare(t, 0.23);
      if (phase >= 2 && bar % 2 === 0 && s === 15) kit.snare(t, 0.13);
      if (bar % 4 === 3 && s >= 12) kit.snare(t, 0.1 + 0.03 * (s - 12));
      if (bar % 2 === 0 && (s === 3 || s === 6 || s === 11)) kit.tom(t, TONIC + OCTAVE, 0.15);
      if (bar % 2 === 1 && (s === 10 || s === 13)) kit.tom(t, TONIC + 7, 0.16);
      kit.hat(t, phase >= 2 ? 0.042 : 0.032, s % 8 === 6);
      // driving bass with a Phrygian flat-second pickup into the next bar on the tonic chord
      const pickup = s === 15 && chord.root === 0;
      const midi = pickup ? TONIC + 1 : note(chord, DRIVE_OFFSETS[s] === 4 ? 7 : DRIVE_OFFSETS[s], 0);
      kit.bass(t, midi, sd * 1.05, s % 4 === 0 ? 0.2 : 0.14, 400 + 130 * phase);
      if (s === 0) {
        kit.pad(t, chordPad(chord, 1), sd * MUSIC.STEPS_PER_BAR, 0.024, 1100);
        if (phase >= 2) kit.pad(t, chordPad(chord, 2), sd * MUSIC.STEPS_PER_BAR, 0.014, 1700);
        if (bar % 8 === 0) kit.bell(t, TONIC + OCTAVE, 0.08);
      }
      if (phase >= 2 && (s === 6 || s === 14)) kit.stab(t, chordPad(chord, 2), 0.03);
      if (phase >= 3 && bar % 2 === 1 && (s === 0 || s === 8)) {
        const root = note(chord, 0, 2);
        kit.stab(t, [root, root + 6], 0.045); // tritone
      }
      if (phase === 1) {
        if (bar % 8 >= 4) {
          const step = PHRASES[(bar + section) % PHRASES.length][s];
          if (step !== null) kit.lead(t, note(chord, step, 2), sd * 1.6, 0.055, 2000);
        }
      } else if (bar % 4 >= 2 && (phase >= 3 || s % 2 === 0)) {
        const k = phase >= 3 ? s : s / 2;
        kit.lead(t, note(chord, RUN_ARP[(k + bar) % RUN_ARP.length], 2 + (section + (bar >> 1)) % 2), sd * 0.9, 0.04, 2600);
      }
    },
  },
};

interface Track {
  state: Exclude<MusicState, 'none'>;
  out: GainNode;
  kit: Kit;
  step: number;
  next: number;
  /** Time at which the faded-out track is dropped. */
  dieAt: number;
}

export type Music = ReturnType<typeof createMusic>;

export function createMusic(g: AudioGraph) {
  let tracks: Track[] = [];
  let current: MusicState = 'none';
  let bossPhase = 1;

  const fadeOut = (fade: number, now: number): void => {
    for (const track of tracks) {
      if (track.dieAt !== Infinity) continue;
      track.out.gain.cancelScheduledValues(now);
      track.out.gain.setValueAtTime(track.out.gain.value, now);
      track.out.gain.linearRampToValueAtTime(MIX.SILENCE, now + fade);
      track.dieAt = now + fade + 0.1;
    }
  };

  /** Crossfades to another state. No-op when it is already playing. */
  const setState = (next: MusicState, fade: number = MUSIC.CROSSFADE): void => {
    if (next === current) return;
    const now = g.ctx.currentTime;
    current = next;
    fadeOut(fade, now);
    if (next === 'none') return;
    const out = g.ctx.createGain();
    out.gain.setValueAtTime(MIX.SILENCE, now);
    out.gain.linearRampToValueAtTime(DEFS[next].gain, now + fade);
    out.connect(g.music);
    tracks.push({ state: next, out, kit: createKit(g, out), step: 0, next: now + MUSIC.START_DELAY, dieAt: Infinity });
  };

  /** Schedules every active track up to `until` (defaults to now + look-ahead). */
  const schedule = (until: number = g.ctx.currentTime + MUSIC.LOOKAHEAD): void => {
    const now = g.ctx.currentTime;
    tracks = tracks.filter((track) => {
      if (now <= track.dieAt) return true;
      track.out.disconnect();
      return false;
    });
    for (const track of tracks) {
      const def = DEFS[track.state];
      const sd = 60 / def.bpm(bossPhase) / MUSIC.STEPS_PER_BEAT;
      if (track.next < now - MUSIC.MAX_LAG) {
        const missed = Math.ceil((now - track.next) / sd);
        track.step += missed;
        track.next += missed * sd;
      }
      const end = Math.min(until, track.dieAt);
      while (track.next < end) {
        const bar = Math.floor(track.step / MUSIC.STEPS_PER_BAR);
        def.step({
          kit: track.kit, bar, s: track.step % MUSIC.STEPS_PER_BAR, t: track.next, sd,
          chord: PROGRESSION[track.state][bar % MUSIC.BARS_PER_CYCLE],
          section: Math.floor(bar / MUSIC.BARS_PER_CYCLE) % 2, phase: bossPhase,
        });
        track.next += sd;
        track.step++;
      }
    }
  };

  const setBossPhase = (phase: number): void => {
    bossPhase = Math.min(MUSIC.MAX_BOSS_PHASE, Math.max(1, Math.round(phase)));
  };

  /** One-shot victory / defeat cue. Fades the running state out first. */
  const stinger = (kind: 'victory' | 'defeat'): void => {
    setState('none', MUSIC.STINGER_FADE);
    const out = g.music;
    const kit = createKit(g, out);
    const t = g.ctx.currentTime + 0.12;
    const D = TONIC + OCTAVE; // D3
    if (kind === 'victory') {
      for (let i = 0; i < 7; i++) kit.tom(t + i * (0.11 - i * 0.006), D, 0.1 + i * 0.025);
      const hit = t + 0.72;
      kit.kick(hit, 0.4);
      noise(g, out, hit, { dur: 1.8, gain: 0.1, filter: 'highpass', freq: 6000, send: 0.4 });
      // D major: the Picardy third resolves the minor-key score
      kit.pad(hit, [D, D + 7, D + 12, D + 16, D + 19], 2.6, 0.03, 2200);
      const fanfare: [number, number, number][] = [[0, 24, 0.24], [0.25, 24, 0.24], [0.5, 31, 0.6], [1.2, 28, 0.2], [1.42, 31, 0.2], [1.65, 36, 1.9]];
      for (const [at, semi, dur] of fanfare) kit.lead(hit + at, D + semi, dur, 0.085, 3200);
      const last = hit + 1.65;
      kit.kick(last, 0.4);
      kit.bell(last, D + 36, 0.07);
      kit.bell(last + 0.12, D + 43, 0.045);
      noise(g, out, last, { dur: 2.2, gain: 0.1, filter: 'highpass', freq: 5500, send: 0.5 });
    } else {
      tone(g, out, t, { freq: 72, freqEnd: 30, dur: 1.2, gain: 0.4 });
      kit.bell(t, D, 0.16);
      tone(g, out, t, { type: 'sawtooth', freq: midiToHz(TONIC), dur: 4.4, gain: 0.07, lpf: 240, attack: 0.3, hold: 2 });
      kit.pad(t + 0.3, [D, D + 3, D + 7], 3.2, 0.03, 700);
      const lament: [number, number, number][] = [[0.5, 15, 0.9], [1.3, 14, 0.9], [2.1, 12, 2.3]];
      for (const [at, semi, dur] of lament) {
        tone(g, out, t + at, { type: 'triangle', freq: midiToHz(D + semi), dur, gain: 0.1, attack: 0.03, send: 0.6 });
      }
      kit.bell(t + 2.1, D, 0.12);
    }
  };

  return { setState, schedule, setBossPhase, stinger, state: (): MusicState => current, trackCount: (): number => tracks.length };
}

// ------------------------------------------------------------------ ambience

const AMBIENCE = {
  GAIN: 0.5,
  FADE: 1.2,
  NOISE_GAIN: 0.36,
  NOISE_CUTOFF: 170,
  HUM_GAIN: 0.035,
  HUM_HZ: 55,
  HUM_BEAT_HZ: 0.6,
  DRIP_MIN_S: 2.5,
  DRIP_MAX_S: 8,
} as const;

export type Ambience = ReturnType<typeof createAmbience>;

/** Low crypt bed for the game screen: a dark rumble, a slow beating hum and occasional drips. */
export function createAmbience(g: AudioGraph) {
  let bed: { out: GainNode; sources: AudioScheduledSourceNode[] } | null = null;
  let dripTimer = 0;

  const drip = (): void => {
    if (!bed) return;
    const t = g.ctx.currentTime + 0.02;
    const pitch = 900 + Math.random() * 900;
    tone(g, bed.out, t, { freq: pitch * 1.6, freqEnd: pitch, dur: 0.09, gain: 0.07, send: 0.8 });
    tone(g, bed.out, t + 0.16 + Math.random() * 0.08, { freq: pitch * 1.25, freqEnd: pitch * 0.9, dur: 0.07, gain: 0.03, send: 0.8 });
  };

  const queueDrip = (): void => {
    const wait = AMBIENCE.DRIP_MIN_S + Math.random() * (AMBIENCE.DRIP_MAX_S - AMBIENCE.DRIP_MIN_S);
    dripTimer = window.setTimeout(() => { drip(); if (bed) queueDrip(); }, wait * 1000);
  };

  const start = (): void => {
    if (bed) return;
    const { ctx } = g;
    const now = ctx.currentTime;
    const out = ctx.createGain();
    out.gain.setValueAtTime(MIX.SILENCE, now);
    out.gain.linearRampToValueAtTime(AMBIENCE.GAIN, now + AMBIENCE.FADE);
    out.connect(g.sfx);

    const rumble = ctx.createBufferSource();
    rumble.buffer = g.noise;
    rumble.loop = true;
    const lp1 = ctx.createBiquadFilter();
    const lp2 = ctx.createBiquadFilter();
    for (const lp of [lp1, lp2]) { lp.type = 'lowpass'; lp.frequency.value = AMBIENCE.NOISE_CUTOFF; lp.Q.value = 0.5; }
    const rumbleGain = ctx.createGain();
    rumbleGain.gain.value = AMBIENCE.NOISE_GAIN;
    rumble.connect(lp1).connect(lp2).connect(rumbleGain).connect(out);

    const sources: AudioScheduledSourceNode[] = [rumble];
    for (const freq of [AMBIENCE.HUM_HZ, AMBIENCE.HUM_HZ + AMBIENCE.HUM_BEAT_HZ]) {
      const osc = ctx.createOscillator();
      osc.frequency.value = freq;
      const gain = ctx.createGain();
      gain.gain.value = AMBIENCE.HUM_GAIN;
      osc.connect(gain).connect(out);
      sources.push(osc);
    }
    for (const src of sources) src.start(now);
    bed = { out, sources };
    queueDrip();
  };

  const stop = (): void => {
    if (!bed) return;
    const now = g.ctx.currentTime;
    const old = bed;
    bed = null;
    window.clearTimeout(dripTimer);
    old.out.gain.cancelScheduledValues(now);
    old.out.gain.setValueAtTime(old.out.gain.value, now);
    old.out.gain.linearRampToValueAtTime(MIX.SILENCE, now + AMBIENCE.FADE);
    for (const src of old.sources) src.stop(now + AMBIENCE.FADE + 0.05);
    window.setTimeout(() => old.out.disconnect(), (AMBIENCE.FADE + 0.2) * 1000);
  };

  return { start, stop, active: (): boolean => bed !== null };
}
