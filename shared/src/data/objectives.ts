/**
 * Chamber objectives (update 4). Every combat chamber has one; elite and boss chambers are always `slay`.
 * The objective of the chamber behind a door is shown on the door. Special objectives carry a bonus condition:
 * meeting it upgrades the chamber's draft (one more choice, rare or better guaranteed) and pays BONUS_GLIMMER.
 */
import type { ObjectiveKind } from '../types.ts';

export interface ObjectiveDef {
  kind: ObjectiveKind;
  /** Relative weight when the director rolls the objective of a combat chamber. */
  weight: number;
  /** First chamber index (within a depth) in which it may appear. */
  minChamber: number;
  /** English reference texts; client i18n mirrors by id (`objective.<kind>.name` / `.goal` / `.bonus`). */
  name: string;
  goal: string;
  bonus: string;
}

export const OBJECTIVES: Record<ObjectiveKind, ObjectiveDef> = {
  slay: { kind: 'slay', weight: 40, minChamber: 0, name: 'Slaughter', goal: 'Clear every wave.', bonus: '' },
  survive: { kind: 'survive', weight: 14, minChamber: 1, name: 'Hold Out', goal: 'Survive until the bell tolls.', bonus: 'Nobody is downed when the timer ends.' },
  defend: { kind: 'defend', weight: 14, minChamber: 1, name: 'Guard the Shard', goal: 'Clear the waves while the bell shard stands.', bonus: 'The shard survives.' },
  hunt: { kind: 'hunt', weight: 14, minChamber: 2, name: 'The Hunt', goal: 'Slay the marked elites.', bonus: 'All of them die before the timer runs out.' },
  ritual: { kind: 'ritual', weight: 14, minChamber: 1, name: 'Light the Braziers', goal: 'Stand in each circle until its brazier burns.', bonus: 'All braziers burn within the time limit.' },
  vault: { kind: 'vault', weight: 4, minChamber: 2, name: 'Sealed Vault', goal: 'No enemies. Open the reliquary.', bonus: '' },
};

export const OBJECTIVE_TUNING = {
  /** Reward for meeting a bonus condition: Glimmer per hero (scaled by Oath and depth like all rewards). */
  BONUS_GLIMMER: 14,
  /** The two doors of a choice never show the same special objective; at most this many vaults per depth. */
  MAX_VAULTS_PER_DEPTH: 1,
  SURVIVE: { SECONDS: 55, SECONDS_PER_CHAMBER: 3, MAX_SECONDS: 80, SPAWN_INTERVAL: 5, BUDGET_FRACTION: 0.45 },
  DEFEND: {
    /** Shard health (scaled like enemy damage by chamber, Oath and depth) and size. */
    HP: 520, RADIUS: 1.1,
    /** Polish 1: a hero who is alone cannot guard the shard and fight at once; its shard has this much more health. */
    SOLO_HP_MUL: 1.5,
    /** Share of each wave that goes for the shard instead of the heroes. */
    ATTACKER_SHARE: 0.3,
    /** Heroes standing within this distance slowly repair the shard between hits. */
    REPAIR_RADIUS: 3, REPAIR_PER_SECOND: 0.02, REPAIR_DELAY: 4,
    ANCHOR_HIT_EVENT_SECONDS: 1,
  },
  /** Polish 1: SECONDS_PER_EXTRA_PLAYER more time for each additional hero (a party hunts more and tougher marks). */
  HUNT: { TARGETS: 2, TARGETS_PER_EXTRA_PLAYER: 0.5, SECONDS: 45, SECONDS_PER_EXTRA_PLAYER: 5, ESCORT_BUDGET_FRACTION: 0.6, ENRAGE_DAMAGE_MUL: 1.4, ENRAGE_SPEED_MUL: 1.25 },
  RITUAL: {
    SITES: 3, RADIUS: 2.4, SECONDS_TO_LIGHT: 7,
    /** Progress drains at this fraction of the fill rate while no hero stands inside. */
    DECAY: 0.35,
    /** Each extra hero in the same circle adds this much speed. */
    EXTRA_HERO_SPEED: 0.35,
    BONUS_SECONDS: 60, SPAWN_INTERVAL: 6, BUDGET_FRACTION: 0.4,
    /**
     * A ritual must always end, even for a party that cannot hold a circle (a hero away from the keyboard, a
     * room that is too hot). Once the bonus time has passed the braziers stop cooling, and from
     * OVERTIME_SPREAD_SECONDS after that the fire spreads by itself: unlit braziers fill at OVERTIME_SPREAD_RATE
     * of the normal speed with nobody inside (heroes still speed it up).
     */
    OVERTIME_SPREAD_SECONDS: 30, OVERTIME_SPREAD_RATE: 0.5,
  },
  /** Vault: draft choices added on top of the normal count; the draft guarantees rare or better; healing. */
  /** A living hero within OPEN_RADIUS_PAD of the reliquary's edge (anchor.r + pad from its centre) opens it. */
  VAULT: { EXTRA_CHOICES: 1, HEAL_FRACTION: 0.2, GLIMMER: 20, OPEN_RADIUS_PAD: 1.6 },
  BONUS_EXTRA_CHOICES: 1,
} as const;
