/**
 * Audio entry point. `initAudio()` only wires listeners; the AudioContext is created on the first
 * 'ui:gesture', and only then do the samples start loading (tier by tier, in the background). Audio is
 * strictly optional: every path is guarded so a missing / blocked Web Audio API or a failed download can
 * never throw into the game — until a sample is decoded its event plays the synthesised fallback.
 *
 * Music state machine (crossfades of ~1.5 s):
 *   screen loading           -> none
 *   screen menu / lobby      -> menu
 *   screen game, combat      -> combat | elite | boss (by run.chamberKind; the boss piece follows the boss kind,
 *                               its intensity follows 'bossPhase')
 *   screen game, draft/doors -> calm
 *   victory / defeat         -> stinger, then the menu bed under the summary
 * Ambience and the tint of the score follow run.room.biome; boss chambers switch the reverb to the hall.
 */
import { BOON_BY_ID } from '@shared/data/boons.ts';
import { CLASSES, secondaryOf } from '@shared/data/classes.ts';
import { STATUS } from '@shared/data/enemies.ts';
import { BOSS_KINDS, ELEMENT_IDS, type BossKind, type ClassId, type ElementId, type EnemyKind, type GameEvent } from '@shared/types.ts';
import { bus } from '../core/EventBus.ts';
import { selfRoster, state } from '../core/GameState.ts';
import { settings } from '../core/Settings.ts';
import { createAmbience, type Ambience } from './ambience.ts';
import { createGraph, MIX, setLevel, type AudioGraph } from './engine.ts';
import { createMusic, MUSIC, type Music, type MusicState } from './music.ts';
import { createBank, type Bank, type BankStats } from './samples.ts';
import { createSfx, type Sfx } from './sfx.ts';
import { abilityInfo } from './sfx-abilities.ts';

const CONFIG = {
  /** A server 'cast' for the own hero is ignored when the local action already made the sound this recently. */
  LOCAL_ECHO_S: 0.45,
  /** Minimum spacing of local primary sounds (holding the button must not machine-gun). */
  PRIMARY_MIN_GAP_S: 0.16,
  /** The combo counter falls back to the first swing after this pause. */
  COMBO_RESET_S: 1.1,
  SUSPEND_DELAY_MS: 120,
  DRAFT_TICK_SECONDS: 5,
  HOVER_SELECTOR: 'button, [role="button"], [role="radio"], [role="switch"], [role="tab"], [data-sfx]',
  SFX_ATTRIBUTE: 'data-sfx',
  /** A click is silent when a bus-driven interface sound (ready, draft pick) was played this recently. */
  CLICK_AFTER_INTENT_S: 0.06,
  /** Burn ticks are a few points of ember damage; anything this small and elemental is a tick, not a blow. */
  TICK_DAMAGE_FACTOR: 1.5,
  /** Hits this soon after a Resonance, carrying its second element, are its splash damage. */
  SPLASH_WINDOW_S: 0.08,
  MAX_TRACKED_ENEMIES: 256,
  /** A click this soon after the profile changed is the purchase that changed it (same task, in practice 0 ms). */
  PURCHASE_CLICK_MS: 80,
  SET_ID_PREFIX: 'set_',
} as const;

/** What a click on a progression page bought, read from how the profile changed. */
type Purchase = 'buy' | 'ascend' | 'talent' | 'relic' | 'unequip' | 'claim' | 'art';

interface Engine {
  ctx: AudioContext;
  graph: AudioGraph;
  bank: Bank;
  music: Music;
  sfx: Sfx;
  ambience: Ambience;
}

let engine: Engine | null = null;
let failed = false;
let stingerUntil = 0;
let stingerTimer = 0;
let lastTick = -1;
let lastHover: Element | null = null;
let lastIntentSound = -1;
let lastChamber = -1;
const lastLocal = { primary: -1, secondary: -1, dash: -1, ultimate: -1 };
let purchase: { kind: Purchase; at: number } | null = null;
let profileMark = '';
let profileParts: ReturnType<typeof profileState> | null = null;
let legendaryShown = '';
const lastResonance = { at: -1, el: null as ElementId | null };
let combo = 0;
/** What is known about living enemies from 'spawn' events (kind decides hit / cast timbres). */
const enemies = new Map<number, EnemyKind>();

type AudioContextCtor = typeof AudioContext;

function contextCtor(): AudioContextCtor | null {
  const w = window as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

/** Runs audio code; any failure disables nothing else and never propagates. */
function safe(fn: (e: Engine) => void): void {
  if (!engine) return;
  try {
    fn(engine);
  } catch (err) {
    console.warn('[audio] ignored error', err);
  }
}

function applyVolumes(e: Engine): void {
  const now = e.ctx.currentTime;
  setLevel(e.graph.master.gain, document.hidden ? 0 : settings.master, now);
  setLevel(e.graph.music.gain, settings.music * MIX.MUSIC_TRIM, now);
  setLevel(e.graph.sfx.gain, settings.sfx * MIX.SFX_TRIM, now);
}

function desiredMusic(): MusicState {
  const run = state.run;
  switch (state.screen) {
    case 'loading': return 'none';
    case 'menu':
    case 'lobby':
    case 'summary': return 'menu';
    case 'game':
      if (!run) return 'calm';
      if (run.phase === 'combat') return run.chamberKind === 'boss' ? 'boss' : run.chamberKind === 'elite' ? 'elite' : 'combat';
      if (run.phase === 'victory' || run.phase === 'defeat') return 'none';
      return 'calm';
  }
}

function asBoss(kind: EnemyKind | null | undefined): BossKind | null {
  return kind && (BOSS_KINDS as readonly string[]).includes(kind) ? (kind as BossKind) : null;
}

/** The boss whose piece the 'boss' state should play. */
function bossOfRun(): BossKind {
  const run = state.run;
  return asBoss(run?.bossKind) ?? run?.finalBoss ?? 'regent';
}

function updateScene(e: Engine): void {
  const run = state.run;
  const inGame = state.screen === 'game';
  const biome = inGame ? run?.room?.biome ?? 'crypt' : null;
  e.ambience.setBiome(biome);
  if (biome) e.music.setBiome(biome);
  e.graph.setSpace(inGame && run?.chamberKind === 'boss' ? 'hall' : 'room');
  e.music.setBossKind(bossOfRun());
  e.music.setDepth(inGame ? run?.depth ?? 0 : 0);
  if (e.ctx.currentTime < stingerUntil) return; // let the stinger breathe; a timer resumes afterwards
  e.music.setState(desiredMusic());
}

function playStinger(e: Engine, kind: 'victory' | 'defeat'): void {
  const cleared = state.run?.cleared ?? 0;
  e.music.stinger(kind, kind === 'victory' ? Math.max(1, cleared) : cleared);
  stingerUntil = e.ctx.currentTime + MUSIC.STINGER_SECONDS;
  window.clearTimeout(stingerTimer);
  stingerTimer = window.setTimeout(() => safe((eng) => { stingerUntil = 0; updateScene(eng); }), MUSIC.STINGER_SECONDS * 1000);
}

function start(): void {
  if (engine || failed) {
    // A later gesture may be needed to resume a context the browser suspended.
    if (engine && engine.ctx.state === 'suspended' && !document.hidden) void engine.ctx.resume().catch(() => undefined);
    return;
  }
  try {
    const Ctor = contextCtor();
    if (!Ctor) { failed = true; return; }
    const ctx = new Ctor({ latencyHint: 'interactive' });
    const graph = createGraph(ctx);
    const bank = createBank(ctx);
    const sfx = createSfx(graph, bank);
    engine = { ctx, graph, bank, sfx, music: createMusic(graph, sfx.player), ambience: createAmbience(graph, sfx.player) };
    graph.master.gain.value = 0;
    applyVolumes(engine);
    void ctx.resume().catch(() => undefined);
    // Samples arrive in the background; nothing waits for them.
    void bank.load();
    window.setInterval(() => safe((e) => {
      if (e.ctx.state !== 'running') return;
      e.music.schedule();
      e.ambience.schedule();
    }), MUSIC.TICK_MS);
    updateScene(engine);
  } catch (err) {
    failed = true;
    engine = null;
    console.warn('[audio] unavailable', err);
  }
}

function onVisibility(): void {
  safe((e) => {
    if (document.hidden) {
      setLevel(e.graph.master.gain, 0, e.ctx.currentTime);
      window.setTimeout(() => { if (document.hidden) void e.ctx.suspend().catch(() => undefined); }, CONFIG.SUSPEND_DELAY_MS);
    } else {
      void e.ctx.resume().catch(() => undefined);
      applyVolumes(e);
    }
  });
}

function classOfSlot(slot: number): ClassId | null {
  return state.roster.find((p) => p.slot === slot)?.cls ?? null;
}

function kindOfEnemy(id: number): EnemyKind | null {
  return enemies.get(id) ?? (id === state.run?.bossId ? state.run.bossKind : null);
}

function onCast(e: Engine, ev: Extract<GameEvent, { e: 'cast' }>): void {
  if (ev.who.t === 'e') { e.sfx.enemyCast(ev.ability, kindOfEnemy(ev.who.id)); return; }
  const own = ev.who.id === state.conn.slot;
  const now = e.ctx.currentTime;
  if (ev.ability === 'dash') {
    if (!(own && now - lastLocal.dash < CONFIG.LOCAL_ECHO_S)) e.sfx.dash(own);
    return;
  }
  const info = abilityInfo(ev.ability);
  if (!info) { if (!own) e.sfx.primary(classOfSlot(ev.who.id) ?? 'knight', 0, false); return; }
  if (own && now - lastLocal[info.slot] < CONFIG.LOCAL_ECHO_S) return;
  e.sfx.ability(ev.ability, own);
}

function onBoon(e: Engine, id: string, own: boolean): void {
  if (BOON_BY_ID.get(id)?.rarity === 'legendary') e.sfx.legendaryPicked(own);
  else e.sfx.boon(own);
}

/** A legendary boon among the own draft cards is announced once per draft. */
function onDraft(): void {
  safe((e) => {
    const legendary = state.draft.filter((offer) => BOON_BY_ID.get(offer.id)?.rarity === 'legendary').map((offer) => offer.id).join(',');
    if (legendary && legendary !== legendaryShown) e.sfx.legendaryOffered();
    legendaryShown = legendary;
  });
}

const total = (levels: Record<string, number>): number => Object.values(levels).reduce((sum, n) => sum + (Number.isFinite(n) ? n : 0), 0);

function profileState() {
  const p = state.profile;
  return {
    meta: total(p.meta), paragon: total(p.paragon), feats: total(p.feats),
    talents: JSON.stringify(p.talents), relics: p.relics.join(','), arts: JSON.stringify(p.arts),
  };
}

/**
 * The progression pages buy through GameState helpers that announce `state:profile`; the click that caused it
 * reaches the document listener right after. Comparing the profile tells which kind of purchase it was, so each
 * gets its own sound whatever `data-sfx` the button carries.
 */
function onProfile(): void {
  const next = profileState();
  const mark = JSON.stringify(next);
  if (mark === profileMark) return;
  const prev = profileParts;
  profileMark = mark;
  profileParts = next;
  if (!prev) return;
  let kind: Purchase | null = null;
  if (next.paragon > prev.paragon) kind = 'ascend';
  else if (next.meta > prev.meta) kind = 'buy';
  else if (next.feats > prev.feats) kind = 'claim';
  else if (next.talents !== prev.talents) kind = 'talent';
  else if (next.relics !== prev.relics) kind = next.relics.length >= prev.relics.length && next.relics !== '' ? 'relic' : 'unequip';
  else if (next.arts !== prev.arts) kind = 'art';
  if (kind) purchase = { kind, at: performance.now() };
}

function playPurchase(e: Engine, kind: Purchase): void {
  switch (kind) {
    case 'buy': e.sfx.buy(); break;
    case 'ascend': e.sfx.ascendRank(); break;
    case 'talent': e.sfx.talentPick(); break;
    case 'relic': e.sfx.relicEquip(); break;
    case 'unequip': e.sfx.equip(); break;
    case 'claim': e.sfx.claim(); break;
    case 'art': e.sfx.artPick(); break;
  }
}

function onHit(e: Engine, ev: Extract<GameEvent, { e: 'hit' }>): void {
  const own = state.conn.slot;
  if (ev.target.t === 'p') { e.sfx.hurt(ev.target.id === own, ev.dmg); return; }
  const kind = kindOfEnemy(ev.target.id);
  const now = e.ctx.currentTime;
  const splash = ev.el !== null && ev.el === lastResonance.el && now - lastResonance.at < CONFIG.SPLASH_WINDOW_S;
  const burn = ev.el === 'ember' && !ev.crit && ev.dmg <= STATUS.BURN.DPS * CONFIG.TICK_DAMAGE_FACTOR;
  e.sfx.hit({
    dmg: ev.dmg, crit: ev.crit, el: ev.el, own: ev.by === own,
    shielded: ev.dmg <= 0,
    boss: kind === 'champion' || asBoss(kind) !== null || ev.target.id === state.run?.bossId,
    weapon: classOfSlot(ev.by),
    tick: ev.by < 0 || splash || burn,
  });
}

function onGameEvent(ev: GameEvent): void {
  safe((e) => {
    const own = state.conn.slot;
    switch (ev.e) {
      case 'hit': onHit(e, ev); break;
      case 'kill':
        e.sfx.kill(ev.kind, ev.by === own);
        enemies.delete(ev.id);
        break;
      case 'resonance':
        lastResonance.at = e.ctx.currentTime;
        lastResonance.el = ev.b;
        e.sfx.resonance(ev.a, ev.b, ev.by === own);
        break;
      case 'status': e.sfx.status(ev.el); break;
      case 'telegraph': e.sfx.telegraph(ev.dur); break;
      case 'cast': onCast(e, ev); break;
      case 'aoe': e.sfx.aoe(ev.el, ev.hostile); break;
      case 'heal': e.sfx.heal(ev.slot === own); break;
      case 'down': e.sfx.down(ev.slot === own); break;
      case 'revived': e.sfx.revived(ev.slot === own); break;
      case 'shieldBreak': e.sfx.shieldBreak(); break;
      case 'spawn':
        if (enemies.size >= CONFIG.MAX_TRACKED_ENEMIES) enemies.clear();
        enemies.set(ev.id, ev.kind);
        e.sfx.spawn(ev.kind, ev.elite, ev.elite ? ev.affix ?? null : null);
        break;
      case 'wave': e.sfx.wave(); break;
      case 'chamberClear': e.sfx.chamberClear(); break;
      case 'bossPhase':
        e.sfx.bossPhase(ev.phase, state.run?.bossKind ?? null);
        e.music.setBossPhase(ev.phase);
        break;
      case 'boon': onBoon(e, ev.id, ev.slot === own); break;
      case 'doorChosen': e.sfx.doorChosen(ev.type); break;
      case 'tutorialStep': e.sfx.tutorialStep(); break;
      case 'hazardHit':
        e.sfx.hazard(ev.kind, ev.target.t === 'e' ? 'enemy' : ev.target.id === own ? 'own' : 'ally');
        break;
      case 'zone': e.sfx.zone(ev.id, ev.kind, ev.dur, ev.el, ev.by === own); break;
      case 'zoneEnd': e.sfx.zoneEnd(ev.id, ev.sprung); break;
      case 'buff': e.sfx.buff(ev.id, ev.slot === own); break;
      case 'mark': e.sfx.mark(); break;
      case 'ultReady': e.sfx.ultReady(ev.slot === own); break;
      case 'descend':
        e.sfx.descend(ev.depth);
        e.music.setDepth(ev.depth);
        break;
      case 'set':
        e.sfx.setBonus(ev.tier, ELEMENT_IDS.find((el) => ev.id === `${CONFIG.SET_ID_PREFIX}${el}`) ?? null, ev.slot === own);
        break;
    }
  });
}

function onLocalAction(action: 'primary' | 'secondary' | 'dash' | 'ultimate' | 'denied'): void {
  safe((e) => {
    const now = e.ctx.currentTime;
    const cls = selfRoster()?.cls ?? state.profile.cls;
    if (action === 'denied') { e.sfx.denied(); return; }
    if (action === 'primary') {
      if (now - lastLocal.primary < CONFIG.PRIMARY_MIN_GAP_S) return;
      const chain = CLASSES[cls].primary.length;
      combo = now - lastLocal.primary > CONFIG.COMBO_RESET_S ? 0 : (combo + 1) % chain;
      e.sfx.ability(CLASSES[cls].primary[combo].id, true);
    } else if (action === 'secondary') {
      // the art chosen in the loadout replaces the standard secondary
      e.sfx.ability(secondaryOf(CLASSES[cls], selfRoster()?.art ?? state.profile.arts[cls] ?? 0).id, true);
    } else if (action === 'ultimate') {
      e.sfx.ability(CLASSES[cls].ultimate.id, true);
    } else {
      e.sfx.dash(true);
    }
    lastLocal[action] = now;
  });
}

function onRun(previousPhase: string | null): void {
  safe((e) => {
    const run = state.run;
    if (!run || run.chamber !== lastChamber) {
      enemies.clear();
      lastChamber = run?.chamber ?? -1;
    }
    if (run && (run.phase === 'victory' || run.phase === 'defeat') && previousPhase !== run.phase) playStinger(e, run.phase);
    if (!run || run.phase !== 'combat' || run.chamberKind !== 'boss') e.music.setBossPhase(1);
    updateScene(e);
    // countdown ticks in the last seconds of a draft the player has not answered yet
    if (run && run.phase === 'draft' && state.draft.length > 0) {
      const left = Math.ceil(run.draftTime);
      if (left > 0 && left <= CONFIG.DRAFT_TICK_SECONDS && left !== lastTick) {
        lastTick = left;
        e.sfx.countdownTick(left === 1);
      }
    } else {
      lastTick = -1;
    }
  });
}

function interactive(target: EventTarget | null): Element | null {
  if (!(target instanceof Element)) return null;
  const el = target.closest(CONFIG.HOVER_SELECTOR);
  if (!el || (el instanceof HTMLButtonElement && el.disabled) || el.getAttribute('aria-disabled') === 'true') return null;
  return el;
}

/** Interface sound for a click on `el`: its `data-sfx` value, or the default click. */
function playUi(e: Engine, el: Element): void {
  switch (el.getAttribute(CONFIG.SFX_ATTRIBUTE)) {
    case 'hover': break; // hover-only element
    case 'confirm': e.sfx.confirm(); break;
    case 'back': e.sfx.back(); break;
    case 'error': e.sfx.error(); break;
    case 'buy': e.sfx.buy(); break;
    case 'equip': e.sfx.equip(); break;
    case 'tab': e.sfx.tab(); break;
    case 'toggle': e.sfx.toggle(); break;
    case 'ascend': e.sfx.ascendRank(); break;
    case 'talent': e.sfx.talentPick(); break;
    case 'relic': e.sfx.relicEquip(); break;
    case 'claim': e.sfx.claim(); break;
    case 'art': e.sfx.artPick(); break;
    default: e.sfx.click(); break;
  }
}

/** A bus-driven interface sound; the click that caused it stays silent. */
function intentSound(fn: (e: Engine) => void): void {
  safe((e) => {
    lastIntentSound = e.ctx.currentTime;
    fn(e);
  });
}

export function initAudio(): void {
  try {
    bus.on('ui:gesture', start);
    // Later gestures: resume a context that the browser kept suspended.
    window.addEventListener('pointerdown', () => { if (engine) start(); }, true);

    bus.on('settings:changed', () => safe(applyVolumes));
    document.addEventListener('visibilitychange', onVisibility);

    bus.on('state:screen', () => safe(updateScene));
    bus.on('state:run', ({ previousPhase }) => onRun(previousPhase));
    bus.on('game:event', onGameEvent);
    bus.on('game:localAction', ({ action }) => onLocalAction(action));
    // run rewards booked: experience ticks, level-up fanfare, relic shards, feats — in that order
    bus.on('game:progress', (p) => safe((e) => e.sfx.progress({ xp: p.xp, levelsGained: p.levelsGained, relics: p.relics, featsReady: p.featsReady })));
    bus.on('state:draft', onDraft);
    onProfile();
    bus.on('state:profile', onProfile);

    // UI feedback: intents on the bus + one delegated hover / click listener for every control.
    // Controls may name their sound with data-sfx="hover|click|confirm|back|error|buy|equip|tab|toggle" or, on the
    // progression pages, "ascend|talent|relic|claim|art". A purchase recognised from the profile wins over both.
    bus.on('ui:lobby', (p) => { if (p.ready !== undefined) intentSound((e) => e.sfx.ready(p.ready === true)); });
    bus.on('ui:pick', () => intentSound((e) => e.sfx.draftPick()));
    bus.on('net:error', () => safe((e) => e.sfx.error()));
    document.addEventListener('pointerover', (ev) => {
      const el = interactive(ev.target);
      if (el === lastHover) return;
      lastHover = el;
      if (el) safe((e) => e.sfx.hover());
    });
    document.addEventListener('click', (ev) => {
      const el = interactive(ev.target);
      const bought = purchase && performance.now() - purchase.at < CONFIG.PURCHASE_CLICK_MS ? purchase.kind : null;
      purchase = null;
      if (bought) safe((e) => playPurchase(e, bought));
      else if (el) safe((e) => { if (e.ctx.currentTime - lastIntentSound > CONFIG.CLICK_AFTER_INTENT_S) playUi(e, el); });
    });
  } catch (err) {
    console.warn('[audio] init failed', err);
  }
}

export interface AudioDebug {
  state: string;
  music: MusicState;
  tracks: number;
  time: number;
  /** Which piece is playing (e.g. "boss:matron"). */
  piece: string | null;
  biome: string | null;
  space: string;
  samples: BankStats;
  /** Sample voices sounding now / source nodes started and not yet ended (leak check). */
  voices: number;
  liveNodes: number;
  /** Per-event mix nodes still plugged in (they are unplugged a few seconds after their sound). */
  mixNodes: number;
  /** Events that played a designed stack vs. the synthesised fallback so far. */
  designed: number;
  fallbacks: number;
  /** Output peak of the last analyser window, 0..1. */
  peak: number;
}

/** Dev / test hook: the live engine's state, or null before the first gesture. */
export function audioDebug(): AudioDebug | null {
  if (!engine) return null;
  const sfx = engine.sfx.stats();
  return {
    state: engine.ctx.state, music: engine.music.state(), tracks: engine.music.trackCount(), time: engine.ctx.currentTime,
    piece: engine.music.key(), biome: engine.ambience.biome(), space: engine.graph.space(), samples: engine.bank.stats(),
    voices: sfx.voices, liveNodes: engine.graph.live.count, mixNodes: sfx.mixNodes, designed: sfx.designed, fallbacks: sfx.fallbacks,
    peak: engine.graph.meter(),
  };
}

/** Dev workbench only: direct handles to the running engine (null before the first gesture). */
export function audioInternals(): Engine | null {
  return engine;
}
