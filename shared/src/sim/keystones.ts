/**
 * Keystones (update 5): what the 23 keystones of data/keystones.ts do, apart from the places where they change
 * an existing rule in passing (combat.ts: damage, healing, charge; build.ts: reshaped abilities; abilities.ts:
 * twin casts, the blood price, the stream). Everything here is PvE only: nothing damages heroes or the bell shard.
 *
 * Damage a keystone deals itself is dealt while `World.ksSource` names it. Such hits are not "direct": they never
 * trigger Chain Lightning, never spend the Phase Walker crit or the Veil bonus and never knock back with Colossus.
 */
import { TICK_DT, WORLD } from '../constants.ts';
import { ULTIMATE } from '../data/classes.ts';
import { KEYSTONES, KEYSTONE_BY_ID, KEYSTONE_CAPS, KEYSTONE_NEEDS_ELEMENTS, KEYSTONE_TUNING } from '../data/keystones.ts';
import { ELEMENT_IDS, type AbilitySlot, type BoonOffer, type ElementId, type InputCmd } from '../types.ts';
import { heroElements, maxDashCharges } from './boons.ts';
import { refreshHero } from './build.ts';
import { addCharge, allDamage, applyElement, healHero, isBoss, isTargetable, rawDamageEnemy, strikeEnemy } from './combat.ts';
import { rayLength } from './enemies.ts';
import { DEG, segDist, TAU } from './geom.ts';
import { KP } from './ksState.ts';
import { popFragileCircle, popFragileSegment, spawnProjectile } from './projectiles.ts';
import type { Rng } from './rng.ts';
import type { AbilityDef, Enemy, Hero, Projectile, SpinState, Trail } from './state.ts';
import { KS, SIM, TALENT } from './tuning.ts';
import type { World } from './world.ts';

const PROC_TICKS = Math.round(KEYSTONE_CAPS.PROC_SECONDS / TICK_DT);
const BLADE_TICKS = Math.round(KEYSTONE_CAPS.BLADE_HIT_SECONDS / TICK_DT);

interface ProcExtra { n?: number; r?: number; tx?: number; tz?: number }

/**
 * Emits a `keystoneProc`, rate-limited per hero and keystone: bursts are PROC_SECONDS apart and hold at most
 * PROC_BURST events of one tick. `force` (events that carry state, e.g. Bloodrush stacks) is never dropped.
 */
export function proc(w: World, h: Hero, id: string, x: number, z: number, extra?: ProcExtra, force = false): void {
  const ks = h.ks;
  const last = ks.procTick.get(id);
  if (!force) {
    if (last === w.tick) {
      const n = ks.procCount.get(id) ?? 0;
      if (n >= KEYSTONE_CAPS.PROC_BURST) return;
      ks.procCount.set(id, n + 1);
    } else {
      if (last !== undefined && w.tick - last < PROC_TICKS) return;
      ks.procTick.set(id, w.tick);
      ks.procCount.set(id, 1);
    }
  }
  w.emit({ e: 'keystoneProc', slot: h.slot, id, x, z, ...extra });
}

/** Runs `fn` with the damage it deals attributed to keystone `id` (and marked as not direct). */
function as(w: World, id: string, fn: () => void): void {
  const before = w.ksSource;
  w.ksSource = id;
  try { fn(); } finally { w.ksSource = before; }
}

const elementOf = (h: Hero, slot: AbilitySlot): ElementId | null => {
  const inf = h.stats.infusion[slot];
  return inf ? inf.element : null;
};
const elementCode = (h: Hero, slot: AbilitySlot): number => {
  const inf = h.stats.infusion[slot];
  return inf ? ELEMENT_IDS.indexOf(inf.element) + 1 : 0;
};

// ---------------------------------------------------------------------------------------------- taking keystones

/**
 * Gives the hero keystone `id` (replacing `replace` if given), recomputes the build and applies what changes at
 * once: health (Colossus heals what it adds, Glass Cannon cuts current health to the new maximum), dash charges.
 * Returns false for an unknown id, one the hero holds, a wrong class, full slots without a valid `replace`.
 */
export function takeKeystone(w: World, h: Hero, id: string, replace?: string): boolean {
  const def = KEYSTONE_BY_ID.get(id);
  if (!def || h.keystones.includes(id) || (def.cls !== undefined && def.cls !== h.cls)) return false;
  let replaced: string | undefined;
  if (replace !== undefined && h.keystones.includes(replace)) replaced = replace;
  if (h.keystones.length - (replaced ? 1 : 0) >= KEYSTONE_TUNING.MAX_HELD) return false;
  const beforeMaxHp = h.maxHp;
  const beforeCharges = maxDashCharges(h);
  if (replaced) {
    const at = h.keystones.indexOf(replaced);
    h.keystones.splice(at, 1);
    h.keystoneAt.splice(at, 1);
    dropKeystoneState(h, replaced);
  }
  h.keystones.push(id);
  h.keystoneAt.push(w.run.chambersCleared);
  refreshHero(h);
  const gain = h.maxHp - beforeMaxHp;
  if (gain > 0 && h.state === 'alive') h.hp = Math.min(h.maxHp, h.hp + gain);
  if (h.hp > h.maxHp) h.hp = h.maxHp;
  const charges = maxDashCharges(h);
  if (charges > beforeCharges) h.dashCharges = Math.min(charges, h.dashCharges + (charges - beforeCharges));
  else if (h.dashCharges > charges) h.dashCharges = charges;
  h.secondaryCd = Math.min(h.secondaryCd, h.abil.secondary.cooldown);
  const ev: { e: 'keystone'; slot: number; id: string; replaced?: string } = { e: 'keystone', slot: h.slot, id };
  if (replaced) ev.replaced = replaced;
  w.emit(ev);
  w.boonVersion++;
  return true;
}

/** Forgets what a keystone that was given up kept track of. */
function dropKeystoneState(h: Hero, id: string): void {
  const ks = h.ks;
  if (id === 'momentum_engine') { ks.stacks = 0; ks.stackTime = 0; }
  if (id === 'sanguine') { ks.overheal = 0; ks.leech = 0; }
  if (id === 'phase_walker') { ks.phaseTime = 0; ks.phaseCrit = false; }
  if (id === 'ks_shade') { ks.veilTime = 0; ks.veilHit = false; }
  if (id === 'ks_mage') ks.channel = 0;
  if (id === 'twin_cast') ks.spinTwin = null;
  if (id === 'orbit_blades') ks.bladeAt.clear();
}

/** New chamber: timers and per-chamber memory start over (stacks, windows, blade memory). */
export function resetKeystoneTimers(h: Hero): void {
  const ks = h.ks;
  ks.dashing = false;
  ks.trail = null;
  ks.phaseTime = 0;
  ks.phaseCrit = false;
  ks.veilTime = 0;
  ks.veilHit = false;
  ks.chainCd = 0;
  ks.bladeAt.clear();
  ks.channel = 0;
  ks.spinTwin = null;
  ks.procTick.clear();
  ks.procCount.clear();
}

/**
 * Offers of a keystone draft: CHOICES keystones the hero does not hold and may hold (class), drawn with the
 * run's generator; the class keystone weighs CLASS_WEIGHT. `pins` (tools / tests) come first where eligible.
 * `exclude` (rerolls): what was just shown, offered again only when nothing else is left.
 */
export function generateKeystoneDraft(rng: Rng, h: Hero, pins: readonly string[] = [], exclude?: ReadonlySet<string>): BoonOffer[] {
  const elements = heroElements(h).size;
  const eligible = KEYSTONES.filter((k) => !h.keystones.includes(k.id) && (k.cls === undefined || k.cls === h.cls) && elements >= (KEYSTONE_NEEDS_ELEMENTS[k.id] ?? 0));
  const pool = exclude ? eligible.filter((k) => !exclude.has(k.id)) : [...eligible];
  const picked: string[] = [];
  for (const id of pins) {
    const at = pool.findIndex((k) => k.id === id);
    if (at < 0 || picked.length >= KEYSTONE_TUNING.CHOICES) continue;
    picked.push(id);
    pool.splice(at, 1);
  }
  const draw = (from: typeof pool): void => {
    while (picked.length < KEYSTONE_TUNING.CHOICES && from.length > 0) {
      const index = rng.weighted(from.map((k) => (k.cls !== undefined ? KEYSTONE_TUNING.CLASS_WEIGHT : 1)));
      const k = from[index];
      if (!k) break;
      picked.push(k.id);
      from.splice(index, 1);
    }
  };
  draw(pool);
  if (exclude && picked.length < KEYSTONE_TUNING.CHOICES) draw(eligible.filter((k) => exclude.has(k.id) && !picked.includes(k.id)));
  return picked.map((id) => ({ id, level: 1 }));
}

// ---------------------------------------------------------------------------------------------- dash keystones

/** A real dash begins (abilities.ts: dash). */
export function onDashStart(h: Hero): void {
  const ks = h.ks;
  ks.dashing = true;
  ks.phaseDone = false;
  ks.trail = ks.emberWake
    ? { owner: h.slot, ax: h.body.x, az: h.body.z, bx: h.body.x, bz: h.body.z, r: (KP.wake.width / 2) * ks.area, time: KP.wake.seconds, timer: 0, open: true }
    : null;
}

/** Called every tick of a real dash after the hero moved from (fromX, fromZ). */
export function onDashMove(w: World, h: Hero, fromX: number, fromZ: number): void {
  const ks = h.ks;
  if (!ks.dashing) return;
  const trail = ks.trail;
  if (trail) {
    if (!w.trails.includes(trail)) addTrail(w, trail);
    trail.bx = h.body.x;
    trail.bz = h.body.z;
  }
  if (ks.phaseWalker && !ks.phaseDone) {
    for (const e of w.enemies) {
      if (!isTargetable(e)) continue;
      if (segDist(fromX, fromZ, h.body.x, h.body.z, e.x, e.z) > e.radius + WORLD.PLAYER_RADIUS + KS.PHASE_PAD) continue;
      ks.phaseDone = true;
      ks.phaseTime = KP.phase.seconds;
      ks.phaseCrit = true;
      w.emit({ e: 'buff', slot: h.slot, id: 'phase_walker', dur: KP.phase.seconds });
      proc(w, h, 'phase_walker', e.x, e.z);
      break;
    }
  }
}

/** The dash is over (it ran out; a hero that goes down mid-dash gets `abort`). */
export function onDashEnd(w: World, h: Hero, abort = false): void {
  const ks = h.ks;
  if (!ks.dashing) return;
  ks.dashing = false;
  const trail = ks.trail;
  ks.trail = null;
  if (trail) {
    trail.open = false;
    if (w.trails.includes(trail)) proc(w, h, 'ember_wake', trail.ax, trail.az, { tx: trail.bx, tz: trail.bz, r: trail.r }, true);
  }
  if (abort || !ks.shockstep || w.run.phase !== 'combat') return;
  const x = h.body.x;
  const z = h.body.z;
  const r = KP.shock.radius * ks.area;
  w.emit({ e: 'aoe', x, z, r, el: elementOf(h, 'dash'), hostile: false });
  proc(w, h, 'shockstep', x, z, { r }, true);
  as(w, 'shockstep', () => {
    for (const e of w.enemies) {
      if (!isTargetable(e)) continue;
      const reach = r + e.radius;
      const dx = e.x - x;
      const dz = e.z - z;
      if (dx * dx + dz * dz > reach * reach) continue;
      strikeEnemy(w, h, e, KP.shock.damage, 'dash', { fromX: x, fromZ: z, stun: 0, knockback: KP.shock.knockback });
    }
  });
  if (w.fragileCount > 0) popFragileCircle(w, h.slot, x, z, r);
}

function addTrail(w: World, trail: Trail): void {
  let own = 0;
  for (const t of w.trails) if (t.owner === trail.owner) own++;
  for (let i = 0; i < w.trails.length && own >= KEYSTONE_CAPS.TRAILS_PER_HERO; i++) {
    if ((w.trails[i] as Trail).owner !== trail.owner) continue;
    w.trails.splice(i, 1);
    i--;
    own--;
  }
  w.trails.push(trail);
}

// ---------------------------------------------------------------------------------------------- world step

/** Trails and waiting Corpse Blooms; once per tick in combat, after the enemies moved. */
export function stepWorldKeystones(w: World): void {
  const dt = TICK_DT;
  const trails = w.trails;
  let keep = 0;
  for (let i = 0; i < trails.length; i++) {
    const t = trails[i] as Trail;
    const owner = w.hero(t.owner);
    if (!owner) continue;
    if (!t.open) t.time -= dt;
    t.timer -= dt;
    if (t.timer <= SIM.EPS) {
      t.timer += KP.wake.tick;
      as(w, 'ember_wake', () => {
        for (const e of w.enemies) {
          if (!isTargetable(e) || segDist(t.ax, t.az, t.bx, t.bz, e.x, e.z) > t.r + e.radius) continue;
          strikeEnemy(w, owner, e, KP.wake.damage, 'dash', { fromX: e.x, fromZ: e.z, stun: 0, knockback: 0, fallback: 'ember' });
        }
      });
    }
    if (t.time > SIM.EPS) trails[keep++] = t;
  }
  trails.length = keep;

  const blooms = w.blooms;
  if (blooms.length === 0) return;
  let done = 0;
  keep = 0;
  const n = blooms.length;
  for (let i = 0; i < n; i++) {
    const b = blooms[i] as (typeof blooms)[number];
    b.t -= dt;
    const owner = w.hero(b.owner);
    if (!owner) continue;
    if (b.t > SIM.EPS || done >= KEYSTONE_CAPS.BLOOMS_PER_TICK) { blooms[keep++] = b; continue; }
    done++;
    const r = KP.bloom.radius * owner.ks.area;
    w.emit({ e: 'aoe', x: b.x, z: b.z, r, el: b.el, hostile: false });
    proc(w, owner, 'corpse_bloom', b.x, b.z, { r, n: b.depth }, true);
    const amount = KP.bloom.damage * allDamage(owner);
    const depth = w.bloomDepth;
    w.bloomDepth = b.depth;
    as(w, 'corpse_bloom', () => {
      const count = w.enemies.length;
      for (let j = 0; j < count; j++) {
        const o = w.enemies[j] as Enemy;
        if (!isTargetable(o)) continue;
        const reach = r + o.radius;
        const dx = o.x - b.x;
        const dz = o.z - b.z;
        if (dx * dx + dz * dz > reach * reach) continue;
        // The status passes on first (it may set off a Resonance), then the burst hurts.
        applyElement(w, o, b.el, owner, b.potency);
        if (isTargetable(o)) rawDamageEnemy(w, o, amount, owner.slot, b.el);
      }
    });
    w.bloomDepth = depth;
  }
  // Blooms queued while resolving sit behind index n.
  for (let i = n; i < blooms.length; i++) blooms[keep++] = blooms[i] as (typeof blooms)[number];
  blooms.length = keep;
}

// ---------------------------------------------------------------------------------------------- kills

/**
 * An enemy died (not quietly). Corpse Bloom: if it carried a status and the hero who applied it (else the killer)
 * holds the keystone, a burst is queued. Bloodrush: the killer gains a stack.
 */
export function onKeystoneKill(w: World, e: Enemy, killer: Hero | undefined, status: ElementId | null, applier: Hero | undefined, potency: number): void {
  if (status !== null) {
    const owner = applier && applier.ks.corpseBloom ? applier : killer && killer.ks.corpseBloom ? killer : null;
    if (owner && w.blooms.length < KEYSTONE_CAPS.BLOOM_QUEUE) {
      w.blooms.push({ x: e.x, z: e.z, el: status, potency, owner: owner.slot, t: KEYSTONE_CAPS.BLOOM_DELAY, depth: w.bloomDepth + 1 });
    }
  }
  if (killer && killer.ks.momentumEngine) {
    const ks = killer.ks;
    const before = ks.stacks;
    ks.stacks = Math.min(KP.rush.max, ks.stacks + 1);
    ks.stackTime = KP.rush.seconds;
    proc(w, killer, 'momentum_engine', killer.body.x, killer.body.z, { n: ks.stacks }, ks.stacks !== before);
  }
}

/** Veil of Knives: a backstab killed `e`. */
export function onBackstabKill(w: World, h: Hero, e: Enemy): void {
  const ks = h.ks;
  const max = maxDashCharges(h);
  if (h.dashCharges < max) h.dashCharges++;
  if (h.dashCharges >= max) h.dashRecharge = 0;
  ks.veilTime = KP.shade.stealth;
  ks.veilHit = true;
  ks.veilX = h.body.x;
  ks.veilZ = h.body.z;
  w.emit({ e: 'buff', slot: h.slot, id: 'ks_shade', dur: KP.shade.stealth });
  proc(w, h, 'ks_shade', e.x, e.z);
  // Whoever was after the shade loses track of it.
  for (const o of w.enemies) if (o.target === h.slot) { o.target = -1; o.retarget = 0; }
}

/** Resonance Engine: a Resonance of this hero charges the ultimate. */
export function onResonance(w: World, h: Hero, x: number, z: number): void {
  addCharge(w, h, (ULTIMATE.MAX * KP.engine.perResonance) / 100);
  proc(w, h, 'resonance_engine', x, z, { n: KP.engine.perResonance });
}

// ---------------------------------------------------------------------------------------------- primary keystones

const chainHit: Enemy[] = [];

/** Chain Lightning: `e` was struck for `amount` (before its own vulnerabilities) by a direct primary hit. */
export function chainLightning(w: World, h: Hero, e: Enemy, amount: number): void {
  h.ks.chainCd = KEYSTONE_CAPS.CHAIN_SECONDS;
  const inf = h.stats.infusion.primary;
  const r2 = KP.chain.range * KP.chain.range;
  chainHit.length = 0;
  for (let i = 0; i < KP.chain.targets; i++) {
    let best: Enemy | null = null;
    let bestD = r2;
    for (const o of w.enemies) {
      if (o === e || !isTargetable(o) || o.hp <= 0 || chainHit.includes(o)) continue;
      const dx = o.x - e.x;
      const dz = o.z - e.z;
      const d = dx * dx + dz * dz;
      if (d <= bestD) { bestD = d; best = o; }
    }
    if (!best) break;
    chainHit.push(best);
  }
  if (chainHit.length === 0) return;
  const targets = chainHit.slice();
  const sx = e.x;
  const sz = e.z;
  as(w, 'chain_lightning', () => {
    for (const o of targets) {
      if (!isTargetable(o)) continue;
      proc(w, h, 'chain_lightning', sx, sz, { tx: o.x, tz: o.z });
      rawDamageEnemy(w, o, amount * KP.chain.fraction, h.slot, inf ? inf.element : null);
      if (inf && isTargetable(o) && o.hp > 0) applyElement(w, o, inf.element, h, inf.potency);
    }
  });
}

/** Next enemy a ricochet can reach from (x, z): the nearest within range that this shot has not hit yet. */
function bounceTarget(w: World, x: number, z: number, hit: readonly number[], skip: Enemy | null): Enemy | null {
  let best: Enemy | null = null;
  let bestD = KP.ricochet.range * KP.ricochet.range;
  for (const o of w.enemies) {
    if (o === skip || !isTargetable(o) || o.hp <= 0 || hit.includes(o.id)) continue;
    const dx = o.x - x;
    const dz = o.z - z;
    const d = dx * dx + dz * dz;
    if (d <= bestD) { bestD = d; best = o; }
  }
  return best;
}

/**
 * Ricochet: projectile `p` has just hit `e` and is spent. If it has a bounce left and another enemy is in range it
 * turns towards it (weaker by `falloff`) and lives on. Returns true when it bounced.
 */
export function bounce(w: World, owner: Hero, p: Projectile, e: Enemy): boolean {
  if (p.bounces <= 0) return false;
  const next = bounceTarget(w, e.x, e.z, p.hit, e);
  if (!next) return false;
  p.bounces--;
  p.damage *= KP.ricochet.falloff;
  p.x = e.x;
  p.z = e.z;
  const dx = next.x - p.x;
  const dz = next.z - p.z;
  const d = Math.hypot(dx, dz);
  p.rot = Math.atan2(dx, dz);
  p.dirX = d > SIM.EPS ? dx / d : 0;
  p.dirZ = d > SIM.EPS ? dz / d : 1;
  p.range = d + KS.BOUNCE_PAD;
  p.only = next.id;
  p.ks = 'ricochet';
  proc(w, owner, 'ricochet', e.x, e.z, { tx: next.x, tz: next.z, n: p.bounces });
  return true;
}

/** Ricochet for melee: every `every`-th swing throws a blade (a `shadowDagger`) that bounces. */
export function onMeleeSwing(w: World, h: Hero, def: AbilityDef, aim: number): void {
  const ks = h.ks;
  if (ks.ricochet && ++ks.swings >= KP.ricochet.every) {
    ks.swings = 0;
    const blade = spawnProjectile(w, {
      kind: 'shadowDagger', x: h.body.x, z: h.body.z, rot: aim, speed: KS.BLADE_SPEED, radius: KS.BLADE_RADIUS, range: KS.BLADE_RANGE,
      damage: def.damage * KS.BLADE_DAMAGE, hostile: false, owner: h.slot, slot: 'primary', pierce: 0, element: elementCode(h, 'primary'),
      stun: 0, knockback: 0, bounces: KP.ricochet.bounces, ks: 'ricochet',
    });
    if (blade) proc(w, h, 'ricochet', h.body.x, h.body.z, { n: KP.ricochet.bounces });
  }
  // Blade Tempest: every cut also sends a wave.
  if (ks.spellblade) tempest(w, h, aim, 1);
}

/** Blade Tempest: `count` extra waves at `fraction` strength (one straight ahead; two to the sides of a finisher). */
export function tempest(w: World, h: Hero, aim: number, count: number): void {
  const wave = h.abil.primary.find((a) => a.shape === 'projectile' && a.projectile !== null);
  if (!wave || !wave.projectile) return;
  for (let i = 0; i < count; i++) {
    const rot = count === 1 ? aim : aim + (i === 0 ? -1 : 1) * KS.TEMPEST_SPREAD_DEG * DEG;
    spawnProjectile(w, {
      kind: wave.projectile, x: h.body.x, z: h.body.z, rot, speed: wave.speed, radius: wave.radius, range: wave.range,
      damage: wave.damage * KP.spellblade.fraction, hostile: false, owner: h.slot, slot: 'primary', pierce: wave.pierce,
      element: elementCode(h, 'primary'), stun: wave.stun, knockback: wave.knockback,
      bounces: h.ks.ricochet ? KP.ricochet.bounces : 0, ks: 'ks_spellblade',
    });
  }
  proc(w, h, 'ks_spellblade', h.body.x, h.body.z, { n: count });
}

/** Fan the Hammer: counts a bolt; every `every`-th also throws the rogue's full knife fan (as a secondary). */
export function onBolt(w: World, h: Hero, aim: number): void {
  const ks = h.ks;
  const fan = ks.fanDef;
  if (!ks.rogue || !fan || !fan.projectile || ++ks.bolts < KP.rogue.every) return;
  ks.bolts = 0;
  const spread = fan.arc * DEG;
  for (let i = 0; i < fan.count; i++) {
    const rot = fan.count > 1 ? aim + (i / (fan.count - 1) - 0.5) * spread : aim;
    spawnProjectile(w, {
      kind: fan.projectile, x: h.body.x, z: h.body.z, rot, speed: fan.speed, radius: fan.radius, range: fan.range, damage: fan.damage,
      hostile: false, owner: h.slot, slot: 'secondary', pierce: fan.pierce, element: elementCode(h, 'secondary'), stun: fan.stun,
      knockback: fan.knockback, ks: 'ks_rogue',
    });
  }
  proc(w, h, 'ks_rogue', h.body.x, h.body.z, { n: fan.count });
}

const streamHit: number[] = [];

/** One beam of the Arc Stream along `rot`; returns the enemy struck farthest away (for Ricochet), if any. */
function streamBeam(w: World, h: Hero, def: AbilityDef, rot: number): void {
  const x = h.body.x;
  const z = h.body.z;
  const len = rayLength(w, x, z, rot, def.range, true);
  const bx = x + Math.sin(rot) * len;
  const bz = z + Math.cos(rot) * len;
  let far: Enemy | null = null;
  let farD = -1;
  streamHit.length = 0;
  const count = w.enemies.length;
  for (let i = 0; i < count; i++) {
    const e = w.enemies[i] as Enemy;
    if (!isTargetable(e) || segDist(x, z, bx, bz, e.x, e.z) > def.radius + e.radius) continue;
    const d = (e.x - x) * (e.x - x) + (e.z - z) * (e.z - z);
    if (!strikeEnemy(w, h, e, def.damage, 'primary', { fromX: x, fromZ: z, stun: def.stun, knockback: def.knockback })) continue;
    streamHit.push(e.id);
    if (d > farD) { farD = d; far = e; }
  }
  if (w.fragileCount > 0) popFragileSegment(w, h.slot, x, z, bx, bz, def.radius);
  // Ricochet: the stream forks on from the last enemy it reaches.
  if (!h.ks.ricochet || !far) return;
  let from: Enemy = far;
  let damage = def.damage;
  const hit = streamHit.slice();
  for (let b = KP.ricochet.bounces; b > 0; b--) {
    const next = bounceTarget(w, from.x, from.z, hit, from);
    if (!next) break;
    damage *= KP.ricochet.falloff;
    hit.push(next.id);
    proc(w, h, 'ricochet', from.x, from.z, { tx: next.x, tz: next.z, n: b - 1 });
    const fx = from.x;
    const fz = from.z;
    const amount = damage;
    as(w, 'ricochet', () => { strikeEnemy(w, h, next, amount, 'primary', { fromX: fx, fromZ: fz, stun: 0, knockback: 0 }); });
    from = next;
  }
}

/**
 * Arc Stream: one pulse while the mage holds the primary button. `speed` is the hero's attack speed. Extra bolts
 * (mage_split) become extra beams; Arcane Echo repeats every ARCANE_ECHO_EVERY-th pulse.
 */
export function streamPulse(w: World, h: Hero, cmd: InputCmd, speed: number): void {
  const def = h.ks.streamDef;
  if (!def) return;
  const ks = h.ks;
  const fresh = ks.channel <= SIM.EPS;
  h.primaryCd = def.cooldown / speed;
  h.pressPrimary = 0;
  ks.channel = h.primaryCd + KS.CHANNEL_GRACE;
  if (fresh) {
    h.anim = def.anim;
    h.animSeq++;
    w.emit({ e: 'cast', who: { t: 'p', id: h.slot }, ability: 'ks_mage', x: h.body.x, z: h.body.z, rot: cmd.aim });
  }
  if (h.animTime < ks.channel) h.animTime = ks.channel;
  let pulses = 1;
  if (h.talent.arcaneEcho && ++h.echoCount >= TALENT.ARCANE_ECHO_EVERY) { h.echoCount = 0; pulses = 2; }
  const spread = (def.count - 1) * SIM.SPLIT_SPREAD_DEG * DEG;
  for (let n = 0; n < pulses; n++) {
    for (let i = 0; i < def.count; i++) streamBeam(w, h, def, def.count > 1 ? cmd.aim + (i / (def.count - 1) - 0.5) * spread : cmd.aim);
  }
}

// ---------------------------------------------------------------------------------------------- per hero, per tick

/** Maelstrom: drags every enemy within reach of (x, z) towards it by `pull` metres per second of `seconds`. */
export function maelstromPull(w: World, x: number, z: number, radius: number, seconds: number): void {
  const reach = radius * KS.PULL_REACH;
  const step = KP.barbarian.pull * seconds;
  for (const e of w.enemies) {
    if (!isTargetable(e) || isBoss(e)) continue;
    const dx = x - e.x;
    const dz = z - e.z;
    const d = Math.hypot(dx, dz);
    if (d > reach + e.radius || d <= KS.PULL_MIN) continue;
    const move = Math.min(step, d - KS.PULL_MIN);
    e.kbX += (dx / d) * move;
    e.kbZ += (dz / d) * move;
  }
}

/** One pulse of a spin (whirlwind, rune ward) around the hero; shared by the ability and its twin. */
export function spinPulse(w: World, h: Hero, spin: SpinState): void {
  const def = spin.def;
  if (def.special === 'maelstrom') maelstromPull(w, h.body.x, h.body.z, def.radius, def.tick);
  for (const e of w.enemies) {
    if (!isTargetable(e)) continue;
    const reach = def.radius + e.radius;
    const dx = e.x - h.body.x;
    const dz = e.z - h.body.z;
    if (dx * dx + dz * dz > reach * reach) continue;
    strikeEnemy(w, h, e, def.damage, spin.slot, { fromX: h.body.x, fromZ: h.body.z, stun: def.stun, knockback: def.knockback, special: def.special });
  }
  popFragileCircle(w, h.slot, h.body.x, h.body.z, def.radius);
}

function shieldburst(w: World, h: Hero, held: number): void {
  if (w.run.phase !== 'combat' || held <= 0) return;
  const x = h.body.x;
  const z = h.body.z;
  const r = KP.knight.radius * h.ks.area;
  const damage = held * KP.knight.fraction;
  w.emit({ e: 'aoe', x, z, r, el: elementOf(h, 'secondary'), hostile: false });
  proc(w, h, 'ks_knight', x, z, { r, n: Math.round(damage) }, true);
  as(w, 'ks_knight', () => {
    for (const e of w.enemies) {
      if (!isTargetable(e)) continue;
      const reach = r + e.radius;
      const dx = e.x - x;
      const dz = e.z - z;
      if (dx * dx + dz * dz > reach * reach) continue;
      strikeEnemy(w, h, e, damage, 'secondary', { fromX: x, fromZ: z, stun: 0, knockback: 0 });
    }
  });
}

/** Timers and the always-on keystones of one hero; once per tick at the end of the hero's step. */
export function stepKeystones(w: World, h: Hero, dt: number): void {
  const ks = h.ks;
  if (h.keystones.length === 0) return;
  if (ks.chainCd > 0) ks.chainCd -= dt;
  if (ks.channel > 0) ks.channel = Math.max(0, ks.channel - dt);
  if (ks.priceWait > 0) ks.priceWait -= dt;
  if (ks.phaseTime > 0) {
    ks.phaseTime -= dt;
    if (ks.phaseTime <= SIM.EPS) { ks.phaseTime = 0; ks.phaseCrit = false; }
  }
  if (ks.veilTime > 0) {
    ks.veilTime -= dt;
    if (ks.veilTime <= SIM.EPS) { ks.veilTime = 0; ks.veilHit = false; }
  }
  if (ks.stackTime > 0) {
    ks.stackTime -= dt;
    if (ks.stackTime <= SIM.EPS) {
      ks.stackTime = 0;
      ks.stacks = 0;
      proc(w, h, 'momentum_engine', h.body.x, h.body.z, { n: 0 }, true);
    }
  }
  const alive = h.state === 'alive';
  const combat = w.run.phase === 'combat';
  if (ks.sanguine) {
    ks.leechTimer -= dt;
    if (ks.leechTimer <= SIM.EPS) {
      ks.leechTimer = KEYSTONE_CAPS.LEECH_SECONDS;
      const amount = ks.leech;
      ks.leech = 0;
      if (amount > 0 && alive) {
        const shield = ks.overheal;
        const gained = healHero(w, h, amount) + (ks.overheal - shield);
        if (gained >= 1) proc(w, h, 'sanguine', h.body.x, h.body.z, { n: Math.round(gained) }, true);
      }
    }
  }
  if (ks.knight && alive) {
    if (h.tempShield > ks.shieldPeak) ks.shieldPeak = h.tempShield;
    else if (h.tempShield <= 0 && ks.shieldPeak > 0) {
      const held = ks.shieldPeak;
      ks.shieldPeak = 0;
      shieldburst(w, h, held);
    }
    if (h.barrier > ks.barrierPeak) ks.barrierPeak = h.barrier;
    else if (h.barrier <= 0 && ks.barrierPeak > 0) {
      const held = ks.barrierPeak;
      ks.barrierPeak = 0;
      shieldburst(w, h, held);
    }
  }
  if (!alive || !combat) return;
  const twin = ks.spinTwin;
  if (twin) {
    twin.timer -= dt;
    if (twin.timer <= SIM.EPS) {
      twin.timer += twin.def.tick;
      twin.pulsesLeft--;
      const dealt = h.run.damage;
      spinPulse(w, h, twin);
      ks.dealt.twin_cast = (ks.dealt.twin_cast ?? 0) + h.run.damage - dealt;
      if (twin.pulsesLeft <= 0) ks.spinTwin = null;
    }
  }
  if (ks.orbitBlades) {
    const ring = KP.blades.radius * ks.area;
    const base = TAU * (KP.blades.rpm / 60) * w.tick * TICK_DT;
    const damage = ks.primaryBase * KP.blades.damageFraction;
    as(w, 'orbit_blades', () => {
      const count = w.enemies.length;
      for (let b = 0; b < KP.blades.blades; b++) {
        const a = base + (b * TAU) / KP.blades.blades;
        const bx = h.body.x + Math.sin(a) * ring;
        const bz = h.body.z + Math.cos(a) * ring;
        for (let i = 0; i < count; i++) {
          const e = w.enemies[i] as Enemy;
          if (!isTargetable(e)) continue;
          const reach = KEYSTONE_CAPS.BLADE_HIT_RADIUS + e.radius;
          const dx = e.x - bx;
          const dz = e.z - bz;
          if (dx * dx + dz * dz > reach * reach) continue;
          const at = ks.bladeAt.get(e.id);
          if (at !== undefined && w.tick < at) continue;
          ks.bladeAt.set(e.id, w.tick + BLADE_TICKS);
          strikeEnemy(w, h, e, damage, 'primary', { fromX: h.body.x, fromZ: h.body.z, stun: 0, knockback: 0 });
        }
        if (w.fragileCount > 0) popFragileCircle(w, h.slot, bx, bz, KEYSTONE_CAPS.BLADE_HIT_RADIUS);
      }
    });
  }
  if (ks.familiar) {
    ks.familiarCd -= dt;
    if (ks.familiarCd <= SIM.EPS) {
      let best: Enemy | null = null;
      let bestD = KP.familiar.range * KP.familiar.range;
      for (const e of w.enemies) {
        if (!isTargetable(e) || e.hp <= 0) continue;
        const dx = e.x - h.body.x;
        const dz = e.z - h.body.z;
        const d = dx * dx + dz * dz;
        if (d < bestD) { bestD = d; best = e; }
      }
      if (best) {
        ks.familiarCd = KP.familiar.interval;
        const dist = Math.sqrt(bestD);
        spawnProjectile(w, {
          kind: 'arcBolt', x: h.body.x, z: h.body.z, rot: Math.atan2(best.x - h.body.x, best.z - h.body.z), speed: KS.FAMILIAR_SPEED,
          radius: KS.FAMILIAR_RADIUS, range: dist + KS.FAMILIAR_RANGE_PAD, damage: ks.primaryBase * KP.familiar.damageFraction, hostile: false,
          owner: h.slot, slot: 'primary', pierce: 0, element: elementCode(h, 'primary'), stun: 0, knockback: 0, ks: 'familiar', aux: true,
        });
        proc(w, h, 'familiar', h.body.x, h.body.z, { tx: best.x, tz: best.z }, true);
      } else {
        ks.familiarCd = 0;
      }
    }
  }
}

/** Dash recharge runs this much faster right now (Phase Walker's window). */
export const dashHaste = (h: Hero): number => (h.ks.phaseTime > 0 ? 1 + KP.phase.haste : 1);
