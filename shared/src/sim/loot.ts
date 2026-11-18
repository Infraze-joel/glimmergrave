/**
 * Relic shard drops: rolled per hero from the run's own seeded generator when a champion, herald or final boss
 * falls, and (polish 1, capped per chamber) when a hero slays an elite-flagged enemy in a cursed chamber.
 */
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

/** Chance per slain elite of a cursed chamber: DROP_CURSED_ELITE, scaled like the champion's chance by depth, Oath and relic find. */
export function cursedDropChance(depth: number, oath: number, relicFind: number): number {
  return Math.min(1, (RELIC_TUNING.DROP_CURSED_ELITE * dropChance('elite', depth, oath, relicFind)) / RELIC_TUNING.DROP_ELITE);
}

/**
 * An elite-flagged enemy of the rank and file fell to a hero in a cursed chamber: every hero rolls for a shard
 * until they have found CURSED_SHARDS_PER_CHAMBER in this chamber (`Hero.cursedShards`, reset on entering one).
 */
export function rollCursedShard(w: World): void {
  if (w.tutorial) return;
  for (const h of w.heroes) {
    // Two numbers per hero whatever happens, like rollShards.
    const hit = w.lootRng.next() < cursedDropChance(w.run.depth, w.run.oath, h.mods.relicFind);
    const relic = w.lootRng.pick(RELICS);
    if (!hit || h.cursedShards >= RELIC_TUNING.CURSED_SHARDS_PER_CHAMBER) continue;
    h.cursedShards++;
    h.shards.push(relic.id);
  }
}
