import { describe, expect, it } from 'vitest';
import { TICK_DT, WORLD } from '@shared/constants.ts';
import { BOONS, BOON_BY_ID, BOON_TUNING } from '@shared/data/boons.ts';
import { CLASSES, DASH } from '@shared/data/classes.ts';
import { ENEMIES, STATUS } from '@shared/data/enemies.ts';
import { applyBoon, SIM, type Hero, type World } from '@shared/sim/index.ts';
import { enemySpeed } from '@shared/sim/enemies.ts';
import { damageHero, enemyDamage } from '@shared/sim/combat.ts';
import { BTN, EF, PF, type GameEvent } from '@shared/types.ts';
import { casts, dummy, hits, live, Pad, place, sandbox, seconds, stepN } from './harness.ts';

const give = (w: World, slot: number, ...ids: string[]): Hero => {
  const h = w.hero(slot)!;
  for (const id of ids) expect(applyBoon(h, id), id).toBeGreaterThan(0);
  return h;
};

/** One knight slash at a dummy 2 m in front; returns the events up to the hit. */
const slash = (w: World, pad: Pad): GameEvent[] => {
  const h = w.hero(0)!;
  h.primaryCd = 0;
  h.lockTime = 0;
  h.comboIndex = 0;
  const ev = pad.hold({ buttons: BTN.PRIMARY, aim: 0 }, 1);
  ev.push(...pad.hold({ aim: 0 }, seconds(CLASSES[h.cls].primary[0]!.windup) + 2));
  return ev;
};
const bash = (w: World, pad: Pad): GameEvent[] => {
  const h = w.hero(0)!;
  h.secondaryCd = 0;
  h.lockTime = 0;
  place(w, 0, 0, 0);
  const ev = pad.hold({ buttons: BTN.SECONDARY, aim: 0 }, 1);
  ev.push(...pad.hold({ aim: 0 }, seconds(CLASSES.knight.secondary.lock) + 2));
  place(w, 0, 0, 0);
  return ev;
};
const setup = (...boons: string[]) => {
  const w = sandbox(['knight']);
  place(w, 0, 0, 0);
  const h = give(w, 0, ...boons);
  const target = dummy(w, 0, 2);
  return { w, h, target, pad: new Pad(w) };
};
const SLASH = CLASSES.knight.primary[0]!.damage;

describe('element statuses', () => {
  it('Burn deals DPS * DURATION over time and expires', () => {
    const { w, target, pad } = setup('infuse_ember_primary');
    const ev = slash(w, pad);
    expect(ev.some((e) => e.e === 'status' && e.id === target.id && e.el === 'ember')).toBe(true);
    expect(w.getSnapshotBody().enemies[0]!.flags & EF.BURN).toBeTruthy();
    const before = target.hp;
    const later = stepN(w, seconds(STATUS.BURN.DURATION) + 5);
    expect(before - target.hp).toBeCloseTo(STATUS.BURN.DPS * STATUS.BURN.DURATION, 5);
    expect(hits(later, 'e', target.id).every((h) => h.el === 'ember')).toBe(true);
    expect(target.status).toBeNull();
    expect(w.getSnapshotBody().enemies[0]!.flags & EF.BURN).toBeFalsy();
    // Burn damage is credited to the hero that applied it.
    expect(w.getRunState().stats[0]!.damage).toBe(Math.round(SLASH + STATUS.BURN.DPS * STATUS.BURN.DURATION));
  });

  it('infusion potency and wildfire scale Burn', () => {
    const { w, target, pad } = setup('infuse_ember_primary', 'infuse_ember_primary', 'wildfire');
    slash(w, pad);
    const before = target.hp;
    stepN(w, seconds(STATUS.BURN.DURATION) + 5);
    const potency = BOON_BY_ID.get('infuse_ember_primary')!.values[1]!;
    const wildfire = BOON_BY_ID.get('wildfire')!.values[0]!;
    expect(before - target.hp).toBeCloseTo(STATUS.BURN.DPS * STATUS.BURN.DURATION * potency * (1 + wildfire), 5);
  });

  it('Chill slows movement; deep_frost slows more and weakens the enemy', () => {
    const { w, target, pad } = setup('infuse_rime_primary');
    const base = enemySpeed(target);
    slash(w, pad);
    expect(target.status).toBe('rime');
    expect(w.getSnapshotBody().enemies[0]!.flags & EF.CHILL).toBeTruthy();
    expect(enemySpeed(target)).toBeCloseTo(base * (1 - STATUS.CHILL.SLOW), 6);
    expect(enemyDamage(target, 10)).toBeCloseTo(10, 6);
    stepN(w, seconds(STATUS.CHILL.DURATION) + 2);
    expect(target.status).toBeNull();
    expect(enemySpeed(target)).toBeCloseTo(base, 6);

    const b = setup('infuse_rime_primary', 'deep_frost');
    slash(b.w, b.pad);
    const frost = BOON_BY_ID.get('deep_frost')!.values[0]!;
    expect(enemySpeed(b.target)).toBeCloseTo(base * (1 - STATUS.CHILL.SLOW - frost), 6);
    expect(enemyDamage(b.target, 10)).toBeCloseTo(10 * (1 - frost), 6);
  });

  it('Shock makes the target take more damage from every source; overcharge adds to it', () => {
    const { w, target, pad } = setup('infuse_storm_primary');
    slash(w, pad);
    expect(target.status).toBe('storm');
    expect(w.getSnapshotBody().enemies[0]!.flags & EF.SHOCK).toBeTruthy();
    const before = target.hp;
    slash(w, pad);
    expect(before - target.hp).toBeCloseTo(SLASH * (1 + STATUS.SHOCK.VULNERABILITY), 5);

    const b = setup('infuse_storm_primary', 'overcharge');
    slash(b.w, b.pad);
    const hp = b.target.hp;
    slash(b.w, b.pad);
    expect(hp - b.target.hp).toBeCloseTo(SLASH * (1 + STATUS.SHOCK.VULNERABILITY + BOON_BY_ID.get('overcharge')!.values[0]!), 5);
  });

  it('an enemy carries at most one element; the same element only refreshes it', () => {
    const { w, target, pad } = setup('infuse_ember_primary');
    slash(w, pad);
    stepN(w, seconds(1));
    const ev = slash(w, pad);
    expect(target.status).toBe('ember');
    expect(target.statusTime).toBeGreaterThan(STATUS.BURN.DURATION - 0.3);
    expect(ev.filter((e) => e.e === 'status')).toHaveLength(0);
    expect(ev.filter((e) => e.e === 'resonance')).toHaveLength(0);
    const flags = w.getSnapshotBody().enemies[0]!.flags;
    expect([EF.BURN, EF.CHILL, EF.SHOCK].filter((f) => flags & f)).toHaveLength(1);
  });
});

describe('Resonance', () => {
  const duo = (...boons: string[]) => {
    const s = setup('infuse_ember_primary', 'infuse_rime_secondary', ...boons);
    const near = dummy(s.w, 2, 3);
    const far = dummy(s.w, 0, 2 + STATUS.RESONANCE.RADIUS * 2 + 3);
    return { ...s, near, far };
  };

  it('a different element detonates the mark: area damage, element transfer, event and stat', () => {
    const { w, target, near, far, pad } = duo();
    slash(w, pad);
    expect(target.status).toBe('ember');
    const nearBefore = near.hp;
    const ev = bash(w, pad);
    const res = ev.filter((e) => e.e === 'resonance');
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({ a: 'ember', b: 'rime', r: STATUS.RESONANCE.RADIUS, by: 0 });
    expect(ev.some((e) => e.e === 'aoe' && !e.hostile && e.el === 'rime')).toBe(true);
    // The neighbour was never touched by the bash itself (outside the lunge path), only by the burst.
    expect(nearBefore - near.hp).toBeCloseTo(STATUS.RESONANCE.DAMAGE, 5);
    expect(target.status).toBe('rime');
    expect(near.status).toBe('rime');
    expect(far.status).toBeNull();
    expect(far.hp).toBe(far.maxHp);
    expect(w.getRunState().stats[0]!.resonances).toBe(1);
  });

  it('has an internal cooldown per enemy, then triggers again', () => {
    const { w, target, pad } = duo();
    slash(w, pad);
    const ev = bash(w, pad);
    expect(ev.filter((e) => e.e === 'resonance')).toHaveLength(1);
    // The bash knocked the dummy away: put it back in front of the knight.
    const reset = (): void => { target.x = 0; target.z = 2; target.kbX = 0; target.kbZ = 0; };
    reset();
    // Strike with ember again while the cooldown is running: the hit lands but the mark is untouched.
    target.resonanceCd = STATUS.RESONANCE.INTERNAL_COOLDOWN;
    const hp = target.hp;
    const blocked = slash(w, pad);
    expect(target.hp).toBeLessThan(hp);
    expect(blocked.filter((e) => e.e === 'resonance')).toHaveLength(0);
    expect(target.status).toBe('rime');
    stepN(w, seconds(STATUS.RESONANCE.INTERNAL_COOLDOWN) + 1);
    reset();
    const again = slash(w, pad);
    expect(again.filter((e) => e.e === 'resonance')).toHaveLength(1);
    expect(again.find((e) => e.e === 'resonance')).toMatchObject({ a: 'rime', b: 'ember' });
    expect(target.status).toBe('ember');
  });

  it('a burst does not chain through its own victims in the same instant', () => {
    const { w, h, target, near, pad } = duo();
    // Both carry ember; one rime hit detonates only the struck enemy, the neighbour is transferred to rime.
    slash(w, pad);
    near.status = 'ember';
    near.statusTime = 3;
    h.secondaryCd = 0;
    h.lockTime = 0;
    const ev = pad.hold({ buttons: BTN.SECONDARY, aim: 0 }, 1);
    for (let i = 0; i < seconds(0.5); i++) {
      const step = pad.hold({ aim: 0 }, 1);
      ev.push(...step);
      if (!step.some((e) => e.e === 'resonance')) continue;
      expect(target.resonanceCd).toBeGreaterThan(0);
      expect(near.resonanceCd).toBeGreaterThan(0);
      break;
    }
    expect(ev.filter((e) => e.e === 'resonance')).toHaveLength(1);
    expect(near.status).toBe('rime');
  });

  it('amplifier, wide_resonance, echo, aftershock and shared_vigor modify the burst', () => {
    const { w, h, target, near, pad } = duo('amplifier', 'wide_resonance', 'echo', 'aftershock', 'shared_vigor');
    h.stats.echo = 1;
    slash(w, pad);
    h.hp = 50;
    h.dashCharges = 0;
    h.dashRecharge = DASH.COOLDOWN;
    const nearBefore = near.hp;
    void target;
    h.secondaryCd = 0;
    h.lockTime = 0;
    const ev = pad.hold({ buttons: BTN.SECONDARY, aim: 0 }, 1);
    let cdAtBurst = -1;
    for (let i = 0; i < seconds(0.5) && cdAtBurst < 0; i++) {
      const before = h.secondaryCd;
      const step = pad.hold({ aim: 0 }, 1);
      ev.push(...step);
      if (step.some((e) => e.e === 'resonance')) cdAtBurst = before - h.secondaryCd;
    }
    const res = ev.filter((e): e is Extract<GameEvent, { e: 'resonance' }> => e.e === 'resonance');
    const amp = BOON_BY_ID.get('amplifier')!.values[0]!;
    const wide = BOON_BY_ID.get('wide_resonance')!.values[0]!;
    expect(res).toHaveLength(2);
    expect(res[0]!.r).toBeCloseTo(STATUS.RESONANCE.RADIUS * (1 + wide), 6);
    expect(nearBefore - near.hp).toBeCloseTo(2 * STATUS.RESONANCE.DAMAGE * (1 + amp), 5);
    // aftershock: a dash charge back and a chunk of the secondary cooldown refunded.
    expect(h.dashCharges).toBe(1);
    expect(cdAtBurst).toBeCloseTo(BOON_BY_ID.get('aftershock')!.values[0]! * h.secondaryCdMax + TICK_DT, 5);
    // shared_vigor healed the hero.
    expect(h.hp).toBe(50 + BOON_BY_ID.get('shared_vigor')!.values[0]!);
    expect(ev.some((e) => e.e === 'heal' && e.slot === 0)).toBe(true);
  });

  it('works across heroes: one applies, another detonates and gets the credit', () => {
    const w = sandbox(['knight', 'barbarian']);
    place(w, 0, 0, 0);
    place(w, 1, 0, 4);
    give(w, 0, 'infuse_storm_primary');
    give(w, 1, 'infuse_ember_primary');
    const target = dummy(w, 0, 2);
    const a = new Pad(w, 0);
    const b = new Pad(w, 1);
    a.send({ buttons: BTN.PRIMARY, aim: 0 });
    stepN(w, seconds(0.4));
    expect(target.status).toBe('storm');
    b.send({ buttons: BTN.PRIMARY, aim: Math.PI });
    const ev = stepN(w, seconds(0.5));
    expect(ev.find((e) => e.e === 'resonance')).toMatchObject({ a: 'storm', b: 'ember', by: 1 });
    expect(w.getRunState().stats[1]!.resonances).toBe(1);
  });

  it('an infused dash marks and detonates enemies along its path', () => {
    const w = sandbox(['knight']);
    place(w, 0, 0, 0);
    give(w, 0, 'infuse_rime_dash');
    const target = dummy(w, 0.5, 2.5);
    target.status = 'ember';
    target.statusTime = 3;
    const pad = new Pad(w);
    const ev = pad.hold({ buttons: BTN.DASH, moveZ: 1 }, 1);
    ev.push(...pad.hold({ moveZ: 1 }, seconds(DASH.DURATION) + 1));
    expect(ev.filter((e) => e.e === 'resonance')).toHaveLength(1);
    expect(hits(ev, 'e', target.id).filter((h) => h.dmg === SIM.DASH_INFUSION_DAMAGE)).toHaveLength(1);
    expect(target.status).toBe('rime');
  });
});

describe('boons', () => {
  it('data sanity: 33 boons, unique ids, every one is implemented', () => {
    expect(BOONS).toHaveLength(33);
    expect(new Set(BOONS.map((b) => b.id)).size).toBe(33);
    for (const def of BOONS) {
      const w = sandbox(['rogue']);
      const h = w.hero(0)!;
      const before = JSON.stringify([h.stats, h.maxHp, h.barrier, h.dashCharges]);
      if (def.category === 'element') applyBoon(h, `infuse_${def.element}_primary`);
      const mid = JSON.stringify([h.stats, h.maxHp, h.barrier, h.dashCharges]);
      for (let level = 1; level <= def.values.length; level++) expect(applyBoon(h, def.id)).toBe(level);
      expect(applyBoon(h, def.id), `${def.id} beyond max level`).toBe(0);
      expect(JSON.stringify([h.stats, h.maxHp, h.barrier, h.dashCharges]), def.id).not.toBe(def.category === 'element' ? mid : before);
    }
  });

  it('infusion: picking another element for the same ability replaces the old one', () => {
    const w = sandbox(['knight']);
    const h = give(w, 0, 'infuse_ember_primary', 'infuse_ember_primary', 'infuse_storm_secondary', 'infuse_rime_primary');
    expect(w.getBoons(0)).toEqual([{ id: 'infuse_storm_secondary', level: 1 }, { id: 'infuse_rime_primary', level: 1 }]);
    expect(h.stats.infusion.primary).toEqual({ element: 'rime', potency: 1 });
    expect(h.stats.infusion.secondary).toEqual({ element: 'storm', potency: 1 });
  });

  it('offense: keen_edge, heavy_hand, executioner and deadeye change the damage numbers', () => {
    const keen = setup('keen_edge', 'keen_edge');
    slash(keen.w, keen.pad);
    expect(keen.target.maxHp - keen.target.hp).toBeCloseTo(SLASH * (1 + BOON_BY_ID.get('keen_edge')!.values[1]!), 5);

    const heavy = setup('heavy_hand');
    bash(heavy.w, heavy.pad);
    expect(heavy.target.maxHp - heavy.target.hp).toBeCloseTo(CLASSES.knight.secondary.damage * (1 + BOON_BY_ID.get('heavy_hand')!.values[0]!), 5);

    const exec = setup('executioner');
    exec.target.hp = exec.target.maxHp * (BOON_TUNING.EXECUTE_THRESHOLD - 0.05);
    const hp = exec.target.hp;
    slash(exec.w, exec.pad);
    expect(hp - exec.target.hp).toBeCloseTo(SLASH * (1 + BOON_BY_ID.get('executioner')!.values[0]!), 5);

    const crit = setup('deadeye');
    crit.h.stats.crit = 1;
    const ev = slash(crit.w, crit.pad);
    expect(crit.target.maxHp - crit.target.hp).toBeCloseTo(SLASH * STATUS.CRIT_MULTIPLIER, 5);
    expect(hits(ev, 'e')[0]).toMatchObject({ crit: true, dmg: SLASH * STATUS.CRIT_MULTIPLIER });
    // At the real chance roughly values[0] of the hits crit.
    const real = setup('deadeye');
    let crits = 0;
    const swings = 300;
    for (let i = 0; i < swings; i++) crits += hits(slash(real.w, real.pad), 'e').filter((h) => h.crit).length;
    expect(crits / swings).toBeGreaterThan(0.04);
    expect(crits / swings).toBeLessThan(0.18);
  });

  it('offense: swift_strikes shortens primary cooldown, windup and lock', () => {
    const count = (boons: string[]): number => {
      const w = sandbox(['knight']);
      give(w, 0, ...boons);
      return casts(new Pad(w).hold({ buttons: BTN.PRIMARY }, seconds(10))).length;
    };
    const base = count([]);
    const fast = count(['swift_strikes', 'swift_strikes', 'swift_strikes']);
    expect(fast / base).toBeGreaterThan(1.15);
    expect(fast / base).toBeLessThan(1.3);
  });

  it('defense: iron_heart raises max health and heals; leech heals on kill', () => {
    const w = sandbox(['knight']);
    const h = w.hero(0)!;
    h.hp = 50;
    give(w, 0, 'iron_heart');
    const bonus = BOON_BY_ID.get('iron_heart')!.values[0]!;
    expect(h.maxHp).toBe(CLASSES.knight.maxHp + bonus);
    expect(h.hp).toBe(50 + bonus);
    give(w, 0, 'leech');
    place(w, 0, 0, 0);
    const weak = dummy(w, 0, 2, 'minion', 5);
    const ev = slash(w, new Pad(w));
    expect(weak.dead).toBe(true);
    expect(ev.some((e) => e.e === 'kill' && e.id === weak.id && e.by === 0)).toBe(true);
    expect(h.hp).toBe(50 + bonus + BOON_BY_ID.get('leech')!.values[0]!);
    expect(w.getRunState().stats[0]!.kills).toBe(1);
  });

  it('defense: barrier absorbs damage and recharges after the delay without damage', () => {
    const w = sandbox(['knight']);
    const h = give(w, 0, 'barrier');
    const shield = BOON_BY_ID.get('barrier')!.values[0]!;
    expect(w.getSnapshotBody().players[0]!.shield).toBe(shield);
    expect(damageHero(w, h, shield + 6, -1)).toBe(true);
    expect(h.hp).toBe(h.maxHp - 6);
    expect(w.getSnapshotBody().players[0]!.shield).toBe(0);
    stepN(w, seconds(BOON_TUNING.BARRIER_RECHARGE_DELAY) - 5);
    expect(h.barrier).toBe(0);
    stepN(w, 10);
    expect(h.barrier).toBe(shield);
  });

  it('defense: last_stand saves the hero once per chamber', () => {
    const w = sandbox(['knight']);
    const h = give(w, 0, 'last_stand');
    damageHero(w, h, 9999, -1);
    expect(h.state).toBe('alive');
    expect(h.hp).toBe(1);
    expect(w.getSnapshotBody().players[0]!.flags & PF.INVULNERABLE).toBeTruthy();
    expect(damageHero(w, h, 9999, -1)).toBe(false);
    stepN(w, seconds(BOON_TUNING.LAST_STAND_INVULNERABILITY) + 2);
    damageHero(w, h, 9999, -1);
    expect(h.state).toBe('downed');
  });

  it('mobility: fleet_foot, quick_step, spare_step and quick_wits', () => {
    const w = sandbox(['knight']);
    const h = give(w, 0, 'fleet_foot', 'quick_step', 'spare_step', 'quick_wits');
    const pad = new Pad(w);
    pad.hold({ moveX: 1 }, 1);
    expect(w.getSelfState(0).moveSpeed).toBeCloseTo(CLASSES.knight.moveSpeed * (1 + BOON_BY_ID.get('fleet_foot')!.values[0]!), 6);
    expect(w.getSnapshotBody().players[0]!.dashCharges).toBe(CLASSES.knight.dashCharges + 1);
    pad.hold({ buttons: BTN.DASH }, 1);
    const recharge = DASH.COOLDOWN / (1 + BOON_BY_ID.get('quick_step')!.values[0]!);
    pad.hold({}, seconds(recharge) - 3);
    expect(h.dashCharges).toBe(CLASSES.knight.dashCharges);
    pad.hold({}, 5);
    expect(h.dashCharges).toBe(CLASSES.knight.dashCharges + 1);
    pad.hold({ buttons: BTN.SECONDARY }, 1);
    expect(h.secondaryCdMax).toBeCloseTo(CLASSES.knight.secondary.cooldown * (1 - BOON_BY_ID.get('quick_wits')!.values[0]!), 6);
  });

  it('kinship: kindred_flame buffs the owner and allies in range, and shows the aura flag', () => {
    const w = sandbox(['knight', 'barbarian']);
    place(w, 0, 0, 0);
    place(w, 1, 3, 0);
    give(w, 1, 'kindred_flame');
    const target = dummy(w, 0, 2);
    const pad = new Pad(w);
    slash(w, pad);
    const bonus = BOON_BY_ID.get('kindred_flame')!.values[0]!;
    expect(target.maxHp - target.hp).toBeCloseTo(SLASH * (1 + bonus), 5);
    const snap = w.getSnapshotBody().players;
    expect(snap[0]!.flags & PF.KINDRED_AURA).toBeTruthy();
    expect(snap[1]!.flags & PF.KINDRED_AURA).toBeTruthy();
    // Out of range: no bonus, no flag.
    place(w, 1, BOON_TUNING.KINDRED_RADIUS + 3, 0);
    const hp = target.hp;
    slash(w, pad);
    expect(hp - target.hp).toBeCloseTo(SLASH, 5);
    expect(w.getSnapshotBody().players[0]!.flags & PF.KINDRED_AURA).toBeFalsy();
  });

  it('kinship: lifeline speeds up revives and returns more health; oathbond triggers when an ally falls', () => {
    const w = sandbox(['knight', 'mage']);
    place(w, 0, 0, 0);
    place(w, 1, 1, 0);
    const knight = give(w, 0, 'lifeline', 'oathbond');
    const mage = w.hero(1)!;
    damageHero(w, mage, 9999, -1);
    expect(mage.state).toBe('downed');
    expect(knight.oathbondTime).toBe(BOON_TUNING.OATHBOND_DURATION);
    // Oathbond: +damage and haste (move speed).
    const target = dummy(w, 0, 2);
    const pad = new Pad(w);
    slash(w, pad);
    expect(target.maxHp - target.hp).toBeCloseTo(SLASH * (1 + BOON_BY_ID.get('oathbond')!.values[0]!), 5);
    pad.hold({}, seconds(0.6));
    pad.hold({ moveX: 0.001 }, 1);
    expect(w.getSelfState(0).moveSpeed).toBeCloseTo(CLASSES.knight.moveSpeed * (1 + BOON_TUNING.OATHBOND_HASTE), 6);
    const life = BOON_BY_ID.get('lifeline')!.values[0]!;
    let ticks = 0;
    const startProgress = mage.revive;
    while (mage.state === 'downed' && ticks < 500) { w.step(); ticks++; }
    const expected = ((1 - startProgress) * WORLD.REVIVE_SECONDS) / (1 + life);
    expect(ticks * TICK_DT).toBeGreaterThan(expected - 0.1);
    expect(ticks * TICK_DT).toBeLessThan(expected + 0.1);
    expect(mage.hp).toBe(Math.round(mage.maxHp * WORLD.REVIVE_HP_FRACTION * (1 + life)));
  });

  it('kinship: oathbond also triggers when the owner drops below 30% health (re-arming above it)', () => {
    const w = sandbox(['knight']);
    const h = give(w, 0, 'oathbond');
    damageHero(w, h, h.maxHp * 0.5, -1);
    expect(h.oathbondTime).toBe(0);
    stepN(w, seconds(0.5));
    damageHero(w, h, h.maxHp * 0.25, -1);
    expect(h.oathbondTime).toBe(BOON_TUNING.OATHBOND_DURATION);
    stepN(w, seconds(BOON_TUNING.OATHBOND_DURATION) + 2);
    expect(h.oathbondTime).toBe(0);
    damageHero(w, h, 1, -1);
    expect(h.oathbondTime).toBe(0);
  });
});

describe('hero damage rules', () => {
  it('grants HIT_IFRAME_SECONDS of invulnerability after a hit', () => {
    const w = sandbox(['knight']);
    const h = w.hero(0)!;
    expect(damageHero(w, h, 10, -1)).toBe(true);
    expect(damageHero(w, h, 10, -1)).toBe(false);
    stepN(w, seconds(WORLD.HIT_IFRAME_SECONDS) - 2);
    expect(damageHero(w, h, 10, -1)).toBe(false);
    stepN(w, 4);
    expect(damageHero(w, h, 10, -1)).toBe(true);
    expect(h.hp).toBe(h.maxHp - 20);
  });

  it('the knight\'s bash shield soaks damage first and fades', () => {
    const w = sandbox(['knight']);
    place(w, 0, 0, 0);
    const h = w.hero(0)!;
    const pad = new Pad(w);
    pad.hold({ buttons: BTN.SECONDARY }, 1);
    const shield = CLASSES.knight.secondary.selfShield;
    expect(w.getSnapshotBody().players[0]!.shield).toBe(shield);
    damageHero(w, h, shield + 4, -1);
    expect(h.hp).toBe(h.maxHp - 4);
    h.tempShield = shield;
    h.tempShieldTime = SIM.TEMP_SHIELD_SECONDS;
    pad.hold({}, seconds(SIM.TEMP_SHIELD_SECONDS) + 2);
    expect(w.getSnapshotBody().players[0]!.shield).toBe(0);
  });

  it('enemy damage follows the enemy definition (sanity for the hit event)', () => {
    const w = sandbox(['knight']);
    place(w, 0, 0, 0);
    live(w, 'minion', 0, 1.2);
    const ev = stepN(w, seconds(1.5));
    const hit = hits(ev, 'p', 0)[0];
    expect(hit).toBeDefined();
    expect(hit!.dmg).toBe(Math.round(ENEMIES.minion.damage));
    expect(w.hero(0)!.hp).toBe(CLASSES.knight.maxHp - ENEMIES.minion.damage);
  });
});
