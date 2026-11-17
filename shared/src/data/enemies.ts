import type { EnemyKind } from '../types.ts';

export interface EnemyDef {
  kind: EnemyKind;
  hp: number;
  speed: number;
  /** Collision radius in metres. */
  radius: number;
  /** Visual scale hint for the client (1 = 1.8 m tall skeleton). */
  scale: number;
  /** Damage of the basic attack. */
  damage: number;
  /** Distance at which the basic attack is started. */
  attackRange: number;
  /** Telegraph duration before the basic attack lands (seconds). */
  windup: number;
  /** Seconds between basic attacks. */
  cooldown: number;
  /** Seconds the spawn animation plays; the enemy is harmless and invulnerable meanwhile. */
  spawnTime: number;
  /** Director cost when composing waves. 0 = never spawned by the wave director. */
  cost: number;
  /** First chamber index in which this kind may appear in waves. */
  minChamber: number;
  /** Damage needed to interrupt (stagger) the enemy's windup; 0 = cannot be staggered. */
  poise: number;
}

/**
 * Behaviour summary (implemented in sim/enemies.ts):
 *  minion   – fast swarm melee, short arc telegraph
 *  warrior  – slow, front shield absorbs SHIELD_HP damage until broken, wide arc swing
 *  archer   – keeps ARCHER_KEEP_DISTANCE, fires a telegraphed (line) bone arrow
 *  mage     – casts a telegraphed (circle) hex blast under a hero, blinks away when cornered
 *  champion – elite mini-boss: sweep (arc), charge (line), summons minions
 *  regent   – final boss, 3 phases: sweep, charge, radial hex volley, summon, grave slam
 */
export const ENEMIES: Record<EnemyKind, EnemyDef> = {
  minion: { kind: 'minion', hp: 28, speed: 4.4, radius: 0.4, scale: 0.85, damage: 8, attackRange: 1.5, windup: 0.42, cooldown: 1.1, spawnTime: 0.9, cost: 1, minChamber: 0, poise: 1 },
  warrior: { kind: 'warrior', hp: 85, speed: 3.0, radius: 0.5, scale: 1.05, damage: 16, attackRange: 2.2, windup: 0.65, cooldown: 1.8, spawnTime: 1.1, cost: 3, minChamber: 1, poise: 30 },
  archer: { kind: 'archer', hp: 40, speed: 3.4, radius: 0.42, scale: 0.95, damage: 10, attackRange: 13, windup: 0.75, cooldown: 2.3, spawnTime: 0.9, cost: 2, minChamber: 0, poise: 1 },
  mage: { kind: 'mage', hp: 55, speed: 2.8, radius: 0.42, scale: 1.0, damage: 18, attackRange: 12, windup: 1.1, cooldown: 3.2, spawnTime: 1.0, cost: 3, minChamber: 2, poise: 15 },
  champion: { kind: 'champion', hp: 520, speed: 3.6, radius: 0.8, scale: 1.55, damage: 24, attackRange: 3.4, windup: 0.8, cooldown: 1.6, spawnTime: 1.6, cost: 0, minChamber: 0, poise: 0 },
  regent: { kind: 'regent', hp: 1600, speed: 3.3, radius: 1.1, scale: 2.2, damage: 30, attackRange: 4.4, windup: 0.9, cooldown: 1.5, spawnTime: 2.4, cost: 0, minChamber: 0, poise: 0 },
};

export const ENEMY_TUNING = {
  WARRIOR_SHIELD_HP: 30,
  ARCHER_KEEP_DISTANCE: 8,
  ARROW_SPEED: 13,
  MAGE_BLAST_RADIUS: 2.4,
  MAGE_BLINK_DISTANCE: 6,
  MAGE_BLINK_COOLDOWN: 6,
  MINION_ARC_DEG: 90,
  WARRIOR_ARC_DEG: 110,
  /** Elite modifier (cursed chambers, elite chambers' escorts). */
  ELITE_HP_MUL: 1.8,
  ELITE_DAMAGE_MUL: 1.3,
  ELITE_SCALE_MUL: 1.2,
  CHAMPION: { SWEEP_ARC_DEG: 160, SWEEP_REACH: 3.8, CHARGE_LENGTH: 10, CHARGE_WIDTH: 2.2, CHARGE_WINDUP: 0.9, CHARGE_SPEED: 20, CHARGE_DAMAGE: 28, SUMMON_EVERY: 14, SUMMON_COUNT: 3 },
  REGENT: {
    PHASE_THRESHOLDS: [0.66, 0.33],
    SWEEP_ARC_DEG: 180, SWEEP_REACH: 4.8,
    CHARGE_LENGTH: 14, CHARGE_WIDTH: 2.8, CHARGE_WINDUP: 1.0, CHARGE_SPEED: 24, CHARGE_DAMAGE: 34,
    VOLLEY_ORBS: 16, VOLLEY_WAVES: 2, VOLLEY_SPEED: 9, VOLLEY_DAMAGE: 14, VOLLEY_WINDUP: 0.9,
    SUMMON_COUNT: 4, SUMMON_COOLDOWN: 16,
    SLAM_RADIUS: 2.8, SLAM_WINDUP: 1.0, SLAM_REPEATS: 3, SLAM_INTERVAL: 0.6, SLAM_DAMAGE: 26,
  },
} as const;

export const STATUS = {
  /** Burn: damage per second for DURATION, scaled by infusion potency. */
  BURN: { DPS: 5, DURATION: 3 },
  /** Chill: movement and attack slow. */
  CHILL: { SLOW: 0.35, DURATION: 3 },
  /** Shock: the target takes extra damage from all sources. */
  SHOCK: { VULNERABILITY: 0.2, DURATION: 4 },
  /**
   * Resonance: hitting an enemy that carries status A with element B (B != A) consumes A and bursts.
   * The burst damages all enemies within RADIUS and applies B to them.
   */
  RESONANCE: { DAMAGE: 30, RADIUS: 3, INTERNAL_COOLDOWN: 0.35 },
  CRIT_MULTIPLIER: 2,
} as const;
