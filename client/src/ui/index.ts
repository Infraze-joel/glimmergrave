/**
 * UI entry point. `initUI(root)` mounts every screen / overlay into #ui-root and wires it to the bus.
 * The UI only READS GameState, LISTENS to bus events and EMITS `ui:*` intents.
 *
 * Views are attached to the DOM only while they are active, so `data-testid` selectors are present exactly
 * when the corresponding screen / element is visible.
 */
import '@fontsource/cinzel/latin-600.css';
import '@fontsource/cinzel/latin-700.css';
import '@fontsource/cinzel/latin-900.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/screens.css';
import './styles/hud.css';
import './styles/overlays.css';

import { bus } from '../core/EventBus.ts';
import { state } from '../core/GameState.ts';
import { settings } from '../core/Settings.ts';
import { blurActive } from './dom.ts';
import { createDraft, type DraftView } from './draft.ts';
import { createHud, type HudView } from './hud.ts';
import { getLang, setLang, t } from './i18n.ts';
import { createLoading } from './loading.ts';
import { createLobby, type LobbyView } from './lobby.ts';
import { createMenu, readJoinParam, type MenuView } from './menu.ts';
import { createOverlays, createToasts, type OverlayView, type ToastView } from './overlays.ts';
import { createScoreboard } from './scoreboard.ts';
import { ui, type ModalKind } from './store.ts';
import { createSummary, type SummaryView } from './summary.ts';
import type { View } from './view.ts';

interface Views {
  loading: View;
  menu: MenuView;
  lobby: LobbyView;
  summary: SummaryView;
  hud: HudView;
  draft: DraftView;
  tab: View;
  overlays: OverlayView;
  toasts: ToastView;
}

const DIGIT_CODES = ['Digit1', 'Digit2', 'Digit3', 'Digit4'];
const NUMPAD_CODES = ['Numpad1', 'Numpad2', 'Numpad3', 'Numpad4'];
const INTERACTIVE_TAGS = new Set(['BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'A']);

let rootEl: HTMLElement | null = null;
let views: Views | null = null;

function mount(view: View, on: boolean): boolean {
  if (!rootEl) return false;
  if (on && !view.el.isConnected) { rootEl.append(view.el); return true; }
  if (!on && view.el.isConnected) view.el.remove();
  return false;
}

function openModal(kind: ModalKind): void {
  ui.modal = kind;
  refresh();
}

function closeModal(): void {
  ui.modal = null;
  blurActive();
  refresh();
}

function setPause(open: boolean): void {
  if (ui.pause === open) return;
  ui.pause = open;
  ui.pauseConfirm = false;
  if (open) ui.tab = false;
  else blurActive();
  bus.emit('ui:overlay', { open });
  refresh();
}

/** Full sync of everything that is (or should be) on screen. Cheap: called on low-frequency events only. */
function refresh(): void {
  if (!views) return;
  const screen = state.screen;
  const v = views;
  mount(v.loading, screen === 'loading');
  mount(v.menu, screen === 'menu');
  mount(v.lobby, screen === 'lobby');
  mount(v.summary, screen === 'summary');
  mount(v.hud, screen === 'game');
  mount(v.draft, v.draft.active());
  v.overlays.sync();
  mount(v.overlays, v.overlays.isOpen());
  mount(v.tab, screen === 'game' && ui.tab && !v.overlays.isOpen());
  for (const view of [v.loading, v.menu, v.lobby, v.summary, v.hud, v.draft, v.tab]) {
    if (view.el.isConnected) view.sync();
  }
}

function build(): void {
  if (!rootEl) return;
  if (views) for (const view of Object.values(views) as View[]) view.dispose?.();
  rootEl.replaceChildren();
  rootEl.classList.add('gg-ui');
  document.documentElement.lang = getLang();
  document.title = t('common.title');
  views = {
    loading: createLoading(),
    menu: createMenu(openModal),
    lobby: createLobby(openModal),
    summary: createSummary(openModal),
    hud: createHud(),
    draft: createDraft(),
    tab: createScoreboard(),
    overlays: createOverlays({ closeModal, setPause }),
    toasts: createToasts(),
  };
  rootEl.append(views.toasts.el);
  refresh();
}

function handleEscape(): void {
  if (!views) return;
  if (views.overlays.back()) { refresh(); return; }
  if (state.screen === 'game') setPause(true);
  else if (state.screen === 'lobby' || state.screen === 'summary') openModal('leave');
}

function onKeyDown(ev: KeyboardEvent): void {
  if (!views || ev.ctrlKey || ev.metaKey || ev.altKey) return;
  const overlayOpen = views.overlays.isOpen();
  if (ev.key === 'Escape') {
    ev.preventDefault();
    if (!ev.repeat) handleEscape();
    return;
  }
  if (ev.key === 'Tab') {
    if (state.screen !== 'game' || overlayOpen) return; // menus keep normal focus navigation
    ev.preventDefault();
    if (!ui.tab) { ui.tab = true; refresh(); }
    return;
  }
  if (overlayOpen || ev.repeat) return;
  const digit = Math.max(DIGIT_CODES.indexOf(ev.code), NUMPAD_CODES.indexOf(ev.code));
  if (digit >= 0 && views.draft.active()) { views.draft.pick(digit); return; }
  if (ev.key === 'Enter') {
    const target = ev.target;
    if (target instanceof HTMLElement && INTERACTIVE_TAGS.has(target.tagName)) return;
    if (state.screen === 'menu') views.menu.primaryAction();
    else if (state.screen === 'lobby') views.lobby.primaryAction();
  }
}

function onKeyUp(ev: KeyboardEvent): void {
  if (ev.key === 'Tab' && ui.tab) { ui.tab = false; refresh(); }
}

function trackOathBaseline(): void {
  const phase = state.run?.phase;
  if (phase === 'combat' || phase === 'draft' || phase === 'doors') ui.oathBaseline = state.profile.oathUnlocked;
  else if (!phase || phase === 'lobby') ui.oathBaseline = null;
}

export function initUI(root: HTMLElement): void {
  if (rootEl) return;
  rootEl = root;
  readJoinParam();
  setLang(settings.lang);
  document.body.dataset.screen = state.screen;
  build();

  // ---- assets
  bus.on('assets:progress', ({ loaded, total }) => {
    ui.assetProgress = total > 0 ? loaded / total : 0;
    views?.loading.sync();
  });
  bus.on('assets:ready', () => { ui.assetProgress = 1; views?.loading.sync(); });
  bus.on('assets:error', ({ message }) => { ui.assetError = message; views?.loading.sync(); });

  // ---- state
  bus.on('state:screen', () => {
    document.body.dataset.screen = state.screen;
    if (state.screen !== 'game') {
      ui.tab = false;
      if (ui.pause) { ui.pause = false; ui.pauseConfirm = false; bus.emit('ui:overlay', { open: false }); }
    }
    ui.modal = null;
    blurActive();
    refresh();
  });
  bus.on('net:status', refresh);
  bus.on('state:roster', refresh);
  bus.on('state:run', () => { trackOathBaseline(); refresh(); });
  bus.on('state:draft', refresh);
  bus.on('state:hud', () => { if (views?.hud.el.isConnected) views.hud.syncHud(); });
  bus.on('net:error', ({ error, fatal }) => {
    if (fatal) ui.fatal = error;
    else views?.toasts.push(t(`error.${error}`));
    refresh();
  });

  // ---- gameplay feedback
  bus.on('game:event', (ev) => { if (views?.hud.el.isConnected) views.hud.onEvent(ev); });
  bus.on('game:localAction', ({ action }) => { if (views?.hud.el.isConnected) views.hud.onLocalAction(action); });

  // ---- settings (language switches rebuild the whole UI in place)
  bus.on('settings:changed', (next) => {
    if (next.lang !== getLang()) { setLang(next.lang); build(); }
    else views?.overlays.sync();
  });

  // ---- keyboard owned by the UI: Esc, Tab (hold), 1-4, Enter. Gameplay keys are never touched.
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', () => { if (ui.tab) { ui.tab = false; refresh(); } });

  // ---- first gesture unlocks audio
  const gesture = (): void => {
    window.removeEventListener('pointerdown', gesture, true);
    window.removeEventListener('keydown', gesture, true);
    bus.emit('ui:gesture');
  };
  window.addEventListener('pointerdown', gesture, true);
  window.addEventListener('keydown', gesture, true);
}
