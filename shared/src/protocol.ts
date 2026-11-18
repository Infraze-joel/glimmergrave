/**
 * Wire protocol.
 *  - Control messages and gameplay events are JSON text frames (low frequency, reliable, easy to validate).
 *  - Input (client -> server) and snapshots (server -> client) are compact binary frames (high frequency).
 * All multi-byte numbers are little-endian.
 */
import { NET, RUN, WORLD } from './constants.ts';
import { CLASSES } from './data/classes.ts';
import { sanitizeArt, sanitizeMastery, sanitizeTalents } from './data/mastery.ts';
import { sanitizeLook, sanitizeMeta, sanitizeParagon } from './data/meta.ts';
import { relicSlots, sanitizeRelics } from './data/relics.ts';
import {
  CLASS_IDS, ENEMY_ANIMS, ENEMY_KINDS, PLAYER_ANIMS, PLAYER_STATES, PROJECTILE_KINDS,
  type BoonOffer, type ClassId, type EnemySnap, type GameEvent, type InputCmd, type Loadout, type PlayerSnap,
  type ProjectileSnap, type RosterEntry, type RunState, type SelfState, type Snapshot,
} from './types.ts';

// ---------------------------------------------------------------- JSON messages

export type ClientMsg =
  /** `tutorial: true` creates a solo training session that cannot be joined. */
  | { t: 'create'; v: number; name: string; cls: ClassId; loadout: Loadout; tutorial?: boolean }
  | { t: 'join'; v: number; code: string; name: string; cls: ClassId; loadout: Loadout }
  /** Resume a slot after a disconnect or page reload. */
  | { t: 'rejoin'; v: number; code: string; token: string }
  /**
   * Lobby changes. `oath` is honoured for the host only. `loadout` replaces look, upgrades, mastery, art, talents
   * and relics (lobby only) and is only valid together with `cls` — send the current class if it did not change.
   */
  | { t: 'lobby'; cls?: ClassId; ready?: boolean; oath?: number; loadout?: Loadout }
  /** Host only; requires every connected player to be ready. */
  | { t: 'start' }
  /** Draft choice: index into the last `draft` message's options. */
  | { t: 'pick'; index: number }
  /** Spend one draft reroll (from the `insight` upgrade): replaces the current draft options. */
  | { t: 'reroll' }
  /** Host only, after victory / defeat: reset the room to the lobby. */
  | { t: 'toLobby' }
  | { t: 'leave' }
  | { t: 'ping'; c: number };

export const ERROR_CODES = [
  'bad_version', 'room_not_found', 'room_full', 'run_in_progress', 'invalid_name', 'invalid_message',
  'rate_limited', 'not_host', 'not_ready', 'session_expired', 'server_full', 'timeout',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export type ServerMsg =
  /** Sent once after create / join / rejoin. `token` is the secret needed to rejoin this slot. */
  | { t: 'welcome'; code: string; slot: number; token: string }
  /** Full roster; sent on every roster / lobby / boon change. */
  | { t: 'roster'; players: RosterEntry[]; oath: number }
  /** Full run state; sent on every structural change and ~4x per second during `draft` and `doors`. */
  | { t: 'run'; state: RunState }
  /** Private: the receiving player's current draft options ([] = nothing to pick) and rerolls left this run. */
  | { t: 'draft'; options: BoonOffer[]; rerolls: number }
  /** Gameplay events that happened up to `tick`. */
  | { t: 'ev'; tick: number; events: GameEvent[] }
  /** `c` echoes the client's timestamp, `s` is the server time (ms). */
  | { t: 'pong'; c: number; s: number }
  /** `fatal` errors are followed by the server closing the socket. */
  | { t: 'error'; code: ErrorCode; fatal: boolean };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const isClass = (v: unknown): v is ClassId => typeof v === 'string' && (CLASS_IDS as readonly string[]).includes(v);

/** Trims, collapses whitespace and strips control characters. Returns null if nothing printable is left. */
export function sanitizeName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  const name = raw.replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, NET.MAX_NAME_LENGTH);
  return name.length > 0 ? name : null;
}

export function normalizeRoomCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const code = raw.trim().toUpperCase();
  if (code.length !== NET.ROOM_CODE_LENGTH) return null;
  for (const ch of code) if (!NET.ROOM_CODE_ALPHABET.includes(ch)) return null;
  return code;
}

/** Untrusted loadout -> valid loadout. Never fails: anything malformed falls back to defaults / level 0. */
export function sanitizeLoadout(raw: unknown, cls: ClassId): Loadout {
  const r = isObj(raw) ? raw : {};
  const meta = sanitizeMeta(r.meta);
  const mastery = sanitizeMastery(r.mastery);
  return {
    look: sanitizeLook(r.look),
    meta,
    paragon: sanitizeParagon(r.paragon),
    mastery,
    art: sanitizeArt(r.art, mastery, CLASSES[cls].arts.length),
    talents: sanitizeTalents(r.talents, mastery),
    relics: sanitizeRelics(r.relics, relicSlots(meta)),
  };
}

/** Strict validation of an untrusted, already JSON-parsed client message. Returns null if invalid. */
export function parseClientMsg(raw: unknown): ClientMsg | null {
  if (!isObj(raw) || typeof raw.t !== 'string') return null;
  switch (raw.t) {
    case 'create': {
      const name = sanitizeName(raw.name);
      if (!isInt(raw.v, 0, 1e6) || !name || !isClass(raw.cls)) return null;
      return { t: 'create', v: raw.v, name, cls: raw.cls, loadout: sanitizeLoadout(raw.loadout, raw.cls), tutorial: raw.tutorial === true };
    }
    case 'join': {
      const name = sanitizeName(raw.name);
      const code = normalizeRoomCode(raw.code);
      if (!isInt(raw.v, 0, 1e6) || !name || !code || !isClass(raw.cls)) return null;
      return { t: 'join', v: raw.v, code, name, cls: raw.cls, loadout: sanitizeLoadout(raw.loadout, raw.cls) };
    }
    case 'rejoin': {
      const code = normalizeRoomCode(raw.code);
      if (!isInt(raw.v, 0, 1e6) || !code || typeof raw.token !== 'string' || raw.token.length < 8 || raw.token.length > 64) return null;
      return { t: 'rejoin', v: raw.v, code, token: raw.token };
    }
    case 'lobby': {
      const msg: ClientMsg = { t: 'lobby' };
      if (raw.cls !== undefined) { if (!isClass(raw.cls)) return null; msg.cls = raw.cls; }
      if (raw.ready !== undefined) { if (typeof raw.ready !== 'boolean') return null; msg.ready = raw.ready; }
      if (raw.oath !== undefined) { if (!isInt(raw.oath, 0, RUN.OATH_MAX)) return null; msg.oath = raw.oath; }
      // A loadout belongs to a class: a class change must bring its loadout along (see the ClientMsg comment).
      if (raw.loadout !== undefined) { if (msg.cls === undefined) return null; msg.loadout = sanitizeLoadout(raw.loadout, msg.cls); }
      return msg;
    }
    case 'start': return { t: 'start' };
    case 'pick': return isInt(raw.index, 0, 7) ? { t: 'pick', index: raw.index } : null;
    case 'reroll': return { t: 'reroll' };
    case 'toLobby': return { t: 'toLobby' };
    case 'leave': return { t: 'leave' };
    case 'ping': return typeof raw.c === 'number' && Number.isFinite(raw.c) ? { t: 'ping', c: raw.c } : null;
    default: return null;
  }
}

// ---------------------------------------------------------------- binary frames

export const BIN = { INPUT: 1, SNAPSHOT: 2 } as const;

const TAU = Math.PI * 2;
const clamp = (v: number, min: number, max: number): number => (v < min ? min : v > max ? max : v);
const wrapAngle = (a: number): number => ((a % TAU) + TAU) % TAU;
const q8 = (frac: number): number => Math.round(clamp(frac, 0, 1) * 255);
const qPos = (v: number): number => clamp(Math.round(v * WORLD.POS_SCALE), -32768, 32767);

export const INPUT_BYTES = 11;

export function encodeInput(cmd: InputCmd): ArrayBuffer {
  const buf = new ArrayBuffer(INPUT_BYTES);
  const dv = new DataView(buf);
  dv.setUint8(0, BIN.INPUT);
  dv.setUint32(1, cmd.seq >>> 0, true);
  dv.setInt8(5, Math.round(clamp(cmd.moveX, -1, 1) * 127));
  dv.setInt8(6, Math.round(clamp(cmd.moveZ, -1, 1) * 127));
  dv.setUint16(7, Math.round((wrapAngle(cmd.aim) / TAU) * 65535), true);
  dv.setUint8(9, Math.round(clamp(cmd.aimDist, 0, 25.5) * 10));
  dv.setUint8(10, cmd.buttons & 0xff);
  return buf;
}

/** Returns null for malformed frames. Never throws. */
export function decodeInput(data: ArrayBuffer | Uint8Array): InputCmd | null {
  const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (u8.byteLength !== INPUT_BYTES || u8[0] !== BIN.INPUT) return null;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  return {
    seq: dv.getUint32(1, true),
    moveX: dv.getInt8(5) / 127,
    moveZ: dv.getInt8(6) / 127,
    aim: (dv.getUint16(7, true) / 65535) * TAU,
    aimDist: dv.getUint8(9) / 10,
    buttons: dv.getUint8(10),
  };
}

const SELF_BYTES = 19;
const PLAYER_BYTES = 19;
const ENEMY_BYTES = 12;
const PROJECTILE_BYTES = 8;

export interface SnapshotBody {
  tick: number;
  players: PlayerSnap[];
  enemies: EnemySnap[];
  projectiles: ProjectileSnap[];
}

/**
 * Encodes the part of a snapshot that is identical for every client. Encode once per tick, then combine
 * with each client's SelfState via `encodeSnapshot`.
 */
export function encodeSnapshotBody(body: SnapshotBody): Uint8Array {
  const { players, enemies, projectiles } = body;
  const out = new Uint8Array(3 + players.length * PLAYER_BYTES + enemies.length * ENEMY_BYTES + projectiles.length * PROJECTILE_BYTES);
  const dv = new DataView(out.buffer);
  let o = 0;
  dv.setUint8(o++, players.length);
  for (const p of players) {
    dv.setUint8(o, p.slot);
    dv.setInt16(o + 1, qPos(p.x), true);
    dv.setInt16(o + 3, qPos(p.z), true);
    dv.setUint8(o + 5, Math.round((wrapAngle(p.rot) / TAU) * 255));
    dv.setUint16(o + 6, clamp(Math.round(p.hp), 0, 65535), true);
    dv.setUint16(o + 8, clamp(Math.round(p.maxHp), 0, 65535), true);
    dv.setUint16(o + 10, clamp(Math.round(p.shield), 0, 65535), true);
    dv.setUint8(o + 12, (PLAYER_STATES.indexOf(p.state) << 6) | PLAYER_ANIMS.indexOf(p.anim));
    dv.setUint8(o + 13, p.animSeq & 0xff);
    dv.setUint8(o + 14, q8(p.cdSecondary));
    dv.setUint8(o + 15, q8(p.cdDash));
    dv.setUint8(o + 16, ((p.dashCharges & 0x0f) << 4) | Math.round(clamp(p.revive, 0, 1) * 15));
    dv.setUint8(o + 17, p.flags & 0xff);
    dv.setUint8(o + 18, q8(p.ult));
    o += PLAYER_BYTES;
  }
  dv.setUint8(o++, enemies.length);
  for (const e of enemies) {
    dv.setUint16(o, e.id & 0xffff, true);
    dv.setUint8(o + 2, ENEMY_KINDS.indexOf(e.kind));
    dv.setInt16(o + 3, qPos(e.x), true);
    dv.setInt16(o + 5, qPos(e.z), true);
    dv.setUint8(o + 7, Math.round((wrapAngle(e.rot) / TAU) * 255));
    dv.setUint8(o + 8, e.hp > 0 ? Math.max(1, q8(e.hp)) : 0);
    dv.setUint8(o + 9, ENEMY_ANIMS.indexOf(e.anim));
    dv.setUint8(o + 10, e.animSeq & 0xff);
    dv.setUint8(o + 11, e.flags & 0xff);
    o += ENEMY_BYTES;
  }
  dv.setUint8(o++, projectiles.length);
  for (const p of projectiles) {
    dv.setUint16(o, p.id & 0xffff, true);
    dv.setUint8(o + 2, PROJECTILE_KINDS.indexOf(p.kind) | ((p.element & 7) << 4) | (p.hostile ? 0x80 : 0));
    dv.setInt16(o + 3, qPos(p.x), true);
    dv.setInt16(o + 5, qPos(p.z), true);
    dv.setUint8(o + 7, Math.round((wrapAngle(p.rot) / TAU) * 255));
    o += PROJECTILE_BYTES;
  }
  return out;
}

export function encodeSnapshot(tick: number, self: SelfState, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(1 + 4 + SELF_BYTES + body.byteLength);
  const dv = new DataView(out.buffer);
  dv.setUint8(0, BIN.SNAPSHOT);
  dv.setUint32(1, tick >>> 0, true);
  dv.setUint32(5, self.ackSeq >>> 0, true);
  dv.setFloat32(9, self.x, true);
  dv.setFloat32(13, self.z, true);
  dv.setUint8(17, Math.round(clamp(self.dashTime, 0, 2.55) * 100));
  dv.setInt8(18, Math.round(clamp(self.dashDirX, -1, 1) * 127));
  dv.setInt8(19, Math.round(clamp(self.dashDirZ, -1, 1) * 127));
  dv.setUint8(20, Math.round(clamp(self.rootTime, 0, 5.1) * 50));
  dv.setUint16(21, Math.round(clamp(self.moveSpeed, 0, 655) * 100), true);
  out.set(body, 1 + 4 + SELF_BYTES);
  return out;
}

/** Returns null for malformed frames. Never throws. */
export function decodeSnapshot(data: ArrayBuffer | Uint8Array): Snapshot | null {
  const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (u8.byteLength < 1 + 4 + SELF_BYTES + 3 || u8[0] !== BIN.SNAPSHOT) return null;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const end = u8.byteLength;
  const tick = dv.getUint32(1, true);
  const self: SelfState = {
    ackSeq: dv.getUint32(5, true),
    x: dv.getFloat32(9, true),
    z: dv.getFloat32(13, true),
    dashTime: dv.getUint8(17) / 100,
    dashDirX: dv.getInt8(18) / 127,
    dashDirZ: dv.getInt8(19) / 127,
    rootTime: dv.getUint8(20) / 50,
    moveSpeed: dv.getUint16(21, true) / 100,
  };
  let o = 1 + 4 + SELF_BYTES;
  const S = WORLD.POS_SCALE;
  const players: PlayerSnap[] = [];
  const nPlayers = dv.getUint8(o++);
  if (o + nPlayers * PLAYER_BYTES > end) return null;
  for (let i = 0; i < nPlayers; i++, o += PLAYER_BYTES) {
    const sa = dv.getUint8(o + 12);
    const cr = dv.getUint8(o + 16);
    players.push({
      slot: dv.getUint8(o),
      x: dv.getInt16(o + 1, true) / S,
      z: dv.getInt16(o + 3, true) / S,
      rot: (dv.getUint8(o + 5) / 255) * TAU,
      hp: dv.getUint16(o + 6, true),
      maxHp: dv.getUint16(o + 8, true),
      shield: dv.getUint16(o + 10, true),
      state: PLAYER_STATES[sa >> 6] ?? 'alive',
      anim: PLAYER_ANIMS[sa & 0x3f] ?? 'idle',
      animSeq: dv.getUint8(o + 13),
      cdSecondary: dv.getUint8(o + 14) / 255,
      cdDash: dv.getUint8(o + 15) / 255,
      dashCharges: cr >> 4,
      revive: (cr & 0x0f) / 15,
      flags: dv.getUint8(o + 17),
      ult: dv.getUint8(o + 18) / 255,
    });
  }
  if (o >= end) return null;
  const enemies: EnemySnap[] = [];
  const nEnemies = dv.getUint8(o++);
  if (o + nEnemies * ENEMY_BYTES > end) return null;
  for (let i = 0; i < nEnemies; i++, o += ENEMY_BYTES) {
    enemies.push({
      id: dv.getUint16(o, true),
      kind: ENEMY_KINDS[dv.getUint8(o + 2)] ?? 'minion',
      x: dv.getInt16(o + 3, true) / S,
      z: dv.getInt16(o + 5, true) / S,
      rot: (dv.getUint8(o + 7) / 255) * TAU,
      hp: dv.getUint8(o + 8) / 255,
      anim: ENEMY_ANIMS[dv.getUint8(o + 9)] ?? 'idle',
      animSeq: dv.getUint8(o + 10),
      flags: dv.getUint8(o + 11),
    });
  }
  if (o >= end) return null;
  const projectiles: ProjectileSnap[] = [];
  const nProj = dv.getUint8(o++);
  if (o + nProj * PROJECTILE_BYTES !== end) return null;
  for (let i = 0; i < nProj; i++, o += PROJECTILE_BYTES) {
    const ke = dv.getUint8(o + 2);
    projectiles.push({
      id: dv.getUint16(o, true),
      kind: PROJECTILE_KINDS[ke & 0x0f] ?? 'arcBolt',
      element: (ke >> 4) & 7,
      hostile: (ke & 0x80) !== 0,
      x: dv.getInt16(o + 3, true) / S,
      z: dv.getInt16(o + 5, true) / S,
      rot: (dv.getUint8(o + 7) / 255) * TAU,
    });
  }
  return { tick, self, players, enemies, projectiles };
}
