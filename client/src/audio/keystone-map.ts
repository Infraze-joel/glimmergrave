/**
 * Update 5, keystones: everything the audio derives from keystone ids and counts without touching Web Audio
 * (so it can be unit-tested): the six families that colour the keystone moment and the score, the power level of
 * the own hero's attack layers, Bloodrush's pitch and tempo per stack, the held list after a `keystone` event.
 */
import { KEYSTONE_BY_ID, KEYSTONE_TUNING, KEYSTONES } from '@shared/data/keystones.ts';

/**
 * The six groups of data/keystones.ts. Each has its own timbre in the keystone moment and its own voice in the score:
 *   movement  – air: running arpeggios, sweeps
 *   primary   – steel: struck metal, stabs in fifths
 *   secondary – deep magic: a low bell, a hummed choir
 *   companion – twinkling: glass notes answering each other
 *   win       – brass: a rising horn call, a war drum
 *   class     – the full chord: open choir and a high voice
 */
export const KEYSTONE_FAMILIES = ['movement', 'primary', 'secondary', 'companion', 'win', 'class'] as const;
export type KeystoneFamily = (typeof KEYSTONE_FAMILIES)[number];

const FAMILY: Record<string, KeystoneFamily> = {
  ember_wake: 'movement', shockstep: 'movement', phase_walker: 'movement',
  ricochet: 'primary', chain_lightning: 'primary', heavy_hitter: 'primary',
  twin_cast: 'secondary', blood_price: 'secondary',
  orbit_blades: 'companion', familiar: 'companion', colossus: 'companion',
  corpse_bloom: 'win', resonance_engine: 'win', glass_cannon: 'win', sanguine: 'win', momentum_engine: 'win',
};

/** Family of a keystone: class keystones by their `cls`, the generic ones by the table; unknown ids count as `win`. */
export function keystoneFamily(id: string): KeystoneFamily {
  if (KEYSTONE_BY_ID.get(id)?.cls) return 'class';
  return FAMILY[id] ?? 'win';
}

/** Generic keystone ids that have no family in the table (must be empty; checked by the unit test). */
export function unmappedKeystones(): string[] {
  return KEYSTONES.filter((def) => !def.cls && !(def.id in FAMILY)).map((def) => def.id);
}

export interface ScoreVoice {
  family: KeystoneFamily;
  /** The second keystone is of the same family as the first: its voice plays the denser variant instead of doubling. */
  dense: boolean;
}

/** The voices the combat score gains: one per held keystone, in the order taken, at most MAX_HELD. */
export function scoreVoices(held: readonly string[]): ScoreVoice[] {
  const families = held.slice(0, KEYSTONE_TUNING.MAX_HELD).map(keystoneFamily);
  return families.map((family, i) => ({ family, dense: i > 0 && families[0] === family }));
}

/** Compact key of a voice list (to tell whether the score has to change). */
export function voicesKey(voices: readonly ScoreVoice[]): string {
  return voices.map((voice) => `${voice.family}${voice.dense ? '+' : ''}`).join(',');
}

/** How many power layers the own hero's attacks carry: 0 none, 1 weight, 2 weight and sparkle. */
export function powerLevel(held: readonly string[]): 0 | 1 | 2 {
  return held.length >= KEYSTONE_TUNING.MAX_HELD ? 2 : held.length >= 1 ? 1 : 0;
}

/** The held list after a `keystone` event (the roster may confirm it a moment later). */
export function heldAfter(held: readonly string[], id: string, replaced?: string): string[] {
  const next = held.filter((k) => k !== replaced && k !== id);
  next.push(id);
  return next.slice(-KEYSTONE_TUNING.MAX_HELD);
}

const RUSH_DEF = KEYSTONE_BY_ID.get('momentum_engine')?.params;

export const BLOODRUSH = {
  MAX: RUSH_DEF?.max ?? 10,
  /** Seconds a stack lasts: the pulse runs this long after the last kill. */
  SECONDS: RUSH_DEF?.seconds ?? 5,
  /** Heartbeats per minute at one stack and gained per further stack. */
  BPM: 84,
  BPM_PER_STACK: 9,
  /** Semitones the kill accent climbs per stack (a whole-tone ladder: it never resolves, it only rises). */
  SEMITONES_PER_STACK: 2,
} as const;

/** Stacks as the sim reports them in `keystoneProc.n`, clamped; a missing count is one stack. */
export function rushStacks(n: number | undefined): number {
  if (n === undefined || !Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(BLOODRUSH.MAX, Math.round(n)));
}

/** Bloodrush: heartbeat tempo (bpm) and accent pitch (playback-rate factor) for `n` stacks. Both rise with every stack. */
export function rushPulse(n: number | undefined): { bpm: number; rate: number; level: number } {
  const stacks = rushStacks(n);
  return {
    bpm: BLOODRUSH.BPM + (stacks - 1) * BLOODRUSH.BPM_PER_STACK,
    rate: Math.pow(2, ((stacks - 1) * BLOODRUSH.SEMITONES_PER_STACK) / 12),
    level: 0.6 + 0.4 * (stacks / BLOODRUSH.MAX),
  };
}

/**
 * Keystones whose sound is derived on the client as long as the sim has not sent a `keystoneProc` for them in this
 * session (see index.ts): from the hero's casts, hits and zones, or — the familiar — from a timer.
 */
export const DERIVED_KEYSTONES = ['heavy_hitter', 'blood_price', 'twin_cast', 'glass_cannon', 'colossus', 'familiar', 'ks_mage', 'ks_templar'] as const;
