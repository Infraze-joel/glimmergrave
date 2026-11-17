/**
 * Balance soak: `npx tsx --tsconfig server/tsconfig.json shared/test/tools/soak.ts [seeds] [oath]`.
 * Prints win rates per final boss, for heroes without permanent upgrades and with all of them.
 */
import { maxMetaLevels } from '@shared/sim/index.ts';
import { BOSS_KINDS, type ClassId } from '@shared/types.ts';
import { formatTable, runBots, summarize, type BalanceRow, type RunResult } from '../harness.ts';

const seeds = Number(process.argv[2] ?? 6);
const oath = Number(process.argv[3] ?? 0);
const solo: ClassId[][] = [['knight'], ['barbarian'], ['mage'], ['rogue']];
const parties: ClassId[][] = [['knight', 'barbarian', 'mage', 'rogue'], ['mage', 'rogue', 'rogue', 'mage'], ['knight', 'barbarian', 'knight', 'barbarian']];
const rows: BalanceRow[] = [];
const t0 = Date.now();
for (const [metaLabel, meta] of [['meta 0', undefined], ['meta max', maxMetaLevels()]] as const) {
  for (const [label, sets] of [['solo', solo], ['4-bot', parties]] as const) {
    const all: RunResult[] = [];
    for (const boss of BOSS_KINDS) {
      const results: RunResult[] = [];
      for (const classes of sets) {
        const own: RunResult[] = [];
        for (let i = 0; i < seeds; i++) own.push(runBots({ classes, seed: (i + 1) * 7919 + classes.length, oath, meta: meta ? [...meta] : undefined, overrides: { finalBoss: boss } }));
        results.push(...own);
        const bad = own.filter((r) => r.nan || (r.phase !== 'victory' && r.phase !== 'defeat'));
        if (bad.length) console.info('!! non-terminating or NaN runs:', classes.join('+'), boss, bad.length);
        const deaths: Record<number, number> = {};
        for (const r of own) if (r.phase === 'defeat') deaths[r.chamber] = (deaths[r.chamber] ?? 0) + 1;
        const wins = own.filter((r) => r.phase === 'victory').length;
        console.info(`${metaLabel} ${boss} ${classes.join('+')}: ${wins}/${own.length} wins, defeats by chamber ${JSON.stringify(deaths)}`);
      }
      rows.push(summarize(`${metaLabel} ${label} ${boss}`, results));
      all.push(...results);
    }
    rows.push(summarize(`${metaLabel} ${label} ALL`, all));
  }
}
console.info(formatTable(rows));
console.info(`soak took ${((Date.now() - t0) / 1000).toFixed(1)} s`);
