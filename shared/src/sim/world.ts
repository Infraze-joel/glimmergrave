/**
 * The authoritative simulation of one room. The server steps it at exactly TICK_DT; everything that leaves it
 * is a contract type (SnapshotBody, SelfState, RunState, GameEvent, BoonOffer, BoonStack).
 */
import { NET, RUN } from '../constants.ts';
import type { SnapshotBody } from '../protocol.ts';
import {
  EF, PF,
  type BoonOffer, type BoonStack, type ClassId, type EnemyKind, type EnemySnap, type GameEvent, type InputCmd,
  type PlayerSnap, type ProjectileSnap, type RoomLayout, type RunState, type SelfState,
} from '../types.ts';
import { dashRechargeSeconds } from './abilities.ts';
import { maxDashCharges } from './boons.ts';
import { createDirector, enterChamber, pickBoon, roomSpawns, stepDirector, type DirectorState } from './director.ts';
import { spawnEnemy, stepEnemy, type SpawnOpts } from './enemies.ts';
import { CLASSES } from '../data/classes.ts';
import { createHero, placeHero, queueInput, resetHero, stepHero, stepHeroInteractions } from './players.ts';
import { stepProjectiles } from './projectiles.ts';
import { Rng } from './rng.ts';
import type { Enemy, Hero, Projectile } from './state.ts';
import { DIRECTOR, SIM } from './tuning.ts';

const LOBBY_ROOM_W = 30;
const LOBBY_ROOM_D = 24;

const lobbyRoom = (): RoomLayout => ({ seed: 0, w: LOBBY_ROOM_W, d: LOBBY_ROOM_D, obstacles: [], spawns: roomSpawns(LOBBY_ROOM_D) });

type RunCore = Omit<RunState, 'stats' | 'room'>;

const freshRun = (): RunCore => ({
  phase: 'lobby', oath: 0, chamber: 0, chamberKind: 'combat', entered: 'boon', wave: 0, waveCount: 0, doors: [],
  doorProgress: [], bossId: -1, draftPending: [], draftTime: 0, elapsed: 0, secondWinds: 0,
});

export class World {
  tick = 0;
  rng = new Rng(1);
  /** Sorted by slot. */
  heroes: Hero[] = [];
  enemies: Enemy[] = [];
  projectiles: Projectile[] = [];
  room: RoomLayout = lobbyRoom();
  run: RunCore = freshRun();
  director: DirectorState = createDirector();
  /** Increments on every structural change of the run state (phase, chamber, wave, doors, draft, boss). */
  runVersion = 0;
  /** Increments whenever any hero's boons change. */
  boonVersion = 0;
  nextEnemyId = 1;
  nextProjectileId = 1;
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

  /** Adds a hero. Only possible in the lobby; returns false for an invalid or taken slot or during a run. */
  addPlayer(slot: number, cls: ClassId, name: string): boolean {
    if (this.run.phase !== 'lobby' || !Number.isInteger(slot) || slot < 0 || slot >= NET.MAX_PLAYERS) return false;
    if (this.hero(slot) || !(cls in CLASSES)) return false;
    this.heroes.push(createHero(slot, cls, name));
    this.heroes.sort((a, b) => a.slot - b.slot);
    return true;
  }

  /** Changes a hero's class (lobby only). */
  setClass(slot: number, cls: ClassId): boolean {
    const h = this.hero(slot);
    if (!h || this.run.phase !== 'lobby' || !(cls in CLASSES)) return false;
    const fresh = createHero(slot, cls, h.name);
    fresh.connected = h.connected;
    this.heroes[this.heroes.indexOf(h)] = fresh;
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

  /** Starts a run with the current roster. Deterministic for a given seed and input stream. */
  start(oath: number, seed: number): boolean {
    if (this.run.phase !== 'lobby' || this.heroes.length === 0) return false;
    this.beginRun(oath, seed);
    enterChamber(this, 0, 'boon');
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
    this.room = room ?? { seed, w: DIRECTOR.BOSS_ROOM_W, d: DIRECTOR.BOSS_ROOM_D, obstacles: [], spawns: roomSpawns(DIRECTOR.BOSS_ROOM_D) };
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
    this.run.oath = Math.max(0, Math.min(RUN.OATH.length - 1, Math.floor(Number.isFinite(oath) ? oath : 0)));
    this.run.secondWinds = this.heroes.length === 1 ? RUN.SOLO_SECOND_WINDS : 0;
    this.director = createDirector();
    for (const h of this.heroes) resetHero(h);
    this.boonVersion++;
  }

  /** Back to the lobby: entities, boons and run state are wiped; the roster stays. */
  reset(): void {
    this.clearEntities();
    this.run = freshRun();
    this.director = createDirector();
    this.room = lobbyRoom();
    this.tick = 0;
    for (const h of this.heroes) resetHero(h);
    this.runVersion++;
    this.boonVersion++;
  }

  private clearEntities(): void {
    this.enemies.length = 0;
    this.projectiles.length = 0;
    this.events.length = 0;
    this.nextEnemyId = 1;
    this.nextProjectileId = 1;
    this.hpMul = 1;
    this.damageMul = 1;
    this.speedMul = 1;
    this.cursed = false;
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
      stepProjectiles(this);
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
    }
    // With nobody connected the world is merely paused; the run is lost only when every present hero is down.
    if (connected === 0 && this.heroes.length > 0) return;
    this.run.phase = 'defeat';
    this.projectiles.length = 0;
    this.runVersion++;
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
      room: run.phase === 'lobby' ? null : this.room,
      stats: this.heroes.map((h) => ({ ...h.run, damage: Math.round(h.run.damage) })),
    };
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
        dashCharges: h.dashCharges, revive: Math.min(1, h.revive), flags,
      });
    }
    const enemies: EnemySnap[] = [];
    for (const e of this.enemies) {
      let flags = 0;
      if (e.elite) flags |= EF.ELITE;
      if (e.status === 'ember') flags |= EF.BURN;
      else if (e.status === 'rime') flags |= EF.CHILL;
      else if (e.status === 'storm') flags |= EF.SHOCK;
      if (e.stunTime > 0) flags |= EF.STUNNED;
      if (e.shieldHp > 0) flags |= EF.SHIELDED;
      if (e.boss && e.boss.phase >= 3) flags |= EF.ENRAGED;
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
