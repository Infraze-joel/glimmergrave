/** Hero lifecycle: creation, input queue, per-tick update, revives and auras. */
import { TICK_DT, WORLD } from '../constants.ts';
import { BOON_TUNING } from '../data/boons.ts';
import { CLASSES } from '../data/classes.ts';
import { HAZARD } from '../data/enemies.ts';
import { BTN, type ClassId, type InputCmd } from '../types.ts';
import { dashRechargeSeconds, dashSweep, heroMoveSpeed, lungeSweep, startAbilities, stepAbilities } from './abilities.ts';
import { emptyStats, maxDashCharges } from './boons.ts';
import { buildAbilities, noSetTiers, permanentOf, refreshHero, sanitizeBuild } from './build.ts';
import { dotHero, reviveHero } from './combat.ts';
import { clamp, finite, TAU } from './geom.ts';
import { computeMeta } from './meta.ts';
import { emptyMods } from '../data/mods.ts';
import { stepMovement } from './movement.ts';
import { emptyInput, type Hero } from './state.ts';
import { META, SIM } from './tuning.ts';
import type { World } from './world.ts';

const BUTTON_MASK = BTN.PRIMARY | BTN.SECONDARY | BTN.DASH | BTN.INTERACT | BTN.ULTIMATE;
const MAX_SEQ = 0xffffffff;

/**
 * `loadout` is the hero's permanent build: a (partial) Loadout, or just the list of upgrade levels. It is clamped
 * here (again) and survives resets; `plain` heroes ignore every permanent bonus (training sessions).
 */
export function createHero(slot: number, cls: ClassId, name: string, loadout?: unknown): Hero {
  const def = CLASSES[cls];
  const build = sanitizeBuild(loadout, cls);
  const meta = computeMeta(build.meta);
  const perm = permanentOf(cls, build);
  const h: Hero = {
    slot, name, cls, def, connected: true,
    body: { x: 0, z: 0, dashTime: 0, dashDirX: 0, dashDirZ: 1, rootTime: 0, moveSpeed: def.moveSpeed },
    rot: Math.PI, hp: def.maxHp, maxHp: def.maxHp, barrier: 0, barrierDelay: 0, tempShield: 0, tempShieldTime: 0,
    state: 'alive', anim: 'idle', animSeq: 0, animTime: 0,
    queue: [], input: emptyInput(), ackSeq: 0, prevButtons: 0, pressPrimary: 0, pressSecondary: 0, pressDash: 0, pressUltimate: 0,
    lockTime: 0, lockMoveMul: 1, comboIndex: 0, comboTime: 0, primaryCd: 0, secondaryCd: 0, secondaryCdMax: def.secondary.cooldown,
    dashCharges: def.dashCharges, dashRecharge: 0, dashHit: new Set(), pending: [], spin: null, lunge: null, flight: false, invuln: 0,
    ult: 0, buffs: { bloodrage: 0, bulwark: 0, overload: 0 }, taunt: 0, overloadEls: [], overloadIndex: 0,
    boons: [], stats: emptyStats(), lastStandUsed: false, oathbondTime: 0, oathbondArmed: true, aura: 0,
    revive: 0, secondWindTimer: 0, draft: [], draftOpts: null,
    rerolls: meta.stats.rerolls + (perm.relic.hourglass > 0 ? 1 : 0), metaLevels: meta.levels, meta: meta.stats,
    build, perm: perm.mods, mods: emptyMods(), abil: buildAbilities(def, build.art, { boons: [] }, 0), talent: perm.talent, relic: perm.relic,
    setTiers: noSetTiers(), setSpread: [], setOverflow: false, setBond: false,
    momentum: 0, momentumTime: 0, rampage: 0, rampageTime: 0, riposte: false, spellweave: false, echoCount: 0, coilHits: 0,
    phoenixUsed: false, slipstreamTime: 0, sanctuary: 0, shards: [], cursedShards: 0,
    burnTime: 0, burnTimer: 0, chillTime: 0, inDoor: false,
    run: { slot, damage: 0, kills: 0, resonances: 0, revives: 0, downs: 0, elites: 0, bosses: 0, ultimates: 0 },
    damageTaken: 0,
  };
  refreshHero(h);
  h.hp = h.maxHp;
  h.dashCharges = maxDashCharges(h);
  h.secondaryCdMax = h.abil.secondary.cooldown;
  return h;
}

/** Back to a fresh, boon-less hero (new run or return to the lobby). Keeps slot, class, name and connection. */
export function resetHero(h: Hero): void {
  const fresh = createHero(h.slot, h.cls, h.name, h.build);
  fresh.connected = h.connected;
  fresh.ackSeq = h.ackSeq;
  fresh.input = { ...h.input, buttons: 0, moveX: 0, moveZ: 0 };
  Object.assign(h, fresh);
}

/** Stops everything in flight and moves the hero (chamber transitions). Cooldowns are kept. */
export function placeHero(h: Hero, x: number, z: number): void {
  h.body.x = x;
  h.body.z = z;
  h.body.dashTime = 0;
  h.body.rootTime = 0;
  h.pending.length = 0;
  h.spin = null;
  h.lunge = null;
  h.flight = false;
  h.lockTime = 0;
  h.lockMoveMul = 1;
  h.sanctuary = 0;
  h.inDoor = false;
  h.revive = 0;
  h.burnTime = 0;
  h.chillTime = 0;
}

/** Untrusted input: every field is forced into its legal range before it reaches the simulation. */
export function sanitizeInput(raw: InputCmd): InputCmd {
  const aim = finite(raw.aim) % TAU;
  return {
    seq: clamp(Math.floor(finite(raw.seq)), 0, MAX_SEQ),
    moveX: clamp(finite(raw.moveX), -1, 1),
    moveZ: clamp(finite(raw.moveZ), -1, 1),
    aim: aim < 0 ? aim + TAU : aim,
    aimDist: clamp(finite(raw.aimDist), 0, SIM.MAX_AIM_DIST),
    buttons: Math.floor(finite(raw.buttons)) & BUTTON_MASK,
  };
}

export function queueInput(h: Hero, raw: InputCmd): void {
  h.queue.push(sanitizeInput(raw));
  while (h.queue.length > SIM.INPUT_BUFFER_MAX) h.queue.shift();
}

const tickDown = (v: number, dt: number): number => (v > dt ? v - dt : 0);

export function stepHero(w: World, h: Hero): void {
  const dt = TICK_DT;
  const next = h.connected ? h.queue.shift() : undefined;
  if (next) {
    h.input = next;
    h.ackSeq = next.seq;
  }
  const cmd = h.input;
  const buttons = h.connected ? cmd.buttons : 0;
  const pressed = buttons & ~h.prevButtons;
  h.prevButtons = buttons;
  const active = h.state === 'alive' && h.connected && w.run.phase !== 'defeat';

  if (active) {
    if (pressed & BTN.PRIMARY) h.pressPrimary = SIM.PRESS_BUFFER_SECONDS;
    if (pressed & BTN.SECONDARY) h.pressSecondary = SIM.PRESS_BUFFER_SECONDS;
    if (pressed & BTN.DASH) h.pressDash = SIM.PRESS_BUFFER_SECONDS;
    if (pressed & BTN.ULTIMATE) h.pressUltimate = SIM.PRESS_BUFFER_SECONDS;
    startAbilities(w, h, cmd, buttons);
    h.body.moveSpeed = heroMoveSpeed(h);
    const fromX = h.body.x;
    const fromZ = h.body.z;
    const dashing = h.body.dashTime > SIM.EPS;
    stepMovement(h.body, cmd.moveX, cmd.moveZ, dt, w.room);
    if (dashing) {
      if (h.lunge) lungeSweep(w, h, fromX, fromZ);
      else if (!h.flight) dashSweep(w, h, fromX, fromZ);
    }
    if (h.lunge && h.body.dashTime <= SIM.EPS) h.lunge = null;
    stepAbilities(w, h, dt);
    h.rot = h.body.dashTime > SIM.EPS ? Math.atan2(h.body.dashDirX, h.body.dashDirZ) : cmd.aim;
  } else {
    h.body.moveSpeed = 0;
    h.body.dashTime = 0;
    h.pressPrimary = 0;
    h.pressSecondary = 0;
    h.pressDash = 0;
    h.pressUltimate = 0;
  }

  // Timers
  h.primaryCd = tickDown(h.primaryCd, dt);
  h.secondaryCd = tickDown(h.secondaryCd, dt);
  h.lockTime = tickDown(h.lockTime, dt);
  if (h.lockTime <= SIM.EPS) h.lockMoveMul = 1;
  h.pressPrimary = tickDown(h.pressPrimary, dt);
  h.pressSecondary = tickDown(h.pressSecondary, dt);
  h.pressDash = tickDown(h.pressDash, dt);
  h.pressUltimate = tickDown(h.pressUltimate, dt);
  h.buffs.bloodrage = tickDown(h.buffs.bloodrage, dt);
  h.buffs.bulwark = tickDown(h.buffs.bulwark, dt);
  h.buffs.overload = tickDown(h.buffs.overload, dt);
  h.taunt = tickDown(h.taunt, dt);
  h.slipstreamTime = tickDown(h.slipstreamTime, dt);
  if (h.momentumTime > 0) {
    h.momentumTime = tickDown(h.momentumTime, dt);
    if (h.momentumTime <= SIM.EPS) h.momentum = 0;
  }
  if (h.rampageTime > 0) {
    h.rampageTime = tickDown(h.rampageTime, dt);
    if (h.rampageTime <= SIM.EPS) h.rampage = 0;
  }
  h.invuln = tickDown(h.invuln, dt);
  h.animTime = tickDown(h.animTime, dt);
  h.oathbondTime = tickDown(h.oathbondTime, dt);
  h.chillTime = tickDown(h.chillTime, dt);
  if (h.burnTime > 0) {
    h.burnTime = tickDown(h.burnTime, dt);
    h.burnTimer -= dt;
    if (h.burnTimer <= SIM.EPS) {
      h.burnTimer += HAZARD.VENT.BURN_TICK;
      dotHero(w, h, HAZARD.VENT.BURN_DPS * HAZARD.VENT.BURN_TICK, 'ember');
    }
  }
  if (h.comboTime > 0) {
    h.comboTime = tickDown(h.comboTime, dt);
    if (h.comboTime <= SIM.EPS) h.comboIndex = 0;
  }
  if (h.tempShieldTime > 0) {
    h.tempShieldTime = tickDown(h.tempShieldTime, dt);
    if (h.tempShieldTime <= SIM.EPS) h.tempShield = 0;
  }
  if (h.state === 'alive') {
    if (h.barrierDelay > 0) {
      h.barrierDelay = tickDown(h.barrierDelay, dt);
    } else if (h.barrier < h.stats.barrier) {
      h.barrier = h.stats.barrier;
    }
    if (!h.oathbondArmed && h.hp >= h.maxHp * SIM.OATHBOND_HP_THRESHOLD) h.oathbondArmed = true;
  }
  const maxCharges = maxDashCharges(h);
  if (h.dashCharges < maxCharges) {
    h.dashRecharge -= dt;
    if (h.dashRecharge <= SIM.EPS) {
      h.dashCharges++;
      h.dashRecharge = h.dashCharges < maxCharges ? dashRechargeSeconds(h) : 0;
    }
  } else {
    h.dashRecharge = 0;
  }

  // Passive animation once the action clip has finished.
  if (h.state !== 'alive') {
    h.anim = 'downed';
  } else if (h.animTime <= SIM.EPS) {
    if (w.run.phase === 'victory') h.anim = 'cheer';
    else if (active && h.body.rootTime <= SIM.EPS && Math.hypot(cmd.moveX, cmd.moveZ) > SIM.RUN_ANIM_THRESHOLD) h.anim = 'run';
    else h.anim = 'idle';
  }
}

/** How fast a hero revives others: lifeline boon plus the reviveSpeed mod (talents, kinship set). */
const reviveRate = (h: Hero): number => 1 + h.stats.lifeline + h.mods.reviveSpeed;

/** Auras, revives and Second Wind; runs once per tick after every hero has moved. */
export function stepHeroInteractions(w: World): void {
  const dt = TICK_DT;
  for (const h of w.heroes) {
    h.aura = 0;
    if (h.state !== 'alive') continue;
    for (const o of w.heroes) {
      if (o.state !== 'alive' || !o.connected || o.stats.kindred <= h.aura) continue;
      const dx = o.body.x - h.body.x;
      const dz = o.body.z - h.body.z;
      if (dx * dx + dz * dz <= BOON_TUNING.KINDRED_RADIUS * BOON_TUNING.KINDRED_RADIUS) h.aura = o.stats.kindred;
    }
  }
  for (const d of w.heroes) {
    if (d.state !== 'downed') continue;
    if (d.secondWindTimer > 0) {
      d.secondWindTimer -= dt;
      if (d.secondWindTimer <= SIM.EPS) {
        reviveHero(w, d, d.slot, WORLD.REVIVE_HP_FRACTION * (1 + d.stats.lifeline), SIM.SECOND_WIND_IFRAMES);
      }
      continue;
    }
    let reviver: Hero | null = null;
    for (const o of w.heroes) {
      if (o === d || o.state !== 'alive' || !o.connected) continue;
      const dx = o.body.x - d.body.x;
      const dz = o.body.z - d.body.z;
      if (dx * dx + dz * dz > WORLD.REVIVE_RADIUS * WORLD.REVIVE_RADIUS) continue;
      if (!reviver || reviveRate(o) > reviveRate(reviver)) reviver = o;
    }
    if (reviver) {
      d.revive += (dt / WORLD.REVIVE_SECONDS) * reviveRate(reviver) * (d.meta.tenacity ? 1 + META.TENACITY_REVIVE : 1);
      if (d.revive >= 1 - SIM.EPS) {
        reviver.run.revives++;
        reviveHero(w, d, reviver.slot, WORLD.REVIVE_HP_FRACTION * (1 + reviver.stats.lifeline), SIM.REVIVE_IFRAMES);
      }
    } else if (d.revive > 0) {
      d.revive = Math.max(0, d.revive - SIM.REVIVE_DECAY_PER_SECOND * dt);
    }
  }
}
