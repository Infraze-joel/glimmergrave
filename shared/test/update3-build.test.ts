/** Update 3: the Mods pipeline — Armory, Ascension, mastery, talents, relics — and the clamping of loadouts inside the sim. */
import { describe, expect, it } from 'vitest';
import { WORLD } from '@shared/constants.ts';
import { CLASSES, ULTIMATE } from '@shared/data/classes.ts';
import { STATUS } from '@shared/data/enemies.ts';
import { MASTERY, TALENTS, masteryMods } from '@shared/data/mastery.ts';
import { META_INDEX, META_UPGRADES, PARAGON, PARAGON_TUNING, paragonEffective } from '@shared/data/meta.ts';
import { MODS_CAPS, MOD_KEYS, ZERO_MODS, type Mods } from '@shared/data/mods.ts';
import { RELICS, RELIC_TUNING, rankScale } from '@shared/data/relics.ts';
import { damageHero, downHero, enemyDamage, setStatus, strikeEnemy } from '@shared/sim/combat.ts';
import { enemySpeed } from '@shared/sim/enemies.ts';
import { maxBuild, maxMetaLevels, META, SIM, TALENT, World, type Enemy, type Hero } from '@shared/sim/index.ts';
import { BTN, CLASS_IDS, type AbilitySlot } from '@shared/types.ts';
import { dummy, live, Pad, place, seconds, stepN } from './harness.ts';
import { arena, give, metaLevels, of, paragonRanks, party, use } from './u3kit.ts';

const meta = (id: string) => META_UPGRADES[META_INDEX.get(id)!]!;
const hit = (a: { w: World; h: Hero }, e: Enemy, base = 10, slot: AbilitySlot = 'dash'): number => {
  const before = e.hp;
  strikeEnemy(a.w, a.h, e, base, slot, { fromX: a.h.body.x, fromZ: a.h.body.z, stun: 0, knockback: 0 });
  return before - e.hp;
};
const post = (w: World, x: number, z: number): Enemy => {
  const e = live(w, 'minion', x, z);
  e.passive = true;
  e.hp = e.maxHp = 100000;
  return e;
};
const expectMods = (actual: Mods, want: Partial<Mods>, label: string): void => {
  for (const key of MOD_KEYS) expect(actual[key], `${label}: ${key}`).toBeCloseTo(want[key] ?? 0, 9);
};
const TALENT_SLOT = 3;
const withRelic = (id: string, rank = 1): unknown => ({ relics: [{ id, rank }] });

describe('Armory: the nine new upgrades', () => {
  it('ferocity, tempo, zeal, salvage, scholar are plain mods at every level', () => {
    const map: Record<string, keyof Mods> = { ferocity: 'critChance', tempo: 'attackSpeed', zeal: 'ultCharge', salvage: 'relicFind', scholar: 'xp' };
    for (const [id, key] of Object.entries(map)) {
      meta(id).values.forEach((v, i) => expectMods(arena('knight', metaLevels({ [id]: i + 1 })).h.mods, { [key]: v }, `${id} ${i + 1}`));
    }
    expectMods(arena('knight').h.mods, {}, 'fresh');
  });

  it('tempo makes primary attacks faster; zeal charges the ultimate faster; ferocity crits', () => {
    const v = meta('tempo').values.at(-1)!;
    const a = arena('knight', metaLevels({ tempo: 3 }));
    a.pad.hold({ buttons: BTN.PRIMARY }, 1);
    expect(a.h.primaryCd + SIM.EPS).toBeCloseTo(CLASSES.knight.primary[0]!.cooldown / (1 + v) - 1 / 30, 5);
    const z = arena('knight', metaLevels({ zeal: 3 }));
    hit(z, post(z.w, 0, 2));
    expect(z.h.ult).toBeCloseTo(10 * ULTIMATE.PER_DAMAGE_DEALT * (1 + meta('zeal').values.at(-1)!), 6);
    const f = arena('knight', metaLevels({ ferocity: 5 }));
    const foe = post(f.w, 0, 2);
    let crits = 0;
    for (let i = 0; i < 1000; i++) { hit(f, foe, 1); if (of(f.w.drainEvents(), 'hit').pop()!.crit) crits++; }
    expect(crits).toBeGreaterThan(60);
    expect(crits).toBeLessThan(150);
  });

  it('warding: every chamber begins with the shield; tenacity: a second Second Wind alone, faster revives in a party', () => {
    const v = meta('warding').values.at(-1)!;
    const w = new World();
    w.addPlayer(0, 'knight', 'A', metaLevels({ warding: 3, tenacity: 1 }));
    w.start(0, 3);
    expect(w.hero(0)!.tempShield).toBe(v);
    expect(w.getSnapshotBody().players[0]!.shield).toBe(v);
    // It does not fade like an ability shield.
    for (let i = 0; i < seconds(SIM.TEMP_SHIELD_SECONDS + 2); i++) { w.hero(0)!.invuln = 1; w.step(); }
    expect(w.hero(0)!.tempShield).toBe(v);
    expect(w.getRunState().secondWinds).toBe(1 + META.TENACITY_SECOND_WINDS);
    const plain = new World();
    plain.addPlayer(0, 'knight', 'A');
    plain.start(0, 3);
    expect(plain.getRunState().secondWinds).toBe(1);
    expect(plain.hero(0)!.tempShield).toBe(0);

    const time = (tenacity: number): number => {
      const p = party(['knight', 'mage'], [undefined, metaLevels({ tenacity })]);
      place(p, 0, 0, 0);
      place(p, 1, 1, 0);
      downHero(p, p.hero(1)!);
      let ticks = 0;
      while (p.hero(1)!.state === 'downed' && ticks < 500) { p.step(); ticks++; }
      return ticks;
    };
    expect(time(0)).toBe(seconds(WORLD.REVIVE_SECONDS));
    expect(time(1)).toBe(Math.ceil(seconds(WORLD.REVIVE_SECONDS) / (1 + META.TENACITY_REVIVE)));
  });

  it('vitality and might have eight levels; the old upgrades still work through the same pipeline', () => {
    expect(meta('vitality').values).toHaveLength(8);
    expect(meta('might').values).toHaveLength(8);
    const a = arena('knight', maxMetaLevels());
    expect(a.h.maxHp).toBe(CLASSES.knight.maxHp + meta('vitality').values.at(-1)!);
    expect(a.h.mods.damage).toBeCloseTo(meta('might').values.at(-1)!, 9);
    expect(a.h.mods.glimmer).toBeCloseTo(meta('fortune').values.at(-1)!, 9);
    expect(a.h.meta).toMatchObject({ attunement: true, foresight: 1, tenacity: true, rerolls: 3 });
  });
});

describe('Ascension', () => {
  it('every stat adds its mods once per effective rank; ranks past SOFT_RANK count less and less', () => {
    expect(paragonEffective(10)).toBe(10);
    expect(paragonEffective(PARAGON_TUNING.SOFT_RANK)).toBe(PARAGON_TUNING.SOFT_RANK);
    expect(paragonEffective(PARAGON_TUNING.SOFT_RANK + 100)).toBeCloseTo(PARAGON_TUNING.SOFT_RANK + 20, 9);
    for (const def of PARAGON) {
      for (const rank of [1, 10, 25, 125]) {
        const want: Partial<Mods> = {};
        for (const key of MOD_KEYS) if (def.mods[key] !== undefined) want[key] = Math.min(MODS_CAPS[key] ?? Infinity, def.mods[key]! * paragonEffective(rank));
        expectMods(arena('knight', { paragon: paragonRanks({ [def.id]: rank }) }).h.mods, want, `${def.id} rank ${rank}`);
      }
    }
  });

  it('applies in play (damage, health) and endless ranks cannot break the caps', () => {
    const a = arena('knight', { paragon: paragonRanks({ asc_might: 20, asc_vitality: 20 }) });
    expect(a.h.maxHp).toBe(CLASSES.knight.maxHp + 40);
    expect(hit(a, post(a.w, 0, 2))).toBeCloseTo(10 * 1.2, 6);
    const top = arena('knight', { paragon: PARAGON.map(() => 1e9) });
    expect(top.h.build.paragon).toEqual(PARAGON.map(() => PARAGON_TUNING.MAX_RANK));
    for (const key of MOD_KEYS) {
      const cap = MODS_CAPS[key];
      if (cap !== undefined) expect(top.h.mods[key], key).toBeLessThanOrEqual(cap);
    }
    expect(top.h.mods.critChance).toBeLessThanOrEqual(0.75);
  });
});

describe('class mastery', () => {
  it('every level adds the small class bonus (full up to SOFT_LEVEL, a quarter beyond) and it reaches the hero', () => {
    expectMods(masteryMods(1), {}, 'level 1');
    expectMods(masteryMods(11), { damage: 10 * MASTERY.PER_LEVEL.damage!, maxHp: 10 * MASTERY.PER_LEVEL.maxHp! }, 'level 11');
    const beyond = MASTERY.SOFT_LEVEL - 1 + 20 * MASTERY.BEYOND_SOFT;
    expectMods(masteryMods(MASTERY.SOFT_LEVEL + 20), { damage: beyond * MASTERY.PER_LEVEL.damage!, maxHp: beyond * MASTERY.PER_LEVEL.maxHp! }, 'beyond soft');
    for (const cls of CLASS_IDS) {
      const a = arena(cls, { mastery: 11 });
      expectMods(a.h.mods, masteryMods(11), cls);
      expect(a.h.maxHp).toBe(CLASSES[cls].maxHp + 10);
    }
  });
});

describe('talents', () => {
  it('42 talents: three tiers of two per class; every plain talent adds exactly its mods on top of the mastery bonus', () => {
    expect(TALENTS).toHaveLength(CLASS_IDS.length * 6);
    const level = MASTERY.TALENT_LEVELS[2]!;
    const base = masteryMods(level);
    for (const t of TALENTS) {
      const talents = [0, 0, 0];
      talents[t.tier] = t.option;
      const a = arena(t.cls, { mastery: level, talents });
      const want: Partial<Mods> = { ...base };
      for (const key of MOD_KEYS) want[key] = (base[key] ?? 0) + (t.mods?.[key] ?? 0);
      expectMods(a.h.mods, want, t.id);
      const flags = Object.entries(a.h.talent).filter(([, on]) => on).map(([k]) => k);
      expect(flags, t.id).toHaveLength(t.special ? 1 : 0);
      // Another class gets nothing from that choice; too little mastery neither.
      expect(arena(t.cls, { mastery: MASTERY.TALENT_LEVELS[t.tier]! - 1, talents }).h.build.talents[t.tier]).toBe(0);
    }
    expect(TALENTS.filter((t) => t.special).map((t) => t.special).sort()).toEqual(['ambush', 'arcane_echo', 'martyr', 'poison_tips', 'rampage', 'riposte', 'spellweave']);
  });

  const special = (cls: Parameters<typeof arena>[0], extra: Record<string, unknown> = {}) => arena(cls, { mastery: 6, talents: [0, 1, 0], ...extra });

  it('riposte (knight): after a shield absorbs damage the next primary hit deals double, once', () => {
    const a = special('knight');
    expect(a.h.talent.riposte).toBe(true);
    const foe = post(a.w, 0, 2);
    const base = hit(a, foe, 10, 'primary');
    a.h.tempShield = 10;
    damageHero(a.w, a.h, 4, -1);
    expect(a.h.riposte).toBe(true);
    // Only a primary hit uses it up.
    expect(hit(a, foe, 10, 'secondary')).toBeCloseTo(base, 6);
    expect(hit(a, foe, 10, 'primary')).toBeCloseTo(base * TALENT.RIPOSTE_MULTIPLIER, 6);
    expect(hit(a, foe, 10, 'primary')).toBeCloseTo(base, 6);
    // Damage that no shield took does not arm it.
    a.h.tempShield = 0;
    a.h.invuln = 0;
    damageHero(a.w, a.h, 4, -1);
    expect(a.h.riposte).toBe(false);
  });

  it('rampage (barbarian): each kill adds attack speed for a few seconds, up to the stack limit', () => {
    const a = special('barbarian');
    for (let i = 1; i <= TALENT.RAMPAGE_MAX_STACKS + 2; i++) {
      hit(a, dummy(a.w, 0, 2, 'minion', 1));
      expect(a.h.rampage).toBe(Math.min(i, TALENT.RAMPAGE_MAX_STACKS));
    }
    a.h.primaryCd = 0;
    a.pad.hold({ buttons: BTN.PRIMARY }, 1);
    const speed = 1 + TALENT.RAMPAGE_MAX_STACKS * TALENT.RAMPAGE_ATTACK_SPEED;
    expect(a.h.primaryCd).toBeCloseTo(CLASSES.barbarian.primary[0]!.cooldown / speed - 1 / 30, 5);
    a.pad.hold({}, seconds(TALENT.RAMPAGE_SECONDS) + 2);
    expect(a.h.rampage).toBe(0);
  });

  it('arcane_echo (mage): every 4th arc bolt is fired twice', () => {
    const count = (talented: boolean): [casts: number, hits: number] => {
      const a = talented ? special('mage') : arena('mage', { mastery: 6 });
      const foe = dummy(a.w, 0, 4);
      const ev = a.pad.hold({ buttons: BTN.PRIMARY, aim: 0 }, seconds(CLASSES.mage.primary[0]!.cooldown * 8 + 0.2));
      ev.push(...a.pad.hold({ aim: 0 }, seconds(0.5)));
      return [of(ev, 'cast').filter((c) => c.ability === 'mage_bolt').length, of(ev, 'hit').filter((x) => x.target.t === 'e' && x.target.id === foe.id).length];
    };
    const [plainCasts, plainHits] = count(false);
    expect(plainCasts).toBeGreaterThanOrEqual(2 * TALENT.ARCANE_ECHO_EVERY);
    expect(plainHits).toBe(plainCasts);
    const [casts, hits] = count(true);
    expect(casts).toBe(plainCasts);
    expect(hits).toBe(casts + Math.floor(casts / TALENT.ARCANE_ECHO_EVERY));
  });

  it('poison_tips (rogue): bolts and knives wither enemies that carry no other status; they never detonate anything', () => {
    for (const buttons of [BTN.PRIMARY, BTN.SECONDARY]) {
      const a = special('rogue');
      const foe = dummy(a.w, 0, 4);
      const marked = dummy(a.w, 0.2, 5.5);
      marked.status = 'ember';
      marked.statusTime = 9;
      a.h.abil.primary[0]!.pierce = 5;
      const ev = use(a, buttons, 0.5);
      expect(foe.status).toBe('umbra');
      expect(foe.statusTime).toBeGreaterThan(STATUS.WITHER.DURATION * TALENT.POISON_POTENCY - 0.6);
      expect(foe.statusTime).toBeLessThanOrEqual(STATUS.WITHER.DURATION * TALENT.POISON_POTENCY);
      expect(marked.hp).toBeLessThan(100000);
      expect(marked.status).toBe('ember');
      expect(of(ev, 'resonance')).toHaveLength(0);
    }
    const plain = arena('rogue', { mastery: 6 });
    const foe = dummy(plain.w, 0, 4);
    use(plain, BTN.PRIMARY, 0.5);
    expect(foe.hp).toBeLessThan(100000);
    expect(foe.status).toBeNull();
  });

  it('martyr (templar): heroes on the hallowed ground take 20 % less, the templar takes that share', () => {
    const w = party(['templar', 'mage'], [{ mastery: 6, talents: [0, 1, 0] }]);
    place(w, 0, 0, 0);
    place(w, 1, 2, 0);
    const [templar, mage] = [w.hero(0)!, w.hero(1)!];
    const pad = new Pad(w, 0);
    pad.hold({ buttons: BTN.SECONDARY }, 1);
    pad.hold({}, seconds(CLASSES.templar.secondary.windup) + 1);
    expect(w.zones).toHaveLength(1);
    const hp = [templar.hp, mage.hp];
    expect(damageHero(w, mage, 40, -1)).toBe(true);
    expect(hp[1]! - mage.hp).toBeCloseTo(40 * (1 - TALENT.MARTYR_SHARE), 6);
    expect(hp[0]! - templar.hp).toBeCloseTo(40 * TALENT.MARTYR_SHARE, 6);
    // The templar's own hits are not shared with anyone; outside the ground there is no sharing.
    templar.invuln = 0;
    const own = templar.hp;
    damageHero(w, templar, 10, -1);
    expect(own - templar.hp).toBeCloseTo(10, 6);
    place(w, 1, CLASSES.templar.secondary.radius + 3, 0);
    mage.invuln = 0;
    const far = mage.hp;
    damageHero(w, mage, 40, -1);
    expect(far - mage.hp).toBeCloseTo(40, 6);
    // Without the talent the ground shares nothing.
    const v = party(['templar', 'mage']);
    place(v, 0, 0, 0);
    place(v, 1, 2, 0);
    const p2 = new Pad(v, 0);
    p2.hold({ buttons: BTN.SECONDARY }, 1);
    p2.hold({}, seconds(CLASSES.templar.secondary.windup) + 1);
    const before = v.hero(1)!.hp;
    damageHero(v, v.hero(1)!, 40, -1);
    expect(before - v.hero(1)!.hp).toBeCloseTo(40, 6);
  });

  it('spellweave (spellblade): the secondary empowers the next blade wave (double damage, more pierce), once', () => {
    const a = special('spellblade');
    const wave = CLASSES.spellblade.primary[2]!;
    const fire = (): { bonus: number; pierce: number } => {
      a.h.primaryCd = 0;
      a.h.lockTime = 0;
      a.h.comboIndex = 2;
      a.h.comboTime = 1;
      a.pad.hold({ buttons: BTN.PRIMARY, aim: 0 }, 1);
      a.pad.hold({ aim: 0 }, seconds(wave.windup) + 1);
      const p = a.w.projectiles.at(-1)!;
      expect(p.kind).toBe('bladeWave');
      return { bonus: p.bonus, pierce: p.pierce };
    };
    expect(fire()).toEqual({ bonus: 0, pierce: wave.pierce });
    use(a, BTN.SECONDARY, 0.4, { aim: Math.PI });
    expect(a.h.spellweave).toBe(true);
    expect(fire()).toEqual({ bonus: TALENT.SPELLWEAVE_DAMAGE, pierce: wave.pierce + TALENT.SPELLWEAVE_PIERCE });
    expect(fire()).toEqual({ bonus: 0, pierce: wave.pierce });
    // The bonus is damage: an empowered wave hits for double.
    const b = special('spellblade');
    const foe = dummy(b.w, 0, 5);
    b.h.spellweave = true;
    b.h.comboIndex = 2;
    b.h.comboTime = 1;
    b.pad.hold({ buttons: BTN.PRIMARY, aim: 0 }, 1);
    b.pad.hold({ aim: 0 }, seconds(0.6));
    expect(100000 - foe.hp).toBeCloseTo(wave.damage * (1 + b.h.mods.damage) * (1 + TALENT.SPELLWEAVE_DAMAGE), 6);
  });

  it('ambush (shade): the first hit on an enemy that is not targeting the shade is critical', () => {
    const a = special('shade');
    const idle = post(a.w, 0, 2);
    const hunter = post(a.w, 2, 2);
    hunter.target = 0;
    const base = 10 * (1 + a.h.mods.damage);
    expect(hit(a, idle)).toBeCloseTo(base * STATUS.CRIT_MULTIPLIER, 6);
    expect(hit(a, idle)).toBeCloseTo(base, 6);
    expect(hit(a, hunter)).toBeCloseTo(base, 6);
    const plain = arena('shade', { mastery: 6 });
    expect(hit(plain, post(plain.w, 0, 2))).toBeCloseTo(base, 6);
  });
});

describe('relics', () => {
  it('20 relics; mods scale with rank by rankScale; slots follow the reliquary upgrade', () => {
    expect(RELICS).toHaveLength(20);
    expect(rankScale(1)).toBe(1);
    expect(rankScale(RELIC_TUNING.MAX_RANK)).toBeCloseTo(1 + RELIC_TUNING.RANK_STEP * (RELIC_TUNING.MAX_RANK - 1), 9);
    for (const relic of RELICS) {
      for (const rank of [1, 5, RELIC_TUNING.MAX_RANK]) {
        const a = arena('knight', withRelic(relic.id, rank));
        const want: Partial<Mods> = {};
        for (const key of MOD_KEYS) if (relic.mods?.[key] !== undefined) want[key] = Math.min(MODS_CAPS[key] ?? Infinity, relic.mods[key]! * rankScale(rank));
        expectMods(a.h.mods, want, `${relic.id} rank ${rank}`);
        const on = Object.values(a.h.relic).filter((v) => v > 0);
        expect(on, relic.id).toEqual(relic.special ? [rankScale(rank)] : []);
      }
    }
    const three = [{ id: 'whetstone', rank: 2 }, { id: 'iron_reliquary', rank: 1 }, { id: 'war_drum', rank: 4 }];
    expect(arena('knight', { relics: three }).h.build.relics).toEqual(three.slice(0, 1));
    expect(arena('knight', { relics: three, meta: metaLevels({ reliquary: 1 }) }).h.build.relics).toEqual(three.slice(0, 2));
    const full = arena('knight', { relics: three, meta: metaLevels({ reliquary: 2 }) });
    expect(full.h.build.relics).toEqual(three);
    expectMods(full.h.mods, { damage: 0.05 * rankScale(2), maxHp: 15, attackSpeed: 0.05 * rankScale(4) }, 'three relics');
  });

  it('ember_heart: a fresh Burn also catches one nearby enemy (and stops there)', () => {
    const a = arena('knight', withRelic('ember_heart'));
    const [first, second, third] = [post(a.w, 0, 2), post(a.w, 2, 2), post(a.w, 5, 2)];
    setStatus(a.w, first, 'ember', a.h, 1);
    expect(second.status).toBe('ember');
    expect(third.status).toBeNull();
    const b = arena('knight');
    const [x, y] = [post(b.w, 0, 2), post(b.w, 2, 2)];
    setStatus(b.w, x, 'ember', b.h, 1);
    expect(y.status).toBeNull();
  });

  it('frost_core: chilled enemies deal less damage (more at higher rank); bell: bursts slow what they hit', () => {
    for (const rank of [1, 5]) {
      const a = arena('knight', withRelic('frost_core', rank));
      const foe = post(a.w, 0, 2);
      setStatus(a.w, foe, 'rime', a.h, 1);
      expect(enemyDamage(foe, 100)).toBeCloseTo(100 * (1 - RELIC_TUNING.FROST_CORE_WEAKEN * rankScale(rank)), 6);
    }
    const b = arena('knight', withRelic('bell'));
    give(b.h, 'infuse_ember_primary');
    const target = post(b.w, 0, 2);
    const near = post(b.w, 2, 2);
    const base = enemySpeed(near);
    target.status = 'storm';
    target.statusTime = 5;
    hit(b, target, 10, 'primary');
    expect(enemySpeed(near)).toBeCloseTo(base * (1 - RELIC_TUNING.BELL_SLOW), 6);
    stepN(b.w, seconds(RELIC_TUNING.BELL_SECONDS) + 2);
    expect(enemySpeed(near)).toBeCloseTo(base, 6);
  });

  it('storm_coil: every 5th hit calls a lightning strike; void_lantern: withered enemies you slay heal the nearest hero', () => {
    const a = arena('knight', withRelic('storm_coil', 3));
    const foe = post(a.w, 0, 2);
    const losses: number[] = [];
    for (let i = 0; i < RELIC_TUNING.COIL_EVERY * 2; i++) losses.push(hit(a, foe));
    const strike = RELIC_TUNING.COIL_DAMAGE * rankScale(3);
    losses.forEach((lost, i) => expect(lost).toBeCloseTo((i + 1) % RELIC_TUNING.COIL_EVERY === 0 ? 10 + strike : 10, 6));
    const ev = a.w.drainEvents();
    expect(of(ev, 'cast').filter((c) => c.ability === 'storm_coil')).toHaveLength(2);
    expect(of(ev, 'hit').filter((x) => x.el === 'storm')).toHaveLength(2);
    expect(foe.status).toBeNull();

    const w = party(['knight', 'mage'], [withRelic('void_lantern')]);
    place(w, 0, 0, 0);
    place(w, 1, 0, 6);
    const [knight, mage] = [w.hero(0)!, w.hero(1)!];
    knight.hp = 50;
    mage.hp = 50;
    const withered = dummy(w, 0, 5, 'minion', 1);
    setStatus(w, withered, 'umbra', knight, 1);
    hit({ w, h: knight }, withered);
    expect(withered.dead).toBe(true);
    expect(mage.hp).toBe(50 + RELIC_TUNING.LANTERN_HEAL);
    // (The knight only got the ordinary leech of a hit on a withered enemy.)
    expect(knight.hp).toBe(50 + STATUS.WITHER.LEECH);
    const plain = dummy(w, 0, 5, 'minion', 1);
    hit({ w, h: knight }, plain);
    expect(mage.hp).toBe(50 + RELIC_TUNING.LANTERN_HEAL);
  });

  it('phoenix: once per run a killing blow leaves the hero standing with part of its health', () => {
    const a = arena('knight', withRelic('phoenix'));
    damageHero(a.w, a.h, 9999, -1);
    expect(a.h.state).toBe('alive');
    expect(a.h.hp).toBe(Math.round(a.h.maxHp * RELIC_TUNING.PHOENIX_HP));
    expect(of(a.w.drainEvents(), 'cast').map((c) => c.ability)).toEqual(['phoenix']);
    expect(of(a.w.drainEvents(), 'down')).toHaveLength(0);
    a.h.invuln = 0;
    damageHero(a.w, a.h, 9999, -1);
    expect(a.h.state).toBe('downed');
    // A new run restores it.
    const w = new World();
    w.addPlayer(0, 'knight', 'A', withRelic('phoenix'));
    w.start(0, 1);
    w.hero(0)!.phoenixUsed = true;
    w.reset();
    expect(w.hero(0)!.phoenixUsed).toBe(false);
    expect(w.hero(0)!.relic.phoenix).toBe(1);
  });
});

describe('the pipeline as a whole', () => {
  it('one Mods per hero: upgrades + Ascension + mastery + talents + relics + sets + boon mods, then the caps', () => {
    const a = arena('knight', {
      meta: metaLevels({ might: 8, reliquary: 2 }), paragon: paragonRanks({ asc_might: 10 }), mastery: 11, talents: [1, 2, 2],
      relics: [{ id: 'whetstone', rank: 3 }, { id: 'aegis_shard', rank: 1 }],
    });
    const might = meta('might').values.at(-1)! + 10 * 0.01 + 10 * MASTERY.PER_LEVEL.damage! + 0.05 * rankScale(3);
    expect(a.h.mods.damage).toBeCloseTo(might, 9);
    // bastion 6 % + unbroken 6 % + aegis shard 3 %.
    expect(a.h.mods.damageTaken).toBeCloseTo(0.15, 9);
    expect(a.h.mods.startShield).toBe(30 + 8);
    give(a.h, 'stoneskin', 'stoneskin', 'barrier', 'leech', 'last_stand', 'thorns');
    // + stoneskin 16 % + defense set tier 2 15 % = 46 %, still below the cap.
    expect(a.h.mods.damageTaken).toBeCloseTo(0.46, 9);
    expect(a.h.maxHp).toBe(CLASSES.knight.maxHp + 10 + 20 + 30);
    a.h.barrier = 0;
    const hp = a.h.hp;
    damageHero(a.w, a.h, 100, -1);
    expect(hp - a.h.hp).toBeCloseTo(54, 6);
    // The cap: whatever is stacked, a hero never ignores more than MODS_CAPS.damageTaken.
    a.h.perm.damageTaken += 5;
    give(a.h, 'mending');
    expect(a.h.mods.damageTaken).toBe(MODS_CAPS.damageTaken);
    expect({ ...ZERO_MODS }).toEqual(Object.fromEntries(MOD_KEYS.map((k) => [k, 0])));
  });

  it('the `area` mod enlarges arcs, blasts and zones', () => {
    const plain = arena('barbarian', { mastery: 6 });
    const big = arena('barbarian', { mastery: 6, talents: [0, 2, 0] });
    expect(big.h.mods.area).toBeCloseTo(0.2, 9);
    expect(big.h.abil.primary[0]!.range).toBeCloseTo(plain.h.abil.primary[0]!.range * 1.2, 9);
    expect(big.h.abil.secondary.radius).toBeCloseTo(plain.h.abil.secondary.radius * 1.2, 9);
    const t = arena('templar', { mastery: 6, talents: [0, 2, 0] });
    expect(of(use(t, BTN.SECONDARY, 0.5), 'zone')[0]!.r).toBeCloseTo(CLASSES.templar.secondary.radius * 1.25, 9);
  });

  it('the simulation clamps whatever loadout it is handed, and a class change keeps only what is not class-bound', () => {
    const w = new World();
    const wish = { meta: META_UPGRADES.map(() => 99), paragon: [1e9], mastery: 5, art: 1, talents: [2, 2, 2], relics: [{ id: 'bell', rank: 99 }, { id: 'bell', rank: 1 }, { id: 'nope', rank: 1 }, { id: 'tome', rank: 0 }, { id: 'prism', rank: 2 }, { id: 'censer', rank: 2 }] };
    expect(w.addPlayer(0, 'knight', 'A', wish)).toBe(true);
    const build = w.getBuild(0)!;
    expect(build.meta).toEqual(maxMetaLevels());
    expect(build).toMatchObject({ mastery: 5, art: 1, talents: [2, 0, 0] });
    expect(build.paragon[0]).toBe(PARAGON_TUNING.MAX_RANK);
    expect(build.relics).toEqual([{ id: 'bell', rank: RELIC_TUNING.MAX_RANK }, { id: 'tome', rank: 1 }, { id: 'prism', rank: 2 }]);
    for (const junk of [null, 'x', 42, { mastery: 'ten', relics: 'all', talents: 7 }]) {
      const v = new World();
      v.addPlayer(0, 'mage', 'J', junk);
      expect(v.getBuild(0)).toEqual({ meta: META_UPGRADES.map(() => 0), paragon: PARAGON.map(() => 0), mastery: 1, art: 0, talents: [0, 0, 0], relics: [] });
    }
    // Mastery, art and talents belong to the class: changing it without a loadout resets them.
    expect(w.setClass(0, 'mage')).toBe(true);
    expect(w.getBuild(0)).toMatchObject({ mastery: 1, art: 0, talents: [0, 0, 0], meta: maxMetaLevels(), relics: build.relics });
    expect(w.setClass(0, 'shade', { ...wish, mastery: 10 })).toBe(true);
    expect(w.getBuild(0)).toMatchObject({ mastery: 10, art: 1, talents: [2, 2, 2] });
    expect(w.hero(0)!.cls).toBe('shade');
    // setLoadout replaces everything; neither works during a run.
    expect(w.setLoadout(0, { mastery: 2 })).toBe(true);
    expect(w.getBuild(0)).toMatchObject({ mastery: 2, art: 0, relics: [] });
    w.start(0, 1);
    expect(w.setLoadout(0, wish)).toBe(false);
    expect(w.setClass(0, 'knight', wish)).toBe(false);
    expect(w.getBuild(0)).toMatchObject({ mastery: 2 });
    // The build survives the run and the return to the lobby.
    w.reset();
    expect(w.getBuild(0)).toMatchObject({ mastery: 2 });
    expect(TALENT_SLOT).toBe(MASTERY.TALENT_LEVELS[0]);
  });

  it('training sessions ignore every permanent bonus', () => {
    const w = new World();
    const full = { ...maxBuild('templar', maxMetaLevels()), paragon: PARAGON.map(() => 50), relics: [{ id: 'whetstone', rank: 10 }] };
    w.addPlayer(0, 'templar', 'Rookie', full);
    expect(w.hero(0)!.mods.damage).toBeGreaterThan(0.5);
    expect(w.startTutorial(1)).toBe(true);
    const h = w.hero(0)!;
    expectMods(h.mods, {}, 'tutorial hero');
    expect(h.maxHp).toBe(CLASSES.templar.maxHp);
    expect(h.abil.secondary.id).toBe('templar_consecrate');
    expect(Object.values(h.talent).some(Boolean)).toBe(false);
    expect(Object.values(h.relic).some((v) => v > 0)).toBe(false);
  });
});
