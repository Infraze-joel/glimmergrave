/** UI-local view state (not part of the GameState contract). */
import type { BiomeId, ClassId, ObjectiveKind } from '@shared/types.ts';
import type { ConnError, EventMap } from '../core/EventBus.ts';

export type ModalKind = 'howto' | 'settings' | 'leave';
/** Full-screen pages that open on top of the menu, lobby, summary or pause menu. */
export type PageKind = 'armory' | 'wardrobe' | 'codex';
export type CodexTab = 'elements' | 'classes' | 'combat' | 'objectives' | 'hazards' | 'bestiary' | 'doors' | 'boons' | 'keystones' | 'progress' | 'tips';
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
  /** Keystone draft with full slots: index of the offered keystone whose replacement is being chosen, or -1. */
  replacing: -1,
  /** What the last answered draft was (wording of the "waiting for ..." panel). */
  pickedKind: 'boon' as 'boon' | 'keystone' | 'skip',
  /** Class filter of the codex Keystones page ('all', 'generic' or a class id). */
  codexKeystones: 'all' as 'all' | 'generic' | ClassId,
  /** Builds the heroes of this room ended their last run with (lobby cards), by slot. */
  lastBuilds: { code: '', bySlot: new Map<number, { hero: string; build: string; keystones: string[] }>() },
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
  /** The last finished objective (for the draft's "objective bonus" mark), or null. */
  lastObjective: null as { kind: ObjectiveKind; bonus: boolean; chamber: number; depth: number } | null,
  /** Biome seen per chamber index in the current run (for the act grouping of the chamber track). */
  biomes: new Map<number, BiomeId>(),
};

/** Purely visual tuning of the UI layer. */
export const UI_CONFIG = {
  TOAST_MS: 4200,
  /** Event feed (ui/feed.ts): lifetime of a line, at most FEED_MAX lines at once. */
  FEED_MS: 5200,
  FEED_MAX: 3,
  /** ... and only this many with the effects setting on "minimal". */
  FEED_MAX_MINIMAL: 2,
  /** From this many lines on the feed counts as crowded: every line then leaves after FEED_BUSY_MS. */
  FEED_BUSY_LINES: 2,
  FEED_BUSY_MS: 3400,
  /** Low-priority lines (an ally's ultimate, boon or set) always leave quickly. */
  FEED_LOW_MS: 2600,
  FEED_FADE_MS: 200,
  BANNER_MS: 2600,
  /** "Keystone acquired": long enough to read the name and what it transforms. */
  KEYSTONE_BANNER_MS: 3800,
  /** Things a hero holds that a keystone card names under "works with", before "+n more". */
  WORKS_WITH_MAX: 3,
  /** The emblem of a fresh keystone glows on the HUD this long. */
  KEYSTONE_NEW_MS: 2400,
  /** Run summary: from this many chambers on the growth chart drops its per-bar labels. */
  GROWTH_LABEL_MAX: 16,
  /** A multiple below this reads as "held steady", not as growth. */
  GROWTH_MIN_MULTIPLE: 1.15,
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
  /** Seconds a contextual tip stays before it dismisses itself: outside a fight, and during one. */
  TIP_SECONDS: 14,
  TIP_COMBAT_SECONDS: 8,
  /** A "new foes" card stays this much longer per foe after the first, up to TIP_FOES_MAX_SECONDS. */
  TIP_FOE_SECONDS: 1.5,
  TIP_FOES_MAX_SECONDS: 12,
  TIP_GAP_MS: 900,
  /** Tips offered within this time of each other are looked at together (new foes of one wave share a card). */
  TIP_COLLECT_MS: 250,
  /** A tip that could not be shown for this long is dropped unseen; its next trigger brings it back. */
  TIP_QUEUE_MAX_MS: 4000,
  /** Resonances of one reaction closer together than this build one combo ("Shatter ×3"). */
  COMBO_WINDOW_MS: 3500,
  COMBO_SHOW_MS: 2600,
  /** The callout of an ally's reaction leaves sooner than the own hero's. */
  COMBO_ALLY_SHOW_MS: 1800,
  /** An own burst keeps the headline of the callout this long against allies' bursts. */
  COMBO_OWN_HOLD_MS: 1200,
  /** Other reactions that are still running are listed under the callout, at most this many. */
  COMBO_OTHERS_MAX: 2,
  COMBO_TIER_2: 3,
  COMBO_TIER_3: 5,
  COMBO_LEAVE_MS: 260,
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
