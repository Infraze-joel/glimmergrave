/** Balance soak: `npx tsx --tsconfig server/tsconfig.json shared/test/tools/soak.ts [seeds] [oath]`. */
import type { ClassId } from '@shared/types.ts';
import { formatTable, runBots, summarize, type BalanceRow, type RunResult } from '../harness.ts';

const seeds = Number(process.argv[2] ?? 6);
const oath = Number(process.argv[3] ?? 0);
const solo: ClassId[][] = [['knight'], ['barbarian'], ['mage'], ['rogue']];
const parties: ClassId[][] = [['knight', 'barbarian', 'mage', 'rogue'], ['knight', 'mage'], ['mage', 'rogue', 'rogue', 'mage'], ['knight', 'barbarian', 'knight', 'barbarian']];
const rows: BalanceRow[] = [];
const all = (label: string, sets: ClassId[][]): void => {
  const total: RunResult[] = [];
  for (const classes of sets) {
    const results: RunResult[] = [];
    for (let seed = 1; seed <= seeds; seed++) results.push(runBots({ classes, seed: seed * 7919 + classes.length, oath }));
    rows.push(summarize(classes.join('+'), results));
    total.push(...results);
    const bad = results.filter((r) => r.nan || (r.phase !== 'victory' && r.phase !== 'defeat'));
    if (bad.length) console.info('!! non-terminating or NaN runs:', classes.join('+'), bad.length);
    const deaths: Record<number, number> = {};
    for (const r of results) if (r.phase === 'defeat') deaths[r.chamber] = (deaths[r.chamber] ?? 0) + 1;
    console.info(classes.join('+'), 'defeats by chamber', JSON.stringify(deaths), 'chamberSeconds(sample)', results[0]?.chamberSeconds.map((s) => s.toFixed(0)).join(','));
  }
  rows.push(summarize(label, total));
};
const t0 = Date.now();
all('ALL SOLO', solo);
all('ALL PARTY', parties);
console.info(formatTable(rows));
console.info(`soak took ${((Date.now() - t0) / 1000).toFixed(1)} s`);
