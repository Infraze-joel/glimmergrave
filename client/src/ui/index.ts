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
import './styles/update2.css';
import './styles/pages.css';
import './styles/update3.css';
import './styles/update4.css';
import './styles/polish1.css';

import { REACTIONS } from '@shared/data/reactions.ts';
import { bus } from '../core/EventBus.ts';
import { state } from '../core/GameState.ts';
import { settings } from '../core/Settings.ts';
import { createCodex } from './codex.ts';
import { blurActive } from './dom.ts';
import { createDraft, type DraftView } from './draft.ts';
import { createHub } from './hub.ts';
import { createHud, type HudView } from './hud.ts';
import { getLang, setLang, t } from './i18n.ts';
import { createLoading } from './loading.ts';
import { createLobby, type LobbyView } from './lobby.ts';
import { createMenu, readJoinParam, type MenuView } from './menu.ts';
import { trackObjectiveEvent, trackObjectiveRun } from './objective.ts';
import { createOverlays, createToasts, type OverlayView, type ToastView } from './overlays.ts';
import { createScoreboard } from './scoreboard.ts';
import { ui, type ModalKind, type PageKind } from './store.ts';
import { createSummary, type SummaryView } from './summary.ts';
import { reactionName } from './text.ts';
import type { View } from './view.ts';
import { createWardrobe, wardrobeClass, type WardrobeView } from './wardrobe.ts';

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
  armory: View;
  wardrobe: WardrobeView;
  codex: View;
}

const DIGIT_CODES = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5'];
const NUMPAD_CODES = ['Numpad1', 'Numpad2', 'Numpad3', 'Numpad4', 'Numpad5'];
const INTERACTIVE_TAGS = new Set(['BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'A']);
const REROLL_CODE = 'KeyR';
/** screenX is sent with this many decimals (sub-pixel changes must not re-emit 'ui:showcase'). */
const SHOWCASE_PRECISION = 1000;

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

function openPage(page: PageKind): void {
  // The wardrobe needs a hero to dress: it is offered on the menu and in the lobby only.
  if (page === 'wardrobe' && state.screen !== 'menu' && state.screen !== 'lobby') return;
  ui.page = page;
  ui.modal = null;
  blurActive();
  refresh();
}

function closePage(): void {
  if (ui.page === null) return;
  ui.page = null;
  blurActive();
  refresh();
}

let lastShowcase = 'null';

/** Tells the 3D view where to present which hero (menu stage / wardrobe), or to hide the preview. */
function syncShowcase(): void {
  if (!views) return;
  const centre = (stage: HTMLElement): number | null => {
    const rect = stage.getBoundingClientRect();
    if (rect.width <= 0 || window.innerWidth <= 0) return null;
    return Math.round(((rect.left + rect.width / 2) / window.innerWidth) * SHOWCASE_PRECISION) / SHOWCASE_PRECISION;
  };
  let request: { cls: ReturnType<typeof wardrobeClass>; screenX: number } | null = null;
  if (ui.page === 'wardrobe' && views.wardrobe.el.isConnected) {
    const screenX = centre(views.wardrobe.stage);
    if (screenX !== null) request = { cls: wardrobeClass(), screenX };
  } else if (state.screen === 'menu' && ui.page === null && views.menu.el.isConnected) {
    const screenX = centre(views.menu.stage);
    if (screenX !== null) request = { cls: state.profile.cls, screenX };
  }
  const key = JSON.stringify(request);
  if (key === lastShowcase) return;
  lastShowcase = key;
  bus.emit('ui:showcase', request);
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
  // The wardrobe is see-through (3D preview), so the screen below it steps aside while it is open.
  const wardrobe = ui.page === 'wardrobe';
  mount(v.loading, screen === 'loading');
  mount(v.menu, screen === 'menu' && !wardrobe);
  mount(v.lobby, screen === 'lobby' && !wardrobe);
  mount(v.summary, screen === 'summary');
  mount(v.hud, screen === 'game');
  mount(v.draft, v.draft.active());
  v.overlays.sync();
  mount(v.overlays, v.overlays.isOpen());
  mount(v.tab, screen === 'game' && ui.tab && !v.overlays.isOpen());
  mount(v.armory, ui.page === 'armory');
  mount(v.wardrobe, wardrobe);
  mount(v.codex, ui.page === 'codex');
  for (const view of [v.loading, v.menu, v.lobby, v.summary, v.hud, v.draft, v.tab, v.armory, v.wardrobe, v.codex]) {
    if (view.el.isConnected) view.sync();
  }
  rootEl?.setAttribute('data-page', ui.page ?? '');
  syncShowcase();
}

/**
 * Hands the 3D view the words it draws into the world: "Resonance" and the six reaction names, in the current
 * language. Sent whenever the UI is (re)built — at start and on a language change — and again on every screen
 * change, because the view is created after the UI and the bus does not replay.
 */
function emitLabels(): void {
  bus.emit('ui:labels', {
    resonance: t('hud.resonance'),
    reactions: Object.fromEntries(REACTIONS.map((def) => [def.id, reactionName(def)])),
  });
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
    menu: createMenu(openModal, openPage),
    lobby: createLobby(openModal, openPage),
    summary: createSummary(openModal, openPage),
    hud: createHud(),
    draft: createDraft(),
    tab: createScoreboard(),
    overlays: createOverlays({ closeModal, setPause, openCodex: () => openPage('codex') }),
    toasts: createToasts(),
    armory: createHub(closePage),
    wardrobe: createWardrobe(closePage, refresh),
    codex: createCodex(closePage),
  };
  rootEl.append(views.toasts.el);
  refresh();
  emitLabels();
}

function handleEscape(): void {
  if (!views) return;
  if (ui.page !== null && !ui.fatal) { closePage(); return; }
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
  if (overlayOpen || ev.repeat || ui.page !== null) return;
  const digit = Math.max(DIGIT_CODES.indexOf(ev.code), NUMPAD_CODES.indexOf(ev.code));
  if (digit >= 0 && views.draft.active()) { views.draft.pick(digit); return; }
  if (ev.code === REROLL_CODE && views.draft.active()) { views.draft.reroll(); return; }
  if (ev.key === 'Enter') {
    const target = ev.target;
    if (target instanceof HTMLElement && INTERACTIVE_TAGS.has(target.tagName)) return;
    if (state.screen === 'menu') views.menu.primaryAction();
    else if (state.screen === 'lobby') views.lobby.primaryAction();
    else if (state.screen === 'game' && views.hud.el.isConnected) views.hud.dismissTip();
  }
}

function onKeyUp(ev: KeyboardEvent): void {
  if (ev.key === 'Tab' && ui.tab) { ui.tab = false; refresh(); }
}

/** Remembers the biome of every chamber seen in this run (the chamber track groups chambers into acts). */
function trackBiomes(): void {
  const run = state.run;
  if (!run || run.phase === 'lobby') { ui.biomes.clear(); return; }
  if (!run.room) return;
  if (run.chamber === 0 && ui.biomes.size > 1) ui.biomes.clear();
  ui.biomes.set(run.chamber, run.room.biome);
}

function trackOathBaseline(): void {
  const phase = state.run?.phase;
  // The booked rewards belong to the summary of one run: forget them once another run (or the lobby) is on.
  if (phase !== 'victory' && phase !== 'defeat') ui.progress = null;
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
    emitLabels();
    if (state.screen !== 'game') {
      ui.tab = false;
      if (ui.pause) { ui.pause = false; ui.pauseConfirm = false; bus.emit('ui:overlay', { open: false }); }
      views?.hud.reset();
    }
    // Pages survive lobby <-> summary; entering a run (or leaving the session) closes them.
    const keepPage = (state.screen === 'lobby' || state.screen === 'summary') && ui.page !== 'wardrobe';
    if (!keepPage) ui.page = null;
    ui.modal = null;
    blurActive();
    refresh();
  });
  bus.on('net:status', refresh);
  bus.on('state:roster', refresh);
  bus.on('state:run', () => { trackOathBaseline(); trackBiomes(); trackObjectiveRun(); refresh(); });
  bus.on('state:draft', refresh);
  bus.on('state:profile', refresh);
  bus.on('state:hud', () => { if (views?.hud.el.isConnected) views.hud.syncHud(); });
  bus.on('net:error', ({ error, fatal }) => {
    if (fatal) { ui.fatal = error; ui.page = null; }
    else views?.toasts.push(t(`error.${error}`));
    refresh();
  });

  // Rewards of the finished run were booked into the profile: the summary shows what changed.
  bus.on('game:progress', (progress) => { ui.progress = progress; refresh(); });

  // ---- gameplay feedback
  bus.on('game:event', (ev) => {
    // The tally for the run summary must not depend on the HUD being on screen.
    if (ev.e === 'objective') trackObjectiveEvent(ev);
    if (views?.hud.el.isConnected) views.hud.onEvent(ev);
    // A finished objective can change what the draft says about itself.
    if (ev.e === 'objective' && ev.what === 'done' && views?.draft.el.isConnected) views.draft.sync();
  });
  bus.on('game:localAction', (payload) => {
    // `slot` is not part of the contract yet (see the UI report): read it when the game sends it.
    const slot = (payload as { slot?: unknown }).slot;
    if (views?.hud.el.isConnected) views.hud.onLocalAction(payload.action, typeof slot === 'string' ? slot : undefined);
  });

  // ---- settings (language switches rebuild the whole UI in place)
  bus.on('settings:changed', (next) => {
    if (next.lang !== getLang()) { setLang(next.lang); build(); }
    else views?.overlays.sync();
  });

  // ---- keyboard owned by the UI: Esc, Tab (hold), 1-4, Enter. Gameplay keys are never touched.
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', () => { if (ui.tab) { ui.tab = false; refresh(); } });
  // The hero stage is measured in pixels: follow window resizes.
  window.addEventListener('resize', refresh);

  // ---- first gesture unlocks audio
  const gesture = (): void => {
    window.removeEventListener('pointerdown', gesture, true);
    window.removeEventListener('keydown', gesture, true);
    bus.emit('ui:gesture');
  };
  window.addEventListener('pointerdown', gesture, true);
  window.addEventListener('keydown', gesture, true);
}
