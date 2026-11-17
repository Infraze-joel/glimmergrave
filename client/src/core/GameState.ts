/**
 * Single source of truth for everything the client knows. net/ writes it, everyone else reads it.
 * After writing, the writer emits the matching `state:*` / `net:*` event on the bus.
 */
import { RUN } from '@shared/constants.ts';
import { CLASSES } from '@shared/data/classes.ts';
import { FEATS, FEAT_BY_ID, LIFETIME_STATS, featTier, type LifetimeStat } from '@shared/data/feats.ts';
import { MASTERY, TALENT_TIERS, levelFromXp, sanitizeArt, sanitizeTalents } from '@shared/data/mastery.ts';
import {
  META_INDEX, META_UPGRADES, PARAGON, PARAGON_TUNING, defaultLooks, paragonCost, sanitizeLook,
} from '@shared/data/meta.ts';
import { RELIC_BY_ID, rankFromShards, relicSlots } from '@shared/data/relics.ts';
import { CLASS_IDS, type BoonOffer, type ClassId, type Loadout, type Look, type PlayerSnap, type RosterEntry, type RunState } from '@shared/types.ts';
import { bus, type ConnError } from './EventBus.ts';

export type Screen = 'loading' | 'menu' | 'lobby' | 'game' | 'summary';
export type ConnStatus = 'offline' | 'connecting' | 'online' | 'reconnecting';

export interface Profile {
  name: string;
  cls: ClassId;
  runs: number;
  wins: number;
  /** Deepest chamber reached (1-based), for the menu. */
  bestChamber: number;
  /** Highest oath level the player may host (winning at level n unlocks n + 1, up to RUN.OATH_MAX). */
  oathUnlocked: number;
  /** Unspent Glimmer (earned at the end of every run). */
  glimmer: number;
  /** Total Glimmer ever earned, for the record. */
  glimmerEarned: number;
  /** Permanent upgrade levels by META_UPGRADES id. */
  meta: Record<string, number>;
  /** Chosen appearance per class. */
  looks: Record<ClassId, Look>;
  tutorialDone: boolean;
  // ---- update 3 (all optional in stored profiles; loadProfile fills the defaults)
  /** Total mastery experience per class (level = levelFromXp). */
  xp: Record<ClassId, number>;
  /** Chosen secondary variant per class (0 = standard). */
  arts: Record<ClassId, number>;
  /** Chosen talent option per tier, per class (0 = none). */
  talents: Record<ClassId, number[]>;
  /** Ascension ranks by PARAGON id. */
  paragon: Record<string, number>;
  /** Relic shards owned by relic id (rank = rankFromShards). */
  shards: Record<string, number>;
  /** Equipped relic ids, in slot order. */
  relics: string[];
  /** Lifetime counters for the Chronicle. */
  lifetime: Record<LifetimeStat, number>;
  /** Claimed tiers per feat id. */
  feats: Record<string, number>;
  /** Wins per class. */
  classWins: Record<ClassId, number>;
}

const PROFILE_KEY = 'glimmergrave.profile.v1';

const perClass = <T>(make: (cls: ClassId) => T): Record<ClassId, T> =>
  Object.fromEntries(CLASS_IDS.map((cls) => [cls, make(cls)])) as Record<ClassId, T>;
const noTalents = (): number[] => Array.from({ length: TALENT_TIERS }, () => 0);
const noLifetime = (): Record<LifetimeStat, number> =>
  Object.fromEntries(LIFETIME_STATS.map((key) => [key, 0])) as Record<LifetimeStat, number>;

function loadProfile(): Profile {
  const fallback: Profile = {
    name: '', cls: 'knight', runs: 0, wins: 0, bestChamber: 0, oathUnlocked: 0,
    glimmer: 0, glimmerEarned: 0, meta: {}, looks: defaultLooks(), tutorialDone: false,
    xp: perClass(() => 0), arts: perClass(() => 0), talents: perClass(() => noTalents()), paragon: {}, shards: {},
    relics: [], lifetime: noLifetime(), feats: {}, classWins: perClass(() => 0),
  };
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    if (raw) {
      const stored = JSON.parse(raw) as Partial<Profile>;
      const looks = defaultLooks();
      for (const cls of Object.keys(looks) as ClassId[]) looks[cls] = sanitizeLook(stored.looks?.[cls]);
      const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
      const lifetime = noLifetime();
      for (const key of LIFETIME_STATS) lifetime[key] = num(stored.lifetime?.[key]);
      // Profiles from before update 3 have no counters: seed what the old record knows.
      lifetime.runs = Math.max(lifetime.runs, num(stored.runs));
      lifetime.wins = Math.max(lifetime.wins, num(stored.wins));
      lifetime.glimmerEarned = Math.max(lifetime.glimmerEarned, num(stored.glimmerEarned));
      return {
        ...fallback, ...stored, looks, meta: { ...(stored.meta ?? {}) },
        xp: perClass((cls) => num(stored.xp?.[cls])),
        arts: perClass((cls) => num(stored.arts?.[cls])),
        talents: perClass((cls) => Array.from({ length: TALENT_TIERS }, (_, tier) => num(stored.talents?.[cls]?.[tier]))),
        paragon: { ...(stored.paragon ?? {}) },
        shards: { ...(stored.shards ?? {}) },
        relics: Array.isArray(stored.relics) ? stored.relics.filter((id): id is string => typeof id === 'string' && RELIC_BY_ID.has(id)) : [],
        lifetime,
        feats: { ...(stored.feats ?? {}) },
        classWins: perClass((cls) => num(stored.classWins?.[cls])),
      };
    }
  } catch { /* storage unavailable or corrupt */ }
  return fallback;
}

export const state = {
  screen: 'loading' as Screen,
  conn: {
    status: 'offline' as ConnStatus,
    code: '',
    /** Own slot (0..3) or -1 when not in a session. */
    slot: -1,
    pingMs: 0,
    lastError: null as ConnError | null,
  },
  roster: [] as RosterEntry[],
  oath: 0,
  run: null as RunState | null,
  /** Own pending draft options ([] = nothing to pick). */
  draft: [] as BoonOffer[],
  /** Draft rerolls the own hero has left in this run. */
  draftRerolls: 0,
  /** Latest snapshot rows of all heroes (own hero included), for HUD and party frames. */
  players: [] as PlayerSnap[],
  /** Boss / champion health 0..1, or null when no boss is alive. */
  bossHp: null as number | null,
  enemiesAlive: 0,
  overlayOpen: false,
  profile: loadProfile(),
};

export type GameState = typeof state;

export function self(): PlayerSnap | null {
  return state.players.find((p) => p.slot === state.conn.slot) ?? null;
}

export function selfRoster(): RosterEntry | null {
  return state.roster.find((p) => p.slot === state.conn.slot) ?? null;
}

export function isHost(): boolean {
  return selfRoster()?.host ?? false;
}

/** Persists profile changes and announces them with `state:profile`. */
export function saveProfile(patch: Partial<Profile>): void {
  Object.assign(state.profile, patch);
  try { localStorage.setItem(PROFILE_KEY, JSON.stringify(state.profile)); } catch { /* ignore */ }
  bus.emit('state:profile');
}

export function metaLevel(id: string): number {
  const def = META_UPGRADES[META_INDEX.get(id) ?? -1];
  return def ? Math.max(0, Math.min(def.costs.length, Math.floor(state.profile.meta[id] ?? 0))) : 0;
}

/** Price of the next level of an upgrade, or null when it is maxed (or unknown). */
export function nextUpgradeCost(id: string): number | null {
  const def = META_UPGRADES[META_INDEX.get(id) ?? -1];
  return def ? def.costs[metaLevel(id)] ?? null : null;
}

/** Buys one level if the player can afford it. Returns whether the purchase happened. */
export function purchaseUpgrade(id: string): boolean {
  const cost = nextUpgradeCost(id);
  if (cost === null || state.profile.glimmer < cost) return false;
  saveProfile({ glimmer: state.profile.glimmer - cost, meta: { ...state.profile.meta, [id]: metaLevel(id) + 1 } });
  bus.emit('ui:loadout');
  return true;
}

/** Changes the appearance of one class and tells the session (if any). */
export function setLook(cls: ClassId, patch: Partial<Look>): void {
  const looks = { ...state.profile.looks, [cls]: sanitizeLook({ ...state.profile.looks[cls], ...patch }) };
  saveProfile({ looks });
  bus.emit('ui:loadout');
}

// ---------------------------------------------------------------- mastery, arts, talents

export function classLevel(cls: ClassId): number {
  return levelFromXp(state.profile.xp[cls] ?? 0).level;
}

/** Level, experience inside the level and experience needed for the next one. */
export function classProgress(cls: ClassId): { level: number; into: number; need: number } {
  return levelFromXp(state.profile.xp[cls] ?? 0);
}

export const totalXp = (): number => CLASS_IDS.reduce((sum, cls) => sum + (state.profile.xp[cls] ?? 0), 0);

/** Active secondary variant of a class, clamped to what its mastery has unlocked. */
export function artOf(cls: ClassId): number {
  return sanitizeArt(state.profile.arts[cls], classLevel(cls), CLASSES[cls].arts.length);
}

export function setArt(cls: ClassId, art: number): void {
  saveProfile({ arts: { ...state.profile.arts, [cls]: sanitizeArt(art, classLevel(cls), CLASSES[cls].arts.length) } });
  bus.emit('ui:loadout');
}

/** Talent choices of a class (one per tier), clamped to what its mastery has unlocked. */
export function talentsOf(cls: ClassId): number[] {
  return sanitizeTalents(state.profile.talents[cls], classLevel(cls));
}

/** Chooses an option (1 or 2; 0 clears) for a talent tier if the class has reached its level. */
export function setTalent(cls: ClassId, tier: number, option: number): void {
  if (tier < 0 || tier >= TALENT_TIERS || classLevel(cls) < MASTERY.TALENT_LEVELS[tier]) return;
  const next = talentsOf(cls);
  next[tier] = option === 1 || option === 2 ? option : 0;
  saveProfile({ talents: { ...state.profile.talents, [cls]: next } });
  bus.emit('ui:loadout');
}

// ---------------------------------------------------------------- ascension (endless ranks)

export const ascensionUnlocked = (): boolean => state.profile.wins >= PARAGON_TUNING.UNLOCK_WINS;

export function paragonRank(id: string): number {
  const v = state.profile.paragon[id];
  return PARAGON.some((def) => def.id === id) && typeof v === 'number' && v > 0 ? Math.min(PARAGON_TUNING.MAX_RANK, Math.floor(v)) : 0;
}

export const nextParagonCost = (id: string): number | null => (PARAGON.some((def) => def.id === id) ? paragonCost(paragonRank(id)) : null);

export function purchaseParagon(id: string): boolean {
  const cost = nextParagonCost(id);
  if (!ascensionUnlocked() || cost === null || state.profile.glimmer < cost) return false;
  saveProfile({ glimmer: state.profile.glimmer - cost, paragon: { ...state.profile.paragon, [id]: paragonRank(id) + 1 } });
  bus.emit('ui:loadout');
  return true;
}

// ---------------------------------------------------------------- relics

export const relicRank = (id: string): number => (RELIC_BY_ID.has(id) ? rankFromShards(state.profile.shards[id] ?? 0) : 0);

export const relicSlotCount = (): number => relicSlots(META_UPGRADES.map((def) => metaLevel(def.id)));

/** Equipped relic ids that are owned, without duplicates, cut to the slots the player has. */
export function equippedRelics(): string[] {
  const out: string[] = [];
  for (const id of state.profile.relics) if (relicRank(id) > 0 && !out.includes(id) && out.length < relicSlotCount()) out.push(id);
  return out;
}

/** Equips an owned relic into a free slot. Returns false when there is none (or it is already worn). */
export function equipRelic(id: string): boolean {
  const worn = equippedRelics();
  if (relicRank(id) < 1 || worn.includes(id) || worn.length >= relicSlotCount()) return false;
  saveProfile({ relics: [...worn, id] });
  bus.emit('ui:loadout');
  return true;
}

export function unequipRelic(id: string): void {
  saveProfile({ relics: equippedRelics().filter((worn) => worn !== id) });
  bus.emit('ui:loadout');
}

// ---------------------------------------------------------------- chronicle (lifetime counters and feats)

/** Counter value, tiers reached and tiers already claimed of a feat. */
export function featState(id: string): { value: number; tier: number; claimed: number } {
  const feat = FEAT_BY_ID.get(id);
  if (!feat) return { value: 0, tier: 0, claimed: 0 };
  const value = state.profile.lifetime[feat.stat] ?? 0;
  const tier = featTier(feat, value);
  return { value, tier, claimed: Math.max(0, Math.min(tier, Math.floor(state.profile.feats[id] ?? 0))) };
}

/** Number of feat tiers that are reached but not claimed yet. */
export const featsReady = (): number => FEATS.reduce((sum, feat) => { const f = featState(feat.id); return sum + (f.tier - f.claimed); }, 0);

/** Claims the next reached tier of a feat and pays its Glimmer. Returns the amount (0 = nothing to claim). */
export function claimFeat(id: string): number {
  const feat = FEAT_BY_ID.get(id);
  const { tier, claimed } = featState(id);
  if (!feat || claimed >= tier) return 0;
  const amount = feat.rewards[claimed] ?? 0;
  saveProfile({
    feats: { ...state.profile.feats, [id]: claimed + 1 },
    glimmer: state.profile.glimmer + amount,
    glimmerEarned: state.profile.glimmerEarned + amount,
    lifetime: { ...state.profile.lifetime, glimmerEarned: state.profile.lifetime.glimmerEarned + amount },
  });
  return amount;
}

/** Recomputes the counters that are derived from other parts of the profile. */
function derivedLifetime(lifetime: Record<LifetimeStat, number>): Record<LifetimeStat, number> {
  const p = state.profile;
  return {
    ...lifetime,
    masteryLevels: CLASS_IDS.reduce((sum, cls) => sum + (classLevel(cls) - 1), 0),
    relicRanks: Object.keys(p.shards).reduce((sum, id) => sum + relicRank(id), 0),
    classesWon: CLASS_IDS.filter((cls) => (p.classWins[cls] ?? 0) > 0).length,
  };
}

/**
 * Books a finished run into the profile: record, Oath unlock, counters, and — once the server has announced
 * them — Glimmer, experience and relic shards of the own hero. Call once with `rewardsOnly = false` when the run
 * ends and once with `true` when the rewards arrive (they may come with the same message). Emits `game:progress`.
 */
export function bookRunEnd(run: RunState, cls: ClassId): void {
  const p = state.profile;
  if (run.tutorial) {
    if (run.phase === 'victory') saveProfile({ tutorialDone: true });
    return;
  }
  const won = run.cleared > 0;
  const mine = run.stats.find((row) => row.slot === state.conn.slot);
  const lifetime = { ...p.lifetime };
  lifetime.runs += 1;
  if (won) lifetime.wins += 1;
  lifetime.chambers += run.chambersCleared;
  if (mine) {
    lifetime.kills += mine.kills;
    lifetime.elites += mine.elites;
    lifetime.bosses += mine.bosses;
    lifetime.resonances += mine.resonances;
    lifetime.revives += mine.revives;
    lifetime.ultimates += mine.ultimates;
    lifetime.damage += Math.round(mine.damage);
  }
  if (won) {
    lifetime.bestDepth = Math.max(lifetime.bestDepth, run.cleared);
    lifetime.bestOath = Math.max(lifetime.bestOath, run.oath + 1);
  }
  saveProfile({
    runs: p.runs + 1,
    wins: p.wins + (won ? 1 : 0),
    bestChamber: Math.max(p.bestChamber, run.depth > 0 ? RUN.CHAMBERS.length : run.chamber + 1),
    oathUnlocked: won ? Math.max(p.oathUnlocked, Math.min(RUN.OATH_MAX, run.oath + 1)) : p.oathUnlocked,
    classWins: won ? { ...p.classWins, [cls]: (p.classWins[cls] ?? 0) + 1 } : p.classWins,
    lifetime,
  });
  saveProfile({ lifetime: derivedLifetime(state.profile.lifetime) });
}

/** Books the own hero's rewards of a finished run (see bookRunEnd). */
export function bookRewards(run: RunState, cls: ClassId): void {
  const reward = run.rewards.find((row) => row.slot === state.conn.slot);
  if (!reward) return;
  const p = state.profile;
  const before = classLevel(cls);
  const readyBefore = featsReady();
  const shards = { ...p.shards };
  const relics: { id: string; rank: number; rankUp: boolean }[] = [];
  for (const id of reward.relics) {
    if (!RELIC_BY_ID.has(id)) continue;
    const rankBefore = rankFromShards(shards[id] ?? 0);
    shards[id] = (shards[id] ?? 0) + 1;
    const rank = rankFromShards(shards[id]);
    relics.push({ id, rank, rankUp: rank > rankBefore });
  }
  saveProfile({
    glimmer: p.glimmer + reward.glimmer,
    glimmerEarned: p.glimmerEarned + reward.glimmer,
    xp: { ...p.xp, [cls]: (p.xp[cls] ?? 0) + Math.max(0, Math.floor(reward.xp)) },
    shards,
    lifetime: { ...p.lifetime, glimmerEarned: p.lifetime.glimmerEarned + reward.glimmer },
  });
  // A first relic goes straight into a free slot so new players feel it without visiting the reliquary.
  for (const drop of relics) if (equippedRelics().length < relicSlotCount()) equipRelic(drop.id);
  saveProfile({ lifetime: derivedLifetime(state.profile.lifetime) });
  const level = classLevel(cls);
  bus.emit('game:progress', { cls, xp: reward.xp, levelsGained: level - before, level, relics, featsReady: featsReady() - readyBefore });
  bus.emit('ui:loadout');
}

/** What the client sends to the server for the given class. */
export function loadoutFor(cls: ClassId): Loadout {
  return {
    look: state.profile.looks[cls],
    meta: META_UPGRADES.map((def) => metaLevel(def.id)),
    paragon: PARAGON.map((def) => paragonRank(def.id)),
    mastery: classLevel(cls),
    art: artOf(cls),
    talents: talentsOf(cls),
    relics: equippedRelics().map((id) => ({ id, rank: relicRank(id) })),
  };
}

/** Clears everything tied to a session (called when leaving or after a fatal error). */
export function resetSession(): void {
  state.conn.status = 'offline';
  state.conn.code = '';
  state.conn.slot = -1;
  state.conn.pingMs = 0;
  state.roster = [];
  state.oath = 0;
  state.run = null;
  state.draft = [];
  state.draftRerolls = 0;
  state.players = [];
  state.bossHp = null;
  state.enemiesAlive = 0;
  state.overlayOpen = false;
}
