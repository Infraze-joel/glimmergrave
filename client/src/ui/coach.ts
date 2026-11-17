/**
 * Training coach panel (top centre of the HUD while `run.tutorial` is set): step n / total, a short title,
 * one or two sentences with inline key caps and element-coloured keywords, the step's progress and a brief
 * "well done" confirmation whenever the next step begins.
 */
import { TUTORIAL_STEPS } from '@shared/data/tutorial.ts';
import type { ElementId } from '@shared/types.ts';
import { state } from '../core/GameState.ts';
import { h, icon, setAttr, setText, setVar, show } from './dom.ts';
import { statusParams } from './elements.ts';
import { hasKey, t, type Params } from './i18n.ts';
import { rich } from './rich.ts';
import { UI_CONFIG } from './store.ts';
import type { View } from './view.ts';

const PERCENT = 100;
/** Steps whose text quotes the numbers of one status. */
const STEP_ELEMENT: Record<string, ElementId> = { burn: 'ember', resonance: 'rime', storm: 'storm' };

export interface CoachView extends View {
  /** A 'tutorialStep' event announced `step`: confirm the finished one, then show the new text. */
  celebrate(step: string): void;
}

export interface StepText {
  title: string;
  body: string;
}

/** Title + body (with markup) of a training step. Unknown ids fall back to the id so nothing breaks. */
export function stepText(id: string): StepText {
  const titleKey = `tutorial.${id}.title`;
  const bodyKey = `tutorial.${id}.body`;
  const params: Params | undefined = STEP_ELEMENT[id] ? statusParams(STEP_ELEMENT[id]) : undefined;
  return {
    title: hasKey(titleKey) ? t(titleKey) : id,
    body: hasKey(bodyKey) ? t(bodyKey, params) : '',
  };
}

export function createCoach(): CoachView {
  const stepLabel = h('span', { class: 'gg-coach-step gg-num' });
  const dots = h('span', { class: 'gg-coach-dots', 'aria-hidden': 'true' });
  const title = h('h3', { class: 'gg-coach-title' });
  const body = h('p', { class: 'gg-coach-body' });
  const fill = h('i');
  const bar = h('div', { class: 'gg-coach-bar' }, fill);
  const done = h('div', { class: 'gg-coach-done', role: 'status' }, icon('check'), h('span', null, t('tutorial.done')));
  const el = h('section', { class: 'gg-coach', 'data-testid': 'tutorial-panel', 'data-step': '', 'aria-live': 'polite' },
    h('header', { class: 'gg-coach-head' },
      h('span', { class: 'gg-coach-label' }, icon('training'), t('tutorial.label')),
      dots,
      stepLabel,
    ),
    h('div', { class: 'gg-coach-main' }, title, body, bar),
    done,
  );

  let shown = '';
  let celebrated = '';
  let timer = 0;
  let dotCount = -1;

  const render = (): void => {
    const tut = state.run?.tutorial;
    if (!tut) return;
    if (shown !== tut.step) {
      shown = tut.step;
      const text = stepText(tut.step);
      setAttr(el, 'data-step', tut.step);
      setText(title, text.title);
      body.replaceChildren(...rich(text.body));
      el.classList.remove('is-in');
      void el.offsetWidth;
      el.classList.add('is-in');
    }
    const total = Math.max(1, tut.total || TUTORIAL_STEPS.length);
    const index = Math.min(total - 1, Math.max(0, tut.index));
    setText(stepLabel, t('tutorial.step', { n: index + 1, m: total }));
    if (dotCount !== total) {
      dotCount = total;
      dots.replaceChildren(...Array.from({ length: total }, () => h('i')));
    }
    Array.from(dots.children).forEach((dot, i) => {
      dot.className = i < index ? 'is-done' : i === index ? 'is-current' : '';
    });
    const progress = Math.min(1, Math.max(0, tut.progress));
    show(bar, progress > 0);
    setVar(fill, '--w', `${Math.round(progress * PERCENT)}%`);
  };

  const celebrate = (step: string): void => {
    if (step === celebrated || step === shown || shown === '') { celebrated = step; return; }
    celebrated = step;
    el.classList.remove('is-done');
    void el.offsetWidth;
    el.classList.add('is-done');
    window.clearTimeout(timer);
    timer = window.setTimeout(() => { timer = 0; el.classList.remove('is-done'); render(); }, UI_CONFIG.TUTORIAL_DONE_MS);
  };

  const sync = (): void => {
    const tut = state.run?.tutorial;
    if (!tut) { shown = ''; celebrated = ''; return; }
    if (shown !== '' && tut.step !== shown) celebrate(tut.step);
    if (timer === 0) render();
  };

  return { el, sync, celebrate, dispose: () => window.clearTimeout(timer) };
}
