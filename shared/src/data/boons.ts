import type { AbilitySlot, ElementId } from '../types.ts';

export type BoonRarity = 'common' | 'rare' | 'epic';
export type BoonCategory = 'infusion' | 'offense' | 'defense' | 'mobility' | 'element' | 'resonance' | 'kinship';

export interface BoonDef {
  id: string;
  rarity: BoonRarity;
  category: BoonCategory;
  /** values[level - 1] is the effect magnitude at that level; maxLevel = values.length. */
  values: number[];
  element?: ElementId;
  slot?: AbilitySlot;
  /** English reference text; {v} = value at the offered level. Client i18n mirrors these keys by id. */
  summary: string;
}

const infusion = (element: ElementId, slot: AbilitySlot): BoonDef => ({
  id: `infuse_${element}_${slot}`, rarity: 'rare', category: 'infusion', element, slot, values: [1, 1.5],
  summary: `Your ${slot} applies ${element} (potency x{v}). Replaces another infusion on the same ability.`,
});

/**
 * Effect semantics (implemented in sim/boons.ts). Percentages are stored as fractions (0.12 = 12 %).
 * Kinship boons also work solo (they always include the owner).
 */
export const BOONS: BoonDef[] = [
  infusion('ember', 'primary'), infusion('ember', 'secondary'), infusion('ember', 'dash'),
  infusion('rime', 'primary'), infusion('rime', 'secondary'), infusion('rime', 'dash'),
  infusion('storm', 'primary'), infusion('storm', 'secondary'), infusion('storm', 'dash'),

  { id: 'keen_edge', rarity: 'common', category: 'offense', values: [0.12, 0.24, 0.36], summary: 'Primary attacks deal +{v}% damage.' },
  { id: 'heavy_hand', rarity: 'common', category: 'offense', values: [0.15, 0.3, 0.45], summary: 'Secondary ability deals +{v}% damage.' },
  { id: 'swift_strikes', rarity: 'common', category: 'offense', values: [0.08, 0.16, 0.24], summary: 'Primary attacks are {v}% faster.' },
  { id: 'deadeye', rarity: 'rare', category: 'offense', values: [0.1, 0.2, 0.3], summary: '+{v}% chance to critically hit for double damage.' },
  { id: 'executioner', rarity: 'rare', category: 'offense', values: [0.25, 0.5], summary: '+{v}% damage to enemies below 30% health.' },

  { id: 'iron_heart', rarity: 'common', category: 'defense', values: [20, 40, 60], summary: '+{v} maximum health (and heal that amount).' },
  { id: 'barrier', rarity: 'rare', category: 'defense', values: [14, 28], summary: 'Gain a {v} point shield that recharges after 6 s without taking damage.' },
  { id: 'leech', rarity: 'rare', category: 'defense', values: [2, 4], summary: 'Heal {v} health whenever you slay an enemy.' },
  { id: 'last_stand', rarity: 'epic', category: 'defense', values: [1], summary: 'Once per chamber, a killing blow leaves you at 1 health and invulnerable for 2 s.' },

  { id: 'fleet_foot', rarity: 'common', category: 'mobility', values: [0.06, 0.12, 0.18], summary: '+{v}% movement speed.' },
  { id: 'quick_step', rarity: 'common', category: 'mobility', values: [0.2, 0.35], summary: 'Dash recharges {v}% faster.' },
  { id: 'spare_step', rarity: 'rare', category: 'mobility', values: [1], summary: '+1 dash charge.' },
  { id: 'quick_wits', rarity: 'common', category: 'mobility', values: [0.12, 0.24, 0.36], summary: 'Secondary cooldown reduced by {v}%.' },

  { id: 'wildfire', rarity: 'rare', category: 'element', element: 'ember', values: [0.5, 1], summary: 'Burn deals +{v}% damage.' },
  { id: 'deep_frost', rarity: 'rare', category: 'element', element: 'rime', values: [0.15, 0.3], summary: 'Chill slows {v}% more and chilled enemies deal {v}% less damage.' },
  { id: 'overcharge', rarity: 'rare', category: 'element', element: 'storm', values: [0.1, 0.2], summary: 'Shocked enemies take a further +{v}% damage.' },

  { id: 'amplifier', rarity: 'rare', category: 'resonance', values: [0.3, 0.6, 0.9], summary: 'Resonance bursts deal +{v}% damage.' },
  { id: 'wide_resonance', rarity: 'common', category: 'resonance', values: [0.2, 0.4], summary: 'Resonance bursts are {v}% larger.' },
  { id: 'aftershock', rarity: 'epic', category: 'resonance', values: [0.2], summary: 'Triggering a Resonance refunds a dash charge and {v}% of your secondary cooldown.' },
  { id: 'echo', rarity: 'epic', category: 'resonance', values: [0.35], summary: 'Resonance has a {v}% chance to burst a second time.' },

  { id: 'kindred_flame', rarity: 'rare', category: 'kinship', values: [0.08, 0.16], summary: 'You and allies within 7 m deal +{v}% damage.' },
  { id: 'shared_vigor', rarity: 'rare', category: 'kinship', values: [2, 4], summary: 'Your Resonance bursts heal every hero for {v}.' },
  { id: 'lifeline', rarity: 'common', category: 'kinship', values: [0.3, 0.6], summary: 'Revive allies {v}% faster; revived heroes return with {v}% more health.' },
  { id: 'oathbond', rarity: 'epic', category: 'kinship', values: [0.3], summary: 'When an ally falls (or you drop below 30% health) gain +{v}% damage and haste for 10 s.' },
];

export const BOON_BY_ID: ReadonlyMap<string, BoonDef> = new Map(BOONS.map((b) => [b.id, b]));

export const BOON_TUNING = {
  /** Relative draft weights per rarity. */
  WEIGHTS: { common: 60, rare: 32, epic: 8 },
  KINDRED_RADIUS: 7,
  BARRIER_RECHARGE_DELAY: 6,
  OATHBOND_DURATION: 10,
  OATHBOND_HASTE: 0.15,
  LAST_STAND_INVULNERABILITY: 2,
  EXECUTE_THRESHOLD: 0.3,
  BLESSING_HEAL_FRACTION: 0.35,
  CURSED_DRAFT_CHOICES: 4,
} as const;
