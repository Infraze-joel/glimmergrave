/** Read-only view helpers shared by several screens. */
import { BACKSTAB, CLASSES, TRAP, secondaryOf, type AbilityDef } from '@shared/data/classes.ts';
import { BOON_BY_ID, type BoonDef } from '@shared/data/boons.ts';
import { RUN, oathScale } from '@shared/constants.ts';
import { CLASS_IDS, type AbilitySlot, type BoonStack, type ClassId, type ElementId, type RosterEntry } from '@shared/types.ts';
import { state } from '../core/GameState.ts';
import type { IconName } from './icons.ts';
import { roman, t } from './i18n.ts';

/** The three abilities of the classic bar (cooldowns, pips). The ultimate is drawn apart from them. */
export const ABILITY_SLOTS: readonly AbilitySlot[] = ['primary', 'secondary', 'dash'];
/** Every ability of a hero that can carry an Infusion, in ability-bar order. */
export const HERO_SLOTS: readonly AbilitySlot[] = ['primary', 'secondary', 'dash', 'ultimate'];

export const ABILITY_ICON: Record<ClassId, Record<AbilitySlot, IconName>> = {
  knight: { primary: 'sword', secondary: 'bash', dash: 'dash', ultimate: 'banner' },
  barbarian: { primary: 'axe', secondary: 'whirl', dash: 'dash', ultimate: 'rage' },
  mage: { primary: 'arcBolt', secondary: 'nova', dash: 'dash', ultimate: 'meteor' },
  rogue: { primary: 'crossbow', secondary: 'knives', dash: 'dash', ultimate: 'volley' },
  templar: { primary: 'greatsword', secondary: 'consecrate', dash: 'dash', ultimate: 'sanctuary' },
  spellblade: { primary: 'bladeWave', secondary: 'blink', dash: 'dash', ultimate: 'overload' },
  shade: { primary: 'daggers', secondary: 'shadowstep', dash: 'dash', ultimate: 'mark' },
};

/** Icon of the alternative secondary ("art") of a class. */
export const ART_ICON: Record<ClassId, IconName> = {
  knight: 'disc', barbarian: 'leap', mage: 'beam', rogue: 'trap', templar: 'judgement', spellblade: 'ward', shade: 'smoke',
};

/** How demanding a class is to play well (1 easy .. 3 hard), shown as a hint on the class cards. */
export const CLASS_DIFFICULTY: Record<ClassId, 1 | 2 | 3> = {
  knight: 1, barbarian: 1, mage: 2, rogue: 2, templar: 2, spellblade: 3, shade: 3,
};

/** `art` > 0 and the class has that variant. */
export function hasArt(cls: ClassId, art: number): boolean {
  return art > 0 && CLASSES[cls].arts[art - 1] !== undefined;
}

/** Icon of an ability slot; the secondary follows the equipped art. */
export function abilityIcon(cls: ClassId, slot: AbilitySlot, art = 0): IconName {
  return slot === 'secondary' && hasArt(cls, art) ? ART_ICON[cls] : ABILITY_ICON[cls][slot];
}

/** Name / description of an ability slot; the secondary follows the equipped art. */
export function abilityName(cls: ClassId, slot: AbilitySlot, art = 0): string {
  return slot === 'secondary' && hasArt(cls, art) ? t(`class.${cls}.art.name`) : t(`class.${cls}.${slot}.name`);
}

/** Numbers quoted inside ability descriptions. */
const ABILITY_TEXT_PARAMS = { v: Math.round(BACKSTAB.BONUS * 100), n: TRAP.MAX_ACTIVE };

export function abilityDesc(cls: ClassId, slot: AbilitySlot, art = 0): string {
  return slot === 'secondary' && hasArt(cls, art)
    ? t(`class.${cls}.art.desc`, ABILITY_TEXT_PARAMS)
    : t(`class.${cls}.${slot}.desc`, ABILITY_TEXT_PARAMS);
}

export const artName = (cls: ClassId): string => t(`class.${cls}.art.name`);
export const artDesc = (cls: ClassId): string => t(`class.${cls}.art.desc`, ABILITY_TEXT_PARAMS);

/** The ability definition behind a slot (first link of the primary chain; the equipped secondary). */
export function abilityDef(cls: ClassId, slot: AbilitySlot, art = 0): AbilityDef | null {
  const def = CLASSES[cls];
  if (slot === 'primary') return def.primary[0] ?? null;
  if (slot === 'secondary') return secondaryOf(def, art);
  if (slot === 'ultimate') return def.ultimate;
  return null;
}

/** Display name of any hero ability id (primary chains, secondaries, arts, ultimates), or null if unknown. */
export function abilityNameById(id: string): string | null {
  for (const cls of CLASS_IDS) {
    const def = CLASSES[cls];
    if (def.primary.some((a) => a.id === id)) return t(`class.${cls}.primary.name`);
    if (def.secondary.id === id) return t(`class.${cls}.secondary.name`);
    if (def.arts.some((a) => a.id === id)) return t(`class.${cls}.art.name`);
    if (def.ultimate.id === id) return t(`class.${cls}.ultimate.name`);
  }
  return null;
}

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
  if (def.cls) return def.cls;
  return def.category;
}

/** CSS colour for a boon: its element colour, or the neutral category tint. */
export function boonTint(def: BoonDef | undefined): string {
  if (def?.element) return `var(--gg-${def.element})`;
  if (def?.cls) return `var(--gg-${def.cls})`;
  if (def?.category === 'resonance') return 'var(--gg-glimmer)';
  if (def?.category === 'kinship' || def?.category === 'ultimate') return 'var(--gg-gold)';
  if (def?.category === 'duo') return 'var(--gg-legendary)';
  return 'var(--gg-text)';
}

const pctMore = (mul: number): number => Math.round((mul - 1) * PERCENT);

/** Enemy multipliers of an Oath level as whole percentages on top of the base. */
export function oathPercent(level: number): { hp: number; dmg: number; spd: number } {
  const o = oathScale(level);
  return { hp: pctMore(o.hp), dmg: pctMore(o.damage), spd: pctMore(o.speed) };
}

export function oathDescription(level: number): string {
  if (level <= 0) return t('oath.0.desc');
  return t('oath.desc', oathPercent(level));
}

/** The first Oath levels carry a name; the endless ones above are numbered. */
export function oathName(level: number): string {
  const clamped = Math.min(Math.max(0, Math.floor(level)), RUN.OATH_MAX);
  if (clamped < RUN.OATH.length) return t(`oath.${clamped as 0 | 1 | 2 | 3}.name`);
  return t('oath.n.name', { n: roman(clamped) });
}

/** "Depth II" for RunState.depth 1: depths are shown counted from 1, like the feats count them. */
export function depthLabel(depth: number): string {
  return t('hud.depth', { n: roman(Math.max(0, Math.floor(depth)) + 1) });
}

export const MAX_OATH = RUN.OATH_MAX;

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
