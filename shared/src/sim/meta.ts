/** Permanent upgrades: turns sanitised levels (Loadout.meta) into the numbers the simulation uses, and run rewards. */
import { META_INDEX, META_UPGRADES, REWARDS, sanitizeMeta } from '../data/meta.ts';
import type { MetaStats } from './state.ts';

export function emptyMeta(): MetaStats {
  return { hp: 0, might: 0, moveSpeed: 0, secondaryHaste: 0, dashHaste: 0, rerolls: 0, attunement: false, resolve: 0, fortune: 0 };
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
    },
  };
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
