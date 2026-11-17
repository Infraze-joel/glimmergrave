import { describe, expect, it } from 'vitest';
import { TICK_DT, WORLD } from '@shared/constants.ts';
import { DASH } from '@shared/data/classes.ts';
import { resolveCollisions, startDash, stepMovement, type MoveBody } from '@shared/sim/movement.ts';
import type { RoomLayout } from '@shared/types.ts';

const room = (obstacles: RoomLayout['obstacles'] = []): RoomLayout => ({ seed: 1, w: 20, d: 12, obstacles, spawns: [] });
const body = (x = 0, z = 0, moveSpeed = 6): MoveBody => ({ x, z, dashTime: 0, dashDirX: 0, dashDirZ: 0, rootTime: 0, moveSpeed });

describe('stepMovement', () => {
  it('moves at moveSpeed and normalises diagonal input', () => {
    const a = body();
    for (let i = 0; i < 30; i++) stepMovement(a, 1, 0, TICK_DT, room());
    expect(a.x).toBeCloseTo(6, 5);
    const b = body();
    for (let i = 0; i < 30; i++) stepMovement(b, 1, 1, TICK_DT, room());
    expect(Math.hypot(b.x, b.z)).toBeCloseTo(6, 5);
  });

  it('scales with analogue input below full deflection', () => {
    const a = body();
    for (let i = 0; i < 30; i++) stepMovement(a, 0.5, 0, TICK_DT, room());
    expect(a.x).toBeCloseTo(3, 5);
  });

  it('does not move while rooted and counts the root down', () => {
    const a = body();
    a.rootTime = 0.2;
    for (let i = 0; i < 6; i++) stepMovement(a, 1, 0, TICK_DT, room());
    expect(a.x).toBe(0);
    expect(a.rootTime).toBeCloseTo(0, 6);
    // Float residue of the fixed step may hold the root for one extra tick (same on client and server).
    stepMovement(a, 1, 0, TICK_DT, room());
    stepMovement(a, 1, 0, TICK_DT, room());
    expect(a.x).toBeGreaterThan(0);
    expect(a.rootTime).toBe(0);
  });

  it('keeps the hero inside the walls', () => {
    const a = body(9, 5);
    for (let i = 0; i < 60; i++) stepMovement(a, 1, 1, TICK_DT, room());
    expect(a.x).toBeCloseTo(10 - WORLD.PLAYER_RADIUS, 6);
    expect(a.z).toBeCloseTo(6 - WORLD.PLAYER_RADIUS, 6);
  });

  it('slides around obstacles instead of entering them', () => {
    const r = room([{ x: 3, z: 0.2, r: 1, kind: 'pillar' }]);
    const a = body(0, 0);
    let minDist = Infinity;
    for (let i = 0; i < 90; i++) {
      stepMovement(a, 1, 0, TICK_DT, r);
      minDist = Math.min(minDist, Math.hypot(a.x - 3, a.z - 0.2));
    }
    expect(minDist).toBeGreaterThanOrEqual(1 + WORLD.PLAYER_RADIUS - 1e-6);
    expect(a.x).toBeGreaterThan(5);
  });
});

describe('dash', () => {
  it('covers DASH.SPEED * DASH.DURATION in the move direction and ignores the root', () => {
    const a = body();
    a.rootTime = 1;
    startDash(a, 0, -1, 0);
    expect(a.rootTime).toBe(0);
    expect(a.dashTime).toBe(DASH.DURATION);
    let ticks = 0;
    while (a.dashTime > 0) { stepMovement(a, 1, 0, TICK_DT, room()); ticks++; }
    expect(a.z).toBeCloseTo(-DASH.SPEED * DASH.DURATION, 4);
    expect(a.x).toBe(0);
    expect(ticks).toBe(Math.ceil(DASH.DURATION / TICK_DT - 1e-9));
  });

  it('dashes along the aim when there is no move input', () => {
    const a = body();
    startDash(a, 0.05, 0, Math.PI / 2);
    expect(a.dashDirX).toBeCloseTo(1, 6);
    expect(a.dashDirZ).toBeCloseTo(0, 6);
  });

  it('stops at walls and obstacles', () => {
    const a = body(8, 0);
    startDash(a, 1, 0, 0);
    while (a.dashTime > 0) stepMovement(a, 0, 0, TICK_DT, room());
    expect(a.x).toBeCloseTo(10 - WORLD.PLAYER_RADIUS, 6);
    const r = room([{ x: 3, z: 0, r: 1, kind: 'pillar' }]);
    const b = body(0, 0);
    startDash(b, 1, 0, 0);
    while (b.dashTime > 0) {
      stepMovement(b, 0, 0, TICK_DT, r);
      expect(Math.hypot(b.x - 3, b.z)).toBeGreaterThanOrEqual(1 + WORLD.PLAYER_RADIUS - 1e-6);
    }
  });
});

describe('resolveCollisions', () => {
  it('pushes a circle out of an obstacle along the shortest way', () => {
    const p = resolveCollisions({ x: 0.5, z: 0 }, 0.5, room([{ x: 0, z: 0, r: 1, kind: 'pillar' }]));
    expect(p.x).toBeCloseTo(1.5, 6);
    expect(p.z).toBeCloseTo(0, 6);
  });

  it('handles a circle exactly on the obstacle centre and never returns NaN', () => {
    const p = resolveCollisions({ x: 0, z: 0 }, 0.5, room([{ x: 0, z: 0, r: 1, kind: 'pillar' }]));
    expect(Number.isFinite(p.x) && Number.isFinite(p.z)).toBe(true);
    expect(Math.hypot(p.x, p.z)).toBeGreaterThanOrEqual(1.5 - 1e-6);
  });

  it('clamps to the room rectangle', () => {
    const p = resolveCollisions({ x: 50, z: -50 }, 1, room());
    expect(p).toEqual({ x: 9, z: -5 });
  });
});
