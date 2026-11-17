import { describe, expect, it } from 'vitest';
import { NET, WORLD } from '@shared/constants.ts';
import { encodeSnapshot, encodeSnapshotBody } from '@shared/protocol.ts';
import { spawnProjectile } from '@shared/sim/projectiles.ts';
import type { EnemyKind } from '@shared/types.ts';
import { World } from '@shared/sim/index.ts';
import { Pad, runBots } from './harness.ts';

const report = (text: string): void => { process.stdout.write(`${text}\n`); };

describe('performance', () => {
  it('World.step() with 4 heroes + 48 enemies + 60 projectiles averages well under 1.5 ms', () => {
    const w = new World();
    (['knight', 'barbarian', 'mage', 'rogue'] as const).forEach((cls, slot) => w.addPlayer(slot, cls, `P${slot}`));
    w.startSandbox(9);
    const kinds: EnemyKind[] = ['minion', 'minion', 'minion', 'warrior', 'archer', 'mage'];
    const fill = (): void => {
      let i = w.enemies.length;
      while (w.enemies.filter((e) => !e.dead).length < WORLD.MAX_ENEMIES - 2 && w.enemies.length < WORLD.MAX_ENEMIES) {
        const e = w.spawnEnemy(kinds[i % kinds.length]!, ((i * 37) % 30) - 15, ((i * 53) % 22) - 11);
        if (!e) break;
        e.spawnTime = 0;
        i++;
      }
      if (!w.enemies.some((e) => e.kind === 'regent')) { const b = w.spawnEnemy('regent', 0, -8); if (b) { b.spawnTime = 0; b.hp = b.maxHp = 1e7; } }
      if (!w.enemies.some((e) => e.kind === 'champion')) { const b = w.spawnEnemy('champion', 6, -8); if (b) { b.spawnTime = 0; b.hp = b.maxHp = 1e7; } }
      for (let p = w.projectiles.length; p < 60; p++) {
        spawnProjectile(w, {
          kind: 'hexOrb', x: ((p * 17) % 20) - 10, z: ((p * 29) % 16) - 8, rot: p * 0.7, speed: 9, radius: 0.35, range: 26, damage: 1,
          hostile: true, owner: -1, slot: 'primary', pierce: 0, element: 0, stun: 0, knockback: 0,
        });
      }
    };
    const pads = w.heroes.map((h) => new Pad(w, h.slot));
    const tickOnce = (i: number): void => {
      fill();
      for (const h of w.heroes) { h.hp = h.maxHp; h.state = 'alive'; }
      pads.forEach((pad, s) => pad.send({ moveX: Math.sin(i / 17 + s), moveZ: Math.cos(i / 23 + s), aim: i / 9 + s, aimDist: 6, buttons: i % 40 === 0 ? 7 : 1 }));
      w.step();
      w.drainEvents();
    };
    for (let i = 0; i < 300; i++) tickOnce(i);
    const N = 2000;
    let enemies = 0;
    let projectiles = 0;
    let stepMs = 0;
    for (let i = 0; i < N; i++) {
      fill();
      for (const h of w.heroes) { h.hp = h.maxHp; h.state = 'alive'; }
      pads.forEach((pad, s) => pad.send({ moveX: Math.sin(i / 17 + s), moveZ: Math.cos(i / 23 + s), aim: i / 9 + s, aimDist: 6, buttons: i % 40 === 0 ? 7 : 1 }));
      enemies += w.enemies.length;
      projectiles += w.projectiles.length;
      const t0 = performance.now();
      w.step();
      stepMs += performance.now() - t0;
      w.drainEvents();
    }
    const avg = stepMs / N;
    const body = encodeSnapshotBody(w.getSnapshotBody());
    const frame = encodeSnapshot(w.tick, w.getSelfState(0), body);
    const t1 = performance.now();
    for (let i = 0; i < 2000; i++) encodeSnapshot(w.tick, w.getSelfState(i % 4), encodeSnapshotBody(w.getSnapshotBody()));
    const encodeMs = (performance.now() - t1) / 2000;
    const hz = NET.TICK_HZ / NET.SNAPSHOT_EVERY;
    report(`\nperf: World.step avg ${avg.toFixed(3)} ms (4 heroes, ${(enemies / N).toFixed(0)} enemies, ${(projectiles / N).toFixed(0)} projectiles); `
      + `snapshot ${frame.byteLength} bytes (${w.enemies.length} enemies, ${w.projectiles.length} projectiles) = ${((frame.byteLength * hz) / 1000).toFixed(1)} kB/s per client at ${hz} Hz; `
      + `build+encode ${encodeMs.toFixed(3)} ms`);
    expect(enemies / N).toBeGreaterThanOrEqual(46);
    expect(projectiles / N).toBeGreaterThanOrEqual(60);
    expect(avg).toBeLessThan(1.5);
    expect(frame.byteLength).toBeLessThan(1400);
  });

  it('a real 4-bot run stays small on the wire and cheap per tick', () => {
    let bytes = 0;
    let frames = 0;
    let peak = 0;
    let eventBytes = 0;
    const t0 = performance.now();
    const result = runBots({
      classes: ['knight', 'barbarian', 'mage', 'rogue'], seed: 31337,
      onTick: (w, events) => {
        if (events.length) eventBytes += JSON.stringify({ t: 'ev', tick: w.tick, events }).length;
        if (w.tick % NET.SNAPSHOT_EVERY !== 0) return;
        const size = 24 + encodeSnapshotBody(w.getSnapshotBody()).byteLength;
        bytes += size;
        frames++;
        if (size > peak) peak = size;
      },
    });
    const wall = performance.now() - t0;
    const seconds = result.ticks / NET.TICK_HZ;
    report(`4-bot run: ${result.phase} after ${(seconds / 60).toFixed(1)} min, ${(wall / result.ticks).toFixed(3)} ms per tick incl. 4 bots + encoding; `
      + `snapshots avg ${(bytes / frames).toFixed(0)} B, peak ${peak} B => ${(bytes / seconds / 1000).toFixed(1)} kB/s avg, ${((peak * NET.TICK_HZ) / NET.SNAPSHOT_EVERY / 1000).toFixed(1)} kB/s peak; `
      + `events ${(eventBytes / seconds / 1000).toFixed(1)} kB/s (JSON, unrounded)`);
    expect(wall / result.ticks).toBeLessThan(1.5);
    expect(peak).toBeLessThan(1400);
  }, 60000);
});
