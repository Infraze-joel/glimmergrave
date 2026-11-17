/**
 * Element / status / boss knowledge shared by the HUD, draft, tips, training and codex.
 * Every number comes from the shared balance tables, so the explanations can never drift from the game.
 */
import { RUN } from '@shared/constants.ts';
import { BOON_BY_ID } from '@shared/data/boons.ts';
import { ENEMIES, ENEMY_TUNING, STATUS } from '@shared/data/enemies.ts';
import {
  BIOME_IDS, BOSS_KINDS, ELEMENT_IDS,
  type AbilitySlot, type BiomeId, type BoonStack, type BossKind, type ElementId, type EnemyKind, type RunState,
} from '@shared/types.ts';
import { h } from './dom.ts';
import { REACTIONS, reactionOf, type ReactionDef } from '@shared/data/reactions.ts';
import { getLang, roman, t, tx, type I18nKey, type Params } from './i18n.ts';
import { HERO_SLOTS } from './model.ts';
import type { Lang } from '../core/Settings.ts';

const PERCENT = 100;
const pct = (fraction: number): number => Math.round(fraction * PERCENT);

/** Values quoted in `status.<el>.detail` and every text that explains a status. */
export function statusParams(el: ElementId): Params {
  if (el === 'ember') return { dps: STATUS.BURN.DPS, dur: STATUS.BURN.DURATION };
  if (el === 'rime') return { slow: pct(STATUS.CHILL.SLOW), dur: STATUS.CHILL.DURATION };
  if (el === 'umbra') return { weak: pct(STATUS.WITHER.WEAKEN), leech: STATUS.WITHER.LEECH, dur: STATUS.WITHER.DURATION };
  return { vuln: pct(STATUS.SHOCK.VULNERABILITY), dur: STATUS.SHOCK.DURATION };
}

export function resonanceParams(): Params {
  return { dmg: STATUS.RESONANCE.DAMAGE, r: STATUS.RESONANCE.RADIUS };
}

/** "Burn: 5 damage per second for 3 s" */
export function statusLine(el: ElementId): string {
  return `${t(`status.${el}.name`)}: ${t(`status.${el}.detail`, statusParams(el))}`;
}

/** "Resonance: two different elements on one foe burst for 30 damage within 3 m" */
export function resonanceLine(): string {
  return `${t('strip.resonance')}: ${t('status.resonance.detail', resonanceParams())}`;
}

export interface Infusion {
  slot: AbilitySlot;
  element: ElementId;
}

/** Infused abilities of a hero in ability-bar order (boon ids `infuse_<element>_<slot>`). */
export function infusionsOf(boons: BoonStack[]): Infusion[] {
  const out: Infusion[] = [];
  for (const slot of HERO_SLOTS) {
    for (const stack of boons) {
      const def = BOON_BY_ID.get(stack.id);
      if (def?.category === 'infusion' && def.slot === slot && def.element) { out.push({ slot, element: def.element }); break; }
    }
  }
  return out;
}

/** Distinct elements among infusions, in the canonical element order. */
export function distinctElements(infusions: Infusion[]): ElementId[] {
  return ELEMENT_IDS.filter((el) => infusions.some((i) => i.element === el));
}

/** Name of the reaction two different elements make ("Shatter"); empty for a === b. */
export function pairName(a: ElementId, b: ElementId): string {
  const reaction = reactionOf(a, b);
  return reaction ? tx(`reaction.${reaction.id}.name`, undefined, reaction.name) : '';
}

/** Every pair of elements, in the order of the reaction table. */
export const ELEMENT_PAIRS: readonly (readonly [ElementId, ElementId])[] = REACTIONS.map((r) => r.pair);

/** Reactions a hero with these elements can trigger alone. */
export function reactionsOf(elements: readonly ElementId[]): ReactionDef[] {
  return REACTIONS.filter((r) => elements.includes(r.pair[0]) && elements.includes(r.pair[1]));
}

// ------------------------------------------------------------------ keyword colouring of plain descriptions

type Tone = 'ember' | 'rime' | 'storm' | 'umbra' | 'res';

/** Words that name an element, its status or Resonance, per language (matched in boon descriptions). */
const KEYWORDS: Record<Lang, RegExp> = {
  en: /\b(?:(?<ember>Burn(?:ing|s)?|Ember)|(?<rime>Chill(?:ed|s)?|Rime)|(?<storm>Shock(?:ed|s)?|Storm)|(?<umbra>Wither(?:ed|s)?|Umbra)|(?<res>Resonances?))\b/gi,
  de: /(?<![\wäöüß])(?:(?<ember>Brand|Glut)|(?<rime>Kälte|unterkühlte\w*|Reif)|(?<storm>Schock|geschockte\w*|Sturm)|(?<umbra>Verfall|Umbra)|(?<res>Resonanz(?:en)?))(?![a-zäöüß])/gi,
};

/** Splits a plain sentence into text nodes and element-coloured keyword spans. */
export function highlight(text: string): Node[] {
  const out: Node[] = [];
  let last = 0;
  for (const match of text.matchAll(KEYWORDS[getLang()])) {
    const groups = match.groups ?? {};
    const tone = (['ember', 'rime', 'storm', 'umbra', 'res'] as const).find((name): name is Tone => groups[name] !== undefined);
    if (!tone) continue;
    if (match.index > last) out.push(document.createTextNode(text.slice(last, match.index)));
    out.push(h('span', { class: `gg-kw gg-kw--${tone}` }, match[0]));
    last = match.index + match[0].length;
  }
  if (last < text.length) out.push(document.createTextNode(text.slice(last)));
  return out;
}

// ------------------------------------------------------------------ bosses + acts

export function isBossKind(kind: EnemyKind | null | undefined): kind is BossKind {
  return kind !== null && kind !== undefined && (BOSS_KINDS as readonly string[]).includes(kind);
}

export function enemyName(kind: EnemyKind): string {
  return t(`enemy.${kind}.name` as I18nKey);
}

export interface BossLabel {
  kind: EnemyKind;
  name: string;
  /** A weaker echo of the final boss fought in an elite chamber. */
  herald: boolean;
}

/** Who the boss bar belongs to: the chamber's boss kind, labelled "Herald of …" outside the boss chamber. */
export function bossLabel(run: RunState): BossLabel {
  const fallback: EnemyKind = run.chamberKind === 'boss' ? run.finalBoss ?? 'regent' : 'champion';
  const kind = run.bossKind ?? fallback;
  const herald = run.chamberKind !== 'boss' && isBossKind(kind);
  return { kind, herald, name: herald ? t(`enemy.${kind}.herald`) : enemyName(kind) };
}

/** Health fractions at which a boss changes phase (drawn as notches). Empty for the champion and heralds. */
export function phaseThresholds(label: BossLabel): readonly number[] {
  if (label.herald || !isBossKind(label.kind)) return [];
  const table = ENEMY_TUNING as unknown as Record<string, unknown>;
  const entry = table[label.kind.toUpperCase()];
  if (typeof entry === 'object' && entry !== null) {
    const list = (entry as { PHASE_THRESHOLDS?: unknown }).PHASE_THRESHOLDS;
    if (Array.isArray(list) && list.every((v) => typeof v === 'number')) return list as number[];
  }
  return ENEMY_TUNING.REGENT.PHASE_THRESHOLDS;
}

/** Base health of an enemy kind, or null while the balance table has no row for it yet. */
export function enemyHealth(kind: EnemyKind): number | null {
  const def = (ENEMIES as Partial<typeof ENEMIES>)[kind];
  return def ? def.hp : null;
}

/** "Act II — The Flooded Catacombs"; just "Act II" while the biome of that act has not been seen yet. */
export function actTitle(act: number, biome: BiomeId | null): string {
  const n = roman(act + 1);
  return biome ? t('hud.act', { n, name: t(`biome.${biome}.name`) }) : t('hud.actShort', { n });
}

/**
 * Act (0-based) of every chamber of a run. Between two chambers whose biomes were both seen, a new act begins
 * exactly where the biome changed; everywhere else the run's structure decides: every elite chamber opens a
 * new act (the order of the later biomes differs from run to run, so it is never guessed).
 */
export function chamberActs(seen: ReadonlyMap<number, BiomeId>): number[] {
  const last = BIOME_IDS.length - 1;
  let act = 0;
  return RUN.CHAMBERS.map((kind, index) => {
    if (index > 0) {
      const biome = seen.get(index);
      const before = seen.get(index - 1);
      const begins = biome && before ? biome !== before : kind === 'elite';
      if (begins) act = Math.min(last, act + 1);
    }
    return act;
  });
}
