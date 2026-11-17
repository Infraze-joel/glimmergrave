/**
 * The common vocabulary of passive bonuses. Talents, relics, Ascension ranks, mastery levels and set bonuses
 * are all expressed as (partial) Mods, so the simulation adds them up once per hero and reads plain numbers.
 * Fractions are stored as fractions (0.1 = 10 %). Everything defaults to 0.
 */
export interface Mods {
  /** Flat maximum health. */
  maxHp: number;
  /** Fraction added to all damage the hero deals. */
  damage: number;
  primaryDamage: number;
  secondaryDamage: number;
  ultimateDamage: number;
  /** Primary attacks are this much faster (cooldown, windup and lock are divided by 1 + value). */
  attackSpeed: number;
  moveSpeed: number;
  /** Recharge rate bonuses (cooldown is divided by 1 + value). */
  secondaryHaste: number;
  dashHaste: number;
  /** Ultimate charge gained is multiplied by 1 + value. */
  ultCharge: number;
  critChance: number;
  /** Added to the critical hit multiplier (base x2). */
  critDamage: number;
  /** Extra dash charges (whole numbers). */
  dashCharges: number;
  /** Fraction of incoming damage ignored. The sum over all sources is capped at MODS_CAPS.damageTaken. */
  damageTaken: number;
  /** Health restored per kill. */
  lifeOnKill: number;
  /** Shield gained whenever the secondary ability is used. */
  shieldOnSecondary: number;
  /** Shield at the start of every chamber. */
  startShield: number;
  /** Status effects applied by the hero are this much stronger (Burn damage, Chill slow, Shock and Wither amount). */
  elementPotency: number;
  resonanceDamage: number;
  /** Ability areas (arc reach, blast radius, zone radius) are this much larger. */
  area: number;
  reviveSpeed: number;
  /** Glimmer and mastery XP earned from runs. */
  glimmer: number;
  xp: number;
  /** Added to every relic drop chance (data/relics.ts). */
  relicFind: number;
}

export const ZERO_MODS: Readonly<Mods> = {
  maxHp: 0, damage: 0, primaryDamage: 0, secondaryDamage: 0, ultimateDamage: 0, attackSpeed: 0, moveSpeed: 0,
  secondaryHaste: 0, dashHaste: 0, ultCharge: 0, critChance: 0, critDamage: 0, dashCharges: 0, damageTaken: 0,
  lifeOnKill: 0, shieldOnSecondary: 0, startShield: 0, elementPotency: 0, resonanceDamage: 0, area: 0,
  reviveSpeed: 0, glimmer: 0, xp: 0, relicFind: 0,
};

/** Upper bounds applied after summing all sources, so endless progression cannot break the game's rules. */
export const MODS_CAPS: Partial<Record<keyof Mods, number>> = {
  damageTaken: 0.6, critChance: 0.75, attackSpeed: 1, moveSpeed: 0.6, secondaryHaste: 2, dashHaste: 2, area: 0.75,
};

export const MOD_KEYS = Object.keys(ZERO_MODS) as (keyof Mods)[];

export const emptyMods = (): Mods => ({ ...ZERO_MODS });

/** target += source * scale (in place). Returns target. */
export function addMods(target: Mods, source: Partial<Mods> | undefined, scale = 1): Mods {
  if (!source) return target;
  for (const key of MOD_KEYS) {
    const v = source[key];
    if (typeof v === 'number') target[key] += v * scale;
  }
  return target;
}

/** Applies MODS_CAPS and makes whole-number stats whole (in place). Call once after summing. */
export function capMods(mods: Mods): Mods {
  for (const key of MOD_KEYS) {
    const cap = MODS_CAPS[key];
    if (cap !== undefined && mods[key] > cap) mods[key] = cap;
  }
  mods.dashCharges = Math.floor(mods.dashCharges);
  return mods;
}
