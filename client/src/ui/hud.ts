/**
 * In-game HUD. The whole layer is pointer-events:none and never captures keys; it only reads GameState.
 * Static structure is built once, the ~15 Hz `syncHud` only touches text / custom properties that changed.
 */
import { RUN, WORLD } from '@shared/constants.ts';
import { ENEMY_TUNING } from '@shared/data/enemies.ts';
import { PF, type AbilitySlot, type DoorType, type GameEvent, type PlayerSnap } from '@shared/types.ts';
import { self, selfRoster, state } from '../core/GameState.ts';
import { h, icon, key, retrigger, setAttr, setText, setVar, show, toggle } from './dom.ts';
import { DOOR_TEXT_PARAMS, formatBoon, roman, t, type I18nKey } from './i18n.ts';
import { ABILITY_ICON, ABILITY_SLOTS, infusionOf, maxDashCharges, nameOf } from './model.ts';
import { UI_CONFIG } from './store.ts';
import type { View } from './view.ts';
import type { IconName } from './icons.ts';

const PERCENT = 100;
const DOOR_LEGEND: readonly DoorType[] = ['boon', 'blessing', 'cursed', 'boss'];

export interface HudView extends View {
  syncHud(): void;
  onEvent(ev: GameEvent): void;
  onLocalAction(action: 'primary' | 'secondary' | 'dash' | 'denied'): void;
}

interface PartyFrame {
  el: HTMLElement;
  hp: HTMLElement;
  shield: HTMLElement;
  revive: HTMLElement;
  tag: HTMLElement;
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
    const key = JSON.stringify([state.conn.slot, state.roster.map((p) => [p.slot, p.name, p.cls])]);
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
      const el = h('div', { class: `gg-party-frame gg-cls-${p.cls}` },
        h('span', { class: 'gg-party-emblem' }, icon(p.cls)),
        h('div', { class: 'gg-party-main' },
          h('div', { class: 'gg-party-name' }, p.name),
          h('div', { class: 'gg-party-row' }, h('div', { class: 'gg-party-hp' }, hp, shield, revive), tag),
        ),
      );
      frames.set(p.slot, { el, hp, shield, revive, tag });
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
  const boss = h('div', { class: 'gg-boss', 'data-testid': 'hud-boss' },
    h('div', { class: 'gg-boss-head' }, icon('boss'), bossName),
    h('div', { class: 'gg-boss-bar' }, bossGhost, bossFill, bossMarks),
  );
  const bannerTitle = h('div', { class: 'gg-banner-title' });
  const bannerSub = h('div', { class: 'gg-banner-sub' });
  const banner = h('div', { class: 'gg-banner', role: 'status' }, bannerTitle, bannerSub);
  const bossSlot = h('div', { class: 'gg-boss-slot' });
  const topCentre = h('div', { class: 'gg-hud-tc' }, track, waveLine, bossSlot, banner);
  let trackKey = '';
  let bossKey = '';
  let bannerTimer = 0;

  const showBanner = (title: string, sub: string, tone: string): void => {
    setText(bannerTitle, title);
    setText(bannerSub, sub);
    banner.dataset.tone = tone;
    retrigger(banner, 'is-on');
    window.clearTimeout(bannerTimer);
    bannerTimer = window.setTimeout(() => banner.classList.remove('is-on'), UI_CONFIG.BANNER_MS);
  };

  const renderTrack = (): void => {
    const run = state.run;
    if (!run) return;
    const k = `${run.chamber}|${run.oath}|${run.entered}`;
    if (k === trackKey) return;
    trackKey = k;
    setAttr(track, 'data-chamber', String(run.chamber));
    const list = h('ol', { class: 'gg-track-list', 'aria-label': t('hud.chamber', { n: run.chamber + 1, m: RUN.CHAMBERS.length }) });
    RUN.CHAMBERS.forEach((kind, i) => {
      const cls = i < run.chamber ? 'is-done' : i === run.chamber ? 'is-current' : '';
      const cursed = i === run.chamber && run.entered === 'cursed' ? ' is-cursed' : '';
      list.append(h('li', { class: `gg-track-node is-${kind} ${cls}${cursed}`, title: t(`chamber.${kind}`) }, icon(kind)));
    });
    const badge = run.oath > 0
      ? h('span', { class: 'gg-oath-badge', title: t('oath.badge', { n: roman(run.oath) }) }, icon('bell'), roman(run.oath))
      : null;
    track.replaceChildren(...(badge ? [badge, list] : [list]));
  };

  const syncRun = (): void => {
    const run = state.run;
    if (!run) return;
    renderTrack();
    const combat = run.phase === 'combat';
    setText(waveText,
      combat ? t('hud.wave', { n: Math.max(1, run.wave), m: Math.max(1, run.waveCount) })
        : run.phase === 'draft' ? t('hud.phase.draft')
          : run.phase === 'doors' ? t('hud.phase.doors') : '');
    const entered = run.entered === 'cursed' ? t('hud.entered.cursed') : run.entered === 'blessing' ? t('hud.entered.blessing') : '';
    setText(waveTag, entered);
    waveTag.dataset.type = run.entered;
    show(waveTag, entered !== '' && combat);
    toggle(el, 'gg-hud--draft', run.phase === 'draft');
    toggle(el, 'gg-hud--calm', !combat);

    const k = `${run.chamberKind}`;
    if (k !== bossKey) {
      bossKey = k;
      const regent = run.chamberKind === 'boss';
      setText(bossName, regent ? t('enemy.regent.name') : t('enemy.champion.name'));
      toggle(boss, 'is-regent', regent);
      bossMarks.replaceChildren();
      if (regent) {
        for (const threshold of ENEMY_TUNING.REGENT.PHASE_THRESHOLDS) {
          const mark = h('i');
          mark.style.left = pct(threshold);
          bossMarks.append(mark);
        }
      }
    }
  };

  // ------------------------------------------------------------ ping + feed (top-right)
  const pingText = h('span', { class: 'gg-num' });
  const ping = h('div', { class: 'gg-ping' }, icon('signal'), pingText);
  const roomCode = h('div', { class: 'gg-room-code' });
  const feed = h('ul', { class: 'gg-feed', 'aria-live': 'polite' });
  const reconnect = h('div', { class: 'gg-reconnect', role: 'alert', 'data-testid': 'reconnect-banner' },
    h('span', { class: 'gg-spinner' }), h('span', null, t('hud.reconnecting')));
  const reconnectSlot = h('div', { class: 'gg-reconnect-slot' });

  const pushFeed = (iconName: IconName, text: string, tone: string): void => {
    const item = h('li', { class: 'gg-feed-item', 'data-tone': tone }, icon(iconName), h('span', null, text));
    feed.append(item);
    while (feed.children.length > UI_CONFIG.FEED_MAX) feed.firstElementChild?.remove();
    window.setTimeout(() => {
      item.classList.add('is-leaving');
      window.setTimeout(() => item.remove(), 200);
    }, UI_CONFIG.FEED_MS);
  };

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
      const types = DOOR_LEGEND.filter((type) => run.doors.some((d) => d.type === type));
      const shown = types.length > 0 ? types : DOOR_LEGEND.slice(0, 3);
      renderPrompt(`doors|${shown.join(',')}|${run.doors.map((d) => d.type).join(',')}`, () => {
        const legend = h('div', { class: 'gg-door-legend' });
        for (const type of shown) {
          const fill = h('i');
          const index = run.doors.findIndex((d) => d.type === type);
          fill.dataset.door = String(index);
          doorBars.push(fill);
          legend.append(h('div', { class: `gg-door gg-door--${type}` },
            icon(type),
            h('div', null,
              h('b', null, t(`door.${type}.name`)),
              h('span', null, t(`door.${type}.desc`, DOOR_TEXT_PARAMS)),
            ),
            h('div', { class: 'gg-door-progress' }, fill),
          ));
        }
        return [line('door', t('hud.prompt.doors')), legend];
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

  const slots = new Map<AbilitySlot, AbilitySlotView>();
  const abilityBar = h('div', { class: 'gg-abilities' });
  for (const slot of ABILITY_SLOTS) {
    const iconBox = h('span', { class: 'gg-ability-icon' });
    const badge = h('span', { class: 'gg-ability-badge' });
    const pips = h('span', { class: 'gg-ability-pips' });
    const slotEl = h('div', { class: `gg-ability gg-ability--${slot}` },
      pips,
      h('div', { class: 'gg-ability-diamond' },
        h('div', { class: 'gg-ability-frame' }, iconBox, h('i', { class: 'gg-ability-sweep' })),
        badge,
      ),
      key(t(`hud.key.${slot}` as I18nKey)),
    );
    slots.set(slot, { el: slotEl, iconBox, badge, pips, iconName: null, element: '', pipCount: -1, ready: true });
    abilityBar.append(slotEl);
  }

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
      const iconName = ABILITY_ICON[cls][slot];
      if (view.iconName !== iconName) {
        view.iconName = iconName;
        view.iconBox.replaceChildren(icon(iconName));
      }
      const element = infusionOf(boons, slot) ?? '';
      if (view.element !== element) {
        view.element = element;
        view.el.dataset.element = element;
        view.badge.replaceChildren(...(element !== '' ? [icon(element as IconName)] : []));
      }
    }
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

  // ------------------------------------------------------------ root
  const el = h('div', { class: 'gg-hud', 'data-testid': 'hud-root' },
    vignette,
    h('div', { class: 'gg-hud-tl' }, party),
    topCentre,
    h('div', { class: 'gg-hud-tr' }, h('div', { class: 'gg-net' }, ping, roomCode), feed),
    reconnectSlot,
    h('div', { class: 'gg-hud-bl' }, vitals),
    h('div', { class: 'gg-hud-bc' }, prompt, abilityBar),
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
    const hp = state.bossHp;
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
  };

  const sync = (): void => {
    renderParty();
    syncRun();
    syncNet();
    syncHud();
  };

  const onEvent = (ev: GameEvent): void => {
    const own = state.conn.slot;
    switch (ev.e) {
      case 'wave': {
        const final = ev.wave >= ev.waveCount && ev.waveCount > 1;
        showBanner(final ? t('toast.waveFinal') : t('toast.wave', { n: ev.wave }),
          final ? t('hud.wave', { n: ev.wave, m: ev.waveCount }) : t('toast.waveSub', { m: ev.waveCount }), 'wave');
        break;
      }
      case 'chamberClear':
        showBanner(t('toast.chamberClear'), t('toast.chamberClearSub'), 'clear');
        break;
      case 'bossPhase':
        showBanner(
          t('toast.bossPhase', {
            name: state.run?.chamberKind === 'elite' ? t('enemy.champion.name') : t('enemy.regent.name'), n: roman(ev.phase),
          }),
          t('toast.bossPhaseSub'), 'boss');
        break;
      case 'doorChosen':
        showBanner(t(`toast.door.${ev.type}`), t(`toast.door.${ev.type}Sub`), `door-${ev.type}`);
        break;
      case 'boon': {
        if (ev.slot === own) break;
        const boon = formatBoon(ev.id, ev.level).name;
        const name = nameOf(ev.slot);
        pushFeed('boon', ev.level > 1 ? t('toast.boonLevel', { name, boon, n: ev.level }) : t('toast.boon', { name, boon }), 'boon');
        break;
      }
      case 'down':
        pushFeed('skull', t('toast.down', { name: nameOf(ev.slot) }), 'down');
        break;
      case 'revived':
        pushFeed('revive', ev.by >= 0 && ev.by !== ev.slot
          ? t('toast.revived', { by: nameOf(ev.by), name: nameOf(ev.slot) })
          : t('toast.revivedSelf', { name: nameOf(ev.slot) }), 'revive');
        break;
      default:
        break;
    }
  };

  const onLocalAction = (action: 'primary' | 'secondary' | 'dash' | 'denied'): void => {
    if (action !== 'denied') { flash(action, 'is-fired', UI_CONFIG.ACTION_FLASH_MS); return; }
    const me = self();
    if (!me || me.cdSecondary > 0) flash('secondary', 'is-denied', UI_CONFIG.DENIED_FLASH_MS);
    if (!me || me.dashCharges <= 0) flash('dash', 'is-denied', UI_CONFIG.DENIED_FLASH_MS);
  };

  return { el, sync, syncHud, onEvent, onLocalAction, dispose: () => window.clearTimeout(bannerTimer) };
}
