/** Small allocation-free 2D helpers for the XZ plane. Angles follow InputCmd.aim: atan2(x, z), 0 faces +Z. */
export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export const clamp = (v: number, min: number, max: number): number => (v < min ? min : v > max ? max : v);

/** NaN / Infinity / non-numbers become 0. */
export const finite = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Smallest signed difference a - b, in (-PI, PI]. */
export function angleDiff(a: number, b: number): number {
  let d = (a - b) % TAU;
  if (d > Math.PI) d -= TAU;
  else if (d <= -Math.PI) d += TAU;
  return d;
}

export const angleTo = (fromX: number, fromZ: number, toX: number, toZ: number): number =>
  Math.atan2(toX - fromX, toZ - fromZ);

export const dist = (ax: number, az: number, bx: number, bz: number): number => Math.hypot(ax - bx, az - bz);

export const dist2 = (ax: number, az: number, bx: number, bz: number): number => {
  const dx = ax - bx;
  const dz = az - bz;
  return dx * dx + dz * dz;
};

/** Parameter t in [0, 1] of the point on segment a->b that is closest to p. */
export function closestT(ax: number, az: number, bx: number, bz: number, px: number, pz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  if (len2 < 1e-12) return 0;
  return clamp(((px - ax) * dx + (pz - az) * dz) / len2, 0, 1);
}

/** Distance from point p to segment a->b. */
export function segDist(ax: number, az: number, bx: number, bz: number, px: number, pz: number): number {
  const t = closestT(ax, az, bx, bz, px, pz);
  return Math.hypot(ax + (bx - ax) * t - px, az + (bz - az) * t - pz);
}

/**
 * First parameter t in [0, 1] at which a point moving a->b comes within `r` of the centre c,
 * or -1 if it never does. Returns 0 when the segment starts inside the circle.
 */
export function sweepHit(ax: number, az: number, bx: number, bz: number, cx: number, cz: number, r: number): number {
  const fx = ax - cx;
  const fz = az - cz;
  const c = fx * fx + fz * fz - r * r;
  if (c <= 0) return 0;
  const dx = bx - ax;
  const dz = bz - az;
  const a = dx * dx + dz * dz;
  if (a < 1e-12) return -1;
  const b = 2 * (fx * dx + fz * dz);
  if (b >= 0) return -1;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return -1;
  const t = (-b - Math.sqrt(disc)) / (2 * a);
  return t >= 0 && t <= 1 ? t : -1;
}

/** Is p inside the circle sector at o facing `rot` with reach `reach` and total angle `arc` (radians)? `pad` widens it. */
export function inArc(ox: number, oz: number, rot: number, reach: number, arc: number, px: number, pz: number, pad: number): boolean {
  const dx = px - ox;
  const dz = pz - oz;
  const d = Math.hypot(dx, dz);
  if (d > reach + pad) return false;
  if (d <= pad || arc >= TAU) return true;
  const off = Math.abs(angleDiff(Math.atan2(dx, dz), rot));
  const slack = pad > 0 ? Math.asin(Math.min(1, pad / d)) : 0;
  return off <= arc / 2 + slack;
}

/** Is p inside the rectangle that starts at o, extends `length` along `rot` and is `width` wide? `pad` widens it. */
export function inLine(ox: number, oz: number, rot: number, length: number, width: number, px: number, pz: number, pad: number): boolean {
  const dirX = Math.sin(rot);
  const dirZ = Math.cos(rot);
  const dx = px - ox;
  const dz = pz - oz;
  const along = dx * dirX + dz * dirZ;
  if (along < -pad || along > length + pad) return false;
  const side = Math.abs(dx * dirZ - dz * dirX);
  return side <= width / 2 + pad;
}
