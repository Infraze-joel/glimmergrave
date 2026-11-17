/**
 * Offline rendering helpers for verification (used by the dev harness and e2e checks, never by the game):
 * render a music state or a burst of SFX with an OfflineAudioContext and report peak / RMS.
 */
import { CLASS_IDS, DOOR_TYPES, ELEMENT_IDS, ENEMY_KINDS } from '@shared/types.ts';
import { createGraph, MIX } from './engine.ts';
import { createMusic, type MusicState } from './music.ts';
import { createSfx, type Sfx } from './sfx.ts';

const SAMPLE_RATE = 44100;
const CHANNELS = 2;

export interface RenderStats {
  name: string;
  seconds: number;
  peak: number;
  rms: number;
  /** Peak in dBFS (0 = full scale). */
  peakDb: number;
}

async function render(name: string, seconds: number, setup: (ctx: OfflineAudioContext) => void): Promise<RenderStats> {
  const ctx = new OfflineAudioContext(CHANNELS, Math.ceil(seconds * SAMPLE_RATE), SAMPLE_RATE);
  setup(ctx);
  const buffer = await ctx.startRendering();
  let peak = 0;
  let sum = 0;
  let count = 0;
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < data.length; i++) {
      const v = Math.abs(data[i]);
      if (v > peak) peak = v;
      sum += v * v;
    }
    count += data.length;
  }
  return { name, seconds, peak, rms: Math.sqrt(sum / Math.max(1, count)), peakDb: 20 * Math.log10(Math.max(peak, 1e-9)) };
}

function levels(graph: ReturnType<typeof createGraph>): void {
  graph.master.gain.value = 1;
  graph.music.gain.value = MIX.MUSIC_TRIM;
  graph.sfx.gain.value = MIX.SFX_TRIM;
}

/** Renders `seconds` of a music state at full user volume. `bossPhase` only matters for 'boss'. */
export function renderMusic(stateName: Exclude<MusicState, 'none'>, seconds: number, bossPhase = 1): Promise<RenderStats> {
  return render(`music:${stateName}${stateName === 'boss' ? bossPhase : ''}`, seconds, (ctx) => {
    const graph = createGraph(ctx);
    levels(graph);
    const music = createMusic(graph);
    music.setBossPhase(bossPhase);
    music.setState(stateName, 0.05);
    music.schedule(seconds);
  });
}

export function renderStinger(kind: 'victory' | 'defeat'): Promise<RenderStats> {
  return render(`stinger:${kind}`, 5, (ctx) => {
    const graph = createGraph(ctx);
    levels(graph);
    createMusic(graph).stinger(kind);
  });
}

type SfxCase = [string, (sfx: Sfx) => void];

export const SFX_CASES: SfxCase[] = [
  ['ui.hover', (s) => s.hover()],
  ['ui.click', (s) => s.click()],
  ['ui.ready', (s) => s.ready(true)],
  ['ui.unready', (s) => s.ready(false)],
  ['ui.error', (s) => s.error()],
  ['ui.denied', (s) => s.denied()],
  ['ui.draftPick', (s) => s.draftPick()],
  ['ui.tick', (s) => s.countdownTick(false)],
  ['ui.tickLast', (s) => s.countdownTick(true)],
  ...CLASS_IDS.flatMap((cls): SfxCase[] => [
    [`primary.${cls}.1`, (s) => s.primary(cls, 0, true)],
    [`primary.${cls}.3`, (s) => s.primary(cls, 2, true)],
    [`secondary.${cls}`, (s) => s.secondary(cls, true)],
  ]),
  ['dash', (s) => s.dash(true)],
  ['enemyCast', (s) => s.enemyCast()],
  ['hit.light', (s) => s.hit({ dmg: 8, crit: false, el: null, own: true })],
  ['hit.heavy.crit', (s) => s.hit({ dmg: 70, crit: true, el: null, own: true })],
  ...ELEMENT_IDS.map((el): SfxCase => [`hit.${el}`, (s) => s.hit({ dmg: 20, crit: false, el, own: true })]),
  ...ELEMENT_IDS.map((el): SfxCase => [`status.${el}`, (s) => s.status(el)]),
  ...ELEMENT_IDS.flatMap((a) => ELEMENT_IDS.filter((b) => b !== a).map((b): SfxCase =>
    [`resonance.${a}>${b}`, (s) => s.resonance(a, b, true)])),
  ...ENEMY_KINDS.flatMap((kind): SfxCase[] => [
    [`spawn.${kind}`, (s) => s.spawn(kind, false)],
    [`kill.${kind}`, (s) => s.kill(kind, true)],
  ]),
  ['telegraph', (s) => s.telegraph(0.8)],
  ['aoe.hostile', (s) => s.aoe(null, true)],
  ['aoe.friendly.ember', (s) => s.aoe('ember', false)],
  ['hurt.own', (s) => s.hurt(true, 30)],
  ['hurt.ally', (s) => s.hurt(false, 30)],
  ['down.own', (s) => s.down(true)],
  ['revived', (s) => s.revived(true)],
  ['heal', (s) => s.heal(true)],
  ['shieldBreak', (s) => s.shieldBreak()],
  ['wave', (s) => s.wave()],
  ['chamberClear', (s) => s.chamberClear()],
  ['bossPhase', (s) => s.bossPhase()],
  ['boon.own', (s) => s.boon(true)],
  ['boon.ally', (s) => s.boon(false)],
  ...DOOR_TYPES.map((type): SfxCase => [`door.${type}`, (s) => s.doorChosen(type)]),
];

export function renderSfx(name: string, play: (sfx: Sfx) => void, seconds = 2.5): Promise<RenderStats> {
  return render(`sfx:${name}`, seconds, (ctx) => {
    const graph = createGraph(ctx);
    levels(graph);
    play(createSfx(graph));
  });
}

/** Worst case: a boss fight score with a wall of simultaneous hits, kills and bursts on top. */
export function renderStress(seconds = 6): Promise<RenderStats> {
  return render('stress', seconds, (ctx) => {
    const graph = createGraph(ctx);
    levels(graph);
    const music = createMusic(graph);
    music.setBossPhase(3);
    music.setState('boss', 0.05);
    music.schedule(seconds);
    const sfx = createSfx(graph);
    // currentTime is 0 while setting up, so everything below lands on the same instant: the limiter must hold.
    for (let i = 0; i < 40; i++) {
      sfx.hit({ dmg: 20 + i, crit: i % 3 === 0, el: ELEMENT_IDS[i % 3], own: i % 2 === 0 });
      sfx.kill('minion', true);
      sfx.spawn('minion', false);
    }
    sfx.resonance('ember', 'storm', true);
    sfx.resonance('rime', 'storm', true);
    sfx.aoe('ember', true);
    sfx.bossPhase();
    sfx.wave();
    sfx.chamberClear();
  });
}
