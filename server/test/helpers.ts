/** Test helpers: an in-process server on a free port and a tiny promise-based WebSocket client. */
import WebSocket from 'ws';
import { NET } from '@shared/constants.ts';
import { decodeSnapshot, encodeInput, type ClientMsg, type ServerMsg } from '@shared/protocol.ts';
import type { ClassId, InputCmd, Snapshot } from '@shared/types.ts';
import { startServer, type RunningServer, type ServerOptions } from '../src/main.ts';

export const V = NET.PROTOCOL_VERSION;

export async function boot(opts: ServerOptions = {}): Promise<RunningServer & { url: string }> {
  const server = await startServer({ port: 0, host: '127.0.0.1', log: false, ...opts });
  return { ...server, url: `ws://127.0.0.1:${server.port}` };
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

type MsgOf<T extends ServerMsg['t']> = Extract<ServerMsg, { t: T }>;

export class Client {
  ws: WebSocket;
  /** Every JSON message received, in order. */
  log: ServerMsg[] = [];
  /** Raw text of every JSON message (for secrecy checks). */
  raw: string[] = [];
  snapshots: Snapshot[] = [];
  closeCode = 0;
  private cursor = 0;
  private waiters: (() => void)[] = [];
  closed: Promise<number>;
  opened: Promise<void>;
  code = '';
  slot = -1;
  token = '';
  seq = 0;

  constructor(url: string, headers: Record<string, string> = {}) {
    this.ws = new WebSocket(url, { perMessageDeflate: false, headers });
    this.opened = new Promise((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', reject);
      this.ws.once('unexpected-response', (_req, res) => reject(new Error(`http ${res.statusCode}`)));
    });
    this.closed = new Promise((resolve) => {
      this.ws.once('close', (code) => {
        this.closeCode = code;
        resolve(code);
        this.wake();
      });
    });
    this.ws.on('error', () => undefined);
    this.ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const snap = decodeSnapshot(data as Buffer);
        if (snap) this.snapshots.push(snap);
      } else {
        const text = (data as Buffer).toString('utf8');
        this.raw.push(text);
        this.log.push(JSON.parse(text) as ServerMsg);
      }
      this.wake();
    });
  }

  private wake(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const fn of w) fn();
  }

  static async open(url: string, headers: Record<string, string> = {}): Promise<Client> {
    const c = new Client(url, headers);
    await c.opened;
    return c;
  }

  send(msg: ClientMsg | Record<string, unknown>): void {
    this.ws.send(JSON.stringify(msg));
  }

  sendRaw(data: string | Uint8Array): void {
    this.ws.send(data);
  }

  input(partial: Partial<InputCmd> = {}): void {
    this.ws.send(encodeInput({ seq: ++this.seq, moveX: 0, moveZ: 0, aim: 0, aimDist: 0, buttons: 0, ...partial }));
  }

  /** Next not-yet-consumed message of type `t` (optionally matching `pred`). Rejects after `timeout` ms. */
  async next<T extends ServerMsg['t']>(t: T, pred: (m: MsgOf<T>) => boolean = () => true, timeout = 4000): Promise<MsgOf<T>> {
    const deadline = Date.now() + timeout;
    for (;;) {
      for (let i = this.cursor; i < this.log.length; i++) {
        const m = this.log[i]!;
        if (m.t === t && pred(m as MsgOf<T>)) {
          this.cursor = i + 1;
          return m as MsgOf<T>;
        }
      }
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timeout waiting for "${t}" (got: ${this.log.slice(this.cursor).map((m) => m.t).join(',')})`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.waiters.push(() => { clearTimeout(timer); resolve(); });
      });
    }
  }

  /** Waits until `pred` holds (checked on every incoming message). */
  async until(pred: () => boolean, timeout = 4000, what = 'condition'): Promise<void> {
    const deadline = Date.now() + timeout;
    while (!pred()) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timeout waiting for ${what}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(left, 50));
        this.waiters.push(() => { clearTimeout(timer); resolve(); });
      });
    }
  }

  /** Messages of a type received so far (does not consume). */
  all<T extends ServerMsg['t']>(t: T): MsgOf<T>[] {
    return this.log.filter((m): m is MsgOf<T> => m.t === t);
  }

  last<T extends ServerMsg['t']>(t: T): MsgOf<T> | undefined {
    const list = this.all(t);
    return list[list.length - 1];
  }

  async create(name = 'Host', cls: ClassId = 'knight'): Promise<MsgOf<'welcome'>> {
    this.send({ t: 'create', v: V, name, cls });
    return this.welcomed();
  }

  async join(code: string, name = 'Guest', cls: ClassId = 'mage'): Promise<MsgOf<'welcome'>> {
    this.send({ t: 'join', v: V, code, name, cls });
    return this.welcomed();
  }

  async rejoin(code: string, token: string): Promise<MsgOf<'welcome'>> {
    this.send({ t: 'rejoin', v: V, code, token });
    return this.welcomed();
  }

  private async welcomed(): Promise<MsgOf<'welcome'>> {
    const w = await this.next('welcome');
    this.code = w.code;
    this.slot = w.slot;
    this.token = w.token;
    return w;
  }

  close(): Promise<number> {
    this.ws.close();
    return this.closed;
  }

  /** Kills the TCP connection without a close handshake (network drop). */
  drop(): Promise<number> {
    this.ws.terminate();
    return this.closed;
  }
}

/** Host + guests in one lobby, everybody ready. */
export async function lobby(url: string, guests: ClassId[] = ['mage']): Promise<Client[]> {
  const host = await Client.open(url);
  await host.create('Host', 'knight');
  const clients = [host];
  for (const [i, cls] of guests.entries()) {
    const c = await Client.open(url);
    await c.join(host.code, `Guest${i + 1}`, cls);
    c.send({ t: 'lobby', ready: true });
    clients.push(c);
  }
  await host.until(() => {
    const r = host.last('roster');
    return r !== undefined && r.players.length === clients.length && r.players.every((p) => p.ready || p.host);
  }, 4000, 'everyone ready');
  return clients;
}

export async function startRun(clients: Client[]): Promise<void> {
  clients[0]!.send({ t: 'start' });
  await Promise.all(clients.map((c) => c.next('run', (m) => m.state.phase === 'combat')));
}
