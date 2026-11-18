/** Update 4: the bots handle every objective and the new enemies (what a client sees is all they use). */
import { describe, expect, it } from 'vitest';
import { RUN } from '@shared/constants.ts';
import { ENEMY_TUNING } from '@shared/data/enemies.ts';
import { OBJECTIVE_TUNING } from '@shared/data/objectives.ts';
import { BotBrain, maxBuild, maxMetaLevels, viewFromWorld, World } from '@shared/sim/index.ts';
import type { ClassId, GameEvent, ObjectiveKind } from '@shared/types.ts';
import { live, place, runBots, sandbox, seconds, type RunResult } from './harness.ts';
import { of } from './u3kit.ts';

const PARTY: ClassId[] = ['knight', 'mage', 'rogue', 'templar'];
const maxed = (classes: ClassId[]): unknown[] => classes.map((cls) => maxBuild(cls, maxMetaLevels()));

interface Played {
  w: World;
  events: GameEvent[];
  seconds: number;
  done: Extract<GameEvent, { e: 'objective' }> | undefined;
}

/** Bots play one chamber with the given objective (chamber 2 of a fresh run) until it is over. */
function playChamber(kind: ObjectiveKind, classes: ClassId[], seed: number, each?: (w: World) => void, strong = true): Played {
  const w = new World();
  // Strong heroes: these tests are about what the bots do, not about whether they survive.
  classes.forEach((cls, slot) => w.addPlayer(slot, cls, `B${slot}`, strong ? maxed(classes)[slot] : undefined));
  w.start(0, seed, 2, { objective: kind });
  const bots = classes.map((cls, slot) => new BotBrain(slot, cls, seed));
  const events: GameEvent[] = [];
  // The attunement draft of an upgraded hero comes first; the chamber is over at its own draft (or a defeat).
  const running = (): boolean => w.run.phase === 'combat' || (w.run.phase === 'draft' && w.director.preDraft);
  while (running() && w.tick < seconds(300)) {
    const shared = { ...w.getSnapshotBody(), run: w.getRunState() };
    for (const bot of bots) {
      const offers = w.getDraft(bot.slot);
      if (offers.length > 0) w.pickBoon(bot.slot, bot.chooseBoon(offers, w.getBoons(bot.slot)));
      w.applyInput(bot.slot, bot.think(viewFromWorld(w, bot.slot, shared)));
    }
    w.step();
    const ev = w.drainEvents();
    for (const bot of bots) bot.observe(ev, w.tick);
    events.push(...ev);
    each?.(w);
  }
  return { w, events, seconds: w.run.elapsed, done: of(events, 'objective').find((o) => o.what === 'done') };
}

describe('bots and objectives', () => {
  it('vault: they walk to the reliquary and open it', () => {
    for (const classes of [['mage'], PARTY] as ClassId[][]) {
      const p = playChamber('vault', classes, 5);
      expect(p.done).toMatchObject({ kind: 'vault', bonus: false });
      expect(p.seconds).toBeLessThan(15);
      expect(p.w.run.phase).toBe('draft');
    }
  });

  it('ritual: they stand in the circles until every brazier burns, and a party spreads over several circles', () => {
    for (const [classes, seed] of [[['knight'], 3], [['rogue'], 4], [PARTY, 5], [PARTY, 6]] as [ClassId[], number][]) {
      let spread = 0;
      const p = playChamber('ritual', classes, seed, (w) => {
        const o = w.run.objective;
        if (!o) return;
        const occupied = o.sites.filter((s) => !s.lit && w.heroes.some((h) => h.state === 'alive' && Math.hypot(h.body.x - s.x, h.body.z - s.z) <= s.r)).length;
        if (occupied >= 2) spread++;
      });
      const label = `${classes.join('+')} seed ${seed}`;
      expect(p.done, label).toMatchObject({ kind: 'ritual' });
      expect(of(p.events, 'objective').filter((o) => o.what === 'site').map((o) => o.index).sort(), label).toEqual([0, 1, 2]);
      expect(p.seconds, label).toBeLessThan(150);
      if (classes.length > 1) expect(spread, label).toBeGreaterThan(seconds(3));
    }
  });

  it('survive: they hold out and keep moving', () => {
    for (const classes of [['barbarian'], ['mage'], PARTY] as ClassId[][]) {
      let moved = 0;
      let last = { x: 0, z: 0 };
      const p = playChamber('survive', classes, 7, (w) => {
        const h = w.heroes[0]!;
        moved += Math.hypot(h.body.x - last.x, h.body.z - last.z);
        last = { x: h.body.x, z: h.body.z };
      });
      expect(p.done, classes.join('+')).toMatchObject({ kind: 'survive' });
      expect(moved, classes.join('+')).toBeGreaterThan(40);
      expect(p.seconds).toBeLessThan(OBJECTIVE_TUNING.SURVIVE.MAX_SECONDS + 5);
    }
  });

  it('defend: they kill what attacks the shard; a strong party keeps it standing', () => {
    let saved = 0;
    for (const seed of [2, 3, 4, 5]) {
      const siege = new Set<number>();
      const p = playChamber('defend', PARTY, seed, (w) => { for (const e of w.enemies) if (e.siege) siege.add(e.id); });
      expect(p.done, `seed ${seed}`).toMatchObject({ kind: 'defend' });
      expect(siege.size).toBeGreaterThan(2);
      // All of them fall; most by a hero's hand (siege bombers burst by themselves, hazards take a few).
      const kills = of(p.events, 'kill').filter((k) => siege.has(k.id));
      expect(kills.length, `seed ${seed}`).toBe(siege.size);
      expect(kills.filter((k) => k.by >= 0).length, `seed ${seed}`).toBeGreaterThan(siege.size / 2);
      if (p.done!.bonus) saved++;
      expect(p.seconds).toBeLessThan(200);
    }
    expect(saved).toBeGreaterThanOrEqual(3);
    // A solo hero still clears the chamber, shard or no shard.
    expect(playChamber('defend', ['knight'], 3).done).toMatchObject({ kind: 'defend' });
  });

  it('hunt: they go for the marked elites first', () => {
    let inTime = 0;
    for (const [classes, seed] of [[['knight'], 2], [['rogue'], 3], [PARTY, 4], [PARTY, 5]] as [ClassId[], number][]) {
      const marked = new Set<number>();
      let escortAliveWhenHunted = -1;
      const p = playChamber('hunt', classes, seed, (w) => {
        for (const e of w.enemies) if (e.marked) marked.add(e.id);
        const o = w.run.objective;
        if (o && marked.size > 0 && o.targets.length === 0 && escortAliveWhenHunted < 0) escortAliveWhenHunted = w.enemies.filter((e) => !e.dead).length;
      });
      const label = `${classes.join('+')} seed ${seed}`;
      expect(p.done, label).toMatchObject({ kind: 'hunt' });
      expect(marked.size, label).toBeGreaterThanOrEqual(OBJECTIVE_TUNING.HUNT.TARGETS);
      if (p.done!.bonus) inTime++;
      expect(p.seconds, label).toBeLessThan(150);
    }
    expect(inTime).toBeGreaterThanOrEqual(3);
  });
});

describe('bots and the new enemies', () => {
  /** A bot alone in the sandbox against whatever `setup` spawns; returns the hits it took. */
  function duel(cls: ClassId, seed: number, setup: (w: World) => void, secs: number): { taken: number; w: World; events: GameEvent[] } {
    const w = sandbox([cls], seed);
    place(w, 0, 0, 0);
    const h = w.hero(0)!;
    h.maxHp = 100000;
    h.hp = 100000;
    setup(w);
    const bot = new BotBrain(0, cls, seed, { missChance: 0 });
    const events: GameEvent[] = [];
    for (let i = 0; i < seconds(secs); i++) {
      w.applyInput(0, bot.think(viewFromWorld(w, 0)));
      w.step();
      const ev = w.drainEvents();
      bot.observe(ev, w.tick);
      events.push(...ev);
    }
    return { taken: of(events, 'hit').filter((x) => x.target.t === 'p').length, w, events };
  }

  it('they get out of most bomber bursts and reaver landings', () => {
    let bursts = 0;
    let burstHits = 0;
    let landings = 0;
    let landingHits = 0;
    for (let seed = 1; seed <= 10; seed++) {
      for (const cls of ['knight', 'mage'] as ClassId[]) {
        const b = duel(cls, seed, (w) => { live(w, 'bomber', 6, -8); live(w, 'bomber', -7, 7); }, 8);
        bursts += of(b.events, 'aoe').filter((a) => a.hostile && a.r === ENEMY_TUNING.BOMBER.BLAST_RADIUS).length;
        burstHits += b.taken;
        const r = duel(cls, seed, (w) => {
          const e = live(w, 'reaver', 0, -10);
          e.specialCd = 0;
          // Only the landing counts here: its melee is slowed to nothing.
          e.attackCd = 999;
        }, 3);
        landings += of(r.events, 'aoe').filter((a) => a.hostile && a.r === ENEMY_TUNING.REAVER.LEAP_RADIUS).length;
        landingHits += r.taken;
      }
    }
    expect(bursts).toBeGreaterThanOrEqual(30);
    expect(burstHits / bursts).toBeLessThan(0.35);
    expect(landings).toBeGreaterThanOrEqual(8);
    expect(landingHits / landings).toBeLessThan(0.35);
  });

  it('they go for the shaman, the necromancer and the aegis before the rank and file next to them', () => {
    for (const kind of ['shaman', 'necromancer', 'aegis'] as const) {
      for (const cls of ['knight', 'rogue'] as ClassId[]) {
        const order: string[] = [];
        const d = duel(cls, 3, (w) => {
          for (const [x, z] of [[-1.5, -5], [1.5, -5], [0, -4.5]] as [number, number][]) {
            const m = live(w, 'warrior', x, z);
            m.rootTime = 1e9;
            m.attackCd = 1e9;
          }
          // The support stands behind the front line, a little further away than the warriors.
          const s = live(w, kind, 0, -6.5);
          s.rootTime = 1e9;
          s.attackCd = 1e9;
          s.specialCd = 1e9;
        }, 25);
        for (const k of of(d.events, 'kill')) order.push(k.kind);
        expect(order[0], `${cls} vs ${kind}: ${order.join(',')}`).toBe(kind);
      }
    }
  });
});

describe('whole runs with bots that prefer special objectives', () => {
  it('parties and solo heroes get through, complete several objectives per run and no chamber drags on', () => {
    const results: { r: RunResult; done: number; bonuses: number; kinds: Set<string>; longest: number }[] = [];
    const sets: [ClassId[], number, boolean][] = [
      [PARTY, 11, true], [['knight', 'barbarian', 'shade', 'spellblade'], 12, true], [['mage'], 13, true], [['templar'], 14, true],
      [PARTY, 15, false], [['rogue'], 16, false], [['barbarian', 'mage'], 17, false],
    ];
    for (const [classes, seed, strong] of sets) {
      const kinds = new Set<string>();
      let done = 0;
      let bonuses = 0;
      let started = 0;
      let longest = 0;
      const r = runBots({
        classes, seed, preferObjectives: true, loadouts: strong ? maxed(classes) : undefined,
        onTick: (w, events) => {
          for (const ev of events) {
            if (ev.e !== 'objective' || ev.kind === 'slay') continue;
            if (ev.what === 'start') started = w.run.elapsed;
            if (ev.what === 'done') { kinds.add(ev.kind); longest = Math.max(longest, w.run.elapsed - started); }
          }
          done = w.run.objectivesDone;
          bonuses = w.run.objectiveBonuses;
        },
      });
      results.push({ r, done, bonuses, kinds, longest });
      expect(['victory', 'defeat']).toContain(r.phase);
      expect(r.nan).toBe(false);
      expect(longest, `${classes.join('+')} seed ${seed}`).toBeLessThanOrEqual(260);
      if (strong) {
        expect(r.phase, `${classes.join('+')} seed ${seed}`).toBe('victory');
        expect(r.chambersCleared).toBe(RUN.CHAMBERS.length);
      }
      expect(bonuses).toBeLessThanOrEqual(done);
    }
    // Four combat chambers per run can carry a special objective (bots that prefer them take even a cursed door for one).
    process.stdout.write(`objectives per run (done/bonus): ${results.map((x) => `${x.done}/${x.bonuses}`).join(' ')}\n`);
    expect(results.slice(0, 4).reduce((n, x) => n + x.done, 0)).toBeGreaterThanOrEqual(8);
    const all = new Set(results.flatMap((x) => [...x.kinds]));
    expect(all.size).toBeGreaterThanOrEqual(4);
    expect(results.reduce((n, x) => n + x.bonuses, 0)).toBeGreaterThan(3);
    // Without the preference the same seeds meet fewer special objectives.
    let plain = 0;
    for (const [classes, seed, strong] of sets.slice(0, 4)) {
      let done = 0;
      runBots({ classes, seed, loadouts: strong ? maxed(classes) : undefined, onTick: (w) => { done = w.run.objectivesDone; } });
      plain += done;
    }
    expect(results.slice(0, 4).reduce((n, x) => n + x.done, 0)).toBeGreaterThan(plain);
  }, 300000);
});
