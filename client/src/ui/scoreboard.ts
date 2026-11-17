/** Hold-Tab overlay: per-player run stats, every hero's boons (icons + levels) and the own boon list in full. */
import { BOON_BY_ID } from '@shared/data/boons.ts';
import { RUN } from '@shared/constants.ts';
import type { BoonStack, PlayerRunStats, RosterEntry } from '@shared/types.ts';
import { selfRoster, state } from '../core/GameState.ts';
import { h, icon } from './dom.ts';
import { formatBoon, formatInt, formatTime, maxBoonLevel, roman, t, type I18nKey } from './i18n.ts';
import { boonIcon, boonTint, oathName } from './model.ts';
import { levelPips } from './draft.ts';
import type { View } from './view.ts';
import type { IconName } from './icons.ts';

type StatKey = 'damage' | 'kills' | 'resonances' | 'revives' | 'downs';

interface Column {
  key: StatKey;
  icon: IconName;
  /** Lower is better (downs). */
  inverse: boolean;
}

const COLUMNS: readonly Column[] = [
  { key: 'damage', icon: 'sword', inverse: false },
  { key: 'kills', icon: 'skull', inverse: false },
  { key: 'resonances', icon: 'resonance', inverse: false },
  { key: 'revives', icon: 'revive', inverse: false },
  { key: 'downs', icon: 'down', inverse: true },
];

const EMPTY_STATS: Omit<PlayerRunStats, 'slot'> = { damage: 0, kills: 0, resonances: 0, revives: 0, downs: 0 };

function statsOf(slot: number): PlayerRunStats {
  return state.run?.stats.find((s) => s.slot === slot) ?? { slot, ...EMPTY_STATS };
}

/** Slots holding the best value of a column. Needs at least two heroes and a non-trivial spread. */
function mvpSlots(column: Column, roster: RosterEntry[]): Set<number> {
  const best = new Set<number>();
  if (roster.length < 2) return best;
  const values = roster.map((p) => statsOf(p.slot)[column.key]);
  const target = column.inverse ? Math.min(...values) : Math.max(...values);
  const spread = Math.max(...values) - Math.min(...values);
  if (spread === 0 || (!column.inverse && target <= 0)) return best;
  roster.forEach((p, i) => { if (values[i] === target) best.add(p.slot); });
  return best;
}

export function boonChips(boons: BoonStack[]): HTMLElement {
  const row = h('div', { class: 'gg-boon-chips' });
  if (boons.length === 0) row.append(h('span', { class: 'gg-boon-chips-empty' }, t('tab.noBoons')));
  for (const stack of boons) {
    const def = BOON_BY_ID.get(stack.id);
    const text = formatBoon(stack.id, stack.level);
    const chip = h('span', {
      class: `gg-boon-chip gg-rarity-${def?.rarity ?? 'common'}`, title: `${text.name} — ${text.desc}`,
    }, icon(boonIcon(def)), h('b', null, roman(stack.level)));
    chip.style.setProperty('--tint', boonTint(def));
    row.append(chip);
  }
  return row;
}

export interface StatsTableOptions {
  mvp: boolean;
  boons: boolean;
}

export function statsTable(options: StatsTableOptions): HTMLElement {
  const roster = [...state.roster].sort((a, b) => a.slot - b.slot);
  const head = h('tr', null, h('th', { class: 'gg-stats-hero', scope: 'col' }, t('tab.hero')));
  for (const column of COLUMNS) {
    head.append(h('th', { scope: 'col' }, icon(column.icon), h('span', null, t(`tab.${column.key}` as I18nKey))));
  }
  const body = h('tbody');
  const best = COLUMNS.map((column) => (options.mvp ? mvpSlots(column, roster) : new Set<number>()));
  for (const p of roster) {
    const stats = statsOf(p.slot);
    const own = p.slot === state.conn.slot;
    const row = h('tr', { class: `gg-cls-${p.cls}${own ? ' is-own' : ''}${p.connected ? '' : ' is-off'}` },
      h('th', { class: 'gg-stats-hero', scope: 'row' },
        h('div', { class: 'gg-stats-hero-in' },
          h('span', { class: 'gg-stats-emblem' }, icon(p.cls)),
          h('span', { class: 'gg-stats-id' },
            h('b', null, p.name),
            h('span', null, t(`class.${p.cls}.name`), p.connected ? '' : ` · ${t('hud.disconnected')}`),
          ),
        ),
      ),
    );
    COLUMNS.forEach((column, i) => {
      const isBest = best[i].has(p.slot);
      row.append(h('td', { class: `gg-num${isBest ? ' is-mvp' : ''}`, title: isBest ? t('summary.mvp') : null },
        isBest ? icon('star', 'gg-mvp-star') : null, formatInt(stats[column.key])));
    });
    body.append(row);
    if (options.boons) {
      body.append(h('tr', { class: 'gg-stats-boons' }, h('td', { colspan: COLUMNS.length + 1 }, boonChips(p.boons))));
    }
  }
  return h('table', { class: 'gg-stats' }, h('thead', null, head), body);
}

export function createScoreboard(): View {
  const body = h('div', { class: 'gg-tab-body' });
  const meta = h('div', { class: 'gg-tab-meta' });
  const el = h('section', { class: 'gg-tab', 'aria-label': t('tab.title') },
    h('div', { class: 'gg-tab-panel gg-cut' },
      h('header', { class: 'gg-tab-head' }, h('h2', { class: 'gg-section-title' }, t('tab.title')), meta),
      body,
    ),
  );

  let bodyKey = '';
  const sync = (): void => {
    const run = state.run;
    const key = JSON.stringify([run?.chamber, run?.oath, Math.floor(run?.elapsed ?? 0), run?.stats, state.conn.slot, state.roster]);
    if (key === bodyKey) return;
    bodyKey = key;
    meta.replaceChildren();
    if (run) {
      meta.append(
        h('span', null, icon(run.chamberKind), t('hud.chamber', { n: run.chamber + 1, m: RUN.CHAMBERS.length })),
        h('span', { class: 'gg-num' }, icon('hourglass'), formatTime(run.elapsed)),
        h('span', null, icon('bell'), oathName(run.oath)),
      );
    }
    const own = selfRoster();
    const list = h('ul', { class: 'gg-own-boons' });
    for (const stack of own?.boons ?? []) {
      const def = BOON_BY_ID.get(stack.id);
      const text = formatBoon(stack.id, stack.level);
      const item = h('li', { class: `gg-rarity-${def?.rarity ?? 'common'}` },
        h('span', { class: 'gg-own-boon-icon' }, icon(boonIcon(def))),
        h('div', null,
          h('b', null, text.name, levelPips(stack.level, maxBoonLevel(stack.id))),
          h('span', null, text.desc),
        ),
      );
      item.style.setProperty('--tint', boonTint(def));
      list.append(item);
    }
    body.replaceChildren(
      statsTable({ mvp: false, boons: true }),
      h('div', { class: 'gg-label gg-own-boons-label' }, t('tab.yourBoons')),
      (own?.boons.length ?? 0) > 0 ? list : h('p', { class: 'gg-boon-chips-empty' }, t('tab.noBoons')),
    );
  };

  return { el, sync };
}
