/**
 * Floor hazards of a chamber (RoomLayout.hazards). Their phase is a pure function of the server tick
 * (hazardState in @shared/sim/hazards.ts), so every client draws exactly what the server applies:
 *   idle   – a calm fixture so players learn where they are: spike plate / vent grate / frost sigil
 *   warn   – an iris closing over the fixture in the hazard's own colour (never the red of enemy telegraphs)
 *   active – spikes thrust up / a column of fire / freezing mist
 * Everything is drawn through the shared batches plus one InstancedMesh for all spikes of the room.
 */
import { ConeGeometry, DynamicDrawUsage, InstancedMesh, Matrix4, Quaternion, Vector3 } from 'three';
import type { BufferGeometry, MeshLambertMaterial, Object3D } from 'three';
import { HAZARD_TIMING, hazardState } from '@shared/sim/hazards.ts';
import type { HazardState } from '@shared/sim/hazards.ts';
import type { Hazard } from '@shared/types.ts';
import type { Assets } from './assets.ts';
import { DECAL, SPRITE } from './batches.ts';
import type { BillboardBatch, DecalBatch } from './batches.ts';
import { HAZARD_COLOR, LIMITS } from './config.ts';
import { solidGeometry } from './level.ts';
import { createLevelMaterial } from './materials.ts';
import { rgb } from './vfx.ts';
import type { Vfx } from './vfx.ts';

const CFG = {
  Y: 0.036,
  WARN_Y: 0.058,
  SPIKE_HEIGHT: 1.05,
  SPIKE_RADIUS: 0.13,
  SPIKE_IDLE: 0.07,
  SPIKE_RING: 0.58,
  /** Fractions of the active phase used to thrust out / pull back. */
  THRUST: 0.1,
  RETRACT: 0.22,
  STEEL: [0.78, 0.84, 0.95],
  FIRE_HEIGHT: 3.4,
  FLAMES: 5,
  MIST_PUFFS: 6,
  FADE_OUT: 0.14,
  EMBER_RATE: 26,
  FROST_RATE: 16,
  SMOULDER_RATE: 1.2,
} as const;

const PHASE = { idle: 0, warn: 1, active: 2 } as const;

const _m = new Matrix4();
const _q = new Quaternion();
const _p = new Vector3();
const _s = new Vector3();

/** Low-discrepancy value in [0, 1) per (hazard, k), stable across frames. */
function seeded(i: number, k: number): number {
  const s = Math.sin(i * 91.7 + k * 37.3) * 43758.5453;
  return s - Math.floor(s);
}

export class Hazards {
  private readonly spikes: InstancedMesh;
  private readonly spikeGeometry: BufferGeometry;
  private readonly material: MeshLambertMaterial;
  private readonly state: HazardState = { phase: 'idle', t: 0 };
  private list: readonly Hazard[] = [];
  private readonly last = new Int8Array(LIMITS.HAZARDS);
  private readonly acc = new Float32Array(LIMITS.HAZARDS);
  private count = 0;
  private hasSpikes = false;

  constructor(parent: Object3D, assets: Assets, stoneUv: readonly [number, number]) {
    const cone = new ConeGeometry(CFG.SPIKE_RADIUS, 1, 5);
    cone.translate(0, 0.5, 0);
    this.spikeGeometry = solidGeometry(cone, stoneUv, CFG.STEEL[0], CFG.STEEL[1], CFG.STEEL[2]);
    this.material = createLevelMaterial(assets.dungeonMap);
    this.material.vertexColors = true;
    this.material.emissive.setRGB(0.1, 0.11, 0.14);
    this.spikes = new InstancedMesh(this.spikeGeometry, this.material, LIMITS.HAZARDS * LIMITS.HAZARD_SPIKES);
    this.spikes.instanceMatrix.setUsage(DynamicDrawUsage);
    this.spikes.count = 0;
    this.spikes.visible = false;
    this.spikes.frustumCulled = false;
    this.spikes.castShadow = false;
    parent.add(this.spikes);
  }

  /** Call when the room changes. Rooms without hazards pass an empty list (or nothing). */
  set(hazards: readonly Hazard[] | undefined | null): void {
    this.list = hazards ?? [];
    this.count = Math.min(LIMITS.HAZARDS, this.list.length);
    this.hasSpikes = false;
    for (let i = 0; i < this.count; i++) {
      this.last[i] = -1;
      this.acc[i] = 0;
      if (this.list[i].kind === 'spikes') this.hasSpikes = true;
    }
    this.spikes.count = 0;
    this.spikes.visible = false;
  }

  get active(): number {
    return this.count;
  }

  update(dt: number, time: number, tick: number, decals: DecalBatch, fx: BillboardBatch, vfx: Vfx): void {
    if (this.count === 0) return;
    let spike = 0;
    for (let i = 0; i < this.count; i++) {
      const h = this.list[i];
      const st = hazardState(h, tick, this.state);
      const phase = PHASE[st.phase];
      const entered = this.last[i] !== phase && this.last[i] !== -1;
      this.last[i] = phase;
      const c = rgb(HAZARD_COLOR[h.kind]);
      const d = h.r * 2;
      const t = st.t;
      // how strongly the active effect shows: snaps in, eases out at the end
      const on = phase === PHASE.active ? Math.min(1, t / 0.06) * Math.min(1, (1 - t) / CFG.FADE_OUT) : 0;
      const warn = phase === PHASE.warn ? t : 0;

      if (phase === PHASE.warn) {
        decals.push(DECAL.WARN, h.x, CFG.WARN_Y, h.z, 0, d, d, c[0] * 1.5, c[1] * 1.5, c[2] * 1.5, Math.min(1, t * 8 + 0.35), 0.3, t);
        fx.push(SPRITE.GLOW, h.x, 0.3, h.z, d * 1.1, d * 0.7, c[0], c[1], c[2], 0.1 + 0.2 * t, 1, 0);
      }

      if (h.kind === 'spikes') {
        decals.push(DECAL.PLATE, h.x, CFG.Y, h.z, seeded(i, 0) * 0.6, d, d, c[0], c[1], c[2], 1, 0, 0.2 + 0.8 * Math.max(warn, on));
        // tips peek out of the plate, rattle while warning, then thrust and pull back
        let height: number = CFG.SPIKE_IDLE;
        if (phase === PHASE.warn) height = CFG.SPIKE_IDLE + 0.12 * t + 0.03 * Math.sin(time * 40 + i) * t;
        else if (phase === PHASE.active) {
          const up = Math.min(1, t / CFG.THRUST);
          const thrust = 1 + 0.18 * Math.sin(up * Math.PI) * (1 - up);
          const down = t > 1 - CFG.RETRACT ? (1 - t) / CFG.RETRACT : 1;
          height = CFG.SPIKE_IDLE + (1 - CFG.SPIKE_IDLE) * (1 - (1 - up) * (1 - up)) * thrust * down * down;
        }
        const n = LIMITS.HAZARD_SPIKES;
        const wide = Math.max(0.8, h.r * 0.75);
        for (let k = 0; k < n; k++) {
          const inner = k < 4;
          const a = seeded(i, 1) * 6.28 + (inner ? (k / 4) : ((k - 4) / (n - 4))) * Math.PI * 2 + (inner ? 0.4 : 0);
          const rr = k === 0 ? 0 : h.r * (inner ? CFG.SPIKE_RING * 0.5 : CFG.SPIKE_RING + 0.2 * seeded(i, k + 9));
          const tall = (k === 0 ? 1.15 : 0.75 + 0.4 * seeded(i, k + 3)) * CFG.SPIKE_HEIGHT * height;
          _m.compose(_p.set(h.x + Math.sin(a) * rr, 0, h.z + Math.cos(a) * rr), _q, _s.set(wide, tall, wide));
          this.spikes.setMatrixAt(spike++, _m);
        }
        if (on > 0) decals.push(DECAL.DISC, h.x, CFG.WARN_Y, h.z, 0, d * 1.3, d * 1.3, c[0], c[1], c[2], 0.3 * on, 1, 0.2);
        if (entered && phase === PHASE.active) {
          vfx.ring(h.x, h.z, d * 0.5, d * 1.5, 0.3, HAZARD_COLOR.spikes, 0.4, 1.8);
          vfx.sparks(h.x, 0.3, h.z, HAZARD_COLOR.spikes, 10, 6);
          vfx.flash(h.x, 0.6, h.z, HAZARD_COLOR.spikes, h.r * 2.4, 0.14, 1.2);
        }
      } else if (h.kind === 'vent') {
        const glow = phase === PHASE.idle ? 0.1 + 0.05 * Math.sin(time * 2.3 + i * 1.7) : phase === PHASE.warn ? 0.2 + 0.8 * t : 1;
        decals.push(DECAL.GRATE, h.x, CFG.Y, h.z, seeded(i, 0) * 3.14, d, d, c[0], c[1] * 0.75, c[2] * 0.6, 1, 0, glow);
        if (phase === PHASE.idle) {
          this.acc[i] += CFG.SMOULDER_RATE * vfx.density * dt;
          if (this.acc[i] >= 1) {
            this.acc[i] -= 1;
            vfx.particle(h.x + (Math.random() - 0.5) * h.r, 0.1, h.z + (Math.random() - 0.5) * h.r, 0, 0.9, 0, 0.9, 0.1, 0.02, c[0] * 2, c[1] * 2, c[2] * 2, 0.9, SPRITE.SPARK, 1, -0.3, 0.4, 4);
          }
        } else if (phase === PHASE.warn) {
          this.acc[i] += CFG.EMBER_RATE * 0.4 * t * vfx.density * dt;
        } else {
          this.acc[i] += CFG.EMBER_RATE * on * vfx.density * dt;
          // a roaring column: overlapping tongues that climb, a hot core and the light it throws on the floor
          for (let k = 0; k < CFG.FLAMES; k++) {
            const lift = (k / CFG.FLAMES) * CFG.FIRE_HEIGHT * 0.62;
            const a = seeded(i, k) * 6.28 + time * (1.4 + k * 0.3);
            const off = h.r * 0.34 * (1 - k / CFG.FLAMES);
            const flick = 0.85 + 0.3 * Math.sin(time * (13 + k * 3) + i + k);
            const w = h.r * (1.7 - k * 0.2) * flick * on;
            const hh = (CFG.FIRE_HEIGHT * 0.52 + k * 0.12) * flick * on;
            fx.push(SPRITE.FLAME, h.x + Math.sin(a) * off, lift + hh * 0.42, h.z + Math.cos(a) * off, w, hh, c[0] * 2, c[1] * 1.9, c[2] * 1.6, 0.95, 0.85, seeded(i, k + 5) + k * 0.31);
          }
          fx.push(SPRITE.GLOW, h.x, 1.2, h.z, h.r * 6.5, h.r * 6.5, c[0], c[1] * 0.9, c[2] * 0.7, 0.32 * on, 1, 0.3);
          fx.push(SPRITE.GLOW, h.x, 0.5, h.z, h.r * 2.2, h.r * 2.2, 1.9, 1.5, 0.8, 0.7 * on, 1, 1.2);
          decals.push(DECAL.DISC, h.x, CFG.WARN_Y, h.z, 0, d * 3.4, d * 3.4, c[0], c[1] * 0.85, c[2] * 0.6, 0.42 * on * (0.9 + 0.1 * Math.sin(time * 17 + i)), 1, 0);
          decals.push(DECAL.RING, h.x, CFG.WARN_Y, h.z, 0, d, d, c[0] * 2, c[1] * 2, c[2] * 2, 0.9 * on, 0.8, 1);
        }
        while (this.acc[i] >= 1 && phase !== PHASE.idle) {
          this.acc[i] -= 1;
          const a = Math.random() * Math.PI * 2;
          const rr = Math.sqrt(Math.random()) * h.r * 0.8;
          vfx.particle(h.x + Math.sin(a) * rr, 0.15, h.z + Math.cos(a) * rr, Math.sin(a) * 0.8, 3 + Math.random() * 4 * (phase === PHASE.active ? 1 : 0.3), Math.cos(a) * 0.8,
            0.5 + Math.random() * 0.6, 0.16, 0.02, c[0] * 2.4, c[1] * 2.2, c[2] * 2, 1, SPRITE.SPARK, 1, -1, 0.6, 6);
        }
        if (entered && phase === PHASE.active) {
          vfx.ring(h.x, h.z, d * 0.4, d * 2, 0.4, HAZARD_COLOR.vent, 0.45, 2);
          vfx.flash(h.x, 1, h.z, HAZARD_COLOR.vent, h.r * 5, 0.22, 1.8);
          vfx.flames(h.x, 0.2, h.z, HAZARD_COLOR.vent, 6, h.r * 0.8, 1.3);
        }
      } else {
        const lit = phase === PHASE.idle ? 0.03 + 0.03 * Math.sin(time * 1.3 + i) : phase === PHASE.warn ? 0.08 + 0.3 * t : 0.5 * on + 0.1;
        decals.push(DECAL.DISC, h.x, CFG.Y - 0.002, h.z, 0, d * 0.96, d * 0.96, 0.02, 0.06, 0.09, 0.55, 0, 0.9);
        decals.push(DECAL.FROST, h.x, CFG.Y, h.z, seeded(i, 0) * 1.05 + (phase === PHASE.active ? time * 0.5 : 0), d, d,
          c[0] * (1 + lit * 2), c[1] * (1 + lit * 2), c[2] * (1 + lit * 2), phase === PHASE.idle ? 0.75 : 1, 0.45, lit);
        if (phase === PHASE.warn) this.acc[i] += CFG.FROST_RATE * 0.35 * t * vfx.density * dt;
        if (phase === PHASE.active) {
          this.acc[i] += CFG.FROST_RATE * on * vfx.density * dt;
          // rolling ground mist: pale puffs circling inside the ring, a cold core and the light on the floor
          for (let k = 0; k < CFG.MIST_PUFFS; k++) {
            const a = (k / CFG.MIST_PUFFS) * Math.PI * 2 + time * (0.7 + 0.12 * (k % 3)) * (k % 2 === 0 ? 1 : -1);
            const rr = h.r * (0.25 + 0.45 * seeded(i, k));
            const size = h.r * (1.25 + 0.5 * Math.sin(time * 1.9 + k * 2.4));
            fx.push(SPRITE.GLOW, h.x + Math.sin(a) * rr, 0.45 + 0.35 * seeded(i, k + 7), h.z + Math.cos(a) * rr, size, size * 0.72, 0.72, 0.92, 1, 0.3 * on, 0.25, 0);
          }
          fx.push(SPRITE.GLOW, h.x, 0.7, h.z, h.r * 3.6, h.r * 2.6, c[0], c[1], c[2], 0.3 * on, 1, 0.2);
          decals.push(DECAL.DISC, h.x, CFG.WARN_Y, h.z, 0, d * 1.25, d * 1.25, c[0], c[1], c[2], 0.34 * on, 1, 0.3);
          decals.push(DECAL.RING, h.x, CFG.WARN_Y, h.z, 0, d, d, c[0] * 1.8, c[1] * 1.8, c[2] * 1.8, 0.85 * on, 0.8, 1);
        }
        while (this.acc[i] >= 1) {
          this.acc[i] -= 1;
          vfx.frost(h.x, 0.25, h.z, HAZARD_COLOR.frost, 1, h.r * 0.9);
        }
        if (entered && phase === PHASE.active) {
          vfx.ring(h.x, h.z, d * 0.3, d * 1.25, 0.5, HAZARD_COLOR.frost, 0.5, 1.8);
          vfx.flash(h.x, 0.6, h.z, HAZARD_COLOR.frost, h.r * 3.4, 0.25, 1.3);
          vfx.frost(h.x, 0.4, h.z, HAZARD_COLOR.frost, 10, h.r);
        }
      }
    }
    if (this.hasSpikes) {
      this.spikes.count = spike;
      this.spikes.visible = spike > 0;
      this.spikes.instanceMatrix.clearUpdateRanges();
      this.spikes.instanceMatrix.addUpdateRange(0, spike * 16);
      this.spikes.instanceMatrix.needsUpdate = true;
    }
  }

  /** `hazardHit` event: a small impact in the hazard's colour on whoever was caught. */
  impact(kind: Hazard['kind'], x: number, y: number, z: number, vfx: Vfx): void {
    const hex = HAZARD_COLOR[kind];
    vfx.flash(x, y, z, hex, 1.7, 0.14, 1.5);
    if (kind === 'spikes') {
      vfx.sparks(x, y * 0.6, z, hex, 9, 6.5);
      vfx.ring(x, z, 0.4, 2, 0.25, hex, 0.3, 1.4);
    } else if (kind === 'vent') {
      vfx.flames(x, y * 0.5, z, hex, 4, 0.4, 0.9);
      vfx.sparks(x, y, z, hex, 7, 5);
    } else {
      vfx.frost(x, y * 0.7, z, hex, 8, 0.6);
      vfx.ring(x, z, 0.4, 2.4, 0.35, hex, 0.35, 1.3);
    }
  }

  /** Seconds of ground warning before a hazard fires (for callers that want to line something up with it). */
  get warnSeconds(): number {
    return HAZARD_TIMING.WARN;
  }

  clear(): void {
    this.list = [];
    this.count = 0;
    this.hasSpikes = false;
    this.spikes.count = 0;
    this.spikes.visible = false;
  }

  dispose(): void {
    this.clear();
    this.spikes.removeFromParent();
    this.spikes.dispose();
    this.spikeGeometry.dispose();
    this.material.dispose();
  }
}
