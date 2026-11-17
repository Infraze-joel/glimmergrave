/**
 * Class mastery. Every run pays experience to the class that was played (win or lose). Levels never end:
 * the first ones unlock the class's alternative secondary and its talents, every level adds a small permanent
 * bonus for that class. Experience lives in the player's browser; the client sends the level with the loadout
 * and the server clamps what that level allows.
 */
import type { ClassId } from '../types.ts';
import { addMods, emptyMods, type Mods } from './mods.ts';

export const MASTERY = {
  MAX_LEVEL: 999,
  /** Experience from level n to n + 1 = round(XP_BASE * n ^ XP_EXPONENT). */
  XP_BASE: 110, XP_EXPONENT: 1.35,
  /** Level that unlocks ClassDef.arts[0] (the alternative secondary). */
  ART_LEVEL: 2,
  /** Levels that unlock talent tier 1, 2 and 3. */
  TALENT_LEVELS: [3, 6, 10],
  /** Per level above 1: bonus for that class, counted fully up to SOFT_LEVEL and at a quarter beyond. */
  PER_LEVEL: { damage: 0.006, maxHp: 1 } as Partial<Mods>,
  SOFT_LEVEL: 30, BEYOND_SOFT: 0.25,
} as const;

/** Experience rules (computed by the server when a run ends, before the hero's own xp bonuses). */
export const XP_REWARDS = {
  PER_CHAMBER_CLEARED: 22,
  PER_ELITE_SLAIN: 30,
  BOSS_SLAIN: 140,
  OATH_BONUS: 0.25,
  DEPTH_BONUS: 0.5,
  MINIMUM: 15,
  TUTORIAL: 60,
} as const;

export const xpForLevel = (level: number): number => Math.round(MASTERY.XP_BASE * Math.pow(Math.max(1, level), MASTERY.XP_EXPONENT));

/** Level (starting at 1) reached with `xp` total experience, plus progress inside that level. */
export function levelFromXp(xp: number): { level: number; into: number; need: number } {
  let level = 1;
  let rest = Math.max(0, Math.floor(Number.isFinite(xp) ? xp : 0));
  for (let need = xpForLevel(level); rest >= need && level < MASTERY.MAX_LEVEL; need = xpForLevel(level)) {
    rest -= need;
    level++;
  }
  return { level, into: rest, need: xpForLevel(level) };
}

export const sanitizeMastery = (raw: unknown): number =>
  (typeof raw === 'number' && Number.isFinite(raw) ? Math.max(1, Math.min(MASTERY.MAX_LEVEL, Math.floor(raw))) : 1);

/** The permanent bonus of a mastery level. */
export function masteryMods(level: number): Mods {
  const steps = sanitizeMastery(level) - 1;
  const soft = MASTERY.SOFT_LEVEL - 1;
  const effective = steps <= soft ? steps : soft + (steps - soft) * MASTERY.BEYOND_SOFT;
  return addMods(emptyMods(), MASTERY.PER_LEVEL, effective);
}

/**
 * Talents: three tiers per class, two options each, one may be active per tier (free to switch outside a run).
 * Most are plain Mods; `special` names behaviour the simulation implements:
 *  riposte     – knight: after your shield absorbs damage your next primary hit deals double damage
 *  rampage     – barbarian: each kill grants +4 % attack speed for 4 s, up to 5 stacks
 *  arcane_echo – mage: every 4th arc bolt is fired twice
 *  poison_tips – rogue: bolts and knives apply a short Wither
 *  martyr      – templar: you take 20 % of the damage heroes inside your hallowed ground would take, they take none of it
 *  spellweave  – spellblade: using your secondary empowers your next blade wave (+100 % damage, +2 pierce)
 *  ambush      – shade: your first hit on an enemy that is not targeting you is a critical hit
 */
export interface TalentDef {
  id: string;
  cls: ClassId;
  /** 0-based tier. */
  tier: number;
  /** 1 or 2 (the value stored in Loadout.talents[tier]). */
  option: number;
  mods?: Partial<Mods>;
  special?: string;
  /** English reference text; client i18n mirrors by id (`talent.<id>.name` / `.body`). */
  name: string;
  summary: string;
}

const t = (cls: ClassId, tier: number, option: number, id: string, name: string, summary: string, mods?: Partial<Mods>, special?: string): TalentDef =>
  ({ id: `${cls}_${id}`, cls, tier, option, name, summary, mods, special });

export const TALENTS: TalentDef[] = [
  t('knight', 0, 1, 'bastion', 'Bastion', '+20 maximum health and 6% less damage taken.', { maxHp: 20, damageTaken: 0.06 }),
  t('knight', 0, 2, 'vanguard', 'Vanguard', '+10% primary damage and 5% movement speed.', { primaryDamage: 0.1, moveSpeed: 0.05 }),
  t('knight', 1, 1, 'riposte', 'Riposte', 'After your shield absorbs damage, your next primary hit deals double damage.', undefined, 'riposte'),
  t('knight', 1, 2, 'drill', 'Drill', 'Your secondary recharges 25% faster and grants 8 more shield.', { secondaryHaste: 0.25, shieldOnSecondary: 8 }),
  t('knight', 2, 1, 'standard', 'Standard Bearer', 'Your ultimate charges 30% faster.', { ultCharge: 0.3 }),
  t('knight', 2, 2, 'unbroken', 'Unbroken', 'Begin every chamber with a 30 point shield and take 6% less damage.', { startShield: 30, damageTaken: 0.06 }),

  t('barbarian', 0, 1, 'thick_hide', 'Thick Hide', '+30 maximum health.', { maxHp: 30 }),
  t('barbarian', 0, 2, 'bloodthirst', 'Bloodthirst', 'Heal 3 health per kill.', { lifeOnKill: 3 }),
  t('barbarian', 1, 1, 'rampage', 'Rampage', 'Each kill grants +4% attack speed for 4 s (up to 5 stacks).', undefined, 'rampage'),
  t('barbarian', 1, 2, 'earthshaker', 'Earthshaker', 'All your areas are 20% larger.', { area: 0.2 }),
  t('barbarian', 2, 1, 'warlord', 'Warlord', '+12% damage.', { damage: 0.12 }),
  t('barbarian', 2, 2, 'undying', 'Undying Rage', 'Your ultimate charges 25% faster and you take 8% less damage.', { ultCharge: 0.25, damageTaken: 0.08 }),

  t('mage', 0, 1, 'focus', 'Focus', '+12% primary damage.', { primaryDamage: 0.12 }),
  t('mage', 0, 2, 'ward', 'Mana Ward', 'Begin every chamber with a 25 point shield.', { startShield: 25 }),
  t('mage', 1, 1, 'arcane_echo', 'Arcane Echo', 'Every 4th arc bolt is fired twice.', undefined, 'arcane_echo'),
  t('mage', 1, 2, 'attuned', 'Attuned', 'Your statuses are 30% stronger.', { elementPotency: 0.3 }),
  t('mage', 2, 1, 'cataclysm', 'Cataclysm', '+25% secondary and ultimate damage.', { secondaryDamage: 0.25, ultimateDamage: 0.25 }),
  t('mage', 2, 2, 'resonant', 'Resonant Mind', '+30% Resonance damage.', { resonanceDamage: 0.3 }),

  t('rogue', 0, 1, 'quickdraw', 'Quickdraw', 'Primary attacks are 10% faster.', { attackSpeed: 0.1 }),
  t('rogue', 0, 2, 'light_feet', 'Light Feet', '+6% movement speed; dash recharges 20% faster.', { moveSpeed: 0.06, dashHaste: 0.2 }),
  t('rogue', 1, 1, 'poison_tips', 'Poison Tips', 'Your bolts and knives apply a short Wither.', undefined, 'poison_tips'),
  t('rogue', 1, 2, 'marksman', 'Marksman', '+8% critical hit chance and +30% critical damage.', { critChance: 0.08, critDamage: 0.3 }),
  t('rogue', 2, 1, 'trickster', 'Trickster', 'Your secondary recharges 35% faster.', { secondaryHaste: 0.35 }),
  t('rogue', 2, 2, 'hail', 'Hail of Bolts', '+35% ultimate damage and it charges 15% faster.', { ultimateDamage: 0.35, ultCharge: 0.15 }),

  t('templar', 0, 1, 'devotion', 'Devotion', '+25 maximum health; revive allies 40% faster.', { maxHp: 25, reviveSpeed: 0.4 }),
  t('templar', 0, 2, 'wrath', 'Wrath', '+10% damage.', { damage: 0.1 }),
  t('templar', 1, 1, 'martyr', 'Martyr', 'Heroes on your hallowed ground take 20% less damage; you take that share instead.', undefined, 'martyr'),
  t('templar', 1, 2, 'hallowed', 'Hallowed Reach', 'All your areas are 25% larger.', { area: 0.25 }),
  t('templar', 2, 1, 'crusader', 'Crusader', 'Primary attacks are 15% faster.', { attackSpeed: 0.15 }),
  t('templar', 2, 2, 'beacon', 'Beacon', 'Your ultimate charges 35% faster.', { ultCharge: 0.35 }),

  t('spellblade', 0, 1, 'edge', 'Honed Edge', '+10% primary damage.', { primaryDamage: 0.1 }),
  t('spellblade', 0, 2, 'glyphs', 'Glyphs', 'Your statuses are 25% stronger.', { elementPotency: 0.25 }),
  t('spellblade', 1, 1, 'spellweave', 'Spellweave', 'Using your secondary empowers your next blade wave: double damage, +2 pierce.', undefined, 'spellweave'),
  t('spellblade', 1, 2, 'flicker', 'Flicker', 'Your secondary recharges 30% faster and grants a 10 point shield.', { secondaryHaste: 0.3, shieldOnSecondary: 10 }),
  t('spellblade', 2, 1, 'convergence', 'Convergence', '+35% Resonance damage.', { resonanceDamage: 0.35 }),
  t('spellblade', 2, 2, 'duelist', 'Duelist', '+8% critical hit chance and primary attacks are 8% faster.', { critChance: 0.08, attackSpeed: 0.08 }),

  t('shade', 0, 1, 'cutthroat', 'Cutthroat', '+8% critical hit chance.', { critChance: 0.08 }),
  t('shade', 0, 2, 'evasion', 'Evasion', '+1 dash charge.', { dashCharges: 1 }),
  t('shade', 1, 1, 'ambush', 'Ambush', 'Your first hit on an enemy that is not targeting you is a critical hit.', undefined, 'ambush'),
  t('shade', 1, 2, 'bleed', 'Deep Cuts', '+40% critical damage.', { critDamage: 0.4 }),
  t('shade', 2, 1, 'reaper', 'Reaper', 'Heal 3 health per kill; +8% damage.', { lifeOnKill: 3, damage: 0.08 }),
  t('shade', 2, 2, 'nightfall', 'Nightfall', 'Your ultimate charges 30% faster and deals +25% damage.', { ultCharge: 0.3, ultimateDamage: 0.25 }),
];

export const TALENT_TIERS = MASTERY.TALENT_LEVELS.length;

export function talentOf(cls: ClassId, tier: number, option: number): TalentDef | null {
  return TALENTS.find((x) => x.cls === cls && x.tier === tier && x.option === option) ?? null;
}

/** Clamps untrusted talent choices to what `mastery` has unlocked. Always returns TALENT_TIERS entries. */
export function sanitizeTalents(raw: unknown, mastery: number): number[] {
  const list = Array.isArray(raw) ? raw : [];
  return MASTERY.TALENT_LEVELS.map((level, tier) => {
    const v = list[tier];
    return mastery >= level && (v === 1 || v === 2) ? v : 0;
  });
}

/** 0 unless `mastery` has unlocked the requested variant and the class has it. */
export function sanitizeArt(raw: unknown, mastery: number, artCount: number): number {
  const v = typeof raw === 'number' && Number.isInteger(raw) ? raw : 0;
  return mastery >= MASTERY.ART_LEVEL && v >= 1 && v <= artCount ? v : 0;
}
