/** Internal, mutable simulation state. Only the contract types in ../types.ts ever leave the sim. */
import type { AbilityDef, ClassDef } from '../data/classes.ts';
import type { EnemyDef } from '../data/enemies.ts';
import type {
  AbilitySlot, BoonOffer, BoonStack, ClassId, ElementId, EnemyAnim, EnemyKind, InputCmd, PlayerAnim,
  PlayerRunStats, PlayerState, ProjectileKind,
} from '../types.ts';
import type { MoveBody } from './movement.ts';

export interface Infusion {
  element: ElementId;
  potency: number;
}

/** Everything a hero's boons add up to. Recomputed whenever a boon is picked. */
export interface BoonStats {
  primaryDamage: number;
  secondaryDamage: number;
  /** Primary cooldown / windup / lock are divided by this (1 = unchanged). */
  attackSpeed: number;
  crit: number;
  execute: number;
  bonusHp: number;
  barrier: number;
  leech: number;
  lastStand: boolean;
  moveSpeed: number;
  dashRecharge: number;
  extraDash: number;
  secondaryCdr: number;
  wildfire: number;
  deepFrost: number;
  overcharge: number;
  amplifier: number;
  wideResonance: number;
  aftershock: number;
  echo: number;
  kindred: number;
  sharedVigor: number;
  lifeline: number;
  oathbond: number;
  infusion: Record<AbilitySlot, Infusion | null>;
}

/** Everything a hero's permanent upgrades add up to (see data/meta.ts). Zero / false = no upgrade. */
export interface MetaStats {
  /** Flat maximum health. */
  hp: number;
  /** Fraction added to all damage the hero deals. */
  might: number;
  moveSpeed: number;
  /** Secondary / dash recharge rate bonus (cooldown is divided by 1 + value). */
  secondaryHaste: number;
  dashHaste: number;
  /** Draft rerolls per run. */
  rerolls: number;
  attunement: boolean;
  /** Extra health fraction when revived; > 0 also grants META.RESOLVE_INVULNERABILITY. */
  resolve: number;
  fortune: number;
}

export interface PendingHit {
  def: AbilityDef;
  slot: AbilitySlot;
  /** Seconds until release. */
  t: number;
  aim: number;
  /** Ground target (circle abilities). */
  tx: number;
  tz: number;
}

export interface SpinState {
  def: AbilityDef;
  pulsesLeft: number;
  timer: number;
}

export interface LungeState {
  def: AbilityDef;
  hit: Set<number>;
}

export interface Hero {
  slot: number;
  name: string;
  cls: ClassId;
  def: ClassDef;
  connected: boolean;
  body: MoveBody;
  rot: number;
  hp: number;
  maxHp: number;
  /** Rechargeable shield from the `barrier` boon. */
  barrier: number;
  barrierDelay: number;
  /** Temporary shield from abilities. */
  tempShield: number;
  tempShieldTime: number;
  state: PlayerState;
  anim: PlayerAnim;
  animSeq: number;
  /** Seconds the current action animation still owns `anim`. */
  animTime: number;

  queue: InputCmd[];
  /** Last consumed input (reused when the queue runs dry). */
  input: InputCmd;
  ackSeq: number;
  prevButtons: number;
  pressPrimary: number;
  pressSecondary: number;
  pressDash: number;

  lockTime: number;
  lockMoveMul: number;
  comboIndex: number;
  comboTime: number;
  primaryCd: number;
  secondaryCd: number;
  secondaryCdMax: number;
  dashCharges: number;
  dashRecharge: number;
  /** Enemies already struck by the current infused dash. */
  dashHit: Set<number>;
  pending: PendingHit[];
  spin: SpinState | null;
  lunge: LungeState | null;
  /** Seconds of invulnerability left (dash, post-hit, revive, last stand). */
  invuln: number;

  boons: BoonStack[];
  stats: BoonStats;
  lastStandUsed: boolean;
  oathbondTime: number;
  oathbondArmed: boolean;
  /** Best kindred_flame bonus of any hero in range (including the hero's own). */
  aura: number;
  revive: number;
  secondWindTimer: number;
  draft: BoonOffer[];
  /** How the current draft was generated (needed to reroll it under the same rules). */
  draftOpts: DraftOptions | null;
  /** Draft rerolls left this run (insight upgrade). */
  rerolls: number;
  /** Sanitised permanent upgrade levels and what they add up to. */
  metaLevels: number[];
  meta: MetaStats;
  /** Hazard afflictions: seconds of burn left, time to the next burn tick, seconds of chill left. */
  burnTime: number;
  burnTimer: number;
  chillTime: number;
  inDoor: boolean;
  run: PlayerRunStats;
  /** Total incoming damage this run (before shields); balance telemetry only. */
  damageTaken: number;
}

export type AttackShape = 'arc' | 'circle' | 'line';

/** A wound-up enemy attack; resolves when `t` reaches 0. */
export interface EnemyAttack {
  type: 'melee' | 'shoot' | 'blast' | 'sweep' | 'charge' | 'volley' | 'summon' | 'slam'
    // matron
    | 'ring' | 'spiral' | 'beam' | 'blasts' | 'wisp'
    // stalker
    | 'fan' | 'spear' | 'leap' | 'trap' | 'frenzy';
  t: number;
  /** Shape origin / centre. */
  x: number;
  z: number;
  rot: number;
  /** circle: radius, arc: reach, line: length. */
  r: number;
  /** arc: total angle (rad), line: width. */
  w: number;
  damage: number;
  /** Target slot the attack was started against. */
  target: number;
  /** Traps: pulses still to come after the next one, and the seconds between pulses. */
  pulses?: number;
  interval?: number;
}

export interface DraftOptions {
  choices: number;
  /** Cursed chambers: at least one offer is rare or better. */
  guaranteeRare: boolean;
  /** First draft of a run: at least one offer is an infusion. */
  guaranteeInfusion: boolean;
  /** Attunement draft: infusions only. */
  infusionsOnly?: boolean;
}

export interface BossState {
  phase: number;
  /** Seconds until the next attack may start. */
  gap: number;
  chargeCd: number;
  volleyCd: number;
  summonCd: number;
  slamCd: number;
  /** Active charge: metres still to travel, heroes already struck. */
  chargeLeft: number;
  chargeLen: number;
  chargeFromX: number;
  chargeFromZ: number;
  chargeHit: number[];
  /** Follow-up volley waves / slam repeats still queued. */
  repeats: number;
  repeatTimer: number;
  /**
   * Announced ground attacks that land on their own schedule, in parallel to whatever the boss does next:
   * slam / blast circles, beam lines, trap circles (which re-announce themselves while they pulse) and queued shots.
   */
  slams: EnemyAttack[];
  /** Seconds spent chasing without attacking (anti-kiting). */
  chase: number;
  retarget: number;
  pendingPhase: number;
  /** Herald (second elite chamber): reduced health, locked to phase 1. */
  herald: boolean;
  /** Per-kind ability cooldowns (indices: MATRON_CD in matron.ts, STALKER_CD in stalker.ts). */
  cd: number[];
  /** A running sequence (beam steps, spiral shots, ring waves, blast waves, frenzy shots). */
  seqType: EnemyAttack['type'] | null;
  seqLeft: number;
  seqTimer: number;
  seqStep: number;
  seqAngle: number;
  seqDir: number;
  /** Rotates through the heroes for multi-target attacks. */
  cycle: number;
}

export interface Enemy {
  id: number;
  kind: EnemyKind;
  def: EnemyDef;
  x: number;
  z: number;
  rot: number;
  hp: number;
  maxHp: number;
  radius: number;
  elite: boolean;
  /** Final outgoing damage multiplier (chamber growth, oath, elite). */
  damageMul: number;
  speedMul: number;
  anim: EnemyAnim;
  animSeq: number;
  dead: boolean;
  corpseTime: number;
  spawnTime: number;
  stunTime: number;
  attackCd: number;
  recover: number;
  attack: EnemyAttack | null;
  /** Damage taken during the current windup. */
  poiseDamage: number;
  target: number;
  retarget: number;
  shieldHp: number;
  status: ElementId | null;
  statusTime: number;
  statusPotency: number;
  /** Slot that applied the status (credited for burn damage), -1 if gone. */
  statusBy: number;
  /** Applier's wildfire / deep_frost / overcharge value. */
  statusBonus: number;
  burnTimer: number;
  resonanceCd: number;
  /** Knockback displacement still to apply. */
  kbX: number;
  kbZ: number;
  blinkCd: number;
  strafeDir: number;
  strafeTime: number;
  boss: BossState | null;
  /** Summoned by a boss (does not count for wave pacing). */
  summoned: boolean;
  /** Training dummy: no AI at all (tutorial). */
  passive: boolean;
  /** Walks straight through hazards instead of around them (tutorial chaser). */
  reckless: boolean;
}

export interface Projectile {
  id: number;
  kind: ProjectileKind;
  x: number;
  z: number;
  dirX: number;
  dirZ: number;
  rot: number;
  speed: number;
  radius: number;
  /** Metres left before it fizzles. */
  range: number;
  damage: number;
  hostile: boolean;
  /** Hero slot (friendly) or enemy id (hostile). */
  owner: number;
  slot: AbilitySlot;
  pierce: number;
  hit: number[];
  /** 0 = neutral, else ELEMENT_IDS index + 1. */
  element: number;
  stun: number;
  knockback: number;
  dead: boolean;
  /** Homing turn rate in rad/s (0 = flies straight) towards the hero in `seek` (-1 = nearest). */
  homing: number;
  seek: number;
  /** Hostile projectiles with `fragile` are destroyed by any hero attack that touches them. */
  fragile: boolean;
}

export const emptyInput = (): InputCmd => ({ seq: 0, moveX: 0, moveZ: 0, aim: 0, aimDist: 0, buttons: 0 });

export type { AbilityDef, ClassDef, EnemyDef, EnemyKind };
