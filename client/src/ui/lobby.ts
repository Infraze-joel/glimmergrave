/** Lobby: room code + invite, four player slots, class switcher, ready, oath (host), start (host). */
import { NET } from '@shared/constants.ts';
import { CLASS_IDS, type ClassId } from '@shared/types.ts';
import { bus } from '../core/EventBus.ts';
import { isHost, saveProfile, selfRoster, state } from '../core/GameState.ts';
import { copyText, h, icon, setText, show, toggle } from './dom.ts';
import { formatList, roman, t } from './i18n.ts';
import { inviteLink, MAX_OATH, oathDescription, oathName, rosterBySlot } from './model.ts';
import { UI_CONFIG, type ModalKind } from './store.ts';
import type { View } from './view.ts';
import { motes } from './menu.ts';

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

export function createLobby(openModal: (kind: ModalKind) => void): LobbyView {
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
    const key = JSON.stringify([state.conn.slot, state.roster.map((p) => [p.slot, p.name, p.cls, p.ready, p.connected, p.host])]);
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
      slots.append(h('div', {
        class: `gg-slot gg-cut gg-cls-${p.cls}${own ? ' is-own' : ''}${p.ready && p.connected ? ' is-ready' : ''}${p.connected ? '' : ' is-off'}`,
        'data-testid': `lobby-slot-${slot}`, 'data-ready': String(p.ready), 'data-connected': String(p.connected),
      },
        p.host ? h('span', { class: 'gg-slot-host', title: t('lobby.host') }, icon('boss'), t('lobby.host')) : null,
        own ? h('span', { class: 'gg-slot-you' }, t('common.you')) : null,
        h('span', { class: 'gg-slot-emblem' }, icon(p.cls)),
        h('div', { class: 'gg-slot-name' }, p.name),
        h('div', { class: 'gg-slot-class' }, t(`class.${p.cls}.name`)),
        status,
      ));
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

  // ---- oath
  const oathButtons: HTMLButtonElement[] = [];
  const oathRow = h('div', { class: 'gg-oath-row', role: 'radiogroup', 'aria-label': t('oath.label') });
  for (let level = 0; level <= MAX_OATH; level++) {
    const btn = h('button', {
      class: 'gg-oath-btn gg-cut', type: 'button', role: 'radio', 'data-testid': `lobby-oath-${level}`,
      onClick: () => { if (isHost() && level <= state.profile.oathUnlocked) bus.emit('ui:lobby', { oath: level }); },
      onMouseenter: () => { hoverOath = level; syncOath(); },
      onMouseleave: () => { hoverOath = null; syncOath(); },
      onFocus: () => { hoverOath = level; syncOath(); },
      onBlur: () => { hoverOath = null; syncOath(); },
    }, h('span', { class: 'gg-oath-num' }, roman(level)), icon('lock', 'gg-oath-lock'));
    oathButtons.push(btn);
    oathRow.append(btn);
  }
  let hoverOath: number | null = null;
  const oathTitle = h('b', { class: 'gg-oath-name' });
  const oathDesc = h('span', { class: 'gg-oath-desc' });
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
        ),
        h('div', { class: 'gg-lobby-panel gg-cut gg-lobby-oath' },
          h('div', { class: 'gg-label' }, t('oath.label'), oathNote),
          h('div', { class: 'gg-oath-body' }, oathRow, h('div', { class: 'gg-oath-text' }, oathTitle, oathDesc)),
        ),
        h('div', { class: 'gg-lobby-actions' },
          reason,
          h('div', { class: 'gg-lobby-buttons' }, leaveBtn, readyBtn, startBtn),
        ),
      ),
    ),
  );

  function syncOath(): void {
    const host = isHost();
    const unlocked = state.profile.oathUnlocked;
    oathButtons.forEach((btn, level) => {
      const locked = host && level > unlocked;
      toggle(btn, 'is-selected', state.oath === level);
      toggle(btn, 'is-locked', locked);
      btn.setAttribute('aria-checked', String(state.oath === level));
      btn.disabled = !host;
      btn.setAttribute('aria-disabled', String(!host || locked));
    });
    const shown = host && hoverOath !== null ? hoverOath : state.oath;
    setText(oathTitle, oathName(shown));
    setText(oathDesc, host && shown > unlocked ? t('oath.locked', { n: roman(shown - 1) }) : oathDescription(shown));
    toggle(oathDesc, 'is-locked', host && shown > unlocked);
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
