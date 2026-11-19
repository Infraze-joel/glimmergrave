/** Shared domain types. Ordered `as const` arrays define the numeric wire codes (index = code). */

/** Append only (profiles store class ids). templar, spellblade and shade arrived with update 3. */
export const CLASS_IDS = ['knight', 'barbarian', 'mage', 'rogue', 'templar', 'spellblade', 'shade'] as const;
export type ClassId = (typeof CLASS_IDS)[number];

/** Append only (wire codes). umbra (status: Wither) arrived with update 3. */
export const ELEMENT_IDS = ['ember', 'rime', 'storm', 'umbra'] as const;
export type ElementId = (typeof ELEMENT_IDS)[number];

/** Append only (wire codes). matron and stalker are bosses, like regent. */
export const ENEMY_KINDS = [
  'minion', 'warrior', 'archer', 'mage', 'champion', 'regent', 'matron', 'stalker',
  // update 4 (append only): rank-and-file enemies that force a change of plan, see data/enemies.ts
  'shaman', 'aegis', 'bomber', 'necromancer', 'reaver',
] as const;
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
  'shieldDisc', // knight art: thrown shield
  'bladeWave', // spellblade combo finisher
  'shadowDagger', // shade ultimate follow-up / thrown daggers
] as const;
export type ProjectileKind = (typeof PROJECTILE_KINDS)[number];

export const PLAYER_ANIMS = [
  'idle', 'run', 'primary1', 'primary2', 'primary3', 'secondary', 'dash', 'hit', 'downed', 'cheer',
  // update 3 (append only): the alternative secondary ("art") and the ultimate
  'art', 'ultimate',
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

export type AbilitySlot = 'primary' | 'secondary' | 'dash' | 'ultimate';

/** Bit flags in PlayerSnap.flags */
export const PF = {
  CONNECTED: 1,
  INVULNERABLE: 2,
  BEING_REVIVED: 4,
  IN_DOOR_ZONE: 8,
  KINDRED_AURA: 16,
  /** Update 5: the hero is channelling the Arc Stream keystone (draw the stream along `rot`). */
  CHANNELING: 32,
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
  /** Umbra status: deals less damage, attackers leech health (see STATUS.WITHER). */
  WITHER: 128,
} as const;

/** Bit flags in InputCmd.buttons */
export const BTN = {
  PRIMARY: 1,
  SECONDARY: 2,
  DASH: 4,
  INTERACT: 8,
  /** Ultimate ability (needs a full charge, see ULTIMATE in data/classes.ts). */
  ULTIMATE: 16,
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
  /** Ultimate charge 0..1 (1 = ready). */
  ult: number;
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
  /** 0 = neutral, 1..4 = ELEMENT_IDS index + 1 (tints the projectile). */
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
  kind:
    | 'pillar' | 'column' | 'barrels' | 'crates' | 'rubble' | 'brazier' | 'sarcophagus' | 'stalagmite' | 'anvil' | 'crystal'
    /**
     * Objective fixtures (polish 1): the bell shard, a ritual brazier's bowl and the vault's reliquary block the
     * way like any obstacle. The simulation adds them to the room's obstacles when the chamber is set up, so
     * client prediction collides with them too. The view draws them from RunState.objective, NOT from this list.
     */
    | 'shard' | 'ritualBowl' | 'reliquary';
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

export const DOOR_TYPES = ['boon', 'blessing', 'cursed', 'boss', 'descend', 'ascend'] as const;
/**
 * What the NEXT chamber grants once cleared:
 *  boon     – standard draft (1 of 3)
 *  blessing – heals the party 35 % and a standard draft
 *  cursed   – enemies in that chamber are empowered; draft has 4 choices and guarantees a rare or better
 *  boss     – leads to the run's final boss
 *  descend  – only after a final boss: go one depth deeper (8 more chambers, everything scales, rewards grow)
 *  ascend   – only after a final boss: bank the run and end it as a victory
 */
export type DoorType = (typeof DOOR_TYPES)[number];

export const OBJECTIVE_KINDS = ['slay', 'survive', 'defend', 'hunt', 'ritual', 'vault'] as const;
/**
 * What a combat chamber asks of the party (data/objectives.ts has the numbers):
 *  slay    – clear every wave (the classic chamber)
 *  survive – enemies keep coming; hold out until the timer runs down, then the rest crumbles
 *  defend  – a bell shard stands in the room and part of the horde attacks it; clear the waves while it stands
 *  hunt    – marked elites must die before the timer runs out; afterwards they enrage
 *  ritual  – enemies keep coming until every brazier is lit by heroes standing in its circle
 *  vault   – no fight: a treasure chamber with a richer draft
 * Elite and boss chambers are always `slay`.
 */
export type ObjectiveKind = (typeof OBJECTIVE_KINDS)[number];

export interface Door {
  x: number;
  z: number;
  type: DoorType;
  /** Objective of the chamber behind this door (shown on the door so the party can choose). */
  objective: ObjectiveKind;
}

/** Live state of the current chamber's objective (RunState.objective). */
export interface ObjectiveState {
  kind: ObjectiveKind;
  /** 0..1 towards completion (time survived, waves cleared, targets slain, braziers lit). */
  progress: number;
  /** Seconds left on the objective's timer (survive, hunt, ritual bonus), else 0. */
  timeLeft: number;
  /** The bonus condition can still be met / was met (see OBJECTIVES[kind].bonus). False once it is lost. */
  bonus: boolean;
  /** `done` = objective complete, the chamber is ending. */
  status: 'active' | 'done';
  /** defend: the bell shard. `hp` is 0..1; at 0 it is shattered (bonus lost, the fight goes on). */
  anchor: { x: number; z: number; r: number; hp: number } | null;
  /** ritual: the braziers. `progress` 0..1; `lit` braziers stay lit. */
  sites: { x: number; z: number; r: number; progress: number; lit: boolean }[];
  /** hunt: enemy ids of the marked targets that are still alive. */
  targets: number[];
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
  /** Ascension ranks aligned with PARAGON (data/meta.ts); endless, clamped to PARAGON_TUNING.MAX_RANK. */
  paragon: number[];
  /** Mastery level of the class being played (1 = new). Gates `art` and `talents`, adds masteryMods(). */
  mastery: number;
  /** Secondary ability variant: 0 = the class's standard secondary, n = ClassDef.arts[n - 1]. */
  art: number;
  /** One choice per talent tier of the class: 0 = none, 1 or 2 = option (see data/mastery.ts). */
  talents: number[];
  /** Equipped relics (data/relics.ts), at most RELIC_TUNING.MAX_SLOTS and what `reliquary` allows. No duplicates. */
  relics: { id: string; rank: number }[];
}

export interface RosterEntry {
  slot: number;
  name: string;
  cls: ClassId;
  look: Look;
  /** Mastery level of `cls` (shown on name plates / lobby cards). */
  mastery: number;
  /** Active secondary variant (0 = standard), so every client shows the right ability. */
  art: number;
  /** Relics equipped and talents chosen (counts only, for lobby cards). */
  relics: number;
  talents: number;
  ready: boolean;
  connected: boolean;
  host: boolean;
  boons: BoonStack[];
  /** Keystones held, in the order taken (data/keystones.ts; at most KEYSTONE_TUNING.MAX_HELD). */
  keystones: string[];
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
  /** Elite enemies (cursed-chamber foes, champions) and bosses this hero landed the killing blow on. */
  elites: number;
  bosses: number;
  /** Ultimates used. */
  ultimates: number;
}

/** What one hero takes home when the run ends (computed by the server). */
export interface RunReward {
  slot: number;
  glimmer: number;
  /** Mastery experience for the class played. */
  xp: number;
  /** Relic shards found (ids from data/relics.ts; the same id may appear more than once). */
  relics: string[];
}

export const AFFIX_IDS = ['swift', 'armored', 'volatile', 'vampiric'] as const;
/**
 * Extra trait of an elite enemy from depth 1 on (and at high Oath levels):
 *  swift    – moves and attacks faster
 *  armored  – takes less damage until its guard is broken by a Resonance
 *  volatile – explodes shortly after dying (telegraphed)
 *  vampiric – heals when it hurts a hero
 */
export type AffixId = (typeof AFFIX_IDS)[number];

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
  /** Rewards per hero; filled in when the run ends (victory or defeat), empty before. */
  rewards: RunReward[];
  /** 0 = the first descent. Each `descend` door adds 1; enemies and rewards scale with it (RUN.DEPTH). */
  depth: number;
  /** Final bosses slain in this run so far. > 0 means the run counts as won even if the party falls deeper down. */
  cleared: number;
  /** Chambers cleared in this run across all depths. */
  chambersCleared: number;
  /** Objective of the current chamber; null in the lobby and when the run is over. */
  objective: ObjectiveState | null;
  /**
   * Traits of the enemies that are alive right now and have any (ward, affix, raised by a necromancer). The
   * `spawn` event announces them once; this list lets a client that joined or reloaded later show them too.
   */
  traits: { id: number; ward?: ElementId; affix?: AffixId; raisedBy?: number }[];
  /** Special objectives (every kind but `slay`) completed in this run, across all depths. */
  objectivesDone: number;
  /** How many of them were completed with their bonus. */
  objectiveBonuses: number;
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
  /** Build tags this boon shares with the hero's keystones ([] or absent = none). See data/keystones.ts. */
  fits?: string[];
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
  /**
   * `ward`: the enemy is warded against that element — its status and Resonance bursts of it do nothing to it.
   * `raisedBy`: enemy id of the necromancer that raised this minion (it crumbles when that necromancer dies).
   */
  | { e: 'spawn'; id: number; kind: EnemyKind; x: number; z: number; elite: boolean; affix?: AffixId; ward?: ElementId; raisedBy?: number }
  | { e: 'wave'; wave: number; waveCount: number }
  | { e: 'chamberClear' }
  | { e: 'bossPhase'; phase: number }
  | { e: 'boon'; slot: number; id: string; level: number }
  /** A hero took a keystone (`replaced` = the one given up for it, if the slots were full). */
  | { e: 'keystone'; slot: number; id: string; replaced?: string }
  /**
   * A keystone did its thing (for its own effect and sound). `n` is a count where it has one (stacks, bounces,
   * blades), `x` / `z` where it happens, `r` a radius, `tx` / `tz` a second point (a bounce or arc target).
   * Sent at most a few times per second per hero and keystone; continuous keystones (orbiting blades, the
   * familiar, the mage's stream, the walking sanctum) are drawn from RosterEntry.keystones and hero state instead.
   */
  | { e: 'keystoneProc'; slot: number; id: string; x: number; z: number; n?: number; r?: number; tx?: number; tz?: number }
  | { e: 'doorChosen'; type: DoorType }
  | { e: 'tutorialStep'; step: string }
  | { e: 'hazardHit'; target: TargetRef; kind: Hazard['kind'] }
  /**
   * A lasting ground effect made by a hero ability (consecrated ground, smoke, a trap, a bolt volley, a sanctuary).
   * `kind` is the ability id. It ends after `dur` seconds or earlier with `zoneEnd` (e.g. a sprung trap).
   */
  | { e: 'zone'; id: number; kind: string; x: number; z: number; r: number; dur: number; el: ElementId | null; by: number }
  | { e: 'zoneEnd'; id: number; x: number; z: number; sprung: boolean }
  /** A timed effect on a hero started (`id` from BUFFS in data/classes.ts). */
  | { e: 'buff'; slot: number; id: string; dur: number }
  /** An enemy was marked for death (shade ultimate): takes more damage, bursts when it dies. */
  | { e: 'mark'; id: number; dur: number }
  /** A hero's ultimate became ready. */
  | { e: 'ultReady'; slot: number }
  /**
   * Objective milestones. start: the chamber's objective begins. site: a ritual brazier was lit (`index`).
   * anchorHit: the bell shard was struck (rate-limited). bonusLost: the bonus condition failed (shard shattered,
   * hunt timer ran out). done: objective complete, `bonus` tells whether the bonus was earned.
   */
  | { e: 'objective'; kind: ObjectiveKind; what: 'start' | 'site' | 'anchorHit' | 'bonusLost' | 'done'; index?: number; bonus?: boolean }
  /** An aegis raised (`on`) or lost its ward dome of radius `r`; enemies inside take far less damage. */
  | { e: 'dome'; id: number; on: boolean; r: number }
  /** A hero's elemental hit did nothing because the enemy is warded against `el` (at most one per enemy per second). */
  | { e: 'warded'; id: number; el: ElementId; x: number; z: number; by: number }
  /** An enemy's wind-up was broken by a stun or stagger before it landed (its telegraph and channel end now). */
  | { e: 'interrupt'; id: number }
  /** A shaman healed these enemies. */
  | { e: 'mend'; id: number; targets: number[] }
  /** The party went one depth deeper. */
  | { e: 'descend'; depth: number }
  /** A set bonus became active for a hero (data/boons.ts SETS). */
  | { e: 'set'; slot: number; id: string; tier: number };
