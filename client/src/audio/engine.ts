/**
 * Audio graph + synth primitives. Works on any BaseAudioContext so passages can also be rendered with an
 * OfflineAudioContext (see offline.ts). Everything is procedural: oscillators, filtered noise, envelopes.
 *
 *   music ─┐
 *   sfx ───┼─> master (user volume / tab mute) ─> compressor ─> limiter ─> soft clip ─> destination
 *   reverb ┘   (shared send: any voice may feed `reverbIn`)
 */

export const MIX = {
  /** Internal trims so that user volumes of 1.0 still leave headroom. */
  MUSIC_TRIM: 0.6,
  SFX_TRIM: 0.85,
  REVERB_RETURN: 0.42,
  REVERB_SECONDS: 2.4,
  REVERB_DECAY: 3.2,
  NOISE_SECONDS: 2,
  OUTPUT_TRIM: 0.8,
  COMP: { threshold: -15, knee: 12, ratio: 3, attack: 0.004, release: 0.2 },
  LIMIT: { threshold: -4, knee: 0, ratio: 20, attack: 0.001, release: 0.09 },
  SOFT_CLIP_DRIVE: 1.5,
  SOFT_CLIP_CEILING: 0.97,
  SOFT_CLIP_SAMPLES: 2048,
  /** Time constant for volume changes (s). */
  SMOOTH: 0.04,
  SILENCE: 0.0001,
} as const;

export interface AudioGraph {
  ctx: BaseAudioContext;
  master: GainNode;
  music: GainNode;
  sfx: GainNode;
  /** Input of the shared reverb send. */
  reverbIn: GainNode;
  noise: AudioBuffer;
}

function makeNoise(ctx: BaseAudioContext): AudioBuffer {
  const length = Math.floor(ctx.sampleRate * MIX.NOISE_SECONDS);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

/** Synthetic crypt impulse response: decaying, progressively darker noise. */
function makeImpulse(ctx: BaseAudioContext): AudioBuffer {
  const length = Math.floor(ctx.sampleRate * MIX.REVERB_SECONDS);
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    let smooth = 0;
    for (let i = 0; i < length; i++) {
      const p = i / length;
      const white = Math.random() * 2 - 1;
      const damp = 0.25 + 0.7 * p; // more smoothing towards the tail = darker
      smooth = smooth * damp + white * (1 - damp);
      data[i] = smooth * Math.pow(1 - p, MIX.REVERB_DECAY);
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

export function createGraph(ctx: BaseAudioContext): AudioGraph {
  const master = ctx.createGain();
  const music = ctx.createGain();
  const sfx = ctx.createGain();
  const reverbIn = ctx.createGain();
  const convolver = ctx.createConvolver();
  const reverbOut = ctx.createGain();
  const comp = ctx.createDynamicsCompressor();
  const limit = ctx.createDynamicsCompressor();
  const clip = ctx.createWaveShaper();
  const out = ctx.createGain();

  convolver.buffer = makeImpulse(ctx);
  reverbOut.gain.value = MIX.REVERB_RETURN;
  for (const [node, cfg] of [[comp, MIX.COMP], [limit, MIX.LIMIT]] as const) {
    node.threshold.value = cfg.threshold;
    node.knee.value = cfg.knee;
    node.ratio.value = cfg.ratio;
    node.attack.value = cfg.attack;
    node.release.value = cfg.release;
  }
  clip.curve = softClipCurve();
  clip.oversample = '2x';
  out.gain.value = MIX.OUTPUT_TRIM;

  music.connect(master);
  sfx.connect(master);
  reverbIn.connect(convolver).connect(reverbOut).connect(master);
  master.connect(comp).connect(limit).connect(clip).connect(out).connect(ctx.destination);

  return { ctx, master, music, sfx, reverbIn, noise: makeNoise(ctx) };
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
  /** 0..1 amount sent to the shared reverb. */
  send?: number;
  /** Seconds the level is held before decaying (pads). */
  hold?: number;
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
}

const MIN_FREQ = 20;
const TAIL = 0.03;

function envelope(g: AudioGraph, t: number, gain: number, attack: number, hold: number, dur: number): GainNode {
  const amp = g.ctx.createGain();
  const peak = Math.max(MIX.SILENCE, gain);
  amp.gain.setValueAtTime(MIX.SILENCE, t);
  amp.gain.linearRampToValueAtTime(peak, t + attack);
  if (hold > 0) amp.gain.setValueAtTime(peak, t + attack + hold);
  amp.gain.exponentialRampToValueAtTime(MIX.SILENCE, t + Math.max(dur, attack + hold + 0.01));
  return amp;
}

function route(g: AudioGraph, node: AudioNode, dest: AudioNode, send: number): void {
  node.connect(dest);
  if (send > 0) {
    const tap = g.ctx.createGain();
    tap.gain.value = send;
    node.connect(tap).connect(g.reverbIn);
  }
}

/** One enveloped oscillator, optionally low-passed. */
export function tone(g: AudioGraph, dest: AudioNode, t: number, o: ToneOpts): void {
  const { ctx } = g;
  const osc = ctx.createOscillator();
  osc.type = o.type ?? 'sine';
  osc.frequency.setValueAtTime(Math.max(MIN_FREQ, o.freq), t);
  if (o.freqEnd !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(MIN_FREQ, o.freqEnd), t + o.dur);
  if (o.detune) osc.detune.value = o.detune;
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
  route(g, amp, dest, o.send ?? 0);
  osc.start(t);
  osc.stop(t + o.dur + TAIL);
}

/** One enveloped burst of filtered white noise. */
export function noise(g: AudioGraph, dest: AudioNode, t: number, o: NoiseOpts): void {
  const { ctx } = g;
  const src = ctx.createBufferSource();
  src.buffer = g.noise;
  src.loop = true;
  const filter = ctx.createBiquadFilter();
  filter.type = o.filter ?? 'lowpass';
  filter.Q.value = o.q ?? 0.8;
  filter.frequency.setValueAtTime(Math.max(MIN_FREQ, o.freq ?? 2000), t);
  if (o.freqEnd !== undefined) filter.frequency.exponentialRampToValueAtTime(Math.max(MIN_FREQ, o.freqEnd), t + o.dur);
  const amp = envelope(g, t, o.gain, o.attack ?? 0.003, 0, o.dur);
  src.connect(filter).connect(amp);
  route(g, amp, dest, o.send ?? 0);
  src.start(t, Math.random() * (MIX.NOISE_SECONDS - 0.1));
  src.stop(t + o.dur + TAIL);
}

const A4_MIDI = 69;
const A4_HZ = 440;
const SEMITONES = 12;

export function midiToHz(midi: number): number {
  return A4_HZ * Math.pow(2, (midi - A4_MIDI) / SEMITONES);
}
