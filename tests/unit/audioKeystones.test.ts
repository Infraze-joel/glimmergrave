import { describe, expect, it } from 'vitest';
import { KEYSTONES, KEYSTONE_TUNING } from '../../shared/src/data/keystones.ts';
import {
  BLOODRUSH, heldAfter, KEYSTONE_FAMILIES, keystoneFamily, powerLevel, rushPulse, rushStacks, scoreVoices, unmappedKeystones, voicesKey,
} from '../../client/src/audio/keystone-map.ts';
import { KEYSTONE_SFX, KEYSTONE_SIGNATURE_IDS } from '../../client/src/audio/sfx-keystones.ts';

describe('keystone audio map', () => {
  it('has a signature, a family and an anti-spam gap for every keystone in the data table, and nothing else', () => {
    const ids = KEYSTONES.map((k) => k.id).sort();
    expect([...KEYSTONE_SIGNATURE_IDS].sort()).toEqual(ids);
    expect(Object.keys(KEYSTONE_SFX.GAP).sort()).toEqual(ids);
    expect(unmappedKeystones()).toEqual([]);
  });

  it('puts class keystones in the class family and uses all six families', () => {
    for (const k of KEYSTONES) expect(keystoneFamily(k.id) === 'class').toBe(k.cls !== undefined);
    expect(new Set(KEYSTONES.map((k) => keystoneFamily(k.id)))).toEqual(new Set(KEYSTONE_FAMILIES));
    expect(keystoneFamily('ember_wake')).toBe('movement');
    expect(keystoneFamily('heavy_hitter')).toBe('primary');
    expect(keystoneFamily('blood_price')).toBe('secondary');
    expect(keystoneFamily('familiar')).toBe('companion');
    expect(keystoneFamily('corpse_bloom')).toBe('win');
    expect(keystoneFamily('a keystone from the future')).toBe('win');
  });

  it('gives the score one voice per held keystone, in the order taken, and a dense variant for a repeated family', () => {
    expect(scoreVoices([])).toEqual([]);
    expect(scoreVoices(['ember_wake'])).toEqual([{ family: 'movement', dense: false }]);
    expect(scoreVoices(['corpse_bloom', 'ember_wake'])).toEqual([{ family: 'win', dense: false }, { family: 'movement', dense: false }]);
    expect(scoreVoices(['ricochet', 'chain_lightning'])).toEqual([{ family: 'primary', dense: false }, { family: 'primary', dense: true }]);
    expect(scoreVoices(['a', 'b', 'c'])).toHaveLength(KEYSTONE_TUNING.MAX_HELD);
    expect(voicesKey(scoreVoices(['ricochet', 'chain_lightning']))).toBe('primary,primary+');
    expect(voicesKey(scoreVoices(['ricochet']))).not.toBe(voicesKey(scoreVoices(['ricochet', 'familiar'])));
  });

  it('adds weight with the first keystone and sparkle with the second', () => {
    expect(powerLevel([])).toBe(0);
    expect(powerLevel(['ricochet'])).toBe(1);
    expect(powerLevel(['ricochet', 'familiar'])).toBe(2);
  });

  it('follows a keystone event before the roster does: take, take, replace, repeat', () => {
    expect(heldAfter([], 'ricochet')).toEqual(['ricochet']);
    expect(heldAfter(['ricochet'], 'familiar')).toEqual(['ricochet', 'familiar']);
    expect(heldAfter(['ricochet', 'familiar'], 'twin_cast', 'ricochet')).toEqual(['familiar', 'twin_cast']);
    // the roster already had it: the event changes nothing
    expect(heldAfter(['ricochet', 'familiar'], 'familiar')).toEqual(['ricochet', 'familiar']);
    expect(heldAfter(['familiar', 'twin_cast'], 'twin_cast', 'ricochet')).toEqual(['familiar', 'twin_cast']);
  });

  it('raises Bloodrush pitch, tempo and level with every stack and clamps what the sim reports', () => {
    let last = rushPulse(1);
    expect(last.rate).toBe(1);
    for (let n = 2; n <= BLOODRUSH.MAX; n++) {
      const next = rushPulse(n);
      expect(next.bpm).toBeGreaterThan(last.bpm);
      expect(next.rate).toBeGreaterThan(last.rate);
      expect(next.level).toBeGreaterThan(last.level);
      last = next;
    }
    expect(rushPulse(99)).toEqual(rushPulse(BLOODRUSH.MAX));
    expect(rushStacks(undefined)).toBe(1);
    expect(rushStacks(0)).toBe(1);
    expect(rushStacks(3.4)).toBe(3);
    // ten stacks: still a heartbeat, not a drum roll
    expect(rushPulse(BLOODRUSH.MAX).bpm).toBeLessThan(180);
  });
});
