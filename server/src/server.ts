/**
 * HTTP + WebSocket front end: connection lifecycle, validation, rate limiting, heartbeats and the room registry.
 * Clients only ever send intents (JSON) and inputs (binary); positions, damage and cooldowns are not in the protocol.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { NET } from '../../shared/src/constants.ts';
import {
  decodeInput, parseClientMsg, sanitizeName, type ClientMsg, type ErrorCode, type ServerMsg,
} from '../../shared/src/protocol.ts';
import { SERVER } from './config.ts';
import { consoleLogger, silentLogger, type Logger } from './log.ts';
import { randomRoomCode, Room, type Peer, type RoomOptions, type Session } from './room.ts';

export interface ServerOptions {
  /** 0 picks a free port (tests). */
  port?: number;
  host?: string;
  /** Allowed browser origins; ['*'] allows any. Requests without an Origin header (non-browser tools) are allowed. */
  allowedOrigins?: string[];
  maxRooms?: number;
  /** false silences logging; a function receives every log line. */
  log?: boolean | Logger;
  // --- overrides for tests / soaks (defaults come from NET) ---
  rejoinGraceMs?: number;
  emptyRoomTtlMs?: number;
  idleRoomTtlMs?: number;
  clientTimeoutMs?: number;
  pingIntervalMs?: number;
  sweepIntervalMs?: number;
  maxMessagesPerSecond?: number;
  /** Simulation speed multiplier (>1 = faster than real time). */
  timeScale?: number;
  /** QA aid: every run starts in this chamber index (0 = normal). Never set this in production. */
  debugStartChamber?: number;
  /** Fixed run seed for every room. */
  seed?: number;
}

export interface RunningServer {
  port: number;
  /** Number of rooms / connected players right now. */
  stats(): { rooms: number; players: number; connections: number };
  /** Closes every socket and the listener. */
  close(): Promise<void>;
}

class Connection implements Peer {
  readonly id: number;
  readonly ws: WebSocket;
  room: Room | null = null;
  session: Session | null = null;
  lastSeen: number;
  readonly openedAt: number;
  windowStart: number;
  windowCount = 0;
  offences = 0;
  /** Highest input sequence number seen on this socket. */
  lastSeq = -1;
  closed = false;

  constructor(id: number, ws: WebSocket, now: number) {
    this.id = id;
    this.ws = ws;
    this.lastSeen = now;
    this.openedAt = now;
    this.windowStart = now;
  }

  sendJson(msg: ServerMsg): void {
    if (this.closed || this.ws.readyState !== this.ws.OPEN) return;
    this.ws.send(JSON.stringify(msg, roundNumbers));
  }

  sendBinary(data: Uint8Array): void {
    if (this.closed || this.ws.readyState !== this.ws.OPEN) return;
    this.ws.send(data, { binary: true });
  }

  congested(): boolean {
    return this.ws.bufferedAmount > SERVER.BACKPRESSURE_BYTES;
  }
}

const ROUND = 10 ** SERVER.JSON_DECIMALS;
function roundNumbers(_key: string, value: unknown): unknown {
  return typeof value === 'number' && !Number.isInteger(value) ? Math.round(value * ROUND) / ROUND : value;
}

function toBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return data;
}

export function parseOrigins(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === '') return ['*'];
  return raw.split(',').map((s) => s.trim().replace(/\/+$/, '')).filter((s) => s.length > 0);
}

export function startServer(opts: ServerOptions = {}): Promise<RunningServer> {
  const log: Logger = opts.log === false ? silentLogger : typeof opts.log === 'function' ? opts.log : consoleLogger;
  const origins = opts.allowedOrigins && opts.allowedOrigins.length > 0 ? opts.allowedOrigins : ['*'];
  const anyOrigin = origins.includes('*');
  const maxRooms = opts.maxRooms ?? SERVER.DEFAULT_MAX_ROOMS;
  const clientTimeoutMs = opts.clientTimeoutMs ?? NET.CLIENT_TIMEOUT_MS;
  const maxRate = opts.maxMessagesPerSecond ?? NET.MAX_MESSAGES_PER_SECOND;
  const now = (): number => Date.now();
  const roomOptions: RoomOptions = {
    rejoinGraceMs: opts.rejoinGraceMs ?? NET.REJOIN_GRACE_MS,
    emptyRoomTtlMs: opts.emptyRoomTtlMs ?? NET.EMPTY_ROOM_TTL_MS,
    idleRoomTtlMs: opts.idleRoomTtlMs ?? NET.IDLE_ROOM_TTL_MS,
    timeScale: Math.max(0.1, opts.timeScale ?? 1),
    debugStartChamber: opts.debugStartChamber ?? 0,
    seed: opts.seed,
    log,
    now,
  };
  const startedAt = now();
  const rooms = new Map<string, Room>();
  const connections = new Set<Connection>();
  let nextConnId = 1;
  let closing = false;

  const playerCount = (): number => {
    let n = 0;
    for (const room of rooms.values()) n += room.connectedCount;
    return n;
  };

  // ------------------------------------------------------------------ HTTP

  const onRequest = (req: IncomingMessage, res: ServerResponse): void => {
    const path = (req.url ?? '/').split('?')[0];
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'text/plain', allow: 'GET, HEAD' }).end('method not allowed');
      return;
    }
    if ((SERVER.HEALTH_PATHS as readonly string[]).includes(path ?? '')) {
      const body = JSON.stringify({ ok: true, rooms: rooms.size, players: playerCount(), uptime: Math.round((now() - startedAt) / 1000) });
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' }).end(body);
      return;
    }
    if ((SERVER.WS_PATHS as readonly string[]).includes(path ?? '')) {
      res.writeHead(426, { 'content-type': 'text/plain', upgrade: 'websocket', connection: 'Upgrade' }).end('websocket endpoint');
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  };

  const http = createServer(onRequest);
  const wss = new WebSocketServer({ noServer: true, maxPayload: NET.MAX_MESSAGE_BYTES, perMessageDeflate: false, clientTracking: false });

  const reject = (socket: Duplex, status: number, text: string): void => {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  };

  http.on('upgrade', (req, socket, head) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    if (closing) return reject(socket, 503, 'Service Unavailable');
    if (!(SERVER.WS_PATHS as readonly string[]).includes(path)) return reject(socket, 404, 'Not Found');
    const origin = req.headers.origin;
    // A page served from the same host as this endpoint (single-origin hosting) is always allowed.
    const sameHost = origin !== undefined && req.headers.host !== undefined && origin.replace(/^https?:\/\//, '').replace(/\/+$/, '') === req.headers.host;
    if (!anyOrigin && origin !== undefined && !sameHost && !origins.includes(origin.replace(/\/+$/, ''))) {
      log('warn', 'origin_rejected', {});
      return reject(socket, 403, 'Forbidden');
    }
    if (connections.size >= maxRooms * NET.MAX_PLAYERS + SERVER.SPARE_CONNECTIONS) return reject(socket, 503, 'Service Unavailable');
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws));
  });

  // ------------------------------------------------------------------ connections

  const fail = (conn: Connection, code: ErrorCode, fatal: boolean): void => {
    conn.sendJson({ t: 'error', code, fatal });
    if (fatal) closeConnection(conn, SERVER.CLOSE_POLICY, code);
  };

  const closeConnection = (conn: Connection, code: number, reason: string): void => {
    if (conn.closed) return;
    detach(conn);
    conn.closed = true;
    connections.delete(conn);
    try {
      conn.ws.close(code, reason);
    } catch {
      conn.ws.terminate();
    }
  };

  /** The socket is gone (or about to be): the slot stays reserved for the grace period. */
  const detach = (conn: Connection): void => {
    const { room, session } = conn;
    conn.room = null;
    conn.session = null;
    if (room && session) room.disconnect(session, conn);
  };

  const offence = (conn: Connection): void => {
    conn.offences++;
    fail(conn, 'invalid_message', conn.offences >= SERVER.MAX_OFFENCES);
  };

  const destroyRoom = (room: Room, reason: string, notify: ErrorCode | null): void => {
    rooms.delete(room.code);
    for (const peer of room.destroy(reason, notify)) {
      const conn = peer as Connection;
      conn.room = null;
      conn.session = null;
      closeConnection(conn, SERVER.CLOSE_NORMAL, reason);
    }
  };

  const enter = (conn: Connection, msg: Extract<ClientMsg, { t: 'create' | 'join' | 'rejoin' }>): void => {
    if (conn.session) return offence(conn);
    if (msg.v !== NET.PROTOCOL_VERSION) return fail(conn, 'bad_version', true);
    if (msg.t === 'create') {
      if (rooms.size >= maxRooms) return fail(conn, 'server_full', false);
      let code = '';
      for (let i = 0; i < SERVER.ROOM_CODE_ATTEMPTS && (code === '' || rooms.has(code)); i++) code = randomRoomCode();
      if (code === '' || rooms.has(code)) return fail(conn, 'server_full', false);
      const room = new Room(code, roomOptions, msg.tutorial === true);
      rooms.set(code, room);
      log('info', 'room_created', { room: code, rooms: rooms.size, tutorial: room.tutorial });
      const result = room.join(conn, msg.name, msg.cls, msg.loadout);
      if (!result.ok) {
        rooms.delete(code);
        return fail(conn, result.code, false);
      }
      conn.room = room;
      conn.session = result.session;
      return;
    }
    const room = rooms.get(msg.code);
    if (!room) return fail(conn, 'room_not_found', false);
    if (msg.t === 'join') {
      const result = room.join(conn, msg.name, msg.cls, msg.loadout);
      if (!result.ok) return fail(conn, result.code, false);
      conn.room = room;
      conn.session = result.session;
      return;
    }
    const result = room.rejoin(conn, msg.token);
    if (!result.ok) return fail(conn, result.code, false);
    conn.room = room;
    conn.session = result.session;
    if (result.replaced && result.replaced !== conn) {
      // The slot's previous socket is still open (e.g. a second tab): it loses the slot.
      const old = result.replaced as Connection;
      old.room = null;
      old.session = null;
      closeConnection(old, SERVER.CLOSE_NORMAL, 'replaced');
    }
  };

  const onJson = (conn: Connection, text: string): void => {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return offence(conn);
    }
    const msg = parseClientMsg(raw);
    if (!msg) {
      // A dedicated code helps the UI when only the name is the problem.
      const r = raw as { t?: unknown; name?: unknown } | null;
      if (r && typeof r === 'object' && (r.t === 'create' || r.t === 'join') && sanitizeName(r.name) === null) {
        return fail(conn, 'invalid_name', false);
      }
      return offence(conn);
    }
    switch (msg.t) {
      case 'ping':
        conn.sendJson({ t: 'pong', c: msg.c, s: now() });
        return;
      case 'create':
      case 'join':
      case 'rejoin':
        enter(conn, msg);
        return;
      case 'leave': {
        const { room, session } = conn;
        conn.room = null;
        conn.session = null;
        if (room && session) room.remove(session, 'left');
        closeConnection(conn, SERVER.CLOSE_NORMAL, 'left');
        return;
      }
      default: {
        // Gameplay intents from sockets without a slot are ignored.
        if (!conn.room || !conn.session) return;
        const error = conn.room.handle(conn.session, msg);
        if (error) fail(conn, error, false);
      }
    }
  };

  const onMessage = (conn: Connection, data: RawData, isBinary: boolean): void => {
    if (conn.closed) return;
    const t = now();
    conn.lastSeen = t;
    if (t - conn.windowStart >= 1000) {
      conn.windowStart = t;
      conn.windowCount = 0;
    }
    if (++conn.windowCount > maxRate) {
      log('warn', 'rate_limited', { conn: conn.id });
      return fail(conn, 'rate_limited', true);
    }
    const bytes = toBytes(data);
    if (bytes.byteLength > NET.MAX_MESSAGE_BYTES) return offence(conn);
    if (isBinary) {
      const cmd = decodeInput(bytes);
      if (!cmd) return offence(conn);
      // Inputs from sockets without a slot are ignored; stale or replayed sequence numbers are dropped.
      if (!conn.room || !conn.session || cmd.seq <= conn.lastSeq) return;
      conn.lastSeq = cmd.seq;
      conn.room.input(conn.session, cmd);
      return;
    }
    onJson(conn, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8'));
  };

  const onConnection = (ws: WebSocket): void => {
    const conn = new Connection(nextConnId++, ws, now());
    connections.add(conn);
    ws.on('message', (data, isBinary) => {
      try {
        onMessage(conn, data, isBinary);
      } catch (err) {
        log('error', 'message_handler_failed', { conn: conn.id, error: err instanceof Error ? err.message : 'unknown' });
        closeConnection(conn, SERVER.CLOSE_POLICY, 'error');
      }
    });
    ws.on('pong', () => { conn.lastSeen = now(); });
    ws.on('close', () => {
      if (conn.closed) return;
      detach(conn);
      conn.closed = true;
      connections.delete(conn);
    });
    // Protocol errors (e.g. a frame above maxPayload) end in 'close'; nothing else to do here.
    ws.on('error', () => undefined);
  };

  // ------------------------------------------------------------------ timers

  const heartbeat = setInterval(() => {
    const t = now();
    for (const conn of connections) {
      const idle = t - conn.lastSeen > clientTimeoutMs;
      const lurking = !conn.session && t - conn.openedAt > clientTimeoutMs;
      if (idle || lurking) {
        conn.sendJson({ t: 'error', code: 'timeout', fatal: true });
        detach(conn);
        conn.closed = true;
        connections.delete(conn);
        conn.ws.terminate();
        continue;
      }
      if (conn.ws.readyState === conn.ws.OPEN) conn.ws.ping();
    }
  }, opts.pingIntervalMs ?? NET.PING_INTERVAL_MS);

  const sweeper = setInterval(() => {
    const t = now();
    for (const room of [...rooms.values()]) {
      const reason = room.sweep(t);
      if (reason) destroyRoom(room, reason, reason === 'idle' ? 'timeout' : null);
    }
  }, opts.sweepIntervalMs ?? SERVER.SWEEP_INTERVAL_MS);

  const close = (): Promise<void> => {
    if (closing) return Promise.resolve();
    closing = true;
    clearInterval(heartbeat);
    clearInterval(sweeper);
    for (const room of [...rooms.values()]) {
      rooms.delete(room.code);
      room.destroy('shutdown', null);
    }
    for (const conn of [...connections]) {
      conn.room = null;
      conn.session = null;
      closeConnection(conn, SERVER.CLOSE_GOING_AWAY, 'shutdown');
    }
    wss.close();
    return new Promise((resolve) => {
      http.close(() => resolve());
      http.closeAllConnections();
    });
  };

  return new Promise((resolve, reject_) => {
    http.once('error', reject_);
    http.listen(opts.port ?? SERVER.DEFAULT_PORT, opts.host ?? '0.0.0.0', () => {
      http.off('error', reject_);
      const port = (http.address() as AddressInfo).port;
      log('info', 'listening', { port, origins: anyOrigin ? '*' : origins.length, maxRooms });
      resolve({ port, stats: () => ({ rooms: rooms.size, players: playerCount(), connections: connections.size }), close });
    });
  });
}
