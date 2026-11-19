/** Update 5: keystone drafts (timing, class filter, max held, replace, skip, timeout, reroll, determinism) and build tags. */
import { describe, expect, it } from 'vitest';
import { RUN } from '@shared/constants.ts';
import { BOONS, BOON_BY_ID, BOON_TUNING } from '@shared/data/boons.ts';
import { boonTags, BUILD_TAGS, KEYSTONES, KEYSTONE_BY_ID, KEYSTONE_TUNING, sharedTags } from '@shared/data/keystones.ts';
import { draftWeight, heldTags } from '@shared/sim/boons.ts';
import { generateKeystoneDraft } from '@shared/sim/keystones.ts';
import { applyBoon, generateDraft, Rng, World, type Hero } from '@shared/sim/index.ts';
import { CLASS_IDS, type ClassId, type GameEvent } from '@shared/types.ts';
import { draftAll, seconds, takeDoor } from './harness.ts';
import { metaLevels, of } from './u3kit.ts';
import { finishChamber } from './u4kit.ts';

const CHAMPION = RUN.CHAMBERS.indexOf('elite');
const HERALD = RUN.CHAMBERS.lastIndexOf('elite');

/** A run that starts in `chamber`, already cleared: the heroes stand in its draft. */
function atDraft(classes: ClassId[], chamber: number, seed = 5, loadout?: unknown, keystones?: string[]): World {
  const w = new World();
  classes.forEach((cls, slot) => w.addPlayer(slot, cls, `P${slot}`, loadout));
  w.start(0, seed, chamber, { keystones });
  for (const slot of w.getRunState().draftPending) w.pickBoon(slot, 0);
  finishChamber(w);
  expect(w.run.phase).toBe('draft');
  return w;
}
const cls = (id: string): ClassId | undefined => KEYSTONE_BY_ID.get(id)?.cls;
const hero = (c: ClassId, ...keystones: string[]): Hero => {
  const w = new World();
  w.addPlayer(0, c, 'T');
  for (const id of keystones) expect(w.grantKeystone(0, id)).toBe(true);
  return w.hero(0)!;
};

describe('keystone drafts: when and what', () => {
  it('follow the champion and the herald chamber for every hero, at every depth — never an ordinary chamber or the boss', () => {
    const w = new World();
    w.addPlayer(0, 'knight', 'A');
    w.addPlayer(1, 'mage', 'B');
    w.start(0, 21);
    const seen: string[] = [];
    for (let depth = 0; depth < 2; depth++) {
      for (let chamber = 0; chamber < RUN.CHAMBERS.length; chamber++) {
        expect(w.run.chamber).toBe(chamber);
        finishChamber(w);
        expect(w.run.phase).toBe('draft');
        const elite = RUN.CHAMBERS[chamber] === 'elite';
        for (const slot of [0, 1]) {
          const ks = w.getKeystoneDraft(slot);
          expect(ks !== null, `depth ${depth} chamber ${chamber} slot ${slot}`).toBe(elite);
          if (!ks) continue;
          const offers = w.getDraft(slot);
          expect(offers).toHaveLength(KEYSTONE_TUNING.CHOICES);
          expect(ks.skip).toBe(offers.length);
          expect(ks.held).toEqual(w.getKeystones(slot));
          for (const o of offers) {
            expect(KEYSTONE_BY_ID.has(o.id)).toBe(true);
            expect(o).toEqual({ id: o.id, level: 1 });
            expect(ks.held).not.toContain(o.id);
          }
          seen.push(`${depth}.${chamber}.${slot}`);
          // Take the first one while a slot is free.
          if (ks.held.length < KEYSTONE_TUNING.MAX_HELD) expect(w.pickBoon(slot, 0)).toBe(true);
        }
        draftAll(w);
        expect(w.run.phase).toBe('doors');
        takeDoor(w, 0);
      }
      expect(w.run.depth).toBe(depth + 1);
    }
    expect(seen).toHaveLength(2 * 2 * 2);
    for (const slot of [0, 1]) expect(w.getKeystones(slot)).toHaveLength(KEYSTONE_TUNING.MAX_HELD);
  });

  it('offers distinct keystones the hero does not hold, class keystones only to their class and at most one', () => {
    for (const c of CLASS_IDS) {
      const h = hero(c, 'colossus');
      let own = 0;
      const total = 400;
      for (let seed = 1; seed <= total; seed++) {
        const offers = generateKeystoneDraft(new Rng(seed), h);
        expect(offers).toHaveLength(KEYSTONE_TUNING.CHOICES);
        expect(new Set(offers.map((o) => o.id)).size).toBe(offers.length);
        expect(offers.map((o) => o.id)).not.toContain('colossus');
        const classOnes = offers.filter((o) => cls(o.id) !== undefined);
        expect(classOnes.length).toBeLessThanOrEqual(1);
        for (const o of classOnes) expect(cls(o.id)).toBe(c);
        own += classOnes.length;
      }
      // The class keystone weighs CLASS_WEIGHT: it shows up clearly more often than a generic one (3 of 15 = 20 %).
      expect(own / total, c).toBeGreaterThan(0.35);
      expect(own / total, c).toBeLessThan(0.75);
    }
  });

  it('is a pure function of the seed and honours pinned keystones (tools)', () => {
    const offers = (seed: number, pins?: string[]): string[][] => {
      const w = atDraft(['rogue', 'templar'], CHAMPION, seed, undefined, pins);
      return [0, 1].map((slot) => w.getDraft(slot).map((o) => o.id));
    };
    expect(offers(77)).toEqual(offers(77));
    expect(JSON.stringify([offers(77), offers(78), offers(79)])).not.toBe(JSON.stringify([offers(80), offers(81), offers(82)]));
    const pinned = offers(77, ['ks_templar', 'glass_cannon']);
    // The rogue cannot take the templar's keystone: only the generic pin applies to it.
    expect(pinned[0]![0]).toBe('glass_cannon');
    expect(pinned[1]!.slice(0, 2)).toEqual(['ks_templar', 'glass_cannon']);
  });
});

describe('keystone drafts: picking', () => {
  it('a pick with a free slot takes the keystone: event, roster list, pending cleared', () => {
    const w = atDraft(['knight'], CHAMPION);
    const id = w.getDraft(0)[1]!.id;
    w.drainEvents();
    const version = w.boonVersion;
    // A needless `replace` is ignored while a slot is free.
    expect(w.pickBoon(0, 1, 'colossus')).toBe(true);
    expect(of(w.drainEvents(), 'keystone')).toEqual([{ e: 'keystone', slot: 0, id }]);
    expect(w.getKeystones(0)).toEqual([id]);
    expect(w.boonVersion).toBeGreaterThan(version);
    expect(w.getRunState().draftPending).toEqual([]);
    expect(w.getDraft(0)).toEqual([]);
    expect(w.getKeystoneDraft(0)).toBeNull();
    expect(w.getBoons(0).some((b) => b.id === id)).toBe(false);
  });

  it('with both slots full a pick needs a valid `replace`; otherwise it is refused and the draft stays', () => {
    const w = new World();
    w.addPlayer(0, 'knight', 'A');
    w.start(0, 9, HERALD, { keystones: ['familiar'] });
    w.grantKeystone(0, 'colossus');
    w.grantKeystone(0, 'sanguine');
    finishChamber(w);
    const before = w.getDraft(0);
    expect(w.getKeystoneDraft(0)).toEqual({ held: ['colossus', 'sanguine'], skip: KEYSTONE_TUNING.CHOICES });
    expect(before[0]!.id).toBe('familiar');
    for (const bad of [undefined, 'familiar', 'glass_cannon', '']) {
      expect(w.pickBoon(0, 0, bad), String(bad)).toBe(false);
      expect(w.getDraft(0)).toEqual(before);
      expect(w.getRunState().draftPending).toEqual([0]);
      expect(w.getKeystones(0)).toEqual(['colossus', 'sanguine']);
    }
    expect(w.pickBoon(0, 7, 'colossus')).toBe(false);
    w.drainEvents();
    const hp = w.hero(0)!.maxHp;
    expect(w.pickBoon(0, 0, 'colossus')).toBe(true);
    expect(of(w.drainEvents(), 'keystone')).toEqual([{ e: 'keystone', slot: 0, id: 'familiar', replaced: 'colossus' }]);
    expect(w.getKeystones(0)).toEqual(['sanguine', 'familiar']);
    expect(w.hero(0)!.maxHp).toBe(hp - KEYSTONE_BY_ID.get('colossus')!.params.hp!);
    expect(w.getRunState().draftPending).toEqual([]);
  });

  it('the skip index trades the keystone draft for an ordinary draft of rare-or-better boons', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const w = atDraft(['knight', 'mage'], CHAMPION, seed);
      const ks = w.getKeystoneDraft(0)!;
      expect(w.pickBoon(0, ks.skip)).toBe(true);
      expect(w.getKeystoneDraft(0)).toBeNull();
      expect(w.getRunState().draftPending).toContain(0);
      const offers = w.getDraft(0);
      expect(offers).toHaveLength(RUN.DRAFT_CHOICES);
      for (const o of offers) {
        expect(BOON_BY_ID.has(o.id)).toBe(true);
        expect(BOON_BY_ID.get(o.id)!.rarity, o.id).not.toBe('common');
      }
      // The other hero's keystone draft is untouched.
      expect(w.getKeystoneDraft(1)).not.toBeNull();
      expect(w.pickBoon(0, 0)).toBe(true);
      expect(w.getKeystones(0)).toEqual([]);
      expect(w.getBoons(0).some((b) => b.id === offers[0]!.id)).toBe(true);
    }
  });

  it('foresight adds its choice to the consolation draft, not to the keystones', () => {
    const w = atDraft(['knight'], CHAMPION, 3, { meta: metaLevels({ foresight: 1 }) });
    expect(w.getDraft(0)).toHaveLength(KEYSTONE_TUNING.CHOICES);
    w.pickBoon(0, w.getKeystoneDraft(0)!.skip);
    expect(w.getDraft(0)).toHaveLength(RUN.DRAFT_CHOICES + 1);
  });

  it('a skip late in the draft leaves time to choose', () => {
    const w = atDraft(['knight'], CHAMPION);
    w.run.draftTime = 2;
    w.pickBoon(0, w.getKeystoneDraft(0)!.skip);
    expect(w.run.draftTime).toBe(KEYSTONE_TUNING.CONSOLATION_SECONDS);
  });

  it('rerolls replace the offered keystones (same rules) and work on the consolation draft too', () => {
    const w = atDraft(['mage'], CHAMPION, 4, { meta: metaLevels({ insight: 2 }) });
    const first = w.getDraft(0).map((o) => o.id);
    expect(w.getRerolls(0)).toBe(2);
    expect(w.rerollDraft(0)).toBe(true);
    const second = w.getDraft(0).map((o) => o.id);
    expect(w.getRerolls(0)).toBe(1);
    expect(w.getKeystoneDraft(0)).not.toBeNull();
    expect(second).toHaveLength(KEYSTONE_TUNING.CHOICES);
    for (const id of second) {
      expect(first).not.toContain(id);
      expect(KEYSTONE_BY_ID.has(id)).toBe(true);
      expect([undefined, 'mage']).toContain(cls(id));
    }
    w.pickBoon(0, w.getKeystoneDraft(0)!.skip);
    const boons = w.getDraft(0).map((o) => o.id);
    expect(w.rerollDraft(0)).toBe(true);
    for (const o of w.getDraft(0)) {
      expect(boons).not.toContain(o.id);
      expect(BOON_BY_ID.get(o.id)!.rarity).not.toBe('common');
    }
    expect(w.rerollDraft(0)).toBe(false);
  });

  it('a draft that times out does nothing harmful: free slot -> the first keystone; full slots -> the consolation', () => {
    const run = (full: boolean): { w: World; events: GameEvent[]; first: string } => {
      const w = new World();
      w.addPlayer(0, 'barbarian', 'A');
      w.start(0, 13, CHAMPION);
      if (full) { w.grantKeystone(0, 'colossus'); w.grantKeystone(0, 'sanguine'); }
      finishChamber(w);
      const first = w.getDraft(0)[0]!.id;
      const events: GameEvent[] = [];
      for (let t = 0; t < seconds(RUN.DRAFT_TIMEOUT_SECONDS + 2) && w.run.phase === 'draft'; t++) { w.step(); events.push(...w.drainEvents()); }
      expect(w.run.phase).toBe('doors');
      return { w, events, first };
    };
    const free = run(false);
    expect(free.w.getKeystones(0)).toEqual([free.first]);
    expect(of(free.events, 'keystone')).toHaveLength(1);
    const full = run(true);
    expect(full.w.getKeystones(0)).toEqual(['colossus', 'sanguine']);
    expect(of(full.events, 'keystone')).toHaveLength(0);
    const boon = of(full.events, 'boon');
    expect(boon).toHaveLength(1);
    expect(BOON_BY_ID.get(boon[0]!.id)!.rarity).not.toBe('common');
  });

  it('the training session has no keystone drafts', () => {
    const w = new World();
    w.addPlayer(0, 'knight', 'A');
    w.startTutorial(3);
    for (let t = 0; t < seconds(20); t++) { w.step(); expect(w.getKeystoneDraft(0)).toBeNull(); }
    expect(w.getKeystones(0)).toEqual([]);
  });
});

describe('build tags', () => {
  it('every boon has tags from the vocabulary; sharedTags lists what a boon has in common with the held keystones', () => {
    for (const b of BOONS) for (const tag of boonTags(b)) expect(BUILD_TAGS as readonly string[], b.id).toContain(tag);
    for (const k of KEYSTONES) for (const tag of k.tags) expect(BUILD_TAGS as readonly string[], k.id).toContain(tag);
    expect(sharedTags('quick_step', ['ember_wake'])).toEqual(['dash']);
    expect(sharedTags('keen_edge', ['ember_wake'])).toEqual([]);
    expect(sharedTags('keen_edge', [])).toEqual([]);
    expect(sharedTags('momentum', ['momentum_engine', 'ricochet']).sort()).toEqual(['primary', 'speed']);
  });

  it('weights: TAG_WEIGHT per shared tag up to the cap, off-build commons at OFF_BUILD_COMMON_WEIGHT, nothing changes without a keystone', () => {
    const T = KEYSTONE_TUNING;
    const W = BOON_TUNING.WEIGHTS;
    const def = (id: string) => BOON_BY_ID.get(id)!;
    const none = heldTags([]);
    for (const b of BOONS) expect(draftWeight(b, none)).toBe(W[b.rarity]);
    const dash = heldTags(['ember_wake']);
    expect(draftWeight(def('quick_step'), dash)).toBeCloseTo(W.common * T.TAG_WEIGHT, 9);
    expect(draftWeight(def('slipstream'), heldTags(['shockstep']))).toBeCloseTo(W[def('slipstream').rarity] * T.TAG_WEIGHT ** 2, 9);
    expect(draftWeight(def('keen_edge'), dash)).toBeCloseTo(W.common * T.OFF_BUILD_COMMON_WEIGHT, 9);
    // A rare boon off the build keeps its weight.
    expect(draftWeight(def('deadeye'), dash)).toBe(W.rare);
    // The cap.
    const many = heldTags(KEYSTONES.map((k) => k.id));
    for (const b of BOONS) expect(draftWeight(b, many)).toBeLessThanOrEqual(W[b.rarity] * T.TAG_WEIGHT_CAP + 1e-9);
    expect(Math.max(...BOONS.map((b) => draftWeight(b, many) / W[b.rarity]))).toBeCloseTo(T.TAG_WEIGHT_CAP, 9);
  });

  it('drafts mark fitting boons, roll them more often and roll off-build commons less once a keystone is held', () => {
    const STD = { choices: RUN.DRAFT_CHOICES, guaranteeRare: false, guaranteeInfusion: false };
    const plain = hero('knight');
    const built = hero('knight', 'ember_wake', 'phase_walker');
    const held = heldTags(built.keystones);
    const count = (h: Hero): { fit: number; offCommon: number; total: number } => {
      const out = { fit: 0, offCommon: 0, total: 0 };
      for (let seed = 1; seed <= 1500; seed++) {
        for (const o of generateDraft(new Rng(seed), h, STD)) {
          const def = BOON_BY_ID.get(o.id)!;
          const shared = boonTags(def).filter((t) => held.has(t));
          out.total++;
          if (shared.length > 0) out.fit++;
          else if (def.rarity === 'common') out.offCommon++;
          if (h === plain) expect(o.fits).toBeUndefined();
          else if (shared.length >= KEYSTONE_TUNING.FIT_TAGS) expect(o.fits).toEqual(shared);
          else expect(o.fits).toBeUndefined();
        }
      }
      return out;
    };
    const a = count(plain);
    const b = count(built);
    expect(b.fit / b.total).toBeGreaterThan((a.fit / a.total) * 1.25);
    expect(b.offCommon / b.total).toBeLessThan((a.offCommon / a.total) * 0.75);
    // World.getDraft hands the marks out.
    const w = atDraft(['knight'], 0, 2);
    w.grantKeystone(0, 'heavy_hitter');
    draftAll(w);
    takeDoor(w, 0);
    finishChamber(w);
    let marked = 0;
    for (const o of w.getDraft(0)) if (o.fits) { marked++; expect(o.fits).toEqual(sharedTags(o.id, ['heavy_hitter'])); } else expect(sharedTags(o.id, ['heavy_hitter'])).toEqual([]);
    expect(marked + w.getDraft(0).length).toBeGreaterThan(0);
    // Picking a boon still works exactly as before.
    expect(applyBoon(plain, 'keen_edge')).toBe(1);
  });
});
