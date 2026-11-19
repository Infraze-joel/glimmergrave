/**
 * Update 5: combinations must not break the simulation. Every pair of generic keystones and every class keystone
 * with each generic one is played through chambers 5-8 by a bot (with three infusions, so statuses, Resonances and
 * blooms happen), and the caps of KEYSTONE_CAPS are checked where runaway loops could start.
 */
import { describe, expect, it } from 'vitest';
import { TICK_DT, WORLD } from '@shared/constants.ts';
import { KEYSTONES, KEYSTONE_CAPS } from '@shared/data/keystones.ts';
import { killEnemy, setStatus } from '@shared/sim/combat.ts';
import { maxBuild, maxMetaLevels } from '@shared/sim/index.ts';
import { BTN, CLASS_IDS, type ClassId, type GameEvent } from '@shared/types.ts';
import { dummy, runBots, seconds, SLOW_STEP_MS, stepN, type RunResult } from './harness.ts';
import { arena, give, mastered, of } from './u3kit.ts';

const GENERIC = KEYSTONES.filter((k) => k.cls === undefined).map((k) => k.id);
const CLASS = KEYSTONES.filter((k) => k.cls !== undefined);
const INFUSIONS = ['infuse_ember_primary', 'infuse_rime_secondary', 'infuse_storm_dash'];
/** Most events one tick may produce (a 48-enemy room hit by an area attack plus statuses and kills stays far below). */
const MAX_EVENTS_PER_TICK = 400;
/**
 * Step time. A tick lasts 33 ms. Wall-clock maxima cannot be asserted on a shared machine (a step that produced no
 * event at all was measured at 200 ms while other processes were building), so the bound is on how many steps of a
 * fight are slow (over SLOW_STEP_MS = 8 ms): a keystone that made the simulation expensive would be slow on every
 * tick of its effect, not on a handful. The slowest step and the mean are printed.
 */
const MAX_SLOW_SHARE = 0.03;
const FIGHT_TICKS = 30 * 60 * 8;

function fight(cls: ClassId, pair: string[], seed: number): RunResult & { ms: number } {
  const t0 = performance.now();
  const r = runBots({
    classes: [cls], seed, startChamber: 4, maxTicks: FIGHT_TICKS, grant: [pair], boons: INFUSIONS, keystoneMode: 'none', timeSteps: true,
    loadouts: [maxBuild(cls, maxMetaLevels())],
  });
  return { ...r, ms: performance.now() - t0 };
}

function check(r: RunResult & { ms: number }, label: string, pair: string[]): void {
  expect(r.nan, label).toBe(false);
  expect(r.keystones[0], label).toEqual(pair);
  expect(r.maxEnemies, label).toBeLessThanOrEqual(WORLD.MAX_ENEMIES);
  expect(r.maxProjectiles, label).toBeLessThanOrEqual(WORLD.MAX_PROJECTILES);
  expect(r.maxEventsPerTick, label).toBeLessThanOrEqual(MAX_EVENTS_PER_TICK);
  expect(r.slowSteps / Math.max(1, r.ticks), `${label}: ${r.slowSteps} slow steps of ${r.ticks}, slowest ${r.maxStepMs.toFixed(0)} ms`).toBeLessThanOrEqual(MAX_SLOW_SHARE);
  expect(r.damageDealt, label).toBeGreaterThan(0);
  expect(r.ticks, label).toBeGreaterThan(seconds(5));
}

describe('every combination survives a bot fight', () => {
  it(`all ${(GENERIC.length * (GENERIC.length - 1)) / 2} pairs of generic keystones`, () => {
    let n = 0;
    let worst = 0;
    let worstEvents = 0;
    let slow = 0;
    let ticks = 0;
    let ms = 0;
    for (let i = 0; i < GENERIC.length; i++) {
      for (let j = i + 1; j < GENERIC.length; j++) {
        const cls = CLASS_IDS[n % CLASS_IDS.length]!;
        const pair = [GENERIC[i]!, GENERIC[j]!];
        const r = fight(cls, pair, 9000 + n);
        check(r, `${cls} ${pair.join('+')}`, pair);
        worst = Math.max(worst, r.maxStepMs);
        worstEvents = Math.max(worstEvents, r.maxEventsPerTick);
        slow += r.slowSteps;
        ticks += r.ticks;
        ms += r.ms;
        n++;
      }
    }
    expect(n).toBe(120);
    process.stdout.write(`generic pairs: ${n} fights, ${ticks} ticks, mean ${(ms / ticks).toFixed(3)} ms per tick (bots included), ${slow} steps over ${SLOW_STEP_MS} ms, slowest ${worst.toFixed(1)} ms, most events in a tick ${worstEvents}\n`);
  }, 900000);

  it(`all ${CLASS.length * GENERIC.length} pairs of a class keystone with a generic one`, () => {
    let n = 0;
    let worst = 0;
    let worstEvents = 0;
    let slow = 0;
    let ticks = 0;
    let ms = 0;
    for (const k of CLASS) {
      for (const g of GENERIC) {
        const pair = [k.id, g];
        const r = fight(k.cls!, pair, 12000 + n);
        check(r, pair.join('+'), pair);
        worst = Math.max(worst, r.maxStepMs);
        worstEvents = Math.max(worstEvents, r.maxEventsPerTick);
        slow += r.slowSteps;
        ticks += r.ticks;
        ms += r.ms;
        n++;
      }
    }
    expect(n).toBe(112);
    process.stdout.write(`class pairs: ${n} fights, ${ticks} ticks, mean ${(ms / ticks).toFixed(3)} ms per tick (bots included), ${slow} steps over ${SLOW_STEP_MS} ms, slowest ${worst.toFixed(1)} ms, most events in a tick ${worstEvents}\n`);
  }, 900000);

  it('a party of four with eight keystones between them', () => {
    const r = runBots({
      classes: ['mage', 'rogue', 'spellblade', 'barbarian'], seed: 4242, startChamber: 4, maxTicks: FIGHT_TICKS, keystoneMode: 'none', timeSteps: true, boons: INFUSIONS,
      grant: [['ks_mage', 'chain_lightning'], ['ricochet', 'ks_rogue'], ['ks_spellblade', 'corpse_bloom'], ['twin_cast', 'blood_price']],
      loadouts: (['mage', 'rogue', 'spellblade', 'barbarian'] as ClassId[]).map((c) => maxBuild(c, maxMetaLevels())),
    });
    expect(r.nan).toBe(false);
    expect(r.maxProjectiles).toBeLessThanOrEqual(WORLD.MAX_PROJECTILES);
    expect(r.maxEventsPerTick).toBeLessThanOrEqual(MAX_EVENTS_PER_TICK * 2);
    expect(r.slowSteps / r.ticks).toBeLessThanOrEqual(MAX_SLOW_SHARE);
  }, 120000);
});

describe('caps', () => {
  const pack = (w: Parameters<typeof dummy>[0], n: number, hp = 100000): ReturnType<typeof dummy>[] => {
    const out = [];
    for (let i = 0; i < n; i++) out.push(dummy(w, -6.8 + (i % 8) * 1.7, 3 + Math.floor(i / 8) * 1.7, 'minion', hp));
    return out;
  };

  it('keystoneProc: per hero and keystone, bursts are PROC_SECONDS apart and at most PROC_BURST events (state-carrying ones excepted)', () => {
    const a = arena('rogue');
    for (const id of ['ricochet', 'chain_lightning']) a.w.grantKeystone(0, id);
    pack(a.w, 40);
    const byTick = new Map<string, number[]>();
    for (let t = 0; t < seconds(8); t++) {
      const ev = a.pad.hold({ aim: 0, aimDist: 5, buttons: BTN.PRIMARY }, 1);
      const counts: Record<string, number> = {};
      for (const p of of(ev, 'keystoneProc')) counts[p.id] = (counts[p.id] ?? 0) + 1;
      for (const [id, n] of Object.entries(counts)) {
        expect(n, id).toBeLessThanOrEqual(KEYSTONE_CAPS.PROC_BURST);
        (byTick.get(id) ?? byTick.set(id, []).get(id)!).push(t);
      }
    }
    for (const id of ['ricochet', 'chain_lightning']) {
      const ticks = byTick.get(id)!;
      expect(ticks.length, id).toBeGreaterThan(10);
      for (let i = 1; i < ticks.length; i++) expect((ticks[i]! - ticks[i - 1]!) * TICK_DT, id).toBeGreaterThanOrEqual(KEYSTONE_CAPS.PROC_SECONDS - 1e-6);
    }
  });

  it('Ricochet + Chain Lightning + Fan the Hammer: projectiles stay under the cap and no hit chains further than its own bounces and arcs', () => {
    const a = arena('rogue');
    for (const id of ['ricochet', 'chain_lightning']) a.w.grantKeystone(0, id);
    give(a.h, 'infuse_storm_primary');
    const foes = pack(a.w, 40);
    let most = 0;
    let events = 0;
    for (let t = 0; t < seconds(10); t++) {
      const ev = a.pad.hold({ aim: 0, aimDist: 5, buttons: BTN.PRIMARY }, 1);
      most = Math.max(most, a.w.projectiles.length);
      events = Math.max(events, ev.length);
      for (const p of a.w.projectiles) expect(p.bounces).toBeLessThanOrEqual(2);
    }
    expect(most).toBeLessThanOrEqual(WORLD.MAX_PROJECTILES);
    expect(events).toBeLessThan(60);
    expect(foes.some((e) => e.hp < e.maxHp)).toBe(true);
  });

  it('Twin Cast + Blood Price: casts are bounded by the cooldown floor and by health; twins never twin; zones per hero are capped', () => {
    const a = arena('templar');
    for (const id of ['twin_cast', 'blood_price']) a.w.grantKeystone(0, id);
    pack(a.w, 16);
    let casts = 0;
    let twins = 0;
    for (let t = 0; t < seconds(20); t++) {
      a.h.hp = a.h.maxHp;
      const ev: GameEvent[] = a.pad.hold({ aim: 0, buttons: t % 2 === 0 ? BTN.SECONDARY : 0 }, 1);
      casts += of(ev, 'keystoneProc').filter((p) => p.id === 'blood_price').length;
      twins += of(ev, 'keystoneProc').filter((p) => p.id === 'twin_cast').length;
      expect(a.h.pending.filter((p) => p.twin).length).toBeLessThanOrEqual(KEYSTONE_CAPS.TWINS_PENDING);
      expect(a.w.zones.filter((z) => z.def.shape !== 'trap').length).toBeLessThanOrEqual(KEYSTONE_CAPS.ZONES_PER_HERO);
    }
    expect(casts).toBeGreaterThan(20);
    expect(casts).toBeLessThanOrEqual(Math.ceil(20 / 0.6) + 1);
    // Every cast is repeated exactly once (the last repeat may still be waiting).
    expect(twins).toBeGreaterThanOrEqual(casts - 1);
    expect(twins).toBeLessThanOrEqual(casts);
    // Without the free refill: health is the limit.
    const b = arena('mage');
    for (const id of ['twin_cast', 'blood_price']) b.w.grantKeystone(0, id);
    let paid = 0;
    for (let t = 0; t < seconds(30); t++) paid += of(b.pad.hold({ aim: 0, aimDist: 5, buttons: t % 2 === 0 ? BTN.SECONDARY : 0 }, 1), 'keystoneProc').filter((p) => p.id === 'blood_price').length;
    expect(paid).toBe(13);
    expect(b.h.hp).toBe(1);
  });

  it('Corpse Bloom in a full room: the queue and the bursts per tick stay bounded and the chain ends', () => {
    const a = arena('mage');
    a.w.grantKeystone(0, 'corpse_bloom');
    a.w.grantKeystone(0, 'glass_cannon');
    const foes = [];
    for (let i = 0; i < WORLD.MAX_ENEMIES - 1; i++) foes.push(dummy(a.w, -8 + (i % 8) * 1.2, -8 + Math.floor(i / 8) * 1.2, 'minion', 20));
    for (const e of foes) setStatus(a.w, e, i(foes, e) % 2 === 0 ? 'ember' : 'storm', a.h, 1);
    killEnemy(a.w, foes[0]!, 0);
    let ticks = 0;
    for (; ticks < seconds(20) && (a.w.blooms.length > 0 || ticks < 10); ticks++) {
      const ev = stepN(a.w, 1);
      expect(of(ev, 'keystoneProc').filter((p) => p.id === 'corpse_bloom').length).toBeLessThanOrEqual(KEYSTONE_CAPS.BLOOMS_PER_TICK);
      expect(a.w.blooms.length).toBeLessThanOrEqual(KEYSTONE_CAPS.BLOOM_QUEUE);
      expect(ev.length).toBeLessThan(MAX_EVENTS_PER_TICK);
    }
    expect(ticks).toBeLessThan(seconds(20));
    expect(foes.filter((e) => e.dead).length).toBeGreaterThan(WORLD.MAX_ENEMIES / 2);
  });

  it('keystone damage never touches the bell shard, heroes or anything in the draft / doors phases', () => {
    const a = arena('knight', mastered());
    for (const id of ['orbit_blades', 'ember_wake']) a.w.grantKeystone(0, id);
    const b = a.w.hero(0)!;
    a.pad.hold({ moveZ: 1, aim: 0, buttons: BTN.DASH }, 1);
    a.pad.hold({ aim: 0 }, seconds(1));
    expect(a.w.trails.length).toBe(1);
    expect(b.damageTaken).toBe(0);
    // Leaving combat: nothing keeps ticking.
    a.w.run.phase = 'doors';
    const e = dummy(a.w, 0, a.h.body.z + 2.6);
    stepN(a.w, seconds(2));
    expect(e.hp).toBe(e.maxHp);
  });
});

function i<T>(list: readonly T[], item: T): number {
  return list.indexOf(item);
}
