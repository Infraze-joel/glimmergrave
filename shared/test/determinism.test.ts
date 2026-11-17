import { describe, expect, it } from 'vitest';
import { encodeSnapshotBody } from '@shared/protocol.ts';
import { BotBrain, viewFromWorld, World } from '@shared/sim/index.ts';
import type { ClassId } from '@shared/types.ts';

const CLASSES: ClassId[] = ['knight', 'mage', 'rogue', 'barbarian'];

/** Runs `ticks` ticks with bots and returns snapshot bytes at checkpoints plus the final event count. */
function play(seed: number, ticks: number, botSeed = 1): { frames: string[]; events: number; run: string } {
  const world = new World();
  CLASSES.forEach((cls, slot) => world.addPlayer(slot, cls, `B${slot}`));
  world.start(0, seed);
  const bots = CLASSES.map((cls, slot) => new BotBrain(slot, cls, botSeed));
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
    for (const bot of bots) bot.observe(ev, world.tick);
    if (world.tick % 300 === 0 || i === ticks - 1) frames.push(Buffer.from(encodeSnapshotBody(world.getSnapshotBody())).toString('base64'));
  }
  return { frames, events, run: JSON.stringify(world.getRunState()) };
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
