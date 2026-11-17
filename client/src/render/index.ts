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
  ClassId, Door, ElementId, EnemySnap, GameEvent, PlayerSnap, ProjectileSnap, RoomLayout,
} from '@shared/types.ts';
import type { ChamberKind } from '@shared/constants.ts';
import { CLASSES } from '@shared/data/classes.ts';
import type { AbilityDef } from '@shared/data/classes.ts';
import { ENEMIES } from '@shared/data/enemies.ts';
import type { Quality } from '../core/Settings.ts';
import { loadAssets } from './assets.ts';
import type { Assets } from './assets.ts';
import { Atlas } from './atlas.ts';
import { BillboardBatch, DecalBatch, SPRITE } from './batches.ts';
import { Enemies, Heroes } from './characters.ts';
import type { EnemyView, HeroView } from './characters.ts';
import { BLOOM, CAMERA, ELEMENT_COLOR, LIMITS, PALETTE, QUALITY, SLOT_COLORS } from './config.ts';
import type { QualityProfile } from './config.ts';
import { Doors } from './doors.ts';
import { LevelView } from './level.ts';
import { Projectiles } from './projectiles.ts';
import { Vfx, rgb } from './vfx.ts';
import type { FollowSource } from './vfx.ts';

export { loadAssets };
export type { Assets };

export interface RenderStats { drawCalls: number; triangles: number; geometries: number; textures: number }
export interface RosterView { slot: number; cls: ClassId; name: string }

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
    if (v.kind === 'regent' || (v.kind === 'champion' && !this.bossSeen)) {
      this.bossX = v.x; this.bossZ = v.z; this.bossSeen = true;
    }
    if (!v.root.visible) return;
    const f = v.flags;
    const p = VIEW.STATUS_RATE * this.dt * this.vfx.density;
    if (f & EF.BURN && Math.random() < p) this.vfx.motes(v.x, v.height * 0.45, v.z, ELEMENT_COLOR.ember, 1, v.radius, 2.4, 0.6);
    if (f & EF.CHILL && Math.random() < p) this.vfx.motes(v.x, v.height * 0.6, v.z, ELEMENT_COLOR.rime, 1, v.radius * 1.2, -0.7, 0.8);
    if (f & EF.SHOCK && Math.random() < p) this.vfx.sparks(v.x, v.height * 0.6, v.z, ELEMENT_COLOR.storm, 1, 3);
    if (v.kind === 'regent' && Math.random() < p * 3) this.vfx.motes(v.x, 0.3, v.z, PALETTE.storm, 1, v.radius * 1.6, 2.6, 1.1);
    if (v.kind === 'champion' && Math.random() < p * 2) this.vfx.motes(v.x, 0.3, v.z, PALETTE.ember, 1, v.radius * 1.4, 2.2, 0.9);
  };

  constructor(canvas: HTMLCanvasElement, assets: Assets) {
    this.canvas = canvas;
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
    this.fog.near = d * 1.25;
    this.fog.far = d * 3.6;
  }

  // ------------------------------------------------------------------ world state

  setRoom(room: RoomLayout | null, chamberKind: ChamberKind, chamberIndex: number): void {
    if (!this.level.setRoom(room, chamberKind, chamberIndex)) return;
    this.level.applyQuality(this.profile);
    this.updateFog();
    this.vfx.clear();
    this.doors.clear();
    this.snapCamera = true;
    this.bossSeen = false;
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
        const big = ev.kind === 'champion' || ev.kind === 'regent';
        const s = ENEMIES[ev.kind].scale;
        this.enemies.kill(ev.id);
        vfx.sparks(ev.x, s, ev.z, VIEW.BONE, big ? 30 : 9, big ? 11 : 6);
        vfx.motes(ev.x, 0.6 * s, ev.z, PALETTE.glimmer, big ? 40 : 7, 0.5 * s, 2.4, big ? 1.8 : 1);
        vfx.puff(ev.x, 0.3, ev.z, VIEW.DUST, big ? 12 : 3, 0.6 * s, 0.3);
        vfx.ring(ev.x, ev.z, 0.4, big ? 16 : 2.6, big ? 0.8 : 0.35, PALETTE.glimmer, 0.3, big ? 2 : 1.1);
        if (big) {
          vfx.flash(ev.x, s, ev.z, PALETTE.glimmer, 12, 0.6, 2);
          vfx.groundFlash(ev.x, ev.z, 18, 0.9, PALETTE.glimmer, 1.2);
          this.shake(0.7);
        } else if (ev.by === this.localSlot) this.shake(0.06);
        break;
      }
      case 'resonance': {
        const a = ELEMENT_COLOR[ev.a];
        const b = ELEMENT_COLOR[ev.b];
        const d = ev.r * 2;
        vfx.ring(ev.x, ev.z, d * 0.2, d * 1.05, 0.42, a, 0.45, 2.2);
        vfx.ring(ev.x, ev.z, d * 0.1, d * 1.2, 0.55, b, 0.3, 2.2, 0.07);
        vfx.groundFlash(ev.x, ev.z, d * 1.15, 0.5, b, 1.3);
        vfx.flash(ev.x, 1.1, ev.z, PALETTE.white, ev.r * 1.8, 0.14, 1.5);
        vfx.flash(ev.x, 1.1, ev.z, a, ev.r * 2.6, 0.3, 1.6);
        vfx.sparks(ev.x, 1, ev.z, a, 12, 10);
        vfx.sparks(ev.x, 1, ev.z, b, 12, 12);
        vfx.motes(ev.x, 0.3, ev.z, b, 12, ev.r * 0.9, 2, 0.9);
        this.shake(0.22);
        break;
      }
      case 'status': {
        const v = this.enemies.get(ev.id);
        if (!v) break;
        const hex = ELEMENT_COLOR[ev.el];
        vfx.motes(v.x, v.height * 0.4, v.z, hex, 6, v.radius, 2, 0.6);
        vfx.ring(v.x, v.z, 0.5, v.radius * 4.4, 0.3, hex, 0.3, 1.3);
        break;
      }
      case 'telegraph':
        vfx.telegraph(ev.shape, ev.x, ev.z, ev.rot, ev.r, ev.w, ev.dur);
        break;
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
        const def = ENEMIES[ev.kind];
        const big = ev.kind === 'champion' || ev.kind === 'regent';
        const hex = ev.elite || big ? PALETTE.hostile : PALETTE.glimmer;
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
        vfx.ring(x, z, 2, 30, 0.9, PALETTE.storm, 0.5, 2.4);
        vfx.ring(x, z, 1, 22, 1.1, PALETTE.hostile, 0.35, 2, 0.15);
        vfx.groundFlash(x, z, 24, 0.9, PALETTE.hostileMagic, 1.2);
        vfx.flash(x, 2.2, z, PALETTE.storm, 14, 0.5, 2);
        vfx.sparks(x, 2, z, PALETTE.storm, 30, 13);
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
    }
  }

  private castEffect(who: 'p' | 'e', id: number, ability: string, x: number, z: number, rot: number): void {
    const vfx = this.vfx;
    if (who === 'e') {
      // Enemy ability ids are owned by the simulation; telegraph / aoe events carry the shapes. Keep this generic.
      const v = this.enemies.get(id);
      const h = v ? v.height * 0.6 : 1.2;
      const magic = v ? v.kind === 'mage' || v.kind === 'regent' : false;
      const hex = magic ? PALETTE.hostileMagic : PALETTE.hostile;
      vfx.flash(x + Math.sin(rot) * 0.7, h, z + Math.cos(rot) * 0.7, hex, v ? 1.4 * v.baseScale : 1.4, 0.16, 1.5);
      if (ability.includes('summon')) {
        vfx.rune(x, z, 6, 1.2, PALETTE.hostileMagic);
        vfx.motes(x, 0.2, z, PALETTE.hostileMagic, 16, 2.4, 2.4, 1.1);
      } else if (ability.includes('volley')) {
        vfx.ring(x, z, 1, 7, 0.4, PALETTE.hostileMagic, 0.4, 2);
        vfx.sparks(x, h, z, PALETTE.hostileMagic, 14, 8);
      }
      return;
    }
    const info = ABILITIES.get(ability);
    if (!info) return;
    const a = info.def;
    const color = VIEW.SWING_COLOR[info.cls];
    const sin = Math.sin(rot);
    const cos = Math.cos(rot);
    switch (a.shape) {
      case 'arc': {
        const heavy = a.knockback > 0;
        const dir = info.index % 2 === 0 ? 1 : -1;
        vfx.slash(x, z, rot, a.range, a.arc * DEG, Math.max(0.16, a.lock * 0.62), heavy ? PALETTE.crit : color, dir, a.windup * 0.7, id, heavy ? 2.2 : 1.6);
        if (heavy) vfx.puff(x + sin * a.range * 0.6, 0.25, z + cos * a.range * 0.6, VIEW.DUST, 4, 0.8, 0.3);
        break;
      }
      case 'projectile': {
        const hex = a.projectile === 'arcBolt' ? PALETTE.arcane : PALETTE.physical;
        const mx = x + sin * 0.9;
        const mz = z + cos * 0.9;
        vfx.flash(mx, 1.2, mz, hex, a.count > 1 ? 2 : 1.5, 0.12, 1.6);
        vfx.sparks(mx, 1.2, mz, hex, a.count > 1 ? 7 : 4, 6, rot, a.count > 1 ? a.arc * DEG * 1.4 : 0.6);
        break;
      }
      case 'circle': {
        vfx.rune(x, z, 3, a.windup + 0.15, PALETTE.arcane);
        vfx.motes(x, 0.2, z, PALETTE.arcane, 14, 1, 2.8, a.windup + 0.2);
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
        vfx.ring(ex, ez, 0.6, a.radius * 2.6, 0.32, PALETTE.shield, 0.4, 1.8, a.windup + 0.12);
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

  private readonly heroFx = (h: HeroView): void => {
    const p = this.dt * this.vfx.density;
    if (h.state !== 'alive') {
      if ((h.flags & PF.BEING_REVIVED) !== 0 && Math.random() < p * 14) this.vfx.motes(h.x, 0.1, h.z, PALETTE.glimmer, 1, 1, 3, 0.9);
      else if (Math.random() < p * 2) this.vfx.motes(h.x, 0.1, h.z, SLOT_COLORS[h.slot], 1, 0.8, 1.4, 1);
    } else if ((h.flags & PF.INVULNERABLE) !== 0 && Math.random() < p * 30) {
      this.vfx.particle(h.x + (Math.random() - 0.5) * 0.5, 0.3 + Math.random() * 1.2, h.z + (Math.random() - 0.5) * 0.5, 0, 0.2, 0, 0.25, 0.5, 0.1, 0.8, 0.9, 1.2, 0.5, SPRITE.GLOW, 1);
    }
  };

  private ambient(dt: number): void {
    const vfx = this.vfx;
    if (this.level.width === 0) return;
    const d = vfx.density;
    this.dustAcc += VIEW.DUST_RATE * d * dt;
    while (this.dustAcc >= 1) {
      this.dustAcc -= 1;
      vfx.particle(this.target.x + (Math.random() - 0.5) * 30, 0.4 + Math.random() * 3.2, this.target.z + (Math.random() - 0.6) * 20,
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
  }

  private updateCamera(dt: number): void {
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
  getDebug(): { quality: Quality; particles: number; decals: number; fxSprites: number; uiSprites: number; enemies: number; projectiles: number } {
    return {
      quality: this.quality, particles: this.vfx.particleCount, decals: this.decals.used, fxSprites: this.fx.used,
      uiSprites: this.ui.used, enemies: this.enemies.count, projectiles: this.projectiles.count,
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
    this.level.setRoom(null, 'combat', 0);
    this.trauma = 0;
    this.snapCamera = true;
    this.bossSeen = false;
  }

  dispose(): void {
    if (this.disposed) return;
    this.clearSession();
    this.disposed = true;
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
