/**
 * Main menu: name, training / host / join, armory, codex, settings, profile record and the class picker.
 * The middle column is a transparent stage: the 3D view presents the selected hero there ('ui:showcase').
 */
import { NET, RUN } from '@shared/constants.ts';
import { CLASSES } from '@shared/data/classes.ts';
import { normalizeRoomCode, sanitizeName } from '@shared/protocol.ts';
import { wardenRank } from '@shared/data/feats.ts';
import { MASTERY } from '@shared/data/mastery.ts';
import { CLASS_IDS, type AbilitySlot, type ClassId } from '@shared/types.ts';
import { bus } from '../core/EventBus.ts';
import { artOf, classProgress, saveProfile, state, totalXp } from '../core/GameState.ts';
import { guardTextField, h, icon, key, replace, setAttr, setText, show, toggle } from './dom.ts';
import { formatInt, roman, t } from './i18n.ts';
import { CLASS_DIFFICULTY, HERO_SLOTS, abilityDesc, abilityIcon, abilityName, classStat, hasArt } from './model.ts';
import { openChoices, pendingCount } from './progress.ts';
import { ui, UI_CONFIG, type HubTab, type ModalKind, type PageKind } from './store.ts';
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

function abilityKey(slot: AbilitySlot): HTMLElement {
  if (slot === 'primary') return icon('mouseLeft', 'gg-class-mouse');
  if (slot === 'secondary') return icon('mouseRight', 'gg-class-mouse');
  return key(slot === 'ultimate' ? t('hud.key.ultimate') : t('hud.key.dash'));
}

const DIFFICULTY_STEPS = 3;

export interface MenuView extends View {
  /** Enter on the menu: join when a full code is typed, otherwise the highlighted action (training until it is done, then host). */
  primaryAction(): void;
  /** Transparent column whose centre is where the 3D hero preview should stand. */
  stage: HTMLElement;
}

export function createMenu(openModal: (kind: ModalKind) => void, openPage: (page: PageKind) => void): MenuView {
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
    if (state.conn.status === 'connecting') return;
    bus.emit('ui:create', { name: currentName(), cls: state.profile.cls });
  };
  const train = (): void => {
    if (state.conn.status === 'connecting') return;
    bus.emit('ui:create', { name: currentName(), cls: state.profile.cls, tutorial: true });
  };
  const join = (): void => {
    const code = normalizeRoomCode(ui.joinCode);
    if (!code || state.conn.status === 'connecting') return;
    bus.emit('ui:join', { code, name: currentName(), cls: state.profile.cls });
  };
  /** Enter: join with a typed code, otherwise whatever is highlighted (training for newcomers, then host). */
  const primary = (): void => {
    if (normalizeRoomCode(ui.joinCode)) join();
    else if (!state.profile.tutorialDone) train();
    else host();
  };
  guardTextField(nameInput, primary);

  const hostBtn = h('button', {
    class: 'gg-btn gg-cut gg-btn--primary gg-btn--block gg-menu-host', type: 'button', 'data-testid': 'menu-host',
    onClick: host,
  }, icon('bell'), t('menu.host'));
  const trainBtn = h('button', {
    class: 'gg-btn gg-cut gg-btn--block gg-menu-train', type: 'button', 'data-testid': 'menu-training', 'data-sfx': 'confirm',
    onClick: train,
  }, icon('training'), t('menu.training'));
  const trainHint = h('p', { class: 'gg-menu-train-hint' }, icon('tip'), t('menu.trainingHint'));
  const play = h('div', { class: 'gg-menu-play' }, h('div', { class: 'gg-menu-train-box' }, trainBtn, trainHint), hostBtn);

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


  // ---- profile record
  const stat = (label: string): { box: HTMLElement; value: HTMLElement } => {
    const value = h('b', { class: 'gg-num' });
    return { box: h('div', { class: 'gg-record-stat' }, value, h('span', null, label)), value };
  };
  const runs = stat(t('menu.stat.runs'));
  const wins = stat(t('menu.stat.wins'));
  const best = stat(t('menu.stat.best'));
  const oath = stat(t('menu.stat.oath'));
  const glimmer = stat(t('menu.stat.glimmer'));
  glimmer.box.classList.add('gg-record-stat--glimmer');
  glimmer.box.prepend(icon('glimmer'));

  const link = (iconName: 'armory' | 'codex' | 'help' | 'gear', label: string, testid: string | null, onClick: () => void): HTMLButtonElement =>
    h('button', {
      class: 'gg-btn gg-cut gg-btn--ghost gg-btn--small', type: 'button', 'data-testid': testid, 'data-sfx': 'click', onClick,
    }, icon(iconName), h('span', null, label));
  const openHub = (tab: HubTab, cls?: ClassId): void => {
    ui.hubTab = tab;
    if (cls) ui.hubCls = cls;
    openPage('armory');
  };
  const armoryWallet = h('b', { class: 'gg-menu-wallet gg-num' });
  // The badge counts what is waiting inside: feat rewards to claim and talents / arts to choose.
  const armoryBadge = h('i', { class: 'gg-tab-badge gg-menu-badge gg-num', 'data-testid': 'menu-armory-badge', 'data-count': '0' });
  const armoryBtn = link('armory', t('menu.armory'), 'menu-armory', () => {
    // With something to claim or choose the hub opens where it is; otherwise where it was left.
    const choice = openChoices()[0];
    if (pendingCount() > 0) openHub(choice && pendingCount() === openChoices().length ? 'mastery' : 'chronicle', choice?.cls);
    else openPage('armory');
  });
  armoryBtn.append(armoryWallet);
  // The badge sits outside the button: the cut corners of a button clip everything inside it.
  const armoryBox = h('div', { class: 'gg-menu-armory' }, armoryBtn, armoryBadge);
  const rankValue = h('b', { class: 'gg-num' });
  const rank = h('span', { class: 'gg-menu-rank', 'data-testid': 'menu-rank', 'data-rank': '1' }, icon('crown'), h('span', null, t('menu.rank')), rankValue);

  const left = h('div', { class: 'gg-menu-left' },
    h('header', { class: 'gg-logo gg-logo--row' },
      h('div', { class: 'gg-logo-emblem' }, icon('emblem')),
      h('div', null,
        h('h1', { class: 'gg-logo-title' }, t('common.title')),
        h('p', { class: 'gg-logo-tag' }, t('common.tagline')),
      ),
    ),
    h('div', { class: 'gg-menu-form' },
      h('div', null, h('label', { class: 'gg-label', for: 'gg-name' }, t('menu.name')), nameInput),
      play,
      h('div', null,
        h('label', { class: 'gg-label', for: 'gg-code' }, t('menu.joinLabel')),
        h('div', { class: 'gg-menu-join' }, codeInput, joinBtn),
      ),
      h('div', { class: 'gg-menu-links' },
        armoryBox,
        link('codex', t('menu.codex'), 'menu-codex', () => openPage('codex')),
        link('help', t('menu.howto'), 'menu-howto', () => openModal('howto')),
        link('gear', t('menu.settings'), 'menu-settings', () => openModal('settings')),
      ),
    ),
    h('footer', { class: 'gg-record' },
      h('div', { class: 'gg-label gg-record-label' }, t('menu.profile'), rank),
      h('div', { class: 'gg-record-row' }, runs.box, wins.box, best.box, oath.box, glimmer.box),
    ),
  );

  // ---- hero stage (transparent: the 3D preview shows through) + wardrobe
  const stageName = h('div', { class: 'gg-stage-name' });
  const stageRole = h('div', { class: 'gg-stage-role' });
  const stage = h('div', { class: 'gg-menu-stage' },
    h('div', { class: 'gg-stage-plate' },
      stageName, stageRole,
      h('button', {
        class: 'gg-btn gg-cut gg-btn--small gg-stage-wardrobe', type: 'button', 'data-testid': 'menu-wardrobe', 'data-sfx': 'click',
        onClick: () => { ui.wardrobeCls = state.profile.cls; openPage('wardrobe'); },
      }, icon('wardrobe'), t('menu.wardrobe')),
    ),
  );

  // ---- class picker: seven compact tiles, one detail card for the selected class
  const tiles = new Map<ClassId, { el: HTMLButtonElement; level: HTMLElement }>();
  const grid = h('div', { class: 'gg-class-picker', role: 'radiogroup', 'aria-label': t('menu.class') });
  for (const cls of CLASS_IDS) {
    const level = h('span', { class: 'gg-class-tile-level gg-num' });
    const tile = h('button', {
      class: `gg-class-tile gg-cut gg-cls-${cls}`, type: 'button', role: 'radio', 'data-testid': `menu-class-${cls}`, 'data-sfx': 'tab',
      title: `${t(`class.${cls}.name`)} — ${t(`class.${cls}.role`)}`,
      onClick: () => { saveProfile({ cls }); syncClass(); },
    },
      h('span', { class: 'gg-class-tile-emblem' }, icon(cls)),
      h('span', { class: 'gg-class-tile-name' }, t(`class.${cls}.name`)),
      level,
    );
    tiles.set(cls, { el: tile, level });
    grid.append(tile);
  }
  const detail = h('article', { class: 'gg-class-detail gg-cut', 'data-testid': 'menu-class-detail', 'data-cls': '' });
  let detailKey = '';

  const renderDetail = (cls: ClassId): void => {
    const p = classProgress(cls);
    const art = artOf(cls);
    const news = openChoices().filter((o) => o.cls === cls).length;
    const k = JSON.stringify([cls, p, art, news]);
    if (k === detailKey) return;
    detailKey = k;
    setAttr(detail, 'data-cls', cls);
    setAttr(detail, 'data-level', String(p.level));
    setAttr(detail, 'data-art', String(art));
    detail.className = `gg-class-detail gg-cut gg-cls-${cls}`;
    const abilities = h('ul', { class: 'gg-class-abilities' });
    for (const slot of HERO_SLOTS) {
      const usesArt = slot === 'secondary' && hasArt(cls, art);
      abilities.append(h('li', { class: `is-${slot}`, 'data-slot': slot },
        abilityKey(slot),
        icon(abilityIcon(cls, slot, art), 'gg-class-ability-icon'),
        h('span', { class: 'gg-class-ability-text' },
          h('b', null, abilityName(cls, slot, art)),
          usesArt ? h('em', { class: 'gg-class-art-tag' }, t('slot.art')) : slot === 'ultimate' ? h('em', { class: 'gg-class-ult-tag' }, t('slot.ultimate')) : null,
          ' ', h('span', null, abilityDesc(cls, slot, art))),
      ));
    }
    const difficulty = CLASS_DIFFICULTY[cls];
    const diffPips = h('span', { class: 'gg-pips gg-diff-pips', role: 'img', 'aria-label': `${t('difficulty.label')} ${difficulty}/${DIFFICULTY_STEPS}` });
    for (let i = 0; i < DIFFICULTY_STEPS; i++) diffPips.append(h('i', { class: i < difficulty ? 'is-on' : '' }));
    const fill = h('i', { class: 'gg-xp-fill' });
    fill.style.setProperty('--w', `${Math.round((p.into / Math.max(1, p.need)) * 1000) / 10}%`);
    replace(detail,
      h('div', { class: 'gg-class-head' },
        h('span', { class: 'gg-class-emblem' }, icon(cls)),
        h('div', { class: 'gg-class-title' },
          h('div', { class: 'gg-class-name' }, t(`class.${cls}.name`)),
          h('div', { class: 'gg-class-role' }, t(`class.${cls}.role`)),
        ),
        h('div', { class: 'gg-class-diff', title: t('difficulty.label') }, diffPips, h('span', null, t(`difficulty.${difficulty}`))),
      ),
      abilities,
      h('div', { class: 'gg-class-stats' },
        statPips(`${t('menu.health')} ${CLASSES[cls].maxHp}`, 'heart', classStat(cls, 'maxHp')),
        statPips(t('menu.speed'), 'speed', classStat(cls, 'moveSpeed')),
      ),
      h('div', { class: 'gg-class-mastery', 'data-testid': 'menu-class-mastery' },
        h('div', { class: 'gg-class-mastery-level' }, h('span', null, t('menu.mastery')), h('b', { class: 'gg-num' }, t('common.lv', { n: p.level }))),
        h('div', { class: 'gg-class-mastery-bar' },
          h('div', { class: 'gg-xp-bar' }, fill),
          h('span', { class: 'gg-num' }, p.level < MASTERY.ART_LEVEL
            ? t('menu.artAt', { n: MASTERY.ART_LEVEL })
            : t('mastery.xp', { into: formatInt(p.into), need: formatInt(p.need) })),
        ),
        h('button', {
          class: 'gg-btn gg-cut gg-btn--small gg-class-mastery-btn', type: 'button', 'data-testid': 'menu-mastery', 'data-sfx': 'click',
          onClick: () => openHub('mastery', cls),
        }, icon('talent'), h('span', null, t('menu.classMastery')), news > 0 ? h('i', { class: 'gg-tab-badge gg-num' }, String(news)) : null),
      ),
    );
  };

  const backdrop = h('div', { class: 'gg-menu-bg gg-backdrop' });
  const el = h('section', { class: 'gg-screen gg-menu' },
    backdrop,
    motes(),
    h('div', { class: 'gg-menu-layout' },
      left,
      stage,
      h('div', { class: 'gg-menu-right' }, h('h2', { class: 'gg-section-title' }, t('menu.class')), grid, detail),
    ),
  );

  /** Keeps the hole in the backdrop centred on the stage column. */
  const placeHole = (): void => {
    const rect = stage.getBoundingClientRect();
    if (rect.width <= 0) return;
    backdrop.style.setProperty('--hole-x', `${Math.round(rect.left + rect.width / 2)}px`);
    backdrop.style.setProperty('--hole-w', `${Math.round(rect.width / 2)}px`);
  };

  function syncClass(): void {
    for (const [cls, tile] of tiles) {
      const on = state.profile.cls === cls;
      toggle(tile.el, 'is-selected', on);
      tile.el.setAttribute('aria-checked', String(on));
      setText(tile.level, t('common.lv', { n: classProgress(cls).level }));
    }
    renderDetail(state.profile.cls);
    setText(stageName, t(`class.${state.profile.cls}.name`));
    setText(stageRole, t(`class.${state.profile.cls}.role`));
    stage.className = `gg-menu-stage gg-cls-${state.profile.cls}`;
  }

  function syncButtons(): void {
    const busy = state.conn.status === 'connecting';
    hostBtn.disabled = busy;
    trainBtn.disabled = busy;
    joinBtn.disabled = busy || normalizeRoomCode(ui.joinCode) === null;
  }

  const sync = (): void => {
    syncClass();
    syncButtons();
    const p = state.profile;
    setText(runs.value, String(p.runs));
    setText(wins.value, String(p.wins));
    setText(best.value, p.bestChamber > 0 ? t('menu.stat.bestValue', { n: p.bestChamber, total: RUN.CHAMBERS.length }) : '–');
    setText(oath.value, roman(p.oathUnlocked));
    setText(glimmer.value, formatInt(p.glimmer));
    setText(armoryWallet, p.glimmer > 0 ? formatInt(p.glimmer) : '');
    show(armoryWallet, p.glimmer > 0);
    const pending = pendingCount();
    setText(armoryBadge, pending > 0 ? String(pending) : '');
    setAttr(armoryBadge, 'data-count', String(pending));
    show(armoryBadge, pending > 0);
    const choices = openChoices().length;
    armoryBtn.title = [
      pending - choices > 0 ? t('menu.badge.feats', { n: pending - choices }) : '', choices > 0 ? t('menu.badge.choices') : '',
    ].filter((part) => part !== '').join(' · ');
    const warden = wardenRank(totalXp());
    setText(rankValue, formatInt(warden));
    setAttr(rank, 'data-rank', String(warden));
    // Until the training is done it is the highlighted way in; afterwards hosting is.
    const trained = p.tutorialDone;
    toggle(play, 'is-trained', trained);
    toggle(trainBtn, 'gg-btn--primary', !trained);
    toggle(trainBtn, 'gg-btn--ghost', trained);
    toggle(trainBtn, 'gg-btn--small', trained);
    toggle(hostBtn, 'gg-btn--primary', trained);
    show(trainHint, !trained);
    el.dataset.trained = String(trained);
    setText(stageName, t(`class.${p.cls}.name`));
    setText(stageRole, t(`class.${p.cls}.role`));
    stage.className = `gg-menu-stage gg-cls-${p.cls}`;
    placeHole();
    if (document.activeElement !== nameInput && nameInput.value !== p.name) nameInput.value = p.name;
    if (document.activeElement !== codeInput && codeInput.value !== ui.joinCode) codeInput.value = ui.joinCode;
  };

  return { el, sync, stage, primaryAction: primary };
}

/** Reads `?join=CODE` once at startup. */
export function readJoinParam(): void {
  const raw = new URLSearchParams(window.location.search).get(JOIN_PARAM);
  if (raw) ui.joinCode = cleanCode(raw);
}
