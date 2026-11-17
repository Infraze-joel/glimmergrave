/**
 * Asset library: loads the optimised KayKit GLBs once and bakes them into render-friendly templates.
 *
 * Every character (hero or skeleton, including its outfit and weapons) is baked into ONE skinned geometry
 * so a character costs a single draw call: rigid attachments are re-expressed as vertices weighted 100 % to
 * the bone they hang from. Templates are instantiated with SkeletonUtils.clone().
 */
import {
  BufferAttribute, BufferGeometry, Color, ConeGeometry, CylinderGeometry, Matrix3, Matrix4, Mesh,
  OctahedronGeometry, Quaternion, Skeleton, SkinnedMesh, Vector3,
} from 'three';
import type { AnimationClip, Bone, InterleavedBufferAttribute, KeyframeTrack, Material, Object3D, Texture } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { CLASS_IDS, ENEMY_KINDS } from '@shared/types.ts';
import type { ClassId, EnemyKind } from '@shared/types.ts';
import { ENEMY_MODEL, HERO_PARTS, MODEL_BASE, PALETTE } from './config.ts';

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
}

export type PropName = 'arrow' | 'dagger' | 'skel_arrow';

export interface Assets {
  heroes: Record<ClassId, CharacterTemplate>;
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
}

interface BakeSpec {
  /** Which optional (rigid) child meshes of the source stay. Skinned body parts are always kept. */
  keepRigid: (name: string) => boolean;
  extras: ExtraPart[];
}

const FILES = [
  'hero_knight', 'hero_barbarian', 'hero_mage', 'hero_rogue',
  'skel_minion', 'skel_warrior', 'skel_rogue', 'skel_mage',
  'anims_hero', 'anims_skel', 'dungeon', 'props',
] as const;
type FileName = (typeof FILES)[number];

const CLOTH_PATTERN = /cape|cloak/i;
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

function decorate(geo: BufferGeometry, mask: readonly number[], tint: Color): void {
  const count = geo.getAttribute('position').count;
  geo.setAttribute('aMask', fillAttribute(count, mask));
  geo.setAttribute('aTint', fillAttribute(count, [tint.r, tint.g, tint.b]));
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
    decorate(geo, [glow, cloth, 0], WHITE);
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
    decorate(geo, mask, tint);
    (shadow ? shadowParts : parts).push(geo);
  };

  for (const mesh of rigid) {
    const shadow = mesh.name.endsWith(SHADOW_SUFFIX);
    const baseName = shadow ? mesh.name.slice(0, -SHADOW_SUFFIX.length) : mesh.name;
    if (!spec.keepRigid(baseName)) continue;
    const bone = findBone(mesh);
    if (!bone) continue;
    _m2.copy(bone.matrixWorld).invert().multiply(mesh.matrixWorld);
    addRigid(mesh.geometry, bone, _m2.clone(), [0, CLOTH_PATTERN.test(mesh.name) ? 1 : 0, 0], WHITE, shadow);
  }
  for (const extra of spec.extras) {
    const bone = skeleton.bones.find((b) => b.name === extra.bone);
    if (bone) {
      addRigid(extra.geometry, bone, extra.matrix, extra.mask, extra.tint);
      if (extra.shadow) addRigid(extra.shadow, bone, extra.shadowMatrix ?? extra.matrix, extra.mask, extra.tint, true);
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
  return { scene, map, triangles: mainCount / 3 };
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

  const heroes = {} as Record<ClassId, CharacterTemplate>;
  for (const cls of CLASS_IDS) {
    const scene = files[`hero_${cls}`].scene;
    const map = firstMap(scene);
    keepMaps.add(map);
    const keep = new Set(HERO_PARTS[cls]);
    heroes[cls] = bakeCharacter(scene, map, { keepRigid: (n) => keep.has(n), extras: [] });
  }

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

  // Source meshes of the characters / props are no longer needed once baked.
  for (const name of FILES) {
    if (name === 'dungeon' || name.startsWith('anims')) continue;
    disposeSource(files[name].scene, keepMaps);
  }

  const dispose = (): void => {
    for (const geo of pieces.values()) geo.dispose();
    pieces.clear();
    for (const geo of Object.values(propGeos)) geo.dispose();
    for (const tpl of [...Object.values(heroes), ...Object.values(enemies)]) {
      const body = tpl.scene.getObjectByName(BODY_MESH_NAME) as SkinnedMesh | undefined;
      body?.geometry.dispose();
      body?.skeleton.dispose();
    }
    disposeSource(dungeon, new Set());
    for (const map of keepMaps) map.dispose();
  };

  return { heroes, enemies, heroClips, skelClips, dungeonMap, rogueMap, skeletonMap, props: propGeos, piece, dispose };
}
