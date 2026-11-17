/**
 * What the player can do next with their permanent progression: open choices (talents, arts), claimable feats
 * and the nearest goals. Shared by the menu badge and the "next" strip of the progression hub.
 */
import { CLASSES } from '@shared/data/classes.ts';
import { FEATS } from '@shared/data/feats.ts';
import { MASTERY } from '@shared/data/mastery.ts';
import { META_UPGRADES, PARAGON } from '@shared/data/meta.ts';
import { RELICS } from '@shared/data/relics.ts';
import { CLASS_IDS, type ClassId } from '@shared/types.ts';
import {
  ascensionUnlocked, classLevel, classProgress, equippedRelics, featState, metaLevel, nextParagonCost, nextUpgradeCost, paragonRank,
  relicRank, relicSlotCount, state, talentsOf,
} from '../core/GameState.ts';
import { metaIcon, metaName } from './armory.ts';
import type { IconName } from './icons.ts';
import { formatInt, roman, t } from './i18n.ts';
import { isMarked } from './prefs.ts';
import type { HubTab } from './store.ts';
import { featName, paragonName, relicName } from './text.ts';

export interface OpenChoice {
  cls: ClassId;
  kind: 'art' | 'talent';
  /** Talent tier (0-based) for `talent`. */
  tier: number;
}

/** Preference mark set once the player has looked at the art choice of a class. */
export const artMark = (cls: ClassId): string => `art.${cls}`;

/** Talent tiers that are unlocked but empty, and arts that were unlocked and never looked at. */
export function openChoices(): OpenChoice[] {
  const out: OpenChoice[] = [];
  for (const cls of CLASS_IDS) {
    const level = classLevel(cls);
    if (level >= MASTERY.ART_LEVEL && CLASSES[cls].arts.length > 0 && !isMarked(artMark(cls))) out.push({ cls, kind: 'art', tier: -1 });
    talentsOf(cls).forEach((option, tier) => {
      if (option === 0 && level >= MASTERY.TALENT_LEVELS[tier]) out.push({ cls, kind: 'talent', tier });
    });
  }
  return out;
}

/** Glimmer waiting in reached, unclaimed feat tiers. */
export function claimableGlimmer(): { tiers: number; glimmer: number } {
  let tiers = 0;
  let glimmer = 0;
  for (const feat of FEATS) {
    const f = featState(feat.id);
    for (let tier = f.claimed; tier < f.tier; tier++) { tiers += 1; glimmer += feat.rewards[tier] ?? 0; }
  }
  return { tiers, glimmer };
}

/** Number shown on the menu badge: claimable feat tiers plus open choices. */
export function pendingCount(): number {
  return claimableGlimmer().tiers + openChoices().length;
}

export interface Goal {
  id: string;
  icon: IconName;
  text: string;
  tab: HubTab;
  /** Something to do right now (true) or something to work towards (false). */
  now: boolean;
  cls?: ClassId;
  relic?: string;
}

interface Purchase {
  name: string;
  cost: number;
  tab: HubTab;
  icon: IconName;
}

function purchases(): Purchase[] {
  const out: Purchase[] = [];
  for (const def of META_UPGRADES) {
    const cost = nextUpgradeCost(def.id);
    if (cost !== null) out.push({ name: `${metaName(def)} ${roman(metaLevel(def.id) + 1)}`, cost, tab: 'armory', icon: metaIcon(def.id) });
  }
  if (ascensionUnlocked()) {
    for (const def of PARAGON) {
      const cost = nextParagonCost(def.id);
      if (cost !== null) out.push({ name: `${paragonName(def)} ${formatInt(paragonRank(def.id) + 1)}`, cost, tab: 'ascension', icon: 'ascension' });
    }
  }
  return out.sort((a, b) => a.cost - b.cost);
}

/** The most useful next steps, things to do now first. */
export function nextGoals(limit: number): Goal[] {
  const goals: Goal[] = [];
  const glimmer = Math.max(0, Math.floor(state.profile.glimmer));

  const claim = claimableGlimmer();
  if (claim.tiers > 0) {
    goals.push({ id: 'claim', icon: 'trophy', tab: 'chronicle', now: true, text: t('hub.goal.claim', { n: claim.tiers, g: formatInt(claim.glimmer) }) });
  }
  const choice = openChoices()[0];
  if (choice) {
    const cls = t(`class.${choice.cls}.name`);
    goals.push({
      id: `choice-${choice.cls}`, icon: choice.kind === 'art' ? 'mastery' : 'talent', tab: 'mastery', now: true, cls: choice.cls,
      text: choice.kind === 'art' ? t('hub.goal.art', { cls }) : t('hub.goal.talent', { cls }),
    });
  }
  const worn = equippedRelics();
  if (worn.length < relicSlotCount()) {
    const spare = RELICS.filter((def) => relicRank(def.id) > 0 && !worn.includes(def.id)).sort((a, b) => relicRank(b.id) - relicRank(a.id))[0];
    if (spare) goals.push({ id: 'relic', icon: 'relic', tab: 'reliquary', now: true, relic: spare.id, text: t('hub.goal.relic', { name: relicName(spare) }) });
  }
  const shop = purchases();
  const affordable = shop.filter((p) => p.cost <= glimmer);
  // The dearest thing in reach is the more interesting offer than the cheapest one.
  const pick = affordable[affordable.length - 1];
  if (pick) goals.push({ id: 'buy', icon: pick.icon, tab: pick.tab, now: true, text: t('hub.goal.buy', { name: pick.name }) });
  const saving = shop.find((p) => p.cost > glimmer);
  if (saving) {
    goals.push({ id: 'save', icon: 'glimmer', tab: saving.tab, now: false, text: t('hub.goal.save', { n: formatInt(saving.cost - glimmer), name: saving.name }) });
  }
  if (!ascensionUnlocked()) goals.push({ id: 'ascension', icon: 'lock', tab: 'ascension', now: false, text: t('hub.goal.unlockAscension') });

  // The feat that is closest to its next tier.
  let best: { ratio: number; text: string } | null = null;
  for (const feat of FEATS) {
    const f = featState(feat.id);
    const goal = feat.goals[f.tier];
    if (goal === undefined || goal <= 0) continue;
    const ratio = f.value / goal;
    if (!best || ratio > best.ratio) best = { ratio, text: t('hub.goal.feat', { name: featName(feat), have: formatInt(f.value), need: formatInt(goal) }) };
  }
  if (best) goals.push({ id: 'feat', icon: 'chronicle', tab: 'chronicle', now: false, text: best.text });

  const cls = state.profile.cls;
  const p = classProgress(cls);
  goals.push({
    id: 'level', icon: 'xp', tab: 'mastery', now: false, cls,
    text: t('hub.goal.level', { cls: t(`class.${cls}.name`), n: p.level + 1, xp: formatInt(Math.max(0, p.need - p.into)) }),
  });
  return goals.slice(0, Math.max(1, limit));
}
