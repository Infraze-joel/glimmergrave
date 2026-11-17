/**
 * Boon draft overlay: 3-4 cards, hotkeys 1-4, countdown, "waiting for ..." after picking.
 * Update 2: element keywords are coloured and explained in a footnote, infusion cards say what they would
 * resonate with, and heroes who bought Insight can reroll the offer (button or R).
 */
import { BOON_BY_ID, BOON_TUNING, type BoonDef } from '@shared/data/boons.ts';
import { RUN } from '@shared/constants.ts';
import type { ElementId } from '@shared/types.ts';
import { bus } from '../core/EventBus.ts';
import { metaLevel, selfRoster, state } from '../core/GameState.ts';
import { h, icon, key, setText, show, toggle } from './dom.ts';
import { distinctElements, highlight, infusionsOf, resonanceLine, statusLine } from './elements.ts';
import { formatBoon, formatList, maxBoonLevel, t } from './i18n.ts';
import type { IconName } from './icons.ts';
import { boonIcon, boonTint, nameOf } from './model.ts';
import { ui, UI_CONFIG } from './store.ts';
import type { View } from './view.ts';

const INSIGHT_ID = 'insight';
const REROLL_FLASH_MS = 600;

export interface DraftView extends View {
  /** True while the overlay should be on screen. */
  active(): boolean;
  pick(index: number): void;
  /** R: spends a reroll when one is left. */
  reroll(): void;
}

export function levelPips(level: number, max: number): HTMLElement {
  const pips = h('span', { class: 'gg-level-pips', 'aria-hidden': 'true' });
  for (let i = 0; i < max; i++) pips.append(h('i', { class: i < level ? 'is-on' : '' }));
  return pips;
}

interface CardTag {
  text: string;
  tone: 'good' | 'info' | 'warn';
  icon: IconName;
  element?: ElementId;
}

const elementName = (el: ElementId): string => t(`element.${el}.name`);

/** One-line explanation of the status / mechanic a boon talks about, with the real numbers. */
export function boonFootnote(def: BoonDef | undefined): string | null {
  if (!def) return null;
  if (def.element && (def.category === 'infusion' || def.category === 'element')) return statusLine(def.element);
  if (def.category === 'resonance' || def.id === 'shared_vigor') return resonanceLine();
  return null;
}

/** What picking this boon would mean for the hero's elements (shown as a tag on the card). */
export function boonTag(def: BoonDef | undefined): CardTag | null {
  if (!def) return null;
  const own = selfRoster();
  const infusions = infusionsOf(own?.boons ?? []);
  const mine = distinctElements(infusions);
  if (def.category === 'infusion' && def.element && def.slot) {
    const element = def.element;
    const replaced = infusions.find((i) => i.slot === def.slot && i.element !== element);
    // Elements the hero would own after the pick (an infusion replaces the one on the same ability).
    const after = distinctElements([...infusions.filter((i) => i.slot !== def.slot), { slot: def.slot, element }]);
    const partner = after.find((el) => el !== element);
    if (partner) return { text: t('draft.tag.resonates', { element: elementName(partner) }), tone: 'good', icon: 'resonance', element: partner };
    if (replaced) return { text: t('draft.tag.replaces', { element: elementName(replaced.element) }), tone: 'warn', icon: 'warning', element: replaced.element };
    if (mine.length === 0) return { text: t('draft.tag.first'), tone: 'good', icon: 'plus', element };
    const partyHas = state.roster.some((p) => p.slot !== own?.slot && infusionsOf(p.boons).some((i) => i.element === element));
    if (!mine.includes(element) && !partyHas) return { text: t('draft.tag.partyNew', { element: elementName(element) }), tone: 'info', icon: 'plus', element };
    return null;
  }
  if (def.category === 'element' && def.element && !mine.includes(def.element)) {
    return { text: t('draft.tag.needsElement', { element: elementName(def.element) }), tone: 'warn', icon: 'warning', element: def.element };
  }
  if (def.category === 'resonance' || def.id === 'shared_vigor') {
    if (mine.length === 0) return { text: t('draft.tag.noElement'), tone: 'warn', icon: 'warning' };
    const partyElements = new Set(state.roster.flatMap((p) => infusionsOf(p.boons).map((i) => i.element)));
    if (partyElements.size < 2) return { text: t('draft.tag.oneElement'), tone: 'warn', icon: 'warning' };
  }
  return null;
}

export function createDraft(): DraftView {
  const sub = h('p', { class: 'gg-draft-sub' });
  const timerText = h('span', { class: 'gg-num' });
  const timer = h('div', { class: 'gg-draft-timer' }, icon('hourglass'), timerText);
  const cards = h('div', { class: 'gg-draft-cards' });
  const hint = h('p', { class: 'gg-draft-hint' }, t('draft.auto'));
  const waitText = h('p', { class: 'gg-draft-wait-text' });
  const wait = h('div', { class: 'gg-draft-wait' },
    h('div', { class: 'gg-draft-wait-title' }, icon('check'), t('draft.waitingTitle')),
    waitText,
  );
  const title = h('h2', { class: 'gg-draft-title' }, t('draft.title'));
  const rerollCount = h('b', { class: 'gg-reroll-count gg-num' });
  const rerollBtn = h('button', {
    class: 'gg-btn gg-cut gg-btn--small gg-reroll', type: 'button', 'data-testid': 'draft-reroll', 'data-rerolls': '0',
    'data-sfx': 'confirm', title: t('draft.rerollHint'), onClick: () => reroll(),
  }, key('R'), icon('reroll'), h('span', null, t('draft.reroll')), rerollCount);
  const foot = h('div', { class: 'gg-draft-foot' }, rerollBtn, hint);
  const el = h('section', { class: 'gg-draft', 'aria-label': t('draft.title') },
    h('header', { class: 'gg-draft-head' }, title, sub, timer),
    cards,
    foot,
    wait,
  );
  let cardsKey = '';

  const pick = (index: number): void => {
    if (ui.picked >= 0 || index < 0 || index >= state.draft.length) return;
    ui.picked = index;
    bus.emit('ui:pick', { index });
    sync();
  };

  function reroll(): void {
    if (!active() || ui.picked >= 0 || state.draft.length === 0 || state.draftRerolls <= 0 || metaLevel(INSIGHT_ID) <= 0) return;
    cards.classList.add('is-rerolling');
    window.setTimeout(() => cards.classList.remove('is-rerolling'), REROLL_FLASH_MS);
    bus.emit('ui:reroll');
  }

  const renderCards = (): void => {
    const own = selfRoster();
    const k = [
      state.draft.map((o) => `${o.id}:${o.level}`).join('|'),
      // tags depend on everybody's infusions
      state.roster.map((p) => infusionsOf(p.boons).map((i) => `${i.slot}${i.element}`).join('')).join('/'), own?.slot,
    ].join('#');
    if (k === cardsKey) return;
    const offerChanged = !cardsKey.startsWith(`${k.split('#')[0]}#`);
    cardsKey = k;
    if (offerChanged) ui.picked = -1;
    cards.classList.remove('is-rerolling');
    cards.replaceChildren();
    cards.dataset.count = String(state.draft.length);
    state.draft.forEach((offer, index) => {
      const def = BOON_BY_ID.get(offer.id);
      const text = formatBoon(offer.id, offer.level);
      const rarity = def?.rarity ?? 'common';
      const category = def?.category ?? 'offense';
      const upgrade = offer.level > 1;
      const note = boonFootnote(def);
      const tag = boonTag(def);
      const desc = h('span', { class: 'gg-boon-desc' });
      desc.append(...highlight(text.desc));
      const noteEl = note ? h('span', { class: 'gg-boon-note' }) : null;
      if (noteEl && note) noteEl.append(...highlight(note));
      const tagEl = tag
        ? h('span', { class: `gg-boon-tag is-${tag.tone}`, 'data-element': tag.element ?? '' }, icon(tag.icon), h('span', null, tag.text))
        : null;
      const card = h('button', {
        class: `gg-boon-card gg-cut gg-rarity-${rarity}${tag ? ' has-tag' : ''}`, type: 'button', 'data-testid': `draft-card-${index}`,
        'data-tag': tag?.tone ?? '', onClick: () => pick(index),
      },
        h('span', { class: 'gg-boon-hotkey' }, key(String(index + 1))),
        h('span', { class: 'gg-boon-rarity' }, icon('gem'), t(`rarity.${rarity}`)),
        h('span', { class: 'gg-boon-icon' }, icon(boonIcon(def))),
        h('span', { class: 'gg-boon-name' }, text.name),
        h('span', { class: `gg-boon-level${upgrade ? ' is-upgrade' : ''}` },
          upgrade ? `${t('draft.upgrade')} · ${t('common.level', { n: offer.level })}` : t('draft.new'),
          levelPips(offer.level, maxBoonLevel(offer.id)),
        ),
        desc,
        tagEl,
        noteEl,
        h('span', { class: 'gg-boon-category' },
          t(`category.${category}`),
          def?.element ? ` · ${t(`element.${def.element}.name`)}` : '',
        ),
      );
      card.style.setProperty('--tint', boonTint(def));
      if (offerChanged) card.style.animationDelay = `${index * 45}ms`;
      else card.style.animation = 'none';
      cards.append(card);
    });
  };

  function active(): boolean {
    const run = state.run;
    if (state.screen !== 'game' || !run || run.phase !== 'draft') return false;
    return state.draft.length > 0 || run.draftPending.length > 0;
  }

  function sync(): void {
    const run = state.run;
    if (!run) return;
    const choosing = state.draft.length > 0;
    if (choosing) renderCards();
    else { cardsKey = ''; ui.picked = -1; cards.replaceChildren(); }
    Array.from(cards.children).forEach((card, i) => {
      toggle(card, 'is-picked', ui.picked === i);
      toggle(card, 'is-rejected', ui.picked >= 0 && ui.picked !== i);
      (card as HTMLButtonElement).disabled = ui.picked >= 0;
    });
    const cursed = state.draft.length >= BOON_TUNING.CURSED_DRAFT_CHOICES && state.draft.length > RUN.DRAFT_CHOICES;
    setText(sub, cursed ? t('draft.subCursed') : t('draft.sub', { n: run.chamber + 1 }));
    toggle(el, 'is-cursed', cursed);
    toggle(el, 'is-training', run.tutorial !== null && run.tutorial !== undefined);
    const seconds = Math.max(0, Math.ceil(run.draftTime));
    setText(timerText, t('draft.timer', { n: seconds }));
    toggle(timer, 'is-urgent', seconds <= UI_CONFIG.DRAFT_URGENT_SECONDS);
    show(cards, choosing);
    show(foot, choosing);
    show(title, choosing);
    show(sub, choosing);
    show(wait, !choosing);
    toggle(el, 'is-waiting', !choosing);
    // Reroll: only for heroes who own Insight; disabled once the run's rerolls are spent or a card is picked.
    const canReroll = metaLevel(INSIGHT_ID) > 0;
    show(rerollBtn, canReroll);
    rerollBtn.disabled = state.draftRerolls <= 0 || ui.picked >= 0;
    rerollBtn.dataset.rerolls = String(state.draftRerolls);
    setText(rerollCount, t('draft.rerollLeft', { n: Math.max(0, state.draftRerolls) }));
    if (!choosing) {
      const names = run.draftPending.filter((slot) => slot !== state.conn.slot).map(nameOf);
      setText(waitText, names.length > 0 ? t('draft.waiting', { names: formatList(names) }) : '');
    }
  }

  return { el, sync, active, pick, reroll };
}
