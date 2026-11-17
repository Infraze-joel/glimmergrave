/**
 * Animated ground surfaces of the biomes, one draw call each:
 *   water – shallow drowned-catacomb water: rippling normals, torch glitter paths and a darkened "reflection" of
 *           the north wall, all analytic (no reflection pass, no depth texture)
 *   lava  – the ember foundry's glowing channels around the walkable floor: drifting crust with hot seams
 */
import { Color, DoubleSide, ShaderMaterial, UniformsLib, UniformsUtils, Vector2, Vector3 } from 'three';

const VERT = /* glsl */ `
varying vec3 vWorld;
#include <fog_pars_vertex>
void main() {
  vec4 world = modelMatrix * vec4( position, 1.0 );
  vWorld = world.xyz;
  vec4 mvPosition = viewMatrix * world;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const WATER_FRAG = /* glsl */ `
uniform float uTime;
uniform vec3 uDeep;
uniform vec3 uShallow;
uniform vec3 uGlint;
uniform vec3 uLightPos[ 4 ];
uniform float uLightPower[ 4 ];
uniform vec2 uRoom;
varying vec3 vWorld;
#include <fog_pars_fragment>
void main() {
  vec2 p = vWorld.xz;
  float t = uTime;
  // four travelling wave trains -> analytic slope
  vec2 n = vec2( 0.0 );
  n += vec2( 1.0, 0.3 ) * cos( dot( p, vec2( 1.0, 0.3 ) ) * 1.7 + t * 1.1 );
  n += vec2( -0.4, 1.0 ) * cos( dot( p, vec2( -0.4, 1.0 ) ) * 2.3 - t * 1.4 );
  n += vec2( 0.7, -0.8 ) * cos( dot( p, vec2( 0.7, -0.8 ) ) * 3.9 + t * 1.9 ) * 0.6;
  n += vec2( -0.9, -0.5 ) * cos( dot( p, vec2( -0.9, -0.5 ) ) * 6.1 - t * 2.6 ) * 0.35;
  vec3 N = normalize( vec3( n.x * 0.07, 1.0, n.y * 0.07 ) );
  vec3 V = normalize( cameraPosition - vWorld );
  float fres = pow( 1.0 - max( dot( N, V ), 0.0 ), 3.0 );

  // inside the walls the floor shows through; outside the water is deep and opaque
  vec2 q = abs( p ) - uRoom;
  float outside = smoothstep( 0.0, 1.2, max( q.x, q.y ) );
  float swell = 0.5 + 0.5 * ( n.x * 0.35 + n.y * 0.25 );
  vec3 col = mix( uDeep, uShallow, swell * ( 1.0 - outside * 0.7 ) );

  // caustic lattice drifting over the bed
  float c1 = sin( p.x * 2.1 + sin( p.y * 1.7 + t * 0.9 ) * 1.3 );
  float c2 = sin( p.y * 2.4 + sin( p.x * 1.9 - t * 0.7 ) * 1.3 );
  float caustic = smoothstep( 0.9, 1.0, 1.0 - abs( c1 * c2 ) ) * ( 1.0 - outside );
  col += uGlint * caustic * 0.22;

  // the north wall mirrored in the water in front of it, broken up by the ripples
  float wall = smoothstep( 4.2, 0.0, p.y + uRoom.y + n.y * 0.45 ) * ( 1.0 - outside ) * step( -uRoom.y, p.y );
  col = mix( col, uDeep * 0.45, wall * 0.75 );

  // glitter path of every torch
  float spec = 0.0;
  for ( int i = 0; i < 4; i++ ) {
    vec3 L = uLightPos[ i ] - vWorld;
    float d = length( L );
    vec3 H = normalize( L / d + V );
    spec += pow( max( dot( N, H ), 0.0 ), 140.0 ) * uLightPower[ i ] / ( 1.0 + d * d * 0.012 );
  }
  col += uGlint * spec;
  col += uGlint * fres * 0.5;
  float alpha = clamp( mix( 0.5, 0.93, outside ) + fres * 0.35 + wall * 0.25 + spec * 0.5, 0.0, 1.0 );
  gl_FragColor = vec4( col, alpha );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

const LAVA_FRAG = /* glsl */ `
uniform float uTime;
uniform vec3 uHot;
uniform vec3 uCrust;
uniform float uHeat;
varying vec3 vWorld;
#include <fog_pars_fragment>
float hash( vec2 p ) { return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 ); }
float noise( vec2 p ) {
  vec2 i = floor( p );
  vec2 f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( hash( i ), hash( i + vec2( 1.0, 0.0 ) ), f.x ), mix( hash( i + vec2( 0.0, 1.0 ) ), hash( i + vec2( 1.0, 1.0 ) ), f.x ), f.y );
}
void main() {
  // heat shimmer: the whole field wobbles very slightly
  vec2 p = vWorld.xz * 0.42 + vec2( sin( uTime * 1.3 + vWorld.z * 0.8 ), cos( uTime * 1.1 + vWorld.x * 0.7 ) ) * 0.025;
  float t = uTime * 0.06;
  float crust = noise( p + vec2( t, t * 0.6 ) ) * 0.6 + noise( p * 2.7 - vec2( t * 1.7, 0.0 ) ) * 0.28 + noise( p * 6.3 + t ) * 0.12;
  float channel = smoothstep( 0.5, 0.36, crust );            // open lava
  float seam = 1.0 - smoothstep( 0.0, 0.045, abs( crust - 0.5 ) );   // white-hot edge of the plates
  float cracks = 1.0 - smoothstep( 0.0, 0.02, abs( noise( p * 3.1 + 7.0 ) - 0.5 ) );
  float pulse = 0.85 + 0.15 * sin( uTime * 1.7 + crust * 14.0 );
  vec3 col = uCrust * ( 0.6 + 0.8 * crust );
  col = mix( col, uHot * ( 0.9 + 1.3 * ( 0.5 - crust ) ) * pulse, channel );
  col += uHot * seam * 1.1;
  col += uHot * cracks * 0.3 * ( 1.0 - channel );
  col *= uHeat;
  gl_FragColor = vec4( col, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

export interface WaterMaterial {
  material: ShaderMaterial;
  setLight(index: number, x: number, y: number, z: number, power: number): void;
  setRoom(halfWidth: number, halfDepth: number): void;
  setColors(deep: number, shallow: number, glint: number): void;
}

export function createWaterMaterial(): WaterMaterial {
  const lightPos = [new Vector3(), new Vector3(), new Vector3(), new Vector3()];
  const lightPower = [0, 0, 0, 0];
  const uniforms = UniformsUtils.merge([UniformsLib.fog, {
    uTime: { value: 0 }, uDeep: { value: new Color(0x031418) }, uShallow: { value: new Color(0x0f4a52) }, uGlint: { value: new Color(0x9ff5ff) },
    uRoom: { value: new Vector2(10, 10) },
  }]);
  // not cloned by merge(): the arrays are written in place
  uniforms.uLightPos = { value: lightPos };
  uniforms.uLightPower = { value: lightPower };
  const material = new ShaderMaterial({
    vertexShader: VERT, fragmentShader: WATER_FRAG, uniforms, fog: true, transparent: true, depthWrite: false, side: DoubleSide,
  });
  return {
    material,
    setLight: (i, x, y, z, power) => { lightPos[i].set(x, y, z); lightPower[i] = power; },
    setRoom: (hw, hd) => { (uniforms.uRoom.value as Vector2).set(hw, hd); },
    setColors: (deep, shallow, glint) => {
      (uniforms.uDeep.value as Color).setHex(deep);
      (uniforms.uShallow.value as Color).setHex(shallow);
      (uniforms.uGlint.value as Color).setHex(glint);
    },
  };
}

export interface LavaMaterial {
  material: ShaderMaterial;
  setColors(hot: number, crust: number, heat: number): void;
}

export function createLavaMaterial(): LavaMaterial {
  const uniforms = UniformsUtils.merge([UniformsLib.fog, {
    uTime: { value: 0 }, uHot: { value: new Color(0xff5a12) }, uCrust: { value: new Color(0x120807) }, uHeat: { value: 1 },
  }]);
  const material = new ShaderMaterial({ vertexShader: VERT, fragmentShader: LAVA_FRAG, uniforms, fog: true });
  return {
    material,
    setColors: (hot, crust, heat) => {
      (uniforms.uHot.value as Color).setHex(hot);
      (uniforms.uCrust.value as Color).setHex(crust);
      uniforms.uHeat.value = heat;
    },
  };
}
