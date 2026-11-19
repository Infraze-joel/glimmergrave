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
import type { Glare } from './glare.ts';

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
  /** Six-armed frost sigil: chill plate under enemies, frost hazard fixture. p0 = inner fill. */
  FROST: 12,
  /** Energy ribbon along +z: quad covers the lane. p0 = white-hot core 0..1. */
  BEAM: 13,
  /** Hazard warning: an iris closing from the rim to the centre. p0 = progress. (Telegraph shapes: p3 > 0 = dark underlay of that strength.) */
  WARN: 14,
  /** Vent grate fixture. p0 = glow between the bars. */
  GRATE: 15,
  /** Spike plate fixture. p0 = highlight. */
  PLATE: 16,
  /** Two-colour shockwave (Resonance). p0 = thickness, p1..p3 = second colour. */
  DUO: 17,
  /** Friendly guidance ring (tutorial). p1..p3 = second colour. */
  MARKER: 18,
  /** Hallowed ground (templar): double ring, slow turning rays, a pulse running outwards. p0 = fill, p1 = pulse 0..1, p2 = rays. */
  HALLOW: 19,
  /** Snare (rogue): toothed iron ring. p0 = armed glow 0..1, p1 = jaws closed 0..1. */
  TRAP: 20,
  /** Roiling cloud lying on the floor (smoke bomb, umbra pools). p0 = density, p1 = rim light, p2..p3 unused. */
  SMOKE: 21,
  /** Jagged, crackling ring (Superconduct, Void Arc). p0 = thickness, p1 = jaggedness. */
  CRACKLE: 22,
  /** A cell of the sprite atlas lying on the floor (aim marker). p0..p3 = uv rect. Needs the batch's `map`. */
  ATLAS: 23,
  /** Update 5. A sword lying flat, tip towards +z (orbiting blades, thrown blades). p0 = edge light 0..1. */
  BLADE: 24,
  /** Burning lane along +z (Blazing Wake). p0 = burnt out 0..1, p1 = seed, p2 > 0 = outline only. */
  WAKE: 25,
  /** Cracked crystal plate around a hero (Glass Cannon). p0 = facet fill, p1 = seed. */
  FRACTURE: 26,
  /** Spiral arms dragging inwards (Maelstrom). p0 = fill, p1 = turn rate (signed). */
  VORTEX: 27,
  /** Jagged lightning along +z across the quad (Chain Lightning, the familiar's bolt). p0 = seed. */
  BOLT: 28,
  /** Straight thread along +z with dashes running towards +z (bounce lines, leech and charge streaks). p0 = dash speed (0 = solid), p1 = head 0..1 (a bright bead at that fraction; < 0 none). */
  THREAD: 29,
} as const;

/** How much of a decal shape's area is lit, for the brightness governor (0 = not governed: warnings, fixtures, shadows). */
const DECAL_GLARE = new Float32Array(32);
DECAL_GLARE[DECAL.DISC] = 0.6;
DECAL_GLARE[DECAL.SHOCK] = 0.3;
DECAL_GLARE[DECAL.DUO] = 0.3;
DECAL_GLARE[DECAL.CRACKLE] = 0.3;
DECAL_GLARE[DECAL.HALLOW] = 0.3;
DECAL_GLARE[DECAL.FROST] = 0.25;
DECAL_GLARE[DECAL.RUNE] = 0.15;
DECAL_GLARE[DECAL.BEAM] = 0.5;
DECAL_GLARE[DECAL.STREAK] = 0.3;
DECAL_GLARE[DECAL.WAKE] = 0.4;
DECAL_GLARE[DECAL.VORTEX] = 0.2;
DECAL_GLARE[DECAL.BOLT] = 0.25;
DECAL_GLARE[DECAL.FRACTURE] = 0.12;
/** Additive share from which a quad counts as light. */
const GLARE_ADDITIVE = 0.5;
const GLARE_SPRITE = 0.5;

export const SPRITE = {
  ATLAS: 0,
  GLOW: 1,
  SPARK: 2,
  BAR: 3,
  FLAME: 4,
  PLATE: 5,
  /** Filled element pip with a dark rim (status row). */
  PIP: 6,
  /** Jagged lightning bolt along the quad's height; param = seed. */
  ARC: 7,
  /** Faceted crystal: a tall diamond with a lit and a dark half and no white core. param = highlight 0..1. */
  SHARD: 8,
  /** Ring with a dark edge filling the quad (an ellipse when the quad is squashed: a floor ring as an overlay). param = band width 0..1. */
  HOOP: 9,
  /** Update 5. A standing column of light, brightest at its foot (keystone moment). param = core 0..1. */
  COLUMN: 10,
  /** Update 5. A plain human silhouette (ghost afterimages, echoes). param = scan-line strength 0..1. */
  FIGURE: 11,
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
uniform float uCap;
uniform sampler2D uMap;
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
    if ( vParam.w > 0.0 ) { a = mask * vParam.w; col = vec3( 0.03, 0.0, 0.0 ); }   // underlay: dims what lies beneath
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
    if ( vParam.w > 0.0 ) { a = vParam.w; col = vec3( 0.03, 0.0, 0.0 ); }
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
  } else if ( shape == 11 ) {       // RUNE: summoning circle, p0 progress
    float ring1 = band( edge - 0.06, 0.04, 0.03 );
    float ring2 = band( rm - vHalf.x * 0.62, 0.03, 0.03 );
    float ticks = step( 0.72, fract( ( ang / ( 2.0 * PI ) + uTime * 0.12 ) * 10.0 ) ) * step( 0.62, r ) * step( r, 0.93 );
    float core = ( 1.0 - smoothstep( 0.0, 0.62, r ) ) * 0.35 * vParam.x;
    a = ring1 + ring2 * 0.7 + ticks * 0.55 + core;
  } else if ( shape == 12 ) {       // FROST sigil
    float sector = PI / 3.0;
    float a6 = abs( fract( ang / sector + 0.5 ) - 0.5 ) * sector;     // angle to the nearest arm
    float across = a6 * rm;
    float arm = band( across, 0.035, 0.03 ) * step( r, 0.84 );
    float twig = band( across - ( 0.84 - r ) * vHalf.x * 0.42, 0.03, 0.03 ) * step( 0.34, r ) * step( r, 0.84 );
    float ring1 = band( edge - 0.06, 0.035, 0.03 );
    float ring2 = band( rm - vHalf.x * 0.3, 0.025, 0.03 );
    float fill = ( 1.0 - r ) * step( r, 1.0 );
    a = ring1 + arm * 0.9 + twig * 0.65 + ring2 * 0.6 + fill * vParam.x;
    col = mix( col, vec3( 1.0 ), ( arm + ring1 ) * 0.35 );
  } else if ( shape == 13 ) {       // BEAM
    float w = 1.0 - abs( vUv.x );
    float along = ( vUv.y * 0.5 + 0.5 ) * vHalf.y * 2.0;
    float flow = 0.72 + 0.28 * sin( along * 1.7 - uTime * 26.0 + sin( uTime * 7.0 + along * 0.4 ) * 2.0 );
    float ends = smoothstep( 0.0, 0.5, along ) * smoothstep( vHalf.y * 2.0, vHalf.y * 2.0 - 0.8, along );
    a = pow( w, 1.5 ) * flow * ends;
    col = mix( col, vec3( 1.0 ), pow( w, 5.0 ) * 0.85 * vParam.x );
  } else if ( shape == 14 ) {       // WARN: closing iris
    float inside = step( r, 1.0 );
    float outline = band( edge - 0.06, 0.06, aa );
    float fillR = ( 1.0 - vParam.x ) * vHalf.x;
    float fill = smoothstep( fillR - 0.04, fillR, rm ) * inside;
    float lead = band( rm - fillR, 0.07, 0.08 ) * inside * step( vParam.x, 0.999 );
    float dash = step( 0.5, fract( ang / ( 2.0 * PI ) * 12.0 - uTime * 0.6 ) );
    float blink = 0.72 + 0.28 * sin( uTime * ( 8.0 + 24.0 * vParam.x ) );
    a = inside * 0.05 + fill * 0.3 * blink + lead * 0.75 + outline * mix( 0.6, 1.0, dash );
    col = mix( col, vec3( 1.0 ), lead * 0.55 );
  } else if ( shape == 15 ) {       // GRATE
    float inside = 1.0 - smoothstep( 0.84, 0.88, r );
    float rim = band( edge - 0.08, 0.07, 0.03 );
    float bar = step( 0.42, fract( vUv.x * vHalf.x * 3.4 + 0.25 ) );
    float cross = step( 0.9, fract( vUv.y * vHalf.x * 1.1 + 0.5 ) );
    float slot = inside * bar * ( 1.0 - cross );
    vec3 iron = vec3( 0.07, 0.065, 0.075 );
    col = mix( iron, vColor.rgb * ( 0.22 + 1.9 * vParam.x ), slot );
    col = mix( col, iron * 2.4, rim );
    a = max( inside * 0.94, rim );
  } else if ( shape == 16 ) {       // PLATE
    float inside = 1.0 - smoothstep( 0.88, 0.92, r );
    float rim = band( edge - 0.07, 0.06, 0.03 );
    vec2 cell = fract( vUv * vHalf.x * 2.3 + 0.5 ) - 0.5;
    float hole = ( 1.0 - smoothstep( 0.17, 0.23, length( cell ) ) ) * step( r, 0.74 );
    vec3 steel = vColor.rgb * ( 0.16 + 0.12 * vParam.x );
    col = mix( steel, vec3( 0.012 ), hole );
    col = mix( col, vColor.rgb * ( 0.55 + 0.7 * vParam.x ), rim );
    a = max( inside * 0.94, rim );
  } else if ( shape == 17 ) {       // DUO shockwave
    float t = clamp( ( 1.0 - r ) / max( vParam.x, 0.02 ), 0.0, 1.0 );
    float crest = band( edge - 0.06, 0.05, 0.05 );
    a = step( r, 1.0 ) * ( 1.0 - t ) * ( 1.0 - t ) + crest;
    float swirl = smoothstep( 0.32, 0.68, 0.5 + 0.5 * sin( ang * 3.0 + r * 8.0 - uTime * 9.0 ) );
    col = mix( vColor.rgb, vParam.yzw, swirl );
    col += vec3( 1.0 ) * crest * 0.15;
  } else if ( shape == 19 ) {       // HALLOW
    float ring1 = band( edge - 0.07, 0.05, 0.03 );
    float ring2 = band( rm - vHalf.x * 0.56, 0.03, 0.03 );
    float rays = pow( abs( cos( ( ang + uTime * 0.22 ) * 4.0 ) ), 14.0 ) * smoothstep( 0.2, 0.5, r ) * step( r, 0.93 );
    float inner = pow( abs( cos( ( ang - uTime * 0.3 ) * 2.0 ) ), 24.0 ) * step( r, 0.54 ) * smoothstep( 0.05, 0.2, r );
    float pr = vParam.y * vHalf.x;
    float pulse = band( rm - pr, 0.12, 0.25 ) * ( 1.0 - vParam.y ) * step( r, 1.0 );
    float fill = ( 1.0 - smoothstep( 0.0, 1.0, r ) ) * vParam.x;
    float shimmer = 0.75 + 0.25 * sin( rm * 3.0 - uTime * 2.4 );
    a = ring1 + ring2 * 0.6 + ( rays * 0.5 + inner * 0.6 ) * vParam.z * shimmer + pulse * 0.8 + fill * step( r, 1.0 );
    col = mix( col, vec3( 1.0 ), ( ring1 + pulse ) * 0.4 );
  } else if ( shape == 20 ) {       // TRAP
    float closed = vParam.y;
    float ringR = vHalf.x * mix( 0.8, 0.3, closed );
    float tooth = abs( fract( ang / ( 2.0 * PI ) * 12.0 ) - 0.5 ) * 2.0;
    float jag = ringR - tooth * vHalf.x * 0.24;
    float jaws = smoothstep( jag - 0.03, jag, rm ) * ( 1.0 - smoothstep( ringR + 0.07, ringR + 0.1, rm ) );
    float hub = 1.0 - smoothstep( vHalf.x * 0.12, vHalf.x * 0.15, rm );
    float plate = ( 1.0 - smoothstep( 0.95, 1.0, r ) ) * 0.28;
    vec3 iron = vec3( 0.12, 0.12, 0.14 );
    float glow = band( rm - ringR - 0.03, 0.03, 0.06 ) * vParam.x;
    col = mix( iron * 0.4, iron * 1.9, jaws );
    col = mix( col, vColor.rgb, clamp( hub * vParam.x + glow, 0.0, 1.0 ) );
    a = max( max( jaws, hub ) * 0.96, max( plate, glow ) );
    a = max( a, band( edge - 0.05, 0.025, 0.03 ) * 0.5 * vParam.x * step( 0.5, fract( ang / ( 2.0 * PI ) * 16.0 + uTime * 0.2 ) ) );
  } else if ( shape == 21 ) {       // SMOKE
    float swirl = sin( ang * 3.0 + r * 5.0 - uTime * 0.9 ) * 0.5 + sin( ang * 5.0 - r * 9.0 + uTime * 0.6 ) * 0.3 + sin( ang * 9.0 + uTime * 1.3 ) * 0.2;
    float body = 1.0 - smoothstep( 0.55 + swirl * 0.14, 1.0, r );
    float billow = 0.72 + 0.28 * sin( r * 11.0 - uTime * 1.4 + swirl * 3.0 );
    float rim = smoothstep( 0.5, 0.9, r + swirl * 0.1 ) * body;
    a = body * vParam.x * billow;
    col = mix( col, vParam.yzw, clamp( rim * 1.6, 0.0, 1.0 ) * step( 0.001, vParam.y + vParam.z + vParam.w ) );
  } else if ( shape == 22 ) {       // CRACKLE
    float n = sin( ang * 7.0 + uTime * 23.0 ) * 0.5 + sin( ang * 17.0 - uTime * 31.0 ) * 0.3 + sin( ang * 41.0 + uTime * 13.0 ) * 0.2;
    float rr = r + n * 0.07 * vParam.y;
    float t = clamp( ( 1.0 - rr ) / max( vParam.x, 0.02 ), 0.0, 1.0 );
    float crest = 1.0 - smoothstep( 0.0, 0.05, abs( rr - 0.93 ) );
    float spokes = pow( abs( sin( ang * 5.0 + n * 2.0 ) ), 30.0 ) * smoothstep( 0.35, 0.9, r ) * step( rr, 0.95 );
    a = step( rr, 1.0 ) * ( 1.0 - t ) * ( 1.0 - t ) * 0.7 + crest + spokes * 0.7;
    col = mix( col, vec3( 1.0 ), clamp( crest * 0.7 + spokes * 0.5, 0.0, 1.0 ) );
  } else if ( shape == 23 ) {       // ATLAS cell on the floor
    vec4 t = texture2D( uMap, mix( vParam.xy, vParam.zw, vec2( vUv.x, -vUv.y ) * 0.5 + 0.5 ) );
    col *= t.rgb;
    a = t.a;
  } else if ( shape == 24 ) {       // BLADE: flat sword, tip at +z
    float t = vUv.y * 0.5 + 0.5;
    float x = abs( vUv.x );
    float halfW = mix( 0.46, 0.0, smoothstep( 0.55, 1.0, t ) );
    float blade = step( 0.24, t ) * ( 1.0 - smoothstep( halfW - 0.1, halfW, x ) );
    float guard = step( 0.17, t ) * step( t, 0.25 ) * ( 1.0 - smoothstep( 0.85, 0.98, x ) );
    float grip = step( 0.02, t ) * step( t, 0.2 ) * ( 1.0 - smoothstep( 0.14, 0.2, x ) );
    float lit = smoothstep( halfW - 0.34, halfW - 0.06, x ) * blade;
    float fuller = ( 1.0 - smoothstep( 0.0, 0.08, x ) ) * blade * step( t, 0.8 );
    vec3 steel = vec3( 0.62, 0.68, 0.78 ) * ( 0.8 + 0.3 * vUv.x );
    col = mix( steel, vColor.rgb, clamp( lit * ( 0.6 + 0.6 * vParam.x ) + guard, 0.0, 1.0 ) );
    col = mix( col, vec3( 0.16, 0.17, 0.22 ), max( fuller * 0.5, grip * 0.8 ) );
    a = max( blade, max( guard, grip ) );
  } else if ( shape == 25 ) {       // WAKE: burning lane
    float w = 1.0 - abs( vUv.x );
    float along = vUv.y * vHalf.y + vParam.y * 7.0;
    float n = sin( along * 4.3 + uTime * 7.0 ) * 0.5 + sin( along * 9.1 - uTime * 11.0 + vUv.x * 3.0 ) * 0.3 + sin( vUv.x * 8.0 + uTime * 5.0 + along * 2.0 ) * 0.2;
    float ends = smoothstep( 1.0, 0.72, abs( vUv.y ) );
    if ( vParam.z > 0.0 ) {
      float dash = step( 0.45, fract( along * 0.9 - uTime * 0.5 ) );
      a = band( w - 0.12, 0.07, 0.05 ) * ends * mix( 0.35, 1.0, dash ) * ( 1.0 - vParam.x );
    } else {
      float burn = vParam.x * 0.55;
      float body = smoothstep( burn, burn + 0.6, w + n * 0.25 );
      float core = smoothstep( 0.5 + burn, 1.0 + burn, w + n * 0.22 );
      a = ( body * 0.5 + core * 0.55 ) * ends;
      col = mix( col, col * 0.5 + vec3( 0.75, 0.62, 0.35 ), core * 0.7 );
    }
  } else if ( shape == 26 ) {       // FRACTURE: cracked crystal plate
    float seg = 7.0;
    float aN = ( ang / ( 2.0 * PI ) + 0.5 ) * seg + vParam.y;
    float cell = floor( aN );
    float f = fract( aN ) - 0.5;
    float jag = sin( r * 13.0 + cell * 2.4 ) * 0.14 + sin( r * 29.0 + cell ) * 0.05;
    float crack = 1.0 - smoothstep( 0.0, 0.05 / max( r, 0.25 ), abs( f - jag ) );
    float shardR = 0.62 + 0.13 * sin( cell * 3.7 + 1.0 );
    float chip = band( r - shardR - f * 0.22, 0.012, 0.02 );
    float mask = smoothstep( 0.34, 0.5, r ) * ( 1.0 - smoothstep( 0.8 + 0.14 * sin( cell * 5.1 ), 1.0, r ) );
    float facet = fract( sin( cell * 12.9898 ) * 43758.5453 );
    float glint = pow( 0.5 + 0.5 * sin( uTime * 1.7 + cell * 2.1 ), 6.0 );
    a = ( crack * 0.95 + chip * 0.7 + ( 0.25 + 0.75 * facet ) * vParam.x + glint * facet * 0.25 ) * mask;
    col = mix( col, vec3( 1.0 ), crack * 0.5 );
  } else if ( shape == 27 ) {       // VORTEX: spiral arms
    float sp = sin( ang * 3.0 + log( r + 0.05 ) * 5.0 + uTime * vParam.y );
    float arms = smoothstep( 0.35, 0.95, sp ) * smoothstep( 1.0, 0.82, r ) * smoothstep( 0.06, 0.3, r );
    float rim = band( edge - 0.06, 0.04, 0.04 );
    float streaks = pow( abs( sin( ang * 11.0 + r * 9.0 + uTime * vParam.y * 1.6 ) ), 18.0 ) * smoothstep( 0.4, 0.95, r ) * step( r, 1.0 );
    a = arms * ( 0.35 + 0.65 * vParam.x ) + rim * 0.8 + streaks * 0.45;
    col = mix( col, vec3( 1.0 ), arms * arms * 0.25 );
  } else if ( shape == 28 ) {       // BOLT: jagged lightning along +z
    float y = vUv.y * 0.5 + 0.5;
    float m = y * vHalf.y * 2.0;
    float s = vParam.x;
    float x = sin( m * 2.1 + s ) * 0.34 + sin( m * 5.3 + s * 1.7 ) * 0.2 + sin( m * 11.0 + s * 2.3 ) * 0.09;
    x *= sin( y * PI );
    float d = abs( vUv.x - x );
    float core = 1.0 - smoothstep( 0.0, 0.1, d );
    float halo = 1.0 - smoothstep( 0.0, 0.42, d );
    col = mix( col, vec3( 1.0 ), core * 0.8 );
    a = max( halo * 0.45, core ) * smoothstep( 0.0, 0.04, y ) * smoothstep( 1.0, 0.96, y );
  } else if ( shape == 29 ) {       // THREAD: dashed line with an optional bright bead
    float w = 1.0 - abs( vUv.x );
    float y = vUv.y * 0.5 + 0.5;
    float m = y * vHalf.y * 2.0;
    float dash = vParam.x == 0.0 ? 1.0 : step( 0.45, fract( m * 1.1 - uTime * vParam.x ) );
    float line = smoothstep( 0.45, 0.8, w );
    float bead = vParam.y < 0.0 ? 0.0 : ( 1.0 - smoothstep( 0.0, 0.5, length( vec2( vUv.x * vHalf.x, ( y - vParam.y ) * vHalf.y * 2.0 ) ) ) );
    a = line * ( 0.3 + 0.7 * dash ) * smoothstep( 0.0, 0.05, y ) * smoothstep( 1.0, 0.95, y ) + bead;
    col = mix( col, vec3( 1.0 ), bead * 0.7 );
  } else {                          // MARKER
    float ring = band( edge - 0.09, 0.06, 0.03 );
    float dash = step( 0.3, fract( ang / ( 2.0 * PI ) * 10.0 + uTime * 0.18 ) );
    float pr = fract( uTime * 0.65 );
    float pulse = band( rm - vHalf.x * ( 1.0 - pr ) * 0.86, 0.05, 0.05 ) * ( 1.0 - pr );
    a = ring * mix( 0.3, 1.0, dash ) + pulse * 0.9 + step( r, 1.0 ) * ( 0.02 + 0.012 * sin( uTime * 3.0 ) );
    col = mix( vColor.rgb, vParam.yzw, clamp( pulse * 1.4, 0.0, 1.0 ) );
  }
  a = clamp( a, 0.0, 1.0 ) * vColor.a;
  if ( a < 0.004 ) discard;
  vec3 lit = col * a;
  if ( uCap > 0.0 ) lit = min( lit, vec3( uCap ) );   // clarity: no single decal is brighter than this (keeps bloom off)
  gl_FragColor = vec4( lit, a * ( 1.0 - vShape.y ) );
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
uniform float uCap;
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
  } else if ( mode == 5 ) {         // PLATE: rounded dark plate behind labels
    vec2 q = abs( vQuad );
    a = ( 1.0 - smoothstep( 0.9, 1.0, q.x ) ) * ( 1.0 - smoothstep( 0.7, 1.0, q.y ) );
  } else if ( mode == 6 ) {         // PIP
    a = 1.0 - smoothstep( 0.9, 1.0, r );
    float inner = 1.0 - smoothstep( 0.68, 0.78, r );
    col = mix( vec3( 0.02, 0.02, 0.05 ), col * ( 0.78 + 0.2 * vQuad.y ), inner );
  } else if ( mode == 8 ) {         // SHARD
    float d = abs( vQuad.x ) + abs( vQuad.y );
    a = 1.0 - smoothstep( 0.9, 1.0, d );
    float lit = step( 0.0, vQuad.x * 0.8 + vQuad.y * 0.25 );
    float edgeL = 1.0 - smoothstep( 0.0, 0.07, abs( vQuad.x ) );
    col *= mix( 0.45, 1.15, lit ) + smoothstep( 0.6, 1.0, d ) * 0.35;
    col = mix( col, col + vec3( 0.55 ), edgeL * vMisc.z );
  } else if ( mode == 9 ) {         // HOOP
    float d = abs( r - 0.84 );
    a = 1.0 - smoothstep( vMisc.z, vMisc.z + 0.03, d );
    col = mix( vec3( 0.02, 0.02, 0.04 ), col, 1.0 - smoothstep( vMisc.z * 0.5, vMisc.z * 0.5 + 0.03, d ) );
  } else if ( mode == 10 ) {        // COLUMN
    float y = vQuad.y * 0.5 + 0.5;
    float w = 1.0 - abs( vQuad.x );
    float flow = 0.8 + 0.2 * sin( y * 14.0 - uTime * 9.0 + vQuad.x * 3.0 );
    a = w * w * ( 1.0 - y ) * ( 1.0 - y * 0.4 ) * flow * smoothstep( 0.0, 0.04, y );
    col = mix( col, vec3( 1.0 ), pow( w, 6.0 ) * vMisc.z * ( 1.0 - y ) );
  } else if ( mode == 11 ) {        // FIGURE
    vec2 q = vQuad;
    float head = 1.0 - smoothstep( 0.15, 0.2, length( ( q - vec2( 0.0, 0.74 ) ) * vec2( 1.9, 1.0 ) ) );
    float tw = mix( 0.24, 0.52, smoothstep( -0.1, 0.48, q.y ) );
    float torso = ( 1.0 - smoothstep( tw - 0.06, tw, abs( q.x ) ) ) * step( -0.12, q.y ) * ( 1.0 - smoothstep( 0.5, 0.58, q.y ) );
    float legs = ( 1.0 - smoothstep( 0.1, 0.16, abs( abs( q.x ) - 0.2 ) ) ) * step( -0.98, q.y ) * step( q.y, -0.1 );
    float body = max( head, max( torso, legs ) );
    float scan = 1.0 - vMisc.z * ( 0.5 + 0.5 * sin( q.y * 34.0 + uTime * 12.0 ) ) * 0.6;
    a = body * scan * ( 0.55 + 0.45 * ( q.y * 0.5 + 0.5 ) );
  } else {                          // ARC
    float y = vQuad.y * 0.5 + 0.5;
    float s = vMisc.z;
    float x = sin( y * 9.0 + s ) * 0.3 + sin( y * 23.0 + s * 1.7 ) * 0.17 + sin( y * 51.0 + s * 2.3 ) * 0.07;
    x *= sin( y * 3.14159 );
    float d = abs( vQuad.x - x );
    float core = 1.0 - smoothstep( 0.0, 0.06, d );
    float halo = 1.0 - smoothstep( 0.0, 0.22, d );
    col = mix( col, vec3( 1.0 ), core );
    a = max( halo * 0.55, core ) * smoothstep( 0.0, 0.06, y ) * smoothstep( 1.0, 0.94, y );
  }
  a *= vColor.a;
  if ( a < 0.004 ) discard;
  vec3 lit = col * a;
  if ( uCap > 0.0 ) lit = min( lit, vec3( uCap ) );
  gl_FragColor = vec4( lit, a * ( 1.0 - vMisc.y ) );
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
  /** Factor on the alpha of every quad with an additive share pushed while it is set (clarity: light hung on enemies). */
  gain = 1;
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

  /** Brightest a single quad of this batch may come out (0 = no cap). */
  setCap(cap: number): void {
    this.mesh.material.uniforms.uCap.value = cap;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}

export class DecalBatch extends QuadBatch {
  /** Brightness governor for the additive shapes of this batch (null: nothing is dimmed, e.g. the telegraph batch). */
  glare: Glare | null = null;

  /** `map` (the sprite atlas) is only needed for DECAL.ATLAS. */
  constructor(capacity: number, map: Texture | null = null, renderOrder = 2) {
    super(capacity, DECAL_STRIDE, ['iPosRot', 'iSize', 'iColor', 'iParam'], 'xz', new ShaderMaterial({
      vertexShader: DECAL_VERT, fragmentShader: DECAL_FRAG, uniforms: { uTime: { value: 0 }, uCap: { value: 0 }, uMap: { value: map } },
      transparent: true, premultipliedAlpha: true, blending: NormalBlending, depthWrite: false, side: DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    }));
    this.mesh.renderOrder = renderOrder;
  }

  /** `sx`/`sz` are full sizes in metres; round shapes use sx as the diameter. `rgb` may exceed 1 (bloom). */
  push(
    shape: number, x: number, y: number, z: number, rot: number, sx: number, sz: number,
    r: number, g: number, b: number, a: number, additive = 0, p0 = 0, p1 = 0, p2 = 0, p3 = 0,
  ): void {
    if (this.count >= this.capacity) return;
    if (additive > 0) a *= this.gain;
    if (this.glare && additive >= GLARE_ADDITIVE && DECAL_GLARE[shape] > 0) {
      a *= this.glare.take(x, 0, z, Math.sqrt(sx * sz), a * Math.max(r, g, b) * DECAL_GLARE[shape] * additive);
    }
    const d = this.data;
    let i = this.count++ * DECAL_STRIDE;
    d[i++] = x; d[i++] = y; d[i++] = z; d[i++] = rot;
    d[i++] = sx; d[i++] = sz; d[i++] = shape; d[i++] = additive;
    d[i++] = r; d[i++] = g; d[i++] = b; d[i++] = a;
    d[i++] = p0; d[i++] = p1; d[i++] = p2; d[i] = p3;
  }
}

export class BillboardBatch extends QuadBatch {
  /** Brightness governor for the additive glows, flames and bolts of this batch (null: nothing is dimmed). */
  glare: Glare | null = null;

  constructor(capacity: number, map: Texture, opts: { depthTest: boolean; toneMapped: boolean; renderOrder: number }) {
    super(capacity, SPRITE_STRIDE, ['iPosRot', 'iSizeOff', 'iUv', 'iColor', 'iMisc'], 'xy', new ShaderMaterial({
      vertexShader: SPRITE_VERT, fragmentShader: SPRITE_FRAG,
      uniforms: { uTime: { value: 0 }, uCap: { value: 0 }, uMap: { value: map } },
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
    if (additive > 0) a *= this.gain;
    if (this.glare && additive >= GLARE_ADDITIVE && (mode === SPRITE.GLOW || mode === SPRITE.FLAME || mode === SPRITE.ARC || mode === SPRITE.COLUMN)) {
      a *= this.glare.take(x, y, z, Math.sqrt(w * h), a * Math.max(r, g, b) * GLARE_SPRITE * additive);
    }
    const d = this.data;
    let i = this.count++ * SPRITE_STRIDE;
    d[i++] = x; d[i++] = y; d[i++] = z; d[i++] = rot;
    d[i++] = w; d[i++] = h; d[i++] = ox; d[i++] = oy;
    d[i++] = u0; d[i++] = v0; d[i++] = u1; d[i++] = v1;
    d[i++] = r; d[i++] = g; d[i++] = b; d[i++] = a;
    d[i++] = mode; d[i++] = additive; d[i++] = param; d[i] = 0;
  }
}
