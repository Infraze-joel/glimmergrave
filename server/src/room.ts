/** One game room: lobby, sessions (slots), host, and the 30 Hz authoritative tick loop while a run is active. */
import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { NET, TICK_DT } from '../../shared/src/constants.ts';
import { encodeSnapshot, encodeSnapshotBody, type ClientMsg, type ErrorCode, type ServerMsg } from '../../shared/src/protocol.ts';
import { World } from '../../shared/src/sim/index.ts';
import type { ClassId, InputCmd, Loadout, Look, ObjectiveKind, RosterEntry } from '../../shared/src/types.ts';
import { SERVER } from './config.ts';
import type { Logger } from './log.ts';

/** What a room needs from a socket. Implemented by the connection wrapper in server.ts. */
export interface Peer {
  readonly id: number;
  sendJson(msg: ServerMsg): void;
  sendBinary(data: Uint8Array): void;
  /** True while the socket's send queue is too long for droppable traffic. */
  congested(): boolean;
}

export interface Session {
  slot: number;
  name: string;
  cls: ClassId;
  /** Cosmetic appearance (already sanitised); shown to everyone on the roster. */
  look: Look;
  /** Mastery level and secondary variant as the simulation applies them (clamped); shown on the roster. */
  mastery: number;
  art: number;
  /** Relics equipped and talents chosen, counted from the build the simulation applies (lobby cards). */
  relics: number;
  talents: number;
  ready: boolean;
  /** Secret for rejoining this slot. Never logged, never sent to anyone but its owner. */
  token: string;
  peer: Peer | null;
  disconnectedAt: number;
  /** Signature of the draft message (options + rerolls left) last sent to this player. */
  draftSig: string;
}

export interface RoomOptions {
  rejoinGraceMs: number;
  emptyRoomTtlMs: number;
  idleRoomTtlMs: number;
  /** >1 runs the simulation faster than real time (tests and soaks only). */
  timeScale: number;
  /** QA aid: runs start in this chamber (0 = normal). */
  debugStartChamber: number;
  /** QA aid: objective pinned to the first door of every choice (undefined = normal). */
  debugObjective?: ObjectiveKind;
  /** Fixed run seed (tests); random when undefined. */
  seed?: number;
  log: Logger;
  now: () => number;
}

export type JoinResult = { ok: true; session: Session } | { ok: false; code: ErrorCode };

const EMPTY_DRAFT = '';

function tokensEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export class Room {
  readonly code: string;
  readonly world = new World();
  private sessions: (Session | null)[] = Array.from({ length: NET.MAX_PLAYERS }, () => null);
  private hostSlot = -1;
  private oath = 0;
  private opts: RoomOptions;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private nextTickAt = 0;
  private lastRunVersion = -1;
  private lastBoonVersion = -1;
  private ticksSinceRun = 0;
  private endedAt = 0;
  private lastActivity: number;
  private emptySince: number;
  private destroyed = false;
  /** Tick loop statistics (diagnostics / tests). */
  ticks = 0;
  droppedBacklogs = 0;

  /** A training session: one player, starts at once, cannot be joined and never returns to a lobby. */
  readonly tutorial: boolean;

  constructor(code: string, opts: RoomOptions, tutorial = false) {
    this.code = code;
    this.opts = opts;
    this.tutorial = tutorial;
    this.lastActivity = opts.now();
    this.emptySince = opts.now();
  }

  // ------------------------------------------------------------------ queries

  get phase(): string {
    return this.world.run.phase;
  }

  get playerCount(): number {
    let n = 0;
    for (const s of this.sessions) if (s) n++;
    return n;
  }

  get connectedCount(): number {
    let n = 0;
    for (const s of this.sessions) if (s && s.peer) n++;
    return n;
  }

  get host(): number {
    return this.hostSlot;
  }

  private roster(): RosterEntry[] {
    const out: RosterEntry[] = [];
    for (const s of this.sessions) {
      if (!s) continue;
      out.push({
        slot: s.slot, name: s.name, cls: s.cls, look: { ...s.look }, mastery: s.mastery, art: s.art, relics: s.relics, talents: s.talents,
        ready: s.ready, connected: s.peer !== null,
        host: s.slot === this.hostSlot,
        boons: this.world.getBoons(s.slot),
      });
    }
    return out;
  }

  // ------------------------------------------------------------------ sending

  private broadcast(msg: ServerMsg): void {
    for (const s of this.sessions) if (s && s.peer) s.peer.sendJson(msg);
  }

  private broadcastRoster(): void {
    this.lastBoonVersion = this.world.boonVersion;
    this.broadcast({ t: 'roster', players: this.roster(), oath: this.oath });
  }

  private broadcastRun(): void {
    this.lastRunVersion = this.world.runVersion;
    this.ticksSinceRun = 0;
    this.broadcast({ t: 'run', state: this.world.getRunState() });
  }

  /** Sends one player their private draft: current options ([] = nothing to pick) and rerolls left this run. */
  private sendDraft(s: Session, force: boolean): void {
    if (!s.peer) return;
    const options = this.world.getDraft(s.slot);
    const rerolls = this.world.getRerolls(s.slot);
    const sig = `${rerolls}:${JSON.stringify(options)}`;
    if (!force && sig === s.draftSig) return;
    s.draftSig = sig;
    s.peer.sendJson({ t: 'draft', options, rerolls });
  }

  /** Sends each player their private draft whenever it changed (new offers, a pick, a reroll). */
  private syncDrafts(force = false): void {
    for (const s of this.sessions) if (s) this.sendDraft(s, force);
  }

  /** Full state for a peer that just (re)joined: welcome, roster, run, draft. */
  private sendState(s: Session): void {
    if (!s.peer) return;
    s.peer.sendJson({ t: 'welcome', code: this.code, slot: s.slot, token: s.token });
    s.peer.sendJson({ t: 'roster', players: this.roster(), oath: this.oath });
    s.peer.sendJson({ t: 'run', state: this.world.getRunState() });
    this.sendDraft(s, true);
  }

  // ------------------------------------------------------------------ membership

  private touch(): void {
    this.lastActivity = this.opts.now();
  }

  /** The host must be a connected player; otherwise the lowest connected slot takes over. */
  private ensureHost(): boolean {
    const current = this.sessions[this.hostSlot];
    if (current && current.peer) return false;
    for (const s of this.sessions) {
      if (s && s.peer) {
        const changed = this.hostSlot !== s.slot;
        this.hostSlot = s.slot;
        if (changed) this.opts.log('info', 'host_changed', { room: this.code, slot: s.slot });
        return changed;
      }
    }
    return false;
  }

  private updateEmpty(): void {
    if (this.connectedCount > 0) this.emptySince = 0;
    else if (this.emptySince === 0) this.emptySince = this.opts.now();
  }

  /** Copies what the simulation made of the loadout (after its own clamping) into the session for the roster. */
  private adoptBuild(session: Session): void {
    const build = this.world.getBuild(session.slot);
    session.mastery = build ? build.mastery : 1;
    session.art = build ? build.art : 0;
    session.relics = build ? build.relics.length : 0;
    // A talent tier without a choice is 0.
    session.talents = build ? build.talents.filter((t) => t > 0).length : 0;
  }

  /**
   * `loadout` must already be sanitised (parseClientMsg does that); the simulation clamps everything again.
   * In a tutorial room the first join starts the training session at once and nobody else can ever join.
   */
  join(peer: Peer, name: string, cls: ClassId, loadout: Loadout): JoinResult {
    if (this.phase !== 'lobby' || (this.tutorial && this.playerCount > 0)) return { ok: false, code: 'run_in_progress' };
    const slot = this.sessions.findIndex((s) => s === null);
    if (slot < 0) return { ok: false, code: 'room_full' };
    if (!this.world.addPlayer(slot, cls, name, loadout)) return { ok: false, code: 'room_full' };
    const session: Session = {
      slot, name, cls, look: { ...loadout.look }, mastery: 1, art: 0, relics: 0, talents: 0, ready: false, token: randomBytes(SERVER.TOKEN_BYTES).toString('hex'), peer,
      disconnectedAt: 0, draftSig: EMPTY_DRAFT,
    };
    this.adoptBuild(session);
    this.sessions[slot] = session;
    this.touch();
    this.updateEmpty();
    this.ensureHost();
    this.opts.log('info', 'join', { room: this.code, slot, name, cls, players: this.playerCount, tutorial: this.tutorial });
    if (this.tutorial) {
      if (!this.world.startTutorial(this.opts.seed ?? randomInt(1, 0x7fffffff))) {
        this.sessions[slot] = null;
        this.world.removePlayer(slot);
        return { ok: false, code: 'server_full' };
      }
      // Training heroes are plain (no mastery, no art): show what the simulation really uses.
      this.adoptBuild(session);
      this.endedAt = 0;
      this.sendState(session);
      this.lastRunVersion = this.world.runVersion;
      this.lastBoonVersion = this.world.boonVersion;
      this.startLoop();
      return { ok: true, session };
    }
    this.sendState(session);
    this.broadcastRoster();
    return { ok: true, session };
  }

  /** Resume a slot with its token. A still-open old socket of that slot is returned so the caller can close it. */
  rejoin(peer: Peer, token: string): JoinResult & { replaced?: Peer } {
    const session = this.sessions.find((s) => s !== null && tokensEqual(s.token, token)) ?? null;
    if (!session) return { ok: false, code: 'session_expired' };
    const replaced = session.peer ?? undefined;
    session.peer = peer;
    session.disconnectedAt = 0;
    this.world.setConnected(session.slot, true);
    this.touch();
    this.updateEmpty();
    this.ensureHost();
    this.opts.log('info', 'rejoin', { room: this.code, slot: session.slot });
    this.sendState(session);
    this.broadcastRoster();
    return { ok: true, session, replaced };
  }

  /** The socket went away: keep the slot for the grace period. */
  disconnect(session: Session, peer: Peer): void {
    if (session.peer !== peer || this.sessions[session.slot] !== session) return;
    session.peer = null;
    session.disconnectedAt = this.opts.now();
    this.world.setConnected(session.slot, false);
    this.opts.log('info', 'disconnect', { room: this.code, slot: session.slot });
    this.updateEmpty();
    this.ensureHost();
    this.broadcastRoster();
    if (this.world.runVersion !== this.lastRunVersion) this.broadcastRun();
  }

  /** Frees a slot for good (explicit leave or grace expiry). */
  remove(session: Session, reason: string): void {
    if (this.sessions[session.slot] !== session) return;
    this.sessions[session.slot] = null;
    session.peer = null;
    this.world.removePlayer(session.slot);
    this.opts.log('info', 'leave', { room: this.code, slot: session.slot, reason, players: this.playerCount });
    this.updateEmpty();
    this.ensureHost();
    this.broadcastRoster();
    if (this.world.runVersion !== this.lastRunVersion) this.broadcastRun();
  }

  // ------------------------------------------------------------------ client messages

  /** Handles a validated message from a player in this room. Returns an error code to report, if any. */
  handle(session: Session, msg: ClientMsg): ErrorCode | null {
    this.touch();
    switch (msg.t) {
      case 'lobby': {
        if (this.phase !== 'lobby') return null;
        let changed = false;
        // A loadout belongs to a class (mastery, art, talents), so it only ever arrives together with `cls`
        // (parseClientMsg enforces that). A class change without one keeps upgrades, Ascension and relics and
        // resets mastery, art and talents until the client sends the loadout of the new class.
        if (msg.cls !== undefined && msg.loadout !== undefined) {
          if (this.world.setClass(session.slot, msg.cls, msg.loadout)) {
            session.cls = msg.cls;
            session.look = { ...msg.loadout.look };
            this.adoptBuild(session);
            changed = true;
          }
        } else if (msg.cls !== undefined && msg.cls !== session.cls && this.world.setClass(session.slot, msg.cls)) {
          session.cls = msg.cls;
          this.adoptBuild(session);
          changed = true;
        }
        if (msg.ready !== undefined && msg.ready !== session.ready) {
          session.ready = msg.ready;
          changed = true;
        }
        let error: ErrorCode | null = null;
        if (msg.oath !== undefined && msg.oath !== this.oath) {
          if (session.slot === this.hostSlot) {
            this.oath = msg.oath;
            changed = true;
          } else {
            error = 'not_host';
          }
        }
        if (changed) this.broadcastRoster();
        return error;
      }
      case 'start':
        if (session.slot !== this.hostSlot) return 'not_host';
        if (this.phase !== 'lobby' || this.tutorial) return null;
        return this.start();
      case 'pick':
        if (this.world.pickBoon(session.slot, msg.index)) this.afterWorldChange();
        return null;
      case 'reroll':
        if (this.world.rerollDraft(session.slot)) this.afterWorldChange();
        return null;
      case 'toLobby':
        if (session.slot !== this.hostSlot) return 'not_host';
        // A training session has no lobby to return to: the client leaves it instead.
        if (this.tutorial || (this.phase !== 'victory' && this.phase !== 'defeat')) return null;
        this.toLobby();
        return null;
      default:
        return null;
    }
  }

  input(session: Session, cmd: InputCmd): void {
    if (this.phase === 'lobby') return;
    this.world.applyInput(session.slot, cmd);
  }

  private start(): ErrorCode | null {
    // Everyone who is connected must be ready; pressing Start counts as the host being ready.
    for (const s of this.sessions) if (s && s.peer && !s.ready && s.slot !== this.hostSlot) return 'not_ready';
    // Players who are not connected right now do not take part in this run.
    for (const s of this.sessions) if (s && !s.peer) this.remove(s, 'absent_at_start');
    const seed = this.opts.seed ?? randomInt(1, 0x7fffffff);
    if (!this.world.start(this.oath, seed, this.opts.debugStartChamber, { objective: this.opts.debugObjective })) return 'not_ready';
    this.endedAt = 0;
    this.opts.log('info', 'run_start', { room: this.code, players: this.playerCount, oath: this.world.run.oath });
    this.broadcastRoster();
    this.broadcastRun();
    this.syncDrafts(true);
    this.startLoop();
    return null;
  }

  private toLobby(): void {
    this.stopLoop();
    this.world.reset();
    for (const s of this.sessions) if (s) s.ready = false;
    this.opts.log('info', 'to_lobby', { room: this.code });
    this.broadcastRoster();
    this.broadcastRun();
    this.syncDrafts();
  }

  /** Pushes everything that changed in the world outside the tick loop (e.g. a draft pick). */
  private afterWorldChange(): void {
    if (this.world.boonVersion !== this.lastBoonVersion) this.broadcastRoster();
    if (this.world.runVersion !== this.lastRunVersion) this.broadcastRun();
    this.syncDrafts();
  }

  // ------------------------------------------------------------------ tick loop

  private get tickMs(): number {
    return (TICK_DT * 1000) / this.opts.timeScale;
  }

  private startLoop(): void {
    this.stopLoop();
    this.nextTickAt = performance.now() + this.tickMs;
    this.schedule();
  }

  private stopLoop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  get running(): boolean {
    return this.timer !== null;
  }

  private schedule(): void {
    this.timer = setTimeout(() => this.onTimer(), Math.max(0, this.nextTickAt - performance.now()));
  }

  /** Fixed timestep with drift compensation: catches up a few ticks after a stall, never spirals. */
  private onTimer(): void {
    this.timer = null;
    if (this.destroyed) return;
    const now = performance.now();
    let steps = 0;
    while (now >= this.nextTickAt && steps < SERVER.MAX_CATCHUP_TICKS) {
      this.tick();
      this.nextTickAt += this.tickMs;
      steps++;
    }
    if (now >= this.nextTickAt) {
      this.nextTickAt = now + this.tickMs;
      this.droppedBacklogs++;
    }
    const phase = this.phase;
    if (phase === 'lobby') return;
    if (phase === 'victory' || phase === 'defeat') {
      if (this.endedAt === 0) {
        this.endedAt = this.opts.now();
        this.opts.log('info', 'run_end', { room: this.code, result: phase, chamber: this.world.run.chamber, depth: this.world.run.depth, cleared: this.world.run.cleared, seconds: Math.round(this.world.run.elapsed) });
      } else if (this.opts.now() - this.endedAt > SERVER.END_LINGER_MS / this.opts.timeScale) {
        return;
      }
    }
    this.schedule();
  }

  private tick(): void {
    const world = this.world;
    world.step();
    this.ticks++;
    if (world.runVersion !== this.lastRunVersion) {
      this.broadcastRun();
    } else if ((world.run.phase === 'draft' || world.run.phase === 'doors' || world.objectiveLive) && ++this.ticksSinceRun >= SERVER.RUN_BROADCAST_TICKS) {
      this.broadcastRun();
    }
    if (world.boonVersion !== this.lastBoonVersion) this.broadcastRoster();
    this.syncDrafts();
    if (world.paused || world.tick % NET.SNAPSHOT_EVERY !== 0) return;
    // Encode the shared part once; only the 23-byte header differs per client.
    const body = encodeSnapshotBody(world.getSnapshotBody());
    const events = world.drainEvents();
    const ev: ServerMsg | null = events.length > 0 ? { t: 'ev', tick: world.tick, events } : null;
    for (const s of this.sessions) {
      if (!s || !s.peer || s.peer.congested()) continue;
      s.peer.sendBinary(encodeSnapshot(world.tick, world.getSelfState(s.slot), body));
      if (ev) s.peer.sendJson(ev);
    }
  }

  // ------------------------------------------------------------------ housekeeping

  /** Expires disconnected players. Returns a reason if the whole room should be destroyed. */
  sweep(now: number): 'empty' | 'idle' | null {
    for (const s of this.sessions) {
      if (s && !s.peer && now - s.disconnectedAt >= this.opts.rejoinGraceMs) this.remove(s, 'grace_expired');
    }
    if (this.playerCount === 0) return 'empty';
    if (this.connectedCount === 0 && this.emptySince > 0 && now - this.emptySince >= this.opts.emptyRoomTtlMs) return 'empty';
    if (this.phase === 'lobby' && now - this.lastActivity >= this.opts.idleRoomTtlMs) return 'idle';
    return null;
  }

  /** Stops the loop and tells everyone who is still connected. */
  destroy(reason: string, notify: ErrorCode | null): Peer[] {
    this.destroyed = true;
    this.stopLoop();
    const peers: Peer[] = [];
    for (const s of this.sessions) {
      if (!s || !s.peer) continue;
      if (notify) s.peer.sendJson({ t: 'error', code: notify, fatal: true });
      peers.push(s.peer);
      s.peer = null;
    }
    this.opts.log('info', 'room_closed', { room: this.code, reason });
    return peers;
  }
}

export function randomRoomCode(): string {
  let code = '';
  for (let i = 0; i < NET.ROOM_CODE_LENGTH; i++) code += NET.ROOM_CODE_ALPHABET[randomInt(NET.ROOM_CODE_ALPHABET.length)];
  return code;
}
