/**
 * Wardrobe: cloth colour, helmet / hat, cape and one of three gear styles per class (purely cosmetic).
 * The left half of the screen stays transparent: the 3D view presents the hero there ('ui:showcase').
 * Every change goes through core `setLook`, which also resends the loadout while in a lobby.
 */
import { LOOK } from '@shared/data/meta.ts';
import { CLASS_IDS, type ClassId } from '@shared/types.ts';
import { selfRoster, setLook, state } from '../core/GameState.ts';
import { h, icon, setAttr, setText, show, toggle } from './dom.ts';
import { t, type I18nKey } from './i18n.ts';
import { pageHead } from './pages.ts';
import { ui } from './store.ts';
import type { View } from './view.ts';

const HEX_DIGITS = 6;

export function lookColor(index: number): string | null {
  const value = LOOK.COLORS[index];
  return index > 0 && value !== undefined ? `#${value.toString(16).padStart(HEX_DIGITS, '0')}` : null;
}

/** Class whose look is being edited: the lobby locks it to the own hero, the menu follows the picker. */
export function wardrobeClass(): ClassId {
  if (state.screen === 'lobby') return selfRoster()?.cls ?? state.profile.cls;
  return ui.wardrobeCls ?? state.profile.cls;
}

export interface WardrobeView extends View {
  /** Element whose horizontal centre is where the 3D hero should stand. */
  stage: HTMLElement;
}

export function createWardrobe(close: () => void, changed: () => void): WardrobeView {
  // ---- class tabs (main menu only)
  const tabs = h('div', { class: 'gg-wardrobe-classes', role: 'tablist', 'aria-label': t('menu.class') });
  const tabButtons = new Map<ClassId, HTMLButtonElement>();
  for (const cls of CLASS_IDS) {
    const btn = h('button', {
      class: `gg-class-chip gg-cut gg-cls-${cls}`, type: 'button', role: 'tab', 'data-sfx': 'tab', 'data-testid': `wardrobe-class-${cls}`,
      onClick: () => { ui.wardrobeCls = cls; changed(); },
    }, icon(cls), h('span', null, t(`class.${cls}.name`)));
    tabButtons.set(cls, btn);
    tabs.append(btn);
  }

  // ---- colours
  const swatches: HTMLButtonElement[] = [];
  const swatchRow = h('div', { class: 'gg-swatches', role: 'radiogroup', 'aria-label': t('wardrobe.color') });
  LOOK.COLORS.forEach((_value, index) => {
    const name = t(`wardrobe.color.${index}` as I18nKey);
    const btn = h('button', {
      class: `gg-swatch${index === 0 ? ' gg-swatch--original' : ''}`, type: 'button', role: 'radio', title: name, 'aria-label': name,
      'data-testid': `wardrobe-color-${index}`, 'data-sfx': 'equip',
      onClick: () => setLook(wardrobeClass(), { color: index }),
    }, icon('check'));
    const hex = lookColor(index);
    if (hex) btn.style.setProperty('--swatch', hex);
    swatches.push(btn);
    swatchRow.append(btn);
  });
  const colorName = h('span', { class: 'gg-wardrobe-value' });

  // ---- gear style
  const styles: { btn: HTMLButtonElement; label: HTMLElement }[] = [];
  const styleRow = h('div', { class: 'gg-styles', role: 'radiogroup', 'aria-label': t('wardrobe.gear') });
  for (let index = 0; index < LOOK.STYLES; index++) {
    const label = h('span');
    const btn = h('button', {
      class: 'gg-style gg-cut', type: 'button', role: 'radio', 'data-testid': `wardrobe-style-${index}`, 'data-sfx': 'equip',
      onClick: () => setLook(wardrobeClass(), { style: index }),
    }, h('b', { class: 'gg-style-num gg-num' }, String(index + 1)), label, icon('check', 'gg-style-check'));
    styles.push({ btn, label });
    styleRow.append(btn);
  }

  // ---- extras
  const headLabel = h('span', { class: 'gg-set-label' });
  const headSwitch = h('button', {
    class: 'gg-switch', type: 'button', role: 'switch', 'data-testid': 'wardrobe-head', 'data-sfx': 'toggle',
    onClick: () => { const cls = wardrobeClass(); setLook(cls, { head: !state.profile.looks[cls].head }); },
  });
  const capeSwitch = h('button', {
    class: 'gg-switch', type: 'button', role: 'switch', 'aria-label': t('wardrobe.cape'), 'data-testid': 'wardrobe-cape', 'data-sfx': 'toggle',
    onClick: () => { const cls = wardrobeClass(); setLook(cls, { cape: !state.profile.looks[cls].cape }); },
  });

  const randomise = (): void => {
    const cls = wardrobeClass();
    const current = state.profile.looks[cls];
    const pick = (count: number): number => Math.floor(Math.random() * count);
    let color = pick(LOOK.COLORS.length);
    if (color === current.color) color = (color + 1) % LOOK.COLORS.length; // always a visible change
    setLook(cls, { color, style: pick(LOOK.STYLES), head: Math.random() < 0.75, cape: Math.random() < 0.6 });
  };

  const stageName = h('div', { class: 'gg-wardrobe-name' });
  const stageRole = h('div', { class: 'gg-wardrobe-role' });
  const stage = h('div', { class: 'gg-wardrobe-stage', 'data-testid': 'wardrobe-stage' },
    h('div', { class: 'gg-wardrobe-plate' }, stageName, stageRole),
  );

  const group = (label: string, value: HTMLElement | null, ...children: HTMLElement[]): HTMLElement =>
    h('div', { class: 'gg-wardrobe-group' }, h('div', { class: 'gg-label' }, label, value), ...children);

  const panel = h('div', { class: 'gg-wardrobe-panel' },
    pageHead({ icon: 'wardrobe', title: t('wardrobe.title'), sub: t('wardrobe.sub'), close }),
    tabs,
    group(t('wardrobe.color'), colorName, swatchRow),
    group(t('wardrobe.gear'), null, styleRow),
    group(t('wardrobe.extras'), null,
      h('div', { class: 'gg-wardrobe-toggles' },
        h('label', { class: 'gg-set-row gg-set-row--inline' }, headLabel, headSwitch),
        h('label', { class: 'gg-set-row gg-set-row--inline' }, h('span', { class: 'gg-set-label' }, t('wardrobe.cape')), capeSwitch),
      ),
    ),
    h('div', { class: 'gg-wardrobe-actions' },
      h('button', {
        class: 'gg-btn gg-cut', type: 'button', 'data-testid': 'wardrobe-random', 'data-sfx': 'equip', onClick: randomise,
      }, icon('shuffle'), t('wardrobe.random')),
    ),
  );

  const el = h('section', { class: 'gg-page gg-wardrobe', 'data-testid': 'wardrobe-root', 'data-cls': '' }, stage, panel);

  const sync = (): void => {
    const cls = wardrobeClass();
    const look = state.profile.looks[cls];
    setAttr(el, 'data-cls', cls);
    el.className = `gg-page gg-wardrobe gg-cls-${cls}`;
    setAttr(el, 'data-color', String(look.color));
    setAttr(el, 'data-style', String(look.style));
    const tint = lookColor(look.color);
    if (tint) el.style.setProperty('--look', tint);
    else el.style.removeProperty('--look');
    show(tabs, state.screen !== 'lobby');
    for (const [id, btn] of tabButtons) {
      toggle(btn, 'is-selected', id === cls);
      btn.setAttribute('aria-selected', String(id === cls));
    }
    swatches.forEach((btn, index) => {
      toggle(btn, 'is-selected', look.color === index);
      btn.setAttribute('aria-checked', String(look.color === index));
    });
    setText(colorName, t(`wardrobe.color.${look.color}` as I18nKey));
    styles.forEach(({ btn, label }, index) => {
      setText(label, t(`look.${cls}.style.${index}` as I18nKey));
      toggle(btn, 'is-selected', look.style === index);
      btn.setAttribute('aria-checked', String(look.style === index));
    });
    setText(headLabel, t(`wardrobe.head.${cls}`));
    headSwitch.setAttribute('aria-label', t(`wardrobe.head.${cls}`));
    headSwitch.setAttribute('aria-checked', String(look.head));
    capeSwitch.setAttribute('aria-checked', String(look.cape));
    setText(stageName, t(`class.${cls}.name`));
    setText(stageRole, t(`look.${cls}.style.${look.style}` as I18nKey));
  };

  return { el, sync, stage };
}
