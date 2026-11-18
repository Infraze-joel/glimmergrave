/** Lobby: room code + invite, four player slots, class switcher, ready, oath (host), start (host). */
import { NET, RUN } from '@shared/constants.ts';
import { TALENT_TIERS } from '@shared/data/mastery.ts';
import { REWARDS } from '@shared/data/meta.ts';
import { CLASS_IDS, type ClassId } from '@shared/types.ts';
import { bus } from '../core/EventBus.ts';
import { equippedRelics, isHost, saveProfile, selfRoster, state, talentsOf } from '../core/GameState.ts';
import { copyText, h, icon, setAttr, setText, show, toggle } from './dom.ts';
import { formatInt, formatList, roman, t } from './i18n.ts';
import { abilityIcon, abilityName, inviteLink, MAX_OATH, oathDescription, oathName, rosterBySlot } from './model.ts';
import { pendingCount } from './progress.ts';
import { UI_CONFIG, type ModalKind, type PageKind } from './store.ts';
import { lookColor } from './wardrobe.ts';
import type { View } from './view.ts';
import { motes } from './menu.ts';

const PERCENT = 100;

export interface LobbyView extends View {
  /** Enter in the lobby: start when possible (host), otherwise toggle ready. */
  primaryAction(): void;
}

interface StartInfo {
  can: boolean;
  reason: string;
}

function startInfo(): StartInfo {
  const me = selfRoster();
  const waiting = state.roster.filter((p) => p.connected && !p.ready);
  if (waiting.length === 0) return { can: true, reason: t('lobby.reason.go') };
  if (me && !me.ready && waiting.length === 1) return { can: false, reason: t('lobby.reason.selfNotReady') };
  const names = waiting.filter((p) => p.slot !== me?.slot).map((p) => p.name);
  if (me && !me.ready) names.unshift(t('common.you'));
  return { can: false, reason: t('lobby.reason.othersNotReady', { names: formatList(names) }) };
}

export function createLobby(openModal: (kind: ModalKind) => void, openPage: (page: PageKind) => void): LobbyView {
  // ---- code + invite
  const code = h('div', { class: 'gg-lobby-code', 'data-testid': 'lobby-code' });
  const feedback = (btn: HTMLButtonElement, label: HTMLElement, original: string) => async (): Promise<void> => {
    const text = btn.dataset.copy ?? '';
    const ok = await copyText(text);
    label.textContent = ok ? t('common.copied') : t('common.copyFailed');
    btn.classList.add('is-done');
    window.setTimeout(() => { label.textContent = original; btn.classList.remove('is-done'); }, UI_CONFIG.COPY_FEEDBACK_MS);
  };
  const copyCodeLabel = h('span', null, t('lobby.copyCode'));
  const copyCodeBtn = h('button', { class: 'gg-btn gg-cut gg-btn--ghost gg-btn--small', type: 'button' }, icon('copy'), copyCodeLabel);
  copyCodeBtn.addEventListener('click', () => void feedback(copyCodeBtn, copyCodeLabel, t('lobby.copyCode'))());
  const copyLinkLabel = h('span', null, t('lobby.copyLink'));
  const copyLinkBtn = h('button', { class: 'gg-btn gg-cut gg-btn--ghost gg-btn--small', type: 'button' }, icon('link'), copyLinkLabel);
  copyLinkBtn.addEventListener('click', () => void feedback(copyLinkBtn, copyLinkLabel, t('lobby.copyLink'))());

  // ---- slots (display only, rebuilt on every roster change)
  const slots = h('div', { class: 'gg-lobby-slots' });

  let slotsKey = '';
  const renderSlots = (): void => {
    // Rebuild only when something visible changed (net:status fires on every ping update).
    const key = JSON.stringify([
      state.conn.slot, state.roster.map((p) => [p.slot, p.name, p.cls, p.ready, p.connected, p.host, p.look?.color ?? 0, p.mastery, p.art, p.relics, p.talents]),
      equippedRelics(), state.profile.talents,
    ]);
    if (key === slotsKey) return;
    slotsKey = key;
    slots.replaceChildren();
    for (let slot = 0; slot < NET.MAX_PLAYERS; slot++) {
      const p = rosterBySlot(slot);
      if (!p) {
        slots.append(h('div', {
          class: 'gg-slot gg-cut is-empty', 'data-testid': `lobby-slot-${slot}`, 'data-ready': 'false', 'data-connected': 'false',
        },
          h('span', { class: 'gg-slot-emblem' }, icon('users')),
          h('div', { class: 'gg-slot-name' }, t('lobby.slotEmpty')),
          h('div', { class: 'gg-slot-class' }, t('lobby.slotEmptyHint')),
        ));
        continue;
      }
      const own = p.slot === state.conn.slot;
      const status = !p.connected
        ? h('div', { class: 'gg-slot-state is-off' }, icon('unlink'), t('lobby.disconnected'))
        : p.ready
          ? h('div', { class: 'gg-slot-state is-ready' }, icon('check'), t('lobby.ready'))
          : h('div', { class: 'gg-slot-state' }, icon('hourglass'), t('lobby.notReady'));
      const cloth = lookColor(p.look?.color ?? 0);
      const level = Math.max(1, Math.floor(p.mastery ?? 1));
      const art = p.art ?? 0;
      // The own card follows the profile at once; the others show what the roster says (counts only).
      const count = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0);
      const relics = own ? equippedRelics().length : count(p.relics);
      const talents = own ? talentsOf(p.cls).filter((option) => option > 0).length : Math.min(TALENT_TIERS, count(p.talents));
      const card = h('div', {
        class: `gg-slot gg-cut gg-cls-${p.cls}${own ? ' is-own' : ''}${p.ready && p.connected ? ' is-ready' : ''}${p.connected ? '' : ' is-off'}`,
        'data-testid': `lobby-slot-${slot}`, 'data-ready': String(p.ready), 'data-connected': String(p.connected),
        'data-look-color': String(p.look?.color ?? 0), 'data-mastery': String(p.mastery ?? 1), 'data-art': String(p.art ?? 0),
        'data-relics': String(relics), 'data-talents': String(talents),
      },
        p.host ? h('span', { class: 'gg-slot-host', title: t('lobby.host') }, icon('boss'), t('lobby.host')) : null,
        own ? h('span', { class: 'gg-slot-you' }, t('common.you')) : null,
        h('span', { class: 'gg-slot-emblem' }, icon(p.cls)),
        h('div', { class: 'gg-slot-name' }, p.name),
        h('div', { class: 'gg-slot-class' }, t(`class.${p.cls}.name`), h('b', { class: 'gg-slot-level gg-num' }, t('common.lv', { n: level }))),
        h('div', { class: 'gg-slot-loadout' },
          h('span', { class: 'gg-slot-art', title: t('mastery.secondary') }, icon(abilityIcon(p.cls, 'secondary', art)), abilityName(p.cls, 'secondary', art)),
          relics > 0 ? h('span', { class: 'gg-slot-relics' }, icon('relic'), relics === 1 ? t('lobby.slot.relics.one') : t('lobby.slot.relics.many', { n: relics })) : null,
          talents > 0 ? h('span', { class: 'gg-slot-talents' }, icon('talent'), t('lobby.slot.talents', { n: talents, m: TALENT_TIERS })) : null,
        ),
        status,
        h('i', { class: 'gg-slot-cloth', 'aria-hidden': 'true' }),
      );
      // Cloth colour of the hero's look as an accent (index 0 keeps the class colour).
      if (cloth) card.style.setProperty('--look', cloth);
      slots.append(card);
    }
  };

  // ---- own class switcher
  const classButtons = new Map<ClassId, HTMLButtonElement>();
  const classRow = h('div', { class: 'gg-lobby-classes', role: 'radiogroup', 'aria-label': t('lobby.yourClass') });
  for (const cls of CLASS_IDS) {
    const btn = h('button', {
      class: `gg-class-chip gg-cut gg-cls-${cls}`, type: 'button', role: 'radio',
      onClick: () => { saveProfile({ cls }); bus.emit('ui:lobby', { cls }); },
    }, icon(cls), h('span', null, t(`class.${cls}.name`)));
    classButtons.set(cls, btn);
    classRow.append(btn);
  }

  // ---- own loadout: wardrobe + armory
  const walletText = h('b', { class: 'gg-menu-wallet gg-num' });
  const armoryBadge = h('i', { class: 'gg-tab-badge gg-menu-badge gg-num' });
  const wardrobeBtn = h('button', {
    class: 'gg-btn gg-cut gg-btn--ghost gg-btn--small', type: 'button', 'data-testid': 'lobby-wardrobe', 'data-sfx': 'click',
    onClick: () => openPage('wardrobe'),
  }, icon('wardrobe'), h('span', null, t('menu.wardrobe')));
  const armoryBtn = h('button', {
    class: 'gg-btn gg-cut gg-btn--ghost gg-btn--small', type: 'button', 'data-testid': 'lobby-armory', 'data-sfx': 'click',
    onClick: () => openPage('armory'),
  }, icon('armory'), h('span', null, t('menu.armory')), walletText);
  const loadoutRow = h('div', { class: 'gg-lobby-loadout' }, wardrobeBtn, h('div', { class: 'gg-menu-armory' }, armoryBtn, armoryBadge));

  // ---- oath: a stepper over the unlocked levels (0..RUN.OATH_MAX), with what the level does to the enemies
  const step = (delta: number): void => {
    if (!isHost()) return;
    const next = Math.min(Math.min(MAX_OATH, state.profile.oathUnlocked), Math.max(0, state.oath + delta));
    if (next !== state.oath) bus.emit('ui:lobby', { oath: next });
  };
  const oathDec = h('button', {
    class: 'gg-oath-step gg-cut', type: 'button', 'aria-label': t('lobby.oath.dec'), title: t('lobby.oath.dec'), 'data-testid': 'lobby-oath-dec', 'data-sfx': 'click',
    onClick: () => step(-1),
  }, icon('minus'));
  const oathInc = h('button', {
    class: 'gg-oath-step gg-cut', type: 'button', 'aria-label': t('lobby.oath.inc'), title: t('lobby.oath.inc'), 'data-testid': 'lobby-oath-inc', 'data-sfx': 'click',
    onClick: () => step(1),
  }, icon('plus'));
  const oathNum = h('b', { class: 'gg-oath-num' });
  const oathValue = h('div', { class: 'gg-oath-value gg-cut', 'data-testid': 'lobby-oath', 'data-level': '0', 'data-unlocked': '0', role: 'status' }, icon('bell'), oathNum);
  const oathTrack = h('div', { class: 'gg-oath-track', 'aria-hidden': 'true' });
  const oathRow = h('div', { class: 'gg-oath-stepper', role: 'group', 'aria-label': t('oath.label') }, oathDec, oathValue, oathInc);
  const oathTitle = h('b', { class: 'gg-oath-name' });
  const oathDesc = h('span', { class: 'gg-oath-desc' });
  const oathExtra = h('span', { class: 'gg-oath-extra' });
  const oathNote = h('span', { class: 'gg-oath-note' }, t('lobby.oathHostOnly'));

  // ---- actions
  const readyLabel = h('span');
  const readyBtn = h('button', {
    class: 'gg-btn gg-cut gg-lobby-ready', type: 'button', 'data-testid': 'lobby-ready',
    onClick: () => bus.emit('ui:lobby', { ready: !(selfRoster()?.ready ?? false) }),
  }, icon('check'), readyLabel);
  const startBtn = h('button', {
    class: 'gg-btn gg-cut gg-btn--primary gg-lobby-start', type: 'button', 'data-testid': 'lobby-start',
    onClick: () => { if (isHost() && startInfo().can) bus.emit('ui:start'); },
  }, icon('bell'), t('lobby.start'));
  const reason = h('p', { class: 'gg-lobby-reason', role: 'status' });
  const leaveBtn = h('button', {
    class: 'gg-btn gg-cut gg-btn--ghost', type: 'button', 'data-testid': 'lobby-leave', onClick: () => openModal('leave'),
  }, icon('exit'), t('common.leave'));

  const el = h('section', { class: 'gg-screen gg-lobby gg-backdrop' },
    motes(),
    h('div', { class: 'gg-lobby-layout' },
      h('header', { class: 'gg-lobby-head' },
        h('div', null,
          h('h2', { class: 'gg-section-title' }, t('lobby.title')),
          h('div', { class: 'gg-label' }, t('lobby.code')),
          code,
        ),
        h('div', { class: 'gg-lobby-copy' }, copyCodeBtn, copyLinkBtn),
      ),
      slots,
      h('div', { class: 'gg-lobby-foot' },
        h('div', { class: 'gg-lobby-panel gg-cut' },
          h('div', { class: 'gg-label' }, t('lobby.yourClass')),
          classRow,
          loadoutRow,
        ),
        h('div', { class: 'gg-lobby-panel gg-cut gg-lobby-oath' },
          h('div', { class: 'gg-label' }, t('oath.label'), oathNote),
          h('div', { class: 'gg-oath-body' }, h('div', { class: 'gg-oath-pick' }, oathRow, oathTrack), h('div', { class: 'gg-oath-text' }, oathTitle, oathDesc, oathExtra)),
        ),
        h('div', { class: 'gg-lobby-actions' },
          reason,
          h('div', { class: 'gg-lobby-buttons' }, leaveBtn, readyBtn, startBtn),
        ),
      ),
    ),
  );

  let trackKey = '';
  function syncOath(): void {
    const host = isHost();
    const unlocked = Math.min(MAX_OATH, Math.max(0, state.profile.oathUnlocked));
    const level = Math.min(MAX_OATH, Math.max(0, state.oath));
    setText(oathNum, roman(level));
    setAttr(oathValue, 'data-level', String(level));
    setAttr(oathValue, 'data-unlocked', String(unlocked));
    oathDec.disabled = !host || level <= 0;
    oathInc.disabled = !host || level >= unlocked;
    show(oathDec, host);
    show(oathInc, host);
    // The whole ladder as ticks: sworn levels lit, unlocked ones outlined, the rest dark.
    const k = `${level}|${unlocked}|${host}`;
    if (k !== trackKey) {
      trackKey = k;
      oathTrack.replaceChildren();
      for (let i = 1; i <= MAX_OATH; i++) {
        oathTrack.append(h('i', { class: `${i <= level ? 'is-on' : ''}${host && i > unlocked ? ' is-locked' : ''}${i === RUN.DEPTH.AFFIX_FROM_OATH ? ' is-mark' : ''}` }));
      }
    }
    setText(oathTitle, oathName(level));
    setText(oathDesc, oathDescription(level));
    const bonus = Math.round(REWARDS.OATH_BONUS * level * PERCENT);
    const parts: string[] = [];
    if (bonus > 0) parts.push(t('lobby.oath.reward', { n: bonus }));
    if (level >= RUN.DEPTH.AFFIX_FROM_OATH) parts.push(t('lobby.oath.affix'));
    if (host && level >= unlocked && unlocked < MAX_OATH) parts.push(t('lobby.oath.next', { n: roman(unlocked) }));
    else if (host) parts.push(t('lobby.oath.unlocked', { n: roman(unlocked) }));
    setText(oathExtra, parts.join(' · '));
    show(oathNote, !host);
  }

  const sync = (): void => {
    const me = selfRoster();
    const host = isHost();
    setText(code, state.conn.code);
    copyCodeBtn.dataset.copy = state.conn.code;
    copyLinkBtn.dataset.copy = inviteLink(state.conn.code);
    renderSlots();
    for (const [cls, btn] of classButtons) {
      const on = me?.cls === cls;
      toggle(btn, 'is-selected', on);
      btn.setAttribute('aria-checked', String(on));
    }
    syncOath();
    setText(walletText, state.profile.glimmer > 0 ? formatInt(state.profile.glimmer) : '');
    show(walletText, state.profile.glimmer > 0);
    const pending = pendingCount();
    setText(armoryBadge, pending > 0 ? String(pending) : '');
    show(armoryBadge, pending > 0);
    const ready = me?.ready ?? false;
    toggle(readyBtn, 'is-on', ready);
    readyBtn.setAttribute('aria-pressed', String(ready));
    setText(readyLabel, ready ? t('lobby.ready') : t('lobby.readyUp'));
    const info = startInfo();
    show(startBtn, host);
    startBtn.disabled = !info.can;
    setText(reason, host ? info.reason : t('lobby.waitingHost'));
    toggle(reason, 'is-go', host && info.can);
  };

  const primaryAction = (): void => {
    if (isHost() && startInfo().can) bus.emit('ui:start');
    else bus.emit('ui:lobby', { ready: !(selfRoster()?.ready ?? false) });
  };

  return { el, sync, primaryAction };
}
