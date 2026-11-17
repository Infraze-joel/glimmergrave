/** Internal, mutable simulation state. Only the contract types in ../types.ts ever leave the sim. */
import type { AbilityDef, ClassDef } from '../data/classes.ts';
import type { EnemyDef } from '../data/enemies.ts';
import type { Mods } from '../data/mods.ts';
import type { ReactionId } from '../data/reactions.ts';
import type {
  AbilitySlot, AffixId, BoonOffer, BoonStack, ClassId, ElementId, EnemyAnim, EnemyKind, InputCmd, PlayerAnim,
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
  // update 3
  momentum: number;
  giantSlayer: number;
  overkill: number;
  firstBlood: number;
  brutality: number;
  thorns: number;
  mending: number;
  crystalWard: number;
  slipstream: number;
  afterimage: number;
  catalyst: number;
  chainReaction: boolean;
  crescendo: number;
  encore: number;
  openingAct: number;
  covenant: number;
  rally: number;
  creepingDark: number;
  /** Duo boons: burst damage bonus per reaction (0 = not owned). */
  duo: Record<ReactionId, number>;
  /** Passive bonuses of boons that are plain Mods (stoneskin, zealot, any boon with `mods`). */
  mods: Mods;
  infusion: Record<AbilitySlot, Infusion | null>;
}

/** What a hero brings into a run besides the look: sanitised Loadout fields (see sim/build.ts). */
export interface HeroBuild {
  meta: number[];
  paragon: number[];
  mastery: number;
  art: number;
  talents: number[];
  relics: { id: string; rank: number }[];
}

/** The hero's abilities after class boons and the `area` mod. Rebuilt whenever boons or mods change. */
export interface HeroAbilities {
  primary: AbilityDef[];
  secondary: AbilityDef;
  ultimate: AbilityDef;
}

/** Talent specials (data/mastery.ts) the hero has chosen. */
export interface TalentFlags {
  riposte: boolean;
  rampage: boolean;
  arcaneEcho: boolean;
  poisonTips: boolean;
  martyr: boolean;
  spellweave: boolean;
  ambush: boolean;
}

/** Relic specials (data/relics.ts): 0 = not equipped, else rankScale(rank). */
export interface RelicFlags {
  emberHeart: number;
  frostCore: number;
  stormCoil: number;
  voidLantern: number;
  phoenix: number;
  bell: number;
  hourglass: number;
  compass: number;
}

/** Remaining seconds of the timed hero effects (BUFFS in data/classes.ts). */
export interface BuffTimes {
  bloodrage: number;
  bulwark: number;
  overload: number;
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
  /** Extra draft choices (foresight). */
  foresight: number;
  /** One more solo Second Wind; revived faster in a party. */
  tenacity: boolean;
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
  /** Leap: the flight (a dash towards tx / tz) has started. */
  launched?: boolean;
  /** Arcane Echo: this is the repeated volley (it does not count towards the next echo). */
  echo?: boolean;
}

export interface SpinState {
  def: AbilityDef;
  slot: AbilitySlot;
  pulsesLeft: number;
  timer: number;
}

export interface LungeState {
  def: AbilityDef;
  slot: AbilitySlot;
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
  pressUltimate: number;

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
  /** In the air (leap): the dash that carries the hero strikes nothing on its way. */
  flight: boolean;
  /** Seconds of invulnerability left (dash, post-hit, revive, last stand). */
  invuln: number;
  /** Ultimate charge 0..ULTIMATE.MAX. Kept between chambers. */
  ult: number;
  buffs: BuffTimes;
  /** Seconds enemies near this hero are forced to target it (own bulwark banner). */
  taunt: number;
  /** Overload: elements applied in turn by every hit, and the next index. */
  overloadEls: ElementId[];
  overloadIndex: number;

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
  /** Sanitised loadout (upgrades, Ascension, mastery, art, talents, relics). */
  build: HeroBuild;
  /** Sum of all permanent sources (uncapped) and the capped total incl. set bonuses and boon mods. */
  perm: Mods;
  mods: Mods;
  abil: HeroAbilities;
  talent: TalentFlags;
  relic: RelicFlags;
  /** Active tier per set (aligned with SETS) and the set specials that are switched on. */
  setTiers: number[];
  setSpread: ElementId[];
  setOverflow: boolean;
  setBond: boolean;
  momentum: number;
  momentumTime: number;
  rampage: number;
  rampageTime: number;
  riposte: boolean;
  spellweave: boolean;
  echoCount: number;
  /** Hits since the last storm coil strike. */
  coilHits: number;
  phoenixUsed: boolean;
  slipstreamTime: number;
  /** Seconds spent downed inside a sanctuary. */
  sanctuary: number;
  /** Relic shards found so far this run. */
  shards: string[];
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
  // update 3
  affix: AffixId | null;
  /** `armored` affix: guard still up. */
  armored: boolean;
  /** Death Mark: seconds left and the slot that marked. */
  markTime: number;
  markBy: number;
  /** Sunder (Superconduct): extra damage taken and seconds left. */
  sunder: number;
  sunderTime: number;
  /** Cannot move (Entomb). */
  rootTime: number;
  /** Generic slow (bell relic): fraction and seconds left. */
  slow: number;
  slowTime: number;
  /** Seconds the smoke bomb's slow / weaken still applies (refreshed while inside). */
  smokeTime: number;
  /** Strength of the current status (1 + elementPotency of the applier). */
  statusPower: number;
  /** Extra outgoing-damage cut while the current status lasts (frost core). */
  statusWeaken: number;
  /** Bit per hero slot that has already struck this enemy (ambush talent). */
  struckBy: number;
}

/** A lasting ground effect of a hero ability (zone / trap shapes). */
export interface Zone {
  id: number;
  def: AbilityDef;
  owner: number;
  slot: AbilitySlot;
  x: number;
  z: number;
  r: number;
  /** Seconds left. */
  time: number;
  /** Seconds to the next pulse. */
  timer: number;
  /** Traps: seconds until armed. */
  arm: number;
  dead: boolean;
}

/** A delayed hostile explosion (volatile affix). */
export interface PendingBlast {
  x: number;
  z: number;
  r: number;
  t: number;
  damage: number;
  by: number;
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
  /** Hero projectiles: only this enemy id can be hit (-1 = anything). */
  only: number;
  /** Hero projectiles: damage multiplier bonus decided at release (spellweave). */
  bonus: number;
}

export const emptyInput = (): InputCmd => ({ seq: 0, moveX: 0, moveZ: 0, aim: 0, aimDist: 0, buttons: 0 });

export type { AbilityDef, ClassDef, EnemyDef, EnemyKind };
