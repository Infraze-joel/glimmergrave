/**
 * Two immediate-mode instanced quad batches. Everything that is not a lit mesh goes through them, so the whole
 * VFX / overlay layer costs three draw calls:
 *   DecalBatch      – quads lying in the XZ plane (telegraphs, rings, shadows, slashes, shockwaves, trails)
 *   BillboardBatch  – camera-facing quads (particles, glows, icons, labels, health bars, damage numbers)
 * Call begin() once per frame, push() any number of times, end() to upload. Colours are premultiplied in the
 * shader so alpha-blended and additive instances can share a batch (`additive` 0..1 per instance).
 */
import {
  BufferAttribute, DoubleSide, DynamicDrawUsage, InstancedBufferGeometry, InstancedInterleavedBuffer, InterleavedBufferAttribute,
  Mesh, NormalBlending, ShaderMaterial,
} from 'three';
import type { Texture } from 'three';

export const DECAL = {
  RING: 0,
  DISC: 1,
  TELE_CIRCLE: 2,
  TELE_ARC: 3,
  TELE_LINE: 4,
  PROGRESS: 5,
  SHOCK: 6,
  SLASH: 7,
  SHADOW: 8,
  ZONE: 9,
  STREAK: 10,
  RUNE: 11,
} as const;

export const SPRITE = {
  ATLAS: 0,
  GLOW: 1,
  SPARK: 2,
  BAR: 3,
  FLAME: 4,
  PLATE: 5,
} as const;

const DECAL_STRIDE = 16;
const SPRITE_STRIDE = 20;

const DECAL_VERT = /* glsl */ `
attribute vec4 iPosRot;
attribute vec4 iSize;
attribute vec4 iColor;
attribute vec4 iParam;
varying vec2 vUv;
varying vec2 vHalf;
varying vec4 vColor;
varying vec4 vParam;
varying vec2 vShape;
void main() {
  vUv = position.xz * 2.0;
  vHalf = iSize.xy * 0.5;
  vColor = iColor;
  vParam = iParam;
  vShape = iSize.zw;
  float s = sin( iPosRot.w );
  float c = cos( iPosRot.w );
  vec2 l = position.xz * iSize.xy;
  vec3 world = vec3( iPosRot.x + c * l.x + s * l.y, iPosRot.y, iPosRot.z - s * l.x + c * l.y );
  gl_Position = projectionMatrix * viewMatrix * vec4( world, 1.0 );
}
`;

const DECAL_FRAG = /* glsl */ `
uniform float uTime;
varying vec2 vUv;
varying vec2 vHalf;
varying vec4 vColor;
varying vec4 vParam;
varying vec2 vShape;
#define PI 3.14159265
float band( float d, float w, float aa ) { return 1.0 - smoothstep( w, w + aa, abs( d ) ); }
void main() {
  int shape = int( vShape.x + 0.5 );
  float r = length( vUv );
  float rm = r * vHalf.x;            // metres from the centre (round shapes use sx as diameter)
  float edge = vHalf.x - rm;         // metres inside the rim
  float ang = atan( vUv.x, vUv.y );  // 0 = forward (+z local), +-PI = back
  float aa = 0.05;
  vec3 col = vColor.rgb;
  float a = 0.0;
  if ( shape == 0 ) {               // RING: player ring, p0 = highlight
    float w = 0.05 + 0.03 * vParam.x;
    a = band( edge - 0.09, w, 0.03 );
    float notch = smoothstep( 0.55, 0.2, abs( ang ) ) * band( edge - 0.09, w + 0.07, 0.03 ) * vParam.x;
    a = max( a, notch );
    a += ( 1.0 - smoothstep( 0.0, vHalf.x, rm ) ) * 0.10 * ( 0.4 + vParam.x );
  } else if ( shape == 1 ) {        // DISC: soft glow, p0 = hardness
    float f = clamp( 1.0 - r, 0.0, 1.0 );
    a = mix( f * f, smoothstep( 0.0, 0.25, f ), vParam.x );
  } else if ( shape == 2 || shape == 3 ) {  // TELEGRAPH circle / arc: p0 progress, p1 flash, p2 half angle
    float inside = step( r, 1.0 );
    float mask = inside;
    float outline = band( edge - 0.05, 0.05, aa );
    if ( shape == 3 ) {
      float side = ( vParam.z - abs( ang ) ) * rm;   // metres inside the straight edges
      mask *= smoothstep( 0.0, aa, side );
      outline = max( outline * mask, band( side - 0.05, 0.05, aa ) * inside * step( 0.0, side ) );
    }
    float fillR = vParam.x * vHalf.x;
    float fill = 1.0 - smoothstep( fillR - 0.04, fillR, rm );
    float lead = band( rm - fillR + 0.06, 0.06, 0.08 ) * step( vParam.x, 0.999 );
    float stripes = 0.5 + 0.5 * sin( ( rm - uTime * 1.6 ) * 9.0 );
    a = mask * ( 0.16 + 0.07 * stripes + fill * 0.34 + lead * 0.5 ) + outline * 0.95;
    col = mix( col, vec3( 1.0, 0.86, 0.6 ), lead * 0.6 + outline * 0.25 );
    col = mix( col, vec3( 1.0, 0.95, 0.85 ), vParam.y );
    a = mix( a, mask * 0.9, vParam.y );
  } else if ( shape == 4 ) {        // TELEGRAPH line: quad covers the lane, p0 progress, p1 flash
    vec2 d = ( 1.0 - abs( vUv ) ) * vHalf;           // metres inside the border
    float m = min( d.x, d.y );
    float outline = band( m - 0.05, 0.05, aa );
    float along = ( vUv.y * 0.5 + 0.5 ) * vHalf.y * 2.0;
    float fillL = vParam.x * vHalf.y * 2.0;
    float fill = 1.0 - smoothstep( fillL - 0.04, fillL, along );
    float lead = band( along - fillL + 0.06, 0.06, 0.08 ) * step( vParam.x, 0.999 );
    float chev = 0.5 + 0.5 * sin( ( along - abs( vUv.x ) * vHalf.x * 0.8 - uTime * 3.0 ) * 5.0 );
    a = 0.16 + 0.09 * chev + fill * 0.34 + lead * 0.5 + outline * 0.8;
    col = mix( col, vec3( 1.0, 0.86, 0.6 ), lead * 0.6 + outline * 0.25 );
    col = mix( col, vec3( 1.0, 0.95, 0.85 ), vParam.y );
    a = mix( a, 0.9, vParam.y );
  } else if ( shape == 5 ) {        // PROGRESS ring: p0 fraction (clockwise from forward)
    float ringMask = band( edge - 0.11, 0.075, 0.03 );
    float frac = fract( ang / ( 2.0 * PI ) + 1.0 );
    float on = step( frac, vParam.x );
    a = ringMask * mix( 0.22, 1.0, on );
    col = mix( col * 0.35, col, on );
  } else if ( shape == 6 ) {        // SHOCK: expanding ring, p0 thickness 0..1
    float t = clamp( ( 1.0 - r ) / max( vParam.x, 0.02 ), 0.0, 1.0 );
    a = step( r, 1.0 ) * ( 1.0 - t ) * ( 1.0 - t ) + band( edge - 0.04, 0.04, 0.05 ) * 0.8;
  } else if ( shape == 7 ) {        // SLASH: crescent, p0 sweep 0..1, p1 direction (+1 / -1), p2 half angle
    float u = ( ang * vParam.y + vParam.z ) / ( 2.0 * vParam.z );   // 0..1 along the sweep
    float inArc = step( 0.0, u ) * step( u, 1.0 );
    float head = vParam.x * 1.4;
    float trail = smoothstep( head - 0.8, head, u ) * ( 1.0 - smoothstep( head, head + 0.03, u ) );
    float inner = 0.5 + 0.22 * u;
    float t = clamp( ( r - inner ) / ( 1.0 - inner ), 0.0, 1.0 );
    float radial = t * t * t * ( 1.0 - smoothstep( 0.95, 1.0, r ) );
    float tips = smoothstep( 0.0, 0.12, u ) * smoothstep( 1.0, 0.9, u );
    a = inArc * trail * trail * ( radial * 0.85 + band( r - 0.955, 0.02, 0.02 ) * 0.9 ) * mix( 0.6, 1.0, tips );
    col = mix( col, vec3( 1.0 ), t * t * 0.6 );
  } else if ( shape == 8 ) {        // SHADOW blob
    float f = clamp( 1.0 - r * r, 0.0, 1.0 );
    a = f * f;
  } else if ( shape == 9 ) {        // ZONE: door zone, p0 hold progress
    float dash = step( 0.5, fract( ( ang / ( 2.0 * PI ) ) * 18.0 + uTime * 0.25 ) );
    a = band( edge - 0.07, 0.05, 0.03 ) * mix( 0.35, 1.0, dash );
    float fillR = vParam.x * vHalf.x;
    a += step( r, 1.0 ) * ( 0.07 + 0.3 * ( 1.0 - smoothstep( fillR - 0.05, fillR, rm ) ) * step( 0.001, vParam.x ) );
  } else if ( shape == 10 ) {       // STREAK: fades towards -z (tail)
    float w = 1.0 - abs( vUv.x );
    float t = vUv.y * 0.5 + 0.5;
    a = w * w * t * t;
  } else {                          // RUNE: summoning circle, p0 progress
    float ring1 = band( edge - 0.06, 0.04, 0.03 );
    float ring2 = band( rm - vHalf.x * 0.62, 0.03, 0.03 );
    float ticks = step( 0.72, fract( ( ang / ( 2.0 * PI ) + uTime * 0.12 ) * 10.0 ) ) * step( 0.62, r ) * step( r, 0.93 );
    float core = ( 1.0 - smoothstep( 0.0, 0.62, r ) ) * 0.35 * vParam.x;
    a = ring1 + ring2 * 0.7 + ticks * 0.55 + core;
  }
  a = clamp( a, 0.0, 1.0 ) * vColor.a;
  if ( a < 0.004 ) discard;
  gl_FragColor = vec4( col * a, a * ( 1.0 - vShape.y ) );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const SPRITE_VERT = /* glsl */ `
attribute vec4 iPosRot;
attribute vec4 iSizeOff;
attribute vec4 iUv;
attribute vec4 iColor;
attribute vec4 iMisc;
varying vec2 vUv;
varying vec2 vQuad;
varying vec4 vColor;
varying vec4 vMisc;
void main() {
  vec3 right = vec3( viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0] );
  vec3 up = vec3( viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1] );
  vQuad = position.xy * 2.0;
  vUv = mix( iUv.xy, iUv.zw, position.xy + 0.5 );
  vColor = iColor;
  vMisc = iMisc;
  float s = sin( iPosRot.w );
  float c = cos( iPosRot.w );
  vec2 l = position.xy * iSizeOff.xy;
  vec2 p = vec2( c * l.x - s * l.y, s * l.x + c * l.y ) + iSizeOff.zw;
  vec3 world = iPosRot.xyz + right * p.x + up * p.y;
  gl_Position = projectionMatrix * viewMatrix * vec4( world, 1.0 );
}
`;

const SPRITE_FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform float uTime;
varying vec2 vUv;
varying vec2 vQuad;
varying vec4 vColor;
varying vec4 vMisc;
void main() {
  int mode = int( vMisc.x + 0.5 );
  vec3 col = vColor.rgb;
  float a = 1.0;
  float r = length( vQuad );
  if ( mode == 0 ) {                // ATLAS
    vec4 t = texture2D( uMap, vUv );
    col *= t.rgb;
    a = t.a;
  } else if ( mode == 1 ) {         // GLOW: soft disc, param = core sharpness
    float f = clamp( 1.0 - r, 0.0, 1.0 );
    a = f * f * ( 1.0 + vMisc.z * 2.0 * f );
    col = mix( col, vec3( 1.0 ), clamp( f * f * f * vMisc.z, 0.0, 1.0 ) );
  } else if ( mode == 2 ) {         // SPARK: hard diamond
    float d = abs( vQuad.x ) + abs( vQuad.y );
    a = 1.0 - smoothstep( 0.8, 1.0, d );
    col = mix( col, vec3( 1.0 ), ( 1.0 - smoothstep( 0.0, 0.6, d ) ) * 0.6 );
  } else if ( mode == 3 ) {         // BAR: param = fraction, uv.x = second colour blend
    vec2 q = abs( vQuad );
    float frame = step( 0.72, q.y ) + step( 0.955, q.x );
    float x = vQuad.x * 0.5 + 0.5;
    float on = step( x, vMisc.z );
    col = mix( vec3( 0.07, 0.03, 0.04 ), col * ( 0.75 + 0.35 * step( vQuad.y, 0.0 ) ), on );
    col = mix( col, vec3( 0.0 ), clamp( frame, 0.0, 1.0 ) );
    a = 0.92;
  } else if ( mode == 4 ) {         // FLAME: teardrop with a hot core, param = seed
    float y = vQuad.y * 0.5 + 0.5;
    float wob = sin( uTime * 9.0 + vMisc.z * 6.283 + y * 5.0 ) * 0.12 * y;
    float w = mix( 0.62, 0.0, pow( y, 1.3 ) ) * smoothstep( 0.0, 0.18, y );
    float d = abs( vQuad.x - wob ) / max( w, 0.001 );
    a = 1.0 - smoothstep( 0.55, 1.0, d );
    float core = 1.0 - smoothstep( 0.0, 0.7, d + y * 0.9 );
    col = mix( col, col * 0.6 + vec3( 0.75, 0.7, 0.5 ), core );
    col *= 1.0 + core * 0.6;
  } else {                          // PLATE: rounded dark plate behind labels
    vec2 q = abs( vQuad );
    a = ( 1.0 - smoothstep( 0.9, 1.0, q.x ) ) * ( 1.0 - smoothstep( 0.7, 1.0, q.y ) );
  }
  a *= vColor.a;
  if ( a < 0.004 ) discard;
  gl_FragColor = vec4( col * a, a * ( 1.0 - vMisc.y ) );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

function quadGeometry(plane: 'xz' | 'xy'): InstancedBufferGeometry {
  const geo = new InstancedBufferGeometry();
  const p = plane === 'xz'
    ? [-0.5, 0, -0.5, 0.5, 0, -0.5, 0.5, 0, 0.5, -0.5, 0, 0.5]
    : [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0];
  geo.setAttribute('position', new BufferAttribute(new Float32Array(p), 3));
  geo.setIndex(plane === 'xz' ? [0, 2, 1, 0, 3, 2] : [0, 1, 2, 0, 2, 3]);
  return geo;
}

abstract class QuadBatch {
  readonly mesh: Mesh<InstancedBufferGeometry, ShaderMaterial>;
  protected readonly data: Float32Array;
  protected readonly buffer: InstancedInterleavedBuffer;
  protected count = 0;
  protected readonly capacity: number;
  protected readonly stride: number;

  constructor(capacity: number, stride: number, attributes: string[], plane: 'xz' | 'xy', material: ShaderMaterial) {
    this.capacity = capacity;
    this.stride = stride;
    this.data = new Float32Array(capacity * stride);
    this.buffer = new InstancedInterleavedBuffer(this.data, stride);
    this.buffer.setUsage(DynamicDrawUsage);
    const geo = quadGeometry(plane);
    attributes.forEach((name, i) => geo.setAttribute(name, new InterleavedBufferAttribute(this.buffer, 4, i * 4)));
    geo.instanceCount = 0;
    this.mesh = new Mesh(geo, material);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
  }

  begin(): void {
    this.count = 0;
  }

  end(time: number): void {
    const geo = this.mesh.geometry;
    geo.instanceCount = this.count;
    this.mesh.visible = this.count > 0;
    this.mesh.material.uniforms.uTime.value = time;
    if (this.count > 0) {
      this.buffer.clearUpdateRanges();
      this.buffer.addUpdateRange(0, this.count * this.stride);
      this.buffer.needsUpdate = true;
    }
  }

  get used(): number {
    return this.count;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}

export class DecalBatch extends QuadBatch {
  constructor(capacity: number) {
    super(capacity, DECAL_STRIDE, ['iPosRot', 'iSize', 'iColor', 'iParam'], 'xz', new ShaderMaterial({
      vertexShader: DECAL_VERT, fragmentShader: DECAL_FRAG, uniforms: { uTime: { value: 0 } },
      transparent: true, premultipliedAlpha: true, blending: NormalBlending, depthWrite: false, side: DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    }));
    this.mesh.renderOrder = 2;
  }

  /** `sx`/`sz` are full sizes in metres; round shapes use sx as the diameter. `rgb` may exceed 1 (bloom). */
  push(
    shape: number, x: number, y: number, z: number, rot: number, sx: number, sz: number,
    r: number, g: number, b: number, a: number, additive = 0, p0 = 0, p1 = 0, p2 = 0,
  ): void {
    if (this.count >= this.capacity) return;
    const d = this.data;
    let i = this.count++ * DECAL_STRIDE;
    d[i++] = x; d[i++] = y; d[i++] = z; d[i++] = rot;
    d[i++] = sx; d[i++] = sz; d[i++] = shape; d[i++] = additive;
    d[i++] = r; d[i++] = g; d[i++] = b; d[i++] = a;
    d[i++] = p0; d[i++] = p1; d[i++] = p2; d[i] = 0;
  }
}

export class BillboardBatch extends QuadBatch {
  constructor(capacity: number, map: Texture, opts: { depthTest: boolean; toneMapped: boolean; renderOrder: number }) {
    super(capacity, SPRITE_STRIDE, ['iPosRot', 'iSizeOff', 'iUv', 'iColor', 'iMisc'], 'xy', new ShaderMaterial({
      vertexShader: SPRITE_VERT, fragmentShader: SPRITE_FRAG,
      uniforms: { uTime: { value: 0 }, uMap: { value: map } },
      transparent: true, premultipliedAlpha: true, blending: NormalBlending, depthWrite: false, side: DoubleSide,
      depthTest: opts.depthTest, toneMapped: opts.toneMapped,
    }));
    this.mesh.renderOrder = opts.renderOrder;
  }

  /** World anchor (x,y,z); `w`/`h` and offsets (ox, oy) are metres along the camera's right / up axes. */
  push(
    mode: number, x: number, y: number, z: number, w: number, h: number,
    r: number, g: number, b: number, a: number,
    additive = 0, param = 0, rot = 0, ox = 0, oy = 0, u0 = 0, v0 = 0, u1 = 1, v1 = 1,
  ): void {
    if (this.count >= this.capacity) return;
    const d = this.data;
    let i = this.count++ * SPRITE_STRIDE;
    d[i++] = x; d[i++] = y; d[i++] = z; d[i++] = rot;
    d[i++] = w; d[i++] = h; d[i++] = ox; d[i++] = oy;
    d[i++] = u0; d[i++] = v0; d[i++] = u1; d[i++] = v1;
    d[i++] = r; d[i++] = g; d[i++] = b; d[i++] = a;
    d[i++] = mode; d[i++] = additive; d[i++] = param; d[i] = 0;
  }
}
