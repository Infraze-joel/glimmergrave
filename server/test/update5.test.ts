/** Update 5 over real sockets: keystone drafts, picks, the consolation, what the other client sees. */
import { afterEach, describe, expect, it } from 'vitest';
import { RUN } from '@shared/constants.ts';
import { BOON_BY_ID } from '@shared/data/boons.ts';
import { KEYSTONE_BY_ID, KEYSTONE_TUNING } from '@shared/data/keystones.ts';
import type { GameEvent } from '@shared/types.ts';
import { BotClient, maxLoadout, parseArgs } from '../src/tools/botClient.ts';
import { boot, Client } from './helpers.ts';

type Booted = Awaited<ReturnType<typeof boot>>;
let server: Booted | null = null;
const clients: Client[] = [];
const bots: BotClient[] = [];
const TIME_SCALE = 8;
const CHAMPION = RUN.CHAMBERS.indexOf('elite');

afterEach(async () => {
  for (const b of bots.splice(0)) b.close(false);
  for (const c of clients.splice(0)) c.ws.terminate();
  if (server) await server.close();
  server = null;
});

describe('keystone drafts on the wire', () => {
  it('after the champion both heroes get a keystone draft; a forced pick shows on both rosters and as an event; the skip index brings the consolation', async () => {
    server = await boot({ timeScale: TIME_SCALE, seed: 77, debugStartChamber: CHAMPION, debugKeystones: ['colossus', 'familiar'], maxMessagesPerSecond: 90 * TIME_SCALE });
    // The host is a bot that fights (and is told to take Colossus); the guest is a raw client that only watches.
    const host = new BotClient({ url: server.url, name: 'Fighter', cls: 'knight', create: true, timeScale: TIME_SCALE, loadout: maxLoadout('knight'), keystones: ['colossus'], seed: 3 });
    bots.push(host);
    const hostEvents: GameEvent[] = [];
    host.onEvents = (ev) => { hostEvents.push(...ev); };
    await host.connect();
    const guest = await Client.open(server.url);
    clients.push(guest);
    await guest.join(host.code, 'Watcher', 'mage');
    guest.send({ t: 'lobby', ready: true });
    await guest.until(() => guest.last('roster')?.players.every((p) => p.ready || p.host) === true && guest.last('roster')!.players.length === 2, 4000, 'ready');
    expect(guest.last('roster')!.players.map((p) => [p.keystones, p.keystoneAt])).toEqual([[[], []], [[], []]]);
    host.send({ t: 'start' });
    await guest.next('run', (m) => m.state.phase === 'combat');
    expect(guest.all('draft').every((d) => d.keystone === undefined)).toBe(true);

    // The champion falls (the bot fights at 8x): the run state that leaves combat carries the damage of the chamber.
    const drafted = await guest.next('run', (m) => m.state.phase === 'draft', 90000);
    expect(drafted.state.chamber).toBe(CHAMPION);
    expect(drafted.state.stats.map((s) => s.chamberDamage.length)).toEqual([1, 1]);
    expect(drafted.state.stats[0]!.chamberDamage[0]).toBe(drafted.state.stats[0]!.damage);
    expect(drafted.state.stats[0]!.damage).toBeGreaterThan(0);

    const draft = await guest.next('draft', (m) => m.keystone !== undefined);
    expect(draft.keystone).toEqual({ held: [], skip: KEYSTONE_TUNING.CHOICES });
    expect(draft.options).toHaveLength(KEYSTONE_TUNING.CHOICES);
    expect(draft.options.slice(0, 2)).toEqual([{ id: 'colossus', level: 1 }, { id: 'familiar', level: 1 }]);
    for (const o of draft.options) expect([undefined, 'mage']).toContain(KEYSTONE_BY_ID.get(o.id)!.cls);
    expect(Object.keys(draft).sort()).toEqual(['keystone', 'options', 'rerolls', 't']);

    // The bot's pick: the roster (with keystoneAt) reaches the guest BEFORE the `keystone` event does.
    await guest.until(() => guest.log.some((m) => m.t === 'ev' && m.events.some((e) => e.e === 'keystone' && e.slot === 0)), 8000, 'keystone event');
    const rosterAt = guest.log.findIndex((m) => m.t === 'roster' && m.players[0]!.keystones.includes('colossus'));
    const eventAt = guest.log.findIndex((m) => m.t === 'ev' && m.events.some((e) => e.e === 'keystone' && e.slot === 0));
    expect(rosterAt).toBeGreaterThanOrEqual(0);
    expect(rosterAt).toBeLessThan(eventAt);
    const roster = guest.last('roster')!;
    expect(roster.players[0]).toMatchObject({ keystones: ['colossus'], keystoneAt: [1] });
    expect(roster.players[1]).toMatchObject({ keystones: [], keystoneAt: [] });
    expect(guest.all('ev').flatMap((m) => m.events).filter((e) => e.e === 'keystone')).toEqual([{ e: 'keystone', slot: 0, id: 'colossus' }]);
    expect(host.lastKeystoneDraft?.keystone).toEqual({ held: [], skip: KEYSTONE_TUNING.CHOICES });
    await new Promise((r) => setTimeout(r, 300));
    expect(hostEvents.filter((e) => e.e === 'keystone')).toHaveLength(1);
    expect(host.roster.find((p) => p.slot === 0)!.keystones).toEqual(['colossus']);

    // Garbage picks change nothing; the skip index trades the keystones for rare-or-better boons.
    const before = guest.all('draft').length;
    guest.send({ t: 'pick', index: 7 });
    guest.send({ t: 'pick', index: KEYSTONE_TUNING.CHOICES, replace: 'colossus' });
    const consolation = await guest.next('draft', (m) => m.keystone === undefined && m.options.length > 0);
    expect(guest.all('draft').length).toBe(before + 1);
    expect(consolation.options).toHaveLength(RUN.DRAFT_CHOICES);
    for (const o of consolation.options) expect(BOON_BY_ID.get(o.id)!.rarity).not.toBe('common');
    expect(guest.last('run')!.state.draftPending).toContain(1);
    guest.send({ t: 'pick', index: 0 });
    await guest.next('run', (m) => m.state.phase === 'doors', 8000);
    expect(guest.last('roster')!.players[1]).toMatchObject({ keystones: [], boons: [{ id: consolation.options[0]!.id, level: 1 }] });
    expect(guest.all('error')).toHaveLength(0);
  }, 150000);

  it('a bot run over sockets: every bot takes a keystone after each elite chamber, the forced one included', async () => {
    server = await boot({ timeScale: TIME_SCALE, seed: 12, debugStartChamber: CHAMPION, debugKeystones: ['orbit_blades', 'sanguine'], maxMessagesPerSecond: 90 * TIME_SCALE });
    const base = { url: server.url, timeScale: TIME_SCALE, keystones: ['orbit_blades', 'sanguine'] };
    const host = new BotClient({ ...base, name: 'A', cls: 'templar', create: true, startWhenPlayers: 2, loadout: maxLoadout('templar'), seed: 1 });
    const guest = new BotClient({ ...base, name: 'B', cls: 'shade', loadout: maxLoadout('shade'), seed: 2 });
    bots.push(host, guest);
    const procs = new Set<string>();
    host.onEvents = (ev) => { for (const e of ev) if (e.e === 'keystoneProc') procs.add(e.id); };
    const ended = new Promise<string>((resolve) => { host.onRunEnd = (phase) => resolve(phase); });
    await host.connect();
    guest.opts.code = host.code;
    await guest.connect();
    // Over real sockets at 8x speed the outcome of the boss fight depends on timing, so this test does not ask for a
    // win (bot win rates are measured in shared/test/botruns.test.ts). It asks that both keystone drafts happened.
    const phase = await ended;
    expect(['victory', 'defeat']).toContain(phase);
    for (const bot of [host, guest]) {
      const me = bot.roster.find((p) => p.slot === bot.slot)!;
      expect(me.keystones).toEqual(['orbit_blades', 'sanguine']);
      expect(me.keystoneAt).toEqual([1, 4]);
      expect(bot.keystoneDrafts).toBe(2);
      expect(bot.lastError).toBe('');
    }
    expect(procs.has('sanguine')).toBe(true);
    // One damage entry per chamber entered (the run starts in the champion's chamber).
    const entered = host.run!.chamber - CHAMPION + 1;
    expect(host.run!.stats.every((s) => s.chamberDamage.length === entered)).toBe(true);
    if (phase === 'victory') expect(entered).toBe(RUN.CHAMBERS.length - CHAMPION);
  }, 240000);

  it('botClient --keystone id[,id]: the ids reach the bots; an unknown id is refused', () => {
    expect(parseArgs(['--create', '--keystone', 'ember_wake,chain_lightning']).keystones).toEqual(['ember_wake', 'chain_lightning']);
    expect(parseArgs(['--create', '--keystone', 'ks_mage', '--keystone', 'glass_cannon']).keystones).toEqual(['ks_mage', 'glass_cannon']);
    expect(parseArgs(['--create']).keystones).toEqual([]);
    expect(() => parseArgs(['--create', '--keystone', 'colossus,nope'])).toThrow(/unknown keystone "nope"/);
  });
});
