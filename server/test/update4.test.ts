/** Update 4 over real sockets: objective state on the wire, how often it is sent, a whole run with special objectives. */
import { afterEach, describe, expect, it } from 'vitest';
import { OBJECTIVE_TUNING } from '@shared/data/objectives.ts';
import { ENEMY_KINDS, OBJECTIVE_KINDS, type ClassId, type GameEvent, type ObjectiveKind, type RunState } from '@shared/types.ts';
import { BotClient, maxLoadout } from '../src/tools/botClient.ts';
import { boot, Client, sleep } from './helpers.ts';

type Booted = Awaited<ReturnType<typeof boot>>;
let server: Booted | null = null;
const clients: Client[] = [];
const bots: BotClient[] = [];

afterEach(async () => {
  for (const b of bots.splice(0)) b.close(false);
  for (const c of clients.splice(0)) c.ws.terminate();
  if (server) await server.close();
  server = null;
});

async function soloRun(opts: Parameters<typeof boot>[0]): Promise<Client> {
  server = await boot(opts);
  const host = await Client.open(server.url);
  clients.push(host);
  await host.create('Host', 'knight');
  host.send({ t: 'start' });
  await host.next('run', (m) => m.state.phase === 'combat');
  return host;
}

describe('objective state on the wire', () => {
  it('a special objective is announced, carried by `run` and re-sent about four times a second while it is active', async () => {
    const host = await soloRun({ seed: 7, debugStartChamber: 1, debugObjective: 'ritual' });
    const first = host.last('run')!.state;
    expect(first.objective).toMatchObject({ kind: 'ritual', status: 'active', bonus: true, anchor: null, targets: [], timeLeft: OBJECTIVE_TUNING.RITUAL.BONUS_SECONDS });
    expect(first.objective!.sites).toHaveLength(OBJECTIVE_TUNING.RITUAL.SITES);
    expect(first).toMatchObject({ objectivesDone: 0, objectiveBonuses: 0, waveCount: 0 });
    const before = host.all('run').length;
    await sleep(2000);
    const runs = host.all('run').slice(before).map((m) => m.state);
    // ~4 Hz for two seconds (plus the structural updates when a group rises).
    expect(runs.length).toBeGreaterThanOrEqual(6);
    expect(runs.length).toBeLessThanOrEqual(14);
    const left = runs.map((r) => r.objective!.timeLeft);
    for (let i = 1; i < left.length; i++) expect(left[i]!).toBeLessThanOrEqual(left[i - 1]!);
    expect(left[0]! - left[left.length - 1]!).toBeGreaterThan(1.2);
    const events = host.all('ev').flatMap((m) => m.events);
    expect(events.filter((e) => e.e === 'objective')).toContainEqual({ e: 'objective', kind: 'ritual', what: 'start' });
    // The JSON on the wire is the contract shape, nothing else.
    expect(Object.keys(first.objective!).sort()).toEqual(['anchor', 'bonus', 'kind', 'progress', 'sites', 'status', 'targets', 'timeLeft']);
    expect(Object.keys(first.objective!.sites[0]!).sort()).toEqual(['lit', 'progress', 'r', 'x', 'z']);
  });

  it('a classic chamber does not re-send the run state during combat; doors carry an objective each', async () => {
    const host = await soloRun({ seed: 7 });
    expect(host.last('run')!.state.objective).toMatchObject({ kind: 'slay', status: 'active' });
    await sleep(600);
    const before = host.all('run').length;
    await sleep(1500);
    // Only structural changes (a wave starting) are sent.
    expect(host.all('run').length - before).toBeLessThanOrEqual(2);
  });

  it('the vault shows its reliquary as `anchor`; an unknown DEBUG_OBJECTIVE is ignored by the option type', async () => {
    const host = await soloRun({ seed: 3, debugStartChamber: 2, debugObjective: 'vault' });
    const o = host.last('run')!.state.objective!;
    expect(o).toMatchObject({ kind: 'vault', status: 'active', progress: 0, bonus: false, sites: [], targets: [] });
    expect(o.anchor).toMatchObject({ hp: 1 });
    expect(OBJECTIVE_KINDS).toContain('vault');
  });
});

describe('a whole run with special objectives over real sockets', () => {
  it('a mastered party that prefers special objectives plays through; objectives, the new enemies and their events arrive', async () => {
    const classes: ClassId[] = ['knight', 'mage', 'rogue', 'templar'];
    const timeScale = 10;
    server = await boot({ timeScale, seed: 4104, maxMessagesPerSecond: 90 * timeScale });
    const party = classes.map((cls, i) => new BotClient({
      url: server!.url, name: `Bot${i + 1}`, cls, create: i === 0, startWhenPlayers: i === 0 ? classes.length : undefined, timeScale, seed: 1 + i,
      loadout: maxLoadout(cls), preferObjectives: true,
    }));
    bots.push(...party);
    const host = party[0]!;
    const events: GameEvent[] = [];
    const objectives = new Map<ObjectiveKind, Set<string>>();
    const kinds = new Set<string>();
    const doorObjectives = new Set<string>();
    let liveUpdates = 0;
    let run: RunState | null = null;
    const ended = new Promise<void>((resolve) => { host.onRunEnd = (_phase, state) => { run = state; resolve(); }; });
    host.onEvents = (batch) => {
      for (const ev of batch) {
        events.push(ev);
        if (ev.e === 'objective') {
          if (!objectives.has(ev.kind)) objectives.set(ev.kind, new Set());
          objectives.get(ev.kind)!.add(ev.what);
        }
        if (ev.e === 'spawn') kinds.add(ev.kind);
      }
    };
    await host.connect();
    for (const b of party.slice(1)) { b.opts.code = host.code; await b.connect(); }
    let lastElapsed = -1;
    const watch = setInterval(() => {
      const state = host.run;
      if (!state) return;
      for (const d of state.doors) doorObjectives.add(d.objective);
      if (state.phase === 'combat' && state.objective && state.objective.kind !== 'slay' && state.objective.status === 'active' && state.elapsed !== lastElapsed) {
        lastElapsed = state.elapsed;
        liveUpdates++;
      }
    }, 2);
    try {
      await ended;
    } finally {
      clearInterval(watch);
    }
    await sleep(50);
    const end = run as unknown as RunState;
    process.stdout.write(`objective party: ${end.phase} in chamber ${end.chamber + 1} after ${Math.round(end.elapsed)} game s; objectives ${end.objectivesDone} `
      + `(${end.objectiveBonuses} with bonus): ${[...objectives.keys()].join(', ')}; doors offered ${[...doorObjectives].join(', ')}; kinds met ${[...kinds].join(', ')}\n`);
    expect(end.phase).toBe('victory');
    expect(end.objective).toBeNull();
    expect(end.objectivesDone).toBeGreaterThanOrEqual(2);
    expect(end.objectiveBonuses).toBeLessThanOrEqual(end.objectivesDone);
    const special = [...objectives.keys()].filter((k) => k !== 'slay');
    expect(special.length).toBeGreaterThanOrEqual(2);
    for (const k of special) {
      expect(objectives.get(k)!.has('start'), k).toBe(true);
      expect(objectives.get(k)!.has('done'), k).toBe(true);
    }
    expect(events.filter((e) => e.e === 'objective' && e.what === 'done' && e.kind !== 'slay')).toHaveLength(end.objectivesDone);
    expect(liveUpdates).toBeGreaterThan(20);
    expect(doorObjectives.size).toBeGreaterThanOrEqual(3);
    // The new kinds showed up in the waves (minChamber 1-4) and every kind on the wire is a known one.
    for (const k of kinds) expect(ENEMY_KINDS).toContain(k);
    expect(['shaman', 'aegis', 'bomber', 'necromancer', 'reaver'].filter((k) => kinds.has(k)).length).toBeGreaterThanOrEqual(4);
    expect(events.some((e) => e.e === 'cast' && ['mend', 'raise', 'fuse', 'reaver_leap'].includes(e.ability))).toBe(true);
    for (const b of party) expect(b.lastError).toBe('');
  }, 240000);
});
