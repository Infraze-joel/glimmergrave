/**
 * Polish 1: objective fixtures are solid (simulation and prediction), `RunState.traits`, the party falloff of
 * ultimate charge, the cursed-chamber shard roll, and the tuning rules for hunt and defend.
 */
import { describe, expect, it } from 'vitest';
import { RUN, TICK_DT, WORLD } from '@shared/constants.ts';
import { CLASSES, ULTIMATE } from '@shared/data/classes.ts';
import { OBJECTIVE_TUNING } from '@shared/data/objectives.ts';
import { RELIC_TUNING } from '@shared/data/relics.ts';
import { damageHero, killEnemy, strikeEnemy } from '@shared/sim/combat.ts';
import { enterChamber } from '@shared/sim/director.ts';
import { hasLineOfSight } from '@shared/sim/enemies.ts';
import { huntSeconds } from '@shared/sim/objectives.ts';
import {
  blocksShots, BotBrain, cursedDropChance, dropChance, FIXTURE_KINDS, hasHazardFreeRoutes, maxBuild, maxMetaLevels, OBJECTIVE,
  partyChargeScale, resolveCollisions, stepMovement, viewFromWorld, World, type MoveBody,
} from '@shared/sim/index.ts';
import { BTN, type ClassId, type GameEvent, type ObjectiveKind, type Obstacle, type RoomLayout } from '@shared/types.ts';
import { draftAll, dummy, input, live, place, seconds, stepN, takeDoor } from './harness.ts';
import { arena, of, party } from './u3kit.ts';
import { finishChamber } from './u4kit.ts';

const T = OBJECTIVE_TUNING;
const EPS = 1e-6;

function begin(kind: ObjectiveKind, classes: ClassId[] = ['knight'], chamber = 2, seed = 11): World {
  const w = new World();
  classes.forEach((cls, slot) => expect(w.addPlayer(slot, cls, `P${slot}`)).toBe(true));
  expect(w.start(0, seed, chamber, { objective: kind })).toBe(true);
  w.drainEvents();
  return w;
}
const fixtures = (room: RoomLayout): Obstacle[] => room.obstacles.filter((o) => FIXTURE_KINDS.has(o.kind));
const scenery = (room: RoomLayout): Obstacle[] => room.obstacles.filter((o) => !FIXTURE_KINDS.has(o.kind));
const slayAll = (w: World): void => { for (const e of w.enemies) if (!e.dead && e.spawnTime <= 0) killEnemy(w, e, -1, true); };
/** What a client holds: the layout as it arrived in the `run` message. */
const wireRoom = (w: World): RoomLayout => JSON.parse(JSON.stringify(w.getRunState().room)) as RoomLayout;

describe('objective fixtures are obstacles', () => {
  it('the shard, each brazier bowl and the reliquary are in room.obstacles of the first run state of their chamber', () => {
    const defend = begin('defend');
    const shard = defend.getRunState().objective!.anchor!;
    expect(fixtures(defend.getRunState().room!)).toEqual([{ x: shard.x, z: shard.z, r: T.DEFEND.RADIUS, kind: 'shard' }]);

    const ritual = begin('ritual');
    const sites = ritual.getRunState().objective!.sites;
    expect(sites).toHaveLength(T.RITUAL.SITES);
    expect(fixtures(ritual.getRunState().room!)).toEqual(sites.map((s) => ({ x: s.x, z: s.z, r: OBJECTIVE.RITUAL_BOWL_RADIUS, kind: 'ritualBowl' })));
    // Only the bowl is solid: a hero fits between it and the edge of the circle with room to spare.
    expect(OBJECTIVE.RITUAL_BOWL_RADIUS + 2 * WORLD.PLAYER_RADIUS).toBeLessThan(T.RITUAL.RADIUS - 0.5);

    const vault = begin('vault');
    const chest = vault.getRunState().objective!.anchor!;
    expect(fixtures(vault.getRunState().room!)).toEqual([{ x: chest.x, z: chest.z, r: OBJECTIVE.VAULT_RADIUS, kind: 'reliquary' }]);
    // The reliquary can still be opened from where a hero can stand.
    expect(OBJECTIVE.VAULT_RADIUS + WORLD.PLAYER_RADIUS).toBeLessThan(chest.r + T.VAULT.OPEN_RADIUS_PAD - 0.5);

    for (const kind of ['slay', 'survive', 'hunt'] as const) expect(fixtures(begin(kind).getRunState().room!), kind).toEqual([]);
    // Fixtures come after the generated obstacles and stay while the party is in the room (draft, doors).
    const room = defend.getRunState().room!;
    expect(room.obstacles.indexOf(fixtures(room)[0]!)).toBe(room.obstacles.length - 1);
    finishChamber(defend);
    expect(defend.run.phase).toBe('draft');
    expect(fixtures(defend.getRunState().room!)).toHaveLength(1);
  });

  it('a chamber entered through a door has its fixtures in the run state of the same tick; the next room starts clean', () => {
    const w = begin('slay', ['knight'], 1, 4);
    w.director.pin = 'ritual';
    finishChamber(w);
    draftAll(w);
    const doors = w.getRunState().doors;
    expect(doors[0]!.objective).toBe('ritual');
    const version = w.runVersion;
    takeDoor(w, 0);
    expect(w.runVersion).toBeGreaterThan(version);
    const state = w.getRunState();
    expect(state.objective!.kind).toBe('ritual');
    expect(fixtures(state.room!)).toHaveLength(T.RITUAL.SITES);
    w.director.pin = 'slay';
    finishChamber(w);
    draftAll(w);
    takeDoor(w, 0);
    expect(w.getRunState().objective!.kind).toBe('slay');
    expect(fixtures(w.getRunState().room!)).toEqual([]);
  });

  it('the shared movement code keeps a walking and a dashing body out of every fixture, from every side', () => {
    for (const kind of ['defend', 'ritual', 'vault'] as const) {
      const room = wireRoom(begin(kind));
      for (const f of fixtures(room)) {
        const min = f.r + WORLD.PLAYER_RADIUS;
        for (let i = 0; i < 16; i++) {
          const a = (i / 16) * Math.PI * 2;
          for (const dash of [false, true]) {
            const body: MoveBody = { x: f.x + Math.sin(a) * (min + 1.5), z: f.z + Math.cos(a) * (min + 1.5), dashTime: dash ? 0.4 : 0, dashDirX: -Math.sin(a), dashDirZ: -Math.cos(a), rootTime: 0, moveSpeed: 6 };
            for (let t = 0; t < seconds(1.5); t++) {
              stepMovement(body, -Math.sin(a), -Math.cos(a), TICK_DT, room);
              expect(Math.hypot(body.x - f.x, body.z - f.z), `${kind} ${f.kind} angle ${i}`).toBeGreaterThanOrEqual(min - EPS);
            }
            // It got there and was stopped by the fixture, not by something else.
            expect(Math.hypot(body.x - f.x, body.z - f.z)).toBeLessThan(min + 0.6);
          }
        }
        // A point dropped inside is pushed to the edge.
        const p = resolveCollisions({ x: f.x + 0.1, z: f.z }, WORLD.PLAYER_RADIUS, room);
        expect(Math.hypot(p.x - f.x, p.z - f.z)).toBeGreaterThanOrEqual(min - EPS);
      }
    }
  });

  it('prediction parity: a client replaying its inputs over the layout from the run message matches the server exactly', () => {
    for (const kind of ['defend', 'ritual', 'vault'] as const) {
      const w = begin(kind, ['rogue'], 2, 21);
      const room = wireRoom(w);
      const target = fixtures(room)[0]!;
      const h = w.hero(0)!;
      // One idle tick tells the client its move speed (SelfState), then it walks and dashes into the fixture and slides along it.
      w.applyInput(0, input(1));
      w.step();
      const self = w.getSelfState(0);
      const body: MoveBody = { x: self.x, z: self.z, dashTime: self.dashTime, dashDirX: self.dashDirX, dashDirZ: self.dashDirZ, rootTime: self.rootTime, moveSpeed: self.moveSpeed };
      let touched = false;
      for (let seq = 2; seq < seconds(6); seq++) {
        h.invuln = 1;
        slayAll(w);
        const d = Math.hypot(target.x - body.x, target.z - body.z);
        // Slightly off-centre, so the body slides around instead of balancing on the spot.
        const moveX = Math.max(-1, Math.min(1, (target.x - body.x) / d + 0.05));
        const moveZ = (target.z - body.z) / d;
        w.applyInput(0, input(seq, { moveX, moveZ, aim: Math.atan2(moveX, moveZ) }));
        w.step();
        // The speed of the tick is part of SelfState (floor hazards and boons change it).
        body.moveSpeed = w.getSelfState(0).moveSpeed;
        stepMovement(body, moveX, moveZ, TICK_DT, room);
        expect(body.x, `${kind} tick ${seq}`).toBe(h.body.x);
        expect(body.z, `${kind} tick ${seq}`).toBe(h.body.z);
        if (d < target.r + WORLD.PLAYER_RADIUS + 0.01) touched = true;
      }
      expect(touched, kind).toBe(true);
    }
  });

  it('in every biome the room stays walkable: spawns reach the doors and each fixture, nothing overlaps, nobody starts inside', () => {
    for (let seed = 1; seed <= 40; seed++) {
      for (const chamber of [1, 2, 4, 5, 7]) {
        for (const kind of ['defend', 'ritual', 'vault'] as const) {
          if (chamber < 2 && kind === 'vault') continue;
          if (RUN.CHAMBERS[chamber] !== 'combat') continue;
          const w = begin(kind, ['knight', 'mage', 'rogue', 'shade'], chamber, seed);
          const room = w.room;
          const where = `seed ${seed} chamber ${chamber} ${kind} (${room.biome})`;
          const own = fixtures(room);
          expect(own.length, where).toBe(kind === 'ritual' ? T.RITUAL.SITES : 1);
          expect(hasHazardFreeRoutes(room, own.map((f) => ({ x: f.x, z: f.z, r: f.r + WORLD.PLAYER_RADIUS + OBJECTIVE.FIXTURE_APPROACH }))), where).toBe(true);
          for (const f of own) {
            for (const o of scenery(room)) expect(Math.hypot(o.x - f.x, o.z - f.z) - o.r - f.r, where).toBeGreaterThan(2 * WORLD.PLAYER_RADIUS);
            for (const hz of room.hazards) expect(Math.hypot(hz.x - f.x, hz.z - f.z), where).toBeGreaterThan(hz.r + f.r);
            for (const h of w.heroes) expect(Math.hypot(h.body.x - f.x, h.body.z - f.z), where).toBeGreaterThan(f.r + WORLD.PLAYER_RADIUS + 1);
            for (const d of w.getRunState().doors) expect(Math.hypot(d.x - f.x, d.z - f.z), where).toBeGreaterThan(f.r + WORLD.DOOR_RADIUS);
            expect(Math.abs(f.x) + f.r + 2 * WORLD.PLAYER_RADIUS, where).toBeLessThan(room.w / 2);
            expect(Math.abs(f.z) + f.r + 2 * WORLD.PLAYER_RADIUS, where).toBeLessThan(room.d / 2);
          }
        }
      }
    }
  });

  it('shots pass over fixtures (lines of sight, projectiles) but not over pillars', () => {
    const w = begin('defend', ['rogue'], 2, 9);
    const shard = fixtures(w.room)[0]!;
    expect(blocksShots(shard)).toBe(false);
    expect(blocksShots({ x: 0, z: 0, r: 1, kind: 'pillar' })).toBe(true);
    w.room.obstacles.length = 0;
    w.room.obstacles.push(shard);
    w.room.hazards.length = 0;
    expect(hasLineOfSight(w, shard.x - 4, shard.z, shard.x + 4, shard.z, 0.25)).toBe(true);
    w.director.manual = true;
    place(w, 0, shard.x - 4, shard.z);
    const foe = dummy(w, shard.x + 4, shard.z);
    const h = w.hero(0)!;
    h.primaryCd = 0;
    const fired = (): GameEvent[] => {
      const ev: GameEvent[] = [];
      for (let i = 0; i < seconds(1.5); i++) {
        w.applyInput(0, input(100 + i + h.ackSeq, { aim: Math.PI / 2, aimDist: 8, buttons: BTN.PRIMARY }));
        w.step();
        ev.push(...w.drainEvents());
      }
      return ev;
    };
    expect(of(fired(), 'hit').some((x) => x.target.t === 'e' && x.target.id === foe.id)).toBe(true);
    // The same shot is stopped by a pillar standing in the same place.
    w.room.obstacles[0] = { ...shard, kind: 'pillar' };
    stepN(w, seconds(1));
    w.drainEvents();
    expect(of(fired(), 'hit').some((x) => x.target.t === 'e' && x.target.id === foe.id)).toBe(false);
  });
});

describe('enemies and fixtures', () => {
  it('a minion walks around a fixture that stands exactly between it and its target', () => {
    for (const kind of ['defend', 'vault'] as const) {
      const w = begin(kind, ['knight'], 2, 13);
      w.director.manual = true;
      w.enemies.length = 0;
      const f = fixtures(w.room)[0]!;
      w.room.obstacles.length = 0;
      w.room.obstacles.push(f);
      w.room.hazards.length = 0;
      place(w, 0, f.x - 5, f.z);
      const e = live(w, 'minion', f.x + 5, f.z);
      e.attackCd = 1e9;
      const h = w.hero(0)!;
      let closest = Infinity;
      for (let i = 0; i < seconds(6); i++) {
        h.invuln = 1;
        w.step();
        expect(Math.hypot(e.x - f.x, e.z - f.z), kind).toBeGreaterThanOrEqual(f.r + e.radius - EPS);
        closest = Math.min(closest, Math.hypot(e.x - h.body.x, e.z - h.body.z));
      }
      expect(closest, kind).toBeLessThan(e.def.attackRange + 0.5);
    }
  });

  it('siege enemies walk straight up to the shard and still break it; enemies never rise inside a fixture', () => {
    const w = begin('defend', ['knight'], 2, 5);
    const shard = fixtures(w.room)[0]!;
    place(w, 0, w.room.w / 2 - 1.5, w.room.d / 2 - 1.5);
    let siegeTouch = false;
    const spawns: Extract<GameEvent, { e: 'spawn' }>[] = [];
    for (let i = 0; i < seconds(60) && w.director.obj!.anchorHp > 0; i++) {
      w.hero(0)!.invuln = 1;
      w.step();
      spawns.push(...of(w.drainEvents(), 'spawn'));
      for (const e of w.enemies) {
        if (e.dead) continue;
        const d = Math.hypot(e.x - shard.x, e.z - shard.z);
        expect(d).toBeGreaterThanOrEqual(shard.r + e.radius - EPS);
        if (e.siege && d < shard.r + e.radius + 0.6) siegeTouch = true;
      }
    }
    expect(siegeTouch).toBe(true);
    expect(w.director.obj!.anchorHp).toBe(0);
    expect(spawns.length).toBeGreaterThan(5);
    for (const s of spawns) expect(Math.hypot(s.x - shard.x, s.z - shard.z)).toBeGreaterThan(shard.r);
  });
});

/** Bots play the chamber a run starts in; `each` sees the world after every tick. */
function botsPlay(kind: ObjectiveKind, classes: ClassId[], seed: number, each: (w: World) => void, until: (w: World) => boolean): World {
  const w = new World();
  classes.forEach((cls, slot) => w.addPlayer(slot, cls, `B${slot}`, maxBuild(cls, maxMetaLevels())));
  w.start(0, seed, 2, { objective: kind });
  const bots = classes.map((cls, slot) => new BotBrain(slot, cls, seed));
  while (!until(w) && w.tick < seconds(240)) {
    const shared = { ...w.getSnapshotBody(), run: w.getRunState() };
    for (const bot of bots) {
      const offers = w.getDraft(bot.slot);
      if (offers.length > 0) w.pickBoon(bot.slot, bot.chooseBoon(offers, w.getBoons(bot.slot)));
      w.applyInput(bot.slot, bot.think(viewFromWorld(w, bot.slot, shared)));
    }
    w.step();
    const ev = w.drainEvents();
    for (const bot of bots) bot.observe(ev, w.tick);
    each(w);
  }
  return w;
}

describe('bots and fixtures', () => {
  it('whole chambers: nobody is ever inside a fixture (heroes with dashes, leaps and lunges; enemies with blinks, knockback and landings)', () => {
    const PARTY: ClassId[] = ['barbarian', 'spellblade', 'shade', 'mage'];
    for (const [kind, classes, seed] of [['defend', PARTY, 3], ['ritual', PARTY, 4], ['ritual', ['knight'], 5], ['defend', ['rogue'], 6], ['vault', PARTY, 7]] as [ObjectiveKind, ClassId[], number][]) {
      let checked = 0;
      const w = botsPlay(kind, classes, seed, (x) => {
        if (x.run.chamber !== 2) return;
        for (const f of fixtures(x.room)) {
          for (const h of x.heroes) {
            expect(Math.hypot(h.body.x - f.x, h.body.z - f.z), `${kind} hero ${h.cls}`).toBeGreaterThanOrEqual(f.r + WORLD.PLAYER_RADIUS - EPS);
            checked++;
          }
          for (const e of x.enemies) {
            // A reaver in the air flies in a straight line (over pillars too); it lands outside.
            if (e.dead || (e.attack && e.attack.type === 'pounce')) continue;
            expect(Math.hypot(e.x - f.x, e.z - f.z), `${kind} enemy ${e.kind}`).toBeGreaterThanOrEqual(f.r + e.radius - EPS);
          }
        }
      }, (x) => x.run.chamber !== 2 || x.run.phase === 'victory' || x.run.phase === 'defeat');
      expect(checked, kind).toBeGreaterThan(100);
      // They finished the chamber and walked on through a door, fixtures or not.
      expect(w.run.chamber, `${kind} ${classes.join('+')} seed ${seed}`).toBe(3);
    }
  });

  it('a bot whose way to the door is blocked dead-on by the reliquary walks around it', () => {
    for (const slotCls of ['knight', 'mage'] as ClassId[]) {
      const w = new World();
      w.addPlayer(0, slotCls, 'B');
      w.start(0, 8, 2, { objective: 'vault' });
      finishChamber(w);
      draftAll(w);
      expect(w.run.phase).toBe('doors');
      const f = fixtures(w.room)[0]!;
      const bot = new BotBrain(0, slotCls, 8);
      // Find the door it wants, then stand exactly behind the reliquary as seen from that door.
      place(w, 0, 0, w.room.d / 2 - 2);
      const first = bot.think(viewFromWorld(w, 0));
      const door = w.getRunState().doors.reduce((best, d) => {
        const h = w.hero(0)!;
        const along = (dd: { x: number; z: number }): number => ((dd.x - h.body.x) * first.moveX + (dd.z - h.body.z) * first.moveZ) / Math.hypot(dd.x - h.body.x, dd.z - h.body.z);
        return along(d) > along(best) ? d : best;
      });
      const dx = f.x - door.x;
      const dz = f.z - door.z;
      const dd = Math.hypot(dx, dz);
      place(w, 0, f.x + (dx / dd) * (f.r + WORLD.PLAYER_RADIUS + 0.4), f.z + (dz / dd) * (f.r + WORLD.PLAYER_RADIUS + 0.4));
      // Dead on: the first step already has a sideways part.
      const cmd = bot.think(viewFromWorld(w, 0));
      expect(Math.abs(cmd.moveX * (dz / dd) - cmd.moveZ * (dx / dd))).toBeGreaterThan(0.5);
      let guard = 0;
      for (; guard < seconds(12) && w.run.phase === 'doors'; guard++) {
        w.applyInput(0, bot.think(viewFromWorld(w, 0)));
        w.step();
      }
      expect(w.run.chamber, slotCls).toBe(3);
      expect(guard).toBeLessThan(seconds(10));
    }
  });
});

describe('RunState.traits', () => {
  it('lists exactly the living enemies with a ward, an affix or a master, and nothing else', () => {
    const w = party(['knight', 'mage']);
    expect(w.getRunState().traits).toEqual([]);
    const plain = live(w, 'minion', 0, -5);
    const warded = live(w, 'archer', 2, -5, { ward: 'rime' });
    const affixed = live(w, 'warrior', 4, -5, { elite: true, affix: 'volatile' });
    const both = live(w, 'mage', 6, -5, { elite: true, affix: 'swift', ward: 'ember' });
    const necro = live(w, 'necromancer', -4, -6);
    const raised = live(w, 'minion', -5, -6, { summoned: true, master: necro.id });
    const want = [
      { id: warded.id, ward: 'rime' }, { id: affixed.id, affix: 'volatile' }, { id: both.id, ward: 'ember', affix: 'swift' },
      { id: raised.id, raisedBy: necro.id },
    ];
    expect(w.getRunState().traits).toEqual(want);
    // Exactly the keys that are set (the wire carries no nulls).
    expect(JSON.parse(JSON.stringify(w.getRunState().traits))).toEqual(want);
    expect(w.getRunState().traits.some((t) => t.id === plain.id)).toBe(false);
    // The same facts the `spawn` events announced.
    const spawned = of(w.drainEvents(), 'spawn').filter((s) => s.ward !== undefined || s.affix !== undefined || s.raisedBy !== undefined);
    expect(spawned.map((s) => ({ id: s.id, ...(s.ward ? { ward: s.ward } : {}), ...(s.affix ? { affix: s.affix } : {}), ...(s.raisedBy !== undefined ? { raisedBy: s.raisedBy } : {}) }))).toEqual(want);
    // The returned list is a copy.
    w.getRunState().traits.length = 0;
    expect(w.getRunState().traits).toHaveLength(4);
    // Death removes an entry at once (the corpse is still in the snapshot); the necromancer takes its minion along.
    killEnemy(w, warded, 0);
    expect(w.getSnapshotBody().enemies.some((e) => e.id === warded.id)).toBe(true);
    expect(w.getRunState().traits.map((t) => t.id)).toEqual([affixed.id, both.id, raised.id]);
    killEnemy(w, necro, 0);
    expect(w.getRunState().traits.map((t) => t.id)).toEqual([affixed.id, both.id]);
    const version = w.runVersion;
    live(w, 'minion', 0, 5, { ward: 'storm' });
    // Rising and falling enemies do not force a run message: the list is built whenever one is sent.
    expect(w.runVersion).toBe(version);
    expect(w.getRunState().traits).toHaveLength(3);
  });

  it('is filled by the director (wards from chamber 4 on) and empty in the lobby and in training', () => {
    const lobby = new World();
    lobby.addPlayer(0, 'knight', 'A');
    expect(lobby.getRunState().traits).toEqual([]);
    const w = new World();
    w.addPlayer(0, 'knight', 'A');
    w.start(0, 5, 4, { objective: 'slay' });
    const seen = new Map<number, string>();
    const announced = new Map<number, string>();
    for (let i = 0; i < seconds(12); i++) {
      w.hero(0)!.invuln = 1;
      w.step();
      for (const s of of(w.drainEvents(), 'spawn')) if (s.ward) announced.set(s.id, s.ward);
      const traits = w.getRunState().traits;
      const alive = new Set(w.enemies.filter((e) => !e.dead).map((e) => e.id));
      for (const t of traits) {
        expect(alive.has(t.id)).toBe(true);
        seen.set(t.id, t.ward ?? '');
      }
      expect(traits).toHaveLength(w.enemies.filter((e) => !e.dead && (e.ward !== null || e.affix !== null || e.master >= 0)).length);
    }
    expect(announced.size).toBeGreaterThan(0);
    expect([...seen]).toEqual([...announced]);
    const t = new World();
    t.addPlayer(0, 'mage', 'T');
    t.startTutorial(1);
    expect(t.getRunState().traits).toEqual([]);
  });
});

describe('ultimate charge in a party', () => {
  it('charge earned by fighting falls with every extra hero; solo heroes are untouched', () => {
    expect([1, 2, 3, 4].map(partyChargeScale)).toEqual([1, 1 / (1 + ULTIMATE.PARTY_FALLOFF), 1 / (1 + 2 * ULTIMATE.PARTY_FALLOFF), 1 / (1 + 3 * ULTIMATE.PARTY_FALLOFF)]);
    expect(partyChargeScale(4)).toBeLessThan(0.7);
    expect(partyChargeScale(4)).toBeGreaterThan(0.5);
    const gains = (heroes: number): number[] => {
      const w = party((['knight', 'mage', 'rogue', 'templar'] as ClassId[]).slice(0, heroes));
      const h = w.hero(0)!;
      const foe = dummy(w, 0, -3);
      const out: number[] = [];
      strikeEnemy(w, h, foe, 50, 'primary', { fromX: 0, fromZ: 0, stun: 0, knockback: 0 });
      out.push(h.ult);
      h.ult = 0;
      strikeEnemy(w, h, foe, 5000, 'secondary', { fromX: 0, fromZ: 0, stun: 0, knockback: 0 });
      out.push(h.ult);
      h.ult = 0;
      damageHero(w, h, 10, -1);
      out.push(h.ult);
      return out;
    };
    const solo = gains(1);
    expect(solo[0]).toBeCloseTo(50 * ULTIMATE.PER_DAMAGE_DEALT, 6);
    expect(solo[1]).toBeCloseTo(ULTIMATE.MAX_PER_HIT, 6);
    expect(solo[2]).toBeCloseTo(10 * ULTIMATE.PER_DAMAGE_TAKEN, 6);
    for (const n of [2, 3, 4]) {
      const got = gains(n);
      got.forEach((g, i) => expect(g, `${n} heroes, source ${i}`).toBeCloseTo((solo[i] as number) * partyChargeScale(n), 6));
    }
  });

  it('the party size of the chamber counts (who is connected when it is entered); charge handed out by boons is not reduced', () => {
    const w = new World();
    (['knight', 'mage', 'rogue', 'templar'] as ClassId[]).forEach((cls, slot) => w.addPlayer(slot, cls, `P${slot}`));
    w.start(0, 3, 0, { objective: 'slay' });
    expect(w.partySize).toBe(4);
    const h = w.hero(0)!;
    h.ult = 0;
    damageHero(w, h, 10, -1);
    expect(h.ult).toBeCloseTo(10 * ULTIMATE.PER_DAMAGE_TAKEN * partyChargeScale(4), 6);
    // opening_act: at least this much charge at the start of a chamber, whatever the party size.
    h.stats.openingAct = 0.5;
    h.ult = 0;
    enterChamber(w, 1, 'boon');
    expect(h.ult).toBe(ULTIMATE.MAX * 0.5);
    const a = arena('knight');
    expect(a.w.partySize).toBe(1);
    expect(CLASSES.knight.ultimate.id).toBe('knight_bulwark');
  });
});

describe('relic shards in cursed chambers', () => {
  const cursedRun = (classes: ClassId[], seed: number): World => {
    const w = new World();
    classes.forEach((cls, slot) => w.addPlayer(slot, cls, `P${slot}`));
    w.start(0, seed, 1, { objective: 'slay' });
    return w;
  };
  /** Slays `count` freshly risen enemies by the first hero's hand. */
  const slay = (w: World, count: number, opts: Parameters<World['spawnEnemy']>[3], by = 0, quiet = false): void => {
    for (let i = 0; i < count; i++) {
      const e = w.spawnEnemy('minion', 0, 0, opts);
      if (!e) throw new Error('enemy cap');
      killEnemy(w, e, by, quiet);
      w.enemies.length = 0;
    }
  };
  const MANY = 600;

  it('an elite of the rank and file slain by a hero gives every hero a small chance, capped at one shard per hero and chamber', () => {
    expect(RELIC_TUNING.DROP_CURSED_ELITE).toBeLessThan(RELIC_TUNING.DROP_ELITE / 2);
    expect(RELIC_TUNING.CURSED_SHARDS_PER_CHAMBER).toBe(1);
    const w = cursedRun(['knight', 'mage', 'rogue'], 7);
    enterChamber(w, 2, 'cursed');
    w.director.manual = true;
    expect(w.cursed).toBe(true);
    slay(w, MANY, { elite: true });
    // 600 rolls at 2 %: everyone has found one, nobody a second.
    expect(w.heroes.map((h) => h.shards.length)).toEqual([1, 1, 1]);
    expect(w.heroes.map((h) => h.cursedShards)).toEqual([1, 1, 1]);
    // The next cursed chamber can give one more; a chamber behind another door gives none.
    w.director.manual = false;
    enterChamber(w, 3, 'cursed');
    w.director.manual = true;
    expect(w.heroes.map((h) => h.cursedShards)).toEqual([0, 0, 0]);
    slay(w, MANY, { elite: true });
    expect(w.heroes.map((h) => h.shards.length)).toEqual([2, 2, 2]);
    w.director.manual = false;
    enterChamber(w, 4, 'boon');
    w.director.manual = true;
    slay(w, MANY, { elite: true });
    expect(w.heroes.map((h) => h.shards.length)).toEqual([2, 2, 2]);
    // The shards are paid with the run's rewards.
    w.director.manual = false;
    for (const h of w.heroes) { h.hp = 0; h.state = 'downed'; }
    stepN(w, 3);
    expect(w.run.phase).toBe('defeat');
    expect(w.getRunState().rewards.map((r) => r.relics.length)).toEqual([2, 2, 2]);
  });

  it('ordinary enemies, summoned minions and enemies that crumble or die without a hero never roll', () => {
    const w = cursedRun(['knight'], 9);
    enterChamber(w, 2, 'cursed');
    w.director.manual = true;
    const h = w.hero(0)!;
    slay(w, MANY, { elite: false });
    slay(w, MANY, { elite: true, summoned: true });
    slay(w, MANY, { elite: true }, -1);
    slay(w, MANY, { elite: true }, 0, true);
    expect(h.shards).toEqual([]);
    slay(w, MANY, { elite: true });
    expect(h.shards).toHaveLength(1);
  });

  it('the chance grows with depth, Oath and relic find like the champion`s; the loot stream never touches the fight', () => {
    expect(cursedDropChance(0, 0, 0)).toBeCloseTo(RELIC_TUNING.DROP_CURSED_ELITE, 9);
    expect(cursedDropChance(2, 5, 0.1) / cursedDropChance(0, 0, 0)).toBeCloseTo(dropChance('elite', 2, 5, 0.1) / dropChance('elite', 0, 0, 0), 9);
    expect(cursedDropChance(50, 20, 5)).toBeLessThanOrEqual(1);
    // Same seed, with and without the kills that roll: the run's own generator is at the same point.
    const a = cursedRun(['knight'], 12);
    const b = cursedRun(['knight'], 12);
    for (const w of [a, b]) { enterChamber(w, 2, 'cursed'); w.director.manual = true; }
    slay(a, 50, { elite: true });
    slay(b, 50, { elite: true }, -1);
    expect(a.rng.u32()).toBe(b.rng.u32());
  });
});

describe('tuning rules of polish 1', () => {
  it('a hunt gives a party more time; a lone hero guards a tougher shard', () => {
    expect([1, 2, 3, 4].map(huntSeconds)).toEqual([0, 1, 2, 3].map((n) => T.HUNT.SECONDS + n * T.HUNT.SECONDS_PER_EXTRA_PLAYER));
    expect(begin('hunt', ['knight', 'mage', 'rogue', 'shade']).getRunState().objective!.timeLeft).toBe(huntSeconds(4));
    expect(begin('hunt').getRunState().objective!.timeLeft).toBe(T.HUNT.SECONDS);
    const solo = begin('defend');
    const duo = begin('defend', ['knight', 'mage']);
    expect(solo.director.obj!.anchorMaxHp).toBeCloseTo(T.DEFEND.HP * solo.damageMul * T.DEFEND.SOLO_HP_MUL, 6);
    expect(duo.director.obj!.anchorMaxHp).toBeCloseTo(T.DEFEND.HP * duo.damageMul, 6);
    expect(T.DEFEND.SOLO_HP_MUL).toBeGreaterThan(1);
  });
});
