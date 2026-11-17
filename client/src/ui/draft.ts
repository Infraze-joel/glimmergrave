/** Boon draft overlay: 3-4 cards, hotkeys 1-4, countdown, "waiting for ..." after picking. */
import { BOON_BY_ID, BOON_TUNING } from '@shared/data/boons.ts';
import { RUN } from '@shared/constants.ts';
import { bus } from '../core/EventBus.ts';
import { state } from '../core/GameState.ts';
import { h, icon, key, setText, show, toggle } from './dom.ts';
import { formatBoon, formatList, maxBoonLevel, t } from './i18n.ts';
import { boonIcon, boonTint, nameOf } from './model.ts';
import { ui, UI_CONFIG } from './store.ts';
import type { View } from './view.ts';

export interface DraftView extends View {
  /** True while the overlay should be on screen. */
  active(): boolean;
  pick(index: number): void;
}

export function levelPips(level: number, max: number): HTMLElement {
  const pips = h('span', { class: 'gg-level-pips', 'aria-hidden': 'true' });
  for (let i = 0; i < max; i++) pips.append(h('i', { class: i < level ? 'is-on' : '' }));
  return pips;
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
  const el = h('section', { class: 'gg-draft', 'aria-label': t('draft.title') },
    h('header', { class: 'gg-draft-head' }, title, sub, timer),
    cards,
    hint,
    wait,
  );
  let cardsKey = '';

  const pick = (index: number): void => {
    if (ui.picked >= 0 || index < 0 || index >= state.draft.length) return;
    ui.picked = index;
    bus.emit('ui:pick', { index });
    sync();
  };

  const renderCards = (): void => {
    const k = state.draft.map((o) => `${o.id}:${o.level}`).join('|');
    if (k === cardsKey) return;
    cardsKey = k;
    ui.picked = -1;
    cards.replaceChildren();
    cards.dataset.count = String(state.draft.length);
    state.draft.forEach((offer, index) => {
      const def = BOON_BY_ID.get(offer.id);
      const text = formatBoon(offer.id, offer.level);
      const rarity = def?.rarity ?? 'common';
      const category = def?.category ?? 'offense';
      const upgrade = offer.level > 1;
      const card = h('button', {
        class: `gg-boon-card gg-cut gg-rarity-${rarity}`, type: 'button', 'data-testid': `draft-card-${index}`,
        onClick: () => pick(index),
      },
        h('span', { class: 'gg-boon-hotkey' }, key(String(index + 1))),
        h('span', { class: 'gg-boon-rarity' }, icon('gem'), t(`rarity.${rarity}`)),
        h('span', { class: 'gg-boon-icon' }, icon(boonIcon(def))),
        h('span', { class: 'gg-boon-name' }, text.name),
        h('span', { class: `gg-boon-level${upgrade ? ' is-upgrade' : ''}` },
          upgrade ? `${t('draft.upgrade')} · ${t('common.level', { n: offer.level })}` : t('draft.new'),
          levelPips(offer.level, maxBoonLevel(offer.id)),
        ),
        h('span', { class: 'gg-boon-desc' }, text.desc),
        h('span', { class: 'gg-boon-category' },
          t(`category.${category}`),
          def?.element ? ` · ${t(`element.${def.element}.name`)}` : '',
        ),
      );
      card.style.setProperty('--tint', boonTint(def));
      card.style.animationDelay = `${index * 45}ms`;
      cards.append(card);
    });
  };

  const active = (): boolean => {
    const run = state.run;
    if (state.screen !== 'game' || !run || run.phase !== 'draft') return false;
    return state.draft.length > 0 || run.draftPending.length > 0;
  };

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
    const seconds = Math.max(0, Math.ceil(run.draftTime));
    setText(timerText, t('draft.timer', { n: seconds }));
    toggle(timer, 'is-urgent', seconds <= UI_CONFIG.DRAFT_URGENT_SECONDS);
    show(cards, choosing);
    show(hint, choosing);
    show(title, choosing);
    show(sub, choosing);
    show(wait, !choosing);
    toggle(el, 'is-waiting', !choosing);
    if (!choosing) {
      const names = run.draftPending.filter((slot) => slot !== state.conn.slot).map(nameOf);
      setText(waitText, names.length > 0 ? t('draft.waiting', { names: formatList(names) }) : '');
    }
  }

  return { el, sync, active, pick };
}
