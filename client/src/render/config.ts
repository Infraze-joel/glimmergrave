/** Purely visual tuning for the render kit. Gameplay numbers live in @shared. */
import type { ClassId, DoorType, ElementId, EnemyKind } from '@shared/types.ts';
import type { Quality } from '../core/Settings.ts';

export const MODEL_BASE = '/assets/models/';

export const PALETTE = {
  background: 0x05060b,
  fog: 0x070912,
  ember: 0xff7a2e,
  rime: 0x58d8ff,
  storm: 0xb07bff,
  /** Glimmer = crystallised soul-light: crystals, heals, revives, enemy eyes. */
  glimmer: 0x7dffb4,
  heal: 0x7dffb4,
  hostile: 0xff3b2e,
  hostileHot: 0xffa13d,
  hostileMagic: 0xe0408f,
  physical: 0xfff1d6,
  crit: 0xffd84a,
  arcane: 0x9fd4ff,
  shield: 0x9fd8ff,
  torch: 0xff9a4d,
  white: 0xffffff,
} as const;

export const ELEMENT_COLOR: Record<ElementId, number> = {
  ember: PALETTE.ember,
  rime: PALETTE.rime,
  storm: PALETTE.storm,
};

/** One colour per player slot (ring, cape, name label). Red is reserved for hostile things. */
export const SLOT_COLORS = [0x4ea8ff, 0xffd23f, 0x5fe38a, 0xff86dc] as const;

export const DOOR_COLOR: Record<DoorType, number> = {
  boon: 0xffd166,
  blessing: 0x7dffb4,
  cursed: 0xc43bff,
  boss: 0xff3b2e,
};

export const CAMERA = {
  FOV: 36,
  /** Pitch below the horizon, degrees. */
  PITCH_DEG: 57,
  DISTANCE: 30,
  NEAR: 1,
  FAR: 140,
  /** Exponential follow rate (1/s). */
  FOLLOW_RATE: 9,
  /** How far outside the walls the view centre may show, metres. */
  EDGE_MARGIN: 3.5,
  SNAP_DISTANCE: 5,
  SHAKE_DECAY: 2.6,
  SHAKE_MAX_OFFSET: 0.55,
  SHAKE_FREQ: 31,
} as const;

export interface QualityProfile {
  pixelRatio: number;
  shadows: boolean;
  blobShadows: boolean;
  bloom: boolean;
  /** Multiplier on ambient / cosmetic particle emission. */
  particles: number;
  /** Number of the (always 4) point lights that are actually lit. */
  pointLights: number;
}

export const QUALITY: Record<Quality, QualityProfile> = {
  low: { pixelRatio: 1, shadows: false, blobShadows: false, bloom: false, particles: 0.45, pointLights: 2 },
  medium: { pixelRatio: 1.5, shadows: false, blobShadows: true, bloom: false, particles: 1, pointLights: 4 },
  high: { pixelRatio: 2, shadows: true, blobShadows: false, bloom: true, particles: 1, pointLights: 4 },
};

export const SHADOW = { MAP_SIZE: 2048, BIAS: -0.0006, NORMAL_BIAS: 0.03 } as const;
export const BLOOM = { STRENGTH: 0.32, RADIUS: 0.4, THRESHOLD: 1.45 } as const;

export const WALL = {
  LENGTH: 4,
  HEIGHT: 4,
  THICKNESS: 1,
  /** Height of the cut-away curb on the camera (south) side. */
  CURB_HEIGHT: 0.55,
} as const;

export const HERO_VIS = {
  HEIGHT: 2.25,
  LABEL_Y: 2.75,
  RING_RADIUS: 0.72,
  /** Natural ground speed of Running_A at timeScale 1 (m/s). */
  RUN_SPEED: 5.4,
  FLASH_TIME: 0.16,
} as const;

export const ENEMY_VIS = {
  /** Height of an unscaled skeleton, metres. */
  HEIGHT: 2.0,
  FLASH_TIME: 0.12,
  /** Natural ground speeds of the locomotion clips at timeScale 1 (m/s). */
  RUN_SPEED: 4.2,
  WALK_SPEED: 1.5,
  DEATH_HOLD: 0.75,
  DEATH_SINK: 0.7,
  SINK_DEPTH: 0.5,
  HEALTH_BAR_W: 1.1,
  HEALTH_BAR_H: 0.16,
} as const;

/** Hero outfit: which optional child meshes of the GLB stay visible. */
export const HERO_PARTS: Record<ClassId, string[]> = {
  knight: ['Knight_Helmet', 'Knight_Cape', '1H_Sword', 'Badge_Shield'],
  barbarian: ['Barbarian_Hat', 'Barbarian_Cape', '2H_Axe'],
  mage: ['Mage_Hat', 'Mage_Cape', '2H_Staff', 'Spellbook_open'],
  rogue: ['Rogue_Cape', '2H_Crossbow'],
};

export const ENEMY_MODEL: Record<EnemyKind, string> = {
  minion: 'skel_minion',
  warrior: 'skel_warrior',
  archer: 'skel_rogue',
  mage: 'skel_mage',
  champion: 'skel_warrior',
  regent: 'skel_warrior',
};

export const EYE_COLOR: Record<EnemyKind, number> = {
  minion: 0x9dffb0,
  warrior: 0x9dffb0,
  archer: 0xd8ff7a,
  mage: 0xff5fd0,
  champion: 0xff6a2a,
  regent: 0xff2a4a,
};

export const LIMITS = {
  DECALS: 384,
  FX_BILLBOARDS: 1536,
  UI_BILLBOARDS: 640,
  PARTICLES: 1100,
  DAMAGE_NUMBERS: 48,
  TELEGRAPHS: 48,
  BURSTS: 64,
  PROJECTILES: 128,
  ENEMY_POOL_PER_KIND: 48,
} as const;
