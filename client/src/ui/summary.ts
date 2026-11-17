/**
 * Run summary: victory / defeat, chamber reached, time, oath, Glimmer earned, stats with per-column best.
 * A finished training session shows "Training complete" instead: what was learned, the Glimmer reward and
 * the two obvious next steps (play, or spend the reward in the Armory).
 */
import { RUN } from '@shared/constants.ts';
import { ELEMENT_IDS } from '@shared/types.ts';
import { bus } from '../core/EventBus.ts';
import { isHost, state } from '../core/GameState.ts';
import { h, icon, replace } from './dom.ts';
import { enemyName, resonanceParams, statusParams } from './elements.ts';
import { formatInt, formatTime, roman, t } from './i18n.ts';
import { MAX_OATH, oathName } from './model.ts';
import { richEl } from './rich.ts';
import { statsTable } from './scoreboard.ts';
import { ui, type ModalKind, type PageKind } from './store.ts';
import type { View } from './view.ts';
import { motes } from './menu.ts';

export interface SummaryView extends View {
  primaryAction(): void;
}

/** Oath level that this run newly unlocked for the local profile, or null. */
function unlockedOath(): number | null {
  const run = state.run;
  if (!run || run.phase !== 'victory' || run.tutorial) return null;
  const next = Math.min(MAX_OATH, run.oath + 1);
  const baseline = ui.oathBaseline ?? state.profile.oathUnlocked;
  return next > baseline ? next : null;
}

/** Glimmer the own hero earned in this run, or null while the server has not announced the rewards yet. */
function ownReward(): number | null {
  const reward = state.run?.rewards?.find((r) => r.slot === state.conn.slot);
  return reward ? Math.max(0, Math.round(reward.glimmer)) : null;
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
    for (const element of ELEMENT_IDS) {
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
          ? h('div', { class: 'gg-training-panel gg-cut' }, h('div', { class: 'gg-label' }, t('training.learned')), learned)
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

  let contentKey = '';
  const sync = (): void => {
    const run = state.run;
    if (!run) return;
    const victory = run.phase === 'victory';
    const isTraining = run.tutorial !== null && run.tutorial !== undefined;
    el.dataset.result = victory ? 'victory' : 'defeat';
    el.dataset.mode = isTraining ? 'training' : 'run';
    const host = isHost();
    const unlocked = unlockedOath();
    const earned = ownReward();
    const key = JSON.stringify([
      run.phase, run.chamber, Math.floor(run.elapsed), run.oath, run.stats, host, unlocked, state.conn.slot, isTraining, earned,
      state.profile.glimmer, run.finalBoss,
      state.roster.map((p) => [p.slot, p.name, p.cls, p.connected]),
    ]);
    if (key === contentKey) return;
    contentKey = key;
    if (isTraining) { training(victory, earned); return; }
    const chamber = Math.min(RUN.CHAMBERS.length, run.chamber + 1);
    replace(content,
      h('header', { class: 'gg-summary-head' },
        h('div', { class: 'gg-summary-emblem' }, icon(victory ? 'boss' : 'skull')),
        h('h1', { class: 'gg-summary-title' }, victory ? t('summary.victory') : t('summary.defeat')),
        h('p', { class: 'gg-summary-sub' },
          victory ? t('summary.victorySub', { boss: enemyName(run.finalBoss ?? 'regent') }) : t('summary.defeatSub')),
      ),
      h('div', { class: 'gg-summary-chips' },
        chip('door', t('summary.chamber'), t('summary.chamberValue', { n: chamber, m: RUN.CHAMBERS.length })),
        chip('hourglass', t('summary.time'), formatTime(run.elapsed)),
        chip('bell', t('summary.oath'), run.oath > 0 ? `${roman(run.oath)} · ${oathName(run.oath)}` : oathName(0)),
        glimmerChip(earned, ''),
      ),
      unlocked !== null
        ? h('div', { class: 'gg-summary-unlock', role: 'status' },
          icon('bell'),
          h('div', null, h('b', null, t('summary.unlocked', { name: oathName(unlocked) })), h('span', null, t('summary.unlockedHint'))))
        : null,
      h('div', { class: 'gg-summary-table gg-cut' },
        statsTable({ mvp: true, boons: false }),
        h('p', { class: 'gg-summary-legend' }, icon('star', 'gg-mvp-star'), t('summary.mvp')),
      ),
      h('footer', { class: 'gg-summary-actions' },
        host ? null : h('p', { class: 'gg-summary-wait' }, h('span', { class: 'gg-spinner' }), t('summary.waitingHost')),
        h('button', {
          class: 'gg-btn gg-cut gg-btn--ghost', type: 'button', 'data-testid': 'summary-leave', onClick: () => openModal('leave'),
        }, icon('exit'), t('common.leave')),
        armoryButton(false, t('menu.armory')),
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
    primaryAction: () => {
      if (state.run?.tutorial) bus.emit('ui:leave');
      else if (isHost()) bus.emit('ui:toLobby');
    },
  };
}
