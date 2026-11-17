/**
 * Sample bank + voice player.
 *
 * The bank loads the files listed in manifest.ts tier by tier (interface first, then core combat, ...), decodes
 * them into AudioBuffers and never throws: a file that fails to load is simply absent, and callers fall back to
 * synthesis (`has()` tells them). AudioBuffers are not tied to a context, so one bank can feed the live context
 * and OfflineAudioContext renders alike.
 *
 * The player turns a buffer into a voice: round-robin variant, random pitch / gain, optional filters, reverb
 * send, per-pool voice limits with priority stealing.
 */
import { panned, type AudioGraph, type BusName } from './engine.ts';
import { AUDIO_BASE, AUDIO_TIERS, AUDIO_TOTAL_BYTES, SAMPLES, type SampleGroup, type SampleInfo } from './manifest.ts';
import { assetUrl } from '../core/assetVersion.ts';

const LOAD = {
  CONCURRENCY: 6,
  /** MP3 decoders may leave encoder delay at the start; playback skips to the first sample above this level. */
  LEAD_THRESHOLD: 0.004,
  LEAD_MAX_S: 0.08,
  LEAD_PRE_S: 0.0005,
} as const;

export const VOICES = {
  /** Default random pitch spread (±) and gain spread (±) per voice. */
  PITCH_JITTER: 0.06,
  GAIN_JITTER: 0.12,
  STEAL_FADE: 0.012,
  RELEASE: 0.03,
  MIN_RATE: 0.25,
  MAX_RATE: 4,
  /** Simultaneous sample voices per pool. */
  LIMITS: { own: 20, combat: 18, element: 14, big: 14, ambience: 8, ui: 6, music: 18 },
  /** Pre-scheduled texture voices (`free`) of one zone bed; more than this are simply not scheduled. */
  FREE_MAX: 160,
  /** Priorities: danger cues and the own hero win over the party, the party over ambience. */
  PRI: { AMBIENT: 0, WORLD: 1, PARTY: 2, OWN: 3 },
} as const;

export type Pool = keyof typeof VOICES.LIMITS;

export interface Loaded {
  info: SampleInfo;
  buffer: AudioBuffer;
  /** Seconds to skip at the start (codec delay). */
  lead: number;
  reversed: AudioBuffer | null;
}

export interface BankStats {
  total: number;
  loaded: number;
  failed: number;
  /** Bytes fetched so far / in total. */
  bytes: number;
  totalBytes: number;
  /** Bytes that had been fetched when the first sample became playable (0 = none yet). */
  firstReadyBytes: number;
  /** Tiers that are completely loaded (0..AUDIO_TIERS). */
  tiersDone: number;
  done: boolean;
  failedFiles: string[];
}

export interface LoadOptions {
  base?: string;
  /** Called after every tier. */
  onTier?: (stats: BankStats) => void;
}

export type Bank = ReturnType<typeof createBank>;

function decode(ctx: BaseAudioContext, data: ArrayBuffer): Promise<AudioBuffer> {
  // Callback form + promise form: old Safari only knows the former.
  return new Promise((resolve, reject) => {
    const maybe = ctx.decodeAudioData(data, resolve, reject) as Promise<AudioBuffer> | undefined;
    if (maybe && typeof maybe.then === 'function') maybe.then(resolve, reject);
  });
}

function leadOf(buffer: AudioBuffer): number {
  const data = buffer.getChannelData(0);
  const max = Math.min(data.length, Math.floor(LOAD.LEAD_MAX_S * buffer.sampleRate));
  for (let i = 0; i < max; i++) {
    if (Math.abs(data[i]) > LOAD.LEAD_THRESHOLD) return Math.max(0, i / buffer.sampleRate - LOAD.LEAD_PRE_S);
  }
  return 0;
}

export function createBank(ctx: BaseAudioContext) {
  const groups = new Map<string, Loaded[]>();
  const cursor = new Map<string, number>();
  const stats: BankStats = {
    total: SAMPLES.length, loaded: 0, failed: 0, bytes: 0, totalBytes: AUDIO_TOTAL_BYTES, firstReadyBytes: 0,
    tiersDone: 0, done: false, failedFiles: [],
  };
  let loading: Promise<BankStats> | null = null;

  const loadOne = async (info: SampleInfo, base: string): Promise<void> => {
    try {
      const response = await fetch(assetUrl(base + info.file));
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.arrayBuffer();
      stats.bytes += data.byteLength;
      const buffer = await decode(ctx, data);
      let list = groups.get(info.group);
      if (!list) { list = []; groups.set(info.group, list); }
      list.push({ info, buffer, lead: leadOf(buffer), reversed: null });
      stats.loaded++;
      if (stats.firstReadyBytes === 0) stats.firstReadyBytes = stats.bytes;
    } catch {
      stats.failed++;
      stats.failedFiles.push(info.file);
    }
  };

  const run = async (opts: LoadOptions): Promise<BankStats> => {
    const base = opts.base ?? AUDIO_BASE;
    for (let tier = 0; tier < AUDIO_TIERS; tier++) {
      const queue: SampleInfo[] = SAMPLES.filter((s) => s.tier === tier);
      const worker = async (): Promise<void> => {
        for (let next = queue.shift(); next; next = queue.shift()) await loadOne(next, base);
      };
      await Promise.all(Array.from({ length: LOAD.CONCURRENCY }, worker));
      stats.tiersDone = tier + 1;
      opts.onTier?.(stats);
    }
    stats.done = true;
    if (stats.failed > 0) console.warn(`[audio] ${stats.failed} of ${stats.total} samples unavailable; synthesis covers them`);
    return stats;
  };

  return {
    /** Starts loading (once). Resolves when every tier was attempted; never rejects. */
    load(opts: LoadOptions = {}): Promise<BankStats> {
      loading ??= run(opts).catch(() => stats);
      return loading;
    },
    /** True when at least one variant of every given group is decoded. */
    has(...names: SampleGroup[]): boolean {
      for (const name of names) if (!groups.has(name)) return false;
      return true;
    },
    /** Next variant of a group (round robin with a random skip so patterns do not repeat), or null. */
    pick(name: SampleGroup, variant?: number): Loaded | null {
      const list = groups.get(name);
      if (!list || list.length === 0) return null;
      if (variant !== undefined) return list.find((l) => l.info.name === `${name}.${variant}`) ?? list[0];
      const skip = list.length > 2 && Math.random() < 0.5 ? 2 : 1;
      const index = ((cursor.get(name) ?? Math.floor(Math.random() * list.length)) + skip) % list.length;
      cursor.set(name, index);
      return list[index];
    },
    /** Seconds of the first variant of a group (0 when it is not loaded). */
    duration(name: SampleGroup): number {
      const first = groups.get(name)?.[0];
      return first ? first.buffer.duration - first.lead : 0;
    },
    /** Time-reversed copy (cached) for swells and charge-ups. */
    reversed(sample: Loaded): AudioBuffer {
      if (!sample.reversed) {
        const src = sample.buffer;
        const copy = ctx.createBuffer(src.numberOfChannels, src.length, src.sampleRate);
        for (let ch = 0; ch < src.numberOfChannels; ch++) {
          const from = src.getChannelData(ch);
          const to = copy.getChannelData(ch);
          for (let i = 0, n = from.length; i < n; i++) to[i] = from[n - 1 - i];
        }
        sample.reversed = copy;
      }
      return sample.reversed;
    },
    stats: (): BankStats => stats,
  };
}

// ------------------------------------------------------------------ voices

export interface VoiceOpts {
  gain: number;
  /** Delay after the stack's start time (s). */
  at?: number;
  /** Playback-rate multiplier (pitch). */
  rate?: number;
  /** Stretch the whole sample to last this many seconds (replaces `rate`; for reversed swells). */
  fit?: number;
  /** Random pitch spread (±), default VOICES.PITCH_JITTER. 0 for tuned material. */
  jitter?: number;
  gainJitter?: number;
  lpf?: number;
  lpfEnd?: number;
  hpf?: number;
  /** 0..1 amount sent to the reverb. */
  send?: number;
  attack?: number;
  /** Cut the voice after this many seconds (then `release`). */
  dur?: number;
  release?: number;
  reverse?: boolean;
  /** Start position in the file (s); -1 = random (textures). */
  offset?: number;
  /** Fixed variant number (1-based) instead of round robin. */
  variant?: number;
  /** Stereo position -1..1 (0 = centre). */
  pan?: number;
  bus?: BusName | 'ui';
  pri?: number;
  /** Custom destination + reverb (music tracks, ambience scenes); such voices live in `pool` (default music). */
  dest?: AudioNode;
  reverb?: AudioNode;
  pool?: Pool;
  /**
   * Outside the voice pools: for textures that are scheduled ahead as a whole (zone beds). Pool limits look at
   * what is scheduled, not at what sounds, so such voices would evict each other; the caller keeps them few and short.
   */
  free?: boolean;
}

interface Voice { end: number; pri: number; amp: GainNode; src: AudioBufferSourceNode }

export type Player = ReturnType<typeof createPlayer>;

export function createPlayer(g: AudioGraph, bank: Bank) {
  const { ctx } = g;
  const pools = new Map<Pool, Voice[]>();
  let dropped = 0;
  let stolen = 0;
  let freeLive = 0;

  /** Makes room in a pool. Returns false when the new voice loses against everything that is playing. */
  const admit = (pool: Pool, pri: number, now: number): boolean => {
    let list = pools.get(pool);
    if (!list) { list = []; pools.set(pool, list); }
    for (let i = list.length - 1; i >= 0; i--) if (list[i].end <= now) list.splice(i, 1);
    if (list.length < VOICES.LIMITS[pool]) return true;
    let victim = 0;
    for (let i = 1; i < list.length; i++) {
      if (list[i].pri < list[victim].pri || (list[i].pri === list[victim].pri && list[i].end < list[victim].end)) victim = i;
    }
    if (list[victim].pri > pri) { dropped++; return false; }
    const old = list[victim];
    list.splice(victim, 1);
    stolen++;
    try {
      old.amp.gain.cancelScheduledValues(now);
      old.amp.gain.setTargetAtTime(0, now, VOICES.STEAL_FADE / 3);
      old.src.stop(now + VOICES.STEAL_FADE * 2);
    } catch { /* already stopped */ }
    return true;
  };

  /** Plays one variant of `group` at time `t`. Returns false when it is not loaded or lost to the voice limit. */
  const play = (group: SampleGroup, t: number, o: VoiceOpts): boolean => {
    const sample = bank.pick(group, o.variant);
    if (!sample) return false;
    const pool: Pool = o.pool ?? (o.dest ? 'music' : o.bus ?? 'combat');
    const pri = o.pri ?? VOICES.PRI.WORLD;
    const now = ctx.currentTime;
    if (o.free) { if (freeLive >= VOICES.FREE_MAX) return false; } else if (!admit(pool, pri, now)) return false;

    const start = t + (o.at ?? 0);
    const buffer = o.reverse ? bank.reversed(sample) : sample.buffer;
    const usable = buffer.duration - sample.lead;
    const jitter = o.fit !== undefined ? 0 : o.jitter ?? VOICES.PITCH_JITTER;
    const wanted = o.fit !== undefined ? usable / Math.max(0.01, o.fit) : o.rate ?? 1;
    const rate = Math.min(VOICES.MAX_RATE, Math.max(VOICES.MIN_RATE, wanted * (1 + (Math.random() * 2 - 1) * jitter)));
    const gainJitter = o.gainJitter ?? VOICES.GAIN_JITTER;
    const gain = Math.max(0, o.gain * sample.info.gain * (1 + (Math.random() * 2 - 1) * gainJitter));
    let offset = o.reverse ? 0 : sample.lead;
    if (o.offset !== undefined) {
      const span = Math.max(0, usable - (o.dur ?? 0) * rate - 0.05);
      offset += o.offset < 0 ? Math.random() * span : Math.min(o.offset, span);
    }
    const natural = (buffer.duration - offset - (o.reverse ? sample.lead : 0)) / rate;
    const release = o.release ?? VOICES.RELEASE;
    const length = o.dur !== undefined ? Math.min(natural, o.dur + release) : natural;

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    let node: AudioNode = src;
    if (o.hpf !== undefined) {
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = o.hpf;
      node = node.connect(hp);
    }
    if (o.lpf !== undefined) {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(o.lpf, start);
      if (o.lpfEnd !== undefined) lp.frequency.exponentialRampToValueAtTime(o.lpfEnd, start + length);
      node = node.connect(lp);
    }
    const amp = ctx.createGain();
    if (o.attack !== undefined && o.attack > 0) {
      amp.gain.setValueAtTime(0, start);
      amp.gain.linearRampToValueAtTime(gain, start + Math.min(o.attack, length));
    } else {
      amp.gain.setValueAtTime(gain, start);
    }
    if (o.dur !== undefined && o.dur + release <= natural) {
      amp.gain.setValueAtTime(gain, start + Math.max(o.dur, o.attack ?? 0));
      amp.gain.linearRampToValueAtTime(0, start + length);
    }
    node.connect(amp);
    panned(ctx, amp, o.pan).connect(o.dest ?? (o.bus === 'ui' ? g.ui : g.buses[o.bus ?? 'combat']));
    if (o.send !== undefined && o.send > 0 && o.bus !== 'ui') {
      const tap = ctx.createGain();
      tap.gain.value = o.send;
      amp.connect(tap).connect(o.reverb ?? g.reverbIn);
    }
    g.track(src);
    src.start(start, offset);
    src.stop(start + length + 0.01);
    if (o.free) {
      freeLive++;
      src.addEventListener('ended', () => { freeLive--; }, { once: true });
    } else {
      pools.get(pool)?.push({ end: start + length, pri, amp, src });
    }
    return true;
  };

  return {
    play,
    has: bank.has,
    duration: bank.duration,
    /** Sample voices currently sounding per pool, plus how many were refused or cut short since start. */
    stats(): { active: number; dropped: number; stolen: number } {
      const now = ctx.currentTime;
      let active = 0;
      for (const list of pools.values()) for (const v of list) if (v.end > now) active++;
      return { active, dropped, stolen };
    },
  };
}
