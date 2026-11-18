/**
 * Chamber objectives on the HUD (update 4): the tracker under the chamber track that always answers "what do
 * we do now?", and the banner that introduces an objective and announces its completion.
 * Like the rest of the HUD both are click-through and only read GameState.
 */
import { OBJECTIVES, OBJECTIVE_TUNING } from '@shared/data/objectives.ts';
import type { GameEvent, ObjectiveKind, ObjectiveState, RunState } from '@shared/types.ts';
import { state } from '../core/GameState.ts';
import { h, icon, retrigger, setAttr, setText, setVar, show, toggle } from './dom.ts';
import type { IconName } from './icons.ts';
import { formatTime, t, tx } from './i18n.ts';
import { ui, UI_CONFIG } from './store.ts';

const PERCENT = 100;
type ObjectiveEvent = Extract<GameEvent, { e: 'objective' }>;

export const OBJECTIVE_ICON: Record<ObjectiveKind, IconName> = {
  slay: 'combat', survive: 'survive', defend: 'defend', hunt: 'hunt', ritual: 'ritual', vault: 'vault',
};

export const objectiveName = (kind: ObjectiveKind): string => tx(`objective.${kind}.name`, undefined, OBJECTIVES[kind].name);
export const objectiveGoal = (kind: ObjectiveKind): string => tx(`objective.${kind}.goal`, undefined, OBJECTIVES[kind].goal);
export const hasBonus = (kind: ObjectiveKind): boolean => OBJECTIVES[kind].bonus !== '';
/** The bonus condition, or '' for objectives without one (slay, vault). */
export const objectiveBonus = (kind: ObjectiveKind): string => (hasBonus(kind) ? tx(`objective.${kind}.bonus`, undefined, OBJECTIVES[kind].bonus) : '');

/** `data-bonus` of the tracker: none (no condition), open (can still be met), lost, earned. */
export type BonusState = 'none' | 'open' | 'lost' | 'earned';

export function bonusState(o: ObjectiveState): BonusState {
  if (!hasBonus(o.kind)) return 'none';
  if (o.status === 'done') return o.bonus ? 'earned' : 'lost';
  return o.bonus ? 'open' : 'lost';
}

/**
 * Whether the draft that follows the current chamber was upgraded: 'bonus' (objective bonus met), 'vault'
 * (a vault's draft is always richer) or null. Reads `run.objective` while the server still sends it during
 * the draft, otherwise the last `objective` event of this chamber.
 */
export function draftUpgrade(run: RunState): 'bonus' | 'vault' | null {
  const depth = Math.max(0, Math.floor(run.depth ?? 0));
  const live = run.objective && run.objective.status === 'done' ? { kind: run.objective.kind, bonus: run.objective.bonus } : null;
  const last = ui.lastObjective && ui.lastObjective.chamber === run.chamber && ui.lastObjective.depth === depth ? ui.lastObjective : null;
  const done = live ?? last;
  if (!done || run.tutorial) return null;
  if (done.kind === 'vault') return 'vault';
  return hasBonus(done.kind) && done.bonus ? 'bonus' : null;
}

/** Counts finished objectives for the run summary and remembers the last one for the draft (called for every event). */
export function trackObjectiveEvent(ev: ObjectiveEvent): void {
  if (ev.what !== 'done') return;
  const run = state.run;
  ui.lastObjective = { kind: ev.kind, bonus: ev.bonus === true, chamber: run?.chamber ?? -1, depth: Math.max(0, Math.floor(run?.depth ?? 0)) };
  if (ev.kind === 'slay') return;
  ui.objectives.done += 1;
  if (ev.bonus === true && hasBonus(ev.kind)) ui.objectives.bonus += 1;
}

/** Keeps the run tally honest: it starts with the run's first chamber and ends with the session. */
export function trackObjectiveRun(): void {
  const run = state.run;
  if (!run || run.phase === 'lobby') {
    ui.objectives = { done: 0, bonus: 0, tracked: false };
    ui.lastObjective = null;
    return;
  }
  const first = run.phase === 'combat' && run.chamber === 0 && (run.depth ?? 0) === 0 && (run.chambersCleared ?? 0) === 0;
  if (first && !ui.objectives.tracked) ui.objectives = { done: 0, bonus: 0, tracked: true };
}

/**
 * Objectives completed / bonuses earned in a run, or null when unknown. Prefers run-level counters from the
 * server (not part of the contract yet, see the UI report) over the client's own tally.
 */
export function objectiveTally(run: RunState): { done: number; bonus: number } | null {
  const extra = run as unknown as { objectivesDone?: unknown; objectiveBonuses?: unknown };
  if (typeof extra.objectivesDone === 'number' && typeof extra.objectiveBonuses === 'number') {
    return { done: Math.max(0, Math.floor(extra.objectivesDone)), bonus: Math.max(0, Math.floor(extra.objectiveBonuses)) };
  }
  return ui.objectives.tracked ? { done: ui.objectives.done, bonus: ui.objectives.bonus } : null;
}

const pct = (v: number): string => `${Math.round(Math.min(1, Math.max(0, v)) * PERCENT * 10) / 10}%`;
const clock = (seconds: number): string => formatTime(Math.ceil(Math.max(0, seconds)));

// ------------------------------------------------------------------ tracker

export interface ObjectiveView {
  el: HTMLElement;
  /** Called at HUD rate: shows / hides the panel and updates the live measure. */
  sync(): void;
  onEvent(ev: ObjectiveEvent): void;
  reset(): void;
}

export function createObjective(): ObjectiveView {
  const iconBox = h('span', { class: 'gg-obj-icon' });
  const name = h('b', { class: 'gg-obj-name' });
  const goal = h('span', { class: 'gg-obj-goal' });
  const clockLabel = h('span', { class: 'gg-obj-clock-label' });
  const clockText = h('b', { class: 'gg-num' });
  const clockEl = h('div', { class: 'gg-obj-clock' }, clockLabel, clockText);
  const measure = h('div', { class: 'gg-obj-measure' });
  const bonusText = h('span', { class: 'gg-obj-bonus-text' });
  const bonusTag = h('em', { class: 'gg-obj-bonus-tag' });
  const bonusIcon = h('span', { class: 'gg-obj-bonus-icon' }, icon('star'));
  const bonus = h('div', { class: 'gg-obj-bonus' }, bonusIcon, bonusText, bonusTag);
  const el = h('div', {
    class: 'gg-obj', 'data-testid': 'hud-objective', 'data-kind': 'slay', 'data-status': 'active', 'data-bonus': 'none', role: 'status',
  },
    h('div', { class: 'gg-obj-head' }, iconBox, h('div', { class: 'gg-obj-title' }, name, goal), clockEl),
    measure,
    bonus,
  );
  show(el, false);

  // Parts of the measure row; built per kind, updated in place.
  let builtKey = '';
  let bar: HTMLElement | null = null;
  let barLabel: HTMLElement | null = null;
  let barValue: HTMLElement | null = null;
  let note: HTMLElement | null = null;
  let tag: HTMLElement | null = null;
  let pips: HTMLElement | null = null;
  let chamberKey = '';
  let huntTotal = 0;
  /** run.elapsed when the ritual began (fallback for its bonus countdown, see `ritualLeft`). */
  let ritualStart: number | null = null;
  let lastBonus: BonusState | null = null;
  let lastStatus = '';

  const build = (kind: ObjectiveKind): void => {
    bar = barLabel = barValue = note = tag = pips = null;
    const fill = (): HTMLElement => { bar = h('i'); return h('div', { class: 'gg-obj-bar' }, bar); };
    const children: HTMLElement[] = [];
    if (kind === 'survive') {
      children.push(fill());
    } else if (kind === 'defend') {
      barLabel = h('span', { class: 'gg-obj-bar-label' }, icon('defend'), h('span', null, t('objective.defend.shard')));
      barValue = h('b', { class: 'gg-num' });
      note = h('span', { class: 'gg-obj-note gg-num' });
      children.push(h('div', { class: 'gg-obj-row' }, barLabel, fill(), barValue, note));
    } else if (kind === 'hunt') {
      pips = h('span', { class: 'gg-obj-pips', 'aria-hidden': 'true' });
      note = h('span', { class: 'gg-obj-note' });
      tag = h('em', { class: 'gg-obj-tag' }, icon('rage'), t('objective.hunt.enraged'));
      children.push(h('div', { class: 'gg-obj-row' }, pips, note, tag));
    } else if (kind === 'ritual') {
      pips = h('span', { class: 'gg-obj-braziers' });
      note = h('span', { class: 'gg-obj-note gg-num' });
      children.push(h('div', { class: 'gg-obj-row' }, pips, note));
    } else if (kind === 'vault') {
      note = h('span', { class: 'gg-obj-note' });
      children.push(h('div', { class: 'gg-obj-row' }, note, fill()));
    }
    measure.replaceChildren(...children);
    show(measure, children.length > 0);
    iconBox.replaceChildren(icon(OBJECTIVE_ICON[kind]));
    setText(name, objectiveName(kind));
    setText(goal, objectiveGoal(kind));
    setText(bonusText, objectiveBonus(kind));
  };

  /** Seconds left for the ritual's bonus: the server's timer when it sends one, else counted from the start event. */
  const ritualLeft = (o: ObjectiveState, run: RunState): number | null => {
    if (o.timeLeft > 0) return o.timeLeft;
    if (ritualStart === null) return null;
    return Math.max(0, OBJECTIVE_TUNING.RITUAL.BONUS_SECONDS - (run.elapsed - ritualStart));
  };

  const setClock = (seconds: number | null, label: string): void => {
    show(clockEl, seconds !== null);
    if (seconds === null) return;
    setText(clockLabel, label);
    setText(clockText, clock(seconds));
    toggle(clockEl, 'is-urgent', seconds <= UI_CONFIG.OBJECTIVE_URGENT_SECONDS);
  };

  const sync = (): void => {
    const run = state.run;
    const o = run?.objective ?? null;
    // Elite and boss chambers are always "slay" and have the boss bar: no panel there. Training has its coach.
    const visible = run !== null && o !== null && run.phase === 'combat' && !run.tutorial
      && !(o.kind === 'slay' && run.chamberKind !== 'combat');
    show(el, visible);
    if (!run || !o || !visible) return;
    const key = `${run.chamber}|${run.depth ?? 0}|${o.kind}`;
    if (key !== chamberKey) {
      chamberKey = key;
      huntTotal = 0;
      lastBonus = null;
      lastStatus = '';
    }
    if (o.kind !== builtKey) { builtKey = o.kind; build(o.kind); }
    const done = o.status === 'done';
    const state2 = bonusState(o);
    setAttr(el, 'data-kind', o.kind);
    setAttr(el, 'data-status', o.status);
    setAttr(el, 'data-bonus', state2);

    // ---- live measure
    let seconds: number | null = null;
    let label = '';
    if (o.kind === 'survive') {
      seconds = done ? null : o.timeLeft;
      if (bar) setVar(bar, '--w', pct(done ? 1 : o.progress));
    } else if (o.kind === 'defend') {
      const hp = Math.min(1, Math.max(0, o.anchor?.hp ?? (o.bonus ? 1 : 0)));
      const shattered = hp <= 0;
      if (bar) setVar(bar, '--w', pct(hp));
      if (barValue) setText(barValue, shattered ? t('objective.defend.shattered') : `${Math.ceil(hp * PERCENT)}%`);
      if (note) setText(note, run.waveCount > 0 ? t('hud.wave', { n: Math.max(1, run.wave), m: Math.max(1, run.waveCount) }) : '');
      toggle(el, 'is-shattered', shattered);
      toggle(el, 'is-low', !shattered && hp < UI_CONFIG.LOW_HEALTH_FRACTION);
    } else if (o.kind === 'hunt') {
      const left = o.targets.length;
      huntTotal = Math.max(huntTotal, left);
      const enraged = !done && !o.bonus && left > 0;
      // Before the marked elites have risen there is nobody to count, but the clock already runs.
      const slain = left === 0 && huntTotal > 0;
      seconds = done || slain || !o.bonus ? null : o.timeLeft;
      if (pips && pips.children.length !== huntTotal) pips.replaceChildren(...Array.from({ length: huntTotal }, () => h('i', null, icon('skull'))));
      if (pips) Array.from(pips.children).forEach((pip, i) => toggle(pip, 'is-dead', i >= left));
      if (note) setText(note, left === 0 ? (slain && !done ? t('objective.hunt.escort') : '') : left === 1 ? t('objective.hunt.one') : t('objective.hunt.many', { n: left }));
      if (tag) show(tag, enraged);
      toggle(el, 'is-enraged', enraged);
      show(measure, left > 0 || (slain && !done));
    } else if (o.kind === 'ritual') {
      const lit = o.sites.filter((site) => site.lit).length;
      const total = Math.max(o.sites.length, 1);
      if (pips && pips.children.length !== o.sites.length) {
        pips.replaceChildren(...o.sites.map(() => h('i', { class: 'gg-obj-brazier' }, icon('ritual'))));
      }
      if (pips) {
        Array.from(pips.children).forEach((pip, i) => {
          const site = o.sites[i];
          toggle(pip, 'is-lit', site.lit);
          toggle(pip, 'is-filling', !site.lit && site.progress > 0);
          setVar(pip as HTMLElement, '--p', pct(site.lit ? 1 : site.progress));
        });
      }
      if (note) setText(note, t('objective.ritual.lit', { n: lit, m: total }));
      seconds = done || !o.bonus ? null : ritualLeft(o, run);
      label = t('objective.ritual.bonusTime');
    } else if (o.kind === 'vault') {
      if (bar) setVar(bar, '--w', pct(done ? 1 : o.progress));
      if (note) setText(note, o.progress > 0 && !done ? t('objective.vault.opening') : t('objective.vault.hold'));
    }
    setClock(seconds, label);

    // ---- bonus line and the completed state
    show(bonus, state2 !== 'none');
    setText(bonusTag, state2 === 'lost' ? t('objective.bonus.lost') : state2 === 'earned' ? t('objective.bonus.earned') : t('objective.bonus'));
    toggle(el, 'is-done', done);
    if (lastBonus !== null && lastBonus !== state2 && (state2 === 'lost' || state2 === 'earned')) retrigger(bonus, 'is-flip');
    if (done && lastStatus === 'active') retrigger(el, 'is-complete');
    lastBonus = state2;
    lastStatus = o.status;
  };

  return {
    el,
    sync,
    onEvent: (ev) => {
      if (ev.what === 'start') ritualStart = ev.kind === 'ritual' ? state.run?.elapsed ?? null : null;
      if (ev.what === 'site' && pips && typeof ev.index === 'number') {
        const pip = pips.children[ev.index];
        if (pip instanceof HTMLElement) retrigger(pip, 'is-new');
      }
      if (ev.what === 'anchorHit') retrigger(el, 'is-hit');
      sync();
    },
    reset: () => { chamberKey = ''; huntTotal = 0; ritualStart = null; lastBonus = null; lastStatus = ''; show(el, false); },
  };
}

// ------------------------------------------------------------------ intro / completion banner

export interface ObjectiveBannerView {
  /** Empty slot in the HUD; the banner element is attached only while it shows. */
  slot: HTMLElement;
  /** Introduces the objective of the chamber that just began (never for `slay`). */
  intro(kind: ObjectiveKind, delayMs?: number): void;
  /** Objective complete; `earned` tells whether the bonus was met. Nothing for `slay`. */
  done(kind: ObjectiveKind, earned: boolean): void;
  /** The bonus condition failed. */
  lost(kind: ObjectiveKind): void;
  /** True while the banner is on screen. */
  showing(): boolean;
  hide(): void;
}

export function createObjectiveBanner(): ObjectiveBannerView {
  const slot = h('div', { class: 'gg-obj-banner-slot' });
  const label = h('span', { class: 'gg-obj-banner-label' });
  const iconBox = h('span', { class: 'gg-obj-banner-icon' });
  const title = h('div', { class: 'gg-obj-banner-title' });
  const sub = h('div', { class: 'gg-obj-banner-sub' });
  const extra = h('div', { class: 'gg-obj-banner-bonus' });
  const el = h('div', { class: 'gg-obj-banner', 'data-testid': 'objective-banner', role: 'status' },
    h('div', { class: 'gg-obj-banner-head' }, iconBox, label), title, sub, extra);
  let timer = 0;
  let delay = 0;

  const hide = (): void => {
    window.clearTimeout(timer);
    window.clearTimeout(delay);
    el.remove();
  };

  const present = (kind: ObjectiveKind, phase: 'start' | 'done' | 'lost', bonus: BonusState, texts: { label: string; title: string; sub: string; extra: string }, ms: number): void => {
    hide();
    el.dataset.kind = kind;
    el.dataset.phase = phase;
    el.dataset.bonus = bonus;
    iconBox.replaceChildren(icon(phase === 'done' ? 'check' : phase === 'lost' ? 'warning' : OBJECTIVE_ICON[kind]));
    setText(label, texts.label);
    setText(title, texts.title);
    setText(sub, texts.sub);
    extra.replaceChildren(...(texts.extra !== '' ? [icon('star'), h('span', null, texts.extra)] : []));
    show(extra, texts.extra !== '');
    setVar(el, '--banner-ms', `${ms}ms`);
    slot.append(el);
    retrigger(el, 'is-on');
    timer = window.setTimeout(() => el.remove(), ms);
  };

  return {
    slot,
    intro: (kind, delayMs = 0) => {
      if (kind === 'slay') return;
      const go = (): void => present(kind, 'start', hasBonus(kind) ? 'open' : 'none', {
        label: t('objective.label'), title: objectiveName(kind), sub: objectiveGoal(kind),
        extra: hasBonus(kind) ? `${t('objective.bonus')}: ${objectiveBonus(kind)}` : '',
      }, UI_CONFIG.OBJECTIVE_BANNER_MS);
      window.clearTimeout(delay);
      if (delayMs > 0) delay = window.setTimeout(go, delayMs);
      else go();
    },
    done: (kind, earned) => {
      if (kind === 'slay') return;
      if (kind === 'vault') {
        present(kind, 'done', 'none', {
          label: objectiveName(kind), title: t('objective.done.vault'),
          sub: t('objective.done.vaultSub', { hp: Math.round(OBJECTIVE_TUNING.VAULT.HEAL_FRACTION * PERCENT) }), extra: '',
        }, UI_CONFIG.OBJECTIVE_DONE_MS);
        return;
      }
      const won = earned && hasBonus(kind);
      present(kind, 'done', won ? 'earned' : 'lost', {
        label: objectiveName(kind), title: won ? t('objective.bonus.earned') : t('objective.done'),
        sub: won ? objectiveBonus(kind) : t('objective.done.noBonus'), extra: won ? t('objective.bonus.reward') : '',
      }, UI_CONFIG.OBJECTIVE_DONE_MS);
    },
    lost: (kind) => {
      if (!hasBonus(kind)) return;
      const key = `objective.lost.${kind}`;
      present(kind, 'lost', 'lost', {
        label: objectiveName(kind), title: t('objective.bonus.lost'), sub: tx(key, undefined, objectiveBonus(kind)), extra: '',
      }, UI_CONFIG.OBJECTIVE_BANNER_MS);
    },
    showing: () => el.isConnected,
    hide,
  };
}
