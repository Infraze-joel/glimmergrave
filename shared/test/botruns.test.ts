import { describe, expect, it } from 'vitest';
import { RUN, WORLD } from '@shared/constants.ts';
import { XP_REWARDS } from '@shared/data/mastery.ts';
import { REWARDS } from '@shared/data/meta.ts';
import { maxBuild, maxMetaLevels } from '@shared/sim/index.ts';
import { BOSS_KINDS, CLASS_IDS, type BossKind, type ClassId } from '@shared/types.ts';
import { formatTable, runBots, summarize, type BalanceRow, type RunResult } from './harness.ts';

const OLD: ClassId[] = ['knight', 'barbarian', 'mage', 'rogue'];
const NEW: ClassId[] = ['templar', 'spellblade', 'shade'];
const SOLO: ClassId[][] = CLASS_IDS.map((cls) => [cls]);
const PARTIES: ClassId[][] = [
  ['knight', 'barbarian', 'mage', 'rogue'], ['mage', 'rogue', 'rogue', 'mage'], ['knight', 'barbarian', 'knight', 'barbarian'],
  ['templar', 'spellblade', 'shade', 'mage'], ['templar', 'shade', 'spellblade', 'knight'],
];
const SOLO_SEEDS = 6;
const PARTY_SEEDS = 3;
/** 25 game minutes per depth: far beyond any legitimate run. */
const TICK_BUDGET = 30 * 60 * 25;
/** Every (seed index, boss, party size) gets its own seed, so the three boss rows are independent samples. */
const seedFor = (i: number, boss: BossKind, n: number): number => (i + 1) * 7919 + BOSS_KINDS.indexOf(boss) * 104729 + n;
/** The fully upgraded hero of update 3: every Armory upgrade, mastery 10, the art, the first talent of each tier. */
const maxed = (classes: ClassId[]): unknown[] => classes.map((cls) => maxBuild(cls, maxMetaLevels()));

const report = (text: string): void => { process.stdout.write(`${text}\n`); };
const rate = (results: RunResult[], pred: (r: RunResult) => boolean): number => results.filter(pred).length / Math.max(1, results.length);

function sanity(results: RunResult[], label: string, budget = TICK_BUDGET): void {
  for (const r of results) {
    expect(['victory', 'defeat'], `${label}: run did not terminate within the tick budget`).toContain(r.phase);
    expect(r.ticks).toBeLessThan(budget);
    expect(r.nan, `${label}: NaN in the world`).toBe(false);
    expect(r.maxEnemies).toBeLessThanOrEqual(WORLD.MAX_ENEMIES);
    expect(r.maxProjectiles).toBeLessThanOrEqual(WORLD.MAX_PROJECTILES);
    expect(r.damageDealt).toBeGreaterThan(0);
    // Every finished run pays at least the minimum; a won one pays the full tally of its first depth.
    expect(r.glimmer).toBeGreaterThanOrEqual(REWARDS.MINIMUM);
    expect(r.xp).toBeGreaterThanOrEqual(XP_REWARDS.MINIMUM);
    if (r.cleared > 0) {
      expect(r.glimmer).toBeGreaterThanOrEqual(8 * REWARDS.PER_CHAMBER_CLEARED + 2 * REWARDS.PER_ELITE_SLAIN + REWARDS.BOSS_SLAIN);
      expect(r.xp).toBeGreaterThanOrEqual(8 * XP_REWARDS.PER_CHAMBER_CLEARED + 2 * XP_REWARDS.PER_ELITE_SLAIN + XP_REWARDS.BOSS_SLAIN);
      expect(r.relics.length).toBeGreaterThanOrEqual(1);
    }
    // Bots that ascend win exactly when a final boss fell.
    if (r.depth === 0) expect(r.phase === 'victory').toBe(r.cleared === 1);
    expect(r.herald).not.toBe(r.finalBoss);
  }
}

describe('full bot runs in the pure simulation (oath 0, depth 0), per final boss, fresh and fully upgraded heroes', () => {
  const rows: BalanceRow[] = [];
  const pools: Record<string, RunResult[]> = {};
  const byClass: Record<string, RunResult[]> = {};

  for (const metaLabel of ['fresh', 'maxed'] as const) {
    for (const [label, sets, seeds] of [['solo', SOLO, SOLO_SEEDS], ['4-bot', PARTIES, PARTY_SEEDS]] as const) {
      for (const boss of BOSS_KINDS) {
        it(`${metaLabel}, ${label} vs ${boss}: ${sets.length * seeds} runs terminate cleanly`, () => {
          const results: RunResult[] = [];
          for (const classes of sets) {
            for (let i = 0; i < seeds; i++) {
              const r = runBots({
                classes, seed: seedFor(i, boss, classes.length), maxTicks: TICK_BUDGET, overrides: { finalBoss: boss },
                loadouts: metaLabel === 'maxed' ? maxed(classes) : undefined,
              });
              results.push(r);
              if (label === 'solo') (byClass[`${metaLabel} ${classes[0]}`] ??= []).push(r);
            }
          }
          sanity(results, `${metaLabel} ${label} ${boss}`);
          for (const r of results) expect(r.finalBoss).toBe(boss);
          // Ultimates are part of every fight now.
          expect(results.reduce((n, r) => n + r.ultimates, 0)).toBeGreaterThan(results.length);
          rows.push(summarize(`${metaLabel} ${label} ${boss}`, results));
          (pools[`${metaLabel} ${label}`] ??= []).push(...results);
        }, 600000);
      }
    }
  }

  it('balance targets hold (tables below)', () => {
    const all = (key: string): BalanceRow => summarize(`${key} ALL`, pools[key] ?? []);
    const solo0 = all('fresh solo');
    const party0 = all('fresh 4-bot');
    const soloMax = all('maxed solo');
    const partyMax = all('maxed 4-bot');
    const ordered: BalanceRow[] = [];
    for (const key of ['fresh solo', 'fresh 4-bot', 'maxed solo', 'maxed 4-bot']) {
      ordered.push(...rows.filter((r) => r.label.startsWith(`${key} `)), all(key));
    }
    report(`\nBalance at oath 0, depth 0 (${SOLO_SEEDS} seeds per solo class, ${PARTY_SEEDS} per party, per final boss)\n${formatTable(ordered)}\n`);
    const classRows = CLASS_IDS.flatMap((cls) => ['fresh', 'maxed'].map((m) => summarize(`${m} solo ${cls}`, byClass[`${m} ${cls}`] ?? [])));
    report(`Per class (solo, all three bosses)\n${formatTable(classRows)}\n`);
    expect(solo0.runs).toBe(SOLO.length * SOLO_SEEDS * BOSS_KINDS.length);
    expect(party0.runs).toBe(PARTIES.length * PARTY_SEEDS * BOSS_KINDS.length);
    // A fresh hero (no upgrades, mastery 1) wins roughly as often as before update 3: solo 20-50 %, a party 40-80 %.
    expect(solo0.winRate).toBeGreaterThanOrEqual(0.2);
    expect(solo0.winRate).toBeLessThanOrEqual(0.5);
    expect(party0.winRate).toBeGreaterThanOrEqual(0.4);
    expect(party0.winRate).toBeLessThanOrEqual(0.8);
    // The four old classes and the three new ones sit in the same band; no class is hopeless or a free win.
    const group = (classes: ClassId[]): number => rate(classes.flatMap((cls) => byClass[`fresh ${cls}`] ?? []), (r) => r.cleared > 0);
    for (const classes of [OLD, NEW]) {
      expect(group(classes), classes.join('+')).toBeGreaterThanOrEqual(0.2);
      expect(group(classes), classes.join('+')).toBeLessThanOrEqual(0.55);
    }
    for (const cls of CLASS_IDS) {
      const r = rate(byClass[`fresh ${cls}`] ?? [], (x) => x.cleared > 0);
      expect(r, cls).toBeGreaterThanOrEqual(0.05);
      expect(r, cls).toBeLessThanOrEqual(0.8);
    }
    // Permanent progression matters much more than before (18 upgrades, mastery, talents, an art): the maxed
    // hero is expected to win depth 0 at oath 0 nearly always — its challenge is deeper down and at higher Oaths.
    expect(soloMax.winRate).toBeGreaterThanOrEqual(0.85);
    expect(soloMax.winRate).toBeGreaterThan(solo0.winRate + 0.25);
    expect(partyMax.winRate).toBeGreaterThan(party0.winRate);
    // Fresh winning runs last 9-15 game minutes and no chamber drags on; a maxed hero is quicker.
    for (const row of [solo0, party0]) {
      expect(row.meanWinMinutes, row.label).toBeGreaterThanOrEqual(9);
      expect(row.meanWinMinutes, row.label).toBeLessThanOrEqual(15);
    }
    for (const row of [soloMax, partyMax]) {
      expect(row.meanWinMinutes, row.label).toBeGreaterThanOrEqual(5);
      expect(row.meanWinMinutes, row.label).toBeLessThan(solo0.meanWinMinutes);
    }
    for (const row of [solo0, party0, soloMax, partyMax]) expect(row.maxChamberSeconds, row.label).toBeLessThanOrEqual(260);
    for (const row of rows) {
      if (row.winRate === 0) continue;
      const fresh = row.label.startsWith('fresh ');
      expect(row.meanBossSeconds, row.label).toBeGreaterThanOrEqual(fresh ? 60 : 35);
      expect(row.meanBossSeconds, row.label).toBeLessThanOrEqual(170);
    }
    // No final boss is a wall or a pushover for the un-upgraded hero.
    for (const row of rows.filter((r) => r.label.startsWith('fresh '))) {
      expect(row.winRate, row.label).toBeGreaterThanOrEqual(0.12);
      expect(row.winRate, row.label).toBeLessThanOrEqual(0.9);
    }
  });
});

describe('the descent with bots', () => {
  it('depth 1 is clearly harder than depth 0 for fresh heroes and within reach of maxed ones; all seven classes go down', () => {
    const play = (classes: ClassId[], loadouts: unknown[] | undefined, seeds: number): RunResult[] => {
      const out: RunResult[] = [];
      for (let i = 0; i < seeds; i++) out.push(runBots({ classes, seed: 3301 + i * 613 + classes.length, descendTo: 1, maxTicks: 2 * TICK_BUDGET, loadouts }));
      return out;
    };
    const fresh = [...PARTIES.slice(0, 2).flatMap((p) => play(p, undefined, 3)), ...SOLO.flatMap((p) => play(p, undefined, 3))];
    const maxedRuns = [...SOLO.flatMap((p) => play(p, maxed(p), 2)), ...play(PARTIES[3]!, maxed(PARTIES[3]!), 2), ...play(PARTIES[0]!, maxed(PARTIES[0]!), 1)];
    sanity([...fresh, ...maxedRuns], 'descent', 2 * TICK_BUDGET);
    const line = (label: string, rs: RunResult[]): string =>
      `${label.padEnd(8)} runs ${rs.length}  slew boss 1: ${(rate(rs, (r) => r.cleared >= 1) * 100).toFixed(0)} %  slew boss 2 (depth 1): ${(rate(rs, (r) => r.cleared >= 2) * 100).toFixed(0)} %`;
    report(`\nDescent to depth 1 (bots take the descend door once)\n${line('fresh', fresh)}\n${line('maxed', maxedRuns)}\n`);
    // Whoever beats the first boss goes down (never ascends at depth 0), and nobody goes further than asked.
    for (const r of [...fresh, ...maxedRuns]) {
      expect(r.depth).toBe(r.cleared >= 1 ? 1 : 0);
      expect(r.cleared).toBeLessThanOrEqual(2);
      if (r.cleared === 2) expect(r.phase).toBe('victory');
      if (r.cleared === 1) expect(r.phase).toBe('defeat');
      if (r.cleared >= 1) expect(r.chambersCleared).toBeGreaterThanOrEqual(RUN.CHAMBERS.length);
    }
    const freshFirst = rate(fresh, (r) => r.cleared >= 1);
    const freshSecond = rate(fresh, (r) => r.cleared >= 2);
    expect(freshFirst).toBeGreaterThan(0.2);
    // Of the fresh heroes that get there, most fall at depth 1.
    expect(freshSecond).toBeLessThan(freshFirst * 0.6);
    // Maxed heroes reach depth 1 nearly always and clear it more often than not.
    expect(rate(maxedRuns, (r) => r.cleared >= 1)).toBeGreaterThanOrEqual(0.85);
    expect(rate(maxedRuns, (r) => r.cleared >= 2)).toBeGreaterThanOrEqual(0.5);
    // Every class took part in a descent.
    for (const cls of CLASS_IDS) expect(maxedRuns.some((r) => r.depth === 1 && r.label.includes(cls)), cls).toBe(true);
  }, 900000);
});

describe('higher oaths and odd party sizes', () => {
  it('oath 1-3 runs, a high Oath with affixes and 2-3 hero parties terminate cleanly', () => {
    const results: RunResult[] = [];
    for (let oath = 1; oath < RUN.OATH.length; oath++) results.push(runBots({ classes: ['knight'], seed: 100 + oath, oath, maxTicks: TICK_BUDGET }));
    results.push(runBots({ classes: ['mage', 'knight'], seed: 55, maxTicks: TICK_BUDGET }));
    results.push(runBots({ classes: ['rogue', 'barbarian', 'mage'], seed: 56, oath: 2, maxTicks: TICK_BUDGET, meta: maxMetaLevels() }));
    results.push(runBots({ classes: ['templar', 'shade'], seed: 57, oath: RUN.DEPTH.AFFIX_FROM_OATH + 2, maxTicks: TICK_BUDGET, loadouts: maxed(['templar', 'shade']) }));
    results.push(runBots({ classes: ['spellblade'], seed: 58, oath: RUN.OATH_MAX, maxTicks: TICK_BUDGET, loadouts: maxed(['spellblade']) }));
    sanity(results, 'misc');
    report(formatTable([summarize('oath 1-20 / 2-3 heroes', results)]));
  }, 300000);
});
