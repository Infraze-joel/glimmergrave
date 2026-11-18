/** Run director: run plan (bosses, biomes), room generation, wave composition, drafts, doors, rewards and the chamber flow. */
import { depthScale, NET, oathScale, RUN, TICK_DT, WORLD } from '../constants.ts';
import { BOON_TUNING } from '../data/boons.ts';
import { ULTIMATE } from '../data/classes.ts';
import { RELIC_TUNING } from '../data/relics.ts';
import { ENEMIES, ENEMY_TUNING, type EnemyDef } from '../data/enemies.ts';
import { OBJECTIVE_TUNING } from '../data/objectives.ts';
import {
  BOSS_KINDS, ELEMENT_IDS,
  type BiomeId, type BossKind, type Door, type DoorType, type ElementId, type EnemyKind, type Hazard, type ObjectiveKind, type Obstacle, type RoomLayout,
} from '../types.ts';
import { applyBoon, generateDraft } from './boons.ts';
import { grantShield, healHero, killEnemy, reviveHero } from './combat.ts';
import { livingEnemies, spawnEnemy } from './enemies.ts';
import { SUPPORT_KINDS } from './horde.ts';
import {
  beginObjective, draftBonus, finishObjective, isEndless, rollDoorObjectives, setWaveProgress, stepObjective, type ObjectiveRun,
} from './objectives.ts';
import { earn, emptyEarnings, glimmerReward, xpReward, type Earnings } from './meta.ts';
import { rollShards } from './loot.ts';
import { clearZones } from './zones.ts';
import { placeHero } from './players.ts';
import type { Rng } from './rng.ts';
import type { DraftOptions, Hero } from './state.ts';
import { stepTutorial } from './tutorial.ts';
import { BIOME, DIRECTOR, META, OBJECTIVE, SIM } from './tuning.ts';
import type { World } from './world.ts';

export interface QueuedSpawn {
  kind: EnemyKind;
  elite: boolean;
  herald?: boolean;
  /** Update 4: warded against an element, sent against the bell shard, a marked hunt target. */
  ward?: ElementId;
  siege?: boolean;
  marked?: boolean;
}

export interface DirectorState {
  /** Sandbox mode for tests: no waves, no clear detection. */
  manual: boolean;
  queue: QueuedSpawn[];
  spawnTimer: number;
  waveTimer: number;
  waveDelay: number;
  clearTimer: number;
  /** Biome of each act (see BIOME.ACT_STARTS). */
  biomes: BiomeId[];
  /** Boss fought (weakened) in the second elite chamber; never this run's final boss. */
  herald: BossKind;
  /** The current draft is the attunement draft at run start: combat follows instead of doors. */
  preDraft: boolean;
  /** Reward tally (whole run, all depths). `bossSlain`: at least one final boss fell. */
  chambersCleared: number;
  elitesSlain: number;
  bossSlain: boolean;
  /** What the party has earned so far (depth bonus already applied to every payment). */
  earnings: Earnings;
  /** Bookkeeping of the current chamber's objective (null in the lobby, the sandbox and the training session). */
  obj: ObjectiveRun | null;
  /** Vaults the party has entered at the current depth. */
  vaults: number;
  /** Tools / tests: objective forced onto the first door of every choice (and the chamber a run starts in). */
  pin: ObjectiveKind | null;
}

export const createDirector = (): DirectorState => ({
  manual: false, queue: [], spawnTimer: 0, waveTimer: 0, waveDelay: 0, clearTimer: 0,
  biomes: ['crypt', 'flooded', 'forge'], herald: 'matron', preDraft: false, chambersCleared: 0, elitesSlain: 0, bossSlain: false,
  earnings: emptyEarnings(), obj: null, vaults: 0, pin: null,
});

/** Test / tooling overrides of the seeded run plan. */
export interface RunOverrides {
  finalBoss?: BossKind;
  herald?: BossKind;
  /** Biomes of act 2 and act 3. */
  biomes?: [BiomeId, BiomeId];
  /**
   * Objective of the chamber the run starts in (if it is a combat chamber) and of the first door of every later
   * choice, wherever the rolling rules allow it. The other door is rolled as usual. `slay` pins every door: a
   * classic run without special objectives.
   */
  objective?: ObjectiveKind;
}

/** Draws the final boss, the herald and the biome order from the run seed. Always consumes the same random numbers. */
export function planRun(w: World, o: RunOverrides = {}): void {
  const final = w.rng.pick(BOSS_KINDS);
  const heraldRoll = w.rng.next();
  const flip = w.rng.chance(0.5);
  w.run.finalBoss = o.finalBoss ?? final;
  const others = BOSS_KINDS.filter((k) => k !== w.run.finalBoss);
  w.director.herald = o.herald !== undefined && o.herald !== w.run.finalBoss ? o.herald : (others[Math.floor(heraldRoll * others.length)] as BossKind);
  w.director.biomes = ['crypt', ...(o.biomes ?? (flip ? ['flooded', 'forge'] as const : ['forge', 'flooded'] as const))];
  w.director.pin = o.objective ?? null;
}

/**
 * The plan of the next depth: a final boss other than the one just slain, a herald that is neither, and a fresh
 * biome order — all from the run's seeded generator.
 */
export function planDescent(w: World): void {
  const others = BOSS_KINDS.filter((k) => k !== w.run.finalBoss);
  w.run.finalBoss = w.rng.pick(others);
  w.director.herald = w.rng.pick(BOSS_KINDS.filter((k) => k !== w.run.finalBoss));
  w.director.biomes = ['crypt', ...(w.rng.chance(0.5) ? ['flooded', 'forge'] as const : ['forge', 'flooded'] as const)];
}

/** Biome of a chamber: act 1 (crypt), act 2 or act 3 of this run's plan. */
export function biomeOfChamber(biomes: readonly BiomeId[], chamber: number): BiomeId {
  let act = 0;
  for (let i = 0; i < BIOME.ACT_STARTS.length; i++) if (chamber >= (BIOME.ACT_STARTS[i] as number)) act = i;
  return biomes[act] ?? 'crypt';
}

/** Boss / champion of a chamber, or null in ordinary chambers. The first elite is the champion, later ones the herald. */
export function bossOfChamber(chamber: number, finalBoss: BossKind, herald: BossKind): EnemyKind | null {
  const kind = RUN.CHAMBERS[chamber] ?? 'boss';
  if (kind === 'boss') return finalBoss;
  if (kind !== 'elite') return null;
  for (let i = 0; i < chamber; i++) if (RUN.CHAMBERS[i] === 'elite') return herald;
  return 'champion';
}

type ObstacleType = { kind: Obstacle['kind']; r: number };
const OBSTACLE_KINDS: Record<BiomeId, ObstacleType[]> = {
  crypt: [
    { kind: 'pillar', r: 0.9 }, { kind: 'column', r: 0.65 }, { kind: 'barrels', r: 0.8 },
    { kind: 'crates', r: 0.9 }, { kind: 'rubble', r: 1.1 }, { kind: 'brazier', r: 0.5 },
  ],
  flooded: [{ kind: 'sarcophagus', r: 1.5 }, { kind: 'crystal', r: 1.25 }, { kind: 'rubble', r: 1.2 }],
  forge: [{ kind: 'anvil', r: 0.8 }, { kind: 'stalagmite', r: 0.9 }, { kind: 'brazier', r: 0.55 }],
};
const BOSS_PILLAR: Record<BiomeId, Obstacle['kind']> = { crypt: 'pillar', flooded: 'crystal', forge: 'stalagmite' };
const HAZARD_KIND: Record<BiomeId, Hazard['kind']> = { crypt: 'spikes', flooded: 'frost', forge: 'vent' };

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

const snap = (v: number): number => Math.round(v / DIRECTOR.OBSTACLE_GRID) * DIRECTOR.OBSTACLE_GRID;
/** Hazard numbers are kept short so the JSON-rounded copy on the client is bit-identical (see hazardState). */
const round1 = (v: number): number => Math.round(v * 10) / 10;
const round2 = (v: number): number => Math.round(v * 100) / 100;

/**
 * Can a hero walk from every spawn point to every door position without touching an obstacle or stepping on a
 * hazard? (Flood fill on a coarse grid; used to guarantee clear lanes whatever the hazards do.)
 */
export function hasHazardFreeRoutes(room: RoomLayout): boolean {
  const step = BIOME.PATH_GRID;
  const cols = Math.floor(room.w / step) - 1;
  const rows = Math.floor(room.d / step) - 1;
  if (cols < 1 || rows < 1) return false;
  const x0 = -((cols - 1) * step) / 2;
  const z0 = -((rows - 1) * step) / 2;
  const blocked = new Uint8Array(cols * rows);
  const pad = WORLD.PLAYER_RADIUS;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = x0 + c * step;
      const z = z0 + r * step;
      let hit = Math.abs(x) > room.w / 2 - pad || Math.abs(z) > room.d / 2 - pad;
      for (let i = 0; !hit && i < room.obstacles.length; i++) {
        const o = room.obstacles[i] as Obstacle;
        hit = Math.hypot(o.x - x, o.z - z) < o.r + pad;
      }
      for (let i = 0; !hit && i < room.hazards.length; i++) {
        const h = room.hazards[i] as Hazard;
        hit = Math.hypot(h.x - x, h.z - z) < h.r;
      }
      if (hit) blocked[r * cols + c] = 1;
    }
  }
  const cell = (x: number, z: number): number => {
    const c = Math.max(0, Math.min(cols - 1, Math.round((x - x0) / step)));
    const r = Math.max(0, Math.min(rows - 1, Math.round((z - z0) / step)));
    return r * cols + c;
  };
  const seen = new Uint8Array(cols * rows);
  const stack: number[] = [];
  const first = room.spawns[0];
  if (!first) return false;
  const start = cell(first.x, first.z);
  if (blocked[start]) return false;
  seen[start] = 1;
  stack.push(start);
  while (stack.length > 0) {
    const at = stack.pop() as number;
    const c = at % cols;
    const r = (at - c) / cols;
    if (c > 0 && !blocked[at - 1] && !seen[at - 1]) { seen[at - 1] = 1; stack.push(at - 1); }
    if (c < cols - 1 && !blocked[at + 1] && !seen[at + 1]) { seen[at + 1] = 1; stack.push(at + 1); }
    if (r > 0 && !blocked[at - cols] && !seen[at - cols]) { seen[at - cols] = 1; stack.push(at - cols); }
    if (r < rows - 1 && !blocked[at + cols] && !seen[at + cols]) { seen[at + cols] = 1; stack.push(at + cols); }
  }
  for (const s of room.spawns) if (!seen[cell(s.x, s.z)]) return false;
  for (const d of [...doorPositions(room, 1), ...doorPositions(room, 2)]) if (!seen[cell(d.x, d.z)]) return false;
  return true;
}

/**
 * Rectangular arena whose size, obstacles and hazards follow the biome's profile (BIOME in tuning.ts). Every
 * obstacle keeps OBSTACLE_GAP to its neighbours and WALL_CLEARANCE to the walls, so there are always lanes wide
 * enough for the largest enemy; hazards keep clear of spawns, doors and obstacles and never cut off a door.
 */
export function generateRoom(rng: Rng, kind: 'combat' | 'elite' | 'boss', biome: BiomeId = 'crypt', chamber = 0): RoomLayout {
  const boss = kind === 'boss';
  const profile = BIOME[biome];
  const w = boss ? DIRECTOR.BOSS_ROOM_W : rng.int(profile.W_MIN / 2, profile.W_MAX / 2) * 2;
  const d = boss ? DIRECTOR.BOSS_ROOM_D : rng.int(profile.D_MIN / 2, profile.D_MAX / 2) * 2;
  const seed = rng.u32();
  const spawns = roomSpawns(d);
  const room: RoomLayout = { seed, biome, w, d, obstacles: [], hazards: [], spawns };
  const doors = [...doorPositions(room, 1), ...doorPositions(room, 2)];
  const kinds = OBSTACLE_KINDS[biome];

  const fits = (o: Obstacle): boolean => {
    if (Math.abs(o.x) + o.r > w / 2 - DIRECTOR.WALL_CLEARANCE || Math.abs(o.z) + o.r > d / 2 - DIRECTOR.WALL_CLEARANCE) return false;
    for (const s of spawns) if (Math.hypot(s.x - o.x, s.z - o.z) < o.r + DIRECTOR.SPAWN_CLEARANCE) return false;
    for (const p of doors) if (Math.hypot(p.x - o.x, p.z - o.z) < o.r + DIRECTOR.DOOR_CLEARANCE) return false;
    for (const other of room.obstacles) {
      if (Math.hypot(other.x - o.x, other.z - o.z) < o.r + other.r + DIRECTOR.OBSTACLE_GAP) return false;
    }
    return true;
  };

  /** Adds a hazard if it keeps every clearance. Hazards of the same `group` (a frost cluster) may overlap. */
  const groups: number[] = [];
  const addHazard = (h: Hazard, group: number): boolean => {
    if (room.hazards.length >= BIOME.MAX_HAZARDS) return false;
    if (Math.abs(h.x) + h.r > w / 2 - BIOME.HAZARD_WALL_GAP || Math.abs(h.z) + h.r > d / 2 - BIOME.HAZARD_WALL_GAP) return false;
    for (const s of spawns) if (Math.hypot(s.x - h.x, s.z - h.z) < h.r + BIOME.HAZARD_SPAWN_CLEARANCE) return false;
    for (const p of doors) if (Math.hypot(p.x - h.x, p.z - h.z) < h.r + WORLD.DOOR_RADIUS + BIOME.HAZARD_DOOR_CLEARANCE) return false;
    for (const o of room.obstacles) if (Math.hypot(o.x - h.x, o.z - h.z) < h.r + o.r + BIOME.HAZARD_OBSTACLE_GAP) return false;
    for (let i = 0; i < room.hazards.length; i++) {
      const other = room.hazards[i] as Hazard;
      if (groups[i] === group) continue;
      if (Math.hypot(other.x - h.x, other.z - h.z) - other.r - h.r < BIOME.HAZARD_GAP) return false;
    }
    room.hazards.push(h);
    groups.push(group);
    if (hasHazardFreeRoutes(room)) return true;
    room.hazards.pop();
    groups.pop();
    return false;
  };
  const hazardKind = HAZARD_KIND[biome];
  const scatterHazards = (wanted: number, rMin: number, rMax: number, pMin: number, pMax: number, xOf: () => number, zOf: () => number): void => {
    for (let attempt = 0, group = 0; attempt < BIOME.HAZARD_ATTEMPTS && room.hazards.length < wanted; attempt++) {
      const h: Hazard = { x: snap(xOf()), z: snap(zOf()), r: round1(rng.range(rMin, rMax)), kind: hazardKind, period: round1(rng.range(pMin, pMax)), phase: round2(rng.next()) };
      if (addHazard(h, group)) group++;
    }
  };
  const anyZ = (): number => rng.range(-d / 2, d / 2);

  if (boss) {
    // Mostly open arena: four pillars far out towards the corners, a few hazards of the biome along the walls.
    const px = w / 2 - DIRECTOR.WALL_CLEARANCE - DIRECTOR.BOSS_PILLAR_INSET;
    const pz = d / 2 - DIRECTOR.WALL_CLEARANCE - DIRECTOR.BOSS_PILLAR_INSET;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const o: Obstacle = { x: sx * px, z: sz * pz, r: DIRECTOR.BOSS_PILLAR_RADIUS, kind: BOSS_PILLAR[biome] };
      if (fits(o)) room.obstacles.push(o);
    }
    const B = BIOME.BOSS;
    const edgeX = (): number => (rng.chance(0.5) ? 1 : -1) * (w / 2 - BIOME.HAZARD_WALL_GAP - B.HAZARD_R - rng.range(0, B.EDGE_BAND - 2 * B.HAZARD_R + 1));
    scatterHazards(rng.int(B.HAZARDS_MIN, B.HAZARDS_MAX), B.HAZARD_R, B.HAZARD_R, B.PERIOD_MIN, B.PERIOD_MAX, edgeX, anyZ);
    return room;
  }

  if (biome === 'forge') {
    // Rows of obstacles along Z split the room into lanes; gaps in the rows let everything cross between lanes.
    const F = BIOME.forge;
    const rows = rng.int(F.ROWS_MIN, F.ROWS_MAX);
    const rowX = rows === 1 ? [0] : [snap(w / 6)];
    const step = snap(rng.range(F.ROW_STEP_MIN, F.ROW_STEP_MAX));
    const first = snap(-d / 2 + DIRECTOR.WALL_CLEARANCE + 1 + rng.range(0, step / 2));
    for (const x of rowX) {
      const skipped: Obstacle[] = [];
      let placed = 0;
      const put = (a: Obstacle): void => {
        if (!fits(a)) return;
        if (x === 0) { room.obstacles.push(a); placed++; return; }
        const b: Obstacle = { ...a, x: -x };
        if (fits(b)) { room.obstacles.push(a, b); placed++; }
      };
      for (let z = first; z < d / 2; z += step) {
        const type = rng.pick(kinds);
        const a: Obstacle = { x, z, r: type.r, kind: type.kind };
        if (rng.chance(F.ROW_SKIP_CHANCE)) skipped.push(a);
        else put(a);
      }
      // A row that came out too thin gets its skipped slots back.
      for (const a of skipped) if (placed < F.ROW_MIN) put(a);
    }
    // Vents sit in the middle of the lanes.
    const lanes = rows === 1 ? [-w / 4, w / 4] : [0, -w / 3, w / 3];
    scatterHazards(rng.int(F.HAZARDS_MIN, F.HAZARDS_MAX), F.HAZARD_R_MIN, F.HAZARD_R_MAX, F.PERIOD_MIN, F.PERIOD_MAX,
      () => rng.pick(lanes) + rng.range(-0.75, 0.75), anyZ);
    return room;
  }

  const obstaclesMin = biome === 'flooded' ? BIOME.flooded.OBSTACLES_MIN : BIOME.crypt.OBSTACLES_MIN;
  const obstaclesMax = biome === 'flooded' ? BIOME.flooded.OBSTACLES_MAX : BIOME.crypt.OBSTACLES_MAX;
  const wanted = rng.int(obstaclesMin, obstaclesMax);
  for (let attempt = 0; attempt < DIRECTOR.OBSTACLE_ATTEMPTS && room.obstacles.length < wanted; attempt++) {
    const type = rng.pick(kinds);
    const left = wanted - room.obstacles.length;
    // A lone leftover slot may still be filled by a mirrored pair as long as the maximum allows it.
    const centred = (left === 1 && room.obstacles.length + 2 > obstaclesMax) || rng.chance(DIRECTOR.CENTRED_OBSTACLE_CHANCE);
    const x = centred ? 0 : rng.range(DIRECTOR.OBSTACLE_GAP / 2 + type.r, w / 2 - DIRECTOR.WALL_CLEARANCE - type.r);
    const z = rng.range(-d / 2 + DIRECTOR.WALL_CLEARANCE + type.r, d / 2 - DIRECTOR.WALL_CLEARANCE - type.r);
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

  if (biome === 'flooded') {
    // Patches of freezing mist: overlapping circles that share one rhythm.
    const F = BIOME.flooded;
    const clusters = rng.int(F.CLUSTERS_MIN, F.CLUSTERS_MAX);
    for (let c = 0, attempt = 0; c < clusters && attempt < BIOME.HAZARD_ATTEMPTS && room.hazards.length < BIOME.MAX_HAZARDS; attempt++) {
      const period = round1(rng.range(F.PERIOD_MIN, F.PERIOD_MAX));
      const phase = round2(rng.next());
      const cx = rng.range(-w / 2, w / 2);
      const cz = anyZ();
      const size = rng.int(F.CLUSTER_SIZE_MIN, F.CLUSTER_SIZE_MAX);
      const before = room.hazards.length;
      for (let i = 0, tries = 0; i < size && tries < size * 6; tries++) {
        const first = room.hazards.length === before;
        const a = rng.range(0, Math.PI * 2);
        const h: Hazard = {
          x: snap(first ? cx : cx + Math.sin(a) * F.CLUSTER_SPREAD), z: snap(first ? cz : cz + Math.cos(a) * F.CLUSTER_SPREAD),
          r: round1(rng.range(F.HAZARD_R_MIN, F.HAZARD_R_MAX)), kind: hazardKind, period, phase,
        };
        if (addHazard(h, c)) i++;
        else if (first) break;
      }
      if (room.hazards.length > before) c++;
    }
  } else if (chamber >= BIOME.crypt.HAZARDS_FROM_CHAMBER) {
    const C = BIOME.crypt;
    scatterHazards(rng.int(C.HAZARDS_MIN, C.HAZARDS_MAX), C.HAZARD_R_MIN, C.HAZARD_R_MAX, C.PERIOD_MIN, C.PERIOD_MAX, () => rng.range(-w / 2, w / 2), anyZ);
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

/**
 * Enemies per kind that already stand (or wait in the spawn queue) when a group is composed. Aegis, necromancers
 * and shamans are always counted; the timed groups of survive / ritual chambers count every capped kind, so the
 * ranged enemies of many small groups cannot pile up.
 */
export type Standing = Partial<Record<EnemyKind, number>>;
const NO_SUPPORT: Standing = {};

/**
 * Picks enemy kinds until the budget is spent, honouring minChamber and the caps: ranged kinds, bombers and
 * reavers per wave; at most one aegis, one necromancer and one shaman ALIVE per two heroes (`standing` counts
 * those already in the room). Support kinds (shaman, aegis, necromancer) take at most SUPPORT_BUDGET_SHARE of the
 * budget and a wave never consists of them alone.
 */
export function composeWave(rng: Rng, chamber: number, budget: number, partySize: number, room: number, biome: BiomeId = 'crypt', standing: Standing = NO_SUPPORT): EnemyKind[] {
  const bias: Partial<Record<EnemyKind, number>> = BIOME.KIND_BIAS[biome];
  const weight: Partial<Record<EnemyKind, number>> = DIRECTOR.KIND_WEIGHT;
  const kinds: EnemyKind[] = [];
  const counts: Partial<Record<EnemyKind, number>> = {
    archer: standing.archer ?? 0, mage: standing.mage ?? 0, bomber: standing.bomber ?? 0, reaver: standing.reaver ?? 0,
    aegis: standing.aegis ?? 0, necromancer: standing.necromancer ?? 0, shaman: standing.shaman ?? 0,
  };
  const caps: Partial<Record<EnemyKind, number>> = {
    archer: Math.floor(DIRECTOR.ARCHER_CAP_BASE + DIRECTOR.ARCHER_CAP_PER_HERO * partySize),
    mage: Math.floor(DIRECTOR.MAGE_CAP_BASE + DIRECTOR.MAGE_CAP_PER_HERO * partySize),
    bomber: Math.floor(DIRECTOR.BOMBER_CAP_BASE + DIRECTOR.BOMBER_CAP_PER_HERO * partySize),
    reaver: Math.floor(DIRECTOR.REAVER_CAP_BASE + DIRECTOR.REAVER_CAP_PER_HERO * partySize),
    aegis: Math.ceil(partySize / DIRECTOR.HEROES_PER_AEGIS),
    necromancer: Math.ceil(partySize / DIRECTOR.HEROES_PER_NECROMANCER),
    shaman: Math.ceil(partySize / DIRECTOR.HEROES_PER_SHAMAN),
  };
  let left = budget;
  let supportLeft = budget * DIRECTOR.SUPPORT_BUDGET_SHARE;
  const options: EnemyDef[] = [];
  const weights: number[] = [];
  while (kinds.length < room) {
    options.length = 0;
    weights.length = 0;
    for (const def of Object.values(ENEMIES)) {
      if (def.cost <= 0 || def.cost > left + SIM.EPS || def.minChamber > chamber) continue;
      const cap = caps[def.kind];
      if (cap !== undefined && (counts[def.kind] ?? 0) >= cap) continue;
      if (SUPPORT_KINDS.has(def.kind) && def.cost > supportLeft + SIM.EPS) continue;
      options.push(def);
      weights.push((weight[def.kind] ?? 1) * (bias[def.kind] ?? 1));
    }
    if (options.length === 0) break;
    const pick = options[rng.weighted(weights)] as EnemyDef;
    kinds.push(pick.kind);
    left -= pick.cost;
    if (SUPPORT_KINDS.has(pick.kind)) supportLeft -= pick.cost;
    if (counts[pick.kind] !== undefined) counts[pick.kind] = (counts[pick.kind] ?? 0) + 1;
  }
  // A group cut short by the enemy cap must still contain somebody who fights.
  if (kinds.length > 0 && kinds.every((k) => SUPPORT_KINDS.has(k))) kinds[kinds.length - 1] = 'minion';
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
  const oath = oathScale(w.run.oath);
  const depth = depthScale(w.run.depth);
  const chamber = w.run.chamber;
  w.hpMul = (1 + RUN.HP_GROWTH_PER_CHAMBER * chamber) * (1 + RUN.HP_PER_EXTRA_PLAYER * (w.partySize - 1)) * oath.hp * depth.hp;
  w.damageMul = (1 + RUN.DAMAGE_GROWTH_PER_CHAMBER * chamber) * (1 + DIRECTOR.DAMAGE_PER_EXTRA_PLAYER * (w.partySize - 1)) * oath.damage * depth.damage;
  w.speedMul = oath.speed * depth.speed;
  w.affixed = w.run.depth >= RUN.DEPTH.AFFIX_FROM_DEPTH || w.run.oath >= RUN.DEPTH.AFFIX_FROM_OATH;
}

/**
 * Enters chamber `index`. `objective` is what the door promised; only combat chambers of a normal run can have a
 * special one (elite and boss chambers are always `slay`).
 */
export function enterChamber(w: World, index: number, entered: DoorType, objective: ObjectiveKind = 'slay'): void {
  const kind = RUN.CHAMBERS[index] ?? 'boss';
  const run = w.run;
  run.chamber = index;
  run.chamberKind = kind;
  run.entered = entered;
  run.phase = 'combat';
  run.wave = 0;
  run.bossKind = bossOfChamber(index, run.finalBoss, w.director.herald);
  const goal: ObjectiveKind = kind === 'combat' ? objective : 'slay';
  // Survive, ritual and vault have no waves (waveCount 0; `wave` counts the groups sent); a hunt is one wave.
  run.waveCount = kind === 'boss' ? 1 : kind === 'elite' ? (run.bossKind === 'champion' ? DIRECTOR.ELITE_WAVES : DIRECTOR.HERALD_WAVES)
    : isEndless(goal) ? 0 : goal === 'hunt' ? 1
    : index >= DIRECTOR.WAVES_LATE_FROM_CHAMBER ? DIRECTOR.WAVES_LATE : DIRECTOR.WAVES_EARLY;
  run.doors = [];
  run.doorProgress = [];
  run.bossId = -1;
  run.draftPending = [];
  run.draftTime = 0;
  w.cursed = entered === 'cursed';
  w.room = generateRoom(w.rng, kind, biomeOfChamber(w.director.biomes, index), index);
  w.enemies.length = 0;
  w.projectiles.length = 0;
  clearZones(w);
  w.affixes = 0;
  w.partySize = Math.max(1, w.heroes.filter((h) => h.connected).length);
  setScaling(w);
  for (const h of w.heroes) {
    const spawn = w.room.spawns[h.slot % w.room.spawns.length] as { x: number; z: number };
    placeHero(h, spawn.x, spawn.z);
    h.lastStandUsed = false;
    h.draft = [];
    h.draftOpts = null;
    h.burnTime = 0;
    h.chillTime = 0;
    // Every chamber begins with the hero's start shield and at least the opening_act charge.
    if (h.mods.startShield > 0) grantShield(h, h.mods.startShield, SIM.START_SHIELD_SECONDS);
    const opening = ULTIMATE.MAX * h.stats.openingAct;
    if (h.ult < opening) h.ult = opening;
  }
  const dir = w.director;
  dir.preDraft = false;
  dir.queue.length = 0;
  dir.spawnTimer = 0;
  dir.waveTimer = 0;
  dir.waveDelay = DIRECTOR.FIRST_WAVE_DELAY;
  dir.clearTimer = 0;
  if (goal === 'vault') dir.vaults++;
  dir.obj = beginObjective(w, goal);
  w.runVersion++;
}

const ALWAYS_COUNTED: ReadonlySet<EnemyKind> = new Set<EnemyKind>(['aegis', 'necromancer', 'shaman']);

/** Capped kinds alive or about to rise: the three support kinds, or every kind when `all` (timed groups). */
function standingKinds(w: World, all: boolean): Standing {
  const standing: Standing = {};
  for (const e of w.enemies) {
    if (!e.dead && !e.summoned && (all || ALWAYS_COUNTED.has(e.kind))) standing[e.kind] = (standing[e.kind] ?? 0) + 1;
  }
  for (const q of w.director.queue) if (all || ALWAYS_COUNTED.has(q.kind)) standing[q.kind] = (standing[q.kind] ?? 0) + 1;
  return standing;
}

/** Share of the rank and file that is warded in the current chamber (0 before WARD.FROM_CHAMBER). */
export function wardShare(chamber: number, depth: number): number {
  const W = ENEMY_TUNING.WARD;
  return chamber < W.FROM_CHAMBER ? 0 : Math.min(W.MAX_SHARE, W.SHARE + W.SHARE_PER_DEPTH * depth);
}

/** Moves `count` random entries of `pool` to its front (partial shuffle with the run's generator). */
function drawToFront<T>(rng: Rng, pool: T[], count: number): void {
  for (let i = 0; i < count; i++) {
    const j = rng.int(i, pool.length - 1);
    const t = pool[i] as T;
    pool[i] = pool[j] as T;
    pool[j] = t;
  }
}

/**
 * Queues a group of rank-and-file enemies. From WARD.FROM_CHAMBER on a share of it is warded against a random
 * element each — never the whole group. In a `defend` chamber ATTACKER_SHARE of it is sent against the shard.
 */
function queueGroup(w: World, kinds: readonly EnemyKind[], elite: boolean): void {
  const group: QueuedSpawn[] = kinds.map((kind) => ({ kind, elite }));
  const share = wardShare(w.run.chamber, w.run.depth);
  if (share > 0 && group.length > 1) {
    const warded = Math.min(group.length - 1, Math.round(group.length * share));
    const pool = [...group];
    drawToFront(w.rng, pool, warded);
    for (let i = 0; i < warded; i++) (pool[i] as QueuedSpawn).ward = w.rng.pick(ELEMENT_IDS);
  }
  const obj = w.director.obj;
  if (obj && obj.kind === 'defend' && obj.anchorHp > 0) {
    const able = group.filter((q) => (OBJECTIVE.SIEGE_KINDS as readonly EnemyKind[]).includes(q.kind));
    const siege = Math.min(able.length, Math.round(group.length * OBJECTIVE_TUNING.DEFEND.ATTACKER_SHARE));
    drawToFront(w.rng, able, siege);
    for (let i = 0; i < siege; i++) (able[i] as QueuedSpawn).siege = true;
  }
  for (const q of group) w.director.queue.push(q);
}

function startWave(w: World): void {
  const run = w.run;
  const dir = w.director;
  setWaveProgress(w, run.wave);
  run.wave++;
  dir.waveTimer = 0;
  dir.waveDelay = DIRECTOR.WAVE_DELAY;
  const room = Math.max(0, WORLD.MAX_ENEMIES - livingEnemies(w));
  const budget = waveBudget(run.chamber, w.partySize) * depthScale(run.depth).count;
  const biome = w.room.biome;
  const standing = standingKinds(w, false);
  if (run.chamberKind === 'boss') {
    dir.queue.push({ kind: run.finalBoss, elite: false });
  } else if (run.chamberKind === 'elite') {
    const champion = run.bossKind === 'champion' || run.bossKind === null;
    if (run.wave === 1) {
      dir.queue.push(champion ? { kind: 'champion', elite: false } : { kind: run.bossKind as EnemyKind, elite: false, herald: true });
      const escort = budget * (champion ? DIRECTOR.ELITE_ESCORT_BUDGET : DIRECTOR.HERALD_ESCORT_BUDGET);
      queueGroup(w, composeWave(w.rng, run.chamber, escort, w.partySize, room - 1, biome, standing), true);
    } else {
      queueGroup(w, composeWave(w.rng, run.chamber, budget * DIRECTOR.ELITE_REINFORCE_BUDGET, w.partySize, room, biome, standing), w.cursed);
    }
  } else if (dir.obj && dir.obj.kind === 'hunt') {
    // The marked elites rise first, their escort after them.
    const kinds = (OBJECTIVE.HUNT_KINDS as readonly EnemyKind[]).filter((k) => ENEMIES[k].minChamber <= run.chamber);
    const marks = Math.min(dir.obj.targetsTotal, room);
    for (let i = 0; i < marks; i++) dir.queue.push({ kind: w.rng.pick(kinds), elite: true, marked: true });
    queueGroup(w, composeWave(w.rng, run.chamber, budget * OBJECTIVE_TUNING.HUNT.ESCORT_BUDGET_FRACTION, w.partySize, room - marks, biome, standing), w.cursed);
  } else {
    queueGroup(w, composeWave(w.rng, run.chamber, budget, w.partySize, room, biome, standing), w.cursed);
  }
  w.emit({ e: 'wave', wave: run.wave, waveCount: run.waveCount });
  w.runVersion++;
}

/** Survive / ritual: the next timed group, unless the room is already full enough. */
function sendGroup(w: World, fraction: number): void {
  const run = w.run;
  const budget = waveBudget(run.chamber, w.partySize) * depthScale(run.depth).count;
  let standingCost = 0;
  for (const e of w.enemies) if (!e.dead) standingCost += Math.max(1, e.def.cost);
  if (standingCost >= budget * OBJECTIVE.MAX_ALIVE_BUDGET) return;
  const room = Math.max(0, WORLD.MAX_ENEMIES - livingEnemies(w));
  const kinds = composeWave(w.rng, run.chamber, budget * fraction, w.partySize, room, w.room.biome, standingKinds(w, true));
  if (kinds.length === 0) return;
  queueGroup(w, kinds, w.cursed);
  run.wave++;
  w.emit({ e: 'wave', wave: run.wave, waveCount: run.waveCount });
  w.runVersion++;
}

function spawnQueued(w: World, q: QueuedSpawn): void {
  const def = ENEMIES[q.kind];
  let point: { x: number; z: number };
  if (def.cost === 0) {
    point = { x: 0, z: -w.room.d / 6 };
    let nearest = Infinity;
    for (const h of w.heroes) nearest = Math.min(nearest, Math.hypot(h.body.x - point.x, h.body.z - point.z));
    if (nearest < DIRECTOR.ENEMY_SPAWN_MIN_DISTANCE || !freeSpot(w, point.x, point.z, def.radius)) point = findSpawnPoint(w, def.radius);
  } else {
    point = findSpawnPoint(w, def.radius);
  }
  const e = spawnEnemy(w, q.kind, point.x, point.z, {
    elite: q.elite, herald: q.herald === true, ward: q.ward, siege: q.siege === true, marked: q.marked === true,
    hpMul: q.marked === true ? OBJECTIVE.HUNT_HP_MUL : 1,
  });
  if (e && e.boss) {
    w.run.bossId = e.id;
    w.runVersion++;
  }
}

function offer(w: World, h: Hero, opts: DraftOptions): void {
  h.draftOpts = opts;
  h.draft = generateDraft(w.rng, h, opts);
  if (h.draft.length > 0) w.run.draftPending.push(h.slot);
}

/** Draft timer: the hourglass relic of any hero in the party makes every draft longer. */
function draftSeconds(w: World): number {
  let best = 0;
  for (const h of w.heroes) if (h.relic.hourglass > best) best = h.relic.hourglass;
  return RUN.DRAFT_TIMEOUT_SECONDS + RELIC_TUNING.HOURGLASS_SECONDS * best;
}

function openDraft(w: World): void {
  const run = w.run;
  const cursed = run.entered === 'cursed';
  run.draftPending = [];
  // A met bonus (or a vault) makes the draft richer: more choices and a rare or better among them.
  const bonus = draftBonus(w.director.obj);
  for (const h of w.heroes) {
    offer(w, h, {
      choices: (cursed ? BOON_TUNING.CURSED_DRAFT_CHOICES : RUN.DRAFT_CHOICES) + h.meta.foresight + bonus.choices,
      guaranteeRare: cursed || bonus.rare,
      guaranteeInfusion: run.chamber === 0 && run.depth === 0,
    });
  }
  run.draftTime = draftSeconds(w);
  run.phase = 'draft';
  w.runVersion++;
}

/**
 * Attunement (permanent upgrade): right after a run starts, before anything spawns, every hero who owns it picks
 * one of ATTUNEMENT_CHOICES infusions. The first wave waits in the `draft` phase until all of them have picked or
 * the draft timed out; then the chamber begins (no doors). Returns false when nobody owns the upgrade.
 */
export function openAttunementDraft(w: World): boolean {
  const run = w.run;
  run.draftPending = [];
  for (const h of w.heroes) {
    if (h.meta.attunement) offer(w, h, { choices: META.ATTUNEMENT_CHOICES + h.meta.foresight, guaranteeRare: false, guaranteeInfusion: false, infusionsOnly: true });
  }
  if (run.draftPending.length === 0) return false;
  run.draftTime = draftSeconds(w);
  run.phase = 'draft';
  w.director.preDraft = true;
  w.runVersion++;
  return true;
}

/**
 * Spends one of the hero's rerolls (insight upgrade): the current offers are replaced by a fresh draft under the
 * same rules that never repeats what was just shown unless there are not enough other boons left.
 */
export function rerollDraft(w: World, h: Hero): boolean {
  if (w.run.phase !== 'draft' || h.draft.length === 0 || h.rerolls <= 0 || !h.draftOpts) return false;
  const shown = new Set(h.draft.map((o) => o.id));
  const next = generateDraft(w.rng, h, h.draftOpts, shown);
  if (next.length === 0) return false;
  h.rerolls--;
  h.draft = next;
  w.draftVersion++;
  return true;
}

/**
 * Ends the run and pays every hero still on the roster: Glimmer (REWARDS), mastery experience (XP_REWARDS) and the
 * relic shards found on the way. A defeat pays everything earned so far, however deep the party fell.
 */
export function finishRun(w: World, phase: 'victory' | 'defeat'): void {
  const run = w.run;
  const e = w.director.earnings;
  run.phase = phase;
  run.rewards = w.heroes.map((h) => {
    const compass = RELIC_TUNING.COMPASS_BONUS * h.relic.compass;
    return {
      slot: h.slot,
      glimmer: glimmerReward(e, run.oath, compass, h.mods.glimmer),
      xp: xpReward(e, run.oath, compass, h.mods.xp),
      relics: [...h.shards],
    };
  });
  run.draftPending = [];
  run.doors = [];
  run.doorProgress = [];
  run.objective = null;
  w.director.obj = null;
  w.projectiles.length = 0;
  clearZones(w);
  w.runVersion++;
}

function chamberCleared(w: World): void {
  const run = w.run;
  const dir = w.director;
  if (dir.obj) finishObjective(w, dir.obj);
  dir.chambersCleared++;
  run.chambersCleared = dir.chambersCleared;
  earn(dir.earnings, 'chamber', run.depth, w.cursed);
  w.projectiles.length = 0;
  clearZones(w);
  w.emit({ e: 'chamberClear' });
  for (const h of w.heroes) {
    if (h.state === 'downed') reviveHero(w, h, -1, WORLD.REVIVE_HP_FRACTION, SIM.REVIVE_IFRAMES);
    if (run.entered === 'blessing') healHero(w, h, h.maxHp * BOON_TUNING.BLESSING_HEAL_FRACTION);
    if (h.stats.mending > 0) healHero(w, h, h.maxHp * h.stats.mending);
  }
  openDraft(w);
}

/** Applies a draft choice. Returns false if the hero has nothing to pick or the index is out of range. */
export function pickBoon(w: World, h: Hero, index: number): boolean {
  if (w.run.phase !== 'draft') return false;
  const offer = h.draft[index];
  if (!offer) return false;
  const level = applyBoon(h, offer.id, (id, tier) => w.emit({ e: 'set', slot: h.slot, id, tier }));
  h.draft = [];
  h.draftOpts = null;
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
  if (run.chamberKind === 'boss') {
    // A final boss is dead: go deeper or bank the run.
    types = ['descend', 'ascend'];
  } else if (next === 'boss') {
    types = ['boss'];
  } else {
    const pool: DoorType[] = ['boon', 'blessing', 'cursed'];
    pool.splice(w.rng.int(0, pool.length - 1), 1);
    if (w.rng.chance(0.5)) pool.reverse();
    types = pool;
  }
  const spots = doorPositions(w.room, types.length);
  // What waits behind each door: a descend door leads to the first chamber of the next depth.
  const objectives = rollDoorObjectives(w, types, run.chamberKind === 'boss' ? 0 : run.chamber + 1, w.director.pin ?? undefined);
  run.doors = types.map((type, i): Door => ({
    x: (spots[i] as { x: number }).x, z: (spots[i] as { z: number }).z, type, objective: objectives[i] ?? 'slay',
  }));
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
  if (w.director.preDraft) {
    // The attunement draft is done: the chamber the run started in begins now.
    w.director.preDraft = false;
    run.phase = 'combat';
    w.runVersion++;
    return;
  }
  openDoors(w);
}

/** Advances the door hold timers. Returns the door the party has committed to this tick, if any. */
export function stepDoorZones(w: World): Door | null {
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
    if ((run.doorProgress[i] as number) >= 1 - SIM.EPS) return door;
  }
  return null;
}

function stepDoors(w: World): void {
  const door = stepDoorZones(w);
  if (!door) return;
  w.emit({ e: 'doorChosen', type: door.type });
  if (door.type === 'ascend') finishRun(w, 'victory');
  else if (door.type === 'descend') descend(w);
  else enterChamber(w, w.run.chamber + 1, door.type, door.objective);
}

/** One depth deeper: everyone stands up and is healed, the chamber sequence starts over with a new plan. */
function descend(w: World): void {
  const run = w.run;
  run.depth++;
  planDescent(w);
  for (const h of w.heroes) {
    if (h.state === 'downed') reviveHero(w, h, -1, RUN.DEPTH.HEAL_FRACTION, SIM.REVIVE_IFRAMES);
    healHero(w, h, h.maxHp * RUN.DEPTH.HEAL_FRACTION);
  }
  w.emit({ e: 'descend', depth: run.depth });
  w.director.vaults = 0;
  enterChamber(w, 0, 'descend');
}

function stepCombat(w: World): void {
  const run = w.run;
  const dir = w.director;
  const dt = TICK_DT;
  if (dir.manual) return;

  if (run.bossId >= 0 && run.chamberKind === 'boss') {
    const boss = w.enemies.find((e) => e.id === run.bossId);
    if (!boss || boss.dead) {
      // The final boss is dead: its host crumbles with it.
      for (const e of w.enemies) if (!e.dead) killEnemy(w, e, -1, true);
      // The run goes on: a draft, then the doors to go deeper or to ascend.
      dir.bossSlain = true;
      run.cleared++;
      earn(dir.earnings, 'boss', run.depth, w.cursed);
      rollShards(w, 'boss');
      chamberCleared(w);
      return;
    }
  }

  const obj = dir.obj;
  if (obj && !obj.complete) {
    stepObjective(w, obj);
    if (obj.spawnTimer > 0) obj.spawnTimer -= dt;
  }
  if (obj && obj.complete) {
    // Survive, ritual, vault: the objective ended the fight. Whatever still stands crumbles, then the chamber is cleared.
    if (w.run.objective && w.run.objective.status !== 'done') {
      dir.queue.length = 0;
      for (const e of w.enemies) if (!e.dead) killEnemy(w, e, -1, true);
      w.blasts.length = 0;
      finishObjective(w, obj);
      dir.clearTimer = 0;
    }
    dir.clearTimer += dt;
    if (dir.clearTimer >= DIRECTOR.CLEAR_DELAY) chamberCleared(w);
    return;
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
  if (obj && isEndless(obj.kind)) {
    if (obj.kind === 'vault' || obj.spawnTimer > 0) return;
    const T = obj.kind === 'survive' ? OBJECTIVE_TUNING.SURVIVE : OBJECTIVE_TUNING.RITUAL;
    obj.spawnTimer = T.SPAWN_INTERVAL;
    sendGroup(w, T.BUDGET_FRACTION);
    return;
  }
  if (obj && obj.kind === 'hunt' && run.wave >= 1) obj.targetsSpawned = true;
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
  if (w.tutorial) {
    if (run.phase !== 'victory') run.elapsed += TICK_DT;
    stepTutorial(w);
    return;
  }
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
