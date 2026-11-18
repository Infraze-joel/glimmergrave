import { afterEach, describe, expect, it } from 'vitest';
import { NET } from '@shared/constants.ts';
import { INPUT_BYTES } from '@shared/protocol.ts';
import { DEFAULT_LOOK } from '@shared/data/meta.ts';
import { BTN, PF } from '@shared/types.ts';
import { parseOrigins } from '../src/main.ts';
import { boot, Client, lobby, sleep, startRun, V } from './helpers.ts';

type Booted = Awaited<ReturnType<typeof boot>>;
let server: Booted | null = null;
const clients: Client[] = [];
const up = async (opts: Parameters<typeof boot>[0] = {}): Promise<Booted> => {
  server = await boot(opts);
  return server;
};
const open = async (url: string, headers: Record<string, string> = {}): Promise<Client> => {
  const c = await Client.open(url, headers);
  clients.push(c);
  return c;
};
const track = (list: Client[]): Client[] => { clients.push(...list); return list; };

afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.terminate();
  if (server) await server.close();
  server = null;
});

describe('http', () => {
  it('serves /health and rejects everything else', async () => {
    const s = await up();
    const base = `http://127.0.0.1:${s.port}`;
    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
    expect(health.headers.get('content-type')).toContain('application/json');
    const body = (await health.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, rooms: 0, players: 0 });
    expect(typeof body.uptime).toBe('number');
    expect((await fetch(`${base}/`)).status).toBe(426);
    expect((await fetch(`${base}/secret`)).status).toBe(404);
    expect((await fetch(`${base}/health`, { method: 'POST' })).status).toBe(405);
    const c = await open(s.url);
    await c.create();
    const after = (await (await fetch(`${base}/health`)).json()) as Record<string, unknown>;
    expect(after).toMatchObject({ ok: true, rooms: 1, players: 1 });
  });

  it('checks the Origin header against the allow list', async () => {
    const s = await up({ allowedOrigins: parseOrigins('https://good.example/, https://also.example') });
    await expect(Client.open(s.url, { origin: 'https://evil.example' })).rejects.toThrow(/403/);
    const good = await open(s.url, { origin: 'https://good.example' });
    await good.create();
    const also = await open(s.url, { origin: 'https://also.example' });
    await also.join(good.code);
    // Non-browser tools send no Origin at all.
    const tool = await open(s.url);
    await tool.join(good.code, 'Tool', 'rogue');
    expect(parseOrigins(undefined)).toEqual(['*']);
    expect(parseOrigins(' * ')).toEqual(['*']);
    // Only the game paths upgrade.
    await expect(Client.open(`${s.url}/admin`)).rejects.toThrow(/404/);
    const viaWs = await open(`${s.url}/ws`);
    await viaWs.join(good.code, 'Ws', 'knight');
  });
});

describe('create / join', () => {
  it('create: welcome with code + token, roster with the host, run in lobby, empty draft', async () => {
    const s = await up();
    const c = await open(s.url);
    const w = await c.create('  Ada  <b> ', 'rogue');
    expect(w.slot).toBe(0);
    expect(w.code).toMatch(new RegExp(`^[${NET.ROOM_CODE_ALPHABET}]{${NET.ROOM_CODE_LENGTH}}$`));
    expect(w.token.length).toBeGreaterThanOrEqual(16);
    const roster = await c.next('roster');
    expect(roster.oath).toBe(0);
    expect(roster.players).toEqual([{ slot: 0, name: 'Ada b', cls: 'rogue', look: DEFAULT_LOOK, mastery: 1, art: 0, relics: 0, talents: 0, ready: false, connected: true, host: true, boons: [] }]);
    const run = await c.next('run');
    expect(run.state.phase).toBe('lobby');
    expect(run.state.room).toBeNull();
    expect(run.state).toMatchObject({ bossKind: null, rewards: [], tutorial: null });
    expect(await c.next('draft')).toEqual({ t: 'draft', options: [], rerolls: 0 });
  });

  it('join: next free slot, duplicates of a class allowed, everyone gets the roster, tokens stay private', async () => {
    const s = await up();
    const a = await open(s.url);
    await a.create('A', 'knight');
    const b = await open(s.url);
    const wb = await b.join(a.code.toLowerCase(), 'B', 'knight');
    expect(wb.slot).toBe(1);
    expect(wb.code).toBe(a.code);
    expect(wb.token).not.toBe(a.token);
    const seen = await a.next('roster', (m) => m.players.length === 2);
    expect(seen.players.map((p) => [p.slot, p.name, p.cls, p.host])).toEqual([[0, 'A', 'knight', true], [1, 'B', 'knight', false]]);
    await b.next('roster', (m) => m.players.length === 2);
    await sleep(50);
    expect(a.raw.some((t) => t.includes(b.token))).toBe(false);
    expect(b.raw.some((t) => t.includes(a.token))).toBe(false);
  });

  it('rejects an unknown code, a full room, a bad version and a bad name', async () => {
    const s = await up();
    const [host] = track(await lobby(s.url, ['mage', 'rogue', 'barbarian']));
    const late = await open(s.url);
    late.send({ t: 'join', v: V, code: 'ZZZZZ', name: 'L', cls: 'mage' });
    expect(await late.next('error')).toEqual({ t: 'error', code: 'room_not_found', fatal: false });
    late.send({ t: 'join', v: V, code: host!.code, name: 'L', cls: 'mage' });
    expect(await late.next('error')).toEqual({ t: 'error', code: 'room_full', fatal: false });
    late.send({ t: 'join', v: V, code: host!.code, name: '\u0001\u0002', cls: 'mage' });
    expect(await late.next('error')).toEqual({ t: 'error', code: 'invalid_name', fatal: false });
    // The socket survived three recoverable errors and can still create its own room.
    await late.create('Late');
    const old = await open(s.url);
    old.send({ t: 'join', v: V + 1, code: host!.code, name: 'Old', cls: 'mage' });
    expect(await old.next('error')).toEqual({ t: 'error', code: 'bad_version', fatal: true });
    expect(await old.closed).toBe(1008);
  });

  it('enforces MAX_ROOMS', async () => {
    const s = await up({ maxRooms: 1 });
    const a = await open(s.url);
    await a.create();
    const b = await open(s.url);
    b.send({ t: 'create', v: V, name: 'B', cls: 'mage' });
    expect(await b.next('error')).toEqual({ t: 'error', code: 'server_full', fatal: false });
  });
});

describe('validation', () => {
  it('answers malformed JSON, unknown messages and bad binary frames with invalid_message, then disconnects', async () => {
    const s = await up();
    const c = await open(s.url);
    await c.create();
    const bad: (string | Uint8Array)[] = [
      '{not json', JSON.stringify({ t: 'cheat', hp: 9999 }), JSON.stringify({ t: 'pick', index: 99 }), new Uint8Array(INPUT_BYTES + 1),
    ];
    for (const frame of bad) {
      c.sendRaw(frame);
      expect(await c.next('error')).toEqual({ t: 'error', code: 'invalid_message', fatal: false });
    }
    // Still alive and functional.
    c.send({ t: 'ping', c: 1 });
    expect((await c.next('pong')).c).toBe(1);
    c.sendRaw(new Uint8Array([9, 9, 9]));
    expect(await c.next('error')).toEqual({ t: 'error', code: 'invalid_message', fatal: true });
    expect(await c.closed).toBe(1008);
  });

  it('closes sockets that send oversized messages', async () => {
    const s = await up();
    const c = await open(s.url);
    await c.create();
    c.sendRaw(JSON.stringify({ t: 'ping', c: 1, pad: 'x'.repeat(NET.MAX_MESSAGE_BYTES) }));
    expect(await c.closed).toBe(1009);
    const d = await open(s.url);
    d.sendRaw(new Uint8Array(NET.MAX_MESSAGE_BYTES + 1));
    expect(await d.closed).toBe(1009);
    // The server is still healthy.
    const e = await open(s.url);
    await e.create();
  });

  it('rate limits message floods', async () => {
    const s = await up();
    const c = await open(s.url);
    await c.create();
    for (let i = 0; i < NET.MAX_MESSAGES_PER_SECOND + 20; i++) c.send({ t: 'ping', c: i });
    expect(await c.next('error', (m) => m.code === 'rate_limited')).toEqual({ t: 'error', code: 'rate_limited', fatal: true });
    expect(await c.closed).toBe(1008);
    expect(c.all('pong').length).toBeLessThanOrEqual(NET.MAX_MESSAGES_PER_SECOND);
  });

  it('ignores gameplay messages from sockets without a slot (but answers pings)', async () => {
    const s = await up();
    const c = await open(s.url);
    c.input({ moveX: 1, buttons: BTN.PRIMARY });
    c.send({ t: 'start' });
    c.send({ t: 'pick', index: 0 });
    c.send({ t: 'toLobby' });
    c.send({ t: 'lobby', ready: true });
    c.send({ t: 'ping', c: 5 });
    expect((await c.next('pong')).c).toBe(5);
    expect(c.all('error')).toEqual([]);
    expect(s.stats().rooms).toBe(0);
  });

  it('refuses a second create/join on a socket that already has a slot', async () => {
    const s = await up();
    const c = await open(s.url);
    await c.create();
    c.send({ t: 'create', v: V, name: 'Again', cls: 'mage' });
    expect((await c.next('error')).code).toBe('invalid_message');
    expect(s.stats().rooms).toBe(1);
  });

  it('drops clients that stop responding (heartbeat) and sockets that never join', async () => {
    const s = await up({ clientTimeoutMs: 300, pingIntervalMs: 100 });
    const lurker = await open(s.url);
    expect(await lurker.next('error', undefined, 3000)).toEqual({ t: 'error', code: 'timeout', fatal: true });
    await lurker.closed;
    // A joined client that answers pings stays connected well beyond the timeout.
    const c = await open(s.url);
    await c.create();
    await sleep(700);
    expect(c.ws.readyState).toBe(c.ws.OPEN);
    // One that stops reading (and therefore never answers a ping) is cut off; its slot stays reserved.
    c.ws.pause();
    const deadline = Date.now() + 3000;
    while (s.stats().connections > 0 && Date.now() < deadline) await sleep(25);
    expect(s.stats()).toMatchObject({ connections: 0, players: 0, rooms: 1 });
  });
});

describe('lobby rules', () => {
  it('class, ready and oath changes; host-only oath and start; start needs everyone ready', async () => {
    const s = await up();
    const host = await open(s.url);
    await host.create('H', 'knight');
    const guest = await open(s.url);
    await guest.join(host.code, 'G', 'mage');
    guest.send({ t: 'lobby', cls: 'rogue' });
    expect((await host.next('roster', (m) => m.players[1]?.cls === 'rogue')).players[1]!.ready).toBe(false);
    guest.send({ t: 'lobby', oath: 3 });
    expect(await guest.next('error')).toEqual({ t: 'error', code: 'not_host', fatal: false });
    guest.send({ t: 'start' });
    expect(await guest.next('error')).toEqual({ t: 'error', code: 'not_host', fatal: false });
    host.send({ t: 'lobby', oath: 2 });
    expect((await guest.next('roster', (m) => m.oath === 2)).oath).toBe(2);
    host.send({ t: 'start' });
    expect(await host.next('error')).toEqual({ t: 'error', code: 'not_ready', fatal: false });
    guest.send({ t: 'lobby', ready: true });
    await host.next('roster', (m) => m.players[1]?.ready === true);
    host.send({ t: 'start' });
    const run = await guest.next('run', (m) => m.state.phase === 'combat');
    expect(run.state.oath).toBe(2);
    expect(run.state.chamber).toBe(0);
    expect(run.state.room).not.toBeNull();
    expect(run.state.stats.map((p) => p.slot)).toEqual([0, 1]);
    // Lobby changes are ignored once the run is on.
    guest.send({ t: 'lobby', cls: 'knight' });
    await sleep(100);
    expect(guest.last('roster')!.players[1]!.cls).toBe('rogue');
  });

  it('migrates the host when the host leaves or drops', async () => {
    const s = await up();
    const [a, b, c] = track(await lobby(s.url, ['mage', 'rogue']));
    a!.send({ t: 'leave' });
    expect(await a!.closed).toBe(1000);
    const r1 = await b!.next('roster', (m) => m.players.length === 2 && m.players[0]!.slot === 1);
    expect(r1.players.map((p) => [p.slot, p.host])).toEqual([[1, true], [2, false]]);
    // The new host can use host powers; a freed slot is reused.
    b!.send({ t: 'lobby', oath: 1 });
    await c!.next('roster', (m) => m.oath === 1);
    const d = await open(s.url);
    expect((await d.join(b!.code, 'D', 'knight')).slot).toBe(0);
    await b!.drop();
    const r2 = await c!.next('roster', (m) => m.players.some((p) => p.slot === 1 && !p.connected));
    expect(r2.players.find((p) => p.host)!.slot).toBe(0);
    expect(r2.players.find((p) => p.slot === 1)).toMatchObject({ connected: false, host: false });
  });
});

describe('running game', () => {
  it('streams snapshots at 15 Hz, acknowledges inputs, moves the hero, and rejects late joiners', async () => {
    const s = await up();
    const [host, guest] = track(await lobby(s.url));
    await startRun([host!, guest!]);
    await host!.until(() => host!.snapshots.length >= 3, 3000, 'snapshots');
    const first = host!.snapshots[0]!;
    expect(first.players.map((p) => p.slot)).toEqual([0, 1]);
    expect(first.players.every((p) => (p.flags & PF.CONNECTED) !== 0)).toBe(true);
    const x0 = first.self.x;
    const t0 = Date.now();
    const n0 = host!.snapshots.length;
    for (let i = 0; i < 30; i++) {
      host!.input({ moveX: -1 });
      await sleep(1000 / NET.INPUT_HZ);
    }
    const last = host!.snapshots[host!.snapshots.length - 1]!;
    expect(last.self.ackSeq).toBeGreaterThan(20);
    expect(last.self.ackSeq).toBeLessThanOrEqual(30);
    expect(last.self.x).toBeLessThan(x0 - 3);
    expect(last.players[0]!.x).toBeCloseTo(last.self.x, 1);
    const hz = ((host!.snapshots.length - n0) * 1000) / (Date.now() - t0);
    expect(hz).toBeGreaterThan(12);
    expect(hz).toBeLessThan(18);
    // The other client sees the same hero move but has its own SelfState.
    const other = guest!.snapshots[guest!.snapshots.length - 1]!;
    expect(other.players[0]!.x).toBeLessThan(x0 - 3);
    expect(other.self.ackSeq).toBe(0);
    // Stale / replayed sequence numbers are dropped.
    host!.seq = 5;
    host!.input({ moveX: 1, buttons: BTN.DASH });
    await sleep(200);
    expect(host!.snapshots[host!.snapshots.length - 1]!.self.ackSeq).toBe(30);
    const late = await open(s.url);
    late.send({ t: 'join', v: V, code: host!.code, name: 'Late', cls: 'rogue' });
    expect(await late.next('error')).toEqual({ t: 'error', code: 'run_in_progress', fatal: false });
    expect((await guest!.next('ev', (m) => m.events.some((e) => e.e === 'spawn'), 8000)).tick).toBeGreaterThan(0);
  });

  it('a mid-run disconnect keeps the slot; rejoining restores welcome, roster, run, draft and snapshots', async () => {
    const s = await up();
    const [host, guest] = track(await lobby(s.url));
    await startRun([host!, guest!]);
    await guest!.until(() => guest!.snapshots.length >= 2, 3000, 'snapshots');
    await guest!.drop();
    const gone = await host!.next('roster', (m) => m.players.some((p) => p.slot === 1 && !p.connected));
    expect(gone.players).toHaveLength(2);
    await host!.until(() => (host!.snapshots[host!.snapshots.length - 1]!.players[1]!.flags & PF.CONNECTED) === 0, 3000, 'disconnected flag');
    // Wrong token / unknown room first.
    const back = await open(s.url);
    back.send({ t: 'rejoin', v: V, code: guest!.code, token: 'f'.repeat(32) });
    expect(await back.next('error')).toEqual({ t: 'error', code: 'session_expired', fatal: false });
    back.send({ t: 'rejoin', v: V, code: 'ZZZZZ', token: guest!.token });
    expect(await back.next('error')).toEqual({ t: 'error', code: 'room_not_found', fatal: false });
    const w = await back.rejoin(guest!.code, guest!.token);
    expect(w).toEqual({ t: 'welcome', code: guest!.code, slot: 1, token: guest!.token });
    expect((await back.next('roster')).players.map((p) => [p.slot, p.connected])).toEqual([[0, true], [1, true]]);
    expect((await back.next('run')).state.phase).toBe('combat');
    expect((await back.next('draft')).options).toEqual([]);
    await back.until(() => back.snapshots.length >= 2, 3000, 'snapshots after rejoin');
    expect(back.snapshots[0]!.self.ackSeq).toBe(0);
    back.input({ moveZ: -1 });
    back.input({ moveZ: -1 });
    await back.until(() => back.snapshots[back.snapshots.length - 1]!.self.ackSeq >= 1, 3000, 'ack after rejoin');
    await host!.next('roster', (m) => m.players.every((p) => p.connected));
  });

  it('a second socket rejoining with the token takes over the slot from the first', async () => {
    const s = await up();
    const a = await open(s.url);
    await a.create();
    const b = await open(s.url);
    const w = await b.rejoin(a.code, a.token);
    expect(w.slot).toBe(0);
    expect(await a.closed).toBe(1000);
    expect((await b.next('roster')).players).toHaveLength(1);
    expect(s.stats()).toMatchObject({ rooms: 1, players: 1 });
  });

  it('grace expiry frees the slot and invalidates the token', async () => {
    const s = await up({ rejoinGraceMs: 300, sweepIntervalMs: 50 });
    const [host, guest] = track(await lobby(s.url));
    await guest!.drop();
    await host!.next('roster', (m) => m.players.length === 2 && !m.players[1]!.connected);
    const removed = await host!.next('roster', (m) => m.players.length === 1, 3000);
    expect(removed.players[0]!.slot).toBe(0);
    const back = await open(s.url);
    back.send({ t: 'rejoin', v: V, code: guest!.code, token: guest!.token });
    expect(await back.next('error')).toEqual({ t: 'error', code: 'session_expired', fatal: false });
    expect((await back.join(host!.code, 'New', 'rogue')).slot).toBe(1);
  });

  it('grace expiry mid-run removes the hero from the world', async () => {
    const s = await up({ rejoinGraceMs: 300, sweepIntervalMs: 50 });
    const [host, guest] = track(await lobby(s.url));
    await startRun([host!, guest!]);
    await guest!.drop();
    await host!.next('roster', (m) => m.players.length === 1, 3000);
    await host!.until(() => host!.snapshots[host!.snapshots.length - 1]!.players.length === 1, 3000, 'hero removed');
    expect((await host!.next('run', (m) => m.state.stats.length === 1)).state.phase).toBe('combat');
  });

  it('destroys rooms nobody is connected to after the empty-room TTL', async () => {
    const s = await up({ emptyRoomTtlMs: 250, sweepIntervalMs: 50 });
    const a = await open(s.url);
    await a.create();
    await a.drop();
    await sleep(100);
    expect(s.stats().rooms).toBe(1);
    await sleep(500);
    expect(s.stats().rooms).toBe(0);
    const back = await open(s.url);
    back.send({ t: 'rejoin', v: V, code: a.code, token: a.token });
    expect((await back.next('error')).code).toBe('room_not_found');
  });

  it('closes idle lobbies with a timeout error', async () => {
    const s = await up({ idleRoomTtlMs: 250, sweepIntervalMs: 50 });
    const a = await open(s.url);
    await a.create();
    expect(await a.next('error', undefined, 3000)).toEqual({ t: 'error', code: 'timeout', fatal: true });
    await a.closed;
    expect(s.stats().rooms).toBe(0);
  });

  it('after a defeat the host (only) returns everyone to the lobby and can start again', async () => {
    const s = await up({ timeScale: 30, seed: 3 });
    const [host, guest] = track(await lobby(s.url));
    await startRun([host!, guest!]);
    // Nobody plays: the heroes are overrun.
    const end = await host!.next('run', (m) => m.state.phase === 'defeat', 25000);
    expect(end.state.stats.every((p) => p.downs >= 1)).toBe(true);
    expect((await guest!.next('run', (m) => m.state.phase === 'defeat')).state.chamber).toBe(0);
    guest!.send({ t: 'toLobby' });
    expect(await guest!.next('error')).toEqual({ t: 'error', code: 'not_host', fatal: false });
    host!.send({ t: 'toLobby' });
    const lobbyRun = await guest!.next('run', (m) => m.state.phase === 'lobby');
    expect(lobbyRun.state.room).toBeNull();
    const roster = guest!.last('roster')!;
    expect(roster.players.every((p) => !p.ready && p.boons.length === 0)).toBe(true);
    host!.send({ t: 'start' });
    expect((await host!.next('error')).code).toBe('not_ready');
    guest!.send({ t: 'lobby', ready: true });
    await host!.next('roster', (m) => m.players[1]!.ready);
    host!.send({ t: 'start' });
    const again = await guest!.next('run', (m) => m.state.phase === 'combat');
    expect(again.state.elapsed).toBeLessThan(1);
    expect(again.state.stats.every((p) => p.downs === 0 && p.damage === 0)).toBe(true);
  }, 40000);
});
