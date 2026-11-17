/**
 * WebSocket bot client: real sockets that play with sim/bot.ts from decoded snapshots.
 *
 *   npx tsx server/src/tools/botClient.ts --url ws://localhost:8787 --code ABCDE --bots 2
 *   npx tsx server/src/tools/botClient.ts --create --bots 3 --cls mage,knight,rogue --latency 120 --jitter 40
 *
 *   npx tsx server/src/tools/botClient.ts --tutorial --cls mage --once
 *
 * Flags: --url, --code, --create, --bots N, --cls a,b,c, --name prefix, --oath 0-3, --wait N (players needed before
 * the hosting bot starts; default = --bots), --latency ms / --jitter ms (one-way delay applied to every message in
 * BOTH directions, so the round trip is about twice that), --once (exit after the first run), --quiet,
 * --meta max (every bot claims fully upgraded permanent upgrades; default: none), --tutorial (one bot plays the
 * training session instead of a run; implies --create --bots 1).
 */
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import { NET, TICK_DT } from '../../../shared/src/constants.ts';
import { DEFAULT_LOOK, META_UPGRADES } from '../../../shared/src/data/meta.ts';
import { decodeSnapshot, encodeInput, type ClientMsg, type ServerMsg } from '../../../shared/src/protocol.ts';
import { BotBrain, type BotView } from '../../../shared/src/sim/bot.ts';
import { CLASS_IDS, type BoonOffer, type ClassId, type Loadout, type RosterEntry, type RunState, type Snapshot } from '../../../shared/src/types.ts';

export interface BotClientOptions {
  url: string;
  name: string;
  cls: ClassId;
  /** Join this room; omit together with `create: true` to host a new one. */
  code?: string;
  create?: boolean;
  /** Create a solo training session instead of a lobby (implies `create`). */
  tutorial?: boolean;
  /** Look and permanent upgrade levels sent with create / join (default: default look, no upgrades). */
  loadout?: Loadout;
  /** Host only: start once this many players are connected and everyone else is ready. */
  startWhenPlayers?: number;
  /** Host only: oath level to set. */
  oath?: number;
  /** Host only: return to the lobby this many ms after a run ended (undefined = never). */
  relobbyAfterMs?: number;
  /** One-way artificial delay per message, both directions. */
  latencyMs?: number;
  jitterMs?: number;
  /** Must match the server's timeScale (inputs are sent at INPUT_HZ * timeScale). */
  timeScale?: number;
  seed?: number;
  /** Rejoin automatically (same slot) when the socket drops unexpectedly. */
  reconnect?: boolean;
  log?: (line: string) => void;
}

export const defaultLoadout = (): Loadout => ({ look: { ...DEFAULT_LOOK }, meta: META_UPGRADES.map(() => 0) });
/** A loadout that claims the highest level of every permanent upgrade. */
export const maxLoadout = (): Loadout => ({ look: { ...DEFAULT_LOOK }, meta: META_UPGRADES.map((def) => def.costs.length) });

const BOT_CLIENT = {
  PICK_DELAY_MS: 700,
  RECONNECT_ATTEMPTS: 5,
  RECONNECT_DELAY_MS: 600,
  MAX_INPUT_CATCHUP: 3,
} as const;

/** FIFO delay line: keeps message order (like TCP) while adding latency and jitter. */
class DelayLine {
  private last = 0;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private latency: number;
  private jitter: number;
  private rand: () => number;

  constructor(latency: number, jitter: number, rand: () => number) {
    this.latency = latency;
    this.jitter = jitter;
    this.rand = rand;
  }

  push(fn: () => void): void {
    if (this.latency <= 0 && this.jitter <= 0) return fn();
    const now = performance.now();
    const due = Math.max(this.last, now + Math.max(0, this.latency + (this.rand() * 2 - 1) * this.jitter));
    this.last = due;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, due - now);
    this.timers.add(timer);
  }

  clear(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }
}

export class BotClient {
  readonly opts: BotClientOptions;
  code = '';
  slot = -1;
  token = '';
  roster: RosterEntry[] = [];
  run: RunState | null = null;
  /** Rerolls left, as reported by the last private draft message. */
  rerolls = 0;
  snapshot: Snapshot | null = null;
  /** Counters for tests and the status line. */
  snapshots = 0;
  inputsSent = 0;
  maxAck = 0;
  runsEnded = 0;
  lastError = '';
  rttMs = 0;
  closed = false;

  onWelcome: (() => void) | null = null;
  onRunEnd: ((phase: 'victory' | 'defeat', run: RunState) => void) | null = null;
  onClose: ((expected: boolean) => void) | null = null;
  onError: ((code: string, fatal: boolean) => void) | null = null;

  private ws: WebSocket | null = null;
  private brain: BotBrain;
  private inbound: DelayLine;
  private outbound: DelayLine;
  private inputTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pickTimer: ReturnType<typeof setTimeout> | null = null;
  private lobbyTimer: ReturnType<typeof setTimeout> | null = null;
  private nextInputAt = 0;
  private wantClose = false;
  private reconnects = 0;
  private endedPhase = '';
  private startSent = false;
  private seq = 0;
  private roomOath = 0;
  private rngState: number;

  constructor(opts: BotClientOptions) {
    this.opts = opts;
    this.rngState = ((opts.seed ?? 1) * 2654435761) >>> 0;
    const rand = (): number => {
      this.rngState = (Math.imul(this.rngState, 1664525) + 1013904223) >>> 0;
      return this.rngState / 4294967296;
    };
    this.inbound = new DelayLine(opts.latencyMs ?? 0, opts.jitterMs ?? 0, rand);
    this.outbound = new DelayLine(opts.latencyMs ?? 0, opts.jitterMs ?? 0, rand);
    this.brain = new BotBrain(0, opts.cls, opts.seed ?? 1);
  }

  private log(line: string): void {
    this.opts.log?.(`[${this.opts.name}] ${line}`);
  }

  /** Opens the socket and resolves once the server has assigned a slot. */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (err?: Error): void => {
        if (settled) return;
        settled = true;
        if (err) reject(err); else resolve();
      };
      const loadout = this.opts.loadout ?? defaultLoadout();
      const first: ClientMsg = this.token
        ? { t: 'rejoin', v: NET.PROTOCOL_VERSION, code: this.code, token: this.token }
        : this.opts.tutorial
          ? { t: 'create', v: NET.PROTOCOL_VERSION, name: this.opts.name, cls: this.opts.cls, loadout, tutorial: true }
          : this.opts.create || !this.opts.code
            ? { t: 'create', v: NET.PROTOCOL_VERSION, name: this.opts.name, cls: this.opts.cls, loadout }
            : { t: 'join', v: NET.PROTOCOL_VERSION, code: this.opts.code, name: this.opts.name, cls: this.opts.cls, loadout };
      const ws = new WebSocket(this.opts.url, { perMessageDeflate: false, handshakeTimeout: 8000 });
      this.ws = ws;
      ws.binaryType = 'nodebuffer';
      ws.on('open', () => this.send(first));
      ws.on('message', (data, isBinary) => {
        const bytes = Array.isArray(data) ? Buffer.concat(data) : (data as Buffer);
        this.inbound.push(() => {
          if (this.ws !== ws) return;
          if (isBinary) this.onSnapshot(bytes);
          else this.onJson(bytes.toString('utf8'), done);
        });
      });
      ws.on('error', (err) => done(err instanceof Error ? err : new Error('socket error')));
      ws.on('close', () => {
        done(new Error(this.lastError || 'socket closed before welcome'));
        if (this.ws === ws) this.handleClose();
      });
    });
  }

  private handleClose(): void {
    this.stopTimers();
    this.ws = null;
    const expected = this.wantClose;
    if (!expected && this.opts.reconnect && this.token && this.reconnects < BOT_CLIENT.RECONNECT_ATTEMPTS) {
      this.reconnects++;
      this.log(`connection lost, rejoining (${this.reconnects}/${BOT_CLIENT.RECONNECT_ATTEMPTS})`);
      setTimeout(() => {
        this.connect().catch(() => this.handleClose());
      }, BOT_CLIENT.RECONNECT_DELAY_MS);
      return;
    }
    this.closed = true;
    this.onClose?.(expected);
  }

  /** Simulates a network drop: the socket dies without a `leave`, the slot stays reserved. */
  drop(): void {
    this.wantClose = true;
    this.stopTimers();
    this.ws?.terminate();
  }

  /** Resume the slot after `drop()`. */
  rejoin(): Promise<void> {
    this.wantClose = false;
    this.closed = false;
    return this.connect();
  }

  close(leave = true): void {
    this.wantClose = true;
    this.stopTimers();
    const ws = this.ws;
    if (!ws) return;
    if (leave && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'leave' } satisfies ClientMsg));
    ws.close();
  }

  private stopLoops(): void {
    if (this.inputTimer) clearTimeout(this.inputTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.inputTimer = this.pingTimer = null;
  }

  private stopTimers(): void {
    this.stopLoops();
    if (this.pickTimer) clearTimeout(this.pickTimer);
    if (this.lobbyTimer) clearTimeout(this.lobbyTimer);
    this.pickTimer = this.lobbyTimer = null;
    this.inbound.clear();
    this.outbound.clear();
  }

  send(msg: ClientMsg): void {
    const ws = this.ws;
    const text = JSON.stringify(msg);
    this.outbound.push(() => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(text);
    });
  }

  private sendBinary(data: ArrayBuffer): void {
    const ws = this.ws;
    this.outbound.push(() => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(data, { binary: true });
    });
  }

  private get scale(): number {
    return Math.max(0.1, this.opts.timeScale ?? 1);
  }

  private onJson(text: string, welcomed: (err?: Error) => void): void {
    let msg: ServerMsg;
    try {
      msg = JSON.parse(text) as ServerMsg;
    } catch {
      return;
    }
    switch (msg.t) {
      case 'welcome':
        this.code = msg.code;
        this.slot = msg.slot;
        this.token = msg.token;
        this.reconnects = 0;
        this.seq = 0;
        this.maxAck = 0;
        this.brain = new BotBrain(msg.slot, this.opts.cls, this.opts.seed ?? 1);
        this.startLoops();
        welcomed();
        this.onWelcome?.();
        break;
      case 'roster':
        this.roster = msg.players;
        this.roomOath = msg.oath;
        this.onRoster();
        break;
      case 'run':
        this.onRun(msg.state);
        break;
      case 'draft':
        this.rerolls = msg.rerolls;
        this.onDraft(msg.options);
        break;
      case 'ev':
        this.brain.observe(msg.events, msg.tick);
        break;
      case 'pong':
        this.rttMs = performance.now() - msg.c;
        break;
      case 'error':
        this.lastError = msg.code;
        this.log(`server error: ${msg.code}${msg.fatal ? ' (fatal)' : ''}`);
        this.onError?.(msg.code, msg.fatal);
        if (msg.code === 'not_ready') this.startSent = false;
        break;
      default:
        break;
    }
  }

  private onRoster(): void {
    const oath = this.roomOath;
    const me = this.roster.find((p) => p.slot === this.slot);
    if (!me || !this.run || this.run.phase !== 'lobby') return;
    if (me.cls !== this.opts.cls) this.send({ t: 'lobby', cls: this.opts.cls });
    if (!me.ready) this.send({ t: 'lobby', ready: true });
    if (!me.host) return;
    if (this.opts.oath !== undefined && this.opts.oath !== oath) this.send({ t: 'lobby', oath: this.opts.oath });
    const need = this.opts.startWhenPlayers;
    if (need === undefined || this.startSent) return;
    const connected = this.roster.filter((p) => p.connected);
    if (connected.length >= need && connected.every((p) => p.ready || p.host)) {
      this.startSent = true;
      this.send({ t: 'start' });
    }
  }

  private onRun(state: RunState): void {
    const before = this.run ? this.run.phase : '';
    this.run = state;
    if (state.phase === 'lobby') {
      this.endedPhase = '';
      this.startSent = false;
      this.snapshot = null;
      if (before !== 'lobby') this.onRoster();
      return;
    }
    if ((state.phase === 'victory' || state.phase === 'defeat') && this.endedPhase !== state.phase) {
      this.endedPhase = state.phase;
      this.runsEnded++;
      this.onRunEnd?.(state.phase, state);
      const me = this.roster.find((p) => p.slot === this.slot);
      if (this.opts.relobbyAfterMs !== undefined && me?.host) {
        this.lobbyTimer = setTimeout(() => this.send({ t: 'toLobby' }), this.opts.relobbyAfterMs);
      }
    }
  }

  private onDraft(options: BoonOffer[]): void {
    if (this.pickTimer) clearTimeout(this.pickTimer);
    this.pickTimer = null;
    if (options.length === 0) return;
    const boons = this.roster.find((p) => p.slot === this.slot)?.boons ?? [];
    const index = this.brain.chooseBoon(options, boons);
    this.pickTimer = setTimeout(() => this.send({ t: 'pick', index }), BOT_CLIENT.PICK_DELAY_MS / this.scale);
  }

  private onSnapshot(bytes: Uint8Array): void {
    const snap = decodeSnapshot(bytes);
    if (!snap) return;
    if (this.snapshot && snap.tick < this.snapshot.tick) return;
    this.snapshot = snap;
    this.snapshots++;
    if (snap.self.ackSeq > this.maxAck) this.maxAck = snap.self.ackSeq;
  }

  private startLoops(): void {
    this.stopLoops();
    const interval = (1000 * TICK_DT) / this.scale;
    this.nextInputAt = performance.now() + interval;
    const loop = (): void => {
      this.inputTimer = null;
      if (this.wantClose || !this.ws) return;
      const now = performance.now();
      let sent = 0;
      while (now >= this.nextInputAt && sent < BOT_CLIENT.MAX_INPUT_CATCHUP) {
        this.sendInput();
        this.nextInputAt += interval;
        sent++;
      }
      if (now >= this.nextInputAt) this.nextInputAt = now + interval;
      this.inputTimer = setTimeout(loop, Math.max(0, this.nextInputAt - performance.now()));
    };
    this.inputTimer = setTimeout(loop, interval);
    this.pingTimer = setInterval(() => this.send({ t: 'ping', c: performance.now() }), NET.PING_INTERVAL_MS);
  }

  private sendInput(): void {
    const run = this.run;
    const snap = this.snapshot;
    if (!run || !snap || run.phase === 'lobby' || run.phase === 'victory' || run.phase === 'defeat') return;
    const view: BotView = { tick: snap.tick, slot: this.slot, cls: this.opts.cls, players: snap.players, enemies: snap.enemies, projectiles: snap.projectiles, run };
    const cmd = this.brain.think(view);
    // The client owns the sequence numbers (monotonic per connection).
    cmd.seq = ++this.seq;
    this.sendBinary(encodeInput(cmd));
    this.inputsSent++;
  }
}

// ---------------------------------------------------------------------------------------------- CLI

interface Args {
  url: string;
  code: string;
  create: boolean;
  bots: number;
  classes: ClassId[];
  name: string;
  oath?: number;
  wait?: number;
  latency: number;
  jitter: number;
  once: boolean;
  quiet: boolean;
  timeScale: number;
  metaMax: boolean;
  tutorial: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { url: 'ws://localhost:8787', code: '', create: false, bots: 1, classes: [], name: 'Bot', latency: 0, jitter: 0, once: false, quiet: false, timeScale: 1, metaMax: false, tutorial: false };
  const num = (v: string | undefined, name: string): number => {
    const n = Number(v);
    if (v === undefined || !Number.isFinite(n)) throw new Error(`--${name} needs a number`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case '--url': args.url = value ?? args.url; i++; break;
      case '--code': args.code = (value ?? '').toUpperCase(); i++; break;
      case '--create': args.create = true; break;
      case '--bots': args.bots = Math.max(1, Math.min(NET.MAX_PLAYERS, Math.floor(num(value, 'bots')))); i++; break;
      case '--cls': {
        for (const c of (value ?? '').split(',')) {
          if (!(CLASS_IDS as readonly string[]).includes(c)) throw new Error(`unknown class "${c}" (use ${CLASS_IDS.join(', ')})`);
          args.classes.push(c as ClassId);
        }
        i++;
        break;
      }
      case '--name': args.name = (value ?? 'Bot').slice(0, NET.MAX_NAME_LENGTH - 2); i++; break;
      case '--oath': args.oath = Math.max(0, Math.min(3, Math.floor(num(value, 'oath')))); i++; break;
      case '--wait': args.wait = Math.max(1, Math.min(NET.MAX_PLAYERS, Math.floor(num(value, 'wait')))); i++; break;
      case '--latency': args.latency = Math.max(0, num(value, 'latency')); i++; break;
      case '--jitter': args.jitter = Math.max(0, num(value, 'jitter')); i++; break;
      case '--timescale': args.timeScale = Math.max(0.1, num(value, 'timescale')); i++; break;
      case '--once': args.once = true; break;
      case '--meta': {
        if (value !== 'max' && value !== 'none') throw new Error('--meta needs "max" or "none"');
        args.metaMax = value === 'max';
        i++;
        break;
      }
      case '--tutorial': args.tutorial = true; args.create = true; args.bots = 1; break;
      case '--quiet': args.quiet = true; break;
      default: throw new Error(`unknown argument "${flag}"`);
    }
  }
  if (args.tutorial) args.bots = 1;
  if (!args.create && !args.code) throw new Error('pass --code ABCDE to join a room, --create to host one or --tutorial');
  return args;
}

async function cli(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const say = (line: string): void => console.info(line);
  const log = args.quiet ? undefined : say;
  const bots: BotClient[] = [];
  let code = args.code;
  let finished = 0;
  const shutdown = (exitCode: number): void => {
    for (const b of bots) b.close();
    setTimeout(() => process.exit(exitCode), 300);
  };
  for (let i = 0; i < args.bots; i++) {
    const cls = args.classes.length > 0 ? (args.classes[i % args.classes.length] as ClassId) : (CLASS_IDS[i % CLASS_IDS.length] as ClassId);
    const hosting = args.create && i === 0;
    const bot = new BotClient({
      url: args.url, name: `${args.name}${i + 1}`, cls, code: hosting ? undefined : code, create: hosting,
      startWhenPlayers: hosting ? (args.wait ?? args.bots) : undefined, oath: hosting ? args.oath : undefined,
      relobbyAfterMs: hosting && !args.once ? 6000 : undefined, latencyMs: args.latency, jitterMs: args.jitter,
      timeScale: args.timeScale, seed: 1 + i, reconnect: true, log, tutorial: args.tutorial,
      loadout: args.metaMax ? maxLoadout() : defaultLoadout(),
    });
    bot.onRunEnd = (phase, run) => {
      const glimmer = run.rewards.find((r) => r.slot === bot.slot)?.glimmer ?? 0;
      const what = run.tutorial ? `tutorial ${phase === 'victory' ? 'completed' : 'failed'} (${run.tutorial.total} steps)` : `run over: ${phase} in chamber ${run.chamber + 1}/8 vs ${run.finalBoss}`;
      say(`[${bot.opts.name}] ${what} after ${Math.round(run.elapsed)} s, +${glimmer} glimmer (snapshots ${bot.snapshots}, rtt ${Math.round(bot.rttMs)} ms)`);
      if (args.once && ++finished >= bots.length) shutdown(0);
    };
    bot.onClose = (expected) => {
      if (expected) return;
      say(`[${bot.opts.name}] disconnected${bot.lastError ? ` (${bot.lastError})` : ''}`);
      if (bots.every((b) => b.closed)) process.exit(1);
    };
    bots.push(bot);
    await bot.connect();
    if (hosting) {
      code = bot.code;
      say(`ROOM CODE: ${code}`);
    }
    say(`[${bot.opts.name}] joined ${bot.code} as ${cls} in slot ${bot.slot}`);
  }
  if (!args.quiet) {
    setInterval(() => {
      const b = bots[0];
      if (!b || !b.run) return;
      const where = b.run.tutorial ? `tutorial step ${b.run.tutorial.index + 1}/${b.run.tutorial.total} (${b.run.tutorial.step})` : `chamber ${b.run.chamber + 1} wave ${b.run.wave}/${b.run.waveCount}`;
      say(`status: ${b.run.phase} ${where} players ${b.roster.filter((p) => p.connected).length} t=${Math.round(b.run.elapsed)}s`);
    }, 10000).unref();
  }
  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  cli().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
