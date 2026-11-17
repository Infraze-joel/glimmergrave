import type { AbilitySlot, ClassId, ElementId } from '../types.ts';
import type { Mods } from './mods.ts';
import type { ReactionId } from './reactions.ts';
import type { AbilityDef } from './classes.ts';

export type BoonRarity = 'common' | 'rare' | 'epic' | 'legendary';
export type BoonCategory =
  | 'infusion' | 'offense' | 'defense' | 'mobility' | 'element' | 'resonance' | 'kinship'
  // update 3
  | 'ultimate' | 'class' | 'duo';

/** Numeric ability fields a class boon may change. */
export type AbilityField = 'damage' | 'range' | 'arc' | 'radius' | 'count' | 'pierce' | 'stun' | 'knockback' | 'duration' | 'selfShield' | 'heal' | 'cooldown';

export interface BoonDef {
  id: string;
  rarity: BoonRarity;
  category: BoonCategory;
  /** values[level - 1] is the effect magnitude at that level; maxLevel = values.length. */
  values: number[];
  element?: ElementId;
  slot?: AbilitySlot;
  /** Only offered to this class. */
  cls?: ClassId;
  /**
   * Class boons: changes one field of the hero's ability in `slot` (for `secondary`: whichever variant is
   * equipped). `mode` mul: field *= 1 + value; add: field += value. value = values[level - 1].
   */
  ability?: { field: AbilityField & keyof AbilityDef; mode: 'mul' | 'add' };
  /** Duo boons: only offered to a hero who has infusions of BOTH elements of this reaction; they empower it. */
  reaction?: ReactionId;
  /** Passive bonus per level, scaled by values[level - 1] (value 1 = the mods as written). */
  mods?: Partial<Mods>;
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

  // ------------------------------------------------------------------ update 3 (append only)
  infusion('umbra', 'primary'), infusion('umbra', 'secondary'), infusion('umbra', 'dash'),
  // Ultimates can carry an element too: everything the ultimate hits gets the status.
  infusion('ember', 'ultimate'), infusion('rime', 'ultimate'), infusion('storm', 'ultimate'), infusion('umbra', 'ultimate'),
  { id: 'creeping_dark', rarity: 'rare', category: 'element', element: 'umbra', values: [0.1, 0.2], summary: 'Withered enemies deal a further {v}% less damage and your hits on them leech twice as much.' },

  { id: 'momentum', rarity: 'common', category: 'offense', values: [0.03, 0.05, 0.07], summary: 'Each hit in a row grants +{v}% damage (up to 6 stacks, lost after 3 s without hitting).' },
  { id: 'giant_slayer', rarity: 'rare', category: 'offense', values: [0.15, 0.3], summary: '+{v}% damage to elites and bosses.' },
  { id: 'overkill', rarity: 'rare', category: 'offense', values: [12, 24], summary: 'Enemies you slay burst for {v} damage around them.' },
  { id: 'first_blood', rarity: 'common', category: 'offense', values: [0.3, 0.6], summary: '+{v}% damage against enemies at full health.' },
  { id: 'brutality', rarity: 'epic', category: 'offense', values: [0.5], summary: 'Critical hits deal +{v}% more damage.' },

  { id: 'thorns', rarity: 'common', category: 'defense', values: [8, 16, 24], summary: 'Enemies that hit you in melee take {v} damage.' },
  { id: 'mending', rarity: 'common', category: 'defense', values: [0.1, 0.2], summary: 'Heal {v}% of your maximum health whenever a chamber is cleared.' },
  { id: 'stoneskin', rarity: 'rare', category: 'defense', values: [0.08, 0.16], summary: 'Take {v}% less damage.' },
  { id: 'crystal_ward', rarity: 'rare', category: 'defense', values: [6, 12], summary: 'Gain a {v} point shield whenever you trigger a Resonance.' },

  { id: 'slipstream', rarity: 'common', category: 'mobility', values: [0.2, 0.35], summary: 'After a dash move {v}% faster for 2 s.' },
  { id: 'afterimage', rarity: 'rare', category: 'mobility', values: [14, 28], summary: 'Your dash cuts every enemy on its path for {v} damage.' },

  { id: 'catalyst', rarity: 'common', category: 'resonance', values: [0.25, 0.5], summary: 'Burn, Chill, Shock and Wither last {v}% longer.' },
  { id: 'chain_reaction', rarity: 'epic', category: 'resonance', values: [1], summary: 'Enemies slain by a Resonance burst pass their status on to the nearest enemy.' },

  { id: 'zealot', rarity: 'common', category: 'ultimate', values: [0.15, 0.3, 0.45], summary: 'Your ultimate charges {v}% faster.' },
  { id: 'crescendo', rarity: 'rare', category: 'ultimate', values: [0.25, 0.5], summary: 'Your ultimate deals +{v}% damage and heals {v}% more.' },
  { id: 'encore', rarity: 'epic', category: 'ultimate', values: [0.35], summary: 'Using your ultimate leaves you with {v}% of the charge.' },
  { id: 'opening_act', rarity: 'rare', category: 'ultimate', values: [0.25, 0.5], summary: 'Begin every chamber with at least {v}% ultimate charge.' },

  { id: 'covenant', rarity: 'rare', category: 'kinship', values: [8, 16], summary: 'When a Resonance is triggered on a status you applied, you and the hero who triggered it gain a {v} point shield.' },
  { id: 'rally', rarity: 'rare', category: 'kinship', values: [15, 30], summary: 'Your ultimate heals every hero for {v}.' },

  // Class boons: two per class, only offered to that class.
  { id: 'knight_aegis', rarity: 'rare', category: 'class', cls: 'knight', slot: 'secondary', ability: { field: 'selfShield', mode: 'add' }, values: [14, 28], summary: 'Knight: your secondary grants +{v} shield.' },
  { id: 'knight_cleave', rarity: 'rare', category: 'class', cls: 'knight', slot: 'primary', ability: { field: 'arc', mode: 'mul' }, values: [0.25, 0.5], summary: 'Knight: your sword swings are {v}% wider.' },
  { id: 'barb_fury', rarity: 'rare', category: 'class', cls: 'barbarian', slot: 'secondary', ability: { field: 'duration', mode: 'mul' }, values: [0.3, 0.6], summary: 'Barbarian: Whirlwind lasts {v}% longer; Skullsplitter stuns {v}% longer.' },
  { id: 'barb_reach', rarity: 'rare', category: 'class', cls: 'barbarian', slot: 'primary', ability: { field: 'range', mode: 'mul' }, values: [0.15, 0.3], summary: 'Barbarian: your axe reaches {v}% further.' },
  { id: 'mage_split', rarity: 'rare', category: 'class', cls: 'mage', slot: 'primary', ability: { field: 'count', mode: 'add' }, values: [1, 2], summary: 'Mage: your arc bolt splits into {v} more bolt(s).' },
  { id: 'mage_expanse', rarity: 'rare', category: 'class', cls: 'mage', slot: 'secondary', ability: { field: 'radius', mode: 'mul' }, values: [0.2, 0.4], summary: 'Mage: your secondary is {v}% larger.' },
  { id: 'rogue_pierce', rarity: 'rare', category: 'class', cls: 'rogue', slot: 'primary', ability: { field: 'pierce', mode: 'add' }, values: [1, 2], summary: 'Rogue: your bolts pierce {v} more enemy(ies).' },
  { id: 'rogue_fan', rarity: 'rare', category: 'class', cls: 'rogue', slot: 'secondary', ability: { field: 'count', mode: 'add' }, values: [2, 4], summary: 'Rogue: Knife Fan throws {v} more knives; a Snare wounds 40% harder per level.' },
  { id: 'templar_grace', rarity: 'rare', category: 'class', cls: 'templar', slot: 'secondary', ability: { field: 'heal', mode: 'mul' }, values: [0.5, 1], summary: 'Templar: hallowed ground heals {v}% more.' },
  { id: 'templar_weight', rarity: 'rare', category: 'class', cls: 'templar', slot: 'primary', ability: { field: 'knockback', mode: 'add' }, values: [1.5, 3], summary: 'Templar: every swing hurls enemies {v} m back.' },
  { id: 'spell_surge', rarity: 'rare', category: 'class', cls: 'spellblade', slot: 'primary', ability: { field: 'pierce', mode: 'add' }, values: [2, 4], summary: 'Spellblade: your blade wave cuts through {v} more enemies.' },
  { id: 'spell_flux', rarity: 'rare', category: 'class', cls: 'spellblade', slot: 'secondary', ability: { field: 'cooldown', mode: 'mul' }, values: [-0.2, -0.35], summary: 'Spellblade: your secondary recharges much faster.' },
  { id: 'shade_venom', rarity: 'rare', category: 'class', cls: 'shade', slot: 'primary', ability: { field: 'damage', mode: 'mul' }, values: [0.2, 0.4], summary: 'Shade: your daggers deal +{v}% damage.' },
  { id: 'shade_reach', rarity: 'rare', category: 'class', cls: 'shade', slot: 'secondary', ability: { field: 'range', mode: 'mul' }, values: [0.25, 0.5], summary: 'Shade: Shadowstep travels {v}% further; Smoke Bomb is {v}% larger.' },

  // Duo boons (legendary): one per reaction, need infusions of both of its elements. Burst +{v}%, extra effect doubled.
  { id: 'duo_shatter', rarity: 'legendary', category: 'duo', reaction: 'shatter', values: [0.6], summary: 'Shatter bursts deal +{v}% damage and stun twice as long.' },
  { id: 'duo_conflagration', rarity: 'legendary', category: 'duo', reaction: 'conflagration', values: [0.6], summary: 'Conflagration bursts deal +{v}% damage and their Burn is twice as strong.' },
  { id: 'duo_superconduct', rarity: 'legendary', category: 'duo', reaction: 'superconduct', values: [0.6], summary: 'Superconduct bursts deal +{v}% damage and Sunder twice as deeply.' },
  { id: 'duo_soulfire', rarity: 'legendary', category: 'duo', reaction: 'soulfire', values: [0.6], summary: 'Soulfire bursts deal +{v}% damage and heal twice as much.' },
  { id: 'duo_entomb', rarity: 'legendary', category: 'duo', reaction: 'entomb', values: [0.6], summary: 'Entomb bursts deal +{v}% damage, hold twice as long and shield twice as much.' },
  { id: 'duo_voidarc', rarity: 'legendary', category: 'duo', reaction: 'voidarc', values: [0.6], summary: 'Void Arc bursts deal +{v}% damage and leap to twice as many enemies.' },
];

/**
 * Set bonuses: owning enough boons of one kind switches on a passive bonus (announced with the `set` event).
 * A set counts boons by `category`, or — for the four element sets — every boon with that `element`
 * (infusions included). Levels do not matter, only different boons. Tier 2 is added on top of tier 1.
 * `special` effects are implemented by the simulation:
 *  spread   – when an enemy carrying this element's status dies, the status jumps to the nearest enemy
 *  overflow – Resonance bursts fully charge 10 % of your ultimate
 *  bond     – revived heroes (you or by you) get 3 s of invulnerability
 */
export interface SetDef {
  id: string;
  element?: ElementId;
  category?: BoonCategory;
  /** Boons needed for tier 1 and tier 2. */
  need: readonly [number, number];
  tiers: readonly [{ mods?: Partial<Mods>; special?: string; summary: string }, { mods?: Partial<Mods>; special?: string; summary: string }];
}

const elementSet = (element: ElementId): SetDef => ({
  id: `set_${element}`, element, need: [2, 4],
  tiers: [
    { mods: { elementPotency: 0.25 }, summary: `Your statuses are 25% stronger.` },
    { mods: { resonanceDamage: 0.3 }, special: 'spread', summary: `+30% Resonance damage; ${element} statuses jump to the nearest enemy when their carrier dies.` },
  ],
});

export const SETS: SetDef[] = [
  elementSet('ember'), elementSet('rime'), elementSet('storm'), elementSet('umbra'),
  { id: 'set_offense', category: 'offense', need: [3, 5], tiers: [{ mods: { damage: 0.1 }, summary: '+10% damage.' }, { mods: { critChance: 0.15 }, summary: '+15% critical hit chance.' }] },
  { id: 'set_defense', category: 'defense', need: [3, 5], tiers: [{ mods: { maxHp: 30 }, summary: '+30 maximum health.' }, { mods: { damageTaken: 0.15 }, summary: 'Take 15% less damage.' }] },
  { id: 'set_mobility', category: 'mobility', need: [3, 5], tiers: [{ mods: { moveSpeed: 0.08 }, summary: '+8% movement speed.' }, { mods: { dashCharges: 1 }, summary: '+1 dash charge.' }] },
  { id: 'set_resonance', category: 'resonance', need: [2, 4], tiers: [{ mods: { area: 0.15 }, summary: 'All your areas are 15% larger.' }, { special: 'overflow', summary: 'Every Resonance you trigger charges 10% of your ultimate.' }] },
  { id: 'set_ultimate', category: 'ultimate', need: [2, 3], tiers: [{ mods: { ultCharge: 0.2 }, summary: 'Your ultimate charges 20% faster.' }, { mods: { ultimateDamage: 0.4 }, summary: '+40% ultimate damage.' }] },
  { id: 'set_kinship', category: 'kinship', need: [2, 4], tiers: [{ mods: { reviveSpeed: 0.5 }, summary: 'Revive 50% faster.' }, { special: 'bond', summary: 'Heroes you revive — and you, when revived — are invulnerable for 3 s.' }] },
];

/** Active tier (0, 1 or 2) and boon count of every set for a hero's boons. */
export function setProgress(boons: readonly { id: string }[]): { set: SetDef; count: number; tier: number }[] {
  return SETS.map((set) => {
    let count = 0;
    for (const stack of boons) {
      const def = BOON_BY_ID.get(stack.id);
      if (!def) continue;
      if (set.element ? def.element === set.element : def.category === set.category) count++;
    }
    return { set, count, tier: count >= set.need[1] ? 2 : count >= set.need[0] ? 1 : 0 };
  });
}

export const BOON_BY_ID: ReadonlyMap<string, BoonDef> = new Map(BOONS.map((b) => [b.id, b]));

export const BOON_TUNING = {
  /** Relative draft weights per rarity. */
  WEIGHTS: { common: 60, rare: 32, epic: 8, legendary: 5 },
  MOMENTUM_MAX_STACKS: 6, MOMENTUM_DECAY_SECONDS: 3,
  OVERKILL_RADIUS: 2.5,
  SLIPSTREAM_SECONDS: 2,
  SET_BOND_INVULNERABILITY: 3, SET_OVERFLOW_CHARGE: 0.1,
  /** rogue_fan boon on a Snare: damage bonus per level instead of more knives. */
  ROGUE_FAN_TRAP_BONUS: 0.4,
  KINDRED_RADIUS: 7,
  BARRIER_RECHARGE_DELAY: 6,
  OATHBOND_DURATION: 10,
  OATHBOND_HASTE: 0.15,
  LAST_STAND_INVULNERABILITY: 2,
  EXECUTE_THRESHOLD: 0.3,
  BLESSING_HEAL_FRACTION: 0.35,
  CURSED_DRAFT_CHOICES: 4,
} as const;
