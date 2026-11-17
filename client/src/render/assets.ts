/**
 * Asset library: loads the optimised KayKit GLBs once and bakes them into render-friendly templates.
 *
 * Every character (hero or skeleton, including its outfit and weapons) is baked into ONE skinned geometry
 * so a character costs a single draw call: rigid attachments are re-expressed as vertices weighted 100 % to
 * the bone they hang from. Templates are instantiated with SkeletonUtils.clone().
 */
import {
  Box3, BufferAttribute, BufferGeometry, Color, ConeGeometry, CylinderGeometry, DodecahedronGeometry, Matrix3, Matrix4, Mesh,
  OctahedronGeometry, Quaternion, Skeleton, SkinnedMesh, Vector3,
} from 'three';
import type { AnimationClip, Bone, InterleavedBufferAttribute, KeyframeTrack, Material, Object3D, Texture } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { CLASS_IDS, ENEMY_KINDS } from '@shared/types.ts';
import type { ClassId, EnemyKind, Look } from '@shared/types.ts';
import { ENEMY_MODEL, HERO_OUTFIT, MODEL_BASE, PALETTE, lookKey } from './config.ts';

export const BODY_MESH_NAME = 'gg_body';
/** Suffix of the coarse shadow-pass LOD meshes produced by tools/build-assets.mjs. */
const SHADOW_SUFFIX = '_shadow';

/** Stored in geometry.userData.shadowRange when a character carries a shadow LOD in the same buffers. */
export interface ShadowRange { mainCount: number; start: number; count: number }

export interface CharacterTemplate {
  /** Bone hierarchy plus one baked SkinnedMesh named BODY_MESH_NAME. Clone with SkeletonUtils.clone(). */
  scene: Object3D;
  map: Texture;
  triangles: number;
  /** Hero templates only: cache key (class, head, cape, style) and the number of live views using it. */
  key: string;
  refs: number;
}

export type PropName = 'arrow' | 'dagger' | 'skel_arrow';

export interface Assets {
  /**
   * Baked hero for a look, shared by every view whose (class, head, cape, style) match; colour is a uniform.
   * Each call takes a reference: hand the template back with releaseHero() when the view is disposed.
   */
  heroTemplate(cls: ClassId, look: Look): CharacterTemplate;
  releaseHero(template: CharacterTemplate): void;
  /** Number of hero geometries currently baked (debug / leak checks). */
  heroTemplateCount(): number;
  enemies: Record<EnemyKind, CharacterTemplate>;
  heroClips: Map<string, AnimationClip>;
  skelClips: Map<string, AnimationClip>;
  dungeonMap: Texture;
  rogueMap: Texture;
  skeletonMap: Texture;
  props: Record<PropName, BufferGeometry>;
  /** Baked static geometry of one dungeon kit piece (cached, owned by the library). */
  piece(name: string): BufferGeometry;
  dispose(): void;
}

type AnyAttribute = BufferAttribute | InterleavedBufferAttribute;

interface ExtraPart {
  geometry: BufferGeometry;
  /** Coarse version for the shadow pass (same local space), if the pipeline provided one. */
  shadow?: BufferGeometry;
  bone: string;
  matrix: Matrix4;
  shadowMatrix?: Matrix4;
  /** glow, cloth, untextured */
  mask: [number, number, number];
  tint: Color;
  /** Geometry is temporary and must be disposed after baking. */
  owned: boolean;
  /** 'model': `matrix` is given in the character's rest-pose space (Y up, +Z forward, feet at 0) instead of bone space. */
  space?: 'model';
}

interface BakeSpec {
  /** Which optional (rigid) child meshes of the source stay. Skinned body parts are always kept. */
  keepRigid: (name: string) => boolean;
  extras: ExtraPart[];
  /** Per-texel cloth mask (heroes): 1 where the palette texel is one of the class's cloth swatches. */
  cloth?: (u: number, v: number) => number;
  /** Rigid source meshes that hang from another bone than in the file (rest-pose placement in model space). */
  rehang?: Map<string, { bone: string; matrix: Matrix4 }>;
}

const FILES = [
  'hero_knight', 'hero_barbarian', 'hero_mage', 'hero_rogue', 'hero_rogue_hooded',
  'skel_minion', 'skel_warrior', 'skel_rogue', 'skel_mage',
  'anims_hero', 'anims_skel', 'dungeon', 'props',
] as const;
type FileName = (typeof FILES)[number];

const CLOTH_PATTERN = /cape|cloak/i;
/** Rigid attachments that count as cloth (the skeleton rogue's hood is one; the hero rogue's hood is a skinned head). */
const RIGID_CLOTH_PATTERN = /cape|cloak|hood/i;
const GLOW_MATERIAL = 'Glow';
const IK_BONE_PATTERN = /IK|control-/;
const TRACK_EPSILON = 1e-4;
const WHITE = new Color(0xffffff);

const _v = new Vector3();
const _n = new Vector3();
const _m = new Matrix4();
const _m2 = new Matrix4();
const _nm = new Matrix3();

function floatAttribute(src: AnyAttribute, itemSize: number): Float32Array {
  const out = new Float32Array(src.count * itemSize);
  for (let i = 0; i < src.count; i++) {
    for (let c = 0; c < itemSize; c++) out[i * itemSize + c] = src.getComponent(i, c);
  }
  return out;
}

function indexArray(src: BufferGeometry): Uint32Array {
  const count = src.getAttribute('position').count;
  if (!src.index) {
    const seq = new Uint32Array(count);
    for (let i = 0; i < count; i++) seq[i] = i;
    return seq;
  }
  const out = new Uint32Array(src.index.count);
  for (let i = 0; i < out.length; i++) out[i] = src.index.getX(i);
  return out;
}

/** Copies position / normal / uv into plain Float32 attributes (de-quantised) with an optional transform. */
function plainGeometry(src: BufferGeometry, matrix: Matrix4 | null): BufferGeometry {
  const position = floatAttribute(src.getAttribute('position'), 3);
  const srcNormal = src.getAttribute('normal') as AnyAttribute | undefined;
  const normal = srcNormal ? floatAttribute(srcNormal, 3) : new Float32Array(position.length);
  const srcUv = src.getAttribute('uv') as AnyAttribute | undefined;
  const uv = srcUv ? floatAttribute(srcUv, 2) : new Float32Array((position.length / 3) * 2);
  if (matrix) {
    _nm.getNormalMatrix(matrix);
    for (let i = 0; i < position.length; i += 3) {
      _v.fromArray(position, i).applyMatrix4(matrix).toArray(position, i);
      _n.fromArray(normal, i).applyMatrix3(_nm).normalize().toArray(normal, i);
    }
  } else {
    for (let i = 0; i < normal.length; i += 3) _n.fromArray(normal, i).normalize().toArray(normal, i);
  }
  const out = new BufferGeometry();
  out.setAttribute('position', new BufferAttribute(position, 3));
  out.setAttribute('normal', new BufferAttribute(normal, 3));
  out.setAttribute('uv', new BufferAttribute(uv, 2));
  out.setIndex(new BufferAttribute(indexArray(src), 1));
  if (!srcNormal) out.computeVertexNormals();
  return out;
}

function fillAttribute(count: number, values: readonly number[]): BufferAttribute {
  const arr = new Float32Array(count * values.length);
  for (let i = 0; i < count; i++) for (let c = 0; c < values.length; c++) arr[i * values.length + c] = values[c];
  return new BufferAttribute(arr, values.length);
}

function decorate(geo: BufferGeometry, mask: readonly number[], tint: Color, cloth?: (u: number, v: number) => number): void {
  const count = geo.getAttribute('position').count;
  const attr = fillAttribute(count, mask);
  if (cloth && mask[1] === 0 && mask[2] === 0) {
    const uv = geo.getAttribute('uv');
    for (let i = 0; i < count; i++) attr.setY(i, cloth(uv.getX(i), uv.getY(i)));
  }
  geo.setAttribute('aMask', attr);
  geo.setAttribute('aTint', fillAttribute(count, [tint.r, tint.g, tint.b]));
}

const CLOTH_SAMPLE = 128;

/** Builds the cloth lookup of a hero palette texture: texels whose hue lies in the class's cloth window. */
function clothSampler(map: Texture, window: { hueMin: number; hueMax: number; satMin: number }): (u: number, v: number) => number {
  const canvas = document.createElement('canvas');
  canvas.width = CLOTH_SAMPLE;
  canvas.height = CLOTH_SAMPLE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return () => 0;
  ctx.drawImage(map.image as CanvasImageSource, 0, 0, CLOTH_SAMPLE, CLOTH_SAMPLE);
  const px = ctx.getImageData(0, 0, CLOTH_SAMPLE, CLOTH_SAMPLE).data;
  const mask = new Uint8Array(CLOTH_SAMPLE * CLOTH_SAMPLE);
  for (let i = 0; i < mask.length; i++) {
    const r = px[i * 4] / 255;
    const g = px[i * 4 + 1] / 255;
    const b = px[i * 4 + 2] / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;
    if (max < 0.12 || delta / Math.max(max, 1e-4) < window.satMin) continue;
    let hue = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
    hue = (hue * 60 + 360) % 360;
    const inside = window.hueMin <= window.hueMax ? hue >= window.hueMin && hue <= window.hueMax : hue >= window.hueMin || hue <= window.hueMax;
    if (inside) mask[i] = 1;
  }
  const flip = map.flipY;
  const ox = map.offset.x;
  const oy = map.offset.y;
  const rx = map.repeat.x;
  const ry = map.repeat.y;
  return (u, v) => {
    const tu = u * rx + ox;
    let tv = v * ry + oy;
    if (flip) tv = 1 - tv;
    const x = Math.min(CLOTH_SAMPLE - 1, Math.max(0, Math.floor((tu - Math.floor(tu)) * CLOTH_SAMPLE)));
    const y = Math.min(CLOTH_SAMPLE - 1, Math.max(0, Math.floor((tv - Math.floor(tv)) * CLOTH_SAMPLE)));
    return mask[y * CLOTH_SAMPLE + x];
  };
}

function rigidSkin(geo: BufferGeometry, boneIndex: number): void {
  const count = geo.getAttribute('position').count;
  const index = new Uint16Array(count * 4);
  const weight = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) { index[i * 4] = boneIndex; weight[i * 4] = 1; }
  geo.setAttribute('skinIndex', new BufferAttribute(index, 4));
  geo.setAttribute('skinWeight', new BufferAttribute(weight, 4));
}

function findBone(obj: Object3D): Bone | null {
  let p: Object3D | null = obj.parent;
  while (p) {
    if ((p as Bone).isBone) return p as Bone;
    p = p.parent;
  }
  return null;
}

/** Hard-edged copy of a primitive for the faceted low-poly look. */
function faceted(geo: BufferGeometry): BufferGeometry {
  const flat = geo.index ? geo.toNonIndexed() : geo.clone();
  flat.computeVertexNormals();
  geo.dispose();
  return flat;
}

function bakeCharacter(source: Object3D, map: Texture, spec: BakeSpec): CharacterTemplate {
  source.updateMatrixWorld(true);
  const skinned: SkinnedMesh[] = [];
  const rigid: Mesh[] = [];
  source.traverse((o) => {
    if ((o as SkinnedMesh).isSkinnedMesh) skinned.push(o as SkinnedMesh);
    else if ((o as Mesh).isMesh) rigid.push(o as Mesh);
  });
  if (skinned.length === 0) throw new Error('character without skinned meshes');
  const main = skinned[0];
  const skeleton = main.skeleton;
  const boneIndexByName = new Map<string, number>();
  skeleton.bones.forEach((b, i) => boneIndexByName.set(b.name, i));

  const parts: BufferGeometry[] = [];
  const shadowParts: BufferGeometry[] = [];

  for (const mesh of skinned) {
    let matrix: Matrix4 | null = null;
    if (mesh.skeleton !== skeleton) {
      // Different quantisation space: boneInverse_src = boneInverse_dst * Q  =>  Q = inv(dst) * src
      const j = boneIndexByName.get(mesh.skeleton.bones[0].name) ?? 0;
      matrix = new Matrix4().copy(skeleton.boneInverses[j]).invert().multiply(mesh.skeleton.boneInverses[0]);
    }
    const geo = plainGeometry(mesh.geometry, matrix);
    const count = geo.getAttribute('position').count;
    const srcIndex = mesh.geometry.getAttribute('skinIndex') as AnyAttribute;
    const srcWeight = mesh.geometry.getAttribute('skinWeight') as AnyAttribute;
    const index = new Uint16Array(count * 4);
    const weight = floatAttribute(srcWeight, 4);
    for (let i = 0; i < count; i++) {
      let sum = 0;
      for (let c = 0; c < 4; c++) {
        const srcBone = mesh.skeleton.bones[srcIndex.getComponent(i, c)];
        index[i * 4 + c] = boneIndexByName.get(srcBone.name) ?? 0;
        sum += weight[i * 4 + c];
      }
      if (sum > 0) for (let c = 0; c < 4; c++) weight[i * 4 + c] /= sum;
    }
    geo.setAttribute('skinIndex', new BufferAttribute(index, 4));
    geo.setAttribute('skinWeight', new BufferAttribute(weight, 4));
    const material = mesh.material as Material;
    const glow = material.name === GLOW_MATERIAL ? 1 : 0;
    const cloth = CLOTH_PATTERN.test(mesh.name) ? 1 : 0;
    decorate(geo, [glow, cloth, 0], WHITE, glow === 0 ? spec.cloth : undefined);
    (mesh.name.endsWith(SHADOW_SUFFIX) ? shadowParts : parts).push(geo);
  }

  const bindInverse = new Matrix4().copy(main.bindMatrix).invert();
  const addRigid = (src: BufferGeometry, bone: Bone, local: Matrix4, mask: readonly number[], tint: Color, shadow = false): void => {
    const j = boneIndexByName.get(bone.name);
    if (j === undefined) return;
    // p = inv(bindMatrix) * inv(boneInverse_j) * local * v   (see header comment)
    _m.copy(skeleton.boneInverses[j]).invert().premultiply(bindInverse).multiply(local);
    const geo = plainGeometry(src, _m);
    rigidSkin(geo, j);
    decorate(geo, mask, tint, spec.cloth);
    (shadow ? shadowParts : parts).push(geo);
  };

  for (const mesh of rigid) {
    const shadow = mesh.name.endsWith(SHADOW_SUFFIX);
    const baseName = shadow ? mesh.name.slice(0, -SHADOW_SUFFIX.length) : mesh.name;
    if (!spec.keepRigid(baseName)) continue;
    const moved = spec.rehang?.get(baseName);
    const bone = moved ? skeleton.bones.find((b) => b.name === moved.bone) ?? null : findBone(mesh);
    if (!bone) continue;
    if (moved) _m2.copy(bone.matrixWorld).invert().multiply(moved.matrix);
    else _m2.copy(bone.matrixWorld).invert().multiply(mesh.matrixWorld);
    addRigid(mesh.geometry, bone, _m2.clone(), [0, RIGID_CLOTH_PATTERN.test(mesh.name) ? 1 : 0, 0], WHITE, shadow);
  }
  for (const extra of spec.extras) {
    const bone = skeleton.bones.find((b) => b.name === extra.bone);
    if (bone) {
      const toLocal = (m: Matrix4): Matrix4 => (extra.space === 'model' ? new Matrix4().copy(bone.matrixWorld).invert().multiply(m) : m);
      addRigid(extra.geometry, bone, toLocal(extra.matrix), extra.mask, extra.tint);
      if (extra.shadow) addRigid(extra.shadow, bone, toLocal(extra.shadowMatrix ?? extra.matrix), extra.mask, extra.tint, true);
    }
    if (extra.owned) extra.geometry.dispose();
  }

  // Main triangles first, then the shadow LOD: the shadow pass only switches the draw range (see characters.ts).
  let mainCount = 0;
  for (const p of parts) mainCount += p.index ? p.index.count : 0;
  const merged = mergeGeometries([...parts, ...shadowParts], false);
  for (const p of parts) p.dispose();
  for (const p of shadowParts) p.dispose();
  if (!merged) throw new Error('failed to merge character geometry');
  const totalCount = merged.index ? merged.index.count : 0;
  if (totalCount > mainCount) {
    merged.setDrawRange(0, mainCount);
    const range: ShadowRange = { mainCount, start: mainCount, count: totalCount - mainCount };
    merged.userData.shadowRange = range;
  }
  merged.computeBoundingBox();
  merged.computeBoundingSphere();

  // Template rig: a clone of the source hierarchy without its meshes, plus the single baked mesh.
  const scene = cloneSkinned(source);
  const strip: Object3D[] = [];
  let meshParent: Object3D = scene;
  scene.traverse((o) => {
    if ((o as Mesh).isMesh) {
      strip.push(o);
      if ((o as SkinnedMesh).isSkinnedMesh && o.parent) meshParent = o.parent;
    }
  });
  for (const o of strip) o.removeFromParent();
  const bones: Bone[] = skeleton.bones.map((b) => scene.getObjectByName(b.name) as Bone);
  const bakedSkeleton = new Skeleton(bones, skeleton.boneInverses.map((mtx) => mtx.clone()));
  const body = new SkinnedMesh(merged);
  body.name = BODY_MESH_NAME;
  body.frustumCulled = false;
  meshParent.add(body);
  scene.updateMatrixWorld(true);
  body.bind(bakedSkeleton, main.bindMatrix.clone());
  return { scene, map, triangles: mainCount / 3, key: '', refs: 0 };
}

function matrixOf(px: number, py: number, pz: number, rx = 0, ry = 0, rz = 0, s = 1): Matrix4 {
  const q = new Quaternion().setFromAxisAngle(_v.set(1, 0, 0), rx)
    .premultiply(new Quaternion().setFromAxisAngle(_v.set(0, 1, 0), ry))
    .premultiply(new Quaternion().setFromAxisAngle(_v.set(0, 0, 1), rz));
  return new Matrix4().compose(new Vector3(px, py, pz), q, new Vector3(s, s, s));
}

function propMeshes(props: Object3D, name: string): { root: Object3D; main: Mesh; shadow: Mesh | null } {
  const root = props.getObjectByName(name);
  if (!root) throw new Error(`missing prop ${name}`);
  root.updateMatrixWorld(true);
  let main: Mesh | null = null;
  let shadow: Mesh | null = null;
  root.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    if (mesh.name.endsWith(SHADOW_SUFFIX)) shadow ??= mesh;
    else main ??= mesh;
  });
  if (!main) throw new Error(`prop ${name} has no mesh`);
  return { root, main, shadow };
}

/** Prop from props.glb as an attachment (its wrapper node already holds the grip offset). */
function propPart(props: Object3D, name: string, bone: string, matrix: Matrix4, mask: [number, number, number] = [0, 0, 0]): ExtraPart {
  const { root, main, shadow } = propMeshes(props, name);
  const inv = new Matrix4().copy(root.matrixWorld).invert();
  const local = new Matrix4().multiplyMatrices(inv, main.matrixWorld).premultiply(matrix);
  const part: ExtraPart = { geometry: main.geometry, bone, matrix: local, mask, tint: WHITE, owned: false };
  if (shadow) {
    part.shadow = shadow.geometry;
    part.shadowMatrix = new Matrix4().multiplyMatrices(inv, shadow.matrixWorld).premultiply(matrix);
  }
  return part;
}

/** Where a belt item (the rogue's knife) hangs: left hip, blade down. */
const BELT = { X: 0.26, Y: 0.52, Z: 0.02, RX: Math.PI, RZ: 0.12 } as const;

const CROWN = { RADIUS: 0.4, BAND: 0.2, SPIKES: 6, SPIKE_H: 0.42, SPIKE_R: 0.1, GEM: 0.09, GEM_GLOW: 2.4, Y: 0.86, GOLD: 0xe0a83a } as const;

function crownParts(): ExtraPart[] {
  const parts: ExtraPart[] = [];
  const gold = new Color(CROWN.GOLD);
  const gem = new Color(PALETTE.glimmer).multiplyScalar(CROWN.GEM_GLOW);
  // open band: an outer wall plus a mirrored inner wall, so the skull stays visible inside the crown from above
  const outer = faceted(new CylinderGeometry(CROWN.RADIUS, CROWN.RADIUS * 0.92, CROWN.BAND, 8, 1, true));
  const innerSrc = new CylinderGeometry(CROWN.RADIUS * 0.86, CROWN.RADIUS * 0.8, CROWN.BAND, 8, 1, true);
  innerSrc.scale(1, 1, -1);
  const inner = faceted(innerSrc);
  parts.push({ geometry: outer, bone: 'head', matrix: matrixOf(0, CROWN.Y, 0), mask: [0, 0, 1], tint: gold, owned: true });
  parts.push({ geometry: inner, bone: 'head', matrix: matrixOf(0, CROWN.Y, 0), mask: [0, 0, 1], tint: gold.clone().multiplyScalar(0.55), owned: true });
  for (let i = 0; i < CROWN.SPIKES; i++) {
    const a = (i / CROWN.SPIKES) * Math.PI * 2;
    const x = Math.sin(a) * CROWN.RADIUS * 0.96;
    const z = Math.cos(a) * CROWN.RADIUS * 0.96;
    const tall = i % 2 === 0 ? 1 : 0.7;
    const spike = faceted(new ConeGeometry(CROWN.SPIKE_R, CROWN.SPIKE_H * tall, 4));
    parts.push({
      geometry: spike, bone: 'head', matrix: matrixOf(x, CROWN.Y + CROWN.BAND * 0.5 + CROWN.SPIKE_H * tall * 0.5, z, 0, a),
      mask: [0, 0, 1], tint: gold, owned: true,
    });
    const jewel = faceted(new OctahedronGeometry(CROWN.GEM * tall));
    parts.push({
      geometry: jewel, bone: 'head', matrix: matrixOf(x * 1.08, CROWN.Y, z * 1.08, 0, a),
      mask: [1, 0, 1], tint: gem, owned: true,
    });
  }
  return parts;
}


// ---------------------------------------------------------------------------------------------- boss dressing
// All placements below are in rest-pose model space of an unscaled skeleton (2 m tall, +Z forward).

function modelPart(geometry: BufferGeometry, bone: string, matrix: Matrix4, mask: [number, number, number], tint: Color): ExtraPart {
  return { geometry: faceted(geometry), bone, matrix, mask, tint, owned: true, space: 'model' };
}

/** Open cone shell with a mirrored inner wall, so the inside never shows as a hole from above. */
function shellParts(rTop: number, rBottom: number, h: number, sides: number, bone: string, y: number, tint: Color, mask: [number, number, number]): ExtraPart[] {
  const outer = new CylinderGeometry(rTop, rBottom, h, sides, 1, true);
  const inner = new CylinderGeometry(rTop * 0.93, rBottom * 0.95, h, sides, 1, true);
  inner.scale(1, 1, -1);
  return [
    modelPart(outer, bone, matrixOf(0, y, 0), mask, tint),
    modelPart(inner, bone, matrixOf(0, y, 0), mask, tint.clone().multiplyScalar(0.5)),
  ];
}

/** A hanging cloth panel behind the body: `rows` of [y, z, halfWidth] from the shoulders down, both faces. */
function panelGeometry(rows: readonly (readonly [number, number, number])[], notch = 0): BufferGeometry {
  const pos: number[] = [];
  const idx: number[] = [];
  rows.forEach(([y, z, hw], i) => {
    const sag = i === rows.length - 1 ? notch : 0;
    pos.push(-hw, y, z, 0, y + sag, z - hw * 0.25, hw, y, z);
  });
  for (let i = 0; i + 1 < rows.length; i++) {
    const a = i * 3;
    const b = a + 3;
    for (const o of [0, 1]) {
      idx.push(a + o, b + o, a + o + 1, a + o + 1, b + o, b + o + 1);
      idx.push(a + o, a + o + 1, b + o, a + o + 1, b + o + 1, b + o);
    }
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  geo.setAttribute('uv', new BufferAttribute(new Float32Array((pos.length / 3) * 2), 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

const MATRON = {
  ROBE: 0xd9d2e6, TRIM: 0x4a3470, SHARDS: 8, HALO_R: 0.7, HALO_Y: 2.0, SHARD_GLOW: 2.6, ORB_GLOW: 3.2, STAFF_SCALE: 1.4,
} as const;

/** The Hex Matron: floor-length robe, high collar, mantle, a tall mitre and a wide halo of witchfire shards. */
function matronParts(props: Object3D): ExtraPart[] {
  const robe = new Color(MATRON.ROBE);
  const trim = new Color(MATRON.TRIM);
  const green = new Color(PALETTE.hexGreen).multiplyScalar(MATRON.SHARD_GLOW);
  const violet = new Color(PALETTE.hexViolet).multiplyScalar(MATRON.SHARD_GLOW);
  const cloth: [number, number, number] = [0, 1, 1];
  const parts: ExtraPart[] = [
    ...shellParts(0.3, 0.66, 0.62, 9, 'hips', 0.33, robe, cloth),
    ...shellParts(0.27, 0.31, 0.34, 9, 'spine', 0.8, robe, cloth),
    // hem band and belt
    modelPart(new CylinderGeometry(0.675, 0.69, 0.07, 9, 1, true), 'hips', matrixOf(0, 0.06, 0), [0, 0, 1], trim),
    modelPart(new CylinderGeometry(0.33, 0.33, 0.08, 9), 'spine', matrixOf(0, 0.64, 0), [0, 0, 1], trim),
    modelPart(new OctahedronGeometry(0.09), 'spine', matrixOf(0, 0.64, 0.33), [1, 0, 1], green),
    // mantle falling from the shoulders to the floor
    {
      geometry: panelGeometry([[1.28, -0.2, 0.34], [0.9, -0.36, 0.5], [0.45, -0.52, 0.62], [0.08, -0.7, 0.7]], 0.14),
      bone: 'chest', matrix: new Matrix4(), mask: cloth, tint: robe.clone().multiplyScalar(0.8), owned: true, space: 'model',
    },
  ];
  // high collar: blades fanning out behind the skull
  for (let i = 0; i < 5; i++) {
    const a = (i - 2) * 0.42;
    const h = i === 2 ? 0.62 : i % 2 === 1 ? 0.5 : 0.36;
    parts.push(modelPart(new ConeGeometry(0.11, h, 4), 'chest',
      matrixOf(Math.sin(a) * 0.3, 1.34 + h * 0.4, -0.16 - Math.cos(a) * 0.1, -0.35, 0, -a * 0.7), [0, 0, 1], trim));
  }
  // mitre: a slender horned crown instead of the common mage's floppy hat, so the skull and collar stay readable from above
  parts.push(modelPart(new CylinderGeometry(0.3, 0.34, 0.14, 8), 'head', matrixOf(0, 1.93, 0), [0, 0, 1], trim));
  parts.push(modelPart(new ConeGeometry(0.2, 0.95, 5), 'head', matrixOf(0, 2.45, -0.04, -0.12), [0, 1, 1], robe));
  parts.push(modelPart(new OctahedronGeometry(0.1), 'head', matrixOf(0, 1.95, 0.33), [1, 0, 1], green));
  for (const side of [-1, 1]) {
    parts.push(modelPart(new ConeGeometry(0.09, 0.6, 4), 'head', matrixOf(side * 0.36, 2.2, -0.05, 0, 0, -side * 0.55), [0, 0, 1], trim));
  }
  // halo: shards orbiting the head, alternating witchfire green and hex violet
  for (let i = 0; i < MATRON.SHARDS; i++) {
    const a = (i / MATRON.SHARDS) * Math.PI * 2;
    const long = i % 2 === 0 ? 1.6 : 1;
    const shard = new OctahedronGeometry(0.1);
    shard.scale(0.7, 2.6 * long, 0.7);
    parts.push(modelPart(shard, 'head',
      matrixOf(Math.sin(a) * MATRON.HALO_R, MATRON.HALO_Y + (i % 2) * 0.07, Math.cos(a) * MATRON.HALO_R, Math.cos(a) * 0.9, 0, -Math.sin(a) * 0.9),
      [1, 0, 1], i % 2 === 0 ? violet : green));
  }
  // staff with a burning orb at its head, witchfire in the off hand
  const staff = propPart(props, 'skel_staff', 'handslotr', matrixOf(0, 0, 0, 0, 0, 0, MATRON.STAFF_SCALE));
  parts.push(staff);
  const tip = farEnd(staff);
  const orb = new OctahedronGeometry(0.17);
  parts.push({ geometry: faceted(orb), bone: 'handslotr', matrix: new Matrix4().makeTranslation(tip.x, tip.y, tip.z), mask: [1, 0, 1], tint: new Color(PALETTE.hexGreen).multiplyScalar(MATRON.ORB_GLOW), owned: true });
  parts.push({ geometry: faceted(new OctahedronGeometry(0.13)), bone: 'handslotl', matrix: new Matrix4(), mask: [1, 0, 1], tint: violet, owned: true });
  return parts;
}

/** Point of an attachment's bounding box that lies farthest from the grip (the head of a staff, the tip of a bolt). */
function farEnd(part: ExtraPart): Vector3 {
  part.geometry.computeBoundingBox();
  const box = new Box3().copy(part.geometry.boundingBox ?? new Box3()).applyMatrix4(part.matrix);
  const size = box.getSize(new Vector3());
  const centre = box.getCenter(new Vector3());
  const axis = size.x >= size.y && size.x >= size.z ? 'x' : size.y >= size.z ? 'y' : 'z';
  const out = centre.clone();
  out[axis] = Math.abs(box.max[axis]) > Math.abs(box.min[axis]) ? box.max[axis] - size[axis] * 0.06 : box.min[axis] + size[axis] * 0.06;
  return out;
}

const STALKER = { BONE: 0xd9cfae, DARK: 0x7d7458, CLOTH: 0xcfc9a0, CROSSBOW_SCALE: 1.75, GLOW: 2.4 } as const;

/** The Ossuary Stalker: antlered hood, trophy bones, quiver, tattered cloak strips and an oversized crossbow. */
function stalkerParts(props: Object3D): ExtraPart[] {
  const bone = new Color(STALKER.BONE);
  const dark = new Color(STALKER.DARK);
  const cloth = new Color(STALKER.CLOTH);
  const solid: [number, number, number] = [0, 0, 1];
  const parts: ExtraPart[] = [
    propPart(props, 'skel_crossbow', 'handslotr', matrixOf(0, 0, 0, 0, 0, 0, STALKER.CROSSBOW_SCALE)),
    { ...propPart(props, 'skel_quiver', 'chest', matrixOf(0.16, 1.02, -0.3, 0.25, 0, -0.45, 1.5)), space: 'model' },
  ];
  for (const side of [-1, 1]) {
    // antlers: three tapering segments sweeping up and out of the hood, with one tine each
    const segs: [number, number, number, number, number][] = [
      [0.2, 1.92, 0.34, 0.085, 0.5], [0.36, 2.2, 0.36, 0.065, 0.95], [0.6, 2.42, 0.3, 0.045, 0.45],
    ];
    for (const [x, y, len, r, lean] of segs) {
      parts.push(modelPart(new CylinderGeometry(r * 0.6, r, len, 5), 'head', matrixOf(side * x, y, -0.06, 0, 0, -side * lean), solid, bone));
    }
    parts.push(modelPart(new ConeGeometry(0.04, 0.3, 4), 'head', matrixOf(side * 0.74, 2.6, -0.06, 0, 0, -side * 0.15), solid, bone));
    parts.push(modelPart(new ConeGeometry(0.04, 0.26, 4), 'head', matrixOf(side * 0.3, 2.3, 0.06, 0.5, 0, side * 0.3), solid, bone));
    // shoulder trophies: rib spikes
    for (let i = 0; i < 3; i++) {
      const h = 0.36 - i * 0.07;
      parts.push(modelPart(new ConeGeometry(0.06, h, 4), 'chest',
        matrixOf(side * (0.27 + i * 0.09), 1.3 + h * 0.3 - i * 0.05, -0.04, -0.15, 0, -side * (0.5 + i * 0.35)), solid, i === 0 ? bone : dark));
    }
    // skulls on the belt
    parts.push(modelPart(new DodecahedronGeometry(0.105), 'hips', matrixOf(side * 0.27, 0.5, 0.08), solid, bone));
    // tattered strips below the cloak
    parts.push({
      geometry: panelGeometry([[0.72, -0.24, 0.11], [0.34, -0.3, 0.09], [side < 0 ? 0.02 : 0.14, -0.34, 0.03]]),
      bone: 'chest', matrix: matrixOf(side * 0.2, 0, 0, 0, side * 0.2), mask: [0, 1, 1], tint: cloth, owned: true, space: 'model',
    });
  }
  parts.push({
    geometry: panelGeometry([[0.72, -0.26, 0.1], [0.3, -0.36, 0.08], [0.06, -0.4, 0.02]]),
    bone: 'chest', matrix: new Matrix4(), mask: [0, 1, 1], tint: cloth.clone().multiplyScalar(0.8), owned: true, space: 'model',
  });
  // necklace of knuckle bones and a trophy skull on the back
  for (let i = 0; i < 5; i++) {
    const a = (i - 2) * 0.32;
    parts.push(modelPart(new OctahedronGeometry(0.05), 'chest', matrixOf(Math.sin(a) * 0.24, 1.2 - Math.cos(a) * 0.08, 0.2 + Math.cos(a) * 0.05), solid, bone));
  }
  parts.push(modelPart(new DodecahedronGeometry(0.13), 'chest', matrixOf(-0.14, 1.12, -0.3), solid, bone));
  parts.push(modelPart(new OctahedronGeometry(0.07), 'chest', matrixOf(0, 1.06, 0.24), [1, 0, 1], new Color(PALETTE.sickly).multiplyScalar(STALKER.GLOW)));
  return parts;
}

/** Removes tracks that cost mixer time without changing the pose (scale, IK helpers, constant == rest). */
function optimiseClip(clip: AnimationClip, rig: Object3D): AnimationClip {
  const keep: KeyframeTrack[] = [];
  for (const track of clip.tracks) {
    const dot = track.name.lastIndexOf('.');
    const node = track.name.slice(0, dot);
    const prop = track.name.slice(dot + 1);
    if (prop === 'scale' || IK_BONE_PATTERN.test(node)) continue;
    const bone = rig.getObjectByName(node);
    if (bone) {
      const size = track.getValueSize();
      const rest = prop === 'position' ? bone.position.toArray() : bone.quaternion.toArray();
      let same = true;
      for (let i = 0; i < track.values.length && same; i++) {
        if (Math.abs(track.values[i] - rest[i % size]) > TRACK_EPSILON) same = false;
      }
      if (same) continue;
    }
    keep.push(track);
  }
  clip.tracks = keep;
  return clip;
}

function clipMap(gltf: GLTF): Map<string, AnimationClip> {
  const map = new Map<string, AnimationClip>();
  for (const clip of gltf.animations) map.set(clip.name, optimiseClip(clip, gltf.scene));
  return map;
}

function firstMap(root: Object3D, materialName?: string): Texture {
  let found: Texture | null = null;
  root.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh || found) return;
    const mat = mesh.material as Material & { map?: Texture | null };
    if (mat.map && (!materialName || mat.name === materialName)) found = mat.map;
  });
  if (!found) throw new Error('model without base colour texture');
  return found;
}

function disposeSource(root: Object3D, keepMaps: Set<Texture>): void {
  const seen = new Set<Texture>();
  root.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    const mat = mesh.material as Material & { map?: Texture | null };
    if (mat.map && !keepMaps.has(mat.map) && !seen.has(mat.map)) {
      seen.add(mat.map);
      mat.map.dispose();
      (mat.map.image as { close?: () => void } | null)?.close?.();
    }
    mat.dispose();
  });
}

export async function loadAssets(onProgress: (loaded: number, total: number) => void): Promise<Assets> {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  let loaded = 0;
  onProgress(0, FILES.length);
  const entries = await Promise.all(FILES.map(async (name) => {
    const gltf = await loader.loadAsync(`${MODEL_BASE}${name}.glb`);
    loaded++;
    onProgress(loaded, FILES.length);
    return [name, gltf] as const;
  }));
  const files = Object.fromEntries(entries) as Record<FileName, GLTF>;

  const props = files.props.scene;
  props.updateMatrixWorld(true);
  const skeletonMap = firstMap(files.skel_warrior.scene, 'skeleton');
  const rogueMap = firstMap(files.hero_rogue.scene);
  const dungeonMap = firstMap(files.dungeon.scene);
  const keepMaps = new Set<Texture>([skeletonMap, rogueMap, dungeonMap]);

  // Heroes are baked lazily per look (class, head, cape, style); their source scenes stay alive for that.
  const heroMaps = {} as Record<ClassId, Texture>;
  const heroCloth = {} as Record<ClassId, (u: number, v: number) => number>;
  for (const cls of CLASS_IDS) {
    const map = firstMap(files[`hero_${cls}`].scene);
    heroMaps[cls] = map;
    keepMaps.add(map);
    heroCloth[cls] = clothSampler(map, HERO_OUTFIT[cls].cloth);
  }
  const heroCache = new Map<string, CharacterTemplate>();
  const disposeTemplate = (tpl: CharacterTemplate): void => {
    const body = tpl.scene.getObjectByName(BODY_MESH_NAME) as SkinnedMesh | undefined;
    body?.geometry.dispose();
    body?.skeleton.dispose();
  };
  const heroTemplate = (cls: ClassId, look: Look): CharacterTemplate => {
    const key = lookKey(cls, look);
    let tpl = heroCache.get(key);
    if (!tpl) {
      const outfit = HERO_OUTFIT[cls];
      const style = Math.max(0, Math.min(outfit.gear.length - 1, Math.floor(look.style)));
      const keep = new Set<string>([...outfit.gear[style], ...outfit.belt[style]]);
      if (look.head && outfit.head) keep.add(outfit.head);
      if (look.cape) keep.add(outfit.cape);
      const rehang = new Map<string, { bone: string; matrix: Matrix4 }>();
      for (const name of outfit.belt[style]) rehang.set(name, { bone: 'hips', matrix: matrixOf(BELT.X, BELT.Y, BELT.Z, BELT.RX, 0, BELT.RZ) });
      // the rogue's hood is a different head mesh: the hooded file is the source when the look shows it
      const file: FileName = cls === 'rogue' && look.head ? 'hero_rogue_hooded' : `hero_${cls}`;
      tpl = bakeCharacter(files[file].scene, heroMaps[cls], { keepRigid: (n) => keep.has(n), extras: [], cloth: heroCloth[cls], rehang });
      tpl.key = key;
      heroCache.set(key, tpl);
    }
    tpl.refs++;
    return tpl;
  };
  const releaseHero = (tpl: CharacterTemplate): void => {
    tpl.refs--;
    if (tpl.refs > 0) return;
    heroCache.delete(tpl.key);
    disposeTemplate(tpl);
  };

  const HAND_R = 'handslotr';
  const HAND_L = 'handslotl';
  const id = (): Matrix4 => new Matrix4();
  const enemySpecs: Record<EnemyKind, BakeSpec> = {
    minion: { keepRigid: () => true, extras: [propPart(props, 'skel_blade', HAND_R, matrixOf(0, 0, 0, 0, 0, 0, 0.8))] },
    warrior: {
      keepRigid: () => true,
      extras: [propPart(props, 'skel_blade', HAND_R, id()), propPart(props, 'skel_shield', HAND_L, id())],
    },
    archer: { keepRigid: () => true, extras: [propPart(props, 'skel_crossbow', HAND_R, id())] },
    mage: { keepRigid: () => true, extras: [propPart(props, 'skel_staff', HAND_R, id())] },
    champion: {
      keepRigid: () => true,
      extras: [
        propPart(props, 'skel_axe', HAND_R, matrixOf(0, 0, 0, 0, 0, 0, 1.25)),
        propPart(props, 'skel_axe', HAND_L, matrixOf(0, 0, 0, 0, Math.PI, 0, 1.25)),
      ],
    },
    regent: {
      keepRigid: () => false,
      extras: [
        propPart(props, 'skel_blade', HAND_R, matrixOf(0, 0, 0, 0, 0, 0, 1.45), [0.3, 0, 0]),
        propPart(props, 'skel_staff', HAND_L, matrixOf(0, 0, 0, 0, Math.PI, 0, 1.1)),
        ...crownParts(),
      ],
    },
    matron: { keepRigid: () => false, extras: matronParts(props) },
    stalker: { keepRigid: () => true, extras: stalkerParts(props) },
  };
  const enemies = {} as Record<EnemyKind, CharacterTemplate>;
  for (const kind of ENEMY_KINDS) {
    const scene = files[ENEMY_MODEL[kind] as FileName].scene;
    enemies[kind] = bakeCharacter(scene, skeletonMap, enemySpecs[kind]);
  }

  const propGeometry = (name: PropName): BufferGeometry => {
    const { root, main } = propMeshes(props, name);
    return plainGeometry(main.geometry, new Matrix4().copy(root.matrixWorld).invert().multiply(main.matrixWorld));
  };
  const propGeos: Record<PropName, BufferGeometry> = {
    arrow: propGeometry('arrow'), dagger: propGeometry('dagger'), skel_arrow: propGeometry('skel_arrow'),
  };

  const heroClips = clipMap(files.anims_hero);
  const skelClips = clipMap(files.anims_skel);

  // The dungeon kit is baked lazily per piece; its source scene stays alive for that.
  const dungeon = files.dungeon.scene;
  dungeon.updateMatrixWorld(true);
  const pieces = new Map<string, BufferGeometry>();
  const piece = (name: string): BufferGeometry => {
    const cached = pieces.get(name);
    if (cached) return cached;
    const root = dungeon.getObjectByName(name);
    if (!root) throw new Error(`unknown dungeon piece "${name}"`);
    const inv = new Matrix4().copy(root.matrixWorld).invert();
    const parts: BufferGeometry[] = [];
    root.traverse((o) => {
      const mesh = o as Mesh;
      if (mesh.isMesh) parts.push(plainGeometry(mesh.geometry, new Matrix4().multiplyMatrices(inv, mesh.matrixWorld)));
    });
    const geo = parts.length === 1 ? parts[0] : mergeGeometries(parts, false);
    if (!geo) throw new Error(`failed to bake dungeon piece "${name}"`);
    if (parts.length > 1) for (const p of parts) p.dispose();
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    pieces.set(name, geo);
    return geo;
  };

  // Source meshes of the skeletons / props are no longer needed once baked (heroes are re-baked per look).
  for (const name of FILES) {
    if (name === 'dungeon' || name.startsWith('anims') || name.startsWith('hero_')) continue;
    disposeSource(files[name].scene, keepMaps);
  }

  const dispose = (): void => {
    for (const geo of pieces.values()) geo.dispose();
    pieces.clear();
    for (const geo of Object.values(propGeos)) geo.dispose();
    for (const tpl of [...heroCache.values(), ...Object.values(enemies)]) disposeTemplate(tpl);
    heroCache.clear();
    disposeSource(dungeon, new Set());
    for (const name of FILES) if (name.startsWith('hero_')) disposeSource(files[name].scene, keepMaps);
    for (const map of keepMaps) map.dispose();
  };

  return {
    heroTemplate, releaseHero, heroTemplateCount: () => heroCache.size,
    enemies, heroClips, skelClips, dungeonMap, rogueMap, skeletonMap, props: propGeos, piece, dispose,
  };
}
