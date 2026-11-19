/**
 * Update 5, keystones: power has to be audible.
 *
 *  - A signature sound for each of the 23 keystones (`keystoneProc`), built so that no two share register AND
 *    gesture: the own hero hears the full sound, allies a quieter one without its tail.
 *  - What a keystone costs: Blood Price's payment, Glass Cannon's brittle hits, Titan Grip's slow, heavy swing.
 *  - Continuous keystones: the whirr of the orbiting blades (own hero only, very quiet), the mage's stream while it
 *    is channelled, the walking sanctum's hum, Bloodrush's heartbeat that quickens with every stack.
 *  - The keystone moment (`keystoneTaken`): build, impact and a shimmering tail in the timbre of the keystone's
 *    family; a short cue for allies; a falling "let go" in front when a keystone was replaced.
 *  - The keystone draft's stinger, the richer pick of a boon that fits the build, and the power layers the own
 *    hero's primary and secondary gain with every keystone held (weight first, sparkle second).
 *
 * Everything works without samples: the synthesised layers carry each sound, samples add grain.
 */
import { KEYSTONE_BY_ID } from '@shared/data/keystones.ts';
import { midiToHz, MIX as ENGINE, type BusName } from './engine.ts';
import { BLOODRUSH, keystoneFamily, rushPulse, rushStacks, type KeystoneFamily } from './keystone-map.ts';
import { NOTE, rnd, TUNED, type Family, type Mix, type SfxKit } from './sfx-kit.ts';

type M = Mix & { pri: number };

const LV = {
  /** Allies' keystone sounds relative to the own hero's (on top of the party trim of `who`). */
  ally: 0.55,
  moment: 0.56, momentAlly: 0.5, replaced: 0.8,
  draftOpen: 0.58, fits: 0.7,
  weight: 0.5, sparkle: 0.75,
  brittle: 0.9, titanSwing: 0.9,
  whirr: 0.05, stream: 0.16, streamAlly: 0.06, sanctum: 0.24, rush: 0.6,
  /** The familiar's shots when they are only derived from a timer: a hint, not a report. */
  derived: 0.5,
} as const;

/** Level of each signature (1 = as designed), balanced against offline renders: see docs/AUDIO.md section 11. */
const SIG_LEVEL: Record<string, number> = {
  ember_wake: 0.43, shockstep: 0.42, phase_walker: 1, ricochet: 0.8, chain_lightning: 0.75, heavy_hitter: 0.55,
  twin_cast: 1, blood_price: 1, orbit_blades: 0.6, familiar: 0.7, colossus: 0.48, corpse_bloom: 0.6,
  resonance_engine: 0.9, glass_cannon: 0.75, sanguine: 0.45, momentum_engine: 0.9, ks_knight: 0.85, ks_barbarian: 0.7,
  ks_mage: 0.7, ks_rogue: 1.7, ks_templar: 0.6, ks_spellblade: 1.7, ks_shade: 0.6,
};

export const KEYSTONE_SFX = {
  /** Shortest time between two sounds of the same keystone for the own hero (s); allies: ALLY_GAP times as long. */
  GAP: {
    ember_wake: 0.4, shockstep: 0.2, phase_walker: 0.3, ricochet: 0.07, chain_lightning: 0.12, heavy_hitter: 0.18,
    twin_cast: 0.25, blood_price: 0.25, orbit_blades: 0.22, familiar: 0.3, colossus: 0.3, corpse_bloom: 0.08,
    resonance_engine: 0.2, glass_cannon: 0.12, sanguine: 0.5, momentum_engine: 0.1, ks_knight: 0.25, ks_barbarian: 0.5,
    ks_mage: 0.11, ks_rogue: 0.3, ks_templar: 0.5, ks_spellblade: 0.14, ks_shade: 0.4,
  } as Record<string, number>,
  DEFAULT_GAP: 0.15,
  ALLY_GAP: 2,
  /** Corpse blooms closer together than this are one chain: each burst sounds a step higher. */
  CHAIN_WINDOW: 1.2,
  CHAIN_MAX: 8,
  /** Chain lightning: events this close together are arcs of one burst; each sounds ARC_GAP after the last; at most ARCS_MAX. */
  ARC_TICK: 0.05,
  ARC_GAP: 0.048,
  ARCS_MAX: 4,
  /** Titan Grip: one swing per hero in this time (the local press and the sim's report are the same swing). */
  SWING_GAP: 0.3,
  /** The mage's stream keeps sounding this long after the last cast / pulse that fed it (s). */
  STREAM_KEEP: 0.34,
  STREAM_FADE: 0.05,
  LOOP_ATTACK: 0.12,
  LOOP_RELEASE: 0.18,
  /** Longest sanctum hum scheduled ahead (the mix node is recycled after 12 s). */
  SANCTUM_MAX: 10,
  /** The keystone moment: seconds from the start to the impact, and how long the tail shimmers. */
  BUILD: 0.42,
  TAIL: 2.2,
  /** A replaced keystone is let go this long before the new one's build starts. */
  LET_GO: 0.32,
  MAX_TRACKED: 16,
} as const;

/** Keystone ids with a designed signature (the workbench and the unit test compare this with data/keystones.ts). */
export const KEYSTONE_SIGNATURE_IDS = [
  'ember_wake', 'shockstep', 'phase_walker', 'ricochet', 'chain_lightning', 'heavy_hitter', 'twin_cast', 'blood_price',
  'orbit_blades', 'familiar', 'colossus', 'corpse_bloom', 'resonance_engine', 'glass_cannon', 'sanguine', 'momentum_engine',
  'ks_knight', 'ks_barbarian', 'ks_mage', 'ks_rogue', 'ks_templar', 'ks_spellblade', 'ks_shade',
] as const;
type SignatureId = (typeof KEYSTONE_SIGNATURE_IDS)[number];

/** Keystones whose procs come in chains (bounces, arcs, blooms, cuts): they share one limiter, the rest another. */
const CHAINED = new Set(['ricochet', 'chain_lightning', 'corpse_bloom', 'orbit_blades', 'ks_mage']);

/** D natural minor from D4, for the climbing blooms. */
const MINOR = [0, 2, 3, 5, 7, 8, 10, 12, 14];

export interface ProcOpts {
  /** `keystoneProc.n`: stacks, bounces, blades, arcs. */
  n?: number;
  /** `keystoneProc.r`: a radius (bigger = lower and longer where the sound has a size). */
  r?: number;
  /** The sound is derived by the client, not reported by the sim: played softer. */
  derived?: boolean;
}

interface SigCtx { m: M; t: number; own: boolean; n: number | undefined; size: number }
type Signature = (c: SigCtx) => void;

/** `until` = Infinity while the loop sounds, the time its nodes stop once it was ended; `fed` = when a stream was last kept alive. */
interface Loop { out: GainNode; nodes: AudioScheduledSourceNode[]; until: number; level: number; fed: number }

export function createKeystoneSfx(k: SfxKit) {
  const ctx = k.g.ctx;
  const lastProc = new Map<string, number>();
  const bloom = { n: 0, last: -Infinity };
  /** Arcs of the chain-lightning burst in progress, per hero key. */
  const arcs = new Map<string, { at: number; n: number }>();
  const lastSwing = new Map<boolean, number>();
  const rush: { mix: Mix | null; until: number; stacks: number } = { mix: null, until: -Infinity, stacks: 0 };
  let whirr: Loop | null = null;
  const streams = new Map<string, Loop>();
  const sanctums = new Map<number, { mix: Mix; until: number }>();

  const hz = midiToHz;
  const brass = (out: AudioNode, t: number, midi: number, dur: number, gain: number): void => {
    for (const detune of [-7, 6]) {
      k.tone(out, t, { type: 'sawtooth', freq: hz(midi), detune, dur, gain, lpf: 700, lpfEnd: 2600, q: 1.4, attack: 0.02, hold: dur * 0.5, send: 0.5 });
    }
    k.tone(out, t, { type: 'triangle', freq: hz(midi), dur, gain: gain * 0.8, attack: 0.015, hold: dur * 0.5, send: 0.5 });
  };
  /** Wordless voices: noise and saws through two vowel bands. */
  const choir = (out: AudioNode, t: number, midis: number[], dur: number, gain: number, open: boolean): void => {
    const bands = open ? [[640, 7, 1], [1080, 9, 0.6]] : [[340, 6, 1], [780, 8, 0.45]];
    for (const [freq, q, level] of bands) k.noise(out, t, { dur, gain: gain * level * 2.4, filter: 'bandpass', freq, q, attack: dur * 0.25, hold: dur * 0.3, send: 0.7 });
    for (const midi of midis) k.tone(out, t, { type: 'sawtooth', freq: hz(midi), dur, gain: gain * 0.5, lpf: open ? 1500 : 800, attack: dur * 0.25, hold: dur * 0.3, vib: 9, vibHz: 5.2, send: 0.6 });
  };

  // ------------------------------------------------------------------ loops (sound until they are stopped)
  const makeLoop = (bus: BusName, level: number): Loop => {
    const t = k.now();
    const out = ctx.createGain();
    out.gain.setValueAtTime(0, t);
    out.gain.setTargetAtTime(level, t, KEYSTONE_SFX.LOOP_ATTACK / 3);
    out.connect(k.g.buses[bus]);
    return { out, nodes: [], until: Infinity, level, fed: t };
  };
  const loopNoise = (loop: Loop): AudioBufferSourceNode => {
    const src = ctx.createBufferSource();
    src.buffer = k.g.noise;
    src.loop = true;
    k.g.track(src);
    src.start(k.now(), Math.random() * (ENGINE.NOISE_SECONDS - 0.1));
    loop.nodes.push(src);
    return src;
  };
  const loopOsc = (loop: Loop, type: OscillatorType, freq: number, detune = 0): OscillatorNode => {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    osc.detune.value = detune;
    k.g.track(osc);
    osc.start(k.now());
    loop.nodes.push(osc);
    return osc;
  };
  const band = (type: BiquadFilterType, freq: number, q: number): BiquadFilterNode => {
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    filter.Q.value = q;
    return filter;
  };
  const gainOf = (value: number): GainNode => {
    const node = ctx.createGain();
    node.gain.value = value;
    return node;
  };
  const endLoop = (loop: Loop, tc: number): void => {
    const t = k.now();
    loop.out.gain.cancelScheduledValues(t);
    loop.out.gain.setTargetAtTime(0, t, tc);
    const stop = t + tc * 8;
    for (const node of loop.nodes) node.stop(stop);
    loop.nodes[0]?.addEventListener('ended', () => loop.out.disconnect(), { once: true });
    loop.until = stop;
  };

  /**
   * Orbiting blades: three passes per turn at one turn per second, so a soft swish three times a second that also
   * wanders left and right once per turn. Steel is a narrow band of air around 2.6 kHz plus a thin ring above it.
   */
  const startWhirr = (): Loop => {
    const def = KEYSTONE_BY_ID.get('orbit_blades')?.params;
    const turnsPerSecond = (def?.rpm ?? 60) / 60;
    const passes = turnsPerSecond * (def?.blades ?? 3);
    const loop = makeLoop('own', LV.whirr);
    const air = band('bandpass', 2600, 2.4);
    const ring = band('bandpass', 5200, 6);
    const src = loopNoise(loop);
    const swish = gainOf(0.45);
    src.connect(air).connect(swish);
    src.connect(ring).connect(gainOf(0.35)).connect(swish);
    const lfo = loopOsc(loop, 'sine', passes);
    lfo.connect(gainOf(0.45)).connect(swish.gain);
    // the blades' own note: barely there, a fifth above the tonic, beating with itself
    const tone = gainOf(0.05);
    loopOsc(loop, 'triangle', hz(NOTE.A5)).connect(tone);
    loopOsc(loop, 'triangle', hz(NOTE.A5), 14).connect(tone);
    tone.connect(swish);
    if (typeof ctx.createStereoPanner === 'function') {
      const pan = ctx.createStereoPanner();
      loopOsc(loop, 'sine', turnsPerSecond).connect(gainOf(0.6)).connect(pan.pan);
      swish.connect(pan).connect(loop.out);
    } else {
      swish.connect(loop.out);
    }
    return loop;
  };

  /** Arc Stream: a steady electric beam — a buzzing fifth through a narrow band, crackle above, 50 Hz roughness. */
  const startStream = (own: boolean): Loop => {
    const loop = makeLoop(own ? 'own' : 'combat', own ? LV.stream : LV.streamAlly);
    const body = band('bandpass', 1500, 1.6);
    const mixIn = gainOf(0.6);
    loopOsc(loop, 'sawtooth', hz(NOTE.D3)).connect(body);
    loopOsc(loop, 'sawtooth', hz(NOTE.A3), 9).connect(body);
    loopOsc(loop, 'square', hz(NOTE.D4), -11).connect(gainOf(0.4)).connect(body);
    body.connect(mixIn);
    const crackle = band('bandpass', 5200, 3);
    loopNoise(loop).connect(crackle).connect(gainOf(0.5)).connect(mixIn);
    loopOsc(loop, 'triangle', 50).connect(gainOf(0.38)).connect(mixIn.gain);
    // the beam "sings": a slow wobble of the band
    loopOsc(loop, 'sine', 3.1).connect(gainOf(260)).connect(body.frequency);
    mixIn.connect(loop.out);
    // the room hears the beam through the loop's own level, so it fades with it
    if (own) loop.out.connect(gainOf(0.25)).connect(k.g.reverbIn);
    return loop;
  };

  // ------------------------------------------------------------------ the 23 signatures
  const SIGNATURES: Record<SignatureId, Signature> = {
    // ---- movement
    /** Blazing Wake: air catches fire along the dash, then the trail crackles for as long as it burns. */
    ember_wake({ m, t, own }) {
      const seconds = KEYSTONE_BY_ID.get('ember_wake')?.params.seconds ?? 3.5;
      k.noise(m.out, t, { dur: 0.42, gain: 0.5, filter: 'bandpass', freq: 380, freqEnd: 2800, q: 1, attack: 0.14, send: 0.3 });
      k.tone(m.out, t, { type: 'sawtooth', freq: 110, freqEnd: 190, dur: 0.34, gain: 0.2, lpf: 600, attack: 0.08 });
      m.V('tex.fire', t, 2, { offset: -1, dur: 0.4, attack: 0.08, release: 0.3, lpf: 6500, rate: 1.1, send: 0.3 });
      for (let i = 0; i < 4; i++) k.noise(m.out, t + 0.1 + i * rnd(0.04, 0.08), { dur: 0.02, gain: rnd(0.25, 0.5), filter: 'highpass', freq: rnd(3200, 5600) });
      if (!own) return;
      // the trail: low fire and embers popping until it is out
      const hold = Math.max(0.1, seconds - 1);
      k.noise(m.out, t + 0.3, { dur: seconds, gain: 0.1, filter: 'bandpass', freq: 900, freqEnd: 500, q: 0.8, attack: 0.2, hold, send: 0.2 });
      m.V('tex.fireLow', t, 0.9, { at: 0.3, offset: -1, dur: Math.min(2.2, seconds - 0.6), attack: 0.2, release: 0.8, free: true });
      for (let at = 0.45; at < seconds - 0.2; at += rnd(0.12, 0.3)) {
        k.noise(m.out, t + at, { dur: 0.018, gain: rnd(0.08, 0.2) * (1 - at / (seconds * 1.3)), filter: 'highpass', freq: rnd(2800, 5200) });
      }
    },
    /** Shockstep: the dash ends in a wave of pressure — a dull boom and a ring of air rolling outwards. */
    shockstep({ m, t, own, size }) {
      k.tone(m.out, t, { freq: 96 / size, freqEnd: 30, dur: 0.6, gain: 0.5 });
      k.noise(m.out, t, { dur: 0.5 * size, gain: 0.4, filter: 'lowpass', freq: 800, freqEnd: 90, send: 0.4 });
      m.V('boom', t, 0.6, { variant: 1, rate: 0.85 / size, lpf: 900, send: 0.4 });
      m.V('hit.sub', t, 0.5);
      k.noise(m.out, t, { dur: 0.01, gain: 0.3, filter: 'lowpass', freq: 900 });
      if (own) m.V('boom.sub', t, 0.4, { rate: 0.9 });
    },
    /** Phase Walker: slipping through a body — a glass swell turned backwards, two notes up, then a charged shimmer. */
    phase_walker({ m, t, own }) {
      const seconds = KEYSTONE_BY_ID.get('phase_walker')?.params.seconds ?? 2;
      m.V('shimmer', t, 0.3, { reverse: true, fit: 0.16, send: 0.5 });
      m.V('zap.jump', t, 0.35, { at: 0.12, rate: 1.5, send: 0.4 });
      k.noise(m.out, t, { dur: 0.16, gain: 0.14, filter: 'highpass', freq: 5000, attack: 0.13 });
      for (const [i, n] of [NOTE.A5, NOTE.E6].entries()) {
        k.tone(m.out, t + 0.14 + i * 0.07, { freq: hz(n), dur: 0.5, gain: 0.16, send: 0.6 });
        k.tone(m.out, t + 0.14 + i * 0.07, { type: 'triangle', freq: hz(n) * 2, dur: 0.2, gain: 0.05, send: 0.5 });
      }
      // empowered: the next hit is waiting — a thin, trembling high note for as long as it lasts
      if (own) k.tone(m.out, t + 0.28, { freq: hz(NOTE.E6), dur: seconds, gain: 0.035, attack: 0.1, hold: seconds * 0.6, am: 0.9, amHz: 11, send: 0.5 });
    },
    // ---- primary
    /** Ricochet: the classic — a struck edge whose note bends up and away; each bounce a step higher. */
    ricochet({ m, t, n }) {
      // the sim reports the bounces LEFT: the first bounce is the lowest, the last the highest
      const bounces = KEYSTONE_BY_ID.get('ricochet')?.params.bounces ?? 2;
      const step = Math.max(0, Math.min(5, bounces - (n ?? bounces)));
      const f = 2300 * Math.pow(2, step / 6);
      k.tone(m.out, t, { freq: f, freqEnd: f * 2.3, dur: 0.16, gain: 0.3, send: 0.15 });
      k.tone(m.out, t, { type: 'triangle', freq: f * 1.5, freqEnd: f * 3.1, dur: 0.1, gain: 0.1 });
      k.noise(m.out, t, { dur: 0.012, gain: 0.4, filter: 'bandpass', freq: 3600, q: 2 });
      m.V('hit.ring', t, 0.5, { rate: 1.7 + step * 0.15, dur: 0.1, hpf: 2000, send: 0.15 });
      m.V('pew', t, 0.3, { rate: 1.2 + step * 0.12, reverse: true, fit: 0.14 });
    },
    /** Chain Lightning: one arc per event (`n` = which arc of the burst, 1-based) — together a quick stutter of zaps jumping away. */
    chain_lightning({ m, t, own, n }) {
      const i = Math.max(1, n ?? 1) - 1;
      const pan = i % 2 === 0 ? -0.4 : 0.4;
      k.tone(m.out, t, { type: 'sawtooth', freq: 3400 * k.jitter(0.12) * (1 + i * 0.12), freqEnd: 420, dur: 0.045, gain: 0.3, lpf: 7000 });
      k.noise(m.out, t, { dur: 0.03, gain: 0.3, filter: 'bandpass', freq: 5200, q: 2.5, pan });
      m.V('spark', t, 0.6, { rate: rnd(1, 1.7), jitter: 0, pan });
      k.tone(m.out, t, { type: 'square', freq: 110, dur: 0.07, gain: 0.16, lpf: 1600, am: 0.9, amHz: 62 });
      if (own && i === 0) m.V('zap.two', t, 0.3, { rate: 1.5, dur: 0.2, release: 0.1, hpf: 900, send: 0.3 });
    },
    /** Titan Grip: the blow lands — iron on bone, then the floor answers a moment later. */
    heavy_hitter({ m, t, own }) {
      m.V('hit.iron', t, 0.9, { rate: 0.62, send: 0.3 });
      m.V('hit.clang', t, 0.5, { rate: 0.5, send: 0.4 });
      k.tone(m.out, t, { type: 'square', freq: 196, freqEnd: 180, dur: 0.3, gain: 0.12, lpf: 1400, send: 0.4 });
      k.tone(m.out, t, { freq: 392 * 1.48, dur: 0.22, gain: 0.07, send: 0.4 });
      k.noise(m.out, t, { dur: 0.012, gain: 0.5, filter: 'bandpass', freq: 1800, q: 1 });
      const ground = t + 0.1;
      k.tone(m.out, ground, { freq: 78, freqEnd: 30, dur: 0.5, gain: 0.5 });
      m.V('earth', ground, 0.5, { rate: 0.7, lpf: 1800, send: 0.3 });
      if (own) m.V('hit.sub', ground, 0.6);
    },
    // ---- secondary
    /** Twin Cast: the spell answers itself — the same plucked note twice, the second from further away and an octave up. */
    twin_cast({ m, t, own }) {
      m.V('glass.mid', t, 0.16, { reverse: true, fit: 0.1, rate: 1, send: 0.5 });
      for (const [i, gain] of [1, 0.6].entries()) {
        const at = t + 0.1 + i * 0.17;
        const n = NOTE.D4 + i * 12;
        k.tone(m.out, at, { type: 'triangle', freq: hz(n), dur: 0.3, gain: 0.3 * gain, lpf: 2400, lpfEnd: 700, send: 0.3 + i * 0.4 });
        k.tone(m.out, at, { type: 'square', freq: hz(n), dur: 0.08, gain: 0.07 * gain, lpf: 2600 });
        m.V('pluck', at, 0.5 * gain, { rate: 0.5 + i * 0.5, jitter: 0, lpf: 3000, send: 0.3 + i * 0.4 });
      }
      if (own) m.V('zap.two', t, 0.2, { at: 0.1, rate: 0.8, dur: 0.3, release: 0.2, lpf: 3000, send: 0.5 });
    },
    /** Blood Price: paid in health — a heart's double beat, something wet, a note that sinks a semitone. */
    blood_price({ m, t, own }) {
      for (const [at, gain] of [[0, 1], [0.15, 0.7]] as const) {
        k.tone(m.out, t + at, { freq: 74, freqEnd: 40, dur: 0.16, gain: 0.5 * gain });
        k.noise(m.out, t + at, { dur: 0.03, gain: 0.14 * gain, filter: 'lowpass', freq: 500 });
      }
      m.V('slime', t, 0.3, { rate: 0.8, lpf: 1400, dur: 0.25, release: 0.15 });
      k.noise(m.out, t, { dur: 0.12, gain: 0.16, filter: 'bandpass', freq: 520, freqEnd: 260, q: 2.4 });
      for (const [n, detune] of [[NOTE.A3, -6], [NOTE.A3, 7]] as const) {
        k.tone(m.out, t + 0.02, { type: 'sawtooth', freq: hz(n), freqEnd: hz(n - 1), detune, dur: 0.5, gain: 0.07, lpf: 760, attack: 0.02, send: 0.3 });
      }
      if (own) k.g.muffle(2400, 0.08, 0.3);
    },
    // ---- companions and auras
    /** Orbiting Blades: a blade found something — one thin, quick edge of steel. */
    orbit_blades({ m, t }) {
      m.V('swing.blade', t, 0.5, { rate: 1.9, hpf: 2400, dur: 0.07 });
      k.noise(m.out, t, { dur: 0.05, gain: 0.26, filter: 'highpass', freq: 7000, attack: 0.012 });
      k.tone(m.out, t, { freq: 6300 * k.jitter(0.06), dur: 0.07, gain: 0.07 });
    },
    /** Glimmer Familiar: the wisp spits a mote — a small falling chirp with a bell in it. */
    familiar({ m, t, own }) {
      k.tone(m.out, t, { type: 'triangle', freq: 2600, freqEnd: 1300, dur: 0.1, gain: 0.3 });
      k.tone(m.out, t, { freq: 3900, freqEnd: 1950, dur: 0.07, gain: 0.12 });
      m.V('pew', t, 0.4, { rate: 1.8, dur: 0.1, hpf: 1200 });
      if (own) k.tone(m.out, t + 0.02, { freq: hz(NOTE.A6), dur: 0.3, gain: 0.035, send: 0.6 });
    },
    /** Colossus: a giant sets its weight down — the lowest thing in the game, stone settling after it. */
    colossus({ m, t, own }) {
      k.tone(m.out, t, { freq: 58, freqEnd: 26, dur: 1, gain: 0.6, attack: 0.012 });
      k.tone(m.out, t, { type: 'triangle', freq: 87, freqEnd: 40, dur: 0.5, gain: 0.25 });
      k.noise(m.out, t, { dur: 0.7, gain: 0.3, filter: 'lowpass', freq: 240, freqEnd: 60, send: 0.3 });
      m.V('earth', t, 0.7, { rate: 0.5, lpf: 900, send: 0.3 });
      m.V('boom.sub', t, 0.5, { rate: 0.7 });
      if (own) for (let i = 0; i < 4; i++) m.V('bone.tap', t, 0.2 - i * 0.03, { at: 0.2 + i * rnd(0.08, 0.14), rate: 0.6, lpf: 1200 });
    },
    // ---- how you win fights
    /** Corpse Bloom: the body bursts — a wet pop, then a bloom of three notes; every burst of a chain a step higher. */
    corpse_bloom({ m, t, own, n }) {
      const step = MINOR[Math.max(0, Math.min(MINOR.length - 1, (n ?? 1) - 1))];
      const root = NOTE.D3 + step;
      k.noise(m.out, t, { dur: 0.1, gain: 0.5, filter: 'bandpass', freq: 380, freqEnd: 1100, q: 1.6 });
      k.tone(m.out, t, { freq: 190, freqEnd: 80, dur: 0.12, gain: 0.4 });
      m.V('slime', t, 0.4, { rate: 1, dur: 0.16, release: 0.1, lpf: 1200 });
      for (const [i, off] of [0, 7, 12].entries()) {
        k.tone(m.out, t + 0.04 + i * 0.035, { type: 'triangle', freq: hz(root + off), dur: own ? 0.5 : 0.25, gain: 0.16, lpf: 1500, send: 0.5 });
      }
      if (own) {
        k.noise(m.out, t + 0.05, { dur: 0.4, gain: 0.1, filter: 'bandpass', freq: 500, freqEnd: 1200, q: 1.2, attack: 0.1, send: 0.5 });
        m.V('tex.void', t, 0.8, { at: 0.03, offset: -1, dur: 0.2, attack: 0.05, release: 0.2, rate: 1, lpf: 900, send: 0.4 });
      }
    },
    /** Resonance Engine: a dynamo spins up — a motor's rising growl that ends in a struck note (`n` = ultimate charge in percent as index.ts passes it: higher the fuller). */
    resonance_engine({ m, t, own, n }) {
      const full = Math.max(0, Math.min(1, (n ?? 0) / 100));
      const top = NOTE.D5 + Math.round(full * 7);
      for (const detune of [-9, 8]) {
        k.tone(m.out, t, { type: 'sawtooth', freq: 98, freqEnd: 392, detune, dur: 0.36, gain: 0.2, lpf: 500, lpfEnd: 3200, q: 2, attack: 0.26, am: 0.7, amHz: 44 });
      }
      k.noise(m.out, t, { dur: 0.34, gain: 0.1, filter: 'bandpass', freq: 700, freqEnd: 3400, q: 3, attack: 0.28 });
      m.V('arcane', t, 0.3, { variant: 1, fit: 0.34, send: 0.3 });
      const ding = t + 0.34;
      k.tone(m.out, ding, { freq: hz(top), dur: own ? 0.6 : 0.25, gain: 0.16, send: 0.6 });
      k.tone(m.out, ding, { freq: hz(top) * 2.76, dur: 0.2, gain: 0.04, send: 0.4 });
      if (own) m.V('ping', ding, 0.14, { variant: 2, rate: (TUNED.PING_TO_D7 / 4) * Math.pow(2, (top - NOTE.D5) / 12) * 2, jitter: 0, send: 0.7 });
    },
    /** Glass Cannon: what it gives — a small cannon's pop with a ring of glass on top. */
    glass_cannon({ m, t, own }) {
      k.tone(m.out, t, { freq: 170, freqEnd: 60, dur: 0.14, gain: 0.5 });
      k.noise(m.out, t, { dur: 0.05, gain: 0.3, filter: 'lowpass', freq: 900 });
      m.V('hit.tight', t, 0.5, { rate: 1.1 });
      m.V('glass.light', t, 0.22, { at: 0.07, rate: 1.9, send: 0.4 });
      for (const f of [4186, 5588]) k.tone(m.out, t + 0.07, { freq: f * k.jitter(0.01), dur: own ? 0.3 : 0.15, gain: 0.025, send: 0.5 });
    },
    /** Sanguine Pact: drinking — a breath drawn in, a warm third, one soft swallow. */
    sanguine({ m, t }) {
      k.noise(m.out, t, { dur: 0.3, gain: 0.3, filter: 'bandpass', freq: 260, freqEnd: 560, q: 2, attack: 0.22 });
      for (const n of [NOTE.F3, NOTE.A3]) k.tone(m.out, t + 0.06, { type: 'triangle', freq: hz(n), dur: 0.26, gain: 0.2, attack: 0.1, lpf: 700 });
      k.tone(m.out, t + 0.26, { freq: 300, freqEnd: 150, dur: 0.07, gain: 0.2 });
      m.V('slime', t, 0.14, { at: 0.24, rate: 1.2, dur: 0.1, lpf: 900 });
    },
    /** Bloodrush: a kill feeds it — a drum and a snatched breath, a whole tone higher with every stack (see `rush`). */
    momentum_engine({ m, t, n }) {
      const pulse = rushPulse(n);
      const stacks = rushStacks(n);
      k.tone(m.out, t, { freq: 120 * pulse.rate, freqEnd: 60 * pulse.rate, dur: 0.14, gain: 0.34 });
      m.V('drum.low', t, 0.6, { rate: 1.1 * pulse.rate, jitter: 0, dur: 0.2 });
      k.tone(m.out, t, { type: 'triangle', freq: hz(NOTE.D4) * pulse.rate, dur: 0.16, gain: 0.14, lpf: 2400 + stacks * 300 });
      k.noise(m.out, t, { dur: 0.12, gain: 0.08 + stacks * 0.012, filter: 'bandpass', freq: 900 * pulse.rate, freqEnd: 2400 * pulse.rate, q: 1.4, attack: 0.07 });
      if (stacks >= BLOODRUSH.MAX) for (const off of [0, 7]) k.tone(m.out, t + 0.03, { type: 'sawtooth', freq: hz(NOTE.D5 + off), dur: 0.3, gain: 0.05, lpf: 3200, send: 0.4 });
    },
    // ---- class keystones
    /** Shieldburst (knight): the barrier goes off like a bell made of plate — a crack, a ring, and the room shakes. */
    ks_knight({ m, t, own, size }) {
      m.V('hit.plate', t, 0.9, { rate: 0.9 });
      m.V('glass.heavy', t, 0.9, { rate: 1.2, send: 0.4 });
      m.V('hit.clang', t, 0.4, { rate: 1.3, send: 0.4 });
      m.V('boom', t, 0.2, { variant: 2, rate: 1.2 / size, hpf: 300, send: 0.3 });
      k.noise(m.out, t, { dur: 0.3, gain: 0.3, filter: 'highpass', freq: 3500, send: 0.4 });
      for (const [n, gain] of [[NOTE.D5, 0.12], [NOTE.A5, 0.09], [NOTE.D6, 0.05]] as const) {
        k.tone(m.out, t, { type: 'square', freq: hz(n), dur: own ? 0.7 : 0.3, gain, lpf: 6000, lpfEnd: 2000, send: 0.6 });
      }
      k.tone(m.out, t, { freq: 110, freqEnd: 44, dur: 0.4, gain: 0.34 });
      if (own) m.V('field', t, 0.25, { rate: 1.3, dur: 0.4, release: 0.3, send: 0.5 });
    },
    /** Maelstrom (barbarian): the whirlwind pulls — air dragged inwards in turns, each turn lower. */
    ks_barbarian({ m, t, own }) {
      const turns = own ? 4 : 2;
      for (let i = 0; i < turns; i++) {
        const at = t + i * 0.2;
        k.whoosh(m.out, at, 1500 - i * 220, 700 - i * 90, 260, 0.24, 0.26);
        m.V('swing.cloth', at, 0.5, { rate: 0.75 - i * 0.07 });
      }
      for (const [freq, detune] of [[98, 0], [147, 12]] as const) {
        k.tone(m.out, t, { type: 'sawtooth', freq, freqEnd: freq * 0.66, detune, dur: turns * 0.2 + 0.2, gain: 0.16, lpf: 900, lpfEnd: 320, attack: 0.05, hold: turns * 0.1, am: 0.6, amHz: 5 });
      }
      k.noise(m.out, t, { dur: turns * 0.2 + 0.2, gain: 0.12, filter: 'lowpass', freq: 700, freqEnd: 180, attack: 0.1, hold: turns * 0.1, send: 0.3 });
    },
    /** Arc Stream (mage): one pulse of the beam — a tiny electric tick (the beam itself is the `stream` loop). */
    ks_mage({ m, t }) {
      k.tone(m.out, t, { type: 'square', freq: hz(NOTE.D4), dur: 0.05, gain: 0.16, lpf: 2600, am: 0.9, amHz: 70 });
      k.noise(m.out, t, { dur: 0.025, gain: 0.22, filter: 'bandpass', freq: 4400, q: 3 });
      m.V('spark', t, 0.4, { rate: rnd(1.2, 1.8), jitter: 0 });
    },
    /** Fan the Hammer (rogue): the fifth bolt — a ratchet and five knives leaving in one breath, left to right. */
    ks_rogue({ m, t, own }) {
      const knives = KEYSTONE_BY_ID.get('ks_rogue')?.params.knives ?? 5;
      m.V('foley.latch', t, 0.5, { variant: 2, rate: 1.4, jitter: 0.01 });
      for (let i = 0; i < knives; i++) {
        const at = t + 0.03 + i * 0.034;
        const pan = knives > 1 ? (i / (knives - 1)) * 1.4 - 0.7 : 0;
        m.V('swing.blade', at, 0.5, { rate: 1.35 + i * 0.06, dur: 0.09, hpf: 900, pan });
        k.noise(m.out, at, { dur: 0.045, gain: 0.2, filter: 'bandpass', freq: 3000 + i * 260, q: 1.8, attack: 0.01, pan });
        k.tone(m.out, at, { type: 'square', freq: 1320 + i * 110, dur: 0.02, gain: 0.05, lpf: 4000 });
      }
      if (own) m.V('hit.ring', t, 0.18, { at: 0.03 + knives * 0.034, rate: 1.7, dur: 0.2, send: 0.5 });
    },
    /** Walking Sanctum (templar): the ground comes with you — a soft chime on the fifth over a hummed breath. */
    ks_templar({ m, t, own }) {
      for (const [i, n] of [NOTE.A4, NOTE.E5].entries()) {
        k.tone(m.out, t + i * 0.09, { type: 'triangle', freq: hz(n), dur: own ? 0.8 : 0.4, gain: 0.16, attack: 0.16, send: 0.7 });
        k.tone(m.out, t + i * 0.09, { freq: hz(n) * 2, dur: 0.4, gain: 0.03, attack: 0.16, send: 0.6 });
      }
      for (const [freq, q, gain] of [[340, 6, 0.2], [780, 8, 0.1]] as const) k.noise(m.out, t, { dur: 0.6, gain, filter: 'bandpass', freq, q, attack: 0.25, hold: 0.15, send: 0.6 });
      k.tone(m.out, t, { freq: hz(NOTE.D3), dur: 0.5, gain: 0.1, attack: 0.2 });
      if (own) m.V('bell', t, 0.1, { at: 0.16, variant: 1, rate: TUNED.BELL1_D4 * 1.5, jitter: 0, attack: 0.05, send: 0.8 });
    },
    /** Blade Tempest (spellblade): a wave of edge and air — one per cut, three (rising) for the finisher. */
    ks_spellblade({ m, t, own, n }) {
      const waves = Math.max(1, Math.min(3, n ?? 1));
      for (let i = 0; i < waves; i++) {
        const at = t + i * 0.07;
        k.whoosh(m.out, at, 500, 2400 + i * 400, 700, 0.22, 0.26);
        m.V('swing.draw', at, 0.4, { at: 0.04, rate: 0.9 + i * 0.1, lpf: 4500, attack: 0.05 });
        k.tone(m.out, at, { type: 'triangle', freq: hz(NOTE.E5 + i * 2), freqEnd: hz(NOTE.A5 + i * 2), dur: 0.24, gain: 0.14, attack: 0.09, send: 0.4 });
      }
      if (own) m.V('arcane', t, 0.14, { at: 0.05, variant: 2, rate: 1.4, dur: 0.2, attack: 0.06, release: 0.15, send: 0.4 });
    },
    /** Veil of Knives (shade): gone — the room's air is drawn in, a dark breath, and a whisper while the veil holds. */
    ks_shade({ m, t, own }) {
      const veil = KEYSTONE_BY_ID.get('ks_shade')?.params.stealth ?? 1.5;
      m.V('glass.mid', t, 0.25, { reverse: true, rate: 0.5, lpf: 1200, send: 0.6 });
      k.noise(m.out, t, { dur: 0.5, gain: 0.34, filter: 'bandpass', freq: 900, freqEnd: 180, q: 1.2, attack: 0.3, send: 0.5 });
      for (const n of [NOTE.D3, NOTE.D3 + 1]) k.tone(m.out, t + 0.1, { freq: hz(n), freqEnd: hz(n) * 0.8, dur: 0.7, gain: 0.2, attack: 0.2 });
      m.V('tex.void', t, 1, { at: 0.1, offset: -1, dur: 0.5, attack: 0.2, release: 0.4, rate: 0.8, lpf: 800, send: 0.4 });
      if (own) k.noise(m.out, t + 0.4, { dur: veil, gain: 0.05, filter: 'bandpass', freq: 2600, q: 4, attack: 0.3, hold: veil * 0.5, send: 0.5 });
    },
  };

  /** A keystone without a signature of its own (a new id): its family's two notes, so it is never silent. */
  const fallbackSignature = (id: string): Signature => ({ m, t }) => {
    for (const [i, n] of FAMILY_NOTES[keystoneFamily(id)].entries()) k.tone(m.out, t + i * 0.06, { type: 'triangle', freq: hz(n), dur: 0.3, gain: 0.14, send: 0.4 });
  };

  /** Two notes per family: the allies' pick cue and the fallback signature. */
  const FAMILY_NOTES: Record<KeystoneFamily, [number, number]> = {
    movement: [NOTE.E5, NOTE.A5], primary: [NOTE.D5, NOTE.A5], secondary: [NOTE.D4, NOTE.F4],
    companion: [NOTE.A5, NOTE.Fs6], win: [NOTE.A4, NOTE.D5], class: [NOTE.D5, NOTE.Fs5],
  };

  // ------------------------------------------------------------------ the keystone moment: family tails
  const TAILS: Record<KeystoneFamily, (out: AudioNode, V: Mix['V'], t: number) => void> = {
    // air: a run up the open chord, sweeps crossing left to right
    movement(out, V, t) {
      [NOTE.D5, NOTE.E5, NOTE.A5, NOTE.D6, NOTE.E6, NOTE.A6, NOTE.D6 + 12].forEach((n, i) => {
        k.tone(out, t + i * 0.06, { freq: hz(n), dur: 1.1, gain: 0.05, attack: 0.01, send: 0.7 });
        k.tone(out, t + i * 0.06, { type: 'triangle', freq: hz(n) / 2, dur: 0.3, gain: 0.02 });
      });
      for (const [at, pan] of [[0, -0.7], [0.35, 0.7], [0.7, -0.4]] as const) {
        k.noise(out, t + at, { dur: 0.6, gain: 0.08, filter: 'bandpass', freq: 900, freqEnd: 5200, q: 1.4, attack: 0.3, pan, send: 0.5 });
      }
      V('swing.cloth', t, 0.3, { rate: 1.3, send: 0.4 });
    },
    // steel: struck metal ringing in fifths, stabs under it
    primary(out, V, t) {
      for (const [at, n, rate] of [[0, NOTE.D5, 1], [0.16, NOTE.A5, 1.5], [0.32, NOTE.D6, 2]] as const) {
        V('hit.ring', t, 0.4, { at, rate, send: 0.6, jitter: 0.01 });
        k.tone(out, t + at, { type: 'square', freq: hz(n), dur: 0.9, gain: 0.035, lpf: 4200, lpfEnd: 1500, send: 0.6 });
        k.tone(out, t + at, { freq: hz(n) * 2.76, dur: 0.5, gain: 0.02, send: 0.5 });
      }
      for (const n of [NOTE.D4, NOTE.A4]) k.tone(out, t, { type: 'sawtooth', freq: hz(n), dur: 1.4, gain: 0.04, lpf: 2600, lpfEnd: 700, q: 2, send: 0.5 });
      V('hit.clang', t, 0.25, { at: 0.48, rate: 1.2, send: 0.6 });
    },
    // deep magic: a low bell, a hummed chord with the ninth in it
    secondary(out, V, t) {
      V('bell', t, 0.4, { variant: 2, rate: TUNED.BELL2_D3, jitter: 0, send: 0.9 });
      choir(out, t + 0.05, [NOTE.D4, NOTE.F4, NOTE.A4, NOTE.E5], 1.9, 0.05, false);
      V('arcane', t, 0.25, { variant: 1, rate: 0.75, send: 0.6 });
      [NOTE.A4, NOTE.E5, NOTE.A5].forEach((n, i) => k.tone(out, t + 0.2 + i * 0.14, { freq: hz(n), dur: 1.3, gain: 0.045, attack: 0.03, send: 0.7 }));
    },
    // twinkling: glass notes answering each other left and right
    companion(out, V, t) {
      const notes = [NOTE.A5, NOTE.Fs6, NOTE.D6, NOTE.A6, NOTE.Fs6, NOTE.D6 + 12, NOTE.A6, NOTE.Fs6 + 12];
      notes.forEach((n, i) => {
        const at = i * 0.085 + (i % 2) * 0.02;
        const pan = i % 2 === 0 ? -0.6 : 0.6;
        V('ping', t, 0.12, { at, rate: hz(n) / 1976, variant: 2, jitter: 0, pan, send: 0.7 });
        k.tone(out, t + at, { freq: hz(n), dur: 0.7, gain: 0.04, send: 0.7 });
      });
      for (const n of [NOTE.D4, NOTE.A4, NOTE.Fs5]) k.tone(out, t, { type: 'triangle', freq: hz(n), dur: 1.6, gain: 0.04, attack: 0.05, send: 0.6 });
    },
    // brass: a horn call rising through the fifth to the octave, the war drum once more
    win(out, V, t) {
      brass(out, t, NOTE.D4, 0.2, 0.07);
      brass(out, t + 0.2, NOTE.A4, 0.24, 0.07);
      brass(out, t + 0.44, NOTE.D5, 1.3, 0.075);
      brass(out, t + 0.44, NOTE.Fs4, 1.3, 0.04);
      V('drum.war', t, 0.6, { at: 0.44, variant: 2, rate: 0.9, send: 0.4 });
      k.tone(out, t + 0.44, { freq: 96, freqEnd: 40, dur: 0.5, gain: 0.2 });
    },
    // the full chord: open voices, a horn on the octave, a bell and glass on top
    class(out, V, t) {
      choir(out, t, [NOTE.D4, NOTE.Fs4, NOTE.A4, NOTE.D5], 2, 0.055, true);
      brass(out, t + 0.1, NOTE.D5, 1.5, 0.05);
      brass(out, t + 0.1, NOTE.A4, 1.5, 0.035);
      V('bell', t, 0.3, { at: 0.1, variant: 1, rate: TUNED.BELL1_D4 * 2, jitter: 0, send: 0.8 });
      [NOTE.Fs6, NOTE.A6, NOTE.D6 + 12].forEach((n, i) => {
        V('ping', t, 0.1, { at: 0.5 + i * 0.1, rate: hz(n) / 1976, variant: 2, jitter: 0, send: 0.8 });
        k.tone(out, t + 0.5 + i * 0.1, { freq: hz(n), dur: 0.8, gain: 0.035, send: 0.7 });
      });
    },
  };

  /** Bloodrush's heartbeat: reschedules the pulse for the stack count just reported; it stops by itself when the stacks run out. */
  const rushBeat = (own: boolean, n: number | undefined): void => {
    if (!own) return;
    const t = k.now();
    const pulse = rushPulse(n);
    const stacks = rushStacks(n);
    if (rush.mix && rush.until > t) rush.mix.fade(t, 0.03);
    const m = k.who(true, LV.rush * pulse.level);
    const beat = 60 / pulse.bpm;
    const bright = 1 + (stacks - 1) * 0.11;
    for (let at = beat * 0.5; at < BLOODRUSH.SECONDS; at += beat) {
      const fade = 1 - 0.5 * (at / BLOODRUSH.SECONDS);
      k.tone(m.out, t + at, { freq: 66 * bright, freqEnd: 40, dur: 0.14, gain: 0.34 * fade });
      k.tone(m.out, t + at + Math.min(0.16, beat * 0.3), { freq: 58 * bright, freqEnd: 38, dur: 0.12, gain: 0.2 * fade });
      if (stacks >= 4) k.noise(m.out, t + at, { dur: 0.02, gain: 0.03 * fade * (stacks / BLOODRUSH.MAX), filter: 'bandpass', freq: 1400 * bright, q: 2 });
    }
    m.fade(t + BLOODRUSH.SECONDS - 0.2, 0.08);
    rush.mix = m;
    rush.until = t + BLOODRUSH.SECONDS;
    rush.stacks = stacks;
  };

  const letGo = (out: AudioNode, V: Mix['V'], t: number): void => {
    // the old keystone leaves: two falling notes, a dull thud, glass sliding away
    for (const [i, n] of [NOTE.A5, NOTE.F5].entries()) k.tone(out, t + i * 0.11, { type: 'triangle', freq: hz(n), freqEnd: hz(n - 1), dur: 0.3, gain: 0.1, lpf: 3000, send: 0.5 });
    V('hit.dull', t, 0.5, { at: 0.2, rate: 0.7 });
    V('glass.light', t, 0.25, { reverse: true, rate: 0.8, fit: 0.2 });
    k.tone(out, t + 0.2, { freq: 130, freqEnd: 60, dur: 0.15, gain: 0.16 });
  };

  const api = {
    /**
     * A keystone did its thing (`keystoneProc`, or derived by index.ts). The own hero gets the full signature; allies
     * the same sound quieter, without tail and less often.
     */
    keystoneProc(id: string, own: boolean, o: ProcOpts = {}): void {
      const t = k.now();
      const key = `${own ? 'o' : 'a'}:${id}`;
      if (id === 'momentum_engine' && o.n !== undefined && o.n <= 0) { api.rushEnd(own); return; }
      const gap = (KEYSTONE_SFX.GAP[id] ?? KEYSTONE_SFX.DEFAULT_GAP) * (own ? 1 : KEYSTONE_SFX.ALLY_GAP);
      let delay = 0;
      let arc = 0;
      if (id === 'chain_lightning') {
        // the arcs of one burst arrive in the same tick: each sounds a moment after the one before
        const burst = arcs.get(key);
        if (burst && t - burst.at < KEYSTONE_SFX.ARC_TICK) {
          if (burst.n >= KEYSTONE_SFX.ARCS_MAX || (!own && burst.n >= 2)) return;
          arc = burst.n++;
          delay = arc * KEYSTONE_SFX.ARC_GAP;
        } else if (t - (lastProc.get(key) ?? -Infinity) >= gap) {
          arcs.set(key, { at: t, n: 1 });
        } else return;
      }
      if (arc === 0 && t - (lastProc.get(key) ?? -Infinity) < gap) {
        // the heartbeat still has to follow the stacks even when the accent is swallowed
        if (id === 'momentum_engine' && rushStacks(o.n) !== rush.stacks) rushBeat(own, o.n);
        return;
      }
      const family: Family = CHAINED.has(id) ? 'ksChain' : 'ksProc';
      const stack = k.take(family, t);
      if (stack < 0) return;
      lastProc.set(key, t);
      let n = o.n;
      if (id === 'corpse_bloom') {
        // a chain climbs even when the sim does not count it
        bloom.n = t - bloom.last < KEYSTONE_SFX.CHAIN_WINDOW ? Math.min(KEYSTONE_SFX.CHAIN_MAX, bloom.n + 1) : 1;
        bloom.last = t;
        n = Math.max(bloom.n, Math.min(KEYSTONE_SFX.CHAIN_MAX, o.n ?? 1));
      }
      const level = (SIG_LEVEL[id] ?? 1) * k.duck(stack) * (own ? 1 : LV.ally) * (o.derived ? LV.derived : 1);
      const m = k.who(own, level);
      // a radius scales the sounds that have a size: 3 m is "as designed"
      const size = o.r !== undefined && o.r > 0 ? Math.max(0.8, Math.min(1.4, Math.sqrt(o.r / 3))) : 1;
      if (id === 'chain_lightning') n = arc + 1;
      ((SIGNATURES as Record<string, Signature | undefined>)[id] ?? fallbackSignature(id))({ m, t: t + delay, own, n, size });
      if (id === 'momentum_engine') rushBeat(own, o.n);
    },
    /** Bloodrush ran out (stacks back to 0): the heartbeat stops with a last, slowing beat. */
    rushEnd(own: boolean): void {
      const t = k.now();
      if (!own || rush.until <= t) { rush.stacks = 0; return; }
      rush.mix?.fade(t, 0.04);
      rush.mix = null;
      rush.until = -Infinity;
      rush.stacks = 0;
      const m = k.who(true, LV.rush * 0.6);
      k.tone(m.out, t + 0.05, { freq: 60, freqEnd: 34, dur: 0.3, gain: 0.3 });
      k.noise(m.out, t, { dur: 0.4, gain: 0.05, filter: 'bandpass', freq: 1200, freqEnd: 400, q: 1.4 });
    },
    /** Glass Cannon's price: the hero was struck and it sounds like something cracked. */
    brittleHit(own: boolean): void {
      const t = k.now();
      const stack = k.take('ksCost', t);
      if (stack < 0) return;
      const m = k.who(own, LV.brittle * k.duck(stack) * (own ? 1 : LV.ally));
      k.noise(m.out, t, { dur: 0.012, gain: 0.6, filter: 'highpass', freq: 6000 });
      m.V('glass.heavy', t, 0.8, { rate: 1.4, send: 0.3 });
      m.V('glass.mid', t, 0.5, { at: 0.02, rate: 1.7, send: 0.3 });
      for (const f of [3322, 4978, 6645]) k.tone(m.out, t, { freq: f * k.jitter(0.03), dur: 0.14, gain: 0.06, send: 0.4 });
      if (!own) return;
      for (let i = 0; i < 4; i++) m.V('glass.light', t, 0.4 - i * 0.07, { at: 0.07 + i * rnd(0.04, 0.08), rate: 1.6 + i * 0.25, send: 0.5 });
      k.tone(m.out, t, { freq: 180, freqEnd: 90, dur: 0.1, gain: 0.14 });
    },
    /** Titan Grip's price: the swing itself is slow and heavy — a long, low sweep of air and a groan of iron. */
    titanSwing(own: boolean): void {
      const t = k.now();
      if (t - (lastSwing.get(own) ?? -Infinity) < KEYSTONE_SFX.SWING_GAP) return;
      lastSwing.set(own, t);
      const stack = k.take('ksCost', t);
      if (stack < 0) return;
      const m = k.who(own, LV.titanSwing * k.duck(stack) * (own ? 1 : LV.ally));
      const slow = 1 + (KEYSTONE_BY_ID.get('heavy_hitter')?.params.slow ?? 0.45);
      const dur = 0.34 * slow;
      k.whoosh(m.out, t, 140, 760, 110, dur, 0.34);
      m.V('swing.cloth', t, 0.7, { rate: 0.52, lpf: 3000 });
      k.tone(m.out, t, { type: 'sawtooth', freq: 62, freqEnd: 92, dur: dur * 0.8, gain: 0.16, lpf: 360, attack: dur * 0.3 });
      if (own) m.V('creak', t, 0.14, { rate: 0.5, lpf: 1600, dur: dur, release: 0.1 });
    },
    /**
     * The own hero's primary or secondary went off while holding `held` keystones (1 or 2): the layers that make the
     * base attack itself sound stronger late in a run. One keystone adds weight (sub and body under the attack),
     * the second adds sparkle (glass and air on top of it).
     */
    powerLayer(slot: 'primary' | 'secondary', held: number): void {
      if (held < 1) return;
      const t = k.now();
      const stack = k.take('ksLayer', t);
      if (stack < 0) return;
      const big = slot === 'secondary';
      const weight = k.who(true, LV.weight * k.duck(stack) * (big ? 1.25 : 1));
      k.tone(weight.out, t, { freq: big ? 92 : 104, freqEnd: big ? 36 : 44, dur: big ? 0.26 : 0.17, gain: 0.34 });
      k.noise(weight.out, t, { dur: 0.07, gain: 0.16, filter: 'lowpass', freq: 380 });
      weight.V('hit.sub', t, big ? 0.5 : 0.36, { rate: big ? 0.85 : 1 });
      if (big) weight.V('boom.sub', t, 0.25, { rate: 1.1, dur: 0.3, release: 0.2 });
      if (held < 2) return;
      const sparkle = k.who(true, LV.sparkle * k.duck(stack) * (big ? 1.2 : 1));
      sparkle.V('glass.light', t, 0.35, { rate: 2.2, send: 0.4 });
      for (const f of [3520, 5274]) k.tone(sparkle.out, t + 0.01, { freq: f * k.jitter(0.015), dur: big ? 0.3 : 0.16, gain: 0.07, send: 0.5 });
      k.noise(sparkle.out, t, { dur: 0.03, gain: 0.16, filter: 'highpass', freq: 8000 });
      if (big) {
        sparkle.V('ping', t, 0.1, { at: 0.03, variant: 2, rate: TUNED.PING_TO_D7 / 2, jitter: 0, send: 0.7 });
        k.tone(sparkle.out, t + 0.03, { freq: hz(NOTE.A6), dur: 0.4, gain: 0.03, send: 0.6 });
      }
    },
    /** The orbiting blades' whirr: on while the own hero carries them into a fight. */
    orbitWhirr(on: boolean): void {
      if (on === (whirr !== null)) return;
      if (on) whirr = startWhirr();
      else if (whirr) { endLoop(whirr, KEYSTONE_SFX.LOOP_RELEASE); whirr = null; }
    },
    /**
     * Arc Stream is being channelled by `who` ('own' or an ally's slot): starts the beam or keeps it alive for
     * STREAM_KEEP seconds. It ends by itself when it is no longer fed.
     */
    stream(who: 'own' | number): void {
      const t = k.now();
      const key = String(who);
      const own = who === 'own';
      let loop = streams.get(key);
      // a beam that is already dying is not revived: a new one starts over it
      if (loop && loop.until !== Infinity) { streams.delete(key); loop = undefined; }
      if (!loop) {
        if (streams.size >= KEYSTONE_SFX.MAX_TRACKED) return;
        loop = startStream(own);
        streams.set(key, loop);
        // ignition: the bolt that becomes a beam
        const stack = k.take('cast', t);
        if (stack >= 0) {
          const m = k.who(own, 0.4 * k.duck(stack) * (own ? 1 : LV.ally));
          m.V('zap.up', t, 0.4, { variant: 1, rate: 1.2, dur: 0.16, release: 0.1 });
          k.tone(m.out, t, { type: 'sawtooth', freq: 300, freqEnd: 1500, dur: 0.1, gain: 0.14, lpf: 4000 });
        }
      } else {
        loop.out.gain.cancelScheduledValues(t);
        loop.out.gain.setTargetAtTime(loop.level, t, 0.02);
      }
      // dies away unless fed again; the nodes are stopped by keystoneTick()
      loop.out.gain.setTargetAtTime(0, t + KEYSTONE_SFX.STREAM_KEEP, KEYSTONE_SFX.STREAM_FADE);
      loop.fed = t;
    },
    /** Housekeeping for the loops (called from the audio scheduler): stops streams that are no longer fed. */
    keystoneTick(): void {
      if (streams.size === 0) return;
      const t = k.now();
      for (const [key, loop] of streams) {
        if (loop.until === Infinity && t - loop.fed > KEYSTONE_SFX.STREAM_KEEP + KEYSTONE_SFX.STREAM_FADE * 6) endLoop(loop, KEYSTONE_SFX.STREAM_FADE);
        else if (loop.until <= t) streams.delete(key);
      }
    },
    /**
     * Walking Sanctum: the hallowed ground of zone `id` follows its templar. On top of the zone's bed: a hum a fifth
     * higher that sways at walking pace, and a soft step of light twice a second.
     */
    sanctumWalk(id: number, dur: number, own: boolean): void {
      const t = k.now();
      if (sanctums.size >= KEYSTONE_SFX.MAX_TRACKED) sanctums.clear();
      const length = Math.min(dur, KEYSTONE_SFX.SANCTUM_MAX);
      const m = k.who(own, LV.sanctum * (own ? 1 : LV.ally));
      const hold = Math.max(0.1, length - 0.8);
      for (const [n, detune] of [[NOTE.A3, 0], [NOTE.E4, 5], [NOTE.A4, -4]] as const) {
        k.tone(m.out, t, { type: 'triangle', freq: hz(n), detune, dur: length, gain: 0.07, attack: 0.4, hold, am: 0.5, amHz: 1.8, send: 0.6 });
      }
      k.noise(m.out, t, { dur: length, gain: 0.07, filter: 'bandpass', freq: 520, q: 7, attack: 0.4, hold, send: 0.6 });
      for (let at = 0; at < length - 1.6; at += 1.3) m.V('tex.hum', t, 0.5, { at, offset: -1, dur: 1.2, attack: 0.3, release: 0.4, rate: 1.5, lpf: 1800, free: true });
      if (own) {
        let i = 0;
        for (let at = 0.3; at < length - 0.4; at += 0.55) {
          k.tone(m.out, t + at, { freq: hz(i++ % 2 === 0 ? NOTE.A5 : NOTE.E5), dur: 0.35, gain: 0.03, send: 0.7 });
          k.tone(m.out, t + at, { freq: 110, freqEnd: 70, dur: 0.1, gain: 0.05 });
        }
      }
      m.fade(t + length - 0.3, 0.12);
      sanctums.set(id, { mix: m, until: t + length });
    },
    /** The zone ended before its time (or was replaced): the hum goes with it. */
    sanctumEnd(id: number): void {
      const t = k.now();
      const hum = sanctums.get(id);
      sanctums.delete(id);
      if (hum && hum.until > t) hum.mix.fade(t, 0.09);
    },
    /**
     * A hero took a keystone. For the own hero this is the moment: a short build, an impact and a shimmering tail in
     * the family's timbre; with `replaced` the old keystone is let go first. Allies: two notes of the family.
     */
    keystoneTaken(id: string, own: boolean, replaced = false): void {
      const t = k.now();
      const family = keystoneFamily(id);
      if (!own) {
        const stack = k.take('ksAlly', t);
        if (stack < 0) return;
        const { V, out } = k.bigMix(LV.momentAlly * k.duck(stack));
        let at = t;
        if (replaced) {
          for (const [i, n] of [NOTE.A5, NOTE.F5].entries()) k.tone(out, t + i * 0.09, { type: 'triangle', freq: hz(n), dur: 0.2, gain: 0.06, lpf: 3000 });
          at = t + 0.2;
        }
        V('drum.low', at, 0.4, { rate: 1.2 });
        k.tone(out, at, { freq: 110, freqEnd: 50, dur: 0.16, gain: 0.14 });
        for (const [i, n] of FAMILY_NOTES[family].entries()) {
          k.tone(out, at + 0.03 + i * 0.09, { type: 'triangle', freq: hz(n), dur: 0.45, gain: 0.09, send: 0.5 });
          k.tone(out, at + 0.03 + i * 0.09, { freq: hz(n) * 2, dur: 0.2, gain: 0.025, send: 0.5 });
        }
        return;
      }
      if (k.take('keystone', t) < 0) return;
      const { V, out } = k.bigMix(LV.moment);
      let start = t;
      if (replaced) {
        const old = k.bigMix(LV.replaced);
        letGo(old.out, old.V, t);
        start = t + KEYSTONE_SFX.LET_GO;
      }
      const build = KEYSTONE_SFX.BUILD;
      // build: the room draws breath
      V('shimmer', start, 0.3, { reverse: true, fit: build, send: 0.6 });
      V('zap.rise', start, 0.3, { fit: build, lpf: 5000, send: 0.4 });
      k.noise(out, start, { dur: build, gain: 0.2, filter: 'bandpass', freq: 300, freqEnd: 6000, q: 1.2, attack: build * 0.9, send: 0.4 });
      for (const detune of [-8, 7]) k.tone(out, start, { type: 'sawtooth', freq: hz(NOTE.D3), freqEnd: hz(NOTE.D4), detune, dur: build, gain: 0.1, lpf: 400, lpfEnd: 3200, q: 2, attack: build * 0.85 });
      V('drum.low', start, 0.4, { at: build - 0.22, rate: 1.1 });
      V('drum.low', start, 0.5, { at: build - 0.11, rate: 1.1 });
      // impact: the keystone is set
      const hit = start + build;
      V('drum.war', hit, 0.9, { variant: 1, send: 0.4 });
      V('boom.sub', hit, 0.6);
      V('hit.plate', hit, 0.3, { rate: 0.7, send: 0.3 });
      V('bell', hit, 0.4, { variant: 1, rate: TUNED.BELL1_D4, jitter: 0, send: 0.8 });
      k.tone(out, hit, { freq: 110, freqEnd: 36, dur: 0.9, gain: 0.36 });
      k.noise(out, hit, { dur: 0.016, gain: 0.5, filter: 'highpass', freq: 3000 });
      [NOTE.D3, NOTE.A3, NOTE.D4, NOTE.Fs4, NOTE.A4].forEach((n, i) => {
        k.tone(out, hit + i * 0.012, { type: 'triangle', freq: hz(n), dur: 1.8, gain: 0.055, attack: 0.01, send: 0.6 });
      });
      // tail: light on the stone, and the family's own voice
      const tail = KEYSTONE_SFX.TAIL;
      V('shimmer', hit, 0.22, { at: 0.04, rate: 0.75, attack: 0.05, send: 0.8, jitter: 0 });
      k.noise(out, hit + 0.05, { dur: tail, gain: 0.05, filter: 'bandpass', freq: 6200, q: 3, attack: 0.2, hold: tail * 0.3, send: 0.6 });
      for (const [n, amHz] of [[NOTE.A6, 7], [NOTE.D6 + 12, 9.5]] as const) {
        k.tone(out, hit + 0.05, { freq: hz(n), dur: tail, gain: 0.022, attack: 0.15, hold: tail * 0.3, am: 0.9, amHz, send: 0.7 });
      }
      TAILS[family](out, V, hit + 0.06);
      k.g.duckMusic(0.35, (replaced ? KEYSTONE_SFX.LET_GO : 0) + build + 1.2, 1.2);
    },
    /**
     * The own keystone draft opened: a question, not an answer — a low bell, a suspended chord that swells and does not
     * resolve, one high note left hanging. `full` (both slots taken, a pick means giving one up): two notes weigh
     * against each other underneath.
     */
    keystoneDraftOpen(full = false): void {
      const t = k.now();
      if (k.take('ksDraft', t) < 0) return;
      const { V, out } = k.bigMix(LV.draftOpen);
      V('bell', t, 0.45, { variant: 2, rate: TUNED.BELL2_D3, jitter: 0, send: 0.9 });
      V('question', t, 0.5, { at: 0.12, variant: 1, rate: 0.75, jitter: 0, send: 0.5 });
      k.tone(out, t, { freq: hz(NOTE.D2), dur: 1.8, gain: 0.14, attack: 0.03, hold: 0.6 });
      // D sus4 with the ninth on top: open, waiting
      [NOTE.D4, NOTE.G4, NOTE.A4, NOTE.E5].forEach((n, i) => {
        k.tone(out, t + 0.1 + i * 0.05, { type: 'triangle', freq: hz(n), dur: 1.9, gain: 0.07, attack: 0.5, hold: 0.5, vib: 5, vibHz: 4, send: 0.7 });
        k.tone(out, t + 0.1 + i * 0.05, { type: 'sawtooth', freq: hz(n), dur: 1.6, gain: 0.02, lpf: 500, lpfEnd: 2000, attack: 0.6, send: 0.5 });
      });
      k.tone(out, t + 0.75, { freq: hz(NOTE.E6), dur: 1.3, gain: 0.05, attack: 0.02, send: 0.8 });
      V('ping', t, 0.12, { at: 0.75, variant: 2, rate: (TUNED.PING_TO_D7 / 2) * Math.pow(2, 2 / 12), jitter: 0, send: 0.8 });
      k.noise(out, t + 0.1, { dur: 1.4, gain: 0.04, filter: 'bandpass', freq: 5200, q: 3, attack: 0.7, send: 0.6 });
      if (full) {
        for (const [i, n] of [NOTE.A3, NOTE.Bb3, NOTE.A3].entries()) k.tone(out, t + 0.5 + i * 0.26, { type: 'triangle', freq: hz(n), dur: 0.4, gain: 0.09, lpf: 1600, send: 0.5 });
        V('question', t, 0.3, { at: 0.62, variant: 2, rate: 0.6, jitter: 0, send: 0.5 });
      }
      k.g.duckMusic(0.5, 1, 1);
    },
    /**
     * The picked boon fits the build (`BoonOffer.fits`): on top of the draft-pick sound, a warm fifth locking in and a
     * glint — a little more for each shared tag (up to three).
     */
    fitsPick(tags = 1): void {
      const t = k.now();
      const n = Math.max(1, Math.min(3, tags));
      const { V, out } = k.uiMix(LV.fits * (0.85 + 0.15 * n));
      V('pluck', t, 0.5, { at: 0.05, variant: 1, jitter: 0 });
      for (const [i, midi] of [NOTE.D4, NOTE.A4, NOTE.Fs5].slice(0, n + 1).entries()) {
        k.tone(out, t + 0.06 + i * 0.045, { type: 'triangle', freq: hz(midi), dur: 0.55, gain: 0.08, lpf: 3600 });
      }
      k.tone(out, t + 0.2, { freq: hz(NOTE.A6), dur: 0.4, gain: 0.03 });
      V('ping', t, 0.1, { at: 0.2, variant: 2, rate: TUNED.PING_TO_D7 / 2, jitter: 0 });
      V('foley.latch', t, 0.25, { at: 0.03, variant: 2, rate: 1.2 });
    },
    /** The session ended or the hero left the fight: every keystone loop and scheduled bed stops. */
    keystoneReset(): void {
      const t = k.now();
      api.orbitWhirr(false);
      for (const loop of streams.values()) if (loop.until === Infinity) endLoop(loop, KEYSTONE_SFX.STREAM_FADE);
      streams.clear();
      for (const hum of sanctums.values()) if (hum.until > t) hum.mix.fade(t, 0.09);
      sanctums.clear();
      if (rush.mix && rush.until > t) rush.mix.fade(t, 0.05);
      rush.mix = null;
      rush.until = -Infinity;
      rush.stacks = 0;
      lastProc.clear();
      arcs.clear();
      lastSwing.clear();
      bloom.n = 0;
    },
    /** Keystone loops and beds sounding now (whirr, streams, sanctum hums, the Bloodrush pulse): for the leak check. */
    keystoneLoops(): number {
      const t = k.now();
      let live = whirr ? 1 : 0;
      for (const loop of streams.values()) if (loop.until === Infinity && t - loop.fed <= KEYSTONE_SFX.STREAM_KEEP) live++;
      for (const hum of sanctums.values()) if (hum.until > t) live++;
      if (rush.until > t) live++;
      return live;
    },
  };

  return { api };
}
