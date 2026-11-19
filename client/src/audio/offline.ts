/**
 * Offline rendering helpers for verification (used by the dev harnesses and e2e checks, never by the game):
 * render a music state, an ambience or SFX with an OfflineAudioContext and report peak / RMS / DC offset.
 * Renders use the real samples (decoded once, shared by all renders) unless `samples: false` asks for the
 * synthesised fallbacks.
 */
import { BUFFS, CLASSES } from '@shared/data/classes.ts';
import { ENEMIES, ENEMY_TUNING } from '@shared/data/enemies.ts';
import {
  AFFIX_IDS, BIOME_IDS, BOSS_KINDS, CLASS_IDS, DOOR_TYPES, ELEMENT_IDS, ENEMY_KINDS, OBJECTIVE_KINDS,
  type BiomeId, type BossKind, type ObjectiveKind,
} from '@shared/types.ts';
import { createAmbience, type SceneId } from './ambience.ts';
import { KEYSTONES } from '@shared/data/keystones.ts';
import { createGraph, MIX, type AudioGraph } from './engine.ts';
import { KEYSTONE_FAMILIES, keystoneFamily, scoreVoices } from './keystone-map.ts';
import { createMusic, type MusicState } from './music.ts';
import { createBank, type Bank, type BankStats } from './samples.ts';
import { createSfx, type Sfx } from './sfx.ts';
import { HORDE_KINDS } from './sfx-horde.ts';
import { OBJECTIVE_SFX, TIMED_OBJECTIVES } from './sfx-objectives.ts';

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
  /** Spectral centroid in Hz (amplitude-weighted, averaged over the render weighted by frame energy): "how bright". */
  centroidHz: number;
  /** Strongest partial between TONAL_MIN_HZ and TONAL_MAX_HZ (bin centre): the note a tuned cue is heard on. */
  tonalHz: number;
  /**
   * Envelope, from 10 ms RMS frames: seconds from the first frame within 30 dB of the loudest one to the loudest
   * one (`riseS`), seconds spent within 30 dB of it (`activeS`), and the number of separate attacks (`onsets`:
   * frames that jump to more than twice the three frames before them and lie within 20 dB of the loudest).
   */
  riseS: number;
  activeS: number;
  onsets: number;
  /** Only with `RenderOptions.band`: level of the signal between those two frequencies over the whole render, dBFS. */
  bandDb?: number;
  /** Only with `RenderOptions.envelope`: RMS per 50 ms in dBFS, from the end of the pre-roll. */
  env?: number[];
}

export interface RenderOptions {
  /** false = render with an empty bank, i.e. the synthesised fallbacks. Default true. */
  samples?: boolean;
  boss?: BossKind;
  biome?: BiomeId;
  /** RunState.depth for music renders (0 = first descent). */
  depth?: number;
  /** Final bosses slain, for the stinger variants. */
  cleared?: number;
  /** Chamber objective for 'combat' music renders, with how far it has come (see Music.setObjective). */
  objective?: ObjectiveKind;
  pressure?: number;
  lit?: number;
  /** Update 5: keystones the own hero holds (their voices join the fighting pieces); the keystone-draft bed for 'calm'. */
  keystones?: string[];
  keystoneDraft?: boolean;
  /** Also measure the level inside this band [lo, hi] in Hz (`RenderStats.bandDb`): where a single voice of the score lives. */
  band?: [number, number];
  /** Also return the level curve (`RenderStats.env`), for checks of what happens at a given moment. */
  envelope?: boolean;
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

const FFT_SIZE = 2048;
const FFT_HOP = 1024;
/** Frames quieter than this (relative to the loudest frame) do not count towards the centroid. */
const CENTROID_FLOOR = 1e-4;

/** In-place radix-2 FFT. */
function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

const TONAL_MIN_HZ = 250;
const TONAL_MAX_HZ = 2400;

/** Spectral centroid and strongest partial of the left channel from `first` on. */
function spectrum(buffer: AudioBuffer, first: number): { centroidHz: number; tonalHz: number } {
  const data = buffer.getChannelData(0);
  const re = new Float32Array(FFT_SIZE);
  const im = new Float32Array(FFT_SIZE);
  const mags = new Float64Array(FFT_SIZE / 2);
  const frames: { energy: number; at: number }[] = [];
  let loudest = 0;
  for (let at = first; at + FFT_SIZE <= data.length; at += FFT_HOP) {
    let energy = 0;
    for (let i = 0; i < FFT_SIZE; i++) energy += data[at + i] * data[at + i];
    frames.push({ energy, at });
    loudest = Math.max(loudest, energy);
  }
  for (const frame of frames) {
    if (frame.energy < loudest * CENTROID_FLOOR) continue;
    for (let i = 0; i < FFT_SIZE; i++) {
      re[i] = data[frame.at + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1)));
      im[i] = 0;
    }
    fft(re, im);
    for (let i = 1; i < FFT_SIZE / 2; i++) mags[i] += Math.hypot(re[i], im[i]);
  }
  let sum = 0;
  let weighted = 0;
  for (let i = 1; i < FFT_SIZE / 2; i++) {
    sum += mags[i];
    weighted += mags[i] * ((i * buffer.sampleRate) / FFT_SIZE);
  }
  let best = 0;
  let bestAt = 0;
  for (let i = Math.ceil((TONAL_MIN_HZ * FFT_SIZE) / buffer.sampleRate); i <= (TONAL_MAX_HZ * FFT_SIZE) / buffer.sampleRate; i++) {
    if (mags[i] > best) { best = mags[i]; bestAt = i; }
  }
  return { centroidHz: sum > 0 ? weighted / sum : 0, tonalHz: (bestAt * buffer.sampleRate) / FFT_SIZE };
}

const ENV_FRAME_S = 0.01;
const ENV_ACTIVE = 0.0316; // -30 dB
const ENV_ONSET_FLOOR = 0.1; // -20 dB
const ENV_ONSET_RATIO = 2;
const ENV_ONSET_LOOKBACK = 3;

/** Envelope figures of the left channel from `first` on. */
function envelopeOf(buffer: AudioBuffer, first: number): { riseS: number; activeS: number; onsets: number } {
  const data = buffer.getChannelData(0);
  const size = Math.max(1, Math.floor(ENV_FRAME_S * buffer.sampleRate));
  const env: number[] = [];
  for (let at = first; at + size <= data.length; at += size) {
    let sum = 0;
    for (let i = 0; i < size; i++) sum += data[at + i] * data[at + i];
    env.push(Math.sqrt(sum / size));
  }
  let top = 0;
  let topAt = 0;
  env.forEach((v, i) => { if (v > top) { top = v; topAt = i; } });
  if (top <= SILENT_PEAK) return { riseS: 0, activeS: 0, onsets: 0 };
  const firstActive = env.findIndex((v) => v >= top * ENV_ACTIVE);
  let active = 0;
  let onsets = 0;
  for (let i = 0; i < env.length; i++) {
    if (env[i] >= top * ENV_ACTIVE) active++;
    let before = 0;
    for (let j = 1; j <= ENV_ONSET_LOOKBACK; j++) before = Math.max(before, env[i - j] ?? 0);
    if (env[i] >= top * ENV_ONSET_FLOOR && env[i] > before * ENV_ONSET_RATIO) onsets++;
  }
  return { riseS: (topAt - Math.max(0, firstActive)) * ENV_FRAME_S, activeS: active * ENV_FRAME_S, onsets };
}

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
    ...spectrum(buffer, first),
    ...envelopeOf(buffer, first),
  };
}

/** Runs `fire` when the render reaches `at` seconds (rounded to a render quantum). */
function atTime(ctx: OfflineAudioContext, at: number, fire: () => void): void {
  if (typeof ctx.suspend !== 'function') { fire(); return; }
  // an event after the end of the render cannot sound in it
  if (Math.round(at / QUANTUM_S) * QUANTUM_S >= ctx.length / ctx.sampleRate) return;
  void ctx.suspend(Math.round(at / QUANTUM_S) * QUANTUM_S).then(() => {
    try { fire(); } finally { void ctx.resume(); }
  });
}

/**
 * Renders `seconds` after the pre-roll. `build` wires the graph at time 0 and may return what to fire once the
 * pre-roll is over (one-shots); continuous material (music, ambience) simply starts in `build`.
 */
async function render(name: string, seconds: number, build: (ctx: OfflineAudioContext) => (() => void) | void, band?: [number, number]): Promise<RenderStats> {
  const ctx = new OfflineAudioContext(CHANNELS, Math.ceil((PREROLL_S + seconds) * SAMPLE_RATE), SAMPLE_RATE);
  const fire = build(ctx);
  if (fire) atTime(ctx, PREROLL_S, fire);
  const buffer = await ctx.startRendering();
  const stats = analyse(name, seconds, buffer, PREROLL_S);
  return band ? { ...stats, bandDb: bandDb(buffer, PREROLL_S, PREROLL_S + seconds, band[0], band[1]) } : stats;
}

function levels(graph: AudioGraph): void {
  graph.master.gain.value = 1;
  graph.music.gain.value = MIX.MUSIC_TRIM;
  graph.sfx.gain.value = MIX.SFX_TRIM;
}

/** Renders `seconds` of a music state at full user volume. `bossPhase` only matters for 'boss'. */
export function renderMusic(stateName: Exclude<MusicState, 'none'>, seconds: number, bossPhase = 1, o: RenderOptions = {}): Promise<RenderStats> {
  const objective = o.objective && o.objective !== 'slay' ? `[${o.objective}${o.pressure !== undefined ? ` p${o.pressure}` : ''}${o.lit !== undefined ? ` lit${o.lit}` : ''}]` : '';
  const keys = o.keystones?.length ? `+ks(${o.keystones.join(',')})` : o.keystoneDraft ? '+keystoneDraft' : '';
  const label = `music:${stateName}${objective}${stateName === 'boss' ? `.${o.boss ?? 'regent'}.${bossPhase}` : ''}${o.biome ? `@${o.biome}` : ''}${o.depth ? `/depth${o.depth}` : ''}${keys}`;
  return render(label, seconds, (ctx) => {
    const graph = createGraph(ctx);
    levels(graph);
    const music = createMusic(graph, createSfx(graph, bankFor(o)).player);
    music.setBossPhase(bossPhase);
    music.setBossKind(o.boss ?? 'regent');
    music.setBiome(o.biome ?? 'crypt');
    music.setDepth(o.depth ?? 0);
    music.setObjective(o.objective ?? null, o.pressure ?? 0, o.lit ?? 0);
    music.setKeystones(scoreVoices(o.keystones ?? []));
    music.setKeystoneDraft(o.keystoneDraft === true);
    music.setState(stateName, 0.05);
    music.schedule(PREROLL_S + seconds);
  }, o.band);
}

export function renderStinger(kind: 'victory' | 'defeat', o: RenderOptions = {}): Promise<RenderStats> {
  return render(`stinger:${kind}${o.cleared !== undefined ? `.cleared${o.cleared}` : ''}`, 6, (ctx) => {
    const graph = createGraph(ctx);
    levels(graph);
    const music = createMusic(graph, createSfx(graph, bankFor(o)).player);
    return () => music.stinger(kind, o.cleared);
  });
}

export function renderAmbience(biome: SceneId, seconds: number, o: RenderOptions = {}): Promise<RenderStats> {
  return render(`ambience:${biome}`, seconds, (ctx) => {
    const graph = createGraph(ctx);
    levels(graph);
    const ambience = createAmbience(graph, createSfx(graph, bankFor(o)).player);
    ambience.setBiome(biome);
    ambience.schedule(PREROLL_S + seconds);
  });
}

/** [name, what to play, seconds to render (default 3)]. */
type SfxCase = [string, (sfx: Sfx) => void, number?];

const HERO_CLASSES = Object.values(CLASSES);
/** Zone kinds with a bed, and how long they last by default. */
const ZONE_KINDS = HERO_CLASSES.flatMap((c) => [c.secondary, ...c.arts, c.ultimate]).filter((a) => a.shape === 'zone' || a.shape === 'trap');
let zoneId = 1;

/** Substring -> signature cue ids the bosses are expected to use (unknown ids fall back to the generic cast). */
export const BOSS_CUE_IDS = ['regent_volley', 'regent_slam', 'regent_summon', 'champion_sweep', 'champion_charge',
  'matron_beam', 'matron_wisp', 'matron_summon', 'stalker_leap', 'stalker_spear', 'stalker_volley', 'blink'] as const;

/** Signatures with a tail longer than the default render. */
const KEYSTONE_RENDER_S: Record<string, number> = { ember_wake: 4.5, phase_walker: 3, momentum_engine: 6, ks_shade: 3 };
/** One keystone per family for the moment renders. */
const MOMENT_IDS = Object.fromEntries(KEYSTONE_FAMILIES.map((family) => [family, KEYSTONES.find((def) => keystoneFamily(def.id) === family)?.id ?? 'ricochet'])) as Record<(typeof KEYSTONE_FAMILIES)[number], string>;

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
  ...HERO_CLASSES.flatMap((c): SfxCase[] => [
    ...c.arts.map((a): SfxCase => [`cast.art.${a.id}`, (s) => s.ability(a.id, true), 3 + a.duration * (a.shape === 'spin' ? 1 : 0)]),
    [`cast.ult.${c.ultimate.id}`, (s) => s.ability(c.ultimate.id, true), 4],
  ]),
  ['cast.ult.ally.mage_meteor', (s) => s.ability('mage_meteor', false), 4],
  ['cast.unknown_id', (s) => s.ability('future_ability', true)],
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
  ...AFFIX_IDS.map((affix): SfxCase => [`enemy.affix.${affix}`, (s) => s.spawn('warrior', true, affix)]),
  ['enemy.spawn.elite', (s) => s.spawn('warrior', true)],
  ...ZONE_KINDS.map((a): SfxCase => [`zone.${a.id}`, (s) => s.zone(zoneId++, a.id, a.duration, null, true), Math.min(a.duration, 10) + 1.5]),
  ['zone.ally.templar_consecrate', (s) => s.zone(zoneId++, 'templar_consecrate', 5, null, false), 6.5],
  ['zone.trap.snap', (s) => { const id = zoneId++; s.zone(id, 'rogue_trap', 14, null, true); s.zoneEnd(id, true); }],
  ['zone.unknown_kind', (s) => s.zone(zoneId++, 'future_zone', 3, 'umbra', true)],
  ...(Object.keys(BUFFS) as (keyof typeof BUFFS)[]).map((id): SfxCase => [`buff.${id}`, (s) => s.buff(id, true), 4]),
  ['buff.ally.bulwark', (s) => s.buff('bulwark', false), 4],
  ['mark', (s) => s.mark()],
  ['ultReady.own', (s) => s.ultReady(true)],
  ['ultReady.ally', (s) => s.ultReady(false)],
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
  ['flow.descend.1', (s) => s.descend(1), 5],
  ['flow.descend.6', (s) => s.descend(6), 5],
  ...[1, 2].flatMap((tier): SfxCase[] => [
    [`flow.set.tier${tier}`, (s) => s.setBonus(tier, null, true)],
    [`flow.set.umbra.tier${tier}`, (s) => s.setBonus(tier, 'umbra', true)],
  ]),
  ['flow.set.ally', (s) => s.setBonus(1, null, false)],
  ['flow.legendary.offered', (s) => s.legendaryOffered()],
  ['flow.legendary.picked', (s) => s.legendaryPicked(true)],
  ['flow.legendary.ally', (s) => s.legendaryPicked(false)],
  ['progress.xpTicks.small', (s) => { s.xpTicks(40); }],
  ['progress.xpTicks.large', (s) => { s.xpTicks(4000); }],
  ...[1, 2, 4].map((n): SfxCase => [`progress.levelUp.${n}`, (s) => s.levelUp(n), 5]),
  ['progress.relic.shard', (s) => s.relicShard(false)],
  ['progress.relic.rankUp', (s) => s.relicShard(true)],
  ['progress.feat', (s) => s.featReady()],
  ['progress.sequence', (s) => s.progress({ xp: 600, levelsGained: 2, relics: [{ rank: 1, rankUp: false }, { rank: 2, rankUp: true }], featsReady: 1 }), 8],
  ['ui.ascend', (s) => s.ascendRank()],
  ['ui.talent', (s) => s.talentPick()],
  ['ui.relic', (s) => s.relicEquip()],
  ['ui.claim', (s) => s.claim()],
  ['ui.art', (s) => s.artPick()],
  // ---- update 4: the horde (spawn signature alone, action cue, death layer alone), wards, objectives
  ...HORDE_KINDS.map((kind): SfxCase => [`horde.spawn.${kind}`, (s) => s.hordeSpawn(kind)]),
  ['horde.action.shaman.mend', (s) => s.enemyCast('mend', 'shaman', hordeId++)],
  ['horde.action.shaman.release', (s) => s.mendRelease(hordeId++, 3)],
  ['horde.action.aegis.domeUp', (s) => s.dome(true)],
  ['horde.action.aegis.domeDown', (s) => s.dome(false)],
  ['horde.action.bomber.fuse', (s) => s.enemyCast('fuse', 'bomber', hordeId++)],
  ['horde.action.bomber.burst', (s) => s.bomberBurst()],
  ['horde.action.bomber.slain', (s) => s.kill('bomber', true, hordeId++)],
  ['horde.action.necromancer.raise', (s) => s.enemyCast('raise', 'necromancer', hordeId++)],
  ['horde.action.reaver.leap', (s) => s.enemyCast('reaver_leap', 'reaver', hordeId++)],
  ...HORDE_KINDS.filter((kind) => kind !== 'bomber').map((kind): SfxCase => [`horde.death.${kind}`, (s) => { s.hordeDeath(kind, hordeId++); }]),
  ...ELEMENT_IDS.map((el): SfxCase => [`ward.deflect.${el}`, (s) => s.wardDeflect(el)]),
  ...OBJECTIVE_KINDS.filter((kind) => kind !== 'slay').map((kind): SfxCase => [`objective.start.${kind}`, (s) => s.objectiveStart(kind)]),
  ...[1, 2, 3].map((n): SfxCase => [`objective.site.${n}of3`, (s) => s.siteLit(n, 3)]),
  ['objective.anchorHit.full', (s) => s.anchorHit(1)],
  ['objective.anchorHit.low', (s) => s.anchorHit(0.15)],
  ['objective.shatter', (s) => s.anchorShatter()],
  ['objective.enrage', (s) => s.huntEnrage()],
  ['objective.bonusLost', (s) => s.bonusLost()],
  ['objective.done.bonus', (s) => s.objectiveDone('survive', true)],
  ['objective.done.plain', (s) => s.objectiveDone('survive', false)],
  ['objective.reliquary', (s) => s.objectiveDone('vault', false), 4],
  // the whole countdown, scheduled ahead like the clock does it second by second
  ...TIMED_OBJECTIVES.map((kind): SfxCase => [`objective.timer.${kind}`, (s) => s.timerCountdown(kind), OBJECTIVE_SFX.TIMER_SECONDS + 1]),
  // ---- update 5: keystones
  ...KEYSTONES.flatMap((def): SfxCase[] => [
    [`keystone.sig.${def.id}`, (s) => playSignature(s, def.id, true), KEYSTONE_RENDER_S[def.id] ?? 2.5],
    [`keystone.sigAlly.${def.id}`, (s) => playSignature(s, def.id, false), 2.5],
  ]),
  ['keystone.ricochet.last', (s) => s.keystoneProc('ricochet', true, { n: 0 })],
  ['keystone.bloom.chain4', (s) => { for (let i = 0; i < 4; i++) atOffset(s, i * 0.15, () => s.keystoneProc('corpse_bloom', true, { n: i + 1, r: 3 })); }],
  ...[1, 5, 10].map((n): SfxCase => [`keystone.rush.${n}`, (s) => s.keystoneProc('momentum_engine', true, { n }), 6]),
  ['keystone.resonanceEngine.full', (s) => s.keystoneProc('resonance_engine', true, { n: 100 })],
  ['keystone.cost.brittle', (s) => s.brittleHit(true)],
  ['keystone.cost.brittleAlly', (s) => s.brittleHit(false)],
  ['keystone.cost.hurt+brittle', (s) => { s.hurt(true, 30); s.brittleHit(true); }],
  ['keystone.cost.titanSwing', (s) => s.titanSwing(true)],
  ['keystone.cost.titan.swing+blow', (s) => { s.primary('knight', 0, true); s.titanSwing(true); atOffset(s, 0.45, () => { s.hit({ dmg: 60, crit: false, el: null, own: true, weapon: 'knight' }); s.keystoneProc('heavy_hitter', true); }); }],
  ...KEYSTONE_FAMILIES.map((family): SfxCase => [`keystone.moment.${family}`, (s) => s.keystoneTaken(MOMENT_IDS[family], true), 4.5]),
  ['keystone.moment.replaced', (s) => s.keystoneTaken('ricochet', true, true), 5],
  ['keystone.momentAlly', (s) => s.keystoneTaken('ricochet', false)],
  ['keystone.momentAlly.replaced', (s) => s.keystoneTaken('ricochet', false, true)],
  ['keystone.draftOpen', (s) => s.keystoneDraftOpen(false), 3.5],
  ['keystone.draftOpen.full', (s) => s.keystoneDraftOpen(true), 3.5],
  ['keystone.pick.plain', (s) => s.draftPick()],
  ['keystone.pick.fits1', (s) => { s.draftPick(); s.fitsPick(1); }],
  ['keystone.pick.fits3', (s) => { s.draftPick(); s.fitsPick(3); }],
  ...(['knight', 'mage', 'shade'] as const).flatMap((cls): SfxCase[] => [0, 1, 2].flatMap((held): SfxCase[] => [
    [`keystone.power.primary.${cls}.${held}`, (s) => { s.primary(cls, 0, true); s.powerLayer('primary', held); }],
    [`keystone.power.secondary.${cls}.${held}`, (s) => { s.secondary(cls, true); s.powerLayer('secondary', held); }],
  ])),
  ['keystone.loop.whirr', (s) => s.orbitWhirr(true), 4],
  ['keystone.loop.stream', (s) => { for (let i = 0; i < 20; i++) atOffset(s, i * 0.1, () => s.stream('own')); }, 4],
  ['keystone.loop.streamAlly', (s) => { for (let i = 0; i < 20; i++) atOffset(s, i * 0.1, () => s.stream(1)); }, 4],
  ['keystone.loop.sanctum', (s) => s.sanctumWalk(zoneId++, 6, true), 7],
];

/** Runs `fire` `seconds` later on the context the sounds play in (offline: at that render time; live: by timer). */
function atOffset(sfx: Sfx, seconds: number, fire: () => void): void {
  const ctx = sfx.context;
  if (seconds <= 0) { fire(); return; }
  if (typeof OfflineAudioContext !== 'undefined' && ctx instanceof OfflineAudioContext) atTime(ctx, ctx.currentTime + seconds, fire);
  else window.setTimeout(fire, seconds * 1000);
}

/** One keystone's signature as the game triggers it (a chain-lightning burst is three arcs in one tick). */
export function playSignature(sfx: Sfx, id: string, own: boolean): void {
  if (id === 'chain_lightning') { for (let i = 0; i < 3; i++) sfx.keystoneProc(id, own); return; }
  if (id === 'ricochet') { sfx.keystoneProc(id, own, { n: 1 }); return; }
  if (id === 'ks_spellblade') { sfx.keystoneProc(id, own, { n: 1 }); return; }
  if (id === 'orbit_blades') { sfx.keystoneProc(id, own); return; }
  sfx.keystoneProc(id, own, { r: 3, n: id === 'momentum_engine' ? 3 : id === 'resonance_engine' ? 40 : undefined });
}

let hordeId = 1000;

/** [seconds after the start, what to do]. */
export type TimedEvent = [number, (sfx: Sfx) => void];

/**
 * Update 4 sequences that only make sense in time: a mend that goes through, one that is interrupted, one cut by
 * the shaman's death; a fuse answered by the sim's blast; a bomber slain mid-fuse; a reaver killed in the air.
 */
export const HORDE_SEQUENCES: [string, TimedEvent[], number][] = [
  ['horde.seq.mend.completed', [[0, (s) => s.enemyCast('mend', 'shaman', 1)], [ENEMY_TUNING.SHAMAN.MEND_WINDUP, (s) => s.mendRelease(1, 2)]], 3.5],
  ['horde.seq.mend.interrupted', [[0, (s) => s.enemyCast('mend', 'shaman', 2)], [ENEMY_TUNING.SHAMAN.MEND_WINDUP / 2, (s) => s.interrupt(2)]], 3.5],
  ['horde.seq.mend.killed', [[0, (s) => s.enemyCast('mend', 'shaman', 3)], [ENEMY_TUNING.SHAMAN.MEND_WINDUP / 2, (s) => s.kill('shaman', true, 3)]], 3.5],
  ['horde.seq.fuse.burst(aoe,kill)', [[0, (s) => s.enemyCast('fuse', 'bomber', 4)], [ENEMIES.bomber.windup, (s) => { s.aoe(null, true); s.kill('bomber', false, 4); }]], 3],
  ['horde.seq.fuse.burst(kill,aoe)', [[0, (s) => s.enemyCast('fuse', 'bomber', 5)], [ENEMIES.bomber.windup, (s) => { s.kill('bomber', false, 5); s.aoe(null, true); }]], 3],
  ['horde.seq.fuse.slain', [[0, (s) => s.enemyCast('fuse', 'bomber', 6)], [ENEMIES.bomber.windup / 2, (s) => s.kill('bomber', true, 6)],
    [ENEMIES.bomber.windup / 2 + ENEMY_TUNING.BOMBER.DEATH_BLAST_DELAY, (s) => s.aoe(null, true)]], 3],
  // the sim's report arrives a little after the local fuse has ended (network jitter)
  ['horde.seq.fuse.burst(late kill,aoe)', [[0, (s) => s.enemyCast('fuse', 'bomber', 10)], [ENEMIES.bomber.windup + 0.12, (s) => { s.kill('bomber', false, 10); s.aoe(null, true); }]], 3],
  ['horde.seq.fuse.burst(early aoe,kill)', [[0, (s) => s.enemyCast('fuse', 'bomber', 11)], [ENEMIES.bomber.windup - 0.1, (s) => { s.aoe(null, true); s.kill('bomber', false, 11); }]], 3],
  ['horde.seq.fuse.stunned', [[0, (s) => s.enemyCast('fuse', 'bomber', 7)], [ENEMIES.bomber.windup / 2, (s) => s.interrupt(7)]], 3],
  ['horde.seq.leap.lands(aoe)', [[0, (s) => s.enemyCast('reaver_leap', 'reaver', 12)], [ENEMY_TUNING.REAVER.LEAP_AIR_TIME + 0.03, (s) => s.aoe(null, true)]], 3],
  ['horde.seq.raise.interrupted', [[0, (s) => s.enemyCast('raise', 'necromancer', 13)], [ENEMIES.necromancer.windup / 2, (s) => s.interrupt(13)]], 3],
  ['horde.seq.leap.interrupted', [[0, (s) => s.enemyCast('reaver_leap', 'reaver', 14)], [ENEMY_TUNING.REAVER.LEAP_AIR_TIME / 2, (s) => s.interrupt(14)],
    [ENEMY_TUNING.REAVER.LEAP_AIR_TIME, (s) => s.aoe(null, true)]], 3],
  ['horde.seq.leap.killed', [[0, (s) => s.enemyCast('reaver_leap', 'reaver', 8)], [ENEMY_TUNING.REAVER.LEAP_AIR_TIME / 2, (s) => s.kill('reaver', true, 8)]], 3],
  ['horde.seq.necromancer.dies', [[0, (s) => s.kill('necromancer', true, 9)], [0.02, (s) => { for (let i = 0; i < 6; i++) s.kill('minion', false, 20 + i); }]], 3],
];

/** Renders a timed list of events with nothing else playing (`from` = seconds after the pre-roll the list starts). */
export function renderSequence(name: string, events: TimedEvent[], seconds: number, o: RenderOptions = {}): Promise<RenderStats> {
  const ctx = new OfflineAudioContext(CHANNELS, Math.ceil((PREROLL_S + seconds) * SAMPLE_RATE), SAMPLE_RATE);
  const graph = createGraph(ctx);
  levels(graph);
  const sfx = createSfx(graph, bankFor(o));
  fireTimed(ctx, sfx, events, 0);
  return ctx.startRendering().then((buffer) => {
    const stats = analyse(`sfx:${name}`, seconds, buffer, PREROLL_S);
    return o.envelope ? { ...stats, env: curveOf(buffer, PREROLL_S) } : stats;
  });
}

const CURVE_FRAME_S = 0.05;

/** RMS per 50 ms over both channels, in dBFS. */
function curveOf(buffer: AudioBuffer, from: number): number[] {
  const size = Math.floor(CURVE_FRAME_S * buffer.sampleRate);
  const first = Math.floor(from * buffer.sampleRate);
  const out: number[] = [];
  for (let at = first; at + size <= buffer.length; at += size) {
    let sum = 0;
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const data = buffer.getChannelData(ch);
      for (let i = 0; i < size; i++) sum += data[at + i] * data[at + i];
    }
    out.push(Math.round(toDb(Math.sqrt(sum / (size * buffer.numberOfChannels))) * 10) / 10);
  }
  return out;
}

/** One suspend per render quantum that has events. */
function fireTimed(ctx: OfflineAudioContext, sfx: Sfx, events: TimedEvent[], startS: number): void {
  const slots = new Map<number, ((sfx: Sfx) => void)[]>();
  for (const [at, fire] of events) {
    const slot = Math.round((PREROLL_S + startS + at) / QUANTUM_S);
    const list = slots.get(slot) ?? [];
    list.push(fire);
    slots.set(slot, list);
  }
  for (const [slot, list] of slots) atTime(ctx, slot * QUANTUM_S, () => { for (const fire of list) fire(sfx); });
}

/**
 * Update 4 worst case: a pack of six bombers lighting their fuses and bursting, two ultimates, the last seconds of
 * a survive timer, a Resonance chain of all six reactions, a reaver landing, a shard shattering and hits, over
 * the survive piece at full pressure at the deepest depth.
 */
export const OBJECTIVE_STRESS = { BOMBERS: 6, HITS: 30, SECONDS: 7 } as const;

export function objectiveStressEvents(): TimedEvent[] {
  const events: TimedEvent[] = [];
  const fuse = ENEMIES.bomber.windup;
  for (let i = 0; i < OBJECTIVE_STRESS.BOMBERS; i++) {
    const at = 0.2 + i * 0.07;
    events.push([at - 0.2, (s) => s.spawn('bomber', false)]);
    events.push([at, (s) => s.enemyCast('fuse', 'bomber', 500 + i)]);
    events.push([at, (s) => s.telegraph(fuse)]);
    events.push([at + fuse, (s) => { s.aoe(null, true); s.kill('bomber', i % 2 === 0, 500 + i); s.hurt(i === 0, 26); }]);
  }
  events.push([0.3, (s) => s.ability('mage_meteor', true)], [0.38, (s) => s.ability('templar_sanctuary', false)]);
  const pairs: [number, number][] = [[0, 1], [0, 2], [1, 2], [0, 3], [1, 3], [2, 3]];
  pairs.forEach(([a, b], i) => events.push([0.5 + i * 0.22, (s) => s.resonance(ELEMENT_IDS[a], ELEMENT_IDS[b], i % 2 === 0)]));
  for (let i = 0; i < OBJECTIVE_STRESS.HITS; i++) {
    events.push([0.2 + i * 0.05, (s) => s.hit({ dmg: 15 + (i % 6) * 12, crit: i % 4 === 0, el: ELEMENT_IDS[i % 4], own: i % 3 === 0, weapon: CLASS_IDS[i % CLASS_IDS.length] })]);
  }
  events.push([0.6, (s) => s.enemyCast('reaver_leap', 'reaver', 520)], [0.9, (s) => s.enemyCast('mend', 'shaman', 521)], [1, (s) => s.dome(true)]);
  events.push([1.3, (s) => s.anchorShatter()], [1.6, (s) => s.dome(false)], [1.1, (s) => s.wardDeflect('ember')]);
  // the timer: seconds 3, 2, 1 with their pick-ups, landing on the bursts
  events.push([0, (s) => s.timerCountdown('survive', OBJECTIVE_SFX.TIMER_URGENT)]);
  events.push([3, (s) => s.objectiveDone('survive', true)], [3.3, (s) => s.chamberClear()]);
  return events.sort((a, b) => a[0] - b[0]);
}

export function renderObjectiveStress(seconds: number = OBJECTIVE_STRESS.SECONDS, o: RenderOptions = {}): Promise<RenderStats> {
  const ctx = new OfflineAudioContext(CHANNELS, Math.ceil((PREROLL_S + seconds) * SAMPLE_RATE), SAMPLE_RATE);
  const graph = createGraph(ctx);
  levels(graph);
  const sfx = createSfx(graph, bankFor(o));
  const music = createMusic(graph, sfx.player);
  music.setDepth(5);
  music.setObjective('survive', 1);
  music.setState('combat', 0.05);
  music.schedule(PREROLL_S + seconds);
  fireTimed(ctx, sfx, objectiveStressEvents(), STRESS.START_S);
  return ctx.startRendering().then((buffer) => analyse('stress.objective', seconds, buffer, PREROLL_S));
}

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

/**
 * Update 3 worst case: four heroes fire their ultimates within 150 ms while a Resonance chain of all six named
 * reactions runs, with zones, buffs, marks and hits on top, over the boss score at the deepest depth.
 */
export function ultimateStressEvents(): [number, (sfx: Sfx) => void][] {
  const events: [number, (sfx: Sfx) => void][] = [];
  const ults = ['mage_meteor', 'spell_overload', 'templar_sanctuary', 'barb_rage', 'shade_mark', 'knight_bulwark', 'rogue_volley'];
  ults.slice(0, 4).forEach((id, i) => events.push([i * 0.05, (s) => s.ability(id, i === 0)]));
  events.push([0.4, (s) => { s.buff('bloodrage', false); s.buff('overload', true); s.zone(zoneId++, 'templar_sanctuary', 6, null, false); }]);
  const pairs: [number, number][] = [[0, 1], [0, 2], [1, 2], [0, 3], [1, 3], [2, 3]];
  pairs.forEach(([a, b], i) => events.push([0.3 + i * 0.22, (s) => s.resonance(ELEMENT_IDS[a], ELEMENT_IDS[b], i % 2 === 0)]));
  for (let i = 0; i < 40; i++) events.push([0.2 + i * 0.035, (s) => s.hit({ dmg: 15 + (i % 6) * 12, crit: i % 4 === 0, el: ELEMENT_IDS[i % 4], own: i % 3 === 0, weapon: CLASS_IDS[i % CLASS_IDS.length] })]);
  for (let i = 0; i < 6; i++) events.push([1.15 + i * 0.03, (s) => s.mark()]);
  for (let i = 0; i < 10; i++) events.push([0.5 + i * 0.1, (s) => s.kill(i % 5 === 0 ? 'champion' : 'minion', true)]);
  return events.sort((a, b) => a[0] - b[0]);
}

/** Renders a timed list of events over the boss score (phase 3) at `depth`. */
function renderTimed(name: string, events: [number, (sfx: Sfx) => void][], seconds: number, depth: number, o: RenderOptions): Promise<RenderStats> {
  const ctx = new OfflineAudioContext(CHANNELS, Math.ceil((PREROLL_S + seconds) * SAMPLE_RATE), SAMPLE_RATE);
  const graph = createGraph(ctx);
  levels(graph);
  const sfx = createSfx(graph, bankFor(o));
  const music = createMusic(graph, sfx.player);
  music.setBossPhase(3);
  music.setDepth(depth);
  music.setState('boss', 0.05);
  music.schedule(PREROLL_S + seconds);
  const slots = new Map<number, ((sfx: Sfx) => void)[]>();
  for (const [at, fire] of events) {
    const slot = Math.round((PREROLL_S + STRESS.START_S + at) / QUANTUM_S);
    const list = slots.get(slot) ?? [];
    list.push(fire);
    slots.set(slot, list);
  }
  for (const [slot, list] of slots) atTime(ctx, slot * QUANTUM_S, () => { for (const fire of list) fire(sfx); });
  return ctx.startRendering().then((buffer) => analyse(name, seconds, buffer, PREROLL_S));
}

export function renderUltimateStress(seconds = 7, o: RenderOptions = {}): Promise<RenderStats> {
  return renderTimed('stress.ultimates', ultimateStressEvents(), seconds, 5, o);
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

// ------------------------------------------------------------------ update 5: keystone worst case and masking

/**
 * Update 5 worst case: four heroes with two keystones each at the sim's caps (a proc burst per hero and keystone
 * every 0.15 s; corpse blooms chaining four per tick; three chain-lightning arcs per burst; ricochets; the own
 * hero's attacks with both power layers, the blades' whirr, the Bloodrush pulse at ten stacks, a keystone moment),
 * on top of the whole update 4 worst case, over the survive piece at full pressure, deepest depth, two keystone voices.
 */
export const KEYSTONE_STRESS = { SECONDS: 7, SPAN_S: 3.2, PROC_GAP_S: 0.15, HEROES: 4 } as const;
/** Two keystones per hero slot (slot 0 = the own hero). */
const STRESS_BUILDS: [string, string][] = [['corpse_bloom', 'chain_lightning'], ['ricochet', 'orbit_blades'], ['momentum_engine', 'ks_knight'], ['twin_cast', 'shockstep']];

export function keystoneLayerEvents(): TimedEvent[] {
  const events: TimedEvent[] = [];
  events.push([0, (s) => s.orbitWhirr(true)]);
  for (let at = 0, i = 0; at < KEYSTONE_STRESS.SPAN_S; at += KEYSTONE_STRESS.PROC_GAP_S, i++) {
    const tick = i;
    STRESS_BUILDS.forEach((build, slot) => {
      const own = slot === 0;
      for (const id of build) {
        if (id === 'corpse_bloom') events.push([at, (s) => { for (let c = 0; c < 4; c++) s.keystoneProc(id, own, { n: (tick % 4) + 1, r: 3 }); }]);
        else if (id === 'chain_lightning') { if (tick % 2 === 0) events.push([at, (s) => { for (let c = 0; c < 3; c++) s.keystoneProc(id, own); }]); }
        else if (id === 'ricochet') events.push([at, (s) => s.keystoneProc(id, own, { n: tick % 2 })]);
        else if (id === 'momentum_engine') events.push([at, (s) => s.keystoneProc(id, own, { n: Math.min(10, tick + 1) })]);
        else if (id === 'orbit_blades') events.push([at, (s) => s.keystoneProc(id, own)]);
        else if (tick % 3 === 0) events.push([at, (s) => s.keystoneProc(id, own, { r: 3.2 })]);
      }
    });
    // the own hero keeps attacking with both layers; a second own Bloodrush would be a third keystone, so slot 2 is an ally
    if (tick % 2 === 0) events.push([at, (s) => { s.primary('spellblade', tick % 3, true); s.powerLayer('primary', 2); }]);
    if (tick % 7 === 3) events.push([at, (s) => { s.secondary('mage', true); s.powerLayer('secondary', 2); }]);
  }
  events.push([0.4, (s) => s.keystoneProc('momentum_engine', true, { n: 10 })]);
  events.push([1.2, (s) => { s.hurt(true, 40); s.brittleHit(true); }]);
  return events.sort((a, b) => a[0] - b[0]);
}

export function keystoneStressEvents(): TimedEvent[] {
  return [...keystoneLayerEvents(), ...objectiveStressEvents()].sort((a, b) => a[0] - b[0]);
}

interface TimedRender { events: TimedEvent[]; seconds: number; music?: boolean; keystones?: string[]; samples?: boolean }

/** Renders a timed list over (optionally) the survive piece at full pressure and depth 5, and returns the raw buffer. */
function renderTimedBuffer(r: TimedRender): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(CHANNELS, Math.ceil((PREROLL_S + r.seconds) * SAMPLE_RATE), SAMPLE_RATE);
  const graph = createGraph(ctx);
  levels(graph);
  const sfx = createSfx(graph, bankFor({ samples: r.samples }));
  if (r.music !== false) {
    const music = createMusic(graph, sfx.player);
    music.setDepth(5);
    music.setObjective('survive', 1);
    music.setKeystones(scoreVoices(r.keystones ?? []));
    music.setState('combat', 0.05);
    music.schedule(PREROLL_S + r.seconds);
  }
  fireTimed(ctx, sfx, r.events, STRESS.START_S);
  return ctx.startRendering();
}

export function renderKeystoneStress(seconds: number = KEYSTONE_STRESS.SECONDS, o: RenderOptions = {}): Promise<RenderStats> {
  return renderTimedBuffer({ events: keystoneStressEvents(), seconds, keystones: STRESS_BUILDS[0], samples: o.samples })
    .then((buffer) => analyse('stress.keystones', seconds, buffer, PREROLL_S));
}

/** Level (dBFS, RMS of the band-limited signal, left channel) between `lo` and `hi` Hz over [fromS, toS) of a buffer. */
function bandDb(buffer: AudioBuffer, fromS: number, toS: number, lo: number, hi: number): number {
  const data = buffer.getChannelData(0);
  const re = new Float32Array(FFT_SIZE);
  const im = new Float32Array(FFT_SIZE);
  const binHz = buffer.sampleRate / FFT_SIZE;
  const first = Math.floor(fromS * buffer.sampleRate);
  const last = Math.min(data.length, Math.floor(toS * buffer.sampleRate));
  let power = 0;
  let frames = 0;
  let window = 0;
  for (let i = 0; i < FFT_SIZE; i++) window += Math.pow(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT_SIZE), 2);
  for (let at = first; at + FFT_SIZE <= last; at += FFT_HOP) {
    for (let i = 0; i < FFT_SIZE; i++) {
      re[i] = data[at + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT_SIZE));
      im[i] = 0;
    }
    fft(re, im);
    for (let b = Math.ceil(lo / binHz); b <= Math.floor(hi / binHz) && b < FFT_SIZE / 2; b++) power += 2 * (re[b] * re[b] + im[b] * im[b]);
    frames++;
  }
  // Parseval: mean square of the band-limited signal
  return toDb(Math.sqrt(power / Math.max(1, frames) / (FFT_SIZE * window)));
}

export const MASKING = {
  /** When the warning starts in the stress (s after its start) and how long its band is measured. */
  CUE_AT_S: 1.2,
  FUSE: { lo: 5000, hi: 12000, seconds: 0.8 },
  LEAP: { lo: 2000, hi: 8000, seconds: 0.8 },
  RUNS: 3,
} as const;

export interface MaskingResult {
  cue: 'fuse' | 'leap';
  /** The cue alone, in its band (dBFS). */
  aloneDb: number;
  /** The fight without keystones (hits, casts, Resonances, score) in that band at that moment: the bed before update 5. */
  bedBeforeDb: number;
  /** The same fight with the whole keystone layer on top. */
  bedAfterDb: number;
  /** The keystone bed with the cue in it. */
  withCueDb: number;
  /** Cue above bed, before and after update 5 (dB; positive = the cue is the loudest thing in its band). */
  marginBeforeDb: number;
  marginAfterDb: number;
  /** How much the band rises when the cue joins the keystone bed (dB). */
  liftDb: number;
}

/** The fight the warnings have to cut through, without bombers and reavers of its own. */
function maskingBed(keystones: boolean): TimedEvent[] {
  const events: TimedEvent[] = [];
  for (let i = 0; i < 60; i++) {
    events.push([i * 0.055, (s) => s.hit({ dmg: 15 + (i % 6) * 12, crit: i % 4 === 0, el: ELEMENT_IDS[i % 4], own: i % 3 === 0, weapon: CLASS_IDS[i % CLASS_IDS.length] })]);
  }
  for (let i = 0; i < 12; i++) events.push([i * 0.27, (s) => s.kill('minion', i % 2 === 0)]);
  for (let i = 0; i < 4; i++) events.push([0.3 + i * 0.7, (s) => s.resonance(ELEMENT_IDS[i % 3], ELEMENT_IDS[(i + 1) % 3], i % 2 === 0)]);
  if (keystones) events.push(...keystoneLayerEvents());
  else for (let i = 0; i < 11; i++) events.push([i * 0.3, (s) => s.primary('spellblade', i % 3, true)]);
  return events.sort((a, b) => a[0] - b[0]);
}

/**
 * Do the bomber's fuse and the reaver's leap still stand out when four heroes' keystones are going off? Renders the
 * cue alone, the fight without and with the keystone layer, and the keystone fight with the cue, and compares the
 * level in the cue's own band while it sounds. Random variation is averaged over MASKING.RUNS renders each.
 */
export async function renderKeystoneMasking(o: RenderOptions = {}): Promise<MaskingResult[]> {
  const out: MaskingResult[] = [];
  const seconds = 5;
  const cues: ['fuse' | 'leap', (s: Sfx) => void, { lo: number; hi: number; seconds: number }][] = [
    ['fuse', (s) => s.enemyCast('fuse', 'bomber', 900 + hordeId++), MASKING.FUSE],
    ['leap', (s) => s.enemyCast('reaver_leap', 'reaver', 900 + hordeId++), MASKING.LEAP],
  ];
  for (const [cue, play, band] of cues) {
    const from = PREROLL_S + STRESS.START_S + MASKING.CUE_AT_S;
    const measure = async (events: TimedEvent[], music: boolean, keystones: string[]): Promise<number> => {
      let sum = 0;
      for (let run = 0; run < MASKING.RUNS; run++) {
        const buffer = await renderTimedBuffer({ events, seconds, music, keystones, samples: o.samples });
        sum += Math.pow(10, bandDb(buffer, from, from + band.seconds, band.lo, band.hi) / 10);
      }
      return 10 * Math.log10(sum / MASKING.RUNS);
    };
    const cueEvent: TimedEvent = [MASKING.CUE_AT_S, play];
    const aloneDb = await measure([cueEvent], false, []);
    const bedBeforeDb = await measure(maskingBed(false), true, []);
    const bedAfterDb = await measure(maskingBed(true), true, STRESS_BUILDS[0]);
    const withCueDb = await measure([...maskingBed(true), cueEvent].sort((a, b) => a[0] - b[0]), true, STRESS_BUILDS[0]);
    out.push({ cue, aloneDb, bedBeforeDb, bedAfterDb, withCueDb, marginBeforeDb: aloneDb - bedBeforeDb, marginAfterDb: aloneDb - bedAfterDb, liftDb: withCueDb - bedAfterDb });
  }
  return out;
}

export interface Closeness { a: string; b: string; distance: number; centroidRatio: number; riseDiffS: number; activeDiffS: number; onsetDiff: number; levelDiffDb: number }

/**
 * How far apart two renders are for a listener who only has register and gesture to go by: octaves between the
 * centroids, plus differences of attack time, sounding time and number of attacks (each scaled to "clearly
 * different" = 1). Below 1 two sounds share a register AND a gesture.
 */
export function closeness(a: RenderStats, b: RenderStats): Closeness {
  const centroidRatio = Math.max(a.centroidHz, b.centroidHz) / Math.max(1, Math.min(a.centroidHz, b.centroidHz));
  const riseDiffS = Math.abs(a.riseS - b.riseS);
  const activeDiffS = Math.abs(a.activeS - b.activeS);
  const onsetDiff = Math.abs(a.onsets - b.onsets);
  const octaves = Math.log2(centroidRatio);
  const distance = Math.hypot(octaves / 0.5, riseDiffS / 0.1, Math.abs(Math.log2(Math.max(0.05, a.activeS) / Math.max(0.05, b.activeS))) / 1, onsetDiff / 2);
  return { a: a.name, b: b.name, distance, centroidRatio, riseDiffS, activeDiffS, onsetDiff, levelDiffDb: Math.abs(a.loudDb - b.loudDb) };
}

/** All pairs of `stats`, closest first. */
export function closestPairs(stats: RenderStats[]): Closeness[] {
  const out: Closeness[] = [];
  for (let i = 0; i < stats.length; i++) for (let j = i + 1; j < stats.length; j++) out.push(closeness(stats[i], stats[j]));
  return out.sort((x, y) => x.distance - y.distance);
}
