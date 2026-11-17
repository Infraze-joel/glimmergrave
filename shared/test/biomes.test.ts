import { describe, expect, it } from 'vitest';
import { RUN, TICK_DT, WORLD } from '@shared/constants.ts';
import { CLASSES, DASH } from '@shared/data/classes.ts';
import { ENEMIES, HAZARD, STATUS } from '@shared/data/enemies.ts';
import { HAZARD_TIMING, hazardState } from '@shared/sim/hazards.ts';
import {
  applyBoon, BIOME, biomeOfChamber, composeWave, DIRECTOR, generateRoom, HAZARD_PHASE, hasHazardFreeRoutes, Rng, tutorialRoom, waveBudget, World,
} from '@shared/sim/index.ts';
import { BIOME_IDS, BTN, EF, type BiomeId, type ClassId, type EnemyKind, type GameEvent, type Hazard, type RoomLayout } from '@shared/types.ts';
import { clearChamber, draftAll, dummy, hits, live, Pad, place, runBots, seconds, stepN, takeDoor } from './harness.ts';

type HazardHit = Extract<GameEvent, { e: 'hazardHit' }>;
const hazardHits = (events: GameEvent[]): HazardHit[] => events.filter((e): e is HazardHit => e.e === 'hazardHit');
const SEEDS = 250;

// ------------------------------------------------------------------------------------------------ acts and biomes

describe('biome sequence', () => {
  it('act 1 is always the crypt; acts 2 and 3 are flooded and forge in seeded order', () => {
    const orders = new Set<string>();
    for (let seed = 1; seed <= 300; seed++) {
      const w = new World();
      w.addPlayer(0, 'knight', 'A');
      w.start(0, seed);
      const biomes = RUN.CHAMBERS.map((_, i) => biomeOfChamber(w.director.biomes, i));
      expect(biomes.slice(0, 3)).toEqual(['crypt', 'crypt', 'crypt']);
      expect(new Set(biomes.slice(3, 6)).size).toBe(1);
      expect(new Set(biomes.slice(6, 8)).size).toBe(1);
      expect(new Set([biomes[3], biomes[6]])).toEqual(new Set(['flooded', 'forge']));
      orders.add(`${biomes[3]}>${biomes[6]}`);
      // Same seed, same order.
      const again = new World();
      again.addPlayer(0, 'mage', 'B');
      again.start(2, seed);
      expect(again.director.biomes).toEqual(w.director.biomes);
      expect(w.getRunState().room!.biome).toBe('crypt');
    }
    expect(orders).toEqual(new Set(['flooded>forge', 'forge>flooded']));
  });

  it('every chamber of a real run carries its act\'s biome in RoomLayout.biome, with that biome\'s hazard kind', () => {
    const kindOf: Record<BiomeId, Hazard['kind']> = { crypt: 'spikes', flooded: 'frost', forge: 'vent' };
    for (const seed of [3, 4, 5, 6, 7, 8]) {
      const w = new World();
      w.addPlayer(0, 'knight', 'A');
      w.addPlayer(1, 'mage', 'B');
      w.start(0, seed);
      const seen: BiomeId[] = [];
      for (let chamber = 0; chamber < RUN.CHAMBERS.length; chamber++) {
        const room = w.getRunState().room!;
        seen.push(room.biome);
        expect(room.biome).toBe(biomeOfChamber(w.director.biomes, chamber));
        for (const h of room.hazards) expect(h.kind).toBe(kindOf[room.biome]);
        if (chamber === 0) expect(room.hazards).toHaveLength(0);
        else expect(room.hazards.length).toBeGreaterThanOrEqual(1);
        if (chamber === RUN.CHAMBERS.length - 1) break;
        clearChamber(w);
        draftAll(w);
        takeDoor(w, 0);
      }
      expect(seen.slice(0, 3)).toEqual(['crypt', 'crypt', 'crypt']);
      expect(seen[3]).not.toBe('crypt');
      expect(seen[6]).not.toBe('crypt');
      expect(seen[6]).not.toBe(seen[3]);
    }
    expect(BIOME_IDS).toEqual(['crypt', 'flooded', 'forge']);
  });
});

// ------------------------------------------------------------------------------------------------ layouts

/** Independent walkability check (finer grid than the generator's): spawn -> every door, off hazards and obstacles. */
function lanesOpen(room: RoomLayout): boolean {
  const step = 0.4;
  const cols = Math.floor(room.w / step);
  const rows = Math.floor(room.d / step);
  const at = (c: number, r: number): [number, number] => [-room.w / 2 + (c + 0.5) * step, -room.d / 2 + (r + 0.5) * step];
  const free = (c: number, r: number): boolean => {
    const [x, z] = at(c, r);
    if (Math.abs(x) > room.w / 2 - WORLD.PLAYER_RADIUS || Math.abs(z) > room.d / 2 - WORLD.PLAYER_RADIUS) return false;
    for (const o of room.obstacles) if (Math.hypot(o.x - x, o.z - z) < o.r + WORLD.PLAYER_RADIUS) return false;
    for (const h of room.hazards) if (Math.hypot(h.x - x, h.z - z) < h.r) return false;
    return true;
  };
  const cell = (x: number, z: number): number => Math.min(rows - 1, Math.max(0, Math.floor((z + room.d / 2) / step))) * cols + Math.min(cols - 1, Math.max(0, Math.floor((x + room.w / 2) / step)));
  const seen = new Uint8Array(cols * rows);
  const start = cell(room.spawns[0]!.x, room.spawns[0]!.z);
  const queue = [start];
  seen[start] = 1;
  while (queue.length) {
    const i = queue.pop()!;
    const c = i % cols;
    const r = (i - c) / cols;
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nc = c + dc;
      const nr = r + dr;
      if (nc < 0 || nr < 0 || nc >= cols || nr >= rows || seen[nr * cols + nc] || !free(nc, nr)) continue;
      seen[nr * cols + nc] = 1;
      queue.push(nr * cols + nc);
    }
  }
  const z = -room.d / 2 + DIRECTOR.DOOR_WALL_OFFSET;
  const targets: [number, number][] = [[0, z], [-room.w / 4, z], [room.w / 4, z], ...room.spawns.map((s) => [s.x, s.z] as [number, number])];
  return targets.every(([x, tz]) => seen[cell(x, tz)] === 1);
}

/** Invariants every generated room must satisfy, whatever its biome. */
function checkCommon(room: RoomLayout, label: string): void {
  expect(room.spawns).toHaveLength(4);
  const doorZ = -room.d / 2 + DIRECTOR.DOOR_WALL_OFFSET;
  const doors: [number, number][] = [[0, doorZ], [-room.w / 4, doorZ], [room.w / 4, doorZ]];
  for (const o of room.obstacles) {
    expect(Math.abs(o.x) + o.r, label).toBeLessThanOrEqual(room.w / 2 - DIRECTOR.WALL_CLEARANCE + 1e-9);
    expect(Math.abs(o.z) + o.r, label).toBeLessThanOrEqual(room.d / 2 - DIRECTOR.WALL_CLEARANCE + 1e-9);
    for (const s of room.spawns) expect(Math.hypot(s.x - o.x, s.z - o.z) - o.r, label).toBeGreaterThanOrEqual(4 - 1e-9);
    for (const [x, z] of doors) expect(Math.hypot(x - o.x, z - o.z) - o.r, label).toBeGreaterThanOrEqual(DIRECTOR.DOOR_CLEARANCE - 1e-9);
    // Lanes: at least OBSTACLE_GAP of free floor between any two obstacles (the widest enemy is 2.2 m).
    for (const p of room.obstacles) if (p !== o) expect(Math.hypot(p.x - o.x, p.z - o.z) - p.r - o.r, label).toBeGreaterThanOrEqual(DIRECTOR.OBSTACLE_GAP - 1e-9);
  }
  expect(room.hazards.length, label).toBeLessThanOrEqual(BIOME.MAX_HAZARDS);
  for (const h of room.hazards) {
    // Inside the room.
    expect(Math.abs(h.x) + h.r, label).toBeLessThanOrEqual(room.w / 2);
    expect(Math.abs(h.z) + h.r, label).toBeLessThanOrEqual(room.d / 2);
    // No hazard within 4 m of a spawn point or within 2 m of a door zone.
    for (const s of room.spawns) expect(Math.hypot(s.x - h.x, s.z - h.z) - h.r, label).toBeGreaterThanOrEqual(4 - 1e-9);
    for (const [x, z] of doors) expect(Math.hypot(x - h.x, z - h.z) - h.r - WORLD.DOOR_RADIUS, label).toBeGreaterThanOrEqual(2 - 1e-9);
    // Never on top of an obstacle.
    for (const o of room.obstacles) expect(Math.hypot(o.x - h.x, o.z - h.z), label).toBeGreaterThan(h.r + o.r);
    // A sane cycle, and numbers that survive the 3-decimal JSON rounding unchanged (client and server must agree).
    expect(h.period).toBeGreaterThanOrEqual(HAZARD_TIMING.ACTIVE[h.kind] + HAZARD_TIMING.WARN + 0.5);
    expect(h.phase).toBeGreaterThanOrEqual(0);
    expect(h.phase).toBeLessThan(1.0001);
    for (const v of [h.x, h.z, h.r, h.period, h.phase]) expect(Math.abs(v * 1000 - Math.round(v * 1000))).toBeLessThan(1e-9);
  }
  for (const o of room.obstacles) for (const v of [o.x, o.z, o.r]) expect(Math.abs(v * 1000 - Math.round(v * 1000))).toBeLessThan(1e-9);
  // Clear lanes: the party can always reach every door without stepping on a hazard.
  expect(hasHazardFreeRoutes(room), label).toBe(true);
  expect(lanesOpen(room), label).toBe(true);
}

describe('per-biome layouts', () => {
  it('crypt: pillared halls; a few spike traps from the second chamber on', () => {
    const kinds = new Set<string>();
    const counts = new Set<number>();
    for (let seed = 1; seed <= SEEDS; seed++) {
      const first = generateRoom(new Rng(seed), 'combat', 'crypt', 0);
      expect(first.hazards).toHaveLength(0);
      const room = generateRoom(new Rng(seed), seed % 3 === 0 ? 'elite' : 'combat', 'crypt', 1 + (seed % 2));
      checkCommon(room, `crypt ${seed}`);
      expect(room.biome).toBe('crypt');
      expect(room.w).toBeGreaterThanOrEqual(26);
      expect(room.w).toBeLessThanOrEqual(38);
      expect(room.d).toBeGreaterThanOrEqual(20);
      expect(room.d).toBeLessThanOrEqual(28);
      expect(room.obstacles.length).toBeGreaterThanOrEqual(4);
      expect(room.obstacles.length).toBeLessThanOrEqual(10);
      for (const o of room.obstacles) {
        kinds.add(o.kind);
        expect(room.obstacles.some((p) => p.x === -o.x && p.z === o.z && p.r === o.r)).toBe(true);
      }
      expect(room.hazards.length).toBeLessThanOrEqual(BIOME.crypt.HAZARDS_MAX);
      counts.add(room.hazards.length);
      for (const h of room.hazards) expect(h.kind).toBe('spikes');
      // The obstacles are the same with and without hazards: hazards are added on top of the hall.
      expect(room.obstacles).toEqual(first.obstacles);
    }
    expect(kinds).toEqual(new Set(['pillar', 'column', 'barrels', 'crates', 'rubble', 'brazier']));
    expect(Math.max(...counts)).toBe(BIOME.crypt.HAZARDS_MAX);
    expect([...counts].filter((n) => n >= 2).length).toBeGreaterThanOrEqual(3);
  });

  it('flooded: wide, open rooms with few large obstacles and clusters of frost', () => {
    const kinds = new Set<string>();
    let cryptFill = 0;
    let floodedFill = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const room = generateRoom(new Rng(seed), seed % 3 === 0 ? 'elite' : 'combat', 'flooded', 3 + (seed % 3));
      checkCommon(room, `flooded ${seed}`);
      expect(room.biome).toBe('flooded');
      expect(room.w).toBeGreaterThanOrEqual(34);
      expect(room.w).toBeLessThanOrEqual(42);
      expect(room.d).toBeGreaterThanOrEqual(24);
      expect(room.d).toBeLessThanOrEqual(30);
      expect(room.w).toBeGreaterThan(room.d);
      expect(room.obstacles.length).toBeGreaterThanOrEqual(2);
      expect(room.obstacles.length).toBeLessThanOrEqual(5);
      for (const o of room.obstacles) { kinds.add(o.kind); expect(o.r).toBeGreaterThanOrEqual(1.2); }
      // Frost comes in patches: every circle overlaps another one that shares its rhythm.
      expect(room.hazards.length).toBeGreaterThanOrEqual(2);
      const clusters = new Set(room.hazards.map((h) => `${h.period}/${h.phase}`));
      expect(clusters.size).toBeGreaterThanOrEqual(1);
      expect(clusters.size).toBeLessThanOrEqual(BIOME.flooded.CLUSTERS_MAX);
      let grouped = 0;
      for (const h of room.hazards) {
        expect(h.kind).toBe('frost');
        if (room.hazards.some((o) => o !== h && o.period === h.period && o.phase === h.phase && Math.hypot(o.x - h.x, o.z - h.z) < o.r + h.r)) grouped++;
      }
      expect(grouped).toBeGreaterThanOrEqual(2);
      const crypt = generateRoom(new Rng(seed), 'combat', 'crypt', 3);
      cryptFill += crypt.obstacles.length / (crypt.w * crypt.d);
      floodedFill += room.obstacles.length / (room.w * room.d);
    }
    expect(kinds).toEqual(new Set(['sarcophagus', 'crystal', 'rubble']));
    // Far fewer obstacles per square metre than the crypt.
    expect(floodedFill).toBeLessThan(cryptFill * 0.6);
  });

  it('forge: long rooms cut into lanes by rows of obstacles, with vents in the lanes', () => {
    const kinds = new Set<string>();
    const rowCounts = new Set<number>();
    for (let seed = 1; seed <= SEEDS; seed++) {
      const room = generateRoom(new Rng(seed), seed % 3 === 0 ? 'elite' : 'combat', 'forge', 3 + (seed % 3));
      checkCommon(room, `forge ${seed}`);
      expect(room.biome).toBe('forge');
      expect(room.w).toBeGreaterThanOrEqual(24);
      expect(room.w).toBeLessThanOrEqual(28);
      expect(room.d).toBeGreaterThanOrEqual(30);
      expect(room.d).toBeLessThanOrEqual(36);
      expect(room.d).toBeGreaterThan(room.w);
      // Rows run along Z: the obstacles share one (centre row) or two (mirrored rows) x positions.
      const xs = new Set(room.obstacles.map((o) => o.x));
      expect(room.obstacles.length).toBeGreaterThanOrEqual(2);
      expect(xs.size === 1 || xs.size === 2).toBe(true);
      if (xs.size === 1) expect([...xs][0]).toBe(0);
      else expect([...xs].reduce((a, b) => a + b, 0)).toBe(0);
      rowCounts.add(xs.size);
      for (const x of xs) expect(room.obstacles.filter((o) => o.x === x).length).toBeGreaterThanOrEqual(2);
      for (const o of room.obstacles) kinds.add(o.kind);
      // Vents sit in the lanes between / beside the rows, never in a row.
      expect(room.hazards.length).toBeGreaterThanOrEqual(BIOME.forge.HAZARDS_MIN - 1);
      expect(room.hazards.length).toBeLessThanOrEqual(BIOME.forge.HAZARDS_MAX);
      for (const h of room.hazards) {
        expect(h.kind).toBe('vent');
        for (const x of xs) expect(Math.abs(h.x - x)).toBeGreaterThan(h.r);
      }
    }
    expect(kinds).toEqual(new Set(['anvil', 'stalagmite', 'brazier']));
    expect(rowCounts).toEqual(new Set([1, 2]));
  });

  it('boss rooms: large, mostly open, 2-4 hazards of the biome\'s kind near the edges', () => {
    const kindOf: Record<BiomeId, Hazard['kind']> = { crypt: 'spikes', flooded: 'frost', forge: 'vent' };
    for (const biome of BIOME_IDS) {
      const counts = new Set<number>();
      for (let seed = 1; seed <= SEEDS; seed++) {
        const room = generateRoom(new Rng(seed), 'boss', biome, 7);
        checkCommon(room, `boss ${biome} ${seed}`);
        expect(room.biome).toBe(biome);
        expect(room.w).toBe(DIRECTOR.BOSS_ROOM_W);
        expect(room.d).toBe(DIRECTOR.BOSS_ROOM_D);
        expect(room.obstacles.length).toBeLessThanOrEqual(4);
        for (const o of room.obstacles) expect(Math.hypot(o.x, o.z)).toBeGreaterThan(12);
        expect(room.hazards.length).toBeGreaterThanOrEqual(2);
        expect(room.hazards.length).toBeLessThanOrEqual(4);
        counts.add(room.hazards.length);
        for (const h of room.hazards) {
          expect(h.kind).toBe(kindOf[biome]);
          // Hugging a wall: the arena's centre stays free.
          expect(Math.min(room.w / 2 - Math.abs(h.x), room.d / 2 - Math.abs(h.z)) - h.r).toBeLessThanOrEqual(BIOME.BOSS.EDGE_BAND);
          expect(Math.hypot(h.x, h.z) - h.r).toBeGreaterThan(8);
        }
      }
      expect(counts).toEqual(new Set([2, 3, 4]));
    }
  });

  it('is deterministic per seed, different across seeds and biomes, and the tutorial arena obeys the same rules', () => {
    for (const biome of BIOME_IDS) {
      expect(generateRoom(new Rng(5), 'combat', biome, 4)).toEqual(generateRoom(new Rng(5), 'combat', biome, 4));
      expect(generateRoom(new Rng(5), 'combat', biome, 4)).not.toEqual(generateRoom(new Rng(6), 'combat', biome, 4));
    }
    expect(generateRoom(new Rng(5), 'combat', 'forge', 4).obstacles).not.toEqual(generateRoom(new Rng(5), 'combat', 'flooded', 4).obstacles);
    const room = tutorialRoom(1);
    checkCommon(room, 'tutorial');
    expect(room.biome).toBe('crypt');
    expect(room.hazards).toHaveLength(1);
  });

  it('hasHazardFreeRoutes notices a door that hazards cut off', () => {
    const room = generateRoom(new Rng(9), 'combat', 'crypt', 0);
    expect(hasHazardFreeRoutes(room)).toBe(true);
    // A wall of hazards across the whole room.
    const wall: Hazard[] = [];
    for (let x = -room.w / 2; x <= room.w / 2; x += 2) wall.push({ x, z: 0, r: 1.5, kind: 'spikes', period: 5, phase: 0 });
    expect(hasHazardFreeRoutes({ ...room, hazards: wall })).toBe(false);
    expect(lanesOpen({ ...room, hazards: wall })).toBe(false);
  });
});

describe('biome enemy mix', () => {
  it('flooded rooms favour casters and archers, the forge favours warriors; the cost budget is unchanged', () => {
    const share = (biome: BiomeId): Record<string, number> => {
      const counts: Record<string, number> = { minion: 0, warrior: 0, archer: 0, mage: 0 };
      let total = 0;
      for (let seed = 1; seed <= 600; seed++) {
        const chamber = 3 + (seed % 4);
        const party = 1 + (seed % 4);
        const budget = waveBudget(chamber, party);
        const kinds = composeWave(new Rng(seed), chamber, budget, party, WORLD.MAX_ENEMIES, biome);
        const cost = kinds.reduce((a, k: EnemyKind) => a + ENEMIES[k].cost, 0);
        expect(cost).toBeLessThanOrEqual(budget + 1e-6);
        expect(budget - cost).toBeLessThan(ENEMIES.minion.cost);
        for (const k of kinds) { counts[k]!++; total++; }
      }
      for (const k of Object.keys(counts)) counts[k]! /= total;
      return counts;
    };
    const crypt = share('crypt');
    const flooded = share('flooded');
    const forge = share('forge');
    expect(flooded.archer! + flooded.mage!).toBeGreaterThan((crypt.archer! + crypt.mage!) * 1.08);
    expect(forge.warrior!).toBeGreaterThan(crypt.warrior! * 1.3);
    expect(forge.archer! + forge.mage!).toBeLessThan(crypt.archer! + crypt.mage!);
    // "A little": every kind still shows up everywhere.
    for (const mix of [crypt, flooded, forge]) for (const k of Object.keys(mix)) expect(mix[k]!, k).toBeGreaterThan(0.05);
  });
});

// ------------------------------------------------------------------------------------------------ hazard effects

/** Sandbox whose only feature is one hazard at the origin. Short idle so tests do not wait long. */
function hazardArena(kind: Hazard['kind'], classes: ClassId[] = ['knight'], period = 0): { w: World; hz: Hazard } {
  const hz: Hazard = { x: 0, z: 0, r: 2, kind, period: period || HAZARD_TIMING.ACTIVE[kind] + HAZARD_TIMING.WARN + 1, phase: 0 };
  const w = new World();
  classes.forEach((cls, slot) => w.addPlayer(slot, cls, `P${slot}`));
  w.startSandbox(4, { seed: 4, biome: 'crypt', w: 40, d: 30, obstacles: [], hazards: [hz], spawns: [{ x: 0, z: 0 }, { x: 0.5, z: 0 }, { x: -0.5, z: 0 }, { x: 0, z: 0.5 }] });
  return { w, hz };
}
const cfgOf = (kind: Hazard['kind']) => (kind === 'spikes' ? HAZARD.SPIKES : kind === 'vent' ? HAZARD.VENT : HAZARD.FROST);
const cycleTicks = (hz: Hazard): number => Math.round(hz.period / TICK_DT);

describe('hazard effects', () => {
  for (const kind of ['spikes', 'vent', 'frost'] as const) {
    it(`${kind}: strikes a hero standing on it only while hazardState() says "active", at its fixed rhythm`, () => {
      const { w, hz } = hazardArena(kind);
      const h = w.hero(0)!;
      h.maxHp = 5000;
      h.hp = 5000;
      const pad = new Pad(w);
      const cfg = cfgOf(kind);
      const hitTicks: number[] = [];
      let activations = 0;
      let prev = 'idle';
      for (let i = 0; i < cycleTicks(hz) * 3; i++) {
        const ev = pad.hold({}, 1);
        const state = hazardState(hz, w.tick);
        if (state.phase === 'active' && prev !== 'active') activations++;
        prev = state.phase;
        const struck = hazardHits(ev);
        // The simulation's own bookkeeping agrees with the shared pure function, tick by tick.
        expect(w.hazardPhase[0]).toBe(state.phase === 'idle' ? HAZARD_PHASE.IDLE : state.phase === 'warn' ? HAZARD_PHASE.WARN : HAZARD_PHASE.ACTIVE);
        if (struck.length > 0) {
          expect(state.phase, `tick ${w.tick}`).toBe('active');
          expect(struck).toEqual([{ e: 'hazardHit', target: { t: 'p', id: 0 }, kind }]);
          hitTicks.push(w.tick);
          const direct = hits(ev, 'p').filter((x) => x.el === null);
          expect(direct).toHaveLength(1);
          expect(direct[0]).toMatchObject({ dmg: cfg.DAMAGE, by: -1 });
        }
      }
      expect(activations).toBe(3);
      const perActivation = Math.ceil(HAZARD_TIMING.ACTIVE[kind] / cfg.TICK - 1e-9);
      expect(hitTicks).toHaveLength(activations * perActivation);
      // The first strike comes with the very first active tick; the rhythm is exactly TICK.
      const firstActive = (() => { for (let t = 1; ; t++) if (hazardState(hz, t).phase === 'active') return t; })();
      expect(hitTicks[0]).toBe(firstActive);
      if (perActivation > 1) expect((hitTicks[1]! - hitTicks[0]!) * TICK_DT).toBeCloseTo(cfg.TICK, 6);
      expect(h.hp).toBeLessThan(5000);
    });
  }

  it('standing next to a hazard, or on it while it is idle or warning, is safe', () => {
    for (const kind of ['spikes', 'vent', 'frost'] as const) {
      const { w, hz } = hazardArena(kind);
      place(w, 0, hz.r + 0.1, 0);
      const ev = new Pad(w).hold({}, cycleTicks(hz) * 2);
      expect(hazardHits(ev)).toHaveLength(0);
      expect(w.hero(0)!.hp).toBe(CLASSES.knight.maxHp);
    }
  });

  it('vent: sets heroes ablaze (damage over time after leaving); frost: chills them (slower for a while)', () => {
    const vent = hazardArena('vent');
    const pad = new Pad(vent.w);
    const h = vent.w.hero(0)!;
    h.maxHp = 5000;
    h.hp = 5000;
    let ev: GameEvent[] = [];
    for (let i = 0; i < cycleTicks(vent.hz) && hazardHits(ev).length === 0; i++) ev = pad.hold({}, 1);
    expect(hazardHits(ev)).toHaveLength(1);
    place(vent.w, 0, 10, 0);
    const afterHit = h.hp;
    const burning = pad.hold({}, seconds(HAZARD.VENT.BURN_SECONDS + 1));
    const ticks = hits(burning, 'p').filter((x) => x.el === 'ember' && x.by === -1);
    expect(ticks.length).toBe(Math.round(HAZARD.VENT.BURN_SECONDS / HAZARD.VENT.BURN_TICK));
    expect(afterHit - h.hp).toBeCloseTo(HAZARD.VENT.BURN_DPS * HAZARD.VENT.BURN_SECONDS, 6);
    expect(h.burnTime).toBe(0);

    const frost = hazardArena('frost', ['rogue']);
    const pad2 = new Pad(frost.w);
    ev = [];
    for (let i = 0; i < cycleTicks(frost.hz) && hazardHits(ev).length === 0; i++) ev = pad2.hold({}, 1);
    pad2.hold({ moveX: 1 }, 1);
    expect(frost.w.getSelfState(0).moveSpeed).toBeCloseTo(CLASSES.rogue.moveSpeed * (1 - HAZARD.FROST.SLOW), 6);
    // Walk out: the chill wears off CHILL_SECONDS after the last strike.
    pad2.hold({ moveX: 1 }, seconds(HAZARD.FROST.CHILL_SECONDS) + 2);
    expect(frost.w.getSelfState(0).moveSpeed).toBeCloseTo(CLASSES.rogue.moveSpeed, 6);
  });

  it('dash i-frames carry a hero through an active hazard unharmed; downed heroes are left alone', () => {
    const { w, hz } = hazardArena('vent', ['knight', 'mage'], 60);
    // Long period: the hazard is active from 57.3 s on. Jump the clock to just before.
    const active = HAZARD_TIMING.ACTIVE.vent;
    w.tick = Math.round((hz.period - active) / TICK_DT) - 4;
    const down = w.hero(1)!;
    down.hp = 0;
    down.state = 'downed';
    place(w, 1, 0.5, 0.5);
    place(w, 0, -hz.r - 0.3, 0);
    const pad = new Pad(w);
    pad.hold({}, 3);
    // Dash across (5 m in 0.18 s with 0.26 s of i-frames) exactly as it turns active.
    const ev = pad.hold({ buttons: BTN.DASH, moveX: 1 }, 1);
    ev.push(...pad.hold({ moveX: 1 }, seconds(DASH.IFRAMES) + 1));
    expect(hazardState(hz, w.tick).phase).toBe('active');
    expect(w.hero(0)!.body.x).toBeGreaterThan(hz.r);
    expect(hazardHits(ev)).toHaveLength(0);
    expect(w.hero(0)!.hp).toBe(CLASSES.knight.maxHp);
    // Walking back in without a dash does hurt.
    place(w, 0, 0, 0);
    expect(hazardHits(pad.hold({}, seconds(HAZARD.VENT.TICK) + 2)).map((e) => e.target)).toEqual([{ t: 'p', id: 0 }]);
  });

  it('enemies take the full effect: scaled damage, Burn from vents, Chill from frost, and they can die from it', () => {
    for (const kind of ['spikes', 'vent', 'frost'] as const) {
      const { w, hz } = hazardArena(kind);
      place(w, 0, 15, 10);
      w.hpMul = 2;
      const e = dummy(w, 0.5, 0.5, 'minion', 100000);
      const rising = w.spawnEnemy('minion', -0.5, -0.5)!;
      const outside = dummy(w, hz.r + 0.6, 0, 'minion', 100000);
      w.drainEvents();
      const pad = new Pad(w);
      let ev: GameEvent[] = [];
      for (let i = 0; i < cycleTicks(hz) && hazardHits(ev).length === 0; i++) { rising.spawnTime = 1; ev = pad.hold({}, 1); }
      // Only the enemy that stands on it and has finished rising is struck.
      expect(hazardHits(ev)).toEqual([{ e: 'hazardHit', target: { t: 'e', id: e.id }, kind }]);
      const dmg = cfgOf(kind).DAMAGE * HAZARD.ENEMY_DAMAGE_MUL * w.hpMul;
      expect(100000 - e.hp).toBeCloseTo(dmg, 6);
      expect(outside.hp).toBe(100000);
      expect(rising.hp).toBe(rising.maxHp);
      const flags = w.getSnapshotBody().enemies.find((s) => s.id === e.id)!.flags;
      if (kind === 'vent') { expect(e.status).toBe('ember'); expect(flags & EF.BURN).toBeTruthy(); }
      else if (kind === 'frost') { expect(e.status).toBe('rime'); expect(flags & EF.CHILL).toBeTruthy(); }
      else expect(e.status).toBeNull();
      // A weak enemy is killed outright; nobody gets the kill.
      const weak = dummy(w, -0.6, 0.3, 'minion', 5);
      ev = [];
      for (let i = 0; i < cycleTicks(hz) * 2 && !weak.dead; i++) ev = pad.hold({}, 1);
      expect(weak.dead).toBe(true);
      expect(ev.find((x) => x.e === 'kill')).toMatchObject({ id: weak.id, by: -1 });
      expect(w.hero(0)!.run.kills).toBe(0);
    }
  });

  it('a hazard\'s mark can be detonated by a hero, and never replaces a hero\'s own mark', () => {
    const { w, hz } = hazardArena('vent', ['mage']);
    const h = w.hero(0)!;
    applyBoon(h, 'infuse_rime_primary');
    place(w, 0, 0, -8);
    const e = dummy(w, 0, 0.5, 'minion', 100000);
    const pad = new Pad(w);
    for (let i = 0; i < cycleTicks(hz) && e.status !== 'ember'; i++) pad.hold({ aim: 0 }, 1);
    expect(e.status).toBe('ember');
    const ev = pad.hold({ aim: 0, buttons: BTN.PRIMARY }, seconds(1));
    const burst = ev.find((x) => x.e === 'resonance');
    expect(burst).toMatchObject({ a: 'ember', b: 'rime', by: 0 });
    expect(h.run.resonances).toBe(1);
    // Now it carries the hero's Rime: the vent keeps hurting it but leaves the mark alone.
    expect(e.status).toBe('rime');
    const more = pad.hold({ aim: 0, buttons: BTN.PRIMARY }, cycleTicks(hz));
    expect(hazardHits(more).length).toBeGreaterThan(0);
    expect(e.status).toBe('rime');
    expect(more.filter((x) => x.e === 'resonance')).toHaveLength(0);
    void STATUS;
  });

  it('bosses and champions are immune to hazard damage and slow', () => {
    for (const hazard of ['spikes', 'vent', 'frost'] as const) {
      for (const kind of ['champion', 'regent', 'matron', 'stalker'] as const) {
        const { w, hz } = hazardArena(hazard);
        place(w, 0, 0.3, 0.3);
        const boss = live(w, kind, 0, 0);
        boss.boss!.gap = 999;
        boss.blinkCd = 999;
        w.drainEvents();
        const events: GameEvent[] = [];
        for (let i = 0; i < cycleTicks(hz) * 2; i++) {
          w.hero(0)!.hp = w.hero(0)!.maxHp;
          boss.x = 0;
          boss.z = 0;
          boss.boss!.gap = 999;
          w.step();
          events.push(...w.drainEvents());
        }
        expect(boss.hp, `${kind} on ${hazard}`).toBe(boss.maxHp);
        expect(boss.status).toBeNull();
        expect(hazardHits(events).every((e) => e.target.t === 'p')).toBe(true);
        expect(hazardHits(events).length).toBeGreaterThan(0);
      }
    }
  });

  it('hazards do nothing outside combat (draft, doors) and reset with the room', () => {
    const w = new World();
    w.addPlayer(0, 'knight', 'A');
    w.start(0, 4);
    clearChamber(w);
    draftAll(w);
    takeDoor(w, 0);
    expect(w.room.hazards.length).toBeGreaterThan(0);
    clearChamber(w);
    expect(w.run.phase).toBe('draft');
    const hz = w.room.hazards[0]!;
    place(w, 0, hz.x, hz.z);
    const hp = w.hero(0)!.hp;
    const ev = stepN(w, cycleTicks(hz) * 2);
    expect(hazardHits(ev)).toHaveLength(0);
    expect(w.hero(0)!.hp).toBe(hp);
    w.reset();
    expect(w.hazardsLive).toBe(0);
  });
});

describe('enemy AI and hazards', () => {
  /** A hazard that is almost always warning or active, between the enemies and the hero. */
  const lane = (heroX: number): { w: World; hz: Hazard } => {
    const { w, hz } = hazardArena('spikes', ['knight'], HAZARD_TIMING.ACTIVE.spikes + HAZARD_TIMING.WARN + 0.5);
    place(w, 0, heroX, 0);
    return { w, hz };
  };

  it('walks around a warning / active hazard when the way round is open', () => {
    const { w, hz } = lane(9);
    const pack = [-0.8, 0, 0.8].map((z) => live(w, 'minion', -9, z));
    w.drainEvents();
    const events: GameEvent[] = [];
    let arrived = false;
    for (let i = 0; i < seconds(12); i++) {
      w.hero(0)!.invuln = 1;
      w.step();
      events.push(...w.drainEvents());
      if (pack.every((e) => Math.hypot(e.x - 9, e.z) < 3)) arrived = true;
    }
    expect(arrived).toBe(true);
    expect(hazardHits(events)).toHaveLength(0);
    void hz;
  });

  it('can be lured in (hero right at the edge) and knocked in', () => {
    const lured = lane(2.6);
    const pack = [-0.8, 0, 0.8, 1.6, -1.6].map((z) => live(lured.w, 'minion', -9, z));
    for (const e of pack) { e.hp = e.maxHp = 100000; }
    lured.w.drainEvents();
    const events: GameEvent[] = [];
    for (let i = 0; i < seconds(15); i++) { lured.w.hero(0)!.invuln = 1; lured.w.step(); events.push(...lured.w.drainEvents()); }
    expect(hazardHits(events).filter((e) => e.target.t === 'e').length).toBeGreaterThan(0);

    // Knocked in: a mage's nova throws a stunned enemy into the spikes.
    const { w, hz } = hazardArena('spikes', ['mage'], 60);
    w.tick = Math.round((hz.period - HAZARD_TIMING.ACTIVE.spikes) / TICK_DT) - seconds(CLASSES.mage.secondary.windup) - 2;
    place(w, 0, 12, 0);
    const victim = dummy(w, hz.r + 0.9, 0, 'minion', 100000);
    const pad = new Pad(w);
    const ev = pad.hold({ buttons: BTN.SECONDARY, aim: -Math.PI / 2, aimDist: 12 - (hz.r + 2.4) }, 1);
    ev.push(...pad.hold({}, seconds(1.2)));
    expect(Math.hypot(victim.x, victim.z)).toBeLessThan(hz.r);
    expect(hazardHits(ev).some((e) => e.target.t === 'e' && e.target.id === victim.id)).toBe(true);
  });

  it('bots stay out of hazards far better than their enemies do', () => {
    let heroes = 0;
    let enemies = 0;
    let runs = 0;
    for (const classes of [['knight'], ['mage'], ['barbarian', 'rogue']] as ClassId[][]) {
      for (const seed of [101, 102, 103]) {
        const r = runBots({ classes, seed });
        heroes += r.hazardHitsHeroes;
        enemies += r.hazardHitsEnemies;
        runs++;
      }
    }
    process.stdout.write(`hazard hits over ${runs} bot runs: heroes ${heroes}, enemies ${enemies}\n`);
    expect(enemies).toBeGreaterThan(runs * 3);
    expect(heroes).toBeLessThan(enemies / 3);
    expect(heroes / runs).toBeLessThan(4);
  }, 60000);
});
