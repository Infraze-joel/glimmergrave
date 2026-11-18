/**
 * Chamber objectives (update 4): which objective a door leads to, where the shard / braziers / reliquary stand and
 * how the live `ObjectiveState` evolves. The chamber flow itself (waves, groups, clearing) stays in director.ts.
 */
import { RUN, TICK_DT, WORLD } from '../constants.ts';
import { OBJECTIVES, OBJECTIVE_TUNING } from '../data/objectives.ts';
import { OBJECTIVE_KINDS, type DoorType, type ObjectiveKind, type ObjectiveState } from '../types.ts';
import { healHero } from './combat.ts';
import { doorPositions } from './director.ts';
import { earn } from './meta.ts';
import type { Enemy } from './state.ts';
import { OBJECTIVE, SIM } from './tuning.ts';
import type { World } from './world.ts';

const T = OBJECTIVE_TUNING;

/** Director-side bookkeeping of the current chamber's objective (the public part is `World.run.objective`). */
export interface ObjectiveRun {
  kind: ObjectiveKind;
  /** Seconds the objective has been running. */
  time: number;
  /** Length of its timer: survive duration, hunt time limit, ritual bonus limit (0 = none). */
  total: number;
  /** Survive / ritual: seconds to the next group, groups sent so far. */
  spawnTimer: number;
  /** Defend: shard health, seconds until heroes may repair it again, seconds until the next `anchorHit` event. */
  anchorHp: number;
  anchorMaxHp: number;
  repairDelay: number;
  hitEventCd: number;
  /** Hunt: marked elites of this chamber and whether they have risen yet. */
  targetsTotal: number;
  targetsSpawned: boolean;
  /** The objective is complete (survive: timer over, ritual: all lit, vault: opened, others: chamber cleared). */
  complete: boolean;
  /** The bonus was earned (decided when the objective completes). */
  bonusEarned: boolean;
}

export const isSpecial = (kind: ObjectiveKind): boolean => kind !== 'slay';
/** Objectives without waves: enemies come in timed groups (survive, ritual) or not at all (vault). */
export const isEndless = (kind: ObjectiveKind): boolean => kind === 'survive' || kind === 'ritual' || kind === 'vault';
/** Objectives whose bonus condition exists at all. */
const hasBonus = (kind: ObjectiveKind): boolean => OBJECTIVES[kind].bonus !== '';

const round2 = (v: number): number => Math.round(v * 100) / 100;

export function surviveSeconds(chamber: number): number {
  return Math.min(T.SURVIVE.MAX_SECONDS, T.SURVIVE.SECONDS + T.SURVIVE.SECONDS_PER_CHAMBER * chamber);
}

export function huntTargets(partySize: number): number {
  return Math.floor(T.HUNT.TARGETS + T.HUNT.TARGETS_PER_EXTRA_PLAYER * (partySize - 1));
}

// ---------------------------------------------------------------------------------------------- doors

/** May `kind` be the objective of combat chamber `chamber` behind a door of `type`, with `vaults` already visited at this depth? */
export function objectiveAllowed(kind: ObjectiveKind, chamber: number, type: DoorType, vaults: number): boolean {
  const def = OBJECTIVES[kind];
  if (def.weight <= 0 || def.minChamber > chamber) return false;
  if (kind === 'vault' && (type === 'cursed' || vaults >= T.MAX_VAULTS_PER_DEPTH)) return false;
  return true;
}

/**
 * Objectives of the chambers behind a set of doors. Only combat chambers roll (weights and minChamber from
 * OBJECTIVES); elite and boss chambers, the first chamber of a depth and the ascend door are `slay`. The doors of
 * one choice never share a special objective; a vault is never cursed and appears at most
 * MAX_VAULTS_PER_DEPTH times per depth (counted when the party enters one). `pin` forces the first door's
 * objective where the rules allow it; pinning `slay` forces it on every door (tools / tests).
 */
export function rollDoorObjectives(w: World, types: readonly DoorType[], nextChamber: number, pin?: ObjectiveKind): ObjectiveKind[] {
  const out: ObjectiveKind[] = [];
  const kind = RUN.CHAMBERS[nextChamber];
  for (let i = 0; i < types.length; i++) {
    const type = types[i] as DoorType;
    if (kind !== 'combat' || type === 'descend' || type === 'ascend' || type === 'boss') { out.push('slay'); continue; }
    const options: ObjectiveKind[] = [];
    const weights: number[] = [];
    for (const k of OBJECTIVE_KINDS) {
      if (!objectiveAllowed(k, nextChamber, type, w.director.vaults)) continue;
      if (isSpecial(k) && out.includes(k)) continue;
      options.push(k);
      weights.push(OBJECTIVES[k].weight);
    }
    const rolled = options[w.rng.weighted(weights)] ?? 'slay';
    // The pin goes on the first door; pinning `slay` makes every door classic.
    out.push(pin !== undefined && (i === 0 || pin === 'slay') && options.includes(pin) ? pin : rolled);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------- placement

interface Spot { x: number; z: number; r: number }

/** Smallest free distance from a circle to obstacles, hazards, walls, spawn points, door zones and `others`, each minus its wanted gap. */
function clearance(w: World, x: number, z: number, r: number, others: readonly Spot[], otherGap: number, relax: number): number {
  const room = w.room;
  let free = Math.min(room.w / 2 - Math.abs(x) - r - OBJECTIVE.WALL_GAP * relax, room.d / 2 - Math.abs(z) - r - OBJECTIVE.WALL_GAP * relax);
  for (const o of room.obstacles) free = Math.min(free, Math.hypot(o.x - x, o.z - z) - o.r - r - OBJECTIVE.OBSTACLE_GAP * relax);
  for (const h of room.hazards) free = Math.min(free, Math.hypot(h.x - x, h.z - z) - h.r - r - OBJECTIVE.HAZARD_GAP * relax);
  for (const s of room.spawns) free = Math.min(free, Math.hypot(s.x - x, s.z - z) - r - OBJECTIVE.SPAWN_GAP * relax);
  for (const count of [1, 2]) {
    for (const d of doorPositions(room, count)) free = Math.min(free, Math.hypot(d.x - x, d.z - z) - r - WORLD.DOOR_RADIUS - OBJECTIVE.DOOR_GAP * relax);
  }
  for (const o of others) free = Math.min(free, Math.hypot(o.x - x, o.z - z) - o.r - r - otherGap * relax);
  return free;
}

/**
 * A free place for a circle of radius `r` within `spread` metres of the room's centre (Infinity = anywhere), clear
 * of obstacles, hazards, walls, spawns, doors and `others`. Random tries first; when the room is too cramped the
 * gaps shrink step by step, and as a last resort the best point of a grid scan is taken (never inside an obstacle
 * or a wall if the room has any free ground at all).
 */
export function findObjectiveSpot(w: World, r: number, spread: number, others: readonly Spot[], otherGap: number): { x: number; z: number } {
  const hx = Math.min(spread, w.room.w / 2 - r);
  const hz = Math.min(spread, w.room.d / 2 - r);
  for (let relax = 1; relax > 0.2; relax *= 0.7) {
    for (let i = 0; i < OBJECTIVE.PLACE_ATTEMPTS; i++) {
      const x = round2(w.rng.range(-hx, hx));
      const z = round2(w.rng.range(-hz, hz));
      if (clearance(w, x, z, r, others, otherGap, relax) >= 0) return { x, z };
    }
  }
  let best = { x: 0, z: 0 };
  let bestFree = -Infinity;
  for (let x = -Math.floor(w.room.w / 2 - r); x <= w.room.w / 2 - r; x++) {
    for (let z = -Math.floor(w.room.d / 2 - r); z <= w.room.d / 2 - r; z++) {
      const free = clearance(w, x, z, r, others, 0, 0);
      if (free > bestFree) { bestFree = free; best = { x, z }; }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------------------------- lifecycle

const emptyState = (kind: ObjectiveKind): ObjectiveState => ({
  kind, progress: 0, timeLeft: 0, bonus: hasBonus(kind), status: 'active', anchor: null, sites: [], targets: [],
});

/**
 * Sets up the objective of the chamber that was just entered (room, party size and scaling are final): places the
 * shard, the braziers or the reliquary, publishes `run.objective` and announces it. Returns the bookkeeping.
 */
export function beginObjective(w: World, kind: ObjectiveKind): ObjectiveRun {
  const state = emptyState(kind);
  const obj: ObjectiveRun = {
    kind, time: 0, total: 0, spawnTimer: OBJECTIVE.FIRST_SPAWN, anchorHp: 0, anchorMaxHp: 0, repairDelay: 0, hitEventCd: 0,
    targetsTotal: 0, targetsSpawned: false, complete: false, bonusEarned: false,
  };
  if (kind === 'survive') {
    obj.total = surviveSeconds(w.run.chamber);
    state.timeLeft = obj.total;
  } else if (kind === 'defend') {
    const spot = findObjectiveSpot(w, T.DEFEND.RADIUS, OBJECTIVE.CENTRE_SCATTER, [], 0);
    obj.anchorMaxHp = T.DEFEND.HP * w.damageMul;
    obj.anchorHp = obj.anchorMaxHp;
    state.anchor = { x: spot.x, z: spot.z, r: T.DEFEND.RADIUS, hp: 1 };
  } else if (kind === 'hunt') {
    obj.total = T.HUNT.SECONDS;
    obj.targetsTotal = huntTargets(w.partySize);
    state.timeLeft = obj.total;
  } else if (kind === 'ritual') {
    obj.total = T.RITUAL.BONUS_SECONDS;
    state.timeLeft = obj.total;
    for (let i = 0; i < T.RITUAL.SITES; i++) {
      const spot = findObjectiveSpot(w, T.RITUAL.RADIUS, Infinity, state.sites, OBJECTIVE.SITE_GAP);
      state.sites.push({ x: spot.x, z: spot.z, r: T.RITUAL.RADIUS, progress: 0, lit: false });
    }
  } else if (kind === 'vault') {
    const spot = findObjectiveSpot(w, OBJECTIVE.VAULT_RADIUS, OBJECTIVE.CENTRE_SCATTER, [], 0);
    state.anchor = { x: spot.x, z: spot.z, r: OBJECTIVE.VAULT_RADIUS, hp: 1 };
  }
  w.run.objective = state;
  w.emit({ e: 'objective', kind, what: 'start' });
  return obj;
}

function loseBonus(w: World, state: ObjectiveState): void {
  if (!state.bonus) return;
  state.bonus = false;
  w.emit({ e: 'objective', kind: state.kind, what: 'bonusLost' });
  w.runVersion++;
}

/** The shard of a `defend` chamber, while it stands. */
export function standingAnchor(w: World): { x: number; z: number; r: number } | null {
  const obj = w.director.obj;
  return obj && obj.kind === 'defend' && obj.anchorHp > 0 && w.run.objective ? w.run.objective.anchor : null;
}

/** An enemy attack struck the bell shard. */
export function damageAnchor(w: World, amount: number): void {
  const obj = w.director.obj;
  const state = w.run.objective;
  if (!obj || !state || !state.anchor || obj.kind !== 'defend' || obj.anchorHp <= 0 || obj.complete || amount <= 0) return;
  obj.anchorHp = Math.max(0, obj.anchorHp - amount);
  obj.repairDelay = T.DEFEND.REPAIR_DELAY;
  state.anchor.hp = obj.anchorHp / obj.anchorMaxHp;
  if (obj.hitEventCd <= 0) {
    obj.hitEventCd = T.DEFEND.ANCHOR_HIT_EVENT_SECONDS;
    w.emit({ e: 'objective', kind: 'defend', what: 'anchorHit' });
  }
  if (obj.anchorHp <= 0) loseBonus(w, state);
}

/** Wave progress of `slay` and `defend` chambers: waves that are over / all waves. */
export function setWaveProgress(w: World, cleared: number): void {
  const state = w.run.objective;
  if (!state || (state.kind !== 'slay' && state.kind !== 'defend')) return;
  state.progress = w.run.waveCount > 0 ? Math.min(1, cleared / w.run.waveCount) : 0;
}

/**
 * Advances timers, braziers, the shard's repair, the hunt and the vault by one tick. Sets `obj.complete` for the
 * objectives that end by themselves (survive, ritual, vault); the director ends the others when the room is clear.
 */
export function stepObjective(w: World, obj: ObjectiveRun): void {
  const state = w.run.objective;
  if (!state || obj.complete) return;
  const dt = TICK_DT;
  obj.time += dt;
  if (obj.kind === 'survive') {
    state.timeLeft = Math.max(0, obj.total - obj.time);
    state.progress = Math.min(1, obj.time / obj.total);
    // Bonus: nobody goes down. It is lost the moment a hero lies on the floor (a solo Second Wind included).
    if (state.bonus) {
      for (const h of w.heroes) if (h.connected && h.state !== 'alive') { loseBonus(w, state); break; }
    }
    if (obj.time >= obj.total - SIM.EPS) obj.complete = true;
  } else if (obj.kind === 'defend') {
    if (obj.hitEventCd > 0) obj.hitEventCd -= dt;
    if (obj.anchorHp <= 0 || !state.anchor) return;
    if (obj.repairDelay > 0) { obj.repairDelay -= dt; return; }
    if (obj.anchorHp >= obj.anchorMaxHp) return;
    const reach = T.DEFEND.REPAIR_RADIUS + state.anchor.r;
    let menders = 0;
    for (const h of w.heroes) {
      if (h.state !== 'alive' || !h.connected) continue;
      const dx = h.body.x - state.anchor.x;
      const dz = h.body.z - state.anchor.z;
      if (dx * dx + dz * dz <= reach * reach) menders++;
    }
    if (menders === 0) return;
    obj.anchorHp = Math.min(obj.anchorMaxHp, obj.anchorHp + obj.anchorMaxHp * T.DEFEND.REPAIR_PER_SECOND * menders * dt);
    state.anchor.hp = obj.anchorHp / obj.anchorMaxHp;
  } else if (obj.kind === 'hunt') {
    state.targets.length = 0;
    for (const e of w.enemies) if (e.marked && !e.dead) state.targets.push(e.id);
    if (obj.targetsSpawned) state.progress = Math.min(1, (obj.targetsTotal - state.targets.length) / Math.max(1, obj.targetsTotal));
    const hunted = obj.targetsSpawned && state.targets.length === 0;
    if (!hunted && state.timeLeft > 0) {
      state.timeLeft = Math.max(0, obj.total - obj.time);
      if (state.timeLeft <= 0) {
        // Too slow: the marked elites enrage and the bonus is gone.
        for (const e of w.enemies) if (e.marked && !e.dead) enrage(e);
        loseBonus(w, state);
      }
    }
  } else if (obj.kind === 'ritual') {
    const rate = dt / (T.RITUAL.SECONDS_TO_LIGHT * (1 + OBJECTIVE.RITUAL_SECONDS_PER_EXTRA_HERO * (w.partySize - 1)));
    let lit = 0;
    let sum = 0;
    for (let i = 0; i < state.sites.length; i++) {
      const site = state.sites[i] as ObjectiveState['sites'][number];
      if (!site.lit) {
        let inside = 0;
        for (const h of w.heroes) {
          if (h.state !== 'alive' || !h.connected) continue;
          const dx = h.body.x - site.x;
          const dz = h.body.z - site.z;
          if (dx * dx + dz * dz <= site.r * site.r) inside++;
        }
        // Overtime (bonus time over): no cooling; later the fire spreads on its own so the chamber always ends.
        const overtime = obj.time - T.RITUAL.BONUS_SECONDS;
        const spread = overtime >= T.RITUAL.OVERTIME_SPREAD_SECONDS ? rate * T.RITUAL.OVERTIME_SPREAD_RATE : 0;
        if (inside > 0) site.progress = Math.min(1, site.progress + spread + rate * (1 + T.RITUAL.EXTRA_HERO_SPEED * (inside - 1)));
        else if (overtime < 0) site.progress = Math.max(0, site.progress - rate * T.RITUAL.DECAY);
        else site.progress = Math.min(1, site.progress + spread);
        if (site.progress >= 1 - SIM.EPS) {
          site.progress = 1;
          site.lit = true;
          w.emit({ e: 'objective', kind: 'ritual', what: 'site', index: i });
          w.runVersion++;
        }
      }
      if (site.lit) lit++;
      sum += site.progress;
    }
    state.progress = state.sites.length > 0 ? sum / state.sites.length : 1;
    if (lit === state.sites.length) { obj.complete = true; return; }
    if (state.bonus) {
      state.timeLeft = Math.max(0, obj.total - obj.time);
      if (state.timeLeft <= 0) loseBonus(w, state);
    }
  } else if (obj.kind === 'vault' && state.anchor) {
    const reach = state.anchor.r + T.VAULT.OPEN_RADIUS_PAD;
    let present = false;
    for (const h of w.heroes) {
      if (h.state !== 'alive' || !h.connected) continue;
      const dx = h.body.x - state.anchor.x;
      const dz = h.body.z - state.anchor.z;
      if (dx * dx + dz * dz <= reach * reach) present = true;
    }
    const step = dt / OBJECTIVE.VAULT_HOLD_SECONDS;
    state.progress = present ? Math.min(1, state.progress + step) : Math.max(0, state.progress - step * 2);
    if (state.progress >= 1 - SIM.EPS) { state.progress = 1; obj.complete = true; }
  }
}

/** A marked elite whose hunt ran out of time (or that rises afterwards) hits harder and moves faster. */
export function enrage(e: Enemy): void {
  if (e.enraged) return;
  e.enraged = true;
  e.damageMul *= T.HUNT.ENRAGE_DAMAGE_MUL;
  e.speedMul *= T.HUNT.ENRAGE_SPEED_MUL;
}

/**
 * The objective is complete: decides the bonus, pays it (and the vault's hoard) into the run's earnings, heals in
 * a vault and announces `done`. Call once, before the chamber is cleared.
 */
export function finishObjective(w: World, obj: ObjectiveRun): void {
  const state = w.run.objective;
  if (!state || state.status === 'done') return;
  obj.complete = true;
  state.status = 'done';
  state.timeLeft = 0;
  state.progress = 1;
  state.targets.length = 0;
  obj.bonusEarned = hasBonus(obj.kind) && state.bonus;
  if (isSpecial(obj.kind)) {
    w.run.objectivesDone++;
    if (obj.bonusEarned) w.run.objectiveBonuses++;
  }
  if (obj.bonusEarned) earn(w.director.earnings, 'bonus', w.run.depth, w.cursed);
  if (obj.kind === 'vault') {
    earn(w.director.earnings, 'vault', w.run.depth, w.cursed);
    for (const h of w.heroes) healHero(w, h, h.maxHp * T.VAULT.HEAL_FRACTION);
  }
  w.emit({ e: 'objective', kind: obj.kind, what: 'done', bonus: obj.bonusEarned });
  w.runVersion++;
}

/** Extra draft choices and the rare guarantee the finished objective grants (met bonus, vault). */
export function draftBonus(obj: ObjectiveRun | null): { choices: number; rare: boolean } {
  if (!obj) return { choices: 0, rare: false };
  if (obj.kind === 'vault') return { choices: T.VAULT.EXTRA_CHOICES, rare: true };
  if (obj.bonusEarned) return { choices: T.BONUS_EXTRA_CHOICES, rare: true };
  return { choices: 0, rare: false };
}
