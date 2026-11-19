/**
 * HUD pieces of update 5: the two keystone emblems next to the ability bar (with the build's name), their
 * live indicators and the "Keystone acquired" banner. Click-through like the rest of the HUD.
 *
 * Indicators follow the sim's client notes (reports/backend-update5.md):
 *  - Bloodrush: `keystoneProc { id: 'momentum_engine', n = stacks }` on every change, n = 0 at expiry;
 *  - Phase Walker / Veil of Knives: `buff { id: 'phase_walker' | 'ks_shade', dur }` opens the window;
 *  - Resonance Engine: `keystoneProc { id: 'resonance_engine', n = percent charged }` per Resonance;
 *  - Blood Price needs no event: the cost is a fraction of maximum health (drawn by hud.ts on the secondary).
 */
import { KEYSTONE_BY_ID, KEYSTONE_TUNING } from '@shared/data/keystones.ts';
import type { GameEvent, RosterEntry } from '@shared/types.ts';
import { settings } from '../core/Settings.ts';
import { state } from '../core/GameState.ts';
import { h, icon, retrigger, setAttr, setText, setVar, show, toggle } from './dom.ts';
import { t } from './i18n.ts';
import { buildInfo, heldKeystones, keystoneBody, keystoneCost, keystoneEmblem, keystoneName, transformInfo } from './keystones.ts';
import { UI_CONFIG } from './store.ts';

const MS = 1000;
const PERCENT = 100;
const BLOODRUSH = 'momentum_engine';
const ENGINE = 'resonance_engine';
/** Keystones whose `buff` event opens a short window, and the ability the window belongs to. */
export const WINDOW_KEYSTONES = ['phase_walker', 'ks_shade'] as const;
export type WindowKeystone = (typeof WINDOW_KEYSTONES)[number];
const isWindow = (id: string): id is WindowKeystone => (WINDOW_KEYSTONES as readonly string[]).includes(id);

interface Socket {
  el: HTMLElement;
  ind: HTMLElement;
  id: string;
}

export interface KeystoneHud {
  /** The emblems, to the left of the ability bar. */
  el: HTMLElement;
  banner: HTMLElement;
  /** Roster changed (keystone taken / replaced, boons). */
  sync(own: RosterEntry | null, training: boolean): void;
  /** HUD rate: stack timers and windows. */
  tick(): void;
  /** Own-hero events: `keystoneProc`, `buff`. */
  onEvent(ev: GameEvent): void;
  /** The own hero took a keystone: the big banner. */
  acquired(id: string, replaced: string | undefined, own: RosterEntry | null): void;
  /** True while the window of this keystone is open. */
  windowOpen(id: WindowKeystone): boolean;
  /** Percent of the ultimate one Resonance just charged (shown once, then 0). */
  takeEngineFeed(): number;
  reset(): void;
  dispose(): void;
}

export function createKeystoneHud(): KeystoneHud {
  const buildName = h('span', { class: 'gg-ks-hud-build' });
  const row = h('div', { class: 'gg-ks-hud-row' });
  const el = h('div', { class: 'gg-ks-hud', 'data-testid': 'hud-keystones', 'data-ids': '', 'data-build': '', 'aria-label': t('hud.keystones') }, buildName, row);
  const sockets: Socket[] = [];
  let shownKey: string | null = null;
  let known: string[] | null = null;

  // ---- banner
  const bannerEmblem = h('span', { class: 'gg-ks-banner-emblem' });
  const bannerName = h('b', { class: 'gg-ks-banner-name' });
  const bannerLine = h('span', { class: 'gg-ks-banner-line' });
  const bannerCost = h('span', { class: 'gg-ks-banner-cost' });
  const bannerBuild = h('em', { class: 'gg-ks-banner-build' });
  const banner = h('div', { class: 'gg-ks-banner', role: 'status', 'data-testid': 'keystone-banner', 'data-id': '' },
    h('i', { class: 'gg-ks-banner-burst' }),
    bannerEmblem,
    h('div', { class: 'gg-ks-banner-text' },
      h('span', { class: 'gg-ks-banner-label' }, icon('keystone'), t('toast.keystone')),
      bannerName, bannerLine, bannerCost, bannerBuild,
    ),
  );
  let bannerTimer = 0;
  const newTimers: number[] = [];

  // ---- live state
  let stacks = 0;
  let stacksStart = 0;
  let stacksEnd = 0;
  const windows = new Map<WindowKeystone, number>();
  let engineFeed = 0;

  const socketOf = (id: string): Socket | undefined => sockets.find((s) => s.id === id);

  const sync = (own: RosterEntry | null, training: boolean): void => {
    const held = heldKeystones(own);
    const info = buildInfo(own);
    const key = `${held.join(',')}|${info.short}|${training}|${own?.cls}`;
    if (key === shownKey) return;
    shownKey = key;
    show(el, !training);
    setAttr(el, 'data-ids', held.join(','));
    setAttr(el, 'data-build', info.name);
    setAttr(el, 'data-count', String(held.length));
    // With one keystone the emblem already says it; the name of the build appears with the second.
    setText(buildName, held.length >= KEYSTONE_TUNING.MAX_HELD ? info.short : held.length === 1 ? keystoneName(held[0]) : '');
    el.title = info.name;
    row.replaceChildren();
    sockets.length = 0;
    for (let slot = 0; slot < KEYSTONE_TUNING.MAX_HELD; slot++) {
      const id = held[slot];
      const ind = h('b', { class: 'gg-ks-hud-ind gg-num' });
      const socket = id
        ? h('div', { class: 'gg-ks-hud-socket', 'data-id': id, title: `${keystoneName(id)} — ${keystoneBody(id)}` }, keystoneEmblem(id, 'm'), ind, h('i', { class: 'gg-ks-hud-timer' }))
        : h('div', { class: 'gg-ks-hud-socket is-empty', 'data-id': '', title: `${t('hud.keystone.empty')} — ${t('hud.keystone.emptyHint')}` },
          h('span', { class: 'gg-ks-emblem gg-ks-emblem--m is-empty' }, h('i', { class: 'gg-ks-emblem-in' })), ind);
      // A keystone that was not there a moment ago glows (not on the first paint after a reload).
      if (id && known !== null && !known.includes(id)) {
        socket.classList.add('is-new');
        newTimers.push(window.setTimeout(() => socket.classList.remove('is-new'), UI_CONFIG.KEYSTONE_NEW_MS));
      }
      sockets.push({ el: socket, ind, id: id ?? '' });
      row.append(socket);
    }
    known = held;
    if (!held.includes(BLOODRUSH)) stacks = 0;
    tick();
  };

  function tick(): void {
    const now = performance.now();
    const rush = socketOf(BLOODRUSH);
    if (rush) {
      if (stacks > 0 && now >= stacksEnd) stacks = 0;
      const on = stacks > 0;
      toggle(rush.el, 'is-active', on);
      setText(rush.ind, on ? `×${stacks}` : '');
      setAttr(rush.el, 'data-stacks', String(stacks));
      if (on) {
        setVar(rush.el, '--left', String(Math.round(((stacksEnd - now) / Math.max(1, stacksEnd - stacksStart)) * PERCENT) / PERCENT));
        const perKill = KEYSTONE_BY_ID.get(BLOODRUSH)?.params.perKill ?? 0;
        rush.el.title = `${t('hud.ks.bloodrush', { n: stacks })} — ${t('hud.ks.bloodrushValue', { v: Math.round(stacks * perKill * PERCENT) })}`;
      }
    }
    for (const id of WINDOW_KEYSTONES) {
      const socket = socketOf(id);
      const end = windows.get(id) ?? 0;
      if (end > 0 && now >= end) windows.delete(id);
      if (socket) toggle(socket.el, 'is-active', now < end);
    }
  }

  const onEvent = (ev: GameEvent): void => {
    const own = state.conn.slot;
    if (ev.e === 'keystoneProc' && ev.slot === own) {
      if (ev.id === BLOODRUSH) {
        const next = Math.max(0, Math.floor(ev.n ?? 0));
        const seconds = KEYSTONE_BY_ID.get(BLOODRUSH)?.params.seconds ?? 0;
        const grew = next > stacks;
        stacks = next;
        stacksStart = performance.now();
        stacksEnd = stacksStart + seconds * MS;
        const socket = socketOf(BLOODRUSH);
        if (socket && grew) retrigger(socket.el, 'is-bump');
        tick();
      } else if (ev.id === ENGINE) {
        engineFeed = Math.max(0, Math.round(ev.n ?? (KEYSTONE_BY_ID.get(ENGINE)?.params.perResonance ?? 0)));
      }
    } else if (ev.e === 'buff' && ev.slot === own && isWindow(ev.id) && ev.dur > 0) {
      windows.set(ev.id, performance.now() + ev.dur * MS);
      tick();
    }
  };

  const acquired = (id: string, replaced: string | undefined, own: RosterEntry | null): void => {
    const cls = own?.cls ?? state.profile.cls;
    const info = transformInfo(id, cls, own?.art ?? 0);
    const cost = keystoneCost(id);
    bannerEmblem.replaceChildren(keystoneEmblem(id, 'l'));
    setText(bannerName, keystoneName(id));
    setText(bannerLine, info ? `${info.text} — ${info.ability}` : t('keystone.passive'));
    setText(bannerCost, cost !== '' ? `${t('keystone.cost')}: ${cost}` : '');
    show(bannerCost, cost !== '');
    // The roster may still show the build before the pick: name it from what the hero holds after it.
    const after = [...heldKeystones(own).filter((k) => k !== replaced && k !== id), id];
    const build = own ? buildInfo({ ...own, keystones: after }) : null;
    const text = build && after.length >= KEYSTONE_TUNING.MAX_HELD ? t('toast.keystone.build', { name: build.name })
      : replaced ? t('toast.keystone.replaced', { name: keystoneName(replaced) }) : '';
    setText(bannerBuild, text);
    show(bannerBuild, text !== '');
    setAttr(banner, 'data-id', id);
    // "Minimal" effects: the same information without the burst.
    toggle(banner, 'is-plain', settings.effects === 'minimal');
    setVar(banner, '--banner-ms', `${UI_CONFIG.KEYSTONE_BANNER_MS}ms`);
    retrigger(banner, 'is-on');
    window.clearTimeout(bannerTimer);
    bannerTimer = window.setTimeout(() => banner.classList.remove('is-on'), UI_CONFIG.KEYSTONE_BANNER_MS);
  };

  const clearTimers = (): void => {
    window.clearTimeout(bannerTimer);
    for (const timer of newTimers.splice(0)) window.clearTimeout(timer);
  };

  return {
    el, banner, sync, tick, onEvent, acquired,
    windowOpen: (id) => performance.now() < (windows.get(id) ?? 0),
    takeEngineFeed: () => { const v = engineFeed; engineFeed = 0; return v; },
    reset: () => {
      clearTimers();
      banner.classList.remove('is-on');
      stacks = 0;
      windows.clear();
      engineFeed = 0;
      known = null;
      shownKey = null;
    },
    dispose: clearTimers,
  };
}
