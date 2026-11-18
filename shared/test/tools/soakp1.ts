/**
 * Polish 1 balance soak: `npx tsx --tsconfig server/tsconfig.json shared/test/tools/soakp1.ts [seeds] [mode] [doors] [classes]`.
 * mode: solo (default) | party | max | maxparty        doors: mixed (default; the usual bot door choice) | prefer
 * (special objectives preferred) | classic (slay only) | cursed (cursed doors preferred)
 * classes: comma separated filter for the solo modes.
 * Prints, per party: win rate, ultimates per hero (per run and per game minute), relic shards per hero and run and
 * cursed chambers entered per run; then per objective: chambers played, bonus rate, how many runs ended there
 * (also as a share of the chambers played), time and downs.
 */
import { maxBuild, maxMetaLevels } from '@shared/sim/index.ts';
import { BOSS_KINDS, CLASS_IDS, OBJECTIVE_KINDS, type ClassId, type ObjectiveKind } from '@shared/types.ts';
import { runBots, type RunResult } from '../harness.ts';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const seeds = Number(args[0] ?? 6);
const mode = args[1] ?? 'solo';
const doors = args[2] ?? 'mixed';
const only = args[3] ? args[3].split(',') : null;
const t0 = Date.now();
const pct = (n: number, d: number): string => `${Math.round((100 * n) / Math.max(1, d))}%`.padStart(4);
const pct1 = (n: number, d: number): string => `${((100 * n) / Math.max(1, d)).toFixed(1)}%`.padStart(6);
const avg = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const mean = (xs: number[]): string => (xs.length ? avg(xs).toFixed(1) : '-').padStart(6);

interface Tally { played: number; done: number; bonus: number; deaths: number; seconds: number[]; downs: number }
const tallies = (): Record<ObjectiveKind, Tally> => {
  const out = {} as Record<ObjectiveKind, Tally>;
  for (const k of OBJECTIVE_KINDS) out[k] = { played: 0, done: 0, bonus: 0, deaths: 0, seconds: [], downs: 0 };
  return out;
};
const total = tallies();

interface Played extends RunResult { shardsPerHero: number; cursedChambers: number; heroes: number }

function row(label: string, results: Played[]): void {
  const wins = results.filter((r) => r.cleared > 0);
  const deaths: Record<string, number> = {};
  for (const r of results) if (r.phase === 'defeat') deaths[`${r.chamber}`] = (deaths[`${r.chamber}`] ?? 0) + 1;
  const ults = avg(results.map((r) => r.ultimates / r.heroes));
  const perMinute = results.reduce((n, r) => n + r.ultimates / r.heroes, 0) / Math.max(1e-9, results.reduce((n, r) => n + r.minutes, 0));
  console.info(`${label.padEnd(34)} win ${pct(wins.length, results.length)} (${String(wins.length).padStart(2)}/${results.length})  min ${mean(wins.map((r) => r.minutesAtFirstClear))}  boss ${mean(wins.map((r) => r.bossSeconds))}s  maxChamber ${Math.max(0, ...results.flatMap((r) => r.chamberSeconds)).toFixed(0)}s  ults/hero ${ults.toFixed(1)} (${perMinute.toFixed(2)}/min)  shards/hero ${avg(results.map((r) => r.shardsPerHero)).toFixed(2)} (wins ${avg(wins.map((r) => r.shardsPerHero)).toFixed(2)})  cursed ${avg(results.map((r) => r.cursedChambers)).toFixed(1)}  defeats ${JSON.stringify(deaths)}`);
}

function play(classes: ClassId[], seed: number, boss: (typeof BOSS_KINDS)[number], max: boolean, into: Record<ObjectiveKind, Tally>[]): Played {
  let kind: ObjectiveKind | null = null;
  let key = '';
  let started = 0;
  let downs = 0;
  let shards = 0;
  let cursed = 0;
  let cursedKey = '';
  const result = runBots({
    classes, seed, overrides: { finalBoss: boss, objective: doors === 'classic' ? 'slay' : undefined }, preferObjectives: doors === 'prefer',
    preferCursed: doors === 'cursed',
    loadouts: max ? classes.map((cls) => maxBuild(cls, maxMetaLevels())) : undefined,
    onTick: (w, events) => {
      const o = w.run.objective;
      const now = `${w.run.depth}.${w.run.chamber}`;
      if (w.run.entered === 'cursed' && now !== cursedKey) { cursedKey = now; cursed++; }
      if (w.run.phase === 'victory' || w.run.phase === 'defeat') shards = w.run.rewards.reduce((n, r) => n + r.relics.length, 0);
      if (o && now !== key && w.run.chamberKind === 'combat') {
        key = now;
        kind = o.kind;
        started = w.run.elapsed;
        downs = 0;
        for (const t of into) t[kind].played++;
      }
      if (!kind) return;
      for (const ev of events) {
        if (ev.e === 'down') downs++;
        if (ev.e === 'objective' && ev.what === 'done' && w.run.chamberKind === 'combat') {
          for (const t of into) {
            t[kind].done++;
            if (ev.bonus) t[kind].bonus++;
            t[kind].seconds.push(w.run.elapsed - started);
            t[kind].downs += downs;
          }
          kind = null;
        }
      }
      if (kind && w.run.phase === 'defeat') {
        for (const t of into) { t[kind].deaths++; t[kind].downs += downs; }
        kind = null;
      }
    },
  });
  return { ...result, shardsPerHero: shards / classes.length, cursedChambers: cursed, heroes: classes.length };
}

function table(label: string, t: Record<ObjectiveKind, Tally>): void {
  console.info(`\n${label}: objective  played  done  bonus%  defeats  ended%  mean s   max s  downs/chamber`);
  for (const k of OBJECTIVE_KINDS) {
    const x = t[k];
    console.info(`  ${k.padEnd(9)} ${String(x.played).padStart(6)} ${String(x.done).padStart(5)} ${pct(x.bonus, x.done).padStart(7)} ${String(x.deaths).padStart(8)} ${pct1(x.deaths, x.played)} ${mean(x.seconds)} ${Math.max(0, ...x.seconds).toFixed(0).padStart(7)} ${(x.downs / Math.max(1, x.played)).toFixed(2).padStart(8)}`);
  }
}

function sweep(label: string, parties: ClassId[][], max: boolean): void {
  const all: Played[] = [];
  for (const classes of parties) {
    const own: Played[] = [];
    const mine = tallies();
    for (const boss of BOSS_KINDS) {
      for (let i = 0; i < seeds; i++) own.push(play(classes, (i + 1) * 7919 + BOSS_KINDS.indexOf(boss) * 104729 + classes.length, boss, max, [mine, total]));
    }
    row(`${label} ${classes.join('+')}`, own);
    if (parties.length > 1 && classes.length === 1) {
      const cell = (k: ObjectiveKind): string => `${k} ${pct(mine[k].bonus, mine[k].done).trim()}/${mine[k].played}`;
      console.info(`    bonus%/played: ${(['survive', 'defend', 'hunt', 'ritual'] as const).map(cell).join('  ')}`);
    }
    all.push(...own);
  }
  row(`${label} ALL`, all);
  table(`${label} (${doors} doors)`, total);
}

const solo = CLASS_IDS.filter((c) => !only || only.includes(c)).map((c) => [c]);
const parties: ClassId[][] = [
  ['knight', 'barbarian', 'mage', 'rogue'], ['mage', 'rogue', 'rogue', 'mage'], ['knight', 'barbarian', 'knight', 'barbarian'],
  ['templar', 'spellblade', 'shade', 'mage'], ['templar', 'shade', 'spellblade', 'knight'],
];
if (mode === 'solo') sweep('fresh solo', solo, false);
else if (mode === 'party') sweep('fresh 4-bot', parties, false);
else if (mode === 'max') sweep('max solo', solo, true);
else if (mode === 'maxparty') sweep('max 4-bot', parties, true);
console.info(`soak took ${((Date.now() - t0) / 1000).toFixed(1)} s`);
