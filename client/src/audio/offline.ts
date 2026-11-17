/**
 * Offline rendering helpers for verification (used by the dev harnesses and e2e checks, never by the game):
 * render a music state, an ambience or SFX with an OfflineAudioContext and report peak / RMS / DC offset.
 * Renders use the real samples (decoded once, shared by all renders) unless `samples: false` asks for the
 * synthesised fallbacks.
 */
import { BIOME_IDS, BOSS_KINDS, CLASS_IDS, DOOR_TYPES, ELEMENT_IDS, ENEMY_KINDS, type BiomeId, type BossKind } from '@shared/types.ts';
import { createAmbience } from './ambience.ts';
import { createGraph, MIX, type AudioGraph } from './engine.ts';
import { createMusic, type MusicState } from './music.ts';
import { createBank, type Bank, type BankStats } from './samples.ts';
import { createSfx, type Sfx } from './sfx.ts';

const SAMPLE_RATE = 44100;
const CHANNELS = 2;
const SILENT_PEAK = 1e-9;
/**
 * A fresh context's compressors need a moment to settle (anything sounding in the first half second comes out
 * far too quiet), so every render runs this long before the measured part starts. Sounds are fired at the end
 * of the pre-roll via OfflineAudioContext.suspend(); statistics cover only what follows.
 */
const PREROLL_S = 1;
const QUANTUM_S = 128 / SAMPLE_RATE;

export interface RenderStats {
  name: string;
  seconds: number;
  peak: number;
  rms: number;
  /** Peak in dBFS (0 = full scale). */
  peakDb: number;
  /** RMS over the whole render in dBFS. */
  rmsDb: number;
  /** RMS of the loudest 400 ms in dBFS (comparable between short and long sounds). */
  loudDb: number;
  /** Mean sample value (DC offset). */
  dc: number;
}

export interface RenderOptions {
  /** false = render with an empty bank, i.e. the synthesised fallbacks. Default true. */
  samples?: boolean;
  boss?: BossKind;
  biome?: BiomeId;
}

let shared: Bank | null = null;
let empty: Bank | null = null;

/** Decodes every sample once for offline renders. Resolves with the load statistics. */
export async function loadOfflineBank(): Promise<BankStats> {
  shared ??= createBank(new OfflineAudioContext(1, 1, SAMPLE_RATE));
  return shared.load();
}

function bankFor(o: RenderOptions): Bank {
  if (o.samples !== false && shared) return shared;
  empty ??= createBank(new OfflineAudioContext(1, 1, SAMPLE_RATE));
  return empty;
}

const toDb = (v: number): number => 20 * Math.log10(Math.max(v, SILENT_PEAK));
const LOUD_WINDOW_S = 0.4;

function analyse(name: string, seconds: number, buffer: AudioBuffer, from = 0): RenderStats {
  let peak = 0;
  let sum = 0;
  let total = 0;
  let count = 0;
  let loudest = 0;
  const win = Math.floor(LOUD_WINDOW_S * buffer.sampleRate);
  const first = Math.min(buffer.length, Math.floor(from * buffer.sampleRate));
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    let run = 0;
    for (let i = first; i < data.length; i++) {
      const v = data[i];
      const sq = v * v;
      if (Math.abs(v) > peak) peak = Math.abs(v);
      sum += sq;
      total += v;
      run += sq;
      if (i - first >= win) run -= data[i - win] * data[i - win];
      if (i - first >= win - 1 && run > loudest) loudest = run;
    }
    count += data.length - first;
  }
  const rms = Math.sqrt(sum / Math.max(1, count));
  return {
    name, seconds, peak, rms, peakDb: toDb(peak), rmsDb: toDb(rms),
    loudDb: toDb(Math.sqrt(Math.max(0, loudest) / Math.max(1, win))), dc: total / Math.max(1, count),
  };
}

/** Runs `fire` when the render reaches `at` seconds (rounded to a render quantum). */
function atTime(ctx: OfflineAudioContext, at: number, fire: () => void): void {
  if (typeof ctx.suspend !== 'function') { fire(); return; }
  void ctx.suspend(Math.round(at / QUANTUM_S) * QUANTUM_S).then(() => {
    try { fire(); } finally { void ctx.resume(); }
  });
}

/**
 * Renders `seconds` after the pre-roll. `build` wires the graph at time 0 and may return what to fire once the
 * pre-roll is over (one-shots); continuous material (music, ambience) simply starts in `build`.
 */
async function render(name: string, seconds: number, build: (ctx: OfflineAudioContext) => (() => void) | void): Promise<RenderStats> {
  const ctx = new OfflineAudioContext(CHANNELS, Math.ceil((PREROLL_S + seconds) * SAMPLE_RATE), SAMPLE_RATE);
  const fire = build(ctx);
  if (fire) atTime(ctx, PREROLL_S, fire);
  return analyse(name, seconds, await ctx.startRendering(), PREROLL_S);
}

function levels(graph: AudioGraph): void {
  graph.master.gain.value = 1;
  graph.music.gain.value = MIX.MUSIC_TRIM;
  graph.sfx.gain.value = MIX.SFX_TRIM;
}

/** Renders `seconds` of a music state at full user volume. `bossPhase` only matters for 'boss'. */
export function renderMusic(stateName: Exclude<MusicState, 'none'>, seconds: number, bossPhase = 1, o: RenderOptions = {}): Promise<RenderStats> {
  const label = `music:${stateName}${stateName === 'boss' ? `.${o.boss ?? 'regent'}.${bossPhase}` : ''}${o.biome ? `@${o.biome}` : ''}`;
  return render(label, seconds, (ctx) => {
    const graph = createGraph(ctx);
    levels(graph);
    const music = createMusic(graph, createSfx(graph, bankFor(o)).player);
    music.setBossPhase(bossPhase);
    music.setBossKind(o.boss ?? 'regent');
    music.setBiome(o.biome ?? 'crypt');
    music.setState(stateName, 0.05);
    music.schedule(PREROLL_S + seconds);
  });
}

export function renderStinger(kind: 'victory' | 'defeat', o: RenderOptions = {}): Promise<RenderStats> {
  return render(`stinger:${kind}`, 5, (ctx) => {
    const graph = createGraph(ctx);
    levels(graph);
    const music = createMusic(graph, createSfx(graph, bankFor(o)).player);
    return () => music.stinger(kind);
  });
}

export function renderAmbience(biome: BiomeId, seconds: number, o: RenderOptions = {}): Promise<RenderStats> {
  return render(`ambience:${biome}`, seconds, (ctx) => {
    const graph = createGraph(ctx);
    levels(graph);
    const ambience = createAmbience(graph, createSfx(graph, bankFor(o)).player);
    ambience.setBiome(biome);
    ambience.schedule(PREROLL_S + seconds);
  });
}

type SfxCase = [string, (sfx: Sfx) => void];

/** Substring -> signature cue ids the bosses are expected to use (unknown ids fall back to the generic cast). */
export const BOSS_CUE_IDS = ['regent_volley', 'regent_slam', 'regent_summon', 'champion_sweep', 'champion_charge',
  'matron_beam', 'matron_wisp', 'matron_summon', 'stalker_leap', 'stalker_spear', 'stalker_volley', 'blink'] as const;

export const SFX_CASES: SfxCase[] = [
  ['ui.hover', (s) => s.hover()],
  ['ui.click', (s) => s.click()],
  ['ui.confirm', (s) => s.confirm()],
  ['ui.back', (s) => s.back()],
  ['ui.ready', (s) => s.ready(true)],
  ['ui.unready', (s) => s.ready(false)],
  ['ui.error', (s) => s.error()],
  ['ui.denied', (s) => s.denied()],
  ['ui.draftPick', (s) => s.draftPick()],
  ['ui.tick', (s) => s.countdownTick(false)],
  ['ui.tickLast', (s) => s.countdownTick(true)],
  ['ui.buy', (s) => s.buy()],
  ['ui.equip', (s) => s.equip()],
  ['ui.tab', (s) => s.tab()],
  ['ui.toggle', (s) => s.toggle()],
  ...CLASS_IDS.flatMap((cls): SfxCase[] => [
    [`cast.primary.${cls}.1`, (s) => s.primary(cls, 0, true)],
    [`cast.primary.${cls}.2`, (s) => s.primary(cls, 1, true)],
    [`cast.primary.${cls}.3`, (s) => s.primary(cls, 2, true)],
    [`cast.secondary.${cls}`, (s) => s.secondary(cls, true)],
  ]),
  ['cast.dash', (s) => s.dash(true)],
  ['cast.ally.knight', (s) => s.primary('knight', 0, false)],
  ['enemy.cast', (s) => s.enemyCast()],
  ...BOSS_CUE_IDS.map((id): SfxCase => [`enemy.cue.${id}`, (s) => s.enemyCast(id, id.startsWith('matron') ? 'matron' : id.startsWith('stalker') ? 'stalker' : id.startsWith('champion') ? 'champion' : 'regent')]),
  ['hit.light', (s) => s.hit({ dmg: 8, crit: false, el: null, own: true })],
  ['hit.heavy', (s) => s.hit({ dmg: 50, crit: false, el: null, own: true, weapon: 'barbarian' })],
  ['hit.heavy.crit', (s) => s.hit({ dmg: 70, crit: true, el: null, own: true, weapon: 'knight' })],
  ['hit.shield', (s) => s.hit({ dmg: 0, crit: false, el: null, own: true, shielded: true })],
  ['hit.boss', (s) => s.hit({ dmg: 30, crit: false, el: null, own: true, boss: true })],
  ['hit.ally', (s) => s.hit({ dmg: 20, crit: false, el: null, own: false })],
  ['hit.tick', (s) => s.hit({ dmg: 3, crit: false, el: 'ember', own: true, tick: true })],
  ...ELEMENT_IDS.map((el): SfxCase => [`hit.${el}`, (s) => s.hit({ dmg: 20, crit: false, el, own: true })]),
  ...ELEMENT_IDS.map((el): SfxCase => [`element.status.${el}`, (s) => s.status(el)]),
  ...ELEMENT_IDS.map((el): SfxCase => [`element.aoe.${el}`, (s) => s.aoe(el, false)]),
  ...ELEMENT_IDS.flatMap((a) => ELEMENT_IDS.filter((b) => b !== a).map((b): SfxCase =>
    [`resonance.${a}>${b}`, (s) => s.resonance(a, b, true)])),
  ...ENEMY_KINDS.flatMap((kind): SfxCase[] => [
    [`enemy.spawn.${kind}`, (s) => s.spawn(kind, false)],
    [`kill.${kind}`, (s) => s.kill(kind, true)],
  ]),
  ['enemy.telegraph', (s) => s.telegraph(0.8)],
  ['enemy.aoe.hostile', (s) => s.aoe(null, true)],
  ['hurt.own', (s) => s.hurt(true, 30)],
  ['hurt.ally', (s) => s.hurt(false, 30)],
  ['shieldBreak', (s) => s.shieldBreak()],
  ...(['spikes', 'vent', 'frost'] as const).map((kind): SfxCase => [`hazard.${kind}`, (s) => s.hazard(kind, 'own')]),
  ['flow.down.own', (s) => s.down(true)],
  ['flow.revived', (s) => s.revived(true)],
  ['flow.heal', (s) => s.heal(true)],
  ['flow.wave', (s) => s.wave()],
  ['flow.chamberClear', (s) => s.chamberClear()],
  ...BOSS_KINDS.map((kind): SfxCase => [`flow.bossPhase.${kind}`, (s) => s.bossPhase(2, kind)]),
  ['flow.boon.own', (s) => s.boon(true)],
  ['flow.boon.ally', (s) => s.boon(false)],
  ['flow.tutorialStep', (s) => s.tutorialStep()],
  ...DOOR_TYPES.map((type): SfxCase => [`flow.door.${type}`, (s) => s.doorChosen(type)]),
];

export function renderSfx(name: string, play: (sfx: Sfx) => void, seconds = 2.5, o: RenderOptions = {}): Promise<RenderStats> {
  return render(`sfx:${name}`, seconds, (ctx) => {
    const graph = createGraph(ctx);
    levels(graph);
    const sfx = createSfx(graph, bankFor(o));
    return () => play(sfx);
  });
}

/** Worst case: a boss fight score with a wall of simultaneous hits, kills and bursts on top. */
export function renderStress(seconds = 6, o: RenderOptions = {}): Promise<RenderStats> {
  return render('stress', seconds, (ctx) => {
    const graph = createGraph(ctx);
    levels(graph);
    const sfx = createSfx(graph, bankFor(o));
    const music = createMusic(graph, sfx.player);
    music.setBossPhase(3);
    music.setState('boss', 0.05);
    music.schedule(PREROLL_S + seconds);
    // Everything below lands on the same instant: the limiters must hold.
    return () => {
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
    };
  });
}

/** The workbench's stress case, spread over one second: 60 hits, 20 kills and 6 Resonances over boss music. */
export const STRESS = { HITS: 60, KILLS: 20, RESONANCES: 6, SPAN_S: 1, START_S: 1 } as const;

export function stressEvents(): [number, (sfx: Sfx) => void][] {
  const events: [number, (sfx: Sfx) => void][] = [];
  for (let i = 0; i < STRESS.HITS; i++) {
    events.push([(i / STRESS.HITS) * STRESS.SPAN_S, (s) => s.hit({ dmg: 10 + (i % 7) * 9, crit: i % 5 === 0, el: i % 2 === 0 ? ELEMENT_IDS[i % 3] : null, own: i % 2 === 0, weapon: CLASS_IDS[i % 4] })]);
  }
  for (let i = 0; i < STRESS.KILLS; i++) events.push([(i / STRESS.KILLS) * STRESS.SPAN_S, (s) => s.kill(i % 4 === 0 ? 'warrior' : 'minion', i % 2 === 0)]);
  for (let i = 0; i < STRESS.RESONANCES; i++) {
    events.push([(i / STRESS.RESONANCES) * STRESS.SPAN_S, (s) => s.resonance(ELEMENT_IDS[i % 3], ELEMENT_IDS[(i + 1) % 3], i % 2 === 0)]);
  }
  return events.sort((a, b) => a[0] - b[0]);
}

/** Renders the timed stress case, so the limiter windows and voice stealing behave as they do live. */
export function renderStressTimed(seconds = 5, o: RenderOptions = {}): Promise<RenderStats> {
  const ctx = new OfflineAudioContext(CHANNELS, Math.ceil((PREROLL_S + seconds) * SAMPLE_RATE), SAMPLE_RATE);
  const graph = createGraph(ctx);
  levels(graph);
  const sfx = createSfx(graph, bankFor(o));
  const music = createMusic(graph, sfx.player);
  music.setBossPhase(3);
  music.setState('boss', 0.05);
  music.schedule(PREROLL_S + seconds);
  // group events by render quantum: one suspend per quantum
  const slots = new Map<number, ((sfx: Sfx) => void)[]>();
  for (const [at, fire] of stressEvents()) {
    const slot = Math.round((PREROLL_S + STRESS.START_S + at) / QUANTUM_S);
    const list = slots.get(slot) ?? [];
    list.push(fire);
    slots.set(slot, list);
  }
  for (const [slot, list] of slots) atTime(ctx, slot * QUANTUM_S, () => { for (const fire of list) fire(sfx); });
  return ctx.startRendering().then((buffer) => analyse('stress.timed', seconds, buffer, PREROLL_S));
}

export const OFFLINE_BIOMES = BIOME_IDS;
export const OFFLINE_BOSSES = BOSS_KINDS;
