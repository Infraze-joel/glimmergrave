/**
 * Hero and enemy views: one baked SkinnedMesh + AnimationMixer per entity, driven purely by snapshot rows.
 * All overlay visuals (rings, shadows, bars, icons, labels) are pushed into the shared batches each frame.
 */
import { AnimationMixer, Color, LoopOnce, LoopRepeat } from 'three';
import { Vector3 } from 'three';
import type { AnimationAction, AnimationClip, Object3D, SkinnedMesh } from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { EF, ENEMY_KINDS, PF } from '@shared/types.ts';
import type { AffixId, ClassId, ElementId, EnemyAnim, EnemyKind, EnemySnap, Look, PlayerAnim, PlayerSnap, PlayerState } from '@shared/types.ts';
import { CLASSES, DASH } from '@shared/data/classes.ts';
import type { BuffId } from '@shared/data/classes.ts';
import { ENEMY_TUNING } from '@shared/data/enemies.ts';
import { DEFAULT_LOOK, LOOK } from '@shared/data/meta.ts';
import { NET } from '@shared/constants.ts';
import { BODY_MESH_NAME } from './assets.ts';
import type { Anchor, Assets, CharacterTemplate, ShadowRange } from './assets.ts';
import type { Atlas, IconName } from './atlas.ts';
import { DECAL, SPRITE } from './batches.ts';
import type { BillboardBatch, DecalBatch } from './batches.ts';
import { AFFIX_COLOR, BOSS_AURA, CAMERA, ELEMENT_COLOR, ENEMY_VIS, EYE_COLOR, HERO_OUTFIT, HERO_VIS, LIMITS, OBJECTIVE_COLOR, PALETTE, SLOT_COLORS, enemyDef, isBigEnemy, lookKey } from './config.ts';
import { rgb } from './vfx.ts';
import { createCharacterMaterial } from './materials.ts';
import type { CharacterMaterial } from './materials.ts';

interface ClipDef {
  clip: string;
  loop?: boolean;
  /** Clip time (s) of the visible hit; the clip is time-scaled so it lands when the ability does. */
  impact?: number;
  speed?: number;
  fade?: number;
}

const ANIM = {
  FADE: 0.14,
  FADE_ACTION: 0.07,
  MAX_ACTION_SPEED: 2.3,
  AFTER_IMPACT_SPEED: 1.25,
  /** Skip the part of the spawn clip where the skeleton is still fully underground. */
  SPAWN_START: 1.3,
  GLOW_BOOST: 2.4,
} as const;

const HERO_COMMON: Record<'run' | 'dash' | 'hit' | 'downed' | 'cheer', ClipDef> = {
  run: { clip: 'Running_A', loop: true },
  dash: { clip: 'Dodge_Forward', speed: 0.4 / (DASH.DURATION + 0.08), fade: 0.04 },
  hit: { clip: 'Hit_A', speed: 1.3, fade: 0.05 },
  downed: { clip: 'Death_A', fade: 0.08 },
  cheer: { clip: 'Cheer', loop: true },
};

/**
 * Clip per class and PlayerAnim. `impact` is the clip time of the visible hit: the clip is time-scaled so that frame
 * lands when the ability does (its windup). Leaps (barbarian / templar art) use the overhead chop: the blade is raised
 * while the hero arcs through the air and comes down on landing.
 */
const HERO_ANIMS: Record<ClassId, Record<PlayerAnim, ClipDef>> = {
  knight: {
    ...HERO_COMMON,
    idle: { clip: 'Idle', loop: true },
    primary1: { clip: '1H_Melee_Attack_Slice_Diagonal', impact: 0.38 },
    primary2: { clip: '1H_Melee_Attack_Slice_Horizontal', impact: 0.25 },
    primary3: { clip: '1H_Melee_Attack_Chop', impact: 0.58 },
    secondary: { clip: 'Block_Attack', impact: 0.35 },
    art: { clip: 'Throw', impact: 0.72 },
    ultimate: { clip: 'Spellcast_Raise', impact: 0.42 },
  },
  barbarian: {
    ...HERO_COMMON,
    idle: { clip: '2H_Melee_Idle', loop: true },
    primary1: { clip: '2H_Melee_Attack_Chop', impact: 0.78 },
    primary2: { clip: '2H_Melee_Attack_Slice', impact: 0.38 },
    primary3: { clip: '2H_Melee_Attack_Chop', impact: 0.78 },
    secondary: { clip: '2H_Melee_Attack_Spinning', loop: true, speed: 1.5, fade: 0.08 },
    art: { clip: '2H_Melee_Attack_Chop', impact: 0.78 },
    ultimate: { clip: 'Cheer', speed: 1.7, fade: 0.06 },
  },
  mage: {
    ...HERO_COMMON,
    idle: { clip: 'Idle', loop: true },
    primary1: { clip: 'Spellcast_Shoot', impact: 0.12 },
    primary2: { clip: 'Spellcast_Shoot', impact: 0.12 },
    primary3: { clip: 'Spellcast_Shoot', impact: 0.12 },
    secondary: { clip: 'Spellcast_Raise', impact: 0.42 },
    art: { clip: '2H_Ranged_Shoot', impact: 0.13 },
    ultimate: { clip: 'Spellcast_Long', impact: 1.35 },
  },
  rogue: {
    ...HERO_COMMON,
    idle: { clip: 'Idle', loop: true },
    primary1: { clip: '2H_Ranged_Shoot', impact: 0.13 },
    primary2: { clip: '2H_Ranged_Shoot', impact: 0.13 },
    primary3: { clip: '2H_Ranged_Shoot', impact: 0.13 },
    secondary: { clip: 'Throw', impact: 0.72 },
    art: { clip: 'PickUp', impact: 0.6 },
    ultimate: { clip: '2H_Ranged_Aiming', speed: 1.4, fade: 0.06 },
  },
  templar: {
    ...HERO_COMMON,
    idle: { clip: '2H_Melee_Idle', loop: true },
    primary1: { clip: '2H_Melee_Attack_Slice', impact: 0.38 },
    primary2: { clip: '2H_Melee_Attack_Chop', impact: 0.78 },
    primary3: { clip: '2H_Melee_Attack_Spin', impact: 1.17 },
    secondary: { clip: 'Spellcast_Raise', impact: 0.42 },
    art: { clip: '2H_Melee_Attack_Chop', impact: 0.78 },
    ultimate: { clip: 'Spellcast_Long', impact: 1.35 },
  },
  spellblade: {
    ...HERO_COMMON,
    idle: { clip: 'Idle', loop: true },
    primary1: { clip: '1H_Melee_Attack_Slice_Diagonal', impact: 0.38 },
    primary2: { clip: '1H_Melee_Attack_Slice_Horizontal', impact: 0.25 },
    primary3: { clip: '1H_Melee_Attack_Chop', impact: 0.58 },
    secondary: { clip: '1H_Melee_Attack_Stab', impact: 0.38 },
    art: { clip: 'Spellcasting', loop: true, speed: 1.2, fade: 0.08 },
    ultimate: { clip: 'Spellcast_Raise', impact: 0.42 },
  },
  shade: {
    ...HERO_COMMON,
    idle: { clip: 'Idle', loop: true },
    primary1: { clip: 'Dualwield_Melee_Attack_Stab', impact: 0.38 },
    primary2: { clip: 'Dualwield_Melee_Attack_Slice', impact: 0.55 },
    primary3: { clip: 'Dualwield_Melee_Attack_Chop', impact: 0.55 },
    secondary: { clip: 'Dualwield_Melee_Attack_Slice', impact: 0.55 },
    art: { clip: 'Use_Item', impact: 0.18 },
    ultimate: { clip: 'Throw', impact: 0.72 },
  },
};

interface EnemyAttackDef {
  /** Clip that holds the anticipation (0..impact, stretched over the telegraph) and the strike. */
  clip: string;
  impact: number;
  /** Optional different clip for the strike itself (ranged kinds). */
  strike?: string;
  strikeStart?: number;
}

const ENEMY_ATTACK: Record<EnemyKind, EnemyAttackDef> = {
  minion: { clip: '1H_Melee_Attack_Slice_Horizontal', impact: 0.25 },
  warrior: { clip: '1H_Melee_Attack_Chop', impact: 0.58 },
  archer: { clip: '2H_Ranged_Aiming', impact: 0.45, strike: '2H_Ranged_Shoot', strikeStart: 0.1 },
  mage: { clip: 'Spellcast_Long', impact: 1.35, strike: 'Spellcast_Shoot', strikeStart: 0.05 },
  champion: { clip: '2H_Melee_Attack_Chop', impact: 0.78 },
  regent: { clip: '1H_Melee_Attack_Chop', impact: 0.58 },
  matron: { clip: 'Spellcast_Long', impact: 1.35, strike: 'Spellcast_Shoot', strikeStart: 0.05 },
  stalker: { clip: '2H_Ranged_Aiming', impact: 0.45, strike: '2H_Ranged_Shoot', strikeStart: 0.1 },
  // update 4. The shaman's basic attack is its hex bolt, the aegis bashes with the shield, the bomber's only
  // "attack" is its fuse (handled in startHorde), the necromancer only raises, the reaver cuts with both blades.
  shaman: { clip: 'Spellcast_Long', impact: 1.35, strike: 'Spellcast_Shoot', strikeStart: 0.05 },
  aegis: { clip: 'Block_Attack', impact: 0.35 },
  bomber: { clip: 'Taunt', impact: 0.5 },
  necromancer: { clip: 'Spellcast_Summon', impact: 2.9 },
  reaver: { clip: 'Dualwield_Melee_Attack_Slice', impact: 0.55 },
};

interface SpecialDef {
  clip: string;
  impact: number;
  /** Seconds from the start of the anim to the hit (telegraph duration). */
  windup: (kind: EnemyKind) => number;
  /** Used when the same special is retriggered in a combo (animSeq changes, anim stays). */
  repeat?: number;
  /** Clip played after the hit instead of letting `clip` run out. */
  then?: ClipDef;
}

const boss = (kind: EnemyKind): typeof ENEMY_TUNING.REGENT | typeof ENEMY_TUNING.CHAMPION =>
  (kind === 'champion' ? ENEMY_TUNING.CHAMPION : ENEMY_TUNING.REGENT);

const SPECIALS: Record<'sweep' | 'charge' | 'volley' | 'summon' | 'slam', SpecialDef> = {
  sweep: { clip: '2H_Melee_Attack_Slice', impact: 0.38, windup: (k) => enemyDef(k).windup },
  charge: {
    clip: 'Block', impact: 0.5, windup: (k) => boss(k).CHARGE_WINDUP,
    then: { clip: 'Dodge_Forward', speed: 0.7, fade: 0.05 },
  },
  volley: { clip: 'Spellcast_Long', impact: 1.45, windup: () => ENEMY_TUNING.REGENT.VOLLEY_WINDUP },
  summon: { clip: 'Spellcast_Summon', impact: 2.9, windup: () => 1.3 },
  slam: {
    clip: '1H_Melee_Attack_Jump_Chop', impact: 0.73, windup: () => ENEMY_TUNING.REGENT.SLAM_WINDUP,
    repeat: ENEMY_TUNING.REGENT.SLAM_INTERVAL,
  },
};

interface EnemyLook {
  cloth: number; clothAmount: number; emissive: number; walk: boolean; bar: boolean; glide?: boolean; clothBoost?: number;
  /** Forward lean of the whole body in radians (hunched shaman, crouched reaver, the bomber bent under its keg). */
  lean?: number;
  /** Idle clip other than Idle_Combat, and its speed. */
  idle?: string;
  idleSpeed?: number;
}

const ENEMY_LOOK: Record<EnemyKind, EnemyLook> = {
  minion: { cloth: 0, clothAmount: 0, emissive: 0x000000, walk: false, bar: true },
  warrior: { cloth: 0, clothAmount: 0, emissive: 0x000000, walk: false, bar: true },
  archer: { cloth: 0x3d5a34, clothAmount: 0.0, emissive: 0x000000, walk: false, bar: true },
  mage: { cloth: 0, clothAmount: 0, emissive: 0x000000, walk: false, bar: true },
  champion: { cloth: 0xff5a1f, clothAmount: 0.9, emissive: 0x1c0600, walk: true, bar: false },
  regent: { cloth: 0x7a2cff, clothAmount: 0.95, emissive: 0x12041c, walk: true, bar: false },
  matron: { cloth: 0x6a2fd0, clothAmount: 0.96, emissive: 0x0a0416, walk: true, bar: false, glide: true },
  stalker: { cloth: 0xb9ad45, clothAmount: 0.94, emissive: 0x0c0b02, walk: false, bar: false, clothBoost: 2.4 },
  shaman: { cloth: 0, clothAmount: 0, emissive: 0x020a02, walk: false, bar: true, lean: 0.16 },
  aegis: { cloth: 0x4a5aa8, clothAmount: 0.92, emissive: 0x000000, walk: true, bar: true, idle: 'Blocking', idleSpeed: 0.6 },
  bomber: { cloth: 0xc9a227, clothAmount: 0.92, emissive: 0x060300, walk: false, bar: true },
  necromancer: { cloth: 0, clothAmount: 0, emissive: 0x05020a, walk: false, bar: true, glide: true, idle: 'Spellcasting', idleSpeed: 0.3 },
  reaver: { cloth: 0x2b3040, clothAmount: 0.96, emissive: 0x000000, walk: false, bar: true, lean: 0.26 },
};

/**
 * The five kinds of update 4. Their dangerous actions are announced by `cast` events (ability ids below) at the
 * start of the windup; the clip is chosen from that id, whatever EnemyAnim the simulation shows meanwhile.
 */
const HORDE = {
  MEND: 'mend', RAISE: 'raise', FUSE: 'fuse', LEAP: 'reaver_leap',
  /** Seconds a cast event is remembered until the snapshot row shows the matching animation. */
  CAST_MEMORY: 0.7,
  /** A minion that spawns this long after a `raise` finished, this close to the necromancer, belongs to it. */
  RAISE_GRACE: 0.9, RAISE_REACH: 7,
  RAISES: 4,
  FUSE_SPARKS: 4, FUSE_RATE: 2.2, FUSE_RATE_LIT: 13,
  MEND_MOTES: 5,
  WARD_SHARDS: 3,
  NECRO_HOVER: 0.07,
  TETHER_WIDTH: 0.2,
  HUNT_Y: 1.2, HUNT_SIZE: 1.05,
} as const;

const ACTION_ANIMS: ReadonlySet<EnemyAnim> = new Set<EnemyAnim>(['windup', 'cast', 'summon', 'beam', 'volley', 'charge', 'slam', 'sweep', 'leap']);
const HORDE_KINDS: ReadonlySet<EnemyKind> = new Set<EnemyKind>(['shaman', 'aegis', 'bomber', 'necromancer', 'reaver']);
const _anchor = new Vector3();

/**
 * Timings of the two newer bosses. The balance table may not expose their windups, so each special uses the
 * duration of the telegraph the simulation sends for it (GameEvent.telegraph.src) and falls back to these.
 */
const BOSS2 = {
  TELEGRAPH_MEMORY: 0.6,
  WINDUP: { beam: 1.0, volley: 0.85, summon: 1.3, slam: 0.9, leap: 0.95, charge: 0.8, sweep: 0.8, cast: 0.9, windup: 1.0 } as Partial<Record<EnemyAnim, number>>,
  HOVER: 0.2,
  HOVER_BOB: 0.07,
  /** The simulation glides the Stalker from take-off to landing over the whole leap, so the crouch is only a beat. */
  LEAP_CROUCH: 0.08,
  LEAP_HEIGHT: 2.1,
  ORBS: 3,
} as const;

const STATUS_VIS = {
  BURN_TINT: 0.26, CHILL_TINT: 0.62, SHOCK_TINT: 0.22, WITHER_TINT: 0.7,
  RIM: { burn: 2.2, chill: 1.5, shock: 2.6, wither: 1.0 },
  WISPS: 3,
  FROST: [0.78, 0.95, 1.0],
  FLICKER_HZ: 17,
  FLAMES: 3,
  ARCS: 2,
} as const;

/** Cheap deterministic hash in [0, 1). */
function hash1(n: number): number {
  const s = Math.sin(n * 127.1) * 43758.5453;
  return s - Math.floor(s);
}

const _color = new Color();
const ELITE_RGB = rgb(PALETTE.hostile);
const STATUS_COLORS = {
  burn: new Color(ELEMENT_COLOR.ember), chill: new Color(ELEMENT_COLOR.rime), shock: new Color(ELEMENT_COLOR.storm),
  wither: new Color(ELEMENT_COLOR.umbra), witherBody: new Color(PALETTE.umbraDeep),
};
const ANY_STATUS = EF.BURN | EF.CHILL | EF.SHOCK | EF.WITHER;

/** Elite affix dressing (spawn.affix). */
const AFFIX_VIS = {
  ICON_SIZE: 0.5,
  SWIFT_TRAILS: 3,
  ARMOR_PLATES: 3,
  VAMP_MOTES: 4,
  MARK_RING: 1.9,
} as const;
const SLOT = SLOT_COLORS.map((c) => new Color(c));
const AEGIS_RGB = rgb(PALETTE.aegis);
const SOUL_RGB = rgb(PALETTE.soul);
const GRAVE_RGB = rgb(PALETTE.grave);
const MEND_RGB = rgb(PALETTE.mend);
const FUSE_RGB = rgb(PALETTE.fuse);
const REAVER_RGB = rgb(PALETTE.reaver);
const HUNT_RGB = rgb(OBJECTIVE_COLOR.hunt);
const HOSTILE_RGB = rgb(PALETTE.hostile);
const HOT_RGB = rgb(PALETTE.hostileHot);
const UMBRA_CORE = rgb(PALETTE.umbraCore);
const OVERLOAD_ORDER: readonly ElementId[] = ['ember', 'rime', 'storm', 'umbra'];
const WARD_ICON: Record<ElementId, IconName> = { ember: 'burn', rime: 'chill', storm: 'shock', umbra: 'wither' };

/** Shared machinery of a skinned, animated character instance. */
class Actor {
  readonly root: Object3D;
  readonly body: SkinnedMesh;
  readonly mat: CharacterMaterial;
  readonly mixer: AnimationMixer;
  x = 0;
  z = 0;
  flash = 0;
  flashTime = 0.12;
  /** Extra uniform scale multiplier that springs back to 1 (hit squash, local action nudge). */
  punch = 0;
  baseScale = 1;
  speed = 0;
  /** Height above the floor (hover, leap arc); applied by the owner each frame. */
  lift = 0;
  private moved = 0;
  private readonly clips: Map<string, AnimationClip>;
  private readonly actions = new Map<string, AnimationAction>();
  private current: AnimationAction | null = null;
  private impactAt = -1;
  private afterSpeed = 1;
  private holdAtImpact = false;
  private queued: ClipDef | null = null;
  private queueDelay = 0;

  constructor(template: CharacterTemplate, clips: Map<string, AnimationClip>) {
    this.root = cloneSkinned(template.scene);
    this.body = this.root.getObjectByName(BODY_MESH_NAME) as SkinnedMesh;
    this.mat = createCharacterMaterial(template.map);
    this.body.material = this.mat.material;
    this.body.castShadow = true;
    this.body.frustumCulled = false;
    // Enemies carry a coarse shadow LOD behind their main triangles: draw only that range into the shadow map.
    const geometry = this.body.geometry;
    const range = geometry.userData.shadowRange as ShadowRange | undefined;
    if (range) {
      this.body.onBeforeShadow = () => { geometry.setDrawRange(range.start, range.count); };
      this.body.onAfterShadow = () => { geometry.setDrawRange(0, range.mainCount); };
    }
    this.mixer = new AnimationMixer(this.root);
    this.clips = clips;
  }

  get currentClip(): string {
    return this.current ? this.current.getClip().name : '';
  }

  get clipTime(): number {
    return this.current ? this.current.time : 0;
  }

  play(name: string, loop: boolean, fade: number, speed = 1, startAt = 0, restart = true): AnimationAction | null {
    let action = this.actions.get(name);
    if (!action) {
      const clip = this.clips.get(name);
      if (!clip) return null;
      action = this.mixer.clipAction(clip);
      this.actions.set(name, action);
    }
    this.impactAt = -1;
    this.holdAtImpact = false;
    this.queued = null;
    const prev = this.current;
    if (prev === action && !restart) {
      action.timeScale = speed;
      return action;
    }
    action.reset();
    action.setLoop(loop ? LoopRepeat : LoopOnce, Infinity);
    action.clampWhenFinished = !loop;
    action.timeScale = speed;
    action.time = Math.min(startAt, Math.max(0, action.getClip().duration - 0.001));
    if (prev && prev !== action && fade > 0) action.crossFadeFrom(prev, fade, false);
    else if (prev && prev !== action) prev.stop();
    action.play();
    this.current = action;
    return action;
  }

  /** Plays `def` so that its impact frame is reached exactly `windup` seconds from now. */
  playTimed(def: ClipDef, windup: number, hold: boolean, after: number = ANIM.AFTER_IMPACT_SPEED): void {
    const impact = def.impact ?? 0;
    let speed = windup > 0.001 ? impact / windup : ANIM.MAX_ACTION_SPEED;
    let start = 0;
    if (speed > ANIM.MAX_ACTION_SPEED) {
      speed = ANIM.MAX_ACTION_SPEED;
      start = Math.max(0, impact - windup * speed);
    }
    this.play(def.clip, false, def.fade ?? ANIM.FADE_ACTION, speed, start);
    this.impactAt = impact;
    this.afterSpeed = after;
    this.holdAtImpact = hold;
  }

  /** Continues (or starts) `clip` from its impact frame at `speed`. */
  strike(clip: string, impact: number, speed: number): void {
    if (this.currentClip === clip && this.current) {
      this.impactAt = -1;
      this.holdAtImpact = false;
      if (this.current.time < impact - 0.05) this.current.time = impact - 0.05;
      this.current.timeScale = speed;
      this.current.paused = false;
      return;
    }
    this.play(clip, false, ANIM.FADE_ACTION, speed, Math.max(0, impact - 0.05));
  }

  queue(def: ClipDef, delay: number): void {
    this.queued = def;
    this.queueDelay = delay;
  }

  /** Jumps to the last frame of a one-shot clip (entities that appear mid-state). */
  pose(name: string): void {
    const action = this.play(name, false, 0);
    if (action) action.time = action.getClip().duration;
  }

  place(x: number, z: number, rot: number): void {
    const dx = x - this.x;
    const dz = z - this.z;
    const dist = Math.hypot(dx, dz);
    if (dist < CAMERA.SNAP_DISTANCE) this.moved += dist;
    this.x = x;
    this.z = z;
    this.root.position.x = x;
    this.root.position.z = z;
    this.root.rotation.y = rot;
  }

  update(dt: number): void {
    if (dt > 0) {
      const inst = this.moved / dt;
      this.speed += (inst - this.speed) * Math.min(1, dt * 10);
      this.moved = 0;
    }
    if (this.queued) {
      this.queueDelay -= dt;
      if (this.queueDelay <= 0) {
        const q = this.queued;
        this.queued = null;
        this.play(q.clip, q.loop ?? false, q.fade ?? ANIM.FADE, q.speed ?? 1);
      }
    }
    const cur = this.current;
    if (cur && this.impactAt >= 0 && cur.time >= this.impactAt) {
      if (this.holdAtImpact) cur.timeScale = 0.04;
      else cur.timeScale = this.afterSpeed;
      this.impactAt = -1;
    }
    this.mixer.update(dt);
    if (this.flash > 0) {
      this.flash = Math.max(0, this.flash - dt / this.flashTime);
      this.mat.uniforms.uFlash.value.w = this.flash * this.flash * 0.85;
    }
    if (this.punch !== 0) {
      this.punch *= Math.max(0, 1 - dt * 14);
      if (Math.abs(this.punch) < 0.002) this.punch = 0;
    }
    const s = this.baseScale;
    this.root.scale.set(s * (1 + this.punch * 0.6), s * (1 - this.punch), s * (1 + this.punch * 0.6));
  }

  hitFlash(r: number, g: number, b: number): void {
    this.mat.uniforms.uFlash.value.set(r, g, b, 0.85);
    this.flash = 1;
  }

  reset(): void {
    this.mixer.stopAllAction();
    this.current = null;
    this.queued = null;
    this.impactAt = -1;
    this.flash = 0;
    this.punch = 0;
    this.speed = 0;
    this.moved = 0;
    const u = this.mat.uniforms;
    u.uFlash.value.w = 0;
    u.uTint.value.w = 0;
    u.uFade.value = 1;
    u.uRim.value.w = 0;
    u.uEmissive.value.setRGB(0, 0, 0);
    this.root.position.y = 0;
    this.root.rotation.x = 0;
    this.lift = 0;
    this.body.castShadow = true;
  }

  dispose(): void {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.root);
    this.root.removeFromParent();
    this.mat.material.dispose();
    this.body.skeleton.dispose();
  }
}

// ---------------------------------------------------------------------------------------------- heroes

class HeroView extends Actor {
  slot = 0;
  cls: ClassId;
  anim: PlayerAnim | null = null;
  animSeq = -1;
  state: PlayerState = 'alive';
  gen = 0;
  hp = 1;
  shield = 0;
  revive = 0;
  flags = 0;
  rot = 0;
  ringPulse = 0;
  downTime = 0;
  readonly template: CharacterTemplate;
  look: Look;
  /** Weapon hand, for the infusion glow. */
  readonly hand: Object3D | null;
  /** Ultimate charge 0..1 from the snapshot. */
  ult = 0;
  /** Seconds since the charge became full (drives the "ready" shimmer), -1 while not ready. */
  ultReadyFor = -1;
  /** Leap in flight (barbarian / templar art): the arc is purely visual. */
  leapT = -1;
  leapDur = 0;
  leapHeight = 0;
  leapFromX = 0; leapFromZ = 0; leapToX = 0; leapToZ = 0;
  leapGlide = false;
  /** Visual offset from the snapshot position (the leap's glide), eased out after landing. */
  offX = 0; offZ = 0;
  /** Set for one frame when a leap touches down. */
  landed = false;
  /** Remaining / total seconds of the timed effects on this hero (BUFFS), indexed like BUFF_IDS. */
  readonly buffLeft: number[] = [0, 0, 0];
  readonly buffTotal: number[] = [1, 1, 1];

  constructor(template: CharacterTemplate, clips: Map<string, AnimationClip>, cls: ClassId, look: Look) {
    super(template, clips);
    this.template = template;
    this.cls = cls;
    this.look = look;
    this.hand = this.root.getObjectByName('handslotr') ?? null;
    this.flashTime = HERO_VIS.FLASH_TIME;
    this.baseScale = HERO_OUTFIT[cls].scale ?? 1;
    this.applyColor(look);
  }

  /** Cloth tint is a uniform: changing only the colour never rebakes. Index 0 keeps the class's own palette. */
  /** The body wash of the classes that wear another class's body (also the state a reconnect returns to). */
  applyWash(): void {
    const wash = HERO_OUTFIT[this.cls].tint;
    if (!wash) { this.mat.uniforms.uTint.value.w = 0; return; }
    const w = rgb(wash[0]);
    this.mat.uniforms.uTint.value.set(w[0], w[1], w[2], wash[1]);
  }

  applyColor(look: Look): void {
    this.look = look;
    this.applyWash();
    const index = Math.max(0, Math.min(LOOK.COLORS.length - 1, Math.floor(look.color)));
    // the classes that borrow a body (templar, spellblade, shade) have a cloth colour of their own at index 0
    const base = HERO_OUTFIT[this.cls].baseCloth;
    const c = rgb(index === 0 ? base ?? 0 : LOOK.COLORS[index]);
    this.mat.uniforms.uCloth.value.set(c[0], c[1], c[2], index === 0 && base === undefined ? 0 : HERO_VIS.CLOTH_TINT);
  }
}

export interface RosterInfo { slot: number; cls: ClassId; name: string; look?: Look; art?: number }
export interface Infusions { primary: ElementId | null; secondary: ElementId | null; dash: ElementId | null; ultimate?: ElementId | null }

export const BUFF_IDS: readonly BuffId[] = ['bloodrage', 'bulwark', 'overload'];

const HERO_FX = {
  LEAP_HEIGHT: 2.5,
  LEAP_LEAN: 0.5,
  /** A cast whose target is closer than this to the hero does not move it visually (the snapshots do). */
  LEAP_MIN_GLIDE: 0.6,
  OFFSET_DECAY: 16,
  READY_FLARE: 0.9,
  RAGE_FLAMES: 3,
  OVERLOAD_ORBS: 4,
  OVERLOAD_PERIOD: 0.45,
} as const;

const SWING: Record<ClassId, number> = {
  knight: 0xdce8ff, barbarian: 0xffcf9a, mage: PALETTE.arcane, rogue: 0xe9ffe0,
  templar: PALETTE.holy, spellblade: 0xa8ecff, shade: PALETTE.mark,
};
/** Signature colour of a class's own effects (swing arcs, ultimate shimmer). */
export function classColor(cls: ClassId): number {
  return SWING[cls];
}

function createHero(assets: Assets, cls: ClassId, look: Look): HeroView {
  return new HeroView(assets.heroTemplate(cls, look), assets.heroClips, cls, look);
}

function disposeHero(assets: Assets, view: HeroView): void {
  view.dispose();
  assets.releaseHero(view.template);
}

export class Heroes {
  private readonly parent: Object3D;
  private readonly assets: Assets;
  private readonly atlas: Atlas;
  private readonly views: (HeroView | null)[] = [];
  private readonly roster: (RosterInfo | null)[] = [];
  private readonly infusions: (Infusions | null)[] = [];
  private gen = 0;
  localSlot = -1;

  constructor(parent: Object3D, assets: Assets, atlas: Atlas) {
    this.parent = parent;
    this.assets = assets;
    this.atlas = atlas;
    for (let i = 0; i < NET.MAX_PLAYERS; i++) { this.views.push(null); this.roster.push(null); this.infusions.push(null); }
  }

  setRoster(entries: readonly RosterInfo[]): void {
    for (let i = 0; i < this.roster.length; i++) this.roster[i] = null;
    for (const e of entries) {
      if (e.slot < 0 || e.slot >= this.roster.length) continue;
      const look = e.look ?? DEFAULT_LOOK;
      this.roster[e.slot] = { slot: e.slot, cls: e.cls, name: e.name, look, art: e.art ?? 0 };
      this.atlas.setName(e.slot, e.name);
      const view = this.views[e.slot];
      if (!view) continue;
      // a different class or outfit rebuilds this hero only (next sync); a new colour is just a uniform
      if (view.cls !== e.cls || lookKey(view.cls, view.look) !== lookKey(e.cls, look)) this.remove(e.slot);
      else view.applyColor(look);
    }
  }

  setInfusions(slot: number, infusions: Infusions): void {
    if (slot < 0 || slot >= this.infusions.length) return;
    this.infusions[slot] = { primary: infusions.primary, secondary: infusions.secondary, dash: infusions.dash, ultimate: infusions.ultimate ?? null };
  }

  infusion(slot: number, ability: 'primary' | 'secondary' | 'dash' | 'ultimate'): ElementId | null {
    return this.infusions[slot]?.[ability] ?? null;
  }

  sync(players: readonly PlayerSnap[], localSlot: number): void {
    this.localSlot = localSlot;
    this.gen++;
    for (const p of players) {
      if (p.slot < 0 || p.slot >= this.views.length) continue;
      let view = this.views[p.slot];
      const cls = this.roster[p.slot]?.cls ?? view?.cls ?? 'knight';
      if (!view) {
        view = createHero(this.assets, cls, this.roster[p.slot]?.look ?? DEFAULT_LOOK);
        view.slot = p.slot;
        view.x = p.x; view.z = p.z;
        this.views[p.slot] = view;
        this.parent.add(view.root);
      }
      view.gen = this.gen;
      view.place(p.x, p.z, p.rot);
      view.rot = p.rot;
      view.ult = p.ult ?? 0;
      view.hp = p.maxHp > 0 ? p.hp / p.maxHp : 0;
      view.shield = p.shield;
      view.revive = p.revive;
      view.flags = p.flags;
      if (view.state !== p.state) {
        view.state = p.state;
        view.downTime = 0;
      }
      if (view.anim !== p.anim || view.animSeq !== p.animSeq) {
        const first = view.anim === null;
        const changed = view.anim !== p.anim;
        view.anim = p.anim;
        view.animSeq = p.animSeq;
        this.startAnim(view, p.anim, first, changed);
      }
    }
    for (let i = 0; i < this.views.length; i++) {
      const v = this.views[i];
      if (v && v.gen !== this.gen) this.remove(i);
    }
  }

  private startAnim(view: HeroView, anim: PlayerAnim, first: boolean, changed: boolean): void {
    const def = HERO_ANIMS[view.cls][anim];
    if (anim === 'downed') {
      if (first) view.pose(def.clip);
      else view.play(def.clip, false, def.fade ?? ANIM.FADE);
      return;
    }
    if (def.loop) {
      // looping states never restart on a bare animSeq bump
      view.play(def.clip, true, def.fade ?? ANIM.FADE, def.speed ?? 1, 0, changed && view.currentClip !== def.clip);
      return;
    }
    if (def.impact !== undefined) {
      view.playTimed(def, this.windupOf(view.cls, anim, view.slot), false);
      return;
    }
    view.play(def.clip, false, def.fade ?? ANIM.FADE_ACTION, def.speed ?? 1);
  }

  private windupOf(cls: ClassId, anim: PlayerAnim, slot: number): number {
    const c = CLASSES[cls];
    if (anim === 'ultimate') return c.ultimate.windup;
    if (anim === 'art') return (c.arts[(this.roster[slot]?.art ?? 1) - 1] ?? c.arts[0] ?? c.secondary).windup;
    if (c.secondary.anim === anim) return c.secondary.windup;
    for (const a of c.primary) if (a.anim === anim) return a.windup;
    return c.primary[0].windup;
  }

  get(slot: number): HeroView | null {
    return slot >= 0 && slot < this.views.length ? this.views[slot] : null;
  }

  classOf(slot: number): ClassId {
    return this.views[slot]?.cls ?? this.roster[slot]?.cls ?? 'knight';
  }

  hit(slot: number): void {
    const v = this.get(slot);
    if (!v) return;
    v.hitFlash(1, 0.25, 0.2);
    v.punch = 0.1;
  }

  nudge(slot: number, amount: number): void {
    const v = this.get(slot);
    if (!v) return;
    v.punch = amount;
    v.ringPulse = 1;
  }

  /**
   * Starts the visual arc of a leap that lands at (toX, toZ) in `dur` seconds. The hero is carried there along a
   * parabola whatever the snapshots do meanwhile; afterwards the view eases back onto the snapshot position.
   */
  leap(slot: number, toX: number, toZ: number, dur: number, height: number = HERO_FX.LEAP_HEIGHT): void {
    const v = this.get(slot);
    if (!v) return;
    v.leapT = 0;
    v.leapDur = Math.max(0.1, dur);
    v.leapHeight = height;
    v.leapFromX = v.x + v.offX; v.leapFromZ = v.z + v.offZ;
    v.leapToX = toX; v.leapToZ = toZ;
    v.leapGlide = Math.hypot(toX - v.leapFromX, toZ - v.leapFromZ) > HERO_FX.LEAP_MIN_GLIDE;
  }

  /** `buff` event: a timed effect (BUFFS) started on a hero. */
  buff(slot: number, id: string, dur: number): void {
    const v = this.get(slot);
    const i = BUFF_IDS.indexOf(id as BuffId);
    if (!v || i < 0) return;
    v.buffLeft[i] = dur;
    v.buffTotal[i] = Math.max(0.1, dur);
  }

  buffLeft(slot: number, id: BuffId): number {
    return this.get(slot)?.buffLeft[BUFF_IDS.indexOf(id)] ?? 0;
  }

  /** The leap arc and the glide to its landing point; returns the visual ground position in v.offX / v.offZ. */
  private elevate(v: HeroView, dt: number): void {
    if (v.leapT >= 0) {
      v.leapT += dt;
      const k = v.leapT / v.leapDur;
      if (k < 1 && v.state === 'alive') {
        v.lift = v.leapHeight * 4 * k * (1 - k);
        v.root.rotation.x = HERO_FX.LEAP_LEAN * (k - 0.35);
        if (v.leapGlide) {
          v.offX = v.leapFromX + (v.leapToX - v.leapFromX) * k - v.x;
          v.offZ = v.leapFromZ + (v.leapToZ - v.leapFromZ) * k - v.z;
        }
      } else {
        if (v.leapGlide) { v.offX = v.leapToX - v.x; v.offZ = v.leapToZ - v.z; }
        v.leapT = -1;
        v.lift = 0;
        v.root.rotation.x = 0;
        v.landed = v.state === 'alive';
        v.punch = 0.16;
      }
    } else if (v.offX !== 0 || v.offZ !== 0) {
      const keep = Math.exp(-HERO_FX.OFFSET_DECAY * dt);
      v.offX *= keep; v.offZ *= keep;
      if (Math.abs(v.offX) + Math.abs(v.offZ) < 0.01) { v.offX = 0; v.offZ = 0; }
    }
    v.root.position.set(v.x + v.offX, v.lift, v.z + v.offZ);
  }

  /** Bloodrage, the bulwark dome and the overload afterglow, drawn on whoever carries them. */
  private buffFx(v: HeroView, dt: number, time: number, x: number, z: number, decals: DecalBatch, fx: BillboardBatch): void {
    const u = v.mat.uniforms;
    let er = 0; let eg = 0; let eb = 0;
    let rr = 0; let rg = 0; let rb = 0;
    for (let i = 0; i < BUFF_IDS.length; i++) {
      if (v.buffLeft[i] <= 0) continue;
      v.buffLeft[i] = Math.max(0, v.buffLeft[i] - dt);
      if (v.state !== 'alive') continue;
      // fades in fast, out over the last half second
      const k = Math.min(1, (v.buffTotal[i] - v.buffLeft[i]) * 5, v.buffLeft[i] * 2);
      const id = BUFF_IDS[i];
      if (id === 'bloodrage') {
        const c = rgb(PALETTE.rage);
        const beat = 0.7 + 0.3 * Math.sin(time * 12 + v.slot);
        er += c[0] * 0.3 * k * beat; eg += c[1] * 0.16 * k * beat;
        rr += c[0] * 2.4 * k; rg += c[1] * 2.4 * k; rb += c[2] * 2.4 * k;
        decals.push(DECAL.DISC, x, 0.034, z, 0, 4.2, 4.2, c[0], c[1] * 0.8, c[2], (0.3 + 0.1 * beat) * k, 1, 0.1);
        decals.push(DECAL.CRACKLE, x, 0.046, z, time * 1.7, 2.9, 2.9, c[0] * 1.6, c[1] * 1.6, c[2] * 1.6, 0.8 * k, 1, 0.5, 0.7);
        for (let n = 0; n < HERO_FX.RAGE_FLAMES; n++) {
          const a = time * 1.9 + n * 2.094 + v.slot;
          const flick = 0.8 + 0.4 * hash1(Math.floor(time * 10 + n * 3) + v.slot * 7);
          const h = (0.8 + 0.25 * n) * flick * k;
          fx.push(SPRITE.FLAME, x + Math.sin(a) * 0.55, v.lift + 0.35 + 0.42 * n + h * 0.4, z + Math.cos(a) * 0.55, h * 0.6, h,
            c[0] * 2, c[1] * 2, c[2] * 2, 0.9 * k, 0.85, v.slot + n * 0.37);
        }
        fx.push(SPRITE.GLOW, x, v.lift + 1.1, z, 3.6, 3.6, c[0], c[1], c[2], 0.2 * k * beat, 1, 0);
      } else if (id === 'bulwark') {
        const c = rgb(PALETTE.shield);
        const g = rgb(PALETTE.holy);
        er += c[0] * 0.06 * k; eg += c[1] * 0.06 * k; eb += c[2] * 0.08 * k;
        rr += g[0] * 1.3 * k; rg += g[1] * 1.3 * k; rb += g[2] * 1.3 * k;
        // a dome read from above: a bright rim on the floor, a soft bubble and two shield plates circling
        decals.push(DECAL.PROGRESS, x, 0.048, z, time * 1.2, 3.0, 3.0, g[0] * 1.5, g[1] * 1.5, g[2] * 1.5, 0.9 * k, 0.5, 0.3);
        decals.push(DECAL.PROGRESS, x, 0.048, z, time * 1.2 + Math.PI, 3.0, 3.0, c[0] * 1.5, c[1] * 1.5, c[2] * 1.5, 0.9 * k, 0.5, 0.3);
        fx.push(SPRITE.GLOW, x, v.lift + 1.15, z, 3.5, 3.5, c[0], c[1], c[2], 0.15 * k, 0.8, 0);
        for (let n = 0; n < 2; n++) {
          const a = time * 2.2 + n * Math.PI;
          fx.push(SPRITE.SHARD, x + Math.sin(a) * 1.15, v.lift + 1.2, z + Math.cos(a) * 1.15, 0.5, 0.7, g[0] * 1.6, g[1] * 1.6, g[2] * 1.6, 0.9 * k, 0.6, 1);
        }
      } else {
        // overload: the hero's elements chase each other around the body
        const step = Math.floor(time / HERO_FX.OVERLOAD_PERIOD);
        const el = ELEMENT_COLOR[OVERLOAD_ORDER[step % OVERLOAD_ORDER.length]];
        const c = rgb(el);
        rr += c[0] * 2.2 * k; rg += c[1] * 2.2 * k; rb += c[2] * 2.2 * k;
        er += c[0] * 0.08 * k; eg += c[1] * 0.08 * k; eb += c[2] * 0.08 * k;
        for (let n = 0; n < HERO_FX.OVERLOAD_ORBS; n++) {
          const oc = rgb(ELEMENT_COLOR[OVERLOAD_ORDER[n]]);
          const a = time * 3.4 + n * (Math.PI / 2);
          const ox = x + Math.sin(a) * 0.95;
          const oz = z + Math.cos(a) * 0.95;
          const oy = v.lift + 1.1 + 0.35 * Math.sin(time * 2.6 + n * 1.7);
          fx.push(SPRITE.GLOW, ox, oy, oz, 0.62, 0.62, oc[0] * 1.8, oc[1] * 1.8, oc[2] * 1.8, 0.95 * k, 1, 1.4);
          decals.push(DECAL.DISC, ox, 0.035, oz, 0, 1.1, 1.1, oc[0], oc[1], oc[2], 0.2 * k, 1, 0);
        }
        decals.push(DECAL.RUNE, x, 0.046, z, -time * 1.4, 2.6, 2.6, c[0] * 1.5, c[1] * 1.5, c[2] * 1.5, 0.7 * k, 0.8, 0.3);
      }
    }
    u.uEmissive.value.setRGB(er, eg, eb);
    u.uRim.value.set(rr, rg, rb, rr + rg + rb > 0 ? 1 : 0);
  }

  /** A hero whose ultimate is charged: a quiet turning arc in its class colour and a flare the moment it fills. */
  private readyFx(v: HeroView, dt: number, time: number, x: number, z: number, decals: DecalBatch, fx: BillboardBatch): void {
    if (v.ult < 0.999 || v.state !== 'alive') { v.ultReadyFor = -1; return; }
    v.ultReadyFor = v.ultReadyFor < 0 ? 0 : v.ultReadyFor + dt;
    const c = rgb(SWING[v.cls]);
    const flare = Math.max(0, 1 - v.ultReadyFor / HERO_FX.READY_FLARE);
    const breathe = 0.6 + 0.4 * Math.sin(time * 2.4 + v.slot * 1.3);
    const d = HERO_VIS.RING_RADIUS * 2 + 0.75;
    decals.push(DECAL.PROGRESS, x, 0.047, z, -time * 0.9, d, d, c[0] * 1.5, c[1] * 1.5, c[2] * 1.5, 0.55 * breathe + 0.4 * flare, 0.7, 0.22);
    decals.push(DECAL.PROGRESS, x, 0.047, z, -time * 0.9 + Math.PI, d, d, c[0] * 1.5, c[1] * 1.5, c[2] * 1.5, 0.55 * breathe + 0.4 * flare, 0.7, 0.22);
    fx.push(SPRITE.GLOW, x, v.lift + 1.2, z, 2.2 + flare * 2.5, 2.2 + flare * 2.5, c[0], c[1], c[2], 0.07 * breathe + 0.4 * flare, 1, 0);
    const a = time * 1.6 + v.slot;
    fx.push(SPRITE.SPARK, x + Math.sin(a) * 0.6, v.lift + 0.5 + ((time * 0.7 + v.slot * 0.3) % 1) * 1.8, z + Math.cos(a) * 0.6, 0.16, 0.16,
      c[0] * 2, c[1] * 2, c[2] * 2, 0.8 * breathe, 1, 0, time * 3);
  }

  update(dt: number, time: number, decals: DecalBatch, ui: BillboardBatch, fx: BillboardBatch, blobShadows: boolean): void {
    for (const v of this.views) {
      if (!v) continue;
      const def = v.anim ? HERO_ANIMS[v.cls][v.anim] : null;
      if (v.anim === 'run' && def && v.currentClip === def.clip) {
        v.play(def.clip, true, 0, Math.min(1.7, Math.max(0.55, v.speed / HERO_VIS.RUN_SPEED)), 0, false);
      }
      const u = v.mat.uniforms;
      const invulnerable = (v.flags & PF.INVULNERABLE) !== 0 && v.state === 'alive';
      const connected = (v.flags & PF.CONNECTED) !== 0;
      u.uFade.value = invulnerable ? 0.62 : 1;
      if (!connected) u.uTint.value.set(0.45, 0.5, 0.6, 0.7);
      else v.applyWash();
      v.update(dt);
      v.ringPulse = Math.max(0, v.ringPulse - dt * 5);
      v.downTime += dt;
      this.elevate(v, dt);
      // everything below is anchored where the hero is drawn (a leap carries it away from the snapshot position)
      const hx = v.x + v.offX;
      const hz = v.z + v.offZ;
      this.buffFx(v, dt, time, hx, hz, decals, fx);
      this.readyFx(v, dt, time, hx, hz, decals, fx);

      const c = SLOT[v.slot];
      const local = v.slot === this.localSlot;
      const downed = v.state !== 'alive';
      const air = v.lift > 0.2 ? Math.max(0.5, 1 - v.lift * 0.16) : 1;
      if (blobShadows || v.lift > 0.2) decals.push(DECAL.SHADOW, hx, 0.02, hz, 0, 1.5 * air, 1.5 * air, 0, 0, 0, 0.5 * air);
      if ((v.flags & PF.KINDRED_AURA) !== 0 && !downed) {
        decals.push(DECAL.DISC, hx, 0.03, hz, 0, 3.6, 3.6, c.r, c.g, c.b, 0.16 + 0.05 * Math.sin(time * 3), 1, 0);
      }
      const ring = HERO_VIS.RING_RADIUS * 2 * (1 + v.ringPulse * 0.25);
      const bright = local ? 1.35 : 0.9;
      if (!downed) {
        decals.push(DECAL.RING, hx, 0.045, hz, v.rot, ring, ring, c.r * bright, c.g * bright, c.b * bright, local ? 1 : 0.8, 0, local ? 1 : 0);
        if (v.shield > 0) {
          const sc = PALETTE.shield;
          _color.setHex(sc);
          decals.push(DECAL.PROGRESS, hx, 0.05, hz, time * 1.5, ring + 0.5, ring + 0.5, _color.r, _color.g, _color.b, 0.85, 0.4, 1);
        }
      } else {
        // downed: pulsing glimmer ring that fills while an ally revives
        _color.setHex(PALETTE.glimmer);
        const pulse = 0.7 + 0.3 * Math.sin(time * 5);
        decals.push(DECAL.DISC, hx, 0.035, hz, 0, 3.2, 3.2, c.r, c.g, c.b, 0.2 * pulse, 0.6, 0);
        decals.push(DECAL.PROGRESS, hx, 0.05, hz, 0, 2.5, 2.5, _color.r * 1.4, _color.g * 1.4, _color.b * 1.4, 1, 0.3, v.revive);
        const bob = Math.sin(time * 3.2) * 0.1;
        const uv = this.atlas.icons.down;
        const s = 0.8 + 0.08 * pulse;
        ui.push(SPRITE.ATLAS, hx, 1.7 + bob, hz, s, s, _color.r, _color.g, _color.b, 1, 0, 0, 0, 0, 0, uv[0], uv[1], uv[2], uv[3]);
        if ((v.flags & PF.BEING_REVIVED) !== 0) {
          fx.push(SPRITE.GLOW, hx, 0.9, hz, 3.4, 3.4, _color.r, _color.g, _color.b, 0.25 + 0.2 * v.revive, 1, 0.3);
        }
      }
      // name label + slim health bar
      const labelY = (downed ? 2.35 : HERO_VIS.LABEL_Y) + v.lift;
      const nameUv = this.atlas.names[v.slot];
      const lh = local ? 0.46 : 0.4;
      const la = connected ? 1 : 0.45;
      ui.push(SPRITE.ATLAS, hx, labelY, hz, lh * this.atlas.nameAspect, lh, c.r, c.g, c.b, la, 0, 0, 0, 0, 0.12, nameUv[0], nameUv[1], nameUv[2], nameUv[3]);
      if (!downed) {
        const hpFrac = Math.max(0, Math.min(1, v.hp));
        _color.setRGB(hpFrac < 0.35 ? 1 : 0.42, hpFrac < 0.35 ? 0.3 : 0.92, hpFrac < 0.35 ? 0.25 : 0.5);
        ui.push(SPRITE.BAR, hx, labelY, hz, 1.15, 0.13, _color.r, _color.g, _color.b, la, 0, hpFrac, 0, 0, -0.2);
        // infused weapon: a faint element glow in the weapon hand (primary first, else the secondary's element)
        const inf = this.infusions[v.slot];
        const el = inf ? inf.primary ?? inf.secondary : null;
        if (el && v.hand && v.root.visible) {
          const e = v.hand.matrixWorld.elements;
          const ec = rgb(ELEMENT_COLOR[el]);
          const breathe = 0.75 + 0.25 * Math.sin(time * 5 + v.slot);
          // umbra glows from a dark heart
          if (el === 'umbra') fx.push(SPRITE.GLOW, e[12], e[13] + 0.1, e[14], 0.7, 0.7, UMBRA_CORE[0], UMBRA_CORE[1], UMBRA_CORE[2], 0.85, 0, 0);
          fx.push(SPRITE.GLOW, e[12], e[13] + 0.1, e[14], 1.25, 1.25, ec[0], ec[1], ec[2], 0.34 * breathe, 1, 0.5);
          fx.push(SPRITE.SPARK, e[12], e[13] + 0.1, e[14], 0.24, 0.24, ec[0] * 2, ec[1] * 2, ec[2] * 2, 0.8 * breathe, 1, 0, time * 3);
        }
      }
    }
  }

  private remove(slot: number): void {
    const v = this.views[slot];
    if (!v) return;
    disposeHero(this.assets, v);
    this.views[slot] = null;
  }

  clear(): void {
    for (let i = 0; i < this.views.length; i++) this.remove(i);
    for (let i = 0; i < this.infusions.length; i++) this.infusions[i] = null;
  }

  forEach(fn: (v: HeroView) => void): void {
    for (const v of this.views) if (v) fn(v);
  }
}

// ---------------------------------------------------------------------------------------------- wardrobe preview

const PREVIEW = { SPIN: 0.42, FLOURISH_EVERY: 5.2, FACE: 0.35 } as const;
const FLOURISHES: readonly PlayerAnim[] = ['primary1', 'cheer', 'ultimate', 'primary3'];

/** The single hero shown on the menu / wardrobe diorama: idle, slow turntable, an occasional flourish. */
export class HeroPreview {
  private readonly parent: Object3D;
  private readonly assets: Assets;
  private view: HeroView | null = null;
  private spin: number = PREVIEW.FACE;
  private wait: number = PREVIEW.FLOURISH_EVERY * 0.5;
  private busy = 0;
  private count = 0;
  y = 0;

  constructor(parent: Object3D, assets: Assets) {
    this.parent = parent;
    this.assets = assets;
  }

  get active(): boolean {
    return this.view !== null;
  }

  get cls(): ClassId | null {
    return this.view ? this.view.cls : null;
  }

  /** Returns true when the model had to be rebuilt (class or outfit changed); a colour change is free. */
  set(cls: ClassId, look: Look): boolean {
    const old = this.view;
    if (old && old.cls === cls && lookKey(cls, old.look) === lookKey(cls, look)) {
      old.applyColor(look);
      return false;
    }
    const classChanged = !old || old.cls !== cls;
    const idleAt = old && !classChanged && this.busy <= 0 ? old.clipTime : 0;
    if (old) disposeHero(this.assets, old);
    const view = createHero(this.assets, cls, look);
    view.play(HERO_ANIMS[cls].idle.clip, true, 0, 1, idleAt);
    this.busy = 0;
    if (classChanged) { this.spin = PREVIEW.FACE; this.wait = PREVIEW.FLOURISH_EVERY * 0.35; view.punch = -0.12; }
    this.view = view;
    this.parent.add(view.root);
    return true;
  }

  update(dt: number): void {
    const v = this.view;
    if (!v) return;
    this.spin += PREVIEW.SPIN * dt;
    v.root.position.set(0, this.y, 0);
    v.root.rotation.y = this.spin;
    if (this.busy > 0) {
      this.busy -= dt;
      if (this.busy <= 0) v.play(HERO_ANIMS[v.cls].idle.clip, true, 0.25);
    } else {
      this.wait -= dt;
      if (this.wait <= 0) {
        this.wait = PREVIEW.FLOURISH_EVERY;
        const pick = this.count++ % FLOURISHES.length;
        const def = HERO_ANIMS[v.cls][FLOURISHES[pick]];
        const action = v.play(def.clip, false, 0.15, 1);
        this.busy = action ? Math.min(1.6, action.getClip().duration) - 0.2 : 0;
      }
    }
    v.update(dt);
  }

  clear(): void {
    if (this.view) disposeHero(this.assets, this.view);
    this.view = null;
    this.busy = 0;
  }
}

// ---------------------------------------------------------------------------------------------- enemies

class EnemyView extends Actor {
  id = -1;
  kind: EnemyKind;
  anim: EnemyAnim | null = null;
  animSeq = -1;
  lastSpecial: EnemyAnim | null = null;
  lastSpecialTime = -10;
  gen = 0;
  hp = 1;
  flags = 0;
  elite = false;
  dying = false;
  deathTime = 0;
  deathHold: number = ENEMY_VIS.DEATH_HOLD;
  age = 0;
  seed = Math.random();
  height: number = ENEMY_VIS.HEIGHT;
  radius = 0.5;
  /** Last telegraph the simulation attributed to this enemy (GameEvent.telegraph.src). */
  teleAt = -10;
  teleDur = 0;
  /** Timeline of the running special (beam channel, leap arc). */
  specialAt = -10;
  specialDur = 0;
  airborne = false;
  /** Set for one frame when a leap touches down (the world adds dust). */
  landed = false;
  readonly hand: Object3D | null;
  readonly handL: Object3D | null;
  /** Elite trait from the spawn event; armoured elites lose the plating when their guard breaks. */
  affix: AffixId | null = null;
  guardBroken = false;
  /** Death Mark (shade ultimate): seconds left / total. */
  markLeft = 0;
  markTotal = 1;
  /** Leap in flight (Stalker, reaver): the arc is drawn by the view, the simulation moves it on the floor. */
  leaping = false;
  /** Element this enemy is warded against (spawn.ward). */
  ward: ElementId | null = null;
  /** Last `cast` event of this enemy and when it arrived; `channel` is the action it is winding up right now. */
  castAbility = '';
  castAt = -10;
  channel = '';
  channelAt = -10;
  channelDur = 0;
  /** The snapshot row has shown the action that belongs to `channel` (so leaving it early means: interrupted). */
  channelSeen = false;
  /** Aegis: ward dome raised (`dome` event), its radius and its eased visibility 0..1. */
  domeOn = false;
  domeR = 0;
  domeK = 0;
  /** Inside a raised dome of another enemy this frame. */
  guarded = false;
  /** Necromancer id that raised this minion, or -1. */
  master = -1;
  /** Hunt target of the chamber's objective. */
  hunted = false;
  fusePhase = 0;
  /** Bomber: when its lit fuse runs out (-10 = not lit, or put out by a stun). */
  fuseEnd = -10;
  /** Set for one frame when a wound-up attack was cut short (stun, stagger): its telegraph can go. */
  interrupted = false;
  private readonly anchorBones = new Map<string, Object3D | null>();
  private readonly anchors: Record<string, Anchor>;

  constructor(template: CharacterTemplate, clips: Map<string, AnimationClip>, kind: EnemyKind) {
    super(template, clips);
    this.kind = kind;
    this.flashTime = ENEMY_VIS.FLASH_TIME;
    this.hand = this.root.getObjectByName('handslotr') ?? null;
    this.handL = this.root.getObjectByName('handslotl') ?? null;
    this.anchors = template.anchors;
    for (const name of Object.keys(template.anchors)) this.anchorBones.set(name, this.root.getObjectByName(template.anchors[name].bone) ?? null);
  }

  /** World position of a named point on the rig (fuse tip, totem head); false when the kind has none. */
  anchor(name: string, out: Vector3): boolean {
    const bone = this.anchorBones.get(name);
    if (!bone) return false;
    const a = this.anchors[name];
    out.set(a.x, a.y, a.z).applyMatrix4(bone.matrixWorld);
    return true;
  }

  /** Seconds the current channel still runs (0 = none). */
  channelLeft(time: number): number {
    return this.channel ? Math.max(0, this.channelAt + this.channelDur - time) : 0;
  }
}

interface Raise { id: number; until: number; left: number }

/** Bosses other than the first are created on demand (one of three appears per run). */
const PREWARM: Record<EnemyKind, number> = {
  minion: 10, warrior: 5, archer: 5, mage: 3, champion: 1, regent: 0, matron: 0, stalker: 0,
  shaman: 1, aegis: 1, bomber: 3, necromancer: 1, reaver: 2,
};
const KILL_MEMORY = 1.5;

export class Enemies {
  private readonly parent: Object3D;
  private readonly assets: Assets;
  private readonly atlas: Atlas;
  private readonly byId = new Map<number, EnemyView>();
  private readonly active: EnemyView[] = [];
  private readonly dying: EnemyView[] = [];
  private readonly pool = Object.fromEntries(ENEMY_KINDS.map((kind) => [kind, [] as EnemyView[]])) as Record<EnemyKind, EnemyView[]>;
  private readonly killed = new Map<number, number>();
  /** Affixes announced by `spawn` before the first snapshot row of that enemy arrived. */
  private readonly affixes = new Map<number, AffixId>();
  /** Wards and necromancer links announced before the first snapshot row of that enemy arrived. */
  private readonly wards = new Map<number, ElementId>();
  private readonly masters = new Map<number, number>();
  private readonly raises: Raise[] = [];
  private readonly hunt: number[] = [];
  private huntCount = 0;
  private huntEnraged = false;
  private readonly domes = new Float32Array(LIMITS.DOMES * 3);
  private domeCount = 0;
  private gen = 0;
  private time = 0;
  private readonly expire = (until: number, id: number): void => {
    if (until < this.time) this.killed.delete(id);
  };

  constructor(parent: Object3D, assets: Assets, atlas: Atlas) {
    this.parent = parent;
    this.assets = assets;
    this.atlas = atlas;
    for (let i = 0; i < HORDE.RAISES; i++) this.raises.push({ id: -1, until: -1, left: 0 });
    for (let i = 0; i < LIMITS.HUNT_TARGETS; i++) this.hunt.push(-1);
  }

  /** Creates pooled views ahead of the first wave so spawning does not hitch. */
  prewarm(): void {
    for (const kind of Object.keys(PREWARM) as EnemyKind[]) {
      while (this.pool[kind].length < PREWARM[kind]) this.pool[kind].push(this.create(kind));
    }
  }

  private create(kind: EnemyKind): EnemyView {
    const view = new EnemyView(this.assets.enemies[kind], this.assets.skelClips, kind);
    const look = ENEMY_LOOK[kind];
    view.mat.uniforms.uCloth.value.set(0, 0, 0, look.clothAmount);
    _color.setHex(look.cloth).multiplyScalar(look.clothBoost ?? 1);
    view.mat.uniforms.uCloth.value.x = _color.r;
    view.mat.uniforms.uCloth.value.y = _color.g;
    view.mat.uniforms.uCloth.value.z = _color.b;
    return view;
  }

  private acquire(snap: EnemySnap): EnemyView {
    const view = this.pool[snap.kind].pop() ?? this.create(snap.kind);
    view.reset();
    view.id = snap.id;
    view.anim = null;
    view.animSeq = -1;
    view.lastSpecial = null;
    view.dying = false;
    view.deathTime = 0;
    view.age = 0;
    view.teleAt = -10;
    view.specialAt = -10;
    view.airborne = false;
    view.landed = false;
    view.affix = this.affixes.get(snap.id) ?? null;
    view.guardBroken = false;
    view.markLeft = 0;
    view.leaping = false;
    view.ward = this.wards.get(snap.id) ?? null;
    view.master = this.masters.get(snap.id) ?? -1;
    view.castAbility = '';
    view.castAt = -10;
    view.channel = '';
    view.channelSeen = false;
    view.domeOn = false;
    view.domeK = 0;
    view.guarded = false;
    view.hunted = false;
    view.interrupted = false;
    view.fusePhase = 0;
    view.fuseEnd = -10;
    view.x = snap.x;
    view.z = snap.z;
    view.seed = (snap.id * 0.61803398875) % 1;
    this.parent.add(view.root);
    this.active.push(view);
    this.byId.set(snap.id, view);
    return view;
  }

  private release(view: EnemyView): void {
    this.affixes.delete(view.id);
    this.wards.delete(view.id);
    this.masters.delete(view.id);
    view.root.removeFromParent();
    view.reset();
    view.id = -1;
    this.pool[view.kind].push(view);
  }

  sync(enemies: readonly EnemySnap[]): void {
    this.gen++;
    for (const e of enemies) {
      if (this.killed.has(e.id)) continue;
      let view = this.byId.get(e.id);
      if (view && view.kind !== e.kind) {
        this.detach(view);
        this.release(view);
        view = undefined;
      }
      if (!view) view = this.acquire(e);
      view.gen = this.gen;
      const elite = (e.flags & EF.ELITE) !== 0;
      const def = enemyDef(e.kind);
      view.elite = elite;
      view.baseScale = def.scale * (elite ? ENEMY_TUNING.ELITE_SCALE_MUL : 1);
      view.height = ENEMY_VIS.HEIGHT * view.baseScale;
      view.radius = def.radius * (elite ? ENEMY_TUNING.ELITE_SCALE_MUL : 1);
      view.place(e.x, e.z, e.rot);
      view.hp = e.hp;
      view.flags = e.flags;
      if (view.anim !== e.anim || view.animSeq !== e.animSeq) {
        const first = view.anim === null;
        const changed = view.anim !== e.anim;
        view.anim = e.anim;
        view.animSeq = e.animSeq;
        this.startAnim(view, e.anim, first, changed);
      }
    }
    for (let i = this.active.length - 1; i >= 0; i--) {
      const v = this.active[i];
      if (v.gen === this.gen) continue;
      this.active[i] = this.active[this.active.length - 1];
      this.active.pop();
      this.byId.delete(v.id);
      // vanished without a kill event: play the death if it was (nearly) dead, otherwise just dissolve
      const dead = v.anim === 'death' || v.hp <= 0.02;
      this.beginDeath(v, dead && v.anim !== 'death', dead ? ENEMY_VIS.DEATH_HOLD * 0.4 : 0);
    }
  }

  private detach(view: EnemyView): void {
    const i = this.active.indexOf(view);
    if (i >= 0) { this.active[i] = this.active[this.active.length - 1]; this.active.pop(); }
    this.byId.delete(view.id);
  }

  private beginDeath(view: EnemyView, playClip: boolean, hold: number): void {
    view.dying = true;
    view.deathTime = 0;
    view.deathHold = hold;
    view.channel = '';
    view.domeOn = false;
    view.hunted = false;
    view.body.castShadow = false;
    if (playClip) view.play('Death_C_Skeletons', false, 0.06, 1.35);
    this.dying.push(view);
  }

  /** `kill` event: start the death right away, wherever the snapshots currently are. */
  kill(id: number): void {
    const view = this.byId.get(id);
    this.killed.set(id, this.time + KILL_MEMORY);
    if (!view) return;
    this.detach(view);
    this.beginDeath(view, view.anim !== 'death', ENEMY_VIS.DEATH_HOLD * (isBigEnemy(view.kind) ? 2 : 1));
  }

  /** `telegraph` event with a source: remembers its timing so the matching special lands with it. */
  telegraphed(id: number, dur: number): void {
    const view = this.byId.get(id);
    if (!view) return;
    view.teleAt = this.time;
    view.teleDur = dur;
    // the pose may already be running (snapshots lag events by the interpolation delay): re-time a leap in flight
    if (view.leaping && this.time - view.specialAt < BOSS2.TELEGRAPH_MEMORY) view.specialDur = Math.max(0.2, this.time - view.specialAt + dur);
    // a channel announced a moment ago ends with its telegraph
    if (view.channel && this.time - view.channelAt < BOSS2.TELEGRAPH_MEMORY) {
      view.channelDur = this.time - view.channelAt + dur;
      if (view.channel === HORDE.FUSE) view.fuseEnd = this.time + dur;
    }
  }

  /**
   * `cast` event of an enemy. The horde's actions (mend, raise, fuse, reaver_leap) start their windup look right away;
   * the clip follows when the snapshot row catches up (events run ahead of the interpolated snapshots).
   */
  cast(id: number, ability: string): void {
    const view = this.byId.get(id);
    if (!view) return;
    view.castAbility = ability;
    view.castAt = this.time;
    if (!HORDE_KINDS.has(view.kind)) return;
    const def = enemyDef(view.kind);
    const dur = ability === HORDE.MEND ? ENEMY_TUNING.SHAMAN.MEND_WINDUP : ability === HORDE.LEAP ? ENEMY_TUNING.REAVER.LEAP_AIR_TIME
      : ability === HORDE.RAISE || ability === HORDE.FUSE ? def.windup : 0;
    if (dur <= 0) return;
    view.channel = ability;
    view.channelAt = this.time;
    view.channelSeen = false;
    // the telegraph of the same action may have arrived just before the cast
    const since = this.time - view.teleAt;
    view.channelDur = since >= 0 && since < BOSS2.TELEGRAPH_MEMORY && view.teleDur > 0 ? Math.max(0.1, view.teleDur - since) : dur;
    if (ability === HORDE.FUSE) view.fuseEnd = this.time + view.channelDur;
    if (ability !== HORDE.RAISE) return;
    let slot = this.raises[0];
    for (const r of this.raises) if (r.until < slot.until) slot = r;
    slot.id = id;
    slot.until = this.time + view.channelDur + HORDE.RAISE_GRACE;
    slot.left = ENEMY_TUNING.NECROMANCER.RAISE_COUNT;
  }

  /**
   * `spawn` event. A minion that rises next to a necromancer that has just finished a `raise` is linked to it (the
   * contract carries no explicit link): it wears the necromancer's soul light and a tether until either is gone.
   */
  spawned(id: number, kind: EnemyKind, x: number, z: number, ward: ElementId | undefined): boolean {
    if (ward) {
      this.wards.set(id, ward);
      const v = this.byId.get(id);
      if (v) v.ward = ward;
    }
    if (kind !== 'minion') return false;
    for (const r of this.raises) {
      if (r.left <= 0 || r.until < this.time) continue;
      const master = this.byId.get(r.id);
      if (!master || Math.hypot(master.x - x, master.z - z) > HORDE.RAISE_REACH) continue;
      r.left--;
      this.masters.set(id, r.id);
      const v = this.byId.get(id);
      if (v) v.master = r.id;
      return true;
    }
    return false;
  }

  /** `interrupt` event: the wind-up of this enemy was broken; whatever it was channelling stops at once. */
  interrupt(id: number): void {
    const v = this.byId.get(id);
    if (!v) return;
    v.channel = '';
    v.fuseEnd = -10;
    v.teleDur = 0;
    v.interrupted = false;
    if (v.leaping) { v.leaping = false; if (v.airborne) this.land(v, false); }
  }

  /** `dome` event: an aegis raised or lost its ward dome. */
  dome(id: number, on: boolean, r: number): void {
    const v = this.byId.get(id);
    if (!v) return;
    v.domeOn = on;
    if (on) v.domeR = r;
  }

  /** Hunt objective: the marked targets that are still alive, and whether the timer has run out (they enrage). */
  setHunted(ids: readonly number[], enraged: boolean): void {
    this.huntCount = Math.min(this.hunt.length, ids.length);
    for (let i = 0; i < this.huntCount; i++) this.hunt[i] = ids[i];
    this.huntEnraged = enraged;
  }

  /** Calls `fn` for every living minion raised by the necromancer `id`. */
  forEachRaised(id: number, fn: (v: EnemyView) => void): void {
    for (const v of this.active) if (v.master === id) fn(v);
  }

  /** Raised domes of this frame as (x, z, r, visibility) for the dome shells. */
  forEachDome(fn: (x: number, z: number, r: number, k: number, seed: number) => void): void {
    for (const v of this.active) if (v.domeK > 0.003) fn(v.x, v.z, v.domeR, v.domeK, v.seed);
  }

  /** Seconds until the special that just started lands: the remaining time of its telegraph, else a default. */
  private windupOf(view: EnemyView, anim: EnemyAnim, fallback: number): number {
    const since = this.time - view.teleAt;
    if (since >= 0 && since < BOSS2.TELEGRAPH_MEMORY && view.teleDur > 0) return Math.max(0.12, view.teleDur - since);
    return BOSS2.WINDUP[anim] ?? fallback;
  }

  /** Hex Matron / Ossuary Stalker animation sets. Returns false to fall through to the common mapping. */
  private startBoss2(view: EnemyView, anim: EnemyAnim, first: boolean, changed: boolean): boolean {
    const matron = view.kind === 'matron';
    const repeat = !changed && view.lastSpecial === anim && this.time - view.lastSpecialTime < 2.5;
    const mark = (dur: number): void => {
      view.lastSpecial = anim;
      view.lastSpecialTime = this.time;
      view.specialAt = this.time;
      view.specialDur = dur;
    };
    switch (anim) {
      case 'move':
        if (!matron) return false;
        // glide: no steps, the robe hides the legs; the hover bob and forward lean are added in update()
        if (changed || first) view.play('Idle_Combat', true, first ? 0 : ANIM.FADE * 2, 0.5, view.seed * 4, view.currentClip !== 'Idle_Combat');
        return true;
      case 'beam': {
        if (!changed && !first) return true;
        const windup = this.windupOf(view, anim, 1);
        // raise the staff, then hold it levelled for as long as the rays keep turning (the world draws the rays)
        view.playTimed({ clip: 'Spellcast_Raise', impact: 0.9, fade: 0.12 }, windup, false, 1);
        view.queue({ clip: '2H_Ranged_Aiming', loop: true, fade: 0.14, speed: 0.6 }, windup);
        mark(windup);
        return true;
      }
      case 'volley': {
        // every further animSeq bump while the state lasts is one more shot of the salvo
        if (repeat) { view.play(matron ? 'Spellcast_Shoot' : '2H_Ranged_Shoot', false, 0.04, matron ? 1.5 : 1.9, matron ? 0.05 : 0.06); mark(0); return true; }
        const windup = this.windupOf(view, anim, 0.85);
        if (matron) view.playTimed({ clip: 'Spellcast_Long', impact: 1.45, fade: 0.1 }, windup, false, 1.3);
        else {
          view.playTimed({ clip: '2H_Ranged_Aiming', impact: 0.45, fade: 0.08 }, windup, true);
          view.queue({ clip: '2H_Ranged_Shoot', fade: 0.04, speed: 1.5 }, windup);
        }
        mark(windup);
        return true;
      }
      case 'windup': {
        // Stalker: the heavy spear (long aim). Matron: plain cast.
        const windup = this.windupOf(view, anim, enemyDef(view.kind).windup);
        const attack = ENEMY_ATTACK[view.kind];
        view.playTimed({ clip: attack.clip, impact: attack.impact, fade: 0.1 }, windup, true);
        mark(windup);
        return true;
      }
      case 'cast': {
        // a wound-up cast (blast lattice, wisps / caltrops) that resolves into `attack`
        const windup = this.windupOf(view, anim, 0.9);
        if (matron) view.playTimed({ clip: 'Spellcast_Long', impact: 1.35, fade: 0.1 }, windup, true);
        else view.playTimed({ clip: '1H_Melee_Attack_Slice_Diagonal', impact: 0.38, fade: 0.1 }, Math.min(windup, 0.5), false, 0.8);
        mark(windup);
        return true;
      }
      case 'slam': {
        if (!matron) return false;
        const windup = repeat ? Math.min(0.6, this.windupOf(view, anim, 0.6)) : this.windupOf(view, anim, 0.9);
        view.playTimed({ clip: '2H_Melee_Attack_Chop', impact: 0.78, fade: 0.1 }, windup, false, 1.2);
        mark(windup);
        return true;
      }
      case 'summon': {
        if (!matron) return false;
        const windup = this.windupOf(view, anim, 1.3);
        view.playTimed({ clip: 'Spellcast_Summon', impact: 2.9, fade: 0.1 }, windup, false, 1.3);
        mark(windup);
        return true;
      }
      case 'leap': {
        const total = this.windupOf(view, anim, 0.95);
        view.play('Jump_Start', false, 0.05, 2.4, 0.2);
        view.queue({ clip: 'Jump_Idle', loop: true, fade: 0.1 }, 0.16);
        view.leaping = true;
        mark(total);
        return true;
      }
      case 'charge': {
        const windup = this.windupOf(view, anim, 0.8);
        view.playTimed({ clip: 'Block', impact: 0.5, fade: 0.1 }, windup, true, 1.3);
        view.queue({ clip: 'Dodge_Forward', speed: 0.7, fade: 0.05 }, windup);
        mark(windup);
        return true;
      }
      case 'sweep': {
        const windup = this.windupOf(view, anim, enemyDef(view.kind).windup);
        view.playTimed({ clip: '2H_Melee_Attack_Slice', impact: 0.38, fade: 0.1 }, windup, false, 1.3);
        mark(windup);
        return true;
      }
      default:
        return false;
    }
  }

  private startAnim(view: EnemyView, anim: EnemyAnim, first: boolean, changed: boolean): void {
    const def = enemyDef(view.kind);
    const attack = ENEMY_ATTACK[view.kind];
    const recent = this.time - view.castAt < HORDE.CAST_MEMORY ? view.castAbility : '';
    const leap = anim === 'leap' || (recent === HORDE.LEAP && ACTION_ANIMS.has(anim));
    if (view.airborne && !leap) this.land(view, anim === 'idle' || anim === 'move');
    if (!leap) view.leaping = false;
    // an attack that was being wound up and is cut short by a stun / stagger: its telegraph is void
    if (anim === 'stun' && !isBigEnemy(view.kind) && (this.time < view.teleAt + view.teleDur - 0.1 || view.channelLeft(this.time) > 0.1)) view.interrupted = true;
    if (view.channel) {
      if (ACTION_ANIMS.has(anim)) view.channelSeen = true;
      else if (anim === 'stun' || anim === 'death' || (view.channelSeen && (anim === 'idle' || anim === 'move'))) { view.channel = ''; view.fuseEnd = -10; }
    }
    if ((view.kind === 'matron' || view.kind === 'stalker') && this.startBoss2(view, anim, first, changed)) return;
    if (HORDE_KINDS.has(view.kind) && this.startHorde(view, anim, recent, leap)) return;
    const look = ENEMY_LOOK[view.kind];
    switch (anim) {
      case 'spawn': {
        const clip = 'Spawn_Ground_Skeletons';
        const span = 3.57 - ANIM.SPAWN_START;
        view.play(clip, false, 0, span / Math.max(0.3, def.spawnTime), ANIM.SPAWN_START);
        break;
      }
      case 'idle':
        if (changed || first) view.play(look.idle ?? 'Idle_Combat', true, first ? 0 : ANIM.FADE * 1.5, look.idleSpeed ?? 1, look.idle ? view.seed : view.seed * 4, true);
        break;
      case 'move':
        // gliding robes keep their idle pose (the lean and bob are added in elevate)
        if (look.glide) { if (changed || first) view.play(look.idle ?? 'Idle_Combat', true, first ? 0 : ANIM.FADE * 2, look.idleSpeed ?? 0.5, view.seed, view.currentClip !== (look.idle ?? 'Idle_Combat')); break; }
        if (changed || first) view.play(look.walk ? 'Walking_D_Skeletons' : 'Running_C', true, first ? 0 : ANIM.FADE, 1, view.seed * 0.8, true);
        break;
      case 'windup':
        view.playTimed({ clip: attack.clip, impact: attack.impact, fade: 0.1 }, def.windup, true);
        break;
      case 'attack':
      case 'cast':
        if (attack.strike) view.play(attack.strike, false, 0.05, 1.2, attack.strikeStart ?? 0);
        else view.strike(attack.clip, attack.impact, 1.25);
        break;
      case 'stun':
        view.play('Hit_B', true, 0.08, 0.75);
        break;
      case 'death':
        if (first) view.pose('Death_C_Skeletons');
        else view.play('Death_C_Skeletons', false, 0.06, 1.35);
        break;
      case 'sweep':
      case 'charge':
      case 'volley':
      case 'summon':
      case 'slam': {
        const sp = SPECIALS[anim];
        const repeat = !changed && sp.repeat !== undefined && view.lastSpecial === anim && this.time - view.lastSpecialTime < 2.5;
        const windup = repeat ? (sp.repeat as number) : sp.windup(view.kind);
        view.playTimed({ clip: sp.clip, impact: sp.impact, fade: 0.1 }, windup, sp.then !== undefined, 1.3);
        if (sp.then) view.queue(sp.then, windup);
        view.lastSpecial = anim;
        view.lastSpecialTime = this.time;
        break;
      }
      case 'beam':
        // kinds without a channel pose: hold the casting stance
        view.play('Spellcast_Long', false, 0.1, 0.6);
        break;
      case 'leap':
        view.play('1H_Melee_Attack_Jump_Chop', false, 0.08, 1.2);
        break;
    }
  }

  /** Windups of the five horde kinds. Returns false to fall through to the common mapping. */
  private startHorde(view: EnemyView, anim: EnemyAnim, recent: string, leap: boolean): boolean {
    if (!ACTION_ANIMS.has(anim)) return false;
    const def = enemyDef(view.kind);
    if (leap && view.kind === 'reaver') {
      const total = this.windupOf(view, anim, ENEMY_TUNING.REAVER.LEAP_AIR_TIME);
      view.play('Jump_Start', false, 0.05, 2.6, 0.2);
      view.queue({ clip: 'Jump_Idle', loop: true, fade: 0.08 }, 0.12);
      view.leaping = true;
      view.specialAt = this.time;
      view.specialDur = total;
      return true;
    }
    // the mend channel: the totem is raised and held until the heal goes out (or the shaman is interrupted)
    if (view.kind === 'shaman' && (recent === HORDE.MEND || anim === 'summon' || anim === 'beam')) {
      const windup = this.windupOf(view, anim, ENEMY_TUNING.SHAMAN.MEND_WINDUP);
      view.playTimed({ clip: 'Spellcast_Raise', impact: 0.9, fade: 0.12 }, windup, true);
      if (!view.channel) { view.channel = HORDE.MEND; view.channelAt = this.time; view.channelDur = windup; view.channelSeen = true; }
      return true;
    }
    if (view.kind === 'necromancer' && anim !== 'cast') {
      const windup = this.windupOf(view, anim, def.windup);
      view.playTimed({ clip: 'Spellcast_Summon', impact: 2.9, fade: 0.1 }, windup, false, 1.3);
      if (!view.channel) { view.channel = HORDE.RAISE; view.channelAt = this.time; view.channelDur = windup; view.channelSeen = true; }
      return true;
    }
    if (view.kind === 'bomber' && anim !== 'cast') {
      // the fuse: it stops and shakes, faster and faster (the sparks and the blink are drawn in overlays)
      const windup = this.windupOf(view, anim, def.windup);
      view.play('Taunt', true, 0.06, 2.2);
      if (!view.channel) { view.channel = HORDE.FUSE; view.channelAt = this.time; view.channelDur = windup; view.channelSeen = true; view.fuseEnd = this.time + windup; }
      return true;
    }
    return false;
  }

  private land(view: EnemyView, playClip: boolean): void {
    view.airborne = false;
    view.landed = true;
    view.punch = 0.16;
    if (playClip) view.play('Jump_Land', false, 0.04, 1.4);
  }

  /** Hover of the Matron and the faked leap arc of the Stalker (the simulation only moves them on the floor). */
  private elevate(v: EnemyView, dt: number, time: number): void {
    let target = 0;
    let lean = 0;
    const upright = v.anim !== 'spawn' && v.anim !== 'death' && v.anim !== 'stun';
    if (v.kind === 'matron' && upright) {
      target = (BOSS2.HOVER + BOSS2.HOVER_BOB * Math.sin(time * 2.1 + v.seed * 6)) * v.baseScale;
      if (v.anim === 'move') lean = Math.min(0.2, v.speed * 0.05);
    } else if (upright) {
      const look = ENEMY_LOOK[v.kind];
      lean = look.lean ?? 0;
      if (look.glide) {
        target = HORDE.NECRO_HOVER * (1 + Math.sin(time * 1.7 + v.seed * 6)) * v.baseScale;
        if (v.anim === 'move') lean = Math.min(0.16, v.speed * 0.05);
      }
      // a channel straightens the caster up; a lit bomber rears back
      if (v.channel) lean *= 0.3;
    }
    if (v.leaping) {
      const t = time - v.specialAt;
      const crouch = Math.min(BOSS2.LEAP_CROUCH, v.specialDur * 0.3);
      const k = (t - crouch) / Math.max(0.1, v.specialDur - crouch);
      if (k > 0 && k < 1) {
        v.airborne = true;
        v.lift = BOSS2.LEAP_HEIGHT * v.baseScale * 4 * k * (1 - k);
        v.root.rotation.x = 0.35 * (k - 0.5);
        return;
      }
      if (k >= 1 && v.airborne) this.land(v, true);
      target = 0;
    }
    v.lift += (target - v.lift) * Math.min(1, dt * (v.lift > target ? 14 : 5));
    v.root.rotation.x += (lean - v.root.rotation.x) * Math.min(1, dt * 6);
  }

  get(id: number): EnemyView | null {
    return this.byId.get(id) ?? null;
  }

  /** `spawn.affix`: remembered until the enemy's view exists (events run ahead of the interpolated snapshots). */
  setAffix(id: number, affix: AffixId): void {
    this.affixes.set(id, affix);
    const v = this.byId.get(id);
    if (v) v.affix = affix;
  }

  /** `shieldBreak` on an armoured elite: the plating is gone for good. */
  breakGuard(id: number): void {
    const v = this.byId.get(id);
    if (v) v.guardBroken = true;
  }

  /** `mark` event (shade ultimate). */
  mark(id: number, dur: number): void {
    const v = this.byId.get(id);
    if (!v) return;
    v.markLeft = dur;
    v.markTotal = Math.max(0.1, dur);
  }

  hit(id: number, r: number, g: number, b: number): void {
    const v = this.byId.get(id);
    if (!v) return;
    v.hitFlash(r, g, b);
    v.punch = isBigEnemy(v.kind) ? 0.05 : 0.12;
  }

  get count(): number {
    return this.active.length + this.dying.length;
  }

  update(dt: number, time: number, decals: DecalBatch, ui: BillboardBatch, fx: BillboardBatch, blobShadows: boolean): void {
    this.time = time;
    if (this.killed.size > 0) this.killed.forEach(this.expire);
    for (const v of this.active) v.hunted = false;
    for (let i = 0; i < this.huntCount; i++) {
      const v = this.byId.get(this.hunt[i]);
      if (v) v.hunted = true;
    }

    for (const v of this.active) {
      v.age += dt;
      if (v.markLeft > 0) v.markLeft = Math.max(0, v.markLeft - dt);
      const look = ENEMY_LOOK[v.kind];
      if (v.anim === 'move' && !look.glide) {
        const natural = (look.walk ? ENEMY_VIS.WALK_SPEED : ENEMY_VIS.RUN_SPEED) * v.baseScale;
        v.play(v.currentClip, true, 0, Math.min(2, Math.max(0.5, v.speed / natural)), 0, false);
      }
      this.applyStatus(v, time);
      v.update(dt);
      if (v.kind === 'matron' || v.kind === 'stalker' || HORDE_KINDS.has(v.kind) || v.lift !== 0) {
        this.elevate(v, dt, time);
        v.root.position.y = v.lift;
      }
      if (v.channel && time >= v.channelAt + v.channelDur) v.channel = '';
      v.domeK += ((v.domeOn ? 1 : 0) - v.domeK) * Math.min(1, dt * (v.domeOn ? 5 : 9));
      v.guarded = false;
      for (let d = 0; d < this.domeCount; d++) {
        const dx = v.x - this.domes[d * 3];
        const dz = v.z - this.domes[d * 3 + 1];
        if (dx * dx + dz * dz < this.domes[d * 3 + 2] && v.domeK < 0.5) { v.guarded = true; break; }
      }
      this.overlays(v, time, decals, ui, fx, blobShadows);
      if (HORDE_KINDS.has(v.kind) || v.ward || v.master >= 0 || v.hunted || v.guarded) this.hordeFx(v, dt, time, decals, ui, fx);
    }
    // the domes standing this frame, for next frame's "guarded" test
    this.domeCount = 0;
    for (const v of this.active) {
      if (v.domeK < 0.5 || this.domeCount >= LIMITS.DOMES) continue;
      this.domes[this.domeCount * 3] = v.x;
      this.domes[this.domeCount * 3 + 1] = v.z;
      this.domes[this.domeCount * 3 + 2] = v.domeR * v.domeR;
      this.domeCount++;
    }

    for (let i = this.dying.length - 1; i >= 0; i--) {
      const v = this.dying[i];
      v.deathTime += dt;
      const t = (v.deathTime - v.deathHold) / ENEMY_VIS.DEATH_SINK;
      v.lift *= Math.max(0, 1 - dt * 10);
      v.root.position.y = v.lift;
      if (t > 0) {
        const k = Math.min(1, t);
        v.root.position.y = v.lift - ENEMY_VIS.SINK_DEPTH * v.baseScale * k * k;
        v.mat.uniforms.uFade.value = 1 - k;
      }
      v.mat.uniforms.uTint.value.set(0.25, 0.22, 0.3, Math.min(0.6, v.deathTime * 1.2));
      v.update(dt);
      if (blobShadows && t < 1) decals.push(DECAL.SHADOW, v.x, 0.02, v.z, 0, v.radius * 3.2, v.radius * 3.2, 0, 0, 0, 0.45 * (1 - Math.max(0, t)));
      if (t >= 1) {
        this.dying[i] = this.dying[this.dying.length - 1];
        this.dying.pop();
        this.release(v);
      }
    }
  }

  private applyStatus(v: EnemyView, time: number): void {
    const u = v.mat.uniforms;
    const f = v.flags;
    // Each status owns a distinct surface read: Burn = warm tint + orange rim, Chill = pale frost crust,
    // Shock = hard violet flicker. Several at once blend, with the rim carrying the mix.
    let tr = 0; let tg = 0; let tb = 0; let ta = 0;
    let rr = 0; let rg = 0; let rb = 0;
    if (f & EF.BURN) {
      const c = STATUS_COLORS.burn;
      const lick = 0.8 + 0.2 * Math.sin(time * 11 + v.seed * 9);
      tr += c.r * STATUS_VIS.BURN_TINT; tg += c.g * STATUS_VIS.BURN_TINT; tb += c.b * STATUS_VIS.BURN_TINT; ta += STATUS_VIS.BURN_TINT;
      rr += c.r * STATUS_VIS.RIM.burn * lick; rg += c.g * STATUS_VIS.RIM.burn * lick; rb += c.b * STATUS_VIS.RIM.burn * lick;
    }
    if (f & EF.CHILL) {
      const [fr, fg, fb] = STATUS_VIS.FROST;
      tr += fr * STATUS_VIS.CHILL_TINT; tg += fg * STATUS_VIS.CHILL_TINT; tb += fb * STATUS_VIS.CHILL_TINT; ta += STATUS_VIS.CHILL_TINT;
      const c = STATUS_COLORS.chill;
      rr += c.r * STATUS_VIS.RIM.chill; rg += c.g * STATUS_VIS.RIM.chill; rb += c.b * STATUS_VIS.RIM.chill;
    }
    if (f & EF.SHOCK) {
      const c = STATUS_COLORS.shock;
      const jolt = hash1(Math.floor(time * STATUS_VIS.FLICKER_HZ) + v.seed * 31) > 0.55 ? 1 : 0.12;
      const amount = STATUS_VIS.SHOCK_TINT * (0.5 + jolt);
      tr += c.r * amount; tg += c.g * amount; tb += c.b * amount; ta += amount;
      rr += c.r * STATUS_VIS.RIM.shock * jolt; rg += c.g * STATUS_VIS.RIM.shock * jolt; rb += c.b * STATUS_VIS.RIM.shock * jolt;
    }
    if (f & EF.WITHER) {
      // Wither: the body darkens to violet-black, only a pale green edge still catches light, slowly breathing
      const body = STATUS_COLORS.witherBody;
      const c = STATUS_COLORS.wither;
      const breathe = 0.7 + 0.3 * Math.sin(time * 2.6 + v.seed * 9);
      tr += body.r * 0.35 * STATUS_VIS.WITHER_TINT; tg += body.g * 0.35 * STATUS_VIS.WITHER_TINT; tb += body.b * 0.35 * STATUS_VIS.WITHER_TINT; ta += STATUS_VIS.WITHER_TINT;
      rr += c.r * STATUS_VIS.RIM.wither * breathe; rg += c.g * STATUS_VIS.RIM.wither * breathe; rb += c.b * STATUS_VIS.RIM.wither * breathe;
    }
    let rim = ta > 0;
    if (v.ward) {
      // the ward: a steady shell of the element it turns away
      const c = rgb(ELEMENT_COLOR[v.ward]);
      const k = 1.5 + 0.3 * Math.sin(time * 3.1 + v.seed * 7);
      rr += c[0] * k; rg += c[1] * k; rb += c[2] * k;
      rim = true;
    }
    if (v.guarded) { rr += AEGIS_RGB[0] * 1.3; rg += AEGIS_RGB[1] * 1.3; rb += AEGIS_RGB[2] * 1.3; rim = true; }
    if (v.master >= 0) { rr += SOUL_RGB[0] * 0.9; rg += SOUL_RGB[1] * 0.9; rb += SOUL_RGB[2] * 0.9; rim = true; }
    if (ta > 0) u.uTint.value.set(tr / ta, tg / ta, tb / ta, Math.min(0.7, ta));
    else if (v.master >= 0) u.uTint.value.set(GRAVE_RGB[0], GRAVE_RGB[1], GRAVE_RGB[2], 0.3);
    else u.uTint.value.w = 0;
    u.uRim.value.set(rr, rg, rb, rim ? 1 : 0);

    const look = ENEMY_LOOK[v.kind];
    _color.setHex(look.emissive);
    let er = _color.r;
    let eg = _color.g;
    let eb = _color.b;
    if (ta > 0) { er += rr * 0.03; eg += rg * 0.03; eb += rb * 0.03; }
    if (v.elite) { er += 0.1; eg += 0.008; eb += 0.004; }
    if (v.affix === 'volatile') { const p = 0.1 + 0.1 * Math.sin(time * 7 + v.seed * 5); er += p; eg += p * 0.55; }
    if (v.markLeft > 0) { er += 0.05; eg += 0.02; eb += 0.09; }
    if (f & EF.ENRAGED) { const p = 0.14 + 0.1 * Math.sin(time * 9); er += p; eg += p * 0.12; }
    if (f & EF.SHIELDED) { er += 0.02; eg += 0.05; eb += 0.09; }
    if (v.channel === HORDE.FUSE) {
      // the lit bomber blinks hot, faster towards the end
      const k = 1 - v.channelLeft(time) / Math.max(0.1, v.channelDur);
      const blink = Math.sin(v.fusePhase * 2.2) > 0 ? 1 : 0.15;
      er += 0.5 * blink * (0.4 + k); eg += 0.32 * blink * (0.4 + k); eb += 0.05 * blink;
    } else if (v.channel === HORDE.MEND) { er += 0.03; eg += 0.14; eb += 0.02; } else if (v.channel === HORDE.RAISE) { er += 0.08; eg += 0.03; eb += 0.14; }
    u.uEmissive.value.setRGB(er, eg, eb);

    _color.setHex(v.master >= 0 ? PALETTE.soul : v.elite && !isBigEnemy(v.kind) ? PALETTE.hostile : EYE_COLOR[v.kind]);
    const glow = ANIM.GLOW_BOOST * (f & EF.STUNNED ? 0.35 : 1);
    u.uGlow.value.setRGB(_color.r * glow, _color.g * glow, _color.b * glow);
  }

  private overlays(v: EnemyView, time: number, decals: DecalBatch, ui: BillboardBatch, fx: BillboardBatch, blobShadows: boolean): void {
    const f = v.flags;
    const spawning = v.anim === 'spawn';
    const lifted = v.lift > 0.3 ? Math.max(0.45, 1 - v.lift * 0.18) : 1;
    if ((blobShadows || v.lift > 0.3) && !spawning) decals.push(DECAL.SHADOW, v.x, 0.02, v.z, 0, v.radius * 3.2 * lifted, v.radius * 3.2 * lifted, 0, 0, 0, 0.5 * lifted);
    const bossy = isBigEnemy(v.kind);
    if (v.elite || bossy) {
      const aura = BOSS_AURA[v.kind];
      const c = aura ? rgb(aura[0]) : ELITE_RGB;
      const c2 = aura ? rgb(aura[1]) : ELITE_RGB;
      const pulse = 0.75 + 0.25 * Math.sin(time * 4 + v.seed * 6);
      const size = v.radius * (bossy ? 4.6 : 4.2);
      decals.push(DECAL.DISC, v.x, 0.03, v.z, 0, size, size, c[0], c[1] * 0.6, c[2], 0.34 * pulse, 0.55, 0.15);
      decals.push(DECAL.RING, v.x, 0.04, v.z, time * 0.8, size * 0.72, size * 0.72, c[0] * 1.5, c[1], c[2] * 1.2, 0.7, 0.3, 0);
      if (bossy) fx.push(SPRITE.GLOW, v.x, v.lift + v.height * 0.55, v.z, v.height * 2.3, v.height * 2.3, c[0], c[1] * 0.5, c[2], 0.12 * pulse, 1, 0);
      if (v.kind === 'matron' && !spawning) {
        // a slow hex circle under her and witchfire orbs circling the robe
        decals.push(DECAL.RUNE, v.x, 0.045, v.z, -time * 0.5, size * 1.25, size * 1.25, c[0] * 1.3, c[1] * 1.3, c[2] * 1.3, 0.55, 0.7, 0.6);
        for (let k = 0; k < BOSS2.ORBS; k++) {
          const a = time * 1.5 + (k / BOSS2.ORBS) * Math.PI * 2;
          const ox = v.x + Math.sin(a) * v.radius * 1.65;
          const oz = v.z + Math.cos(a) * v.radius * 1.65;
          const oy = v.lift + v.height * (0.42 + 0.1 * Math.sin(time * 2.3 + k * 2.1));
          fx.push(SPRITE.GLOW, ox, oy, oz, 0.95, 0.95, c2[0] * 1.6, c2[1] * 1.6, c2[2] * 1.6, 0.95, 1, 1.4);
          fx.push(SPRITE.SPARK, ox, oy, oz, 0.3, 0.3, 2.2, 2.4, 2, 1, 1, 0, a * 2);
          decals.push(DECAL.DISC, ox, 0.035, oz, 0, 1.3, 1.3, c2[0], c2[1], c2[2], 0.22, 1, 0);
        }
        if (v.hand) {
          const e = v.hand.matrixWorld.elements;
          fx.push(SPRITE.GLOW, e[12], e[13] + 0.3 * v.baseScale, e[14], 1.6, 1.6, c2[0], c2[1], c2[2], 0.3 * pulse, 1, 0.6);
        }
      } else if (v.kind === 'stalker' && !spawning) {
        // a predator's mark: hard double ring and a sickly lantern glow on the chest
        decals.push(DECAL.PROGRESS, v.x, 0.045, v.z, time * -1.3, size * 0.95, size * 0.95, c2[0] * 1.4, c2[1] * 1.4, c2[2] * 1.4, 0.55, 0.5, 0.18);
        decals.push(DECAL.PROGRESS, v.x, 0.045, v.z, time * -1.3 + Math.PI, size * 0.95, size * 0.95, c2[0] * 1.4, c2[1] * 1.4, c2[2] * 1.4, 0.55, 0.5, 0.18);
        fx.push(SPRITE.GLOW, v.x + Math.sin(v.root.rotation.y) * 0.4, v.lift + v.height * 0.55, v.z + Math.cos(v.root.rotation.y) * 0.4, 1.3, 1.3, c[0], c[1], c[2], 0.3 * pulse, 1, 0.7);
      }
    }
    if (v.affix && !spawning && v.root.visible) this.affixFx(v, time, decals, fx);
    if (v.markLeft > 0) this.markFx(v, time, decals, ui);
    if (v.anim === 'beam') this.channel(v, time, decals, fx);
    if (f & EF.SHIELDED) {
      _color.setHex(PALETTE.shield);
      decals.push(DECAL.PROGRESS, v.x, 0.045, v.z, v.root.rotation.y - Math.PI * 0.3, v.radius * 3.4, v.radius * 3.4, _color.r, _color.g, _color.b, 0.9, 0.3, 0.3);
    }
    if (!spawning && v.root.visible) this.statusFx(v, time, decals, fx);
    const top = v.lift + v.height + 0.25;
    if (ENEMY_LOOK[v.kind].bar && v.hp < 0.999 && v.hp > 0 && !spawning) {
      const w = ENEMY_VIS.HEALTH_BAR_W * (v.elite ? 1.3 : 1);
      if (v.elite) ui.push(SPRITE.BAR, v.x, top, v.z, w, ENEMY_VIS.HEALTH_BAR_H, 1, 0.72, 0.2, 1, 0, v.hp);
      else ui.push(SPRITE.BAR, v.x, top, v.z, w, ENEMY_VIS.HEALTH_BAR_H, 0.95, 0.24, 0.2, 1, 0, v.hp);
    }
    // element pips (filled, colour-coded) and state icons in a row above the bar
    let n = 0;
    if (f & EF.BURN) n++;
    if (f & EF.CHILL) n++;
    if (f & EF.SHOCK) n++;
    if (f & EF.WITHER) n++;
    if (f & EF.SHIELDED) n++;
    if (f & EF.ENRAGED) n++;
    const affix = spawning ? null : v.affix;
    if (affix) n++;
    const ward = spawning ? null : v.ward;
    if (ward) n++;
    if (n > 0) {
      const size = bossy ? 0.66 : 0.48;
      let ox = -(n - 1) * size * 0.5;
      if (ward) {
        // the element inside a shield: this enemy shrugs that element off
        const wide = size * 1.5;
        this.icon(ui, v, top, 'ward', ELEMENT_COLOR[ward], wide, ox);
        const uv = this.atlas.icons[WARD_ICON[ward]];
        _color.setHex(ELEMENT_COLOR[ward]);
        ui.push(SPRITE.ATLAS, v.x, top, v.z, wide * 0.5, wide * 0.5, _color.r * 1.2, _color.g * 1.2, _color.b * 1.2, 1, 0, 0, 0, ox, 0.42, uv[0], uv[1], uv[2], uv[3]);
        ox += size;
      }
      if (affix) { this.icon(ui, v, top, affix, AFFIX_COLOR[affix], size, ox); ox += size; }
      if (f & EF.BURN) { this.pip(ui, v, top, 'burn', ELEMENT_COLOR.ember, size, ox); ox += size; }
      if (f & EF.CHILL) { this.pip(ui, v, top, 'chill', ELEMENT_COLOR.rime, size, ox); ox += size; }
      if (f & EF.SHOCK) { this.pip(ui, v, top, 'shock', ELEMENT_COLOR.storm, size, ox); ox += size; }
      if (f & EF.WITHER) { this.pip(ui, v, top, 'wither', PALETTE.umbraDeep, size, ox, ELEMENT_COLOR.umbra); ox += size; }
      if (f & EF.SHIELDED) { this.icon(ui, v, top, 'shield', PALETTE.shield, size, ox); ox += size; }
      if (f & EF.ENRAGED) this.icon(ui, v, top, 'enrage', PALETTE.hostile, size, ox);
    }
    if (f & EF.STUNNED) {
      const uv = this.atlas.icons.stun;
      for (let k = 0; k < 3; k++) {
        const a = time * 4.2 + (k / 3) * Math.PI * 2;
        const depth = Math.sin(a);
        ui.push(SPRITE.ATLAS, v.x, v.height * 0.98, v.z, 0.36, 0.36, 1, 0.86, 0.3, 0.75 + 0.25 * depth, 0, 0, a, Math.cos(a) * 0.42 * v.baseScale, depth * 0.12, uv[0], uv[1], uv[2], uv[3]);
      }
    }
  }

  /**
   * Everything update 4 hangs on an enemy: the ward shell, the dome's footprint, the shaman's channel, the bomber's
   * fuse, the necromancer's soul lights and tethers, the reaver's blades, and the hunt marker.
   */
  private hordeFx(v: EnemyView, dt: number, time: number, decals: DecalBatch, ui: BillboardBatch, fx: BillboardBatch): void {
    if (v.anim === 'spawn') return;
    const s = v.baseScale;
    const mid = v.lift + v.height * 0.5;
    if (v.hunted) {
      // the quarry: a pin bobbing high over the head and two brackets closing around its feet; red once it enrages
      const c = this.huntEnraged ? HOSTILE_RGB : HUNT_RGB;
      // the brackets on the floor stay out of the telegraph red even then
      const g = this.huntEnraged ? HOT_RGB : HUNT_RGB;
      const rate = this.huntEnraged ? 3.4 : 1.2;
      const beat = this.huntEnraged ? 0.75 + 0.25 * Math.sin(time * 11 + v.seed * 5) : 1;
      const d = v.radius * 5.4;
      for (let k = 0; k < 2; k++) {
        decals.push(DECAL.PROGRESS, v.x, 0.049, v.z, time * rate + k * Math.PI, d, d, g[0] * 1.6, g[1] * 1.6, g[2] * 1.6, 0.95 * beat, 0.45, 0.2);
        decals.push(DECAL.PROGRESS, v.x, 0.049, v.z, -time * rate * 0.7 + k * Math.PI, d * 1.28, d * 1.28, g[0] * 1.3, g[1] * 1.3, g[2] * 1.3, 0.7 * beat, 0.4, 0.1);
      }
      decals.push(DECAL.DISC, v.x, 0.031, v.z, 0, d * 1.2, d * 1.2, g[0], g[1], g[2], 0.16 * beat, 1, 0.2);
      const uv = this.atlas.icons.hunt;
      const bob = Math.abs(Math.sin(time * 2.6 + v.seed * 6)) * 0.22;
      const y = v.lift + v.height + HORDE.HUNT_Y + bob;
      const size = HORDE.HUNT_SIZE * (this.huntEnraged ? 1.12 : 1);
      ui.push(SPRITE.GLOW, v.x, y, v.z, size * 1.9, size * 1.9, c[0] * 0.25, c[1] * 0.2, c[2] * 0.1, 0.75);
      ui.push(SPRITE.ATLAS, v.x, y, v.z, size, size, c[0] * 1.25, c[1] * 1.25, c[2] * 1.25, 1, 0, 0, 0, 0, 0, uv[0], uv[1], uv[2], uv[3]);
      if (this.huntEnraged && v.root.visible) {
        for (let k = 0; k < 2; k++) {
          const a = time * 2.3 + k * Math.PI + v.seed * 6;
          const h = (0.7 + 0.25 * hash1(Math.floor(time * 10 + k * 3) + v.seed * 13)) * s;
          fx.push(SPRITE.FLAME, v.x + Math.sin(a) * v.radius * 0.9, v.lift + v.height * 0.75 + h * 0.4, v.z + Math.cos(a) * v.radius * 0.9, h * 0.6, h, c[0] * 2, c[1] * 2 + 0.3, c[2] * 2, 0.9, 0.85, v.seed + k * 0.4);
        }
      }
    }
    if (!v.root.visible) return;
    if (v.ward) {
      // a rune circle and three shards of the element circling the body: that element does nothing here
      const c = rgb(ELEMENT_COLOR[v.ward]);
      const d = v.radius * 4.8;
      decals.push(DECAL.RUNE, v.x, 0.044, v.z, -time * 0.8 + v.seed * 6, d, d, c[0] * 1.4, c[1] * 1.4, c[2] * 1.4, 0.8, 0.55, 0.3);
      for (let k = 0; k < HORDE.WARD_SHARDS; k++) {
        const a = time * 1.5 + (k / HORDE.WARD_SHARDS) * Math.PI * 2 + v.seed * 6;
        fx.push(SPRITE.SHARD, v.x + Math.sin(a) * v.radius * 1.55, mid + 0.25 * s * Math.sin(time * 2.2 + k * 2.1), v.z + Math.cos(a) * v.radius * 1.55, 0.3 * s, 0.52 * s,
          c[0] * 1.4, c[1] * 1.4, c[2] * 1.4, 0.95, 0.35, 1);
      }
      fx.push(SPRITE.GLOW, v.x, mid, v.z, v.height * 1.15, v.height * 1.4, c[0], c[1], c[2], 0.13, 1, 0);
    }
    if (v.guarded) {
      const d = v.radius * 3.6;
      decals.push(DECAL.PROGRESS, v.x, 0.046, v.z, time * 2.2 + v.seed * 6, d, d, AEGIS_RGB[0] * 1.4, AEGIS_RGB[1] * 1.4, AEGIS_RGB[2] * 1.4, 0.85, 0.5, 0.3);
    }
    if (v.master >= 0) {
      const m = this.byId.get(v.master);
      if (m) {
        // a thin thread of grave light on the floor, brightest at the minion it holds upright
        const dx = v.x - m.x;
        const dz = v.z - m.z;
        const len = Math.hypot(dx, dz);
        if (len > 0.3) {
          const pulse = 0.55 + 0.25 * Math.sin(time * 4 - len * 0.8 + v.seed * 6);
          decals.push(DECAL.STREAK, (v.x + m.x) * 0.5, 0.036, (v.z + m.z) * 0.5, Math.atan2(dx, dz), HORDE.TETHER_WIDTH, len, SOUL_RGB[0] * 1.3, SOUL_RGB[1] * 1.3, SOUL_RGB[2] * 1.3, pulse, 0.9);
        }
      }
      fx.push(SPRITE.GLOW, v.x, v.lift + v.height + 0.2, v.z, 0.5, 0.7, SOUL_RGB[0] * 1.4, SOUL_RGB[1] * 1.4, SOUL_RGB[2] * 1.4, 0.55 + 0.25 * Math.sin(time * 5 + v.seed * 9), 1, 0.9);
      decals.push(DECAL.DISC, v.x, 0.03, v.z, 0, v.radius * 4, v.radius * 4, GRAVE_RGB[0], GRAVE_RGB[1], GRAVE_RGB[2], 0.28, 1, 0.1);
    }
    const left = v.channelLeft(time);
    const k = v.channel ? 1 - left / Math.max(0.1, v.channelDur) : 0;
    switch (v.kind) {
      case 'shaman': {
        const c = MEND_RGB;
        if (!v.anchor('totem', _anchor)) _anchor.set(v.x, v.lift + v.height, v.z);
        const breathe = 0.7 + 0.3 * Math.sin(time * 3.3 + v.seed * 6);
        fx.push(SPRITE.GLOW, _anchor.x, _anchor.y, _anchor.z, 0.8 + 1.3 * k, 0.8 + 1.3 * k, c[0] * 1.5, c[1] * 1.5, c[2] * 1.5, 0.4 * breathe + 0.35 * k, 1, 0.6 + 0.4 * k);
        decals.push(DECAL.DISC, v.x, 0.03, v.z, 0, v.radius * 5, v.radius * 5, c[0], c[1], c[2], 0.16 + 0.2 * k, 1, 0);
        if (v.channel !== HORDE.MEND) break;
        // the channel: a ring at the reach of the heal that fills as it completes, and motes drawn in to the totem
        const d = ENEMY_TUNING.SHAMAN.MEND_RADIUS * 2;
        decals.push(DECAL.PROGRESS, v.x, 0.047, v.z, 0, d, d, c[0] * 1.5, c[1] * 1.5, c[2] * 1.5, 0.55 + 0.35 * k, 0.5, k);
        decals.push(DECAL.RUNE, v.x, 0.045, v.z, time * 1.4, v.radius * 7, v.radius * 7, c[0] * 1.5, c[1] * 1.5, c[2] * 1.5, 0.75, 0.7, k);
        for (let i = 0; i < HORDE.MEND_MOTES; i++) {
          const ph = (time * 0.9 + i / HORDE.MEND_MOTES + v.seed) % 1;
          const a = i * 1.257 + ph * 2.6 + v.seed * 6;
          const r = ENEMY_TUNING.SHAMAN.MEND_RADIUS * 0.6 * (1 - ph);
          fx.push(SPRITE.GLOW, v.x + Math.sin(a) * r, 0.3 + (_anchor.y - 0.3) * ph, v.z + Math.cos(a) * r, 0.45, 0.45, c[0] * 1.8, c[1] * 1.8, c[2] * 1.8, 0.9 * Math.sin(ph * Math.PI), 1, 1.2);
        }
        fx.push(SPRITE.GLOW, v.x, v.lift + v.height * 1.3, v.z, 1.1 * k, v.height * 2.4, c[0] * 1.3, c[1] * 1.3, c[2] * 1.3, 0.3 * k, 1, 0.4);
        break;
      }
      case 'aegis': {
        const c = AEGIS_RGB;
        const e = v.handL ? v.handL.matrixWorld.elements : null;
        const pulse = 0.75 + 0.25 * Math.sin(time * 2.4 + v.seed * 6);
        if (e) fx.push(SPRITE.GLOW, e[12], e[13], e[14], 1.3 * s, 1.3 * s, c[0] * 1.3, c[1] * 1.3, c[2] * 1.3, (0.3 + 0.35 * v.domeK) * pulse, 1, 0.6);
        if (v.domeK < 0.01) break;
        // the dome's footprint (the shell itself is a mesh, see horde.ts)
        const d = v.domeR * 2 * (0.6 + 0.4 * v.domeK);
        decals.push(DECAL.DISC, v.x, 0.029, v.z, 0, d, d, c[0], c[1], c[2], 0.07 * v.domeK, 1, 0.9);
        decals.push(DECAL.PROGRESS, v.x, 0.047, v.z, time * 0.25, d, d, c[0] * 1.5, c[1] * 1.5, c[2] * 1.5, 0.85 * v.domeK, 0.45, 1);
        decals.push(DECAL.RUNE, v.x, 0.045, v.z, -time * 0.3, d * 0.42, d * 0.42, c[0] * 1.2, c[1] * 1.2, c[2] * 1.2, 0.4 * v.domeK, 0.6, 0.2);
        break;
      }
      case 'bomber': {
        const c = FUSE_RGB;
        const lit = v.channel === HORDE.FUSE;
        v.fusePhase += dt * (lit ? HORDE.FUSE_RATE + (HORDE.FUSE_RATE_LIT - HORDE.FUSE_RATE) * k * k + 3 : HORDE.FUSE_RATE);
        if (!v.anchor('fuse', _anchor)) _anchor.set(v.x, v.lift + v.height * 1.2, v.z);
        const flick = 0.75 + 0.25 * Math.sin(v.fusePhase * 9);
        const heat = lit ? 1 + 1.6 * k : 1;
        fx.push(SPRITE.GLOW, _anchor.x, _anchor.y, _anchor.z, 0.3 * heat, 0.3 * heat, c[0] * 2, c[1] * 1.8, c[2] * 1.4, 0.8 * flick, 1, 0.8);
        for (let i = 0; i < HORDE.FUSE_SPARKS; i++) {
          const ph = (v.fusePhase + i / HORDE.FUSE_SPARKS) % 1;
          const a = i * 2.4 + Math.floor(v.fusePhase + i / HORDE.FUSE_SPARKS) * 1.9;
          const reach = (0.35 + 0.5 * (lit ? k : 0)) * ph;
          fx.push(SPRITE.SPARK, _anchor.x + Math.sin(a) * reach, _anchor.y + ph * (0.5 - ph) * 1.2, _anchor.z + Math.cos(a) * reach, 0.13 * (1.2 - ph) * heat, 0.13 * (1.2 - ph) * heat,
            2.4, 2 - ph, 0.9 - ph * 0.6, 1 - ph * 0.7, 1, 0, a);
        }
        // the charge itself glows through the staves
        fx.push(SPRITE.GLOW, _anchor.x, _anchor.y - 0.6 * s, _anchor.z, 1.5 * s * heat, 1.5 * s * heat, c[0] * 1.5, c[1] * 1.1, c[2] * 0.6, (lit ? 0.1 + 0.5 * k : 0) * flick, 1, 0.3);
        if (lit) decals.push(DECAL.CRACKLE, v.x, 0.046, v.z, time * 2, v.radius * (3 + 3 * k), v.radius * (3 + 3 * k), c[0] * 1.6, c[1] * 1.3, c[2], 0.5 + 0.4 * k, 1, 0.35, 1);
        break;
      }
      case 'necromancer': {
        const c = SOUL_RGB;
        const breathe = 0.7 + 0.3 * Math.sin(time * 2.2 + v.seed * 6);
        // a pool of grave dark under the robe and a soul light in each palm
        decals.push(DECAL.SMOKE, v.x, 0.032, v.z, time * 0.3 + v.seed * 6, v.radius * 6.2, v.radius * 6.2, UMBRA_CORE[0], UMBRA_CORE[1], UMBRA_CORE[2], 0.8, 0, 0.9, GRAVE_RGB[0], GRAVE_RGB[1], GRAVE_RGB[2]);
        for (let n = 0; n < 2; n++) {
          const hand = n === 0 ? v.hand : v.handL;
          if (!hand) continue;
          const e = hand.matrixWorld.elements;
          fx.push(SPRITE.GLOW, e[12], e[13] + 0.16 * s, e[14], 0.7 + 1.1 * k, 0.7 + 1.1 * k, c[0] * 1.6, c[1] * 1.6, c[2] * 1.6, 0.55 * breathe + 0.4 * k, 1, 1 + k);
        }
        if (v.channel !== HORDE.RAISE) break;
        const g = GRAVE_RGB;
        decals.push(DECAL.RUNE, v.x, 0.046, v.z, -time * 1.5, v.radius * 9, v.radius * 9, g[0] * 1.8, g[1] * 1.8, g[2] * 1.8, 0.85, 0.75, k);
        decals.push(DECAL.PROGRESS, v.x, 0.048, v.z, 0, v.radius * 10.5, v.radius * 10.5, c[0] * 1.4, c[1] * 1.4, c[2] * 1.4, 0.8, 0.5, k);
        fx.push(SPRITE.GLOW, v.x, v.lift + v.height * 1.4, v.z, 1.2 * k, v.height * 2.6, g[0] * 1.6, g[1] * 1.6, g[2] * 1.6, 0.35 * k, 1, 0.4);
        break;
      }
      case 'reaver': {
        // pale edges: a glint in each hand, a longer one while it is in the air
        const c = REAVER_RGB;
        const air = v.leaping ? 1 : 0;
        for (let n = 0; n < 2; n++) {
          const hand = n === 0 ? v.hand : v.handL;
          if (!hand) continue;
          const e = hand.matrixWorld.elements;
          fx.push(SPRITE.GLOW, e[12], e[13] + 0.35 * s, e[14], 0.45 + 0.9 * air, 0.9 + 1.2 * air, c[0], c[1], c[2], 0.28 + 0.45 * air, 1, 0.8);
        }
        break;
      }
      default:
        break;
    }
  }

  /** World-space status dressing: flames licking up (Burn), a frost plate (Chill), crackling arcs (Shock). */
  private statusFx(v: EnemyView, time: number, decals: DecalBatch, fx: BillboardBatch): void {
    const f = v.flags;
    if ((f & ANY_STATUS) === 0) return;
    const s = v.baseScale;
    const base = v.lift;
    if (f & EF.BURN) {
      const c = STATUS_COLORS.burn;
      for (let k = 0; k < STATUS_VIS.FLAMES; k++) {
        const a = v.seed * 6.283 + k * 2.094 + time * 0.7;
        const flick = 0.85 + 0.3 * hash1(Math.floor(time * 9 + k * 3) + v.seed * 17);
        const h = (0.62 + 0.2 * k) * s * flick;
        fx.push(SPRITE.FLAME, v.x + Math.sin(a) * v.radius * 0.7, base + v.height * (0.16 + 0.17 * k) + h * 0.4, v.z + Math.cos(a) * v.radius * 0.7,
          h * 0.62, h, c.r * 1.9, c.g * 1.9, c.b * 1.9, 0.95, 0.8, v.seed + k * 0.37);
      }
      decals.push(DECAL.DISC, v.x, 0.032, v.z, 0, v.radius * 5, v.radius * 5, c.r, c.g * 0.8, c.b, 0.26 + 0.06 * Math.sin(time * 13 + v.seed * 5), 1, 0);
    }
    if (f & EF.CHILL) {
      const c = STATUS_COLORS.chill;
      decals.push(DECAL.FROST, v.x, 0.034, v.z, v.seed * 6.283, v.radius * 4.4, v.radius * 4.4, c.r * 1.2, c.g * 1.2, c.b * 1.2, 0.8, 0.35, 0.35);
      fx.push(SPRITE.GLOW, v.x, base + v.height * 0.5, v.z, v.height * 1.25, v.height * 1.25, 0.6, 0.9, 1, 0.16, 0.6, 0);
    }
    if (f & EF.SHOCK) {
      const c = STATUS_COLORS.shock;
      const tick = Math.floor(time * STATUS_VIS.FLICKER_HZ);
      for (let k = 0; k < STATUS_VIS.ARCS; k++) {
        const r = hash1(tick + k * 7.3 + v.seed * 11);
        if (r < 0.3) continue;
        const a = hash1(tick * 1.7 + k * 3.1 + v.seed) * 6.283;
        const len = v.height * (0.55 + 0.4 * r);
        fx.push(SPRITE.ARC, v.x + Math.sin(a) * v.radius * 0.5, base + v.height * (0.3 + 0.4 * hash1(tick + k)), v.z + Math.cos(a) * v.radius * 0.5,
          len * 0.5, len, c.r * 2.4 + 0.5, c.g * 2.4 + 0.5, c.b * 2.4 + 0.5, 1, 1, r * 37 + tick, (hash1(tick + k * 5.5) - 0.5) * 2.4);
      }
      decals.push(DECAL.DISC, v.x, 0.033, v.z, 0, v.radius * 4.6, v.radius * 4.6, c.r, c.g, c.b, 0.12 + 0.2 * hash1(tick + v.seed), 1, 0);
    }
    if (f & EF.WITHER) {
      // a pool of shadow with a pale rim, and wisps of the victim's strength sinking out of it
      const c = STATUS_COLORS.wither;
      decals.push(DECAL.SMOKE, v.x, 0.031, v.z, v.seed * 6.283 + time * 0.3, v.radius * 5.2, v.radius * 5.2, UMBRA_CORE[0], UMBRA_CORE[1], UMBRA_CORE[2], 0.92, 0, 0.9,
        c.r * 0.9, c.g * 0.9, c.b * 0.9);
      for (let k = 0; k < STATUS_VIS.WISPS; k++) {
        const ph = (time * 0.55 + k / STATUS_VIS.WISPS + v.seed) % 1;
        const a = v.seed * 6.283 + k * 2.094 + Math.sin(time * 1.3 + k) * 0.5;
        const d = v.radius * (0.5 + 0.9 * ph);
        fx.push(SPRITE.GLOW, v.x + Math.sin(a) * d, base + v.height * (0.85 - 0.75 * ph), v.z + Math.cos(a) * d, 0.5 * s * (1 - ph * 0.5), 0.9 * s * (1 - ph * 0.5),
          c.r * 1.5, c.g * 1.5, c.b * 1.5, 0.75 * Math.sin(ph * Math.PI), 1, 0.8);
      }
      fx.push(SPRITE.GLOW, v.x, base + v.height * 0.55, v.z, v.height * 0.9, v.height * 1.1, UMBRA_CORE[0], UMBRA_CORE[1], UMBRA_CORE[2], 0.4, 0, 0);
    }
  }

  /** Elite affixes: each trait has its own silhouette of light around the body, readable without the icon. */
  private affixFx(v: EnemyView, time: number, decals: DecalBatch, fx: BillboardBatch): void {
    const c = rgb(AFFIX_COLOR[v.affix as AffixId]);
    const s = v.baseScale;
    const mid = v.lift + v.height * 0.5;
    switch (v.affix) {
      case 'swift': {
        // wind: streaks trailing behind the direction it faces and a fast thin ring
        const sin = Math.sin(v.root.rotation.y);
        const cos = Math.cos(v.root.rotation.y);
        for (let k = 0; k < AFFIX_VIS.SWIFT_TRAILS; k++) {
          const side = (k - 1) * 0.42 * s;
          const flick = 0.6 + 0.4 * Math.sin(time * 16 + k * 2.1 + v.seed * 9);
          const len = (1.5 + 0.5 * k) * s * (0.6 + Math.min(1, v.speed * 0.2));
          decals.push(DECAL.STREAK, v.x - sin * len * 0.55 + cos * side, v.lift + 0.3 + 0.45 * k * s, v.z - cos * len * 0.55 - sin * side, v.root.rotation.y,
            0.22 * s, len, c[0] * 1.5, c[1] * 1.5, c[2] * 1.5, 0.6 * flick, 1);
        }
        decals.push(DECAL.PROGRESS, v.x, 0.046, v.z, time * 7, v.radius * 3.6, v.radius * 3.6, c[0] * 1.4, c[1] * 1.4, c[2] * 1.4, 0.8, 0.6, 0.16);
        decals.push(DECAL.PROGRESS, v.x, 0.046, v.z, time * 7 + Math.PI, v.radius * 3.6, v.radius * 3.6, c[0] * 1.4, c[1] * 1.4, c[2] * 1.4, 0.8, 0.6, 0.16);
        break;
      }
      case 'armored': {
        if (v.guardBroken) break;
        // plating: steel shards slowly circling the torso and a heavy segmented ring
        for (let k = 0; k < AFFIX_VIS.ARMOR_PLATES; k++) {
          const a = time * 1.1 + (k / AFFIX_VIS.ARMOR_PLATES) * Math.PI * 2 + v.seed * 6;
          fx.push(SPRITE.SHARD, v.x + Math.sin(a) * v.radius * 1.5, mid + 0.12 * Math.sin(time * 2 + k), v.z + Math.cos(a) * v.radius * 1.5, 0.5 * s, 0.72 * s,
            c[0] * 1.2, c[1] * 1.2, c[2] * 1.2, 0.95, 0.15, 1);
        }
        for (let k = 0; k < 3; k++) {
          decals.push(DECAL.PROGRESS, v.x, 0.047, v.z, -time * 0.6 + k * 2.094, v.radius * 4.4, v.radius * 4.4, c[0] * 1.3, c[1] * 1.3, c[2] * 1.3, 0.95, 0.25, 0.24);
        }
        break;
      }
      case 'volatile': {
        // a lit fuse: an unstable core in the chest that beats faster and a flickering ground glow
        const beat = Math.pow(0.5 + 0.5 * Math.sin(time * 9 + v.seed * 4), 3);
        fx.push(SPRITE.GLOW, v.x, mid + 0.1 * s, v.z, (0.9 + 0.7 * beat) * s, (0.9 + 0.7 * beat) * s, c[0] * 2, c[1] * 1.7, c[2] * 1.2, 0.85, 1, 1.6);
        fx.push(SPRITE.SPARK, v.x, mid + 0.1 * s, v.z, 0.34 * s, 0.34 * s, 2.4, 2.2, 1.6, 0.9, 1, 0, time * 5);
        decals.push(DECAL.CRACKLE, v.x, 0.046, v.z, time, v.radius * 4.6, v.radius * 4.6, c[0] * 1.5, c[1] * 1.3, c[2], 0.5 + 0.4 * beat, 1, 0.35, 1);
        break;
      }
      case 'vampiric': {
        // blood drawn inwards: motes spiralling into the body over a dark crimson pool
        for (let k = 0; k < AFFIX_VIS.VAMP_MOTES; k++) {
          const ph = (time * 0.7 + k / AFFIX_VIS.VAMP_MOTES + v.seed) % 1;
          const a = k * 1.571 + ph * 3.2 + v.seed * 6;
          const d = v.radius * (2.6 - 2.2 * ph);
          fx.push(SPRITE.GLOW, v.x + Math.sin(a) * d, v.lift + 0.25 + ph * v.height * 0.55, v.z + Math.cos(a) * d, 0.42 * (1.2 - ph), 0.42 * (1.2 - ph),
            c[0] * 2, c[1] * 2, c[2] * 2, 0.9 * Math.min(1, ph * 5), 1, 1.2);
        }
        decals.push(DECAL.SMOKE, v.x, 0.036, v.z, time * 0.4, v.radius * 5, v.radius * 5, c[0] * 0.35, c[1] * 0.35, c[2] * 0.35, 0.75, 0.1, 0.9, c[0], c[1], c[2]);
        break;
      }
    }
  }

  /** Death Mark: a reticle on the floor that tightens as the mark runs out and the mark icon over the head. */
  private markFx(v: EnemyView, time: number, decals: DecalBatch, ui: BillboardBatch): void {
    const c = rgb(PALETTE.mark);
    const k = v.markLeft / v.markTotal;
    const blink = v.markLeft < 1.5 ? 0.6 + 0.4 * Math.sin(time * 14) : 1;
    const d = v.radius * 2 * AFFIX_VIS.MARK_RING;
    decals.push(DECAL.ZONE, v.x, 0.05, v.z, 0, d * 1.6, d * 1.6, c[0] * 1.5, c[1] * 1.5, c[2] * 1.5, 0.9 * blink, 0.5, 0);
    decals.push(DECAL.PROGRESS, v.x, 0.052, v.z, 0, d * 1.25, d * 1.25, c[0] * 1.8, c[1] * 1.8, c[2] * 1.8, blink, 0.6, k);
    const uv = this.atlas.icons.mark;
    const bob = Math.sin(time * 3 + v.seed * 6) * 0.07;
    const y = v.lift + v.height + 0.95 + bob;
    ui.push(SPRITE.GLOW, v.x, y, v.z, 1.1, 1.1, 0.04, 0.01, 0.08, 0.8 * blink);
    ui.push(SPRITE.ATLAS, v.x, y, v.z, 0.62, 0.62, c[0] * 1.2, c[1] * 1.2, c[2] * 1.2, blink, 0, 0, 0, 0, 0, uv[0], uv[1], uv[2], uv[3]);
  }

  /** The Matron's channel: light gathers at the raised staff and a pillar burns over her while the rays turn. */
  private channel(v: EnemyView, time: number, decals: DecalBatch, fx: BillboardBatch): void {
    const t = time - v.specialAt;
    const a = rgb(PALETTE.hexViolet);
    const b = rgb(PALETTE.hexGreen);
    const charge = Math.min(1, t / Math.max(0.1, v.specialDur));
    const pulse = 0.8 + 0.2 * Math.sin(time * 19);
    const e = v.hand ? v.hand.matrixWorld.elements : null;
    const hx = e ? e[12] : v.x;
    const hy = e ? e[13] + 0.5 * v.baseScale : v.lift + v.height * 0.8;
    const hz = e ? e[14] : v.z;
    fx.push(SPRITE.GLOW, hx, hy, hz, 1.2 + charge * 2.6, 1.2 + charge * 2.6, b[0] * 1.8, b[1] * 1.8, b[2] * 1.8, (0.45 + 0.5 * charge) * pulse, 1, 1.4);
    fx.push(SPRITE.GLOW, v.x, v.lift + v.height * 1.5, v.z, 1.5 * charge, v.height * 3.2, a[0] * 1.5, a[1] * 1.5, a[2] * 1.5, 0.4 * charge * pulse, 1, 0.5);
    decals.push(DECAL.RUNE, v.x, 0.05, v.z, time * 1.6, v.radius * 9 * charge, v.radius * 9 * charge, b[0] * 1.5, b[1] * 1.5, b[2] * 1.5, 0.7 * charge, 0.8, charge);
  }

  private pip(ui: BillboardBatch, v: EnemyView, top: number, name: IconName, hex: number, size: number, ox: number, iconHex: number = PALETTE.white): void {
    const uv = this.atlas.icons[name];
    const c = rgb(hex);
    const ic = rgb(iconHex);
    ui.push(SPRITE.PIP, v.x, top, v.z, size * 0.92, size * 0.92, c[0], c[1], c[2], 1, 0, 0, 0, ox, 0.4);
    ui.push(SPRITE.ATLAS, v.x, top, v.z, size * 0.66, size * 0.66, ic[0], ic[1], ic[2], 1, 0, 0, 0, ox, 0.4, uv[0], uv[1], uv[2], uv[3]);
  }

  private icon(ui: BillboardBatch, v: EnemyView, top: number, name: IconName, hex: number, size: number, ox: number): void {
    const uv = this.atlas.icons[name];
    _color.setHex(hex);
    ui.push(SPRITE.ATLAS, v.x, top, v.z, size, size, _color.r, _color.g, _color.b, 1, 0, 0, 0, ox, 0.4, uv[0], uv[1], uv[2], uv[3]);
  }

  forEachActive(fn: (v: EnemyView) => void): void {
    for (const v of this.active) fn(v);
  }

  forEachView(fn: (v: EnemyView) => void): void {
    for (const v of this.active) fn(v);
    for (const v of this.dying) fn(v);
  }

  /** Releases every view and frees the per-instance GPU resources (materials, bone textures). */
  clear(): void {
    for (const v of this.active) v.dispose();
    for (const v of this.dying) v.dispose();
    for (const kind of Object.keys(this.pool) as EnemyKind[]) {
      for (const v of this.pool[kind]) v.dispose();
      this.pool[kind].length = 0;
    }
    this.active.length = 0;
    this.dying.length = 0;
    this.byId.clear();
    this.killed.clear();
    this.affixes.clear();
    this.wards.clear();
    this.masters.clear();
    for (const r of this.raises) { r.id = -1; r.until = -1; r.left = 0; }
    this.huntCount = 0;
    this.huntEnraged = false;
    this.domeCount = 0;
  }
}

export type { EnemyView, HeroView };
