/**
 * The five rank-and-file kinds of update 4 (behaviour summary above ENEMIES in data/enemies.ts):
 *  shaman      – mends wounded enemies with an interruptible channel, else throws a weak hex bolt
 *  aegis       – ward dome that shields OTHER enemies; drops while it is stunned, staggered or dead
 *  bomber      – fuse and burst; bursts again (delayed, announced) when slain
 *  necromancer – raises minions that crumble with it
 *  reaver      – leaps onto the hero furthest from the fight, then quick melee
 * Same fairness rule as enemies.ts: whatever hurts a hero is announced with a `telegraph` first.
 */
import { WORLD } from '../constants.ts';
import { ENEMY_TUNING } from '../data/enemies.ts';
import type { EnemyKind } from '../types.ts';
import { damageHero, enemyDamage, isBoss, isTargetable, killEnemy, rawDamageEnemy } from './combat.ts';
import {
  beginAttack, enemySpeed, hasLineOfSight, isTargetHero, keepDistance, landAttack, livingEnemies, rayLength, setAnim, spawnEnemy,
  steer, stepMelee, type TargetLike,
} from './enemies.ts';
import { angleTo, TAU } from './geom.ts';
import { resolveCollisions } from './movement.ts';
import { damageAnchor, standingAnchor } from './objectives.ts';
import { spawnProjectile } from './projectiles.ts';
import type { Enemy, EnemyAttack, Hero } from './state.ts';
import { AI, SIM } from './tuning.ts';
import type { World } from './world.ts';

const SH = ENEMY_TUNING.SHAMAN;
const AE = ENEMY_TUNING.AEGIS;
const BO = ENEMY_TUNING.BOMBER;
const NE = ENEMY_TUNING.NECROMANCER;
const RE = ENEMY_TUNING.REAVER;

const HORDE_KINDS: ReadonlySet<EnemyKind> = new Set<EnemyKind>(['shaman', 'aegis', 'bomber', 'necromancer', 'reaver']);
export const isHorde = (kind: EnemyKind): boolean => HORDE_KINDS.has(kind);

/** Kinds that help the others instead of fighting: a wave never consists of them alone. */
export const SUPPORT_KINDS: ReadonlySet<EnemyKind> = new Set<EnemyKind>(['shaman', 'aegis', 'necromancer']);

/** Seconds before a freshly risen enemy may use its special for the first time. */
export function firstSpecial(kind: EnemyKind): number {
  if (kind === 'shaman') return AI.SHAMAN.FIRST_MEND;
  if (kind === 'necromancer') return AI.NECROMANCER.FIRST_RAISE;
  if (kind === 'reaver') return AI.REAVER.FIRST_LEAP;
  return 0;
}

const castEvent = (w: World, e: Enemy, ability: string, x: number, z: number): void => {
  w.emit({ e: 'cast', who: { t: 'e', id: e.id }, ability, x, z, rot: e.rot });
};

// ---------------------------------------------------------------------------------------------- shaman

/** Can this enemy be mended by a shaman at all? (Never itself, bosses, corpses, enemies that are still rising or that were mended MAX_MENDS times.) */
const mendable = (e: Enemy, o: Enemy): boolean => o !== e && isTargetable(o) && !isBoss(o) && o.mends < AI.SHAMAN.MAX_MENDS;

/** The most wounded mendable enemy below MEND_BELOW, anywhere in the room. */
function mostWounded(w: World, e: Enemy): Enemy | null {
  let best: Enemy | null = null;
  let bestHp: number = SH.MEND_BELOW;
  for (const o of w.enemies) {
    if (!mendable(e, o)) continue;
    const f = o.hp / o.maxHp;
    if (f < bestHp) { bestHp = f; best = o; }
  }
  return best;
}

function stepShaman(w: World, e: Enemy, target: TargetLike, dt: number): void {
  const wounded = e.specialCd <= AI.SHAMAN.MEND_SOON ? mostWounded(w, e) : null;
  if (wounded) {
    const d = Math.hypot(wounded.x - e.x, wounded.z - e.z);
    if (e.specialCd <= 0 && d <= SH.MEND_RADIUS) {
      e.rot = angleTo(e.x, e.z, wounded.x, wounded.z);
      // An interrupted channel may be tried again after part of the cooldown.
      e.specialCd = SH.MEND_COOLDOWN * SIM.STAGGER_COOLDOWN_FRACTION;
      beginAttack(w, e, { type: 'mend', t: SH.MEND_WINDUP, x: e.x, z: e.z, rot: e.rot, r: SH.MEND_RADIUS, w: 0, damage: 0, target: -1 }, null, 'cast');
      castEvent(w, e, 'mend', e.x, e.z);
      return;
    }
    if (d > SH.MEND_RADIUS * AI.SHAMAN.MEND_APPROACH) {
      // Close in on the wounded so the channel can reach them.
      steer(w, e, wounded.x, wounded.z, enemySpeed(e), 1);
      setAnim(e, 'move');
      e.rot = angleTo(e.x, e.z, wounded.x, wounded.z);
      return;
    }
  }
  const tx = target.body.x;
  const tz = target.body.z;
  const d = Math.hypot(tx - e.x, tz - e.z);
  if (e.attackCd <= 0 && d <= e.def.attackRange && hasLineOfSight(w, e.x, e.z, tx, tz, AI.ORB_RADIUS)) {
    const rot = angleTo(e.x, e.z, tx, tz);
    e.rot = rot;
    const length = rayLength(w, e.x, e.z, rot, AI.SHAMAN.BOLT_RANGE, true);
    beginAttack(w, e, { type: 'bolt', t: e.def.windup, x: e.x, z: e.z, rot, r: length, w: AI.SHAMAN.BOLT_TELEGRAPH_WIDTH, damage: e.def.damage, target: target.slot }, 'line', 'windup');
    return;
  }
  keepDistance(w, e, target, SH.KEEP_DISTANCE, AI.SHAMAN.BAND, true, dt);
}

/** The channel completes: every wounded enemy in reach regains MEND_FRACTION of its health. */
function mend(w: World, e: Enemy): void {
  const targets: number[] = [];
  const r2 = SH.MEND_RADIUS * SH.MEND_RADIUS;
  for (const o of w.enemies) {
    if (!mendable(e, o) || o.hp >= o.maxHp) continue;
    const dx = o.x - e.x;
    const dz = o.z - e.z;
    if (dx * dx + dz * dz > r2) continue;
    o.hp = Math.min(o.maxHp, o.hp + o.maxHp * SH.MEND_FRACTION);
    o.mends++;
    targets.push(o.id);
  }
  e.specialCd = SH.MEND_COOLDOWN;
  w.emit({ e: 'mend', id: e.id, targets });
}

// ---------------------------------------------------------------------------------------------- aegis

/** Raises and drops an aegis' dome; runs every tick, also while the aegis is stunned. */
export function stepDome(w: World, e: Enemy, dt: number): void {
  const able = e.spawnTime <= 0 && e.stunTime <= 0;
  if (e.domeOn) {
    if (!able) dropDome(w, e);
    return;
  }
  if (!able) return;
  e.domeCd -= dt;
  if (e.domeCd > SIM.EPS) return;
  e.domeCd = 0;
  e.domeOn = true;
  w.emit({ e: 'dome', id: e.id, on: true, r: AE.DOME_RADIUS });
}

export function dropDome(w: World, e: Enemy): void {
  if (!e.domeOn) return;
  e.domeOn = false;
  e.domeCd = AE.DOME_REARM_SECONDS;
  w.emit({ e: 'dome', id: e.id, on: false, r: AE.DOME_RADIUS });
}

/** Marks every enemy that stands inside the dome of another aegis (rank and file only, never an aegis). */
export function refreshDomes(w: World): void {
  let domes = 0;
  for (const e of w.enemies) {
    e.domed = false;
    if (e.domeOn && !e.dead) domes++;
  }
  if (domes === 0) return;
  const r2 = AE.DOME_RADIUS * AE.DOME_RADIUS;
  for (const a of w.enemies) {
    if (!a.domeOn || a.dead) continue;
    for (const o of w.enemies) {
      if (o.dead || o.kind === 'aegis' || isBoss(o)) continue;
      const dx = o.x - a.x;
      const dz = o.z - a.z;
      if (dx * dx + dz * dz <= r2) o.domed = true;
    }
  }
}

// ---------------------------------------------------------------------------------------------- bomber

function stepBomber(w: World, e: Enemy, target: TargetLike, pad: number): void {
  const tx = target.body.x;
  const tz = target.body.z;
  const d = Math.hypot(tx - e.x, tz - e.z) - pad;
  e.rot = angleTo(e.x, e.z, tx, tz);
  if (d <= e.def.attackRange) {
    beginAttack(w, e, { type: 'fuse', t: e.def.windup, x: e.x, z: e.z, rot: e.rot, r: BO.BLAST_RADIUS, w: 0, damage: e.def.damage, target: target.slot }, 'circle', 'windup');
    castEvent(w, e, 'fuse', e.x, e.z);
    return;
  }
  steer(w, e, tx, tz, enemySpeed(e), 1);
  setAnim(e, 'move');
}

/** Damage of a bomber's burst to other enemies: scaled like their health, so it stays worth provoking. */
const burstEnemyDamage = (w: World, e: Enemy): number => e.def.damage * BO.ENEMY_DAMAGE_MUL * w.hpMul;

/** The fuse has burnt down: everything in the announced circle is hurt, the bomber is gone. */
function burst(w: World, e: Enemy, a: EnemyAttack): void {
  const dmg = enemyDamage(e, a.damage);
  const foeDamage = burstEnemyDamage(w, e);
  const siege = e.siege && a.target < 0;
  // The bomber goes first, so that nothing its burst sets off (another bomber) reaches back to it.
  killEnemy(w, e, -1, true);
  w.emit({ e: 'aoe', x: a.x, z: a.z, r: a.r, el: null, hostile: true });
  for (const h of w.heroes) {
    if (!isTargetHero(h)) continue;
    const dx = h.body.x - a.x;
    const dz = h.body.z - a.z;
    if (dx * dx + dz * dz <= a.r * a.r) damageHero(w, h, dmg, e.id);
  }
  blastEnemies(w, a.x, a.z, a.r, foeDamage);
  if (siege) {
    const shard = standingAnchor(w);
    if (shard && Math.hypot(shard.x - a.x, shard.z - a.z) <= a.r + shard.r) damageAnchor(w, dmg);
  }
}

/** A hostile burst that also tears through the horde (bomber). */
export function blastEnemies(w: World, x: number, z: number, r: number, amount: number): void {
  if (amount <= 0) return;
  const n = w.enemies.length;
  for (let i = 0; i < n; i++) {
    const o = w.enemies[i] as Enemy;
    if (!isTargetable(o)) continue;
    const reach = r + o.radius;
    const dx = o.x - x;
    const dz = o.z - z;
    if (dx * dx + dz * dz <= reach * reach) rawDamageEnemy(w, o, amount, -1, null);
  }
}

// ---------------------------------------------------------------------------------------------- necromancer

function raisedBy(w: World, e: Enemy): number {
  let n = 0;
  for (const o of w.enemies) if (!o.dead && o.master === e.id) n++;
  return n;
}

function stepNecromancer(w: World, e: Enemy, target: TargetLike, dt: number): void {
  if (e.specialCd <= 0 && raisedBy(w, e) < NE.MAX_RAISED && livingEnemies(w) < WORLD.MAX_ENEMIES) {
    e.rot = angleTo(e.x, e.z, target.body.x, target.body.z);
    e.specialCd = e.def.cooldown * SIM.STAGGER_COOLDOWN_FRACTION;
    beginAttack(w, e, { type: 'raise', t: e.def.windup, x: e.x, z: e.z, rot: e.rot, r: 0, w: 0, damage: 0, target: target.slot }, null, 'summon');
    castEvent(w, e, 'raise', e.x, e.z);
    return;
  }
  keepDistance(w, e, target, NE.KEEP_DISTANCE, AI.NECROMANCER.BAND, false, dt);
}

function raise(w: World, e: Enemy): void {
  const count = Math.min(NE.RAISE_COUNT, NE.MAX_RAISED - raisedBy(w, e), WORLD.MAX_ENEMIES - livingEnemies(w));
  const start = w.rng.range(0, TAU);
  for (let i = 0; i < count; i++) {
    const a = start + (i / Math.max(1, count)) * TAU;
    const r = e.radius + w.rng.range(AI.NECROMANCER.RING_MIN, AI.NECROMANCER.RING_MAX);
    spawnEnemy(w, 'minion', e.x + Math.sin(a) * r, e.z + Math.cos(a) * r, { summoned: true, elite: w.cursed, master: e.id });
  }
  e.specialCd = e.def.cooldown;
}

// ---------------------------------------------------------------------------------------------- reaver

/** The hero furthest from the fight: from the centre of all other living enemies, or from the reaver if it is alone. */
function backliner(w: World, e: Enemy): Hero | null {
  let cx = 0;
  let cz = 0;
  let n = 0;
  for (const o of w.enemies) {
    if (o === e || o.dead) continue;
    cx += o.x;
    cz += o.z;
    n++;
  }
  if (n > 0) { cx /= n; cz /= n; } else { cx = e.x; cz = e.z; }
  let best: Hero | null = null;
  let bestD = -1;
  for (const h of w.heroes) {
    if (!isTargetHero(h)) continue;
    const dx = h.body.x - cx;
    const dz = h.body.z - cz;
    const d = dx * dx + dz * dz;
    if (d > bestD) { bestD = d; best = h; }
  }
  return best;
}

const landing = { x: 0, z: 0 };

function stepReaver(w: World, e: Enemy, target: TargetLike, pad: number): void {
  if (e.specialCd <= 0 && !e.siege && e.rootTime <= 0) {
    const prey = backliner(w, e);
    if (prey) {
      const d = Math.hypot(prey.body.x - e.x, prey.body.z - e.z);
      if (d >= RE.LEAP_MIN_DISTANCE && d <= RE.LEAP_MAX_DISTANCE) {
        const hx = w.room.w / 2 - AI.REAVER.WALL_MARGIN;
        const hz = w.room.d / 2 - AI.REAVER.WALL_MARGIN;
        landing.x = Math.max(-hx, Math.min(hx, prey.body.x));
        landing.z = Math.max(-hz, Math.min(hz, prey.body.z));
        resolveCollisions(landing, e.radius, w.room);
        e.rot = angleTo(e.x, e.z, landing.x, landing.z);
        e.specialCd = RE.LEAP_COOLDOWN;
        e.leapFromX = e.x;
        e.leapFromZ = e.z;
        e.leapTime = RE.LEAP_AIR_TIME;
        beginAttack(w, e, { type: 'pounce', t: RE.LEAP_AIR_TIME, x: landing.x, z: landing.z, rot: 0, r: RE.LEAP_RADIUS, w: 0, damage: RE.LEAP_DAMAGE, target: prey.slot }, 'circle', 'leap');
        castEvent(w, e, 'reaver_leap', landing.x, landing.z);
        return;
      }
    }
  }
  stepMelee(w, e, target, pad);
}

/** A reaver in the air travels in a straight line from where it jumped to the announced circle. */
export function flyReaver(e: Enemy, a: EnemyAttack): void {
  const f = e.leapTime > 0 ? Math.min(1, Math.max(0, 1 - a.t / e.leapTime)) : 1;
  e.x = e.leapFromX + (a.x - e.leapFromX) * f;
  e.z = e.leapFromZ + (a.z - e.leapFromZ) * f;
}

function land(w: World, e: Enemy, a: EnemyAttack): void {
  e.x = a.x;
  e.z = a.z;
  resolveCollisions(e, e.radius, w.room);
  w.emit({ e: 'aoe', x: a.x, z: a.z, r: a.r, el: null, hostile: true });
  landAttack(w, e, a, 'circle');
  // It stays on the hero it jumped at for a while.
  e.target = a.target;
  e.retarget = AI.REAVER.FOCUS_SECONDS;
}

// ---------------------------------------------------------------------------------------------- shared entry points

export function stepHorde(w: World, e: Enemy, target: TargetLike, pad: number, dt: number): void {
  if (e.specialCd > 0) e.specialCd -= dt;
  switch (e.kind) {
    case 'shaman': stepShaman(w, e, target, dt); break;
    case 'bomber': stepBomber(w, e, target, pad); break;
    case 'necromancer': stepNecromancer(w, e, target, dt); break;
    case 'reaver': stepReaver(w, e, target, pad); break;
    default: stepMelee(w, e, target, pad); break;
  }
}

/**
 * Resolves a finished windup of one of the new kinds. Returns the recovery in seconds, or -1 when the enemy is
 * gone (a bomber) and must not be touched any more.
 */
export function resolveHordeAttack(w: World, e: Enemy, a: EnemyAttack): number {
  switch (a.type) {
    case 'mend':
      mend(w, e);
      return AI.RECOVER_SECONDS;
    case 'bolt':
      spawnProjectile(w, {
        kind: 'hexOrb', x: e.x, z: e.z, rot: a.rot, speed: SH.BOLT_SPEED, radius: AI.ORB_RADIUS, range: a.r,
        damage: enemyDamage(e, a.damage), hostile: true, owner: e.id, slot: 'primary', pierce: 0, element: 0, stun: 0, knockback: 0,
      });
      return AI.RECOVER_SECONDS;
    case 'fuse':
      burst(w, e, a);
      return -1;
    case 'raise':
      raise(w, e);
      return AI.RECOVER_SECONDS;
    case 'pounce':
      land(w, e, a);
      return AI.REAVER.LEAP_RECOVER;
    default:
      return AI.RECOVER_SECONDS;
  }
}

/** What a dying enemy of the new kinds leaves behind. `quiet`: it crumbled or burst by itself (no death burst). */
export function onHordeDeath(w: World, e: Enemy, quiet: boolean): void {
  if (e.kind === 'aegis') {
    if (e.domeOn) {
      e.domeOn = false;
      w.emit({ e: 'dome', id: e.id, on: false, r: AE.DOME_RADIUS });
    }
  } else if (e.kind === 'bomber') {
    if (quiet) return;
    w.blasts.push({ x: e.x, z: e.z, r: BO.BLAST_RADIUS, t: BO.DEATH_BLAST_DELAY, damage: e.def.damage * e.damageMul, by: e.id, enemyDamage: burstEnemyDamage(w, e) });
    w.emit({ e: 'telegraph', shape: 'circle', x: e.x, z: e.z, rot: 0, r: BO.BLAST_RADIUS, w: 0, dur: BO.DEATH_BLAST_DELAY });
  } else if (e.kind === 'necromancer') {
    // Its minions crumble with it.
    const n = w.enemies.length;
    for (let i = 0; i < n; i++) {
      const o = w.enemies[i] as Enemy;
      if (!o.dead && o.master === e.id) killEnemy(w, o, -1, true);
    }
  }
}
