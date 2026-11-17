/**
 * Reliquary tab: the 20 relics (shared/data/relics.ts). Left: the equipped slots and the grid of relics, found
 * or still unknown. Right: the selected relic with its effect at the current rank, the next rank and the
 * equip button. Equipping goes through core `equipRelic` / `unequipRelic`.
 */
import { META_INDEX, META_UPGRADES } from '@shared/data/meta.ts';
import { RELIC_BY_ID, RELIC_TUNING, RELICS, shardsForRank, type RelicDef } from '@shared/data/relics.ts';
import { equipRelic, equippedRelics, relicRank, relicSlotCount, state, unequipRelic } from '../core/GameState.ts';
import { h, icon, replace, setAttr } from './dom.ts';
import type { IconName } from './icons.ts';
import { formatInt, roman, t } from './i18n.ts';
import { ui } from './store.ts';
import { relicBody, relicEffects, relicName } from './text.ts';
import type { View } from './view.ts';

const PERCENT = 100;

export const RELIC_ICON: Record<string, IconName> = {
  whetstone: 'sword', iron_reliquary: 'heart', swift_sandals: 'speed', hunters_eye: 'eye', war_drum: 'offense', tuning_fork: 'resonance',
  prism: 'gem', censer: 'ultimate', aegis_shard: 'defense', leech_fang: 'revive', coin_of_charon: 'glimmer', tome: 'codex',
  ember_heart: 'ember', frost_core: 'rime', storm_coil: 'storm', void_lantern: 'umbra', phoenix: 'rage', bell: 'bell',
  hourglass: 'hourglass', compass: 'cursed',
};

/** Shards held towards the next rank and how many that rank needs in total. */
function shardProgress(id: string): { have: number; need: number; rank: number } {
  const rank = relicRank(id);
  const shards = Math.max(0, Math.floor(state.profile.shards[id] ?? 0));
  if (rank >= RELIC_TUNING.MAX_RANK) return { have: 0, need: 0, rank };
  const base = shardsForRank(rank);
  return { have: shards - base, need: shardsForRank(rank + 1) - base, rank };
}

function relicTint(def: RelicDef): string {
  const el = RELIC_ICON[def.id];
  return el === 'ember' || el === 'rime' || el === 'storm' || el === 'umbra' ? `var(--gg-${el})` : 'var(--gg-gold)';
}

export function createReliquary(): View {
  const slots = h('div', { class: 'gg-relic-slots', 'data-testid': 'relic-slots' });
  const found = h('span', { class: 'gg-relic-found gg-num' });
  const grid = h('div', { class: 'gg-relic-grid', role: 'listbox', 'aria-label': t('hub.tab.reliquary') });
  const detail = h('aside', { class: 'gg-relic-detail gg-cut', 'data-testid': 'relic-detail' });
  const el = h('div', { class: 'gg-hub-pane gg-hub-reliquary', 'data-testid': 'reliquary-root' },
    h('div', { class: 'gg-relic-left' },
      h('div', { class: 'gg-relic-top' }, h('div', { class: 'gg-label' }, t('reliquary.slots')), slots, found),
      grid,
      h('footer', { class: 'gg-page-foot' }, h('p', null, icon('shard'), t('reliquary.drop', {
        e: Math.round(RELIC_TUNING.DROP_ELITE * PERCENT), h: Math.round(RELIC_TUNING.DROP_HERALD * PERCENT),
      }))),
    ),
    detail,
  );
  let key = '';

  /** Selected relic: the player's choice, else the first equipped, else the first owned, else the first of all. */
  const selected = (): string => {
    if (ui.hubRelic && RELIC_BY_ID.has(ui.hubRelic)) return ui.hubRelic;
    return equippedRelics()[0] ?? RELICS.find((def) => relicRank(def.id) > 0)?.id ?? RELICS[0].id;
  };
  const select = (id: string): void => { ui.hubRelic = id; sync(); };

  const renderDetail = (def: RelicDef): void => {
    const rank = relicRank(def.id);
    const worn = equippedRelics();
    const isWorn = worn.includes(def.id);
    const tint = relicTint(def);
    detail.style.setProperty('--tint', tint);
    setAttr(detail, 'data-relic', def.id);
    setAttr(detail, 'data-rank', String(rank));
    if (rank <= 0) {
      detail.replaceChildren(
        h('span', { class: 'gg-relic-big is-unknown' }, icon('relic')),
        h('h3', null, t('reliquary.unknown')),
        h('p', { class: 'gg-relic-body' }, t('reliquary.unknownHint')),
      );
      return;
    }
    const p = shardProgress(def.id);
    const fill = h('i');
    fill.style.setProperty('--w', p.need > 0 ? `${Math.round((p.have / p.need) * 1000) / 10}%` : '100%');
    const effects = (r: number): HTMLElement => {
      const list = h('ul', { class: 'gg-relic-effects' });
      for (const line of relicEffects(def, r)) list.append(h('li', null, line));
      return list;
    };
    const free = worn.length < relicSlotCount();
    const action = isWorn
      ? h('button', {
        class: 'gg-btn gg-cut', type: 'button', 'data-testid': `relic-unequip-${def.id}`, 'data-sfx': 'equip', onClick: () => unequipRelic(def.id),
      }, icon('close'), t('reliquary.unequip'))
      : h('button', {
        class: 'gg-btn gg-cut gg-btn--primary', type: 'button', 'data-testid': `relic-equip-${def.id}`, 'data-sfx': 'equip', disabled: !free,
        onClick: () => { equipRelic(def.id); },
      }, icon('check'), t('reliquary.equip'));
    replace(detail,
      h('div', { class: 'gg-relic-detail-head' },
        h('span', { class: 'gg-relic-big' }, icon(RELIC_ICON[def.id] ?? 'relic')),
        h('div', null,
          h('h3', null, relicName(def)),
          h('p', { class: 'gg-relic-rankline' }, h('b', null, t('common.rank', { n: roman(rank) })), isWorn ? h('em', null, icon('check'), t('reliquary.equipped')) : null),
        ),
      ),
      h('p', { class: 'gg-relic-body' }, relicBody(def)),
      h('div', { class: 'gg-relic-rankbar' },
        h('div', { class: 'gg-xp-bar' }, fill),
        h('span', { class: 'gg-num' }, p.need > 0
          ? t('reliquary.shards', { have: p.have, need: p.need, n: roman(rank + 1) })
          : t('reliquary.maxRank')),
      ),
      h('div', { class: 'gg-label' }, t('reliquary.effect', { n: roman(rank) })),
      effects(rank),
      rank < RELIC_TUNING.MAX_RANK ? h('div', { class: 'gg-label gg-relic-next-label' }, t('reliquary.nextRank', { n: roman(rank + 1) })) : null,
      rank < RELIC_TUNING.MAX_RANK ? h('div', { class: 'gg-relic-next' }, effects(rank + 1)) : null,
      h('div', { class: 'gg-relic-actions' }, action, !isWorn && !free ? h('p', { class: 'gg-relic-full' }, t('reliquary.full')) : null),
    );
  };

  function sync(): void {
    const worn = equippedRelics();
    const slotCount = relicSlotCount();
    const pick = selected();
    const k = JSON.stringify([state.profile.shards, worn, slotCount, pick]);
    if (k === key) return;
    key = k;

    slots.replaceChildren();
    for (let i = 0; i < RELIC_TUNING.MAX_SLOTS; i++) {
      const id = worn[i];
      const def = id ? RELIC_BY_ID.get(id) : undefined;
      if (def) {
        const slot = h('button', {
          class: 'gg-relic-slot gg-cut is-filled', type: 'button', 'data-testid': `relic-slot-${i}`, 'data-relic': def.id, 'data-sfx': 'tab',
          title: relicName(def), onClick: () => select(def.id),
        }, h('span', { class: 'gg-relic-slot-icon' }, icon(RELIC_ICON[def.id] ?? 'relic')), h('span', { class: 'gg-relic-slot-name' }, relicName(def)),
        h('b', { class: 'gg-num' }, roman(relicRank(def.id))));
        slot.style.setProperty('--tint', relicTint(def));
        slots.append(slot);
      } else if (i < slotCount) {
        slots.append(h('div', { class: 'gg-relic-slot gg-cut is-empty', 'data-testid': `relic-slot-${i}`, 'data-relic': '' },
          h('span', { class: 'gg-relic-slot-icon' }, icon('plus')), h('span', { class: 'gg-relic-slot-name' }, t('reliquary.slot.empty'))));
      } else {
        const upgrade = META_UPGRADES[META_INDEX.get('reliquary') ?? -1];
        slots.append(h('div', {
          class: 'gg-relic-slot gg-cut is-locked', 'data-testid': `relic-slot-${i}`, 'data-relic': '', 'data-locked': 'true',
          title: upgrade ? t('reliquary.slot.locked') : '',
        }, h('span', { class: 'gg-relic-slot-icon' }, icon('lock')), h('span', { class: 'gg-relic-slot-name' }, t('reliquary.slot.locked'))));
      }
    }

    grid.replaceChildren();
    let owned = 0;
    for (const def of RELICS) {
      const rank = relicRank(def.id);
      if (rank > 0) owned += 1;
      const isWorn = worn.includes(def.id);
      const p = shardProgress(def.id);
      const fill = h('i');
      fill.style.setProperty('--w', rank > 0 && p.need > 0 ? `${Math.round((p.have / p.need) * 1000) / 10}%` : rank > 0 ? '100%' : '0%');
      const tile = h('button', {
        class: `gg-relic-tile gg-cut${rank > 0 ? '' : ' is-unknown'}${isWorn ? ' is-worn' : ''}${def.id === pick ? ' is-selected' : ''}`, type: 'button',
        role: 'option', 'aria-selected': String(def.id === pick), 'data-testid': `relic-${def.id}`, 'data-rank': String(rank), 'data-worn': String(isWorn),
        'data-sfx': 'tab', onClick: () => select(def.id),
        // Double click is the quick way to put a relic on or take it off.
        onDblclick: () => { if (rank <= 0) return; if (isWorn) unequipRelic(def.id); else equipRelic(def.id); },
      },
        h('span', { class: 'gg-relic-tile-icon' }, icon(rank > 0 ? RELIC_ICON[def.id] ?? 'relic' : 'relic')),
        h('span', { class: 'gg-relic-tile-name' }, rank > 0 ? relicName(def) : t('reliquary.unknown')),
        rank > 0 ? h('b', { class: 'gg-relic-tile-rank gg-num' }, roman(rank)) : h('b', { class: 'gg-relic-tile-rank' }, '?'),
        h('span', { class: 'gg-mastery-bar' }, fill),
        isWorn ? h('i', { class: 'gg-relic-tile-worn' }, icon('check')) : null,
      );
      // Unknown relics give nothing away, not even their colour.
      if (rank > 0) tile.style.setProperty('--tint', relicTint(def));
      grid.append(tile);
    }
    found.textContent = owned > 0 ? t('reliquary.found', { n: formatInt(owned), m: formatInt(RELICS.length) }) : t('reliquary.none');
    const def = RELIC_BY_ID.get(pick);
    if (def) renderDetail(def);
  }

  return { el, sync };
}
