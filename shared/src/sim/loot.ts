/** Relic shard drops: rolled per hero from the run's own seeded generator when a champion, herald or final boss falls. */
import { RELICS, RELIC_TUNING } from '../data/relics.ts';
import type { World } from './world.ts';

export type DropKind = 'elite' | 'herald' | 'boss';

const BASE_CHANCE: Record<DropKind, number> = {
  elite: RELIC_TUNING.DROP_ELITE, herald: RELIC_TUNING.DROP_HERALD, boss: RELIC_TUNING.DROP_BOSS,
};

/** Chance of one shard for a hero with `relicFind` at the given depth and Oath (0..1). */
export function dropChance(kind: DropKind, depth: number, oath: number, relicFind: number): number {
  return Math.min(1, BASE_CHANCE[kind] + RELIC_TUNING.DROP_PER_DEPTH * depth + RELIC_TUNING.DROP_PER_OATH * oath + relicFind);
}

/** Every hero on the roster rolls (not only the killer). Final bosses below depth 0 roll DEEP_BOSS_SHARDS times. */
export function rollShards(w: World, kind: DropKind): void {
  if (w.tutorial) return;
  const rolls = kind === 'boss' && w.run.depth > 0 ? RELIC_TUNING.DEEP_BOSS_SHARDS : 1;
  for (const h of w.heroes) {
    const chance = dropChance(kind, w.run.depth, w.run.oath, h.mods.relicFind);
    for (let i = 0; i < rolls; i++) {
      // Always two numbers per roll, so one hero's luck never shifts another hero's relic.
      const hit = w.lootRng.next() < chance;
      const relic = w.lootRng.pick(RELICS);
      if (hit) h.shards.push(relic.id);
    }
  }
}
