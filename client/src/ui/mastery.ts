/**
 * Mastery tab: one class at a time. Level and experience, the permanent bonus of the level, the choice between
 * the standard secondary and the art (from MASTERY.ART_LEVEL), and three talent tiers with two options each.
 * Choices go through core `setArt` / `setTalent`, which also resend the loadout while in a lobby.
 */
import { CLASSES } from '@shared/data/classes.ts';
import { MASTERY, TALENT_TIERS, XP_REWARDS, masteryMods, talentOf } from '@shared/data/mastery.ts';
import { CLASS_IDS, type ClassId } from '@shared/types.ts';
import { artOf, classProgress, saveProfile, selfRoster, setArt, setTalent, state, talentsOf } from '../core/GameState.ts';
import { bus } from '../core/EventBus.ts';
import { h, icon, setAttr } from './dom.ts';
import { formatInt, roman, t } from './i18n.ts';
import { ABILITY_ICON, ART_ICON, CLASS_DIFFICULTY, abilityDesc, abilityName, artDesc, artName } from './model.ts';
import { setMark } from './prefs.ts';
import { artMark, openChoices } from './progress.ts';
import { ui } from './store.ts';
import { modText, talentBody, talentName } from './text.ts';
import type { View } from './view.ts';

/** Level badge + thin experience bar, used wherever a class's mastery is summarised. */
export function masteryMeter(cls: ClassId, compact = false): HTMLElement {
  const p = classProgress(cls);
  const fill = h('i');
  fill.style.setProperty('--w', `${Math.round((p.into / Math.max(1, p.need)) * 1000) / 10}%`);
  return h('span', {
    class: `gg-mastery-meter${compact ? ' is-compact' : ''}`, 'data-level': String(p.level),
    title: `${t('mastery.level')} ${p.level} · ${t('mastery.xp', { into: formatInt(p.into), need: formatInt(p.need) })}`,
  }, h('b', { class: 'gg-num' }, t('common.lv', { n: p.level })), h('span', { class: 'gg-mastery-bar' }, fill));
}

export function createMastery(): View {
  const classList = h('div', { class: 'gg-mastery-classes', role: 'tablist', 'aria-label': t('menu.class') });
  const detail = h('div', { class: 'gg-mastery-detail' });
  const el = h('div', { class: 'gg-hub-pane gg-hub-mastery', 'data-testid': 'mastery-root', 'data-cls': '' },
    classList, detail);
  let key = '';

  const current = (): ClassId => ui.hubCls ?? selfRoster()?.cls ?? state.profile.cls;
  const pick = (cls: ClassId): void => { ui.hubCls = cls; sync(); };

  /** In a lobby the class is switched through the session; on the menu it is just the profile's class. */
  const playAs = (cls: ClassId): void => {
    saveProfile({ cls });
    if (state.screen === 'lobby') bus.emit('ui:lobby', { cls });
  };

  const option = (opts: {
    testid: string; selected: boolean; locked: boolean; iconName: Parameters<typeof icon>[0]; label: string; name: string; body: string; onPick: () => void;
  }): HTMLElement => h('button', {
    class: `gg-choice gg-cut${opts.selected ? ' is-selected' : ''}${opts.locked ? ' is-locked' : ''}`, type: 'button', role: 'radio',
    'aria-checked': String(opts.selected), 'data-testid': opts.testid, 'data-sfx': 'equip', disabled: opts.locked, onClick: opts.onPick,
  },
    h('span', { class: 'gg-choice-icon' }, icon(opts.locked ? 'lock' : opts.iconName)),
    h('span', { class: 'gg-choice-text' },
      h('span', { class: 'gg-choice-label' }, opts.label),
      h('b', null, opts.name),
      h('span', { class: 'gg-choice-body' }, opts.body),
    ),
    h('span', { class: 'gg-choice-check' }, icon('check'), t('mastery.active')),
  );

  function render(cls: ClassId): void {
    const p = classProgress(cls);
    const art = artOf(cls);
    const talents = talentsOf(cls);
    const playing = (selfRoster()?.cls ?? state.profile.cls) === cls;
    const bonus = modText(masteryMods(p.level));
    const perLevel = modText(MASTERY.PER_LEVEL);
    const fill = h('i', { class: 'gg-xp-fill' });
    fill.style.setProperty('--w', `${Math.round((p.into / Math.max(1, p.need)) * 1000) / 10}%`);

    const artUnlocked = p.level >= MASTERY.ART_LEVEL;
    const hasArtVariant = CLASSES[cls].arts.length > 0;
    const secondary = h('div', { class: 'gg-choice-row', role: 'radiogroup', 'aria-label': t('mastery.secondary') },
      option({
        testid: 'mastery-art-0', selected: art === 0, locked: false, iconName: ABILITY_ICON[cls].secondary, label: t('mastery.standard'),
        name: abilityName(cls, 'secondary'), body: abilityDesc(cls, 'secondary'), onPick: () => setArt(cls, 0),
      }),
      hasArtVariant ? option({
        testid: 'mastery-art-1', selected: art === 1, locked: !artUnlocked, iconName: ART_ICON[cls],
        label: artUnlocked ? t('mastery.art') : t('mastery.artLocked', { n: MASTERY.ART_LEVEL }),
        name: artName(cls), body: artDesc(cls), onPick: () => setArt(cls, 1),
      }) : null,
    );

    const tiers = h('div', { class: 'gg-talent-tiers' });
    for (let tier = 0; tier < TALENT_TIERS; tier++) {
      const need = MASTERY.TALENT_LEVELS[tier];
      const unlocked = p.level >= need;
      const row = h('div', { class: 'gg-choice-row', role: 'radiogroup', 'aria-label': t('mastery.tier', { n: roman(tier + 1) }) });
      for (const choice of [1, 2]) {
        const def = talentOf(cls, tier, choice);
        if (!def) continue;
        row.append(option({
          testid: `mastery-talent-${tier}-${choice}`, selected: talents[tier] === choice, locked: !unlocked, iconName: 'talent',
          label: unlocked ? t('mastery.tier', { n: roman(tier + 1) }) : t('mastery.tierLocked', { n: need }),
          name: talentName(def), body: talentBody(def),
          // Clicking the active talent again clears the tier.
          onPick: () => setTalent(cls, tier, talents[tier] === choice ? 0 : choice),
        }));
      }
      tiers.append(h('div', {
        class: `gg-talent-tier${unlocked ? '' : ' is-locked'}${unlocked && talents[tier] === 0 ? ' is-open' : ''}`, 'data-tier': String(tier),
        'data-unlocked': String(unlocked), 'data-choice': String(talents[tier]),
      },
        h('div', { class: 'gg-talent-tier-head' },
          h('b', null, roman(tier + 1)),
          h('span', null, unlocked ? (talents[tier] === 0 ? t('mastery.choose') : '') : t('common.lv', { n: need })),
        ),
        row,
      ));
    }

    detail.className = `gg-mastery-detail gg-cls-${cls}`;
    detail.replaceChildren(
      h('header', { class: 'gg-mastery-head gg-cut' },
        h('span', { class: 'gg-mastery-emblem' }, icon(cls)),
        h('div', { class: 'gg-mastery-id' },
          h('h3', null, t(`class.${cls}.name`)),
          h('p', null, t(`class.${cls}.role`), ' · ', t(`difficulty.${CLASS_DIFFICULTY[cls]}`)),
        ),
        h('div', { class: 'gg-mastery-level', 'data-testid': 'mastery-level', 'data-level': String(p.level) },
          h('span', null, t('mastery.level')), h('b', { class: 'gg-num' }, String(p.level))),
        h('div', { class: 'gg-mastery-xp' },
          h('div', { class: 'gg-xp-bar' }, fill),
          h('div', { class: 'gg-mastery-xp-text gg-num' },
            h('span', null, t('mastery.xp', { into: formatInt(p.into), need: formatInt(p.need) })),
            h('span', null, t('mastery.toNext', { n: formatInt(Math.max(0, p.need - p.into)), m: p.level + 1 })),
          ),
        ),
        h('div', { class: 'gg-mastery-bonus' },
          h('span', null, t('mastery.bonus')),
          h('b', null, bonus !== '' ? bonus : t('mastery.bonusNone')),
          h('em', null, t('mastery.perLevel', { bonus: perLevel }), ' ', p.level >= MASTERY.SOFT_LEVEL ? t('mastery.soft', { n: MASTERY.SOFT_LEVEL }) : ''),
        ),
        playing
          ? h('span', { class: 'gg-mastery-playing' }, icon('check'), t('mastery.playing'))
          : h('button', {
            class: 'gg-btn gg-cut gg-btn--small', type: 'button', 'data-testid': 'mastery-play', 'data-sfx': 'equip', onClick: () => playAs(cls),
          }, icon(cls), t('mastery.play', { cls: t(`class.${cls}.name`) })),
      ),
      h('section', { class: 'gg-mastery-section' },
        h('div', { class: 'gg-label' }, t('mastery.secondary'), h('span', { class: 'gg-label-note' }, t('mastery.hint'))),
        secondary,
      ),
      h('section', { class: 'gg-mastery-section' }, h('div', { class: 'gg-label' }, t('mastery.talents')), tiers),
      h('footer', { class: 'gg-page-foot' },
        h('p', null, icon('xp'), t('mastery.earn', {
          c: XP_REWARDS.PER_CHAMBER_CLEARED, e: XP_REWARDS.PER_ELITE_SLAIN, b: XP_REWARDS.BOSS_SLAIN, m: XP_REWARDS.MINIMUM,
        })),
        h('p', null, icon('boss'), t('mastery.wins', { n: formatInt(state.profile.classWins[cls] ?? 0) })),
      ),
    );
  }

  function sync(): void {
    const cls = current();
    // Looking at a class counts as having seen its art choice (the badge is about news, not about a debt).
    if (classProgress(cls).level >= MASTERY.ART_LEVEL) setMark(artMark(cls));
    const open = openChoices();
    const k = JSON.stringify([
      cls, state.profile.xp, state.profile.arts, state.profile.talents, state.profile.classWins, selfRoster()?.cls ?? state.profile.cls,
      open.map((o) => `${o.cls}${o.kind}${o.tier}`),
    ]);
    if (k === key) return;
    key = k;
    setAttr(el, 'data-cls', cls);
    classList.replaceChildren();
    for (const id of CLASS_IDS) {
      const p = classProgress(id);
      const fill = h('i');
      fill.style.setProperty('--w', `${Math.round((p.into / Math.max(1, p.need)) * 1000) / 10}%`);
      const news = open.filter((o) => o.cls === id).length;
      classList.append(h('button', {
        class: `gg-mastery-class gg-cut gg-cls-${id}${id === cls ? ' is-selected' : ''}`, type: 'button', role: 'tab', 'aria-selected': String(id === cls),
        'data-testid': `mastery-class-${id}`, 'data-level': String(p.level), 'data-news': String(news), 'data-sfx': 'tab', onClick: () => pick(id),
      },
        h('span', { class: 'gg-mastery-class-emblem' }, icon(id)),
        h('span', { class: 'gg-mastery-class-text' },
          h('b', null, t(`class.${id}.name`)),
          h('span', { class: 'gg-mastery-bar' }, fill),
        ),
        h('span', { class: 'gg-mastery-class-level gg-num' }, t('common.lv', { n: p.level })),
        news > 0 ? h('i', { class: 'gg-tab-badge gg-num' }, String(news)) : null,
      ));
    }
    render(cls);
  }

  return { el, sync };
}
