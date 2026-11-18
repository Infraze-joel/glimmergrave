/**
 * The guided training session: one hero in a fixed crypt arena, taken through TUTORIAL_STEPS (data/tutorial.ts).
 * Every step is scripted here and advances when its goal is met. Nothing can be failed for good: the hero's
 * health never drops below 1, training targets come back when they are destroyed, the slow attack of the dash
 * lesson simply repeats, and the draft resolves itself when its timer runs out.
 */
import { RUN, TICK_DT, WORLD } from '../constants.ts';
import { XP_REWARDS } from '../data/mastery.ts';
import { REWARDS } from '../data/meta.ts';
import { TUTORIAL_STEPS, type TutorialStep } from '../data/tutorial.ts';
import type { EnemyKind, RoomLayout, TutorialState } from '../types.ts';
import { applyBoon, generateDraft, maxDashCharges } from './boons.ts';
import { killEnemy } from './combat.ts';
import { doorPositions, pickBoon, roomSpawns, stepDoorZones } from './director.ts';
import { beginAttack, landAttack, rayLength, spawnEnemy, type SpawnOpts } from './enemies.ts';
import { angleTo } from './geom.ts';
import { placeHero } from './players.ts';
import type { Enemy, EnemyAttack, Hero } from './state.ts';
import { SIM, TUTORIAL } from './tuning.ts';
import type { World } from './world.ts';

export interface TutorialRun {
  index: number;
  /** Seconds since the current step began. */
  time: number;
  /** > 0: the step's goal is met; the next step begins when this has run out. */
  linger: number;
  finished: boolean;
  /** Counters fed by the simulation (reset when a step begins). */
  secondaryHits: number;
  hazardHits: number;
  /** Enemies the step keeps alive (parallel to its positions); respawn timers for the ones that died. */
  ids: number[];
  respawn: number[];
  /** Step bookkeeping: kills, Resonances at step start, a Shock seen, dash lesson state. */
  kills: number;
  resonances: number;
  sawShock: boolean;
  attackTimer: number;
  attempts: number;
  dashed: boolean;
}

const createRun = (): TutorialRun => ({
  index: -1, time: 0, linger: 0, finished: false, secondaryHits: 0, hazardHits: 0, ids: [], respawn: [],
  kills: 0, resonances: 0, sawShock: false, attackTimer: 0, attempts: 0, dashed: false,
});

export function tutorialRoom(seed: number): RoomLayout {
  const hz = TUTORIAL.HAZARD;
  return {
    seed, biome: 'crypt', w: TUTORIAL.ROOM_W, d: TUTORIAL.ROOM_D,
    obstacles: TUTORIAL.OBSTACLES.map((o) => ({ ...o, kind: 'pillar' as const })),
    hazards: [{ x: hz.x, z: hz.z, r: hz.r, kind: 'spikes', period: hz.period, phase: 0 }],
    spawns: roomSpawns(TUTORIAL.ROOM_D),
  };
}

interface Spot { readonly x: number; readonly z: number }

interface Targets {
  spots: readonly Spot[];
  kind: EnemyKind;
  hp: number;
  opts: SpawnOpts;
}

/** What each step keeps in the arena (null = nothing). */
function targetsOf(step: TutorialStep): Targets | null {
  const hz = TUTORIAL.HAZARD;
  switch (step) {
    case 'attack': return { spots: TUTORIAL.ATTACK_DUMMIES, kind: 'minion', hp: TUTORIAL.ATTACK_DUMMY_HP, opts: { passive: true } };
    case 'dash': return { spots: [TUTORIAL.DASH_ATTACKER], kind: 'warrior', hp: TUTORIAL.ELEMENT_DUMMY_HP, opts: { passive: true } };
    case 'secondary': return { spots: TUTORIAL.GROUP_DUMMIES, kind: 'minion', hp: TUTORIAL.GROUP_DUMMY_HP, opts: { passive: true } };
    case 'burn': case 'resonance': case 'storm':
      return { spots: TUTORIAL.ELEMENT_DUMMIES, kind: 'minion', hp: TUTORIAL.ELEMENT_DUMMY_HP, opts: { passive: true } };
    case 'hazard': return { spots: [{ x: hz.x - TUTORIAL.CHASER_OFFSET, z: hz.z }], kind: 'minion', hp: TUTORIAL.CHASER_HP, opts: { reckless: true } };
    default: return null;
  }
}

/** Infusion granted when a step begins, so the lesson works with every class. */
const GRANTS: Partial<Record<TutorialStep, string>> = {
  burn: 'infuse_ember_primary', resonance: 'infuse_rime_secondary', storm: 'infuse_storm_dash',
};

const stepOf = (t: TutorialRun): TutorialStep => TUTORIAL_STEPS[Math.max(0, Math.min(TUTORIAL_STEPS.length - 1, t.index))] as TutorialStep;

function markerOf(w: World, step: TutorialStep): TutorialState['marker'] {
  if (step === 'move') return { ...TUTORIAL.MOVE_MARKER };
  if (step === 'hazard') return { x: TUTORIAL.HAZARD.x + TUTORIAL.HAZARD_MARKER_OFFSET, z: TUTORIAL.HAZARD.z, r: TUTORIAL.HAZARD_MARKER_R };
  if (step === 'door') {
    const door = w.run.doors[0];
    return door ? { x: door.x, z: door.z, r: WORLD.DOOR_RADIUS } : null;
  }
  return null;
}

/** Publishes the tutorial state; a changed step or progress value counts as a structural run change. */
function publish(w: World, t: TutorialRun, progress: number): void {
  const step = stepOf(t);
  const value = Math.max(0, Math.min(1, progress));
  const prev = w.run.tutorial;
  if (prev && prev.step === step && prev.progress === value) return;
  w.run.tutorial = { step, index: t.index, total: TUTORIAL_STEPS.length, progress: value, marker: markerOf(w, step) };
  w.runVersion++;
}

function clearTargets(w: World, t: TutorialRun): void {
  for (const e of w.enemies) if (!e.dead) killEnemy(w, e, -1);
  t.ids.length = 0;
  t.respawn.length = 0;
}

function spawnTarget(w: World, t: TutorialRun, targets: Targets, i: number): void {
  const spot = targets.spots[i] as Spot;
  const e = spawnEnemy(w, targets.kind, spot.x, spot.z, targets.opts);
  if (!e) { t.ids[i] = -1; t.respawn[i] = TUTORIAL.DUMMY_RESPAWN_SECONDS; return; }
  e.hp = targets.hp;
  e.maxHp = targets.hp;
  e.shieldHp = 0;
  if (targets.opts.reckless) {
    e.speedMul = TUTORIAL.CHASER_SPEED_MUL;
    e.damageMul = TUTORIAL.CHASER_DAMAGE_MUL;
  }
  t.ids[i] = e.id;
  t.respawn[i] = 0;
}

/** Keeps the step's targets alive: whatever was destroyed returns after a short pause. Returns the live ones. */
function maintainTargets(w: World, t: TutorialRun, targets: Targets, out: Enemy[]): void {
  out.length = 0;
  for (let i = 0; i < targets.spots.length; i++) {
    const id = t.ids[i] ?? -1;
    let e: Enemy | undefined;
    if (id >= 0) for (const o of w.enemies) if (o.id === id && !o.dead) { e = o; break; }
    if (e) { out.push(e); continue; }
    if (id >= 0) {
      // It just died.
      t.kills++;
      t.ids[i] = -1;
      t.respawn[i] = TUTORIAL.DUMMY_RESPAWN_SECONDS;
      continue;
    }
    t.respawn[i] = (t.respawn[i] ?? 0) - TICK_DT;
    if ((t.respawn[i] as number) <= 0 && !t.finished && t.linger <= 0) spawnTarget(w, t, targets, i);
  }
}

function beginStep(w: World, t: TutorialRun, index: number): void {
  const h = w.heroes[0];
  if (!h) return;
  clearTargets(w, t);
  t.index = index;
  t.time = 0;
  t.linger = 0;
  t.secondaryHits = 0;
  t.hazardHits = 0;
  t.kills = 0;
  t.resonances = h.run.resonances;
  t.sawShock = false;
  t.attackTimer = TUTORIAL.DASH_FIRST;
  t.attempts = 0;
  t.dashed = false;
  const step = stepOf(t);
  // Every lesson starts with its tools ready.
  h.secondaryCd = 0;
  h.dashCharges = maxDashCharges(h);
  h.dashRecharge = 0;
  const grant = GRANTS[step];
  if (grant) {
    const level = applyBoon(h, grant);
    if (level > 0) {
      w.boonVersion++;
      w.emit({ e: 'boon', slot: h.slot, id: grant, level });
    }
  }
  const targets = targetsOf(step);
  if (targets) for (let i = 0; i < targets.spots.length; i++) spawnTarget(w, t, targets, i);
  if (step === 'draft') {
    h.draftOpts = { choices: RUN.DRAFT_CHOICES, guaranteeRare: false, guaranteeInfusion: false };
    h.draft = generateDraft(w.rng, h, h.draftOpts);
    w.run.draftPending = h.draft.length > 0 ? [h.slot] : [];
    w.run.draftTime = RUN.DRAFT_TIMEOUT_SECONDS;
    w.run.phase = 'draft';
  } else if (step === 'door') {
    const spot = doorPositions(w.room, 1)[0] as Spot;
    w.run.doors = [{ x: spot.x, z: spot.z, type: 'boon', objective: 'slay' }];
    w.run.doorProgress = [0];
    w.run.draftPending = [];
    w.run.phase = 'doors';
  }
  w.run.tutorial = null;
  publish(w, t, 0);
  w.emit({ e: 'tutorialStep', step });
}

/** Sets a training session up in place of a normal run. The caller has already reset the world for a new run. */
export function startTutorial(w: World, seed: number): void {
  const h = w.heroes[0];
  if (!h) return;
  w.room = tutorialRoom(seed);
  w.director.manual = true;
  w.run.phase = 'combat';
  w.run.chamberKind = 'combat';
  w.partySize = 1;
  const spawn = w.room.spawns[h.slot % w.room.spawns.length] as Spot;
  placeHero(h, spawn.x, spawn.z);
  const t = createRun();
  w.tutorial = t;
  beginStep(w, t, 0);
  w.runVersion++;
}

function finish(w: World, t: TutorialRun): void {
  t.finished = true;
  const run = w.run;
  run.phase = 'victory';
  run.rewards = w.heroes.map((h) => ({ slot: h.slot, glimmer: REWARDS.TUTORIAL, xp: XP_REWARDS.TUTORIAL, relics: [] }));
  w.director.chambersCleared = 1;
  run.chambersCleared = 1;
  w.emit({ e: 'chamberClear' });
  publish(w, t, 1);
  w.runVersion++;
}

/** The dash lesson: the training warrior repeats one slow lane attack aimed at the hero. */
function stepDashLesson(w: World, t: TutorialRun, h: Hero, attacker: Enemy | undefined): boolean {
  if (!attacker || attacker.spawnTime > 0) return false;
  const a = attacker.attack;
  if (!a) {
    attacker.rot = angleTo(attacker.x, attacker.z, h.body.x, h.body.z);
    t.attackTimer -= TICK_DT;
    if (t.attackTimer > 0) return false;
    t.attackTimer = TUTORIAL.DASH_EVERY;
    t.dashed = false;
    const rot = attacker.rot;
    const attack: EnemyAttack = {
      type: 'charge', t: TUTORIAL.DASH_WINDUP, x: attacker.x, z: attacker.z, rot, r: rayLength(w, attacker.x, attacker.z, rot, w.room.w + w.room.d, false),
      w: TUTORIAL.DASH_WIDTH, damage: TUTORIAL.DASH_DAMAGE, target: h.slot,
    };
    beginAttack(w, attacker, attack, 'line', 'windup');
    return false;
  }
  if (h.body.dashTime > SIM.EPS) t.dashed = true;
  a.t -= TICK_DT;
  if (a.t > SIM.EPS) return false;
  const before = h.damageTaken;
  landAttack(w, attacker, a, 'line');
  attacker.attack = null;
  attacker.anim = 'attack';
  attacker.animSeq++;
  t.attempts++;
  const avoided = h.damageTaken === before;
  return avoided && (t.dashed || t.attempts >= TUTORIAL.DASH_FALLBACK_ATTEMPTS);
}

const live: Enemy[] = [];

export function stepTutorial(w: World): void {
  const t = w.tutorial;
  const h = w.heroes[0];
  if (!t || !h || t.finished) return;
  t.time += TICK_DT;
  const step = stepOf(t);
  if (t.linger > 0) {
    t.linger -= TICK_DT;
    if (t.linger <= 0) {
      if (t.index + 1 >= TUTORIAL_STEPS.length) finish(w, t);
      else beginStep(w, t, t.index + 1);
    }
    return;
  }
  const targets = targetsOf(step);
  if (targets) maintainTargets(w, t, targets, live);
  else live.length = 0;

  let progress = 0;
  let done = false;
  switch (step) {
    case 'move': {
      const m = TUTORIAL.MOVE_MARKER;
      done = Math.hypot(h.body.x - m.x, h.body.z - m.z) <= m.r;
      break;
    }
    case 'attack':
      progress = t.kills / TUTORIAL.ATTACK_DUMMIES.length;
      done = t.kills >= TUTORIAL.ATTACK_DUMMIES.length;
      break;
    case 'dash':
      done = stepDashLesson(w, t, h, live[0]);
      break;
    case 'secondary':
      progress = t.secondaryHits / TUTORIAL.SECONDARY_HITS;
      done = t.secondaryHits >= TUTORIAL.SECONDARY_HITS;
      break;
    case 'burn':
      for (const e of live) if (e.status === 'ember') done = true;
      break;
    case 'resonance':
      done = h.run.resonances > t.resonances;
      break;
    case 'storm':
      for (const e of live) if (e.status === 'storm') t.sawShock = true;
      progress = t.sawShock ? 0.5 : 0;
      done = h.run.resonances > t.resonances && (t.sawShock || t.time >= TUTORIAL.STORM_FALLBACK_SECONDS);
      break;
    case 'hazard':
      done = t.hazardHits > 0;
      break;
    case 'draft':
      w.run.draftTime = Math.max(0, w.run.draftTime - TICK_DT);
      if (h.draft.length > 0 && w.run.draftTime <= 0) pickBoon(w, h, 0);
      done = h.draft.length === 0;
      break;
    case 'door':
      if (stepDoorZones(w)) {
        w.emit({ e: 'doorChosen', type: 'boon' });
        done = true;
      }
      break;
    default:
      done = true;
      break;
  }
  if (!done) {
    publish(w, t, progress);
    return;
  }
  publish(w, t, 1);
  if (step === 'draft') {
    w.run.phase = 'combat';
    w.run.draftPending = [];
    w.runVersion++;
  }
  if (step === 'door') {
    finish(w, t);
    return;
  }
  t.linger = TUTORIAL.STEP_LINGER;
}
