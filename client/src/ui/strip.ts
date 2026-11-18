/**
 * Element strip (next to the ability bar) and the Resonance combo counter above it.
 *  - one chip per infused ability: which button, which element, what it does in one word
 *  - two different elements: a "Resonance" chip; only one: the hint that a second element enables it
 *  - every Resonance burst bumps a short-lived callout that counts per reaction ("Shatter ×3"); own bursts are
 *    emphasised and keep the headline, other running reactions are listed in small print below it
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

interface Tally {
  count: number;
  /** performance.now() of the latest burst. */
  at: number;
  a: ElementId;
  b: ElementId;
}

export function createStrip(): StripView {
  const chips = h('div', { class: 'gg-strip-chips' });
  const comboCount = h('b', { class: 'gg-combo-count gg-num' });
  // The named reaction is the headline ("Shatter ×3"); the pair and who caused it follow below.
  const comboLabel = h('span', { class: 'gg-combo-label' }, t('hud.resonance'));
  const comboPair = h('span', { class: 'gg-combo-pair' });
  const comboWho = h('span', { class: 'gg-combo-who' });
  const comboOthers = h('div', { class: 'gg-combo-others' });
  const combo = h('div', { class: 'gg-combo', role: 'status', 'data-testid': 'hud-combo' },
    h('div', { class: 'gg-combo-main' }, icon('resonance'), comboLabel, comboCount),
    h('div', { class: 'gg-combo-sub' }, comboPair, comboWho),
    comboOthers,
  );
  const el = h('div', { class: 'gg-strip', 'data-testid': 'element-strip', 'data-elements': '0', 'aria-label': t('strip.label') }, combo, chips);
  show(combo, false);

  let chipsKey = '';
  let hideTimer = 0;
  let hideAt = 0;
  /** Bursts per reaction inside the combo window: each reaction counts for itself ("Shatter ×3", "Void Arc ×2"). */
  const tallies = new Map<string, Tally>();
  /** Reaction in the headline, and until when an own burst keeps it against allies' bursts. */
  let head = '';
  let ownHoldUntil = 0;

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

  const label = (tally: Tally): string => pairName(tally.a, tally.b) || t('hud.resonance');

  /** The other reactions that are still running, most recent first: small print under the headline. */
  const paintOthers = (): void => {
    const rest = [...tallies.entries()].filter(([id]) => id !== head).sort((x, y) => y[1].at - x[1].at).slice(0, UI_CONFIG.COMBO_OTHERS_MAX);
    comboOthers.replaceChildren(...rest.map(([id, tally]) =>
      h('span', { 'data-reaction': id }, icon(tally.b, `gg-el-${tally.b}`), label(tally), tally.count > 1 ? h('b', { class: 'gg-num' }, `×${tally.count}`) : null)));
    show(comboOthers, rest.length > 0);
    setAttr(combo, 'data-others', rest.map(([id]) => id).join(' '));
  };

  const onResonance = (a: ElementId, b: ElementId, by: number): void => {
    const now = performance.now();
    const id = reactionOf(a, b)?.id ?? `${a}+${b}`;
    for (const [other, tally] of tallies) if (now - tally.at > UI_CONFIG.COMBO_WINDOW_MS) tallies.delete(other);
    const tally: Tally = { count: (tallies.get(id)?.count ?? 0) + 1, at: now, a, b };
    tallies.set(id, tally);
    const own = by === state.conn.slot;
    const visible = !combo.hidden && !combo.classList.contains('is-leaving');
    // An ally's burst does not take the headline from a burst the own hero caused a moment ago.
    if (!own && visible && id !== head && now < ownHoldUntil) { paintOthers(); return; }
    head = id;
    if (own) ownHoldUntil = now + UI_CONFIG.COMBO_OWN_HOLD_MS;
    comboCount.textContent = tally.count > 1 ? `×${tally.count}` : '';
    comboLabel.textContent = label(tally);
    comboPair.replaceChildren(icon(a, `gg-el-${a}`), icon('arrow', 'gg-combo-arrow'), icon(b, `gg-el-${b}`), h('span', null, t('hud.resonance')));
    comboWho.textContent = own ? t('hud.resonanceOwn') : by >= 0 ? nameOf(by) : '';
    combo.dataset.reaction = reactionOf(a, b)?.id ?? '';
    combo.dataset.count = String(tally.count);
    combo.classList.toggle('is-own', own);
    combo.dataset.tier = tally.count >= UI_CONFIG.COMBO_TIER_3 ? '3' : tally.count >= UI_CONFIG.COMBO_TIER_2 ? '2' : '1';
    combo.style.setProperty('--el-a', `var(--gg-${a})`);
    combo.style.setProperty('--el-b', `var(--gg-${b})`);
    paintOthers();
    show(combo, true);
    combo.classList.remove('is-leaving');
    retrigger(combo, 'is-bump');
    // Allies' callouts leave sooner; they never cut an own callout short.
    hideAt = Math.max(visible ? hideAt : 0, now + (own ? UI_CONFIG.COMBO_SHOW_MS : UI_CONFIG.COMBO_ALLY_SHOW_MS));
    window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => {
      combo.classList.add('is-leaving');
      hideTimer = window.setTimeout(() => { combo.classList.remove('is-leaving'); show(combo, false); }, UI_CONFIG.COMBO_LEAVE_MS);
    }, hideAt - now);
  };

  const reset = (): void => {
    window.clearTimeout(hideTimer);
    tallies.clear();
    head = '';
    ownHoldUntil = 0;
    hideAt = 0;
    combo.classList.remove('is-leaving', 'is-bump');
    show(combo, false);
  };

  return { el, sync, onResonance, reset, dispose: () => window.clearTimeout(hideTimer) };
}
