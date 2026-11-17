/**
 * Builds the visible chamber from a RoomLayout, deterministically from room.seed:
 * instanced floor / walls / props (one InstancedMesh per repeated kit piece, everything that occurs only once
 * or twice is merged into a single mesh), glimmer crystals, torches and the chamber lighting rig.
 *
 * Three biomes share the kit but differ in floor, dressing, lighting and ground surface:
 *   crypt   – torch-lit stone hall
 *   flooded – drowned catacombs: shallow rippling water over mossy tiles, pale crystals, chains, ghost-lanterns
 *   forge   – ember foundry: basalt and dirt floor with glowing cracks, lava around the walkable floor, light from below
 * The chamber kind (combat / elite / boss) is layered on top as a mood. The same builder also makes the small
 * pedestal diorama behind the wardrobe (setDiorama).
 */
import {
  BoxGeometry, BufferAttribute, BufferGeometry, Color, ConeGeometry, CylinderGeometry, DirectionalLight, DoubleSide, Euler, Group,
  HemisphereLight, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, PlaneGeometry, PointLight, Quaternion, Vector3,
} from 'three';
import type { MeshLambertMaterial } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { BiomeId, Obstacle, RoomLayout } from '@shared/types.ts';
import type { ChamberKind } from '@shared/constants.ts';
import type { Assets } from './assets.ts';
import { BillboardBatch, DECAL, DecalBatch, SPRITE } from './batches.ts';
import { PALETTE, SHADOW, WALL } from './config.ts';
import type { QualityProfile } from './config.ts';
import { createLevelMaterial } from './materials.ts';
import { createRng } from './rng.ts';
import type { Rng } from './rng.ts';
import { createLavaMaterial, createWaterMaterial } from './surfaces.ts';
import type { LavaMaterial, WaterMaterial } from './surfaces.ts';

interface Mood {
  hemiSky: number; hemiGround: number; hemiIntensity: number;
  dirColor: number; dirIntensity: number;
  torch: number; torchIntensity: number;
  floorTint: number; wallTint: number; propTint: number;
  crystal: number;
  banners: string[];
  fog: number;
  void: number;
}

const CRYPT: Mood = {
  hemiSky: 0x7f93c8, hemiGround: 0x2c2420, hemiIntensity: 1.1, dirColor: 0xc9d6ff, dirIntensity: 1.5,
  torch: 0xff8f3f, torchIntensity: 46, floorTint: 0x70809a, wallTint: 0xb9bfd6, propTint: 0xd8d2c8,
  crystal: PALETTE.glimmer, banners: ['banner_patternB_blue', 'banner_patternC_green', 'banner_thin_yellow'],
  fog: 0x080a14, void: 0x0c0f1a,
};
const FLOODED: Mood = {
  hemiSky: 0x4fd0dc, hemiGround: 0x0c3038, hemiIntensity: 1.25, dirColor: 0x9ff0ff, dirIntensity: 1.15,
  torch: 0x4dffd8, torchIntensity: 40, floorTint: 0x4a6f78, wallTint: 0x7fb0b4, propTint: 0xa6cfc8,
  crystal: 0xc8fbff, banners: ['banner_patternA_green', 'banner_blue'],
  fog: 0x051d22, void: 0x04161b,
};
const FORGE: Mood = {
  hemiSky: 0x9a6248, hemiGround: 0xff5a1a, hemiIntensity: 1.2, dirColor: 0xffc49a, dirIntensity: 1.05,
  torch: 0xff6a1e, torchIntensity: 56, floorTint: 0x77564a, wallTint: 0xa88474, propTint: 0xd4b8a2,
  crystal: 0xff8426, banners: ['banner_patternB_red', 'banner_brown', 'banner_triple_yellow'],
  fog: 0x1c0905, void: 0x130604,
};

/** Chamber moods on top of each biome: elite turns the fires hostile red, the boss chamber gets its own eerie light. */
const MOODS: Record<BiomeId, Record<ChamberKind, Mood>> = {
  crypt: {
    combat: CRYPT,
    elite: {
      ...CRYPT, hemiSky: 0x6f9ae0, hemiGround: 0x1d1a26, hemiIntensity: 1.2, dirColor: 0xa9c8ff, dirIntensity: 1.45,
      torch: 0xff4a36, torchIntensity: 44, floorTint: 0x7586ae, wallTint: 0xa3b2d8, propTint: 0xc4c6d6,
      crystal: 0xff3d55, banners: ['banner_patternA_red', 'banner_shield_red'], fog: 0x070b18, void: 0x0a0e1c,
    },
    boss: {
      ...CRYPT, hemiSky: 0x5f78d8, hemiGround: 0x0f1a1c, hemiIntensity: 1.0, dirColor: 0xcfe0ff, dirIntensity: 1.25,
      torch: 0x4dffa0, torchIntensity: 34, floorTint: 0x6f7a98, wallTint: 0x9aa6c8, propTint: 0xc8c8d4,
      banners: ['banner_shield_red', 'banner_patternA_red'], fog: 0x060c12, void: 0x08101a,
    },
  },
  flooded: {
    combat: FLOODED,
    elite: {
      ...FLOODED, hemiSky: 0x48b4d8, hemiIntensity: 1.15, torch: 0xff4058, torchIntensity: 46, crystal: 0xff4a78,
      banners: ['banner_patternA_red', 'banner_shield_red'], fog: 0x07161f,
    },
    boss: {
      ...FLOODED, hemiSky: 0x5a9ae0, hemiGround: 0x101c38, hemiIntensity: 1.05, dirColor: 0xbcd0ff, dirIntensity: 1.0,
      torch: 0xb48cff, torchIntensity: 40, crystal: 0xd6c2ff, banners: ['banner_shield_red', 'banner_blue'], fog: 0x070f22, void: 0x060c1c,
    },
  },
  forge: {
    combat: FORGE,
    elite: {
      ...FORGE, hemiSky: 0x9a4a48, torch: 0xff2a2a, torchIntensity: 52, crystal: 0xff3030,
      banners: ['banner_patternA_red', 'banner_shield_red'], fog: 0x1c0606,
    },
    boss: {
      ...FORGE, hemiSky: 0x8a5a58, hemiGround: 0xff7a1a, hemiIntensity: 1.1, dirColor: 0xffe0b0, dirIntensity: 0.95,
      torch: 0xffe07a, torchIntensity: 46, crystal: 0xffd24a, banners: ['banner_shield_red', 'banner_patternB_red'], fog: 0x1a0c04,
    },
  },
};

/** What is not light: floor recipe, ground surface and dressing of a biome. */
const BIOME = {
  crypt: { moss: 0x70809a, throne: 0xa59bd0, ledgeSouth: 1.5 },
  flooded: {
    moss: 0x3f8a5c, throne: 0x8fc4cc, ledgeSouth: 1.5,
    water: { y: 0.016, deep: 0x03161b, shallow: 0x12525a, glint: 0xa8f6ff, margin: 90 },
  },
  forge: {
    moss: 0x4a3a34, throne: 0xb08a78, ledgeSouth: 4.2,
    lava: { y: -0.32, hot: 0xff5a12, crust: 0x160907, heat: 1.15, margin: 90 },
    crack: 0xff6a1a,
  },
} as const;

const DIORAMA_MOOD: Mood = {
  ...CRYPT, hemiSky: 0x8fa2e0, hemiGround: 0x3a2c28, hemiIntensity: 1.25, dirColor: 0xdfe6ff, dirIntensity: 1.7,
  torch: 0xff9a4a, torchIntensity: 30, floorTint: 0x7a88a6, wallTint: 0xaab2cc, fog: 0x070912, void: 0x090c15,
};

const CFG = {
  FLOOR_CELL: 2,
  FLOOR_Y: -0.05,
  INSTANCE_MIN: 3,
  TORCH_Y: 2.15,
  TORCH_FLAME: { y: 0.78, z: 0.42 },
  LIGHT_HEIGHT: 3.1,
  LIGHT_INSET: 1.4,
  LIGHT_DISTANCE: 19,
  LIGHT_DECAY: 1.35,
  PILLAR_HEIGHT: 2.7,
  ALCOVE_DEPTH: 4,
  DAIS_HEIGHT: 0.5,
  SKIRT_INNER: 1.5,
  SKIRT_OUTER: 70,
  SKIRT_Y: -0.18,
  CRYSTAL_GLOW: 1.25,
  SUN_DIR: [-0.42, 1, 0.5],
  /** Flat unlit floor details (forge cracks, moss) sit just above the tiles and below every decal. */
  DETAIL_Y: 0.011,
  CHAIN_LINK: 0.2,
  IRON: 0x3c3a44,
  /** Wardrobe diorama. */
  PEDESTAL_HEIGHT: 0.34,
  PEDESTAL_RADIUS: 1.25,
  DIORAMA_WALL_Z: -3.4,
} as const;

interface Flame { x: number; y: number; z: number; size: number; seed: number; pool: number }
interface Glow { x: number; y: number; z: number; size: number; r: number; g: number; b: number; seed: number }

interface PieceBin { matrices: number[]; colors: number[] }

type Put = (piece: string, x: number, y: number, z: number, rotY?: number, sx?: number, sy?: number, sz?: number, tint?: Color, shade?: number) => void;
type AddFlame = (x: number, y: number, z: number, size: number, pool: number) => void;
type AddCluster = (x: number, y: number, z: number, scale: number, count: number, color?: Color) => void;

/** Everything the piece-placing helpers need while one room is being assembled. */
interface Build {
  rng: Rng;
  biome: BiomeId;
  mood: Mood;
  put: Put;
  flame: AddFlame;
  cluster: AddCluster;
  glow: (x: number, y: number, z: number, size: number, color: Color) => void;
  /** Lit procedural solids, merged into one mesh. */
  extra: BufferGeometry[];
  /** Unlit flat floor details: [x, z] quad strips with a colour. */
  detail: { positions: number[]; colors: number[] };
  floorTint: Color; wallTint: Color; propTint: Color; crystalColor: Color;
}

const _m = new Matrix4();
const _q = new Quaternion();
const _e = new Euler();
const _p = new Vector3();
const _s = new Vector3();
const _c = new Color();
const WHITE = new Color(0xffffff);

function noise1(t: number, seed: number): number {
  return Math.sin(t * 7.3 + seed * 12.9) * 0.5 + Math.sin(t * 13.7 + seed * 4.1) * 0.3 + Math.sin(t * 23.1 + seed * 7.7) * 0.2;
}

export class LevelView {
  readonly group = new Group();
  readonly lights = new Group();
  readonly sun: DirectionalLight;
  /** Current room size (0 when no room is built; the diorama also reports 0). */
  width = 0;
  depth = 0;
  biome: BiomeId = 'crypt';
  /** True while the wardrobe diorama is built instead of a chamber. */
  diorama = false;
  fogColor = new Color(PALETTE.fog);

  private readonly assets: Assets;
  private readonly material: MeshLambertMaterial;
  private readonly miscMaterial: MeshLambertMaterial;
  private readonly crystalMaterial: MeshBasicMaterial;
  private readonly detailMaterial: MeshBasicMaterial;
  private readonly skirtMaterial: MeshBasicMaterial;
  private readonly crystalGeometry: BufferGeometry;
  private readonly hemi: HemisphereLight;
  private readonly torchLights: PointLight[] = [];
  private readonly torchBase: number[] = [0, 0, 0, 0];
  readonly stoneUv: [number, number];
  private water: WaterMaterial | null = null;
  private lava: LavaMaterial | null = null;
  private built: (InstancedMesh | Mesh)[] = [];
  private ownedGeometries: BufferGeometry[] = [];
  private flames: Flame[] = [];
  private glows: Glow[] = [];
  private torchColor = new Color(PALETTE.torch);
  private roomKey = '';
  private receiveShadow = false;

  constructor(assets: Assets) {
    this.assets = assets;
    this.material = createLevelMaterial(assets.dungeonMap);
    this.miscMaterial = createLevelMaterial(assets.dungeonMap);
    this.miscMaterial.vertexColors = true;
    this.crystalMaterial = new MeshBasicMaterial({ vertexColors: true });
    this.detailMaterial = new MeshBasicMaterial({ vertexColors: true, side: DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
    this.skirtMaterial = new MeshBasicMaterial({ vertexColors: true, fog: false, side: DoubleSide });

    const shard = new ConeGeometry(0.17, 1, 5).toNonIndexed();
    shard.translate(0, 0.5, 0);
    shard.computeVertexNormals();
    const pos = shard.getAttribute('position');
    const nrm = shard.getAttribute('normal');
    const col = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const facet = 0.62 + 0.38 * Math.max(0, nrm.getX(i) * 0.5 + nrm.getZ(i) * 0.7 + 0.3);
      const v = (0.4 + 0.6 * pos.getY(i)) * facet;
      col[i * 3] = v; col[i * 3 + 1] = v; col[i * 3 + 2] = v;
    }
    shard.setAttribute('color', new BufferAttribute(col, 3));
    this.crystalGeometry = shard;

    // A stone-coloured texel of the kit atlas for procedural additions (throne, brazier bowls).
    const pillar = assets.piece('pillar');
    const pp = pillar.getAttribute('position');
    const pu = pillar.getAttribute('uv');
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < pp.count; i++) {
      const d = Math.abs(pp.getY(i) - 2);
      if (d < bestD) { bestD = d; best = i; }
    }
    this.stoneUv = [pu.getX(best), pu.getY(best)];

    this.hemi = new HemisphereLight(0xffffff, 0x000000, 1);
    this.sun = new DirectionalLight(0xffffff, 1);
    this.sun.shadow.mapSize.set(SHADOW.MAP_SIZE, SHADOW.MAP_SIZE);
    this.sun.shadow.bias = SHADOW.BIAS;
    this.sun.shadow.normalBias = SHADOW.NORMAL_BIAS;
    this.lights.add(this.hemi, this.sun, this.sun.target);
    for (let i = 0; i < 4; i++) {
      const light = new PointLight(PALETTE.torch, 0, CFG.LIGHT_DISTANCE, CFG.LIGHT_DECAY);
      this.torchLights.push(light);
      this.lights.add(light);
    }
    this.applyMood(MOODS.crypt.combat);
  }

  /** Rebuilds only when the room, biome, chamber kind or index actually changed. Returns true when rebuilt. */
  setRoom(room: RoomLayout | null, kind: ChamberKind, index: number): boolean {
    const biome: BiomeId = room && room.biome in MOODS ? room.biome : 'crypt';
    const key = room ? `${room.seed}:${room.w}:${room.d}:${room.obstacles.length}:${biome}:${kind}:${index}` : '';
    if (key === this.roomKey) return false;
    this.roomKey = key;
    this.clear();
    if (room) this.build(room, biome, kind, index);
    return true;
  }

  /** Builds (or removes) the wardrobe pedestal scene. Returns true when something changed. */
  setDiorama(on: boolean): boolean {
    const key = on ? 'diorama' : '';
    if (key === this.roomKey || (!on && !this.diorama)) return false;
    this.roomKey = key;
    this.clear();
    if (on) this.buildDiorama();
    return true;
  }

  applyQuality(q: QualityProfile): void {
    this.sun.castShadow = q.shadows;
    this.receiveShadow = q.shadows;
    for (const mesh of this.built) mesh.receiveShadow = q.shadows && mesh.userData.receive !== false;
    this.torchLights.forEach((light, i) => { light.visible = i < q.pointLights; });
  }

  /** Per-frame: torch flicker and all emissive sprites of the level (flames, crystal glows, light pools). */
  emit(fx: BillboardBatch, decals: DecalBatch, time: number): void {
    const t = this.torchColor;
    for (let i = 0; i < this.torchLights.length; i++) {
      this.torchLights[i].intensity = this.torchBase[i] * (1 + 0.09 * noise1(time, i + 1));
    }
    if (this.water) {
      this.water.material.uniforms.uTime.value = time;
      for (let i = 0; i < this.torchLights.length; i++) {
        const l = this.torchLights[i];
        this.water.setLight(i, l.position.x, l.position.y, l.position.z, l.visible ? l.intensity * 0.02 : 0);
      }
    }
    if (this.lava) this.lava.material.uniforms.uTime.value = time;
    for (const f of this.flames) {
      const flick = 1 + 0.1 * noise1(time, f.seed);
      fx.push(SPRITE.FLAME, f.x, f.y + f.size * 0.42, f.z, f.size * 0.8 * flick, f.size * 1.25 * flick, t.r * 1.7, t.g * 1.7, t.b * 1.7, 1, 0.75, f.seed);
      fx.push(SPRITE.GLOW, f.x, f.y + f.size * 0.3, f.z, f.size * 4.2, f.size * 4.2, t.r, t.g, t.b, 0.3 * flick, 1, 0);
      if (f.pool > 0) decals.push(DECAL.DISC, f.x, 0.03, f.z + f.pool * 0.25, 0, f.pool * 2, f.pool * 2, t.r, t.g, t.b, 0.16 * flick, 1, 0);
    }
    for (const g of this.glows) {
      const pulse = 0.75 + 0.25 * Math.sin(time * 1.7 + g.seed * 6.283);
      fx.push(SPRITE.GLOW, g.x, g.y, g.z, g.size * 3.2, g.size * 3.2, g.r, g.g, g.b, 0.3 * pulse, 1, 0.4);
      decals.push(DECAL.DISC, g.x, 0.03, g.z, 0, g.size * 3.4, g.size * 3.4, g.r, g.g, g.b, 0.2 * pulse, 1, 0);
    }
  }

  /** Random crystal position for sparkle particles; returns false when the room has none. */
  sampleGlow(pick: number, out: { x: number; y: number; z: number; r: number; g: number; b: number }): boolean {
    if (this.glows.length === 0) return false;
    const g = this.glows[Math.min(this.glows.length - 1, Math.floor(pick * this.glows.length))];
    out.x = g.x; out.y = g.y; out.z = g.z; out.r = g.r; out.g = g.g; out.b = g.b;
    return true;
  }

  sampleFlame(pick: number, out: { x: number; y: number; z: number; r: number; g: number; b: number }): boolean {
    if (this.flames.length === 0) return false;
    const f = this.flames[Math.min(this.flames.length - 1, Math.floor(pick * this.flames.length))];
    out.x = f.x; out.y = f.y + f.size; out.z = f.z;
    out.r = this.torchColor.r; out.g = this.torchColor.g; out.b = this.torchColor.b;
    return true;
  }

  clear(): void {
    for (const mesh of this.built) {
      this.group.remove(mesh);
      if ((mesh as InstancedMesh).isInstancedMesh) (mesh as InstancedMesh).dispose();
    }
    for (const geo of this.ownedGeometries) geo.dispose();
    this.water?.material.dispose();
    this.lava?.material.dispose();
    this.water = null;
    this.lava = null;
    this.built = [];
    this.ownedGeometries = [];
    this.flames = [];
    this.glows = [];
    this.width = 0;
    this.depth = 0;
    this.diorama = false;
    for (let i = 0; i < 4; i++) this.torchBase[i] = 0;
  }

  dispose(): void {
    this.clear();
    this.roomKey = '';
    this.material.dispose();
    this.miscMaterial.dispose();
    this.crystalMaterial.dispose();
    this.detailMaterial.dispose();
    this.skirtMaterial.dispose();
    this.crystalGeometry.dispose();
    this.sun.shadow.map?.dispose();
    this.sun.dispose();
    this.hemi.dispose();
    for (const light of this.torchLights) light.dispose();
  }

  // ------------------------------------------------------------------ build

  private applyMood(mood: Mood): void {
    this.hemi.color.setHex(mood.hemiSky);
    this.hemi.groundColor.setHex(mood.hemiGround);
    this.hemi.intensity = mood.hemiIntensity;
    this.sun.color.setHex(mood.dirColor);
    this.sun.intensity = mood.dirIntensity;
    this.torchColor.setHex(mood.torch);
    for (const light of this.torchLights) { light.color.setHex(mood.torch); light.distance = CFG.LIGHT_DISTANCE; }
    this.fogColor.setHex(mood.fog);
  }

  /** Shared scaffolding of a build: piece bins, crystal instances, flames, glows and the final mesh assembly. */
  private begin(seed: number, biome: BiomeId, mood: Mood): { b: Build; finish: () => void } {
    const rng = createRng(seed);
    const bins = new Map<string, PieceBin>();
    const crystals: number[] = [];
    const crystalColors: number[] = [];
    const extra: BufferGeometry[] = [];
    const detail = { positions: [] as number[], colors: [] as number[] };
    const crystalColor = new Color(mood.crystal);

    const put: Put = (piece, x, y, z, rotY = 0, sx = 1, sy = 1, sz = 1, tint = WHITE, shade = 1) => {
      let bin = bins.get(piece);
      if (!bin) { bin = { matrices: [], colors: [] }; bins.set(piece, bin); }
      _m.compose(_p.set(x, y, z), _q.setFromEuler(_e.set(0, rotY, 0)), _s.set(sx, sy, sz));
      for (let i = 0; i < 16; i++) bin.matrices.push(_m.elements[i]);
      bin.colors.push(tint.r * shade, tint.g * shade, tint.b * shade);
    };
    const glow = (x: number, y: number, z: number, size: number, color: Color): void => {
      this.glows.push({ x, y, z, size, r: color.r, g: color.g, b: color.b, seed: rng.next() });
    };
    const cluster: AddCluster = (x, y, z, scale, count, color = crystalColor) => {
      for (let i = 0; i < count; i++) {
        const a = rng.range(0, Math.PI * 2);
        const r = i === 0 ? 0 : rng.range(0.12, 0.38) * scale;
        const tilt = i === 0 ? rng.range(0, 0.12) : rng.range(0.2, 0.62);
        const h = (i === 0 ? rng.range(1.1, 1.45) : rng.range(0.45, 0.95)) * scale;
        _q.setFromEuler(_e.set(Math.cos(a) * tilt, rng.range(0, 6.28), -Math.sin(a) * tilt));
        _m.compose(_p.set(x + Math.sin(a) * r, y, z + Math.cos(a) * r), _q, _s.set(scale * 1.15, h, scale * 1.15));
        for (let k = 0; k < 16; k++) crystals.push(_m.elements[k]);
        const v = CFG.CRYSTAL_GLOW * rng.range(0.8, 1.15);
        crystalColors.push(color.r * v, color.g * v, color.b * v);
      }
      glow(x, y + 0.6 * scale, z, scale, color);
    };
    const flame: AddFlame = (x, y, z, size, pool) => {
      this.flames.push({ x, y, z, size, seed: rng.next(), pool });
    };

    const finish = (): void => {
      const merged: BufferGeometry[] = [...extra];
      for (const [piece, bin] of bins) {
        const count = bin.matrices.length / 16;
        const geometry = this.assets.piece(piece);
        if (count >= CFG.INSTANCE_MIN) {
          const mesh = new InstancedMesh(geometry, this.material, count);
          for (let i = 0; i < count; i++) {
            mesh.setMatrixAt(i, _m.fromArray(bin.matrices, i * 16));
            mesh.setColorAt(i, _c.fromArray(bin.colors, i * 3));
          }
          mesh.instanceMatrix.needsUpdate = true;
          if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
          mesh.computeBoundingSphere();
          this.addBuilt(mesh);
        } else {
          for (let i = 0; i < count; i++) {
            const geo = geometry.clone();
            geo.applyMatrix4(_m.fromArray(bin.matrices, i * 16));
            paint(geo, bin.colors[i * 3], bin.colors[i * 3 + 1], bin.colors[i * 3 + 2]);
            merged.push(geo);
          }
        }
      }
      if (merged.length > 0) {
        const geo = mergeGeometries(merged, false);
        for (const g of merged) g.dispose();
        if (geo) {
          this.ownedGeometries.push(geo);
          this.addBuilt(new Mesh(geo, this.miscMaterial));
        }
      }
      if (crystals.length > 0) {
        const count = crystals.length / 16;
        const mesh = new InstancedMesh(this.crystalGeometry, this.crystalMaterial, count);
        for (let i = 0; i < count; i++) {
          mesh.setMatrixAt(i, _m.fromArray(crystals, i * 16));
          mesh.setColorAt(i, _c.fromArray(crystalColors, i * 3));
        }
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        mesh.computeBoundingSphere();
        this.addBuilt(mesh, false);
      }
      if (detail.positions.length > 0) {
        const geo = new BufferGeometry();
        geo.setAttribute('position', new BufferAttribute(new Float32Array(detail.positions), 3));
        geo.setAttribute('color', new BufferAttribute(new Float32Array(detail.colors), 3));
        this.ownedGeometries.push(geo);
        this.addBuilt(new Mesh(geo, this.detailMaterial), false);
      }
    };

    return {
      b: {
        rng, biome, mood, put, flame, cluster, glow, extra, detail,
        floorTint: new Color(mood.floorTint), wallTint: new Color(mood.wallTint), propTint: new Color(mood.propTint), crystalColor,
      },
      finish,
    };
  }

  private build(room: RoomLayout, biome: BiomeId, kind: ChamberKind, index: number): void {
    const mood = MOODS[biome][kind];
    this.applyMood(mood);
    this.biome = biome;
    const { b, finish } = this.begin(room.seed * 7919 + index * 131 + 17, biome, mood);
    const { rng, put, flame, cluster, floorTint, wallTint, propTint } = b;
    const w = room.w;
    const d = room.d;
    const hw = w / 2;
    const hd = d / 2;
    this.width = w;
    this.depth = d;
    const mossTint = new Color(BIOME[biome].moss);

    // ---------------------------------------------------------------- floor
    const nx = Math.max(1, Math.round(w / CFG.FLOOR_CELL));
    const nz = Math.max(1, Math.round(d / CFG.FLOOR_CELL));
    const cx = w / nx;
    const cz = d / nz;
    const used = new Uint8Array(nx * nz);
    const DIRT_SMALL = ['floor_dirt_small_A', 'floor_dirt_small_B', 'floor_dirt_small_C', 'floor_dirt_small_D'];
    for (let iz = 0; iz < nz; iz++) {
      for (let ix = 0; ix < nx; ix++) {
        if (used[iz * nx + ix]) continue;
        const shade = rng.range(0.9, 1.08);
        const canLarge = ix + 1 < nx && iz + 1 < nz && !used[iz * nx + ix + 1];
        // the forge keeps a paved walkway down the middle and around the rim; the rest is trodden dirt
        const rim = ix === 0 || iz === 0 || ix >= nx - 2 || iz >= nz - 2;
        const dirt = biome === 'forge' && !rim && Math.abs(ix - nx / 2 + 0.5) > 1.6;
        if (canLarge && rng.chance(biome === 'flooded' ? 0.35 : 0.55)) {
          used[iz * nx + ix] = used[iz * nx + ix + 1] = used[(iz + 1) * nx + ix] = used[(iz + 1) * nx + ix + 1] = 1;
          const piece = dirt ? (rng.chance(0.4) ? 'floor_dirt_large_rocky' : 'floor_dirt_large')
            : biome === 'crypt' && rng.chance(0.07) ? 'floor_dirt_large' : 'floor_tile_large';
          put(piece, (ix + 1) * cx - hw, CFG.FLOOR_Y, (iz + 1) * cz - hd, 0, cx / 2, 1, cz / 2, floorTint, dirt ? shade * 0.92 : shade);
          continue;
        }
        used[iz * nx + ix] = 1;
        const roll = rng.next();
        const turns = rng.int(4);
        const odd = turns % 2 === 1;
        let piece: string;
        let tint = floorTint;
        if (dirt) piece = rng.pick(DIRT_SMALL);
        else if (biome === 'flooded') {
          // drowned tiles: half of them cracked or overgrown, the overgrown ones stained green
          piece = roll < 0.14 ? 'floor_tile_small_broken_A' : roll < 0.28 ? 'floor_tile_small_broken_B'
            : roll < 0.44 ? 'floor_tile_small_weeds_A' : roll < 0.6 ? 'floor_tile_small_weeds_B' : 'floor_tile_small';
          if (roll >= 0.28 && roll < 0.72) tint = _c.copy(floorTint).lerp(mossTint, rng.range(0.25, 0.7)).clone();
        } else {
          piece = roll < 0.06 ? 'floor_tile_small_broken_A' : roll < 0.12 ? 'floor_tile_small_broken_B'
            : roll < 0.16 ? 'floor_tile_small_weeds_A' : roll < 0.2 ? 'floor_tile_small_weeds_B' : 'floor_tile_small';
        }
        put(piece, (ix + 0.5) * cx - hw, CFG.FLOOR_Y, (iz + 0.5) * cz - hd, turns * Math.PI / 2,
          (odd ? cz : cx) / 2, 1, (odd ? cx : cz) / 2, tint, shade);
      }
    }
    if (biome === 'forge') this.forgeCracks(b, hw, hd);
    if (biome === 'flooded') this.mossPatches(b, hw, hd, mossTint);

    // ---------------------------------------------------------------- walls
    const nSeg = Math.max(1, Math.round(w / WALL.LENGTH));
    const seg = w / nSeg;
    const mSeg = Math.max(1, Math.round(d / WALL.LENGTH));
    const segZ = d / mSeg;
    const northZ = -hd - WALL.THICKNESS / 2;
    const alcoveSegs = kind === 'boss' && nSeg >= 5 ? (nSeg % 2 === 1 ? 3 : 2) : 0;
    const alcoveFirst = (nSeg - alcoveSegs) / 2;
    const torchSpots: { x: number; z: number; rot: number }[] = [];

    for (let i = 0; i < nSeg; i++) {
      const x = -hw + (i + 0.5) * seg;
      const sx = seg / WALL.LENGTH;
      const shade = rng.range(0.93, 1.05);
      if (alcoveSegs > 0 && i >= alcoveFirst && i < alcoveFirst + alcoveSegs) continue;
      let piece = 'wall';
      const centre = Math.abs(i - (nSeg - 1) / 2) < 0.6;
      if (kind === 'elite' && centre) piece = 'wall_gated';
      else {
        const roll = rng.next();
        if (biome === 'flooded') {
          if (roll < 0.2) piece = 'wall_arched';
          else if (roll < 0.36) piece = 'wall_cracked';
          else if (roll < 0.5) piece = 'wall_archedwindow_gated';
          else if (roll < 0.62) piece = 'wall_pillar';
        } else if (biome === 'forge') {
          if (roll < 0.24) piece = 'wall_pillar';
          else if (roll < 0.38) piece = 'wall_gated';
          else if (roll < 0.5) piece = 'wall_shelves';
          else if (roll < 0.58) piece = 'wall_cracked';
        } else if (roll < 0.2) piece = 'wall_pillar';
        else if (roll < 0.32) piece = 'wall_arched';
        else if (roll < 0.4) piece = 'wall_window_closed';
        else if (roll < 0.47) piece = 'wall_shelves';
        else if (roll < 0.53) piece = 'wall_cracked';
      }
      put(piece, x, 0, northZ, 0, sx, 1, 1, wallTint, shade);
      const plain = piece === 'wall' || piece === 'wall_cracked';
      if (plain) {
        const bannerChance = biome === 'crypt' ? 0.62 : 0.4;
        if (rng.chance(bannerChance)) put(rng.pick(mood.banners), x, 0, northZ, 0, 1, 1, 1, WHITE, biome === 'flooded' ? 0.7 : 0.95);
        else if (rng.chance(biome === 'forge' ? 0.85 : 0.5)) put(rng.pick(['sword_shield', 'sword_shield_gold', 'sword_shield_broken']), x, 2.3, -hd + 0.08, 0, 1, 1, 1, propTint);
        else if (biome !== 'crypt') this.chain(b, x + rng.range(-0.8, 0.8), 3.9, -hd + 0.16, rng.range(1.2, 2.1), true);
      }
      if (biome !== 'crypt' && !plain && rng.chance(0.5)) this.chain(b, x + rng.range(-1.2, 1.2), 3.9, -hd + 0.16, rng.range(0.9, 1.8), biome === 'flooded');
      // small trinkets hugging the wall (never out in the walkable lanes)
      if (biome === 'crypt') {
        if (rng.chance(0.45)) {
          const cxp = x + rng.range(-1.4, 1.4);
          const triple = rng.chance(0.6);
          put(triple ? 'candle_triple' : 'candle_lit', cxp, 0, -hd + 0.28, rng.range(0, 6.28), 1, 1, 1, propTint);
          flame(cxp + (triple ? 0.05 : 0), triple ? 0.82 : 1.0, -hd + 0.3, 0.2, 0);
        }
        if (rng.chance(0.18)) put('coin_stack_medium', x + rng.range(-1.5, 1.5), 0, -hd + 0.45, rng.range(0, 6.28), 0.8, 0.8, 0.8, propTint);
        if (rng.chance(0.15)) put('bottle_A_green', x + rng.range(-1.6, 1.6), 0, -hd + 0.25, rng.range(0, 6.28), 1, 1, 1, propTint);
      } else if (biome === 'flooded') {
        if (rng.chance(0.5)) put('candle_melted', x + rng.range(-1.5, 1.5), 0, -hd + 0.3, rng.range(0, 6.28), 1.1, 1.1, 1.1, propTint, 0.8);
        if (rng.chance(0.45)) cluster(x + rng.range(-1.5, 1.5), 0, -hd + 0.35, rng.range(0.3, 0.5), 3);
      } else {
        if (rng.chance(0.4)) put('coin_stack_small', x + rng.range(-1.5, 1.5), 0, -hd + 0.4, rng.range(0, 6.28), 1, 1, 1, propTint);
        if (rng.chance(0.4)) this.coals(b, x + rng.range(-1.4, 1.4), -hd + 0.45, rng.range(0.3, 0.45));
      }
    }
    for (let i = 1; i < nSeg; i++) {
      if (alcoveSegs > 0 && i >= alcoveFirst && i <= alcoveFirst + alcoveSegs) continue;
      if (i % 2 === 1 || nSeg <= 3) torchSpots.push({ x: -hw + i * seg, z: -hd, rot: 0 });
    }

    for (const side of [-1, 1]) {
      const x = side * (hw + WALL.THICKNESS / 2);
      const rot = side < 0 ? Math.PI / 2 : -Math.PI / 2;
      for (let j = 0; j < mSeg; j++) {
        const z = -hd + (j + 0.5) * segZ;
        const roll = rng.next();
        const piece = roll < 0.25 ? 'wall_pillar' : roll < 0.33 ? 'wall_arched' : biome === 'flooded' && roll < 0.5 ? 'wall_cracked' : 'wall';
        put(piece, x, 0, z, rot, segZ / WALL.LENGTH, 1, 1, wallTint, rng.range(0.9, 1.02));
        if (piece === 'wall' && rng.chance(0.4)) put(rng.pick(mood.banners), x, 0, z, rot, 1, 1, 1, WHITE, biome === 'flooded' ? 0.7 : 0.9);
      }
      const torchCount = mSeg >= 5 ? 2 : 1;
      for (let k = 0; k < torchCount; k++) {
        const j = Math.max(1, Math.round((mSeg * (k + 1)) / (torchCount + 1)));
        torchSpots.push({ x: side * hw, z: -hd + j * segZ, rot });
      }
      // north corners: full pillars; south corners: cut down so they never hide the party
      put('pillar', x, 0, northZ, 0, 1, 1, 1, wallTint);
      put('pillar', x, 0, hd + WALL.THICKNESS / 2, 0, 1, 0.42, 1, wallTint, 0.9);
    }
    // south side: low cut-away curb
    for (let i = 0; i < nSeg; i++) {
      put('barrier', -hw + (i + 0.5) * seg, 0, hd + 0.25, 0, seg / WALL.LENGTH, WALL.CURB_HEIGHT / 1.1, 1, wallTint, 0.85);
    }

    // ---------------------------------------------------------------- torches + real lights
    for (const spot of torchSpots) {
      put('torch_mounted', spot.x, CFG.TORCH_Y, spot.z, spot.rot, 1.25, 1.25, 1.25, propTint);
      const fx = spot.x + Math.sin(spot.rot) * CFG.TORCH_FLAME.z * 1.25;
      const fz = spot.z + Math.cos(spot.rot) * CFG.TORCH_FLAME.z * 1.25;
      flame(fx, CFG.TORCH_Y + CFG.TORCH_FLAME.y * 1.25, fz, 0.62, 2.6);
    }
    const lightTargets = [
      { x: -hw * 0.5, z: -hd }, { x: hw * 0.5, z: -hd }, { x: -hw, z: hd * 0.15 }, { x: hw, z: hd * 0.15 },
    ];
    lightTargets.forEach((target, i) => {
      let best = torchSpots[0];
      let bestD = Infinity;
      for (const spot of torchSpots) {
        const dist = (spot.x - target.x) ** 2 + (spot.z - target.z) ** 2;
        if (dist < bestD) { bestD = dist; best = spot; }
      }
      const light = this.torchLights[i];
      if (!best) { this.torchBase[i] = 0; return; }
      light.position.set(
        best.x + Math.sin(best.rot) * CFG.LIGHT_INSET, CFG.LIGHT_HEIGHT, best.z + Math.cos(best.rot) * CFG.LIGHT_INSET,
      );
      this.torchBase[i] = mood.torchIntensity;
    });
    if (biome === 'forge') {
      // the foundry is lit from below: the two side lights sink to the lava in front of the party
      const lavaHot = BIOME.forge.lava.hot;
      [-1, 1].forEach((side, k) => {
        const light = this.torchLights[2 + k];
        light.position.set(side * hw * 0.55, 0.9, hd + 2.2);
        light.color.setHex(lavaHot);
        light.distance = CFG.LIGHT_DISTANCE * 1.5;
        this.torchBase[2 + k] = mood.torchIntensity * 0.95;
      });
    }

    // ---------------------------------------------------------------- obstacles
    for (const o of room.obstacles) this.placeObstacle(o, b);

    // ---------------------------------------------------------------- accents
    cluster(-hw + 0.75, 0, -hd + 0.75, 1.0, 5);
    cluster(hw - 0.75, 0, -hd + 0.75, 0.9, 4);
    for (const side of [-1, 1]) {
      for (let j = 1; j < mSeg; j++) {
        if (rng.chance(biome === 'flooded' ? 0.55 : 0.3)) cluster(side * (hw - 0.45), 0, -hd + j * segZ + rng.range(-1, 1), rng.range(0.45, 0.7), 3);
        else if (biome === 'forge' && rng.chance(0.5)) this.coals(b, side * (hw - 0.5), -hd + j * segZ + rng.range(-1, 1), rng.range(0.35, 0.5));
      }
    }
    this.foreground(b, nSeg, seg, hw, hd);

    if (alcoveSegs > 0) this.buildThrone(alcoveSegs * seg, hd, b);

    // ---------------------------------------------------------------- ground beyond the walls
    const north = alcoveSegs > 0 ? CFG.ALCOVE_DEPTH + 1 : 0;
    const ledgeSouth = BIOME[biome].ledgeSouth;
    this.addBuilt(new Mesh(this.buildSkirt(w, d, north, ledgeSouth, mood, biome === 'crypt'), this.skirtMaterial), false);
    if (biome === 'flooded') {
      const cfg = BIOME.flooded.water;
      this.water = createWaterMaterial();
      this.water.setColors(cfg.deep, cfg.shallow, cfg.glint);
      this.water.setRoom(hw, hd);
      const geo = new PlaneGeometry(w + cfg.margin * 2, d + cfg.margin * 2);
      geo.rotateX(-Math.PI / 2);
      geo.translate(0, cfg.y, 0);
      this.ownedGeometries.push(geo);
      const mesh = new Mesh(geo, this.water.material);
      mesh.renderOrder = 1;
      this.addBuilt(mesh, false);
    } else if (biome === 'forge') {
      const cfg = BIOME.forge.lava;
      this.lava = createLavaMaterial();
      this.lava.setColors(cfg.hot, cfg.crust, kind === 'boss' ? cfg.heat * 1.15 : cfg.heat);
      const geo = new PlaneGeometry(w + cfg.margin * 2, d + cfg.margin * 2);
      geo.rotateX(-Math.PI / 2);
      geo.translate(0, cfg.y, 0);
      this.ownedGeometries.push(geo);
      this.addBuilt(new Mesh(geo, this.lava.material), false);
      // the glow of the channels on everything that stands near the edge
      const hot = new Color(cfg.hot);
      for (let i = 0; i < nSeg; i++) b.glow(-hw + (i + 0.5) * seg, 0.2, hd + ledgeSouth + 1.2, 2.6, hot);
      for (const side of [-1, 1]) for (let j = 0; j < mSeg; j += 2) b.glow(side * (hw + 3.2), 0.2, -hd + (j + 0.5) * segZ, 2.4, hot);
    }

    finish();

    // shadow frustum covers the whole room
    const radius = Math.hypot(hw, hd) + 3;
    this.sun.position.set(CFG.SUN_DIR[0], CFG.SUN_DIR[1], CFG.SUN_DIR[2]).normalize().multiplyScalar(radius + 20);
    this.sun.target.position.set(0, 0, 0);
    this.sun.target.updateMatrixWorld();
    const cam = this.sun.shadow.camera;
    cam.left = -radius; cam.right = radius; cam.top = radius; cam.bottom = -radius;
    cam.near = 5; cam.far = radius * 2 + 40;
    cam.updateProjectionMatrix();
  }

  private addBuilt(mesh: InstancedMesh | Mesh, receive = true): void {
    mesh.userData.receive = receive;
    mesh.receiveShadow = this.receiveShadow && receive;
    mesh.matrixAutoUpdate = false;
    this.built.push(mesh);
    this.group.add(mesh);
  }

  // ------------------------------------------------------------------ biome dressing

  /** Adds a flat quad strip segment (a..b, `width` wide) to the unlit floor-detail mesh. */
  private strip(b: Build, ax: number, az: number, bx: number, bz: number, width: number, r: number, g: number, bl: number): void {
    const dx = bx - ax;
    const dz = bz - az;
    const len = Math.hypot(dx, dz) || 1;
    const nx = (-dz / len) * width * 0.5;
    const nz = (dx / len) * width * 0.5;
    const y = CFG.DETAIL_Y;
    b.detail.positions.push(ax - nx, y, az - nz, bx - nx, y, bz - nz, bx + nx, y, bz + nz, ax - nx, y, az - nz, bx + nx, y, bz + nz, ax + nx, y, az + nz);
    for (let i = 0; i < 6; i++) b.detail.colors.push(r, g, bl);
  }

  /** Glowing fissures in the foundry floor: jagged polylines that branch once. */
  private forgeCracks(b: Build, hw: number, hd: number): void {
    const { rng } = b;
    const hot = new Color(BIOME.forge.crack);
    const count = Math.round((hw * hd) / 9);
    for (let i = 0; i < count; i++) {
      let x = rng.range(-hw + 1, hw - 1);
      let z = rng.range(-hd + 1, hd - 1);
      let a = rng.range(0, Math.PI * 2);
      const heat = rng.range(1.1, 2.0);
      const segs = 3 + rng.int(4);
      for (let k = 0; k < segs; k++) {
        a += rng.range(-0.9, 0.9);
        const len = rng.range(0.6, 1.5);
        const ex = Math.max(-hw + 0.3, Math.min(hw - 0.3, x + Math.sin(a) * len));
        const ez = Math.max(-hd + 0.3, Math.min(hd - 0.3, z + Math.cos(a) * len));
        const fade = heat * (1 - (k / segs) * 0.55);
        this.strip(b, x, z, ex, ez, rng.range(0.07, 0.14) * (1 - (k / segs) * 0.4), hot.r * fade, hot.g * fade, hot.b * fade);
        if (k === 1 && rng.chance(0.5)) {
          const ba = a + rng.pick([-1, 1]) * rng.range(0.7, 1.2);
          this.strip(b, x, z, x + Math.sin(ba) * len * 0.7, z + Math.cos(ba) * len * 0.7, 0.09, hot.r * fade * 0.8, hot.g * fade * 0.8, hot.b * fade * 0.8);
        }
        x = ex; z = ez;
      }
      if (i % 3 === 0) b.glow(x, 0.15, z, 0.55, hot);
    }
  }

  /** Dark algae mats under the water, drawn as flat fans. */
  private mossPatches(b: Build, hw: number, hd: number, moss: Color): void {
    const { rng } = b;
    const count = Math.round((hw * hd) / 7);
    for (let i = 0; i < count; i++) {
      const x = rng.range(-hw + 0.8, hw - 0.8);
      const z = rng.range(-hd + 0.8, hd - 0.8);
      const r = rng.range(0.35, 1.0);
      const shade = rng.range(0.06, 0.13);
      const n = 6;
      const first = r * rng.range(0.6, 1.1);
      let px = x;
      let pz = z + first;
      for (let k = 1; k <= n; k++) {
        const a = (k / n) * Math.PI * 2;
        const rr = k === n ? first : r * rng.range(0.6, 1.1);
        const ex = x + Math.sin(a) * rr;
        const ez = z + Math.cos(a) * rr;
        b.detail.positions.push(x, CFG.DETAIL_Y, z, px, CFG.DETAIL_Y, pz, ex, CFG.DETAIL_Y, ez);
        for (let v = 0; v < 3; v++) b.detail.colors.push(moss.r * shade, moss.g * shade, moss.b * shade);
        px = ex; pz = ez;
      }
    }
  }

  /** Iron chain hanging down a wall face, optionally ending in a lantern cage (flooded) or a hook. */
  private chain(b: Build, x: number, yTop: number, z: number, length: number, lantern: boolean): void {
    const iron = _c.setHex(CFG.IRON).clone();
    const links = Math.max(2, Math.round(length / CFG.CHAIN_LINK));
    for (let i = 0; i < links; i++) {
      const link = new BoxGeometry(i % 2 === 0 ? 0.13 : 0.045, CFG.CHAIN_LINK * 1.15, i % 2 === 0 ? 0.045 : 0.13);
      link.translate(x, yTop - (i + 0.5) * CFG.CHAIN_LINK, z);
      b.extra.push(this.solid(link, iron, i % 2 === 0 ? 1 : 0.8));
    }
    const yEnd = yTop - links * CFG.CHAIN_LINK;
    if (lantern) {
      const cage = new CylinderGeometry(0.16, 0.2, 0.36, 5);
      cage.translate(x, yEnd - 0.18, z);
      b.extra.push(this.solid(cage, iron, 1.1));
      b.flame(x, yEnd - 0.3, z + 0.12, 0.34, 0);
    } else {
      const hook = new ConeGeometry(0.1, 0.3, 4);
      hook.rotateX(Math.PI);
      hook.translate(x, yEnd - 0.15, z);
      b.extra.push(this.solid(hook, iron, 1.3));
    }
  }

  /** A heap of glowing coals (forge): low ember crystals with a warm pool. */
  private coals(b: Build, x: number, z: number, scale: number): void {
    b.cluster(x, -0.1 * scale, z, scale, 4);
  }

  /** Silhouettes beyond the south curb (outside the walkable area): what the place is made of, seen up close. */
  private foreground(b: Build, nSeg: number, seg: number, hw: number, hd: number): void {
    const { rng, put, cluster, propTint, wallTint } = b;
    for (let i = 0; i < nSeg; i++) {
      if (!rng.chance(b.biome === 'crypt' ? 0.55 : 0.75)) continue;
      const x = -hw + (i + rng.range(0.2, 0.8)) * seg;
      const z = hd + rng.range(1.5, 2.6);
      const roll = rng.next();
      if (b.biome === 'flooded') {
        if (roll < 0.3) put('column', x, -0.1, z, rng.range(0, 6.28), 1.5, rng.range(0.25, 0.7), 1.5, wallTint, 0.7);
        else if (roll < 0.5) this.stalagmite(b, x, z, rng.range(0.5, 0.8), 0.75);
        else if (roll < 0.7) this.sarcophagus(b, x, z, rng.range(0.9, 1.1), rng.range(-0.3, 0.3), 0.7, -0.22);
        else cluster(x, -0.05, z, rng.range(0.7, 1.0), 4);
      } else if (b.biome === 'forge') {
        const fz = hd + rng.range(1.6, 3.2);
        if (roll < 0.22) put('keg', x, 0, fz, rng.range(-0.5, 0.5), 1.2, 1.2, 1.2, propTint, 0.75);
        else if (roll < 0.4) put('keg_decorated', x, 0, fz, rng.range(-0.5, 0.5), 1.2, 1.2, 1.2, propTint, 0.75);
        else if (roll < 0.58) this.anvil(b, x, fz, 0.7, rng.range(0, 6.28), 0.8);
        else if (roll < 0.72) put('barrel_large_decorated', x, 0, fz, rng.range(0, 6.28), 1, 1, 1, propTint, 0.7);
        else if (roll < 0.86) this.coals(b, x, fz, rng.range(0.6, 0.9));
        else put('trunk_small_A', x, 0, fz, rng.range(0, 6.28), 1.3, 1.3, 1.3, propTint, 0.7);
      } else if (roll < 0.35) put('barrel_small', x, 0, z, rng.range(0, 6.28), 1.1, 1.1, 1.1, propTint, 0.6);
      else if (roll < 0.6) put('box_small', x, 0, z, rng.range(0, 6.28), 1.1, 1.1, 1.1, propTint, 0.6);
      else if (roll < 0.8) cluster(x, 0, z, rng.range(0.6, 0.9), 3);
      else put('box_large', x, 0, z, rng.range(0, 6.28), 0.9, 0.9, 0.9, propTint, 0.6);
    }
  }

  /** Lit box in obstacle-local space (rotated by `rot` around the obstacle centre). */
  private block(b: Build, ox: number, oz: number, rot: number, w: number, h: number, d: number, lx: number, ly: number, lz: number, tint: Color, shade: number): void {
    const geo = new BoxGeometry(w, h, d);
    geo.translate(lx, ly, lz);
    geo.rotateY(rot);
    geo.translate(ox, 0, oz);
    b.extra.push(this.solid(geo, tint, shade));
  }

  /** Stone coffin whose long side spans the collision circle. */
  private sarcophagus(b: Build, x: number, z: number, r: number, rot: number, shade: number, sink = 0): void {
    const stone = b.wallTint;
    const len = r * 1.9;
    const wid = r * 1.12;
    this.block(b, x, z, rot, len * 1.04, 0.2, wid * 1.08, 0, 0.1 + sink, 0, stone, shade * 0.8);
    this.block(b, x, z, rot, len * 0.94, 0.62, wid * 0.94, 0, 0.5 + sink, 0, stone, shade);
    this.block(b, x, z, rot, len, 0.16, wid, 0, 0.89 + sink, 0, stone, shade * 1.12);
    // ridged lid with a cross in relief
    const ridge = new CylinderGeometry(wid * 0.5, wid * 0.5, len * 0.92, 3, 1);
    ridge.rotateZ(Math.PI / 2);
    ridge.scale(1, 0.34, 1);
    ridge.rotateX(Math.PI);
    ridge.translate(0, 1.02 + sink, 0);
    ridge.rotateY(rot);
    ridge.translate(x, 0, z);
    b.extra.push(this.solid(ridge, stone, shade * 1.05));
    this.block(b, x, z, rot, len * 0.5, 0.07, wid * 0.14, -len * 0.08, 1.14 + sink, 0, stone, shade * 1.3);
    this.block(b, x, z, rot, wid * 0.14, 0.07, wid * 0.46, -len * 0.2, 1.14 + sink, 0, stone, shade * 1.3);
  }

  /** Cluster of rock spikes inside the collision circle. */
  private stalagmite(b: Build, x: number, z: number, r: number, shade: number): void {
    const { rng } = b;
    const rock = _c.copy(b.wallTint).multiplyScalar(0.82).clone();
    const count = 3 + rng.int(2);
    for (let i = 0; i < count; i++) {
      const main = i === 0;
      const a = rng.range(0, Math.PI * 2);
      const d = main ? r * 0.12 : r * rng.range(0.42, 0.6);
      const base = main ? r * 0.62 : r * rng.range(0.26, 0.38);
      const h = main ? r * rng.range(2.5, 3.1) : r * rng.range(0.9, 1.7);
      const cone = new ConeGeometry(base, h, 6);
      cone.translate(0, h / 2 - 0.05, 0);
      cone.rotateZ(main ? rng.range(-0.06, 0.06) : rng.range(-0.18, 0.18));
      cone.rotateY(rng.range(0, 6.28));
      cone.translate(x + Math.sin(a) * d, 0, z + Math.cos(a) * d);
      b.extra.push(this.solid(cone, rock, shade * rng.range(0.85, 1.1)));
    }
    const foot = new CylinderGeometry(r * 0.92, r, 0.16, 7);
    foot.translate(x, 0.08, z);
    b.extra.push(this.solid(foot, rock, shade * 0.75));
  }

  /** Anvil on a stump; the stump is the footprint. */
  private anvil(b: Build, x: number, z: number, r: number, rot: number, shade: number): void {
    const iron = _c.setHex(CFG.IRON).clone();
    const stump = new CylinderGeometry(r * 0.9, r * 0.98, 0.52, 8);
    stump.translate(x, 0.26, z);
    b.extra.push(this.solid(stump, b.propTint, shade * 0.62));
    const s = r / 0.75;
    this.block(b, x, z, rot, 0.62 * s, 0.14, 0.46 * s, 0, 0.59, 0, iron, shade * 1.1);
    this.block(b, x, z, rot, 0.36 * s, 0.24, 0.3 * s, 0, 0.78, 0, iron, shade * 0.95);
    this.block(b, x, z, rot, 0.98 * s, 0.24, 0.44 * s, 0.04 * s, 1.02, 0, iron, shade * 1.35);
    const horn = new ConeGeometry(0.2 * s, 0.56 * s, 6);
    horn.rotateZ(Math.PI / 2);
    horn.translate(-0.7 * s, 1.03, 0);
    horn.rotateY(rot);
    horn.translate(x, 0, z);
    b.extra.push(this.solid(horn, iron, shade * 1.35));
    // a billet left glowing on the face
    const hot = _c.setHex(BIOME.forge.crack).clone();
    b.glow(x + Math.cos(rot) * 0.12 * s, 1.2, z - Math.sin(rot) * 0.12 * s, 0.34, hot);
  }

  private placeObstacle(o: Obstacle, b: Build): void {
    const { rng, put, flame, cluster, extra, propTint, wallTint } = b;
    const r = o.r;
    const rot = rng.range(0, Math.PI * 2);
    switch (o.kind) {
      case 'pillar': {
        // kit pillar: 1.5 m square base. The square sits between the inscribed and circumscribed square of the circle.
        const s = (r * 1.7) / 1.5;
        put('pillar', o.x, 0, o.z, Math.round(rot / (Math.PI / 2)) * (Math.PI / 2), s, CFG.PILLAR_HEIGHT / 4, s, wallTint);
        break;
      }
      case 'column': {
        const s = r / 0.35;
        put('column', o.x, 0, o.z, rot, s, Math.min(s, 1.5), s, wallTint);
        if (rng.chance(0.5)) cluster(o.x, 1.4 * Math.min(s, 1.5), o.z, 0.38 * s, 3);
        break;
      }
      case 'barrels': {
        if (r < 0.7) put('barrel_small', o.x, 0, o.z, rot, r / 0.5, r / 0.5, r / 0.5, propTint);
        else if (r < 1.0) put('barrel_large', o.x, 0, o.z, rot, r / 0.9, r / 0.9, r / 0.9, propTint);
        else {
          const rho = r * 0.464;
          for (let i = 0; i < 3; i++) {
            const a = rot + (i / 3) * Math.PI * 2;
            const s = rho / 0.5;
            put('barrel_small', o.x + Math.sin(a) * (r - rho), 0, o.z + Math.cos(a) * (r - rho), rng.range(0, 6.28), s, s * rng.range(0.9, 1.15), s, propTint);
          }
        }
        break;
      }
      case 'crates': {
        if (r < 1.05) {
          const s = (r * 1.62) / 1.5;
          put('box_large', o.x, 0, o.z, rot, s, s, s, propTint);
          if (r > 0.75 && rng.chance(0.6)) put('box_small', o.x, 1.5 * s, o.z, rot + rng.range(0.3, 1.2), s * 0.8, s * 0.8, s * 0.8, propTint);
        } else {
          const s = (r * 0.95) / 1.1;
          put('crates_stacked', o.x, 0, o.z, rot, s, s, s, propTint);
        }
        break;
      }
      case 'rubble': {
        // rubble_half spans x 0..4, z -1.5..1.5: centre it and squash the height so it stays readable
        const s = r / 1.75;
        put('rubble_half', o.x - Math.cos(rot) * 2 * s, 0, o.z + Math.sin(rot) * 2 * s, rot, s, s * 0.5, s, propTint, 1.25);
        break;
      }
      case 'brazier': {
        const s = (r * 0.8) / 0.35;
        const h = 0.95;
        put('column', o.x, 0, o.z, rot, s, h / 1.4, s, wallTint);
        const bowl = new CylinderGeometry(r, r * 0.55, 0.36, 8);
        bowl.translate(o.x, h + 0.18, o.z);
        extra.push(this.solid(bowl, wallTint, 0.8));
        for (let i = 0; i < 3; i++) {
          const a = (i / 3) * Math.PI * 2 + rot;
          flame(o.x + Math.sin(a) * r * 0.3, h + 0.3, o.z + Math.cos(a) * r * 0.3, i === 0 ? 1.15 : 0.8, i === 0 ? 3.4 : 0);
        }
        break;
      }
      case 'sarcophagus':
        this.sarcophagus(b, o.x, o.z, r, rot, 1);
        if (rng.chance(0.6)) cluster(o.x + Math.cos(rot) * r * 0.7, 0, o.z - Math.sin(rot) * r * 0.7, 0.3, 3);
        break;
      case 'stalagmite':
        this.stalagmite(b, o.x, o.z, r, 1);
        break;
      case 'anvil':
        this.anvil(b, o.x, o.z, r, rot, 1);
        break;
      case 'crystal': {
        // the shards lean out to roughly 0.57 x scale from the centre: scale the cluster to the collision circle
        const base = new CylinderGeometry(r * 0.86, r * 0.98, 0.2, 7);
        base.translate(o.x, 0.1, o.z);
        extra.push(this.solid(base, wallTint, 0.7));
        cluster(o.x, 0.12, o.z, r / 0.57, 7);
        break;
      }
    }
  }

  private buildThrone(aw: number, hd: number, b: Build): void {
    const { rng, put, flame, cluster, extra, wallTint, floorTint, propTint, mood } = b;
    const depth = CFG.ALCOVE_DEPTH;
    const dais = CFG.DAIS_HEIGHT;
    const n = Math.round(aw / WALL.LENGTH);
    const seg = aw / n;
    const backZ = -hd - depth - WALL.THICKNESS / 2;
    for (let i = 0; i < n; i++) {
      const x = -aw / 2 + (i + 0.5) * seg;
      put('wall', x, 0, backZ, 0, seg / WALL.LENGTH, 1.15, 1, wallTint, 0.92);
      put('floor_tile_large', x, dais + CFG.FLOOR_Y, -hd - depth / 2, 0, seg / 4, 1, depth / 4, floorTint, 1.05);
      put('barrier', x, 0, -hd - 0.25, 0, seg / WALL.LENGTH, dais / 1.1, 1, wallTint, 1.05);
      if (i !== (n - 1) / 2) put(mood.banners[0], x, 0.6, backZ, 0, 1.1, 1.1, 1, WHITE, 0.95);
    }
    for (const side of [-1, 1]) {
      const x = side * (aw / 2 + WALL.THICKNESS / 2);
      put('wall', x, 0, -hd - depth / 2, side < 0 ? Math.PI / 2 : -Math.PI / 2, depth / WALL.LENGTH, 1.15, 1, wallTint, 0.9);
      put('pillar', x, 0, -hd - WALL.THICKNESS / 2, 0, 1, 1.15, 1, wallTint);
      put('pillar', x, 0, backZ, 0, 1, 1.15, 1, wallTint);
      // braziers on the dais corners
      const bx = side * (aw / 2 - 1.1);
      put('column', bx, dais, -hd - 0.95, 0, 1.3, 0.75, 1.3, wallTint);
      const bowl = new CylinderGeometry(0.62, 0.34, 0.34, 8);
      bowl.translate(bx, dais + 1.05 + 0.17, -hd - 0.95);
      extra.push(this.solid(bowl, wallTint, 0.75));
      flame(bx, dais + 1.3, -hd - 0.95, 1.25, 3.6);
      flame(bx + 0.18, dais + 1.25, -hd - 1.05, 0.8, 0);
      // the hoard
      put('coin_stack_large', side * (aw / 2 - 2.4), dais, -hd - depth + 1.2, rng.range(0, 6.28), 1.2, 1.2, 1.2, propTint);
      put('coin_stack_medium', side * (aw / 2 - 3.3), dais, -hd - 1.6, rng.range(0, 6.28), 1.1, 1.1, 1.1, propTint);
      put(side < 0 ? 'chest_gold' : 'chest', side * (aw / 2 - 1.5), dais, -hd - depth + 2.2, side * -0.5, 1, 1, 1, propTint);
      cluster(side * (aw / 2 - 1.0), dais, -hd - depth + 0.9, 1.7, 6);
      cluster(side * 2.0, dais, -hd - depth + 0.7, 1.25, 5);
    }
    // throne of dark stone
    const tz = -hd - depth + 1.5;
    const throneTint = _c.set(BIOME[b.biome].throne).clone();
    const box = (bw: number, bh: number, bd: number, x: number, y: number, z: number): void => {
      const g = new BoxGeometry(bw, bh, bd);
      g.translate(x, y, z);
      extra.push(this.solid(g, throneTint, 1));
    };
    box(2.6, 0.35, 2.3, 0, dais + 0.175, tz + 0.2);
    box(1.9, 0.75, 1.5, 0, dais + 0.35 + 0.375, tz + 0.15);
    box(2.2, 3.9, 0.5, 0, dais + 0.35 + 1.95, tz - 0.6);
    box(0.4, 0.6, 1.5, -0.95, dais + 1.4, tz + 0.15);
    box(0.4, 0.6, 1.5, 0.95, dais + 1.4, tz + 0.15);
    for (const sx of [-0.9, 0, 0.9]) {
      const spire = new ConeGeometry(sx === 0 ? 0.42 : 0.3, sx === 0 ? 1.7 : 1.1, 4);
      spire.rotateY(Math.PI / 4);
      spire.translate(sx, dais + 0.35 + 3.9 + (sx === 0 ? 0.85 : 0.55), tz - 0.6);
      extra.push(this.solid(spire, throneTint, 1.05));
    }
    cluster(-0.9, dais + 4.25, tz - 0.6, 0.5, 1);
    cluster(0.9, dais + 4.25, tz - 0.6, 0.5, 1);
    cluster(0, dais + 0.35, tz - 1.25, 2.4, 7);
  }

  // ------------------------------------------------------------------ wardrobe diorama

  /** Height of the pedestal top: the previewed hero stands here. */
  get pedestalY(): number {
    return CFG.PEDESTAL_HEIGHT;
  }

  /**
   * A torch-lit corner of the crypt around a round pedestal at the origin. Wide enough that the hero can sit
   * anywhere between 20 % and 80 % of the screen width without the set running out.
   */
  private buildDiorama(): void {
    const mood = DIORAMA_MOOD;
    this.applyMood(mood);
    this.biome = 'crypt';
    this.diorama = true;
    const { b, finish } = this.begin(20260117, 'crypt', mood);
    const { rng, put, flame, cluster, extra, floorTint, wallTint, propTint } = b;
    const wz = CFG.DIORAMA_WALL_Z;

    for (let ix = -3; ix <= 3; ix++) {
      for (let iz = -1; iz <= 1; iz++) {
        put('floor_tile_large', ix * 4, CFG.FLOOR_Y, iz * 4 + 0.6, 0, 1, 1, 1, floorTint, rng.range(0.88, 1.06));
      }
    }
    // back wall: arch behind the hero flanked by banners, pillars and torches
    const pieces = ['wall_pillar', 'wall', 'wall_arched', 'wall', 'wall_arched', 'wall', 'wall_pillar'];
    pieces.forEach((piece, i) => {
      const x = (i - 3) * 4;
      put(piece, x, 0, wz - 0.5, 0, 1, 1.35, 1, wallTint, rng.range(0.9, 1.02));
      if (piece === 'wall') {
        put(i === 3 ? 'banner_shield_red' : rng.pick(mood.banners), x, 1.2, wz - 0.5, 0, 1.15, 1.15, 1, WHITE, 0.95);
        if (i !== 3) put('sword_shield_gold', x + 1.3, 2.2, wz + 0.08, 0, 1, 1, 1, propTint);
      }
    });
    const torches = [-6, -2, 2, 6];
    torches.forEach((x) => {
      put('torch_mounted', x, CFG.TORCH_Y + 0.2, wz, 0, 1.3, 1.3, 1.3, propTint);
      flame(x, CFG.TORCH_Y + 0.2 + CFG.TORCH_FLAME.y * 1.3, wz + CFG.TORCH_FLAME.z * 1.3, 0.68, 2.4);
    });
    for (const side of [-1, 1]) {
      put('pillar', side * 2.9, 0, -1.9, 0, 0.8, 0.5, 0.8, wallTint, 1.02);
      const bowl = new CylinderGeometry(0.5, 0.26, 0.3, 8);
      bowl.translate(side * 2.9, 2.15, -1.9);
      extra.push(this.solid(bowl, wallTint, 0.8));
      flame(side * 2.9, 2.25, -1.9, 1.0, 2.8);
      flame(side * 2.9 + 0.15, 2.2, -1.95, 0.7, 0);
      cluster(side * 4.4, 0, -2.6, 1.3, 6);
      cluster(side * 1.7, 0, wz + 0.5, 0.6, 4);
      put('candle_triple', side * 1.75, 0, 1.3, rng.range(0, 6.28), 1.1, 1.1, 1.1, propTint);
      flame(side * 1.75 + 0.05, 0.9, 1.3, 0.2, 0.9);
    }
    put('chest_gold', -3.9, 0, -0.9, 0.7, 1.1, 1.1, 1.1, propTint);
    put('coin_stack_large', -4.9, 0, -0.2, 1.2, 1.1, 1.1, 1.1, propTint);
    put('coin_stack_medium', -3.2, 0, -0.1, 2.2, 1, 1, 1, propTint);
    put('coin_stack_small', -4.2, 0, 0.6, 0.4, 1, 1, 1, propTint);
    put('barrel_large', 4.3, 0, -1.2, 0.3, 1, 1, 1, propTint);
    put('barrel_small', 5.3, 0, -0.5, 1.3, 1, 1, 1, propTint);
    put('crates_stacked', -7.2, 0, -1.6, 0.4, 1, 1, 1, propTint);
    put('table_long', 7.4, 0, -1.8, 0.1, 1, 1, 1, propTint);
    put('keg_decorated', 7.2, 1.0, -1.8, 0.1, 0.9, 0.9, 0.9, propTint);
    put('shelf_small_candles', -6.0, 2.2, wz + 0.1, 0, 1, 1, 1, propTint);
    cluster(-8.2, 0, -2.4, 1.1, 5);
    cluster(8.6, 0, 0.4, 0.9, 4);

    // the pedestal: two stepped drums with a trim, lit from its rim
    const top = CFG.PEDESTAL_HEIGHT;
    const r = CFG.PEDESTAL_RADIUS;
    const lower = new CylinderGeometry(r * 1.22, r * 1.3, top * 0.5, 12);
    lower.translate(0, top * 0.25, 0);
    extra.push(this.solid(lower, wallTint, 0.85));
    const upper = new CylinderGeometry(r, r * 1.06, top * 0.5, 12);
    upper.translate(0, top * 0.75, 0);
    extra.push(this.solid(upper, wallTint, 1.1));
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.3;
      cluster(Math.sin(a) * r * 1.42, 0, Math.cos(a) * r * 1.42, 0.2, 2);
    }

    // two warm torch lights behind, a cool rim from the crystals, one soft fill in front of the hero
    const spots: [number, number, number, number][] = [[-2.9, 2.9, -1.2, 1], [2.9, 2.9, -1.2, 1], [-1.6, 2.2, 3.4, 0.55], [3.2, 1.2, 1.6, 0.4]];
    spots.forEach(([x, y, z, k], i) => {
      this.torchLights[i].position.set(x, y, z);
      this.torchBase[i] = mood.torchIntensity * k;
    });
    this.torchLights[3].color.setHex(PALETTE.glimmer);

    this.addBuilt(new Mesh(this.buildSkirt(28, 12, 0, CFG.SKIRT_INNER, mood, true), this.skirtMaterial), false);
    finish();

    const radius = 14;
    this.sun.position.set(-0.55, 1, 0.9).normalize().multiplyScalar(radius + 20);
    this.sun.target.position.set(0, 0, 0);
    this.sun.target.updateMatrixWorld();
    const cam = this.sun.shadow.camera;
    cam.left = -radius; cam.right = radius; cam.top = radius; cam.bottom = -radius;
    cam.near = 5; cam.far = radius * 2 + 40;
    cam.updateProjectionMatrix();
  }

  private solid(geo: BufferGeometry, tint: Color, shade: number): BufferGeometry {
    return solidGeometry(geo, this.stoneUv, tint.r * shade, tint.g * shade, tint.b * shade);
  }

  /**
   * Dark ground under and around the room. With `fade` it runs out into the void (crypt); the other biomes
   * only get the ledge and put their water / lava surface around it.
   */
  private buildSkirt(w: number, d: number, northExtra: number, south: number, mood: Mood, fade: boolean): BufferGeometry {
    const inner = new Color(mood.void);
    const outer = new Color(PALETTE.background);
    const x0 = w / 2 + CFG.SKIRT_INNER;
    const zN = d / 2 + CFG.SKIRT_INNER + northExtra;
    const zS = d / 2 + south;
    const o = CFG.SKIRT_OUTER;
    const y = CFG.SKIRT_Y;
    const positions = [
      -x0, y, -zN, x0, y, -zN, x0, y, zS, -x0, y, zS,
      -x0 - o, y, -zN - o, x0 + o, y, -zN - o, x0 + o, y, zS + o, -x0 - o, y, zS + o,
    ];
    const colors: number[] = [];
    for (let i = 0; i < 8; i++) { const c = i < 4 ? inner : outer; colors.push(c.r, c.g, c.b); }
    const index = fade
      ? [0, 2, 1, 0, 3, 2, 4, 0, 1, 4, 1, 5, 5, 1, 2, 5, 2, 6, 6, 2, 3, 6, 3, 7, 7, 3, 0, 7, 0, 4]
      : [0, 2, 1, 0, 3, 2];
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
    geo.setAttribute('color', new BufferAttribute(new Float32Array(colors), 3));
    geo.setIndex(index);
    this.ownedGeometries.push(geo);
    return geo;
  }
}

/** Flat-shaded procedural solid mapped onto one stone texel of the kit atlas, with a vertex tint. */
export function solidGeometry(geo: BufferGeometry, uvTexel: readonly [number, number], r: number, g: number, b: number): BufferGeometry {
  const flat = geo.index ? geo.toNonIndexed() : geo.clone();
  geo.dispose();
  flat.computeVertexNormals();
  const count = flat.getAttribute('position').count;
  const uv = new Float32Array(count * 2);
  const index = new Uint32Array(count);
  for (let i = 0; i < count; i++) { uv[i * 2] = uvTexel[0]; uv[i * 2 + 1] = uvTexel[1]; index[i] = i; }
  flat.setAttribute('uv', new BufferAttribute(uv, 2));
  flat.setIndex(new BufferAttribute(index, 1));
  paint(flat, r, g, b);
  return flat;
}

function paint(geo: BufferGeometry, r: number, g: number, b: number): void {
  const count = geo.getAttribute('position').count;
  const col = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) { col[i * 3] = r; col[i * 3 + 1] = g; col[i * 3 + 2] = b; }
  geo.setAttribute('color', new BufferAttribute(col, 3));
}
