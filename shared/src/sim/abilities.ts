/** Hero abilities: activation rules, windups and hit detection in the XZ plane. */
import { BOON_TUNING } from '../data/boons.ts';
import { BUFFS, COMBO_WINDOW, DASH, ULTIMATE, type AbilityDef } from '../data/classes.ts';
import { HAZARD } from '../data/enemies.ts';
import { WORLD } from '../constants.ts';
import { BTN, ELEMENT_IDS, type AbilitySlot, type ElementId, type InputCmd } from '../types.ts';
import { heroElements } from './boons.ts';
import { applyElement, grantShield, healHero, isTargetable, strikeEnemy } from './combat.ts';
import { clamp, DEG, inArc, segDist } from './geom.ts';
import { KEYSTONE_CAPS } from '../data/keystones.ts';
import { onBolt, onDashStart, onMeleeSwing, proc, spinPulse, streamPulse, tempest } from './keystones.ts';
import { KP } from './ksState.ts';
import { resolveCollisions, startDash } from './movement.ts';
import { popFragileArc, popFragileCircle, popFragileSegment, spawnProjectile } from './projectiles.ts';
import type { Enemy, Hero, PendingHit } from './state.ts';
import { KS, SIM, TALENT } from './tuning.ts';
import type { World } from './world.ts';
import { spawnZone } from './zones.ts';

/** Speed handed to stepMovement this tick: class speed x mods x boons x haste x chill x ability move multiplier. */
export function heroMoveSpeed(h: Hero): number {
  let speed = h.def.moveSpeed * h.stats.moveSpeed * (1 + h.mods.moveSpeed);
  if (h.oathbondTime > 0) speed *= 1 + BOON_TUNING.OATHBOND_HASTE;
  if (h.buffs.bloodrage > 0) speed *= 1 + BUFFS.bloodrage.moveSpeed;
  if (h.slipstreamTime > 0) speed *= 1 + h.stats.slipstream;
  if (h.chillTime > 0) speed *= 1 - HAZARD.FROST.SLOW;
  // Keystones: Colossus is slower, Bloodrush faster per stack, channelling the Arc Stream slows.
  if (h.ks.colossus) speed *= 1 + KP.colossus.moveSpeed;
  if (h.ks.stacks > 0) speed *= 1 + KP.rush.perKill * h.ks.stacks;
  if (h.ks.channel > SIM.EPS) speed *= 1 - KP.mage.slow;
  if (h.lockTime > SIM.EPS) speed *= h.lockMoveMul;
  return speed;
}

export const dashRechargeSeconds = (h: Hero): number => DASH.COOLDOWN / (h.stats.dashRecharge * (1 + h.mods.dashHaste));

/** Secondary cooldown after boons (quick_wits shortens it), haste and the keystones Twin Cast / Blood Price (recharge faster). */
export const secondaryCooldown = (h: Hero): number =>
  (h.abil.secondary.cooldown * (1 - h.stats.secondaryCdr))
  / ((1 + h.mods.secondaryHaste) * (h.ks.twinCast ? 1 + KP.twin.recharge : 1) * (h.ks.bloodPrice ? 1 + KP.price.recharge : 1));

/**
 * Blood Price: the secondary may be used again `minCooldown` seconds after its last use although it has not
 * recharged — for a price in health (see activate). Never the last point of health: at 1 health it waits.
 */
export const canCastEarly = (h: Hero): boolean => h.ks.bloodPrice && h.hp > 1 && h.secondaryCd > SIM.EPS && h.ks.priceWait <= SIM.EPS;

/** Primary attacks are this many times faster (cooldown, windup and lock are divided by it). */
export function attackSpeed(h: Hero): number {
  let speed = h.stats.attackSpeed + h.mods.attackSpeed + h.rampage * TALENT.RAMPAGE_ATTACK_SPEED;
  if (h.buffs.bloodrage > 0) speed += BUFFS.bloodrage.attackSpeed;
  if (h.ks.stacks > 0) speed += KP.rush.perKill * h.ks.stacks;
  // Titan Grip: every primary attack is slower.
  if (h.ks.heavyHitter) speed *= 1 - KP.heavy.slow;
  return speed;
}

const elementCode = (h: Hero, slot: AbilitySlot): number => {
  const inf = h.stats.infusion[slot];
  return inf ? ELEMENT_IDS.indexOf(inf.element) + 1 : 0;
};

function playAction(h: Hero, def: AbilityDef, seconds: number): void {
  h.anim = def.anim;
  h.animSeq++;
  h.animTime = Math.max(seconds, SIM.ACTION_ANIM_MIN_SECONDS);
}

const moves = (p: PendingHit): boolean => !p.twin && (p.def.shape === 'lunge' || p.def.shape === 'leap');

/**
 * Twin Cast: queues the repeat of a secondary (`fraction` of its damage and healing, no shield, after `delay`).
 * The repeat never moves the hero: see `releaseTwin` for what each ability shape does.
 */
function queueTwin(h: Hero, def: AbilityDef, slot: AbilitySlot, aim: number, tx: number, tz: number, ox: number, oz: number): void {
  let waiting = 0;
  for (const p of h.pending) if (p.twin) waiting++;
  if (waiting >= KEYSTONE_CAPS.TWINS_PENDING) return;
  const twin: AbilityDef = { ...def, damage: def.damage * KP.twin.fraction, heal: def.heal * KP.twin.fraction, selfShield: 0, special: def.special === 'max3' ? null : def.special };
  h.pending.push({ def: twin, slot, t: KP.twin.delay, aim, tx, tz, twin: true, ox, oz });
}

function dash(w: World, h: Hero, cmd: InputCmd): void {
  startDash(h.body, cmd.moveX, cmd.moveZ, cmd.aim);
  h.pressDash = 0;
  h.dashCharges--;
  if (h.dashRecharge <= SIM.EPS) h.dashRecharge = dashRechargeSeconds(h);
  if (h.invuln < DASH.IFRAMES) h.invuln = DASH.IFRAMES;
  // A dash cancels the lock / root of the current ability and an unreleased lunge or leap; other wound-up hits still land.
  h.lockTime = 0;
  h.lockMoveMul = 1;
  h.lunge = null;
  h.flight = false;
  for (let i = h.pending.length - 1; i >= 0; i--) if (moves(h.pending[i] as PendingHit)) h.pending.splice(i, 1);
  h.dashHit.clear();
  onDashStart(h);
  if (h.stats.slipstream > 0) h.slipstreamTime = BOON_TUNING.SLIPSTREAM_SECONDS + DASH.DURATION;
  h.anim = 'dash';
  h.animSeq++;
  h.animTime = DASH.DURATION;
  w.emit({ e: 'cast', who: { t: 'p', id: h.slot }, ability: 'dash', x: h.body.x, z: h.body.z, rot: Math.atan2(h.body.dashDirX, h.body.dashDirZ) });
}

function activate(w: World, h: Hero, def: AbilityDef, slot: AbilitySlot, cmd: InputCmd): void {
  const speed = slot === 'primary' ? attackSpeed(h) : 1;
  const lock = def.lock / speed;
  const windup = def.windup / speed;
  let shield = def.selfShield;
  if (slot === 'primary') {
    h.primaryCd = def.cooldown / speed;
    h.comboIndex = (h.comboIndex + 1) % h.abil.primary.length;
    h.comboTime = lock + COMBO_WINDOW;
    h.pressPrimary = 0;
  } else if (slot === 'secondary') {
    h.pressSecondary = 0;
    if (h.ks.bloodPrice) {
      h.ks.casts++;
      h.ks.priceWait = KP.price.minCooldown;
    }
    if (h.ks.bloodPrice && h.secondaryCd > SIM.EPS) {
      // Blood Price: cast before it had recharged, paid in health (never the last point). The recharge that is
      // under way simply goes on, so the next free cast comes no later than it would have.
      const cost = Math.min(h.hp - 1, h.maxHp * KP.price.hpFraction);
      h.hp -= cost;
      h.ks.extraCasts++;
      proc(w, h, 'blood_price', h.body.x, h.body.z, { n: Math.round(cost) }, true);
    } else {
      const cd = secondaryCooldown(h);
      h.secondaryCd = cd;
      h.secondaryCdMax = cd;
    }
    shield += h.mods.shieldOnSecondary;
    if (h.talent.spellweave) h.spellweave = true;
  } else {
    // Ultimates are paid with the whole charge (encore hands part of it back) and have no cooldown.
    h.ult = ULTIMATE.MAX * h.stats.encore;
    h.pressUltimate = 0;
    h.run.ultimates++;
    // Another hero's rally is outside healing (Sanguine Pact refuses it); the caster's own is not.
    if (h.stats.rally > 0) for (const ally of w.heroes) healHero(w, ally, h.stats.rally * (1 + h.stats.crescendo), ally !== h);
  }
  h.lockTime = lock;
  h.lockMoveMul = def.moveMul;
  if (def.moveMul === 0) h.body.rootTime = lock;
  playAction(h, def, Math.max(lock, windup));

  let tx = h.body.x;
  let tz = h.body.z;
  const aimed = def.shape === 'circle' || def.shape === 'leap' || def.shape === 'trap' || def.shape === 'zone';
  if (aimed && def.range > 0) {
    const reach = clamp(cmd.aimDist, 0, def.range);
    tx = clamp(h.body.x + Math.sin(cmd.aim) * reach, -w.room.w / 2, w.room.w / 2);
    tz = clamp(h.body.z + Math.cos(cmd.aim) * reach, -w.room.d / 2, w.room.d / 2);
    if (def.shape === 'leap') {
      // The landing spot is somewhere a hero can stand.
      LANDING.x = tx;
      LANDING.z = tz;
      resolveCollisions(LANDING, WORLD.PLAYER_RADIUS, w.room);
      tx = LANDING.x;
      tz = LANDING.z;
    }
  }
  w.emit({ e: 'cast', who: { t: 'p', id: h.slot }, ability: def.id, x: tx, z: tz, rot: cmd.aim });
  // A banner's shield goes to everyone in reach when it lands (see `buff` in release).
  if (shield > 0 && !(def.shape === 'buff' && def.radius > 0)) grantShield(h, shield);
  if (def.shape === 'trap') {
    // Traps lie on the ground at once and arm after the windup.
    spawnZone(w, h, def, slot, tx, tz, windup);
    if (slot === 'secondary' && h.ks.twinCast) queueTwin(h, def, slot, cmd.aim, tx, tz, tx, tz);
    return;
  }
  if (def.shape === 'leap' && h.invuln < windup) h.invuln = windup;
  h.pending.push({ def, slot, t: windup, aim: cmd.aim, tx, tz });
}

const LANDING = { x: 0, z: 0 };

/**
 * Called once per tick with the consumed input, before movement. Dash triggers on a (buffered) press and may
 * interrupt anything; ULTIMATE (with a full charge) and SECONDARY trigger on a (buffered) press; PRIMARY repeats
 * while held.
 */
export function startAbilities(w: World, h: Hero, cmd: InputCmd, buttons: number): void {
  if (h.pressDash > SIM.EPS && h.dashCharges >= 1) dash(w, h, cmd);
  if (h.lockTime > SIM.EPS || h.body.dashTime > SIM.EPS) return;
  if (h.pressUltimate > SIM.EPS && h.ult >= ULTIMATE.MAX) {
    activate(w, h, h.abil.ultimate, 'ultimate', cmd);
  } else if (h.pressSecondary > SIM.EPS && (h.secondaryCd <= SIM.EPS || canCastEarly(h))) {
    activate(w, h, h.abil.secondary, 'secondary', cmd);
  } else if (((buttons & BTN.PRIMARY) !== 0 || h.pressPrimary > SIM.EPS) && h.primaryCd <= SIM.EPS) {
    // Arc Stream: the mage's primary is a channelled beam (no wind-up, no lock) while the button is held.
    if (h.ks.streamDef) streamPulse(w, h, cmd, attackSpeed(h));
    else activate(w, h, h.abil.primary[h.comboIndex % h.abil.primary.length] as AbilityDef, 'primary', cmd);
  }
}

function blast(w: World, h: Hero, def: AbilityDef, slot: AbilitySlot, x: number, z: number): void {
  const inf = h.stats.infusion[slot];
  w.emit({ e: 'aoe', x, z, r: def.radius, el: inf ? inf.element : null, hostile: false });
  for (const e of w.enemies) {
    if (!isTargetable(e)) continue;
    const reach = def.radius + e.radius;
    const dx = e.x - x;
    const dz = e.z - z;
    if (dx * dx + dz * dz > reach * reach) continue;
    strikeEnemy(w, h, e, def.damage, slot, { fromX: x, fromZ: z, stun: def.stun, knockback: def.knockback, special: def.special });
  }
  popFragileCircle(w, h.slot, x, z, def.radius);
}

const scratch: Enemy[] = [];

/** Spellblade ultimate: the blast, then every element in turn on everything it hit, then the Overload afterglow. */
function overload(w: World, h: Hero, def: AbilityDef, slot: AbilitySlot, x: number, z: number): void {
  const own = heroElements(h);
  const elements: ElementId[] = ELEMENT_IDS.filter((el) => own.has(el));
  if (elements.length === 0) {
    // No infusion yet: two different random elements.
    const first = w.rng.int(0, ELEMENT_IDS.length - 1);
    const second = (first + w.rng.int(1, ELEMENT_IDS.length - 1)) % ELEMENT_IDS.length;
    elements.push(ELEMENT_IDS[first] as ElementId, ELEMENT_IDS[second] as ElementId);
  }
  scratch.length = 0;
  for (const e of w.enemies) {
    if (!isTargetable(e)) continue;
    const reach = def.radius + e.radius;
    const dx = e.x - x;
    const dz = e.z - z;
    if (dx * dx + dz * dz <= reach * reach) scratch.push(e);
  }
  const hit = scratch.slice();
  blast(w, h, def, slot, x, z);
  for (const el of elements) {
    for (const e of hit) if (isTargetable(e) && e.hp > 0) applyElement(w, e, el, h, BUFFS.overload.potency);
  }
  if (def.buff && def.duration > 0) {
    h.overloadEls = elements;
    h.overloadIndex = 0;
    h.buffs[def.buff] = def.duration;
    w.emit({ e: 'buff', slot: h.slot, id: def.buff, dur: def.duration });
  }
}

/** Shade ultimate: marks the enemies nearest to the cursor and throws a dagger at each. */
function deathMark(w: World, h: Hero, def: AbilityDef, slot: AbilitySlot, x: number, z: number): void {
  const inf = h.stats.infusion[slot];
  w.emit({ e: 'aoe', x, z, r: def.radius, el: inf ? inf.element : null, hostile: false });
  scratch.length = 0;
  for (const e of w.enemies) {
    if (!isTargetable(e)) continue;
    const reach = def.radius + e.radius;
    const dx = e.x - x;
    const dz = e.z - z;
    if (dx * dx + dz * dz <= reach * reach) scratch.push(e);
  }
  scratch.sort((a, b) => Math.hypot(a.x - x, a.z - z) - Math.hypot(b.x - x, b.z - z) || a.id - b.id);
  const count = Math.min(scratch.length, ULTIMATE.MARK_MAX_TARGETS);
  for (let i = 0; i < count; i++) {
    const e = scratch[i] as Enemy;
    e.markTime = def.duration;
    e.markBy = h.slot;
    w.emit({ e: 'mark', id: e.id, dur: def.duration });
    if (!def.projectile) continue;
    const dist = Math.hypot(e.x - h.body.x, e.z - h.body.z);
    spawnProjectile(w, {
      kind: def.projectile, x: h.body.x, z: h.body.z, rot: Math.atan2(e.x - h.body.x, e.z - h.body.z), speed: SIM.SHADOW_DAGGER_SPEED,
      radius: SIM.SHADOW_DAGGER_RADIUS, range: dist + SIM.SHADOW_DAGGER_RANGE_PAD, damage: def.damage, hostile: false, owner: h.slot, slot,
      pierce: 0, element: elementCode(h, slot), stun: def.stun, knockback: def.knockback, only: e.id,
    });
  }
}

/**
 * Twin Cast going off. arc / projectile / beam: again from where the hero stands now, along the original aim.
 * circle / zone / trap: again at the same spot (a zone around the hero: where the hero stands now).
 * spin: a second spin runs alongside the first. lunge: an afterimage repeats the charge along its path (the hero
 * stays put). leap: a second blast where the hero landed. Returns true when it handled the repeat itself.
 */
function releaseTwin(w: World, h: Hero, p: PendingHit): boolean {
  const def = p.def;
  const ox = p.ox ?? h.body.x;
  const oz = p.oz ?? h.body.z;
  switch (def.shape) {
    case 'spin':
      h.ks.spinTwin = { def, slot: p.slot, pulsesLeft: Math.max(1, Math.round(def.duration / Math.max(def.tick, SIM.EPS))), timer: 0 };
      proc(w, h, 'twin_cast', h.body.x, h.body.z, { r: def.radius }, true);
      return true;
    case 'lunge': {
      const ex = clamp(ox + Math.sin(p.aim) * def.range, -w.room.w / 2, w.room.w / 2);
      const ez = clamp(oz + Math.cos(p.aim) * def.range, -w.room.d / 2, w.room.d / 2);
      proc(w, h, 'twin_cast', ox, oz, { tx: ex, tz: ez, r: def.radius }, true);
      for (const e of w.enemies) {
        if (!isTargetable(e) || segDist(ox, oz, ex, ez, e.x, e.z) > def.radius + e.radius) continue;
        strikeEnemy(w, h, e, def.damage, p.slot, { fromX: ox, fromZ: oz, stun: def.stun, knockback: def.knockback, special: def.special });
      }
      popFragileSegment(w, h.slot, ox, oz, ex, ez, def.radius);
      return true;
    }
    case 'leap':
      proc(w, h, 'twin_cast', p.tx, p.tz, { r: def.radius }, true);
      blast(w, h, def, p.slot, p.tx, p.tz);
      return true;
    case 'trap':
      proc(w, h, 'twin_cast', p.tx, p.tz, { r: def.radius }, true);
      spawnZone(w, h, def, p.slot, p.tx, p.tz, KS.TWIN_TRAP_ARM);
      return true;
    case 'circle': case 'zone':
      proc(w, h, 'twin_cast', def.range > 0 ? p.tx : h.body.x, def.range > 0 ? p.tz : h.body.z, { r: def.radius }, true);
      return false;
    default:
      proc(w, h, 'twin_cast', h.body.x, h.body.z, undefined, true);
      return false;
  }
}

function release(w: World, h: Hero, p: PendingHit): void {
  if (!p.twin) { releaseCore(w, h, p); return; }
  // A twin's hits are ordinary direct hits of the ability; what they deal at once is counted for the keystone.
  const dealt = h.run.damage;
  if (!releaseTwin(w, h, p)) releaseCore(w, h, p);
  h.ks.dealt.twin_cast = (h.ks.dealt.twin_cast ?? 0) + h.run.damage - dealt;
}

function releaseCore(w: World, h: Hero, p: PendingHit): void {
  const def = p.def;
  const x = h.body.x;
  const z = h.body.z;
  if (!p.twin && p.slot === 'secondary' && h.ks.twinCast && !p.echo && def.shape !== 'buff') {
    // The repeat of a lunge starts where the charge started; of a leap, where the hero came down.
    queueTwin(h, def, p.slot, p.aim, def.shape === 'leap' ? x : p.tx, def.shape === 'leap' ? z : p.tz, x, z);
  }
  switch (def.shape) {
    case 'arc': {
      const arc = def.arc * DEG;
      // Titan Grip: the proc marks the release, so it comes before the hits of the swing (same tick).
      if (p.slot === 'primary' && h.ks.heavyHitter) proc(w, h, 'heavy_hitter', x, z, { r: def.range });
      for (const e of w.enemies) {
        if (!isTargetable(e) || !inArc(x, z, p.aim, def.range, arc, e.x, e.z, e.radius)) continue;
        strikeEnemy(w, h, e, def.damage, p.slot, { fromX: x, fromZ: z, stun: def.stun, knockback: def.knockback, special: def.special });
      }
      popFragileArc(w, h.slot, x, z, p.aim, def.range, arc);
      if (p.slot === 'primary' && (h.ks.ricochet || h.ks.spellblade)) onMeleeSwing(w, h, def, p.aim);
      break;
    }
    case 'projectile': {
      if (!def.projectile) break;
      // Abilities without a spread of their own fan extra projectiles out a little (mage_split).
      const spread = def.arc > 0 ? def.arc * DEG : (def.count - 1) * SIM.SPLIT_SPREAD_DEG * DEG;
      let pierce = def.pierce;
      let bonus = 0;
      if (h.spellweave && def.projectile === 'bladeWave') {
        h.spellweave = false;
        bonus = TALENT.SPELLWEAVE_DAMAGE;
        pierce += TALENT.SPELLWEAVE_PIERCE;
      }
      for (let i = 0; i < def.count; i++) {
        const rot = def.count > 1 ? p.aim + (i / (def.count - 1) - 0.5) * spread : p.aim;
        spawnProjectile(w, {
          kind: def.projectile, x, z, rot, speed: def.speed, radius: def.radius, range: def.range, damage: def.damage,
          hostile: false, owner: h.slot, slot: p.slot, pierce, element: elementCode(h, p.slot),
          stun: def.stun, knockback: def.knockback, bonus,
          bounces: p.slot === 'primary' && h.ks.ricochet ? KP.ricochet.bounces : 0, ks: p.twin ? 'twin_cast' : null,
        });
      }
      if (p.slot === 'primary') {
        if (h.ks.heavyHitter) proc(w, h, 'heavy_hitter', x, z);
        if (!p.echo) {
          if (h.ks.rogue) onBolt(w, h, p.aim);
          // Blade Tempest: the finisher sends three waves (its own and one to either side).
          if (h.ks.spellblade) tempest(w, h, p.aim, 2);
        }
      }
      if (h.talent.arcaneEcho && p.slot === 'primary' && !p.echo && ++h.echoCount >= TALENT.ARCANE_ECHO_EVERY) {
        h.echoCount = 0;
        h.pending.push({ def, slot: p.slot, t: SIM.ECHO_DELAY, aim: p.aim, tx: p.tx, tz: p.tz, echo: true });
      }
      break;
    }
    case 'circle':
      if (def.special === 'allElements') overload(w, h, def, p.slot, p.tx, p.tz);
      else if (def.special === 'mark') deathMark(w, h, def, p.slot, p.tx, p.tz);
      else blast(w, h, def, p.slot, p.tx, p.tz);
      break;
    case 'spin':
      h.spin = { def, slot: p.slot, pulsesLeft: Math.max(1, Math.round(def.duration / Math.max(def.tick, SIM.EPS))), timer: 0 };
      if (def.special === 'maelstrom') proc(w, h, 'ks_barbarian', x, z, { r: def.radius * KS.PULL_REACH }, true);
      break;
    case 'lunge': {
      const duration = def.range / DASH.SPEED;
      h.body.dashDirX = Math.sin(p.aim);
      h.body.dashDirZ = Math.cos(p.aim);
      h.body.dashTime = duration;
      // The lunge moves like a dash (so the client can replay it from SelfState); the rest of the lock is a root.
      h.body.rootTime = Math.max(0, h.lockTime - duration);
      h.lunge = { def, slot: p.slot, hit: new Set() };
      lungeSweep(w, h, x, z);
      break;
    }
    case 'beam': {
      const bx = x + Math.sin(p.aim) * def.range;
      const bz = z + Math.cos(p.aim) * def.range;
      for (const e of w.enemies) {
        if (!isTargetable(e) || segDist(x, z, bx, bz, e.x, e.z) > def.radius + e.radius) continue;
        strikeEnemy(w, h, e, def.damage, p.slot, { fromX: x, fromZ: z, stun: def.stun, knockback: def.knockback, special: def.special });
      }
      popFragileSegment(w, h.slot, x, z, bx, bz, def.radius);
      break;
    }
    case 'leap':
      // Landed: the blast is centred on where the hero actually came down.
      h.flight = false;
      blast(w, h, def, p.slot, x, z);
      // Class keystones with the leap arts: a maelstrom / hallowed ground where the hero lands.
      if (p.slot === 'secondary' && h.ks.whirlDef) spawnZone(w, h, h.ks.whirlDef, p.slot, x, z, 0);
      if (p.slot === 'secondary' && h.ks.groundDef) spawnZone(w, h, h.ks.groundDef, p.slot, x, z, 0);
      break;
    case 'zone':
      spawnZone(w, h, def, p.slot, def.range > 0 ? p.tx : x, def.range > 0 ? p.tz : z, 0);
      break;
    case 'buff': {
      if (!def.buff) break;
      const r2 = def.radius * def.radius;
      for (const ally of w.heroes) {
        if (ally.state !== 'alive') continue;
        if (ally !== h) {
          const dx = ally.body.x - x;
          const dz = ally.body.z - z;
          if (def.radius <= 0 || dx * dx + dz * dz > r2) continue;
        }
        ally.buffs[def.buff] = def.duration;
        if (def.radius > 0) grantShield(ally, def.selfShield);
        w.emit({ e: 'buff', slot: ally.slot, id: def.buff, dur: def.duration });
      }
      if (def.buff === 'bulwark') h.taunt = def.duration;
      // An infused buff ultimate marks everything around the hero with its element.
      const inf = h.stats.infusion[p.slot];
      if (inf) {
        const reach = Math.max(def.radius, SIM.BUFF_PULSE_RADIUS);
        w.emit({ e: 'aoe', x, z, r: reach, el: inf.element, hostile: false });
        for (const e of w.enemies) {
          if (!isTargetable(e)) continue;
          const dx = e.x - x;
          const dz = e.z - z;
          const far = reach + e.radius;
          if (dx * dx + dz * dz <= far * far) applyElement(w, e, inf.element, h, inf.potency);
        }
      }
      break;
    }
    default:
      break;
  }
}

/** Hits everything within the lunge radius of the path walked this tick (once per enemy per lunge). */
export function lungeSweep(w: World, h: Hero, fromX: number, fromZ: number): void {
  const lunge = h.lunge;
  if (!lunge) return;
  const def = lunge.def;
  for (const e of w.enemies) {
    if (!isTargetable(e) || lunge.hit.has(e.id)) continue;
    if (segDist(fromX, fromZ, h.body.x, h.body.z, e.x, e.z) > def.radius + e.radius) continue;
    lunge.hit.add(e.id);
    strikeEnemy(w, h, e, def.damage, lunge.slot, { fromX, fromZ, stun: def.stun, knockback: def.knockback, special: def.special });
  }
  popFragileSegment(w, h.slot, fromX, fromZ, h.body.x, h.body.z, def.radius);
}

/** Infused dashes (and dashes with afterimage) strike every enemy near the dash path once. */
export function dashSweep(w: World, h: Hero, fromX: number, fromZ: number): void {
  const infused = h.stats.infusion.dash !== null;
  if (!infused && h.stats.afterimage <= 0) return;
  const damage = (infused ? SIM.DASH_INFUSION_DAMAGE : 0) + h.stats.afterimage;
  for (const e of w.enemies) {
    if (!isTargetable(e) || h.dashHit.has(e.id)) continue;
    if (segDist(fromX, fromZ, h.body.x, h.body.z, e.x, e.z) > SIM.DASH_INFUSION_RADIUS + e.radius) continue;
    h.dashHit.add(e.id);
    strikeEnemy(w, h, e, damage, 'dash', { fromX, fromZ, stun: 0, knockback: 0 });
  }
}

/**
 * Leap: the hero stays put for the first part of the windup and then flies to the landing spot as a dash
 * (DASH.SPEED along dashDir, exactly like a lunge), so SelfState describes the whole movement.
 */
function launchLeap(h: Hero, p: PendingHit): void {
  const dx = p.tx - h.body.x;
  const dz = p.tz - h.body.z;
  const dist = Math.hypot(dx, dz);
  const flight = dist / DASH.SPEED;
  if (p.t > flight + SIM.EPS) return;
  p.launched = true;
  if (dist < SIM.EPS) return;
  h.body.dashDirX = dx / dist;
  h.body.dashDirZ = dz / dist;
  h.body.dashTime = flight;
  h.body.rootTime = Math.max(0, h.lockTime - flight);
  h.flight = true;
}

/** Advances windups and channelled abilities after movement. */
export function stepAbilities(w: World, h: Hero, dt: number): void {
  for (let i = 0; i < h.pending.length; i++) {
    const p = h.pending[i] as PendingHit;
    p.t -= dt;
    if (p.def.shape === 'leap' && !p.twin) {
      if (!p.launched) launchLeap(h, p);
      // The blast waits for the hero to touch down.
      if (p.launched && h.body.dashTime > SIM.EPS) continue;
    }
    if (p.t > SIM.EPS) continue;
    h.pending.splice(i, 1);
    i--;
    release(w, h, p);
  }
  const spin = h.spin;
  if (spin) {
    spin.timer -= dt;
    if (spin.timer <= SIM.EPS) {
      spin.timer += spin.def.tick;
      spin.pulsesLeft--;
      spinPulse(w, h, spin);
      if (spin.pulsesLeft <= 0) h.spin = null;
    }
  }
}
