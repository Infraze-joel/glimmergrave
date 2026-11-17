import { describe, expect, it } from 'vitest';
import { RUN, WORLD } from '@shared/constants.ts';
import { REWARDS } from '@shared/data/meta.ts';
import { maxMetaLevels } from '@shared/sim/index.ts';
import { BOSS_KINDS, type ClassId } from '@shared/types.ts';
import { formatTable, runBots, summarize, type BalanceRow, type RunResult } from './harness.ts';

const SOLO: ClassId[][] = [['knight'], ['barbarian'], ['mage'], ['rogue']];
const PARTIES: ClassId[][] = [
  ['knight', 'barbarian', 'mage', 'rogue'], ['mage', 'rogue', 'rogue', 'mage'], ['knight', 'barbarian', 'knight', 'barbarian'],
];
const SOLO_SEEDS = 8;
const PARTY_SEEDS = 5;
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
    // Every finished run pays at least the minimum; a victory pays the full tally.
    expect(r.glimmer).toBeGreaterThanOrEqual(REWARDS.MINIMUM);
    if (r.phase === 'victory') expect(r.glimmer).toBeGreaterThanOrEqual(8 * REWARDS.PER_CHAMBER_CLEARED + 2 * REWARDS.PER_ELITE_SLAIN + REWARDS.BOSS_SLAIN);
    expect(r.herald).not.toBe(r.finalBoss);
  }
}

describe('full bot runs in the pure simulation (oath 0), per final boss, without and with permanent upgrades', () => {
  const rows: BalanceRow[] = [];
  const pools: Record<string, RunResult[]> = {};
  const METAS = [['meta 0', undefined], ['meta max', maxMetaLevels()]] as const;

  for (const [metaLabel, meta] of METAS) {
    for (const [label, sets, seeds] of [['solo', SOLO, SOLO_SEEDS], ['4-bot', PARTIES, PARTY_SEEDS]] as const) {
      for (const boss of BOSS_KINDS) {
        it(`${metaLabel}, ${label} vs ${boss}: ${sets.length * seeds} runs terminate cleanly`, () => {
          const results: RunResult[] = [];
          for (const classes of sets) {
            for (let i = 0; i < seeds; i++) {
              results.push(runBots({ classes, seed: seedFor(i, classes.length), maxTicks: TICK_BUDGET, meta: meta ? [...meta] : undefined, overrides: { finalBoss: boss } }));
            }
          }
          sanity(results, `${metaLabel} ${label} ${boss}`);
          for (const r of results) expect(r.finalBoss).toBe(boss);
          rows.push(summarize(`${metaLabel} ${label} ${boss}`, results));
          (pools[`${metaLabel} ${label}`] ??= []).push(...results);
        }, 300000);
      }
    }
  }

  it('balance targets hold (table below)', () => {
    const all = (key: string): BalanceRow => summarize(`${key} ALL`, pools[key] ?? []);
    const solo0 = all('meta 0 solo');
    const party0 = all('meta 0 4-bot');
    const soloMax = all('meta max solo');
    const partyMax = all('meta max 4-bot');
    const ordered: BalanceRow[] = [];
    for (const key of ['meta 0 solo', 'meta 0 4-bot', 'meta max solo', 'meta max 4-bot']) {
      ordered.push(...rows.filter((r) => r.label.startsWith(`${key} `)), all(key));
    }
    report(`\nBalance at oath 0 (${SOLO_SEEDS} seeds per solo class, ${PARTY_SEEDS} per party, per final boss)\n${formatTable(ordered)}\n`);
    expect(solo0.runs).toBe(SOLO.length * SOLO_SEEDS * BOSS_KINDS.length);
    expect(party0.runs).toBe(PARTIES.length * PARTY_SEEDS * BOSS_KINDS.length);
    // Without permanent upgrades a competent solo bot wins roughly 20-45 %, a 4-bot party roughly 40-70 %.
    expect(solo0.winRate).toBeGreaterThanOrEqual(0.2);
    expect(solo0.winRate).toBeLessThanOrEqual(0.45);
    expect(party0.winRate).toBeGreaterThanOrEqual(0.4);
    expect(party0.winRate).toBeLessThanOrEqual(0.7);
    // Permanent upgrades matter: fully upgraded, the same solo bot wins roughly 60-85 %.
    expect(soloMax.winRate).toBeGreaterThanOrEqual(0.6);
    expect(soloMax.winRate).toBeLessThanOrEqual(0.85);
    expect(soloMax.winRate).toBeGreaterThan(solo0.winRate + 0.25);
    expect(partyMax.winRate).toBeGreaterThan(party0.winRate);
    // Winning runs last 9-15 game minutes, no chamber drags on, every boss fight averages 60-150 s.
    for (const row of [solo0, party0, soloMax, partyMax]) {
      expect(row.meanWinMinutes, row.label).toBeGreaterThanOrEqual(9);
      expect(row.meanWinMinutes, row.label).toBeLessThanOrEqual(15);
      expect(row.maxChamberSeconds, row.label).toBeLessThanOrEqual(200);
    }
    for (const row of rows) {
      if (row.winRate === 0) continue;
      expect(row.meanBossSeconds, row.label).toBeGreaterThanOrEqual(60);
      expect(row.meanBossSeconds, row.label).toBeLessThanOrEqual(150);
    }
    // No final boss is a wall or a pushover for the un-upgraded hero.
    for (const row of rows.filter((r) => r.label.startsWith('meta 0 '))) {
      expect(row.winRate, row.label).toBeGreaterThanOrEqual(0.12);
      expect(row.winRate, row.label).toBeLessThanOrEqual(0.75);
    }
  });
});

describe('higher oaths and odd party sizes', () => {
  it('oath 1-3 runs and 2-3 hero parties terminate cleanly', () => {
    const results: RunResult[] = [];
    for (let oath = 1; oath < RUN.OATH.length; oath++) results.push(runBots({ classes: ['knight'], seed: 100 + oath, oath, maxTicks: TICK_BUDGET }));
    results.push(runBots({ classes: ['mage', 'knight'], seed: 55, maxTicks: TICK_BUDGET }));
    results.push(runBots({ classes: ['rogue', 'barbarian', 'mage'], seed: 56, oath: 2, maxTicks: TICK_BUDGET, meta: maxMetaLevels() }));
    sanity(results, 'misc');
    report(formatTable([summarize('oath 1-3 / 2-3 heroes', results)]));
  }, 120000);
});
