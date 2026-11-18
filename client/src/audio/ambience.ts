/**
 * Ambience per biome, only while a chamber is on screen. Each biome is a "scene": continuous synthesised beds
 * (filtered noise, beating hums, slow LFOs), sample beds that are crossfade-looped with themselves (MP3 cannot
 * loop seamlessly, overlapping instances can) and sparse one-shots (drips, distant knocks, metal ticks).
 * Changing the biome crossfades two scenes. Scheduling is look-ahead based like the score, so a scene can also
 * be rendered offline.
 *
 *   crypt   – low drone, stale air, distant drips, now and then a far creak or knock
 *   flooded – water lapping, frequent drips, a hollow tunnel resonance
 *   forge   – deep rumble, fire roar, bellows-like breathing, sparse metal ticks and ember pops
 *   vault   – (update 4, a chamber without a fight, whatever its biome) still air, a warm hum on D and A,
 *             small glints of metal and now and then a coin settling
 */
import type { BiomeId } from '@shared/types.ts';
import { MIX, noise, tone, type AudioGraph } from './engine.ts';
import type { SampleGroup } from './manifest.ts';
import { VOICES, type Player } from './samples.ts';

const AMBIENCE = {
  FADE: 2,
  /** Sample beds are scheduled this far ahead. */
  LOOKAHEAD: 0.6,
  BED_FADE: 1.1,
  START_DELAY: 0.05,
} as const;

interface BedDef { group: SampleGroup; rate: number; gain: number; lpf: number }
interface EventDef { every: [number, number]; play(scene: Scene, t: number): void }
interface SceneDef {
  gain: number;
  beds: BedDef[];
  build(scene: Scene, t: number): void;
  events: EventDef[];
}

/** A biome, or the sealed vault that replaces the biome's ambience while the party is in one. */
export type SceneId = BiomeId | 'vault';

interface Scene {
  biome: SceneId;
  out: GainNode;
  sources: AudioScheduledSourceNode[];
  nextBed: number[];
  nextEvent: number[];
  /** Time at which the faded-out scene is dropped. */
  dieAt: number;
}

export type Ambience = ReturnType<typeof createAmbience>;

export function createAmbience(g: AudioGraph, player: Player) {
  const { ctx } = g;
  let scenes: Scene[] = [];
  let current: SceneId | null = null;

  // ---------------------------------------------------------------- building blocks
  const loopNoise = (scene: Scene, t: number, type: BiquadFilterType, freq: number, q: number, gain: number, poles = 1): { filter: BiquadFilterNode; amp: GainNode } => {
    const src = ctx.createBufferSource();
    src.buffer = g.noise;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    let node: AudioNode = src.connect(filter);
    for (let i = 0; i < poles; i++) {
      // the first pole is the one callers may modulate
      const pole = i === 0 ? filter : ctx.createBiquadFilter();
      pole.type = type;
      pole.frequency.value = freq;
      pole.Q.value = q;
      if (i > 0) node = node.connect(pole);
    }
    const amp = ctx.createGain();
    amp.gain.value = gain;
    node.connect(amp).connect(scene.out);
    g.track(src);
    src.start(t, Math.random() * (MIX.NOISE_SECONDS - 0.1));
    scene.sources.push(src);
    return { filter, amp };
  };
  const hum = (scene: Scene, t: number, freq: number, gain: number): void => {
    const osc = ctx.createOscillator();
    osc.frequency.value = freq;
    const amp = ctx.createGain();
    amp.gain.value = gain;
    osc.connect(amp).connect(scene.out);
    g.track(osc);
    osc.start(t);
    scene.sources.push(osc);
  };
  /** Slow sine LFO added to a parameter. */
  const lfo = (scene: Scene, t: number, hz: number, depth: number, target: AudioParam): void => {
    const osc = ctx.createOscillator();
    osc.frequency.value = hz;
    const amount = ctx.createGain();
    amount.gain.value = depth;
    osc.connect(amount).connect(target);
    g.track(osc);
    osc.start(t);
    scene.sources.push(osc);
  };
  const far = (scene: Scene, group: SampleGroup, t: number, gain: number, rate: number, lpf: number): void => {
    player.play(group, t, { gain, rate, lpf, send: 1, dest: scene.out, pool: 'ambience', pri: VOICES.PRI.AMBIENT, jitter: 0.12 });
  };
  const drip = (scene: Scene, t: number, gain: number, notes: number): void => {
    const pitch = 900 + Math.random() * 1100;
    for (let i = 0; i < notes; i++) {
      const f = pitch * (1 + i * 0.22);
      tone(g, scene.out, t + i * (0.13 + Math.random() * 0.08), { freq: f * 1.6, freqEnd: f, dur: 0.09, gain: gain / (1 + i), send: 0.85 });
    }
  };

  // ---------------------------------------------------------------- the three biomes
  const DEFS: Record<SceneId, SceneDef> = {
    crypt: {
      gain: 0.44,
      beds: [{ group: 'bed.drone', rate: 0.5, gain: 0.5, lpf: 260 }],
      build(scene, t) {
        loopNoise(scene, t, 'lowpass', 170, 0.5, 0.34, 2);
        hum(scene, t, 55, 0.035);
        hum(scene, t, 55.6, 0.035);
        const air = loopNoise(scene, t, 'bandpass', 420, 0.6, 0.03);
        lfo(scene, t, 0.07, 0.018, air.amp.gain);
        loopNoise(scene, t, 'bandpass', 1900, 0.5, 0.005); // a breath of stale air on small speakers
      },
      events: [
        { every: [2.5, 8], play: (scene, t) => drip(scene, t, 0.06, 2) },
        { every: [14, 34], play: (scene, t) => far(scene, Math.random() < 0.5 ? 'creak' : 'drum.low', t, 0.1, 0.55, 900) },
      ],
    },
    flooded: {
      gain: 0.8,
      beds: [{ group: 'bed.drone', rate: 0.42, gain: 0.3, lpf: 200 }],
      build(scene, t) {
        loopNoise(scene, t, 'lowpass', 140, 0.5, 0.2, 2);
        // water lapping: band noise whose level and colour drift on two unrelated slow LFOs
        const wash = loopNoise(scene, t, 'bandpass', 650, 0.8, 0.05);
        lfo(scene, t, 0.19, 0.03, wash.amp.gain);
        lfo(scene, t, 0.31, 0.018, wash.amp.gain);
        lfo(scene, t, 0.19, 260, wash.filter.frequency);
        const foam = loopNoise(scene, t, 'highpass', 2600, 0.5, 0.007);
        lfo(scene, t, 0.31, 0.006, foam.amp.gain);
        // hollow tunnel resonance on D and A
        const d = loopNoise(scene, t, 'bandpass', 146.8, 22, 0.07);
        lfo(scene, t, 0.05, 0.03, d.amp.gain);
        const a = loopNoise(scene, t, 'bandpass', 220, 26, 0.04);
        lfo(scene, t, 0.083, 0.02, a.amp.gain);
      },
      events: [
        { every: [0.8, 3.2], play: (scene, t) => drip(scene, t, 0.07, 1 + Math.floor(Math.random() * 3)) },
        { every: [9, 20], play: (scene, t) => far(scene, 'slime', t, 0.12, 0.7, 1800) },
        { every: [18, 40], play: (scene, t) => far(scene, 'creak', t, 0.07, 0.5, 700) },
      ],
    },
    forge: {
      gain: 0.53,
      beds: [
        { group: 'bed.rumble', rate: 1.2, gain: 0.4, lpf: 700 },
        { group: 'tex.fireLow', rate: 1, gain: 0.8, lpf: 2800 },
      ],
      build(scene, t) {
        hum(scene, t, 55, 0.03);
        hum(scene, t, 55.5, 0.03);
        loopNoise(scene, t, 'lowpass', 150, 0.5, 0.14, 2);
        // bellows: a slow breath in level and brightness
        const breath = loopNoise(scene, t, 'lowpass', 520, 0.7, 0.07);
        lfo(scene, t, 0.23, 0.06, breath.amp.gain);
        lfo(scene, t, 0.23, 340, breath.filter.frequency);
      },
      events: [
        {
          every: [3, 9],
          play(scene, t) {
            const group: SampleGroup = Math.random() < 0.6 ? 'hit.ring' : Math.random() < 0.6 ? 'hit.metal' : 'pot';
            const rate = 0.5 + Math.random() * 0.6;
            far(scene, group, t, 0.09, rate, 3500);
            if (Math.random() < 0.35) far(scene, group, t + 0.34, 0.06, rate, 3000); // hammer rebound
          },
        },
        { every: [0.4, 1.6], play: (scene, t) => noise(g, scene.out, t, { dur: 0.02, gain: 0.008 + Math.random() * 0.02, filter: 'highpass', freq: 2500 + Math.random() * 3000, send: 0.3 }) },
      ],
    },
    vault: {
      gain: 0.5,
      beds: [{ group: 'bed.drone', rate: 0.5, gain: 0.22, lpf: 220 }],
      build(scene, t) {
        // a closed room: very little air, and the walls humming an open fifth with a major third far above
        loopNoise(scene, t, 'lowpass', 150, 0.5, 0.16, 2);
        hum(scene, t, 73.42, 0.05);
        hum(scene, t, 73.9, 0.04);
        hum(scene, t, 110, 0.03);
        const third = loopNoise(scene, t, 'bandpass', 370, 30, 0.05);
        lfo(scene, t, 0.06, 0.03, third.amp.gain);
        const air = loopNoise(scene, t, 'bandpass', 2400, 0.7, 0.004);
        lfo(scene, t, 0.09, 0.002, air.amp.gain);
      },
      events: [
        // a glint: one or two high, soft notes of D major
        {
          every: [1.6, 5],
          play(scene, t) {
            const notes = [1174.7, 1480, 1760, 2349.3];
            const f = notes[Math.floor(Math.random() * notes.length)];
            tone(g, scene.out, t, { freq: f, dur: 0.9, gain: 0.018, send: 0.9 });
            if (Math.random() < 0.4) tone(g, scene.out, t + 0.18, { freq: f * 1.5, dur: 0.7, gain: 0.012, send: 0.9 });
          },
        },
        { every: [6, 14], play: (scene, t) => far(scene, 'ui.coins', t, 0.1, 0.85 + Math.random() * 0.3, 5000) },
        { every: [11, 24], play: (scene, t) => far(scene, Math.random() < 0.5 ? 'pouch' : 'ping', t, 0.06, 0.8, 4000) },
      ],
    },
  };

  const between = ([min, max]: [number, number]): number => min + Math.random() * (max - min);

  const fadeOut = (now: number): void => {
    for (const scene of scenes) {
      if (scene.dieAt !== Infinity) continue;
      scene.out.gain.cancelScheduledValues(now);
      scene.out.gain.setValueAtTime(scene.out.gain.value, now);
      scene.out.gain.linearRampToValueAtTime(MIX.SILENCE, now + AMBIENCE.FADE);
      scene.dieAt = now + AMBIENCE.FADE + 0.1;
      for (const src of scene.sources) src.stop(scene.dieAt);
    }
  };

  /** Crossfades to the ambience of a biome (or of the vault); null fades everything out. */
  const setBiome = (biome: SceneId | null): void => {
    if (biome === current) return;
    current = biome;
    const now = ctx.currentTime;
    fadeOut(now);
    if (!biome) return;
    const def = DEFS[biome];
    const out = ctx.createGain();
    out.gain.setValueAtTime(MIX.SILENCE, now);
    out.gain.linearRampToValueAtTime(def.gain, now + AMBIENCE.FADE);
    out.connect(g.buses.ambience);
    const t = now + AMBIENCE.START_DELAY;
    const scene: Scene = {
      biome, out, sources: [], dieAt: Infinity,
      nextBed: def.beds.map(() => t),
      nextEvent: def.events.map((e) => t + between(e.every) * 0.5),
    };
    def.build(scene, t);
    scenes.push(scene);
  };

  /** Schedules beds and sparse events up to `until` (defaults to now + look-ahead). Call it regularly. */
  const schedule = (until: number = ctx.currentTime + AMBIENCE.LOOKAHEAD): void => {
    const now = ctx.currentTime;
    scenes = scenes.filter((scene) => {
      if (now <= scene.dieAt) return true;
      scene.out.disconnect();
      return false;
    });
    for (const scene of scenes) {
      if (scene.dieAt !== Infinity) continue;
      const def = DEFS[scene.biome];
      def.beds.forEach((bed, i) => {
        while (scene.nextBed[i] < until) {
          const start = Math.max(scene.nextBed[i], now);
          const ok = player.play(bed.group, start, {
            gain: bed.gain, rate: bed.rate, lpf: bed.lpf, attack: AMBIENCE.BED_FADE, release: AMBIENCE.BED_FADE, jitter: 0.02,
            dur: Math.max(0.1, bedSeconds(bed) - AMBIENCE.BED_FADE - 0.05), dest: scene.out, pool: 'ambience', pri: VOICES.PRI.AMBIENT,
          });
          // not decoded yet: look again in a moment (the synthesised layers carry the scene meanwhile)
          scene.nextBed[i] = start + (ok ? Math.max(0.5, bedSeconds(bed) - AMBIENCE.BED_FADE) : 1);
        }
      });
      def.events.forEach((event, i) => {
        while (scene.nextEvent[i] < until) {
          if (scene.nextEvent[i] >= now) event.play(scene, scene.nextEvent[i]);
          scene.nextEvent[i] += between(event.every);
        }
      });
    }
  };

  const bedSeconds = (bed: BedDef): number => (player.duration(bed.group) || 3) / bed.rate;

  return { setBiome, schedule, biome: (): SceneId | null => current, active: (): boolean => current !== null, sceneCount: (): number => scenes.length };
}
