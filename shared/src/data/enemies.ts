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
 *  regent   – boss, 3 phases: sweep, charge, radial hex volley, summon, grave slam
 *  matron   – caster boss (sim/matron.ts), 3 phases: orb rings and spirals, rotating beams, blast patterns,
 *             homing soul wisps, blink, summons
 *  shaman   – support caster: keeps behind the horde and mends wounded enemies near it with a telegraphed
 *             channel (stun, stagger or kill it to stop the heal); weak hex bolt when nobody needs mending
 *  aegis    – shield bearer: raises a ward dome; other enemies inside take far less damage. The dome drops
 *             while the aegis is stunned, staggered or dead. Slow, sturdy, weak melee
 *  bomber   – runs at a hero, stops and bursts after a short telegraphed fuse (hurts enemies too); also
 *             bursts when slain, so kill it from range or dash out
 *  necromancer – keeps away and raises minions at intervals, up to a cap; its minions crumble when it dies
 *  reaver   – leaps onto the hero furthest from the fight (telegraphed landing circle), then quick melee;
 *             fragile
 *  stalker  – mobile ranged boss (sim/stalker.ts), 3 phases: arrow fans, piercing bone spear, leap, traps, frenzy
 */
export const ENEMIES: Record<EnemyKind, EnemyDef> = {
  minion: { kind: 'minion', hp: 40, speed: 4.4, radius: 0.4, scale: 0.85, damage: 9, attackRange: 1.5, windup: 0.42, cooldown: 1.1, spawnTime: 0.9, cost: 1, minChamber: 0, poise: 1 },
  warrior: { kind: 'warrior', hp: 126, speed: 3.0, radius: 0.5, scale: 1.05, damage: 18, attackRange: 2.2, windup: 0.65, cooldown: 1.8, spawnTime: 1.1, cost: 3, minChamber: 1, poise: 30 },
  archer: { kind: 'archer', hp: 57, speed: 3.4, radius: 0.42, scale: 0.95, damage: 12, attackRange: 13, windup: 0.75, cooldown: 2.3, spawnTime: 0.9, cost: 2, minChamber: 0, poise: 1 },
  mage: { kind: 'mage', hp: 81, speed: 2.8, radius: 0.42, scale: 1.0, damage: 20, attackRange: 12, windup: 1.1, cooldown: 3.2, spawnTime: 1.0, cost: 3, minChamber: 2, poise: 15 },
  champion: { kind: 'champion', hp: 900, speed: 3.6, radius: 0.8, scale: 1.55, damage: 28, attackRange: 3.4, windup: 0.8, cooldown: 1.6, spawnTime: 1.6, cost: 0, minChamber: 0, poise: 0 },
  regent: { kind: 'regent', hp: 2300, speed: 3.3, radius: 1.1, scale: 2.2, damage: 31, attackRange: 4.4, windup: 0.9, cooldown: 1.5, spawnTime: 2.4, cost: 0, minChamber: 0, poise: 0 },
  // attackRange of the two ranged bosses = the distance they try to keep; damage = their basic projectile.
  matron: { kind: 'matron', hp: 2200, speed: 2.7, radius: 0.9, scale: 1.9, damage: 14, attackRange: 9, windup: 0.9, cooldown: 1.5, spawnTime: 2.4, cost: 0, minChamber: 0, poise: 0 },
  shaman: { kind: 'shaman', hp: 70, speed: 3.0, radius: 0.42, scale: 1.0, damage: 10, attackRange: 11, windup: 0.9, cooldown: 2.8, spawnTime: 1.0, cost: 4, minChamber: 2, poise: 12 },
  aegis: { kind: 'aegis', hp: 170, speed: 2.6, radius: 0.55, scale: 1.15, damage: 14, attackRange: 2.2, windup: 0.75, cooldown: 2.2, spawnTime: 1.2, cost: 5, minChamber: 3, poise: 35 },
  bomber: { kind: 'bomber', hp: 34, speed: 5.2, radius: 0.4, scale: 0.9, damage: 26, attackRange: 1.8, windup: 0.8, cooldown: 0, spawnTime: 0.8, cost: 2, minChamber: 1, poise: 0 },
  necromancer: { kind: 'necromancer', hp: 95, speed: 2.8, radius: 0.42, scale: 1.05, damage: 0, attackRange: 12, windup: 1.3, cooldown: 7, spawnTime: 1.1, cost: 5, minChamber: 4, poise: 18 },
  reaver: { kind: 'reaver', hp: 62, speed: 4.6, radius: 0.42, scale: 1.0, damage: 15, attackRange: 1.7, windup: 0.4, cooldown: 1.0, spawnTime: 0.9, cost: 3, minChamber: 2, poise: 5 },
  stalker: { kind: 'stalker', hp: 2500, speed: 3.9, radius: 0.85, scale: 1.8, damage: 15, attackRange: 10, windup: 0.85, cooldown: 1.4, spawnTime: 2.2, cost: 0, minChamber: 0, poise: 0 },
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
  CHAMPION: { SWEEP_ARC_DEG: 160, SWEEP_REACH: 3.8, CHARGE_LENGTH: 10, CHARGE_WIDTH: 2.2, CHARGE_WINDUP: 0.9, CHARGE_SPEED: 20, CHARGE_DAMAGE: 32, SUMMON_EVERY: 14, SUMMON_COUNT: 3 },
  REGENT: {
    PHASE_THRESHOLDS: [0.66, 0.33],
    SWEEP_ARC_DEG: 180, SWEEP_REACH: 4.8,
    CHARGE_LENGTH: 14, CHARGE_WIDTH: 2.8, CHARGE_WINDUP: 1.0, CHARGE_SPEED: 24, CHARGE_DAMAGE: 35,
    VOLLEY_ORBS: 16, VOLLEY_WAVES: 2, VOLLEY_SPEED: 9, VOLLEY_DAMAGE: 16, VOLLEY_WINDUP: 0.9,
    SUMMON_COUNT: 4, SUMMON_COOLDOWN: 16,
    SLAM_RADIUS: 2.8, SLAM_WINDUP: 1.0, SLAM_REPEATS: 3, SLAM_INTERVAL: 0.6, SLAM_DAMAGE: 26,
  },
  /**
   * The Hex Matron. Arrays with three entries are indexed by phase - 1.
   *  ring   – RING_ORBS hex orbs in a circle, RING_WAVES rings half a step apart
   *  spiral – SPIRAL_ARMS orbs every SPIRAL_INTERVAL, turning SPIRAL_TURN_DEG per step (phase 2+)
   *  beam   – BEAM_RAYS rays from the Matron, re-announced BEAM_STEPS times, each step turned by BEAM_TURN_DEG
   *  blasts – a lattice of circles (spacing BLAST_SPACING) around the target; phase 3 adds a second, shifted wave
   *  wisp   – slow homing orbs that can be destroyed by any hero attack or outrun
   */
  MATRON: {
    PHASE_THRESHOLDS: [0.66, 0.33],
    BLINK_DISTANCE: 9, BLINK_COOLDOWN: 7, BLINK_TRIGGER: 3.6,
    RING_ORBS: 12, RING_WAVES: [1, 2, 2], RING_SPEED: 8, RING_WINDUP: 0.9, RING_DAMAGE: 16,
    SPIRAL_ARMS: 3, SPIRAL_STEPS: 12, SPIRAL_INTERVAL: 0.15, SPIRAL_TURN_DEG: 14, SPIRAL_SPEED: 7.5, SPIRAL_WINDUP: 0.8, SPIRAL_DAMAGE: 14,
    BEAM_RAYS: [2, 3, 4], BEAM_STEPS: [2, 3, 4], BEAM_WINDUP: 1.0, BEAM_INTERVAL: 0.75, BEAM_TURN_DEG: 22, BEAM_WIDTH: 1.6, BEAM_LENGTH: 30, BEAM_DAMAGE: 30,
    BLAST_RADIUS: 2.3, BLAST_SPACING: 6.2, BLAST_WINDUP: 1.15, BLAST_DAMAGE: 28, BLAST_WAVES: [1, 1, 2], BLAST_WAVE_INTERVAL: 0.8,
    WISP_COUNT: [1, 2, 3], WISP_MAX: 5, WISP_SPEED: 4.1, WISP_TURN_DEG: 110, WISP_LIFETIME: 9, WISP_RADIUS: 0.45, WISP_WINDUP: 0.8, WISP_DAMAGE: 24,
    SUMMON_MAGES: 1, SUMMON_MINIONS: 2, SUMMON_COOLDOWN: 18,
  },
  /**
   * The Ossuary Stalker. Arrays with three entries are indexed by phase - 1.
   *  fan    – FAN_ARROWS bone arrows spread over FAN_SPREAD_DEG, one line telegraph each
   *  spear  – one heavy boneSpear that passes through every hero in its line
   *  leap   – jumps to a new spot (away from a hero who closed in, or onto a distant one); the landing circle hurts
   *  trap   – caltrop circles that arm after TRAP_ARM and then pulse TRAP_PULSES times, TRAP_INTERVAL apart
   *  frenzy – phase 3: FRENZY_SHOTS quick aimed arrows, FRENZY_INTERVAL apart, then a long recovery
   */
  STALKER: {
    PHASE_THRESHOLDS: [0.66, 0.33],
    FAN_ARROWS: [3, 5, 7], FAN_SPREAD_DEG: [26, 44, 60], FAN_WINDUP: 0.85, FAN_SPEED: 16, FAN_DAMAGE: 18,
    SPEAR_WINDUP: 1.1, SPEAR_SPEED: 30, SPEAR_WIDTH: 1.3, SPEAR_RADIUS: 0.55, SPEAR_DAMAGE: 40,
    LEAP_AIR_TIME: 0.95, LEAP_RADIUS: 3, LEAP_DAMAGE: 32, LEAP_DISTANCE: 10, LEAP_TRIGGER: 3.6,
    TRAP_COUNT: [2, 3, 4], TRAP_RADIUS: 1.8, TRAP_ARM: 1.0, TRAP_PULSES: 4, TRAP_INTERVAL: 0.8, TRAP_DAMAGE: 16,
    FRENZY_SHOTS: 6, FRENZY_INTERVAL: 0.45, FRENZY_WINDUP: 0.55, FRENZY_DAMAGE: 15,
  },
  SHAMAN: { KEEP_DISTANCE: 9, MEND_RADIUS: 6, MEND_FRACTION: 0.3, MEND_WINDUP: 1.4, MEND_COOLDOWN: 6, MEND_BELOW: 0.75, BOLT_SPEED: 11 },
  AEGIS: { DOME_RADIUS: 4.5, DOME_REDUCTION: 0.6, DOME_REARM_SECONDS: 3 },
  BOMBER: { BLAST_RADIUS: 2.6, DEATH_BLAST_DELAY: 0.6, ENEMY_DAMAGE_MUL: 1.5 },
  NECROMANCER: { KEEP_DISTANCE: 10, RAISE_COUNT: 2, MAX_RAISED: 6 },
  REAVER: { LEAP_MIN_DISTANCE: 6, LEAP_MAX_DISTANCE: 14, LEAP_AIR_TIME: 0.8, LEAP_RADIUS: 1.8, LEAP_DAMAGE: 18, LEAP_COOLDOWN: 7 },
  /**
   * Warded enemies (spawn.ward): from WARD_FROM_CHAMBER on, a share of the rank and file is immune to one
   * element's status and bursts, so a one-element build has to adapt. Never the only enemies of a wave.
   */
  WARD: { FROM_CHAMBER: 4, SHARE: 0.2, SHARE_PER_DEPTH: 0.08, MAX_SHARE: 0.45 },
  /** The herald (second elite chamber): a boss that is not this run's final boss, locked to phase 1. */
  HERALD: { HP_FRACTION: 0.45 },
  /**
   * Bosses and the champion gain this much health per additional hero instead of RUN.HP_PER_EXTRA_PLAYER
   * (a party focuses all its damage on them, so they need more than the rank and file to last as long).
   */
  BOSS_HP_PER_EXTRA_PLAYER: 1.3,
} as const;

/**
 * Floor hazards (see Hazard in types.ts; timing in sim/hazards.ts). While a hazard is active it strikes everything
 * standing on it every TICK seconds (keep TICK a multiple of the simulation tick), starting the moment it turns
 * active: ceil(active time / TICK) strikes per activation. Heroes take DAMAGE (dash and other
 * i-frames avoid it); enemies take DAMAGE * ENEMY_DAMAGE_MUL * the chamber's health scaling, so luring stays
 * worthwhile in late chambers. Bosses and champions are immune.
 *  vent  – also sets heroes ablaze (BURN_DPS for BURN_SECONDS) and applies Burn to enemies
 *  frost – also slows heroes by SLOW for CHILL_SECONDS and applies Chill to enemies
 */
export const HAZARD = {
  SPIKES: { DAMAGE: 14, TICK: 0.5 },
  VENT: { DAMAGE: 9, TICK: 0.4, BURN_DPS: 4, BURN_SECONDS: 2, BURN_TICK: 0.5 },
  FROST: { DAMAGE: 3, TICK: 0.6, SLOW: 0.35, CHILL_SECONDS: 1.5 },
  ENEMY_DAMAGE_MUL: 1.6,
} as const;

export const STATUS = {
  /** Burn: damage per second for DURATION, scaled by infusion potency. */
  BURN: { DPS: 5, DURATION: 3 },
  /** Chill: movement and attack slow. */
  CHILL: { SLOW: 0.35, DURATION: 3 },
  /** Shock: the target takes extra damage from all sources. */
  SHOCK: { VULNERABILITY: 0.2, DURATION: 4 },
  /** Wither (umbra): the target deals less damage and every hit on it heals the attacker a little. */
  WITHER: { WEAKEN: 0.2, LEECH: 1, DURATION: 4 },
  /**
   * Resonance: hitting an enemy that carries status A with element B (B != A) consumes A and bursts.
   * The burst damages all enemies within RADIUS and applies B to them.
   */
  RESONANCE: { DAMAGE: 30, RADIUS: 3, INTERNAL_COOLDOWN: 0.35 },
  CRIT_MULTIPLIER: 2,
} as const;
