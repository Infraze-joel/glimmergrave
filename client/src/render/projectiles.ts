/** Projectile views: instanced bolt / knife / arrow meshes plus glow, ground light and trail per ProjectileKind. */
import { DynamicDrawUsage, Euler, InstancedMesh, Matrix4, MeshLambertMaterial, Quaternion, Vector3 } from 'three';
import type { Object3D } from 'three';
import { ELEMENT_IDS } from '@shared/types.ts';
import type { ProjectileKind, ProjectileSnap } from '@shared/types.ts';
import type { Assets } from './assets.ts';
import { DECAL, SPRITE } from './batches.ts';
import type { BillboardBatch, DecalBatch } from './batches.ts';
import { CAMERA, ELEMENT_COLOR, LIMITS, PALETTE } from './config.ts';
import { rgb } from './vfx.ts';
import type { Vfx } from './vfx.ts';

interface Style {
  mesh: 'arrow' | 'dagger' | 'skel_arrow' | null;
  color: number;
  y: number;
  glow: number;
  trail: number;
  trailWidth: number;
  scale: number;
  spin: number;
  /** Trail particles per second (0 = none). */
  motes: number;
}

const STYLE: Record<ProjectileKind, Style> = {
  arcBolt: { mesh: null, color: PALETTE.arcane, y: 1.15, glow: 1.25, trail: 2.4, trailWidth: 0.5, scale: 1, spin: 0, motes: 14 },
  crossbowBolt: { mesh: 'arrow', color: 0xffe2a8, y: 1.1, glow: 0.5, trail: 2.6, trailWidth: 0.2, scale: 1.7, spin: 0, motes: 0 },
  knife: { mesh: 'dagger', color: 0xe6f0ff, y: 1.05, glow: 0.45, trail: 1.5, trailWidth: 0.22, scale: 0.85, spin: 22, motes: 0 },
  boneArrow: { mesh: 'skel_arrow', color: PALETTE.hostile, y: 1.1, glow: 0.85, trail: 2.2, trailWidth: 0.3, scale: 1.9, spin: 0, motes: 0 },
  hexOrb: { mesh: null, color: PALETTE.hostileMagic, y: 1.0, glow: 1.45, trail: 1.5, trailWidth: 0.6, scale: 1, spin: 0, motes: 10 },
};

interface Proj {
  id: number;
  kind: ProjectileKind;
  x: number; z: number; rot: number;
  color: number;
  hostile: boolean;
  age: number;
  gen: number;
  moteAcc: number;
}

const _m = new Matrix4();
const _q = new Quaternion();
const _q2 = new Quaternion();
const _e = new Euler();
const _p = new Vector3();
const _s = new Vector3();
const X_AXIS = new Vector3(1, 0, 0);
const MESH_KEYS = ['arrow', 'dagger', 'skel_arrow'] as const;

export class Projectiles {
  private readonly meshes: Record<'arrow' | 'dagger' | 'skel_arrow', InstancedMesh>;
  private readonly counts = { arrow: 0, dagger: 0, skel_arrow: 0 };
  private readonly materials: MeshLambertMaterial[];
  private readonly byId = new Map<number, Proj>();
  private readonly active: Proj[] = [];
  private readonly free: Proj[] = [];
  private gen = 0;

  constructor(parent: Object3D, assets: Assets) {
    const rogue = new MeshLambertMaterial({ map: assets.rogueMap, emissive: 0x2a2a2a });
    const bone = new MeshLambertMaterial({ map: assets.skeletonMap, emissive: 0x3a1210 });
    this.materials = [rogue, bone];
    const make = (name: 'arrow' | 'dagger' | 'skel_arrow', material: MeshLambertMaterial): InstancedMesh => {
      const mesh = new InstancedMesh(assets.props[name], material, LIMITS.PROJECTILES);
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      mesh.count = 0;
      mesh.visible = false;
      mesh.frustumCulled = false;
      parent.add(mesh);
      return mesh;
    };
    this.meshes = { arrow: make('arrow', rogue), dagger: make('dagger', rogue), skel_arrow: make('skel_arrow', bone) };
    for (let i = 0; i < LIMITS.PROJECTILES; i++) {
      this.free.push({ id: -1, kind: 'arcBolt', x: 0, z: 0, rot: 0, color: 0, hostile: false, age: 0, gen: 0, moteAcc: 0 });
    }
  }

  sync(list: readonly ProjectileSnap[], vfx: Vfx): void {
    this.gen++;
    for (const s of list) {
      let p = this.byId.get(s.id);
      if (!p) {
        const fresh = this.free.pop();
        if (!fresh) continue;
        p = fresh;
        p.id = s.id; p.age = 0; p.moteAcc = 0;
        p.x = s.x; p.z = s.z;
        this.byId.set(s.id, p);
        this.active.push(p);
      }
      p.kind = s.kind;
      p.hostile = s.hostile;
      const style = STYLE[s.kind];
      p.color = s.hostile ? (s.kind === 'hexOrb' ? PALETTE.hostileMagic : PALETTE.hostile)
        : s.element > 0 && s.element <= ELEMENT_IDS.length ? ELEMENT_COLOR[ELEMENT_IDS[s.element - 1]] : style.color;
      if (Math.hypot(s.x - p.x, s.z - p.z) > CAMERA.SNAP_DISTANCE) p.age = 0;
      p.x = s.x; p.z = s.z; p.rot = s.rot;
      p.gen = this.gen;
    }
    for (let i = this.active.length - 1; i >= 0; i--) {
      const p = this.active[i];
      if (p.gen === this.gen) continue;
      // gone: small fizzle where it was last seen (real impacts add their own hit sparks)
      vfx.sparks(p.x, STYLE[p.kind].y, p.z, p.color, 4, 3.5);
      vfx.flash(p.x, STYLE[p.kind].y, p.z, p.color, 1.2, 0.14, 1.2);
      this.byId.delete(p.id);
      this.active[i] = this.active[this.active.length - 1];
      this.active.pop();
      this.free.push(p);
    }
  }

  update(dt: number, time: number, decals: DecalBatch, fx: BillboardBatch, vfx: Vfx): void {
    this.counts.arrow = 0; this.counts.dagger = 0; this.counts.skel_arrow = 0;
    for (const p of this.active) {
      p.age += dt;
      const style = STYLE[p.kind];
      const c = rgb(p.color);
      const fade = Math.min(1, p.age * 12);
      const sin = Math.sin(p.rot);
      const cos = Math.cos(p.rot);
      if (style.mesh) {
        const i = this.counts[style.mesh]++;
        // the kit arrows have their tip at -Y: lay them flat with the tip along +Z, then yaw (knives also spin)
        _q.setFromAxisAngle(X_AXIS, -Math.PI / 2);
        _q2.setFromEuler(_e.set(0, p.rot + (style.spin !== 0 ? p.age * style.spin : 0), 0));
        _q.premultiply(_q2);
        _m.compose(_p.set(p.x, style.y, p.z), _q, _s.setScalar(style.scale));
        this.meshes[style.mesh].setMatrixAt(i, _m);
      }
      // trail (flat streak behind the projectile), glow and a light pool on the floor
      const len = style.trail * fade;
      decals.push(DECAL.STREAK, p.x - sin * len * 0.5, style.y - 0.05, p.z - cos * len * 0.5, p.rot, style.trailWidth, len,
        c[0] * 1.6, c[1] * 1.6, c[2] * 1.6, 0.85, 1);
      decals.push(DECAL.DISC, p.x, 0.04, p.z, 0, style.glow * 2.2, style.glow * 2.2, c[0], c[1], c[2], 0.3, 1, 0);
      const pulse = 1 + 0.12 * Math.sin(time * 24 + p.id);
      fx.push(SPRITE.GLOW, p.x, style.y, p.z, style.glow * pulse, style.glow * pulse, c[0] * 1.8, c[1] * 1.8, c[2] * 1.8, 1, 1, style.mesh ? 0.4 : 1.6);
      if (p.kind === 'hexOrb') {
        // dark core with a spinning shard so hostile orbs read differently from the mage's bolts
        fx.push(SPRITE.GLOW, p.x, style.y, p.z, 0.5, 0.5, 0.08, 0, 0.05, 0.9, 0, 0);
        fx.push(SPRITE.SPARK, p.x, style.y, p.z, 0.62, 0.62, c[0] * 2.2, c[1] * 2.2, c[2] * 2.2, 0.9, 1, 0, time * 7 + p.id);
      } else if (p.kind === 'arcBolt') {
        fx.push(SPRITE.SPARK, p.x, style.y, p.z, 0.42, 0.42, 2.2, 2.2, 2.2, 1, 1, 0, time * 9 + p.id);
      }
      if (style.motes > 0) {
        p.moteAcc += style.motes * vfx.density * dt;
        while (p.moteAcc >= 1) {
          p.moteAcc -= 1;
          vfx.particle(p.x + (Math.random() - 0.5) * 0.3, style.y + (Math.random() - 0.5) * 0.3, p.z + (Math.random() - 0.5) * 0.3,
            -sin * 1.5, 0.3, -cos * 1.5, 0.3, 0.2, 0.02, c[0] * 2, c[1] * 2, c[2] * 2, 1, SPRITE.SPARK, 1, 0, 1, 6);
        }
      }
    }
    for (const key of MESH_KEYS) {
      const mesh = this.meshes[key];
      const n = this.counts[key];
      mesh.count = n;
      mesh.visible = n > 0;
      if (n > 0) {
        mesh.instanceMatrix.clearUpdateRanges();
        mesh.instanceMatrix.addUpdateRange(0, n * 16);
        mesh.instanceMatrix.needsUpdate = true;
      }
    }
  }

  get count(): number {
    return this.active.length;
  }

  clear(): void {
    for (const p of this.active) this.free.push(p);
    this.active.length = 0;
    this.byId.clear();
    for (const mesh of Object.values(this.meshes)) { mesh.count = 0; mesh.visible = false; }
  }

  dispose(): void {
    this.clear();
    for (const mesh of Object.values(this.meshes)) { mesh.removeFromParent(); mesh.dispose(); }
    for (const m of this.materials) m.dispose();
  }
}
