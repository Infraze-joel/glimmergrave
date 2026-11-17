/** Read-only view helpers shared by several screens. */
import { CLASSES } from '@shared/data/classes.ts';
import { BOON_BY_ID, type BoonDef } from '@shared/data/boons.ts';
import { RUN } from '@shared/constants.ts';
import { CLASS_IDS, type AbilitySlot, type BoonStack, type ClassId, type ElementId, type RosterEntry } from '@shared/types.ts';
import { state } from '../core/GameState.ts';
import type { IconName } from './icons.ts';
import { t, type I18nKey } from './i18n.ts';

export const ABILITY_SLOTS: readonly AbilitySlot[] = ['primary', 'secondary', 'dash'];

export const ABILITY_ICON: Record<ClassId, Record<AbilitySlot, IconName>> = {
  knight: { primary: 'sword', secondary: 'bash', dash: 'dash' },
  barbarian: { primary: 'axe', secondary: 'whirl', dash: 'dash' },
  mage: { primary: 'arcBolt', secondary: 'nova', dash: 'dash' },
  rogue: { primary: 'crossbow', secondary: 'knives', dash: 'dash' },
};

const SPARE_STEP_ID = 'spare_step';
const PERCENT = 100;

export function rosterBySlot(slot: number): RosterEntry | null {
  return state.roster.find((p) => p.slot === slot) ?? null;
}

export function nameOf(slot: number): string {
  const entry = rosterBySlot(slot);
  return entry && entry.name !== '' ? entry.name : `P${slot + 1}`;
}

export function classOf(slot: number): ClassId {
  return rosterBySlot(slot)?.cls ?? 'knight';
}

/** Element infused into an ability slot by the given boons, if any. */
export function infusionOf(boons: BoonStack[], slot: AbilitySlot): ElementId | null {
  for (const stack of boons) {
    const def = BOON_BY_ID.get(stack.id);
    if (def?.category === 'infusion' && def.slot === slot && def.element) return def.element;
  }
  return null;
}

export function maxDashCharges(cls: ClassId, boons: BoonStack[]): number {
  const extra = boons.find((b) => b.id === SPARE_STEP_ID)?.level ?? 0;
  return CLASSES[cls].dashCharges + extra;
}

export function boonIcon(def: BoonDef | undefined): IconName {
  if (!def) return 'gem';
  if (def.element) return def.element;
  return def.category;
}

/** CSS colour for a boon: its element colour, or the neutral category tint. */
export function boonTint(def: BoonDef | undefined): string {
  if (def?.element) return `var(--gg-${def.element})`;
  if (def?.category === 'resonance') return 'var(--gg-glimmer)';
  if (def?.category === 'kinship') return 'var(--gg-gold)';
  return 'var(--gg-text)';
}

export function oathDescription(level: number): string {
  if (level <= 0) return t('oath.0.desc');
  const o = RUN.OATH[Math.min(level, RUN.OATH.length - 1)];
  const pct = (mul: number): number => Math.round((mul - 1) * PERCENT);
  return t('oath.desc', { hp: pct(o.hp), dmg: pct(o.damage), spd: pct(o.speed) });
}

export function oathName(level: number): string {
  const clamped = Math.min(Math.max(0, Math.floor(level)), RUN.OATH.length - 1) as 0 | 1 | 2 | 3;
  return t(`oath.${clamped}.name` as I18nKey);
}

export const MAX_OATH = RUN.OATH.length - 1;

/** Where a class sits between the weakest (0) and strongest (1) class for a stat. */
export function classStat(cls: ClassId, stat: 'maxHp' | 'moveSpeed'): number {
  const values = CLASS_IDS.map((id) => CLASSES[id][stat]);
  const min = Math.min(...values);
  const max = Math.max(...values);
  return max > min ? (CLASSES[cls][stat] - min) / (max - min) : 1;
}

export function inviteLink(code: string): string {
  return `${window.location.origin}${window.location.pathname}?join=${code}`;
}
