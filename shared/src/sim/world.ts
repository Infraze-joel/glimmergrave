/**
 * The authoritative simulation of one room. The server steps it at exactly TICK_DT; everything that leaves it
 * is a contract type (SnapshotBody, SelfState, RunState, GameEvent, BoonOffer, BoonStack).
 */
import { NET, RUN } from '../constants.ts';
import { ULTIMATE } from '../data/classes.ts';
import type { SnapshotBody } from '../protocol.ts';
import {
  EF, PF,
  type BoonOffer, type BoonStack, type ClassId, type EnemyKind, type EnemySnap, type GameEvent, type InputCmd,
  type PlayerSnap, type ProjectileSnap, type RoomLayout, type RunState, type SelfState,
} from '../types.ts';
import { dashRechargeSeconds } from './abilities.ts';
import { maxDashCharges } from './boons.ts';
import {
  createDirector, enterChamber, finishRun, openAttunementDraft, pickBoon, planRun, rerollDraft, roomSpawns, stepDirector,
  type DirectorState, type RunOverrides,
} from './director.ts';
import { spawnEnemy, stepEnemy, type SpawnOpts } from './enemies.ts';
import { stepHazards } from './hazardFx.ts';
import { refreshDomes } from './horde.ts';
import { isSpecial } from './objectives.ts';
import { noMetaLevels } from './meta.ts';
import { META } from './tuning.ts';
import { sanctuaryHolds, stepBlasts, stepZones } from './zones.ts';
import { startTutorial, type TutorialRun } from './tutorial.ts';
import { CLASSES } from '../data/classes.ts';
import { createHero, placeHero, queueInput, resetHero, stepHero, stepHeroInteractions } from './players.ts';
import { stepProjectiles } from './projectiles.ts';
import { Rng } from './rng.ts';
import type { Enemy, Hero, HeroBuild, PendingBlast, Projectile, Zone } from './state.ts';
import { DIRECTOR, SIM } from './tuning.ts';

const LOBBY_ROOM_W = 30;
const LOBBY_ROOM_D = 24;

const lobbyRoom = (): RoomLayout => ({
  seed: 0, biome: 'crypt', w: LOBBY_ROOM_W, d: LOBBY_ROOM_D, obstacles: [], hazards: [], spawns: roomSpawns(LOBBY_ROOM_D),
});

/** `stats`, `room` and `traits` are derived from the heroes, the room and the living enemies when the state is published. */
type RunCore = Omit<RunState, 'stats' | 'room' | 'traits'>;

const freshRun = (): RunCore => ({
  phase: 'lobby', oath: 0, chamber: 0, chamberKind: 'combat', entered: 'boon', wave: 0, waveCount: 0, doors: [],
  doorProgress: [], bossId: -1, draftPending: [], draftTime: 0, elapsed: 0, secondWinds: 0,
  // `finalBoss` only means something once a run has started (it is drawn from the run seed).
  bossKind: null, finalBoss: 'regent', rewards: [], depth: 0, cleared: 0, chambersCleared: 0, objective: null, objectivesDone: 0, objectiveBonuses: 0, tutorial: null,
});

/** Mixed into the run seed for the generator that only rolls relic shards. */
const LOOT_SEED_SALT = 0x9e3779b9;

export class World {
  tick = 0;
  rng = new Rng(1);
  /** Sorted by slot. */
  heroes: Hero[] = [];
  enemies: Enemy[] = [];
  projectiles: Projectile[] = [];
  /** Lasting ground effects of hero abilities, and delayed hostile explosions (volatile affix). */
  zones: Zone[] = [];
  blasts: PendingBlast[] = [];
  /** Relic shard rolls have their own seeded stream, so loot never changes how a fight plays out. */
  lootRng = new Rng(1);
  room: RoomLayout = lobbyRoom();
  run: RunCore = freshRun();
  director: DirectorState = createDirector();
  /** Increments on every structural change of the run state (phase, chamber, wave, doors, draft, boss). */
  runVersion = 0;
  /** Increments whenever any hero's boons change. */
  boonVersion = 0;
  /** Increments whenever a hero's draft offers change without a pick (rerolls). */
  draftVersion = 0;
  /** Script state of a training session, or null in a normal run. */
  tutorial: TutorialRun | null = null;
  /** Hazard bookkeeping (see hazardFx.ts): phase code and active-tick counter per hazard of `hazardRoom`. */
  hazardPhase: number[] = [];
  hazardTicks: number[] = [];
  hazardRoom: RoomLayout | null = null;
  /** Number of hazards that are warning or active this tick. */
  hazardsLive = 0;
  /** Fragile hostile projectiles (soul wisps) alive at the start of this tick's projectile step. */
  fragileCount = 0;
  nextEnemyId = 1;
  nextProjectileId = 1;
  nextZoneId = 1;
  /** Elites and champions of this chamber carry an affix; number of affixed enemies spawned in it so far. */
  affixed = false;
  affixes = 0;
  /** Enemy scaling of the current chamber. */
  hpMul = 1;
  damageMul = 1;
  speedMul = 1;
  partySize = 1;
  cursed = false;
  /** Melee windups currently aimed at each slot (attack tokens). */
  meleeWindups: number[] = [0, 0, 0, 0];
  private events: GameEvent[] = [];

  // ------------------------------------------------------------------ roster

  hero(slot: number): Hero | undefined {
    for (const h of this.heroes) if (h.slot === slot) return h;
    return undefined;
  }

  /**
   * Adds a hero. Only possible in the lobby; returns false for an invalid or taken slot or during a run.
   * `loadout` is the hero's permanent build: a (partial) Loadout or just the upgrade levels (Loadout.meta).
   * Everything in it is clamped here again (art and talents by mastery, relics by slots, ranks by maximum).
   */
  addPlayer(slot: number, cls: ClassId, name: string, loadout?: unknown): boolean {
    if (this.run.phase !== 'lobby' || !Number.isInteger(slot) || slot < 0 || slot >= NET.MAX_PLAYERS) return false;
    if (this.hero(slot) || !(cls in CLASSES)) return false;
    this.heroes.push(createHero(slot, cls, name, loadout));
    this.heroes.sort((a, b) => a.slot - b.slot);
    return true;
  }

  private replaceHero(h: Hero, cls: ClassId, loadout: unknown): void {
    const fresh = createHero(h.slot, cls, h.name, loadout);
    fresh.connected = h.connected;
    this.heroes[this.heroes.indexOf(h)] = fresh;
  }

  /** Replaces a hero's permanent upgrade levels and keeps the rest of the build (lobby only). */
  setMeta(slot: number, meta: readonly number[]): boolean {
    const h = this.hero(slot);
    if (!h || this.run.phase !== 'lobby') return false;
    this.replaceHero(h, h.cls, { ...h.build, meta });
    return true;
  }

  /** Replaces a hero's whole build (lobby only). */
  setLoadout(slot: number, loadout: unknown): boolean {
    const h = this.hero(slot);
    if (!h || this.run.phase !== 'lobby') return false;
    this.replaceHero(h, h.cls, loadout);
    return true;
  }

  getMeta(slot: number): number[] {
    const h = this.hero(slot);
    return h ? [...h.metaLevels] : noMetaLevels();
  }

  /** The hero's sanitised build (what the simulation actually applies), or null. */
  getBuild(slot: number): HeroBuild | null {
    const h = this.hero(slot);
    return h ? { ...h.build, meta: [...h.build.meta], paragon: [...h.build.paragon], talents: [...h.build.talents], relics: h.build.relics.map((r) => ({ ...r })) } : null;
  }

  /**
   * Changes a hero's class (lobby only). Mastery, art and talents belong to a class: without a `loadout` for the
   * new class they fall back to level 1 / none, while upgrades, Ascension ranks and relics are kept.
   */
  setClass(slot: number, cls: ClassId, loadout?: unknown): boolean {
    const h = this.hero(slot);
    if (!h || this.run.phase !== 'lobby' || !(cls in CLASSES)) return false;
    this.replaceHero(h, cls, loadout ?? (cls === h.cls ? h.build : { meta: h.build.meta, paragon: h.build.paragon, relics: h.build.relics }));
    return true;
  }

  removePlayer(slot: number): void {
    const h = this.hero(slot);
    if (!h) return;
    this.heroes.splice(this.heroes.indexOf(h), 1);
    const pending = this.run.draftPending.indexOf(slot);
    if (pending >= 0) this.run.draftPending.splice(pending, 1);
    for (const e of this.enemies) if (e.target === slot) e.target = -1;
    this.runVersion++;
    this.checkDefeat();
  }

  /**
   * Disconnected heroes stand still, cannot be hurt or targeted and do not block drafts or doors.
   * Reconnecting clears the input queue and restarts `ackSeq` at 0 (a reloaded client restarts its sequence).
   */
  setConnected(slot: number, connected: boolean): void {
    const h = this.hero(slot);
    if (!h || h.connected === connected) return;
    h.connected = connected;
    h.queue.length = 0;
    h.input = { ...h.input, moveX: 0, moveZ: 0, buttons: 0, seq: 0 };
    h.prevButtons = 0;
    h.ackSeq = 0;
    h.body.dashTime = 0;
    this.runVersion++;
    if (!connected) this.checkDefeat();
  }

  applyInput(slot: number, cmd: InputCmd): void {
    const h = this.hero(slot);
    if (h && h.connected) queueInput(h, cmd);
  }

  // ------------------------------------------------------------------ run lifecycle

  /**
   * Starts a run with the current roster. Deterministic for a given seed and input stream: the final boss, the
   * herald and the biome order are drawn from the seed first (`overrides` pins them for tests and tools).
   * `startChamber` > 0 is a QA aid (server option `debugStartChamber`): the run begins in a later chamber.
   * Heroes with the attunement upgrade get their infusion draft before anything spawns (phase `draft`).
   */
  start(oath: number, seed: number, startChamber = 0, overrides: RunOverrides = {}): boolean {
    if (this.run.phase !== 'lobby' || this.heroes.length === 0) return false;
    this.beginRun(oath, seed);
    planRun(this, overrides);
    const last = RUN.CHAMBERS.length - 1;
    const index = Math.max(0, Math.min(last, Math.floor(startChamber)));
    enterChamber(this, index, index === last ? 'boss' : 'boon', overrides.objective);
    openAttunementDraft(this);
    return true;
  }

  /**
   * Starts the guided training session (data/tutorial.ts) for the single hero on the roster. Permanent upgrades
   * do not apply in it. Ends in `victory` with the fixed tutorial reward once the last step is done.
   */
  startTutorial(seed: number): boolean {
    if (this.run.phase !== 'lobby' || this.heroes.length !== 1) return false;
    const h = this.heroes[0] as Hero;
    // Training heroes are plain: no upgrades, Ascension, mastery, talents or relics.
    const plain = createHero(h.slot, h.cls, h.name);
    plain.connected = h.connected;
    this.heroes[0] = plain;
    this.beginRun(0, seed);
    this.run.secondWinds = 0;
    startTutorial(this, seed);
    return true;
  }

  /**
   * Test / tooling entry: starts a run in an empty arena without the wave director.
   * Spawn enemies with `spawnEnemy` and drive heroes with `applyInput`.
   */
  startSandbox(seed = 1, room?: RoomLayout): void {
    this.beginRun(0, seed);
    this.director.manual = true;
    this.run.phase = 'combat';
    this.room = room ?? { seed, biome: 'crypt', w: DIRECTOR.BOSS_ROOM_W, d: DIRECTOR.BOSS_ROOM_D, obstacles: [], hazards: [], spawns: roomSpawns(DIRECTOR.BOSS_ROOM_D) };
    this.partySize = Math.max(1, this.heroes.length);
    for (const h of this.heroes) {
      const spawn = this.room.spawns[h.slot % this.room.spawns.length] as { x: number; z: number };
      placeHero(h, spawn.x, spawn.z);
    }
    this.runVersion++;
  }

  private beginRun(oath: number, seed: number): void {
    this.clearEntities();
    this.rng = new Rng(seed);
    this.tick = 0;
    this.run = freshRun();
    this.lootRng = new Rng((seed ^ LOOT_SEED_SALT) >>> 0);
    this.run.oath = Math.max(0, Math.min(RUN.OATH_MAX, Math.floor(Number.isFinite(oath) ? oath : 0)));
    const solo = this.heroes.length === 1 ? this.heroes[0] : undefined;
    this.run.secondWinds = solo ? RUN.SOLO_SECOND_WINDS + (solo.meta.tenacity ? META.TENACITY_SECOND_WINDS : 0) : 0;
    this.director = createDirector();
    this.tutorial = null;
    for (const h of this.heroes) resetHero(h);
    this.boonVersion++;
  }

  /** Back to the lobby: entities, boons and run state are wiped; the roster stays. */
  reset(): void {
    this.clearEntities();
    this.run = freshRun();
    this.director = createDirector();
    this.tutorial = null;
    this.room = lobbyRoom();
    this.tick = 0;
    for (const h of this.heroes) resetHero(h);
    this.runVersion++;
    this.boonVersion++;
  }

  private clearEntities(): void {
    this.enemies.length = 0;
    this.projectiles.length = 0;
    this.zones.length = 0;
    this.blasts.length = 0;
    this.events.length = 0;
    this.nextEnemyId = 1;
    this.nextProjectileId = 1;
    this.nextZoneId = 1;
    this.affixed = false;
    this.affixes = 0;
    this.hpMul = 1;
    this.damageMul = 1;
    this.speedMul = 1;
    this.cursed = false;
    this.hazardRoom = null;
    this.hazardsLive = 0;
    this.fragileCount = 0;
  }

  /**
   * True while the current objective changes continuously (timers, brazier and vault progress, shard health), so
   * whoever publishes the run state should keep re-sending it during combat (the server does, ~4x per second).
   */
  get objectiveLive(): boolean {
    const o = this.run.objective;
    return this.run.phase === 'combat' && o !== null && o.status === 'active' && isSpecial(o.kind);
  }

  /** Is the simulation waiting because nobody is connected (or no run is active)? */
  get paused(): boolean {
    if (this.run.phase === 'lobby') return true;
    for (const h of this.heroes) if (h.connected) return false;
    return true;
  }

  /** Advances the world by exactly one tick (TICK_DT). */
  step(): void {
    if (this.paused) return;
    this.tick++;
    const phase = this.run.phase;
    for (const h of this.heroes) stepHero(this, h);
    stepHeroInteractions(this);
    if (this.room.hazards.length > 0) stepHazards(this);
    if (phase === 'combat') {
      const counts = this.meleeWindups;
      counts.fill(0);
      for (const e of this.enemies) {
        const a = e.attack;
        if (a && a.type === 'melee' && a.target >= 0 && a.target < counts.length) counts[a.target] = (counts[a.target] as number) + 1;
      }
      // Summons appended during the loop start acting next tick.
      const n = this.enemies.length;
      for (let i = 0; i < n; i++) stepEnemy(this, this.enemies[i] as Enemy);
      refreshDomes(this);
      stepProjectiles(this);
      stepZones(this);
      if (this.blasts.length > 0) stepBlasts(this);
    }
    stepDirector(this);
    if (this.run.phase === 'combat') this.checkDefeat();
    this.sweep();
  }

  private checkDefeat(): void {
    if (this.run.phase !== 'combat' || this.director.manual) return;
    let connected = 0;
    for (const h of this.heroes) {
      if (!h.connected) continue;
      connected++;
      if (h.state === 'alive' || h.secondWindTimer > 0) return;
      // A fallen hero inside a sanctuary is about to be raised.
      if (this.zones.length > 0 && sanctuaryHolds(this, h)) return;
    }
    // With nobody connected the world is merely paused; the run is lost only when every present hero is down.
    if (connected === 0 && this.heroes.length > 0) return;
    finishRun(this, 'defeat');
  }

  private sweep(): void {
    const enemies = this.enemies;
    let keep = 0;
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i] as Enemy;
      if (e.dead && e.corpseTime <= 0) continue;
      enemies[keep++] = e;
    }
    enemies.length = keep;
    const projectiles = this.projectiles;
    keep = 0;
    for (let i = 0; i < projectiles.length; i++) {
      const p = projectiles[i] as Projectile;
      if (p.dead) continue;
      projectiles[keep++] = p;
    }
    projectiles.length = keep;
  }

  // ------------------------------------------------------------------ drafts

  getDraft(slot: number): BoonOffer[] {
    const h = this.hero(slot);
    return h && this.run.phase === 'draft' ? h.draft.map((o) => ({ id: o.id, level: o.level })) : [];
  }

  getBoons(slot: number): BoonStack[] {
    const h = this.hero(slot);
    return h ? h.boons.map((b) => ({ id: b.id, level: b.level })) : [];
  }

  pickBoon(slot: number, index: number): boolean {
    const h = this.hero(slot);
    if (!h || !Number.isInteger(index)) return false;
    return pickBoon(this, h, index);
  }

  /** Draft rerolls the hero has left this run (insight upgrade). */
  getRerolls(slot: number): number {
    const h = this.hero(slot);
    return h ? h.rerolls : 0;
  }

  /** Spends a reroll: replaces the hero's current draft offers. False if there is nothing to reroll or none left. */
  rerollDraft(slot: number): boolean {
    const h = this.hero(slot);
    return h ? rerollDraft(this, h) : false;
  }

  // ------------------------------------------------------------------ output

  emit(ev: GameEvent): void {
    this.events.push(ev);
  }

  /** Returns and clears the events emitted since the last call. */
  drainEvents(): GameEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  getRunState(): RunState {
    const run = this.run;
    return {
      ...run,
      doors: run.doors.map((d) => ({ ...d })),
      doorProgress: [...run.doorProgress],
      draftPending: [...run.draftPending],
      rewards: run.rewards.map((r) => ({ ...r, relics: [...r.relics] })),
      objective: run.objective ? {
        ...run.objective, anchor: run.objective.anchor ? { ...run.objective.anchor } : null,
        sites: run.objective.sites.map((site) => ({ ...site })), targets: [...run.objective.targets],
      } : null,
      tutorial: run.tutorial ? { ...run.tutorial, marker: run.tutorial.marker ? { ...run.tutorial.marker } : null } : null,
      room: run.phase === 'lobby' ? null : this.room,
      traits: this.getTraits(),
      stats: this.heroes.map((h) => ({ ...h.run, damage: Math.round(h.run.damage) })),
    };
  }

  /**
   * Wards, affixes and necromancer links of the enemies alive right now (RunState.traits), in spawn order. Built
   * on demand from the living enemies, so every published run state — the one a (re)joining client receives
   * included — is current, and nothing has to be tracked or re-sent when an enemy rises or falls.
   */
  getTraits(): RunState['traits'] {
    const out: RunState['traits'] = [];
    for (const e of this.enemies) {
      if (e.dead || (e.ward === null && e.affix === null && e.master < 0)) continue;
      const trait: RunState['traits'][number] = { id: e.id };
      if (e.ward !== null) trait.ward = e.ward;
      if (e.affix !== null) trait.affix = e.affix;
      if (e.master >= 0) trait.raisedBy = e.master;
      out.push(trait);
    }
    return out;
  }

  getSelfState(slot: number): SelfState {
    const h = this.hero(slot);
    if (!h) return { ackSeq: 0, x: 0, z: 0, dashTime: 0, dashDirX: 0, dashDirZ: 0, rootTime: 0, moveSpeed: 0 };
    const b = h.body;
    return { ackSeq: h.ackSeq, x: b.x, z: b.z, dashTime: b.dashTime, dashDirX: b.dashDirX, dashDirZ: b.dashDirZ, rootTime: b.rootTime, moveSpeed: b.moveSpeed };
  }

  getSnapshotBody(): SnapshotBody {
    const players: PlayerSnap[] = [];
    for (const h of this.heroes) {
      const maxCharges = maxDashCharges(h);
      let flags = 0;
      if (h.connected) flags |= PF.CONNECTED;
      if (h.invuln > SIM.EPS || !h.connected) flags |= PF.INVULNERABLE;
      if (h.state === 'downed' && h.revive > 0) flags |= PF.BEING_REVIVED;
      if (h.inDoor) flags |= PF.IN_DOOR_ZONE;
      if (h.aura > 0) flags |= PF.KINDRED_AURA;
      players.push({
        slot: h.slot, x: h.body.x, z: h.body.z, rot: h.rot, hp: Math.max(0, h.state === 'alive' ? Math.max(1, h.hp) : 0), maxHp: h.maxHp,
        shield: h.barrier + h.tempShield, state: h.state, anim: h.anim, animSeq: h.animSeq & 0xff,
        cdSecondary: h.secondaryCdMax > 0 ? Math.min(1, h.secondaryCd / h.secondaryCdMax) : 0,
        cdDash: h.dashCharges >= maxCharges ? 0 : Math.min(1, h.dashRecharge / dashRechargeSeconds(h)),
        ult: Math.min(1, h.ult / ULTIMATE.MAX), dashCharges: h.dashCharges, revive: Math.min(1, h.revive), flags,
      });
    }
    const enemies: EnemySnap[] = [];
    for (const e of this.enemies) {
      let flags = 0;
      if (e.elite) flags |= EF.ELITE;
      if (e.status === 'ember') flags |= EF.BURN;
      else if (e.status === 'rime') flags |= EF.CHILL;
      else if (e.status === 'storm') flags |= EF.SHOCK;
      else if (e.status === 'umbra') flags |= EF.WITHER;
      if (e.stunTime > 0) flags |= EF.STUNNED;
      if (e.shieldHp > 0) flags |= EF.SHIELDED;
      if ((e.boss && e.boss.phase >= 3) || e.enraged) flags |= EF.ENRAGED;
      enemies.push({
        id: e.id, kind: e.kind, x: e.x, z: e.z, rot: e.rot, hp: e.dead ? 0 : Math.max(0, e.hp / e.maxHp), anim: e.anim,
        animSeq: e.animSeq & 0xff, flags,
      });
    }
    const projectiles: ProjectileSnap[] = [];
    for (const p of this.projectiles) {
      projectiles.push({ id: p.id, kind: p.kind, x: p.x, z: p.z, rot: p.rot, element: p.element, hostile: p.hostile });
    }
    return { tick: this.tick, players, enemies, projectiles };
  }

  // ------------------------------------------------------------------ tooling

  /** Spawns an enemy directly (tests, sandbox). Returns null at the enemy cap. */
  spawnEnemy(kind: EnemyKind, x: number, z: number, opts: SpawnOpts = {}): Enemy | null {
    return spawnEnemy(this, kind, x, z, opts);
  }
}
