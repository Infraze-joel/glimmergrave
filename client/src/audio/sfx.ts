/**
 * Designed one-shot sound effects. Every sound is a layer stack: transient / body from samples (round robin,
 * random pitch and gain), plus synthesised layers where synthesis is the better tool (element colours, tonal
 * blooms, sweeps, growls). When the samples a stack needs are not decoded (yet), the event falls back to the
 * fully synthesised sound from sfx-synth.ts, so nothing is ever silent and nothing throws.
 *
 * Burst control, in three stages: a per-family window limiter with stack ducking (below), per-pool voice
 * limits with priority stealing (samples.ts) and the burst compressor on the combat buses (engine.ts).
 */
import { BOSS_KINDS, type ClassId, type DoorType, type ElementId, type EnemyKind, type Hazard } from '@shared/types.ts';
import { CLASSES } from '@shared/data/classes.ts';
import { midiToHz, noise, semitones, tone, type AudioGraph, type BusName } from './engine.ts';
import type { SampleGroup } from './manifest.ts';
import { createPlayer, VOICES, type Bank, type VoiceOpts } from './samples.ts';
import { createSynthSfx } from './sfx-synth.ts';

/** [max sounds, window seconds] per sound family. */
const LIMITS = {
  hit: [4, 0.05],
  tick: [2, 0.08],
  element: [3, 0.06],
  crit: [2, 0.08],
  kill: [3, 0.08],
  spawn: [3, 0.12],
  telegraph: [1, 0.12],
  aoe: [2, 0.1],
  resonance: [2, 0.12],
  cast: [4, 0.07],
  enemyCast: [2, 0.12],
  cue: [1, 0.3],
  hurt: [2, 0.1],
  heal: [1, 0.2],
  shield: [2, 0.12],
  status: [2, 0.1],
  hazard: [2, 0.12],
  ui: [3, 0.04],
  hover: [1, 0.045],
  big: [1, 0.25],
} as const;

type Family = keyof typeof LIMITS;

const TUNE = {
  /** Each extra sound inside a limiter window is this much quieter. */
  STACK_DUCK: 0.3,
  /** Damage at which a hit reaches full weight. */
  HEAVY_DAMAGE: 60,
  HEAVY_FROM: 0.4,
  OWN_GAIN: 1,
  OTHER_GAIN: 0.6,
  /** Hard cap of sounds started across all families per GLOBAL_WINDOW. */
  GLOBAL_MAX: 26,
  GLOBAL_WINDOW: 0.1,
  /** Resonances closer together than this chain: each one blooms a step higher. */
  CHAIN_WINDOW: 2,
  CHAIN_MAX: 6,
  CHAIN_RATE_STEP: 0.025,
  /** Second part of the Resonance burst (the detonation) lands this long after the first. */
  RESONANCE_GAP: 0.11,
} as const;

/** D minor colours shared with the music so effects sit in the same key. */
const NOTE = { D2: 38, A2: 45, D3: 50, F3: 53, A3: 57, D4: 62, F4: 65, Fs4: 66, A4: 69, D5: 74, F5: 77, Fs5: 78, A5: 81, D6: 86, F6: 89, A6: 93 } as const;
const PAIR_ROOT: Record<string, number> = { 'ember+rime': NOTE.D4, 'ember+storm': NOTE.F4, 'rime+storm': NOTE.A4 };
/** Semitones the Resonance bloom climbs per chain step (D natural minor). */
const CHAIN_STEPS = [0, 2, 3, 5, 7, 8, 10];
const BLOOM_CHORD = [0, 7, 12, 19];

/** Playback rates that land tuned samples on D. bell.1 hums at 380 Hz, bell.2 at 240 Hz (measured). */
const TUNED = {
  BELL1_D4: 293.66 / 380,
  BELL2_D3: 146.83 / 240,
  /** jingle.rise ends on G: a fourth down resolves it to D. */
  RISE_TO_D: semitones(-5),
  /** jingle.fifth is Eb-Bb: a semitone down makes it D-A. */
  FIFTH_TO_D: semitones(-1),
  /** jingle.magic climbs a whole-tone scale from C: start it on D. */
  MAGIC_TO_D: semitones(2),
  /** jingle.fall ends on D; an octave down turns it into a slow, dark descent. */
  FALL_DARK: 0.5,
} as const;

const CLATTER: SampleGroup[] = ['bone.tick', 'hit.bone', 'bone.tap', 'bone.tick'];

/** Samples a class's attack stack is built on; without them the synthesised attack plays. */
const PRIMARY_NEEDS: Record<ClassId, SampleGroup[]> = {
  knight: ['swing.blade', 'swing.cloth', 'swing.draw'],
  barbarian: ['swing.blade', 'swing.cloth', 'swing.draw'],
  mage: ['laser.small'],
  rogue: ['foley.latch', 'hit.bone', 'swing.blade'],
};
const SECONDARY_NEEDS: Record<ClassId, SampleGroup[]> = {
  knight: ['hit.plate', 'hit.clang', 'hit.heavy'],
  barbarian: ['swing.blade', 'swing.cloth', 'swing.draw'],
  mage: ['boom', 'boom.sub', 'field'],
  rogue: ['swing.blade', 'swing.draw'],
};

type CueName = 'beam' | 'wisp' | 'leap' | 'volley' | 'spear' | 'slam' | 'sweep' | 'charge' | 'summon' | 'blink';
/** Substring of the 'cast' ability id -> signature cue (first match wins). */
const CUES: [string, CueName][] = [
  ['beam', 'beam'], ['wisp', 'wisp'], ['leap', 'leap'], ['volley', 'volley'], ['spear', 'spear'], ['slam', 'slam'],
  ['sweep', 'sweep'], ['charge', 'charge'], ['summon', 'summon'], ['blink', 'blink'],
];
/** Per-caster colour of the cues: pitch factor and extra reverb. */
const TINT: Record<string, { rate: number; send: number }> = {
  regent: { rate: 0.84, send: 0.5 },
  matron: { rate: 1.2, send: 0.75 },
  stalker: { rate: 1.02, send: 0.3 },
  champion: { rate: 0.92, send: 0.4 },
  other: { rate: 1, send: 0.3 },
};

const isBoss = (kind: EnemyKind | null | undefined): boolean => kind !== null && kind !== undefined && (BOSS_KINDS as readonly string[]).includes(kind);
const isBig = (kind: EnemyKind | null | undefined): boolean => kind === 'champion' || isBoss(kind);
const rnd = (a: number, b: number): number => a + Math.random() * (b - a);

export interface HitOpts {
  dmg: number;
  crit: boolean;
  el: ElementId | null;
  /** Dealt by the local hero. */
  own: boolean;
  /** The target still carries its shield (rings instead of thuds). */
  shielded?: boolean;
  /** The target is a champion or a boss. */
  boss?: boolean;
  /** Class of the attacker for the weapon layer, when the hit is a direct weapon hit. */
  weapon?: ClassId | null;
  /** Damage over time / splash: no weapon impact, only a light elemental tick. */
  tick?: boolean;
}

export type HazardVictim = 'own' | 'ally' | 'enemy';

export type Sfx = ReturnType<typeof createSfx>;

export function createSfx(g: AudioGraph, bank: Bank) {
  const player = createPlayer(g, bank);
  const synth = createSynthSfx(g);
  const stamps = new Map<Family, number[]>();
  const recent: number[] = [];
  const chain = { n: 0, last: -Infinity };
  let designed = 0;
  let fallbacks = 0;

  /** Returns the number of same-family sounds already in the window, or -1 when the sound must be dropped. */
  const take = (family: Family, t: number): number => {
    const [max, window] = LIMITS[family];
    let list = stamps.get(family);
    if (!list) { list = []; stamps.set(family, list); }
    while (list.length > 0 && t - list[0] > window) list.shift();
    while (recent.length > 0 && t - recent[0] > TUNE.GLOBAL_WINDOW) recent.shift();
    if (list.length >= max || recent.length >= TUNE.GLOBAL_MAX) return -1;
    list.push(t);
    recent.push(t);
    return list.length - 1;
  };
  const duck = (stack: number): number => 1 / (1 + stack * TUNE.STACK_DUCK);
  const now = (): number => g.ctx.currentTime;
  const jitter = (spread: number): number => 1 + (Math.random() * 2 - 1) * spread;

  /** Runs the designed stack when its samples are there, the synthesised sound otherwise. */
  const use = (needs: SampleGroup[], stack: () => void, fallback: () => void): void => {
    if (player.has(...needs)) { designed++; stack(); } else { fallbacks++; fallback(); }
  };

  type Layer = (group: SampleGroup, t: number, gain: number, o?: Omit<VoiceOpts, 'gain'>) => void;
  /** A sample-layer function bound to a bus and priority. */
  const on = (bus: BusName | 'ui', pri: number): Layer => (group, t, gain, o) => { player.play(group, t, { ...o, gain, bus, pri }); };
  const UI = on('ui', VOICES.PRI.OWN);
  const who = (own: boolean): { V: Layer; out: GainNode; bus: BusName; pri: number; gain: number } => own
    ? { V: on('own', VOICES.PRI.OWN), out: g.buses.own, bus: 'own', pri: VOICES.PRI.OWN, gain: TUNE.OWN_GAIN }
    : { V: on('combat', VOICES.PRI.PARTY), out: g.buses.combat, bus: 'combat', pri: VOICES.PRI.PARTY, gain: TUNE.OTHER_GAIN };
  const BIG = on('big', VOICES.PRI.OWN);
  const WORLD = on('combat', VOICES.PRI.WORLD);
  const big = g.buses.big;
  const world = g.buses.combat;
  const ui = g.ui;

  const whoosh = (out: AudioNode, t: number, from: number, peak: number, to: number, dur: number, gain: number): void => {
    noise(g, out, t, { dur: dur * 0.5, gain, filter: 'bandpass', freq: from, freqEnd: peak, q: 1.4, attack: dur * 0.2 });
    noise(g, out, t + dur * 0.35, { dur: dur * 0.65, gain: gain * 0.8, filter: 'bandpass', freq: peak, freqEnd: to, q: 1.4 });
  };
  const thump = (out: AudioNode, t: number, freq: number, dur: number, gain: number): void => {
    tone(g, out, t, { freq, freqEnd: freq * 0.4, dur, gain });
  };

  // ---------------------------------------------------------------- element layers (synthesis + sample grain)
  /** size 0 = status tick, 1 = hit, 2 = burst (Resonance, blasts). Works without samples, richer with them. */
  const element = (el: ElementId, t: number, gain: number, size: 0 | 1 | 2, bus: BusName, pri: number): void => {
    const out = g.buses[bus];
    const V = on(bus, pri);
    const burst = size === 2;
    if (el === 'ember') {
      noise(g, out, t, { dur: burst ? 0.5 : 0.2, gain: gain * 0.5, filter: 'bandpass', freq: 1700, freqEnd: 420, q: 1.2, send: burst ? 0.3 : 0 });
      tone(g, out, t, { type: 'sawtooth', freq: 150, freqEnd: 70, dur: burst ? 0.32 : 0.16, gain: gain * 0.4, lpf: 500 });
      for (let i = 0, pops = 2 + size * 3; i < pops; i++) {
        noise(g, out, t + 0.02 + Math.random() * (0.12 + size * 0.14), { dur: 0.022, gain: gain * rnd(0.3, 0.6), filter: 'highpass', freq: rnd(3000, 5600) });
      }
      V('tex.fire', t, gain * (burst ? 2.4 : 1.6), { offset: -1, dur: 0.1 + size * 0.14, attack: 0.008, release: 0.14 + size * 0.12, lpf: 7000, lpfEnd: 900, rate: 1.15, send: burst ? 0.3 : 0.1 });
      if (burst) V('boom', t, gain * 0.55, { variant: 2, rate: 1.2, dur: 0.45, release: 0.3, send: 0.3 });
    } else if (el === 'rime') {
      for (const [f, d] of [[2637, 0.2], [3520, 0.15], [4699, 0.11]] as const) {
        tone(g, out, t, { freq: f * jitter(0.02), dur: d * (burst ? 2.2 : 1), gain: gain * 0.2, send: 0.4 });
      }
      noise(g, out, t, { dur: 0.05, gain: gain * 0.3, filter: 'highpass', freq: 6000 });
      V('glass.light', t, gain * 0.9, { rate: size === 0 ? 1.6 : 1.3, send: 0.3 });
      if (size >= 1) V('snow', t, gain * 0.7, { rate: 1.1, hpf: 500 });
      if (burst) {
        V('glass.mid', t, gain * 0.9, { rate: 1.1, send: 0.4 });
        V('glass.heavy', t, gain * 0.6, { rate: 1.25, send: 0.3 });
        V('shimmer', t, gain * 0.22, { rate: 0.82, attack: 0.03, send: 0.6, jitter: 0.02 });
        for (let i = 0; i < 3; i++) V('glass.light', t, gain * (0.4 - i * 0.1), { at: 0.05 + i * rnd(0.04, 0.07), rate: 1.5 + i * 0.25, send: 0.5 });
      }
    } else {
      tone(g, out, t, { type: 'sawtooth', freq: 2200 * jitter(0.1), freqEnd: 180, dur: 0.09, gain: gain * 0.4, lpf: 5000 });
      tone(g, out, t + 0.03, { type: 'square', freq: 96, dur: burst ? 0.22 : 0.09, gain: gain * 0.35, lpf: 1400, am: 0.8, amHz: 55 });
      noise(g, out, t, { dur: 0.06, gain: gain * 0.35, filter: 'bandpass', freq: 4200, q: 3 });
      for (let i = 0, sparks = 2 + size * 2; i < sparks; i++) {
        V('spark', t, gain * rnd(0.5, 0.9), { at: i === 0 ? 0 : rnd(0.01, 0.07 + size * 0.09), rate: rnd(0.8, 1.6), jitter: 0 });
      }
      if (size >= 1) V('scratch', t, gain * 0.4, { rate: rnd(0.8, 1.3), dur: 0.09, hpf: 1500 });
      if (burst) {
        V('zap.down', t, gain * 0.5, { rate: 1.25, send: 0.3 });
        V('zap.long', t, gain * 0.35, { rate: 0.9, lpf: 6000, send: 0.4 });
        noise(g, out, t + 0.04, { dur: 0.6, gain: gain * 0.3, filter: 'lowpass', freq: 320, freqEnd: 70, send: 0.4 });
      }
    }
  };

  /** A handful of bone knocks with random order, pitch and spacing. */
  const clatter = (V: Layer, t: number, count: number, span: number, gain: number): void => {
    let at = 0;
    for (let i = 0; i < count; i++) {
      V(CLATTER[Math.floor(Math.random() * CLATTER.length)], t, gain * (1 - (0.6 * i) / count), { at, rate: rnd(0.85, 1.7), jitter: 0, send: 0.25 });
      at += rnd(0.5, 1.5) * (span / count);
    }
  };

  // ---------------------------------------------------------------- hero abilities
  const primary = (cls: ClassId, step: number, own: boolean, level: number, t: number): void => {
    const { V, out, gain: base } = who(own);
    const gain = base * level;
    const finisher = step >= 2;
    switch (cls) {
      case 'knight':
        if (finisher) {
          V('swing.blade', t, gain * 0.5, { rate: 0.78 });
          V('swing.draw', t, gain * 0.5, { rate: 0.8 });
          V('swing.cloth', t, gain * 0.5, { rate: 0.85 });
          V('hit.ring', t, gain * 0.07, { at: 0.06, rate: 0.5, send: 0.5 });
          whoosh(out, t, 500, 2400, 350, 0.26, gain * 0.16);
          thump(out, t + 0.05, 120, 0.16, gain * 0.14);
        } else {
          V('swing.blade', t, gain * 0.42, { rate: step === 1 ? 1.1 : 0.97, hpf: 700 });
          V('swing.cloth', t, gain * 0.32, { rate: 1.25, lpf: 2600 });
          whoosh(out, t, 700, 3200, 500, 0.16, gain * 0.12);
        }
        break;
      case 'barbarian':
        V('swing.cloth', t, gain * 0.7, { rate: finisher ? 0.58 : 0.72 });
        V('swing.blade', t, gain * 0.3, { rate: finisher ? 0.55 : 0.66, lpf: 3800 });
        if (finisher) V('swing.draw', t, gain * 0.35, { rate: 0.52, at: 0.03 });
        whoosh(out, t, 320, finisher ? 1300 : 1700, 240, finisher ? 0.32 : 0.24, gain * 0.17);
        thump(out, t + 0.06, finisher ? 90 : 118, 0.2, gain * (finisher ? 0.16 : 0.1));
        break;
      case 'mage':
        V('laser.small', t, gain * 0.5, { rate: 1.18, lpf: 5200, send: 0.3 });
        V('ping', t, gain * 0.14, { rate: 1.5, send: 0.4 });
        tone(g, out, t, { type: 'triangle', freq: 980 * jitter(0.06), freqEnd: 340, dur: 0.14, gain: gain * 0.2, send: 0.25 });
        tone(g, out, t, { freq: 1960 * jitter(0.06), freqEnd: 700, dur: 0.1, gain: gain * 0.08 });
        noise(g, out, t, { dur: 0.08, gain: gain * 0.08, filter: 'highpass', freq: 4500 });
        break;
      case 'rogue':
        V('foley.latch', t, gain * 0.5, { rate: 1.2 });
        V('hit.bone', t, gain * 0.3, { rate: 1.5 });
        V('swing.blade', t, gain * 0.14, { rate: 1.6, hpf: 2500, dur: 0.1 });
        tone(g, out, t, { type: 'triangle', freq: 340 * jitter(0.05), freqEnd: 170, dur: 0.07, gain: gain * 0.22 });
        noise(g, out, t + 0.015, { dur: 0.07, gain: gain * 0.1, filter: 'bandpass', freq: 3000, freqEnd: 1200, q: 2 });
        break;
    }
  };

  const secondary = (cls: ClassId, own: boolean, level: number, t: number): void => {
    const { V, out, gain: base } = who(own);
    const gain = base * level;
    const def = CLASSES[cls].secondary;
    switch (cls) {
      case 'knight':
        V('hit.plate', t, gain * 0.7);
        V('hit.clang', t, gain * 0.45, { rate: 0.8, send: 0.3 });
        V('hit.heavy', t, gain * 0.55);
        V('bell', t, gain * 0.1, { variant: 3, rate: 1.3, dur: 0.4, release: 0.25, send: 0.6 });
        whoosh(out, t, 400, 1800, 300, 0.22, gain * 0.14);
        thump(out, t, 150, 0.26, gain * 0.24);
        break;
      case 'barbarian': {
        // One pass of the axe per damage tick, for as long as the spin lasts.
        const period = Math.max(0.12, def.tick);
        const turns = Math.max(1, Math.round(def.duration / period));
        for (let i = 0; i < turns; i++) {
          const at = i * period;
          V('swing.cloth', t, gain * 0.5, { at, rate: 0.62 + (i % 2) * 0.1 });
          V('swing.blade', t, gain * 0.22, { at: at + 0.04, rate: 0.66 + i * 0.03, lpf: 4200 });
          whoosh(out, t + at, 300, 1400 + i * 110, 260, period * 1.3, gain * 0.14);
        }
        tone(g, out, t, { type: 'sawtooth', freq: 82, freqEnd: 112, dur: def.duration, gain: gain * 0.07, lpf: 420, attack: 0.1, hold: def.duration * 0.6 });
        noise(g, out, t, { dur: def.duration + 0.15, gain: gain * 0.07, filter: 'bandpass', freq: 500, freqEnd: 900, q: 0.8, attack: 0.15, hold: def.duration * 0.7 });
        V('swing.draw', t, gain * 0.4, { at: def.duration, rate: 0.7 });
        break;
      }
      case 'mage': {
        // Charge for the wind-up, then the blast.
        const wind = def.windup;
        V('field', t, gain * 0.5, { rate: 1.25, dur: wind, release: 0.08, lpf: 2500 });
        V('boom', t, gain * 0.3, { variant: 1, reverse: true, fit: wind });
        tone(g, out, t, { type: 'triangle', freq: 220, freqEnd: 990, dur: wind, gain: gain * 0.1, attack: wind * 0.6, send: 0.4 });
        noise(g, out, t, { dur: wind, gain: gain * 0.06, filter: 'bandpass', freq: 800, freqEnd: 5200, q: 2, attack: wind * 0.75 });
        V('boom', t, gain * 0.7, { at: wind, variant: 1, send: 0.4 });
        V('boom.sub', t, gain * 0.55, { at: wind });
        V('glass.mid', t, gain * 0.25, { at: wind, rate: 1.4, send: 0.4 });
        tone(g, out, t + wind, { freq: 120, freqEnd: 36, dur: 0.5, gain: gain * 0.3 });
        noise(g, out, t + wind, { dur: 0.4, gain: gain * 0.14, filter: 'lowpass', freq: 5200, freqEnd: 200, send: 0.3 });
        break;
      }
      case 'rogue':
        for (let i = 0; i < def.count; i++) {
          V('swing.blade', t, gain * 0.26, { at: i * 0.018, rate: 1.2 + i * 0.08, dur: 0.12, hpf: 1200 });
        }
        V('swing.draw', t, gain * 0.45, { rate: 1.3 });
        whoosh(out, t, 900, 3400, 700, 0.18, gain * 0.12);
        break;
    }
  };

  /** Signature cue of a boss / elite ability. `rate` and `send` carry the caster's colour. */
  const cue = (name: CueName, t: number, rate: number, send: number): void => {
    switch (name) {
      case 'beam':
        BIG('laser.large', t, 0.6, { rate: 0.6 * rate, send });
        BIG('field', t, 0.5, { rate: 0.8 * rate, send });
        for (const detune of [-14, 9]) tone(g, big, t, { type: 'sawtooth', freq: 196 * rate, freqEnd: 262 * rate, detune, dur: 1, gain: 0.07, lpf: 900, lpfEnd: 3200, attack: 0.12, hold: 0.6, send });
        noise(g, big, t, { dur: 1, gain: 0.07, filter: 'bandpass', freq: 1800, freqEnd: 4200, q: 2.5, attack: 0.2, hold: 0.5 });
        break;
      case 'wisp':
        BIG('zap.up', t, 0.35, { rate: 0.7 * rate, lpf: 3200, send: 0.8 });
        BIG('shimmer', t, 0.12, { rate: 0.5 * rate, attack: 0.05, send: 0.8, jitter: 0.02 });
        tone(g, big, t, { freq: 520 * rate, freqEnd: 780 * rate, dur: 0.7, gain: 0.09, attack: 0.15, vib: 35, vibHz: 6, send: 0.8 });
        noise(g, big, t, { dur: 0.6, gain: 0.05, filter: 'bandpass', freq: 1400, freqEnd: 2600, q: 4, attack: 0.25, send: 0.6 });
        break;
      case 'leap':
        BIG('swing.cloth', t, 0.8, { rate: 0.5 * rate });
        whoosh(big, t, 200, 1800 * rate, 500, 0.42, 0.2);
        tone(g, big, t, { type: 'sawtooth', freq: 70 * rate, freqEnd: 140 * rate, dur: 0.4, gain: 0.12, lpf: 600, attack: 0.05, am: 0.5 });
        break;
      case 'volley':
        for (let i = 0; i < 3; i++) BIG('laser.small', t, 0.4, { at: i * 0.09, rate: (0.7 + i * 0.1) * rate, send });
        BIG('swing.draw', t, 0.35, { rate: 0.8 * rate });
        tone(g, big, t, { type: 'triangle', freq: 300 * rate, freqEnd: 600 * rate, dur: 0.3, gain: 0.08, send });
        break;
      case 'spear':
        BIG('swing.draw', t, 0.6, { rate: 0.7 * rate });
        BIG('swing.blade', t, 0.5, { rate: 0.6 * rate, at: 0.04 });
        BIG('hit.bone', t, 0.3, { rate: 0.7 * rate });
        whoosh(big, t, 600, 4000, 800, 0.22, 0.18);
        break;
      case 'slam':
        BIG('earth', t, 0.6, { rate: 0.8 * rate, send });
        BIG('hit.plate', t, 0.45, { rate: 0.7 * rate });
        BIG('creak', t, 0.14, { rate: 0.5 * rate, send });
        tone(g, big, t, { freq: 90 * rate, freqEnd: 45, dur: 0.5, gain: 0.22, attack: 0.03 });
        break;
      case 'sweep':
        BIG('swing.cloth', t, 0.8, { rate: 0.6 * rate });
        BIG('swing.blade', t, 0.45, { rate: 0.5 * rate, lpf: 4000 });
        whoosh(big, t, 250, 1300 * rate, 200, 0.4, 0.2);
        break;
      case 'charge':
        BIG('earth', t, 0.4, { rate: 1.1 * rate });
        BIG('earth', t, 0.5, { at: 0.18, rate: 0.95 * rate });
        tone(g, big, t, { type: 'sawtooth', freq: 55 * rate, freqEnd: 110 * rate, dur: 0.6, gain: 0.13, lpf: 300, lpfEnd: 1200, attack: 0.1, am: 0.6, amHz: 24 });
        whoosh(big, t + 0.1, 200, 900, 300, 0.5, 0.12);
        break;
      case 'summon':
        BIG('bell', t, 0.4, { variant: 2, rate: TUNED.BELL2_D3 * rate, send: 0.9, jitter: 0 });
        BIG('glass.mid', t, 0.25, { reverse: true, rate: 0.6, send: 0.7 });
        for (const [f, q] of [[350, 6], [800, 8]] as const) noise(g, big, t, { dur: 1.1, gain: 0.1, filter: 'bandpass', freq: f * rate, q, attack: 0.3, hold: 0.4, send: 0.6 });
        for (const n of [NOTE.D3, NOTE.F3, NOTE.A3]) tone(g, big, t, { type: 'sawtooth', freq: midiToHz(n) * rate, dur: 1.1, gain: 0.03, lpf: 900, attack: 0.3, hold: 0.4, send: 0.6 });
        clatter(BIG, t + 0.3, 5, 0.6, 0.22);
        break;
      case 'blink':
        WORLD('zap.jump', t, 0.3, { rate: 1.2 * rate, send: 0.5 });
        whoosh(world, t, 600, 2600, 400, 0.18, 0.08);
        break;
    }
  };

  const api = {
    // ------------------------------------------------------------ UI (dry)
    hover(): void {
      const t = now();
      if (take('hover', t) < 0) return;
      use(['ui.hover'], () => UI('ui.hover', t, 0.5), () => synth.hover());
    },
    click(): void {
      const t = now();
      if (take('ui', t) < 0) return;
      use(['ui.click'], () => UI('ui.click', t, 0.8), () => synth.click());
    },
    confirm(): void {
      const t = now();
      if (take('ui', t) < 0) return;
      use(['ui.click', 'ui.confirm'], () => {
        UI('ui.click', t, 0.6);
        UI('ui.confirm', t, 0.7, { at: 0.02, jitter: 0 });
      }, () => synth.confirm());
    },
    back(): void {
      const t = now();
      if (take('ui', t) < 0) return;
      use(['ui.back'], () => UI('ui.back', t, 0.8), () => synth.back());
    },
    ready(on: boolean): void {
      const t = now();
      if (take('ui', t) < 0) return;
      use(['ui.ready', 'ui.back', 'ui.click'], () => {
        UI('ui.click', t, 0.5);
        if (on) UI('ui.ready', t, 0.75, { at: 0.02, jitter: 0 });
        else UI('ui.back', t, 0.7, { at: 0.02, rate: 0.75 });
      }, () => synth.ready(on));
    },
    error(): void {
      const t = now();
      if (take('ui', t) < 0) return;
      use(['ui.error'], () => {
        UI('ui.error', t, 0.9, { variant: 1, rate: 0.9 });
        UI('ui.error', t, 0.7, { variant: 2, at: 0.11, rate: 0.8 });
      }, () => synth.error());
    },
    denied(): void {
      const t = now();
      if (take('ui', t) < 0) return;
      use(['ui.error'], () => UI('ui.error', t, 0.6, { variant: 1, rate: 1.25, dur: 0.07 }), () => synth.denied());
    },
    draftPick(): void {
      const t = now();
      use(['ui.card', 'ui.drop'], () => {
        UI('ui.card', t, 0.9);
        UI('ui.drop', t, 0.5, { at: 0.05, rate: 0.7 });
        tone(g, ui, t + 0.04, { freq: 120, freqEnd: 48, dur: 0.2, gain: 0.14 });
        [NOTE.D5, NOTE.A5, NOTE.D6].forEach((n, i) => {
          tone(g, ui, t + 0.05 + i * 0.05, { freq: midiToHz(n), dur: 0.6, gain: 0.06 });
          tone(g, ui, t + 0.05 + i * 0.05, { freq: midiToHz(n) * 2.76, dur: 0.22, gain: 0.014 });
        });
      }, () => synth.draftPick());
    },
    countdownTick(last: boolean): void {
      const t = now();
      use(['ui.tick'], () => {
        UI('ui.tick', t, 0.9, { variant: last ? 2 : 1, rate: last ? 1.35 : 1, jitter: 0 });
        tone(g, ui, t, { type: 'triangle', freq: last ? 1480 : 990, freqEnd: last ? 1300 : 860, dur: 0.06, gain: 0.12, lpf: 3000 });
      }, () => synth.countdownTick(last));
    },
    buy(): void {
      const t = now();
      if (take('ui', t) < 0) return;
      use(['ui.coins', 'ui.buy'], () => {
        UI('ui.coins', t, 0.9);
        UI('ui.buy', t, 0.6, { at: 0.09, jitter: 0 });
      }, () => synth.buy());
    },
    equip(): void {
      const t = now();
      if (take('ui', t) < 0) return;
      use(['ui.equip', 'foley.latch'], () => {
        UI('ui.equip', t, 0.9);
        UI('foley.latch', t, 0.35, { at: 0.12, variant: 1 });
      }, () => synth.equip());
    },
    tab(): void {
      const t = now();
      if (take('ui', t) < 0) return;
      use(['ui.tab'], () => UI('ui.tab', t, 0.8), () => synth.tab());
    },
    toggle(): void {
      const t = now();
      if (take('ui', t) < 0) return;
      use(['ui.toggle'], () => UI('ui.toggle', t, 0.7), () => synth.toggle());
    },

    // ------------------------------------------------------------ hero actions
    primary(cls: ClassId, step: number, own: boolean): void {
      const t = now();
      const stack = take('cast', t);
      if (stack < 0) return;
      use(PRIMARY_NEEDS[cls], () => primary(cls, step, own, duck(stack), t), () => synth.primary(cls, step, own));
    },
    secondary(cls: ClassId, own: boolean): void {
      const t = now();
      const stack = take('cast', t);
      if (stack < 0) return;
      use(SECONDARY_NEEDS[cls], () => secondary(cls, own, duck(stack), t), () => synth.secondary(cls, own));
    },
    dash(own: boolean): void {
      const t = now();
      const stack = take('cast', t);
      if (stack < 0) return;
      use(['swing.cloth'], () => {
        const { V, out, gain: base } = who(own);
        const gain = base * duck(stack);
        V('swing.cloth', t, gain * 0.65, { rate: 1.12 });
        V('bone.tap', t, gain * 0.2, { at: 0.16, rate: 0.8 });
        whoosh(out, t, 500, 3200, 900, 0.2, gain * 0.15);
        tone(g, out, t, { freq: 320, freqEnd: 760, dur: 0.13, gain: gain * 0.05 });
      }, () => synth.dash(own));
    },
    /** An enemy ability. Bosses' big attacks get a signature cue chosen from the ability id. */
    enemyCast(ability = '', kind: EnemyKind | null = null): void {
      const t = now();
      const id = ability.toLowerCase();
      const match = CUES.find(([part]) => id.includes(part));
      const tint = TINT[kind ?? 'other'] ?? TINT.other;
      if (match && take(match[1] === 'blink' ? 'enemyCast' : 'cue', t) >= 0) {
        use(['swing.cloth', 'swing.blade', 'swing.draw', 'earth', 'bell', 'laser.small', 'laser.large', 'field', 'zap.up', 'zap.jump', 'hit.plate', 'glass.mid'],
          () => cue(match[1], t, tint.rate, tint.send), () => synth.enemyCast());
        return;
      }
      const stack = take('enemyCast', t);
      if (stack < 0) return;
      use(['swing.cloth'], () => {
        WORLD('swing.cloth', t, 0.3 * duck(stack), { rate: 0.9 * tint.rate });
        whoosh(world, t, 260, 1100, 220, 0.2, 0.08 * duck(stack));
      }, () => synth.enemyCast());
    },

    // ------------------------------------------------------------ combat feedback
    hit(o: HitOpts): void {
      const t = now();
      const { V, out, pri, gain: base } = who(o.own);
      if (o.tick) {
        const stack = take('tick', t);
        if (stack < 0) return;
        const gain = base * duck(stack);
        if (player.has('hit.bone')) V('hit.bone', t, gain * 0.14, { rate: 0.8, lpf: 1800 });
        if (o.el) element(o.el, t, gain * 0.1, 0, 'element', pri);
        else tone(g, out, t, { type: 'triangle', freq: 200, freqEnd: 110, dur: 0.05, gain: gain * 0.1 });
        return;
      }
      const stack = take('hit', t);
      if (stack >= 0) {
        const weight = Math.min(1, Math.max(0, o.dmg) / TUNE.HEAVY_DAMAGE);
        const gain = base * duck(stack) * (0.6 + weight * 0.4);
        use(['hit.bone', 'hit.body', 'hit.heavy', 'hit.thud', 'hit.metal', 'hit.tin', 'hit.sub', 'hit.plate'], () => {
          if (o.shielded || o.dmg <= 0) {
            // shield: metal ring instead of a thud
            V('hit.metal', t, gain * 0.6, { rate: 1.05 - weight * 0.2, send: 0.25 });
            V('hit.tin', t, gain * 0.35, { rate: 0.9 });
            V('hit.body', t, gain * 0.2, { rate: 1.1 });
            tone(g, out, t, { freq: 1380 * jitter(0.06), dur: 0.2, gain: gain * 0.035, send: 0.4 });
          } else if (weight < TUNE.HEAVY_FROM) {
            V('hit.bone', t, gain * 0.55);
            V('hit.body', t, gain * 0.42, { rate: 1.12 });
          } else {
            V('hit.thud', t, gain * 0.55, { rate: 1 - weight * 0.15 });
            V('hit.heavy', t, gain * 0.55, { rate: 1.05 - weight * 0.15 });
            V('hit.bone', t, gain * 0.3, { rate: 0.8 });
          }
          if (o.boss) {
            V('hit.sub', t, gain * 0.5);
            V('hit.plate', t, gain * 0.25, { rate: 0.8, send: 0.3 });
          }
          switch (o.weapon) {
            case 'knight': V('swing.blade', t, gain * 0.16, { rate: 1.3, dur: 0.09, hpf: 1500 }); break;
            case 'barbarian': V('swing.chop', t, gain * 0.4, { rate: 0.8 }); break;
            case 'rogue': V('bone.tick', t, gain * 0.3, { rate: 1.4 }); break;
            case 'mage': V('spark', t, gain * 0.25, { rate: 1.2 }); break;
            default: break;
          }
        }, () => synth.hit({ dmg: o.dmg, crit: false, el: null, own: o.own }));
      }
      if (o.crit && take('crit', t) >= 0) {
        const gain = o.own ? 1 : 0.6;
        V('hit.ring', t, gain * 0.3, { rate: 1.2, send: 0.4 });
        V('glass.light', t, gain * 0.14, { rate: 1.7, send: 0.3 });
        tone(g, out, t, { type: 'square', freq: 1568, freqEnd: 2093, dur: 0.1, gain: gain * 0.07, lpf: 6000, send: 0.2 });
        noise(g, out, t, { dur: 0.04, gain: gain * 0.08, filter: 'highpass', freq: 5200 });
        thump(out, t, 140, 0.12, gain * 0.14);
      }
      if (o.el) {
        const elStack = take('element', t);
        if (elStack >= 0) element(o.el, t, (o.own ? 0.34 : 0.2) * duck(elStack), 1, 'element', pri);
      }
    },
    status(el: ElementId): void {
      const t = now();
      const stack = take('status', t);
      if (stack >= 0) element(el, t, 0.1 * duck(stack), 0, 'element', VOICES.PRI.WORLD);
    },
    /** The signature sound: element `a` ignites, element `b` detonates into a tonal bloom. Chains climb in pitch. */
    resonance(a: ElementId, b: ElementId, own: boolean): void {
      const t = now();
      const stack = take('resonance', t);
      if (stack < 0) return;
      chain.n = t - chain.last < TUNE.CHAIN_WINDOW ? Math.min(TUNE.CHAIN_MAX, chain.n + 1) : 0;
      chain.last = t;
      const gain = (own ? 0.9 : 0.62) * duck(stack);
      const pri = own ? VOICES.PRI.OWN : VOICES.PRI.PARTY;
      const E = on('element', pri);
      const out = g.buses.element;
      const lift = semitones(CHAIN_STEPS[chain.n]);
      const rate = 1 + chain.n * TUNE.CHAIN_RATE_STEP;
      const t2 = t + TUNE.RESONANCE_GAP;
      // part 1: ignition — the first element snaps, the air is sucked in
      element(a, t, gain * 0.5, 1, 'element', pri);
      E('hit.sub', t, gain * 0.5, { rate });
      E('glass.mid', t, gain * 0.2, { reverse: true, fit: TUNE.RESONANCE_GAP });
      noise(g, out, t, { dur: TUNE.RESONANCE_GAP, gain: gain * 0.14, filter: 'bandpass', freq: 500, freqEnd: 4200 * lift, q: 1.5, attack: TUNE.RESONANCE_GAP * 0.8 });
      // part 2: detonation — the second element bursts over a sub drop
      element(b, t2, gain * 0.62, 2, 'element', pri);
      E('boom', t2, gain * 0.55, { variant: 1, rate: rate * 1.05, send: 0.35 });
      E('boom.sub', t2, gain * 0.6, { rate });
      tone(g, out, t2, { freq: 120, freqEnd: 36, dur: 0.7, gain: gain * 0.34 });
      noise(g, out, t2, { dur: 0.5, gain: gain * 0.16, filter: 'lowpass', freq: 5200, freqEnd: 180, send: 0.3 });
      // bloom: a chord that depends on the element pair, arpeggio direction on the order, pitch on the chain
      const pair = [a, b].sort().join('+');
      const root = (PAIR_ROOT[pair] ?? NOTE.D4) + CHAIN_STEPS[chain.n];
      const rising = a < b;
      (rising ? BLOOM_CHORD : [...BLOOM_CHORD].reverse()).forEach((semi, i) => {
        const f = midiToHz(root + semi);
        tone(g, out, t2 + 0.02 + i * 0.045, { type: 'triangle', freq: f, dur: 1.1, gain: gain * 0.075, attack: 0.012, send: 0.65, lpf: 4200 });
        tone(g, out, t2 + 0.02 + i * 0.045, { freq: f * 2, dur: 0.6, gain: gain * 0.025, detune: 6, send: 0.65 });
      });
      tone(g, out, t2, { freq: midiToHz(root - 12), dur: 0.9, gain: gain * 0.12, attack: 0.03, send: 0.4 });
      E('ping', t2, gain * 0.2, { at: 0.03, rate: lift * 0.75, jitter: 0.01, send: 0.7 });
      E('shimmer', t2, gain * 0.1, { rate: lift * 0.5, attack: 0.04, send: 0.8, jitter: 0.01 });
      g.duckMusic(0.5, 0.3, 0.6);
    },
    kill(kind: EnemyKind, own: boolean): void {
      const t = now();
      if (isBig(kind)) {
        if (take('big', t) < 0) return;
        use(['boom', 'boom.sub', 'bell', 'bone.tick', 'hit.bone', 'bone.tap'], () => {
          BIG('boom', t, 0.9, { variant: 3, send: 0.5 });
          BIG('boom.sub', t, 0.8);
          BIG('bell', t, 0.5, { variant: 2, rate: TUNED.BELL2_D3, at: 0.1, send: 0.8, jitter: 0 });
          clatter(BIG, t + 0.08, 12, 1, 0.5);
          tone(g, big, t, { freq: 110, freqEnd: 30, dur: 1.4, gain: 0.36 });
          [NOTE.D4, NOTE.A3, NOTE.F3, NOTE.D3].forEach((n, i) =>
            tone(g, big, t + 0.1 + i * 0.16, { type: 'sawtooth', freq: midiToHz(n), dur: 0.7, gain: 0.05, lpf: 1400, send: 0.5 }));
          g.duckMusic(0.35, 0.9, 1.2);
        }, () => synth.kill(kind, own));
        return;
      }
      const stack = take('kill', t);
      if (stack < 0) return;
      use(['bone.tick', 'hit.bone', 'bone.tap', 'hit.thud'], () => {
        const { V, out, gain: base } = who(own);
        const gain = base * duck(stack);
        clatter(V, t, 3 + Math.floor(Math.random() * 3), 0.2, gain * 0.5);
        V('hit.thud', t, gain * 0.3, { rate: 0.8 });
        V('foley.fall', t, gain * 0.3, { at: 0.07 });
        if (kind === 'warrior') V('hit.tin', t, gain * 0.2, { at: 0.04, rate: 0.9 });
        if (kind === 'mage') V('ping', t, gain * 0.1, { rate: 0.8, send: 0.5 });
        noise(g, out, t, { dur: 0.12, gain: gain * 0.07, filter: 'bandpass', freq: 1300, freqEnd: 300, q: 1.1 });
        if (own) tone(g, out, t + 0.04, { freq: midiToHz(NOTE.A6) * jitter(0.01), dur: 0.3, gain: 0.025, send: 0.5 });
      }, () => synth.kill(kind, own));
    },
    spawn(kind: EnemyKind, elite: boolean): void {
      const t = now();
      if (isBig(kind)) {
        if (take('big', t) < 0) return;
        const tint = TINT[kind] ?? TINT.other;
        use(['boom', 'earth', 'bell'], () => {
          BIG('boom', t, 0.4, { variant: 3, reverse: true, fit: 1.15 });
          BIG('earth', t, 0.8, { at: 1.1, rate: 0.7 * tint.rate, send: 0.5 });
          BIG('bell', t, 0.5, { at: 1.1, variant: 2, rate: TUNED.BELL2_D3 * (kind === 'matron' ? 2 : 1), send: 0.8, jitter: 0 });
          const low = 46 * tint.rate;
          tone(g, big, t, { type: 'sawtooth', freq: low, freqEnd: low * 1.3, dur: 1.5, gain: 0.2, lpf: 240, lpfEnd: 900, attack: 0.3, send: 0.4 });
          tone(g, big, t, { type: 'sawtooth', freq: low * 1.5, freqEnd: low * 1.9, dur: 1.5, gain: 0.09, lpf: 300, lpfEnd: 1100, attack: 0.4 });
          noise(g, big, t, { dur: 1.3, gain: 0.1, filter: 'lowpass', freq: 300, freqEnd: 1600, attack: 0.5, send: 0.4 });
          g.duckMusic(0.5, 1.2, 1);
        }, () => synth.spawn(kind, elite));
        return;
      }
      const stack = take('spawn', t);
      if (stack < 0) return;
      use(['earth', 'bone.tick'], () => {
        const gain = duck(stack) * (elite ? 1.3 : 1);
        WORLD('earth', t, gain * 0.22, { rate: 1.35, dur: 0.3, release: 0.15, lpf: 1200 });
        WORLD('bone.tick', t, gain * 0.16, { at: 0.08, rate: rnd(0.9, 1.4) });
        WORLD('bone.tick', t, gain * 0.12, { at: 0.16, rate: rnd(1.1, 1.7) });
        if (elite) WORLD('bell', t, gain * 0.07, { variant: 3, rate: 0.6, send: 0.7 });
        tone(g, world, t, { freq: elite ? 60 : 78, freqEnd: elite ? 96 : 120, dur: 0.35, gain: gain * 0.05, attack: 0.1 });
      }, () => synth.spawn(kind, elite));
    },
    telegraph(seconds: number): void {
      const t = now();
      if (take('telegraph', t) < 0) return;
      const urgent = seconds < 0.7;
      use(['ui.tick'], () => {
        on('big', VOICES.PRI.OWN)('ui.tick', t, 0.35, { variant: 1, rate: urgent ? 1.5 : 1.15, jitter: 0.02 });
        tone(g, big, t, { type: 'square', freq: urgent ? 988 : 784, freqEnd: urgent ? 1046 : 830, dur: 0.07, gain: 0.09, lpf: 2400 });
      }, () => synth.telegraph(seconds));
    },
    aoe(el: ElementId | null, hostile: boolean): void {
      const t = now();
      const stack = take('aoe', t);
      if (stack < 0) return;
      use(['earth', 'hit.sub', 'hit.tight', 'hit.clang'], () => {
        const gain = duck(stack);
        if (hostile) {
          BIG('earth', t, gain * 0.5, { rate: 1.1, send: 0.3 });
          BIG('hit.sub', t, gain * 0.5);
          BIG('hit.clang', t, gain * 0.14, { rate: 0.7 });
          tone(g, big, t, { freq: 105, freqEnd: 40, dur: 0.34, gain: gain * 0.24 });
          tone(g, big, t, { type: 'sawtooth', freq: 233, freqEnd: 110, dur: 0.2, gain: gain * 0.05, lpf: 900 });
          noise(g, big, t, { dur: 0.28, gain: gain * 0.14, filter: 'lowpass', freq: 1500, freqEnd: 180, send: 0.25 });
        } else {
          WORLD('hit.tight', t, gain * 0.4);
          noise(g, world, t, { dur: 0.25, gain: gain * 0.12, filter: 'lowpass', freq: 2600, freqEnd: 180, send: 0.25 });
        }
        if (el) element(el, t, gain * (hostile ? 0.3 : 0.22), hostile ? 2 : 1, 'element', hostile ? VOICES.PRI.OWN : VOICES.PRI.PARTY);
      }, () => synth.aoe(el, hostile));
    },
    hurt(own: boolean, dmg: number): void {
      const t = now();
      const stack = take('hurt', t);
      if (stack < 0) return;
      const weight = Math.min(1, Math.max(0, dmg) / TUNE.HEAVY_DAMAGE);
      use(['hit.heavy', 'hit.sub', 'hit.body', 'swing.cloth'], () => {
        if (own) {
          const V = on('own', VOICES.PRI.OWN);
          const out = g.buses.own;
          V('hit.heavy', t, 0.75 + weight * 0.2);
          V('hit.sub', t, 0.6);
          V('swing.cloth', t, 0.3, { rate: 0.8 });
          tone(g, out, t, { type: 'sawtooth', freq: 240, freqEnd: 105, dur: 0.2, gain: 0.26 + weight * 0.1, lpf: 800 });
          tone(g, out, t, { freq: 70, freqEnd: 40, dur: 0.18, gain: 0.24 });
          // the blow dulls the world for a moment
          g.muffle(900 - weight * 400, 0.1 + weight * 0.1, 0.4);
          g.duckMusic(0.7, 0.15, 0.4);
        } else {
          const V = on('combat', VOICES.PRI.PARTY);
          V('hit.body', t, 0.35 * duck(stack), { rate: 0.9 });
          tone(g, world, t, { type: 'triangle', freq: 330, freqEnd: 190, dur: 0.12, gain: 0.08 * duck(stack), lpf: 1200 });
        }
      }, () => synth.hurt(own, dmg));
    },
    down(own: boolean): void {
      const t = now();
      use(['hit.sub', 'foley.fall', 'swing.cloth', 'bell'], () => {
        const gain = own ? 1 : 0.7;
        BIG('hit.sub', t, gain * 0.8);
        BIG('swing.cloth', t, gain * 0.5, { at: 0.05, rate: 0.6 });
        BIG('foley.fall', t, gain * 0.7, { at: 0.14 });
        BIG('bell', t, gain * 0.35, { at: 0.1, variant: 2, rate: TUNED.BELL2_D3, send: 0.8, jitter: 0 });
        tone(g, big, t, { freq: 90, freqEnd: 34, dur: 0.9, gain: gain * 0.3 });
        [NOTE.D4, NOTE.A3, NOTE.F3].forEach((n, i) =>
          tone(g, big, t + i * 0.17, { type: 'triangle', freq: midiToHz(n), dur: 0.8, gain: gain * 0.1, send: 0.6, lpf: 1800 }));
        if (own) {
          g.muffle(420, 0.7, 1.4);
          g.duckMusic(0.4, 1, 1.5);
        }
      }, () => synth.down(own));
    },
    revived(own: boolean): void {
      const t = now();
      use(['zap.up', 'shimmer', 'swing.cloth'], () => {
        const gain = own ? 1 : 0.75;
        BIG('zap.up', t, gain * 0.25, { rate: 0.8, lpf: 4000, send: 0.6 });
        BIG('shimmer', t, gain * 0.1, { rate: 0.8, attack: 0.1, send: 0.7, jitter: 0.01 });
        BIG('swing.cloth', t, gain * 0.3, { rate: 1.2 });
        [NOTE.D4, NOTE.A4, NOTE.D5, NOTE.Fs5].forEach((n, i) => {
          tone(g, big, t + i * 0.07, { type: 'triangle', freq: midiToHz(n), dur: 0.6, gain: gain * 0.08, send: 0.55 });
          tone(g, big, t + i * 0.07, { freq: midiToHz(n) * 2, dur: 0.3, gain: gain * 0.025 });
        });
        noise(g, big, t, { dur: 0.5, gain: gain * 0.04, filter: 'highpass', freq: 3000, freqEnd: 8000, attack: 0.2 });
      }, () => synth.revived(own));
    },
    heal(own: boolean): void {
      const t = now();
      if (take('heal', t) < 0) return;
      use(['ping'], () => {
        const gain = own ? 1 : 0.6;
        BIG('ping', t, gain * 0.16, { variant: 3, rate: 0.9, send: 0.6 });
        tone(g, big, t, { freq: 660, freqEnd: 990, dur: 0.28, gain: gain * 0.06, send: 0.4 });
        tone(g, big, t + 0.08, { freq: 1320, dur: 0.25, gain: gain * 0.035, send: 0.4 });
      }, () => synth.heal(own));
    },
    shieldBreak(): void {
      const t = now();
      const stack = take('shield', t);
      if (stack < 0) return;
      use(['glass.heavy', 'glass.light', 'hit.clang', 'hit.plate'], () => {
        const gain = duck(stack);
        const V = on('combat', VOICES.PRI.PARTY);
        V('glass.heavy', t, gain * 0.7, { send: 0.3 });
        V('hit.clang', t, gain * 0.55, { send: 0.3 });
        V('hit.plate', t, gain * 0.45);
        V('glass.light', t, gain * 0.3, { at: 0.04, rate: 1.3 });
        V('glass.light', t, gain * 0.2, { at: 0.09, rate: 1.7 });
        noise(g, world, t, { dur: 0.2, gain: gain * 0.1, filter: 'highpass', freq: 2800 });
        tone(g, world, t, { type: 'square', freq: 392, freqEnd: 260, dur: 0.1, gain: gain * 0.06, lpf: 1800 });
      }, () => synth.shieldBreak());
    },
    hazard(kind: Hazard['kind'], victim: HazardVictim): void {
      const t = now();
      const stack = take('hazard', t);
      if (stack < 0) return;
      const own = victim === 'own';
      const gain = (own ? 1 : victim === 'ally' ? 0.6 : 0.4) * duck(stack);
      const pri = own ? VOICES.PRI.OWN : VOICES.PRI.WORLD;
      use(['hit.metal', 'swing.blade', 'hit.body', 'snow'], () => {
        const V = on(own ? 'own' : 'combat', pri);
        if (kind === 'spikes') {
          V('hit.metal', t, gain * 0.45, { rate: 1.3, send: 0.2 });
          V('swing.blade', t, gain * 0.4, { rate: 1.4, dur: 0.1 });
          V('hit.body', t, gain * 0.4, { at: 0.02 });
        } else if (kind === 'vent') {
          element('ember', t, gain * 0.4, 2, 'element', pri);
          V('tex.fire', t, gain * 1.6, { offset: -1, dur: 0.35, attack: 0.03, release: 0.3, lpf: 5000, lpfEnd: 700 });
        } else {
          element('rime', t, gain * 0.35, 1, 'element', pri);
          V('snow', t, gain * 0.6, { rate: 0.85 });
          noise(g, g.buses.element, t, { dur: 0.4, gain: gain * 0.07, filter: 'highpass', freq: 5000, attack: 0.1 });
        }
      }, () => synth.hazard(kind, own));
    },

    // ------------------------------------------------------------ run flow
    wave(): void {
      const t = now();
      use(['drum.war', 'hit.sub'], () => {
        BIG('drum.war', t, 0.7, { variant: 2 });
        BIG('drum.war', t, 0.85, { at: 0.22, variant: 1, rate: 0.92, send: 0.4 });
        BIG('hit.sub', t, 0.5, { at: 0.22 });
        for (const n of [NOTE.D3, NOTE.A3]) {
          tone(g, big, t + 0.05, { type: 'sawtooth', freq: midiToHz(n), dur: 0.8, gain: 0.05, lpf: 420, lpfEnd: 1100, attack: 0.12, send: 0.45 });
        }
      }, () => synth.wave());
    },
    chamberClear(): void {
      const t = now();
      use(['jingle.rise', 'bell'], () => {
        BIG('jingle.rise', t, 0.6, { rate: TUNED.RISE_TO_D, jitter: 0, gainJitter: 0, send: 0.5 });
        BIG('bell', t, 0.3, { at: 0.75, variant: 1, rate: TUNED.BELL1_D4, jitter: 0, send: 0.7 });
        [NOTE.D4, NOTE.Fs4, NOTE.A4, NOTE.D5, NOTE.Fs5].forEach((n, i) => {
          tone(g, big, t + 0.75 + i * 0.07, { type: 'triangle', freq: midiToHz(n), dur: 1.3, gain: 0.055, send: 0.6 });
        });
        tone(g, big, t + 0.75, { freq: midiToHz(NOTE.D2), dur: 1.6, gain: 0.16, attack: 0.05 });
        g.duckMusic(0.5, 1.2, 1);
      }, () => synth.chamberClear());
    },
    /** Phase change of a boss: a roar that grows with the phase and carries the boss's colour. */
    bossPhase(phase = 2, kind: EnemyKind | null = null): void {
      const t = now();
      if (take('big', t) < 0) return;
      const tint = TINT[kind ?? 'regent'] ?? TINT.other;
      const rate = tint.rate * (1 + Math.max(0, phase - 2) * 0.08);
      use(['boom', 'boom.sub', 'bell', 'drum.fill'], () => {
        BIG('bell', t, 0.35, { variant: 1, reverse: true, fit: 0.4, send: 0.5 });
        const r = t + 0.38;
        BIG('boom', r, 0.9, { variant: 3, rate: 0.9 * rate, send: 0.5 });
        BIG('boom.sub', r, 0.9);
        BIG('bell', r, 0.6, { variant: 2, rate: TUNED.BELL2_D3, jitter: 0, send: 0.9 });
        BIG('drum.fill', r, 0.5, { variant: 2, rate: 0.85, send: 0.4 });
        // the roar: detuned saws through two moving formants, roughened
        for (const [freq, detune] of [[74, 0], [104, 18], [148, -12]] as const) {
          tone(g, big, r, { type: 'sawtooth', freq: freq * rate, freqEnd: freq * rate * 0.6, detune, dur: 1.5, gain: 0.16, lpf: 380, lpfEnd: 1700 * rate, attack: 0.08, am: 0.7, amHz: 27, send: 0.5 });
        }
        noise(g, big, r, { dur: 1.3, gain: 0.16, filter: 'bandpass', freq: 500 * rate, freqEnd: 1500 * rate, q: 0.9, attack: 0.15, send: 0.5 });
        tone(g, big, r, { freq: 60, freqEnd: 30, dur: 0.8, gain: 0.26 });
        g.duckMusic(0.3, 1.2, 1);
      }, () => synth.bossPhase());
    },
    boon(own: boolean): void {
      const t = now();
      use(['jingle.fifth', 'ping'], () => {
        if (own) {
          BIG('jingle.fifth', t, 0.5, { rate: TUNED.FIFTH_TO_D, jitter: 0, gainJitter: 0, send: 0.5 });
          BIG('ping', t, 0.12, { at: 0.3, variant: 2, rate: 0.595, jitter: 0, send: 0.7 });
          [NOTE.D6, NOTE.A6].forEach((n, i) => tone(g, big, t + 0.3 + i * 0.06, { freq: midiToHz(n), dur: 0.45, gain: 0.04, send: 0.55 }));
        } else {
          [NOTE.D6, NOTE.A6].forEach((n, i) => tone(g, big, t + i * 0.055, { freq: midiToHz(n), dur: 0.45, gain: 0.03, send: 0.55 }));
        }
      }, () => synth.boon(own));
    },
    doorChosen(type: DoorType): void {
      const t = now();
      use(['door.open', 'creak', 'foley.latch', 'bell', 'jingle.magic', 'jingle.fall'], () => {
        BIG('foley.latch', t, 0.4, { variant: 1 });
        BIG('door.open', t, 0.6, { at: 0.05, send: 0.4 });
        BIG('creak', t, 0.22, { at: 0.1, rate: 0.8, send: 0.5 });
        tone(g, big, t, { freq: 84, freqEnd: 36, dur: 0.6, gain: 0.28 });
        noise(g, big, t, { dur: 0.6, gain: 0.1, filter: 'lowpass', freq: 600, freqEnd: 140, send: 0.4 });
        const c = t + 0.25;
        if (type === 'boon') {
          [NOTE.D5, NOTE.A5].forEach((n, i) => tone(g, big, c + i * 0.07, { type: 'triangle', freq: midiToHz(n), dur: 0.8, gain: 0.07, lpf: 4000, send: 0.6 }));
        } else if (type === 'blessing') {
          // warm: a rising run into a major chord
          BIG('jingle.magic', c, 0.42, { rate: TUNED.MAGIC_TO_D, jitter: 0, gainJitter: 0, send: 0.6, lpf: 5000 });
          BIG('shimmer', c, 0.07, { rate: 0.64, attack: 0.2, send: 0.8, jitter: 0 });
          [NOTE.D4, NOTE.Fs4, NOTE.A4, NOTE.D5].forEach((n, i) => tone(g, big, c + 0.2 + i * 0.05, { type: 'triangle', freq: midiToHz(n), dur: 1.4, gain: 0.05, attack: 0.08, lpf: 3000, send: 0.6 }));
        } else if (type === 'cursed') {
          // ominous: a slow chromatic fall, a low bell and a tritone
          BIG('jingle.fall', c, 0.45, { rate: TUNED.FALL_DARK, jitter: 0, gainJitter: 0, lpf: 1800, send: 0.7 });
          BIG('bell', c, 0.4, { variant: 2, rate: TUNED.BELL2_D3 / 2, jitter: 0, send: 0.8 });
          for (const n of [NOTE.D3, NOTE.D3 + 6]) tone(g, big, c, { type: 'sawtooth', freq: midiToHz(n), dur: 1.8, gain: 0.05, lpf: 700, attack: 0.2, hold: 0.6, send: 0.6, am: 0.3, amHz: 7 });
        } else {
          BIG('bell', c, 0.6, { variant: 2, rate: TUNED.BELL2_D3, jitter: 0, send: 0.9 });
          BIG('boom.sub', c, 0.5);
          BIG('drum.war', c, 0.6, { variant: 1, rate: 0.85 });
          for (const n of [NOTE.D3, NOTE.D3 + 1, NOTE.D3 + 6]) tone(g, big, c, { type: 'sawtooth', freq: midiToHz(n), dur: 1.6, gain: 0.045, lpf: 900, attack: 0.15, send: 0.6 });
        }
      }, () => synth.doorChosen(type));
    },
    tutorialStep(): void {
      const t = now();
      use(['jingle.resolve'], () => {
        BIG('jingle.resolve', t, 0.45, { jitter: 0, gainJitter: 0, send: 0.4 });
        tone(g, big, t + 0.5, { freq: midiToHz(NOTE.D5), dur: 0.5, gain: 0.04, send: 0.5 });
      }, () => synth.tutorialStep());
    },

    /** Counters for the dev workbench and tests. */
    stats(): { designed: number; fallbacks: number; voices: number; dropped: number; stolen: number; chain: number } {
      const p = player.stats();
      return { designed, fallbacks, voices: p.active, dropped: p.dropped, stolen: p.stolen, chain: chain.n };
    },
    player,
  };
  return api;
}
