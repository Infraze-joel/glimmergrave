/**
 * Character material: one Lambert program shared by every hero and skeleton, with per-instance uniforms for
 * hit flash, status tint, cloth recolour, glow colour and a dithered dissolve (no transparency sorting).
 *
 * Baked vertex attributes (see assets.ts):
 *   aMask.x  glow      – unlit emissive part (eyes: uGlow; untextured parts such as crown gems: aTint)
 *   aMask.y  cloth     – recoloured with uCloth (capes / cloaks)
 *   aMask.z  untextured – use aTint instead of the atlas texel (procedural parts)
 */
import { Color, MeshLambertMaterial, Vector4 } from 'three';
import type { Texture, WebGLProgramParametersWithUniforms } from 'three';

export interface CharacterUniforms {
  /** rgb = flash colour, a = amount 0..1 (replaces the lit colour). */
  uFlash: { value: Vector4 };
  /** rgb = status tint, a = amount 0..1. */
  uTint: { value: Vector4 };
  /** rgb = cloth colour, a = amount 0..1. */
  uCloth: { value: Vector4 };
  uGlow: { value: Color };
  /** Flat additive emissive (auras, enrage pulse). */
  uEmissive: { value: Color };
  /** 1 = solid, 0 = fully dissolved. */
  uFade: { value: number };
  /** rgb = fresnel rim colour (status read: burn orange, chill ice, shock violet), a = strength. */
  uRim: { value: Vector4 };
}

export interface CharacterMaterial {
  material: MeshLambertMaterial;
  uniforms: CharacterUniforms;
}

const VERT_PARS = /* glsl */ `
attribute vec3 aMask;
attribute vec3 aTint;
varying vec3 vMask;
varying vec3 vTintC;
`;

const FRAG_PARS = /* glsl */ `
uniform vec4 uFlash;
uniform vec4 uTint;
uniform vec4 uCloth;
uniform vec3 uGlow;
uniform vec3 uEmissive;
uniform float uFade;
uniform vec4 uRim;
varying vec3 vMask;
varying vec3 vTintC;
`;

const FRAG_DISSOLVE = /* glsl */ `
if ( uFade < 0.999 ) {
  float ign = fract( 52.9829189 * fract( dot( floor( gl_FragCoord.xy ), vec2( 0.06711056, 0.00583715 ) ) ) );
  if ( ign > uFade ) discard;
}
`;

const FRAG_ALBEDO = /* glsl */ `
diffuseColor.rgb = mix( diffuseColor.rgb, vTintC, vMask.z );
float gLum = dot( diffuseColor.rgb, vec3( 0.299, 0.587, 0.114 ) );
diffuseColor.rgb = mix( diffuseColor.rgb, uCloth.rgb * ( gLum * 1.9 + 0.12 ), vMask.y * uCloth.a );
diffuseColor.rgb = mix( diffuseColor.rgb, uTint.rgb * ( gLum * 0.9 + 0.3 ), uTint.a );
diffuseColor.rgb *= 1.0 - vMask.x;
`;

const FRAG_EMISSIVE = /* glsl */ `
totalEmissiveRadiance += mix( uGlow, vTintC, vMask.z ) * vMask.x + uEmissive;
if ( uRim.a > 0.001 ) {
  float rimF = 1.0 - clamp( dot( normal, normalize( vViewPosition ) ), 0.0, 1.0 );
  totalEmissiveRadiance += uRim.rgb * ( rimF * rimF * uRim.a );
}
`;

const FRAG_FLASH = /* glsl */ `
gl_FragColor.rgb = mix( gl_FragColor.rgb, uFlash.rgb, uFlash.a );
`;

const CACHE_KEY = 'gg-character-v2';

export function createCharacterMaterial(map: Texture): CharacterMaterial {
  const uniforms: CharacterUniforms = {
    uFlash: { value: new Vector4(1, 1, 1, 0) },
    uTint: { value: new Vector4(1, 1, 1, 0) },
    uCloth: { value: new Vector4(1, 1, 1, 0) },
    uGlow: { value: new Color(0xffffff) },
    uEmissive: { value: new Color(0x000000) },
    uFade: { value: 1 },
    uRim: { value: new Vector4(1, 1, 1, 0) },
  };
  const material = new MeshLambertMaterial({ map });
  material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_PARS}`)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvMask = aMask;\nvTintC = aTint;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_PARS}`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>\n${FRAG_DISSOLVE}`)
      .replace('#include <map_fragment>', `#include <map_fragment>\n${FRAG_ALBEDO}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${FRAG_EMISSIVE}`)
      .replace('#include <opaque_fragment>', `#include <opaque_fragment>\n${FRAG_FLASH}`);
  };
  material.customProgramCacheKey = () => CACHE_KEY;
  return { material, uniforms };
}

/** Static level geometry (KayKit dungeon atlas). */
export function createLevelMaterial(map: Texture): MeshLambertMaterial {
  return new MeshLambertMaterial({ map });
}
