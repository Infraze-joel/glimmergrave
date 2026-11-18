/** Purely visual tuning for the render kit. Gameplay numbers live in @shared. */
import { ENEMIES } from '@shared/data/enemies.ts';
import type { EnemyDef } from '@shared/data/enemies.ts';
import type { AffixId, ClassId, DoorType, ElementId, EnemyKind, Hazard, Look } from '@shared/types.ts';
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
  /** The Hex Matron: violet robes, venom-green witchfire. */
  hexViolet: 0x9a4dff,
  hexGreen: 0x8dff3a,
  /** The Ossuary Stalker: sickly yellow on old bone. */
  sickly: 0xe8d44a,
  bone: 0xe8dcc0,
  /** Friendly guidance (tutorial marker): never used by hazards or telegraphs. */
  guideTeal: 0x3df2d0,
  guideGold: 0xffd166,
  /** Umbra: a deep violet-black body with a pale green rim. The rim is what glows; the core is drawn dark. */
  umbra: 0xc2f59c,
  umbraCore: 0x1a0b30,
  umbraDeep: 0x4a1f8a,
  /** Hallowed things of the templar and the knight's banner. */
  holy: 0xffe9a8,
  holyDeep: 0xf2b441,
  /** Barbarian bloodrage: a hot amber, kept away from the hostile red. */
  rage: 0xff9a1f,
  /** Shade smoke and marks. */
  shadow: 0x4a3f6b,
  mark: 0xd9b8ff,
  /** Endless descent: the abyss below and the bell light above. */
  abyss: 0x8a3dff,
  bell: 0xfff3c4,
} as const;

/** Hazard warnings deliberately avoid the hostile red: one colour per kind, shared by fixture, warning and impact. */
export const HAZARD_COLOR: Record<Hazard['kind'], number> = {
  spikes: 0xdfe9ff,
  vent: 0xff8a1e,
  frost: 0x4fe6ff,
};

export const ELEMENT_COLOR: Record<ElementId, number> = {
  ember: PALETTE.ember,
  rime: PALETTE.rime,
  storm: PALETTE.storm,
  umbra: PALETTE.umbra,
};

/** One colour per player slot (ground ring and name label only). Red is reserved for hostile things. */
export const SLOT_COLORS = [0x4ea8ff, 0xffd23f, 0x5fe38a, 0xff86dc] as const;

export const DOOR_COLOR: Record<DoorType, number> = {
  boon: 0xffd166,
  blessing: 0x7dffb4,
  cursed: 0xc43bff,
  boss: 0xff3b2e,
  descend: PALETTE.abyss,
  ascend: PALETTE.bell,
};

/** Elite affix auras. Vampiric is the only one near red: it is an enemy trait, never a ground warning. */
export const AFFIX_COLOR: Record<AffixId, number> = {
  swift: 0xf4ffb0,
  armored: 0x9fb4d8,
  volatile: 0xffb52e,
  vampiric: 0xd4246e,
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
  /** Strength of the Look colour on cloth swatches (0 = the class's own palette). */
  CLOTH_TINT: 0.94,
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

/**
 * Hero outfit: which optional (rigid) child meshes of the GLB a Look keeps. `gear[style]` follows the per-class
 * meaning of Look.style documented in shared/src/data/meta.ts. `belt` parts are re-hung on the hip instead of a hand.
 * The rogue's hood is a different head mesh (hero_rogue_hooded.glb), so it has no `head` attachment.
 */
export interface HeroOutfit {
  /** Class whose body (GLB, palette texture, cloth swatches) this class wears. */
  body: 'knight' | 'barbarian' | 'mage' | 'rogue';
  /** Cloth colour for Look.color 0 where the class does not keep its body's own palette. */
  baseCloth?: number;
  /** Wash over the whole body [hex, amount 0..1] that sets the class apart from the one whose body it wears. */
  tint?: readonly [number, number];
  /** Build of the class relative to the others (1 = default). */
  scale?: number;
  /** Named sets of extra parts built in assets.ts (props from props.glb and procedural trim), one per gear style. */
  extras?: readonly (readonly string[])[];
  /** Extra part sets that only exist while the look shows the head piece (a crest on the helmet). */
  headExtras?: readonly string[];
  /** Per style: meshes of `gear` that move from the weapon hand to the off hand. */
  offhand?: readonly (readonly string[])[];
  /** Per style: meshes of `gear` that are slung on the back instead of held. */
  back?: readonly (readonly string[])[];
  head: string | null;
  cape: string;
  gear: readonly (readonly string[])[];
  belt: readonly (readonly string[])[];
  /** Hue window (degrees, may wrap) + minimum saturation of the class's cloth swatches in its palette texture. */
  cloth: { hueMin: number; hueMax: number; satMin: number };
}

export const HERO_OUTFIT: Record<ClassId, HeroOutfit> = {
  knight: {
    body: 'knight', head: 'Knight_Helmet', cape: 'Knight_Cape',
    gear: [['1H_Sword', 'Round_Shield'], ['1H_Sword', 'Spike_Shield'], ['1H_Sword', 'Badge_Shield']],
    belt: [[], [], []],
    cloth: { hueMin: 318, hueMax: 9, satMin: 0.5 },
  },
  barbarian: {
    body: 'barbarian', head: 'Barbarian_Hat', cape: 'Barbarian_Cape',
    gear: [['2H_Axe'], ['1H_Axe', 'Barbarian_Round_Shield'], ['1H_Axe', '1H_Axe_Offhand']],
    belt: [[], [], []],
    cloth: { hueMin: 195, hueMax: 232, satMin: 0.22 },
  },
  mage: {
    body: 'mage', head: 'Mage_Hat', cape: 'Mage_Cape',
    gear: [['2H_Staff'], ['1H_Wand', 'Spellbook_open'], ['2H_Staff', 'Spellbook']],
    belt: [[], [], []],
    cloth: { hueMin: 236, hueMax: 292, satMin: 0.25 },
  },
  rogue: {
    body: 'rogue', head: null, cape: 'Rogue_Cape',
    gear: [['2H_Crossbow'], ['1H_Crossbow', 'Knife_Offhand'], ['2H_Crossbow']],
    belt: [[], [], ['Knife']],
    cloth: { hueMin: 136, hueMax: 178, satMin: 0.35 },
  },
  // Update 3. The three new classes wear an existing body with their own weapons, trim and cloth colour.
  templar: {
    body: 'knight', baseCloth: 0xe9e4d4, tint: [0xffd27a, 0.24], scale: 1.08, head: 'Knight_Helmet', cape: 'Knight_Cape',
    gear: [['2H_Sword'], [], ['2H_Sword', 'Rectangle_Shield']],
    belt: [[], [], []],
    back: [[], [], ['Rectangle_Shield']],
    extras: [['templarTrim'], ['templarTrim', 'ornateSword'], ['templarTrim']],
    headExtras: ['templarCrest'],
    cloth: { hueMin: 318, hueMax: 9, satMin: 0.5 },
  },
  spellblade: {
    body: 'mage', baseCloth: 0xd9741f, head: 'Mage_Hat', cape: 'Mage_Cape',
    gear: [['Spellbook_open'], ['Spellbook'], ['1H_Wand']],
    belt: [[], [], []],
    offhand: [[], [], ['1H_Wand']],
    extras: [['spellSword', 'spellTrim'], ['spellSword', 'spellTrim'], ['spellSword', 'spellTrim']],
    cloth: { hueMin: 236, hueMax: 292, satMin: 0.25 },
  },
  shade: {
    body: 'rogue', baseCloth: 0x3a2d5c, tint: [0x4a3d78, 0.42], scale: 0.96, head: null, cape: 'Rogue_Cape',
    gear: [['Knife', 'Knife_Offhand'], ['Knife'], ['Knife', 'Knife_Offhand']],
    belt: [[], ['1H_Crossbow'], []],
    extras: [['shadeTrim'], ['shadeTrim'], ['shadeTrim', 'backQuiver']],
    cloth: { hueMin: 136, hueMax: 178, satMin: 0.35 },
  },
};

/** Cache key of a baked hero: looks that differ only in colour share one geometry (the tint is a uniform). */
export function lookKey(cls: ClassId, look: Look): string {
  return `${cls}:${look.head ? 1 : 0}:${look.cape ? 1 : 0}:${look.style}`;
}

export const ENEMY_MODEL: Record<EnemyKind, string> = {
  minion: 'skel_minion',
  warrior: 'skel_warrior',
  archer: 'skel_rogue',
  mage: 'skel_mage',
  champion: 'skel_warrior',
  regent: 'skel_warrior',
  matron: 'skel_mage',
  stalker: 'skel_rogue',
};

export const EYE_COLOR: Record<EnemyKind, number> = {
  minion: 0x9dffb0,
  warrior: 0x9dffb0,
  archer: 0xd8ff7a,
  mage: 0xff5fd0,
  champion: 0xff6a2a,
  regent: 0xff2a4a,
  matron: 0x9dff3a,
  stalker: 0xffe23a,
};

/** Aura / phase-burst colours of the big enemies (primary, secondary). */
export const BOSS_AURA: Partial<Record<EnemyKind, readonly [number, number]>> = {
  champion: [PALETTE.hostile, PALETTE.ember],
  regent: [PALETTE.storm, PALETTE.hostile],
  matron: [PALETTE.hexViolet, PALETTE.hexGreen],
  stalker: [PALETTE.sickly, 0xff9a2e],
};

export function isBigEnemy(kind: EnemyKind): boolean {
  return BOSS_AURA[kind] !== undefined;
}

/** Used until the balance table carries a row for a kind (the render kit must never crash on a new wire code). */
const FALLBACK_DEFS: Partial<Record<EnemyKind, EnemyDef>> = {
  matron: { kind: 'matron', hp: 2500, speed: 2.8, radius: 1.0, scale: 2.05, damage: 30, attackRange: 12, windup: 1.0, cooldown: 1.6, spawnTime: 2.4, cost: 0, minChamber: 0, poise: 0 },
  stalker: { kind: 'stalker', hp: 2400, speed: 4.4, radius: 0.95, scale: 1.95, damage: 30, attackRange: 14, windup: 0.8, cooldown: 1.4, spawnTime: 2.2, cost: 0, minChamber: 0, poise: 0 },
};

export function enemyDef(kind: EnemyKind): EnemyDef {
  const table: Partial<Record<EnemyKind, EnemyDef>> = ENEMIES;
  return table[kind] ?? FALLBACK_DEFS[kind] ?? ENEMIES.minion;
}

export const LIMITS = {
  DECALS: 512,
  FX_BILLBOARDS: 1536,
  UI_BILLBOARDS: 640,
  PARTICLES: 1100,
  DAMAGE_NUMBERS: 48,
  TELEGRAPHS: 48,
  BURSTS: 64,
  PROJECTILES: 128,
  ENEMY_POOL_PER_KIND: 48,
  FLOATERS: 24,
  HAZARDS: 24,
  HAZARD_SPIKES: 12,
} as const;
