/**
 * The Ossuary Stalker: a mobile archer boss. It kites, fires fans of arrows and a heavy piercing spear, leaps to a
 * new position (away from heroes who close in, later also onto distant ones), scatters caltrop traps and, in its
 * last phase, falls into a short frenzy of quick shots.
 * Fairness: every arrow and the spear fly along a line that was announced when the windup started; the landing
 * circle of a leap and every pulse of a trap are announced before they hurt. It stands still while it shoots and
 * for the recovery afterwards (the frenzy ends in the longest one).
 */
import { ENEMY_TUNING } from '../data/enemies.ts';
import { bossTarget, endAttack } from './boss.ts';
import { enemyDamage } from './combat.ts';
import {
  beginAttack, emitTelegraph, hasLineOfSight, isTargetHero, keepDistance, landAttack, nearestHero, rayLength, setAnim,
} from './enemies.ts';
import { angleTo, DEG, TAU } from './geom.ts';
import { spawnProjectile } from './projectiles.ts';
import type { BossState, Enemy, EnemyAttack, Hero } from './state.ts';
import { AI, SIM } from './tuning.ts';
import type { World } from './world.ts';

const ST = ENEMY_TUNING.STALKER;
const A = AI.STALKER;

/** Indices into BossState.cd. The arrow fan has no cooldown: it is what the Stalker does when nothing else is ready. */
export const STALKER_CD = { SPEAR: 0, LEAP: 1, TRAP: 2, FRENZY: 3 } as const;

export const createStalkerCooldowns = (): number[] => [A.FIRST_SPEAR, A.FIRST_LEAP, A.FIRST_TRAP, 0];

/** The spear passes through every hero in its path. */
const SPEAR_PIERCE = 99;
const SPEAR_MAX_RANGE = 60;

const phaseIndex = (b: BossState): number => Math.max(0, Math.min(2, b.phase - 1));

/** Releases a shot whose line was announced when it was queued (called by the shared pending-attack loop). */
export function firePendingShot(w: World, e: Enemy, s: EnemyAttack): void {
  const spear = s.type === 'spear';
  spawnProjectile(w, {
    kind: spear ? 'boneSpear' : 'boneArrow', x: s.x, z: s.z, rot: s.rot, speed: spear ? ST.SPEAR_SPEED : ST.FAN_SPEED,
    radius: spear ? ST.SPEAR_RADIUS : AI.ARROW_RADIUS, range: s.r, damage: enemyDamage(e, s.damage), hostile: true, owner: e.id,
    slot: 'primary', pierce: spear ? SPEAR_PIERCE : 0, element: 0, stun: 0, knockback: 0,
  });
}

function queueShot(w: World, e: Enemy, b: BossState, rot: number, windup: number, damage: number, target: number): void {
  const shot: EnemyAttack = {
    type: 'shoot', t: windup, x: e.x, z: e.z, rot, r: rayLength(w, e.x, e.z, rot, AI.ARROW_RANGE, true), w: A.FAN_TELEGRAPH_WIDTH, damage, target,
  };
  b.slams.push(shot);
  emitTelegraph(w, e, shot, 'line');
}

function freeLanding(w: World, e: Enemy, x: number, z: number): boolean {
  if (Math.abs(x) > w.room.w / 2 - e.radius - A.LEAP_WALL_MARGIN || Math.abs(z) > w.room.d / 2 - e.radius - A.LEAP_WALL_MARGIN) return false;
  for (const o of w.room.obstacles) if (Math.hypot(o.x - x, o.z - z) < o.r + e.radius + AI.MAGE_BLINK_OBSTACLE_MARGIN) return false;
  return true;
}

function startLeap(w: World, e: Enemy, b: BossState, x: number, z: number, target: number): void {
  b.cd[STALKER_CD.LEAP] = A.LEAP_COOLDOWN;
  b.chargeFromX = e.x;
  b.chargeFromZ = e.z;
  e.rot = angleTo(e.x, e.z, x, z);
  beginAttack(w, e, { type: 'leap', t: ST.LEAP_AIR_TIME, x, z, rot: 0, r: ST.LEAP_RADIUS, w: 0, damage: ST.LEAP_DAMAGE, target }, 'circle', 'leap');
  w.emit({ e: 'cast', who: { t: 'e', id: e.id }, ability: 'leap', x, z, rot: e.rot });
}

/** Leap away from a hero who has closed in: the first free spot LEAP_DISTANCE away that is not next to another hero. */
function leapAway(w: World, e: Enemy, b: BossState, threat: Hero): boolean {
  const base = angleTo(threat.body.x, threat.body.z, e.x, e.z);
  for (const off of AI.MAGE_BLINK_ANGLES) {
    const a = base + off * DEG;
    const x = e.x + Math.sin(a) * ST.LEAP_DISTANCE;
    const z = e.z + Math.cos(a) * ST.LEAP_DISTANCE;
    if (!freeLanding(w, e, x, z)) continue;
    let near = false;
    for (const h of w.heroes) if (isTargetHero(h) && Math.hypot(h.body.x - x, h.body.z - z) < A.LEAP_MIN_HERO_DISTANCE) { near = true; break; }
    if (near) continue;
    startLeap(w, e, b, x, z, threat.slot);
    return true;
  }
  return false;
}

function throwTraps(w: World, e: Enemy, b: BossState, target: Hero): void {
  const count = ST.TRAP_COUNT[phaseIndex(b)] as number;
  const first = b.slams.length;
  const min = ST.TRAP_RADIUS * 2 + A.TRAP_MIN_GAP;
  const hx = w.room.w / 2 - ST.TRAP_RADIUS;
  const hz = w.room.d / 2 - ST.TRAP_RADIUS;
  let placed = 0;
  const add = (x: number, z: number, slot: number): void => {
    if (Math.abs(x) > hx || Math.abs(z) > hz) return;
    for (let i = first; i < b.slams.length; i++) {
      const s = b.slams[i] as EnemyAttack;
      if (s.type === 'trap' && Math.hypot(s.x - x, s.z - z) < min) return;
    }
    const trap: EnemyAttack = {
      type: 'trap', t: ST.TRAP_ARM, x, z, rot: 0, r: ST.TRAP_RADIUS, w: 0, damage: ST.TRAP_DAMAGE, target: slot,
      pulses: ST.TRAP_PULSES - 1, interval: ST.TRAP_INTERVAL,
    };
    b.slams.push(trap);
    emitTelegraph(w, e, trap, 'circle');
    placed++;
  };
  // One under the target, one under each other hero while the count lasts, the rest scattered around the target.
  add(target.body.x, target.body.z, target.slot);
  for (const h of w.heroes) if (placed < count && isTargetHero(h) && h !== target) add(h.body.x, h.body.z, h.slot);
  for (let attempt = 0; attempt < count * 4 && placed < count; attempt++) {
    const a = w.rng.range(0, TAU);
    const r = w.rng.range(min, min + A.TRAP_SCATTER);
    add(target.body.x + Math.sin(a) * r, target.body.z + Math.cos(a) * r, target.slot);
  }
}

function choose(w: World, e: Enemy, b: BossState, target: Hero, d: number): void {
  const p = phaseIndex(b);
  const rot = angleTo(e.x, e.z, target.body.x, target.body.z);
  const cast = (type: EnemyAttack['type'], t: number): EnemyAttack => ({ type, t, x: e.x, z: e.z, rot, r: 0, w: 0, damage: 0, target: target.slot });
  if (b.phase >= 3 && (b.cd[STALKER_CD.FRENZY] as number) <= 0) {
    b.cd[STALKER_CD.FRENZY] = A.FRENZY_COOLDOWN;
    e.rot = rot;
    beginAttack(w, e, cast('frenzy', (ST.FRENZY_SHOTS - 1) * ST.FRENZY_INTERVAL + ST.FRENZY_WINDUP), null, 'volley');
    w.emit({ e: 'cast', who: { t: 'e', id: e.id }, ability: 'frenzy', x: e.x, z: e.z, rot });
    b.seqType = 'frenzy';
    b.seqLeft = ST.FRENZY_SHOTS;
    b.seqTimer = 0;
    b.seqStep = 0;
    return;
  }
  if ((b.cd[STALKER_CD.LEAP] as number) <= 0) {
    const near = nearestHero(w, e.x, e.z);
    if (near && Math.hypot(near.body.x - e.x, near.body.z - e.z) < ST.LEAP_TRIGGER && leapAway(w, e, b, near)) return;
  }
  if ((b.cd[STALKER_CD.TRAP] as number) <= 0) {
    b.cd[STALKER_CD.TRAP] = A.TRAP_COOLDOWN;
    e.rot = rot;
    beginAttack(w, e, cast('trap', A.TRAP_CAST), null, 'cast');
    throwTraps(w, e, b, target);
    return;
  }
  if ((b.cd[STALKER_CD.SPEAR] as number) <= 0 && hasLineOfSight(w, e.x, e.z, target.body.x, target.body.z, ST.SPEAR_RADIUS)) {
    b.cd[STALKER_CD.SPEAR] = A.SPEAR_COOLDOWN;
    e.rot = rot;
    beginAttack(w, e, cast('spear', ST.SPEAR_WINDUP), null, 'windup');
    const spear: EnemyAttack = {
      type: 'spear', t: ST.SPEAR_WINDUP, x: e.x, z: e.z, rot, r: rayLength(w, e.x, e.z, rot, SPEAR_MAX_RANGE, true), w: ST.SPEAR_WIDTH,
      damage: ST.SPEAR_DAMAGE, target: target.slot,
    };
    b.slams.push(spear);
    emitTelegraph(w, e, spear, 'line');
    return;
  }
  if (b.phase >= 2 && (b.cd[STALKER_CD.LEAP] as number) <= 0 && d >= A.LEAP_POUNCE_MIN_DISTANCE && w.rng.chance(A.LEAP_POUNCE_CHANCE)
    && freeLanding(w, e, target.body.x, target.body.z)) {
    startLeap(w, e, b, target.body.x, target.body.z, target.slot);
    return;
  }
  // Arrow fan: one announced line per arrow.
  const arrows = ST.FAN_ARROWS[p] as number;
  const spread = (ST.FAN_SPREAD_DEG[p] as number) * DEG;
  e.rot = rot;
  beginAttack(w, e, cast('fan', ST.FAN_WINDUP), null, 'volley');
  for (let i = 0; i < arrows; i++) queueShot(w, e, b, rot + (arrows > 1 ? i / (arrows - 1) - 0.5 : 0) * spread, ST.FAN_WINDUP, ST.FAN_DAMAGE, target.slot);
}

function resolve(w: World, e: Enemy, b: BossState, a: EnemyAttack): void {
  switch (a.type) {
    case 'fan':
      endAttack(e, b, A.FAN_RECOVER);
      break;
    case 'spear':
      endAttack(e, b, A.SPEAR_RECOVER);
      break;
    case 'trap':
      endAttack(e, b, A.TRAP_RECOVER);
      break;
    case 'frenzy':
      endAttack(e, b, A.FRENZY_RECOVER);
      break;
    case 'leap':
      e.x = a.x;
      e.z = a.z;
      w.emit({ e: 'aoe', x: a.x, z: a.z, r: a.r, el: null, hostile: true });
      landAttack(w, e, a, 'circle');
      endAttack(e, b, A.LEAP_RECOVER);
      break;
    default:
      e.attack = null;
      break;
  }
}

/** Frenzy: one quick aimed arrow per step, cycling through the heroes. */
function stepSequence(w: World, e: Enemy, b: BossState, dt: number): void {
  if (b.seqLeft <= 0) return;
  b.seqTimer -= dt;
  if (b.seqTimer > SIM.EPS) return;
  b.seqLeft--;
  b.seqStep++;
  b.seqTimer += ST.FRENZY_INTERVAL;
  if (b.seqType !== 'frenzy') { b.seqLeft = 0; return; }
  let aim: Hero | null = null;
  let seen = 0;
  for (const h of w.heroes) if (isTargetHero(h)) seen++;
  if (seen > 0) {
    let index = b.cycle++ % seen;
    for (const h of w.heroes) {
      if (!isTargetHero(h)) continue;
      if (index-- === 0) { aim = h; break; }
    }
  }
  if (!aim) return;
  e.rot = angleTo(e.x, e.z, aim.body.x, aim.body.z);
  e.animSeq++;
  queueShot(w, e, b, e.rot, ST.FRENZY_WINDUP, ST.FRENZY_DAMAGE, aim.slot);
}

export function stepStalker(w: World, e: Enemy, b: BossState, dt: number, rate: number): void {
  if (b.pendingPhase > 0) {
    // Phase 2 opens with a field of traps, phase 3 with the frenzy.
    if (b.pendingPhase === 2) b.cd[STALKER_CD.TRAP] = 0;
    if (b.pendingPhase === 3) b.cd[STALKER_CD.FRENZY] = 0;
    b.gap = Math.max(b.gap, A.PHASE_PAUSE);
    b.pendingPhase = 0;
  }
  stepSequence(w, e, b, dt);
  const a = e.attack;
  if (a) {
    a.t -= dt;
    if (a.type === 'leap') {
      // In the air: glide from the take-off point to the announced landing spot.
      const k = Math.max(0, Math.min(1, 1 - a.t / ST.LEAP_AIR_TIME));
      e.x = b.chargeFromX + (a.x - b.chargeFromX) * k;
      e.z = b.chargeFromZ + (a.z - b.chargeFromZ) * k;
    }
    if (a.t <= SIM.EPS) resolve(w, e, b, a);
    return;
  }
  if (e.recover > 0) {
    e.recover -= dt;
    if (e.recover <= SIM.EPS) {
      e.recover = 0;
      const cadence = b.phase >= 3 ? A.PHASE3_CADENCE : b.phase === 2 ? A.PHASE2_CADENCE : 1;
      b.gap = Math.max(A.MIN_GAP, e.def.cooldown * cadence);
    }
    return;
  }
  const target = bossTarget(w, e, b, dt);
  if (!target) {
    setAnim(e, 'idle');
    return;
  }
  b.gap -= rate;
  if (b.gap <= 0) {
    choose(w, e, b, target, Math.hypot(target.body.x - e.x, target.body.z - e.z));
    if (e.attack) return;
  }
  keepDistance(w, e, target, e.def.attackRange, A.KEEP_BAND, true, dt);
}
