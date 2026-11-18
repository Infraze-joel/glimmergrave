/**
 * Enemy lifecycle and the AI of the four rank-and-file kinds.
 * Fairness rule: every damaging attack emits a `telegraph` when its windup starts and only hurts heroes that are
 * still inside the announced shape when the windup ends (projectiles: on contact, along the announced line).
 */
import { RUN, TICK_DT, WORLD } from '../constants.ts';
import { ENEMIES, ENEMY_TUNING, STATUS } from '../data/enemies.ts';
import { AFFIX_IDS, type AffixId, type ElementId, type EnemyAnim, type EnemyKind, type GameEvent, type Hazard } from '../types.ts';
import { BUFFS } from '../data/classes.ts';
import { chillSlow, clearStatus, damageHero, enemyDamage, isBoss, moveSlow, rawDamageEnemy } from './combat.ts';
import { stepBoss, createBossState } from './boss.ts';
import { angleTo, closestT, DEG, inArc, inLine, sweepHit, TAU } from './geom.ts';
import { firstSpecial, flyReaver, isHorde, resolveHordeAttack, stepDome, stepHorde } from './horde.ts';
import { resolveCollisions } from './movement.ts';
import { damageAnchor, standingAnchor } from './objectives.ts';
import { spawnProjectile } from './projectiles.ts';
import type { AttackShape, Enemy, EnemyAttack, Hero } from './state.ts';
import { AFFIX, AI, SIM } from './tuning.ts';
import type { World } from './world.ts';

/** Spreads perfectly stacked enemies apart in distinct directions. */
const GOLDEN_ANGLE = 2.399963;

export interface SpawnOpts {
  elite?: boolean;
  summoned?: boolean;
  /** Boss kinds only: the weakened phase-1 version fought in the second elite chamber. */
  herald?: boolean;
  /** Tutorial: no AI (training dummy) / ignores hazards (chaser). */
  passive?: boolean;
  reckless?: boolean;
  /** Pins the affix of an elite or champion (tests); otherwise it is drawn when the chamber calls for affixes. */
  affix?: AffixId;
  /** Warded against this element (rank and file only; ignored for bosses and champions). */
  ward?: ElementId;
  /** Defend objective: attacks the bell shard instead of the heroes while it stands. */
  siege?: boolean;
  /** Hunt objective: a marked target. `hpMul` multiplies its health on top of everything else. */
  marked?: boolean;
  hpMul?: number;
  /** Id of the necromancer that raised it. */
  master?: number;
}

/** What an enemy goes for: a hero, or the bell shard of a `defend` chamber (slot -1). */
export interface TargetLike {
  body: { x: number; z: number };
  slot: number;
}

/** The bell shard as a target (position refreshed before every use). */
const SHARD: TargetLike = { body: { x: 0, z: 0 }, slot: -1 };

const BOSS_KINDS_ALL: ReadonlySet<EnemyKind> = new Set<EnemyKind>(['champion', 'regent', 'matron', 'stalker']);

export function setAnim(e: Enemy, anim: EnemyAnim): void {
  if (e.anim === anim) return;
  e.anim = anim;
  e.animSeq++;
}

export function livingEnemies(w: World): number {
  let n = 0;
  for (const e of w.enemies) if (!e.dead) n++;
  return n;
}

export function spawnEnemy(w: World, kind: EnemyKind, x: number, z: number, opts: SpawnOpts = {}): Enemy | null {
  if (w.enemies.length >= WORLD.MAX_ENEMIES) {
    const corpse = w.enemies.findIndex((e) => e.dead);
    if (corpse < 0) return null;
    w.enemies.splice(corpse, 1);
  }
  const def = ENEMIES[kind];
  const boss = BOSS_KINDS_ALL.has(kind);
  const herald = boss && kind !== 'champion' && opts.herald === true;
  const elite = opts.elite === true;
  const eliteHp = elite && !boss ? ENEMY_TUNING.ELITE_HP_MUL : 1;
  const eliteDamage = elite && !boss ? ENEMY_TUNING.ELITE_DAMAGE_MUL : 1;
  // Bosses swap the party health scaling of the rank and file for their own, steeper one.
  const party = w.partySize - 1;
  const bossParty = boss ? (1 + ENEMY_TUNING.BOSS_HP_PER_EXTRA_PLAYER * party) / (1 + RUN.HP_PER_EXTRA_PLAYER * party) : 1;
  const maxHp = def.hp * w.hpMul * eliteHp * bossParty * (herald ? ENEMY_TUNING.HERALD.HP_FRACTION : 1) * (opts.hpMul ?? 1);
  const ward = !boss && opts.ward !== undefined ? opts.ward : null;
  // Elites and champions carry an affix once the run is deep or sworn enough (drawn only then, so shallow runs keep their random stream).
  let affix: AffixId | null = opts.affix ?? null;
  if (!affix && w.affixed && (kind === 'champion' || (elite && !boss))) affix = w.rng.pick(AFFIX_IDS);
  if (affix) w.affixes++;
  const e: Enemy = {
    id: w.nextEnemyId++, kind, def, x, z, rot: 0, hp: maxHp, maxHp, radius: def.radius, elite,
    damageMul: w.damageMul * eliteDamage, speedMul: w.speedMul * (affix === 'swift' ? AFFIX.SWIFT_SPEED : 1), anim: 'spawn', animSeq: 0, dead: false, corpseTime: 0,
    spawnTime: def.spawnTime, stunTime: 0, attackCd: w.rng.range(AI.FIRST_ATTACK_DELAY_MIN, AI.FIRST_ATTACK_DELAY_MAX),
    recover: 0, attack: null, poiseDamage: 0, target: -1, retarget: 0,
    shieldHp: kind === 'warrior' ? ENEMY_TUNING.WARRIOR_SHIELD_HP * w.hpMul * eliteHp : 0,
    status: null, statusTime: 0, statusPotency: 1, statusBy: -1, statusBonus: 0, burnTimer: 0, resonanceCd: 0,
    kbX: 0, kbZ: 0, blinkCd: ENEMY_TUNING.MAGE_BLINK_COOLDOWN / 2, strafeDir: w.rng.chance(0.5) ? 1 : -1, strafeTime: 0,
    boss: boss ? createBossState(kind, herald) : null, summoned: opts.summoned === true,
    passive: opts.passive === true, reckless: opts.reckless === true,
    affix, armored: affix === 'armored', markTime: 0, markBy: -1, sunder: 0, sunderTime: 0, rootTime: 0, slow: 0, slowTime: 0,
    smokeTime: 0, statusPower: 1, statusWeaken: 0, struckBy: 0,
    ward, siege: opts.siege === true && !boss, marked: opts.marked === true, enraged: false, domeOn: false, domeCd: 0, domed: false,
    specialCd: firstSpecial(kind), master: opts.master ?? -1, leapFromX: x, leapFromZ: z, leapTime: 0, mends: 0, wardCd: 0,
  };
  if (w.nextEnemyId > 0xffff) w.nextEnemyId = 1;
  resolveCollisions(e, e.radius, w.room);
  const nearest = nearestHero(w, e.x, e.z);
  if (nearest) e.rot = angleTo(e.x, e.z, nearest.body.x, nearest.body.z);
  w.enemies.push(e);
  const ev: Extract<GameEvent, { e: 'spawn' }> = { e: 'spawn', id: e.id, kind, x: e.x, z: e.z, elite };
  if (affix) ev.affix = affix;
  if (ward) ev.ward = ward;
  w.emit(ev);
  return e;
}

export const isTargetHero = (h: Hero): boolean => h.state === 'alive' && h.connected;

export function nearestHero(w: World, x: number, z: number): Hero | null {
  let best: Hero | null = null;
  let bestD = Infinity;
  for (const h of w.heroes) {
    if (!isTargetHero(h)) continue;
    const dx = h.body.x - x;
    const dz = h.body.z - z;
    const d = dx * dx + dz * dz;
    if (d < bestD) { bestD = d; best = h; }
  }
  return best;
}

/** A knight whose banner (bulwark ultimate) is up and close enough to force this enemy onto him, if any. */
export function taunting(w: World, e: Enemy): Hero | null {
  for (const h of w.heroes) {
    if (h.taunt <= 0 || !isTargetHero(h)) continue;
    const dx = h.body.x - e.x;
    const dz = h.body.z - e.z;
    if (dx * dx + dz * dz <= BUFFS.bulwark.tauntRadius * BUFFS.bulwark.tauntRadius) return h;
  }
  return null;
}

/** Nearest living hero with stickiness: the current target is kept unless another hero is clearly closer. */
export function pickTarget(w: World, e: Enemy, dt: number): Hero | null {
  const taunter = taunting(w, e);
  if (taunter) {
    e.target = taunter.slot;
    return taunter;
  }
  const current = w.hero(e.target);
  e.retarget -= dt;
  if (current && isTargetHero(current) && e.retarget > 0) return current;
  e.retarget = AI.RETARGET_SECONDS;
  const nearest = nearestHero(w, e.x, e.z);
  if (!nearest) { e.target = -1; return null; }
  if (current && isTargetHero(current) && current !== nearest) {
    const dc = Math.hypot(current.body.x - e.x, current.body.z - e.z);
    const dn = Math.hypot(nearest.body.x - e.x, nearest.body.z - e.z);
    if (dn > dc * AI.STICKINESS) return current;
  }
  e.target = nearest.slot;
  return nearest;
}

/**
 * Moves `e` towards (tx, tz) at `speed`: seek + separation from other enemies + tangential obstacle avoidance.
 * `seekWeight` 0 keeps only the separation (holding a position inside a crowd).
 */
export function steer(w: World, e: Enemy, tx: number, tz: number, speed: number, seekWeight: number): void {
  let dx = tx - e.x;
  let dz = tz - e.z;
  const d = Math.hypot(dx, dz);
  let vx = 0;
  let vz = 0;
  if (d > 1e-3 && seekWeight > 0) {
    dx /= d;
    dz /= d;
    vx = dx * seekWeight;
    vz = dz * seekWeight;
    const look = Math.min(d, AI.AVOID_LOOKAHEAD);
    for (const o of w.room.obstacles) {
      const clearance = o.r + e.radius + AI.AVOID_PAD;
      const t = closestT(e.x, e.z, e.x + dx * look, e.z + dz * look, o.x, o.z);
      const cx = e.x + dx * look * t;
      const cz = e.z + dz * look * t;
      const gap = Math.hypot(o.x - cx, o.z - cz);
      if (gap >= clearance || t <= 0) continue;
      // Slide around the obstacle on the side we are already leaning to (stable choice, so no dithering).
      const cross = dx * (o.z - e.z) - dz * (o.x - e.x);
      const side = Math.abs(cross) > AI.AVOID_SIDE_EPSILON ? Math.sign(cross) : (e.id & 1) === 0 ? 1 : -1;
      const push = AI.AVOID_PUSH * (1 - gap / clearance) + AI.AVOID_PUSH_MIN;
      vx += -dz * side * -push;
      vz += dx * side * -push;
    }
    // Warning / active hazards are walked around like obstacles, unless the destination itself lies inside
    // (lured in) or the enemy is immune (bosses) or reckless.
    if (w.hazardsLive > 0 && !e.boss && !e.reckless) {
      const hazards = w.room.hazards;
      for (let i = 0; i < hazards.length; i++) {
        if ((w.hazardPhase[i] as number) === 0) continue;
        const hz = hazards[i] as Hazard;
        const clearance = hz.r + e.radius + AI.HAZARD_PAD;
        const lureX = tx - hz.x;
        const lureZ = tz - hz.z;
        if (lureX * lureX + lureZ * lureZ < clearance * clearance) continue;
        const ox = e.x - hz.x;
        const oz = e.z - hz.z;
        const od = Math.hypot(ox, oz);
        if (od < clearance) {
          // Standing in it: get out by the shortest way.
          if (od > 1e-3) { vx += (ox / od) * AI.HAZARD_PUSH; vz += (oz / od) * AI.HAZARD_PUSH; }
          continue;
        }
        const t = closestT(e.x, e.z, e.x + dx * look, e.z + dz * look, hz.x, hz.z);
        if (t <= 0) continue;
        const gap = Math.hypot(hz.x - (e.x + dx * look * t), hz.z - (e.z + dz * look * t));
        if (gap >= clearance) continue;
        const cross = dx * (hz.z - e.z) - dz * (hz.x - e.x);
        const side = Math.abs(cross) > AI.AVOID_SIDE_EPSILON ? Math.sign(cross) : (e.id & 1) === 0 ? 1 : -1;
        const push = AI.AVOID_PUSH * (1 - gap / clearance) + AI.AVOID_PUSH_MIN;
        vx += -dz * side * -push;
        vz += dx * side * -push;
      }
    }
  }
  for (const o of w.enemies) {
    if (o === e || o.dead) continue;
    const min = e.radius + o.radius + AI.SEPARATION_PAD;
    const ox = e.x - o.x;
    const oz = e.z - o.z;
    const d2 = ox * ox + oz * oz;
    if (d2 >= min * min) continue;
    // Bosses plough through the rank and file instead of being herded by it.
    if (isBoss(e) && !isBoss(o)) continue;
    if (d2 < 1e-6) {
      const a = (e.id * GOLDEN_ANGLE) % TAU;
      vx += Math.sin(a) * AI.SEPARATION_WEIGHT;
      vz += Math.cos(a) * AI.SEPARATION_WEIGHT;
      continue;
    }
    const od = Math.sqrt(d2);
    const f = (AI.SEPARATION_WEIGHT * (1 - od / min)) / od;
    vx += ox * f;
    vz += oz * f;
  }
  const len = Math.hypot(vx, vz);
  if (len < 1e-3) return;
  const scale = (Math.min(1, len) / len) * speed * TICK_DT;
  e.x += vx * scale;
  e.z += vz * scale;
}

/** Current speed: Chill, the bell's slow and smoke slow it; an entombed (rooted) enemy does not move at all. */
export const enemySpeed = (e: Enemy): number => (e.rootTime > 0 ? 0 : e.def.speed * e.speedMul * (1 - moveSlow(e)));

/** Distance a ray from (x, z) along `rot` travels before it hits a wall or (optionally) an obstacle. */
export function rayLength(w: World, x: number, z: number, rot: number, max: number, obstacles: boolean): number {
  const dirX = Math.sin(rot);
  const dirZ = Math.cos(rot);
  const hx = w.room.w / 2;
  const hz = w.room.d / 2;
  let len = max;
  if (dirX > 1e-6) len = Math.min(len, (hx - x) / dirX);
  else if (dirX < -1e-6) len = Math.min(len, (-hx - x) / dirX);
  if (dirZ > 1e-6) len = Math.min(len, (hz - z) / dirZ);
  else if (dirZ < -1e-6) len = Math.min(len, (-hz - z) / dirZ);
  len = Math.max(0, len);
  if (obstacles) {
    for (const o of w.room.obstacles) {
      const t = sweepHit(x, z, x + dirX * len, z + dirZ * len, o.x, o.z, o.r);
      if (t >= 0) len *= t;
    }
  }
  return len;
}

export function hasLineOfSight(w: World, ax: number, az: number, bx: number, bz: number, pad: number): boolean {
  for (const o of w.room.obstacles) if (sweepHit(ax, az, bx, bz, o.x, o.z, o.r + pad) >= 0) return false;
  return true;
}

/** Starts a wound-up attack and announces it. `shape` null = harmless cast (summon). */
export function beginAttack(w: World, e: Enemy, attack: EnemyAttack, shape: AttackShape | null, anim: EnemyAnim): void {
  e.attack = attack;
  e.poiseDamage = 0;
  e.anim = anim;
  e.animSeq++;
  if (shape) emitTelegraph(w, e, attack, shape);
}

export function emitTelegraph(w: World, e: Enemy, a: EnemyAttack, shape: AttackShape): void {
  w.emit({ e: 'telegraph', shape, x: a.x, z: a.z, rot: a.rot, r: a.r, w: a.w, dur: a.t, src: e.id });
}

/** Damages every hero whose centre is inside the attack's shape right now. */
export function landAttack(w: World, e: Enemy, a: EnemyAttack, shape: AttackShape): void {
  const dmg = enemyDamage(e, a.damage);
  for (const h of w.heroes) {
    if (!isTargetHero(h)) continue;
    const hx = h.body.x;
    const hz = h.body.z;
    let inside: boolean;
    if (shape === 'arc') inside = inArc(a.x, a.z, a.rot, a.r, a.w, hx, hz, 0);
    else if (shape === 'circle') inside = (hx - a.x) * (hx - a.x) + (hz - a.z) * (hz - a.z) <= a.r * a.r;
    else inside = inLine(a.x, a.z, a.rot, a.r, a.w, hx, hz, 0);
    if (inside) damageHero(w, h, dmg, e.id, shape === 'arc');
  }
  // An attack that was aimed at the bell shard hurts it when it is inside the announced shape.
  if (e.siege && a.target < 0) {
    const shard = standingAnchor(w);
    if (!shard) return;
    let inside: boolean;
    if (shape === 'arc') inside = inArc(a.x, a.z, a.rot, a.r, a.w, shard.x, shard.z, shard.r);
    else if (shape === 'circle') inside = Math.hypot(shard.x - a.x, shard.z - a.z) <= a.r + shard.r;
    else inside = inLine(a.x, a.z, a.rot, a.r, a.w, shard.x, shard.z, shard.r);
    if (inside) damageAnchor(w, dmg);
  }
}

function finishAttack(e: Enemy, anim: EnemyAnim): void {
  e.attack = null;
  e.recover = AI.RECOVER_SECONDS;
  e.attackCd = e.def.cooldown;
  e.anim = anim;
  e.animSeq++;
}

/** Arc of the basic melee swing per kind: reach beyond the attack range and total angle (degrees). */
function meleeArc(kind: EnemyKind): { reach: number; deg: number } {
  if (kind === 'warrior') return WARRIOR_ARC;
  if (kind === 'aegis') return AEGIS_ARC;
  if (kind === 'reaver') return REAVER_ARC;
  return MINION_ARC;
}
const MINION_ARC = { reach: AI.MINION_REACH_BONUS, deg: ENEMY_TUNING.MINION_ARC_DEG };
const WARRIOR_ARC = { reach: AI.WARRIOR_REACH_BONUS, deg: ENEMY_TUNING.WARRIOR_ARC_DEG };
const AEGIS_ARC = { reach: AI.AEGIS.REACH_BONUS, deg: AI.AEGIS.ARC_DEG };
const REAVER_ARC = { reach: AI.REAVER.REACH_BONUS, deg: AI.REAVER.ARC_DEG };

/** Walks up to the target and swings. `pad` is the target's own radius (the bell shard; 0 for heroes). */
export function stepMelee(w: World, e: Enemy, target: TargetLike, pad = 0): void {
  const tx = target.body.x;
  const tz = target.body.z;
  const d = Math.hypot(tx - e.x, tz - e.z) - pad;
  e.rot = angleTo(e.x, e.z, tx, tz);
  const hero = target.slot >= 0;
  if (e.attackCd <= 0 && d <= e.def.attackRange && (!hero || (w.meleeWindups[target.slot] ?? 0) < AI.MAX_MELEE_WINDUPS_PER_HERO)) {
    const arc = meleeArc(e.kind);
    if (hero) w.meleeWindups[target.slot] = (w.meleeWindups[target.slot] ?? 0) + 1;
    beginAttack(w, e, { type: 'melee', t: e.def.windup, x: e.x, z: e.z, rot: e.rot, r: e.def.attackRange + arc.reach + pad, w: arc.deg * DEG, damage: e.def.damage, target: target.slot }, 'arc', 'windup');
    return;
  }
  if (d > e.def.attackRange * AI.MELEE_STOP_FRACTION) {
    steer(w, e, tx, tz, enemySpeed(e), 1);
    setAnim(e, 'move');
  } else {
    steer(w, e, tx, tz, enemySpeed(e), 0);
    setAnim(e, 'idle');
  }
}

/** Shared ranged positioning: hold a distance band around the target, strafing inside it. */
export function keepDistance(w: World, e: Enemy, target: TargetLike, keep: number, band: number, strafe: boolean, dt: number): void {
  const tx = target.body.x;
  const tz = target.body.z;
  const dx = e.x - tx;
  const dz = e.z - tz;
  const d = Math.hypot(dx, dz) || 1;
  const speed = enemySpeed(e);
  const los = hasLineOfSight(w, e.x, e.z, tx, tz, AI.ARROW_RADIUS);
  const beforeX = e.x;
  const beforeZ = e.z;
  if (!los || d > keep + band) {
    steer(w, e, tx, tz, speed, 1);
  } else if (d < keep - band) {
    const ax = e.x + (dx / d) * AI.KITE_STEP;
    const az = e.z + (dz / d) * AI.KITE_STEP;
    const hx = w.room.w / 2 - e.radius - AI.KITE_WALL_MARGIN;
    const hz = w.room.d / 2 - e.radius - AI.KITE_WALL_MARGIN;
    if (Math.abs(ax) > hx || Math.abs(az) > hz) {
      // Cornered against a wall: slide sideways instead of pushing into it.
      steer(w, e, e.x + (-dz / d) * e.strafeDir * AI.KITE_STEP, e.z + (dx / d) * e.strafeDir * AI.KITE_STEP, speed, 1);
    } else {
      steer(w, e, ax, az, speed, 1);
    }
  } else if (strafe) {
    steer(w, e, e.x + (-dz / d) * e.strafeDir * AI.KITE_STEP, e.z + (dx / d) * e.strafeDir * AI.KITE_STEP, speed * AI.STRAFE_SPEED_FACTOR, 1);
  } else {
    steer(w, e, tx, tz, speed, 0);
  }
  resolveCollisions(e, e.radius, w.room);
  const moved = Math.hypot(e.x - beforeX, e.z - beforeZ);
  e.strafeTime -= dt;
  if (e.strafeTime <= 0 || (moved < speed * dt * AI.STUCK_FACTOR && d <= keep + band)) {
    e.strafeTime = AI.ARCHER_STRAFE_SECONDS;
    e.strafeDir = -e.strafeDir;
  }
  setAnim(e, moved > speed * dt * AI.MOVING_FACTOR ? 'move' : 'idle');
  e.rot = angleTo(e.x, e.z, tx, tz);
}

function stepArcher(w: World, e: Enemy, target: TargetLike, dt: number): void {
  const tx = target.body.x;
  const tz = target.body.z;
  const d = Math.hypot(tx - e.x, tz - e.z);
  if (e.attackCd <= 0 && d <= e.def.attackRange && hasLineOfSight(w, e.x, e.z, tx, tz, AI.ARROW_RADIUS)) {
    const rot = angleTo(e.x, e.z, tx, tz);
    e.rot = rot;
    const length = rayLength(w, e.x, e.z, rot, AI.ARROW_RANGE, true);
    beginAttack(w, e, { type: 'shoot', t: e.def.windup, x: e.x, z: e.z, rot, r: length, w: AI.ARROW_TELEGRAPH_WIDTH, damage: e.def.damage, target: target.slot }, 'line', 'windup');
    return;
  }
  keepDistance(w, e, target, ENEMY_TUNING.ARCHER_KEEP_DISTANCE, AI.ARCHER_BAND, true, dt);
}

export function tryBlink(w: World, e: Enemy, threat: Hero, distance: number = ENEMY_TUNING.MAGE_BLINK_DISTANCE, cooldown: number = ENEMY_TUNING.MAGE_BLINK_COOLDOWN, minHeroDistance: number = AI.MAGE_BLINK_MIN_HERO_DISTANCE): boolean {
  const base = angleTo(threat.body.x, threat.body.z, e.x, e.z);
  const hx = w.room.w / 2 - e.radius - AI.MAGE_BLINK_WALL_MARGIN;
  const hz = w.room.d / 2 - e.radius - AI.MAGE_BLINK_WALL_MARGIN;
  for (const off of AI.MAGE_BLINK_ANGLES) {
    const a = base + off * DEG;
    const x = e.x + Math.sin(a) * distance;
    const z = e.z + Math.cos(a) * distance;
    if (Math.abs(x) > hx || Math.abs(z) > hz) continue;
    let free = true;
    for (const o of w.room.obstacles) if (Math.hypot(o.x - x, o.z - z) < o.r + e.radius + AI.MAGE_BLINK_OBSTACLE_MARGIN) { free = false; break; }
    if (!free) continue;
    for (const h of w.heroes) {
      if (isTargetHero(h) && Math.hypot(h.body.x - x, h.body.z - z) < minHeroDistance) { free = false; break; }
    }
    if (!free) continue;
    e.x = x;
    e.z = z;
    e.rot = angleTo(x, z, threat.body.x, threat.body.z);
    e.blinkCd = cooldown;
    w.emit({ e: 'cast', who: { t: 'e', id: e.id }, ability: 'blink', x, z, rot: e.rot });
    return true;
  }
  return false;
}

function stepMage(w: World, e: Enemy, target: TargetLike, dt: number): void {
  e.blinkCd -= dt;
  const near = nearestHero(w, e.x, e.z);
  if (near && e.blinkCd <= 0 && Math.hypot(near.body.x - e.x, near.body.z - e.z) < AI.MAGE_BLINK_TRIGGER) {
    if (tryBlink(w, e, near)) return;
    e.blinkCd = AI.MAGE_BLINK_RETRY_SECONDS;
  }
  const tx = target.body.x;
  const tz = target.body.z;
  const d = Math.hypot(tx - e.x, tz - e.z);
  if (e.attackCd <= 0 && d <= e.def.attackRange) {
    e.rot = angleTo(e.x, e.z, tx, tz);
    beginAttack(w, e, { type: 'blast', t: e.def.windup, x: tx, z: tz, rot: 0, r: ENEMY_TUNING.MAGE_BLAST_RADIUS, w: 0, damage: e.def.damage, target: target.slot }, 'circle', 'cast');
    return;
  }
  keepDistance(w, e, target, AI.MAGE_KEEP_DISTANCE, AI.MAGE_BAND, false, dt);
}

/** Resolves a finished windup of a rank-and-file enemy. */
function resolveAttack(w: World, e: Enemy, a: EnemyAttack): void {
  switch (a.type) {
    case 'melee':
      landAttack(w, e, a, 'arc');
      break;
    case 'shoot':
      spawnProjectile(w, {
        kind: 'boneArrow', x: e.x, z: e.z, rot: a.rot, speed: ENEMY_TUNING.ARROW_SPEED, radius: AI.ARROW_RADIUS, range: a.r,
        damage: enemyDamage(e, a.damage), hostile: true, owner: e.id, slot: 'primary', pierce: 0, element: 0, stun: 0, knockback: 0,
      });
      break;
    case 'blast':
      w.emit({ e: 'aoe', x: a.x, z: a.z, r: a.r, el: null, hostile: true });
      landAttack(w, e, a, 'circle');
      break;
    default: {
      const recover = resolveHordeAttack(w, e, a);
      if (recover < 0) return;
      finishAttack(e, 'attack');
      e.recover = recover;
      return;
    }
  }
  finishAttack(e, 'attack');
}

export function stepEnemy(w: World, e: Enemy): void {
  const dt = TICK_DT;
  if (e.dead) {
    e.corpseTime -= dt;
    return;
  }
  if (e.kind === 'aegis') stepDome(w, e, dt);
  if (e.status !== null) {
    e.statusTime -= dt;
    if (e.status === 'ember') {
      e.burnTimer -= dt;
      if (e.burnTimer <= SIM.EPS) {
        e.burnTimer += SIM.BURN_TICK_SECONDS;
        const src = w.hero(e.statusBy);
        rawDamageEnemy(w, e, STATUS.BURN.DPS * e.statusPotency * e.statusPower * (1 + e.statusBonus) * (src ? 1 + src.mods.damage : 1) * SIM.BURN_TICK_SECONDS, e.statusBy, 'ember');
        if (e.dead) return;
      }
    }
    if (e.statusTime <= SIM.EPS) clearStatus(e);
  }
  if (e.resonanceCd > 0) e.resonanceCd -= dt;
  if (e.wardCd > 0) e.wardCd -= dt;
  if (e.markTime > 0) e.markTime -= dt;
  if (e.sunderTime > 0) e.sunderTime -= dt;
  if (e.rootTime > 0) e.rootTime -= dt;
  if (e.slowTime > 0) e.slowTime -= dt;
  if (e.smokeTime > 0) e.smokeTime -= dt;
  if (e.spawnTime > 0) {
    e.spawnTime -= dt;
    if (e.spawnTime <= SIM.EPS) {
      e.spawnTime = 0;
      setAnim(e, 'idle');
    }
    return;
  }
  if (e.kbX !== 0 || e.kbZ !== 0) {
    const left = Math.hypot(e.kbX, e.kbZ);
    const step = Math.min(left, SIM.KNOCKBACK_SPEED * dt);
    e.x += (e.kbX / left) * step;
    e.z += (e.kbZ / left) * step;
    if (left - step < 1e-3) { e.kbX = 0; e.kbZ = 0; } else { e.kbX *= (left - step) / left; e.kbZ *= (left - step) / left; }
    resolveCollisions(e, e.radius, w.room);
  }
  if (e.stunTime > 0) {
    e.stunTime -= dt;
    if (e.stunTime <= SIM.EPS) {
      e.stunTime = 0;
      setAnim(e, 'idle');
    }
    return;
  }
  if (e.boss) {
    stepBoss(w, e, dt);
    resolveCollisions(e, e.radius, w.room);
    return;
  }
  // Training dummies have no will of their own; the tutorial script drives whatever they do.
  if (e.passive) return;
  if (e.attack) {
    e.attack.t -= dt;
    if (e.attack.type === 'pounce') flyReaver(e, e.attack);
    if (e.attack.t <= SIM.EPS) resolveAttack(w, e, e.attack);
    return;
  }
  if (e.recover > 0) {
    e.recover -= dt;
    return;
  }
  if (e.attackCd > 0) e.attackCd -= dt * (1 - chillSlow(e)) * (e.affix === 'swift' ? AFFIX.SWIFT_ATTACK_RATE : 1);
  // Siege enemies of a `defend` chamber go for the bell shard while it stands (a knight's banner still pulls them off).
  const shard = e.siege ? standingAnchor(w) : null;
  let target: TargetLike | null = pickTarget(w, e, dt);
  let pad = 0;
  if (shard && !(target && taunting(w, e))) {
    SHARD.body.x = shard.x;
    SHARD.body.z = shard.z;
    target = SHARD;
    pad = shard.r;
  }
  if (!target) {
    setAnim(e, 'idle');
    return;
  }
  if (e.kind === 'archer') stepArcher(w, e, target, dt);
  else if (e.kind === 'mage') stepMage(w, e, target, dt);
  else if (isHorde(e.kind)) stepHorde(w, e, target, pad, dt);
  else stepMelee(w, e, target, pad);
  resolveCollisions(e, e.radius, w.room);
}
