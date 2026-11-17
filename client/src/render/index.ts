/**
 * Render kit entry point. The gameplay integrator talks to this module only:
 *   const assets = await loadAssets(onProgress);
 *   const view = new WorldView(canvas, assets);
 *   per frame: syncPlayers / syncEnemies / syncProjectiles (already interpolated rows), then update(dt).
 * The kit never touches the EventBus or GameState; it is driven purely by these calls.
 */
import {
  ACESFilmicToneMapping, Color, Fog, Frustum, HalfFloatType, Matrix4, PCFShadowMap, PerspectiveCamera, Scene, Sphere,
  Vector2, Vector3, WebGLRenderTarget, WebGLRenderer,
} from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { EF, PF } from '@shared/types.ts';
import type {
  ClassId, Door, ElementId, EnemyKind, EnemySnap, GameEvent, Look, PlayerSnap, ProjectileSnap, RoomLayout,
} from '@shared/types.ts';
import type { ChamberKind } from '@shared/constants.ts';
import { CLASSES } from '@shared/data/classes.ts';
import type { AbilityDef } from '@shared/data/classes.ts';
import type { Quality } from '../core/Settings.ts';
import { loadAssets } from './assets.ts';
import type { Assets } from './assets.ts';
import { Atlas } from './atlas.ts';
import { BillboardBatch, DECAL, DecalBatch, SPRITE } from './batches.ts';
import { Enemies, HeroPreview, Heroes } from './characters.ts';
import type { EnemyView, HeroView, Infusions } from './characters.ts';
import { BLOOM, BOSS_AURA, CAMERA, ELEMENT_COLOR, HERO_VIS, LIMITS, PALETTE, QUALITY, SLOT_COLORS, enemyDef, isBigEnemy } from './config.ts';
import type { QualityProfile } from './config.ts';
import { Doors } from './doors.ts';
import { Hazards } from './hazards.ts';
import { LevelView } from './level.ts';
import { Projectiles } from './projectiles.ts';
import { Vfx, rgb } from './vfx.ts';
import type { FollowSource } from './vfx.ts';

export { loadAssets };
export type { Assets };

export interface RenderStats { drawCalls: number; triangles: number; geometries: number; textures: number }
export interface RosterView { slot: number; cls: ClassId; name: string; look?: Look }
/** Hero presented on the wardrobe diorama; `screenX` (0..1 of the canvas width) is where it is centred. */
export interface ShowcaseView { cls: ClassId; look: Look; screenX: number }
export interface MarkerView { x: number; z: number; r: number }
export type { Infusions };

interface AbilityInfo { def: AbilityDef; cls: ClassId; index: number }

const ABILITIES = new Map<string, AbilityInfo>();
for (const cls of Object.values(CLASSES)) {
  cls.primary.forEach((def, index) => ABILITIES.set(def.id, { def, cls: cls.id, index }));
  ABILITIES.set(cls.secondary.id, { def: cls.secondary, cls: cls.id, index: 0 });
}

const VIEW = {
  EXPOSURE: 1.12,
  ZOOM_MIN: 0.6,
  ZOOM_MAX: 1.6,
  NORTH_MARGIN: 5.5,
  CULL_RADIUS: 2.6,
  DUST_RATE: 7,
  EMBER_RATE: 6,
  SPARKLE_RATE: 4,
  STATUS_RATE: 5,
  SWING_COLOR: { knight: 0xdce8ff, barbarian: 0xffcf9a, mage: PALETTE.arcane, rogue: 0xe9ffe0 } as Record<ClassId, number>,
  BONE: 0xe8dcc0,
  DUST: 0x4f4a44,
  /** Seconds after a cast during which its hits may still re-colour the swing arc. */
  CAST_TINT_WINDOW: 0.5,
  MIST_RATE: 5,
  FORGE_EMBER_RATE: 16,
  HAZE_RATE: 2.2,
  RIPPLE_RATE: 3.2,
} as const;

/** Wardrobe diorama camera: the hero fills HERO_FRACTION of the screen height. */
const STAGE = {
  HERO_FRACTION: 0.55,
  PITCH_DEG: 7,
  LOOK_Y: 1.42,
  INTRO_TIME: 1.5,
  INTRO_PULL: 0.55,
  INTRO_RISE: 1.4,
  SWAY: 0.12,
  SLIDE_RATE: 5,
  FOG_NEAR: 9,
  FOG_FAR: 34,
} as const;

const DEG = Math.PI / 180;
const _v = new Vector3();
const _dir = new Vector3();
const _pm = new Matrix4();
const _frustum = new Frustum();
const _sphere = new Sphere();
const _sample = { x: 0, y: 0, z: 0, r: 0, g: 0, b: 0 };

export class WorldView implements FollowSource {
  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly uiScene = new Scene();
  private readonly camera: PerspectiveCamera;
  private readonly atlas: Atlas;
  private readonly level: LevelView;
  private readonly heroes: Heroes;
  private readonly enemies: Enemies;
  private readonly projectiles: Projectiles;
  private readonly doors: Doors;
  private readonly hazards: Hazards;
  private readonly preview: HeroPreview;
  private readonly assets: Assets;
  private readonly vfx: Vfx;
  private readonly decals: DecalBatch;
  private readonly fx: BillboardBatch;
  private readonly ui: BillboardBatch;
  private readonly fog: Fog;
  private composer: EffectComposer | null = null;
  private bloomTarget: WebGLRenderTarget | null = null;

  private quality: Quality = 'high';
  private profile: QualityProfile = QUALITY.high;
  private shakeScale = 1;
  private zoom = 1;
  private trauma = 0;
  private time = 0;
  private dt = 0;
  private localSlot = -1;
  private readonly target = new Vector3();
  private readonly shakeOffset = new Vector3();
  private snapCamera = true;
  private dustAcc = 0;
  private emberAcc = 0;
  private sparkleAcc = 0;
  private bossX = 0;
  private bossZ = 0;
  private bossSeen = false;
  private disposed = false;
  private focus: { x: number; z: number; zoom: number } | null = null;
  private serverTick = 0;
  private marker: MarkerView | null = null;
  private hasRoom = false;
  private showcase: ShowcaseView | null = null;
  private stageTime = 0;
  private stageX = 0.5;
  private appliedOffset = 0;
  private bossKind: EnemyKind = 'regent';
  private mistAcc = 0;
  private hazeAcc = 0;
  private readonly castAt: number[] = [-10, -10, -10, -10];
  private readonly castTinted: boolean[] = [false, false, false, false];
  private readonly stats: RenderStats = { drawCalls: 0, triangles: 0, geometries: 0, textures: 0 };

  private readonly cullHero = (v: HeroView): void => {
    _sphere.center.set(v.x, 1, v.z);
    _sphere.radius = VIEW.CULL_RADIUS;
    v.root.visible = _frustum.intersectsSphere(_sphere);
  };

  private readonly perEnemy = (v: EnemyView): void => {
    _sphere.center.set(v.x, v.baseScale, v.z);
    _sphere.radius = VIEW.CULL_RADIUS * v.baseScale;
    v.root.visible = _frustum.intersectsSphere(_sphere);
    if (v.dying) return;
    const boss = isBigEnemy(v.kind);
    if (boss && (v.kind !== 'champion' || !this.bossSeen)) {
      this.bossX = v.x; this.bossZ = v.z; this.bossSeen = true; this.bossKind = v.kind;
    }
    if (v.landed) {
      v.landed = false;
      this.vfx.puff(v.x, 0.25, v.z, VIEW.DUST, 10, v.radius * 1.6, 0.4);
      this.vfx.ring(v.x, v.z, v.radius * 2, v.radius * 7, 0.4, BOSS_AURA[v.kind]?.[0] ?? PALETTE.hostile, 0.4, 1.6);
      this.shake(0.3);
    }
    if (!v.root.visible) return;
    const f = v.flags;
    const p = VIEW.STATUS_RATE * this.dt * this.vfx.density;
    // Burn: embers streaming up. Chill: slow crystals sinking around the body. Shock: violet sparks spat sideways.
    if (f & EF.BURN && Math.random() < p * 1.6) this.vfx.motes(v.x, v.lift + v.height * 0.5, v.z, ELEMENT_COLOR.ember, 1, v.radius, 3, 0.55);
    if (f & EF.CHILL && Math.random() < p * 1.4) this.vfx.frost(v.x, v.lift + v.height * 0.7, v.z, ELEMENT_COLOR.rime, 1, v.radius * 1.3);
    if (f & EF.SHOCK && Math.random() < p) this.vfx.sparks(v.x, v.lift + v.height * 0.6, v.z, ELEMENT_COLOR.storm, 1, 3.5);
    if (boss) {
      const aura = BOSS_AURA[v.kind];
      if (aura && Math.random() < p * 3) this.vfx.motes(v.x, 0.3, v.z, aura[v.kind === 'matron' && Math.random() < 0.5 ? 1 : 0], 1, v.radius * 1.6, 2.6, 1.1);
      if (v.airborne && Math.random() < p * 8) this.vfx.motes(v.x, v.lift + v.height * 0.3, v.z, PALETTE.sickly, 1, v.radius, -1, 0.5);
    }
  };

  constructor(canvas: HTMLCanvasElement, assets: Assets) {
    this.canvas = canvas;
    this.assets = assets;
    this.renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = VIEW.EXPOSURE;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFShadowMap;
    this.renderer.info.autoReset = false;
    this.renderer.autoClear = false;

    this.scene.background = new Color(PALETTE.background);
    this.fog = new Fog(PALETTE.fog, 30, 80);
    this.scene.fog = this.fog;
    this.camera = new PerspectiveCamera(CAMERA.FOV, 16 / 9, CAMERA.NEAR, CAMERA.FAR);

    this.atlas = new Atlas();
    this.level = new LevelView(assets);
    this.scene.add(this.level.group, this.level.lights);
    this.decals = new DecalBatch(LIMITS.DECALS);
    this.fx = new BillboardBatch(LIMITS.FX_BILLBOARDS, this.atlas.texture, { depthTest: true, toneMapped: true, renderOrder: 3 });
    this.ui = new BillboardBatch(LIMITS.UI_BILLBOARDS, this.atlas.texture, { depthTest: false, toneMapped: false, renderOrder: 4 });
    this.scene.add(this.decals.mesh, this.fx.mesh);
    this.uiScene.add(this.ui.mesh);

    this.heroes = new Heroes(this.scene, assets, this.atlas);
    this.enemies = new Enemies(this.scene, assets, this.atlas);
    this.projectiles = new Projectiles(this.scene, assets);
    this.doors = new Doors(this.scene, assets, this.atlas, this.level.stoneUv);
    this.hazards = new Hazards(this.scene, assets, this.level.stoneUv);
    this.preview = new HeroPreview(this.scene, assets);
    this.vfx = new Vfx(this.atlas);
    this.enemies.prewarm();

    this.setQuality('high');
    this.resize();
  }

  // ------------------------------------------------------------------ settings

  setQuality(q: Quality): void {
    this.quality = q;
    this.profile = QUALITY[q];
    this.level.applyQuality(this.profile);
    this.vfx.density = this.profile.particles;
    if (!this.profile.bloom) this.disposeComposer();
    this.resize();
  }

  setShake(scale: number): void {
    this.shakeScale = Math.max(0, Math.min(1.5, scale));
  }

  setZoom(mult: number): void {
    this.zoom = Math.max(VIEW.ZOOM_MIN, Math.min(VIEW.ZOOM_MAX, mult));
    this.updateFog();
  }

  setDamageNumbers(on: boolean): void {
    this.vfx.numbersEnabled = on;
  }

  resize(): void {
    const w = Math.max(1, this.canvas.clientWidth || window.innerWidth);
    const h = Math.max(1, this.canvas.clientHeight || window.innerHeight);
    const ratio = Math.min(window.devicePixelRatio || 1, this.profile.pixelRatio);
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.appliedOffset = 0;
    this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
    if (this.profile.bloom) {
      if (!this.composer) this.createComposer();
      this.composer?.setPixelRatio(ratio);
      this.composer?.setSize(w, h);
    }
  }

  private createComposer(): void {
    this.bloomTarget = new WebGLRenderTarget(1, 1, { type: HalfFloatType, samples: 4 });
    const composer = new EffectComposer(this.renderer, this.bloomTarget);
    composer.addPass(new RenderPass(this.scene, this.camera));
    composer.addPass(new UnrealBloomPass(new Vector2(256, 256), BLOOM.STRENGTH, BLOOM.RADIUS, BLOOM.THRESHOLD));
    composer.addPass(new OutputPass());
    this.composer = composer;
  }

  private disposeComposer(): void {
    if (!this.composer) return;
    for (const pass of this.composer.passes) pass.dispose();
    this.composer.dispose();
    this.bloomTarget?.dispose();
    this.composer = null;
    this.bloomTarget = null;
  }

  private updateFog(): void {
    const d = CAMERA.DISTANCE * this.zoom;
    this.fog.color.copy(this.level.fogColor);
    if (this.level.diorama) {
      this.fog.near = STAGE.FOG_NEAR;
      this.fog.far = STAGE.FOG_FAR;
      return;
    }
    this.fog.near = d * 1.25;
    this.fog.far = d * 3.6;
  }

  // ------------------------------------------------------------------ world state

  setRoom(room: RoomLayout | null, chamberKind: ChamberKind, chamberIndex: number): void {
    this.hasRoom = room !== null;
    if (!room && this.showcase) {
      // menu / lobby with a wardrobe request: the diorama stands in for the chamber
      this.hazards.clear();
      this.applyShowcase();
      return;
    }
    if (room) this.endShowcase();
    if (!this.level.setRoom(room, chamberKind, chamberIndex)) return;
    this.hazards.set(room ? room.hazards : null);
    this.level.applyQuality(this.profile);
    this.updateFog();
    this.vfx.clear();
    this.doors.clear();
    this.snapCamera = true;
    this.bossSeen = false;
  }

  /**
   * Wardrobe / class picker: presents `view.cls` in `view.look` on a lit pedestal while no chamber is set, centred
   * at `view.screenX`. Calling it again with another look updates the hero in place (the camera move is not
   * restarted); null removes it. It is ignored (but remembered) while a chamber is shown and costs nothing then.
   */
  setShowcase(view: ShowcaseView | null): void {
    this.showcase = view ? { cls: view.cls, look: { ...view.look }, screenX: Math.max(0, Math.min(1, view.screenX)) } : null;
    if (this.hasRoom) return;
    if (this.showcase) this.applyShowcase();
    else if (this.level.diorama) {
      this.endShowcase();
      this.updateFog();
    }
  }

  private applyShowcase(): void {
    const want = this.showcase;
    if (!want) return;
    if (this.level.setDiorama(true)) {
      this.level.applyQuality(this.profile);
      this.updateFog();
      this.vfx.clear();
      this.doors.clear();
      this.stageTime = 0;
      this.stageX = want.screenX;
      this.snapCamera = true;
    }
    const y = this.level.pedestalY;
    this.preview.y = y;
    const before = this.preview.cls;
    if (this.preview.set(want.cls, want.look) && before !== null) {
      // a new outfit shimmers in; a new class also kicks up the pedestal's glimmer
      this.vfx.motes(0, y + 0.2, 0, PALETTE.glimmer, before === want.cls ? 8 : 18, 0.7, 2.6, 0.8);
      if (before !== want.cls) this.vfx.ring(0, 0, 1.4, 5, 0.5, PALETTE.glimmer, 0.3, 1.4);
    }
  }

  private endShowcase(): void {
    this.preview.clear();
    if (this.level.setDiorama(false)) this.vfx.clear();
    if (this.appliedOffset !== 0) {
      this.appliedOffset = 0;
      this.camera.clearViewOffset();
      this.camera.updateProjectionMatrix();
    }
  }

  /** Interpolated (fractional) server tick of the frame being drawn: hazards animate from it. Call every frame. */
  setServerTick(tick: number): void {
    if (Number.isFinite(tick)) this.serverTick = tick;
  }

  /** Which abilities of a hero carry an element (from the roster's infusion boons). Call when the roster changes. */
  setInfusions(slot: number, infusions: Infusions): void {
    this.heroes.setInfusions(slot, infusions);
  }

  /** Tutorial waypoint: a friendly teal / gold ring with a bobbing arrow. null removes it. */
  setMarker(marker: MarkerView | null): void {
    this.marker = marker ? { x: marker.x, z: marker.z, r: marker.r } : null;
  }

  setDoors(doors: Door[], progress: number[]): void {
    if (doors.length === 0) { this.doors.clear(); return; }
    this.doors.set(doors, progress, this.level.depth);
  }

  setRoster(entries: RosterView[]): void {
    this.heroes.setRoster(entries);
  }

  syncPlayers(players: PlayerSnap[], localSlot: number): void {
    this.localSlot = localSlot;
    this.heroes.sync(players, localSlot);
  }

  syncEnemies(enemies: EnemySnap[]): void {
    this.enemies.sync(enemies);
  }

  syncProjectiles(projectiles: ProjectileSnap[]): void {
    this.projectiles.sync(projectiles, this.vfx);
  }

  /** FollowSource: lets timed effects stick to a hero. */
  position(slot: number, out: { x: number; z: number; rot: number }): boolean {
    const hero = this.heroes.get(slot);
    if (!hero) return false;
    out.x = hero.x; out.z = hero.z; out.rot = hero.rot;
    return true;
  }

  /** Instant feedback for the own hero's inputs (before the server confirms). */
  localAction(action: 'primary' | 'secondary' | 'dash'): void {
    const hero = this.heroes.get(this.localSlot);
    if (!hero) return;
    this.heroes.nudge(this.localSlot, action === 'dash' ? -0.16 : action === 'secondary' ? 0.1 : 0.06);
    if (action === 'dash') this.vfx.puff(hero.x, 0.25, hero.z, VIEW.DUST, 5, 0.5, 0.35);
  }

  screenToGround(clientX: number, clientY: number, out: { x: number; z: number }): boolean {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const nx = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ny = -(((clientY - rect.top) / rect.height) * 2 - 1);
    _v.set(nx, ny, 0.5).unproject(this.camera);
    _dir.copy(_v).sub(this.camera.position).normalize();
    if (_dir.y > -1e-4) return false;
    const t = -this.camera.position.y / _dir.y;
    out.x = this.camera.position.x + _dir.x * t;
    out.z = this.camera.position.z + _dir.z * t;
    return true;
  }

  // ------------------------------------------------------------------ events

  private shake(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount * this.shakeScale);
  }

  private elementColor(el: ElementId | null, fallback: number): number {
    return el ? ELEMENT_COLOR[el] : fallback;
  }

  handleEvent(ev: GameEvent): void {
    const vfx = this.vfx;
    switch (ev.e) {
      case 'hit': {
        const hex = this.elementColor(ev.el, PALETTE.physical);
        if (ev.target.t === 'e') {
          const v = this.enemies.get(ev.target.id);
          const y = v ? v.height * 0.55 : 1.1;
          if (ev.el) {
            const c = rgb(hex);
            this.enemies.hit(ev.target.id, Math.min(1, c[0] * 1.6 + 0.3), Math.min(1, c[1] * 1.6 + 0.3), Math.min(1, c[2] * 1.6 + 0.3));
          } else this.enemies.hit(ev.target.id, 1, 1, 1);
          vfx.sparks(ev.x, y, ev.z, hex, ev.crit ? 12 : 6, ev.crit ? 9 : 6.5);
          vfx.flash(ev.x, y, ev.z, hex, ev.crit ? 2.6 : 1.6, 0.12);
          if (ev.el) {
            this.elementBurst(ev.el, ev.x, y, ev.z, 0.45, ev.crit ? 0.5 : 0.25);
            // the swing that caused it takes the element's colour (the cast event itself does not carry it)
            if (ev.by >= 0 && ev.by < this.castAt.length && !this.castTinted[ev.by] && this.time - this.castAt[ev.by] < VIEW.CAST_TINT_WINDOW) {
              this.castTinted[ev.by] = true;
              vfx.tintSlashes(ev.by, hex);
            }
          }
          vfx.number(ev.x, (v ? v.height : 2) + 0.5, ev.z, ev.dmg, ev.crit ? PALETTE.crit : ev.el ? hex : PALETTE.white, ev.crit ? 1.5 : 1, ev.crit ? 2 : 0);
          if (ev.by === this.localSlot) this.shake(ev.crit ? 0.14 : 0.04);
        } else {
          this.heroes.hit(ev.target.id);
          vfx.sparks(ev.x, 1.2, ev.z, PALETTE.hostile, 7, 6);
          vfx.flash(ev.x, 1.2, ev.z, PALETTE.hostile, 2, 0.14);
          vfx.number(ev.x, 2.5, ev.z, ev.dmg, PALETTE.hostile, 0.95, 0);
          if (ev.target.id === this.localSlot) this.shake(0.32);
        }
        break;
      }
      case 'kill': {
        const big = isBigEnemy(ev.kind);
        const s = enemyDef(ev.kind).scale;
        this.enemies.kill(ev.id);
        vfx.sparks(ev.x, s, ev.z, VIEW.BONE, big ? 30 : 9, big ? 11 : 6);
        vfx.motes(ev.x, 0.6 * s, ev.z, PALETTE.glimmer, big ? 40 : 7, 0.5 * s, 2.4, big ? 1.8 : 1);
        vfx.puff(ev.x, 0.3, ev.z, VIEW.DUST, big ? 12 : 3, 0.6 * s, 0.3);
        vfx.ring(ev.x, ev.z, 0.4, big ? 16 : 2.6, big ? 0.8 : 0.35, PALETTE.glimmer, 0.3, big ? 2 : 1.1);
        if (big) {
          // death sequence: the boss's own colours tear outwards in three beats before the soul-light is released
          const aura = BOSS_AURA[ev.kind] ?? [PALETTE.hostile, PALETTE.ember];
          vfx.flash(ev.x, s, ev.z, PALETTE.glimmer, 12, 0.6, 2);
          vfx.groundFlash(ev.x, ev.z, 18, 0.9, PALETTE.glimmer, 1.2);
          vfx.duoRing(ev.x, ev.z, 1, 20, 0.9, aura[0], aura[1], 0.5, 2.2);
          vfx.duoRing(ev.x, ev.z, 1, 26, 1.2, aura[1], aura[0], 0.3, 1.8, 0.35);
          vfx.ring(ev.x, ev.z, 1, 30, 1.4, PALETTE.glimmer, 0.25, 1.6, 0.8);
          vfx.sparks(ev.x, s * 1.2, ev.z, aura[0], 26, 13);
          vfx.sparks(ev.x, s * 0.8, ev.z, aura[1], 20, 10);
          vfx.motes(ev.x, 0.4, ev.z, aura[1], 30, 1.4 * s, 3.2, 2.2);
          if (ev.kind === 'matron') vfx.arcs(ev.x, s, ev.z, aura[1], 8, 4);
          this.shake(0.7);
        } else if (ev.by === this.localSlot) this.shake(0.06);
        break;
      }
      case 'resonance': {
        // The signature effect: both elements are visible in every layer of it.
        const a = ELEMENT_COLOR[ev.a];
        const b = ELEMENT_COLOR[ev.b];
        const d = ev.r * 2;
        vfx.flash(ev.x, 1.1, ev.z, PALETTE.white, ev.r * 1.5, 0.1, 2.4);
        vfx.duoRing(ev.x, ev.z, d * 0.15, d * 1.06, 0.5, a, b, 0.6, 2.4);
        vfx.duoRing(ev.x, ev.z, d * 0.1, d * 1.32, 0.85, b, a, 0.2, 1.7, 0.1);
        vfx.groundFlash(ev.x, ev.z, d * 1.2, 0.55, a, 1.1);
        vfx.groundFlash(ev.x, ev.z, d * 0.75, 0.75, b, 1.5, 0.06);
        vfx.flash(ev.x, 1.0, ev.z, a, ev.r * 2.5, 0.3, 1.7);
        vfx.flash(ev.x, 1.7, ev.z, b, ev.r * 1.7, 0.45, 1.9);
        vfx.sparks(ev.x, 1, ev.z, a, 16, 12);
        vfx.sparks(ev.x, 1.2, ev.z, b, 16, 14);
        this.elementBurst(ev.a, ev.x, 0.4, ev.z, ev.r * 0.55, 1);
        this.elementBurst(ev.b, ev.x, 0.4, ev.z, ev.r * 0.85, 1);
        vfx.motes(ev.x, 0.3, ev.z, a, 7, ev.r * 0.7, 2.6, 1);
        vfx.motes(ev.x, 0.3, ev.z, b, 7, ev.r * 0.9, 2, 1.1);
        vfx.word(ev.x, 3.2, ev.z, a, b, ev.by === this.localSlot || this.localSlot < 0 ? 1 : 0.82);
        this.shake(ev.by === this.localSlot ? 0.3 : 0.2);
        break;
      }
      case 'status': {
        const v = this.enemies.get(ev.id);
        if (!v) break;
        const hex = ELEMENT_COLOR[ev.el];
        const icon = ev.el === 'ember' ? this.atlas.icons.burn : ev.el === 'rime' ? this.atlas.icons.chill : this.atlas.icons.shock;
        vfx.iconPop(v.x, v.lift + v.height + 0.95, v.z, icon, hex, isBigEnemy(v.kind) ? 1.3 : 0.95);
        vfx.ring(v.x, v.z, 0.5, v.radius * 4.6, 0.32, hex, 0.35, 1.5);
        vfx.flash(v.x, v.lift + v.height * 0.55, v.z, hex, v.height * 1.1, 0.2, 1.3);
        this.elementBurst(ev.el, v.x, v.lift + v.height * 0.35, v.z, v.radius * 1.1, 0.6);
        break;
      }
      case 'telegraph': {
        vfx.telegraph(ev.shape, ev.x, ev.z, ev.rot, ev.r, ev.w, ev.dur);
        if (ev.src === undefined) break;
        this.enemies.telegraphed(ev.src, ev.dur);
        const src = this.enemies.get(ev.src);
        // the Matron's rays: each announced lane is burnt by a beam the moment it lands
        if (src && src.kind === 'matron' && ev.shape === 'line') vfx.beam(ev.x, ev.z, ev.rot, ev.r, ev.w, PALETTE.hexViolet, PALETTE.hexGreen, ev.dur);
        break;
      }
      case 'cast':
        this.castEffect(ev.who.t, ev.who.id, ev.ability, ev.x, ev.z, ev.rot);
        break;
      case 'aoe': {
        const hex = this.elementColor(ev.el, ev.hostile ? PALETTE.hostile : PALETTE.arcane);
        const d = ev.r * 2;
        vfx.ring(ev.x, ev.z, d * 0.35, d * 1.02, 0.4, hex, 0.5, 2);
        vfx.groundFlash(ev.x, ev.z, d * 1.1, 0.45, ev.hostile ? PALETTE.hostileHot : hex, 0.8);
        vfx.flash(ev.x, 0.8, ev.z, hex, ev.r * 1.8, 0.18, 0.8);
        vfx.sparks(ev.x, 0.4, ev.z, hex, Math.round(6 + ev.r * 4), 5 + ev.r * 1.6);
        vfx.puff(ev.x, 0.25, ev.z, VIEW.DUST, 4, ev.r * 0.8, 0.28);
        if (ev.hostile) this.shake(0.12 + ev.r * 0.03);
        break;
      }
      case 'heal': {
        const h = this.heroes.get(ev.slot);
        if (!h) break;
        vfx.number(h.x, 2.6, h.z, ev.amount, PALETTE.heal, 1, 1);
        vfx.motes(h.x, 0.2, h.z, PALETTE.heal, 12, 0.7, 2.6, 0.9);
        vfx.ring(h.x, h.z, 0.6, 3, 0.45, PALETTE.heal, 0.3, 1.3);
        break;
      }
      case 'down': {
        const h = this.heroes.get(ev.slot);
        if (!h) break;
        vfx.ring(h.x, h.z, 0.6, 5.5, 0.5, PALETTE.hostile, 0.4, 1.8);
        vfx.flash(h.x, 1, h.z, PALETTE.hostile, 4.5, 0.3, 1.6);
        vfx.puff(h.x, 0.3, h.z, 0x40343a, 6, 0.8, 0.4);
        this.shake(ev.slot === this.localSlot ? 0.6 : 0.25);
        break;
      }
      case 'revived': {
        const h = this.heroes.get(ev.slot);
        if (!h) break;
        vfx.ring(h.x, h.z, 0.6, 6, 0.6, PALETTE.glimmer, 0.4, 2);
        vfx.groundFlash(h.x, h.z, 5, 0.6, PALETTE.glimmer, 1.2);
        vfx.flash(h.x, 1.2, h.z, PALETTE.glimmer, 5, 0.4, 1.8);
        vfx.motes(h.x, 0.2, h.z, PALETTE.glimmer, 24, 0.9, 3.4, 1.1);
        break;
      }
      case 'shieldBreak': {
        const v = this.enemies.get(ev.id);
        if (!v) break;
        vfx.sparks(v.x, v.height * 0.5, v.z, PALETTE.shield, 16, 9);
        vfx.ring(v.x, v.z, 0.5, 4, 0.35, PALETTE.shield, 0.35, 1.8);
        vfx.flash(v.x, v.height * 0.5, v.z, PALETTE.shield, 3, 0.16, 1.8);
        break;
      }
      case 'spawn': {
        const def = enemyDef(ev.kind);
        const big = isBigEnemy(ev.kind);
        const hex = big ? BOSS_AURA[ev.kind]?.[0] ?? PALETTE.hostile : ev.elite ? PALETTE.hostile : PALETTE.glimmer;
        vfx.rune(ev.x, ev.z, def.radius * (big ? 4.6 : 4.2), def.spawnTime + 0.25, hex);
        vfx.puff(ev.x, 0.2, ev.z, VIEW.DUST, big ? 8 : 3, def.radius, 0.35);
        vfx.motes(ev.x, 0.1, ev.z, hex, big ? 22 : 5, def.radius * 1.2, 2.2, def.spawnTime);
        if (big) { vfx.ring(ev.x, ev.z, 1, 14, 0.9, hex, 0.4, 1.8); this.shake(0.4); }
        break;
      }
      case 'wave':
        break;
      case 'chamberClear': {
        this.heroes.forEach((h) => {
          vfx.ring(h.x, h.z, 0.6, 5, 0.6, PALETTE.glimmer, 0.35, 1.6);
          vfx.motes(h.x, 0.2, h.z, PALETTE.glimmer, 14, 0.8, 3, 1.1);
        });
        for (let i = 0; i < 12; i++) {
          if (this.level.sampleGlow(Math.random(), _sample)) vfx.motes(_sample.x, _sample.y, _sample.z, PALETTE.glimmer, 5, 0.5, 2.6, 1.2);
        }
        vfx.groundFlash(0, 0, Math.max(this.level.width, this.level.depth) * 1.1, 1.1, PALETTE.glimmer, 0.35);
        break;
      }
      case 'bossPhase': {
        const x = this.bossSeen ? this.bossX : 0;
        const z = this.bossSeen ? this.bossZ : 0;
        const aura = BOSS_AURA[this.bossKind] ?? [PALETTE.storm, PALETTE.hostile];
        vfx.duoRing(x, z, 2, 30, 0.9, aura[0], aura[1], 0.5, 2.4);
        vfx.ring(x, z, 1, 22, 1.1, PALETTE.hostile, 0.35, 2, 0.15);
        vfx.groundFlash(x, z, 24, 0.9, aura[0], 1.2);
        vfx.flash(x, 2.2, z, aura[0], 14, 0.5, 2);
        vfx.sparks(x, 2, z, aura[0], 22, 13);
        vfx.sparks(x, 2.4, z, aura[1], 16, 11);
        if (this.bossKind === 'matron') vfx.arcs(x, 1.5, z, aura[1], 9, 5);
        if (this.bossKind === 'stalker') vfx.puff(x, 0.3, z, VIEW.DUST, 12, 2.5, 0.4);
        this.shake(0.8);
        break;
      }
      case 'boon': {
        const h = this.heroes.get(ev.slot);
        if (!h) break;
        vfx.ring(h.x, h.z, 0.5, 3.4, 0.5, DOOR_GOLD, 0.3, 1.6);
        vfx.motes(h.x, 0.2, h.z, DOOR_GOLD, 14, 0.7, 3, 1);
        vfx.flash(h.x, 1.3, h.z, DOOR_GOLD, 3, 0.3, 1.4);
        break;
      }
      case 'doorChosen':
        this.doors.chosen(ev.type, vfx);
        break;
      case 'tutorialStep': {
        // a step was completed: the waypoint (if any) answers with a soft chime of light
        const m = this.marker;
        const h = this.heroes.get(this.localSlot);
        const x = m ? m.x : h ? h.x : 0;
        const z = m ? m.z : h ? h.z : 0;
        vfx.ring(x, z, 0.6, 4.5, 0.5, PALETTE.guideTeal, 0.3, 1.5);
        vfx.motes(x, 0.2, z, PALETTE.guideGold, 14, 0.9, 3, 1);
        break;
      }
      case 'hazardHit': {
        if (ev.target.t === 'p') {
          const h = this.heroes.get(ev.target.id);
          if (h) this.hazards.impact(ev.kind, h.x, 1.1, h.z, vfx);
        } else {
          const v = this.enemies.get(ev.target.id);
          if (v) this.hazards.impact(ev.kind, v.x, v.height * 0.5, v.z, vfx);
        }
        break;
      }
    }
  }

  /** The look of one element as a burst: Ember leaps up in flames, Rime sheds drifting frost, Storm arcs. */
  private elementBurst(el: ElementId, x: number, y: number, z: number, radius: number, amount: number): void {
    const hex = ELEMENT_COLOR[el];
    if (el === 'ember') this.vfx.flames(x, y, z, hex, 7 * amount, radius, 0.8 + 0.7 * amount);
    else if (el === 'rime') this.vfx.frost(x, y + 0.3, z, hex, 14 * amount, radius * 1.2);
    else this.vfx.arcs(x, y, z, hex, 7 * amount, 0.9 + radius * 1.3);
  }

  private castEffect(who: 'p' | 'e', id: number, ability: string, x: number, z: number, rot: number): void {
    const vfx = this.vfx;
    if (who === 'e') {
      // Enemy ability ids are owned by the simulation; telegraph / aoe events carry the shapes. Keep this generic.
      const v = this.enemies.get(id);
      const h = v ? v.lift + v.height * 0.6 : 1.2;
      const aura = v ? BOSS_AURA[v.kind] : undefined;
      const magic = v ? v.kind === 'mage' || v.kind === 'regent' || v.kind === 'matron' : false;
      const hex = aura && v && v.kind !== 'champion' && v.kind !== 'regent' ? aura[1] : magic ? PALETTE.hostileMagic : PALETTE.hostile;
      if (ability === 'blink' && v) {
        // vanishes where it stood, tears back in at (x, z)
        vfx.puff(v.x, 1, v.z, 0x2a1a3a, 8, v.radius * 1.5, 0.45);
        vfx.ring(v.x, v.z, v.radius * 4, 0.4, 0.3, hex, 0.5, 1.6);
        vfx.ring(x, z, 0.4, v.radius * 5, 0.35, hex, 0.4, 2);
        vfx.flash(x, h, z, hex, v.height * 1.6, 0.25, 1.8);
        vfx.motes(x, 0.2, z, hex, 12, v.radius * 1.3, 3, 0.7);
        return;
      }
      if (ability === 'leap' && v) {
        vfx.puff(v.x, 0.25, v.z, VIEW.DUST, 8, v.radius * 1.4, 0.4);
        vfx.ring(v.x, v.z, v.radius * 2, v.radius * 6, 0.3, hex, 0.3, 1.4);
        return;
      }
      const ox = v ? v.x : x;
      const oz = v ? v.z : z;
      vfx.flash(ox + Math.sin(rot) * 0.7, h, oz + Math.cos(rot) * 0.7, hex, v ? 1.4 * v.baseScale : 1.4, 0.16, 1.5);
      if (ability.includes('summon')) {
        vfx.rune(ox, oz, 6, 1.2, hex);
        vfx.motes(ox, 0.2, oz, hex, 16, 2.4, 2.4, 1.1);
      } else if (ability.includes('volley') || ability === 'frenzy') {
        vfx.ring(ox, oz, 1, 7, 0.4, hex, 0.4, 2);
        vfx.sparks(ox, h, oz, hex, 14, 8);
      }
      return;
    }
    const info = ABILITIES.get(ability);
    if (!info) return;
    const a = info.def;
    // an infused ability shows its element in the swing / muzzle / rune; otherwise the class colour
    const infused = this.heroes.infusion(id, a.anim === 'secondary' ? 'secondary' : 'primary');
    const color = infused ? ELEMENT_COLOR[infused] : VIEW.SWING_COLOR[info.cls];
    const sin = Math.sin(rot);
    const cos = Math.cos(rot);
    if (id >= 0 && id < this.castAt.length) { this.castAt[id] = this.time; this.castTinted[id] = infused !== null; }
    if (infused) this.elementBurst(infused, x + sin * 0.8, 1.1, z + cos * 0.8, 0.3, 0.3);
    switch (a.shape) {
      case 'arc': {
        const heavy = a.knockback > 0;
        const dir = info.index % 2 === 0 ? 1 : -1;
        vfx.slash(x, z, rot, a.range, a.arc * DEG, Math.max(0.16, a.lock * 0.62), heavy && !infused ? PALETTE.crit : color, dir, a.windup * 0.7, id, heavy ? 2.2 : 1.6);
        if (heavy) vfx.puff(x + sin * a.range * 0.6, 0.25, z + cos * a.range * 0.6, VIEW.DUST, 4, 0.8, 0.3);
        break;
      }
      case 'projectile': {
        const hex = infused ? color : a.projectile === 'arcBolt' ? PALETTE.arcane : PALETTE.physical;
        const mx = x + sin * 0.9;
        const mz = z + cos * 0.9;
        vfx.flash(mx, 1.2, mz, hex, a.count > 1 ? 2 : 1.5, 0.12, 1.6);
        vfx.sparks(mx, 1.2, mz, hex, a.count > 1 ? 7 : 4, 6, rot, a.count > 1 ? a.arc * DEG * 1.4 : 0.6);
        break;
      }
      case 'circle': {
        vfx.rune(x, z, 3, a.windup + 0.15, infused ? color : PALETTE.arcane);
        vfx.motes(x, 0.2, z, infused ? color : PALETTE.arcane, 14, 1, 2.8, a.windup + 0.2);
        break;
      }
      case 'spin': {
        const steps = Math.max(1, Math.round(a.duration / Math.max(0.05, a.tick)));
        for (let k = 0; k < steps; k++) {
          vfx.slash(x, z, rot + k * 2.2, a.radius, Math.PI * 1.75, a.tick * 1.7, k % 2 === 0 ? color : PALETTE.white, 1, a.windup + k * a.tick, id, 1.5);
        }
        vfx.ring(x, z, 1, a.radius * 2, 0.35, color, 0.3, 1.3, a.windup);
        break;
      }
      case 'lunge': {
        vfx.streak(x, z, rot, a.range, a.radius * 1.7, 0.34, color, a.windup);
        vfx.puff(x, 0.25, z, VIEW.DUST, 4, 0.5, 0.3);
        const ex = x + sin * a.range;
        const ez = z + cos * a.range;
        vfx.ring(ex, ez, 0.6, a.radius * 2.6, 0.32, infused ? color : PALETTE.shield, 0.4, 1.8, a.windup + 0.12);
        break;
      }
    }
  }

  // ------------------------------------------------------------------ frame

  /** Advances mixers / VFX / camera and draws the frame. `render = false` only simulates (catch-up, hidden tab). */
  update(dt: number, render = true): void {
    if (this.disposed) return;
    const step = Math.min(0.1, Math.max(0, dt));
    this.time += step;
    this.dt = step;
    const time = this.time;

    this.updateCamera(step);
    _pm.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_pm);

    this.decals.begin();
    this.fx.begin();
    this.ui.begin();

    this.level.emit(this.fx, this.decals, time);
    this.ambient(step);
    this.hazards.update(step, time, this.serverTick, this.decals, this.fx, this.vfx);
    if (this.marker && this.hasRoom) this.drawMarker(this.marker, time);
    if (this.level.diorama) this.preview.update(step);
    const blobs = this.profile.blobShadows;
    this.heroes.update(step, time, this.decals, this.ui, this.fx, blobs);
    this.enemies.update(step, time, this.decals, this.ui, this.fx, blobs);
    this.heroes.forEach(this.cullHero);
    this.enemies.forEachView(this.perEnemy);
    this.heroes.forEach(this.heroFx);
    this.doors.update(step, time, this.decals, this.fx, this.ui, this.vfx);
    this.projectiles.update(step, time, this.decals, this.fx, this.vfx);
    this.vfx.update(step, this.decals, this.fx, this.ui, this);

    this.decals.end(time);
    this.fx.end(time);
    this.ui.end(time);

    if (render) this.render(step);
  }

  private drawMarker(m: MarkerView, time: number): void {
    const t = rgb(PALETTE.guideTeal);
    const g = rgb(PALETTE.guideGold);
    const d = m.r * 2;
    const bob = Math.sin(time * 2.6) * 0.18;
    this.decals.push(DECAL.MARKER, m.x, 0.05, m.z, 0, d, d, t[0] * 1.5, t[1] * 1.5, t[2] * 1.5, 0.95, 0.35, 0, g[0] * 1.6, g[1] * 1.6, g[2] * 1.6);
    this.decals.push(DECAL.DISC, m.x, 0.04, m.z, 0, d * 1.5, d * 1.5, t[0], t[1], t[2], 0.16, 1, 0);
    this.fx.push(SPRITE.GLOW, m.x, 1.4, m.z, 1.4, 3.4, t[0], t[1], t[2], 0.16, 1, 0);
    const uv = this.atlas.icons.marker;
    this.ui.push(SPRITE.GLOW, m.x, 2.75 + bob, m.z, 1.7, 1.7, t[0] * 0.5, t[1] * 0.5, t[2] * 0.5, 0.5, 1, 0);
    this.ui.push(SPRITE.ATLAS, m.x, 2.75 + bob, m.z, 1.05, 1.05, g[0] * 1.2, g[1] * 1.2, g[2] * 1.2, 1, 0, 0, 0, 0, 0, uv[0], uv[1], uv[2], uv[3]);
  }

  private readonly heroFx = (h: HeroView): void => {
    const p = this.dt * this.vfx.density;
    const dashEl = h.anim === 'dash' ? this.heroes.infusion(h.slot, 'dash') : null;
    if (dashEl && h.state === 'alive') {
      // infused dash: a streak of the element where the hero passes
      const c = rgb(ELEMENT_COLOR[dashEl]);
      this.fx.push(SPRITE.GLOW, h.x, 1, h.z, 2.6, 2.6, c[0], c[1], c[2], 0.5, 1, 0.4);
      this.decals.push(DECAL.STREAK, h.x - Math.sin(h.rot) * 1.6, 0.4, h.z - Math.cos(h.rot) * 1.6, h.rot, 1.1, 3.4, c[0] * 1.6, c[1] * 1.6, c[2] * 1.6, 0.8, 1);
      if (Math.random() < p * 60) this.elementBurst(dashEl, h.x, 0.5, h.z, 0.4, 0.2);
    }
    if (this.level.biome === 'flooded' && h.state === 'alive' && h.speed > 1.5 && Math.random() < p * VIEW.RIPPLE_RATE) {
      this.vfx.ring(h.x, h.z, 0.5, 2.2, 0.7, 0x9fe8f0, 0.16, 0.5);
    }
    if (h.state !== 'alive') {
      if ((h.flags & PF.BEING_REVIVED) !== 0 && Math.random() < p * 14) this.vfx.motes(h.x, 0.1, h.z, PALETTE.glimmer, 1, 1, 3, 0.9);
      else if (Math.random() < p * 2) this.vfx.motes(h.x, 0.1, h.z, SLOT_COLORS[h.slot], 1, 0.8, 1.4, 1);
    } else if ((h.flags & PF.INVULNERABLE) !== 0 && Math.random() < p * 30) {
      this.vfx.particle(h.x + (Math.random() - 0.5) * 0.5, 0.3 + Math.random() * 1.2, h.z + (Math.random() - 0.5) * 0.5, 0, 0.2, 0, 0.25, 0.5, 0.1, 0.8, 0.9, 1.2, 0.5, SPRITE.GLOW, 1);
    }
  };

  private ambient(dt: number): void {
    const vfx = this.vfx;
    const stage = this.level.diorama;
    if (this.level.width === 0 && !stage) return;
    const d = vfx.density;
    const biome = this.level.biome;
    const cx = stage ? 0 : this.target.x;
    const cz = stage ? 0 : this.target.z;
    const spreadX = stage ? 12 : 30;
    const spreadZ = stage ? 6 : 20;
    this.dustAcc += VIEW.DUST_RATE * d * dt * (biome === 'forge' ? 0.5 : 1);
    while (this.dustAcc >= 1) {
      this.dustAcc -= 1;
      vfx.particle(cx + (Math.random() - 0.5) * spreadX, 0.4 + Math.random() * 3.2, cz + (Math.random() - 0.6) * spreadZ,
        (Math.random() - 0.5) * 0.3, 0.05 + Math.random() * 0.1, (Math.random() - 0.5) * 0.3, 3 + Math.random() * 2.5, 0.07, 0.12, 0.6, 0.66, 0.85, 0.5, SPRITE.GLOW, 0.8);
    }
    this.emberAcc += VIEW.EMBER_RATE * d * dt;
    while (this.emberAcc >= 1) {
      this.emberAcc -= 1;
      if (this.level.sampleFlame(Math.random(), _sample)) {
        vfx.particle(_sample.x + (Math.random() - 0.5) * 0.2, _sample.y, _sample.z + (Math.random() - 0.5) * 0.2, (Math.random() - 0.5) * 0.5, 1 + Math.random() * 1.2,
          (Math.random() - 0.5) * 0.5, 0.7 + Math.random() * 0.7, 0.11, 0.02, _sample.r * 2.4, _sample.g * 2.4, _sample.b * 2.4, 1, SPRITE.SPARK, 1, -0.4, 0.5, 5);
      }
    }
    this.sparkleAcc += VIEW.SPARKLE_RATE * d * dt;
    while (this.sparkleAcc >= 1) {
      this.sparkleAcc -= 1;
      if (this.level.sampleGlow(Math.random(), _sample)) {
        vfx.particle(_sample.x + (Math.random() - 0.5) * 0.9, _sample.y + (Math.random() - 0.3) * 0.9, _sample.z + (Math.random() - 0.5) * 0.9, 0, 0.35, 0,
          0.6 + Math.random() * 0.5, 0.2, 0.02, _sample.r * 2.2, _sample.g * 2.2, _sample.b * 2.2, 1, SPRITE.SPARK, 1, 0, 0, 3);
      }
    }
    if (stage) return;
    if (biome === 'flooded') {
      // mist drifting low over the water
      this.mistAcc += VIEW.MIST_RATE * d * dt;
      while (this.mistAcc >= 1) {
        this.mistAcc -= 1;
        const drift = 0.25 + Math.random() * 0.4;
        vfx.particle(cx + (Math.random() - 0.5) * 34, 0.25 + Math.random() * 0.7, cz + (Math.random() - 0.55) * 24, drift, 0.02, (Math.random() - 0.5) * 0.2,
          5 + Math.random() * 3, 2.4 + Math.random() * 1.6, 4.4, 0.5, 0.78, 0.8, 0.085, SPRITE.GLOW, 0.35);
      }
    } else if (biome === 'forge') {
      // embers climbing out of the channels and off the floor, and slow heat haze above the southern lava
      this.mistAcc += VIEW.FORGE_EMBER_RATE * d * dt;
      while (this.mistAcc >= 1) {
        this.mistAcc -= 1;
        const edge = Math.random() < 0.45;
        const x = cx + (Math.random() - 0.5) * 34;
        const z = edge ? this.level.depth / 2 + 2 + Math.random() * 5 : cz + (Math.random() - 0.55) * 22;
        const hot = 1.6 + Math.random() * 1.2;
        vfx.particle(x, 0.1 + Math.random() * 0.4, z, (Math.random() - 0.5) * 0.7, 1.1 + Math.random() * 1.8, (Math.random() - 0.5) * 0.7,
          1.6 + Math.random() * 1.8, 0.1 + Math.random() * 0.06, 0.02, 1.0 * hot, 0.42 * hot, 0.1 * hot, 1, SPRITE.SPARK, 1, -0.25, 0.25, 5);
      }
      this.hazeAcc += VIEW.HAZE_RATE * d * dt;
      while (this.hazeAcc >= 1) {
        this.hazeAcc -= 1;
        vfx.particle(cx + (Math.random() - 0.5) * 36, 0.3, this.level.depth / 2 + 2.5 + Math.random() * 4, (Math.random() - 0.5) * 0.3, 0.7 + Math.random() * 0.5, 0,
          3.5 + Math.random() * 2, 2.6, 5, 1, 0.34, 0.08, 0.07, SPRITE.GLOW, 1);
      }
    }
  }

  /** Wardrobe framing: a slow push-in on the pedestal, the hero centred at the requested screen position. */
  private updateStageCamera(dt: number, want: ShowcaseView): void {
    this.stageTime += dt;
    this.stageX += (want.screenX - this.stageX) * Math.min(1, dt * STAGE.SLIDE_RATE);
    const fovTan = Math.tan((CAMERA.FOV * DEG) / 2);
    const dist = HERO_VIS.HEIGHT / (STAGE.HERO_FRACTION * 2 * fovTan);
    const k = Math.min(1, this.stageTime / STAGE.INTRO_TIME);
    const ease = 1 - (1 - k) * (1 - k) * (1 - k);
    const pull = 1 + STAGE.INTRO_PULL * (1 - ease);
    const pitch = STAGE.PITCH_DEG * DEG;
    const sway = Math.sin(this.time * 0.35) * STAGE.SWAY;
    const lookY = STAGE.LOOK_Y + this.level.pedestalY;
    this.target.set(0, 0, 0);
    this.camera.position.set(sway, lookY + Math.sin(pitch) * dist * pull + STAGE.INTRO_RISE * (1 - ease), Math.cos(pitch) * dist * pull);
    _v.set(0, lookY, 0);
    this.camera.lookAt(_v);
    // off-axis projection: the hero stays undistorted in the middle of the lens and is shifted on screen instead
    const offset = this.stageX - 0.5;
    if (Math.abs(offset - this.appliedOffset) > 1e-4) {
      this.appliedOffset = offset;
      const aspect = this.camera.aspect;
      this.camera.setViewOffset(aspect, 1, -offset * aspect, 0, aspect, 1);
    }
    this.camera.updateMatrixWorld();
    this.trauma = 0;
    this.shakeOffset.set(0, 0, 0);
  }

  private updateCamera(dt: number): void {
    if (this.level.diorama && this.showcase) { this.updateStageCamera(dt, this.showcase); return; }
    const dist = CAMERA.DISTANCE * (this.focus ? this.focus.zoom : this.zoom);
    const pitch = CAMERA.PITCH_DEG * DEG;
    // follow the local hero; fall back to the party centre, then the room centre
    let tx = 0;
    let tz = 0;
    const local = this.heroes.get(this.localSlot);
    if (local) { tx = local.x; tz = local.z; } else {
      let n = 0;
      for (let s = 0; s < 4; s++) { const h = this.heroes.get(s); if (h) { tx += h.x; tz += h.z; n++; } }
      if (n > 0) { tx /= n; tz /= n; }
    }
    if (this.focus) {
      tx = this.focus.x; tz = this.focus.z;
      this.snapCamera = true;
    } else if (this.level.width > 0) {
      // keep the view from showing far outside the room
      const halfV = Math.tan((CAMERA.FOV * DEG) / 2) * dist;
      const halfW = halfV * this.camera.aspect;
      const halfD = halfV / Math.sin(pitch);
      const limX = Math.max(0, this.level.width / 2 + CAMERA.EDGE_MARGIN - halfW);
      const limN = Math.max(0, this.level.depth / 2 + VIEW.NORTH_MARGIN - halfD);
      const limS = Math.max(0, this.level.depth / 2 + CAMERA.EDGE_MARGIN - halfD * 0.9);
      tx = Math.max(-limX, Math.min(limX, tx));
      tz = Math.max(-limN, Math.min(limS, tz));
      if (limN === 0 && limS === 0) tz = -(VIEW.NORTH_MARGIN - CAMERA.EDGE_MARGIN) * 0.5;
    }
    const jump = Math.hypot(tx - this.target.x, tz - this.target.z);
    if (this.snapCamera || jump > CAMERA.SNAP_DISTANCE * 2.5) {
      this.target.set(tx, 0, tz);
      this.snapCamera = false;
    } else {
      const k = 1 - Math.exp(-CAMERA.FOLLOW_RATE * dt);
      this.target.x += (tx - this.target.x) * k;
      this.target.z += (tz - this.target.z) * k;
    }
    this.camera.position.set(this.target.x, Math.sin(pitch) * dist + 1, this.target.z + Math.cos(pitch) * dist);
    _v.set(this.target.x, 1, this.target.z);
    this.camera.lookAt(_v);
    this.camera.updateMatrixWorld();

    this.trauma = Math.max(0, this.trauma - CAMERA.SHAKE_DECAY * dt);
    const s = this.trauma * this.trauma * CAMERA.SHAKE_MAX_OFFSET;
    const t = this.time * CAMERA.SHAKE_FREQ;
    this.shakeOffset.set(Math.sin(t * 1.13) + Math.sin(t * 2.31) * 0.5, Math.sin(t * 1.71 + 1.3) * 0.6, Math.sin(t * 1.37 + 2.1) * 0.4).multiplyScalar(s);
  }

  private render(dt: number): void {
    const renderer = this.renderer;
    renderer.info.reset();
    // shake is applied only for the draw so aiming (screenToGround) stays stable
    this.camera.position.add(this.shakeOffset);
    this.camera.updateMatrixWorld();
    if (this.composer && this.profile.bloom) {
      this.composer.render(dt);
    } else {
      renderer.setRenderTarget(null);
      renderer.clear();
      renderer.render(this.scene, this.camera);
    }
    renderer.render(this.uiScene, this.camera);
    this.camera.position.sub(this.shakeOffset);
    this.camera.updateMatrixWorld();
    this.stats.drawCalls = renderer.info.render.calls;
    this.stats.triangles = renderer.info.render.triangles;
    this.stats.geometries = renderer.info.memory.geometries;
    this.stats.textures = renderer.info.memory.textures;
  }

  getStats(): RenderStats {
    return this.stats;
  }

  /** Debug counters for the showcase overlay. */
  getDebug(): {
    quality: Quality; particles: number; decals: number; fxSprites: number; uiSprites: number; enemies: number; projectiles: number;
    hazards: number; heroTemplates: number; showcase: boolean;
  } {
    return {
      quality: this.quality, particles: this.vfx.particleCount, decals: this.decals.used, fxSprites: this.fx.used,
      uiSprites: this.ui.used, enemies: this.enemies.count, projectiles: this.projectiles.count,
      hazards: this.hazards.active, heroTemplates: this.assets.heroTemplateCount(), showcase: this.level.diorama,
    };
  }

  /** Dev helper (showcase close-ups): pins the camera to a ground point with a free zoom; null restores following. */
  debugFocus(focus: { x: number; z: number; zoom: number } | null): void {
    this.focus = focus;
    this.snapCamera = true;
  }

  // ------------------------------------------------------------------ lifecycle

  clearSession(): void {
    this.heroes.clear();
    this.enemies.clear();
    this.projectiles.clear();
    this.vfx.clear();
    this.doors.clear();
    this.hazards.clear();
    this.marker = null;
    this.hasRoom = false;
    // back in the menu: a wardrobe request that was waiting behind the chamber takes over again
    if (this.showcase) this.applyShowcase();
    else this.level.setRoom(null, 'combat', 0);
    this.trauma = 0;
    this.snapCamera = true;
    this.bossSeen = false;
  }

  dispose(): void {
    if (this.disposed) return;
    this.showcase = null;
    this.clearSession();
    this.endShowcase();
    this.disposed = true;
    this.hazards.dispose();
    this.level.dispose();
    this.projectiles.dispose();
    this.doors.dispose();
    this.decals.dispose();
    this.fx.dispose();
    this.ui.dispose();
    this.atlas.dispose();
    this.disposeComposer();
    this.renderer.renderLists.dispose();
    this.renderer.dispose();
  }
}

const DOOR_GOLD = 0xffd166;
