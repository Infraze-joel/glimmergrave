/** Update 4: the five new enemy kinds and their counters, warded enemies, wave composition rules. */
import { describe, expect, it } from 'vitest';
import { RUN, WORLD } from '@shared/constants.ts';
import { DASH } from '@shared/data/classes.ts';
import { ENEMIES, ENEMY_TUNING, STATUS } from '@shared/data/enemies.ts';
import { applyElement, killEnemy, rawDamageEnemy, setStatus, strikeEnemy, stunEnemy } from '@shared/sim/combat.ts';
import { wardShare } from '@shared/sim/director.ts';
import { SUPPORT_KINDS } from '@shared/sim/horde.ts';
import { AI, composeWave, DIRECTOR, Rng, SIM, waveBudget, World, type Enemy, type Hero } from '@shared/sim/index.ts';
import { BTN, EF, ELEMENT_IDS, ENEMY_KINDS, type ElementId, type EnemyKind, type GameEvent } from '@shared/types.ts';
import { casts, dummy, hits, live, Pad, place, sandbox, seconds, stepN } from './harness.ts';
import { of } from './u3kit.ts';

const SH = ENEMY_TUNING.SHAMAN;
const AE = ENEMY_TUNING.AEGIS;
const BO = ENEMY_TUNING.BOMBER;
const NE = ENEMY_TUNING.NECROMANCER;
const RE = ENEMY_TUNING.REAVER;

/** Sandbox with sturdy heroes; hero 0 at the origin. */
function arena(classes: Parameters<typeof sandbox>[0] = ['knight'], seed = 3): { w: World; h: Hero; pad: Pad } {
  const w = sandbox(classes, seed);
  for (const h of w.heroes) { h.maxHp = 5000; h.hp = 5000; }
  place(w, 0, 0, 0);
  w.drainEvents();
  return { w, h: w.hero(0)!, pad: new Pad(w) };
}
/** Steps until `pred` matches an event of the tick; returns all events so far. */
function until(w: World, pred: (ev: GameEvent) => boolean, max = seconds(12)): GameEvent[] {
  const all: GameEvent[] = [];
  for (let i = 0; i < max; i++) {
    const ev = stepN(w, 1);
    all.push(...ev);
    if (ev.some(pred)) return all;
  }
  throw new Error('event did not happen');
}
const hitOpts = (h: Hero): Parameters<typeof strikeEnemy>[5] => ({ fromX: h.body.x, fromZ: h.body.z, stun: 0, knockback: 0 });
const isCast = (ability: string) => (ev: GameEvent): boolean => ev.e === 'cast' && ev.ability === ability;
const wound = (e: Enemy, fraction: number): void => { e.hp = e.maxHp * fraction; };

describe('data', () => {
  it('the five kinds are appended to ENEMY_KINDS and are ordinary rank and file', () => {
    expect(ENEMY_KINDS.slice(8)).toEqual(['shaman', 'aegis', 'bomber', 'necromancer', 'reaver']);
    for (const k of ENEMY_KINDS.slice(8)) {
      expect(ENEMIES[k].cost, k).toBeGreaterThan(0);
      expect(ENEMIES[k].minChamber, k).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('shaman', () => {
  /** A shaman 4 m from a wounded dummy; the hero stands far away. */
  function scene(): { w: World; h: Hero; shaman: Enemy; hurt: Enemy } {
    const { w, h } = arena();
    place(w, 0, 0, 12);
    const hurt = dummy(w, 0, -6, 'warrior', 1000);
    wound(hurt, 0.4);
    const shaman = live(w, 'shaman', 0, -10);
    shaman.specialCd = 0;
    w.drainEvents();
    return { w, h, shaman, hurt };
  }

  it('mends wounded enemies near it after a channel that is announced with a `cast` event (no ground telegraph: it hurts nobody)', () => {
    const { w, shaman, hurt } = scene();
    const healthy = dummy(w, 2, -9, 'minion', 500);
    // Scratched (so the shaman does not walk over for it) and out of reach.
    const far = dummy(w, SH.MEND_RADIUS + 3, -10, 'minion', 500);
    wound(far, 0.9);
    const start = until(w, isCast('mend'));
    expect(shaman.attack).toMatchObject({ type: 'mend' });
    expect(shaman.anim).toBe('cast');
    expect(of(start, 'telegraph')).toEqual([]);
    expect(of(start, 'cast').at(-1)).toMatchObject({ who: { t: 'e', id: shaman.id }, ability: 'mend' });
    // Nothing is healed before the channel ends.
    const channel = stepN(w, seconds(SH.MEND_WINDUP) - 2);
    expect(of(channel, 'mend')).toEqual([]);
    expect(hurt.hp).toBeCloseTo(400, 6);
    const end = stepN(w, 4);
    expect(of(end, 'mend')).toEqual([{ e: 'mend', id: shaman.id, targets: [hurt.id] }]);
    expect(hurt.hp).toBeCloseTo(400 + 1000 * SH.MEND_FRACTION, 6);
    expect(healthy.hp).toBe(500);
    expect(far.hp).toBeCloseTo(450, 6);
    expect(shaman.specialCd).toBeCloseTo(SH.MEND_COOLDOWN, 1);
    // Not again before the cooldown.
    wound(hurt, 0.4);
    expect(casts(stepN(w, seconds(SH.MEND_COOLDOWN) - 30))).not.toContain('mend');
    expect(casts(stepN(w, 60))).toContain('mend');
  });

  it('the heal is stopped by a stagger, a stun or its death', () => {
    for (const how of ['stagger', 'stun', 'kill'] as const) {
      const { w, h, shaman, hurt } = scene();
      until(w, isCast('mend'));
      stepN(w, seconds(SH.MEND_WINDUP / 2));
      if (how === 'stagger') {
        // Enough damage during the channel breaks its poise.
        expect(ENEMIES.shaman.poise).toBeGreaterThan(0);
        strikeEnemy(w, h, shaman, ENEMIES.shaman.poise + 5, 'secondary', hitOpts(h));
        expect(shaman.dead).toBe(false);
        expect(shaman.stunTime).toBeCloseTo(SIM.STAGGER_SECONDS, 6);
      } else if (how === 'stun') {
        stunEnemy(shaman, 1);
      } else {
        killEnemy(w, shaman, 0);
      }
      expect(shaman.attack, how).toBeNull();
      const ev = stepN(w, seconds(SH.MEND_WINDUP));
      expect(of(ev, 'mend'), how).toEqual([]);
      expect(hurt.hp, how).toBeCloseTo(400, 6);
    }
  });

  it('never mends itself or a boss, and an enemy can be mended only MAX_MENDS times', () => {
    const { w, shaman, hurt } = scene();
    const boss = live(w, 'champion', 3, -9);
    boss.stunTime = 0;
    boss.boss!.gap = 999;
    wound(boss, 0.5);
    wound(shaman, 0.5);
    let mends = 0;
    for (let i = 0; i < seconds(40); i++) {
      wound(hurt, 0.4);
      shaman.specialCd = 0;
      mends += of(stepN(w, 1), 'mend').length;
    }
    expect(mends).toBe(AI.SHAMAN.MAX_MENDS);
    expect(hurt.mends).toBe(AI.SHAMAN.MAX_MENDS);
    expect(boss.hp).toBeLessThanOrEqual(boss.maxHp * 0.5);
    expect(shaman.hp).toBeCloseTo(shaman.maxHp * 0.5, 6);
  });

  it('walks up to the wounded when it is out of reach, and throws a telegraphed hex bolt when nobody needs mending', () => {
    const { w, h } = arena();
    place(w, 0, 0, 12);
    const hurt = dummy(w, 0, -2, 'warrior', 1000);
    wound(hurt, 0.2);
    const shaman = live(w, 'shaman', 0, -13);
    shaman.specialCd = 0;
    shaman.attackCd = 99;
    const ev = until(w, isCast('mend'));
    expect(Math.hypot(shaman.x - hurt.x, shaman.z - hurt.z)).toBeLessThanOrEqual(SH.MEND_RADIUS + 0.01);
    expect(hits(ev, 'p')).toEqual([]);

    const b = arena();
    place(b.w, 0, 0, 0);
    const caster = live(b.w, 'shaman', 0, SH.KEEP_DISTANCE);
    const tele = until(b.w, (x) => x.e === 'telegraph').filter((x): x is Extract<GameEvent, { e: 'telegraph' }> => x.e === 'telegraph')[0]!;
    expect(tele).toMatchObject({ shape: 'line', src: caster.id, w: AI.SHAMAN.BOLT_TELEGRAPH_WIDTH });
    expect(tele.dur).toBeCloseTo(ENEMIES.shaman.windup, 6);
    expect(caster.attack).toMatchObject({ type: 'bolt' });
    const flight = stepN(b.w, seconds(ENEMIES.shaman.windup + 1.2));
    expect(b.w.getSnapshotBody().projectiles.length + hits(flight, 'p').length).toBeGreaterThan(0);
    expect(hits(flight, 'p', 0)[0]?.dmg).toBe(ENEMIES.shaman.damage);
    expect(h.hp).toBe(5000);
  });
});

describe('aegis', () => {
  function scene(): { w: World; h: Hero; aegis: Enemy; inside: Enemy; outside: Enemy } {
    const { w, h } = arena();
    place(w, 0, 0, 14);
    const aegis = live(w, 'aegis', 0, -6);
    aegis.attackCd = 999;
    // It stays where it is (it would walk towards the hero otherwise).
    aegis.rootTime = 1e9;
    const inside = dummy(w, 2, -6, 'minion', 1000);
    const outside = dummy(w, AE.DOME_RADIUS + 2, -6, 'minion', 1000);
    return { w, h, aegis, inside, outside };
  }
  const struck = (w: World, e: Enemy, amount = 100): number => {
    const before = e.hp;
    rawDamageEnemy(w, e, amount, 0, null);
    return before - e.hp;
  };

  it('raises a dome: OTHER enemies inside take DOME_REDUCTION less damage; the aegis itself and enemies outside do not', () => {
    const { w, h, aegis, inside, outside } = scene();
    const ev = stepN(w, 3);
    expect(of(ev, 'dome')).toEqual([{ e: 'dome', id: aegis.id, on: true, r: AE.DOME_RADIUS }]);
    expect(struck(w, inside)).toBeCloseTo(100 * (1 - AE.DOME_REDUCTION), 6);
    expect(struck(w, outside)).toBeCloseTo(100, 6);
    expect(struck(w, aegis, 10)).toBeCloseTo(10, 6);
    // Ability hits are reduced the same way.
    const before = inside.hp;
    strikeEnemy(w, h, inside, 50, 'ultimate', hitOpts(h));
    expect(before - inside.hp).toBeCloseTo(50 * (1 - AE.DOME_REDUCTION), 6);
    // Another aegis is not shielded by the first, a boss neither.
    const second = live(w, 'aegis', -2, -6);
    const boss = live(w, 'champion', 0, -8);
    stepN(w, 2);
    expect(struck(w, second, 10)).toBeCloseTo(10, 6);
    expect(struck(w, boss, 10)).toBeCloseTo(10, 6);
  });

  it('the dome drops while the aegis is stunned and is raised again DOME_REARM_SECONDS after it recovered', () => {
    const { w, aegis, inside } = scene();
    stepN(w, 3);
    stunEnemy(aegis, 1);
    const drop = stepN(w, 2);
    expect(of(drop, 'dome')).toEqual([{ e: 'dome', id: aegis.id, on: false, r: AE.DOME_RADIUS }]);
    expect(struck(w, inside)).toBeCloseTo(100, 6);
    // Still down right after the stun, and for the whole re-arm time.
    const wait = stepN(w, seconds(1 + AE.DOME_REARM_SECONDS) - 6);
    expect(of(wait, 'dome')).toEqual([]);
    expect(struck(w, inside)).toBeCloseTo(100, 6);
    const back = stepN(w, 10);
    expect(of(back, 'dome')).toEqual([{ e: 'dome', id: aegis.id, on: true, r: AE.DOME_RADIUS }]);
    expect(struck(w, inside)).toBeCloseTo(100 * (1 - AE.DOME_REDUCTION), 6);
  });

  it('a stagger drops it too, and so does its death', () => {
    const { w, h, aegis, inside } = scene();
    place(w, 0, 0, -6 + 1.6);
    aegis.attackCd = 0;
    until(w, (x) => x.e === 'telegraph' && x.src === aegis.id);
    expect(aegis.attack).toMatchObject({ type: 'melee' });
    w.drainEvents();
    strikeEnemy(w, h, aegis, ENEMIES.aegis.poise * (aegis.maxHp / ENEMIES.aegis.hp) + 1, 'secondary', hitOpts(h));
    expect(aegis.dead).toBe(false);
    expect(aegis.attack).toBeNull();
    const ev = stepN(w, 2);
    expect(of(ev, 'dome')).toEqual([{ e: 'dome', id: aegis.id, on: false, r: AE.DOME_RADIUS }]);
    expect(struck(w, inside)).toBeCloseTo(100, 6);

    const b = scene();
    stepN(b.w, 3);
    b.w.drainEvents();
    killEnemy(b.w, b.aegis, 0);
    expect(of(b.w.drainEvents(), 'dome')).toEqual([{ e: 'dome', id: b.aegis.id, on: false, r: AE.DOME_RADIUS }]);
    stepN(b.w, 2);
    expect(struck(b.w, b.inside)).toBeCloseTo(100, 6);
    expect(of(stepN(b.w, seconds(AE.DOME_REARM_SECONDS + 1)), 'dome')).toEqual([]);
  });

  it('is slow, sturdy and swings a weak, telegraphed arc', () => {
    expect(ENEMIES.aegis.speed).toBeLessThan(ENEMIES.warrior.speed);
    expect(ENEMIES.aegis.hp).toBeGreaterThan(ENEMIES.warrior.hp);
    expect(ENEMIES.aegis.damage).toBeLessThan(ENEMIES.warrior.damage);
    const { w } = arena();
    const aegis = live(w, 'aegis', 0, 1.8);
    const tele = of(until(w, (x) => x.e === 'telegraph'), 'telegraph')[0]!;
    expect(tele).toMatchObject({ shape: 'arc', src: aegis.id });
    expect(hits(stepN(w, seconds(ENEMIES.aegis.windup) + 2), 'p', 0)[0]?.dmg).toBe(ENEMIES.aegis.damage);
  });
});

describe('bomber', () => {
  it('runs at a hero, stops, and bursts after a telegraphed fuse: the hero and enemies inside are hurt, the bomber is gone', () => {
    const { w, h } = arena();
    const bomber = live(w, 'bomber', 0, 9);
    const bystander = dummy(w, 1.5, 1.5, 'warrior', 1000);
    const start = until(w, (x) => x.e === 'telegraph');
    expect(hits(start, 'p')).toEqual([]);
    const tele = of(start, 'telegraph')[0]!;
    expect(tele).toMatchObject({ shape: 'circle', r: BO.BLAST_RADIUS, src: bomber.id });
    expect(tele.dur).toBeCloseTo(ENEMIES.bomber.windup, 6);
    expect(casts(start)).toContain('fuse');
    expect(Math.hypot(bomber.x, bomber.z)).toBeLessThanOrEqual(ENEMIES.bomber.attackRange + 0.3);
    const fuse = stepN(w, seconds(ENEMIES.bomber.windup) - 2);
    expect(hits(fuse, 'p')).toEqual([]);
    const boom = stepN(w, 4);
    expect(of(boom, 'aoe')).toContainEqual({ e: 'aoe', x: tele.x, z: tele.z, r: BO.BLAST_RADIUS, el: null, hostile: true });
    expect(hits(boom, 'p', 0).map((x) => x.dmg)).toEqual([ENEMIES.bomber.damage]);
    expect(h.hp).toBe(5000 - ENEMIES.bomber.damage);
    expect(1000 - bystander.hp).toBeCloseTo(ENEMIES.bomber.damage * BO.ENEMY_DAMAGE_MUL * w.hpMul, 6);
    expect(bomber.dead).toBe(true);
    expect(of(boom, 'kill')).toContainEqual(expect.objectContaining({ id: bomber.id, by: -1 }));
    // It burst by itself: no second burst afterwards.
    const after = stepN(w, seconds(BO.DEATH_BLAST_DELAY + 1));
    expect(of(after, 'telegraph')).toEqual([]);
    expect(hits(after, 'p')).toEqual([]);
  });

  it('the burst is avoided by dashing through it or by walking out', () => {
    for (const how of ['dash', 'walk'] as const) {
      const { w, h, pad } = arena();
      live(w, 'bomber', 0, 6);
      let lands = -1;
      const ev: GameEvent[] = [];
      for (let i = 0; i < seconds(8); i++) {
        const left = lands - w.tick;
        const dashNow = how === 'dash' && lands >= 0 && left === 3;
        const tick = pad.hold(how === 'walk' && lands >= 0 ? { moveX: 1 } : dashNow ? { moveX: 1, buttons: BTN.DASH } : {}, 1);
        ev.push(...tick);
        const tele = of(tick, 'telegraph')[0];
        if (tele && lands < 0) lands = w.tick + seconds(tele.dur);
        if (lands >= 0 && w.tick > lands + 5) break;
      }
      expect(lands, how).toBeGreaterThan(0);
      expect(of(ev, 'aoe').filter((a) => a.hostile), how).toHaveLength(1);
      expect(hits(ev, 'p'), how).toEqual([]);
      expect(h.hp, how).toBe(5000);
    }
    expect(DASH.DURATION).toBeGreaterThan(0.1);
  });

  it('a stun stops the fuse; a slain bomber bursts after DEATH_BLAST_DELAY with a telegraph, hurting heroes and enemies', () => {
    const { w, h } = arena();
    const bomber = live(w, 'bomber', 0, 1.5);
    until(w, (x) => x.e === 'telegraph');
    stunEnemy(bomber, 2);
    expect(bomber.attack).toBeNull();
    const calm = stepN(w, seconds(1.5));
    expect(of(calm, 'aoe')).toEqual([]);
    expect(h.hp).toBe(5000);
    const near = dummy(w, bomber.x + 1.5, bomber.z, 'warrior', 1000);
    w.drainEvents();
    killEnemy(w, bomber, 0);
    const death = w.drainEvents();
    const tele = of(death, 'telegraph');
    expect(tele).toHaveLength(1);
    expect(tele[0]).toMatchObject({ shape: 'circle', x: bomber.x, z: bomber.z, r: BO.BLAST_RADIUS, dur: BO.DEATH_BLAST_DELAY });
    expect(tele[0]!.src).toBeUndefined();
    const wait = stepN(w, seconds(BO.DEATH_BLAST_DELAY) - 2);
    expect(hits(wait, 'p')).toEqual([]);
    const boom = stepN(w, 4);
    expect(hits(boom, 'p', 0).map((x) => x.dmg)).toEqual([ENEMIES.bomber.damage]);
    expect(1000 - near.hp).toBeCloseTo(ENEMIES.bomber.damage * BO.ENEMY_DAMAGE_MUL, 6);
  });

  it('one bomber sets off the next; a hero who killed it from range is safe', () => {
    const { w, h } = arena();
    place(w, 0, 0, 12);
    const a = live(w, 'bomber', 0, -5);
    const b = live(w, 'bomber', 1.2, -5);
    a.stunTime = 99;
    b.stunTime = 99;
    w.drainEvents();
    killEnemy(w, a, 0);
    expect(of(w.drainEvents(), 'telegraph')).toHaveLength(1);
    const ev = stepN(w, seconds(2 * BO.DEATH_BLAST_DELAY + 0.5));
    expect(b.dead).toBe(true);
    expect(of(ev, 'aoe').filter((x) => x.hostile)).toHaveLength(2);
    // The second death burst is announced as well (the first was announced when the first bomber fell).
    expect(of(ev, 'telegraph')).toHaveLength(1);
    expect(h.hp).toBe(5000);
  });
});

describe('necromancer', () => {
  it('raises RAISE_COUNT minions with a cast that is announced, up to MAX_RAISED; they crumble when it dies', () => {
    const { w, h } = arena();
    place(w, 0, 0, 12);
    const necro = live(w, 'necromancer', 0, 12 - NE.KEEP_DISTANCE);
    necro.specialCd = 0;
    w.drainEvents();
    const start = until(w, isCast('raise'));
    expect(necro.attack).toMatchObject({ type: 'raise' });
    expect(necro.anim).toBe('summon');
    expect(of(start, 'spawn')).toEqual([]);
    const cast = stepN(w, seconds(ENEMIES.necromancer.windup) + 2);
    const raised = of(cast, 'spawn');
    expect(raised).toHaveLength(NE.RAISE_COUNT);
    expect(raised.every((s) => s.kind === 'minion')).toBe(true);
    const mine = (): Enemy[] => w.enemies.filter((e) => e.master === necro.id && !e.dead);
    expect(mine()).toHaveLength(NE.RAISE_COUNT);
    expect(mine().every((e) => e.summoned)).toBe(true);
    // Up to the cap, never beyond, at its own pace.
    expect(casts(stepN(w, seconds(ENEMIES.necromancer.cooldown) - 60))).not.toContain('raise');
    for (let i = 0; i < seconds(60); i++) { h.invuln = 1; w.step(); expect(mine().length).toBeLessThanOrEqual(NE.MAX_RAISED); }
    expect(mine()).toHaveLength(NE.MAX_RAISED);
    // A fallen minion is replaced.
    killEnemy(w, mine()[0]!, 0);
    for (let i = 0; i < seconds(ENEMIES.necromancer.cooldown + 3); i++) { h.invuln = 1; w.step(); }
    expect(mine()).toHaveLength(NE.MAX_RAISED);
    const other = dummy(w, 5, 5, 'minion', 100);
    w.drainEvents();
    killEnemy(w, necro, 0);
    const kills = of(w.drainEvents(), 'kill');
    expect(kills).toHaveLength(1 + NE.MAX_RAISED);
    expect(mine()).toHaveLength(0);
    expect(other.dead).toBe(false);
    expect(ENEMIES.necromancer.damage).toBe(0);
  });

  it('a stagger interrupts the raise; it keeps its distance and never attacks', () => {
    const { w, h } = arena();
    const necro = live(w, 'necromancer', 0, 9);
    necro.specialCd = 0;
    until(w, isCast('raise'));
    strikeEnemy(w, h, necro, ENEMIES.necromancer.poise + 5, 'secondary', hitOpts(h));
    expect(necro.attack).toBeNull();
    const ev = stepN(w, seconds(ENEMIES.necromancer.windup));
    expect(of(ev, 'spawn')).toEqual([]);
    // Cornered by the hero it backs off.
    necro.specialCd = 99;
    necro.x = 0;
    necro.z = 3;
    necro.stunTime = 0;
    const all = stepN(w, seconds(3));
    expect(Math.hypot(necro.x, necro.z)).toBeGreaterThan(5);
    expect(of(all, 'telegraph')).toEqual([]);
    expect(h.hp).toBe(5000);
  });
});

describe('reaver', () => {
  it('leaps onto the hero furthest from the fight with a telegraphed landing circle, then fights that hero', () => {
    const { w } = arena(['knight', 'mage']);
    place(w, 0, 0, 0);
    place(w, 1, 0, 10);
    // The pack stands at the knight; the mage is the backline.
    dummy(w, 1, -1, 'minion');
    dummy(w, -1, -1, 'minion');
    const reaver = live(w, 'reaver', 0, -2);
    reaver.specialCd = 0;
    const start = until(w, (x) => x.e === 'telegraph', 10);
    const tele = of(start, 'telegraph')[0]!;
    expect(tele).toMatchObject({ shape: 'circle', r: RE.LEAP_RADIUS, src: reaver.id });
    expect(tele.dur).toBeCloseTo(RE.LEAP_AIR_TIME, 6);
    expect(Math.hypot(tele.x - 0, tele.z - 10)).toBeLessThan(0.01);
    expect(of(start, 'cast').find((c) => c.ability === 'reaver_leap')).toMatchObject({ who: { t: 'e', id: reaver.id }, x: tele.x, z: tele.z });
    expect(reaver.anim).toBe('leap');
    // It flies there in a straight line; nothing is hurt on the way.
    const mid = stepN(w, seconds(RE.LEAP_AIR_TIME / 2));
    expect(hits(mid, 'p')).toEqual([]);
    expect(reaver.z).toBeGreaterThan(2);
    expect(reaver.z).toBeLessThan(8);
    const landed = stepN(w, seconds(RE.LEAP_AIR_TIME / 2) + 2);
    expect(of(landed, 'aoe')).toContainEqual({ e: 'aoe', x: tele.x, z: tele.z, r: RE.LEAP_RADIUS, el: null, hostile: true });
    expect(hits(landed, 'p').map((x) => [x.target.id, x.dmg])).toEqual([[1, RE.LEAP_DAMAGE]]);
    expect(Math.hypot(reaver.x - tele.x, reaver.z - tele.z)).toBeLessThan(0.5);
    // Quick melee on the hero it jumped at, announced as an arc.
    const fight = until(w, (x) => x.e === 'telegraph' && x.shape === 'arc');
    expect(of(fight, 'telegraph').at(-1)).toMatchObject({ shape: 'arc', src: reaver.id });
    expect(reaver.attack).toMatchObject({ type: 'melee', target: 1 });
    expect(reaver.specialCd).toBeGreaterThan(RE.LEAP_COOLDOWN - 3);
    expect(ENEMIES.reaver.hp).toBeLessThan(ENEMIES.warrior.hp);
  });

  it('whoever leaves the circle in time is not hurt; a stun in the air cancels the landing', () => {
    const { w } = arena(['knight']);
    const reaver = live(w, 'reaver', 0, -9);
    reaver.specialCd = 0;
    until(w, (x) => x.e === 'telegraph', 10);
    place(w, 0, RE.LEAP_RADIUS + 1, 0);
    const ev = stepN(w, seconds(RE.LEAP_AIR_TIME) + 3);
    expect(of(ev, 'aoe').filter((a) => a.hostile)).toHaveLength(1);
    expect(hits(ev, 'p')).toEqual([]);

    const b = arena(['knight']);
    const r = live(b.w, 'reaver', 0, -9);
    r.specialCd = 0;
    until(b.w, (x) => x.e === 'telegraph', 10);
    stepN(b.w, 5);
    stunEnemy(r, 1);
    const after = stepN(b.w, seconds(RE.LEAP_AIR_TIME + 0.5));
    expect(of(after, 'aoe')).toEqual([]);
    expect(hits(after, 'p')).toEqual([]);
    expect(r.specialCd).toBeGreaterThan(0);
  });

  it('only leaps between LEAP_MIN_DISTANCE and LEAP_MAX_DISTANCE', () => {
    const { w } = arena(['knight']);
    const reaver = live(w, 'reaver', 0, RE.LEAP_MIN_DISTANCE - 2.5);
    reaver.specialCd = 0;
    const ev = stepN(w, seconds(1.5));
    expect(casts(ev)).not.toContain('reaver_leap');
    expect(of(ev, 'telegraph').every((t) => t.shape === 'arc')).toBe(true);
  });
});

describe('warded enemies', () => {
  const warded = (w: World, ward: ElementId, x = 0, z = 3): Enemy => {
    const e = w.spawnEnemy('warrior', x, z, { ward })!;
    e.spawnTime = 0;
    e.stunTime = 1e9;
    e.hp = 1000;
    e.maxHp = 1000;
    e.shieldHp = 0;
    return e;
  };

  it('`spawn` names the ward; bosses and champions are never warded', () => {
    const { w } = arena();
    const e = w.spawnEnemy('archer', 0, 5, { ward: 'rime' })!;
    expect(e.ward).toBe('rime');
    expect(of(w.drainEvents(), 'spawn')).toEqual([{ e: 'spawn', id: e.id, kind: 'archer', x: e.x, z: e.z, elite: false, ward: 'rime' }]);
    const plain = w.spawnEnemy('archer', 2, 5)!;
    expect(plain.ward).toBeNull();
    expect('ward' in of(w.drainEvents(), 'spawn')[0]!).toBe(false);
    for (const kind of ['champion', 'regent', 'matron', 'stalker'] as EnemyKind[]) {
      const boss = w.spawnEnemy(kind, 0, -8, { ward: 'ember' })!;
      expect(boss.ward, kind).toBeNull();
      expect('ward' in of(w.drainEvents(), 'spawn')[0]!).toBe(false);
    }
  });

  it('the warded element never becomes a status on it (hits, direct application), the damage of the hit still lands; `warded` is sent at most once per second', () => {
    for (const el of ELEMENT_IDS) {
      const { w, h } = arena();
      const e = warded(w, el);
      w.drainEvents();
      const before = e.hp;
      strikeEnemy(w, h, e, 40, 'primary', hitOpts(h));
      applyElement(w, e, el, h, 1);
      setStatus(w, e, el, h, 1);
      setStatus(w, e, el, null, 1);
      expect(e.status, el).toBeNull();
      expect(before - e.hp).toBeGreaterThan(30);
      const ev = w.drainEvents();
      expect(of(ev, 'status')).toEqual([]);
      expect(of(ev, 'warded')).toEqual([{ e: 'warded', id: e.id, el, x: e.x, z: e.z, by: 0 }]);
      expect(w.getSnapshotBody().enemies[0]!.flags & (EF.BURN | EF.CHILL | EF.SHOCK | EF.WITHER)).toBe(0);
      // Rate limit: nothing for a second, then again.
      for (let i = 0; i < seconds(SIM.WARDED_EVENT_SECONDS) - 2; i++) { w.step(); applyElement(w, e, el, h, 1); }
      expect(of(w.drainEvents(), 'warded')).toEqual([]);
      stepN(w, 4);
      applyElement(w, e, el, h, 1);
      expect(of(w.drainEvents(), 'warded')).toHaveLength(1);
      // Every other element works as usual.
      const other = ELEMENT_IDS.find((x) => x !== el)!;
      applyElement(w, e, other, h, 1);
      expect(e.status).toBe(other);
    }
  });

  it('a hit with the warded element does not detonate another status on it', () => {
    const { w, h } = arena();
    const e = warded(w, 'storm');
    applyElement(w, e, 'ember', h, 1);
    w.drainEvents();
    const hp = e.hp;
    applyElement(w, e, 'storm', h, 1);
    const ev = w.drainEvents();
    expect(of(ev, 'resonance')).toEqual([]);
    expect(e.status).toBe('ember');
    expect(e.hp).toBe(hp);
    expect(of(ev, 'warded')).toHaveLength(1);
    expect(h.run.resonances).toBe(0);
    // A third element detonates it normally (the burst consumes ember and applies rime: no storm involved).
    applyElement(w, e, 'rime', h, 1);
    expect(of(w.drainEvents(), 'resonance')).toHaveLength(1);
    expect(e.hp).toBeLessThan(hp);
    expect(e.status).toBe('rime');
  });

  it('a Resonance burst that consumes or applies the warded element passes it by: no damage, no status, no reaction effect, and a `warded` event', () => {
    for (const [ward, hurt] of [['rime', false], ['ember', false], ['storm', true], ['umbra', true]] as [ElementId, boolean][]) {
      const { w, h } = arena();
      const carrier = dummy(w, 0, 3, 'minion', 1000);
      const near = warded(w, ward, 1.5, 3);
      const plain = dummy(w, -1.5, 3, 'minion', 1000);
      near.stunTime = 0;
      applyElement(w, carrier, 'ember', h, 1);
      w.drainEvents();
      // Ember consumed, rime applied: Shatter (stuns).
      applyElement(w, carrier, 'rime', h, 1);
      const ev = w.drainEvents();
      expect(of(ev, 'resonance')).toHaveLength(1);
      expect(plain.hp, ward).toBeLessThan(1000);
      expect(plain.status, ward).toBe('rime');
      if (hurt) {
        expect(near.hp, ward).toBeLessThan(1000);
        expect(near.status, ward).toBe('rime');
        expect(of(ev, 'warded')).toEqual([]);
      } else {
        expect(near.hp, ward).toBe(1000);
        expect(near.status, ward).toBeNull();
        expect(near.stunTime, ward).toBe(0);
        expect(hits(ev, 'e', near.id), ward).toEqual([]);
        expect(of(ev, 'warded'), ward).toEqual([{ e: 'warded', id: near.id, el: ward, x: near.x, z: near.z, by: 0 }]);
      }
    }
    expect(STATUS.RESONANCE.RADIUS).toBeGreaterThan(1.5);
  });

  it('an `armored` warded elite keeps its guard when the burst passes it by; a Void Arc does not leap to an enemy warded against storm or umbra', () => {
    const { w, h } = arena();
    const carrier = dummy(w, 0, 3, 'minion', 1000);
    const elite = w.spawnEnemy('warrior', 1.5, 3, { elite: true, affix: 'armored', ward: 'rime' })!;
    elite.spawnTime = 0;
    applyElement(w, carrier, 'ember', h, 1);
    applyElement(w, carrier, 'rime', h, 1);
    expect(elite.armored).toBe(true);
    expect(of(w.drainEvents(), 'shieldBreak')).toEqual([]);

    const v = arena();
    const source = dummy(v.w, 0, 3, 'minion', 1000);
    const wardedFar = warded(v.w, 'umbra', 0, 9);
    applyElement(v.w, source, 'storm', v.h, 1);
    v.w.drainEvents();
    applyElement(v.w, source, 'umbra', v.h, 1);
    const ev = v.w.drainEvents();
    expect(of(ev, 'resonance')).toHaveLength(1);
    expect(casts(ev)).not.toContain('voidarc');
    expect(wardedFar.hp).toBe(1000);
    const open = dummy(v.w, 0, 8, 'minion', 1000);
    source.resonanceCd = 0;
    applyElement(v.w, source, 'storm', v.h, 1);
    expect(casts(v.w.drainEvents())).toContain('voidarc');
    expect(open.hp).toBeLessThan(1000);
    expect(wardedFar.hp).toBe(1000);
  });

  it('hazards and burning neighbours cannot set a warded enemy ablaze', () => {
    const { w, h } = arena();
    const e = warded(w, 'ember');
    setStatus(w, e, 'ember', null, 1);
    expect(e.status).toBeNull();
    // No `warded` event without a hero behind it.
    expect(of(w.drainEvents(), 'warded')).toEqual([]);
    expect(h.hp).toBe(5000);
  });
});

describe('wards in waves', () => {
  it('share per chamber and depth as in ENEMY_TUNING.WARD', () => {
    const W = ENEMY_TUNING.WARD;
    expect(wardShare(W.FROM_CHAMBER - 1, 5)).toBe(0);
    expect(wardShare(W.FROM_CHAMBER, 0)).toBe(W.SHARE);
    expect(wardShare(W.FROM_CHAMBER, 1)).toBeCloseTo(W.SHARE + W.SHARE_PER_DEPTH, 6);
    expect(wardShare(7, 99)).toBe(W.MAX_SHARE);
  });

  it('from chamber 4 on some of every larger group is warded, never all of it, never a boss; before that nobody', () => {
    const spawnsOf = (chamber: number, seed: number, depth = 0): Extract<GameEvent, { e: 'spawn' }>[][] => {
      const w = new World();
      w.addPlayer(0, 'knight', 'A');
      w.addPlayer(1, 'mage', 'B');
      w.start(0, seed, chamber, { objective: 'slay' });
      if (depth > 0) { w.run.depth = depth; }
      const waves: Extract<GameEvent, { e: 'spawn' }>[][] = [];
      for (let i = 0; i < seconds(70) && w.run.phase === 'combat'; i++) {
        for (const h of w.heroes) h.invuln = 1;
        // Kill a wave only once it has fully risen.
        if (w.director.queue.length === 0 && w.enemies.every((e) => e.dead || e.spawnTime <= 0)) {
          for (const e of w.enemies) if (!e.dead) killEnemy(w, e, 0, true);
        }
        w.step();
        for (const ev of w.drainEvents()) {
          if (ev.e === 'wave') waves.push([]);
          if (ev.e === 'spawn' && waves.length > 0) waves[waves.length - 1]!.push(ev);
        }
      }
      return waves;
    };
    for (let seed = 1; seed <= 12; seed++) {
      for (const chamber of [1, 2]) for (const wave of spawnsOf(chamber, seed)) expect(wave.every((s) => s.ward === undefined)).toBe(true);
    }
    let warded = 0;
    let total = 0;
    const elements = new Set<string>();
    for (let seed = 1; seed <= 20; seed++) {
      for (const chamber of [4, 5, 6, 7]) {
        for (const wave of spawnsOf(chamber, seed)) {
          const file = wave.filter((s) => ENEMIES[s.kind].cost > 0);
          const bosses = wave.filter((s) => ENEMIES[s.kind].cost === 0);
          for (const b of bosses) expect(b.ward).toBeUndefined();
          const n = file.filter((s) => s.ward !== undefined).length;
          if (file.length > 0) expect(n, `seed ${seed} chamber ${chamber}`).toBeLessThan(file.length);
          if (file.length >= 5) expect(n).toBeGreaterThan(0);
          for (const s of file) if (s.ward) elements.add(s.ward);
          warded += n;
          total += file.length;
        }
      }
    }
    expect(elements).toEqual(new Set(ELEMENT_IDS));
    expect(warded / total).toBeGreaterThan(ENEMY_TUNING.WARD.SHARE - 0.06);
    expect(warded / total).toBeLessThan(ENEMY_TUNING.WARD.SHARE + 0.06);
  }, 120000);
});

describe('wave composition with the new kinds', () => {
  const cost = (kinds: EnemyKind[]): number => kinds.reduce((a, k) => a + ENEMIES[k].cost, 0);
  const count = (kinds: EnemyKind[], k: EnemyKind): number => kinds.filter((x) => x === k).length;

  it('minChamber, budget, at most one aegis / necromancer / shaman alive per two heroes, never a support-only wave', () => {
    const seen = new Set<EnemyKind>();
    for (let seed = 1; seed <= 1500; seed++) {
      const chamber = seed % RUN.CHAMBERS.length;
      const party = 1 + (seed % 4);
      const budget = waveBudget(chamber, party);
      const kinds = composeWave(new Rng(seed), chamber, budget, party, WORLD.MAX_ENEMIES);
      const where = `seed ${seed}`;
      expect(cost(kinds), where).toBeLessThanOrEqual(budget + 1e-6);
      for (const k of kinds) { expect(ENEMIES[k].minChamber, where).toBeLessThanOrEqual(chamber); seen.add(k); }
      const cap = Math.ceil(party / 2);
      expect(cap).toBe(Math.ceil(party / DIRECTOR.HEROES_PER_AEGIS));
      for (const k of ['aegis', 'necromancer', 'shaman'] as EnemyKind[]) expect(count(kinds, k), `${where} ${k}`).toBeLessThanOrEqual(cap);
      expect(kinds.some((k) => !SUPPORT_KINDS.has(k)), where).toBe(true);
      const support = kinds.filter((k) => SUPPORT_KINDS.has(k));
      expect(cost(support), where).toBeLessThanOrEqual(budget * DIRECTOR.SUPPORT_BUDGET_SHARE + 1e-6);
      // What already stands counts against the caps.
      const full = composeWave(new Rng(seed), chamber, budget, party, WORLD.MAX_ENEMIES, 'crypt', { aegis: cap, necromancer: cap, shaman: cap });
      expect(full.some((k) => SUPPORT_KINDS.has(k)), where).toBe(false);
      const one = composeWave(new Rng(seed), chamber, budget, party, WORLD.MAX_ENEMIES, 'crypt', { aegis: cap - 1, necromancer: cap, shaman: cap });
      expect(count(one, 'aegis'), where).toBeLessThanOrEqual(1);
      // Even a group cut down to a single enemy by the cap is somebody who fights.
      const single = composeWave(new Rng(seed), chamber, budget, party, 1);
      expect(single, where).toHaveLength(1);
      expect(SUPPORT_KINDS.has(single[0]!), where).toBe(false);
    }
    expect([...seen].sort()).toEqual(ENEMY_KINDS.filter((k) => ENEMIES[k].cost > 0).sort());
    expect([...SUPPORT_KINDS].sort()).toEqual(['aegis', 'necromancer', 'shaman']);
  });

  it('in a real run the caps hold across waves (alive enemies count)', () => {
    for (const [classes, cap] of [[['knight'], 1], [['knight', 'mage', 'rogue', 'barbarian'], 2]] as [Parameters<typeof sandbox>[0], number][]) {
      for (let seed = 1; seed <= 8; seed++) {
        const w = new World();
        classes!.forEach((cls, slot) => w.addPlayer(slot, cls, `P${slot}`));
        w.start(0, seed, 5, { objective: 'slay' });
        // Nothing is killed: waves pile up through the wave timeout.
        for (let i = 0; i < seconds(100) && w.run.phase === 'combat'; i++) {
          for (const h of w.heroes) h.invuln = 1;
          w.step();
          for (const k of ['aegis', 'necromancer', 'shaman'] as EnemyKind[]) {
            expect(w.enemies.filter((e) => e.kind === k && !e.dead).length, `${k} seed ${seed}`).toBeLessThanOrEqual(cap);
          }
        }
        w.drainEvents();
        expect(w.run.wave).toBeGreaterThanOrEqual(3);
      }
    }
  }, 120000);
});

describe('interrupt event', () => {
  it('is sent once when a stun or stagger breaks a wind-up (fuse, mend, raise, a melee swing), not for idle enemies and not for kills', () => {
    const interrupts = (ev: GameEvent[]): number[] => of(ev, 'interrupt').map((x) => x.id);
    // Bomber fuse, stunned.
    const a = arena();
    const bomber = live(a.w, 'bomber', 0, 1.5);
    until(a.w, (x) => x.e === 'telegraph');
    stunEnemy(bomber, 1);
    stunEnemy(bomber, 1.5);
    expect(interrupts(stepN(a.w, 1))).toEqual([bomber.id]);
    expect(interrupts(stepN(a.w, seconds(1)))).toEqual([]);
    // Stunning an enemy that winds nothing up says nothing.
    const idle = live(a.w, 'warrior', 10, 10);
    idle.attackCd = 99;
    stunEnemy(idle, 1);
    expect(interrupts(stepN(a.w, 3))).toEqual([]);

    // Shaman mend, staggered by damage; necromancer raise, stunned; warrior swing, staggered.
    const b = arena();
    place(b.w, 0, 0, 12);
    const hurt = dummy(b.w, 0, -6, 'warrior', 1000);
    wound(hurt, 0.4);
    const shaman = live(b.w, 'shaman', 0, -10);
    shaman.specialCd = 0;
    until(b.w, isCast('mend'));
    strikeEnemy(b.w, b.h, shaman, ENEMIES.shaman.poise + 5, 'secondary', hitOpts(b.h));
    expect(interrupts(stepN(b.w, 2))).toEqual([shaman.id]);
    const necro = live(b.w, 'necromancer', 8, 4);
    necro.specialCd = 0;
    until(b.w, isCast('raise'));
    stunEnemy(necro, 1);
    expect(interrupts(stepN(b.w, 2))).toEqual([necro.id]);

    // A wind-up that ends because the enemy dies is a kill, not an interrupt.
    const c = arena();
    const doomed = live(c.w, 'bomber', 0, 1.5);
    until(c.w, (x) => x.e === 'telegraph');
    killEnemy(c.w, doomed, 0);
    expect(interrupts(stepN(c.w, 3))).toEqual([]);
    const struck = live(c.w, 'minion', 0, -1.2);
    until(c.w, (x) => x.e === 'telegraph' && x.src === struck.id);
    strikeEnemy(c.w, c.h, struck, 100000, 'primary', hitOpts(c.h));
    expect(struck.dead).toBe(true);
    expect(interrupts(stepN(c.w, 3))).toEqual([]);
  });
});
