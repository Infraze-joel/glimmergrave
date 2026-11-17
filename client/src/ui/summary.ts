/** Run summary: victory / defeat, chamber reached, time, oath, stats with per-column best, next steps. */
import { RUN } from '@shared/constants.ts';
import { bus } from '../core/EventBus.ts';
import { isHost, state } from '../core/GameState.ts';
import { h, icon, replace } from './dom.ts';
import { formatTime, roman, t } from './i18n.ts';
import { MAX_OATH, oathName } from './model.ts';
import { statsTable } from './scoreboard.ts';
import { ui, type ModalKind } from './store.ts';
import type { View } from './view.ts';
import { motes } from './menu.ts';

export interface SummaryView extends View {
  primaryAction(): void;
}

/** Oath level that this run newly unlocked for the local profile, or null. */
function unlockedOath(): number | null {
  const run = state.run;
  if (!run || run.phase !== 'victory') return null;
  const next = Math.min(MAX_OATH, run.oath + 1);
  const baseline = ui.oathBaseline ?? state.profile.oathUnlocked;
  return next > baseline ? next : null;
}

export function createSummary(openModal: (kind: ModalKind) => void): SummaryView {
  const content = h('div', { class: 'gg-summary-box' });
  const el = h('section', { class: 'gg-screen gg-summary gg-backdrop', 'data-testid': 'summary-root', 'data-result': 'defeat' },
    motes(), content);

  const chip = (iconName: 'door' | 'hourglass' | 'bell', label: string, value: string): HTMLElement =>
    h('div', { class: 'gg-summary-chip gg-cut' }, icon(iconName), h('div', null, h('span', null, label), h('b', { class: 'gg-num' }, value)));

  let contentKey = '';
  const sync = (): void => {
    const run = state.run;
    if (!run) return;
    const victory = run.phase === 'victory';
    el.dataset.result = victory ? 'victory' : 'defeat';
    const host = isHost();
    const unlocked = unlockedOath();
    const key = JSON.stringify([
      run.phase, run.chamber, Math.floor(run.elapsed), run.oath, run.stats, host, unlocked, state.conn.slot,
      state.roster.map((p) => [p.slot, p.name, p.cls, p.connected]),
    ]);
    if (key === contentKey) return;
    contentKey = key;
    const chamber = Math.min(RUN.CHAMBERS.length, run.chamber + 1);
    replace(content,
      h('header', { class: 'gg-summary-head' },
        h('div', { class: 'gg-summary-emblem' }, icon(victory ? 'boss' : 'skull')),
        h('h1', { class: 'gg-summary-title' }, victory ? t('summary.victory') : t('summary.defeat')),
        h('p', { class: 'gg-summary-sub' }, victory ? t('summary.victorySub') : t('summary.defeatSub')),
      ),
      h('div', { class: 'gg-summary-chips' },
        chip('door', t('summary.chamber'), t('summary.chamberValue', { n: chamber, m: RUN.CHAMBERS.length })),
        chip('hourglass', t('summary.time'), formatTime(run.elapsed)),
        chip('bell', t('summary.oath'), run.oath > 0 ? `${roman(run.oath)} · ${oathName(run.oath)}` : oathName(0)),
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
        host
          ? h('button', {
            class: 'gg-btn gg-cut gg-btn--primary', type: 'button', 'data-testid': 'summary-to-lobby',
            onClick: () => bus.emit('ui:toLobby'),
          }, t('summary.toLobby'))
          : null,
      ),
    );
  };

  return { el, sync, primaryAction: () => { if (isHost()) bus.emit('ui:toLobby'); } };
}
