/**
 * Crypt Champion and Bone Regent, plus what every boss shares (state, targeting, phases, announced ground attacks).
 * All bosses run the same loop: reposition -> telegraphed attack -> recovery (punish window) -> gap -> next attack.
 * They cannot be stunned or knocked back, never start two attacks back to back and always have an option that
 * does not require reaching the target (charge / volley / projectiles), so kiting or body-blocking cannot stall
 * them. The Hex Matron lives in matron.ts, the Ossuary Stalker in stalker.ts.
 */
import { WORLD, RUN } from '../constants.ts';
import { ENEMY_TUNING } from '../data/enemies.ts';
import type { EnemyKind } from '../types.ts';
import { chillSlow, damageHero, enemyDamage } from './combat.ts';
import {
  beginAttack, emitTelegraph, enemySpeed, isTargetHero, landAttack, livingEnemies, nearestHero, rayLength, setAnim, taunting,
  spawnEnemy, steer,
} from './enemies.ts';
import { angleTo, DEG, TAU } from './geom.ts';
import { createMatronCooldowns, stepMatron } from './matron.ts';
import { spawnProjectile } from './projectiles.ts';
import { createStalkerCooldowns, firePendingShot, stepStalker } from './stalker.ts';
import type { BossState, Enemy, EnemyAttack, Hero } from './state.ts';
import { AI, SIM, AFFIX } from './tuning.ts';
import type { World } from './world.ts';

const CH = ENEMY_TUNING.CHAMPION;
const RG = ENEMY_TUNING.REGENT;

/** Health fractions at which a boss enters phase 2 and 3 (the champion has a single phase). */
const PHASE_THRESHOLDS: Partial<Record<EnemyKind, readonly [number, number]>> = {
  regent: RG.PHASE_THRESHOLDS, matron: ENEMY_TUNING.MATRON.PHASE_THRESHOLDS, stalker: ENEMY_TUNING.STALKER.PHASE_THRESHOLDS,
};

export function createBossState(kind: EnemyKind, herald = false): BossState {
  return {
    phase: 1, gap: AI.BOSS_FIRST_GAP, chargeCd: AI.BOSS_FIRST_CHARGE, volleyCd: AI.BOSS_FIRST_VOLLEY,
    summonCd: kind === 'champion' ? AI.CHAMPION.FIRST_SUMMON : kind === 'matron' ? ENEMY_TUNING.MATRON.SUMMON_COOLDOWN : RG.SUMMON_COOLDOWN,
    slamCd: AI.REGENT.SLAM_COOLDOWN,
    chargeLeft: 0, chargeLen: 0, chargeFromX: 0, chargeFromZ: 0, chargeHit: [],
    repeats: 0, repeatTimer: 0, slams: [], chase: 0, retarget: 0, pendingPhase: 0,
    herald, cd: kind === 'matron' ? createMatronCooldowns() : kind === 'stalker' ? createStalkerCooldowns() : [],
    seqType: null, seqLeft: 0, seqTimer: 0, seqStep: 0, seqAngle: 0, seqDir: 1, cycle: 0,
  };
}

export function bossTarget(w: World, e: Enemy, b: BossState, dt: number): Hero | null {
  b.retarget -= dt;
  const taunter = taunting(w, e);
  if (taunter) {
    e.target = taunter.slot;
    return taunter;
  }
  const current = w.hero(e.target);
  if (current && isTargetHero(current) && b.retarget > 0) return current;
  b.retarget = AI.REGENT.RETARGET_SECONDS;
  const candidates = w.heroes.filter(isTargetHero);
  if (candidates.length === 0) { e.target = -1; return null; }
  // Mostly the nearest hero, sometimes a random one so that ranged heroes are not ignored.
  const pick = candidates.length > 1 && w.rng.chance(AI.BOSS_RANDOM_TARGET_CHANCE) ? w.rng.pick(candidates) : nearestHero(w, e.x, e.z);
  const target = pick ?? (candidates[0] as Hero);
  e.target = target.slot;
  return target;
}

export function partyCount(w: World, base: number): number {
  return Math.round(base * (1 + RUN.COUNT_PER_EXTRA_PLAYER * (w.partySize - 1)));
}

function summon(w: World, e: Enemy, base: number): void {
  const count = Math.min(partyCount(w, base), WORLD.MAX_ENEMIES - livingEnemies(w));
  const start = w.rng.range(0, TAU);
  for (let i = 0; i < count; i++) {
    const a = start + (i / Math.max(1, count)) * TAU;
    const r = e.radius + w.rng.range(AI.SUMMON_RING_MIN, AI.SUMMON_RING_MAX);
    spawnEnemy(w, 'minion', e.x + Math.sin(a) * r, e.z + Math.cos(a) * r, { summoned: true, elite: w.cursed });
  }
}

function fireVolley(w: World, e: Enemy, offset: number): void {
  for (let i = 0; i < RG.VOLLEY_ORBS; i++) {
    const rot = offset + (i / RG.VOLLEY_ORBS) * TAU;
    spawnProjectile(w, {
      kind: 'hexOrb', x: e.x, z: e.z, rot, speed: RG.VOLLEY_SPEED, radius: AI.ORB_RADIUS, range: AI.ORB_RANGE,
      damage: enemyDamage(e, RG.VOLLEY_DAMAGE), hostile: true, owner: e.id, slot: 'primary', pierce: 0, element: 0, stun: 0, knockback: 0,
    });
  }
}

function addSlams(w: World, e: Enemy, b: BossState): void {
  for (const h of w.heroes) {
    if (!isTargetHero(h)) continue;
    const slam: EnemyAttack = {
      type: 'slam', t: RG.SLAM_WINDUP, x: h.body.x, z: h.body.z, rot: 0, r: RG.SLAM_RADIUS, w: 0, damage: RG.SLAM_DAMAGE, target: h.slot,
    };
    b.slams.push(slam);
    emitTelegraph(w, e, slam, 'circle');
  }
}

function startCharge(w: World, e: Enemy, target: Hero, length: number, width: number, windup: number, damage: number): boolean {
  const rot = angleTo(e.x, e.z, target.body.x, target.body.z);
  const len = Math.min(length, rayLength(w, e.x, e.z, rot, length + e.radius, false) - e.radius);
  if (len < AI.CHARGE_MIN_LANE) return false;
  e.rot = rot;
  beginAttack(w, e, { type: 'charge', t: windup, x: e.x, z: e.z, rot, r: len, w: width, damage, target: target.slot }, 'line', 'windup');
  return true;
}

function startSweep(w: World, e: Enemy, target: Hero, reach: number, arcDeg: number): void {
  e.rot = angleTo(e.x, e.z, target.body.x, target.body.z);
  beginAttack(w, e, { type: 'sweep', t: e.def.windup, x: e.x, z: e.z, rot: e.rot, r: reach, w: arcDeg * DEG, damage: e.def.damage, target: target.slot }, 'arc', 'sweep');
}

function chooseChampion(w: World, e: Enemy, b: BossState, target: Hero, d: number): void {
  if (b.summonCd <= 0 && livingEnemies(w) + CH.SUMMON_COUNT <= WORLD.MAX_ENEMIES) {
    b.summonCd = CH.SUMMON_EVERY;
    beginAttack(w, e, { type: 'summon', t: AI.CHAMPION.SUMMON_CAST, x: e.x, z: e.z, rot: e.rot, r: 0, w: 0, damage: 0, target: target.slot }, null, 'summon');
    return;
  }
  if (d <= e.def.attackRange) {
    startSweep(w, e, target, CH.SWEEP_REACH, CH.SWEEP_ARC_DEG);
    return;
  }
  const wantsCharge = (d >= AI.CHAMPION.CHARGE_MIN_DISTANCE && d <= CH.CHARGE_LENGTH) || b.chase >= AI.CHAMPION.CHASE_PATIENCE;
  if (b.chargeCd <= 0 && wantsCharge && startCharge(w, e, target, CH.CHARGE_LENGTH, CH.CHARGE_WIDTH, CH.CHARGE_WINDUP, CH.CHARGE_DAMAGE)) {
    b.chargeCd = AI.CHAMPION.CHARGE_COOLDOWN;
  }
}

function startVolley(w: World, e: Enemy, b: BossState, target: Hero): void {
  b.volleyCd = AI.REGENT.VOLLEY_COOLDOWN;
  beginAttack(w, e, {
    type: 'volley', t: RG.VOLLEY_WINDUP, x: e.x, z: e.z, rot: e.rot, r: AI.REGENT.VOLLEY_TELEGRAPH_RADIUS, w: 0, damage: RG.VOLLEY_DAMAGE, target: target.slot,
  }, 'circle', 'volley');
}

function chooseRegent(w: World, e: Enemy, b: BossState, target: Hero, d: number): void {
  if (b.phase >= 2 && b.summonCd <= 0 && livingEnemies(w) + RG.SUMMON_COUNT <= WORLD.MAX_ENEMIES) {
    b.summonCd = RG.SUMMON_COOLDOWN;
    beginAttack(w, e, { type: 'summon', t: AI.REGENT.SUMMON_CAST, x: e.x, z: e.z, rot: e.rot, r: 0, w: 0, damage: 0, target: target.slot }, null, 'summon');
    return;
  }
  if (b.phase >= 3 && b.slamCd <= 0) {
    b.slamCd = AI.REGENT.SLAM_COOLDOWN;
    const total = RG.SLAM_INTERVAL * (RG.SLAM_REPEATS - 1) + RG.SLAM_WINDUP;
    beginAttack(w, e, { type: 'slam', t: total, x: e.x, z: e.z, rot: e.rot, r: 0, w: 0, damage: 0, target: target.slot }, null, 'slam');
    b.repeats = RG.SLAM_REPEATS - 1;
    b.repeatTimer = RG.SLAM_INTERVAL;
    addSlams(w, e, b);
    return;
  }
  if (d <= e.def.attackRange) {
    if (b.volleyCd <= 0 && w.rng.chance(AI.REGENT_CLOSE_VOLLEY_CHANCE)) startVolley(w, e, b, target);
    else startSweep(w, e, target, RG.SWEEP_REACH, RG.SWEEP_ARC_DEG);
    return;
  }
  const inChargeBand = d >= AI.REGENT.CHARGE_MIN_DISTANCE && d <= RG.CHARGE_LENGTH;
  if (b.chargeCd <= 0 && (inChargeBand || b.chase >= AI.REGENT.CHASE_PATIENCE)
    && startCharge(w, e, target, RG.CHARGE_LENGTH, RG.CHARGE_WIDTH, RG.CHARGE_WINDUP, RG.CHARGE_DAMAGE)) {
    b.chargeCd = AI.REGENT.CHARGE_COOLDOWN;
    return;
  }
  if (b.volleyCd <= 0) startVolley(w, e, b, target);
}

export function endAttack(e: Enemy, b: BossState, recover: number): void {
  e.attack = null;
  e.recover = recover;
  b.chase = 0;
  setAnim(e, 'attack');
}

function resolveBossAttack(w: World, e: Enemy, b: BossState, a: EnemyAttack): void {
  const champion = e.kind === 'champion';
  const cfg = champion ? AI.CHAMPION : AI.REGENT;
  switch (a.type) {
    case 'sweep':
      landAttack(w, e, a, 'arc');
      endAttack(e, b, cfg.SWEEP_RECOVER);
      break;
    case 'charge':
      e.attack = null;
      b.chargeLeft = a.r;
      b.chargeLen = a.r;
      b.chargeFromX = a.x;
      b.chargeFromZ = a.z;
      b.chargeHit.length = 0;
      e.rot = a.rot;
      setAnim(e, 'charge');
      break;
    case 'summon':
      summon(w, e, champion ? CH.SUMMON_COUNT : RG.SUMMON_COUNT);
      endAttack(e, b, cfg.SUMMON_RECOVER);
      break;
    case 'volley':
      fireVolley(w, e, e.rot);
      b.repeats = RG.VOLLEY_WAVES - 1;
      b.repeatTimer = AI.REGENT.VOLLEY_WAVE_INTERVAL;
      // Keeps the volley pose while the remaining waves go out.
      e.attack = null;
      e.recover = AI.REGENT.VOLLEY_WAVE_INTERVAL * (RG.VOLLEY_WAVES - 1) + AI.REGENT.VOLLEY_RECOVER;
      b.chase = 0;
      break;
    case 'slam':
      endAttack(e, b, AI.REGENT.SLAM_RECOVER);
      break;
    default:
      e.attack = null;
      break;
  }
}

function stepCharge(w: World, e: Enemy, b: BossState, dt: number): void {
  const champion = e.kind === 'champion';
  const speed = champion ? CH.CHARGE_SPEED : RG.CHARGE_SPEED;
  const width = champion ? CH.CHARGE_WIDTH : RG.CHARGE_WIDTH;
  const damage = champion ? CH.CHARGE_DAMAGE : RG.CHARGE_DAMAGE;
  const dirX = Math.sin(e.rot);
  const dirZ = Math.cos(e.rot);
  const from = b.chargeLen - b.chargeLeft;
  const step = Math.min(speed * dt, b.chargeLeft);
  const to = from + step;
  e.x += dirX * step;
  e.z += dirZ * step;
  b.chargeLeft -= step;
  // Contact damage inside the announced lane as the boss passes.
  for (const h of w.heroes) {
    if (!isTargetHero(h) || b.chargeHit.includes(h.slot)) continue;
    const dx = h.body.x - b.chargeFromX;
    const dz = h.body.z - b.chargeFromZ;
    const along = dx * dirX + dz * dirZ;
    const side = Math.abs(dx * dirZ - dz * dirX);
    if (side > width / 2 || along < from - e.radius || along > to + e.radius || along > b.chargeLen) continue;
    b.chargeHit.push(h.slot);
    damageHero(w, h, enemyDamage(e, damage), e.id, true);
  }
  if (b.chargeLeft <= SIM.EPS) {
    b.chargeLeft = 0;
    endAttack(e, b, champion ? AI.CHAMPION.CHARGE_RECOVER : AI.REGENT.CHARGE_RECOVER);
  }
}

/**
 * Announced ground attacks land on their own schedule: slam and blast circles, beam lines, queued shots and
 * traps (a trap re-announces itself after every pulse until its pulses are used up).
 */
function stepPending(w: World, e: Enemy, b: BossState, dt: number): void {
  for (let i = b.slams.length - 1; i >= 0; i--) {
    const s = b.slams[i] as EnemyAttack;
    s.t -= dt;
    if (s.t > SIM.EPS) continue;
    if (s.type === 'beam') {
      b.slams.splice(i, 1);
      w.emit({ e: 'cast', who: { t: 'e', id: e.id }, ability: 'matron_beam', x: s.x, z: s.z, rot: s.rot });
      landAttack(w, e, s, 'line');
      continue;
    }
    if (s.type === 'shoot' || s.type === 'spear') {
      b.slams.splice(i, 1);
      firePendingShot(w, e, s);
      continue;
    }
    w.emit({ e: 'aoe', x: s.x, z: s.z, r: s.r, el: null, hostile: true });
    landAttack(w, e, s, 'circle');
    if (s.type === 'trap' && (s.pulses ?? 0) > 0) {
      s.pulses = (s.pulses ?? 0) - 1;
      s.t = s.interval ?? 0;
      emitTelegraph(w, e, s, 'circle');
      continue;
    }
    b.slams.splice(i, 1);
  }
}

export function stepBoss(w: World, e: Enemy, dt: number): void {
  const b = e.boss as BossState;
  const rate = dt * (1 - chillSlow(e)) * (e.affix === 'swift' ? AFFIX.SWIFT_ATTACK_RATE : 1);
  b.chargeCd -= rate;
  b.volleyCd -= rate;
  b.summonCd -= rate;
  b.slamCd -= rate;
  for (let i = 0; i < b.cd.length; i++) b.cd[i] = (b.cd[i] as number) - rate;

  const thresholds = PHASE_THRESHOLDS[e.kind];
  if (thresholds && !b.herald) {
    const frac = e.hp / e.maxHp;
    const phase = frac <= thresholds[1] ? 3 : frac <= thresholds[0] ? 2 : 1;
    if (phase > b.phase) {
      b.phase = phase;
      w.emit({ e: 'bossPhase', phase });
      // The new phase opens with its signature move after a short pause.
      b.pendingPhase = phase;
      if (e.kind === 'regent') {
        if (phase === 2) b.summonCd = 0;
        if (phase === 3) b.slamCd = 0;
        b.gap = Math.max(b.gap, AI.REGENT.PHASE_PAUSE);
      }
    }
  }

  stepPending(w, e, b, dt);
  if (e.kind === 'matron') { stepMatron(w, e, b, dt, rate); return; }
  if (e.kind === 'stalker') { stepStalker(w, e, b, dt, rate); return; }

  if (b.repeats > 0) {
    b.repeatTimer -= dt;
    if (b.repeatTimer <= SIM.EPS) {
      b.repeats--;
      if (e.attack && e.attack.type === 'slam') {
        b.repeatTimer += RG.SLAM_INTERVAL;
        addSlams(w, e, b);
      } else {
        b.repeatTimer += AI.REGENT.VOLLEY_WAVE_INTERVAL;
        fireVolley(w, e, e.rot + Math.PI / RG.VOLLEY_ORBS);
      }
    }
  }

  if (b.chargeLeft > 0) {
    stepCharge(w, e, b, dt);
    return;
  }
  if (e.attack) {
    e.attack.t -= dt;
    if (e.attack.t <= SIM.EPS) resolveBossAttack(w, e, b, e.attack);
    return;
  }
  if (e.recover > 0) {
    e.recover -= dt;
    if (e.recover <= SIM.EPS) {
      e.recover = 0;
      const cadence = e.kind === 'regent' ? (b.phase >= 3 ? AI.REGENT.PHASE3_CADENCE : b.phase === 2 ? AI.REGENT.PHASE2_CADENCE : 1) : 1;
      b.gap = Math.max(AI.REGENT.MIN_GAP, e.def.cooldown * cadence);
    }
    return;
  }

  const target = bossTarget(w, e, b, dt);
  if (!target) {
    setAnim(e, 'idle');
    return;
  }
  const tx = target.body.x;
  const tz = target.body.z;
  const d = Math.hypot(tx - e.x, tz - e.z);
  b.gap -= rate;
  if (b.gap <= 0) {
    if (e.kind === 'champion') chooseChampion(w, e, b, target, d);
    else chooseRegent(w, e, b, target, d);
    if (e.attack) return;
  }
  e.rot = angleTo(e.x, e.z, tx, tz);
  if (d > e.def.attackRange * AI.MELEE_STOP_FRACTION) {
    steer(w, e, tx, tz, enemySpeed(e), 1);
    b.chase += dt;
    setAnim(e, 'move');
  } else {
    setAnim(e, 'idle');
  }
}
