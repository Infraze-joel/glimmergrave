/**
 * Update 3 ability visuals that outlive a single burst: lasting ground zones, traps, the falling star, banners,
 * rune wards, the overload nova, ice prisons and the six named reactions. Everything is pooled and drawn through
 * the shared batches; nothing here creates meshes or materials.
 *
 * Draw order matters: this module must push its decals BEFORE Vfx.update(), which draws hostile telegraphs last, so
 * no friendly effect can ever cover one. Red is not used here at all.
 */
import type { ClassId, ElementId, GameEvent } from '@shared/types.ts';
import { ULTIMATE } from '@shared/data/classes.ts';
import type { AbilityDef } from '@shared/data/classes.ts';
import { REACTION_TUNING, reactionOf } from '@shared/data/reactions.ts';
import type { Atlas } from './atlas.ts';
import { DECAL, SPRITE } from './batches.ts';
import type { BillboardBatch, DecalBatch } from './batches.ts';
import type { Enemies, EnemyView, Heroes } from './characters.ts';
import { ELEMENT_COLOR, PALETTE } from './config.ts';
import { CL } from './clarity.ts';
import { OWNER, rgb } from './vfx.ts';
import type { Vfx } from './vfx.ts';

type ZoneEvent = Extract<GameEvent, { e: 'zone' }>;
type ResonanceEvent = Extract<GameEvent, { e: 'resonance' }>;

const LIMIT = { ZONES: 24, SCHEDULE: 32, METEORS: 4, BANNERS: 4, WARDS: 4, NOVAS: 4, PRISONS: 8 } as const;

const ZK = { GENERIC: 0, CONSECRATE: 1, SANCTUARY: 2, VOLLEY: 3, SMOKE: 4, TRAP: 5 } as const;
const ZONE_KIND: Record<string, number> = {
  templar_consecrate: ZK.CONSECRATE, templar_sanctuary: ZK.SANCTUARY, rogue_volley: ZK.VOLLEY, shade_smoke: ZK.SMOKE, rogue_trap: ZK.TRAP,
};

const SK = { LEAP_BARB: 0, LEAP_TEMPLAR: 1, LANCE: 2, METEOR: 3, NOVA: 4, MARK: 5 } as const;

const TUNE = {
  FADE_IN: 4,
  FADE_OUT: 0.45,
  DUST: 0x4f4a44,
  ROCK: 0x3a2e28,
  BOLT: 0xffe2a8,
  TRAP: 0xe9ffe0,
  TRAP_ARM: 0.6,
  TRAP_PLATE: 1.7,
  TRAP_SNAP: 0.55,
  STAR: 0xffc46a,
  STAR_FROM: { x: 5, y: 17, z: -3 },
  STAR_TAIL: 9,
  RAIN_BOLTS: 14,
  RAIN_RATE: 2.4,
  RAIN_HEIGHT: 9,
  RIM_COLUMNS: 8,
  PRISON_SHARDS: 7,
  PRISON_ICE: 0x121c46,
  PRISON_RIM: 0x7fd0ff,
  WARD_SHARDS: 3,
  RUNE: 0xa8ecff,
  /** Lasting effects of other heroes: their ground shapes stay readable but translucent, their light is turned down. */
  ALLY_SHAPE: 0.62,
  ALLY_LIGHT: 0.45,
  /** Clarity: alpha of the outline that is left of another hero's lasting effect. */
  OUTLINE: 0.5,
  CAGE_SEE: 0.45, CAGE_LOW: 0.6,
} as const;

const ALL_ELEMENTS: readonly ElementId[] = ['ember', 'rime', 'storm', 'umbra'];

interface Zone {
  active: boolean; id: number; kind: number;
  x: number; z: number; r: number; dur: number; age: number;
  /** Seconds since the zone ended (fading out), -1 while it lasts. */
  ended: number; sprung: boolean;
  el: ElementId | null; acc: number; seed: number;
  /** Hero who placed it (-1 unknown). */
  slot: number;
}
interface Scheduled { active: boolean; at: number; type: number; x: number; z: number; r: number; rot: number; hex: number; slot: number }
interface Meteor { active: boolean; x: number; z: number; r: number; age: number; dur: number; hex: number; acc: number; slot: number }
interface Banner { active: boolean; x: number; z: number; r: number; age: number; dur: number; acc: number; slot: number }
interface Follow { active: boolean; slot: number; age: number; dur: number; r: number; hex: number }
interface Prison { active: boolean; x: number; z: number; r: number; age: number; dur: number; seed: number; slot: number }

/** Cheap deterministic hash in [0, 1). */
function hash1(n: number): number {
  const s = Math.sin(n * 127.1) * 43758.5453;
  return s - Math.floor(s);
}

const CORE = rgb(PALETTE.umbraCore);

export class AbilityFx {
  private readonly vfx: Vfx;
  private readonly atlas: Atlas;
  private readonly heroes: Heroes;
  private readonly enemies: Enemies;
  private readonly zones: Zone[] = [];
  private readonly schedule: Scheduled[] = [];
  private readonly meteors: Meteor[] = [];
  private readonly banners: Banner[] = [];
  private readonly wards: Follow[] = [];
  private readonly novas: Follow[] = [];
  private readonly prisons: Prison[] = [];
  private time = 0;
  private trauma = 0;
  /** Slot of the own hero (-1 = none: everything is drawn in full). */
  localSlot = -1;
  /** Update 5, Walking Sanctum: heroes (by slot) whose hallowed ground follows them. Written by WorldView.setRoster. */
  readonly sanctum: boolean[] = [false, false, false, false];

  // scratch state of the Void Arc target search (no closures per event)
  private seekX = 0;
  private seekZ = 0;
  private seekBest: EnemyView | null = null;
  private seekDist = 0;
  private readonly seekUsed: number[] = [];
  private readonly seek = (v: EnemyView): void => {
    if (v.dying || this.seekUsed.includes(v.id)) return;
    const d = Math.hypot(v.x - this.seekX, v.z - this.seekZ);
    if (d < 1 || d > REACTION_TUNING.VOIDARC_RANGE || d >= this.seekDist) return;
    this.seekDist = d;
    this.seekBest = v;
  };

  constructor(vfx: Vfx, atlas: Atlas, heroes: Heroes, enemies: Enemies) {
    this.vfx = vfx;
    this.atlas = atlas;
    this.heroes = heroes;
    this.enemies = enemies;
    for (let i = 0; i < LIMIT.ZONES; i++) {
      this.zones.push({ active: false, id: -1, kind: 0, x: 0, z: 0, r: 1, dur: 1, age: 0, ended: -1, sprung: false, el: null, acc: 0, seed: 0, slot: -1 });
    }
    for (let i = 0; i < LIMIT.SCHEDULE; i++) this.schedule.push({ active: false, at: 0, type: 0, x: 0, z: 0, r: 0, rot: 0, hex: 0, slot: -1 });
    for (let i = 0; i < LIMIT.METEORS; i++) this.meteors.push({ active: false, x: 0, z: 0, r: 1, age: 0, dur: 1, hex: 0, acc: 0, slot: -1 });
    for (let i = 0; i < LIMIT.BANNERS; i++) this.banners.push({ active: false, x: 0, z: 0, r: 1, age: 0, dur: 1, acc: 0, slot: -1 });
    for (let i = 0; i < LIMIT.WARDS; i++) this.wards.push({ active: false, slot: -1, age: 0, dur: 1, r: 1, hex: 0 });
    for (let i = 0; i < LIMIT.NOVAS; i++) this.novas.push({ active: false, slot: -1, age: 0, dur: 1, r: 1, hex: 0 });
    for (let i = 0; i < LIMIT.PRISONS; i++) this.prisons.push({ active: false, x: 0, z: 0, r: 1, age: 0, dur: 1, seed: 0, slot: -1 });
  }

  /** Is this another hero's effect? Unknown owners and spectators (no own hero) count as own. */
  private foreign(slot: number): boolean {
    return this.localSlot >= 0 && slot >= 0 && slot !== this.localSlot;
  }

  /** Camera shake asked for since the last call (the world owns the camera). */
  takeShake(): number {
    const t = this.trauma;
    this.trauma = 0;
    return t;
  }

  get activeZones(): number {
    let n = 0;
    for (const z of this.zones) if (z.active) n++;
    return n;
  }

  // ------------------------------------------------------------------------------------------ elements

  /** The look of one element as a burst: Ember leaps up in flames, Rime sheds frost, Storm arcs, Umbra billows dark. */
  elementBurst(el: ElementId, x: number, y: number, z: number, radius: number, amount: number): void {
    const vfx = this.vfx;
    const hex = ELEMENT_COLOR[el];
    if (el === 'ember') vfx.flames(x, y, z, hex, 7 * amount, radius, 0.8 + 0.7 * amount);
    else if (el === 'rime') vfx.frost(x, y + 0.3, z, hex, 14 * amount, radius * 1.2);
    else if (el === 'storm') vfx.arcs(x, y, z, hex, 7 * amount, 0.9 + radius * 1.3);
    else {
      vfx.smoke(x, y + 0.2, z, PALETTE.umbraCore, 4 * amount, radius, 0.5, 0.9, 0.9 + 0.5 * amount);
      vfx.motes(x, y, z, hex, 5 * amount, radius, -0.9, 0.9);
      vfx.sparks(x, y + 0.4, z, PALETTE.umbraDeep, 4 * amount, 4);
    }
  }

  // ------------------------------------------------------------------------------------------ zones

  zone(ev: ZoneEvent): void {
    let slot: Zone | null = null;
    for (const z of this.zones) if (z.active && z.id === ev.id) { slot = z; break; }
    if (!slot) for (const z of this.zones) if (!z.active) { slot = z; break; }
    if (!slot) {
      // pool exhausted: recycle the zone that is closest to its end
      slot = this.zones[0];
      for (const z of this.zones) if (z.dur - z.age < slot.dur - slot.age) slot = z;
    }
    slot.active = true; slot.id = ev.id; slot.kind = ZONE_KIND[ev.kind] ?? ZK.GENERIC;
    slot.x = ev.x; slot.z = ev.z; slot.r = ev.r; slot.dur = Math.max(0.1, ev.dur); slot.age = 0; slot.ended = -1; slot.sprung = false;
    slot.el = ev.el; slot.acc = 0; slot.seed = (ev.id * 0.61803398875) % 1; slot.slot = ev.by;
    const vfx = this.vfx;
    const d = ev.r * 2;
    switch (slot.kind) {
      case ZK.CONSECRATE:
        vfx.ring(ev.x, ev.z, 1, d * 1.05, 0.45, PALETTE.holy, 0.4, 1.8);
        vfx.groundFlash(ev.x, ev.z, d, 0.5, PALETTE.holyDeep, 0.7);
        vfx.motes(ev.x, 0.2, ev.z, PALETTE.holy, 16, ev.r * 0.8, 3, 1);
        break;
      case ZK.SANCTUARY:
        // the templar's ultimate: the whole circle lights up, then a column of light stands over it
        vfx.flash(ev.x, 2.4, ev.z, PALETTE.holy, ev.r * 1.1, 0.4, 1.1);
        vfx.flash(ev.x, 1.2, ev.z, PALETTE.white, ev.r * 0.4, 0.12, 1.2);
        vfx.ring(ev.x, ev.z, 1, d * 1.1, 0.6, PALETTE.holy, 0.55, 2.3);
        vfx.ring(ev.x, ev.z, 1, d * 1.5, 0.95, PALETTE.holyDeep, 0.25, 1.7, 0.12);
        vfx.groundFlash(ev.x, ev.z, d * 1.25, 0.8, PALETTE.holy, 0.8);
        vfx.stamp(DECAL.HALLOW, ev.x, ev.z, d * 0.4, d * 1.25, 0.9, PALETTE.white, 1.2, 1, 0.12, -1, 1);
        vfx.motes(ev.x, 0.2, ev.z, PALETTE.holy, 44, ev.r * 0.9, 4.2, 1.4);
        vfx.sparks(ev.x, 1.2, ev.z, PALETTE.holyDeep, 26, 12);
        this.trauma += 0.4;
        break;
      case ZK.VOLLEY:
        vfx.ring(ev.x, ev.z, d * 1.2, d * 0.98, 0.35, TUNE.BOLT, 0.3, 1.8);
        vfx.groundFlash(ev.x, ev.z, d, 0.4, TUNE.BOLT, 0.5);
        this.trauma += 0.2;
        break;
      case ZK.SMOKE:
        vfx.smoke(ev.x, 0.5, ev.z, PALETTE.shadow, 16, ev.r * 0.8, 0.36, 1.5, 2);
        vfx.ring(ev.x, ev.z, 0.6, d, 0.4, PALETTE.mark, 0.3, 1.2);
        vfx.sparks(ev.x, 0.5, ev.z, PALETTE.umbra, 8, 6);
        break;
      case ZK.TRAP:
        vfx.puff(ev.x, 0.2, ev.z, TUNE.DUST, 4, 0.5, 0.3);
        vfx.sparks(ev.x, 0.2, ev.z, TUNE.TRAP, 5, 3.5);
        break;
      default:
        vfx.ring(ev.x, ev.z, 1, d, 0.4, ev.el ? ELEMENT_COLOR[ev.el] : PALETTE.arcane, 0.35, 1.5);
    }
  }

  zoneEnd(id: number, sprung: boolean): void {
    for (const z of this.zones) {
      if (!z.active || z.id !== id || z.ended >= 0) continue;
      z.ended = 0;
      z.sprung = sprung;
      if (z.kind === ZK.TRAP && sprung) {
        const vfx = this.vfx;
        vfx.owner(this.foreign(z.slot) ? OWNER.ALLY : OWNER.SELF);
        const hex = z.el ? ELEMENT_COLOR[z.el] : TUNE.TRAP;
        vfx.ring(z.x, z.z, 0.6, z.r * 2.05, 0.32, hex, 0.5, 2.1);
        vfx.stamp(DECAL.CRACKLE, z.x, z.z, z.r * 0.8, z.r * 2.1, 0.4, hex, 1.6, 1, 0.5, 1);
        vfx.flash(z.x, 0.8, z.z, hex, z.r * 1.8, 0.16, 1.7);
        vfx.sparks(z.x, 0.3, z.z, PALETTE.physical, 16, 9);
        vfx.puff(z.x, 0.25, z.z, TUNE.DUST, 6, z.r * 0.6, 0.3);
        if (z.el) this.elementBurst(z.el, z.x, 0.3, z.z, z.r * 0.6, 0.8);
        this.trauma += 0.12;
        vfx.owner(OWNER.WORLD);
      }
    }
  }

  private drawZone(zn: Zone, dt: number, decals: DecalBatch, fx: BillboardBatch): void {
    const vfx = this.vfx;
    const time = this.time;
    zn.age += dt;
    if (zn.ended < 0 && zn.age >= zn.dur) zn.ended = 0;
    let a = Math.min(1, zn.age * TUNE.FADE_IN);
    if (zn.ended >= 0) {
      zn.ended += dt;
      const out = zn.kind === ZK.TRAP && zn.sprung ? TUNE.TRAP_SNAP : TUNE.FADE_OUT;
      if (zn.ended >= out) { zn.active = false; return; }
      a *= 1 - zn.ended / out;
    }
    const walking = zn.kind === ZK.CONSECRATE && zn.slot >= 0 && this.sanctum[zn.slot] === true;
    if (walking && zn.ended < 0) {
      const carrier = this.heroes.get(zn.slot);
      if (carrier) { zn.x = carrier.x + carrier.offX; zn.z = carrier.z + carrier.offZ; }
    }
    const { x, z, r } = zn;
    const d = r * 2;
    const live = zn.ended < 0;
    // another hero's zone: the outline stays, the fill and the light above it are turned down
    const foreign = this.foreign(zn.slot);
    if (foreign && CL.outlines) { this.outlineZone(zn, a, decals); return; }
    const lit = foreign ? TUNE.ALLY_LIGHT : CL.ownFill;
    const fillK = foreign ? 1 : CL.ownFill;
    if (foreign) a *= TUNE.ALLY_SHAPE;
    vfx.owner(foreign ? OWNER.ALLY : OWNER.SELF);
    const tint = zn.el ? ELEMENT_COLOR[zn.el] : 0;
    switch (zn.kind) {
      case ZK.CONSECRATE: {
        const c = rgb(PALETTE.holy);
        const g = rgb(PALETTE.holyDeep);
        decals.push(DECAL.DISC, x, 0.032, z, 0, d * 1.15, d * 1.15, g[0], g[1], g[2], 0.14 * a * fillK, 1, 0.2);
        decals.push(DECAL.HALLOW, x, 0.044, z, 0, d, d, c[0] * 1.4, c[1] * 1.4, c[2] * 1.4, 0.85 * a, 1, 0.07, (zn.age * 1.1) % 1, 1);
        if (walking) {
          // Walking Sanctum: the ground is carried, so it turns with the stride: a second wheel inside and four lights on the rim
          decals.push(DECAL.HALLOW, x, 0.046, z, -time * 0.9, d * 0.58, d * 0.58, g[0] * 1.6, g[1] * 1.6, g[2] * 1.6, 0.8 * a * fillK, 1, 0.04, (zn.age * 1.1 + 0.5) % 1, 1);
          for (let k = 0; k < 4; k++) {
            const ang = time * 0.9 + k * (Math.PI / 2);
            fx.push(SPRITE.GLOW, x + Math.sin(ang) * r, 0.9, z + Math.cos(ang) * r, 0.45, 1.8, c[0] * 1.4, c[1] * 1.4, c[2] * 1.4, 0.4 * a * lit, 1, 0.9);
          }
        }
        if (live) {
          zn.acc += dt * 12 * vfx.density;
          while (zn.acc >= 1) { zn.acc -= 1; vfx.motes(x, 0.1, z, tint !== 0 && Math.random() < 0.4 ? tint : PALETTE.holy, 1, r * 0.95, 2.2, 0.9); }
        }
        break;
      }
      case ZK.SANCTUARY: {
        const c = rgb(PALETTE.holy);
        const g = rgb(PALETTE.holyDeep);
        const breathe = 0.85 + 0.15 * Math.sin(time * 2.2);
        decals.push(DECAL.DISC, x, 0.032, z, 0, d * 1.2, d * 1.2, g[0], g[1], g[2], 0.2 * a * fillK, 1, 0.25);
        decals.push(DECAL.HALLOW, x, 0.044, z, 0, d, d, c[0] * 1.6, c[1] * 1.6, c[2] * 1.6, 0.95 * a, 1, 0.1, (zn.age * 0.9) % 1, 1);
        decals.push(DECAL.HALLOW, x, 0.046, z, Math.PI / 8, d * 0.6, d * 0.6, g[0] * 1.6, g[1] * 1.6, g[2] * 1.6, 0.7 * a * fillK, 1, 0.05, (zn.age * 0.9 + 0.5) % 1, 1);
        // a column of light over the centre, slim pillars around the rim and a faint dome
        fx.push(SPRITE.GLOW, x, 4.6, z, 2.4 * breathe, 10, c[0], c[1], c[2], 0.24 * a * lit, 1, 0.4);
        fx.push(SPRITE.GLOW, x, 1.2, z, d * 0.95, d * 0.6, c[0], c[1], c[2], 0.05 * a * lit, 1, 0);
        for (let k = 0; k < TUNE.RIM_COLUMNS; k++) {
          const ang = (k / TUNE.RIM_COLUMNS) * Math.PI * 2 + time * 0.25;
          const h = 2.6 + 0.8 * Math.sin(time * 2 + k * 1.9);
          fx.push(SPRITE.GLOW, x + Math.sin(ang) * r, h * 0.5, z + Math.cos(ang) * r, 0.5, h, c[0] * 1.4, c[1] * 1.4, c[2] * 1.4, 0.32 * a * lit, 1, 0.9);
        }
        if (live) {
          zn.acc += dt * 24 * vfx.density;
          while (zn.acc >= 1) { zn.acc -= 1; vfx.motes(x, 0.1, z, Math.random() < 0.35 ? PALETTE.heal : PALETTE.holy, 1, r * 0.95, 3, 1.1); }
        }
        break;
      }
      case ZK.VOLLEY: {
        const hex = tint !== 0 ? tint : TUNE.BOLT;
        const c = rgb(hex);
        decals.push(DECAL.DISC, x, 0.032, z, 0, d * 1.1, d * 1.1, c[0], c[1], c[2], 0.12 * a * fillK, 1, 0.3);
        decals.push(DECAL.ZONE, x, 0.046, z, time * 0.3, d, d, c[0] * 1.5, c[1] * 1.5, c[2] * 1.5, 0.85 * a, 0.5, 0);
        if (!live) break;
        // bolts falling at a slant; each lands with a pin of light where it strikes
        for (let k = 0; k < TUNE.RAIN_BOLTS; k++) {
          const cyc = time * TUNE.RAIN_RATE + k * 0.618 + zn.seed;
          const ph = cyc - Math.floor(cyc);
          const n = Math.floor(cyc) * 7.31 + k * 13.7 + zn.seed * 91;
          const ang = hash1(n) * Math.PI * 2;
          const dist = Math.sqrt(hash1(n + 3.3)) * r * 0.94;
          const px = x + Math.sin(ang) * dist;
          const pz = z + Math.cos(ang) * dist;
          const up = (1 - ph) * TUNE.RAIN_HEIGHT;
          fx.push(SPRITE.GLOW, px + up * 0.16, up + 0.7, pz - up * 0.1, 0.17, 1.9, c[0] * 2.2, c[1] * 2.2, c[2] * 2.2, 0.95 * a * lit, 1, 1.2, -0.16);
          if (ph > 0.86) {
            const hit = (ph - 0.86) / 0.14;
            decals.push(DECAL.DISC, px, 0.05, pz, 0, 1.5 * hit + 0.4, 1.5 * hit + 0.4, c[0] * 1.6, c[1] * 1.6, c[2] * 1.6, 0.8 * (1 - hit) * a * lit, 1, 0.5);
            fx.push(SPRITE.SPARK, px, 0.3, pz, 0.5 * (1 - hit) + 0.1, 0.5 * (1 - hit) + 0.1, 2.4, 2.3, 2, 1 - hit, 1, 0, n);
          }
        }
        zn.acc += dt * 14 * vfx.density;
        while (zn.acc >= 1) {
          zn.acc -= 1;
          const ang = Math.random() * Math.PI * 2;
          const dist = Math.sqrt(Math.random()) * r * 0.9;
          vfx.sparks(x + Math.sin(ang) * dist, 0.15, z + Math.cos(ang) * dist, hex, 2, 4);
        }
        break;
      }
      case ZK.SMOKE: {
        const s = rgb(PALETTE.shadow);
        const rim = rgb(tint !== 0 ? tint : PALETTE.umbra);
        decals.push(DECAL.SMOKE, x, 0.04, z, time * 0.2, d * 1.1, d * 1.1, s[0], s[1], s[2], 0.9 * a, 0, 1, rim[0] * 0.95, rim[1] * 0.95, rim[2] * 0.95);
        decals.push(DECAL.SMOKE, x, 0.042, z, -time * 0.33 + 2, d * 0.72, d * 0.72, s[0] * 2, s[1] * 2, s[2] * 2, 0.5 * a, 0, 0.9);
        // its reach as a pale dashed outline: the cloud itself is dark on a dark floor
        decals.push(DECAL.ZONE, x, 0.046, z, time * 0.15, d, d, rim[0] * 1.5, rim[1] * 1.5, rim[2] * 1.5, 0.7 * a, 0.5, 0);
        if (live) {
          zn.acc += dt * 6 * vfx.density;
          while (zn.acc >= 1) {
            zn.acc -= 1;
            vfx.smoke(x, 0.4, z, PALETTE.shadow, 1, r * 0.8, 0.2, 1.7, 1.9);
            if (Math.random() < 0.5) vfx.motes(x, 0.3, z, tint !== 0 ? tint : PALETTE.umbra, 1, r * 0.9, 0.8, 1.1);
          }
        }
        break;
      }
      case ZK.TRAP: {
        const hex = tint !== 0 ? tint : TUNE.TRAP;
        const c = rgb(hex);
        const arm = Math.min(1, zn.age / TUNE.TRAP_ARM);
        const closed = zn.sprung ? Math.min(1, zn.ended / 0.07) : 0;
        const blink = arm < 1 ? arm * 0.5 : 0.65 + 0.35 * Math.sin(time * 3.2 + zn.seed * 6);
        decals.push(DECAL.TRAP, x, 0.04, z, zn.seed * 6.283, TUNE.TRAP_PLATE, TUNE.TRAP_PLATE, c[0] * 1.7, c[1] * 1.7, c[2] * 1.7, a, 0, blink, closed);
        // its reach: a faint friendly ring, only once armed
        decals.push(DECAL.ZONE, x, 0.045, z, 0, d, d, c[0], c[1], c[2], 0.3 * a * (arm < 1 ? 0 : 1), 0.4, 0);
        if (arm >= 1 && live) fx.push(SPRITE.GLOW, x, 0.25, z, 0.7, 0.7, c[0], c[1], c[2], 0.35 * blink * a, 1, 0.8);
        break;
      }
      default: {
        const c = rgb(tint !== 0 ? tint : PALETTE.arcane);
        decals.push(DECAL.DISC, x, 0.032, z, 0, d, d, c[0], c[1], c[2], 0.12 * a, 1, 0.3);
        decals.push(DECAL.ZONE, x, 0.046, z, 0, d, d, c[0] * 1.4, c[1] * 1.4, c[2] * 1.4, 0.8 * a, 0.4, 0);
      }
    }
  }

  /**
   * Clarity: another hero's zone is only its reach, a thin dashed ring in the zone's colour. No fill, no light
   * above it, no particles. A snare keeps its plate (it is a small object, not an effect).
   */
  private outlineZone(zn: Zone, a: number, decals: DecalBatch): void {
    const d = zn.r * 2;
    const hex = zn.el ? ELEMENT_COLOR[zn.el] : zn.kind === ZK.CONSECRATE || zn.kind === ZK.SANCTUARY ? PALETTE.holy
      : zn.kind === ZK.VOLLEY ? TUNE.BOLT : zn.kind === ZK.SMOKE ? PALETTE.mark : zn.kind === ZK.TRAP ? TUNE.TRAP : PALETTE.arcane;
    const c = rgb(hex);
    if (zn.kind === ZK.TRAP) {
      const closed = zn.sprung ? Math.min(1, zn.ended / 0.07) : 0;
      decals.push(DECAL.TRAP, zn.x, 0.04, zn.z, zn.seed * 6.283, TUNE.TRAP_PLATE, TUNE.TRAP_PLATE, c[0] * 1.2, c[1] * 1.2, c[2] * 1.2, a * 0.8, 0, 0.4, closed);
      return;
    }
    decals.push(DECAL.ZONE, zn.x, 0.046, zn.z, this.time * 0.2, d, d, c[0] * 1.2, c[1] * 1.2, c[2] * 1.2, TUNE.OUTLINE * a, 0.3, 0);
  }

  // ------------------------------------------------------------------------------------------ casts

  private later(delay: number, type: number, x: number, z: number, r: number, rot: number, hex: number, slot: number): void {
    for (const s of this.schedule) {
      if (s.active) continue;
      s.active = true; s.at = this.time + delay; s.type = type; s.x = x; s.z = z; s.r = r; s.rot = rot; s.hex = hex; s.slot = slot;
      return;
    }
  }

  private take<T extends { active: boolean }>(pool: T[]): T {
    for (const p of pool) if (!p.active) return p;
    return pool[0];
  }

  /**
   * Hero ability cast. `hx/hz` is where the hero stands, `x/z` what the cast event carries (the target of
   * ground-targeted abilities). Returns true when the ability is fully handled here.
   */
  cast(def: AbilityDef, cls: ClassId, slot: number, x: number, z: number, rot: number, hx: number, hz: number, color: number, infused: ElementId | null): boolean {
    const vfx = this.vfx;
    const sin = Math.sin(rot);
    const cos = Math.cos(rot);
    switch (def.id) {
      case 'mage_lance': {
        // light gathers at the staff, then the lance tears the whole lane open at once
        const mx = hx + sin * 0.9;
        const mz = hz + cos * 0.9;
        vfx.flash(mx, 1.25, mz, color, 2.2, def.windup + 0.05, 1.3);
        vfx.rune(hx, hz, 2.2, def.windup + 0.1, color);
        vfx.beam(mx, mz, rot, def.range, def.radius * 3.2, color, PALETTE.white, def.windup, 0.65);
        this.later(def.windup, SK.LANCE, mx, mz, def.range, rot, color, slot);
        return true;
      }
      case 'barb_leap':
      case 'templar_judgement': {
        const templar = def.id === 'templar_judgement';
        this.heroes.leap(slot, x, z, def.windup);
        const far = Math.hypot(x - hx, z - hz) > 0.6;
        vfx.puff(hx, 0.25, hz, TUNE.DUST, 6, 0.7, 0.35);
        vfx.ring(hx, hz, 0.6, 3, 0.3, color, 0.3, 1.3);
        // where it will come down: a friendly circle in the hero's colour
        if (far) vfx.rune(x, z, def.radius * 2, def.windup + 0.12, color);
        this.later(def.windup, templar ? SK.LEAP_TEMPLAR : SK.LEAP_BARB, x, z, def.radius, far ? 1 : 0, color, slot);
        return true;
      }
      case 'templar_consecrate':
      case 'templar_sanctuary':
        vfx.flash(hx, 1.6, hz, PALETTE.holy, def.id === 'templar_sanctuary' ? 4 : 2.4, def.windup + 0.1, 1.5);
        vfx.rune(hx, hz, def.radius * 2, def.windup + 0.15, PALETTE.holy);
        return true;
      case 'rogue_volley':
        // a sheaf of bolts loosed into the dark above
        vfx.flash(hx + sin * 0.6, 1.6, hz + cos * 0.6, color, 2.4, 0.2, 1.7);
        for (let k = 0; k < 6; k++) {
          vfx.particle(hx + sin * 0.6, 1.5, hz + cos * 0.6, sin * 5 + (Math.random() - 0.5) * 3, 17 + Math.random() * 5, cos * 5 + (Math.random() - 0.5) * 3,
            0.45, 0.3, 0.1, 2.3, 2.1, 1.6, 1, SPRITE.SPARK, 1, 0, 0, 0);
        }
        return true;
      case 'rogue_trap':
        vfx.flash(hx + sin * 0.6, 0.6, hz + cos * 0.6, TUNE.TRAP, 1.1, 0.14, 1.2);
        return true;
      case 'shade_smoke':
        vfx.flash(hx, 0.7, hz, PALETTE.mark, 1.8, 0.14, 1.3);
        return true;
      case 'knight_bulwark': {
        const b = this.take(this.banners);
        b.active = true; b.x = hx; b.z = hz; b.r = def.radius; b.age = 0; b.dur = def.duration + def.windup; b.acc = 0; b.slot = slot;
        vfx.rune(hx, hz, 3.4, def.windup + 0.1, PALETTE.holy);
        vfx.ring(hx, hz, 1, def.radius * 2, 0.7, PALETTE.holy, 0.4, 2.1, def.windup);
        vfx.ring(hx, hz, 1, def.radius * 2.3, 1.0, PALETTE.shield, 0.2, 1.6, def.windup + 0.1);
        vfx.groundFlash(hx, hz, def.radius * 2, 0.8, PALETTE.holy, 0.9, def.windup);
        vfx.flash(hx, 2.6, hz, PALETTE.holy, 5, 0.45, 1.3);
        vfx.motes(hx, 0.2, hz, PALETTE.holy, 30, 1.6, 4, 1.3);
        this.trauma += 0.3;
        return true;
      }
      case 'barb_rage':
        // the roar: everything around the barbarian is thrown outwards
        vfx.flash(hx, 1.3, hz, PALETTE.rage, 4.5, 0.35, 1.3);
        vfx.ring(hx, hz, 0.8, 9, 0.5, PALETTE.rage, 0.5, 2.3, def.windup * 0.5);
        vfx.stamp(DECAL.CRACKLE, hx, hz, 2, 11, 0.7, PALETTE.rage, 1.8, 1, 0.4, 1, 0, def.windup * 0.5);
        vfx.groundFlash(hx, hz, 8, 0.6, PALETTE.rage, 1);
        vfx.flames(hx, 0.4, hz, PALETTE.rage, 16, 1.3, 1.6);
        vfx.sparks(hx, 1.2, hz, PALETTE.rage, 26, 12);
        vfx.puff(hx, 0.25, hz, TUNE.DUST, 8, 1.2, 0.35);
        this.trauma += 0.35;
        return true;
      case 'spell_overload': {
        const n = this.take(this.novas);
        n.active = true; n.slot = slot; n.age = 0; n.dur = def.windup; n.r = def.radius; n.hex = color;
        this.later(def.windup, SK.NOVA, hx, hz, def.radius, 0, color, slot);
        return true;
      }
      case 'spell_ward': {
        const w = this.take(this.wards);
        w.active = true; w.slot = slot; w.age = 0; w.dur = def.duration + def.windup; w.r = def.radius; w.hex = infused ? color : TUNE.RUNE;
        vfx.ring(hx, hz, 0.6, def.radius * 2, 0.35, w.hex, 0.35, 1.6);
        vfx.flash(hx, 1.2, hz, w.hex, 3, 0.2, 1.5);
        return true;
      }
      case 'mage_meteor': {
        const m = this.take(this.meteors);
        m.active = true; m.x = x; m.z = z; m.r = def.radius; m.age = 0; m.dur = def.windup; m.acc = 0; m.hex = infused ? color : TUNE.STAR; m.slot = slot;
        vfx.rune(hx, hz, 3.4, def.windup, PALETTE.arcane);
        vfx.motes(hx, 0.2, hz, PALETTE.arcane, 22, 1.1, 3.4, def.windup);
        this.later(def.windup, SK.METEOR, x, z, def.radius, 0, m.hex, slot);
        return true;
      }
      case 'shade_mark':
        // the shade's hand passes over the ground: a ring of shadow closes on everything inside
        vfx.flash(hx, 1.2, hz, PALETTE.mark, 2.2, 0.2, 1.4);
        vfx.streak(hx, hz, Math.atan2(x - hx, z - hz), Math.hypot(x - hx, z - hz), 1.1, 0.35, PALETTE.mark);
        vfx.ring(x, z, def.radius * 2.3, 1, def.windup + 0.2, PALETTE.mark, 0.3, 1.7);
        vfx.rune(x, z, def.radius * 2, def.windup + 0.5, PALETTE.mark);
        this.later(def.windup, SK.MARK, x, z, def.radius, 0, PALETTE.mark, slot);
        return true;
      default:
        return cls === 'shade' && def.shape === 'lunge' ? this.shadowStep(def, x, z, rot) : false;
    }
  }

  /** Shadowstep: the shade dissolves where it stood and re-forms at the end of the dash. */
  private shadowStep(def: AbilityDef, x: number, z: number, rot: number): boolean {
    const vfx = this.vfx;
    const ex = x + Math.sin(rot) * def.range;
    const ez = z + Math.cos(rot) * def.range;
    vfx.smoke(x, 0.9, z, PALETTE.shadow, 6, 0.5, 0.4, 0.7, 1.2);
    vfx.streak(x, z, rot, def.range, def.radius * 1.8, 0.4, PALETTE.mark, def.windup);
    vfx.streak(x, z, rot, def.range, def.radius * 0.6, 0.3, PALETTE.white, def.windup);
    vfx.smoke(ex, 0.9, ez, PALETTE.shadow, 5, 0.5, 0.35, 0.6, 1.1);
    vfx.ring(ex, ez, 0.5, def.radius * 2.6, 0.3, PALETTE.mark, 0.4, 1.8, def.windup + 0.1);
    vfx.sparks(ex, 1, ez, PALETTE.umbra, 8, 6);
    return true;
  }

  private fire(s: Scheduled): void {
    const vfx = this.vfx;
    vfx.owner(this.foreign(s.slot) ? OWNER.ALLY : OWNER.SELF);
    let { x, z } = s;
    const d = s.r * 2;
    switch (s.type) {
      case SK.LEAP_BARB:
      case SK.LEAP_TEMPLAR: {
        // a cast without a target (rot = 0) lands wherever the hero is by now
        const h = this.heroes.get(s.slot);
        if (s.rot === 0 && h) { x = h.x + h.offX; z = h.z + h.offZ; }
        if (s.type === SK.LEAP_BARB) {
          vfx.ring(x, z, 0.6, d * 1.05, 0.4, s.hex, 0.55, 2.2);
          vfx.stamp(DECAL.CRACKLE, x, z, d * 0.3, d * 1.1, 0.55, PALETTE.rage, 1.5, 1, 0.5, 1);
          vfx.groundFlash(x, z, d * 1.1, 0.4, s.hex, 0.9);
          vfx.flash(x, 0.8, z, s.hex, s.r * 1.9, 0.16, 1.6);
          vfx.shards(x, 0.2, z, TUNE.ROCK, 12, 8, 0.45, 0);
          vfx.sparks(x, 0.3, z, s.hex, 18, 10);
          vfx.puff(x, 0.25, z, TUNE.DUST, 12, s.r * 0.8, 0.38);
          this.trauma += 0.4;
        } else {
          // judgement: the blade comes down inside a shaft of light
          vfx.flash(x, 3.2, z, PALETTE.holy, 3.2, 0.3, 1.3);
          vfx.particle(x, 4.5, z, 0, 0, 0, 0.32, 1.8, 0.5, 2.2, 2.0, 1.4, 0.9, SPRITE.GLOW, 1, 0, 0, 0, 1.2);
          vfx.ring(x, z, 0.6, d * 1.05, 0.42, PALETTE.holy, 0.5, 2.2);
          vfx.stamp(DECAL.HALLOW, x, z, d * 0.4, d * 1.05, 0.7, PALETTE.holy, 1.7, 1, 0.25, -1, 1);
          vfx.groundFlash(x, z, d * 1.1, 0.45, PALETTE.holyDeep, 1);
          vfx.sparks(x, 0.4, z, PALETTE.holy, 20, 10);
          vfx.motes(x, 0.2, z, PALETTE.holy, 16, s.r * 0.8, 3.4, 1);
          vfx.puff(x, 0.25, z, TUNE.DUST, 6, s.r * 0.6, 0.3);
          this.trauma += 0.35;
        }
        break;
      }
      case SK.LANCE: {
        const sin = Math.sin(s.rot);
        const cos = Math.cos(s.rot);
        vfx.flash(x, 1.2, z, PALETTE.white, 3, 0.14, 1.4);
        vfx.ring(x, z, 0.5, 3.4, 0.3, s.hex, 0.4, 1.9);
        vfx.streak(x, z, s.rot, s.r, 2.4, 0.5, s.hex);
        for (let k = 1; k <= 6; k++) {
          const t = (k / 6) * s.r;
          vfx.sparks(x + sin * t, 1.1, z + cos * t, s.hex, 4, 5);
        }
        this.trauma += 0.16;
        break;
      }
      case SK.METEOR: {
        // the biggest single hit in the game: a white-out, three shock fronts, fire, flung rock and a lasting scorch
        vfx.flash(x, 1.5, z, PALETTE.white, s.r * 1.1, 0.12, 1.1);
        vfx.flash(x, 2.2, z, s.hex, s.r * 1.8, 0.45, 1);
        vfx.groundFlash(x, z, d * 1.35, 0.7, s.hex, 1);
        vfx.ring(x, z, 1, d * 1.04, 0.45, s.hex, 0.7, 2.6);
        vfx.duoRing(x, z, 1, d * 1.5, 0.9, s.hex, PALETTE.arcane, 0.35, 2.1, 0.06);
        vfx.ring(x, z, 1, d * 1.9, 1.2, PALETTE.white, 0.14, 1.3, 0.14);
        vfx.stamp(DECAL.CRACKLE, x, z, d * 0.5, d * 1.02, 1.3, s.hex, 1.8, 1, 0.6, 1);
        vfx.stamp(DECAL.DISC, x, z, d * 0.85, d * 0.95, 3.2, 0x0a0706, 1, 0, 0.5, 0, 0, 0.1, 0.6);
        vfx.flames(x, 0.3, z, s.hex, 22, s.r * 0.85, 1.9);
        vfx.sparks(x, 0.5, z, s.hex, 44, 17);
        vfx.sparks(x, 0.8, z, PALETTE.white, 16, 12);
        vfx.shards(x, 0.2, z, TUNE.ROCK, 16, 11, 0.6, 0);
        vfx.puff(x, 0.3, z, TUNE.DUST, 18, s.r * 0.9, 0.4);
        vfx.motes(x, 0.2, z, s.hex, 26, s.r, 3, 1.6);
        this.trauma += 0.7;
        break;
      }
      case SK.NOVA: {
        const h = this.heroes.get(s.slot);
        if (h) { x = h.x + h.offX; z = h.z + h.offZ; }
        vfx.flash(x, 1.2, z, PALETTE.white, s.r * 0.9, 0.12, 1.1);
        vfx.groundFlash(x, z, d * 1.1, 0.6, PALETTE.white, 0.45);
        // one shock front per element, each a beat behind the last, each throwing its own matter
        for (let k = 0; k < ALL_ELEMENTS.length; k++) {
          const el = ALL_ELEMENTS[k];
          const hex = ELEMENT_COLOR[el];
          vfx.ring(x, z, 1, d * (0.82 + 0.07 * k), 0.5 + 0.08 * k, hex, 0.5, 2.3, k * 0.07);
          vfx.sparks(x, 1 + 0.15 * k, z, hex, 10, 13);
          const a = (k / ALL_ELEMENTS.length) * Math.PI * 2 + 0.6;
          for (let n = 0; n < 3; n++) {
            const aa = a + n * 2.094;
            this.elementBurst(el, x + Math.sin(aa) * s.r * 0.62, 0.4, z + Math.cos(aa) * s.r * 0.62, 0.8, 0.8);
          }
        }
        vfx.duoRing(x, z, 1, d * 1.2, 0.8, ELEMENT_COLOR.ember, ELEMENT_COLOR.rime, 0.3, 1.9, 0.1);
        vfx.duoRing(x, z, 1, d * 1.36, 1.0, ELEMENT_COLOR.storm, ELEMENT_COLOR.umbra, 0.22, 1.7, 0.2);
        vfx.stamp(DECAL.CRACKLE, x, z, d * 0.3, d, 0.6, TUNE.RUNE, 1.6, 1, 0.4, 1);
        this.trauma += 0.5;
        break;
      }
      case SK.MARK:
        vfx.smoke(x, 0.4, z, PALETTE.shadow, 10, s.r * 0.8, 0.3, 1, 1.6);
        vfx.stamp(DECAL.SMOKE, x, z, d * 0.9, d * 1.05, 1.1, PALETTE.shadow, 1, 0, 0.9, 0, 0, 0, 0.8);
        vfx.ring(x, z, 1, d, 0.4, PALETTE.mark, 0.25, 1.8);
        vfx.sparks(x, 0.6, z, PALETTE.mark, 14, 8);
        this.trauma += 0.15;
        break;
    }
    vfx.owner(OWNER.WORLD);
  }

  /** A marked enemy died: its mark bursts (ULTIMATE.MARK_BURST_RADIUS). */
  markBurst(x: number, z: number): void {
    const vfx = this.vfx;
    const d = ULTIMATE.MARK_BURST_RADIUS * 2;
    vfx.ring(x, z, 0.6, d * 1.05, 0.4, PALETTE.mark, 0.5, 2.2);
    vfx.stamp(DECAL.SMOKE, x, z, d * 0.6, d * 1.1, 0.8, PALETTE.shadow, 1, 0, 0.9, 0, 0, 0, 0.8);
    vfx.flash(x, 1, z, PALETTE.mark, ULTIMATE.MARK_BURST_RADIUS * 1.6, 0.2, 1.7);
    vfx.sparks(x, 1, z, PALETTE.mark, 16, 10);
    vfx.smoke(x, 0.6, z, PALETTE.shadow, 6, 1, 0.35, 0.8, 1.4);
  }

  // ------------------------------------------------------------------------------------------ reactions

  /** The reaction's own signature on top of the common Resonance burst. */
  reaction(ev: ResonanceEvent): void {
    const def = reactionOf(ev.a, ev.b);
    if (!def) return;
    const vfx = this.vfx;
    const { x, z } = ev;
    const r = ev.r;
    const d = r * 2;
    switch (def.id) {
      case 'shatter': {
        // thermal shock: a frost sigil snaps and the ice flies apart in splinters, steam where fire met it
        vfx.stamp(DECAL.FROST, x, z, d * 0.5, d * 1.05, 0.55, ELEMENT_COLOR.rime, 2, 1, 0.3);
        vfx.shards(x, 0.5, z, ELEMENT_COLOR.rime, 22, 11, 0.6, 0.55);
        vfx.shards(x, 0.9, z, PALETTE.white, 8, 7, 0.4, 0.8);
        vfx.sparks(x, 0.8, z, ELEMENT_COLOR.ember, 14, 9);
        vfx.puff(x, 0.5, z, 0xdfe9f2, 8, r * 0.5, 0.3);
        this.trauma += 0.12;
        break;
      }
      case 'conflagration': {
        // a wall of fire racing outwards, far wider than the burst
        vfx.ring(x, z, d * 0.3, d * 1.08, 0.6, ELEMENT_COLOR.ember, 0.75, 2.4);
        vfx.ring(x, z, d * 0.2, d * 1.22, 0.85, PALETTE.crit, 0.2, 1.7, 0.08);
        vfx.groundFlash(x, z, d * 1.15, 0.9, ELEMENT_COLOR.ember, 1.1);
        for (let k = 0; k < 18; k++) {
          const a = (k / 18) * Math.PI * 2 + Math.random() * 0.2;
          const rr = r * (0.55 + 0.4 * (k % 3) * 0.5);
          vfx.flames(x + Math.sin(a) * rr, 0.2, z + Math.cos(a) * rr, ELEMENT_COLOR.ember, 1.4, 0.3, 1.5 + (k % 3) * 0.35);
        }
        vfx.arcs(x, 0.8, z, ELEMENT_COLOR.storm, 5, r * 0.5);
        this.trauma += 0.15;
        break;
      }
      case 'superconduct': {
        // frost that carries current: jagged rings crawling over a rime plate
        vfx.stamp(DECAL.CRACKLE, x, z, d * 0.2, d * 1.05, 0.7, ELEMENT_COLOR.rime, 2, 1, 0.45, 1);
        vfx.stamp(DECAL.CRACKLE, x, z, d * 0.1, d * 0.8, 0.9, ELEMENT_COLOR.storm, 2, 1, 0.3, 1, 0, 0.1);
        vfx.stamp(DECAL.FROST, x, z, d * 0.8, d * 0.9, 1.3, ELEMENT_COLOR.rime, 1.3, 0.8, 0.15);
        vfx.arcs(x, 0.5, z, ELEMENT_COLOR.storm, 12, r * 0.75);
        vfx.arcs(x, 0.9, z, ELEMENT_COLOR.rime, 7, r * 0.55);
        vfx.frost(x, 0.6, z, ELEMENT_COLOR.rime, 12, r * 0.8);
        break;
      }
      case 'soulfire': {
        // pale green fire with a violet heart, and what it burns away rises as healing light
        vfx.flames(x, 0.3, z, PALETTE.umbra, 14, r * 0.6, 1.7);
        vfx.flames(x, 0.3, z, PALETTE.umbraDeep, 9, r * 0.4, 1.3);
        vfx.stamp(DECAL.SMOKE, x, z, d * 0.6, d * 0.95, 0.9, PALETTE.umbraCore, 1, 0, 0.9, 0, 0, 0, 0.75);
        const heal = REACTION_TUNING.SOULFIRE_HEAL_RADIUS * 2;
        vfx.ring(x, z, d * 0.3, heal, 0.9, PALETTE.heal, 0.16, 1.2, 0.1);
        vfx.groundFlash(x, z, heal * 0.8, 0.9, PALETTE.heal, 0.3, 0.1);
        vfx.motes(x, 0.2, z, PALETTE.heal, 26, r * 1.1, 3.4, 1.5);
        break;
      }
      case 'entomb': {
        // a cage of black ice slams shut and stands for as long as the root lasts
        const p = this.take(this.prisons);
        p.active = true; p.x = x; p.z = z; p.r = Math.min(r * 0.55, 1.9); p.age = 0; p.dur = REACTION_TUNING.ENTOMB_ROOT_SECONDS; p.seed = Math.random(); p.slot = ev.by;
        vfx.stamp(DECAL.FROST, x, z, d * 0.9, d * 0.6, 0.5, TUNE.PRISON_RIM, 1.6, 0.9, 0.3);
        vfx.smoke(x, 0.4, z, PALETTE.umbraCore, 6, r * 0.5, 0.4, 0.9, 1.3);
        vfx.frost(x, 1.2, z, ELEMENT_COLOR.rime, 10, r * 0.6);
        break;
      }
      case 'voidarc': {
        // lightning leaves the burst and jumps from enemy to enemy, far past its radius
        let px = x;
        let pz = z;
        this.seekUsed.length = 0;
        for (let k = 0; k < REACTION_TUNING.VOIDARC_JUMPS; k++) {
          this.seekX = px; this.seekZ = pz; this.seekBest = null; this.seekDist = Infinity;
          this.enemies.forEachActive(this.seek);
          const hit = this.seekBest as EnemyView | null;
          if (!hit) break;
          this.seekUsed.push(hit.id);
          const rot = Math.atan2(hit.x - px, hit.z - pz);
          const len = Math.hypot(hit.x - px, hit.z - pz);
          const delay = k * 0.07;
          vfx.beam(px, pz, rot, len, 0.5, PALETTE.umbraDeep, PALETTE.umbra, delay, 0.36);
          vfx.beam(px, pz, rot, len, 0.22, ELEMENT_COLOR.storm, PALETTE.white, delay + 0.03, 0.28);
          vfx.ring(hit.x, hit.z, 0.4, 3, 0.3, ELEMENT_COLOR.storm, 0.35, 1.8, delay);
          vfx.arcs(hit.x, hit.lift + hit.height * 0.5, hit.z, ELEMENT_COLOR.storm, 6, 1.4);
          vfx.smoke(hit.x, hit.lift + hit.height * 0.5, hit.z, PALETTE.umbraCore, 2, 0.4, 0.45, 0.6, 1);
          px = hit.x; pz = hit.z;
        }
        vfx.stamp(DECAL.CRACKLE, x, z, d * 0.2, d * 0.95, 0.6, ELEMENT_COLOR.storm, 1.8, 1, 0.35, 1);
        vfx.arcs(x, 0.7, z, PALETTE.umbra, 6, r * 0.6);
        break;
      }
    }
  }

  // ------------------------------------------------------------------------------------------ frame

  update(dt: number, time: number, decals: DecalBatch, fx: BillboardBatch): void {
    this.time += dt;
    const vfx = this.vfx;
    for (const s of this.schedule) {
      if (!s.active || s.at > this.time) continue;
      s.active = false;
      this.fire(s);
    }
    for (const z of this.zones) if (z.active) this.drawZone(z, dt, decals, fx);
    vfx.owner(OWNER.WORLD);

    for (const b of this.banners) {
      if (!b.active) continue;
      b.age += dt;
      if (b.age >= b.dur) { b.active = false; continue; }
      // the Banner of the Last Bell: a standard of light planted where the knight called it, its reach drawn on the floor
      const foreign = this.foreign(b.slot);
      const lit = foreign ? TUNE.ALLY_LIGHT : CL.ownFill;
      const a = Math.min(1, b.age * 3, (b.dur - b.age) * 2) * (foreign ? TUNE.ALLY_SHAPE : 1);
      const c = rgb(PALETTE.holy);
      if (foreign && CL.outlines) {
        // the banner's reach and the bell over it: allies inside are protected, that much has to stay
        const uvb = this.atlas.icons.bell;
        decals.push(DECAL.ZONE, b.x, 0.045, b.z, -time * 0.2, b.r * 2, b.r * 2, c[0] * 1.2, c[1] * 1.2, c[2] * 1.2, TUNE.OUTLINE * a, 0.3, 0);
        fx.push(SPRITE.ATLAS, b.x, 2.6, b.z, 0.7, 0.7, 1.3, 1.2, 0.9, 0.8 * a, 0, 0, 0, 0, 0, uvb[0], uvb[1], uvb[2], uvb[3]);
        continue;
      }
      const g = rgb(PALETTE.holyDeep);
      const sh = rgb(PALETTE.shield);
      const sway = Math.sin(time * 2.1) * 0.08;
      const d = b.r * 2;
      decals.push(DECAL.HALLOW, b.x, 0.043, b.z, 0, d, d, c[0] * 1.2, c[1] * 1.2, c[2] * 1.2, 0.6 * a, 1, 0.025, (b.age * 0.6) % 1, 0.45);
      decals.push(DECAL.ZONE, b.x, 0.045, b.z, -time * 0.2, d, d, sh[0] * 1.4, sh[1] * 1.4, sh[2] * 1.4, 0.55 * a, 0.6, 0);
      decals.push(DECAL.DISC, b.x, 0.034, b.z, 0, 4.4, 4.4, c[0], c[1], c[2], 0.3 * a * lit, 1, 0.1);
      fx.push(SPRITE.GLOW, b.x, 2.6, b.z, 0.34, 5.4, c[0] * 1.8, c[1] * 1.8, c[2] * 1.8, 0.9 * a, 1, 1.6);
      fx.push(SPRITE.PLATE, b.x, 4.05, b.z, 1.25, 1.75, g[0] * 0.95, g[1] * 0.8, g[2] * 0.5, 0.96 * a, 0.15, 0, sway, 0.72, 0);
      const uv = this.atlas.icons.bell;
      fx.push(SPRITE.ATLAS, b.x, 4.1, b.z, 0.9, 0.9, 1.5, 1.4, 1.1, a, 0.3, 0, sway, 0.72, 0, uv[0], uv[1], uv[2], uv[3]);
      fx.push(SPRITE.SPARK, b.x, 5.35, b.z, 0.5, 0.5, 2.4, 2.2, 1.6, a, 1, 0, time * 1.5);
      fx.push(SPRITE.GLOW, b.x, 3.4, b.z, 6.5, 6.5, c[0], c[1], c[2], 0.12 * a * lit, 1, 0);
      b.acc += dt * 7 * vfx.density;
      while (b.acc >= 1) { b.acc -= 1; vfx.motes(b.x, 0.2, b.z, PALETTE.holy, 1, 1.4, 3, 1.2); }
    }

    for (const w of this.wards) {
      if (!w.active) continue;
      w.age += dt;
      const h = this.heroes.get(w.slot);
      if (w.age >= w.dur || !h || h.state !== 'alive') { w.active = false; continue; }
      const foreign = this.foreign(w.slot);
      const a = Math.min(1, w.age * 6, (w.dur - w.age) * 3) * (foreign ? TUNE.ALLY_SHAPE : 1);
      const c = rgb(w.hex);
      if (foreign && CL.outlines) {
        decals.push(DECAL.RUNE, h.x + h.offX, 0.046, h.z + h.offZ, time * 2.4, w.r * 2, w.r * 2, c[0] * 1.2, c[1] * 1.2, c[2] * 1.2, TUNE.OUTLINE * a, 0.5, 0);
        continue;
      }
      const x = h.x + h.offX;
      const z = h.z + h.offZ;
      const d = w.r * 2;
      decals.push(DECAL.RUNE, x, 0.046, z, time * 2.4, d, d, c[0] * 1.5, c[1] * 1.5, c[2] * 1.5, 0.75 * a, 0.9, 0.25);
      decals.push(DECAL.DISC, x, 0.033, z, 0, d, d, c[0], c[1], c[2], 0.08 * a, 1, 0.3);
      for (let k = 0; k < TUNE.WARD_SHARDS; k++) {
        const ang = time * 6.5 + (k / TUNE.WARD_SHARDS) * Math.PI * 2;
        const ox = x + Math.sin(ang) * w.r * 0.86;
        const oz = z + Math.cos(ang) * w.r * 0.86;
        fx.push(SPRITE.GLOW, ox, 1.1, oz, 1.3, 1.3, c[0], c[1], c[2], 0.5 * a * (foreign ? TUNE.ALLY_LIGHT : 1), 1, 0.6);
        fx.push(SPRITE.SHARD, ox, 1.1, oz, 0.5, 0.95, c[0] * 1.7, c[1] * 1.7, c[2] * 1.7, a, 0.75, 1, ang);
        decals.push(DECAL.STREAK, ox - Math.cos(ang) * 0.9, 1.05, oz + Math.sin(ang) * 0.9, ang + Math.PI / 2, 0.4, 1.9, c[0] * 1.5, c[1] * 1.5, c[2] * 1.5, 0.7 * a, 1);
      }
    }

    for (const n of this.novas) {
      if (!n.active) continue;
      n.age += dt;
      const h = this.heroes.get(n.slot);
      if (n.age >= n.dur || !h) { n.active = false; continue; }
      // overload gathering: the four elements spiral into the spellblade
      const k = n.age / n.dur;
      const x = h.x + h.offX;
      const z = h.z + h.offZ;
      if (this.foreign(n.slot) && CL.outlines) continue;
      const q = this.foreign(n.slot) ? TUNE.ALLY_LIGHT : CL.ownLight;
      for (let e = 0; e < ALL_ELEMENTS.length; e++) {
        const c = rgb(ELEMENT_COLOR[ALL_ELEMENTS[e]]);
        const ang = e * (Math.PI / 2) + k * 5.5;
        const dist = (1 - k) * n.r * 0.55 + 0.45;
        const ox = x + Math.sin(ang) * dist;
        const oz = z + Math.cos(ang) * dist;
        fx.push(SPRITE.GLOW, ox, 1.1 + 0.5 * k, oz, 0.8 + 0.6 * k, 0.8 + 0.6 * k, c[0] * 1.9, c[1] * 1.9, c[2] * 1.9, 0.95 * q, 1, 1.5);
        decals.push(DECAL.DISC, ox, 0.035, oz, 0, 1.6, 1.6, c[0], c[1], c[2], 0.3 * q, 1, 0);
      }
      const c = rgb(TUNE.RUNE);
      const d = n.r * 2 * (1 - 0.35 * k);
      decals.push(DECAL.RUNE, x, 0.046, z, -time * 3, d, d, c[0] * 1.5, c[1] * 1.5, c[2] * 1.5, 0.7 * Math.min(1, k * 4), 0.9, k);
      fx.push(SPRITE.GLOW, x, 1.3, z, 1 + 2.4 * k, 1 + 2.4 * k, 1.6, 1.6, 1.7, 0.4 * k * q, 1, 1);
    }

    for (const m of this.meteors) {
      if (!m.active) continue;
      m.age += dt;
      if (m.age >= m.dur) { m.active = false; continue; }
      const k = m.age / m.dur;
      const c = rgb(m.hex);
      const w = rgb(PALETTE.arcane);
      const d = m.r * 2;
      const q = this.foreign(m.slot) ? TUNE.ALLY_LIGHT : CL.ownLight;
      if (this.foreign(m.slot) && CL.outlines) {
        // an ally's star: only the closing iris on the floor (stand clear) and a small spark coming down
        const fallK = k * k;
        decals.push(DECAL.WARN, m.x, 0.047, m.z, 0, d, d, w[0] * 1.3, w[1] * 1.3, w[2] * 1.3, 0.4, 0.3, k);
        fx.push(SPRITE.SPARK, m.x + TUNE.STAR_FROM.x * (1 - fallK), 0.6 + TUNE.STAR_FROM.y * (1 - fallK), m.z + TUNE.STAR_FROM.z * (1 - fallK), 0.9, 0.9, c[0] * 1.6, c[1] * 1.6, c[2] * 1.6, 0.9, 1, 0, time * 6);
        continue;
      }
      // for allies: an iris in the caster's blue-white closing on the point of impact, lit warmer as the star nears
      decals.push(DECAL.WARN, m.x, 0.047, m.z, 0, d, d, w[0] * 1.5, w[1] * 1.5, w[2] * 1.5, 0.45, 0.35, k);
      decals.push(DECAL.DISC, m.x, 0.034, m.z, 0, d * (0.5 + 0.7 * k), d * (0.5 + 0.7 * k), c[0], c[1], c[2], (0.1 + 0.4 * k * k) * q, 1, 0.1);
      const fall = k * k;
      const sx = m.x + TUNE.STAR_FROM.x * (1 - fall);
      const sy = 0.6 + TUNE.STAR_FROM.y * (1 - fall);
      const sz = m.z + TUNE.STAR_FROM.z * (1 - fall);
      for (let t = TUNE.STAR_TAIL; t >= 1; t--) {
        const tf = Math.max(0, fall - t * 0.022 * (0.4 + k));
        const f = 1 - t / (TUNE.STAR_TAIL + 1);
        const size = 0.7 + 2.3 * f;
        fx.push(SPRITE.GLOW, m.x + TUNE.STAR_FROM.x * (1 - tf), 0.6 + TUNE.STAR_FROM.y * (1 - tf), m.z + TUNE.STAR_FROM.z * (1 - tf), size, size,
          c[0] * (1 + f), c[1] * (1 + f), c[2] * (1 + f), 0.85 * f * q, 1, 0.8);
      }
      fx.push(SPRITE.GLOW, sx, sy, sz, 3.6, 3.6, c[0] * 1.8, c[1] * 1.8, c[2] * 1.8, q, 1, 1.8);
      fx.push(SPRITE.SPARK, sx, sy, sz, 1.5, 1.5, 2.6, 2.6, 2.6, 1, 1, 0, time * 6);
      fx.push(SPRITE.GLOW, sx, sy, sz, 6, 6, w[0], w[1], w[2], 0.1 * q, 1, 0);
      m.acc += dt * 70 * vfx.density * q;
      while (m.acc >= 1) {
        m.acc -= 1;
        vfx.particle(sx + (Math.random() - 0.5) * 0.9, sy + (Math.random() - 0.5) * 0.9, sz + (Math.random() - 0.5) * 0.9, (Math.random() - 0.5) * 2, 1 + Math.random() * 2,
          (Math.random() - 0.5) * 2, 0.4 + Math.random() * 0.3, 0.3, 0.03, c[0] * 2.2, c[1] * 2.2, c[2] * 2.2, 1, SPRITE.SPARK, 1, 2, 1, 6);
      }
    }

    for (const p of this.prisons) {
      if (!p.active) continue;
      const before = p.age;
      p.age += dt;
      const outline = this.foreign(p.slot) && CL.outlines;
      if (before < p.dur && p.age >= p.dur) {
        vfx.owner(this.foreign(p.slot) ? OWNER.ALLY : OWNER.SELF);
        vfx.shards(p.x, 0.8, p.z, TUNE.PRISON_RIM, 14, 8, 0.5, 0.4);
        vfx.frost(p.x, 0.8, p.z, ELEMENT_COLOR.rime, 8, p.r);
        vfx.owner(OWNER.WORLD);
      }
      if (p.age >= p.dur) { p.active = false; continue; }
      if (outline) {
        // an ally's cage: the frost sigil on the floor says "rooted here", no wall of ice in front of the enemies
        const rimc = rgb(TUNE.PRISON_RIM);
        decals.push(DECAL.FROST, p.x, 0.045, p.z, p.seed * 6, p.r * 3, p.r * 3, rimc[0] * 1.2, rimc[1] * 1.2, rimc[2] * 1.2, TUNE.OUTLINE, 0.5, 0);
        continue;
      }
      // clarity: the own hero's cage is lower and translucent, so whoever stands inside can still be seen
      const see = CL.level === 'full' ? 1 : TUNE.CAGE_SEE;
      const grow = Math.min(1, p.age * 9);
      const pop = grow < 1 ? grow * 1.15 : 1 + 0.15 * Math.max(0, 1 - (p.age - 0.11) * 8);
      const crack = p.age > p.dur - 0.4 ? 0.6 + 0.4 * Math.sin(time * 40) : 1;
      const ice = rgb(TUNE.PRISON_ICE);
      const rim = rgb(TUNE.PRISON_RIM);
      decals.push(DECAL.SMOKE, p.x, 0.036, p.z, p.seed * 6, p.r * 3.6, p.r * 3.6, CORE[0], CORE[1], CORE[2], 0.85, 0, 0.95, rim[0] * 0.5, rim[1] * 0.5, rim[2] * 0.5);
      decals.push(DECAL.FROST, p.x, 0.045, p.z, p.seed * 6, p.r * 3, p.r * 3, rim[0] * 1.3, rim[1] * 1.3, rim[2] * 1.3, 0.8 * crack, 0.6, 0.12);
      // back shards first, so the cage closes around whoever stands inside
      for (let k = 0; k < TUNE.PRISON_SHARDS; k++) {
        const ang = p.seed * 6.283 + (k / TUNE.PRISON_SHARDS) * Math.PI * 2;
        const h = (2.3 + 0.9 * hash1(k * 3.7 + p.seed * 50)) * pop * (see < 1 ? TUNE.CAGE_LOW : 1);
        const lean = Math.sin(ang) * -0.22;
        fx.push(SPRITE.SHARD, p.x + Math.sin(ang) * p.r, h * 0.42, p.z + Math.cos(ang) * p.r, 0.78, h, ice[0] + rim[0] * 0.12, ice[1] + rim[1] * 0.12, ice[2] + rim[2] * 0.12,
          0.96 * crack * see, 0.04, 0.7, lean);
      }
      fx.push(SPRITE.GLOW, p.x, 1.1, p.z, p.r * 3.4, p.r * 3.4, rim[0], rim[1], rim[2], 0.12, 1, 0);
    }
  }

  clear(): void {
    for (const z of this.zones) z.active = false;
    for (const s of this.schedule) s.active = false;
    for (const m of this.meteors) m.active = false;
    for (const b of this.banners) b.active = false;
    for (const w of this.wards) w.active = false;
    for (const n of this.novas) n.active = false;
    for (const p of this.prisons) p.active = false;
    this.trauma = 0;
  }
}
