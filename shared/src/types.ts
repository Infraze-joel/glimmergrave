/** Shared domain types. Ordered `as const` arrays define the numeric wire codes (index = code). */

export const CLASS_IDS = ['knight', 'barbarian', 'mage', 'rogue'] as const;
export type ClassId = (typeof CLASS_IDS)[number];

export const ELEMENT_IDS = ['ember', 'rime', 'storm'] as const;
export type ElementId = (typeof ELEMENT_IDS)[number];

/** Append only (wire codes). matron and stalker are bosses, like regent. */
export const ENEMY_KINDS = ['minion', 'warrior', 'archer', 'mage', 'champion', 'regent', 'matron', 'stalker'] as const;
export type EnemyKind = (typeof ENEMY_KINDS)[number];

/** The final boss of a run is drawn from this pool (seeded), so consecutive runs end differently. */
export const BOSS_KINDS = ['regent', 'matron', 'stalker'] as const;
export type BossKind = (typeof BOSS_KINDS)[number];

export const BIOME_IDS = ['crypt', 'flooded', 'forge'] as const;
/**
 * crypt   – torch-lit stone halls (the original look)
 * flooded – drowned catacombs: teal light, shallow water, frost hazards
 * forge   – the ember foundry below: red glow, vents that erupt in fire
 */
export type BiomeId = (typeof BIOME_IDS)[number];

export const PROJECTILE_KINDS = [
  'arcBolt', // mage primary
  'crossbowBolt', // rogue primary
  'knife', // rogue secondary
  'boneArrow', // skeleton archer
  'hexOrb', // skeleton mage / regent volley
  'boneSpear', // stalker heavy shot
  'soulWisp', // matron slow homing orb
] as const;
export type ProjectileKind = (typeof PROJECTILE_KINDS)[number];

export const PLAYER_ANIMS = [
  'idle', 'run', 'primary1', 'primary2', 'primary3', 'secondary', 'dash', 'hit', 'downed', 'cheer',
] as const;
export type PlayerAnim = (typeof PLAYER_ANIMS)[number];

export const ENEMY_ANIMS = [
  'spawn', 'idle', 'move', 'windup', 'attack', 'cast', 'stun', 'death',
  // boss / champion specials (append only)
  'sweep', 'charge', 'volley', 'summon', 'slam', 'beam', 'leap',
] as const;
export type EnemyAnim = (typeof ENEMY_ANIMS)[number];

export const PLAYER_STATES = ['alive', 'downed', 'dead'] as const;
export type PlayerState = (typeof PLAYER_STATES)[number];

export type AbilitySlot = 'primary' | 'secondary' | 'dash';

/** Bit flags in PlayerSnap.flags */
export const PF = {
  CONNECTED: 1,
  INVULNERABLE: 2,
  BEING_REVIVED: 4,
  IN_DOOR_ZONE: 8,
  KINDRED_AURA: 16,
} as const;

/** Bit flags in EnemySnap.flags */
export const EF = {
  ELITE: 1,
  BURN: 2,
  CHILL: 4,
  SHOCK: 8,
  STUNNED: 16,
  SHIELDED: 32,
  ENRAGED: 64,
} as const;

/** Bit flags in InputCmd.buttons */
export const BTN = {
  PRIMARY: 1,
  SECONDARY: 2,
  DASH: 4,
  INTERACT: 8,
} as const;

/** One sampled input frame. `seq` increases by one per frame per client. */
export interface InputCmd {
  seq: number;
  /** Desired move direction in world space, each -1..1 (need not be normalised). */
  moveX: number;
  moveZ: number;
  /** Aim angle in radians: atan2(aimDirX, aimDirZ); 0 faces +Z. */
  aim: number;
  /** Distance of the cursor from the player in metres (0..25), used by ground-targeted abilities. */
  aimDist: number;
  buttons: number;
}

export interface PlayerSnap {
  slot: number;
  x: number;
  z: number;
  /** Facing, radians, same convention as InputCmd.aim. */
  rot: number;
  hp: number;
  maxHp: number;
  shield: number;
  state: PlayerState;
  anim: PlayerAnim;
  /** Incremented every time an action animation (re)starts, so clients can retrigger identical clips. */
  animSeq: number;
  /** Remaining cooldown fraction 0..1 (0 = ready). */
  cdSecondary: number;
  cdDash: number;
  dashCharges: number;
  /** 0..1 revive progress while downed. */
  revive: number;
  flags: number;
}

export interface EnemySnap {
  id: number;
  kind: EnemyKind;
  x: number;
  z: number;
  rot: number;
  /** Health fraction 0..1. */
  hp: number;
  anim: EnemyAnim;
  animSeq: number;
  flags: number;
}

export interface ProjectileSnap {
  id: number;
  kind: ProjectileKind;
  x: number;
  z: number;
  rot: number;
  /** 0 = neutral, 1..3 = ELEMENT_IDS index + 1 (tints the projectile). */
  element: number;
  hostile: boolean;
}

/** Authoritative movement state of the receiving client's own hero, used for prediction + reconciliation. */
export interface SelfState {
  /** Sequence number of the last input the server has simulated for this client. */
  ackSeq: number;
  x: number;
  z: number;
  /** Seconds left in the current dash (0 = not dashing). */
  dashTime: number;
  dashDirX: number;
  dashDirZ: number;
  /** Seconds the hero is rooted by an ability animation or stun (cannot move). */
  rootTime: number;
  /** Current total move speed in m/s after boons, slows and ability move multipliers. */
  moveSpeed: number;
}

export interface Snapshot {
  tick: number;
  self: SelfState;
  players: PlayerSnap[];
  enemies: EnemySnap[];
  projectiles: ProjectileSnap[];
}

export interface Obstacle {
  x: number;
  z: number;
  /** Collision radius in metres. */
  r: number;
  /** Visual hint for the client. */
  kind: 'pillar' | 'column' | 'barrels' | 'crates' | 'rubble' | 'brazier' | 'sarcophagus' | 'stalagmite' | 'anvil' | 'crystal';
}

/**
 * A floor hazard that cycles forever: idle -> warn -> active. Its state is a pure function of the server tick
 * (see sim/hazards.ts), so clients animate it from the layout alone and the server applies the effect.
 *  spikes – damage while active
 *  vent   – fire burst: damage and Burn while active
 *  frost  – freezing mist: Chill (slow) while active, minor damage
 * Hazards hurt heroes AND enemies, so luring foes into them is a tactic.
 */
export interface Hazard {
  x: number;
  z: number;
  r: number;
  kind: 'spikes' | 'vent' | 'frost';
  /** Full cycle length in seconds. */
  period: number;
  /** Offset into the cycle, 0..1, so hazards in one room do not all fire together. */
  phase: number;
}

export const DOOR_TYPES = ['boon', 'blessing', 'cursed', 'boss'] as const;
/**
 * What the NEXT chamber grants once cleared:
 *  boon     – standard draft (1 of 3)
 *  blessing – heals the party 35 % and a standard draft
 *  cursed   – enemies in that chamber are empowered; draft has 4 choices and guarantees a rare or better
 *  boss     – leads to the Bone Regent
 */
export type DoorType = (typeof DOOR_TYPES)[number];

export interface Door {
  x: number;
  z: number;
  type: DoorType;
}

/** Rectangular arena centred on the origin: x in [-w/2, w/2], z in [-d/2, d/2]. */
export interface RoomLayout {
  /** Deterministic seed for client-side decoration (props, floor variation). */
  seed: number;
  biome: BiomeId;
  w: number;
  d: number;
  obstacles: Obstacle[];
  hazards: Hazard[];
  /** Player spawn points (one per slot), near the south wall (+Z). */
  spawns: { x: number; z: number }[];
}

export interface BoonStack {
  id: string;
  level: number;
}

/** Cosmetic appearance of a hero. Purely visual; validated and clamped by the server. */
export interface Look {
  /** Index into LOOK.COLORS (cloth / cape tint). */
  color: number;
  /** Show the helmet / hat. */
  head: boolean;
  cape: boolean;
  /** Class-specific gear variant 0..LOOK.STYLES-1 (e.g. knight shield shape, mage wand vs staff). */
  style: number;
}

/** What a client brings into a session: its look and its permanent upgrade levels (see data/meta.ts). */
export interface Loadout {
  look: Look;
  /** Levels aligned with META_UPGRADES (index = upgrade). Missing entries count as 0. */
  meta: number[];
}

export interface RosterEntry {
  slot: number;
  name: string;
  cls: ClassId;
  look: Look;
  ready: boolean;
  connected: boolean;
  host: boolean;
  boons: BoonStack[];
}

export const RUN_PHASES = ['lobby', 'combat', 'draft', 'doors', 'victory', 'defeat'] as const;
/**
 * lobby   – waiting for the host to start
 * combat  – waves are active
 * draft   – chamber cleared, every player picks a boon
 * doors   – exits are open, party walks into a door zone to choose the next chamber
 * victory / defeat – run over, summary shown, host may return to lobby
 */
export type RunPhase = (typeof RUN_PHASES)[number];

export interface PlayerRunStats {
  slot: number;
  damage: number;
  kills: number;
  resonances: number;
  revives: number;
  downs: number;
}

export interface RunState {
  phase: RunPhase;
  oath: number;
  /** 0-based index of the current chamber; total = RUN.CHAMBERS.length. */
  chamber: number;
  chamberKind: 'combat' | 'elite' | 'boss';
  /** Door type that was chosen to enter this chamber (affects reward). */
  entered: DoorType;
  wave: number;
  waveCount: number;
  room: RoomLayout | null;
  /** Exits, only populated during the `doors` phase. */
  doors: Door[];
  /** 0..1 hold progress per door during the `doors` phase. */
  doorProgress: number[];
  /** Enemy id of the boss / champion for the boss bar, or -1. */
  bossId: number;
  /** Slots that still have to pick during `draft`. */
  draftPending: number[];
  /** Seconds left in the draft. */
  draftTime: number;
  elapsed: number;
  stats: PlayerRunStats[];
  secondWinds: number;
  /** Kind of the boss / champion fought in this chamber, or null in ordinary chambers. */
  bossKind: EnemyKind | null;
  /** The boss waiting at the end of this run (known from the start, shown on the chamber track). */
  finalBoss: BossKind;
  /** Glimmer earned per hero; filled in when the run ends (victory or defeat), empty before. */
  rewards: { slot: number; glimmer: number }[];
  /** Guided training session state, or null in a normal run. */
  tutorial: TutorialState | null;
}

export interface TutorialState {
  /** Current step id (see data/tutorial.ts). */
  step: string;
  index: number;
  total: number;
  /** 0..1 progress within the step where it makes sense (e.g. 2 of 3 dummies hit), else 0. */
  progress: number;
  /** Ground marker the player should walk to, if the step has one. */
  marker: { x: number; z: number; r: number } | null;
}

export interface BoonOffer {
  id: string;
  /** Level the boon would have after picking (1 = new). */
  level: number;
}

export type TargetRef = { t: 'p'; id: number } | { t: 'e'; id: number };

/** Transient, fire-and-forget gameplay events for VFX, SFX and UI. Never needed to reconstruct state. */
export type GameEvent =
  | { e: 'hit'; target: TargetRef; x: number; z: number; dmg: number; crit: boolean; el: ElementId | null; by: number }
  | { e: 'kill'; id: number; kind: EnemyKind; x: number; z: number; by: number }
  | { e: 'resonance'; x: number; z: number; r: number; a: ElementId; b: ElementId; by: number }
  | { e: 'status'; id: number; el: ElementId }
  | {
      e: 'telegraph';
      /** circle: r = radius. arc: r = reach, w = total angle in radians. line: r = length, w = width. */
      shape: 'circle' | 'arc' | 'line';
      x: number; z: number; rot: number; r: number; w: number;
      /** Seconds until the attack lands. */
      dur: number;
      /**
       * Id of the enemy that is winding up (additive, optional). If that enemy dies or is stunned / staggered
       * before `dur` has passed, the attack is cancelled and the telegraph can be removed early.
       */
      src?: number;
    }
  | { e: 'cast'; who: TargetRef; ability: string; x: number; z: number; rot: number }
  | { e: 'aoe'; x: number; z: number; r: number; el: ElementId | null; hostile: boolean }
  | { e: 'heal'; slot: number; amount: number }
  | { e: 'down'; slot: number }
  | { e: 'revived'; slot: number; by: number }
  | { e: 'shieldBreak'; id: number }
  | { e: 'spawn'; id: number; kind: EnemyKind; x: number; z: number; elite: boolean }
  | { e: 'wave'; wave: number; waveCount: number }
  | { e: 'chamberClear' }
  | { e: 'bossPhase'; phase: number }
  | { e: 'boon'; slot: number; id: string; level: number }
  | { e: 'doorChosen'; type: DoorType }
  | { e: 'tutorialStep'; step: string }
  | { e: 'hazardHit'; target: TargetRef; kind: Hazard['kind'] };
