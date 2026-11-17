/** Damage, statuses and Resonance. Every change of health goes through this module. */
import { WORLD } from '../constants.ts';
import { BOON_TUNING } from '../data/boons.ts';
import { STATUS } from '../data/enemies.ts';
import type { AbilitySlot, ElementId } from '../types.ts';
import { angleDiff, angleTo, DEG } from './geom.ts';
import { maxDashCharges } from './boons.ts';
import type { Enemy, Hero } from './state.ts';
import { META, SIM } from './tuning.ts';
import type { World } from './world.ts';

export const isBoss = (e: Enemy): boolean => e.boss !== null;

/** Spawning enemies and corpses can neither be hit nor targeted. */
export const isTargetable = (e: Enemy): boolean => !e.dead && e.spawnTime <= 0;

const vulnerability = (e: Enemy): number =>
  e.status === 'storm' ? 1 + STATUS.SHOCK.VULNERABILITY + e.statusBonus : 1;

/** Movement / cooldown slow factor (0..1) from Chill. */
export function chillSlow(e: Enemy): number {
  if (e.status !== 'rime') return 0;
  const slow = Math.min(0.9, STATUS.CHILL.SLOW + e.statusBonus);
  return isBoss(e) ? slow * SIM.BOSS_CHILL_FACTOR : slow;
}

/** Outgoing damage of an enemy attack after chamber scaling, elite bonus and deep_frost. */
export function enemyDamage(e: Enemy, base: number): number {
  const weaken = e.status === 'rime' ? Math.max(0, 1 - e.statusBonus) : 1;
  return base * e.damageMul * weaken;
}

export function setStatus(w: World, e: Enemy, el: ElementId, by: Hero | null, potency: number): void {
  const changed = e.status !== el;
  e.status = el;
  e.statusPotency = potency;
  e.statusBy = by ? by.slot : -1;
  if (el === 'ember') {
    e.statusTime = STATUS.BURN.DURATION;
    e.statusBonus = by ? by.stats.wildfire : 0;
    if (changed) e.burnTimer = SIM.BURN_TICK_SECONDS;
  } else if (el === 'rime') {
    e.statusTime = STATUS.CHILL.DURATION * potency;
    e.statusBonus = by ? by.stats.deepFrost : 0;
  } else {
    e.statusTime = STATUS.SHOCK.DURATION * potency;
    e.statusBonus = by ? by.stats.overcharge : 0;
  }
  if (changed) w.emit({ e: 'status', id: e.id, el });
}

export function clearStatus(e: Enemy): void {
  e.status = null;
  e.statusTime = 0;
  e.statusBonus = 0;
  e.statusBy = -1;
}

export function healHero(w: World, h: Hero, amount: number): number {
  if (h.state !== 'alive' || amount <= 0) return 0;
  const gain = Math.min(h.maxHp - h.hp, amount);
  if (gain <= 0) return 0;
  h.hp += gain;
  w.emit({ e: 'heal', slot: h.slot, amount: Math.max(1, Math.round(gain)) });
  return gain;
}

export function killEnemy(w: World, e: Enemy, by: number): void {
  if (e.dead) return;
  e.dead = true;
  e.hp = 0;
  e.corpseTime = SIM.CORPSE_SECONDS;
  e.attack = null;
  e.stunTime = 0;
  e.kbX = 0;
  e.kbZ = 0;
  clearStatus(e);
  if (e.boss) {
    e.boss.slams.length = 0;
    e.boss.seqLeft = 0;
    if (e.id === w.run.bossId && w.run.chamberKind === 'elite') w.director.elitesSlain++;
  }
  e.anim = 'death';
  e.animSeq++;
  w.emit({ e: 'kill', id: e.id, kind: e.kind, x: e.x, z: e.z, by });
  const killer = w.hero(by);
  if (killer) {
    killer.run.kills++;
    if (killer.stats.leech > 0) healHero(w, killer, killer.stats.leech);
  }
}

/** Unblockable damage (burn ticks, Resonance bursts). `amount` is final except for Shock vulnerability. */
export function rawDamageEnemy(w: World, e: Enemy, amount: number, by: number, el: ElementId | null): void {
  if (!isTargetable(e)) return;
  const dmg = amount * vulnerability(e);
  const dealt = Math.min(e.hp, dmg);
  e.hp -= dmg;
  const src = w.hero(by);
  if (src) src.run.damage += dealt;
  w.emit({ e: 'hit', target: { t: 'e', id: e.id }, x: e.x, z: e.z, dmg: Math.max(1, Math.round(dmg)), crit: false, el, by });
  if (e.hp <= 0) killEnemy(w, e, by);
}

function burst(w: World, x: number, z: number, a: ElementId, b: ElementId, h: Hero, potency: number): void {
  const radius = STATUS.RESONANCE.RADIUS * (1 + h.stats.wideResonance);
  const damage = STATUS.RESONANCE.DAMAGE * (1 + h.stats.amplifier) * (1 + h.meta.might);
  w.emit({ e: 'resonance', x, z, r: radius, a, b, by: h.slot });
  w.emit({ e: 'aoe', x, z, r: radius, el: b, hostile: false });
  for (const o of w.enemies) {
    if (!isTargetable(o)) continue;
    const reach = radius + o.radius;
    const dx = o.x - x;
    const dz = o.z - z;
    if (dx * dx + dz * dz > reach * reach) continue;
    o.resonanceCd = STATUS.RESONANCE.INTERNAL_COOLDOWN;
    rawDamageEnemy(w, o, damage, h.slot, b);
    // Element transfer: everything caught in the burst now carries the new element.
    if (!o.dead) setStatus(w, o, b, h, potency);
  }
}

function resonate(w: World, e: Enemy, el: ElementId, h: Hero, potency: number): void {
  const a = e.status as ElementId;
  const x = e.x;
  const z = e.z;
  clearStatus(e);
  h.run.resonances++;
  burst(w, x, z, a, el, h, potency);
  if (h.stats.echo > 0 && w.rng.chance(h.stats.echo)) burst(w, x, z, a, el, h, potency);
  if (h.stats.aftershock > 0) {
    h.dashCharges = Math.min(maxDashCharges(h), h.dashCharges + 1);
    if (h.dashCharges >= maxDashCharges(h)) h.dashRecharge = 0;
    h.secondaryCd = Math.max(0, h.secondaryCd - h.stats.aftershock * h.secondaryCdMax);
  }
  if (h.stats.sharedVigor > 0) for (const ally of w.heroes) healHero(w, ally, h.stats.sharedVigor);
}

/**
 * Applies an element to an enemy. A different element on a marked enemy detonates it (Resonance) unless the
 * enemy burst (or was caught in a burst) within the internal cooldown, in which case the hit changes nothing.
 */
export function applyElement(w: World, e: Enemy, el: ElementId, h: Hero, potency: number): void {
  if (e.status !== null && e.status !== el) {
    if (e.resonanceCd > SIM.EPS) return;
    resonate(w, e, el, h, potency);
    return;
  }
  if (!e.dead && e.hp > 0) setStatus(w, e, el, h, potency);
}

function interrupt(e: Enemy): void {
  e.attack = null;
  e.poiseDamage = 0;
  if (e.boss) {
    e.boss.slams.length = 0;
    e.boss.seqLeft = 0;
  }
}

export function stunEnemy(e: Enemy, seconds: number): void {
  if (isBoss(e) || e.dead || seconds <= 0) return;
  interrupt(e);
  if (seconds > e.stunTime) e.stunTime = seconds;
  if (e.anim !== 'stun') {
    e.anim = 'stun';
    e.animSeq++;
  }
}

export interface StrikeOpts {
  fromX: number;
  fromZ: number;
  stun: number;
  knockback: number;
}

/**
 * A hero's ability hits an enemy: boon multipliers, crit, shield, poise, stun, knockback, element.
 * Returns false if the enemy could not be hit at all.
 */
export function strikeEnemy(w: World, h: Hero, e: Enemy, base: number, slot: AbilitySlot, opts: StrikeOpts): boolean {
  if (!isTargetable(e)) return false;
  if (w.tutorial && slot === 'secondary') w.tutorial.secondaryHits++;
  let dmg = base * (1 + h.meta.might);
  if (slot === 'primary') dmg *= 1 + h.stats.primaryDamage;
  else if (slot === 'secondary') dmg *= 1 + h.stats.secondaryDamage;
  dmg *= 1 + h.aura;
  if (h.oathbondTime > 0) dmg *= 1 + h.stats.oathbond;
  if (h.stats.execute > 0 && e.hp < e.maxHp * BOON_TUNING.EXECUTE_THRESHOLD) dmg *= 1 + h.stats.execute;
  const crit = h.stats.crit > 0 && w.rng.chance(h.stats.crit);
  if (crit) dmg *= STATUS.CRIT_MULTIPLIER;
  dmg *= vulnerability(e);

  const infusion = h.stats.infusion[slot];
  let blocked = false;
  if (e.shieldHp > 0 && e.stunTime <= 0) {
    const off = Math.abs(angleDiff(angleTo(e.x, e.z, opts.fromX, opts.fromZ), e.rot));
    if (off <= SIM.SHIELD_HALF_ARC_DEG * DEG) {
      const absorbed = Math.min(e.shieldHp, dmg);
      e.shieldHp -= absorbed;
      dmg -= absorbed;
      if (e.shieldHp <= 0) {
        e.shieldHp = 0;
        w.emit({ e: 'shieldBreak', id: e.id });
      }
      blocked = dmg <= 0;
    }
  }

  if (!blocked) {
    const dealt = Math.min(e.hp, dmg);
    e.hp -= dmg;
    h.run.damage += dealt;
    if (e.attack && e.def.poise > 0) {
      e.poiseDamage += dmg;
      if (e.poiseDamage >= e.def.poise * (e.maxHp / e.def.hp)) {
        interrupt(e);
        if (e.stunTime < SIM.STAGGER_SECONDS) e.stunTime = SIM.STAGGER_SECONDS;
        e.attackCd = Math.max(e.attackCd, e.def.cooldown * SIM.STAGGER_COOLDOWN_FRACTION);
        e.anim = 'stun';
        e.animSeq++;
      }
    }
  }
  w.emit({
    e: 'hit', target: { t: 'e', id: e.id }, x: e.x, z: e.z, dmg: blocked ? 0 : Math.max(1, Math.round(dmg)),
    crit: crit && !blocked, el: infusion ? infusion.element : null, by: h.slot,
  });

  if (opts.stun > 0) stunEnemy(e, opts.stun);
  if (opts.knockback > 0 && !isBoss(e)) {
    let dx = e.x - opts.fromX;
    let dz = e.z - opts.fromZ;
    const d = Math.hypot(dx, dz);
    if (d < 1e-4) { dx = Math.sin(h.rot); dz = Math.cos(h.rot); } else { dx /= d; dz /= d; }
    e.kbX += dx * opts.knockback;
    e.kbZ += dz * opts.knockback;
  }
  if (infusion && !blocked) applyElement(w, e, infusion.element, h, infusion.potency);
  if (e.hp <= 0) killEnemy(w, e, h.slot);
  return true;
}

function triggerOathbond(h: Hero): void {
  if (h.stats.oathbond > 0 && h.state === 'alive') h.oathbondTime = BOON_TUNING.OATHBOND_DURATION;
}

export function downHero(w: World, h: Hero): void {
  h.state = 'downed';
  h.hp = 0;
  h.revive = 0;
  h.pending.length = 0;
  h.spin = null;
  h.lunge = null;
  h.lockTime = 0;
  h.lockMoveMul = 1;
  h.body.dashTime = 0;
  h.body.rootTime = 0;
  h.tempShield = 0;
  h.barrier = 0;
  h.invuln = 0;
  h.oathbondTime = 0;
  h.burnTime = 0;
  h.chillTime = 0;
  h.anim = 'downed';
  h.animSeq++;
  h.animTime = 0;
  h.run.downs++;
  w.emit({ e: 'down', slot: h.slot });
  for (const ally of w.heroes) if (ally !== h) triggerOathbond(ally);
  if (w.run.secondWinds > 0) {
    w.run.secondWinds--;
    h.secondWindTimer = SIM.SECOND_WIND_DELAY;
    w.runVersion++;
  }
}

export function reviveHero(w: World, h: Hero, by: number, hpFraction: number, iframes: number): void {
  if (h.state !== 'downed') return;
  h.state = 'alive';
  // Resolve (permanent upgrade): more health and a guaranteed window of invulnerability on every revive.
  h.hp = Math.max(1, Math.min(h.maxHp, Math.round(h.maxHp * hpFraction * (1 + h.meta.resolve))));
  h.revive = 0;
  h.secondWindTimer = 0;
  h.invuln = h.meta.resolve > 0 ? Math.max(iframes, META.RESOLVE_INVULNERABILITY) : iframes;
  h.barrierDelay = BOON_TUNING.BARRIER_RECHARGE_DELAY;
  h.anim = 'idle';
  h.animSeq++;
  h.oathbondArmed = h.hp >= h.maxHp * SIM.OATHBOND_HP_THRESHOLD;
  w.emit({ e: 'revived', slot: h.slot, by });
}

/**
 * An enemy attack lands on a hero. Returns false when it was avoided (i-frames, downed, disconnected).
 * `by` is the attacking enemy's id (or -1).
 */
export function damageHero(w: World, h: Hero, amount: number, by: number): boolean {
  if (h.state !== 'alive' || !h.connected || h.invuln > SIM.EPS || w.run.phase !== 'combat' || amount <= 0) return false;
  let dmg = amount;
  if (h.tempShield > 0) {
    const absorbed = Math.min(h.tempShield, dmg);
    h.tempShield -= absorbed;
    dmg -= absorbed;
  }
  if (h.barrier > 0 && dmg > 0) {
    const absorbed = Math.min(h.barrier, dmg);
    h.barrier -= absorbed;
    dmg -= absorbed;
  }
  h.barrierDelay = BOON_TUNING.BARRIER_RECHARGE_DELAY;
  h.invuln = WORLD.HIT_IFRAME_SECONDS;
  h.damageTaken += amount;
  w.emit({ e: 'hit', target: { t: 'p', id: h.slot }, x: h.body.x, z: h.body.z, dmg: Math.max(1, Math.round(amount)), crit: false, el: null, by });
  if (dmg <= 0) return true;
  loseHealth(w, h, dmg);
  return true;
}

/** Health loss after shields: hit animation, last stand, the tutorial's floor at 1 health, downing, oathbond. */
function loseHealth(w: World, h: Hero, dmg: number): void {
  h.hp -= dmg;
  if (h.animTime <= 0) {
    h.anim = 'hit';
    h.animSeq++;
    h.animTime = SIM.HIT_ANIM_SECONDS;
  }
  if (h.hp <= 0) {
    if (w.tutorial) {
      // Nobody dies in the training session.
      h.hp = 1;
    } else if (h.stats.lastStand && !h.lastStandUsed) {
      h.lastStandUsed = true;
      h.hp = 1;
      h.invuln = BOON_TUNING.LAST_STAND_INVULNERABILITY;
    } else {
      downHero(w, h);
      return;
    }
  }
  if (h.oathbondArmed && h.hp < h.maxHp * SIM.OATHBOND_HP_THRESHOLD) {
    h.oathbondArmed = false;
    triggerOathbond(h);
  }
}

/**
 * Damage over time on a hero (burning after a fire vent). Shields absorb it, but i-frames do not stop it and it
 * grants none.
 */
export function dotHero(w: World, h: Hero, amount: number, el: ElementId): void {
  if (h.state !== 'alive' || w.run.phase !== 'combat' || amount <= 0) return;
  let dmg = amount;
  if (h.tempShield > 0) {
    const absorbed = Math.min(h.tempShield, dmg);
    h.tempShield -= absorbed;
    dmg -= absorbed;
  }
  if (h.barrier > 0 && dmg > 0) {
    const absorbed = Math.min(h.barrier, dmg);
    h.barrier -= absorbed;
    dmg -= absorbed;
  }
  h.barrierDelay = BOON_TUNING.BARRIER_RECHARGE_DELAY;
  h.damageTaken += amount;
  w.emit({ e: 'hit', target: { t: 'p', id: h.slot }, x: h.body.x, z: h.body.z, dmg: Math.max(1, Math.round(amount)), crit: false, el, by: -1 });
  if (dmg > 0) loseHealth(w, h, dmg);
}
