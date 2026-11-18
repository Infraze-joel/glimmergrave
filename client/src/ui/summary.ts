/**
 * Run summary: outcome, depth and bosses slain, time, oath, the own hero's rewards (Glimmer, mastery XP with
 * level-ups, relic shards, claimable feats) and the party's stats with per-column best.
 * A finished training session shows "Training complete" instead: what was learned, the Glimmer reward and
 * the two obvious next steps (play, or spend the reward in the Armory).
 */
import { RUN } from '@shared/constants.ts';
import { CLASSES } from '@shared/data/classes.ts';
import { MASTERY, levelFromXp, masteryMods } from '@shared/data/mastery.ts';
import { RELIC_BY_ID } from '@shared/data/relics.ts';
import type { ClassId, ElementId, RunReward, RunState } from '@shared/types.ts';
import { bus } from '../core/EventBus.ts';
import { featsReady, isHost, relicRank, selfRoster, state } from '../core/GameState.ts';
import { h, icon, replace } from './dom.ts';
import { enemyName, resonanceParams, statusParams } from './elements.ts';
import type { IconName } from './icons.ts';
import { formatInt, formatTime, roman, t } from './i18n.ts';
import { ART_ICON, MAX_OATH, artName, depthLabel, oathName } from './model.ts';
import { objectiveTally } from './objective.ts';
import { RELIC_ICON } from './reliquary.ts';
import { richEl } from './rich.ts';
import { statsTable } from './scoreboard.ts';
import { ui, UI_CONFIG, type HubTab, type ModalKind, type PageKind } from './store.ts';
import { modText, relicName } from './text.ts';
import type { View } from './view.ts';
import { motes } from './menu.ts';

const TAUGHT_ELEMENTS: readonly ElementId[] = ['ember', 'rime', 'storm'];

export interface SummaryView extends View {
  primaryAction(): void;
}

/** A run counts as won as soon as one final boss fell, even if the party died deeper down. */
const runWon = (run: RunState): boolean => (run.cleared ?? 0) > 0 || run.phase === 'victory';

/** Oath level that this run newly unlocked for the local profile, or null. */
function unlockedOath(): number | null {
  const run = state.run;
  if (!run || !runWon(run) || run.tutorial) return null;
  const next = Math.min(MAX_OATH, run.oath + 1);
  const baseline = ui.oathBaseline ?? state.profile.oathUnlocked;
  return next > baseline ? next : null;
}

function ownRewardRow(): RunReward | null {
  return state.run?.rewards?.find((r) => r.slot === state.conn.slot) ?? null;
}

/** Glimmer the own hero earned in this run, or null while the server has not announced the rewards yet. */
function ownReward(): number | null {
  const reward = ownRewardRow();
  return reward ? Math.max(0, Math.round(reward.glimmer)) : null;
}

interface XpGain {
  cls: ClassId;
  gain: number;
  /** Total experience of the class before and after this run. */
  from: number;
  to: number;
}

/**
 * Experience the own hero gained. The profile is already booked when the summary shows (`game:progress`), so
 * "before" is the profile's total minus the gain.
 */
function xpGain(reward: RunReward): XpGain {
  const cls = ui.progress?.cls ?? selfRoster()?.cls ?? state.profile.cls;
  const gain = Math.max(0, Math.floor(ui.progress?.xp ?? reward.xp ?? 0));
  const to = Math.max(gain, Math.floor(state.profile.xp[cls] ?? 0));
  return { cls, gain, from: to - gain, to };
}

interface RelicDrop {
  id: string;
  shards: number;
  rank: number;
  rankUp: boolean;
  isNew: boolean;
}

/** Shards found, one row per relic. Rank-ups come from `game:progress`; without it only the counts are known. */
function relicDrops(reward: RunReward): RelicDrop[] {
  const out = new Map<string, RelicDrop>();
  const booked = ui.progress?.relics;
  if (booked) {
    for (const drop of booked) {
      const row = out.get(drop.id) ?? { id: drop.id, shards: 0, rank: 0, rankUp: false, isNew: false };
      row.shards += 1;
      row.rank = Math.max(row.rank, drop.rank);
      row.rankUp = row.rankUp || drop.rankUp;
      row.isNew = row.isNew || (drop.rankUp && drop.rank === 1);
      out.set(drop.id, row);
    }
  } else {
    for (const id of reward.relics ?? []) {
      const row = out.get(id) ?? { id, shards: 0, rank: relicRank(id), rankUp: false, isNew: false };
      row.shards += 1;
      out.set(id, row);
    }
  }
  return [...out.values()].filter((row) => RELIC_BY_ID.has(row.id));
}

/** What the levels gained in this run unlocked, most important first. */
function levelUnlocks(cls: ClassId, from: number, to: number): { icon: IconName; text: string; major: boolean }[] {
  const out: { icon: IconName; text: string; major: boolean }[] = [];
  for (let level = from + 1; level <= to; level++) {
    if (level === MASTERY.ART_LEVEL && CLASSES[cls].arts.length > 0) {
      out.push({ icon: ART_ICON[cls], text: t('summary.unlock.art', { name: artName(cls) }), major: true });
    }
    const tier = (MASTERY.TALENT_LEVELS as readonly number[]).indexOf(level);
    if (tier >= 0) out.push({ icon: 'talent', text: t('summary.unlock.talent', { n: roman(tier + 1) }), major: true });
  }
  if (to > from) {
    const bonus = modText(masteryMods(to));
    if (bonus !== '') out.push({ icon: 'mastery', text: t('summary.unlock.bonus', { bonus }), major: false });
  }
  return out;
}

export function createSummary(openModal: (kind: ModalKind) => void, openPage: (page: PageKind) => void): SummaryView {
  const content = h('div', { class: 'gg-summary-box' });
  const el = h('section', { class: 'gg-screen gg-summary gg-backdrop', 'data-testid': 'summary-root', 'data-result': 'defeat' },
    motes(), content);

  const chip = (iconName: 'door' | 'hourglass' | 'bell', label: string, value: string): HTMLElement =>
    h('div', { class: 'gg-summary-chip gg-cut' }, icon(iconName), h('div', null, h('span', null, label), h('b', { class: 'gg-num' }, value)));

  const glimmerChip = (earned: number | null, cls: string): HTMLElement =>
    h('div', {
      class: `gg-summary-chip gg-cut gg-summary-glimmer ${cls}`, 'data-testid': 'summary-glimmer', 'data-earned': String(earned ?? 0),
    },
      icon('glimmer'),
      h('div', null,
        h('span', null, t('summary.glimmer')),
        h('b', { class: 'gg-num' }, earned === null ? t('summary.glimmerPending') : `+${formatInt(earned)}`),
      ),
      h('em', { class: 'gg-summary-wallet gg-num' }, t('summary.wallet', { n: formatInt(state.profile.glimmer) })),
    );

  const armoryButton = (primary: boolean, label: string): HTMLElement =>
    h('button', {
      class: `gg-btn gg-cut${primary ? ' gg-btn--glimmer' : ''}`, type: 'button', 'data-testid': 'summary-armory', 'data-sfx': 'click',
      onClick: () => openPage('armory'),
    }, icon('armory'), label);

  const training = (victory: boolean, earned: number | null): void => {
    const learned = h('ul', { class: 'gg-training-learned' });
    // The training teaches three of the four elements; the rest is hinted at below the list.
    for (const element of TAUGHT_ELEMENTS) {
      learned.append(h('li', { 'data-element': element },
        h('span', { class: 'gg-training-icon' }, icon(element)),
        richEl('p', '', t(`training.${element}`, statusParams(element)))));
    }
    learned.append(h('li', { 'data-element': 'res' },
      h('span', { class: 'gg-training-icon' }, icon('resonance')),
      richEl('p', '', t('training.resonance', resonanceParams()))));
    replace(content,
      h('div', { class: 'gg-training-box', 'data-testid': 'tutorial-summary', 'data-result': victory ? 'done' : 'failed' },
        h('header', { class: 'gg-summary-head' },
          h('div', { class: 'gg-summary-emblem' }, icon(victory ? 'training' : 'hourglass')),
          h('h1', { class: 'gg-summary-title gg-training-title' }, victory ? t('training.title') : t('training.failedTitle')),
          h('p', { class: 'gg-summary-sub' }, victory ? t('training.sub') : t('training.failedSub')),
        ),
        victory
          ? h('div', { class: 'gg-training-panel gg-cut' }, h('div', { class: 'gg-label' }, t('training.learned')), learned,
            richEl('p', 'gg-training-beyond', t('training.beyond')))
          : null,
        victory
          ? h('div', { class: 'gg-training-reward' },
            glimmerChip(earned, 'is-big'),
            h('p', { class: 'gg-training-hint' }, t('training.glimmerHint')))
          : null,
        h('footer', { class: 'gg-summary-actions' },
          victory ? armoryButton(false, t('training.armory')) : null,
          h('button', {
            class: 'gg-btn gg-cut gg-btn--primary', type: 'button', 'data-testid': 'summary-leave', 'data-sfx': 'confirm',
            onClick: () => bus.emit('ui:leave'),
          }, icon('bell'), t('training.play')),
        ),
      ),
    );
  };

  const openHub = (tab: HubTab): void => { ui.hubTab = tab; openPage('armory'); };

  // ---- experience bar: fills from the total before the run to the total after it, level by level
  let xpFrame = 0;
  const stopXp = (): void => { if (xpFrame !== 0) { window.cancelAnimationFrame(xpFrame); xpFrame = 0; } };

  const xpPanel = (gain: XpGain): HTMLElement => {
    const before = levelFromXp(gain.from);
    const after = levelFromXp(gain.to);
    const levelText = h('b', { class: 'gg-xp-level gg-num' });
    const fill = h('i', { class: 'gg-xp-fill' });
    const numbers = h('span', { class: 'gg-xp-numbers gg-num' });
    const unlocks = h('ul', { class: 'gg-xp-unlocks' });
    for (const unlock of levelUnlocks(gain.cls, before.level, after.level)) {
      unlocks.append(h('li', { class: unlock.major ? 'is-major' : '' }, icon(unlock.icon), h('span', null, unlock.text)));
    }
    const leveled = after.level > before.level;
    const panel = h('div', {
      class: `gg-reward gg-reward--xp gg-cut gg-cls-${gain.cls}${leveled ? ' is-levelup' : ''}`, 'data-testid': 'summary-xp',
      'data-xp': String(gain.gain), 'data-level': String(after.level), 'data-levels': String(after.level - before.level),
    },
      h('div', { class: 'gg-reward-head' },
        h('span', { class: 'gg-reward-emblem' }, icon(gain.cls)),
        h('div', { class: 'gg-reward-title' },
          h('span', null, t('summary.xp', { cls: t(`class.${gain.cls}.name`) })),
          h('b', { class: 'gg-num' }, t('summary.xpGain', { n: formatInt(gain.gain) })),
        ),
        leveled ? h('em', { class: 'gg-xp-up' }, icon('ascension'), t('summary.levelUp')) : null,
        h('div', { class: 'gg-xp-lv' }, h('span', null, t('mastery.level')), levelText),
      ),
      h('div', { class: 'gg-xp-bar' }, fill),
      h('div', { class: 'gg-xp-foot' }, numbers, unlocks),
    );
    const paint = (xp: number): void => {
      const at = levelFromXp(xp);
      levelText.textContent = String(at.level);
      fill.style.setProperty('--w', `${Math.round((at.into / Math.max(1, at.need)) * 1000) / 10}%`);
      numbers.textContent = t('summary.xpNext', { n: formatInt(Math.max(0, at.need - at.into)), m: at.level + 1 });
    };
    stopXp();
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    if (still || gain.gain <= 0) { paint(gain.to); return panel; }
    paint(gain.from);
    const begin = performance.now() + UI_CONFIG.XP_FILL_DELAY_MS;
    const step = (now: number): void => {
      const k = Math.min(1, Math.max(0, (now - begin) / UI_CONFIG.XP_FILL_MS));
      // ease-out: fast first, settling at the end
      paint(gain.from + (gain.to - gain.from) * (1 - (1 - k) * (1 - k)));
      if (k < 1 && panel.isConnected) xpFrame = window.requestAnimationFrame(step);
      else { xpFrame = 0; paint(gain.to); panel.classList.add('is-done'); }
    };
    xpFrame = window.requestAnimationFrame(step);
    return panel;
  };

  const relicPanel = (drops: RelicDrop[]): HTMLElement => {
    const list = h('ul', { class: 'gg-relic-drops' });
    for (const drop of drops) {
      const def = RELIC_BY_ID.get(drop.id);
      if (!def) continue;
      list.append(h('li', { class: `${drop.rankUp ? 'is-rankup' : ''}${drop.isNew ? ' is-new' : ''}`, 'data-relic': drop.id, 'data-rankup': String(drop.rankUp) },
        h('span', { class: 'gg-relic-drop-icon' }, icon(RELIC_ICON[drop.id] ?? 'relic')),
        h('div', null,
          h('b', null, relicName(def)),
          h('span', null,
            drop.isNew ? t('summary.relic.new')
              : drop.rankUp ? t('summary.relic.rankUp', { n: roman(drop.rank) })
                : drop.rank > 0 ? t('summary.relic.rank', { n: roman(drop.rank) }) : ''),
        ),
        h('em', { class: 'gg-num' }, icon('shard'), `+${drop.shards}`),
      ));
    }
    return h('div', { class: 'gg-reward gg-reward--relics gg-cut', 'data-testid': 'summary-relics', 'data-shards': String(drops.reduce((n, d) => n + d.shards, 0)) },
      h('div', { class: 'gg-reward-label' }, icon('relic'), t('summary.relics')),
      drops.length > 0 ? list : h('p', { class: 'gg-reward-empty' }, t('summary.relics.none')),
    );
  };

  const featsButton = (): HTMLElement | null => {
    const ready = featsReady();
    if (ready <= 0) return null;
    return h('button', {
      class: 'gg-btn gg-cut gg-btn--small gg-summary-feats', type: 'button', 'data-testid': 'summary-chronicle', 'data-ready': String(ready), 'data-sfx': 'click',
      onClick: () => openHub('chronicle'),
    }, icon('trophy'), h('span', null, ready === 1 ? t('summary.feats.one') : t('summary.feats.many', { n: ready })), icon('chevron'));
  };

  let contentKey = '';
  const sync = (): void => {
    const run = state.run;
    if (!run) return;
    const victory = run.phase === 'victory';
    const isTraining = run.tutorial !== null && run.tutorial !== undefined;
    const won = runWon(run);
    const depth = Math.max(0, Math.floor(run.depth ?? 0));
    // A party that fell below the first depth still rang the bell: success colours, its own wording.
    const ending = victory ? 'ascended' : won ? 'fell' : 'defeat';
    el.dataset.result = isTraining ? (victory ? 'victory' : 'defeat') : won ? 'victory' : 'defeat';
    el.dataset.ending = ending;
    el.dataset.mode = isTraining ? 'training' : 'run';
    const host = isHost();
    const unlocked = unlockedOath();
    const earned = ownReward();
    const reward = ownRewardRow();
    const tally = objectiveTally(run);
    const key = JSON.stringify([
      tally, run.phase, run.chamber, depth, run.cleared, Math.floor(run.elapsed), run.oath, run.stats, run.rewards, host, unlocked, state.conn.slot,
      isTraining, earned, state.profile.glimmer, run.finalBoss, ui.progress, featsReady(),
      state.roster.map((p) => [p.slot, p.name, p.cls, p.connected, p.mastery]),
    ]);
    if (key === contentKey) return;
    contentKey = key;
    if (isTraining) { stopXp(); training(victory, earned); return; }
    const chamber = Math.min(RUN.CHAMBERS.length, run.chamber + 1);
    const cleared = Math.max(0, Math.floor(run.cleared ?? 0));
    const title = ending === 'fell' ? t('summary.fellTitle') : won ? t('summary.victory') : t('summary.defeat');
    const sub = ending === 'fell' ? t('summary.fellSub', { n: roman(depth + 1) })
      : ending === 'ascended' && depth > 0 ? t('summary.ascendedSub', { n: roman(depth + 1) })
        : won ? t('summary.victorySub', { boss: enemyName(run.finalBoss ?? 'regent') }) : t('summary.defeatSub');
    replace(content,
      h('header', { class: 'gg-summary-head' },
        h('div', { class: 'gg-summary-emblem' }, icon(ending === 'fell' ? 'bell' : won ? 'boss' : 'skull')),
        h('h1', { class: 'gg-summary-title', 'data-testid': 'summary-title' }, title),
        h('p', { class: 'gg-summary-sub' }, sub),
      ),
      h('div', { class: 'gg-summary-chips' },
        depth > 0 || won
          ? h('div', { class: 'gg-summary-chip gg-cut gg-summary-chip--depth', 'data-testid': 'summary-depth', 'data-depth': String(depth) },
            icon('depth'), h('div', null, h('span', null, t('summary.depth')),
              h('b', { class: 'gg-num' }, `${depthLabel(depth)} · ${t('summary.chamberValue', { n: chamber, m: RUN.CHAMBERS.length })}`)))
          : chip('door', t('summary.chamber'), t('summary.chamberValue', { n: chamber, m: RUN.CHAMBERS.length })),
        won
          ? h('div', { class: 'gg-summary-chip gg-cut gg-summary-chip--bosses', 'data-testid': 'summary-bosses', 'data-cleared': String(cleared) },
            icon('crown'), h('div', null, h('span', null, t('summary.bosses')), h('b', { class: 'gg-num' }, String(cleared))))
          : null,
        // Special objectives completed and bonuses earned in the whole run (counted by the server).
        tally.done > 0
          ? h('div', { class: 'gg-summary-chip gg-cut gg-summary-chip--objectives', 'data-testid': 'summary-objectives', 'data-done': String(tally.done), 'data-bonus': String(tally.bonus) },
            icon('hunt'), h('div', null, h('span', null, t('summary.objectives')),
              h('b', { class: 'gg-num' }, t('summary.objectivesValue', { n: tally.done })),
              h('em', { class: 'gg-summary-bonuses gg-num' }, icon('star'), tally.bonus === 1 ? t('summary.bonuses.one') : t('summary.bonuses.many', { n: tally.bonus }))))
          : null,
        chip('hourglass', t('summary.time'), formatTime(run.elapsed)),
        // Named Oaths show numeral and name; the numbered ones above are their own name.
        chip('bell', t('summary.oath'), run.oath > 0 && run.oath < RUN.OATH.length ? `${roman(run.oath)} · ${oathName(run.oath)}` : oathName(run.oath)),
      ),
      unlocked !== null
        ? h('div', { class: 'gg-summary-unlock', role: 'status' },
          icon('bell'),
          h('div', null, h('b', null, t('summary.unlocked', { name: oathName(unlocked) })), h('span', null, t('summary.unlockedHint'))))
        : null,
      h('section', { class: 'gg-summary-rewards', 'data-testid': 'summary-rewards', 'data-pending': String(reward === null), 'aria-label': t('summary.rewards') },
        h('div', { class: 'gg-label gg-summary-rewards-label' }, t('summary.rewards'), featsButton()),
        h('div', { class: 'gg-summary-rewards-row' },
          glimmerChip(earned, 'gg-reward gg-reward--glimmer'),
          reward ? xpPanel(xpGain(reward)) : h('div', { class: 'gg-reward gg-reward--xp gg-cut is-pending' }, h('span', { class: 'gg-spinner' }), t('summary.pending')),
          reward ? relicPanel(relicDrops(reward)) : null,
        ),
      ),
      h('div', { class: 'gg-summary-table gg-cut' },
        statsTable({ mvp: true, boons: false, rewards: true }),
        h('p', { class: 'gg-summary-legend' }, icon('star', 'gg-mvp-star'), t('summary.mvp')),
      ),
      h('footer', { class: 'gg-summary-actions' },
        host ? null : h('p', { class: 'gg-summary-wait' }, h('span', { class: 'gg-spinner' }), t('summary.waitingHost')),
        h('button', {
          class: 'gg-btn gg-cut gg-btn--ghost', type: 'button', 'data-testid': 'summary-leave', onClick: () => openModal('leave'),
        }, icon('exit'), t('common.leave')),
        armoryButton(reward !== null && !host, t('summary.spend')),
        host
          ? h('button', {
            class: 'gg-btn gg-cut gg-btn--primary', type: 'button', 'data-testid': 'summary-to-lobby',
            onClick: () => bus.emit('ui:toLobby'),
          }, t('summary.toLobby'))
          : null,
      ),
    );
  };

  return {
    el, sync,
    dispose: stopXp,
    primaryAction: () => {
      if (state.run?.tutorial) bus.emit('ui:leave');
      else if (isHost()) bus.emit('ui:toLobby');
    },
  };
}
