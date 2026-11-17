import { describe, expect, it } from 'vitest';
import { RUN } from '@shared/constants.ts';
import { BOONS, BOON_BY_ID, BOON_TUNING } from '@shared/data/boons.ts';
import { applyBoon, generateDraft, Rng, World, type Hero } from '@shared/sim/index.ts';
import { clearChamber, seconds, stepN } from './harness.ts';

const hero = (...boons: string[]): Hero => {
  const w = new World();
  w.addPlayer(0, 'knight', 'T');
  const h = w.hero(0)!;
  for (const id of boons) applyBoon(h, id);
  return h;
};
const STD = { choices: RUN.DRAFT_CHOICES, guaranteeRare: false, guaranteeInfusion: false };
const rarity = (id: string): string => BOON_BY_ID.get(id)!.rarity;
const category = (id: string): string => BOON_BY_ID.get(id)!.category;

describe('generateDraft', () => {
  it('offers the requested number of distinct boons at the next level', () => {
    const h = hero('keen_edge');
    for (let seed = 1; seed <= 300; seed++) {
      const offers = generateDraft(new Rng(seed), h, STD);
      expect(offers).toHaveLength(RUN.DRAFT_CHOICES);
      expect(new Set(offers.map((o) => o.id)).size).toBe(offers.length);
      for (const o of offers) expect(o.level).toBe(o.id === 'keen_edge' ? 2 : 1);
    }
  });

  it('never offers a boon that is already at its maximum level', () => {
    const maxed = BOONS.filter((b) => b.category !== 'infusion').slice(0, 12);
    const h = hero();
    for (const def of maxed) for (let i = 0; i < def.values.length; i++) applyBoon(h, def.id);
    const ids = new Set(maxed.map((b) => b.id));
    for (let seed = 1; seed <= 300; seed++) {
      for (const o of generateDraft(new Rng(seed), h, STD)) expect(ids.has(o.id), o.id).toBe(false);
    }
  });

  it('only offers element and resonance boons once the hero has a matching infusion', () => {
    const plain = hero();
    const ember = hero('infuse_ember_secondary');
    const seenPlain = new Set<string>();
    const seenEmber = new Set<string>();
    for (let seed = 1; seed <= 600; seed++) {
      for (const o of generateDraft(new Rng(seed), plain, STD)) seenPlain.add(o.id);
      for (const o of generateDraft(new Rng(seed), ember, STD)) seenEmber.add(o.id);
    }
    for (const id of seenPlain) {
      expect(['element', 'resonance'], id).not.toContain(category(id));
      expect(id).not.toBe('shared_vigor');
    }
    expect(seenEmber.has('wildfire')).toBe(true);
    expect(seenEmber.has('deep_frost')).toBe(false);
    expect(seenEmber.has('overcharge')).toBe(false);
    for (const id of ['amplifier', 'wide_resonance', 'aftershock', 'echo', 'shared_vigor']) expect(seenEmber.has(id), id).toBe(true);
  });

  it('can guarantee an infusion and (for cursed drafts) four choices with a rare or better', () => {
    const h = hero();
    for (let seed = 1; seed <= 300; seed++) {
      const first = generateDraft(new Rng(seed), h, { ...STD, guaranteeInfusion: true });
      expect(first.some((o) => category(o.id) === 'infusion')).toBe(true);
      const cursed = generateDraft(new Rng(seed), h, { choices: BOON_TUNING.CURSED_DRAFT_CHOICES, guaranteeRare: true, guaranteeInfusion: false });
      expect(cursed).toHaveLength(BOON_TUNING.CURSED_DRAFT_CHOICES);
      expect(new Set(cursed.map((o) => o.id)).size).toBe(cursed.length);
      expect(cursed.some((o) => rarity(o.id) !== 'common')).toBe(true);
    }
  });

  it('weights offers by rarity', () => {
    const h = hero('infuse_ember_primary');
    const counts: Record<string, number> = { common: 0, rare: 0, epic: 0 };
    const pool: Record<string, number> = { common: 0, rare: 0, epic: 0 };
    for (const b of BOONS) pool[b.rarity]!++;
    for (let seed = 1; seed <= 2000; seed++) for (const o of generateDraft(new Rng(seed), h, STD)) counts[rarity(o.id)]!++;
    // Per-boon frequency must follow common > rare > epic.
    expect(counts.common! / pool.common!).toBeGreaterThan(counts.rare! / pool.rare!);
    expect(counts.rare! / pool.rare!).toBeGreaterThan(counts.epic! / pool.epic!);
    expect(counts.epic!).toBeGreaterThan(0);
  });

  it('shrinks gracefully when almost everything is maxed', () => {
    const h = hero();
    for (const def of BOONS) for (let i = 0; i < def.values.length; i++) applyBoon(h, def.id);
    const offers = generateDraft(new Rng(1), h, STD);
    for (const o of offers) expect(category(o.id)).toBe('infusion');
  });
});

describe('draft flow in a run', () => {
  const start = (classes: ('knight' | 'mage')[] = ['knight', 'mage'], seed = 5): World => {
    const w = new World();
    classes.forEach((cls, slot) => w.addPlayer(slot, cls, `P${slot}`));
    w.start(0, seed);
    return w;
  };

  it('the first draft of a run always contains an infusion for every hero', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const w = start(['knight', 'mage'], seed);
      clearChamber(w);
      expect(w.run.phase).toBe('draft');
      expect(w.getRunState().draftPending).toEqual([0, 1]);
      for (const slot of [0, 1]) {
        const offers = w.getDraft(slot);
        expect(offers).toHaveLength(RUN.DRAFT_CHOICES);
        expect(offers.some((o) => category(o.id) === 'infusion')).toBe(true);
      }
    }
  });

  it('picking applies the boon, emits `boon`, updates getBoons and the pending list', () => {
    const w = start();
    clearChamber(w);
    w.drainEvents();
    const version = w.runVersion;
    const offer = w.getDraft(1)[2]!;
    expect(w.pickBoon(1, 7)).toBe(false);
    expect(w.pickBoon(1, -1)).toBe(false);
    expect(w.pickBoon(5, 0)).toBe(false);
    expect(w.pickBoon(1, 2)).toBe(true);
    expect(w.pickBoon(1, 0)).toBe(false);
    expect(w.getBoons(1)).toEqual([{ id: offer.id, level: 1 }]);
    expect(w.getDraft(1)).toEqual([]);
    expect(w.getRunState().draftPending).toEqual([0]);
    expect(w.runVersion).toBeGreaterThan(version);
    expect(w.drainEvents()).toContainEqual({ e: 'boon', slot: 1, id: offer.id, level: 1 });
    expect(w.run.phase).toBe('draft');
    expect(w.pickBoon(0, 0)).toBe(true);
    stepN(w, 2);
    expect(w.run.phase).toBe('doors');
  });

  it('auto-picks the first option when the draft times out', () => {
    const w = start();
    clearChamber(w);
    const first = [w.getDraft(0)[0]!, w.getDraft(1)[0]!];
    stepN(w, seconds(RUN.DRAFT_TIMEOUT_SECONDS) - 10);
    expect(w.run.phase).toBe('draft');
    expect(w.getRunState().draftTime).toBeGreaterThan(0);
    stepN(w, 15);
    expect(w.run.phase).toBe('doors');
    expect(w.getBoons(0)).toEqual([{ id: first[0]!.id, level: 1 }]);
    expect(w.getBoons(1)).toEqual([{ id: first[1]!.id, level: 1 }]);
  });

  it('does not wait for disconnected heroes (they get their first option)', () => {
    const w = start();
    clearChamber(w);
    w.setConnected(1, false);
    const first = w.getDraft(1)[0]!;
    w.pickBoon(0, 0);
    stepN(w, 2);
    expect(w.run.phase).toBe('doors');
    expect(w.getBoons(1)).toEqual([{ id: first.id, level: 1 }]);
  });

  it('refuses picks outside the draft phase', () => {
    const w = start();
    expect(w.pickBoon(0, 0)).toBe(false);
    expect(w.getDraft(0)).toEqual([]);
  });
});
