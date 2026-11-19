/** Keystone bookkeeping that has no dependencies inside the simulation: flags, parameters and the empty state. */
import { KEYSTONE_BY_ID } from '../data/keystones.ts';
import type { KeystoneFlags, KeystoneState } from './state.ts';

/** Keystone id -> flag on KeystoneState. */
export const KEYSTONE_FLAG: Readonly<Record<string, keyof KeystoneFlags>> = {
  ember_wake: 'emberWake', shockstep: 'shockstep', phase_walker: 'phaseWalker', ricochet: 'ricochet', chain_lightning: 'chainLightning',
  heavy_hitter: 'heavyHitter', twin_cast: 'twinCast', blood_price: 'bloodPrice', orbit_blades: 'orbitBlades', familiar: 'familiar',
  colossus: 'colossus', corpse_bloom: 'corpseBloom', resonance_engine: 'resonanceEngine', glass_cannon: 'glassCannon', sanguine: 'sanguine',
  momentum_engine: 'momentumEngine', ks_knight: 'knight', ks_barbarian: 'barbarian', ks_mage: 'mage', ks_rogue: 'rogue',
  ks_templar: 'templar', ks_spellblade: 'spellblade', ks_shade: 'shade',
};

/** The named `params` of a keystone as plain numbers (throws at start-up if the data table lacks one). */
export function keystoneParams<K extends string>(id: string, ...keys: K[]): Readonly<Record<K, number>> {
  const def = KEYSTONE_BY_ID.get(id);
  const out = {} as Record<K, number>;
  for (const key of keys) {
    const v = def ? def.params[key] : undefined;
    if (typeof v !== 'number') throw new Error(`keystone ${id}: missing param ${key}`);
    out[key] = v;
  }
  return out;
}

export const KP = {
  wake: keystoneParams('ember_wake', 'seconds', 'damage', 'tick', 'width'),
  shock: keystoneParams('shockstep', 'damage', 'radius', 'knockback', 'charges'),
  phase: keystoneParams('phase_walker', 'seconds', 'haste'),
  ricochet: keystoneParams('ricochet', 'bounces', 'falloff', 'range', 'every'),
  chain: keystoneParams('chain_lightning', 'targets', 'fraction', 'range'),
  heavy: keystoneParams('heavy_hitter', 'damage', 'slow', 'area', 'knockback'),
  twin: keystoneParams('twin_cast', 'delay', 'fraction', 'recharge'),
  price: keystoneParams('blood_price', 'hpFraction', 'minCooldown', 'recharge'),
  blades: keystoneParams('orbit_blades', 'blades', 'radius', 'damageFraction', 'rpm'),
  familiar: keystoneParams('familiar', 'interval', 'damageFraction', 'range'),
  colossus: keystoneParams('colossus', 'size', 'area', 'knockback', 'hp', 'moveSpeed'),
  bloom: keystoneParams('corpse_bloom', 'radius', 'damage'),
  engine: keystoneParams('resonance_engine', 'perResonance', 'burstArea', 'burstDamage'),
  glass: keystoneParams('glass_cannon', 'damage', 'hp'),
  sanguine: keystoneParams('sanguine', 'leech', 'overheal'),
  rush: keystoneParams('momentum_engine', 'perKill', 'max', 'seconds'),
  knight: keystoneParams('ks_knight', 'fraction', 'radius'),
  barbarian: keystoneParams('ks_barbarian', 'pull', 'moveMul', 'duration'),
  mage: keystoneParams('ks_mage', 'tick', 'damageFraction', 'range', 'width', 'slow'),
  rogue: keystoneParams('ks_rogue', 'every', 'knives'),
  templar: keystoneParams('ks_templar', 'duration'),
  spellblade: keystoneParams('ks_spellblade', 'fraction'),
  shade: keystoneParams('ks_shade', 'stealth', 'damage'),
} as const;

export const noKeystoneFlags = (): KeystoneFlags => ({
  emberWake: false, shockstep: false, phaseWalker: false, ricochet: false, chainLightning: false, heavyHitter: false, twinCast: false,
  bloodPrice: false, orbitBlades: false, familiar: false, colossus: false, corpseBloom: false, resonanceEngine: false, glassCannon: false,
  sanguine: false, momentumEngine: false, knight: false, barbarian: false, mage: false, rogue: false, templar: false, spellblade: false,
  shade: false,
});

export const emptyKeystoneState = (): KeystoneState => ({
  ...noKeystoneFlags(), damageMul: 1, area: 1, primaryBase: 0, dashing: false, trail: null,
  phaseTime: 0, phaseCrit: false, phaseTick: -1, phaseDone: false, veilTime: 0, veilX: 0, veilZ: 0, veilHit: false, veilTick: -1, veilAt: -1,
  swings: 0, bolts: 0, chainCd: 0, bladeAt: new Map(), familiarCd: 0, stacks: 0, stackTime: 0, leech: 0, leechTimer: 0, overheal: 0,
  shieldPeak: 0, barrierPeak: 0, channel: 0, priceWait: 0, spinTwin: null, procTick: new Map(), procCount: new Map(),
  fanDef: null, whirlDef: null, groundDef: null, streamDef: null, dealt: {}, casts: 0, extraCasts: 0, secondaryDealt: 0,
});

/** Sets the flags (and the two multipliers) from the list of held keystone ids. */
export function setKeystoneFlags(ks: KeystoneState, held: readonly string[]): void {
  Object.assign(ks, noKeystoneFlags());
  for (const id of held) {
    const flag = KEYSTONE_FLAG[id];
    if (flag) ks[flag] = true;
  }
  ks.damageMul = ks.glassCannon ? 1 + KP.glass.damage : 1;
  ks.area = ks.colossus ? 1 + KP.colossus.area : 1;
}
