/** Update 3: umbra / Wither, the six named reactions, every new boon, class and duo boons, draft rules, set bonuses. */
import { describe, expect, it } from 'vitest';
import { RUN, WORLD } from '@shared/constants.ts';
import { BOONS, BOON_BY_ID, BOON_TUNING, SETS, setProgress } from '@shared/data/boons.ts';
import { CLASSES, DASH, ULTIMATE } from '@shared/data/classes.ts';
import { STATUS } from '@shared/data/enemies.ts';
import { REACTIONS, REACTION_TUNING, reactionOf, type ReactionId } from '@shared/data/reactions.ts';
import { RELIC_TUNING } from '@shared/data/relics.ts';
import { damageHero, downHero, enemyDamage, killEnemy, reviveHero, setStatus, strikeEnemy } from '@shared/sim/combat.ts';
import { enemySpeed } from '@shared/sim/enemies.ts';
import { applyBoon, generateDraft, isOfferable, Rng, SIM, World, type Enemy, type Hero } from '@shared/sim/index.ts';
import { BTN, CLASS_IDS, EF, ELEMENT_IDS, type AbilitySlot, type ClassId, type ElementId } from '@shared/types.ts';
import { clearChamber, draftAll, dummy, live, Pad, place, seconds, stepN, takeDoor } from './harness.ts';
import { arena, give, mastered, metaLevels, of, party, use, type Arena } from './u3kit.ts';

const val = (id: string, level = 1): number => BOON_BY_ID.get(id)!.values[level - 1]!;
const hit = (a: { w: World; h: Hero }, e: Enemy, base = 10, slot: AbilitySlot = 'dash', special: string | null = null): number => {
  const before = e.hp;
  strikeEnemy(a.w, a.h, e, base, slot, { fromX: a.h.body.x, fromZ: a.h.body.z, stun: 0, knockback: 0, special });
  return before - e.hp;
};
/** A passive, unstunned enemy with plenty of health. */
const post = (w: World, x: number, z: number, kind: Parameters<World['spawnEnemy']>[0] = 'minion'): Enemy => {
  const e = live(w, kind, x, z);
  e.passive = true;
  e.hp = e.maxHp = 100000;
  e.shieldHp = 0;
  return e;
};
const mark = (e: Enemy, el: ElementId, by = 0): void => {
  e.status = el;
  e.statusTime = 5;
  e.statusBy = by;
};

describe('umbra: Wither', () => {
  it('a withered enemy deals less damage and every hit on it heals the attacker; it shows on the wire and wears off', () => {
    const a = arena('knight');
    give(a.h, 'infuse_umbra_primary');
    const foe = dummy(a.w, 0, 2);
    const ev = use(a, BTN.PRIMARY, 0.3);
    expect(foe.status).toBe('umbra');
    expect(of(ev, 'status')).toEqual([{ e: 'status', id: foe.id, el: 'umbra' }]);
    expect(a.w.getSnapshotBody().enemies[0]!.flags & EF.WITHER).toBeTruthy();
    expect(enemyDamage(foe, 10)).toBeCloseTo(10 * (1 - STATUS.WITHER.WEAKEN), 6);
    // The hit that applies the status does not leech yet; the next one does.
    a.h.hp = 50;
    hit(a, foe);
    expect(a.h.hp).toBeCloseTo(50 + STATUS.WITHER.LEECH, 6);
    a.pad.hold({}, seconds(STATUS.WITHER.DURATION) + 2);
    expect(foe.status).toBeNull();
    expect(enemyDamage(foe, 10)).toBeCloseTo(10, 6);
    expect(a.w.getSnapshotBody().enemies[0]!.flags & EF.WITHER).toBeFalsy();
  });

  it('creeping_dark: a further cut of the enemy damage and twice the leech', () => {
    const a = arena('knight');
    give(a.h, 'infuse_umbra_primary', 'creeping_dark');
    const foe = dummy(a.w, 0, 2);
    use(a, BTN.PRIMARY, 0.3);
    // Two umbra boons switch on the umbra set (tier 1): statuses are stronger.
    const power = 1 + SETS.find((s) => s.id === 'set_umbra')!.tiers[0].mods!.elementPotency!;
    expect(enemyDamage(foe, 10)).toBeCloseTo(10 * (1 - STATUS.WITHER.WEAKEN * power - val('creeping_dark')), 6);
    a.h.hp = 50;
    hit(a, foe);
    expect(a.h.hp).toBeCloseTo(50 + STATUS.WITHER.LEECH * power * 2, 6);
  });
});

describe('named reactions', () => {
  /** A hero whose primary carries `b` strikes an enemy marked with `a`; `near` is inside the plain burst radius. */
  const react = (a: ElementId, b: ElementId, boons: string[] = [], cls: ClassId = 'knight') => {
    const s = arena(cls);
    give(s.h, `infuse_${b}_primary`, ...boons);
    const target = post(s.w, 0, 2);
    const near = post(s.w, 2, 2);
    const wide = post(s.w, 0, 2 + STATUS.RESONANCE.RADIUS + 1.2);
    mark(target, a);
    const hp = near.hp;
    strikeEnemy(s.w, s.h, target, 10, 'primary', { fromX: 0, fromZ: 0, stun: 0, knockback: 0 });
    const ev = s.w.drainEvents();
    return { ...s, target, near, wide, ev, burst: hp - near.hp, def: reactionOf(a, b)! };
  };

  it('every pair of elements has exactly one reaction and the burst follows its multipliers', () => {
    expect(REACTIONS).toHaveLength(6);
    const seen = new Set<string>();
    for (const a of ELEMENT_IDS) {
      for (const b of ELEMENT_IDS) {
        if (a === b) { expect(reactionOf(a, b)).toBeNull(); continue; }
        const r = react(a, b);
        expect(r.def).toBe(reactionOf(b, a));
        seen.add(r.def.id);
        const res = of(r.ev, 'resonance');
        expect(res).toEqual([{ e: 'resonance', x: 0, z: 2, r: STATUS.RESONANCE.RADIUS * r.def.radiusMul, a, b, by: 0 }]);
        expect(r.burst, `${a}+${b}`).toBeCloseTo(STATUS.RESONANCE.DAMAGE * r.def.damageMul, 6);
        // (Void Arc reaches further by leaping, see its own test.)
        if (r.def.id !== 'voidarc') expect(r.wide.hp < 100000, `${a}+${b} reach`).toBe(r.def.radiusMul > 1.3);
      }
    }
    expect(seen.size).toBe(6);
  });

  it('Shatter (ember + rime): hits harder and stuns; bosses are staggered and take extra burst damage instead', () => {
    const r = react('ember', 'rime');
    expect(r.def.id).toBe('shatter');
    expect(r.near.stunTime).toBe(REACTION_TUNING.SHATTER_STUN);
    expect(r.target.stunTime).toBe(REACTION_TUNING.SHATTER_STUN);
    expect(r.wide.stunTime).toBe(0);
    const s = arena('knight');
    give(s.h, 'infuse_rime_primary');
    const boss = post(s.w, 0, 3, 'regent');
    mark(boss, 'ember');
    const lost = hit(s, boss, 10, 'primary');
    expect(lost).toBeCloseTo(10 + STATUS.RESONANCE.DAMAGE * r.def.damageMul * (1 + REACTION_TUNING.SHATTER_BOSS_BONUS), 6);
    expect(boss.stunTime).toBe(SIM.BOSS_STAGGER_SECONDS);
  });

  it('Conflagration (ember + storm): a much larger burst that leaves a stronger Burn on everything, whichever element came last', () => {
    for (const [a, b] of [['ember', 'storm'], ['storm', 'ember']] as const) {
      const r = react(a, b);
      expect(r.def.id).toBe('conflagration');
      for (const e of [r.target, r.near, r.wide]) {
        expect(e.status).toBe('ember');
        expect(e.statusPotency).toBe(REACTION_TUNING.CONFLAGRATION_BURN_POTENCY);
      }
      // The Burn ticks with that potency.
      const hp = r.wide.hp;
      stepN(r.w, seconds(SIM.BURN_TICK_SECONDS) + 1);
      expect(hp - r.wide.hp).toBeCloseTo(STATUS.BURN.DPS * SIM.BURN_TICK_SECONDS * REACTION_TUNING.CONFLAGRATION_BURN_POTENCY, 6);
    }
  });

  it('Superconduct (rime + storm): enemies in the burst are Sundered and take more damage from everything for a while', () => {
    const r = react('storm', 'rime');
    expect(r.def.id).toBe('superconduct');
    expect(r.near.status).toBe('rime');
    expect(hit(r, r.near)).toBeCloseTo(10 * (1 + REACTION_TUNING.SUNDER_VULNERABILITY), 6);
    expect(hit(r, r.wide)).toBeCloseTo(10, 6);
    stepN(r.w, seconds(REACTION_TUNING.SUNDER_SECONDS) + 2);
    expect(hit(r, r.near)).toBeCloseTo(10, 6);
  });

  it('Soulfire (ember + umbra): heals every hero near the burst, not those far away', () => {
    const w = party(['knight', 'mage', 'rogue']);
    place(w, 0, 0, 0);
    place(w, 1, REACTION_TUNING.SOULFIRE_HEAL_RADIUS - 1, 2);
    place(w, 2, REACTION_TUNING.SOULFIRE_HEAL_RADIUS + 3, 2);
    const h = give(w.hero(0)!, 'infuse_umbra_primary');
    for (const o of w.heroes) o.hp = 40;
    const target = post(w, 0, 2);
    mark(target, 'ember');
    strikeEnemy(w, h, target, 10, 'primary', { fromX: 0, fromZ: 0, stun: 0, knockback: 0 });
    expect(of(w.drainEvents(), 'resonance')[0]).toMatchObject({ a: 'ember', b: 'umbra' });
    expect(w.heroes.map((o) => o.hp)).toEqual([40 + REACTION_TUNING.SOULFIRE_HEAL, 40 + REACTION_TUNING.SOULFIRE_HEAL, 40]);
  });

  it('Entomb (rime + umbra): enemies in the burst cannot move (bosses only briefly) and the hero gains a shield', () => {
    const r = react('rime', 'umbra');
    expect(r.def.id).toBe('entomb');
    expect(r.near.rootTime).toBe(REACTION_TUNING.ENTOMB_ROOT_SECONDS);
    expect(enemySpeed(r.near)).toBe(0);
    expect(enemySpeed(r.wide)).toBeGreaterThan(0);
    expect(r.near.stunTime).toBe(0);
    expect(r.h.tempShield).toBe(REACTION_TUNING.ENTOMB_SHIELD);
    stepN(r.w, seconds(REACTION_TUNING.ENTOMB_ROOT_SECONDS) + 2);
    expect(enemySpeed(r.near)).toBeGreaterThan(0);
    const s = arena('knight');
    give(s.h, 'infuse_umbra_primary');
    const boss = post(s.w, 0, 3, 'matron');
    mark(boss, 'rime');
    hit(s, boss, 10, 'primary');
    expect(boss.rootTime).toBe(REACTION_TUNING.ENTOMB_BOSS_ROOT_SECONDS);
  });

  it('Void Arc (storm + umbra): lightning leaps from the burst to VOIDARC_JUMPS further enemies, each within range of the last', () => {
    const s = arena('knight');
    give(s.h, 'infuse_umbra_primary');
    const target = post(s.w, -15, 0);
    place(s.w, 0, -15, -2);
    mark(target, 'storm');
    const step = REACTION_TUNING.VOIDARC_RANGE - 1;
    const chain = [1, 2, 3, 4].map((i) => post(s.w, -15 + i * step, 0));
    hit(s, target, 10, 'primary');
    const ev = s.w.drainEvents();
    const arcs = of(ev, 'cast').filter((c) => c.ability === 'voidarc');
    expect(arcs.map((c) => c.x)).toEqual(chain.slice(0, REACTION_TUNING.VOIDARC_JUMPS).map((e) => e.x));
    chain.forEach((e, i) => {
      const struck = i < REACTION_TUNING.VOIDARC_JUMPS;
      expect(100000 - e.hp).toBeCloseTo(struck ? REACTION_TUNING.VOIDARC_DAMAGE : 0, 6);
      expect(e.status).toBe(struck ? 'umbra' : null);
    });
  });

  it('duo boons: +{v}% burst damage and the reaction\'s own effect doubled', () => {
    const bonus = (id: ReactionId): number => val(`duo_${id}`);
    const shatter = react('ember', 'rime', ['duo_shatter']);
    expect(shatter.burst).toBeCloseTo(STATUS.RESONANCE.DAMAGE * shatter.def.damageMul * (1 + bonus('shatter')), 6);
    expect(shatter.near.stunTime).toBe(2 * REACTION_TUNING.SHATTER_STUN);
    const conf = react('storm', 'ember', ['duo_conflagration']);
    expect(conf.burst).toBeCloseTo(STATUS.RESONANCE.DAMAGE * (1 + bonus('conflagration')), 6);
    expect(conf.near.statusPotency).toBe(2 * REACTION_TUNING.CONFLAGRATION_BURN_POTENCY);
    const sup = react('storm', 'rime', ['duo_superconduct']);
    expect(sup.burst).toBeCloseTo(STATUS.RESONANCE.DAMAGE * (1 + bonus('superconduct')), 6);
    expect(hit(sup, sup.near)).toBeCloseTo(10 * (1 + 2 * REACTION_TUNING.SUNDER_VULNERABILITY), 6);
    const soul = arena('knight');
    give(soul.h, 'infuse_umbra_primary', 'duo_soulfire');
    soul.h.hp = 40;
    const t = post(soul.w, 0, 2);
    mark(t, 'ember');
    hit(soul, t, 10, 'primary');
    expect(soul.h.hp).toBe(40 + 2 * REACTION_TUNING.SOULFIRE_HEAL);
    const tomb = react('rime', 'umbra', ['duo_entomb']);
    expect(tomb.burst).toBeCloseTo(STATUS.RESONANCE.DAMAGE * tomb.def.damageMul * (1 + bonus('entomb')), 6);
    expect(tomb.near.rootTime).toBe(2 * REACTION_TUNING.ENTOMB_ROOT_SECONDS);
    expect(tomb.h.tempShield).toBe(2 * REACTION_TUNING.ENTOMB_SHIELD);
    const arc = arena('knight');
    give(arc.h, 'infuse_umbra_primary', 'duo_voidarc');
    const first = post(arc.w, -18, 0);
    mark(first, 'storm');
    const chain = Array.from({ length: 2 * REACTION_TUNING.VOIDARC_JUMPS + 1 }, (_, i) => post(arc.w, -18 + (i + 1) * 5, 0));
    hit(arc, first, 10, 'primary');
    expect(chain.filter((e) => e.hp < 100000)).toHaveLength(2 * REACTION_TUNING.VOIDARC_JUMPS);
    expect(100000 - chain[0]!.hp).toBeCloseTo(REACTION_TUNING.VOIDARC_DAMAGE * (1 + bonus('voidarc')), 6);
    // A duo boon does nothing for other reactions.
    const other = react('ember', 'rime', ['duo_voidarc']);
    expect(other.burst).toBeCloseTo(STATUS.RESONANCE.DAMAGE * other.def.damageMul, 6);
    expect(other.near.stunTime).toBe(REACTION_TUNING.SHATTER_STUN);
  });
});

describe('new boons: offense', () => {
  it('momentum: each hit in a row adds a stack (up to the maximum), lost after a pause', () => {
    const a = arena('knight');
    give(a.h, 'momentum');
    const foe = dummy(a.w, 0, 2);
    foe.hp = foe.maxHp = 1e9;
    const v = val('momentum');
    for (let i = 0; i < BOON_TUNING.MOMENTUM_MAX_STACKS + 3; i++) {
      // (first_blood style full-health effects are not in play: the dummy is damaged after the first hit.)
      expect(hit(a, foe), `hit ${i}`).toBeCloseTo(10 * (1 + v * Math.min(i, BOON_TUNING.MOMENTUM_MAX_STACKS)), 6);
    }
    stepN(a.w, seconds(BOON_TUNING.MOMENTUM_DECAY_SECONDS) - 3);
    expect(a.h.momentum).toBe(BOON_TUNING.MOMENTUM_MAX_STACKS);
    stepN(a.w, 6);
    expect(a.h.momentum).toBe(0);
    expect(hit(a, foe)).toBeCloseTo(10, 6);
  });

  it('giant_slayer: more damage to elites, champions and bosses only', () => {
    const a = arena('knight');
    give(a.h, 'giant_slayer');
    const v = val('giant_slayer');
    const plain = post(a.w, 0, 2);
    const elite = live(a.w, 'minion', 2, 2, { elite: true });
    elite.hp = elite.maxHp = 100000;
    const champion = post(a.w, 5, 5, 'champion');
    const boss = post(a.w, -6, 5, 'stalker');
    for (const e of [plain, elite, champion, boss]) e.hp -= 1;
    expect(hit(a, plain)).toBeCloseTo(10, 6);
    for (const e of [elite, champion, boss]) expect(hit(a, e)).toBeCloseTo(10 * (1 + v), 6);
  });

  it('overkill: slain enemies burst around them', () => {
    const a = arena('knight');
    give(a.h, 'overkill');
    const prey = dummy(a.w, 0, 2, 'minion', 5);
    const near = post(a.w, 0, 2 + BOON_TUNING.OVERKILL_RADIUS - 0.2);
    const far = post(a.w, 0, 2 + BOON_TUNING.OVERKILL_RADIUS + 1.5);
    hit(a, prey);
    expect(prey.dead).toBe(true);
    expect(100000 - near.hp).toBeCloseTo(val('overkill'), 6);
    expect(far.hp).toBe(100000);
    expect(of(a.w.drainEvents(), 'aoe')).toContainEqual({ e: 'aoe', x: 0, z: 2, r: BOON_TUNING.OVERKILL_RADIUS, el: null, hostile: false });
  });

  it('first_blood: only against enemies at full health; brutality: critical hits are stronger', () => {
    const a = arena('knight');
    give(a.h, 'first_blood');
    const foe = post(a.w, 0, 2);
    expect(hit(a, foe)).toBeCloseTo(10 * (1 + val('first_blood')), 6);
    expect(hit(a, foe)).toBeCloseTo(10, 6);
    const b = arena('shade');
    const target = post(b.w, 0, 2);
    target.hp -= 1;
    expect(hit(b, target, 10, 'secondary', 'crit')).toBeCloseTo(10 * STATUS.CRIT_MULTIPLIER, 6);
    give(b.h, 'brutality');
    expect(hit(b, target, 10, 'secondary', 'crit')).toBeCloseTo(10 * STATUS.CRIT_MULTIPLIER * (1 + val('brutality')), 6);
    expect(hit(b, target)).toBeCloseTo(10, 6);
  });
});

describe('new boons: defense and mobility', () => {
  it('thorns: enemies that hit in melee are hurt, ranged hits are not answered', () => {
    const a = arena('knight');
    give(a.h, 'thorns');
    const foe = post(a.w, 0, 2);
    expect(damageHero(a.w, a.h, 5, foe.id, true)).toBe(true);
    expect(100000 - foe.hp).toBeCloseTo(val('thorns'), 6);
    a.h.invuln = 0;
    damageHero(a.w, a.h, 5, foe.id, false);
    expect(100000 - foe.hp).toBeCloseTo(val('thorns'), 6);
    // A real melee attack counts as melee.
    const b = arena('knight');
    give(b.h, 'thorns');
    const minion = live(b.w, 'minion', 0, 1.2);
    for (let i = 0; i < seconds(2) && minion.hp === minion.maxHp; i++) b.pad.hold({}, 1);
    expect(minion.maxHp - minion.hp).toBeCloseTo(val('thorns'), 6);
  });

  it('stoneskin: less damage taken; mending: heals when a chamber is cleared', () => {
    const a = arena('knight');
    give(a.h, 'stoneskin');
    const hp = a.h.hp;
    damageHero(a.w, a.h, 50, -1);
    expect(hp - a.h.hp).toBeCloseTo(50 * (1 - val('stoneskin')), 6);

    const w = new World();
    w.addPlayer(0, 'knight', 'A');
    w.start(0, 4);
    const h = give(w.hero(0)!, 'mending');
    for (let i = 0; i < seconds(3); i++) w.step();
    h.hp = 20;
    clearChamber(w);
    expect(w.run.phase).toBe('draft');
    expect(h.hp).toBeCloseTo(20 + h.maxHp * val('mending'), 6);
  });

  it('crystal_ward: a shield whenever the hero triggers a Resonance', () => {
    const a = arena('knight');
    give(a.h, 'infuse_ember_primary', 'crystal_ward');
    const foe = post(a.w, 0, 2);
    mark(foe, 'storm');
    hit(a, foe, 10, 'primary');
    expect(a.h.tempShield).toBe(val('crystal_ward'));
  });

  it('slipstream: faster for a moment after a dash; afterimage: the dash cuts what it passes', () => {
    const a = arena('knight');
    give(a.h, 'slipstream', 'afterimage');
    const foe = dummy(a.w, 0.4, 2.5);
    a.pad.hold({ buttons: BTN.DASH, moveZ: 1 }, 1);
    a.pad.hold({ moveZ: 1 }, seconds(DASH.DURATION) + 1);
    expect(100000 - foe.hp).toBeCloseTo(val('afterimage'), 6);
    expect(foe.status).toBeNull();
    expect(a.w.getSelfState(0).moveSpeed).toBeCloseTo(CLASSES.knight.moveSpeed * (1 + val('slipstream')), 6);
    a.pad.hold({ moveZ: 1 }, seconds(BOON_TUNING.SLIPSTREAM_SECONDS) + 2);
    expect(a.w.getSelfState(0).moveSpeed).toBeCloseTo(CLASSES.knight.moveSpeed, 6);
    // With a dash infusion the two damages add up.
    const b = arena('knight');
    give(b.h, 'afterimage', 'infuse_rime_dash');
    const other = dummy(b.w, 0.4, 2.5);
    b.pad.hold({ buttons: BTN.DASH, moveZ: 1 }, 1);
    b.pad.hold({ moveZ: 1 }, seconds(DASH.DURATION) + 1);
    expect(100000 - other.hp).toBeCloseTo(val('afterimage') + SIM.DASH_INFUSION_DAMAGE, 6);
    expect(other.status).toBe('rime');
  });
});

describe('new boons: resonance, ultimate, kinship', () => {
  it('catalyst: every status lasts longer', () => {
    const base = arena('knight');
    const a = arena('knight');
    give(a.h, 'catalyst');
    const durations: Record<ElementId, number> = {
      ember: STATUS.BURN.DURATION, rime: STATUS.CHILL.DURATION, storm: STATUS.SHOCK.DURATION, umbra: STATUS.WITHER.DURATION,
    };
    for (const el of ELEMENT_IDS) {
      const plain = post(base.w, 0, 2);
      const longer = post(a.w, 0, 2);
      setStatus(base.w, plain, el, base.h, 1);
      setStatus(a.w, longer, el, a.h, 1);
      expect(plain.statusTime).toBeCloseTo(durations[el], 6);
      expect(longer.statusTime).toBeCloseTo(durations[el] * (1 + val('catalyst')), 6);
    }
  });

  it('chain_reaction: an enemy slain by a burst passes the new status to the nearest enemy outside it', () => {
    const a = arena('knight');
    give(a.h, 'infuse_rime_primary', 'chain_reaction');
    const target = post(a.w, 0, 2);
    const weak = dummy(a.w, 1.5, 2, 'minion', 3);
    const outside = post(a.w, 1.5 + SIM.SPREAD_RANGE - 1, 2);
    const beyond = post(a.w, -(SIM.SPREAD_RANGE + STATUS.RESONANCE.RADIUS + 4), 2);
    mark(target, 'storm');
    hit(a, target, 10, 'primary');
    expect(weak.dead).toBe(true);
    expect(outside.hp).toBe(100000);
    expect(outside.status).toBe('rime');
    expect(beyond.status).toBeNull();
    // Without the boon nothing is passed on.
    const b = arena('knight');
    give(b.h, 'infuse_rime_primary');
    const t2 = post(b.w, 0, 2);
    dummy(b.w, 1.5, 2, 'minion', 3);
    const o2 = post(b.w, 1.5 + SIM.SPREAD_RANGE - 1, 2);
    mark(t2, 'storm');
    hit(b, t2, 10, 'primary');
    expect(o2.status).toBeNull();
  });

  it('zealot: faster charge; encore: part of the charge stays; opening_act: every chamber starts with a minimum', () => {
    const a = arena('mage');
    give(a.h, 'zealot');
    const foe = post(a.w, 0, 8);
    hit(a, foe, 20, 'primary');
    expect(a.h.ult).toBeCloseTo(20 * ULTIMATE.PER_DAMAGE_DEALT * (1 + val('zealot')), 6);
    give(a.h, 'encore');
    use(a, BTN.ULTIMATE, 0.1, { aimDist: 8 });
    expect(a.h.ult).toBeCloseTo(ULTIMATE.MAX * val('encore'), 6);

    const w = new World();
    w.addPlayer(0, 'knight', 'A');
    w.start(0, 4);
    const h = give(w.hero(0)!, 'opening_act');
    clearChamber(w);
    h.ult = 3;
    draftAll(w);
    takeDoor(w, 0);
    expect(h.ult).toBe(ULTIMATE.MAX * val('opening_act'));
    // Never lowers a fuller bar.
    clearChamber(w);
    h.ult = 80;
    draftAll(w);
    takeDoor(w, 0);
    expect(h.ult).toBe(80);
  });

  it('crescendo: the ultimate hits harder and heals more; rally: the ultimate heals every hero', () => {
    const plain = arena('mage');
    const foe0 = post(plain.w, 0, 8);
    use(plain, BTN.ULTIMATE, CLASSES.mage.ultimate.windup + 0.1, { aimDist: 8 });
    const base = 100000 - foe0.hp;
    expect(base).toBeCloseTo(CLASSES.mage.ultimate.damage, 6);
    const a = arena('mage');
    give(a.h, 'crescendo');
    const foe = post(a.w, 0, 8);
    use(a, BTN.ULTIMATE, CLASSES.mage.ultimate.windup + 0.1, { aimDist: 8 });
    expect(100000 - foe.hp).toBeCloseTo(base * (1 + val('crescendo')), 6);
    // Primary attacks are unchanged.
    expect(hit(a, foe, 10, 'primary')).toBeCloseTo(10, 6);

    const w = party(['templar', 'mage']);
    place(w, 0, 0, 0);
    place(w, 1, 30, 0);
    const [templar, mage] = [w.hero(0)!, w.hero(1)!];
    give(templar, 'rally', 'crescendo');
    templar.hp = 30;
    mage.hp = 30;
    templar.ult = ULTIMATE.MAX;
    const pad = new Pad(w, 0);
    pad.hold({ buttons: BTN.ULTIMATE }, 1);
    const heal = val('rally') * (1 + val('crescendo'));
    // Everyone, wherever they stand, at the moment of the cast.
    expect(mage.hp).toBeCloseTo(30 + heal, 6);
    expect(templar.hp).toBeCloseTo(30 + heal, 6);
    // Sanctuary pulses heal more too (the far mage gets none of those).
    pad.hold({}, seconds(CLASSES.templar.ultimate.windup) + 2);
    expect(templar.hp).toBeCloseTo(30 + heal + CLASSES.templar.ultimate.heal * (1 + val('crescendo')), 6);
    expect(mage.hp).toBeCloseTo(30 + heal, 6);
  });

  it('covenant: when someone detonates a status you applied, both of you are shielded', () => {
    const w = party(['knight', 'mage']);
    const [knight, mage] = [w.hero(0)!, w.hero(1)!];
    give(knight, 'infuse_rime_primary', 'covenant');
    give(mage, 'infuse_storm_primary');
    const foe = post(w, 0, 2);
    hit({ w, h: knight }, foe, 10, 'primary');
    expect(foe.statusBy).toBe(0);
    hit({ w, h: mage }, foe, 10, 'primary');
    expect(w.getRunState().stats[1]!.resonances).toBe(1);
    expect(knight.tempShield).toBe(val('covenant'));
    expect(mage.tempShield).toBe(val('covenant'));
    // The other way round (the mage has no covenant) nobody is shielded.
    knight.tempShield = 0;
    mage.tempShield = 0;
    foe.resonanceCd = 0;
    expect(foe.status).toBe('storm');
    hit({ w, h: knight }, foe, 10, 'primary');
    expect(w.getRunState().stats[0]!.resonances).toBe(1);
    expect([knight.tempShield, mage.tempShield]).toEqual([0, 0]);
  });
});

describe('class boons', () => {
  type Check = [boon: string, cls: ClassId, art: number, read: (h: Hero) => number, expected: (base: number, v: number) => number];
  const mul = (base: number, v: number): number => base * (1 + v);
  const add = (base: number, v: number): number => base + v;
  const checks: Check[] = [
    ['knight_aegis', 'knight', 0, (h) => h.abil.secondary.selfShield, add],
    ['knight_aegis', 'knight', 1, (h) => h.abil.secondary.selfShield, add],
    ['knight_cleave', 'knight', 0, (h) => h.abil.primary[2]!.arc, mul],
    ['barb_fury', 'barbarian', 0, (h) => h.abil.secondary.duration, mul],
    ['barb_fury', 'barbarian', 1, (h) => h.abil.secondary.stun, mul],
    ['barb_reach', 'barbarian', 0, (h) => h.abil.primary[1]!.range, mul],
    ['mage_split', 'mage', 0, (h) => h.abil.primary[0]!.count, add],
    ['mage_expanse', 'mage', 0, (h) => h.abil.secondary.radius, mul],
    ['mage_expanse', 'mage', 1, (h) => h.abil.secondary.radius, mul],
    ['rogue_pierce', 'rogue', 0, (h) => h.abil.primary[0]!.pierce, add],
    ['rogue_fan', 'rogue', 0, (h) => h.abil.secondary.count, add],
    ['rogue_fan', 'rogue', 1, (h) => h.abil.secondary.damage, (base) => base * (1 + BOON_TUNING.ROGUE_FAN_TRAP_BONUS)],
    ['templar_grace', 'templar', 0, (h) => h.abil.secondary.heal, mul],
    ['templar_weight', 'templar', 0, (h) => h.abil.primary[0]!.knockback, add],
    ['spell_surge', 'spellblade', 0, (h) => h.abil.primary[2]!.pierce, add],
    ['spell_flux', 'spellblade', 0, (h) => h.abil.secondary.cooldown, mul],
    ['spell_flux', 'spellblade', 1, (h) => h.abil.secondary.cooldown, mul],
    ['shade_venom', 'shade', 0, (h) => h.abil.primary[0]!.damage, mul],
    ['shade_reach', 'shade', 0, (h) => h.abil.secondary.range, mul],
    ['shade_reach', 'shade', 1, (h) => h.abil.secondary.radius, mul],
  ];

  it('two per class, each changes the documented ability field (also on the art where its text says so)', () => {
    const classBoons = BOONS.filter((b) => b.category === 'class');
    expect(classBoons).toHaveLength(2 * CLASS_IDS.length);
    for (const cls of CLASS_IDS) expect(classBoons.filter((b) => b.cls === cls)).toHaveLength(2);
    expect(new Set(checks.map((c) => c[0]))).toEqual(new Set(classBoons.map((b) => b.id)));
    for (const [boon, cls, art, read, expected] of checks) {
      const a = arena(cls, art ? { mastery: 2, art } : undefined);
      const base = read(a.h);
      // The mastery-2 hero has no area bonus, so `base` is the table value.
      give(a.h, boon);
      expect(read(a.h), `${boon} on art ${art}`).toBeCloseTo(expected(base, val(boon)), 6);
      give(a.h, boon);
      if (boon !== 'rogue_fan' || art === 0) expect(read(a.h), `${boon} level 2`).toBeCloseTo(expected(base, val(boon, 2)), 6);
      else expect(read(a.h)).toBeCloseTo(base * (1 + 2 * BOON_TUNING.ROGUE_FAN_TRAP_BONUS), 6);
      // The class table itself is never modified.
      expect(read(arena(cls, art ? { mastery: 2, art } : undefined).h)).toBe(base);
    }
  });

  it('they work in play: split bolts fan out, a wider cleave reaches the flank, a faster blink recharges sooner', () => {
    const a = arena('mage');
    give(a.h, 'mage_split', 'mage_split');
    a.pad.hold({ buttons: BTN.PRIMARY, aim: 0 }, 1);
    a.pad.hold({ aim: 0 }, seconds(CLASSES.mage.primary[0]!.windup) + 1);
    const bolts = a.w.projectiles;
    expect(bolts).toHaveLength(3);
    expect(new Set(bolts.map((p) => p.rot.toFixed(4))).size).toBe(3);
    expect(bolts[1]!.rot).toBeCloseTo(0, 6);

    const side = (boons: string[]): number => {
      const k = arena('knight');
      give(k.h, ...boons);
      // 75 degrees off the aim: outside the 110 degree slash (even with the enemy's own width), inside one that is 25 % wider.
      const foe = dummy(k.w, Math.sin(1.31) * 2, Math.cos(1.31) * 2);
      use(k, BTN.PRIMARY, 0.3);
      return 100000 - foe.hp;
    };
    expect(side([])).toBe(0);
    expect(side(['knight_cleave'])).toBeCloseTo(CLASSES.knight.primary[0]!.damage, 6);

    const s = arena('spellblade');
    give(s.h, 'spell_flux');
    s.pad.hold({ buttons: BTN.SECONDARY, aim: 0 }, 1);
    expect(s.h.secondaryCdMax).toBeCloseTo(CLASSES.spellblade.secondary.cooldown * (1 + val('spell_flux')), 6);
  });
});

describe('draft rules', () => {
  const offers = (h: Hero, seed: number, opts = { choices: 3, guaranteeRare: false, guaranteeInfusion: false }): string[] =>
    generateDraft(new Rng(seed), h, opts).map((o) => o.id);
  const everOffered = (h: Hero, n = 400): Set<string> => {
    const seen = new Set<string>();
    for (let seed = 1; seed <= n; seed++) for (const id of offers(h, seed)) seen.add(id);
    return seen;
  };

  it('class boons are only offered to their class, and only when they change the equipped abilities', () => {
    for (const cls of CLASS_IDS) {
      const seen = everOffered(arena(cls).h);
      const classIds = [...seen].filter((id) => BOON_BY_ID.get(id)!.category === 'class');
      expect(classIds.length).toBeGreaterThan(0);
      for (const id of classIds) expect(BOON_BY_ID.get(id)!.cls).toBe(cls);
    }
    // templar_grace heals more: useless with Judgement (a leap) equipped, so it is not offered then.
    expect(isOfferable(arena('templar').h, BOON_BY_ID.get('templar_grace')!)).toBe(true);
    expect(isOfferable(arena('templar', mastered({ art: 1 })).h, BOON_BY_ID.get('templar_grace')!)).toBe(false);
    expect(isOfferable(arena('knight').h, BOON_BY_ID.get('templar_grace')!)).toBe(false);
  });

  it('duo boons need infusions of both elements of their reaction; legendaries are rare', () => {
    const a = arena('knight');
    const duos = BOONS.filter((b) => b.category === 'duo');
    expect(duos).toHaveLength(REACTIONS.length);
    expect(duos.every((b) => b.rarity === 'legendary')).toBe(true);
    for (const b of duos) expect(isOfferable(a.h, b)).toBe(false);
    give(a.h, 'infuse_ember_primary');
    for (const b of duos) expect(isOfferable(a.h, b)).toBe(false);
    give(a.h, 'infuse_umbra_ultimate');
    expect(duos.filter((b) => isOfferable(a.h, b)).map((b) => b.id)).toEqual(['duo_soulfire']);
    let legendary = 0;
    const n = 600;
    for (let seed = 1; seed <= n; seed++) if (offers(a.h, seed).includes('duo_soulfire')) legendary++;
    expect(legendary).toBeGreaterThan(0);
    // One eligible legendary among dozens of boons: far rarer than a common boon of weight 60.
    let common = 0;
    for (let seed = 1; seed <= n; seed++) if (offers(a.h, seed).includes('keen_edge')) common++;
    expect(legendary).toBeLessThan(common / 3);
    expect(BOON_TUNING.WEIGHTS.legendary).toBeLessThan(BOON_TUNING.WEIGHTS.epic);
  });

  it('umbra and ultimate infusions are in the pool; a cursed draft still guarantees rare or better', () => {
    const seen = everOffered(arena('rogue').h);
    for (const id of ['infuse_umbra_primary', 'infuse_umbra_dash', 'infuse_storm_ultimate', 'infuse_umbra_ultimate']) expect(seen.has(id), id).toBe(true);
    expect(seen.has('creeping_dark')).toBe(false);
    const h = arena('rogue').h;
    for (let seed = 1; seed <= 200; seed++) {
      const ids = offers(h, seed, { choices: BOON_TUNING.CURSED_DRAFT_CHOICES, guaranteeRare: true, guaranteeInfusion: false });
      expect(ids).toHaveLength(BOON_TUNING.CURSED_DRAFT_CHOICES);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.some((id) => BOON_BY_ID.get(id)!.rarity !== 'common')).toBe(true);
    }
  });

  it('foresight adds a choice to every draft; the hourglass relic lengthens the timer for the party and adds a reroll', () => {
    const w = new World();
    w.addPlayer(0, 'knight', 'A', { meta: metaLevels({ foresight: 1, reliquary: 1 }), relics: [{ id: 'hourglass', rank: 1 }] });
    w.addPlayer(1, 'mage', 'B');
    w.start(0, 7);
    expect(w.getRerolls(0)).toBe(1);
    expect(w.getRerolls(1)).toBe(0);
    clearChamber(w);
    expect(w.getDraft(0)).toHaveLength(RUN.DRAFT_CHOICES + 1);
    expect(w.getDraft(1)).toHaveLength(RUN.DRAFT_CHOICES);
    expect(w.run.draftTime).toBeCloseTo(RUN.DRAFT_TIMEOUT_SECONDS + RELIC_TUNING.HOURGLASS_SECONDS, 1);
    expect(w.rerollDraft(0)).toBe(true);
    expect(w.getDraft(0)).toHaveLength(RUN.DRAFT_CHOICES + 1);
    expect(w.rerollDraft(0)).toBe(false);
    // Without the relic the timer is the plain one.
    const v = new World();
    v.addPlayer(0, 'knight', 'A');
    v.start(0, 7);
    clearChamber(v);
    expect(v.run.draftTime).toBeCloseTo(RUN.DRAFT_TIMEOUT_SECONDS, 1);
  });
});

describe('set bonuses', () => {
  const POOL: Record<string, string[]> = {
    set_ember: ['infuse_ember_primary', 'infuse_ember_secondary', 'infuse_ember_dash', 'wildfire'],
    set_rime: ['infuse_rime_primary', 'infuse_rime_secondary', 'infuse_rime_dash', 'deep_frost'],
    set_storm: ['infuse_storm_primary', 'infuse_storm_secondary', 'infuse_storm_dash', 'overcharge'],
    set_umbra: ['infuse_umbra_primary', 'infuse_umbra_secondary', 'infuse_umbra_ultimate', 'creeping_dark'],
    set_offense: ['keen_edge', 'heavy_hand', 'executioner', 'giant_slayer', 'first_blood'],
    set_defense: ['barrier', 'leech', 'last_stand', 'thorns', 'mending'],
    set_mobility: ['quick_step', 'quick_wits', 'slipstream', 'afterimage', 'fleet_foot'],
    set_resonance: ['amplifier', 'wide_resonance', 'aftershock', 'echo'],
    set_ultimate: ['crescendo', 'encore', 'opening_act'],
    set_kinship: ['kindred_flame', 'shared_vigor', 'lifeline', 'oathbond'],
  };

  it('every set: tier 1 and tier 2 switch on at their boon counts, announce themselves and add exactly their mods', () => {
    expect(SETS.map((s) => s.id).sort()).toEqual(Object.keys(POOL).sort());
    for (const set of SETS) {
      const a = arena('knight');
      const ids = POOL[set.id]!;
      expect(ids.length).toBeGreaterThanOrEqual(set.need[1]);
      const raised: [string, number][] = [];
      const before = { ...a.h.mods };
      ids.forEach((id, i) => {
        const count = i + 1;
        expect(applyBoon(a.h, id, (sid, tier) => raised.push([sid, tier]))).toBe(1);
        const tier = count >= set.need[1] ? 2 : count >= set.need[0] ? 1 : 0;
        const own = setProgress(a.h.boons).find((p) => p.set.id === set.id)!;
        expect([own.count, own.tier], `${set.id} after ${count}`).toEqual([count, tier]);
        // Mods: exactly the tiers that are active (fleet_foot etc. are boon stats, not mods).
        for (const key of Object.keys(before) as (keyof typeof before)[]) {
          let want = before[key];
          for (let t = 0; t < tier; t++) want += set.tiers[t]!.mods?.[key] ?? 0;
          expect(a.h.mods[key], `${set.id} ${key} after ${count}`).toBeCloseTo(want, 9);
        }
      });
      expect(raised.filter((r) => r[0] === set.id)).toEqual([[set.id, 1], [set.id, 2]]);
      const specials = set.tiers[1].special;
      expect(a.h.setSpread).toEqual(specials === 'spread' ? [set.element] : []);
      expect(a.h.setOverflow).toBe(specials === 'overflow');
      expect(a.h.setBond).toBe(specials === 'bond');
    }
  });

  it('the `set` event is sent when a draft pick completes a tier', () => {
    const w = new World();
    w.addPlayer(0, 'knight', 'A');
    w.start(0, 3);
    const h = give(w.hero(0)!, 'infuse_ember_primary');
    clearChamber(w);
    w.drainEvents();
    h.draft = [{ id: 'wildfire', level: 1 }];
    expect(w.pickBoon(0, 0)).toBe(true);
    expect(of(w.drainEvents(), 'set')).toEqual([{ e: 'set', slot: 0, id: 'set_ember', tier: 1 }]);
  });

  it('the mods do something: defense adds health, mobility a dash charge, ultimate set damage, offense crits', () => {
    const d = arena('knight');
    const hp = d.h.maxHp;
    give(d.h, ...POOL.set_defense!.slice(0, 3));
    expect(d.h.maxHp).toBe(hp + SETS.find((s) => s.id === 'set_defense')!.tiers[0].mods!.maxHp!);
    expect(d.h.hp).toBe(d.h.maxHp);
    give(d.h, ...POOL.set_defense!.slice(3));
    d.h.barrier = 0;
    const before = d.h.hp;
    damageHero(d.w, d.h, 40, -1);
    expect(before - d.h.hp).toBeCloseTo(40 * (1 - 0.15), 6);

    const m = arena('knight');
    give(m.h, ...POOL.set_mobility!);
    expect(m.w.getSnapshotBody().players[0]!.dashCharges).toBe(CLASSES.knight.dashCharges + 1);

    const u = arena('mage');
    give(u.h, ...POOL.set_ultimate!);
    const foe = post(u.w, 0, 8);
    use(u, BTN.ULTIMATE, CLASSES.mage.ultimate.windup + 0.1, { aimDist: 8 });
    expect(100000 - foe.hp).toBeCloseTo(CLASSES.mage.ultimate.damage * (1 + val('crescendo') + 0.4), 6);

    const o = arena('knight');
    give(o.h, ...POOL.set_offense!);
    expect(o.h.mods.critChance).toBeCloseTo(0.15, 9);
    const target = post(o.w, 0, 2);
    target.hp -= 1;
    let crits = 0;
    for (let i = 0; i < 400; i++) { hit(o, target, 1); if (of(o.w.drainEvents(), 'hit').pop()!.crit) crits++; }
    expect(crits).toBeGreaterThan(30);
    expect(crits).toBeLessThan(100);
  });

  it('special `spread`: the status of a dying carrier jumps to the nearest enemy without one', () => {
    const a = arena('knight');
    give(a.h, ...POOL.set_ember!);
    const carrier = dummy(a.w, 0, 2, 'minion', 500);
    const next = post(a.w, 3, 2);
    const taken = post(a.w, 1, 2);
    mark(taken, 'storm');
    const far = post(a.w, 0, 2 + SIM.SPREAD_RANGE + 2);
    setStatus(a.w, carrier, 'ember', a.h, 1);
    killEnemy(a.w, carrier, 0);
    expect(next.status).toBe('ember');
    expect(next.statusBy).toBe(0);
    expect(taken.status).toBe('storm');
    expect(far.status).toBeNull();
    // Only this set's element spreads.
    const other = dummy(a.w, 0, -3, 'minion', 500);
    const beside = post(a.w, 1, -3);
    setStatus(a.w, other, 'rime', a.h, 1);
    killEnemy(a.w, other, 0);
    expect(beside.status).toBeNull();
  });

  it('special `overflow`: every Resonance charges 10 % of the ultimate; special `bond`: revives come with 3 s of invulnerability', () => {
    const a = arena('knight');
    give(a.h, ...POOL.set_resonance!, 'infuse_ember_primary');
    a.h.stats.echo = 0;
    const foe = post(a.w, 0, 2);
    mark(foe, 'storm');
    hit(a, foe, 10, 'primary');
    // (The marked enemy is Shocked, so the hit itself deals 20 % more.)
    expect(a.h.ult).toBeCloseTo(10 * (1 + STATUS.SHOCK.VULNERABILITY) * ULTIMATE.PER_DAMAGE_DEALT + ULTIMATE.PER_RESONANCE + ULTIMATE.MAX * BOON_TUNING.SET_OVERFLOW_CHARGE, 6);

    const w = party(['knight', 'mage', 'rogue']);
    const [knight, mage, rogue] = [w.hero(0)!, w.hero(1)!, w.hero(2)!];
    give(knight, ...POOL.set_kinship!);
    // Revived by the owner, and the owner revived by anyone.
    downHero(w, mage);
    reviveHero(w, mage, 0, WORLD.REVIVE_HP_FRACTION, SIM.REVIVE_IFRAMES);
    expect(mage.invuln).toBe(BOON_TUNING.SET_BOND_INVULNERABILITY);
    downHero(w, knight);
    reviveHero(w, knight, 2, WORLD.REVIVE_HP_FRACTION, SIM.REVIVE_IFRAMES);
    expect(knight.invuln).toBe(BOON_TUNING.SET_BOND_INVULNERABILITY);
    downHero(w, mage);
    reviveHero(w, mage, 2, WORLD.REVIVE_HP_FRACTION, SIM.REVIVE_IFRAMES);
    expect(mage.invuln).toBe(SIM.REVIVE_IFRAMES);
    void rogue;
  });
});

export type { Arena };
