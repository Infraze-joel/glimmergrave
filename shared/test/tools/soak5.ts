/**
 * Update 5 balance soak: `npx tsx --tsconfig server/tsconfig.json shared/test/tools/soak5.ts [seeds] [what] [classSeeds]`.
 * Fresh solo heroes, oath 0, the seeds of botruns.test.ts first. `what`: all (default) | base | generic | class | a
 * comma separated list of keystone ids.
 * Rows: `none` (bots take the consolation in every keystone draft), `free` (bots choose as they like), then one
 * row per keystone: the bot takes exactly that keystone in its first keystone draft and the consolation in the
 * second. Generic keystones are played by all seven classes, a class keystone by its class (against that class's
 * own `none` row, with `classSeeds` seeds).
 * Columns: win rate and its difference to `none`; seconds for chambers 5-8 in runs that won (and the difference);
 * the keystone's own share of the damage dealt after it was taken; downs per run; keystone events and ultimates per run.
 * `--by-class`: also the win rate of every class in the row. `--blind`: the bots are not told which keystones they
 * hold (with a keystone that needs the bot to use it, this measures what the pick costs: the consolation boon).
 * `--from=N`: start at seed index N (a fresh, independent sample: `soak5.ts 10 x --from=10` plays seeds 10..19).
 * `--set=id.key=value,...`: try other `params` without editing the data table (applied before the simulation loads,
 * which copies params at import).
 */
import { KEYSTONE_BY_ID, KEYSTONES } from '@shared/data/keystones.ts';
import { BOSS_KINDS, CLASS_IDS, type BossKind, type ClassId } from '@shared/types.ts';
import type { RunResult } from '../harness.ts';

const flag = (name: string): string | undefined => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
for (const set of (flag('set') ?? '').split(',').filter(Boolean)) {
  const [path, value] = set.split('=');
  const [id, key] = (path ?? '').split('.');
  const params = KEYSTONE_BY_ID.get(id ?? '')?.params;
  if (!params || key === undefined || !(key in params) || !Number.isFinite(Number(value))) throw new Error(`--set: bad ${set}`);
  params[key] = Number(value);
  console.info(`set ${id}.${key} = ${value}`);
}
const { runBots } = await import('../harness.ts');

const by = process.argv.includes('--by-class');
const blind = process.argv.includes('--blind');
const from = Number(flag('from') ?? 0);
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const seeds = Number(args[0] ?? 6);
const what = args[1] ?? 'all';
const classSeeds = Number(args[2] ?? seeds * 3);
const seedFor = (i: number, boss: BossKind, n: number): number => (from + i + 1) * 7919 + BOSS_KINDS.indexOf(boss) * 104729 + n;
const avg = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const LATE_FROM = 4;

interface Row { label: string; runs: number; win: number; late: number; share: number; downs: number; took: number; procs: number; ults: number; died: Record<string, number>; perClass: Record<string, number> }

function play(classes: readonly ClassId[], n: number, id: string | null, mode: 'none' | 'free' | 'only'): Row {
  const results: RunResult[] = [];
  const perClass: Record<string, number> = {};
  for (const cls of classes) for (const boss of BOSS_KINDS) for (let i = 0; i < n; i++) {
    const r = runBots({ classes: [cls], seed: seedFor(i, boss, 1), overrides: { finalBoss: boss }, keystones: id ? [id] : undefined, keystoneMode: mode, blind });
    results.push(r);
    perClass[cls] = (perClass[cls] ?? 0) + (r.cleared > 0 ? 1 / (BOSS_KINDS.length * n) : 0);
  }
  const wins = results.filter((r) => r.cleared > 0);
  const dealt = results.reduce((a, r) => a + r.damageWithKeystone, 0);
  const own = id ? results.reduce((a, r) => a + (r.keystoneDamage[id] ?? 0), 0) : 0;
  const died: Record<string, number> = {};
  for (const r of results) if (r.cleared === 0) died[r.chamber + 1] = (died[r.chamber + 1] ?? 0) + 1;
  return {
    label: id ?? mode, runs: results.length, win: wins.length / results.length,
    late: avg(wins.map((r) => r.chamberSeconds.slice(LATE_FROM, LATE_FROM + 4).reduce((a, b) => a + b, 0))),
    share: dealt > 0 ? own / dealt : 0, downs: avg(results.map((r) => r.downs)),
    took: id ? results.filter((r) => r.keystones[0]!.includes(id)).length / results.length : 0, died,
    procs: avg(results.map((r) => r.procs)), ults: avg(results.map((r) => r.ultimates)), perClass,
  };
}

const pct = (v: number): string => `${(v * 100).toFixed(0)}%`.padStart(5);
const signed = (v: number, digits = 0): string => `${v >= 0 ? '+' : ''}${v.toFixed(digits)}`.padStart(6);
function print(row: Row, base: Row | null): void {
  const delta = base ? `${signed((row.win - base.win) * 100)} pts` : '          ';
  const late = base ? `${signed(row.late - base.late)} s (${signed(base.late > 0 ? ((row.late - base.late) / base.late) * 100 : 0)}%)` : '';
  console.info(`${row.label.padEnd(18)} runs ${String(row.runs).padStart(4)}  win ${pct(row.win)} ${delta}  ch5-8 ${row.late.toFixed(0).padStart(4)} s ${late.padEnd(18)}  own dmg ${pct(row.share)}  downs ${row.downs.toFixed(2)}  taken ${pct(row.took)}  procs ${row.procs.toFixed(0).padStart(4)}  ults ${row.ults.toFixed(1).padStart(4)}  died in ${JSON.stringify(row.died)}`);
  if (by) console.info(`    by class: ${Object.entries(row.perClass).map(([c, v]) => `${c} ${pct(v).trim()}`).join('  ')}`);
}

const t0 = Date.now();
const generic = KEYSTONES.filter((k) => k.cls === undefined);
const cls = KEYSTONES.filter((k) => k.cls !== undefined);
const listed = what.includes('_') || KEYSTONES.some((k) => k.id === what) ? what.split(',') : null;
const none = play(CLASS_IDS, seeds, null, 'none');
print(none, null);
if (what === 'all' || what === 'base') print(play(CLASS_IDS, seeds, null, 'free'), none);
for (const k of generic) {
  if (!(what === 'all' || what === 'generic' || listed?.includes(k.id))) continue;
  print(play(CLASS_IDS, seeds, k.id, 'only'), none);
}
for (const k of cls) {
  if (!(what === 'all' || what === 'class' || listed?.includes(k.id))) continue;
  const own = [k.cls as ClassId];
  const base = play(own, classSeeds, null, 'none');
  print({ ...base, label: `none (${k.cls})` }, null);
  print(play(own, classSeeds, k.id, 'only'), base);
}
console.info(`(${((Date.now() - t0) / 1000).toFixed(0)} s)`);
