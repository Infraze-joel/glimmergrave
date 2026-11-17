/**
 * First-time contextual tips. Each tip is shown once per profile (ui/prefs.ts), one at a time, never during
 * training, a draft or a boss windup. Tips dismiss themselves after a while or with Enter; the HUD stays
 * click-through, so there is no button to press with the mouse.
 */
import { BOON_TUNING } from '@shared/data/boons.ts';
import { ENEMY_TUNING } from '@shared/data/enemies.ts';
import { RUN, WORLD } from '@shared/constants.ts';
import { HAZARD_TIMING } from '@shared/sim/hazards.ts';
import type { ElementId, GameEvent } from '@shared/types.ts';
import { selfRoster, state } from '../core/GameState.ts';
import { h, icon, key } from './dom.ts';
import { bossLabel, distinctElements, enemyName, infusionsOf, resonanceParams, statusParams } from './elements.ts';
import type { IconName } from './icons.ts';
import { t } from './i18n.ts';
import { nameOf } from './model.ts';
import { markTipSeen, tipSeen, tipsEnabled } from './prefs.ts';
import { mark, rich } from './rich.ts';
import { UI_CONFIG } from './store.ts';
import type { View } from './view.ts';

const PERCENT = 100;
const MS = 1000;
/** A tip interrupted by a draft counts as read once it was visible this long. */
const READ_MS = 4000;
const pctMore = (mul: number): number => Math.round((mul - 1) * PERCENT);

export const TIP_IDS = [
  'status.ember', 'status.rime', 'status.storm', 'resonance', 'ally', 'hazard', 'cursed', 'downed', 'elite', 'boss',
] as const;
export type TipId = (typeof TIP_IDS)[number];

export interface TipContent {
  id: TipId;
  icon: IconName;
  tone: string;
  title: string;
  /** Rich markup (see rich.ts). */
  body: string;
}

export interface TipsView extends View {
  onEvent(ev: GameEvent): void;
  /** Run state changed (new chamber, phase, doors). */
  onRun(): void;
  /** Called at HUD rate: shows the next queued tip as soon as nothing forbids it. */
  pump(): void;
  /** Enter: closes the visible tip. Returns false when none was open. */
  dismiss(): boolean;
  /** The session screen was left: forget queued tips; a visible one comes back next time. */
  reset(): void;
}

/** Builds the text of a tip from the live state (exported for the dev harness and the codex of tips). */
export function tipContent(id: TipId, detail: { name?: string; a?: ElementId; b?: ElementId } = {}): TipContent {
  switch (id) {
    case 'status.ember':
    case 'status.rime':
    case 'status.storm': {
      const el = id.slice('status.'.length) as ElementId;
      return { id, icon: el, tone: el, title: t(`tip.status.${el}.title`), body: t(`tip.status.${el}.body`, statusParams(el)) };
    }
    case 'resonance':
      return { id, icon: 'resonance', tone: 'res', title: t('tip.resonance.title'), body: t('tip.resonance.body', resonanceParams()) };
    case 'ally': {
      const a = detail.a ?? 'ember';
      const b = detail.b ?? 'rime';
      return {
        id, icon: 'resonance', tone: 'res', title: t('tip.ally.title'),
        body: t('tip.ally.body', {
          name: detail.name ?? '', a: mark(a, t(`element.${a}.name`)), b: mark(b, t(`element.${b}.name`)),
        }),
      };
    }
    case 'hazard': {
      const kind = state.run?.room?.hazards[0]?.kind ?? 'spikes';
      return {
        id, icon: kind, tone: `hazard-${kind}`, title: t('tip.hazard.title', { name: t(`hazard.${kind}.name`) }),
        body: t('tip.hazard.body', { warn: HAZARD_TIMING.WARN }),
      };
    }
    case 'cursed':
      return {
        id, icon: 'cursed', tone: 'cursed', title: t('tip.cursed.title'),
        body: t('tip.cursed.body', {
          hp: pctMore(ENEMY_TUNING.ELITE_HP_MUL), dmg: pctMore(ENEMY_TUNING.ELITE_DAMAGE_MUL), n: BOON_TUNING.CURSED_DRAFT_CHOICES,
        }),
      };
    case 'downed': {
      const solo = state.roster.length <= 1;
      return {
        id, icon: 'revive', tone: 'danger', title: t('tip.downed.title'),
        body: solo ? t('tip.downedSolo.body', { n: RUN.SOLO_SECOND_WINDS }) : t('tip.downed.body', { t: WORLD.REVIVE_SECONDS }),
      };
    }
    case 'elite':
      return { id, icon: 'elite', tone: 'danger', title: t('tip.elite.title'), body: t('tip.elite.body', { name: enemyName('champion') }) };
    case 'boss': {
      const run = state.run;
      const name = detail.name ?? (run ? bossLabel(run).name : enemyName('regent'));
      return { id, icon: 'boss', tone: 'danger', title: t('tip.boss.title', { name }), body: t('tip.boss.body') };
    }
  }
}

interface Shown {
  content: TipContent;
  since: number;
  timer: number;
}

export function createTips(): TipsView {
  const el = h('div', { class: 'gg-tip-slot', 'aria-live': 'polite' });
  const queue: TipContent[] = [];
  let current: Shown | null = null;
  let bossBusyUntil = 0;
  let nextAt = 0;
  let retry = 0;

  const blocked = (): boolean => {
    const run = state.run;
    if (!run || state.screen !== 'game' || run.tutorial) return true;
    if (run.phase === 'draft' || run.phase === 'victory' || run.phase === 'defeat') return true;
    return performance.now() < bossBusyUntil;
  };

  const close = (seen: boolean): void => {
    if (!current) return;
    const { content, timer } = current;
    window.clearTimeout(timer);
    if (seen) markTipSeen(content.id);
    else queue.unshift(content);
    current = null;
    el.replaceChildren();
    nextAt = performance.now() + UI_CONFIG.TIP_GAP_MS;
  };

  const open = (content: TipContent): void => {
    const card = h('aside', { class: 'gg-tip', 'data-testid': 'tip-root', 'data-tip': content.id, 'data-tone': content.tone },
      h('div', { class: 'gg-tip-head' },
        h('span', { class: 'gg-tip-icon' }, icon(content.icon)),
        h('div', null,
          h('span', { class: 'gg-tip-label' }, icon('tip'), t('tip.label')),
          h('b', { class: 'gg-tip-title' }, content.title),
        ),
      ),
      h('p', { class: 'gg-tip-body' }, ...rich(content.body)),
      h('div', { class: 'gg-tip-foot' }, key('Enter'), h('span', null, t('tip.dismiss'))),
      h('i', { class: 'gg-tip-timer' }),
    );
    card.style.setProperty('--tip-s', `${UI_CONFIG.TIP_SECONDS}s`);
    el.replaceChildren(card);
    current = {
      content, since: performance.now(),
      timer: window.setTimeout(() => close(true), UI_CONFIG.TIP_SECONDS * MS),
    };
  };

  const offer = (id: TipId, detail?: { name?: string; a?: ElementId; b?: ElementId }, urgent = false): void => {
    if (!tipsEnabled() || tipSeen(id) || state.run?.tutorial) return;
    if (current?.content.id === id || queue.some((q) => q.id === id)) return;
    const content = tipContent(id, detail);
    if (urgent) queue.unshift(content);
    else queue.push(content);
  };

  function pump(): void {
    if (current) {
      if (!tipsEnabled()) close(true);
      else if (blocked()) close(performance.now() - current.since >= READ_MS);
      return;
    }
    if (queue.length === 0) return;
    const wait = Math.max(nextAt, bossBusyUntil) - performance.now();
    if (wait > 0) {
      // Pause between two tips / boss windup: come back by ourselves instead of relying on the next HUD update.
      window.clearTimeout(retry);
      retry = window.setTimeout(pump, wait + 1);
      return;
    }
    if (blocked()) return;
    if (!tipsEnabled()) { queue.length = 0; return; }
    const next = queue.shift();
    if (next && !tipSeen(next.id)) open(next);
  }

  const onEvent = (ev: GameEvent): void => {
    const own = state.conn.slot;
    switch (ev.e) {
      case 'hit': {
        if (ev.target.t !== 'e' || !ev.el || ev.by < 0) break;
        if (ev.by === own) { offer(`status.${ev.el}`); break; }
        if (tipSeen('ally') || !tipsEnabled()) break; // hits are frequent: skip the look-up below once it is moot
        const mine = distinctElements(infusionsOf(selfRoster()?.boons ?? [])).find((el2) => el2 !== ev.el);
        if (mine) offer('ally', { name: nameOf(ev.by), a: ev.el, b: mine });
        break;
      }
      case 'resonance': offer('resonance'); break;
      case 'down': if (ev.slot === own) offer('downed', undefined, true); break;
      case 'telegraph': {
        const bossId = state.run?.bossId ?? -1;
        if (bossId >= 0 && ev.src === bossId) bossBusyUntil = Math.max(bossBusyUntil, performance.now() + ev.dur * MS);
        break;
      }
      default: break;
    }
    pump();
  };

  const onRun = (): void => {
    const run = state.run;
    if (!run || run.tutorial) { if (!run) queue.length = 0; pump(); return; }
    if (run.phase === 'combat') {
      if (run.chamberKind === 'boss') offer('boss');
      else if (run.chamberKind === 'elite') offer(bossLabel(run).herald ? 'boss' : 'elite');
      if ((run.room?.hazards.length ?? 0) > 0) offer('hazard');
    }
    if (run.phase === 'doors' && run.doors.some((d) => d.type === 'cursed')) offer('cursed');
    pump();
  };

  const dismiss = (): boolean => {
    if (!current) return false;
    close(true);
    return true;
  };

  const reset = (): void => {
    if (current) close(false);
    queue.length = 0;
    bossBusyUntil = 0;
    nextAt = 0;
    window.clearTimeout(retry);
  };

  return {
    el, sync: pump, onEvent, onRun, pump, dismiss, reset,
    dispose: () => { if (current) window.clearTimeout(current.timer); window.clearTimeout(retry); },
  };
}
