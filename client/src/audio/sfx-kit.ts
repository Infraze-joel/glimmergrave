/**
 * What the sound-effect modules share: limiter families, tuned constants and the `SfxKit` — the set of mixing
 * helpers that sfx.ts builds once and hands to sfx-abilities.ts and sfx-progress.ts, so every sound goes through
 * the same buses, voice limits and anti-spam windows.
 */
import type { ElementId } from '@shared/types.ts';
import { semitones, type AudioGraph, type BusName, type NoiseOpts, type ToneOpts } from './engine.ts';
import type { SampleGroup } from './manifest.ts';
import type { Player, VoiceOpts } from './samples.ts';

/** [max sounds, window seconds] per sound family. */
export const LIMITS = {
  hit: [4, 0.05],
  tick: [2, 0.08],
  element: [3, 0.06],
  crit: [2, 0.08],
  kill: [3, 0.08],
  spawn: [3, 0.12],
  telegraph: [1, 0.12],
  aoe: [2, 0.1],
  resonance: [2, 0.12],
  cast: [4, 0.07],
  enemyCast: [2, 0.12],
  cue: [1, 0.3],
  hurt: [2, 0.1],
  heal: [1, 0.2],
  shield: [2, 0.12],
  status: [2, 0.1],
  hazard: [2, 0.12],
  ui: [3, 0.04],
  hover: [1, 0.045],
  big: [1, 0.25],
  // update 3
  /** Four heroes may fire their ultimates in the same moment; each one after the first is ducked. */
  ult: [4, 0.3],
  zone: [3, 0.15],
  zoneEnd: [2, 0.12],
  buff: [2, 0.25],
  mark: [3, 0.1],
  ready: [1, 0.4],
  affix: [1, 0.35],
  progress: [1, 0.12],
  set: [1, 0.5],
  // update 4
  /** Spawn signatures of the five new kinds: a pack arriving together is told by its first two. */
  voice: [2, 0.2],
  mend: [2, 0.25],
  dome: [2, 0.2],
  /** Bombers are warnings: three fuses may start together, each later one ducked, a fourth is one too many to count anyway. */
  fuse: [3, 0.15],
  burst: [3, 0.12],
  raise: [1, 0.4],
  leap: [2, 0.2],
  ward: [1, 0.16],
  objective: [1, 0.3],
  site: [1, 0.2],
  /** The server sends at most one shard hit per second; the alarm never repeats faster than this. */
  anchor: [1, 0.8],
  timer: [2, 0.2],
  // update 5
  /** The own hero's keystone moment; allies' picks may come together after an elite chamber. */
  keystone: [1, 0.5],
  ksAlly: [2, 0.3],
  ksDraft: [1, 0.5],
  /** Keystone signatures: four heroes with two keystones each must not add up to a wall. */
  ksProc: [3, 0.1],
  /** Chained procs (bounces, arcs, corpse blooms, blade cuts, stream pulses). */
  ksChain: [3, 0.1],
  ksLayer: [2, 0.07],
  ksCost: [2, 0.15],
} as const;

export type Family = keyof typeof LIMITS;

/** D minor colours shared with the music so effects sit in the same key. */
export const NOTE = {
  D2: 38, A2: 45, D3: 50, F3: 53, A3: 57, D4: 62, E4: 64, F4: 65, Fs4: 66, G4: 67, A4: 69, B4: 71, D5: 74, E5: 76, F5: 77, Fs5: 78,
  A5: 81, D6: 86, E6: 88, F6: 89, Fs6: 90, A6: 93,
  C4: 60, C5: 72, Bb3: 58, Bb4: 70, Cs5: 73, G5: 79, Eb3: 51, Gs4: 68, G3: 55, C6: 84,
} as const;

/** Playback rates that land tuned samples on D. bell.1 hums at 380 Hz, bell.2 at 240 Hz (measured). */
export const TUNED = {
  BELL1_D4: 293.66 / 380,
  BELL2_D3: 146.83 / 240,
  /** jingle.rise ends on G: a fourth down resolves it to D. */
  RISE_TO_D: semitones(-5),
  /** jingle.fifth is Eb-Bb: a semitone down makes it D-A. */
  FIFTH_TO_D: semitones(-1),
  /** jingle.magic climbs a whole-tone scale from C: start it on D. */
  MAGIC_TO_D: semitones(2),
  /** jingle.fall ends on D; an octave down turns it into a slow, dark descent. */
  FALL_DARK: 0.5,
  /** ping.2 rings at 1976 Hz (B6); this lands it on D7, a glitter above the boon jingle. */
  PING_TO_D7: 2349.3 / 1976,
} as const;

export type Layer = (group: SampleGroup, t: number, gain: number, o?: Omit<VoiceOpts, 'gain'>) => void;

/** One sounding event: a mix node on a bus with its reverb send, and a sample-layer function bound to both. */
export interface Mix {
  V: Layer;
  out: GainNode;
  /** Fades the whole event (dry and reverb send) to silence from `t` with time constant `tc`. */
  fade(t: number, tc: number): void;
}

export interface SfxKit {
  g: AudioGraph;
  player: Player;
  now(): number;
  /** Number of same-family sounds already in the limiter window, or -1 when the sound must be dropped. */
  take(family: Family, t: number): number;
  duck(stack: number): number;
  jitter(spread: number): number;
  mix(bus: BusName | 'ui', pri: number, level: number): Mix;
  uiMix(level: number): Mix;
  bigMix(level: number): Mix;
  worldMix(level: number): Mix;
  /** Mix for something a hero does: the own hero is louder, on its own bus and wins voice stealing. */
  who(own: boolean, level: number): Mix & { pri: number };
  tone(out: AudioNode, t: number, o: ToneOpts): void;
  noise(out: AudioNode, t: number, o: NoiseOpts): void;
  whoosh(out: AudioNode, t: number, from: number, peak: number, to: number, dur: number, gain: number): void;
  thump(out: AudioNode, t: number, freq: number, dur: number, gain: number): void;
  /** Element colour: size 0 = status tick, 1 = hit, 2 = burst. */
  element(el: ElementId, t: number, level: number, size: 0 | 1 | 2, pri: number): void;
  clatter(V: Layer, t: number, count: number, span: number, gain: number): void;
}

export const rnd = (a: number, b: number): number => a + Math.random() * (b - a);
