import { afterEach, describe, expect, it } from 'vitest';
import { RUN } from '@shared/constants.ts';
import type { RunState } from '@shared/types.ts';
import { BotClient, type BotClientOptions } from '../src/tools/botClient.ts';
import { boot, sleep } from './helpers.ts';

type Booted = Awaited<ReturnType<typeof boot>>;
let server: Booted | null = null;
const bots: BotClient[] = [];

afterEach(async () => {
  for (const b of bots.splice(0)) b.close(false);
  if (server) await server.close();
  server = null;
});

interface Outcome {
  phase: string;
  run: RunState;
  maxChamber: number;
  phases: Set<string>;
  /** Longest pause between two snapshots, in game seconds. */
  maxSnapshotGap: number;
}

/**
 * Two real WebSocket bots play one whole run against an in-process server.
 * `timeScale` speeds the server (and the bots' input clock) up; latencies are given in GAME milliseconds and
 * scaled down accordingly, so "150 ms" means the same thing to the simulation as on a real-time server.
 */
async function playRun(timeScale: number, latencyGameMs: number, jitterGameMs: number, seed: number): Promise<{ outcome: Outcome; host: BotClient; guest: BotClient }> {
  server = await boot({ timeScale, seed, maxMessagesPerSecond: 90 * timeScale });
  const base: Omit<BotClientOptions, 'name' | 'cls'> = {
    url: server.url, timeScale, latencyMs: latencyGameMs / timeScale, jitterMs: jitterGameMs / timeScale,
  };
  const host = new BotClient({ ...base, name: 'HostBot', cls: 'knight', create: true, startWhenPlayers: 2, seed: 1 });
  const guest = new BotClient({ ...base, name: 'GuestBot', cls: 'mage', seed: 2 });
  bots.push(host, guest);
  const outcome: Outcome = { phase: '', run: null as unknown as RunState, maxChamber: 0, phases: new Set(), maxSnapshotGap: 0 };
  const ended = new Promise<void>((resolve) => {
    host.onRunEnd = (phase, run) => {
      outcome.phase = phase;
      outcome.run = run;
      resolve();
    };
  });
  await host.connect();
  guest.opts.code = host.code;
  await guest.connect();
  let lastCount = 0;
  let lastChange = performance.now();
  const watch = setInterval(() => {
    const run = guest.run;
    if (!run) return;
    outcome.phases.add(run.phase);
    outcome.maxChamber = Math.max(outcome.maxChamber, run.chamber);
    const now = performance.now();
    if (guest.snapshots !== lastCount) {
      lastCount = guest.snapshots;
      lastChange = now;
    } else if (run.phase !== 'lobby' && run.phase !== 'victory' && run.phase !== 'defeat') {
      outcome.maxSnapshotGap = Math.max(outcome.maxSnapshotGap, ((now - lastChange) / 1000) * timeScale);
    }
  }, 5);
  try {
    await ended;
  } finally {
    clearInterval(watch);
  }
  await sleep(50);
  return { outcome, host, guest };
}

function check(result: Awaited<ReturnType<typeof playRun>>, label: string): void {
  const { outcome, host, guest } = result;
  const { run } = outcome;
  process.stdout.write(`${label}: ${outcome.phase} in chamber ${run.chamber + 1}/${RUN.CHAMBERS.length} after ${(run.elapsed / 60).toFixed(1)} game min; `
    + `snapshots ${host.snapshots}/${guest.snapshots}, inputs ${host.inputsSent}/${guest.inputsSent}, acked ${host.maxAck}/${guest.maxAck}, `
    + `max snapshot gap ${outcome.maxSnapshotGap.toFixed(2)} game s\n`);
  expect(['victory', 'defeat']).toContain(outcome.phase);
  // The whole loop worked over the wire: fights, drafts (boons picked), doors, chamber changes.
  expect(outcome.maxChamber).toBeGreaterThanOrEqual(1);
  for (const phase of ['combat', 'draft', 'doors']) expect(outcome.phases.has(phase), phase).toBe(true);
  expect(guest.roster.every((p) => p.boons.length >= 1)).toBe(true);
  expect(run.stats).toHaveLength(2);
  expect(run.stats.every((p) => p.damage > 0)).toBe(true);
  for (const bot of [host, guest]) {
    const ticks = run.elapsed * 30;
    // Snapshots kept arriving (15 per game second, minus scheduling slack) ...
    expect(bot.snapshots).toBeGreaterThan(ticks / 2 * 0.7);
    // ... and the server consumed (nearly) every input the bot sent.
    expect(bot.inputsSent).toBeGreaterThan(ticks * 0.7);
    expect(bot.maxAck).toBeGreaterThan(bot.inputsSent * 0.85);
    expect(bot.lastError).toBe('');
  }
  expect(outcome.maxSnapshotGap).toBeLessThan(2);
}

describe('bot clients over real sockets', () => {
  it('two bots complete a whole run', async () => {
    check(await playRun(12, 0, 0, 20261), 'no latency');
  }, 150000);

  it('two bots complete a whole run with 150 ms +- 50 ms latency in each direction', async () => {
    const result = await playRun(8, 150, 50, 20262);
    check(result, '150+-50 ms');
    // Pings went through the delay line twice: the measured round trip reflects the simulated latency.
    expect(result.host.rttMs * 8).toBeGreaterThan(200);
  }, 200000);
});
