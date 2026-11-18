/**
 * The Chronicle: lifetime counters and the feats they unlock. Counters are added up in the player's browser
 * from what the server reports at the end of every run (RunState.stats, rewards, depth, …). Each feat has
 * tiers; reaching a tier lets the player claim its Glimmer once. Nothing here affects the simulation.
 */
export const LIFETIME_STATS = [
  'runs', 'wins', 'kills', 'elites', 'bosses', 'resonances', 'revives', 'ultimates', 'chambers', 'damage',
  'bestDepth', 'bestOath', 'glimmerEarned', 'masteryLevels', 'relicRanks', 'classesWon',
] as const;
/**
 * runs / wins        – finished runs / runs with at least one final boss slain
 * kills … damage     – summed from the own hero's PlayerRunStats (chambers: RunState.chambersCleared)
 * bestDepth          – deepest depth reached + 1 on a won run (1 = first boss slain, 2 = slain at depth 1, …)
 * bestOath           – highest Oath level won + 1
 * masteryLevels      – sum of all class levels above 1
 * relicRanks         – sum of the ranks of all owned relics
 * classesWon         – number of different classes with at least one win
 */
export type LifetimeStat = (typeof LIFETIME_STATS)[number];

export interface FeatDef {
  id: string;
  stat: LifetimeStat;
  /** Counter value needed per tier (ascending). */
  goals: number[];
  /** Glimmer paid when the tier is claimed. */
  rewards: number[];
  /** English reference text; {n} = goal of the tier. Client i18n mirrors by id (`feat.<id>.name` / `.body`). */
  name: string;
  summary: string;
}

export const FEATS: FeatDef[] = [
  { id: 'wanderer', stat: 'runs', goals: [1, 5, 15, 40, 100, 250], rewards: [20, 40, 80, 150, 300, 600], name: 'Wanderer', summary: 'Finish {n} runs.' },
  { id: 'bellringer', stat: 'wins', goals: [1, 3, 10, 25, 60, 150], rewards: [50, 80, 150, 300, 600, 1200], name: 'Bellringer', summary: 'Win {n} runs.' },
  { id: 'gravedigger', stat: 'kills', goals: [100, 500, 2000, 6000, 15000, 40000], rewards: [20, 50, 120, 250, 500, 1000], name: 'Gravedigger', summary: 'Slay {n} enemies.' },
  { id: 'headhunter', stat: 'elites', goals: [5, 25, 80, 200, 500], rewards: [30, 70, 150, 300, 600], name: 'Headhunter', summary: 'Slay {n} elites.' },
  { id: 'kingslayer', stat: 'bosses', goals: [1, 5, 15, 40, 100], rewards: [40, 90, 200, 400, 800], name: 'Kingslayer', summary: 'Land the killing blow on {n} bosses.' },
  { id: 'harmonist', stat: 'resonances', goals: [25, 150, 600, 2000, 6000], rewards: [20, 50, 120, 250, 500], name: 'Harmonist', summary: 'Trigger {n} Resonances.' },
  { id: 'lifeline', stat: 'revives', goals: [3, 15, 50, 150], rewards: [30, 70, 150, 300], name: 'Lifeline', summary: 'Revive allies {n} times.' },
  { id: 'showstopper', stat: 'ultimates', goals: [5, 30, 120, 400, 1200], rewards: [20, 50, 120, 250, 500], name: 'Showstopper', summary: 'Use your ultimate {n} times.' },
  { id: 'delver', stat: 'chambers', goals: [10, 50, 200, 600, 2000], rewards: [20, 50, 120, 250, 500], name: 'Delver', summary: 'Clear {n} chambers.' },
  { id: 'ruin', stat: 'damage', goals: [10000, 100000, 500000, 2000000, 10000000], rewards: [20, 60, 150, 300, 600], name: 'Ruin', summary: 'Deal {n} damage.' },
  { id: 'abyss', stat: 'bestDepth', goals: [2, 3, 4, 6, 8, 11], rewards: [100, 200, 350, 600, 1000, 2000], name: 'Into the Abyss', summary: 'Slay a final boss at depth {n}.' },
  { id: 'oathkeeper', stat: 'bestOath', goals: [2, 3, 4, 6, 9, 13, 21], rewards: [60, 100, 160, 300, 600, 1200, 3000], name: 'Oathkeeper', summary: 'Win a run at Oath level {n} (counted from 1).' },
  { id: 'hoarder', stat: 'glimmerEarned', goals: [500, 2500, 10000, 40000, 150000], rewards: [30, 80, 200, 500, 1200], name: 'Hoarder', summary: 'Earn {n} Glimmer in total.' },
  { id: 'adept', stat: 'masteryLevels', goals: [5, 15, 40, 90, 200], rewards: [40, 100, 250, 500, 1000], name: 'Adept', summary: 'Gain {n} mastery levels across all classes.' },
  { id: 'curator', stat: 'relicRanks', goals: [3, 10, 25, 60, 120], rewards: [40, 100, 250, 500, 1000], name: 'Curator', summary: 'Own relics with {n} ranks in total.' },
  { id: 'polymath', stat: 'classesWon', goals: [2, 4, 7], rewards: [100, 300, 800], name: 'Polymath', summary: 'Win with {n} different classes.' },
];

export const FEAT_BY_ID: ReadonlyMap<string, FeatDef> = new Map(FEATS.map((f) => [f.id, f]));

/** Tiers of a feat reached with the given counter value. */
export function featTier(feat: FeatDef, value: number): number {
  let tier = 0;
  while (tier < feat.goals.length && value >= feat.goals[tier]) tier++;
  return tier;
}

/** Warden rank shown in the menu: one rank per RANK_STEP of total mastery experience across all classes. */
export const WARDEN_RANK = { XP_PER_RANK: 600 } as const;
export const wardenRank = (totalXp: number): number => 1 + Math.floor(Math.max(0, totalXp) / WARDEN_RANK.XP_PER_RANK);
