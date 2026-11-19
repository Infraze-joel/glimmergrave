/** Polish 1 over real sockets: relic / talent counts on the roster, fixtures and enemy traits for a client that rejoins mid-chamber. */
import { afterEach, describe, expect, it } from 'vitest';
import { MASTERY } from '@shared/data/mastery.ts';
import { META_INDEX, META_UPGRADES } from '@shared/data/meta.ts';
import { OBJECTIVE_TUNING } from '@shared/data/objectives.ts';
import type { GameEvent } from '@shared/types.ts';
import { defaultLoadout } from '../src/tools/botClient.ts';
import { boot, Client, lobby, startRun, V } from './helpers.ts';

type Booted = Awaited<ReturnType<typeof boot>>;
let server: Booted | null = null;
const clients: Client[] = [];
const open = async (url: string): Promise<Client> => {
  const c = await Client.open(url);
  clients.push(c);
  return c;
};
const enter = async (c: Client, msg: Record<string, unknown>): Promise<void> => {
  c.send({ v: V, ...msg });
  const w = await c.next('welcome');
  c.code = w.code;
  c.slot = w.slot;
  c.token = w.token;
};

afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.terminate();
  if (server) await server.close();
  server = null;
});

describe('roster counts', () => {
  it('relics and talents are counted from the loadout as the server clamped it, and follow lobby changes', async () => {
    server = await boot();
    const meta = META_UPGRADES.map(() => 0);
    meta[META_INDEX.get('reliquary')!] = 2;
    const relics = [{ id: 'bell', rank: 4 }, { id: 'phoenix', rank: 1 }, { id: 'compass', rank: 2 }, { id: 'hourglass', rank: 1 }];
    const host = await open(server.url);
    // Three slots (reliquary 2), talents of the first two tiers unlocked.
    await enter(host, { t: 'create', name: 'Host', cls: 'templar', loadout: { ...defaultLoadout(), meta, mastery: MASTERY.TALENT_LEVELS[1], talents: [1, 2, 1], relics } });
    expect((await host.next('roster')).players[0]).toMatchObject({ relics: 3, talents: 2 });
    // No reliquary upgrade: one slot whatever is claimed; mastery 1: no talents; duplicates and unknown relics do not count.
    const cheat = await open(server.url);
    await enter(cheat, { t: 'join', code: host.code, name: 'Cheat', cls: 'shade', loadout: { ...defaultLoadout(), mastery: 1, talents: [1, 1, 1], relics } });
    const plain = await open(server.url);
    await enter(plain, { t: 'join', code: host.code, name: 'Plain', cls: 'mage' });
    const odd = await open(server.url);
    await enter(odd, { t: 'join', code: host.code, name: 'Odd', cls: 'rogue', loadout: { ...defaultLoadout(), meta, mastery: MASTERY.TALENT_LEVELS[2], talents: [2, 0, 1], relics: [{ id: 'bell', rank: 1 }, { id: 'bell', rank: 2 }, { id: 'nope', rank: 1 }] } });
    const roster = await host.next('roster', (m) => m.players.length === 4);
    expect(roster.players.map((p) => [p.cls, p.relics, p.talents])).toEqual([['templar', 3, 2], ['shade', 1, 0], ['mage', 0, 0], ['rogue', 1, 2]]);
    expect(Object.keys(roster.players[0]!).sort()).toEqual(['art', 'boons', 'cls', 'connected', 'host', 'keystones', 'look', 'mastery', 'name', 'ready', 'relics', 'slot', 'talents']);
    // A new loadout in the lobby updates the counts; a class change without one keeps the relics and drops the talents.
    host.send({ t: 'lobby', cls: 'templar', loadout: { ...defaultLoadout(), meta, mastery: MASTERY.TALENT_LEVELS[2], talents: [1, 1, 1], relics: relics.slice(0, 2) } });
    expect((await host.next('roster', (m) => m.players[0]!.talents === 3)).players[0]).toMatchObject({ relics: 2, talents: 3 });
    host.send({ t: 'lobby', cls: 'knight' });
    expect((await host.next('roster', (m) => m.players[0]!.cls === 'knight')).players[0]).toMatchObject({ relics: 2, talents: 0 });
  });
});

describe('a client that comes back mid-chamber', () => {
  it('receives the fixtures in room.obstacles and the traits of the enemies that already stand', async () => {
    // Chamber 4: part of every group is warded. A defend chamber: the shard is a fixture.
    server = await boot({ seed: 11, debugStartChamber: 4, debugObjective: 'defend' });
    const [host, guest] = await lobby(server.url);
    clients.push(host!, guest!);
    await startRun([host!, guest!]);
    const first = host!.last('run')!.state;
    expect(first.objective).toMatchObject({ kind: 'defend', status: 'active' });
    const shard = first.objective!.anchor!;
    // The layout is final in the first run state of the chamber.
    expect(first.room!.obstacles.filter((o) => o.kind === 'shard')).toEqual([{ x: shard.x, z: shard.z, r: OBJECTIVE_TUNING.DEFEND.RADIUS, kind: 'shard' }]);
    expect(first.traits).toEqual([]);
    const spawns = (): Extract<GameEvent, { e: 'spawn' }>[] =>
      host!.all('ev').flatMap((m) => m.events).filter((e): e is Extract<GameEvent, { e: 'spawn' }> => e.e === 'spawn');
    await host!.until(() => spawns().some((s) => s.ward !== undefined), 8000, 'a warded enemy');
    await guest!.drop();
    await host!.next('roster', (m) => m.players.some((p) => p.slot === 1 && !p.connected));
    const announced = new Map(spawns().filter((s) => s.ward !== undefined).map((s) => [s.id, s.ward]));
    const back = await open(server.url);
    await back.rejoin(guest!.code, guest!.token);
    const state = (await back.next('run')).state;
    // Nothing of what was announced before reaches the newcomer as an event: the run state carries it.
    expect(back.all('ev').flatMap((m) => m.events).filter((e) => e.e === 'spawn' && announced.has(e.id))).toEqual([]);
    expect(state.phase).toBe('combat');
    expect(state.room!.obstacles.filter((o) => o.kind === 'shard')).toHaveLength(1);
    expect(state.traits.length).toBeGreaterThan(0);
    await back.until(() => back.snapshots.length >= 1, 3000, 'a snapshot after rejoining');
    const all = new Map(spawns().filter((s) => s.ward !== undefined).map((s) => [s.id, s.ward]));
    for (const t of state.traits) {
      expect(Object.keys(t).sort()).toEqual(['id', 'ward']);
      expect(all.get(t.id)).toBe(t.ward);
    }
    // Every warded enemy announced before the drop that still stands is in the list.
    const standing = new Set(back.snapshots[0]!.enemies.filter((e) => e.hp > 0).map((e) => e.id));
    const listed = new Set(state.traits.map((t) => t.id));
    for (const id of announced.keys()) if (standing.has(id)) expect(listed.has(id), `enemy ${id}`).toBe(true);
    // The run state of the others carries the same list from then on.
    const later = await host!.next('run', (m) => m.state.traits.length > 0);
    for (const t of later.state.traits) expect(all.get(t.id) ?? spawns().find((s) => s.id === t.id)?.ward).toBe(t.ward);
  });
});
