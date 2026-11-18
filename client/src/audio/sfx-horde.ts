/**
 * Update 4, the horde: voices of the five new enemy kinds and the feedback of a warded foe.
 *
 * Each kind has a register and a gesture of its own, so it can be told by ear before it is seen:
 *   shaman      – wet, hummed, mid-low: a voice that rises while it mends and is cut off when interrupted
 *   aegis       – heavy plate below, glass above: the dome swells up and cracks
 *   bomber      – thin, high and ticking: a fuse that accelerates into a burst
 *   necromancer – the lowest: a pulsing chant under bones knocking together
 *   reaver      – air and steel: a whoosh across the room and a hard landing
 * Per kind: a spawn signature (after the common spawn sound), an action cue and a death layer.
 *
 * Bombers and reavers are warnings. They play on the `big` bus with the priority of the own hero, their
 * limiter families are separate from the rest of the enemy casts, and the fuse / the incoming whistle are
 * synthesised, so no voice limit can swallow them.
 *
 * Channelled sounds (mend, fuse, raise, leap) are remembered per enemy id and are cut when that enemy dies or
 * `interrupt(id)` is called. Everything works without samples.
 */
import { ENEMIES, ENEMY_TUNING } from '@shared/data/enemies.ts';
import type { ElementId, EnemyKind } from '@shared/types.ts';
import { midiToHz } from './engine.ts';
import { VOICES } from './samples.ts';
import { NOTE, rnd, TUNED, type Mix, type SfxKit } from './sfx-kit.ts';

const LV = {
  spawnShaman: 0.8, spawnAegis: 0.5, spawnBomber: 1.5, spawnNecromancer: 0.5, spawnReaver: 1.3,
  mend: 0.42, mendCut: 0.6, mendRelease: 1,
  domeUp: 0.8, domeDown: 0.85,
  fuse: 1.25, burst: 1, deathFuse: 0.9,
  raise: 0.4, leap: 0.66,
  deathShaman: 0.7, deathAegis: 0.5, deathNecromancer: 0.6, deathReaver: 1.1,
  ward: 0.9,
} as const;

export const HORDE = {
  /** The signature follows the common spawn sound by this much (s). */
  SPAWN_DELAY: 0.14,
  /** Time constant of the cut when a channel is interrupted (s): fast enough to be heard as a cut, no click. */
  CUT_TC: 0.012,
  /** Ticks of a bomber's fuse; each gap is this fraction of the one before, so the ticking accelerates. */
  FUSE_TICKS: 9,
  FUSE_ACCEL: 0.8,
  /** A `kill` or hostile `aoe` up to this long before the fuse's end is the burst itself, not a hero's kill (s). */
  FUSE_END_SLACK: 0.2,
  /** ... and up to this long after it (network jitter); also how close a hostile `aoe` must be to a burst already sounded (s). */
  BURST_WINDOW: 0.3,
  /** Minion bones heard collapsing with a necromancer. */
  CRUMBLE_KNOCKS: 14,
  /** Mended enemies that get a note of their own in the release. */
  MEND_TARGETS_MAX: 4,
  MAX_TRACKED: 64,
} as const;

/** Enemy `cast` ids of the new kinds (the sim's names) and the channel each one starts. */
const CAST_IDS: Record<string, ChannelKind> = { mend: 'mend', raise: 'raise', fuse: 'fuse', reaver_leap: 'leap' };

type ChannelKind = 'mend' | 'raise' | 'fuse' | 'leap';
interface Channel { kind: ChannelKind; mix: Mix; start: number; end: number }

export const HORDE_KINDS = ['shaman', 'aegis', 'bomber', 'necromancer', 'reaver'] as const;
export type HordeKind = (typeof HORDE_KINDS)[number];
export const isHordeKind = (kind: EnemyKind | null | undefined): kind is HordeKind =>
  kind !== null && kind !== undefined && (HORDE_KINDS as readonly string[]).includes(kind);

/** Which channel an enemy `cast` id starts, or null for the casts of the older kinds. */
export function hordeCast(ability: string): ChannelKind | null {
  const id = ability.toLowerCase();
  if (id in CAST_IDS) return CAST_IDS[id];
  // tolerate prefixed ids ("shaman_mend", "bomber_fuse"); `reaver_leap` must win over the bosses' `leap` cue
  for (const [part, kind] of Object.entries(CAST_IDS)) if (id.endsWith(`_${part}`) || id === part) return kind;
  return id.startsWith('reaver') && id.includes('leap') ? 'leap' : null;
}

export function createHordeSfx(k: SfxKit) {
  const channels = new Map<number, Channel>();
  /** Times at which a bomber's burst was sounded or is scheduled (the sim's `aoe` for it then stays silent). */
  const bursts: number[] = [];
  /** Bombers whose fuse already ended in a burst here: their `kill` is not a second death. */
  const burst = new Map<number, number>();

  const track = (id: number, channel: Channel): void => {
    if (channels.size >= HORDE.MAX_TRACKED) channels.clear();
    channels.set(id, channel);
  };
  /** Cuts whatever enemy `id` was channelling. Returns the channel if it was still sounding. */
  const cut = (id: number, t: number): Channel | null => {
    const channel = channels.get(id);
    if (!channel) return null;
    channels.delete(id);
    if (channel.end <= t) return null;
    channel.mix.fade(t, HORDE.CUT_TC);
    return channel;
  };

  /** A hummed voice: detuned triangle / saw with vibrato through two "oo" formant bands. */
  const hum = (out: AudioNode, t: number, midi: number, toMidi: number, dur: number, gain: number, attack: number): void => {
    const f = midiToHz(midi);
    const to = midiToHz(toMidi);
    k.tone(out, t, { type: 'triangle', freq: f, freqEnd: to, dur, gain, attack, vib: 16, vibHz: 5.4, send: 0.5 });
    k.tone(out, t, { type: 'sawtooth', freq: f, freqEnd: to, detune: 9, dur, gain: gain * 0.45, lpf: 700, lpfEnd: 1500, q: 2, attack, vib: 16, vibHz: 5.4, send: 0.5 });
  };

  // ---------------------------------------------------------------- bomber
  const burstAt = (t: number, stack: number, expectAoe: boolean): void => {
    if (expectAoe) bursts.push(t);
    const { V, out } = k.bigMix(LV.burst * k.duck(stack));
    // a small, dry, cracking blast: bright on top so it is not mistaken for a boss slam
    V('boom', t, 0.85, { variant: 1, rate: 1.25, send: 0.3 });
    V('boom.sub', t, 0.45, { rate: 1.1 });
    V('hit.thud', t, 0.4, { rate: 0.9 });
    k.noise(out, t, { dur: 0.016, gain: 0.8, filter: 'highpass', freq: 5200 });
    k.noise(out, t, { dur: 0.32, gain: 0.5, filter: 'bandpass', freq: 3200, freqEnd: 500, q: 0.9, send: 0.3 });
    k.tone(out, t, { freq: 150, freqEnd: 38, dur: 0.42, gain: 0.42 });
    k.tone(out, t, { type: 'square', freq: 1900, freqEnd: 240, dur: 0.07, gain: 0.1, lpf: 5000 });
    // shrapnel of bone
    k.clatter(V, t + 0.05, 5, 0.35, 0.3);
    for (let i = 0; i < 4; i++) k.noise(out, t + 0.06 + i * rnd(0.03, 0.07), { dur: 0.02, gain: rnd(0.15, 0.3), filter: 'highpass', freq: rnd(3500, 6500) });
  };

  const api = {
    // ------------------------------------------------------------ spawn signatures
    /** The kind's own voice right after the common spawn sound. Unknown / older kinds: nothing. */
    hordeSpawn(kind: EnemyKind): void {
      if (!isHordeKind(kind)) return;
      const t = k.now() + HORDE.SPAWN_DELAY;
      const stack = k.take('voice', t);
      if (stack < 0) return;
      const duck = k.duck(stack);
      switch (kind) {
        case 'shaman': {
          // two hummed notes, a question: F up to A
          const { V, out } = k.worldMix(LV.spawnShaman * duck);
          hum(out, t, NOTE.F3, NOTE.F3, 0.22, 0.16, 0.04);
          hum(out, t + 0.2, NOTE.A3, NOTE.A3 + 1, 0.42, 0.18, 0.05);
          for (const [freq, q] of [[340, 7], [780, 9]] as const) k.noise(out, t, { dur: 0.6, gain: 0.12, filter: 'bandpass', freq, q, attack: 0.12, hold: 0.2, send: 0.6 });
          V('slime', t, 0.14, { rate: 0.8, lpf: 1600, send: 0.5 });
          break;
        }
        case 'aegis': {
          // plate set down, then a glassy ring above it
          const { V, out } = k.worldMix(LV.spawnAegis * duck);
          V('hit.plate', t, 0.7, { rate: 0.7, send: 0.4 });
          V('hit.iron', t, 0.5, { at: 0.02, rate: 0.8 });
          V('hit.clang', t, 0.3, { at: 0.16, rate: 0.6, send: 0.5 });
          k.tone(out, t, { freq: 170, freqEnd: 80, dur: 0.24, gain: 0.2 });
          for (const n of [NOTE.D5, NOTE.A5]) k.tone(out, t + 0.16, { freq: midiToHz(n), dur: 0.7, gain: 0.035, attack: 0.03, send: 0.7 });
          V('ping', t, 0.1, { at: 0.16, variant: 1, rate: 0.75, send: 0.7 });
          break;
        }
        case 'bomber': {
          // flint struck twice, a hiss catching, a squeak going up: something small that is in a hurry
          const { V, out } = k.bigMix(LV.spawnBomber * duck);
          for (const at of [0, 0.09]) {
            k.noise(out, t + at, { dur: 0.02, gain: 0.22, filter: 'highpass', freq: 5200 });
            V('foley.latch', t, 0.2, { at, variant: 2, rate: 1.7, jitter: 0.02 });
          }
          k.noise(out, t + 0.1, { dur: 0.42, gain: 0.3, filter: 'bandpass', freq: 3000, freqEnd: 7500, q: 2, attack: 0.25 });
          k.tone(out, t + 0.1, { type: 'square', freq: 740, freqEnd: 1480, dur: 0.34, gain: 0.08, lpf: 4200, attack: 0.15 });
          for (let i = 0; i < 3; i++) k.tone(out, t + 0.16 + i * 0.07, { type: 'square', freq: 1760, dur: 0.035, gain: 0.07, lpf: 5000 });
          break;
        }
        case 'necromancer': {
          // a muffled low bell and a breath of chant on the tonic
          const { V, out } = k.bigMix(LV.spawnNecromancer * duck);
          V('bell', t, 0.4, { variant: 2, rate: TUNED.BELL2_D3 / 2, lpf: 900, jitter: 0, send: 0.9 });
          for (const [n, detune] of [[NOTE.D2, 0], [NOTE.A2, 8]] as const) {
            k.tone(out, t, { type: 'sawtooth', freq: midiToHz(n), detune, dur: 0.9, gain: 0.11, lpf: 420, q: 3, attack: 0.15, hold: 0.3, am: 0.8, amHz: 4.4, send: 0.6 });
          }
          k.noise(out, t, { dur: 0.9, gain: 0.14, filter: 'bandpass', freq: 340, q: 7, attack: 0.2, hold: 0.3, send: 0.6 });
          V('bone.tick', t, 0.3, { at: 0.3, rate: 0.7 });
          V('bone.tick', t, 0.25, { at: 0.48, rate: 0.6 });
          break;
        }
        case 'reaver': {
          // two blades drawn fast and a short snarl
          const { V, out } = k.bigMix(LV.spawnReaver * duck);
          V('swing.draw', t, 0.6, { rate: 1.3, lpf: 6000 });
          V('swing.draw', t, 0.55, { at: 0.09, rate: 1.6, lpf: 6000 });
          k.whoosh(out, t, 700, 3000, 1000, 0.18, 0.2);
          for (const detune of [-10, 8]) {
            k.tone(out, t + 0.08, { type: 'sawtooth', freq: 190, freqEnd: 300, detune, dur: 0.3, gain: 0.16, lpf: 1700, q: 2, attack: 0.03, am: 0.9, amHz: 43 });
          }
          k.tone(out, t + 0.08, { freq: 150, freqEnd: 90, dur: 0.14, gain: 0.14 });
          V('hit.ring', t, 0.12, { at: 0.1, rate: 1.3, dur: 0.14, send: 0.4 });
          break;
        }
      }
    },

    // ------------------------------------------------------------ action cues
    /**
     * An enemy `cast` of one of the new kinds (`mend`, `raise`, `fuse`, `reaver_leap`). Returns false when the id
     * is none of them, so the caller plays the older cues.
     */
    hordeAction(ability: string, id: number): boolean {
      const kind = hordeCast(ability);
      if (!kind) return false;
      if (kind === 'mend') api.mendStart(id);
      else if (kind === 'raise') api.raise(id);
      else if (kind === 'fuse') api.fuse(id);
      else api.reaverLeap(id);
      return true;
    },
    /**
     * A shaman starts to mend: a hum that climbs a fifth and swells for the whole channel. It never resolves on
     * its own; `mendRelease` resolves it, `interrupt` (or the shaman's death) cuts it off.
     */
    mendStart(id: number, dur: number = ENEMY_TUNING.SHAMAN.MEND_WINDUP): void {
      const t = k.now();
      cut(id, t);
      const stack = k.take('mend', t);
      if (stack < 0) return;
      const m = k.worldMix(LV.mend * k.duck(stack));
      const { V, out } = m;
      const swell = dur * 0.92;
      hum(out, t, NOTE.D3, NOTE.A3, dur, 0.2, swell);
      hum(out, t, NOTE.A3, NOTE.E4, dur, 0.12, swell);
      // the breath behind the voice opens from "oo" towards "ah"
      k.noise(out, t, { dur, gain: 0.22, filter: 'bandpass', freq: 340, freqEnd: 640, q: 6, attack: swell, send: 0.6 });
      k.noise(out, t, { dur, gain: 0.1, filter: 'bandpass', freq: 780, freqEnd: 1080, q: 8, attack: swell, send: 0.6 });
      // a slow pulse like a heart: three beats, each stronger
      for (let i = 0; i < 3; i++) k.tone(out, t + (i / 3) * dur, { freq: 88, freqEnd: 56, dur: 0.16, gain: 0.07 + i * 0.04 });
      V('tex.void', t, 0.5, { offset: -1, dur: dur * 0.85, attack: dur * 0.7, release: 0.08, rate: 1.5, lpf: 1400, send: 0.4 });
      track(id, { kind: 'mend', mix: m, start: t, end: t + dur });
    },
    /** The mend went through (`mend` event): the hum lands on a soft major chord, one small note per healed enemy. */
    mendRelease(id: number, targets: number): void {
      const t = k.now();
      channels.delete(id);
      const stack = k.take('mend', t);
      if (stack < 0) return;
      const { V, out } = k.worldMix(LV.mendRelease * k.duck(stack));
      // F major over the hum's last note A: warm, and plainly not the heroes' D major heal
      for (const [i, n] of [NOTE.F3, NOTE.A3, NOTE.C4, NOTE.F4].entries()) {
        k.tone(out, t + i * 0.012, { type: 'triangle', freq: midiToHz(n), dur: 0.8, gain: 0.07, attack: 0.02, send: 0.65 });
      }
      k.noise(out, t, { dur: 0.5, gain: 0.1, filter: 'bandpass', freq: 640, q: 6, attack: 0.02, send: 0.6 });
      V('slime', t, 0.12, { rate: 1.2, lpf: 2400, send: 0.5 });
      const n = Math.max(1, Math.min(HORDE.MEND_TARGETS_MAX, targets));
      for (let i = 0; i < n; i++) {
        k.tone(out, t + 0.07 + i * 0.06, { freq: midiToHz(NOTE.C5 + (i % 2) * 5), dur: 0.35, gain: 0.035, send: 0.7 });
      }
    },
    /** An aegis raised or lost its ward dome. */
    dome(on: boolean): void {
      const t = k.now();
      const stack = k.take('dome', t);
      if (stack < 0) return;
      if (on) {
        // glassy swell: partials fading in over a reversed shimmer, closing with a clear ping
        const { V, out } = k.worldMix(LV.domeUp * k.duck(stack));
        const rise = 0.4;
        V('shimmer', t, 0.3, { reverse: true, fit: rise, send: 0.6, jitter: 0 });
        V('field', t, 0.35, { variant: 1, rate: 1.3, dur: rise + 0.2, attack: rise * 0.8, release: 0.2, hpf: 600, send: 0.5 });
        V('tex.spin', t, 0.5, { offset: -1, dur: rise + 0.25, attack: rise, release: 0.25, rate: 1.6, hpf: 500, send: 0.4 });
        for (const [n, gain] of [[NOTE.D5, 0.06], [NOTE.A5, 0.05], [NOTE.D6, 0.04], [NOTE.Fs6 + 1, 0.02]] as const) {
          k.tone(out, t, { freq: midiToHz(n), dur: rise + 0.7, gain, attack: rise, send: 0.7 });
        }
        k.noise(out, t, { dur: rise + 0.1, gain: 0.08, filter: 'highpass', freq: 5000, attack: rise, send: 0.5 });
        V('ping', t, 0.2, { at: rise, variant: 2, rate: TUNED.PING_TO_D7 / 2, jitter: 0, send: 0.8 });
        V('glass.light', t, 0.2, { at: rise, rate: 0.8, send: 0.6 });
      } else {
        // crack: one hard break, the ring falling away, a few shards
        const { V, out } = k.worldMix(LV.domeDown * k.duck(stack));
        k.noise(out, t, { dur: 0.012, gain: 0.7, filter: 'highpass', freq: 6000 });
        V('glass.heavy', t, 0.9, { rate: 0.95, send: 0.4 });
        V('glass.mid', t, 0.6, { at: 0.02, rate: 0.8, send: 0.4 });
        V('zap.fall', t, 0.4, { rate: 0.9, lpf: 5000, send: 0.5, jitter: 0 });
        for (const n of [NOTE.D6, NOTE.A5]) k.tone(out, t, { freq: midiToHz(n), freqEnd: midiToHz(n) * 0.5, dur: 0.4, gain: 0.05, send: 0.6 });
        k.tone(out, t, { freq: 190, freqEnd: 70, dur: 0.2, gain: 0.16 });
        for (let i = 0; i < 4; i++) V('glass.light', t, 0.4 - i * 0.07, { at: 0.07 + i * rnd(0.04, 0.08), rate: 1.2 + i * 0.2, send: 0.55 });
      }
    },
    /**
     * A bomber lit its fuse: ticks that come faster and higher over a climbing hiss, for exactly `dur` seconds.
     * The burst is not scheduled with it (a stun may still stop the fuse): it answers the sim's own report of the
     * blast, the bomber's `kill` or its hostile `aoe`, whichever arrives first (`hordeDeath`, `claimBurst`).
     */
    fuse(id: number, dur: number = ENEMIES.bomber.windup): void {
      const t = k.now();
      cut(id, t);
      const stack = k.take('fuse', t);
      if (stack < 0) return;
      const m = k.bigMix(LV.fuse * k.duck(stack));
      const { V, out } = m;
      // gaps shrink geometrically and add up to `dur`
      let unit = 0;
      for (let i = 0; i < HORDE.FUSE_TICKS; i++) unit += Math.pow(HORDE.FUSE_ACCEL, i);
      let at = 0;
      for (let i = 0; i < HORDE.FUSE_TICKS; i++) {
        const p = i / (HORDE.FUSE_TICKS - 1);
        k.noise(out, t + at, { dur: 0.02, gain: 0.3 + 0.2 * p, filter: 'highpass', freq: 4200 });
        k.tone(out, t + at, { type: 'square', freq: 1320 * (1 + p), dur: 0.045, gain: 0.12 + 0.08 * p, lpf: 6000 });
        if (i % 2 === 0) V('ui.tick', t, 0.5, { at, variant: 2, rate: 1.2 + p * 0.8, jitter: 0, pool: 'big' });
        at += (dur * Math.pow(HORDE.FUSE_ACCEL, i)) / unit;
      }
      k.noise(out, t, { dur, gain: 0.4, filter: 'bandpass', freq: 2400, freqEnd: 8200, q: 1.8, attack: dur * 0.85 });
      k.tone(out, t, { type: 'sawtooth', freq: 440, freqEnd: 1760, dur, gain: 0.1, lpf: 5200, attack: dur * 0.85 });
      V('tex.fire', t, 1.4, { offset: -1, dur: dur * 0.9, attack: dur * 0.6, release: 0.05, hpf: 1800, rate: 1.4 });
      track(id, { kind: 'fuse', mix: m, start: t, end: t + dur });
    },
    /** The burst of a bomber, now. Also called through `claimBurst` when the sim reports the blast itself. */
    bomberBurst(t: number = k.now()): void {
      const stack = k.take('burst', t);
      if (stack >= 0) burstAt(t, stack, true);
    },
    /**
     * A hostile `aoe` arrived. True when it is the blast of a bomber whose burst is expected about now: the caller
     * then skips the common hostile blast, the bomber's own burst plays instead (once).
     */
    claimBurst(): boolean {
      const t = k.now();
      for (let i = bursts.length - 1; i >= 0; i--) if (t - bursts[i] > HORDE.BURST_WINDOW) bursts.splice(i, 1);
      for (let i = 0; i < bursts.length; i++) {
        if (Math.abs(bursts[i] - t) <= HORDE.BURST_WINDOW) { bursts.splice(i, 1); return true; }
      }
      for (const [id, channel] of channels) {
        if (channel.kind !== 'fuse' || t < channel.end - HORDE.FUSE_END_SLACK || t > channel.end + HORDE.BURST_WINDOW) continue;
        // the fuse ran out: its sound ends here, the burst answers it
        channels.delete(id);
        channel.mix.fade(t, HORDE.CUT_TC);
        if (burst.size >= HORDE.MAX_TRACKED) burst.clear();
        burst.set(id, t);
        const stack = k.take('burst', t);
        if (stack >= 0) burstAt(t, stack, false);
        return true;
      }
      return false;
    },
    /** A necromancer raises minions: a pulsing chant on the tonic while bones knock together faster and faster. */
    raise(id: number, dur: number = ENEMIES.necromancer.windup): void {
      const t = k.now();
      cut(id, t);
      if (k.take('raise', t) < 0) return;
      const m = k.bigMix(LV.raise);
      const { V, out } = m;
      // chant: low saws through "oo" formants, the level beating in syllables
      for (const [n, detune, gain] of [[NOTE.D2, -6, 0.16], [NOTE.D2, 7, 0.16], [NOTE.A2, 0, 0.1], [NOTE.D3 + 1, 0, 0.05]] as const) {
        k.tone(out, t, { type: 'sawtooth', freq: midiToHz(n), detune, dur, gain, lpf: 380, lpfEnd: 760, q: 3.5, attack: dur * 0.25, hold: dur * 0.6, am: 0.9, amHz: 4.6, send: 0.6 });
      }
      for (const [freq, q, gain] of [[340, 7, 0.2], [780, 9, 0.08]] as const) k.noise(out, t, { dur, gain, filter: 'bandpass', freq, q, attack: dur * 0.3, hold: dur * 0.5, send: 0.6 });
      k.tone(out, t, { freq: midiToHz(NOTE.D2), dur, gain: 0.16, attack: dur * 0.3, hold: dur * 0.5 });
      // bones finding each other: sparse and low at first, dense and higher towards the end
      const knocks = 9;
      for (let i = 0; i < knocks; i++) {
        const p = i / (knocks - 1);
        const at = dur * (0.12 + 0.82 * Math.sqrt(p));
        V(i % 3 === 0 ? 'hit.bone' : 'bone.tick', t, 0.22 + 0.25 * p, { at, rate: 0.7 + 0.8 * p, jitter: 0.04, send: 0.3 });
        k.tone(out, t + at, { type: 'triangle', freq: 300 + 500 * p, freqEnd: 220 + 300 * p, dur: 0.035, gain: 0.03 + 0.03 * p });
      }
      // they stand: one knock together and the floor answering
      V('hit.bone', t, 0.6, { at: dur, rate: 0.8 });
      V('hit.thud', t, 0.4, { at: dur, rate: 0.75 });
      V('earth', t, 0.25, { at: dur, rate: 1.2, dur: 0.3, release: 0.15, lpf: 1400 });
      k.tone(out, t + dur, { freq: 110, freqEnd: 50, dur: 0.3, gain: 0.2 });
      track(id, { kind: 'raise', mix: m, start: t, end: t + dur });
    },
    /**
     * A reaver leaps: take-off, a whoosh across the air time with a whistle falling towards the landing, and the
     * landing itself at the end. Killed in the air: `hordeDeath` cuts it.
     */
    reaverLeap(id: number, air: number = ENEMY_TUNING.REAVER.LEAP_AIR_TIME): void {
      const t = k.now();
      cut(id, t);
      const stack = k.take('leap', t);
      if (stack < 0) return;
      const m = k.bigMix(LV.leap * k.duck(stack));
      const { V, out } = m;
      // take-off
      V('swing.cloth', t, 0.8, { rate: 1.3 });
      V('bone.tap', t, 0.4, { rate: 0.8 });
      k.tone(out, t, { freq: 140, freqEnd: 70, dur: 0.12, gain: 0.18 });
      k.tone(out, t, { type: 'sawtooth', freq: 210, freqEnd: 330, dur: 0.2, gain: 0.07, lpf: 1600, attack: 0.02, am: 0.9, amHz: 47 });
      // through the air: up, over, and coming down on someone
      k.noise(out, t, { dur: air * 0.75, gain: 0.5, filter: 'bandpass', freq: 500, freqEnd: 3400, q: 1.3, attack: air * 0.3, hold: air * 0.15 });
      k.noise(out, t + air * 0.4, { dur: air * 0.62, gain: 0.55, filter: 'bandpass', freq: 3400, freqEnd: 700, q: 1.3, attack: air * 0.3, hold: air * 0.25 });
      k.tone(out, t + air * 0.45, { freq: 2100, freqEnd: 620, dur: air * 0.56, gain: 0.2, attack: air * 0.3, hold: air * 0.2 });
      k.tone(out, t + air * 0.45, { type: 'triangle', freq: 2140, freqEnd: 600, dur: air * 0.56, gain: 0.12, attack: air * 0.3, hold: air * 0.2 });
      // landing
      const land = t + air;
      V('earth', land, 0.9, { rate: 1.1, send: 0.4 });
      V('hit.thud', land, 0.9, { rate: 0.85 });
      V('hit.heavy', land, 0.6, { rate: 0.9 });
      V('swing.blade', land, 0.6, { at: 0.02, rate: 1.3 });
      V('hit.ring', land, 0.2, { at: 0.02, rate: 1.3, dur: 0.2, send: 0.4 });
      k.noise(out, land, { dur: 0.014, gain: 0.5, filter: 'highpass', freq: 3800 });
      k.tone(out, land, { freq: 170, freqEnd: 46, dur: 0.3, gain: 0.6 });
      k.noise(out, land, { dur: 0.2, gain: 0.3, filter: 'lowpass', freq: 1800, freqEnd: 200, send: 0.3 });
      track(id, { kind: 'leap', mix: m, start: t, end: land });
    },
    /**
     * The wind-up of enemy `id` was broken (stun, stagger): whatever it was channelling stops dead. A cut mend gets
     * a swallowed, falling choke so the stop reads as an interruption and not as the end of the sound.
     */
    interrupt(id: number): void {
      const t = k.now();
      const channel = cut(id, t);
      if (!channel || channel.kind !== 'mend') return;
      const { V, out } = k.worldMix(LV.mendCut);
      k.noise(out, t, { dur: 0.09, gain: 0.3, filter: 'bandpass', freq: 700, freqEnd: 200, q: 2 });
      k.tone(out, t, { type: 'triangle', freq: 260, freqEnd: 120, dur: 0.1, gain: 0.14 });
      V('hit.tight', t, 0.4, { rate: 1.1 });
    },

    // ------------------------------------------------------------ deaths
    /**
     * Death of one of the new kinds, on top of the common kill sound. Cuts what the enemy was channelling.
     * Returns true when the common kill sound should stay silent (a bomber: its burst is its death).
     */
    hordeDeath(kind: EnemyKind, id: number): boolean {
      const t = k.now();
      // what it was doing, even if that has just ended: a fuse that ran out a moment ago is why this bomber dies
      const was = channels.get(id);
      const channel = cut(id, t);
      if (!isHordeKind(kind)) return false;
      switch (kind) {
        case 'shaman': {
          // the voice drops away
          if (channel?.kind === 'mend') k.noise(k.worldMix(LV.mendCut).out, t, { dur: 0.08, gain: 0.3, filter: 'bandpass', freq: 700, freqEnd: 200, q: 2 });
          if (k.take('voice', t) < 0) return false;
          const { V, out } = k.worldMix(LV.deathShaman);
          hum(out, t, NOTE.A3, NOTE.A2 - 2, 0.45, 0.16, 0.02);
          k.noise(out, t, { dur: 0.4, gain: 0.14, filter: 'bandpass', freq: 640, freqEnd: 300, q: 6, send: 0.5 });
          V('slime', t, 0.2, { rate: 0.6, lpf: 1200, send: 0.4 });
          return false;
        }
        case 'aegis': {
          // the plate comes down in two pieces
          if (k.take('voice', t) < 0) return false;
          const { V, out } = k.worldMix(LV.deathAegis);
          V('hit.clang', t, 0.7, { rate: 0.6, send: 0.5 });
          V('hit.plate', t, 0.7, { at: 0.12, rate: 0.6, send: 0.4 });
          V('hit.iron', t, 0.5, { at: 0.2, rate: 0.7 });
          V('pot', t, 0.3, { at: 0.24, rate: 0.6, send: 0.4 });
          k.tone(out, t, { freq: 120, freqEnd: 44, dur: 0.5, gain: 0.3 });
          return false;
        }
        case 'bomber': {
          const done = burst.get(id);
          burst.delete(id);
          // its blast was already heard through the `aoe` that came with this kill
          if (done !== undefined && t - done <= HORDE.BURST_WINDOW) return true;
          if (was?.kind === 'fuse' && t >= was.end - HORDE.FUSE_END_SLACK && t <= was.end + HORDE.BURST_WINDOW) {
            // the fuse ran out by itself: this kill is the burst
            api.bomberBurst(t);
            return true;
          }
          // slain: it still goes off, after a short and frantic last hiss
          const delay = ENEMY_TUNING.BOMBER.DEATH_BLAST_DELAY;
          const stack = k.take('burst', t);
          if (stack < 0) return false;
          const { V, out } = k.bigMix(LV.deathFuse * k.duck(stack));
          k.noise(out, t, { dur: delay, gain: 0.34, filter: 'bandpass', freq: 3600, freqEnd: 9000, q: 1.6, attack: delay * 0.8 });
          const ticks = 6;
          for (let i = 0; i < ticks; i++) {
            const at = delay * (1 - Math.pow(1 - i / ticks, 1.5));
            k.noise(out, t + at, { dur: 0.012, gain: 0.6, filter: 'highpass', freq: 4500 });
            k.tone(out, t + at, { type: 'square', freq: 1760 + i * 220, dur: 0.025, gain: 0.14, lpf: 6500 });
          }
          V('tex.fire', t, 1.4, { offset: -1, dur: delay * 0.9, attack: delay * 0.5, release: 0.04, hpf: 2200, rate: 1.6 });
          burstAt(t + delay, stack, true);
          return false;
        }
        case 'necromancer': {
          // the chant breaks and everything it raised falls in on itself, together
          if (k.take('voice', t) < 0) return false;
          const { V, out } = k.bigMix(LV.deathNecromancer);
          for (const [n, detune] of [[NOTE.D3, -8], [NOTE.D3 + 1, 6]] as const) {
            k.tone(out, t, { type: 'sawtooth', freq: midiToHz(n), freqEnd: midiToHz(n) * 0.5, detune, dur: 0.8, gain: 0.12, lpf: 900, lpfEnd: 200, q: 2, send: 0.6 });
          }
          V('bell', t, 0.3, { variant: 2, rate: TUNED.BELL2_D3 / 2, lpf: 700, dur: 0.6, release: 0.3, jitter: 0, send: 0.8 });
          k.clatter(V, t + 0.06, HORDE.CRUMBLE_KNOCKS, 0.9, 0.5);
          V('earth', t, 0.4, { at: 0.2, rate: 0.9, lpf: 1800, send: 0.4 });
          V('foley.fall', t, 0.4, { at: 0.45 });
          k.noise(out, t + 0.1, { dur: 0.8, gain: 0.14, filter: 'lowpass', freq: 1400, freqEnd: 200, attack: 0.1, send: 0.4 });
          k.tone(out, t, { freq: 90, freqEnd: 34, dur: 0.9, gain: 0.3 });
          return false;
        }
        case 'reaver': {
          // blades dropped
          if (k.take('voice', t) < 0) return false;
          const { V, out } = k.worldMix(LV.deathReaver);
          V('hit.metal', t, 0.5, { rate: 1.3, send: 0.4 });
          V('hit.ring', t, 0.4, { at: 0.09, rate: 1.1, send: 0.5 });
          V('swing.blade', t, 0.4, { rate: 0.8, lpf: 5000 });
          k.whoosh(out, t, 1800, 900, 300, 0.2, 0.1);
          return false;
        }
      }
    },

    // ------------------------------------------------------------ wards
    /**
     * The own hero's elemental hit landed on an enemy warded against that element: a dull, dead knock with the
     * element's colour swallowed in it. Nothing rings, nothing sparkles: "that did nothing".
     */
    wardDeflect(el: ElementId): void {
      const t = k.now();
      if (k.take('ward', t) < 0) return;
      const { V, out } = k.mix('own', VOICES.PRI.OWN, LV.ward);
      V('hit.dull', t, 0.9, { rate: 0.7, lpf: 1500, dur: 0.16, release: 0.08 });
      V('hit.tight', t, 0.5, { rate: 0.8, lpf: 900 });
      k.tone(out, t, { type: 'triangle', freq: 230, freqEnd: 150, dur: 0.09, gain: 0.26, lpf: 600 });
      k.noise(out, t, { dur: 0.07, gain: 0.3, filter: 'lowpass', freq: 520 });
      // the element fizzles: its register, falling and choked within a tenth of a second
      const tint: Record<ElementId, number> = { ember: 520, rime: 1250, storm: 880, umbra: 190 };
      k.tone(out, t + 0.02, { type: 'square', freq: tint[el], freqEnd: tint[el] * 0.45, dur: 0.11, gain: 0.05, lpf: 1300 });
      k.noise(out, t + 0.02, { dur: 0.1, gain: 0.07, filter: 'bandpass', freq: tint[el] * 2, freqEnd: tint[el], q: 3 });
    },
    /** Channels sounding now (dev workbench / tests). */
    hordeChannels(): number {
      const t = k.now();
      let live = 0;
      for (const channel of channels.values()) if (channel.end > t) live++;
      return live;
    },
  };

  return { api };
}
