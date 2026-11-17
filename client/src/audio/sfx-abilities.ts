/**
 * Update 3 hero sounds: the three new classes, every art and every ultimate, the lasting effects they leave
 * (zone beds, traps), buff cues, the shade's marks and the "ultimate ready" cue.
 *
 * `ABILITY_SOUNDS` maps EVERY ability id of data/classes.ts to a sound; `unmappedAbilities()` lists ids that
 * have none (the workbench and the checks print it). Each stack carries enough synthesis to work before its
 * samples are decoded; the samples add body and grain.
 *
 * Ultimates are the loudest authored hero moments: a build over the ability's wind-up, a release when it lands,
 * and a slight duck of the score.
 */
import { ABILITY_BY_ID, CLASSES, type AbilityDef } from '@shared/data/classes.ts';
import type { ClassId, ElementId } from '@shared/types.ts';
import { midiToHz } from './engine.ts';
import { VOICES } from './samples.ts';
import { NOTE, rnd, TUNED, type Layer, type Mix, type SfxKit } from './sfx-kit.ts';

export const LEGACY_CLASSES = ['knight', 'barbarian', 'mage', 'rogue'] as const;
export type LegacyClass = (typeof LEGACY_CLASSES)[number];
export const isLegacyClass = (cls: ClassId): cls is LegacyClass => (LEGACY_CLASSES as readonly string[]).includes(cls);

/** Mix levels of this module (1 = as designed), tuned against offline renders like LEVEL in sfx.ts. */
const LV = {
  templar: 0.62, templarFinisher: 0.68, consecrate: 0.8,
  spellblade: 1.5, wave: 0.9, blink: 0.9,
  shade: 1.7, shadeFinisher: 1.5, step: 0.9,
  art: 0.95, leap: 0.78,
  ult: 0.95, volley: 1.5,
  generic: 0.8,
  zoneStart: 0.7, bed: 0.55, bedAlly: 0.3, bedHallowed: 0.45, bedGrand: 0.55, bedSmoke: 0.55, bedPatter: 1, trapArm: 1.2, trapSnap: 1, zoneFade: 0.5,
  buff: 0.95, buffBulwark: 0.5, buffRage: 0.8, buffEcho: 0.5, BUFF_ECHO_S: 0.3, mark: 0.7, ready: 0.8, readyAlly: 0.35,
} as const;

const ZONES = {
  /** Beds sounding at once; further zones only get their start cue. */
  MAX_BEDS: 4,
  /** Longest bed (the mix node is recycled after TUNE.MIX_TTL in sfx.ts; boons may stretch a zone beyond it). */
  MAX_SECONDS: 10,
  FADE_IN: 0.35,
  FADE_OUT: 0.5,
  /** Time constant of the fade when a zone is ended early. */
  END_TC: 0.09,
  MAX_TRACKED: 32,
  /** Bolt-storm patter: seconds between impacts. */
  PATTER_GAP: [0.055, 0.11],
} as const;

/** How the blow of an ability is sounded (documentation for the map; the check prints it). */
type Impact = 'weapon layer on hit' | 'landing in the cast stack' | 'zone bed + pulses' | 'buff cue' | 'trap arm + snap' | 'release in the cast stack';

interface Ctx {
  k: SfxKit;
  t: number;
  own: boolean;
  /** Level after stack ducking. */
  level: number;
  def: AbilityDef;
}

interface AbilitySound {
  impact: Impact;
  /** One of the four first classes: sounded by the stacks in sfx.ts. */
  legacy?: { cls: LegacyClass; slot: 'primary' | 'secondary'; step: number };
  ult?: boolean;
  play?: (c: Ctx) => void;
}

const legacy = (cls: LegacyClass, slot: 'primary' | 'secondary', step: number, impact: Impact): AbilitySound => ({ impact, legacy: { cls, slot, step } });

// ------------------------------------------------------------------ templar: heavy two-handed steel

const templarSwing = (second: boolean) => ({ k, t, own, level, def }: Ctx): void => {
  // a long, low pass of a two-handed blade: it drags the air, and the weight arrives at the end of the wind-up
  const { V, out } = k.who(own, LV.templar * level);
  V('swing.cloth', t, 0.75, { rate: second ? 0.52 : 0.46 });
  V('swing.blade', t, 0.38, { at: 0.04, rate: second ? 0.54 : 0.48, lpf: 3200 });
  V('swing.draw', t, 0.2, { rate: 0.42, lpf: 2600 });
  k.whoosh(out, t + 0.03, 170, second ? 1250 : 1050, 150, 0.42, 0.22);
  k.thump(out, t + def.windup, 84, 0.24, 0.18);
  V('hit.iron', t, 0.14, { at: def.windup, rate: 0.8, lpf: 900 });
};

const templarFinisher = ({ k, t, own, level, def }: Ctx): void => {
  // the overhead blow: a long drag up, then the whole weight comes down and rings
  const { V, out } = k.who(own, LV.templarFinisher * level);
  V('swing.draw', t, 0.4, { rate: 0.38 });
  V('swing.cloth', t, 0.85, { at: 0.05, rate: 0.4 });
  V('swing.blade', t, 0.45, { at: 0.1, rate: 0.42, lpf: 3000 });
  k.whoosh(out, t + 0.05, 130, 900, 110, 0.56, 0.26);
  V('hit.iron', t, 0.34, { at: def.windup, rate: 0.7 });
  V('earth', t, 0.22, { at: def.windup, rate: 0.8, lpf: 1400, dur: 0.3, release: 0.15 });
  V('hit.ring', t, 0.09, { at: def.windup + 0.02, rate: 0.42, send: 0.6 });
  k.thump(out, t + def.windup, 70, 0.36, 0.26);
};

const consecrate = ({ k, t, own, level, def }: Ctx): void => {
  // the sword is planted: iron on stone, a small bell, warm fifths rising out of the ground
  const { V, out } = k.who(own, LV.consecrate * level);
  V('swing.cloth', t, 0.4, { rate: 0.7 });
  const land = t + def.windup;
  V('hit.iron', land, 0.5, { rate: 0.85 });
  V('earth', land, 0.2, { rate: 1, lpf: 1600, dur: 0.25, release: 0.15 });
  V('bell', land, 0.14, { variant: 3, rate: 0.9, send: 0.8 });
  k.thump(out, land, 90, 0.3, 0.2);
  [NOTE.D3, NOTE.A3, NOTE.D4, NOTE.A4].forEach((n, i) => {
    k.tone(out, land + i * 0.06, { type: 'triangle', freq: midiToHz(n), dur: 1.1, gain: 0.06, attack: 0.05, lpf: 2400, send: 0.6 });
  });
  k.noise(out, land, { dur: 0.7, gain: 0.05, filter: 'bandpass', freq: 780, q: 6, attack: 0.2, send: 0.6 });
};

// ------------------------------------------------------------------ spellblade: bright blade + arcane shimmer

const spellCut = (second: boolean) => ({ k, t, own, level }: Ctx): void => {
  const { V, out } = k.who(own, LV.spellblade * level);
  const up = second ? 1.12 : 1;
  V('swing.blade', t, 0.4, { rate: 1.28 * up, hpf: 900 });
  V('swing.cloth', t, 0.16, { rate: 1.5, lpf: 3000 });
  k.whoosh(out, t, 1100, 4600 * up, 900, 0.13, 0.1);
  // the shimmer: a glassy glint that follows the edge
  V('ping', t, 0.12, { at: 0.03, rate: (second ? 1.5 : 1.19) * 1.0, send: 0.5, jitter: 0.01 });
  k.tone(out, t + 0.02, { freq: midiToHz(second ? NOTE.A6 : NOTE.D6) * 2, freqEnd: midiToHz(second ? NOTE.D6 : NOTE.A5) * 2, dur: 0.16, gain: 0.05, send: 0.5 });
  k.noise(out, t + 0.02, { dur: 0.09, gain: 0.05, filter: 'highpass', freq: 7000 });
};

const spellWave = ({ k, t, own, level, def }: Ctx): void => {
  // the third cut leaves the sword: a slice, then a singing crescent of force flying off
  const { V, out } = k.who(own, LV.wave * level);
  V('swing.blade', t, 0.45, { rate: 1.05, hpf: 700 });
  V('swing.draw', t, 0.3, { rate: 1.25 });
  const go = t + def.windup;
  V('laser.small', go, 0.3, { rate: 0.85, lpf: 4200, send: 0.4 });
  V('arcane', go, 0.22, { variant: 2, rate: 1.1, lpf: 5000, send: 0.5 });
  V('shimmer', go, 0.1, { rate: 1.1, attack: 0.02, send: 0.6, jitter: 0.01 });
  k.whoosh(out, go, 700, 5200, 1500, 0.3, 0.16);
  for (const [n, detune] of [[NOTE.D5, -7], [NOTE.A5, 6]] as const) {
    k.tone(out, go, { type: 'triangle', freq: midiToHz(n), freqEnd: midiToHz(n + 2), detune, dur: 0.4, gain: 0.07, attack: 0.01, send: 0.5 });
  }
  k.tone(out, go, { type: 'sawtooth', freq: 620, freqEnd: 1900, dur: 0.22, gain: 0.05, lpf: 3800, send: 0.3 });
};

const spellBlink = ({ k, t, own, level }: Ctx): void => {
  // gone and back: the air snaps shut where the hero stood and opens where the blade arrives
  const { V, out } = k.who(own, LV.blink * level);
  V('zap.jump', t, 0.35, { rate: 1.45, send: 0.4 });
  V('ping', t, 0.16, { reverse: true, fit: 0.12, send: 0.4 });
  k.whoosh(out, t, 900, 6000, 1400, 0.16, 0.14);
  k.tone(out, t, { freq: 440, freqEnd: 1760, dur: 0.12, gain: 0.07, send: 0.4 });
  const land = 0.13;
  V('swing.blade', t, 0.45, { at: land, rate: 1.3, hpf: 900 });
  V('ping', t, 0.18, { at: land, variant: 2, rate: TUNED.PING_TO_D7 / 2, send: 0.6, jitter: 0 });
  k.tone(out, t + land, { freq: midiToHz(NOTE.D6), dur: 0.3, gain: 0.05, send: 0.6 });
  k.thump(out, t + land, 150, 0.12, 0.1);
};

// ------------------------------------------------------------------ shade: quick, light dagger flicks

const flick = (V: Layer, k: SfxKit, out: AudioNode, t: number, rate: number, gain: number): void => {
  V('swing.blade', t, gain * 2, { rate: 1.75 * rate, dur: 0.07, release: 0.03, hpf: 2200 });
  k.noise(out, t, { dur: 0.07, gain: gain * 0.5, filter: 'bandpass', freq: 2600 * rate, freqEnd: 6200 * rate, q: 2.4, attack: 0.012 });
  // the wrist behind the blade: a tiny, dry knock
  k.tone(out, t, { type: 'triangle', freq: 520 * rate, freqEnd: 260, dur: 0.035, gain: gain * 0.25 });
};

const shadeStab = (second: boolean) => ({ k, t, own, level }: Ctx): void => {
  const { V, out } = k.who(own, LV.shade * level);
  flick(V, k, out, t, second ? 1.14 : 1, 0.34);
  V('swing.cloth', t, 0.1, { rate: 1.9, lpf: 2400, dur: 0.06 });
};

const shadeFinisher = ({ k, t, own, level }: Ctx): void => {
  // both daggers, a hair apart, and the hiss of steel being turned in the hand
  const { V, out } = k.who(own, LV.shadeFinisher * level);
  flick(V, k, out, t, 0.95, 0.36);
  flick(V, k, out, t + 0.05, 1.25, 0.36);
  V('swing.draw', t, 0.22, { at: 0.02, rate: 1.7, hpf: 1200 });
  k.tone(out, t + 0.05, { freq: 3100, freqEnd: 4200, dur: 0.07, gain: 0.02 });
};

const shadeStep = ({ k, t, own, level }: Ctx): void => {
  // a step through shadow: breath instead of wind, then one certain cut
  const { V, out } = k.who(own, LV.step * level);
  V('swing.cloth', t, 0.4, { rate: 1.4, lpf: 2000 });
  V('tex.void', t, 1, { offset: -1, dur: 0.14, attack: 0.03, release: 0.12, rate: 1.3, lpf: 900 });
  k.noise(out, t, { dur: 0.22, gain: 0.2, filter: 'bandpass', freq: 240, freqEnd: 900, q: 1.1, attack: 0.05 });
  k.tone(out, t, { freq: 110, freqEnd: 62, dur: 0.2, gain: 0.14 });
  const cut = 0.14;
  flick(V, k, out, t + cut, 1.1, 0.42);
  V('hit.ring', t, 0.1, { at: cut, rate: 1.5, send: 0.4 });
  k.tone(out, t + cut, { type: 'square', freq: 1568, freqEnd: 2093, dur: 0.07, gain: 0.03, lpf: 5000 });
};

// ------------------------------------------------------------------ arts

const knightToss = ({ k, t, own, level, def }: Ctx): void => {
  // the shield leaves the arm and spins away humming
  const { V, out } = k.who(own, LV.art * level);
  V('swing.cloth', t, 0.6, { rate: 0.85 });
  const go = t + def.windup;
  V('hit.plate', go, 0.3, { rate: 1.2, dur: 0.12 });
  V('hit.ring', go, 0.2, { rate: 0.6, send: 0.5 });
  k.whoosh(out, go, 400, 2200, 500, 0.36, 0.18);
  // the spin: a metallic hum chopped by the rotation, fading with distance
  k.tone(out, go, { type: 'triangle', freq: 392, freqEnd: 330, dur: 0.55, gain: 0.1, am: 0.9, amHz: 19, send: 0.4 });
  k.tone(out, go, { freq: 1176, freqEnd: 990, dur: 0.4, gain: 0.03, am: 0.9, amHz: 19, send: 0.4 });
};

const leap = (holy: boolean) => ({ k, t, own, level, def }: Ctx): void => {
  // take-off, a moment of air, and a landing that owns the floor
  const { V, out } = k.who(own, LV.leap * level);
  const air = def.windup;
  V('swing.cloth', t, 0.7, { rate: holy ? 0.7 : 0.55 });
  k.whoosh(out, t, 180, holy ? 1700 : 1300, 320, air, 0.2);
  k.tone(out, t, { type: 'sawtooth', freq: holy ? 147 : 62, freqEnd: holy ? 220 : 124, dur: air, gain: holy ? 0.05 : 0.1, lpf: holy ? 1400 : 500, attack: air * 0.4, am: holy ? 0 : 0.5, amHz: 26, send: 0.3 });
  const land = t + air;
  V('earth', land, 0.7, { rate: holy ? 0.9 : 0.7, send: 0.4 });
  V('hit.iron', land, 0.6, { rate: holy ? 0.85 : 0.65 });
  V('hit.sub', land, 0.6);
  k.tone(out, land, { freq: holy ? 96 : 84, freqEnd: 34, dur: 0.5, gain: 0.34 });
  k.noise(out, land, { dur: 0.3, gain: 0.16, filter: 'lowpass', freq: 2400, freqEnd: 200, send: 0.3 });
  if (holy) {
    // judgement: the blow rings like a struck bell
    V('bell', land, 0.4, { variant: 2, rate: TUNED.BELL2_D3 * 2, jitter: 0, send: 0.8 });
    for (const n of [NOTE.D4, NOTE.A4, NOTE.D5]) k.tone(out, land, { type: 'triangle', freq: midiToHz(n), dur: 0.9, gain: 0.05, send: 0.6 });
    k.noise(out, land, { dur: 0.25, gain: 0.06, filter: 'highpass', freq: 5000, send: 0.4 });
  } else {
    // skullsplitter: wood and bone give way
    V('swing.chop', land, 0.6, { rate: 0.7 });
    k.clatter(V, land + 0.05, 4, 0.25, 0.25);
  }
};

const mageLance = ({ k, t, own, level, def }: Ctx): void => {
  // a short gathering, then a line of light: hard edge, bright body, a tail that sings in the room
  const { V, out } = k.who(own, LV.art * level);
  const wind = def.windup;
  V('field', t, 0.4, { rate: 1.5, dur: wind, release: 0.05, lpf: 3200 });
  k.tone(out, t, { type: 'triangle', freq: 330, freqEnd: 1320, dur: wind, gain: 0.08, attack: wind * 0.7, send: 0.3 });
  k.noise(out, t, { dur: wind, gain: 0.05, filter: 'bandpass', freq: 1500, freqEnd: 6500, q: 3, attack: wind * 0.8 });
  const go = t + wind;
  V('laser.large', go, 0.7, { rate: 1.15, send: 0.5 });
  V('zap.long', go, 0.35, { rate: 1.3, lpf: 7000, send: 0.5 });
  V('glass.light', go, 0.2, { rate: 1.6, send: 0.5 });
  for (const detune of [-12, 11]) {
    k.tone(out, go, { type: 'sawtooth', freq: midiToHz(NOTE.D5), freqEnd: midiToHz(NOTE.A4), detune, dur: 0.4, gain: 0.08, lpf: 6000, lpfEnd: 1200, hold: 0.12, send: 0.5 });
  }
  k.tone(out, go, { freq: 2349, freqEnd: 1760, dur: 0.5, gain: 0.04, send: 0.7 });
  k.thump(out, go, 130, 0.2, 0.18);
};

const rogueTrap = ({ k, t, own, level, def }: Ctx): void => {
  // tossed onto the floor and wound up: thud, ratchet, ratchet, ratchet (the 'zone' event adds the arming click)
  const { V, out } = k.who(own, LV.art * level);
  V('swing.cloth', t, 0.4, { rate: 1.2 });
  V('pot', t, 0.3, { at: 0.2, rate: 1.3, dur: 0.15 });
  V('hit.thud', t, 0.3, { at: 0.2, rate: 1.1 });
  const steps = 4;
  for (let i = 0; i < steps; i++) {
    const at = 0.26 + (i / steps) * Math.max(0.2, def.windup - 0.3);
    V('foley.latch', t, 0.3, { at, variant: 2, rate: 1.1 + i * 0.12, jitter: 0.01 });
    k.tone(out, t + at, { type: 'square', freq: 700 + i * 130, dur: 0.02, gain: 0.03, lpf: 3000 });
  }
};

const spellWard = ({ k, t, own, level, def }: Ctx): void => {
  // runes circling: a shield going up, then one glassy pass per damage tick while the ward turns
  const { V, out } = k.who(own, LV.art * level);
  V('field', t, 0.5, { rate: 1.2, lpf: 3600, send: 0.4 });
  V('arcane', t, 0.2, { variant: 1, rate: 1, lpf: 4500, send: 0.5 });
  const period = Math.max(0.15, def.tick);
  const turns = Math.max(1, Math.round(def.duration / period));
  const scale = [NOTE.D5, NOTE.F5, NOTE.A5, NOTE.E5];
  for (let i = 0; i < turns; i++) {
    const at = i * period;
    V('ping', t, 0.1, { at, rate: 0.8 + (i % 4) * 0.12, send: 0.6, free: true });
    k.whoosh(out, t + at, 1400, 4200, 1800, period * 0.9, 0.05);
    k.tone(out, t + at, { freq: midiToHz(scale[i % scale.length]) * 2, dur: 0.22, gain: 0.03, send: 0.6 });
  }
  k.tone(out, t, { type: 'triangle', freq: midiToHz(NOTE.D4), dur: def.duration, gain: 0.04, attack: 0.15, hold: def.duration * 0.7, am: 0.5, amHz: 1 / period, send: 0.5 });
  k.noise(out, t, { dur: def.duration, gain: 0.03, filter: 'bandpass', freq: 3200, q: 4, attack: 0.2, hold: def.duration * 0.7 });
};

const shadeSmoke = ({ k, t, own, level, def }: Ctx): void => {
  // a small bomb: flint, pop, and the first rush of smoke (the 'zone' event keeps it hissing)
  const { V, out } = k.who(own, LV.art * level);
  V('foley.latch', t, 0.3, { variant: 2, rate: 1.4 });
  const pop = t + def.windup;
  V('hit.tight', pop, 0.6, { rate: 1.2 });
  V('glass.light', pop, 0.25, { rate: 0.8, lpf: 3000 });
  k.thump(out, pop, 120, 0.16, 0.2);
  k.noise(out, pop, { dur: 0.7, gain: 0.3, filter: 'bandpass', freq: 5200, freqEnd: 1800, q: 0.7, attack: 0.02, send: 0.3 });
  k.noise(out, pop, { dur: 0.5, gain: 0.14, filter: 'lowpass', freq: 900, freqEnd: 200 });
};

// ------------------------------------------------------------------ ultimates: build over the wind-up, then release

/** The shared frame of every ultimate: the hero's mix at ultimate level, and a slight duck of the score. */
const ultimate = (c: Ctx): Mix & { land: number } => {
  const { k, t, own, level, def } = c;
  const m = k.who(own, LV.ult * level);
  k.g.duckMusic(own ? 0.55 : 0.75, def.windup + 0.6, 0.9);
  // every build starts with the same intake of air, so "an ultimate is coming" reads before the class does
  m.V('boom', t, 0.22, { variant: 1, reverse: true, fit: Math.max(0.2, def.windup) });
  return { ...m, land: t + def.windup };
};

const knightBulwark = (c: Ctx): void => {
  // Banner of the Last Bell: the standard is driven into the stone and the bell answers
  const { k, t, def } = c;
  const { V, out, land } = ultimate(c);
  V('bell', t, 0.3, { variant: 1, reverse: true, fit: def.windup, send: 0.5 });
  V('swing.cloth', t, 0.7, { rate: 0.6 });
  k.whoosh(out, t, 200, 1200, 300, def.windup, 0.16);
  V('hit.plate', land, 0.8, { rate: 0.8, send: 0.4 });
  V('hit.iron', land, 0.7, { rate: 0.75 });
  V('earth', land, 0.6, { rate: 0.8, send: 0.4 });
  V('boom.sub', land, 0.7);
  V('bell', land, 0.8, { variant: 2, rate: TUNED.BELL2_D3, jitter: 0, send: 0.9 });
  k.tone(out, land, { freq: 100, freqEnd: 34, dur: 0.9, gain: 0.4 });
  for (const n of [NOTE.D3, NOTE.A3, NOTE.D4]) k.tone(out, land, { type: 'triangle', freq: midiToHz(n), dur: 1.6, gain: 0.07, attack: 0.02, send: 0.7 });
  k.noise(out, land, { dur: 0.5, gain: 0.14, filter: 'lowpass', freq: 3000, freqEnd: 200, send: 0.4 });
};

const barbRage = (c: Ctx): void => {
  // Bloodrage: a breath dragged in, then the drums and the body let go (the 'buff' event carries the roar itself)
  const { k, t, def } = c;
  const { V, out, land } = ultimate(c);
  k.noise(out, t, { dur: def.windup, gain: 0.2, filter: 'bandpass', freq: 400, freqEnd: 1900, q: 1.2, attack: def.windup * 0.8 });
  k.tone(out, t, { type: 'sawtooth', freq: 55, freqEnd: 98, dur: def.windup, gain: 0.14, lpf: 400, attack: def.windup * 0.7, am: 0.6, amHz: 24 });
  V('drum.war', land, 1, { variant: 1, rate: 0.9, send: 0.4 });
  V('drum.war', land, 0.8, { at: 0.16, variant: 2, rate: 0.8, send: 0.4 });
  V('boom', land, 0.6, { variant: 3, rate: 0.85, send: 0.4 });
  V('boom.sub', land, 0.8);
  V('swing.chop', land, 0.5, { rate: 0.6 });
  k.tone(out, land, { freq: 110, freqEnd: 36, dur: 0.8, gain: 0.42 });
  k.noise(out, land, { dur: 0.45, gain: 0.2, filter: 'lowpass', freq: 2600, freqEnd: 180, send: 0.4 });
};

const mageMeteor = (c: Ctx): void => {
  // Starfall: a long gathering while something falls from very high, then the floor takes it
  const { k, t, def } = c;
  const { V, out, land } = ultimate(c);
  const wind = def.windup;
  V('field', t, 0.6, { rate: 0.9, dur: wind, release: 0.1, lpf: 2600, send: 0.4 });
  V('arcane', t, 0.3, { variant: 1, rate: 0.7, send: 0.5 });
  // the star: a whistle falling four octaves, growing as it comes
  k.tone(out, t, { type: 'triangle', freq: 3520, freqEnd: 220, dur: wind, gain: 0.14, attack: wind * 0.85, send: 0.5 });
  k.tone(out, t, { type: 'sawtooth', freq: 2640, freqEnd: 165, dur: wind, gain: 0.07, lpf: 5000, attack: wind * 0.9, send: 0.4 });
  k.noise(out, t, { dur: wind, gain: 0.16, filter: 'bandpass', freq: 5000, freqEnd: 500, q: 1.5, attack: wind * 0.9, send: 0.3 });
  k.tone(out, t, { type: 'sawtooth', freq: 55, freqEnd: 82, dur: wind, gain: 0.1, lpf: 300, attack: wind * 0.6, am: 0.4, amHz: 17 });
  V('boom', land, 1.1, { variant: 3, rate: 0.8, send: 0.5 });
  V('boom', land, 0.7, { variant: 2, at: 0.05, send: 0.5 });
  V('boom.sub', land, 1.1, { rate: 0.85 });
  V('earth', land, 0.8, { rate: 0.65, send: 0.5 });
  V('glass.heavy', land, 0.35, { rate: 0.8, send: 0.5 });
  V('tex.fire', land, 2, { offset: -1, dur: 0.5, attack: 0.02, release: 0.5, lpf: 6000, lpfEnd: 600, send: 0.4 });
  k.tone(out, land, { freq: 130, freqEnd: 28, dur: 1.3, gain: 0.5 });
  k.noise(out, land, { dur: 1, gain: 0.26, filter: 'lowpass', freq: 5000, freqEnd: 120, send: 0.5 });
  k.clatter(V, land + 0.15, 8, 0.8, 0.3);
};

const rogueVolley = (c: Ctx): void => {
  // Bolt Storm: the repeater is cranked, then a whole quiver goes up at once (the zone brings the rain down)
  const { k, t, def } = c;
  const { V, out, land } = ultimate({ ...c, level: c.level * LV.volley });
  for (let i = 0; i < 4; i++) {
    const at = (i / 4) * def.windup;
    V('foley.latch', t, 0.5, { at, variant: 1 + (i % 2), rate: 1 + i * 0.14, jitter: 0.01 });
  }
  k.tone(out, t, { type: 'triangle', freq: 180, freqEnd: 520, dur: def.windup, gain: 0.12, attack: def.windup * 0.5 });
  const bolts = 9;
  for (let i = 0; i < bolts; i++) {
    const at = i * 0.028;
    V('hit.bone', land, 0.4, { at, rate: 1.4 + i * 0.05 });
    V('swing.blade', land, 0.2, { at, rate: 1.5 + i * 0.07, dur: 0.1, hpf: 2200 });
    k.tone(out, land + at, { type: 'triangle', freq: 300 + i * 22, freqEnd: 140, dur: 0.1, gain: 0.12 });
  }
  V('hit.thud', land, 0.6, { rate: 1.1 });
  V('drum.low', land, 0.6, { rate: 0.9 });
  V('boom', land, 0.5, { variant: 1, rate: 1.3, send: 0.4 });
  k.whoosh(out, land, 900, 5200, 2400, 0.6, 0.34);
  k.noise(out, land + 0.2, { dur: 0.6, gain: 0.08, filter: 'bandpass', freq: 3600, freqEnd: 5200, q: 3, attack: 0.2, send: 0.4 });
  k.thump(out, land, 110, 0.3, 0.3);
};

const templarSanctuary = (c: Ctx): void => {
  // Sanctuary: voices gather, the sword comes down and a major chord opens over the whole floor
  const { k, t, def } = c;
  const { V, out, land } = ultimate(c);
  V('bell', t, 0.3, { variant: 2, reverse: true, fit: def.windup, send: 0.6 });
  for (const [freq, q] of [[640, 7], [1080, 9]] as const) k.noise(out, t, { dur: def.windup, gain: 0.14, filter: 'bandpass', freq, q, attack: def.windup * 0.9, send: 0.6 });
  k.tone(out, t, { type: 'triangle', freq: midiToHz(NOTE.A3), freqEnd: midiToHz(NOTE.D4), dur: def.windup, gain: 0.08, attack: def.windup * 0.7, send: 0.5 });
  V('hit.iron', land, 0.8, { rate: 0.8 });
  V('earth', land, 0.4, { rate: 0.9, send: 0.4 });
  V('boom.sub', land, 0.7);
  V('bell', land, 0.7, { variant: 2, rate: TUNED.BELL2_D3, jitter: 0, send: 0.9 });
  V('bell', land, 0.4, { variant: 1, rate: TUNED.BELL1_D4 * 1.5, at: 0.18, jitter: 0, send: 0.9 });
  V('shimmer', land, 0.16, { rate: 0.75, attack: 0.05, send: 0.8, jitter: 0 });
  k.tone(out, land, { freq: 96, freqEnd: 36, dur: 0.9, gain: 0.36 });
  // D major, voiced like a choir: the Picardy third of the whole score
  for (const n of [NOTE.D3, NOTE.A3, NOTE.D4, NOTE.Fs4, NOTE.A4, NOTE.D5]) {
    for (const detune of [-9, 8]) {
      k.tone(out, land, { type: 'sawtooth', freq: midiToHz(n), detune, dur: 1.9, gain: 0.03, lpf: 1300, lpfEnd: 800, q: 1.4, attack: 0.1, hold: 0.6, vib: 12, vibHz: 5.2, send: 0.7 });
    }
  }
  for (const [freq, q, gain] of [[640, 7, 0.22], [1080, 9, 0.12]] as const) k.noise(out, land, { dur: 1.6, gain, filter: 'bandpass', freq, q, attack: 0.08, hold: 0.5, send: 0.7 });
  [NOTE.D5, NOTE.Fs5, NOTE.A5, NOTE.D6].forEach((n, i) => k.tone(out, land + 0.1 + i * 0.07, { type: 'triangle', freq: midiToHz(n), dur: 1.2, gain: 0.05, send: 0.7 }));
};

const spellOverload = (c: Ctx): void => {
  // Overload: every rune lights at once, the charge climbs past what the blade can hold, and it all goes
  const { k, t, own, def } = c;
  const { V, out, land } = ultimate(c);
  const wind = def.windup;
  V('arcane', t, 0.6, { variant: 1, fit: wind, send: 0.5 });
  V('field', t, 0.5, { rate: 1.6, dur: wind, release: 0.04, lpf: 4200 });
  for (const detune of [-14, 13]) k.tone(out, t, { type: 'sawtooth', freq: 220, freqEnd: 1760, detune, dur: wind, gain: 0.08, lpf: 1200, lpfEnd: 7000, attack: wind * 0.7, send: 0.4 });
  for (let i = 0, n = 7; i < n; i++) V('spark', t, 0.5, { at: wind * (1 - Math.pow(1 - i / n, 2)), rate: 1 + i * 0.12, jitter: 0 });
  V('boom', land, 0.9, { variant: 1, rate: 1.1, send: 0.5 });
  V('boom.sub', land, 0.9);
  V('zap.down', land, 0.6, { rate: 0.9, send: 0.4 });
  V('glass.mid', land, 0.4, { rate: 1.3, send: 0.5 });
  V('laser.large', land, 0.45, { rate: 0.8, send: 0.5 });
  k.tone(out, land, { freq: 140, freqEnd: 32, dur: 1, gain: 0.44 });
  k.noise(out, land, { dur: 0.7, gain: 0.22, filter: 'lowpass', freq: 8000, freqEnd: 200, send: 0.5 });
  // the cascade: each element in turn, a breath apart — the blast resonates with itself
  const pri = own ? VOICES.PRI.OWN : VOICES.PRI.PARTY;
  const cascade: ElementId[] = ['ember', 'rime', 'storm', 'umbra'];
  cascade.forEach((el, i) => k.element(el, land + 0.06 + i * 0.09, (own ? 0.34 : 0.2) * c.level, 1, pri));
  [NOTE.D5, NOTE.F5, NOTE.A5, NOTE.D6].forEach((n, i) => k.tone(out, land + 0.06 + i * 0.09, { type: 'triangle', freq: midiToHz(n), dur: 0.7, gain: 0.06, send: 0.6 }));
};

const shadeMark = (c: Ctx): void => {
  // Death Mark: the light goes out of the room for a moment; then the daggers find everything that was marked
  const { k, t, own, def } = c;
  const { V, out, land } = ultimate(c);
  V('glass.mid', t, 0.3, { reverse: true, fit: def.windup, lpf: 1800 });
  k.noise(out, t, { dur: def.windup, gain: 0.24, filter: 'bandpass', freq: 1400, freqEnd: 240, q: 1.3, attack: def.windup * 0.6 });
  k.element('umbra', land, (own ? 0.5 : 0.3) * c.level, 2, own ? VOICES.PRI.OWN : VOICES.PRI.PARTY);
  V('boom.sub', land, 0.9, { rate: 0.8 });
  V('bell', land, 0.5, { variant: 2, rate: TUNED.BELL2_D3 / 2, jitter: 0, lpf: 1600, send: 0.9 });
  k.tone(out, land, { freq: 92, freqEnd: 30, dur: 1.1, gain: 0.46 });
  // a tritone, low and reedy: the verdict
  for (const n of [NOTE.D3, NOTE.D3 + 6]) k.tone(out, land, { type: 'sawtooth', freq: midiToHz(n), dur: 1.3, gain: 0.07, lpf: 800, attack: 0.03, hold: 0.3, am: 0.4, amHz: 9, send: 0.6 });
  const daggers = 5;
  for (let i = 0; i < daggers; i++) {
    const at = 0.08 + i * 0.045;
    flick(V, k, out, land + at, 0.9 + i * 0.1, 0.4);
    V('hit.ring', land, 0.1, { at, rate: 0.7 + i * 0.08, send: 0.5 });
  }
};

/** A sound for an ability id nobody mapped yet, chosen by its shape. */
const generic = ({ k, t, own, level, def }: Ctx): void => {
  const { V, out } = k.who(own, LV.generic * level);
  V('swing.cloth', t, 0.5, { rate: 0.9 });
  k.whoosh(out, t, 400, 2400, 500, 0.22, 0.14);
  if (def.windup > 0.2 || def.shape === 'circle' || def.shape === 'leap') {
    V('hit.tight', t, 0.5, { at: def.windup });
    k.thump(out, t + def.windup, 110, 0.25, 0.2);
  }
};

/**
 * Every hero ability id -> its sound. Keys must cover ABILITY_BY_ID (see unmappedAbilities()).
 * Impacts: melee and projectile hits are sounded by the weapon layer of the 'hit' event (per attacker class);
 * wind-up abilities land inside their own stack at `windup`; zones and buffs continue in their own events.
 */
export const ABILITY_SOUNDS: Record<string, AbilitySound> = {
  knight_slash1: legacy('knight', 'primary', 0, 'weapon layer on hit'),
  knight_slash2: legacy('knight', 'primary', 1, 'weapon layer on hit'),
  knight_slash3: legacy('knight', 'primary', 2, 'weapon layer on hit'),
  knight_bash: legacy('knight', 'secondary', 0, 'landing in the cast stack'),
  knight_toss: { impact: 'weapon layer on hit', play: knightToss },
  knight_bulwark: { impact: 'buff cue', ult: true, play: knightBulwark },
  barb_chop1: legacy('barbarian', 'primary', 0, 'weapon layer on hit'),
  barb_chop2: legacy('barbarian', 'primary', 2, 'weapon layer on hit'),
  barb_whirl: legacy('barbarian', 'secondary', 0, 'weapon layer on hit'),
  barb_leap: { impact: 'landing in the cast stack', play: leap(false) },
  barb_rage: { impact: 'buff cue', ult: true, play: barbRage },
  mage_bolt: legacy('mage', 'primary', 0, 'weapon layer on hit'),
  mage_nova: legacy('mage', 'secondary', 0, 'landing in the cast stack'),
  mage_lance: { impact: 'release in the cast stack', play: mageLance },
  mage_meteor: { impact: 'landing in the cast stack', ult: true, play: mageMeteor },
  rogue_bolt: legacy('rogue', 'primary', 0, 'weapon layer on hit'),
  rogue_fan: legacy('rogue', 'secondary', 0, 'weapon layer on hit'),
  rogue_trap: { impact: 'trap arm + snap', play: rogueTrap },
  rogue_volley: { impact: 'zone bed + pulses', ult: true, play: rogueVolley },
  templar_swing1: { impact: 'weapon layer on hit', play: templarSwing(false) },
  templar_swing2: { impact: 'weapon layer on hit', play: templarSwing(true) },
  templar_swing3: { impact: 'weapon layer on hit', play: templarFinisher },
  templar_consecrate: { impact: 'zone bed + pulses', play: consecrate },
  templar_judgement: { impact: 'landing in the cast stack', play: leap(true) },
  templar_sanctuary: { impact: 'zone bed + pulses', ult: true, play: templarSanctuary },
  spell_cut1: { impact: 'weapon layer on hit', play: spellCut(false) },
  spell_cut2: { impact: 'weapon layer on hit', play: spellCut(true) },
  spell_wave: { impact: 'weapon layer on hit', play: spellWave },
  spell_blink: { impact: 'landing in the cast stack', play: spellBlink },
  spell_ward: { impact: 'weapon layer on hit', play: spellWard },
  spell_overload: { impact: 'release in the cast stack', ult: true, play: spellOverload },
  shade_stab1: { impact: 'weapon layer on hit', play: shadeStab(false) },
  shade_stab2: { impact: 'weapon layer on hit', play: shadeStab(true) },
  shade_stab3: { impact: 'weapon layer on hit', play: shadeFinisher },
  shade_step: { impact: 'landing in the cast stack', play: shadeStep },
  shade_smoke: { impact: 'zone bed + pulses', play: shadeSmoke },
  shade_mark: { impact: 'release in the cast stack', ult: true, play: shadeMark },
};

/** Ability ids of data/classes.ts that have no entry in ABILITY_SOUNDS (must be empty). */
export function unmappedAbilities(): string[] {
  return [...ABILITY_BY_ID.keys()].filter((id) => !(id in ABILITY_SOUNDS));
}

/** The whole map as text lines, for the workbench and the report. */
export function abilitySoundTable(): string[] {
  return [...ABILITY_BY_ID.keys()].map((id) => {
    const s = ABILITY_SOUNDS[id] as AbilitySound | undefined;
    return `${id.padEnd(20)} ${s ? `${s.ult ? 'ULTIMATE ' : ''}${s.legacy ? `sfx.ts ${s.legacy.cls} ${s.legacy.slot} ${s.legacy.step + 1}` : 'sfx-abilities.ts'} · impact: ${s.impact}` : 'UNMAPPED'}`;
  });
}

export type AbilitySlotName = 'primary' | 'secondary' | 'ultimate';

/** Which class and button an ability id belongs to (arts count as the secondary), or null for unknown ids. */
export function abilityInfo(id: string): { cls: ClassId; slot: AbilitySlotName; step: number } | null {
  for (const def of Object.values(CLASSES)) {
    const step = def.primary.findIndex((a) => a.id === id);
    if (step >= 0) return { cls: def.id, slot: 'primary', step };
    if (def.secondary.id === id || def.arts.some((a) => a.id === id)) return { cls: def.id, slot: 'secondary', step: 0 };
    if (def.ultimate.id === id) return { cls: def.id, slot: 'ultimate', step: 0 };
  }
  return null;
}

interface Bed { kind: string; mix: Mix | null; until: number; own: boolean }

export function createAbilitySfx(k: SfxKit) {
  const zones = new Map<number, Bed>();
  const lastBuff = { id: '', at: -Infinity, own: false };

  const play = (id: string, own: boolean): void => {
    const sound = ABILITY_SOUNDS[id] as AbilitySound | undefined;
    const def = ABILITY_BY_ID.get(id) ?? CLASSES.knight.primary[0];
    const t = k.now();
    const stack = k.take(sound?.ult ? 'ult' : 'cast', t);
    if (stack < 0) return;
    (sound?.play ?? generic)({ k, t, own, level: k.duck(stack), def });
  };

  const liveBeds = (now: number): number => {
    let n = 0;
    for (const [id, bed] of zones) {
      if (bed.until <= now) zones.delete(id);
      else if (bed.mix) n++;
    }
    return n;
  };

  /** Hallowed ground: a warm open fifth with a breath of choir, a soft pulse on every tick. */
  const hallowed = (m: Mix, t: number, dur: number, tick: number, grand: boolean): void => {
    const hold = Math.max(0.1, dur - ZONES.FADE_IN - ZONES.FADE_OUT);
    const notes = grand ? [NOTE.D3, NOTE.A3, NOTE.D4, NOTE.Fs4, NOTE.A4] : [NOTE.D3, NOTE.A3, NOTE.D4];
    for (const n of notes) {
      k.tone(m.out, t, { type: 'triangle', freq: midiToHz(n), dur, gain: grand ? 0.05 : 0.045, attack: ZONES.FADE_IN, hold, vib: 6, vibHz: 4.6, send: 0.6 });
    }
    for (const [freq, q, gain] of [[340, 6, 0.12], [780, 8, 0.06]] as const) {
      k.noise(m.out, t, { dur, gain: gain * (grand ? 1.4 : 1), filter: 'bandpass', freq, q, attack: ZONES.FADE_IN, hold, send: 0.6 });
    }
    k.tone(m.out, t, { freq: midiToHz(NOTE.D2), dur, gain: 0.07, attack: ZONES.FADE_IN, hold });
    const period = Math.max(0.25, tick);
    for (let at = period; at < dur - 0.1; at += period) {
      // the pulse that mends and burns: a soft swell and a small high bell
      k.tone(m.out, t + at, { freq: midiToHz(NOTE.D3), freqEnd: midiToHz(NOTE.D3) * 0.8, dur: 0.22, gain: 0.07, attack: 0.02 });
      k.tone(m.out, t + at, { freq: midiToHz(grand ? NOTE.Fs5 : NOTE.A5), dur: 0.3, gain: 0.018, send: 0.7 });
      if (grand) m.V('ping', t, 0.05, { at, rate: TUNED.PING_TO_D7 / 2, send: 0.8, jitter: 0, free: true });
    }
  };

  /** Smoke: a soft, steady hiss with slow puffs rolling through it. */
  const smoke = (m: Mix, t: number, dur: number): void => {
    const hold = Math.max(0.1, dur - 0.1 - ZONES.FADE_OUT * 2);
    k.noise(m.out, t, { dur, gain: 0.16, filter: 'bandpass', freq: 3400, freqEnd: 2400, q: 0.6, attack: 0.1, hold, send: 0.3 });
    k.noise(m.out, t, { dur, gain: 0.07, filter: 'highpass', freq: 6500, attack: 0.1, hold });
    k.noise(m.out, t, { dur, gain: 0.1, filter: 'lowpass', freq: 420, attack: 0.2, hold });
    for (let at = 0.3; at < dur - 0.5; at += rnd(0.5, 0.9)) {
      k.noise(m.out, t + at, { dur: 0.5, gain: 0.08, filter: 'bandpass', freq: rnd(1200, 2200), q: 1.4, attack: 0.2, send: 0.3 });
      m.V('tex.fire', t, 0.5, { at, offset: -1, dur: 0.35, attack: 0.15, release: 0.3, rate: 0.6, hpf: 1800, lpf: 5000, free: true });
    }
  };

  /** Bolt storm: bolts whistle down and patter into stone, bone and wood, never in time. */
  const patter = (m: Mix, t: number, dur: number): void => {
    k.noise(m.out, t, { dur, gain: 0.05, filter: 'bandpass', freq: 4600, freqEnd: 3000, q: 2, attack: 0.15, hold: Math.max(0.1, dur - 0.5), send: 0.3 });
    let i = 0;
    for (let at = 0.05; at < dur; at += rnd(ZONES.PATTER_GAP[0], ZONES.PATTER_GAP[1])) {
      const pick = i++ % 3;
      const gain = rnd(0.22, 0.4);
      if (pick === 0) m.V('hit.bone', t, gain, { at, rate: rnd(1.2, 1.9), free: true, send: 0.2 });
      else if (pick === 1) m.V('bone.tick', t, gain, { at, rate: rnd(1.1, 1.8), free: true, send: 0.2 });
      else m.V('hit.thud', t, gain * 0.8, { at, rate: rnd(1.3, 1.8), dur: 0.08, free: true });
      // synthesised knock under every impact, so the rain is there before the samples are
      k.tone(m.out, t + at, { type: 'triangle', freq: rnd(260, 520), freqEnd: 150, dur: 0.035, gain: gain * 0.25 });
      if (i % 4 === 0) k.noise(m.out, t + at - 0.04, { dur: 0.05, gain: 0.05, filter: 'bandpass', freq: 5200, freqEnd: 2600, q: 3, attack: 0.03 });
    }
  };

  const api = {
    /**
     * A lasting ground effect appeared (`kind` = ability id). Plays its start cue and, for hallowed ground, smoke
     * and the bolt storm, a bed that lasts as long as the zone does; traps arm.
     */
    zone(id: number, kind: string, dur: number, el: ElementId | null, own: boolean): void {
      const t = k.now();
      const live = liveBeds(t);
      if (zones.size >= ZONES.MAX_TRACKED) zones.clear();
      const stack = k.take('zone', t);
      if (stack < 0) { zones.set(id, { kind, mix: null, until: t + dur, own }); return; }
      const pri = own ? VOICES.PRI.OWN : VOICES.PRI.PARTY;
      if (el) k.element(el, t, (own ? 0.2 : 0.12) * k.duck(stack), 1, pri);
      if (kind === 'rogue_trap') {
        // armed: the jaws lock open with a click and a tick that rises like a question
        const { V, out } = k.who(own, LV.trapArm * k.duck(stack));
        V('foley.latch', t, 0.6, { variant: 1, rate: 1.15, jitter: 0.01 });
        V('hit.ring', t, 0.12, { at: 0.03, rate: 1.6, dur: 0.12, send: 0.3 });
        k.tone(out, t + 0.03, { type: 'square', freq: 880, freqEnd: 1320, dur: 0.06, gain: 0.05, lpf: 3600 });
        zones.set(id, { kind, mix: null, until: t + dur, own });
        return;
      }
      const length = Math.min(dur, ZONES.MAX_SECONDS);
      const bedKind = kind === 'templar_consecrate' || kind === 'templar_sanctuary' ? 'hallowed'
        : kind === 'shade_smoke' ? 'smoke' : kind === 'rogue_volley' ? 'patter' : 'other';
      if (bedKind === 'other') {
        // an unknown lasting effect: a soft low swell so it is not silent
        const { out } = k.who(own, LV.zoneStart * k.duck(stack));
        k.tone(out, t, { freq: midiToHz(NOTE.D3), dur: 0.6, gain: 0.08, attack: 0.1, send: 0.5 });
        zones.set(id, { kind, mix: null, until: t + dur, own });
        return;
      }
      if (live >= ZONES.MAX_BEDS) { zones.set(id, { kind, mix: null, until: t + dur, own }); return; }
      const kindLevel = bedKind === 'smoke' ? LV.bedSmoke : bedKind === 'patter' ? LV.bedPatter : kind === 'templar_sanctuary' ? LV.bedGrand : LV.bedHallowed;
      const m = k.who(own, (own ? LV.bed : LV.bedAlly) * kindLevel * k.duck(stack));
      if (bedKind === 'hallowed') hallowed(m, t, length, ABILITY_BY_ID.get(kind)?.tick ?? 0.5, kind === 'templar_sanctuary');
      else if (bedKind === 'smoke') smoke(m, t, length);
      else patter(m, t, length);
      // close the bed on time even where single layers ring a little longer
      m.fade(t + length - ZONES.FADE_OUT / 2, ZONES.FADE_OUT / 3);
      zones.set(id, { kind, mix: m, until: t + length, own });
    },
    /** A zone ended early. A sprung trap snaps shut; other beds are faded out. */
    zoneEnd(id: number, sprung: boolean): void {
      const t = k.now();
      const bed = zones.get(id);
      zones.delete(id);
      if (bed?.mix && bed.until > t) bed.mix.fade(t, ZONES.END_TC);
      const stack = k.take('zoneEnd', t);
      if (stack < 0) return;
      const own = bed?.own ?? false;
      if (sprung) {
        // the snare: iron jaws slam, the chain yanks tight
        const { V, out } = k.who(own, LV.trapSnap * k.duck(stack));
        V('hit.clang', t, 0.8, { rate: 1.1, send: 0.3 });
        V('hit.iron', t, 0.6, { rate: 1.2 });
        V('foley.latch', t, 0.6, { variant: 1, rate: 0.8 });
        V('hit.metal', t, 0.4, { at: 0.05, rate: 1.4 });
        V('pot', t, 0.25, { at: 0.07, rate: 1.5, dur: 0.2, send: 0.3 });
        k.noise(out, t, { dur: 0.02, gain: 0.4, filter: 'highpass', freq: 4000 });
        k.thump(out, t, 160, 0.14, 0.26);
        k.tone(out, t, { type: 'square', freq: 1320, freqEnd: 660, dur: 0.08, gain: 0.05, lpf: 4000 });
      } else if (bed && bed.until > t + 0.2) {
        // dispelled before its time: a short breath out
        const { out } = k.who(own, LV.zoneFade * k.duck(stack));
        k.noise(out, t, { dur: 0.35, gain: 0.1, filter: 'bandpass', freq: 1400, freqEnd: 400, q: 1.2, send: 0.4 });
      }
    },
    /** A timed hero effect started (BUFFS in data/classes.ts): the character layer on top of the ultimate's release. */
    buff(id: string, own: boolean): void {
      const t = k.now();
      // one banner reaches several heroes: the cue plays once; if it then turns out to include the own hero, a small echo says so
      const echo = id === lastBuff.id && t - lastBuff.at < LV.BUFF_ECHO_S;
      if (echo && (!own || lastBuff.own)) return;
      const stack = echo ? 0 : k.take('buff', t);
      if (stack < 0) return;
      lastBuff.id = id;
      lastBuff.at = t;
      lastBuff.own = own;
      const trim = id === 'bulwark' ? LV.buffBulwark : id === 'bloodrage' ? LV.buffRage : 1;
      const { V, out } = k.who(own, (echo ? LV.buffEcho : LV.buff * trim) * k.duck(stack));
      if (echo) {
        k.tone(out, t, { type: 'triangle', freq: midiToHz(NOTE.D5), dur: 0.5, gain: 0.08, send: 0.6 });
        k.tone(out, t + 0.06, { type: 'triangle', freq: midiToHz(NOTE.A5), dur: 0.5, gain: 0.06, send: 0.6 });
        return;
      }
      if (id === 'bloodrage') {
        // the roar: a throat of detuned saws breaking upwards, breath over it, then the heart
        for (const [freq, detune] of [[98, 0], [147, 17], [196, -13]] as const) {
          k.tone(out, t, { type: 'sawtooth', freq, freqEnd: freq * 0.72, detune, dur: 1.1, gain: 0.2, lpf: 500, lpfEnd: 2400, attack: 0.05, hold: 0.25, am: 0.75, amHz: 31, send: 0.4 });
        }
        k.noise(out, t, { dur: 1, gain: 0.2, filter: 'bandpass', freq: 800, freqEnd: 1900, q: 0.9, attack: 0.08, hold: 0.2, send: 0.4 });
        V('boom', t, 0.3, { variant: 3, rate: 1.2, lpf: 2500, send: 0.4 });
        for (const at of [0.75, 0.97, 1.5, 1.72]) {
          k.tone(out, t + at, { freq: 70, freqEnd: 44, dur: 0.16, gain: own ? 0.3 : 0.12 });
          V('hit.sub', t, own ? 0.4 : 0.15, { at, rate: 0.9 });
        }
      } else if (id === 'bulwark') {
        // the horn call (D, then the fifth above, held) and the bell humming under it
        const call: [number, number, number][] = [[0, NOTE.D3, 0.32], [0.3, NOTE.A3, 1.2]];
        for (const [at, n, len] of call) {
          for (const detune of [-8, 7]) {
            k.tone(out, t + at, { type: 'sawtooth', freq: midiToHz(n), detune, dur: len, gain: 0.13, lpf: 420, lpfEnd: 1700, q: 1.6, attack: 0.06, hold: len * 0.55, vib: 7, send: 0.6 });
          }
          k.tone(out, t + at, { freq: midiToHz(n), dur: len, gain: 0.1, attack: 0.05, hold: len * 0.5 });
        }
        V('bell', t, 0.5, { variant: 2, rate: TUNED.BELL2_D3, jitter: 0, send: 0.9 });
        V('bell', t, 0.25, { at: 0.3, variant: 1, rate: TUNED.BELL1_D4, jitter: 0, send: 0.9 });
        V('hit.plate', t, 0.3, { rate: 0.9, send: 0.4 });
      } else if (id === 'overload') {
        // the afterglow crackles: sparks that will not stop, over a buzzing, overdriven edge
        for (let i = 0; i < 12; i++) V('spark', t, rnd(0.4, 0.8), { at: rnd(0, 1.2) * (i / 12 + 0.1), rate: rnd(0.9, 1.9), jitter: 0, free: true });
        V('zap.up', t, 0.35, { rate: 1.1, send: 0.4 });
        V('scratch', t, 0.3, { at: 0.2, rate: 1.2, hpf: 1500 });
        k.tone(out, t, { type: 'square', freq: 110, dur: 1.2, gain: 0.12, lpf: 2200, lpfEnd: 900, hold: 0.3, am: 0.9, amHz: 57 });
        k.tone(out, t, { type: 'sawtooth', freq: 1760, freqEnd: 2637, dur: 0.9, gain: 0.03, lpf: 7000, hold: 0.2, am: 1, amHz: 37, send: 0.4 });
        k.noise(out, t, { dur: 1.1, gain: 0.07, filter: 'bandpass', freq: 5200, q: 3, attack: 0.05, hold: 0.3 });
      } else {
        // a buff nobody designed yet: a neutral rising glow
        k.tone(out, t, { type: 'triangle', freq: midiToHz(NOTE.D4), freqEnd: midiToHz(NOTE.A4), dur: 0.6, gain: 0.1, attack: 0.05, send: 0.5 });
      }
    },
    /** An enemy was marked for death: a cold little sting; several marks in a row climb a tritone ladder. */
    mark(): void {
      const t = k.now();
      const stack = k.take('mark', t);
      if (stack < 0) return;
      const { V, out } = k.mix('element', VOICES.PRI.PARTY, LV.mark * k.duck(stack));
      const up = 1 + stack * 0.19;
      V('hit.ring', t, 0.3, { rate: 0.55 * up, lpf: 3800, send: 0.5 });
      V('swing.blade', t, 0.14, { rate: 1.8, dur: 0.05, hpf: 2600 });
      for (const n of [NOTE.D5, NOTE.D5 + 6]) k.tone(out, t, { type: 'square', freq: midiToHz(n) * up, dur: 0.14, gain: 0.05, lpf: 2600, send: 0.4 });
      k.tone(out, t, { freq: 120, freqEnd: 62, dur: 0.2, gain: 0.2 });
      k.noise(out, t, { dur: 0.22, gain: 0.14, filter: 'bandpass', freq: 320, freqEnd: 150, q: 1, attack: 0.04, send: 0.4 });
    },
    /** The ultimate is charged. Clear for the own hero, barely there for allies. */
    ultReady(own: boolean): void {
      const t = k.now();
      if (!own) {
        if (k.take('ready', t) < 0) return;
        const { out } = k.mix('combat', VOICES.PRI.WORLD, LV.readyAlly);
        k.tone(out, t, { freq: midiToHz(NOTE.A5), dur: 0.3, gain: 0.03, send: 0.5 });
        return;
      }
      const { V, out } = k.mix('own', VOICES.PRI.OWN, LV.ready);
      // charged: a low pulse you feel, then a fifth snapping up into the octave
      k.tone(out, t, { freq: 98, freqEnd: 62, dur: 0.22, gain: 0.2 });
      V('arcane', t, 0.25, { variant: 2, rate: 0.9, lpf: 4200, send: 0.5, jitter: 0 });
      [NOTE.A4, NOTE.D5, NOTE.A5].forEach((n, i) => {
        k.tone(out, t + 0.05 + i * 0.075, { type: 'triangle', freq: midiToHz(n), dur: 0.5, gain: 0.09, attack: 0.008, send: 0.55 });
        k.tone(out, t + 0.05 + i * 0.075, { freq: midiToHz(n) * 2, dur: 0.25, gain: 0.025, send: 0.55 });
      });
      V('ping', t, 0.14, { at: 0.2, variant: 2, rate: TUNED.PING_TO_D7, jitter: 0, send: 0.7 });
      k.noise(out, t + 0.05, { dur: 0.3, gain: 0.03, filter: 'highpass', freq: 5000, freqEnd: 9000, attack: 0.1 });
    },
  };

  return {
    api,
    play,
    /** The four first classes' own abilities are sounded by sfx.ts. */
    legacyOf: (id: string): AbilitySound['legacy'] | undefined => (ABILITY_SOUNDS[id] as AbilitySound | undefined)?.legacy,
  };
}
