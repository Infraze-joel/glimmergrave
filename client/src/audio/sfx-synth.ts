/**
 * Fully synthesised one-shot sound effects (the original, sample-free set). sfx.ts uses these whenever the
 * samples a designed sound needs are missing or not decoded yet, so no event is ever silent.
 * Every sound is built from the primitives in engine.ts; a per-type limiter keeps bursts from clipping.
 */
import type { ClassId, DoorType, ElementId, EnemyKind, Hazard } from '@shared/types.ts';
import { midiToHz, noise, tone, type AudioGraph } from './engine.ts';

/** [max voices, window seconds] per sound family. */
const LIMITS = {
  hit: [4, 0.05],
  element: [3, 0.06],
  crit: [2, 0.08],
  kill: [3, 0.08],
  spawn: [3, 0.12],
  telegraph: [1, 0.12],
  aoe: [2, 0.1],
  resonance: [2, 0.12],
  cast: [4, 0.07],
  enemyCast: [2, 0.12],
  hurt: [2, 0.1],
  heal: [1, 0.2],
  shield: [2, 0.12],
  status: [2, 0.1],
  ui: [3, 0.04],
  hover: [1, 0.045],
  big: [1, 0.25],
} as const;

type Family = keyof typeof LIMITS;

const TUNE = {
  /** Each extra voice inside a limiter window is this much quieter. */
  STACK_DUCK: 0.3,
  /** Damage at which a hit reaches full weight. */
  HEAVY_DAMAGE: 60,
  OWN_GAIN: 1,
  OTHER_GAIN: 0.62,
  /** Hard cap of voices started across all families per GLOBAL_WINDOW. */
  GLOBAL_MAX: 26,
  GLOBAL_WINDOW: 0.1,
} as const;

/** D minor colours shared with the music so effects sit in the same key. */
const NOTE = { D2: 38, A2: 45, D3: 50, F3: 53, A3: 57, D4: 62, F4: 65, Fs4: 66, A4: 69, D5: 74, F5: 77, Fs5: 78, A5: 81, D6: 86, F6: 89, A6: 93 } as const;

const PAIR_ROOT: Record<string, number> = { 'ember+rime': NOTE.D4, 'ember+storm': NOTE.F4, 'rime+storm': NOTE.A4 };

export interface HitOpts {
  dmg: number;
  crit: boolean;
  el: ElementId | null;
  /** Dealt by the local hero. */
  own: boolean;
}

export type SynthSfx = ReturnType<typeof createSynthSfx>;

export function createSynthSfx(g: AudioGraph) {
  const out = g.buses.combat;
  const ui = g.ui;
  const stamps = new Map<Family, number[]>();
  const recent: number[] = [];

  /** Returns the number of same-family voices already in the window, or -1 when the sound must be dropped. */
  const take = (family: Family, t: number): number => {
    const [max, window] = LIMITS[family];
    let list = stamps.get(family);
    if (!list) { list = []; stamps.set(family, list); }
    while (list.length > 0 && t - list[0] > window) list.shift();
    while (recent.length > 0 && t - recent[0] > TUNE.GLOBAL_WINDOW) recent.shift();
    if (list.length >= max || recent.length >= TUNE.GLOBAL_MAX) return -1;
    list.push(t);
    recent.push(t);
    return list.length - 1;
  };
  const duck = (stack: number): number => 1 / (1 + stack * TUNE.STACK_DUCK);
  const now = (): number => g.ctx.currentTime;
  const jitter = (spread: number): number => 1 + (Math.random() * 2 - 1) * spread;

  // ---------------------------------------------------------------- element layers
  const elementLayer = (el: ElementId, t: number, gain: number): void => {
    if (el === 'ember') {
      noise(g, out, t, { dur: 0.2, gain: gain * 0.9, filter: 'bandpass', freq: 1700, freqEnd: 420, q: 1.2 });
      for (let i = 0; i < 3; i++) {
        noise(g, out, t + 0.02 + Math.random() * 0.14, { dur: 0.025, gain: gain * 0.7, filter: 'highpass', freq: 3200 });
      }
      tone(g, out, t, { type: 'sawtooth', freq: 150, freqEnd: 70, dur: 0.16, gain: gain * 0.6, lpf: 500 });
    } else if (el === 'rime') {
      for (const [f, d] of [[2637, 0.2], [3520, 0.15], [4699, 0.11]] as const) {
        tone(g, out, t, { freq: f * jitter(0.02), dur: d, gain: gain * 0.42, send: 0.35 });
      }
      noise(g, out, t, { dur: 0.05, gain: gain * 0.5, filter: 'highpass', freq: 6000 });
    } else {
      tone(g, out, t, { type: 'sawtooth', freq: 2200 * jitter(0.1), freqEnd: 180, dur: 0.09, gain: gain * 0.55, lpf: 5000 });
      tone(g, out, t + 0.03, { type: 'square', freq: 96, dur: 0.09, gain: gain * 0.5, lpf: 1400 });
      noise(g, out, t, { dur: 0.06, gain: gain * 0.5, filter: 'bandpass', freq: 4200, q: 3 });
    }
  };

  const whoosh = (t: number, from: number, peak: number, to: number, dur: number, gain: number): void => {
    noise(g, out, t, { dur: dur * 0.5, gain, filter: 'bandpass', freq: from, freqEnd: peak, q: 1.4, attack: dur * 0.2 });
    noise(g, out, t + dur * 0.35, { dur: dur * 0.65, gain: gain * 0.8, filter: 'bandpass', freq: peak, freqEnd: to, q: 1.4 });
  };

  const thump = (t: number, freq: number, dur: number, gain: number): void => {
    tone(g, out, t, { freq, freqEnd: freq * 0.4, dur, gain });
  };

  // ---------------------------------------------------------------- hero abilities
  const primary = (cls: ClassId, step: number, gain: number, t: number): void => {
    const finisher = step >= 2;
    switch (cls) {
      case 'knight':
        whoosh(t, 700, finisher ? 2400 : 3200, 500, finisher ? 0.24 : 0.16, gain * 0.2);
        tone(g, out, t + 0.02, { type: 'triangle', freq: (finisher ? 2100 : 2900) * jitter(0.05), dur: 0.07, gain: gain * 0.035 });
        if (finisher) thump(t + 0.05, 130, 0.16, gain * 0.2);
        break;
      case 'barbarian':
        whoosh(t, 320, step >= 1 ? 1300 : 1700, 240, step >= 1 ? 0.3 : 0.24, gain * 0.2);
        thump(t + 0.06, step >= 1 ? 95 : 120, 0.2, gain * 0.18);
        break;
      case 'mage':
        tone(g, out, t, { type: 'triangle', freq: 980 * jitter(0.06), freqEnd: 340, dur: 0.14, gain: gain * 0.36, send: 0.25 });
        tone(g, out, t, { freq: 1960 * jitter(0.06), freqEnd: 700, dur: 0.1, gain: gain * 0.14 });
        noise(g, out, t, { dur: 0.08, gain: gain * 0.12, filter: 'highpass', freq: 4500 });
        break;
      case 'rogue':
        noise(g, out, t, { dur: 0.025, gain: gain * 0.4, filter: 'highpass', freq: 2600 });
        tone(g, out, t, { type: 'triangle', freq: 340 * jitter(0.05), freqEnd: 170, dur: 0.07, gain: gain * 0.4 });
        noise(g, out, t + 0.015, { dur: 0.07, gain: gain * 0.18, filter: 'bandpass', freq: 3000, freqEnd: 1200, q: 2 });
        break;
    }
  };

  const secondary = (cls: ClassId, gain: number, t: number): void => {
    switch (cls) {
      case 'knight':
        thump(t, 150, 0.26, gain * 0.36);
        for (const f of [523, 784, 1108]) {
          tone(g, out, t + 0.07, { type: 'square', freq: f * jitter(0.01), dur: 0.2, gain: gain * 0.04, lpf: 2600, send: 0.2 });
        }
        whoosh(t, 400, 1800, 300, 0.22, gain * 0.16);
        break;
      case 'barbarian':
        for (let i = 0; i < 5; i++) whoosh(t + i * 0.26, 300, 1500 + i * 120, 260, 0.26, gain * 0.2);
        tone(g, out, t, { type: 'sawtooth', freq: 82, freqEnd: 110, dur: 1.3, gain: gain * 0.08, lpf: 420, attack: 0.1 });
        break;
      case 'mage':
        tone(g, out, t, { type: 'triangle', freq: 220, freqEnd: 990, dur: 0.55, gain: gain * 0.12, attack: 0.3, send: 0.4 });
        tone(g, out, t, { freq: 440, freqEnd: 1980, dur: 0.55, gain: gain * 0.05, attack: 0.35 });
        noise(g, out, t, { dur: 0.55, gain: gain * 0.07, filter: 'bandpass', freq: 800, freqEnd: 5200, q: 2, attack: 0.4 });
        break;
      case 'rogue':
        for (let i = 0; i < 5; i++) {
          noise(g, out, t + i * 0.018, { dur: 0.03, gain: gain * 0.13, filter: 'highpass', freq: 3000 + i * 300 });
          tone(g, out, t + i * 0.018, { type: 'triangle', freq: 2400 + i * 180, dur: 0.05, gain: gain * 0.03 });
        }
        whoosh(t, 900, 3400, 700, 0.18, gain * 0.14);
        break;
    }
  };

  return {
    // ------------------------------------------------------------ UI
    hover(): void {
      const t = now();
      if (take('hover', t) < 0) return;
      tone(g, ui, t, { freq: 1900, freqEnd: 2300, dur: 0.035, gain: 0.1 });
    },
    click(): void {
      const t = now();
      if (take('ui', t) < 0) return;
      tone(g, ui, t, { type: 'triangle', freq: 540, freqEnd: 320, dur: 0.07, gain: 0.22 });
      noise(g, ui, t, { dur: 0.02, gain: 0.07, filter: 'highpass', freq: 3200 });
    },
    ready(on: boolean): void {
      const t = now();
      if (take('ui', t) < 0) return;
      const notes = on ? [NOTE.D5, NOTE.A5] : [NOTE.A4, NOTE.D4];
      notes.forEach((n, i) => tone(g, ui, t + i * 0.08, { type: 'triangle', freq: midiToHz(n), dur: 0.22, gain: 0.12, send: 0.3 }));
    },
    error(): void {
      const t = now();
      if (take('ui', t) < 0) return;
      tone(g, ui, t, { type: 'square', freq: 196, freqEnd: 170, dur: 0.14, gain: 0.1, lpf: 900 });
      tone(g, ui, t + 0.13, { type: 'square', freq: 147, freqEnd: 120, dur: 0.2, gain: 0.1, lpf: 800 });
    },
    denied(): void {
      const t = now();
      if (take('ui', t) < 0) return;
      tone(g, ui, t, { type: 'square', freq: 170, freqEnd: 140, dur: 0.06, gain: 0.15, lpf: 700 });
    },
    draftPick(): void {
      const t = now();
      tone(g, ui, t, { freq: 120, freqEnd: 48, dur: 0.2, gain: 0.22 });
      [NOTE.D5, NOTE.A5, NOTE.D6].forEach((n, i) => {
        tone(g, ui, t + i * 0.05, { freq: midiToHz(n), dur: 0.7, gain: 0.09, send: 0.55 });
        tone(g, ui, t + i * 0.05, { freq: midiToHz(n) * 2.76, dur: 0.25, gain: 0.02 });
      });
    },
    countdownTick(last: boolean): void {
      const t = now();
      tone(g, ui, t, { type: 'triangle', freq: last ? 1480 : 990, freqEnd: last ? 1300 : 860, dur: 0.06, gain: 0.3, lpf: 3000 });
    },

    confirm(): void {
      const t = now();
      if (take('ui', t) < 0) return;
      [NOTE.D5, NOTE.A5].forEach((n, i) => tone(g, ui, t + i * 0.06, { type: 'triangle', freq: midiToHz(n), dur: 0.16, gain: 0.12 }));
    },
    back(): void {
      const t = now();
      if (take('ui', t) < 0) return;
      tone(g, ui, t, { type: 'triangle', freq: 420, freqEnd: 250, dur: 0.09, gain: 0.18 });
    },
    buy(): void {
      const t = now();
      if (take('ui', t) < 0) return;
      for (let i = 0; i < 4; i++) tone(g, ui, t + i * 0.035, { freq: 2400 + i * 310, dur: 0.08, gain: 0.06 });
      tone(g, ui, t + 0.12, { type: 'triangle', freq: midiToHz(NOTE.D5), dur: 0.3, gain: 0.1 });
    },
    equip(): void {
      const t = now();
      if (take('ui', t) < 0) return;
      noise(g, ui, t, { dur: 0.12, gain: 0.12, filter: 'bandpass', freq: 900, freqEnd: 2200, q: 1 });
      tone(g, ui, t + 0.09, { type: 'triangle', freq: 1500, dur: 0.05, gain: 0.08 });
    },
    tab(): void {
      const t = now();
      if (take('ui', t) < 0) return;
      tone(g, ui, t, { type: 'triangle', freq: 700, freqEnd: 900, dur: 0.05, gain: 0.14 });
    },
    toggle(): void {
      const t = now();
      if (take('ui', t) < 0) return;
      tone(g, ui, t, { type: 'triangle', freq: 880, freqEnd: 660, dur: 0.06, gain: 0.14 });
    },
    // ------------------------------------------------------------ hero actions
    primary(cls: ClassId, step: number, own: boolean): void {
      const t = now();
      const stack = take('cast', t);
      if (stack < 0) return;
      primary(cls, step, (own ? TUNE.OWN_GAIN : TUNE.OTHER_GAIN) * duck(stack), t);
    },
    secondary(cls: ClassId, own: boolean): void {
      const t = now();
      const stack = take('cast', t);
      if (stack < 0) return;
      secondary(cls, (own ? TUNE.OWN_GAIN : TUNE.OTHER_GAIN) * duck(stack), t);
    },
    dash(own: boolean): void {
      const t = now();
      const stack = take('cast', t);
      if (stack < 0) return;
      const gain = (own ? TUNE.OWN_GAIN : TUNE.OTHER_GAIN) * duck(stack);
      whoosh(t, 500, 3200, 900, 0.2, gain * 0.2);
      tone(g, out, t, { freq: 320, freqEnd: 760, dur: 0.13, gain: gain * 0.07 });
    },
    enemyCast(): void {
      const t = now();
      const stack = take('enemyCast', t);
      if (stack < 0) return;
      whoosh(t, 260, 1100, 220, 0.2, 0.09 * duck(stack));
    },

    // ------------------------------------------------------------ combat feedback
    hit(o: HitOpts): void {
      const t = now();
      const stack = take('hit', t);
      if (stack >= 0) {
        const weight = Math.min(1, Math.max(0, o.dmg) / TUNE.HEAVY_DAMAGE);
        const gain = (o.own ? TUNE.OWN_GAIN : TUNE.OTHER_GAIN) * duck(stack) * (0.42 + weight * 0.46);
        const pitch = (230 - weight * 120) * jitter(0.08);
        tone(g, out, t, { type: 'triangle', freq: pitch, freqEnd: pitch * 0.45, dur: 0.07 + weight * 0.07, gain });
        noise(g, out, t, { dur: 0.05 + weight * 0.05, gain: gain * 0.8, filter: 'lowpass', freq: 2600 - weight * 1200, freqEnd: 500 });
      }
      if (o.crit && take('crit', t) >= 0) {
        const gain = o.own ? 0.14 : 0.08;
        tone(g, out, t, { type: 'square', freq: 1568, freqEnd: 2093, dur: 0.1, gain, lpf: 6000, send: 0.2 });
        noise(g, out, t, { dur: 0.04, gain, filter: 'highpass', freq: 5200 });
      }
      if (o.el) {
        const elStack = take('element', t);
        if (elStack >= 0) elementLayer(o.el, t, (o.own ? 0.16 : 0.1) * duck(elStack));
      }
    },
    status(el: ElementId): void {
      const t = now();
      const stack = take('status', t);
      if (stack >= 0) elementLayer(el, t, 0.035 * duck(stack));
    },
    resonance(a: ElementId, b: ElementId, own: boolean): void {
      const t = now();
      const stack = take('resonance', t);
      if (stack < 0) return;
      const gain = (own ? 0.82 : 0.6) * duck(stack);
      const pair = [a, b].sort().join('+');
      const root = PAIR_ROOT[pair] ?? NOTE.D4;
      const rising = a < b;
      // body: sub drop + noise wash
      tone(g, out, t, { freq: 120, freqEnd: 36, dur: 0.75, gain: gain * 0.5 });
      noise(g, out, t, { dur: 0.55, gain: gain * 0.26, filter: 'lowpass', freq: 5200, freqEnd: 180, send: 0.3 });
      noise(g, out, t, { dur: 0.05, gain: gain * 0.2, filter: 'highpass', freq: 3000 });
      // shimmer chord that depends on the element pair, arpeggio direction on the order
      const chord = [0, 7, 12, 19];
      (rising ? chord : [...chord].reverse()).forEach((semi, i) => {
        tone(g, out, t + 0.03 + i * 0.045, {
          type: 'triangle', freq: midiToHz(root + semi), dur: 0.9, gain: gain * 0.075, send: 0.6, lpf: 4200,
        });
      });
      elementLayer(a, t, gain * 0.1);
      elementLayer(b, t + 0.07, gain * 0.13);
      if (pair === 'ember+rime') noise(g, out, t + 0.05, { dur: 0.8, gain: gain * 0.08, filter: 'highpass', freq: 5200, attack: 0.08 });
      if (pair === 'ember+storm') noise(g, out, t + 0.02, { dur: 0.12, gain: gain * 0.2, filter: 'bandpass', freq: 2400, q: 0.6 });
      if (pair === 'rime+storm') tone(g, out, t, { type: 'sawtooth', freq: 3200, freqEnd: 300, dur: 0.22, gain: gain * 0.06, lpf: 6000 });
    },
    kill(kind: EnemyKind, own: boolean): void {
      const t = now();
      if (kind === 'champion' || kind === 'regent') {
        if (take('big', t) < 0) return;
        tone(g, out, t, { freq: 110, freqEnd: 30, dur: 1.4, gain: 0.5 });
        noise(g, out, t, { dur: 1.2, gain: 0.3, filter: 'lowpass', freq: 3000, freqEnd: 120, send: 0.5 });
        [NOTE.D4, NOTE.A3, NOTE.F3, NOTE.D3].forEach((n, i) =>
          tone(g, out, t + 0.1 + i * 0.16, { type: 'sawtooth', freq: midiToHz(n), dur: 0.7, gain: 0.07, lpf: 1400, send: 0.5 }));
        return;
      }
      const stack = take('kill', t);
      if (stack < 0) return;
      const gain = (own ? TUNE.OWN_GAIN : TUNE.OTHER_GAIN) * duck(stack);
      noise(g, out, t, { dur: 0.13, gain: gain * 0.15, filter: 'bandpass', freq: 1300, freqEnd: 300, q: 1.1 });
      for (const [f, d] of [[920, 0], [690, 0.035], [1150, 0.06]] as const) {
        tone(g, out, t + d, { type: 'triangle', freq: f * jitter(0.08), dur: 0.035, gain: gain * 0.07 });
      }
      if (own) tone(g, out, t + 0.04, { freq: midiToHz(NOTE.A6) * jitter(0.01), dur: 0.3, gain: 0.03, send: 0.5 });
    },
    spawn(kind: EnemyKind, elite: boolean): void {
      const t = now();
      if (kind === 'champion' || kind === 'regent') {
        if (take('big', t) < 0) return;
        const low = kind === 'regent' ? 46 : 58;
        tone(g, out, t, { type: 'sawtooth', freq: low, freqEnd: low * 1.3, dur: 1.5, gain: 0.26, lpf: 240, lpfEnd: 900, attack: 0.3, send: 0.4 });
        tone(g, out, t, { type: 'sawtooth', freq: low * 1.5, freqEnd: low * 1.9, dur: 1.5, gain: 0.12, lpf: 300, lpfEnd: 1100, attack: 0.4 });
        noise(g, out, t, { dur: 1.3, gain: 0.14, filter: 'lowpass', freq: 300, freqEnd: 1600, attack: 0.5, send: 0.4 });
        return;
      }
      const stack = take('spawn', t);
      if (stack < 0) return;
      const gain = duck(stack) * (elite ? 1.3 : 1);
      for (let i = 0; i < 4; i++) {
        noise(g, out, t + i * 0.045 * jitter(0.3), { dur: 0.03, gain: gain * 0.04, filter: 'bandpass', freq: 2300 * jitter(0.25), q: 4 });
      }
      tone(g, out, t, { freq: elite ? 60 : 78, freqEnd: elite ? 96 : 120, dur: 0.35, gain: gain * 0.06, attack: 0.1 });
    },
    telegraph(seconds: number): void {
      const t = now();
      if (take('telegraph', t) < 0) return;
      const urgent = seconds < 0.7;
      tone(g, out, t, { type: 'square', freq: urgent ? 988 : 784, freqEnd: urgent ? 1046 : 830, dur: 0.07, gain: 0.24, lpf: 2400 });
    },
    aoe(el: ElementId | null, hostile: boolean): void {
      const t = now();
      const stack = take('aoe', t);
      if (stack < 0) return;
      const gain = duck(stack) * (hostile ? 1 : 0.85);
      tone(g, out, t, { freq: hostile ? 105 : 130, freqEnd: 40, dur: 0.34, gain: gain * 0.34 });
      noise(g, out, t, { dur: 0.28, gain: gain * 0.2, filter: 'lowpass', freq: hostile ? 1500 : 2600, freqEnd: 180, send: 0.25 });
      if (hostile) tone(g, out, t, { type: 'sawtooth', freq: 233, freqEnd: 110, dur: 0.2, gain: gain * 0.07, lpf: 900 });
      if (el) elementLayer(el, t, gain * 0.1);
    },
    hurt(own: boolean, dmg: number): void {
      const t = now();
      const stack = take('hurt', t);
      if (stack < 0) return;
      const weight = Math.min(1, Math.max(0, dmg) / TUNE.HEAVY_DAMAGE);
      if (own) {
        tone(g, out, t, { type: 'sawtooth', freq: 240, freqEnd: 105, dur: 0.2, gain: 0.42 + weight * 0.16, lpf: 800 });
        noise(g, out, t, { dur: 0.12, gain: 0.26 + weight * 0.1, filter: 'lowpass', freq: 900, freqEnd: 200 });
        tone(g, out, t, { freq: 70, freqEnd: 40, dur: 0.18, gain: 0.34 });
      } else {
        tone(g, out, t, { type: 'triangle', freq: 330, freqEnd: 190, dur: 0.12, gain: 0.17 * duck(stack), lpf: 1200 });
      }
    },
    down(own: boolean): void {
      const t = now();
      const gain = own ? 1 : 0.7;
      tone(g, out, t, { freq: 90, freqEnd: 34, dur: 0.9, gain: gain * 0.4 });
      [NOTE.D4, NOTE.A3, NOTE.F3].forEach((n, i) =>
        tone(g, out, t + i * 0.17, { type: 'triangle', freq: midiToHz(n), dur: 0.8, gain: gain * 0.13, send: 0.6, lpf: 1800 }));
      noise(g, out, t, { dur: 0.5, gain: gain * 0.12, filter: 'lowpass', freq: 700, freqEnd: 120 });
    },
    revived(own: boolean): void {
      const t = now();
      const gain = own ? 1 : 0.75;
      [NOTE.D4, NOTE.A4, NOTE.D5, NOTE.Fs5].forEach((n, i) => {
        tone(g, out, t + i * 0.07, { type: 'triangle', freq: midiToHz(n), dur: 0.6, gain: gain * 0.1, send: 0.55 });
        tone(g, out, t + i * 0.07, { freq: midiToHz(n) * 2, dur: 0.3, gain: gain * 0.03 });
      });
      noise(g, out, t, { dur: 0.5, gain: gain * 0.05, filter: 'highpass', freq: 3000, freqEnd: 8000, attack: 0.2 });
    },
    heal(own: boolean): void {
      const t = now();
      if (take('heal', t) < 0) return;
      const gain = own ? 1 : 0.6;
      tone(g, out, t, { freq: 660, freqEnd: 990, dur: 0.28, gain: gain * 0.07, send: 0.4 });
      tone(g, out, t + 0.08, { freq: 1320, dur: 0.25, gain: gain * 0.04, send: 0.4 });
    },
    shieldBreak(): void {
      const t = now();
      const stack = take('shield', t);
      if (stack < 0) return;
      const gain = duck(stack);
      noise(g, out, t, { dur: 0.22, gain: gain * 0.17, filter: 'highpass', freq: 2800 });
      for (const f of [2217, 2960, 3729]) tone(g, out, t, { freq: f * jitter(0.03), dur: 0.16, gain: gain * 0.04 });
      tone(g, out, t, { type: 'square', freq: 392, freqEnd: 260, dur: 0.1, gain: gain * 0.09, lpf: 1800 });
    },

    hazard(kind: Hazard['kind'], own: boolean): void {
      const t = now();
      const stack = take('aoe', t);
      if (stack < 0) return;
      const gain = (own ? 1 : 0.5) * duck(stack);
      if (kind === 'spikes') {
        tone(g, out, t, { type: 'square', freq: 1200, freqEnd: 500, dur: 0.07, gain: gain * 0.1, lpf: 3000 });
        noise(g, out, t, { dur: 0.06, gain: gain * 0.2, filter: 'highpass', freq: 3500 });
      } else {
        elementLayer(kind === 'vent' ? 'ember' : 'rime', t, gain * 0.2);
      }
    },

    // ------------------------------------------------------------ run flow
    tutorialStep(): void {
      const t = now();
      [NOTE.A4, NOTE.D5, NOTE.Fs5].forEach((n, i) => tone(g, out, t + i * 0.07, { type: 'triangle', freq: midiToHz(n), dur: 0.4, gain: 0.09, send: 0.4 }));
    },
    wave(): void {
      const t = now();
      thump(t, 95, 0.32, 0.26);
      thump(t + 0.22, 80, 0.4, 0.3);
      for (const n of [NOTE.D3, NOTE.A3]) {
        tone(g, out, t + 0.05, { type: 'sawtooth', freq: midiToHz(n), dur: 0.8, gain: 0.07, lpf: 420, lpfEnd: 1100, attack: 0.12, send: 0.45 });
      }
    },
    chamberClear(): void {
      const t = now();
      [NOTE.D4, NOTE.Fs4, NOTE.A4, NOTE.D5, NOTE.Fs5].forEach((n, i) => {
        tone(g, out, t + i * 0.09, { type: 'triangle', freq: midiToHz(n), dur: 1.3, gain: 0.1, send: 0.6 });
        tone(g, out, t + i * 0.09, { freq: midiToHz(n) * 2.76, dur: 0.35, gain: 0.018 });
      });
      tone(g, out, t, { freq: midiToHz(NOTE.D2), dur: 1.6, gain: 0.2, attack: 0.05 });
    },
    bossPhase(): void {
      const t = now();
      if (take('big', t) < 0) return;
      tone(g, out, t, { type: 'sawtooth', freq: 74, freqEnd: 44, dur: 1.5, gain: 0.24, lpf: 300, lpfEnd: 1500, attack: 0.08, send: 0.5 });
      tone(g, out, t, { type: 'sawtooth', freq: 104, freqEnd: 60, dur: 1.5, gain: 0.16, lpf: 340, lpfEnd: 1700, attack: 0.1, detune: 18 });
      tone(g, out, t, { type: 'square', freq: 52, freqEnd: 36, dur: 1.2, gain: 0.14, lpf: 500 });
      noise(g, out, t, { dur: 1.3, gain: 0.2, filter: 'bandpass', freq: 500, freqEnd: 1500, q: 0.7, attack: 0.15, send: 0.5 });
      tone(g, out, t, { freq: 60, freqEnd: 30, dur: 0.8, gain: 0.36 });
    },
    boon(own: boolean): void {
      const t = now();
      const notes = own ? [NOTE.A5, NOTE.D6, NOTE.F6, NOTE.A6] : [NOTE.D6, NOTE.A6];
      notes.forEach((n, i) => tone(g, out, t + i * 0.055, { freq: midiToHz(n), dur: 0.45, gain: own ? 0.07 : 0.035, send: 0.55 }));
    },
    doorChosen(type: DoorType): void {
      const t = now();
      tone(g, out, t, { freq: 84, freqEnd: 36, dur: 0.6, gain: 0.42 });
      noise(g, out, t, { dur: 0.6, gain: 0.16, filter: 'lowpass', freq: 600, freqEnd: 140, send: 0.4 });
      const colour: Record<DoorType, number[]> = {
        boon: [NOTE.D5, NOTE.A5],
        blessing: [NOTE.D5, NOTE.Fs5, NOTE.A5],
        cursed: [NOTE.D4, NOTE.D4 + 6],
        boss: [NOTE.D3, NOTE.D3 + 1, NOTE.D3 + 6],
      };
      const dark = type === 'cursed' || type === 'boss';
      colour[type].forEach((n, i) => tone(g, out, t + 0.12 + i * 0.07, {
        type: dark ? 'sawtooth' : 'triangle', freq: midiToHz(n), dur: dark ? 1.1 : 0.8, gain: dark ? 0.07 : 0.09,
        lpf: dark ? 900 : 4000, send: 0.6,
      }));
    },
  };
}
