import { describe, expect, it } from 'vitest';
import { encodeSnapshotBody } from '@shared/protocol.ts';
import { applyBoon, BotBrain, viewFromWorld, World } from '@shared/sim/index.ts';
import { OBJECTIVE_KINDS, type ClassId, type ObjectiveKind } from '@shared/types.ts';

const CLASSES: ClassId[] = ['knight', 'mage', 'rogue', 'barbarian'];

/** Runs `ticks` ticks with bots and returns snapshot bytes at checkpoints plus the final event count. */
function play(seed: number, ticks: number, botSeed = 1, objective?: ObjectiveKind): { frames: string[]; events: number; run: string; objectives: string } {
  const world = new World();
  CLASSES.forEach((cls, slot) => world.addPlayer(slot, cls, `B${slot}`));
  world.start(0, seed, objective ? 2 : 0, { objective });
  const bots = CLASSES.map((cls, slot) => new BotBrain(slot, cls, botSeed, { preferObjectives: objective !== undefined }));
  let objectives = '';
  const frames: string[] = [];
  let events = 0;
  for (let i = 0; i < ticks; i++) {
    const phase = world.run.phase;
    if (phase === 'victory' || phase === 'defeat') break;
    for (const bot of bots) {
      if (phase === 'draft') {
        const offers = world.getDraft(bot.slot);
        if (offers.length) world.pickBoon(bot.slot, bot.chooseBoon(offers, world.getBoons(bot.slot)));
      }
      world.applyInput(bot.slot, bot.think(viewFromWorld(world, bot.slot)));
    }
    world.step();
    const ev = world.drainEvents();
    events += ev.length;
    for (const e of ev) if (e.e === 'objective' || e.e === 'dome' || e.e === 'mend' || e.e === 'warded') objectives += `${world.tick}:${JSON.stringify(e)};`;
    if (world.tick % 150 === 0) objectives += JSON.stringify(world.getRunState().objective);
    for (const bot of bots) bot.observe(ev, world.tick);
    if (world.tick % 300 === 0 || i === ticks - 1) frames.push(Buffer.from(encodeSnapshotBody(world.getSnapshotBody())).toString('base64'));
  }
  return { frames, events, run: JSON.stringify(world.getRunState()), objectives };
}

describe('determinism', () => {
  it('same seed + same inputs => identical snapshot bytes, events and run state', () => {
    const a = play(4242, 4500);
    const b = play(4242, 4500);
    expect(a.frames.length).toBeGreaterThan(10);
    expect(b.frames).toEqual(a.frames);
    expect(b.events).toBe(a.events);
    expect(b.run).toBe(a.run);
  });

  it('update 4: every objective replays identically (state, events, doors) from the same seed', () => {
    for (const kind of OBJECTIVE_KINDS) {
      const a = play(977, 3000, 1, kind);
      const b = play(977, 3000, 1, kind);
      expect(a.objectives.length, kind).toBeGreaterThan(50);
      expect(a.objectives).toContain(`"kind":"${kind}"`);
      expect(b.objectives, kind).toBe(a.objectives);
      expect(b.frames, kind).toEqual(a.frames);
      expect(b.run, kind).toBe(a.run);
      expect(b.events, kind).toBe(a.events);
    }
  }, 120000);

  it('update 5: a party holding eight keystones (blooms, bounces, arcs, twins, companions) replays identically, drafts included', () => {
    const grant: Record<number, string[]> = {
      0: ['corpse_bloom', 'twin_cast'], 1: ['ricochet', 'chain_lightning'], 2: ['familiar', 'sanguine'], 3: ['orbit_blades', 'ember_wake'],
    };
    const replay = (): { procs: string; frames: string[]; run: string } => {
      const world = new World();
      CLASSES.forEach((cls, slot) => world.addPlayer(slot, cls, `B${slot}`));
      world.start(0, 5150, 2);
      for (const h of world.heroes) {
        applyBoon(h, 'infuse_ember_primary');
        applyBoon(h, 'infuse_rime_secondary');
        for (const id of grant[h.slot] ?? []) expect(world.grantKeystone(h.slot, id)).toBe(true);
      }
      const bots = CLASSES.map((cls, slot) => new BotBrain(slot, cls, 3));
      let procs = '';
      const frames: string[] = [];
      for (let i = 0; i < 5400; i++) {
        const phase = world.run.phase;
        if (phase === 'victory' || phase === 'defeat') break;
        for (const bot of bots) {
          if (phase === 'draft') {
            for (let step = 0; step < 2; step++) {
              const offers = world.getDraft(bot.slot);
              if (offers.length === 0) break;
              const ks = world.getKeystoneDraft(bot.slot);
              if (!ks) { world.pickBoon(bot.slot, bot.chooseBoon(offers, world.getBoons(bot.slot))); break; }
              const choice = bot.chooseKeystone(offers, ks.held, ks.skip, world.getBoons(bot.slot));
              world.pickBoon(bot.slot, choice.index, choice.replace);
            }
          }
          world.applyInput(bot.slot, bot.think(viewFromWorld(world, bot.slot)));
        }
        world.step();
        const ev = world.drainEvents();
        for (const e of ev) if (e.e === 'keystoneProc' || e.e === 'keystone') procs += `${world.tick}:${JSON.stringify(e)};`;
        for (const bot of bots) bot.observe(ev, world.tick);
        if (world.tick % 300 === 0) frames.push(Buffer.from(encodeSnapshotBody(world.getSnapshotBody())).toString('base64'));
      }
      return { procs, frames, run: JSON.stringify(world.getRunState()) };
    };
    const a = replay();
    const b = replay();
    for (const id of ['corpse_bloom', 'ricochet', 'chain_lightning', 'familiar', 'ember_wake']) expect(a.procs, id).toContain(`"id":"${id}"`);
    expect(b.procs).toBe(a.procs);
    expect(b.frames).toEqual(a.frames);
    expect(b.run).toBe(a.run);
  }, 120000);

  it('a different seed produces a different run', () => {
    const a = play(4242, 900);
    const b = play(4243, 900);
    expect(b.frames).not.toEqual(a.frames);
  });

  it('the simulation never calls Math.random', () => {
    const original = Math.random;
    let calls = 0;
    Math.random = () => { calls++; return original(); };
    try {
      play(99, 1500);
    } finally {
      Math.random = original;
    }
    expect(calls).toBe(0);
  });

  it('reset + start with the same seed replays the same run on a reused World', () => {
    const world = new World();
    world.addPlayer(0, 'knight', 'A');
    const run = (): string => {
      world.start(0, 777);
      for (let i = 0; i < 600; i++) {
        world.applyInput(0, { seq: i + 1, moveX: Math.sin(i / 20), moveZ: -1, aim: i / 10, aimDist: 5, buttons: i % 3 === 0 ? 1 : 2 });
        world.step();
      }
      world.drainEvents();
      const bytes = Buffer.from(encodeSnapshotBody(world.getSnapshotBody())).toString('base64');
      world.reset();
      return bytes;
    };
    expect(run()).toBe(run());
  });
});
