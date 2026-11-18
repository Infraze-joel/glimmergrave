/**
 * Update 4, chamber objectives: the intro stinger of each objective, brazier ignitions, the bell shard being
 * struck and shattering, the hunt's enrage, the last seconds of a timer, the end of an objective with and
 * without its bonus, and the reliquary of a vault.
 *
 * Everything is on the `big` bus (room, may duck the score) except the timer, which is dry on the interface bus:
 * it is information, like the draft countdown. All sounds work without samples.
 */
import type { ObjectiveKind } from '@shared/types.ts';
import { midiToHz } from './engine.ts';
import { NOTE, rnd, TUNED, type SfxKit } from './sfx-kit.ts';

const LV = {
  startSurvive: 0.5, startDefend: 0.75, startHunt: 0.6, startRitual: 1, startVault: 0.9,
  site: 0.42, siteAll: 0.5, anchorHit: 0.6, shatter: 0.85, enrage: 0.8, bonusLost: 0.7,
  done: 0.6, doneBonus: 1.1, reliquary: 0.85, timer: 0.8, timerLast: 1,
  /** The three timer voices are built differently; these bring them to the same loudness. */
  timerKind: { survive: 1, hunt: 1.5, ritual: 2.2 } as Partial<Record<ObjectiveKind, number>>,
} as const;

export const OBJECTIVE_SFX = {
  /** The timer layer starts this many seconds before the end. */
  TIMER_SECONDS: 10,
  /** From here on every second also gets a half-second pick-up. */
  TIMER_URGENT: 3,
  /** Braziers beyond this count keep the last pitch. */
  SITES_MAX: 6,
  /** Shard health under which the alarm is at its most urgent. */
  ANCHOR_CRITICAL: 0.3,
} as const;

/** Objectives that carry a timer whose last seconds are sounded. */
export const TIMED_OBJECTIVES: readonly ObjectiveKind[] = ['survive', 'hunt', 'ritual'];

/** Brazier notes, one step higher per lit brazier: D minor climbing to the octave. */
const SITE_NOTES = [NOTE.D4, NOTE.F4, NOTE.A4, NOTE.D5, NOTE.F5, NOTE.A5];

export function createObjectiveSfx(k: SfxKit) {
  const brass = (out: AudioNode, t: number, midi: number, dur: number, gain: number): void => {
    for (const detune of [-7, 6]) {
      k.tone(out, t, { type: 'sawtooth', freq: midiToHz(midi), detune, dur, gain, lpf: 600, lpfEnd: 2200, q: 1.4, attack: 0.02, hold: dur * 0.5, send: 0.5 });
    }
    k.tone(out, t, { type: 'triangle', freq: midiToHz(midi), dur, gain: gain * 0.8, attack: 0.015, hold: dur * 0.5, send: 0.5 });
  };
  const fire = (out: AudioNode, t: number, gain: number): void => {
    k.noise(out, t, { dur: 0.5, gain, filter: 'bandpass', freq: 500, freqEnd: 2600, q: 1, attack: 0.12, send: 0.4 });
    for (let i = 0; i < 3; i++) k.noise(out, t + 0.1 + i * rnd(0.05, 0.1), { dur: 0.02, gain: gain * rnd(0.3, 0.6), filter: 'bandpass', freq: rnd(2500, 4500), q: 2 });
  };

  const api = {
    /**
     * The chamber's objective begins: one short stinger per kind, each with its own gesture.
     *   survive – a low bell and two drum beats: hold until it tolls again
     *   defend  – the shard rings: a high, held fifth
     *   hunt    – a horn call, a rising fourth over a drum pick-up
     *   ritual  – three flames catching, D-F-A upwards
     *   vault   – coins and a warm major chord
     *   slay    – nothing new: the wave drums are its opening
     */
    objectiveStart(kind: ObjectiveKind): void {
      if (kind === 'slay') return;
      const t = k.now();
      if (k.take('objective', t) < 0) return;
      const level = { survive: LV.startSurvive, defend: LV.startDefend, hunt: LV.startHunt, ritual: LV.startRitual, vault: LV.startVault }[kind];
      const { V, out } = k.bigMix(level);
      switch (kind) {
        case 'survive':
          V('bell', t, 0.6, { variant: 2, rate: TUNED.BELL2_D3 / 2, lpf: 800, dur: 0.9, release: 0.4, jitter: 0, send: 0.7 });
          k.tone(out, t, { freq: midiToHz(NOTE.D2), freqEnd: midiToHz(NOTE.D2) * 0.97, dur: 1.2, gain: 0.16, send: 0.5 });
          k.tone(out, t, { freq: midiToHz(NOTE.D2) * 2.76, dur: 0.6, gain: 0.04, send: 0.4 });
          V('drum.war', t, 0.7, { at: 0.42, variant: 2, rate: 0.8, lpf: 900, send: 0.4 });
          V('drum.war', t, 0.85, { at: 0.64, variant: 1, rate: 0.75, lpf: 900, send: 0.4 });
          for (const at of [0.42, 0.64]) k.tone(out, t + at, { freq: 92, freqEnd: 40, dur: 0.3, gain: 0.26 });
          break;
        case 'defend':
          V('bell', t, 0.4, { variant: 1, rate: TUNED.BELL1_D4 * 4, hpf: 700, jitter: 0, send: 0.9 });
          V('shimmer', t, 0.3, { rate: 1, attack: 0.05, send: 0.8, jitter: 0 });
          V('glass.light', t, 0.4, { rate: 1.2, send: 0.6 });
          V('ping', t, 0.2, { variant: 2, rate: TUNED.PING_TO_D7, jitter: 0, send: 0.8 });
          for (const [n, gain] of [[NOTE.D6, 0.06], [NOTE.A6, 0.05], [NOTE.D6 + 12, 0.035], [NOTE.A6 + 12, 0.02]] as const) {
            k.tone(out, t, { freq: midiToHz(n), dur: 1.3, gain, attack: 0.02, hold: 0.5, vib: 5, vibHz: 3.5, send: 0.7 });
          }
          k.noise(out, t, { dur: 0.9, gain: 0.05, filter: 'highpass', freq: 6000, attack: 0.05, hold: 0.3, send: 0.6 });
          break;
        case 'hunt':
          V('drum.low', t, 0.6, { rate: 1.2 });
          V('drum.low', t, 0.7, { at: 0.1, rate: 1.2 });
          V('drum.war', t, 0.6, { at: 0.2, variant: 1, send: 0.4 });
          brass(out, t + 0.02, NOTE.A3, 0.2, 0.08);
          brass(out, t + 0.2, NOTE.D4, 0.75, 0.09);
          brass(out, t + 0.2, NOTE.A4, 0.75, 0.04);
          k.tone(out, t + 0.2, { freq: 98, freqEnd: 44, dur: 0.35, gain: 0.2 });
          break;
        case 'ritual':
          [NOTE.D4, NOTE.F4, NOTE.A4].forEach((n, i) => {
            const at = t + i * 0.17;
            fire(out, at, 0.07);
            k.tone(out, at, { type: 'triangle', freq: midiToHz(n), dur: 0.7, gain: 0.14, attack: 0.03, send: 0.65 });
            k.tone(out, at, { type: 'sawtooth', freq: midiToHz(n), dur: 0.4, gain: 0.05, lpf: 2400, lpfEnd: 900, attack: 0.02, send: 0.5 });
            k.tone(out, at, { freq: midiToHz(n) * 2, dur: 0.3, gain: 0.03, send: 0.6 });
            V('tex.fire', at, 0.7, { offset: -1, dur: 0.22, attack: 0.05, release: 0.15, hpf: 600, lpf: 5000 });
          });
          k.tone(out, t, { freq: midiToHz(NOTE.D3), dur: 1, gain: 0.08, attack: 0.1 });
          break;
        case 'vault':
          V('ui.coins', t, 0.35, { variant: 1, lpf: 6000, send: 0.4 });
          V('foley.latch', t, 0.3, { at: 0.05, variant: 1 });
          [NOTE.D4, NOTE.Fs4, NOTE.A4, NOTE.E5].forEach((n, i) => {
            k.tone(out, t + 0.1 + i * 0.07, { type: 'triangle', freq: midiToHz(n), dur: 1.3, gain: 0.09, attack: 0.03, send: 0.7 });
          });
          V('ping', t, 0.12, { at: 0.4, variant: 2, rate: TUNED.PING_TO_D7 / 2, jitter: 0, send: 0.8 });
          k.tone(out, t + 0.1, { freq: midiToHz(NOTE.D3), dur: 1.2, gain: 0.08, attack: 0.08 });
          break;
      }
      k.g.duckMusic(0.6, 0.5, 0.6);
    },
    /**
     * A brazier caught fire. `lit` = how many burn now (1-based), `total` = how many there are: the note climbs with
     * every one, and the last one closes the chord.
     */
    siteLit(lit: number, total: number): void {
      const t = k.now();
      if (k.take('site', t) < 0) return;
      const all = lit >= total;
      const { V, out } = k.bigMix(all ? LV.siteAll : LV.site);
      const step = Math.max(0, Math.min(OBJECTIVE_SFX.SITES_MAX, lit) - 1);
      const n = SITE_NOTES[Math.min(SITE_NOTES.length - 1, step)];
      // ignition: a rush of air into flame, crackle, a struck bowl
      k.noise(out, t, { dur: 0.6, gain: 0.2, filter: 'bandpass', freq: 300, freqEnd: 2400 + step * 500, q: 0.9, attack: 0.16, send: 0.4 });
      k.tone(out, t, { type: 'sawtooth', freq: 90, freqEnd: 150, dur: 0.4, gain: 0.14, lpf: 500, attack: 0.1 });
      V('tex.fire', t, 2, { offset: -1, dur: 0.5, attack: 0.1, release: 0.35, lpf: 6000, rate: 1 + step * 0.08, send: 0.3 });
      V('tex.fireLow', t, 1.2, { offset: -1, dur: 0.5, attack: 0.08, release: 0.3 });
      V('pot', t, 0.3, { at: 0.1, variant: 1, rate: midiToHz(n) / midiToHz(NOTE.D4), send: 0.5 });
      for (let i = 0; i < 5; i++) k.noise(out, t + 0.15 + i * rnd(0.04, 0.09), { dur: 0.02, gain: rnd(0.12, 0.25), filter: 'highpass', freq: rnd(3000, 5600) });
      k.tone(out, t + 0.1, { type: 'triangle', freq: midiToHz(n), dur: 1.1, gain: 0.2, attack: 0.02, send: 0.7 });
      k.tone(out, t + 0.1, { freq: midiToHz(n) * 2, dur: 0.5, gain: 0.05, send: 0.6 });
      k.tone(out, t + 0.1, { freq: midiToHz(n) / 2, dur: 0.8, gain: 0.05 });
      if (all) {
        // every brazier burns: the notes heard so far sound together, with the octave on top
        const chord = SITE_NOTES.slice(0, Math.min(SITE_NOTES.length, Math.max(3, total)));
        chord.forEach((m, i) => k.tone(out, t + 0.32 + i * 0.03, { type: 'triangle', freq: midiToHz(m), dur: 1.5, gain: 0.055, attack: 0.02, send: 0.7 }));
        V('bell', t, 0.35, { at: 0.32, variant: 1, rate: TUNED.BELL1_D4, jitter: 0, send: 0.8 });
        k.noise(out, t + 0.3, { dur: 1, gain: 0.1, filter: 'bandpass', freq: 900, freqEnd: 3600, q: 0.8, attack: 0.2, send: 0.5 });
        k.g.duckMusic(0.6, 0.7, 0.8);
      }
    },
    /**
     * The bell shard was struck (`hp` = its health 0..1 if known). A short cracked ring and a two-note alarm that
     * gets higher and closer together as the shard weakens. Never more often than LIMITS.anchor allows.
     */
    anchorHit(hp = 1): void {
      const t = k.now();
      if (k.take('anchor', t) < 0) return;
      const danger = 1 - Math.max(0, Math.min(1, hp));
      const critical = hp <= OBJECTIVE_SFX.ANCHOR_CRITICAL;
      const { V, out } = k.bigMix(LV.anchorHit * (1 + danger * 0.35));
      V('bell', t, 0.4, { variant: 3, rate: 1.2 + danger * 0.3, dur: 0.3, release: 0.2, jitter: 0, send: 0.6 });
      V('hit.dull', t, 0.5, { rate: 0.9 });
      V('glass.light', t, 0.2 + danger * 0.2, { rate: 0.9, send: 0.4 });
      k.tone(out, t, { freq: 200, freqEnd: 110, dur: 0.1, gain: 0.14 });
      // alarm: a minor second, soft; when the shard is nearly gone it comes twice
      const base = NOTE.A5 + Math.round(danger * 5);
      const gap = 0.11 - danger * 0.04;
      for (let rep = 0; rep < (critical ? 2 : 1); rep++) {
        for (const [i, n] of [base, base + 1].entries()) {
          k.tone(out, t + 0.05 + rep * gap * 2.4 + i * gap, { type: 'triangle', freq: midiToHz(n), dur: 0.16, gain: 0.05 + danger * 0.03, lpf: 5000, send: 0.5 });
        }
      }
    },
    /** The shard shattered (defend, bonus lost): the bell breaks, its pieces fall, the note sinks. */
    anchorShatter(): void {
      const t = k.now();
      if (k.take('big', t) < 0) return;
      const { V, out } = k.bigMix(LV.shatter);
      k.noise(out, t, { dur: 0.014, gain: 0.8, filter: 'highpass', freq: 5500 });
      V('bell', t, 0.7, { variant: 1, rate: TUNED.BELL1_D4, jitter: 0, send: 0.9 });
      V('glass.heavy', t, 0.9, { rate: 0.8, send: 0.5 });
      V('glass.mid', t, 0.7, { at: 0.04, rate: 0.7, send: 0.5 });
      V('hit.clang', t, 0.5, { rate: 0.6, send: 0.5 });
      V('boom.sub', t, 0.5, { rate: 0.9 });
      // the bell's note bends down and dies: it will not ring again
      for (const [mul, gain, dur] of [[1, 0.14, 1.4], [2.76, 0.05, 0.8], [5.4, 0.02, 0.4]] as const) {
        k.tone(out, t, { freq: midiToHz(NOTE.D4) * mul, freqEnd: midiToHz(NOTE.D4) * mul * 0.7, dur, gain, send: 0.7 });
      }
      for (const n of [NOTE.D4, NOTE.F4, NOTE.Gs4]) k.tone(out, t + 0.1, { type: 'sawtooth', freq: midiToHz(n), freqEnd: midiToHz(n) * 0.94, dur: 1.2, gain: 0.04, lpf: 1200, attack: 0.05, send: 0.6 });
      for (let i = 0; i < 8; i++) V('glass.light', t, 0.5 - i * 0.05, { at: 0.1 + i * rnd(0.05, 0.11), rate: 0.8 + i * 0.12, send: 0.55 });
      k.tone(out, t, { freq: 120, freqEnd: 32, dur: 0.9, gain: 0.34 });
      k.g.duckMusic(0.4, 0.8, 1);
    },
    /** The hunt's timer ran out: the marked elites enrage. A roar breaking upwards over a tritone and a drum. */
    huntEnrage(): void {
      const t = k.now();
      if (k.take('big', t) < 0) return;
      const { V, out } = k.bigMix(LV.enrage);
      V('boom', t, 0.4, { variant: 3, reverse: true, fit: 0.3 });
      const hit = t + 0.28;
      for (const [f, detune] of [[73, -12], [110, 9], [147, 0]] as const) {
        k.tone(out, hit, { type: 'sawtooth', freq: f, freqEnd: f * 1.5, detune, dur: 0.9, gain: 0.14, lpf: 500, lpfEnd: 2600, q: 2, attack: 0.04, hold: 0.3, am: 0.8, amHz: 31, send: 0.5 });
      }
      k.noise(out, hit, { dur: 0.8, gain: 0.2, filter: 'bandpass', freq: 700, freqEnd: 2200, q: 1.2, attack: 0.05, hold: 0.2, send: 0.5 });
      V('drum.war', hit, 0.9, { variant: 1, rate: 0.8, send: 0.4 });
      V('boom.sub', hit, 0.5);
      for (const n of [NOTE.D4, NOTE.Gs4]) k.tone(out, hit, { type: 'sawtooth', freq: midiToHz(n), dur: 0.5, gain: 0.05, lpf: 2400, send: 0.5 });
      k.tone(out, hit, { freq: 100, freqEnd: 40, dur: 0.5, gain: 0.3 });
      k.g.duckMusic(0.5, 0.7, 0.8);
    },
    /** The bonus of a survive / ritual chamber was lost: two soft falling notes, no drama. The fight goes on. */
    bonusLost(): void {
      const t = k.now();
      if (k.take('objective', t) < 0) return;
      const { V, out } = k.bigMix(LV.bonusLost);
      for (const [i, n] of [NOTE.A4, NOTE.Gs4].entries()) {
        k.tone(out, t + i * 0.16, { type: 'triangle', freq: midiToHz(n), dur: 0.5, gain: 0.08, lpf: 2400, send: 0.6 });
      }
      k.tone(out, t + 0.16, { freq: midiToHz(NOTE.D3), dur: 0.6, gain: 0.08 });
      V('hit.dull', t, 0.3, { rate: 0.7, lpf: 1800 });
    },
    /**
     * The objective is complete. With the bonus: a bright run up to the octave, a bell and Glimmer pouring. Without:
     * one plain low bell on an open fifth. Short on purpose, the chamber-clear jingle may follow. Vault: the reliquary.
     */
    objectiveDone(kind: ObjectiveKind, bonus: boolean): void {
      if (kind === 'slay') return;
      if (kind === 'vault') { api.reliquaryOpen(); return; }
      const t = k.now();
      if (k.take('objective', t) < 0) return;
      const { V, out } = k.bigMix(bonus ? LV.doneBonus : LV.done);
      if (bonus) {
        [NOTE.D4, NOTE.Fs4, NOTE.A4, NOTE.D5, NOTE.Fs5, NOTE.A5, NOTE.D6].forEach((n, i) => {
          k.tone(out, t + i * 0.055, { type: 'triangle', freq: midiToHz(n), dur: 0.9, gain: 0.06, send: 0.7 });
          k.tone(out, t + i * 0.055, { freq: midiToHz(n) * 2, dur: 0.25, gain: 0.015, send: 0.6 });
        });
        V('bell', t, 0.4, { at: 0.33, variant: 1, rate: TUNED.BELL1_D4 * 2, jitter: 0, send: 0.8 });
        V('ui.rise', t, 0.4, { variant: 1, jitter: 0, send: 0.4 });
        V('ui.coins', t, 0.6, { at: 0.36, variant: 1, send: 0.3 });
        V('ui.coins', t, 0.4, { at: 0.5, variant: 2, rate: 1.2, send: 0.3 });
        V('ping', t, 0.14, { at: 0.38, variant: 2, rate: TUNED.PING_TO_D7, jitter: 0, send: 0.8 });
        k.tone(out, t, { freq: midiToHz(NOTE.D3), dur: 1, gain: 0.1, attack: 0.03 });
      } else {
        V('bell', t, 0.4, { variant: 2, rate: TUNED.BELL2_D3, lpf: 2400, jitter: 0, send: 0.8 });
        for (const n of [NOTE.D3, NOTE.A3]) k.tone(out, t, { type: 'triangle', freq: midiToHz(n), dur: 1, gain: 0.08, attack: 0.02, send: 0.6 });
        k.tone(out, t, { freq: midiToHz(NOTE.D2), dur: 0.9, gain: 0.12 });
      }
    },
    /** The vault's reliquary opens: latch, a heavy lid, Glimmer and pouches, a warm chord unfolding. */
    reliquaryOpen(): void {
      const t = k.now();
      if (k.take('objective', t) < 0) return;
      const { V, out } = k.bigMix(LV.reliquary);
      V('foley.latch', t, 0.6, { variant: 1, rate: 0.85, jitter: 0.01 });
      V('foley.latch', t, 0.5, { at: 0.12, variant: 2, rate: 0.8, jitter: 0.01 });
      V('creak', t, 0.4, { at: 0.2, rate: 0.7, send: 0.5 });
      V('lid', t, 0.8, { at: 0.72, rate: 0.6, send: 0.4 });
      k.tone(out, t + 0.72, { freq: 130, freqEnd: 60, dur: 0.3, gain: 0.2 });
      // light from inside
      const open = t + 0.36;
      V('shimmer', open, 0.2, { rate: 0.7, attack: 0.2, send: 0.8, jitter: 0 });
      k.noise(out, open, { dur: 1.4, gain: 0.05, filter: 'bandpass', freq: 5500, q: 2.5, attack: 0.5, hold: 0.3, send: 0.6 });
      [NOTE.D4, NOTE.A4, NOTE.D5, NOTE.Fs5, NOTE.A5, NOTE.E6].forEach((n, i) => {
        k.tone(out, open + i * 0.09, { type: 'triangle', freq: midiToHz(n), dur: 1.8, gain: 0.05, attack: 0.05, send: 0.7 });
      });
      k.tone(out, open, { freq: midiToHz(NOTE.D3), dur: 1.6, gain: 0.1, attack: 0.15, hold: 0.5 });
      // what is in it
      V('ui.coins', open, 0.7, { at: 0.5, variant: 1, send: 0.3 });
      V('pouch', open, 0.6, { at: 0.72, variant: 1 });
      V('ui.coins', open, 0.5, { at: 0.9, variant: 2, rate: 1.15, send: 0.3 });
      V('pouch', open, 0.5, { at: 1.1, variant: 2 });
      V('ping', open, 0.14, { at: 0.55, variant: 2, rate: TUNED.PING_TO_D7 / 2, jitter: 0, send: 0.8 });
      V('bell', open, 0.25, { at: 0.5, variant: 1, rate: TUNED.BELL1_D4, jitter: 0, send: 0.8 });
      k.g.duckMusic(0.6, 1.2, 1);
    },
    /**
     * One second of an objective's last seconds, scheduled at audio time `t` (the caller keeps the clock).
     * `left` = whole seconds remaining when it sounds. The three timed objectives differ:
     *   survive – the bell that will end it is already swinging: a soft toll per second, growing
     *   hunt    – a dry tick over a heartbeat: the quarry is getting away
     *   ritual  – a tick with a spit of fire
     * The pitch climbs second by second; the last three seconds get a pick-up on the half second.
     */
    timerTick(kind: ObjectiveKind, left: number, t: number = k.now()): void {
      const span = OBJECTIVE_SFX.TIMER_SECONDS;
      const p = 1 - Math.max(0, Math.min(span, left)) / span; // 0 at ten seconds, towards 1 at the end
      const urgent = left <= OBJECTIVE_SFX.TIMER_URGENT;
      const { V, out } = k.uiMix((urgent ? LV.timerLast : LV.timer) * (0.6 + 0.4 * p) * (LV.timerKind[kind] ?? 1));
      const tick = (at: number, gain: number): void => {
        V('ui.tick', at, 0.22 * gain, { variant: 1, rate: 0.9 + p * 0.5, jitter: 0, gainJitter: 0, free: true });
        k.tone(out, at, { type: 'square', freq: 660 * (1 + p * 0.5), dur: 0.06, gain: 0.1 * gain, lpf: 3200 });
        k.tone(out, at, { type: 'triangle', freq: 330 * (1 + p * 0.5), dur: 0.08, gain: 0.1 * gain });
        k.noise(out, at, { dur: 0.02, gain: 0.07 * gain, filter: 'bandpass', freq: 3200, q: 1.5 });
      };
      tick(t, 1);
      if (urgent) tick(t + 0.5, 0.6);
      if (kind === 'survive') {
        const f = midiToHz(NOTE.D3);
        k.tone(out, t, { freq: f, dur: 0.9, gain: 0.1 + 0.1 * p });
        k.tone(out, t, { freq: f * 2.76, dur: 0.4, gain: 0.03 + 0.04 * p });
        k.tone(out, t, { freq: f * 5.4, dur: 0.18, gain: 0.012 + 0.015 * p });
      } else if (kind === 'hunt') {
        k.tone(out, t, { freq: 86, freqEnd: 50, dur: 0.16, gain: 0.14 + 0.1 * p });
        k.tone(out, t + 0.17, { freq: 78, freqEnd: 46, dur: 0.14, gain: 0.08 + 0.08 * p });
      } else {
        k.noise(out, t, { dur: 0.16, gain: 0.2 + 0.16 * p, filter: 'bandpass', freq: 1800, freqEnd: 4200, q: 2, attack: 0.03 });
        k.tone(out, t, { type: 'triangle', freq: midiToHz(NOTE.A4) * (1 + p * 0.5), dur: 0.16, gain: 0.1 + 0.05 * p });
      }
    },
    /** Dev workbench / offline renders: the whole countdown from `from` seconds, scheduled ahead on the audio clock. */
    timerCountdown(kind: ObjectiveKind, from: number = OBJECTIVE_SFX.TIMER_SECONDS): void {
      const t = k.now();
      for (let left = from; left >= 1; left--) api.timerTick(kind, left, t + from - left);
    },
  };

  return { api };
}
