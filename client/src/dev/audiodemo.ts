/**
 * Audio workbench (dev only): http://localhost:5177/?audiodemo
 *
 * One page to audition everything the audio module can do, without network or 3D:
 *   - every designed sound and variation on a button (direct calls into the running engine),
 *   - the same sounds as real 'game:event's on the bus (exercises the event mapping in audio/index.ts),
 *   - every music state / boss piece / phase / biome tint, the stingers, the three ambiences, both reverbs,
 *   - sliders for the master / music / effects volumes (the real settings),
 *   - an A/B switch between the designed (sample-based) sounds and the original synthesised fallbacks,
 *   - a stress button (60 hits + 20 kills + 6 Resonances in one second over boss music),
 *   - a peak meter after the master chain, and an offline measurement run (peak / loudness / DC per sound),
 *   - update 4: objective scenes with a simulated RunState.objective timeline (timer, braziers, shard), the five
 *     new enemy kinds as events, wards, and a stress case of bombers + ultimates + timer + Resonance chain.
 *
 * window.__audiodemo exposes the same actions for scripted checks.
 */
import { BOONS } from '@shared/data/boons.ts';
import { ABILITY_BY_ID, BUFFS, CLASSES } from '@shared/data/classes.ts';
import { ENEMIES, ENEMY_TUNING } from '@shared/data/enemies.ts';
import { KEYSTONES, KEYSTONE_TUNING } from '@shared/data/keystones.ts';
import { OBJECTIVE_TUNING } from '@shared/data/objectives.ts';
import {
  AFFIX_IDS, BIOME_IDS, BOSS_KINDS, CLASS_IDS, ELEMENT_IDS, OBJECTIVE_KINDS, PF,
  type BiomeId, type BossKind, type ClassId, type GameEvent, type ObjectiveKind, type ObjectiveState, type RosterEntry, type RunPhase, type RunState,
} from '@shared/types.ts';
import { audioDebug, audioInternals, initAudio, type AudioDebug } from '../audio/index.ts';
import { SAMPLES } from '../audio/manifest.ts';
import {
  BOSS_CUE_IDS, closestPairs, HORDE_SEQUENCES, keystoneStressEvents, loadOfflineBank, objectiveStressEvents, renderAmbience, renderKeystoneMasking,
  renderKeystoneStress, renderMusic, renderObjectiveStress, renderSequence,
  renderSfx, renderStinger, renderStress, renderStressTimed, renderUltimateStress, SFX_CASES, STRESS, stressEvents, ultimateStressEvents,
  type Closeness, type MaskingResult, type RenderStats,
} from '../audio/offline.ts';
import { keystoneFamily, unmappedKeystones } from '../audio/keystone-map.ts';
import { HORDE_KINDS } from '../audio/sfx-horde.ts';
import { KEYSTONE_SIGNATURE_IDS } from '../audio/sfx-keystones.ts';
import { abilitySoundTable, unmappedAbilities } from '../audio/sfx-abilities.ts';
import { bus } from '../core/EventBus.ts';
import { state, type Screen } from '../core/GameState.ts';
import { settings, updateSettings } from '../core/Settings.ts';

const DEMO = {
  OWN_SLOT: 0,
  ALLY_SLOT: 1,
  BOSS_ID: 1,
  ENEMY_ID: 7,
  SHIELD_ID: 9,
  METER_FLOOR_DB: -60,
  METER_WARN_DB: -1,
  METER_HOLD_MS: 1500,
  STATUS_MS: 200,
  CHAIN_GAP_MS: 350,
  STRESS_LISTEN_MS: 4000,
  DRAFT_SECONDS: 6,
  ZONE_ID: 100,
  MAX_DEPTH: 6,
  DEFAULT_RENDER_S: 3,
  // update 4
  HORDE_ID: 200,
  WARDED_ID: 260,
  /** How often the simulated server sends the run state during an objective (ms), and its jitter (ms). */
  RUN_STATE_MS: 250,
  RUN_STATE_JITTER_MS: 60,
  TIMELINE_SECONDS: 14,
} as const;

const CSS = `
#audiodemo { position: fixed; inset: 0; overflow: auto; background: #0b0d13; color: #d8dbe6; font: 13px/1.45 system-ui, sans-serif; padding: 16px 20px 60px; box-sizing: border-box; }
#audiodemo h1 { font-size: 18px; margin: 0 0 4px; color: #fff; }
#audiodemo h2 { font-size: 13px; margin: 18px 0 6px; color: #ffcf7a; text-transform: uppercase; letter-spacing: .08em; }
#audiodemo h3 { font-size: 12px; margin: 8px 0 3px; color: #9aa3c0; font-weight: 600; }
#audiodemo p { margin: 2px 0 6px; color: #9aa3c0; max-width: 980px; }
#audiodemo .row { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
#audiodemo button { padding: 4px 9px; background: #1b2030; border: 1px solid #39415c; border-radius: 4px; color: #e6e9f5; font: inherit; cursor: pointer; }
#audiodemo button:hover { background: #283050; }
#audiodemo button.on { background: #7a4a12; border-color: #ffb347; }
#audiodemo button.big { padding: 8px 16px; font-weight: 700; background: #2c4a2a; border-color: #6fbf6a; }
#audiodemo button.warn { background: #55212a; border-color: #d0626f; }
#audiodemo .bar { position: sticky; top: -16px; z-index: 2; background: #0b0d13; padding: 10px 0 8px; border-bottom: 1px solid #2a3046; display: grid; grid-template-columns: auto 1fr; gap: 6px 18px; align-items: center; }
#audiodemo .meter { position: relative; height: 16px; background: #161a26; border: 1px solid #39415c; border-radius: 3px; overflow: hidden; }
#audiodemo .meter i { position: absolute; left: 0; top: 0; bottom: 0; width: 0; background: linear-gradient(90deg, #3fae5a, #d7c84a 80%, #e0503a); }
#audiodemo .meter b { position: absolute; top: 0; bottom: 0; width: 2px; background: #fff; }
#audiodemo .meter s { position: absolute; top: 0; bottom: 0; width: 1px; background: #e0503a; }
#audiodemo label { display: inline-flex; gap: 6px; align-items: center; margin-right: 14px; }
#audiodemo input[type=range] { width: 150px; }
#audiodemo pre { background: #10131c; border: 1px solid #2a3046; padding: 8px; overflow: auto; max-height: 420px; font: 11px/1.4 ui-monospace, monospace; }
#audiodemo code { color: #b9c4ff; }
`;

// ------------------------------------------------------------------ fake game state

let chamber = 0;
let biome: BiomeId = 'crypt';
let ownClass: ClassId = 'knight';
let ownArt = 0;
let depth = 0;
let cleared = 0;
let zoneId: number = DEMO.ZONE_ID;
let objectiveKind: ObjectiveKind = 'slay';
let timelineTimer = 0;
/** Update 5: keystones per roster slot (the own hero is slot 0), as the roster would carry them. */
const keystonesOf = new Map<number, string[]>();
const LEGENDARY_ID = BOONS.find((b) => b.rarity === 'legendary')?.id ?? 'keen_edge';

function roster(): RosterEntry[] {
  const look = { color: 0, head: true, cape: true, style: 0 };
  return CLASS_IDS.map((cls, i) => ({
    slot: i, name: i === DEMO.OWN_SLOT ? 'You' : `Ally ${i}`, cls: i === DEMO.OWN_SLOT ? ownClass : cls, look,
    mastery: 1, art: i === DEMO.OWN_SLOT ? ownArt : 0, relics: 0, talents: 0, ready: true, connected: true, host: i === DEMO.OWN_SLOT, boons: [],
    keystones: keystonesOf.get(i) ?? [], keystoneAt: (keystonesOf.get(i) ?? []).map(() => 0),
  }));
}

/** A fresh objective state as the sim would start it. */
function fakeObjective(kind: ObjectiveKind, timeLeft = 0): ObjectiveState {
  return {
    kind, progress: 0, timeLeft, bonus: true, status: 'active',
    anchor: kind === 'defend' ? { x: 0, z: 0, r: OBJECTIVE_TUNING.DEFEND.RADIUS, hp: 1 } : null,
    sites: kind === 'ritual' ? Array.from({ length: OBJECTIVE_TUNING.RITUAL.SITES }, (_unused, i) => ({ x: i * 4, z: 0, r: OBJECTIVE_TUNING.RITUAL.RADIUS, progress: 0, lit: false })) : [],
    targets: kind === 'hunt' ? [DEMO.HORDE_ID + 50, DEMO.HORDE_ID + 51] : [],
  };
}

function fakeRun(phase: RunPhase, chamberKind: RunState['chamberKind'], boss: BossKind): RunState {
  return {
    objective: phase === 'combat' || phase === 'draft' || phase === 'doors' ? fakeObjective(chamberKind === 'combat' ? objectiveKind : 'slay') : null,
    phase, oath: 0, chamber, chamberKind, entered: 'boon', wave: 1, waveCount: 3,
    traits: [],
    room: { seed: 1, biome, w: 30, d: 30, obstacles: [], hazards: [], spawns: [] },
    doors: [], doorProgress: [], bossId: chamberKind === 'combat' ? -1 : DEMO.BOSS_ID, draftPending: [], draftTime: 0, elapsed: 0,
    stats: [], secondWinds: 0, bossKind: chamberKind === 'boss' ? boss : chamberKind === 'elite' ? 'champion' : null,
    finalBoss: boss, rewards: [], depth, cleared, chambersCleared: 0, tutorial: null, objectivesDone: 0, objectiveBonuses: 0,
  };
}

interface SceneDef { screen: Screen; phase?: RunPhase; kind?: RunState['chamberKind']; boss?: BossKind; objective?: ObjectiveKind }

const SCENES: Record<string, SceneDef> = {
  'silence (loading)': { screen: 'loading' },
  menu: { screen: 'menu' },
  lobby: { screen: 'lobby' },
  'game: combat': { screen: 'game', phase: 'combat', kind: 'combat' },
  ...Object.fromEntries(OBJECTIVE_KINDS.filter((k) => k !== 'slay').map((k): [string, SceneDef] => [`game: ${k}`, { screen: 'game', phase: 'combat', kind: 'combat', objective: k }])),
  'game: elite': { screen: 'game', phase: 'combat', kind: 'elite' },
  'game: boss – Bone Regent': { screen: 'game', phase: 'combat', kind: 'boss', boss: 'regent' },
  'game: boss – Hex Matron': { screen: 'game', phase: 'combat', kind: 'boss', boss: 'matron' },
  'game: boss – Ossuary Stalker': { screen: 'game', phase: 'combat', kind: 'boss', boss: 'stalker' },
  'game: draft (calm)': { screen: 'game', phase: 'draft', kind: 'combat' },
  'game: doors (calm)': { screen: 'game', phase: 'doors', kind: 'combat' },
  'victory stinger': { screen: 'game', phase: 'victory', kind: 'boss' },
  'defeat stinger': { screen: 'game', phase: 'defeat', kind: 'combat' },
  summary: { screen: 'summary' },
};

let sceneName = 'menu';

function scene(name: string, newChamber = true): void {
  const def = SCENES[name];
  if (!def) return;
  sceneName = name;
  window.clearInterval(timelineTimer);
  objectiveKind = def.objective ?? 'slay';
  const previous = state.run?.phase ?? null;
  if (newChamber) chamber++;
  state.conn.slot = DEMO.OWN_SLOT;
  state.roster = roster();
  state.screen = def.screen;
  state.run = def.phase ? fakeRun(def.phase, def.kind ?? 'combat', def.boss ?? state.run?.finalBoss ?? 'regent') : null;
  state.draft = [];
  state.draftKeystone = null;
  bus.emit('state:screen');
  bus.emit('state:run', { previousPhase: previous });
  paintActive();
}

function setBiome(next: BiomeId): void {
  biome = next;
  if (state.run?.room) {
    state.run.room = { ...state.run.room, biome };
    bus.emit('state:run', { previousPhase: state.run.phase });
  }
  paintActive();
}

/** Sets RunState.depth like a `descend` door does (the score follows at its next bar). */
function setDepth(next: number): void {
  depth = Math.max(0, Math.min(DEMO.MAX_DEPTH, next));
  if (state.run) {
    state.run.depth = depth;
    bus.emit('state:run', { previousPhase: state.run.phase });
  }
  paintActive();
}

function fire(ev: GameEvent): void {
  bus.emit('game:event', ev);
}

/** Changes the live objective state and announces it like a run message from the server. */
function patchObjective(patch: Partial<ObjectiveState>): void {
  const run = state.run;
  if (!run?.objective) return;
  run.objective = { ...run.objective, ...patch };
  bus.emit('state:run', { previousPhase: run.phase });
}

export interface TimelineResult { kind: ObjectiveKind; seconds: number; runStates: number; events: string[] }

/**
 * A whole chamber of objective `kind` in `seconds`, as the server would report it: the `start` event, run states
 * every RUN_STATE_MS (with jitter, like a network) carrying timeLeft / progress / shard health / brazier progress,
 * the milestones as `objective` events, and `done` at the end. `bonus` decides how it ends.
 */
function timeline(kind: ObjectiveKind, seconds: number = DEMO.TIMELINE_SECONDS, bonus = true): Promise<TimelineResult> {
  return new Promise((resolve) => {
    scene(`game: ${kind}`);
    const run = state.run;
    const timed = kind === 'survive' || kind === 'hunt' || kind === 'ritual';
    const events: string[] = [];
    const emit = (what: 'start' | 'site' | 'anchorHit' | 'bonusLost' | 'done', extra: { index?: number; bonus?: boolean } = {}): void => {
      events.push(what);
      fire({ e: 'objective', kind, what, ...extra });
    };
    if (run) run.objective = fakeObjective(kind, timed ? seconds : 0);
    bus.emit('state:run', { previousPhase: 'doors' });
    emit('start');
    const started = performance.now();
    let runStates = 0;
    let lit = 0;
    let lost = false;
    let lastHit = 0;
    const sites = OBJECTIVE_TUNING.RITUAL.SITES;
    const step = (): void => {
      const elapsed = (performance.now() - started) / 1000;
      const p = Math.min(1, elapsed / seconds);
      const o = state.run?.objective;
      if (!o || o.kind !== kind) return; // the scene was changed under the timeline
      if (kind === 'ritual') {
        // braziers catch at 30 %, 55 % and 80 % of the chamber
        const due = [0.3, 0.55, 0.8].filter((at) => p >= at).length;
        while (lit < Math.min(sites, due)) {
          o.sites[lit] = { ...o.sites[lit], progress: 1, lit: true };
          emit('site', { index: lit });
          lit++;
        }
      }
      if (kind === 'defend') {
        const hp = bonus ? 1 - p * 0.6 : Math.max(0, 1 - p * 1.6);
        if (elapsed - lastHit >= OBJECTIVE_TUNING.DEFEND.ANCHOR_HIT_EVENT_SECONDS && hp > 0) { lastHit = elapsed; emit('anchorHit'); }
        if (hp <= 0 && !lost) { lost = true; emit('bonusLost'); }
        patchObjective({ progress: p, anchor: o.anchor ? { ...o.anchor, hp } : null, bonus: !lost });
      } else if (kind === 'hunt' && !bonus) {
        // the hunt takes longer than its timer: enrage at 70 %
        const left = Math.max(0, seconds * 0.7 - elapsed);
        if (left <= 0 && !lost) { lost = true; emit('bonusLost'); }
        patchObjective({ progress: p, timeLeft: left, bonus: !lost });
      } else {
        patchObjective({ progress: kind === 'ritual' ? lit / sites : p, timeLeft: timed ? Math.max(0, seconds - elapsed) : 0, sites: o.sites });
      }
      runStates++;
      if (p >= 1) {
        window.clearInterval(timelineTimer);
        patchObjective({ status: 'done', timeLeft: 0, progress: 1 });
        emit('done', { bonus: bonus && !lost });
        if (kind !== 'vault') fire({ e: 'chamberClear' });
        resolve({ kind, seconds, runStates, events });
      }
    };
    window.clearInterval(timelineTimer);
    timelineTimer = window.setInterval(() => window.setTimeout(step, Math.random() * DEMO.RUN_STATE_JITTER_MS), DEMO.RUN_STATE_MS);
  });
}

/** Timer ticks the audio module scheduled since the log was last read: which second, for when, and when it was asked. */
export interface TickLogEntry { kind: ObjectiveKind; left: number; at: number; scheduledAt: number }
const tickLog: TickLogEntry[] = [];
let tickLogHooked = false;

/** Records every `timerTick` the live engine schedules (scripted checks of the timer clock). */
function hookTickLog(): void {
  const engine = audioInternals();
  if (!engine || tickLogHooked) return;
  tickLogHooked = true;
  const original = engine.sfx.timerTick;
  engine.sfx.timerTick = (kind, left, t) => {
    tickLog.push({ kind, left, at: t ?? engine.ctx.currentTime, scheduledAt: engine.ctx.currentTime });
    original(kind, left, t);
  };
  // which update 4 sounds the event mapping in audio/index.ts asks for, with their arguments
  const sfx = engine.sfx as unknown as Record<string, (...args: unknown[]) => unknown>;
  for (const name of LOGGED_CALLS) {
    const fn = sfx[name];
    sfx[name] = (...args: unknown[]) => {
      callLog.push(`${name}(${args.map((a) => (typeof a === 'number' ? Math.round(a * 100) / 100 : String(a))).join(',')})`);
      return fn(...args);
    };
  }
}

const LOGGED_CALLS = ['keystoneProc', 'keystoneTaken', 'keystoneDraftOpen', 'fitsPick', 'powerLayer', 'brittleHit', 'titanSwing', 'sanctumWalk', 'sanctumEnd', 'draftPick', 'heal', 'buff', 'interrupt', 'wardDeflect', 'hit', 'objectiveStart', 'siteLit', 'anchorHit', 'anchorShatter', 'huntEnrage', 'bonusLost', 'objectiveDone', 'dome', 'mendRelease', 'enemyCast', 'kill'] as const;
const callLog: string[] = [];

// ------------------------------------------------------------------ update 5: keystones as the server reports them

/** Sets the keystones of a roster slot and announces the roster, like the server does after a pick. */
function setKeystones(ids: string[], slot: number = DEMO.OWN_SLOT): void {
  keystonesOf.set(slot, ids.slice(0, KEYSTONE_TUNING.MAX_HELD));
  state.roster = roster();
  bus.emit('state:roster');
  paintActive();
}

/** A hero takes a keystone: the `keystone` event, then the roster (with full slots the oldest is replaced). */
function takeKeystone(id: string, slot: number = DEMO.OWN_SLOT): void {
  const before = keystonesOf.get(slot) ?? [];
  if (before.includes(id)) return;
  const replaced = before.length >= KEYSTONE_TUNING.MAX_HELD ? before[0] : undefined;
  fire(replaced === undefined ? { e: 'keystone', slot, id } : { e: 'keystone', slot, id, replaced });
  setKeystones([...before.filter((k) => k !== replaced), id], slot);
}

/** Opens / closes the own keystone draft the way net/ does: state first, then `state:draft`. */
function keystoneDraft(open: boolean, full = false): void {
  if (open && state.run?.phase !== 'draft') scene('game: draft (calm)');
  const own = keystonesOf.get(DEMO.OWN_SLOT) ?? [];
  const heldNow = full ? ['ricochet', 'familiar'] : own;
  if (full) setKeystones(heldNow);
  const options = KEYSTONES.filter((k) => !heldNow.includes(k.id) && (!k.cls || k.cls === ownClass)).slice(0, KEYSTONE_TUNING.CHOICES);
  state.draft = open ? options.map((k) => ({ id: k.id, level: 1 })) : [];
  state.draftKeystone = open ? { held: heldNow, skip: options.length } : null;
  bus.emit('state:draft');
}

/** An ordinary draft whose first offer fits the build (two tags), the second one tag, the third none. */
function fitsDraft(): void {
  if (state.run?.phase !== 'draft') scene('game: draft (calm)');
  state.draftKeystone = null;
  state.draft = [{ id: 'keen_edge', level: 1, fits: ['primary', 'melee'] }, { id: 'fleet_foot', level: 1, fits: ['speed'] }, { id: 'iron_heart', level: 1 }];
  bus.emit('state:draft');
}

/** Sets or clears PF.CHANNELING in the own hero's (or an ally's) snapshot row for `ms`, like a held Arc Stream. */
function channel(slot: number, ms: number): void {
  const row = () => state.players.find((p) => p.slot === slot);
  if (!row()) {
    state.players = [...state.players, {
      slot, x: 0, z: 0, rot: 0, hp: 100, maxHp: 100, shield: 0, state: 'alive', anim: 'idle', animSeq: 0, cdSecondary: 0, cdDash: 0, ult: 0.4,
      dashCharges: 1, revive: 0, flags: PF.CONNECTED,
    }];
  }
  const p = row();
  if (!p) return;
  p.flags |= PF.CHANNELING;
  window.setTimeout(() => { p.flags &= ~PF.CHANNELING; }, ms);
}

const proc = (id: string, slot: number, extra: { n?: number; r?: number; tx?: number; tz?: number } = {}): void => fire({ e: 'keystoneProc', slot, id, x: 0, z: 0, ...extra });

/**
 * Each keystone as the sim reports it (backend-update5.md): the events of one trigger, for hero `slot`. Keystones the
 * sim sends nothing for are shown through what the audio derives them from (the hero must hold the keystone).
 */
function keystoneTrigger(id: string, slot: number): void {
  const mine = slot === DEMO.OWN_SLOT;
  const hitEnemy = (): void => fire({ e: 'hit', target: { t: 'e', id: DEMO.ENEMY_ID }, ...at, dmg: 40, crit: false, el: null, by: slot });
  const press = (action: 'primary' | 'secondary' | 'dash', ability: string): void => {
    if (mine) bus.emit('game:localAction', { action });
    else fire({ e: 'cast', who: { t: 'p', id: slot }, ability, ...at, rot: 0 });
  };
  const cls = state.roster.find((p) => p.slot === slot)?.cls ?? 'knight';
  switch (id) {
    case 'ember_wake': proc(id, slot, { tx: 4, tz: 0, r: 0.8 }); break;
    case 'shockstep': fire({ e: 'aoe', ...at, r: 3.2, el: null, hostile: false }); proc(id, slot, { r: 3.2 }); break;
    case 'phase_walker': proc(id, slot); fire({ e: 'buff', slot, id, dur: 2 }); break;
    case 'ricochet': for (let i = 0; i < 2; i++) window.setTimeout(() => proc(id, slot, { n: 1 - i, tx: 3, tz: 1 }), i * 180); break;
    case 'chain_lightning': for (let i = 0; i < 3; i++) { proc(id, slot, { tx: i, tz: 2 }); hitEnemy(); } break;
    case 'heavy_hitter':
      press('primary', CLASSES[cls].primary[0].id);
      proc(id, slot, { r: 2.4 });
      window.setTimeout(hitEnemy, 420);
      break;
    case 'twin_cast': window.setTimeout(() => { proc(id, slot, { r: 3 }); fire({ e: 'aoe', ...at, r: 3, el: null, hostile: false }); }, 450); break;
    case 'blood_price': press('secondary', CLASSES[cls].secondary.id); proc(id, slot, { n: 8 }); break;
    case 'orbit_blades': hitEnemy(); break;
    case 'familiar': proc(id, slot, { tx: 5, tz: 3 }); break;
    case 'colossus': press('dash', 'dash'); break;
    case 'corpse_bloom':
      for (let i = 0; i < 4; i++) window.setTimeout(() => { fire({ e: 'aoe', ...at, r: 3, el: 'ember', hostile: false }); proc(id, slot, { r: 3, n: i + 1 }); }, i * 150);
      break;
    case 'resonance_engine': fire({ e: 'resonance', ...at, r: 3.9, a: 'ember', b: 'rime', by: slot }); proc(id, slot, { n: 14 }); break;
    case 'glass_cannon':
      press('primary', CLASSES[cls].primary[0].id);
      window.setTimeout(() => fire({ e: 'hit', target: { t: 'p', id: slot }, ...at, dmg: 22, crit: false, el: null, by: -1 }), 500);
      break;
    case 'sanguine': proc(id, slot, { n: 6 }); fire({ e: 'heal', slot, amount: 6 }); break;
    case 'momentum_engine':
      for (let i = 0; i < 10; i++) window.setTimeout(() => proc(id, slot, { n: i + 1 }), i * 450);
      window.setTimeout(() => proc(id, slot, { n: 0 }), 9500);
      break;
    case 'ks_knight': fire({ e: 'aoe', ...at, r: 3.2, el: null, hostile: false }); proc(id, slot, { r: 3.2, n: 45 }); break;
    case 'ks_barbarian':
      proc(id, slot, { r: 5 });
      window.setTimeout(() => fire({ e: 'zone', id: zoneId++, kind: 'ks_barbarian', ...at, r: 3, dur: 3, el: null, by: slot }), 1400);
      break;
    case 'ks_mage': channel(slot, 1500); break;
    case 'ks_rogue': proc(id, slot, { n: 5 }); break;
    case 'ks_templar': {
      const zone = zoneId++;
      fire({ e: 'zone', id: zone, kind: 'templar_consecrate', ...at, r: 4, dur: 6, el: null, by: slot });
      break;
    }
    case 'ks_spellblade': proc(id, slot, { n: 1 }); window.setTimeout(() => proc(id, slot, { n: 3 }), 600); break;
    case 'ks_shade': fire({ e: 'kill', id: DEMO.ENEMY_ID, kind: 'minion', ...at, by: slot }); proc(id, slot); fire({ e: 'buff', slot, id, dur: 1.5 }); break;
  }
}

const hordeAt = (kind: (typeof HORDE_KINDS)[number]): number => DEMO.HORDE_ID + HORDE_KINDS.indexOf(kind);

const at = { x: 0, z: 0 };
const own = DEMO.OWN_SLOT;
const ally = DEMO.ALLY_SLOT;

/** Real game events, as the server sends them. */
const GAME_EVENTS: [string, () => void][] = [
  ['spawn minion', () => fire({ e: 'spawn', id: DEMO.ENEMY_ID, kind: 'minion', ...at, elite: false })],
  ['spawn elite warrior', () => fire({ e: 'spawn', id: DEMO.SHIELD_ID, kind: 'warrior', ...at, elite: true })],
  ...(['champion', ...BOSS_KINDS] as const).map((kind): [string, () => void] => [`spawn ${kind}`, () => fire({ e: 'spawn', id: DEMO.BOSS_ID, kind, ...at, elite: false })]),
  ['hit (own)', () => fire({ e: 'hit', target: { t: 'e', id: DEMO.ENEMY_ID }, ...at, dmg: 18, crit: false, el: null, by: own })],
  ['hit heavy crit (own)', () => fire({ e: 'hit', target: { t: 'e', id: DEMO.ENEMY_ID }, ...at, dmg: 62, crit: true, el: null, by: own })],
  ['hit (ally)', () => fire({ e: 'hit', target: { t: 'e', id: DEMO.ENEMY_ID }, ...at, dmg: 18, crit: false, el: null, by: ally })],
  ['hit blocked by shield', () => fire({ e: 'hit', target: { t: 'e', id: DEMO.SHIELD_ID }, ...at, dmg: 0, crit: false, el: null, by: own })],
  ['hit boss', () => fire({ e: 'hit', target: { t: 'e', id: DEMO.BOSS_ID }, ...at, dmg: 30, crit: false, el: null, by: own })],
  ...ELEMENT_IDS.map((el): [string, () => void] => [`hit ${el}`, () => fire({ e: 'hit', target: { t: 'e', id: DEMO.ENEMY_ID }, ...at, dmg: 22, crit: false, el, by: own })]),
  ['burn tick', () => fire({ e: 'hit', target: { t: 'e', id: DEMO.ENEMY_ID }, ...at, dmg: 3, crit: false, el: 'ember', by: own })],
  ...ELEMENT_IDS.map((el): [string, () => void] => [`status ${el}`, () => fire({ e: 'status', id: DEMO.ENEMY_ID, el })]),
  ...ELEMENT_IDS.flatMap((a) => ELEMENT_IDS.filter((b) => b !== a).map((b): [string, () => void] =>
    [`resonance ${a}→${b}`, () => { fire({ e: 'resonance', ...at, r: 3, a, b, by: own }); fire({ e: 'aoe', ...at, r: 3, el: b, hostile: false }); }])),
  ['resonance by ally', () => fire({ e: 'resonance', ...at, r: 3, a: 'rime', b: 'storm', by: ally })],
  ['kill minion (own)', () => fire({ e: 'kill', id: DEMO.ENEMY_ID, kind: 'minion', ...at, by: own })],
  ['kill warrior (ally)', () => fire({ e: 'kill', id: DEMO.SHIELD_ID, kind: 'warrior', ...at, by: ally })],
  ['kill champion', () => fire({ e: 'kill', id: DEMO.BOSS_ID, kind: 'champion', ...at, by: own })],
  ['kill boss', () => fire({ e: 'kill', id: DEMO.BOSS_ID, kind: state.run?.finalBoss ?? 'regent', ...at, by: own })],
  ['shield break', () => fire({ e: 'shieldBreak', id: DEMO.SHIELD_ID })],
  ['hurt own (light)', () => fire({ e: 'hit', target: { t: 'p', id: own }, ...at, dmg: 9, crit: false, el: null, by: -1 })],
  ['hurt own (heavy)', () => fire({ e: 'hit', target: { t: 'p', id: own }, ...at, dmg: 48, crit: false, el: null, by: -1 })],
  ['hurt ally', () => fire({ e: 'hit', target: { t: 'p', id: ally }, ...at, dmg: 20, crit: false, el: null, by: -1 })],
  ['telegraph', () => fire({ e: 'telegraph', shape: 'circle', ...at, rot: 0, r: 2.4, w: 0, dur: 1.1 })],
  ['telegraph (urgent)', () => fire({ e: 'telegraph', shape: 'circle', ...at, rot: 0, r: 2.4, w: 0, dur: 0.5 })],
  ['aoe hostile', () => fire({ e: 'aoe', ...at, r: 2.4, el: null, hostile: true })],
  ...CLASS_IDS.flatMap((cls): [string, () => void][] => [
    ...CLASSES[cls].primary.map((a, i): [string, () => void] => [`ally ${cls} primary ${i + 1}`, () => fire({ e: 'cast', who: { t: 'p', id: CLASS_IDS.indexOf(cls) || ally }, ability: a.id, ...at, rot: 0 })]),
    [`ally ${cls} secondary`, () => fire({ e: 'cast', who: { t: 'p', id: CLASS_IDS.indexOf(cls) || ally }, ability: CLASSES[cls].secondary.id, ...at, rot: 0 })],
  ]),
  ['ally dash', () => fire({ e: 'cast', who: { t: 'p', id: ally }, ability: 'dash', ...at, rot: 0 })],
  ['own primary (local action)', () => bus.emit('game:localAction', { action: 'primary' })],
  ['own secondary (local action)', () => bus.emit('game:localAction', { action: 'secondary' })],
  ['own dash (local action)', () => bus.emit('game:localAction', { action: 'dash' })],
  ['own denied', () => bus.emit('game:localAction', { action: 'denied' })],
  ...BOSS_CUE_IDS.map((id): [string, () => void] => [`enemy cast "${id}"`, () => fire({ e: 'cast', who: { t: 'e', id: DEMO.BOSS_ID }, ability: id, ...at, rot: 0 })]),
  ['enemy cast (unknown id)', () => fire({ e: 'cast', who: { t: 'e', id: DEMO.ENEMY_ID }, ability: 'archer_shot', ...at, rot: 0 })],
  ['boss phase 2', () => fire({ e: 'bossPhase', phase: 2 })],
  ['boss phase 3', () => fire({ e: 'bossPhase', phase: 3 })],
  ...(['spikes', 'vent', 'frost'] as const).flatMap((kind): [string, () => void][] => [
    [`hazard ${kind} (own)`, () => fire({ e: 'hazardHit', target: { t: 'p', id: own }, kind })],
    [`hazard ${kind} (enemy)`, () => fire({ e: 'hazardHit', target: { t: 'e', id: DEMO.ENEMY_ID }, kind })],
  ]),
  ['wave', () => fire({ e: 'wave', wave: 2, waveCount: 3 })],
  ['chamber clear', () => fire({ e: 'chamberClear' })],
  ...(['boon', 'blessing', 'cursed', 'boss'] as const).map((type): [string, () => void] => [`door ${type}`, () => fire({ e: 'doorChosen', type })]),
  ['boon (own)', () => fire({ e: 'boon', slot: own, id: 'keen_edge', level: 1 })],
  ['boon (ally)', () => fire({ e: 'boon', slot: ally, id: 'keen_edge', level: 1 })],
  ['heal', () => fire({ e: 'heal', slot: own, amount: 12 })],
  ['down (own)', () => fire({ e: 'down', slot: own })],
  ['down (ally)', () => fire({ e: 'down', slot: ally })],
  ['revived', () => fire({ e: 'revived', slot: own, by: ally })],
  ['tutorial step', () => fire({ e: 'tutorialStep', step: 'attack' })],
  // ---- update 3
  ...CLASS_IDS.flatMap((cls): [string, () => void][] => [
    ...CLASSES[cls].arts.map((a): [string, () => void] => [`ally ${cls} art ${a.id}`, () => fire({ e: 'cast', who: { t: 'p', id: ally }, ability: a.id, ...at, rot: 0 })]),
    [`ally ${cls} ultimate`, () => fire({ e: 'cast', who: { t: 'p', id: ally }, ability: CLASSES[cls].ultimate.id, ...at, rot: 0 })],
  ]),
  ['own ultimate (local action)', () => bus.emit('game:localAction', { action: 'ultimate' })],
  ['ultimate ready (own)', () => fire({ e: 'ultReady', slot: own })],
  ['ultimate ready (ally)', () => fire({ e: 'ultReady', slot: ally })],
  ...(['templar_consecrate', 'templar_sanctuary', 'shade_smoke', 'rogue_volley', 'rogue_trap'] as const).map((kind): [string, () => void] =>
    [`zone ${kind}`, () => fire({ e: 'zone', id: ++zoneId, kind, ...at, r: 3.6, dur: ABILITY_BY_ID.get(kind)?.duration ?? 5, el: null, by: own })]),
  ['zone (ally, umbra)', () => fire({ e: 'zone', id: ++zoneId, kind: 'templar_consecrate', ...at, r: 3.6, dur: 5, el: 'umbra', by: ally })],
  ['zone end (last zone, early)', () => fire({ e: 'zoneEnd', id: zoneId, ...at, sprung: false })],
  ['trap sprung (last zone)', () => fire({ e: 'zoneEnd', id: zoneId, ...at, sprung: true })],
  ...(Object.keys(BUFFS) as (keyof typeof BUFFS)[]).map((id): [string, () => void] => [`buff ${id} (own)`, () => fire({ e: 'buff', slot: own, id, dur: 6 })]),
  ['buff bulwark (ally, then own)', () => { fire({ e: 'buff', slot: ally, id: 'bulwark', dur: 6 }); fire({ e: 'buff', slot: own, id: 'bulwark', dur: 6 }); }],
  ['mark ×4', () => { for (let i = 0; i < 4; i++) window.setTimeout(() => fire({ e: 'mark', id: DEMO.ENEMY_ID + i, dur: 8 }), i * 60); }],
  ...AFFIX_IDS.map((affix): [string, () => void] => [`spawn elite (${affix})`, () => fire({ e: 'spawn', id: DEMO.SHIELD_ID, kind: 'warrior', ...at, elite: true, affix })]),
  ['set bonus tier 1 (own)', () => fire({ e: 'set', slot: own, id: 'set_offense', tier: 1 })],
  ['set bonus tier 2 umbra (own)', () => fire({ e: 'set', slot: own, id: 'set_umbra', tier: 2 })],
  ['set bonus (ally)', () => fire({ e: 'set', slot: ally, id: 'set_ember', tier: 1 })],
  ['legendary boon offered (state:draft)', () => { state.draft = [{ id: 'keen_edge', level: 1 }, { id: LEGENDARY_ID, level: 1 }]; bus.emit('state:draft'); }],
  ['legendary boon picked (own)', () => fire({ e: 'boon', slot: own, id: LEGENDARY_ID, level: 1 })],
  ['legendary boon picked (ally)', () => fire({ e: 'boon', slot: ally, id: LEGENDARY_ID, level: 1 })],
  ['door descend', () => fire({ e: 'doorChosen', type: 'descend' })],
  ['door ascend', () => fire({ e: 'doorChosen', type: 'ascend' })],
  ['descend (one deeper)', () => { setDepth(depth + 1); fire({ e: 'descend', depth }); }],
  ['progress: xp only', () => bus.emit('game:progress', { cls: ownClass, xp: 120, levelsGained: 0, level: 3, relics: [], featsReady: 0 })],
  ['progress: level up', () => bus.emit('game:progress', { cls: ownClass, xp: 480, levelsGained: 1, level: 4, relics: [], featsReady: 0 })],
  ['progress: 3 levels, relic rank-up, feat', () => bus.emit('game:progress', { cls: ownClass, xp: 2600, levelsGained: 3, level: 7, relics: [{ id: 'r', rank: 1, rankUp: false }, { id: 'r2', rank: 2, rankUp: true }], featsReady: 2 })],
  // ---- update 4
  ...HORDE_KINDS.map((kind): [string, () => void] => [`spawn ${kind}`, () => fire({ e: 'spawn', id: hordeAt(kind), kind, ...at, elite: false })]),
  ...HORDE_KINDS.map((kind): [string, () => void] => [`kill ${kind}`, () => fire({ e: 'kill', id: hordeAt(kind), kind, ...at, by: own })]),
  ['shaman cast "mend"', () => fire({ e: 'cast', who: { t: 'e', id: hordeAt('shaman') }, ability: 'mend', ...at, rot: 0 })],
  ['shaman mend lands (mend event)', () => fire({ e: 'mend', id: hordeAt('shaman'), targets: [DEMO.ENEMY_ID, DEMO.SHIELD_ID] })],
  ['shaman mend: cast, then lands', () => {
    fire({ e: 'cast', who: { t: 'e', id: hordeAt('shaman') }, ability: 'mend', ...at, rot: 0 });
    window.setTimeout(() => fire({ e: 'mend', id: hordeAt('shaman'), targets: [DEMO.ENEMY_ID] }), ENEMY_TUNING.SHAMAN.MEND_WINDUP * 1000);
  }],
  ['shaman mend: cast, interrupted half way (interrupt event)', () => {
    fire({ e: 'cast', who: { t: 'e', id: hordeAt('shaman') }, ability: 'mend', ...at, rot: 0 });
    window.setTimeout(() => fire({ e: 'interrupt', id: hordeAt('shaman') }), ENEMY_TUNING.SHAMAN.MEND_WINDUP * 500);
  }],
  ...(['raise', 'fuse', 'reaver_leap'] as const).map((ability, i): [string, () => void] => [`${ability}: cast, interrupted half way (interrupt event)`, () => {
    const id = hordeAt((['necromancer', 'bomber', 'reaver'] as const)[i]);
    const dur = [ENEMIES.necromancer.windup, ENEMIES.bomber.windup, ENEMY_TUNING.REAVER.LEAP_AIR_TIME][i];
    fire({ e: 'cast', who: { t: 'e', id }, ability, ...at, rot: 0 });
    window.setTimeout(() => fire({ e: 'interrupt', id }), dur * 500);
  }]),
  ['interrupt of an enemy that channels nothing (silent)', () => fire({ e: 'interrupt', id: DEMO.ENEMY_ID })],
  ['shaman mend: cast, killed half way', () => {
    fire({ e: 'cast', who: { t: 'e', id: hordeAt('shaman') }, ability: 'mend', ...at, rot: 0 });
    window.setTimeout(() => fire({ e: 'kill', id: hordeAt('shaman'), kind: 'shaman', ...at, by: own }), ENEMY_TUNING.SHAMAN.MEND_WINDUP * 500);
  }],
  ['aegis dome up', () => fire({ e: 'dome', id: hordeAt('aegis'), on: true, r: ENEMY_TUNING.AEGIS.DOME_RADIUS })],
  ['aegis dome down', () => fire({ e: 'dome', id: hordeAt('aegis'), on: false, r: ENEMY_TUNING.AEGIS.DOME_RADIUS })],
  ['bomber cast "fuse"', () => fire({ e: 'cast', who: { t: 'e', id: hordeAt('bomber') }, ability: 'fuse', ...at, rot: 0 })],
  ['bomber: fuse, then bursts (aoe + kill)', () => {
    fire({ e: 'cast', who: { t: 'e', id: hordeAt('bomber') }, ability: 'fuse', ...at, rot: 0 });
    fire({ e: 'telegraph', shape: 'circle', ...at, rot: 0, r: ENEMY_TUNING.BOMBER.BLAST_RADIUS, w: 0, dur: ENEMIES.bomber.windup, src: hordeAt('bomber') });
    window.setTimeout(() => {
      fire({ e: 'aoe', ...at, r: ENEMY_TUNING.BOMBER.BLAST_RADIUS, el: null, hostile: true });
      fire({ e: 'kill', id: hordeAt('bomber'), kind: 'bomber', ...at, by: -1 });
    }, ENEMIES.bomber.windup * 1000);
  }],
  ['bomber: slain, bursts after the delay', () => {
    fire({ e: 'kill', id: hordeAt('bomber'), kind: 'bomber', ...at, by: own });
    window.setTimeout(() => fire({ e: 'aoe', ...at, r: ENEMY_TUNING.BOMBER.BLAST_RADIUS, el: null, hostile: true }), ENEMY_TUNING.BOMBER.DEATH_BLAST_DELAY * 1000);
  }],
  ['bomber pack ×5 (staggered fuses)', () => {
    for (let i = 0; i < 5; i++) {
      window.setTimeout(() => {
        const id = DEMO.HORDE_ID + 20 + i;
        fire({ e: 'spawn', id, kind: 'bomber', ...at, elite: false });
        fire({ e: 'cast', who: { t: 'e', id }, ability: 'fuse', ...at, rot: 0 });
        window.setTimeout(() => {
          fire({ e: 'aoe', ...at, r: ENEMY_TUNING.BOMBER.BLAST_RADIUS, el: null, hostile: true });
          fire({ e: 'kill', id, kind: 'bomber', ...at, by: -1 });
        }, ENEMIES.bomber.windup * 1000);
      }, i * 110);
    }
  }],
  ['necromancer cast "raise"', () => fire({ e: 'cast', who: { t: 'e', id: hordeAt('necromancer') }, ability: 'raise', ...at, rot: 0 })],
  ['necromancer dies, six minions crumble', () => {
    fire({ e: 'kill', id: hordeAt('necromancer'), kind: 'necromancer', ...at, by: own });
    for (let i = 0; i < 6; i++) fire({ e: 'kill', id: DEMO.HORDE_ID + 30 + i, kind: 'minion', ...at, by: -1 });
  }],
  ['reaver cast "reaver_leap" (lands: aoe)', () => {
    fire({ e: 'cast', who: { t: 'e', id: hordeAt('reaver') }, ability: 'reaver_leap', ...at, rot: 0 });
    fire({ e: 'telegraph', shape: 'circle', ...at, rot: 0, r: ENEMY_TUNING.REAVER.LEAP_RADIUS, w: 0, dur: ENEMY_TUNING.REAVER.LEAP_AIR_TIME, src: hordeAt('reaver') });
    window.setTimeout(() => fire({ e: 'aoe', ...at, r: ENEMY_TUNING.REAVER.LEAP_RADIUS, el: null, hostile: true }), ENEMY_TUNING.REAVER.LEAP_AIR_TIME * 1000);
  }],
  ...ELEMENT_IDS.flatMap((el, i): [string, () => void][] => [
    [`spawn minion warded against ${el}`, () => fire({ e: 'spawn', id: DEMO.WARDED_ID + i, kind: 'minion', ...at, elite: false, ward: el })],
    [`own ${el} hit on that warded minion (deflect)`, () => {
      fire({ e: 'spawn', id: DEMO.WARDED_ID + i, kind: 'minion', ...at, elite: false, ward: el });
      fire({ e: 'hit', target: { t: 'e', id: DEMO.WARDED_ID + i }, ...at, dmg: 22, crit: false, el, by: own });
      fire({ e: 'warded', id: DEMO.WARDED_ID + i, el, ...at, by: own });
    }],
  ]),
  ['ally ember hit on a minion warded against ember (no deflect, no element)', () => {
    fire({ e: 'spawn', id: DEMO.WARDED_ID, kind: 'minion', ...at, elite: false, ward: 'ember' });
    fire({ e: 'hit', target: { t: 'e', id: DEMO.WARDED_ID }, ...at, dmg: 22, crit: false, el: 'ember', by: ally });
    fire({ e: 'warded', id: DEMO.WARDED_ID, el: 'ember', ...at, by: ally });
  }],
  ...OBJECTIVE_KINDS.filter((kind) => kind !== 'slay').map((kind): [string, () => void] => [`objective start: ${kind}`, () => fire({ e: 'objective', kind, what: 'start' })]),
  ...[0, 1, 2].map((index): [string, () => void] => [`objective: brazier ${index + 1} lit`, () => fire({ e: 'objective', kind: 'ritual', what: 'site', index })]),
  ['objective: shard hit', () => fire({ e: 'objective', kind: 'defend', what: 'anchorHit' })],
  ['objective: shard shatters (bonus lost)', () => fire({ e: 'objective', kind: 'defend', what: 'bonusLost' })],
  ['objective: hunt enrage (bonus lost)', () => fire({ e: 'objective', kind: 'hunt', what: 'bonusLost' })],
  ['objective: ritual bonus lost', () => fire({ e: 'objective', kind: 'ritual', what: 'bonusLost' })],
  ['objective done, bonus', () => fire({ e: 'objective', kind: 'survive', what: 'done', bonus: true })],
  ['objective done, no bonus', () => fire({ e: 'objective', kind: 'survive', what: 'done', bonus: false })],
  ['objective done: vault (reliquary opens)', () => fire({ e: 'objective', kind: 'vault', what: 'done', bonus: false })],
  ['draft pick (ui:pick)', () => bus.emit('ui:pick', { index: 0 })],
  // update 5: keystones — taking one, every signature for the own hero and an ally, drafts, fitting boons
  ['keystones: clear all', () => { for (const slot of [own, ally]) setKeystones([], slot); }],
  ...KEYSTONES.flatMap((k): [string, () => void][] => [
    [`keystone ${k.id}: own trigger`, () => { if (!(keystonesOf.get(own) ?? []).includes(k.id)) setKeystones([k.id]); keystoneTrigger(k.id, own); }],
    [`keystone ${k.id}: ally trigger`, () => { if (!(keystonesOf.get(ally) ?? []).includes(k.id)) setKeystones([k.id], ally); keystoneTrigger(k.id, ally); }],
  ]),
  ['keystone taken: own, first slot', () => { setKeystones([]); takeKeystone('ember_wake'); }],
  ['keystone taken: own, second slot', () => { setKeystones(['ember_wake']); takeKeystone('corpse_bloom'); }],
  ['keystone taken: own, replaced', () => { setKeystones(['ember_wake', 'corpse_bloom']); takeKeystone('ricochet'); }],
  ['keystone taken: ally', () => { setKeystones([], ally); takeKeystone('familiar', ally); }],
  ['keystone taken: ally, replaced', () => { setKeystones(['familiar', 'ricochet'], ally); takeKeystone('twin_cast', ally); }],
  ['keystone draft: open', () => { setKeystones([]); keystoneDraft(true); }],
  ['keystone draft: open (slots full)', () => keystoneDraft(true, true)],
  ['keystone draft: close', () => keystoneDraft(false)],
  ['draft: pick a boon that fits (2 tags)', () => { fitsDraft(); bus.emit('ui:pick', { index: 0 }); }],
  ['draft: pick a boon that does not fit', () => { fitsDraft(); bus.emit('ui:pick', { index: 2 }); }],
  ['own primary with 2 keystones (weight + sparkle)', () => { setKeystones(['ember_wake', 'shockstep']); bus.emit('game:localAction', { action: 'primary' }); }],
  ['own secondary with 1 keystone (weight)', () => { setKeystones(['ember_wake']); bus.emit('game:localAction', { action: 'secondary' }); }],
  ['ready on', () => bus.emit('ui:lobby', { ready: true })],
  ['ready off', () => bus.emit('ui:lobby', { ready: false })],
  ['network error', () => bus.emit('net:error', { error: 'unreachable', fatal: false })],
];

const SEQUENCES: [string, () => void][] = [
  ['Resonance chain ×6 (pitch climbs)', () => {
    for (let i = 0; i < 6; i++) window.setTimeout(() => fire({ e: 'resonance', ...at, r: 3, a: ELEMENT_IDS[i % 3], b: ELEMENT_IDS[(i + 1) % 3], by: own }), i * DEMO.CHAIN_GAP_MS);
  }],
  ['Knight combo 1-2-3', () => { for (let i = 0; i < 3; i++) window.setTimeout(() => audioInternals()?.sfx.primary('knight', i, true), i * 380); }],
  ['Barbarian chop 1-2', () => { for (let i = 0; i < 2; i++) window.setTimeout(() => audioInternals()?.sfx.primary('barbarian', i === 1 ? 2 : 0, true), i * 560); }],
  ['Rogue rapid fire ×6 (round robin)', () => { for (let i = 0; i < 6; i++) window.setTimeout(() => audioInternals()?.sfx.primary('rogue', 0, true), i * 230); }],
  ['Six kills in a row (clatter variation)', () => { for (let i = 0; i < 6; i++) window.setTimeout(() => audioInternals()?.sfx.kill('minion', true), i * 300); }],
  ['Ten light hits (variation)', () => { for (let i = 0; i < 10; i++) window.setTimeout(() => audioInternals()?.sfx.hit({ dmg: 12, crit: false, el: null, own: true }), i * 160); }],
  ['Draft countdown (last 5 s)', () => {
    scene('game: draft (calm)');
    const started = performance.now();
    const timer = window.setInterval(() => {
      const left = DEMO.DRAFT_SECONDS - (performance.now() - started) / 1000;
      if (!state.run || left <= 0) { window.clearInterval(timer); state.draft = []; return; }
      state.draft = [{ id: 'keen_edge', level: 1 }];
      state.run.draftTime = left;
      bus.emit('state:run', { previousPhase: 'draft' });
    }, DEMO.STATUS_MS);
  }],
];

// ------------------------------------------------------------------ stress + measurements

interface StressResult { peak: number; peakDb: number; liveBefore: number; liveAfter: number; voicesAfter: number; dropped: number; stolen: number }

function stress(): Promise<StressResult> {
  return new Promise((resolve) => {
    const engine = audioInternals();
    if (!engine) { resolve({ peak: 0, peakDb: -Infinity, liveBefore: 0, liveAfter: 0, voicesAfter: 0, dropped: 0, stolen: 0 }); return; }
    const liveBefore = engine.graph.live.count;
    let peak = 0;
    const sample = window.setInterval(() => { peak = Math.max(peak, engine.graph.meter()); }, 10);
    for (const [when, play] of stressEvents()) window.setTimeout(() => play(engine.sfx), when * 1000);
    window.setTimeout(() => {
      window.clearInterval(sample);
      const s = engine.sfx.stats();
      resolve({ peak, peakDb: 20 * Math.log10(Math.max(peak, 1e-9)), liveBefore, liveAfter: engine.graph.live.count, voicesAfter: s.voices, dropped: s.dropped, stolen: s.stolen });
    }, DEMO.STRESS_LISTEN_MS);
  });
}

/** Renders the SFX cases whose name contains `filter` (all when empty). */
async function renderCases(filter = '', withSamples = true): Promise<RenderStats[]> {
  const o = { samples: withSamples };
  if (withSamples) await loadOfflineBank();
  const out: RenderStats[] = [];
  for (const [name, play, seconds] of SFX_CASES) {
    if (name.includes(filter)) out.push(await renderSfx(name, play, seconds ?? DEMO.DEFAULT_RENDER_S, o));
  }
  return out;
}

/** Update 3 additions to the measurement run: the score per depth, stinger variants, the ultimate stress. */
async function renderDepths(withSamples = true): Promise<RenderStats[]> {
  const o = { samples: withSamples };
  if (withSamples) await loadOfflineBank();
  const out: RenderStats[] = [];
  for (const d of [0, 1, 3, 5]) {
    out.push(await renderMusic('combat', 12, 1, { ...o, depth: d }));
    out.push(await renderMusic('boss', 12, 3, { ...o, depth: d }));
  }
  out.push(await renderMusic('calm', 12, 1, { ...o, depth: 5 }), await renderMusic('elite', 12, 1, { ...o, depth: 5 }));
  for (const boss of ['matron', 'stalker'] as const) out.push(await renderMusic('boss', 12, 3, { ...o, boss, depth: 5 }));
  out.push(await renderStinger('victory', { ...o, cleared: 3 }), await renderStinger('defeat', { ...o, cleared: 1 }));
  out.push(await renderUltimateStress(7, o));
  return out;
}

/** Update 4 additions: the timed horde sequences, every objective piece, the vault ambience, the objective stress. */
async function renderUpdate4(withSamples = true): Promise<RenderStats[]> {
  const o = { samples: withSamples };
  if (withSamples) await loadOfflineBank();
  const out: RenderStats[] = [];
  for (const [name, events, seconds] of HORDE_SEQUENCES) out.push(await renderSequence(name, events, seconds, o));
  out.push(await renderMusic('combat', 12, 1, o));
  for (const pressure of [0, 0.6, 1]) out.push(await renderMusic('combat', 12, 1, { ...o, objective: 'survive', pressure }));
  for (const pressure of [0, 0.8]) out.push(await renderMusic('combat', 12, 1, { ...o, objective: 'defend', pressure }));
  for (const pressure of [0, 1]) out.push(await renderMusic('combat', 12, 1, { ...o, objective: 'hunt', pressure }));
  for (const lit of [0, 1, 2, 3]) out.push(await renderMusic('combat', 12, 1, { ...o, objective: 'ritual', lit }));
  out.push(await renderMusic('combat', 14, 1, { ...o, objective: 'vault' }));
  for (const objective of OBJECTIVE_KINDS.filter((k) => k !== 'slay')) {
    out.push(await renderMusic('combat', 12, 1, { ...o, objective, pressure: 1, lit: 3, depth: 5 }));
  }
  for (const b of ['flooded', 'forge'] as const) out.push(await renderMusic('combat', 10, 1, { ...o, objective: 'hunt', biome: b }));
  out.push(await renderAmbience('vault', 14, o));
  out.push(await renderObjectiveStress(undefined, o));
  return out;
}

/** Update 5: every keystone sound, the score with keystone voices on every kind of piece, the draft bed, the worst case. */
async function renderUpdate5(withSamples = true): Promise<RenderStats[]> {
  const o = { samples: withSamples };
  if (withSamples) await loadOfflineBank();
  const out: RenderStats[] = await renderCases('keystone.', withSamples);
  for (const name of ['progress.levelUp', 'boon.own', 'boon.legendary', 'ui.draftPick', 'hurt.own']) {
    for (const c of SFX_CASES.filter(([n]) => n.startsWith(name)).slice(0, 2)) out.push(await renderSfx(c[0], c[1], c[2] ?? DEMO.DEFAULT_RENDER_S, o));
  }
  const builds: string[][] = [[], ['ember_wake'], ['ember_wake', 'corpse_bloom'], ['ricochet'], ['twin_cast'], ['familiar'], ['corpse_bloom'], ['ks_knight'], ['ricochet', 'chain_lightning'], ['ks_knight', 'familiar']];
  for (const keystones of builds) out.push(await renderMusic('combat', 12, 1, { ...o, keystones }));
  for (const keystones of [[], ['ember_wake', 'corpse_bloom']]) {
    out.push(await renderMusic('elite', 12, 1, { ...o, keystones }));
    out.push(await renderMusic('boss', 12, 3, { ...o, keystones }));
    out.push(await renderMusic('boss', 12, 2, { ...o, keystones, boss: 'matron' }));
    out.push(await renderMusic('combat', 12, 1, { ...o, keystones, depth: 5 }));
    for (const objective of OBJECTIVE_KINDS.filter((k) => k !== 'slay')) out.push(await renderMusic('combat', 12, 1, { ...o, keystones, objective, pressure: 0.6, lit: 2 }));
  }
  out.push(await renderMusic('calm', 14, 1, o), await renderMusic('calm', 14, 1, { ...o, keystoneDraft: true }), await renderMusic('calm', 14, 1, { ...o, keystoneDraft: true, depth: 5 }));
  out.push(await renderObjectiveStress(undefined, o), await renderKeystoneStress(undefined, o));
  return out;
}

/** The 23 signatures (own hero) and how close each pair is in register and gesture, closest first. */
async function renderSignatures(withSamples = true): Promise<{ stats: RenderStats[]; pairs: Closeness[] }> {
  const stats = await renderCases('keystone.sig.', withSamples);
  return { stats, pairs: closestPairs(stats) };
}

function liveStress(events: [number, (sfx: NonNullable<ReturnType<typeof audioInternals>>['sfx']) => void][], listenMs: number): Promise<StressResult> {
  return new Promise((resolve) => {
    const engine = audioInternals();
    if (!engine) { resolve({ peak: 0, peakDb: -Infinity, liveBefore: 0, liveAfter: 0, voicesAfter: 0, dropped: 0, stolen: 0 }); return; }
    const liveBefore = engine.graph.live.count;
    let peak = 0;
    const sample = window.setInterval(() => { peak = Math.max(peak, engine.graph.meter()); }, 10);
    for (const [when, play] of events) window.setTimeout(() => play(engine.sfx), when * 1000);
    window.setTimeout(() => {
      window.clearInterval(sample);
      engine.sfx.keystoneReset();
      const s = engine.sfx.stats();
      resolve({ peak, peakDb: 20 * Math.log10(Math.max(peak, 1e-9)), liveBefore, liveAfter: engine.graph.live.count, voicesAfter: s.voices, dropped: s.dropped, stolen: s.stolen });
    }, listenMs);
  });
}

async function renderAll(withSamples = true): Promise<RenderStats[]> {
  const o = { samples: withSamples };
  if (withSamples) await loadOfflineBank();
  const out: RenderStats[] = await renderCases('', withSamples);
  out.push(...await renderDepths(withSamples));
  out.push(...await renderUpdate4(withSamples));
  out.push(...(await renderUpdate5(withSamples)).filter((s) => !out.some((have) => have.name === s.name)));
  for (const name of ['menu', 'calm', 'combat', 'elite'] as const) out.push(await renderMusic(name, 12, 1, o));
  for (const boss of BOSS_KINDS) for (const phase of [1, 2, 3]) out.push(await renderMusic('boss', 10, phase, { ...o, boss }));
  for (const b of BIOME_IDS) out.push(await renderMusic('combat', 10, 1, { ...o, biome: b }));
  out.push(await renderStinger('victory', o), await renderStinger('defeat', o));
  for (const b of BIOME_IDS) out.push(await renderAmbience(b, 12, o));
  out.push(await renderStress(6, o), await renderStressTimed(5, o));
  return out;
}

function formatStats(stats: RenderStats[]): string {
  const head = `${'sound'.padEnd(44)} ${'peak dBFS'.padStart(9)} ${'loud dB'.padStart(8)} ${'rms dB'.padStart(8)} ${'DC'.padStart(9)} ${'centroid'.padStart(9)} ${'rise s'.padStart(7)} ${'active s'.padStart(8)} ${'onsets'.padStart(6)}`;
  return [head, ...stats.map((s) =>
    `${s.name.padEnd(44)} ${s.peakDb.toFixed(1).padStart(9)} ${s.loudDb.toFixed(1).padStart(8)} ${s.rmsDb.toFixed(1).padStart(8)} ${s.dc.toExponential(1).padStart(9)} ${`${s.centroidHz.toFixed(0)} Hz`.padStart(9)} ${s.riseS.toFixed(2).padStart(7)} ${s.activeS.toFixed(2).padStart(8)} ${String(s.onsets).padStart(6)}`)].join('\n');
}

// ------------------------------------------------------------------ page

const active = new Map<string, HTMLButtonElement>();

function paintActive(): void {
  for (const [key, btn] of active) {
    btn.classList.toggle('on', key === `scene:${sceneName}` || key === `biome:${biome}` || key === `class:${ownClass}` || key === `depth:${depth}` || key === `art:${ownArt}` || key === `cleared:${cleared}`);
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', cls = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (cls) node.className = cls;
  return node;
}

function button(label: string, action: () => void, key = '', cls = ''): HTMLButtonElement {
  const btn = el('button', label, cls);
  btn.type = 'button';
  // these buttons audition a sound themselves; keep the interface click out of the way
  btn.setAttribute('data-sfx', 'hover');
  btn.addEventListener('click', action);
  if (key) active.set(key, btn);
  return btn;
}

function section(root: HTMLElement, title: string, note = ''): HTMLElement {
  root.append(el('h2', title));
  if (note) root.append(el('p', note));
  const row = el('div', '', 'row');
  root.append(row);
  return row;
}

function boot(): void {
  document.getElementById('game-canvas')?.remove();
  const style = el('style', CSS);
  document.head.append(style);
  const root = el('div');
  root.id = 'audiodemo';
  document.body.append(root);

  initAudio();
  state.conn.slot = DEMO.OWN_SLOT;
  state.roster = roster();
  state.screen = 'menu';

  root.append(el('h1', 'Glimmergrave — audio workbench'));
  root.append(el('p', 'Click “Enable audio” first (browsers need a gesture). Samples then load in the background; until a sample is there its sound plays the synthesised fallback. Use headphones or speakers with real bass: many layers live below 120 Hz.'));

  // ---------------------------------------------------------------- sticky bar: start, meter, volumes, status
  const bar = el('div', '', 'bar');
  const startBtn = button('Enable audio', () => { bus.emit('ui:gesture'); scene(sceneName, false); }, '', 'big');
  startBtn.id = 'audiodemo-start';
  const meterBox = el('div');
  const meter = el('div', '', 'meter');
  const fill = el('i');
  const hold = el('b');
  const warn = el('s');
  warn.style.left = `${(1 - DEMO.METER_WARN_DB / DEMO.METER_FLOOR_DB) * 100}%`;
  meter.append(fill, hold, warn);
  const meterText = el('div', 'output peak: –');
  meterText.id = 'audiodemo-meter';
  meterBox.append(meter, meterText);
  const volumes = el('div');
  for (const key of ['master', 'music', 'sfx'] as const) {
    const label = el('label', key);
    const input = el('input');
    input.type = 'range';
    input.min = '0';
    input.max = '1';
    input.step = '0.01';
    input.value = String(settings[key]);
    input.id = `audiodemo-${key}`;
    const value = el('span', settings[key].toFixed(2));
    input.addEventListener('input', () => { updateSettings({ [key]: Number(input.value) }); value.textContent = Number(input.value).toFixed(2); });
    label.append(input, value);
    volumes.append(label);
  }
  const synthToggle = button('A/B: designed sounds (click for original synth)', () => {
    const on = !synthToggle.classList.contains('on');
    synthToggle.classList.toggle('on', on);
    synthToggle.textContent = on ? 'A/B: ORIGINAL SYNTH (click for designed sounds)' : 'A/B: designed sounds (click for original synth)';
    audioInternals()?.sfx.setForceSynth(on);
  });
  volumes.append(synthToggle);
  const status = el('div', 'audio not started');
  status.id = 'audiodemo-status';
  bar.append(startBtn, meterBox, el('span', 'volumes'), volumes, el('span', 'status'), status);
  root.append(bar);

  let heldDb: number = DEMO.METER_FLOOR_DB;
  let heldAt = 0;
  let maxDb = -Infinity;
  const toPct = (dB: number): number => Math.max(0, Math.min(1, 1 - dB / DEMO.METER_FLOOR_DB)) * 100;
  const frame = (): void => {
    const peak = audioInternals()?.graph.meter() ?? 0;
    const dB = 20 * Math.log10(Math.max(peak, 1e-6));
    const nowMs = performance.now();
    if (dB >= heldDb || nowMs - heldAt > DEMO.METER_HOLD_MS) { heldDb = dB; heldAt = nowMs; }
    maxDb = Math.max(maxDb, dB);
    fill.style.width = `${toPct(dB)}%`;
    hold.style.left = `${toPct(heldDb)}%`;
    meterText.textContent = `output peak: ${dB <= DEMO.METER_FLOOR_DB ? '–' : dB.toFixed(1)} dBFS · hold ${heldDb.toFixed(1)} · max since reset ${Number.isFinite(maxDb) ? maxDb.toFixed(1) : '–'} dBFS (red line = ${DEMO.METER_WARN_DB} dBFS; click to reset)`;
    meterText.style.color = maxDb > DEMO.METER_WARN_DB ? '#ff7b6b' : '';
    requestAnimationFrame(frame);
  };
  meterText.addEventListener('click', () => { maxDb = -Infinity; });
  requestAnimationFrame(frame);
  window.setInterval(() => {
    const d = audioDebug();
    status.textContent = d
      ? `context ${d.state} · samples ${d.samples.loaded}/${d.samples.total} (${(d.samples.bytes / 1024).toFixed(0)} kB, ${d.samples.failed} failed, first playable after ${(d.samples.firstReadyBytes / 1024).toFixed(1)} kB) · music ${d.piece ?? 'none'} (${d.tracks} track) · ambience ${d.biome ?? 'off'} · reverb ${d.space} · voices ${d.voices} · live nodes ${d.liveNodes} · designed ${d.designed} / fallback ${d.fallbacks}`
      : 'audio not started';
  }, DEMO.STATUS_MS);

  // ---------------------------------------------------------------- music, ambience
  const scenes = section(root, 'Music and scene (through fake game state)',
    'Sets the screen / run like the game does; the score crossfades in 1.5 s. Ambience and reverb follow: ambience only on game scenes, the long hall reverb only in boss chambers.');
  for (const name of Object.keys(SCENES)) scenes.append(button(name, () => scene(name), `scene:${name}`));
  const tint = section(root, 'Biome (ambience + tint of the score)', 'crypt: drone and drips · flooded: lapping water, hollow resonance, darker and wetter score · forge: rumble, fire, bellows, anvil hits in the beat.');
  for (const b of BIOME_IDS) tint.append(button(b, () => setBiome(b), `biome:${b}`));
  const phases = section(root, 'Boss phase (music escalates, roar plays)', 'Pick a boss scene first.');
  for (const phase of [2, 3]) phases.append(button(`phase ${phase}`, () => fire({ e: 'bossPhase', phase })));
  phases.append(button('back to phase 1', () => { audioInternals()?.music.setBossPhase(1); }));
  const depths = section(root, 'Depth of the descent (score: lower, denser, more dissonant per depth)', 'Pick a combat / elite / boss scene first; the running piece changes at its next bar line. "cleared" feeds the stinger variants.');
  for (let d = 0; d <= DEMO.MAX_DEPTH; d++) depths.append(button(`depth ${d}`, () => setDepth(d), `depth:${d}`));
  for (const n of [0, 1, 3]) depths.append(button(`cleared ${n}`, () => { cleared = n; if (state.run) state.run.cleared = n; paintActive(); }, `cleared:${n}`));
  const objectives = section(root, 'Chamber objective (update 4): a whole chamber as the server would report it',
    `Each button runs the objective in ${DEMO.TIMELINE_SECONDS} s: start stinger, the objective's piece of the score, run states every ${DEMO.RUN_STATE_MS} ms with network-like jitter (timer, shard health, braziers), the last 10 seconds ticked from the audio module's own clock, then "done". The "game: <objective>" scenes above only switch the score.`);
  for (const kind of OBJECTIVE_KINDS.filter((k) => k !== 'slay')) {
    objectives.append(button(`${kind} (bonus kept)`, () => { void timeline(kind, DEMO.TIMELINE_SECONDS, true); }));
    if (kind === 'defend' || kind === 'hunt') objectives.append(button(`${kind} (bonus lost)`, () => { void timeline(kind, DEMO.TIMELINE_SECONDS, false); }));
  }
  const keys = section(root, 'Keystones (update 5): as the server reports them',
    `Signatures: ${KEYSTONE_SIGNATURE_IDS.length} of ${KEYSTONES.length} keystones${unmappedKeystones().length > 0 ? ` — NO FAMILY: ${unmappedKeystones().join(', ')}` : ''}. "take" fires the keystone event for the own hero (the third replaces the oldest) and updates the roster: the moment plays, the fighting score gains that family's voice at its next bar, own attacks gain weight / sparkle. "own" / "ally" fire one trigger of that keystone with its real events. Pick a combat scene first to hear the voices and the blades' whirr.`);
  keys.append(button('clear', () => { for (const slot of [own, ally]) setKeystones([], slot); }));
  keys.append(button('draft: open', () => { setKeystones([]); keystoneDraft(true); }), button('draft: open, slots full', () => keystoneDraft(true, true)), button('draft: close', () => keystoneDraft(false)));
  keys.append(button('pick: fits (2 tags)', () => { fitsDraft(); bus.emit('ui:pick', { index: 0 }); }), button('pick: plain', () => { fitsDraft(); bus.emit('ui:pick', { index: 2 }); }));
  keys.append(button('ally takes one', () => { setKeystones([], ally); takeKeystone('familiar', ally); }));
  for (const k of KEYSTONES) {
    const row = el('div', '', 'row');
    row.append(el('code', `${k.id} (${keystoneFamily(k.id)})`.padEnd(30)));
    row.append(button('take', () => takeKeystone(k.id), `ks:${k.id}`), button('own', () => { if (!(keystonesOf.get(own) ?? []).includes(k.id)) takeKeystone(k.id); keystoneTrigger(k.id, own); }),
      button('ally', () => { if (!(keystonesOf.get(ally) ?? []).includes(k.id)) setKeystones([k.id], ally); keystoneTrigger(k.id, ally); }));
    keys.append(row);
  }
  const cls = section(root, 'Own hero class (for local actions and weapon layers on hits)');
  for (const c of CLASS_IDS) cls.append(button(c, () => { ownClass = c; state.roster = roster(); paintActive(); }, `class:${c}`));
  for (const a of [0, 1]) cls.append(button(a === 0 ? 'secondary: standard' : 'secondary: art', () => { ownArt = a; state.roster = roster(); paintActive(); }, `art:${a}`));

  const map = section(root, 'Ability → sound map (every id of ABILITY_BY_ID)', 'Unmapped ids must be none. Click an id to hear it as the own hero.');
  const missing = unmappedAbilities();
  const check = el('p', missing.length === 0 ? `All ${abilitySoundTable().length} ability ids are mapped.` : `UNMAPPED: ${missing.join(', ')}`);
  check.id = 'audiodemo-unmapped';
  if (missing.length > 0) check.style.color = '#ff7b6b';
  map.before(check);
  for (const line of abilitySoundTable()) {
    const id = line.split(' ')[0];
    const btn = button(id, () => audioInternals()?.sfx.ability(id, true));
    btn.title = line;
    map.append(btn);
  }

  // ---------------------------------------------------------------- sounds
  root.append(el('h2', 'Every sound (direct)'));
  root.append(el('p', 'Each click plays the next round-robin variant with fresh random pitch / gain, so press a button several times.'));
  const groups = new Map<string, HTMLElement>();
  for (const [name, play] of SFX_CASES) {
    const group = name.split('.')[0];
    let row = groups.get(group);
    if (!row) {
      root.append(el('h3', group));
      row = el('div', '', 'row');
      root.append(row);
      groups.set(group, row);
    }
    row.append(button(name.slice(group.length + 1) || name, () => { const e = audioInternals(); if (e) play(e.sfx); }));
  }
  const seq = section(root, 'Sequences and variation');
  for (const [label, action] of SEQUENCES) seq.append(button(label, action));

  const events = section(root, 'Game events on the bus (as the server sends them)',
    'Goes through audio/index.ts: own vs. ally, shield / boss detection from spawn events, burn ticks, de-duplication of local actions.');
  for (const [label, action] of GAME_EVENTS) events.append(button(label, action));

  const uiRow = section(root, 'Interface sounds via data-sfx (hover and click these)',
    'Real buttons carrying data-sfx; the delegated listener in audio/index.ts picks the sound. The last one has no attribute and gets the default hover / click.');
  for (const kind of ['click', 'confirm', 'back', 'error', 'buy', 'equip', 'tab', 'toggle', 'ascend', 'talent', 'relic', 'claim', 'art']) {
    const btn = el('button', `data-sfx="${kind}"`);
    btn.type = 'button';
    btn.setAttribute('data-sfx', kind);
    btn.setAttribute('data-testid', `sfx-${kind}`);
    uiRow.append(btn);
  }
  const plain = el('button', 'no attribute');
  plain.type = 'button';
  plain.setAttribute('data-testid', 'sfx-default');
  uiRow.append(plain);

  // ---------------------------------------------------------------- stress + measurement
  const stressRow = section(root, 'Stress', `${STRESS.HITS} hits + ${STRESS.KILLS} kills + ${STRESS.RESONANCES} Resonances within ${STRESS.SPAN_S} s. Start a boss scene first for the worst case. Watch the meter: it must stay left of the red line and the mix must stay readable.`);
  const stressOut = el('span', '');
  stressOut.id = 'audiodemo-stress';
  stressRow.append(button('STRESS', () => {
    stressOut.textContent = ' running…';
    void stress().then((r) => {
      stressOut.textContent = ` peak ${r.peakDb.toFixed(1)} dBFS · live nodes ${r.liveBefore} → ${r.liveAfter} · sample voices still sounding ${r.voicesAfter} · refused ${r.dropped}, cut short ${r.stolen} (totals)`;
    });
  }, '', 'warn'), stressOut);

  stressRow.append(button('OBJECTIVE STRESS (6 bombers + 2 ultimates + timer + Resonance chain)', () => window.__audiodemo?.objectiveStress(), '', 'warn'));
  stressRow.append(button('KEYSTONE STRESS (4 heroes × 2 keystones on top of the objective stress)', () => { void window.__audiodemo?.keystoneStress(); }, '', 'warn'));

  const measure = section(root, 'Offline measurements', 'Renders every sound, music state and ambience with an OfflineAudioContext at full volume and reports peak, loudest 400 ms, RMS and DC offset after the master chain. Takes a while.');
  const out = el('pre', '');
  out.id = 'audiodemo-measure';
  measure.append(
    button('Measure designed sounds', () => { out.textContent = 'rendering…'; void renderAll(true).then((s) => { out.textContent = formatStats(s); }); }),
    button('Measure synth fallbacks', () => { out.textContent = 'rendering…'; void renderAll(false).then((s) => { out.textContent = formatStats(s); }); }),
  );
  root.append(out);
  root.append(el('p', `${SAMPLES.length} sample files in the manifest. Sources and licences: docs/AUDIO.md.`));

  paintActive();

  window.__audiodemo = {
    start: () => { bus.emit('ui:gesture'); scene(sceneName, false); hookTickLog(); },
    tickLog: () => { hookTickLog(); return tickLog.splice(0); },
    callLog: () => { hookTickLog(); return callLog.splice(0); },
    now: () => audioInternals()?.ctx.currentTime ?? 0,
    debug: audioDebug,
    scene,
    scenes: Object.keys(SCENES),
    setBiome,
    fire,
    events: GAME_EVENTS.map(([label]) => label),
    event: (label) => { GAME_EVENTS.find(([l]) => l === label)?.[1](); },
    cases: SFX_CASES.map(([name]) => name),
    play: (name) => { const e = audioInternals(); const c = SFX_CASES.find(([n]) => n === name); if (e && c) c[1](e.sfx); },
    forceSynth: (on) => { audioInternals()?.sfx.setForceSynth(on); },
    stress,
    renderAll,
    renderCases,
    renderDepths,
    setDepth,
    unmapped: unmappedAbilities,
    abilityTable: abilitySoundTable,
    ultimateStress: () => {
      const engine = audioInternals();
      if (engine) for (const [when, play] of ultimateStressEvents()) window.setTimeout(() => play(engine.sfx), when * 1000);
    },
    renderUpdate4,
    renderSequences: async (withCurve = true) => {
      await loadOfflineBank();
      const out: RenderStats[] = [];
      for (const [name, events, seconds] of HORDE_SEQUENCES) out.push(await renderSequence(name, events, seconds, { envelope: withCurve }));
      // single cues whose shape over time matters
      for (const name of ['horde.action.shaman.mend', 'horde.action.bomber.fuse', 'horde.action.necromancer.raise', 'horde.action.reaver.leap', 'horde.action.aegis.domeUp', 'horde.action.aegis.domeDown']) {
        const play = SFX_CASES.find(([n]) => n === name)?.[1];
        if (play) out.push(await renderSequence(name, [[0, play]], DEMO.DEFAULT_RENDER_S, { envelope: withCurve }));
      }
      return out;
    },
    timeline,
    objectiveStress: () => {
      const engine = audioInternals();
      if (engine) for (const [when, play] of objectiveStressEvents()) window.setTimeout(() => play(engine.sfx), when * 1000);
    },
    interrupt: (id) => { audioInternals()?.sfx.interrupt(id); },
    loadOfflineBank,
    renderUpdate5,
    renderSignatures,
    renderMasking: async (withSamples = true) => { if (withSamples) await loadOfflineBank(); return renderKeystoneMasking({ samples: withSamples }); },
    renderMusicWith: async (name, seconds, o) => { await loadOfflineBank(); return renderMusic(name, seconds, o.bossPhase ?? 1, o); },
    keystoneStress: () => liveStress(keystoneStressEvents(), 6000),
    setKeystones,
    takeKeystone,
    keystoneDraft,
    keystoneTrigger,
    channel,
    keystoneIds: KEYSTONES.map((k) => k.id),
  };
}

declare global {
  interface Window {
    __audiodemo?: {
      start(): void;
      tickLog(): TickLogEntry[];
      callLog(): string[];
      now(): number;
      debug(): AudioDebug | null;
      scene(name: string, newChamber?: boolean): void;
      scenes: string[];
      setBiome(biome: BiomeId): void;
      fire(ev: GameEvent): void;
      events: string[];
      event(label: string): void;
      cases: string[];
      play(name: string): void;
      forceSynth(on: boolean): void;
      stress(): Promise<StressResult>;
      renderAll(withSamples?: boolean): Promise<RenderStats[]>;
      renderCases(filter?: string, withSamples?: boolean): Promise<RenderStats[]>;
      renderDepths(withSamples?: boolean): Promise<RenderStats[]>;
      setDepth(depth: number): void;
      unmapped(): string[];
      abilityTable(): string[];
      ultimateStress(): void;
      renderUpdate4(withSamples?: boolean): Promise<RenderStats[]>;
      renderSequences(withCurve?: boolean): Promise<RenderStats[]>;
      timeline(kind: ObjectiveKind, seconds?: number, bonus?: boolean): Promise<TimelineResult>;
      objectiveStress(): void;
      interrupt(id: number): void;
      loadOfflineBank: typeof loadOfflineBank;
      renderUpdate5(withSamples?: boolean): Promise<RenderStats[]>;
      renderSignatures(withSamples?: boolean): Promise<{ stats: RenderStats[]; pairs: Closeness[] }>;
      renderMasking(withSamples?: boolean): Promise<MaskingResult[]>;
      renderMusicWith(name: 'menu' | 'calm' | 'combat' | 'elite' | 'boss', seconds: number, o: Parameters<typeof renderMusic>[3] & { bossPhase?: number }): Promise<RenderStats>;
      keystoneStress(): Promise<StressResult>;
      setKeystones(ids: string[], slot?: number): void;
      takeKeystone(id: string, slot?: number): void;
      keystoneDraft(open: boolean, full?: boolean): void;
      keystoneTrigger(id: string, slot: number): void;
      channel(slot: number, ms: number): void;
      keystoneIds: string[];
    };
  }
}

boot();
