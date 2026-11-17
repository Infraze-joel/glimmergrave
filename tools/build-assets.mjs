// Asset pipeline: converts the CC0 KayKit source packs into web-optimised GLBs.
// Usage: node tools/build-assets.mjs <dir containing the three cloned KayKit repos>
// Sources (all CC0, Kay Lousberg): see docs/ASSETS.md
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune, resample, quantize, meshopt, mergeDocuments, unpartition, simplify, compactPrimitive, weld } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptDecoder, MeshoptSimplifier } from 'meshoptimizer';
import { mkdirSync, statSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SRC = resolve(process.argv[2] ?? '../assets-src');
const OUT = resolve('client/public/assets/models');
mkdirSync(OUT, { recursive: true });
await MeshoptEncoder.ready;
await MeshoptSimplifier.ready;
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });

const ADV = join(SRC, 'KayKit-Character-Pack-Adventures-1.0/addons/kaykit_character_pack_adventures');
const SKE = join(SRC, 'KayKit-Character-Pack-Skeletons-1.0/addons/kaykit_character_pack_skeletons');
const DUN = join(SRC, 'KayKit-Dungeon-Remastered-1.0/addons/kaykit_dungeon_remastered/Assets/gltf');

const HERO_CLIPS = ['Idle', 'Running_A', 'Running_B', 'Running_Strafe_Left', 'Running_Strafe_Right', 'Walking_Backwards',
  'Dodge_Forward', '1H_Melee_Attack_Chop', '1H_Melee_Attack_Slice_Diagonal', '1H_Melee_Attack_Slice_Horizontal',
  '1H_Melee_Attack_Stab', '2H_Melee_Attack_Chop', '2H_Melee_Attack_Slice', '2H_Melee_Attack_Spin', '2H_Melee_Attack_Spinning',
  '2H_Melee_Idle', 'Block', 'Block_Attack', 'Spellcast_Shoot', 'Spellcast_Long', 'Spellcast_Raise', 'Spellcasting',
  '1H_Ranged_Shoot', '2H_Ranged_Shoot', '2H_Ranged_Aiming', 'Throw', 'Hit_A', 'Hit_B', 'Death_A', 'Death_A_Pose',
  'Lie_Idle', 'Lie_StandUp', 'Cheer', 'Interact', 'Use_Item'];
const SKEL_CLIPS = ['Idle', 'Idle_Combat', 'Running_A', 'Running_C', 'Walking_D_Skeletons', '1H_Melee_Attack_Chop',
  '1H_Melee_Attack_Slice_Diagonal', '1H_Melee_Attack_Slice_Horizontal', '1H_Melee_Attack_Jump_Chop', '2H_Melee_Attack_Chop',
  '2H_Melee_Attack_Slice', '2H_Melee_Attack_Spin', '2H_Melee_Attack_Spinning', '2H_Ranged_Shoot', '2H_Ranged_Aiming',
  '2H_Ranged_Reload', 'Spellcast_Shoot', 'Spellcast_Long', 'Spellcast_Summon', 'Spellcast_Raise', 'Hit_A', 'Hit_B',
  'Death_A', 'Death_A_Pose', 'Death_C_Skeletons', 'Death_C_Pose', 'Spawn_Ground_Skeletons', 'Skeletons_Awaken_Floor',
  'Taunt', 'Taunt_Longer', 'Block', 'Dodge_Forward',
  // update 2: Hex Matron channel + Ossuary Stalker leap
  'Spellcasting', 'Jump_Start', 'Jump_Idle', 'Jump_Land', '2H_Ranged_Shooting'];

const DUNGEON = ['floor_tile_large', 'floor_tile_small', 'floor_tile_small_broken_A', 'floor_tile_small_broken_B',
  'floor_tile_small_decorated', 'floor_tile_small_weeds_A', 'floor_tile_small_weeds_B', 'floor_tile_large_rocks',
  'floor_dirt_large', 'floor_dirt_large_rocky', 'floor_tile_big_grate', 'wall', 'wall_cracked', 'wall_broken',
  'wall_corner', 'wall_doorway', 'wall_gated', 'wall_arched', 'wall_pillar', 'wall_half', 'wall_endcap',
  'wall_window_closed', 'wall_shelves', 'pillar', 'pillar_decorated', 'column', 'torch_mounted', 'torch_lit',
  'barrel_large', 'barrel_small', 'barrel_small_stack', 'box_large', 'box_small', 'box_stacked', 'crates_stacked',
  'chest', 'chest_gold', 'banner_patternA_red', 'banner_patternB_blue', 'banner_patternC_green', 'banner_shield_red',
  'banner_thin_yellow', 'rubble_large', 'rubble_half', 'candle_triple', 'candle_lit', 'coin_stack_large',
  'coin_stack_medium', 'sword_shield', 'sword_shield_gold', 'sword_shield_broken', 'keg', 'table_long_broken',
  'table_medium_broken', 'barrier', 'barrier_column', 'stool', 'trunk_large_A', 'shelf_large', 'bottle_A_green', 'key',
  // update 2: biome dressing (flooded catacombs, ember foundry) and the wardrobe diorama
  'floor_dirt_small_A', 'floor_dirt_small_B', 'floor_dirt_small_C', 'floor_dirt_small_D', 'floor_dirt_small_weeds',
  'floor_tile_grate', 'keg_decorated', 'barrel_large_decorated', 'table_long', 'trunk_small_A', 'chair', 'stairs_wide',
  'wall_archedwindow_gated', 'banner_patternA_green', 'banner_blue', 'banner_patternB_red', 'banner_brown',
  'banner_triple_yellow', 'coin_stack_small', 'candle_melted', 'plate_stack', 'shelf_small_candles'];

const PROPS = [
  [join(SKE, 'Assets/gltf/Skeleton_Blade.gltf'), 'skel_blade'], [join(SKE, 'Assets/gltf/Skeleton_Axe.gltf'), 'skel_axe'],
  [join(SKE, 'Assets/gltf/Skeleton_Staff.gltf'), 'skel_staff'], [join(SKE, 'Assets/gltf/Skeleton_Crossbow.gltf'), 'skel_crossbow'],
  [join(SKE, 'Assets/gltf/Skeleton_Shield_Large_A.gltf'), 'skel_shield'], [join(SKE, 'Assets/gltf/Skeleton_Arrow.gltf'), 'skel_arrow'],
  [join(ADV, 'Assets/gltf/arrow.gltf'), 'arrow'], [join(ADV, 'Assets/gltf/dagger.gltf'), 'dagger'],
  [join(SKE, 'Assets/gltf/Skeleton_Quiver.gltf'), 'skel_quiver'], [join(SKE, 'Assets/gltf/Skeleton_Shield_Small_B.gltf'), 'skel_buckler'],
];

const report = [];
function dropAnimation(a) {
  for (const c of a.listChannels()) c.dispose();
  for (const s of a.listSamplers()) s.dispose();
  a.dispose();
}

async function finish(doc, name) {
  await doc.transform(unpartition(), dedup(), prune(), quantize(), meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
  const out = join(OUT, name + '.glb');
  await io.write(out, doc);
  report.push([name, statSync(out).size]);
}

// Up to 44 skeletons are on screen at once (and drawn a second time into the shadow map on 'high'), seen from
// ~30 m away: they are decimated to stay inside the triangle budget. Heroes keep the full source detail.
const ENEMY_LOD = { ratio: Number(process.env.ENEMY_LOD_RATIO ?? 0.4), error: Number(process.env.ENEMY_LOD_ERROR ?? 0.03) };
// Every decimated mesh also gets a much coarser sibling node "<name>_shadow". The client appends it to the same
// vertex/index buffers and switches the draw range while rendering the shadow map (render/assets.ts).
const SHADOW_LOD = { ratio: 0.16, error: 0.25 };
const SHADOW_SUFFIX = '_shadow';

async function decimate(doc) {
  await doc.transform(weld(), simplify({ simplifier: MeshoptSimplifier, ...ENEMY_LOD }));
  const scene = doc.getRoot().listScenes()[0];
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh || node.getName().endsWith(SHADOW_SUFFIX)) continue;
    const lod = doc.createMesh(mesh.getName() + SHADOW_SUFFIX);
    for (const prim of mesh.listPrimitives()) {
      const copy = prim.clone();
      const src = new Uint32Array(copy.getIndices().getArray());
      const target = Math.floor((src.length * SHADOW_LOD.ratio) / 3) * 3;
      // 'Permissive' lets the simplifier collapse across the hard-edge seams of the low-poly kit; fine for a silhouette
      const [dst] = MeshoptSimplifier.simplify(src, copy.getAttribute('POSITION').getArray(), 3, target, SHADOW_LOD.error, ['Permissive', 'Prune']);
      if (dst.length < 3) continue;
      copy.setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(dst)));
      compactPrimitive(copy);
      lod.addPrimitive(copy);
    }
    if (lod.listPrimitives().length === 0) { lod.dispose(); continue; }
    const lodNode = doc.createNode(node.getName() + SHADOW_SUFFIX).setMesh(lod).setSkin(node.getSkin())
      .setTranslation(node.getTranslation()).setRotation(node.getRotation()).setScale(node.getScale());
    const parent = node.getParentNode();
    if (parent) parent.addChild(lodNode); else scene.addChild(lodNode);
  }
}

async function character(src, name, lod = false) {
  const doc = await io.read(src);
  for (const a of doc.getRoot().listAnimations()) dropAnimation(a);
  if (lod) await decimate(doc);
  await finish(doc, name);
}

async function animations(src, name, keep) {
  const doc = await io.read(src);
  const root = doc.getRoot();
  const have = new Set();
  for (const a of root.listAnimations()) {
    if (!keep.includes(a.getName())) dropAnimation(a); else have.add(a.getName());
  }
  const missing = keep.filter((k) => !have.has(k));
  if (missing.length) throw new Error(`${name}: missing clips ${missing.join(', ')}`);
  for (const n of root.listNodes()) { if (n.getMesh()) n.setMesh(null); n.setSkin(null); }
  for (const s of root.listSkins()) s.dispose();
  await doc.transform(resample({ tolerance: 0.0005 }), prune({ keepLeaves: true, keepAttributes: false }), dedup());
  // prune() may drop non-animated leaf joints; that is fine — clips bind by node name.
  await doc.transform(unpartition(), meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
  const out = join(OUT, name + '.glb');
  await io.write(out, doc);
  report.push([name, statSync(out).size]);
}

async function library(entries, name, lod = false) {
  let target = null;
  for (const [file, nodeName] of entries) {
    const doc = await io.read(file);
    if (lod) await decimate(doc);
    const scene = doc.getRoot().listScenes()[0];
    // Wrap each source file in a single named root so the client can look pieces up by name.
    const wrapper = doc.createNode(nodeName);
    for (const child of scene.listChildren()) wrapper.addChild(child);
    scene.addChild(wrapper);
    if (!target) { target = doc; continue; }
    mergeDocuments(target, doc);
  }
  const root = target.getRoot();
  const [main, ...rest] = root.listScenes();
  for (const s of rest) { for (const c of s.listChildren()) main.addChild(c); s.dispose(); }
  await finish(target, name);
}

for (const h of ['Knight', 'Barbarian', 'Mage', 'Rogue']) await character(join(ADV, `Characters/gltf/${h}.glb`), `hero_${h.toLowerCase()}`);
// The rogue's hood is a different head mesh, not an attachment: ship the hooded variant for Look.head = true.
await character(join(ADV, 'Characters/gltf/Rogue_Hooded.glb'), 'hero_rogue_hooded');
for (const s of ['Minion', 'Warrior', 'Rogue', 'Mage']) await character(join(SKE, `Characters/gltf/Skeleton_${s}.glb`), `skel_${s.toLowerCase()}`, true);
await animations(join(ADV, 'Characters/gltf/Knight.glb'), 'anims_hero', HERO_CLIPS);
await animations(join(SKE, 'Characters/gltf/Skeleton_Warrior.glb'), 'anims_skel', SKEL_CLIPS);
const dunFiles = new Set(readdirSync(DUN));
await library(DUNGEON.map((n) => {
  const f = dunFiles.has(`${n}.gltf.glb`) ? `${n}.gltf.glb` : `${n}.glb`;
  return [join(DUN, f), n];
}), 'dungeon');
await library(PROPS, 'props', true);

let total = 0;
for (const [n, s] of report) { total += s; console.log(n.padEnd(16), (s / 1024).toFixed(1).padStart(8), 'KB'); }
console.log('TOTAL'.padEnd(16), (total / 1024).toFixed(1).padStart(8), 'KB');
