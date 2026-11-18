/** Update 4: chamber objectives — each one start to finish with its bonus won and lost, doors, rewards, counters. */
import { describe, expect, it } from 'vitest';
import { RUN, TICK_DT, WORLD } from '@shared/constants.ts';
import { BOON_BY_ID, BOON_TUNING } from '@shared/data/boons.ts';
import { REWARDS } from '@shared/data/meta.ts';
import { OBJECTIVES, OBJECTIVE_TUNING } from '@shared/data/objectives.ts';
import { downHero, killEnemy } from '@shared/sim/combat.ts';
import { damageAnchor, huntSeconds, huntTargets, surviveSeconds } from '@shared/sim/objectives.ts';
import { FIXTURE_KINDS, glimmerReward, OBJECTIVE, World } from '@shared/sim/index.ts';
import { EF, OBJECTIVE_KINDS, type ClassId, type Door, type GameEvent, type ObjectiveKind, type ObjectiveState } from '@shared/types.ts';
import { draftAll, place, seconds, takeDoor } from './harness.ts';
import { of } from './u3kit.ts';
import { finishChamber } from './u4kit.ts';

const T = OBJECTIVE_TUNING;

/** A run that begins in combat chamber `chamber` with the given objective. */
function begin(kind: ObjectiveKind, classes: ClassId[] = ['knight'], chamber = 2, seed = 11): { w: World; ev: GameEvent[] } {
  const w = new World();
  classes.forEach((cls, slot) => expect(w.addPlayer(slot, cls, `P${slot}`)).toBe(true));
  expect(w.start(0, seed, chamber, { objective: kind })).toBe(true);
  return { w, ev: w.drainEvents() };
}
const state = (w: World): ObjectiveState => w.getRunState().objective as ObjectiveState;
/** Steps with untouchable heroes; `each` runs before every tick. Stops when the phase is no longer `combat`. */
function run(w: World, ticks: number, each?: (w: World) => void): GameEvent[] {
  const ev: GameEvent[] = [];
  for (let i = 0; i < ticks && w.run.phase === 'combat'; i++) {
    for (const h of w.heroes) if (h.state === 'alive') h.invuln = 1;
    each?.(w);
    w.step();
    ev.push(...w.drainEvents());
  }
  return ev;
}
const slayAll = (w: World): void => { for (const e of w.enemies) if (!e.dead && e.spawnTime <= 0) killEnemy(w, e, 0); };
const objectiveEvents = (ev: GameEvent[]): string[] => of(ev, 'objective').map((o) => (o.what === 'done' ? `done:${o.bonus}` : o.what === 'site' ? `site:${o.index}` : o.what));
const rarities = (w: World, slot = 0): string[] => w.getDraft(slot).map((o) => BOON_BY_ID.get(o.id)!.rarity);
const expectRichDraft = (w: World, rich: boolean): void => {
  expect(w.run.phase).toBe('draft');
  expect(w.getDraft(0)).toHaveLength(RUN.DRAFT_CHOICES + (rich ? T.BONUS_EXTRA_CHOICES : 0));
  if (rich) expect(rarities(w).some((r) => r !== 'common')).toBe(true);
};
const chamberPay = REWARDS.PER_CHAMBER_CLEARED;

describe('objective state', () => {
  it('is null in the lobby, a `slay` state in classic chambers, null again when the run is over; the training session has none', () => {
    const w = new World();
    w.addPlayer(0, 'knight', 'A');
    expect(w.getRunState().objective).toBeNull();
    w.start(0, 3);
    const ev = w.drainEvents();
    expect(of(ev, 'objective')).toEqual([{ e: 'objective', kind: 'slay', what: 'start' }]);
    expect(state(w)).toEqual({ kind: 'slay', progress: 0, timeLeft: 0, bonus: false, status: 'active', anchor: null, sites: [], targets: [] });
    expect(w.getRunState()).toMatchObject({ objectivesDone: 0, objectiveBonuses: 0 });
    // Waves cleared / waves.
    const seen = new Set<number>();
    const all = run(w, seconds(60), (x) => { slayAll(x); seen.add(Math.round(state(x).progress * 100)); });
    expect([...seen].sort((a, b) => a - b)).toEqual([0, 33, 67]);
    expect(objectiveEvents(all)).toEqual(['done:false']);
    expect(state(w)).toMatchObject({ status: 'done', progress: 1 });
    expect(w.getRunState()).toMatchObject({ objectivesDone: 0, objectiveBonuses: 0 });
    expectRichDraft(w, false);
    // The returned state is a copy.
    state(w).progress = 0.5;
    expect(state(w).progress).toBe(1);
    const lost = new World();
    lost.addPlayer(0, 'knight', 'A');
    lost.addPlayer(1, 'mage', 'B');
    lost.start(0, 3);
    for (const h of lost.heroes) downHero(lost, h);
    lost.step();
    expect(lost.run.phase).toBe('defeat');
    expect(lost.getRunState().objective).toBeNull();

    const t = new World();
    t.addPlayer(0, 'mage', 'T');
    expect(t.startTutorial(1)).toBe(true);
    expect(t.getRunState().objective).toBeNull();
    expect(of(t.drainEvents(), 'objective')).toEqual([]);
  });

  it('elite and boss chambers are `slay` whatever the door said', () => {
    for (const chamber of [3, 6, 7]) {
      const { w, ev } = begin('ritual', ['knight'], chamber);
      expect(w.run.chamberKind).not.toBe('combat');
      expect(state(w).kind).toBe('slay');
      expect(of(ev, 'objective')[0]).toMatchObject({ kind: 'slay', what: 'start' });
    }
  });
});

describe('survive', () => {
  it('enemies keep coming until the timer ends, then the rest crumbles; nobody down = bonus (richer draft, Glimmer)', () => {
    const { w, ev } = begin('survive', ['knight'], 1);
    const total = surviveSeconds(1);
    expect(total).toBe(T.SURVIVE.SECONDS + T.SURVIVE.SECONDS_PER_CHAMBER);
    expect(surviveSeconds(99)).toBe(T.SURVIVE.MAX_SECONDS);
    expect(objectiveEvents(ev)).toEqual(['start']);
    expect(state(w)).toMatchObject({ kind: 'survive', timeLeft: total, progress: 0, bonus: true, status: 'active' });
    expect(w.run.waveCount).toBe(0);
    // Half way: groups have risen, the timer and the progress follow the clock.
    const first = run(w, seconds(total / 2));
    expect(state(w).timeLeft).toBeCloseTo(total / 2, 1);
    expect(state(w).progress).toBeCloseTo(0.5, 2);
    const groups = of(first, 'wave');
    expect(groups.length).toBeGreaterThanOrEqual(2);
    expect(groups.every((g) => g.waveCount === 0)).toBe(true);
    expect(w.run.wave).toBe(groups.length);
    expect(of(first, 'spawn').length).toBeGreaterThan(4);
    // Killing everything does not end it.
    slayAll(w);
    run(w, seconds(2));
    expect(w.run.phase).toBe('combat');
    const alive = (): number => w.enemies.filter((e) => !e.dead).length;
    const rest = run(w, seconds(total / 2 - 2) - 2);
    expect(state(w).status).toBe('active');
    expect(alive()).toBeGreaterThan(0);
    const end = run(w, 4);
    expect(objectiveEvents([...rest, ...end])).toEqual(['done:true']);
    expect(alive()).toBe(0);
    expect(of(end, 'kill').length).toBeGreaterThan(0);
    expect(state(w)).toMatchObject({ status: 'done', progress: 1, timeLeft: 0, bonus: true });
    expect(w.run.phase).toBe('combat');
    const after = run(w, seconds(1.2));
    expect(of(after, 'chamberClear')).toHaveLength(1);
    expectRichDraft(w, true);
    expect(w.director.earnings.glimmer).toBeCloseTo(chamberPay + T.BONUS_GLIMMER, 6);
    expect(w.getRunState()).toMatchObject({ objectivesDone: 1, objectiveBonuses: 1 });
  });

  it('the bonus is lost the moment a hero goes down, even if they are back up when the bell tolls', () => {
    const { w } = begin('survive', ['knight', 'mage'], 1);
    place(w, 0, -8, 8);
    place(w, 1, 8, 8);
    run(w, seconds(5));
    expect(state(w).bonus).toBe(true);
    const mage = w.hero(1)!;
    mage.invuln = 0;
    downHero(w, mage);
    const ev = run(w, 2);
    expect(objectiveEvents(ev)).toEqual(['bonusLost']);
    expect(state(w)).toMatchObject({ bonus: false, status: 'active' });
    // Raised again: the bonus does not come back.
    place(w, 0, 8, 8);
    const rest = run(w, seconds(surviveSeconds(1)));
    expect(of(rest, 'revived').length).toBeGreaterThan(0);
    expect(objectiveEvents(rest)).toEqual(['done:false']);
    expectRichDraft(w, false);
    expect(w.director.earnings.glimmer).toBeCloseTo(chamberPay, 6);
    expect(w.getRunState()).toMatchObject({ objectivesDone: 1, objectiveBonuses: 0 });
  });

  it('the room never fills beyond the alive budget and never beyond the enemy cap', () => {
    const { w } = begin('survive', ['knight', 'mage', 'rogue', 'barbarian'], 5);
    let most = 0;
    run(w, seconds(surviveSeconds(5)) - 5, (x) => { most = Math.max(most, x.enemies.filter((e) => !e.dead).length); });
    expect(most).toBeGreaterThan(8);
    expect(most).toBeLessThanOrEqual(WORLD.MAX_ENEMIES);
  });
});

describe('defend', () => {
  it('a bell shard stands clear in the room; the chamber is cleared like slay and the surviving shard is the bonus', () => {
    const { w, ev } = begin('defend', ['knight'], 1);
    expect(objectiveEvents(ev)).toEqual(['start']);
    const s = state(w);
    expect(s).toMatchObject({ kind: 'defend', bonus: true, timeLeft: 0, sites: [], targets: [] });
    expect(s.anchor).toMatchObject({ r: T.DEFEND.RADIUS, hp: 1 });
    // Clear of everything the room was generated with (the shard itself is an obstacle too since polish 1).
    const scenery = w.room.obstacles.filter((o) => !FIXTURE_KINDS.has(o.kind));
    expect(scenery).toHaveLength(w.room.obstacles.length - 1);
    for (const o of scenery) expect(Math.hypot(o.x - s.anchor!.x, o.z - s.anchor!.z)).toBeGreaterThan(o.r + s.anchor!.r);
    // A lone hero's shard is tougher (SOLO_HP_MUL).
    expect(w.director.obj!.anchorMaxHp).toBeCloseTo(T.DEFEND.HP * w.damageMul * T.DEFEND.SOLO_HP_MUL, 6);
    expect(w.run.waveCount).toBeGreaterThan(1);
    const all = run(w, seconds(60), slayAll);
    expect(objectiveEvents(all)).toEqual(['done:true']);
    expect(of(all, 'wave')).toHaveLength(w.run.waveCount);
    expect(state(w).anchor!.hp).toBe(1);
    expectRichDraft(w, true);
    expect(w.getRunState()).toMatchObject({ objectivesDone: 1, objectiveBonuses: 1 });
  });

  it('ATTACKER_SHARE of each wave attacks the shard with telegraphed attacks; a shattered shard costs the bonus and the fight goes on', () => {
    const { w } = begin('defend', ['knight'], 2, 5);
    const anchor = state(w).anchor!;
    // The hero hides in a corner; nothing is killed.
    place(w, 0, w.room.w / 2 - 1, w.room.d / 2 - 1);
    const ev: GameEvent[] = [];
    let sieging = 0;
    let waveSize = 0;
    let lastHp = 1;
    let telegraphed = 0;
    for (let i = 0; i < seconds(120) && state(w).anchor!.hp > 0; i++) {
      const tick = run(w, 1);
      ev.push(...tick);
      if (w.run.wave === 1 && w.director.queue.length === 0 && waveSize === 0 && w.enemies.length > 0) {
        waveSize = w.enemies.length;
        sieging = w.enemies.filter((e) => e.siege).length;
      }
      telegraphed += of(tick, 'telegraph').filter((t) => t.src !== undefined && w.enemies.some((e) => e.id === t.src && e.siege)).length;
      const hp = state(w).anchor!.hp;
      // No damage to the shard before an attack on it was announced.
      if (hp < lastHp) expect(telegraphed).toBeGreaterThan(0);
      lastHp = hp;
    }
    expect(waveSize).toBeGreaterThan(3);
    expect(sieging).toBeGreaterThan(0);
    expect(sieging).toBeLessThanOrEqual(Math.round(waveSize * T.DEFEND.ATTACKER_SHARE));
    for (const e of w.enemies) if (e.siege) expect(OBJECTIVE.SIEGE_KINDS).toContain(e.kind);
    expect(state(w).anchor!.hp).toBe(0);
    expect(state(w)).toMatchObject({ bonus: false, status: 'active' });
    expect(objectiveEvents(ev).filter((x) => x === 'bonusLost')).toHaveLength(1);
    // anchorHit is rate-limited.
    const hitTicks: number[] = [];
    let tick = 0;
    for (const x of ev) { if (x.e === 'objective' && x.what === 'anchorHit') hitTicks.push(tick); tick++; }
    expect(hitTicks.length).toBeGreaterThan(1);
    expect(of(ev, 'objective').filter((o) => o.what === 'anchorHit').length).toBeLessThanOrEqual(Math.ceil(w.run.elapsed / T.DEFEND.ANCHOR_HIT_EVENT_SECONDS) + 1);
    // The siege turns on the hero now.
    const hero = w.hero(0)!;
    run(w, seconds(6));
    const besiegers = w.enemies.filter((e) => e.siege && !e.dead);
    expect(besiegers.length).toBeGreaterThan(0);
    for (const e of besiegers) expect(Math.hypot(e.x - hero.body.x, e.z - hero.body.z)).toBeLessThan(Math.hypot(anchor.x - hero.body.x, anchor.z - hero.body.z));
    // Shattered stays shattered: no repair.
    place(w, 0, anchor.x + 1.5, anchor.z);
    run(w, seconds(T.DEFEND.REPAIR_DELAY + 2));
    expect(state(w).anchor!.hp).toBe(0);
    const rest = run(w, seconds(90), slayAll);
    expect(objectiveEvents(rest)).toEqual(['done:false']);
    expectRichDraft(w, false);
    expect(w.getRunState()).toMatchObject({ objectivesDone: 1, objectiveBonuses: 0 });
  });

  it('heroes standing next to the shard repair it after REPAIR_DELAY, faster with more heroes, never from afar', () => {
    const { w } = begin('defend', ['knight', 'mage'], 1);
    w.director.manual = false;
    const anchor = state(w).anchor!;
    const max = w.director.obj!.anchorMaxHp;
    const freeze = (x: World): void => { x.director.waveDelay = 99; };
    damageAnchor(w, max * 0.5);
    expect(state(w).anchor!.hp).toBeCloseTo(0.5, 6);
    place(w, 0, anchor.x + anchor.r + T.DEFEND.REPAIR_RADIUS - 0.2, anchor.z);
    place(w, 1, anchor.x + anchor.r + T.DEFEND.REPAIR_RADIUS + 1, anchor.z);
    run(w, seconds(T.DEFEND.REPAIR_DELAY) - 2, freeze);
    expect(state(w).anchor!.hp).toBeCloseTo(0.5, 6);
    run(w, seconds(5) + 2, freeze);
    expect(state(w).anchor!.hp).toBeCloseTo(0.5 + 5 * T.DEFEND.REPAIR_PER_SECOND, 2);
    place(w, 1, anchor.x - 1.5, anchor.z);
    const before = state(w).anchor!.hp;
    run(w, seconds(5), freeze);
    expect(state(w).anchor!.hp - before).toBeCloseTo(2 * 5 * T.DEFEND.REPAIR_PER_SECOND, 2);
    // A hit interrupts the repair; nobody near = nothing.
    damageAnchor(w, 1);
    const hit = state(w).anchor!.hp;
    run(w, seconds(2), freeze);
    expect(state(w).anchor!.hp).toBeCloseTo(hit, 6);
    place(w, 0, anchor.x + 9, anchor.z);
    place(w, 1, anchor.x - 9, anchor.z);
    run(w, seconds(T.DEFEND.REPAIR_DELAY + 3), freeze);
    expect(state(w).anchor!.hp).toBeCloseTo(hit, 6);
  });
});

describe('hunt', () => {
  it('marked elites with an escort; the chamber ends when all are dead; in time = bonus', () => {
    expect([1, 2, 3, 4].map(huntTargets)).toEqual([2, 2, 3, 3]);
    const { w, ev } = begin('hunt', ['knight', 'mage', 'rogue'], 2);
    expect(objectiveEvents(ev)).toEqual(['start']);
    expect(state(w)).toMatchObject({ kind: 'hunt', timeLeft: huntSeconds(3), bonus: true, targets: [], progress: 0 });
    expect(w.run.waveCount).toBe(1);
    const rise = run(w, seconds(8));
    const marked = w.enemies.filter((e) => e.marked);
    expect(marked).toHaveLength(3);
    for (const e of marked) {
      expect(e.elite).toBe(true);
      expect(OBJECTIVE.HUNT_KINDS).toContain(e.kind);
      expect(e.maxHp).toBeGreaterThan(e.def.hp * w.hpMul * OBJECTIVE.HUNT_HP_MUL);
    }
    expect([...state(w).targets].sort()).toEqual(marked.map((e) => e.id).sort());
    const escort = w.enemies.filter((e) => !e.marked);
    expect(escort.length).toBeGreaterThan(0);
    expect(of(rise, 'spawn')).toHaveLength(marked.length + escort.length);
    expect(state(w).timeLeft).toBeCloseTo(huntSeconds(3) - 8, 1);
    // One down.
    killEnemy(w, marked[0]!, 0);
    run(w, 2);
    expect(state(w).targets).toHaveLength(2);
    expect(state(w).progress).toBeCloseTo(1 / 3, 6);
    killEnemy(w, marked[1]!, 0);
    killEnemy(w, marked[2]!, 1);
    run(w, seconds(3));
    // The escort still stands: not over, and the timer has stopped mattering.
    expect(state(w)).toMatchObject({ targets: [], progress: 1, status: 'active', bonus: true });
    expect(w.run.phase).toBe('combat');
    run(w, seconds(T.HUNT.SECONDS));
    expect(state(w)).toMatchObject({ bonus: true, status: 'active' });
    const end = run(w, seconds(5), slayAll);
    expect(objectiveEvents(end)).toEqual(['done:true']);
    expectRichDraft(w, true);
    expect(w.getRunState()).toMatchObject({ objectivesDone: 1, objectiveBonuses: 1 });
  });

  it('when the timer runs out the marked elites enrage (flag, damage, speed) and the bonus is lost', () => {
    const { w } = begin('hunt', ['knight'], 2);
    place(w, 0, 0, w.room.d / 2 - 1);
    run(w, seconds(8));
    const marked = w.enemies.filter((e) => e.marked);
    expect(marked).toHaveLength(2);
    const before = marked.map((e) => [e.damageMul, e.speedMul]);
    const flag = (id: number): number => w.getSnapshotBody().enemies.find((e) => e.id === id)!.flags & EF.ENRAGED;
    expect(flag(marked[0]!.id)).toBe(0);
    const ev = run(w, seconds(T.HUNT.SECONDS - 8) + 2);
    expect(objectiveEvents(ev)).toEqual(['bonusLost']);
    expect(state(w)).toMatchObject({ timeLeft: 0, bonus: false, status: 'active' });
    marked.forEach((e, i) => {
      expect(e.damageMul).toBeCloseTo(before[i]![0]! * T.HUNT.ENRAGE_DAMAGE_MUL, 6);
      expect(e.speedMul).toBeCloseTo(before[i]![1]! * T.HUNT.ENRAGE_SPEED_MUL, 6);
      expect(flag(e.id)).toBe(EF.ENRAGED);
    });
    for (const e of w.enemies) if (!e.marked) expect(flag(e.id)).toBe(0);
    // Only once.
    expect(objectiveEvents(run(w, seconds(3)))).toEqual([]);
    const end = run(w, seconds(5), slayAll);
    expect(objectiveEvents(end)).toEqual(['done:false']);
    expectRichDraft(w, false);
  });
});

describe('ritual', () => {
  it('braziers stand clear of obstacles, hazards, walls and each other in every biome', () => {
    for (let seed = 1; seed <= 60; seed++) {
      for (const chamber of [1, 4, 5]) {
        const { w } = begin('ritual', ['knight'], chamber, seed);
        const sites = state(w).sites;
        expect(sites).toHaveLength(T.RITUAL.SITES);
        sites.forEach((s, i) => {
          const where = `seed ${seed} chamber ${chamber} site ${i}`;
          expect(s).toMatchObject({ r: T.RITUAL.RADIUS, progress: 0, lit: false });
          expect(Math.abs(s.x) + s.r, where).toBeLessThan(w.room.w / 2);
          expect(Math.abs(s.z) + s.r, where).toBeLessThan(w.room.d / 2);
          for (const o of w.room.obstacles) if (!FIXTURE_KINDS.has(o.kind)) expect(Math.hypot(o.x - s.x, o.z - s.z), where).toBeGreaterThan(o.r + s.r);
          for (const h of w.room.hazards) expect(Math.hypot(h.x - s.x, h.z - s.z), where).toBeGreaterThan(h.r + s.r);
          for (let j = 0; j < i; j++) expect(Math.hypot(sites[j]!.x - s.x, sites[j]!.z - s.z), where).toBeGreaterThan(2 * s.r);
        });
      }
    }
  });

  it('standing in a circle lights it, leaving lets it decay, lit stays lit; all lit in time = bonus and the rest crumbles', () => {
    const { w, ev } = begin('ritual', ['knight'], 1);
    expect(objectiveEvents(ev)).toEqual(['start']);
    expect(state(w)).toMatchObject({ kind: 'ritual', timeLeft: T.RITUAL.BONUS_SECONDS, bonus: true });
    expect(w.run.waveCount).toBe(0);
    const sites = state(w).sites;
    place(w, 0, sites[0]!.x, sites[0]!.z);
    run(w, seconds(3.5));
    expect(state(w).sites[0]!.progress).toBeCloseTo(3.5 / T.RITUAL.SECONDS_TO_LIGHT, 2);
    expect(state(w).progress).toBeCloseTo(3.5 / T.RITUAL.SECONDS_TO_LIGHT / 3, 2);
    expect(state(w).timeLeft).toBeCloseTo(T.RITUAL.BONUS_SECONDS - 3.5, 1);
    // Just outside: it drains at DECAY of the fill rate.
    place(w, 0, sites[0]!.x + sites[0]!.r + 0.3, sites[0]!.z);
    run(w, seconds(2));
    expect(state(w).sites[0]!.progress).toBeCloseTo((3.5 - 2 * T.RITUAL.DECAY) / T.RITUAL.SECONDS_TO_LIGHT, 2);
    place(w, 0, sites[0]!.x, sites[0]!.z);
    const lit = run(w, seconds(T.RITUAL.SECONDS_TO_LIGHT));
    expect(objectiveEvents(lit)).toEqual(['site:0']);
    expect(state(w).sites[0]).toMatchObject({ progress: 1, lit: true });
    place(w, 0, sites[1]!.x, sites[1]!.z);
    const second = run(w, seconds(T.RITUAL.SECONDS_TO_LIGHT) + 2);
    expect(objectiveEvents(second)).toEqual(['site:1']);
    expect(state(w).sites[0]).toMatchObject({ progress: 1, lit: true });
    expect(of([...lit, ...second], 'spawn').length).toBeGreaterThan(3);
    expect(w.enemies.some((e) => !e.dead)).toBe(true);
    place(w, 0, sites[2]!.x, sites[2]!.z);
    const third = run(w, seconds(T.RITUAL.SECONDS_TO_LIGHT) + 2);
    expect(objectiveEvents(third)).toEqual(['site:2', 'done:true']);
    expect(w.enemies.every((e) => e.dead)).toBe(true);
    expect(state(w)).toMatchObject({ status: 'done', progress: 1, bonus: true });
    run(w, seconds(1.2));
    expectRichDraft(w, true);
    expect(w.getRunState()).toMatchObject({ objectivesDone: 1, objectiveBonuses: 1 });
  });

  it('always ends: after the bonus time the braziers stop cooling, then the fire spreads by itself', () => {
    const { w } = begin('ritual', ['knight', 'mage'], 1);
    const far = { x: 0, z: w.room.d / 2 - 1 };
    const keepAway = (ticks: number): void => {
      for (let i = 0; i < ticks && w.run.phase === 'combat'; i++) {
        // Nobody ever stands in a circle; the heroes just stay alive.
        for (const h of w.heroes) { h.invuln = 1; h.body.x = far.x; h.body.z = far.z; }
        w.step();
      }
    };
    const sites = state(w).sites;
    place(w, 0, sites[0]!.x, sites[0]!.z);
    run(w, seconds(3));
    const warmed = state(w).sites[0]!.progress;
    expect(warmed).toBeGreaterThan(0);
    keepAway(seconds(T.RITUAL.BONUS_SECONDS));
    expect(state(w).bonus).toBe(false);
    const cooled = state(w).sites[0]!.progress;
    expect(cooled).toBeLessThan(warmed);
    // Overtime before the spread: nothing cools any further, nothing fills.
    keepAway(seconds(T.RITUAL.OVERTIME_SPREAD_SECONDS - 5));
    expect(state(w).sites[0]!.progress).toBeCloseTo(cooled, 5);
    expect(state(w).sites[1]!.progress).toBe(0);
    // The spread lights every brazier without a hero in it, and the chamber ends.
    const perBrazier = (T.RITUAL.SECONDS_TO_LIGHT * (1 + OBJECTIVE.RITUAL_SECONDS_PER_EXTRA_HERO)) / T.RITUAL.OVERTIME_SPREAD_RATE;
    keepAway(seconds(perBrazier + 6));
    expect(w.run.phase).not.toBe('combat');
    expect(w.getRunState()).toMatchObject({ objectivesDone: 1, objectiveBonuses: 0 });
  });

  it('more heroes in one circle are faster (a party needs longer per brazier); too slow loses the bonus but not the chamber', () => {
    const { w } = begin('ritual', ['knight', 'mage'], 1);
    const sites = state(w).sites;
    const solo = T.RITUAL.SECONDS_TO_LIGHT * (1 + OBJECTIVE.RITUAL_SECONDS_PER_EXTRA_HERO);
    place(w, 0, sites[0]!.x, sites[0]!.z);
    place(w, 1, sites[1]!.x, sites[1]!.z);
    run(w, seconds(4));
    expect(state(w).sites[0]!.progress).toBeCloseTo(4 / solo, 2);
    expect(state(w).sites[1]!.progress).toBeCloseTo(4 / solo, 2);
    place(w, 1, sites[0]!.x + 0.5, sites[0]!.z);
    const at = state(w).sites[0]!.progress;
    run(w, seconds(2));
    expect(state(w).sites[0]!.progress - at).toBeCloseTo((2 / solo) * (1 + T.RITUAL.EXTRA_HERO_SPEED), 2);
    // A downed hero lights nothing.
    place(w, 0, sites[2]!.x, sites[2]!.z);
    w.hero(0)!.invuln = 0;
    downHero(w, w.hero(0)!);
    place(w, 1, 0, w.room.d / 2 - 1);
    run(w, seconds(2));
    expect(state(w).sites[2]!.progress).toBe(0);
    // Time runs out.
    for (const s of w.run.objective!.sites) s.progress = 0;
    const ev = run(w, seconds(T.RITUAL.BONUS_SECONDS));
    expect(objectiveEvents(ev)).toEqual(['bonusLost']);
    expect(state(w)).toMatchObject({ bonus: false, timeLeft: 0, status: 'active' });
    const mage = w.hero(1)!;
    const end: GameEvent[] = [];
    for (const s of state(w).sites) {
      mage.body.x = s.x;
      mage.body.z = s.z;
      end.push(...run(w, seconds(solo) + 3, (x) => { x.hero(1)!.body.x = s.x; x.hero(1)!.body.z = s.z; }));
    }
    expect(objectiveEvents(end)).toEqual(['site:0', 'site:1', 'site:2', 'done:false']);
    run(w, seconds(1.2));
    expect(w.run.phase).toBe('draft');
    expect(w.getDraft(1)).toHaveLength(RUN.DRAFT_CHOICES);
    expect(w.getRunState()).toMatchObject({ objectivesDone: 1, objectiveBonuses: 0 });
  });
});

describe('vault', () => {
  it('no enemies; a living hero next to the reliquary opens it: heal, Glimmer and a richer draft', () => {
    const { w, ev } = begin('vault', ['knight', 'mage'], 2);
    expect(objectiveEvents(ev)).toEqual(['start']);
    const s = state(w);
    expect(s).toMatchObject({ kind: 'vault', bonus: false, progress: 0, timeLeft: 0, status: 'active', sites: [], targets: [] });
    expect(s.anchor).toMatchObject({ r: OBJECTIVE.VAULT_RADIUS, hp: 1 });
    expect(w.run.waveCount).toBe(0);
    for (const h of w.heroes) h.hp = h.maxHp * 0.5;
    const idle = run(w, seconds(12));
    expect(of(idle, 'spawn')).toEqual([]);
    expect(of(idle, 'wave')).toEqual([]);
    expect(w.enemies).toHaveLength(0);
    expect(state(w).progress).toBe(0);
    // A downed hero does not open it.
    const knight = w.hero(0)!;
    place(w, 0, s.anchor!.x + s.anchor!.r + 0.5, s.anchor!.z);
    place(w, 1, s.anchor!.x + 9, s.anchor!.z);
    run(w, seconds(OBJECTIVE.VAULT_HOLD_SECONDS / 2));
    expect(state(w).progress).toBeCloseTo(0.5, 1);
    // The ring the client draws: anchor.r + OPEN_RADIUS_PAD. Just outside it nothing happens.
    expect(T.VAULT.OPEN_RADIUS_PAD).toBe(1.6);
    place(w, 1, s.anchor!.x + s.anchor!.r + T.VAULT.OPEN_RADIUS_PAD + 0.1, s.anchor!.z);
    // Stepping away loses the progress again.
    place(w, 0, s.anchor!.x + 8, s.anchor!.z);
    run(w, seconds(OBJECTIVE.VAULT_HOLD_SECONDS));
    expect(state(w).progress).toBe(0);
    place(w, 0, s.anchor!.x + s.anchor!.r + 0.5, s.anchor!.z);
    const open = run(w, seconds(OBJECTIVE.VAULT_HOLD_SECONDS) + 2);
    expect(objectiveEvents(open)).toEqual(['done:false']);
    expect(state(w)).toMatchObject({ status: 'done', progress: 1 });
    expect(state(w).anchor!.hp).toBe(1);
    expect(of(open, 'heal').map((h) => h.slot).sort()).toEqual([0, 1]);
    expect(knight.hp).toBeCloseTo(knight.maxHp * (0.5 + T.VAULT.HEAL_FRACTION), 0);
    run(w, seconds(1.2));
    expect(w.run.phase).toBe('draft');
    for (const slot of [0, 1]) {
      expect(w.getDraft(slot)).toHaveLength(RUN.DRAFT_CHOICES + T.VAULT.EXTRA_CHOICES);
      expect(rarities(w, slot).some((r) => r !== 'common')).toBe(true);
    }
    expect(w.director.earnings.glimmer).toBeCloseTo(chamberPay + T.VAULT.GLIMMER, 6);
    // It counts as a special objective, but it has no bonus.
    expect(w.getRunState()).toMatchObject({ objectivesDone: 1, objectiveBonuses: 0, chambersCleared: 1 });
  });
});

describe('rewards', () => {
  it('a bonus pays BONUS_GLIMMER through the run rewards, scaled by depth and Oath like everything else', () => {
    const w = new World();
    w.addPlayer(0, 'knight', 'A');
    w.addPlayer(1, 'mage', 'B');
    const oath = 2;
    w.start(oath, 4, 2, { objective: 'hunt' });
    w.run.depth = 1;
    run(w, seconds(8));
    run(w, seconds(5), slayAll);
    expect(w.run.phase).toBe('draft');
    const earned = (chamberPay + T.BONUS_GLIMMER) * (1 + REWARDS.DEPTH_BONUS);
    expect(w.director.earnings.glimmer).toBeCloseTo(earned, 6);
    // XP is not touched by the bonus.
    const plain = new World();
    plain.addPlayer(0, 'knight', 'A');
    plain.start(oath, 4, 2, { objective: 'slay' });
    plain.run.depth = 1;
    run(plain, seconds(90), slayAll);
    expect(plain.run.phase).toBe('draft');
    expect(w.director.earnings.xp).toBeCloseTo(plain.director.earnings.xp, 6);
    // Fall in the next chamber: the defeat pays it.
    draftAll(w);
    takeDoor(w, 0);
    for (const h of w.heroes) { h.invuln = 0; downHero(w, h); }
    w.step();
    expect(w.run.phase).toBe('defeat');
    const expected = Math.round(earned * (1 + REWARDS.OATH_BONUS * oath));
    expect(expected).toBe(glimmerReward(w.director.earnings, oath, 0, 0));
    expect(w.getRunState().rewards.map((r) => r.glimmer)).toEqual([expected, expected]);
    // The counters survive the end of the run (the summary shows them).
    expect(w.getRunState()).toMatchObject({ objective: null, objectivesDone: 1, objectiveBonuses: 1 });
    w.reset();
    expect(w.getRunState()).toMatchObject({ objectivesDone: 0, objectiveBonuses: 0 });
  });

  it('a cursed chamber with a met bonus offers the cursed four plus one', () => {
    const w = new World();
    w.addPlayer(0, 'knight', 'A');
    w.start(0, 9, 0, { objective: 'hunt' });
    // Walk until a cursed door with the hunt behind it shows up (the pin is on the first door).
    let found = false;
    for (let guard = 0; guard < 6 && !found; guard++) {
      finishChamber(w);
      draftAll(w);
      const doors = w.getRunState().doors;
      const index = doors.findIndex((d) => d.type === 'cursed' && d.objective === 'hunt');
      if (index >= 0) { takeDoor(w, index); found = true; } else takeDoor(w, 0);
    }
    expect(found).toBe(true);
    expect(w.cursed).toBe(true);
    run(w, seconds(8));
    run(w, seconds(5), slayAll);
    expect(w.getDraft(0)).toHaveLength(BOON_TUNING.CURSED_DRAFT_CHOICES + T.BONUS_EXTRA_CHOICES);
  });
});

describe('doors', () => {
  /** Walks a whole depth and returns every door choice with the chamber index it leads to. */
  function walk(seed: number, pick: (doors: Door[]) => number, classes: ClassId[] = ['knight']): { next: number; doors: Door[]; depth: number }[] {
    const w = new World();
    classes.forEach((cls, slot) => w.addPlayer(slot, cls, `P${slot}`));
    w.start(0, seed);
    expect(state(w).kind).toBe('slay');
    const out: { next: number; doors: Door[]; depth: number }[] = [];
    for (let guard = 0; guard < 2 * RUN.CHAMBERS.length + 2; guard++) {
      finishChamber(w);
      if (w.run.phase !== 'draft') break;
      draftAll(w);
      const doors = w.getRunState().doors;
      const boss = w.run.chamberKind === 'boss';
      out.push({ next: boss ? 0 : w.run.chamber + 1, doors, depth: w.run.depth });
      if (boss && w.run.depth >= 1) break;
      const index = boss ? doors.findIndex((d) => d.type === 'descend') : pick(doors);
      takeDoor(w, index);
      expect(state(w).kind).toBe(doors[index]!.objective);
    }
    return out;
  }

  it('every door carries an objective under the rolling rules; all special kinds show up', () => {
    const seen = new Set<ObjectiveKind>();
    let special = 0;
    let rolled = 0;
    for (let seed = 1; seed <= 150; seed++) {
      const choices = walk(seed, (doors) => (seed % 2 === 0 ? doors.length - 1 : 0));
      expect(choices.length).toBeGreaterThanOrEqual(RUN.CHAMBERS.length);
      for (const { next, doors, depth } of choices) {
        const where = `seed ${seed} depth ${depth} -> chamber ${next}`;
        const kind = RUN.CHAMBERS[next];
        for (const d of doors) {
          expect(OBJECTIVE_KINDS, where).toContain(d.objective);
          if (kind !== 'combat' || d.type === 'descend' || d.type === 'ascend' || d.type === 'boss') expect(d.objective, where).toBe('slay');
          expect(OBJECTIVES[d.objective].minChamber, where).toBeLessThanOrEqual(next);
          if (d.type === 'cursed') expect(d.objective, where).not.toBe('vault');
          seen.add(d.objective);
        }
        if (kind === 'combat' && doors.length === 2 && doors[0]!.type !== 'descend') {
          rolled += 2;
          for (const d of doors) if (d.objective !== 'slay') special++;
          if (doors[0]!.objective !== 'slay') expect(doors[1]!.objective, where).not.toBe(doors[0]!.objective);
        }
      }
    }
    expect([...seen].sort()).toEqual([...OBJECTIVE_KINDS].sort());
    // Roughly the share the weights promise (60 % once everything is unlocked, less in chamber 1).
    expect(special / rolled).toBeGreaterThan(0.4);
    expect(special / rolled).toBeLessThan(0.7);
  }, 120000);

  it('at most one vault per depth: once the party has entered one, no door of that depth offers another', () => {
    let vaults = 0;
    let offeredAgain = 0;
    for (let seed = 1; seed <= 90; seed++) {
      const choices = walk(seed, (doors) => Math.max(0, doors.findIndex((d) => d.objective === 'vault')));
      const entered = [0, 0];
      for (const { doors, depth } of choices) {
        const offered = doors.some((d) => d.objective === 'vault');
        if (entered[depth]! > 0 && offered) offeredAgain++;
        if (offered) { entered[depth]!++; vaults++; }
      }
    }
    expect(vaults).toBeGreaterThan(8);
    expect(offeredAgain).toBe(0);
    expect(OBJECTIVE_TUNING.MAX_VAULTS_PER_DEPTH).toBe(1);
  }, 120000);

  it('doors and objectives are a pure function of the seed', () => {
    const key = (seed: number): string => JSON.stringify(walk(seed, () => 0, ['mage', 'rogue']));
    expect(key(42)).toBe(key(42));
    expect(key(42)).not.toBe(key(43));
  });

  it('pinning `slay` gives a classic run; pinning a special objective puts it on the first door where allowed', () => {
    const w = new World();
    w.addPlayer(0, 'knight', 'A');
    w.start(0, 8, 0, { objective: 'slay' });
    for (let i = 0; i < 6; i++) {
      finishChamber(w);
      draftAll(w);
      for (const d of w.getRunState().doors) expect(d.objective).toBe('slay');
      takeDoor(w, 0);
    }
    const v = new World();
    v.addPlayer(0, 'knight', 'A');
    v.start(0, 8, 0, { objective: 'hunt' });
    // Chamber 0 of depth 0 stays slay only when the run really starts there... the pin applies to the start chamber too.
    expect(state(v).kind).toBe('hunt');
    finishChamber(v);
    draftAll(v);
    // Chamber 1: hunt needs chamber 2.
    expect(v.getRunState().doors[0]!.objective).not.toBe('hunt');
    takeDoor(v, 0);
    finishChamber(v);
    draftAll(v);
    const doors = v.getRunState().doors;
    expect(doors[0]!.objective).toBe('hunt');
    expect(doors[1]!.objective).not.toBe('hunt');
  });
});

describe('across depths', () => {
  it('objectives work after a descent: scaled shard, vault count reset, counters keep adding up', () => {
    const w = new World();
    w.addPlayer(0, 'knight', 'A');
    w.start(0, 6, RUN.CHAMBERS.length - 1, { objective: 'defend' });
    finishChamber(w);
    draftAll(w);
    w.director.vaults = 1;
    const down = w.getRunState().doors.findIndex((d) => d.type === 'descend');
    expect(w.getRunState().doors.map((d) => d.objective)).toEqual(['slay', 'slay']);
    takeDoor(w, down);
    expect(w.run.depth).toBe(1);
    expect(w.director.vaults).toBe(0);
    expect(state(w).kind).toBe('slay');
    finishChamber(w);
    draftAll(w);
    const doors = w.getRunState().doors;
    expect(doors[0]!.objective).toBe('defend');
    takeDoor(w, 0);
    expect(state(w).kind).toBe('defend');
    expect(w.director.obj!.anchorMaxHp).toBeCloseTo(T.DEFEND.HP * w.damageMul * T.DEFEND.SOLO_HP_MUL, 6);
    expect(w.damageMul).toBeGreaterThan(1.5);
    finishChamber(w);
    expect(w.getRunState()).toMatchObject({ objectivesDone: 1, objectiveBonuses: 1 });
    expect(TICK_DT).toBeGreaterThan(0);
  });
});
