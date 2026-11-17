/** Update 3: classes, new ability shapes, arts, ultimates and their specials. */
import { describe, expect, it } from 'vitest';
import { TICK_DT, WORLD } from '@shared/constants.ts';
import { ABILITY_BY_ID, BACKSTAB, BUFFS, CLASSES, SMOKE, TRAP, ULTIMATE, secondaryOf } from '@shared/data/classes.ts';
import { STATUS } from '@shared/data/enemies.ts';
import { damageHero, downHero, enemyDamage, strikeEnemy } from '@shared/sim/combat.ts';
import { enemySpeed } from '@shared/sim/enemies.ts';
import { World } from '@shared/sim/index.ts';
import { BTN, CLASS_IDS, EF, PROJECTILE_KINDS } from '@shared/types.ts';
import { casts, clearChamber, draftAll, dummy, live, Pad, place, seconds, stepN, takeDoor } from './harness.ts';
import { arena, damageOn, give, mastered, of, party, use } from './u3kit.ts';

const ART = mastered({ art: 1 });
const SLASH = CLASSES.knight.primary[0]!.damage;

describe('classes and ability ids', () => {
  it('seven classes, each with a primary chain, a secondary, an art and an ultimate; ability ids are unique', () => {
    expect(CLASS_IDS).toEqual(['knight', 'barbarian', 'mage', 'rogue', 'templar', 'spellblade', 'shade']);
    let count = 0;
    for (const cls of CLASS_IDS) {
      const def = CLASSES[cls];
      expect(def.primary.length).toBeGreaterThan(0);
      expect(def.arts.length).toBeGreaterThan(0);
      expect(def.secondary.anim).toBe('secondary');
      for (const art of def.arts) expect(art.anim).toBe('art');
      expect(def.ultimate.anim).toBe('ultimate');
      expect(def.ultimate.cooldown).toBe(0);
      count += def.primary.length + 1 + def.arts.length + 1;
    }
    expect(ABILITY_BY_ID.size).toBe(count);
    for (const kind of ['shieldDisc', 'bladeWave', 'shadowDagger']) expect(PROJECTILE_KINDS).toContain(kind);
  });

  for (const cls of CLASS_IDS) {
    it(`${cls}: secondary, art and ultimate each cast under their ability id with their animation`, () => {
      const def = CLASSES[cls];
      // Standard secondary.
      const a = arena(cls);
      dummy(a.w, 0, 2.5);
      expect(a.h.abil.secondary.id).toBe(def.secondary.id);
      a.pad.hold({ buttons: BTN.SECONDARY, aim: 0, aimDist: 3 }, 1);
      expect(casts(a.w.drainEvents().concat(of([], 'cast')))).toEqual([]);
      const b = arena(cls);
      let ev = b.pad.hold({ buttons: BTN.SECONDARY, aim: 0, aimDist: 3 }, 1);
      expect(casts(ev)).toContain(def.secondary.id);
      expect(b.w.getSnapshotBody().players[0]!.anim).toBe('secondary');
      expect(of(ev, 'cast').find((c) => c.ability === def.secondary.id)!.who).toEqual({ t: 'p', id: 0 });
      // The art replaces it once mastery allows (Loadout.art = 1).
      const c = arena(cls, ART);
      expect(c.h.abil.secondary.id).toBe(def.arts[0]!.id);
      expect(secondaryOf(def, c.h.build.art).id).toBe(def.arts[0]!.id);
      ev = c.pad.hold({ buttons: BTN.SECONDARY, aim: 0, aimDist: 3 }, 1);
      expect(casts(ev)).toContain(def.arts[0]!.id);
      expect(casts(ev)).not.toContain(def.secondary.id);
      expect(c.w.getSnapshotBody().players[0]!.anim).toBe('art');
      // The ultimate needs a full charge and spends it.
      const d = arena(cls);
      ev = d.pad.hold({ buttons: BTN.ULTIMATE, aim: 0, aimDist: 3 }, 2);
      expect(casts(ev)).toEqual([]);
      d.h.ult = ULTIMATE.MAX;
      expect(d.w.getSnapshotBody().players[0]!.ult).toBe(1);
      ev = d.pad.hold({ aim: 0 }, 1);
      ev.push(...d.pad.hold({ buttons: BTN.ULTIMATE, aim: 0, aimDist: 3 }, 1));
      expect(casts(ev)).toEqual([def.ultimate.id]);
      expect(d.w.getSnapshotBody().players[0]!.anim).toBe('ultimate');
      expect(d.h.ult).toBe(0);
      expect(d.w.getSnapshotBody().players[0]!.ult).toBe(0);
      expect(d.w.getRunState().stats[0]!.ultimates).toBe(1);
      // No second cast without a new charge.
      ev = d.pad.hold({ aim: 0 }, seconds(1.5));
      ev.push(...d.pad.hold({ buttons: BTN.ULTIMATE, aim: 0 }, 2));
      expect(casts(ev)).not.toContain(def.ultimate.id);
    });
  }

  it('the art needs mastery: below MASTERY.ART_LEVEL the standard secondary stays', () => {
    const a = arena('knight', { mastery: 1, art: 1 });
    expect(a.h.build.art).toBe(0);
    expect(a.h.abil.secondary.id).toBe('knight_bash');
    expect(arena('knight', { mastery: 2, art: 1 }).h.abil.secondary.id).toBe('knight_toss');
    expect(arena('knight', { mastery: 99, art: 2 }).h.abil.secondary.id).toBe('knight_bash');
  });
});

describe('new ability shapes', () => {
  it('beam (mage Arc Lance): an instant line through everything, as wide as its radius', () => {
    const a = arena('mage', ART);
    const lance = CLASSES.mage.arts[0]!;
    place(a.w, 0, 0, -10);
    const near = dummy(a.w, 0, -5);
    const far = dummy(a.w, 0.5, -10 + lance.range - 1);
    const beside = dummy(a.w, lance.radius + 0.4 + 0.5, -4);
    const behind = dummy(a.w, 0, -13);
    const beyond = dummy(a.w, 0, -10 + lance.range + lance.radius + 0.4 + 0.5);
    const ev = use(a, BTN.SECONDARY, lance.windup + 0.1);
    // (A mastered hero also has the small damage bonus of its mastery level.)
    expect(100000 - near.hp).toBeCloseTo(lance.damage * (1 + a.h.mods.damage), 6);
    expect(100000 - far.hp).toBeCloseTo(lance.damage * (1 + a.h.mods.damage), 6);
    for (const e of [beside, behind, beyond]) expect(damageOn(ev, e.id)).toBe(0);
    // Instant: no projectile is ever in flight.
    expect(a.w.projectiles).toHaveLength(0);
  });

  it('leap (barbarian Skullsplitter): flies to the cursor as a dash, invulnerable in the air, blasts on landing', () => {
    const a = arena('barbarian', ART);
    const leap = CLASSES.barbarian.arts[0]!;
    const target = dummy(a.w, 0, 7.5);
    const out = dummy(a.w, 0, 6 + leap.radius + 1.5);
    a.h.primaryCd = 0;
    let ev = a.pad.hold({ buttons: BTN.SECONDARY, aim: 0, aimDist: 6 }, 1);
    expect(of(ev, 'cast')[0]).toMatchObject({ ability: 'barb_leap', x: 0, rot: 0 });
    expect(of(ev, 'cast')[0]!.z).toBeCloseTo(6, 6);
    expect(damageHero(a.w, a.h, 50, -1)).toBe(false);
    let dashed = 0;
    let landedAt = -1;
    for (let i = 1; i < seconds(leap.lock) + 3; i++) {
      ev = a.pad.hold({ aim: 0, moveX: 1 }, 1);
      const self = a.w.getSelfState(0);
      if (self.dashTime > 0) { dashed++; expect(self.dashDirZ).toBeCloseTo(1, 6); }
      if (landedAt < 0 && damageOn(ev, target.id) > 0) {
        landedAt = i;
        expect(100000 - target.hp).toBeCloseTo(leap.damage * (1 + a.h.mods.damage), 6);
        expect(damageOn(ev, out.id)).toBe(0);
        expect(of(ev, 'aoe')[0]).toMatchObject({ r: leap.radius, hostile: false });
      }
    }
    // The flight is a dash at DASH speed (SelfState carries it); the blast lands when the windup is over.
    expect(dashed).toBeGreaterThanOrEqual(5);
    expect(Math.abs(landedAt * TICK_DT - leap.windup)).toBeLessThanOrEqual(2 * TICK_DT);
    // Rooted otherwise: the sideways input moved nothing until the lock ended.
    expect(a.h.body.z).toBeCloseTo(6, 1);
    expect(Math.abs(a.h.body.x)).toBeLessThan(0.6);
    // The jump is clamped to the ability's range.
    const b = arena('barbarian', ART);
    use(b, BTN.SECONDARY, leap.lock + 0.1, { aimDist: 25 });
    expect(b.h.body.z).toBeCloseTo(leap.range, 1);
  });

  it('zone (templar Consecrate): announced, pulses damage to enemies and healing to heroes inside, ends by itself', () => {
    const a = arena('templar');
    const def = CLASSES.templar.secondary;
    const inside = dummy(a.w, 0, 2);
    const outside = dummy(a.w, 0, def.radius + 2);
    a.h.hp = 50;
    const ev = use(a, BTN.SECONDARY, def.windup + def.duration + 1);
    const zone = of(ev, 'zone');
    expect(zone).toHaveLength(1);
    expect(zone[0]).toMatchObject({ kind: 'templar_consecrate', x: 0, z: 0, r: def.radius, dur: def.duration, el: null, by: 0 });
    const pulses = Math.round(def.duration / def.tick);
    const hitsIn = of(ev, 'hit').filter((x) => x.target.t === 'e' && x.target.id === inside.id);
    expect(hitsIn).toHaveLength(pulses);
    expect(hitsIn.every((x) => x.dmg === def.damage)).toBe(true);
    expect(damageOn(ev, outside.id)).toBe(0);
    expect(a.h.hp).toBeCloseTo(50 + pulses * def.heal, 6);
    expect(of(ev, 'zoneEnd')).toHaveLength(0);
    expect(a.w.zones).toHaveLength(0);
  });

  it('zone at the cursor (rogue Bolt Storm) and its ultimate charge rule: ultimate hits charge nothing', () => {
    const a = arena('rogue');
    const def = CLASSES.rogue.ultimate;
    const foe = dummy(a.w, 0, 8);
    const ev = use(a, BTN.ULTIMATE, def.windup + def.duration + 0.5, { aimDist: 8 });
    expect(of(ev, 'zone')[0]).toMatchObject({ kind: 'rogue_volley', x: 0, r: def.radius });
    expect(of(ev, 'zone')[0]!.z).toBeCloseTo(8, 6);
    expect(damageOn(ev, foe.id)).toBe(Math.round(def.duration / def.tick) * def.damage);
    expect(a.h.ult).toBe(0);
  });

  it('trap (rogue Snare): lies at once, arms after the windup, springs on contact, stuns; at most three at a time', () => {
    const a = arena('rogue', ART);
    const def = CLASSES.rogue.arts[0]!;
    const foe = live(a.w, 'warrior', 0, 5);
    foe.stunTime = 0;
    foe.passive = true;
    foe.shieldHp = 0;
    const hp = foe.hp;
    let ev = a.pad.hold({ buttons: BTN.SECONDARY, aim: 0, aimDist: 5 }, 1);
    const placed = of(ev, 'zone');
    expect(placed).toHaveLength(1);
    expect(placed[0]).toMatchObject({ kind: 'rogue_trap', r: def.radius, by: 0 });
    expect(placed[0]!.dur).toBeCloseTo(def.duration + def.windup, 6);
    // Not armed yet: the enemy stands on it unharmed.
    ev = a.pad.hold({ aim: 0 }, seconds(def.windup) - 2);
    expect(foe.hp).toBe(hp);
    ev = a.pad.hold({ aim: 0 }, 5);
    expect(hp - foe.hp).toBeCloseTo(def.damage * (1 + a.h.mods.damage), 6);
    expect(foe.stunTime).toBeGreaterThan(def.stun - 0.2);
    expect(of(ev, 'zoneEnd')).toEqual([{ e: 'zoneEnd', id: placed[0]!.id, x: placed[0]!.x, z: placed[0]!.z, sprung: true }]);
    expect(a.w.zones).toHaveLength(0);

    // max3: a fourth trap removes the oldest (zoneEnd, not sprung).
    const b = arena('rogue', ART);
    const ids: number[] = [];
    for (let i = 0; i <= TRAP.MAX_ACTIVE; i++) {
      const cast = use(b, BTN.SECONDARY, 0.5, { aim: i * 1.3, aimDist: 6 });
      ids.push(of(cast, 'zone')[0]!.id);
      if (i < TRAP.MAX_ACTIVE) expect(of(cast, 'zoneEnd')).toHaveLength(0);
      else expect(of(cast, 'zoneEnd')).toEqual([expect.objectContaining({ id: ids[0], sprung: false })]);
    }
    expect(b.w.zones.map((z) => z.id)).toEqual(ids.slice(1));
    // An unsprung trap runs out after its duration.
    stepN(b.w, seconds(def.duration + def.windup + 0.5));
    expect(b.w.zones).toHaveLength(0);
  });

  it('spin art (spellblade Rune Ward) shields and cuts; projectile art (knight Shield Toss) pierces a whole line and stuns', () => {
    const a = arena('spellblade', ART);
    const ward = CLASSES.spellblade.arts[0]!;
    const close = dummy(a.w, 0, 2);
    const ev = use(a, BTN.SECONDARY, ward.duration + 0.5);
    expect(a.w.getSnapshotBody().players[0]!.shield).toBe(ward.selfShield);
    expect(of(ev, 'hit').filter((x) => x.target.t === 'e' && x.target.id === close.id)).toHaveLength(Math.round(ward.duration / ward.tick));
    expect(100000 - close.hp).toBeCloseTo(Math.round(ward.duration / ward.tick) * ward.damage * (1 + a.h.mods.damage), 6);

    const k = arena('knight', ART);
    const toss = CLASSES.knight.arts[0]!;
    const line = [live(k.w, 'minion', 0, 3), live(k.w, 'minion', 0, 5), live(k.w, 'minion', 0, 8)];
    for (const e of line) { e.passive = true; e.hp = e.maxHp = 500; }
    k.pad.hold({ buttons: BTN.SECONDARY, aim: 0 }, 1);
    const flight = k.pad.hold({ aim: 0 }, seconds(toss.windup) + 2);
    expect(k.w.getSnapshotBody().projectiles[0]).toMatchObject({ kind: 'shieldDisc', hostile: false });
    const stunned = new Set<number>();
    for (let i = 0; i < seconds(0.6); i++) {
      k.pad.hold({ aim: 0 }, 1);
      for (const e of line) if (e.stunTime > 0) stunned.add(e.id);
    }
    for (const e of line) expect(500 - e.hp).toBeCloseTo(toss.damage * (1 + k.h.mods.damage), 6);
    expect(stunned.size).toBe(line.length);
    void flight;
  });

  it('the spellblade chain ends in a blade wave projectile', () => {
    const a = arena('spellblade');
    const foe = dummy(a.w, 0, 6);
    const ev = a.pad.hold({ buttons: BTN.PRIMARY, aim: 0 }, seconds(1.3));
    expect(casts(ev).slice(0, 3)).toEqual(['spell_cut1', 'spell_cut2', 'spell_wave']);
    expect(damageOn(ev, foe.id)).toBe(CLASSES.spellblade.primary[2]!.damage);
    const b = arena('spellblade');
    let seen = false;
    for (let i = 0; i < seconds(1.3); i++) {
      b.pad.hold({ buttons: BTN.PRIMARY, aim: 0 }, 1);
      seen ||= b.w.getSnapshotBody().projectiles.some((p) => p.kind === 'bladeWave');
    }
    expect(seen).toBe(true);
  });
});

describe('buff ultimates', () => {
  it('barbarian Bloodrage: more damage, faster attacks and movement, heals on kill, for its duration', () => {
    const a = arena('barbarian');
    const rage = CLASSES.barbarian.ultimate;
    const chop = CLASSES.barbarian.primary[0]!;
    const foe = dummy(a.w, 0, 2);
    let ev = use(a, BTN.ULTIMATE, rage.lock + 0.1);
    expect(of(ev, 'buff')).toEqual([{ e: 'buff', slot: 0, id: 'bloodrage', dur: rage.duration }]);
    ev = use(a, BTN.PRIMARY, 0);
    expect(a.h.primaryCd).toBeCloseTo(chop.cooldown / (1 + BUFFS.bloodrage.attackSpeed) - TICK_DT, 6);
    ev.push(...a.pad.hold({ aim: 0, moveX: 0 }, seconds(chop.windup) + 1));
    expect(damageOn(ev, foe.id)).toBe(Math.round(chop.damage * (1 + BUFFS.bloodrage.damage)));
    a.pad.hold({ moveX: 1 }, seconds(chop.lock) + 2);
    expect(a.w.getSelfState(0).moveSpeed).toBeCloseTo(CLASSES.barbarian.moveSpeed * (1 + BUFFS.bloodrage.moveSpeed), 6);
    // Kill: heal.
    a.h.hp = 50;
    const prey = dummy(a.w, a.h.body.x, a.h.body.z + 2, 'minion', 1);
    strikeEnemy(a.w, a.h, prey, 5, 'primary', { fromX: 0, fromZ: 0, stun: 0, knockback: 0 });
    expect(prey.dead).toBe(true);
    expect(a.h.hp).toBe(50 + BUFFS.bloodrage.lifeOnKill);
    // Over after the duration.
    a.pad.hold({}, seconds(rage.duration));
    expect(a.h.buffs.bloodrage).toBe(0);
    a.pad.hold({ moveX: 1 }, 2);
    expect(a.w.getSelfState(0).moveSpeed).toBeCloseTo(CLASSES.barbarian.moveSpeed, 6);
  });

  it('knight Banner (bulwark): heroes in reach get the buff and the shield, take far less damage; enemies nearby turn on the knight', () => {
    const banner = CLASSES.knight.ultimate;
    const w = party(['knight', 'mage', 'rogue']);
    place(w, 0, 0, 0);
    place(w, 1, banner.radius - 1, 0);
    place(w, 2, banner.radius + 3, 0);
    const [knight, mage, rogue] = [w.hero(0)!, w.hero(1)!, w.hero(2)!];
    // A minion that is after the mage, inside the taunt radius of the knight.
    const foe = live(w, 'minion', banner.radius - 1, 5);
    foe.attackCd = 99;
    stepN(w, 2);
    expect(foe.target).toBe(1);
    knight.ult = ULTIMATE.MAX;
    const pad = new Pad(w, 0);
    const ev = pad.hold({ buttons: BTN.ULTIMATE }, 1);
    ev.push(...pad.hold({}, seconds(banner.windup) + 2));
    expect(of(ev, 'buff').map((b) => [b.slot, b.id, b.dur])).toEqual([[0, 'bulwark', banner.duration], [1, 'bulwark', banner.duration]]);
    expect(knight.tempShield).toBe(banner.selfShield);
    expect(mage.tempShield).toBe(banner.selfShield);
    expect(rogue.tempShield).toBe(0);
    expect(rogue.buffs.bulwark).toBe(0);
    expect(foe.target).toBe(0);
    // Damage: halved for the two under the banner (before shields), full for the rogue.
    for (const h of [knight, mage, rogue]) { h.tempShield = 0; h.invuln = 0; }
    const before = [knight.hp, mage.hp, rogue.hp];
    for (const h of [knight, mage, rogue]) damageHero(w, h, 40, -1);
    expect(before[0]! - knight.hp).toBeCloseTo(40 * (1 - BUFFS.bulwark.damageTaken), 6);
    expect(before[1]! - mage.hp).toBeCloseTo(40 * (1 - BUFFS.bulwark.damageTaken), 6);
    expect(before[2]! - rogue.hp).toBeCloseTo(40, 6);
    // When the banner falls the enemy is free to choose again.
    stepN(w, seconds(banner.duration));
    expect(knight.buffs.bulwark).toBe(0);
    expect(knight.taunt).toBe(0);
    place(w, 0, -16, -10);
    foe.x = banner.radius - 1;
    foe.z = 5;
    stepN(w, seconds(2));
    expect(foe.target).toBe(1);
  });
});

describe('ultimate charge', () => {
  it('comes from damage dealt (capped per hit), damage taken and Resonances; ultReady fires once when it fills', () => {
    const a = arena('knight');
    const foe = dummy(a.w, 0, 2);
    use(a, BTN.PRIMARY, 0.3);
    expect(a.h.ult).toBeCloseTo(SLASH * ULTIMATE.PER_DAMAGE_DEALT, 6);
    a.h.ult = 0;
    strikeEnemy(a.w, a.h, foe, 5000, 'secondary', { fromX: 0, fromZ: 0, stun: 0, knockback: 0 });
    expect(a.h.ult).toBe(ULTIMATE.MAX_PER_HIT);
    a.h.ult = 0;
    damageHero(a.w, a.h, 10, -1);
    expect(a.h.ult).toBeCloseTo(10 * ULTIMATE.PER_DAMAGE_TAKEN, 6);
    // Resonance: PER_RESONANCE on top of the hit that caused it.
    give(a.h, 'infuse_ember_primary');
    foe.status = 'rime';
    foe.statusTime = 5;
    a.h.ult = 0;
    strikeEnemy(a.w, a.h, foe, 10, 'primary', { fromX: 0, fromZ: 0, stun: 0, knockback: 0 });
    expect(a.w.getRunState().stats[0]!.resonances).toBe(1);
    expect(a.h.ult).toBeCloseTo(10 * ULTIMATE.PER_DAMAGE_DEALT + ULTIMATE.PER_RESONANCE, 6);
    // Filling the bar: one event, and no overflow.
    a.w.drainEvents();
    a.h.ult = ULTIMATE.MAX - 1;
    strikeEnemy(a.w, a.h, foe, 5000, 'secondary', { fromX: 0, fromZ: 0, stun: 0, knockback: 0 });
    strikeEnemy(a.w, a.h, foe, 5000, 'secondary', { fromX: 0, fromZ: 0, stun: 0, knockback: 0 });
    expect(a.h.ult).toBe(ULTIMATE.MAX);
    expect(of(a.w.drainEvents(), 'ultReady')).toEqual([{ e: 'ultReady', slot: 0 }]);
    expect(a.w.getSnapshotBody().players[0]!.ult).toBe(1);
  });

  it('is kept between chambers and reset by a new run', () => {
    const w = new World();
    w.addPlayer(0, 'knight', 'A');
    w.start(0, 5);
    w.hero(0)!.ult = 40;
    clearChamber(w);
    draftAll(w);
    takeDoor(w, 0);
    expect(w.run.chamber).toBe(1);
    expect(w.hero(0)!.ult).toBe(40);
    w.reset();
    expect(w.hero(0)!.ult).toBe(0);
  });
});

describe('ability specials', () => {
  it('templar Sanctuary (revive): a downed hero inside stands up after SANCTUARY_REVIVE_SECONDS, one outside does not', () => {
    const def = CLASSES.templar.ultimate;
    const w = party(['templar', 'mage', 'rogue']);
    place(w, 0, 0, 0);
    place(w, 1, 2, 2);
    place(w, 2, def.radius + WORLD.REVIVE_RADIUS + 4, 0);
    const [templar, mage, rogue] = [w.hero(0)!, w.hero(1)!, w.hero(2)!];
    templar.ult = ULTIMATE.MAX;
    const pad = new Pad(w, 0);
    const ev = pad.hold({ buttons: BTN.ULTIMATE }, 1);
    ev.push(...pad.hold({}, seconds(def.windup) + 1));
    expect(of(ev, 'zone')[0]).toMatchObject({ kind: 'templar_sanctuary', r: def.radius });
    // Outside the normal revive radius of the templar, inside the sanctuary.
    place(w, 1, 0, WORLD.REVIVE_RADIUS + 1.5);
    downHero(w, mage);
    downHero(w, rogue);
    const wait = pad.hold({}, seconds(ULTIMATE.SANCTUARY_REVIVE_SECONDS) - 3);
    expect(mage.state).toBe('downed');
    wait.push(...pad.hold({}, 6));
    expect(mage.state).toBe('alive');
    expect(of(wait, 'revived')).toEqual([{ e: 'revived', slot: 1, by: 0 }]);
    expect(w.getRunState().stats[0]!.revives).toBe(1);
    expect(rogue.state).toBe('downed');
  });

  it('templar Sanctuary also raises the templar: a solo run is not lost while the fallen hero lies inside it', () => {
    const w = new World();
    w.addPlayer(0, 'templar', 'Solo');
    w.start(0, 3);
    const h = w.hero(0)!;
    w.run.secondWinds = 0;
    h.ult = ULTIMATE.MAX;
    const pad = new Pad(w);
    pad.hold({ buttons: BTN.ULTIMATE }, 1);
    pad.hold({}, seconds(CLASSES.templar.ultimate.windup) + 1);
    expect(w.zones).toHaveLength(1);
    downHero(w, h);
    pad.hold({}, seconds(ULTIMATE.SANCTUARY_REVIVE_SECONDS) - 3);
    expect(w.run.phase).toBe('combat');
    expect(h.state).toBe('downed');
    pad.hold({}, 6);
    expect(h.state).toBe('alive');
    expect(w.run.phase).toBe('combat');
    // Without a sanctuary the same fall ends the run at once.
    stepN(w, seconds(CLASSES.templar.ultimate.duration + 1));
    expect(w.zones).toHaveLength(0);
    h.invuln = 0;
    downHero(w, h);
    w.step();
    expect(w.run.phase).toBe('defeat');
  });

  it('spellblade Overload (allElements): applies every infused element in turn, so it resonates with itself; then the afterglow', () => {
    const def = CLASSES.spellblade.ultimate;
    const a = arena('spellblade');
    give(a.h, 'infuse_ember_primary', 'infuse_rime_secondary');
    const foe = dummy(a.w, 0, 3);
    const edge = dummy(a.w, def.radius - 0.5, 0);
    const out = dummy(a.w, 0, -(def.radius + 2));
    const ev = use(a, BTN.ULTIMATE, def.windup + 0.1);
    const res = of(ev, 'resonance');
    expect(res.length).toBeGreaterThanOrEqual(2);
    for (const r of res) expect([r.a, r.b]).toEqual(['ember', 'rime']);
    expect(foe.status).toBe('rime');
    expect(edge.status).toBe('rime');
    expect(out.status).toBeNull();
    expect(damageOn(ev, out.id)).toBe(0);
    expect(damageOn(ev, foe.id)).toBeGreaterThanOrEqual(def.damage + STATUS.RESONANCE.DAMAGE);
    expect(of(ev, 'buff')).toEqual([{ e: 'buff', slot: 0, id: 'overload', dur: def.duration }]);
    // Afterglow: every hit applies the next element in turn, with BUFFS.overload.potency.
    foe.status = null;
    foe.resonanceCd = 0;
    const els: (string | null)[] = [];
    for (let i = 0; i < 4; i++) {
      strikeEnemy(a.w, a.h, out, 1, 'dash', { fromX: 0, fromZ: 0, stun: 0, knockback: 0 });
      els.push(of(a.w.drainEvents(), 'hit').pop()!.el);
      out.status = null;
      out.resonanceCd = 0;
    }
    expect(els).toEqual(['ember', 'rime', 'ember', 'rime']);
    strikeEnemy(a.w, a.h, foe, 1, 'dash', { fromX: 0, fromZ: 0, stun: 0, knockback: 0 });
    expect(foe.statusPotency).toBe(BUFFS.overload.potency);
    a.pad.hold({}, seconds(def.duration + 0.5));
    strikeEnemy(a.w, a.h, out, 1, 'dash', { fromX: 0, fromZ: 0, stun: 0, knockback: 0 });
    expect(of(a.w.drainEvents(), 'hit').pop()!.el).toBeNull();
  });

  it('spellblade Overload without infusions uses two different random elements (seeded) and still resonates', () => {
    const pairs = new Set<string>();
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const a = arena('spellblade', undefined, seed);
      dummy(a.w, 0, 3);
      const res = of(use(a, BTN.ULTIMATE, 0.6), 'resonance');
      expect(res).toHaveLength(1);
      expect(res[0]!.a).not.toBe(res[0]!.b);
      expect(a.h.overloadEls).toEqual([res[0]!.a, res[0]!.b]);
      pairs.add(`${res[0]!.a}+${res[0]!.b}`);
      // Deterministic for a seed.
      const again = arena('spellblade', undefined, seed);
      dummy(again.w, 0, 3);
      expect(of(use(again, BTN.ULTIMATE, 0.6), 'resonance')[0]).toEqual(res[0]);
    }
    expect(pairs.size).toBeGreaterThan(1);
  });

  it('shade backstab: primary hits from behind deal BACKSTAB.BONUS more; from the front they do not', () => {
    const stab = CLASSES.shade.primary[0]!;
    const hit = (rot: number): number => {
      const a = arena('shade');
      const foe = dummy(a.w, 0, 2);
      foe.rot = rot;
      return 100000 - (use(a, BTN.PRIMARY, stab.windup + 0.1), foe.hp);
    };
    // The enemy at +Z looks along +Z: away from the shade.
    expect(hit(0)).toBeCloseTo(stab.damage * (1 + BACKSTAB.BONUS), 6);
    expect(hit((BACKSTAB.HALF_ANGLE_DEG - 5) * (Math.PI / 180))).toBeCloseTo(stab.damage * (1 + BACKSTAB.BONUS), 6);
    expect(hit(Math.PI)).toBeCloseTo(stab.damage, 6);
    expect(hit(Math.PI / 2 + 0.2)).toBeCloseTo(stab.damage, 6);
    // Other classes have no such bonus.
    const k = arena('knight');
    const foe = dummy(k.w, 0, 2);
    foe.rot = 0;
    use(k, BTN.PRIMARY, 0.3);
    expect(100000 - foe.hp).toBeCloseTo(SLASH, 6);
  });

  it('shade Shadowstep (crit): the hit is always critical', () => {
    const step = CLASSES.shade.secondary;
    const a = arena('shade');
    const foe = dummy(a.w, 0, 3);
    foe.rot = Math.PI;
    const hit = of(use(a, BTN.SECONDARY, 0.5), 'hit').filter((x) => x.target.t === 'e');
    expect(hit).toHaveLength(1);
    expect(hit[0]).toMatchObject({ crit: true, dmg: step.damage * STATUS.CRIT_MULTIPLIER });
    expect(a.h.body.z).toBeCloseTo(step.range, 0);
  });

  it('shade Smoke Bomb (smoke): enemies inside are slowed and deal less damage while they stay in it', () => {
    const smoke = CLASSES.shade.arts[0]!;
    const a = arena('shade', ART);
    const inside = dummy(a.w, 0, 2);
    const outside = dummy(a.w, 0, smoke.radius + 3);
    const base = enemySpeed(inside);
    const ev = use(a, BTN.SECONDARY, smoke.windup + 0.2);
    expect(of(ev, 'zone')[0]).toMatchObject({ kind: 'shade_smoke', r: smoke.radius });
    expect(enemySpeed(inside)).toBeCloseTo(base * (1 - SMOKE.SLOW), 6);
    expect(enemyDamage(inside, 10)).toBeCloseTo(10 * (1 - SMOKE.WEAKEN), 6);
    expect(enemySpeed(outside)).toBeCloseTo(base, 6);
    expect(enemyDamage(outside, 10)).toBeCloseTo(10, 6);
    a.pad.hold({}, seconds(smoke.duration + 0.5));
    expect(enemySpeed(inside)).toBeCloseTo(base, 6);
    expect(enemyDamage(inside, 10)).toBeCloseTo(10, 6);
  });

  it('shade Death Mark (mark): marks the nearest MARK_MAX_TARGETS, throws a dagger at each, they take more damage and burst on death', () => {
    const def = CLASSES.shade.ultimate;
    const a = arena('shade');
    const foes = Array.from({ length: ULTIMATE.MARK_MAX_TARGETS + 2 }, (_, i) => dummy(a.w, (i - 3.5) * 1.1, 8 + (i % 2) * 0.4));
    const far = dummy(a.w, 0, 8 + def.radius + 2);
    a.h.ult = ULTIMATE.MAX;
    let ev = a.pad.hold({ buttons: BTN.ULTIMATE, aim: 0, aimDist: 8 }, 1);
    ev.push(...a.pad.hold({ aim: 0 }, seconds(def.windup) + 1));
    const marks = of(ev, 'mark');
    expect(marks).toHaveLength(ULTIMATE.MARK_MAX_TARGETS);
    expect(marks.every((m) => m.dur === def.duration)).toBe(true);
    const daggers = a.w.getSnapshotBody().projectiles;
    expect(daggers).toHaveLength(ULTIMATE.MARK_MAX_TARGETS);
    expect(daggers.every((p) => p.kind === 'shadowDagger' && !p.hostile)).toBe(true);
    ev = a.pad.hold({ aim: 0 }, seconds(0.6));
    const marked = foes.filter((e) => e.markTime > 0);
    expect(marked.map((e) => e.id).sort()).toEqual(marks.map((m) => m.id).sort());
    // Each dagger hits its own target: ability damage x the mark's vulnerability.
    for (const e of marked) expect(100000 - e.hp).toBeCloseTo(def.damage * (1 + ULTIMATE.MARK_VULNERABILITY), 6);
    for (const e of foes.filter((x) => x.markTime <= 0)) expect(e.hp).toBe(100000);
    expect(far.hp).toBe(100000);
    // Any later hit on a marked enemy is stronger too.
    const one = marked[0]!;
    let hp = one.hp;
    strikeEnemy(a.w, a.h, one, 10, 'dash', { fromX: 0, fromZ: 0, stun: 0, knockback: 0 });
    expect(hp - one.hp).toBeCloseTo(10 * (1 + ULTIMATE.MARK_VULNERABILITY), 6);
    // Death: the mark bursts around the corpse.
    const neighbour = foes.find((e) => e !== one && Math.hypot(e.x - one.x, e.z - one.z) < ULTIMATE.MARK_BURST_RADIUS)!;
    hp = neighbour.hp;
    a.w.drainEvents();
    one.hp = 1;
    strikeEnemy(a.w, a.h, one, 10, 'dash', { fromX: 0, fromZ: 0, stun: 0, knockback: 0 });
    expect(one.dead).toBe(true);
    expect(hp - neighbour.hp).toBeCloseTo(ULTIMATE.MARK_BURST_DAMAGE * (neighbour.markTime > 0 ? 1 + ULTIMATE.MARK_VULNERABILITY : 1), 6);
    expect(of(a.w.drainEvents(), 'aoe')).toContainEqual({ e: 'aoe', x: one.x, z: one.z, r: ULTIMATE.MARK_BURST_RADIUS, el: null, hostile: false });
    expect(far.hp).toBe(100000);
    // The mark runs out.
    a.pad.hold({}, seconds(def.duration));
    expect(foes.every((e) => e.markTime <= 0)).toBe(true);
  });

  it('ultimate infusions: whatever the ultimate hits carries the element; buff ultimates mark everything around the hero', () => {
    const a = arena('mage');
    give(a.h, 'infuse_storm_ultimate');
    const foe = dummy(a.w, 0, 8);
    const ev = use(a, BTN.ULTIMATE, CLASSES.mage.ultimate.windup + 0.1, { aimDist: 8 });
    expect(damageOn(ev, foe.id)).toBe(CLASSES.mage.ultimate.damage);
    expect(foe.status).toBe('storm');
    expect(a.w.getSnapshotBody().enemies[0]!.flags & EF.SHOCK).toBeTruthy();

    const k = arena('knight');
    give(k.h, 'infuse_umbra_ultimate');
    const near = dummy(k.w, 0, CLASSES.knight.ultimate.radius - 1);
    const far = dummy(k.w, 0, CLASSES.knight.ultimate.radius + 3);
    use(k, BTN.ULTIMATE, CLASSES.knight.ultimate.windup + 0.1);
    expect(near.status).toBe('umbra');
    expect(near.hp).toBe(100000);
    expect(far.status).toBeNull();
    expect(k.w.getSnapshotBody().enemies[0]!.flags & EF.WITHER).toBeTruthy();
  });
});
