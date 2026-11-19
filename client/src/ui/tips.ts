/**
 * First-time contextual tips. Each tip is shown once per profile (ui/prefs.ts), one at a time, never during
 * training, a draft or a boss windup. Tips dismiss themselves after a while or with Enter; the HUD stays
 * click-through, so there is no button to press with the mouse.
 *
 * Polish 1 — tips no longer pile up behind each other:
 *  - new foes that arrive together share one compact card ("New foes", one line each);
 *  - a tip that cannot be shown within TIP_QUEUE_MAX_MS is dropped unseen and returns with its next trigger;
 *  - a downed hero only ever sees the tip about being down;
 *  - during a fight a tip leaves after TIP_COMBAT_SECONDS.
 * Every tip can be read again in the codex (tab "Tips").
 */
import { BOON_TUNING } from '@shared/data/boons.ts';
import { ENEMY_TUNING } from '@shared/data/enemies.ts';
import { RUN, WORLD } from '@shared/constants.ts';
import { HAZARD_TIMING } from '@shared/sim/hazards.ts';
import { SETS } from '@shared/data/boons.ts';
import type { AffixId, ElementId, EnemyKind, GameEvent } from '@shared/types.ts';
import { self, selfRoster, state } from '../core/GameState.ts';
import { h, icon, key } from './dom.ts';
import { bossLabel, distinctElements, enemyName, infusionsOf, resonanceParams, statusParams } from './elements.ts';
import type { IconName } from './icons.ts';
import { formatNum, roman, t, type Params } from './i18n.ts';
import { ABILITY_ICON, nameOf } from './model.ts';
import { affixBody, affixName, setName, setTierText } from './text.ts';
import { markTipSeen, tipSeen, tipsEnabled } from './prefs.ts';
import { mark, rich } from './rich.ts';
import { UI_CONFIG } from './store.ts';
import type { View } from './view.ts';

const PERCENT = 100;
const MS = 1000;
/** A tip interrupted by a draft counts as read once it was visible this long. */
const READ_MS = 4000;
const pctMore = (mul: number): number => Math.round((mul - 1) * PERCENT);

export const TIP_IDS = [
  'status.ember', 'status.rime', 'status.storm', 'resonance', 'ally', 'hazard', 'cursed', 'downed', 'elite', 'boss',
  // update 3
  'status.umbra', 'ultimate', 'descend', 'affix', 'set',
  // update 4: the five new foes, warded enemies, objectives on the doors
  'enemy.shaman', 'enemy.aegis', 'enemy.bomber', 'enemy.necromancer', 'enemy.reaver', 'ward', 'objective',
  // update 5: shown inside the draft overlay (ui/draft.ts), since tip cards never cover a draft
  'keystone', 'fits',
] as const;
export type TipId = (typeof TIP_IDS)[number];

export interface TipContent {
  id: TipId;
  icon: IconName;
  tone: string;
  title: string;
  /** Rich markup (see rich.ts). */
  body: string;
}

export interface TipsView extends View {
  onEvent(ev: GameEvent): void;
  /** Run state changed (new chamber, phase, doors). */
  onRun(): void;
  /** Called at HUD rate: shows the next queued tip as soon as nothing forbids it. */
  pump(): void;
  /** Enter: closes the visible tip. Returns false when none was open. */
  dismiss(): boolean;
  /** The session screen was left: forget queued tips; a visible one comes back next time. */
  reset(): void;
}

/** Builds the text of a tip from the live state (exported for the dev harness and the codex of tips). */
export interface TipDetail {
  /** Element of a ward (`ward` tip). */
  ward?: ElementId;
  name?: string;
  a?: ElementId;
  b?: ElementId;
  affix?: AffixId;
  set?: string;
  tier?: number;
}

export const NEW_FOES = ['shaman', 'aegis', 'bomber', 'necromancer', 'reaver'] as const;
export type NewFoe = (typeof NEW_FOES)[number];
export const FOE_ICON: Record<NewFoe, IconName> = { shaman: 'shaman', aegis: 'aegis', bomber: 'bomber', necromancer: 'necromancer', reaver: 'reaver' };
const isNewFoe = (kind: EnemyKind): kind is NewFoe => (NEW_FOES as readonly string[]).includes(kind);

/** Numbers quoted in the texts about a new foe (description, counter and first-encounter tip), from ENEMY_TUNING. */
export function foeParams(kind: EnemyKind): Params {
  switch (kind) {
    case 'shaman':
      return { r: ENEMY_TUNING.SHAMAN.MEND_RADIUS, v: Math.round(ENEMY_TUNING.SHAMAN.MEND_FRACTION * PERCENT), t: formatNum(ENEMY_TUNING.SHAMAN.MEND_WINDUP) };
    case 'aegis':
      return { r: formatNum(ENEMY_TUNING.AEGIS.DOME_RADIUS), v: Math.round(ENEMY_TUNING.AEGIS.DOME_REDUCTION * PERCENT), t: formatNum(ENEMY_TUNING.AEGIS.DOME_REARM_SECONDS) };
    case 'bomber':
      return { r: formatNum(ENEMY_TUNING.BOMBER.BLAST_RADIUS), d: formatNum(ENEMY_TUNING.BOMBER.DEATH_BLAST_DELAY), m: formatNum(ENEMY_TUNING.BOMBER.ENEMY_DAMAGE_MUL) };
    case 'necromancer':
      return { n: ENEMY_TUNING.NECROMANCER.RAISE_COUNT, max: ENEMY_TUNING.NECROMANCER.MAX_RAISED };
    case 'reaver':
      return { t: formatNum(ENEMY_TUNING.REAVER.LEAP_AIR_TIME), r: formatNum(ENEMY_TUNING.REAVER.LEAP_RADIUS) };
    default:
      return {};
  }
}

export function tipContent(id: TipId, detail: TipDetail = {}): TipContent {
  switch (id) {
    case 'status.ember':
    case 'status.rime':
    case 'status.storm':
    case 'status.umbra': {
      const el = id.slice('status.'.length) as ElementId;
      return { id, icon: el, tone: el, title: t(`tip.status.${el}.title`), body: t(`tip.status.${el}.body`, statusParams(el)) };
    }
    case 'resonance':
      return { id, icon: 'resonance', tone: 'res', title: t('tip.resonance.title'), body: t('tip.resonance.body', resonanceParams()) };
    case 'ally': {
      const a = detail.a ?? 'ember';
      const b = detail.b ?? 'rime';
      return {
        id, icon: 'resonance', tone: 'res', title: t('tip.ally.title'),
        body: t('tip.ally.body', {
          name: detail.name ?? '', a: mark(a, t(`element.${a}.name`)), b: mark(b, t(`element.${b}.name`)),
        }),
      };
    }
    case 'hazard': {
      const kind = state.run?.room?.hazards[0]?.kind ?? 'spikes';
      return {
        id, icon: kind, tone: `hazard-${kind}`, title: t('tip.hazard.title', { name: t(`hazard.${kind}.name`) }),
        body: t('tip.hazard.body', { warn: HAZARD_TIMING.WARN }),
      };
    }
    case 'cursed':
      return {
        id, icon: 'cursed', tone: 'cursed', title: t('tip.cursed.title'),
        body: t('tip.cursed.body', {
          hp: pctMore(ENEMY_TUNING.ELITE_HP_MUL), dmg: pctMore(ENEMY_TUNING.ELITE_DAMAGE_MUL), n: BOON_TUNING.CURSED_DRAFT_CHOICES,
        }),
      };
    case 'downed': {
      const solo = state.roster.length <= 1;
      return {
        id, icon: 'revive', tone: 'danger', title: t('tip.downed.title'),
        body: solo ? t('tip.downedSolo.body', { n: RUN.SOLO_SECOND_WINDS }) : t('tip.downed.body', { t: WORLD.REVIVE_SECONDS }),
      };
    }
    case 'elite':
      return { id, icon: 'elite', tone: 'danger', title: t('tip.elite.title'), body: t('tip.elite.body', { name: enemyName('champion') }) };
    case 'boss': {
      const run = state.run;
      const name = detail.name ?? (run ? bossLabel(run).name : enemyName('regent'));
      return { id, icon: 'boss', tone: 'danger', title: t('tip.boss.title', { name }), body: t('tip.boss.body') };
    }
    case 'ultimate': {
      const cls = selfRoster()?.cls ?? state.profile.cls;
      return { id, icon: ABILITY_ICON[cls].ultimate, tone: 'ultimate', title: t('tip.ultimate.title'), body: t('tip.ultimate.body', { name: t(`class.${cls}.ultimate.name`) }) };
    }
    case 'descend':
      return { id, icon: 'descend', tone: 'res', title: t('tip.descend.title'), body: t('tip.descend.body', { n: RUN.CHAMBERS.length }) };
    case 'affix': {
      const affix = detail.affix ?? 'swift';
      return { id, icon: 'affix', tone: 'danger', title: t('tip.affix.title', { name: affixName(affix) }), body: t('tip.affix.body', { body: affixBody(affix) }) };
    }
    case 'enemy.shaman':
    case 'enemy.aegis':
    case 'enemy.bomber':
    case 'enemy.necromancer':
    case 'enemy.reaver': {
      const kind = id.slice('enemy.'.length) as NewFoe;
      return {
        id, icon: FOE_ICON[kind], tone: 'danger', title: t('tip.enemy.title', { name: enemyName(kind) }),
        body: t(`tip.enemy.${kind}.body`, foeParams(kind)),
      };
    }
    case 'ward': {
      const el = detail.ward ?? 'ember';
      return { id, icon: 'warded', tone: el, title: t('tip.ward.title'), body: t('tip.ward.body', { element: mark(el, t(`element.${el}.name`)) }) };
    }
    case 'objective':
      return { id, icon: 'hunt', tone: 'res', title: t('tip.objective.title'), body: t('tip.objective.body') };
    case 'keystone':
      return { id, icon: 'keystone', tone: 'res', title: t('tip.keystone.title'), body: t('tip.keystone.body') };
    case 'fits':
      return { id, icon: 'keystone', tone: 'res', title: t('tip.fits.title'), body: t('tip.fits.body') };
    case 'set': {
      const def = SETS.find((set) => set.id === detail.set) ?? SETS[0];
      const tier = detail.tier ?? 1;
      return {
        id, icon: def.element ?? def.category ?? 'boon', tone: 'res', title: t('tip.set.title'),
        body: t('tip.set.body', { name: `${setName(def)} ${roman(tier)}`, effect: setTierText(def, tier) }),
      };
    }
  }
}

/** `data-tip` of the card that introduces several new foes at once. */
export const FOES_TIP = 'enemy.group';
const isFoeTip = (id: TipId): boolean => id.startsWith('enemy.');
const foeOf = (id: TipId): NewFoe => id.slice('enemy.'.length) as NewFoe;

interface Queued {
  content: TipContent;
  /** performance.now() of the offer: a tip that waits too long is dropped unseen (its next trigger brings it back). */
  at: number;
}

interface Shown {
  /** One tip, or several new-foe tips sharing one card. */
  tips: TipContent[];
  since: number;
  timer: number;
}

export function createTips(): TipsView {
  const el = h('div', { class: 'gg-tip-slot', 'aria-live': 'polite' });
  const queue: Queued[] = [];
  let current: Shown | null = null;
  let bossBusyUntil = 0;
  let nextAt = 0;
  let retry = 0;

  /** Nothing may be shown: no run, training, a draft, the end of the run, a boss winding up. */
  const blocked = (): boolean => {
    const run = state.run;
    if (!run || state.screen !== 'game' || run.tutorial) return true;
    if (run.phase === 'draft' || run.phase === 'victory' || run.phase === 'defeat') return true;
    return performance.now() < bossBusyUntil;
  };

  /** A downed hero has other worries: only the tip about being down may show. */
  const ownDown = (): boolean => {
    const me = self();
    return me !== null && me.state !== 'alive';
  };

  const allowed = (id: TipId): boolean => id === 'downed' || !ownDown();

  /** Seconds a card stays: shorter during a fight, a little longer per extra foe on a shared card. */
  const lifetime = (count: number): number => {
    const base = state.run?.phase === 'combat' ? UI_CONFIG.TIP_COMBAT_SECONDS : UI_CONFIG.TIP_SECONDS;
    return count <= 1 ? base : Math.max(base, Math.min(UI_CONFIG.TIP_FOES_MAX_SECONDS, UI_CONFIG.TIP_COMBAT_SECONDS + (count - 1) * UI_CONFIG.TIP_FOE_SECONDS));
  };

  const close = (seen: boolean): void => {
    if (!current) return;
    const { tips, timer } = current;
    window.clearTimeout(timer);
    for (const content of tips) if (seen) markTipSeen(content.id);
    // Not read: back into the queue, where it waits a moment and otherwise returns with its next trigger.
    if (!seen) queue.unshift(...tips.map((content) => ({ content, at: performance.now() })));
    current = null;
    el.replaceChildren();
    nextAt = performance.now() + UI_CONFIG.TIP_GAP_MS;
  };

  const foot = (hint: string | null): HTMLElement =>
    h('div', { class: 'gg-tip-foot' },
      hint !== null ? h('span', { class: 'gg-tip-more' }, icon('codex'), hint) : null,
      key('Enter'), h('span', null, t('tip.dismiss')));

  const card = (tips: TipContent[]): HTMLElement => {
    if (tips.length === 1) {
      const content = tips[0];
      return h('aside', { class: 'gg-tip', 'data-testid': 'tip-root', 'data-tip': content.id, 'data-tone': content.tone },
        h('div', { class: 'gg-tip-head' },
          h('span', { class: 'gg-tip-icon' }, icon(content.icon)),
          h('div', null,
            h('span', { class: 'gg-tip-label' }, icon('tip'), t('tip.label')),
            h('b', { class: 'gg-tip-title' }, content.title),
          ),
        ),
        h('p', { class: 'gg-tip-body' }, ...rich(content.body)),
        foot(null),
        h('i', { class: 'gg-tip-timer' }),
      );
    }
    // Several new foes at once: one compact card, one line each. The full texts are in the codex.
    const foes = tips.map((content) => foeOf(content.id));
    return h('aside', { class: 'gg-tip gg-tip--foes', 'data-testid': 'tip-root', 'data-tip': FOES_TIP, 'data-foes': foes.join(' '), 'data-tone': 'danger' },
      h('div', { class: 'gg-tip-head' },
        h('span', { class: 'gg-tip-icon' }, icon('skull')),
        h('div', null,
          h('span', { class: 'gg-tip-label' }, icon('tip'), t('tip.label')),
          h('b', { class: 'gg-tip-title' }, t('tip.foes.title')),
        ),
      ),
      h('ul', { class: 'gg-tip-foes' }, ...foes.map((kind) =>
        h('li', { 'data-foe': kind },
          icon(FOE_ICON[kind]),
          h('div', null, h('b', null, enemyName(kind)), h('span', null, t(`tip.enemy.${kind}.short`))),
        ))),
      foot(t('tip.foes.more')),
      h('i', { class: 'gg-tip-timer' }),
    );
  };

  const open = (tips: TipContent[]): void => {
    if (current) window.clearTimeout(current.timer);
    const seconds = lifetime(tips.length);
    const view = card(tips);
    view.style.setProperty('--tip-s', `${seconds}s`);
    // A card that only gained a line does not slide in again.
    if (current) view.classList.add('is-updated');
    el.replaceChildren(view);
    current = { tips, since: current?.since ?? performance.now(), timer: window.setTimeout(() => close(true), seconds * MS) };
  };

  const known = (id: TipId): boolean => current?.tips.some((c) => c.id === id) === true || queue.some((q) => q.content.id === id);

  const offer = (id: TipId, detail?: TipDetail, urgent = false): void => {
    if (!tipsEnabled() || tipSeen(id) || state.run?.tutorial || known(id)) return;
    const now = performance.now();
    const content = tipContent(id, detail);
    // A new foe joins the card that is already introducing new foes instead of waiting behind it.
    if (isFoeTip(id) && current && current.tips.every((c) => isFoeTip(c.id)) && !blocked() && allowed(id)) {
      open([...current.tips, content]);
      return;
    }
    if (urgent) queue.unshift({ content, at: now });
    else queue.push({ content, at: now });
    // Tips of the same moment (a wave's spawns) are looked at together; an urgent one does not wait.
    if (!current && !urgent) nextAt = Math.max(nextAt, now + UI_CONFIG.TIP_COLLECT_MS);
  };

  /** Drops what waited too long. Only tips whose trigger comes again are affected (all of them do). */
  const prune = (): void => {
    const now = performance.now();
    for (let i = queue.length - 1; i >= 0; i--) if (now - queue[i].at > UI_CONFIG.TIP_QUEUE_MAX_MS) queue.splice(i, 1);
  };

  function pump(): void {
    prune();
    // Being down cannot wait behind another tip or a pause.
    const downedAt = queue.findIndex((q) => q.content.id === 'downed');
    if (current) {
      const read = performance.now() - current.since >= READ_MS;
      if (!tipsEnabled()) close(true);
      else if (blocked()) close(read);
      else if (!current.tips.every((c) => allowed(c.id))) close(read);
      else if (downedAt >= 0 && current.tips[0].id !== 'downed') {
        const [urgent] = queue.splice(downedAt, 1);
        close(read);
        open([urgent.content]);
      }
      if (current || downedAt < 0) return;
    }
    if (queue.length === 0) return;
    if (!tipsEnabled()) { queue.length = 0; return; }
    if (downedAt >= 0) {
      const at = queue.findIndex((q) => q.content.id === 'downed');
      if (at >= 0 && !blocked()) open([queue.splice(at, 1)[0].content]);
      return;
    }
    const wait = Math.max(nextAt, bossBusyUntil) - performance.now();
    if (wait > 0) {
      // Pause between two tips / boss windup: come back by ourselves instead of relying on the next HUD update.
      window.clearTimeout(retry);
      retry = window.setTimeout(pump, wait + 1);
      return;
    }
    if (blocked()) return;
    const index = queue.findIndex((q) => allowed(q.content.id) && !tipSeen(q.content.id));
    if (index < 0) return;
    const [next] = queue.splice(index, 1);
    if (!isFoeTip(next.content.id)) { open([next.content]); return; }
    // Every new foe that is waiting shares the card.
    const foes = [next.content];
    for (let i = queue.length - 1; i >= 0; i--) {
      if (isFoeTip(queue[i].content.id) && !tipSeen(queue[i].content.id)) foes.splice(1, 0, ...queue.splice(i, 1).map((q) => q.content));
    }
    open(foes);
  }

  const onEvent = (ev: GameEvent): void => {
    const own = state.conn.slot;
    switch (ev.e) {
      case 'hit': {
        if (ev.target.t !== 'e' || !ev.el || ev.by < 0) break;
        if (ev.by === own) { offer(`status.${ev.el}`); break; }
        if (tipSeen('ally') || !tipsEnabled()) break; // hits are frequent: skip the look-up below once it is moot
        const mine = distinctElements(infusionsOf(selfRoster()?.boons ?? [])).find((el2) => el2 !== ev.el);
        if (mine) offer('ally', { name: nameOf(ev.by), a: ev.el, b: mine });
        break;
      }
      case 'resonance': offer('resonance'); break;
      case 'down': if (ev.slot === own) offer('downed', undefined, true); break;
      case 'ultReady': if (ev.slot === own) offer('ultimate'); break;
      case 'spawn':
        if (isNewFoe(ev.kind)) offer(`enemy.${ev.kind}`);
        if (ev.ward) offer('ward', { ward: ev.ward });
        if (ev.affix) offer('affix', { affix: ev.affix });
        break;
      case 'set': if (ev.slot === own) offer('set', { set: ev.id, tier: ev.tier }); break;
      case 'telegraph': {
        const bossId = state.run?.bossId ?? -1;
        if (bossId >= 0 && ev.src === bossId) bossBusyUntil = Math.max(bossBusyUntil, performance.now() + ev.dur * MS);
        break;
      }
      default: break;
    }
    pump();
  };

  const onRun = (): void => {
    const run = state.run;
    if (!run || run.tutorial) { if (!run) queue.length = 0; pump(); return; }
    if (run.phase === 'combat') {
      if (run.chamberKind === 'boss') offer('boss');
      else if (run.chamberKind === 'elite') offer(bossLabel(run).herald ? 'boss' : 'elite');
      if ((run.room?.hazards.length ?? 0) > 0) offer('hazard');
    }
    if (run.phase === 'doors' && run.doors.some((d) => d.type === 'cursed')) offer('cursed');
    if (run.phase === 'doors' && run.doors.some((d) => d.type === 'descend')) offer('descend', undefined, true);
    if (run.phase === 'doors' && run.doors.some((d) => d.objective !== undefined && d.objective !== 'slay')) offer('objective');
    pump();
  };

  const dismiss = (): boolean => {
    if (!current) return false;
    close(true);
    return true;
  };

  const reset = (): void => {
    if (current) close(false);
    queue.length = 0;
    bossBusyUntil = 0;
    nextAt = 0;
    window.clearTimeout(retry);
  };

  return {
    el, sync: pump, onEvent, onRun, pump, dismiss, reset,
    dispose: () => { if (current) window.clearTimeout(current.timer); window.clearTimeout(retry); },
  };
}
