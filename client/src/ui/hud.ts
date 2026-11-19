/**
 * In-game HUD. The whole layer is pointer-events:none and never captures keys; it only reads GameState.
 * Static structure is built once, the ~15 Hz `syncHud` only touches text / custom properties that changed.
 */
import { RUN, WORLD, depthScale } from '@shared/constants.ts';
import { SETS } from '@shared/data/boons.ts';
import {
  OBJECTIVE_KINDS, PF, type AbilitySlot, type AffixId, type BiomeId, type Door, type DoorType, type ElementId, type EnemyKind, type GameEvent,
  type ObjectiveKind, type PlayerSnap, type RunState,
} from '@shared/types.ts';
import { self, selfRoster, state } from '../core/GameState.ts';
import { createCoach } from './coach.ts';
import { FEED_PRIORITY, createFeed } from './feed.ts';
import { h, icon, key, retrigger, setAttr, setText, setVar, show, toggle } from './dom.ts';
import { actTitle, bossLabel, chamberActs, distinctElements, enemyName, infusionsOf, phaseThresholds } from './elements.ts';
import { createBuffs, createSets, createUltimate } from './hud3.ts';
import { createKeystoneHud } from './hud5.ts';
import { buildInfo, heldKeystones, keystoneName, keystoneOnSlot } from './keystones.ts';
import { KEYSTONE_BY_ID } from '@shared/data/keystones.ts';
import { DOOR_TEXT_PARAMS, formatBoon, formatList, roman, t, type I18nKey } from './i18n.ts';
import { ABILITY_SLOTS, abilityIcon, depthLabel, infusionOf, maxDashCharges, nameOf } from './model.ts';
import { OBJECTIVE_ICON, createObjective, createObjectiveBanner, hasBonus, objectiveBonus, objectiveGoal, objectiveName, objectiveReward } from './objective.ts';
import { affixBody, affixName, setName, setTierText } from './text.ts';
import { ui, UI_CONFIG } from './store.ts';
import { createStrip } from './strip.ts';
import { createTips } from './tips.ts';
import type { View } from './view.ts';
import type { IconName } from './icons.ts';

const PERCENT = 100;
/** Door types that lead into an ordinary combat chamber: their objective is always worth showing. */
const COMBAT_DOORS: readonly DoorType[] = ['boon', 'blessing', 'cursed'];
/** Objectives whose chamber has no waves to count (foes keep coming, or there are none). */
const WAVELESS: readonly ObjectiveKind[] = ['survive', 'ritual', 'vault'];
/** Objective behind a door; `slay` when an older server does not send one. */
const doorObjective = (door: Door): ObjectiveKind => ((OBJECTIVE_KINDS as readonly string[]).includes(door.objective) ? door.objective : 'slay');
/** Objective of the chamber being fought, or null outside a chamber. */
const liveObjective = (run: RunState | null): ObjectiveKind | null => (run && run.objective && run.phase === 'combat' ? run.objective.kind : null);
const pctMore = (mul: number): number => Math.round((mul - 1) * PERCENT);
/** Icon of a boss / champion on the chamber track and the boss bar. */
export const BOSS_ICON: Partial<Record<EnemyKind, IconName>> = { champion: 'elite', regent: 'boss', matron: 'matron', stalker: 'stalker' };

export interface HudView extends View {
  syncHud(): void;
  onEvent(ev: GameEvent): void;
  /** `slot` (optional) names the ability a denied press was for. */
  onLocalAction(action: LocalAction, slot?: string): void;
  /** Enter in game: closes the visible tip. Returns false when there was none. */
  dismissTip(): boolean;
  /** The game screen was left. */
  reset(): void;
}

export type LocalAction = 'primary' | 'secondary' | 'dash' | 'ultimate' | 'denied';

interface PartyFrame {
  el: HTMLElement;
  hp: HTMLElement;
  shield: HTMLElement;
  revive: HTMLElement;
  tag: HTMLElement;
  ult: HTMLElement;
}

interface AbilitySlotView {
  el: HTMLElement;
  iconBox: HTMLElement;
  badge: HTMLElement;
  pips: HTMLElement;
  iconName: IconName | null;
  element: string;
  pipCount: number;
  ready: boolean;
}

const pct = (v: number): string => `${Math.round(Math.min(1, Math.max(0, v)) * PERCENT * 10) / 10}%`;

export function createHud(): HudView {
  // ------------------------------------------------------------ own vitals (bottom-left)
  const vignette = h('div', { class: 'gg-vignette' });
  const ownEmblem = h('span', { class: 'gg-vitals-emblem' });
  const ownName = h('span', { class: 'gg-vitals-name' });
  const secondWind = h('span', { class: 'gg-vitals-wind' }, icon('revive'), h('span'));
  const hpGhost = h('i', { class: 'gg-hpbar-ghost' });
  const hpFill = h('i', { class: 'gg-hpbar-fill' });
  const hpNum = h('span', { class: 'gg-hpbar-num gg-num' });
  const hpBar = h('div', { class: 'gg-hpbar', 'data-testid': 'hud-hp', 'data-hp': '0', 'data-max': '0' }, hpGhost, hpFill, hpNum);
  const shieldFill = h('i');
  const shieldNum = h('span', { class: 'gg-shield-num gg-num' });
  const shieldBar = h('div', { class: 'gg-shieldbar' }, shieldFill);
  const vitals = h('div', { class: 'gg-vitals' },
    ownEmblem,
    h('div', { class: 'gg-vitals-main' },
      h('div', { class: 'gg-vitals-top' }, ownName, shieldNum, secondWind),
      shieldBar,
      hpBar,
    ),
  );
  let ownClass = '';
  let lastHp = -1;

  // ------------------------------------------------------------ party frames (top-left)
  const party = h('div', { class: 'gg-party' });
  const frames = new Map<number, PartyFrame>();

  let partyKey = '';
  const renderParty = (): void => {
    const key = JSON.stringify([state.conn.slot, state.roster.map((p) => [p.slot, p.name, p.cls, p.mastery, buildInfo(p).short])]);
    if (key === partyKey) return;
    partyKey = key;
    party.replaceChildren();
    frames.clear();
    for (const p of state.roster) {
      if (p.slot === state.conn.slot) continue;
      const hp = h('i', { class: 'gg-party-hp-fill' });
      const shield = h('i', { class: 'gg-party-hp-shield' });
      const revive = h('i', { class: 'gg-party-revive' });
      const tag = h('span', { class: 'gg-party-tag' });
      const ult = h('span', { class: 'gg-party-ult', title: t('hud.party.ult') }, icon('ultimate'));
      const level = Math.max(1, Math.floor(p.mastery ?? 1));
      // Update 5: once an ally holds a keystone the frame names the build (the emblem keeps showing the class).
      const build = buildInfo(p);
      const el = h('div', { class: `gg-party-frame gg-cls-${p.cls}`, 'data-slot': String(p.slot), 'data-ult': 'false', 'data-build': build.short },
        h('span', { class: 'gg-party-emblem', title: t(`class.${p.cls}.name`) }, icon(p.cls), h('b', { class: 'gg-party-level gg-num' }, String(level))),
        h('div', { class: 'gg-party-main' },
          h('div', { class: 'gg-party-name' }, h('span', null, p.name),
            build.short !== ''
              ? h('em', { class: 'gg-party-class gg-party-build', title: `${build.name} — ${build.keystones.map(keystoneName).join(', ')}` }, icon('keystone'), build.short)
              : h('em', { class: 'gg-party-class' }, t(`class.${p.cls}.name`)),
            ult),
          h('div', { class: 'gg-party-row' }, h('div', { class: 'gg-party-hp' }, hp, shield, revive), tag),
        ),
      );
      frames.set(p.slot, { el, hp, shield, revive, tag, ult });
      party.append(el);
    }
  };

  const syncParty = (): void => {
    for (const [slot, frame] of frames) {
      const snap = state.players.find((p) => p.slot === slot);
      const connected = state.roster.find((p) => p.slot === slot)?.connected ?? true;
      const downed = snap?.state === 'downed';
      const dead = snap?.state === 'dead';
      toggle(frame.el, 'is-off', !connected);
      toggle(frame.el, 'is-downed', connected && downed);
      toggle(frame.el, 'is-dead', connected && dead);
      const frac = snap && snap.maxHp > 0 ? snap.hp / snap.maxHp : 0;
      toggle(frame.el, 'is-low', connected && !downed && !dead && frac < UI_CONFIG.LOW_HEALTH_FRACTION);
      setVar(frame.hp, '--w', pct(downed || dead ? 0 : frac));
      setVar(frame.shield, '--w', pct(snap && snap.maxHp > 0 ? snap.shield / snap.maxHp : 0));
      setVar(frame.revive, '--w', pct(downed ? snap.revive : 0));
      setText(frame.tag, !connected ? t('hud.disconnected') : downed ? t('hud.downed') : dead ? t('hud.dead') : '');
      const charged = connected && !downed && !dead && (snap?.ult ?? 0) >= 1;
      toggle(frame.ult, 'is-on', charged);
      setAttr(frame.el, 'data-ult', String(charged));
    }
  };

  // ------------------------------------------------------------ chamber track + wave + boss (top-centre)
  const track = h('div', { class: 'gg-track', 'data-testid': 'hud-chamber', 'data-chamber': '0' });
  const waveText = h('span', { class: 'gg-wave-main' });
  const waveTag = h('span', { class: 'gg-wave-tag' });
  const enemiesText = h('span', { class: 'gg-wave-enemies gg-num' });
  const waveLine = h('div', { class: 'gg-wave' }, waveTag, waveText, enemiesText);
  const bossName = h('span', { class: 'gg-boss-name' });
  const bossFill = h('i', { class: 'gg-boss-fill' });
  const bossGhost = h('i', { class: 'gg-boss-ghost' });
  const bossMarks = h('div', { class: 'gg-boss-marks' });
  const bossIcon = h('span', { class: 'gg-boss-icon' });
  const boss = h('div', { class: 'gg-boss', 'data-testid': 'hud-boss', 'data-boss': '' },
    h('div', { class: 'gg-boss-head' }, bossIcon, bossName),
    h('div', { class: 'gg-boss-bar' }, bossGhost, bossFill, bossMarks),
  );
  const bannerTitle = h('div', { class: 'gg-banner-title' });
  const bannerSub = h('div', { class: 'gg-banner-sub' });
  const banner = h('div', { class: 'gg-banner', role: 'status' }, bannerTitle, bannerSub);
  const bossSlot = h('div', { class: 'gg-boss-slot' });
  const coach = createCoach();
  const coachSlot = h('div', { class: 'gg-coach-slot' });
  const objective = createObjective();
  const objectiveBanner = createObjectiveBanner();
  // The objective banner shares the place of the generic banner: whichever came last is shown.
  const bannerSlot = h('div', { class: 'gg-banner-slot' }, banner, objectiveBanner.slot);
  const keystones = createKeystoneHud();
  const topCentre = h('div', { class: 'gg-hud-tc' }, coachSlot, track, waveLine, objective.el, bossSlot, bannerSlot, keystones.banner);
  let trackKey = '';
  let bossKey = '';
  let bannerTimer = 0;
  let actBannerUntil = 0;
  /** While an objective intro / completion banner is up, the plain "Wave 1" / "Chamber cleared" banners stay away. */
  let objectiveBannerUntil = 0;
  let lastBiome: BiomeId | null = null;
  let lastChamber = -1;

  const showBanner = (title: string, sub: string, tone: string, ms: number = UI_CONFIG.BANNER_MS): void => {
    objectiveBanner.hide();
    objectiveBannerUntil = 0;
    setText(bannerTitle, title);
    setText(bannerSub, sub);
    banner.dataset.tone = tone;
    setVar(banner, '--banner-ms', `${ms}ms`);
    retrigger(banner, 'is-on');
    window.clearTimeout(bannerTimer);
    bannerTimer = window.setTimeout(() => banner.classList.remove('is-on'), ms);
  };

  const renderTrack = (): void => {
    const run = state.run;
    if (!run) return;
    const acts = chamberActs(ui.biomes);
    const depth = Math.max(0, Math.floor(run.depth ?? 0));
    const special = liveObjective(run);
    const k = `${run.chamber}|${run.oath}|${run.entered}|${run.finalBoss}|${depth}|${special}|${acts.join('')}|${[...ui.biomes.values()].join(',')}`;
    if (k === trackKey) return;
    trackKey = k;
    setAttr(track, 'data-chamber', String(run.chamber));
    setAttr(track, 'data-depth', String(depth));
    setAttr(track, 'data-objective', special ?? '');
    const finalName = enemyName(run.finalBoss ?? 'regent');
    const list = h('ol', { class: 'gg-track-list', 'aria-label': t('hud.chamber', { n: run.chamber + 1, m: RUN.CHAMBERS.length }) });
    const currentAct = acts[Math.min(run.chamber, acts.length - 1)];
    RUN.CHAMBERS.forEach((kind, i) => {
      const act = acts[i];
      const actStart = i === 0 || acts[i - 1] !== act;
      if (actStart) {
        // Any chamber of the act that was already visited tells its biome.
        const seenAt = acts.findIndex((other, index) => other === act && ui.biomes.has(index));
        const biome = seenAt >= 0 ? ui.biomes.get(seenAt) ?? null : null;
        list.append(h('li', {
          class: `gg-track-act${act === currentAct ? ' is-current' : act < currentAct ? ' is-done' : ''}`,
          'data-biome': biome ?? '', 'data-act': String(act + 1), title: actTitle(act, biome),
        }, roman(act + 1)));
      }
      const cls = i < run.chamber ? 'is-done' : i === run.chamber ? 'is-current' : '';
      const cursed = i === run.chamber && run.entered === 'cursed' ? ' is-cursed' : '';
      const final = kind === 'boss';
      // The current chamber wears its objective's icon (special objectives only exist in combat chambers).
      const goal = i === run.chamber && kind === 'combat' && special && special !== 'slay' ? special : null;
      list.append(h('li', {
        class: `gg-track-node is-${kind} ${cls}${cursed}${actStart ? ' is-act-start' : ''}${goal ? ' has-objective' : ''}`,
        'data-objective': goal ?? '',
        title: final ? t('hud.finalBoss', { name: finalName }) : goal ? `${t(`chamber.${kind}`)} — ${objectiveName(goal)}` : t(`chamber.${kind}`),
      }, icon(final ? BOSS_ICON[run.finalBoss] ?? 'boss' : goal ? OBJECTIVE_ICON[goal] : kind)));
    });
    const badge = run.oath > 0
      ? h('span', { class: 'gg-oath-badge', title: t('oath.badge', { n: roman(run.oath) }) }, icon('bell'), roman(run.oath))
      : null;
    const final = h('span', { class: 'gg-track-final', 'data-boss': run.finalBoss ?? 'regent', title: t('hud.finalBoss', { name: finalName }) }, finalName);
    // Depth is counted from 1 ("Depth II" = one descent); the first descent needs no label.
    const depthBadge = depth > 0
      ? h('span', { class: 'gg-depth-badge', 'data-testid': 'hud-depth', 'data-depth': String(depth) }, icon('depth'), depthLabel(depth))
      : null;
    track.replaceChildren(...[badge, depthBadge, list, final].filter((n): n is HTMLElement => n !== null));
  };

  /** Announces a new act when the biome changes (or the run begins). Nothing after a reload mid-run. */
  const trackAct = (): void => {
    const run = state.run;
    if (!run || !run.room || run.tutorial) return;
    if (run.chamber === 0 && lastChamber !== 0) lastBiome = null;
    const biome = run.room.biome;
    const fresh = lastBiome === null ? run.chamber === 0 && lastChamber !== 0 : biome !== lastBiome;
    if (fresh && run.phase !== 'combat') return; // announce once the fight in the new act starts
    lastChamber = run.chamber;
    lastBiome = biome;
    if (!fresh) return;
    const act = chamberActs(ui.biomes)[Math.min(run.chamber, RUN.CHAMBERS.length - 1)] ?? 0;
    // If the objective was introduced a moment earlier, the act goes first and the objective comes back after it.
    const pending = objectiveBanner.showing() ? liveObjective(run) : null;
    showBanner(actTitle(act, biome), t(`biome.${biome}.hint`), `biome-${biome}`, UI_CONFIG.ACT_BANNER_MS);
    banner.dataset.act = String(act + 1);
    actBannerUntil = performance.now() + UI_CONFIG.ACT_BANNER_MS;
    if (pending && pending !== 'slay') {
      objectiveBanner.intro(pending, UI_CONFIG.ACT_BANNER_MS);
      objectiveBannerUntil = actBannerUntil + UI_CONFIG.OBJECTIVE_BANNER_MS;
    }
  };

  const syncRun = (): void => {
    const run = state.run;
    if (!run) return;
    const training = run.tutorial !== null && run.tutorial !== undefined;
    toggle(el, 'gg-hud--training', training);
    if (training && !coach.el.isConnected) coachSlot.append(coach.el);
    else if (!training && coach.el.isConnected) coach.el.remove();
    if (training) coach.sync();
    renderTrack();
    trackAct();
    strip.sync();
    sets.sync(selfRoster()?.boons ?? []);
    keystones.sync(selfRoster(), training);
    tips.onRun();
    const combat = run.phase === 'combat';
    const waveless = combat && run.objective !== null && run.objective !== undefined && WAVELESS.includes(run.objective.kind);
    objective.sync();
    setText(waveText,
      waveless ? ''
        : combat ? t('hud.wave', { n: Math.max(1, run.wave), m: Math.max(1, run.waveCount) })
        : run.phase === 'draft' ? t('hud.phase.draft')
          : run.phase === 'doors' ? t('hud.phase.doors') : '');
    const entered = run.entered === 'cursed' ? t('hud.entered.cursed') : run.entered === 'blessing' ? t('hud.entered.blessing') : '';
    setText(waveTag, entered);
    waveTag.dataset.type = run.entered;
    show(waveTag, entered !== '' && combat);
    toggle(el, 'gg-hud--draft', run.phase === 'draft');
    toggle(el, 'gg-hud--calm', !combat);

    const label = bossLabel(run);
    const k = `${label.kind}|${label.herald}|${run.chamberKind}`;
    if (k !== bossKey) {
      bossKey = k;
      setText(bossName, label.name);
      bossIcon.replaceChildren(icon(BOSS_ICON[label.kind] ?? 'boss'));
      setAttr(boss, 'data-boss', label.kind);
      toggle(boss, 'is-regent', run.chamberKind === 'boss');
      toggle(boss, 'is-herald', label.herald);
      bossMarks.replaceChildren();
      for (const threshold of phaseThresholds(label)) {
        const mark = h('i');
        mark.style.left = pct(threshold);
        bossMarks.append(mark);
      }
    }
  };

  // ------------------------------------------------------------ ping + feed (top-right)
  const pingText = h('span', { class: 'gg-num' });
  const ping = h('div', { class: 'gg-ping' }, icon('signal'), pingText);
  const roomCode = h('div', { class: 'gg-room-code' });
  const feed = createFeed();
  const reconnect = h('div', { class: 'gg-reconnect', role: 'alert', 'data-testid': 'reconnect-banner' },
    h('span', { class: 'gg-spinner' }), h('span', null, t('hud.reconnecting')));
  const reconnectSlot = h('div', { class: 'gg-reconnect-slot' });


  const syncNet = (): void => {
    const ms = Math.round(state.conn.pingMs);
    setText(pingText, t('hud.ping', { n: ms }));
    const reconnecting = state.conn.status === 'reconnecting';
    ping.dataset.q = reconnecting ? 'bad'
      : ms <= UI_CONFIG.PING_GOOD_MS ? 'good' : ms <= UI_CONFIG.PING_OK_MS ? 'ok' : ms <= UI_CONFIG.PING_POOR_MS ? 'poor' : 'bad';
    setText(roomCode, state.conn.code);
    if (reconnecting && !reconnect.isConnected) reconnectSlot.append(reconnect);
    else if (!reconnecting && reconnect.isConnected) reconnect.remove();
  };

  // ------------------------------------------------------------ prompts + ability bar (bottom-centre)
  const prompt = h('div', { class: 'gg-prompt', role: 'status' });
  let promptKey = '';
  let promptBar: HTMLElement | null = null;
  const doorBars: HTMLElement[] = [];

  const progressBar = (): HTMLElement => {
    const fill = h('i');
    promptBar = fill;
    return h('div', { class: 'gg-prompt-bar' }, fill);
  };

  const renderPrompt = (kind: string, build: () => (HTMLElement | null)[]): void => {
    if (kind === promptKey) return;
    promptKey = kind;
    promptBar = null;
    doorBars.length = 0;
    prompt.replaceChildren(...build().filter((n): n is HTMLElement => n !== null));
    prompt.dataset.kind = kind.split('|')[0];
    show(prompt, kind !== '');
    if (kind !== '') retrigger(prompt, 'is-in');
  };

  const line = (iconName: IconName, text: string): HTMLElement =>
    h('div', { class: 'gg-prompt-line' }, icon(iconName), h('span', null, text));

  const windText = (n: number): string =>
    n <= 0 ? t('hud.prompt.secondWind.none') : n === 1 ? t('hud.prompt.secondWind.one') : t('hud.prompt.secondWind.many', { n });

  const syncPrompt = (): void => {
    const run = state.run;
    const me = self();
    const solo = state.roster.length <= 1;
    if (me && me.state !== 'alive') {
      if (solo) {
        const winds = run?.secondWinds ?? 0;
        renderPrompt(`downed|solo|${winds}`, () => [line('skull', t('hud.prompt.downedSolo')), line('revive', windText(winds))]);
      } else {
        const reviving = (me.flags & PF.BEING_REVIVED) !== 0 || me.revive > 0;
        renderPrompt(`downed|${reviving}`, () => [
          line(reviving ? 'revive' : 'skull', reviving ? t('hud.prompt.beingRevived') : t('hud.prompt.downed')),
          reviving ? progressBar() : null,
        ]);
        if (promptBar) setVar(promptBar, '--w', pct(me.revive));
      }
      return;
    }
    if (run?.phase === 'doors') {
      const training = run.tutorial !== null && run.tutorial !== undefined;
      const deep = run.doors.some((d) => d.type === 'descend' || d.type === 'ascend');
      const nextDepth = roman(Math.max(0, run.depth ?? 0) + 2);
      const goals = run.doors.map((d) => doorObjective(d));
      // One card per door, left to right as the doors stand in the room (the camera looks down the -z axis).
      const order = run.doors.map((_, index) => index).sort((i, j) => run.doors[i].x - run.doors[j].x || i - j);
      const sided = order.length === 2 && run.doors[order[0]].x !== run.doors[order[1]].x;
      const special = !training && goals.some((kind) => kind !== 'slay');
      renderPrompt(`doors|${run.doors.map((d, i) => `${d.type}:${goals[i]}:${Math.round(d.x)}`).join(',')}|${run.finalBoss}|${nextDepth}|${training}`, () => {
        const legend = h('div', { class: 'gg-door-legend', 'data-doors': String(order.length) });
        order.forEach((index, place) => {
          const door = run.doors[index];
          const kind = goals[index];
          const fill = h('i');
          fill.dataset.door = String(index);
          doorBars.push(fill);
          // The objective is shown for every door into a combat chamber, and wherever it is a special one.
          const showGoal = !training && (kind !== 'slay' || COMBAT_DOORS.includes(door.type));
          const goal = showGoal
            ? h('div', { class: 'gg-door-obj', 'data-testid': `door-objective-${index}`, 'data-kind': kind, 'data-bonus': String(hasBonus(kind)) },
              icon(OBJECTIVE_ICON[kind]),
              h('div', { class: 'gg-door-obj-text' },
                h('b', null, objectiveName(kind)),
                h('span', null, objectiveGoal(kind)),
                hasBonus(kind)
                  ? h('em', { class: 'gg-door-obj-bonus', title: objectiveBonus(kind) }, icon('star'),
                    h('span', null, `${t('objective.bonus')}: ${objectiveBonus(kind)}`))
                  : null,
                // What meeting the condition is worth (a vault pays without a condition).
                objectiveReward(kind) !== ''
                  ? h('em', { class: 'gg-door-obj-reward', 'data-testid': `door-reward-${index}`, title: t('door.objective.rewardLabel') }, icon('boon'),
                    h('span', null, objectiveReward(kind)))
                  : null,
              ))
            : null;
          legend.append(h('div', { class: `gg-door gg-door--${door.type}${goal ? ' has-objective' : ''}`, 'data-door': String(index), 'data-type': door.type },
            h('div', { class: 'gg-door-type' },
              icon(door.type),
              h('div', null,
                h('b', null, t(`door.${door.type}.name`), sided ? h('i', { class: 'gg-door-side' }, t(place === 0 ? 'door.left' : 'door.right')) : null),
                h('span', null, t(`door.${door.type}.desc`, { ...DOOR_TEXT_PARAMS, boss: enemyName(run.finalBoss ?? 'regent'), depth: nextDepth })),
              ),
            ),
            goal,
            h('div', { class: 'gg-door-progress' }, fill),
          ));
        });
        return [
          line(deep ? 'bell' : 'door', deep ? t('hud.prompt.doorsDeep') : special ? t('hud.prompt.doorsObjective') : t('hud.prompt.doors')),
          order.length > 0 ? legend : null,
        ];
      });
      for (const fill of doorBars) {
        const index = Number(fill.dataset.door);
        setVar(fill, '--w', pct(index >= 0 ? run.doorProgress[index] ?? 0 : 0));
      }
      return;
    }
    if (me) {
      let nearest: PlayerSnap | null = null;
      let best: number = UI_CONFIG.REVIVE_HINT_RADIUS;
      for (const p of state.players) {
        if (p.slot === me.slot || p.state !== 'downed') continue;
        const dist = Math.hypot(p.x - me.x, p.z - me.z);
        if (dist <= best) { best = dist; nearest = p; }
      }
      if (nearest) {
        const close = best <= WORLD.REVIVE_RADIUS || nearest.revive > 0;
        const name = nameOf(nearest.slot);
        renderPrompt(`revive|${nearest.slot}|${close}`, () => [
          line('revive', close ? t('hud.prompt.reviving', { name }) : t('hud.prompt.reviveHint', { name })),
          close ? progressBar() : null,
        ]);
        if (promptBar) setVar(promptBar, '--w', pct(nearest.revive));
        return;
      }
    }
    renderPrompt('', () => []);
  };

  const ultimate = createUltimate();
  const buffs = createBuffs();
  const sets = createSets();

  const slots = new Map<AbilitySlot, AbilitySlotView>();
  /** Blood Price: what the next secondary costs in health. */
  const bloodCost = h('b', { class: 'gg-ability-cost gg-num', 'data-testid': 'hud-blood-price' });
  const engineFeed = h('b', { class: 'gg-ult-feed gg-num' });
  const abilityBar = h('div', { class: 'gg-abilities' });
  for (const slot of ABILITY_SLOTS) {
    const iconBox = h('span', { class: 'gg-ability-icon' });
    const badge = h('span', { class: 'gg-ability-badge' });
    const pips = h('span', { class: 'gg-ability-pips' });
    const slotEl = h('div', { class: `gg-ability gg-ability--${slot}`, 'data-keystone': '' },
      pips,
      h('div', { class: 'gg-ability-diamond' },
        h('div', { class: 'gg-ability-frame' }, iconBox, h('i', { class: 'gg-ability-sweep' })),
        badge,
        // Update 5: the mark of the keystone that transforms this ability.
        h('i', { class: 'gg-ability-ks' }, icon('keystone')),
        slot === 'secondary' ? bloodCost : null,
      ),
      key(t(`hud.key.${slot}` as I18nKey)),
    );
    slots.set(slot, { el: slotEl, iconBox, badge, pips, iconName: null, element: '', pipCount: -1, ready: true });
    abilityBar.append(slotEl);
  }
  abilityBar.append(ultimate.el);
  ultimate.el.append(engineFeed);

  const flash = (slot: AbilitySlot, cls: string, ms: number): void => {
    const view = slots.get(slot);
    if (!view) return;
    retrigger(view.el, cls);
    window.setTimeout(() => view.el.classList.remove(cls), ms);
  };

  const syncAbilities = (me: PlayerSnap | null): void => {
    const roster = selfRoster();
    const cls = roster?.cls ?? state.profile.cls;
    const boons = roster?.boons ?? [];
    for (const slot of ABILITY_SLOTS) {
      const view = slots.get(slot);
      if (!view) continue;
      // The secondary shows the equipped art (RosterEntry.art), so the bar never lies about what RMB does.
      const iconName = abilityIcon(cls, slot, roster?.art ?? 0);
      if (view.iconName !== iconName) {
        view.iconName = iconName;
        view.iconBox.replaceChildren(icon(iconName));
        view.el.dataset.ability = iconName;
      }
      const element = infusionOf(boons, slot) ?? '';
      if (view.element !== element) {
        view.element = element;
        view.el.dataset.element = element;
        view.badge.replaceChildren(...(element !== '' ? [icon(element as IconName)] : []));
      }
    }
    ultimate.sync(me, cls, infusionOf(boons, 'ultimate') ?? '');
    // ---- update 5: keystone frames, Blood Price cost, Phase Walker / Veil windows, Resonance Engine
    const held = heldKeystones(roster);
    for (const slot of ABILITY_SLOTS) {
      const view = slots.get(slot);
      const ks = keystoneOnSlot(held, slot) ?? '';
      if (view && view.el.dataset.keystone !== ks) {
        view.el.dataset.keystone = ks;
        view.el.title = ks !== '' ? t('hud.keystone.frame', { name: keystoneName(ks) }) : '';
      }
    }
    const engine = keystoneOnSlot(held, 'ultimate') ?? '';
    if (ultimate.el.dataset.keystone !== engine) {
      ultimate.el.dataset.keystone = engine;
      const per = KEYSTONE_BY_ID.get(engine)?.params.perResonance;
      // The ring is cut into the pieces one Resonance charges.
      setVar(ultimate.el, '--seg', per ? `${per}%` : '100%');
    }
    const fed = keystones.takeEngineFeed();
    if (fed > 0 && engine !== '') { setText(engineFeed, `+${fed}%`); retrigger(engineFeed, 'is-on'); }
    const price = held.includes('blood_price') ? KEYSTONE_BY_ID.get('blood_price')?.params.hpFraction ?? 0 : 0;
    if (price > 0 && me) {
      // It cannot kill: the last point of health is never spent, and at 1 health the ability does not fire.
      const cost = Math.max(0, Math.min(Math.round(me.maxHp * price), Math.round(me.hp) - 1));
      const blocked = me.hp <= 1;
      setText(bloodCost, blocked ? '!' : `−${cost}`);
      setAttr(bloodCost, 'data-cost', String(cost));
      toggle(bloodCost, 'is-blocked', blocked);
      bloodCost.title = blocked ? t('hud.ks.bloodPriceBlocked') : t('hud.ks.bloodPrice', { n: cost });
    }
    show(bloodCost, price > 0 && me !== null);
    const dashView = slots.get('dash');
    if (dashView) toggle(dashView.el, 'is-empowered', keystones.windowOpen('phase_walker') || keystones.windowOpen('ks_shade'));
    const secondary = slots.get('secondary');
    const dash = slots.get('dash');
    if (!secondary || !dash) return;
    const cdSecondary = me?.cdSecondary ?? 0;
    setVar(secondary.el, '--cd', String(Math.round(cdSecondary * 1000) / 1000));
    const secondaryReady = cdSecondary <= 0;
    toggle(secondary.el, 'is-cooling', !secondaryReady);
    if (secondaryReady && !secondary.ready) flash('secondary', 'is-refreshed', UI_CONFIG.DENIED_FLASH_MS);
    secondary.ready = secondaryReady;

    const charges = me?.dashCharges ?? 0;
    const max = Math.max(maxDashCharges(cls, boons), charges, 1);
    if (dash.pipCount !== max) {
      dash.pipCount = max;
      dash.pips.replaceChildren(...Array.from({ length: max }, () => h('i')));
    }
    Array.from(dash.pips.children).forEach((pip, i) => toggle(pip, 'is-on', i < charges));
    const recharging = charges < max;
    setVar(dash.el, '--cd', recharging ? String(Math.round((me?.cdDash ?? 0) * 1000) / 1000) : '0');
    toggle(dash.el, 'is-cooling', charges === 0);
    toggle(dash.el, 'is-recharging', recharging && charges > 0);
    const dashReady = charges > 0;
    if (dashReady && !dash.ready) flash('dash', 'is-refreshed', UI_CONFIG.DENIED_FLASH_MS);
    dash.ready = dashReady;
    toggle(abilityBar, 'is-downed', me !== null && me.state !== 'alive');
  };

  // ------------------------------------------------------------ element strip, combo counter, tips
  const strip = createStrip();
  const tips = createTips();

  // ------------------------------------------------------------ root
  const el = h('div', { class: 'gg-hud', 'data-testid': 'hud-root' },
    vignette,
    h('div', { class: 'gg-hud-tl' }, party),
    topCentre,
    h('div', { class: 'gg-hud-tr' }, h('div', { class: 'gg-net' }, ping, roomCode), feed.el),
    reconnectSlot,
    tips.el,
    h('div', { class: 'gg-hud-bl' }, vitals),
    h('div', { class: 'gg-hud-br' }, sets.el),
    h('div', { class: 'gg-hud-bc' }, prompt, buffs.el, h('div', { class: 'gg-ability-row' }, keystones.el, abilityBar, strip.el)),
  );
  show(prompt, false);

  const syncVitals = (me: PlayerSnap | null): void => {
    const roster = selfRoster();
    const cls = roster?.cls ?? state.profile.cls;
    if (ownClass !== cls) {
      ownClass = cls;
      ownEmblem.replaceChildren(icon(cls));
      ownEmblem.className = `gg-vitals-emblem gg-cls-${cls}`;
    }
    setText(ownName, roster?.name ?? state.profile.name);
    const hp = me ? Math.max(0, Math.round(me.hp)) : 0;
    const max = me ? Math.max(1, Math.round(me.maxHp)) : 1;
    const shield = me ? Math.max(0, Math.round(me.shield)) : 0;
    const frac = hp / max;
    setAttr(hpBar, 'data-hp', String(hp));
    setAttr(hpBar, 'data-max', String(me ? max : 0));
    setVar(hpFill, '--w', pct(frac));
    setVar(hpGhost, '--w', pct(frac));
    setText(hpNum, me ? `${hp} / ${max}` : '');
    if (lastHp >= 0 && hp < lastHp) retrigger(hpBar, 'is-hit');
    lastHp = hp;
    setVar(shieldFill, '--w', pct(shield / max));
    toggle(shieldBar, 'is-on', shield > 0);
    setText(shieldNum, shield > 0 ? `+${shield}` : '');
    const downed = me !== null && me.state !== 'alive';
    toggle(vitals, 'is-downed', downed);
    toggle(vitals, 'is-low', !downed && me !== null && frac < UI_CONFIG.LOW_HEALTH_FRACTION);
    toggle(vitals, 'is-critical', !downed && me !== null && frac < UI_CONFIG.CRITICAL_HEALTH_FRACTION);
    const danger = me && !downed ? Math.max(0, (UI_CONFIG.LOW_HEALTH_FRACTION - frac) / UI_CONFIG.LOW_HEALTH_FRACTION) : downed ? 1 : 0;
    setVar(vignette, '--a', String(Math.round(danger * 100) / 100));
    toggle(vignette, 'is-critical', !downed && me !== null && frac < UI_CONFIG.CRITICAL_HEALTH_FRACTION);
    toggle(vignette, 'is-downed', downed);
    const solo = state.roster.length <= 1;
    const winds = state.run?.secondWinds ?? 0;
    show(secondWind, solo && winds > 0);
    if (solo && winds > 0) setText(secondWind.lastElementChild as HTMLElement, `${t('hud.secondWind')} ×${winds}`);
  };

  const syncHud = (): void => {
    const me = self();
    syncVitals(me);
    syncParty();
    syncAbilities(me);
    syncPrompt();
    buffs.tick();
    keystones.tick();
    tips.pump();
    objective.sync();
    // The bar belongs to a living boss: once the fight is over (draft, doors) a dead boss's empty bar goes away.
    const fighting = state.run?.phase === 'combat';
    const hp = fighting ? state.bossHp : null;
    if (hp !== null && !boss.isConnected) bossSlot.append(boss);
    else if (hp === null && boss.isConnected) boss.remove();
    if (hp !== null) {
      setVar(bossFill, '--w', pct(hp));
      setVar(bossGhost, '--w', pct(hp));
    }
    const combat = state.run?.phase === 'combat';
    const n = state.enemiesAlive;
    setText(enemiesText, combat && n > 0 ? (n === 1 ? t('hud.enemies.one') : t('hud.enemies.many', { n })) : '');
    show(enemiesText, combat && n > 0);
    show(waveLine, waveText.textContent !== '' || !waveTag.hidden || !enemiesText.hidden);
  };

  const affixSeen = new Map<string, number>();
  const wardSeen = new Map<ElementId, number>();
  let anchorCalloutAt = -Infinity;
  /** Braziers announced as lit in this chamber (the event can arrive before the snapshot that shows it). */
  const litSites = new Set<number>();

  const sync = (): void => {
    renderParty();
    syncRun();
    syncNet();
    syncHud();
  };

  const onEvent = (ev: GameEvent): void => {
    const own = state.conn.slot;
    tips.onEvent(ev);
    keystones.onEvent(ev);
    switch (ev.e) {
      case 'keystone':
        if (ev.slot === own) {
          // The moment of the run: its own banner, nothing else talks over it.
          banner.classList.remove('is-on');
          objectiveBanner.hide();
          keystones.acquired(ev.id, ev.replaced, selfRoster());
          keystones.sync(selfRoster(), false);
        } else {
          feed.push({
            key: `keystone-${ev.slot}`, icon: 'keystone', tone: 'keystone', priority: FEED_PRIORITY.INFO,
            text: t('toast.keystoneAlly', { name: nameOf(ev.slot), keystone: keystoneName(ev.id) }),
          });
        }
        break;
      case 'resonance':
        strip.onResonance(ev.a, ev.b, ev.by);
        break;
      case 'tutorialStep':
        coach.celebrate(ev.step);
        break;
      case 'ultReady':
        if (ev.slot === own) {
          ultimate.ready();
          const cls = selfRoster()?.cls ?? state.profile.cls;
          // The button itself says "Ready": one short line is enough here.
          feed.push({
            key: 'ult-own', icon: 'ultimate', tone: 'ult', priority: FEED_PRIORITY.NOTICE,
            text: t('toast.ultReadyOwn', { name: t(`class.${cls}.ultimate.name`), key: t('hud.key.ultimate') }),
          });
        } else {
          // Allies' ultimates are a nicety (their party frame wears a star): one merged line that never crowds out news.
          feed.push({
            key: 'ult-ally', icon: 'ultimate', tone: 'ult-ally', priority: FEED_PRIORITY.LOW, item: nameOf(ev.slot),
            list: (names) => (names.length === 1 ? t('toast.ultReadyAlly', { name: names[0] }) : t('toast.ultReadyMany', { n: names.length })),
          });
        }
        break;
      case 'buff':
        if (ev.slot === own) buffs.add(ev.id, ev.dur);
        break;
      case 'set': {
        const def = SETS.find((set) => set.id === ev.id);
        if (!def) break;
        const tier = roman(ev.tier);
        if (ev.slot === own) {
          sets.sync(selfRoster()?.boons ?? []);
          sets.flash(ev.id);
          showBanner(t('toast.set', { name: setName(def), tier }), setTierText(def, ev.tier), 'set');
        } else {
          feed.push({
            key: `set-${ev.slot}`, icon: def.element ?? def.category ?? 'boon', tone: 'set', priority: FEED_PRIORITY.LOW,
            text: t('toast.setAlly', { who: nameOf(ev.slot), name: setName(def), tier }),
          });
        }
        break;
      }
      case 'descend': {
        const scale = depthScale(ev.depth);
        showBanner(t('toast.descend', { n: roman(ev.depth + 1) }), t('toast.descendSub', { hp: pctMore(scale.hp), dmg: pctMore(scale.damage) }), 'descend',
          UI_CONFIG.ACT_BANNER_MS);
        actBannerUntil = performance.now() + UI_CONFIG.ACT_BANNER_MS;
        break;
      }
      case 'spawn': {
        const now = performance.now();
        // Wards: one line per element, and a plainer warning when it is an element the own hero relies on.
        if (ev.ward && now - (wardSeen.get(ev.ward) ?? -Infinity) >= UI_CONFIG.WARD_CALLOUT_GAP_MS) {
          wardSeen.set(ev.ward, now);
          const mine = distinctElements(infusionsOf(selfRoster()?.boons ?? [])).includes(ev.ward);
          const element = t(`element.${ev.ward}.name`);
          // Several warded elements in one wave share a line; a ward against an own element is the louder one.
          if (mine) {
            feed.push({
              key: 'ward-own', icon: 'warded', tone: `ward-${ev.ward}`, priority: FEED_PRIORITY.ALERT, item: element,
              list: (els) => (els.length === 1 ? t('toast.wardOwn', { element: els[0] }) : t('toast.wardOwnMany', { elements: formatList(els) })),
            });
          } else {
            feed.push({
              key: 'ward', icon: 'warded', tone: `ward-${ev.ward}`, priority: FEED_PRIORITY.NOTICE, item: element,
              list: (els) => (els.length === 1 ? t('toast.ward', { element: els[0] }) : t('toast.wardMany', { elements: formatList(els) })),
            });
          }
        }
        // Elite affixes: one small line per affix, however many elites spawn with it.
        if (!ev.affix) break;
        if (now - (affixSeen.get(ev.affix) ?? -Infinity) < UI_CONFIG.AFFIX_CALLOUT_GAP_MS) break;
        affixSeen.set(ev.affix, now);
        // One affix is explained; several at once are only named (the tip and the codex explain them).
        feed.push({
          key: 'affix', icon: 'affix', tone: 'affix', priority: FEED_PRIORITY.INFO, item: ev.affix,
          list: (ids) => {
            const affixes = ids as AffixId[];
            return affixes.length === 1
              ? `${t('toast.affix', { affix: affixName(affixes[0]) })} — ${affixBody(affixes[0])}`
              : t('toast.affixMany', { affixes: formatList(affixes.map(affixName)) });
          },
        });
        break;
      }
      case 'objective': {
        if (state.run?.tutorial) break;
        objective.onEvent(ev);
        const now = performance.now();
        if (ev.what === 'start') litSites.clear();
        if (ev.what === 'start' && ev.kind !== 'slay') {
          // A new act or depth is announced first; the objective follows it.
          const wait = Math.max(0, actBannerUntil - now);
          if (wait === 0) banner.classList.remove('is-on');
          objectiveBanner.intro(ev.kind, wait);
          objectiveBannerUntil = now + wait + UI_CONFIG.OBJECTIVE_BANNER_MS;
        } else if (ev.what === 'done' && ev.kind !== 'slay') {
          banner.classList.remove('is-on');
          objectiveBanner.done(ev.kind, ev.bonus === true);
          objectiveBannerUntil = now + UI_CONFIG.OBJECTIVE_DONE_MS;
        } else if (ev.what === 'bonusLost') {
          banner.classList.remove('is-on');
          objectiveBanner.lost(ev.kind);
          objectiveBannerUntil = now + UI_CONFIG.OBJECTIVE_BANNER_MS;
        } else if (ev.what === 'site') {
          const sites = state.run?.objective?.sites ?? [];
          sites.forEach((site, index) => { if (site.lit) litSites.add(index); });
          if (typeof ev.index === 'number') litSites.add(ev.index);
          const lit = Math.max(litSites.size, 1);
          feed.push({ key: 'site', icon: 'ritual', tone: 'objective', priority: FEED_PRIORITY.INFO, text: t('toast.objective.site', { n: lit, m: Math.max(sites.length, lit) }) });
        } else if (ev.what === 'anchorHit' && now - anchorCalloutAt >= UI_CONFIG.ANCHOR_CALLOUT_GAP_MS) {
          anchorCalloutAt = now;
          feed.push({ key: 'anchor', icon: 'defend', tone: 'anchor', priority: FEED_PRIORITY.NOTICE, text: t('toast.objective.anchorHit') });
        }
        break;
      }
      case 'wave': {
        if (state.run?.tutorial || (ev.wave <= 1 && performance.now() < Math.max(actBannerUntil, objectiveBannerUntil))) break;
        const final = ev.wave >= ev.waveCount && ev.waveCount > 1;
        showBanner(final ? t('toast.waveFinal') : t('toast.wave', { n: ev.wave }),
          final ? t('hud.wave', { n: ev.wave, m: ev.waveCount }) : t('toast.waveSub', { m: ev.waveCount }), 'wave');
        break;
      }
      case 'chamberClear':
        // A special objective has just announced its own completion: do not talk over it.
        if (!state.run?.tutorial && performance.now() >= objectiveBannerUntil) showBanner(t('toast.chamberClear'), t('toast.chamberClearSub'), 'clear');
        break;
      case 'bossPhase':
        showBanner(
          t('toast.bossPhase', { name: state.run ? bossLabel(state.run).name : enemyName('regent'), n: roman(ev.phase) }),
          t('toast.bossPhaseSub'), 'boss');
        break;
      case 'doorChosen':
        if (state.run?.tutorial) break;
        showBanner(t(`toast.door.${ev.type}`),
          t(`toast.door.${ev.type}Sub`, { boss: enemyName(state.run?.finalBoss ?? 'regent') }), `door-${ev.type}`);
        break;
      case 'boon': {
        if (ev.slot === own) break;
        const boon = formatBoon(ev.id, ev.level).name;
        const name = nameOf(ev.slot);
        feed.push({
          key: `boon-${ev.slot}`, icon: 'boon', tone: 'boon', priority: FEED_PRIORITY.LOW,
          text: ev.level > 1 ? t('toast.boonLevel', { name, boon, n: ev.level }) : t('toast.boon', { name, boon }),
        });
        break;
      }
      case 'down':
        feed.dropItem('revive', nameOf(ev.slot));
        feed.push({
          key: 'down', icon: 'skull', tone: 'down', priority: FEED_PRIORITY.ALERT, item: nameOf(ev.slot),
          list: (names) => (names.length === 1 ? t('toast.down', { name: names[0] }) : t('toast.downMany', { names: formatList(names) })),
        });
        break;
      case 'revived': {
        // Whoever is back up leaves the "is down" line.
        feed.dropItem('down', nameOf(ev.slot));
        const by = ev.by >= 0 && ev.by !== ev.slot ? nameOf(ev.by) : '';
        feed.push({
          key: 'revive', icon: 'revive', tone: 'revive', priority: FEED_PRIORITY.NOTICE, item: nameOf(ev.slot),
          list: (names) => (names.length > 1 ? t('toast.revivedMany', { names: formatList(names) })
            : by !== '' ? t('toast.revived', { by, name: names[0] }) : t('toast.revivedSelf', { name: names[0] })),
        });
        break;
      }
      default:
        break;
    }
  };

  const onLocalAction = (action: LocalAction, slot?: string): void => {
    if (action === 'ultimate') { ultimate.fired(); return; }
    if (action !== 'denied') { flash(action, 'is-fired', UI_CONFIG.ACTION_FLASH_MS); return; }
    const me = self();
    const secondaryBlocked = !me || me.cdSecondary > 0;
    const dashBlocked = !me || me.dashCharges <= 0;
    const ultBlocked = !me || me.ult < 1;
    if (slot === 'ultimate' || slot === 'secondary' || slot === 'dash') {
      if (slot === 'ultimate') ultimate.denied();
      else flash(slot, 'is-denied', UI_CONFIG.DENIED_FLASH_MS);
      return;
    }
    // The event does not say which button was refused: shake what is not ready. The ultimate only shakes when
    // nothing else can have been meant, so an empty charge does not flicker on every early right-click.
    if (secondaryBlocked) flash('secondary', 'is-denied', UI_CONFIG.DENIED_FLASH_MS);
    if (dashBlocked) flash('dash', 'is-denied', UI_CONFIG.DENIED_FLASH_MS);
    if (ultBlocked && !secondaryBlocked && !dashBlocked) ultimate.denied();
  };

  const reset = (): void => {
    tips.reset();
    strip.reset();
    feed.reset();
    buffs.reset();
    keystones.reset();
    engineFeed.classList.remove('is-on');
    affixSeen.clear();
    wardSeen.clear();
    litSites.clear();
    anchorCalloutAt = -Infinity;
    objective.reset();
    objectiveBanner.hide();
    objectiveBannerUntil = 0;
    banner.classList.remove('is-on');
    lastBiome = null;
    lastChamber = -1;
    actBannerUntil = 0;
  };

  return {
    el, sync, syncHud, onEvent, onLocalAction, reset,
    dismissTip: () => tips.dismiss(),
    dispose: () => { window.clearTimeout(bannerTimer); objectiveBanner.hide(); coach.dispose?.(); strip.dispose?.(); tips.dispose?.(); feed.dispose(); keystones.dispose(); },
  };
}
