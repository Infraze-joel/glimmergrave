/**
 * Permanent progression. Heroes earn Glimmer at the end of every run (win or lose) and spend it on upgrades
 * that apply to all their future runs. There are no accounts: levels live in the player's browser and are
 * sent with the loadout. The server clamps every level to 0..maxLevel, so the worst a tampered client can
 * claim is a fully upgraded hero — acceptable for a co-op game without competition.
 */
import type { ClassId, Look } from '../types.ts';

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
  { id: 'vitality', costs: [40, 70, 110, 160, 220], values: [8, 16, 24, 32, 40], summary: '+{v} maximum health.' },
  { id: 'might', costs: [50, 90, 140, 200, 270], values: [0.04, 0.08, 0.12, 0.16, 0.2], summary: '+{v}% damage with everything.' },
  { id: 'swiftness', costs: [60, 120, 200], values: [0.03, 0.06, 0.09], summary: '+{v}% movement speed.' },
  { id: 'celerity', costs: [60, 120, 200], values: [0.06, 0.12, 0.18], summary: 'Secondary ability recharges {v}% faster.' },
  { id: 'footwork', costs: [60, 120, 200], values: [0.08, 0.16, 0.24], summary: 'Dash recharges {v}% faster.' },
  { id: 'insight', costs: [80, 160, 260], values: [1, 2, 3], summary: '{v} draft reroll(s) per run: replace the offered boons once each.' },
  { id: 'attunement', costs: [150], values: [1], summary: 'Begin every run with a free Infusion draft (choose 1 of 3 elements for an ability).' },
  { id: 'resolve', costs: [120, 240], values: [0.25, 0.5], summary: 'When revived (or on a Second Wind) return with {v}% more health and 2 s of invulnerability.' },
  { id: 'fortune', costs: [70, 140, 230], values: [0.1, 0.2, 0.3], summary: '+{v}% Glimmer from every run.' },
];

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
 * Styles are cosmetic only; abilities, reach and damage do not change.
 */
export const DEFAULT_LOOK: Look = { color: 0, head: true, cape: true, style: 0 };

export function defaultLooks(): Record<ClassId, Look> {
  return { knight: { ...DEFAULT_LOOK }, barbarian: { ...DEFAULT_LOOK }, mage: { ...DEFAULT_LOOK }, rogue: { ...DEFAULT_LOOK } };
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
