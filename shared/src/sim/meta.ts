/** Permanent upgrades: turns sanitised levels (Loadout.meta) into the numbers the simulation uses, and run rewards. */
import { XP_REWARDS } from '../data/mastery.ts';
import { META_INDEX, META_UPGRADES, REWARDS, sanitizeMeta } from '../data/meta.ts';
import { emptyMods, type Mods } from '../data/mods.ts';
import { OBJECTIVE_TUNING } from '../data/objectives.ts';
import type { MetaStats } from './state.ts';

export function emptyMeta(): MetaStats {
  return {
    hp: 0, might: 0, moveSpeed: 0, secondaryHaste: 0, dashHaste: 0, rerolls: 0, attunement: false, resolve: 0, fortune: 0,
    foresight: 0, tenacity: false,
  };
}

export const noMetaLevels = (): number[] => META_UPGRADES.map(() => 0);

/** Highest level of every upgrade (tools and tests). */
export const maxMetaLevels = (): number[] => META_UPGRADES.map((def) => def.costs.length);

function value(levels: readonly number[], id: string): number {
  const index = META_INDEX.get(id);
  if (index === undefined) return 0;
  const def = META_UPGRADES[index];
  const level = levels[index] ?? 0;
  if (!def || level < 1) return 0;
  return def.values[Math.min(level, def.values.length) - 1] ?? 0;
}

/** `raw` is clamped again here, so the simulation never trusts its caller with upgrade levels. */
export function computeMeta(raw: unknown): { levels: number[]; stats: MetaStats } {
  const levels = sanitizeMeta(raw);
  return {
    levels,
    stats: {
      hp: value(levels, 'vitality'),
      might: value(levels, 'might'),
      moveSpeed: value(levels, 'swiftness'),
      secondaryHaste: value(levels, 'celerity'),
      dashHaste: value(levels, 'footwork'),
      rerolls: value(levels, 'insight'),
      attunement: value(levels, 'attunement') > 0,
      resolve: value(levels, 'resolve'),
      fortune: value(levels, 'fortune'),
      foresight: value(levels, 'foresight'),
      tenacity: value(levels, 'tenacity') > 0,
    },
  };
}

/** The Armory upgrades that are plain passive bonuses, as Mods (the rest are MetaStats flags). */
export function metaMods(levels: readonly number[]): Mods {
  const m = emptyMods();
  m.maxHp = value(levels, 'vitality');
  m.damage = value(levels, 'might');
  m.moveSpeed = value(levels, 'swiftness');
  m.secondaryHaste = value(levels, 'celerity');
  m.dashHaste = value(levels, 'footwork');
  m.glimmer = value(levels, 'fortune');
  m.critChance = value(levels, 'ferocity');
  m.attackSpeed = value(levels, 'tempo');
  m.ultCharge = value(levels, 'zeal');
  m.startShield = value(levels, 'warding');
  m.xp = value(levels, 'scholar');
  m.relicFind = value(levels, 'salvage');
  return m;
}

export interface RunTally {
  chambersCleared: number;
  elitesSlain: number;
  bossSlain: boolean;
  oath: number;
}

/** Glimmer of a finished run before the hero's own fortune bonus: tally x oath multiplier, at least MINIMUM. */
export function baseReward(tally: RunTally): number {
  const sum = tally.chambersCleared * REWARDS.PER_CHAMBER_CLEARED + tally.elitesSlain * REWARDS.PER_ELITE_SLAIN
    + (tally.bossSlain ? REWARDS.BOSS_SLAIN : 0);
  return Math.max(REWARDS.MINIMUM, sum * (1 + REWARDS.OATH_BONUS * tally.oath));
}

export const heroReward = (base: number, fortune: number): number => Math.round(base * (1 + fortune));

/**
 * What the party has earned so far, before Oath and personal bonuses. Every payment is multiplied by the depth
 * bonus of the depth it was earned at when it is added; `cursed*` is the part earned inside cursed chambers
 * (the compass relic pays extra on it).
 */
export interface Earnings {
  glimmer: number;
  xp: number;
  cursedGlimmer: number;
  cursedXp: number;
}

export const emptyEarnings = (): Earnings => ({ glimmer: 0, xp: 0, cursedGlimmer: 0, cursedXp: 0 });

/** `bonus`: an objective's bonus condition was met; `vault`: the hoard of a sealed vault (both pay Glimmer only). */
export type EarnKind = 'chamber' | 'elite' | 'boss' | 'bonus' | 'vault';

const GLIMMER_OF: Record<EarnKind, number> = {
  chamber: REWARDS.PER_CHAMBER_CLEARED, elite: REWARDS.PER_ELITE_SLAIN, boss: REWARDS.BOSS_SLAIN,
  bonus: OBJECTIVE_TUNING.BONUS_GLIMMER, vault: OBJECTIVE_TUNING.VAULT.GLIMMER,
};
const XP_OF: Record<EarnKind, number> = { chamber: XP_REWARDS.PER_CHAMBER_CLEARED, elite: XP_REWARDS.PER_ELITE_SLAIN, boss: XP_REWARDS.BOSS_SLAIN, bonus: 0, vault: 0 };

export function earn(e: Earnings, kind: EarnKind, depth: number, cursed: boolean): void {
  const g = GLIMMER_OF[kind] * (1 + REWARDS.DEPTH_BONUS * depth);
  const x = XP_OF[kind] * (1 + XP_REWARDS.DEPTH_BONUS * depth);
  e.glimmer += g;
  e.xp += x;
  if (cursed) { e.cursedGlimmer += g; e.cursedXp += x; }
}

/** Glimmer of one hero: (earned + compass share) x Oath, at least MINIMUM, x the hero's own bonus. */
export function glimmerReward(e: Earnings, oath: number, compass: number, bonus: number): number {
  const base = Math.max(REWARDS.MINIMUM, (e.glimmer + e.cursedGlimmer * compass) * (1 + REWARDS.OATH_BONUS * oath));
  return Math.round(base * (1 + bonus));
}

/** Mastery experience of one hero, by the same rules with XP_REWARDS. */
export function xpReward(e: Earnings, oath: number, compass: number, bonus: number): number {
  const base = Math.max(XP_REWARDS.MINIMUM, (e.xp + e.cursedXp * compass) * (1 + XP_REWARDS.OATH_BONUS * oath));
  return Math.round(base * (1 + bonus));
}
