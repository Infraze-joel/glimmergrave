/** Projectiles are swept circles, so fast bolts never tunnel through targets, obstacles or walls. */
import { TICK_DT, WORLD } from '../constants.ts';
import { damageHero, isTargetable, strikeEnemy } from './combat.ts';
import { sweepHit } from './geom.ts';
import type { Enemy, Projectile } from './state.ts';
import type { World } from './world.ts';

export type ProjectileInit = Omit<Projectile, 'id' | 'hit' | 'dead' | 'rot' | 'dirX' | 'dirZ'> & { rot: number };

export function spawnProjectile(w: World, init: ProjectileInit): Projectile | null {
  if (w.projectiles.length >= WORLD.MAX_PROJECTILES) {
    // Hostile shots are simply not fired at the cap; hero shots replace the oldest projectile.
    if (init.hostile) return null;
    w.projectiles.shift();
  }
  const p: Projectile = {
    ...init, id: w.nextProjectileId++, dirX: Math.sin(init.rot), dirZ: Math.cos(init.rot), hit: [], dead: false,
  };
  if (w.nextProjectileId > 0xffff) w.nextProjectileId = 1;
  w.projectiles.push(p);
  return p;
}

const hitT: number[] = [];
const hitE: Enemy[] = [];

/** Parameter t in [0, 1] at which the segment leaves the room or touches an obstacle (1 = free path). */
function blockT(w: World, ax: number, az: number, bx: number, bz: number): number {
  const room = w.room;
  const hx = room.w / 2;
  const hz = room.d / 2;
  let t = 1;
  const dx = bx - ax;
  const dz = bz - az;
  if (bx > hx && dx > 0) t = Math.min(t, (hx - ax) / dx);
  else if (bx < -hx && dx < 0) t = Math.min(t, (-hx - ax) / dx);
  if (bz > hz && dz > 0) t = Math.min(t, (hz - az) / dz);
  else if (bz < -hz && dz < 0) t = Math.min(t, (-hz - az) / dz);
  for (const o of room.obstacles) {
    const s = sweepHit(ax, az, bx, bz, o.x, o.z, o.r);
    if (s >= 0 && s < t) t = s;
  }
  return t < 0 ? 0 : t;
}

function stepFriendly(w: World, p: Projectile, bx: number, bz: number, limit: number): number {
  const owner = w.hero(p.owner);
  if (!owner) {
    p.dead = true;
    return limit;
  }
  hitT.length = 0;
  hitE.length = 0;
  for (const e of w.enemies) {
    if (!isTargetable(e) || p.hit.includes(e.id)) continue;
    const t = sweepHit(p.x, p.z, bx, bz, e.x, e.z, p.radius + e.radius);
    if (t < 0 || t > limit) continue;
    // Insertion sort by t: at most a handful of candidates.
    let i = hitT.length;
    hitT.push(t);
    hitE.push(e);
    while (i > 0 && (hitT[i - 1] as number) > t) {
      hitT[i] = hitT[i - 1] as number;
      hitE[i] = hitE[i - 1] as Enemy;
      i--;
    }
    hitT[i] = t;
    hitE[i] = e;
  }
  for (let i = 0; i < hitE.length; i++) {
    const e = hitE[i] as Enemy;
    const t = hitT[i] as number;
    const fromX = p.x - p.dirX;
    const fromZ = p.z - p.dirZ;
    if (!strikeEnemy(w, owner, e, p.damage, p.slot, { fromX, fromZ, stun: p.stun, knockback: p.knockback })) continue;
    p.hit.push(e.id);
    if (p.pierce > 0) {
      p.pierce--;
    } else {
      p.dead = true;
      return t;
    }
  }
  return limit;
}

function stepHostile(w: World, p: Projectile, bx: number, bz: number, limit: number): number {
  for (const h of w.heroes) {
    if (h.state !== 'alive' || !h.connected || p.hit.includes(h.slot)) continue;
    const t = sweepHit(p.x, p.z, bx, bz, h.body.x, h.body.z, p.radius + WORLD.PLAYER_RADIUS);
    if (t < 0 || t > limit) continue;
    if (damageHero(w, h, p.damage, p.owner)) {
      p.dead = true;
      return t;
    }
    // Dodged with i-frames: this projectile can no longer hit that hero.
    p.hit.push(h.slot);
  }
  return limit;
}

export function stepProjectiles(w: World): void {
  for (const p of w.projectiles) {
    if (p.dead) continue;
    const step = Math.min(p.speed * TICK_DT, p.range);
    const bx = p.x + p.dirX * step;
    const bz = p.z + p.dirZ * step;
    const block = blockT(w, p.x, p.z, bx, bz);
    const t = p.hostile ? stepHostile(w, p, bx, bz, block) : stepFriendly(w, p, bx, bz, block);
    p.x += p.dirX * step * t;
    p.z += p.dirZ * step * t;
    p.range -= step;
    if (block < 1 || p.range <= 1e-6) p.dead = true;
  }
}
