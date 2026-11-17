/** Loading screen: title, asset progress, rotating flavour line, error state with retry. */
import { h, icon, setText, setVar, show } from './dom.ts';
import { t, type I18nKey } from './i18n.ts';
import { ui, UI_CONFIG } from './store.ts';
import type { View } from './view.ts';

const PERCENT = 100;

export function createLoading(): View {
  const fill = h('div', { class: 'gg-load-fill' });
  const percent = h('span', { class: 'gg-load-percent gg-num' });
  const flavour = h('p', { class: 'gg-load-flavour' });
  const progress = h('div', { class: 'gg-load-progress' },
    h('div', { class: 'gg-load-row' }, h('span', { class: 'gg-load-label' }, t('loading.title')), percent),
    h('div', { class: 'gg-load-bar', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': PERCENT }, fill),
    flavour,
  );
  const errorDetail = h('p', { class: 'gg-load-error-detail' });
  const error = h('div', { class: 'gg-load-error', role: 'alert' },
    h('div', { class: 'gg-load-error-title' }, icon('warning'), t('loading.errorTitle')),
    h('p', null, t('loading.errorBody')),
    errorDetail,
    h('button', { class: 'gg-btn gg-cut gg-btn--primary', type: 'button', onClick: () => window.location.reload() },
      t('common.retry')),
  );
  const el = h('section', { class: 'gg-screen gg-loading gg-backdrop', 'data-testid': 'loading-root' },
    h('div', { class: 'gg-load-box' },
      h('div', { class: 'gg-logo-emblem' }, icon('emblem')),
      h('h1', { class: 'gg-logo-title' }, t('common.title')),
      h('p', { class: 'gg-logo-tag' }, t('common.tagline')),
      progress,
      error,
    ),
  );

  let flavourIndex = Math.floor(Math.random() * UI_CONFIG.FLAVOUR_COUNT);
  const rotate = (): void => {
    flavourIndex = (flavourIndex + 1) % UI_CONFIG.FLAVOUR_COUNT;
    flavour.textContent = t(`loading.flavour.${flavourIndex}` as I18nKey);
  };
  rotate();
  const timer = window.setInterval(() => { if (!el.hidden) rotate(); }, UI_CONFIG.FLAVOUR_ROTATE_MS);

  const sync = (): void => {
    const failed = ui.assetError !== null;
    show(progress, !failed);
    show(error, failed);
    if (failed) { setText(errorDetail, ui.assetError ?? ''); return; }
    const pct = Math.round(Math.min(1, Math.max(0, ui.assetProgress)) * PERCENT);
    setVar(fill, '--p', `${pct}%`);
    setText(percent, t('loading.percent', { n: pct }));
    fill.parentElement?.setAttribute('aria-valuenow', String(pct));
  };

  return { el, sync, dispose: () => window.clearInterval(timer) };
}
