/** Update 3: the endless descent, depth and Oath scaling, elite affixes, rewards (Glimmer, XP, relic shards), determinism. */
import { describe, expect, it } from 'vitest';
import { depthScale, oathScale, RUN, TICK_DT } from '@shared/constants.ts';
import { ENEMIES } from '@shared/data/enemies.ts';
import { XP_REWARDS } from '@shared/data/mastery.ts';
import { META_UPGRADES, REWARDS } from '@shared/data/meta.ts';
import { RELIC_BY_ID, RELIC_TUNING } from '@shared/data/relics.ts';
import { damageHero, downHero, killEnemy, strikeEnemy } from '@shared/sim/combat.ts';
import { enemySpeed } from '@shared/sim/enemies.ts';
import { rollShards } from '@shared/sim/loot.ts';
import {
  AFFIX, dropChance, earn, emptyEarnings, glimmerReward, maxBuild, maxMetaLevels, World, xpReward, type Enemy,
} from '@shared/sim/index.ts';
import { AFFIX_IDS, BOSS_KINDS, CLASS_IDS, type AffixId, type ClassId, type GameEvent } from '@shared/types.ts';
import { clearChamber, draftAll, live, place, runBots, seconds, stepN, takeDoor } from './harness.ts';
import { arena, give, metaLevels, of, paragonRanks } from './u3kit.ts';

const LAST = RUN.CHAMBERS.length - 1;
const start = (classes: ClassId[], loadouts: unknown[] = [], seed = 5, oath = 0): World => {
  const w = new World();
  classes.forEach((cls, slot) => expect(w.addPlayer(slot, cls, `P${slot}`, loadouts[slot])).toBe(true));
  expect(w.start(oath, seed)).toBe(true);
  return w;
};
const doorOf = (w: World, type: string): number => w.getRunState().doors.findIndex((d) => d.type === type);
/** Forces the party through the chambers up to the final boss of the current depth. `prefer` picks a door type when offered. */
function toBoss(w: World, prefer = 'boon'): void {
  for (let guard = 0; guard < RUN.CHAMBERS.length && w.run.chamber < LAST; guard++) {
    clearChamber(w);
    draftAll(w);
    takeDoor(w, Math.max(0, doorOf(w, prefer)));
  }
  expect(w.run.chamberKind).toBe('boss');
}
/** Kills the final boss of the current depth by hero 0 and returns the events up to the draft. */
function slayBoss(w: World): GameEvent[] {
  for (let i = 0; i < seconds(8) && w.run.bossId < 0; i++) { for (const h of w.heroes) h.invuln = 1; w.step(); }
  const boss = w.enemies.find((e) => e.id === w.run.bossId)!;
  expect(boss.kind).toBe(w.run.finalBoss);
  boss.spawnTime = 0;
  w.drainEvents();
  killEnemy(w, boss, 0);
  w.step();
  expect(w.run.phase).toBe('draft');
  return w.drainEvents();
}
const BASE_GLIMMER = RUN.CHAMBERS.length * REWARDS.PER_CHAMBER_CLEARED + 2 * REWARDS.PER_ELITE_SLAIN + REWARDS.BOSS_SLAIN;
const BASE_XP = RUN.CHAMBERS.length * XP_REWARDS.PER_CHAMBER_CLEARED + 2 * XP_REWARDS.PER_ELITE_SLAIN + XP_REWARDS.BOSS_SLAIN;

describe('endless descent', () => {
  it('after a final boss: draft, then the descend and ascend doors; descending goes one depth deeper with everything carried over', () => {
    const w = start(['knight', 'mage']);
    const [knight, mage] = [w.hero(0)!, w.hero(1)!];
    expect(w.getRunState()).toMatchObject({ depth: 0, cleared: 0, chambersCleared: 0 });
    toBoss(w);
    const first = w.run.finalBoss;
    const ev = slayBoss(w);
    expect(ev).toContainEqual({ e: 'chamberClear' });
    expect(w.getRunState()).toMatchObject({ phase: 'draft', depth: 0, cleared: 1, chambersCleared: RUN.CHAMBERS.length, rewards: [] });
    // The herald and the final boss count as bosses; the champion and its elite escort as elites.
    expect(w.getRunState().stats[0]!.bosses).toBe(2);
    expect(w.getRunState().stats[0]!.elites).toBeGreaterThanOrEqual(1);
    draftAll(w);
    const doors = w.getRunState().doors;
    expect(doors.map((d) => d.type)).toEqual(['descend', 'ascend']);
    const boons = [w.getBoons(0), w.getBoons(1)];
    knight.ult = 60;
    knight.hp = 10;
    mage.hp = mage.maxHp - 5;
    const kills = knight.run.kills;
    const down = takeDoor(w, 0);
    expect(down).toContainEqual({ e: 'doorChosen', type: 'descend' });
    expect(down).toContainEqual({ e: 'descend', depth: 1 });
    const run = w.getRunState();
    expect(run).toMatchObject({ phase: 'combat', depth: 1, chamber: 0, chamberKind: 'combat', entered: 'descend', cleared: 1, chambersCleared: RUN.CHAMBERS.length, rewards: [], wave: 0 });
    // A different final boss, a herald that is neither, the crypt first again.
    expect(run.finalBoss).not.toBe(first);
    expect(BOSS_KINDS).toContain(run.finalBoss);
    expect(w.director.herald).not.toBe(run.finalBoss);
    expect(run.room!.biome).toBe('crypt');
    // Heal on descending; boons, ultimate charge and stats carry over.
    expect(knight.hp).toBeCloseTo(10 + knight.maxHp * RUN.DEPTH.HEAL_FRACTION, 6);
    expect(mage.hp).toBe(mage.maxHp);
    expect([w.getBoons(0), w.getBoons(1)]).toEqual(boons);
    expect(knight.ult).toBe(60);
    expect(knight.run.kills).toBe(kills);
    // The whole sequence again, one depth deeper, and deeper still.
    toBoss(w);
    slayBoss(w);
    expect(w.getRunState()).toMatchObject({ depth: 1, cleared: 2, chambersCleared: 2 * RUN.CHAMBERS.length });
    const second = w.run.finalBoss;
    draftAll(w);
    takeDoor(w, doorOf(w, 'descend'));
    expect(w.getRunState()).toMatchObject({ depth: 2, chamber: 0 });
    expect(w.run.finalBoss).not.toBe(second);
  });

  it('ascending ends the run as a victory', () => {
    const w = start(['rogue']);
    toBoss(w);
    slayBoss(w);
    draftAll(w);
    const ev = takeDoor(w, doorOf(w, 'ascend'));
    expect(ev).toContainEqual({ e: 'doorChosen', type: 'ascend' });
    expect(ev.some((e) => e.e === 'descend')).toBe(false);
    expect(w.getRunState()).toMatchObject({ phase: 'victory', depth: 0, cleared: 1, doors: [] });
    expect(w.getRunState().rewards).toHaveLength(1);
  });

  it('the plan of every depth comes from the run seed', () => {
    const plan = (seed: number): string[] => {
      const w = start(['knight'], [], seed);
      const out: string[] = [];
      for (let depth = 0; depth < 3; depth++) {
        out.push(`${w.run.finalBoss}/${w.director.herald}/${w.director.biomes.join('-')}`);
        toBoss(w);
        slayBoss(w);
        draftAll(w);
        takeDoor(w, doorOf(w, 'descend'));
      }
      return out;
    };
    expect(plan(11)).toEqual(plan(11));
    const plans = new Set([11, 12, 13, 14, 15, 16].map((s) => plan(s).join(' | ')));
    expect(plans.size).toBeGreaterThan(2);
  });

  it('depth multiplies enemy health, damage, speed and numbers (depthScale); elites carry affixes from depth 1', () => {
    expect(depthScale(0)).toEqual({ hp: 1, damage: 1, speed: 1, count: 1 });
    expect(depthScale(1)).toEqual({ hp: 1 + RUN.DEPTH.HP_STEP, damage: 1 + RUN.DEPTH.DAMAGE_STEP, speed: 1 + RUN.DEPTH.SPEED_STEP, count: 1 + RUN.DEPTH.COUNT_STEP });
    expect(depthScale(50).speed).toBe(RUN.DEPTH.SPEED_CAP);
    expect(depthScale(50).count).toBe(RUN.DEPTH.COUNT_CAP);
    const w = start(['knight']);
    const shallow = { hp: w.hpMul, damage: w.damageMul, speed: w.speedMul };
    for (let i = 0; i < seconds(6) && w.run.wave < 1; i++) { w.hero(0)!.invuln = 1; w.step(); }
    for (let i = 0; i < seconds(4); i++) { w.hero(0)!.invuln = 1; w.step(); }
    const firstWave = w.enemies.length;
    expect(w.affixed).toBe(false);
    toBoss(w);
    slayBoss(w);
    draftAll(w);
    takeDoor(w, doorOf(w, 'descend'));
    const d = depthScale(1);
    expect(w.hpMul).toBeCloseTo(shallow.hp * d.hp, 9);
    expect(w.damageMul).toBeCloseTo(shallow.damage * d.damage, 9);
    expect(w.speedMul).toBeCloseTo(shallow.speed * d.speed, 9);
    expect(w.affixed).toBe(true);
    const minion = w.spawnEnemy('minion', 0, 0)!;
    expect(minion.maxHp).toBeCloseTo(ENEMIES.minion.hp * d.hp, 6);
    expect(minion.affix).toBeNull();
    for (let i = 0; i < seconds(6) && w.run.wave < 1; i++) { w.hero(0)!.invuln = 1; w.step(); }
    for (let i = 0; i < seconds(4); i++) { w.hero(0)!.invuln = 1; w.step(); }
    // More director budget per wave one depth down (the minion spawned by hand is not counted).
    expect(w.enemies.length - 1).toBeGreaterThanOrEqual(firstWave);
  });

  it('a defeat below depth 0 is phase `defeat` but counts as a won run and pays everything earned', () => {
    const w = start(['knight', 'mage']);
    toBoss(w);
    slayBoss(w);
    draftAll(w);
    takeDoor(w, doorOf(w, 'descend'));
    clearChamber(w);
    draftAll(w);
    takeDoor(w, 0);
    for (const h of w.heroes) { h.invuln = 0; downHero(w, h); }
    w.step();
    const run = w.getRunState();
    expect(run).toMatchObject({ phase: 'defeat', depth: 1, cleared: 1, chambersCleared: RUN.CHAMBERS.length + 1 });
    // Everything from depth 0, plus one chamber paid with the depth bonus.
    const glimmer = BASE_GLIMMER + REWARDS.PER_CHAMBER_CLEARED * (1 + REWARDS.DEPTH_BONUS);
    const xp = BASE_XP + XP_REWARDS.PER_CHAMBER_CLEARED * (1 + XP_REWARDS.DEPTH_BONUS);
    for (const r of run.rewards) {
      expect(r.glimmer).toBe(Math.round(glimmer));
      expect(r.xp).toBe(Math.round(xp));
      expect(r.relics.length).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('Oath levels', () => {
  it('oathScale: the table up to 3, then steps; speed stops at its cap; World.start accepts 0..OATH_MAX', () => {
    for (let n = 0; n < RUN.OATH.length; n++) expect(oathScale(n)).toEqual(RUN.OATH[n]);
    const top = RUN.OATH[RUN.OATH.length - 1]!;
    expect(oathScale(5)).toEqual({ hp: top.hp + 2 * RUN.OATH_HP_STEP, damage: top.damage + 2 * RUN.OATH_DAMAGE_STEP, speed: top.speed + 2 * RUN.OATH_SPEED_STEP });
    expect(oathScale(RUN.OATH_MAX).speed).toBe(RUN.OATH_SPEED_CAP);
    expect(oathScale(99)).toEqual(oathScale(RUN.OATH_MAX));
    expect(oathScale(-3)).toEqual(RUN.OATH[0]);
    const w = start(['knight'], [], 5, 7);
    expect(w.getRunState().oath).toBe(7);
    expect(w.hpMul).toBeCloseTo(oathScale(7).hp, 9);
    expect(w.damageMul).toBeCloseTo(oathScale(7).damage, 9);
    expect(w.speedMul).toBeCloseTo(oathScale(7).speed, 9);
  });
});

describe('elite affixes', () => {
  const spawned = (w: World, n: number): GameEvent[] => {
    const ev: GameEvent[] = [];
    for (let i = 0; i < n; i++) { for (const h of w.heroes) h.invuln = 1; w.step(); ev.push(...w.drainEvents()); }
    return ev;
  };

  it('appear in the spawn event of elites and champions from AFFIX_FROM_OATH (or depth 1), never before and never on ordinary foes', () => {
    expect(AFFIX_IDS).toEqual(['swift', 'armored', 'volatile', 'vampiric']);
    for (const oath of [0, RUN.DEPTH.AFFIX_FROM_OATH - 1, RUN.DEPTH.AFFIX_FROM_OATH]) {
      const w = new World();
      w.addPlayer(0, 'knight', 'A');
      w.start(oath, 21, 3);
      expect(w.run.chamberKind).toBe('elite');
      const spawns = of(spawned(w, seconds(8)), 'spawn');
      const special = spawns.filter((s) => s.elite || s.kind === 'champion');
      expect(special.length).toBeGreaterThan(1);
      expect(spawns.some((s) => s.kind === 'champion')).toBe(true);
      if (oath >= RUN.DEPTH.AFFIX_FROM_OATH) {
        for (const s of special) expect(AFFIX_IDS).toContain(s.affix);
        for (const s of special) expect(w.enemies.find((e) => e.id === s.id)!.affix).toBe(s.affix);
      } else {
        for (const s of spawns) expect('affix' in s).toBe(false);
      }
      for (const s of spawns.filter((x) => !x.elite && x.kind !== 'champion')) expect(s.affix).toBeUndefined();
    }
    // Bosses never carry one.
    const a = arena('knight');
    a.w.affixed = true;
    expect(a.w.spawnEnemy('regent', 0, 5)!.affix).toBeNull();
    expect(a.w.spawnEnemy('minion', 3, 5)!.affix).toBeNull();
    expect(AFFIX_IDS).toContain(a.w.spawnEnemy('minion', 5, 5, { elite: true })!.affix);
    // Every affix turns up.
    const seen = new Set<AffixId>();
    for (let i = 0; i < 40; i++) seen.add(a.w.spawnEnemy('minion', 5, 5, { elite: true })!.affix!);
    expect(seen.size).toBe(AFFIX_IDS.length);
  });

  const elite = (a: ReturnType<typeof arena>, affix: AffixId, x = 0, z = 3): Enemy => {
    const e = live(a.w, 'minion', x, z, { elite: true, affix });
    a.w.drainEvents();
    return e;
  };

  it('swift: moves and attacks faster', () => {
    const a = arena('knight');
    const plain = live(a.w, 'minion', 6, 6, { elite: true });
    const swift = elite(a, 'swift', -6, 6);
    expect(enemySpeed(swift)).toBeCloseTo(enemySpeed(plain) * AFFIX.SWIFT_SPEED, 9);
    place(a.w, 0, 0, -12);
    plain.attackCd = 3;
    swift.attackCd = 3;
    a.h.invuln = 99;
    stepN(a.w, 30);
    expect(3 - swift.attackCd).toBeCloseTo((3 - plain.attackCd) * AFFIX.SWIFT_ATTACK_RATE, 6);
  });

  it('armored: takes less damage until a Resonance breaks its guard', () => {
    const a = arena('knight');
    give(a.h, 'infuse_ember_primary');
    const e = elite(a, 'armored');
    e.passive = true;
    e.hp = e.maxHp = 100000;
    const hit = (slot: 'dash' | 'primary'): number => {
      const before = e.hp;
      strikeEnemy(a.w, a.h, e, 10, slot, { fromX: 0, fromZ: 0, stun: 0, knockback: 0 });
      return before - e.hp;
    };
    expect(hit('dash')).toBeCloseTo(10 * (1 - AFFIX.ARMORED_REDUCTION), 6);
    e.status = 'rime';
    e.statusTime = 5;
    a.w.drainEvents();
    hit('primary');
    expect(of(a.w.drainEvents(), 'shieldBreak')).toEqual([{ e: 'shieldBreak', id: e.id }]);
    expect(e.armored).toBe(false);
    e.status = null;
    expect(hit('dash')).toBeCloseTo(10, 6);
  });

  it('volatile: announced when it dies, explodes shortly after and hurts heroes still inside', () => {
    for (const stay of [true, false]) {
      const a = arena('knight');
      const e = elite(a, 'volatile', 0, 1.5);
      e.passive = true;
      killEnemy(a.w, e, 0);
      const tele = of(a.w.drainEvents(), 'telegraph');
      expect(tele).toEqual([{ e: 'telegraph', shape: 'circle', x: e.x, z: e.z, rot: 0, r: AFFIX.VOLATILE_RADIUS, w: 0, dur: AFFIX.VOLATILE_DELAY }]);
      if (!stay) place(a.w, 0, 0, 1.5 + AFFIX.VOLATILE_RADIUS + 1);
      const hp = a.h.hp;
      stepN(a.w, seconds(AFFIX.VOLATILE_DELAY) - 2);
      expect(a.h.hp).toBe(hp);
      const ev = stepN(a.w, 4);
      expect(of(ev, 'aoe')).toContainEqual({ e: 'aoe', x: e.x, z: e.z, r: AFFIX.VOLATILE_RADIUS, el: null, hostile: true });
      expect(hp - a.h.hp).toBeCloseTo(stay ? AFFIX.VOLATILE_DAMAGE * e.damageMul : 0, 6);
      expect(a.w.blasts).toHaveLength(0);
    }
  });

  it('vampiric: heals when it hurts a hero (never above its maximum)', () => {
    const a = arena('knight');
    const e = elite(a, 'vampiric');
    e.passive = true;
    e.hp = e.maxHp * 0.5;
    expect(damageHero(a.w, a.h, 5, e.id)).toBe(true);
    expect(e.hp).toBeCloseTo(e.maxHp * (0.5 + AFFIX.VAMPIRIC_HEAL), 6);
    // A dodged attack heals nothing.
    expect(damageHero(a.w, a.h, 5, e.id)).toBe(false);
    expect(e.hp).toBeCloseTo(e.maxHp * (0.5 + AFFIX.VAMPIRIC_HEAL), 6);
    e.hp = e.maxHp - 1;
    a.h.invuln = 0;
    damageHero(a.w, a.h, 5, e.id);
    expect(e.hp).toBe(e.maxHp);
  });
});

describe('rewards', () => {
  it('reward maths: payments carry the bonus of their depth; Oath multiplies; MINIMUM floors; the hero bonus comes last', () => {
    const e = emptyEarnings();
    expect(glimmerReward(e, 0, 0, 0)).toBe(REWARDS.MINIMUM);
    expect(xpReward(e, 3, 0, 0.5)).toBe(Math.round(XP_REWARDS.MINIMUM * 1.5));
    earn(e, 'chamber', 0, false);
    earn(e, 'elite', 0, true);
    earn(e, 'boss', 2, false);
    expect(e.glimmer).toBeCloseTo(REWARDS.PER_CHAMBER_CLEARED + REWARDS.PER_ELITE_SLAIN + REWARDS.BOSS_SLAIN * (1 + 2 * REWARDS.DEPTH_BONUS), 9);
    expect(e.xp).toBeCloseTo(XP_REWARDS.PER_CHAMBER_CLEARED + XP_REWARDS.PER_ELITE_SLAIN + XP_REWARDS.BOSS_SLAIN * (1 + 2 * XP_REWARDS.DEPTH_BONUS), 9);
    expect(e.cursedGlimmer).toBe(REWARDS.PER_ELITE_SLAIN);
    expect(e.cursedXp).toBe(XP_REWARDS.PER_ELITE_SLAIN);
    expect(glimmerReward(e, 6, 0, 0)).toBe(Math.round(e.glimmer * (1 + 6 * REWARDS.OATH_BONUS)));
    expect(glimmerReward(e, 0, 0.25, 0.3)).toBe(Math.round((e.glimmer + 0.25 * REWARDS.PER_ELITE_SLAIN) * 1.3));
    expect(xpReward(e, 2, 0.25, 0.1)).toBe(Math.round((e.xp + 0.25 * XP_REWARDS.PER_ELITE_SLAIN) * (1 + 2 * XP_REWARDS.OATH_BONUS) * 1.1));
  });

  it('a won run pays Glimmer and XP per hero with the hero\'s own bonuses (fortune, scholar, Ascension, relics) and high Oath levels', () => {
    const oath = 5;
    const loadouts = [
      undefined,
      { meta: metaLevels({ fortune: 3, scholar: 3 }) },
      { paragon: paragonRanks({ asc_fortune: 10, asc_wisdom: 5 }), relics: [{ id: 'coin_of_charon', rank: 1 }] },
      { relics: [{ id: 'tome', rank: 5 }] },
    ];
    const w = start(['knight', 'mage', 'rogue', 'templar'], loadouts, 9, oath);
    toBoss(w);
    slayBoss(w);
    draftAll(w);
    takeDoor(w, doorOf(w, 'ascend'));
    const rewards = w.getRunState().rewards;
    const g = BASE_GLIMMER * (1 + REWARDS.OATH_BONUS * oath);
    const x = BASE_XP * (1 + XP_REWARDS.OATH_BONUS * oath);
    expect(rewards.map((r) => r.slot)).toEqual([0, 1, 2, 3]);
    expect(rewards.map((r) => r.glimmer)).toEqual([Math.round(g), Math.round(g * 1.3), Math.round(g * (1 + 0.2 + 0.1)), Math.round(g)]);
    expect(rewards.map((r) => r.xp)).toEqual([Math.round(x), Math.round(x * 1.3), Math.round(x * 1.1), Math.round(x * (1 + 0.12 * 2))]);
    for (const r of rewards) for (const id of r.relics) expect(RELIC_BY_ID.has(id)).toBe(true);
  });

  it('compass: what is earned in cursed chambers pays its owner more', () => {
    let cursedTaken = 0;
    const w = start(['knight', 'mage'], [{ relics: [{ id: 'compass', rank: 1 }] }], 31);
    let cursedGlimmer = 0;
    let cursedXp = 0;
    let glimmer = 0;
    let xp = 0;
    for (let chamber = 0; chamber < 4; chamber++) {
      const cursed = w.run.entered === 'cursed';
      const eliteChamber = w.run.chamberKind === 'elite';
      clearChamber(w);
      const g = REWARDS.PER_CHAMBER_CLEARED + (eliteChamber ? REWARDS.PER_ELITE_SLAIN : 0);
      const x = XP_REWARDS.PER_CHAMBER_CLEARED + (eliteChamber ? XP_REWARDS.PER_ELITE_SLAIN : 0);
      glimmer += g;
      xp += x;
      if (cursed) { cursedTaken++; cursedGlimmer += g; cursedXp += x; }
      draftAll(w);
      takeDoor(w, Math.max(0, doorOf(w, 'cursed')));
    }
    expect(cursedTaken).toBeGreaterThan(0);
    expect(w.director.earnings).toEqual({ glimmer, xp, cursedGlimmer, cursedXp });
    for (const h of w.heroes) { h.invuln = 0; downHero(w, h); }
    w.step();
    const [owner, other] = w.getRunState().rewards;
    expect(other).toMatchObject({ glimmer: Math.round(glimmer), xp: Math.round(xp) });
    expect(owner).toMatchObject({
      glimmer: Math.round(glimmer + cursedGlimmer * RELIC_TUNING.COMPASS_BONUS), xp: Math.round(xp + cursedXp * RELIC_TUNING.COMPASS_BONUS),
    });
    expect(owner!.glimmer).toBeGreaterThan(other!.glimmer);
  });

  it('relic drop chances: base per kind, plus depth, Oath and the hero\'s relicFind, never above 1', () => {
    expect(dropChance('elite', 0, 0, 0)).toBe(RELIC_TUNING.DROP_ELITE);
    expect(dropChance('herald', 0, 0, 0)).toBe(RELIC_TUNING.DROP_HERALD);
    expect(dropChance('boss', 0, 0, 0)).toBe(RELIC_TUNING.DROP_BOSS);
    expect(dropChance('elite', 2, 5, 0.24)).toBeCloseTo(RELIC_TUNING.DROP_ELITE + 2 * RELIC_TUNING.DROP_PER_DEPTH + 5 * RELIC_TUNING.DROP_PER_OATH + 0.24, 9);
    expect(dropChance('herald', 9, 20, 0.5)).toBe(1);
  });

  it('shards are rolled per hero from the run\'s own seeded stream: the frequencies follow the chances and the fight is not disturbed', () => {
    const w = start(['knight', 'mage'], [undefined, { meta: metaLevels({ salvage: 3 }) }], 77);
    const salvage = META_UPGRADES.find((u) => u.id === 'salvage')!.values.at(-1)!;
    expect(w.hero(1)!.mods.relicFind).toBeCloseTo(salvage, 9);
    const state = w.rng.state;
    const n = 4000;
    for (let i = 0; i < n; i++) rollShards(w, 'elite');
    expect(w.rng.state).toBe(state);
    const [plain, lucky] = [w.hero(0)!.shards, w.hero(1)!.shards];
    expect(plain.length / n).toBeGreaterThan(RELIC_TUNING.DROP_ELITE - 0.025);
    expect(plain.length / n).toBeLessThan(RELIC_TUNING.DROP_ELITE + 0.025);
    expect(lucky.length / n).toBeGreaterThan(RELIC_TUNING.DROP_ELITE + salvage - 0.03);
    expect(lucky.length / n).toBeLessThan(RELIC_TUNING.DROP_ELITE + salvage + 0.03);
    for (const id of plain) expect(RELIC_BY_ID.has(id)).toBe(true);
    expect(new Set(plain).size).toBeGreaterThan(15);
    // Heralds drop more often; a final boss always drops, twice below depth 0.
    w.hero(0)!.shards = [];
    for (let i = 0; i < n; i++) rollShards(w, 'herald');
    expect(w.hero(0)!.shards.length / n).toBeGreaterThan(RELIC_TUNING.DROP_HERALD - 0.03);
    expect(w.hero(0)!.shards.length / n).toBeLessThan(RELIC_TUNING.DROP_HERALD + 0.03);
    w.hero(0)!.shards = [];
    rollShards(w, 'boss');
    expect(w.hero(0)!.shards).toHaveLength(1);
    w.run.depth = 1;
    rollShards(w, 'boss');
    expect(w.hero(0)!.shards).toHaveLength(1 + RELIC_TUNING.DEEP_BOSS_SHARDS);
  });

  it('the same seed gives the same shards; a deeper final boss gives two per hero; rewards list them', () => {
    const play = (seed: number): string[][] => {
      const w = start(['knight', 'shade'], [], seed);
      toBoss(w);
      slayBoss(w);
      const afterFirst = w.heroes.map((h) => h.shards.length);
      for (const n of afterFirst) expect(n).toBeGreaterThanOrEqual(1);
      draftAll(w);
      takeDoor(w, doorOf(w, 'descend'));
      toBoss(w);
      slayBoss(w);
      w.heroes.forEach((h, i) => expect(h.shards.length).toBeGreaterThanOrEqual(afterFirst[i]! + RELIC_TUNING.DEEP_BOSS_SHARDS));
      draftAll(w);
      takeDoor(w, doorOf(w, 'ascend'));
      const rewards = w.getRunState().rewards;
      expect(rewards.map((r) => r.relics)).toEqual(w.heroes.map((h) => h.shards));
      // Depth 1 paid half as much again for everything earned there.
      expect(rewards[0]!.glimmer).toBe(Math.round(BASE_GLIMMER * (2 + REWARDS.DEPTH_BONUS)));
      expect(rewards[0]!.xp).toBe(Math.round(BASE_XP * (2 + XP_REWARDS.DEPTH_BONUS)));
      return rewards.map((r) => r.relics);
    };
    expect(play(42)).toEqual(play(42));
    expect(JSON.stringify(play(42))).not.toBe(JSON.stringify(play(43)));
  });

  it('run stats count elites, bosses and ultimates per hero', () => {
    const a = arena('knight');
    const kill = (kind: Parameters<typeof live>[1], opts: Parameters<typeof live>[4] = {}): void => {
      const e = live(a.w, kind, 0, 5, opts);
      killEnemy(a.w, e, 0);
    };
    kill('minion');
    expect(a.w.getRunState().stats[0]).toMatchObject({ kills: 1, elites: 0, bosses: 0, ultimates: 0 });
    kill('warrior', { elite: true });
    kill('champion');
    expect(a.w.getRunState().stats[0]).toMatchObject({ kills: 3, elites: 2, bosses: 0 });
    kill('matron', { herald: true });
    kill('regent');
    expect(a.w.getRunState().stats[0]).toMatchObject({ kills: 5, elites: 2, bosses: 2 });
    // Kills by nobody (a crumbling host) count for nobody.
    const e = live(a.w, 'minion', 0, 5, { elite: true });
    killEnemy(a.w, e, -1);
    expect(a.w.getRunState().stats[0]).toMatchObject({ kills: 5, elites: 2 });
  });
});

describe('determinism with the update 3 systems', () => {
  it('two runs from the same seed (seven classes, maxed builds, arts, ultimates, a descent) produce identical event streams', () => {
    const digest = (classes: ClassId[], seed: number) => {
      let hash = 0;
      let events = 0;
      const kinds = new Set<string>();
      const r = runBots({
        classes, seed, maxTicks: Math.round(240 / TICK_DT), descendTo: 1, startChamber: 6,
        loadouts: classes.map((cls) => ({ ...maxBuild(cls, maxMetaLevels()), relics: [{ id: 'storm_coil', rank: 3 }, { id: 'bell', rank: 2 }, { id: 'ember_heart', rank: 1 }] })),
        onTick: (_w, evs) => {
          for (const ev of evs) {
            kinds.add(ev.e);
            const text = JSON.stringify(ev);
            for (let i = 0; i < text.length; i++) hash = (Math.imul(hash, 31) + text.charCodeAt(i)) | 0;
            events++;
          }
        },
      });
      return { hash, events, kinds, phase: r.phase, ticks: r.ticks, depth: r.depth, cleared: r.cleared, dealt: Math.round(r.damageDealt), relics: r.relics, ultimates: r.ultimates, nan: r.nan };
    };
    const kinds = new Set<string>();
    for (const [classes, seed] of [[CLASS_IDS.slice(0, 4), 501], [CLASS_IDS.slice(3), 502]] as [ClassId[], number][]) {
      const a = digest(classes, seed);
      const b = digest(classes, seed);
      expect({ ...a, kinds: [...a.kinds] }).toEqual({ ...b, kinds: [...b.kinds] });
      expect(a.nan).toBe(false);
      expect(a.events).toBeGreaterThan(1000);
      expect(a.ultimates).toBeGreaterThan(0);
      const other = digest(classes, seed + 1000);
      expect(other.hash).not.toBe(a.hash);
      for (const k of a.kinds) kinds.add(k);
    }
    // The new systems really ran.
    for (const kind of ['zone', 'buff', 'ultReady', 'cast', 'resonance']) expect(kinds.has(kind), kind).toBe(true);
  }, 120000);
});
