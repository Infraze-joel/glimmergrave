/**
 * Element strip (next to the ability bar) and the Resonance combo counter above it.
 *  - one chip per infused ability: which button, which element, what it does in one word
 *  - two different elements: a "Resonance" chip; only one: the hint that a second element enables it
 *  - every Resonance burst bumps a short-lived combo counter; own bursts are emphasised
 */
import { reactionOf } from '@shared/data/reactions.ts';
import type { ElementId } from '@shared/types.ts';
import { selfRoster, state } from '../core/GameState.ts';
import { h, icon, retrigger, setAttr, show } from './dom.ts';
import { distinctElements, infusionsOf, pairName, reactionsOf, statusLine } from './elements.ts';
import { t, type I18nKey } from './i18n.ts';
import { nameOf } from './model.ts';
import { UI_CONFIG } from './store.ts';
import { reactionBody, reactionName } from './text.ts';
import type { View } from './view.ts';

export interface StripView extends View {
  /** A Resonance burst happened (a consumed, b spread). */
  onResonance(a: ElementId, b: ElementId, by: number): void;
  /** The game screen was left: drop the combo. */
  reset(): void;
}

export function createStrip(): StripView {
  const chips = h('div', { class: 'gg-strip-chips' });
  const comboCount = h('b', { class: 'gg-combo-count gg-num' });
  const comboPair = h('span', { class: 'gg-combo-pair' });
  const comboWho = h('span', { class: 'gg-combo-who' });
  const combo = h('div', { class: 'gg-combo', role: 'status' },
    h('div', { class: 'gg-combo-main' }, icon('resonance'), h('span', { class: 'gg-combo-label' }, t('hud.resonance')), comboCount),
    h('div', { class: 'gg-combo-sub' }, comboPair, comboWho),
  );
  const el = h('div', { class: 'gg-strip', 'data-testid': 'element-strip', 'data-elements': '0', 'aria-label': t('strip.label') }, combo, chips);
  show(combo, false);

  let chipsKey = '';
  let count = 0;
  let lastAt = 0;
  let hideTimer = 0;

  const sync = (): void => {
    const infusions = infusionsOf(selfRoster()?.boons ?? []);
    const elements = distinctElements(infusions);
    const key = infusions.map((i) => `${i.slot}:${i.element}`).join('|');
    if (key === chipsKey) return;
    chipsKey = key;
    setAttr(el, 'data-elements', String(elements.length));
    chips.replaceChildren();
    for (const { slot, element } of infusions) {
      chips.append(h('div', { class: 'gg-strip-chip', 'data-element': element, title: statusLine(element) },
        h('span', { class: 'gg-strip-key' }, t(`hud.key.${slot}` as I18nKey)),
        icon(element),
        h('b', null, t(`element.${element}.name`)),
        // Four infused abilities do not fit with the verb: the element name alone stays.
        infusions.length <= 2 ? h('span', { class: 'gg-strip-verb' }, t(`status.${element}.verb`)) : null,
      ));
    }
    if (elements.length >= 2) {
      // Which named reactions this hero can trigger alone: the first by name, the rest as a count.
      const reactions = reactionsOf(elements);
      const row = h('div', { class: 'gg-strip-res is-ready', title: reactions.map((r) => `${reactionName(r)}: ${reactionBody(r)}`).join('\n') },
        icon('arrow', 'gg-strip-arrow'));
      const first = reactions[0];
      for (const element of first ? first.pair : elements) row.append(h('i', { class: 'gg-strip-dot', 'data-element': element }));
      row.append(icon('resonance'), h('b', null, first ? reactionName(first) : t('strip.resonance')));
      if (reactions.length > 1) row.append(h('span', { class: 'gg-strip-more gg-num' }, t('strip.more', { n: reactions.length - 1 })));
      setAttr(el, 'data-reactions', reactions.map((r) => r.id).join(' '));
      chips.append(row);
    } else if (elements.length === 1) {
      setAttr(el, 'data-reactions', '');
      chips.append(h('div', { class: 'gg-strip-res' }, icon('plus', 'gg-strip-arrow'), h('span', null, t('strip.one'))));
    } else {
      setAttr(el, 'data-reactions', '');
    }
    show(chips, infusions.length > 0);
  };

  const onResonance = (a: ElementId, b: ElementId, by: number): void => {
    const now = performance.now();
    count = now - lastAt <= UI_CONFIG.COMBO_WINDOW_MS ? count + 1 : 1;
    lastAt = now;
    const own = by === state.conn.slot;
    comboCount.textContent = count > 1 ? `×${count}` : '';
    comboPair.replaceChildren(icon(a, `gg-el-${a}`), icon('arrow', 'gg-combo-arrow'), icon(b, `gg-el-${b}`), h('span', null, pairName(a, b)));
    comboWho.textContent = own ? t('hud.resonanceOwn') : by >= 0 ? nameOf(by) : '';
    combo.dataset.reaction = reactionOf(a, b)?.id ?? '';
    combo.classList.toggle('is-own', own);
    combo.dataset.tier = count >= 5 ? '3' : count >= 3 ? '2' : '1';
    combo.style.setProperty('--el-a', `var(--gg-${a})`);
    combo.style.setProperty('--el-b', `var(--gg-${b})`);
    show(combo, true);
    retrigger(combo, 'is-bump');
    window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => {
      combo.classList.add('is-leaving');
      hideTimer = window.setTimeout(() => { combo.classList.remove('is-leaving'); show(combo, false); }, 260);
    }, UI_CONFIG.COMBO_SHOW_MS);
    combo.classList.remove('is-leaving');
  };

  const reset = (): void => {
    window.clearTimeout(hideTimer);
    count = 0;
    lastAt = 0;
    combo.classList.remove('is-leaving', 'is-bump');
    show(combo, false);
  };

  return { el, sync, onResonance, reset, dispose: () => window.clearTimeout(hideTimer) };
}
