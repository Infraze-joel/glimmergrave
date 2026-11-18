/**
 * Chamber objectives (update 4), drawn from RunState.objective and the `objective` events:
 *   defend  – the bell shard: a Glimmer crystal grown out of a bronze bell fragment on a plinth; it loses shards as
 *             its health drops, flashes when struck, shatters when it falls, and glows while heroes mend it
 *   ritual  – braziers in ground circles that fill while heroes stand in them and burn once lit
 *   hunt    – the marked targets (the marker itself is drawn on the enemy, see characters.ts)
 *   survive – the great bell above the north wall tolling faster as the timer runs down
 *   vault   – a treasure chamber: reliquary chest on a dais that opens when the objective is done, coin piles, candles
 * Everything the party has to read is drawn in old gold / Glimmer / bell light, never in the hostile red, and all
 * ground marks go into the decal batch before the timed pool, so hostile telegraphs stay on top.
 */
import {
  BufferAttribute, Color, CylinderGeometry, DynamicDrawUsage, Group, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, Object3D, OctahedronGeometry,
  Quaternion, Vector3,
} from 'three';
import type { BufferGeometry, MeshLambertMaterial } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { ObjectiveKind, ObjectiveState } from '@shared/types.ts';
import { OBJECTIVE_TUNING } from '@shared/data/objectives.ts';
import type { Assets } from './assets.ts';
import type { Atlas } from './atlas.ts';
import { DECAL, SPRITE } from './batches.ts';
import type { BillboardBatch, DecalBatch } from './batches.ts';
import type { Enemies, HeroView, Heroes } from './characters.ts';
import { LIMITS, OBJECTIVE_COLOR, PALETTE } from './config.ts';
import type { LevelView } from './level.ts';
import { solidGeometry } from './level.ts';
import { createLevelMaterial } from './materials.ts';
import { rgb } from './vfx.ts';
import type { Vfx } from './vfx.ts';

const CFG = {
  /** Bell shard. Sizes are for an anchor radius of BASE_R; the whole object scales with the anchor. */
  BASE_R: 1.1,
  SIDE_SHARDS: 4,
  /** Health below which the n-th side shard has broken off. */
  SHARD_AT: [0.8, 0.6, 0.4, 0.2],
  MAIN_H: 3.0,
  BELL_ARC: 2.6,
  BELL_TURN: 0.55,
  /** The plinth's atlas texel is a dim grey stone: procedural colours are multiplied up to come out as bronze. */
  BRONZE_GAIN: 4.2,
  CRYSTAL_GLOW: 1.5,
  FLASH_TIME: 0.35,
  SHATTER_TIME: 0.5,
  LOW_HP: 0.35,
  /** Ritual brazier. */
  BRAZIER_H: 1.05,
  FLAMES: 3,
  /** Survive: seconds between tolls at the start and at the end of the timer. */
  TOLL_SLOW: 4.2,
  TOLL_FAST: 0.85,
  /** The bell is a figure of light on the north wall: the game camera never sees anything above the walls. */
  BELL_Y: 2.0,
  BELL_SIZE: 3.8,
  /** Vault. */
  LID_HINGE_Y: 0.82,
  LID_HINGE_Z: -0.56,
  LID_OPEN: 1.75,
  LID_TIME: 0.7,
  DAIS_R: 3.1,
  DAIS_H: 0.2,
  CHEST_SCALE: 1.35,
  REACH: 1.6,
  IRON: [0.2, 0.2, 0.24],
  STONE: [0.56, 0.58, 0.7],
} as const;

/** Coin piles and candles around the reliquary: [piece, x, z, rotY, scale]. Candles carry a flame. */
const HOARD: readonly (readonly [string, number, number, number, number])[] = [
  ['coin_stack_large', -1.75, -0.35, 0.4, 1], ['coin_stack_large', 1.7, -0.6, 2.2, 0.9], ['coin_stack_medium', -1.35, 0.95, 1.1, 1.1],
  ['coin_stack_medium', 1.3, 0.9, 4.0, 1.1], ['coin_stack_medium', 0.2, -1.5, 2.9, 1], ['coin_stack_small', -0.55, 1.5, 0.3, 1.2],
  ['coin_stack_small', 0.7, 1.55, 5.1, 1.2], ['coin_stack_small', -2.3, 0.75, 3.3, 1.1], ['coin_stack_small', 2.35, 0.45, 1.9, 1.1],
  ['candle_triple', -2.45, -1.3, 0.6, 1.25], ['candle_triple', 2.4, -1.45, 3.6, 1.25], ['candle_lit', -2.75, 1.75, 0, 1.1], ['candle_lit', 2.8, 1.6, 0, 1.1],
  // the wider room: lesser chests, trunks and spilled piles around the dais
  ['chest', -5.6, -1.2, 0.5, 1], ['chest', 5.9, -0.6, -0.6, 1], ['trunk_large_A', -4.6, -3.1, 0.3, 1], ['trunk_large_A', 4.4, -3.3, -0.2, 1],
  ['coin_stack_large', -4.5, 0.6, 1.3, 0.9], ['coin_stack_large', 4.7, 1.2, 3.9, 0.9], ['coin_stack_medium', -6.4, 0.5, 0.2, 1.1], ['coin_stack_medium', 6.6, 1.1, 2.4, 1.1],
  ['coin_stack_small', -3.9, 2.4, 2, 1.2], ['coin_stack_small', 3.8, 2.7, 4.4, 1.2], ['coin_stack_medium', 0.4, -4.4, 1.7, 1.2], ['coin_stack_small', -1.6, -4, 0.9, 1.2],
  ['candle_triple', -6.2, -2.6, 1.2, 1.25], ['candle_triple', 6.3, -2.4, 4.1, 1.25], ['keg_decorated', 0, -6.2, 0, 0.8],
];
const CANDLE_FLAME_Y: Record<string, number> = { candle_triple: 0.95, candle_lit: 1.12 };

interface Site { x: number; z: number; r: number; progress: number; lit: boolean; shown: number; flare: number }

const _m = new Matrix4();
const _q = new Quaternion();
const _q2 = new Quaternion();
const _p = new Vector3();
const _s = new Vector3();
const _c = new Color();
const X_AXIS = new Vector3(1, 0, 0);
const Y_AXIS = new Vector3(0, 1, 0);
const Z_AXIS = new Vector3(0, 0, 1);
const GLIMMER = rgb(PALETTE.glimmer);
const GOLD = rgb(PALETTE.objective);
const BELL = rgb(PALETTE.bell);
const RITUAL = rgb(OBJECTIVE_COLOR.ritual);
const VAULT = rgb(OBJECTIVE_COLOR.vault);
const NONE: readonly number[] = [];

function hash1(n: number): number {
  const s = Math.sin(n * 127.1) * 43758.5453;
  return s - Math.floor(s);
}

/** A faceted crystal standing on the origin, shaded into its vertex colours (drawn unlit so it glows). */
function crystalGeometry(): BufferGeometry {
  const geo = new OctahedronGeometry(1).toNonIndexed();
  // a long point above a short root
  const pos = geo.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    pos.setXYZ(i, pos.getX(i) * 0.26, y > 0 ? y * 0.82 : y * 0.18, pos.getZ(i) * 0.26);
  }
  geo.translate(0, 0.18, 0);
  geo.computeVertexNormals();
  const nrm = geo.getAttribute('normal');
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const facet = 0.5 + 0.5 * Math.max(0, nrm.getX(i) * 0.55 + nrm.getZ(i) * 0.75 + 0.25);
    const v = (0.45 + 0.55 * pos.getY(i)) * facet;
    col[i * 3] = v; col[i * 3 + 1] = v; col[i * 3 + 2] = v;
  }
  geo.setAttribute('color', new BufferAttribute(col, 3));
  return geo;
}

export class Objectives {
  private readonly vfx: Vfx;
  private readonly atlas: Atlas;
  private readonly assets: Assets;
  private readonly enemies: Enemies;
  private readonly heroes: Heroes;
  private readonly level: LevelView;
  private readonly group = new Group();
  private readonly stone: MeshLambertMaterial;
  private readonly kit: MeshLambertMaterial;
  private readonly crystalMaterial: MeshBasicMaterial;
  private readonly owned: BufferGeometry[] = [];
  private readonly vaultOwned: BufferGeometry[] = [];
  private readonly plinth: Mesh;
  private readonly crystals: InstancedMesh;
  private readonly braziers: InstancedMesh;
  private readonly stoneUv: readonly [number, number];
  /** Vault dressing, built the first time a vault is shown. */
  private vault: { root: Group; lid: Object3D; flames: number[] } | null = null;

  private kind: ObjectiveKind | null = null;
  private done = false;
  private progress = 0;
  private anchorOn = false;
  private ax = 0;
  private az = 0;
  private ar = 1;
  private hp = 1;
  private shownHp = 1;
  private flash = 0;
  private shatter = -1;
  private mending = 0;
  private readonly sites: Site[] = [];
  private siteCount = 0;
  private toll = 0;
  private tollPulse = 0;
  private lid = 0;
  private opened = false;
  private sparkle = 0;
  private shake = 0;
  private near = 0;

  private readonly nearAnchor = (h: HeroView): void => {
    if (h.state !== 'alive') return;
    if (Math.hypot(h.x - this.ax, h.z - this.az) <= this.ar + OBJECTIVE_TUNING.DEFEND.REPAIR_RADIUS) this.near++;
  };

  constructor(parent: Object3D, assets: Assets, atlas: Atlas, stoneUv: readonly [number, number], vfx: Vfx, enemies: Enemies, heroes: Heroes, level: LevelView) {
    this.vfx = vfx;
    this.atlas = atlas;
    this.assets = assets;
    this.enemies = enemies;
    this.heroes = heroes;
    this.level = level;
    this.stoneUv = stoneUv;
    this.stone = createLevelMaterial(assets.dungeonMap);
    this.stone.vertexColors = true;
    this.kit = createLevelMaterial(assets.dungeonMap);
    this.kit.emissive.setRGB(0.07, 0.05, 0.02);
    this.crystalMaterial = new MeshBasicMaterial({ vertexColors: true });

    // plinth and bell fragment
    const [sr, sg, sb] = CFG.STONE;
    const bronze = rgb(PALETTE.bronze);
    const parts: BufferGeometry[] = [];
    const add = (geo: BufferGeometry, y: number, r: number, g: number, b: number, rotY = 0): void => {
      if (rotY !== 0) geo.rotateY(rotY);
      geo.translate(0, y, 0);
      parts.push(solidGeometry(geo, stoneUv, r, g, b));
    };
    add(new CylinderGeometry(1.0, 1.1, 0.3, 8), 0.15, sr, sg, sb);
    add(new CylinderGeometry(0.74, 0.8, 0.3, 8), 0.45, sr * 0.85, sg * 0.85, sb * 0.85);
    // a curved piece of the great bell standing behind the crystal, hollow side to the camera, with a thick lip.
    // The arc is centred on +x so that mirroring z gives the same arc with its faces turned inwards (the inner wall).
    const from = Math.PI / 2 - CFG.BELL_ARC / 2;
    const k = CFG.BRONZE_GAIN;
    const turn = Math.PI / 2 + CFG.BELL_TURN;
    add(new CylinderGeometry(0.6, 0.95, 1.3, 9, 1, true, from, CFG.BELL_ARC), 1.25, bronze[0] * k, bronze[1] * k, bronze[2] * k, turn);
    const inner = new CylinderGeometry(0.54, 0.89, 1.3, 9, 1, true, from, CFG.BELL_ARC);
    inner.scale(1, 1, -1);
    add(inner, 1.25, bronze[0] * k * 0.7, bronze[1] * k * 0.7, bronze[2] * k * 0.7, turn);
    const lip = new CylinderGeometry(0.93, 0.95, 0.16, 9, 1, true, from, CFG.BELL_ARC);
    lip.scale(1, 1, -1);
    add(lip, 0.68, bronze[0] * k * 1.3, bronze[1] * k * 1.3, bronze[2] * k * 1.3, turn);
    const plinthGeo = this.merge(parts);
    this.plinth = new Mesh(plinthGeo, this.stone);
    this.plinth.castShadow = true;
    this.plinth.receiveShadow = true;

    const crystal = crystalGeometry();
    this.owned.push(crystal);
    this.crystals = new InstancedMesh(crystal, this.crystalMaterial, 1 + CFG.SIDE_SHARDS);
    this.crystals.instanceMatrix.setUsage(DynamicDrawUsage);
    for (let i = 0; i <= CFG.SIDE_SHARDS; i++) this.crystals.setColorAt(i, _c.setRGB(1, 1, 1));

    // ritual brazier: foot, stem, an iron bowl with a lip and a bed of coals
    const [ir, ig, ib] = CFG.IRON;
    const bz: BufferGeometry[] = [];
    const part = (geo: BufferGeometry, y: number, k: number): void => {
      geo.translate(0, y, 0);
      bz.push(solidGeometry(geo, stoneUv, ir * k, ig * k, ib * k));
    };
    part(new CylinderGeometry(0.2, 0.46, 0.22, 6), 0.11, 1);
    part(new CylinderGeometry(0.1, 0.14, 0.5, 6), 0.45, 1.3);
    part(new CylinderGeometry(0.66, 0.26, 0.4, 8), 0.86, 1.15);
    part(new CylinderGeometry(0.72, 0.7, 0.08, 8), 1.08, 1.9);
    part(new CylinderGeometry(0.58, 0.58, 0.05, 8), 1.1, 0.35);
    this.braziers = new InstancedMesh(this.merge(bz), this.stone, LIMITS.SITES);
    this.braziers.instanceMatrix.setUsage(DynamicDrawUsage);
    this.braziers.castShadow = true;
    for (let i = 0; i < LIMITS.SITES; i++) {
      this.sites.push({ x: 0, z: 0, r: 1, progress: 0, lit: false, shown: 0, flare: 0 });
      this.braziers.setColorAt(i, _c.setRGB(1, 1, 1));
    }
    for (const mesh of [this.plinth, this.crystals, this.braziers]) {
      mesh.visible = false;
      mesh.frustumCulled = false;
      this.group.add(mesh);
    }
    parent.add(this.group);
  }

  private merge(parts: BufferGeometry[], owner: BufferGeometry[] = this.owned): BufferGeometry {
    const merged = mergeGeometries(parts, false);
    for (const p of parts) p.dispose();
    if (!merged) throw new Error('objective geometry failed');
    owner.push(merged);
    return merged;
  }

  /** Camera shake asked for since the last call. */
  takeShake(): number {
    const s = this.shake;
    this.shake = 0;
    return s;
  }

  get activeKind(): ObjectiveKind | null {
    return this.kind;
  }

  // ------------------------------------------------------------------ state

  /** RunState.objective, on every run-state update (cheap: values are copied, nothing is rebuilt unless the kind changes). */
  set(state: ObjectiveState | null): void {
    const kind = state ? state.kind : null;
    if (kind !== this.kind) this.begin(kind);
    if (!state) return;
    this.progress = state.progress;
    if (state.status === 'done' && !this.done) this.finish();
    const a = state.anchor;
    this.anchorOn = a !== null && (kind === 'defend' || kind === 'vault');
    if (a) {
      this.ax = a.x; this.az = a.z; this.ar = Math.max(0.4, a.r);
      if (kind === 'defend') {
        if (a.hp <= 0 && this.hp > 0 && this.shatter < 0) this.shatter = 0;
        this.hp = a.hp;
      }
    }
    this.siteCount = kind === 'ritual' ? Math.min(LIMITS.SITES, state.sites.length) : 0;
    for (let i = 0; i < this.siteCount; i++) {
      const src = state.sites[i];
      const site = this.sites[i];
      site.x = src.x; site.z = src.z; site.r = src.r; site.progress = src.progress;
      // a site that is already lit when it is first seen (reconnect) simply burns, without the burst
      if (src.lit && !site.lit && site.shown < 0) site.shown = 1;
      site.lit = src.lit;
    }
    this.enemies.setHunted(kind === 'hunt' ? state.targets : NONE, kind === 'hunt' && !state.bonus);
    if (kind === 'hunt' && state.targets.length > 0) {
      // remembered so `bonusLost` and the start flourish can find them
      this.huntIds.length = 0;
      for (let i = 0; i < state.targets.length && i < LIMITS.HUNT_TARGETS; i++) this.huntIds.push(state.targets[i]);
    }
    if (kind === 'vault') this.placeVault();
  }

  private begin(kind: ObjectiveKind | null): void {
    this.kind = kind;
    this.done = false;
    this.progress = 0;
    this.hp = 1;
    this.shownHp = 1;
    this.flash = 0;
    this.shatter = -1;
    this.mending = 0;
    this.toll = 1.2;
    this.tollPulse = 0;
    this.lid = 0;
    this.opened = false;
    this.siteCount = 0;
    this.anchorOn = false;
    for (const site of this.sites) { site.lit = false; site.shown = -1; site.flare = 0; site.progress = 0; }
    this.plinth.visible = false;
    this.crystals.visible = false;
    this.braziers.visible = false;
    if (this.vault) this.vault.root.visible = false;
    if (kind !== 'hunt') this.enemies.setHunted(NONE, false);
  }

  private finish(): void {
    this.done = true;
    if (this.kind === 'vault' && !this.opened) this.open();
  }

  private placeVault(): void {
    if (!this.vault) this.vault = this.buildVault();
    this.vault.root.visible = true;
    this.vault.root.position.set(this.ax, 0, this.az);
  }

  private buildVault(): { root: Group; lid: Object3D; flames: number[] } {
    const root = new Group();
    const [sr, sg, sb] = CFG.STONE;
    const steps: BufferGeometry[] = [];
    const lower = new CylinderGeometry(CFG.DAIS_R, CFG.DAIS_R + 0.15, CFG.DAIS_H, 10);
    lower.translate(0, CFG.DAIS_H / 2, 0);
    steps.push(solidGeometry(lower, this.stoneUv, sr, sg, sb));
    const upper = new CylinderGeometry(1.45, 1.55, 0.16, 8);
    upper.translate(0, CFG.DAIS_H + 0.08, 0);
    steps.push(solidGeometry(upper, this.stoneUv, sr * 0.8, sg * 0.8, sb * 0.8));
    const dais = new Mesh(this.merge(steps, this.vaultOwned), this.stone);
    dais.receiveShadow = true;
    const top = CFG.DAIS_H + 0.16;
    const s = CFG.CHEST_SCALE;
    const body = new Mesh(this.assets.piece('chest_gold', '-lid'), this.kit);
    body.position.y = top;
    body.scale.setScalar(s);
    body.castShadow = true;
    const lidGeo = this.assets.piece('chest_gold', '+lid').clone();
    lidGeo.translate(0, -CFG.LID_HINGE_Y, -CFG.LID_HINGE_Z);
    this.vaultOwned.push(lidGeo);
    const lid = new Mesh(lidGeo, this.kit);
    lid.position.set(0, top + CFG.LID_HINGE_Y * s, CFG.LID_HINGE_Z * s);
    lid.scale.setScalar(s);
    lid.castShadow = true;
    // coin piles and candles: one merged mesh
    const parts: BufferGeometry[] = [];
    const flames: number[] = [];
    for (const [piece, x, z, rot, scale] of HOARD) {
      const geo = this.assets.piece(piece).clone();
      const y = Math.hypot(x, z) < CFG.DAIS_R - 0.4 ? CFG.DAIS_H : 0;
      geo.applyMatrix4(_m.compose(_p.set(x, y, z), _q.setFromAxisAngle(Y_AXIS, rot), _s.set(scale, scale, scale)));
      parts.push(geo);
      const fy = CANDLE_FLAME_Y[piece];
      if (fy !== undefined) flames.push(x, y + fy * scale, z);
    }
    const hoard = new Mesh(this.merge(parts, this.vaultOwned), this.kit);
    hoard.castShadow = true;
    hoard.receiveShadow = true;
    for (const mesh of [dais, body, lid, hoard]) mesh.frustumCulled = false;
    root.add(dais, body, lid, hoard);
    this.group.add(root);
    return { root, lid, flames };
  }

  private open(): void {
    this.opened = true;
    const vfx = this.vfx;
    const y = CFG.DAIS_H + 1.1;
    vfx.flash(this.ax, y + 0.6, this.az, OBJECTIVE_COLOR.vault, 7, 0.6, 2);
    vfx.groundFlash(this.ax, this.az, 12, 0.9, OBJECTIVE_COLOR.vault, 0.7);
    vfx.ring(this.ax, this.az, 1.5, 11, 0.8, OBJECTIVE_COLOR.vault, 0.3, 1.6);
    vfx.motes(this.ax, y, this.az, OBJECTIVE_COLOR.vault, 34, 0.8, 4.2, 1.5);
    vfx.motes(this.ax, y, this.az, PALETTE.glimmer, 16, 0.6, 3.4, 1.7);
    vfx.sparks(this.ax, y, this.az, OBJECTIVE_COLOR.vault, 18, 7);
  }

  // ------------------------------------------------------------------ events

  /** `objective` event. */
  event(kind: ObjectiveKind, what: 'start' | 'site' | 'anchorHit' | 'bonusLost' | 'done', index: number | undefined, bonus: boolean | undefined): void {
    const vfx = this.vfx;
    const hex = OBJECTIVE_COLOR[kind];
    switch (what) {
      case 'start': {
        // each objective announces where it happens: light gathers on the thing the party has to deal with
        if (kind === 'slay') break;
        if ((kind === 'defend' || kind === 'vault') && this.anchorOn) {
          vfx.ring(this.ax, this.az, 13, this.ar * 2, 0.8, hex, 0.25, 1.5);
          vfx.motes(this.ax, 0.3, this.az, hex, 22, this.ar * 2.2, 3, 1.3);
          vfx.flash(this.ax, 1.8, this.az, hex, 5, 0.5, 1.4);
        } else if (kind === 'ritual') {
          for (let i = 0; i < this.siteCount; i++) {
            const site = this.sites[i];
            vfx.ring(site.x, site.z, site.r * 5, site.r * 2, 0.7, hex, 0.25, 1.5, i * 0.12);
            vfx.motes(site.x, 0.2, site.z, hex, 8, site.r * 0.8, 2.4, 1.1);
          }
        } else if (kind === 'survive') {
          this.toll = 0;
        } else if (kind === 'hunt') {
          for (let i = 0; i < this.huntIds.length; i++) {
            const v = this.enemies.get(this.huntIds[i]);
            if (v) vfx.ring(v.x, v.z, v.radius * 16, v.radius * 5, 0.6, hex, 0.25, 1.6, i * 0.1);
          }
        }
        break;
      }
      case 'site': {
        const site = index !== undefined && index >= 0 && index < this.siteCount ? this.sites[index] : null;
        if (!site) break;
        site.lit = true;
        site.shown = 0;
        site.flare = 1;
        const y = CFG.BRAZIER_H + 0.3;
        vfx.flames(site.x, y, site.z, OBJECTIVE_COLOR.ritual, 8, 0.5, 1.6);
        vfx.flash(site.x, y + 0.4, site.z, OBJECTIVE_COLOR.ritual, 4, 0.3, 1.2);
        vfx.sparks(site.x, y, site.z, PALETTE.objective, 16, 8);
        vfx.ring(site.x, site.z, 0.8, site.r * 3.2, 0.6, OBJECTIVE_COLOR.ritual, 0.3, 1.7);
        vfx.groundFlash(site.x, site.z, site.r * 2.6, 0.6, OBJECTIVE_COLOR.ritual, 0.6);
        vfx.motes(site.x, y, site.z, PALETTE.objective, 16, 0.6, 3.6, 1.2);
        break;
      }
      case 'anchorHit': {
        if (!this.anchorOn) break;
        this.flash = 1;
        const y = 1.3 * (this.ar / CFG.BASE_R);
        vfx.shards(this.ax, y, this.az, PALETTE.glimmer, 4, 5, 0.3, 0.6);
        vfx.sparks(this.ax, y, this.az, PALETTE.white, 6, 7);
        vfx.ring(this.ax, this.az, this.ar * 2, this.ar * 4.6, 0.3, PALETTE.white, 0.2, 1.4);
        this.shake += 0.08;
        break;
      }
      case 'bonusLost': {
        if (kind === 'defend' && this.shatter < 0) this.shatter = 0;
        if (kind === 'hunt') {
          // the quarry turns on the hunters
          for (let i = 0; i < this.huntIds.length; i++) {
            const v = this.enemies.get(this.huntIds[i]);
            if (!v) continue;
            vfx.ring(v.x, v.z, v.radius * 2, v.radius * 9, 0.5, PALETTE.hostile, 0.3, 1.8);
            vfx.flash(v.x, v.lift + v.height * 0.6, v.z, PALETTE.hostile, v.height * 2, 0.35, 1.6);
            vfx.sparks(v.x, v.lift + v.height * 0.7, v.z, PALETTE.hostileHot, 12, 8);
          }
          this.shake += 0.2;
        }
        break;
      }
      case 'done': {
        if (!this.done) this.finish();
        if (kind === 'slay') break;
        const earned = bonus === true;
        const x = this.anchorOn ? this.ax : 0;
        const z = this.anchorOn ? this.az : 0;
        if (kind === 'ritual') {
          for (let i = 0; i < this.siteCount; i++) {
            const site = this.sites[i];
            vfx.ring(site.x, site.z, 1, site.r * 4.5, 0.8, hex, 0.3, 1.7, i * 0.1);
            vfx.motes(site.x, CFG.BRAZIER_H, site.z, PALETTE.objective, 12, 0.7, 4, 1.4);
          }
        } else if (kind === 'survive') {
          // the bell tolls the hour: one great wave of bell light through the chamber
          this.tollPulse = 1.6;
          vfx.ring(0, 0, 2, Math.max(this.level.width, this.level.depth, 24) * 1.3, 1.3, PALETTE.bell, 0.2, 1.6);
          vfx.groundFlash(0, 0, Math.max(this.level.width, this.level.depth, 24), 1, PALETTE.bell, 0.4);
        } else if (kind !== 'vault') {
          vfx.ring(x, z, 1, 12, 0.8, hex, 0.3, 1.6);
          vfx.motes(x, 0.4, z, hex, 20, 1.6, 3.4, 1.3);
        }
        if (earned) {
          // bonus met: a second, golden answer on every hero
          this.heroes.forEach(this.cheer);
        }
        break;
      }
    }
  }

  private readonly huntIds: number[] = [];


  private readonly cheer = (h: HeroView): void => {
    this.vfx.ring(h.x, h.z, 0.6, 5.5, 0.7, PALETTE.objective, 0.3, 1.7, 0.15);
    this.vfx.motes(h.x, 0.2, h.z, PALETTE.objective, 14, 0.8, 3.4, 1.2);
  };

  // ------------------------------------------------------------------ frame

  update(dt: number, time: number, decals: DecalBatch, fx: BillboardBatch, ui: BillboardBatch): void {
    const kind = this.kind;
    if (!kind || kind === 'slay' || kind === 'hunt') return;
    if (kind === 'defend') this.drawShard(dt, time, decals, fx);
    else if (kind === 'ritual') this.drawRitual(dt, time, decals, fx);
    else if (kind === 'survive') this.drawBell(dt, time, decals, fx);
    else this.drawVault(dt, time, decals, fx, ui);
  }

  private drawShard(dt: number, time: number, decals: DecalBatch, fx: BillboardBatch): void {
    const on = this.anchorOn;
    this.plinth.visible = on;
    this.crystals.visible = on;
    if (!on) return;
    const scale = this.ar / CFG.BASE_R;
    const x = this.ax;
    const z = this.az;
    this.plinth.position.set(x, 0, z);
    this.plinth.scale.setScalar(scale);
    const hp = Math.max(0, Math.min(1, this.hp));
    // a shard breaks off each time the health crosses one of its thresholds
    for (let i = 0; i < CFG.SIDE_SHARDS; i++) {
      if (this.shownHp > CFG.SHARD_AT[i] && hp <= CFG.SHARD_AT[i] && hp > 0) {
        const a = (i / CFG.SIDE_SHARDS) * Math.PI * 2 + 0.6;
        this.vfx.shards(x + Math.sin(a) * 0.7 * scale, 1.5 * scale, z + Math.cos(a) * 0.7 * scale, PALETTE.glimmer, 7, 6, 0.4, 0.5);
        this.vfx.flash(x, 1.5 * scale, z, PALETTE.white, 3 * scale, 0.2, 1.4);
      }
    }
    this.shownHp = hp;
    if (this.flash > 0) this.flash = Math.max(0, this.flash - dt / CFG.FLASH_TIME);
    const broken = hp <= 0;
    if (this.shatter >= 0 && this.shatter < CFG.SHATTER_TIME) {
      if (this.shatter === 0) {
        const vfx = this.vfx;
        vfx.shards(x, 1.6 * scale, z, PALETTE.glimmer, 26, 10, 0.55, 0.5);
        vfx.shards(x, 1.0 * scale, z, PALETTE.white, 10, 7, 0.35, 0.3);
        vfx.flash(x, 1.6 * scale, z, PALETTE.white, 9 * scale, 0.3, 2);
        vfx.ring(x, z, 1, 14, 0.7, PALETTE.glimmer, 0.3, 1.7);
        vfx.smoke(x, 1, z, 0x2a3a34, 6, 1, 0.35, 1.4, 1.5);
        this.shake += 0.5;
      }
      this.shatter += dt;
    }
    // heroes close by mend it: light flows into the crystal
    this.near = 0;
    if (!broken && !this.done) this.heroes.forEach(this.nearAnchor);
    const mend = this.near > 0 && hp < 0.999 ? 1 : 0;
    this.mending += (mend - this.mending) * Math.min(1, dt * 4);

    const low = hp < CFG.LOW_HP && !broken;
    const flicker = low ? 0.55 + 0.45 * hash1(Math.floor(time * 13)) : 1;
    const glow = broken ? 0.12 : (0.55 + 0.6 * hp) * flicker + this.flash * 0.4 + this.mending * 0.25 * (0.6 + 0.4 * Math.sin(time * 5));
    const white = this.flash * 0.7;
    const cr = GLIMMER[0] + (1 - GLIMMER[0]) * white;
    const cg = GLIMMER[1] + (1 - GLIMMER[1]) * white;
    const cb = GLIMMER[2] + (1 - GLIMMER[2]) * white;
    // main crystal: whole while the shard stands, a dark stump once it is shattered
    const top = 0.62 * scale;
    const mainH = (broken ? 0.55 : CFG.MAIN_H) * scale;
    _m.compose(_p.set(x, top, z), _q.setFromAxisAngle(Z_AXIS, broken ? 0.3 : 0.06), _s.set(scale * 1.45, mainH, scale * 1.45));
    this.crystals.setMatrixAt(0, _m);
    this.crystals.setColorAt(0, _c.setRGB(cr * glow * CFG.CRYSTAL_GLOW, cg * glow * CFG.CRYSTAL_GLOW, cb * glow * CFG.CRYSTAL_GLOW));
    for (let i = 0; i < CFG.SIDE_SHARDS; i++) {
      const a = (i / CFG.SIDE_SHARDS) * Math.PI * 2 + 0.6;
      const there = hp > CFG.SHARD_AT[i];
      if (there) {
        // leaning out of the bell fragment around the main crystal
        const h = (1.4 + 0.3 * ((i * 7) % 3) * 0.5) * scale;
        _q.setFromAxisAngle(_p.set(Math.cos(a), 0, -Math.sin(a)), 0.5);
        _m.compose(_p.set(x + Math.sin(a) * 0.36 * scale, top, z + Math.cos(a) * 0.36 * scale), _q, _s.set(scale * 1.1, h, scale * 1.1));
        this.crystals.setColorAt(i + 1, _c.setRGB(cr * glow * 1.25, cg * glow * 1.25, cb * glow * 1.25));
      } else {
        // broken off: lying dull on the floor around the plinth
        const d = (1.5 + 0.35 * (i % 2)) * scale;
        _q.setFromAxisAngle(X_AXIS, Math.PI / 2 - 0.08).premultiply(_q2.setFromAxisAngle(Y_AXIS, a + 1.1 + i));
        _m.compose(_p.set(x + Math.sin(a + 0.5) * d, 0.1, z + Math.cos(a + 0.5) * d), _q, _s.set(scale * 0.95, scale * 0.85, scale * 0.95));
        this.crystals.setColorAt(i + 1, _c.setRGB(GLIMMER[0] * 0.2, GLIMMER[1] * 0.2, GLIMMER[2] * 0.2));
      }
      this.crystals.setMatrixAt(i + 1, _m);
    }
    this.crystals.instanceMatrix.needsUpdate = true;
    if (this.crystals.instanceColor) this.crystals.instanceColor.needsUpdate = true;

    // light: the crystal's own glow, its health as a ring around the plinth, and the mending reach
    const g = GLIMMER;
    if (!broken) {
      const pulse = 0.8 + 0.2 * Math.sin(time * 1.9);
      fx.push(SPRITE.GLOW, x, top + mainH * 0.55, z, 3.4 * scale, 4.4 * scale, cr, cg, cb, (0.16 + 0.2 * hp) * pulse * flicker + this.flash * 0.2, 1, 0.3);
      decals.push(DECAL.DISC, x, 0.03, z, 0, 7.5 * scale, 7.5 * scale, g[0], g[1], g[2], (0.06 + 0.1 * hp) * pulse * flicker, 1, 0);
      const d = this.ar * 2 + 1.5;
      // the ring turns from Glimmer to pale amber as the shard weakens (never red: that colour belongs to the enemy)
      const wr = low ? GOLD[0] : g[0];
      const wg = low ? GOLD[1] : g[1];
      const wb = low ? GOLD[2] : g[2];
      decals.push(DECAL.PROGRESS, x, 0.05, z, 0, d, d, wr * 1.6, wg * 1.6, wb * 1.6, low ? 0.7 + 0.3 * Math.sin(time * 9) : 0.95, 0.4, hp);
      const reach = (this.ar + OBJECTIVE_TUNING.DEFEND.REPAIR_RADIUS) * 2;
      decals.push(DECAL.ZONE, x, 0.042, z, 0, reach, reach, g[0] * 1.2, g[1] * 1.2, g[2] * 1.2, 0.2 + 0.2 * this.mending, 0.4, 0);
      if (this.mending > 0.05) {
        for (let i = 0; i < 4; i++) {
          const ph = (time * 0.7 + i * 0.25) % 1;
          const a = i * 1.571 + time * 0.6;
          const r = (reach * 0.5) * (1 - ph);
          fx.push(SPRITE.GLOW, x + Math.sin(a) * r, 0.3 + ph * 1.6 * scale, z + Math.cos(a) * r, 0.42, 0.42, g[0] * 1.8, g[1] * 1.8, g[2] * 1.8, 0.85 * Math.sin(ph * Math.PI) * this.mending, 1, 1.2);
        }
      }
    } else {
      decals.push(DECAL.SMOKE, x, 0.034, z, 0.7, 5.5 * scale, 5.5 * scale, 0.03, 0.05, 0.045, 0.6, 0, 0.8);
      fx.push(SPRITE.GLOW, x, top + 0.3, z, 1.4, 1.4, g[0], g[1], g[2], 0.08 + 0.05 * Math.sin(time * 2.3), 1, 0);
    }
  }

  private drawRitual(dt: number, time: number, decals: DecalBatch, fx: BillboardBatch): void {
    const n = this.siteCount;
    this.braziers.visible = n > 0;
    this.braziers.count = n;
    if (n === 0) return;
    _q.identity();
    for (let i = 0; i < n; i++) {
      const site = this.sites[i];
      _m.compose(_p.set(site.x, 0, site.z), _q, _s.set(1, 1, 1));
      this.braziers.setMatrixAt(i, _m);
      if (site.lit && site.shown < 0) site.shown = 1;
      if (site.lit) site.shown = Math.min(1, Math.max(0, site.shown) + dt * 2.5);
      site.flare = Math.max(0, site.flare - dt * 1.4);
      const k = site.lit ? 1 : Math.max(0, Math.min(1, site.progress));
      const d = site.r * 2;
      const c = site.lit ? RITUAL : GOLD;
      const seed = i * 1.7;
      if (site.lit) {
        // burning: a steady ring, a pool of firelight and a tall flame
        const flick = 0.85 + 0.15 * Math.sin(time * 11 + seed) + site.flare * 0.6;
        decals.push(DECAL.PROGRESS, site.x, 0.047, site.z, 0, d, d, c[0] * 1.5, c[1] * 1.5, c[2] * 1.5, 0.75, 0.5, 1);
        decals.push(DECAL.DISC, site.x, 0.03, site.z, 0, d * 1.5, d * 1.5, c[0], c[1], c[2], 0.2 * flick * site.shown, 1, 0);
        for (let f = 0; f < CFG.FLAMES; f++) {
          const a = time * 1.3 + f * 2.094 + seed;
          const h = (1.25 + 0.3 * f) * site.shown * (0.85 + 0.3 * hash1(Math.floor(time * 9 + f * 3) + i * 7));
          fx.push(SPRITE.FLAME, site.x + Math.sin(a) * 0.2, CFG.BRAZIER_H + h * 0.42, site.z + Math.cos(a) * 0.2, h * 0.62, h, c[0] * 2, c[1] * 1.8, c[2] * 1.5, 0.95, 0.8, seed + f * 0.37);
        }
        fx.push(SPRITE.GLOW, site.x, CFG.BRAZIER_H + 0.6, site.z, 4.2, 4.2, c[0], c[1], c[2], 0.3 * flick * site.shown, 1, 0.2);
      } else {
        // unlit: the circle to stand in. It fills from the centre and its rim closes as the brazier catches
        const pulse = 0.75 + 0.25 * Math.sin(time * 2.4 + seed);
        decals.push(DECAL.ZONE, site.x, 0.045, site.z, 0, d, d, c[0] * 1.5, c[1] * 1.5, c[2] * 1.5, 0.7, 0.3, k);
        decals.push(DECAL.PROGRESS, site.x, 0.05, site.z, 0, d + 0.45, d + 0.45, c[0] * 1.9, c[1] * 1.9, c[2] * 1.9, k > 0.001 ? 1 : 0.5 * pulse, 0.5, k);
        // embers in the bowl that grow into a small flame
        fx.push(SPRITE.GLOW, site.x, CFG.BRAZIER_H + 0.15, site.z, 0.9 + 1.6 * k, 0.9 + 1.6 * k, RITUAL[0] * 1.4, RITUAL[1] * 1.2, RITUAL[2], 0.25 * pulse + 0.5 * k, 1, 0.8);
        if (k > 0.05) {
          const h = 0.25 + 0.75 * k;
          fx.push(SPRITE.FLAME, site.x, CFG.BRAZIER_H + h * 0.4, site.z, h * 0.6, h, RITUAL[0] * 2, RITUAL[1] * 1.8, RITUAL[2] * 1.5, 0.9, 0.8, seed);
        }
        // a beacon over the brazier so the circle is found from across the room
        const uv = this.atlas.icons.ritual;
        const bob = Math.sin(time * 2.4 + seed) * 0.1;
        fx.push(SPRITE.ATLAS, site.x, CFG.BRAZIER_H + 2.1 + bob, site.z, 0.8, 0.8, c[0] * 1.3, c[1] * 1.3, c[2] * 1.3, 0.85 * pulse, 0, 0, 0, 0, 0, uv[0], uv[1], uv[2], uv[3]);
      }
    }
    this.braziers.instanceMatrix.needsUpdate = true;
  }

  private drawBell(dt: number, time: number, decals: DecalBatch, fx: BillboardBatch): void {
    // the great bell above the chamber: it swings slowly and tolls faster and faster as the hour comes
    const k = Math.max(0, Math.min(1, this.progress));
    const interval = CFG.TOLL_SLOW + (CFG.TOLL_FAST - CFG.TOLL_SLOW) * k * Math.sqrt(k);
    const span = Math.max(this.level.width, this.level.depth, 20);
    if (!this.done) {
      this.toll -= dt;
      if (this.toll <= 0) {
        this.toll += interval;
        if (this.toll < 0) this.toll = interval;
        this.tollPulse = 1;
        // a thin wave of bell light crosses the floor from under the bell (drawn below every telegraph)
        this.vfx.ring(0, -this.level.depth / 2 + 1, 2, span * 1.5, 1.5, PALETTE.bell, 0.12, 0.7 + 0.5 * k);
      }
    }
    this.tollPulse = Math.max(0, this.tollPulse - dt * 1.6);
    const p = this.tollPulse;
    const c = BELL;
    const y = CFG.BELL_Y;
    const z = -this.level.depth / 2 + 0.25;
    const swing = Math.sin(time * (Math.PI / interval)) * (0.08 + 0.1 * k);
    const uv = this.atlas.icons.bell;
    const size = CFG.BELL_SIZE * (1 + 0.05 * p);
    fx.push(SPRITE.GLOW, 0, y, z, size * 2, size * 1.6, c[0], c[1], c[2], 0.06 + 0.2 * p, 1, 0);
    fx.push(SPRITE.ATLAS, 0, y, z, size, size, c[0] * 1.2, c[1] * 1.2, c[2] * 1.2, 0.3 + 0.12 * k + 0.5 * p, 0.6, 0, swing, 0, 0, uv[0], uv[1], uv[2], uv[3]);
    // a shaft of bell light down the middle of the room and a pool where it lands
    fx.push(SPRITE.GLOW, 0, 4, -this.level.depth * 0.15, 5 + 2 * p, 13, c[0], c[1], c[2], 0.025 + 0.05 * p + 0.02 * k, 1, 0);
    decals.push(DECAL.DISC, 0, 0.028, -this.level.depth * 0.1, 0, span * 0.8, span * 0.6, c[0], c[1], c[2], 0.03 + 0.07 * p + 0.03 * k, 1, 0);
  }

  private drawVault(dt: number, time: number, decals: DecalBatch, fx: BillboardBatch, ui: BillboardBatch): void {
    const v = this.vault;
    if (!v || !this.anchorOn) return;
    const x = this.ax;
    const z = this.az;
    if (this.opened) this.lid = Math.min(1, this.lid + dt / CFG.LID_TIME);
    const e = 1 - (1 - this.lid) * (1 - this.lid);
    // a little overshoot as the lid falls open
    v.lid.rotation.x = -CFG.LID_OPEN * (e + Math.sin(this.lid * Math.PI) * 0.08);
    const c = VAULT;
    const breathe = 0.8 + 0.2 * Math.sin(time * 1.6);
    // warm light: the hoard glows on its own, far more once the reliquary is open
    decals.push(DECAL.DISC, x, 0.03, z, 0, 22, 17, c[0], c[1] * 0.85, c[2] * 0.6, (0.3 + 0.16 * e) * breathe, 1, 0);
    decals.push(DECAL.HALLOW, x, 0.045, z, time * 0.1, CFG.DAIS_R * 2 + 1.6, CFG.DAIS_R * 2 + 1.6, c[0] * 1.3, c[1] * 1.3, c[2] * 1.3, 0.5, 1, 0.05, (time * 0.3) % 1, 0.6);
    fx.push(SPRITE.GLOW, x, 1.3, z, 7 + 3 * e, 6 + 3 * e, c[0], c[1] * 0.9, c[2] * 0.7, (0.2 + 0.25 * e) * breathe, 1, 0.1);
    for (let i = 0; i + 2 < v.flames.length; i += 3) {
      const fxp = x + v.flames[i];
      const fy = v.flames[i + 1];
      const fz = z + v.flames[i + 2];
      const flick = 0.85 + 0.15 * Math.sin(time * 12 + i);
      fx.push(SPRITE.FLAME, fxp, fy + 0.13, fz, 0.2 * flick, 0.34 * flick, 2, 1.5, 0.8, 1, 0.8, i * 0.37);
      fx.push(SPRITE.GLOW, fxp, fy + 0.1, fz, 1.5, 1.5, 1, 0.7, 0.35, 0.3 * flick, 1, 0);
    }
    // coins catching the light
    this.sparkle += dt * 9 * this.vfx.density;
    while (this.sparkle >= 1) {
      this.sparkle -= 1;
      const a = Math.random() * Math.PI * 2;
      const r = 0.6 + Math.random() * 2;
      this.vfx.particle(x + Math.sin(a) * r, 0.3 + Math.random() * 0.9, z + Math.cos(a) * r, 0, 0.25, 0, 0.5 + Math.random() * 0.4, 0.2, 0.02, c[0] * 2.4, c[1] * 2.2, c[2] * 1.6, 1, SPRITE.SPARK, 1, 0, 0, 3);
    }
    const top = CFG.DAIS_H + 0.16 + 1.0 * CFG.CHEST_SCALE;
    if (this.opened) {
      // light pours out of the open reliquary
      fx.push(SPRITE.GLOW, x, top + 1.6, z + 0.2, 2.2 * e, 5.5 * e, c[0] * 1.3, c[1] * 1.3, c[2], 0.5 * e * breathe, 1, 0.5);
      fx.push(SPRITE.GLOW, x, top + 0.1, z + 0.2, 2.6 * e, 1.6 * e, 1.4, 1.3, 0.9, 0.7 * e, 1, 1.2);
    } else {
      // closed: where to stand, and a beacon over the lid
      const reach = (this.ar + CFG.REACH) * 2;
      decals.push(DECAL.MARKER, x, 0.05, z, 0, reach, reach, c[0] * 1.5, c[1] * 1.5, c[2] * 1.5, 0.9, 0.35, 0, GLIMMER[0] * 1.5, GLIMMER[1] * 1.5, GLIMMER[2] * 1.5);
      const uv = this.atlas.icons.vault;
      const bob = Math.sin(time * 2.4) * 0.12;
      ui.push(SPRITE.GLOW, x, top + 1.5 + bob, z, 1.7, 1.7, 0.05, 0.03, 0.01, 0.6);
      ui.push(SPRITE.ATLAS, x, top + 1.5 + bob, z, 0.95, 0.95, c[0] * 1.2, c[1] * 1.2, c[2] * 1.2, 1, 0, 0, 0, 0, 0, uv[0], uv[1], uv[2], uv[3]);
    }
  }

  // ------------------------------------------------------------------ lifecycle

  /** Back to "no objective" (new chamber, session end). The vault dressing is kept for the next vault. */
  clear(): void {
    this.begin(null);
    this.huntIds.length = 0;
    this.shake = 0;
  }

  /** Session end: frees what was built for this session. */
  reset(): void {
    this.clear();
    if (this.vault) {
      this.vault.root.removeFromParent();
      this.vault = null;
    }
    for (const geo of this.vaultOwned) geo.dispose();
    this.vaultOwned.length = 0;
  }

  dispose(): void {
    this.reset();
    this.group.removeFromParent();
    this.crystals.dispose();
    this.braziers.dispose();
    for (const geo of this.owned) geo.dispose();
    this.owned.length = 0;
    this.stone.dispose();
    this.kit.dispose();
    this.crystalMaterial.dispose();
  }
}

