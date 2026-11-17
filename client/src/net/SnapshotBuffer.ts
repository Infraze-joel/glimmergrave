/**
 * Buffers authoritative snapshots and produces an interpolated frame a fixed delay in the past, so remote
 * entities move smoothly regardless of network jitter. No extrapolation: if the buffer runs dry the last
 * known state is held.
 */
import { NET } from '@shared/constants.ts';
import type { EnemySnap, PlayerSnap, ProjectileSnap, Snapshot } from '@shared/types.ts';

const TICK_MS = 1000 / NET.TICK_HZ;
const MAX_BUFFERED = 20;
/** Jumps larger than this (chamber change, blink) snap instead of sliding. */
const SNAP_DISTANCE = 5;
/** How quickly the clock offset follows rising latency (falling latency is adopted immediately). */
const OFFSET_RISE_RATE = 0.02;
const TAU = Math.PI * 2;

export interface Frame {
  players: PlayerSnap[];
  enemies: EnemySnap[];
  projectiles: ProjectileSnap[];
}

interface Positioned { x: number; z: number; rot: number }

function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU; else if (d < -Math.PI) d += TAU;
  return a + d * t;
}

export class SnapshotBuffer {
  private snaps: Snapshot[] = [];
  /** Smoothed (local receive time − server time). NaN until the first snapshot. */
  private offset = Number.NaN;
  private readonly frame: Frame = { players: [], enemies: [], projectiles: [] };
  private readonly prevPlayers = new Map<number, PlayerSnap>();
  private readonly prevEnemies = new Map<number, EnemySnap>();
  private readonly prevProjectiles = new Map<number, ProjectileSnap>();

  clear(): void {
    this.snaps.length = 0;
    this.offset = Number.NaN;
    this.frame.players.length = 0;
    this.frame.enemies.length = 0;
    this.frame.projectiles.length = 0;
  }

  latest(): Snapshot | null {
    return this.snaps.length > 0 ? this.snaps[this.snaps.length - 1] : null;
  }

  push(snap: Snapshot, now: number): void {
    const last = this.latest();
    if (last && snap.tick <= last.tick) {
      // Tick counter went backwards: the server started a fresh world. Start over.
      this.clear();
    }
    this.snaps.push(snap);
    if (this.snaps.length > MAX_BUFFERED) this.snaps.shift();
    const sample = now - snap.tick * TICK_MS;
    if (Number.isNaN(this.offset) || sample < this.offset) this.offset = sample;
    else this.offset += (sample - this.offset) * OFFSET_RISE_RATE;
  }

  /** Interpolated state for rendering at local time `now`. The returned arrays/rows are reused every call. */
  sample(now: number): Frame {
    const snaps = this.snaps;
    const frame = this.frame;
    if (snaps.length === 0) return frame;
    const renderTick = (now - this.offset - NET.INTERP_DELAY_MS) / TICK_MS;

    let i = snaps.length - 1;
    while (i > 0 && snaps[i].tick > renderTick) i--;
    const a = snaps[i];
    const b = i + 1 < snaps.length ? snaps[i + 1] : a;
    const span = b.tick - a.tick;
    const t = span > 0 ? Math.min(1, Math.max(0, (renderTick - a.tick) / span)) : 0;

    this.blend(a.players, b.players, t, frame.players, this.prevPlayers, (p) => p.slot);
    this.blend(a.enemies, b.enemies, t, frame.enemies, this.prevEnemies, (e) => e.id);
    this.blend(a.projectiles, b.projectiles, t, frame.projectiles, this.prevProjectiles, (p) => p.id);
    return frame;
  }

  private blend<T extends Positioned>(from: T[], to: T[], t: number, out: T[], index: Map<number, T>, key: (row: T) => number): void {
    index.clear();
    for (const row of from) index.set(key(row), row);
    // Rows that exist only in `from` are dropped as soon as interpolation toward `to` starts; rows that
    // exist only in `to` appear at their first known position.
    const source = t > 0 ? to : from;
    out.length = source.length;
    for (let n = 0; n < source.length; n++) {
      const target = source[n];
      const start = index.get(key(target));
      const row = (out[n] ??= { ...target });
      Object.assign(row, target);
      if (start && t > 0 && t < 1) {
        const dx = target.x - start.x;
        const dz = target.z - start.z;
        if (dx * dx + dz * dz < SNAP_DISTANCE * SNAP_DISTANCE) {
          row.x = start.x + dx * t;
          row.z = start.z + dz * t;
          row.rot = lerpAngle(start.rot, target.rot, t);
        }
      }
    }
  }
}
