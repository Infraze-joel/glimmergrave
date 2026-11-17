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
import { midiToHz, noise as engineNoise, semitones, tone as engineTone, type AudioGraph, type BusName, type NoiseOpts, type ToneOpts } from './engine.ts';
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
  /**
   * How much of every game sound goes to the room on top of the per-layer sends, so nothing is bone dry. The own
   * hero is closest and driest; the party, enemies and big events sit further back in the chamber.
   */
  ROOM: { own: 0.1, combat: 0.17, element: 0.14, big: 0.18, ambience: 0 },
  /** Per-event mix nodes are unplugged this long after they were made (longer than any sound's tail). */
  MIX_TTL: 12,
} as const;

/**
 * The mix table: level of every sound relative to its layer gains (1 = as designed). Tuned against offline
 * renders so that, at full volume, the loudest 400 ms sit roughly at: interface -40..-28 dBFS, own attacks
 * -27..-21, hits -27 (light) to -19 (crit), kills -25, hurt -17, Resonance -14, boss moments -12, with the
 * score at -18 and ambience at -28 (see docs/AUDIO.md).
 */
const LEVEL = {
  hover: 0.22, click: 0.42, confirm: 0.8, back: 0.4, ready: 0.8, error: 0.63, denied: 0.6, draftPick: 0.75, tick: 0.6,
  buy: 0.6, equip: 0.75, tab: 0.38, toggle: 1,
  knight: 1, knightBash: 1, barbarian: 0.75, whirl: 0.75, mage: 1, nova: 0.65, rogue: 1, fan: 1.7, dash: 0.85,
  enemyCast: 1, cue: 0.8, blink: 1,
  hit: 0.8, hitShield: 1, hitTick: 0.6, crit: 1.3, kill: 0.63, bigKill: 0.75, spawn: 0.65, bigSpawn: 0.85, telegraph: 0.5,
  aoeHostile: 1, aoeFriendly: 0.7, hurtOwn: 1, hurtAlly: 1, shieldBreak: 1,
  hazardSpikes: 1, hazardVent: 0.5, hazardFrost: 0.9,
  resonance: 0.87, down: 0.9, revived: 1, heal: 1, wave: 0.65, chamberClear: 1, bossPhase: 0.8, boonOwn: 0.85, boonAlly: 1,
  door: 0.85, doorCursed: 0.75, doorBoss: 0.73, tutorial: 0.85,
} as const;

/** Balance between the three element colours per size (0 status tick, 1 hit layer, 2 burst). */
const ELEMENT_LEVEL: Record<ElementId, [number, number, number]> = {
  ember: [0.9, 0.6, 1],
  rime: [1.1, 1.5, 1],
  storm: [1.35, 1.5, 1],
};

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
  /** ping.2 rings at 1976 Hz (B6); this lands it on D7, a glitter above the boon jingle. */
  PING_TO_D7: 2349.3 / 1976,
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
const CUE_NEEDS: SampleGroup[] = ['swing.cloth', 'swing.blade', 'swing.draw', 'earth', 'bell', 'laser.small', 'laser.large', 'field', 'zap.up', 'zap.jump', 'hit.plate', 'glass.mid'];
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
  let forceSynth = false;

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
    if (!forceSynth && player.has(...needs)) { designed++; stack(); } else { fallbacks++; fallback(); }
  };

  type Layer = (group: SampleGroup, t: number, gain: number, o?: Omit<VoiceOpts, 'gain'>) => void;
  interface Mix { V: Layer; out: GainNode }
  /** Reverb send that belongs to an event's mix node. */
  const sends = new WeakMap<AudioNode, AudioNode>();
  /** Mix nodes in creation order, waiting to be unplugged once their sound is certainly over. */
  const retired: { at: number; nodes: AudioNode[] }[] = [];

  /**
   * One sounding event: a mix node with the event's level on a bus (plus a matching reverb send), and a
   * sample-layer function bound to it. Synth layers reach the same node through tone() / noise() below.
   */
  const mix = (bus: BusName | 'ui', pri: number, level: number): Mix => {
    const born = g.ctx.currentTime;
    while (retired.length > 0 && born - retired[0].at > TUNE.MIX_TTL) {
      for (const node of retired.shift()?.nodes ?? []) node.disconnect();
    }
    const out = g.ctx.createGain();
    out.gain.value = level;
    out.connect(bus === 'ui' ? g.ui : g.buses[bus]);
    const entry = { at: born, nodes: [out] as AudioNode[] };
    retired.push(entry);
    let send: GainNode | undefined;
    if (bus !== 'ui') {
      send = g.ctx.createGain();
      send.gain.value = level;
      send.connect(g.reverbIn);
      sends.set(out, send);
      entry.nodes.push(send);
      if (TUNE.ROOM[bus] > 0) {
        const room = g.ctx.createGain();
        room.gain.value = TUNE.ROOM[bus];
        out.connect(room).connect(g.reverbIn);
        entry.nodes.push(room);
      }
    }
    const V: Layer = (group, t, gain, o) => {
      player.play(group, t, { ...o, gain, dest: out, reverb: send, pool: bus, pri, send: send ? o?.send : 0 });
    };
    return { V, out };
  };
  const tone = (out: AudioNode, t: number, o: ToneOpts): void => engineTone(g, out, t, o, sends.get(out) ?? g.reverbIn);
  const noise = (out: AudioNode, t: number, o: NoiseOpts): void => engineNoise(g, out, t, o, sends.get(out) ?? g.reverbIn);

  const uiMix = (level: number): Mix => mix('ui', VOICES.PRI.OWN, level);
  const bigMix = (level: number): Mix => mix('big', VOICES.PRI.OWN, level);
  const worldMix = (level: number): Mix => mix('combat', VOICES.PRI.WORLD, level);
  /** Mix for something a hero does: the own hero is louder, on its own bus and wins voice stealing. */
  const who = (own: boolean, level: number): Mix & { pri: number } => {
    const pri = own ? VOICES.PRI.OWN : VOICES.PRI.PARTY;
    return { ...mix(own ? 'own' : 'combat', pri, level * (own ? TUNE.OWN_GAIN : TUNE.OTHER_GAIN)), pri };
  };

  const whoosh = (out: AudioNode, t: number, from: number, peak: number, to: number, dur: number, gain: number): void => {
    noise(out, t, { dur: dur * 0.5, gain, filter: 'bandpass', freq: from, freqEnd: peak, q: 1.4, attack: dur * 0.2 });
    noise(out, t + dur * 0.35, { dur: dur * 0.65, gain: gain * 0.8, filter: 'bandpass', freq: peak, freqEnd: to, q: 1.4 });
  };
  const thump = (out: AudioNode, t: number, freq: number, dur: number, gain: number): void => {
    tone(out, t, { freq, freqEnd: freq * 0.4, dur, gain });
  };

  // ---------------------------------------------------------------- element layers (synthesis + sample grain)
  /** size 0 = status tick, 1 = hit, 2 = burst (Resonance, blasts). Works without samples, richer with them. */
  const element = (el: ElementId, t: number, level: number, size: 0 | 1 | 2, pri: number): void => {
    const { V, out } = mix('element', pri, level * ELEMENT_LEVEL[el][size]);
    const burst = size === 2;
    if (el === 'ember') {
      // crackle and whoosh: a slice of real fire under a falling noise sweep, with popping embers
      noise(out, t, { dur: burst ? 0.5 : 0.2, gain: 0.5, filter: 'bandpass', freq: 1700, freqEnd: 420, q: 1.2, send: burst ? 0.3 : 0 });
      tone(out, t, { type: 'sawtooth', freq: 150, freqEnd: 70, dur: burst ? 0.32 : 0.16, gain: 0.4, lpf: 500 });
      for (let i = 0, pops = 2 + size * 3; i < pops; i++) {
        noise(out, t + 0.02 + Math.random() * (0.12 + size * 0.14), { dur: 0.022, gain: rnd(0.3, 0.6), filter: 'highpass', freq: rnd(3000, 5600) });
      }
      V('tex.fire', t, burst ? 2.4 : 1.6, { offset: -1, dur: 0.1 + size * 0.14, attack: 0.008, release: 0.14 + size * 0.12, lpf: 7000, lpfEnd: 900, rate: 1.15, send: burst ? 0.3 : 0.1 });
      if (burst) V('boom', t, 0.55, { variant: 2, rate: 1.2, dur: 0.45, release: 0.3, send: 0.3 });
    } else if (el === 'rime') {
      // glassy shimmer and crunch: struck glass, snow underfoot, high partials that ring into the room
      for (const [f, d] of [[2637, 0.2], [3520, 0.15], [4699, 0.11]] as const) {
        tone(out, t, { freq: f * jitter(0.02), dur: d * (burst ? 2.2 : 1), gain: 0.2, send: 0.4 });
      }
      noise(out, t, { dur: 0.05, gain: 0.3, filter: 'highpass', freq: 6000 });
      V('glass.light', t, 0.9, { rate: size === 0 ? 1.6 : 1.3, send: 0.3 });
      if (size >= 1) V('snow', t, 0.7, { rate: 1.1, hpf: 500 });
      if (burst) {
        V('glass.mid', t, 0.9, { rate: 1.1, send: 0.4 });
        V('glass.heavy', t, 0.6, { rate: 1.25, send: 0.3 });
        V('shimmer', t, 0.22, { rate: 0.82, attack: 0.03, send: 0.6, jitter: 0.02 });
        for (let i = 0; i < 3; i++) V('glass.light', t, 0.4 - i * 0.1, { at: 0.05 + i * rnd(0.04, 0.07), rate: 1.5 + i * 0.25, send: 0.5 });
      }
    } else {
      // zap and crackle: a falling saw, a rough low buzz and a scatter of tiny digital sparks
      tone(out, t, { type: 'sawtooth', freq: 2200 * jitter(0.1), freqEnd: 180, dur: 0.09, gain: 0.4, lpf: 5000 });
      tone(out, t + 0.03, { type: 'square', freq: 96, dur: burst ? 0.22 : 0.09, gain: 0.35, lpf: 1400, am: 0.8, amHz: 55 });
      noise(out, t, { dur: 0.06, gain: 0.35, filter: 'bandpass', freq: 4200, q: 3 });
      for (let i = 0, sparks = 2 + size * 2; i < sparks; i++) {
        V('spark', t, rnd(0.5, 0.9), { at: i === 0 ? 0 : rnd(0.01, 0.07 + size * 0.09), rate: rnd(0.8, 1.6), jitter: 0 });
      }
      if (size >= 1) V('scratch', t, 0.4, { rate: rnd(0.8, 1.3), dur: 0.09, hpf: 1500 });
      if (burst) {
        V('zap.down', t, 0.5, { rate: 1.25, send: 0.3 });
        V('zap.long', t, 0.35, { rate: 0.9, lpf: 6000, send: 0.4 });
        noise(out, t + 0.04, { dur: 0.6, gain: 0.3, filter: 'lowpass', freq: 320, freqEnd: 70, send: 0.4 });
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
  const primary = (cls: ClassId, step: number, own: boolean, stackLevel: number, t: number): void => {
    const finisher = step >= 2;
    switch (cls) {
      case 'knight': {
        const { V, out } = who(own, LEVEL.knight * stackLevel);
        if (finisher) {
          // heavier third swing: lower, longer, with the blade ringing out
          V('swing.blade', t, 0.5, { rate: 0.78 });
          V('swing.draw', t, 0.5, { rate: 0.8 });
          V('swing.cloth', t, 0.5, { rate: 0.85 });
          V('hit.ring', t, 0.07, { at: 0.06, rate: 0.5, send: 0.5 });
          whoosh(out, t, 500, 2400, 350, 0.26, 0.16);
          thump(out, t + 0.05, 120, 0.16, 0.14);
        } else {
          V('swing.blade', t, 0.42, { rate: step === 1 ? 1.1 : 0.97, hpf: 700 });
          V('swing.cloth', t, 0.32, { rate: 1.25, lpf: 2600 });
          whoosh(out, t, 700, 3200, 500, 0.16, 0.12);
        }
        break;
      }
      case 'barbarian': {
        const { V, out } = who(own, LEVEL.barbarian * stackLevel);
        V('swing.cloth', t, 0.7, { rate: finisher ? 0.58 : 0.72 });
        V('swing.blade', t, 0.3, { rate: finisher ? 0.55 : 0.66, lpf: 3800 });
        if (finisher) V('swing.draw', t, 0.35, { rate: 0.52, at: 0.03 });
        whoosh(out, t, 320, finisher ? 1300 : 1700, 240, finisher ? 0.32 : 0.24, 0.17);
        thump(out, t + 0.06, finisher ? 90 : 118, 0.2, finisher ? 0.16 : 0.1);
        break;
      }
      case 'mage': {
        const { V, out } = who(own, LEVEL.mage * stackLevel);
        V('laser.small', t, 0.5, { rate: 1.18, lpf: 5200, send: 0.3 });
        V('ping', t, 0.14, { rate: 1.5, send: 0.4 });
        tone(out, t, { type: 'triangle', freq: 980 * jitter(0.06), freqEnd: 340, dur: 0.14, gain: 0.2, send: 0.25 });
        tone(out, t, { freq: 1960 * jitter(0.06), freqEnd: 700, dur: 0.1, gain: 0.08 });
        noise(out, t, { dur: 0.08, gain: 0.08, filter: 'highpass', freq: 4500 });
        break;
      }
      case 'rogue': {
        const { V, out } = who(own, LEVEL.rogue * stackLevel);
        // crossbow: latch click, stock thunk, string twang, the bolt leaving
        V('foley.latch', t, 0.5, { rate: 1.2 });
        V('hit.bone', t, 0.3, { rate: 1.5 });
        V('hit.thud', t, 0.28, { rate: 1.35, dur: 0.1 });
        V('swing.blade', t, 0.16, { rate: 1.6, hpf: 2500, dur: 0.12 });
        tone(out, t, { type: 'triangle', freq: 340 * jitter(0.05), freqEnd: 150, dur: 0.12, gain: 0.24 });
        noise(out, t + 0.015, { dur: 0.1, gain: 0.12, filter: 'bandpass', freq: 3000, freqEnd: 1200, q: 2 });
        break;
      }
    }
  };

  const secondary = (cls: ClassId, own: boolean, stackLevel: number, t: number): void => {
    const def = CLASSES[cls].secondary;
    switch (cls) {
      case 'knight': {
        // shield bash: plate and iron, a body blow, a short bell-like ring
        const { V, out } = who(own, LEVEL.knightBash * stackLevel);
        V('hit.plate', t, 0.7);
        V('hit.clang', t, 0.45, { rate: 0.8, send: 0.3 });
        V('hit.heavy', t, 0.55);
        V('bell', t, 0.1, { variant: 3, rate: 1.3, dur: 0.4, release: 0.25, send: 0.6 });
        whoosh(out, t, 400, 1800, 300, 0.22, 0.14);
        thump(out, t, 150, 0.26, 0.24);
        break;
      }
      case 'barbarian': {
        // whirlwind: one pass of the axe per damage tick, for as long as the spin lasts
        const { V, out } = who(own, LEVEL.whirl * stackLevel);
        const period = Math.max(0.12, def.tick);
        const turns = Math.max(1, Math.round(def.duration / period));
        for (let i = 0; i < turns; i++) {
          const at = i * period;
          V('swing.cloth', t, 0.5, { at, rate: 0.62 + (i % 2) * 0.1 });
          V('swing.blade', t, 0.22, { at: at + 0.04, rate: 0.66 + i * 0.03, lpf: 4200 });
          whoosh(out, t + at, 300, 1400 + i * 110, 260, period * 1.3, 0.14);
        }
        tone(out, t, { type: 'sawtooth', freq: 82, freqEnd: 112, dur: def.duration, gain: 0.07, lpf: 420, attack: 0.1, hold: def.duration * 0.6 });
        noise(out, t, { dur: def.duration + 0.15, gain: 0.07, filter: 'bandpass', freq: 500, freqEnd: 900, q: 0.8, attack: 0.15, hold: def.duration * 0.7 });
        V('swing.draw', t, 0.4, { at: def.duration, rate: 0.7 });
        break;
      }
      case 'mage': {
        // nova: charge for the wind-up, then the blast
        const { V, out } = who(own, LEVEL.nova * stackLevel);
        const wind = def.windup;
        V('field', t, 0.5, { rate: 1.25, dur: wind, release: 0.08, lpf: 2500 });
        V('boom', t, 0.3, { variant: 1, reverse: true, fit: wind });
        tone(out, t, { type: 'triangle', freq: 220, freqEnd: 990, dur: wind, gain: 0.1, attack: wind * 0.6, send: 0.4 });
        noise(out, t, { dur: wind, gain: 0.06, filter: 'bandpass', freq: 800, freqEnd: 5200, q: 2, attack: wind * 0.75 });
        V('boom', t, 0.7, { at: wind, variant: 1, send: 0.4 });
        V('boom.sub', t, 0.55, { at: wind });
        V('glass.mid', t, 0.25, { at: wind, rate: 1.4, send: 0.4 });
        tone(out, t + wind, { freq: 120, freqEnd: 36, dur: 0.5, gain: 0.3 });
        noise(out, t + wind, { dur: 0.4, gain: 0.14, filter: 'lowpass', freq: 5200, freqEnd: 200, send: 0.3 });
        break;
      }
      case 'rogue': {
        // knife fan: one blade per knife, a hair apart, rising
        const { V, out } = who(own, LEVEL.fan * stackLevel);
        for (let i = 0; i < def.count; i++) {
          V('swing.blade', t, 0.26, { at: i * 0.018, rate: 1.2 + i * 0.08, dur: 0.12, hpf: 1200 });
        }
        V('swing.draw', t, 0.45, { rate: 1.3 });
        whoosh(out, t, 900, 3400, 700, 0.18, 0.12);
        break;
      }
    }
  };

  /** Signature cue of a boss / elite ability. `rate` and `send` carry the caster's colour. */
  const cue = (name: CueName, t: number, rate: number, send: number): void => {
    if (name === 'blink') {
      const { V, out } = worldMix(LEVEL.blink);
      V('zap.jump', t, 0.3, { rate: 1.2 * rate, send: 0.5 });
      whoosh(out, t, 600, 2600, 400, 0.18, 0.08);
      return;
    }
    const { V, out } = bigMix(LEVEL.cue);
    switch (name) {
      case 'beam':
        V('laser.large', t, 0.6, { rate: 0.6 * rate, send });
        V('field', t, 0.5, { rate: 0.8 * rate, send });
        for (const detune of [-14, 9]) tone(out, t, { type: 'sawtooth', freq: 196 * rate, freqEnd: 262 * rate, detune, dur: 1, gain: 0.07, lpf: 900, lpfEnd: 3200, attack: 0.12, hold: 0.6, send });
        noise(out, t, { dur: 1, gain: 0.07, filter: 'bandpass', freq: 1800, freqEnd: 4200, q: 2.5, attack: 0.2, hold: 0.5 });
        break;
      case 'wisp':
        V('zap.up', t, 0.35, { rate: 0.7 * rate, lpf: 3200, send: 0.8 });
        V('shimmer', t, 0.12, { rate: 0.5 * rate, attack: 0.05, send: 0.8, jitter: 0.02 });
        tone(out, t, { freq: 520 * rate, freqEnd: 780 * rate, dur: 0.7, gain: 0.09, attack: 0.15, vib: 35, vibHz: 6, send: 0.8 });
        noise(out, t, { dur: 0.6, gain: 0.05, filter: 'bandpass', freq: 1400, freqEnd: 2600, q: 4, attack: 0.25, send: 0.6 });
        break;
      case 'leap':
        V('swing.cloth', t, 0.8, { rate: 0.5 * rate });
        whoosh(out, t, 200, 1800 * rate, 500, 0.42, 0.2);
        tone(out, t, { type: 'sawtooth', freq: 70 * rate, freqEnd: 140 * rate, dur: 0.4, gain: 0.12, lpf: 600, attack: 0.05, am: 0.5 });
        break;
      case 'volley':
        for (let i = 0; i < 3; i++) V('laser.small', t, 0.4, { at: i * 0.09, rate: (0.7 + i * 0.1) * rate, send });
        V('swing.draw', t, 0.35, { rate: 0.8 * rate });
        tone(out, t, { type: 'triangle', freq: 300 * rate, freqEnd: 600 * rate, dur: 0.3, gain: 0.08, send });
        break;
      case 'spear':
        V('swing.draw', t, 0.6, { rate: 0.7 * rate });
        V('swing.blade', t, 0.5, { rate: 0.6 * rate, at: 0.04 });
        V('hit.bone', t, 0.3, { rate: 0.7 * rate });
        whoosh(out, t, 600, 4000, 800, 0.22, 0.18);
        break;
      case 'slam':
        V('earth', t, 0.6, { rate: 0.8 * rate, send });
        V('hit.plate', t, 0.45, { rate: 0.7 * rate });
        V('creak', t, 0.14, { rate: 0.5 * rate, send });
        tone(out, t, { freq: 90 * rate, freqEnd: 45, dur: 0.5, gain: 0.22, attack: 0.03 });
        break;
      case 'sweep':
        V('swing.cloth', t, 0.8, { rate: 0.6 * rate });
        V('swing.blade', t, 0.45, { rate: 0.5 * rate, lpf: 4000 });
        whoosh(out, t, 250, 1300 * rate, 200, 0.4, 0.2);
        break;
      case 'charge':
        V('earth', t, 0.4, { rate: 1.1 * rate });
        V('earth', t, 0.5, { at: 0.18, rate: 0.95 * rate });
        tone(out, t, { type: 'sawtooth', freq: 55 * rate, freqEnd: 110 * rate, dur: 0.6, gain: 0.13, lpf: 300, lpfEnd: 1200, attack: 0.1, am: 0.6, amHz: 24 });
        whoosh(out, t + 0.1, 200, 900, 300, 0.5, 0.12);
        break;
      case 'summon':
        V('bell', t, 0.4, { variant: 2, rate: TUNED.BELL2_D3 * rate, send: 0.9, jitter: 0 });
        V('glass.mid', t, 0.25, { reverse: true, rate: 0.6, send: 0.7 });
        for (const [f, q] of [[350, 6], [800, 8]] as const) noise(out, t, { dur: 1.1, gain: 0.1, filter: 'bandpass', freq: f * rate, q, attack: 0.3, hold: 0.4, send: 0.6 });
        for (const n of [NOTE.D3, NOTE.F3, NOTE.A3]) tone(out, t, { type: 'sawtooth', freq: midiToHz(n) * rate, dur: 1.1, gain: 0.03, lpf: 900, attack: 0.3, hold: 0.4, send: 0.6 });
        clatter(V, t + 0.3, 5, 0.6, 0.22);
        break;
    }
  };

  const api = {
    // ------------------------------------------------------------ UI (dry)
    hover(): void {
      const t = now();
      if (take('hover', t) < 0) return;
      use(['ui.hover'], () => uiMix(LEVEL.hover).V('ui.hover', t, 0.5), () => synth.hover());
    },
    click(): void {
      const t = now();
      if (take('ui', t) < 0) return;
      use(['ui.click'], () => uiMix(LEVEL.click).V('ui.click', t, 0.8), () => synth.click());
    },
    confirm(): void {
      const t = now();
      if (take('ui', t) < 0) return;
      use(['ui.click', 'ui.confirm'], () => {
        const { V } = uiMix(LEVEL.confirm);
        V('ui.click', t, 0.6);
        V('ui.confirm', t, 0.7, { at: 0.02, jitter: 0 });
      }, () => synth.confirm());
    },
    back(): void {
      const t = now();
      if (take('ui', t) < 0) return;
      use(['ui.back'], () => uiMix(LEVEL.back).V('ui.back', t, 0.8), () => synth.back());
    },
    ready(on: boolean): void {
      const t = now();
      if (take('ui', t) < 0) return;
      use(['ui.ready', 'ui.back', 'ui.click'], () => {
        const { V } = uiMix(LEVEL.ready);
        V('ui.click', t, 0.5);
        if (on) V('ui.ready', t, 0.75, { at: 0.02, jitter: 0 });
        else V('ui.back', t, 0.4, { at: 0.02, rate: 0.75 });
      }, () => synth.ready(on));
    },
    error(): void {
      const t = now();
      if (take('ui', t) < 0) return;
      use(['ui.error'], () => {
        const { V } = uiMix(LEVEL.error);
        V('ui.error', t, 0.9, { variant: 1, rate: 0.9 });
        V('ui.error', t, 0.7, { variant: 2, at: 0.11, rate: 0.8 });
      }, () => synth.error());
    },
    denied(): void {
      const t = now();
      if (take('ui', t) < 0) return;
      use(['ui.error'], () => uiMix(LEVEL.denied).V('ui.error', t, 0.6, { variant: 1, rate: 1.25, dur: 0.07 }), () => synth.denied());
    },
    draftPick(): void {
      const t = now();
      use(['ui.card', 'ui.drop'], () => {
        const { V, out } = uiMix(LEVEL.draftPick);
        V('ui.card', t, 0.6);
        V('ui.drop', t, 0.5, { at: 0.05, rate: 0.7 });
        tone(out, t + 0.04, { freq: 120, freqEnd: 48, dur: 0.2, gain: 0.14 });
        [NOTE.D5, NOTE.A5, NOTE.D6].forEach((n, i) => {
          tone(out, t + 0.05 + i * 0.05, { freq: midiToHz(n), dur: 0.6, gain: 0.06 });
          tone(out, t + 0.05 + i * 0.05, { freq: midiToHz(n) * 2.76, dur: 0.22, gain: 0.014 });
        });
      }, () => synth.draftPick());
    },
    countdownTick(last: boolean): void {
      const t = now();
      use(['ui.tick'], () => {
        const { V, out } = uiMix(LEVEL.tick);
        V('ui.tick', t, 0.9, { variant: last ? 2 : 1, rate: last ? 1.35 : 1, jitter: 0 });
        tone(out, t, { type: 'triangle', freq: last ? 1480 : 990, freqEnd: last ? 1300 : 860, dur: 0.06, gain: 0.12, lpf: 3000 });
      }, () => synth.countdownTick(last));
    },
    buy(): void {
      const t = now();
      if (take('ui', t) < 0) return;
      use(['ui.coins', 'ui.buy'], () => {
        const { V } = uiMix(LEVEL.buy);
        V('ui.coins', t, 0.6);
        V('ui.buy', t, 0.6, { at: 0.09, jitter: 0 });
      }, () => synth.buy());
    },
    equip(): void {
      const t = now();
      if (take('ui', t) < 0) return;
      use(['ui.equip', 'foley.latch'], () => {
        const { V } = uiMix(LEVEL.equip);
        V('ui.equip', t, 0.6);
        V('foley.latch', t, 0.3, { at: 0.12, variant: 1 });
      }, () => synth.equip());
    },
    tab(): void {
      const t = now();
      if (take('ui', t) < 0) return;
      use(['ui.tab'], () => uiMix(LEVEL.tab).V('ui.tab', t, 0.8), () => synth.tab());
    },
    toggle(): void {
      const t = now();
      if (take('ui', t) < 0) return;
      use(['ui.toggle'], () => uiMix(LEVEL.toggle).V('ui.toggle', t, 0.7), () => synth.toggle());
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
        const { V, out } = who(own, LEVEL.dash * duck(stack));
        V('swing.cloth', t, 0.65, { rate: 1.12 });
        V('bone.tap', t, 0.2, { at: 0.16, rate: 0.8 });
        whoosh(out, t, 500, 3200, 900, 0.2, 0.15);
        tone(out, t, { freq: 320, freqEnd: 760, dur: 0.13, gain: 0.05 });
      }, () => synth.dash(own));
    },
    /** An enemy ability. Bosses' big attacks get a signature cue chosen from the ability id. */
    enemyCast(ability = '', kind: EnemyKind | null = null): void {
      const t = now();
      const id = ability.toLowerCase();
      const match = CUES.find(([part]) => id.includes(part));
      const tint = TINT[kind ?? 'other'] ?? TINT.other;
      if (match && take(match[1] === 'blink' ? 'enemyCast' : 'cue', t) >= 0) {
        use(CUE_NEEDS, () => cue(match[1], t, tint.rate, tint.send), () => synth.enemyCast());
        return;
      }
      const stack = take('enemyCast', t);
      if (stack < 0) return;
      use(['swing.cloth'], () => {
        const { V, out } = worldMix(LEVEL.enemyCast * duck(stack));
        V('swing.cloth', t, 0.3, { rate: 0.9 * tint.rate });
        whoosh(out, t, 260, 1100, 220, 0.2, 0.08);
      }, () => synth.enemyCast());
    },

    // ------------------------------------------------------------ combat feedback
    hit(o: HitOpts): void {
      const t = now();
      const pri = o.own ? VOICES.PRI.OWN : VOICES.PRI.PARTY;
      if (o.tick) {
        const stack = take('tick', t);
        if (stack < 0) return;
        const { V, out } = who(o.own, LEVEL.hitTick * duck(stack));
        V('hit.bone', t, 0.14, { rate: 0.8, lpf: 1800 });
        if (o.el) element(o.el, t, (o.own ? 0.1 : 0.06) * LEVEL.hitTick * duck(stack), 0, pri);
        else tone(out, t, { type: 'triangle', freq: 200, freqEnd: 110, dur: 0.05, gain: 0.1 });
        return;
      }
      const stack = take('hit', t);
      if (stack >= 0) {
        const weight = Math.min(1, Math.max(0, o.dmg) / TUNE.HEAVY_DAMAGE);
        const shield = o.shielded === true || o.dmg <= 0;
        const size = duck(stack) * (0.6 + weight * 0.4);
        use(['hit.bone', 'hit.body', 'hit.heavy', 'hit.thud', 'hit.metal', 'hit.tin', 'hit.sub', 'hit.plate'], () => {
          const { V, out } = who(o.own, (shield ? LEVEL.hitShield : LEVEL.hit) * size);
          if (shield) {
            // shield: metal rings instead of bone thudding
            V('hit.metal', t, 0.6, { rate: 1.05 - weight * 0.2, send: 0.25 });
            V('hit.tin', t, 0.35, { rate: 0.9 });
            V('hit.body', t, 0.2, { rate: 1.1 });
            tone(out, t, { freq: 1380 * jitter(0.06), dur: 0.2, gain: 0.035, send: 0.4 });
          } else if (weight < TUNE.HEAVY_FROM) {
            V('hit.bone', t, 0.55);
            V('hit.body', t, 0.42, { rate: 1.12 });
            noise(out, t, { dur: 0.03, gain: 0.16, filter: 'bandpass', freq: 3600 * jitter(0.15), q: 0.8 }); // snap
          } else {
            V('hit.thud', t, 0.55, { rate: 1 - weight * 0.15 });
            V('hit.heavy', t, 0.55, { rate: 1.05 - weight * 0.15 });
            V('hit.bone', t, 0.3, { rate: 0.8 });
            noise(out, t, { dur: 0.045, gain: 0.2, filter: 'bandpass', freq: 2800 * jitter(0.15), q: 0.7 }); // crack
          }
          if (o.boss) {
            V('hit.sub', t, 0.5);
            V('hit.plate', t, 0.25, { rate: 0.8, send: 0.3 });
          }
          switch (o.weapon) {
            case 'knight': V('swing.blade', t, 0.16, { rate: 1.3, dur: 0.09, hpf: 1500 }); break;
            case 'barbarian': V('swing.chop', t, 0.4, { rate: 0.8 }); break;
            case 'rogue': V('bone.tick', t, 0.3, { rate: 1.4 }); break;
            case 'mage': V('spark', t, 0.25, { rate: 1.2 }); break;
            default: break;
          }
        }, () => synth.hit({ dmg: o.dmg, crit: false, el: null, own: o.own }));
      }
      if (o.crit && take('crit', t) >= 0) {
        const { V, out } = who(o.own, LEVEL.crit);
        V('hit.ring', t, 0.3, { rate: 1.2, send: 0.4 });
        V('glass.light', t, 0.14, { rate: 1.7, send: 0.3 });
        tone(out, t, { type: 'square', freq: 1568, freqEnd: 2093, dur: 0.1, gain: 0.07, lpf: 6000, send: 0.2 });
        noise(out, t, { dur: 0.04, gain: 0.08, filter: 'highpass', freq: 5200 });
        thump(out, t, 140, 0.12, 0.14);
      }
      if (o.el) {
        const elStack = take('element', t);
        if (elStack >= 0) element(o.el, t, (o.own ? 0.34 : 0.2) * duck(elStack), 1, pri);
      }
    },
    status(el: ElementId): void {
      const t = now();
      const stack = take('status', t);
      if (stack >= 0) element(el, t, 0.1 * duck(stack), 0, VOICES.PRI.WORLD);
    },
    /** The signature sound: element `a` ignites, element `b` detonates into a tonal bloom. Chains climb in pitch. */
    resonance(a: ElementId, b: ElementId, own: boolean): void {
      const t = now();
      const stack = take('resonance', t);
      if (stack < 0) return;
      chain.n = t - chain.last < TUNE.CHAIN_WINDOW ? Math.min(TUNE.CHAIN_MAX, chain.n + 1) : 0;
      chain.last = t;
      const level = (own ? 0.9 : 0.62) * duck(stack) * LEVEL.resonance;
      const pri = own ? VOICES.PRI.OWN : VOICES.PRI.PARTY;
      const { V, out } = mix('element', pri, level);
      const lift = semitones(CHAIN_STEPS[chain.n]);
      const rate = 1 + chain.n * TUNE.CHAIN_RATE_STEP;
      const t2 = t + TUNE.RESONANCE_GAP;
      // part 1: ignition — the first element snaps and the air is sucked in
      element(a, t, level * 0.5, 1, pri);
      V('hit.sub', t, 0.5, { rate });
      V('glass.mid', t, 0.2, { reverse: true, fit: TUNE.RESONANCE_GAP });
      noise(out, t, { dur: TUNE.RESONANCE_GAP, gain: 0.14, filter: 'bandpass', freq: 500, freqEnd: 4200 * lift, q: 1.5, attack: TUNE.RESONANCE_GAP * 0.8 });
      // part 2: detonation — the second element bursts over a sub drop
      element(b, t2, level * 0.62, 2, pri);
      V('boom', t2, 0.55, { variant: 1, rate: rate * 1.05, send: 0.35 });
      V('boom.sub', t2, 0.6, { rate });
      tone(out, t2, { freq: 120, freqEnd: 36, dur: 0.7, gain: 0.34 });
      noise(out, t2, { dur: 0.5, gain: 0.16, filter: 'lowpass', freq: 5200, freqEnd: 180, send: 0.3 });
      // bloom: a chord that depends on the element pair, arpeggio direction on the order, pitch on the chain
      const pair = [a, b].sort().join('+');
      const root = (PAIR_ROOT[pair] ?? NOTE.D4) + CHAIN_STEPS[chain.n];
      const rising = a < b;
      (rising ? BLOOM_CHORD : [...BLOOM_CHORD].reverse()).forEach((semi, i) => {
        const f = midiToHz(root + semi);
        tone(out, t2 + 0.02 + i * 0.045, { type: 'triangle', freq: f, dur: 1.1, gain: 0.075, attack: 0.012, send: 0.65, lpf: 4200 });
        tone(out, t2 + 0.02 + i * 0.045, { freq: f * 2, dur: 0.6, gain: 0.025, detune: 6, send: 0.65 });
      });
      tone(out, t2, { freq: midiToHz(root - 12), dur: 0.9, gain: 0.12, attack: 0.03, send: 0.4 });
      V('ping', t2, 0.2, { at: 0.03, rate: lift * 0.75, jitter: 0.01, send: 0.7 });
      V('shimmer', t2, 0.1, { rate: lift * 0.5, attack: 0.04, send: 0.8, jitter: 0.01 });
      g.duckMusic(0.5, 0.3, 0.6);
    },
    kill(kind: EnemyKind, own: boolean): void {
      const t = now();
      if (isBig(kind)) {
        if (take('big', t) < 0) return;
        use(['boom', 'boom.sub', 'bell', 'bone.tick', 'hit.bone', 'bone.tap'], () => {
          const { V, out } = bigMix(LEVEL.bigKill);
          V('boom', t, 0.9, { variant: 3, send: 0.5 });
          V('boom.sub', t, 0.8);
          V('bell', t, 0.5, { variant: 2, rate: TUNED.BELL2_D3, at: 0.1, send: 0.8, jitter: 0 });
          clatter(V, t + 0.08, 12, 1, 0.5);
          tone(out, t, { freq: 110, freqEnd: 30, dur: 1.4, gain: 0.36 });
          [NOTE.D4, NOTE.A3, NOTE.F3, NOTE.D3].forEach((n, i) =>
            tone(out, t + 0.1 + i * 0.16, { type: 'sawtooth', freq: midiToHz(n), dur: 0.7, gain: 0.05, lpf: 1400, send: 0.5 }));
          g.duckMusic(0.35, 0.9, 1.2);
        }, () => synth.kill(kind, own));
        return;
      }
      const stack = take('kill', t);
      if (stack < 0) return;
      use(['bone.tick', 'hit.bone', 'bone.tap', 'hit.thud'], () => {
        // bone clatter: three to five knocks, never the same twice, then the body drops
        const { V, out } = who(own, LEVEL.kill * duck(stack));
        clatter(V, t, 3 + Math.floor(Math.random() * 3), 0.2, 0.5);
        V('hit.thud', t, 0.3, { rate: 0.8 });
        V('foley.fall', t, 0.3, { at: 0.07 });
        if (kind === 'warrior') V('hit.tin', t, 0.2, { at: 0.04, rate: 0.9 });
        if (kind === 'mage') V('ping', t, 0.1, { rate: 0.8, send: 0.5 });
        noise(out, t, { dur: 0.12, gain: 0.07, filter: 'bandpass', freq: 1300, freqEnd: 300, q: 1.1 });
        if (own) tone(out, t + 0.04, { freq: midiToHz(NOTE.A6) * jitter(0.01), dur: 0.3, gain: 0.025, send: 0.5 });
      }, () => synth.kill(kind, own));
    },
    spawn(kind: EnemyKind, elite: boolean): void {
      const t = now();
      if (isBig(kind)) {
        if (take('big', t) < 0) return;
        const tint = TINT[kind] ?? TINT.other;
        use(['boom', 'earth', 'bell'], () => {
          // a reversed blast swells into the ground breaking open and a bell
          const { V, out } = bigMix(LEVEL.bigSpawn);
          V('boom', t, 0.4, { variant: 3, reverse: true, fit: 1.15 });
          V('earth', t, 0.8, { at: 1.1, rate: 0.7 * tint.rate, send: 0.5 });
          V('bell', t, 0.5, { at: 1.1, variant: 2, rate: TUNED.BELL2_D3 * (kind === 'matron' ? 2 : 1), send: 0.8, jitter: 0 });
          const low = 46 * tint.rate;
          tone(out, t, { type: 'sawtooth', freq: low, freqEnd: low * 1.3, dur: 1.5, gain: 0.2, lpf: 240, lpfEnd: 900, attack: 0.3, send: 0.4 });
          tone(out, t, { type: 'sawtooth', freq: low * 1.5, freqEnd: low * 1.9, dur: 1.5, gain: 0.09, lpf: 300, lpfEnd: 1100, attack: 0.4 });
          noise(out, t, { dur: 1.3, gain: 0.1, filter: 'lowpass', freq: 300, freqEnd: 1600, attack: 0.5, send: 0.4 });
          g.duckMusic(0.5, 1.2, 1);
        }, () => synth.spawn(kind, elite));
        return;
      }
      const stack = take('spawn', t);
      if (stack < 0) return;
      use(['earth', 'bone.tick'], () => {
        // rising from the floor: a crumble of earth, two bones finding their place
        const { V, out } = worldMix(LEVEL.spawn * duck(stack) * (elite ? 1.3 : 1));
        V('earth', t, 0.22, { rate: 1.35, dur: 0.3, release: 0.15, lpf: 1200 });
        V('bone.tick', t, 0.16, { at: 0.08, rate: rnd(0.9, 1.4) });
        V('bone.tick', t, 0.12, { at: 0.16, rate: rnd(1.1, 1.7) });
        if (elite) V('bell', t, 0.07, { variant: 3, rate: 0.6, send: 0.7 });
        tone(out, t, { freq: elite ? 60 : 78, freqEnd: elite ? 96 : 120, dur: 0.35, gain: 0.05, attack: 0.1 });
      }, () => synth.spawn(kind, elite));
    },
    telegraph(seconds: number): void {
      const t = now();
      if (take('telegraph', t) < 0) return;
      const urgent = seconds < 0.7;
      use(['ui.tick'], () => {
        const { V, out } = bigMix(LEVEL.telegraph);
        V('ui.tick', t, 0.35, { variant: 1, rate: urgent ? 1.5 : 1.15, jitter: 0.02 });
        tone(out, t, { type: 'square', freq: urgent ? 988 : 784, freqEnd: urgent ? 1046 : 830, dur: 0.07, gain: 0.09, lpf: 2400 });
      }, () => synth.telegraph(seconds));
    },
    aoe(el: ElementId | null, hostile: boolean): void {
      const t = now();
      const stack = take('aoe', t);
      if (stack < 0) return;
      use(['earth', 'hit.sub', 'hit.tight', 'hit.clang'], () => {
        if (hostile) {
          const { V, out } = bigMix(LEVEL.aoeHostile * duck(stack));
          V('earth', t, 0.5, { rate: 1.1, send: 0.3 });
          V('hit.sub', t, 0.5);
          V('hit.clang', t, 0.14, { rate: 0.7 });
          tone(out, t, { freq: 105, freqEnd: 40, dur: 0.34, gain: 0.24 });
          tone(out, t, { type: 'sawtooth', freq: 233, freqEnd: 110, dur: 0.2, gain: 0.05, lpf: 900 });
          noise(out, t, { dur: 0.28, gain: 0.14, filter: 'lowpass', freq: 1500, freqEnd: 180, send: 0.25 });
          if (el) element(el, t, 0.3 * LEVEL.aoeHostile * duck(stack), 2, VOICES.PRI.OWN);
        } else {
          const { V, out } = worldMix(LEVEL.aoeFriendly * duck(stack));
          V('hit.tight', t, 0.4);
          noise(out, t, { dur: 0.25, gain: 0.12, filter: 'lowpass', freq: 2600, freqEnd: 180, send: 0.25 });
          if (el) element(el, t, 0.22 * LEVEL.aoeFriendly * duck(stack), 1, VOICES.PRI.PARTY);
        }
      }, () => synth.aoe(el, hostile));
    },
    hurt(own: boolean, dmg: number): void {
      const t = now();
      const stack = take('hurt', t);
      if (stack < 0) return;
      const weight = Math.min(1, Math.max(0, dmg) / TUNE.HEAVY_DAMAGE);
      use(['hit.heavy', 'hit.sub', 'hit.body', 'swing.cloth'], () => {
        if (own) {
          const { V, out } = mix('own', VOICES.PRI.OWN, LEVEL.hurtOwn * (0.8 + weight * 0.2));
          V('hit.heavy', t, 0.9);
          V('hit.sub', t, 0.6);
          V('swing.cloth', t, 0.3, { rate: 0.8 });
          tone(out, t, { type: 'sawtooth', freq: 240, freqEnd: 105, dur: 0.2, gain: 0.3, lpf: 800 });
          tone(out, t, { freq: 70, freqEnd: 40, dur: 0.18, gain: 0.24 });
          // the blow dulls the world for a moment
          g.muffle(900 - weight * 400, 0.1 + weight * 0.1, 0.4);
          g.duckMusic(0.7, 0.15, 0.4);
        } else {
          const { V, out } = mix('combat', VOICES.PRI.PARTY, LEVEL.hurtAlly * duck(stack));
          V('hit.body', t, 0.35, { rate: 0.9 });
          tone(out, t, { type: 'triangle', freq: 330, freqEnd: 190, dur: 0.12, gain: 0.08, lpf: 1200 });
        }
      }, () => synth.hurt(own, dmg));
    },
    down(own: boolean): void {
      const t = now();
      use(['hit.sub', 'foley.fall', 'swing.cloth', 'bell'], () => {
        const { V, out } = bigMix(LEVEL.down * (own ? 1 : 0.7));
        V('hit.sub', t, 0.8);
        V('swing.cloth', t, 0.5, { at: 0.05, rate: 0.6 });
        V('foley.fall', t, 0.7, { at: 0.14 });
        V('bell', t, 0.35, { at: 0.1, variant: 2, rate: TUNED.BELL2_D3, send: 0.8, jitter: 0 });
        tone(out, t, { freq: 90, freqEnd: 34, dur: 0.9, gain: 0.3 });
        [NOTE.D4, NOTE.A3, NOTE.F3].forEach((n, i) =>
          tone(out, t + i * 0.17, { type: 'triangle', freq: midiToHz(n), dur: 0.8, gain: 0.1, send: 0.6, lpf: 1800 }));
        if (own) {
          g.muffle(420, 0.7, 1.4);
          g.duckMusic(0.4, 1, 1.5);
        }
      }, () => synth.down(own));
    },
    revived(own: boolean): void {
      const t = now();
      use(['zap.up', 'shimmer', 'swing.cloth'], () => {
        const { V, out } = bigMix(LEVEL.revived * (own ? 1 : 0.75));
        V('zap.up', t, 0.25, { rate: 0.8, lpf: 4000, send: 0.6 });
        V('shimmer', t, 0.1, { rate: 0.8, attack: 0.1, send: 0.7, jitter: 0.01 });
        V('swing.cloth', t, 0.3, { rate: 1.2 });
        [NOTE.D4, NOTE.A4, NOTE.D5, NOTE.Fs5].forEach((n, i) => {
          tone(out, t + i * 0.07, { type: 'triangle', freq: midiToHz(n), dur: 0.6, gain: 0.08, send: 0.55 });
          tone(out, t + i * 0.07, { freq: midiToHz(n) * 2, dur: 0.3, gain: 0.025 });
        });
        noise(out, t, { dur: 0.5, gain: 0.04, filter: 'highpass', freq: 3000, freqEnd: 8000, attack: 0.2 });
      }, () => synth.revived(own));
    },
    heal(own: boolean): void {
      const t = now();
      if (take('heal', t) < 0) return;
      use(['ping'], () => {
        const { V, out } = bigMix(LEVEL.heal * (own ? 1 : 0.6));
        V('ping', t, 0.16, { variant: 3, rate: 0.9, send: 0.6 });
        tone(out, t, { freq: 660, freqEnd: 990, dur: 0.28, gain: 0.06, send: 0.4 });
        tone(out, t + 0.08, { freq: 1320, dur: 0.25, gain: 0.035, send: 0.4 });
      }, () => synth.heal(own));
    },
    shieldBreak(): void {
      const t = now();
      const stack = take('shield', t);
      if (stack < 0) return;
      use(['glass.heavy', 'glass.light', 'hit.clang', 'hit.plate'], () => {
        // the shield cracks: a shatter over a clang, shards trailing off
        const { V, out } = mix('combat', VOICES.PRI.PARTY, LEVEL.shieldBreak * duck(stack));
        V('glass.heavy', t, 0.7, { send: 0.3 });
        V('hit.clang', t, 0.55, { send: 0.3 });
        V('hit.plate', t, 0.45);
        V('glass.light', t, 0.3, { at: 0.04, rate: 1.3 });
        V('glass.light', t, 0.2, { at: 0.09, rate: 1.7 });
        noise(out, t, { dur: 0.2, gain: 0.1, filter: 'highpass', freq: 2800 });
        tone(out, t, { type: 'square', freq: 392, freqEnd: 260, dur: 0.1, gain: 0.06, lpf: 1800 });
      }, () => synth.shieldBreak());
    },
    hazard(kind: Hazard['kind'], victim: HazardVictim): void {
      const t = now();
      const stack = take('hazard', t);
      if (stack < 0) return;
      const own = victim === 'own';
      const size = (own ? 1 : victim === 'ally' ? 0.6 : 0.4) * duck(stack);
      const pri = own ? VOICES.PRI.OWN : VOICES.PRI.WORLD;
      use(['hit.metal', 'swing.blade', 'hit.body', 'snow'], () => {
        if (kind === 'spikes') {
          const { V } = mix(own ? 'own' : 'combat', pri, LEVEL.hazardSpikes * size);
          V('hit.metal', t, 0.45, { rate: 1.3, send: 0.2 });
          V('swing.blade', t, 0.4, { rate: 1.4, dur: 0.1 });
          V('hit.body', t, 0.4, { at: 0.02 });
        } else if (kind === 'vent') {
          const { V } = mix(own ? 'own' : 'combat', pri, LEVEL.hazardVent * size);
          element('ember', t, 0.4 * LEVEL.hazardVent * size, 2, pri);
          V('tex.fire', t, 1.6, { offset: -1, dur: 0.35, attack: 0.03, release: 0.3, lpf: 5000, lpfEnd: 700 });
        } else {
          const { V, out } = mix(own ? 'own' : 'combat', pri, LEVEL.hazardFrost * size);
          element('rime', t, 0.35 * LEVEL.hazardFrost * size, 1, pri);
          V('snow', t, 0.6, { rate: 0.85 });
          noise(out, t, { dur: 0.4, gain: 0.07, filter: 'highpass', freq: 5000, attack: 0.1 });
        }
      }, () => synth.hazard(kind, own));
    },

    // ------------------------------------------------------------ run flow
    wave(): void {
      const t = now();
      use(['drum.war', 'hit.sub'], () => {
        const { V, out } = bigMix(LEVEL.wave);
        V('drum.war', t, 0.7, { variant: 2 });
        V('drum.war', t, 0.85, { at: 0.22, variant: 1, rate: 0.92, send: 0.4 });
        V('hit.sub', t, 0.5, { at: 0.22 });
        for (const n of [NOTE.D3, NOTE.A3]) {
          tone(out, t + 0.05, { type: 'sawtooth', freq: midiToHz(n), dur: 0.8, gain: 0.05, lpf: 420, lpfEnd: 1100, attack: 0.12, send: 0.45 });
        }
      }, () => synth.wave());
    },
    chamberClear(): void {
      const t = now();
      use(['jingle.rise', 'bell'], () => {
        // a pizzicato run up to D, answered by a bell and a major chord
        const { V, out } = bigMix(LEVEL.chamberClear);
        V('jingle.rise', t, 0.6, { rate: TUNED.RISE_TO_D, jitter: 0, gainJitter: 0, send: 0.5 });
        V('bell', t, 0.3, { at: 0.75, variant: 1, rate: TUNED.BELL1_D4, jitter: 0, send: 0.7 });
        [NOTE.D4, NOTE.Fs4, NOTE.A4, NOTE.D5, NOTE.Fs5].forEach((n, i) => {
          tone(out, t + 0.75 + i * 0.07, { type: 'triangle', freq: midiToHz(n), dur: 1.3, gain: 0.055, send: 0.6 });
        });
        tone(out, t + 0.75, { freq: midiToHz(NOTE.D2), dur: 1.6, gain: 0.16, attack: 0.05 });
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
        const { V, out } = bigMix(LEVEL.bossPhase);
        V('bell', t, 0.35, { variant: 1, reverse: true, fit: 0.4, send: 0.5 });
        const r = t + 0.38;
        V('boom', r, 0.9, { variant: 3, rate: 0.9 * rate, send: 0.5 });
        V('boom.sub', r, 0.9);
        V('bell', r, 0.6, { variant: 2, rate: TUNED.BELL2_D3, jitter: 0, send: 0.9 });
        V('drum.fill', r, 0.5, { variant: 2, rate: 0.85, send: 0.4 });
        // the roar: detuned saws through a rising low-pass, roughened, over a band of breath
        for (const [freq, detune] of [[74, 0], [104, 18], [148, -12]] as const) {
          tone(out, r, { type: 'sawtooth', freq: freq * rate, freqEnd: freq * rate * 0.6, detune, dur: 1.5, gain: 0.16, lpf: 380, lpfEnd: 1700 * rate, attack: 0.08, am: 0.7, amHz: 27, send: 0.5 });
        }
        noise(out, r, { dur: 1.3, gain: 0.16, filter: 'bandpass', freq: 500 * rate, freqEnd: 1500 * rate, q: 0.9, attack: 0.15, send: 0.5 });
        tone(out, r, { freq: 60, freqEnd: 30, dur: 0.8, gain: 0.26 });
        g.duckMusic(0.3, 1.2, 1);
      }, () => synth.bossPhase());
    },
    boon(own: boolean): void {
      const t = now();
      use(['jingle.fifth', 'ping'], () => {
        if (own) {
          const { V, out } = bigMix(LEVEL.boonOwn);
          V('jingle.fifth', t, 0.5, { rate: TUNED.FIFTH_TO_D, jitter: 0, gainJitter: 0, send: 0.5 });
          V('ping', t, 0.12, { at: 0.3, variant: 2, rate: TUNED.PING_TO_D7, jitter: 0, send: 0.7 });
          [NOTE.D6, NOTE.A6].forEach((n, i) => tone(out, t + 0.3 + i * 0.06, { freq: midiToHz(n), dur: 0.45, gain: 0.04, send: 0.55 }));
        } else {
          const { out } = bigMix(LEVEL.boonAlly);
          [NOTE.D6, NOTE.A6].forEach((n, i) => tone(out, t + i * 0.055, { freq: midiToHz(n), dur: 0.45, gain: 0.03, send: 0.55 }));
        }
      }, () => synth.boon(own));
    },
    doorChosen(type: DoorType): void {
      const t = now();
      use(['door.open', 'creak', 'foley.latch', 'bell', 'jingle.magic', 'jingle.fall'], () => {
        const { V, out } = bigMix(type === 'cursed' ? LEVEL.doorCursed : type === 'boss' ? LEVEL.doorBoss : LEVEL.door);
        V('foley.latch', t, 0.4, { variant: 1 });
        V('door.open', t, 0.6, { at: 0.05, send: 0.4 });
        V('creak', t, 0.22, { at: 0.1, rate: 0.8, send: 0.5 });
        tone(out, t, { freq: 84, freqEnd: 36, dur: 0.6, gain: 0.28 });
        noise(out, t, { dur: 0.6, gain: 0.1, filter: 'lowpass', freq: 600, freqEnd: 140, send: 0.4 });
        const c = t + 0.25;
        if (type === 'boon') {
          [NOTE.D5, NOTE.A5].forEach((n, i) => tone(out, c + i * 0.07, { type: 'triangle', freq: midiToHz(n), dur: 0.8, gain: 0.07, lpf: 4000, send: 0.6 }));
        } else if (type === 'blessing') {
          // warm: a rising run into a major chord
          V('jingle.magic', c, 0.42, { rate: TUNED.MAGIC_TO_D, jitter: 0, gainJitter: 0, send: 0.6, lpf: 5000 });
          V('shimmer', c, 0.07, { rate: 0.64, attack: 0.2, send: 0.8, jitter: 0 });
          [NOTE.D4, NOTE.Fs4, NOTE.A4, NOTE.D5].forEach((n, i) => tone(out, c + 0.2 + i * 0.05, { type: 'triangle', freq: midiToHz(n), dur: 1.4, gain: 0.05, attack: 0.08, lpf: 3000, send: 0.6 }));
        } else if (type === 'cursed') {
          // ominous: a slow chromatic fall, a low bell and a tritone
          V('jingle.fall', c, 0.45, { rate: TUNED.FALL_DARK, jitter: 0, gainJitter: 0, lpf: 1800, send: 0.7 });
          V('bell', c, 0.4, { variant: 2, rate: TUNED.BELL2_D3 / 2, jitter: 0, send: 0.8 });
          for (const n of [NOTE.D3, NOTE.D3 + 6]) tone(out, c, { type: 'sawtooth', freq: midiToHz(n), dur: 1.8, gain: 0.05, lpf: 700, attack: 0.2, hold: 0.6, send: 0.6, am: 0.3, amHz: 7 });
        } else {
          V('bell', c, 0.6, { variant: 2, rate: TUNED.BELL2_D3, jitter: 0, send: 0.9 });
          V('boom.sub', c, 0.5);
          V('drum.war', c, 0.6, { variant: 1, rate: 0.85 });
          for (const n of [NOTE.D3, NOTE.D3 + 1, NOTE.D3 + 6]) tone(out, c, { type: 'sawtooth', freq: midiToHz(n), dur: 1.6, gain: 0.045, lpf: 900, attack: 0.15, send: 0.6 });
        }
      }, () => synth.doorChosen(type));
    },
    tutorialStep(): void {
      const t = now();
      use(['jingle.resolve'], () => {
        const { V, out } = bigMix(LEVEL.tutorial);
        V('jingle.resolve', t, 0.45, { jitter: 0, gainJitter: 0, send: 0.4 });
        tone(out, t + 0.5, { freq: midiToHz(NOTE.D5), dur: 0.5, gain: 0.04, send: 0.5 });
      }, () => synth.tutorialStep());
    },

    /** Dev workbench: play the synthesised fallbacks even though the samples are there (A/B listening). */
    setForceSynth(on: boolean): void {
      forceSynth = on;
    },
    /** Counters for the dev workbench and tests. */
    stats(): { designed: number; fallbacks: number; voices: number; dropped: number; stolen: number; chain: number; mixNodes: number } {
      const p = player.stats();
      return { designed, fallbacks, voices: p.active, dropped: p.dropped, stolen: p.stolen, chain: chain.n, mixNodes: retired.length };
    },
    player,
  };
  return api;
}
