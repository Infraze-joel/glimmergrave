/**
 * Boon draft overlay: 3-5 cards, hotkeys 1-5, countdown, "waiting for ..." after picking.
 * Update 3: legendary rarity, the categories ultimate / class / duo, and what a boon does for the hero's sets.
 * Update 2: element keywords are coloured and explained in a footnote, infusion cards say what they would
 * resonate with, and heroes who bought Insight can reroll the offer (button or R).
 */
import { BOON_BY_ID, SETS, setProgress, type BoonDef, type SetDef } from '@shared/data/boons.ts';
import { REACTIONS } from '@shared/data/reactions.ts';
import { RUN } from '@shared/constants.ts';
import type { ElementId } from '@shared/types.ts';
import { bus } from '../core/EventBus.ts';
import { metaLevel, selfRoster, state } from '../core/GameState.ts';
import { h, icon, key, setText, show, toggle } from './dom.ts';
import { distinctElements, highlight, infusionsOf, resonanceLine, statusLine } from './elements.ts';
import { setIcon, setPips, setTint } from './hud3.ts';
import { formatBoon, formatList, maxBoonLevel, roman, t } from './i18n.ts';
import type { IconName } from './icons.ts';
import { abilityIcon, abilityName, boonIcon, boonTint, nameOf } from './model.ts';
import { draftUpgrade } from './objective.ts';
import { reactionName, setName } from './text.ts';
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

/** What picking a boon would do for one of the hero's sets. */
export interface SetNote {
  set: SetDef;
  /** Different boons counted now and after the pick. */
  have: number;
  after: number;
  /** Tier that the pick would switch on (0 = none). */
  activates: number;
}

/** The sets a boon counts towards, with the progress the pick would make (an upgrade adds nothing). */
export function boonSets(def: BoonDef | undefined, owned: readonly { id: string }[]): SetNote[] {
  if (!def) return [];
  const mine = SETS.filter((set) => (set.element ? def.element === set.element : def.category === set.category));
  if (mine.length === 0) return [];
  const isNew = !owned.some((b) => b.id === def.id);
  const before = setProgress(owned);
  const after = isNew ? setProgress([...owned, { id: def.id }]) : before;
  return mine.map((set) => {
    const was = before.find((p) => p.set === set);
    const now = after.find((p) => p.set === set);
    return { set, have: was?.count ?? 0, after: now?.count ?? 0, activates: (now?.tier ?? 0) > (was?.tier ?? 0) ? now?.tier ?? 0 : 0 };
  });
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
  // Class boons name the ability they change (the equipped secondary variant), duo boons their reaction.
  if (def.category === 'class' && def.cls && def.slot) {
    const art = own?.cls === def.cls ? own.art : 0;
    return { text: t('draft.tag.changes', { ability: abilityName(def.cls, def.slot, art) }), tone: 'info', icon: abilityIcon(def.cls, def.slot, art) };
  }
  if (def.category === 'duo' && def.reaction) {
    const reaction = REACTIONS.find((r) => r.id === def.reaction);
    if (reaction) return { text: t('draft.tag.reaction', { reaction: reactionName(reaction) }), tone: 'good', icon: 'resonance' };
  }
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
  // Shown when the chamber's objective bonus (or a vault) upgraded this draft.
  const bonusText = h('span');
  const bonusMark = h('p', { class: 'gg-draft-bonus', 'data-testid': 'draft-bonus', 'data-source': '' }, icon('star'), bonusText);
  const rerollCount = h('b', { class: 'gg-reroll-count gg-num' });
  const rerollBtn = h('button', {
    class: 'gg-btn gg-cut gg-btn--small gg-reroll', type: 'button', 'data-testid': 'draft-reroll', 'data-rerolls': '0',
    'data-sfx': 'confirm', title: t('draft.rerollHint'), onClick: () => reroll(),
  }, key('R'), icon('reroll'), h('span', null, t('draft.reroll')), rerollCount);
  const foot = h('div', { class: 'gg-draft-foot' }, rerollBtn, hint);
  const el = h('section', { class: 'gg-draft', 'aria-label': t('draft.title') },
    h('header', { class: 'gg-draft-head' }, title, sub, bonusMark, timer),
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
      // set progress depends on the own boons, the class tag on the equipped art
      (own?.boons ?? []).map((b) => b.id).join(','), own?.art,
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
      const setEls = boonSets(def, own?.boons ?? []).map((note) => {
        const gained = note.after > note.have;
        const need = note.set.need[note.after >= note.set.need[0] ? 1 : 0];
        const label = note.activates > 0
          ? t('draft.set.activates', { name: setName(note.set), tier: roman(note.activates) })
          : !gained && note.have >= note.set.need[1] ? t('draft.set.done', { name: setName(note.set) })
            : !gained ? t('draft.set.counted', { name: setName(note.set) })
              : t('draft.set.new', { name: setName(note.set), have: note.after, need });
        const row = h('span', {
          class: `gg-boon-set${note.activates > 0 ? ' is-activating' : ''}${gained ? '' : ' is-counted'}`, 'data-set': note.set.id,
          'data-after': String(note.after), 'data-activates': String(note.activates),
        }, icon(setIcon(note.set)), h('span', null, label), setPips(note.set, note.have, note.after - note.have));
        row.style.setProperty('--tint', setTint(note.set));
        return row;
      });
      const duo = def?.category === 'duo' ? REACTIONS.find((r) => r.id === def.reaction) : undefined;
      const emblem = duo
        ? h('span', { class: 'gg-boon-icon gg-boon-icon--duo' }, h('i', { 'data-element': duo.pair[0] }, icon(duo.pair[0])), h('i', { 'data-element': duo.pair[1] }, icon(duo.pair[1])))
        : h('span', { class: 'gg-boon-icon' }, icon(boonIcon(def)));
      const card = h('button', {
        class: `gg-boon-card gg-cut gg-rarity-${rarity} gg-cat-${category}${def?.cls ? ` gg-cls-${def.cls}` : ''}${tag ? ' has-tag' : ''}`,
        type: 'button', 'data-testid': `draft-card-${index}`, 'data-tag': tag?.tone ?? '', 'data-rarity': rarity, 'data-category': category,
        onClick: () => pick(index),
      },
        h('span', { class: 'gg-boon-hotkey' }, key(String(index + 1))),
        h('span', { class: 'gg-boon-rarity' }, icon('gem'), t(`rarity.${rarity}`)),
        emblem,
        h('span', { class: 'gg-boon-name' }, text.name),
        h('span', { class: `gg-boon-level${upgrade ? ' is-upgrade' : ''}` },
          upgrade ? `${t('draft.upgrade')} · ${t('common.level', { n: offer.level })}` : t('draft.new'),
          levelPips(offer.level, maxBoonLevel(offer.id)),
        ),
        desc,
        tagEl,
        ...setEls,
        noteEl,
        h('span', { class: 'gg-boon-category' },
          t(`category.${category}`),
          def?.element ? ` · ${t(`element.${def.element}.name`)}` : '',
          def?.cls ? ` · ${t(`class.${def.cls}.name`)}` : '',
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
    // Foresight also adds a choice, so the door the party came through decides, not the number of cards.
    const cursed = run.entered === 'cursed' && state.draft.length > RUN.DRAFT_CHOICES;
    const depth = Math.max(0, Math.floor(run.depth ?? 0));
    setText(sub, cursed ? t('draft.subCursed')
      : run.chamberKind === 'boss' && !run.tutorial ? t('draft.subFinal')
        : depth > 0 ? t('draft.subDepth', { d: roman(depth + 1), n: run.chamber + 1 })
          : t('draft.sub', { n: run.chamber + 1 }));
    toggle(el, 'is-cursed', cursed);
    toggle(el, 'is-training', run.tutorial !== null && run.tutorial !== undefined);
    const seconds = Math.max(0, Math.ceil(run.draftTime));
    setText(timerText, t('draft.timer', { n: seconds }));
    toggle(timer, 'is-urgent', seconds <= UI_CONFIG.DRAFT_URGENT_SECONDS);
    show(cards, choosing);
    show(foot, choosing);
    show(title, choosing);
    show(sub, choosing);
    const upgrade = choosing ? draftUpgrade(run) : null;
    show(bonusMark, upgrade !== null);
    bonusMark.dataset.source = upgrade ?? '';
    if (upgrade) setText(bonusText, t(upgrade === 'vault' ? 'draft.bonus.vault' : 'draft.bonus'));
    toggle(el, 'has-bonus', upgrade !== null);
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
