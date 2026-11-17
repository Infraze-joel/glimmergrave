import { describe, expect, it } from 'vitest';
import { RUN, WORLD } from '@shared/constants.ts';
import type { ClassId } from '@shared/types.ts';
import { formatTable, runBots, summarize, type BalanceRow, type RunResult } from './harness.ts';

const SOLO: ClassId[][] = [['knight'], ['barbarian'], ['mage'], ['rogue']];
const PARTIES: ClassId[][] = [
  ['knight', 'barbarian', 'mage', 'rogue'], ['mage', 'rogue', 'rogue', 'mage'], ['knight', 'barbarian', 'knight', 'barbarian'],
];
const SOLO_SEEDS = 10;
const PARTY_SEEDS = 8;
/** 25 game minutes: far beyond any legitimate run. */
const TICK_BUDGET = 30 * 60 * 25;
const seedFor = (i: number, n: number): number => (i + 1) * 7919 + n;

const report = (text: string): void => { process.stdout.write(`${text}\n`); };

function sanity(results: RunResult[], label: string): void {
  for (const r of results) {
    expect(['victory', 'defeat'], `${label}: run did not terminate within the tick budget`).toContain(r.phase);
    expect(r.ticks).toBeLessThan(TICK_BUDGET);
    expect(r.nan, `${label}: NaN in the world`).toBe(false);
    expect(r.maxEnemies).toBeLessThanOrEqual(WORLD.MAX_ENEMIES);
    expect(r.maxProjectiles).toBeLessThanOrEqual(WORLD.MAX_PROJECTILES);
    expect(r.damageDealt).toBeGreaterThan(0);
  }
}

describe('full bot runs in the pure simulation (oath 0)', () => {
  const rows: BalanceRow[] = [];
  const solo: RunResult[] = [];
  const party: RunResult[] = [];

  for (const classes of SOLO) {
    it(`solo ${classes[0]}: ${SOLO_SEEDS} runs terminate cleanly`, () => {
      const results: RunResult[] = [];
      for (let i = 0; i < SOLO_SEEDS; i++) results.push(runBots({ classes, seed: seedFor(i, 1), maxTicks: TICK_BUDGET }));
      sanity(results, classes.join('+'));
      rows.push(summarize(`solo ${classes[0]}`, results));
      solo.push(...results);
    }, 120000);
  }

  for (const classes of PARTIES) {
    it(`party ${classes.join('+')}: ${PARTY_SEEDS} runs terminate cleanly`, () => {
      const results: RunResult[] = [];
      for (let i = 0; i < PARTY_SEEDS; i++) results.push(runBots({ classes, seed: seedFor(i, 4), maxTicks: TICK_BUDGET }));
      sanity(results, classes.join('+'));
      rows.push(summarize(classes.map((c) => c.slice(0, 3)).join('+'), results));
      party.push(...results);
    }, 240000);
  }

  it('balance targets hold (table below)', () => {
    const allSolo = summarize('ALL SOLO', solo);
    const allParty = summarize('ALL 4-BOT', party);
    report(`\nBalance at oath 0 (${SOLO_SEEDS} seeds per solo class, ${PARTY_SEEDS} per party)\n${formatTable([...rows, allSolo, allParty])}\n`);
    expect(solo).toHaveLength(SOLO.length * SOLO_SEEDS);
    expect(party).toHaveLength(PARTIES.length * PARTY_SEEDS);
    // A competent solo bot wins roughly 30-70 %, a 4-bot party roughly 50-85 %.
    expect(allSolo.winRate).toBeGreaterThanOrEqual(0.3);
    expect(allSolo.winRate).toBeLessThanOrEqual(0.7);
    expect(allParty.winRate).toBeGreaterThanOrEqual(0.5);
    expect(allParty.winRate).toBeLessThanOrEqual(0.85);
    // Winning runs last 9-15 game minutes, no chamber drags on, the boss fight is 60-150 s.
    for (const row of [allSolo, allParty]) {
      expect(row.meanWinMinutes).toBeGreaterThanOrEqual(9);
      expect(row.meanWinMinutes).toBeLessThanOrEqual(15);
      expect(row.maxChamberSeconds).toBeLessThanOrEqual(200);
      expect(row.meanBossSeconds).toBeGreaterThanOrEqual(60);
      expect(row.meanBossSeconds).toBeLessThanOrEqual(150);
    }
  });
});

describe('higher oaths and odd party sizes', () => {
  it('oath 1-3 runs and 2-3 hero parties terminate cleanly', () => {
    const results: RunResult[] = [];
    for (let oath = 1; oath < RUN.OATH.length; oath++) results.push(runBots({ classes: ['knight'], seed: 100 + oath, oath, maxTicks: TICK_BUDGET }));
    results.push(runBots({ classes: ['mage', 'knight'], seed: 55, maxTicks: TICK_BUDGET }));
    results.push(runBots({ classes: ['rogue', 'barbarian', 'mage'], seed: 56, oath: 2, maxTicks: TICK_BUDGET }));
    sanity(results, 'misc');
    report(formatTable([summarize('oath 1-3 / 2-3 heroes', results)]));
  }, 120000);
});
