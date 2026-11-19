/**
 * A hero's build: everything permanent (Armory, Ascension, mastery, talents, relics) plus what the run adds
 * (boons, set bonuses) summed into one `Mods`, and the hero's abilities after class boons.
 */
import { BOON_BY_ID, BOON_TUNING, SETS, setProgress } from '../data/boons.ts';
import { CLASSES, secondaryOf, type AbilityDef, type ClassDef } from '../data/classes.ts';
import { masteryMods, talentOf } from '../data/mastery.ts';
import { PARAGON, paragonEffective } from '../data/meta.ts';
import { addMods, capMods, emptyMods, type Mods } from '../data/mods.ts';
import { RELIC_BY_ID, rankScale } from '../data/relics.ts';
import { sanitizeLoadout } from '../protocol.ts';
import type { ClassId, ElementId } from '../types.ts';
import { boonValue, computeStats } from './boons.ts';
import { KP, setKeystoneFlags } from './ksState.ts';
import { metaMods } from './meta.ts';
import type { BoonStats, Hero, HeroAbilities, HeroBuild, KeystoneFlags, RelicFlags, TalentFlags } from './state.ts';
import { KS } from './tuning.ts';

/** Highest useful mastery for tools and tests: every talent tier and the art are unlocked. */
export const MAX_BUILD_MASTERY = 10;

/**
 * Untrusted loadout -> build. Accepts a full or partial Loadout, or (as before update 3) just the list of
 * upgrade levels. Everything is clamped by the same rules the server applies to the wire message.
 */
export function sanitizeBuild(raw: unknown, cls: ClassId): HeroBuild {
  const l = sanitizeLoadout(Array.isArray(raw) ? { meta: raw } : raw, cls);
  return { meta: l.meta, paragon: l.paragon, mastery: l.mastery, art: l.art, talents: l.talents, relics: l.relics };
}

export const emptyTalents = (): TalentFlags => ({
  riposte: false, rampage: false, arcaneEcho: false, poisonTips: false, martyr: false, spellweave: false, ambush: false,
});

export const emptyRelics = (): RelicFlags => ({
  emberHeart: 0, frostCore: 0, stormCoil: 0, voidLantern: 0, phoenix: 0, bell: 0, hourglass: 0, compass: 0,
});

const TALENT_KEY: Record<string, keyof TalentFlags> = {
  riposte: 'riposte', rampage: 'rampage', arcane_echo: 'arcaneEcho', poison_tips: 'poisonTips', martyr: 'martyr',
  spellweave: 'spellweave', ambush: 'ambush',
};
const RELIC_KEY: Record<string, keyof RelicFlags> = {
  ember_heart: 'emberHeart', frost_core: 'frostCore', storm_coil: 'stormCoil', void_lantern: 'voidLantern',
  phoenix: 'phoenix', bell: 'bell', hourglass: 'hourglass', compass: 'compass',
};

export interface Permanent {
  mods: Mods;
  talent: TalentFlags;
  relic: RelicFlags;
}

/** Armory + Ascension + mastery level + talents + relics of a (sanitised) build. Not capped yet. */
export function permanentOf(cls: ClassId, build: HeroBuild): Permanent {
  const mods = metaMods(build.meta);
  build.paragon.forEach((rank, i) => {
    const def = PARAGON[i];
    if (def && rank > 0) addMods(mods, def.mods, paragonEffective(rank));
  });
  addMods(mods, masteryMods(build.mastery));
  const talent = emptyTalents();
  build.talents.forEach((option, tier) => {
    const def = option > 0 ? talentOf(cls, tier, option) : null;
    if (!def) return;
    addMods(mods, def.mods);
    const key = def.special ? TALENT_KEY[def.special] : undefined;
    if (key) talent[key] = true;
  });
  const relic = emptyRelics();
  for (const r of build.relics) {
    const def = RELIC_BY_ID.get(r.id);
    if (!def) continue;
    const scale = rankScale(r.rank);
    addMods(mods, def.mods, scale);
    const key = def.special ? RELIC_KEY[def.special] : undefined;
    if (key) relic[key] = scale;
  }
  return { mods, talent, relic };
}

const AREA_FIELD: Partial<Record<AbilityDef['shape'], 'range' | 'radius'>> = {
  arc: 'range', circle: 'radius', spin: 'radius', leap: 'radius', zone: 'radius', trap: 'radius',
};

/**
 * One ability after the hero's class boons for `slot`, the `area` mod and the keystones that reshape abilities:
 *  Titan Grip  – primaries: more damage, knockback, wider (arcs: angle and a little reach; projectiles: radius)
 *  Maelstrom   – a spin secondary lasts longer, does not slow the barbarian and drags instead of pushing
 *  Walking Sanctum – a healing zone around the templar lasts longer and follows him (special `follow`)
 */
function tuneAbility(base: AbilityDef, cls: ClassDef, slot: 'primary' | 'secondary' | 'ultimate', h: Pick<Hero, 'boons'>, area: number, ks?: KeystoneFlags): AbilityDef {
  const def: AbilityDef = { ...base };
  for (const stack of h.boons) {
    const boon = BOON_BY_ID.get(stack.id);
    if (!boon || !boon.ability || boon.cls !== cls.id || boon.slot !== slot) continue;
    const v = boonValue(boon, stack.level);
    let field = boon.ability.field;
    // Three class boons name a second effect for the alternative secondary (see their summaries).
    if (boon.id === 'rogue_fan' && def.shape === 'trap') {
      def.damage *= 1 + BOON_TUNING.ROGUE_FAN_TRAP_BONUS * stack.level;
      continue;
    }
    if (boon.id === 'barb_fury' && def.shape === 'leap') field = 'stun';
    if (boon.id === 'shade_reach' && def.shape === 'zone') field = 'radius';
    def[field] = boon.ability.mode === 'mul' ? def[field] * (1 + v) : def[field] + v;
  }
  const areaField = AREA_FIELD[def.shape];
  if (areaField && area > 0) def[areaField] *= 1 + area;
  if (!ks) return def;
  if (slot === 'primary' && ks.heavyHitter) {
    def.damage *= 1 + KP.heavy.damage;
    def.knockback += KP.heavy.knockback;
    if (def.shape === 'arc') {
      def.arc = Math.min(KS.FULL_CIRCLE_DEG, def.arc * (1 + KP.heavy.area));
      def.range *= 1 + KS.HEAVY_REACH;
    } else {
      def.radius *= 1 + KP.heavy.area;
    }
  }
  if (slot === 'secondary' && ks.barbarian && def.shape === 'spin') {
    def.duration *= 1 + KP.barbarian.duration;
    def.lock *= 1 + KP.barbarian.duration;
    def.moveMul = KP.barbarian.moveMul;
    def.knockback = 0;
    def.special = 'maelstrom';
  }
  if (slot === 'secondary' && ks.templar && def.shape === 'zone' && def.heal > 0 && def.range === 0) {
    def.duration *= 1 + KP.templar.duration;
    def.special = 'follow';
  }
  return def;
}

export function buildAbilities(cls: ClassDef, art: number, h: Pick<Hero, 'boons'>, area: number, ks?: KeystoneFlags): HeroAbilities {
  return {
    primary: cls.primary.map((a) => tuneAbility(a, cls, 'primary', h, area, ks)),
    secondary: tuneAbility(secondaryOf(cls, art), cls, 'secondary', h, area, ks),
    ultimate: tuneAbility(cls.ultimate, cls, 'ultimate', h, area, ks),
  };
}

/**
 * The abilities class keystones fall back on, whatever art is equipped: the rogue's knife fan (Fan the Hammer),
 * the barbarian's whirlwind as a stationary zone (Maelstrom after a Skullsplitter), the templar's hallowed ground
 * (Walking Sanctum after a Judgement) and the mage's stream (Arc Stream), all with the hero's class boons.
 */
function keystoneAbilities(h: Hero, area: number): void {
  const ks = h.ks;
  const cls = h.def;
  const standard = ks.rogue || ks.barbarian || ks.templar ? tuneAbility(cls.secondary, cls, 'secondary', h, area, ks) : null;
  ks.fanDef = ks.rogue ? standard : null;
  ks.groundDef = ks.templar ? standard : null;
  ks.whirlDef = ks.barbarian && standard ? { ...standard, id: 'ks_barbarian', shape: 'zone', range: 0, selfShield: 0 } : null;
  const bolt = h.abil.primary[0];
  ks.streamDef = ks.mage && bolt ? {
    ...bolt, shape: 'beam', damage: bolt.damage * KP.mage.damageFraction, range: KP.mage.range,
    radius: (KP.mage.width / 2) * (ks.heavyHitter ? 1 + KP.heavy.area : 1) * ks.area, cooldown: KP.mage.tick, knockback: bolt.knockback * KS.STREAM_KNOCKBACK,
  } : null;
  let sum = 0;
  for (const def of h.abil.primary) sum += def.damage;
  ks.primaryBase = h.abil.primary.length > 0 ? sum / h.abil.primary.length / (ks.heavyHitter ? 1 + KP.heavy.damage : 1) : 0;
}

/** Would this class boon change anything on the abilities the hero has equipped? */
export function classBoonMatters(h: Pick<Hero, 'def' | 'build' | 'boons'>, boonId: string): boolean {
  const boon = BOON_BY_ID.get(boonId);
  if (!boon || !boon.ability || boon.slot === undefined || boon.slot === 'dash') return false;
  const cls = h.def;
  const targets = boon.slot === 'primary' ? cls.primary : boon.slot === 'secondary' ? [secondaryOf(cls, h.build.art)] : [cls.ultimate];
  for (const def of targets) {
    if (boon.id === 'rogue_fan' && def.shape === 'trap') return true;
    let field = boon.ability.field;
    if (boon.id === 'barb_fury' && def.shape === 'leap') field = 'stun';
    if (boon.id === 'shade_reach' && def.shape === 'zone') field = 'radius';
    if (boon.ability.mode === 'add') {
      // More projectiles / pierce only matter on abilities that fire something.
      if ((field === 'count' || field === 'pierce') && def.shape !== 'projectile') continue;
      return true;
    }
    if (def[field] !== 0) return true;
  }
  return false;
}

/**
 * Recomputes everything derived from the hero's boons and permanent build: boon stats, set tiers, the capped
 * Mods total, abilities and maximum health. Returns the set tiers that went up (for the `set` event).
 */
export function refreshHero(h: Hero): { id: string; tier: number }[] {
  const stats: BoonStats = computeStats(h.boons);
  h.stats = stats;
  const mods = addMods(addMods(emptyMods(), h.perm), stats.mods);
  const raised: { id: string; tier: number }[] = [];
  const spread: ElementId[] = [];
  h.setOverflow = false;
  h.setBond = false;
  setProgress(h.boons).forEach((p, i) => {
    for (let tier = 1; tier <= p.tier; tier++) {
      const t = p.set.tiers[tier - 1];
      if (!t) continue;
      addMods(mods, t.mods);
      if (t.special === 'spread' && p.set.element) spread.push(p.set.element);
      else if (t.special === 'overflow') h.setOverflow = true;
      else if (t.special === 'bond') h.setBond = true;
    }
    if (p.tier > (h.setTiers[i] ?? 0)) raised.push({ id: p.set.id, tier: p.tier });
    h.setTiers[i] = p.tier;
  });
  h.setSpread = spread;
  h.mods = capMods(mods);
  // Keystones: Colossus enlarges every area on top of the capped `area` mod; Glass Cannon halves the health pool.
  setKeystoneFlags(h.ks, h.keystones);
  const area = (1 + h.mods.area) * h.ks.area - 1;
  h.abil = buildAbilities(h.def, h.build.art, h, area, h.ks);
  keystoneAbilities(h, area);
  const hp = h.def.maxHp + h.mods.maxHp + stats.bonusHp + (h.ks.colossus ? KP.colossus.hp : 0);
  h.maxHp = h.ks.glassCannon ? Math.max(1, Math.round(hp * KP.glass.hp)) : hp;
  return raised;
}

export const noSetTiers = (): number[] => SETS.map(() => 0);

/** A fully unlocked build for tools and tests: every upgrade, mastery 10, the art and the first talents. */
export function maxBuild(cls: ClassId, metaLevels: readonly number[]): HeroBuild {
  return sanitizeBuild({ meta: [...metaLevels], mastery: MAX_BUILD_MASTERY, art: CLASSES[cls].arts.length > 0 ? 1 : 0, talents: [1, 1, 1] }, cls);
}
