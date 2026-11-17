/**
 * The Hex Matron: a caster boss that keeps her distance, blinks away from heroes who close in and fights with
 * patterns: orb rings and spirals, rotating beams, lattices of ground blasts, slow homing soul wisps, summons.
 * Fairness: beams and blasts are announced when their windup starts and only hurt heroes still inside when they
 * land; orbs and wisps hurt on contact only (wisps can be destroyed by any hero attack, or outrun). She is rooted
 * while she casts and for the recovery afterwards, which is the window to punish her.
 */
import { WORLD } from '../constants.ts';
import { ENEMY_TUNING } from '../data/enemies.ts';
import { bossTarget, endAttack, partyCount } from './boss.ts';
import { enemyDamage } from './combat.ts';
import {
  beginAttack, emitTelegraph, isTargetHero, keepDistance, livingEnemies, nearestHero, rayLength, setAnim, spawnEnemy, tryBlink,
} from './enemies.ts';
import { angleTo, DEG, TAU } from './geom.ts';
import { spawnProjectile } from './projectiles.ts';
import type { BossState, Enemy, EnemyAttack, Hero } from './state.ts';
import { AI, SIM } from './tuning.ts';
import type { World } from './world.ts';

const MT = ENEMY_TUNING.MATRON;
const A = AI.MATRON;

/** Indices into BossState.cd. The orb ring has no cooldown: it is what she casts when nothing else is ready. */
export const MATRON_CD = { BLAST: 0, WISP: 1, BEAM: 2, SPIRAL: 3 } as const;

export const createMatronCooldowns = (): number[] => [A.FIRST_BLAST, A.FIRST_WISP, A.FIRST_BEAM, 0];

/** Lattice offsets (in units of BLAST_SPACING) of the blast patterns. */
const CROSS: readonly (readonly [number, number])[] = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]];
const GRID: readonly (readonly [number, number])[] = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
const SHIFTED: readonly (readonly [number, number])[] = [[0.5, 0.5], [0.5, -0.5], [-0.5, 0.5], [-0.5, -0.5]];
const RING_POINTS = 6;

const phaseIndex = (b: BossState): number => Math.max(0, Math.min(2, b.phase - 1));

function fireOrbs(w: World, e: Enemy, count: number, offset: number, speed: number, damage: number): void {
  for (let i = 0; i < count; i++) {
    spawnProjectile(w, {
      kind: 'hexOrb', x: e.x, z: e.z, rot: offset + (i / count) * TAU, speed, radius: AI.ORB_RADIUS, range: AI.ORB_RANGE,
      damage: enemyDamage(e, damage), hostile: true, owner: e.id, slot: 'primary', pierce: 0, element: 0, stun: 0, knockback: 0,
    });
  }
}

function addBeams(w: World, e: Enemy, b: BossState, target: number): void {
  const rays = MT.BEAM_RAYS[phaseIndex(b)] as number;
  const base = b.seqAngle + b.seqStep * MT.BEAM_TURN_DEG * DEG * b.seqDir;
  for (let k = 0; k < rays; k++) {
    const rot = base + (k / rays) * TAU;
    const beam: EnemyAttack = {
      type: 'beam', t: MT.BEAM_WINDUP, x: e.x, z: e.z, rot, r: rayLength(w, e.x, e.z, rot, MT.BEAM_LENGTH, false), w: MT.BEAM_WIDTH,
      damage: MT.BEAM_DAMAGE, target,
    };
    b.slams.push(beam);
    emitTelegraph(w, e, beam, 'line');
  }
}

/**
 * One wave of ground blasts: a lattice around (cx, cz), turned by `rot`. Neighbouring circles are BLAST_SPACING
 * apart, so there is always a gap to stand in. Other heroes get a circle of their own where it keeps that gap.
 */
function addBlasts(w: World, e: Enemy, b: BossState, cx: number, cz: number, rot: number, pattern: readonly (readonly [number, number])[], ring: boolean, target: number): void {
  const first = b.slams.length;
  const sin = Math.sin(rot);
  const cos = Math.cos(rot);
  const hx = w.room.w / 2;
  const hz = w.room.d / 2;
  const add = (x: number, z: number, slot: number): void => {
    if (Math.abs(x) > hx || Math.abs(z) > hz) return;
    const blast: EnemyAttack = { type: 'blast', t: MT.BLAST_WINDUP, x, z, rot: 0, r: MT.BLAST_RADIUS, w: 0, damage: MT.BLAST_DAMAGE, target: slot };
    b.slams.push(blast);
    emitTelegraph(w, e, blast, 'circle');
  };
  if (ring) {
    for (let i = 0; i < RING_POINTS; i++) {
      const a = rot + (i / RING_POINTS) * TAU;
      add(cx + Math.sin(a) * MT.BLAST_SPACING, cz + Math.cos(a) * MT.BLAST_SPACING, target);
    }
  } else {
    for (const [u, v] of pattern) {
      const ox = (u * cos + v * sin) * MT.BLAST_SPACING;
      const oz = (v * cos - u * sin) * MT.BLAST_SPACING;
      add(cx + ox, cz + oz, target);
    }
  }
  const min = MT.BLAST_RADIUS * 2 + A.BLAST_MIN_GAP;
  for (const h of w.heroes) {
    if (!isTargetHero(h) || h.slot === target) continue;
    let free = true;
    for (let i = first; i < b.slams.length && free; i++) {
      const s = b.slams[i] as EnemyAttack;
      if (s.type === 'blast' && Math.hypot(s.x - h.body.x, s.z - h.body.z) < min) free = false;
    }
    if (free) add(h.body.x, h.body.z, h.slot);
  }
}

function wispCount(w: World): number {
  let n = 0;
  for (const p of w.projectiles) if (p.kind === 'soulWisp' && !p.dead) n++;
  return n;
}

function summon(w: World, e: Enemy): void {
  const minions = partyCount(w, MT.SUMMON_MINIONS);
  const count = Math.min(MT.SUMMON_MAGES + minions, WORLD.MAX_ENEMIES - livingEnemies(w));
  const start = w.rng.range(0, TAU);
  for (let i = 0; i < count; i++) {
    const a = start + (i / Math.max(1, count)) * TAU;
    const r = e.radius + w.rng.range(AI.SUMMON_RING_MIN, AI.SUMMON_RING_MAX);
    spawnEnemy(w, i < MT.SUMMON_MAGES ? 'mage' : 'minion', e.x + Math.sin(a) * r, e.z + Math.cos(a) * r, { summoned: true, elite: w.cursed });
  }
}

function choose(w: World, e: Enemy, b: BossState, target: Hero): void {
  const p = phaseIndex(b);
  const rot = angleTo(e.x, e.z, target.body.x, target.body.z);
  e.rot = rot;
  const cast = (type: EnemyAttack['type'], t: number): EnemyAttack => ({ type, t, x: e.x, z: e.z, rot, r: 0, w: 0, damage: 0, target: target.slot });
  if (b.phase >= 2 && b.summonCd <= 0 && livingEnemies(w) + MT.SUMMON_MAGES + partyCount(w, MT.SUMMON_MINIONS) <= WORLD.MAX_ENEMIES) {
    b.summonCd = MT.SUMMON_COOLDOWN;
    beginAttack(w, e, cast('summon', A.SUMMON_CAST), null, 'summon');
    return;
  }
  if ((b.cd[MATRON_CD.BEAM] as number) <= 0) {
    b.cd[MATRON_CD.BEAM] = A.BEAM_COOLDOWN;
    const steps = MT.BEAM_STEPS[p] as number;
    beginAttack(w, e, cast('beam', (steps - 1) * MT.BEAM_INTERVAL + MT.BEAM_WINDUP), null, 'beam');
    b.seqType = 'beam';
    b.seqLeft = steps - 1;
    b.seqTimer = MT.BEAM_INTERVAL;
    b.seqStep = 0;
    b.seqAngle = rot;
    b.seqDir = w.rng.chance(0.5) ? 1 : -1;
    addBeams(w, e, b, target.slot);
    return;
  }
  if ((b.cd[MATRON_CD.BLAST] as number) <= 0) {
    b.cd[MATRON_CD.BLAST] = A.BLAST_COOLDOWN;
    const waves = MT.BLAST_WAVES[p] as number;
    beginAttack(w, e, cast('blasts', (waves - 1) * MT.BLAST_WAVE_INTERVAL + MT.BLAST_WINDUP), null, 'cast');
    b.seqType = 'blasts';
    b.seqLeft = waves - 1;
    b.seqTimer = MT.BLAST_WAVE_INTERVAL;
    b.seqStep = 0;
    b.seqAngle = w.rng.range(0, TAU);
    // The lattice stays where it was aimed; `chargeFrom` doubles as its anchor for the second wave.
    b.chargeFromX = target.body.x;
    b.chargeFromZ = target.body.z;
    const ring = b.phase === 2 && w.rng.chance(0.5);
    addBlasts(w, e, b, target.body.x, target.body.z, b.seqAngle, b.phase >= 2 ? GRID : CROSS, ring, target.slot);
    return;
  }
  const wisps = Math.min(MT.WISP_COUNT[p] as number, MT.WISP_MAX - wispCount(w));
  if ((b.cd[MATRON_CD.WISP] as number) <= 0 && wisps > 0) {
    b.cd[MATRON_CD.WISP] = A.WISP_COOLDOWN;
    beginAttack(w, e, cast('wisp', MT.WISP_WINDUP), null, 'cast');
    return;
  }
  if (b.phase >= 2 && (b.cd[MATRON_CD.SPIRAL] as number) <= 0) {
    b.cd[MATRON_CD.SPIRAL] = A.SPIRAL_COOLDOWN;
    beginAttack(w, e, { ...cast('spiral', MT.SPIRAL_WINDUP), r: A.RING_TELEGRAPH_RADIUS }, 'circle', 'volley');
    return;
  }
  beginAttack(w, e, { ...cast('ring', MT.RING_WINDUP), r: A.RING_TELEGRAPH_RADIUS, damage: MT.RING_DAMAGE }, 'circle', 'volley');
}

function resolve(w: World, e: Enemy, b: BossState, a: EnemyAttack): void {
  const p = phaseIndex(b);
  switch (a.type) {
    case 'ring': {
      const waves = MT.RING_WAVES[p] as number;
      fireOrbs(w, e, MT.RING_ORBS, a.rot, MT.RING_SPEED, MT.RING_DAMAGE);
      b.seqType = 'ring';
      b.seqLeft = waves - 1;
      b.seqTimer = A.RING_WAVE_INTERVAL;
      b.seqStep = 0;
      b.seqAngle = a.rot;
      // Keeps the volley pose while the remaining rings go out.
      e.attack = null;
      e.recover = A.RING_WAVE_INTERVAL * (waves - 1) + A.RING_RECOVER;
      b.chase = 0;
      break;
    }
    case 'spiral':
      b.seqType = 'spiral';
      b.seqLeft = MT.SPIRAL_STEPS;
      b.seqTimer = 0;
      b.seqStep = 0;
      b.seqAngle = a.rot;
      b.seqDir = w.rng.chance(0.5) ? 1 : -1;
      e.attack = null;
      e.recover = MT.SPIRAL_STEPS * MT.SPIRAL_INTERVAL + A.SPIRAL_RECOVER;
      b.chase = 0;
      break;
    case 'wisp': {
      const heroes = w.heroes.filter(isTargetHero);
      const count = Math.min(MT.WISP_COUNT[p] as number, MT.WISP_MAX - wispCount(w));
      for (let i = 0; i < count && heroes.length > 0; i++) {
        const h = heroes[(b.cycle + i) % heroes.length] as Hero;
        const side = a.rot + Math.PI / 2 + (i % 2) * Math.PI;
        const x = e.x + Math.sin(side) * A.WISP_SPAWN_OFFSET * (1 + Math.floor(i / 2));
        const z = e.z + Math.cos(side) * A.WISP_SPAWN_OFFSET * (1 + Math.floor(i / 2));
        spawnProjectile(w, {
          kind: 'soulWisp', x, z, rot: angleTo(x, z, h.body.x, h.body.z), speed: MT.WISP_SPEED, radius: MT.WISP_RADIUS,
          range: MT.WISP_SPEED * MT.WISP_LIFETIME, damage: enemyDamage(e, MT.WISP_DAMAGE), hostile: true, owner: e.id, slot: 'primary',
          pierce: 0, element: 0, stun: 0, knockback: 0, homing: MT.WISP_TURN_DEG * DEG, seek: h.slot, fragile: true,
        });
      }
      b.cycle += count;
      endAttack(e, b, A.WISP_RECOVER);
      break;
    }
    case 'summon':
      summon(w, e);
      endAttack(e, b, A.SUMMON_RECOVER);
      break;
    case 'beam':
      endAttack(e, b, A.BEAM_RECOVER);
      break;
    case 'blasts':
      endAttack(e, b, A.BLAST_RECOVER);
      break;
    default:
      e.attack = null;
      break;
  }
}

/** Follow-up steps of the running pattern: later beam steps, blast waves, ring waves, spiral shots. */
function stepSequence(w: World, e: Enemy, b: BossState, dt: number): void {
  if (b.seqLeft <= 0) return;
  b.seqTimer -= dt;
  if (b.seqTimer > SIM.EPS) return;
  b.seqLeft--;
  b.seqStep++;
  const target = e.attack ? e.attack.target : e.target;
  switch (b.seqType) {
    case 'beam':
      b.seqTimer += MT.BEAM_INTERVAL;
      addBeams(w, e, b, target);
      break;
    case 'blasts':
      b.seqTimer += MT.BLAST_WAVE_INTERVAL;
      addBlasts(w, e, b, b.chargeFromX, b.chargeFromZ, b.seqAngle, SHIFTED, false, -1);
      break;
    case 'ring':
      b.seqTimer += A.RING_WAVE_INTERVAL;
      fireOrbs(w, e, MT.RING_ORBS, b.seqAngle + (b.seqStep * Math.PI) / MT.RING_ORBS, MT.RING_SPEED, MT.RING_DAMAGE);
      break;
    case 'spiral':
      b.seqTimer += MT.SPIRAL_INTERVAL;
      fireOrbs(w, e, MT.SPIRAL_ARMS, b.seqAngle + b.seqStep * MT.SPIRAL_TURN_DEG * DEG * b.seqDir, MT.SPIRAL_SPEED, MT.SPIRAL_DAMAGE);
      break;
    default:
      b.seqLeft = 0;
      break;
  }
}

export function stepMatron(w: World, e: Enemy, b: BossState, dt: number, rate: number): void {
  if (b.pendingPhase > 0) {
    // Phase 2 opens with reinforcements, phase 3 with the double blast lattice.
    if (b.pendingPhase === 2) b.summonCd = 0;
    if (b.pendingPhase === 3) b.cd[MATRON_CD.BLAST] = 0;
    b.gap = Math.max(b.gap, A.PHASE_PAUSE);
    b.pendingPhase = 0;
  }
  stepSequence(w, e, b, dt);
  if (e.attack) {
    e.attack.t -= dt;
    if (e.attack.t <= SIM.EPS) resolve(w, e, b, e.attack);
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
  e.blinkCd -= dt;
  const near = nearestHero(w, e.x, e.z);
  if (near && e.blinkCd <= 0 && Math.hypot(near.body.x - e.x, near.body.z - e.z) < MT.BLINK_TRIGGER) {
    if (tryBlink(w, e, near, MT.BLINK_DISTANCE, MT.BLINK_COOLDOWN, A.BLINK_MIN_HERO_DISTANCE)) {
      b.gap = Math.max(b.gap, A.BLINK_GAP);
      return;
    }
    e.blinkCd = A.BLINK_RETRY_SECONDS;
  }
  b.gap -= rate;
  if (b.gap <= 0) {
    choose(w, e, b, target);
    if (e.attack) return;
  }
  keepDistance(w, e, target, e.def.attackRange, A.KEEP_BAND, false, dt);
}
