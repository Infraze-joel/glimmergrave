/** Shared domain types. Ordered `as const` arrays define the numeric wire codes (index = code). */

export const CLASS_IDS = ['knight', 'barbarian', 'mage', 'rogue'] as const;
export type ClassId = (typeof CLASS_IDS)[number];

export const ELEMENT_IDS = ['ember', 'rime', 'storm'] as const;
export type ElementId = (typeof ELEMENT_IDS)[number];

export const ENEMY_KINDS = ['minion', 'warrior', 'archer', 'mage', 'champion', 'regent'] as const;
export type EnemyKind = (typeof ENEMY_KINDS)[number];

export const PROJECTILE_KINDS = [
  'arcBolt', // mage primary
  'crossbowBolt', // rogue primary
  'knife', // rogue secondary
  'boneArrow', // skeleton archer
  'hexOrb', // skeleton mage / regent volley
] as const;
export type ProjectileKind = (typeof PROJECTILE_KINDS)[number];

export const PLAYER_ANIMS = [
  'idle', 'run', 'primary1', 'primary2', 'primary3', 'secondary', 'dash', 'hit', 'downed', 'cheer',
] as const;
export type PlayerAnim = (typeof PLAYER_ANIMS)[number];

export const ENEMY_ANIMS = [
  'spawn', 'idle', 'move', 'windup', 'attack', 'cast', 'stun', 'death',
  // boss / champion specials
  'sweep', 'charge', 'volley', 'summon', 'slam',
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
  kind: 'pillar' | 'column' | 'barrels' | 'crates' | 'rubble' | 'brazier';
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
  w: number;
  d: number;
  obstacles: Obstacle[];
  /** Player spawn points (one per slot), near the south wall (+Z). */
  spawns: { x: number; z: number }[];
}

export interface BoonStack {
  id: string;
  level: number;
}

export interface RosterEntry {
  slot: number;
  name: string;
  cls: ClassId;
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
  | { e: 'doorChosen'; type: DoorType };
