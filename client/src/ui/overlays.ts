/**
 * Modal layer: pause / settings, how to play, leave confirmation, connecting, fatal error dialog.
 * Exactly one modal is visible at a time; the host element only exists in the DOM while one is open.
 */
import { bus } from '../core/EventBus.ts';
import type { ConnError } from '../core/EventBus.ts';
import { state } from '../core/GameState.ts';
import { settings, updateSettings, type Quality } from '../core/Settings.ts';
import { h, icon, key, setText, setVar } from './dom.ts';
import { LANG_LABEL, LANGS, t, type I18nKey } from './i18n.ts';
import { resetTips, setTipsEnabled, tipsEnabled } from './prefs.ts';
import { ui, UI_CONFIG } from './store.ts';
import type { View } from './view.ts';
import type { IconName } from './icons.ts';

const PERCENT = 100;
const ZOOM_MIN = 0.8;
const ZOOM_MAX = 1.3;
const ZOOM_STEP = 0.05;
const QUALITIES: readonly Quality[] = ['low', 'medium', 'high'];
const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), [tabindex="0"]';

type SettingsSync = () => void;

function slider(label: string, min: number, max: number, step: number, read: () => number, write: (v: number) => void,
  format: (v: number) => string): { row: HTMLElement; sync: SettingsSync } {
  const value = h('span', { class: 'gg-set-value gg-num' });
  const input = h('input', { class: 'gg-slider', type: 'range', min, max, step, 'aria-label': label });
  const sync = (): void => {
    const v = read();
    if (document.activeElement !== input || Number(input.value) !== v) input.value = String(v);
    setVar(input, '--val', `${((v - min) / (max - min)) * PERCENT}%`);
    setText(value, format(v));
  };
  input.addEventListener('input', () => { write(Number(input.value)); sync(); });
  return { row: h('label', { class: 'gg-set-row' }, h('span', { class: 'gg-set-label' }, label), input, value), sync };
}

function segmented<T extends string>(label: string, options: readonly T[], text: (v: T) => string, read: () => T,
  write: (v: T) => void): { row: HTMLElement; sync: SettingsSync } {
  const buttons = options.map((option) => {
    const btn = h('button', { type: 'button', onClick: () => write(option) }, text(option));
    return { option, btn };
  });
  const sync = (): void => {
    for (const { option, btn } of buttons) btn.setAttribute('aria-pressed', String(read() === option));
  };
  const group = h('div', { class: 'gg-seg', role: 'group', 'aria-label': label }, ...buttons.map((b) => b.btn));
  return { row: h('div', { class: 'gg-set-row gg-set-row--inline' }, h('span', { class: 'gg-set-label' }, label), group), sync };
}

function controlsReference(): HTMLElement {
  const row = (keys: HTMLElement[], label: string): HTMLElement =>
    h('li', null, h('span', { class: 'gg-controls-keys' }, ...keys), h('span', null, label));
  return h('ul', { class: 'gg-controls' },
    row([key('W'), key('A'), key('S'), key('D')], t('controls.move')),
    row([icon('mouse', 'gg-controls-mouse')], t('controls.aim')),
    row([icon('mouseLeft', 'gg-controls-mouse')], t('controls.primary')),
    row([icon('mouseRight', 'gg-controls-mouse')], t('controls.secondary')),
    row([key(t('hud.key.dash'))], t('controls.dash')),
    row([key('3 s')], t('controls.revive')),
    row([key('Tab')], t('controls.scoreboard')),
    row([key('1'), key('–'), key('4')], t('controls.pick')),
    row([key('R')], t('controls.reroll')),
    row([key('Enter')], t('controls.tip')),
    row([key('Esc')], t('controls.menu')),
  );
}

function settingsBody(): { el: HTMLElement; sync: SettingsSync } {
  const volume = (labelKey: I18nKey, field: 'master' | 'music' | 'sfx') =>
    slider(t(labelKey), 0, PERCENT, 1, () => Math.round(settings[field] * PERCENT),
      (v) => updateSettings({ [field]: v / PERCENT }), (v) => `${v}%`);
  const master = volume('settings.master', 'master');
  const music = volume('settings.music', 'music');
  const sfx = volume('settings.sfx', 'sfx');
  const quality = segmented(t('settings.quality'), QUALITIES, (q) => t(`settings.quality.${q}`),
    () => settings.quality, (q) => updateSettings({ quality: q }));
  const shake = slider(t('settings.shake'), 0, PERCENT, 5, () => Math.round(settings.shake * PERCENT),
    (v) => updateSettings({ shake: v / PERCENT }), (v) => `${v}%`);
  const zoom = slider(t('settings.zoom'), ZOOM_MIN * PERCENT, ZOOM_MAX * PERCENT, ZOOM_STEP * PERCENT,
    () => Math.round(settings.zoom * PERCENT), (v) => updateSettings({ zoom: v / PERCENT }), (v) => `×${(v / PERCENT).toFixed(2)}`);
  const numbers = h('button', {
    class: 'gg-switch', type: 'button', role: 'switch', 'aria-label': t('settings.damageNumbers'),
    onClick: () => updateSettings({ damageNumbers: !settings.damageNumbers }),
  });
  const lang = segmented(t('settings.language'), LANGS, (l) => LANG_LABEL[l], () => settings.lang, (l) => updateSettings({ lang: l }));
  // Tips are a UI-only preference (ui/prefs.ts), not part of the Settings contract.
  const tips = h('button', {
    class: 'gg-switch', type: 'button', role: 'switch', 'aria-label': t('settings.tips'), 'data-testid': 'settings-tips', 'data-sfx': 'toggle',
    onClick: () => { setTipsEnabled(!tipsEnabled()); sync(); },
  });
  const resetLabel = h('span', null, t('settings.tipsReset'));
  const reset = h('button', {
    class: 'gg-btn gg-cut gg-btn--ghost gg-btn--small', type: 'button', 'data-testid': 'settings-tips-reset', 'data-sfx': 'confirm',
    onClick: () => {
      resetTips();
      resetLabel.textContent = t('settings.tipsResetDone');
      reset.classList.add('is-done');
      window.setTimeout(() => { resetLabel.textContent = t('settings.tipsReset'); reset.classList.remove('is-done'); }, UI_CONFIG.COPY_FEEDBACK_MS);
    },
  }, icon('tip'), resetLabel);

  const el = h('div', { class: 'gg-settings' },
    h('div', { class: 'gg-settings-col' },
      h('h3', { class: 'gg-label' }, t('settings.audio')),
      master.row, music.row, sfx.row,
      h('h3', { class: 'gg-label' }, t('settings.video')),
      quality.row, shake.row, zoom.row,
      h('div', { class: 'gg-set-row gg-set-row--inline' }, h('span', { class: 'gg-set-label' }, t('settings.damageNumbers')), numbers),
      lang.row,
      h('div', { class: 'gg-set-row gg-set-row--inline gg-set-row--tips' },
        h('span', { class: 'gg-set-label' }, t('settings.tips')), h('span', { class: 'gg-set-tips' }, tips, reset)),
    ),
    h('div', { class: 'gg-settings-col' }, h('h3', { class: 'gg-label' }, t('settings.controls')), controlsReference()),
  );
  function sync(): void {
    for (const part of [master, music, sfx, quality, shake, zoom, lang]) part.sync();
    numbers.setAttribute('aria-checked', String(settings.damageNumbers));
    tips.setAttribute('aria-checked', String(tipsEnabled()));
  }
  sync();
  return { el, sync };
}

function howToBody(): HTMLElement {
  const lines: [IconName[], I18nKey][] = [
    [['move'], 'howto.1'],
    [['sword'], 'howto.2'],
    [['ember', 'rime', 'storm'], 'howto.3'],
    [['resonance'], 'howto.4'],
    [['revive', 'door'], 'howto.5'],
  ];
  const list = h('ol', { class: 'gg-howto' });
  lines.forEach(([icons, textKey], i) => {
    list.append(h('li', { class: `gg-howto-${i + 1}` },
      h('span', { class: 'gg-howto-icons' }, ...icons.map((name) => icon(name, `gg-el-${name}`))),
      h('p', null, t(textKey)),
    ));
  });
  return list;
}

export interface OverlayView extends View {
  /** Esc pressed: closes the top-most modal. Returns false when nothing was open. */
  back(): boolean;
  isOpen(): boolean;
}

export interface OverlayActions {
  closeModal(): void;
  setPause(open: boolean): void;
  openCodex(): void;
}

export function createOverlays(actions: OverlayActions): OverlayView {
  const el = h('div', { class: 'gg-modal-host' });
  let currentKey = '';
  let settingsSync: SettingsSync | null = null;

  const frame = (title: string, iconName: IconName, wide: boolean, body: HTMLElement, buttons: (HTMLElement | null)[],
    attrs: Record<string, string> = {}): HTMLElement =>
    h('div', { class: `gg-modal gg-cut${wide ? ' gg-modal--wide' : ''}`, role: 'dialog', 'aria-modal': 'true', tabindex: -1, ...attrs },
      h('h2', { class: 'gg-modal-title' }, icon(iconName), title),
      h('div', { class: 'gg-modal-body' }, body),
      h('div', { class: 'gg-modal-actions' }, ...buttons),
    );

  const leave = (): void => {
    ui.modal = null;
    ui.pauseConfirm = false;
    if (ui.pause) actions.setPause(false);
    bus.emit('ui:leave');
  };

  const kind = (): string => {
    if (ui.fatal) return `fatal:${ui.fatal}`;
    if (state.screen === 'menu' && state.conn.status === 'connecting') return 'connecting';
    if (state.screen === 'game' && ui.pause) return ui.pauseConfirm ? 'pause-confirm' : 'pause';
    if (ui.modal) return ui.modal;
    return '';
  };

  const build = (k: string): HTMLElement | null => {
    settingsSync = null;
    if (k.startsWith('fatal:')) {
      const error = ui.fatal as ConnError;
      const dismiss = (): void => { ui.fatal = null; sync(); };
      return frame(t('error.title'), 'warning', false,
        h('p', { class: 'gg-modal-text' }, t(`error.${error}`)),
        [
          error === 'bad_version'
            ? h('button', { class: 'gg-btn gg-cut', type: 'button', onClick: () => window.location.reload() }, t('error.reload'))
            : null,
          h('button', { class: 'gg-btn gg-cut gg-btn--primary', type: 'button', onClick: dismiss }, t('common.ok')),
        ],
        { 'data-testid': 'error-dialog', 'data-error': error, class: 'gg-modal gg-cut gg-modal--error' });
    }
    if (k === 'connecting') {
      return frame(t('menu.connecting'), 'bell', false,
        h('div', { class: 'gg-connecting' }, h('span', { class: 'gg-spinner' }), h('p', null, t('menu.connectingHint'))),
        [h('button', { class: 'gg-btn gg-cut gg-btn--ghost', type: 'button', onClick: () => bus.emit('ui:leave') }, t('common.cancel'))]);
    }
    if (k === 'pause' || k === 'settings') {
      const body = settingsBody();
      settingsSync = body.sync;
      const paused = k === 'pause';
      const wrapper = h('div', null, paused ? h('p', { class: 'gg-pause-hint' }, t('settings.pausedHint')) : null, body.el);
      return frame(paused ? t('settings.paused') : t('settings.title'), 'gear', true, wrapper, paused
        ? [
          h('button', {
            class: 'gg-btn gg-cut gg-btn--danger', type: 'button', 'data-testid': 'pause-leave',
            onClick: () => { ui.pauseConfirm = true; sync(); },
          }, icon('exit'), t('settings.leave')),
          h('span', { class: 'gg-modal-spacer' }),
          h('button', {
            class: 'gg-btn gg-cut', type: 'button', 'data-testid': 'pause-codex', 'data-sfx': 'click', onClick: actions.openCodex,
          }, icon('codex'), t('menu.codex')),
          h('button', { class: 'gg-btn gg-cut gg-btn--primary', type: 'button', onClick: () => actions.setPause(false) },
            t('settings.resume')),
        ]
        : [h('button', { class: 'gg-btn gg-cut gg-btn--primary', type: 'button', onClick: actions.closeModal }, t('common.close'))]);
    }
    if (k === 'pause-confirm') {
      return frame(t('settings.leaveTitle'), 'exit', false, h('p', { class: 'gg-modal-text' }, t('settings.leaveBody')), [
        h('button', { class: 'gg-btn gg-cut gg-btn--ghost', type: 'button', onClick: () => { ui.pauseConfirm = false; sync(); } },
          t('common.back')),
        h('button', { class: 'gg-btn gg-cut gg-btn--danger', type: 'button', 'data-testid': 'pause-leave-confirm', onClick: leave },
          icon('exit'), t('settings.leaveConfirm')),
      ]);
    }
    if (k === 'leave') {
      return frame(t('lobby.leaveTitle'), 'exit', false, h('p', { class: 'gg-modal-text' }, t('lobby.leaveBody')), [
        h('button', { class: 'gg-btn gg-cut gg-btn--ghost', type: 'button', onClick: actions.closeModal }, t('common.cancel')),
        h('button', { class: 'gg-btn gg-cut gg-btn--danger', type: 'button', 'data-testid': 'leave-confirm', onClick: leave }, icon('exit'), t('common.leave')),
      ]);
    }
    if (k === 'howto') {
      return frame(t('howto.title'), 'help', true, howToBody(),
        [h('button', { class: 'gg-btn gg-cut gg-btn--primary', type: 'button', onClick: actions.closeModal }, t('common.close'))]);
    }
    return null;
  };

  // Keep keyboard focus inside the open dialog.
  el.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Tab') return;
    const focusable = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (ev.shiftKey && (active === first || !el.contains(active))) { ev.preventDefault(); last.focus(); }
    else if (!ev.shiftKey && (active === last || !el.contains(active))) { ev.preventDefault(); first.focus(); }
  });
  // A click on the dimmed backdrop closes dismissible modals.
  el.addEventListener('pointerdown', (ev) => { if (ev.target === el) back(); });

  function sync(): void {
    const k = kind();
    if (k !== currentKey) {
      currentKey = k;
      const modal = build(k);
      el.replaceChildren();
      if (modal) { el.append(modal); el.dataset.kind = k.split(':')[0]; }
    } else {
      settingsSync?.();
    }
  }

  function back(): boolean {
    const k = kind();
    if (k === '') return false;
    if (k.startsWith('fatal:')) ui.fatal = null;
    else if (k === 'connecting') bus.emit('ui:leave');
    else if (k === 'pause-confirm') ui.pauseConfirm = false;
    else if (k === 'pause') { actions.setPause(false); return true; }
    else { actions.closeModal(); return true; }
    sync();
    return true;
  }

  return { el, sync, back, isOpen: () => kind() !== '' };
}

// ------------------------------------------------------------------ toasts

export interface ToastView extends View {
  push(text: string, tone?: 'error' | 'info'): void;
}

export function createToasts(): ToastView {
  const el = h('div', { class: 'gg-toasts', 'aria-live': 'assertive' });
  const push = (text: string, tone: 'error' | 'info' = 'error'): void => {
    const toast = h('div', { class: `gg-toast gg-toast--${tone}`, role: tone === 'error' ? 'alert' : 'status' },
      icon(tone === 'error' ? 'warning' : 'check'), h('span', null, text));
    el.append(toast);
    window.setTimeout(() => {
      toast.classList.add('is-leaving');
      window.setTimeout(() => toast.remove(), 200);
    }, UI_CONFIG.TOAST_MS);
  };
  return { el, sync: () => undefined, push };
}
