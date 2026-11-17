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
 */
export interface AbilityDef {
  id: string;
  shape: 'arc' | 'projectile' | 'circle' | 'spin' | 'lunge';
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
}

const base: Omit<AbilityDef, 'id' | 'shape' | 'anim'> = {
  cooldown: 0.4, windup: 0.1, lock: 0.3, moveMul: 0.45, damage: 10, range: 2.5, arc: 100, radius: 0.35,
  speed: 0, count: 1, pierce: 0, stun: 0, knockback: 0, duration: 0, tick: 0, selfShield: 0, projectile: null,
};

export interface ClassDef {
  id: ClassId;
  maxHp: number;
  moveSpeed: number;
  dashCharges: number;
  /** Primary attack chain; repeated presses within COMBO_WINDOW advance through it. */
  primary: AbilityDef[];
  secondary: AbilityDef;
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
  },
  barbarian: {
    id: 'barbarian', maxHp: 140, moveSpeed: 5.4, dashCharges: 1,
    primary: [
      { ...base, id: 'barb_chop1', shape: 'arc', anim: 'primary1', cooldown: 0.54, windup: 0.19, lock: 0.44, damage: 27, range: 3.1, arc: 130, moveMul: 0.45 },
      { ...base, id: 'barb_chop2', shape: 'arc', anim: 'primary2', cooldown: 0.66, windup: 0.23, lock: 0.5, damage: 36, range: 3.2, arc: 165, moveMul: 0.45, knockback: 2.5 },
    ],
    secondary: { ...base, id: 'barb_whirl', shape: 'spin', anim: 'secondary', cooldown: 8, windup: 0.1, lock: 1.4, moveMul: 0.8, damage: 12, radius: 3.2, duration: 1.4, tick: 0.2, knockback: 0.4, selfShield: 18 },
  },
  mage: {
    id: 'mage', maxHp: 95, moveSpeed: 5.5, dashCharges: 1,
    primary: [
      { ...base, id: 'mage_bolt', shape: 'projectile', anim: 'primary1', cooldown: 0.34, windup: 0.08, lock: 0.2, moveMul: 0.6, damage: 16, range: 16, arc: 0, radius: 0.4, speed: 22, projectile: 'arcBolt' },
    ],
    secondary: { ...base, id: 'mage_nova', shape: 'circle', anim: 'secondary', cooldown: 6, windup: 0.55, lock: 0.4, moveMul: 0.3, damage: 44, range: 11, radius: 3.4, knockback: 2.5 },
  },
  rogue: {
    id: 'rogue', maxHp: 90, moveSpeed: 6.1, dashCharges: 2,
    primary: [
      { ...base, id: 'rogue_bolt', shape: 'projectile', anim: 'primary1', cooldown: 0.23, windup: 0.05, lock: 0.12, moveMul: 0.7, damage: 10, range: 18, arc: 0, radius: 0.3, speed: 30, pierce: 1, projectile: 'crossbowBolt' },
    ],
    secondary: { ...base, id: 'rogue_fan', shape: 'projectile', anim: 'secondary', cooldown: 5, windup: 0.1, lock: 0.25, moveMul: 0.5, damage: 12, range: 9, arc: 50, radius: 0.3, speed: 24, count: 5, projectile: 'knife' },
  },
};
