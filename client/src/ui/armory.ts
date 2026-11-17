/**
 * Armory tab of the progression hub: spend Glimmer on permanent upgrades (shared/data/meta.ts), grouped by
 * what they are for. Buying goes through core `purchaseUpgrade`, which also resends the loadout in a lobby.
 */
import { META_INDEX, META_UPGRADES, REWARDS, type MetaUpgradeDef } from '@shared/data/meta.ts';
import { metaLevel, nextUpgradeCost, purchaseUpgrade, state } from '../core/GameState.ts';
import { h, icon, retrigger, setAttr, setText, show, toggle } from './dom.ts';
import { levelPips } from './draft.ts';
import type { IconName } from './icons.ts';
import { formatInt, getLang, hasKey, t } from './i18n.ts';
import { UI_CONFIG } from './store.ts';
import type { View } from './view.ts';

const PERCENT = 100;
const PERCENT_VALUE = /\{v\}\s?%/;
const HAS_VALUE = /\{v\}/;

const META_ICON: Record<string, IconName> = {
  vitality: 'heart', might: 'sword', swiftness: 'speed', celerity: 'hourglass', footwork: 'dash',
  insight: 'reroll', attunement: 'infusion', resolve: 'revive', fortune: 'glimmer',
  ferocity: 'eye', tempo: 'offense', zeal: 'ultimate', warding: 'defense', scholar: 'xp', reliquary: 'relic', salvage: 'shard',
  foresight: 'boon', tenacity: 'heart',
};

/** Upgrades grouped by purpose. Ids missing here (a new table row) land in the last group. */
export const META_GROUPS: readonly { id: 'combat' | 'agility' | 'draft' | 'fortune'; upgrades: readonly string[] }[] = [
  { id: 'combat', upgrades: ['vitality', 'might', 'ferocity', 'tempo', 'zeal', 'warding'] },
  { id: 'agility', upgrades: ['swiftness', 'celerity', 'footwork'] },
  { id: 'draft', upgrades: ['insight', 'attunement', 'foresight', 'resolve', 'tenacity'] },
  { id: 'fortune', upgrades: ['fortune', 'scholar', 'reliquary', 'salvage'] },
];

export const metaIcon = (id: string): IconName => META_ICON[id] ?? 'gem';
/** Upgrades whose value is a count rather than a bonus. */
const COUNT_VALUES = new Set(['insight']);

/** Raw magnitude at a level as it appears inside a sentence: 4 for 0.04 when the text says "{v}%". */
function sentenceValue(def: MetaUpgradeDef, level: number): string {
  const raw = def.values[Math.min(def.values.length, Math.max(1, level)) - 1] ?? 0;
  if (PERCENT_VALUE.test(def.summary)) return String(Math.round(raw * PERCENT));
  return String(raw);
}

/** Short value chip: "+8", "+4%", "2×", "active", or "none" for level 0. */
export function metaValue(def: MetaUpgradeDef, level: number): string {
  if (level <= 0) return t('armory.none');
  if (!HAS_VALUE.test(def.summary)) return t('armory.active');
  const v = sentenceValue(def, level);
  if (COUNT_VALUES.has(def.id)) return `${v}×`;
  if (PERCENT_VALUE.test(def.summary)) return getLang() === 'de' ? `+${v} %` : `+${v}%`;
  return `+${v}`;
}

export function metaName(def: MetaUpgradeDef): string {
  const key = `meta.${def.id}.name`;
  return hasKey(key) ? t(key) : def.id;
}

/** Description with the value of `level` filled in (falls back to the shared English reference text). */
export function metaDesc(def: MetaUpgradeDef, level: number): string {
  const key = `meta.${def.id}.desc`;
  const v = sentenceValue(def, level);
  return hasKey(key) ? t(key, { v }) : def.summary.replace('{v}', v);
}

interface Card {
  def: MetaUpgradeDef;
  el: HTMLElement;
  pips: HTMLElement;
  desc: HTMLElement;
  now: HTMLElement;
  next: HTMLElement;
  arrow: HTMLElement;
  nextBox: HTMLElement;
  buy: HTMLButtonElement;
  buyLabel: HTMLElement;
  price: HTMLElement;
  reason: HTMLElement;
  level: number;
}

export function createArmoryTab(): View {
  const grid = h('div', { class: 'gg-armory-groups' });
  const lobbyNote = h('p', { class: 'gg-armory-note' }, icon('check'), t('armory.lobbyNote'));
  const cards: Card[] = [];
  const groupEls = new Map<string, { box: HTMLElement; count: HTMLElement; ids: string[] }>();
  const grouped = new Set(META_GROUPS.flatMap((g) => g.upgrades));
  const lastGroup = META_GROUPS[META_GROUPS.length - 1].id;
  for (const group of META_GROUPS) {
    const ids = group.upgrades.filter((id) => META_INDEX.has(id));
    if (group.id === lastGroup) ids.push(...META_UPGRADES.filter((def) => !grouped.has(def.id)).map((def) => def.id));
    const count = h('span', { class: 'gg-armory-group-count gg-num' });
    const box = h('div', { class: 'gg-armory-grid' });
    groupEls.set(group.id, { box, count, ids });
    grid.append(h('section', { class: 'gg-armory-group', 'data-group': group.id },
      h('header', { class: 'gg-armory-group-head' }, h('h3', null, t(`armory.group.${group.id}`)), count), box));
  }
  const boxOf = (id: string): HTMLElement => [...groupEls.values()].find((g) => g.ids.includes(id))?.box ?? grid;

  for (const def of META_UPGRADES) {
    const pips = h('span', { class: 'gg-meta-pips' });
    const desc = h('p', { class: 'gg-meta-desc' });
    const now = h('b', { class: 'gg-num' });
    const next = h('b', { class: 'gg-num' });
    const arrow = icon('arrow', 'gg-meta-arrow');
    const nextBox = h('span', { class: 'gg-meta-next' }, h('span', null, t('armory.next')), next);
    const buyLabel = h('span');
    const price = h('span', { class: 'gg-meta-price gg-num' });
    const reason = h('span', { class: 'gg-meta-reason' });
    const buy = h('button', {
      class: 'gg-btn gg-cut gg-btn--glimmer gg-meta-buy', type: 'button', 'data-testid': `armory-buy-${def.id}`, 'data-sfx': 'buy',
      onClick: () => {
        if (!purchaseUpgrade(def.id)) return;
        const card = cards.find((c) => c.def.id === def.id);
        if (!card) return;
        retrigger(card.el, 'is-bought');
        window.setTimeout(() => card.el.classList.remove('is-bought'), UI_CONFIG.PURCHASE_FLASH_MS);
      },
    }, buyLabel, price);
    const el = h('article', { class: 'gg-meta-card gg-cut', 'data-id': def.id, 'data-level': '0', 'data-max': String(def.costs.length) },
      h('span', { class: 'gg-meta-icon' }, icon(metaIcon(def.id))),
      h('div', { class: 'gg-meta-main' },
        h('div', { class: 'gg-meta-top' }, h('h3', null, metaName(def)), pips),
        desc,
        h('div', { class: 'gg-meta-values' },
          h('span', { class: 'gg-meta-now' }, h('span', null, t('armory.now')), now), arrow, nextBox),
      ),
      h('div', { class: 'gg-meta-shop' }, buy, reason),
    );
    cards.push({ def, el, pips, desc, now, next, arrow, nextBox, buy, buyLabel, price, reason, level: -1 });
  }
  // Cards are placed in group order (the table order is the wire format, not a reading order).
  for (const { ids } of groupEls.values()) {
    for (const id of ids) {
      const card = cards.find((c) => c.def.id === id);
      if (card) boxOf(id).append(card.el);
    }
  }

  const el = h('div', { class: 'gg-hub-pane gg-hub-armory' },
    grid,
    h('footer', { class: 'gg-page-foot' },
      h('p', { class: 'gg-armory-earn' }, icon('glimmer'), t('armory.earnHint', {
        c: REWARDS.PER_CHAMBER_CLEARED, e: REWARDS.PER_ELITE_SLAIN, b: REWARDS.BOSS_SLAIN, m: REWARDS.MINIMUM,
      })),
      lobbyNote,
    ),
  );

  const sync = (): void => {
    const glimmer = Math.max(0, Math.floor(state.profile.glimmer));
    for (const group of groupEls.values()) {
      let have = 0;
      let max = 0;
      for (const id of group.ids) {
        const def = META_UPGRADES[META_INDEX.get(id) ?? -1];
        if (!def) continue;
        have += metaLevel(id);
        max += def.costs.length;
      }
      setText(group.count, t('armory.owned', { n: have, m: max }));
    }
    show(lobbyNote, state.screen === 'lobby');
    for (const card of cards) {
      const { def } = card;
      const max = def.costs.length;
      const level = metaLevel(def.id);
      const cost = nextUpgradeCost(def.id);
      const maxed = cost === null;
      if (card.level !== level) {
        card.level = level;
        setAttr(card.el, 'data-level', String(level));
        card.pips.replaceChildren(levelPips(level, max));
        setText(card.desc, metaDesc(def, maxed ? level : level + 1));
        setText(card.now, metaValue(def, level));
        setText(card.next, maxed ? '' : metaValue(def, level + 1));
        show(card.arrow, !maxed);
        show(card.nextBox, !maxed);
      }
      const short = maxed ? 0 : Math.max(0, cost - glimmer);
      toggle(card.el, 'is-maxed', maxed);
      toggle(card.el, 'is-owned', level > 0);
      toggle(card.el, 'is-affordable', !maxed && short === 0);
      card.buy.disabled = maxed || short > 0;
      setText(card.buyLabel, maxed ? t('armory.maxed') : t('armory.buy'));
      card.price.replaceChildren(...(maxed ? [icon('check')] : [icon('glimmer'), formatInt(cost)]));
      setText(card.reason, maxed || short === 0 ? '' : t('armory.need', { n: formatInt(short) }));
      card.buy.title = maxed ? t('armory.maxed') : short > 0 ? t('armory.need', { n: formatInt(short) }) : '';
    }
  };

  return { el, sync };
}
