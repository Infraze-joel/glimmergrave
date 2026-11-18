/** UI-local view state (not part of the GameState contract). */
import type { BiomeId, ClassId, ObjectiveKind } from '@shared/types.ts';
import type { ConnError, EventMap } from '../core/EventBus.ts';

export type ModalKind = 'howto' | 'settings' | 'leave';
/** Full-screen pages that open on top of the menu, lobby, summary or pause menu. */
export type PageKind = 'armory' | 'wardrobe' | 'codex';
export type CodexTab = 'elements' | 'classes' | 'combat' | 'objectives' | 'hazards' | 'bestiary' | 'doors' | 'boons' | 'progress';
/** Tabs of the progression hub (the page that grew out of the Armory; PageKind stays 'armory'). */
export const HUB_TABS = ['armory', 'ascension', 'mastery', 'reliquary', 'chronicle'] as const;
export type HubTab = (typeof HUB_TABS)[number];
/** What the last finished run added to the profile (payload of `game:progress`). */
export type RunProgress = EventMap['game:progress'];

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
  /** Armory / wardrobe / codex page, or null. */
  page: null as PageKind | null,
  codexTab: 'elements' as CodexTab,
  /** Class shown in the wardrobe (the lobby locks it to the own class). */
  wardrobeCls: null as ClassId | null,
  hubTab: 'armory' as HubTab,
  /** Class shown on the Mastery tab (null = the profile's class). */
  hubCls: null as ClassId | null,
  /** Relic selected in the Reliquary (null = the first equipped / owned one). */
  hubRelic: null as string | null,
  /** Rewards booked for the run whose summary is showing; null before they arrive and outside a summary. */
  progress: null as RunProgress | null,
  /**
   * Special objectives completed and bonuses earned in the current run, counted from the `objective` events.
   * `tracked` is true only when the run was watched from its first chamber (a hero who joined or reloaded
   * mid-run does not know the earlier chambers, so the summary hides the tally then).
   */
  objectives: { done: 0, bonus: 0, tracked: false },
  /** The last finished objective (for the draft's "objective bonus" mark), or null. */
  lastObjective: null as { kind: ObjectiveKind; bonus: boolean; chamber: number; depth: number } | null,
  /** Biome seen per chamber index in the current run (for the act grouping of the chamber track). */
  biomes: new Map<number, BiomeId>(),
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
  /** Seconds a contextual tip stays before it dismisses itself. */
  TIP_SECONDS: 14,
  TIP_GAP_MS: 900,
  /** Resonances closer together than this build one combo. */
  COMBO_WINDOW_MS: 3500,
  COMBO_SHOW_MS: 2600,
  TUTORIAL_DONE_MS: 1500,
  ACT_BANNER_MS: 3600,
  PURCHASE_FLASH_MS: 700,
  /** Set chips shown on the HUD before the rest collapses into "+n more". */
  SET_CHIPS_MAX: 4,
  /** Several elites with the same affix spawning together make one callout. */
  AFFIX_CALLOUT_GAP_MS: 4000,
  /** Run summary: the experience bar fills over this long (per level gained it wraps once). */
  XP_FILL_MS: 1400,
  XP_FILL_DELAY_MS: 450,
  /** Objective intro ("Hold Out — survive until the bell tolls") and completion banner. */
  OBJECTIVE_BANNER_MS: 2500,
  OBJECTIVE_DONE_MS: 3200,
  /** Objective timers turn urgent below this many seconds. */
  OBJECTIVE_URGENT_SECONDS: 10,
  /** "The shard is under attack" is repeated at most this often. */
  ANCHOR_CALLOUT_GAP_MS: 8000,
  /** Several foes with the same ward spawning together make one callout. */
  WARD_CALLOUT_GAP_MS: 12000,
} as const;
