import { describe, expect, it } from 'vitest';
import { TICK_DT } from '@shared/constants.ts';
import { CLASSES, DASH } from '@shared/data/classes.ts';
import { ENEMIES, ENEMY_TUNING } from '@shared/data/enemies.ts';
import { AI, SIM, type Enemy, type World } from '@shared/sim/index.ts';
import { BTN, EF, type EnemyKind, type GameEvent } from '@shared/types.ts';
import { dummy, hits, live, Pad, place, sandbox, seconds, stepN } from './harness.ts';

type Telegraph = Extract<GameEvent, { e: 'telegraph' }>;

interface Scenario {
  name: string;
  kind: EnemyKind;
  /** Enemy position; the hero stands at the origin. */
  at: [number, number];
  attack: string;
  shape: Telegraph['shape'];
  /** Expected telegraph duration. */
  dur: number;
  /** Extra seconds after the windup in which damage may still arrive (projectile flight, charge travel). */
  travel: number;
  prepare?: (e: Enemy) => void;
}

const RG = ENEMY_TUNING.REGENT;
const CH = ENEMY_TUNING.CHAMPION;
const noSummon = (e: Enemy): void => { e.boss!.summonCd = 999; e.boss!.gap = 0; };

const SCENARIOS: Scenario[] = [
  { name: 'minion swing', kind: 'minion', at: [0, 1.3], attack: 'melee', shape: 'arc', dur: ENEMIES.minion.windup, travel: 0 },
  { name: 'warrior swing', kind: 'warrior', at: [0, 2], attack: 'melee', shape: 'arc', dur: ENEMIES.warrior.windup, travel: 0 },
  { name: 'archer arrow', kind: 'archer', at: [0, 8], attack: 'shoot', shape: 'line', dur: ENEMIES.archer.windup, travel: 1.2 },
  { name: 'mage hex blast', kind: 'mage', at: [0, 9], attack: 'blast', shape: 'circle', dur: ENEMIES.mage.windup, travel: 0, prepare: (e) => { e.blinkCd = 999; } },
  { name: 'champion sweep', kind: 'champion', at: [0, 3], attack: 'sweep', shape: 'arc', dur: ENEMIES.champion.windup, travel: 0, prepare: noSummon },
  { name: 'champion charge', kind: 'champion', at: [0, 8], attack: 'charge', shape: 'line', dur: CH.CHARGE_WINDUP, travel: 0.8, prepare: (e) => { noSummon(e); e.boss!.chargeCd = 0; } },
  { name: 'regent sweep', kind: 'regent', at: [0, 4], attack: 'sweep', shape: 'arc', dur: ENEMIES.regent.windup, travel: 0, prepare: (e) => { noSummon(e); e.boss!.volleyCd = 999; } },
  { name: 'regent charge', kind: 'regent', at: [0, 9], attack: 'charge', shape: 'line', dur: RG.CHARGE_WINDUP, travel: 0.8, prepare: (e) => { noSummon(e); e.boss!.chargeCd = 0; e.boss!.volleyCd = 999; } },
  { name: 'regent hex volley', kind: 'regent', at: [0, 3], attack: 'volley', shape: 'circle', dur: RG.VOLLEY_WINDUP, travel: 0.6, prepare: (e) => { noSummon(e); e.boss!.chargeCd = 999; e.boss!.volleyCd = 0; e.def = { ...e.def, attackRange: 0 }; } },
  { name: 'regent grave slam', kind: 'regent', at: [0, 9], attack: 'slam', shape: 'circle', dur: RG.SLAM_WINDUP, travel: 0, prepare: (e) => { noSummon(e); e.boss!.phase = 3; e.hp = e.maxHp * 0.2; e.boss!.slamCd = 0; e.boss!.chargeCd = 999; e.boss!.volleyCd = 999; } },
];

/** Runs until the enemy's first telegraph; returns it together with the world. */
function untilTelegraph(s: Scenario): { w: World; e: Enemy; tele: Telegraph; pad: Pad } {
  const w = sandbox(['knight'], 3);
  place(w, 0, 0, 0);
  const h = w.hero(0)!;
  h.maxHp = 1000;
  h.hp = 1000;
  const e = live(w, s.kind, s.at[0], s.at[1]);
  s.prepare?.(e);
  const pad = new Pad(w);
  w.drainEvents();
  for (let i = 0; i < seconds(6); i++) {
    const ev = pad.hold({}, 1);
    expect(hits(ev, 'p'), `${s.name}: damage before any telegraph`).toHaveLength(0);
    const tele = ev.find((x): x is Telegraph => x.e === 'telegraph');
    if (tele) return { w, e, tele, pad };
  }
  throw new Error(`${s.name}: no telegraph within 6 s`);
}

function insideShape(t: Telegraph, x: number, z: number): boolean {
  const dx = x - t.x;
  const dz = z - t.z;
  if (t.shape === 'circle') return Math.hypot(dx, dz) <= t.r;
  const dirX = Math.sin(t.rot);
  const dirZ = Math.cos(t.rot);
  if (t.shape === 'line') {
    const along = dx * dirX + dz * dirZ;
    return along >= 0 && along <= t.r && Math.abs(dx * dirZ - dz * dirX) <= t.w / 2;
  }
  const d = Math.hypot(dx, dz);
  if (d > t.r) return false;
  const off = Math.abs(Math.atan2(dirX * dz - dirZ * dx, dirX * dx + dirZ * dz));
  return off <= t.w / 2;
}

/**
 * A point just outside the telegraph (1 m margin), reachable inside the room.
 * The volley is the one attack whose danger is the projectiles themselves, not the announced circle: its safe
 * spot is a gap between two orb rays.
 */
function safeSpot(t: Telegraph, w: World, s: Scenario): [number, number] {
  if (s.attack === 'volley') {
    const gap = t.rot + Math.PI / RG.VOLLEY_ORBS / 2 + Math.PI;
    return [t.x + Math.sin(gap) * 12, t.z + Math.cos(gap) * 12];
  }
  const dirX = Math.sin(t.rot);
  const dirZ = Math.cos(t.rot);
  const candidates: [number, number][] = t.shape === 'line'
    ? [[t.w / 2 + 1.2, 0], [-(t.w / 2 + 1.2), 0]].map(([side]) => [dirZ * side!, -dirX * side!] as [number, number])
    : [[t.x - dirX * (t.r + 1.2), t.z - dirZ * (t.r + 1.2)], [t.x + (t.r + 1.2), t.z], [t.x - (t.r + 1.2), t.z], [t.x, t.z - (t.r + 1.2)]];
  for (const [x, z] of candidates) {
    if (Math.abs(x) < w.room.w / 2 - 1 && Math.abs(z) < w.room.d / 2 - 1 && !insideShape(t, x, z)) return [x, z];
  }
  throw new Error('no safe spot');
}

describe('telegraph fairness: every enemy attack', () => {
  for (const s of SCENARIOS) {
    it(`${s.name}: announced, lands only after the windup, and only on heroes still inside`, () => {
      // --- A: the hero stays put and is hit, but not before the windup has elapsed.
      const a = untilTelegraph(s);
      expect(a.e.attack?.type ?? (a.e.boss?.slams.length ? 'slam' : ''), s.name).toBe(s.attack);
      expect(a.tele.shape).toBe(s.shape);
      expect(a.tele.dur).toBeCloseTo(s.dur, 6);
      expect(a.tele.src).toBe(a.e.id);
      expect(insideShape(a.tele, 0, 0), `${s.name}: hero should start inside the telegraph`).toBe(true);
      const windupTicks = seconds(a.tele.dur);
      const early = a.pad.hold({}, windupTicks - 2);
      expect(hits(early, 'p'), `${s.name}: damage during the windup`).toHaveLength(0);
      const late = a.pad.hold({}, seconds(s.travel) + 4);
      expect(hits(late, 'p').length, `${s.name}: a hero who stays must be hit`).toBeGreaterThan(0);
      expect(hits(late, 'p')[0]!.by).toBe(a.e.id);

      // --- B: same seed, but the hero leaves the shape just before the windup ends: no damage at all.
      const b = untilTelegraph(s);
      expect(b.tele).toEqual(a.tele);
      b.pad.hold({}, windupTicks - 3);
      const [sx, sz] = safeSpot(b.tele, b.w, s);
      place(b.w, 0, sx, sz);
      const after = b.pad.hold({}, seconds(s.travel + (s.attack === 'volley' ? 2.5 : 0)) + 6);
      expect(hits(after, 'p'), `${s.name}: a hero who left must not be hit`).toHaveLength(0);
      expect(b.w.hero(0)!.hp).toBe(1000);
    });
  }

  it('walking out of a minion swing avoids it; so does dashing through with i-frames', () => {
    const s = SCENARIOS[0]!;
    const walk = untilTelegraph(s);
    const ev = walk.pad.hold({ moveZ: -1 }, seconds(s.dur) + 6);
    expect(hits(ev, 'p')).toHaveLength(0);

    const dash = untilTelegraph(s);
    dash.pad.hold({}, seconds(s.dur) - 4);
    // Dash on the spot against a wall-less centre: the hero ends up outside or still invulnerable when it lands.
    const ev2 = dash.pad.hold({ buttons: BTN.DASH, moveX: 1 }, 1);
    ev2.push(...dash.pad.hold({}, seconds(DASH.IFRAMES)));
    expect(hits(ev2, 'p')).toHaveLength(0);
  });

  it('the Regent\'s slam repeats and every circle is announced separately', () => {
    const s = SCENARIOS.find((x) => x.attack === 'slam')!;
    const { w, pad, tele } = untilTelegraph(s);
    const teles: Telegraph[] = [tele];
    const aoes: GameEvent[] = [];
    for (let i = 0; i < seconds(RG.SLAM_INTERVAL * RG.SLAM_REPEATS + RG.SLAM_WINDUP); i++) {
      // Keep moving in a circle so every slam lands where the hero no longer is.
      const a = (w.tick * TICK_DT) * 2.2;
      const ev = pad.hold({ moveX: Math.cos(a), moveZ: Math.sin(a) }, 1);
      for (const x of ev) { if (x.e === 'telegraph') teles.push(x); if (x.e === 'aoe' && x.hostile) aoes.push(x); }
    }
    expect(teles).toHaveLength(RG.SLAM_REPEATS);
    expect(aoes).toHaveLength(RG.SLAM_REPEATS);
    for (const t of teles) { expect(t.shape).toBe('circle'); expect(t.r).toBe(RG.SLAM_RADIUS); }
    expect(w.getSnapshotBody().enemies[0]!.flags & EF.ENRAGED).toBeTruthy();
  });

  it('the Regent\'s volley fires VOLLEY_WAVES rings of VOLLEY_ORBS orbs', () => {
    const s = SCENARIOS.find((x) => x.attack === 'volley')!;
    const { w, pad } = untilTelegraph(s);
    w.hero(0)!.invuln = 99;
    let max = 0;
    for (let i = 0; i < seconds(RG.VOLLEY_WINDUP + AI.REGENT.VOLLEY_WAVE_INTERVAL * RG.VOLLEY_WAVES) + 2; i++) {
      w.hero(0)!.invuln = 99;
      pad.hold({}, 1);
      max = Math.max(max, w.projectiles.filter((p) => p.hostile && p.kind === 'hexOrb').length);
    }
    expect(max).toBe(RG.VOLLEY_ORBS * RG.VOLLEY_WAVES);
  });
});

describe('interrupts and stuns', () => {
  it('damage above an enemy\'s poise cancels its windup (and the attack never lands)', () => {
    const w = sandbox(['knight']);
    place(w, 0, 0, 0);
    const minion = live(w, 'minion', 0, 1.3);
    const pad = new Pad(w);
    let tele: Telegraph | undefined;
    for (let i = 0; i < seconds(3) && !tele; i++) tele = pad.hold({ aim: 0 }, 1).find((x): x is Telegraph => x.e === 'telegraph');
    expect(tele).toBeDefined();
    const ev = pad.hold({ aim: 0, buttons: BTN.PRIMARY }, 1);
    ev.push(...pad.hold({ aim: 0 }, seconds(ENEMIES.minion.windup) + 3));
    expect(hits(ev, 'e', minion.id).length).toBeGreaterThan(0);
    expect(hits(ev, 'p')).toHaveLength(0);
    expect(minion.attack).toBeNull();
  });

  it('a warrior shrugs off small hits (poise) but a stun cancels its swing', () => {
    const run = (stun: boolean): number => {
      const w = sandbox(['knight']);
      place(w, 0, 0, 0);
      const h = w.hero(0)!;
      h.maxHp = 1000; h.hp = 1000;
      const warrior = live(w, 'warrior', 0, 2);
      warrior.maxHp = 5000; warrior.hp = 5000;
      const pad = new Pad(w);
      let tele: Telegraph | undefined;
      for (let i = 0; i < seconds(3) && !tele; i++) tele = pad.hold({ aim: 0 }, 1).find((x): x is Telegraph => x.e === 'telegraph');
      const ev = pad.hold({ aim: 0, buttons: stun ? BTN.SECONDARY : BTN.PRIMARY }, 1);
      ev.push(...pad.hold({ aim: 0 }, seconds(ENEMIES.warrior.windup) + 3));
      if (stun) expect(warrior.stunTime).toBeGreaterThan(0);
      return hits(ev, 'p').length;
    };
    expect(run(false)).toBe(1);
    expect(run(true)).toBe(0);
  });

  it('bosses cannot be stunned or knocked back', () => {
    const w = sandbox(['knight']);
    place(w, 0, 0, 0);
    const champion = live(w, 'champion', 0, 3);
    champion.boss!.gap = 5;
    const pad = new Pad(w);
    pad.hold({ aim: 0, buttons: BTN.SECONDARY }, 1);
    pad.hold({ aim: 0 }, seconds(0.4));
    expect(champion.hp).toBeLessThan(champion.maxHp);
    expect(champion.stunTime).toBe(0);
    expect(champion.kbX).toBe(0);
    expect(champion.kbZ).toBe(0);
  });
});

describe('warrior shield', () => {
  it('absorbs WARRIOR_SHIELD_HP of frontal damage, then breaks; hits from behind bypass it', () => {
    const w = sandbox(['knight']);
    place(w, 0, 0, 0);
    const h = w.hero(0)!;
    h.maxHp = 5000; h.hp = 5000;
    const warrior = live(w, 'warrior', 0, 2.5);
    warrior.attackCd = 999;
    expect(w.getSnapshotBody().enemies[0]!.flags & EF.SHIELDED).toBeTruthy();
    const pad = new Pad(w);
    const slash = CLASSES.knight.primary[0]!;
    const swing = (): GameEvent[] => {
      h.primaryCd = 0; h.lockTime = 0; h.comboIndex = 0;
      warrior.x = 0; warrior.z = 2.5; warrior.kbX = 0; warrior.kbZ = 0; warrior.attackCd = 999;
      const ev = pad.hold({ aim: 0, buttons: BTN.PRIMARY }, 1);
      ev.push(...pad.hold({ aim: 0 }, seconds(slash.windup) + 2));
      return ev;
    };
    const first = swing();
    expect(warrior.hp).toBe(warrior.maxHp);
    expect(hits(first, 'e', warrior.id)[0]!.dmg).toBe(0);
    expect(warrior.shieldHp).toBeCloseTo(ENEMY_TUNING.WARRIOR_SHIELD_HP - slash.damage, 6);
    const second = swing();
    expect(second).toContainEqual({ e: 'shieldBreak', id: warrior.id });
    expect(warrior.hp).toBeCloseTo(warrior.maxHp - (2 * slash.damage - ENEMY_TUNING.WARRIOR_SHIELD_HP), 6);
    expect(w.getSnapshotBody().enemies[0]!.flags & EF.SHIELDED).toBeFalsy();

    // Fresh warrior, struck from behind: the shield does not help.
    const w2 = sandbox(['knight']);
    place(w2, 0, 0, 0);
    const other = dummy(w2, 0, 2.5, 'warrior', 500);
    other.stunTime = 0;
    other.attackCd = 999;
    other.shieldHp = ENEMY_TUNING.WARRIOR_SHIELD_HP;
    const mate = w2.spawnEnemy('minion', 0, 0)!;
    void mate;
    // Make the warrior look away from the knight (its target is north of it).
    w2.addPlayer(1, 'mage', 'x');
    const pad2 = new Pad(w2);
    other.rot = 0;
    other.stunTime = 0.2;
    pad2.hold({ aim: 0, buttons: BTN.PRIMARY }, 1);
    other.stunTime = 0;
    other.recover = 5;
    other.rot = 0;
    pad2.hold({ aim: 0 }, seconds(slash.windup) + 2);
    expect(other.hp).toBeLessThan(500);
    expect(other.shieldHp).toBe(ENEMY_TUNING.WARRIOR_SHIELD_HP);
  });
});

describe('ranged enemies', () => {
  it('archers back away from a hero who closes in and keep roughly ARCHER_KEEP_DISTANCE', () => {
    const w = sandbox(['knight']);
    place(w, 0, 0, 0);
    const h = w.hero(0)!;
    h.maxHp = 9999; h.hp = 9999;
    const archer = live(w, 'archer', 0, 3);
    archer.attackCd = 999;
    stepN(w, seconds(3));
    const d = Math.hypot(archer.x - h.body.x, archer.z - h.body.z);
    expect(d).toBeGreaterThan(ENEMY_TUNING.ARCHER_KEEP_DISTANCE - AI.ARCHER_BAND - 0.5);
    // ... and approach one who is out of range.
    const far = live(w, 'archer', 14, -13);
    far.attackCd = 999;
    const before = Math.hypot(far.x, far.z);
    stepN(w, seconds(2));
    expect(Math.hypot(far.x, far.z)).toBeLessThan(before);
  });

  it('archers only shoot with a clear line; the telegraph ends at the first obstacle and so does the arrow', () => {
    const w = sandbox(['knight']);
    w.room.obstacles.push({ x: 0, z: 4, r: 1, kind: 'pillar' }, { x: 0, z: -5, r: 1, kind: 'pillar' });
    place(w, 0, 0, 0);
    const h = w.hero(0)!;
    h.invuln = 99;
    const archer = live(w, 'archer', 0, 9);
    // The pillar between them blocks the shot: the archer sidesteps until it can see the hero.
    let tele: Telegraph | undefined;
    for (let i = 0; i < seconds(4) && !tele; i++) {
      h.invuln = 99;
      tele = stepN(w, 1).find((x): x is Telegraph => x.e === 'telegraph');
      if (!tele) expect(w.projectiles).toHaveLength(0);
    }
    expect(tele).toBeDefined();
    if (!tele) return;
    expect(Math.abs(archer.x)).toBeGreaterThan(0.5);
    expect(tele.r).toBeGreaterThanOrEqual(Math.hypot(archer.x, archer.z) - 1e-6);
    expect(tele.r).toBeLessThanOrEqual(AI.ARROW_RANGE);
    // Straight shot down the middle with a pillar behind the hero: the line stops at the pillar.
    const w2 = sandbox(['knight']);
    w2.room.obstacles.push({ x: 0, z: -5, r: 1, kind: 'pillar' });
    place(w2, 0, 0, 0);
    w2.hero(0)!.invuln = 99;
    live(w2, 'archer', 0, 9);
    const t2 = stepN(w2, 2).find((x): x is Telegraph => x.e === 'telegraph')!;
    expect(t2.r).toBeCloseTo(9 + 5 - 1, 5);
    let seen = 0;
    for (let i = 0; i < seconds(3); i++) {
      w2.hero(0)!.invuln = 99;
      w2.step();
      for (const p of w2.projectiles) { seen++; expect(p.z).toBeGreaterThanOrEqual(-4 - 1e-6); expect(Math.abs(p.x)).toBeLessThan(0.01); }
      if (seen > 0 && w2.projectiles.length === 0) break;
    }
    expect(seen).toBeGreaterThan(5);
  });

  it('mages blink away when a hero gets close (on a cooldown)', () => {
    const w = sandbox(['knight']);
    place(w, 0, 0, 0);
    const h = w.hero(0)!;
    h.maxHp = 9999; h.hp = 9999;
    const mage = live(w, 'mage', 0, 2);
    mage.attackCd = 999;
    mage.blinkCd = 0;
    const ev = stepN(w, 3);
    const cast = ev.find((e) => e.e === 'cast' && e.who.t === 'e');
    expect(cast).toMatchObject({ ability: 'blink', who: { t: 'e', id: mage.id } });
    const d = Math.hypot(mage.x, mage.z);
    expect(d).toBeGreaterThanOrEqual(AI.MAGE_BLINK_MIN_HERO_DISTANCE);
    expect(mage.blinkCd).toBeGreaterThan(ENEMY_TUNING.MAGE_BLINK_COOLDOWN - 0.2);
    place(w, 0, mage.x, mage.z - 1.5);
    const again = stepN(w, seconds(1));
    expect(again.filter((e) => e.e === 'cast' && e.who.t === 'e')).toHaveLength(0);
  });
});

describe('targeting and steering', () => {
  it('targets the nearest living hero and sticks to it unless another is clearly closer', () => {
    const w = sandbox(['knight', 'mage']);
    place(w, 0, -6, 0);
    place(w, 1, 6, 0);
    for (const h of w.heroes) { h.maxHp = 9999; h.hp = 9999; }
    const warrior = live(w, 'warrior', 2, 6);
    warrior.attackCd = 999;
    stepN(w, 3);
    expect(warrior.target).toBe(1);
    // Slightly closer is not enough to steal the target ...
    const dist = (): number => Math.hypot(warrior.x - w.hero(1)!.body.x, warrior.z - w.hero(1)!.body.z);
    place(w, 0, warrior.x - dist() * 0.9, warrior.z);
    warrior.retarget = 0;
    stepN(w, 1);
    expect(warrior.target).toBe(1);
    // ... clearly closer is.
    place(w, 0, warrior.x - dist() * (AI.STICKINESS - 0.1), warrior.z);
    warrior.retarget = 0;
    stepN(w, 1);
    expect(warrior.target).toBe(0);
    // A downed target is dropped immediately.
    w.hero(0)!.state = 'downed';
    stepN(w, 1);
    expect(warrior.target).toBe(1);
  });

  it('enemies walk around obstacles and do not stack on top of each other', () => {
    const w = sandbox(['knight']);
    w.room.obstacles.push({ x: 0, z: 0, r: 1.1, kind: 'rubble' }, { x: 3.5, z: 2, r: 0.9, kind: 'pillar' }, { x: -3.5, z: 2, r: 0.9, kind: 'pillar' });
    place(w, 0, 0, 8);
    const h = w.hero(0)!;
    const pack: Enemy[] = [];
    for (let i = 0; i < 8; i++) pack.push(live(w, i % 2 ? 'minion' : 'warrior', (i - 3.5) * 0.3, -9));
    for (const e of pack) e.attackCd = 999;
    for (let i = 0; i < seconds(9); i++) { h.invuln = 1; w.step(); }
    for (const e of pack) {
      expect(Math.hypot(e.x - h.body.x, e.z - h.body.z), `${e.kind} ${e.id} should have reached the hero`).toBeLessThan(e.def.attackRange + 2.5);
      for (const o of w.room.obstacles) expect(Math.hypot(e.x - o.x, e.z - o.z)).toBeGreaterThanOrEqual(o.r + e.radius - 1e-6);
    }
    let overlaps = 0;
    for (const a of pack) for (const b of pack) if (a.id < b.id && Math.hypot(a.x - b.x, a.z - b.z) < (a.radius + b.radius) * 0.6) overlaps++;
    expect(overlaps).toBe(0);
  });

  it('limits simultaneous melee windups against one hero', () => {
    const w = sandbox(['knight']);
    place(w, 0, 0, 0);
    const h = w.hero(0)!;
    for (let i = 0; i < 10; i++) live(w, 'minion', Math.sin(i) * 1.2, Math.cos(i) * 1.2);
    let max = 0;
    for (let i = 0; i < seconds(6); i++) {
      h.invuln = 1;
      w.step();
      max = Math.max(max, w.enemies.filter((e) => e.attack?.type === 'melee').length);
    }
    expect(max).toBe(AI.MAX_MELEE_WINDUPS_PER_HERO);
  });
});

describe('bosses', () => {
  const arena = (kind: 'champion' | 'regent', heroes = 1) => {
    const w = sandbox(Array.from({ length: heroes }, (_, i) => (['knight', 'mage', 'rogue', 'barbarian'] as const)[i]!), 5);
    w.heroes.forEach((h, i) => place(w, h.slot, (i - (heroes - 1) / 2) * 3, 6));
    const boss = live(w, kind, 0, -4);
    w.drainEvents();
    return { w, boss };
  };

  it('the Regent changes phase at the thresholds, summons in phase 2 and slams in phase 3', () => {
    const { w, boss } = arena('regent');
    const h = w.hero(0)!;
    const run = (ticks: number): GameEvent[] => {
      const out: GameEvent[] = [];
      for (let i = 0; i < ticks; i++) { h.invuln = 1; w.step(); out.push(...w.drainEvents()); }
      return out;
    };
    const p1 = run(seconds(8));
    expect(p1.filter((e) => e.e === 'bossPhase')).toHaveLength(0);
    expect(p1.filter((e) => e.e === 'spawn')).toHaveLength(0);
    boss.hp = boss.maxHp * (RG.PHASE_THRESHOLDS[0] - 0.01);
    const p2 = run(seconds(8));
    expect(p2.filter((e) => e.e === 'bossPhase')).toEqual([{ e: 'bossPhase', phase: 2 }]);
    const summoned = p2.filter((e) => e.e === 'spawn');
    expect(summoned).toHaveLength(RG.SUMMON_COUNT);
    expect(summoned.every((e) => e.e === 'spawn' && e.kind === 'minion')).toBe(true);
    expect(w.enemies.filter((e) => e.summoned)).toHaveLength(RG.SUMMON_COUNT);
    expect(w.getSnapshotBody().enemies.find((e) => e.id === boss.id)!.flags & EF.ENRAGED).toBeFalsy();
    boss.hp = boss.maxHp * (RG.PHASE_THRESHOLDS[1] - 0.01);
    const p3 = run(seconds(8));
    expect(p3.filter((e) => e.e === 'bossPhase')).toEqual([{ e: 'bossPhase', phase: 3 }]);
    const slams = p3.filter((e) => e.e === 'telegraph' && e.shape === 'circle' && e.r === RG.SLAM_RADIUS);
    expect(slams.length).toBeGreaterThanOrEqual(RG.SLAM_REPEATS);
    expect(w.getSnapshotBody().enemies.find((e) => e.id === boss.id)!.flags & EF.ENRAGED).toBeTruthy();
  });

  it('the champion summons SUMMON_COUNT minions periodically', () => {
    const { w, boss } = arena('champion');
    boss.boss!.summonCd = 0;
    boss.boss!.gap = 0;
    const h = w.hero(0)!;
    let spawns = 0;
    for (let i = 0; i < seconds(3); i++) { h.invuln = 1; w.step(); spawns += w.drainEvents().filter((e) => e.e === 'spawn').length; }
    expect(spawns).toBe(CH.SUMMON_COUNT);
    expect(boss.boss!.summonCd).toBeGreaterThan(CH.SUMMON_EVERY - 3.5);
  });

  for (const kind of ['champion', 'regent'] as const) {
    for (const heroes of [1, 4]) {
      it(`${kind} vs ${heroes}: keeps attacking, never chains attacks without a gap, never gets stuck`, () => {
        const { w, boss } = arena(kind, heroes);
        w.room.obstacles.push({ x: 0, z: 1, r: 1.1, kind: 'rubble' }, { x: 4, z: 3, r: 0.9, kind: 'pillar' }, { x: -4, z: 3, r: 0.9, kind: 'pillar' });
        if (kind === 'regent') boss.hp = boss.maxHp * 0.5;
        // Attack "episodes": a windup, an active charge, or a recovery. Between two episodes the boss must idle.
        let busy = false;
        let lastEnd = -1;
        let attacks = 0;
        let minGap = Infinity;
        let minDist = Infinity;
        let stillTicks = 0;
        let px = boss.x;
        let pz = boss.z;
        for (let i = 0; i < seconds(60); i++) {
          for (const h of w.heroes) h.invuln = 1;
          w.step();
          w.drainEvents();
          const b = boss.boss!;
          const now = boss.attack !== null || b.chargeLeft > 0 || boss.recover > 0;
          if (now && !busy) {
            attacks++;
            if (lastEnd >= 0) minGap = Math.min(minGap, (w.tick - lastEnd) * TICK_DT);
          }
          if (!now && busy) lastEnd = w.tick;
          busy = now;
          for (const h of w.heroes) minDist = Math.min(minDist, Math.hypot(h.body.x - boss.x, h.body.z - boss.z));
          const moved = Math.hypot(boss.x - px, boss.z - pz);
          px = boss.x; pz = boss.z;
          // "Stuck" = wants to move (chasing, far from every hero) but does not.
          const far = w.heroes.every((h) => Math.hypot(h.body.x - boss.x, h.body.z - boss.z) > boss.def.attackRange + 1);
          stillTicks = !now && far && moved < 0.01 ? stillTicks + 1 : 0;
          expect(stillTicks, `${kind} stood still while chasing`).toBeLessThan(seconds(1));
          expect(Number.isFinite(boss.x) && Number.isFinite(boss.z)).toBe(true);
        }
        expect(attacks).toBeGreaterThan(10);
        expect(minGap).toBeGreaterThanOrEqual(AI.REGENT.MIN_GAP - TICK_DT);
        expect(minDist).toBeLessThan(boss.def.attackRange);
        expect(boss.stunTime).toBe(0);
        void SIM;
      });
    }
  }
});
