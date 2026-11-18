/**
 * Permanent progression. Heroes earn Glimmer at the end of every run (win or lose) and spend it on upgrades
 * that apply to all their future runs. There are no accounts: levels live in the player's browser and are
 * sent with the loadout. The server clamps every level to 0..maxLevel, so the worst a tampered client can
 * claim is a fully upgraded hero — acceptable for a co-op game without competition.
 */
import { CLASS_IDS, type ClassId, type Look } from '../types.ts';
import type { Mods } from './mods.ts';

export interface MetaUpgradeDef {
  id: string;
  /** costs[level] = Glimmer price of going from `level` to `level + 1`; maxLevel = costs.length. */
  costs: number[];
  /** values[level - 1] = effect magnitude at that level. Fractions for percentages (0.04 = 4 %). */
  values: number[];
  /** English reference text; {v} = value at the level. Client i18n mirrors these by id. */
  summary: string;
}

/** Order is part of the wire format (Loadout.meta is aligned with it). Append only. */
export const META_UPGRADES: MetaUpgradeDef[] = [
  { id: 'vitality', costs: [40, 70, 110, 160, 220, 300, 400, 520], values: [5, 10, 15, 20, 25, 30, 35, 40], summary: '+{v} maximum health.' },
  { id: 'might', costs: [50, 90, 140, 200, 270, 360, 470, 600], values: [0.03, 0.06, 0.09, 0.12, 0.15, 0.18, 0.21, 0.24], summary: '+{v}% damage with everything.' },
  { id: 'swiftness', costs: [60, 120, 200], values: [0.03, 0.06, 0.09], summary: '+{v}% movement speed.' },
  { id: 'celerity', costs: [60, 120, 200], values: [0.06, 0.12, 0.18], summary: 'Secondary ability recharges {v}% faster.' },
  { id: 'footwork', costs: [60, 120, 200], values: [0.08, 0.16, 0.24], summary: 'Dash recharges {v}% faster.' },
  { id: 'insight', costs: [80, 160, 260], values: [1, 2, 3], summary: '{v} draft reroll(s) per run: replace the offered boons once each.' },
  { id: 'attunement', costs: [150], values: [1], summary: 'Begin every run with a free Infusion draft (choose 1 of 3 elements for an ability).' },
  { id: 'resolve', costs: [120, 240], values: [0.25, 0.5], summary: 'When revived (or on a Second Wind) return with {v}% more health and 2 s of invulnerability.' },
  { id: 'fortune', costs: [70, 140, 230], values: [0.1, 0.2, 0.3], summary: '+{v}% Glimmer from every run.' },
  // ---- update 3 (append only)
  { id: 'ferocity', costs: [80, 150, 240, 350, 480], values: [0.02, 0.04, 0.06, 0.08, 0.1], summary: '+{v}% chance to critically hit.' },
  { id: 'tempo', costs: [80, 160, 260], values: [0.03, 0.06, 0.09], summary: 'Primary attacks are {v}% faster.' },
  { id: 'zeal', costs: [90, 180, 300], values: [0.08, 0.16, 0.24], summary: 'Your ultimate charges {v}% faster.' },
  { id: 'warding', costs: [70, 140, 230], values: [8, 16, 24], summary: 'Begin every chamber with a {v} point shield.' },
  { id: 'scholar', costs: [90, 180, 300], values: [0.1, 0.2, 0.3], summary: '+{v}% mastery experience from every run.' },
  { id: 'reliquary', costs: [300, 900], values: [1, 2], summary: '+{v} relic slot(s).' },
  { id: 'salvage', costs: [120, 240, 400], values: [0.08, 0.16, 0.24], summary: '+{v}% chance on every relic drop.' },
  { id: 'foresight', costs: [700], values: [1], summary: 'Every boon draft offers one more choice.' },
  { id: 'tenacity', costs: [400], values: [1], summary: 'One more Second Wind per run when alone; in a party you are revived 50% faster.' },
];

/**
 * Ascension: endless ranks bought with Glimmer once a hero has won a run. Each rank adds `mods` once, with
 * diminishing returns past SOFT_RANK (see paragonEffective), so there is always a next rank worth a little.
 * Order is part of the wire format (Loadout.paragon is aligned with it). Append only.
 */
export interface ParagonDef {
  id: string;
  mods: Partial<Mods>;
  /** English reference text; {v} = total bonus at the rank. */
  summary: string;
}

export const PARAGON: ParagonDef[] = [
  { id: 'asc_might', mods: { damage: 0.01 }, summary: '+{v}% damage.' },
  { id: 'asc_vitality', mods: { maxHp: 2 }, summary: '+{v} maximum health.' },
  { id: 'asc_haste', mods: { secondaryHaste: 0.01, dashHaste: 0.01 }, summary: 'Secondary and dash recharge {v}% faster.' },
  { id: 'asc_precision', mods: { critChance: 0.004 }, summary: '+{v}% critical hit chance.' },
  { id: 'asc_resonance', mods: { resonanceDamage: 0.015 }, summary: '+{v}% Resonance damage.' },
  { id: 'asc_fortune', mods: { glimmer: 0.02 }, summary: '+{v}% Glimmer.' },
  { id: 'asc_wisdom', mods: { xp: 0.02 }, summary: '+{v}% mastery experience.' },
];

export const PARAGON_TUNING = {
  MAX_RANK: 999,
  /** Ranks up to here count fully; beyond, each further rank counts less and less. */
  SOFT_RANK: 25,
  /** Price of rank r + 1 (r = ranks owned) = COST_BASE + COST_LINEAR * r + COST_QUADRATIC * r². */
  COST_BASE: 150, COST_LINEAR: 60, COST_QUADRATIC: 6,
  /** Wins needed before Ascension opens. */
  UNLOCK_WINS: 1,
} as const;

/** Rank after diminishing returns: full up to SOFT_RANK, then SOFT_RANK + 2 * sqrt(rank - SOFT_RANK). */
export function paragonEffective(rank: number): number {
  const r = Math.max(0, Math.min(PARAGON_TUNING.MAX_RANK, Math.floor(rank)));
  return r <= PARAGON_TUNING.SOFT_RANK ? r : PARAGON_TUNING.SOFT_RANK + 2 * Math.sqrt(r - PARAGON_TUNING.SOFT_RANK);
}

/** Glimmer price of the next rank when `rank` ranks are owned; null at MAX_RANK. */
export function paragonCost(rank: number): number | null {
  if (rank >= PARAGON_TUNING.MAX_RANK) return null;
  const r = Math.max(0, Math.floor(rank));
  return PARAGON_TUNING.COST_BASE + PARAGON_TUNING.COST_LINEAR * r + PARAGON_TUNING.COST_QUADRATIC * r * r;
}

/** Clamps untrusted Ascension ranks. Always returns PARAGON.length entries. */
export function sanitizeParagon(raw: unknown): number[] {
  const list = Array.isArray(raw) ? raw : [];
  return PARAGON.map((_, i) => {
    const v = list[i];
    return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(PARAGON_TUNING.MAX_RANK, Math.floor(v))) : 0;
  });
}

export const META_INDEX: ReadonlyMap<string, number> = new Map(META_UPGRADES.map((u, i) => [u.id, i]));

/** Glimmer payout rules (computed by the server when a run ends, before the `fortune` bonus). */
export const REWARDS = {
  PER_CHAMBER_CLEARED: 12,
  PER_ELITE_SLAIN: 18,
  BOSS_SLAIN: 80,
  /** Added per Oath level as a multiplier on the total: 1 + OATH_BONUS * oath. */
  OATH_BONUS: 0.25,
  /** Minimum payout for any finished run, so a first defeat still buys progress. */
  MINIMUM: 10,
  /** One-off payout for finishing the training session. */
  TUTORIAL: 40,
  /** Added per depth as a multiplier on what is earned AT that depth: 1 + DEPTH_BONUS * depth. */
  DEPTH_BONUS: 0.5,
  /** Oath levels above 3 keep adding OATH_BONUS each. */
} as const;

export const LOOK = {
  /** Cloth tints (hex). Index 0 keeps the class's own colours. */
  COLORS: [0x000000, 0xc0392b, 0x2e86de, 0x27ae60, 0xf39c12, 0x8e44ad, 0x16a085, 0xecf0f1, 0x2c3e50, 0xe84393] as const,
  /** Number of gear variants per class. */
  STYLES: 3,
} as const;

/**
 * What `Look.style` means per class (the render kit maps these to the meshes of the hero model):
 *  knight    0 sword + round shield, 1 sword + spiked shield, 2 sword + badge shield
 *  barbarian 0 two-handed axe, 1 axe + round shield, 2 twin axes
 *  mage      0 staff, 1 wand + open spellbook, 2 staff + closed spellbook
 *  rogue     0 heavy crossbow, 1 hand crossbow + knife, 2 heavy crossbow + knife
 *  templar   0 two-handed sword, 1 two-handed sword (ornate) , 2 two-handed sword + back shield   (knight body)
 *  spellblade 0 sword + open spellbook, 1 sword + closed spellbook, 2 sword + wand                (mage body)
 *  shade     0 twin daggers, 1 dagger + hand crossbow (worn, not fired), 2 twin daggers + quiver   (rogue body)
 * Styles are cosmetic only; abilities, reach and damage do not change.
 */
export const DEFAULT_LOOK: Look = { color: 0, head: true, cape: true, style: 0 };

export function defaultLooks(): Record<ClassId, Look> {
  return Object.fromEntries(CLASS_IDS.map((cls) => [cls, { ...DEFAULT_LOOK }])) as Record<ClassId, Look>;
}

/** Clamps untrusted meta levels to valid integers. Always returns META_UPGRADES.length entries. */
export function sanitizeMeta(raw: unknown): number[] {
  const list = Array.isArray(raw) ? raw : [];
  return META_UPGRADES.map((def, i) => {
    const v = list[i];
    return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(def.costs.length, Math.floor(v))) : 0;
  });
}

export function sanitizeLook(raw: unknown): Look {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const int = (v: unknown, max: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(max, Math.floor(v))) : 0);
  return {
    color: int(r.color, LOOK.COLORS.length - 1),
    head: r.head !== false,
    cape: r.cape !== false,
    style: int(r.style, LOOK.STYLES - 1),
  };
}
