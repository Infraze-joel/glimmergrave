/** Shared helpers for simulation tests and balance soaks. */
import { TICK_DT, WORLD } from '@shared/constants.ts';
import { killEnemy } from '@shared/sim/combat.ts';
import { BotBrain, viewFromWorld, World, type RunOverrides } from '@shared/sim/index.ts';
import type { BossKind, ClassId, EnemyKind, GameEvent, InputCmd, RunPhase } from '@shared/types.ts';

export interface RunResult {
  phase: RunPhase;
  ticks: number;
  /** Game minutes (run.elapsed). */
  minutes: number;
  chamber: number;
  damageTaken: number;
  damageDealt: number;
  downs: number;
  resonances: number;
  chamberSeconds: number[];
  bossSeconds: number;
  /** Combat seconds of the herald chamber (0 if the run never got there). */
  heraldSeconds: number;
  finalBoss: BossKind;
  herald: EnemyKind | null;
  glimmer: number;
  hazardHitsHeroes: number;
  hazardHitsEnemies: number;
  maxEnemies: number;
  maxProjectiles: number;
  nan: boolean;
  events: number;
}

export interface RunOptions {
  classes: ClassId[];
  seed: number;
  oath?: number;
  maxTicks?: number;
  /** Permanent upgrade levels for every hero (default: none). */
  meta?: number[];
  overrides?: RunOverrides;
  startChamber?: number;
  onTick?: (world: World, events: GameEvent[]) => void;
}

const hasNaN = (world: World): boolean => {
  for (const h of world.heroes) {
    if (!Number.isFinite(h.body.x) || !Number.isFinite(h.body.z) || !Number.isFinite(h.hp) || !Number.isFinite(h.rot)) return true;
  }
  for (const e of world.enemies) if (!Number.isFinite(e.x) || !Number.isFinite(e.z) || !Number.isFinite(e.hp) || !Number.isFinite(e.rot)) return true;
  for (const p of world.projectiles) if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) return true;
  return false;
};

/** Plays one whole run with bots in the pure simulation. */
export function runBots(opts: RunOptions): RunResult {
  const world = new World();
  opts.classes.forEach((cls, slot) => world.addPlayer(slot, cls, `Bot${slot}`, opts.meta));
  world.start(opts.oath ?? 0, opts.seed, opts.startChamber ?? 0, opts.overrides);
  const bots = opts.classes.map((cls, slot) => new BotBrain(slot, cls, opts.seed));
  const maxTicks = opts.maxTicks ?? 30 * 60 * 30;
  const result: RunResult = {
    phase: 'combat', ticks: 0, minutes: 0, chamber: 0, damageTaken: 0, damageDealt: 0, downs: 0, resonances: 0,
    chamberSeconds: [], bossSeconds: 0, heraldSeconds: 0, finalBoss: world.run.finalBoss, herald: null, glimmer: 0,
    hazardHitsHeroes: 0, hazardHitsEnemies: 0, maxEnemies: 0, maxProjectiles: 0, nan: false, events: 0,
  };
  const heraldChamber = 6;
  let chamber = 0;
  let chamberStart = 0;
  let combatTicks = 0;
  while (world.tick < maxTicks) {
    const phase = world.run.phase;
    if (phase === 'victory' || phase === 'defeat') break;
    const shared = { ...world.getSnapshotBody(), run: world.getRunState() };
    for (const bot of bots) {
      if (phase === 'draft') {
        const offers = world.getDraft(bot.slot);
        if (offers.length > 0) world.pickBoon(bot.slot, bot.chooseBoon(offers, world.getBoons(bot.slot)));
      }
      world.applyInput(bot.slot, bot.think(viewFromWorld(world, bot.slot, shared)));
    }
    world.step();
    const events = world.drainEvents();
    result.events += events.length;
    for (const ev of events) {
      if (ev.e !== 'hazardHit') continue;
      if (ev.target.t === 'p') result.hazardHitsHeroes++; else result.hazardHitsEnemies++;
    }
    for (const bot of bots) bot.observe(events, world.tick);
    if (opts.onTick) opts.onTick(world, events);
    if (world.run.phase === 'combat') {
      combatTicks++;
      if (world.run.chamber === heraldChamber) { result.heraldSeconds += TICK_DT; result.herald = world.run.bossKind; }
    }
    if (world.run.chamber !== chamber) {
      result.chamberSeconds.push((world.tick - chamberStart) * TICK_DT);
      chamber = world.run.chamber;
      chamberStart = world.tick;
      combatTicks = 0;
    }
    let alive = 0;
    for (const e of world.enemies) if (!e.dead) alive++;
    if (world.enemies.length > result.maxEnemies) result.maxEnemies = world.enemies.length;
    if (alive > WORLD.MAX_ENEMIES) result.maxEnemies = Math.max(result.maxEnemies, alive);
    if (world.projectiles.length > result.maxProjectiles) result.maxProjectiles = world.projectiles.length;
    if (world.tick % 15 === 0 && hasNaN(world)) { result.nan = true; break; }
  }
  result.chamberSeconds.push((world.tick - chamberStart) * TICK_DT);
  if (world.run.chamberKind === 'boss') result.bossSeconds = combatTicks * TICK_DT;
  result.phase = world.run.phase;
  result.ticks = world.tick;
  result.minutes = world.run.elapsed / 60;
  result.chamber = world.run.chamber;
  result.glimmer = world.run.rewards[0]?.glimmer ?? 0;
  for (const h of world.heroes) {
    result.damageTaken += h.damageTaken;
    result.damageDealt += h.run.damage;
    result.downs += h.run.downs;
    result.resonances += h.run.resonances;
  }
  result.nan = result.nan || hasNaN(world);
  return result;
}

export interface BalanceRow {
  label: string;
  runs: number;
  winRate: number;
  meanWinMinutes: number;
  meanChamber: number;
  meanDamageTaken: number;
  maxChamberSeconds: number;
  meanBossSeconds: number;
  meanDowns: number;
  meanResonances: number;
}

export function summarize(label: string, results: RunResult[]): BalanceRow {
  const wins = results.filter((r) => r.phase === 'victory');
  const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  return {
    label, runs: results.length, winRate: wins.length / Math.max(1, results.length),
    meanWinMinutes: mean(wins.map((r) => r.minutes)),
    meanChamber: mean(results.map((r) => r.chamber + (r.phase === 'victory' ? 1 : 0))),
    meanDamageTaken: mean(results.map((r) => r.damageTaken)),
    maxChamberSeconds: Math.max(0, ...results.flatMap((r) => r.chamberSeconds)),
    meanBossSeconds: mean(wins.map((r) => r.bossSeconds)),
    meanDowns: mean(results.map((r) => r.downs)),
    meanResonances: mean(results.map((r) => r.resonances)),
  };
}

export function formatTable(rows: BalanceRow[]): string {
  const head = 'party                 runs  win%  winMin  chamber  dmgTaken  maxChamberS  bossS  downs  reson';
  const lines = rows.map((r) =>
    `${r.label.padEnd(20)} ${String(r.runs).padStart(5)} ${(r.winRate * 100).toFixed(0).padStart(5)} ${r.meanWinMinutes.toFixed(1).padStart(7)} ${r.meanChamber.toFixed(1).padStart(8)} ${r.meanDamageTaken.toFixed(0).padStart(9)} ${r.maxChamberSeconds.toFixed(0).padStart(12)} ${r.meanBossSeconds.toFixed(0).padStart(6)} ${r.meanDowns.toFixed(1).padStart(6)} ${r.meanResonances.toFixed(0).padStart(6)}`);
  return [head, ...lines].join('\n');
}

/** Minimal input helper for scripted tests. */
export function input(seq: number, partial: Partial<InputCmd> = {}): InputCmd {
  return { seq, moveX: 0, moveZ: 0, aim: 0, aimDist: 0, buttons: 0, ...partial };
}

// ---------------------------------------------------------------------------------------------- scripted worlds

/** World in sandbox mode (no wave director) with the given heroes at their spawn points. */
export function sandbox(classes: ClassId[] = ['knight'], seed = 1): World {
  const world = new World();
  classes.forEach((cls, slot) => world.addPlayer(slot, cls, `H${slot}`));
  world.startSandbox(seed);
  return world;
}

/** Feeds one input per tick to a hero, keeping `seq` monotonic. */
export class Pad {
  seq = 0;
  private world: World;
  private slot: number;
  constructor(world: World, slot = 0) {
    this.world = world;
    this.slot = slot;
  }
  send(partial: Partial<InputCmd> = {}): void {
    this.world.applyInput(this.slot, input(++this.seq, partial));
  }
  /** Sends the same input for `ticks` ticks, stepping the world each time. Returns all events. */
  hold(partial: Partial<InputCmd>, ticks: number): GameEvent[] {
    const events: GameEvent[] = [];
    for (let i = 0; i < ticks; i++) {
      this.send(partial);
      this.world.step();
      events.push(...this.world.drainEvents());
    }
    return events;
  }
}

export function stepN(world: World, ticks: number): GameEvent[] {
  const events: GameEvent[] = [];
  for (let i = 0; i < ticks; i++) {
    world.step();
    events.push(...world.drainEvents());
  }
  return events;
}

export const seconds = (s: number): number => Math.round(s / TICK_DT);

/** A passive punching bag: spawned, past its spawn phase, permanently stunned, with plenty of health. */
export function dummy(world: World, x: number, z: number, kind: 'minion' | 'warrior' | 'archer' | 'mage' = 'minion', hp = 100000) {
  const e = world.spawnEnemy(kind, x, z);
  if (!e) throw new Error('enemy cap reached');
  e.spawnTime = 0;
  e.stunTime = 1e9;
  e.hp = hp;
  e.maxHp = hp;
  e.shieldHp = 0;
  world.drainEvents();
  return e;
}

/** A live enemy that skips its spawn animation. */
export function live(world: World, kind: Parameters<World['spawnEnemy']>[0], x: number, z: number, opts: Parameters<World['spawnEnemy']>[3] = {}) {
  const e = world.spawnEnemy(kind, x, z, opts);
  if (!e) throw new Error('enemy cap reached');
  e.spawnTime = 0;
  e.attackCd = 0;
  return e;
}

export function place(world: World, slot: number, x: number, z: number): void {
  const h = world.hero(slot);
  if (!h) throw new Error(`no hero in slot ${slot}`);
  h.body.x = x;
  h.body.z = z;
}

export const hits = (events: GameEvent[], target: 'p' | 'e', id?: number): Extract<GameEvent, { e: 'hit' }>[] =>
  events.filter((ev): ev is Extract<GameEvent, { e: 'hit' }> => ev.e === 'hit' && ev.target.t === target && (id === undefined || ev.target.id === id));

export const casts = (events: GameEvent[]): string[] =>
  events.filter((ev): ev is Extract<GameEvent, { e: 'cast' }> => ev.e === 'cast').map((ev) => ev.ability);

/** Clears the current chamber by force (heroes are made untouchable first). */
export function clearChamber(w: World): void {
  for (let guard = 0; guard < seconds(90) && w.run.phase === 'combat'; guard++) {
    for (const h of w.heroes) h.invuln = 1;
    for (const e of w.enemies) if (!e.dead && e.spawnTime <= 0) killEnemy(w, e, 0);
    w.step();
  }
}

/** Walks every living hero into the given door and waits for the commit. Returns the events. */
export function takeDoor(w: World, index: number): GameEvent[] {
  const door = w.getRunState().doors[index];
  if (!door) throw new Error(`no door ${index}`);
  for (const h of w.heroes) if (h.state === 'alive') { h.body.x = door.x; h.body.z = door.z; }
  const events: GameEvent[] = [];
  for (let guard = 0; guard < seconds(5) && w.run.phase === 'doors'; guard++) {
    w.step();
    events.push(...w.drainEvents());
  }
  return events;
}

/** Picks the first option for every hero that still has to draft. */
export function draftAll(w: World): void {
  for (const slot of w.getRunState().draftPending) w.pickBoon(slot, 0);
  w.step();
}
