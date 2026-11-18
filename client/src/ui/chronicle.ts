/**
 * Chronicle tab: the Warden rank, the lifetime counters and the 16 feats (shared/data/feats.ts). Every feat
 * shows the tier being worked on with a progress bar; reached tiers pay Glimmer once through core `claimFeat`.
 */
import { FEATS, WARDEN_RANK, wardenRank, type FeatDef, type LifetimeStat } from '@shared/data/feats.ts';
import { claimFeat, featState, state, totalXp } from '../core/GameState.ts';
import { h, icon, retrigger, setAttr } from './dom.ts';
import type { IconName } from './icons.ts';
import { formatCompact, formatInt, roman, t } from './i18n.ts';
import { claimableGlimmer } from './progress.ts';
import { UI_CONFIG } from './store.ts';
import { featBody, featName } from './text.ts';
import type { View } from './view.ts';

const STAT_ICON: Record<LifetimeStat, IconName> = {
  runs: 'door', wins: 'bell', kills: 'skull', elites: 'elite', bosses: 'crown', resonances: 'resonance', revives: 'revive', ultimates: 'ultimate',
  chambers: 'combat', damage: 'sword', bestDepth: 'depth', bestOath: 'bell', glimmerEarned: 'glimmer', masteryLevels: 'mastery',
  relicRanks: 'relic', classesWon: 'users',
};
/** Counters shown in the header strip (the rest are visible on their feats). */
const HEADLINE: readonly LifetimeStat[] = ['runs', 'wins', 'kills', 'bosses', 'chambers', 'bestDepth', 'bestOath', 'glimmerEarned'];
/** Counters that are "best of" records counted from 1: shown as roman numerals, 0 as a dash. */
const RECORDS: ReadonlySet<LifetimeStat> = new Set(['bestDepth', 'bestOath']);

function statValue(stat: LifetimeStat, value: number): string {
  if (RECORDS.has(stat)) return value > 0 ? roman(value) : '–';
  return formatCompact(value);
}

export function createChronicle(): View {
  const head = h('div', { class: 'gg-chron-head' });
  const list = h('div', { class: 'gg-feat-list' });
  const claimAll = h('button', {
    class: 'gg-btn gg-cut gg-btn--glimmer gg-btn--small gg-chron-claim-all', type: 'button', 'data-testid': 'feat-claim-all', 'data-sfx': 'buy',
    onClick: () => {
      // One tier per feat per pass, until nothing is left (a feat may have several tiers waiting).
      for (let guard = 0; guard < 64 && claimableGlimmer().tiers > 0; guard++) for (const feat of FEATS) claimFeat(feat.id);
    },
  });
  const el = h('div', { class: 'gg-hub-pane gg-hub-chronicle', 'data-testid': 'chronicle-root' },
    head,
    h('div', { class: 'gg-chron-bar' }, h('div', { class: 'gg-label' }, t('chronicle.feats'), h('span', { class: 'gg-label-note' }, t('chronicle.intro'))), claimAll),
    list,
  );
  let key = '';
  let justClaimed: string | null = null;

  const featCard = (feat: FeatDef): HTMLElement => {
    const f = featState(feat.id);
    const total = feat.goals.length;
    const complete = f.tier >= total;
    const claimable = f.tier > f.claimed;
    // The tier to show: the one waiting to be claimed, else the one being worked on.
    const tierIndex = claimable ? f.claimed : Math.min(f.tier, total - 1);
    const goal = feat.goals[tierIndex] ?? 0;
    const reward = feat.rewards[tierIndex] ?? 0;
    const fill = h('i');
    const fraction = goal > 0 ? Math.min(1, f.value / goal) : 1;
    fill.style.setProperty('--w', `${Math.round(fraction * 1000) / 10}%`);
    const pips = h('span', { class: 'gg-feat-pips', 'aria-label': t('chronicle.tier', { n: f.claimed, m: total }) });
    for (let i = 0; i < total; i++) pips.append(h('i', { class: i < f.claimed ? 'is-claimed' : i < f.tier ? 'is-reached' : '' }));
    const done = complete && !claimable;
    const action = claimable
      ? h('button', {
        class: 'gg-btn gg-cut gg-btn--glimmer gg-btn--small gg-feat-claim', type: 'button', 'data-testid': `feat-claim-${feat.id}`, 'data-sfx': 'buy',
        'data-reward': String(reward),
        onClick: () => { justClaimed = feat.id; claimFeat(feat.id); },
      }, h('span', null, t('chronicle.claim')), h('span', { class: 'gg-meta-price gg-num' }, icon('glimmer'), `+${formatInt(reward)}`))
      : done
        ? h('span', { class: 'gg-feat-done' }, icon('check'), t('chronicle.done'))
        : h('span', { class: 'gg-feat-reward gg-num', title: t('chronicle.tier', { n: tierIndex + 1, m: total }) }, icon('glimmer'), formatInt(reward));
    return h('article', {
      class: `gg-feat gg-cut${claimable ? ' is-claimable' : ''}${done ? ' is-done' : ''}`, 'data-feat': feat.id, 'data-tier': String(f.tier),
      'data-claimed': String(f.claimed), 'data-claimable': String(claimable),
    },
      h('span', { class: 'gg-feat-icon' }, icon(STAT_ICON[feat.stat] ?? 'trophy')),
      h('div', { class: 'gg-feat-main' },
        h('div', { class: 'gg-feat-top' }, h('h3', null, featName(feat)), h('span', { class: 'gg-feat-tier gg-num' }, roman(Math.min(total, tierIndex + 1))), pips),
        h('p', null, featBody(feat, goal)),
        h('div', { class: 'gg-feat-progress' },
          h('div', { class: 'gg-xp-bar' }, fill),
          h('span', { class: 'gg-num' }, `${formatCompact(Math.min(f.value, done ? f.value : Math.max(goal, f.value)))} / ${formatCompact(goal)}`),
        ),
      ),
      h('div', { class: 'gg-feat-action' }, action),
    );
  };

  function sync(): void {
    const p = state.profile;
    const k = JSON.stringify([p.lifetime, p.feats, p.xp]);
    if (k === key) return;
    key = k;

    const xp = totalXp();
    const rank = wardenRank(xp);
    const into = xp % WARDEN_RANK.XP_PER_RANK;
    const rankFill = h('i');
    rankFill.style.setProperty('--w', `${Math.round((into / WARDEN_RANK.XP_PER_RANK) * 1000) / 10}%`);
    const stats = h('div', { class: 'gg-chron-stats' });
    for (const stat of HEADLINE) {
      stats.append(h('div', { class: 'gg-chron-stat', 'data-stat': stat, 'data-value': String(p.lifetime[stat] ?? 0) },
        icon(STAT_ICON[stat]), h('b', { class: 'gg-num' }, statValue(stat, p.lifetime[stat] ?? 0)), h('span', null, t(`lifetime.${stat}`))));
    }
    head.replaceChildren(
      h('div', { class: 'gg-chron-rank gg-cut', 'data-testid': 'chronicle-rank', 'data-rank': String(rank), title: t('chronicle.rankHint', { n: formatInt(WARDEN_RANK.XP_PER_RANK) }) },
        h('span', { class: 'gg-chron-rank-icon' }, icon('crown')),
        h('div', null,
          h('span', null, t('menu.rank')),
          h('b', { class: 'gg-num' }, formatInt(rank)),
        ),
        h('div', { class: 'gg-chron-rank-bar' },
          h('div', { class: 'gg-xp-bar' }, rankFill),
          h('span', { class: 'gg-num' }, t('chronicle.rankNext', { xp: formatInt(WARDEN_RANK.XP_PER_RANK - into), n: formatInt(rank + 1) })),
        ),
      ),
      stats,
    );

    const claim = claimableGlimmer();
    claimAll.replaceChildren(h('span', null, t('chronicle.claimAll')), h('span', { class: 'gg-meta-price gg-num' }, icon('glimmer'), `+${formatInt(claim.glimmer)}`));
    claimAll.disabled = claim.tiers === 0;
    setAttr(claimAll, 'data-tiers', String(claim.tiers));
    list.replaceChildren(...FEATS.map(featCard));
    if (justClaimed) {
      const card = list.querySelector<HTMLElement>(`[data-feat="${justClaimed}"]`);
      if (card) { retrigger(card, 'is-bought'); window.setTimeout(() => card.classList.remove('is-bought'), UI_CONFIG.PURCHASE_FLASH_MS); }
      justClaimed = null;
    }
  }

  return { el, sync };
}
