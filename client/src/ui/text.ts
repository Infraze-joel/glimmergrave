/**
 * Texts built from the shared data tables of update 3: passive bonus lines (`Mods`), talents, relics, feats,
 * sets, reactions, Ascension stats and affixes. Every number is computed from the tables at render time.
 * `missingTexts()` is the coverage check: no id may lack a string in English or German.
 */
import { BOONS, SETS, type SetDef } from '@shared/data/boons.ts';
import { FEATS, LIFETIME_STATS, type FeatDef } from '@shared/data/feats.ts';
import { TALENTS, type TalentDef } from '@shared/data/mastery.ts';
import { META_UPGRADES, PARAGON, paragonEffective, type ParagonDef } from '@shared/data/meta.ts';
import { MOD_KEYS, type Mods } from '@shared/data/mods.ts';
import { REACTIONS, type ReactionDef } from '@shared/data/reactions.ts';
import { RELICS, RELIC_TUNING, rankScale, type RelicDef } from '@shared/data/relics.ts';
import { OBJECTIVES } from '@shared/data/objectives.ts';
import { BUILD_TAGS, KEYSTONES } from '@shared/data/keystones.ts';
import { AFFIX_IDS, CLASS_IDS, DOOR_TYPES, ELEMENT_IDS, ENEMY_KINDS, OBJECTIVE_KINDS, type AffixId } from '@shared/types.ts';
import { formatInt, formatNum, hasKey, LANGS, t, textIn, tx } from './i18n.ts';

const PERCENT = 100;
/** Mods that are plain amounts; every other one is a fraction shown as a percentage. */
const FLAT_MODS: ReadonlySet<keyof Mods> = new Set(['maxHp', 'dashCharges', 'lifeOnKill', 'shieldOnSecondary', 'startShield']);

/** One formatted value of a passive bonus ("12.5" for 0.125 damage, "30" for 30 health). */
export function modValue(key: keyof Mods, value: number): string {
  return formatNum(FLAT_MODS.has(key) ? value : value * PERCENT);
}

/** "+5% damage", "+15 maximum health", ... one line per bonus that is not zero. */
export function modLines(mods: Partial<Mods> | undefined, scale = 1): string[] {
  if (!mods) return [];
  const out: string[] = [];
  for (const key of MOD_KEYS) {
    const raw = mods[key];
    if (typeof raw !== 'number' || raw === 0) continue;
    out.push(t(`mod.${key}`, { v: modValue(key, raw * scale) }));
  }
  return out;
}

/** Bonus lines joined for a single row of text. */
export const modText = (mods: Partial<Mods> | undefined, scale = 1): string => modLines(mods, scale).join(' · ');

// ------------------------------------------------------------------ talents

export const talentName = (def: TalentDef): string => tx(`talent.${def.id}.name`, undefined, def.name);
export const talentBody = (def: TalentDef): string => tx(`talent.${def.id}.body`, undefined, def.summary);

// ------------------------------------------------------------------ relics

export const relicName = (def: RelicDef): string => tx(`relic.${def.id}.name`, undefined, def.name);
export const relicBody = (def: RelicDef): string => tx(`relic.${def.id}.body`, undefined, def.summary);

/** The special effect of a relic at a rank, with its numbers (they scale like the mods), or null. */
export function relicSpecial(def: RelicDef, rank: number): string | null {
  if (!def.special) return null;
  const key = `relic.${def.special}.special`;
  if (!hasKey(key)) return null;
  const scale = rankScale(rank);
  const capped = (fraction: number): string => formatNum(Math.min(PERCENT, fraction * scale * PERCENT));
  switch (def.special) {
    case 'frost_core': return t(key, { v: capped(RELIC_TUNING.FROST_CORE_WEAKEN) });
    case 'storm_coil': return t(key, { n: RELIC_TUNING.COIL_EVERY, v: formatNum(RELIC_TUNING.COIL_DAMAGE * scale) });
    case 'void_lantern': return t(key, { v: formatNum(RELIC_TUNING.LANTERN_HEAL * scale) });
    case 'phoenix': return t(key, { v: capped(RELIC_TUNING.PHOENIX_HP) });
    case 'bell': return t(key, { v: capped(RELIC_TUNING.BELL_SLOW), t: RELIC_TUNING.BELL_SECONDS });
    case 'hourglass': return t(key, { v: formatNum(RELIC_TUNING.HOURGLASS_SECONDS * scale) });
    case 'compass': return t(key, { v: formatNum(RELIC_TUNING.COMPASS_BONUS * scale * PERCENT) });
    default: return t(key);
  }
}

/** Everything a relic does at a rank: its special first, then its passive bonuses. */
export function relicEffects(def: RelicDef, rank: number): string[] {
  const special = relicSpecial(def, rank);
  return [...(special ? [special] : []), ...modLines(def.mods, rankScale(rank))];
}

// ------------------------------------------------------------------ feats

export const featName = (def: FeatDef): string => tx(`feat.${def.id}.name`, undefined, def.name);
export const featBody = (def: FeatDef, goal: number): string => tx(`feat.${def.id}.body`, { n: formatInt(goal) }, def.summary);

// ------------------------------------------------------------------ sets, reactions, affixes

export function setName(def: SetDef): string {
  const key = `set.${def.id}.name`;
  return hasKey(key) ? t(key) : def.id;
}

/** Text of a set tier (1 or 2). */
export function setTierText(def: SetDef, tier: number): string {
  const index = tier >= 2 ? 1 : 0;
  return tx(`set.${def.id}.t${index + 1}`, undefined, def.tiers[index].summary);
}

/** What a set counts ("every boon with Ember", "Offense boons"). */
export function setCounts(def: SetDef): string {
  if (def.element) return t('set.counts.element', { element: t(`element.${def.element}.name`) });
  return def.category ? t('set.counts.category', { category: t(`category.${def.category}`) }) : '';
}

export const reactionName = (def: ReactionDef): string => tx(`reaction.${def.id}.name`, undefined, def.name);
export const reactionBody = (def: ReactionDef): string => tx(`reaction.${def.id}.body`, undefined, def.summary);

export const affixName = (id: AffixId): string => t(`affix.${id}.name`);
export const affixBody = (id: AffixId): string => t(`affix.${id}.body`);

// ------------------------------------------------------------------ Ascension

export function paragonName(def: ParagonDef): string {
  const key = `paragon.${def.id}.name`;
  return hasKey(key) ? t(key) : def.id;
}

/** Total magnitude of an Ascension stat at a rank, as the sentence quotes it (percent or flat). */
export function paragonValue(def: ParagonDef, rank: number): number {
  const key = MOD_KEYS.find((k) => typeof def.mods[k] === 'number');
  if (!key) return 0;
  const raw = (def.mods[key] ?? 0) * paragonEffective(rank);
  return FLAT_MODS.has(key) ? raw : raw * PERCENT;
}

/** "+12.4% damage." — the stat's sentence with the total bonus of `rank`. */
export const paragonBody = (def: ParagonDef, rank: number): string =>
  tx(`paragon.${def.id}.body`, { v: formatNum(paragonValue(def, rank)) }, def.summary);

// ------------------------------------------------------------------ coverage check

/** Foes with a first-encounter tip (kept in step with tips.ts NEW_FOES; text.ts must not import the HUD). */
const NEW_FOE_KINDS = ['shaman', 'aegis', 'bomber', 'necromancer', 'reaver'] as const;
/** Playstyle families of keystones (kept in step with keystones.ts FAMILY; every pair needs a build name). */
export const BUILD_FAMILIES = ['step', 'strike', 'cast', 'company', 'body', 'chain'] as const;
const NUMBERS = /\d+(?:[.,]\d+)?/g;
const numbersOf = (text: string): string => (text.match(NUMBERS) ?? []).map((n) => n.replace(',', '.')).sort().join(' ');

/**
 * Every id of the update-3 tables must have its texts in English AND German. Returns the missing keys as
 * "de: talent.knight_riposte.body"; for texts that mirror a data table, also German sentences whose numbers
 * differ from the English reference ("de!: ..."), which is how a retuned table shows up.
 */
export function missingTexts(): string[] {
  const keys: string[] = [];
  const mirrored: string[] = [];
  for (const cls of CLASS_IDS) {
    keys.push(`class.${cls}.name`, `class.${cls}.role`, `wardrobe.head.${cls}`);
    for (const slot of ['primary', 'secondary', 'dash', 'art', 'ultimate']) keys.push(`class.${cls}.${slot}.name`, `class.${cls}.${slot}.desc`);
    for (let style = 0; style < 3; style++) keys.push(`look.${cls}.style.${style}`);
  }
  for (const el of ELEMENT_IDS) {
    keys.push(`element.${el}.name`, `status.${el}.name`, `status.${el}.desc`, `status.${el}.verb`, `status.${el}.detail`);
    for (const slot of ['primary', 'secondary', 'dash', 'ultimate']) keys.push(`infusion.${el}.${slot}.name`);
  }
  for (const def of BOONS) {
    if (def.category === 'infusion') continue;
    keys.push(`boon.${def.id}.name`);
    mirrored.push(`boon.${def.id}.desc`);
    keys.push(`category.${def.category}`, `rarity.${def.rarity}`);
  }
  for (const def of TALENTS) mirrored.push(`talent.${def.id}.name`, `talent.${def.id}.body`);
  for (const def of RELICS) {
    mirrored.push(`relic.${def.id}.name`, `relic.${def.id}.body`);
    if (def.special) keys.push(`relic.${def.special}.special`);
  }
  for (const def of FEATS) mirrored.push(`feat.${def.id}.name`, `feat.${def.id}.body`);
  for (const stat of LIFETIME_STATS) keys.push(`lifetime.${stat}`);
  for (const def of SETS) { keys.push(`set.${def.id}.name`); mirrored.push(`set.${def.id}.t1`, `set.${def.id}.t2`); }
  for (const def of REACTIONS) mirrored.push(`reaction.${def.id}.name`, `reaction.${def.id}.body`);
  for (const id of AFFIX_IDS) keys.push(`affix.${id}.name`, `affix.${id}.body`);
  for (const def of META_UPGRADES) keys.push(`meta.${def.id}.name`, `meta.${def.id}.desc`);
  for (const def of PARAGON) { keys.push(`paragon.${def.id}.name`); mirrored.push(`paragon.${def.id}.body`); }
  for (const key of MOD_KEYS) keys.push(`mod.${key}`);
  for (const type of DOOR_TYPES) keys.push(`door.${type}.name`, `door.${type}.desc`, `toast.door.${type}`, `toast.door.${type}Sub`);
  // update 4: every objective (name, goal, codex detail, bonus and what the HUD says when it is lost) and every enemy kind
  for (const kind of OBJECTIVE_KINDS) {
    mirrored.push(`objective.${kind}.name`, `objective.${kind}.goal`);
    keys.push(`objective.${kind}.detail`);
    if (OBJECTIVES[kind].bonus !== '') { mirrored.push(`objective.${kind}.bonus`); keys.push(`objective.lost.${kind}`); }
  }
  for (const kind of ENEMY_KINDS) keys.push(`enemy.${kind}.name`, `enemy.${kind}.desc`, `enemy.${kind}.tip`);
  for (const kind of NEW_FOE_KINDS) keys.push(`tip.enemy.${kind}.body`, `tip.enemy.${kind}.short`);
  // update 5: every keystone (name, what it changes, its cost), every build tag, and a name for every pair of families
  for (const def of KEYSTONES) {
    mirrored.push(`keystone.${def.id}.name`, `keystone.${def.id}.body`);
    if (def.cost !== '') mirrored.push(`keystone.${def.id}.cost`);
    for (const tag of def.tags) keys.push(`tag.${tag}`);
  }
  for (const tag of BUILD_TAGS) keys.push(`tag.${tag}`);
  for (const slot of ['primary', 'secondary', 'dash', 'ultimate']) keys.push(`keystone.slot.${slot}`);
  for (const el of [...ELEMENT_IDS, 'resonance']) keys.push(`build.of.${el}`);
  BUILD_FAMILIES.forEach((a, i) => { for (const b of BUILD_FAMILIES.slice(i)) keys.push(`build.family.${[a, b].sort().join('+')}`); });

  const out: string[] = [];
  const names = /\.name$/;
  for (const lang of LANGS) {
    for (const key of [...new Set([...keys, ...mirrored])]) {
      if (textIn(lang, key) === null) out.push(`${lang}: ${key}`);
    }
    if (lang === 'en') continue;
    for (const key of mirrored) {
      const en = textIn('en', key);
      const other = textIn(lang, key);
      if (en === null || other === null || names.test(key)) continue;
      if (numbersOf(en) !== numbersOf(other)) out.push(`${lang}!: ${key}  (${numbersOf(en)} / ${numbersOf(other)})`);
    }
  }
  return out;
}
