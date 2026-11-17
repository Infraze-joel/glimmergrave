/** Main menu: name, class picker, host / join, how to play, settings, profile record. */
import { NET, RUN } from '@shared/constants.ts';
import { CLASSES } from '@shared/data/classes.ts';
import { normalizeRoomCode, sanitizeName } from '@shared/protocol.ts';
import { CLASS_IDS, type ClassId } from '@shared/types.ts';
import { bus } from '../core/EventBus.ts';
import { saveProfile, state } from '../core/GameState.ts';
import { guardTextField, h, icon, key, setText, show, toggle } from './dom.ts';
import { roman, t } from './i18n.ts';
import { ABILITY_ICON, ABILITY_SLOTS, classStat } from './model.ts';
import { ui, UI_CONFIG, type ModalKind } from './store.ts';
import type { View } from './view.ts';

const MIN_STAT_PIPS = 2;
const JOIN_PARAM = 'join';
const ALLOWED = new Set(NET.ROOM_CODE_ALPHABET);

/** Keeps only valid room-code characters. Accepts a pasted invite link as well. */
export function cleanCode(raw: string): string {
  let text = raw;
  const match = /[?&]join=([^&#\s]+)/i.exec(raw);
  if (match) text = match[1];
  let out = '';
  for (const ch of text.toUpperCase()) {
    if (ALLOWED.has(ch)) out += ch;
    if (out.length === NET.ROOM_CODE_LENGTH) break;
  }
  return out;
}

export function motes(): HTMLElement {
  const box = h('div', { class: 'gg-motes', 'aria-hidden': 'true' });
  for (let i = 0; i < UI_CONFIG.MOTE_COUNT; i++) {
    const mote = h('i');
    // Deterministic scatter so the layout is stable between rebuilds.
    mote.style.left = `${(i * 37 + 11) % 100}%`;
    mote.style.animationDelay = `${-((i * 53) % 140) / 10}s`;
    mote.style.animationDuration = `${11 + ((i * 7) % 9)}s`;
    box.append(mote);
  }
  return box;
}

function statPips(label: string, iconName: 'heart' | 'speed', fraction: number): HTMLElement {
  const filled = MIN_STAT_PIPS + Math.round(fraction * (UI_CONFIG.STAT_PIPS - MIN_STAT_PIPS));
  const pips = h('span', { class: 'gg-pips', role: 'img', 'aria-label': `${label} ${filled}/${UI_CONFIG.STAT_PIPS}` });
  for (let i = 0; i < UI_CONFIG.STAT_PIPS; i++) pips.append(h('i', { class: i < filled ? 'is-on' : '' }));
  return h('div', { class: `gg-class-stat gg-class-stat--${iconName}` }, icon(iconName), h('span', null, label), pips);
}

function abilityKey(slot: (typeof ABILITY_SLOTS)[number]): HTMLElement {
  if (slot === 'primary') return icon('mouseLeft', 'gg-class-mouse');
  if (slot === 'secondary') return icon('mouseRight', 'gg-class-mouse');
  return key(t('hud.key.dash'));
}

export interface MenuView extends View {
  /** Enter on the menu: join when a full code is typed, otherwise host. */
  primaryAction(): void;
}

export function createMenu(openModal: (kind: ModalKind) => void): MenuView {
  // ---- name
  const nameInput = h('input', {
    class: 'gg-input', type: 'text', id: 'gg-name', maxlength: NET.MAX_NAME_LENGTH, autocomplete: 'off',
    spellcheck: 'false', placeholder: t('menu.namePlaceholder'), 'data-testid': 'menu-name',
  });
  nameInput.value = state.profile.name;
  const currentName = (): string => sanitizeName(nameInput.value) ?? t('menu.defaultName');
  nameInput.addEventListener('input', () => saveProfile({ name: sanitizeName(nameInput.value) ?? '' }));

  // ---- host / join
  const host = (): void => {
    if (!ui.serverConfigured || state.conn.status === 'connecting') return;
    bus.emit('ui:create', { name: currentName(), cls: state.profile.cls });
  };
  const join = (): void => {
    const code = normalizeRoomCode(ui.joinCode);
    if (!code || !ui.serverConfigured || state.conn.status === 'connecting') return;
    bus.emit('ui:join', { code, name: currentName(), cls: state.profile.cls });
  };
  guardTextField(nameInput, () => (normalizeRoomCode(ui.joinCode) ? join() : host()));

  const hostBtn = h('button', {
    class: 'gg-btn gg-cut gg-btn--primary gg-btn--block gg-menu-host', type: 'button', 'data-testid': 'menu-host',
    onClick: host,
  }, icon('bell'), t('menu.host'));

  const codeInput = h('input', {
    class: 'gg-input gg-input--code', type: 'text', id: 'gg-code', maxlength: NET.ROOM_CODE_LENGTH, autocomplete: 'off',
    autocapitalize: 'characters', spellcheck: 'false', placeholder: t('menu.codePlaceholder'),
    'aria-label': t('menu.joinLabel'), 'data-testid': 'menu-join-code',
  });
  codeInput.value = ui.joinCode;
  const joinBtn = h('button', {
    class: 'gg-btn gg-cut gg-btn--glimmer', type: 'button', 'data-testid': 'menu-join', onClick: join,
  }, t('menu.join'));
  const applyCode = (raw: string): void => {
    ui.joinCode = cleanCode(raw);
    if (codeInput.value !== ui.joinCode) codeInput.value = ui.joinCode;
    syncButtons();
  };
  codeInput.addEventListener('input', () => applyCode(codeInput.value));
  codeInput.addEventListener('paste', (ev) => {
    const text = ev.clipboardData?.getData('text');
    if (text === undefined) return;
    ev.preventDefault();
    applyCode(text);
  });
  guardTextField(codeInput, join);

  const notice = h('div', { class: 'gg-menu-notice', role: 'status' },
    icon('warning'),
    h('div', null, h('b', null, t('menu.notConfigured.title')), h('p', null, t('menu.notConfigured.body'))),
  );

  // ---- profile record
  const stat = (label: string): { box: HTMLElement; value: HTMLElement } => {
    const value = h('b', { class: 'gg-num' });
    return { box: h('div', { class: 'gg-record-stat' }, value, h('span', null, label)), value };
  };
  const runs = stat(t('menu.stat.runs'));
  const wins = stat(t('menu.stat.wins'));
  const best = stat(t('menu.stat.best'));
  const oath = stat(t('menu.stat.oath'));

  const left = h('div', { class: 'gg-menu-left' },
    h('header', { class: 'gg-logo' },
      h('div', { class: 'gg-logo-emblem' }, icon('emblem')),
      h('h1', { class: 'gg-logo-title' }, t('common.title')),
      h('p', { class: 'gg-logo-tag' }, t('common.tagline')),
    ),
    h('div', { class: 'gg-menu-form' },
      h('div', null, h('label', { class: 'gg-label', for: 'gg-name' }, t('menu.name')), nameInput),
      hostBtn,
      h('div', null,
        h('label', { class: 'gg-label', for: 'gg-code' }, t('menu.joinLabel')),
        h('div', { class: 'gg-menu-join' }, codeInput, joinBtn),
      ),
      notice,
      h('div', { class: 'gg-menu-links' },
        h('button', { class: 'gg-btn gg-cut gg-btn--ghost gg-btn--small', type: 'button', onClick: () => openModal('howto') },
          icon('help'), t('menu.howto')),
        h('button', { class: 'gg-btn gg-cut gg-btn--ghost gg-btn--small', type: 'button', onClick: () => openModal('settings') },
          icon('gear'), t('menu.settings')),
      ),
    ),
    h('footer', { class: 'gg-record' },
      h('div', { class: 'gg-label' }, t('menu.profile')),
      h('div', { class: 'gg-record-row' }, runs.box, wins.box, best.box, oath.box),
    ),
  );

  // ---- class picker
  const cards = new Map<ClassId, HTMLElement>();
  const grid = h('div', { class: 'gg-class-grid', role: 'radiogroup', 'aria-label': t('menu.class') });
  for (const cls of CLASS_IDS) {
    const abilities = h('ul', { class: 'gg-class-abilities' });
    for (const slot of ABILITY_SLOTS) {
      abilities.append(h('li', null,
        abilityKey(slot),
        icon(ABILITY_ICON[cls][slot], 'gg-class-ability-icon'),
        h('span', { class: 'gg-class-ability-text' },
          h('b', null, t(`class.${cls}.${slot}.name`)), ' ', h('span', null, t(`class.${cls}.${slot}.desc`))),
      ));
    }
    const card = h('button', {
      class: `gg-class-card gg-cut gg-cls-${cls}`, type: 'button', role: 'radio', 'data-testid': `menu-class-${cls}`,
      onClick: () => { saveProfile({ cls }); syncClass(); },
    },
      h('div', { class: 'gg-class-head' },
        h('span', { class: 'gg-class-emblem' }, icon(cls)),
        h('div', { class: 'gg-class-title' },
          h('div', { class: 'gg-class-name' }, t(`class.${cls}.name`)),
          h('div', { class: 'gg-class-role' }, t(`class.${cls}.role`)),
        ),
        h('span', { class: 'gg-class-check' }, icon('check')),
      ),
      abilities,
      h('div', { class: 'gg-class-stats' },
        statPips(`${t('menu.health')} ${CLASSES[cls].maxHp}`, 'heart', classStat(cls, 'maxHp')),
        statPips(t('menu.speed'), 'speed', classStat(cls, 'moveSpeed')),
      ),
    );
    cards.set(cls, card);
    grid.append(card);
  }

  const el = h('section', { class: 'gg-screen gg-menu gg-backdrop' },
    motes(),
    h('div', { class: 'gg-menu-layout' },
      left,
      h('div', { class: 'gg-menu-right' }, h('h2', { class: 'gg-section-title' }, t('menu.class')), grid),
    ),
  );

  function syncClass(): void {
    for (const [cls, card] of cards) {
      const on = state.profile.cls === cls;
      toggle(card, 'is-selected', on);
      card.setAttribute('aria-checked', String(on));
    }
  }

  function syncButtons(): void {
    const busy = state.conn.status === 'connecting';
    hostBtn.disabled = !ui.serverConfigured || busy;
    joinBtn.disabled = !ui.serverConfigured || busy || normalizeRoomCode(ui.joinCode) === null;
    codeInput.disabled = !ui.serverConfigured;
    show(notice, !ui.serverConfigured);
  }

  const sync = (): void => {
    syncClass();
    syncButtons();
    const p = state.profile;
    setText(runs.value, String(p.runs));
    setText(wins.value, String(p.wins));
    setText(best.value, p.bestChamber > 0 ? t('menu.stat.bestValue', { n: p.bestChamber, total: RUN.CHAMBERS.length }) : '–');
    setText(oath.value, roman(p.oathUnlocked));
    if (document.activeElement !== nameInput && nameInput.value !== p.name) nameInput.value = p.name;
    if (document.activeElement !== codeInput && codeInput.value !== ui.joinCode) codeInput.value = ui.joinCode;
  };

  return { el, sync, primaryAction: () => (normalizeRoomCode(ui.joinCode) ? join() : host()) };
}

/** Reads `?join=CODE` once at startup. */
export function readJoinParam(): void {
  const raw = new URLSearchParams(window.location.search).get(JOIN_PARAM);
  if (raw) ui.joinCode = cleanCode(raw);
}
