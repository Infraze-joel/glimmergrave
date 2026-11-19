/**
 * Keystones (update 5): boons that change HOW a hero fights instead of adding a percentage. They are the answer
 * to "my build is just bigger numbers". Rules:
 *  - Keystones are offered only in dedicated **keystone drafts**: after each elite chamber (the champion and
 *    the herald) every hero chooses 1 of KEYSTONE_TUNING.CHOICES keystones instead of an ordinary boon draft.
 *    So every run has two build-defining decisions at known points, and more with each depth.
 *  - A hero holds at most KEYSTONE_TUNING.MAX_HELD keystones. With the slots full, the draft offers to REPLACE
 *    one (pick, then choose which to give up) or to take the consolation (an ordinary rare-or-better draft).
 *  - A keystone has one level. Everything it does is visible in the world (its own effect, colour and sound).
 *  - `tags` describe what a keystone feeds on. Ordinary boons carry tags too (boonTags below); a boon that
 *    shares a tag with a held keystone is marked "fits your build" in drafts and weighted up when rolled.
 *  - Class keystones (`cls`) are only offered to that class; at most one class keystone is in an offer.
 * The simulation implements each `id`; the numbers it needs are in `params` (English `summary` uses them).
 */
import type { AbilitySlot, ClassId } from '../types.ts';
import { BOON_BY_ID, type BoonDef } from './boons.ts';

export const BUILD_TAGS = [
  'primary', 'secondary', 'dash', 'ultimate', 'projectile', 'melee', 'area', 'status', 'resonance', 'crit',
  'shield', 'health', 'speed', 'summon', 'kill',
] as const;
export type BuildTag = (typeof BUILD_TAGS)[number];

export interface KeystoneDef {
  id: string;
  cls?: ClassId;
  /** Ability the keystone transforms, if it is tied to one (for the HUD: its icon gets a keystone frame). */
  slot?: AbilitySlot;
  tags: BuildTag[];
  params: Record<string, number>;
  /** English reference texts; client i18n mirrors by id (`keystone.<id>.name` / `.body` / `.cost`). */
  name: string;
  summary: string;
  /** The price or downside, if any (shown separately so the trade is obvious). */
  cost: string;
}

export const KEYSTONES: KeystoneDef[] = [
  // ---- how you move
  { id: 'ember_wake', slot: 'dash', tags: ['dash', 'status', 'area'], params: { seconds: 3.5, damage: 9, tick: 0.5, width: 1.6 },
    name: 'Blazing Wake', summary: 'Your dash leaves a burning trail for 3.5 s that damages enemies and applies your dash element (Ember without one).', cost: '' },
  { id: 'shockstep', slot: 'dash', tags: ['dash', 'area', 'speed'], params: { damage: 26, radius: 3.2, knockback: 3, charges: 1 },
    name: 'Shockstep', summary: 'Every dash ends in a shockwave that hurls enemies back and applies your dash element. +1 dash charge.', cost: '' },
  { id: 'phase_walker', slot: 'dash', tags: ['dash', 'crit', 'speed'], params: { seconds: 2, crit: 1, haste: 0.5 },
    name: 'Phase Walker', summary: 'Dashing THROUGH an enemy empowers you for 2 s: your next hit is a guaranteed critical hit and your dash recharges 50% faster.', cost: 'Dashing without passing an enemy grants nothing.' },
  // ---- how your primary works
  { id: 'ricochet', slot: 'primary', tags: ['primary', 'projectile', 'melee'], params: { bounces: 2, falloff: 0.7, range: 7, every: 3 },
    name: 'Ricochet', summary: 'Primary projectiles bounce to 2 more enemies. Melee: every 3rd swing throws a blade that bounces.', cost: '' },
  { id: 'chain_lightning', slot: 'primary', tags: ['primary', 'status', 'area'], params: { targets: 3, fraction: 0.5, range: 6 },
    name: 'Chain Lightning', summary: 'Primary hits arc to 3 nearby enemies for 50% damage and apply your primary element to them.', cost: '' },
  { id: 'heavy_hitter', slot: 'primary', tags: ['primary', 'melee', 'crit', 'area'], params: { damage: 1.5, slow: 0.45, area: 0.4, knockback: 2 },
    name: 'Titan Grip', summary: 'Primary attacks deal +150% damage, hit 40% wider and knock enemies back.', cost: 'They are 45% slower.' },
  // ---- how your secondary works
  { id: 'twin_cast', slot: 'secondary', tags: ['secondary', 'area'], params: { delay: 0.45, fraction: 0.65 },
    name: 'Twin Cast', summary: 'Your secondary goes off a second time after 0.45 s at 65% strength.', cost: '' },
  { id: 'blood_price', slot: 'secondary', tags: ['secondary', 'health'], params: { hpFraction: 0.08, minCooldown: 0.6 },
    name: 'Blood Price', summary: 'Your secondary has almost no cooldown.', cost: 'Each use costs 8% of your maximum health (it cannot kill you; at 1 health it will not fire).' },
  // ---- companions and auras
  { id: 'orbit_blades', tags: ['primary', 'melee', 'area', 'summon'], params: { blades: 3, radius: 2.6, damageFraction: 0.45, rpm: 60 },
    name: 'Orbiting Blades', summary: 'Three blades circle you for good, cutting everything they touch for 45% of your primary damage and applying your primary element.', cost: '' },
  { id: 'familiar', tags: ['projectile', 'summon', 'status'], params: { interval: 0.9, damageFraction: 0.6, range: 12 },
    name: 'Glimmer Familiar', summary: 'A wisp follows you and shoots the nearest enemy every 0.9 s for 60% of your primary damage, with your primary element.', cost: '' },
  { id: 'colossus', tags: ['area', 'melee', 'health'], params: { size: 1.25, area: 0.4, knockback: 1.5, hp: 40, moveSpeed: -0.1 },
    name: 'Colossus', summary: 'You grow by a quarter: all your areas are 40% larger, your hits knock back, +40 maximum health.', cost: 'You move 10% slower.' },
  // ---- how you win fights
  { id: 'corpse_bloom', tags: ['status', 'kill', 'area', 'resonance'], params: { radius: 3, damage: 20 },
    name: 'Corpse Bloom', summary: 'An enemy that dies while carrying a status bursts, damaging enemies around it and passing that status on — chains can clear a room.', cost: '' },
  { id: 'resonance_engine', slot: 'ultimate', tags: ['ultimate', 'resonance'], params: { perResonance: 14, burstArea: 0.3 },
    name: 'Resonance Engine', summary: 'Each Resonance you trigger charges 14% of your ultimate, and your bursts are 30% larger.', cost: 'Your ultimate no longer charges from damage dealt or taken.' },
  { id: 'glass_cannon', tags: ['crit', 'primary', 'secondary'], params: { damage: 0.6, hp: 0.5 },
    name: 'Glass Cannon', summary: '+60% damage with everything.', cost: 'Your maximum health is halved.' },
  { id: 'sanguine', tags: ['health', 'kill', 'melee'], params: { leech: 0.03, overheal: 30 },
    name: 'Sanguine Pact', summary: 'Heal for 3% of all damage you deal; healing beyond full health becomes a shield (up to 30).', cost: 'Blessing doors, hallowed ground and other heroes no longer heal you.' },
  { id: 'momentum_engine', tags: ['speed', 'kill', 'primary'], params: { perKill: 0.04, max: 10, seconds: 5 },
    name: 'Bloodrush', summary: 'Each kill grants +4% attack and movement speed for 5 s, up to 10 stacks; kills refresh all stacks.', cost: '' },
  // ---- class keystones
  { id: 'ks_knight', cls: 'knight', slot: 'secondary', tags: ['shield', 'area', 'secondary'], params: { fraction: 1.5, radius: 3.2 },
    name: 'Shieldburst', summary: 'Knight: whenever a shield of yours breaks or runs out, it bursts for 150% of what it held.', cost: '' },
  { id: 'ks_barbarian', cls: 'barbarian', slot: 'secondary', tags: ['secondary', 'area', 'melee'], params: { pull: 5, moveMul: 1, duration: 0.5 },
    name: 'Maelstrom', summary: 'Barbarian: Whirlwind drags enemies towards you, lasts 50% longer and no longer slows you; Skullsplitter leaves a whirlwind where you land.', cost: '' },
  { id: 'ks_mage', cls: 'mage', slot: 'primary', tags: ['primary', 'projectile', 'status'], params: { tick: 0.12, damageFraction: 0.42, range: 13, width: 0.6, slow: 0.3 },
    name: 'Arc Stream', summary: 'Mage: your arc bolt becomes a continuous beam while you hold the button; it pierces everything and applies your element with every pulse.', cost: 'You move 30% slower while channelling.' },
  { id: 'ks_rogue', cls: 'rogue', slot: 'primary', tags: ['primary', 'projectile', 'crit'], params: { every: 5, knives: 5 },
    name: 'Fan the Hammer', summary: 'Rogue: every 5th bolt also throws a full knife fan.', cost: '' },
  { id: 'ks_templar', cls: 'templar', slot: 'secondary', tags: ['secondary', 'area', 'health'], params: { follow: 1, duration: 0.5 },
    name: 'Walking Sanctum', summary: 'Templar: your hallowed ground follows you and lasts 50% longer.', cost: '' },
  { id: 'ks_spellblade', cls: 'spellblade', slot: 'primary', tags: ['primary', 'projectile', 'melee'], params: { fraction: 0.5 },
    name: 'Blade Tempest', summary: 'Spellblade: every cut also sends out a blade wave at 50% strength; the finisher sends three.', cost: '' },
  { id: 'ks_shade', cls: 'shade', slot: 'dash', tags: ['dash', 'crit', 'kill'], params: { stealth: 1.5, damage: 0.5 },
    name: 'Veil of Knives', summary: 'Shade: a backstab kill resets a dash charge and veils you for 1.5 s — enemies lose track of you and your next hit deals +50% damage.', cost: '' },
];

export const KEYSTONE_BY_ID: ReadonlyMap<string, KeystoneDef> = new Map(KEYSTONES.map((k) => [k.id, k]));

export const KEYSTONE_TUNING = {
  CHOICES: 3,
  MAX_HELD: 2,
  /** Draft weight multiplier of an ordinary boon for each tag it shares with a held keystone (capped). */
  TAG_WEIGHT: 1.6, TAG_WEIGHT_CAP: 3,
  /** From this many shared tags on, a boon is marked as fitting the build. */
  FIT_TAGS: 1,
  /**
   * Fewer plain percentages: once a hero holds a keystone, common boons without any shared tag are rolled at
   * this fraction of their weight.
   */
  OFF_BUILD_COMMON_WEIGHT: 0.5,
  /** Draft weight of the hero's class keystone in a keystone draft (a generic keystone weighs 1). */
  CLASS_WEIGHT: 4,
  /** After skipping a keystone draft the consolation draft keeps at least this many seconds on the clock. */
  CONSOLATION_SECONDS: 20,
} as const;

/**
 * Hard limits that keep keystone combinations from running away (the simulation enforces every one of them;
 * shared/test/update5-safety.test.ts checks them).
 */
export const KEYSTONE_CAPS = {
  /** `keystoneProc` events of one hero and keystone: bursts are at least this far apart, at most PROC_BURST events per burst (one tick). */
  PROC_SECONDS: 0.15, PROC_BURST: 3,
  /** Blazing Wake: trails of one hero that burn at the same time (the oldest goes out). */
  TRAILS_PER_HERO: 4,
  /** Orbiting Blades: one enemy is cut by one hero's blades at most once per this many seconds; blade hit radius. */
  BLADE_HIT_SECONDS: 0.33, BLADE_HIT_RADIUS: 0.7,
  /** Chain Lightning: seconds between two bursts of arcs of one hero (arcs never arc again). */
  CHAIN_SECONDS: 0.3,
  /** Corpse Bloom: bursts resolved per tick, delay of a burst after the death, bursts that can wait at once. */
  BLOOMS_PER_TICK: 4, BLOOM_DELAY: 0.15, BLOOM_QUEUE: 48,
  /** Lasting zones (hallowed ground, smoke, maelstroms; not traps) one hero can have at once: the oldest ends. */
  ZONES_PER_HERO: 4,
  /** Sanguine Pact: leeched health is paid out in steps this many seconds apart. */
  LEECH_SECONDS: 0.5,
  /** Twin casts waiting to go off per hero. */
  TWINS_PENDING: 4,
} as const;

/** Tags of an ordinary boon, derived from its slot, category and element (no table to maintain). */
export function boonTags(boon: BoonDef): BuildTag[] {
  const tags = new Set<BuildTag>();
  if (boon.slot) tags.add(boon.slot);
  switch (boon.category) {
    case 'infusion': case 'element': tags.add('status'); break;
    case 'resonance': case 'duo': tags.add('resonance'); tags.add('status'); break;
    case 'mobility': tags.add('speed'); break;
    case 'ultimate': tags.add('ultimate'); break;
    default: break;
  }
  const extra = BOON_TAGS[boon.id];
  if (extra) for (const tag of extra) tags.add(tag);
  return [...tags];
}

/** Tags that slot / category do not give away. */
const BOON_TAGS: Record<string, BuildTag[]> = {
  keen_edge: ['primary'], heavy_hand: ['secondary'], swift_strikes: ['primary', 'speed'], deadeye: ['crit'], executioner: ['kill'],
  iron_heart: ['health'], barrier: ['shield'], leech: ['health', 'kill'], last_stand: ['health'],
  fleet_foot: ['speed'], quick_step: ['dash'], spare_step: ['dash'], quick_wits: ['secondary'],
  momentum: ['primary', 'speed'], giant_slayer: ['crit'], overkill: ['kill', 'area'], first_blood: ['crit'], brutality: ['crit'],
  thorns: ['melee'], mending: ['health'], stoneskin: ['health'], crystal_ward: ['shield', 'resonance'],
  slipstream: ['dash', 'speed'], afterimage: ['dash', 'area'], catalyst: ['status'], chain_reaction: ['kill', 'resonance'],
  covenant: ['shield'], rally: ['health', 'ultimate'], wide_resonance: ['area'], aftershock: ['dash', 'secondary'],
  knight_aegis: ['shield'], knight_cleave: ['melee', 'area'], barb_fury: ['area'], barb_reach: ['melee', 'area'],
  mage_split: ['projectile'], mage_expanse: ['area'], rogue_pierce: ['projectile'], rogue_fan: ['projectile'],
  templar_grace: ['health', 'area'], templar_weight: ['melee'], spell_surge: ['projectile'], spell_flux: ['secondary'],
  shade_venom: ['melee', 'crit'], shade_reach: ['dash'],
};

/** Tags shared between a boon and the keystones a hero holds. */
export function sharedTags(boonId: string, keystoneIds: readonly string[]): BuildTag[] {
  const boon = BOON_BY_ID.get(boonId);
  if (!boon) return [];
  const mine = boonTags(boon);
  const held = new Set<BuildTag>();
  for (const id of keystoneIds) for (const tag of KEYSTONE_BY_ID.get(id)?.tags ?? []) held.add(tag);
  return mine.filter((tag) => held.has(tag));
}
