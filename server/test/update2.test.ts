import { afterEach, describe, expect, it } from 'vitest';
import { NET } from '@shared/constants.ts';
import { BOON_BY_ID } from '@shared/data/boons.ts';
import { CLASSES } from '@shared/data/classes.ts';
import { XP_REWARDS } from '@shared/data/mastery.ts';
import { DEFAULT_LOOK, LOOK, META_INDEX, META_UPGRADES, REWARDS } from '@shared/data/meta.ts';
import { TUTORIAL_STEPS } from '@shared/data/tutorial.ts';
import { BIOME_IDS, BOSS_KINDS, type GameEvent, type Loadout } from '@shared/types.ts';
import { BotClient, defaultLoadout, maxLoadout } from '../src/tools/botClient.ts';
import { boot, Client, sleep, V } from './helpers.ts';

type Booted = Awaited<ReturnType<typeof boot>>;
let server: Booted | null = null;
const clients: Client[] = [];
const bots: BotClient[] = [];
const up = async (opts: Parameters<typeof boot>[0] = {}): Promise<Booted> => {
  server = await boot(opts);
  return server;
};
const open = async (url: string): Promise<Client> => {
  const c = await Client.open(url);
  clients.push(c);
  return c;
};

afterEach(async () => {
  for (const b of bots.splice(0)) b.close(false);
  for (const c of clients.splice(0)) c.ws.terminate();
  if (server) await server.close();
  server = null;
});

const meta = (levels: Record<string, number>): number[] => {
  const out = META_UPGRADES.map(() => 0);
  for (const [id, level] of Object.entries(levels)) out[META_INDEX.get(id)!] = level;
  return out;
};
const enter = async (c: Client, msg: Record<string, unknown>): Promise<void> => {
  c.send({ v: V, ...msg });
  const w = await c.next('welcome');
  c.code = w.code;
  c.slot = w.slot;
  c.token = w.token;
};
const lastMaxHp = (c: Client, slot: number): number => c.snapshots[c.snapshots.length - 1]!.players.find((p) => p.slot === slot)!.maxHp;

describe('protocol version', () => {
  it('a protocol v1 or v2 client gets bad_version and is disconnected, on create, join and rejoin', async () => {
    const s = await up();
    const host = await open(s.url);
    await host.create();
    expect(NET.PROTOCOL_VERSION).toBe(3);
    for (const msg of [1, 2].flatMap((v) => [
      { t: 'create', v, name: 'Old', cls: 'knight' },
      { t: 'join', v, code: host.code, name: 'Old', cls: 'knight' },
      { t: 'rejoin', v, code: host.code, token: host.token },
    ])) {
      const old = await open(s.url);
      old.send(msg);
      expect(await old.next('error')).toEqual({ t: 'error', code: 'bad_version', fatal: true });
      expect(await old.closed).toBe(1008);
      expect(old.all('welcome')).toHaveLength(0);
    }
    // The room is untouched.
    expect(host.last('roster')!.players).toHaveLength(1);
    expect(s.stats().rooms).toBe(1);
  });
});

describe('loadouts', () => {
  it('create / join with a loadout: everyone sees the look on the roster; garbage and over-max values are clamped', async () => {
    const s = await up({ seed: 7 });
    const host = await open(s.url);
    const look = { color: 4, head: false, cape: true, style: 2 };
    await enter(host, { t: 'create', name: 'Host', cls: 'knight', loadout: { look, meta: meta({ vitality: 2 }) } });
    expect((await host.next('roster')).players[0]).toMatchObject({ slot: 0, look, boons: [] });

    const junk = await open(s.url);
    await enter(junk, { t: 'join', code: host.code, name: 'Junk', cls: 'mage', loadout: { look: { color: 999, head: 'no', cape: null, style: -3, crown: true }, meta: [99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99] } });
    const none = await open(s.url);
    await enter(none, { t: 'join', code: host.code, name: 'None', cls: 'rogue', loadout: 'nonsense' });
    const bare = await open(s.url);
    await enter(bare, { t: 'join', code: host.code, name: 'Bare', cls: 'barbarian' });
    const roster = await host.next('roster', (m) => m.players.length === 4);
    expect(roster.players.map((p) => p.look)).toEqual([
      look, { color: LOOK.COLORS.length - 1, head: true, cape: true, style: 0 }, DEFAULT_LOOK, DEFAULT_LOOK,
    ]);
    for (const c of [junk, none, bare]) expect((await c.next('roster', (m) => m.players.length === 4)).players[0]!.look).toEqual(look);
    // Nothing but the four look fields ever reaches other clients.
    expect(Object.keys(roster.players[1]!.look).sort()).toEqual(['cape', 'color', 'head', 'style']);
    expect(host.raw.join('').includes('crown')).toBe(false);

    // The clamped levels are what the simulation uses: the level-2 value for vitality 2, the top value for "99".
    for (const c of [junk, none, bare]) c.send({ t: 'lobby', ready: true });
    await host.until(() => host.last('roster')!.players.every((p) => p.ready || p.host), 4000, 'ready');
    host.send({ t: 'start' });
    // "99" in every slot includes attunement: the run opens with that hero's infusion draft.
    const run = await host.next('run', (m) => m.state.phase !== 'lobby');
    expect(run.state.phase).toBe('draft');
    expect(run.state.draftPending).toEqual([1]);
    const draft = await junk.next('draft', (m) => m.options.length > 0);
    expect(draft.rerolls).toBe(META_UPGRADES[META_INDEX.get('insight')!]!.values.at(-1));
    junk.send({ t: 'pick', index: 0 });
    await host.next('run', (m) => m.state.phase === 'combat');
    await host.until(() => host.snapshots.length >= 2, 4000, 'snapshots');
    const vitality = META_UPGRADES[META_INDEX.get('vitality')!]!.values;
    expect(lastMaxHp(host, 0)).toBe(CLASSES.knight.maxHp + vitality[1]!);
    expect(lastMaxHp(host, 1)).toBe(CLASSES.mage.maxHp + vitality.at(-1)!);
    expect(lastMaxHp(host, 2)).toBe(CLASSES.rogue.maxHp);
    expect(lastMaxHp(host, 3)).toBe(CLASSES.barbarian.maxHp);
  });

  it('a lobby message with a loadout replaces look and upgrade levels, in the lobby only', async () => {
    const s = await up({ seed: 8 });
    const host = await open(s.url);
    await enter(host, { t: 'create', name: 'Host', cls: 'knight', loadout: defaultLoadout() });
    const guest = await open(s.url);
    await enter(guest, { t: 'join', code: host.code, name: 'Guest', cls: 'mage', loadout: defaultLoadout() });
    await host.next('roster', (m) => m.players.length === 2);
    const look = { color: 7, head: true, cape: false, style: 1 };
    // A loadout always comes with the class it belongs to (here: the unchanged one).
    guest.send({ t: 'lobby', cls: 'mage', loadout: { look, meta: meta({ vitality: 5 }) } });
    const seen = await host.next('roster', (m) => m.players[1]!.look.color === 7);
    expect(seen.players[1]).toMatchObject({ look, cls: 'mage', ready: false });
    expect(seen.players[0]!.look).toEqual(DEFAULT_LOOK);
    // Class changes keep the loadout; a garbage loadout falls back to the default instead of being an error.
    guest.send({ t: 'lobby', cls: 'rogue', ready: true });
    expect((await host.next('roster', (m) => m.players[1]!.cls === 'rogue')).players[1]!.look).toEqual(look);
    host.send({ t: 'lobby', cls: 'knight', loadout: { look: 5, meta: 'max' } });
    await sleep(60);
    expect(host.all('error')).toHaveLength(0);
    host.send({ t: 'start' });
    await host.next('run', (m) => m.state.phase === 'combat');
    await host.until(() => host.snapshots.length >= 2, 4000, 'snapshots');
    const top = META_UPGRADES[META_INDEX.get('vitality')!]!.values[4]!;
    expect(lastMaxHp(host, 1)).toBe(CLASSES.rogue.maxHp + top);
    // During the run the loadout is frozen.
    const rosters = host.all('roster').length;
    guest.send({ t: 'lobby', cls: 'rogue', loadout: { look: DEFAULT_LOOK, meta: meta({}) } });
    await sleep(120);
    expect(host.all('roster').length).toBe(rosters);
    expect(host.last('roster')!.players[1]!.look).toEqual(look);
    await host.until(() => host.snapshots.length >= 4, 4000, 'more snapshots');
    expect(lastMaxHp(host, 1)).toBe(CLASSES.rogue.maxHp + top);
  });
});

describe('run state of update 2', () => {
  it('the first run message names the final boss and carries biome + hazards; a defeat publishes rewards', async () => {
    const s = await up({ seed: 11, timeScale: 30 });
    const host = await open(s.url);
    await enter(host, { t: 'create', name: 'Host', cls: 'knight', loadout: { look: DEFAULT_LOOK, meta: meta({ fortune: 3 }) } });
    const guest = await open(s.url);
    await enter(guest, { t: 'join', code: host.code, name: 'Guest', cls: 'mage', loadout: defaultLoadout() });
    guest.send({ t: 'lobby', ready: true });
    await host.next('roster', (m) => m.players.length === 2 && m.players[1]!.ready);
    host.send({ t: 'start' });
    const first = await guest.next('run', (m) => m.state.phase !== 'lobby');
    expect(BOSS_KINDS).toContain(first.state.finalBoss);
    expect(first.state).toMatchObject({ phase: 'combat', bossKind: null, rewards: [], tutorial: null, chamber: 0 });
    expect(BIOME_IDS).toContain(first.state.room!.biome);
    expect(first.state.room!.biome).toBe('crypt');
    expect(Array.isArray(first.state.room!.hazards)).toBe(true);
    // Nobody plays: the heroes are overrun and paid the minimum (the host with a fortune bonus).
    const end = await guest.next('run', (m) => m.state.phase === 'defeat', 25000);
    expect(end.state.finalBoss).toBe(first.state.finalBoss);
    expect(end.state.rewards).toEqual([
      { slot: 0, glimmer: Math.round(REWARDS.MINIMUM * 1.3), xp: XP_REWARDS.MINIMUM, relics: [] },
      { slot: 1, glimmer: REWARDS.MINIMUM, xp: XP_REWARDS.MINIMUM, relics: [] },
    ]);
    // Back in the lobby the rewards are gone again.
    host.send({ t: 'toLobby' });
    expect((await guest.next('run', (m) => m.state.phase === 'lobby')).state.rewards).toEqual([]);
  }, 40000);
});

describe('draft rerolls and the attunement draft over the wire', () => {
  it('reroll replaces the private draft and reports the rerolls left; rejoining restores draft, looks and the room', async () => {
    const s = await up({ seed: 5 });
    const host = await open(s.url);
    const look = { color: 2, head: true, cape: true, style: 1 };
    await enter(host, { t: 'create', name: 'Host', cls: 'knight', loadout: { look, meta: meta({ attunement: 1, insight: 2 }) } });
    const guest = await open(s.url);
    await enter(guest, { t: 'join', code: host.code, name: 'Guest', cls: 'mage', loadout: defaultLoadout() });
    guest.send({ t: 'lobby', ready: true });
    await host.next('roster', (m) => m.players.length === 2 && m.players[1]!.ready);
    expect(host.all('draft')[0]).toEqual({ t: 'draft', options: [], rerolls: 2 });
    host.send({ t: 'start' });
    // Attunement: the run opens in the draft phase for the host alone.
    const run = await guest.next('run', (m) => m.state.phase !== 'lobby');
    expect(run.state).toMatchObject({ phase: 'draft', chamber: 0, wave: 0, draftPending: [0] });
    const d1 = await host.next('draft', (m) => m.options.length > 0);
    expect(d1.rerolls).toBe(2);
    expect(d1.options).toHaveLength(3);
    for (const o of d1.options) expect(BOON_BY_ID.get(o.id)!.category).toBe('infusion');
    // The guest has nothing to pick, cannot reroll and cannot see the host's offers.
    guest.send({ t: 'reroll' });
    guest.send({ t: 'pick', index: 0 });
    host.send({ t: 'reroll' });
    const d2 = await host.next('draft');
    expect(d2.rerolls).toBe(1);
    expect(d2.options).toHaveLength(3);
    for (const o of d2.options) {
      expect(BOON_BY_ID.get(o.id)!.category).toBe('infusion');
      expect(d1.options.map((x) => x.id)).not.toContain(o.id);
    }
    await sleep(80);
    expect(guest.all('draft').every((m) => m.options.length === 0 && m.rerolls === 0)).toBe(true);
    for (const o of [...d1.options, ...d2.options]) expect(guest.raw.some((t) => t.includes(`"${o.id}"`))).toBe(false);
    expect(guest.last('run')!.state.phase).toBe('draft');

    // Drop and rejoin in the middle of the draft: welcome, roster (with looks), run (room, biome, hazards), draft.
    await host.drop();
    const back = await open(s.url);
    await back.rejoin(host.code, host.token);
    const roster = await back.next('roster');
    expect(roster.players.map((p) => p.look)).toEqual([look, DEFAULT_LOOK]);
    const state = (await back.next('run')).state;
    expect(state).toMatchObject({ phase: 'draft', draftPending: [0], tutorial: null, rewards: [] });
    expect(state.room).toMatchObject({ biome: 'crypt', hazards: [] });
    expect(BOSS_KINDS).toContain(state.finalBoss);
    expect(await back.next('draft')).toEqual({ t: 'draft', options: d2.options, rerolls: 1 });

    back.send({ t: 'reroll' });
    const d3 = await back.next('draft');
    expect(d3.rerolls).toBe(0);
    for (const o of d3.options) expect(d2.options.map((x) => x.id)).not.toContain(o.id);
    // No rerolls left: the message is ignored (no new draft, no error).
    back.send({ t: 'reroll' });
    await sleep(100);
    expect(back.all('draft')).toHaveLength(2);
    expect(back.all('error')).toHaveLength(0);
    back.send({ t: 'pick', index: 1 });
    expect(await back.next('draft')).toEqual({ t: 'draft', options: [], rerolls: 0 });
    const combat = await guest.next('run', (m) => m.state.phase === 'combat');
    expect(combat.state.wave).toBe(0);
    await guest.until(() => guest.last('roster')!.players[0]!.boons.length === 1, 4000, 'boon on the roster');
    expect(guest.last('roster')!.players[0]!.boons).toEqual([{ id: d3.options[1]!.id, level: 1 }]);
    // Only now does the first wave come.
    const wave = await guest.next('ev', (m) => m.events.some((e) => e.e === 'wave'), 6000);
    expect(wave.events.find((e) => e.e === 'wave')).toMatchObject({ wave: 1 });
    expect(guest.all('ev').flatMap((m) => m.events).filter((e) => e.e === 'wave')).toHaveLength(1);
  });
});

describe('tutorial sessions', () => {
  it('create with tutorial: true starts a solo training run at once; it cannot be joined, started or sent to a lobby', async () => {
    const s = await up({ seed: 3 });
    const c = await open(s.url);
    const look = { color: 5, head: true, cape: false, style: 0 };
    await enter(c, { t: 'create', name: 'Rookie', cls: 'rogue', tutorial: true, loadout: { look, meta: maxLoadout().meta } });
    const roster = await c.next('roster');
    expect(roster.players).toEqual([{ slot: 0, name: 'Rookie', cls: 'rogue', look, mastery: 1, art: 0, relics: 0, talents: 0, ready: false, connected: true, host: true, boons: [] }]);
    const run = (await c.next('run')).state;
    expect(run.phase).toBe('combat');
    expect(run.tutorial).toMatchObject({ step: TUTORIAL_STEPS[0], index: 0, total: TUTORIAL_STEPS.length, progress: 0 });
    expect(run.tutorial!.marker).not.toBeNull();
    expect(run.room).toMatchObject({ biome: 'crypt' });
    expect(run.room!.hazards).toHaveLength(1);
    // Permanent upgrades do not apply in training: no attunement draft, no rerolls.
    expect(await c.next('draft')).toEqual({ t: 'draft', options: [], rerolls: 0 });
    const ev = await c.next('ev', (m) => m.events.some((e) => e.e === 'tutorialStep'));
    expect(ev.events).toContainEqual({ e: 'tutorialStep', step: 'move' });
    await c.until(() => c.snapshots.length >= 3, 4000, 'snapshots');
    expect(c.snapshots[c.snapshots.length - 1]!.players).toHaveLength(1);
    expect(lastMaxHp(c, 0)).toBe(CLASSES.rogue.maxHp);

    const other = await open(s.url);
    other.send({ t: 'join', v: V, code: c.code, name: 'Friend', cls: 'mage', loadout: defaultLoadout() });
    expect(await other.next('error')).toEqual({ t: 'error', code: 'run_in_progress', fatal: false });
    c.send({ t: 'start' });
    c.send({ t: 'toLobby' });
    c.send({ t: 'lobby', cls: 'knight', ready: true });
    await sleep(150);
    expect(c.all('error')).toHaveLength(0);
    expect(c.last('run')!.state.phase).toBe('combat');
    expect(c.last('roster')!.players[0]!.cls).toBe('rogue');

    // Walking onto the marker advances to the second step.
    const marker = run.tutorial!.marker!;
    const timer = setInterval(() => {
      const me = c.snapshots[c.snapshots.length - 1]!.players[0]!;
      const dx = marker.x - me.x;
      const dz = marker.z - me.z;
      const d = Math.hypot(dx, dz) || 1;
      c.input({ moveX: dx / d, moveZ: dz / d });
    }, 33);
    try {
      const next = await c.next('run', (m) => m.state.tutorial?.step === TUTORIAL_STEPS[1], 8000);
      expect(next.state.tutorial).toMatchObject({ index: 1, total: TUTORIAL_STEPS.length });
    } finally {
      clearInterval(timer);
    }
    // A reload mid-tutorial comes back to the same step.
    await c.drop();
    const back = await open(s.url);
    await back.rejoin(c.code, c.token);
    expect((await back.next('roster')).players[0]!.look).toEqual(look);
    expect((await back.next('run')).state.tutorial).toMatchObject({ step: TUTORIAL_STEPS[1], index: 1 });
  });

  it('a bot client completes the whole tutorial over real sockets and is paid the tutorial reward once', async () => {
    const timeScale = 10;
    const s = await up({ seed: 4, timeScale, maxMessagesPerSecond: 90 * timeScale });
    const bot = new BotClient({ url: s.url, name: 'TutorBot', cls: 'knight', tutorial: true, timeScale, seed: 1 });
    bots.push(bot);
    const steps: string[] = [];
    const ended = new Promise<{ phase: string; rewards: { slot: number; glimmer: number }[]; elapsed: number }>((resolve) => {
      bot.onRunEnd = (phase, run) => resolve({ phase, rewards: run.rewards, elapsed: run.elapsed });
    });
    await bot.connect();
    const watch = setInterval(() => {
      const step = bot.run?.tutorial?.step;
      if (step && steps[steps.length - 1] !== step) steps.push(step);
    }, 2);
    const result = await ended;
    clearInterval(watch);
    process.stdout.write(`tutorial over sockets: ${result.phase} after ${result.elapsed.toFixed(0)} game s, steps seen: ${steps.join(' > ')}\n`);
    expect(result.phase).toBe('victory');
    expect(result.rewards).toEqual([{ slot: 0, glimmer: REWARDS.TUTORIAL, xp: XP_REWARDS.TUTORIAL, relics: [] }]);
    expect(result.elapsed).toBeLessThan(180);
    expect(steps[0]).toBe('move');
    expect(steps[steps.length - 1]).toBe('door');
    expect(steps.length).toBeGreaterThanOrEqual(TUTORIAL_STEPS.length - 2);
    expect(bot.roster[0]!.boons.map((b) => b.id)).toEqual(expect.arrayContaining(['infuse_ember_primary', 'infuse_rime_secondary', 'infuse_storm_dash']));
    expect(bot.runsEnded).toBe(1);
    expect(bot.lastError).toBe('');
    // The room stays a finished tutorial: no second payout, no lobby.
    bot.send({ t: 'toLobby' });
    await sleep(200);
    expect(bot.run!.phase).toBe('victory');
    expect(bot.run!.rewards).toEqual([{ slot: 0, glimmer: REWARDS.TUTORIAL, xp: XP_REWARDS.TUTORIAL, relics: [] }]);
    expect(bot.runsEnded).toBe(1);
  }, 60000);

  it('tutorial rooms are freed like any other room when their player is gone', async () => {
    const s = await up({ emptyRoomTtlMs: 150, rejoinGraceMs: 150, sweepIntervalMs: 40 });
    const c = await open(s.url);
    await enter(c, { t: 'create', name: 'Rookie', cls: 'knight', tutorial: true });
    expect(s.stats().rooms).toBe(1);
    await c.drop();
    await sleep(500);
    expect(s.stats().rooms).toBe(0);
  });
});

describe('bot client loadouts', () => {
  it('sends the default loadout, or the highest level of every upgrade with the max option', async () => {
    const s = await up();
    const plain = new BotClient({ url: s.url, name: 'Plain', cls: 'knight', create: true });
    const maxed = new BotClient({ url: s.url, name: 'Maxed', cls: 'mage', loadout: maxLoadout() as Loadout });
    bots.push(plain, maxed);
    await plain.connect();
    maxed.opts.code = plain.code;
    await maxed.connect();
    await sleep(100);
    expect(plain.roster.map((p) => p.look)).toEqual([DEFAULT_LOOK, DEFAULT_LOOK]);
    expect(maxLoadout().meta).toEqual(META_UPGRADES.map((u) => u.costs.length));
    expect(defaultLoadout().meta.every((v) => v === 0)).toBe(true);
    // The maxed bot's rerolls show up in its private draft message.
    expect(maxed.rerolls).toBe(3);
    expect(plain.rerolls).toBe(0);
    const ev: GameEvent[] = [];
    void ev;
  });
});
