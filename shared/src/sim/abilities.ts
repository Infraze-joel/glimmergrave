/** Hero abilities: activation rules, windups and hit detection in the XZ plane. */
import { BOON_TUNING } from '../data/boons.ts';
import { COMBO_WINDOW, DASH, type AbilityDef } from '../data/classes.ts';
import { HAZARD } from '../data/enemies.ts';
import { BTN, ELEMENT_IDS, type AbilitySlot, type InputCmd } from '../types.ts';
import { isTargetable, strikeEnemy } from './combat.ts';
import { clamp, DEG, inArc, segDist } from './geom.ts';
import { startDash } from './movement.ts';
import { popFragileArc, popFragileCircle, popFragileSegment, spawnProjectile } from './projectiles.ts';
import type { Hero, PendingHit } from './state.ts';
import { SIM } from './tuning.ts';
import type { World } from './world.ts';

/** Speed handed to stepMovement this tick: class speed x upgrades x boons x haste x chill x ability move multiplier. */
export function heroMoveSpeed(h: Hero): number {
  let speed = h.def.moveSpeed * h.stats.moveSpeed * (1 + h.meta.moveSpeed);
  if (h.oathbondTime > 0) speed *= 1 + BOON_TUNING.OATHBOND_HASTE;
  if (h.chillTime > 0) speed *= 1 - HAZARD.FROST.SLOW;
  if (h.lockTime > SIM.EPS) speed *= h.lockMoveMul;
  return speed;
}

export const dashRechargeSeconds = (h: Hero): number => DASH.COOLDOWN / (h.stats.dashRecharge * (1 + h.meta.dashHaste));

/** Secondary cooldown after boons (quick_wits shortens it) and the celerity upgrade (recharges faster). */
export const secondaryCooldown = (h: Hero): number => (h.def.secondary.cooldown * (1 - h.stats.secondaryCdr)) / (1 + h.meta.secondaryHaste);

const elementCode = (h: Hero, slot: AbilitySlot): number => {
  const inf = h.stats.infusion[slot];
  return inf ? ELEMENT_IDS.indexOf(inf.element) + 1 : 0;
};

function playAction(h: Hero, def: AbilityDef, seconds: number): void {
  h.anim = def.anim;
  h.animSeq++;
  h.animTime = Math.max(seconds, SIM.ACTION_ANIM_MIN_SECONDS);
}

function dash(w: World, h: Hero, cmd: InputCmd): void {
  startDash(h.body, cmd.moveX, cmd.moveZ, cmd.aim);
  h.pressDash = 0;
  h.dashCharges--;
  if (h.dashRecharge <= SIM.EPS) h.dashRecharge = dashRechargeSeconds(h);
  if (h.invuln < DASH.IFRAMES) h.invuln = DASH.IFRAMES;
  // A dash cancels the lock / root of the current ability and an unreleased lunge; other wound-up hits still land.
  h.lockTime = 0;
  h.lockMoveMul = 1;
  h.lunge = null;
  for (let i = h.pending.length - 1; i >= 0; i--) if ((h.pending[i] as PendingHit).def.shape === 'lunge') h.pending.splice(i, 1);
  h.dashHit.clear();
  h.anim = 'dash';
  h.animSeq++;
  h.animTime = DASH.DURATION;
  w.emit({ e: 'cast', who: { t: 'p', id: h.slot }, ability: 'dash', x: h.body.x, z: h.body.z, rot: Math.atan2(h.body.dashDirX, h.body.dashDirZ) });
}

function activate(w: World, h: Hero, def: AbilityDef, slot: AbilitySlot, cmd: InputCmd): void {
  const speed = slot === 'primary' ? h.stats.attackSpeed : 1;
  const lock = def.lock / speed;
  const windup = def.windup / speed;
  if (slot === 'primary') {
    h.primaryCd = def.cooldown / speed;
    h.comboIndex = (h.comboIndex + 1) % h.def.primary.length;
    h.comboTime = lock + COMBO_WINDOW;
    h.pressPrimary = 0;
  } else {
    const cd = secondaryCooldown(h);
    h.secondaryCd = cd;
    h.secondaryCdMax = cd;
    h.pressSecondary = 0;
  }
  h.lockTime = lock;
  h.lockMoveMul = def.moveMul;
  if (def.moveMul === 0) h.body.rootTime = lock;
  playAction(h, def, Math.max(lock, windup));

  let tx = h.body.x;
  let tz = h.body.z;
  if (def.shape === 'circle') {
    const reach = clamp(cmd.aimDist, 0, def.range);
    tx = clamp(h.body.x + Math.sin(cmd.aim) * reach, -w.room.w / 2, w.room.w / 2);
    tz = clamp(h.body.z + Math.cos(cmd.aim) * reach, -w.room.d / 2, w.room.d / 2);
  }
  w.emit({ e: 'cast', who: { t: 'p', id: h.slot }, ability: def.id, x: tx, z: tz, rot: cmd.aim });
  if (def.selfShield > 0) {
    if (h.tempShield < def.selfShield) h.tempShield = def.selfShield;
    h.tempShieldTime = SIM.TEMP_SHIELD_SECONDS;
  }
  h.pending.push({ def, slot, t: windup, aim: cmd.aim, tx, tz });
}

/**
 * Called once per tick with the consumed input, before movement. Dash triggers on a (buffered) press and may
 * interrupt anything; SECONDARY triggers on a (buffered) press; PRIMARY repeats while held.
 */
export function startAbilities(w: World, h: Hero, cmd: InputCmd, buttons: number): void {
  if (h.pressDash > SIM.EPS && h.dashCharges >= 1) dash(w, h, cmd);
  if (h.lockTime > SIM.EPS || h.body.dashTime > SIM.EPS) return;
  if (h.pressSecondary > SIM.EPS && h.secondaryCd <= SIM.EPS) {
    activate(w, h, h.def.secondary, 'secondary', cmd);
  } else if (((buttons & BTN.PRIMARY) !== 0 || h.pressPrimary > SIM.EPS) && h.primaryCd <= SIM.EPS) {
    activate(w, h, h.def.primary[h.comboIndex % h.def.primary.length] as AbilityDef, 'primary', cmd);
  }
}

function release(w: World, h: Hero, p: PendingHit): void {
  const def = p.def;
  const x = h.body.x;
  const z = h.body.z;
  switch (def.shape) {
    case 'arc': {
      const arc = def.arc * DEG;
      for (const e of w.enemies) {
        if (!isTargetable(e) || !inArc(x, z, p.aim, def.range, arc, e.x, e.z, e.radius)) continue;
        strikeEnemy(w, h, e, def.damage, p.slot, { fromX: x, fromZ: z, stun: def.stun, knockback: def.knockback });
      }
      popFragileArc(w, h.slot, x, z, p.aim, def.range, arc);
      break;
    }
    case 'projectile': {
      if (!def.projectile) break;
      const spread = def.arc * DEG;
      for (let i = 0; i < def.count; i++) {
        const rot = def.count > 1 ? p.aim + (i / (def.count - 1) - 0.5) * spread : p.aim;
        spawnProjectile(w, {
          kind: def.projectile, x, z, rot, speed: def.speed, radius: def.radius, range: def.range, damage: def.damage,
          hostile: false, owner: h.slot, slot: p.slot, pierce: def.pierce, element: elementCode(h, p.slot),
          stun: def.stun, knockback: def.knockback,
        });
      }
      break;
    }
    case 'circle': {
      const inf = h.stats.infusion[p.slot];
      w.emit({ e: 'aoe', x: p.tx, z: p.tz, r: def.radius, el: inf ? inf.element : null, hostile: false });
      for (const e of w.enemies) {
        if (!isTargetable(e)) continue;
        const reach = def.radius + e.radius;
        const dx = e.x - p.tx;
        const dz = e.z - p.tz;
        if (dx * dx + dz * dz > reach * reach) continue;
        strikeEnemy(w, h, e, def.damage, p.slot, { fromX: p.tx, fromZ: p.tz, stun: def.stun, knockback: def.knockback });
      }
      popFragileCircle(w, h.slot, p.tx, p.tz, def.radius);
      break;
    }
    case 'spin':
      h.spin = { def, pulsesLeft: Math.max(1, Math.round(def.duration / Math.max(def.tick, SIM.EPS))), timer: 0 };
      break;
    case 'lunge': {
      const duration = def.range / DASH.SPEED;
      h.body.dashDirX = Math.sin(p.aim);
      h.body.dashDirZ = Math.cos(p.aim);
      h.body.dashTime = duration;
      // The lunge moves like a dash (so the client can replay it from SelfState); the rest of the lock is a root.
      h.body.rootTime = Math.max(0, h.lockTime - duration);
      h.lunge = { def, hit: new Set() };
      lungeSweep(w, h, x, z);
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
    strikeEnemy(w, h, e, def.damage, 'secondary', { fromX, fromZ, stun: def.stun, knockback: def.knockback });
  }
  popFragileSegment(w, h.slot, fromX, fromZ, h.body.x, h.body.z, def.radius);
}

/** Infused dashes strike (and mark) every enemy near the dash path once. */
export function dashSweep(w: World, h: Hero, fromX: number, fromZ: number): void {
  if (!h.stats.infusion.dash) return;
  for (const e of w.enemies) {
    if (!isTargetable(e) || h.dashHit.has(e.id)) continue;
    if (segDist(fromX, fromZ, h.body.x, h.body.z, e.x, e.z) > SIM.DASH_INFUSION_RADIUS + e.radius) continue;
    h.dashHit.add(e.id);
    strikeEnemy(w, h, e, SIM.DASH_INFUSION_DAMAGE, 'dash', { fromX, fromZ, stun: 0, knockback: 0 });
  }
}

/** Advances windups and channelled abilities after movement. */
export function stepAbilities(w: World, h: Hero, dt: number): void {
  for (let i = 0; i < h.pending.length; i++) {
    const p = h.pending[i] as PendingHit;
    p.t -= dt;
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
      const def = spin.def;
      for (const e of w.enemies) {
        if (!isTargetable(e)) continue;
        const reach = def.radius + e.radius;
        const dx = e.x - h.body.x;
        const dz = e.z - h.body.z;
        if (dx * dx + dz * dz > reach * reach) continue;
        strikeEnemy(w, h, e, def.damage, 'secondary', { fromX: h.body.x, fromZ: h.body.z, stun: def.stun, knockback: def.knockback });
      }
      popFragileCircle(w, h.slot, h.body.x, h.body.z, def.radius);
      if (spin.pulsesLeft <= 0) h.spin = null;
    }
  }
}
