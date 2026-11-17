/**
 * Hero movement shared by the authoritative server and the predicting client.
 * Both sides MUST call exactly these functions with the same fixed dt (TICK_DT) so prediction matches.
 */
import { WORLD } from '../constants.ts';
import { DASH } from '../data/classes.ts';
import type { RoomLayout } from '../types.ts';

export interface MoveBody {
  x: number;
  z: number;
  dashTime: number;
  dashDirX: number;
  dashDirZ: number;
  rootTime: number;
  moveSpeed: number;
}

/** Keeps a circle inside the room rectangle and outside every obstacle. Mutates and returns `pos`. */
export function resolveCollisions<T extends { x: number; z: number }>(pos: T, radius: number, room: RoomLayout): T {
  const hx = room.w / 2 - radius;
  const hz = room.d / 2 - radius;
  for (let pass = 0; pass < 2; pass++) {
    for (const o of room.obstacles) {
      const dx = pos.x - o.x;
      const dz = pos.z - o.z;
      const min = o.r + radius;
      const d2 = dx * dx + dz * dz;
      if (d2 >= min * min) continue;
      if (d2 < 1e-8) { pos.x = o.x + min; continue; }
      const d = Math.sqrt(d2);
      pos.x = o.x + (dx / d) * min;
      pos.z = o.z + (dz / d) * min;
    }
    if (pos.x < -hx) pos.x = -hx; else if (pos.x > hx) pos.x = hx;
    if (pos.z < -hz) pos.z = -hz; else if (pos.z > hz) pos.z = hz;
  }
  return pos;
}

/**
 * Starts a dash in the move direction (or the aim direction when standing still).
 * The caller is responsible for checking charges / state before calling.
 */
export function startDash(body: MoveBody, moveX: number, moveZ: number, aim: number): void {
  let dx = moveX;
  let dz = moveZ;
  const len = Math.hypot(dx, dz);
  if (len < 0.15) { dx = Math.sin(aim); dz = Math.cos(aim); } else { dx /= len; dz /= len; }
  body.dashDirX = dx;
  body.dashDirZ = dz;
  body.dashTime = DASH.DURATION;
  body.rootTime = 0;
}

/** Advances one fixed step. `moveX/moveZ` is the raw input direction (-1..1 each). */
export function stepMovement(body: MoveBody, moveX: number, moveZ: number, dt: number, room: RoomLayout): void {
  if (body.dashTime > 0) {
    const t = Math.min(dt, body.dashTime);
    body.x += body.dashDirX * DASH.SPEED * t;
    body.z += body.dashDirZ * DASH.SPEED * t;
    body.dashTime = Math.max(0, body.dashTime - dt);
  } else if (body.rootTime > 0) {
    body.rootTime = Math.max(0, body.rootTime - dt);
  } else {
    const len = Math.hypot(moveX, moveZ);
    if (len > 0.01) {
      const scale = (len > 1 ? 1 / len : 1) * body.moveSpeed * dt;
      body.x += moveX * scale;
      body.z += moveZ * scale;
    }
  }
  resolveCollisions(body, WORLD.PLAYER_RADIUS, room);
}
