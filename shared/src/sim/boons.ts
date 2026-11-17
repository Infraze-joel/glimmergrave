/** Boon bookkeeping: stat aggregation, applying picks, and draft generation. */
import { BOONS, BOON_BY_ID, BOON_TUNING, type BoonDef } from '../data/boons.ts';
import { addMods, emptyMods } from '../data/mods.ts';
import { REACTIONS } from '../data/reactions.ts';
import type { AbilitySlot, BoonOffer, BoonStack, ElementId } from '../types.ts';
import { classBoonMatters, refreshHero } from './build.ts';
import type { Rng } from './rng.ts';
import type { BoonStats, DraftOptions, Hero } from './state.ts';

export type { DraftOptions };

/** Kinship boons that only do something once the owner can trigger Resonance. */
const NEEDS_INFUSION: ReadonlySet<string> = new Set(['shared_vigor', 'crystal_ward', 'covenant']);

export function emptyStats(): BoonStats {
  return {
    primaryDamage: 0, secondaryDamage: 0, attackSpeed: 1, crit: 0, execute: 0, bonusHp: 0, barrier: 0, leech: 0,
    lastStand: false, moveSpeed: 1, dashRecharge: 1, extraDash: 0, secondaryCdr: 0, wildfire: 0, deepFrost: 0,
    overcharge: 0, amplifier: 0, wideResonance: 0, aftershock: 0, echo: 0, kindred: 0, sharedVigor: 0, lifeline: 0,
    oathbond: 0,
    momentum: 0, giantSlayer: 0, overkill: 0, firstBlood: 0, brutality: 0, thorns: 0, mending: 0, crystalWard: 0,
    slipstream: 0, afterimage: 0, catalyst: 0, chainReaction: false, crescendo: 0, encore: 0, openingAct: 0, covenant: 0,
    rally: 0, creepingDark: 0,
    duo: { shatter: 0, conflagration: 0, superconduct: 0, soulfire: 0, entomb: 0, voidarc: 0 },
    mods: emptyMods(),
    infusion: { primary: null, secondary: null, dash: null, ultimate: null },
  };
}

export function boonValue(def: BoonDef, level: number): number {
  return def.values[Math.min(level, def.values.length) - 1] ?? 0;
}

export function computeStats(boons: readonly BoonStack[]): BoonStats {
  const s = emptyStats();
  for (const stack of boons) {
    const def = BOON_BY_ID.get(stack.id);
    if (!def || stack.level < 1) continue;
    const v = boonValue(def, stack.level);
    if (def.category === 'infusion') {
      if (def.element && def.slot) s.infusion[def.slot] = { element: def.element, potency: v };
      continue;
    }
    if (def.mods) addMods(s.mods, def.mods, v);
    if (def.reaction) { s.duo[def.reaction] = v; continue; }
    switch (def.id) {
      case 'keen_edge': s.primaryDamage = v; break;
      case 'heavy_hand': s.secondaryDamage = v; break;
      case 'swift_strikes': s.attackSpeed = 1 + v; break;
      case 'deadeye': s.crit = v; break;
      case 'executioner': s.execute = v; break;
      case 'iron_heart': s.bonusHp = v; break;
      case 'barrier': s.barrier = v; break;
      case 'leech': s.leech = v; break;
      case 'last_stand': s.lastStand = true; break;
      case 'fleet_foot': s.moveSpeed = 1 + v; break;
      case 'quick_step': s.dashRecharge = 1 + v; break;
      case 'spare_step': s.extraDash = v; break;
      case 'quick_wits': s.secondaryCdr = v; break;
      case 'wildfire': s.wildfire = v; break;
      case 'deep_frost': s.deepFrost = v; break;
      case 'overcharge': s.overcharge = v; break;
      case 'amplifier': s.amplifier = v; break;
      case 'wide_resonance': s.wideResonance = v; break;
      case 'aftershock': s.aftershock = v; break;
      case 'echo': s.echo = v; break;
      case 'kindred_flame': s.kindred = v; break;
      case 'shared_vigor': s.sharedVigor = v; break;
      case 'lifeline': s.lifeline = v; break;
      case 'oathbond': s.oathbond = v; break;
      case 'momentum': s.momentum = v; break;
      case 'giant_slayer': s.giantSlayer = v; break;
      case 'overkill': s.overkill = v; break;
      case 'first_blood': s.firstBlood = v; break;
      case 'brutality': s.brutality = v; break;
      case 'thorns': s.thorns = v; break;
      case 'mending': s.mending = v; break;
      case 'stoneskin': s.mods.damageTaken += v; break;
      case 'crystal_ward': s.crystalWard = v; break;
      case 'slipstream': s.slipstream = v; break;
      case 'afterimage': s.afterimage = v; break;
      case 'catalyst': s.catalyst = v; break;
      case 'chain_reaction': s.chainReaction = true; break;
      case 'zealot': s.mods.ultCharge += v; break;
      case 'crescendo': s.crescendo = v; break;
      case 'encore': s.encore = v; break;
      case 'opening_act': s.openingAct = v; break;
      case 'covenant': s.covenant = v; break;
      case 'rally': s.rally = v; break;
      case 'creeping_dark': s.creepingDark = v; break;
      default: break;
    }
  }
  return s;
}

export function boonLevel(boons: readonly BoonStack[], id: string): number {
  for (const b of boons) if (b.id === id) return b.level;
  return 0;
}

export function maxDashCharges(h: Hero): number {
  return h.def.dashCharges + h.stats.extraDash + h.mods.dashCharges;
}

/**
 * Adds one level of `id` to the hero and applies its immediate effects (health, shield, charges).
 * Returns the new level, or 0 if the boon is unknown or already maxed.
 */
export function applyBoon(h: Hero, id: string, onSet?: (id: string, tier: number) => void): number {
  const def = BOON_BY_ID.get(id);
  if (!def) return 0;
  const current = boonLevel(h.boons, id);
  if (current >= def.values.length) return 0;
  if (def.category === 'infusion' && def.slot) {
    // An ability carries a single infusion: picking a new element replaces the old one.
    const slot: AbilitySlot = def.slot;
    h.boons = h.boons.filter((b) => {
      if (b.id === id) return true;
      const other = BOON_BY_ID.get(b.id);
      return !(other && other.category === 'infusion' && other.slot === slot);
    });
  }
  const stack = h.boons.find((b) => b.id === id);
  if (stack) stack.level = current + 1;
  else h.boons.push({ id, level: 1 });
  const before = h.stats;
  const beforeMaxHp = h.maxHp;
  const beforeCharges = maxDashCharges(h);
  const raised = refreshHero(h);
  const hpGain = h.maxHp - beforeMaxHp;
  if (hpGain !== 0) {
    if (h.state === 'alive') h.hp = Math.min(h.maxHp, h.hp + Math.max(0, hpGain));
    else h.hp = Math.min(h.hp, h.maxHp);
  }
  if (h.stats.barrier !== before.barrier) h.barrier = h.stats.barrier;
  const charges = maxDashCharges(h);
  if (charges > beforeCharges) h.dashCharges = Math.min(charges, h.dashCharges + (charges - beforeCharges));
  else if (h.dashCharges > charges) h.dashCharges = charges;
  if (onSet) for (const r of raised) onSet(r.id, r.tier);
  return current + 1;
}

export function heroElements(h: Hero): Set<ElementId> {
  const out = new Set<ElementId>();
  const inf = h.stats.infusion;
  if (inf.primary) out.add(inf.primary.element);
  if (inf.secondary) out.add(inf.secondary.element);
  if (inf.dash) out.add(inf.dash.element);
  if (inf.ultimate) out.add(inf.ultimate.element);
  return out;
}

/** May this boon be offered to the hero right now? */
export function isOfferable(h: Hero, def: BoonDef): boolean {
  if (boonLevel(h.boons, def.id) >= def.values.length) return false;
  if (def.cls !== undefined && def.cls !== h.cls) return false;
  if (def.category === 'class') return classBoonMatters(h, def.id);
  if (def.category === 'duo') {
    // Duo boons need infusions of both elements of their reaction.
    const reaction = REACTIONS.find((r) => r.id === def.reaction);
    if (!reaction) return false;
    const own = heroElements(h);
    return own.has(reaction.pair[0]) && own.has(reaction.pair[1]);
  }
  if (def.category === 'element') return def.element !== undefined && heroElements(h).has(def.element);
  if (def.category === 'resonance' || NEEDS_INFUSION.has(def.id)) return heroElements(h).size > 0;
  return true;
}

/**
 * `exclude` (rerolls): offers that were just shown. They are only offered again when there are not enough
 * alternatives to fill the draft.
 */
export function generateDraft(rng: Rng, h: Hero, opts: DraftOptions, exclude?: ReadonlySet<string>): BoonOffer[] {
  const offerable = BOONS.filter((def) => isOfferable(h, def) && (!opts.infusionsOnly || def.category === 'infusion'));
  const pool = exclude ? offerable.filter((def) => !exclude.has(def.id)) : offerable;
  const picked: BoonDef[] = [];
  const take = (from: BoonDef[], candidates: BoonDef[]): void => {
    if (candidates.length === 0) return;
    const index = rng.weighted(candidates.map((def) => BOON_TUNING.WEIGHTS[def.rarity]));
    const def = candidates[index];
    if (!def) return;
    picked.push(def);
    from.splice(from.indexOf(def), 1);
  };
  if (opts.guaranteeInfusion) take(pool, pool.filter((def) => def.category === 'infusion'));
  if (opts.guaranteeRare && !picked.some((def) => def.rarity !== 'common')) take(pool, pool.filter((def) => def.rarity !== 'common'));
  while (picked.length < opts.choices && pool.length > 0) take(pool, pool);
  if (exclude && picked.length < opts.choices) {
    const again = offerable.filter((def) => exclude.has(def.id));
    while (picked.length < opts.choices && again.length > 0) take(again, again);
  }
  // Shuffle so the guaranteed offers are not always in the first position.
  for (let i = picked.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    const tmp = picked[i] as BoonDef;
    picked[i] = picked[j] as BoonDef;
    picked[j] = tmp;
  }
  return picked.map((def) => ({ id: def.id, level: boonLevel(h.boons, def.id) + 1 }));
}
