/**
 * Audio graph + synth primitives. Works on any BaseAudioContext so passages can also be rendered with an
 * OfflineAudioContext (see offline.ts).
 *
 *   ui (dry) ───────────────────────────────────────────────┐
 *   own / combat / element / big ─> burst compressor ─┐      │
 *   ambience ─────────────────────────────────────────┼─> hurt low-pass ─> sfx (user volume) ─┐
 *   reverbIn ─> room | hall convolver ────────────────┘                                        │
 *   music tracks ─> musicIn (ducking) ─> hurt low-pass ─> music (user volume) ─────────────────┼─> master
 *   musicReverbIn ─> convolver ─> musicIn                                                      │   (user volume)
 *   master ─> DC blocker ─> compressor ─> limiter ─> soft clip ─> output trim ─> destination (+ analyser, dev meter)
 */

export const MIX = {
  /** Internal trims so that user volumes of 1.0 still leave headroom. */
  MUSIC_TRIM: 0.6,
  SFX_TRIM: 0.85,
  NOISE_SECONDS: 2,
  OUTPUT_TRIM: 0.8,
  COMP: { threshold: -15, knee: 12, ratio: 3, attack: 0.004, release: 0.2 },
  LIMIT: { threshold: -4, knee: 0, ratio: 20, attack: 0.001, release: 0.09 },
  /**
   * Holds dense combat (dozens of hits in one frame) together before it reaches the master chain. The threshold
   * sits above a single ordinary hit, so lone transients keep their punch and only stacks are squeezed.
   */
  BURST: { threshold: -12, knee: 6, ratio: 6, attack: 0.002, release: 0.14 },
  /** Make-up gain a DynamicsCompressorNode adds on its own with the BURST settings (measured); taken out again. */
  BURST_MAKEUP_DB: 4.81,
  SOFT_CLIP_DRIVE: 1.5,
  SOFT_CLIP_CEILING: 0.97,
  SOFT_CLIP_SAMPLES: 2048,
  /** Time constant for volume changes (s). */
  SMOOTH: 0.04,
  SILENCE: 0.0001,
  /** Mixing trim per game bus (the own hero and danger cues sit on top, ambience underneath). */
  BUS: { own: 1, combat: 0.8, element: 0.9, big: 1, ambience: 0.55 },
  UI_TRIM: 0.8,
  /** Open cutoff of the hurt low-pass (effectively bypassed). */
  OPEN_HZ: 20000,
  METER_FFT: 2048,
  DC_BLOCK_HZ: 20,
} as const;

/**
 * Synthetic spaces. `hall` replaces `room` in boss chambers; `music` gives the score its own tail.
 * Return gains are calibrated by measurement (ConvolverNode normalisation makes these responses quiet): a
 * sound sent at 1.0 comes back about 2 dB under its dry level in the room, 1 dB over it in the hall and 4 dB
 * under it for the score.
 */
const SPACES = {
  room: { seconds: 1.5, decay: 3.4, predelay: 0.012, damp: 0.72, gain: 1.9 },
  hall: { seconds: 3.2, decay: 2.6, predelay: 0.028, damp: 0.8, gain: 1.85 },
  music: { seconds: 2.4, decay: 3.2, predelay: 0.02, damp: 0.7, gain: 1.2 },
} as const;

const SPACE_FADE = 1.2;
const EARLY_REFLECTIONS = 7;
const EARLY_WINDOW = 0.07;

export type BusName = keyof typeof MIX.BUS;
export type SpaceName = 'room' | 'hall';

export interface AudioGraph {
  ctx: BaseAudioContext;
  master: GainNode;
  /** User music volume. Tracks connect to `musicIn`, never here. */
  music: GainNode;
  /** User effects volume. Voices connect to a bus or to `ui`, never here. */
  sfx: GainNode;
  musicIn: GainNode;
  ui: GainNode;
  buses: Record<BusName, GainNode>;
  /** Input of the shared reverb send for game sounds. */
  reverbIn: GainNode;
  musicReverbIn: GainNode;
  noise: AudioBuffer;
  /** Source nodes that were started and have not ended yet (leak check). */
  live: { count: number; started: number };
  /** Registers a source so `live` stays truthful. Call before start(). */
  track(node: AudioScheduledSourceNode): void;
  setSpace(space: SpaceName): void;
  space(): SpaceName;
  /** Briefly lowers the score: `to` is the linear floor, then it recovers after `hold`. */
  duckMusic(to: number, hold: number, release: number): void;
  /** Briefly low-passes game sound and music (the hero took a blow). */
  muffle(hz: number, hold: number, release: number): void;
  /** Peak of the last analyser window after the master chain (0..1), or 0 without an analyser. */
  meter(): number;
}

function makeNoise(ctx: BaseAudioContext): AudioBuffer {
  const length = Math.floor(ctx.sampleRate * MIX.NOISE_SECONDS);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

/** Synthetic stone-room impulse response: a few early reflections, then decaying, progressively darker noise. */
function makeImpulse(ctx: BaseAudioContext, space: (typeof SPACES)[keyof typeof SPACES]): AudioBuffer {
  const rate = ctx.sampleRate;
  const length = Math.floor(rate * space.seconds);
  const pre = Math.floor(rate * space.predelay);
  const buffer = ctx.createBuffer(2, length, rate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    let smooth = 0;
    for (let i = pre; i < length; i++) {
      const p = (i - pre) / (length - pre);
      const white = Math.random() * 2 - 1;
      const damp = 0.2 + space.damp * p; // more smoothing towards the tail = darker
      smooth = smooth * damp + white * (1 - damp);
      data[i] = smooth * Math.pow(1 - p, space.decay);
    }
    for (let k = 0; k < EARLY_REFLECTIONS; k++) {
      const at = pre + Math.floor(Math.random() * EARLY_WINDOW * rate);
      if (at < length) data[at] += (Math.random() < 0.5 ? -1 : 1) * (0.7 - (0.5 * k) / EARLY_REFLECTIONS);
    }
  }
  return buffer;
}

function softClipCurve(): Float32Array<ArrayBuffer> {
  const n = MIX.SOFT_CLIP_SAMPLES;
  const curve = new Float32Array(new ArrayBuffer(n * Float32Array.BYTES_PER_ELEMENT));
  const norm = Math.tanh(MIX.SOFT_CLIP_DRIVE);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = (Math.tanh(x * MIX.SOFT_CLIP_DRIVE) / norm) * MIX.SOFT_CLIP_CEILING;
  }
  return curve;
}

interface DynamicsConfig { threshold: number; knee: number; ratio: number; attack: number; release: number }

function dynamics(ctx: BaseAudioContext, cfg: DynamicsConfig): DynamicsCompressorNode {
  const node = ctx.createDynamicsCompressor();
  node.threshold.value = cfg.threshold;
  node.knee.value = cfg.knee;
  node.ratio.value = cfg.ratio;
  node.attack.value = cfg.attack;
  node.release.value = cfg.release;
  return node;
}

function lowpass(ctx: BaseAudioContext): BiquadFilterNode {
  const node = ctx.createBiquadFilter();
  node.type = 'lowpass';
  node.frequency.value = MIX.OPEN_HZ;
  node.Q.value = 0.5;
  return node;
}

function gainNode(ctx: BaseAudioContext, value: number): GainNode {
  const node = ctx.createGain();
  node.gain.value = value;
  return node;
}

export function createGraph(ctx: BaseAudioContext): AudioGraph {
  const master = ctx.createGain();
  const music = ctx.createGain();
  const sfx = ctx.createGain();
  const musicIn = ctx.createGain();
  const ui = gainNode(ctx, MIX.UI_TRIM);
  const gameMix = ctx.createGain();
  const burst = dynamics(ctx, MIX.BURST);
  const sfxLpf = lowpass(ctx);
  const musicLpf = lowpass(ctx);
  const comp = dynamics(ctx, MIX.COMP);
  const limit = dynamics(ctx, MIX.LIMIT);
  const clip = ctx.createWaveShaper();
  const out = gainNode(ctx, MIX.OUTPUT_TRIM);

  const buses = {} as Record<BusName, GainNode>;
  for (const name of Object.keys(MIX.BUS) as BusName[]) {
    buses[name] = gainNode(ctx, MIX.BUS[name]);
    buses[name].connect(name === 'ambience' ? gameMix : burst);
  }
  burst.connect(gainNode(ctx, Math.pow(10, -MIX.BURST_MAKEUP_DB / 20))).connect(gameMix);

  // Game reverb: two spaces fed by one send, crossfaded with the chamber kind.
  const reverbIn = ctx.createGain();
  const returns = {} as Record<SpaceName, GainNode>;
  for (const name of ['room', 'hall'] as const) {
    const convolver = ctx.createConvolver();
    convolver.buffer = makeImpulse(ctx, SPACES[name]);
    returns[name] = gainNode(ctx, name === 'room' ? SPACES.room.gain : 0);
    reverbIn.connect(convolver).connect(returns[name]).connect(gameMix);
  }
  const musicReverbIn = ctx.createGain();
  const musicConvolver = ctx.createConvolver();
  musicConvolver.buffer = makeImpulse(ctx, SPACES.music);
  musicReverbIn.connect(musicConvolver).connect(gainNode(ctx, SPACES.music.gain)).connect(musicIn);

  clip.curve = softClipCurve();
  clip.oversample = '2x';

  gameMix.connect(sfxLpf).connect(sfx);
  ui.connect(sfx);
  musicIn.connect(musicLpf).connect(music);
  music.connect(master);
  sfx.connect(master);
  // Sub-sonic / DC blocker ahead of the dynamics, so the clipper's ceiling still bounds the output.
  const dcBlock = ctx.createBiquadFilter();
  dcBlock.type = 'highpass';
  dcBlock.frequency.value = MIX.DC_BLOCK_HZ;
  dcBlock.Q.value = Math.SQRT1_2;
  master.connect(dcBlock).connect(comp).connect(limit).connect(clip).connect(out).connect(ctx.destination);

  let analyser: AnalyserNode | null = null;
  let meterData: Float32Array<ArrayBuffer> | null = null;
  if (typeof OfflineAudioContext === 'undefined' || !(ctx instanceof OfflineAudioContext)) {
    analyser = ctx.createAnalyser();
    analyser.fftSize = MIX.METER_FFT;
    meterData = new Float32Array(new ArrayBuffer(MIX.METER_FFT * Float32Array.BYTES_PER_ELEMENT));
    out.connect(analyser);
  }

  const live = { count: 0, started: 0 };
  let space: SpaceName = 'room';

  return {
    ctx, master, music, sfx, musicIn, ui, buses, reverbIn, musicReverbIn, noise: makeNoise(ctx), live,
    track(node): void {
      live.count++;
      live.started++;
      node.addEventListener('ended', () => { live.count--; }, { once: true });
    },
    setSpace(next): void {
      if (next === space) return;
      space = next;
      const now = ctx.currentTime;
      for (const name of ['room', 'hall'] as const) {
        const param = returns[name].gain;
        param.cancelScheduledValues(now);
        param.setValueAtTime(param.value, now);
        param.linearRampToValueAtTime(name === next ? SPACES[name].gain : 0, now + SPACE_FADE);
      }
    },
    space: () => space,
    duckMusic(to, hold, release): void {
      const now = ctx.currentTime;
      const param = musicIn.gain;
      param.cancelScheduledValues(now);
      param.setTargetAtTime(Math.max(MIX.SILENCE, to), now, MIX.SMOOTH);
      param.setTargetAtTime(1, now + hold, release / 3);
    },
    muffle(hz, hold, release): void {
      const now = ctx.currentTime;
      for (const param of [sfxLpf.frequency, musicLpf.frequency]) {
        param.cancelScheduledValues(now);
        param.setTargetAtTime(hz, now, MIX.SMOOTH / 2);
        param.setTargetAtTime(MIX.OPEN_HZ, now + hold, release / 3);
      }
    },
    meter(): number {
      if (!analyser || !meterData) return 0;
      analyser.getFloatTimeDomainData(meterData);
      let peak = 0;
      for (let i = 0; i < meterData.length; i++) peak = Math.max(peak, Math.abs(meterData[i]));
      return peak;
    },
  };
}

export function setLevel(param: AudioParam, value: number, now: number): void {
  param.cancelScheduledValues(now);
  param.setTargetAtTime(Math.max(0, value), now, MIX.SMOOTH);
}

// ------------------------------------------------------------------ primitives

export interface ToneOpts {
  type?: OscillatorType;
  freq: number;
  /** Exponential glide target. */
  freqEnd?: number;
  dur: number;
  gain: number;
  attack?: number;
  /** Cents. */
  detune?: number;
  /** Low-pass cutoff (Hz); omitted = unfiltered. */
  lpf?: number;
  lpfEnd?: number;
  q?: number;
  /** 0..1 amount sent to the reverb of the graph the voice plays in. */
  send?: number;
  /** Seconds the level is held before decaying (pads). */
  hold?: number;
  /** Vibrato: depth in cents at `vibHz`. */
  vib?: number;
  vibHz?: number;
  /** Amplitude roughness (growls): modulation depth 0..1 at `amHz`. */
  am?: number;
  amHz?: number;
}

export interface NoiseOpts {
  dur: number;
  gain: number;
  filter?: BiquadFilterType;
  freq?: number;
  freqEnd?: number;
  q?: number;
  attack?: number;
  send?: number;
  hold?: number;
  /** Stereo position -1..1 (0 = centre). */
  pan?: number;
}

const MIN_FREQ = 20;
const TAIL = 0.03;
const DEFAULT_VIB_HZ = 5.5;
const DEFAULT_AM_HZ = 30;

function envelope(g: AudioGraph, t: number, gain: number, attack: number, hold: number, dur: number): GainNode {
  const amp = g.ctx.createGain();
  const peak = Math.max(MIX.SILENCE, gain);
  amp.gain.setValueAtTime(MIX.SILENCE, t);
  amp.gain.linearRampToValueAtTime(peak, t + attack);
  if (hold > 0) amp.gain.setValueAtTime(peak, t + attack + hold);
  amp.gain.exponentialRampToValueAtTime(MIX.SILENCE, t + Math.max(dur, attack + hold + 0.01));
  return amp;
}

function route(g: AudioGraph, node: AudioNode, dest: AudioNode, send: number, reverb: AudioNode): void {
  node.connect(dest);
  if (send > 0) {
    const tap = g.ctx.createGain();
    tap.gain.value = send;
    node.connect(tap).connect(reverb);
  }
}

/** Places a mono voice in the stereo field (no-op for centre or where StereoPannerNode is missing). */
export function panned(ctx: BaseAudioContext, node: AudioNode, pan: number | undefined): AudioNode {
  if (!pan || typeof ctx.createStereoPanner !== 'function') return node;
  const panner = ctx.createStereoPanner();
  panner.pan.value = Math.max(-1, Math.min(1, pan));
  return node.connect(panner);
}

/** One enveloped oscillator, optionally low-passed. `reverb` defaults to the game send. */
export function tone(g: AudioGraph, dest: AudioNode, t: number, o: ToneOpts, reverb: AudioNode = g.reverbIn): void {
  const { ctx } = g;
  const osc = ctx.createOscillator();
  const end = t + o.dur + TAIL;
  osc.type = o.type ?? 'sine';
  osc.frequency.setValueAtTime(Math.max(MIN_FREQ, o.freq), t);
  if (o.freqEnd !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(MIN_FREQ, o.freqEnd), t + o.dur);
  if (o.detune) osc.detune.value = o.detune;
  if (o.vib) {
    const lfo = ctx.createOscillator();
    const depth = ctx.createGain();
    lfo.frequency.value = o.vibHz ?? DEFAULT_VIB_HZ;
    depth.gain.value = o.vib;
    lfo.connect(depth).connect(osc.detune);
    g.track(lfo);
    lfo.start(t);
    lfo.stop(end);
  }
  let node: AudioNode = osc;
  if (o.lpf !== undefined) {
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = o.q ?? 0.7;
    filter.frequency.setValueAtTime(Math.max(MIN_FREQ, o.lpf), t);
    if (o.lpfEnd !== undefined) filter.frequency.exponentialRampToValueAtTime(Math.max(MIN_FREQ, o.lpfEnd), t + o.dur);
    node = osc.connect(filter);
  }
  const amp = envelope(g, t, o.gain, o.attack ?? 0.004, o.hold ?? 0, o.dur);
  node.connect(amp);
  let last: AudioNode = amp;
  if (o.am) {
    const trem = ctx.createGain();
    const lfo = ctx.createOscillator();
    const depth = ctx.createGain();
    trem.gain.value = 1 - o.am / 2;
    lfo.type = 'triangle';
    lfo.frequency.value = o.amHz ?? DEFAULT_AM_HZ;
    depth.gain.value = o.am / 2;
    lfo.connect(depth).connect(trem.gain);
    g.track(lfo);
    lfo.start(t);
    lfo.stop(end);
    last = amp.connect(trem);
  }
  route(g, last, dest, o.send ?? 0, reverb);
  g.track(osc);
  osc.start(t);
  osc.stop(end);
}

/** One enveloped burst of filtered white noise. */
export function noise(g: AudioGraph, dest: AudioNode, t: number, o: NoiseOpts, reverb: AudioNode = g.reverbIn): void {
  const { ctx } = g;
  const src = ctx.createBufferSource();
  src.buffer = g.noise;
  src.loop = true;
  const filter = ctx.createBiquadFilter();
  filter.type = o.filter ?? 'lowpass';
  filter.Q.value = o.q ?? 0.8;
  filter.frequency.setValueAtTime(Math.max(MIN_FREQ, o.freq ?? 2000), t);
  if (o.freqEnd !== undefined) filter.frequency.exponentialRampToValueAtTime(Math.max(MIN_FREQ, o.freqEnd), t + o.dur);
  const amp = envelope(g, t, o.gain, o.attack ?? 0.003, o.hold ?? 0, o.dur);
  src.connect(filter).connect(amp);
  route(g, panned(ctx, amp, o.pan), dest, o.send ?? 0, reverb);
  g.track(src);
  src.start(t, Math.random() * (MIX.NOISE_SECONDS - 0.1));
  src.stop(t + o.dur + TAIL);
}

const A4_MIDI = 69;
const A4_HZ = 440;
const SEMITONES = 12;

export function midiToHz(midi: number): number {
  return A4_HZ * Math.pow(2, (midi - A4_MIDI) / SEMITONES);
}

/** Playback-rate factor for a shift of `semitones`. */
export function semitones(n: number): number {
  return Math.pow(2, n / SEMITONES);
}
