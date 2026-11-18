/**
 * Effects of the update 4 horde that are not tied to one enemy view:
 *   ward domes   – a translucent panelled shell per raised aegis dome (one InstancedMesh, drawn before every decal,
 *                  so hostile telegraphs inside a dome are never tinted or hidden by it)
 *   mend beams   – the shaman's heal reaching each enemy it mended
 *   powder kegs  – the charge a slain bomber leaves behind until it bursts, and the burst itself
 *   deflects     – the spark when a hit of the warded element lands on a warded enemy
 * Per-enemy dressing (ward shell, fuse, tethers, hunt markers) lives in characters.ts.
 */
import { DoubleSide, DynamicDrawUsage, InstancedBufferAttribute, InstancedMesh, Matrix4, NormalBlending, Quaternion, ShaderMaterial, SphereGeometry, Vector3 } from 'three';
import type { Object3D } from 'three';
import type { ElementId } from '@shared/types.ts';
import { ENEMY_TUNING } from '@shared/data/enemies.ts';
import type { Atlas } from './atlas.ts';
import { DECAL, SPRITE } from './batches.ts';
import type { BillboardBatch, DecalBatch } from './batches.ts';
import type { Enemies } from './characters.ts';
import { ELEMENT_COLOR, LIMITS, PALETTE } from './config.ts';
import { rgb } from './vfx.ts';
import type { Vfx } from './vfx.ts';

const CFG = {
  DOME_SEGMENTS: 28,
  DOME_RINGS: 9,
  /** Height of the shell relative to its radius: flatter than a hemisphere, so it never towers into the camera. */
  DOME_HEIGHT: 0.62,
  BEAM_TIME: 0.7,
  BEAM_WIDTH: 0.62,
  BEAM_MOTES: 3,
  BEAM_FROM_Y: 2.3,
  KEGS: 8,
  KEG_Y: 0.42,
  DUST: 0x4f4a44,
  SMOKE: 0x2a2622,
} as const;

const DOME_VERT = /* glsl */ `
attribute vec2 iDome;
varying vec3 vLocal;
varying vec3 vNormalW;
varying vec3 vView;
varying vec2 vDome;
void main() {
  vLocal = position;
  vDome = iDome;
  vec4 world = modelMatrix * instanceMatrix * vec4( position, 1.0 );
  // the shell is only ever scaled and moved, so the unit normal needs no matrix
  vNormalW = normalize( vec3( position.x, position.y / ${CFG.DOME_HEIGHT.toFixed(2)}, position.z ) );
  vView = cameraPosition - world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const DOME_FRAG = /* glsl */ `
uniform float uTime;
uniform vec3 uColor;
varying vec3 vLocal;
varying vec3 vNormalW;
varying vec3 vView;
varying vec2 vDome;
#define PI 3.14159265
void main() {
  float k = vDome.x;
  float h = clamp( vLocal.y, 0.0, 1.0 );
  float fres = 1.0 - abs( dot( normalize( vNormalW ), normalize( vView ) ) );
  fres = fres * fres;
  // panels: meridians and two rings, like a leaded glass bell
  float ang = atan( vLocal.x, vLocal.z ) / ( 2.0 * PI ) + vDome.y;
  float mer = 1.0 - smoothstep( 0.0, 0.035, abs( fract( ang * 10.0 ) - 0.5 ) * 2.0 * ( 1.0 - h * 0.8 ) );
  float ringA = 1.0 - smoothstep( 0.0, 0.02, abs( h - 0.42 ) );
  float ringB = 1.0 - smoothstep( 0.0, 0.02, abs( h - 0.78 ) );
  float lattice = max( mer * step( h, 0.8 ), max( ringA, ringB ) );
  // a slow pulse climbing the shell, and a bright foot where it meets the floor
  float sweep = pow( 0.5 + 0.5 * sin( h * 7.0 - uTime * 1.7 + vDome.y * 20.0 ), 6.0 );
  float foot = 1.0 - smoothstep( 0.0, 0.09, h );
  float a = ( 0.035 + fres * 0.34 + lattice * 0.17 + sweep * 0.06 + foot * 0.4 ) * k;
  // it rises from the floor when raised and sinks back when it drops
  a *= 1.0 - smoothstep( k * 1.15 - 0.15, k * 1.15, h );
  if ( a < 0.004 ) discard;
  vec3 col = uColor * ( 1.0 + lattice * 0.5 + foot * 0.6 ) + vec3( 1.0 ) * fres * 0.18;
  gl_FragColor = vec4( col * a, a * 0.3 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

interface Beam { active: boolean; from: number; to: number; x0: number; z0: number; x1: number; z1: number; age: number }
interface Keg { active: boolean; x: number; z: number; age: number; dur: number; r: number }

const _m = new Matrix4();
const _q = new Quaternion();
const _p = new Vector3();
const _s = new Vector3();
const MEND = rgb(PALETTE.mend);
const FUSE = rgb(PALETTE.fuse);

export class HordeFx {
  private readonly vfx: Vfx;
  private readonly atlas: Atlas;
  private readonly enemies: Enemies;
  private readonly domes: InstancedMesh;
  private readonly domeMaterial: ShaderMaterial;
  private readonly domeData: InstancedBufferAttribute;
  private readonly beams: Beam[] = [];
  private readonly kegs: Keg[] = [];
  private domeCount = 0;
  private shake = 0;

  private readonly pushDome = (x: number, z: number, r: number, k: number, seed: number): void => {
    if (this.domeCount >= LIMITS.DOMES) return;
    _m.compose(_p.set(x, 0, z), _q, _s.set(r, r, r));
    this.domes.setMatrixAt(this.domeCount, _m);
    this.domeData.setXY(this.domeCount, k, seed);
    this.domeCount++;
  };

  constructor(parent: Object3D, vfx: Vfx, atlas: Atlas, enemies: Enemies) {
    this.vfx = vfx;
    this.atlas = atlas;
    this.enemies = enemies;
    const geo = new SphereGeometry(1, CFG.DOME_SEGMENTS, CFG.DOME_RINGS, 0, Math.PI * 2, 0, Math.PI / 2);
    geo.scale(1, CFG.DOME_HEIGHT, 1);
    this.domeData = new InstancedBufferAttribute(new Float32Array(LIMITS.DOMES * 2), 2);
    this.domeData.setUsage(DynamicDrawUsage);
    geo.setAttribute('iDome', this.domeData);
    const c = rgb(PALETTE.aegis);
    this.domeMaterial = new ShaderMaterial({
      vertexShader: DOME_VERT, fragmentShader: DOME_FRAG,
      uniforms: { uTime: { value: 0 }, uColor: { value: new Vector3(c[0] * 1.25, c[1] * 1.25, c[2] * 1.25) } },
      transparent: true, premultipliedAlpha: true, blending: NormalBlending, depthWrite: false, side: DoubleSide,
    });
    this.domes = new InstancedMesh(geo, this.domeMaterial, LIMITS.DOMES);
    this.domes.instanceMatrix.setUsage(DynamicDrawUsage);
    this.domes.count = 0;
    this.domes.visible = false;
    this.domes.frustumCulled = false;
    // before the decal batch (2): every ground effect, telegraphs above all, is drawn over the shell
    this.domes.renderOrder = 1;
    parent.add(this.domes);
    for (let i = 0; i < LIMITS.MEND_BEAMS; i++) this.beams.push({ active: false, from: -1, to: -1, x0: 0, z0: 0, x1: 0, z1: 0, age: 0 });
    for (let i = 0; i < CFG.KEGS; i++) this.kegs.push({ active: false, x: 0, z: 0, age: 0, dur: 1, r: 1 });
  }

  /** Camera shake asked for since the last call. */
  takeShake(): number {
    const s = this.shake;
    this.shake = 0;
    return s;
  }

  get activeDomes(): number {
    return this.domeCount;
  }

  /** `mend` event: the shaman `from` healed `targets`. */
  mend(from: number, targets: readonly number[]): void {
    const src = this.enemies.get(from);
    if (!src) return;
    const vfx = this.vfx;
    vfx.ring(src.x, src.z, 0.6, ENEMY_TUNING.SHAMAN.MEND_RADIUS * 2, 0.5, PALETTE.mend, 0.2, 1.3);
    vfx.flash(src.x, src.lift + src.height * 1.1, src.z, PALETTE.mend, 2.6, 0.3, 1.5);
    for (const id of targets) {
      const v = this.enemies.get(id);
      if (!v) continue;
      let beam = this.beams[0];
      for (const b of this.beams) { if (!b.active) { beam = b; break; } if (b.age > beam.age) beam = b; }
      beam.active = true; beam.from = from; beam.to = id; beam.age = 0;
      beam.x0 = src.x; beam.z0 = src.z; beam.x1 = v.x; beam.z1 = v.z;
      this.enemies.hit(id, 0.5, 1, 0.45);
      vfx.motes(v.x, 0.2, v.z, PALETTE.mend, 9, v.radius * 1.2, 2.8, 0.9);
      vfx.ring(v.x, v.z, v.radius * 5, v.radius * 1.5, 0.4, PALETTE.mend, 0.3, 1.5);
      vfx.iconPop(v.x, v.lift + v.height + 0.9, v.z, this.atlas.icons.blessing, PALETTE.mend, 0.8);
    }
  }

  /** A hit of the warded element landed: the ward turns the element aside (status and bursts do nothing). */
  deflect(x: number, y: number, z: number, el: ElementId, radius: number): void {
    const hex = ELEMENT_COLOR[el];
    const vfx = this.vfx;
    vfx.shards(x, y, z, hex, 5, 6, 0.32, 0.5);
    vfx.sparks(x, y, z, PALETTE.white, 6, 8);
    vfx.ring(x, z, radius * 2, radius * 5.5, 0.28, hex, 0.22, 1.8);
    vfx.iconPop(x, y + 1.2, z, this.atlas.icons.ward, hex, 0.9);
  }

  /** A bomber was slain before its fuse ran out: the keg lies there for `delay` seconds, then bursts. */
  kegDrop(x: number, z: number, delay: number, radius: number): void {
    let keg = this.kegs[0];
    for (const k of this.kegs) { if (!k.active) { keg = k; break; } if (k.age > keg.age) keg = k; }
    keg.active = true; keg.x = x; keg.z = z; keg.age = 0; keg.dur = Math.max(0.05, delay); keg.r = radius;
    this.vfx.sparks(x, 0.8, z, PALETTE.fuse, 8, 6);
  }

  /** The burst of a powder keg (the damage ring itself comes with the simulation's `aoe` event). */
  kegBurst(x: number, z: number, radius: number): void {
    const vfx = this.vfx;
    vfx.flash(x, 1, z, PALETTE.fuse, radius * 2.6, 0.22, 2);
    vfx.flames(x, 0.3, z, PALETTE.ember, 9, radius * 0.7, 1.5);
    vfx.sparks(x, 0.7, z, PALETTE.fuse, 22, 12);
    vfx.smoke(x, 0.9, z, CFG.SMOKE, 6, radius * 0.6, 0.4, 1.3, 1.6);
    vfx.puff(x, 0.3, z, CFG.DUST, 6, radius * 0.7, 0.35);
    vfx.stamp(DECAL.CRACKLE, x, z, radius * 0.6, radius * 2.1, 0.45, PALETTE.fuse, 1.8, 1, 0.5, 1);
    this.shake += 0.25;
  }

  update(dt: number, time: number, decals: DecalBatch, fx: BillboardBatch): void {
    // domes
    this.domeCount = 0;
    this.enemies.forEachDome(this.pushDome);
    this.domes.count = this.domeCount;
    this.domes.visible = this.domeCount > 0;
    if (this.domeCount > 0) {
      this.domeMaterial.uniforms.uTime.value = time;
      this.domes.instanceMatrix.needsUpdate = true;
      this.domeData.needsUpdate = true;
    }
    // mend beams: a ribbon on the floor from the shaman to the mended, light running along it
    for (const b of this.beams) {
      if (!b.active) continue;
      b.age += dt;
      const k = b.age / CFG.BEAM_TIME;
      if (k >= 1) { b.active = false; continue; }
      const src = this.enemies.get(b.from);
      const dst = this.enemies.get(b.to);
      if (src) { b.x0 = src.x; b.z0 = src.z; }
      if (dst) { b.x1 = dst.x; b.z1 = dst.z; }
      const dx = b.x1 - b.x0;
      const dz = b.z1 - b.z0;
      const len = Math.hypot(dx, dz);
      if (len < 0.2) continue;
      const fade = (1 - k) * Math.min(1, k * 8);
      decals.push(DECAL.BEAM, (b.x0 + b.x1) * 0.5, 0.043, (b.z0 + b.z1) * 0.5, Math.atan2(dx, dz), CFG.BEAM_WIDTH, len, MEND[0] * 1.5, MEND[1] * 1.5, MEND[2] * 1.5, 0.85 * fade, 0.8, 0.5);
      for (let i = 0; i < CFG.BEAM_MOTES; i++) {
        const ph = Math.min(1, k * 1.7 + i * 0.16);
        if (ph >= 1) continue;
        const y = CFG.BEAM_FROM_Y + (1.0 - CFG.BEAM_FROM_Y) * ph + Math.sin(ph * Math.PI) * 0.6;
        fx.push(SPRITE.GLOW, b.x0 + dx * ph, y, b.z0 + dz * ph, 0.6, 0.6, MEND[0] * 1.8, MEND[1] * 1.8, MEND[2] * 1.8, 0.9, 1, 1.4);
      }
    }
    // kegs left by slain bombers
    for (const keg of this.kegs) {
      if (!keg.active) continue;
      keg.age += dt;
      const k = keg.age / keg.dur;
      if (k >= 1) {
        keg.active = false;
        this.kegBurst(keg.x, keg.z, keg.r);
        continue;
      }
      const blink = Math.sin(keg.age * (14 + 40 * k)) > 0 ? 1 : 0.3;
      fx.push(SPRITE.GLOW, keg.x, CFG.KEG_Y, keg.z, 1.2 + 1.6 * k, 1.2 + 1.6 * k, FUSE[0] * 1.8, FUSE[1] * 1.5, FUSE[2], (0.45 + 0.5 * k) * blink, 1, 1.2);
      fx.push(SPRITE.SPARK, keg.x, CFG.KEG_Y + 0.35, keg.z, 0.34, 0.34, 2.4, 2, 1, blink, 1, 0, time * 9);
      decals.push(DECAL.CRACKLE, keg.x, 0.046, keg.z, time * 2, 1.6 + 2 * k, 1.6 + 2 * k, FUSE[0] * 1.6, FUSE[1] * 1.3, FUSE[2], 0.6 + 0.4 * k, 1, 0.35, 1);
    }
  }

  clear(): void {
    for (const b of this.beams) b.active = false;
    for (const k of this.kegs) k.active = false;
    this.domeCount = 0;
    this.domes.count = 0;
    this.domes.visible = false;
    this.shake = 0;
  }

  dispose(): void {
    this.clear();
    this.domes.removeFromParent();
    this.domes.geometry.dispose();
    this.domes.dispose();
    this.domeMaterial.dispose();
  }
}
