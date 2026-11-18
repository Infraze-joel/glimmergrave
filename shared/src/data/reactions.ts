/**
 * Resonance reactions. Striking an enemy that carries the status of element A with a different element B
 * consumes A and bursts (STATUS.RESONANCE in data/enemies.ts). Since update 3 every PAIR of elements has its own
 * named reaction: the burst is the same, the extra effect differs. The order of the two elements does not matter.
 */
import type { ElementId } from '../types.ts';

export const REACTION_IDS = ['shatter', 'conflagration', 'superconduct', 'soulfire', 'entomb', 'voidarc'] as const;
export type ReactionId = (typeof REACTION_IDS)[number];

export interface ReactionDef {
  id: ReactionId;
  pair: readonly [ElementId, ElementId];
  /** Multiplier on the burst's damage and radius. */
  damageMul: number;
  radiusMul: number;
  /** English reference text. Client i18n mirrors these by id (`reaction.<id>.name` / `.body`). */
  name: string;
  summary: string;
}

export const REACTIONS: ReactionDef[] = [
  { id: 'shatter', pair: ['ember', 'rime'], damageMul: 1.25, radiusMul: 1, name: 'Shatter', summary: 'Thermal shock: the burst hits harder and stuns everything it touches.' },
  { id: 'conflagration', pair: ['ember', 'storm'], damageMul: 1, radiusMul: 1.5, name: 'Conflagration', summary: 'A much larger burst that sets every enemy in it ablaze with a stronger Burn.' },
  { id: 'superconduct', pair: ['rime', 'storm'], damageMul: 1, radiusMul: 1, name: 'Superconduct', summary: 'Enemies in the burst are Sundered: they take more damage from everything for a while.' },
  { id: 'soulfire', pair: ['ember', 'umbra'], damageMul: 1, radiusMul: 1, name: 'Soulfire', summary: 'The burst heals every hero near it.' },
  { id: 'entomb', pair: ['rime', 'umbra'], damageMul: 0.8, radiusMul: 1, name: 'Entomb', summary: 'Enemies in the burst are frozen in place, and the hero who caused it gains a shield.' },
  { id: 'voidarc', pair: ['storm', 'umbra'], damageMul: 0.8, radiusMul: 1, name: 'Void Arc', summary: 'Lightning leaps from the burst to further enemies, far beyond its radius.' },
];

export const REACTION_TUNING = {
  SHATTER_STUN: 1,
  /** Bosses cannot be stunned: Shatter staggers them instead and deals this much extra burst damage. */
  SHATTER_BOSS_BONUS: 0.5,
  CONFLAGRATION_BURN_POTENCY: 1.5,
  SUNDER_VULNERABILITY: 0.2, SUNDER_SECONDS: 6,
  SOULFIRE_HEAL: 6, SOULFIRE_HEAL_RADIUS: 7,
  ENTOMB_ROOT_SECONDS: 2, ENTOMB_BOSS_ROOT_SECONDS: 0.5, ENTOMB_SHIELD: 12,
  VOIDARC_JUMPS: 3, VOIDARC_RANGE: 8, VOIDARC_DAMAGE: 22,
} as const;

const key = (a: ElementId, b: ElementId): string => (a < b ? `${a}+${b}` : `${b}+${a}`);
const BY_PAIR: ReadonlyMap<string, ReactionDef> = new Map(REACTIONS.map((r) => [key(r.pair[0], r.pair[1]), r]));

/** The reaction of two different elements (order does not matter); null for a === b. */
export function reactionOf(a: ElementId, b: ElementId): ReactionDef | null {
  return a === b ? null : BY_PAIR.get(key(a, b)) ?? null;
}
