/** Projectiles are swept circles, so fast bolts never tunnel through targets, obstacles or walls. */
import { TICK_DT, WORLD } from '../constants.ts';
import { damageHero, isTargetable, strikeEnemy, type StrikeOpts } from './combat.ts';
import { blocksShots } from './fixtures.ts';
import { angleDiff, inArc, segDist, sweepHit } from './geom.ts';
import type { Enemy, Hero, Projectile } from './state.ts';
import { SIM } from './tuning.ts';
import type { World } from './world.ts';

export type ProjectileInit = Omit<Projectile, 'id' | 'hit' | 'dead' | 'rot' | 'dirX' | 'dirZ' | 'homing' | 'seek' | 'fragile' | 'only' | 'bonus'>
  & { rot: number; homing?: number; seek?: number; fragile?: boolean; only?: number; bonus?: number };

export function spawnProjectile(w: World, init: ProjectileInit): Projectile | null {
  if (w.projectiles.length >= WORLD.MAX_PROJECTILES) {
    // Hostile shots are simply not fired at the cap; hero shots replace the oldest projectile.
    if (init.hostile) return null;
    w.projectiles.shift();
  }
  const p: Projectile = {
    ...init, id: w.nextProjectileId++, dirX: Math.sin(init.rot), dirZ: Math.cos(init.rot), hit: [], dead: false,
    homing: init.homing ?? 0, seek: init.seek ?? -1, fragile: init.fragile === true, only: init.only ?? -1, bonus: init.bonus ?? 0,
  };
  if (w.nextProjectileId > 0xffff) w.nextProjectileId = 1;
  w.projectiles.push(p);
  return p;
}

const hitT: number[] = [];
/** Reused strike options (projectile hits are the hottest strike path). */
const STRIKE: StrikeOpts = { fromX: 0, fromZ: 0, stun: 0, knockback: 0, special: null, bonus: 0, poison: false };
const hitE: Enemy[] = [];

// ---------------------------------------------------------------- fragile hostile projectiles (soul wisps)

function pop(w: World, q: Projectile, by: number): void {
  q.dead = true;
  w.emit({ e: 'cast', who: { t: 'p', id: by }, ability: 'wisp_pop', x: q.x, z: q.z, rot: q.rot });
}

/** Destroys fragile hostile projectiles inside a circle. */
export function popFragileCircle(w: World, by: number, x: number, z: number, r: number): void {
  for (const q of w.projectiles) {
    if (!q.fragile || q.dead || !q.hostile) continue;
    const reach = r + q.radius + SIM.WISP_HIT_PAD;
    const dx = q.x - x;
    const dz = q.z - z;
    if (dx * dx + dz * dz <= reach * reach) pop(w, q, by);
  }
}

/** Destroys fragile hostile projectiles inside a melee arc. */
export function popFragileArc(w: World, by: number, x: number, z: number, rot: number, reach: number, arc: number): void {
  for (const q of w.projectiles) {
    if (!q.fragile || q.dead || !q.hostile) continue;
    if (inArc(x, z, rot, reach, arc, q.x, q.z, q.radius + SIM.WISP_HIT_PAD)) pop(w, q, by);
  }
}

/** Destroys fragile hostile projectiles within `r` of a path segment (lunges, infused dashes, hero projectiles). */
export function popFragileSegment(w: World, by: number, ax: number, az: number, bx: number, bz: number, r: number): boolean {
  let any = false;
  for (const q of w.projectiles) {
    if (!q.fragile || q.dead || !q.hostile) continue;
    if (segDist(ax, az, bx, bz, q.x, q.z) > r + q.radius + SIM.WISP_HIT_PAD) continue;
    pop(w, q, by);
    any = true;
  }
  return any;
}

/** Turns a homing projectile towards its quarry (the hero it seeks, else the nearest living one). */
function steerHoming(w: World, p: Projectile): void {
  let target: Hero | null = null;
  const sought = w.hero(p.seek);
  if (sought && sought.state === 'alive' && sought.connected) {
    target = sought;
  } else {
    let best = Infinity;
    for (const h of w.heroes) {
      if (h.state !== 'alive' || !h.connected) continue;
      const dx = h.body.x - p.x;
      const dz = h.body.z - p.z;
      const d = dx * dx + dz * dz;
      if (d < best) { best = d; target = h; }
    }
  }
  if (!target) return;
  const want = Math.atan2(target.body.x - p.x, target.body.z - p.z);
  const max = p.homing * TICK_DT;
  const diff = angleDiff(want, p.rot);
  p.rot += diff > max ? max : diff < -max ? -max : diff;
  p.dirX = Math.sin(p.rot);
  p.dirZ = Math.cos(p.rot);
}

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
    if (!blocksShots(o)) continue;
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
    if (!isTargetable(e) || p.hit.includes(e.id) || (p.only >= 0 && e.id !== p.only)) continue;
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
  // A hero projectile that touches a soul wisp destroys it (and is spent unless it pierces).
  if (w.fragileCount > 0 && popFragileSegment(w, p.owner, p.x, p.z, p.x + (bx - p.x) * limit, p.z + (bz - p.z) * limit, p.radius)) {
    if (p.pierce > 0) p.pierce--;
    else if (hitE.length === 0) { p.dead = true; return limit; }
  }
  for (let i = 0; i < hitE.length; i++) {
    const e = hitE[i] as Enemy;
    const t = hitT[i] as number;
    const fromX = p.x - p.dirX;
    const fromZ = p.z - p.dirZ;
    STRIKE.fromX = fromX;
    STRIKE.fromZ = fromZ;
    STRIKE.stun = p.stun;
    STRIKE.knockback = p.knockback;
    STRIKE.bonus = p.bonus;
    STRIKE.poison = p.kind === 'crossbowBolt' || p.kind === 'knife';
    if (!strikeEnemy(w, owner, e, p.damage, p.slot, STRIKE)) continue;
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
    if (damageHero(w, h, p.damage, p.owner) && p.pierce <= 0) {
      p.dead = true;
      return t;
    }
    // Dodged with i-frames (or pierced by a spear): this projectile can no longer hit that hero.
    p.hit.push(h.slot);
  }
  return limit;
}

export function stepProjectiles(w: World): void {
  let fragile = 0;
  for (const p of w.projectiles) if (p.fragile && !p.dead) fragile++;
  w.fragileCount = fragile;
  for (const p of w.projectiles) {
    if (p.dead) continue;
    if (p.homing > 0) steerHoming(w, p);
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
