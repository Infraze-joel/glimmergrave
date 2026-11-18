/** Projectile views: instanced bolt / knife / arrow meshes plus glow, ground light and trail per ProjectileKind. */
import { DoubleSide, DynamicDrawUsage, Euler, InstancedMesh, Matrix4, MeshLambertMaterial, Quaternion, Vector3 } from 'three';
import type { Object3D } from 'three';
import { ELEMENT_IDS } from '@shared/types.ts';
import type { ProjectileKind, ProjectileSnap } from '@shared/types.ts';
import type { Assets } from './assets.ts';
import { DECAL, SPRITE } from './batches.ts';
import type { BillboardBatch, DecalBatch } from './batches.ts';
import { CAMERA, ELEMENT_COLOR, LIMITS, PALETTE } from './config.ts';
import { rgb } from './vfx.ts';
import type { Vfx } from './vfx.ts';

type MeshKey = 'arrow' | 'dagger' | 'skel_arrow' | 'shield_round';

interface Style {
  mesh: MeshKey | null;
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
  // Stalker: a long heavy bolt with a blinding trail. Matron: a slow homing ghost-light with a wavering tail.
  boneSpear: { mesh: 'skel_arrow', color: PALETTE.sickly, y: 1.15, glow: 1.3, trail: 6.5, trailWidth: 0.55, scale: 4.2, spin: 0, motes: 26 },
  soulWisp: { mesh: null, color: PALETTE.hexGreen, y: 1.25, glow: 1.9, trail: 0, trailWidth: 0, scale: 1, spin: 0, motes: 9 },
  // update 3: the knight's thrown shield (a big flat spinning disc), the spellblade's travelling crescent,
  // the shade's daggers (dark blades with a pale edge)
  shieldDisc: { mesh: 'shield_round', color: PALETTE.shield, y: 1.05, glow: 1.5, trail: 3.2, trailWidth: 1.3, scale: 1.25, spin: 26, motes: 10 },
  bladeWave: { mesh: null, color: 0xa8ecff, y: 0.95, glow: 1.4, trail: 2.6, trailWidth: 1.9, scale: 1, spin: 0, motes: 16 },
  shadowDagger: { mesh: 'dagger', color: PALETTE.mark, y: 1.1, glow: 0.8, trail: 3.0, trailWidth: 0.3, scale: 1.25, spin: 0, motes: 12 },
};

const WAVE = { REACH: 1.5, ARC: 1.25 } as const;
const UMBRA_CODE = ELEMENT_IDS.indexOf('umbra') + 1;

const WISP = { TAIL: 7, SPACING: 0.34, WAVE: 0.34, DANGER_RADIUS: 1.5 } as const;

interface Proj {
  id: number;
  kind: ProjectileKind;
  x: number; z: number; rot: number;
  color: number;
  hostile: boolean;
  /** Tinted with umbra: drawn with a dark heart inside the pale glow. */
  dark: boolean;
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
const MESH_KEYS = ['arrow', 'dagger', 'skel_arrow', 'shield_round'] as const;
const CORE = rgb(PALETTE.umbraCore);
/** Diameter of the bright rim around an umbra projectile, in glow sizes. */
const UMBRA_RIM = 0.95;

export class Projectiles {
  private readonly meshes: Record<MeshKey, InstancedMesh>;
  private readonly counts = { arrow: 0, dagger: 0, skel_arrow: 0, shield_round: 0 };
  private readonly materials: MeshLambertMaterial[];
  private readonly byId = new Map<number, Proj>();
  private readonly active: Proj[] = [];
  private readonly free: Proj[] = [];
  private gen = 0;

  constructor(parent: Object3D, assets: Assets) {
    const rogue = new MeshLambertMaterial({ map: assets.rogueMap, emissive: 0x2a2a2a });
    const bone = new MeshLambertMaterial({ map: assets.skeletonMap, emissive: 0x3a1210 });
    const knight = new MeshLambertMaterial({ map: assets.knightMap, emissive: 0x30363f, side: DoubleSide });
    this.materials = [rogue, bone, knight];
    const make = (name: MeshKey, material: MeshLambertMaterial): InstancedMesh => {
      const mesh = new InstancedMesh(assets.props[name], material, LIMITS.PROJECTILES);
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      mesh.count = 0;
      mesh.visible = false;
      mesh.frustumCulled = false;
      parent.add(mesh);
      return mesh;
    };
    this.meshes = {
      arrow: make('arrow', rogue), dagger: make('dagger', rogue), skel_arrow: make('skel_arrow', bone), shield_round: make('shield_round', knight),
    };
    for (let i = 0; i < LIMITS.PROJECTILES; i++) {
      this.free.push({ id: -1, kind: 'arcBolt', x: 0, z: 0, rot: 0, color: 0, hostile: false, dark: false, age: 0, gen: 0, moteAcc: 0 });
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
      p.color = s.kind === 'boneSpear' || s.kind === 'soulWisp' ? style.color
        : s.hostile ? (s.kind === 'hexOrb' ? PALETTE.hostileMagic : PALETTE.hostile)
        : s.element > 0 && s.element <= ELEMENT_IDS.length ? ELEMENT_COLOR[ELEMENT_IDS[s.element - 1]] : style.color;
      p.dark = !s.hostile && (s.element === UMBRA_CODE || s.kind === 'shadowDagger');
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
    this.counts.arrow = 0; this.counts.dagger = 0; this.counts.skel_arrow = 0; this.counts.shield_round = 0;
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
        if (style.mesh === 'shield_round') {
          // the shield lies flat like a discus, tilted into its flight, and spins about its own axis
          _q.setFromEuler(_e.set(Math.PI / 2, 0, p.age * style.spin));
          _q2.setFromEuler(_e.set(0.28, p.rot, 0, 'YXZ'));
        } else {
          _q.setFromAxisAngle(X_AXIS, -Math.PI / 2);
          _q2.setFromEuler(_e.set(0, p.rot + (style.spin !== 0 ? p.age * style.spin : 0), 0));
        }
        _q.premultiply(_q2);
        _m.compose(_p.set(p.x, style.y, p.z), _q, _s.setScalar(style.scale));
        this.meshes[style.mesh].setMatrixAt(i, _m);
      }
      // trail (flat streak behind the projectile), glow and a light pool on the floor
      const len = style.trail * fade;
      if (len > 0) {
        decals.push(DECAL.STREAK, p.x - sin * len * 0.5, style.y - 0.05, p.z - cos * len * 0.5, p.rot, style.trailWidth, len,
          c[0] * 1.6, c[1] * 1.6, c[2] * 1.6, 0.85, 1);
      }
      decals.push(DECAL.DISC, p.x, 0.04, p.z, 0, style.glow * 2.2, style.glow * 2.2, c[0], c[1], c[2], 0.3, 1, 0);
      const pulse = 1 + 0.12 * Math.sin(time * 24 + p.id);
      if (p.dark) {
        // umbra: a dark heart inside a bright rim (a flat ring at flight height and a wider pool of light below it),
        // so it stands out on the dark floors where the pale glow alone was lost
        fx.push(SPRITE.GLOW, p.x, style.y, p.z, style.glow * 0.56, style.glow * 0.56, CORE[0], CORE[1], CORE[2], 0.9, 0, 0);
        decals.push(DECAL.SHOCK, p.x, style.y, p.z, 0, style.glow * UMBRA_RIM, style.glow * UMBRA_RIM, c[0] * 1.5, c[1] * 1.5, c[2] * 1.5, 0.8, 1, 0.22);
        decals.push(DECAL.DISC, p.x, 0.041, p.z, 0, style.glow * 2.6, style.glow * 2.6, c[0], c[1], c[2], 0.18, 1, 0.2);
      }
      fx.push(SPRITE.GLOW, p.x, style.y, p.z, style.glow * pulse, style.glow * pulse, c[0] * 1.8, c[1] * 1.8, c[2] * 1.8, 1, 1, style.mesh ? 0.4 : 1.6);
      if (p.kind === 'hexOrb') {
        // dark core with a spinning shard so hostile orbs read differently from the mage's bolts
        fx.push(SPRITE.GLOW, p.x, style.y, p.z, 0.5, 0.5, 0.08, 0, 0.05, 0.9, 0, 0);
        fx.push(SPRITE.SPARK, p.x, style.y, p.z, 0.62, 0.62, c[0] * 2.2, c[1] * 2.2, c[2] * 2.2, 0.9, 1, 0, time * 7 + p.id);
      } else if (p.kind === 'shieldDisc') {
        // a ring of light around the rim, so the disc reads as wide as it hits
        decals.push(DECAL.PROGRESS, p.x, style.y - 0.1, p.z, p.age * 19, 2.3, 2.3, c[0] * 1.7, c[1] * 1.7, c[2] * 1.7, 0.9 * fade, 0.9, 0.34);
        decals.push(DECAL.PROGRESS, p.x, style.y - 0.1, p.z, p.age * 19 + Math.PI, 2.3, 2.3, c[0] * 1.7, c[1] * 1.7, c[2] * 1.7, 0.9 * fade, 0.9, 0.34);
        decals.push(DECAL.RING, p.x, 0.045, p.z, 0, 1.9, 1.9, c[0], c[1], c[2], 0.5 * fade, 0.6, 0);
      } else if (p.kind === 'bladeWave') {
        // a crescent of force: the leading edge is a slash arc held fully swept, with a second, softer one behind
        const d = WAVE.REACH * 2;
        decals.push(DECAL.SLASH, p.x - sin * WAVE.REACH * 0.8, style.y, p.z - cos * WAVE.REACH * 0.8, p.rot, d, d, c[0] * 2.1, c[1] * 2.1, c[2] * 2.1, fade, 0.9, 0.72, 1, WAVE.ARC);
        decals.push(DECAL.SLASH, p.x - sin * WAVE.REACH * 0.8, style.y, p.z - cos * WAVE.REACH * 0.8, p.rot, d, d, c[0] * 2.1, c[1] * 2.1, c[2] * 2.1, fade, 0.9, 0.72, -1, WAVE.ARC);
        decals.push(DECAL.SLASH, p.x - sin * WAVE.REACH * 1.15, style.y - 0.2, p.z - cos * WAVE.REACH * 1.15, p.rot, d * 0.95, d * 0.95, c[0], c[1], c[2], 0.5 * fade, 1, 0.72, 1, WAVE.ARC * 0.9);
        fx.push(SPRITE.SPARK, p.x + sin * 0.35, style.y, p.z + cos * 0.35, 0.5, 0.5, 2.3, 2.3, 2.3, fade, 1, 0, time * 11 + p.id);
      } else if (p.kind === 'shadowDagger') {
        // a smear of shadow under a pale edge
        decals.push(DECAL.STREAK, p.x - sin * len * 0.45, style.y - 0.12, p.z - cos * len * 0.45, p.rot, 0.75, len * 0.9, CORE[0] * 2, CORE[1] * 2, CORE[2] * 2, 0.75, 0);
        fx.push(SPRITE.SPARK, p.x + sin * 0.55, style.y, p.z + cos * 0.55, 0.3, 0.3, c[0] * 2.2, c[1] * 2.2, c[2] * 2.2, 1, 1, 0, Math.PI / 4);
      } else if (p.kind === 'arcBolt') {
        fx.push(SPRITE.SPARK, p.x, style.y, p.z, 0.42, 0.42, 2.2, 2.2, 2.2, 1, 1, 0, time * 9 + p.id);
      } else if (p.kind === 'boneSpear') {
        // white-hot core streak inside the wide trail, a hostile ground lane and a hard head flare
        const h = rgb(PALETTE.hostile);
        decals.push(DECAL.STREAK, p.x - sin * len * 0.3, style.y, p.z - cos * len * 0.3, p.rot, 0.2, len * 0.6, 2.6, 2.5, 2, 1, 1);
        decals.push(DECAL.STREAK, p.x - sin * len * 0.4, 0.05, p.z - cos * len * 0.4, p.rot, 1.1, len * 0.8, h[0], h[1], h[2], 0.5, 1);
        fx.push(SPRITE.SPARK, p.x + sin * 0.9, style.y, p.z + cos * 0.9, 0.7, 0.7, 2.6, 2.4, 1.6, 1, 1, 0, Math.PI / 4);
      } else if (p.kind === 'soulWisp') {
        // a ghost-light: bright head, hollow dark eye, and a tail of fading lights that wavers behind it
        const v = rgb(PALETTE.hexViolet);
        const h = rgb(PALETTE.hostile);
        const breathe = 1 + 0.18 * Math.sin(time * 6 + p.id * 1.7);
        fx.push(SPRITE.GLOW, p.x, style.y, p.z, 0.44, 0.44, 0.02, 0.05, 0.02, 0.85, 0, 0);
        fx.push(SPRITE.GLOW, p.x, style.y, p.z, 2.9 * breathe, 2.9 * breathe, v[0], v[1], v[2], 0.3, 1, 0);
        for (let k = 1; k <= WISP.TAIL; k++) {
          const f = 1 - k / (WISP.TAIL + 1);
          const wave = Math.sin(time * 7 - k * 0.9 + p.id) * WISP.WAVE * (k / WISP.TAIL);
          const tx = p.x - sin * k * WISP.SPACING * fade + cos * wave;
          const tz = p.z - cos * k * WISP.SPACING * fade - sin * wave;
          const ty = style.y + Math.sin(time * 5 - k * 0.7 + p.id) * 0.12 * (k / WISP.TAIL);
          const mix = k / WISP.TAIL;
          fx.push(SPRITE.GLOW, tx, ty, tz, (0.25 + 0.75 * f) * 0.95, (0.25 + 0.75 * f) * 0.95,
            (c[0] * (1 - mix) + v[0] * mix) * 1.7, (c[1] * (1 - mix) + v[1] * mix) * 1.7, (c[2] * (1 - mix) + v[2] * mix) * 1.7, 0.9 * f, 1, 1.2);
        }
        // the ring on the floor is its reach: step out of it or outrun it
        const d = WISP.DANGER_RADIUS * 2;
        decals.push(DECAL.ZONE, p.x, 0.05, p.z, 0, d, d, h[0] * 1.3, h[1] * 1.3, h[2] * 1.3, 0.55 * fade, 0.3, 0);
        decals.push(DECAL.DISC, p.x, 0.045, p.z, 0, d * 1.5, d * 1.5, c[0], c[1], c[2], 0.2, 1, 0);
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
