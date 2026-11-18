import { describe, expect, it } from 'vitest';
import { RUN, TICK_DT, WORLD } from '@shared/constants.ts';
import { BOONS, BOON_BY_ID, BOON_TUNING } from '@shared/data/boons.ts';
import { CLASSES, DASH } from '@shared/data/classes.ts';
import { STATUS } from '@shared/data/enemies.ts';
import { XP_REWARDS } from '@shared/data/mastery.ts';
import { META_INDEX, META_UPGRADES, REWARDS } from '@shared/data/meta.ts';
import { reactionOf } from '@shared/data/reactions.ts';
import {
  applyBoon, baseReward, computeMeta, DIRECTOR, generateDraft, heroReward, maxMetaLevels, META, noMetaLevels, Rng, SIM, World,
} from '@shared/sim/index.ts';
import { BTN, type ClassId, type GameEvent } from '@shared/types.ts';
import { clearChamber, draftAll, dummy, Pad, place, seconds, stepN, takeDoor } from './harness.ts';

const levels = (id: string, level: number): number[] => {
  const m = noMetaLevels();
  m[META_INDEX.get(id)!] = level;
  return m;
};
const def = (id: string) => META_UPGRADES[META_INDEX.get(id)!]!;
const arena = (cls: ClassId, meta?: number[], seed = 1): World => {
  const w = new World();
  w.addPlayer(0, cls, 'T', meta);
  w.startSandbox(seed);
  place(w, 0, 0, 0);
  return w;
};
const run = (classes: ClassId[], metas: (number[] | undefined)[], seed = 5, oath = 0): World => {
  const w = new World();
  classes.forEach((cls, slot) => w.addPlayer(slot, cls, `P${slot}`, metas[slot]));
  expect(w.start(oath, seed)).toBe(true);
  return w;
};
const category = (id: string): string => BOON_BY_ID.get(id)!.category;

describe('permanent upgrades: sanitising inside the simulation', () => {
  it('clamps whatever levels it is handed and treats missing ones as 0', () => {
    const max = maxMetaLevels();
    expect(computeMeta(undefined).levels).toEqual(noMetaLevels());
    expect(max).toHaveLength(META_UPGRADES.length);
    expect(computeMeta(META_UPGRADES.map(() => 99)).levels).toEqual(max);
    const rest = META_UPGRADES.slice(3).map(() => 0);
    expect(computeMeta([-1, 2.9, NaN]).levels).toEqual([0, 2, 0, ...rest]);
    const w = new World();
    w.addPlayer(0, 'knight', 'A', [1e9, -5, 1.5] as number[]);
    expect(w.getMeta(0)).toEqual([max[0], 0, 1, ...rest]);
    // setMeta replaces the levels in the lobby only; a class change keeps them.
    expect(w.setMeta(0, max)).toBe(true);
    expect(w.setClass(0, 'mage')).toBe(true);
    expect(w.getMeta(0)).toEqual(max);
    expect(w.hero(0)!.maxHp).toBe(CLASSES.mage.maxHp + def('vitality').values.at(-1)!);
    w.start(0, 1);
    expect(w.setMeta(0, noMetaLevels())).toBe(false);
    expect(w.getMeta(0)).toEqual(max);
    w.reset();
    expect(w.getMeta(0)).toEqual(max);
  });
});

describe('permanent upgrades: every effect matches its summary', () => {
  it('vitality: +{v} maximum health at every level (and it stacks with iron_heart)', () => {
    def('vitality').values.forEach((v, i) => {
      const w = arena('knight', levels('vitality', i + 1));
      const h = w.hero(0)!;
      expect(h.maxHp).toBe(CLASSES.knight.maxHp + v);
      expect(h.hp).toBe(h.maxHp);
      expect(w.getSnapshotBody().players[0]!.maxHp).toBe(CLASSES.knight.maxHp + v);
      applyBoon(h, 'iron_heart');
      expect(h.maxHp).toBe(CLASSES.knight.maxHp + v + BOON_BY_ID.get('iron_heart')!.values[0]!);
    });
    expect(arena('knight').hero(0)!.maxHp).toBe(CLASSES.knight.maxHp);
  });

  it('might: +{v}% damage with everything (strikes, Resonance bursts, burn ticks)', () => {
    const strike = (meta?: number[]): number => {
      const w = arena('knight', meta);
      const d = dummy(w, 0, 2);
      new Pad(w).hold({ buttons: BTN.PRIMARY, aim: 0 }, 8);
      return 100000 - d.hp;
    };
    const base = strike();
    expect(base).toBeCloseTo(CLASSES.knight.primary[0]!.damage, 6);
    def('might').values.forEach((v, i) => expect(strike(levels('might', i + 1))).toBeCloseTo(base * (1 + v), 6));

    const burst = (meta?: number[]): { resonance: number; burn: number } => {
      const w = arena('mage', meta);
      const h = w.hero(0)!;
      applyBoon(h, 'infuse_ember_primary');
      applyBoon(h, 'infuse_rime_secondary');
      const d = dummy(w, 0, 6);
      const pad = new Pad(w);
      pad.hold({ buttons: BTN.PRIMARY, aim: 0 }, 3);
      pad.hold({ aim: 0 }, seconds(0.6));
      const afterBolt = d.hp;
      // One burn tick has passed since the bolt landed.
      pad.hold({ aim: 0 }, seconds(SIM.BURN_TICK_SECONDS));
      const burn = afterBolt - d.hp;
      // The tick in which the nova lands on the burning dummy: nova damage + the Resonance burst, nothing else.
      let resonance = NaN;
      for (let i = 0; i < seconds(1) && Number.isNaN(resonance); i++) {
        const before = d.hp;
        const ev = pad.hold({ buttons: i === 0 ? BTN.SECONDARY : 0, aim: 0, aimDist: 6 }, 1);
        if (ev.some((e) => e.e === 'resonance')) resonance = before - d.hp - CLASSES.mage.secondary.damage * (1 + h.meta.might);
      }
      return { resonance, burn };
    };
    const plain = burst();
    // Ember then rime is Shatter (burst x damageMul).
    const shatter = reactionOf('ember', 'rime')!.damageMul;
    expect(plain.resonance).toBeCloseTo(STATUS.RESONANCE.DAMAGE * shatter, 4);
    expect(plain.burn).toBeCloseTo(STATUS.BURN.DPS * SIM.BURN_TICK_SECONDS, 4);
    const v = def('might').values.at(-1)!;
    const mighty = burst(levels('might', def('might').values.length));
    expect(mighty.resonance).toBeCloseTo(STATUS.RESONANCE.DAMAGE * shatter * (1 + v), 4);
    expect(mighty.burn).toBeCloseTo(STATUS.BURN.DPS * SIM.BURN_TICK_SECONDS * (1 + v), 4);
  });

  it('swiftness: +{v}% movement speed (reported in SelfState, so prediction follows)', () => {
    const walk = (meta?: number[]): { speed: number; dist: number } => {
      const w = arena('rogue', meta);
      new Pad(w).hold({ moveX: 1 }, 30);
      return { speed: w.getSelfState(0).moveSpeed, dist: w.hero(0)!.body.x };
    };
    const base = walk();
    expect(base.speed).toBeCloseTo(CLASSES.rogue.moveSpeed, 6);
    def('swiftness').values.forEach((v, i) => {
      const fast = walk(levels('swiftness', i + 1));
      expect(fast.speed).toBeCloseTo(CLASSES.rogue.moveSpeed * (1 + v), 6);
      expect(fast.dist).toBeCloseTo(base.dist * (1 + v), 4);
    });
  });

  it('celerity: the secondary recharges {v}% faster', () => {
    const cooldown = (meta?: number[]): number => {
      const w = arena('knight', meta);
      new Pad(w).hold({ buttons: BTN.SECONDARY, aim: 0 }, 1);
      return w.hero(0)!.secondaryCdMax;
    };
    expect(cooldown()).toBeCloseTo(CLASSES.knight.secondary.cooldown, 6);
    def('celerity').values.forEach((v, i) => expect(cooldown(levels('celerity', i + 1))).toBeCloseTo(CLASSES.knight.secondary.cooldown / (1 + v), 6));
    // Measured: with the top level it really is ready again that much sooner.
    const w = arena('knight', levels('celerity', 3));
    const pad = new Pad(w);
    pad.hold({ buttons: BTN.SECONDARY, aim: 0 }, 1);
    const ready = CLASSES.knight.secondary.cooldown / (1 + def('celerity').values[2]!);
    pad.hold({}, seconds(ready) - 3);
    expect(w.hero(0)!.secondaryCd).toBeGreaterThan(0);
    pad.hold({}, 4);
    expect(w.hero(0)!.secondaryCd).toBe(0);
  });

  it('footwork: the dash recharges {v}% faster', () => {
    const recharge = (meta?: number[]): number => {
      const w = arena('knight', meta);
      const pad = new Pad(w);
      pad.hold({ buttons: BTN.DASH, moveX: 1 }, 1);
      expect(w.hero(0)!.dashCharges).toBe(0);
      let ticks = 0;
      while (w.hero(0)!.dashCharges === 0 && ticks < seconds(6)) { pad.hold({}, 1); ticks++; }
      return (ticks + 1) * TICK_DT;
    };
    expect(recharge()).toBeCloseTo(DASH.COOLDOWN, 1);
    def('footwork').values.forEach((v, i) => expect(recharge(levels('footwork', i + 1))).toBeCloseTo(DASH.COOLDOWN / (1 + v), 1));
  });

  it('resolve: revived heroes return with {v}% more health and 2 s of invulnerability (also on a Second Wind)', () => {
    def('resolve').values.forEach((v, i) => {
      const w = new World();
      w.addPlayer(0, 'knight', 'A');
      w.addPlayer(1, 'mage', 'B', levels('resolve', i + 1));
      w.addPlayer(2, 'mage', 'C');
      w.startSandbox(3);
      for (const slot of [1, 2]) { const h = w.hero(slot)!; h.hp = 0; h.state = 'downed'; place(w, slot, slot === 1 ? 1 : -1, 0); }
      place(w, 0, 0, 0);
      stepN(w, seconds(WORLD.REVIVE_SECONDS) + 2);
      const resolved = w.hero(1)!;
      const plain = w.hero(2)!;
      expect(resolved.state).toBe('alive');
      expect(plain.state).toBe('alive');
      expect(plain.hp).toBe(Math.round(plain.maxHp * WORLD.REVIVE_HP_FRACTION));
      expect(resolved.hp).toBe(Math.round(resolved.maxHp * WORLD.REVIVE_HP_FRACTION * (1 + v)));
      expect(resolved.invuln).toBeGreaterThan(META.RESOLVE_INVULNERABILITY - 3 * TICK_DT);
      expect(plain.invuln).toBeLessThanOrEqual(SIM.REVIVE_IFRAMES);
      expect(META.RESOLVE_INVULNERABILITY).toBe(2);
    });
    // Solo: the Second Wind is a revive too.
    const solo = run(['knight'], [levels('resolve', 2)]);
    const h = solo.hero(0)!;
    stepN(solo, 2);
    h.invuln = 0;
    h.hp = 0;
    h.state = 'downed';
    h.secondWindTimer = SIM.SECOND_WIND_DELAY;
    stepN(solo, seconds(SIM.SECOND_WIND_DELAY) + 2);
    expect(h.state).toBe('alive');
    expect(h.hp).toBe(Math.round(h.maxHp * WORLD.REVIVE_HP_FRACTION * 1.5));
  });

  it('insight: {v} rerolls per run, reported per hero and restored for the next run', () => {
    def('insight').values.forEach((v, i) => {
      const w = run(['knight', 'mage'], [levels('insight', i + 1), undefined]);
      expect(w.getRerolls(0)).toBe(v);
      expect(w.getRerolls(1)).toBe(0);
      clearChamber(w);
      expect(w.rerollDraft(0)).toBe(true);
      expect(w.getRerolls(0)).toBe(v - 1);
      w.reset();
      w.start(0, 9);
      expect(w.getRerolls(0)).toBe(v);
    });
  });

  it('every upgrade has as many values as costs, and the maxed hero differs from a fresh one in every stat', () => {
    for (const u of META_UPGRADES) expect(u.values).toHaveLength(u.costs.length);
    const fresh = computeMeta(noMetaLevels()).stats;
    const maxed = computeMeta(maxMetaLevels()).stats;
    expect(fresh).toEqual({
      hp: 0, might: 0, moveSpeed: 0, secondaryHaste: 0, dashHaste: 0, rerolls: 0, attunement: false, resolve: 0, fortune: 0,
      foresight: 0, tenacity: false,
    });
    for (const key of Object.keys(fresh) as (keyof typeof fresh)[]) expect(maxed[key], key).not.toBe(fresh[key]);
  });
});

describe('draft rerolls (insight)', () => {
  it('replaces the offers with a fresh valid draft that repeats nothing just shown', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const w = run(['knight'], [levels('insight', 3)], seed);
      clearChamber(w);
      expect(w.run.phase).toBe('draft');
      let shown = w.getDraft(0);
      for (let n = 0; n < 3; n++) {
        const version = w.draftVersion;
        expect(w.rerollDraft(0)).toBe(true);
        const next = w.getDraft(0);
        expect(next).toHaveLength(RUN.DRAFT_CHOICES);
        expect(new Set(next.map((o) => o.id)).size).toBe(next.length);
        for (const o of next) expect(shown.map((s) => s.id), `seed ${seed}`).not.toContain(o.id);
        // Same rules as the draft it replaces: the first draft of a run keeps its guaranteed infusion.
        expect(next.some((o) => category(o.id) === 'infusion')).toBe(true);
        expect(w.draftVersion).toBeGreaterThan(version);
        expect(w.getRunState().draftPending).toEqual([0]);
        shown = next;
      }
      // Out of rerolls: nothing changes any more, but picking still works.
      expect(w.rerollDraft(0)).toBe(false);
      expect(w.getDraft(0)).toEqual(shown);
      expect(w.pickBoon(0, 1)).toBe(true);
      expect(w.getBoons(0)).toEqual([{ id: shown[1]!.id, level: 1 }]);
      expect(w.rerollDraft(0)).toBe(false);
    }
  });

  it('is refused without the upgrade, outside a draft and for unknown slots; rerolls last the whole run', () => {
    const w = run(['knight', 'mage'], [levels('insight', 1), undefined]);
    expect(w.rerollDraft(0)).toBe(false);
    clearChamber(w);
    expect(w.rerollDraft(1)).toBe(false);
    expect(w.rerollDraft(7)).toBe(false);
    const other = w.getDraft(1);
    expect(w.rerollDraft(0)).toBe(true);
    expect(w.getDraft(1)).toEqual(other);
    draftAll(w);
    takeDoor(w, 0);
    clearChamber(w);
    // The single reroll was spent in chamber 1.
    expect(w.run.phase).toBe('draft');
    expect(w.getRerolls(0)).toBe(0);
    expect(w.rerollDraft(0)).toBe(false);
  });

  it('a cursed draft keeps its four choices and its guaranteed rare after a reroll', () => {
    let tested = 0;
    for (let seed = 1; seed <= 40 && tested < 5; seed++) {
      const w = run(['knight'], [levels('insight', 2)], seed);
      clearChamber(w);
      draftAll(w);
      const cursed = w.getRunState().doors.findIndex((d) => d.type === 'cursed');
      if (cursed < 0) continue;
      takeDoor(w, cursed);
      clearChamber(w);
      const shown = w.getDraft(0);
      expect(shown).toHaveLength(BOON_TUNING.CURSED_DRAFT_CHOICES);
      expect(w.rerollDraft(0)).toBe(true);
      const next = w.getDraft(0);
      expect(next).toHaveLength(BOON_TUNING.CURSED_DRAFT_CHOICES);
      expect(next.some((o) => BOON_BY_ID.get(o.id)!.rarity !== 'common')).toBe(true);
      for (const o of next) expect(shown.map((s) => s.id)).not.toContain(o.id);
      tested++;
    }
    expect(tested).toBeGreaterThan(0);
  });

  it('repeats shown offers only when there are not enough alternatives', () => {
    const w = new World();
    w.addPlayer(0, 'knight', 'T');
    const h = w.hero(0)!;
    // Max everything except four plain boons.
    const keep = ['keen_edge', 'heavy_hand', 'fleet_foot', 'quick_step'];
    for (const b of BOONS) if (!keep.includes(b.id) && b.category !== 'infusion') for (let i = 0; i < b.values.length; i++) applyBoon(h, b.id);
    const opts = { choices: 3, guaranteeRare: false, guaranteeInfusion: false };
    for (let seed = 1; seed <= 60; seed++) {
      // Infusions stay offerable, so take them out of the picture by showing them all.
      const infusions = BOONS.filter((b) => b.category === 'infusion').map((b) => b.id);
      const shown = ['keen_edge', 'heavy_hand', 'fleet_foot'];
      const next = generateDraft(new Rng(seed), h, opts, new Set([...shown, ...infusions]));
      expect(next).toHaveLength(3);
      expect(new Set(next.map((o) => o.id)).size).toBe(3);
      // The one boon that was not shown is always in; the other two have to be repeats.
      expect(next.map((o) => o.id)).toContain('quick_step');
    }
    // Nothing else left at all: the same offers come back rather than an empty draft.
    const all = new Set(BOONS.map((b) => b.id));
    expect(generateDraft(new Rng(1), h, opts, all)).toHaveLength(3);
  });
});

describe('attunement draft at run start', () => {
  const attuned = levels('attunement', 1);

  it('gives only its owners a private draft of 3 infusions and holds the first wave until it is resolved', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const w = run(['knight', 'mage'], [attuned, undefined], seed);
      const state = w.getRunState();
      expect(state.phase).toBe('draft');
      expect(state.chamber).toBe(0);
      expect(state.wave).toBe(0);
      expect(state.draftPending).toEqual([0]);
      expect(state.draftTime).toBe(RUN.DRAFT_TIMEOUT_SECONDS);
      expect(state.room).not.toBeNull();
      const offers = w.getDraft(0);
      expect(offers).toHaveLength(META.ATTUNEMENT_CHOICES);
      expect(META.ATTUNEMENT_CHOICES).toBe(3);
      expect(new Set(offers.map((o) => o.id)).size).toBe(3);
      for (const o of offers) { expect(category(o.id)).toBe('infusion'); expect(o.level).toBe(1); }
      expect(w.getDraft(1)).toEqual([]);
      // Nothing spawns while the draft is open, however long it takes (short of the timeout).
      const waiting = stepN(w, seconds(8));
      expect(waiting.filter((e) => e.e === 'wave' || e.e === 'spawn')).toHaveLength(0);
      expect(w.enemies).toHaveLength(0);
      expect(w.run.phase).toBe('draft');
      // A hero without the upgrade cannot pick.
      expect(w.pickBoon(1, 0)).toBe(false);
      expect(w.pickBoon(0, 2)).toBe(true);
      expect(w.getBoons(0)).toEqual([{ id: offers[2]!.id, level: 1 }]);
      const after: GameEvent[] = [];
      let waveTick = -1;
      const from = w.tick;
      for (let i = 0; i < seconds(DIRECTOR.FIRST_WAVE_DELAY + 1) && waveTick < 0; i++) {
        w.step();
        const ev = w.drainEvents();
        after.push(...ev);
        if (ev.some((e) => e.e === 'wave')) waveTick = w.tick;
      }
      expect(w.run.phase).toBe('combat');
      expect(w.getRunState().doors).toEqual([]);
      // The chamber starts exactly as it would have without the draft: first wave after FIRST_WAVE_DELAY.
      expect((waveTick - from) * TICK_DT).toBeGreaterThanOrEqual(DIRECTOR.FIRST_WAVE_DELAY);
      expect((waveTick - from) * TICK_DT).toBeLessThan(DIRECTOR.FIRST_WAVE_DELAY + 0.2);
    }
  });

  it('waits for every owner, resolves on the timeout with the first option, and skips disconnected owners', () => {
    const w = run(['knight', 'mage', 'rogue'], [attuned, attuned, attuned], 3);
    expect(w.getRunState().draftPending).toEqual([0, 1, 2]);
    w.pickBoon(0, 0);
    stepN(w, seconds(3));
    expect(w.run.phase).toBe('draft');
    w.setConnected(2, false);
    const first = [w.getDraft(1)[0]!, w.getDraft(2)[0]!];
    stepN(w, seconds(RUN.DRAFT_TIMEOUT_SECONDS) - seconds(3) - 5);
    expect(w.run.phase).toBe('draft');
    expect(w.enemies).toHaveLength(0);
    stepN(w, 12);
    expect(w.run.phase).toBe('combat');
    expect(w.getBoons(1)).toEqual([{ id: first[0]!.id, level: 1 }]);
    expect(w.getBoons(2)).toEqual([{ id: first[1]!.id, level: 1 }]);

    // Only a disconnected owner left: no waiting at all.
    const v = run(['knight', 'mage'], [undefined, attuned], 4);
    v.setConnected(1, false);
    stepN(v, 2);
    expect(v.run.phase).toBe('combat');
    expect(v.getBoons(1)).toHaveLength(1);
  });

  it('does nothing without the upgrade, can be rerolled, and the normal draft + doors follow the first chamber', () => {
    const plain = run(['knight'], [undefined]);
    expect(plain.run.phase).toBe('combat');
    expect(plain.getDraft(0)).toEqual([]);

    const meta = levels('attunement', 1);
    meta[META_INDEX.get('insight')!] = 1;
    const w = run(['knight'], [meta], 8);
    const shown = w.getDraft(0);
    expect(w.rerollDraft(0)).toBe(true);
    const next = w.getDraft(0);
    expect(next).toHaveLength(3);
    for (const o of next) { expect(category(o.id)).toBe('infusion'); expect(shown.map((s) => s.id)).not.toContain(o.id); }
    w.pickBoon(0, 0);
    stepN(w, 2);
    expect(w.run.phase).toBe('combat');
    clearChamber(w);
    expect(w.run.phase).toBe('draft');
    expect(w.getDraft(0)).toHaveLength(RUN.DRAFT_CHOICES);
    const taken = w.getDraft(0)[0]!.id;
    draftAll(w);
    expect(w.run.phase).toBe('doors');
    // The attunement infusion plus the pick (an infusion for the same ability replaces the first one).
    expect(w.getBoons(0).map((b) => b.id)).toContain(taken);
    expect(w.getBoons(0).length).toBeGreaterThanOrEqual(1);
    expect(w.getBoons(0).length).toBeLessThanOrEqual(2);
    // The second chamber starts in combat: the attunement draft happens once per run.
    takeDoor(w, 0);
    expect(w.run.phase).toBe('combat');
  });
});

describe('rewards', () => {
  it('reward maths: tally x oath multiplier, at least MINIMUM, then the hero\'s own fortune bonus, rounded', () => {
    const tally = (chambersCleared: number, elitesSlain: number, bossSlain: boolean, oath: number) => baseReward({ chambersCleared, elitesSlain, bossSlain, oath });
    expect(tally(0, 0, false, 0)).toBe(REWARDS.MINIMUM);
    expect(tally(0, 0, false, 3)).toBe(REWARDS.MINIMUM);
    expect(tally(3, 1, false, 0)).toBe(3 * REWARDS.PER_CHAMBER_CLEARED + REWARDS.PER_ELITE_SLAIN);
    expect(tally(3, 1, false, 2)).toBeCloseTo((3 * 12 + 18) * (1 + 2 * REWARDS.OATH_BONUS), 9);
    expect(tally(8, 2, true, 0)).toBe(8 * 12 + 2 * 18 + 80);
    expect(tally(8, 2, true, 3)).toBeCloseTo(212 * 1.75, 9);
    expect(heroReward(REWARDS.MINIMUM, 0)).toBe(10);
    expect(heroReward(REWARDS.MINIMUM, 0.3)).toBe(13);
    expect(heroReward(81, 0.1)).toBe(89);
    expect(heroReward(82.5, 0)).toBe(83);
    for (const base of [10, 54, 82.5, 212, 371]) for (const f of [0, ...def('fortune').values]) expect(Number.isInteger(heroReward(base, f))).toBe(true);
  });

  it('are empty during the run and published per hero when it ends in defeat (minimum payout in chamber 1)', () => {
    const w = run(['knight', 'mage'], [undefined, levels('fortune', 3)], 2);
    expect(w.getRunState().rewards).toEqual([]);
    stepN(w, seconds(3));
    expect(w.getRunState().rewards).toEqual([]);
    for (const h of w.heroes) { h.invuln = 0; h.hp = 0; h.state = 'downed'; }
    const version = w.runVersion;
    w.step();
    const state = w.getRunState();
    expect(state.phase).toBe('defeat');
    expect(w.runVersion).toBeGreaterThan(version);
    expect(state.rewards).toEqual([
      { slot: 0, glimmer: REWARDS.MINIMUM, xp: XP_REWARDS.MINIMUM, relics: [] },
      { slot: 1, glimmer: Math.round(REWARDS.MINIMUM * 1.3), xp: XP_REWARDS.MINIMUM, relics: [] },
    ]);
    // Nothing is paid twice.
    stepN(w, seconds(2));
    expect(w.getRunState().rewards).toEqual(state.rewards);
  });

  it('count cleared chambers and slain elites with the oath multiplier on a late defeat', () => {
    const w = run(['knight', 'rogue'], [levels('fortune', 1), undefined], 6, 1);
    for (let chamber = 0; chamber < 4; chamber++) {
      clearChamber(w);
      draftAll(w);
      takeDoor(w, 0);
    }
    expect(w.run.chamber).toBe(4);
    expect(w.director.chambersCleared).toBe(4);
    expect(w.director.elitesSlain).toBe(1);
    // A player who leaves before the end is not paid.
    w.removePlayer(1);
    const h = w.hero(0)!;
    stepN(w, 3);
    h.invuln = 0;
    h.hp = 0;
    h.state = 'downed';
    w.step();
    expect(w.run.phase).toBe('defeat');
    const base = (4 * REWARDS.PER_CHAMBER_CLEARED + REWARDS.PER_ELITE_SLAIN) * (1 + REWARDS.OATH_BONUS);
    const xp = (4 * XP_REWARDS.PER_CHAMBER_CLEARED + XP_REWARDS.PER_ELITE_SLAIN) * (1 + XP_REWARDS.OATH_BONUS);
    const reward = w.getRunState().rewards;
    expect(reward).toHaveLength(1);
    expect(reward[0]).toMatchObject({ slot: 0, glimmer: Math.round(base * 1.1), xp: Math.round(xp) });
    // The champion of the elite chamber may have dropped a relic shard (12 % per hero); nothing else can have.
    expect(reward[0]!.relics.length).toBeLessThanOrEqual(1);
  });

  it('a victory pays every chamber, both elites and the boss', () => {
    const w = run(['knight', 'mage', 'rogue'], [undefined, levels('fortune', 2), levels('fortune', 3)], 12, 2);
    for (let chamber = 0; chamber < RUN.CHAMBERS.length - 1; chamber++) {
      clearChamber(w);
      draftAll(w);
      takeDoor(w, 0);
    }
    expect(w.run.chamberKind).toBe('boss');
    for (let i = 0; i < seconds(8) && w.run.bossId < 0; i++) { for (const h of w.heroes) h.invuln = 1; w.step(); }
    const boss = w.enemies.find((e) => e.id === w.run.bossId)!;
    expect(boss.kind).toBe(w.run.finalBoss);
    boss.spawnTime = 0;
    boss.hp = 0;
    boss.dead = true;
    w.step();
    // Since update 3 the run goes on after the boss: a draft, then the descend / ascend doors. Ascending banks it.
    expect(w.run.phase).toBe('draft');
    expect(w.getRunState().rewards).toEqual([]);
    draftAll(w);
    expect(w.getRunState().doors.map((d) => d.type)).toEqual(['descend', 'ascend']);
    takeDoor(w, 1);
    const state = w.getRunState();
    expect(state.phase).toBe('victory');
    expect(state).toMatchObject({ cleared: 1, depth: 0, chambersCleared: RUN.CHAMBERS.length });
    const base = (8 * REWARDS.PER_CHAMBER_CLEARED + 2 * REWARDS.PER_ELITE_SLAIN + REWARDS.BOSS_SLAIN) * (1 + 2 * REWARDS.OATH_BONUS);
    expect(base).toBe(318);
    expect(state.rewards.map((r) => ({ slot: r.slot, glimmer: r.glimmer }))).toEqual([{ slot: 0, glimmer: 318 }, { slot: 1, glimmer: Math.round(318 * 1.2) }, { slot: 2, glimmer: Math.round(318 * 1.3) }]);
    const xp = (8 * XP_REWARDS.PER_CHAMBER_CLEARED + 2 * XP_REWARDS.PER_ELITE_SLAIN + XP_REWARDS.BOSS_SLAIN) * (1 + 2 * XP_REWARDS.OATH_BONUS);
    for (const r of state.rewards) {
      expect(r.xp).toBe(Math.round(xp));
      // The final boss always drops one shard per hero at depth 0.
      expect(r.relics.length).toBeGreaterThanOrEqual(1);
    }
    // Back in the lobby the slate is clean.
    w.reset();
    expect(w.getRunState().rewards).toEqual([]);
  });
});
