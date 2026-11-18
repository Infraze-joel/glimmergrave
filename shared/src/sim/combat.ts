/** Damage, statuses, reactions and the ultimate charge. Every change of health goes through this module. */
import { WORLD } from '../constants.ts';
import { BOON_TUNING } from '../data/boons.ts';
import { BACKSTAB, BUFFS, SMOKE, ULTIMATE } from '../data/classes.ts';
import { ENEMY_TUNING, STATUS } from '../data/enemies.ts';
import { REACTION_TUNING, reactionOf } from '../data/reactions.ts';
import { RELIC_TUNING } from '../data/relics.ts';
import type { AbilitySlot, ElementId } from '../types.ts';
import { angleDiff, angleTo, DEG } from './geom.ts';
import { maxDashCharges } from './boons.ts';
import { onHordeDeath } from './horde.ts';
import { earn } from './meta.ts';
import { rollCursedShard, rollShards } from './loot.ts';
import type { Enemy, Hero } from './state.ts';
import { AFFIX, META, SIM, TALENT } from './tuning.ts';
import type { World } from './world.ts';

export const isBoss = (e: Enemy): boolean => e.boss !== null;

/** Spawning enemies and corpses can neither be hit nor targeted. */
export const isTargetable = (e: Enemy): boolean => !e.dead && e.spawnTime <= 0;

/** Incoming damage multiplier: Shock, Sunder, Death Mark, and the `armored` guard. */
function vulnerability(e: Enemy): number {
  let v = e.status === 'storm' ? 1 + STATUS.SHOCK.VULNERABILITY * e.statusPower + e.statusBonus : 1;
  if (e.sunderTime > 0) v *= 1 + e.sunder;
  if (e.markTime > 0) v *= 1 + ULTIMATE.MARK_VULNERABILITY;
  if (e.armored) v *= 1 - AFFIX.ARMORED_REDUCTION;
  if (e.domed) v *= 1 - ENEMY_TUNING.AEGIS.DOME_REDUCTION;
  return v;
}

/** Movement / cooldown slow factor (0..1) from Chill. */
export function chillSlow(e: Enemy): number {
  if (e.status !== 'rime') return 0;
  const slow = Math.min(SIM.MAX_CUT, STATUS.CHILL.SLOW * e.statusPower + e.statusBonus);
  return isBoss(e) ? slow * SIM.BOSS_CHILL_FACTOR : slow;
}

/** Total movement slow (0..1): Chill, the bell relic's slow and smoke. */
export function moveSlow(e: Enemy): number {
  let keep = 1 - chillSlow(e);
  if (e.slowTime > 0) keep *= 1 - (isBoss(e) ? e.slow * SIM.BOSS_CHILL_FACTOR : e.slow);
  if (e.smokeTime > 0) keep *= 1 - (isBoss(e) ? SMOKE.SLOW * SIM.BOSS_CHILL_FACTOR : SMOKE.SLOW);
  return 1 - keep;
}

/** Outgoing damage of an enemy attack after chamber scaling, elite bonus, deep_frost, frost core, Wither and smoke. */
export function enemyDamage(e: Enemy, base: number): number {
  let weaken = 1;
  if (e.status === 'rime') weaken = 1 - Math.min(SIM.MAX_CUT, e.statusBonus + e.statusWeaken);
  else if (e.status === 'umbra') weaken = 1 - Math.min(SIM.MAX_CUT, STATUS.WITHER.WEAKEN * e.statusPower + e.statusBonus);
  if (e.smokeTime > 0) weaken *= 1 - SMOKE.WEAKEN;
  return base * e.damageMul * weaken;
}

/** Nearest targetable enemy within `range` of a point that is not `skip` and passes `ok`. */
export function nearestEnemy(w: World, x: number, z: number, range: number, skip: Enemy | null, ok?: (e: Enemy) => boolean): Enemy | null {
  let best: Enemy | null = null;
  let bestD = range * range;
  for (const o of w.enemies) {
    if (o === skip || !isTargetable(o) || o.hp <= 0) continue;
    const dx = o.x - x;
    const dz = o.z - z;
    const d = dx * dx + dz * dz;
    if (d > bestD || (ok && !ok(o))) continue;
    bestD = d;
    best = o;
  }
  return best;
}

const noStatus = (e: Enemy): boolean => e.status === null;

/**
 * Warded enemies (update 4). An enemy warded against element X
 *  - never carries X's status, whatever tries to apply it (hits, hazards, spreading statuses, bursts);
 *  - is not detonated by X: a hit with X on it while it carries another status changes nothing;
 *  - is untouched by any Resonance burst that consumed X or applied X (no damage, no status, no reaction effect,
 *    a Void Arc does not leap to it).
 * Plain damage of an X-infused hit is dealt as usual.
 */
export const wardedAgainst = (e: Enemy, el: ElementId): boolean => e.ward === el;

/** Tells the clients that a hero's element did nothing to a warded enemy (rate-limited per enemy). */
function wardBlocked(w: World, e: Enemy, el: ElementId, by: Hero | null): void {
  if (!by || e.dead || e.wardCd > 0) return;
  e.wardCd = SIM.WARDED_EVENT_SECONDS;
  w.emit({ e: 'warded', id: e.id, el, x: e.x, z: e.z, by: by.slot });
}

export function setStatus(w: World, e: Enemy, el: ElementId, by: Hero | null, potency: number, jumped = false): void {
  if (wardedAgainst(e, el)) { wardBlocked(w, e, el, by); return; }
  const changed = e.status !== el;
  const lasting = by ? 1 + by.stats.catalyst : 1;
  e.status = el;
  e.statusPotency = potency;
  e.statusBy = by ? by.slot : -1;
  e.statusPower = by ? 1 + by.mods.elementPotency : 1;
  e.statusWeaken = 0;
  if (el === 'ember') {
    e.statusTime = STATUS.BURN.DURATION * lasting;
    e.statusBonus = by ? by.stats.wildfire : 0;
    if (changed) e.burnTimer = SIM.BURN_TICK_SECONDS;
  } else if (el === 'rime') {
    e.statusTime = STATUS.CHILL.DURATION * potency * lasting;
    e.statusBonus = by ? by.stats.deepFrost : 0;
    if (by && by.relic.frostCore > 0) e.statusWeaken = RELIC_TUNING.FROST_CORE_WEAKEN * by.relic.frostCore;
  } else if (el === 'storm') {
    e.statusTime = STATUS.SHOCK.DURATION * potency * lasting;
    e.statusBonus = by ? by.stats.overcharge : 0;
  } else {
    e.statusTime = STATUS.WITHER.DURATION * potency * lasting;
    e.statusBonus = by ? by.stats.creepingDark : 0;
  }
  if (!changed) return;
  w.emit({ e: 'status', id: e.id, el });
  // Ember heart: a fresh Burn also catches one neighbour (which does not spread it further).
  if (el === 'ember' && by && by.relic.emberHeart > 0 && !jumped) {
    const next = nearestEnemy(w, e.x, e.z, SIM.SPREAD_RANGE, e, noStatus);
    if (next) setStatus(w, next, 'ember', by, potency, true);
  }
}

export function clearStatus(e: Enemy): void {
  e.status = null;
  e.statusTime = 0;
  e.statusBonus = 0;
  e.statusWeaken = 0;
  e.statusPower = 1;
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

/** A temporary shield that does not stack: the larger of the current and the new one stays. */
export function grantShield(h: Hero, amount: number, seconds: number = SIM.TEMP_SHIELD_SECONDS): void {
  if (h.state !== 'alive' || amount <= 0) return;
  if (h.tempShield < amount) h.tempShield = amount;
  if (h.tempShieldTime < seconds) h.tempShieldTime = seconds;
}

/** Adds ultimate charge (already in charge points) and announces a full bar once. */
export function addCharge(w: World, h: Hero, points: number): void {
  if (points <= 0 || h.ult >= ULTIMATE.MAX) return;
  h.ult = Math.min(ULTIMATE.MAX, h.ult + points);
  if (h.ult >= ULTIMATE.MAX) w.emit({ e: 'ultReady', slot: h.slot });
}

/** Share of the charge earned by fighting that a hero keeps in a party of `partySize` (ULTIMATE.PARTY_FALLOFF). */
export const partyChargeScale = (partySize: number): number => 1 / (1 + ULTIMATE.PARTY_FALLOFF * Math.max(0, partySize - 1));

/** Charge earned by fighting: scaled by the hero's ultCharge bonus and the party falloff, at most MAX_PER_HIT per hit. */
function earnCharge(w: World, h: Hero, points: number): void {
  addCharge(w, h, Math.min(ULTIMATE.MAX_PER_HIT, points) * (1 + h.mods.ultCharge) * partyChargeScale(w.partySize));
}

function heroNearest(w: World, x: number, z: number): Hero | null {
  let best: Hero | null = null;
  let bestD = Infinity;
  for (const o of w.heroes) {
    if (o.state !== 'alive') continue;
    const dx = o.body.x - x;
    const dz = o.body.z - z;
    const d = dx * dx + dz * dz;
    if (d < bestD) { bestD = d; best = o; }
  }
  return best;
}

/** Unblockable damage to everything around a point (overkill, Death Mark). */
function blastEnemies(w: World, x: number, z: number, r: number, amount: number, by: number, skip: Enemy): void {
  w.emit({ e: 'aoe', x, z, r, el: null, hostile: false });
  for (const o of w.enemies) {
    if (o === skip || !isTargetable(o)) continue;
    const reach = r + o.radius;
    const dx = o.x - x;
    const dz = o.z - z;
    if (dx * dx + dz * dz <= reach * reach) rawDamageEnemy(w, o, amount, by, null);
  }
}

/** `quiet`: the enemy crumbles or bursts by itself and leaves nothing behind (no bomber death burst). */
export function killEnemy(w: World, e: Enemy, by: number, quiet = false): void {
  if (e.dead) return;
  const status = e.status;
  const applier = status !== null ? w.hero(e.statusBy) : undefined;
  const potency = e.statusPotency;
  const marker = e.markTime > 0 ? w.hero(e.markBy) : undefined;
  e.dead = true;
  e.hp = 0;
  e.corpseTime = SIM.CORPSE_SECONDS;
  e.attack = null;
  e.stunTime = 0;
  e.kbX = 0;
  e.kbZ = 0;
  e.markTime = 0;
  clearStatus(e);
  const killer = w.hero(by);
  if (e.boss) {
    e.boss.slams.length = 0;
    e.boss.seqLeft = 0;
    // Relic shards: champion and herald here; the run's final boss is paid by the director when the chamber ends.
    if (e.kind === 'champion') rollShards(w, 'elite');
    else if (e.boss.herald) rollShards(w, 'herald');
    else if (e.id !== w.run.bossId || w.director.manual) rollShards(w, 'boss');
    if (e.id === w.run.bossId && w.run.chamberKind === 'elite') {
      w.director.elitesSlain++;
      earn(w.director.earnings, 'elite', w.run.depth, w.cursed);
    }
  }
  e.anim = 'death';
  e.animSeq++;
  w.emit({ e: 'kill', id: e.id, kind: e.kind, x: e.x, z: e.z, by });
  if (e.kind === 'aegis' || e.kind === 'bomber' || e.kind === 'necromancer') onHordeDeath(w, e, quiet);
  // Cursed chambers: elite-flagged rank and file slain by a hero may leave a shard (at most one per hero and chamber).
  if (killer && w.cursed && e.elite && !e.boss && !e.summoned && !quiet) rollCursedShard(w);
  if (!killer) return;
  killer.run.kills++;
  if (e.boss && e.kind !== 'champion') killer.run.bosses++;
  else if (e.elite || e.boss) killer.run.elites++;
  const life = killer.stats.leech + killer.mods.lifeOnKill + (killer.buffs.bloodrage > 0 ? BUFFS.bloodrage.lifeOnKill : 0);
  if (life > 0) healHero(w, killer, life);
  if (killer.talent.rampage) {
    killer.rampage = Math.min(TALENT.RAMPAGE_MAX_STACKS, killer.rampage + 1);
    killer.rampageTime = TALENT.RAMPAGE_SECONDS;
  }
  if (status === 'umbra' && killer.relic.voidLantern > 0) {
    const near = heroNearest(w, e.x, e.z);
    if (near) healHero(w, near, RELIC_TUNING.LANTERN_HEAL * killer.relic.voidLantern);
  }
  // Set special `spread`: the status of a dying carrier jumps to the nearest enemy without one.
  if (status !== null && applier && applier.setSpread.includes(status)) {
    const next = nearestEnemy(w, e.x, e.z, SIM.SPREAD_RANGE, e, noStatus);
    if (next) setStatus(w, next, status, applier, potency, true);
  }
  if (e.affix === 'volatile') {
    w.blasts.push({ x: e.x, z: e.z, r: AFFIX.VOLATILE_RADIUS, t: AFFIX.VOLATILE_DELAY, damage: AFFIX.VOLATILE_DAMAGE * e.damageMul, by: e.id, enemyDamage: 0 });
    w.emit({ e: 'telegraph', shape: 'circle', x: e.x, z: e.z, rot: 0, r: AFFIX.VOLATILE_RADIUS, w: 0, dur: AFFIX.VOLATILE_DELAY });
  }
  if (marker) {
    const amount = ULTIMATE.MARK_BURST_DAMAGE * (1 + marker.mods.damage) * (1 + marker.mods.ultimateDamage + marker.stats.crescendo);
    blastEnemies(w, e.x, e.z, ULTIMATE.MARK_BURST_RADIUS, amount, marker.slot, e);
  }
  if (killer.stats.overkill > 0) blastEnemies(w, e.x, e.z, BOON_TUNING.OVERKILL_RADIUS, killer.stats.overkill, killer.slot, e);
}

/** Unblockable damage (burn ticks, Resonance bursts). `amount` is final except for the target's vulnerabilities. */
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

/** Enemies caught by the burst that is being resolved (Void Arc must leap to others). */
const burstHit: Enemy[] = [];

function burst(w: World, x: number, z: number, a: ElementId, b: ElementId, h: Hero, potency: number): void {
  const reaction = reactionOf(a, b);
  const id = reaction ? reaction.id : null;
  const duo = reaction ? h.stats.duo[reaction.id] : 0;
  // A duo boon doubles the reaction's own effect.
  const twice = duo > 0 ? 2 : 1;
  const radius = STATUS.RESONANCE.RADIUS * (1 + h.stats.wideResonance) * (reaction ? reaction.radiusMul : 1);
  const damage = STATUS.RESONANCE.DAMAGE * (1 + h.stats.amplifier + h.mods.resonanceDamage) * (1 + h.mods.damage)
    * (reaction ? reaction.damageMul : 1) * (1 + duo);
  w.emit({ e: 'resonance', x, z, r: radius, a, b, by: h.slot });
  w.emit({ e: 'aoe', x, z, r: radius, el: b, hostile: false });
  burstHit.length = 0;
  for (const o of w.enemies) {
    if (!isTargetable(o)) continue;
    const reach = radius + o.radius;
    const dx = o.x - x;
    const dz = o.z - z;
    if (dx * dx + dz * dz > reach * reach) continue;
    // Warded against either element of this burst: it passes the enemy by.
    if (o.ward !== null && (o.ward === a || o.ward === b)) { burstHit.push(o); wardBlocked(w, o, o.ward, h); continue; }
    burstHit.push(o);
    o.resonanceCd = STATUS.RESONANCE.INTERNAL_COOLDOWN;
    if (o.armored) {
      o.armored = false;
      w.emit({ e: 'shieldBreak', id: o.id });
    }
    rawDamageEnemy(w, o, id === 'shatter' && isBoss(o) ? damage * (1 + REACTION_TUNING.SHATTER_BOSS_BONUS) : damage, h.slot, b);
    if (o.dead) {
      // chain_reaction: what the burst kills hands the new status to the nearest enemy outside.
      if (h.stats.chainReaction) {
        const next = nearestEnemy(w, o.x, o.z, SIM.SPREAD_RANGE, o, noStatus);
        if (next) setStatus(w, next, b, h, potency, true);
      }
      continue;
    }
    // Element transfer: everything caught in the burst now carries the new element.
    if (id === 'conflagration') setStatus(w, o, 'ember', h, potency * REACTION_TUNING.CONFLAGRATION_BURN_POTENCY * twice);
    else setStatus(w, o, b, h, potency);
    if (id === 'shatter') {
      if (isBoss(o)) {
        if (o.stunTime < SIM.BOSS_STAGGER_SECONDS) o.stunTime = SIM.BOSS_STAGGER_SECONDS;
      } else {
        stunEnemy(o, REACTION_TUNING.SHATTER_STUN * twice);
      }
    } else if (id === 'superconduct') {
      o.sunder = REACTION_TUNING.SUNDER_VULNERABILITY * twice;
      o.sunderTime = REACTION_TUNING.SUNDER_SECONDS;
    } else if (id === 'entomb') {
      const hold = (isBoss(o) ? REACTION_TUNING.ENTOMB_BOSS_ROOT_SECONDS : REACTION_TUNING.ENTOMB_ROOT_SECONDS) * twice;
      if (o.rootTime < hold) o.rootTime = hold;
    }
    if (h.relic.bell > 0) {
      o.slow = Math.min(SIM.MAX_CUT, RELIC_TUNING.BELL_SLOW * h.relic.bell);
      o.slowTime = RELIC_TUNING.BELL_SECONDS;
    }
  }
  if (id === 'soulfire') {
    const r2 = REACTION_TUNING.SOULFIRE_HEAL_RADIUS * REACTION_TUNING.SOULFIRE_HEAL_RADIUS;
    for (const ally of w.heroes) {
      const dx = ally.body.x - x;
      const dz = ally.body.z - z;
      if (dx * dx + dz * dz <= r2) healHero(w, ally, REACTION_TUNING.SOULFIRE_HEAL * twice);
    }
  } else if (id === 'entomb') {
    grantShield(h, REACTION_TUNING.ENTOMB_SHIELD * twice);
  } else if (id === 'voidarc') {
    // Lightning leaps on from enemy to enemy, each at most VOIDARC_RANGE from the last.
    let fromX = x;
    let fromZ = z;
    for (let jump = 0; jump < REACTION_TUNING.VOIDARC_JUMPS * twice; jump++) {
      const next = nearestEnemy(w, fromX, fromZ, REACTION_TUNING.VOIDARC_RANGE, null, arcTarget);
      if (!next) break;
      burstHit.push(next);
      fromX = next.x;
      fromZ = next.z;
      w.emit({ e: 'cast', who: { t: 'p', id: h.slot }, ability: 'voidarc', x: next.x, z: next.z, rot: 0 });
      rawDamageEnemy(w, next, REACTION_TUNING.VOIDARC_DAMAGE * (1 + h.mods.damage) * (1 + duo), h.slot, b);
      if (!next.dead) setStatus(w, next, b, h, potency);
    }
  }
}

/** Void Arc (storm + umbra) never leaps to an enemy that is warded against one of its two elements. */
const arcTarget = (e: Enemy): boolean => !burstHit.includes(e) && e.ward !== 'storm' && e.ward !== 'umbra';

function resonate(w: World, e: Enemy, el: ElementId, h: Hero, potency: number): void {
  const a = e.status as ElementId;
  const applier = w.hero(e.statusBy);
  const x = e.x;
  const z = e.z;
  clearStatus(e);
  h.run.resonances++;
  addCharge(w, h, ULTIMATE.PER_RESONANCE * (1 + h.mods.ultCharge) * partyChargeScale(w.partySize));
  if (h.setOverflow) addCharge(w, h, ULTIMATE.MAX * BOON_TUNING.SET_OVERFLOW_CHARGE);
  burst(w, x, z, a, el, h, potency);
  if (h.stats.echo > 0 && w.rng.chance(h.stats.echo)) burst(w, x, z, a, el, h, potency);
  if (h.stats.aftershock > 0) {
    h.dashCharges = Math.min(maxDashCharges(h), h.dashCharges + 1);
    if (h.dashCharges >= maxDashCharges(h)) h.dashRecharge = 0;
    h.secondaryCd = Math.max(0, h.secondaryCd - h.stats.aftershock * h.secondaryCdMax);
  }
  if (h.stats.sharedVigor > 0) for (const ally of w.heroes) healHero(w, ally, h.stats.sharedVigor);
  if (h.stats.crystalWard > 0) grantShield(h, h.stats.crystalWard);
  // covenant: the hero whose status was consumed and the hero who consumed it are both shielded.
  if (applier && applier.stats.covenant > 0) {
    grantShield(applier, applier.stats.covenant);
    if (applier !== h) grantShield(h, applier.stats.covenant);
  }
}

/**
 * Applies an element to an enemy. A different element on a marked enemy detonates it (Resonance) unless the
 * enemy burst (or was caught in a burst) within the internal cooldown, in which case the hit changes nothing.
 */
export function applyElement(w: World, e: Enemy, el: ElementId, h: Hero, potency: number): void {
  if (wardedAgainst(e, el)) { wardBlocked(w, e, el, h); return; }
  if (e.status !== null && e.status !== el) {
    if (e.resonanceCd > SIM.EPS) return;
    resonate(w, e, el, h, potency);
    return;
  }
  if (!e.dead && e.hp > 0) setStatus(w, e, el, h, potency);
}

/** Breaks whatever the enemy is winding up. A broken wind-up is announced once (`interrupt` event, see stepEnemy). */
function interrupt(e: Enemy): void {
  if (e.attack && !e.dead) e.interrupted = true;
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
  /** AbilityDef.special of the ability that hits (`backstab`, `crit`), if any. */
  special?: string | null;
  /** Extra damage fraction decided by the caller (spellweave). */
  bonus?: number;
  /** Rogue bolts and knives (poison_tips talent). */
  poison?: boolean;
}

const BACKSTAB_HALF_ANGLE = BACKSTAB.HALF_ANGLE_DEG * DEG;

/**
 * A hero's ability hits an enemy: mods and boon multipliers, crit, shield, poise, stun, knockback, element,
 * ultimate charge. Returns false if the enemy could not be hit at all.
 */
export function strikeEnemy(w: World, h: Hero, e: Enemy, base: number, slot: AbilitySlot, opts: StrikeOpts): boolean {
  if (!isTargetable(e)) return false;
  if (w.tutorial && slot === 'secondary') w.tutorial.secondaryHits++;
  const bit = 1 << h.slot;
  let dmg = base * (1 + h.mods.damage);
  if (slot === 'primary') dmg *= 1 + h.stats.primaryDamage + h.mods.primaryDamage;
  else if (slot === 'secondary') dmg *= 1 + h.stats.secondaryDamage + h.mods.secondaryDamage;
  else if (slot === 'ultimate') dmg *= 1 + h.stats.crescendo + h.mods.ultimateDamage;
  dmg *= 1 + h.aura;
  if (h.oathbondTime > 0) dmg *= 1 + h.stats.oathbond;
  if (h.buffs.bloodrage > 0) dmg *= 1 + BUFFS.bloodrage.damage;
  if (h.stats.execute > 0 && e.hp < e.maxHp * BOON_TUNING.EXECUTE_THRESHOLD) dmg *= 1 + h.stats.execute;
  if (h.stats.giantSlayer > 0 && (e.elite || e.boss !== null)) dmg *= 1 + h.stats.giantSlayer;
  if (h.stats.firstBlood > 0 && e.hp >= e.maxHp) dmg *= 1 + h.stats.firstBlood;
  if (h.stats.momentum > 0) {
    dmg *= 1 + h.stats.momentum * h.momentum;
    if (h.momentum < BOON_TUNING.MOMENTUM_MAX_STACKS) h.momentum++;
    h.momentumTime = BOON_TUNING.MOMENTUM_DECAY_SECONDS;
  }
  if (opts.bonus) dmg *= 1 + opts.bonus;
  if (opts.special === 'backstab') {
    // Behind = the enemy looks away from the hero.
    const away = Math.abs(angleDiff(angleTo(e.x, e.z, h.body.x, h.body.z), e.rot + Math.PI));
    if (away <= BACKSTAB_HALF_ANGLE) dmg *= 1 + BACKSTAB.BONUS;
  }
  if (slot === 'primary' && h.riposte) {
    h.riposte = false;
    dmg *= TALENT.RIPOSTE_MULTIPLIER;
  }
  const chance = h.stats.crit + h.mods.critChance;
  const sure = opts.special === 'crit' || (h.talent.ambush && e.target !== h.slot && (e.struckBy & bit) === 0);
  const crit = sure || (chance > 0 && w.rng.chance(chance));
  if (crit) dmg *= (STATUS.CRIT_MULTIPLIER + h.mods.critDamage) * (1 + h.stats.brutality);
  dmg *= vulnerability(e);
  e.struckBy |= bit;

  let element: ElementId | null = null;
  let potency = 1;
  if (h.buffs.overload > 0 && h.overloadEls.length > 0) {
    element = h.overloadEls[h.overloadIndex % h.overloadEls.length] as ElementId;
    h.overloadIndex++;
    potency = BUFFS.overload.potency;
  } else {
    const infusion = h.stats.infusion[slot];
    if (infusion) { element = infusion.element; potency = infusion.potency; }
  }
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
    // The ultimate does not charge itself.
    if (slot !== 'ultimate') earnCharge(w, h, dealt * ULTIMATE.PER_DAMAGE_DEALT);
    if (e.status === 'umbra') healHero(w, h, STATUS.WITHER.LEECH * e.statusPower * (h.stats.creepingDark > 0 ? 2 : 1));
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
    crit: crit && !blocked, el: element, by: h.slot,
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
  if (!blocked) {
    if (element) applyElement(w, e, element, h, potency);
    // Poison Tips never detonates anything: it only withers enemies that carry no other status.
    if (opts.poison && h.talent.poisonTips && !e.dead && e.hp > 0 && (e.status === null || e.status === 'umbra')) {
      setStatus(w, e, 'umbra', h, TALENT.POISON_POTENCY);
    }
    if (h.relic.stormCoil > 0 && ++h.coilHits >= RELIC_TUNING.COIL_EVERY) {
      h.coilHits = 0;
      w.emit({ e: 'cast', who: { t: 'p', id: h.slot }, ability: 'storm_coil', x: e.x, z: e.z, rot: 0 });
      rawDamageEnemy(w, e, RELIC_TUNING.COIL_DAMAGE * h.relic.stormCoil * (1 + h.mods.damage), h.slot, 'storm');
    }
  }
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
  h.flight = false;
  h.sanctuary = 0;
  h.momentum = 0;
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
  // Set special `bond`: whoever is raised by (or is) a hero with the kinship set gets a longer window.
  const reviver = w.hero(by);
  if ((h.setBond || (reviver && reviver.setBond)) && h.invuln < BOON_TUNING.SET_BOND_INVULNERABILITY) h.invuln = BOON_TUNING.SET_BOND_INVULNERABILITY;
  h.sanctuary = 0;
  h.barrierDelay = BOON_TUNING.BARRIER_RECHARGE_DELAY;
  h.anim = 'idle';
  h.animSeq++;
  h.oathbondArmed = h.hp >= h.maxHp * SIM.OATHBOND_HP_THRESHOLD;
  w.emit({ e: 'revived', slot: h.slot, by });
}

/** Shields first: returns what is left of `dmg`. A hero with riposte is armed by anything a shield swallows. */
function absorb(h: Hero, dmg: number): number {
  let left = dmg;
  if (h.tempShield > 0) {
    const absorbed = Math.min(h.tempShield, left);
    h.tempShield -= absorbed;
    left -= absorbed;
  }
  if (h.barrier > 0 && left > 0) {
    const absorbed = Math.min(h.barrier, left);
    h.barrier -= absorbed;
    left -= absorbed;
  }
  if (left < dmg && h.talent.riposte) h.riposte = true;
  return left;
}

/** Martyr (templar): the owner of hallowed ground this hero stands on, if that owner takes a share of its damage. */
function martyrFor(w: World, h: Hero): Hero | null {
  for (const zone of w.zones) {
    if (zone.dead || zone.owner === h.slot || zone.def.heal <= 0) continue;
    const owner = w.hero(zone.owner);
    if (!owner || !owner.talent.martyr || owner.state !== 'alive') continue;
    const dx = h.body.x - zone.x;
    const dz = h.body.z - zone.z;
    if (dx * dx + dz * dz <= zone.r * zone.r) return owner;
  }
  return null;
}

/**
 * An enemy attack lands on a hero. Returns false when it was avoided (i-frames, downed, disconnected).
 * `by` is the attacking enemy's id (or -1); `melee` marks blows struck from close range (thorns).
 */
export function damageHero(w: World, h: Hero, amount: number, by: number, melee = false): boolean {
  if (h.state !== 'alive' || !h.connected || h.invuln > SIM.EPS || w.run.phase !== 'combat' || amount <= 0) return false;
  let taken = amount * (1 - h.mods.damageTaken);
  if (h.buffs.bulwark > 0) taken *= 1 - BUFFS.bulwark.damageTaken;
  const martyr = w.zones.length > 0 ? martyrFor(w, h) : null;
  if (martyr) {
    const share = taken * TALENT.MARTYR_SHARE;
    taken -= share;
    dotHero(w, martyr, share, null);
  }
  const dmg = absorb(h, taken);
  h.barrierDelay = BOON_TUNING.BARRIER_RECHARGE_DELAY;
  h.invuln = WORLD.HIT_IFRAME_SECONDS;
  h.damageTaken += taken;
  earnCharge(w, h, taken * ULTIMATE.PER_DAMAGE_TAKEN);
  w.emit({ e: 'hit', target: { t: 'p', id: h.slot }, x: h.body.x, z: h.body.z, dmg: Math.max(1, Math.round(taken)), crit: false, el: null, by });
  if (by >= 0 && (h.stats.thorns > 0 || w.affixes > 0)) {
    for (const e of w.enemies) {
      if (e.id !== by || e.dead) continue;
      if (e.affix === 'vampiric') e.hp = Math.min(e.maxHp, e.hp + e.maxHp * AFFIX.VAMPIRIC_HEAL);
      if (melee && h.stats.thorns > 0) rawDamageEnemy(w, e, h.stats.thorns, h.slot, null);
      break;
    }
  }
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
    } else if (h.relic.phoenix > 0 && !h.phoenixUsed) {
      // Phoenix feather: once per run the hero stands up at once instead of going down.
      h.phoenixUsed = true;
      h.hp = Math.max(1, Math.round(h.maxHp * Math.min(1, RELIC_TUNING.PHOENIX_HP * h.relic.phoenix)));
      h.invuln = SIM.REVIVE_IFRAMES;
      w.emit({ e: 'cast', who: { t: 'p', id: h.slot }, ability: 'phoenix', x: h.body.x, z: h.body.z, rot: h.rot });
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
 * Damage over time on a hero (burning after a fire vent, a martyr's share). Shields absorb it, but i-frames do
 * not stop it and it grants none.
 */
export function dotHero(w: World, h: Hero, amount: number, el: ElementId | null): void {
  if (h.state !== 'alive' || w.run.phase !== 'combat' || amount <= 0) return;
  const dmg = absorb(h, amount);
  h.barrierDelay = BOON_TUNING.BARRIER_RECHARGE_DELAY;
  h.damageTaken += amount;
  w.emit({ e: 'hit', target: { t: 'p', id: h.slot }, x: h.body.x, z: h.body.z, dmg: Math.max(1, Math.round(amount)), crit: false, el, by: -1 });
  if (dmg > 0) loseHealth(w, h, dmg);
}
