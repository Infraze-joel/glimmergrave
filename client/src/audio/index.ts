/**
 * Audio entry point. `initAudio()` only wires listeners; the AudioContext is created on the first
 * 'ui:gesture'. Audio is strictly optional: every path is guarded so a missing / blocked Web Audio API
 * can never throw into the game.
 *
 * Music state machine (crossfades of ~1.5 s):
 *   screen loading           -> none
 *   screen menu / lobby      -> menu
 *   screen game, combat      -> combat | elite | boss (by run.chamberKind; boss intensity follows 'bossPhase')
 *   screen game, draft/doors -> calm
 *   victory / defeat         -> stinger, then the menu bed under the summary
 */
import { CLASSES } from '@shared/data/classes.ts';
import type { ClassId, GameEvent } from '@shared/types.ts';
import { bus } from '../core/EventBus.ts';
import { selfRoster, state } from '../core/GameState.ts';
import { settings } from '../core/Settings.ts';
import { createGraph, MIX, setLevel, type AudioGraph } from './engine.ts';
import { createAmbience, createMusic, MUSIC, type Ambience, type Music, type MusicState } from './music.ts';
import { createSfx, type Sfx } from './sfx.ts';

const CONFIG = {
  /** A server 'cast' for the own hero is ignored when the local action already made the sound this recently. */
  LOCAL_ECHO_S: 0.45,
  /** Minimum spacing of local primary sounds (holding the button must not machine-gun). */
  PRIMARY_MIN_GAP_S: 0.16,
  /** The combo counter falls back to the first swing after this pause. */
  COMBO_RESET_S: 1.1,
  SUSPEND_DELAY_MS: 120,
  DRAFT_TICK_SECONDS: 5,
  HOVER_SELECTOR: 'button, [role="button"], [role="radio"], [role="switch"]',
} as const;

interface Engine {
  ctx: AudioContext;
  graph: AudioGraph;
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
const lastLocal = { primary: -1, secondary: -1, dash: -1 };
let combo = 0;

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

function updateMusic(e: Engine): void {
  if (state.screen === 'game') e.ambience.start();
  else e.ambience.stop();
  if (e.ctx.currentTime < stingerUntil) return; // let the stinger breathe; a timer resumes afterwards
  e.music.setState(desiredMusic());
}

function playStinger(e: Engine, kind: 'victory' | 'defeat'): void {
  e.music.stinger(kind);
  stingerUntil = e.ctx.currentTime + MUSIC.STINGER_SECONDS;
  window.clearTimeout(stingerTimer);
  stingerTimer = window.setTimeout(() => safe((eng) => { stingerUntil = 0; updateMusic(eng); }), MUSIC.STINGER_SECONDS * 1000);
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
    engine = { ctx, graph, music: createMusic(graph), sfx: createSfx(graph), ambience: createAmbience(graph) };
    graph.master.gain.value = 0;
    applyVolumes(engine);
    void ctx.resume().catch(() => undefined);
    window.setInterval(() => safe((e) => { if (e.ctx.state === 'running') e.music.schedule(); }), MUSIC.TICK_MS);
    updateMusic(engine);
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

function classOfSlot(slot: number): ClassId {
  return state.roster.find((p) => p.slot === slot)?.cls ?? 'knight';
}

/** Which class + combo step an ability id such as "knight_slash3" belongs to. */
function describeAbility(id: string): { cls: ClassId; slot: 'primary' | 'secondary'; step: number } | null {
  for (const def of Object.values(CLASSES)) {
    const step = def.primary.findIndex((a) => a.id === id);
    if (step >= 0) return { cls: def.id, slot: 'primary', step: def.primary.length === 2 && step === 1 ? 2 : step };
    if (def.secondary.id === id) return { cls: def.id, slot: 'secondary', step: 0 };
  }
  return null;
}

function onCast(e: Engine, ev: Extract<GameEvent, { e: 'cast' }>): void {
  if (ev.who.t === 'e') { e.sfx.enemyCast(); return; }
  const own = ev.who.id === state.conn.slot;
  const now = e.ctx.currentTime;
  if (ev.ability === 'dash') {
    if (!(own && now - lastLocal.dash < CONFIG.LOCAL_ECHO_S)) e.sfx.dash(own);
    return;
  }
  const info = describeAbility(ev.ability);
  if (!info) { if (!own) e.sfx.primary(classOfSlot(ev.who.id), 0, false); return; }
  if (own && now - lastLocal[info.slot] < CONFIG.LOCAL_ECHO_S) return;
  if (info.slot === 'primary') e.sfx.primary(info.cls, info.step, own);
  else e.sfx.secondary(info.cls, own);
}

function onGameEvent(ev: GameEvent): void {
  safe((e) => {
    const own = state.conn.slot;
    switch (ev.e) {
      case 'hit':
        if (ev.target.t === 'p') e.sfx.hurt(ev.target.id === own, ev.dmg);
        else e.sfx.hit({ dmg: ev.dmg, crit: ev.crit, el: ev.el, own: ev.by === own });
        break;
      case 'kill': e.sfx.kill(ev.kind, ev.by === own); break;
      case 'resonance': e.sfx.resonance(ev.a, ev.b, ev.by === own); break;
      case 'status': e.sfx.status(ev.el); break;
      case 'telegraph': e.sfx.telegraph(ev.dur); break;
      case 'cast': onCast(e, ev); break;
      case 'aoe': e.sfx.aoe(ev.el, ev.hostile); break;
      case 'heal': e.sfx.heal(ev.slot === own); break;
      case 'down': e.sfx.down(ev.slot === own); break;
      case 'revived': e.sfx.revived(ev.slot === own); break;
      case 'shieldBreak': e.sfx.shieldBreak(); break;
      case 'spawn': e.sfx.spawn(ev.kind, ev.elite); break;
      case 'wave': e.sfx.wave(); break;
      case 'chamberClear': e.sfx.chamberClear(); break;
      case 'bossPhase':
        e.sfx.bossPhase();
        e.music.setBossPhase(ev.phase);
        break;
      case 'boon': e.sfx.boon(ev.slot === own); break;
      case 'doorChosen': e.sfx.doorChosen(ev.type); break;
    }
  });
}

function onLocalAction(action: 'primary' | 'secondary' | 'dash' | 'denied'): void {
  safe((e) => {
    const now = e.ctx.currentTime;
    const cls = selfRoster()?.cls ?? state.profile.cls;
    if (action === 'denied') { e.sfx.denied(); return; }
    if (action === 'primary') {
      if (now - lastLocal.primary < CONFIG.PRIMARY_MIN_GAP_S) return;
      const chain = CLASSES[cls].primary.length;
      combo = now - lastLocal.primary > CONFIG.COMBO_RESET_S ? 0 : (combo + 1) % chain;
      e.sfx.primary(cls, chain === 2 && combo === 1 ? 2 : combo, true);
    } else if (action === 'secondary') {
      e.sfx.secondary(cls, true);
    } else {
      e.sfx.dash(true);
    }
    lastLocal[action] = now;
  });
}

function onRun(previousPhase: string | null): void {
  safe((e) => {
    const run = state.run;
    if (run && (run.phase === 'victory' || run.phase === 'defeat') && previousPhase !== run.phase) playStinger(e, run.phase);
    if (!run || run.phase !== 'combat' || run.chamberKind !== 'boss') e.music.setBossPhase(1);
    updateMusic(e);
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

export function initAudio(): void {
  try {
    bus.on('ui:gesture', start);
    // Later gestures: resume a context that the browser kept suspended.
    window.addEventListener('pointerdown', () => { if (engine) start(); }, true);

    bus.on('settings:changed', () => safe(applyVolumes));
    document.addEventListener('visibilitychange', onVisibility);

    bus.on('state:screen', () => safe(updateMusic));
    bus.on('state:run', ({ previousPhase }) => onRun(previousPhase));
    bus.on('game:event', onGameEvent);
    bus.on('game:localAction', ({ action }) => onLocalAction(action));

    // UI feedback: intents on the bus + generic hover / click on real controls.
    bus.on('ui:lobby', (p) => { if (p.ready !== undefined) safe((e) => e.sfx.ready(p.ready === true)); });
    bus.on('ui:pick', () => safe((e) => e.sfx.draftPick()));
    bus.on('net:error', () => safe((e) => e.sfx.error()));
    document.addEventListener('pointerover', (ev) => {
      const el = interactive(ev.target);
      if (el === lastHover) return;
      lastHover = el;
      if (el) safe((e) => e.sfx.hover());
    });
    document.addEventListener('click', (ev) => { if (interactive(ev.target)) safe((e) => e.sfx.click()); });
  } catch (err) {
    console.warn('[audio] init failed', err);
  }
}

/** Dev / test hook: the live engine, or null before the first gesture. */
export function audioDebug(): { state: string; music: MusicState; tracks: number; time: number } | null {
  if (!engine) return null;
  return { state: engine.ctx.state, music: engine.music.state(), tracks: engine.music.trackCount(), time: engine.ctx.currentTime };
}
