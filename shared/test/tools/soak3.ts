/**
 * Update 3 balance soak: `npx tsx --tsconfig server/tsconfig.json shared/test/tools/soak3.ts [seeds] [mode]`.
 * mode: solo (default) | party | max | depth
 */
import { maxBuild, maxMetaLevels } from '@shared/sim/index.ts';
import { BOSS_KINDS, CLASS_IDS, type ClassId } from '@shared/types.ts';
import { runBots, type RunResult } from '../harness.ts';

const seeds = Number(process.argv[2] ?? 6);
const mode = process.argv[3] ?? 'solo';
const t0 = Date.now();
const pct = (n: number, d: number): string => `${Math.round((100 * n) / Math.max(1, d))}%`.padStart(4);
const mean = (xs: number[]): string => (xs.length ? (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1) : '-').padStart(6);

function row(label: string, results: RunResult[]): void {
  const wins = results.filter((r) => r.cleared > 0);
  const deaths: Record<string, number> = {};
  for (const r of results) if (r.phase === 'defeat') deaths[`${r.depth}.${r.chamber}`] = (deaths[`${r.depth}.${r.chamber}`] ?? 0) + 1;
  console.info(`${label.padEnd(34)} win ${pct(wins.length, results.length)} (${String(wins.length).padStart(2)}/${results.length})  min ${mean(wins.map((r) => r.minutesAtFirstClear))}  boss ${mean(wins.map((r) => r.bossSeconds))}s  depth ${mean(results.map((r) => r.cleared))}  ults ${mean(results.map((r) => r.ultimates))}  defeats ${JSON.stringify(deaths)}`);
}

function sweep(label: string, parties: ClassId[][], opts: { max?: boolean; descendTo?: number; oath?: number }): void {
  const all: RunResult[] = [];
  for (const classes of parties) {
    const own: RunResult[] = [];
    for (const boss of BOSS_KINDS) {
      for (let i = 0; i < seeds; i++) {
        own.push(runBots({
          classes, seed: (i + 1) * 7919 + BOSS_KINDS.indexOf(boss) * 104729 + classes.length, oath: opts.oath ?? 0, overrides: { finalBoss: boss },
          loadouts: opts.max ? classes.map((cls) => maxBuild(cls, maxMetaLevels())) : undefined, descendTo: opts.descendTo,
        }));
      }
    }
    row(`${label} ${classes.join('+')}`, own);
    all.push(...own);
  }
  row(`${label} ALL`, all);
}

const solo = CLASS_IDS.map((c) => [c]);
const parties: ClassId[][] = [
  ['knight', 'barbarian', 'mage', 'rogue'], ['mage', 'rogue', 'rogue', 'mage'], ['knight', 'barbarian', 'knight', 'barbarian'],
  ['templar', 'spellblade', 'shade', 'mage'], ['templar', 'shade', 'spellblade', 'knight'],
];
if (mode === 'solo') sweep('fresh solo', solo, {});
else if (mode === 'party') sweep('fresh 4-bot', parties, {});
else if (mode === 'max') { sweep('max solo', solo, { max: true }); }
else if (mode === 'maxparty') { sweep('max 4-bot', parties, { max: true }); }
else if (mode === 'depth') {
  sweep('fresh solo d1', solo, { descendTo: 1 });
  sweep('max solo d1', solo, { max: true, descendTo: 1 });
  sweep('fresh 4-bot d1', parties.slice(0, 2), { descendTo: 1 });
  sweep('max 4-bot d1', parties.slice(0, 2), { max: true, descendTo: 1 });
}
console.info(`soak took ${((Date.now() - t0) / 1000).toFixed(1)} s`);
