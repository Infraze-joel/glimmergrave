/**
 * Hold-Tab overlay: per-player run stats, every hero's build and boons (icons + levels), and the own build in
 * full: keystones with their cost, the boons grouped by tag with the ones that feed a keystone first, sets.
 */
import { BOON_BY_ID, setProgress } from '@shared/data/boons.ts';
import { BUILD_TAGS, KEYSTONE_TUNING, boonTags, type BuildTag } from '@shared/data/keystones.ts';
import { RUN } from '@shared/constants.ts';
import type { BoonStack, PlayerRunStats, RosterEntry } from '@shared/types.ts';
import { selfRoster, state } from '../core/GameState.ts';
import { h, icon } from './dom.ts';
import { formatBoon, formatInt, formatList, formatTime, maxBoonLevel, roman, t } from './i18n.ts';
import { boonIcon, boonTint, depthLabel, oathName } from './model.ts';
import { levelPips } from './draft.ts';
import { keystoneTaken, whenText } from './growth.ts';
import { setIcon, setTint } from './hud3.ts';
import { costLine } from './keystoneDraft.ts';
import { buildInfo, fitsOf, heldKeystones, keystoneBody, keystoneDef, keystoneEmblem, keystoneName, tagChips, tagIcon, tagName } from './keystones.ts';
import { setName } from './text.ts';
import type { View } from './view.ts';
import type { IconName } from './icons.ts';

type StatKey = 'damage' | 'kills' | 'elites' | 'bosses' | 'resonances' | 'ultimates' | 'revives' | 'downs';

interface Column {
  key: StatKey;
  icon: IconName;
  /** Lower is better (downs). */
  inverse: boolean;
}

const COLUMNS: readonly Column[] = [
  { key: 'damage', icon: 'sword', inverse: false },
  { key: 'kills', icon: 'skull', inverse: false },
  { key: 'elites', icon: 'elite', inverse: false },
  { key: 'bosses', icon: 'crown', inverse: false },
  { key: 'resonances', icon: 'resonance', inverse: false },
  { key: 'ultimates', icon: 'ultimate', inverse: false },
  { key: 'revives', icon: 'revive', inverse: false },
  { key: 'downs', icon: 'down', inverse: true },
];

const EMPTY_STATS: Omit<PlayerRunStats, 'slot'> = { damage: 0, kills: 0, resonances: 0, revives: 0, downs: 0, elites: 0, bosses: 0, ultimates: 0, chamberDamage: [] };

/** Reward columns of the run summary (RunState.rewards). */
const REWARD_COLUMNS: readonly { key: 'glimmer' | 'xp' | 'shards'; icon: IconName }[] = [
  { key: 'glimmer', icon: 'glimmer' }, { key: 'xp', icon: 'xp' }, { key: 'shards', icon: 'shard' },
];

function statsOf(slot: number): PlayerRunStats {
  // Rows from a server that predates a counter simply show 0 for it.
  return { slot, ...EMPTY_STATS, ...(state.run?.stats.find((s) => s.slot === slot) ?? {}) };
}

/** Slots holding the best value of a column. Needs at least two heroes and a non-trivial spread. */
function mvpSlots(column: Column, roster: RosterEntry[]): Set<number> {
  const best = new Set<number>();
  if (roster.length < 2) return best;
  const values = roster.map((p) => statsOf(p.slot)[column.key] ?? 0);
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

/** Keystone emblems and the name of a hero's build, for a table row. `when` adds the chamber each was taken in. */
export function buildChips(p: RosterEntry, when = false): HTMLElement | null {
  const info = buildInfo(p);
  if (info.keystones.length === 0) return null;
  const row = h('div', { class: 'gg-build-chips', 'data-build': info.name, 'data-ids': info.keystones.join(',') }, h('b', { class: 'gg-build-chips-name' }, info.name));
  for (const id of info.keystones) {
    const taken = when ? keystoneTaken(p.slot, id) : null;
    row.append(h('span', { class: 'gg-build-chip', 'data-id': id, title: `${keystoneName(id)} — ${keystoneBody(id)}` },
      keystoneEmblem(id, 'xs'), h('span', null, keystoneName(id)), taken ? h('em', { class: 'gg-num' }, whenText(taken)) : null));
  }
  return row;
}

/** Summary: the build of every hero with the chamber each keystone was taken in. */
export function buildsPanel(): HTMLElement {
  const list = h('ul', { class: 'gg-builds-list' });
  for (const p of [...state.roster].sort((a, b) => a.slot - b.slot)) {
    const info = buildInfo(p);
    const chips = h('div', { class: 'gg-builds-keystones' });
    for (const id of info.keystones) {
      const taken = keystoneTaken(p.slot, id);
      chips.append(h('span', { class: 'gg-build-chip', 'data-id': id, 'data-when': taken ? `${taken.depth}:${taken.chamber}` : '', title: `${keystoneName(id)} — ${keystoneBody(id)}` },
        keystoneEmblem(id, 'xs'), h('span', null, keystoneName(id)), taken ? h('em', { class: 'gg-num' }, whenText(taken)) : null));
    }
    list.append(h('li', { class: `gg-cls-${p.cls}${p.slot === state.conn.slot ? ' is-own' : ''}`, 'data-testid': `summary-build-${p.slot}`, 'data-build': info.name, 'data-ids': info.keystones.join(',') },
      h('span', { class: 'gg-builds-emblem' }, icon(p.cls)),
      h('div', { class: 'gg-builds-id' },
        h('span', { class: 'gg-builds-hero' }, p.name),
        h('b', { class: 'gg-builds-name' }, info.name !== '' ? info.name : t('summary.build.none'))),
      info.keystones.length > 0 ? chips : null,
    ));
  }
  return h('section', { class: 'gg-builds gg-cut', 'data-testid': 'summary-builds' }, h('div', { class: 'gg-label' }, icon('keystone'), t('summary.builds')), list);
}

/** Own boons from which the build panel shortens (one-line descriptions), then drops, the descriptions. */
const BUILD_TIGHT_FROM = 7;
const BUILD_DENSE_FROM = 15;

interface BoonGroup {
  tag: BuildTag | 'other';
  fit: boolean;
  /** Keystones the group's tag feeds. */
  keystones: string[];
  boons: BoonStack[];
}

/** The own boons by tag: a boon sits under the first tag it shares with a keystone, else under its own first tag. */
function boonGroups(boons: readonly BoonStack[], held: readonly string[]): BoonGroup[] {
  const groups = new Map<string, BoonGroup>();
  for (const stack of boons) {
    const def = BOON_BY_ID.get(stack.id);
    const fits = fitsOf(stack.id, held);
    const shared = BUILD_TAGS.find((tag) => fits.some((f) => f.tags.includes(tag)));
    const tag: BuildTag | 'other' = shared ?? (def ? boonTags(def)[0] : undefined) ?? 'other';
    const key = `${shared ? 'fit' : 'own'}:${tag}`;
    const group = groups.get(key) ?? { tag, fit: shared !== undefined, keystones: held.filter((id) => tag !== 'other' && (keystoneDef(id)?.tags ?? []).includes(tag)), boons: [] };
    group.boons.push(stack);
    groups.set(key, group);
  }
  const order = (g: BoonGroup): number => (g.fit ? 0 : 100) + (g.tag === 'other' ? 99 : BUILD_TAGS.indexOf(g.tag));
  return [...groups.values()].sort((a, b) => order(a) - order(b));
}

/** The own build in full (Tab overview). */
export function buildPanel(own: RosterEntry | null): HTMLElement {
  const held = heldKeystones(own);
  const info = buildInfo(own);
  const boons = own?.boons ?? [];
  const keystones = h('div', { class: 'gg-build-keystones' });
  for (let slot = 0; slot < KEYSTONE_TUNING.MAX_HELD; slot++) {
    const id = held[slot];
    if (!id) {
      keystones.append(h('div', { class: 'gg-build-keystone is-empty' },
        h('span', { class: 'gg-ks-emblem gg-ks-emblem--m is-empty' }, h('i', { class: 'gg-ks-emblem-in' })),
        h('div', null, h('b', null, t('hud.keystone.empty')), slot === held.length ? h('span', null, t('tab.build.empty')) : null)));
      continue;
    }
    const taken = own ? keystoneTaken(own.slot, id) : null;
    keystones.append(h('div', { class: 'gg-build-keystone', 'data-id': id },
      keystoneEmblem(id, 'm'),
      h('div', null,
        h('b', null, keystoneName(id), taken ? h('em', { class: 'gg-num' }, whenText(taken)) : null),
        h('span', null, keystoneBody(id)),
        h('div', { class: 'gg-build-keystone-foot' }, costLine(id), tagChips(keystoneDef(id)?.tags ?? [])),
      )));
  }
  // The overlay cannot scroll (it is click-through): the more boons, the less each one says.
  const density = boons.length >= BUILD_DENSE_FROM ? ' is-dense' : boons.length >= BUILD_TIGHT_FROM ? ' is-tight' : '';
  const groups = h('div', { class: `gg-build-groups${density}`, 'data-boons': String(boons.length) });
  for (const group of boonGroups(boons, held)) {
    const list = h('ul', { class: 'gg-build-boons' });
    for (const stack of group.boons) {
      const def = BOON_BY_ID.get(stack.id);
      const text = formatBoon(stack.id, stack.level);
      const item = h('li', { class: `gg-rarity-${def?.rarity ?? 'common'}${group.fit ? ' is-fit' : ''}`, 'data-boon': stack.id, 'data-fit': String(group.fit), title: text.desc },
        h('span', { class: 'gg-own-boon-icon' }, icon(boonIcon(def))),
        h('div', null, h('b', null, text.name, levelPips(stack.level, maxBoonLevel(stack.id))), h('span', null, text.desc)));
      item.style.setProperty('--tint', boonTint(def));
      list.append(item);
    }
    groups.append(h('section', { class: `gg-build-group${group.fit ? ' is-fit' : ''}`, 'data-tag': group.tag, 'data-fit': String(group.fit) },
      h('header', null,
        h('span', { class: 'gg-build-group-tag' }, icon(group.tag === 'other' ? 'boon' : tagIcon(group.tag)), group.tag === 'other' ? t('tab.build.other') : tagName(group.tag)),
        group.fit
          ? h('em', { class: 'gg-build-group-fit' }, icon('keystone'), t('tab.build.fitTitle', { keystone: formatList(group.keystones.map(keystoneName)) }))
          : null),
      list));
  }
  const sets = h('div', { class: 'gg-build-sets' });
  for (const p of setProgress(boons).filter((row) => row.count > 0)) {
    const need = p.tier >= 2 ? p.set.need[1] : p.set.need[p.tier];
    const chip = h('span', { class: `gg-build-set${p.tier > 0 ? ' is-active' : ''}`, 'data-set': p.set.id }, icon(setIcon(p.set)), setName(p.set),
      p.tier > 0 ? h('b', null, roman(p.tier)) : null, h('em', { class: 'gg-num' }, `${Math.min(p.count, need)}/${need}`));
    chip.style.setProperty('--tint', setTint(p.set));
    sets.append(chip);
  }
  return h('section', { class: 'gg-build', 'data-testid': 'tab-build', 'data-build': info.name, 'data-ids': held.join(',') },
    h('header', { class: 'gg-build-head' },
      h('span', { class: 'gg-label' }, icon('keystone'), t('tab.build')),
      h('b', { class: 'gg-build-name' }, info.name !== '' ? info.name : t('build.none')),
      sets.childElementCount > 0 ? sets : null,
    ),
    keystones,
    boons.length > 0 ? groups : h('p', { class: 'gg-boon-chips-empty' }, t('tab.noBoons')),
    held.length > 0 && boons.length > 0 && !boons.some((b) => fitsOf(b.id, held).length > 0) ? h('p', { class: 'gg-build-nofits' }, t('tab.build.noFits')) : null,
  );
}

export interface StatsTableOptions {
  mvp: boolean;
  boons: boolean;
  /** Adds what every hero takes home (Glimmer, XP, relic shards) once the server has announced it. */
  rewards?: boolean;
}

export function statsTable(options: StatsTableOptions): HTMLElement {
  const roster = [...state.roster].sort((a, b) => a.slot - b.slot);
  const head = h('tr', null, h('th', { class: 'gg-stats-hero', scope: 'col' }, t('tab.hero')));
  for (const column of COLUMNS) {
    head.append(h('th', { scope: 'col', 'data-col': column.key, title: t(`tab.${column.key}`) }, icon(column.icon), h('span', null, t(`tab.${column.key}`))));
  }
  const rewards = options.rewards ? state.run?.rewards ?? [] : [];
  const showRewards = rewards.length > 0;
  if (showRewards) {
    for (const column of REWARD_COLUMNS) {
      head.append(h('th', { scope: 'col', class: 'gg-stats-reward', 'data-col': column.key, title: t(`tab.${column.key}`) },
        icon(column.icon), h('span', null, t(`tab.${column.key}`))));
    }
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
            h('span', null, t(`class.${p.cls}.name`), ` · ${t('common.lv', { n: Math.max(1, Math.floor(p.mastery ?? 1)) })}`,
              p.connected ? '' : ` · ${t('hud.disconnected')}`),
          ),
        ),
      ),
    );
    COLUMNS.forEach((column, i) => {
      const isBest = best[i].has(p.slot);
      row.append(h('td', { class: `gg-num${isBest ? ' is-mvp' : ''}`, title: isBest ? t('summary.mvp') : null },
        isBest ? icon('star', 'gg-mvp-star') : null, formatInt(stats[column.key] ?? 0)));
    });
    if (showRewards) {
      const reward = rewards.find((r) => r.slot === p.slot);
      const cell = (value: number | null): HTMLElement =>
        h('td', { class: 'gg-num gg-stats-reward' }, value === null ? '–' : value > 0 ? `+${formatInt(value)}` : '0');
      row.append(cell(reward ? reward.glimmer : null), cell(reward ? reward.xp : null), cell(reward ? reward.relics.length : null));
    }
    body.append(row);
    if (options.boons) {
      body.append(h('tr', { class: 'gg-stats-boons' }, h('td', { colspan: COLUMNS.length + 1 + (showRewards ? REWARD_COLUMNS.length : 0) },
        h('div', { class: 'gg-stats-build' }, buildChips(p), boonChips(p.boons)))));
    }
  }
  return h('table', { class: `gg-stats${showRewards ? ' gg-stats--rewards' : ''}`, 'data-cols': String(COLUMNS.length) }, h('thead', null, head), body);
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
    const key = JSON.stringify([run?.chamber, run?.depth, run?.oath, Math.floor(run?.elapsed ?? 0), run?.stats, state.conn.slot, state.roster]);
    if (key === bodyKey) return;
    bodyKey = key;
    meta.replaceChildren();
    if (run) {
      meta.append(
        h('span', null, icon(run.chamberKind), t('hud.chamber', { n: run.chamber + 1, m: RUN.CHAMBERS.length })),
        h('span', { class: 'gg-num' }, icon('hourglass'), formatTime(run.elapsed)),
        h('span', null, icon('bell'), oathName(run.oath)),
      );
      if ((run.depth ?? 0) > 0) meta.prepend(h('span', null, icon('depth'), depthLabel(run.depth)));
    }
    body.replaceChildren(statsTable({ mvp: false, boons: true }), buildPanel(selfRoster()));
  };

  return { el, sync };
}
