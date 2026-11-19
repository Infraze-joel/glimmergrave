/**
 * Pieces of the keystone draft (update 5): the three large cards, the strip of held keystones and the
 * "which one do you give up" step. `draft.ts` owns the overlay, the timer, rerolls and the hotkeys.
 *
 * A keystone card answers four questions in this order: what is it, which ability does it transform, what
 * does it cost (always its own red line, never hidden in the description) and what of mine does it work with.
 */
import { BOON_BY_ID } from '@shared/data/boons.ts';
import { KEYSTONE_TUNING } from '@shared/data/keystones.ts';
import type { RosterEntry } from '@shared/types.ts';
import { h, icon, key } from './dom.ts';
import { highlight } from './elements.ts';
import { t } from './i18n.ts';
import { fitsOf, keystoneBody, keystoneCost, keystoneDef, keystoneEmblem, keystoneName, tagChips, transformInfo, worksWith } from './keystones.ts';
import { UI_CONFIG } from './store.ts';

type Hero = Pick<RosterEntry, 'cls' | 'art' | 'boons' | 'keystones'>;

/** The red cost line (or the quiet "no downside"). */
export function costLine(id: string): HTMLElement {
  const cost = keystoneCost(id);
  return cost !== ''
    ? h('span', { class: 'gg-ks-cost', 'data-cost': 'true' }, h('b', null, icon('warning'), t('keystone.cost')), h('span', null, cost))
    : h('span', { class: 'gg-ks-cost is-free', 'data-cost': 'false' }, icon('check'), h('span', null, t('keystone.noCost')));
}

/** "Transforms your dash" with the ability's icon, or "Changes your whole hero". */
export function transformLine(id: string, hero: Pick<RosterEntry, 'cls' | 'art'>): HTMLElement {
  const info = transformInfo(id, hero.cls, hero.art ?? 0);
  return info
    ? h('span', { class: 'gg-ks-transform', 'data-slot': keystoneDef(id)?.slot ?? '' },
      h('i', { class: 'gg-ks-transform-icon' }, icon(info.icon)), h('span', null, info.text, h('em', null, info.ability)))
    : h('span', { class: 'gg-ks-transform is-hero', 'data-slot': '' }, h('i', { class: 'gg-ks-transform-icon' }, icon('keystone')), h('span', null, t('keystone.passive')));
}

function worksWithBlock(id: string, hero: Hero, held: readonly string[]): HTMLElement {
  const feeders = worksWith(id, hero.boons, held);
  const list = h('span', { class: 'gg-ks-works-list' });
  for (const feeder of feeders.slice(0, UI_CONFIG.WORKS_WITH_MAX)) {
    list.append(h('i', { class: `gg-ks-feeder${feeder.keystone ? ' is-keystone' : ''}`, 'data-id': feeder.id, title: feeder.tags.map((tag) => t(`tag.${tag}`)).join(', ') },
      icon(feeder.icon), feeder.name));
  }
  if (feeders.length > UI_CONFIG.WORKS_WITH_MAX) list.append(h('i', { class: 'gg-ks-feeder is-more' }, t('keystone.worksWith.more', { n: feeders.length - UI_CONFIG.WORKS_WITH_MAX })));
  return h('span', { class: `gg-ks-works${feeders.length === 0 ? ' is-empty' : ''}`, 'data-count': String(feeders.length) },
    h('b', null, t('keystone.worksWith')),
    feeders.length > 0 ? list : h('span', { class: 'gg-ks-works-none' }, t('keystone.worksWith.none')),
  );
}

/** One offered keystone. */
export function keystoneCard(index: number, id: string, hero: Hero, held: readonly string[], onPick: (index: number) => void): HTMLButtonElement {
  const def = keystoneDef(id);
  const body = h('span', { class: 'gg-ks-body' });
  body.append(...highlight(keystoneBody(id)));
  return h('button', {
    class: `gg-ks-card gg-cut${def?.cls ? ` is-class gg-cls-${def.cls}` : ''}${keystoneCost(id) !== '' ? ' has-cost' : ''}`, type: 'button',
    'data-testid': `keystone-card-${index}`, 'data-id': id, 'data-slot': def?.slot ?? '', onClick: () => onPick(index),
  },
    h('span', { class: 'gg-boon-hotkey' }, key(String(index + 1))),
    h('span', { class: 'gg-ks-kind' }, icon('keystone'), def?.cls ? t('keystone.class', { cls: t(`class.${def.cls}.name`) }) : t('keystone.label')),
    keystoneEmblem(id, 'l'),
    h('span', { class: 'gg-ks-name' }, keystoneName(id)),
    transformLine(id, hero),
    body,
    costLine(id),
    tagChips(def?.tags ?? []),
    worksWithBlock(id, hero, held),
  );
}

/** The two slots of the hero: what is held, and where the pick would go. */
export function heldStrip(held: readonly string[]): HTMLElement {
  const row = h('div', { class: 'gg-ks-held', 'data-full': String(held.length >= KEYSTONE_TUNING.MAX_HELD) }, h('span', { class: 'gg-ks-held-label' }, t('keystone.held')));
  for (let slot = 0; slot < KEYSTONE_TUNING.MAX_HELD; slot++) {
    const id = held[slot];
    row.append(id
      ? h('span', { class: 'gg-ks-held-slot', 'data-id': id, title: keystoneBody(id) }, keystoneEmblem(id, 's'), h('b', null, keystoneName(id)))
      : h('span', { class: `gg-ks-held-slot is-free${slot === held.length ? ' is-next' : ''}` },
        h('span', { class: 'gg-ks-emblem gg-ks-emblem--s is-empty' }, h('i', { class: 'gg-ks-emblem-in' }, icon('plus'))),
        h('b', null, slot === held.length ? t('keystone.held.fills') : t('keystone.held.free'))));
  }
  return row;
}

/** How many of the hero's boons only fit the build through this keystone. */
function orphaned(id: string, hero: Hero, held: readonly string[]): number {
  const others = held.filter((other) => other !== id);
  return hero.boons.filter((stack) => BOON_BY_ID.has(stack.id) && fitsOf(stack.id, [id]).length > 0 && fitsOf(stack.id, others).length === 0).length;
}

/** Step two with full slots: the chosen keystone on the left, the two held ones as "give up" buttons. */
export function replacePanel(
  id: string, hero: Hero, held: readonly string[], onGive: (replace: string) => void, onCancel: () => void,
): HTMLElement {
  const incoming = h('div', { class: 'gg-ks-incoming gg-cut' },
    h('span', { class: 'gg-ks-kind' }, icon('plus'), t('draft.new')),
    keystoneEmblem(id, 'm'),
    h('span', { class: 'gg-ks-name' }, keystoneName(id)),
    transformLine(id, hero),
    costLine(id),
  );
  const options = h('div', { class: 'gg-ks-replace-options' });
  held.forEach((old, i) => {
    const lost = orphaned(old, hero, held);
    const body = h('span', { class: 'gg-ks-body' });
    body.append(...highlight(keystoneBody(old)));
    options.append(h('button', {
      class: 'gg-ks-replace gg-cut', type: 'button', 'data-testid': `keystone-replace-${old}`, 'data-id': old, 'data-lost': String(lost), 'data-sfx': 'confirm',
      onClick: () => onGive(old),
    },
      h('span', { class: 'gg-boon-hotkey' }, key(String(i + 1))),
      keystoneEmblem(old, 'm'),
      h('span', { class: 'gg-ks-replace-text' },
        h('span', { class: 'gg-ks-name' }, keystoneName(old)),
        body,
        h('span', { class: `gg-ks-lost${lost > 0 ? ' is-warn' : ''}` }, icon(lost > 0 ? 'warning' : 'check'),
          lost === 0 ? t('keystone.replace.losesNone') : lost === 1 ? t('keystone.replace.losesOne') : t('keystone.replace.loses', { n: lost })),
      ),
      h('span', { class: 'gg-ks-give' }, icon('close'), t('keystone.replace.give', { name: keystoneName(old) })),
    ));
  });
  return h('div', { class: 'gg-ks-replace-panel', 'data-testid': 'keystone-replace', 'data-for': id },
    h('div', { class: 'gg-ks-replace-head' },
      h('h3', null, t('keystone.replace.title')),
      h('p', null, t('keystone.replace.sub', { name: keystoneName(id) })),
    ),
    h('div', { class: 'gg-ks-replace-row' }, incoming, h('span', { class: 'gg-ks-replace-arrow' }, icon('arrow')), options),
    h('button', { class: 'gg-btn gg-cut gg-btn--ghost gg-btn--small gg-ks-cancel', type: 'button', 'data-testid': 'keystone-replace-cancel', onClick: onCancel },
      key('Esc'), t('keystone.replace.cancel')),
  );
}
