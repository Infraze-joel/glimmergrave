/**
 * Pooled visual effects: particles, timed ground decals (telegraphs, shockwaves, slashes, runes) and floating
 * damage numbers. Nothing here allocates per frame; everything renders through the shared batches.
 */
import { Color } from 'three';
import type { Atlas, UvRect } from './atlas.ts';
import { DECAL, SPRITE } from './batches.ts';
import type { BillboardBatch, DecalBatch } from './batches.ts';
import { LIMITS, PALETTE } from './config.ts';

const FX = {
  TELEGRAPH_FLASH: 0.22,
  TELEGRAPH_Y: 0.06,
  NUMBER_LIFE: 0.85,
  NUMBER_RISE: 1.9,
  NUMBER_SIZE: 0.62,
  GRAVITY: 9,
  WORD_HEIGHT: 0.92,
  WORD_LIFE: 1.15,
} as const;

/** Linear RGB triplets of a hex colour, cached so effects never allocate. */
const rgbCache = new Map<number, readonly [number, number, number]>();
const _c = new Color();
export function rgb(hex: number): readonly [number, number, number] {
  let v = rgbCache.get(hex);
  if (!v) {
    _c.setHex(hex);
    v = [_c.r, _c.g, _c.b];
    rgbCache.set(hex, v);
  }
  return v;
}

export const TIMED = { TELEGRAPH: 0, RING: 1, SLASH: 2, RUNE: 3, FLASH: 4, STREAK: 5, DUO: 6, BEAM: 7 } as const;

interface TimedDecal {
  active: boolean;
  kind: number;
  shape: number;
  x: number; y: number; z: number; rot: number;
  /** Start / end size (round shapes: diameter). */
  s0: number; s1: number; sz: number;
  age: number; dur: number;
  r: number; g: number; b: number; a: number;
  /** Second colour (two-colour shockwaves). */
  r2: number; g2: number; b2: number;
  additive: number;
  p1: number; p2: number;
  /** Hero slot to follow (-1 = fixed in the world). */
  follow: number;
}

/** A short-lived atlas sprite that pops, floats up and fades: status icon bursts and the Resonance word mark. */
interface Floater {
  active: boolean;
  x: number; y: number; z: number;
  age: number; life: number;
  uv: UvRect;
  w: number; h: number;
  ox: number;
  r: number; g: number; b: number;
  rise: number;
  /** Extra white flash at the start (0..1). */
  hot: number;
}

interface DamageNumber {
  active: boolean;
  x: number; y: number; z: number;
  age: number; life: number;
  digits: number[];
  n: number;
  /** 0 none, 1 '+', 2 '!' suffix */
  deco: number;
  r: number; g: number; b: number;
  size: number;
  drift: number;
}

export interface FollowSource {
  position(slot: number, out: { x: number; z: number; rot: number }): boolean;
}

export class Vfx {
  /** Scales cosmetic particle counts (quality). */
  density = 1;
  numbersEnabled = true;

  private readonly atlas: Atlas;
  private readonly n = LIMITS.PARTICLES;
  private readonly px = new Float32Array(this.n);
  private readonly py = new Float32Array(this.n);
  private readonly pz = new Float32Array(this.n);
  private readonly vx = new Float32Array(this.n);
  private readonly vy = new Float32Array(this.n);
  private readonly vz = new Float32Array(this.n);
  private readonly age = new Float32Array(this.n);
  private readonly life = new Float32Array(this.n);
  private readonly s0 = new Float32Array(this.n);
  private readonly s1 = new Float32Array(this.n);
  private readonly cr = new Float32Array(this.n);
  private readonly cg = new Float32Array(this.n);
  private readonly cb = new Float32Array(this.n);
  private readonly ca = new Float32Array(this.n);
  private readonly mode = new Uint8Array(this.n);
  private readonly add = new Float32Array(this.n);
  private readonly grav = new Float32Array(this.n);
  private readonly drag = new Float32Array(this.n);
  private readonly spin = new Float32Array(this.n);
  private readonly par = new Float32Array(this.n);
  private readonly rot0 = new Float32Array(this.n);
  private cursor = 0;
  private alive = 0;

  private readonly timed: TimedDecal[] = [];
  private timedCursor = 0;
  private readonly numbers: DamageNumber[] = [];
  private numberCursor = 0;
  private readonly floaters: Floater[] = [];
  private floaterCursor = 0;
  private readonly followOut = { x: 0, z: 0, rot: 0 };

  constructor(atlas: Atlas) {
    this.atlas = atlas;
    for (let i = 0; i < LIMITS.TELEGRAPHS + LIMITS.BURSTS; i++) {
      this.timed.push({
        active: false, kind: 0, shape: 0, x: 0, y: 0, z: 0, rot: 0, s0: 0, s1: 0, sz: 0, age: 0, dur: 1,
        r: 1, g: 1, b: 1, a: 1, r2: 1, g2: 1, b2: 1, additive: 0, p1: 0, p2: 0, follow: -1,
      });
    }
    for (let i = 0; i < LIMITS.FLOATERS; i++) {
      this.floaters.push({ active: false, x: 0, y: 0, z: 0, age: 0, life: 1, uv: atlas.plus, w: 1, h: 1, ox: 0, r: 1, g: 1, b: 1, rise: 1, hot: 0 });
    }
    for (let i = 0; i < LIMITS.DAMAGE_NUMBERS; i++) {
      this.numbers.push({ active: false, x: 0, y: 0, z: 0, age: 0, life: 1, digits: [0, 0, 0, 0, 0], n: 0, deco: 0, r: 1, g: 1, b: 1, size: 1, drift: 0 });
    }
  }

  get particleCount(): number {
    return this.alive;
  }

  // ---------------------------------------------------------------- particles

  particle(
    x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, s0: number, s1: number,
    r: number, g: number, b: number, a: number, mode: number, additive: number, gravity = 0, drag = 0, spin = 0, param = 0, rot = 0,
  ): void {
    const i = this.cursor;
    this.cursor = (i + 1) % this.n;
    this.px[i] = x; this.py[i] = y; this.pz[i] = z;
    this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
    this.age[i] = 0; this.life[i] = life;
    this.s0[i] = s0; this.s1[i] = s1;
    this.cr[i] = r; this.cg[i] = g; this.cb[i] = b; this.ca[i] = a;
    this.mode[i] = mode; this.add[i] = additive; this.grav[i] = gravity; this.drag[i] = drag; this.spin[i] = spin;
    this.par[i] = param; this.rot0[i] = rot;
  }

  /** Short lightning bolts crackling outwards from a point (Storm). */
  arcs(x: number, y: number, z: number, hex: number, count: number, reach: number): void {
    const c = rgb(hex);
    const n = Math.max(1, Math.round(count * (0.6 + 0.4 * this.density)));
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const d = reach * (0.25 + Math.random() * 0.5);
      const len = reach * (0.7 + Math.random() * 0.7);
      this.particle(x + Math.sin(a) * d, y + Math.random() * 0.8, z + Math.cos(a) * d, Math.sin(a) * 2, 0.5, Math.cos(a) * 2,
        0.1 + Math.random() * 0.14, len, len * 0.8, c[0] * 2.2 + 0.4, c[1] * 2.2 + 0.4, c[2] * 2.2 + 0.4, 1, SPRITE.ARC, 1, 0, 0, 0,
        Math.random() * 60, (Math.random() - 0.5) * 2.6);
    }
  }

  /** Tongues of fire that leap up and die (Ember). */
  flames(x: number, y: number, z: number, hex: number, count: number, radius: number, size: number): void {
    const c = rgb(hex);
    const n = Math.max(1, Math.round(count * (0.6 + 0.4 * this.density)));
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const d = Math.sqrt(Math.random()) * radius;
      const s = size * (0.7 + Math.random() * 0.6);
      this.particle(x + Math.sin(a) * d, y + s * 0.3, z + Math.cos(a) * d, Math.sin(a) * 0.8, 1.6 + Math.random() * 1.6, Math.cos(a) * 0.8,
        0.3 + Math.random() * 0.3, s, s * 0.45, c[0] * 1.9, c[1] * 1.9, c[2] * 1.9, 0.95, SPRITE.FLAME, 0.85, 0, 1.2, 0, Math.random());
    }
  }

  /** Slow, drifting crystals of frost (Rime). */
  frost(x: number, y: number, z: number, hex: number, count: number, radius: number): void {
    const c = rgb(hex);
    const n = Math.max(1, Math.round(count * this.density));
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const d = Math.sqrt(Math.random()) * radius;
      this.particle(x + Math.sin(a) * d, y + Math.random() * 1.2, z + Math.cos(a) * d, Math.sin(a) * 0.5, -0.25 - Math.random() * 0.3, Math.cos(a) * 0.5,
        0.9 + Math.random() * 0.8, 0.2 + Math.random() * 0.1, 0.05, c[0] * 1.3 + 0.7, c[1] * 1.3 + 0.7, c[2] * 1.3 + 0.7, 0.95, SPRITE.SPARK, 0.9, 0, 0.8,
        (Math.random() - 0.5) * 2.4);
    }
  }

  /** Hard-edged sparks flying outwards (hits, impacts). `dir` < 0 = all directions. */
  sparks(x: number, y: number, z: number, hex: number, count: number, speed: number, dir = -1, spread = Math.PI): void {
    const c = rgb(hex);
    const n = Math.max(1, Math.round(count * (0.5 + 0.5 * this.density)));
    for (let i = 0; i < n; i++) {
      const a = dir < 0 ? Math.random() * Math.PI * 2 : dir + (Math.random() - 0.5) * spread;
      const sp = speed * (0.45 + Math.random() * 0.75);
      const up = 1.5 + Math.random() * 3.5;
      const bright = 1.6 + Math.random() * 1.2;
      this.particle(x, y, z, Math.sin(a) * sp, up, Math.cos(a) * sp, 0.22 + Math.random() * 0.3, 0.26 + Math.random() * 0.14, 0.03,
        c[0] * bright, c[1] * bright, c[2] * bright, 1, SPRITE.SPARK, 1, FX.GRAVITY, 2.5, (Math.random() - 0.5) * 14);
    }
  }

  /** Slow rising motes (embers, soul-light, frost). */
  motes(x: number, y: number, z: number, hex: number, count: number, radius: number, rise = 1.4, life = 1): void {
    const c = rgb(hex);
    const n = Math.max(1, Math.round(count * this.density));
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const rr = Math.sqrt(Math.random()) * radius;
      const bright = 1.5 + Math.random();
      this.particle(x + Math.sin(a) * rr, y + Math.random() * 0.5, z + Math.cos(a) * rr, (Math.random() - 0.5) * 0.6, rise * (0.6 + Math.random() * 0.8),
        (Math.random() - 0.5) * 0.6, life * (0.6 + Math.random() * 0.7), 0.16 + Math.random() * 0.1, 0.02,
        c[0] * bright, c[1] * bright, c[2] * bright, 0.95, SPRITE.SPARK, 1, -0.6, 0.6, (Math.random() - 0.5) * 6);
    }
  }

  /** Soft non-additive dust / smoke. */
  puff(x: number, y: number, z: number, hex: number, count: number, radius: number, alpha = 0.3): void {
    const c = rgb(hex);
    const n = Math.max(1, Math.round(count * this.density));
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 0.6 + Math.random() * 1.6;
      this.particle(x + Math.sin(a) * radius * 0.4, y, z + Math.cos(a) * radius * 0.4, Math.sin(a) * sp, 0.4 + Math.random() * 0.8, Math.cos(a) * sp,
        0.45 + Math.random() * 0.4, 0.4 + Math.random() * 0.3, 1.1 + Math.random() * 0.5, c[0], c[1], c[2], alpha * 0.8, SPRITE.GLOW, 0, 0, 2.2);
    }
  }

  /** One big additive glow that fades quickly (muzzle flashes, impact bloom). */
  flash(x: number, y: number, z: number, hex: number, size: number, life = 0.18, intensity = 1.6): void {
    const c = rgb(hex);
    this.particle(x, y, z, 0, 0, 0, life, size, size * 1.5, c[0] * intensity, c[1] * intensity, c[2] * intensity, 0.9, SPRITE.GLOW, 1);
  }

  // ---------------------------------------------------------------- timed decals

  private timedSlot(): TimedDecal {
    for (let i = 0; i < this.timed.length; i++) {
      const j = (this.timedCursor + i) % this.timed.length;
      if (!this.timed[j].active) { this.timedCursor = (j + 1) % this.timed.length; return this.timed[j]; }
    }
    const t = this.timed[this.timedCursor];
    this.timedCursor = (this.timedCursor + 1) % this.timed.length;
    return t;
  }

  /** Hostile ground telegraph that fills over `dur` and flashes when it lands. */
  telegraph(shape: 'circle' | 'arc' | 'line', x: number, z: number, rot: number, r: number, w: number, dur: number): void {
    const t = this.timedSlot();
    const c = rgb(PALETTE.hostile);
    t.active = true; t.kind = TIMED.TELEGRAPH; t.age = 0; t.dur = Math.max(0.05, dur); t.follow = -1;
    t.r = c[0] * 1.5; t.g = c[1] * 1.5; t.b = c[2] * 1.5; t.a = 1; t.additive = 0.25; t.y = FX.TELEGRAPH_Y; t.rot = rot; t.p1 = 0; t.p2 = 0;
    if (shape === 'circle') {
      t.shape = DECAL.TELE_CIRCLE; t.x = x; t.z = z; t.s0 = t.s1 = r * 2; t.sz = r * 2;
    } else if (shape === 'arc') {
      t.shape = DECAL.TELE_ARC; t.x = x; t.z = z; t.s0 = t.s1 = r * 2; t.sz = r * 2; t.p2 = Math.min(Math.PI, w / 2);
    } else {
      t.shape = DECAL.TELE_LINE; t.x = x + Math.sin(rot) * r * 0.5; t.z = z + Math.cos(rot) * r * 0.5; t.s0 = t.s1 = w; t.sz = r;
    }
  }

  /** Expanding shockwave ring. */
  ring(x: number, z: number, d0: number, d1: number, dur: number, hex: number, thickness = 0.35, intensity = 1.5, delay = 0): void {
    const t = this.timedSlot();
    const c = rgb(hex);
    t.active = true; t.kind = TIMED.RING; t.shape = DECAL.SHOCK; t.age = -delay; t.dur = dur; t.follow = -1;
    t.x = x; t.y = 0.07; t.z = z; t.rot = 0; t.s0 = d0; t.s1 = d1; t.sz = 0;
    t.r = c[0] * intensity; t.g = c[1] * intensity; t.b = c[2] * intensity; t.a = 1; t.additive = 1; t.p1 = thickness; t.p2 = 0;
  }

  /** Expanding shockwave whose band swirls between two colours (Resonance). */
  duoRing(x: number, z: number, d0: number, d1: number, dur: number, hexA: number, hexB: number, thickness = 0.4, intensity = 2, delay = 0): void {
    const t = this.timedSlot();
    const a = rgb(hexA);
    const b = rgb(hexB);
    t.active = true; t.kind = TIMED.DUO; t.shape = DECAL.DUO; t.age = -delay; t.dur = dur; t.follow = -1;
    t.x = x; t.y = 0.075; t.z = z; t.rot = 0; t.s0 = d0; t.s1 = d1; t.sz = 0;
    t.r = a[0] * intensity; t.g = a[1] * intensity; t.b = a[2] * intensity; t.a = 1;
    t.r2 = b[0] * intensity; t.g2 = b[1] * intensity; t.b2 = b[2] * intensity;
    t.additive = 1; t.p1 = thickness; t.p2 = 0;
  }

  /** A ray that tears along a lane and burns out (the Matron's beams). Origin at the start, pointing along `rot`. */
  beam(x: number, z: number, rot: number, length: number, width: number, hexOuter: number, hexCore: number, delay = 0, dur = 0.42): void {
    const t = this.timedSlot();
    const a = rgb(hexOuter);
    const b = rgb(hexCore);
    t.active = true; t.kind = TIMED.BEAM; t.shape = DECAL.BEAM; t.age = -delay; t.dur = dur; t.follow = -1;
    t.x = x + Math.sin(rot) * length * 0.5; t.y = 1.1; t.z = z + Math.cos(rot) * length * 0.5; t.rot = rot;
    t.s0 = t.s1 = width; t.sz = length;
    t.r = a[0] * 1.7; t.g = a[1] * 1.7; t.b = a[2] * 1.7; t.a = 1;
    t.r2 = b[0] * 1.6 + 0.5; t.g2 = b[1] * 1.6 + 0.5; t.b2 = b[2] * 1.6 + 0.5;
    t.additive = 1; t.p1 = 0; t.p2 = 0;
  }

  /** Re-colours the swing arcs that currently follow a hero (their hits turned out to carry an element). */
  tintSlashes(slot: number, hex: number, intensity = 1.8): void {
    const c = rgb(hex);
    for (const t of this.timed) {
      if (!t.active || t.kind !== TIMED.SLASH || t.follow !== slot) continue;
      t.r = c[0] * intensity; t.g = c[1] * intensity; t.b = c[2] * intensity;
    }
  }

  /** Soft ground flash that grows and fades. */
  groundFlash(x: number, z: number, d: number, dur: number, hex: number, intensity = 1, delay = 0): void {
    const t = this.timedSlot();
    const c = rgb(hex);
    t.active = true; t.kind = TIMED.FLASH; t.shape = DECAL.DISC; t.age = -delay; t.dur = dur; t.follow = -1;
    t.x = x; t.y = 0.05; t.z = z; t.rot = 0; t.s0 = d * 0.7; t.s1 = d; t.sz = 0;
    t.r = c[0] * intensity; t.g = c[1] * intensity; t.b = c[2] * intensity; t.a = 0.7; t.additive = 1; t.p1 = 0.2; t.p2 = 0;
  }

  /** Weapon swing crescent. `dir` +1 sweeps right-to-left, -1 the other way. `follow` = hero slot or -1. */
  slash(x: number, z: number, rot: number, reach: number, arc: number, dur: number, hex: number, dir: number, delay = 0, follow = -1, intensity = 1.6): void {
    const t = this.timedSlot();
    const c = rgb(hex);
    t.active = true; t.kind = TIMED.SLASH; t.shape = DECAL.SLASH; t.age = -delay; t.dur = dur; t.follow = follow;
    t.x = x; t.y = 0.9; t.z = z; t.rot = rot; t.s0 = t.s1 = reach * 2; t.sz = reach * 2;
    t.r = c[0] * intensity; t.g = c[1] * intensity; t.b = c[2] * intensity; t.a = 1; t.additive = 0.85; t.p1 = dir; t.p2 = Math.min(Math.PI, arc / 2);
  }

  /** Summoning circle that lives for `dur`. */
  rune(x: number, z: number, d: number, dur: number, hex: number): void {
    const t = this.timedSlot();
    const c = rgb(hex);
    t.active = true; t.kind = TIMED.RUNE; t.shape = DECAL.RUNE; t.age = 0; t.dur = dur; t.follow = -1;
    t.x = x; t.y = 0.05; t.z = z; t.rot = Math.random() * 6.28; t.s0 = d * 0.6; t.s1 = d; t.sz = 0;
    t.r = c[0] * 1.5; t.g = c[1] * 1.5; t.b = c[2] * 1.5; t.a = 0.95; t.additive = 0.8; t.p1 = 0; t.p2 = 0;
  }

  /** Fading streak along a path (lunges, charges). Origin at the start, pointing along `rot`. */
  streak(x: number, z: number, rot: number, length: number, width: number, dur: number, hex: number, delay = 0): void {
    const t = this.timedSlot();
    const c = rgb(hex);
    t.active = true; t.kind = TIMED.STREAK; t.shape = DECAL.STREAK; t.age = -delay; t.dur = dur; t.follow = -1;
    t.x = x + Math.sin(rot) * length * 0.5; t.y = 0.5; t.z = z + Math.cos(rot) * length * 0.5; t.rot = rot;
    t.s0 = t.s1 = width; t.sz = length;
    t.r = c[0] * 1.5; t.g = c[1] * 1.5; t.b = c[2] * 1.5; t.a = 0.9; t.additive = 1; t.p1 = 0; t.p2 = 0;
  }

  // ---------------------------------------------------------------- floaters

  private floater(x: number, y: number, z: number, uv: UvRect, w: number, h: number, ox: number, hex: number, life: number, rise: number, hot: number): void {
    const f = this.floaters[this.floaterCursor];
    this.floaterCursor = (this.floaterCursor + 1) % this.floaters.length;
    const c = rgb(hex);
    f.active = true; f.x = x; f.y = y; f.z = z; f.age = 0; f.life = life; f.uv = uv; f.w = w; f.h = h; f.ox = ox;
    f.r = c[0]; f.g = c[1]; f.b = c[2]; f.rise = rise; f.hot = hot;
  }

  /** Element icon that pops above a target when a status lands. */
  iconPop(x: number, y: number, z: number, icon: UvRect, hex: number, size = 0.95): void {
    this.floater(x, y, z, icon, size, size, 0, hex, 0.7, 1.1, 0.6);
  }

  /** "RESONANCE" in the two colours of the burst. */
  word(x: number, y: number, z: number, hexA: number, hexB: number, scale = 1): void {
    const h = FX.WORD_HEIGHT * scale;
    const half = h * this.atlas.wordAspect * 0.5;
    this.floater(x, y, z, this.atlas.wordHalves[0], half, h, -half * 0.5, hexA, FX.WORD_LIFE, 0.7, 0.45);
    this.floater(x, y, z, this.atlas.wordHalves[1], half, h, half * 0.5, hexB, FX.WORD_LIFE, 0.7, 0.45);
  }

  // ---------------------------------------------------------------- damage numbers

  /** deco: 0 plain, 1 leading '+', 2 trailing '!' */
  number(x: number, y: number, z: number, value: number, hex: number, size = 1, deco = 0): void {
    if (!this.numbersEnabled) return;
    let v = Math.max(0, Math.round(value));
    if (v === 0 && deco !== 1) return;
    const d = this.numbers[this.numberCursor];
    this.numberCursor = (this.numberCursor + 1) % this.numbers.length;
    let n = 0;
    do { d.digits[n++] = v % 10; v = Math.floor(v / 10); } while (v > 0 && n < d.digits.length);
    const c = rgb(hex);
    d.active = true; d.n = n; d.deco = deco;
    d.x = x + (Math.random() - 0.5) * 0.7; d.y = y; d.z = z + (Math.random() - 0.5) * 0.3;
    d.age = 0; d.life = FX.NUMBER_LIFE * (size > 1.2 ? 1.25 : 1);
    d.r = c[0]; d.g = c[1]; d.b = c[2]; d.size = FX.NUMBER_SIZE * size; d.drift = (Math.random() - 0.5) * 0.8;
  }

  // ---------------------------------------------------------------- frame

  /** `rx..uz`: camera right / up vectors in world space, for velocity-aligned sparks. */
  update(dt: number, decals: DecalBatch, fx: BillboardBatch, ui: BillboardBatch, follow: FollowSource): void {
    // timed decals
    for (const t of this.timed) {
      if (!t.active) continue;
      t.age += dt;
      if (t.age < 0) continue;
      if (t.follow >= 0 && follow.position(t.follow, this.followOut)) {
        t.x = this.followOut.x; t.z = this.followOut.z;
      }
      const k = Math.min(1, t.age / t.dur);
      switch (t.kind) {
        case TIMED.TELEGRAPH: {
          const over = t.age - t.dur;
          if (over > FX.TELEGRAPH_FLASH) { t.active = false; break; }
          const flash = over > 0 ? 1 - over / FX.TELEGRAPH_FLASH : 0;
          const alpha = over > 0 ? flash : Math.min(1, t.age * 8);
          decals.push(t.shape, t.x, t.y, t.z, t.rot, t.s0, t.sz, t.r, t.g, t.b, alpha, over > 0 ? 0.8 : t.additive, k, flash, t.p2);
          break;
        }
        case TIMED.RING: {
          if (k >= 1) { t.active = false; break; }
          const e = 1 - (1 - k) * (1 - k);
          const size = t.s0 + (t.s1 - t.s0) * e;
          decals.push(t.shape, t.x, t.y, t.z, 0, size, size, t.r, t.g, t.b, (1 - k) * (1 - k), 1, t.p1 * (1 - k * 0.5));
          break;
        }
        case TIMED.DUO: {
          if (k >= 1) { t.active = false; break; }
          const e = 1 - (1 - k) * (1 - k) * (1 - k);
          const size = t.s0 + (t.s1 - t.s0) * e;
          decals.push(t.shape, t.x, t.y, t.z, t.age * 1.4, size, size, t.r, t.g, t.b, (1 - k) * (1 - k * 0.6), 0.5, t.p1 * (1 - k * 0.45), t.r2, t.g2, t.b2);
          break;
        }
        case TIMED.BEAM: {
          if (k >= 1) { t.active = false; break; }
          // snaps open, then narrows to a thread while it fades
          const open = k < 0.12 ? k / 0.12 : 1 - (k - 0.12) / 0.88;
          const fade = 1 - k * k;
          decals.push(t.shape, t.x, t.y, t.z, t.rot, t.s0 * 2.2 * open, t.sz, t.r, t.g, t.b, 0.8 * fade, 1, 1);
          decals.push(t.shape, t.x, t.y + 0.02, t.z, t.rot, t.s0 * 0.9 * open, t.sz, t.r2, t.g2, t.b2, fade, 1, 1);
          decals.push(DECAL.STREAK, t.x, 0.045, t.z, t.rot + Math.PI, t.s0 * 2.6, t.sz, t.r, t.g, t.b, 0.45 * fade, 1);
          break;
        }
        case TIMED.FLASH: {
          if (k >= 1) { t.active = false; break; }
          const size = t.s0 + (t.s1 - t.s0) * k;
          decals.push(t.shape, t.x, t.y, t.z, 0, size, size, t.r, t.g, t.b, t.a * (1 - k) * (1 - k), 1, t.p1);
          break;
        }
        case TIMED.SLASH: {
          if (k >= 1) { t.active = false; break; }
          const e = 1 - (1 - k) * (1 - k);
          const fade = k > 0.6 ? 1 - (k - 0.6) / 0.4 : 1;
          decals.push(t.shape, t.x, t.y, t.z, t.rot, t.s0, t.sz, t.r, t.g, t.b, fade, t.additive, e, t.p1, t.p2);
          break;
        }
        case TIMED.RUNE: {
          if (k >= 1) { t.active = false; break; }
          const grow = Math.min(1, k * 4);
          const size = t.s0 + (t.s1 - t.s0) * grow;
          const alpha = Math.min(1, k * 6) * Math.min(1, (1 - k) * 4);
          decals.push(t.shape, t.x, t.y, t.z, t.rot + t.age * 0.8, size, size, t.r, t.g, t.b, t.a * alpha, t.additive, k);
          break;
        }
        default: {
          if (k >= 1) { t.active = false; break; }
          decals.push(t.shape, t.x, t.y, t.z, t.rot, t.s0 * (1 - k * 0.5), t.sz, t.r, t.g, t.b, t.a * (1 - k), t.additive);
        }
      }
    }

    // particles
    let alive = 0;
    for (let i = 0; i < this.n; i++) {
      const life = this.life[i];
      if (life <= 0) continue;
      const age = this.age[i] + dt;
      if (age >= life) { this.life[i] = 0; continue; }
      this.age[i] = age;
      alive++;
      const damp = Math.max(0, 1 - this.drag[i] * dt);
      this.vx[i] *= damp; this.vz[i] *= damp;
      this.vy[i] = this.vy[i] * damp - this.grav[i] * dt;
      this.px[i] += this.vx[i] * dt;
      this.py[i] += this.vy[i] * dt;
      this.pz[i] += this.vz[i] * dt;
      if (this.py[i] < 0.05 && this.grav[i] > 0) { this.py[i] = 0.05; this.vy[i] *= -0.35; }
      const k = age / life;
      const size = this.s0[i] + (this.s1[i] - this.s0[i]) * k;
      const fade = this.mode[i] === SPRITE.GLOW && this.add[i] < 0.5 ? Math.min(1, k * 6) * (1 - k) : 1 - k * k;
      fx.push(this.mode[i], this.px[i], this.py[i], this.pz[i], size, size, this.cr[i], this.cg[i], this.cb[i], this.ca[i] * fade,
        this.add[i], this.par[i], this.rot0[i] + this.spin[i] * age);
    }
    this.alive = alive;

    // floaters: overshoot pop, rise, fade
    for (const f of this.floaters) {
      if (!f.active) continue;
      f.age += dt;
      if (f.age >= f.life) { f.active = false; continue; }
      const k = f.age / f.life;
      f.y += f.rise * (1 - k) * dt;
      const pop = k < 0.16 ? 0.4 + 1.0 * (k / 0.16) : 1.4 - 0.4 * Math.min(1, (k - 0.16) / 0.14);
      const alpha = k > 0.7 ? 1 - (k - 0.7) / 0.3 : 1;
      const hot = f.hot * Math.max(0, 1 - k * 4);
      ui.push(SPRITE.ATLAS, f.x, f.y, f.z, f.w * pop, f.h * pop, f.r + (1.6 - f.r) * hot + 0.25, f.g + (1.6 - f.g) * hot + 0.25, f.b + (1.6 - f.b) * hot + 0.25, alpha,
        0, 0, 0, f.ox * pop, 0, f.uv[0], f.uv[1], f.uv[2], f.uv[3]);
    }

    // damage numbers
    const digitW = this.atlas.digitAspect;
    for (const d of this.numbers) {
      if (!d.active) continue;
      d.age += dt;
      if (d.age >= d.life) { d.active = false; continue; }
      const k = d.age / d.life;
      d.y += FX.NUMBER_RISE * (1 - k) * (1 - k) * dt;
      d.x += d.drift * dt * (1 - k);
      const pop = 1 + 0.7 * Math.max(0, 1 - d.age / 0.1);
      const h = d.size * pop;
      const w = h * digitW;
      const step = w * 0.74;
      const alpha = k > 0.65 ? 1 - (k - 0.65) / 0.35 : 1;
      const total = d.n + (d.deco !== 0 ? 1 : 0);
      let ox = -(total - 1) * step * 0.5;
      if (d.deco === 1) {
        const uv = this.atlas.plus;
        ui.push(SPRITE.ATLAS, d.x, d.y, d.z, w, h, d.r, d.g, d.b, alpha, 0, 0, 0, ox, 0, uv[0], uv[1], uv[2], uv[3]);
        ox += step;
      }
      for (let i = d.n - 1; i >= 0; i--) {
        const uv = this.atlas.digits[d.digits[i]];
        ui.push(SPRITE.ATLAS, d.x, d.y, d.z, w, h, d.r, d.g, d.b, alpha, 0, 0, 0, ox, 0, uv[0], uv[1], uv[2], uv[3]);
        ox += step;
      }
      if (d.deco === 2) {
        const uv = this.atlas.bang;
        ui.push(SPRITE.ATLAS, d.x, d.y, d.z, w, h, d.r, d.g, d.b, alpha, 0, 0, 0, ox - step * 0.2, 0, uv[0], uv[1], uv[2], uv[3]);
      }
    }
  }

  clear(): void {
    this.life.fill(0);
    this.alive = 0;
    for (const t of this.timed) t.active = false;
    for (const d of this.numbers) d.active = false;
    for (const f of this.floaters) f.active = false;
  }
}
