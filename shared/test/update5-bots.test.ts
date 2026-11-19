/** Update 5: bots choose keystones for their class and build, and play the ones that ask for it. */
import { describe, expect, it } from 'vitest';
import { RUN } from '@shared/constants.ts';
import { KEYSTONE_BY_ID, KEYSTONE_TUNING } from '@shared/data/keystones.ts';
import { BotBrain, maxBuild, maxMetaLevels } from '@shared/sim/index.ts';
import { PF, type BoonOffer, type BoonStack, type ClassId, type GameEvent } from '@shared/types.ts';
import { runBots } from './harness.ts';

const offers = (...ids: string[]): BoonOffer[] => ids.map((id) => ({ id, level: 1 }));
const boons = (...ids: string[]): BoonStack[] => ids.map((id) => ({ id, level: 1 }));
const SKIP = KEYSTONE_TUNING.CHOICES;
const pick = (cls: ClassId, ids: string[], held: string[] = [], own: BoonStack[] = [], opts: ConstructorParameters<typeof BotBrain>[3] = {}): { id: string | 'skip'; replace?: string } => {
  const choice = new BotBrain(0, cls, 1, opts).chooseKeystone(offers(...ids), held, SKIP, own);
  return { id: choice.index === SKIP ? 'skip' : ids[choice.index]!, replace: choice.replace };
};

describe('choosing keystones', () => {
  it('prefers the class keystone, then what suits the class', () => {
    expect(pick('mage', ['colossus', 'ks_mage', 'ricochet']).id).toBe('ks_mage');
    expect(pick('knight', ['glass_cannon', 'orbit_blades', 'blood_price']).id).toBe('orbit_blades');
    expect(pick('rogue', ['colossus', 'ricochet', 'phase_walker']).id).toBe('ricochet');
    expect(pick('barbarian', ['resonance_engine', 'corpse_bloom', 'colossus']).id).toBe('colossus');
  });

  it('prefers keystones that match its infusions', () => {
    const three = ['ember_wake', 'sanguine', 'corpse_bloom'];
    expect(pick('knight', three).id).toBe('sanguine');
    expect(pick('knight', three, [], boons('infuse_storm_dash')).id).toBe('ember_wake');
    expect(pick('knight', ['resonance_engine', 'blood_price', 'phase_walker']).id).not.toBe('resonance_engine');
    expect(pick('knight', ['resonance_engine', 'blood_price', 'phase_walker'], [], boons('infuse_storm_dash', 'infuse_ember_primary')).id).toBe('resonance_engine');
    expect(pick('mage', ['corpse_bloom', 'blood_price', 'phase_walker'], [], boons('infuse_ember_primary', 'infuse_rime_secondary')).id).toBe('corpse_bloom');
  });

  it('with full slots it replaces its weakest keystone for a clearly better one, else takes the consolation', () => {
    expect(pick('knight', ['orbit_blades', 'blood_price', 'corpse_bloom'], ['resonance_engine', 'colossus'])).toEqual({ id: 'orbit_blades', replace: 'resonance_engine' });
    expect(pick('knight', ['blood_price', 'corpse_bloom', 'resonance_engine'], ['ks_knight', 'orbit_blades'])).toEqual({ id: 'skip', replace: undefined });
  });

  it('forced keystones (tests, --keystone) beat everything; modes `only` and `none` take the consolation otherwise', () => {
    const force = { keystones: ['blood_price'] };
    expect(pick('knight', ['ks_knight', 'blood_price', 'colossus'], [], [], force).id).toBe('blood_price');
    expect(pick('knight', ['ks_knight', 'blood_price', 'colossus'], ['ks_knight', 'colossus'], [], force)).toMatchObject({ id: 'blood_price' });
    expect(pick('knight', ['ks_knight', 'blood_price', 'colossus'], ['ks_knight', 'colossus'], [], force).replace).toBeDefined();
    expect(pick('knight', ['ks_knight', 'sanguine', 'colossus'], [], [], { ...force, keystoneMode: 'only' }).id).toBe('skip');
    expect(pick('knight', ['ks_knight', 'sanguine', 'colossus'], [], [], force).id).toBe('ks_knight');
    expect(pick('knight', ['ks_knight', 'blood_price', 'colossus'], [], [], { ...force, keystoneMode: 'none' }).id).toBe('skip');
  });
});

describe('bots in runs', () => {
  it('take a keystone after the champion and one after the herald (class keystone and build first), in a party too', () => {
    let two = 0;
    let classOnes = 0;
    let offered = 0;
    const runs = [
      ...(['knight', 'mage', 'shade', 'templar'] as ClassId[]).map((cls, i) => runBots({ classes: [cls], seed: 700 + i, loadouts: [maxBuild(cls, maxMetaLevels())] })),
      runBots({ classes: ['barbarian', 'rogue', 'spellblade'], seed: 710, loadouts: (['barbarian', 'rogue', 'spellblade'] as ClassId[]).map((c) => maxBuild(c, maxMetaLevels())) }),
    ];
    for (const r of runs) {
      expect(r.cleared, r.label).toBeGreaterThan(0);
      for (const held of r.keystones) {
        expect(held.length).toBe(KEYSTONE_TUNING.MAX_HELD);
        expect(new Set(held).size).toBe(held.length);
        two++;
        offered++;
        if (held.some((id) => KEYSTONE_BY_ID.get(id)!.cls !== undefined)) classOnes++;
      }
      expect(r.keystonePicks).toBe(r.keystones.length * 2);
    }
    expect(two).toBe(7);
    // The class keystone is offered in roughly half of the drafts; most heroes end up with it.
    expect(classOnes).toBeGreaterThanOrEqual(3);
    expect(offered).toBe(7);
  }, 120000);

  /** Plays chambers 5-8 with a maxed hero holding `keystones` and hands every tick to `watch`. */
  function watchRun(cls: ClassId, keystones: string[], seed: number, watch: (w: Parameters<NonNullable<Parameters<typeof runBots>[0]['onTick']>>[0], ev: GameEvent[]) => void): ReturnType<typeof runBots> {
    return runBots({
      classes: [cls], seed, startChamber: RUN.CHAMBERS.indexOf('elite') + 1, grant: [keystones], keystoneMode: 'none', loadouts: [maxBuild(cls, maxMetaLevels())],
      boons: ['infuse_ember_primary'], onTick: watch,
    });
  }

  it('Blood Price: the bot spends health only while it has plenty', () => {
    let casts = 0;
    let lowest = 1;
    let before = 1;
    const r = watchRun('mage', ['blood_price'], 31, (w, ev) => {
      const h = w.hero(0)!;
      for (const e of ev) {
        if (e.e !== 'keystoneProc' || e.id !== 'blood_price') continue;
        casts++;
        lowest = Math.min(lowest, before);
      }
      before = h.hp / h.maxHp;
    });
    expect(casts).toBeGreaterThan(10);
    // Never cast from below half health (the snapshot the bot decided on is one tick old).
    expect(lowest).toBeGreaterThan(0.45);
    expect(r.keystoneDamage.blood_price ?? 0).toBeGreaterThan(0);
  }, 60000);

  it('Phase Walker: the bot dashes through enemies to arm the crit', () => {
    let windows = 0;
    let dashes = 0;
    watchRun('knight', ['phase_walker'], 32, (_w, ev) => {
      for (const e of ev) {
        if (e.e === 'buff' && e.id === 'phase_walker') windows++;
        if (e.e === 'cast' && e.ability === 'dash') dashes++;
      }
    });
    expect(windows).toBeGreaterThan(8);
    expect(windows / dashes).toBeGreaterThan(0.4);
  }, 60000);

  it('Arc Stream: the bot holds the button — the mage channels most of the time it has a target in reach, and no bolt flies', () => {
    let channel = 0;
    let fighting = 0;
    let bolts = 0;
    watchRun('mage', ['ks_mage'], 33, (w) => {
      if (w.run.phase !== 'combat') return;
      const h = w.hero(0)!;
      if (h.state !== 'alive') return;
      const near = w.enemies.some((e) => !e.dead && e.spawnTime <= 0 && Math.hypot(e.x - h.body.x, e.z - h.body.z) < 9);
      if (!near) return;
      fighting++;
      if ((w.getSnapshotBody().players[0]!.flags & PF.CHANNELING) !== 0) channel++;
      bolts += w.projectiles.filter((p) => !p.hostile && p.kind === 'arcBolt').length;
    });
    expect(fighting).toBeGreaterThan(300);
    expect(channel / fighting).toBeGreaterThan(0.5);
    expect(bolts).toBe(0);
  }, 60000);

  it('Shockstep and Blazing Wake: the bot dashes into packs, so the keystones deal damage', () => {
    const r = watchRun('barbarian', ['shockstep', 'ember_wake'], 34, () => undefined);
    expect(r.keystoneDamage.shockstep ?? 0).toBeGreaterThan(0);
    expect(r.keystoneDamage.ember_wake ?? 0).toBeGreaterThan(0);
  }, 60000);

  it('Glass Cannon: the bot keeps more distance and takes less damage than it would playing as usual', () => {
    // Same seeds, same keystone; the careful bot knows it holds it, the careless one is not told.
    let careful = 0;
    let careless = 0;
    for (let i = 0; i < 6; i++) {
      const base = { classes: ['mage' as ClassId], seed: 900 + i, startChamber: 4, grant: [['glass_cannon']], keystoneMode: 'none' as const, loadouts: [maxBuild('mage', maxMetaLevels())] };
      careful += runBots(base).damageTaken;
      careless += runBots({ ...base, blind: true }).damageTaken;
    }
    expect(careful).toBeLessThan(careless);
  }, 120000);
});
