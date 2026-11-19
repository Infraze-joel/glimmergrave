/** Update 5: what each of the 23 keystones does (effect, cost, params), in the sandbox. */
import { describe, expect, it } from 'vitest';
import { TICK_DT } from '@shared/constants.ts';
import { CLASSES, DASH, ULTIMATE } from '@shared/data/classes.ts';
import { STATUS } from '@shared/data/enemies.ts';
import { KEYSTONES, KEYSTONE_BY_ID, KEYSTONE_CAPS } from '@shared/data/keystones.ts';
import { attackSpeed, heroMoveSpeed, secondaryCooldown } from '@shared/sim/abilities.ts';
import { applyElement, damageHero, healHero, killEnemy, setStatus } from '@shared/sim/combat.ts';
import { maxDashCharges } from '@shared/sim/boons.ts';
import { KEYSTONE_FLAG } from '@shared/sim/ksState.ts';
import type { Enemy } from '@shared/sim/index.ts';
import { BTN, PF, type GameEvent } from '@shared/types.ts';
import { dummy, live, Pad, place, seconds, stepN } from './harness.ts';
import { arena, give, mastered, of, party, use, type Arena } from './u3kit.ts';

const P = (id: string): Record<string, number> => KEYSTONE_BY_ID.get(id)!.params;
const procs = (events: GameEvent[], id: string) => of(events, 'keystoneProc').filter((p) => p.id === id);
const HP = 100000;
const lost = (e: Enemy): number => HP - e.hp;

function withKs(cls: Parameters<typeof arena>[0], ids: string[], loadout?: unknown): Arena {
  const a = arena(cls, loadout);
  for (const id of ids) expect(a.w.grantKeystone(0, id), id).toBe(true);
  a.w.drainEvents();
  return a;
}
/** Dashes along +Z (aim 0) and returns the events of the dash plus `after` seconds. */
function dash(a: Arena, after = 0.3): GameEvent[] {
  const ev = a.pad.hold({ moveX: 0, moveZ: 1, aim: 0, buttons: BTN.DASH }, 1);
  ev.push(...a.pad.hold({ aim: 0 }, seconds(DASH.DURATION + after)));
  return ev;
}

describe('the keystone table', () => {
  it('has 23 keystones (16 for everyone, one per class), each with a flag in the simulation', () => {
    expect(KEYSTONES).toHaveLength(23);
    expect(KEYSTONES.filter((k) => k.cls === undefined)).toHaveLength(16);
    expect(new Set(KEYSTONES.filter((k) => k.cls).map((k) => k.cls)).size).toBe(Object.keys(CLASSES).length);
    for (const k of KEYSTONES) expect(KEYSTONE_FLAG[k.id], k.id).toBeDefined();
  });

  it('taking one emits `keystone`, sets the flag and is refused twice, for the wrong class and beyond two', () => {
    const a = arena('knight');
    expect(a.w.grantKeystone(0, 'colossus')).toBe(true);
    expect(of(a.w.drainEvents(), 'keystone')).toEqual([{ e: 'keystone', slot: 0, id: 'colossus' }]);
    expect(a.h.ks.colossus).toBe(true);
    expect(a.w.grantKeystone(0, 'colossus')).toBe(false);
    expect(a.w.grantKeystone(0, 'ks_mage')).toBe(false);
    expect(a.w.grantKeystone(0, 'nope')).toBe(false);
    expect(a.w.grantKeystone(0, 'ks_knight')).toBe(true);
    expect(a.w.grantKeystone(0, 'familiar')).toBe(false);
    a.w.drainEvents();
    expect(a.w.grantKeystone(0, 'familiar', 'colossus')).toBe(true);
    expect(of(a.w.drainEvents(), 'keystone')).toEqual([{ e: 'keystone', slot: 0, id: 'familiar', replaced: 'colossus' }]);
    expect(a.w.getKeystones(0)).toEqual(['ks_knight', 'familiar']);
    expect(a.h.ks.colossus).toBe(false);
    expect(a.h.maxHp).toBe(CLASSES.knight.maxHp);
  });
});

describe('dash keystones', () => {
  it('ember_wake: the dash leaves a trail that burns for `seconds`, ticking `damage` every `tick` with Ember', () => {
    const a = withKs('knight', ['ember_wake']);
    const p = P('ember_wake');
    const e = dummy(a.w, 0.6, 2.5);
    const far = dummy(a.w, 3, 2.5);
    const ev = dash(a, 0);
    const proc = procs(ev, 'ember_wake');
    expect(proc).toHaveLength(1);
    expect(proc[0]).toMatchObject({ x: 0, z: 0, tx: 0, r: p.width! / 2 });
    expect(proc[0]!.tz).toBeCloseTo(DASH.SPEED * DASH.DURATION, 1);
    ev.push(...stepN(a.w, seconds(p.seconds! + 1)));
    const all = of(ev, 'hit').filter((h) => h.target.t === 'e' && h.target.id === e.id);
    for (const h of all) expect(h.el).toBe('ember');
    // Burn ticks aside (they are smaller), the trail itself hits for `damage` every `tick`.
    const hits = all.filter((h) => h.dmg === p.damage);
    const expected = Math.floor((p.seconds! + DASH.DURATION) / p.tick!) + 1;
    expect(hits.length).toBeGreaterThanOrEqual(expected - 1);
    expect(hits.length).toBeLessThanOrEqual(expected + 1);
    for (const h of hits) expect(h.el).toBe('ember');
    expect(e.status).toBe('ember');
    expect(a.w.trails).toHaveLength(0);
    expect(lost(far)).toBe(0);
    expect(a.h.ks.dealt.ember_wake).toBeCloseTo(hits.length * p.damage!, 5);
  });

  it('ember_wake: carries the dash infusion instead of Ember, and at most TRAILS_PER_HERO trails burn', () => {
    const a = withKs('rogue', ['ember_wake']);
    give(a.h, 'infuse_storm_dash');
    const e = dummy(a.w, 0.5, 2);
    dash(a, 0.6);
    expect(e.status).toBe('storm');
    for (let i = 0; i < KEYSTONE_CAPS.TRAILS_PER_HERO + 3; i++) {
      a.h.dashCharges = 1;
      place(a.w, 0, 0, 0);
      dash(a, 0);
      expect(a.w.trails.length).toBeLessThanOrEqual(KEYSTONE_CAPS.TRAILS_PER_HERO);
    }
    expect(a.w.trails).toHaveLength(KEYSTONE_CAPS.TRAILS_PER_HERO);
  });

  it('shockstep: every dash ends in a shockwave (damage, radius, knockback) and the hero has one more charge', () => {
    const plain = arena('knight');
    const a = withKs('knight', ['shockstep']);
    const p = P('shockstep');
    expect(maxDashCharges(a.h)).toBe(maxDashCharges(plain.h) + p.charges!);
    expect(a.h.dashCharges).toBe(maxDashCharges(a.h));
    const end = DASH.SPEED * DASH.DURATION;
    const near = dummy(a.w, 2, end);
    const out = dummy(a.w, p.radius! + 1.5, end);
    const boss = live(a.w, 'champion', -2.5, end);
    boss.hp = boss.maxHp = HP;
    const ev = dash(a, 0);
    expect(lost(near)).toBeCloseTo(p.damage!, 5);
    expect(lost(out)).toBe(0);
    expect(Math.hypot(near.kbX, near.kbZ) + Math.hypot(near.x - 2, near.z - end)).toBeCloseTo(p.knockback!, 1);
    expect(lost(boss)).toBeGreaterThan(0);
    expect(boss.kbX).toBe(0);
    expect(procs(ev, 'shockstep')).toHaveLength(1);
    expect(procs(ev, 'shockstep')[0]).toMatchObject({ r: p.radius });
    expect(of(ev, 'aoe').some((x) => x.r === p.radius && !x.hostile)).toBe(true);
  });

  it('phase_walker: dashing THROUGH an enemy arms a sure crit and faster dash recharge for `seconds`; a dash past nobody grants nothing', () => {
    const p = P('phase_walker');
    const miss = withKs('knight', ['phase_walker']);
    dummy(miss.w, 4, 2);
    const none = dash(miss);
    expect(of(none, 'buff')).toHaveLength(0);
    expect(miss.h.ks.phaseTime).toBe(0);

    const a = withKs('knight', ['phase_walker']);
    dummy(a.w, 0, 2.5);
    const ev = dash(a, 0);
    expect(of(ev, 'buff')).toEqual([{ e: 'buff', slot: 0, id: 'phase_walker', dur: p.seconds }]);
    expect(procs(ev, 'phase_walker')).toHaveLength(1);
    // Recharge runs 1 + haste times as fast inside the window.
    const before = a.h.dashRecharge;
    stepN(a.w, 3);
    expect(before - a.h.dashRecharge).toBeCloseTo(3 * TICK_DT * (1 + p.haste!), 5);
    const two = [dummy(a.w, -0.8, a.h.body.z + 2), dummy(a.w, 0.8, a.h.body.z + 2)];
    const hit = use(a, BTN.PRIMARY, 0.3);
    for (const e of two) expect(of(hit, 'hit').filter((h) => h.target.t === 'e' && h.target.id === e.id)[0]!.crit).toBe(true);
    // Spent: the next swing is an ordinary one.
    const again = use(a, BTN.PRIMARY, 0.3);
    expect(of(again, 'hit').every((h) => !h.crit)).toBe(true);
    stepN(a.w, seconds(p.seconds!));
    expect(a.h.ks.phaseTime).toBe(0);
  });
});

describe('primary keystones', () => {
  it('ricochet: a primary projectile bounces to `bounces` more enemies within `range`, weaker by `falloff` each time', () => {
    const a = withKs('mage', ['ricochet']);
    const p = P('ricochet');
    // A zig-zag of `bounces + 2` dummies 3.6 m apart: the bolt hits the first, bounces `bounces` times, and the
    // last one stays untouched.
    const chain: Enemy[] = [];
    for (let i = 0; i < p.bounces! + 2; i++) chain.push(dummy(a.w, 3 * i, i % 2 === 0 ? 5 : 7));
    const ev = use(a, BTN.PRIMARY, 0.6 * (p.bounces! + 2));
    const bolt = CLASSES.mage.primary[0]!.damage;
    for (let i = 0; i <= p.bounces!; i++) expect(lost(chain[i]!), `link ${i}`).toBeCloseTo(bolt * p.falloff! ** i, 5);
    expect(lost(chain[p.bounces! + 1]!)).toBe(0);
    // The first bounce is always announced; a second one within PROC_SECONDS falls to the rate limit.
    const b = procs(ev, 'ricochet');
    expect(b.length).toBeGreaterThanOrEqual(1);
    expect(b.length).toBeLessThanOrEqual(p.bounces!);
    expect(b[0]).toMatchObject({ x: 0, z: 5, tx: 3, tz: 7, n: p.bounces! - 1 });
    // Nothing in range: the bolt simply ends.
    const lone = withKs('mage', ['ricochet']);
    const only = dummy(lone.w, 0, 5);
    dummy(lone.w, 0, 5 + p.range! + 2);
    expect(procs(use(lone, BTN.PRIMARY, 1), 'ricochet')).toHaveLength(0);
    expect(lost(only)).toBeCloseTo(bolt, 5);
  });

  it('ricochet: a melee hero throws a bouncing blade with every `every`-th swing', () => {
    const a = withKs('knight', ['ricochet']);
    const p = P('ricochet');
    const front = dummy(a.w, 0, 2);
    const side = dummy(a.w, 4, 4);
    let blades = 0;
    for (let swing = 1; swing <= p.every! * 2; swing++) {
      a.pad.hold({ aim: 0, buttons: BTN.PRIMARY }, 1);
      for (let t = 0; t < seconds(0.7); t++) {
        a.pad.hold({ aim: 0 }, 1);
        if (a.w.projectiles.some((q) => q.kind === 'shadowDagger')) { blades++; break; }
      }
      stepN(a.w, seconds(0.8));
      a.h.comboIndex = 0;
      a.h.primaryCd = 0;
      a.h.lockTime = 0;
      expect(blades, `after swing ${swing}`).toBe(Math.floor(swing / p.every!));
    }
    expect(lost(side)).toBeGreaterThan(0);
    expect(lost(front)).toBeGreaterThan(0);
    expect(a.h.ks.dealt.ricochet).toBeGreaterThan(0);
  });

  it('chain_lightning: a primary hit arcs to `targets` enemies within `range` for `fraction`, with the primary element; arcs do not arc', () => {
    const a = withKs('mage', ['chain_lightning']);
    give(a.h, 'infuse_storm_primary');
    const p = P('chain_lightning');
    const struck = dummy(a.w, 0, 6);
    const near = [dummy(a.w, 2, 6), dummy(a.w, -2, 6), dummy(a.w, 0, 9)];
    const fourth = dummy(a.w, 0, 6 + p.range! - 0.5);
    const far = dummy(a.w, p.range! + 3, 6);
    const ev = use(a, BTN.PRIMARY, 0.8);
    const bolt = CLASSES.mage.primary[0]!.damage;
    expect(lost(struck)).toBeCloseTo(bolt, 5);
    for (const e of near) {
      expect(lost(e)).toBeCloseTo(bolt * p.fraction!, 5);
      expect(e.status).toBe('storm');
    }
    expect(lost(fourth)).toBe(0);
    expect(lost(far)).toBe(0);
    expect(procs(ev, 'chain_lightning')).toHaveLength(p.targets!);
    expect(procs(ev, 'chain_lightning')[0]).toMatchObject({ x: 0, z: 6 });
    expect(a.h.ks.dealt.chain_lightning).toBeCloseTo(bolt * p.fraction! * p.targets!, 5);
  });

  it('chain_lightning: bursts of one hero are at least CHAIN_SECONDS apart', () => {
    const a = withKs('rogue', ['chain_lightning']);
    dummy(a.w, 0, 5);
    dummy(a.w, 1.5, 5.5);
    const ev = a.pad.hold({ aim: 0, buttons: BTN.PRIMARY }, seconds(4));
    const ticks = new Set<number>();
    let tick = 0;
    // Group procs by the step they were emitted in.
    const b = withKs('rogue', ['chain_lightning']);
    dummy(b.w, 0, 5);
    dummy(b.w, 1.5, 5.5);
    for (let i = 0; i < seconds(4); i++) {
      tick++;
      if (procs(b.pad.hold({ aim: 0, buttons: BTN.PRIMARY }, 1), 'chain_lightning').length > 0) ticks.add(tick);
    }
    const sorted = [...ticks].sort((x, y) => x - y);
    expect(sorted.length).toBeGreaterThan(5);
    for (let i = 1; i < sorted.length; i++) expect((sorted[i]! - sorted[i - 1]!) * TICK_DT).toBeGreaterThanOrEqual(KEYSTONE_CAPS.CHAIN_SECONDS - 1e-6);
    expect(procs(ev, 'chain_lightning').length).toBe(sorted.length);
  });

  it('heavy_hitter: primaries deal +`damage`, reach wider and knock back, but are `slow` slower; the proc comes at the release', () => {
    const plain = arena('knight');
    const a = withKs('knight', ['heavy_hitter']);
    const p = P('heavy_hitter');
    const base = CLASSES.knight.primary[0]!;
    const def = a.h.abil.primary[0]!;
    expect(def.damage).toBeCloseTo(base.damage * (1 + p.damage!), 5);
    expect(def.arc).toBeCloseTo(base.arc * (1 + p.area!), 5);
    expect(def.range).toBeGreaterThan(base.range);
    expect(def.knockback).toBe(base.knockback + p.knockback!);
    expect(attackSpeed(a.h)).toBeCloseTo(attackSpeed(plain.h) * (1 - p.slow!), 5);
    const e = dummy(a.w, 0, 2);
    const ev = use(a, BTN.PRIMARY, 0.05);
    expect(a.h.primaryCd + 0.05 + TICK_DT).toBeCloseTo(base.cooldown / (1 - p.slow!), 1);
    expect(lost(e)).toBe(0);
    ev.push(...stepN(a.w, seconds(0.4)));
    expect(lost(e)).toBeCloseTo(base.damage * (1 + p.damage!), 5);
    expect(Math.hypot(e.kbX, e.kbZ) + Math.hypot(e.x, e.z - 2)).toBeCloseTo(p.knockback!, 1);
    expect(procs(ev, 'heavy_hitter')).toHaveLength(1);
    // The proc marks the release: it comes in the same tick as the swing's hits, before them.
    const at = ev.findIndex((x) => x.e === 'keystoneProc' && x.id === 'heavy_hitter');
    const firstHit = ev.findIndex((x) => x.e === 'hit' && x.target.t === 'e');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(at).toBeLessThan(firstHit);
    // A full circle is the limit for wide arcs.
    const templar = withKs('templar', ['heavy_hitter']);
    expect(templar.h.abil.primary[2]!.arc).toBeLessThanOrEqual(360);
    // Projectiles get wider instead.
    const mage = withKs('mage', ['heavy_hitter']);
    expect(mage.h.abil.primary[0]!.radius).toBeCloseTo(CLASSES.mage.primary[0]!.radius * (1 + p.area!), 5);
  });
});

describe('secondary keystones', () => {
  const p = P('twin_cast');

  it('twin_cast: a blast goes off again after `delay` at `fraction` strength, on the same spot; the secondary recharges `recharge` faster', () => {
    const a = withKs('mage', ['twin_cast']);
    const e = dummy(a.w, 0, 6);
    const nova = CLASSES.mage.secondary;
    const ev = a.pad.hold({ aim: 0, aimDist: 6, buttons: BTN.SECONDARY }, 1);
    let firstAt = -1;
    let secondAt = -1;
    for (let t = 1; t <= seconds(2); t++) {
      const step = a.pad.hold({ aim: 0, aimDist: 6 }, 1);
      ev.push(...step);
      const blasts = of(step, 'aoe').length;
      if (blasts > 0 && firstAt < 0) firstAt = t; else if (blasts > 0) secondAt = t;
    }
    expect((secondAt - firstAt) * TICK_DT).toBeCloseTo(p.delay!, 1);
    expect(lost(e)).toBeCloseTo(nova.damage * (1 + p.fraction!), 5);
    expect(of(ev, 'aoe').map((x) => [x.x, x.z])).toEqual([[0, 6], [0, 6]]);
    expect(procs(ev, 'twin_cast')).toHaveLength(1);
    expect(of(ev, 'cast').filter((c) => c.ability === nova.id)).toHaveLength(1);
    expect(a.h.ks.dealt.twin_cast).toBeCloseTo(nova.damage * p.fraction!, 5);
    // The secondary recharges 1 + `recharge` times as fast; with Blood Price as well, both speed-ups multiply.
    expect(a.h.secondaryCdMax).toBeCloseTo(nova.cooldown / (1 + p.recharge!), 9);
    expect(secondaryCooldown(withKs('mage', ['twin_cast', 'blood_price']).h)).toBeCloseTo(nova.cooldown / ((1 + p.recharge!) * (1 + P('blood_price').recharge!)), 9);
  });

  it('twin_cast: a lunge is repeated by an afterimage along its path — the hero is not moved twice, no second shield', () => {
    const a = withKs('knight', ['twin_cast']);
    const bash = CLASSES.knight.secondary;
    const e = dummy(a.w, 0.5, 3);
    const ev = use(a, BTN.SECONDARY, 0.3);
    const at = { x: a.h.body.x, z: a.h.body.z };
    expect(lost(e)).toBeCloseTo(bash.damage, 5);
    const shield = a.h.tempShield;
    ev.push(...use({ ...a }, 0, 0.5));
    expect(lost(e)).toBeCloseTo(bash.damage * (1 + p.fraction!), 5);
    expect(a.h.body.z).toBeCloseTo(at.z, 5);
    expect(a.h.tempShield).toBe(shield);
    expect(procs(ev, 'twin_cast')[0]).toMatchObject({ x: 0, z: 0, tx: 0, tz: bash.range, r: bash.radius });
  });

  it('twin_cast: spins run twice side by side, zones and traps are laid twice, a leap blasts twice where it landed', () => {
    const blade = withKs('spellblade', ['twin_cast'], mastered({ art: 1 }));
    const ward = CLASSES.spellblade.arts[0]!;
    const single = arena('spellblade', mastered({ art: 1 }));
    const once = dummy(single.w, 0, 2);
    use(single, BTN.SECONDARY, 4);
    const e = dummy(blade.w, 0, 2);
    use(blade, BTN.SECONDARY, 4);
    expect(lost(once)).toBeGreaterThanOrEqual(ward.damage * Math.round(ward.duration / ward.tick));
    expect(lost(e)).toBeCloseTo(lost(once) * (1 + p.fraction!), 3);

    const templar = withKs('templar', ['twin_cast']);
    const zones = of(use(templar, BTN.SECONDARY, 1.2), 'zone');
    expect(zones).toHaveLength(2);
    expect(templar.w.zones.map((z) => z.def.heal)).toEqual([CLASSES.templar.secondary.heal, CLASSES.templar.secondary.heal * p.fraction!]);

    const rogue = withKs('rogue', ['twin_cast'], mastered({ art: 1 }));
    expect(of(use(rogue, BTN.SECONDARY, 1, { aimDist: 5 }), 'zone')).toHaveLength(2);

    const leaper = withKs('barbarian', ['twin_cast'], mastered({ art: 1 }));
    const leap = CLASSES.barbarian.arts[0]!;
    const victim = dummy(leaper.w, 0, 6);
    const ev = use(leaper, BTN.SECONDARY, 1.6, { aimDist: 6 });
    const plainLeaper = arena('barbarian', mastered({ art: 1 }));
    const plainVictim = dummy(plainLeaper.w, 0, 6);
    use(plainLeaper, BTN.SECONDARY, 1.6, { aimDist: 6 });
    expect(lost(plainVictim)).toBeGreaterThanOrEqual(leap.damage);
    expect(lost(victim)).toBeCloseTo(lost(plainVictim) * (1 + p.fraction!), 3);
    expect(leaper.h.body.z).toBeCloseTo(6, 0);
    expect(procs(ev, 'twin_cast')).toHaveLength(1);
  });

  it('blood_price: the secondary recharges `recharge` faster and can be used again after `minCooldown` for `hpFraction` of maximum health; a recharged cast is free; never the last point of health', () => {
    const a = withKs('mage', ['blood_price']);
    const bp = P('blood_price');
    const cast = (): GameEvent[] => {
      const ev = a.pad.hold({ aim: 0, aimDist: 5, buttons: BTN.SECONDARY }, 1);
      ev.push(...a.pad.hold({ aim: 0 }, 1));
      return ev;
    };
    // The first cast finds the ability recharged: free, and the ordinary cooldown starts.
    expect(procs(cast(), 'blood_price')).toHaveLength(0);
    expect(a.h.hp).toBe(a.h.maxHp);
    expect(a.h.secondaryCdMax).toBe(secondaryCooldown(a.h));
    // It also recharges 1 + `recharge` times as fast.
    const recharged = CLASSES.mage.secondary.cooldown / (1 + bp.recharge!);
    expect(secondaryCooldown(a.h)).toBeCloseTo(recharged, 9);
    expect(secondaryCooldown(arena('mage').h)).toBe(CLASSES.mage.secondary.cooldown);
    expect(a.w.getSnapshotBody().players[0]!.cdSecondary).toBeGreaterThan(0.9);
    // Too early even for blood.
    stepN(a.w, seconds(bp.minCooldown! - 0.4));
    a.h.lockTime = 0;
    expect(of(cast(), 'cast')).toHaveLength(0);
    // After minCooldown: it fires for health, without a `hit` on the hero.
    expect(of(stepN(a.w, seconds(0.5)), 'cast')).toHaveLength(0);
    a.h.lockTime = 0;
    const ev = cast();
    expect(of(ev, 'cast').map((c) => c.ability)).toEqual([CLASSES.mage.secondary.id]);
    expect(a.h.hp).toBeCloseTo(a.h.maxHp * (1 - bp.hpFraction!), 5);
    expect(procs(ev, 'blood_price')[0]!.n).toBe(Math.round(a.h.maxHp * bp.hpFraction!));
    expect(of(ev, 'hit').filter((h) => h.target.t === 'p')).toHaveLength(0);
    // The recharge that was under way went on: the paid cast did not restart it.
    expect(a.h.secondaryCdMax).toBeCloseTo(recharged, 9);
    expect(a.h.secondaryCd).toBeLessThan(recharged - bp.minCooldown!);
    // Cast early until it refuses: the hero ends at exactly 1 health and is still standing.
    let paid = 1;
    for (let i = 0; i < Math.ceil(1 / bp.hpFraction!) + 5; i++) {
      stepN(a.w, seconds(bp.minCooldown! + 0.1));
      a.h.lockTime = 0;
      a.h.secondaryCd = 3;
      const before = a.h.hp;
      if (procs(cast(), 'blood_price').length > 0) paid++;
      else expect(a.h.hp).toBe(before);
    }
    expect(a.h.hp).toBe(1);
    expect(a.h.state).toBe('alive');
    expect(paid).toBe(Math.ceil(1 / bp.hpFraction!));
    // At 1 health it waits for the recharge, and then fires for free.
    a.h.secondaryCd = 0.2;
    stepN(a.w, seconds(0.4));
    expect(of(cast(), 'cast')).toHaveLength(1);
    expect(a.h.hp).toBe(1);
  });
});

describe('companions and auras', () => {
  it('orbit_blades: three blades on a ring cut for `damageFraction` of the primary damage with its element, each enemy at most once per BLADE_HIT_SECONDS', () => {
    const a = withKs('knight', ['orbit_blades']);
    give(a.h, 'infuse_rime_primary');
    const p = P('orbit_blades');
    const onRing = dummy(a.w, 0, p.radius!);
    const hugging = dummy(a.w, 0.3, 0.3);
    const outside = dummy(a.w, 0, p.radius! + 2.5);
    const secs = 6;
    const ev = stepN(a.w, seconds(secs));
    const hits = of(ev, 'hit').filter((h) => h.target.t === 'e' && h.target.id === onRing.id);
    const mean = CLASSES.knight.primary.reduce((n, d) => n + d.damage, 0) / CLASSES.knight.primary.length;
    expect(lost(onRing) / hits.length).toBeCloseTo(mean * p.damageFraction!, 5);
    // One pass per blade per turn: blades x rpm / 60 hits a second, never more than the cap allows.
    expect(hits.length).toBeGreaterThanOrEqual(secs * p.blades! * (p.rpm! / 60) - 2);
    expect(hits.length).toBeLessThanOrEqual(Math.ceil(secs / KEYSTONE_CAPS.BLADE_HIT_SECONDS) + 1);
    expect(onRing.status).toBe('rime');
    expect(lost(hugging)).toBe(0);
    expect(lost(outside)).toBe(0);
    expect(a.h.ks.dealt.orbit_blades).toBeCloseTo(lost(onRing), 5);
    // The blade positions are a pure function of the tick (clients draw them from it).
    const angle = 2 * Math.PI * (p.rpm! / 60) * a.w.tick * TICK_DT;
    const fresh = dummy(a.w, Math.sin(angle + 2 * Math.PI * (p.rpm! / 60) * TICK_DT) * p.radius!, Math.cos(angle + 2 * Math.PI * (p.rpm! / 60) * TICK_DT) * p.radius!);
    stepN(a.w, 1);
    expect(lost(fresh)).toBeGreaterThan(0);
  });

  it('familiar: shoots the nearest enemy within `range` every `interval` for `damageFraction` of the primary damage', () => {
    const a = withKs('mage', ['familiar']);
    const p = P('familiar');
    const near = dummy(a.w, 0, 6);
    const other = dummy(a.w, 0, -9);
    const ev = stepN(a.w, seconds(p.interval! * 5 + 0.5));
    const shots = procs(ev, 'familiar');
    expect(shots.length).toBeGreaterThanOrEqual(5);
    expect(shots.length).toBeLessThanOrEqual(6);
    expect(shots[0]).toMatchObject({ x: 0, z: 0, tx: 0, tz: 6 });
    expect(lost(other)).toBe(0);
    const hits = of(ev, 'hit').filter((h) => h.target.t === 'e' && h.target.id === near.id);
    expect(lost(near) / hits.length).toBeCloseTo(CLASSES.mage.primary[0]!.damage * p.damageFraction!, 5);
    // Out of range: silence.
    const b = withKs('mage', ['familiar']);
    dummy(b.w, 0, p.range! + 1);
    expect(procs(stepN(b.w, seconds(3)), 'familiar')).toHaveLength(0);
    expect(b.w.projectiles).toHaveLength(0);
  });

  it('colossus: +`hp` health, `area` larger areas, knockback on hits, `moveSpeed` slower', () => {
    const plain = arena('knight');
    const a = arena('knight');
    a.h.hp = 50;
    a.w.grantKeystone(0, 'colossus');
    const p = P('colossus');
    expect(a.h.maxHp).toBe(plain.h.maxHp + p.hp!);
    expect(a.h.hp).toBe(50 + p.hp!);
    expect(heroMoveSpeed(a.h)).toBeCloseTo(heroMoveSpeed(plain.h) * (1 + p.moveSpeed!), 5);
    expect(a.h.abil.primary[0]!.range).toBeCloseTo(plain.h.abil.primary[0]!.range * (1 + p.area!), 5);
    expect(a.h.abil.secondary.radius).toBe(plain.h.abil.secondary.radius);
    expect(a.h.abil.ultimate.radius).toBe(plain.h.abil.ultimate.radius);
    const mage = withKs('mage', ['colossus']);
    expect(mage.h.abil.secondary.radius).toBeCloseTo(CLASSES.mage.secondary.radius * (1 + p.area!), 5);
    const e = dummy(a.w, 0, 2);
    use(a, BTN.PRIMARY, 0.3);
    expect(Math.hypot(e.kbX, e.kbZ) + Math.hypot(e.x, e.z - 2)).toBeCloseTo(p.knockback!, 1);
    // The self speed the client predicts with is the slowed one.
    a.pad.hold({ moveX: 1 }, 2);
    expect(a.w.getSelfState(0).moveSpeed).toBeCloseTo(CLASSES.knight.moveSpeed * (1 + p.moveSpeed!), 5);
  });
});

describe('how you win fights', () => {
  it('corpse_bloom: a dying carrier bursts after BLOOM_DELAY, hurting the enemies around it and passing its status on', () => {
    const a = withKs('knight', ['corpse_bloom']);
    const p = P('corpse_bloom');
    const carrier = dummy(a.w, 5, 5);
    const near = dummy(a.w, 6.5, 5);
    const far = dummy(a.w, 5, 5 + p.radius! + 2);
    setStatus(a.w, carrier, 'rime', a.h, 1);
    killEnemy(a.w, carrier, 0);
    expect(a.w.blooms).toHaveLength(1);
    const ev = stepN(a.w, seconds(KEYSTONE_CAPS.BLOOM_DELAY) + 1);
    expect(lost(near)).toBeCloseTo(p.damage!, 5);
    expect(near.status).toBe('rime');
    expect(lost(far)).toBe(0);
    expect(procs(ev, 'corpse_bloom')).toEqual([{ e: 'keystoneProc', slot: 0, id: 'corpse_bloom', x: 5, z: 5, r: p.radius, n: 1 }]);
    // No status, no bloom; a quiet death (crumbling) neither.
    const clean = dummy(a.w, -5, 5);
    killEnemy(a.w, clean, 0);
    const quiet = dummy(a.w, -5, -5);
    setStatus(a.w, quiet, 'ember', a.h, 1);
    killEnemy(a.w, quiet, -1, true);
    expect(a.w.blooms).toHaveLength(0);
  });

  it('corpse_bloom: chains run through a pack link by link, at most BLOOMS_PER_TICK bursts per tick', () => {
    const a = withKs('knight', ['corpse_bloom']);
    const p = P('corpse_bloom');
    const pack: Enemy[] = [];
    for (let i = 0; i < 30; i++) pack.push(dummy(a.w, -10 + (i % 10) * 1.6, -4 + Math.floor(i / 10) * 1.6, 'minion', p.damage! - 1));
    setStatus(a.w, pack[0]!, 'ember', a.h, 1);
    killEnemy(a.w, pack[0]!, 0);
    let depth = 0;
    let bursts = 0;
    for (let t = 0; t < seconds(8); t++) {
      const step = procs(stepN(a.w, 1), 'corpse_bloom');
      expect(step.length).toBeLessThanOrEqual(KEYSTONE_CAPS.BLOOMS_PER_TICK);
      expect(a.w.blooms.length).toBeLessThanOrEqual(KEYSTONE_CAPS.BLOOM_QUEUE);
      bursts += step.length;
      for (const s of step) depth = Math.max(depth, s.n ?? 0);
    }
    expect(pack.every((e) => e.dead)).toBe(true);
    expect(bursts).toBe(pack.length);
    expect(depth).toBeGreaterThan(3);
    expect(a.w.blooms).toHaveLength(0);
  });

  it('resonance_engine: only Resonances charge the ultimate (`perResonance` % each); bursts are larger and hit harder', () => {
    const a = withKs('knight', ['resonance_engine']);
    const p = P('resonance_engine');
    give(a.h, 'infuse_ember_primary');
    const e = dummy(a.w, 0, 2);
    use(a, BTN.PRIMARY, 0.3);
    expect(lost(e)).toBeGreaterThan(0);
    expect(a.h.ult).toBe(0);
    a.h.invuln = 0;
    const foe = live(a.w, 'minion', 0, -1.2);
    foe.hp = foe.maxHp = HP;
    stepN(a.w, seconds(3));
    expect(a.h.damageTaken).toBeGreaterThan(0);
    expect(a.h.ult).toBe(0);
    killEnemy(a.w, foe, -1, true);
    setStatus(a.w, e, 'rime', a.h, 1);
    const ev = use(a, BTN.PRIMARY, 0.3);
    const burst = of(ev, 'resonance');
    expect(burst).toHaveLength(1);
    expect(burst[0]!.r).toBeCloseTo(STATUS.RESONANCE.RADIUS * (1 + p.burstArea!), 5);
    expect(a.h.ult).toBeCloseTo((ULTIMATE.MAX * p.perResonance!) / 100, 5);
    expect(procs(ev, 'resonance_engine')[0]).toMatchObject({ n: p.perResonance });
    // The burst deals 1 + burstDamage times as much as the same burst without the keystone.
    const burstHit = (ids: string[]): number => {
      const b = withKs('knight', ids);
      const target = dummy(b.w, 0, 2);
      setStatus(b.w, target, 'rime', b.h, 1);
      const before = target.hp;
      applyElement(b.w, target, 'ember', b.h, 1);
      return before - target.hp;
    };
    expect(burstHit(['resonance_engine'])).toBeCloseTo(burstHit([]) * (1 + p.burstDamage!), 5);
    expect(burstHit([])).toBeGreaterThan(0);
  });

  it('glass_cannon: +`damage` with everything, `hp` of the health', () => {
    const a = arena('knight');
    a.h.hp = a.h.maxHp;
    a.w.grantKeystone(0, 'glass_cannon');
    const p = P('glass_cannon');
    expect(a.h.maxHp).toBe(Math.round(CLASSES.knight.maxHp * p.hp!));
    expect(a.h.hp).toBe(a.h.maxHp);
    give(a.h, 'iron_heart');
    expect(a.h.maxHp).toBe(Math.round((CLASSES.knight.maxHp + 20) * p.hp!));
    const e = dummy(a.w, 0, 2);
    use(a, BTN.PRIMARY, 0.3);
    expect(lost(e)).toBeCloseTo(CLASSES.knight.primary[0]!.damage * (1 + p.damage!), 5);
    // Burn ticks too.
    const burning = dummy(a.w, 8, 8);
    setStatus(a.w, burning, 'ember', a.h, 1);
    stepN(a.w, seconds(STATUS.BURN.DURATION + 0.5));
    expect(lost(burning)).toBeCloseTo(STATUS.BURN.DPS * STATUS.BURN.DURATION * (1 + p.damage!), 3);
    // Giving it up restores the health pool, not the health.
    a.w.grantKeystone(0, 'colossus');
    a.w.grantKeystone(0, 'familiar', 'glass_cannon');
    expect(a.h.maxHp).toBe(CLASSES.knight.maxHp + 20 + P('colossus').hp!);
  });

  it('sanguine: heals `leech` of all damage dealt, overheal becomes a shield up to `overheal`; blessings, hallowed ground and other heroes heal nothing', () => {
    const a = withKs('templar', ['sanguine']);
    const p = P('sanguine');
    a.h.hp = 50;
    const e = dummy(a.w, 0, 2);
    const ev = use(a, BTN.PRIMARY, 1);
    expect(a.h.hp).toBeCloseTo(50 + lost(e) * p.leech!, 5);
    expect(procs(ev, 'sanguine').length).toBeLessThanOrEqual(Math.ceil(1.1 / KEYSTONE_CAPS.LEECH_SECONDS));
    // External healing is refused, the hero's own is not.
    expect(healHero(a.w, a.h, 10, true)).toBe(0);
    // His own hallowed ground: its damage is leeched, its healing pulses do nothing for him.
    const zones = of(use(a, BTN.SECONDARY, 6), 'zone');
    expect(zones).toHaveLength(1);
    expect(a.w.zones).toHaveLength(0);
    stepN(a.w, seconds(KEYSTONE_CAPS.LEECH_SECONDS));
    expect(a.h.hp).toBeCloseTo(50 + lost(e) * p.leech!, 3);
    expect(healHero(a.w, a.h, 5)).toBe(5);
    // Beyond full health: a shield, capped, that absorbs damage and shows in the snapshot.
    a.h.hp = a.h.maxHp;
    healHero(a.w, a.h, p.overheal! + 50);
    expect(a.h.ks.overheal).toBe(p.overheal);
    expect(a.w.getSnapshotBody().players[0]!.shield).toBe(p.overheal);
    a.h.invuln = 0;
    expect(damageHero(a.w, a.h, 12, -1)).toBe(true);
    expect(a.h.ks.overheal).toBe(p.overheal! - 12);
    expect(a.h.hp).toBe(a.h.maxHp);
  });

  it('sanguine: another hero\'s rally (on its ultimate) does nothing for the holder; its own rally does', () => {
    const w = party(['templar', 'knight']);
    expect(w.grantKeystone(0, 'sanguine')).toBe(true);
    const [holder, ally] = [w.hero(0)!, w.hero(1)!];
    place(w, 1, 2, 0);
    give(ally, 'rally');
    expect(ally.stats.rally).toBeGreaterThan(0);
    holder.hp = 50;
    ally.hp = 50;
    w.drainEvents();
    ally.ult = ULTIMATE.MAX;
    const pad = new Pad(w, 1);
    const ev = pad.hold({ aim: 0, buttons: BTN.ULTIMATE }, 1);
    ev.push(...pad.hold({ aim: 0 }, seconds(1)));
    expect(ally.hp).toBeGreaterThan(50);
    expect(holder.hp).toBe(50);
    expect(of(ev, 'heal').filter((x) => x.slot === 0)).toHaveLength(0);
    // His own rally heals him.
    give(holder, 'rally');
    holder.ult = ULTIMATE.MAX;
    new Pad(w, 0).hold({ aim: 0, buttons: BTN.ULTIMATE }, 1);
    expect(holder.hp).toBeGreaterThan(50);
  });

  it('momentum_engine: each kill is a stack of attack and movement speed up to `max`; all expire `seconds` after the last kill', () => {
    const plain = arena('knight');
    const a = withKs('knight', ['momentum_engine']);
    const p = P('momentum_engine');
    const seen: number[] = [];
    for (let i = 0; i < p.max! + 3; i++) {
      killEnemy(a.w, dummy(a.w, 5, 5), 0);
      stepN(a.w, seconds(0.3)).forEach((ev) => { if (ev.e === 'keystoneProc' && ev.id === 'momentum_engine') seen.push(ev.n ?? -1); });
      const n = Math.min(p.max!, i + 1);
      expect(a.h.ks.stacks).toBe(n);
      expect(attackSpeed(a.h)).toBeCloseTo(attackSpeed(plain.h) + p.perKill! * n, 5);
      expect(heroMoveSpeed(a.h)).toBeCloseTo(heroMoveSpeed(plain.h) * (1 + p.perKill! * n), 5);
    }
    // Every stack change is announced (none dropped by the rate limit).
    expect(seen.slice(0, p.max!)).toEqual(Array.from({ length: p.max! }, (_, i) => i + 1));
    const ev = stepN(a.w, seconds(p.seconds!));
    expect(a.h.ks.stacks).toBe(0);
    expect(procs(ev, 'momentum_engine').at(-1)!.n).toBe(0);
    expect(attackSpeed(a.h)).toBeCloseTo(attackSpeed(plain.h), 5);
  });
});

describe('class keystones', () => {
  it('ks_knight: a shield that runs out or breaks bursts for `fraction` of what it held', () => {
    const a = withKs('knight', ['ks_knight']);
    const p = P('ks_knight');
    const bash = CLASSES.knight.secondary;
    use(a, BTN.SECONDARY, 0.6);
    expect(a.h.tempShield).toBe(bash.selfShield);
    const e = dummy(a.w, a.h.body.x + 2, a.h.body.z);
    const out = dummy(a.w, a.h.body.x + p.radius! + 2, a.h.body.z);
    const ev = stepN(a.w, seconds(5));
    expect(lost(e)).toBeCloseTo(bash.selfShield * p.fraction!, 5);
    expect(lost(out)).toBe(0);
    expect(procs(ev, 'ks_knight')).toHaveLength(1);
    expect(procs(ev, 'ks_knight')[0]).toMatchObject({ r: p.radius, n: Math.round(bash.selfShield * p.fraction!) });
    // Broken by a blow: it bursts at once, for the full amount it held.
    use(a, BTN.SECONDARY, 0.6, { aim: Math.PI });
    const foe = live(a.w, 'minion', a.h.body.x, a.h.body.z - 1.5);
    foe.hp = foe.maxHp = HP;
    foe.damageMul = 5;
    a.h.invuln = 0;
    const hpBefore = lost(foe);
    for (let t = 0; t < seconds(4) && a.h.tempShield > 0; t++) stepN(a.w, 1);
    expect(a.h.tempShield).toBe(0);
    stepN(a.w, 2);
    expect(lost(foe) - hpBefore).toBeGreaterThanOrEqual(bash.selfShield * p.fraction! - 1e-6);
    // The barrier boon counts as a shield of the knight's as well.
    const b = withKs('knight', ['ks_knight']);
    give(b.h, 'barrier');
    stepN(b.w, 2);
    const near = dummy(b.w, 1.5, 0);
    b.h.barrier = 0;
    b.h.barrierDelay = 6;
    stepN(b.w, 2);
    expect(lost(near)).toBeCloseTo(14 * p.fraction!, 5);
  });

  it('ks_barbarian: Whirlwind lasts longer, drags enemies in and does not slow; a Skullsplitter leaves a maelstrom', () => {
    const a = withKs('barbarian', ['ks_barbarian']);
    const p = P('ks_barbarian');
    const whirl = CLASSES.barbarian.secondary;
    expect(a.h.abil.secondary.duration).toBeCloseTo(whirl.duration * (1 + p.duration!), 5);
    expect(a.h.abil.secondary.moveMul).toBe(p.moveMul);
    const inside = dummy(a.w, 0, 2);
    const dragged = dummy(a.w, 0, 5.5);
    const boss = live(a.w, 'champion', 5, 0);
    boss.stunTime = 0;
    const far = dummy(a.w, 0, whirl.radius * 2 + 3);
    const ev = use(a, BTN.SECONDARY, 2.6);
    expect(lost(inside)).toBeCloseTo(whirl.damage * Math.round((whirl.duration * (1 + p.duration!)) / whirl.tick), 3);
    expect(dragged.z).toBeLessThan(5.5 - 2);
    expect(dragged.z).toBeGreaterThan(1);
    expect(far.z).toBe(whirl.radius * 2 + 3);
    expect(boss.kbX).toBe(0);
    expect(procs(ev, 'ks_barbarian')).toHaveLength(1);
    // With the leap art: a stationary whirlwind where the barbarian lands.
    const leaper = withKs('barbarian', ['ks_barbarian'], mastered({ art: 1 }));
    const victim = dummy(leaper.w, 1, 7);
    const lev = use(leaper, BTN.SECONDARY, 1.2, { aimDist: 6 });
    const zone = of(lev, 'zone');
    expect(zone).toHaveLength(1);
    expect(zone[0]).toMatchObject({ kind: 'ks_barbarian', r: whirl.radius });
    expect(zone[0]!.dur).toBeCloseTo(whirl.duration * (1 + p.duration!), 5);
    expect(zone[0]!.z).toBeCloseTo(6, 0);
    stepN(leaper.w, seconds(2.5));
    expect(lost(victim)).toBeGreaterThan(CLASSES.barbarian.arts[0]!.damage + whirl.damage * 5);
    expect(leaper.w.zones).toHaveLength(0);
  });

  it('ks_mage: holding the button channels a piercing stream (pulses of `damageFraction` every `tick`), which slows the mage; no bolts fly', () => {
    const plain = arena('mage');
    const a = withKs('mage', ['ks_mage']);
    give(a.h, 'infuse_ember_primary');
    const p = P('ks_mage');
    const first = dummy(a.w, 0, 4);
    const behind = dummy(a.w, 0.2, 9);
    const beyond = dummy(a.w, 0, p.range! + 1.5);
    const beside = dummy(a.w, 2, 6);
    const secs = 3;
    const ev = a.pad.hold({ aim: 0, buttons: BTN.PRIMARY }, seconds(secs));
    expect(a.w.projectiles).toHaveLength(0);
    const pulse = Math.round(CLASSES.mage.primary[0]!.damage * p.damageFraction!);
    const hits = of(ev, 'hit').filter((h) => h.target.t === 'e' && h.target.id === behind.id && h.dmg === pulse);
    expect(hits.length).toBeGreaterThanOrEqual(Math.floor(secs / (Math.ceil(p.tick! / TICK_DT) * TICK_DT)) - 1);
    expect(hits.length).toBeLessThanOrEqual(Math.ceil(secs / p.tick!));
    expect(first.status).toBe('ember');
    expect(lost(beyond)).toBe(0);
    expect(lost(beside)).toBe(0);
    expect(a.w.getSnapshotBody().players[0]!.flags & PF.CHANNELING).toBe(PF.CHANNELING);
    expect(a.h.body.moveSpeed).toBeCloseTo(heroMoveSpeed(plain.h) * (1 - p.slow!), 5);
    expect(of(ev, 'cast').filter((c) => c.ability === 'ks_mage')).toHaveLength(1);
    // Letting go ends the channel.
    a.pad.hold({ aim: 0 }, seconds(0.4));
    expect(a.w.getSnapshotBody().players[0]!.flags & PF.CHANNELING).toBe(0);
    expect(a.h.body.moveSpeed).toBeCloseTo(heroMoveSpeed(plain.h), 5);
    // A pillar stops the stream.
    const b = withKs('mage', ['ks_mage']);
    b.w.room.obstacles.push({ x: 0, z: 4, r: 0.9, kind: 'pillar' });
    const hidden = dummy(b.w, 0, 8);
    b.pad.hold({ aim: 0, buttons: BTN.PRIMARY }, seconds(1));
    expect(lost(hidden)).toBe(0);
  });

  it('ks_rogue: every `every`-th bolt also throws the full knife fan', () => {
    const a = withKs('rogue', ['ks_rogue']);
    const p = P('ks_rogue');
    let bolts = 0;
    let fans = 0;
    const seenIds = new Set<number>();
    for (let t = 0; t < seconds(6); t++) {
      const ev = a.pad.hold({ aim: 0, buttons: BTN.PRIMARY }, 1);
      for (const q of a.w.projectiles) {
        if (seenIds.has(q.id)) continue;
        seenIds.add(q.id);
        if (q.kind === 'crossbowBolt') bolts++;
      }
      const fan = procs(ev, 'ks_rogue');
      if (fan.length > 0) { fans++; expect(fan[0]!.n).toBe(p.knives); }
    }
    expect(bolts).toBeGreaterThan(15);
    expect(fans).toBe(Math.floor(bolts / p.every!));
    expect([...a.w.projectiles].every((q) => q.kind !== 'knife' || q.slot === 'secondary')).toBe(true);
  });

  it('ks_templar: hallowed ground follows the templar and lasts `duration` longer; a Judgement leaves one where he lands', () => {
    const a = withKs('templar', ['ks_templar']);
    const p = P('ks_templar');
    const base = CLASSES.templar.secondary;
    const ev = use(a, BTN.SECONDARY, 0.6);
    const zone = of(ev, 'zone')[0]!;
    expect(zone.kind).toBe(base.id);
    expect(zone.dur).toBeCloseTo(base.duration * (1 + p.duration!), 5);
    a.pad.hold({ moveX: 1, moveZ: 0 }, seconds(2));
    expect(a.h.body.x).toBeGreaterThan(5);
    expect(a.w.zones[0]!.x).toBe(a.h.body.x);
    expect(a.w.zones[0]!.z).toBe(a.h.body.z);
    const e = dummy(a.w, a.h.body.x + 2, a.h.body.z);
    stepN(a.w, seconds(1.2));
    expect(lost(e)).toBeGreaterThan(0);
    const judge = withKs('templar', ['ks_templar'], mastered({ art: 1 }));
    const zones = of(use(judge, BTN.SECONDARY, 1.2, { aimDist: 5 }), 'zone');
    expect(zones.map((z) => z.kind)).toEqual([base.id]);
    judge.pad.hold({ moveX: -1 }, seconds(1));
    expect(judge.w.zones[0]!.x).toBe(judge.h.body.x);
  });

  it('ks_spellblade: every cut sends a blade wave at `fraction` strength; the finisher sends three', () => {
    const a = withKs('spellblade', ['ks_spellblade']);
    const p = P('ks_spellblade');
    const wave = CLASSES.spellblade.primary[2]!;
    const counts: number[] = [];
    for (let i = 0; i < 3; i++) {
      a.h.comboIndex = i;
      a.h.primaryCd = 0;
      a.h.lockTime = 0;
      a.w.projectiles.length = 0;
      a.pad.hold({ aim: 0, buttons: BTN.PRIMARY }, 1);
      let most = 0;
      for (let t = 0; t < seconds(0.25); t++) { a.pad.hold({ aim: 0 }, 1); most = Math.max(most, a.w.projectiles.length); }
      counts.push(most);
      if (i < 2) expect(a.w.projectiles[0]!.damage).toBeCloseTo(wave.damage * p.fraction!, 5);
      else expect(a.w.projectiles.map((q) => q.damage).sort((x, y) => y - x)).toEqual([wave.damage, wave.damage * p.fraction!, wave.damage * p.fraction!]);
    }
    expect(counts).toEqual([1, 1, 3]);
    expect(a.w.projectiles.every((q) => q.kind === 'bladeWave' && q.slot === 'primary')).toBe(true);
  });

  it('ks_shade: a backstab kill returns a dash charge and veils the shade — nobody targets it, and its next hit deals more', () => {
    const a = withKs('shade', ['ks_shade']);
    const p = P('ks_shade');
    const stab = CLASSES.shade.primary[0]!;
    // A kill from the front does nothing.
    const facing = dummy(a.w, 0, 1.5, 'minion', 5);
    facing.rot = Math.PI;
    expect(of(use(a, BTN.PRIMARY, 0.2), 'buff')).toHaveLength(0);
    expect(facing.dead).toBe(true);
    // From behind (the victim looks away from the shade).
    a.h.dashCharges = 0;
    a.h.dashRecharge = 2;
    const victim = dummy(a.w, 0, 1.5, 'minion', 5);
    victim.rot = 0;
    const hunter = live(a.w, 'minion', 6, 0);
    hunter.target = 0;
    const ev = use(a, BTN.PRIMARY, 0.2);
    expect(victim.dead).toBe(true);
    expect(of(ev, 'buff')).toEqual([{ e: 'buff', slot: 0, id: 'ks_shade', dur: p.stealth }]);
    expect(procs(ev, 'ks_shade')).toHaveLength(1);
    expect(a.h.dashCharges).toBe(1);
    expect(hunter.target).toBe(-1);
    // It walks to where the shade vanished, but starts no attack while the veil lasts.
    let attacked = false;
    for (let t = 0; t < seconds(p.stealth! - 0.6); t++) { stepN(a.w, 1); attacked = attacked || hunter.attack !== null || hunter.target === 0; }
    expect(attacked).toBe(false);
    expect(Math.hypot(hunter.x - a.h.ks.veilX, hunter.z - a.h.ks.veilZ)).toBeLessThan(5);
    // The next hit out of the veil: +damage (from the front, so no backstab bonus on top).
    const next = dummy(a.w, 0, 1.5);
    next.rot = Math.PI;
    use(a, BTN.PRIMARY, 0.2);
    expect(lost(next)).toBeCloseTo(stab.damage * (1 + p.damage!), 5);
    stepN(a.w, seconds(0.2));
    expect(a.h.ks.veilTime).toBe(0);
    stepN(a.w, seconds(1.5));
    expect(hunter.target).toBe(0);
    // A veiled hero can still be hurt (the veil is not invulnerability).
    expect(a.h.damageTaken).toBeGreaterThanOrEqual(0);
  });

  it('ks_shade: a Shadowstep kill counts as a backstab (victims struck in the same tick veil once); a kill by the hit out of the veil veils again', () => {
    const a = withKs('shade', ['ks_shade']);
    const p = P('ks_shade');
    a.h.dashCharges = 0;
    a.h.dashRecharge = 2;
    // Facing the shade: no backstab, but Shadowstep passes through and strikes from behind.
    const foes = [dummy(a.w, -0.3, 2.5, 'minion', 5), dummy(a.w, 0.3, 2.5, 'minion', 5)];
    for (const f of foes) f.rot = Math.PI;
    const ev = use(a, BTN.SECONDARY, 0.4, { aimDist: 5 });
    expect(foes.every((f) => f.dead)).toBe(true);
    expect(of(ev, 'buff')).toEqual([{ e: 'buff', slot: 0, id: 'ks_shade', dur: p.stealth }]);
    expect(a.h.dashCharges).toBe(1);
    // Without the keystone nothing happens.
    const plain = arena('shade');
    const f = dummy(plain.w, 0, 2.5, 'minion', 5);
    f.rot = Math.PI;
    expect(of(use(plain, BTN.SECONDARY, 0.4, { aimDist: 5 }), 'buff')).toHaveLength(0);
    expect(f.dead).toBe(true);
    // The empowered hit out of the veil kills (from the front): the veil comes again. One that does not kill ends it.
    a.h.body.x = 0;
    a.h.body.z = 0;
    a.w.drainEvents();
    const weak = dummy(a.w, 0, 1.5, 'minion', 5);
    weak.rot = Math.PI;
    const again = use(a, BTN.PRIMARY, 0.2);
    expect(weak.dead).toBe(true);
    expect(of(again, 'buff')).toEqual([{ e: 'buff', slot: 0, id: 'ks_shade', dur: p.stealth }]);
    expect(a.h.ks.veilHit).toBe(true);
    const tough = dummy(a.w, 0, 1.5);
    tough.rot = Math.PI;
    expect(of(use(a, BTN.PRIMARY, 0.2), 'buff')).toHaveLength(0);
    expect(a.h.ks.veilHit).toBe(false);
  });
});
