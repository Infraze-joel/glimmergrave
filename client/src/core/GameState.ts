/**
 * Single source of truth for everything the client knows. net/ writes it, everyone else reads it.
 * After writing, the writer emits the matching `state:*` / `net:*` event on the bus.
 */
import type { BoonOffer, ClassId, PlayerSnap, RosterEntry, RunState } from '@shared/types.ts';
import type { ConnError } from './EventBus.ts';

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
}

const PROFILE_KEY = 'glimmergrave.profile.v1';

function loadProfile(): Profile {
  const fallback: Profile = { name: '', cls: 'knight', runs: 0, wins: 0, bestChamber: 0, oathUnlocked: 0 };
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    if (raw) return { ...fallback, ...(JSON.parse(raw) as Partial<Profile>) };
  } catch { /* storage unavailable */ }
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

export function saveProfile(patch: Partial<Profile>): void {
  Object.assign(state.profile, patch);
  try { localStorage.setItem(PROFILE_KEY, JSON.stringify(state.profile)); } catch { /* ignore */ }
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
  state.players = [];
  state.bossHp = null;
  state.enemiesAlive = 0;
  state.overlayOpen = false;
}
