import type { ClassId, PlayerAnim, ProjectileKind } from '../types.ts';

export const DASH = {
  /** Metres per second while dashing. */
  SPEED: 28,
  DURATION: 0.18,
  /** Seconds of invulnerability from dash start. */
  IFRAMES: 0.26,
  /** Seconds to regain one charge. */
  COOLDOWN: 2.4,
} as const;

/**
 * shape:
 *  arc        – melee swing in front of the hero: `range` reach, `arc` total degrees
 *  projectile – `count` projectiles spread over `arc` degrees, `speed` m/s, `range` max distance, `radius` hit radius
 *  circle     – ground-targeted blast at the cursor (max `range` away) with `radius`, lands after `windup`
 *  spin       – damage pulses of `radius` around the hero every `tick` seconds for `duration` seconds
 *  lunge      – hero dashes `range` metres along aim, hitting everything within `radius` of the path
 *  beam       – instant line from the hero along aim: `range` long, `radius` = half width, hits everything in it
 *  leap       – hero jumps to the cursor (max `range`) and lands after `windup` with a blast of `radius`;
 *               invulnerable in the air
 *  zone       – lasting ground effect of `radius` for `duration` seconds, pulsing every `tick`: `damage` to
 *               enemies and `heal` to heroes inside. Centred on the hero if `range` is 0, else at the cursor.
 *  trap       – placed at the cursor (max `range`), arms after `windup`, lasts `duration` seconds and goes off
 *               with `radius` when an enemy steps on it
 *  buff       – starts the timed effect `buff` (see BUFFS) for `duration` seconds on the hero, or on every hero
 *               within `radius` if that is > 0
 * `special` names extra behaviour that only the simulation implements; each value is documented at its ability.
 */
export interface AbilityDef {
  id: string;
  shape: 'arc' | 'projectile' | 'circle' | 'spin' | 'lunge' | 'beam' | 'leap' | 'zone' | 'trap' | 'buff';
  /** Seconds before the ability can be used again (measured from activation). */
  cooldown: number;
  /** Seconds from activation to the hit / projectile release. */
  windup: number;
  /** Seconds from activation during which no other ability can start. */
  lock: number;
  /** Move speed multiplier while locked (0 = rooted). */
  moveMul: number;
  damage: number;
  range: number;
  arc: number;
  radius: number;
  speed: number;
  count: number;
  pierce: number;
  /** Seconds of stun applied to enemies hit. */
  stun: number;
  /** Metres enemies are pushed away. */
  knockback: number;
  duration: number;
  tick: number;
  /** Shield granted to the caster on use. */
  selfShield: number;
  projectile: ProjectileKind | null;
  anim: PlayerAnim;
  /** Health restored to heroes (per pulse for zones, once otherwise). */
  heal: number;
  buff: BuffId | null;
  special: string | null;
}

/**
 * Timed effects on heroes (announced with the `buff` event).
 *  bloodrage – barbarian ultimate: more damage, faster attacks and movement, heals on kill
 *  bulwark   – knight ultimate: heroes in the banner's reach take far less damage; enemies nearby turn on the knight
 *  overload  – spellblade ultimate afterglow: every hit applies the hero's next infused element in turn
 */
export const BUFFS = {
  bloodrage: { damage: 0.3, attackSpeed: 0.25, moveSpeed: 0.2, lifeOnKill: 4 },
  bulwark: { damageTaken: 0.5, tauntRadius: 9 },
  overload: { potency: 1.5 },
} as const;
export type BuffId = keyof typeof BUFFS;

/**
 * Ultimates need a full charge (100). Charge comes from damage dealt and taken, never from time, and is kept
 * between chambers. An ultimate has no cooldown of its own.
 */
export const ULTIMATE = {
  MAX: 100,
  PER_DAMAGE_DEALT: 0.04,
  PER_DAMAGE_TAKEN: 0.3,
  PER_RESONANCE: 4,
  /** Largest charge a single hit can give (one huge blast must not fill the bar). */
  MAX_PER_HIT: 6,
  /** Shade ultimate: damage taken bonus on marked enemies, burst when they die, enemies marked at most. */
  MARK_VULNERABILITY: 0.3, MARK_BURST_DAMAGE: 45, MARK_BURST_RADIUS: 3, MARK_MAX_TARGETS: 6,
  /** Templar sanctuary: seconds a downed ally must lie inside to be raised. */
  SANCTUARY_REVIVE_SECONDS: 2,
} as const;

const base: Omit<AbilityDef, 'id' | 'shape' | 'anim'> = {
  cooldown: 0.4, windup: 0.1, lock: 0.3, moveMul: 0.45, damage: 10, range: 2.5, arc: 100, radius: 0.35,
  speed: 0, count: 1, pierce: 0, stun: 0, knockback: 0, duration: 0, tick: 0, selfShield: 0, projectile: null,
  heal: 0, buff: null, special: null,
};

/** Pierces everything (beams, big discs). */
const PIERCE_ALL = 99;

export interface ClassDef {
  id: ClassId;
  maxHp: number;
  moveSpeed: number;
  dashCharges: number;
  /** Primary attack chain; repeated presses within COMBO_WINDOW advance through it. */
  primary: AbilityDef[];
  secondary: AbilityDef;
  /** Alternative secondaries, unlocked through mastery. Loadout.art = n selects arts[n - 1]. Animation: `art`. */
  arts: AbilityDef[];
  /** Third ability (BTN.ULTIMATE), paid with a full ultimate charge. Animation: `ultimate`. */
  ultimate: AbilityDef;
}

/** The secondary a hero actually uses for a given Loadout.art (falls back to the standard one). */
export function secondaryOf(cls: ClassDef, art: number): AbilityDef {
  return cls.arts[art - 1] ?? cls.secondary;
}

/** Seconds after a primary attack's lock ends during which the next press continues the chain. */
export const COMBO_WINDOW = 0.6;

export const CLASSES: Record<ClassId, ClassDef> = {
  knight: {
    id: 'knight', maxHp: 125, moveSpeed: 5.6, dashCharges: 1,
    primary: [
      { ...base, id: 'knight_slash1', shape: 'arc', anim: 'primary1', cooldown: 0.36, windup: 0.11, lock: 0.3, damage: 18, range: 2.8, arc: 110 },
      { ...base, id: 'knight_slash2', shape: 'arc', anim: 'primary2', cooldown: 0.36, windup: 0.11, lock: 0.3, damage: 18, range: 2.8, arc: 110 },
      { ...base, id: 'knight_slash3', shape: 'arc', anim: 'primary3', cooldown: 0.56, windup: 0.18, lock: 0.44, damage: 31, range: 3.1, arc: 150, knockback: 2 },
    ],
    secondary: { ...base, id: 'knight_bash', shape: 'lunge', anim: 'secondary', cooldown: 6, windup: 0.08, lock: 0.42, moveMul: 0, damage: 26, range: 4.6, radius: 1.3, stun: 1.2, knockback: 1.5, selfShield: 12 },
    arts: [
      // Shield Toss: the shield flies through everything in a line and stuns briefly.
      { ...base, id: 'knight_toss', shape: 'projectile', anim: 'art', cooldown: 7, windup: 0.18, lock: 0.4, moveMul: 0.3, damage: 30, range: 13, arc: 0, radius: 0.75, speed: 20, pierce: PIERCE_ALL, stun: 0.6, knockback: 1, projectile: 'shieldDisc' },
    ],
    // Banner of the Last Bell: see BUFFS.bulwark; every hero in reach also gains the shield.
    ultimate: { ...base, id: 'knight_bulwark', shape: 'buff', anim: 'ultimate', cooldown: 0, windup: 0.3, lock: 0.6, moveMul: 0, damage: 0, radius: 8, duration: 6, selfShield: 45, buff: 'bulwark' },
  },
  barbarian: {
    id: 'barbarian', maxHp: 140, moveSpeed: 5.4, dashCharges: 1,
    primary: [
      { ...base, id: 'barb_chop1', shape: 'arc', anim: 'primary1', cooldown: 0.54, windup: 0.19, lock: 0.44, damage: 27, range: 3.1, arc: 130, moveMul: 0.45 },
      { ...base, id: 'barb_chop2', shape: 'arc', anim: 'primary2', cooldown: 0.66, windup: 0.23, lock: 0.5, damage: 36, range: 3.2, arc: 165, moveMul: 0.45, knockback: 2.5 },
    ],
    secondary: { ...base, id: 'barb_whirl', shape: 'spin', anim: 'secondary', cooldown: 8, windup: 0.1, lock: 1.4, moveMul: 0.8, damage: 12, radius: 3.2, duration: 1.4, tick: 0.2, knockback: 0.4, selfShield: 18 },
    arts: [
      // Skullsplitter: leap to the cursor and crash down.
      { ...base, id: 'barb_leap', shape: 'leap', anim: 'art', cooldown: 8, windup: 0.5, lock: 0.75, moveMul: 0, damage: 46, range: 9, radius: 3, stun: 0.5, knockback: 2.5 },
    ],
    // Bloodrage: see BUFFS.bloodrage.
    ultimate: { ...base, id: 'barb_rage', shape: 'buff', anim: 'ultimate', cooldown: 0, windup: 0.25, lock: 0.5, moveMul: 0.5, damage: 0, radius: 0, duration: 8, buff: 'bloodrage' },
  },
  mage: {
    id: 'mage', maxHp: 95, moveSpeed: 5.5, dashCharges: 1,
    primary: [
      { ...base, id: 'mage_bolt', shape: 'projectile', anim: 'primary1', cooldown: 0.34, windup: 0.08, lock: 0.2, moveMul: 0.6, damage: 16, range: 16, arc: 0, radius: 0.4, speed: 22, projectile: 'arcBolt' },
    ],
    secondary: { ...base, id: 'mage_nova', shape: 'circle', anim: 'secondary', cooldown: 6, windup: 0.55, lock: 0.4, moveMul: 0.3, damage: 44, range: 11, radius: 3.4, knockback: 2.5 },
    arts: [
      // Arc Lance: an instant beam through everything in a line.
      { ...base, id: 'mage_lance', shape: 'beam', anim: 'art', cooldown: 6, windup: 0.35, lock: 0.5, moveMul: 0.2, damage: 38, range: 14, radius: 0.7, pierce: PIERCE_ALL, knockback: 1 },
    ],
    // Starfall: a slow, huge blast at the cursor.
    ultimate: { ...base, id: 'mage_meteor', shape: 'circle', anim: 'ultimate', cooldown: 0, windup: 1.1, lock: 0.7, moveMul: 0.2, damage: 150, range: 14, radius: 5.5, stun: 1, knockback: 3 },
  },
  rogue: {
    id: 'rogue', maxHp: 90, moveSpeed: 6.1, dashCharges: 2,
    primary: [
      { ...base, id: 'rogue_bolt', shape: 'projectile', anim: 'primary1', cooldown: 0.23, windup: 0.05, lock: 0.12, moveMul: 0.7, damage: 10, range: 18, arc: 0, radius: 0.3, speed: 30, pierce: 1, projectile: 'crossbowBolt' },
    ],
    secondary: { ...base, id: 'rogue_fan', shape: 'projectile', anim: 'secondary', cooldown: 5, windup: 0.1, lock: 0.25, moveMul: 0.5, damage: 12, range: 9, arc: 50, radius: 0.3, speed: 24, count: 5, projectile: 'knife' },
    arts: [
      // Snare: a trap that roots (stuns) and wounds whatever steps on it. Up to 3 can lie at once (special).
      { ...base, id: 'rogue_trap', shape: 'trap', anim: 'art', cooldown: 6, windup: 0.6, lock: 0.3, moveMul: 0.6, damage: 34, range: 8, radius: 2.2, duration: 14, stun: 1.2, special: 'max3' },
    ],
    // Bolt Storm: bolts rain on an area for a few seconds.
    ultimate: { ...base, id: 'rogue_volley', shape: 'zone', anim: 'ultimate', cooldown: 0, windup: 0.3, lock: 0.5, moveMul: 0.4, damage: 12, range: 14, radius: 4.5, duration: 3.5, tick: 0.25 },
  },
  // Two-handed zealot. Slow, wide, heavy swings; keeps the party standing.
  templar: {
    id: 'templar', maxHp: 128, moveSpeed: 5.3, dashCharges: 1,
    primary: [
      { ...base, id: 'templar_swing1', shape: 'arc', anim: 'primary1', cooldown: 0.6, windup: 0.22, lock: 0.5, damage: 29, range: 3.4, arc: 150, moveMul: 0.4 },
      { ...base, id: 'templar_swing2', shape: 'arc', anim: 'primary2', cooldown: 0.6, windup: 0.22, lock: 0.5, damage: 29, range: 3.4, arc: 150, moveMul: 0.4 },
      { ...base, id: 'templar_swing3', shape: 'arc', anim: 'primary3', cooldown: 0.85, windup: 0.32, lock: 0.7, damage: 48, range: 3.7, arc: 200, moveMul: 0.3, knockback: 2.5, stun: 0.3 },
    ],
    // Consecrate: hallowed ground around the templar hurts enemies and mends heroes.
    secondary: { ...base, id: 'templar_consecrate', shape: 'zone', anim: 'secondary', cooldown: 9, windup: 0.3, lock: 0.5, moveMul: 0.3, damage: 7, heal: 1.5, range: 0, radius: 3.6, duration: 5, tick: 0.5 },
    arts: [
      // Judgement: leap and smite.
      { ...base, id: 'templar_judgement', shape: 'leap', anim: 'art', cooldown: 8, windup: 0.45, lock: 0.7, moveMul: 0, damage: 42, range: 7, radius: 2.8, stun: 1 },
    ],
    // Sanctuary: a large hallowed circle; downed heroes inside are raised after ULTIMATE.SANCTUARY_REVIVE_SECONDS (special).
    ultimate: { ...base, id: 'templar_sanctuary', shape: 'zone', anim: 'ultimate', cooldown: 0, windup: 0.4, lock: 0.7, moveMul: 0, damage: 8, heal: 4, range: 0, radius: 5.5, duration: 6, tick: 0.5, special: 'revive' },
  },
  // Sword in one hand, spellbook in the other: melee combo that ends in a ranged wave, blinks through foes.
  spellblade: {
    id: 'spellblade', maxHp: 112, moveSpeed: 5.8, dashCharges: 1,
    primary: [
      { ...base, id: 'spell_cut1', shape: 'arc', anim: 'primary1', cooldown: 0.32, windup: 0.09, lock: 0.26, damage: 16, range: 2.7, arc: 110, moveMul: 0.55 },
      { ...base, id: 'spell_cut2', shape: 'arc', anim: 'primary2', cooldown: 0.32, windup: 0.09, lock: 0.26, damage: 16, range: 2.7, arc: 110, moveMul: 0.55 },
      { ...base, id: 'spell_wave', shape: 'projectile', anim: 'primary3', cooldown: 0.5, windup: 0.16, lock: 0.38, moveMul: 0.4, damage: 27, range: 10, arc: 0, radius: 1.1, speed: 18, pierce: 3, projectile: 'bladeWave' },
    ],
    // Blink Strike: flash through enemies along the aim.
    secondary: { ...base, id: 'spell_blink', shape: 'lunge', anim: 'secondary', cooldown: 5, windup: 0.05, lock: 0.3, moveMul: 0, damage: 30, range: 6.5, radius: 1.4, selfShield: 14 },
    arts: [
      // Rune Ward: spinning runes shield the spellblade and cut what comes close.
      { ...base, id: 'spell_ward', shape: 'spin', anim: 'art', cooldown: 8, windup: 0.1, lock: 0.3, moveMul: 0.9, damage: 9, radius: 2.8, duration: 2.4, tick: 0.3, selfShield: 22 },
    ],
    // Overload: a blast around the hero that applies each element the hero has infused, one after the other
    // (two random ones without infusions), so it resonates with itself; then BUFFS.overload for `duration` (special).
    ultimate: { ...base, id: 'spell_overload', shape: 'circle', anim: 'ultimate', cooldown: 0, windup: 0.4, lock: 0.6, moveMul: 0.2, damage: 60, range: 0, radius: 6, duration: 6, buff: 'overload', special: 'allElements' },
  },
  // Twin daggers. Fragile and fast; rewards flanking (special `backstab`: +40 % from behind) and marks targets.
  shade: {
    id: 'shade', maxHp: 98, moveSpeed: 6.3, dashCharges: 2,
    primary: [
      { ...base, id: 'shade_stab1', shape: 'arc', anim: 'primary1', cooldown: 0.2, windup: 0.05, lock: 0.15, damage: 11.5, range: 2.3, arc: 90, moveMul: 0.75, special: 'backstab' },
      { ...base, id: 'shade_stab2', shape: 'arc', anim: 'primary2', cooldown: 0.2, windup: 0.05, lock: 0.15, damage: 11.5, range: 2.3, arc: 90, moveMul: 0.75, special: 'backstab' },
      { ...base, id: 'shade_stab3', shape: 'arc', anim: 'primary3', cooldown: 0.34, windup: 0.09, lock: 0.26, damage: 22, range: 2.6, arc: 120, moveMul: 0.6, special: 'backstab' },
    ],
    // Shadowstep: dash through foes; the hit is always critical (special).
    secondary: { ...base, id: 'shade_step', shape: 'lunge', anim: 'secondary', cooldown: 5, windup: 0.04, lock: 0.25, moveMul: 0, damage: 26, range: 7, radius: 1.2, selfShield: 10, special: 'crit' },
    arts: [
      // Smoke Bomb: a cloud around the shade; enemies inside are slowed and deal less damage (special).
      { ...base, id: 'shade_smoke', shape: 'zone', anim: 'art', cooldown: 9, windup: 0.15, lock: 0.3, moveMul: 0.8, damage: 5, range: 0, radius: 3.6, duration: 4.5, tick: 0.5, special: 'smoke' },
    ],
    // Death Mark: marks enemies near the cursor (see ULTIMATE.MARK_*) and throws a dagger at each (special).
    ultimate: { ...base, id: 'shade_mark', shape: 'circle', anim: 'ultimate', cooldown: 0, windup: 0.2, lock: 0.4, moveMul: 0.5, damage: 30, range: 12, radius: 5, duration: 8, projectile: 'shadowDagger', special: 'mark' },
  },
};

/** Smoke Bomb (shade): slow and outgoing-damage cut on enemies inside. */
export const SMOKE = { SLOW: 0.4, WEAKEN: 0.4 } as const;
/** Shade passive on primary hits from behind (target faces away within this half angle, degrees). */
export const BACKSTAB = { BONUS: 0.4, HALF_ANGLE_DEG: 75 } as const;
/** Snare (rogue): traps that may lie at the same time; the oldest is removed. */
export const TRAP = { MAX_ACTIVE: 3 } as const;

/** Every hero ability by id (primary chains, secondaries, arts, ultimates). */
export const ABILITY_BY_ID: ReadonlyMap<string, AbilityDef> = new Map(
  Object.values(CLASSES).flatMap((c) => [...c.primary, c.secondary, ...c.arts, c.ultimate]).map((a) => [a.id, a]),
);
