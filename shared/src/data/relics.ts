/**
 * Relics: permanent trinkets found as shards when bosses and elites fall. Shards of the same relic raise its
 * rank (endlessly useful up to MAX_RANK); a hero equips a few of them. Shards and the equipped set live in the
 * player's browser; the loadout carries id + rank and the server clamps rank, slot count and duplicates.
 */
import { META_INDEX, META_UPGRADES } from './meta.ts';
import type { Mods } from './mods.ts';

/**
 * `mods` are the bonus at rank 1; rank r multiplies them by rankScale(r).
 * `special` effects are implemented by the simulation and scale with rank the same way where a number is given:
 *  ember_heart  – your Burn spreads to one nearby enemy when it is first applied
 *  frost_core   – enemies you Chill are also weakened by 8 %
 *  storm_coil   – every 5th hit calls a small lightning strike (18 damage)
 *  void_lantern – Withered enemies you slay drop a mote that heals the nearest hero for 4
 *  phoenix      – once per run, when you would be downed, stand up with 30 % health instead
 *  bell         – your Resonance bursts ring: enemies in them are slowed 30 % for 2 s
 *  hourglass    – draft timers are 15 s longer and you get one more reroll per run
 *  compass      – cursed chambers pay 25 % more Glimmer and experience
 */
export interface RelicDef {
  id: string;
  mods?: Partial<Mods>;
  special?: string;
  /** English reference text; {v} placeholders are filled by the client from mods * rankScale. */
  name: string;
  summary: string;
}

export const RELICS: RelicDef[] = [
  { id: 'whetstone', name: 'Bellfounder\'s Whetstone', summary: 'More damage with everything.', mods: { damage: 0.05 } },
  { id: 'iron_reliquary', name: 'Iron Reliquary', summary: 'More maximum health.', mods: { maxHp: 15 } },
  { id: 'swift_sandals', name: 'Pilgrim\'s Sandals', summary: 'Faster movement and dash recharge.', mods: { moveSpeed: 0.03, dashHaste: 0.1 } },
  { id: 'hunters_eye', name: 'Hunter\'s Eye', summary: 'Higher critical hit chance and critical damage.', mods: { critChance: 0.04, critDamage: 0.1 } },
  { id: 'war_drum', name: 'War Drum', summary: 'Faster primary attacks.', mods: { attackSpeed: 0.05 } },
  { id: 'tuning_fork', name: 'Tuning Fork', summary: 'Stronger Resonance bursts and larger areas.', mods: { resonanceDamage: 0.12, area: 0.05 } },
  { id: 'prism', name: 'Glimmer Prism', summary: 'Stronger statuses.', mods: { elementPotency: 0.12 } },
  { id: 'censer', name: 'Warden\'s Censer', summary: 'Your ultimate charges faster and hits harder.', mods: { ultCharge: 0.1, ultimateDamage: 0.08 } },
  { id: 'aegis_shard', name: 'Aegis Shard', summary: 'Take less damage; start chambers with a shield.', mods: { damageTaken: 0.03, startShield: 8 } },
  { id: 'leech_fang', name: 'Leech Fang', summary: 'Heal on every kill.', mods: { lifeOnKill: 1.5 } },
  { id: 'coin_of_charon', name: 'Ferryman\'s Coin', summary: 'More Glimmer and more relic shards.', mods: { glimmer: 0.1, relicFind: 0.05 } },
  { id: 'tome', name: 'Annotated Tome', summary: 'More mastery experience.', mods: { xp: 0.12 } },
  { id: 'ember_heart', name: 'Ember Heart', summary: 'Your Burn spreads to a nearby enemy. Stronger statuses.', mods: { elementPotency: 0.05 }, special: 'ember_heart' },
  { id: 'frost_core', name: 'Frost Core', summary: 'Enemies you Chill deal less damage. Faster secondary.', mods: { secondaryHaste: 0.06 }, special: 'frost_core' },
  { id: 'storm_coil', name: 'Storm Coil', summary: 'Every 5th hit calls a lightning strike.', special: 'storm_coil' },
  { id: 'void_lantern', name: 'Void Lantern', summary: 'Withered enemies you slay heal the nearest hero.', special: 'void_lantern' },
  { id: 'phoenix', name: 'Phoenix Feather', summary: 'Once per run, stand up instead of going down.', special: 'phoenix' },
  { id: 'bell', name: 'Shard of the Last Bell', summary: 'Your Resonance bursts slow what they hit. Stronger Resonance.', mods: { resonanceDamage: 0.06 }, special: 'bell' },
  { id: 'hourglass', name: 'Drafter\'s Hourglass', summary: 'Longer drafts and one more reroll per run.', special: 'hourglass' },
  { id: 'compass', name: 'Cursed Compass', summary: 'Cursed chambers pay more Glimmer and experience.', special: 'compass' },
];

export const RELIC_BY_ID: ReadonlyMap<string, RelicDef> = new Map(RELICS.map((r) => [r.id, r]));

export const RELIC_TUNING = {
  MAX_RANK: 10,
  /** Slots without the `reliquary` upgrade; each of its levels adds one. */
  BASE_SLOTS: 1,
  MAX_SLOTS: 3,
  /** Rank r multiplies a relic's mods by 1 + RANK_STEP * (r - 1). */
  RANK_STEP: 0.25,
  /** Chance of one shard per hero for each kill of that kind (the whole party rolls, not only the killer). */
  DROP_ELITE: 0.12, DROP_HERALD: 0.4, DROP_BOSS: 1,
  /** Added to every chance per depth, and per Oath level. */
  DROP_PER_DEPTH: 0.1, DROP_PER_OATH: 0.02,
  /** A final boss below depth 0 drops this many shards. */
  DEEP_BOSS_SHARDS: 2,
  /**
   * Polish 1: behind a cursed door every elite-flagged enemy of the rank and file that a hero slays gives each
   * hero this (small) chance of a shard, raised by depth, Oath and relic find in the same proportion as the
   * champion's DROP_ELITE. No hero finds more than CURSED_SHARDS_PER_CHAMBER of them in one chamber. Summoned
   * minions and enemies that crumble by themselves never roll.
   */
  DROP_CURSED_ELITE: 0.02, CURSED_SHARDS_PER_CHAMBER: 1,
  /** Phoenix: health fraction; storm coil: hits per strike and damage; and so on for the specials. */
  PHOENIX_HP: 0.3, COIL_EVERY: 5, COIL_DAMAGE: 18, LANTERN_HEAL: 4, FROST_CORE_WEAKEN: 0.08,
  BELL_SLOW: 0.3, BELL_SECONDS: 2, HOURGLASS_SECONDS: 15, COMPASS_BONUS: 0.25,
} as const;

/** Total shards needed for rank r (1 shard = rank 1, then 2 more, 3 more, …): r (r + 1) / 2. */
export const shardsForRank = (rank: number): number => (rank * (rank + 1)) / 2;

/** Rank (0 = not owned) of a relic the player holds `shards` shards of. */
export function rankFromShards(shards: number): number {
  let rank = 0;
  while (rank < RELIC_TUNING.MAX_RANK && shardsForRank(rank + 1) <= shards) rank++;
  return rank;
}

export const rankScale = (rank: number): number => 1 + RELIC_TUNING.RANK_STEP * (Math.max(1, rank) - 1);

/** Relic slots for a given meta level list (aligned with META_UPGRADES). */
export function relicSlots(meta: readonly number[]): number {
  const index = META_INDEX.get('reliquary');
  const level = index === undefined ? 0 : Math.max(0, Math.min(META_UPGRADES[index].costs.length, Math.floor(meta[index] ?? 0)));
  return Math.min(RELIC_TUNING.MAX_SLOTS, RELIC_TUNING.BASE_SLOTS + level);
}

/** Clamps an untrusted equipped-relic list: known ids, no duplicates, valid ranks, at most `slots` entries. */
export function sanitizeRelics(raw: unknown, slots: number): { id: string; rank: number }[] {
  const out: { id: string; rank: number }[] = [];
  if (!Array.isArray(raw)) return out;
  for (const item of raw) {
    if (out.length >= slots) break;
    if (typeof item !== 'object' || item === null) continue;
    const { id, rank } = item as { id?: unknown; rank?: unknown };
    if (typeof id !== 'string' || !RELIC_BY_ID.has(id) || out.some((r) => r.id === id)) continue;
    const r = typeof rank === 'number' && Number.isFinite(rank) ? Math.max(1, Math.min(RELIC_TUNING.MAX_RANK, Math.floor(rank))) : 1;
    out.push({ id, rank: r });
  }
  return out;
}
