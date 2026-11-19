/**
 * HUD pieces added with update 3: the ultimate button with its charge ring, the timed buffs of the own hero
 * and the set-bonus chips. Like the rest of the HUD they are click-through and only read GameState.
 */
import { SETS, setProgress, type SetDef } from '@shared/data/boons.ts';
import { BUFFS } from '@shared/data/classes.ts';
import type { BoonStack, ClassId, PlayerSnap } from '@shared/types.ts';
import { h, icon, key, retrigger, setAttr, setText, setVar, show, toggle } from './dom.ts';
import type { IconName } from './icons.ts';
import { hasKey, roman, t, type Params } from './i18n.ts';
import { KEYSTONE_BY_ID } from '@shared/data/keystones.ts';
import { ABILITY_ICON } from './model.ts';
import { UI_CONFIG } from './store.ts';
import { setName, setTierText } from './text.ts';

const PERCENT = 100;
const MS = 1000;

// ------------------------------------------------------------------ ultimate

export interface UltimateView {
  el: HTMLElement;
  /** Class icon, element badge, charge and the ready state. */
  sync(me: PlayerSnap | null, cls: ClassId, element: string): void;
  /** The own hero used it. */
  fired(): void;
  /** Q was pressed without a full charge. */
  denied(): void;
  /** The server says the charge is full. */
  ready(): void;
}

export function createUltimate(): UltimateView {
  const iconBox = h('span', { class: 'gg-ult-icon' });
  const badge = h('span', { class: 'gg-ult-badge' });
  const state = h('span', { class: 'gg-ult-state gg-num' });
  const el = h('div', { class: 'gg-ult', 'data-testid': 'hud-ultimate', 'data-ready': 'false', 'data-charge': '0' },
    state,
    h('div', { class: 'gg-ult-ring' }, h('div', { class: 'gg-ult-core' }, iconBox), badge, h('i', { class: 'gg-ult-burst' })),
    key(t('hud.key.ultimate')),
  );
  let iconName: IconName | null = null;
  let shownElement: string | null = null;
  let wasReady = false;

  return {
    el,
    sync: (me, cls, element) => {
      const name = ABILITY_ICON[cls].ultimate;
      if (name !== iconName) {
        iconName = name;
        iconBox.replaceChildren(icon(name));
        el.title = `${t(`class.${cls}.ultimate.name`)} — ${t(`class.${cls}.ultimate.desc`)}`;
      }
      if (element !== shownElement) {
        shownElement = element;
        el.dataset.element = element;
        badge.replaceChildren(...(element !== '' ? [icon(element as IconName)] : []));
      }
      const charge = Math.min(1, Math.max(0, me?.ult ?? 0));
      const isReady = charge >= 1;
      const percent = Math.floor(charge * PERCENT);
      setVar(el, '--ult', String(Math.round(charge * 1000) / 1000));
      setAttr(el, 'data-charge', String(percent));
      setAttr(el, 'data-ready', String(isReady));
      toggle(el, 'is-ready', isReady);
      toggle(el, 'is-downed', me !== null && me.state !== 'alive');
      setText(state, isReady ? t('hud.ult.ready') : `${percent}%`);
      if (isReady && !wasReady) retrigger(el, 'is-charged');
      wasReady = isReady;
    },
    fired: () => {
      retrigger(el, 'is-fired');
      window.setTimeout(() => el.classList.remove('is-fired'), UI_CONFIG.PURCHASE_FLASH_MS);
    },
    denied: () => {
      retrigger(el, 'is-denied');
      window.setTimeout(() => el.classList.remove('is-denied'), UI_CONFIG.DENIED_FLASH_MS);
    },
    ready: () => retrigger(el, 'is-charged'),
  };
}

// ------------------------------------------------------------------ buffs

const BUFF_ICON: Record<string, IconName> = { bloodrage: 'rage', bulwark: 'banner', overload: 'overload', phase_walker: 'phase', ks_shade: 'smoke' };
/** Numbers quoted in the names of the keystone windows (update 5). */
const BUFF_PARAMS: Record<string, Params> = {
  ks_shade: { v: Math.round((KEYSTONE_BY_ID.get('ks_shade')?.params.damage ?? 0) * PERCENT) },
};

interface BuffChip {
  el: HTMLElement;
  time: HTMLElement;
  start: number;
  end: number;
  shown: number;
}

export interface BuffsView {
  el: HTMLElement;
  /** A timed effect started on the own hero. Restarts the chip when it is already running. */
  add(id: string, seconds: number): void;
  /** Called at HUD rate: counts the timers down and drops expired chips. */
  tick(): void;
  reset(): void;
}

export function createBuffs(): BuffsView {
  const el = h('div', { class: 'gg-buffs', 'data-testid': 'hud-buffs', 'aria-live': 'off' });
  const chips = new Map<string, BuffChip>();

  const drop = (id: string): void => {
    chips.get(id)?.el.remove();
    chips.delete(id);
  };

  return {
    el,
    add: (id, seconds) => {
      if (!(seconds > 0)) return;
      drop(id);
      const nameKey = `buff.${id}.name`;
      const name = hasKey(nameKey) ? t(nameKey, BUFF_PARAMS[id]) : id;
      const time = h('b', { class: 'gg-num' });
      const chip = h('div', { class: `gg-buff${id in BUFF_PARAMS || id === 'phase_walker' ? ' is-keystone' : ''}`, 'data-buff': id, title: name },
        h('span', { class: 'gg-buff-icon' }, icon(BUFF_ICON[id] ?? (id in BUFFS ? 'ultimate' : 'star'))),
        h('span', { class: 'gg-buff-name' }, name),
        time,
        h('i', { class: 'gg-buff-bar' }),
      );
      const now = performance.now();
      const shown = Math.ceil(seconds);
      time.textContent = `${shown} s`;
      chips.set(id, { el: chip, time, start: now, end: now + seconds * MS, shown });
      el.append(chip);
    },
    tick: () => {
      if (chips.size === 0) return;
      const now = performance.now();
      for (const [id, chip] of chips) {
        const left = chip.end - now;
        if (left <= 0) { drop(id); continue; }
        const seconds = Math.ceil(left / MS);
        if (seconds !== chip.shown) { chip.shown = seconds; chip.time.textContent = `${seconds} s`; }
        setVar(chip.el, '--w', `${Math.round((left / (chip.end - chip.start)) * 1000) / 10}%`);
        toggle(chip.el, 'is-ending', seconds <= 2);
      }
    },
    reset: () => { for (const id of [...chips.keys()]) drop(id); },
  };
}

// ------------------------------------------------------------------ set bonuses

export const setIcon = (def: SetDef): IconName => def.element ?? def.category ?? 'boon';

export function setTint(def: SetDef): string {
  if (def.element) return `var(--gg-${def.element})`;
  if (def.category === 'resonance') return 'var(--gg-glimmer)';
  if (def.category === 'kinship' || def.category === 'ultimate') return 'var(--gg-gold)';
  return 'var(--gg-text)';
}

/** Pips of a set: one per boon needed for tier 2, with a notch where tier 1 switches on. */
export function setPips(def: SetDef, count: number, preview = 0): HTMLElement {
  const pips = h('span', { class: 'gg-set-pips', 'aria-hidden': 'true' });
  for (let i = 0; i < def.need[1]; i++) {
    pips.append(h('i', { class: `${i < count ? 'is-on' : i < count + preview ? 'is-preview' : ''}${i === def.need[0] - 1 ? ' is-tier' : ''}` }));
  }
  return pips;
}

export interface SetsView {
  el: HTMLElement;
  sync(boons: readonly BoonStack[]): void;
  /** A tier of a set just switched on for the own hero. */
  flash(id: string): void;
}

export function createSets(): SetsView {
  const list = h('ul', { class: 'gg-sets-list' });
  const el = h('div', { class: 'gg-sets', 'data-testid': 'hud-sets', 'data-active': '0', 'aria-label': t('hud.sets') },
    h('div', { class: 'gg-sets-label' }, t('hud.sets')), list);
  let shownKey: string | null = null;

  return {
    el,
    sync: (boons) => {
      const progress = setProgress(boons).filter((p) => p.count > 0);
      const k = progress.map((p) => `${p.set.id}:${p.count}`).join('|');
      if (k === shownKey) return;
      shownKey = k;
      // Active sets first, then the ones closest to their next tier.
      const missing = (p: (typeof progress)[number]): number => (p.tier >= 2 ? 0 : p.set.need[p.tier] - p.count);
      progress.sort((a, b) => b.tier - a.tier || missing(a) - missing(b) || SETS.indexOf(a.set) - SETS.indexOf(b.set));
      list.replaceChildren();
      const shown = progress.slice(0, UI_CONFIG.SET_CHIPS_MAX);
      for (const p of shown) {
        const need = p.tier >= 2 ? p.set.need[1] : p.set.need[p.tier];
        const chip = h('li', {
          class: `gg-set-chip${p.tier > 0 ? ' is-active' : ''}${p.tier >= 2 ? ' is-full' : ''}`, 'data-set': p.set.id, 'data-tier': String(p.tier),
          title: p.tier > 0 ? setTierText(p.set, p.tier) : setTierText(p.set, 1),
        },
          h('span', { class: 'gg-set-chip-icon' }, icon(setIcon(p.set))),
          h('span', { class: 'gg-set-chip-name' }, setName(p.set)),
          p.tier > 0 ? h('b', { class: 'gg-set-chip-tier' }, roman(p.tier)) : null,
          setPips(p.set, p.count),
          h('span', { class: 'gg-set-chip-count gg-num' }, `${Math.min(p.count, need)}/${need}`),
        );
        chip.style.setProperty('--tint', setTint(p.set));
        list.append(chip);
      }
      if (progress.length > shown.length) list.append(h('li', { class: 'gg-set-more' }, t('hud.sets.more', { n: progress.length - shown.length })));
      setAttr(el, 'data-active', String(progress.filter((p) => p.tier > 0).length));
      show(el, progress.length > 0);
    },
    flash: (id) => {
      const chip = list.querySelector<HTMLElement>(`[data-set="${id}"]`);
      if (chip) retrigger(chip, 'is-new');
    },
  };
}
