/** Run director: room generation, wave composition, drafts, doors and the chamber-to-chamber flow. */
import { NET, RUN, TICK_DT, WORLD } from '../constants.ts';
import { BOON_TUNING } from '../data/boons.ts';
import { ENEMIES, type EnemyDef } from '../data/enemies.ts';
import type { Door, DoorType, EnemyKind, Obstacle, RoomLayout } from '../types.ts';
import { applyBoon, generateDraft } from './boons.ts';
import { healHero, killEnemy, reviveHero } from './combat.ts';
import { livingEnemies, spawnEnemy } from './enemies.ts';
import { placeHero } from './players.ts';
import type { Rng } from './rng.ts';
import type { Hero } from './state.ts';
import { DIRECTOR, SIM } from './tuning.ts';
import type { World } from './world.ts';

export interface QueuedSpawn {
  kind: EnemyKind;
  elite: boolean;
}

export interface DirectorState {
  /** Sandbox mode for tests: no waves, no clear detection. */
  manual: boolean;
  queue: QueuedSpawn[];
  spawnTimer: number;
  waveTimer: number;
  waveDelay: number;
  clearTimer: number;
}

export const createDirector = (): DirectorState => ({ manual: false, queue: [], spawnTimer: 0, waveTimer: 0, waveDelay: 0, clearTimer: 0 });

const OBSTACLE_KINDS: { kind: Obstacle['kind']; r: number }[] = [
  { kind: 'pillar', r: 0.9 }, { kind: 'column', r: 0.65 }, { kind: 'barrels', r: 0.8 },
  { kind: 'crates', r: 0.9 }, { kind: 'rubble', r: 1.1 }, { kind: 'brazier', r: 0.5 },
];

export function roomSpawns(d: number): { x: number; z: number }[] {
  const z = d / 2 - DIRECTOR.SPAWN_WALL_OFFSET;
  const spawns: { x: number; z: number }[] = [];
  for (let i = 0; i < NET.MAX_PLAYERS; i++) spawns.push({ x: (i - (NET.MAX_PLAYERS - 1) / 2) * DIRECTOR.SPAWN_SPACING, z });
  return spawns;
}

export function doorPositions(room: RoomLayout, count: number): { x: number; z: number }[] {
  const z = -room.d / 2 + DIRECTOR.DOOR_WALL_OFFSET;
  if (count <= 1) return [{ x: 0, z }];
  return [{ x: -room.w / 4, z }, { x: room.w / 4, z }];
}

/**
 * Rectangular arena with mirrored obstacles. Every obstacle keeps OBSTACLE_GAP to its neighbours and
 * WALL_CLEARANCE to the walls, so there are always lanes wide enough for the largest enemy.
 */
export function generateRoom(rng: Rng, kind: 'combat' | 'elite' | 'boss'): RoomLayout {
  const boss = kind === 'boss';
  const w = boss ? DIRECTOR.BOSS_ROOM_W : rng.int(DIRECTOR.ROOM_W_MIN / 2, DIRECTOR.ROOM_W_MAX / 2) * 2;
  const d = boss ? DIRECTOR.BOSS_ROOM_D : rng.int(DIRECTOR.ROOM_D_MIN / 2, DIRECTOR.ROOM_D_MAX / 2) * 2;
  const seed = rng.u32();
  const spawns = roomSpawns(d);
  const room: RoomLayout = { seed, w, d, obstacles: [], spawns };
  const doors = [...doorPositions(room, 1), ...doorPositions(room, 2)];
  const wanted = boss ? DIRECTOR.BOSS_OBSTACLES : rng.int(DIRECTOR.OBSTACLES_MIN, DIRECTOR.OBSTACLES_MAX);

  const fits = (o: Obstacle): boolean => {
    if (Math.abs(o.x) + o.r > w / 2 - DIRECTOR.WALL_CLEARANCE || Math.abs(o.z) + o.r > d / 2 - DIRECTOR.WALL_CLEARANCE) return false;
    for (const s of spawns) if (Math.hypot(s.x - o.x, s.z - o.z) < o.r + DIRECTOR.SPAWN_CLEARANCE) return false;
    for (const p of doors) if (Math.hypot(p.x - o.x, p.z - o.z) < o.r + DIRECTOR.DOOR_CLEARANCE) return false;
    for (const other of room.obstacles) {
      if (Math.hypot(other.x - o.x, other.z - o.z) < o.r + other.r + DIRECTOR.OBSTACLE_GAP) return false;
    }
    return true;
  };

  if (boss) {
    // Mostly open arena: four pillars far out towards the corners.
    const px = w / 2 - DIRECTOR.WALL_CLEARANCE - DIRECTOR.BOSS_PILLAR_INSET;
    const pz = d / 2 - DIRECTOR.WALL_CLEARANCE - DIRECTOR.BOSS_PILLAR_INSET;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const o: Obstacle = { x: sx * px, z: sz * pz, r: DIRECTOR.BOSS_PILLAR_RADIUS, kind: 'pillar' };
      if (fits(o)) room.obstacles.push(o);
    }
    return room;
  }

  for (let attempt = 0; attempt < DIRECTOR.OBSTACLE_ATTEMPTS && room.obstacles.length < wanted; attempt++) {
    const type = rng.pick(OBSTACLE_KINDS);
    const left = wanted - room.obstacles.length;
    // A lone leftover slot may still be filled by a mirrored pair as long as the maximum allows it.
    const centred = (left === 1 && room.obstacles.length + 2 > DIRECTOR.OBSTACLES_MAX) || rng.chance(DIRECTOR.CENTRED_OBSTACLE_CHANCE);
    const x = centred ? 0 : rng.range(DIRECTOR.OBSTACLE_GAP / 2 + type.r, w / 2 - DIRECTOR.WALL_CLEARANCE - type.r);
    const z = rng.range(-d / 2 + DIRECTOR.WALL_CLEARANCE + type.r, d / 2 - DIRECTOR.WALL_CLEARANCE - type.r);
    const snap = (v: number): number => Math.round(v / DIRECTOR.OBSTACLE_GRID) * DIRECTOR.OBSTACLE_GRID;
    const a: Obstacle = { x: snap(x), z: snap(z), r: type.r, kind: type.kind };
    if (!fits(a)) continue;
    if (centred) {
      room.obstacles.push(a);
      continue;
    }
    const b: Obstacle = { ...a, x: -a.x };
    if (Math.hypot(a.x - b.x, 0) < a.r + b.r + DIRECTOR.OBSTACLE_GAP || !fits(b)) continue;
    room.obstacles.push(a, b);
  }
  return room;
}

export function partyScale(w: World): number {
  return 1 + RUN.COUNT_PER_EXTRA_PLAYER * (w.partySize - 1);
}

/** Total director cost of one regular wave in the given chamber. */
export function waveBudget(chamber: number, partySize: number): number {
  return (DIRECTOR.BUDGET_BASE + DIRECTOR.BUDGET_PER_CHAMBER * chamber) * (1 + RUN.COUNT_PER_EXTRA_PLAYER * (partySize - 1));
}

/** Picks enemy kinds until the budget is spent, honouring minChamber and the ranged caps. */
export function composeWave(rng: Rng, chamber: number, budget: number, partySize: number, room: number): EnemyKind[] {
  const kinds: EnemyKind[] = [];
  const counts: Record<string, number> = { archer: 0, mage: 0 };
  const caps: Record<string, number> = {
    archer: Math.floor(DIRECTOR.ARCHER_CAP_BASE + DIRECTOR.ARCHER_CAP_PER_HERO * partySize),
    mage: Math.floor(DIRECTOR.MAGE_CAP_BASE + DIRECTOR.MAGE_CAP_PER_HERO * partySize),
  };
  let left = budget;
  while (kinds.length < room) {
    const options: EnemyDef[] = [];
    for (const def of Object.values(ENEMIES)) {
      if (def.cost <= 0 || def.cost > left + SIM.EPS || def.minChamber > chamber) continue;
      const cap = caps[def.kind];
      if (cap !== undefined && (counts[def.kind] ?? 0) >= cap) continue;
      options.push(def);
    }
    if (options.length === 0) break;
    const pick = options[rng.weighted(options.map((def) => DIRECTOR.KIND_WEIGHT[def.kind as keyof typeof DIRECTOR.KIND_WEIGHT] ?? 1))] as EnemyDef;
    kinds.push(pick.kind);
    left -= pick.cost;
    if (counts[pick.kind] !== undefined) counts[pick.kind] = (counts[pick.kind] ?? 0) + 1;
  }
  return kinds;
}

function freeSpot(w: World, x: number, z: number, radius: number): boolean {
  for (const o of w.room.obstacles) if (Math.hypot(o.x - x, o.z - z) < o.r + radius + DIRECTOR.ENEMY_OBSTACLE_MARGIN) return false;
  return true;
}

/**
 * Random free point at least ENEMY_SPAWN_MIN_DISTANCE from every hero. If random sampling fails, a grid scan
 * looks for any legal point; only when the heroes cover the whole room is the farthest point returned.
 */
export function findSpawnPoint(w: World, radius: number): { x: number; z: number } {
  const hx = w.room.w / 2 - DIRECTOR.ENEMY_WALL_MARGIN;
  const hz = w.room.d / 2 - DIRECTOR.ENEMY_WALL_MARGIN;
  let best = { x: 0, z: -hz };
  let bestD = -1;
  const consider = (x: number, z: number): boolean => {
    if (!freeSpot(w, x, z, radius)) return false;
    let nearest = Infinity;
    for (const h of w.heroes) nearest = Math.min(nearest, Math.hypot(h.body.x - x, h.body.z - z));
    if (nearest > bestD) { bestD = nearest; best = { x, z }; }
    return nearest >= DIRECTOR.ENEMY_SPAWN_MIN_DISTANCE;
  };
  for (let i = 0; i < DIRECTOR.SPAWN_SAMPLES; i++) {
    if (consider(w.rng.range(-hx, hx), w.rng.range(-hz, hz))) return best;
  }
  for (let x = -hx; x <= hx; x += DIRECTOR.SPAWN_GRID_STEP) {
    for (let z = -hz; z <= hz; z += DIRECTOR.SPAWN_GRID_STEP) if (consider(x, z)) return best;
  }
  return best;
}

function setScaling(w: World): void {
  const oath = RUN.OATH[w.run.oath] ?? RUN.OATH[0];
  const chamber = w.run.chamber;
  w.hpMul = (1 + RUN.HP_GROWTH_PER_CHAMBER * chamber) * (1 + RUN.HP_PER_EXTRA_PLAYER * (w.partySize - 1)) * oath.hp;
  w.damageMul = (1 + RUN.DAMAGE_GROWTH_PER_CHAMBER * chamber) * (1 + DIRECTOR.DAMAGE_PER_EXTRA_PLAYER * (w.partySize - 1)) * oath.damage;
  w.speedMul = oath.speed;
}

export function enterChamber(w: World, index: number, entered: DoorType): void {
  const kind = RUN.CHAMBERS[index] ?? 'boss';
  const run = w.run;
  run.chamber = index;
  run.chamberKind = kind;
  run.entered = entered;
  run.phase = 'combat';
  run.wave = 0;
  run.waveCount = kind === 'boss' ? 1 : kind === 'elite' ? DIRECTOR.ELITE_WAVES
    : index >= DIRECTOR.WAVES_LATE_FROM_CHAMBER ? DIRECTOR.WAVES_LATE : DIRECTOR.WAVES_EARLY;
  run.doors = [];
  run.doorProgress = [];
  run.bossId = -1;
  run.draftPending = [];
  run.draftTime = 0;
  w.cursed = entered === 'cursed';
  w.room = generateRoom(w.rng, kind);
  w.enemies.length = 0;
  w.projectiles.length = 0;
  w.partySize = Math.max(1, w.heroes.filter((h) => h.connected).length);
  setScaling(w);
  for (const h of w.heroes) {
    const spawn = w.room.spawns[h.slot % w.room.spawns.length] as { x: number; z: number };
    placeHero(h, spawn.x, spawn.z);
    h.lastStandUsed = false;
    h.draft = [];
  }
  const dir = w.director;
  dir.queue.length = 0;
  dir.spawnTimer = 0;
  dir.waveTimer = 0;
  dir.waveDelay = DIRECTOR.FIRST_WAVE_DELAY;
  dir.clearTimer = 0;
  w.runVersion++;
}

function startWave(w: World): void {
  const run = w.run;
  const dir = w.director;
  run.wave++;
  dir.waveTimer = 0;
  dir.waveDelay = DIRECTOR.WAVE_DELAY;
  const room = Math.max(0, WORLD.MAX_ENEMIES - livingEnemies(w));
  const budget = waveBudget(run.chamber, w.partySize);
  if (run.chamberKind === 'boss') {
    dir.queue.push({ kind: 'regent', elite: false });
  } else if (run.chamberKind === 'elite') {
    if (run.wave === 1) {
      dir.queue.push({ kind: 'champion', elite: false });
      for (const kind of composeWave(w.rng, run.chamber, budget * DIRECTOR.ELITE_ESCORT_BUDGET, w.partySize, room - 1)) dir.queue.push({ kind, elite: true });
    } else {
      for (const kind of composeWave(w.rng, run.chamber, budget * DIRECTOR.ELITE_REINFORCE_BUDGET, w.partySize, room)) dir.queue.push({ kind, elite: w.cursed });
    }
  } else {
    for (const kind of composeWave(w.rng, run.chamber, budget, w.partySize, room)) dir.queue.push({ kind, elite: w.cursed });
  }
  w.emit({ e: 'wave', wave: run.wave, waveCount: run.waveCount });
  w.runVersion++;
}

function spawnQueued(w: World, q: QueuedSpawn): void {
  const def = ENEMIES[q.kind];
  let point: { x: number; z: number };
  if (q.kind === 'regent' || q.kind === 'champion') {
    point = { x: 0, z: -w.room.d / 6 };
    let nearest = Infinity;
    for (const h of w.heroes) nearest = Math.min(nearest, Math.hypot(h.body.x - point.x, h.body.z - point.z));
    if (nearest < DIRECTOR.ENEMY_SPAWN_MIN_DISTANCE || !freeSpot(w, point.x, point.z, def.radius)) point = findSpawnPoint(w, def.radius);
  } else {
    point = findSpawnPoint(w, def.radius);
  }
  const e = spawnEnemy(w, q.kind, point.x, point.z, { elite: q.elite });
  if (e && e.boss) {
    w.run.bossId = e.id;
    w.runVersion++;
  }
}

function openDraft(w: World): void {
  const run = w.run;
  const cursed = run.entered === 'cursed';
  run.draftPending = [];
  for (const h of w.heroes) {
    h.draft = generateDraft(w.rng, h, {
      choices: cursed ? BOON_TUNING.CURSED_DRAFT_CHOICES : RUN.DRAFT_CHOICES,
      guaranteeRare: cursed,
      guaranteeInfusion: run.chamber === 0,
    });
    if (h.draft.length > 0) run.draftPending.push(h.slot);
  }
  run.draftTime = RUN.DRAFT_TIMEOUT_SECONDS;
  run.phase = 'draft';
  w.runVersion++;
}

function chamberCleared(w: World): void {
  const run = w.run;
  w.projectiles.length = 0;
  w.emit({ e: 'chamberClear' });
  for (const h of w.heroes) {
    if (h.state === 'downed') reviveHero(w, h, -1, WORLD.REVIVE_HP_FRACTION, SIM.REVIVE_IFRAMES);
    if (run.entered === 'blessing') healHero(w, h, h.maxHp * BOON_TUNING.BLESSING_HEAL_FRACTION);
  }
  openDraft(w);
}

/** Applies a draft choice. Returns false if the hero has nothing to pick or the index is out of range. */
export function pickBoon(w: World, h: Hero, index: number): boolean {
  if (w.run.phase !== 'draft') return false;
  const offer = h.draft[index];
  if (!offer) return false;
  const level = applyBoon(h, offer.id);
  h.draft = [];
  const at = w.run.draftPending.indexOf(h.slot);
  if (at >= 0) w.run.draftPending.splice(at, 1);
  w.runVersion++;
  if (level > 0) {
    w.boonVersion++;
    w.emit({ e: 'boon', slot: h.slot, id: offer.id, level });
  }
  return true;
}

function openDoors(w: World): void {
  const run = w.run;
  const next = RUN.CHAMBERS[run.chamber + 1];
  let types: DoorType[];
  if (next === 'boss') {
    types = ['boss'];
  } else {
    const pool: DoorType[] = ['boon', 'blessing', 'cursed'];
    pool.splice(w.rng.int(0, pool.length - 1), 1);
    if (w.rng.chance(0.5)) pool.reverse();
    types = pool;
  }
  const spots = doorPositions(w.room, types.length);
  run.doors = types.map((type, i): Door => ({ x: (spots[i] as { x: number }).x, z: (spots[i] as { z: number }).z, type }));
  run.doorProgress = types.map(() => 0);
  run.phase = 'doors';
  w.runVersion++;
}

function stepDraft(w: World): void {
  const run = w.run;
  run.draftTime = Math.max(0, run.draftTime - TICK_DT);
  let waiting = false;
  for (const slot of run.draftPending) {
    const h = w.hero(slot);
    if (h && h.connected) waiting = true;
  }
  if (waiting && run.draftTime > 0) return;
  // Timeout (or only disconnected heroes left): everyone still pending takes their first option.
  for (const slot of [...run.draftPending]) {
    const h = w.hero(slot);
    if (h) pickBoon(w, h, 0);
  }
  run.draftPending = [];
  openDoors(w);
}

function stepDoors(w: World): void {
  const run = w.run;
  const r2 = WORLD.DOOR_RADIUS * WORLD.DOOR_RADIUS;
  for (const h of w.heroes) h.inDoor = false;
  for (let i = 0; i < run.doors.length; i++) {
    const door = run.doors[i] as Door;
    let present = 0;
    let all = true;
    for (const h of w.heroes) {
      if (h.state !== 'alive' || !h.connected) continue;
      const dx = h.body.x - door.x;
      const dz = h.body.z - door.z;
      if (dx * dx + dz * dz <= r2) { present++; h.inDoor = true; } else all = false;
    }
    const step = TICK_DT / WORLD.DOOR_HOLD_SECONDS;
    const p = run.doorProgress[i] ?? 0;
    run.doorProgress[i] = all && present > 0 ? Math.min(1, p + step) : Math.max(0, p - step * 2);
    if ((run.doorProgress[i] as number) >= 1 - SIM.EPS) {
      w.emit({ e: 'doorChosen', type: door.type });
      enterChamber(w, run.chamber + 1, door.type);
      return;
    }
  }
}

function stepCombat(w: World): void {
  const run = w.run;
  const dir = w.director;
  const dt = TICK_DT;
  if (dir.manual) return;

  if (run.bossId >= 0 && run.chamberKind === 'boss') {
    const boss = w.enemies.find((e) => e.id === run.bossId);
    if (!boss || boss.dead) {
      // The Regent is dead: its host crumbles with it.
      for (const e of w.enemies) if (!e.dead) killEnemy(w, e, -1);
      w.projectiles.length = 0;
      for (const h of w.heroes) if (h.state === 'downed') reviveHero(w, h, -1, WORLD.REVIVE_HP_FRACTION, SIM.REVIVE_IFRAMES);
      w.emit({ e: 'chamberClear' });
      run.phase = 'victory';
      w.runVersion++;
      return;
    }
  }

  dir.waveTimer += dt;
  if (dir.queue.length > 0) {
    dir.spawnTimer -= dt;
    while (dir.queue.length > 0 && dir.spawnTimer <= 0) {
      spawnQueued(w, dir.queue.shift() as QueuedSpawn);
      dir.spawnTimer += DIRECTOR.SPAWN_STAGGER;
    }
    return;
  }
  dir.spawnTimer = 0;
  let alive = 0;
  let waveAlive = 0;
  for (const e of w.enemies) {
    if (e.dead) continue;
    alive++;
    if (!e.summoned && !e.boss) waveAlive++;
  }
  if (run.wave < run.waveCount) {
    const ready = run.wave === 0 || waveAlive <= DIRECTOR.NEXT_WAVE_ALIVE || dir.waveTimer >= DIRECTOR.WAVE_TIMEOUT;
    if (!ready) return;
    dir.waveDelay -= dt;
    if (dir.waveDelay <= 0) startWave(w);
    return;
  }
  if (alive > 0) {
    dir.clearTimer = 0;
    return;
  }
  dir.clearTimer += dt;
  if (dir.clearTimer >= DIRECTOR.CLEAR_DELAY) chamberCleared(w);
}

export function stepDirector(w: World): void {
  const run = w.run;
  if (run.phase === 'combat') {
    run.elapsed += TICK_DT;
    stepCombat(w);
  } else if (run.phase === 'draft') {
    run.elapsed += TICK_DT;
    stepDraft(w);
  } else if (run.phase === 'doors') {
    run.elapsed += TICK_DT;
    stepDoors(w);
  }
}
