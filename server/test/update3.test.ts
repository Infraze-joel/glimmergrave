/** Update 3 over real sockets: loadouts on the roster, lobby rules, Oath levels, seven classes, ultimates, the descent, rewards. */
import { afterEach, describe, expect, it } from 'vitest';
import { RUN } from '@shared/constants.ts';
import { CLASSES } from '@shared/data/classes.ts';
import { MASTERY, masteryMods } from '@shared/data/mastery.ts';
import { META_INDEX, META_UPGRADES } from '@shared/data/meta.ts';
import { RELIC_BY_ID } from '@shared/data/relics.ts';
import { BTN, CLASS_IDS, type ClassId, type GameEvent, type RunState } from '@shared/types.ts';
import { BotClient, defaultLoadout, maxLoadout, MAX_LOADOUT_MASTERY } from '../src/tools/botClient.ts';
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
const enter = async (c: Client, msg: Record<string, unknown>): Promise<void> => {
  c.send({ v: V, ...msg });
  const w = await c.next('welcome');
  c.code = w.code;
  c.slot = w.slot;
  c.token = w.token;
};

afterEach(async () => {
  for (const b of bots.splice(0)) b.close(false);
  for (const c of clients.splice(0)) c.ws.terminate();
  if (server) await server.close();
  server = null;
});

describe('loadouts of update 3', () => {
  it('the roster shows mastery and art as the server clamped them; nothing else of the loadout leaks', async () => {
    const s = await up();
    const host = await open(s.url);
    await enter(host, { t: 'create', name: 'Host', cls: 'templar', loadout: { ...defaultLoadout(), mastery: 7, art: 1, talents: [1, 2, 1], paragon: [3], relics: [{ id: 'bell', rank: 4 }] } });
    expect((await host.next('roster')).players[0]).toMatchObject({ cls: 'templar', mastery: 7, art: 1 });
    const cheat = await open(s.url);
    // Art without the mastery for it, an absurd level, a variant the class does not have.
    await enter(cheat, { t: 'join', code: host.code, name: 'Cheat', cls: 'shade', loadout: { mastery: 1, art: 1 } });
    const huge = await open(s.url);
    await enter(huge, { t: 'join', code: host.code, name: 'Huge', cls: 'mage', loadout: { mastery: 1e12, art: 2, talents: 'all' } });
    const junk = await open(s.url);
    await enter(junk, { t: 'join', code: host.code, name: 'Junk', cls: 'spellblade', loadout: 'nonsense' });
    const roster = await host.next('roster', (m) => m.players.length === 4);
    expect(roster.players.map((p) => [p.cls, p.mastery, p.art])).toEqual([
      ['templar', 7, 1], ['shade', 1, 0], ['mage', MASTERY.MAX_LEVEL, 0], ['spellblade', 1, 0],
    ]);
    expect(Object.keys(roster.players[0]!).sort()).toEqual(['art', 'boons', 'cls', 'connected', 'host', 'keystones', 'look', 'mastery', 'name', 'ready', 'relics', 'slot', 'talents']);
    // Counts of relics and talents are shown since polish 1; which ones they are still never leaves the server.
    expect(roster.players.map((p) => [p.relics, p.talents])).toEqual([[1, 2], [0, 0], [0, 0], [0, 0]]);
    expect(host.raw.join('')).not.toMatch(/talents":\[|paragon|relics":\[|bell/);
  });

  it('lobby: a loadout is only accepted together with its class; a class change without one resets mastery and art; Oath goes up to 20', async () => {
    const s = await up({ seed: 4 });
    const host = await open(s.url);
    await enter(host, { t: 'create', name: 'Host', cls: 'knight', loadout: { ...defaultLoadout(), mastery: 5, art: 1 } });
    await host.next('roster');
    // Loadout without a class: invalid.
    host.send({ t: 'lobby', loadout: { ...defaultLoadout(), mastery: 9 } });
    expect(await host.next('error')).toMatchObject({ code: 'invalid_message', fatal: false });
    expect(host.last('roster')!.players[0]).toMatchObject({ cls: 'knight', mastery: 5, art: 1 });
    // Same class, new loadout.
    host.send({ t: 'lobby', cls: 'knight', loadout: { ...defaultLoadout(), mastery: 9, art: 0 } });
    expect((await host.next('roster', (m) => m.players[0]!.mastery === 9)).players[0]).toMatchObject({ cls: 'knight', mastery: 9, art: 0 });
    // Class change without a loadout: mastery of the old class does not carry over.
    host.send({ t: 'lobby', cls: 'shade' });
    expect((await host.next('roster', (m) => m.players[0]!.cls === 'shade')).players[0]).toMatchObject({ mastery: 1, art: 0 });
    // Class change with its loadout (vitality 8 and mastery 11 give health we can see in the snapshot).
    const meta = META_UPGRADES.map(() => 0);
    meta[META_INDEX.get('vitality')!] = 8;
    host.send({ t: 'lobby', cls: 'spellblade', loadout: { ...defaultLoadout(), meta, mastery: 11, art: 1 } });
    expect((await host.next('roster', (m) => m.players[0]!.cls === 'spellblade')).players[0]).toMatchObject({ mastery: 11, art: 1 });
    // Oath: the host may choose any level up to OATH_MAX.
    host.send({ t: 'lobby', oath: RUN.OATH_MAX });
    expect((await host.next('roster', (m) => m.oath === RUN.OATH_MAX)).oath).toBe(RUN.OATH_MAX);
    host.send({ t: 'lobby', oath: RUN.OATH_MAX + 1 });
    expect(await host.next('error')).toMatchObject({ code: 'invalid_message' });
    host.send({ t: 'lobby', oath: 6 });
    await host.next('roster', (m) => m.oath === 6);
    host.send({ t: 'start' });
    const run = await host.next('run', (m) => m.state.phase !== 'lobby');
    expect(run.state).toMatchObject({ oath: 6, depth: 0, cleared: 0, chambersCleared: 0 });
    await host.until(() => host.snapshots.length >= 2, 4000, 'snapshots');
    const me = host.snapshots.at(-1)!.players[0]!;
    expect(me.maxHp).toBe(CLASSES.spellblade.maxHp + META_UPGRADES[META_INDEX.get('vitality')!]!.values[7]! + masteryMods(11).maxHp);
    expect(me.ult).toBe(0);
    // The art is what the hero really casts: Rune Ward instead of Blink Strike.
    host.input({ buttons: BTN.SECONDARY });
    host.input({ buttons: 0 });
    const cast = await host.next('ev', (m) => m.events.some((e) => e.e === 'cast'), 4000);
    expect(cast.events.filter((e): e is Extract<GameEvent, { e: 'cast' }> => e.e === 'cast').map((e) => e.ability)).toContain('spell_ward');
  });
});

interface PartyResult {
  run: RunState;
  events: Set<string>;
  casts: Set<string>;
  maxDepth: number;
  doorTypes: Set<string>;
  bots: BotClient[];
}

/** A party of bots with mastered loadouts starts at the final boss (QA option) and plays until the run ends. */
async function bossParty(classes: ClassId[], descendTo: number, seed: number, timeScale: number): Promise<PartyResult> {
  const s = await up({ timeScale, seed, debugStartChamber: RUN.CHAMBERS.length - 1, maxMessagesPerSecond: 90 * timeScale });
  const out: PartyResult = { run: null as unknown as RunState, events: new Set(), casts: new Set(), maxDepth: 0, doorTypes: new Set(), bots: [] };
  const party = classes.map((cls, i) => new BotClient({
    url: s.url, timeScale, name: `Bot${i}`, cls, create: i === 0, startWhenPlayers: i === 0 ? classes.length : undefined, seed: i + 1,
    loadout: maxLoadout(cls), descendTo,
  }));
  bots.push(...party);
  out.bots = party;
  const host = party[0]!;
  const ended = new Promise<void>((resolve) => {
    host.onRunEnd = (_phase, run) => { out.run = run; resolve(); };
  });
  host.onEvents = (events) => {
    for (const ev of events) {
      out.events.add(ev.e);
      if (ev.e === 'cast' && ev.who.t === 'p') out.casts.add(ev.ability);
      if (ev.e === 'doorChosen') out.doorTypes.add(ev.type);
    }
  };
  await host.connect();
  for (const b of party.slice(1)) { b.opts.code = host.code; await b.connect(); }
  const watch = setInterval(() => { if (host.run) out.maxDepth = Math.max(out.maxDepth, host.run.depth); }, 5);
  try {
    await ended;
  } finally {
    clearInterval(watch);
  }
  await sleep(50);
  return out;
}

describe('seven classes over real sockets', () => {
  it('a mastered party of four slays the final boss, descends to depth 1 and is paid Glimmer, XP and relic shards', async () => {
    const classes: ClassId[] = ['knight', 'barbarian', 'mage', 'rogue'];
    const r = await bossParty(classes, 1, 9101, 10);
    const { run } = r;
    process.stdout.write(`party A (${classes.join(', ')}): ${run.phase} at depth ${run.depth} chamber ${run.chamber + 1}, bosses ${run.cleared}, `
      + `rewards ${JSON.stringify(run.rewards)}\n`);
    expect(r.bots.map((b) => b.roster.find((p) => p.slot === b.slot))).toMatchObject(classes.map((cls) => ({ cls, mastery: MAX_LOADOUT_MASTERY, art: 1 })));
    expect(run.cleared).toBeGreaterThanOrEqual(1);
    expect(r.maxDepth).toBe(1);
    expect(r.doorTypes.has('descend')).toBe(true);
    expect(r.events.has('descend')).toBe(true);
    expect(run.depth).toBe(1);
    expect(['victory', 'defeat']).toContain(run.phase);
    expect(run.chambersCleared).toBeGreaterThanOrEqual(1);
    expect(run.rewards).toHaveLength(classes.length);
    for (const reward of run.rewards) {
      expect(reward.glimmer).toBeGreaterThanOrEqual(80);
      expect(reward.xp).toBeGreaterThanOrEqual(140);
      expect(reward.relics.length).toBeGreaterThanOrEqual(1);
      for (const id of reward.relics) expect(RELIC_BY_ID.has(id)).toBe(true);
    }
    expect(run.stats.reduce((n, p) => n + p.ultimates, 0)).toBeGreaterThan(0);
    expect(run.stats.reduce((n, p) => n + p.bosses, 0)).toBeGreaterThanOrEqual(1);
    for (const kind of ['ultReady', 'buff', 'zone']) expect(r.events.has(kind), kind).toBe(true);
    // Arts (mastered loadouts have them equipped) and ultimates were cast under their ability ids.
    const arts = classes.map((cls) => CLASSES[cls].arts[0]!.id).filter((id) => r.casts.has(id));
    const ults = classes.map((cls) => CLASSES[cls].ultimate.id).filter((id) => r.casts.has(id));
    expect(arts.length).toBeGreaterThanOrEqual(3);
    expect(ults.length).toBeGreaterThanOrEqual(3);
    for (const b of r.bots) expect(b.lastError).toBe('');
  }, 240000);

  it('the three new classes play a boss fight together and ascend', async () => {
    const classes: ClassId[] = ['templar', 'spellblade', 'shade'];
    const r = await bossParty(classes, 0, 9102, 10);
    const { run } = r;
    process.stdout.write(`party B (${classes.join(', ')}): ${run.phase} at depth ${run.depth}, bosses ${run.cleared}, rewards ${JSON.stringify(run.rewards)}\n`);
    expect(new Set([...classes, 'knight', 'barbarian', 'mage', 'rogue'])).toEqual(new Set(CLASS_IDS));
    expect(['victory', 'defeat']).toContain(run.phase);
    expect(run.depth).toBe(0);
    if (run.phase === 'victory') {
      expect(run.cleared).toBe(1);
      expect(r.doorTypes.has('ascend')).toBe(true);
      for (const reward of run.rewards) expect(reward.relics.length).toBeGreaterThanOrEqual(1);
    }
    expect(run.rewards).toHaveLength(3);
    expect(run.stats.every((p) => p.damage > 0)).toBe(true);
    const used = classes.flatMap((cls) => [...CLASSES[cls].primary.map((a) => a.id), CLASSES[cls].arts[0]!.id, CLASSES[cls].ultimate.id]).filter((id) => r.casts.has(id));
    expect(used.length).toBeGreaterThanOrEqual(8);
    for (const b of r.bots) expect(b.lastError).toBe('');
  }, 240000);
});
