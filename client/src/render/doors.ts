/** Exit portals on the north wall: stone arch, animated portal surface, type icon and hold-progress zone. */
import {
  BoxGeometry, Color, DynamicDrawUsage, Euler, InstancedBufferAttribute, InstancedMesh, Matrix4, PlaneGeometry, Quaternion, ShaderMaterial, Vector3,
} from 'three';
import type { BufferGeometry, MeshLambertMaterial, Object3D } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { WORLD } from '@shared/constants.ts';
import type { Door, DoorType } from '@shared/types.ts';
import type { Assets } from './assets.ts';
import type { Atlas } from './atlas.ts';
import { DECAL, SPRITE } from './batches.ts';
import type { BillboardBatch, DecalBatch } from './batches.ts';
import { DOOR_COLOR, PALETTE } from './config.ts';
import { solidGeometry } from './level.ts';
import { createLevelMaterial } from './materials.ts';
import type { Vfx } from './vfx.ts';
import { rgb } from './vfx.ts';

const CFG = {
  MAX: 4,
  WIDTH: 3.3,
  HEIGHT: 3.9,
  DEPTH: 0.75,
  POST: 0.6,
  APPEAR_TIME: 0.55,
  ICON_Y: 5.0,
  FRAME_TINT: [0.5, 0.52, 0.66],
} as const;

/** Portal surface per door type: 0 = the swirling veil, 1 = a stair sinking into the abyss, 2 = the bell light. */
const STYLE: Record<DoorType, number> = { boon: 0, blessing: 0, cursed: 0, boss: 0, descend: 1, ascend: 2 };
const SPECIAL = { SHAFT_H: 9, SHAFT_W: 2.6, POOL: 7.5, MOTES: 3 } as const;

const PORTAL_VERT = /* glsl */ `
attribute float iStyle;
varying vec2 vUv;
varying vec3 vCol;
varying float vStyle;
void main() {
  vUv = uv;
  vCol = instanceColor;
  vStyle = iStyle;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4( position, 1.0 );
}
`;

const PORTAL_FRAG = /* glsl */ `
uniform float uTime;
varying vec2 vUv;
varying vec3 vCol;
varying float vStyle;
void main() {
  float x = ( vUv.x - 0.5 ) * 2.0;
  if ( vStyle > 1.5 ) {
    // ascend: daylight pouring down the shaft, brightest at the top, with slow rays and drifting dust
    float rays = 0.5 + 0.5 * sin( x * 9.0 + sin( uTime * 0.7 ) * 1.5 + vUv.y * 1.2 );
    float beam = pow( 1.0 - abs( x ), 0.7 );
    float lift = smoothstep( 0.0, 1.0, vUv.y );
    float dust = pow( 0.5 + 0.5 * sin( vUv.y * 40.0 - uTime * 2.2 + x * 17.0 ), 12.0 );
    vec3 c = vCol * ( 0.35 + beam * ( 0.5 + 0.45 * rays ) + lift * 0.5 ) + vec3( 1.0 ) * ( beam * lift * 0.5 + dust * 0.3 );
    gl_FragColor = vec4( c, 1.0 );
  } else if ( vStyle > 0.5 ) {
    // descend: steps receding downwards into black; only their edges catch the violet light from below
    float persp = 1.0 / ( 0.35 + vUv.y * 1.6 );
    float steps = fract( persp * 2.2 - uTime * 0.12 );
    float edge = smoothstep( 0.86, 0.97, steps );
    float depth = smoothstep( 0.0, 0.85, vUv.y );
    float narrow = step( abs( x ), 0.25 + ( 1.0 - vUv.y ) * 0.75 );
    float mist = 0.5 + 0.5 * sin( vUv.y * 9.0 + uTime * 1.3 + sin( x * 5.0 - uTime ) * 1.4 );
    float rim = pow( abs( x ), 3.0 ) * 0.5 + pow( vUv.y, 6.0 ) * 0.5;
    vec3 c = vCol * ( edge * narrow * ( 1.0 - depth ) * 0.85 + rim * 0.6 + depth * mist * 0.2 + 0.015 );
    gl_FragColor = vec4( c, 1.0 );
  } else {
  float wave = sin( vUv.y * 11.0 - uTime * 2.6 + sin( vUv.x * 7.0 + uTime * 1.3 ) * 1.6 ) * 0.5 + 0.5;
  float wisps = sin( vUv.x * 23.0 + sin( vUv.y * 6.0 - uTime * 1.9 ) * 2.5 ) * 0.5 + 0.5;
  float rim = pow( abs( x ), 2.2 ) + pow( vUv.y, 5.0 ) * 0.8;
  float ground = 1.0 - smoothstep( 0.0, 0.4, vUv.y );
  vec3 col = vCol * ( 0.07 + rim * 0.95 + wave * wisps * 0.55 + ground * 0.45 );
  col += vec3( 1.0 ) * pow( wave * wisps, 6.0 ) * 0.35;
  gl_FragColor = vec4( col, 1.0 );
  }
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const ICON: Record<DoorType, 'boon' | 'blessing' | 'cursed' | 'boss' | 'descend' | 'ascend'> = {
  boon: 'boon', blessing: 'blessing', cursed: 'cursed', boss: 'boss', descend: 'descend', ascend: 'ascend',
};
const ABYSS_CORE = rgb(PALETTE.umbraCore);

const _m = new Matrix4();
const _q = new Quaternion();
const _e = new Euler();
const _p = new Vector3();
const _s = new Vector3();
const _c = new Color();

export class Doors {
  private readonly frames: InstancedMesh;
  private readonly portals: InstancedMesh;
  private readonly frameGeometry: BufferGeometry;
  private readonly frameMaterial: MeshLambertMaterial;
  private readonly portalMaterial: ShaderMaterial;
  private readonly styles: InstancedBufferAttribute;
  private readonly atlas: Atlas;
  private readonly x: number[] = [];
  private readonly z: number[] = [];
  private readonly type: DoorType[] = [];
  private readonly progress: number[] = [];
  private readonly pulse: number[] = [];
  private count = 0;
  private appear = 0;
  private wallZ = 0;
  private moteAcc = 0;

  constructor(parent: Object3D, assets: Assets, atlas: Atlas, stoneUv: readonly [number, number]) {
    this.atlas = atlas;
    const [r, g, b] = CFG.FRAME_TINT;
    const parts: BufferGeometry[] = [];
    const box = (w: number, h: number, d: number, x: number, y: number, rotZ = 0): void => {
      const geo = new BoxGeometry(w, h, d);
      if (rotZ !== 0) geo.rotateZ(rotZ);
      geo.translate(x, y, CFG.DEPTH / 2);
      parts.push(solidGeometry(geo, stoneUv, r, g, b));
    };
    const half = CFG.WIDTH / 2;
    box(CFG.POST, CFG.HEIGHT, CFG.DEPTH, -half, CFG.HEIGHT / 2);
    box(CFG.POST, CFG.HEIGHT, CFG.DEPTH, half, CFG.HEIGHT / 2);
    box(CFG.WIDTH + CFG.POST * 1.6, 0.6, CFG.DEPTH + 0.15, 0, CFG.HEIGHT + 0.2);
    box(0.85, 0.85, CFG.DEPTH + 0.3, 0, CFG.HEIGHT + 0.35, Math.PI / 4);
    box(CFG.WIDTH + CFG.POST * 2, 0.16, CFG.DEPTH + 0.5, 0, 0.08);
    const merged = mergeGeometries(parts, false);
    for (const part of parts) part.dispose();
    if (!merged) throw new Error('door frame geometry failed');
    this.frameGeometry = merged;
    this.frameMaterial = createLevelMaterial(assets.dungeonMap);
    this.frameMaterial.vertexColors = true;
    this.frames = new InstancedMesh(merged, this.frameMaterial, CFG.MAX);

    const plane = new PlaneGeometry(CFG.WIDTH - CFG.POST * 0.6, CFG.HEIGHT);
    plane.translate(0, CFG.HEIGHT / 2, CFG.DEPTH * 0.45);
    this.styles = new InstancedBufferAttribute(new Float32Array(CFG.MAX), 1);
    this.styles.setUsage(DynamicDrawUsage);
    plane.setAttribute('iStyle', this.styles);
    this.portalMaterial = new ShaderMaterial({ vertexShader: PORTAL_VERT, fragmentShader: PORTAL_FRAG, uniforms: { uTime: { value: 0 } } });
    this.portals = new InstancedMesh(plane, this.portalMaterial, CFG.MAX);
    for (const mesh of [this.frames, this.portals]) {
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      mesh.count = 0;
      mesh.visible = false;
      mesh.frustumCulled = false;
      parent.add(mesh);
    }
    for (let i = 0; i < CFG.MAX; i++) {
      this.x.push(0); this.z.push(0); this.type.push('boon'); this.progress.push(0); this.pulse.push(0);
      this.portals.setColorAt(i, _c.setHex(0xffffff));
      this.frames.setColorAt(i, _c.setHex(0xffffff));
    }
  }

  set(doors: readonly Door[], progress: readonly number[], roomDepth: number): void {
    const n = Math.min(CFG.MAX, doors.length);
    let changed = n !== this.count;
    for (let i = 0; i < n; i++) {
      const d = doors[i];
      if (d.x !== this.x[i] || d.z !== this.z[i] || d.type !== this.type[i]) changed = true;
      this.x[i] = d.x; this.z[i] = d.z; this.type[i] = d.type;
      this.progress[i] = progress[i] ?? 0;
    }
    this.wallZ = -roomDepth / 2;
    if (!changed) return;
    this.count = n;
    this.appear = 0;
    for (let i = 0; i < n; i++) {
      this.pulse[i] = 0;
      const c = rgb(DOOR_COLOR[this.type[i]]);
      this.portals.setColorAt(i, _c.setRGB(c[0] * 1.5, c[1] * 1.5, c[2] * 1.5));
      this.frames.setColorAt(i, _c.setRGB(0.9 + c[0] * 0.25, 0.9 + c[1] * 0.25, 0.9 + c[2] * 0.25));
      this.styles.setX(i, STYLE[this.type[i]]);
    }
    this.styles.needsUpdate = true;
    if (this.portals.instanceColor) this.portals.instanceColor.needsUpdate = true;
    if (this.frames.instanceColor) this.frames.instanceColor.needsUpdate = true;
  }

  /** Flash every door of the chosen type. */
  chosen(type: DoorType, vfx: Vfx): void {
    for (let i = 0; i < this.count; i++) {
      if (this.type[i] !== type) continue;
      this.pulse[i] = 1;
      const hex = DOOR_COLOR[type];
      vfx.ring(this.x[i], this.z[i], 1, WORLD.DOOR_RADIUS * 3.2, 0.6, hex, 0.5, 2);
      vfx.flash(this.x[i], 2.2, this.wallZ + 0.6, hex, 9, 0.5, 2);
      vfx.motes(this.x[i], 0.2, this.z[i], hex, 26, WORLD.DOOR_RADIUS, 3.2, 1.1);
    }
  }

  update(dt: number, time: number, decals: DecalBatch, fx: BillboardBatch, ui: BillboardBatch, vfx: Vfx): void {
    const n = this.count;
    this.frames.count = n;
    this.portals.count = n;
    this.frames.visible = n > 0;
    this.portals.visible = n > 0;
    if (n === 0) return;
    this.portalMaterial.uniforms.uTime.value = time;
    this.appear = Math.min(1, this.appear + dt / CFG.APPEAR_TIME);
    const k = this.appear;
    const ease = 1 - (1 - k) * (1 - k) * (1 - k);
    _q.setFromEuler(_e.set(0, 0, 0));
    this.moteAcc += dt * 10 * vfx.density;
    for (let i = 0; i < n; i++) {
      const x = this.x[i];
      const c = rgb(DOOR_COLOR[this.type[i]]);
      this.pulse[i] = Math.max(0, this.pulse[i] - dt * 1.6);
      const boost = 1 + this.pulse[i] * 1.5;
      _m.compose(_p.set(x, 0, this.wallZ - 0.02), _q, _s.set(1, Math.max(0.001, ease), 1));
      this.frames.setMatrixAt(i, _m);
      _m.compose(_p.set(x, 0, this.wallZ), _q, _s.set(Math.max(0.001, ease), Math.max(0.001, ease), 1));
      this.portals.setMatrixAt(i, _m);

      const zoneD = WORLD.DOOR_RADIUS * 2;
      decals.push(DECAL.DISC, x, 0.03, this.wallZ + 1.6, 0, 6.5, 6.5, c[0], c[1], c[2], 0.3 * ease * boost, 1, 0);
      decals.push(DECAL.ZONE, x, 0.05, this.z[i], 0, zoneD, zoneD, c[0] * 1.5, c[1] * 1.5, c[2] * 1.5, 0.95 * ease, 0.2, this.progress[i]);
      if (this.progress[i] > 0.001) {
        decals.push(DECAL.PROGRESS, x, 0.055, this.z[i], 0, zoneD + 0.5, zoneD + 0.5, c[0] * 2, c[1] * 2, c[2] * 2, 1, 0.4, this.progress[i]);
      }
      fx.push(SPRITE.GLOW, x, CFG.HEIGHT * 0.5, this.wallZ + 0.7, 7 * ease, 7 * ease, c[0], c[1], c[2], 0.22 * boost, 1, 0);
      if (this.type[i] === 'descend') {
        // the abyss breathes out: a pool of shadow spilling over the threshold, light sinking into it
        decals.push(DECAL.SMOKE, x, 0.04, this.wallZ + 2.2, time * 0.25, SPECIAL.POOL * ease, SPECIAL.POOL * ease, ABYSS_CORE[0], ABYSS_CORE[1], ABYSS_CORE[2], 0.9 * ease, 0, 0.95,
          c[0] * 0.8, c[1] * 0.8, c[2] * 0.8);
        for (let k = 0; k < SPECIAL.MOTES; k++) {
          const ph = (time * 0.45 + k / SPECIAL.MOTES + i * 0.37) % 1;
          const a = k * 2.4 + i + ph * 2.0;
          const d = 2.6 * (1 - ph);
          fx.push(SPRITE.GLOW, x + Math.sin(a) * d, 0.2 + 1.6 * (1 - ph), this.wallZ + 1.4 + Math.cos(a) * d * 0.5, 0.5 * (1 - ph * 0.6), 0.5 * (1 - ph * 0.6),
            c[0] * 1.7, c[1] * 1.7, c[2] * 1.7, 0.85 * Math.sin(ph * Math.PI) * ease, 1, 1.2);
        }
      } else if (this.type[i] === 'ascend') {
        // a shaft of light standing over the arch and a bright landing in front of it
        const shimmer = 0.85 + 0.15 * Math.sin(time * 1.7 + i);
        fx.push(SPRITE.GLOW, x, SPECIAL.SHAFT_H * 0.5, this.wallZ + 0.9, SPECIAL.SHAFT_W * ease, SPECIAL.SHAFT_H * ease, c[0], c[1], c[2], 0.3 * shimmer * boost, 1, 0.3);
        fx.push(SPRITE.GLOW, x, CFG.HEIGHT + 0.6, this.wallZ + 0.6, 3.4 * ease, 3.4 * ease, c[0] * 1.5, c[1] * 1.5, c[2] * 1.5, 0.5 * shimmer, 1, 1.2);
        decals.push(DECAL.HALLOW, x, 0.045, this.wallZ + 2.2, 0, SPECIAL.POOL * 0.8 * ease, SPECIAL.POOL * 0.8 * ease, c[0] * 1.3, c[1] * 1.3, c[2] * 1.3, 0.6 * ease, 1, 0.12, (time * 0.4 + i * 0.3) % 1, 1);
      }
      const bob = Math.sin(time * 2.2 + i * 1.7) * 0.08;
      const uv = this.atlas.icons[ICON[this.type[i]]];
      const s = 1.05 * ease * (1 + this.pulse[i] * 0.3);
      ui.push(SPRITE.GLOW, x, CFG.ICON_Y + bob, this.wallZ + 0.4, s * 2.1, s * 2.1, 0.01, 0.01, 0.03, 0.85 * ease);
      ui.push(SPRITE.ATLAS, x, CFG.ICON_Y + bob, this.wallZ + 0.4, s, s, c[0] * 1.15, c[1] * 1.15, c[2] * 1.15, ease, 0, 0, 0, 0, 0, uv[0], uv[1], uv[2], uv[3]);
    }
    while (this.moteAcc >= 1) {
      this.moteAcc -= 1;
      const i = Math.floor(Math.random() * n);
      // motes sink into the abyss, rise in the bell light, drift up everywhere else
      const rise = this.type[i] === 'descend' ? -1.4 : this.type[i] === 'ascend' ? 2.6 : 1.2;
      vfx.motes(this.x[i] + (Math.random() - 0.5) * 2.2, (rise < 0 ? 1.8 : 0.2) + Math.random() * 2.5, this.wallZ + 0.7, DOOR_COLOR[this.type[i]], 1, 0.3, rise, 0.9);
    }
    this.frames.instanceMatrix.needsUpdate = true;
    this.portals.instanceMatrix.needsUpdate = true;
  }

  clear(): void {
    this.count = 0;
    this.frames.count = 0;
    this.portals.count = 0;
    this.frames.visible = false;
    this.portals.visible = false;
  }

  dispose(): void {
    this.frames.removeFromParent();
    this.portals.removeFromParent();
    this.frames.dispose();
    this.portals.dispose();
    this.frameGeometry.dispose();
    this.portals.geometry.dispose();
    this.frameMaterial.dispose();
    this.portalMaterial.dispose();
  }
}
