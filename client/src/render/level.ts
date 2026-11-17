/**
 * Builds the visible chamber from a RoomLayout, deterministically from room.seed:
 * instanced floor / walls / props (one InstancedMesh per repeated kit piece, everything that occurs only once
 * or twice is merged into a single mesh), glimmer crystals, torches and the chamber lighting rig.
 */
import {
  BoxGeometry, BufferAttribute, BufferGeometry, Color, ConeGeometry, CylinderGeometry, DirectionalLight, DoubleSide, Euler, Group,
  HemisphereLight, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, PointLight, Quaternion, Vector3,
} from 'three';
import type { MeshLambertMaterial } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Obstacle, RoomLayout } from '@shared/types.ts';
import type { ChamberKind } from '@shared/constants.ts';
import type { Assets } from './assets.ts';
import { BillboardBatch, DECAL, DecalBatch, SPRITE } from './batches.ts';
import { PALETTE, SHADOW, WALL } from './config.ts';
import type { QualityProfile } from './config.ts';
import { createLevelMaterial } from './materials.ts';
import { createRng } from './rng.ts';
import type { Rng } from './rng.ts';

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

const MOODS: Record<ChamberKind, Mood> = {
  combat: {
    hemiSky: 0x7f93c8, hemiGround: 0x2c2420, hemiIntensity: 1.1, dirColor: 0xc9d6ff, dirIntensity: 1.5,
    torch: 0xff8f3f, torchIntensity: 46, floorTint: 0x70809a, wallTint: 0xb9bfd6, propTint: 0xd8d2c8,
    crystal: PALETTE.glimmer, banners: ['banner_patternB_blue', 'banner_patternC_green', 'banner_thin_yellow'],
    fog: 0x080a14, void: 0x0c0f1a,
  },
  elite: {
    hemiSky: 0x6f9ae0, hemiGround: 0x1d1a26, hemiIntensity: 1.2, dirColor: 0xa9c8ff, dirIntensity: 1.45,
    torch: 0xff4a36, torchIntensity: 44, floorTint: 0x7586ae, wallTint: 0xa3b2d8, propTint: 0xc4c6d6,
    crystal: 0xff3d55, banners: ['banner_patternA_red', 'banner_shield_red'],
    fog: 0x070b18, void: 0x0a0e1c,
  },
  boss: {
    hemiSky: 0x5f78d8, hemiGround: 0x0f1a1c, hemiIntensity: 1.0, dirColor: 0xcfe0ff, dirIntensity: 1.25,
    torch: 0x4dffa0, torchIntensity: 34, floorTint: 0x6f7a98, wallTint: 0x9aa6c8, propTint: 0xc8c8d4,
    crystal: PALETTE.glimmer, banners: ['banner_shield_red', 'banner_patternA_red'],
    fog: 0x060c12, void: 0x08101a,
  },
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
} as const;

interface Flame { x: number; y: number; z: number; size: number; seed: number; pool: number }
interface Glow { x: number; y: number; z: number; size: number; r: number; g: number; b: number; seed: number }

interface PieceBin { matrices: number[]; colors: number[] }

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
  /** Current room size (0 when no room is built). */
  width = 0;
  depth = 0;
  fogColor = new Color(PALETTE.fog);

  private readonly assets: Assets;
  private readonly material: MeshLambertMaterial;
  private readonly miscMaterial: MeshLambertMaterial;
  private readonly crystalMaterial: MeshBasicMaterial;
  private readonly skirtMaterial: MeshBasicMaterial;
  private readonly crystalGeometry: BufferGeometry;
  private readonly hemi: HemisphereLight;
  private readonly torchLights: PointLight[] = [];
  private readonly torchBase: number[] = [0, 0, 0, 0];
  readonly stoneUv: [number, number];
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
    this.applyMood(MOODS.combat);
  }

  /** Rebuilds only when the room, chamber kind or index actually changed. Returns true when rebuilt. */
  setRoom(room: RoomLayout | null, kind: ChamberKind, index: number): boolean {
    const key = room ? `${room.seed}:${room.w}:${room.d}:${room.obstacles.length}:${kind}:${index}` : '';
    if (key === this.roomKey) return false;
    this.roomKey = key;
    this.clear();
    if (room) this.build(room, kind, index);
    return true;
  }

  applyQuality(q: QualityProfile): void {
    this.sun.castShadow = q.shadows;
    this.receiveShadow = q.shadows;
    for (const mesh of this.built) mesh.receiveShadow = q.shadows;
    this.torchLights.forEach((light, i) => { light.visible = i < q.pointLights; });
  }

  /** Per-frame: torch flicker and all emissive sprites of the level (flames, crystal glows, light pools). */
  emit(fx: BillboardBatch, decals: DecalBatch, time: number): void {
    const t = this.torchColor;
    for (let i = 0; i < this.torchLights.length; i++) {
      this.torchLights[i].intensity = this.torchBase[i] * (1 + 0.09 * noise1(time, i + 1));
    }
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
    this.built = [];
    this.ownedGeometries = [];
    this.flames = [];
    this.glows = [];
    this.width = 0;
    this.depth = 0;
    for (let i = 0; i < 4; i++) this.torchBase[i] = 0;
  }

  dispose(): void {
    this.clear();
    this.roomKey = '';
    this.material.dispose();
    this.miscMaterial.dispose();
    this.crystalMaterial.dispose();
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
    for (const light of this.torchLights) light.color.setHex(mood.torch);
    this.fogColor.setHex(mood.fog);
  }

  private build(room: RoomLayout, kind: ChamberKind, index: number): void {
    const mood = MOODS[kind];
    this.applyMood(mood);
    const rng = createRng(room.seed * 7919 + index * 131 + 17);
    const w = room.w;
    const d = room.d;
    const hw = w / 2;
    const hd = d / 2;
    this.width = w;
    this.depth = d;

    const bins = new Map<string, PieceBin>();
    const crystals: number[] = [];
    const crystalColors: number[] = [];
    const extra: BufferGeometry[] = [];
    const floorTint = new Color(mood.floorTint);
    const wallTint = new Color(mood.wallTint);
    const propTint = new Color(mood.propTint);
    const crystalColor = new Color(mood.crystal);

    const put = (piece: string, x: number, y: number, z: number, rotY = 0, sx = 1, sy = 1, sz = 1, tint: Color = WHITE, shade = 1): void => {
      let bin = bins.get(piece);
      if (!bin) { bin = { matrices: [], colors: [] }; bins.set(piece, bin); }
      _m.compose(_p.set(x, y, z), _q.setFromEuler(_e.set(0, rotY, 0)), _s.set(sx, sy, sz));
      for (let i = 0; i < 16; i++) bin.matrices.push(_m.elements[i]);
      bin.colors.push(tint.r * shade, tint.g * shade, tint.b * shade);
    };

    const addGlow = (x: number, y: number, z: number, size: number, color: Color): void => {
      this.glows.push({ x, y, z, size, r: color.r, g: color.g, b: color.b, seed: rng.next() });
    };

    const cluster = (x: number, y: number, z: number, scale: number, count: number, color: Color = crystalColor): void => {
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
      addGlow(x, y + 0.6 * scale, z, scale, color);
    };

    const flame = (x: number, y: number, z: number, size: number, pool: number): void => {
      this.flames.push({ x, y, z, size, seed: rng.next(), pool });
    };

    // ---------------------------------------------------------------- floor
    const nx = Math.max(1, Math.round(w / CFG.FLOOR_CELL));
    const nz = Math.max(1, Math.round(d / CFG.FLOOR_CELL));
    const cx = w / nx;
    const cz = d / nz;
    const used = new Uint8Array(nx * nz);
    for (let iz = 0; iz < nz; iz++) {
      for (let ix = 0; ix < nx; ix++) {
        if (used[iz * nx + ix]) continue;
        const shade = rng.range(0.9, 1.08);
        const canLarge = ix + 1 < nx && iz + 1 < nz && !used[iz * nx + ix + 1];
        if (canLarge && rng.chance(0.55)) {
          used[iz * nx + ix] = used[iz * nx + ix + 1] = used[(iz + 1) * nx + ix] = used[(iz + 1) * nx + ix + 1] = 1;
          const piece = rng.chance(0.07) ? 'floor_dirt_large' : 'floor_tile_large';
          put(piece, (ix + 1) * cx - hw, CFG.FLOOR_Y, (iz + 1) * cz - hd, 0, cx / 2, 1, cz / 2, floorTint, shade);
          continue;
        }
        used[iz * nx + ix] = 1;
        const roll = rng.next();
        const piece = roll < 0.06 ? 'floor_tile_small_broken_A' : roll < 0.12 ? 'floor_tile_small_broken_B'
          : roll < 0.16 ? 'floor_tile_small_weeds_A' : roll < 0.2 ? 'floor_tile_small_weeds_B' : 'floor_tile_small';
        const turns = rng.int(4);
        const odd = turns % 2 === 1;
        put(piece, (ix + 0.5) * cx - hw, CFG.FLOOR_Y, (iz + 0.5) * cz - hd, turns * Math.PI / 2,
          (odd ? cz : cx) / 2, 1, (odd ? cx : cz) / 2, floorTint, shade);
      }
    }

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
        if (roll < 0.2) piece = 'wall_pillar';
        else if (roll < 0.32) piece = 'wall_arched';
        else if (roll < 0.4) piece = 'wall_window_closed';
        else if (roll < 0.47) piece = 'wall_shelves';
        else if (roll < 0.53) piece = 'wall_cracked';
      }
      put(piece, x, 0, northZ, 0, sx, 1, 1, wallTint, shade);
      if (piece === 'wall' || piece === 'wall_cracked') {
        if (rng.chance(0.62)) put(rng.pick(mood.banners), x, 0, northZ, 0, 1, 1, 1, WHITE, 0.95);
        else if (rng.chance(0.5)) put(rng.pick(['sword_shield', 'sword_shield_gold', 'sword_shield_broken']), x, 2.3, -hd + 0.08, 0, 1, 1, 1, propTint);
      }
      // candles and small trinkets hugging the wall (never out in the walkable lanes)
      if (rng.chance(0.45)) {
        const cxp = x + rng.range(-1.4, 1.4);
        const triple = rng.chance(0.6);
        put(triple ? 'candle_triple' : 'candle_lit', cxp, 0, -hd + 0.28, rng.range(0, 6.28), 1, 1, 1, propTint);
        flame(cxp + (triple ? 0.05 : 0), triple ? 0.82 : 1.0, -hd + 0.3, 0.2, 0);
      }
      if (rng.chance(0.18)) put('coin_stack_medium', x + rng.range(-1.5, 1.5), 0, -hd + 0.45, rng.range(0, 6.28), 0.8, 0.8, 0.8, propTint);
      if (rng.chance(0.15)) put('bottle_A_green', x + rng.range(-1.6, 1.6), 0, -hd + 0.25, rng.range(0, 6.28), 1, 1, 1, propTint);
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
        const piece = roll < 0.25 ? 'wall_pillar' : roll < 0.33 ? 'wall_arched' : 'wall';
        put(piece, x, 0, z, rot, segZ / WALL.LENGTH, 1, 1, wallTint, rng.range(0.9, 1.02));
        if (piece === 'wall' && rng.chance(0.4)) put(rng.pick(mood.banners), x, 0, z, rot, 1, 1, 1, WHITE, 0.9);
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

    // ---------------------------------------------------------------- obstacles
    for (const o of room.obstacles) this.placeObstacle(o, rng, put, flame, cluster, extra, propTint, wallTint);

    // ---------------------------------------------------------------- accents
    cluster(-hw + 0.75, 0, -hd + 0.75, 1.0, 5);
    cluster(hw - 0.75, 0, -hd + 0.75, 0.9, 4);
    for (const side of [-1, 1]) {
      for (let j = 1; j < mSeg; j++) {
        if (rng.chance(0.3)) cluster(side * (hw - 0.45), 0, -hd + j * segZ + rng.range(-1, 1), rng.range(0.45, 0.7), 3);
      }
    }
    // silhouettes in the dark beyond the south curb (outside the walkable area)
    for (let i = 0; i < nSeg; i++) {
      if (!rng.chance(0.55)) continue;
      const x = -hw + (i + rng.range(0.2, 0.8)) * seg;
      const z = hd + rng.range(1.5, 2.6);
      const roll = rng.next();
      if (roll < 0.35) put('barrel_small', x, 0, z, rng.range(0, 6.28), 1.1, 1.1, 1.1, propTint, 0.6);
      else if (roll < 0.6) put('box_small', x, 0, z, rng.range(0, 6.28), 1.1, 1.1, 1.1, propTint, 0.6);
      else if (roll < 0.8) cluster(x, 0, z, rng.range(0.6, 0.9), 3);
      else put('box_large', x, 0, z, rng.range(0, 6.28), 0.9, 0.9, 0.9, propTint, 0.6);
    }

    if (alcoveSegs > 0) this.buildThrone(alcoveSegs * seg, hd, rng, put, flame, cluster, extra, wallTint, floorTint, propTint, mood);

    // ---------------------------------------------------------------- finalise meshes
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
      this.addBuilt(mesh);
    }
    this.addBuilt(new Mesh(this.buildSkirt(w, d, alcoveSegs > 0 ? CFG.ALCOVE_DEPTH + 1 : 0, mood), this.skirtMaterial));

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

  private addBuilt(mesh: InstancedMesh | Mesh): void {
    mesh.receiveShadow = this.receiveShadow;
    mesh.matrixAutoUpdate = false;
    this.built.push(mesh);
    this.group.add(mesh);
  }

  private placeObstacle(
    o: Obstacle, rng: Rng,
    put: (piece: string, x: number, y: number, z: number, rotY?: number, sx?: number, sy?: number, sz?: number, tint?: Color, shade?: number) => void,
    flame: (x: number, y: number, z: number, size: number, pool: number) => void,
    cluster: (x: number, y: number, z: number, scale: number, count: number) => void,
    extra: BufferGeometry[], propTint: Color, wallTint: Color,
  ): void {
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
    }
  }

  private buildThrone(
    aw: number, hd: number, rng: Rng,
    put: (piece: string, x: number, y: number, z: number, rotY?: number, sx?: number, sy?: number, sz?: number, tint?: Color, shade?: number) => void,
    flame: (x: number, y: number, z: number, size: number, pool: number) => void,
    cluster: (x: number, y: number, z: number, scale: number, count: number, color?: Color) => void,
    extra: BufferGeometry[], wallTint: Color, floorTint: Color, propTint: Color, mood: Mood,
  ): void {
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
    const throneTint = _c.set(0xa59bd0).clone();
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

  private solid(geo: BufferGeometry, tint: Color, shade: number): BufferGeometry {
    return solidGeometry(geo, this.stoneUv, tint.r * shade, tint.g * shade, tint.b * shade);
  }

  /** Dark ground under and around the room that fades into the void instead of ending in a hard edge. */
  private buildSkirt(w: number, d: number, northExtra: number, mood: Mood): BufferGeometry {
    const inner = new Color(mood.void);
    const outer = new Color(PALETTE.background);
    const x0 = w / 2 + CFG.SKIRT_INNER;
    const zN = d / 2 + CFG.SKIRT_INNER + northExtra;
    const zS = d / 2 + CFG.SKIRT_INNER;
    const o = CFG.SKIRT_OUTER;
    const y = CFG.SKIRT_Y;
    const positions = [
      -x0, y, -zN, x0, y, -zN, x0, y, zS, -x0, y, zS,
      -x0 - o, y, -zN - o, x0 + o, y, -zN - o, x0 + o, y, zS + o, -x0 - o, y, zS + o,
    ];
    const colors: number[] = [];
    for (let i = 0; i < 8; i++) { const c = i < 4 ? inner : outer; colors.push(c.r, c.g, c.b); }
    const index = [0, 2, 1, 0, 3, 2, 4, 0, 1, 4, 1, 5, 5, 1, 2, 5, 2, 6, 6, 2, 3, 6, 3, 7, 7, 3, 0, 7, 0, 4];
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
