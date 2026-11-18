/**
 * Effect clarity (Settings.effects, polish 1 second pass). One shared set of factors every part of the render kit
 * reads; WorldView.setClarity() is the only writer.
 *   full     everything, as before the second pass
 *   clear    (default) other heroes' effects are thin outlines with a brief soft flash, the own hero's keep their look
 *            with about half the fill and particles, enemy-side glow is capped, no bloom from friendly light
 *   minimal  like clear, without ambient particles and reaction words, allies' effects outlines only
 */
import type { EffectsLevel } from '../core/Settings.ts';

interface Profile {
  /** Other heroes' effects are reduced to outlines (no fills, no particles, no lingering layers). */
  outlines: boolean;
  /** Brightness of the one soft flash an ally's burst keeps (0 = none). */
  allyFlash: number;
  /** Own hero: share of particles and of fill opacity relative to `full`. */
  ownCount: number;
  ownFill: number;
  ownLight: number;
  /** Reaction word marks for the own hero's / other heroes' bursts. */
  ownWords: boolean;
  allyWords: boolean;
  /** Own words on screen at once, and their size. */
  wordMax: number;
  wordSize: number;
  /** Damage numbers: size factor, own numbers at once, whether allies' numbers show without the setting. */
  numberSize: number;
  numberMax: number;
  allyNumbers: boolean;
  /** Additive light hung on enemies (auras, pools, wisps) and the status / ward rim on their bodies. */
  enemyGlow: number;
  enemyRim: number;
  /** Status / trait icons shown per enemy before the rest collapses into "+n". */
  pipMax: number;
  pipSize: number;
  /** Ward shards and shell glow around a warded enemy. */
  wardShell: boolean;
  /** Fill of the aegis dome's shell. */
  dome: number;
  /** Ambient dust, embers, mist. */
  ambient: number;
  /** Brightness budget of the glare governor and the cap on a single additive quad's output (0 = uncapped). */
  glare: number;
  quadCap: number;
  bloom: number;
  /** Extra marker on the own hero. */
  selfMarker: boolean;
}

const PROFILES: Record<EffectsLevel, Profile> = {
  full: {
    outlines: false, allyFlash: 1, ownCount: 1, ownFill: 1, ownLight: 1, ownWords: true, allyWords: true, wordMax: 6, wordSize: 1, numberSize: 1, numberMax: 12, allyNumbers: true,
    enemyGlow: 1, enemyRim: 1, pipMax: 8, pipSize: 1, wardShell: true, dome: 1, ambient: 1, glare: 1.1, quadCap: 0, bloom: 1, selfMarker: false,
  },
  clear: {
    outlines: true, allyFlash: 0.3, ownCount: 0.5, ownFill: 0.5, ownLight: 0.75, ownWords: true, allyWords: false, wordMax: 2, wordSize: 0.8, numberSize: 0.6, numberMax: 6, allyNumbers: false,
    enemyGlow: 0.3, enemyRim: 0.35, pipMax: 2, pipSize: 0.8, wardShell: false, dome: 0.12, ambient: 0.6, glare: 0.55, quadCap: 0.9, bloom: 0.45, selfMarker: true,
  },
  minimal: {
    outlines: true, allyFlash: 0, ownCount: 0.3, ownFill: 0.4, ownLight: 0.65, ownWords: false, allyWords: false, wordMax: 0, wordSize: 0.8, numberSize: 0.5, numberMax: 5, allyNumbers: false,
    enemyGlow: 0.2, enemyRim: 0.3, pipMax: 2, pipSize: 0.75, wardShell: false, dome: 0.08, ambient: 0, glare: 0.45, quadCap: 0.8, bloom: 0.3, selfMarker: true,
  },
};

/** The active factors. Read-only for everyone but setClarityLevel. */
export const CL: Profile & { level: EffectsLevel } = { level: 'clear', ...PROFILES.clear };

export function setClarityLevel(level: EffectsLevel, allyNumbers: boolean): void {
  const p = PROFILES[level] ?? PROFILES.clear;
  Object.assign(CL, p);
  CL.level = level in PROFILES ? level : 'clear';
  // the setting adds allies' numbers on the quiet levels; `full` always shows them
  CL.allyNumbers = p.allyNumbers || allyNumbers;
}
