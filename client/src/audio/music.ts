/**
 * Adaptive generative score: a step sequencer in D minor.
 *
 * States: menu (sparse bells over a pad), calm (draft / doors interlude), combat, elite (more drive) and boss
 * (three phases; each final boss has its own piece: Regent = bell, choir and war drums, Matron = a slow
 * compound-time dance of glass arpeggios, Stalker = a fast hunt of bone percussion and tritones).
 * Changing state crossfades two concurrently running tracks. Every state walks a 16-bar chord cycle,
 * alternates A/B sections and uses hashed per-bar variation, so nothing repeats exactly for well over 32 bars.
 * The biome tints every track (filter, reverb amount, bass drive, anvil / water-drop percussion).
 *
 * Voices are layered and filtered (detuned saws through moving low-passes, formant "choir", vibrato leads);
 * drums and bells use samples when they are decoded and fall back to synthesis otherwise.
 * Victory / defeat are one-shot stingers.
 *
 * Update 4: a combat chamber with a special objective plays that objective's variation instead of the combat
 * piece (`setObjective`): survive = a relentless pulse whose tempo and density tighten with the timer, defend =
 * an anchored drone on the tonic under half-time drums, hunt = a driving ostinato, ritual = a sparse frame that
 * gains a layer per lit brazier, vault = sparse and warm, in the relative major, no drums.
 *
 * Update 5: every keystone the own hero holds adds a voice to the fighting pieces (`setKeystones`, one voice per
 * keystone family, see `keystoneLayer`), on top of whatever piece plays and transposed with it; and while the own
 * keystone draft is open the calm interlude gives way to a held, unresolved bed (`setKeystoneDraft`).
 */
import type { BiomeId, BossKind, ObjectiveKind } from '@shared/types.ts';
import { MIX, midiToHz, noise, panned, tone, type AudioGraph, type NoiseOpts, type ToneOpts } from './engine.ts';
import type { KeystoneFamily, ScoreVoice } from './keystone-map.ts';
import { voicesKey } from './keystone-map.ts';
import type { SampleGroup } from './manifest.ts';
import { VOICES, type Player, type VoiceOpts } from './samples.ts';

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
  BARS_PER_CYCLE: 16,
  MAX_BOSS_PHASE: 3,
  STINGER_SECONDS: 4.6,
  STINGER_BELLS_MAX: 4,
  /** Fundamental the sampled drum / bell are tuned from (measured, Hz). */
  DRUM_HZ: 100,
  BELL_HZ: 240,
  /** The sampled bell is only used up to this note; above it the synthesised bell rings truer. */
  BELL_SAMPLE_MAX: 62,
  TAIL: 0.05,
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

/** Objectives with a piece of their own (`slay` is the combat piece). */
export type SpecialObjective = Exclude<ObjectiveKind, 'slay'>;
type TrackKey = 'menu' | 'calm' | 'keydraft' | 'combat' | 'elite' | `boss:${BossKind}` | `obj:${SpecialObjective}`;

/** What the objective pieces follow while they play. */
export interface ObjectiveMusic {
  /** 0..1: how far the timer has run down (survive, hunt), how damaged the shard is (defend). */
  pressure: number;
  /** ritual: braziers burning. */
  lit: number;
}

export const OBJECTIVE_MUSIC = {
  /** Braziers beyond this add no further layer. */
  LIT_MAX: 3,
  /** survive: beats per minute at the start and gained by the end of the timer. */
  SURVIVE_BPM: 116,
  SURVIVE_BPM_GAIN: 20,
  HUNT_BPM: 130,
  HUNT_BPM_ENRAGED: 138,
  RITUAL_BPM: 104,
  RITUAL_BPM_PER_SITE: 4,
} as const;

const PROGRESSION: Record<TrackKey, Chord[]> = {
  menu: [I, I, VI, VI, IV, IV, I, I, III, III, VII, VII, IV, IV, V, V],
  calm: [I, VI, III, VII, I, VI, IV, V, I, III, VI, VII, IV, I, IV, V],
  // the keystone draft: the tonic held, the subdominant leaning on it, never a cadence
  keydraft: [I, I, I, I, IV, IV, I, I, I, I, VI, VI, IV, IV, I, I],
  combat: [I, I, VI, VII, I, I, IV, Vm, I, VI, III, VII, IV, IV, V, V],
  elite: [I, I, II, V, I, I, VI, V, IV, IV, I, I, VI, VII, V, V],
  'boss:regent': [I, I, I, I, VI, VI, V, V, I, I, IV, IV, II, II, V, V],
  // harmonic minor: the major dominant keeps returning
  'boss:matron': [I, I, VI, V, I, IV, V, V, I, III, VI, V, IV, I, V, V],
  // barely any harmony: tonic pedal with tritone-laden neighbours
  'boss:stalker': [I, I, I, II, I, I, VI, II, I, I, I, II, IV, IV, II, II],
  // one chord per two bars: nothing may distract from the pulse
  'obj:survive': [I, I, I, I, VI, VI, I, I, IV, IV, I, I, VI, VI, V, V],
  // the bass never leaves the tonic (pedal); only the colour above it moves
  'obj:defend': [I, I, VI, VI, I, I, IV, IV, I, I, III, III, IV, IV, I, I],
  'obj:hunt': [I, I, I, II, I, I, VII, VII, I, I, I, II, VI, VI, V, V],
  'obj:ritual': [I, I, IV, IV, I, I, VI, VII, I, I, IV, IV, VI, VII, I, I],
  // F, B flat and C: the relative major, I-IV-V in F. The only piece of the score that is at peace
  'obj:vault': [III, III, VI, VI, VII, VII, III, III, VI, VI, III, III, VII, VII, III, III],
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
/** Matron: glass arpeggio over a 12-step bar, and her long melody notes [step, scale offset, steps long]. */
const MATRON_ARP = [0, 4, 7, 9, 7, 4, 2, 4, 7, 11, 7, 4];
const MATRON_MELODY: [number, number, number][][] = [
  [[0, 4, 5], [6, 6, 3], [9, 4, 3]],
  [[0, 7, 6], [6, 6, 6]],
  [[0, 2, 3], [3, 4, 3], [6, 7, 6]],
  [[0, 8, 4], [6, 7, 2], [9, 4, 3]],
];
/** Stalker: bone ostinato accents per 16th (0 = rest, 1 = ghost, 2 = accent) and its hunting motifs. */
const STALKER_BONES = [2, 0, 1, 1, 0, 2, 0, 1, 2, 0, 1, 0, 2, 1, 0, 1];
const STALKER_PULSE = [0, 3, 6, 10, 12];
/** Hunt: the ostinato in scale steps above the chord root (the second degree is flattened: Phrygian). */
const HUNT_OSTINATO = [0, 0, 7, 0, 1, 0, 7, 0, 0, 0, 7, 0, 3, 2, 1, 0];
/** Ritual: one note per burning brazier, D-F-A above the tonic two octaves up. */
const BRAZIER_NOTES = [0, 3, 7];
const STALKER_MOTIFS: (number | null)[][] = [
  [0, _, 1, _, 0, _, _, 6, _, _, 0, _, _, _, _, _],
  [0, _, 2, _, 1, _, 0, _, _, _, _, _, 6, _, 0, _],
  [4, _, 3, _, 1, _, 0, _, _, _, _, _, _, _, _, _],
];

/** Pad low-pass cutoffs in the pieces are multiplied by this (one knob for the overall darkness of the score). */
const PAD_BRIGHTNESS = 1.5;

/** Steepness of the bass saturator curve; `drive` / `post` in the tints are matched to it for equal loudness. */
const BASS_SHAPE = 2.5;

/** Stereo placement of the score: detuned pad voices spread by SPREAD, light percussion sits slightly off-centre. */
const STEREO = { SPREAD: 0.55, HAT: 0.22, BONE: -0.28, ANVIL: 0.32, GLASS: 0.18 } as const;

/**
 * The endless descent: every depth below the first transposes the score a semitone down and adds a layer of
 * the overlay in `depthLayer` (denser pulse, more dissonance). Everything is derived from bar and step numbers,
 * so the deeper versions loop over the same 16-bar cycle as the pieces they sit on.
 */
export const DEPTH = {
  /** Depths beyond this sound like this one. */
  MAX: 5,
  SEMITONES_PER_DEPTH: -1,
  /** Chance of an extra ghost hat per odd step, per depth. */
  GHOST_HATS: 0.14,
} as const;

/** How a biome colours the score. */
interface Tint { cutoff: number; send: number; drive: number; post: number; anvil: boolean; drip: boolean }
const TINTS: Record<BiomeId, Tint> = {
  crypt: { cutoff: 13000, send: 1, drive: 0.6, post: 0.71, anvil: false, drip: false },
  flooded: { cutoff: 5200, send: 1.6, drive: 0.6, post: 0.71, anvil: false, drip: true },
  forge: { cutoff: 16000, send: 0.8, drive: 2, post: 0.33, anvil: true, drip: false },
};

interface KitEnv {
  /** Voices connect here (track input). */
  out: AudioNode;
  /** Reverb send of the track. */
  send: AudioNode;
  tint(): Tint;
  /** Transposition of the track in semitones (0 or negative: deeper = lower). */
  shift(): number;
}

type Kit = ReturnType<typeof createKit>;

function createKit(g: AudioGraph, player: Player | null, env: KitEnv) {
  const { ctx } = g;
  const { out, send } = env;
  /** Every pitched voice of the kit goes through here, so a track can sit lower the deeper the party is. */
  const hz = (midi: number): number => midiToHz(midi + env.shift());
  const T = (t: number, o: ToneOpts): void => tone(g, out, t, o, send);
  const N = (t: number, o: NoiseOpts): void => noise(g, out, t, o, send);
  const S = (group: SampleGroup, t: number, gain: number, o: Omit<VoiceOpts, 'gain'> = {}): boolean =>
    player !== null && player.play(group, t, { jitter: 0.02, ...o, gain, dest: out, reverb: send, pri: VOICES.PRI.PARTY });

  // The bass runs through a soft saturator; the biome sets how hard it is driven.
  const bassIn = ctx.createGain();
  const shaper = ctx.createWaveShaper();
  const bassOut = ctx.createGain();
  const curve = new Float32Array(new ArrayBuffer(MIX.SOFT_CLIP_SAMPLES * Float32Array.BYTES_PER_ELEMENT));
  for (let i = 0; i < curve.length; i++) curve[i] = Math.tanh(BASS_SHAPE * ((i / (curve.length - 1)) * 2 - 1));
  shaper.curve = curve;
  bassIn.connect(shaper).connect(bassOut).connect(out);
  const applyTint = (): void => {
    bassIn.gain.value = env.tint().drive;
    bassOut.gain.value = env.tint().post;
  };
  applyTint();

  /** Oscillators -> one shared, moving low-pass -> envelope. The backbone of pads and stabs. */
  const stack = (t: number, freqs: number[], detunes: number[], type: OscillatorType, dur: number, gain: number,
    attack: number, hold: number, cutoffFrom: number, cutoffPeak: number, cutoffEnd: number, q: number, sendAmount: number): void => {
    const end = t + dur + MUSIC.TAIL;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = q;
    filter.frequency.setValueAtTime(cutoffFrom, t);
    filter.frequency.linearRampToValueAtTime(cutoffPeak, t + Math.max(attack, 0.01));
    filter.frequency.linearRampToValueAtTime(cutoffEnd, t + dur);
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(MIX.SILENCE, t);
    amp.gain.linearRampToValueAtTime(gain, t + attack);
    if (hold > 0) amp.gain.setValueAtTime(gain, t + attack + hold);
    amp.gain.exponentialRampToValueAtTime(MIX.SILENCE, t + dur);
    // one filter + envelope per detune group, the groups spread left and right
    detunes.forEach((detune, side) => {
      const group = side === 0 ? filter : ctx.createBiquadFilter();
      if (side > 0) {
        group.type = 'lowpass';
        group.Q.value = q;
        group.frequency.setValueAtTime(cutoffFrom, t);
        group.frequency.linearRampToValueAtTime(cutoffPeak, t + Math.max(attack, 0.01));
        group.frequency.linearRampToValueAtTime(cutoffEnd, t + dur);
      }
      for (const freq of freqs) {
        const osc = ctx.createOscillator();
        osc.type = type;
        osc.frequency.value = freq;
        osc.detune.value = detune;
        osc.connect(group);
        g.track(osc);
        osc.start(t);
        osc.stop(end);
      }
      const pan = detunes.length > 1 ? (side / (detunes.length - 1)) * 2 * STEREO.SPREAD - STEREO.SPREAD : 0;
      panned(ctx, group, pan).connect(amp);
    });
    amp.connect(out);
    if (sendAmount > 0) {
      const tap = ctx.createGain();
      tap.gain.value = sendAmount;
      amp.connect(tap).connect(send);
    }
  };

  return {
    applyTint,
    kick(t: number, gain: number): void {
      if (S('hit.tight', t, gain * 1.5, { rate: 0.92 })) {
        T(t, { freq: 110, freqEnd: 42, dur: 0.2, gain: gain * 0.55 });
      } else {
        T(t, { freq: 150, freqEnd: 42, dur: 0.24, gain });
        T(t, { type: 'triangle', freq: 1100, freqEnd: 300, dur: 0.016, gain: gain * 0.3 });
      }
    },
    snare(t: number, gain: number): void {
      if (S('drum.plank', t, gain * 1.6, { rate: 1.5, hpf: 180, dur: 0.14, send: 0.2 })) {
        N(t, { dur: 0.13, gain: gain * 0.6, filter: 'bandpass', freq: 2100, q: 0.7, send: 0.15 });
      } else {
        N(t, { dur: 0.15, gain, filter: 'bandpass', freq: 1700, q: 0.7, send: 0.15 });
        T(t, { type: 'triangle', freq: 200, freqEnd: 130, dur: 0.1, gain: gain * 0.7 });
      }
    },
    hat(t: number, gain: number, open = false): void {
      N(t, { dur: open ? 0.17 : 0.035, gain: gain * 1.5, filter: 'highpass', freq: 7800, pan: STEREO.HAT });
      if (open) N(t, { dur: 0.12, gain: gain * 0.7, filter: 'bandpass', freq: 10500, q: 2, pan: STEREO.HAT });
    },
    tom(t: number, midi: number, gain: number): void {
      const f = hz(midi);
      if (S('drum.low', t, gain * 2.4, { rate: f / MUSIC.DRUM_HZ, send: 0.25 })) {
        T(t, { freq: f * 1.3, freqEnd: f * 0.8, dur: 0.22, gain: gain * 0.5 });
      } else {
        T(t, { freq: f * 1.5, freqEnd: f * 0.8, dur: 0.28, gain, send: 0.2 });
      }
    },
    /** Big war drum (taiko-like sample). */
    war(t: number, gain: number, rate = 1): void {
      if (!S('drum.war', t, gain * 2, { rate, send: 0.35 })) {
        T(t, { freq: 95 * rate, freqEnd: 40, dur: 0.4, gain, send: 0.3 });
        N(t, { dur: 0.08, gain: gain * 0.4, filter: 'lowpass', freq: 900 });
      }
    },
    /** A knock of bone on bone; `rate` gives the pitch of the ostinato. */
    bone(t: number, rate: number, gain: number): void {
      if (!S('hit.bone', t, gain * 2.6, { rate, send: 0.25, pan: STEREO.BONE })) {
        T(t, { type: 'triangle', freq: 420 * rate, freqEnd: 300 * rate, dur: 0.04, gain });
      }
    },
    anvil(t: number, gain: number): void {
      if (!S('hit.ring', t, gain * 1.8, { rate: 0.8, send: 0.5, pan: STEREO.ANVIL })) {
        for (const f of [2100, 3140]) T(t, { freq: f, dur: 0.18, gain: gain * 0.5, send: 0.4 });
      }
    },
    /** Water drop for the flooded biome. */
    drop(t: number, midi: number, gain: number): void {
      const f = hz(midi);
      T(t, { freq: f * 1.5, freqEnd: f, dur: 0.1, gain, send: 0.7 });
    },
    bass(t: number, midi: number, dur: number, gain: number, cutoff: number): void {
      const f = hz(midi);
      tone(g, bassIn, t, { type: 'sawtooth', freq: f, dur, gain, lpf: cutoff * 3.6, lpfEnd: cutoff * 1.3, q: 3 }, send);
      tone(g, bassIn, t, { type: 'square', freq: f, detune: 9, dur: dur * 0.8, gain: gain * 0.25, lpf: cutoff * 1.6, lpfEnd: cutoff * 0.8 }, send);
      tone(g, bassIn, t, { freq: f, dur, gain: gain * 0.5 }, send);
      tone(g, bassIn, t, { type: 'triangle', freq: f * 2, dur: dur * 0.7, gain: gain * 0.2 }, send); // audible on small speakers
    },
    pad(t: number, midis: number[], dur: number, gain: number, cutoff: number): void {
      const attack = Math.min(1.2, dur * 0.35);
      const c = cutoff * PAD_BRIGHTNESS;
      stack(t, midis.map(hz), [-8, 7], 'sawtooth', dur * 1.25, gain * 1.2, attack, dur * 0.4, c * 0.55, c, c * 0.7, 0.8, 0.35);
      T(t, { type: 'triangle', freq: hz(midis[0] + OCTAVE), dur: dur * 1.2, gain: gain * 0.6, attack, hold: dur * 0.4, send: 0.35 });
    },
    /** Wordless choir: saws with vibrato through two vowel formants. */
    choir(t: number, midis: number[], dur: number, gain: number, vowel: 'ah' | 'oo'): void {
      const end = t + dur * 1.3 + MUSIC.TAIL;
      const attack = Math.min(1.4, dur * 0.4);
      const amp = ctx.createGain();
      amp.gain.setValueAtTime(MIX.SILENCE, t);
      amp.gain.linearRampToValueAtTime(gain, t + attack);
      amp.gain.setValueAtTime(gain, t + attack + dur * 0.35);
      amp.gain.exponentialRampToValueAtTime(MIX.SILENCE, t + dur * 1.3);
      const formants = vowel === 'ah' ? [[640, 6, 1], [1080, 8, 0.6], [2500, 9, 0.12]] : [[340, 6, 1], [780, 8, 0.45], [2300, 9, 0.06]];
      const pre = ctx.createGain();
      for (const [freq, q, level] of formants) {
        const band = ctx.createBiquadFilter();
        band.type = 'bandpass';
        band.frequency.value = freq;
        band.Q.value = q;
        const lv = ctx.createGain();
        lv.gain.value = level * 3;
        pre.connect(band).connect(lv).connect(amp);
      }
      const lfo = ctx.createOscillator();
      const depth = ctx.createGain();
      lfo.frequency.value = 5.2;
      depth.gain.value = 9;
      lfo.connect(depth);
      g.track(lfo);
      lfo.start(t);
      lfo.stop(end);
      for (const midi of midis) {
        for (const detune of [-11, 10]) {
          const osc = ctx.createOscillator();
          osc.type = 'sawtooth';
          osc.frequency.value = hz(midi);
          osc.detune.value = detune;
          depth.connect(osc.detune);
          osc.connect(pre);
          g.track(osc);
          osc.start(t);
          osc.stop(end);
        }
      }
      amp.connect(out);
      const tap = ctx.createGain();
      tap.gain.value = 0.6;
      amp.connect(tap).connect(send);
    },
    lead(t: number, midi: number, dur: number, gain: number, bright: number): void {
      const f = hz(midi);
      T(t, { type: 'sawtooth', freq: f, detune: -6, dur, gain: gain * 0.7, lpf: bright * 1.3, lpfEnd: bright * 0.6, q: 2.5, attack: 0.01, vib: 10, send: 0.3 });
      T(t, { type: 'triangle', freq: f, detune: 6, dur, gain: gain * 1.2, attack: 0.01, vib: 10, send: 0.3 });
      T(t, { freq: f * 2, dur: dur * 0.6, gain: gain * 0.2, attack: 0.01 });
    },
    /** Sustained, breathy voice for slow melodies. */
    wail(t: number, midi: number, dur: number, gain: number): void {
      const f = hz(midi);
      T(t, { type: 'triangle', freq: f, dur: dur * 1.1, gain, attack: Math.min(0.25, dur * 0.3), hold: dur * 0.4, vib: 22, vibHz: 5.6, send: 0.6 });
      T(t, { type: 'sawtooth', freq: f, detune: 8, dur: dur * 1.1, gain: gain * 0.3, lpf: 1500, attack: Math.min(0.3, dur * 0.35), hold: dur * 0.4, vib: 22, vibHz: 5.6, send: 0.5 });
    },
    /** Bowed tremolo for tension. */
    tremolo(t: number, midis: number[], dur: number, gain: number): void {
      for (const m of midis) T(t, { type: 'sawtooth', freq: hz(m), dur: dur * 1.05, gain, lpf: 2400, attack: 0.06, hold: dur * 0.7, am: 0.85, amHz: 13, send: 0.4 });
    },
    bell(t: number, midi: number, gain: number): void {
      const f = hz(midi);
      T(t, { freq: f, dur: 2.6, gain, send: 0.6 });
      T(t, { freq: f * 2.76, dur: 1.1, gain: gain * 0.28, send: 0.4 });
      T(t, { freq: f * 5.4, dur: 0.5, gain: gain * 0.1 });
      if (midi <= MUSIC.BELL_SAMPLE_MAX) S('bell', t, gain * 4, { variant: 2, rate: f / MUSIC.BELL_HZ, jitter: 0, send: 0.7 });
    },
    /** Small glassy bell for arpeggios. */
    glass(t: number, midi: number, gain: number): void {
      const f = hz(midi);
      T(t, { freq: f, dur: 0.7, gain: gain * 1.2, send: 0.6 });
      T(t, { freq: f * 2.76, dur: 0.25, gain: gain * 0.3, send: 0.4 });
      T(t, { type: 'triangle', freq: f * 2, dur: 0.12, gain: gain * 0.25 });
    },
    pluck(t: number, midi: number, gain: number): void {
      const f = hz(midi);
      T(t, { type: 'triangle', freq: f, dur: 0.34, gain, lpf: 2600, lpfEnd: 500, send: 0.35 });
      T(t, { type: 'sawtooth', freq: f, detune: 5, dur: 0.2, gain: gain * 0.25, lpf: 3000, lpfEnd: 400, q: 2 });
    },
    stab(t: number, midis: number[], gain: number): void {
      stack(t, midis.map(hz), [-9, 9], 'sawtooth', 0.17, gain, 0.004, 0, 2600, 2600, 500, 2, 0.2);
    },
    drone(t: number, midi: number, dur: number, gain: number): void {
      const attack = Math.min(0.8, dur * 0.3);
      T(t, { freq: hz(midi), dur: dur * 1.15, gain: gain * 0.7, attack, hold: dur * 0.5 });
      T(t, { type: 'triangle', freq: hz(midi), dur: dur * 1.15, gain: gain * 0.35, attack, hold: dur * 0.5, lpf: 400 });
    },
    noise: N,
    tone: T,
    sample: S,
    /** Transposition of the track in semitones (for voices that compute their own frequencies). */
    shift: (): number => env.shift(),
  };
}

interface StepCtx {
  kit: Kit;
  bar: number;
  /** Step inside the bar. */
  s: number;
  t: number;
  /** Step duration (s). */
  sd: number;
  /** Bar duration (s). */
  barLen: number;
  chord: Chord;
  /** 0 = A section, 1 = B section (flips every 16 bars). */
  section: number;
  phase: number;
  tint: Tint;
  /** State of the chamber's objective (only the objective pieces read it). */
  obj: ObjectiveMusic;
}

interface TrackDef {
  gain: number;
  /** Steps per bar and per beat (16 / 4 = common time, 12 / 3 = compound time). */
  steps: number;
  stepsPerBeat: number;
  bpm(phase: number, obj: ObjectiveMusic): number;
  step(c: StepCtx): void;
}

const chordPad = (chord: Chord, octave: number): number[] => TRIAD.map((o) => note(chord, o, octave));

/** What the depth adds on top of a piece (d = 1..DEPTH.MAX). `drive` is false for the calm interlude. */
function depthLayer({ kit, bar, s, t, sd, barLen, chord }: StepCtx, d: number, steps: number, stepsPerBeat: number, drive: boolean): void {
  const idx = bar * steps + s;
  if (s === 0) {
    // the flat second under everything: the further down, the louder it grinds against the tonic
    kit.drone(t, TONIC + 1, barLen, 0.016 + 0.007 * d);
    if (d >= 2 && bar % 2 === 1) kit.tremolo(t, [note(chord, 0, 2) + 6], barLen, 0.005 + 0.002 * d);
  }
  if (!drive) return;
  // a sub pulse between the beats thickens the low end
  if (s % stepsPerBeat === Math.floor(stepsPerBeat / 2)) kit.tone(t, { freq: 55, freqEnd: 41, dur: sd * 1.5, gain: 0.05 + 0.012 * d });
  if (d >= 2 && s % 2 === 1 && rnd(idx, 21) < DEPTH.GHOST_HATS * d) kit.hat(t, 0.022);
  if (d >= 3) {
    if ((s * 5 + bar) % 7 === 0) kit.bone(t, 0.8 + 0.1 * (bar % 3), 0.03 + 0.004 * d);
    if (bar % 4 === 3 && s === steps - 2) {
      const root = note(chord, 0, 2);
      kit.stab(t, [root, root + 1, root + 6], 0.03); // cluster
    }
  }
  if (d >= 4 && s === steps / 2) kit.war(t, 0.07 + 0.01 * d, 0.75);
  if (d >= DEPTH.MAX && bar % 2 === 0 && s === steps - 1) kit.tom(t, TONIC + 1, 0.11);
}

/** Update 5: what the keystone voices are built from. */
const KEY_RUN = [0, 2, 4, 7, 9, 7, 4, 2];
const KEY_ANSWERS: [number, number][] = [[4, 7], [7, 9], [2, 4], [9, 7]];
const KEY_CALLS: [number, number][] = [[0, 4], [4, 7], [0, 2], [4, 0]];

/**
 * The voice a held keystone adds to a fighting piece, by family (keystone-map.ts). All of it hangs on bar and step
 * numbers and on the bar's chord, so it sits on any piece (common or compound time), follows the chord cycle and is
 * transposed with the depth like everything else the kit plays. `dense` = the second keystone of the same family:
 * the same voice an octave up and twice as busy instead of a mere doubling. `drive` is false for pieces without drums.
 *   movement  – a running arpeggio of plucked notes on the off-beats
 *   primary   – steel: an anvil on the back-beats and a stab in fifths
 *   secondary – a bell on the bar and a hummed chord
 *   companion – two glass notes answering each other at the end of the bar
 *   win       – a horn call over two bars, the war drum under it
 *   class     – open voices on the chord and a long high note
 */
function keystoneLayer({ kit, bar, s, t, sd, barLen, chord }: StepCtx, family: KeystoneFamily, dense: boolean, steps: number, stepsPerBeat: number, drive: boolean): void {
  const beat = Math.floor(s / stepsPerBeat);
  const onBeat = s % stepsPerBeat === 0;
  const up = dense ? 1 : 0;
  switch (family) {
    case 'movement': {
      const half = Math.floor(stepsPerBeat / 2);
      const off = s % stepsPerBeat === half;
      if (off || (dense && s % stepsPerBeat === half + 1)) {
        kit.pluck(t, note(chord, KEY_RUN[(beat * 2 + (off ? 0 : 1) + bar * 3) % KEY_RUN.length], 3 + up), 0.055);
      }
      if (s === steps - 1 && bar % 2 === 1) kit.noise(t - sd, { dur: sd * 2, gain: 0.02, filter: 'bandpass', freq: 900, freqEnd: 4200, q: 1.5, attack: sd * 1.6, pan: -STEREO.HAT });
      break;
    }
    case 'primary': {
      if (drive && onBeat && beat % 2 === 1) kit.anvil(t, dense ? 0.065 : 0.085);
      const stabAt = stepsPerBeat + Math.floor(stepsPerBeat / 2);
      if (s === stabAt || (dense && s === steps - stabAt)) {
        const root = note(chord, 0, 3 + up);
        kit.stab(t, [root, root + 7], 0.06);
        // struck steel rings on: the note and its inharmonic overtone
        kit.tone(t, { type: 'triangle', freq: midiToHz(root + 12 + kit.shift()), dur: sd * 6, gain: 0.05, send: 0.5 });
        kit.tone(t, { freq: midiToHz(root + 12 + kit.shift()) * 2.76, dur: sd * 4, gain: 0.012, send: 0.5 });
      }
      if (dense && onBeat && beat === 0 && bar % 2 === 0) kit.glass(t, note(chord, 4, 3), 0.03);
      break;
    }
    case 'secondary':
      if (s === 0 && bar % 2 === 0) {
        kit.bell(t, note(chord, 0, 3 + up), 0.06);
        kit.choir(t, [note(chord, 0, 2), note(chord, 4, 2)], barLen * 2, 0.011, 'oo');
      }
      // the bell's echo: one glass note in the bar between, two when dense
      if (s === Math.floor(steps / 2) && bar % 2 === 1) kit.glass(t, note(chord, 4, 3), 0.05);
      if (dense && s === steps - stepsPerBeat && bar % 2 === 1) kit.glass(t, note(chord, 2, 4), 0.035);
      break;
    case 'companion': {
      const [a, b] = KEY_ANSWERS[bar % KEY_ANSWERS.length];
      const first = steps - stepsPerBeat;
      if (s === first) kit.glass(t, note(chord, a, 3 + up), 0.07);
      if (s === first + Math.floor(stepsPerBeat / 2)) kit.glass(t, note(chord, b, 3 + up), 0.06);
      if (dense && s === Math.floor(steps / 2)) kit.glass(t, note(chord, a, 3), 0.03);
      break;
    }
    case 'win': {
      if (s === 0 && bar % 2 === 0) {
        const [a, b] = KEY_CALLS[(bar / 2) % KEY_CALLS.length];
        const beatLen = sd * stepsPerBeat;
        for (const [at, off, dur] of [[0, a, beatLen * 0.9], [beatLen, b, beatLen * 2.6]] as const) {
          const f = midiToHz(note(chord, off, 2 + up) + kit.shift());
          for (const detune of [-7, 6]) kit.tone(t + at, { type: 'sawtooth', freq: f, detune, dur, gain: 0.032, lpf: 600, lpfEnd: 2000, q: 1.4, attack: 0.03, hold: dur * 0.5, send: 0.45 });
          kit.tone(t + at, { type: 'triangle', freq: f, dur, gain: 0.032, attack: 0.02, hold: dur * 0.5, send: 0.45 });
        }
        if (drive) kit.war(t, 0.07, 0.9);
      }
      if (dense && drive && s === steps - stepsPerBeat && bar % 2 === 1) kit.tom(t, note(chord, 0, 1), 0.08);
      break;
    }
    case 'class':
      if (s === 0 && bar % 2 === 0) kit.choir(t, chordPad(chord, 2), barLen * 2, 0.012, 'ah');
      if (s === 0 && bar % 4 === 2) kit.wail(t, note(chord, dense ? 7 : 4, 3), barLen * 1.5, 0.035);
      if (dense && s === Math.floor(steps / 2) && bar % 2 === 0) kit.glass(t, note(chord, 4, 4), 0.03);
      break;
  }
}

const DEFS: Record<TrackKey, TrackDef> = {
  // -------------------------------------------------------------- menu / lobby: sparse, atmospheric
  menu: {
    gain: 1, steps: 16, stepsPerBeat: 4,
    bpm: () => 66,
    step({ kit, bar, s, t, barLen, chord }) {
      if (s === 0) {
        kit.pad(t, chordPad(chord, 1), barLen, 0.03, 620 + 260 * Math.sin(bar * 0.7));
        kit.drone(t, note(chord, 0, 0), barLen, 0.09);
        if (bar % 4 === 0) kit.bell(t, TONIC + OCTAVE, 0.09); // the Last Bell
        if (bar % 8 === 4) kit.choir(t, chordPad(chord, 1), barLen * 2, 0.012, 'oo');
        if (bar % 2 === 1) kit.war(t, 0.05, 0.8);
      }
      if (s === 3 && bar % 2 === 1) kit.war(t, 0.035, 0.8);
      if (s % 2 === 0 && rnd(bar * 16 + s, 1) < 0.13) {
        const pick = BELL_STEPS[Math.floor(rnd(bar * 16 + s, 2) * BELL_STEPS.length)];
        kit.glass(t, note(chord, pick, 2), 0.05);
      }
      if (s === 8 && rnd(bar, 3) < 0.6) kit.glass(t, note(chord, 4, 2), 0.04);
    },
  },
  // -------------------------------------------------------------- draft / doors: calm interlude
  calm: {
    gain: 1, steps: 16, stepsPerBeat: 4,
    bpm: () => 84,
    step({ kit, bar, s, t, barLen, chord, section, tint }) {
      if (s === 0) {
        kit.pad(t, chordPad(chord, 1), barLen, 0.027, 900);
        kit.drone(t, note(chord, 0, 0), barLen, 0.075);
        if (bar % 2 === 0) kit.tom(t, TONIC + OCTAVE, 0.06);
      }
      if (s % 2 === 0 && rnd(bar * 16 + s, 4) >= 0.18) {
        const arp = (section + bar) % 2 === 0 ? ARP_A : ARP_B;
        const midi = note(chord, arp[(s / 2 + (bar % 2) * 3) % arp.length], 2);
        if (tint.drip && s % 4 === 2) kit.drop(t, midi + OCTAVE, 0.05);
        else kit.pluck(t, midi, 0.065);
      }
      if (s === 12 && bar % 4 === 3) kit.bell(t, note(chord, 4, 2), 0.04);
    },
  },
  // -------------------------------------------------------------- keystone draft: held, expectant, unresolved
  keydraft: {
    gain: 0.9, steps: 16, stepsPerBeat: 4,
    bpm: () => 60,
    step({ kit, bar, s, t, sd, barLen, chord }) {
      if (s === 0) {
        // a suspended chord: root, fourth and fifth — the third that would decide it is never played
        kit.pad(t, [note(chord, 0, 1), note(chord, 3, 1), note(chord, 4, 1)], barLen, 0.03, 1300);
        kit.drone(t, note(I, 0, 0), barLen, 0.085);
        kit.tremolo(t, [note(I, 4, 2)], barLen, 0.008);
        if (bar % 4 === 0) kit.choir(t, [note(chord, 0, 2), note(chord, 4, 2)], barLen * 2, 0.011, 'oo');
        if (bar % 4 === 2) kit.bell(t, TONIC + OCTAVE, 0.05);
      }
      // a slow heart under it
      if (s === 0 || s === 3) kit.tone(t, { freq: 64, freqEnd: 42, dur: 0.2, gain: s === 0 ? 0.11 : 0.07 });
      // one high note asked again and again, its answer a step short of home
      if (s === 8) kit.glass(t, note(I, 8, 3), 0.045);
      if (s === 12 && bar % 2 === 1) kit.glass(t, note(I, 7 + (bar % 4 === 3 ? 2 : 1), 3), 0.035);
      if (s === 14 && bar % 4 === 3) kit.noise(t, { dur: sd * 2, gain: 0.02, filter: 'bandpass', freq: 1200, freqEnd: 5200, q: 2, attack: sd * 1.6 });
    },
  },
  // -------------------------------------------------------------- combat: dark, pulsing
  combat: {
    gain: 1, steps: 16, stepsPerBeat: 4,
    bpm: () => 114,
    step({ kit, bar, s, t, sd, barLen, chord, section, tint }) {
      const idx = bar * 16 + s;
      if (KICKS[bar % KICKS.length].includes(s)) kit.kick(t, 0.3);
      if (s === 4 || s === 12) kit.snare(t, 0.17);
      if (bar % 8 === 7 && s >= 13) kit.snare(t, 0.09 + 0.03 * (s - 13));
      if (bar % 16 === 15 && s >= 8 && s < 12) kit.tom(t, FILL_TOMS[s - 8], 0.14);
      if (s % 2 === 0) kit.hat(t, 0.04);
      else if (rnd(idx, 5) < 0.28) kit.hat(t, 0.025);
      if (bar % 2 === 1 && s === 14) kit.hat(t, 0.045, true);
      // skeleton colour: bone knocks ghosting the off-beats
      if (s % 4 === 3 && rnd(idx, 9) < 0.5) kit.bone(t, 1.2 + 0.2 * (bar % 3), 0.035);
      if (tint.anvil && (s === 6 || (s === 14 && bar % 2 === 1))) kit.anvil(t, 0.045);
      if (tint.drip && s === 10 && bar % 2 === 0) kit.drop(t, note(chord, 4, 3), 0.04);
      if ((section === 0 ? BASS_A : BASS_B)[s] === 1) {
        const offset = s === 10 ? 7 : s === 13 ? 4 : 0;
        kit.bass(t, note(chord, offset, 0), sd * 1.6, 0.17, 360 + 220 * ((bar % 8) / 8));
      }
      if (s === 0) {
        kit.pad(t, chordPad(chord, 1), barLen, 0.022, 1000);
        if (bar % 8 === 0) kit.war(t, 0.1);
      }
      const leading = bar % 8 >= 4 || (section === 1 && bar % 4 >= 2);
      if (leading) {
        const step = PHRASES[Math.floor(rnd(bar, 7) * PHRASES.length)][s];
        if (step !== null) kit.lead(t, note(chord, step, 2), sd * 1.8, 0.045, 1700);
      }
    },
  },
  // -------------------------------------------------------------- elite: more drive
  elite: {
    gain: 1, steps: 16, stepsPerBeat: 4,
    bpm: () => 124,
    step({ kit, bar, s, t, sd, barLen, chord, section, tint }) {
      const idx = bar * 16 + s;
      if (s % 4 === 0) kit.kick(t, 0.32);
      if ((s === 10 && bar % 2 === 1) || (s === 15 && bar % 4 === 3)) kit.kick(t, 0.23);
      if (s === 4 || s === 12) kit.snare(t, 0.19);
      if ((s === 7 || s === 9) && rnd(idx, 6) < 0.4) kit.snare(t, 0.06);
      if (bar % 4 === 3 && s >= 12) kit.tom(t, FILL_TOMS[s - 12], 0.15);
      kit.hat(t, s % 4 === 2 ? 0.05 : 0.027, bar % 2 === 1 && (s === 6 || s === 14));
      if (s === 0 && bar % 4 === 0) kit.war(t, 0.12);
      if (tint.anvil && (s === 2 || s === 10)) kit.anvil(t, 0.04);
      if (tint.drip && s === 6 && bar % 2 === 0) kit.drop(t, note(chord, 2, 3), 0.04);
      const sweep = Math.abs(((bar % 8) / 4) - 1);
      kit.bass(t, note(chord, DRIVE_OFFSETS[s], 0), sd * 1.1, s % 4 === 0 ? 0.16 : 0.11, 430 + 300 * (1 - sweep));
      if (s === 0) {
        kit.pad(t, chordPad(chord, 1), barLen, 0.02, 1200);
        if (section === 1 && bar % 4 === 0) kit.tremolo(t, [note(chord, 0, 2), note(chord, 4, 2)], barLen * 2, 0.012);
      }
      const stabs = section === 0 ? [3, 6, 11] : [0, 3, 6, 10, 13];
      if (stabs.includes(s)) kit.stab(t, chordPad(chord, 2), 0.036);
      if (bar % 4 >= 2) {
        const step = PHRASES[(bar + Math.floor(rnd(bar, 8) * 2)) % PHRASES.length][s];
        if (step !== null) kit.lead(t, note(chord, step, 2), sd * 1.6, 0.05, 2200);
      }
    },
  },
  // -------------------------------------------------------------- Bone Regent: bell, choir, war drums
  'boss:regent': {
    gain: 1, steps: 16, stepsPerBeat: 4,
    bpm: (phase) => (phase >= 3 ? 146 : phase === 2 ? 138 : 132),
    step({ kit, bar, s, t, sd, barLen, chord, section, phase, tint }) {
      if (s % 4 === 0) kit.kick(t, 0.33);
      if (s === 14 || s === 15) kit.kick(t, 0.21);
      if (phase >= 2 && bar % 2 === 1 && (s === 6 || s === 7)) kit.kick(t, 0.19);
      if (phase >= 3 && (s === 2 || s === 10)) kit.kick(t, 0.17);
      if (s === 4 || s === 12) kit.snare(t, 0.2);
      if (phase >= 2 && bar % 2 === 0 && s === 15) kit.snare(t, 0.11);
      if (bar % 4 === 3 && s >= 12) kit.snare(t, 0.09 + 0.026 * (s - 12));
      if (bar % 2 === 0 && (s === 3 || s === 6 || s === 11)) kit.tom(t, TONIC + OCTAVE, 0.13);
      if (bar % 2 === 1 && (s === 10 || s === 13)) kit.tom(t, TONIC + 7, 0.14);
      if (s === 0 && bar % 2 === 0) kit.war(t, 0.13 + 0.02 * phase);
      kit.hat(t, phase >= 2 ? 0.038 : 0.029, s % 8 === 6);
      if (tint.anvil && (s === 6 || s === 14)) kit.anvil(t, 0.04);
      // driving bass with a Phrygian flat-second pickup into the next bar on the tonic chord
      const pickup = s === 15 && chord.root === 0;
      const midi = pickup ? TONIC + 1 : note(chord, DRIVE_OFFSETS[s] === 4 ? 7 : DRIVE_OFFSETS[s], 0);
      kit.bass(t, midi, sd * 1.05, s % 4 === 0 ? 0.17 : 0.12, 400 + 130 * phase);
      if (s === 0) {
        kit.pad(t, chordPad(chord, 1), barLen, 0.02, 1100);
        if (bar % 2 === 0) kit.choir(t, chordPad(chord, phase >= 3 ? 2 : 1), barLen * 2, 0.01 + 0.004 * phase, 'ah');
        if (bar % 8 === 0) kit.bell(t, TONIC + OCTAVE, 0.08);
      }
      if (phase >= 2 && (s === 6 || s === 14)) kit.stab(t, chordPad(chord, 2), 0.032);
      if (phase >= 3 && bar % 2 === 1 && (s === 0 || s === 8)) {
        const root = note(chord, 0, 2);
        kit.stab(t, [root, root + 6], 0.046); // tritone
      }
      if (phase === 1) {
        if (bar % 8 >= 4) {
          const step = PHRASES[(bar + section) % PHRASES.length][s];
          if (step !== null) kit.lead(t, note(chord, step, 2), sd * 1.6, 0.05, 2000);
        }
      } else if (bar % 4 >= 2 && (phase >= 3 || s % 2 === 0)) {
        const k = phase >= 3 ? s : s / 2;
        kit.lead(t, note(chord, RUN_ARP[(k + bar) % RUN_ARP.length], 2 + (section + (bar >> 1)) % 2), sd * 0.9, 0.036, 2600);
      }
    },
  },
  // -------------------------------------------------------------- Hex Matron: a slow, cold dance in 12/8
  'boss:matron': {
    gain: 1, steps: 12, stepsPerBeat: 3,
    bpm: (phase) => (phase >= 3 ? 108 : phase === 2 ? 100 : 92),
    step({ kit, bar, s, t, sd, barLen, chord, section, phase, tint }) {
      // heartbeat instead of a beat: two soft thuds, then air
      if (s === 0) kit.kick(t, 0.3);
      if (s === 2) kit.kick(t, 0.17);
      if (phase >= 2 && s === 6) kit.snare(t, 0.15);
      if (phase >= 2 && s === 9 && bar % 2 === 1) kit.kick(t, 0.2);
      if (phase >= 3) {
        if (s % 3 === 0) kit.hat(t, 0.035);
        if (bar % 2 === 1 && s >= 9) kit.tom(t, FILL_TOMS[s - 9], 0.12);
      }
      if (s === 6 && phase === 1) kit.hat(t, 0.03, true);
      if (tint.anvil && s === 9) kit.anvil(t, 0.035);
      // glass arpeggio: every other step at first, every step once she is enraged
      if (phase >= 3 || s % 2 === 0 || (phase === 2 && s % 3 === 1)) {
        const up = (section + (bar >> 2)) % 2;
        const midi = note(chord, MATRON_ARP[(s + bar * 5) % MATRON_ARP.length], 2 + up);
        if (tint.drip && s % 6 === 4) kit.drop(t, midi, 0.04);
        else kit.glass(t, midi, 0.04 + 0.006 * phase);
      }
      if (s === 0 || s === 6) kit.bass(t, note(chord, s === 6 ? 4 : 0, 0), sd * 5, 0.15, 300 + 90 * phase);
      if (phase >= 2 && (s === 3 || s === 9)) kit.bass(t, note(chord, 7, 0), sd * 1.5, 0.1, 420);
      if (s === 0) {
        kit.choir(t, chordPad(chord, 2), barLen, 0.011 + 0.003 * phase, 'oo');
        kit.pad(t, chordPad(chord, 1), barLen, 0.018, 800 + 200 * phase);
        if (bar % 8 === 0) kit.bell(t, TONIC + 2 * OCTAVE, 0.045);
        if (phase >= 3 && bar % 2 === 0) kit.tremolo(t, [note(chord, 0, 3), note(chord, 2, 3)], barLen * 2, 0.008);
      }
      // her melody: long, wavering notes that lean on the raised seventh
      if (bar % 4 >= 2 || phase >= 2) {
        for (const [at, offset, len] of MATRON_MELODY[(bar + section) % MATRON_MELODY.length]) {
          if (at === s) kit.wail(t, note(chord, offset, 2), sd * len, 0.05);
        }
      }
    },
  },
  // -------------------------------------------------------------- Ossuary Stalker: a fast, dry hunt
  'boss:stalker': {
    gain: 1, steps: 16, stepsPerBeat: 4,
    bpm: (phase) => (phase >= 3 ? 164 : phase === 2 ? 156 : 150),
    step({ kit, bar, s, t, sd, barLen, chord, section, phase, tint }) {
      const idx = bar * 16 + s;
      // every fourth bar the hunt holds its breath for half a bar, then strikes
      const hush = bar % 4 === 3 && s >= 8;
      if (hush) {
        if (s === 8) kit.tremolo(t, [TONIC + 2 * OCTAVE, TONIC + 2 * OCTAVE + 6], sd * 8, 0.02);
        if (s === 14) kit.war(t, 0.16, 1.1);
        if (s === 15) kit.war(t, 0.2, 0.9);
        return;
      }
      const accent = STALKER_BONES[(s + (bar % 2) * 3) % STALKER_BONES.length];
      if (accent > 0) kit.bone(t, accent === 2 ? 1 : 1.5 + 0.25 * ((idx >> 1) % 3), accent === 2 ? 0.075 : 0.035);
      if (STALKER_PULSE.includes(s)) {
        kit.kick(t, s === 0 ? 0.34 : 0.24);
        kit.bass(t, note(chord, s === 10 ? 1 : 0, 0), sd * 1.4, 0.19, 300 + 120 * phase);
      }
      if (phase >= 2 && (s === 4 || s === 12)) kit.snare(t, 0.18);
      if (phase >= 2 && s % 2 === 1 && rnd(idx, 11) < 0.5) kit.hat(t, 0.03);
      if (phase >= 3) kit.hat(t, s % 4 === 2 ? 0.045 : 0.025);
      else if (phase === 1 && s % 4 === 2) kit.hat(t, 0.02);
      if (tint.anvil && s === 12) kit.anvil(t, 0.045);
      if (tint.drip && s === 6 && bar % 2 === 1) kit.drop(t, note(chord, 4, 3), 0.04);
      if (s === 0) {
        if (bar % 4 === 0) kit.war(t, 0.15);
        // thin, cold harmony: an open fifth, later with the tritone on top
        kit.pad(t, [note(chord, 0, 1), note(chord, 4, 1)], barLen, 0.016, 700 + 250 * phase);
        if (phase >= 2 && bar % 2 === 1) kit.tremolo(t, [note(chord, 0, 2) + 6], barLen, 0.012);
      }
      if (bar % 2 === 1 && (s === 3 || s === 11)) kit.stab(t, [note(chord, 0, 2), note(chord, 0, 2) + 6], 0.034 + 0.006 * phase);
      if (bar % 8 >= 4 || phase >= 3) {
        const step = STALKER_MOTIFS[(bar + section) % STALKER_MOTIFS.length][s];
        if (step !== null) {
          // Phrygian: the second degree is flattened
          const midi = note(chord, step, phase >= 3 ? 3 : 2) - (((chord.root + step) % SCALE.length) === 1 ? 1 : 0);
          kit.lead(t, midi, sd * 1.2, 0.05, 2400 + 300 * phase);
        }
      }
    },
  },
  // -------------------------------------------------------------- survive: a relentless pulse that tightens
  'obj:survive': {
    gain: 1.12, steps: 16, stepsPerBeat: 4,
    bpm: (_phase, obj) => OBJECTIVE_MUSIC.SURVIVE_BPM + OBJECTIVE_MUSIC.SURVIVE_BPM_GAIN * obj.pressure,
    step({ kit, bar, s, t, sd, barLen, chord, tint, obj }) {
      const p = obj.pressure;
      const idx = bar * 16 + s;
      // four on the floor, and a clock: tick on the off-beat, tock a third lower
      if (s % 4 === 0) kit.kick(t, 0.3 + 0.04 * p);
      if (s % 4 === 2) kit.bone(t, s % 8 === 2 ? 1.6 : 1.3, 0.045 + 0.02 * p);
      if (s === 4 || s === 12) kit.snare(t, 0.14 + 0.05 * p);
      // the pulse: eighths on the root, sixteenths once half the time is gone
      if (s % 2 === 0 || p > 0.5) {
        kit.bass(t, note(chord, s % 8 === 6 ? 7 : 0, 0), sd * 0.9, s % 4 === 0 ? 0.16 : 0.1 + 0.03 * p, 320 + 500 * p);
      }
      if (s % 2 === 0) kit.hat(t, 0.035);
      else if (rnd(idx, 31) < 0.2 + 0.7 * p) kit.hat(t, 0.022);
      // the last quarter: a snare roll into every second bar
      if (p > 0.75 && bar % 2 === 1 && s >= 12) kit.snare(t, 0.06 + 0.03 * (s - 12));
      if (tint.anvil && s === 6) kit.anvil(t, 0.04);
      if (tint.drip && s === 10 && bar % 2 === 0) kit.drop(t, note(chord, 4, 3), 0.04);
      if (s === 0) {
        kit.pad(t, chordPad(chord, 1), barLen, 0.02, 800 + 900 * p);
        if (bar % 4 === 0) kit.war(t, 0.1 + 0.06 * p);
        if (p > 0.4) kit.tremolo(t, [note(chord, 0, 2), note(chord, 4, 2)], barLen, 0.005 + 0.01 * p);
      }
      if (p > 0.6 && bar % 4 >= 2) {
        const step = PHRASES[Math.floor(rnd(bar, 7) * PHRASES.length)][s];
        if (step !== null) kit.lead(t, note(chord, step, 2), sd * 1.6, 0.045, 1900);
      }
    },
  },
  // -------------------------------------------------------------- defend: anchored on the tonic
  'obj:defend': {
    gain: 0.66, steps: 16, stepsPerBeat: 4,
    bpm: () => 100,
    step({ kit, bar, s, t, sd, barLen, chord, tint, obj }) {
      if (s === 0) {
        // the anchor: tonic and fifth held under everything, whatever the chord
        kit.drone(t, TONIC, barLen, 0.11);
        kit.drone(t, TONIC + 7, barLen, 0.05);
        kit.pad(t, chordPad(chord, 1), barLen, 0.022, 800);
        if (bar % 2 === 0) kit.bell(t, TONIC + 2 * OCTAVE, 0.06); // the shard rings
        if (bar % 4 === 2) kit.choir(t, [TONIC + 2 * OCTAVE, TONIC + 2 * OCTAVE + 7], barLen * 2, 0.011, 'oo');
        // a wounded shard: the fifth above it starts to shake
        if (obj.pressure > 0.5) kit.tremolo(t, [TONIC + 2 * OCTAVE + 7], barLen, 0.004 + 0.012 * (obj.pressure - 0.5));
      }
      // half time: the back beat falls on three
      if (s === 0 || s === 10) kit.kick(t, 0.3);
      if (s === 8) kit.snare(t, 0.16);
      if (s === 8 && bar % 2 === 1) kit.war(t, 0.1, 0.9);
      if (s % 4 === 2) kit.hat(t, 0.03);
      if (s === 0 || s === 6 || s === 10) kit.bass(t, TONIC, sd * 2.4, 0.15, 300);
      if (tint.anvil && s === 14) kit.anvil(t, 0.04);
      if (tint.drip && s === 6 && bar % 2 === 1) kit.drop(t, note(chord, 4, 3), 0.04);
      if (bar % 4 >= 2 && s === 0) kit.wail(t, note(chord, bar % 4 === 2 ? 4 : 2, 2), barLen * 0.9, 0.045);
    },
  },
  // -------------------------------------------------------------- hunt: a driving ostinato
  'obj:hunt': {
    gain: 1.1, steps: 16, stepsPerBeat: 4,
    bpm: (_phase, obj) => (obj.pressure >= 1 ? OBJECTIVE_MUSIC.HUNT_BPM_ENRAGED : OBJECTIVE_MUSIC.HUNT_BPM),
    step({ kit, bar, s, t, sd, barLen, chord, tint, obj }) {
      const enraged = obj.pressure >= 1;
      const off = HUNT_OSTINATO[s];
      const flat = ((chord.root + off) % SCALE.length) === 1 ? 1 : 0;
      kit.pluck(t, note(chord, off, 1) - flat, s % 4 === 0 ? 0.075 : 0.05);
      if (s % 2 === 0) kit.bass(t, note(chord, off, 0) - flat, sd * 0.9, s % 4 === 0 ? 0.15 : 0.1, 380 + 240 * obj.pressure);
      if (s % 4 === 0) kit.kick(t, 0.31);
      if (s === 14 && bar % 2 === 1) kit.kick(t, 0.22);
      if (s === 4 || s === 12) kit.snare(t, 0.17);
      // a gallop on the toms
      if (s % 4 === 3) kit.tom(t, FILL_TOMS[(s >> 2) % FILL_TOMS.length] - OCTAVE, 0.07);
      kit.hat(t, s % 2 === 0 ? 0.04 : 0.022);
      if (tint.anvil && s === 10) kit.anvil(t, 0.04);
      if (tint.drip && s === 6 && bar % 2 === 0) kit.drop(t, note(chord, 4, 3), 0.04);
      if (s === 0) kit.pad(t, [note(chord, 0, 1), note(chord, 4, 1)], barLen, 0.016, 900);
      // the horn: a call every four bars, root then up a fourth
      if (bar % 4 === 0 && s === 0) kit.lead(t, note(chord, 0, 2), sd * 3, 0.05, 2000);
      if (bar % 4 === 0 && s === 4) kit.lead(t, note(chord, 3, 2), sd * 6, 0.05, 2000);
      if (enraged) {
        if (s === 3 || s === 11) kit.stab(t, [note(chord, 0, 2), note(chord, 0, 2) + 6], 0.04);
        if (s === 0 && bar % 2 === 0) kit.tremolo(t, [note(chord, 0, 2) + 6], barLen * 2, 0.012);
      }
    },
  },
  // -------------------------------------------------------------- ritual: one layer per burning brazier
  'obj:ritual': {
    gain: 0.8, steps: 16, stepsPerBeat: 4,
    bpm: (_phase, obj) => OBJECTIVE_MUSIC.RITUAL_BPM + OBJECTIVE_MUSIC.RITUAL_BPM_PER_SITE * Math.min(OBJECTIVE_MUSIC.LIT_MAX, obj.lit),
    step({ kit, bar, s, t, sd, barLen, chord, section, tint, obj }) {
      const lit = Math.min(OBJECTIVE_MUSIC.LIT_MAX, obj.lit);
      // the frame, always: drone, a hand drum, bones
      if (s === 0) {
        kit.drone(t, TONIC, barLen, 0.09);
        kit.pad(t, chordPad(chord, 1), barLen, 0.018, 700 + 250 * lit);
        // every burning brazier is a bell note in the bar that opens a phrase
        if (bar % 4 === 0) for (let i = 0; i < lit; i++) kit.glass(t + i * sd * 2, TONIC + 2 * OCTAVE + BRAZIER_NOTES[i], 0.07);
      }
      if (s === 0 || s === 6 || s === 10) kit.tom(t, TONIC + OCTAVE, s === 0 ? 0.11 : 0.07);
      if (s % 4 === 2) kit.bone(t, 1.1 + 0.2 * (bar % 2), 0.035);
      if (tint.anvil && s === 14) kit.anvil(t, 0.04);
      if (tint.drip && s === 6 && bar % 2 === 1) kit.drop(t, note(chord, 4, 3), 0.04);
      if (lit >= 1 && s % 2 === 0) {
        const arp = (section + bar) % 2 === 0 ? ARP_A : ARP_B;
        kit.glass(t, note(chord, arp[(s / 2) % arp.length], 2), 0.04);
      }
      if (lit >= 2) {
        if (s % 4 === 0) kit.kick(t, 0.28);
        if (BASS_A[s] === 1) kit.bass(t, note(chord, s === 10 ? 7 : 0, 0), sd * 1.6, 0.15, 380);
        if (s % 2 === 0) kit.hat(t, 0.035);
      }
      if (lit >= OBJECTIVE_MUSIC.LIT_MAX) {
        if (s === 4 || s === 12) kit.snare(t, 0.16);
        if (s === 0 && bar % 2 === 0) kit.choir(t, chordPad(chord, 2), barLen * 2, 0.012, 'ah');
        if (bar % 4 >= 2) {
          const step = PHRASES[Math.floor(rnd(bar, 7) * PHRASES.length)][s];
          if (step !== null) kit.lead(t, note(chord, step, 2), sd * 1.8, 0.045, 1900);
        }
      }
    },
  },
  // -------------------------------------------------------------- vault: sparse and warm
  'obj:vault': {
    gain: 0.85, steps: 16, stepsPerBeat: 4,
    bpm: () => 66,
    step({ kit, bar, s, t, barLen, chord }) {
      const idx = bar * 16 + s;
      if (s === 0) {
        kit.pad(t, chordPad(chord, 1), barLen, 0.03, 900);
        kit.drone(t, note(chord, 0, 0), barLen, 0.07);
      }
      if (s % 4 === 0 && rnd(idx, 4) >= 0.25) kit.pluck(t, note(chord, ARP_A[(s / 4 + bar) % ARP_A.length], 2), 0.06);
      // glints, like coins catching the light
      if (s % 2 === 0 && rnd(idx, 41) < 0.1) kit.glass(t, note(chord, BELL_STEPS[Math.floor(rnd(idx, 42) * BELL_STEPS.length)], 3), 0.03);
      if (bar % 4 === 3 && s === 8) kit.bell(t, note(chord, 4, 2), 0.035);
    },
  },
};

/** Pieces without a beat: the depth overlay leaves its pulse out of them. */
const NO_DRIVE: ReadonlySet<TrackKey> = new Set<TrackKey>(['calm', 'keydraft', 'obj:vault']);
/** Pieces outside a fight: the keystone voices stay out of them. */
const NO_KEYSTONE_VOICES: ReadonlySet<TrackKey> = new Set<TrackKey>(['menu', 'calm', 'keydraft']);

interface Track {
  key: TrackKey;
  /** Voices connect here. */
  input: GainNode;
  filter: BiquadFilterNode;
  out: GainNode;
  send: GainNode;
  kit: Kit;
  step: number;
  next: number;
  /** Time at which the faded-out track is dropped. */
  dieAt: number;
  /** Depth the track is playing at (taken over at bar lines only). */
  pitch: { depth: number };
  /** Keystone voices the track is playing (taken over at bar lines only). */
  voices: ScoreVoice[];
}

export type Music = ReturnType<typeof createMusic>;

export function createMusic(g: AudioGraph, player: Player | null = null) {
  let tracks: Track[] = [];
  let current: MusicState = 'none';
  let currentKey: TrackKey | null = null;
  let bossPhase = 1;
  let bossKind: BossKind = 'regent';
  let biome: BiomeId = 'crypt';
  let depth = 0;
  let objective: SpecialObjective | null = null;
  const obj: ObjectiveMusic = { pressure: 0, lit: 0 };
  let voices: ScoreVoice[] = [];
  let keystoneDraft = false;

  const tint = (): Tint => TINTS[biome];

  const fadeOut = (fade: number, now: number): void => {
    for (const track of tracks) {
      if (track.dieAt !== Infinity) continue;
      for (const param of [track.out.gain, track.send.gain]) {
        param.cancelScheduledValues(now);
        param.setValueAtTime(param.value, now);
        param.linearRampToValueAtTime(MIX.SILENCE, now + fade);
      }
      track.dieAt = now + fade + 0.1;
    }
  };

  const keyOf = (state: Exclude<MusicState, 'none'>): TrackKey =>
    (state === 'boss' ? `boss:${bossKind}` : state === 'combat' && objective ? `obj:${objective}` : state === 'calm' && keystoneDraft ? 'keydraft' : state);

  /** Crossfades to another state. No-op when it is already playing. */
  const setState = (next: MusicState, fade: number = MUSIC.CROSSFADE): void => {
    const key = next === 'none' ? null : keyOf(next);
    if (next === current && key === currentKey) return;
    const now = g.ctx.currentTime;
    current = next;
    currentKey = key;
    fadeOut(fade, now);
    if (!key) return;
    const input = g.ctx.createGain();
    const filter = g.ctx.createBiquadFilter();
    const out = g.ctx.createGain();
    const send = g.ctx.createGain();
    filter.type = 'lowpass';
    filter.Q.value = 0.5;
    filter.frequency.value = tint().cutoff;
    out.gain.setValueAtTime(MIX.SILENCE, now);
    out.gain.linearRampToValueAtTime(DEFS[key].gain, now + fade);
    send.gain.setValueAtTime(MIX.SILENCE, now);
    send.gain.linearRampToValueAtTime(tint().send, now + fade);
    input.connect(filter).connect(out).connect(g.musicIn);
    send.connect(g.musicReverbIn);
    // the menu is not part of a descent and always plays at home
    const pitch = { depth: key === 'menu' ? 0 : depth };
    const kit = createKit(g, player, { out: input, send, tint, shift: () => pitch.depth * DEPTH.SEMITONES_PER_DEPTH });
    tracks.push({ key, input, filter, out, send, kit, step: 0, next: now + MUSIC.START_DELAY, dieAt: Infinity, pitch, voices });
  };

  /** Schedules every active track up to `until` (defaults to now + look-ahead). */
  const schedule = (until: number = g.ctx.currentTime + MUSIC.LOOKAHEAD): void => {
    const now = g.ctx.currentTime;
    tracks = tracks.filter((track) => {
      if (now <= track.dieAt) return true;
      track.out.disconnect();
      track.send.disconnect();
      return false;
    });
    for (const track of tracks) {
      const def = DEFS[track.key];
      const sd = 60 / def.bpm(bossPhase, obj) / def.stepsPerBeat;
      if (track.next < now - MUSIC.MAX_LAG) {
        const missed = Math.ceil((now - track.next) / sd);
        track.step += missed;
        track.next += missed * sd;
      }
      const end = Math.min(until, track.dieAt);
      while (track.next < end) {
        const bar = Math.floor(track.step / def.steps);
        const s = track.step % def.steps;
        if (s === 0 && track.key !== 'menu') track.pitch.depth = depth;
        const c: StepCtx = {
          kit: track.kit, bar, s, t: track.next, sd, barLen: sd * def.steps,
          chord: PROGRESSION[track.key][bar % MUSIC.BARS_PER_CYCLE],
          section: Math.floor(bar / MUSIC.BARS_PER_CYCLE) % 2, phase: bossPhase, tint: tint(), obj,
        };
        def.step(c);
        if (track.pitch.depth > 0) depthLayer(c, track.pitch.depth, def.steps, def.stepsPerBeat, !NO_DRIVE.has(track.key));
        if (s === 0) track.voices = voices;
        if (track.voices.length > 0 && !NO_KEYSTONE_VOICES.has(track.key)) {
          for (const voice of track.voices) keystoneLayer(c, voice.family, voice.dense, def.steps, def.stepsPerBeat, !NO_DRIVE.has(track.key));
        }
        track.next += sd;
        track.step++;
      }
    }
  };

  const setBossPhase = (phase: number): void => {
    bossPhase = Math.min(MUSIC.MAX_BOSS_PHASE, Math.max(1, Math.round(phase)));
  };

  /** Which final boss the 'boss' state plays for. Takes effect on the next setState('boss'). */
  const setBossKind = (kind: BossKind): void => {
    bossKind = kind;
  };

  /**
   * The objective of the chamber (null or 'slay' = the plain combat piece) and what its piece should follow.
   * A change of kind while the combat state plays crossfades to the other piece; `pressure` and `lit` are read
   * by the running piece step by step, so tempo and layers move without a seam.
   */
  const setObjective = (kind: ObjectiveKind | null, pressure = 0, lit = 0): void => {
    const next = kind === null || kind === 'slay' ? null : kind;
    obj.pressure = Math.min(1, Math.max(0, pressure));
    obj.lit = Math.max(0, Math.floor(lit));
    if (next === objective) return;
    objective = next;
    if (current === 'combat') setState('combat');
  };

  /**
   * The voices the own hero's keystones add to the fighting pieces (keystone-map.ts `scoreVoices`). Running tracks
   * take them over at their next bar line; the calm interlude and the menu never play them.
   */
  const setKeystones = (next: readonly ScoreVoice[]): void => {
    if (voicesKey(next) === voicesKey(voices)) return;
    voices = next.slice();
  };

  /** The own keystone draft is open: the calm interlude is replaced by the held, expectant bed (and back). */
  const setKeystoneDraft = (on: boolean): void => {
    if (on === keystoneDraft) return;
    keystoneDraft = on;
    if (current === 'calm') setState('calm');
  };

  /** How deep the party is (RunState.depth). Running tracks follow at their next bar line. */
  const setDepth = (next: number): void => {
    depth = Math.min(DEPTH.MAX, Math.max(0, Math.floor(next)));
  };

  /** Tints running and future tracks for a biome. */
  const setBiome = (next: BiomeId): void => {
    if (next === biome) return;
    biome = next;
    const now = g.ctx.currentTime;
    for (const track of tracks) {
      if (track.dieAt !== Infinity) continue;
      track.filter.frequency.setTargetAtTime(tint().cutoff, now, MUSIC.CROSSFADE / 3);
      track.send.gain.setTargetAtTime(tint().send, now, MUSIC.CROSSFADE / 3);
      track.kit.applyTint();
    }
  };

  /**
   * One-shot victory / defeat cue. Fades the running state out first. `cleared` = final bosses slain in the run:
   * a victory after one or more descents gets a second, higher phrase and a bell per boss; a defeat in the deep
   * (cleared > 0 — the run still counts as won) ends its lament on a major chord.
   */
  const stinger = (kind: 'victory' | 'defeat', cleared = kind === 'victory' ? 1 : 0): void => {
    setState('none', MUSIC.STINGER_FADE);
    const kit = createKit(g, player, { out: g.musicIn, send: g.musicReverbIn, tint, shift: () => 0 });
    const t = g.ctx.currentTime + 0.12;
    const D = TONIC + OCTAVE; // D3
    if (kind === 'victory') {
      for (let i = 0; i < 7; i++) kit.tom(t + i * (0.11 - i * 0.006), D, 0.09 + i * 0.022);
      const hit = t + 0.72;
      kit.kick(hit, 0.36);
      kit.war(hit, 0.2);
      kit.noise(hit, { dur: 1.8, gain: 0.08, filter: 'highpass', freq: 6000, send: 0.4 });
      // D major: the Picardy third resolves the minor-key score
      kit.pad(hit, [D, D + 7, D + 12, D + 16, D + 19], 2.6, 0.028, 2200);
      kit.choir(hit, [D + 12, D + 16, D + 19], 2.4, 0.016, 'ah');
      const fanfare: [number, number, number][] = [[0, 24, 0.24], [0.25, 24, 0.24], [0.5, 31, 0.6], [1.2, 28, 0.2], [1.42, 31, 0.2], [1.65, 36, 1.9]];
      for (const [at, semi, dur] of fanfare) kit.lead(hit + at, D + semi, dur, 0.075, 3200);
      const last = hit + 1.65;
      kit.kick(last, 0.36);
      kit.war(last, 0.24, 0.9);
      kit.bell(last, D + 12, 0.07);
      kit.glass(last + 0.12, D + 43, 0.04);
      kit.noise(last, { dur: 2.2, gain: 0.08, filter: 'highpass', freq: 5500, send: 0.5 });
      if (cleared > 1) {
        // back from the deep: the call again, a fourth higher and home, and the Last Bell once per boss slain
        const again: [number, number, number][] = [[0.9, 41, 0.2], [1.12, 43, 0.2], [1.34, 48, 1.4]];
        for (const [at, semi, dur] of again) kit.lead(last + at, D + semi, dur, 0.06, 3600);
        kit.choir(last + 1.34, [D + 24, D + 28, D + 31], 1.4, 0.014, 'ah');
        for (let i = 0; i < Math.min(cleared, MUSIC.STINGER_BELLS_MAX); i++) kit.bell(last + 0.6 + i * 0.42, D + 12, 0.06);
      }
    } else {
      kit.tone(t, { freq: 72, freqEnd: 30, dur: 1.2, gain: 0.34 });
      kit.sample('drum.fill', t, 0.5, { variant: 2, rate: 0.7, send: 0.5 });
      kit.bell(t, D, 0.14);
      kit.tone(t, { type: 'sawtooth', freq: midiToHz(TONIC), dur: 4.4, gain: 0.06, lpf: 240, attack: 0.3, hold: 2 });
      kit.pad(t + 0.3, [D, D + 3, D + 7], 3.2, 0.028, 700);
      kit.choir(t + 0.3, [D, D + 3, D + 7], 3, 0.014, 'oo');
      const lament: [number, number, number][] = [[0.5, 15, 0.9], [1.3, 14, 0.9], [2.1, 12, 2.3]];
      for (const [at, semi, dur] of lament) kit.wail(t + at, D + semi, dur, 0.085);
      kit.bell(t + 2.1, D, 0.11);
      if (cleared > 0) {
        // fallen below, but the boss is dead: the last chord turns to major
        kit.pad(t + 3, [D, D + 4, D + 7, D + 12], 1.6, 0.03, 1600);
        kit.glass(t + 3.1, D + 28, 0.045);
        kit.glass(t + 3.3, D + 31, 0.04);
      }
    }
  };

  return {
    setState, schedule, setBossPhase, setBossKind, setBiome, setDepth, setObjective, setKeystones, setKeystoneDraft, stinger,
    keystoneVoices: (): string => voicesKey(voices),
    objective: (): SpecialObjective | null => objective,
    depth: (): number => depth,
    state: (): MusicState => current,
    key: (): string | null => currentKey,
    trackCount: (): number => tracks.length,
  };
}
