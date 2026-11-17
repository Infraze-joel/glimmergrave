import { describe, expect, it } from 'vitest';
import { RUN, TICK_DT, WORLD } from '@shared/constants.ts';
import { BOON_BY_ID, BOON_TUNING } from '@shared/data/boons.ts';
import { CLASSES } from '@shared/data/classes.ts';
import { ENEMIES, ENEMY_TUNING } from '@shared/data/enemies.ts';
import { composeWave, DIRECTOR, generateRoom, Rng, waveBudget, World } from '@shared/sim/index.ts';
import { EF, PF, type EnemyKind, type GameEvent } from '@shared/types.ts';
import { clearChamber, draftAll, Pad, seconds, stepN, takeDoor } from './harness.ts';

const start = (classes: ('knight' | 'mage' | 'rogue' | 'barbarian')[] = ['knight'], seed = 11, oath = 0): World => {
  const w = new World();
  classes.forEach((cls, slot) => w.addPlayer(slot, cls, `P${slot}`));
  expect(w.start(oath, seed)).toBe(true);
  return w;
};
const cost = (kinds: EnemyKind[]): number => kinds.reduce((sum, k) => sum + ENEMIES[k].cost, 0);

describe('room generation', () => {
  it('produces legal, mirrored layouts with clear lanes for every seed', () => {
    for (let seed = 1; seed <= 400; seed++) {
      const room = generateRoom(new Rng(seed), seed % 3 === 0 ? 'elite' : 'combat');
      expect(room.w).toBeGreaterThanOrEqual(26);
      expect(room.w).toBeLessThanOrEqual(38);
      expect(room.d).toBeGreaterThanOrEqual(20);
      expect(room.d).toBeLessThanOrEqual(28);
      expect(room.obstacles.length).toBeGreaterThanOrEqual(4);
      expect(room.obstacles.length).toBeLessThanOrEqual(10);
      expect(room.spawns).toHaveLength(4);
      for (const s of room.spawns) {
        expect(s.z).toBeGreaterThan(0);
        expect(Math.abs(s.x)).toBeLessThan(room.w / 2 - 1);
        expect(s.z).toBeLessThan(room.d / 2 - 1);
      }
      for (const o of room.obstacles) {
        // Inside the room with a walkable lane to every wall.
        expect(Math.abs(o.x) + o.r).toBeLessThanOrEqual(room.w / 2 - DIRECTOR.WALL_CLEARANCE + 1e-9);
        expect(Math.abs(o.z) + o.r).toBeLessThanOrEqual(room.d / 2 - DIRECTOR.WALL_CLEARANCE + 1e-9);
        // Nothing within 4 m of a spawn point.
        for (const s of room.spawns) expect(Math.hypot(s.x - o.x, s.z - o.z) - o.r).toBeGreaterThanOrEqual(4 - 1e-9);
        // Mirrored across the Z axis (or centred).
        expect(room.obstacles.some((p) => p.x === -o.x && p.z === o.z && p.r === o.r)).toBe(true);
        for (const p of room.obstacles) {
          if (p === o) continue;
          expect(Math.hypot(p.x - o.x, p.z - o.z) - p.r - o.r).toBeGreaterThanOrEqual(DIRECTOR.OBSTACLE_GAP - 1e-9);
        }
      }
    }
  });

  it('gives the boss a larger, mostly open arena', () => {
    const room = generateRoom(new Rng(7), 'boss');
    expect(room.w).toBeGreaterThan(38);
    expect(room.d).toBeGreaterThan(28);
    expect(room.obstacles.length).toBeLessThanOrEqual(4);
    for (const o of room.obstacles) expect(Math.hypot(o.x, o.z)).toBeGreaterThan(12);
  });

  it('is deterministic per seed and different across seeds', () => {
    expect(generateRoom(new Rng(5), 'combat')).toEqual(generateRoom(new Rng(5), 'combat'));
    expect(generateRoom(new Rng(5), 'combat')).not.toEqual(generateRoom(new Rng(6), 'combat'));
  });
});

describe('wave composition', () => {
  it('budget grows with the chamber index and the party size', () => {
    for (let chamber = 1; chamber < RUN.CHAMBERS.length; chamber++) expect(waveBudget(chamber, 1)).toBeGreaterThan(waveBudget(chamber - 1, 1));
    for (let n = 2; n <= 4; n++) expect(waveBudget(3, n)).toBeGreaterThan(waveBudget(3, n - 1));
    expect(waveBudget(2, 4) / waveBudget(2, 1)).toBeCloseTo(1 + 3 * RUN.COUNT_PER_EXTRA_PLAYER, 6);
  });

  it('never overspends, respects minChamber and the room left under the enemy cap', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const chamber = seed % RUN.CHAMBERS.length;
      const party = 1 + (seed % 4);
      const budget = waveBudget(chamber, party);
      const kinds = composeWave(new Rng(seed), chamber, budget, party, WORLD.MAX_ENEMIES);
      expect(kinds.length).toBeGreaterThan(0);
      expect(cost(kinds)).toBeLessThanOrEqual(budget + 1e-6);
      // Whatever is left could not have bought the cheapest enemy.
      expect(budget - cost(kinds)).toBeLessThan(ENEMIES.minion.cost);
      for (const k of kinds) {
        expect(ENEMIES[k].cost).toBeGreaterThan(0);
        expect(ENEMIES[k].minChamber).toBeLessThanOrEqual(chamber);
      }
      expect(composeWave(new Rng(seed), chamber, budget, party, 5).length).toBeLessThanOrEqual(5);
    }
    expect(composeWave(new Rng(1), 0, 50, 1, WORLD.MAX_ENEMIES).every((k) => k === 'minion' || k === 'archer')).toBe(true);
  });

  it('enemy health and damage scale with chamber, party size and oath', () => {
    const solo = start(['knight'], 4, 0);
    const party = start(['knight', 'mage', 'rogue'], 4, 0);
    const oath = start(['knight'], 4, 2);
    expect(solo.hpMul).toBe(1);
    expect(party.hpMul).toBeCloseTo(1 + 2 * RUN.HP_PER_EXTRA_PLAYER, 6);
    expect(oath.hpMul).toBeCloseTo(RUN.OATH[2].hp, 6);
    expect(oath.damageMul).toBeCloseTo(RUN.OATH[2].damage, 6);
    expect(oath.speedMul).toBeCloseTo(RUN.OATH[2].speed, 6);
    clearChamber(solo);
    draftAll(solo);
    takeDoor(solo, 0);
    expect(solo.run.chamber).toBe(1);
    expect(solo.hpMul).toBeCloseTo(1 + RUN.HP_GROWTH_PER_CHAMBER, 6);
    expect(solo.damageMul).toBeCloseTo(1 + RUN.DAMAGE_GROWTH_PER_CHAMBER, 6);
  });
});

describe('waves in a live chamber', () => {
  it('announces enemies with `spawn`, keeps them harmless and invulnerable while rising, >= 7 m from heroes', () => {
    for (const classes of [['knight'], ['knight', 'mage', 'rogue', 'barbarian']] as const) {
      const w = start([...classes], 21);
      const pads = w.heroes.map((h) => new Pad(w, h.slot));
      let spawns = 0;
      for (let i = 0; i < seconds(6); i++) {
        for (const pad of pads) pad.send({});
        w.step();
        for (const ev of w.drainEvents()) {
          if (ev.e !== 'spawn') continue;
          spawns++;
          for (const h of w.heroes) expect(Math.hypot(h.body.x - ev.x, h.body.z - ev.z)).toBeGreaterThanOrEqual(DIRECTOR.ENEMY_SPAWN_MIN_DISTANCE);
          const e = w.enemies.find((o) => o.id === ev.id)!;
          expect(e.spawnTime).toBeCloseTo(ENEMIES[e.kind].spawnTime, 6);
        }
        for (const e of w.enemies) if (e.spawnTime > 0) { expect(e.attack).toBeNull(); expect(e.anim).toBe('spawn'); }
        if (spawns > 0 && w.tick === seconds(DIRECTOR.FIRST_WAVE_DELAY) + 6) {
          // Abilities pass through enemies that are still rising.
          const rising = w.enemies.filter((e) => e.spawnTime > 0);
          expect(rising.length).toBeGreaterThan(0);
        }
      }
      expect(spawns).toBeGreaterThan(0);
      expect(w.tick * TICK_DT).toBeLessThan(15);
    }
  });

  it('spawning enemies cannot be damaged', () => {
    const w = start(['mage'], 2);
    stepN(w, seconds(DIRECTOR.FIRST_WAVE_DELAY) + 4);
    const rising = w.enemies.find((e) => e.spawnTime > 0)!;
    expect(rising).toBeDefined();
    const h = w.hero(0)!;
    h.body.x = rising.x;
    h.body.z = rising.z + 2;
    new Pad(w).hold({ buttons: 1, aim: Math.PI }, 6);
    expect(rising.hp).toBe(rising.maxHp);
  });

  it('starts the next wave when at most NEXT_WAVE_ALIVE enemies are left, and clears after the last wave', () => {
    const w = start(['knight'], 8);
    const waves: number[] = [];
    let cleared = false;
    for (let i = 0; i < seconds(40) && !cleared; i++) {
      for (const h of w.heroes) h.invuln = 1;
      const alive = w.enemies.filter((e) => !e.dead && e.spawnTime <= 0);
      // Leave exactly NEXT_WAVE_ALIVE enemies standing until the final wave is out.
      const keep = w.run.wave < w.run.waveCount ? DIRECTOR.NEXT_WAVE_ALIVE : 0;
      for (const e of alive.slice(keep)) { e.hp = 0; e.dead = true; e.corpseTime = 0; }
      w.step();
      for (const ev of w.drainEvents()) {
        if (ev.e === 'wave') { waves.push(ev.wave); expect(ev.waveCount).toBe(w.run.waveCount); }
        if (ev.e === 'chamberClear') cleared = true;
      }
    }
    expect(waves).toEqual(Array.from({ length: w.run.waveCount }, (_, i) => i + 1));
    expect(cleared).toBe(true);
    expect(w.run.phase).toBe('draft');
  });

  it('starts the next wave after WAVE_TIMEOUT even if the previous one is still alive', () => {
    const w = start(['knight'], 8);
    let second = -1;
    let first = -1;
    for (let i = 0; i < seconds(DIRECTOR.WAVE_TIMEOUT + 8) && second < 0; i++) {
      for (const h of w.heroes) h.invuln = 1;
      w.step();
      for (const ev of w.drainEvents()) {
        if (ev.e === 'wave' && ev.wave === 1) first = w.tick;
        if (ev.e === 'wave' && ev.wave === 2) second = w.tick;
      }
    }
    expect(first).toBeGreaterThan(0);
    expect((second - first) * TICK_DT).toBeGreaterThanOrEqual(DIRECTOR.WAVE_TIMEOUT);
    expect((second - first) * TICK_DT).toBeLessThan(DIRECTOR.WAVE_TIMEOUT + 4);
    expect(w.enemies.filter((e) => !e.dead).length).toBeGreaterThan(DIRECTOR.NEXT_WAVE_ALIVE);
  });
});

describe('doors', () => {
  const toDoors = (w: World): void => {
    clearChamber(w);
    draftAll(w);
    expect(w.run.phase).toBe('doors');
  };

  it('offers two distinct reward doors on the north wall', () => {
    const seen = new Set<string>();
    for (let seed = 1; seed <= 40; seed++) {
      const w = start(['knight'], seed);
      toDoors(w);
      const run = w.getRunState();
      expect(run.doors).toHaveLength(2);
      expect(run.doorProgress).toEqual([0, 0]);
      expect(run.doors[0]!.type).not.toBe(run.doors[1]!.type);
      for (const d of run.doors) {
        expect(['boon', 'blessing', 'cursed']).toContain(d.type);
        expect(d.z).toBeLessThan(-w.room.d / 2 + 3);
        expect(Math.abs(d.x)).toBeLessThan(w.room.w / 2 - WORLD.DOOR_RADIUS);
        seen.add(d.type);
      }
      expect(run.doors[0]!.x).not.toBe(run.doors[1]!.x);
    }
    expect(seen).toEqual(new Set(['boon', 'blessing', 'cursed']));
  });

  it('commits only when ALL living connected heroes hold one door for DOOR_HOLD_SECONDS', () => {
    const w = start(['knight', 'mage', 'rogue'], 6);
    toDoors(w);
    const [a, b] = w.getRunState().doors as [{ x: number; z: number; type: string }, { x: number; z: number; type: string }];
    const put = (slot: number, d: { x: number; z: number }): void => { w.hero(slot)!.body.x = d.x; w.hero(slot)!.body.z = d.z; };
    // Split party: no progress on either door.
    put(0, a); put(1, a); put(2, b);
    stepN(w, seconds(WORLD.DOOR_HOLD_SECONDS * 2));
    expect(w.run.phase).toBe('doors');
    expect(w.getRunState().doorProgress).toEqual([0, 0]);
    expect(w.getSnapshotBody().players.every((p) => (p.flags & PF.IN_DOOR_ZONE) !== 0)).toBe(true);
    // Everyone at door A: progress rises ...
    put(2, a);
    stepN(w, seconds(WORLD.DOOR_HOLD_SECONDS / 2));
    expect(w.getRunState().doorProgress[0]).toBeCloseTo(0.5, 1);
    // ... and falls back when someone steps out.
    put(1, { x: 0, z: 0 });
    stepN(w, seconds(WORLD.DOOR_HOLD_SECONDS));
    expect(w.getRunState().doorProgress[0]).toBe(0);
    expect(w.getSnapshotBody().players[1]!.flags & PF.IN_DOOR_ZONE).toBeFalsy();
    // A disconnected hero does not block the party.
    w.setConnected(1, false);
    const cooldown = (w.hero(0)!.secondaryCd = 4);
    const ev = stepN(w, seconds(WORLD.DOOR_HOLD_SECONDS) + 2);
    expect(ev).toContainEqual({ e: 'doorChosen', type: a.type });
    expect(w.run.phase).toBe('combat');
    expect(w.run.chamber).toBe(1);
    expect(w.getRunState().entered).toBe(a.type);
    expect(w.getRunState().doors).toEqual([]);
    // Heroes are teleported to their spawns; cooldowns are kept.
    for (const h of w.heroes) {
      const s = w.room.spawns[h.slot]!;
      expect(h.body.x).toBeCloseTo(s.x, 6);
      expect(h.body.z).toBeCloseTo(s.z, 6);
    }
    expect(w.hero(0)!.secondaryCd).toBeGreaterThan(cooldown - WORLD.DOOR_HOLD_SECONDS - 0.2);
    expect(w.hero(0)!.secondaryCd).toBeLessThan(cooldown);
  });

  it('a blessing door heals 35% when its chamber is cleared', () => {
    let tested = false;
    for (let seed = 1; seed <= 30 && !tested; seed++) {
      const w = start(['knight'], seed);
      toDoors(w);
      const index = w.getRunState().doors.findIndex((d) => d.type === 'blessing');
      if (index < 0) continue;
      takeDoor(w, index);
      expect(w.getRunState().entered).toBe('blessing');
      const h = w.hero(0)!;
      h.hp = 10;
      w.drainEvents();
      clearChamber(w);
      const heal = Math.round(h.maxHp * BOON_TUNING.BLESSING_HEAL_FRACTION);
      expect(w.drainEvents()).toContainEqual({ e: 'heal', slot: 0, amount: heal });
      expect(h.hp).toBeCloseTo(10 + h.maxHp * BOON_TUNING.BLESSING_HEAL_FRACTION, 6);
      expect(w.getDraft(0)).toHaveLength(RUN.DRAFT_CHOICES);
      tested = true;
    }
    expect(tested).toBe(true);
  });

  it('a cursed door empowers the next chamber and upgrades its draft', () => {
    let tested = false;
    for (let seed = 1; seed <= 30 && !tested; seed++) {
      const w = start(['knight'], seed);
      toDoors(w);
      const index = w.getRunState().doors.findIndex((d) => d.type === 'cursed');
      if (index < 0) continue;
      takeDoor(w, index);
      const spawned: GameEvent[] = [];
      for (let i = 0; i < seconds(4); i++) { w.hero(0)!.invuln = 1; w.step(); spawned.push(...w.drainEvents().filter((e) => e.e === 'spawn')); }
      expect(spawned.length).toBeGreaterThan(0);
      expect(spawned.every((e) => e.e === 'spawn' && e.elite)).toBe(true);
      for (const e of w.enemies) {
        expect(e.maxHp).toBeCloseTo(ENEMIES[e.kind].hp * w.hpMul * ENEMY_TUNING.ELITE_HP_MUL, 6);
        expect(e.damageMul).toBeCloseTo(w.damageMul * ENEMY_TUNING.ELITE_DAMAGE_MUL, 6);
      }
      expect(w.getSnapshotBody().enemies.every((e) => (e.flags & EF.ELITE) !== 0)).toBe(true);
      clearChamber(w);
      const offers = w.getDraft(0);
      expect(offers).toHaveLength(BOON_TUNING.CURSED_DRAFT_CHOICES);
      expect(offers.some((o) => BOON_BY_ID.get(o.id)!.rarity !== 'common')).toBe(true);
      tested = true;
    }
    expect(tested).toBe(true);
  });
});

describe('whole run flow (forced)', () => {
  it('walks the chamber sequence, spawns the champion and the Regent, and ends in victory', () => {
    const w = start(['knight', 'mage'], 31);
    const kinds: string[] = [];
    const versions: number[] = [];
    for (let chamber = 0; chamber < RUN.CHAMBERS.length; chamber++) {
      const run = w.getRunState();
      expect(run.chamber).toBe(chamber);
      expect(run.chamberKind).toBe(RUN.CHAMBERS[chamber]);
      expect(run.room).not.toBeNull();
      kinds.push(run.chamberKind);
      versions.push(w.runVersion);
      if (run.chamberKind !== 'combat') {
        // Wait for the boss to rise: it must be announced through bossId.
        let bossKind = '';
        for (let i = 0; i < seconds(6) && !bossKind; i++) {
          for (const h of w.heroes) h.invuln = 1;
          w.step();
          const id = w.getRunState().bossId;
          if (id >= 0) bossKind = w.enemies.find((e) => e.id === id)?.kind ?? '';
        }
        expect(bossKind).toBe(run.chamberKind === 'boss' ? 'regent' : 'champion');
      }
      if (run.chamberKind === 'boss') break;
      clearChamber(w);
      expect(w.run.phase).toBe('draft');
      draftAll(w);
      expect(w.run.phase).toBe('doors');
      const doors = w.getRunState().doors;
      if (RUN.CHAMBERS[chamber + 1] === 'boss') expect(doors.map((d) => d.type)).toEqual(['boss']);
      else expect(doors).toHaveLength(2);
      const ev = takeDoor(w, 0);
      expect(ev.some((e) => e.e === 'doorChosen')).toBe(true);
    }
    expect(kinds).toEqual([...RUN.CHAMBERS]);
    expect(new Set(versions).size).toBe(versions.length);
    // Boss chamber: add a few summons, then kill the Regent -> everything dies, victory.
    const regent = w.enemies.find((e) => e.kind === 'regent')!;
    regent.spawnTime = 0;
    w.spawnEnemy('minion', 3, 3, { summoned: true });
    w.spawnEnemy('minion', -3, 3, { summoned: true });
    w.hero(1)!.invuln = 0;
    w.hero(1)!.hp = 0;
    w.hero(1)!.state = 'downed';
    w.drainEvents();
    regent.hp = 0;
    regent.dead = true;
    const version = w.runVersion;
    w.step();
    const ev = w.drainEvents();
    expect(w.run.phase).toBe('victory');
    expect(w.runVersion).toBeGreaterThan(version);
    expect(w.enemies.every((e) => e.dead)).toBe(true);
    expect(ev.filter((e) => e.e === 'kill')).toHaveLength(2);
    expect(ev).toContainEqual({ e: 'chamberClear' });
    expect(w.hero(1)!.state).toBe('alive');
    stepN(w, seconds(1));
    expect(w.getSnapshotBody().players.every((p) => p.anim === 'cheer')).toBe(true);
    expect(w.getRunState().stats).toHaveLength(2);
    // reset() returns to the lobby with a clean slate.
    w.reset();
    const lobby = w.getRunState();
    expect(lobby.phase).toBe('lobby');
    expect(lobby.room).toBeNull();
    expect(w.getBoons(0)).toEqual([]);
    expect(w.enemies).toHaveLength(0);
    expect(w.hero(0)!.hp).toBe(CLASSES.knight.maxHp);
    expect(w.start(1, 77)).toBe(true);
    expect(w.getRunState().oath).toBe(1);
  });

  it('refuses to start without heroes or while a run is active; players cannot join mid-run', () => {
    const w = new World();
    expect(w.start(0, 1)).toBe(false);
    expect(w.addPlayer(0, 'knight', 'A')).toBe(true);
    expect(w.addPlayer(0, 'mage', 'dup')).toBe(false);
    expect(w.addPlayer(4, 'mage', 'oob')).toBe(false);
    expect(w.addPlayer(-1, 'mage', 'oob')).toBe(false);
    expect(w.setClass(0, 'rogue')).toBe(true);
    expect(w.hero(0)!.cls).toBe('rogue');
    expect(w.start(9, 1)).toBe(true);
    expect(w.getRunState().oath).toBe(RUN.OATH.length - 1);
    expect(w.start(0, 1)).toBe(false);
    expect(w.addPlayer(1, 'mage', 'late')).toBe(false);
    expect(w.setClass(0, 'knight')).toBe(false);
  });
});
