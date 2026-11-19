/**
 * WebSocket session: create / join / rejoin, automatic reconnect, ping, message routing.
 * Writes GameState and announces changes on the bus. Never touches rendering or DOM.
 */
import { NET } from '@shared/constants.ts';
import { BIN, decodeSnapshot, encodeInput, type ClientMsg, type ServerMsg } from '@shared/protocol.ts';
import type { ClassId, InputCmd, RunPhase, Snapshot } from '@shared/types.ts';
import { SERVER_URL } from '../core/config.ts';
import { bus, type ConnError } from '../core/EventBus.ts';
import { loadoutFor, resetSession, selfRoster, state, type Screen } from '../core/GameState.ts';

const SESSION_KEY = 'glimmergrave.session.v1';
const CONNECT_TIMEOUT_MS = 8000;
const RECONNECT_BASE_DELAY_MS = 800;
const RECONNECT_MAX_DELAY_MS = 5000;
/** No frame from the server for this long while online = connection considered dead. */
const SILENCE_TIMEOUT_MS = 6000;
const PING_SMOOTHING = 0.3;

interface StoredSession { code: string; token: string }
type Intent = { kind: 'create'; name: string; cls: ClassId; tutorial: boolean } | { kind: 'join'; code: string; name: string; cls: ClassId } | { kind: 'rejoin' };

function readSession(): StoredSession | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredSession>;
    if (typeof parsed.code === 'string' && typeof parsed.token === 'string') return { code: parsed.code, token: parsed.token };
  } catch { /* unavailable or corrupt */ }
  return null;
}

function writeSession(session: StoredSession | null): void {
  try {
    if (session) sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else sessionStorage.removeItem(SESSION_KEY);
  } catch { /* ignore */ }
}

export class NetClient {
  /** Called for every decoded snapshot (before `state:hud`). */
  onSnapshot: ((snap: Snapshot, receivedAt: number) => void) | null = null;

  private socket: WebSocket | null = null;
  private session: StoredSession | null = null;
  private intent: Intent | null = null;
  private welcomed = false;
  private connectTimer = 0;
  private reconnectTimer = 0;
  private pingTimer = 0;
  private reconnectDeadline = 0;
  private reconnectAttempt = 0;
  private lastMessageAt = 0;

  constructor() {
    bus.on('ui:create', ({ name, cls, tutorial }) => this.begin({ kind: 'create', name, cls, tutorial: tutorial === true }));
    bus.on('ui:join', ({ code, name, cls }) => this.begin({ kind: 'join', code, name, cls }));
    // A class change also switches to that class's look.
    bus.on('ui:lobby', (patch) => this.send({ t: 'lobby', ...patch, ...(patch.cls ? { loadout: loadoutFor(patch.cls) } : {}) }));
    bus.on('ui:loadout', () => {
      const me = selfRoster();
      if (me && state.run?.phase === 'lobby') this.send({ t: 'lobby', cls: me.cls, loadout: loadoutFor(me.cls) });
    });
    bus.on('ui:reroll', () => this.send({ t: 'reroll' }));
    bus.on('ui:start', () => this.send({ t: 'start' }));
    bus.on('ui:pick', ({ index, replace }) => this.send(replace === undefined ? { t: 'pick', index } : { t: 'pick', index, replace }));
    bus.on('ui:toLobby', () => this.send({ t: 'toLobby' }));
    bus.on('ui:leave', () => this.leave());
    this.pingTimer = window.setInterval(() => this.heartbeat(), NET.PING_INTERVAL_MS);
  }

  /** Resumes a session stored by this tab (page reload). Returns true if a rejoin was started. */
  resume(): boolean {
    const stored = readSession();
    if (!stored) return false;
    this.session = stored;
    state.conn.code = stored.code;
    this.startReconnect();
    return true;
  }

  get online(): boolean {
    return this.welcomed && this.socket?.readyState === WebSocket.OPEN;
  }

  sendInput(cmd: InputCmd): void {
    if (this.online) this.socket?.send(encodeInput(cmd));
  }

  // ------------------------------------------------------------------ connection lifecycle

  private begin(intent: Intent): void {
    if (state.conn.status !== 'offline') return;
    this.intent = intent;
    this.setStatus('connecting');
    this.open();
  }

  private open(): void {
    this.closeSocket();
    this.welcomed = false;
    let socket: WebSocket;
    try {
      socket = new WebSocket(SERVER_URL);
    } catch {
      this.handleClose();
      return;
    }
    socket.binaryType = 'arraybuffer';
    this.socket = socket;
    window.clearTimeout(this.connectTimer);
    this.connectTimer = window.setTimeout(() => {
      if (this.socket === socket && !this.welcomed) socket.close();
    }, CONNECT_TIMEOUT_MS);

    socket.onopen = () => {
      if (this.socket !== socket || !this.intent) return;
      const v = NET.PROTOCOL_VERSION;
      if (this.intent.kind === 'create') this.send({ t: 'create', v, name: this.intent.name, cls: this.intent.cls, loadout: loadoutFor(this.intent.cls), tutorial: this.intent.tutorial });
      else if (this.intent.kind === 'join') this.send({ t: 'join', v, code: this.intent.code, name: this.intent.name, cls: this.intent.cls, loadout: loadoutFor(this.intent.cls) });
      else if (this.session) this.send({ t: 'rejoin', v, code: this.session.code, token: this.session.token });
    };
    socket.onmessage = (ev) => {
      if (this.socket !== socket) return;
      this.lastMessageAt = performance.now();
      if (typeof ev.data === 'string') this.onText(ev.data);
      else if (ev.data instanceof ArrayBuffer) this.onBinary(ev.data);
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.handleClose();
    };
    socket.onerror = () => { /* onclose follows */ };
  }

  private handleClose(): void {
    window.clearTimeout(this.connectTimer);
    if (state.conn.status === 'offline') return;
    if (this.session) {
      // We had (or were resuming) a session: try to get back in.
      if (state.conn.status !== 'reconnecting') this.startReconnect();
      else this.scheduleReconnect();
      return;
    }
    this.fail('unreachable');
  }

  private startReconnect(): void {
    this.intent = { kind: 'rejoin' };
    this.reconnectAttempt = 0;
    this.reconnectDeadline = performance.now() + NET.REJOIN_GRACE_MS;
    this.setStatus('reconnecting');
    this.open();
  }

  private scheduleReconnect(): void {
    if (performance.now() > this.reconnectDeadline) {
      this.fail('connection_lost');
      return;
    }
    const delay = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2 ** this.reconnectAttempt++);
    window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = window.setTimeout(() => {
      if (state.conn.status === 'reconnecting') this.open();
    }, delay);
  }

  private leave(): void {
    if (this.online) this.send({ t: 'leave' });
    this.teardown();
    this.updateScreen();
  }

  /** Ends the session with an error shown to the user. */
  private fail(error: ConnError): void {
    this.teardown();
    state.conn.lastError = error;
    bus.emit('net:error', { error, fatal: true });
    this.updateScreen();
  }

  private teardown(): void {
    window.clearTimeout(this.connectTimer);
    window.clearTimeout(this.reconnectTimer);
    this.intent = null;
    this.session = null;
    this.welcomed = false;
    writeSession(null);
    resetSession();
    this.closeSocket();
    bus.emit('net:status');
    bus.emit('state:roster');
    bus.emit('state:draft');
    bus.emit('state:hud');
  }

  private closeSocket(): void {
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState <= WebSocket.OPEN) socket.close();
  }

  private setStatus(status: typeof state.conn.status): void {
    state.conn.status = status;
    bus.emit('net:status');
  }

  private heartbeat(): void {
    if (!this.online) return;
    const now = performance.now();
    if (now - this.lastMessageAt > SILENCE_TIMEOUT_MS) {
      this.socket?.close();
      return;
    }
    this.send({ t: 'ping', c: now });
  }

  private send(msg: ClientMsg): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(msg));
  }

  // ------------------------------------------------------------------ incoming

  private onBinary(data: ArrayBuffer): void {
    if (new Uint8Array(data, 0, 1)[0] !== BIN.SNAPSHOT) return;
    const snap = decodeSnapshot(data);
    if (!snap) return;
    this.onSnapshot?.(snap, this.lastMessageAt);
  }

  private onText(text: string): void {
    let msg: ServerMsg;
    try {
      msg = JSON.parse(text) as ServerMsg;
    } catch {
      return;
    }
    switch (msg.t) {
      case 'welcome':
        this.welcomed = true;
        window.clearTimeout(this.connectTimer);
        this.session = { code: msg.code, token: msg.token };
        writeSession(this.session);
        state.conn.code = msg.code;
        state.conn.slot = msg.slot;
        state.conn.lastError = null;
        this.setStatus('online');
        break;
      case 'roster':
        state.roster = msg.players;
        state.oath = msg.oath;
        bus.emit('state:roster');
        break;
      case 'run': {
        const previousPhase: RunPhase | null = state.run?.phase ?? null;
        state.run = msg.state;
        this.updateScreen();
        bus.emit('state:run', { previousPhase });
        break;
      }
      case 'draft':
        state.draft = msg.options;
        state.draftRerolls = msg.rerolls;
        state.draftKeystone = msg.keystone ?? null;
        bus.emit('state:draft');
        break;
      case 'ev':
        for (const event of msg.events) bus.emit('game:event', event);
        break;
      case 'pong': {
        const rtt = Math.max(0, performance.now() - msg.c);
        state.conn.pingMs = state.conn.pingMs === 0 ? rtt : state.conn.pingMs + (rtt - state.conn.pingMs) * PING_SMOOTHING;
        break;
      }
      case 'error':
        if (msg.fatal || !this.welcomed) this.fail(msg.code);
        else bus.emit('net:error', { error: msg.code, fatal: false });
        break;
    }
  }

  private updateScreen(): void {
    let screen: Screen = state.screen;
    if (state.conn.status === 'offline') screen = 'menu';
    else if (state.run) {
      const phase = state.run.phase;
      screen = phase === 'lobby' ? 'lobby' : phase === 'victory' || phase === 'defeat' ? 'summary' : 'game';
    }
    if (screen !== state.screen) {
      state.screen = screen;
      bus.emit('state:screen');
    }
  }

  dispose(): void {
    window.clearInterval(this.pingTimer);
    this.teardown();
  }
}
