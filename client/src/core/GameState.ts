/**
 * Single source of truth for everything the client knows. net/ writes it, everyone else reads it.
 * After writing, the writer emits the matching `state:*` / `net:*` event on the bus.
 */
import { META_INDEX, META_UPGRADES, defaultLooks, sanitizeLook } from '@shared/data/meta.ts';
import type { BoonOffer, ClassId, Loadout, Look, PlayerSnap, RosterEntry, RunState } from '@shared/types.ts';
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
  /** Highest oath level the player may host (winning at level n unlocks n + 1, max 3). */
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
}

const PROFILE_KEY = 'glimmergrave.profile.v1';

function loadProfile(): Profile {
  const fallback: Profile = {
    name: '', cls: 'knight', runs: 0, wins: 0, bestChamber: 0, oathUnlocked: 0,
    glimmer: 0, glimmerEarned: 0, meta: {}, looks: defaultLooks(), tutorialDone: false,
  };
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    if (raw) {
      const stored = JSON.parse(raw) as Partial<Profile>;
      const looks = defaultLooks();
      for (const cls of Object.keys(looks) as ClassId[]) looks[cls] = sanitizeLook(stored.looks?.[cls]);
      return { ...fallback, ...stored, looks, meta: { ...(stored.meta ?? {}) } };
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

/** What the client sends to the server for the given class. */
export function loadoutFor(cls: ClassId): Loadout {
  return { look: state.profile.looks[cls], meta: META_UPGRADES.map((def) => metaLevel(def.id)) };
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
