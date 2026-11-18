/**
 * Update 4 balance soak: `npx tsx --tsconfig server/tsconfig.json shared/test/tools/soak4.ts [seeds] [mode] [doors] [classes]`.
 * mode: solo (default) | party | max | maxparty        doors: mixed (default; the usual bot door choice) | prefer
 * (special objectives preferred) | classic (slay only)  classes: comma separated filter for solo modes.
 * Prints win rates per party and, per objective, how often it was played, its bonus rate, the time it took and
 * how many runs ended in it.
 */
import { ENEMIES } from '@shared/data/enemies.ts';
import { maxBuild, maxMetaLevels } from '@shared/sim/index.ts';
import { BOSS_KINDS, CLASS_IDS, OBJECTIVE_KINDS, type ClassId, type ObjectiveKind } from '@shared/types.ts';
import { runBots, type RunResult } from '../harness.ts';

// Experiments: OFF=shaman,bomber removes kinds from the waves.
for (const k of (process.env.OFF ?? '').split(',').filter(Boolean)) (ENEMIES as Record<string, { cost: number }>)[k]!.cost = 0;
const seeds = Number(process.argv[2] ?? 6);
const mode = process.argv[3] ?? 'solo';
const doors = process.argv[4] ?? 'mixed';
const only = process.argv[5] ? process.argv[5].split(',') : null;
const t0 = Date.now();
const pct = (n: number, d: number): string => `${Math.round((100 * n) / Math.max(1, d))}%`.padStart(4);
const mean = (xs: number[]): string => (xs.length ? (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1) : '-').padStart(6);

interface Tally { played: number; done: number; bonus: number; deaths: number; seconds: number[]; downs: number }
const tallies = (): Record<ObjectiveKind, Tally> => {
  const out = {} as Record<ObjectiveKind, Tally>;
  for (const k of OBJECTIVE_KINDS) out[k] = { played: 0, done: 0, bonus: 0, deaths: 0, seconds: [], downs: 0 };
  return out;
};
const total = tallies();

function row(label: string, results: RunResult[]): void {
  const wins = results.filter((r) => r.cleared > 0);
  const deaths: Record<string, number> = {};
  for (const r of results) if (r.phase === 'defeat') deaths[`${r.chamber}`] = (deaths[`${r.chamber}`] ?? 0) + 1;
  console.info(`${label.padEnd(34)} win ${pct(wins.length, results.length)} (${String(wins.length).padStart(2)}/${results.length})  min ${mean(wins.map((r) => r.minutesAtFirstClear))}  boss ${mean(wins.map((r) => r.bossSeconds))}s  maxChamber ${Math.max(0, ...results.flatMap((r) => r.chamberSeconds)).toFixed(0)}s  defeats ${JSON.stringify(deaths)}`);
}

function play(classes: ClassId[], seed: number, boss: (typeof BOSS_KINDS)[number], max: boolean, into: Record<ObjectiveKind, Tally>[]): RunResult {
  let kind: ObjectiveKind | null = null;
  let key = '';
  let started = 0;
  let downs = 0;
  return runBots({
    classes, seed, overrides: { finalBoss: boss, objective: doors === 'classic' ? 'slay' : undefined }, preferObjectives: doors === 'prefer',
    loadouts: max ? classes.map((cls) => maxBuild(cls, maxMetaLevels())) : undefined,
    onTick: (w, events) => {
      const o = w.run.objective;
      const now = `${w.run.depth}.${w.run.chamber}`;
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
}

function table(label: string, t: Record<ObjectiveKind, Tally>): void {
  console.info(`\n${label}: objective  played  done  bonus%  defeats  mean s   max s  downs/chamber`);
  for (const k of OBJECTIVE_KINDS) {
    const x = t[k];
    console.info(`  ${k.padEnd(9)} ${String(x.played).padStart(6)} ${String(x.done).padStart(5)} ${pct(x.bonus, x.done).padStart(7)} ${String(x.deaths).padStart(8)} ${mean(x.seconds)} ${Math.max(0, ...x.seconds).toFixed(0).padStart(7)} ${(x.downs / Math.max(1, x.played)).toFixed(2).padStart(8)}`);
  }
}

function sweep(label: string, parties: ClassId[][], max: boolean): void {
  const all: RunResult[] = [];
  for (const classes of parties) {
    const own: RunResult[] = [];
    const mine = tallies();
    for (const boss of BOSS_KINDS) {
      for (let i = 0; i < seeds; i++) own.push(play(classes, (i + 1) * 7919 + BOSS_KINDS.indexOf(boss) * 104729 + classes.length, boss, max, [mine, total]));
    }
    row(`${label} ${classes.join('+')}`, own);
    if (parties.length > 1 && process.argv.includes('--per-class')) table(classes.join('+'), mine);
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
