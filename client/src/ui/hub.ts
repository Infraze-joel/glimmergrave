/**
 * The progression hub (page kind 'armory'): everything permanent in one place. Tabs: Armory (upgrades),
 * Ascension (endless ranks), Mastery (class levels, art, talents), Reliquary (relics) and Chronicle (feats).
 * The strip under the tabs always names the next things worth doing, so there is never a dead end.
 */
import { wardenRank } from '@shared/data/feats.ts';
import { ascensionUnlocked, state, totalXp } from '../core/GameState.ts';
import { createArmoryTab } from './armory.ts';
import { createAscension } from './ascension.ts';
import { createChronicle } from './chronicle.ts';
import { h, icon, retrigger, setAttr, setText, show } from './dom.ts';
import type { IconName } from './icons.ts';
import { formatInt, t } from './i18n.ts';
import { createMastery } from './mastery.ts';
import { pageHead } from './pages.ts';
import { claimableGlimmer, nextGoals, openChoices, type Goal } from './progress.ts';
import { createReliquary } from './reliquary.ts';
import { HUB_TABS, ui, type HubTab } from './store.ts';
import type { View } from './view.ts';

const TAB_ICON: Record<HubTab, IconName> = {
  armory: 'armory', ascension: 'ascension', mastery: 'mastery', reliquary: 'relic', chronicle: 'chronicle',
};
const GOALS_SHOWN = 4;

export function createHub(close: () => void): View {
  const walletValue = h('b', { class: 'gg-num' });
  const wallet = h('div', { class: 'gg-wallet', 'data-testid': 'armory-wallet', 'data-glimmer': '0' },
    icon('glimmer'),
    h('div', null, h('span', null, t('armory.wallet')), walletValue),
  );
  const rank = h('div', { class: 'gg-hub-rank', 'data-testid': 'hub-warden-rank', 'data-rank': '1' });
  let lastGlimmer = -1;

  const panes: Record<HubTab, View> = {
    armory: createArmoryTab(),
    ascension: createAscension(),
    mastery: createMastery(),
    reliquary: createReliquary(),
    chronicle: createChronicle(),
  };

  const body = h('div', { class: 'gg-hub-body', tabindex: 0 });
  const buttons = new Map<HubTab, { btn: HTMLButtonElement; badge: HTMLElement }>();
  const tabs = h('nav', { class: 'gg-codex-tabs gg-hub-tabs', role: 'tablist', 'aria-label': t('hub.title') });
  let shown: HubTab | null = null;

  const select = (tab: HubTab): void => {
    ui.hubTab = tab;
    sync();
  };

  for (const tab of HUB_TABS) {
    const badge = h('i', { class: 'gg-tab-badge gg-num' });
    const btn = h('button', {
      class: 'gg-codex-tab gg-hub-tab', type: 'button', role: 'tab', 'data-testid': `hub-tab-${tab}`, 'data-sfx': 'tab',
      onClick: () => select(tab),
    }, icon(TAB_ICON[tab]), h('span', null, t(`hub.tab.${tab}`)), badge);
    buttons.set(tab, { btn, badge });
    tabs.append(btn);
  }

  const goalList = h('ul', { class: 'gg-hub-goals' });
  const goals = h('div', { class: 'gg-hub-next', 'data-testid': 'hub-next' }, h('span', { class: 'gg-hub-next-label' }, icon('chevron'), t('hub.next')), goalList);
  let goalsKey = '';

  const follow = (goal: Goal): void => {
    if (goal.cls) ui.hubCls = goal.cls;
    if (goal.relic) ui.hubRelic = goal.relic;
    select(goal.tab);
  };

  const renderGoals = (): void => {
    const list = nextGoals(GOALS_SHOWN);
    const k = list.map((g) => `${g.id}:${g.text}`).join('|');
    if (k === goalsKey) return;
    goalsKey = k;
    goalList.replaceChildren();
    for (const goal of list) {
      goalList.append(h('li', null, h('button', {
        class: `gg-hub-goal${goal.now ? ' is-now' : ''}`, type: 'button', 'data-testid': `hub-goal-${goal.id}`, 'data-tab': goal.tab, 'data-sfx': 'tab',
        onClick: () => follow(goal),
      }, icon(goal.icon), h('span', null, goal.text))));
    }
    if (list.length === 0) goalList.append(h('li', { class: 'gg-hub-goal-none' }, t('hub.goal.none')));
  };

  const el = h('section', { class: 'gg-page gg-armory gg-hub gg-backdrop', 'data-testid': 'armory-root', 'data-tab': 'armory' },
    h('div', { class: 'gg-page-layout' },
      pageHead({ icon: 'armory', title: t('hub.title'), sub: t('hub.sub'), extra: h('div', { class: 'gg-hub-head-extra' }, rank, wallet), close }),
      tabs,
      goals,
      body,
    ),
  );

  function sync(): void {
    const tab: HubTab = HUB_TABS.includes(ui.hubTab) ? ui.hubTab : 'armory';
    const glimmer = Math.max(0, Math.floor(state.profile.glimmer));
    setText(walletValue, formatInt(glimmer));
    setAttr(wallet, 'data-glimmer', String(glimmer));
    if (lastGlimmer >= 0 && glimmer !== lastGlimmer) retrigger(wallet, glimmer < lastGlimmer ? 'is-spent' : 'is-gained');
    lastGlimmer = glimmer;
    const warden = wardenRank(totalXp());
    setAttr(rank, 'data-rank', String(warden));
    rank.replaceChildren(icon('crown'), h('span', null, t('menu.rank')), h('b', { class: 'gg-num' }, formatInt(warden)));

    const claim = claimableGlimmer().tiers;
    const choices = openChoices().length;
    const counts: Record<HubTab, number> = { armory: 0, ascension: 0, mastery: choices, reliquary: 0, chronicle: claim };
    for (const [id, { btn, badge }] of buttons) {
      btn.classList.toggle('is-selected', id === tab);
      btn.setAttribute('aria-selected', String(id === tab));
      btn.classList.toggle('is-locked', id === 'ascension' && !ascensionUnlocked());
      setText(badge, counts[id] > 0 ? String(counts[id]) : '');
      show(badge, counts[id] > 0);
      setAttr(btn, 'data-badge', String(counts[id]));
    }
    if (shown !== tab) {
      shown = tab;
      setAttr(el, 'data-tab', tab);
      body.replaceChildren(panes[tab].el);
      body.scrollTop = 0;
    }
    panes[tab].sync();
    // After the pane: looking at a class's art choice clears its badge, which changes the goals.
    renderGoals();
  }

  return { el, sync, dispose: () => { for (const pane of Object.values(panes)) pane.dispose?.(); } };
}
