/** UI-local view state (not part of the GameState contract). */
import type { ConnError } from '../core/EventBus.ts';

export type ModalKind = 'howto' | 'settings' | 'leave';

export const ui = {
  /** Modal opened from a button (menu / lobby). */
  modal: null as ModalKind | null,
  /** Pause / settings overlay in game (Esc). */
  pause: false,
  /** Leave-confirm step inside the pause overlay. */
  pauseConfirm: false,
  /** Tab is held: scoreboard visible. */
  tab: false,
  joinCode: '',
  /** Fatal error shown as a dialog until dismissed. */
  fatal: null as ConnError | null,
  assetError: null as string | null,
  assetProgress: 0,
  /** Index of the draft card the player clicked (optimistic), or -1. */
  picked: -1,
  /** profile.oathUnlocked as it was while the run was still going (for the "new oath" notice). */
  oathBaseline: null as number | null,
  /** Overridable by the dev harness to preview the "server not configured" state. */
};

/** Purely visual tuning of the UI layer. */
export const UI_CONFIG = {
  TOAST_MS: 4200,
  FEED_MS: 5200,
  FEED_MAX: 4,
  BANNER_MS: 2600,
  COPY_FEEDBACK_MS: 1600,
  LOW_HEALTH_FRACTION: 0.4,
  CRITICAL_HEALTH_FRACTION: 0.2,
  /** Metres within which the "stand close to revive" hint appears. */
  REVIVE_HINT_RADIUS: 9,
  PING_GOOD_MS: 80,
  PING_OK_MS: 160,
  PING_POOR_MS: 280,
  DRAFT_URGENT_SECONDS: 5,
  ACTION_FLASH_MS: 140,
  DENIED_FLASH_MS: 260,
  STAT_PIPS: 5,
  FLAVOUR_ROTATE_MS: 3800,
  FLAVOUR_COUNT: 5,
  MOTE_COUNT: 14,
} as const;
