import { describe, expect, it } from 'vitest';
import { RUN, TICK_DT, WORLD } from '@shared/constants.ts';
import { CLASSES } from '@shared/data/classes.ts';
import { SIM, World } from '@shared/sim/index.ts';
import { damageHero } from '@shared/sim/combat.ts';
import { PF } from '@shared/types.ts';
import { clearChamber, live, Pad, place, sandbox, seconds, stepN } from './harness.ts';

const down = (w: World, slot: number): void => {
  const h = w.hero(slot)!;
  h.invuln = 0;
  damageHero(w, h, 99999, -1);
};

describe('downed and revive', () => {
  it('a hero at 0 health is downed, cannot act or be hurt, and emits `down`', () => {
    const w = sandbox(['knight', 'mage']);
    w.drainEvents();
    down(w, 1);
    expect(w.drainEvents()).toContainEqual({ e: 'down', slot: 1 });
    const snap = w.getSnapshotBody().players[1]!;
    expect(snap.state).toBe('downed');
    expect(snap.hp).toBe(0);
    expect(snap.anim).toBe('downed');
    expect(w.getRunState().stats[1]!.downs).toBe(1);
    const x = w.hero(1)!.body.x;
    const pad = new Pad(w, 1);
    const ev = pad.hold({ moveX: 1, buttons: 7 }, seconds(1));
    expect(w.hero(1)!.body.x).toBe(x);
    expect(ev.filter((e) => e.e === 'cast')).toHaveLength(0);
    expect(w.getSelfState(1).moveSpeed).toBe(0);
    expect(damageHero(w, w.hero(1)!, 10, -1)).toBe(false);
  });

  it('an ally within REVIVE_RADIUS revives in REVIVE_SECONDS; progress shows in the snapshot', () => {
    const w = sandbox(['knight', 'mage']);
    place(w, 0, 0, 0);
    place(w, 1, 5, 0);
    down(w, 1);
    stepN(w, seconds(1));
    expect(w.getSnapshotBody().players[1]!.revive).toBe(0);
    expect(w.getSnapshotBody().players[1]!.flags & PF.BEING_REVIVED).toBeFalsy();
    place(w, 0, 5 - WORLD.REVIVE_RADIUS + 0.1, 0);
    w.drainEvents();
    stepN(w, seconds(WORLD.REVIVE_SECONDS / 2));
    const mid = w.getSnapshotBody().players[1]!;
    expect(mid.revive).toBeCloseTo(0.5, 1);
    expect(mid.flags & PF.BEING_REVIVED).toBeTruthy();
    expect(mid.state).toBe('downed');
    const ev = stepN(w, seconds(WORLD.REVIVE_SECONDS / 2) + 2);
    expect(ev).toContainEqual({ e: 'revived', slot: 1, by: 0 });
    const mage = w.hero(1)!;
    expect(mage.state).toBe('alive');
    expect(mage.hp).toBe(Math.round(CLASSES.mage.maxHp * WORLD.REVIVE_HP_FRACTION));
    expect(w.getRunState().stats[0]!.revives).toBe(1);
    expect(w.getSnapshotBody().players[1]!.flags & PF.INVULNERABLE).toBeTruthy();
  });

  it('progress decays when the ally leaves and no revive happens from outside the radius', () => {
    const w = sandbox(['knight', 'mage']);
    place(w, 0, 1, 0);
    place(w, 1, 0, 0);
    down(w, 1);
    stepN(w, seconds(1.5));
    const reached = w.hero(1)!.revive;
    expect(reached).toBeGreaterThan(0.4);
    place(w, 0, WORLD.REVIVE_RADIUS + 0.2, 0);
    stepN(w, seconds(0.5));
    expect(w.hero(1)!.revive).toBeCloseTo(reached - SIM.REVIVE_DECAY_PER_SECOND * 0.5, 2);
    stepN(w, seconds(3));
    expect(w.hero(1)!.revive).toBe(0);
    expect(w.hero(1)!.state).toBe('downed');
  });

  it('a downed or disconnected ally cannot revive', () => {
    const w = sandbox(['knight', 'mage', 'rogue']);
    place(w, 0, 0, 0);
    place(w, 1, 0.5, 0);
    place(w, 2, 12, 0);
    down(w, 0);
    down(w, 1);
    stepN(w, seconds(WORLD.REVIVE_SECONDS + 1));
    expect(w.hero(0)!.state).toBe('downed');
    expect(w.hero(1)!.state).toBe('downed');
    place(w, 2, 0.2, 0);
    w.setConnected(2, false);
    w.addPlayer(3, 'knight', 'late');
    stepN(w, seconds(WORLD.REVIVE_SECONDS + 1));
    expect(w.hero(0)!.state).toBe('downed');
  });
});

describe('run rules around downed heroes', () => {
  const start = (classes: ('knight' | 'mage' | 'rogue')[], seed = 3): World => {
    const w = new World();
    classes.forEach((cls, slot) => w.addPlayer(slot, cls, `P${slot}`));
    expect(w.start(0, seed)).toBe(true);
    return w;
  };

  it('solo: one Second Wind per run, then defeat', () => {
    const w = start(['knight']);
    expect(w.getRunState().secondWinds).toBe(RUN.SOLO_SECOND_WINDS);
    stepN(w, 5);
    down(w, 0);
    expect(w.getRunState().secondWinds).toBe(RUN.SOLO_SECOND_WINDS - 1);
    stepN(w, 3);
    expect(w.run.phase).toBe('combat');
    const ev = stepN(w, seconds(SIM.SECOND_WIND_DELAY) + 2);
    expect(ev).toContainEqual({ e: 'revived', slot: 0, by: 0 });
    expect(w.hero(0)!.state).toBe('alive');
    expect(w.hero(0)!.hp).toBe(Math.round(CLASSES.knight.maxHp * WORLD.REVIVE_HP_FRACTION));
    down(w, 0);
    stepN(w, 2);
    expect(w.run.phase).toBe('defeat');
    expect(w.getRunState().phase).toBe('defeat');
  });

  it('party: no Second Wind; defeat only when every hero is down at once', () => {
    const w = start(['knight', 'mage']);
    expect(w.getRunState().secondWinds).toBe(0);
    stepN(w, 5);
    down(w, 0);
    stepN(w, seconds(1));
    expect(w.run.phase).toBe('combat');
    const version = w.runVersion;
    down(w, 1);
    stepN(w, 2);
    expect(w.run.phase).toBe('defeat');
    expect(w.runVersion).toBeGreaterThan(version);
    // The world is frozen after the end: nothing moves, nobody gets up.
    const tickBefore = w.tick;
    stepN(w, seconds(5));
    expect(w.tick).toBeGreaterThan(tickBefore);
    expect(w.heroes.every((h) => h.state === 'downed')).toBe(true);
    expect(w.run.phase).toBe('defeat');
  });

  it('clearing the chamber revives downed heroes', () => {
    const w = start(['knight', 'mage']);
    stepN(w, 5);
    down(w, 1);
    w.drainEvents();
    clearChamber(w);
    const ev = w.drainEvents();
    expect(ev).toContainEqual({ e: 'chamberClear' });
    expect(ev).toContainEqual({ e: 'revived', slot: 1, by: -1 });
    expect(w.hero(1)!.state).toBe('alive');
    expect(w.hero(1)!.hp).toBe(Math.round(CLASSES.mage.maxHp * WORLD.REVIVE_HP_FRACTION));
  });

  it('removing the last standing hero mid-run ends the run for the rest', () => {
    const w = start(['knight', 'mage']);
    stepN(w, 5);
    down(w, 1);
    w.removePlayer(0);
    expect(w.run.phase).toBe('defeat');
  });
});

describe('disconnected heroes', () => {
  it('stand still, are invulnerable, are not targeted and keep their slot', () => {
    const w = sandbox(['knight', 'mage']);
    place(w, 0, -8, 0);
    place(w, 1, 8, 0);
    const pad = new Pad(w, 1);
    pad.hold({ moveX: -1, buttons: 1 }, 5);
    w.setConnected(1, false);
    const minion = live(w, 'minion', 7, 0);
    const x = w.hero(1)!.body.x;
    w.applyInput(1, { seq: 99, moveX: 1, moveZ: 0, aim: 0, aimDist: 0, buttons: 1 });
    const ev = stepN(w, seconds(4));
    const snap = w.getSnapshotBody().players[1]!;
    expect(snap.flags & PF.CONNECTED).toBeFalsy();
    expect(snap.flags & PF.INVULNERABLE).toBeTruthy();
    expect(w.hero(1)!.body.x).toBe(x);
    expect(w.hero(1)!.hp).toBe(CLASSES.mage.maxHp);
    expect(damageHero(w, w.hero(1)!, 10, -1)).toBe(false);
    expect(ev.filter((e) => e.e === 'cast' && e.who.t === 'p' && e.who.id === 1)).toHaveLength(0);
    // The minion walked past the idle mage towards the connected knight.
    expect(minion.target).toBe(0);
    expect(minion.x).toBeLessThan(0);
    w.setConnected(1, true);
    expect(w.getSnapshotBody().players[1]!.flags & PF.CONNECTED).toBeTruthy();
    expect(w.getSelfState(1).ackSeq).toBe(0);
  });

  it('the world pauses while every hero is disconnected and resumes afterwards', () => {
    const w = sandbox(['knight']);
    place(w, 0, 0, 0);
    const minion = live(w, 'minion', 6, 0);
    w.setConnected(0, false);
    expect(w.paused).toBe(true);
    const tick = w.tick;
    const x = minion.x;
    stepN(w, seconds(3));
    expect(w.tick).toBe(tick);
    expect(minion.x).toBe(x);
    w.setConnected(0, true);
    stepN(w, seconds(0.5));
    expect(w.tick).toBe(tick + seconds(0.5));
    expect(minion.x).toBeLessThan(x);
  });

  it('a run is lost when every connected hero is down, even if a disconnected one still stands', () => {
    const w = new World();
    w.addPlayer(0, 'knight', 'A');
    w.addPlayer(1, 'mage', 'B');
    w.start(0, 9);
    stepN(w, 5);
    w.setConnected(1, false);
    down(w, 0);
    stepN(w, 2);
    expect(w.run.phase).toBe('defeat');
  });

  it('elapsed time only advances while the world runs', () => {
    const w = new World();
    w.addPlayer(0, 'knight', 'A');
    w.start(0, 9);
    stepN(w, seconds(2));
    expect(w.getRunState().elapsed).toBeCloseTo(2, 3);
    w.setConnected(0, false);
    stepN(w, seconds(2));
    expect(w.getRunState().elapsed).toBeCloseTo(2, 3);
    expect(TICK_DT).toBeCloseTo(1 / 30, 9);
  });
});
