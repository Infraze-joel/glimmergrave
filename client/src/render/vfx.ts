/**
 * Pooled visual effects: particles, timed ground decals (telegraphs, shockwaves, slashes, runes) and floating
 * damage numbers. Nothing here allocates per frame; everything renders through the shared batches.
 */
import { Color } from 'three';
import type { Atlas, UvRect } from './atlas.ts';
import type { Glare } from './glare.ts';
import { CL } from './clarity.ts';
import { DECAL, SPRITE } from './batches.ts';
import type { BillboardBatch, DecalBatch } from './batches.ts';
import { LIMITS, PALETTE } from './config.ts';

const FX = {
  TELEGRAPH_FLASH: 0.22,
  TELEGRAPH_Y: 0.06,
  TELEGRAPH_SHADE: 0.32,
  NUMBER_LIFE: 0.85,
  NUMBER_RISE: 1.9,
  NUMBER_SIZE: 0.62,
  GRAVITY: 9,
  WORD_HEIGHT: 0.92,
  WORD_LIFE: 1.15,
  /** Word marks shown at once; a new burst next to a standing word of the same reaction only refreshes that word. */
  WORD_NEAR: 7,
  WORD_REFRESH: 0.5,
  /** Word marks on screen at once: other heroes' bursts stop adding words first. */
  WORDS_ALLY: 2,
  WORDS_MAX: 6,
} as const;

/**
 * Damage / healing numbers (polish 1). Hits on the same target within MERGE_WINDOW become ONE number that counts up;
 * at most MAX numbers float at once (ALLY_MAX of them for other heroes' hits), the smallest are dropped first.
 * Other heroes' numbers are smaller, paler and shorter-lived than the own hero's; crits stay gold with a '!'.
 */
const NUM = {
  MERGE_WINDOW: 0.55,
  /** A merged number is closed after this long, so the total stays a readable "one burst". */
  MERGE_SPAN: 2.2,
  MAX: 12,
  ALLY_MAX: 5,
  /** Allies' numbers on the quiet clarity levels, when the player asked for them at all. */
  ALLY_QUIET: 3,
  /** Clarity: a merged number is gold only while crits make up more than this share of it. */
  CRIT_SHARE: 0.5,
  /** Numbers keep clear of heroes: metres to the side, and how fast they slide there. */
  HEROES: 4, HERO_CLEAR: 1.2, HERO_TOP: 3.2, SLIDE: 5,
  /** Age a number is put back to when another hit joins it (it has already popped, it just stays). */
  HOLD: 0.14,
  COUNT_RATE: 14,
  RISE_CAP: 1.5,
  ALLY_SIZE: 0.62,
  /** An ally's crit is only this much larger than its plain numbers, and its numbers sit lower than the own hero's. */
  ALLY_CRIT: 1.15,
  ALLY_DROP: 0.55,
  ALLY_ALPHA: 0.55,
  ALLY_LIFE: 0.7,
  /** How far an ally's number is washed towards grey. */
  ALLY_WASH: 0.45,
  WASH: 0.72,
  BUMP: 0.22,
  DIGITS: 6,
  /** Fade-out time of a number that is pushed out by the cap. */
  DROP: 0.12,
} as const;

/** Who an effect belongs to: the own hero's are drawn in full, other heroes' quieter (see Vfx.owner). */
export const OWNER = { SELF: 0, ALLY: 1, WORLD: 2 } as const;
/** Clarity: what is left of another hero's shockwave. */
const THIN = { BAND: 0.08, INTENSITY: 1.3, ALPHA: 0.42, SWING: 0.35 } as const;
const QUIET = {
  /** Light of an ally's additive effects (flashes, shockwaves, swings) relative to the own hero's. */
  LIGHT: 0.5,
  /** Their flashes are also shorter. */
  LIFE: 0.7,
  /** Share of their sparks, motes, flames and splinters that is drawn at all. */
  COUNT: 0.5,
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

export const TIMED = { TELEGRAPH: 0, RING: 1, SLASH: 2, RUNE: 3, FLASH: 4, STREAK: 5, DUO: 6, BEAM: 7, STAMP: 8 } as const;

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
  /** Telegraphs: id of the enemy winding up (-1 = unknown), so the telegraph can go when that enemy is interrupted. */
  src: number;
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
  /** Left half of a word mark (counted for the cap). */
  word: boolean;
}

interface DamageNumber {
  active: boolean;
  x: number; y: number; z: number;
  /** Height it was born at (the rise is capped from here, however long hits keep joining). */
  y0: number;
  age: number; life: number;
  digits: number[];
  n: number;
  /** 0 none, 1 '+', 2 '!' suffix */
  deco: number;
  r: number; g: number; b: number;
  size: number;
  drift: number;
  /** Merge key (0 = never merged), sum of the joined hits, the value on screen, seconds since the first / last hit. */
  key: number; total: number; shown: number; span: number; since: number;
  ally: boolean; alpha: number; bump: number;
  /** Crit damage inside `total`, and the colour the number has while it is not (mostly) a crit. */
  crit: number; br: number; bg: number; bb: number; scale: number;
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
  /** Brightness governor: telegraphs reserve their floor in it. */
  glare: Glare | null = null;
  /** Factors of the effects being created right now (owner()). */
  private light = 1;
  private fill = 1;
  private lifeMul = 1;
  private countMul = 1;
  private thin = false;

  constructor(atlas: Atlas) {
    this.atlas = atlas;
    for (let i = 0; i < LIMITS.TELEGRAPHS + LIMITS.BURSTS; i++) {
      this.timed.push({
        active: false, kind: 0, shape: 0, x: 0, y: 0, z: 0, rot: 0, s0: 0, s1: 0, sz: 0, age: 0, dur: 1,
        r: 1, g: 1, b: 1, a: 1, r2: 1, g2: 1, b2: 1, additive: 0, p1: 0, p2: 0, follow: -1, src: -1,
      });
    }
    for (let i = 0; i < LIMITS.FLOATERS; i++) {
      this.floaters.push({ active: false, x: 0, y: 0, z: 0, age: 0, life: 1, uv: atlas.plus, w: 1, h: 1, ox: 0, r: 1, g: 1, b: 1, rise: 1, hot: 0, word: false });
    }
    for (let i = 0; i < LIMITS.DAMAGE_NUMBERS; i++) {
      this.numbers.push({
        active: false, x: 0, y: 0, z: 0, y0: 0, age: 0, life: 1, digits: [0, 0, 0, 0, 0, 0], n: 0, deco: 0, r: 1, g: 1, b: 1, size: 1, drift: 0,
        key: 0, total: 0, shown: 0, span: 0, since: 0, ally: false, alpha: 1, bump: 0, crit: 0, br: 1, bg: 1, bb: 1, scale: 1,
      });
    }
  }

  /**
   * Whose effects the following calls create (OWNER.*). Another hero's flashes, shockwaves, swings and particles are
   * drawn with less light, shorter and thinner than the own hero's; hostile and neutral effects are never changed.
   * The world resets it to OWNER.WORLD after every event.
   */
  owner(who: number): void {
    const ally = who === OWNER.ALLY;
    const self = who === OWNER.SELF;
    this.thin = ally && CL.outlines;
    if (this.thin) {
      // clarity: an ally's effect is its outline and one soft flash, nothing filled, nothing flying
      this.light = CL.allyFlash; this.fill = 0; this.lifeMul = 0.6; this.countMul = 0;
    } else if (ally) {
      this.light = QUIET.LIGHT; this.fill = QUIET.LIGHT; this.lifeMul = QUIET.LIFE; this.countMul = QUIET.COUNT;
    } else if (self) {
      this.light = CL.ownLight; this.fill = CL.ownFill; this.lifeMul = 1; this.countMul = CL.ownCount;
    } else {
      this.light = 1; this.fill = 1; this.lifeMul = 1; this.countMul = 1;
    }
  }

  /** Turns the effects of the current owner down by `f` until the next owner() (a Twin Cast echo is the weaker copy). */
  soften(f: number): void {
    this.light *= f; this.fill *= f; this.countMul *= f;
  }

  /** Stochastic rounding of a particle count under the current owner's share (0 = none at all). */
  private share(count: number): number {
    const f = count * this.countMul;
    const n = Math.floor(f);
    return f - n > 0 && Math.random() < f - n ? n + 1 : n;
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
    const n = this.share(Math.max(1, count * (0.6 + 0.4 * this.density)));
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
    const n = this.share(Math.max(1, count * (0.6 + 0.4 * this.density)));
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
    const n = this.share(Math.max(1, count * this.density));
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
    const n = this.share(Math.max(1, count * (0.5 + 0.5 * this.density)));
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
    const n = this.share(Math.max(1, count * this.density));
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
    const n = this.share(Math.max(1, count * this.density));
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 0.6 + Math.random() * 1.6;
      this.particle(x + Math.sin(a) * radius * 0.4, y, z + Math.cos(a) * radius * 0.4, Math.sin(a) * sp, 0.4 + Math.random() * 0.8, Math.cos(a) * sp,
        0.45 + Math.random() * 0.4, 0.4 + Math.random() * 0.3, 1.1 + Math.random() * 0.5, c[0], c[1], c[2], alpha * 0.8, SPRITE.GLOW, 0, 0, 2.2);
    }
  }

  /** One big additive glow that fades quickly (muzzle flashes, impact bloom). */
  flash(x: number, y: number, z: number, hex: number, size: number, life = 0.18, intensity = 1.6): void {
    if (this.light <= 0) return;
    const c = rgb(hex);
    const i = intensity * this.light;
    if (this.thin) size *= 0.7;
    this.particle(x, y, z, 0, 0, 0, life * this.lifeMul, size, size * 1.5, c[0] * i, c[1] * i, c[2] * i, 0.9, SPRITE.GLOW, 1);
  }

  // ---------------------------------------------------------------- timed decals

  private timedSlot(): TimedDecal {
    for (let i = 0; i < this.timed.length; i++) {
      const j = (this.timedCursor + i) % this.timed.length;
      if (!this.timed[j].active) { this.timedCursor = (j + 1) % this.timed.length; this.timed[j].src = -1; return this.timed[j]; }
    }
    const t = this.timed[this.timedCursor];
    this.timedCursor = (this.timedCursor + 1) % this.timed.length;
    t.src = -1;
    return t;
  }

  /**
   * Removes the telegraphs of an enemy whose windup was cut short (killed, stunned, staggered): by contract that
   * attack never lands. Telegraphs that are already flashing (the attack landed) are left alone.
   */
  cancelTelegraphs(src: number): void {
    for (const t of this.timed) {
      if (t.active && t.kind === TIMED.TELEGRAPH && t.src === src && t.age < t.dur) t.active = false;
    }
  }

  /** The floor under a pending warning is kept clear of friendly glare. */
  private reserve(t: TimedDecal): void {
    const glare = this.glare;
    if (!glare) return;
    if (t.shape !== DECAL.TELE_LINE) { glare.protect(t.x, t.z, t.s0 * 0.5); return; }
    // a lane: a row of circles along it
    const half = t.sz * 0.5;
    const r = Math.max(1.5, t.s0);
    const steps = Math.max(1, Math.ceil(t.sz / (r * 2)));
    const sin = Math.sin(t.rot);
    const cos = Math.cos(t.rot);
    for (let i = 0; i <= steps; i++) {
      const d = -half + (i / steps) * t.sz;
      glare.protect(t.x + sin * d, t.z + cos * d, r);
    }
  }

  /** Hostile ground telegraph that fills over `dur` and flashes when it lands. `src` = the enemy winding up, if known. */
  telegraph(shape: 'circle' | 'arc' | 'line', x: number, z: number, rot: number, r: number, w: number, dur: number, src = -1): void {
    const t = this.timedSlot();
    t.src = src;
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
    if (this.thin && delay > 0) return;
    if (this.thin) { thickness = Math.min(thickness, THIN.BAND); intensity = Math.min(intensity, THIN.INTENSITY); }
    const t = this.timedSlot();
    const c = rgb(hex);
    t.active = true; t.kind = TIMED.RING; t.shape = DECAL.SHOCK; t.age = -delay; t.dur = dur; t.follow = -1;
    t.x = x; t.y = 0.07; t.z = z; t.rot = 0; t.s0 = d0; t.s1 = d1; t.sz = 0;
    t.r = c[0] * intensity; t.g = c[1] * intensity; t.b = c[2] * intensity; t.a = this.thin ? THIN.ALPHA : this.light; t.additive = 1; t.p1 = thickness; t.p2 = 0;
  }

  /** Expanding shockwave whose band swirls between two colours (Resonance). */
  duoRing(x: number, z: number, d0: number, d1: number, dur: number, hexA: number, hexB: number, thickness = 0.4, intensity = 2, delay = 0): void {
    // an ally's burst keeps one ring, not the echo behind it
    if (this.thin && delay > 0) return;
    if (this.thin) { thickness = Math.min(thickness, THIN.BAND); intensity = Math.min(intensity, THIN.INTENSITY); }
    const t = this.timedSlot();
    const a = rgb(hexA);
    const b = rgb(hexB);
    t.active = true; t.kind = TIMED.DUO; t.shape = DECAL.DUO; t.age = -delay; t.dur = dur; t.follow = -1;
    t.x = x; t.y = 0.075; t.z = z; t.rot = 0; t.s0 = d0; t.s1 = d1; t.sz = 0;
    t.r = a[0] * intensity; t.g = a[1] * intensity; t.b = a[2] * intensity; t.a = this.thin ? THIN.ALPHA : this.light;
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
    t.r = a[0] * 1.7; t.g = a[1] * 1.7; t.b = a[2] * 1.7; t.a = this.thin ? THIN.SWING : this.light;
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
    if (this.fill <= 0) return;
    const t = this.timedSlot();
    const c = rgb(hex);
    t.active = true; t.kind = TIMED.FLASH; t.shape = DECAL.DISC; t.age = -delay; t.dur = dur; t.follow = -1;
    t.x = x; t.y = 0.05; t.z = z; t.rot = 0; t.s0 = d * 0.7; t.s1 = d; t.sz = 0;
    t.r = c[0] * intensity; t.g = c[1] * intensity; t.b = c[2] * intensity; t.a = 0.7 * this.fill; t.additive = 1; t.p1 = 0.2; t.p2 = 0;
  }

  /** Weapon swing crescent. `dir` +1 sweeps right-to-left, -1 the other way. `follow` = hero slot or -1. */
  slash(x: number, z: number, rot: number, reach: number, arc: number, dur: number, hex: number, dir: number, delay = 0, follow = -1, intensity = 1.6): void {
    const t = this.timedSlot();
    const c = rgb(hex);
    t.active = true; t.kind = TIMED.SLASH; t.shape = DECAL.SLASH; t.age = -delay; t.dur = dur; t.follow = follow;
    t.x = x; t.y = 0.9; t.z = z; t.rot = rot; t.s0 = t.s1 = reach * 2; t.sz = reach * 2;
    t.r = c[0] * intensity; t.g = c[1] * intensity; t.b = c[2] * intensity; t.a = this.thin ? THIN.SWING : this.light < 1 ? 0.7 : 1; t.additive = 0.85; t.p1 = dir; t.p2 = Math.min(Math.PI, arc / 2);
  }

  /** Summoning circle that lives for `dur`. */
  rune(x: number, z: number, d: number, dur: number, hex: number): void {
    const t = this.timedSlot();
    const c = rgb(hex);
    t.active = true; t.kind = TIMED.RUNE; t.shape = DECAL.RUNE; t.age = 0; t.dur = dur; t.follow = -1;
    t.x = x; t.y = 0.05; t.z = z; t.rot = Math.random() * 6.28; t.s0 = d * 0.6; t.s1 = d; t.sz = 0;
    t.r = c[0] * 1.5; t.g = c[1] * 1.5; t.b = c[2] * 1.5; t.a = 0.95 * (this.thin ? 0.5 : this.light < 1 ? 0.75 : 1); t.additive = 0.8; t.p1 = 0; t.p2 = 0;
  }

  /** Fading streak along a path (lunges, charges). Origin at the start, pointing along `rot`. */
  streak(x: number, z: number, rot: number, length: number, width: number, dur: number, hex: number, delay = 0): void {
    const t = this.timedSlot();
    const c = rgb(hex);
    t.active = true; t.kind = TIMED.STREAK; t.shape = DECAL.STREAK; t.age = -delay; t.dur = dur; t.follow = -1;
    t.x = x + Math.sin(rot) * length * 0.5; t.y = 0.5; t.z = z + Math.cos(rot) * length * 0.5; t.rot = rot;
    t.s0 = t.s1 = width; t.sz = length;
    t.r = c[0] * 1.5; t.g = c[1] * 1.5; t.b = c[2] * 1.5; t.a = 0.9 * (this.thin ? THIN.SWING : this.light); t.additive = 1; t.p1 = 0; t.p2 = 0;
  }

  /**
   * Any decal shape as a one-shot: grows from d0 to d1 and fades over `dur`. p0..p2 are passed to the shape as they
   * are (a negative p0 / p1 runs 0..1 with the effect's age instead).
   */
  stamp(shape: number, x: number, z: number, d0: number, d1: number, dur: number, hex: number, intensity = 1.5, additive = 1, p0 = 0, p1 = 0, p2 = 0, delay = 0, alpha = 1): void {
    if (this.fill <= 0) return;
    const t = this.timedSlot();
    const c = rgb(hex);
    t.active = true; t.kind = TIMED.STAMP; t.shape = shape; t.age = -delay; t.dur = dur; t.follow = -1;
    t.x = x; t.y = 0.055; t.z = z; t.rot = Math.random() * 6.28; t.s0 = d0; t.s1 = d1; t.sz = p2;
    t.r = c[0] * intensity; t.g = c[1] * intensity; t.b = c[2] * intensity; t.a = additive >= 0.5 ? alpha * this.fill : alpha * Math.min(1, this.fill * 1.5); t.additive = additive; t.p1 = p0; t.p2 = p1;
  }

  /** Crystal splinters thrown outwards that tumble and drop (Shatter, breaking prisons). */
  shards(x: number, y: number, z: number, hex: number, count: number, speed: number, size = 0.5, additive = 0.35): void {
    const c = rgb(hex);
    const n = this.share(Math.max(1, count * (0.6 + 0.4 * this.density)));
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = speed * (0.5 + Math.random() * 0.7);
      const s = size * (0.6 + Math.random() * 0.8);
      this.particle(x + Math.sin(a) * 0.3, y + Math.random() * 0.6, z + Math.cos(a) * 0.3, Math.sin(a) * sp, 3 + Math.random() * 4, Math.cos(a) * sp,
        0.5 + Math.random() * 0.4, s, s * 0.5, c[0] * 1.3 + 0.15, c[1] * 1.3 + 0.15, c[2] * 1.3 + 0.15, 1, SPRITE.SHARD, additive, FX.GRAVITY * 1.4, 1.2,
        (Math.random() - 0.5) * 16, 0.8, Math.random() * 6.28);
    }
  }

  /** Slow, dark, non-additive billows (umbra, smoke bombs). */
  smoke(x: number, y: number, z: number, hex: number, count: number, radius: number, alpha = 0.3, life = 1.4, size = 1.3): void {
    const c = rgb(hex);
    const n = this.share(Math.max(1, count * this.density));
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const d = Math.sqrt(Math.random()) * radius;
      this.particle(x + Math.sin(a) * d, y + Math.random() * 0.4, z + Math.cos(a) * d, Math.sin(a) * 0.35, 0.25 + Math.random() * 0.5, Math.cos(a) * 0.35,
        life * (0.7 + Math.random() * 0.6), size * (0.5 + Math.random() * 0.4), size * (1.1 + Math.random() * 0.6), c[0], c[1], c[2], alpha, SPRITE.GLOW, 0, 0, 0.6);
    }
  }

  // ---------------------------------------------------------------- floaters

  private floater(x: number, y: number, z: number, uv: UvRect, w: number, h: number, ox: number, hex: number, life: number, rise: number, hot: number): Floater {
    const f = this.floaters[this.floaterCursor];
    this.floaterCursor = (this.floaterCursor + 1) % this.floaters.length;
    const c = rgb(hex);
    f.active = true; f.x = x; f.y = y; f.z = z; f.age = 0; f.life = life; f.uv = uv; f.w = w; f.h = h; f.ox = ox;
    f.r = c[0]; f.g = c[1]; f.b = c[2]; f.rise = rise; f.hot = hot; f.word = false;
    return f;
  }

  /** Element icon that pops above a target when a status lands. */
  iconPop(x: number, y: number, z: number, icon: UvRect, hex: number, size = 0.95): void {
    this.floater(x, y, z, icon, size, size, 0, hex, 0.7, 1.1, 0.6);
  }

  /**
   * The reaction's name (atlas word `index`: 0 = "Resonance", 1.. = REACTIONS order) in the two colours of the burst.
   * A second burst of the same reaction close to a word that has only just appeared does not stack a second word on
   * it; `scale` < 1 = another hero's burst (smaller, shorter).
   */
  word(x: number, y: number, z: number, hexA: number, hexB: number, scale = 1, index = 0): void {
    if (scale < 1 ? !CL.allyWords : !CL.ownWords) return;
    const mark = this.atlas.words[index] ?? this.atlas.words[0];
    let words = 0;
    for (const f of this.floaters) {
      if (!f.active || !f.word) continue;
      words++;
      if (f.uv === mark.halves[0] && f.age <= FX.WORD_REFRESH && Math.hypot(f.x - x, f.z - z) < FX.WORD_NEAR) return;
    }
    if (words >= (scale < 1 ? FX.WORDS_ALLY : Math.min(FX.WORDS_MAX, CL.wordMax))) return;
    const h = FX.WORD_HEIGHT * scale * CL.wordSize;
    const half = h * mark.aspect * 0.5;
    const life = FX.WORD_LIFE * (scale < 1 ? 0.8 : 1);
    this.floater(x, y, z, mark.halves[0], half, h, -half * 0.5, hexA, life, 0.7, scale < 1 ? 0.2 : 0.45).word = true;
    this.floater(x, y, z, mark.halves[1], half, h, half * 0.5, hexB, life, 0.7, scale < 1 ? 0.2 : 0.45);
  }

  // ---------------------------------------------------------------- damage numbers

  private setDigits(d: DamageNumber, value: number): void {
    let v = Math.max(0, Math.round(value));
    let n = 0;
    do { d.digits[n++] = v % 10; v = Math.floor(v / 10); } while (v > 0 && n < NUM.DIGITS);
    d.n = n;
  }

  /** Makes room under the cap for a number worth `value`; false = the new one is the least important and is dropped. */
  private makeRoom(value: number, ally: boolean, strong: boolean): boolean {
    let total = 0;
    let allies = 0;
    let weakest: DamageNumber | null = null;
    let weakestAlly: DamageNumber | null = null;
    for (const d of this.numbers) {
      if (!d.active || d.age >= d.life - NUM.DROP) continue;
      total++;
      if (d.ally) allies++;
      // crits and the own hero's numbers are the last to go
      const weight = d.total * (d.deco === 2 ? 4 : 1) * (d.ally ? 1 : 8);
      if (!weakest || weight < weakest.total * (weakest.deco === 2 ? 4 : 1) * (weakest.ally ? 1 : 8)) weakest = d;
      if (d.ally && (!weakestAlly || weight < weakestAlly.total * (weakestAlly.deco === 2 ? 4 : 1))) weakestAlly = d;
    }
    const mine = value * (strong ? 4 : 1) * (ally ? 1 : 8);
    const full = CL.level === 'full';
    if (ally && allies >= (full ? NUM.ALLY_MAX : NUM.ALLY_QUIET)) {
      if (!weakestAlly || weakestAlly.total * (weakestAlly.deco === 2 ? 4 : 1) >= mine) return false;
      weakestAlly.age = Math.max(weakestAlly.age, weakestAlly.life - NUM.DROP);
      weakestAlly.key = 0;
      return true;
    }
    if (total < (full ? NUM.MAX : CL.numberMax + (CL.allyNumbers ? NUM.ALLY_QUIET : 0))) return true;
    if (!weakest || weakest.total * (weakest.deco === 2 ? 4 : 1) * (weakest.ally ? 1 : 8) >= mine) return false;
    weakest.age = Math.max(weakest.age, weakest.life - NUM.DROP);
    weakest.key = 0;
    return true;
  }

  /**
   * deco: 0 plain, 1 leading '+', 2 trailing '!'.
   * `key` (non-zero) names the target and channel: numbers with the same key that arrive within a short window are
   * merged into one that counts up. `ally` = not the own hero's number: smaller, paler, first to be dropped.
   */
  number(x: number, y: number, z: number, value: number, hex: number, size = 1, deco = 0, key = 0, ally = false): void {
    if (!this.numbersEnabled || (ally && !CL.allyNumbers)) return;
    const v = Math.max(0, Math.round(value));
    if (v === 0 && deco !== 1) return;
    const c = rgb(hex);
    const wash = ally ? NUM.ALLY_WASH : 0;
    const crit = deco === 2;
    const scale = FX.NUMBER_SIZE * CL.numberSize * (ally ? Math.min(size, NUM.ALLY_CRIT) * NUM.ALLY_SIZE : size);
    if (key !== 0) {
      for (const d of this.numbers) {
        if (!d.active || d.key !== key || d.since > NUM.MERGE_WINDOW || d.span > NUM.MERGE_SPAN) continue;
        d.total += v;
        if (crit) { d.crit += v; d.scale = Math.max(d.scale, scale); }
        else { d.br = c[0] + (NUM.WASH - c[0]) * wash; d.bg = c[1] + (NUM.WASH - c[1]) * wash; d.bb = c[2] + (NUM.WASH - c[2]) * wash; }
        d.since = 0;
        d.age = Math.min(d.age, NUM.HOLD);
        d.bump = 1;
        d.x += (x - d.x) * 0.5; d.z += (z - d.z) * 0.5;
        this.style(d);
        return;
      }
    }
    if (!this.makeRoom(v, ally, crit)) return;
    let d = this.numbers[this.numberCursor];
    for (let i = 0; i < this.numbers.length && d.active; i++) {
      this.numberCursor = (this.numberCursor + 1) % this.numbers.length;
      d = this.numbers[this.numberCursor];
    }
    this.numberCursor = (this.numberCursor + 1) % this.numbers.length;
    d.active = true; d.deco = deco; d.key = key; d.total = v; d.shown = v; d.span = 0; d.since = 0; d.ally = ally; d.bump = 0;
    d.crit = crit ? v : 0;
    this.setDigits(d, v);
    d.x = x + (Math.random() - 0.5) * 0.7; d.y = ally ? y - NUM.ALLY_DROP : y; d.y0 = d.y; d.z = z + (Math.random() - 0.5) * 0.3;
    d.age = 0; d.life = FX.NUMBER_LIFE * (size > 1.2 ? 1.25 : 1) * (ally ? NUM.ALLY_LIFE : 1);
    d.alpha = ally ? NUM.ALLY_ALPHA : 1;
    // a lone crit keeps its gold; the plain colour it would fall back to is white
    d.br = crit ? NUM.WASH + (1 - NUM.WASH) * (1 - wash) : c[0] + (NUM.WASH - c[0]) * wash;
    d.bg = crit ? d.br : c[1] + (NUM.WASH - c[1]) * wash;
    d.bb = crit ? d.br : c[2] + (NUM.WASH - c[2]) * wash;
    d.r = c[0] + (NUM.WASH - c[0]) * wash; d.g = c[1] + (NUM.WASH - c[1]) * wash; d.b = c[2] + (NUM.WASH - c[2]) * wash;
    d.size = scale; d.scale = scale; d.drift = (Math.random() - 0.5) * (ally ? 0.4 : 0.8) * CL.numberSize;
  }

  /** Colour and mark of a merged number: gold with a '!' while it is (on `full`: as soon as it contains) crit damage. */
  private style(d: DamageNumber): void {
    if (d.deco === 1) { d.r = d.br; d.g = d.bg; d.b = d.bb; return; }
    const gold = CL.level === 'full' ? d.crit > 0 : d.crit > d.total * NUM.CRIT_SHARE;
    if (gold) {
      const c = rgb(PALETTE.crit);
      const wash = d.ally ? NUM.ALLY_WASH : 0;
      d.deco = 2; d.size = d.scale;
      d.r = c[0] + (NUM.WASH - c[0]) * wash; d.g = c[1] + (NUM.WASH - c[1]) * wash; d.b = c[2] + (NUM.WASH - c[2]) * wash;
    } else {
      d.deco = 0;
      d.r = d.br; d.g = d.bg; d.b = d.bb;
    }
  }

  /** Numbers on screen right now (debug overlay). */
  get numberCount(): number {
    let n = 0;
    for (const d of this.numbers) if (d.active) n++;
    return n;
  }

  // ---------------------------------------------------------------- frame

  /** `rx..uz`: camera right / up vectors in world space, for velocity-aligned sparks. */
  update(dt: number, decals: DecalBatch, fx: BillboardBatch, ui: BillboardBatch, follow: FollowSource, warnings: DecalBatch = decals): void {
    // timed decals: two passes, so hostile telegraphs are always drawn on top of every friendly ground effect
    for (let pass = 0; pass < 2; pass++) for (const t of this.timed) {
      if (!t.active || (t.kind === TIMED.TELEGRAPH) !== (pass === 1)) continue;
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
          // first a dark copy of the shape, so whatever glows underneath is turned down inside the warning
          if (over <= 0 && warnings !== decals) warnings.push(t.shape, t.x, t.y - 0.004, t.z, t.rot, t.s0, t.sz, 0, 0, 0, alpha, 0, k, 0, t.p2, FX.TELEGRAPH_SHADE);
          warnings.push(t.shape, t.x, t.y, t.z, t.rot, t.s0, t.sz, t.r, t.g, t.b, alpha, over > 0 ? 0.8 : t.additive, k, flash, t.p2);
          if (this.glare && over <= 0) this.reserve(t);
          break;
        }
        case TIMED.RING: {
          if (k >= 1) { t.active = false; break; }
          const e = 1 - (1 - k) * (1 - k);
          const size = t.s0 + (t.s1 - t.s0) * e;
          decals.push(t.shape, t.x, t.y, t.z, 0, size, size, t.r, t.g, t.b, (1 - k) * (1 - k) * t.a, 1, t.p1 * (1 - k * 0.5));
          break;
        }
        case TIMED.DUO: {
          if (k >= 1) { t.active = false; break; }
          const e = 1 - (1 - k) * (1 - k) * (1 - k);
          const size = t.s0 + (t.s1 - t.s0) * e;
          decals.push(t.shape, t.x, t.y, t.z, t.age * 1.4, size, size, t.r, t.g, t.b, (1 - k) * (1 - k * 0.6) * t.a, 0.5, t.p1 * (1 - k * 0.45), t.r2, t.g2, t.b2);
          break;
        }
        case TIMED.BEAM: {
          if (k >= 1) { t.active = false; break; }
          // snaps open, then narrows to a thread while it fades
          const open = k < 0.12 ? k / 0.12 : 1 - (k - 0.12) / 0.88;
          const fade = 1 - k * k;
          decals.push(t.shape, t.x, t.y, t.z, t.rot, t.s0 * 2.2 * open, t.sz, t.r, t.g, t.b, 0.8 * fade * t.a, 1, 1);
          decals.push(t.shape, t.x, t.y + 0.02, t.z, t.rot, t.s0 * 0.9 * open, t.sz, t.r2, t.g2, t.b2, fade * t.a, 1, 1);
          decals.push(DECAL.STREAK, t.x, 0.045, t.z, t.rot + Math.PI, t.s0 * 2.6, t.sz, t.r, t.g, t.b, 0.45 * fade * t.a, 1);
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
          decals.push(t.shape, t.x, t.y, t.z, t.rot, t.s0, t.sz, t.r, t.g, t.b, fade * t.a, t.additive, e, t.p1, t.p2);
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
        case TIMED.STAMP: {
          if (k >= 1) { t.active = false; break; }
          const e = 1 - (1 - k) * (1 - k);
          const size = t.s0 + (t.s1 - t.s0) * e;
          decals.push(t.shape, t.x, t.y, t.z, t.rot, size, size, t.r, t.g, t.b, t.a * (1 - k) * (1 - k * 0.5), t.additive, t.p1 < 0 ? k : t.p1, t.p2 < 0 ? k : t.p2, t.sz);
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
    // other heroes' numbers first, so the own hero's are never covered by them
    for (let pass = 0; pass < 2; pass++) for (const d of this.numbers) {
      if (!d.active || d.ally !== (pass === 0)) continue;
      d.age += dt;
      d.span += dt;
      d.since += dt;
      if (d.age >= d.life) { d.active = false; continue; }
      if (d.shown < d.total) {
        // counting up towards the merged total
        d.shown = Math.min(d.total, d.shown + Math.max(1, (d.total - d.shown) * NUM.COUNT_RATE * dt));
        this.setDigits(d, d.shown);
      }
      d.bump = Math.max(0, d.bump - dt * 7);
      const k = d.age / d.life;
      d.y = Math.min(d.y0 + NUM.RISE_CAP, d.y + FX.NUMBER_RISE * (1 - k) * (1 - k) * dt);
      d.x += d.drift * dt * (1 - k);
      if (CL.level !== 'full') {
        // never over a hero: a number that would cover one slides off to the side
        const lift = this.glare ? this.glare.lift : 0;
        for (let slot = 0; slot < NUM.HEROES; slot++) {
          if (!follow.position(slot, this.followOut)) continue;
          const dx = d.x - this.followOut.x;
          const dz = d.z - d.y * lift - this.followOut.z;
          if (Math.abs(dx) < NUM.HERO_CLEAR && dz < 0.5 && dz > -NUM.HERO_TOP * lift - 0.5) d.x += (dx >= 0 ? 1 : -1) * NUM.SLIDE * dt;
        }
      }
      const pop = 1 + (d.ally ? 0.25 : 0.7) * Math.max(0, 1 - d.age / 0.1) + NUM.BUMP * d.bump;
      const h = d.size * pop;
      const w = h * digitW;
      const step = w * 0.74;
      const alpha = (k > 0.65 ? 1 - (k - 0.65) / 0.35 : 1) * d.alpha;
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
    this.owner(OWNER.WORLD);
  }
}
