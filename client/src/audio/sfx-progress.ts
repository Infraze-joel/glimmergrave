/**
 * Update 3 progression and descent sounds: experience ticking up, the level-up fanfare, relic shards, feats,
 * the purchase sounds of the progression pages, set bonuses, legendary boons, elite affixes and the descent.
 *
 * Small interface feedback (ticks, purchases) is dry on the interface bus; the moments worth celebrating
 * (level-up, relic, set bonus, legendary boon, descent) go through the `big` bus so they get the room and may
 * duck the score. Everything works without samples.
 */
import type { AffixId, ElementId } from '@shared/types.ts';
import { midiToHz } from './engine.ts';
import { VOICES } from './samples.ts';
import { NOTE, TUNED, type SfxKit } from './sfx-kit.ts';

const LV = {
  xpTick: 0.7, levelUp: 0.95, relic: 0.85, feat: 0.75,
  ascend: 0.7, talent: 0.7, relicEquip: 0.75, claim: 0.7, art: 0.7,
  setOwn: 0.85, setAlly: 0.5, legendaryOffer: 0.7, legendaryPick: 0.95, legendaryAlly: 0.6,
  affix: 0.75, descend: 0.72,
} as const;

export const PROGRESS = {
  /** Experience ticks: count grows with the logarithm of the amount, all inside TICK_SPAN seconds. */
  TICKS_MIN: 5,
  TICKS_MAX: 16,
  TICKS_PER_DOUBLING: 1.6,
  XP_UNIT: 10,
  TICK_SPAN: 0.9,
  /** Levels beyond this add nothing more to the fanfare. */
  LEVELS_MAX: 4,
  /** Relic chimes played for one run (more shards than this share the last chime). */
  RELICS_MAX: 3,
  RELIC_GAP: 0.55,
  /** The descent cue gets a step lower per depth, down to this many semitones. */
  DEPTH_SEMITONES_MAX: 7,
} as const;

/** D major pentatonic for the experience counter (rises, never lands on anything sad). */
const XP_SCALE = [NOTE.D5, NOTE.E5, NOTE.Fs5, NOTE.A5, NOTE.B4 + 12, NOTE.D6, NOTE.E6, NOTE.Fs6, NOTE.A6];

/** What the reward sequence at the end of a run contains (from `game:progress`). */
export interface ProgressCue {
  xp: number;
  levelsGained: number;
  relics: { rank: number; rankUp: boolean }[];
  featsReady: number;
}

export function createProgressSfx(k: SfxKit) {
  const brass = (out: AudioNode, t: number, midi: number, dur: number, gain: number): void => {
    for (const detune of [-7, 6]) {
      k.tone(out, t, { type: 'sawtooth', freq: midiToHz(midi), detune, dur, gain, lpf: 700, lpfEnd: 2600, q: 1.4, attack: 0.02, hold: dur * 0.5, send: 0.5 });
    }
    k.tone(out, t, { type: 'triangle', freq: midiToHz(midi), dur, gain: gain * 0.8, attack: 0.015, hold: dur * 0.5, send: 0.5 });
  };

  const api = {
    /** Experience counting up: a run of ticks climbing a pentatonic scale. Returns how long it lasts (s). */
    xpTicks(xp: number, t = k.now()): number {
      if (xp <= 0) return 0;
      const count = Math.round(Math.min(PROGRESS.TICKS_MAX, Math.max(PROGRESS.TICKS_MIN, PROGRESS.TICKS_PER_DOUBLING * Math.log2(1 + xp / PROGRESS.XP_UNIT))));
      const { V, out } = k.uiMix(LV.xpTick);
      for (let i = 0; i < count; i++) {
        // ease out: fast at first, settling at the end like a counter does
        const at = PROGRESS.TICK_SPAN * (1 - Math.pow(1 - i / count, 1.6));
        const n = XP_SCALE[Math.min(XP_SCALE.length - 1, Math.floor((i / count) * XP_SCALE.length))];
        V('ui.tick', t, 0.5, { at, variant: 1, rate: 1 + (i / count) * 0.5, jitter: 0.01, free: true });
        k.tone(out, t + at, { type: 'triangle', freq: midiToHz(n), dur: 0.09, gain: 0.07, lpf: 5000 });
      }
      k.tone(out, t + PROGRESS.TICK_SPAN, { freq: midiToHz(NOTE.D6), dur: 0.35, gain: 0.07 });
      V('ui.coins', t, 0.3, { at: PROGRESS.TICK_SPAN, variant: 2, free: true });
      return PROGRESS.TICK_SPAN + 0.1;
    },
    /** Mastery level gained: a short brass call with drums; more levels add a second phrase, voices and bells. */
    levelUp(levels = 1, t = k.now()): void {
      const n = Math.max(1, Math.min(PROGRESS.LEVELS_MAX, Math.round(levels)));
      const { V, out } = k.bigMix(LV.levelUp * (1 + (n - 1) * 0.06));
      // pick-up on the drums
      V('drum.low', t, 0.5, { rate: 1.1 });
      V('drum.low', t, 0.6, { at: 0.11, rate: 1.1 });
      V('drum.war', t, 0.7, { at: 0.24, variant: 1, send: 0.4 });
      k.tone(out, t + 0.24, { freq: 100, freqEnd: 44, dur: 0.4, gain: 0.22 });
      // ta-ta-taa: D, D, up to A, home on the octave
      const call: [number, number, number][] = [[0, NOTE.D4, 0.13], [0.13, NOTE.D4, 0.11], [0.24, NOTE.A4, 0.3], [0.56, NOTE.D5, n > 1 ? 0.5 : 1.3]];
      for (const [at, midi, dur] of call) brass(out, t + at, midi, dur, 0.075);
      let end = 0.56;
      if (n > 1) {
        // a second phrase through the subdominant (G) and back: a small "amen" that says more than one
        const more: [number, number, number][] = [[0.98, NOTE.G4, 0.3], [0.98, NOTE.B4, 0.3], [1.3, NOTE.Fs5, 0.26], [1.58, NOTE.A5, 1.5], [1.58, NOTE.D5, 1.5]];
        for (const [at, midi, dur] of more) brass(out, t + at, midi, dur, 0.065);
        V('drum.war', t, 0.7, { at: 1.58, variant: 2, rate: 0.9, send: 0.4 });
        k.tone(out, t + 1.58, { freq: 96, freqEnd: 40, dur: 0.5, gain: 0.22 });
        end = 1.58;
      }
      // the chord under the last note, a bell and a lift of air
      const home = t + end;
      [NOTE.D3, NOTE.A3, NOTE.D4, NOTE.Fs4, NOTE.A4].forEach((midi, i) => {
        k.tone(out, home + i * 0.02, { type: 'triangle', freq: midiToHz(midi), dur: 1.6, gain: 0.05, attack: 0.02, send: 0.6 });
      });
      V('bell', home, 0.35, { variant: 1, rate: TUNED.BELL1_D4, jitter: 0, send: 0.8 });
      k.noise(out, home, { dur: 1.2, gain: 0.05, filter: 'highpass', freq: 5000, attack: 0.02, send: 0.5 });
      if (n > 2) {
        // three or more: voices join and bells run up the chord
        for (const [freq, q, gain] of [[640, 7, 0.16], [1080, 9, 0.09]] as const) k.noise(out, home, { dur: 1.6, gain, filter: 'bandpass', freq, q, attack: 0.1, hold: 0.5, send: 0.7 });
        [NOTE.D5, NOTE.Fs5, NOTE.A5, NOTE.D6, NOTE.Fs6, NOTE.A6].slice(0, n * 2 - 2).forEach((midi, i) => {
          k.tone(out, home + 0.12 + i * 0.07, { freq: midiToHz(midi), dur: 0.8, gain: 0.04, send: 0.7 });
          V('ping', home, 0.08, { at: 0.12 + i * 0.07, rate: midiToHz(midi) / 1976, jitter: 0, send: 0.7 });
        });
        V('bell', home, 0.3, { at: 0.4, variant: 2, rate: TUNED.BELL2_D3, jitter: 0, send: 0.9 });
      }
      k.g.duckMusic(0.5, Math.max(0, t - k.now()) + end + 1, 1);
    },
    /** A relic shard was found; a rank-up answers with a rising sweep, a bell and the octave. */
    relicShard(rankUp: boolean, t = k.now()): void {
      const { V, out } = k.bigMix(LV.relic);
      // something old and hard comes to hand: stone, a ring of metal, a strange little chord (D minor add 9)
      V('glass.mid', t, 0.35, { rate: 0.75, lpf: 3200, send: 0.5 });
      V('hit.ring', t, 0.18, { rate: 0.8, send: 0.6 });
      V('shimmer', t, 0.1, { reverse: true, fit: 0.35, send: 0.6 });
      [NOTE.D5, NOTE.F5, NOTE.A5, NOTE.E6].forEach((n, i) => {
        k.tone(out, t + 0.05 + i * 0.085, { freq: midiToHz(n), dur: 0.9, gain: 0.06, send: 0.7 });
        k.tone(out, t + 0.05 + i * 0.085, { type: 'triangle', freq: midiToHz(n) / 2, dur: 0.5, gain: 0.03, send: 0.5 });
      });
      k.tone(out, t, { freq: midiToHz(NOTE.D3), dur: 0.9, gain: 0.1, attack: 0.03 });
      if (rankUp) {
        const up = t + 0.42;
        V('ui.rise', up, 0.5, { variant: 1, send: 0.4, jitter: 0 });
        V('bell', up, 0.35, { at: 0.12, variant: 1, rate: TUNED.BELL1_D4 * 2, jitter: 0, send: 0.8 });
        [NOTE.D6, NOTE.Fs6, NOTE.A6].forEach((n, i) => k.tone(out, up + 0.12 + i * 0.06, { freq: midiToHz(n), dur: 0.9, gain: 0.05, send: 0.7 }));
        k.tone(out, up, { type: 'triangle', freq: midiToHz(NOTE.D4), freqEnd: midiToHz(NOTE.D5), dur: 0.2, gain: 0.07 });
      }
    },
    /** A feat of the Chronicle became claimable: a small gong and a quill stroke. */
    featReady(t = k.now()): void {
      const { V, out } = k.bigMix(LV.feat);
      V('bong', t, 0.7, { rate: 0.8, send: 0.6, jitter: 0 });
      V('ui.card', t, 0.4, { at: 0.08, variant: 2 });
      k.tone(out, t, { freq: midiToHz(NOTE.A3), dur: 0.9, gain: 0.1, send: 0.6 });
      [NOTE.A4, NOTE.D5].forEach((n, i) => k.tone(out, t + 0.1 + i * 0.09, { type: 'triangle', freq: midiToHz(n), dur: 0.6, gain: 0.06, send: 0.6 }));
    },
    /** The whole reward sequence of a finished run, in order: experience, level-up, relics, feats. */
    progress(cue: ProgressCue): void {
      const t = k.now();
      if (k.take('progress', t) < 0) return;
      let at = api.xpTicks(cue.xp, t);
      if (cue.levelsGained > 0) {
        api.levelUp(cue.levelsGained, t + at);
        at += cue.levelsGained > 1 ? 2.3 : 1.3;
      }
      cue.relics.slice(0, PROGRESS.RELICS_MAX).forEach((relic, i) => {
        // more shards than chimes: the last chime stands for the rest
        const rankUp = relic.rankUp || (i === PROGRESS.RELICS_MAX - 1 && cue.relics.slice(i).some((r) => r.rankUp));
        api.relicShard(rankUp, t + at);
        at += PROGRESS.RELIC_GAP + (rankUp ? 0.5 : 0);
      });
      if (cue.featsReady > 0) api.featReady(t + at + 0.1);
    },

    // ------------------------------------------------------------ purchases on the progression pages (dry)
    /** An Ascension rank: coin, then an endless-sounding rise that does not resolve (there is always one more). */
    ascendRank(): void {
      const t = k.now();
      if (k.take('ui', t) < 0) return;
      const { V, out } = k.uiMix(LV.ascend);
      V('ui.coins', t, 0.5, { variant: 2 });
      V('ui.rise', t, 0.5, { at: 0.06, variant: 1, jitter: 0 });
      [NOTE.D5, NOTE.A5, NOTE.E6].forEach((n, i) => {
        k.tone(out, t + 0.08 + i * 0.06, { freq: midiToHz(n), dur: 0.7, gain: 0.06 });
        k.tone(out, t + 0.08 + i * 0.06, { freq: midiToHz(n) * 2.76, dur: 0.2, gain: 0.012 });
      });
      k.tone(out, t + 0.06, { type: 'triangle', freq: midiToHz(NOTE.D4), freqEnd: midiToHz(NOTE.D5), dur: 0.3, gain: 0.05 });
    },
    /** A talent chosen: a page turned, a plucked decision. */
    talentPick(): void {
      const t = k.now();
      if (k.take('ui', t) < 0) return;
      const { V, out } = k.uiMix(LV.talent);
      V('ui.card', t, 0.5, { variant: 2 });
      V('pluck', t, 0.7, { at: 0.05, variant: 1, jitter: 0 });
      V('pluck', t, 0.6, { at: 0.14, variant: 2, rate: 1.5, jitter: 0 });
      [NOTE.A4, NOTE.D5].forEach((n, i) => k.tone(out, t + 0.05 + i * 0.09, { type: 'triangle', freq: midiToHz(n), dur: 0.4, gain: 0.07, lpf: 4000 }));
    },
    /** A relic set into its slot: weight put down, a low hum, a glint. */
    relicEquip(): void {
      const t = k.now();
      if (k.take('ui', t) < 0) return;
      const { V, out } = k.uiMix(LV.relicEquip);
      V('ui.book', t, 0.8, { variant: 1 });
      V('foley.latch', t, 0.3, { at: 0.07, variant: 1 });
      k.tone(out, t + 0.02, { freq: 130, freqEnd: 70, dur: 0.25, gain: 0.16 });
      k.tone(out, t + 0.07, { freq: midiToHz(NOTE.D4), dur: 0.7, gain: 0.05 });
      k.tone(out, t + 0.07, { freq: midiToHz(NOTE.A4) * 1.003, dur: 0.7, gain: 0.04 });
      V('ping', t, 0.12, { at: 0.12, variant: 1, rate: 0.75 });
    },
    /** A feat claimed: Glimmer pours out, a gong seals it. */
    claim(): void {
      const t = k.now();
      if (k.take('ui', t) < 0) return;
      const { V, out } = k.uiMix(LV.claim);
      V('ui.coins', t, 0.7, { variant: 1 });
      V('ui.coins', t, 0.4, { at: 0.12, variant: 2, rate: 1.2 });
      V('bong', t, 0.5, { at: 0.04, jitter: 0 });
      [NOTE.D5, NOTE.Fs5, NOTE.A5].forEach((n, i) => k.tone(out, t + 0.1 + i * 0.06, { type: 'triangle', freq: midiToHz(n), dur: 0.5, gain: 0.06, lpf: 5000 }));
    },
    /** A different art (secondary variant) chosen in the loadout: steel changing hands. */
    artPick(): void {
      const t = k.now();
      if (k.take('ui', t) < 0) return;
      const { V, out } = k.uiMix(LV.art);
      V('ui.equip', t, 0.5, { variant: 2 });
      V('swing.draw', t, 0.4, { at: 0.04, rate: 1.2 });
      k.tone(out, t + 0.1, { freq: midiToHz(NOTE.A5), dur: 0.3, gain: 0.03 });
    },

    // ------------------------------------------------------------ run: sets, legendary boons, affixes, descent
    /** A set bonus switched on. Tier 2 is the full chord; element sets carry their element's colour. */
    setBonus(tier: number, el: ElementId | null, own: boolean): void {
      const t = k.now();
      if (k.take('set', t) < 0) return;
      const { V, out } = k.bigMix(own ? LV.setOwn : LV.setAlly);
      const full = tier >= 2;
      // pieces clicking into place, one per boon, then the chord they make together
      const pieces = full ? 4 : 3;
      for (let i = 0; i < pieces; i++) {
        V('foley.latch', t, 0.35, { at: i * 0.07, variant: 2, rate: 1 + i * 0.1, jitter: 0.01 });
        k.tone(out, t + i * 0.07, { type: 'square', freq: midiToHz(NOTE.D5 + i * (full ? 3 : 4)), dur: 0.05, gain: 0.03, lpf: 4000 });
      }
      const lock = t + pieces * 0.07 + 0.03;
      const chord = full ? [NOTE.D4, NOTE.A4, NOTE.D5, NOTE.Fs5, NOTE.A5, NOTE.D6] : [NOTE.D4, NOTE.A4, NOTE.D5];
      chord.forEach((n, i) => k.tone(out, lock + i * 0.015, { type: 'triangle', freq: midiToHz(n), dur: full ? 1.5 : 1, gain: own ? 0.06 : 0.035, attack: 0.01, send: 0.65 }));
      k.tone(out, lock, { freq: midiToHz(NOTE.D3), dur: 0.8, gain: own ? 0.14 : 0.06 });
      if (own) {
        V('hit.ring', lock, 0.2, { rate: 0.75, send: 0.6 });
        V('bell', lock, full ? 0.4 : 0.2, { variant: 1, rate: TUNED.BELL1_D4, jitter: 0, send: 0.8 });
        if (full) V('shimmer', lock, 0.14, { rate: 0.75, attack: 0.03, send: 0.8, jitter: 0 });
        if (el) k.element(el, lock, full ? 0.3 : 0.2, 1, VOICES.PRI.OWN);
        k.g.duckMusic(0.65, 0.5, 0.6);
      }
    },
    /** A legendary boon lies among the draft cards: a held, glittering breath. */
    legendaryOffered(): void {
      const t = k.now();
      const { V, out } = k.bigMix(LV.legendaryOffer);
      V('shimmer', t, 0.2, { rate: 0.6, attack: 0.15, send: 0.8, jitter: 0 });
      V('ping', t, 0.12, { at: 0.2, variant: 2, rate: TUNED.PING_TO_D7 / 2, jitter: 0, send: 0.8 });
      for (const n of [NOTE.D5, NOTE.A5, NOTE.E6]) {
        k.tone(out, t, { freq: midiToHz(n), dur: 1.6, gain: 0.035, attack: 0.3, hold: 0.4, vib: 8, vibHz: 4.2, send: 0.7 });
      }
      k.noise(out, t, { dur: 1.4, gain: 0.03, filter: 'bandpass', freq: 6500, q: 3, attack: 0.4, hold: 0.3, send: 0.6 });
      k.tone(out, t, { freq: midiToHz(NOTE.D3), dur: 1.2, gain: 0.07, attack: 0.2 });
    },
    /** A legendary boon was taken: the boon jingle's big brother. */
    legendaryPicked(own: boolean): void {
      const t = k.now();
      const { V, out } = k.bigMix(own ? LV.legendaryPick : LV.legendaryAlly);
      if (own) {
        V('boom.sub', t, 0.5);
        V('jingle.fifth', t, 0.5, { rate: TUNED.FIFTH_TO_D, jitter: 0, gainJitter: 0, send: 0.6 });
        V('bell', t, 0.45, { variant: 2, rate: TUNED.BELL2_D3, jitter: 0, send: 0.9 });
        V('arcane', t, 0.25, { variant: 1, send: 0.6, jitter: 0 });
        k.tone(out, t, { freq: 96, freqEnd: 40, dur: 0.6, gain: 0.24 });
        k.g.duckMusic(0.5, 0.9, 0.8);
      }
      const notes = own ? [NOTE.D4, NOTE.A4, NOTE.D5, NOTE.Fs5, NOTE.A5, NOTE.D6, NOTE.Fs6] : [NOTE.D5, NOTE.A5, NOTE.D6];
      notes.forEach((n, i) => {
        k.tone(out, t + 0.1 + i * 0.06, { type: 'triangle', freq: midiToHz(n), dur: 1.4, gain: own ? 0.055 : 0.035, send: 0.7 });
        if (own) k.tone(out, t + 0.1 + i * 0.06, { freq: midiToHz(n) * 2, dur: 0.5, gain: 0.015, send: 0.7 });
      });
      if (own) V('ping', t, 0.14, { at: 0.5, variant: 2, rate: TUNED.PING_TO_D7, jitter: 0, send: 0.8 });
    },
    /** An elite carries an affix: a short signature after its spawn sound. */
    affix(affix: AffixId): void {
      const t = k.now() + 0.18;
      if (k.take('affix', t) < 0) return;
      const { V, out } = k.bigMix(LV.affix);
      // every affix starts with the same low warning note, then its own colour
      k.tone(out, t, { type: 'sawtooth', freq: midiToHz(NOTE.D3), dur: 0.5, gain: 0.07, lpf: 700, attack: 0.02, send: 0.5 });
      switch (affix) {
        case 'swift':
          // two quick passes of air, the second higher
          k.whoosh(out, t, 700, 3600, 900, 0.14, 0.2);
          k.whoosh(out, t + 0.13, 900, 5200, 1200, 0.12, 0.2);
          V('swing.cloth', t, 0.5, { rate: 1.5 });
          V('swing.cloth', t, 0.5, { at: 0.13, rate: 1.8 });
          break;
        case 'armored':
          // plate on plate
          V('hit.plate', t, 0.7, { rate: 0.8, send: 0.4 });
          V('hit.clang', t, 0.5, { at: 0.09, rate: 0.7, send: 0.4 });
          V('hit.iron', t, 0.5, { rate: 0.9 });
          k.tone(out, t, { freq: 180, freqEnd: 90, dur: 0.2, gain: 0.16 });
          break;
        case 'volatile':
          // a fuse: hiss climbing towards a pop that does not come yet
          k.noise(out, t, { dur: 0.5, gain: 0.2, filter: 'bandpass', freq: 2200, freqEnd: 7000, q: 2, attack: 0.35 });
          V('tex.fire', t, 1.6, { offset: -1, dur: 0.4, attack: 0.25, release: 0.08, hpf: 1200 });
          for (let i = 0; i < 4; i++) k.noise(out, t + 0.1 + i * 0.1, { dur: 0.02, gain: 0.2, filter: 'highpass', freq: 4500 });
          k.tone(out, t, { type: 'square', freq: 440, freqEnd: 1320, dur: 0.5, gain: 0.03, lpf: 3000, attack: 0.3 });
          break;
        case 'vampiric':
          // a wet, low breath in and a minor second
          k.element('umbra', t, 0.3, 1, VOICES.PRI.WORLD);
          V('slime', t, 0.3, { rate: 0.5, lpf: 1200, send: 0.5 });
          for (const n of [NOTE.D4, NOTE.D4 + 1]) k.tone(out, t, { type: 'sawtooth', freq: midiToHz(n), dur: 0.6, gain: 0.05, lpf: 900, attack: 0.1, send: 0.6 });
          break;
      }
    },
    /**
     * The party goes one depth deeper: the Last Bell struck three times, each strike lower, over a long drop into
     * the sub. Deeper depths start lower.
     */
    descend(depth: number): void {
      const t = k.now();
      if (k.take('big', t) < 0) return;
      const { V, out } = k.bigMix(LV.descend);
      const down = -Math.min(PROGRESS.DEPTH_SEMITONES_MAX, Math.max(0, depth - 1));
      const shift = Math.pow(2, down / 12);
      // strikes on D, A below, D below: a falling fifth and fourth, each bell also bending down
      const strikes: [number, number, number][] = [[0, 12, 0.6], [0.55, 7, 0.55], [1.1, 0, 0.7]];
      for (const [at, semi, gain] of strikes) {
        const f = midiToHz(NOTE.D3 + semi) * shift;
        V('bell', t, gain, { at, variant: 2, rate: (f / 240), jitter: 0, send: 0.9 });
        k.tone(out, t + at, { freq: f, freqEnd: f * 0.84, dur: 1.8, gain: 0.1, send: 0.7 });
        k.tone(out, t + at, { freq: f * 2.76, freqEnd: f * 2.76 * 0.84, dur: 0.9, gain: 0.03, send: 0.6 });
        k.tone(out, t + at, { freq: f * 5.4, freqEnd: f * 5.4 * 0.84, dur: 0.4, gain: 0.012 });
      }
      // the drop: everything falls away under the last strike
      V('sub.drop', t, 0.9, { at: 1.1, rate: 0.9 * shift, jitter: 0 });
      V('boom.sub', t, 0.7, { at: 1.1, rate: 0.75 });
      V('door.close', t, 0.4, { at: 1.15, rate: 0.6, lpf: 1600, send: 0.7 });
      k.tone(out, t + 1.1, { freq: 110 * shift, freqEnd: 24, dur: 2, gain: 0.5, attack: 0.01 });
      k.tone(out, t, { type: 'sawtooth', freq: 147 * shift, freqEnd: 55 * shift, dur: 2.6, gain: 0.05, lpf: 900, lpfEnd: 200, attack: 0.3, hold: 0.6, send: 0.6 });
      k.noise(out, t, { dur: 3, gain: 0.14, filter: 'lowpass', freq: 2400, freqEnd: 90, attack: 0.5, hold: 0.4, send: 0.6 });
      // air rushing up past the party
      k.noise(out, t + 0.2, { dur: 2.2, gain: 0.07, filter: 'bandpass', freq: 3000, freqEnd: 300, q: 1.5, attack: 0.6, send: 0.5 });
      k.g.duckMusic(0.3, 2.4, 1.6);
    },
  };

  return { api };
}
