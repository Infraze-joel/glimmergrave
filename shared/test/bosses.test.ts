import { describe, expect, it } from 'vitest';
import { RUN, TICK_DT, WORLD } from '@shared/constants.ts';
import { CLASSES } from '@shared/data/classes.ts';
import { ENEMIES, ENEMY_TUNING } from '@shared/data/enemies.ts';
import { AI, bossOfChamber, MATRON_CD, maxMetaLevels, STALKER_CD, type Enemy, type World as WorldType } from '@shared/sim/index.ts';
import { World } from '@shared/sim/index.ts';
import { BOSS_KINDS, BTN, EF, type BossKind, type ClassId, type GameEvent } from '@shared/types.ts';
import { clearChamber, draftAll, hits, live, Pad, place, runBots, sandbox, seconds, stepN, takeDoor } from './harness.ts';

type Telegraph = Extract<GameEvent, { e: 'telegraph' }>;
const MT = ENEMY_TUNING.MATRON;
const ST = ENEMY_TUNING.STALKER;
const NEVER = 999;

// ------------------------------------------------------------------------------------------------ run plan

describe('boss pool', () => {
  const plan = (seed: number, classes: ClassId[] = ['knight']): { final: BossKind; herald: string; first: BossKind } => {
    const w = new World();
    classes.forEach((cls, slot) => w.addPlayer(slot, cls, `P${slot}`));
    w.start(0, seed, 0, { objective: 'slay' });
    return { final: w.run.finalBoss, herald: w.director.herald, first: w.getRunState().finalBoss };
  };

  it('the final boss is a pure function of the run seed and is reported from the first run state', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const a = plan(seed);
      expect(BOSS_KINDS).toContain(a.final);
      expect(a.first).toBe(a.final);
      expect(plan(seed)).toEqual(a);
      // The roster does not change the draw.
      expect(plan(seed, ['mage', 'rogue', 'knight']).final).toBe(a.final);
    }
  });

  it('all three bosses appear across seeds, each about a third of the time', () => {
    const counts: Record<string, number> = { regent: 0, matron: 0, stalker: 0 };
    const N = 900;
    for (let seed = 1; seed <= N; seed++) counts[plan(seed * 7919).final]!++;
    for (const kind of BOSS_KINDS) {
      expect(counts[kind]!, kind).toBeGreaterThan(N * 0.25);
      expect(counts[kind]!, kind).toBeLessThan(N * 0.42);
    }
  });

  it('the herald is never the final boss, and either of the other two can be it', () => {
    const pairs = new Set<string>();
    for (let seed = 1; seed <= 600; seed++) {
      const p = plan(seed);
      expect(p.herald).not.toBe(p.final);
      expect(BOSS_KINDS).toContain(p.herald);
      pairs.add(`${p.final}>${p.herald}`);
    }
    expect(pairs.size).toBe(6);
    // Overrides (tests / tools) cannot break the rule either.
    const w = new World();
    w.addPlayer(0, 'knight', 'A');
    w.start(0, 5, 0, { finalBoss: 'stalker', herald: 'stalker', objective: 'slay' });
    expect(w.run.finalBoss).toBe('stalker');
    expect(w.director.herald).not.toBe('stalker');
  });

  it('bossKind names the champion, the herald and the final boss in their chambers and is null elsewhere', () => {
    expect(RUN.CHAMBERS.map((_, i) => bossOfChamber(i, 'matron', 'stalker'))).toEqual([null, null, null, 'champion', null, null, 'stalker', 'matron']);
    for (const final of BOSS_KINDS) {
      const w = new World();
      w.addPlayer(0, 'knight', 'A');
      w.start(0, 77, 0, { finalBoss: final, objective: 'slay' });
      const herald = w.director.herald;
      for (let chamber = 0; chamber < RUN.CHAMBERS.length; chamber++) {
        const state = w.getRunState();
        expect(state.finalBoss).toBe(final);
        expect(state.bossKind).toBe(chamber === 3 ? 'champion' : chamber === 6 ? herald : chamber === 7 ? final : null);
        if (state.bossKind) {
          expect(state.bossId).toBe(-1);
          for (let i = 0; i < seconds(6) && w.run.bossId < 0; i++) { for (const h of w.heroes) h.invuln = 1; w.step(); }
          const boss = w.enemies.find((e) => e.id === w.run.bossId)!;
          expect(boss.kind).toBe(state.bossKind);
          expect(boss.boss!.herald).toBe(chamber === 6);
        }
        if (chamber === RUN.CHAMBERS.length - 1) break;
        clearChamber(w);
        draftAll(w);
        takeDoor(w, 0);
      }
    }
  });
});

describe('herald fight (second elite chamber)', () => {
  const toHerald = (final: BossKind, herald: BossKind, heroes: ClassId[] = ['knight']): { w: World; boss: Enemy; spawned: GameEvent[] } => {
    const w = new World();
    heroes.forEach((cls, slot) => w.addPlayer(slot, cls, `P${slot}`));
    w.start(0, 21, 6, { finalBoss: final, herald });
    expect(w.run.chamber).toBe(6);
    expect(w.getRunState().bossKind).toBe(herald);
    const spawned: GameEvent[] = [];
    for (let i = 0; i < seconds(6); i++) { for (const h of w.heroes) h.invuln = 1; w.step(); spawned.push(...w.drainEvents().filter((e) => e.e === 'spawn')); }
    const boss = w.enemies.find((e) => e.id === w.run.bossId)!;
    return { w, boss, spawned };
  };

  for (const [final, herald] of [['regent', 'matron'], ['regent', 'stalker'], ['matron', 'regent'], ['stalker', 'matron']] as const) {
    it(`${herald} as herald of a ${final} run: about 45 % health, a small escort, locked to phase 1`, () => {
      const { w, boss, spawned } = toHerald(final, herald);
      expect(boss.kind).toBe(herald);
      expect(boss.maxHp).toBeCloseTo(ENEMIES[herald].hp * w.hpMul * ENEMY_TUNING.HERALD.HP_FRACTION, 6);
      expect(ENEMY_TUNING.HERALD.HP_FRACTION).toBeGreaterThan(0.4);
      expect(ENEMY_TUNING.HERALD.HP_FRACTION).toBeLessThan(0.5);
      const escort = spawned.filter((e) => e.e === 'spawn' && e.kind !== herald);
      expect(escort.length).toBeGreaterThanOrEqual(1);
      expect(escort.length).toBeLessThanOrEqual(6);
      expect(escort.every((e) => e.e === 'spawn' && e.elite)).toBe(true);
      expect(w.getRunState().waveCount).toBe(1);
      // Even at a sliver of health it never changes phase or uses later-phase moves.
      boss.hp = boss.maxHp * 0.1;
      const types = new Set<string>();
      const events: GameEvent[] = [];
      for (let i = 0; i < seconds(40); i++) {
        for (const h of w.heroes) h.invuln = 1;
        w.step();
        events.push(...w.drainEvents());
        if (boss.attack) types.add(boss.attack.type);
      }
      expect(boss.boss!.phase).toBe(1);
      expect(events.filter((e) => e.e === 'bossPhase')).toHaveLength(0);
      expect(events.filter((e) => e.e === 'spawn')).toHaveLength(0);
      expect(w.getSnapshotBody().enemies.find((e) => e.id === boss.id)!.flags & EF.ENRAGED).toBeFalsy();
      for (const t of ['summon', 'slam', 'spiral', 'frenzy']) expect(types.has(t), t).toBe(false);
      expect(types.size).toBeGreaterThanOrEqual(2);
      // Killing it and its escort clears the chamber like any elite chamber and counts as an elite.
      clearChamber(w);
      expect(w.run.phase).toBe('draft');
      expect(w.director.elitesSlain).toBe(1);
      draftAll(w);
      expect(w.getRunState().doors.map((d) => d.type)).toEqual(['boss']);
    });
  }
});

// ------------------------------------------------------------------------------------------------ fairness audit

interface Tele { ev: Telegraph; start: number; land: number }

function inside(t: Telegraph, x: number, z: number, pad = 0): boolean {
  const dx = x - t.x;
  const dz = z - t.z;
  if (t.shape === 'circle') return Math.hypot(dx, dz) <= t.r + pad;
  const dirX = Math.sin(t.rot);
  const dirZ = Math.cos(t.rot);
  if (t.shape === 'line') {
    const along = dx * dirX + dz * dirZ;
    return along >= -pad && along <= t.r + pad && Math.abs(dx * dirZ - dz * dirX) <= t.w / 2 + pad;
  }
  const d = Math.hypot(dx, dz);
  if (d > t.r + pad) return false;
  return Math.abs(Math.atan2(dirX * dz - dirZ * dx, dirX * dx + dirZ * dz)) <= t.w / 2 + 0.01;
}

/**
 * Watches a fight and checks the fairness rule on everything that happens:
 *  - a hero is only ever hurt by (a) an announced shape that lands on that very tick while the hero stands in it,
 *    or (b) a projectile that touched them;
 *  - every arrow and spear is released along a line that was announced a full windup earlier.
 */
class Audit {
  teles: Tele[] = [];
  violations: string[] = [];
  areaHits = 0;
  contactHits = 0;
  private w: WorldType;
  private seen = new Set<number>();
  private before: { x: number; z: number; r: number; speed: number }[] = [];

  constructor(w: WorldType) {
    this.w = w;
    for (const p of w.projectiles) this.seen.add(p.id);
  }

  /** Call right before World.step(). */
  pre(): void {
    this.before = this.w.projectiles.filter((p) => p.hostile).map((p) => ({ x: p.x, z: p.z, r: p.radius, speed: p.speed }));
  }

  /** Call right after World.step() with the drained events. */
  post(events: GameEvent[]): void {
    const w = this.w;
    for (const ev of events) if (ev.e === 'telegraph') this.teles.push({ ev, start: w.tick, land: w.tick + Math.round(ev.dur / TICK_DT) });
    for (const p of w.projectiles) {
      if (this.seen.has(p.id)) continue;
      this.seen.add(p.id);
      if (!p.hostile || (p.kind !== 'boneArrow' && p.kind !== 'boneSpear')) continue;
      const announced = this.teles.some((t) => t.ev.shape === 'line' && Math.abs(t.land - w.tick) <= 1 && w.tick - t.start >= Math.round(t.ev.dur / TICK_DT) - 1
        && Math.hypot(t.ev.x - p.x, t.ev.z - p.z) <= p.speed * TICK_DT + 0.01 && Math.abs(Math.sin(t.ev.rot) - p.dirX) < 1e-6 && Math.abs(Math.cos(t.ev.rot) - p.dirZ) < 1e-6);
      if (!announced) this.violations.push(`tick ${w.tick}: ${p.kind} released without an announced line`);
    }
    for (const hit of hits(events, 'p')) {
      if (hit.by < 0) continue;
      const area = this.teles.some((t) => Math.abs(t.land - w.tick) <= 1 && inside(t.ev, hit.x, hit.z, 0.02));
      const contact = this.before.some((p) => Math.hypot(p.x - hit.x, p.z - hit.z) <= p.r + WORLD.PLAYER_RADIUS + p.speed * TICK_DT + 0.6);
      if (area) this.areaHits++;
      else if (contact) this.contactHits++;
      else this.violations.push(`tick ${w.tick}: hero ${hit.target.id} hurt at (${hit.x.toFixed(2)}, ${hit.z.toFixed(2)}) outside every landing shape and away from every projectile`);
    }
  }

  /** Telegraphs that have not landed yet (lines stay dangerous a little longer: their shot is still in flight). */
  active(linger = seconds(1.6)): Tele[] {
    const tick = this.w.tick;
    return this.teles.filter((t) => t.land >= tick || (t.ev.shape === 'line' && t.land + linger >= tick));
  }
}

/** Teleports the hero out of every shape that is about to land. Proves "not inside when it lands => not hurt". */
function dodge(w: WorldType, audit: Audit, slot: number): void {
  const h = w.hero(slot)!;
  const active = audit.active();
  const threatened = (x: number, z: number, pad: number): boolean => active.some((t) => inside(t.ev, x, z, pad));
  const soon = active.some((t) => t.land - w.tick <= 3 && inside(t.ev, h.body.x, h.body.z, 0.3));
  if (!soon) return;
  for (let r = 1; r <= 14; r += 0.5) {
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      const x = h.body.x + Math.sin(a) * r;
      const z = h.body.z + Math.cos(a) * r;
      if (Math.abs(x) > w.room.w / 2 - 1 || Math.abs(z) > w.room.d / 2 - 1 || threatened(x, z, 0.6)) continue;
      place(w, slot, x, z);
      return;
    }
  }
  throw new Error('dodger found no safe spot: the pattern leaves no gap');
}

interface Scenario {
  name: string;
  kind: 'matron' | 'stalker';
  /** Boss position; the hero stands at the origin. */
  at: [number, number];
  attack: string;
  prepare: (e: Enemy) => void;
  /** Seconds to watch. */
  watch: number;
  /** Shape of the telegraphs that belong to the attack (null: the attack is projectiles announced by a cast only). */
  shape: Telegraph['shape'] | null;
  dur: number;
  /** 'area' attacks must hurt a hero who stays in the shape; 'contact' attacks hurt through their projectiles. */
  hurts: 'area' | 'contact';
}

const only = (e: Enemy, cds: number[], phase = 1): void => {
  const b = e.boss!;
  b.cd = cds;
  b.gap = 0;
  b.summonCd = NEVER;
  b.phase = phase;
  e.blinkCd = NEVER;
  if (phase === 2) e.hp = e.maxHp * 0.6;
  if (phase === 3) e.hp = e.maxHp * 0.3;
};
const matronCd = (ready?: keyof typeof MATRON_CD): number[] => {
  const cd = [NEVER, NEVER, NEVER, NEVER];
  if (ready) cd[MATRON_CD[ready]] = 0;
  return cd;
};
const stalkerCd = (ready?: keyof typeof STALKER_CD): number[] => {
  const cd = [NEVER, NEVER, NEVER, NEVER];
  if (ready) cd[STALKER_CD[ready]] = 0;
  return cd;
};

const SCENARIOS: Scenario[] = [
  { name: 'matron orb ring', kind: 'matron', at: [0, 8], attack: 'ring', prepare: (e) => only(e, matronCd()), watch: 4, shape: 'circle', dur: MT.RING_WINDUP, hurts: 'contact' },
  { name: 'matron orb spiral', kind: 'matron', at: [0, 8], attack: 'spiral', prepare: (e) => only(e, matronCd('SPIRAL'), 2), watch: 6, shape: 'circle', dur: MT.SPIRAL_WINDUP, hurts: 'contact' },
  { name: 'matron rotating beam', kind: 'matron', at: [0, 8], attack: 'beam', prepare: (e) => only(e, matronCd('BEAM')), watch: 4, shape: 'line', dur: MT.BEAM_WINDUP, hurts: 'area' },
  { name: 'matron rotating beam (phase 3)', kind: 'matron', at: [0, 8], attack: 'beam', prepare: (e) => only(e, matronCd('BEAM'), 3), watch: 6, shape: 'line', dur: MT.BEAM_WINDUP, hurts: 'area' },
  { name: 'matron ground blasts', kind: 'matron', at: [0, 8], attack: 'blasts', prepare: (e) => only(e, matronCd('BLAST')), watch: 3, shape: 'circle', dur: MT.BLAST_WINDUP, hurts: 'area' },
  { name: 'matron ground blasts (phase 3, two waves)', kind: 'matron', at: [0, 8], attack: 'blasts', prepare: (e) => only(e, matronCd('BLAST'), 3), watch: 4, shape: 'circle', dur: MT.BLAST_WINDUP, hurts: 'area' },
  { name: 'matron soul wisps', kind: 'matron', at: [0, 8], attack: 'wisp', prepare: (e) => only(e, matronCd('WISP')), watch: 6, shape: null, dur: MT.WISP_WINDUP, hurts: 'contact' },
  { name: 'stalker arrow fan', kind: 'stalker', at: [0, 9], attack: 'fan', prepare: (e) => only(e, stalkerCd()), watch: 3, shape: 'line', dur: ST.FAN_WINDUP, hurts: 'contact' },
  { name: 'stalker arrow fan (phase 3)', kind: 'stalker', at: [0, 9], attack: 'fan', prepare: (e) => only(e, stalkerCd(), 3), watch: 3, shape: 'line', dur: ST.FAN_WINDUP, hurts: 'contact' },
  { name: 'stalker bone spear', kind: 'stalker', at: [0, 9], attack: 'spear', prepare: (e) => only(e, stalkerCd('SPEAR')), watch: 3, shape: 'line', dur: ST.SPEAR_WINDUP, hurts: 'contact' },
  { name: 'stalker leap', kind: 'stalker', at: [0, 9], attack: 'leap', prepare: (e) => { only(e, stalkerCd('LEAP'), 2); e.def = { ...e.def }; }, watch: 3, shape: 'circle', dur: ST.LEAP_AIR_TIME, hurts: 'area' },
  { name: 'stalker traps', kind: 'stalker', at: [0, 9], attack: 'trap', prepare: (e) => only(e, stalkerCd('TRAP')), watch: 6, shape: 'circle', dur: ST.TRAP_ARM, hurts: 'area' },
  { name: 'stalker frenzy', kind: 'stalker', at: [0, 9], attack: 'frenzy', prepare: (e) => only(e, stalkerCd('FRENZY'), 3), watch: 5, shape: 'line', dur: ST.FRENZY_WINDUP, hurts: 'contact' },
];

interface Played { w: WorldType; boss: Enemy; audit: Audit; events: GameEvent[]; first: Telegraph | null; firstTick: number; firstHitTick: number; hp: number }

/** Plays one scenario. The pounce (leap onto a hero) is a coin flip against the fan, so the seed is searched for it. */
function play(s: Scenario, dodging: boolean, seed = 3): Played {
  for (let attempt = seed; attempt < seed + 40; attempt++) {
    const w = sandbox(['knight'], attempt);
    place(w, 0, 0, 0);
    const h = w.hero(0)!;
    h.maxHp = 100000;
    h.hp = 100000;
    const boss = live(w, s.kind, s.at[0], s.at[1]);
    boss.hp = boss.maxHp = 1e7;
    s.prepare(boss);
    w.drainEvents();
    const audit = new Audit(w);
    const pad = new Pad(w);
    const out: Played = { w, boss, audit, events: [], first: null, firstTick: -1, firstHitTick: -1, hp: 0 };
    let type = '';
    for (let i = 0; i < seconds(s.watch); i++) {
      if (dodging) dodge(w, audit, 0);
      audit.pre();
      const ev = pad.hold({}, 1);
      audit.post(ev);
      out.events.push(...ev);
      if (!type && boss.attack) type = boss.attack.type;
      const tele = ev.find((x): x is Telegraph => x.e === 'telegraph');
      if (tele && !out.first) { out.first = tele; out.firstTick = w.tick; }
      if (out.firstHitTick < 0 && hits(ev, 'p').length > 0) out.firstHitTick = w.tick;
      // Keep the boss on this one attack for the whole watch.
      if (!boss.attack && boss.recover <= 0) boss.boss!.gap = NEVER;
    }
    out.hp = h.hp;
    if (type !== s.attack) continue;
    return out;
  }
  throw new Error(`${s.name}: the boss never chose "${s.attack}"`);
}

describe('telegraph fairness: every Matron and Stalker attack', () => {
  for (const s of SCENARIOS) {
    it(`${s.name}: announced at windup start, hurts only heroes still inside when it lands (or touched by its projectiles)`, () => {
      // --- A: the hero never moves.
      const a = play(s, false);
      expect(a.audit.violations, s.name).toEqual([]);
      if (s.shape) {
        expect(a.first, `${s.name}: no telegraph`).not.toBeNull();
        expect(a.first!.shape).toBe(s.shape);
        expect(a.first!.dur).toBeCloseTo(s.dur, 6);
        expect(a.first!.src).toBe(a.boss.id);
        // Nothing can hurt before the first windup has fully elapsed.
        if (a.firstHitTick >= 0) expect(a.firstHitTick - a.firstTick).toBeGreaterThanOrEqual(seconds(s.dur) - 1);
      }
      const total = a.audit.areaHits + a.audit.contactHits;
      // (The spiral is the one pattern with gaps wide enough to stand in by luck.)
      if (s.attack !== 'spiral') expect(total, `${s.name}: a hero who stands still must be hurt`).toBeGreaterThan(0);
      if (s.hurts === 'area') expect(a.audit.areaHits).toBeGreaterThan(0);

      // --- B: the hero steps out of every announced shape just before it lands: never hurt by an area attack.
      if (s.shape && s.attack !== 'ring' && s.attack !== 'spiral') {
        const b = play(s, true);
        expect(b.audit.violations, s.name).toEqual([]);
        expect(hits(b.events, 'p'), `${s.name}: a hero who left every shape in time must not be hurt`).toHaveLength(0);
        expect(b.hp).toBe(100000);
      }
    });
  }

  it('a whole fight against each boss (bots, 1 and 4 heroes) never breaks the rule', () => {
    for (const kind of ['matron', 'stalker'] as const) {
      for (const classes of [['knight'], ['knight', 'mage', 'rogue', 'barbarian']] as ClassId[][]) {
        const w = sandbox(classes, 17);
        w.heroes.forEach((h, i) => place(w, h.slot, (i - (classes.length - 1) / 2) * 3, 8));
        const boss = live(w, kind, 0, -6);
        boss.hp = boss.maxHp = 1e7;
        w.drainEvents();
        const audit = new Audit(w);
        const pads = w.heroes.map((h) => new Pad(w, h.slot));
        const phases = [1, 2, 3];
        for (let i = 0; i < seconds(150); i++) {
          // Walk the boss through its phases.
          const phase = phases[Math.min(2, Math.floor(i / seconds(50)))]!;
          boss.hp = boss.maxHp * (phase === 1 ? 0.9 : phase === 2 ? 0.5 : 0.2);
          for (const h of w.heroes) { h.hp = h.maxHp; if (h.state !== 'alive') { h.state = 'alive'; } }
          pads.forEach((pad, k) => pad.send({ moveX: Math.sin(i / 40 + k * 2), moveZ: Math.cos(i / 55 + k), aim: i / 20 }));
          audit.pre();
          w.step();
          audit.post(w.drainEvents());
          // Summons are not part of this audit: remove them as they appear.
          for (const e of w.enemies) if (e !== boss && !e.dead) { e.dead = true; e.corpseTime = 0; }
        }
        expect(audit.violations, `${kind} vs ${classes.length}`).toEqual([]);
        expect(audit.areaHits + audit.contactHits).toBeGreaterThan(4);
        expect(boss.boss!.phase).toBe(3);
      }
    }
  });
});

// ------------------------------------------------------------------------------------------------ attack details

describe('Hex Matron', () => {
  const arena = (heroes: ClassId[] = ['knight'], seed = 5): { w: WorldType; boss: Enemy } => {
    const w = sandbox(heroes, seed);
    w.heroes.forEach((h, i) => place(w, h.slot, (i - (heroes.length - 1) / 2) * 4, 0));
    const boss = live(w, 'matron', 0, 8);
    boss.hp = boss.maxHp = 1e7;
    w.drainEvents();
    return { w, boss };
  };
  const collect = (w: WorldType, ticks: number): GameEvent[] => {
    const out: GameEvent[] = [];
    for (let i = 0; i < ticks; i++) { for (const h of w.heroes) h.invuln = 1; w.step(); out.push(...w.drainEvents()); }
    return out;
  };

  it('is built on the mage skeleton: keeps her distance and blinks away from a hero who closes in', () => {
    const { w, boss } = arena();
    only(boss, matronCd());
    boss.boss!.gap = NEVER;
    boss.blinkCd = 0;
    place(w, 0, 0, 6);
    const ev = collect(w, 3);
    const blink = ev.find((e) => e.e === 'cast' && e.ability === 'blink');
    expect(blink).toBeDefined();
    expect(Math.hypot(boss.x, boss.z - 6)).toBeGreaterThanOrEqual(AI.MATRON.BLINK_MIN_HERO_DISTANCE);
    expect(boss.blinkCd).toBeGreaterThan(MT.BLINK_COOLDOWN - 1);
    // Further away than she likes: she closes in; too close (blink on cooldown): she backs off.
    place(w, 0, boss.x, boss.z - 16 > -14 ? boss.z - 16 : boss.z + 16);
    const far = Math.hypot(w.hero(0)!.body.x - boss.x, w.hero(0)!.body.z - boss.z);
    collect(w, seconds(2));
    expect(Math.hypot(w.hero(0)!.body.x - boss.x, w.hero(0)!.body.z - boss.z)).toBeLessThan(far - 2);
  });

  it('beam: BEAM_RAYS rays per step, BEAM_STEPS steps, each step turned by BEAM_TURN_DEG and announced on its own', () => {
    for (const phase of [1, 2, 3]) {
      const { w, boss } = arena();
      only(boss, matronCd('BEAM'), phase);
      const ev = collect(w, seconds(6));
      const lines = ev.filter((e): e is Telegraph => e.e === 'telegraph' && e.shape === 'line');
      const rays = MT.BEAM_RAYS[phase - 1]!;
      const steps = MT.BEAM_STEPS[phase - 1]!;
      expect(lines).toHaveLength(rays * steps);
      const casts = ev.filter((e) => e.e === 'cast' && e.ability === 'matron_beam');
      expect(casts).toHaveLength(rays * steps);
      for (const l of lines) { expect(l.w).toBe(MT.BEAM_WIDTH); expect(l.dur).toBe(MT.BEAM_WINDUP); expect(l.x).toBeCloseTo(boss.x, 6); }
      // Ray 0 of step 0 points at the target; every later step is turned by the same angle in one direction.
      const toHero = Math.atan2(0 - lines[0]!.x, 0 - lines[0]!.z);
      expect(Math.cos(lines[0]!.rot - toHero)).toBeCloseTo(1, 6);
      const turn = (MT.BEAM_TURN_DEG * Math.PI) / 180;
      for (let step = 1; step < steps; step++) expect(Math.abs(Math.sin(lines[step * rays]!.rot - lines[(step - 1) * rays]!.rot))).toBeCloseTo(Math.sin(turn), 6);
      expect(w.getSnapshotBody().enemies).toHaveLength(1);
    }
  });

  it('plays the `beam` animation while she channels and is rooted for the whole pattern', () => {
    const { w, boss } = arena();
    only(boss, matronCd('BEAM'));
    collect(w, 2);
    expect(boss.anim).toBe('beam');
    const { x, z } = boss;
    collect(w, seconds(MT.BEAM_WINDUP));
    expect(boss.x).toBe(x);
    expect(boss.z).toBe(z);
  });

  it('ground blasts: several circles at once that always leave gaps a hero fits into', () => {
    for (const phase of [1, 2, 3]) {
      for (let seed = 1; seed <= 12; seed++) {
        const { w, boss } = arena(seed % 2 ? ['knight'] : ['knight', 'mage', 'rogue', 'barbarian'], seed);
        only(boss, matronCd('BLAST'), phase);
        const waves: Telegraph[][] = [];
        for (let i = 0; i < seconds(4); i++) {
          for (const h of w.heroes) h.invuln = 1;
          w.step();
          const circles = w.drainEvents().filter((e): e is Telegraph => e.e === 'telegraph' && e.shape === 'circle');
          if (circles.length) waves.push(circles);
          if (!boss.attack && boss.recover <= 0) boss.boss!.gap = NEVER;
        }
        expect(waves).toHaveLength(MT.BLAST_WAVES[phase - 1]!);
        for (const wave of waves) {
          expect(wave.length).toBeGreaterThanOrEqual(3);
          for (const c of wave) { expect(c.r).toBe(MT.BLAST_RADIUS); expect(c.dur).toBe(MT.BLAST_WINDUP); }
          for (let i = 0; i < wave.length; i++) for (let j = i + 1; j < wave.length; j++) {
            const gap = Math.hypot(wave[i]!.x - wave[j]!.x, wave[i]!.z - wave[j]!.z) - 2 * MT.BLAST_RADIUS;
            expect(gap, `phase ${phase} seed ${seed}`).toBeGreaterThanOrEqual(2 * WORLD.PLAYER_RADIUS + 0.4);
          }
          // From anywhere inside a circle the way out is at most its radius: walkable within the windup.
          expect(MT.BLAST_RADIUS / CLASSES.barbarian.moveSpeed).toBeLessThan(MT.BLAST_WINDUP * 0.6);
        }
      }
    }
  });

  it('orb ring and spiral: counts, waves and the hexOrb projectile', () => {
    for (const phase of [1, 2, 3]) {
      const { w, boss } = arena();
      only(boss, matronCd(), phase);
      let fired = 0;
      const seen = new Set<number>();
      for (let i = 0; i < seconds(3.2); i++) {
        w.hero(0)!.invuln = 1;
        w.step();
        w.drainEvents();
        for (const p of w.projectiles) if (!seen.has(p.id)) { seen.add(p.id); expect(p.kind).toBe('hexOrb'); expect(p.hostile).toBe(true); fired++; }
        if (!boss.attack && boss.recover <= 0) boss.boss!.gap = NEVER;
      }
      expect(fired).toBe(MT.RING_ORBS * MT.RING_WAVES[phase - 1]!);
    }
    const { w, boss } = arena();
    only(boss, matronCd('SPIRAL'), 2);
    const seen = new Set<number>();
    let max = 0;
    for (let i = 0; i < seconds(MT.SPIRAL_WINDUP + MT.SPIRAL_STEPS * MT.SPIRAL_INTERVAL + 1); i++) {
      w.hero(0)!.invuln = 1;
      w.step();
      w.drainEvents();
      for (const p of w.projectiles) seen.add(p.id);
      max = Math.max(max, w.projectiles.length);
      if (!boss.attack && boss.recover <= 0) boss.boss!.gap = NEVER;
    }
    expect(seen.size).toBe(MT.SPIRAL_ARMS * MT.SPIRAL_STEPS);
    expect(max).toBeLessThanOrEqual(WORLD.MAX_PROJECTILES);
  });

  it('soul wisps: slow homing orbs in the snapshot that expire, are outrun and die on obstacles', () => {
    const { w, boss } = arena(['barbarian']);
    only(boss, matronCd('WISP'));
    const pad = new Pad(w);
    pad.hold({}, seconds(MT.WISP_WINDUP) + 3);
    boss.boss!.gap = NEVER;
    const wisp = w.projectiles.find((p) => p.kind === 'soulWisp')!;
    expect(wisp).toBeDefined();
    expect(w.projectiles.filter((p) => p.kind === 'soulWisp')).toHaveLength(MT.WISP_COUNT[0]!);
    expect(w.getSnapshotBody().projectiles.find((p) => p.id === wisp.id)).toMatchObject({ kind: 'soulWisp', hostile: true });
    // Slower than the slowest hero: running in a wide circle it never catches up, then it fizzles.
    expect(MT.WISP_SPEED).toBeLessThan(Math.min(...Object.values(CLASSES).map((c) => c.moveSpeed)) * 0.85);
    const h = w.hero(0)!;
    const hp = h.hp;
    let turned = false;
    const rot0 = wisp.rot;
    for (let i = 0; i < seconds(MT.WISP_LIFETIME) + 5; i++) {
      // Run away from the wisp, sliding along the walls.
      const dx = h.body.x - wisp.x;
      const dz = h.body.z - wisp.z;
      const nearWall = Math.abs(h.body.x) > w.room.w / 2 - 3 || Math.abs(h.body.z) > w.room.d / 2 - 3;
      boss.boss!.gap = NEVER;
      pad.hold(nearWall ? { moveX: -h.body.z, moveZ: h.body.x } : { moveX: dx, moveZ: dz }, 1);
      if (!wisp.dead && Math.abs(Math.sin(wisp.rot - rot0)) > 0.3) turned = true;
    }
    expect(turned).toBe(true);
    expect(h.hp).toBe(hp);
    expect(w.projectiles.some((p) => p.kind === 'soulWisp')).toBe(false);

    // Standing still: it arrives and hurts. Behind a pillar: it breaks on the stone.
    const still = arena(['knight']);
    only(still.boss, matronCd('WISP'));
    const quiet = (x: { w: WorldType; boss: Enemy }, ticks: number): GameEvent[] => {
      const pad2 = new Pad(x.w);
      const out: GameEvent[] = [];
      let started = false;
      for (let i = 0; i < ticks; i++) {
        started = started || x.boss.attack !== null;
        if (started && !x.boss.attack) x.boss.boss!.gap = NEVER;
        out.push(...pad2.hold({}, 1));
      }
      return out;
    };
    const ev = quiet(still, seconds(MT.WISP_WINDUP + 8 / MT.WISP_SPEED + 1.5));
    expect(hits(ev, 'p')).toHaveLength(1);
    const cover = arena(['knight']);
    only(cover.boss, matronCd('WISP'));
    cover.w.room.obstacles.push({ x: 0, z: 3, r: 2.5, kind: 'pillar' });
    const ev2 = quiet(cover, seconds(MT.WISP_WINDUP + 8 / MT.WISP_SPEED + 3));
    expect(hits(ev2, 'p')).toHaveLength(0);
    expect(cover.w.projectiles.some((p) => p.kind === 'soulWisp')).toBe(false);
  });

  for (const cls of ['knight', 'barbarian', 'mage', 'rogue'] as const) {
    it(`soul wisps can be destroyed by a ${cls}'s primary attack`, () => {
      const { w, boss } = arena([cls]);
      only(boss, matronCd('WISP'));
      const pad = new Pad(w);
      pad.hold({}, seconds(MT.WISP_WINDUP) + 3);
      boss.boss!.gap = NEVER;
      const h = w.hero(0)!;
      const hp = h.hp;
      const events: GameEvent[] = [];
      for (let i = 0; i < seconds(6); i++) {
        boss.boss!.gap = NEVER;
        const wisp = w.projectiles.find((p) => p.kind === 'soulWisp');
        if (!wisp) break;
        events.push(...pad.hold({ aim: Math.atan2(wisp.x - h.body.x, wisp.z - h.body.z), buttons: BTN.PRIMARY }, 1));
      }
      expect(w.projectiles.some((p) => p.kind === 'soulWisp')).toBe(false);
      expect(events.some((e) => e.e === 'cast' && e.ability === 'wisp_pop' && e.who.t === 'p' && e.who.id === 0)).toBe(true);
      expect(h.hp).toBe(hp);
    });
  }

  it('never keeps more than WISP_MAX wisps in the air', () => {
    const { w, boss } = arena(['knight', 'mage', 'rogue', 'barbarian']);
    let max = 0;
    for (let i = 0; i < seconds(40); i++) {
      for (const h of w.heroes) h.invuln = 1;
      only(boss, matronCd('WISP'), 3);
      boss.boss!.gap = Math.min(boss.boss!.gap, 0.2);
      w.step();
      w.drainEvents();
      for (const e of w.enemies) if (e !== boss) { e.dead = true; e.corpseTime = 0; }
      max = Math.max(max, w.projectiles.filter((p) => p.kind === 'soulWisp').length);
    }
    expect(max).toBeGreaterThan(MT.WISP_COUNT[0]!);
    expect(max).toBeLessThanOrEqual(MT.WISP_MAX);
  });

  it('changes phase at the thresholds: summons a mage and minions in phase 2, doubles the blasts in phase 3', () => {
    const { w, boss } = arena();
    boss.boss!.cd = matronCd();
    const p1 = collect(w, seconds(8));
    expect(p1.filter((e) => e.e === 'bossPhase')).toHaveLength(0);
    expect(p1.filter((e) => e.e === 'spawn')).toHaveLength(0);
    boss.hp = boss.maxHp * (MT.PHASE_THRESHOLDS[0] - 0.01);
    const p2 = collect(w, seconds(8));
    expect(p2.filter((e) => e.e === 'bossPhase')).toEqual([{ e: 'bossPhase', phase: 2 }]);
    const summoned = p2.filter((e): e is Extract<GameEvent, { e: 'spawn' }> => e.e === 'spawn');
    expect(summoned.filter((e) => e.kind === 'mage')).toHaveLength(MT.SUMMON_MAGES);
    expect(summoned.filter((e) => e.kind === 'minion')).toHaveLength(MT.SUMMON_MINIONS);
    expect(w.enemies.filter((e) => e.summoned)).toHaveLength(MT.SUMMON_MAGES + MT.SUMMON_MINIONS);
    for (const e of w.enemies) if (e !== boss) { e.dead = true; e.corpseTime = 0; }
    boss.boss!.summonCd = NEVER;
    boss.hp = boss.maxHp * (MT.PHASE_THRESHOLDS[1] - 0.01);
    const p3 = collect(w, seconds(6));
    expect(p3.filter((e) => e.e === 'bossPhase')).toEqual([{ e: 'bossPhase', phase: 3 }]);
    expect(p3.filter((e) => e.e === 'telegraph' && e.shape === 'circle' && e.r === MT.BLAST_RADIUS).length).toBeGreaterThanOrEqual(9 + 4);
    expect(w.getSnapshotBody().enemies.find((e) => e.id === boss.id)!.flags & EF.ENRAGED).toBeTruthy();
  });
});

describe('Ossuary Stalker', () => {
  const arena = (heroes: ClassId[] = ['knight'], seed = 5, at: [number, number] = [0, 9]): { w: WorldType; boss: Enemy } => {
    const w = sandbox(heroes, seed);
    w.heroes.forEach((h, i) => place(w, h.slot, (i - (heroes.length - 1) / 2) * 4, 0));
    const boss = live(w, 'stalker', at[0], at[1]);
    boss.hp = boss.maxHp = 1e7;
    w.drainEvents();
    return { w, boss };
  };
  const collect = (w: WorldType, ticks: number, boss?: Enemy): GameEvent[] => {
    const out: GameEvent[] = [];
    for (let i = 0; i < ticks; i++) {
      for (const h of w.heroes) h.invuln = 1;
      w.step();
      out.push(...w.drainEvents());
      if (boss && !boss.attack && boss.recover <= 0) boss.boss!.gap = NEVER;
    }
    return out;
  };

  it('fan volley: one line per arrow, more arrows and a wider fan in later phases, then exactly those arrows fly', () => {
    for (const phase of [1, 2, 3]) {
      const { w, boss } = arena();
      only(boss, stalkerCd(), phase);
      const ev = collect(w, 2);
      const lines = ev.filter((e): e is Telegraph => e.e === 'telegraph' && e.shape === 'line');
      expect(lines).toHaveLength(ST.FAN_ARROWS[phase - 1]!);
      expect(boss.anim).toBe('volley');
      const spread = lines[lines.length - 1]!.rot - lines[0]!.rot;
      expect(Math.abs(spread)).toBeCloseTo((ST.FAN_SPREAD_DEG[phase - 1]! * Math.PI) / 180, 6);
      collect(w, seconds(ST.FAN_WINDUP) + 1, boss);
      const arrows = w.projectiles.filter((p) => p.kind === 'boneArrow');
      expect(arrows).toHaveLength(lines.length);
      expect(arrows.map((p) => p.rot).sort()).toEqual(lines.map((l) => l.rot).sort());
    }
  });

  it('bone spear: a boneSpear that passes through every hero in its line (and stops at obstacles)', () => {
    const { w, boss } = arena(['knight', 'mage', 'rogue']);
    place(w, 0, 0, 4);
    place(w, 1, 0, 0);
    place(w, 2, 0, -4);
    for (const h of w.heroes) { h.maxHp = 5000; h.hp = 5000; }
    only(boss, stalkerCd('SPEAR'));
    boss.target = 0;
    boss.boss!.retarget = NEVER;
    const pads = w.heroes.map((h) => new Pad(w, h.slot));
    const events: GameEvent[] = [];
    let spear = false;
    for (let i = 0; i < seconds(ST.SPEAR_WINDUP + 1.5); i++) {
      for (const pad of pads) pad.send({});
      w.step();
      events.push(...w.drainEvents());
      if (w.projectiles.some((p) => p.kind === 'boneSpear' && p.hostile)) spear = true;
      if (!boss.attack && boss.recover <= 0) boss.boss!.gap = NEVER;
    }
    expect(spear).toBe(true);
    const lines = events.filter((e): e is Telegraph => e.e === 'telegraph');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ shape: 'line', w: ST.SPEAR_WIDTH, dur: ST.SPEAR_WINDUP });
    expect(hits(events, 'p').map((h) => h.target.id).sort()).toEqual([0, 1, 2]);
    for (const hit of hits(events, 'p')) expect(hit.dmg).toBe(ST.SPEAR_DAMAGE);

    // Behind a pillar: the announced line ends at the stone and so does the spear. No line of sight => no spear at all.
    const blocked = arena(['knight']);
    blocked.w.room.obstacles.push({ x: 2.2, z: 5, r: 1.5, kind: 'pillar' });
    only(blocked.boss, stalkerCd('SPEAR'));
    place(blocked.w, 0, 0, 0);
    const ev = collect(blocked.w, seconds(3), blocked.boss);
    expect(ev.filter((e) => e.e === 'telegraph' && e.shape === 'line' && e.w === ST.SPEAR_WIDTH).length).toBeLessThanOrEqual(1);
    const hidden = arena(['knight']);
    hidden.w.room.obstacles.push({ x: 0, z: 5, r: 1.5, kind: 'pillar' });
    only(hidden.boss, stalkerCd('SPEAR'));
    const ev2 = collect(hidden.w, 3);
    expect(ev2.filter((e) => e.e === 'telegraph' && e.shape === 'line' && e.w === ST.SPEAR_WIDTH)).toHaveLength(0);
  });

  it('leap: away from a hero who closes in, with the `leap` animation, a cast event and a landing circle', () => {
    const { w, boss } = arena(['knight'], 5, [0, 3]);
    only(boss, stalkerCd('LEAP'));
    const from = { x: boss.x, z: boss.z };
    const ev = collect(w, 2);
    const circle = ev.find((e): e is Telegraph => e.e === 'telegraph' && e.shape === 'circle')!;
    expect(circle).toMatchObject({ r: ST.LEAP_RADIUS, dur: ST.LEAP_AIR_TIME, src: boss.id });
    expect(Math.hypot(circle.x - from.x, circle.z - from.z)).toBeCloseTo(ST.LEAP_DISTANCE, 6);
    expect(Math.hypot(circle.x, circle.z)).toBeGreaterThanOrEqual(AI.STALKER.LEAP_MIN_HERO_DISTANCE);
    expect(ev.some((e) => e.e === 'cast' && e.ability === 'leap' && e.x === circle.x && e.z === circle.z)).toBe(true);
    expect(boss.anim).toBe('leap');
    // It travels through the air to exactly the announced spot and recovers there (punish window).
    const mid = collect(w, seconds(ST.LEAP_AIR_TIME / 2));
    expect(mid.filter((e) => e.e === 'aoe')).toHaveLength(0);
    const d = Math.hypot(boss.x - from.x, boss.z - from.z);
    expect(d).toBeGreaterThan(ST.LEAP_DISTANCE * 0.3);
    expect(d).toBeLessThan(ST.LEAP_DISTANCE * 0.8);
    const land = collect(w, seconds(ST.LEAP_AIR_TIME / 2) + 2);
    expect(land.filter((e) => e.e === 'aoe' && e.hostile)).toEqual([{ e: 'aoe', x: circle.x, z: circle.z, r: ST.LEAP_RADIUS, el: null, hostile: true }]);
    expect(boss.x).toBeCloseTo(circle.x, 6);
    expect(boss.z).toBeCloseTo(circle.z, 6);
    expect(boss.recover).toBeGreaterThan(AI.STALKER.LEAP_RECOVER - 0.2);
    expect(boss.boss!.cd[STALKER_CD.LEAP]).toBeGreaterThan(AI.STALKER.LEAP_COOLDOWN - 2);
  });

  it('leap: never lands in a wall or an obstacle, wherever it is cornered', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const w = sandbox(['knight'], seed);
      const hx = w.room.w / 2 - 1.5;
      const hz = w.room.d / 2 - 1.5;
      const bx = ((seed * 37) % 100) / 100 * 2 * hx - hx;
      const bz = ((seed * 53) % 100) / 100 * 2 * hz - hz;
      w.room.obstacles.push({ x: bx + 6, z: bz, r: 1.2, kind: 'pillar' }, { x: bx - 4, z: bz + 5, r: 1.2, kind: 'pillar' });
      const boss = live(w, 'stalker', bx, bz);
      place(w, 0, bx + (seed % 2 ? 2 : -2), bz + 1);
      only(boss, stalkerCd('LEAP'));
      const ev = collect(w, seconds(ST.LEAP_AIR_TIME) + 4);
      const circle = ev.find((e): e is Telegraph => e.e === 'telegraph' && e.shape === 'circle' && e.r === ST.LEAP_RADIUS);
      if (!circle) continue;
      expect(Math.abs(circle.x)).toBeLessThanOrEqual(w.room.w / 2 - boss.radius);
      expect(Math.abs(circle.z)).toBeLessThanOrEqual(w.room.d / 2 - boss.radius);
      for (const o of w.room.obstacles) expect(Math.hypot(o.x - circle.x, o.z - circle.z)).toBeGreaterThan(o.r + boss.radius);
      expect(Number.isFinite(boss.x) && Number.isFinite(boss.z)).toBe(true);
    }
  });

  it('traps: circles that persist for a few seconds as a chain of announced pulses', () => {
    for (const phase of [1, 2, 3]) {
      const { w, boss } = arena(['knight', 'mage']);
      place(w, 0, -3, 0);
      place(w, 1, 3, 0);
      only(boss, stalkerCd('TRAP'), phase);
      const events: { tick: number; ev: GameEvent }[] = [];
      for (let i = 0; i < seconds(8); i++) {
        for (const h of w.heroes) h.invuln = 1;
        w.step();
        for (const ev of w.drainEvents()) events.push({ tick: w.tick, ev });
        if (!boss.attack && boss.recover <= 0) boss.boss!.gap = NEVER;
      }
      const teles = events.filter((x) => x.ev.e === 'telegraph' && x.ev.shape === 'circle');
      const aoes = events.filter((x) => x.ev.e === 'aoe');
      const first = teles.filter((x) => x.tick === teles[0]!.tick);
      const count = first.length;
      expect(count).toBeGreaterThanOrEqual(2);
      expect(count).toBeLessThanOrEqual(ST.TRAP_COUNT[phase - 1]!);
      // Thrown under the heroes: both stand in one.
      for (const h of w.heroes) expect(first.some((x) => x.ev.e === 'telegraph' && Math.hypot(x.ev.x - h.body.x, x.ev.z - h.body.z) < 0.01)).toBe(true);
      expect(teles).toHaveLength(count * ST.TRAP_PULSES);
      expect(aoes).toHaveLength(count * ST.TRAP_PULSES);
      for (const x of first) if (x.ev.e === 'telegraph') { expect(x.ev.r).toBe(ST.TRAP_RADIUS); expect(x.ev.dur).toBe(ST.TRAP_ARM); }
      // Life of a trap: arm time + the remaining pulses.
      const life = (aoes[aoes.length - 1]!.tick - teles[0]!.tick) * TICK_DT;
      expect(life).toBeCloseTo(ST.TRAP_ARM + (ST.TRAP_PULSES - 1) * ST.TRAP_INTERVAL, 1);
      expect(life).toBeGreaterThanOrEqual(3);
      expect(boss.boss!.slams).toHaveLength(0);
      // No two traps of one throw overlap.
      for (let i = 0; i < count; i++) for (let j = i + 1; j < count; j++) {
        const a = first[i]!.ev as Telegraph;
        const b = first[j]!.ev as Telegraph;
        expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThanOrEqual(2 * ST.TRAP_RADIUS + AI.STALKER.TRAP_MIN_GAP - 1e-9);
      }
    }
  });

  it('traps: walking into a live trap hurts at its next pulse; leaving it ends the damage; killing the Stalker removes them', () => {
    const { w, boss } = arena(['knight']);
    only(boss, stalkerCd('TRAP'));
    const h = w.hero(0)!;
    h.maxHp = 5000;
    h.hp = 5000;
    const pad = new Pad(w);
    const first = pad.hold({}, 2).find((e): e is Telegraph => e.e === 'telegraph')!;
    boss.boss!.gap = NEVER;
    const hold = (ticks: number): GameEvent[] => {
      const out: GameEvent[] = [];
      for (let i = 0; i < ticks; i++) { if (!boss.attack) boss.boss!.gap = NEVER; out.push(...pad.hold({}, 1)); }
      return out;
    };
    // Step out before it arms, back in for one pulse, out again.
    place(w, 0, first.x + ST.TRAP_RADIUS + 1, first.z);
    expect(hits(hold(seconds(ST.TRAP_ARM) + 2), 'p')).toHaveLength(0);
    place(w, 0, first.x, first.z);
    const inside1 = hold(seconds(ST.TRAP_INTERVAL) + 1);
    expect(hits(inside1, 'p')).toHaveLength(1);
    expect(hits(inside1, 'p')[0]).toMatchObject({ dmg: ST.TRAP_DAMAGE, by: boss.id });
    place(w, 0, first.x + ST.TRAP_RADIUS + 1, first.z);
    expect(hits(hold(seconds(ST.TRAP_INTERVAL * ST.TRAP_PULSES)), 'p')).toHaveLength(0);

    const second = arena(['knight']);
    only(second.boss, stalkerCd('TRAP'));
    const pad2 = new Pad(second.w);
    pad2.hold({}, seconds(ST.TRAP_ARM) - 3);
    second.boss.hp = 1;
    second.w.hero(0)!.invuln = 0;
    // Any hit kills it now; the simplest is a sword.
    place(second.w, 0, second.boss.x, second.boss.z - 2);
    const ev = pad2.hold({ buttons: BTN.PRIMARY, aim: 0 }, 12);
    expect(second.boss.dead).toBe(true);
    const after = [...ev, ...pad2.hold({}, seconds(4))];
    expect(after.filter((e) => e.e === 'aoe' && e.hostile)).toHaveLength(0);
  });

  it('changes phase at the thresholds: traps open phase 2, a frenzy of FRENZY_SHOTS quick shots opens phase 3', () => {
    const { w, boss } = arena();
    boss.boss!.cd = stalkerCd();
    const p1 = collect(w, seconds(6));
    expect(p1.filter((e) => e.e === 'bossPhase')).toHaveLength(0);
    boss.hp = boss.maxHp * (ST.PHASE_THRESHOLDS[0] - 0.01);
    const p2 = collect(w, seconds(5));
    expect(p2.filter((e) => e.e === 'bossPhase')).toEqual([{ e: 'bossPhase', phase: 2 }]);
    expect(p2.some((e) => e.e === 'telegraph' && e.shape === 'circle' && e.r === ST.TRAP_RADIUS)).toBe(true);
    boss.boss!.cd[STALKER_CD.TRAP] = NEVER;
    boss.boss!.cd[STALKER_CD.LEAP] = NEVER;
    boss.hp = boss.maxHp * (ST.PHASE_THRESHOLDS[1] - 0.01);
    let frenzyAt = -1;
    let shots = 0;
    let ended = -1;
    for (let i = 0; i < seconds(9) && ended < 0; i++) {
      for (const h of w.heroes) h.invuln = 1;
      w.step();
      const ev = w.drainEvents();
      if (ev.some((e) => e.e === 'cast' && e.ability === 'frenzy')) frenzyAt = w.tick;
      if (frenzyAt >= 0 && boss.attack?.type === 'frenzy') shots += ev.filter((e) => e.e === 'telegraph' && e.shape === 'line' && e.dur === ST.FRENZY_WINDUP).length;
      if (frenzyAt >= 0 && !boss.attack) ended = w.tick;
    }
    expect(frenzyAt).toBeGreaterThan(0);
    expect(shots).toBe(ST.FRENZY_SHOTS);
    // Short, and followed by the longest recovery of the fight.
    expect((ended - frenzyAt) * TICK_DT).toBeLessThan(4);
    expect(boss.recover).toBeGreaterThan(AI.STALKER.FRENZY_RECOVER - 0.1);
    expect(AI.STALKER.FRENZY_RECOVER).toBeGreaterThan(Math.max(AI.STALKER.FAN_RECOVER, AI.STALKER.SPEAR_RECOVER, AI.STALKER.LEAP_RECOVER, AI.STALKER.TRAP_RECOVER));
    expect(w.getSnapshotBody().enemies.find((e) => e.id === boss.id)!.flags & EF.ENRAGED).toBeTruthy();
  });
});

// ------------------------------------------------------------------------------------------------ pacing and termination

describe('boss pacing', () => {
  for (const kind of ['matron', 'stalker'] as const) {
    for (const heroes of [1, 4]) {
      it(`${kind} vs ${heroes}: keeps attacking, always leaves a gap between attacks, stays in the arena, cannot be stunned`, () => {
        const w = sandbox(Array.from({ length: heroes }, (_, i) => (['knight', 'mage', 'rogue', 'barbarian'] as const)[i]!), 5);
        w.heroes.forEach((h, i) => place(w, h.slot, (i - (heroes - 1) / 2) * 3, 6));
        const boss = live(w, kind, 0, -4);
        w.room.obstacles.push({ x: 0, z: 1, r: 1.1, kind: 'rubble' }, { x: 4, z: 3, r: 0.9, kind: 'pillar' }, { x: -4, z: 3, r: 0.9, kind: 'pillar' });
        const cfg = kind === 'matron' ? AI.MATRON : AI.STALKER;
        const types = new Set<string>();
        let busy = false;
        let lastEnd = -1;
        let attacks = 0;
        let minGap = Infinity;
        let longestIdle = 0;
        let idle = 0;
        const pads = w.heroes.map((h) => new Pad(w, h.slot));
        for (let i = 0; i < seconds(120); i++) {
          for (const h of w.heroes) h.invuln = 1;
          // Phase 1 for 40 s, then 2, then 3. Heroes wander so that every positional option gets used.
          boss.hp = boss.maxHp * (i < seconds(40) ? 0.9 : i < seconds(80) ? 0.5 : 0.2);
          pads.forEach((pad, k) => pad.send({ moveX: Math.sin(i / 50 + k * 2), moveZ: Math.cos(i / 70 + k), aim: 0, buttons: i % 90 === 0 ? BTN.SECONDARY : 0 }));
          w.step();
          w.drainEvents();
          for (const e of w.enemies) if (e !== boss && !e.dead) { e.dead = true; e.corpseTime = 0; }
          const now = boss.attack !== null || boss.recover > 0;
          if (boss.attack) types.add(boss.attack.type);
          if (now && !busy) {
            attacks++;
            if (lastEnd >= 0) minGap = Math.min(minGap, (w.tick - lastEnd) * TICK_DT);
          }
          if (!now && busy) lastEnd = w.tick;
          busy = now;
          idle = now ? 0 : idle + 1;
          longestIdle = Math.max(longestIdle, idle);
          expect(Number.isFinite(boss.x) && Number.isFinite(boss.z) && Number.isFinite(boss.rot)).toBe(true);
          expect(Math.abs(boss.x)).toBeLessThanOrEqual(w.room.w / 2 - boss.radius + 1e-6);
          expect(Math.abs(boss.z)).toBeLessThanOrEqual(w.room.d / 2 - boss.radius + 1e-6);
          for (const o of w.room.obstacles) expect(Math.hypot(o.x - boss.x, o.z - boss.z)).toBeGreaterThanOrEqual(o.r + boss.radius - 1e-6);
        }
        expect(attacks).toBeGreaterThan(25);
        expect(minGap).toBeGreaterThanOrEqual(cfg.MIN_GAP - TICK_DT);
        // Never out of options: the longest stretch without an attack or recovery is a few seconds at most.
        expect(longestIdle * TICK_DT).toBeLessThan(4);
        expect(boss.stunTime).toBe(0);
        const expected = kind === 'matron' ? ['ring', 'spiral', 'beam', 'blasts', 'wisp', 'summon'] : ['fan', 'spear', 'leap', 'trap', 'frenzy'];
        for (const t of expected) expect(types.has(t), `${kind} never used ${t}`).toBe(true);
      });
    }
  }

  it('bosses are immune to stun and knockback like the Regent', () => {
    for (const kind of ['matron', 'stalker'] as const) {
      const w = sandbox(['knight'], 2);
      const boss = live(w, kind, 0, 2.5);
      boss.boss!.gap = NEVER;
      boss.blinkCd = NEVER;
      place(w, 0, 0, 0);
      const { x, z } = boss;
      const ev = new Pad(w).hold({ buttons: BTN.SECONDARY, aim: 0 }, 20);
      expect(hits(ev, 'e', boss.id).length).toBeGreaterThan(0);
      expect(boss.stunTime).toBe(0);
      expect(boss.kbX).toBe(0);
      expect(Math.hypot(boss.x - x, boss.z - z)).toBeLessThan(1.5);
    }
  });
});

describe('boss fights with bots', () => {
  const TICK_BUDGET = 30 * 60 * 8;
  for (const final of BOSS_KINDS) {
    for (const classes of [['knight'], ['mage'], ['knight', 'barbarian', 'mage', 'rogue']] as ClassId[][]) {
      it(`${final} vs ${classes.length === 1 ? classes[0] : '4 heroes'}: the fight terminates without NaN or overflow`, () => {
        for (const seed of [11, 12]) {
          const r = runBots({ classes, seed, startChamber: 7, overrides: { finalBoss: final }, meta: maxMetaLevels(), maxTicks: TICK_BUDGET });
          expect(['victory', 'defeat'], `${final} seed ${seed}`).toContain(r.phase);
          expect(r.ticks).toBeLessThan(TICK_BUDGET);
          expect(r.nan).toBe(false);
          expect(r.maxEnemies).toBeLessThanOrEqual(WORLD.MAX_ENEMIES);
          expect(r.maxProjectiles).toBeLessThanOrEqual(WORLD.MAX_PROJECTILES);
          expect(r.damageDealt).toBeGreaterThan(0);
        }
      }, 60000);
    }
  }

  it('no boss can stall: every class brings every boss down when it cannot die itself', () => {
    for (const final of BOSS_KINDS) {
      for (const cls of ['knight', 'barbarian', 'mage', 'rogue'] as const) {
        const r = runBots({
          classes: [cls], seed: 5, startChamber: 7, overrides: { finalBoss: final }, maxTicks: 30 * 60 * 10,
          onTick: (w) => { for (const h of w.heroes) if (h.state === 'alive') h.hp = h.maxHp; },
        });
        expect(r.phase, `${cls} vs ${final}`).toBe('victory');
        expect(r.nan).toBe(false);
      }
    }
  }, 120000);

  it('herald fights terminate with 1 and 4 bots for every herald', () => {
    for (const [final, herald] of [['regent', 'matron'], ['regent', 'stalker'], ['matron', 'regent']] as const) {
      for (const classes of [['barbarian'], ['knight', 'barbarian', 'mage', 'rogue']] as ClassId[][]) {
        const r = runBots({ classes, seed: 9, startChamber: 6, overrides: { finalBoss: final, herald }, meta: maxMetaLevels(), maxTicks: 30 * 60 * 12 });
        expect(['victory', 'defeat']).toContain(r.phase);
        expect(r.herald).toBe(herald);
        expect(r.nan).toBe(false);
      }
    }
  }, 60000);
});

void stepN;
