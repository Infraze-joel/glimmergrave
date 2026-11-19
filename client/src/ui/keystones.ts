/**
 * Keystones and builds (update 5): names, emblems, tags, what feeds what, and the name of a build.
 * Read-only helpers shared by the draft, the HUD, the Tab overview, the summary, the lobby and the codex.
 * Everything is derived from `shared/src/data/keystones.ts`; nothing here decides gameplay.
 */
import { BOON_BY_ID } from '@shared/data/boons.ts';
import { BUILD_TAGS, KEYSTONE_BY_ID, KEYSTONE_TUNING, boonTags, type BuildTag, type KeystoneDef } from '@shared/data/keystones.ts';
import type { AbilitySlot, BoonStack, ClassId, ElementId, RosterEntry } from '@shared/types.ts';
import { h, icon } from './dom.ts';
import { infusionsOf } from './elements.ts';
import type { IconName } from './icons.ts';
import { formatBoon, formatList, hasKey, t, tx } from './i18n.ts';
import { abilityIcon, abilityName, boonIcon } from './model.ts';

// ------------------------------------------------------------------ texts and emblems

export const keystoneDef = (id: string): KeystoneDef | undefined => KEYSTONE_BY_ID.get(id);
export const keystoneName = (id: string): string => tx(`keystone.${id}.name`, undefined, keystoneDef(id)?.name ?? id);
/** What the keystone changes. Class keystones lose their "Knight: " prefix (the card says whose it is). */
export function keystoneBody(id: string): string {
  const def = keystoneDef(id);
  const body = tx(`keystone.${id}.body`, undefined, def?.summary ?? '');
  if (!def?.cls) return body;
  const prefix = `${t(`class.${def.cls}.name`)}: `;
  return body.startsWith(prefix) ? body.charAt(prefix.length).toUpperCase() + body.slice(prefix.length + 1) : body;
}
/** The price of a keystone, or '' when it has none. */
export const keystoneCost = (id: string): string => ((keystoneDef(id)?.cost ?? '') === '' ? '' : tx(`keystone.${id}.cost`, undefined, keystoneDef(id)?.cost ?? ''));

const KEYSTONE_ICON: Record<string, IconName> = {
  ember_wake: 'wake', shockstep: 'shockwave', phase_walker: 'phase',
  ricochet: 'ricochet', chain_lightning: 'chain', heavy_hitter: 'fist',
  twin_cast: 'twin', blood_price: 'blood',
  orbit_blades: 'orbit', familiar: 'wisp', colossus: 'colossus',
  corpse_bloom: 'bloom', resonance_engine: 'engine', glass_cannon: 'glass', sanguine: 'pact', momentum_engine: 'rush',
  ks_knight: 'ward', ks_barbarian: 'whirl', ks_mage: 'beam', ks_rogue: 'knives', ks_templar: 'consecrate', ks_spellblade: 'bladeWave',
  ks_shade: 'smoke',
};
export const keystoneIcon = (id: string): IconName => KEYSTONE_ICON[id] ?? 'keystone';

const TAG_ICON: Record<BuildTag, IconName> = {
  primary: 'mouseLeft', secondary: 'mouseRight', dash: 'dash', ultimate: 'ultimate', projectile: 'crossbow', melee: 'sword', area: 'nova',
  status: 'element', resonance: 'resonance', crit: 'mark', shield: 'defense', health: 'heart', speed: 'speed', summon: 'wisp', kill: 'skull',
};
const isTag = (tag: string): tag is BuildTag => (BUILD_TAGS as readonly string[]).includes(tag);
export const tagName = (tag: string): string => (isTag(tag) ? t(`tag.${tag}`) : tag);
export const tagIcon = (tag: string): IconName => (isTag(tag) ? TAG_ICON[tag] : 'gem');

/** The hexagonal emblem of a keystone. `size` only picks a CSS variant. */
export function keystoneEmblem(id: string, size: 'xs' | 's' | 'm' | 'l' = 'm'): HTMLElement {
  const def = keystoneDef(id);
  return h('span', { class: `gg-ks-emblem gg-ks-emblem--${size}${def?.cls ? ` gg-cls-${def.cls}` : ''}`, 'data-keystone': id, title: keystoneName(id) },
    h('i', { class: 'gg-ks-emblem-in' }, icon(keystoneIcon(id))));
}

/** A row of tag chips; tags listed in `lit` are highlighted (they are shared with the build). */
export function tagChips(tags: readonly string[], lit: readonly string[] = []): HTMLElement {
  const row = h('span', { class: 'gg-tags' });
  for (const tag of tags) row.append(h('i', { class: `gg-tag${lit.includes(tag) ? ' is-lit' : ''}`, 'data-tag': tag }, icon(tagIcon(tag)), tagName(tag)));
  return row;
}

// ------------------------------------------------------------------ what a hero holds

/** Keystones of a roster entry (known ids only, at most the two the rules allow). */
export function heldKeystones(entry: Pick<RosterEntry, 'keystones'> | null | undefined): string[] {
  const list = entry?.keystones;
  return Array.isArray(list) ? list.filter((id) => KEYSTONE_BY_ID.has(id)).slice(0, KEYSTONE_TUNING.MAX_HELD) : [];
}

/** The keystone that transforms an ability slot, if the hero holds one. */
export function keystoneOnSlot(held: readonly string[], slot: AbilitySlot): string | null {
  return held.find((id) => keystoneDef(id)?.slot === slot) ?? null;
}

/** "Transforms your dash" plus the icon / name of that ability for a class; null for hero-wide keystones. */
export function transformInfo(id: string, cls: ClassId, art = 0): { text: string; icon: IconName; ability: string } | null {
  const slot = keystoneDef(id)?.slot;
  if (!slot) return null;
  return { text: t('keystone.transforms', { slot: t(`keystone.slot.${slot}`) }), icon: abilityIcon(cls, slot, art), ability: abilityName(cls, slot, art) };
}

// ------------------------------------------------------------------ fits

export interface Fit {
  keystone: string;
  tags: BuildTag[];
}

/** For each held keystone, the tags a boon shares with it (keystones without a shared tag are left out). */
export function fitsOf(boonId: string, held: readonly string[]): Fit[] {
  const boon = BOON_BY_ID.get(boonId);
  if (!boon) return [];
  const mine = boonTags(boon);
  const out: Fit[] = [];
  for (const id of held) {
    const tags = (keystoneDef(id)?.tags ?? []).filter((tag) => mine.includes(tag));
    if (tags.length >= KEYSTONE_TUNING.FIT_TAGS) out.push({ keystone: id, tags });
  }
  return out;
}

/**
 * Fits of a draft offer. The server decides WHETHER a boon fits (`BoonOffer.fits`, it also weights the roll by
 * it); which keystone each tag feeds is worked out here. Tags the server did not name are dropped.
 */
export function offerFits(offer: { id: string; fits?: string[] }, held: readonly string[]): Fit[] {
  const named = offer.fits ?? [];
  if (named.length === 0) return [];
  const mine = fitsOf(offer.id, held)
    .map((fit) => ({ keystone: fit.keystone, tags: fit.tags.filter((tag) => named.includes(tag)) }))
    .filter((fit) => fit.tags.length > 0);
  return mine;
}

/** "feeds Blazing Wake: Dash and Status" */
export const fitLine = (fit: Fit): string => t('draft.fit.line', { keystone: keystoneName(fit.keystone), tags: formatList(fit.tags.map(tagName)) });

export interface Feeder {
  /** Boon id, or keystone id when `keystone` is true. */
  id: string;
  keystone: boolean;
  name: string;
  icon: IconName;
  tags: BuildTag[];
}

/** What a hero already holds that shares tags with a keystone: infusions first, then by the number of tags. */
export function worksWith(keystoneId: string, boons: readonly BoonStack[], held: readonly string[]): Feeder[] {
  const def = keystoneDef(keystoneId);
  if (!def) return [];
  const out: (Feeder & { weight: number })[] = [];
  for (const other of held) {
    if (other === keystoneId) continue;
    const tags = (keystoneDef(other)?.tags ?? []).filter((tag) => def.tags.includes(tag));
    if (tags.length > 0) out.push({ id: other, keystone: true, name: keystoneName(other), icon: keystoneIcon(other), tags, weight: 100 + tags.length });
  }
  for (const stack of boons) {
    const boon = BOON_BY_ID.get(stack.id);
    if (!boon) continue;
    const tags = boonTags(boon).filter((tag) => def.tags.includes(tag));
    if (tags.length === 0) continue;
    // An infusion on the transformed ability is the strongest partner: the keystone spreads that element.
    const infusion = boon.category === 'infusion' && boon.slot !== undefined && boon.slot === def.slot;
    out.push({ id: stack.id, keystone: false, name: formatBoon(stack.id, stack.level).name, icon: boonIcon(boon), tags, weight: (infusion ? 50 : 0) + tags.length });
  }
  return out.sort((a, b) => b.weight - a.weight).map(({ weight: _weight, ...feeder }) => feeder);
}

// ------------------------------------------------------------------ build names

/** Rough playstyle of a keystone; two families name a build when no pair has a name of its own. */
type Family = 'step' | 'strike' | 'cast' | 'company' | 'body' | 'chain';
const FAMILY: Record<string, Family> = {
  ember_wake: 'step', shockstep: 'step', phase_walker: 'step', ks_shade: 'step',
  ricochet: 'strike', chain_lightning: 'strike', heavy_hitter: 'strike', ks_mage: 'strike', ks_rogue: 'strike', ks_spellblade: 'strike',
  twin_cast: 'cast', blood_price: 'cast', ks_knight: 'cast', ks_barbarian: 'cast', ks_templar: 'cast',
  orbit_blades: 'company', familiar: 'company',
  colossus: 'body', glass_cannon: 'body', sanguine: 'body',
  corpse_bloom: 'chain', resonance_engine: 'chain', momentum_engine: 'chain',
};
const familyOf = (id: string): Family => FAMILY[id] ?? (keystoneDef(id)?.slot === 'dash' ? 'step' : keystoneDef(id)?.slot === 'secondary' ? 'cast' : 'strike');
const pairKey = (a: string, b: string): string => [a, b].sort().join('+');

/** The element a hero leans on: the one most of the boons carry; 'resonance' when two share the lead. */
export function dominantElement(boons: readonly BoonStack[]): ElementId | 'resonance' | null {
  const count = new Map<ElementId, number>();
  for (const stack of boons) {
    const el = BOON_BY_ID.get(stack.id)?.element;
    if (el) count.set(el, (count.get(el) ?? 0) + 1);
  }
  // Only elements the hero can actually apply count.
  const applied = new Set(infusionsOf([...boons]).map((i) => i.element));
  const ranked = [...count.entries()].filter(([el]) => applied.has(el)).sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0) return null;
  if (ranked.length > 1 && ranked[0][1] === ranked[1][1]) return 'resonance';
  return ranked[0][0];
}

export interface BuildInfo {
  /** Full name ("Stormrunner of Ember"); '' while there is nothing to name. */
  name: string;
  /** Compact name for party frames ("Stormrunner", "Blazing Wake"); '' without a keystone. */
  short: string;
  keystones: string[];
}

/**
 * Name of a build.
 *  - two keystones: the pair's own name (`build.pair.<a>+<b>`), else the name of their two families
 *    (`build.family.<f>+<g>`); the dominant element is appended ("of Ember", "of Resonance");
 *  - one keystone: "<Keystone> <Class>";
 *  - none: "<Element> <Class>" when the hero has an element, else ''.
 */
export function buildInfo(entry: Pick<RosterEntry, 'keystones' | 'boons' | 'cls'> | null | undefined): BuildInfo {
  if (!entry) return { name: '', short: '', keystones: [] };
  const held = heldKeystones(entry);
  const cls = t(`class.${entry.cls}.name`);
  const element = dominantElement(entry.boons ?? []);
  const withElement = (name: string): string => (element ? t('build.with', { name, of: t(`build.of.${element}`) }) : name);
  if (held.length >= 2) {
    const own = `build.pair.${pairKey(held[0], held[1])}`;
    const family = `build.family.${pairKey(familyOf(held[0]), familyOf(held[1]))}`;
    const base = hasKey(own) ? t(own) : hasKey(family) ? t(family) : `${keystoneName(held[0])} + ${keystoneName(held[1])}`;
    return { name: withElement(base), short: base, keystones: held };
  }
  if (held.length === 1) {
    const keystone = keystoneName(held[0]);
    return { name: t('build.single', { keystone, cls }), short: keystone, keystones: held };
  }
  if (element === 'resonance') return { name: withElement(cls), short: '', keystones: [] };
  if (element) return { name: t('build.element', { element: t(`element.${element}.name`), cls }), short: '', keystones: [] };
  return { name: '', short: '', keystones: [] };
}
