/**
 * Update 5 "Keystones": everything a held keystone adds to a hero. A keystone has to be SEEN (a different silhouette,
 * a transformed ability), so each of the 23 has its own drawing here. All of it goes through the shared batches:
 * no meshes, no materials, no extra draw call, nothing allocated per frame.
 *
 * Sources:
 *   roster (`RosterView.keystones`) + hero state   lasting things: orbiting blades, the familiar, size, auras, emblems,
 *                                                  the mage's stream, the burning dash trail
 *   `keystone` event                               the moment a keystone is taken (pillar of light)
 *   `keystoneProc` event                           one-shot effects (bounce, arc, shockwave, bloom, veil, ...)
 *   `cast` / `hit` / `kill` / `resonance` events   keystones that change how an ordinary ability or hit looks
 *
 * Clarity (render/clarity.ts): the own hero's keystones are drawn in full; another hero's are reduced to what a
 * team mate has to know (where the blades are, where the trail burns, that the hero is veiled). Red is not used.
 * Draw order: update() must run before Vfx.update(), which draws hostile telegraphs last.
 */
import { EF, PF } from '@shared/types.ts';
import type { ClassId, ElementId, GameEvent } from '@shared/types.ts';
import { NET, TICK_DT } from '@shared/constants.ts';
import { KEYSTONES, KEYSTONE_BY_ID, KEYSTONE_TUNING } from '@shared/data/keystones.ts';
import { CLASSES } from '@shared/data/classes.ts';
import type { AbilityDef } from '@shared/data/classes.ts';
import type { Atlas } from './atlas.ts';
import { DECAL, SPRITE } from './batches.ts';
import type { BillboardBatch, DecalBatch } from './batches.ts';
import type { Heroes, HeroView } from './characters.ts';
import { CL } from './clarity.ts';
import { ELEMENT_COLOR, HERO_VIS, PALETTE } from './config.ts';
import { OWNER, rgb } from './vfx.ts';
import type { Vfx } from './vfx.ts';

type ProcEvent = Extract<GameEvent, { e: 'keystoneProc' }>;

function param(id: string, key: string, fallback: number): number {
  return KEYSTONE_BY_ID.get(id)?.params[key] ?? fallback;
}

/** Numbers of data/keystones.ts the drawings follow (fallbacks only matter if an id is ever removed). */
const P = {
  WAKE_SECONDS: param('ember_wake', 'seconds', 3.5),
  WAKE_WIDTH: param('ember_wake', 'width', 1.6),
  SHOCK_RADIUS: param('shockstep', 'radius', 3.2),
  PHASE_SECONDS: param('phase_walker', 'seconds', 2),
  HEAVY_AREA: param('heavy_hitter', 'area', 0.4),
  HEAVY_SLOW: param('heavy_hitter', 'slow', 0.45),
  TWIN_DELAY: param('twin_cast', 'delay', 0.45),
  TWIN_FRACTION: param('twin_cast', 'fraction', 0.65),
  BLOOD_FRACTION: param('blood_price', 'hpFraction', 0.08),
  BLADES: Math.round(param('orbit_blades', 'blades', 3)),
  BLADE_RADIUS: param('orbit_blades', 'radius', 2.6),
  BLADE_RPM: param('orbit_blades', 'rpm', 60),
  COLOSSUS_SIZE: param('colossus', 'size', 1.25),
  COLOSSUS_AREA: param('colossus', 'area', 0.4),
  BLOOM_RADIUS: param('corpse_bloom', 'radius', 3),
  CHARGE: param('resonance_engine', 'perResonance', 14),
  RUSH_MAX: Math.round(param('momentum_engine', 'max', 10)),
  RUSH_SECONDS: param('momentum_engine', 'seconds', 5),
  KNIGHT_RADIUS: param('ks_knight', 'radius', 3.2),
  WHIRL_LONGER: param('ks_barbarian', 'duration', 0.5),
  STREAM_RANGE: param('ks_mage', 'range', 13),
  STREAM_WIDTH: param('ks_mage', 'width', 0.6),
  FAN_EVERY: Math.round(param('ks_rogue', 'every', 5)),
  FAN_KNIVES: Math.round(param('ks_rogue', 'knives', 5)),
  VEIL_SECONDS: param('ks_shade', 'stealth', 1.5),
} as const;

/** Signature colour of each keystone: its emblem, its pillar of light and, where no element applies, its effect. */
export const KEYSTONE_COLOR: Record<string, number> = {
  ember_wake: PALETTE.ember, shockstep: 0x8fd0ff, phase_walker: 0xc9b8ff, ricochet: 0xdfe9ff, chain_lightning: 0xb9a2ff,
  heavy_hitter: 0xffa64a, twin_cast: 0x7ad7ff, blood_price: 0xd8265e, orbit_blades: 0xcfe0ff, familiar: PALETTE.glimmer,
  colossus: 0xd9b36a, corpse_bloom: 0xc9ff7a, resonance_engine: 0xffe08a, glass_cannon: 0xbfeaff, sanguine: 0xe0356b,
  momentum_engine: 0xffd23f, ks_knight: PALETTE.shield, ks_barbarian: PALETTE.rage, ks_mage: PALETTE.arcane, ks_rogue: 0xe9ffe0,
  ks_templar: PALETTE.holy, ks_spellblade: 0xa8ecff, ks_shade: PALETTE.mark,
};
const FALLBACK_COLOR = PALETTE.objective;

const KS_INDEX = new Map<string, number>(KEYSTONES.map((k, i) => [k.id, i]));
const KS_COUNT = KEYSTONES.length;

const LIMIT = { WAKES: 20, LINKS: 48, GHOSTS: 28, CORPSES: 10 } as const;
/** Kinds of a link (a short-lived line between two points). */
const LK = { BOLT: 0, BOUNCE: 1, LEECH: 2, CHARGE: 3, BLOOM: 4, SHOT: 5 } as const;

const TUNE = {
  /** Dash trail: metres per segment, overlap of neighbouring segments, flames per segment and second. */
  WAKE_OVERLAP: 0.5, WAKE_FLAMES: 1.3, WAKE_FADE_IN: 12, WAKE_MAX: 4,
  /** The same event / state change counted twice (event and snapshot) within this time and distance is drawn once. */
  DUP_TIME: 0.5, DUP_DIST: 2.6,
  PILLAR: 1,
  PILLAR_HEIGHT: 9,
  /** Emblem badges beside the health bar: size, sideways offset, height offset from the label. */
  BADGE: 0.52, BADGE_X: 0.9, BADGE_Y: -0.2, BADGE_POP: 0.45,
  /** Arcs on the hero's ring, one per keystone. */
  ARC_GROW: 0.34, ARC_FRAC: 0.16,
  BLADE_Y: 1.05, BLADE_LEN: 1.55, BLADE_W: 0.5,
  FAMILIAR: { BACK: 0.5, SIDE: 1.45, Y: 2.05, FOLLOW: 6, BOB: 0.16, SIZE: 0.62 },
  STEP_LENGTH: 2.4,
  RUSH_LINES: 5,
  /** Corpse blooms drawn in full within WINDOW seconds (own hero / another hero); the rest are a thin ring. */
  BLOOM_WINDOW: 0.4, BLOOM_OWN: 4, BLOOM_ALLY: 2,
  LEECH_EVERY: 0.12, HEAVY_EVERY: 0.14, HEAVY_WINDOW: 0.9,
  /** Twin Cast: how long before / after the echo is due a second `cast` of the same ability counts as that echo. */
  ECHO_EARLY: 0.25, ECHO_LATE: 0.15,
  STREAM_HOLD: 0.2, STREAM_Y: 1.2, STREAM_MUZZLE: 0.9,
  VEIL_OWN: 0.42, VEIL_ALLY: 0.16,
  /** Other heroes' lasting keystone visuals on the quiet clarity levels / on `full`. */
  ALLY_QUIET: 0.45, ALLY_FULL: 0.7,
  STEEL: 0xdfe9ff,
  GHOST: 0x9fdcff,
  BLOOD: 0xd8265e,
  BLOOD_DARK: 0x4a0a1e,
  PALE: 0xe6fff0,
  DUST: 0x4f4a44,
} as const;

interface Wake { active: boolean; x: number; z: number; rot: number; len: number; width: number; age: number; dur: number; hex: number; slot: number; seed: number; acc: number }
interface Link {
  active: boolean; kind: number; x0: number; z0: number; x1: number; z1: number; age: number; dur: number;
  hex: number; slot: number; follow: number; seed: number; done: boolean;
}
interface Ghost { active: boolean; x: number; z: number; age: number; dur: number; hex: number; alpha: number; size: number; slot: number; scan: number }
interface Corpse { x: number; z: number; hex: number; at: number }

interface SlotState {
  held: string[];
  cls: ClassId;
  /** Time / place a keystone's one-shot was last drawn, per keystone index (dedupe of event versus state). */
  lastT: Float32Array; lastX: Float32Array; lastZ: Float32Array;
  /** Seconds since each held keystone was taken (emblem pop), and the running pillar. */
  takenAge: number[];
  pillarAge: number; pillarHex: number;
  seen: boolean; px: number; pz: number; vx: number; vz: number;
  phaseLeft: number; phaseTotal: number; veilLeft: number; veilTotal: number; veilK: number;
  maelLeft: number; maelTotal: number; maelX: number; maelZ: number; maelR: number;
  bloodPulse: number;
  stacks: number; stackLeft: number; stacksFromProc: boolean; ghostAcc: number;
  chargeFlash: number; lastUlt: number;
  shots: number; fanAt: number;
  famX: number; famZ: number; famInit: boolean; famFlash: number;
  size: number; stepAcc: number;
  shield: number;
  stream: number; streamHold: number;
  echoAt: number; echoAbility: string; echoX: number; echoZ: number; echoRot: number;
  vortexLeft: number; vortexTotal: number; vortexX: number; vortexZ: number; vortexR: number; vortexFollow: boolean; vortexDelay: number;
  leechAt: number; heavyAt: number; castAt: number; glassAt: number;
}

function hash1(n: number): number {
  const s = Math.sin(n * 127.1) * 43758.5453;
  return s - Math.floor(s);
}

export class KeystoneFx {
  private readonly vfx: Vfx;
  private readonly atlas: Atlas;
  private readonly heroes: Heroes;
  private readonly slots: SlotState[] = [];
  private readonly wakes: Wake[] = [];
  private readonly links: Link[] = [];
  private readonly ghosts: Ghost[] = [];
  private readonly corpses: Corpse[] = [];
  private corpseCursor = 0;
  private readonly bloomTimes: number[] = [0, 0, 0, 0, 0, 0];
  private bloomCursor = 0;
  private time = 0;
  private tick = 0;
  private trauma = 0;
  private halfW = 0;
  private halfD = 0;
  /** Slot of the own hero (-1 = none: everything is drawn in full). */
  localSlot = -1;
  /** A due Twin Cast echo the view has to replay (see takeEcho). */
  private replaySlot = -1;
  /** True while the view replays an echo, so that cast does not schedule another one. */
  echoing = false;

  constructor(vfx: Vfx, atlas: Atlas, heroes: Heroes) {
    this.vfx = vfx;
    this.atlas = atlas;
    this.heroes = heroes;
    for (let i = 0; i < NET.MAX_PLAYERS; i++) {
      this.slots.push({
        held: [], cls: 'knight', lastT: new Float32Array(KS_COUNT).fill(-100), lastX: new Float32Array(KS_COUNT), lastZ: new Float32Array(KS_COUNT),
        takenAge: [10, 10], pillarAge: -1, pillarHex: 0, seen: false, px: 0, pz: 0, vx: 0, vz: 0,
        phaseLeft: 0, phaseTotal: 1, veilLeft: 0, veilTotal: 1, veilK: 0, maelLeft: 0, maelTotal: 1, maelX: 0, maelZ: 0, maelR: 1, bloodPulse: 0,
        stacks: 0, stackLeft: 0, stacksFromProc: false, ghostAcc: 0, chargeFlash: 0, lastUlt: 0, shots: 0, fanAt: -100,
        famX: 0, famZ: 0, famInit: false, famFlash: 0, size: 1, stepAcc: 0, shield: 0, stream: 0, streamHold: 0,
        echoAt: -1, echoAbility: '', echoX: 0, echoZ: 0, echoRot: 0,
        vortexLeft: 0, vortexTotal: 1, vortexX: 0, vortexZ: 0, vortexR: 1, vortexFollow: false, vortexDelay: 0,
        leechAt: -100, heavyAt: -100, castAt: -100, glassAt: -100,
      });
    }
    for (let i = 0; i < LIMIT.WAKES; i++) this.wakes.push({ active: false, x: 0, z: 0, rot: 0, len: 1, width: 1, age: 0, dur: 1, hex: 0, slot: -1, seed: 0, acc: 0 });
    for (let i = 0; i < LIMIT.LINKS; i++) {
      this.links.push({ active: false, kind: 0, x0: 0, z0: 0, x1: 0, z1: 0, age: 0, dur: 1, hex: 0, slot: -1, follow: -1, seed: 0, done: false });
    }
    for (let i = 0; i < LIMIT.GHOSTS; i++) this.ghosts.push({ active: false, x: 0, z: 0, age: 0, dur: 1, hex: 0, alpha: 1, size: 1, slot: -1, scan: 0.6 });
    for (let i = 0; i < LIMIT.CORPSES; i++) this.corpses.push({ x: 0, z: 0, hex: 0, at: -100 });
  }

  // ------------------------------------------------------------------ roster / queries

  /** Keystones per hero from the roster (missing = none). Call whenever the roster changes. */
  setRoster(entries: readonly { slot: number; cls: ClassId; keystones?: readonly string[] }[]): void {
    for (let s = 0; s < this.slots.length; s++) {
      const st = this.slots[s];
      let entry: { slot: number; cls: ClassId; keystones?: readonly string[] } | null = null;
      for (const e of entries) if (e.slot === s) entry = e;
      const want = entry?.keystones ?? [];
      if (entry) st.cls = entry.cls;
      let same = want.length === st.held.length;
      for (let i = 0; same && i < want.length; i++) same = want[i] === st.held[i];
      if (same) continue;
      // keep the pop timers of keystones that stay
      const ages = want.map((id) => { const i = st.held.indexOf(id); return i >= 0 ? st.takenAge[i] ?? 10 : 10; });
      st.held.length = 0;
      for (let i = 0; i < want.length && i < KEYSTONE_TUNING.MAX_HELD; i++) { st.held.push(want[i]); st.takenAge[i] = ages[i]; }
      this.dropLost(st);
    }
  }

  /** State of keystones a hero no longer holds is forgotten at once. */
  private dropLost(st: SlotState): void {
    if (!st.held.includes('momentum_engine')) { st.stacks = 0; st.stackLeft = 0; st.stacksFromProc = false; }
    if (!st.held.includes('phase_walker')) st.phaseLeft = 0;
    if (!st.held.includes('ks_shade')) st.veilLeft = 0;
    if (!st.held.includes('familiar')) st.famInit = false;
    if (!st.held.includes('ks_rogue')) st.shots = 0;
    if (!st.held.includes('twin_cast')) st.echoAt = -1;
    if (!st.held.includes('ks_barbarian')) st.vortexLeft = 0;
  }

  has(slot: number, id: string): boolean {
    const st = this.slots[slot];
    return st !== undefined && st.held.includes(id);
  }

  /** Factor on the drawn size of a hero's areas (Colossus). */
  areaMul(slot: number): number {
    return this.has(slot, 'colossus') ? 1 + P.COLOSSUS_AREA : 1;
  }

  /** Titan Grip: reach factor and duration factor of a primary swing (1, 1 without it). */
  heavyReach(slot: number): number {
    return this.has(slot, 'heavy_hitter') ? 1 + P.HEAVY_AREA * 0.5 : 1;
  }

  /** Titan Grip: factor on the angle of a primary arc and on the width of projectiles and the stream. */
  heavyWide(slot: number): number {
    return this.has(slot, 'heavy_hitter') ? 1 + P.HEAVY_AREA : 1;
  }

  heavySlow(slot: number): number {
    return this.has(slot, 'heavy_hitter') ? 1 / Math.max(0.2, 1 - P.HEAVY_SLOW) : 1;
  }

  /** Walking Sanctum: this hero's hallowed ground follows it. */
  sanctum(slot: number): boolean {
    return this.has(slot, 'ks_templar');
  }

  /** Arc Stream: the mage's bolts are a beam; the per-bolt muzzle flash is left out. */
  streaming(slot: number): boolean {
    return this.has(slot, 'ks_mage');
  }

  setBounds(width: number, depth: number): void {
    this.halfW = width / 2;
    this.halfD = depth / 2;
  }

  takeShake(): number {
    const t = this.trauma;
    this.trauma = 0;
    return t;
  }

  /** Lasting keystone effects in play (debug overlay). */
  get active(): number {
    let n = 0;
    for (const w of this.wakes) if (w.active) n++;
    for (const l of this.links) if (l.active) n++;
    for (const g of this.ghosts) if (g.active) n++;
    return n;
  }

  private foreign(slot: number): boolean {
    return this.localSlot >= 0 && slot >= 0 && slot !== this.localSlot;
  }

  /** Strength of another hero's lasting keystone visuals (1 for the own hero). */
  private level(slot: number): number {
    if (!this.foreign(slot)) return 1;
    return CL.outlines ? TUNE.ALLY_QUIET : TUNE.ALLY_FULL;
  }

  private elementHex(slot: number, ability: 'primary' | 'secondary' | 'dash', fallback: number): number {
    const el = this.heroes.infusion(slot, ability);
    return el ? ELEMENT_COLOR[el] : fallback;
  }

  /** Was this keystone's one-shot already drawn here a moment ago (the event and the state both report it)? */
  private dup(st: SlotState, id: string, x: number, z: number): boolean {
    const i = KS_INDEX.get(id);
    if (i === undefined) return false;
    const again = this.time - st.lastT[i] < TUNE.DUP_TIME && Math.hypot(st.lastX[i] - x, st.lastZ[i] - z) < TUNE.DUP_DIST;
    if (!again) { st.lastT[i] = this.time; st.lastX[i] = x; st.lastZ[i] = z; }
    return again;
  }

  // ------------------------------------------------------------------ pools

  private wake(slot: number, x0: number, z0: number, x1: number, z1: number, hex: number, width: number): void {
    const len = Math.hypot(x1 - x0, z1 - z0);
    if (len < 0.15) return;
    let w: Wake | null = null;
    for (const c of this.wakes) if (!c.active) { w = c; break; }
    if (!w) {
      w = this.wakes[0];
      for (const c of this.wakes) if (c.dur - c.age < w.dur - w.age) w = c;
    }
    w.active = true; w.slot = slot; w.x = (x0 + x1) / 2; w.z = (z0 + z1) / 2; w.rot = Math.atan2(x1 - x0, z1 - z0);
    w.len = len + TUNE.WAKE_OVERLAP; w.width = width; w.age = 0; w.dur = P.WAKE_SECONDS; w.hex = hex; w.seed = Math.random(); w.acc = Math.random();
  }

  private link(kind: number, slot: number, x0: number, z0: number, x1: number, z1: number, dur: number, hex: number, follow = -1): Link {
    let l: Link | null = null;
    for (const c of this.links) if (!c.active) { l = c; break; }
    if (!l) {
      l = this.links[0];
      for (const c of this.links) if (c.dur - c.age < l.dur - l.age) l = c;
    }
    l.active = true; l.kind = kind; l.slot = slot; l.x0 = x0; l.z0 = z0; l.x1 = x1; l.z1 = z1; l.age = 0; l.dur = dur; l.hex = hex;
    l.follow = follow; l.seed = Math.random() * 60; l.done = false;
    return l;
  }

  private ghost(slot: number, x: number, z: number, dur: number, hex: number, alpha: number, size = 1, scan = 0.6): void {
    let g: Ghost | null = null;
    for (const c of this.ghosts) if (!c.active) { g = c; break; }
    if (!g) {
      g = this.ghosts[0];
      for (const c of this.ghosts) if (c.dur - c.age < g.dur - g.age) g = c;
    }
    g.active = true; g.slot = slot; g.x = x; g.z = z; g.age = 0; g.dur = dur; g.hex = hex; g.alpha = alpha; g.size = size; g.scan = scan;
  }

  // ------------------------------------------------------------------ events

  /** `keystone` event: a hero took a keystone. The pillar of light, and the emblem that then stays at the health bar. */
  taken(slot: number, id: string, replaced?: string): void {
    const st = this.slots[slot];
    if (!st) return;
    // the roster follows a moment later; show it right away
    if (!st.held.includes(id)) {
      const at = replaced ? st.held.indexOf(replaced) : -1;
      if (at >= 0) st.held[at] = id;
      else if (st.held.length < KEYSTONE_TUNING.MAX_HELD) st.held.push(id);
      else st.held[st.held.length - 1] = id;
      this.dropLost(st);
    }
    const index = st.held.indexOf(id);
    if (index >= 0) st.takenAge[index] = 0;
    const hex = KEYSTONE_COLOR[id] ?? FALLBACK_COLOR;
    st.pillarAge = 0;
    st.pillarHex = hex;
    const h = this.heroes.get(slot);
    if (!h) return;
    const vfx = this.vfx;
    const x = h.x + h.offX;
    const z = h.z + h.offZ;
    vfx.ring(x, z, 7, 1.2, 0.35, hex, 0.3, 1.6);
    vfx.ring(x, z, 0.8, 7.5, 0.7, hex, 0.45, 2, 0.3);
    vfx.groundFlash(x, z, 7, 0.9, hex, 0.9, 0.3);
    vfx.flash(x, 1.3, z, hex, 4.5, 0.45, 1.6);
    vfx.motes(x, 0.2, z, hex, 26, 0.9, 5, 1.2);
    vfx.sparks(x, 1.4, z, PALETTE.white, 14, 9);
    const uv = this.atlas.emblems.get(id);
    if (uv) vfx.iconPop(x, HERO_VIS.LABEL_Y + 1.5, z, uv, hex, this.foreign(slot) ? 1 : 1.5);
    if (!this.foreign(slot)) this.trauma += 0.3;
  }

  /** `keystoneProc` event. Unknown ids are ignored. */
  proc(ev: ProcEvent): void {
    const st = this.slots[ev.slot];
    if (!st) return;
    const vfx = this.vfx;
    const slot = ev.slot;
    const own = !this.foreign(slot);
    const hero = this.heroes.get(slot);
    const hx = hero ? hero.x + hero.offX : ev.x;
    const hz = hero ? hero.z + hero.offZ : ev.z;
    const far = ev.tx !== undefined && ev.tz !== undefined;
    const tx = ev.tx ?? ev.x;
    const tz = ev.tz ?? ev.z;
    switch (ev.id) {
      case 'ember_wake': {
        // the dash ended: the trail is the segment from its start to its end; r = half width
        if (!far) break;
        let mine = 0;
        let oldest: Wake | null = null;
        for (const w of this.wakes) if (w.active && w.slot === slot) { mine++; if (!oldest || w.age > oldest.age) oldest = w; }
        if (mine >= TUNE.WAKE_MAX && oldest) oldest.active = false;
        this.wake(slot, ev.x, ev.z, tx, tz, this.elementHex(slot, 'dash', PALETTE.ember), (ev.r ?? P.WAKE_WIDTH / 2) * 2);
        const hex = this.elementHex(slot, 'dash', PALETTE.ember);
        vfx.flames(tx, 0.2, tz, hex, 5, 0.6, 0.9);
        break;
      }
      case 'shockstep':
        this.shockstep(st, slot, ev.x, ev.z, ev.r ?? P.SHOCK_RADIUS);
        break;
      case 'phase_walker': {
        // the hero passed through an enemy at (x, z): its after-image hangs there, and the empowered window opens
        const hex = KEYSTONE_COLOR.phase_walker;
        if (st.phaseLeft <= 0) { st.phaseLeft = P.PHASE_SECONDS; st.phaseTotal = P.PHASE_SECONDS; }
        this.ghost(slot, ev.x, ev.z, 0.6, hex, own ? 0.85 : 0.4, 1.05, 0.8);
        this.ghost(slot, (ev.x + hx) / 2, (ev.z + hz) / 2, 0.45, hex, own ? 0.5 : 0.25, 1, 0.8);
        vfx.ring(ev.x, ev.z, 0.5, 3, 0.3, hex, 0.3, 1.7);
        vfx.flash(hx, 1.2, hz, hex, 3, 0.3, 1.5);
        vfx.sparks(ev.x, 1.1, ev.z, hex, 10, 7);
        break;
      }
      case 'ricochet': {
        const hex = this.elementHex(slot, 'primary', TUNE.STEEL);
        this.link(LK.BOUNCE, slot, ev.x, ev.z, tx, tz, 0.5, hex);
        vfx.ring(ev.x, ev.z, 0.4, 2, 0.22, hex, 0.3, 1.6);
        vfx.sparks(ev.x, 1.1, ev.z, hex, 5, 6);
        break;
      }
      case 'chain_lightning': {
        const hex = this.elementHex(slot, 'primary', KEYSTONE_COLOR.chain_lightning);
        this.link(LK.BOLT, slot, ev.x, ev.z, tx, tz, 0.26, hex);
        vfx.flash(tx, 1.1, tz, hex, 1.6, 0.14, 1.5);
        vfx.sparks(tx, 1.1, tz, hex, 4, 6);
        break;
      }
      case 'heavy_hitter':
        // the release of a primary; the swing itself is drawn from its cast, the impact from its hits
        break;
      case 'twin_cast':
        // the repeat goes off now: the view replays the cast it saw; without one, a bare mark where it happens
        if (st.echoAt >= 0 && this.replaySlot < 0) { st.echoAt = -1; this.replaySlot = slot; }
        else if (st.echoAt < 0) {
          vfx.ring(far ? tx : ev.x, far ? tz : ev.z, 0.6, (ev.r ?? 2) * 2, 0.4, TUNE.GHOST, 0.3, 1.6);
          this.ghost(slot, hx, hz, 0.4, TUNE.GHOST, own ? 0.7 : 0.3);
        }
        break;
      case 'blood_price':
        this.bloodPrice(st, slot, hero, ev.n ?? 0);
        break;
      case 'orbit_blades': {
        // a blade cut something at (x, z)
        const hex = this.elementHex(slot, 'primary', TUNE.STEEL);
        vfx.sparks(ev.x, TUNE.BLADE_Y, ev.z, hex, 5, 6);
        vfx.flash(ev.x, TUNE.BLADE_Y, ev.z, hex, 1.1, 0.1, 1.4);
        break;
      }
      case 'familiar': {
        // the wisp shot at (tx, tz), or at (x, z) when only one point is given
        const hex = this.elementHex(slot, 'primary', PALETTE.glimmer);
        const fy = st.famInit;
        this.link(LK.SHOT, slot, fy ? st.famX : hx, fy ? st.famZ : hz, tx, tz, 0.2, hex);
        st.famFlash = 1;
        vfx.flash(tx, 1.1, tz, hex, 1.3, 0.12, 1.4);
        vfx.sparks(tx, 1.1, tz, hex, 4, 5);
        break;
      }
      case 'colossus':
        vfx.puff(ev.x, 0.25, ev.z, TUNE.DUST, 5, 0.9, 0.35);
        vfx.ring(ev.x, ev.z, 0.6, (ev.r ?? 1.6) * 2, 0.3, KEYSTONE_COLOR.colossus, 0.3, 1.4);
        break;
      case 'corpse_bloom':
        this.bloom(slot, ev.x, ev.z, ev.r ?? P.BLOOM_RADIUS, far, tx, tz);
        break;
      case 'resonance_engine':
        this.charge(st, slot, ev.x, ev.z);
        break;
      case 'glass_cannon':
        vfx.shards(ev.x, 1.1, ev.z, KEYSTONE_COLOR.glass_cannon, 5, 8, 0.3, 0.6);
        break;
      case 'sanguine': {
        // health came in (n); the motes themselves fly from the enemies that were struck (onHit)
        if (hero && !this.foreign(slot)) vfx.ring(hx, hz, 2.6, 0.9, 0.3, KEYSTONE_COLOR.sanguine, 0.2, 1.4);
        break;
      }
      case 'momentum_engine':
        // n = stacks now
        st.stacksFromProc = true;
        st.stacks = Math.max(0, Math.min(P.RUSH_MAX, Math.round(ev.n ?? st.stacks + 1)));
        st.stackLeft = st.stacks > 0 ? P.RUSH_SECONDS : 0;
        if (hero && st.stacks > 0) vfx.ring(hx, hz, 0.6, 2.4 + st.stacks * 0.12, 0.25, KEYSTONE_COLOR.momentum_engine, 0.25, 1.5);
        break;
      case 'ks_knight':
        this.shieldBurst(st, slot, ev.x, ev.z, ev.r ?? P.KNIGHT_RADIUS);
        break;
      case 'ks_barbarian':
        // Whirlwind started: the drag turns around the hero for as long as it spins; r = pull reach
        this.vortex(st, hx, hz, ev.r ?? CLASSES.barbarian.secondary.radius, CLASSES.barbarian.secondary.duration * (1 + P.WHIRL_LONGER), true, 0);
        break;
      case 'ks_rogue':
        this.fan(st, slot, hero);
        break;
      case 'ks_spellblade':
        if (hero) this.waves(slot, hx, hz, hero.rot, Math.max(1, Math.min(3, Math.round(ev.n ?? 1))), 0, this.elementHex(slot, 'primary', KEYSTONE_COLOR.ks_spellblade));
        break;
      case 'ks_shade': {
        // a backstab kill at (x, z): the dark the victim leaves closes around the shade (the veil itself is its buff)
        if (st.veilLeft <= 0) { st.veilLeft = P.VEIL_SECONDS; st.veilTotal = P.VEIL_SECONDS; }
        vfx.smoke(ev.x, 0.8, ev.z, PALETTE.shadow, 6, 0.6, 0.4, 0.8, 1.3);
        this.link(LK.BLOOM, slot, ev.x, ev.z, hx, hz, 0.3, PALETTE.mark);
        vfx.smoke(hx, 0.8, hz, PALETTE.shadow, 8, 0.8, 0.4, 0.9, 1.5);
        vfx.ring(hx, hz, 3.4, 0.8, 0.3, PALETTE.mark, 0.25, 1.5);
        vfx.sparks(hx, 1.1, hz, PALETTE.mark, 8, 5);
        break;
      }
      default:
        break;
    }
  }

  /**
   * A hero used an ability (`cast`). `echo` = this cast is a Twin Cast echo. Draws what a keystone adds to that
   * ability; the ordinary look of the ability stays with the caller.
   */
  onCast(slot: number, def: AbilityDef, cls: ClassId, x: number, z: number, rot: number, hx: number, hz: number, color: number, echo: boolean): void {
    const st = this.slots[slot];
    if (!st || st.held.length === 0) return;
    const vfx = this.vfx;
    const primary = def.anim === 'primary1' || def.anim === 'primary2' || def.anim === 'primary3';
    const secondary = def.anim === 'secondary' || def.anim === 'art';
    const own = !this.foreign(slot);
    st.castAt = this.time;
    if (primary && st.held.includes('heavy_hitter')) {
      // the weight of it: dust under the swing and a second, slower crescent behind the first
      const hex = KEYSTONE_COLOR.heavy_hitter;
      const reach = def.shape === 'arc' ? def.range * this.heavyReach(slot) * this.areaMul(slot) : 2.6;
      vfx.slash(hx, hz, rot, reach * 0.82, Math.min(Math.PI * 1.7, (def.arc > 0 ? def.arc : 120) * (Math.PI / 180) * 1.1), 0.5, hex, -1, def.windup * 0.9 + 0.06, slot, 1.5);
      vfx.puff(hx + Math.sin(rot) * reach * 0.6, 0.25, hz + Math.cos(rot) * reach * 0.6, TUNE.DUST, 5, reach * 0.3, 0.32);
      if (def.shape === 'projectile') vfx.ring(hx + Math.sin(rot), hz + Math.cos(rot), 0.5, 3.4, 0.3, hex, 0.4, 1.7, def.windup);
      if (own) this.trauma += 0.07;
    }
    if (primary && cls === 'rogue' && st.held.includes('ks_rogue') && def.shape === 'projectile') {
      // counted for the tell only; the fan itself is announced by its keystoneProc
      st.shots = (st.shots + 1) % P.FAN_EVERY;
    }
    if (secondary && !echo && !this.echoing && st.held.includes('twin_cast')) {
      // the echo is announced by a ghost that stands where the cast was made and casts again when it is due
      st.echoAt = this.time + P.TWIN_DELAY;
      st.echoAbility = def.id; st.echoX = x; st.echoZ = z; st.echoRot = rot;
      // (it steps out to the hero's right, so the two can be told apart)
      const gx = hx + Math.cos(rot) * -1.9;
      const gz = hz - Math.sin(rot) * -1.9;
      this.ghost(slot, gx, gz, P.TWIN_DELAY + 0.35, TUNE.GHOST, own ? 1 : 0.4, 1.25, 0.35);
      vfx.ring(gx, gz, 2.6, 0.9, P.TWIN_DELAY, TUNE.GHOST, 0.2, 1.5);
      vfx.sparks(gx, 1.2, gz, TUNE.GHOST, 6, 4);
    }
    void cls; void color;
  }

  /** `buff` event with a keystone's id: the empowered window of Phase Walker, the shade's veil. Returns true when it was one. */
  buff(slot: number, id: string, dur: number): boolean {
    const st = this.slots[slot];
    if (!st) return false;
    if (id === 'phase_walker') { st.phaseLeft = dur; st.phaseTotal = Math.max(0.1, dur); return true; }
    if (id === 'ks_shade') { st.veilLeft = dur; st.veilTotal = Math.max(0.1, dur); return true; }
    return false;
  }

  /** `zone` of kind `ks_barbarian`: the maelstrom a Skullsplitter leaves where it lands. */
  maelstrom(slot: number, x: number, z: number, r: number, dur: number): void {
    const st = this.slots[slot];
    if (!st) return;
    st.maelLeft = dur; st.maelTotal = Math.max(0.1, dur); st.maelX = x; st.maelZ = z; st.maelR = r;
    this.vfx.ring(x, z, r * 2.2, 1, 0.35, this.elementHex(slot, 'secondary', KEYSTONE_COLOR.ks_barbarian), 0.3, 1.6);
  }

  /** `chamberClear`: the burning trails go out with the fight. */
  chamberClear(): void {
    for (const w of this.wakes) if (w.active && w.dur - w.age > 0.4) w.dur = w.age + 0.4;
  }

  /**
   * Twin Cast: is this `cast` the simulation's own second cast of a pending echo? Then it is drawn as the echo
   * (weaker, in the ghost's colour) and no replay happens.
   */
  claimEcho(slot: number, ability: string): boolean {
    const st = this.slots[slot];
    if (!st || st.echoAt < 0 || st.echoAbility !== ability) return false;
    if (this.time < st.echoAt - TUNE.ECHO_EARLY) return false;
    st.echoAt = -1;
    return true;
  }

  /**
   * Twin Cast: slot whose echo is due and was not announced by a second `cast` (-1 = none). The view replays that
   * cast's effect (echoAbility / echoX / echoZ / echoRot of the returned slot) with `echoing` set.
   */
  takeEcho(): number {
    const s = this.replaySlot;
    this.replaySlot = -1;
    return s;
  }

  echoOf(slot: number): { echoAbility: string; echoX: number; echoZ: number; echoRot: number } {
    return this.slots[slot];
  }

  /** The echo's own mark on top of the replayed ability. */
  echoFlourish(slot: number, x: number, z: number): void {
    const hero = this.heroes.get(slot);
    const hx = hero ? hero.x + hero.offX : x;
    const hz = hero ? hero.z + hero.offZ : z;
    this.vfx.ring(hx, hz, 0.8, 4.2, 0.4, TUNE.GHOST, 0.3, 1.7);
    this.vfx.flash(hx, 1.3, hz, TUNE.GHOST, 2.6, 0.2, 1.4);
    this.vfx.sparks(hx, 1.2, hz, TUNE.GHOST, 8, 6);
  }

  /** A hero's hit on an enemy at (x, y, z). */
  onHit(by: number, x: number, y: number, z: number, crit: boolean, el: ElementId | null): void {
    const st = this.slots[by];
    if (!st || st.held.length === 0) return;
    const vfx = this.vfx;
    if (st.held.includes('glass_cannon') && this.time - st.glassAt > 0.05) {
      // sharper: every hit throws splinters and a hard white star
      st.glassAt = this.time;
      const hex = el ? ELEMENT_COLOR[el] : KEYSTONE_COLOR.glass_cannon;
      vfx.shards(x, y, z, hex, crit ? 5 : 3, 9, 0.26, 0.7);
      vfx.particle(x, y, z, 0, 0, 0, 0.14, 1.5, 0.3, 1.8, 1.9, 2, 1, SPRITE.SPARK, 1, 0, 0, 14);
    }
    if (st.held.includes('heavy_hitter') && this.time - st.castAt < TUNE.HEAVY_WINDOW) this.heavyImpact(st, by, x, z);
    if (st.held.includes('sanguine')) this.leech(st, by, x, z, false);
    if (st.phaseLeft > 0 && crit) {
      // the promised critical hit lands
      st.phaseLeft = 0;
      const hex = KEYSTONE_COLOR.phase_walker;
      vfx.ring(x, z, 0.5, 4.2, 0.35, hex, 0.45, 2);
      vfx.flash(x, y, z, hex, 3.2, 0.2, 1.7);
      vfx.sparks(x, y, z, PALETTE.crit, 12, 10);
      if (!this.foreign(by)) this.trauma += 0.12;
    }
    if (st.veilLeft > 0) {
      // out of the veil with a knife
      st.veilLeft = 0;
      vfx.ring(x, z, 0.5, 3.6, 0.3, PALETTE.mark, 0.4, 1.9);
      vfx.smoke(x, y, z, PALETTE.shadow, 4, 0.5, 0.4, 0.6, 1.1);
      vfx.sparks(x, y, z, PALETTE.mark, 10, 9);
    }
  }

  /** A hero killed an enemy that carried `flags` (EF.*). */
  onKill(by: number, x: number, z: number, flags: number): void {
    // remember what the corpse carried: a bloom there takes that status' colour
    const c = this.corpses[this.corpseCursor];
    this.corpseCursor = (this.corpseCursor + 1) % this.corpses.length;
    c.x = x; c.z = z; c.at = this.time;
    c.hex = flags & EF.BURN ? PALETTE.ember : flags & EF.CHILL ? PALETTE.rime : flags & EF.SHOCK ? PALETTE.storm : flags & EF.WITHER ? PALETTE.umbra : 0;
    const st = this.slots[by];
    if (!st) return;
    if (st.held.includes('momentum_engine') && !st.stacksFromProc) {
      st.stacks = Math.min(P.RUSH_MAX, st.stacks + 1);
      st.stackLeft = P.RUSH_SECONDS;
    }
  }

  /** A hero triggered a Resonance at (x, z). */
  onResonance(by: number, x: number, z: number): void {
    const st = this.slots[by];
    if (st && st.held.includes('resonance_engine')) this.charge(st, by, x, z);
  }

  // ------------------------------------------------------------------ one-shots

  private shockstep(st: SlotState, slot: number, x: number, z: number, r: number): void {
    if (this.dup(st, 'shockstep', x, z)) return;
    const vfx = this.vfx;
    const hex = this.elementHex(slot, 'dash', KEYSTONE_COLOR.shockstep);
    const d = r * 2;
    vfx.ring(x, z, 0.8, d * 1.04, 0.42, hex, 0.5, 2.1);
    vfx.ring(x, z, 0.5, d * 0.7, 0.5, PALETTE.white, 0.2, 1.2, 0.05);
    vfx.stamp(DECAL.CRACKLE, x, z, d * 0.4, d * 1.02, 0.45, hex, 1.6, 1, 0.4, 0.9);
    vfx.groundFlash(x, z, d * 1.05, 0.4, hex, 0.7);
    vfx.flash(x, 0.7, z, hex, r * 1.3, 0.16, 1.2);
    vfx.puff(x, 0.25, z, TUNE.DUST, 8, r * 0.7, 0.34);
    vfx.sparks(x, 0.4, z, hex, 12, 9);
    if (!this.foreign(slot)) this.trauma += 0.16;
  }

  private heavyImpact(st: SlotState, slot: number, x: number, z: number): void {
    if (this.time - st.heavyAt < TUNE.HEAVY_EVERY) return;
    st.heavyAt = this.time;
    const vfx = this.vfx;
    const hex = KEYSTONE_COLOR.heavy_hitter;
    vfx.ring(x, z, 0.5, 3.6, 0.32, hex, 0.45, 1.9);
    vfx.stamp(DECAL.CRACKLE, x, z, 1, 3.2, 0.4, hex, 1.5, 1, 0.35, 0.8);
    vfx.puff(x, 0.25, z, TUNE.DUST, 5, 0.8, 0.35);
    vfx.shards(x, 0.3, z, 0x8a7a66, 4, 6, 0.3, 0);
    if (!this.foreign(slot)) this.trauma += 0.1;
  }

  private bloodPrice(st: SlotState, slot: number, hero: HeroView | null, paid: number): void {
    if (!hero) return;
    const x = hero.x + hero.offX;
    const z = hero.z + hero.offZ;
    if (this.dup(st, 'blood_price', x, z)) return;
    const vfx = this.vfx;
    st.bloodPulse = 1;
    // the price is drawn out of the body: a ring closing on the hero, drops falling, a piece off the health bar
    vfx.ring(x, z, 4.2, 0.9, 0.3, TUNE.BLOOD, 0.3, 1.6);
    vfx.stamp(DECAL.DISC, x, z, 1.2, 2.8, 0.5, TUNE.BLOOD_DARK, 1, 0, 0.5, 0, 0, 0, 0.7);
    const c = rgb(TUNE.BLOOD);
    const own = !this.foreign(slot);
    const drops = own ? 9 : CL.outlines ? 0 : 4;
    for (let i = 0; i < drops; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 1.2 + Math.random() * 2.2;
      vfx.particle(x + Math.sin(a) * 0.3, 1.5 + Math.random() * 0.6, z + Math.cos(a) * 0.3, Math.sin(a) * sp, 1.5 + Math.random() * 2, Math.cos(a) * sp,
        0.5 + Math.random() * 0.3, 0.2, 0.08, c[0] * 1.1, c[1] * 1.1, c[2] * 1.1, 0.95, SPRITE.GLOW, 0.25, 12, 0.6, 0, 1.4);
    }
    const y = HERO_VIS.LABEL_Y + HERO_VIS.HEIGHT * (hero.size - 1);
    // the chip: a slab of the bar that tips off to the right and falls
    vfx.particle(x + 0.45, y - 0.2, z, 1.4, 1.6, 0, 0.55, 0.3, 0.22, c[0] * 1.2, c[1] * 1.2, c[2] * 1.2, 1, SPRITE.SHARD, 0.2, 13, 0.4, 9, 0.4, 0.6);
    if (own) vfx.number(x, y + 0.2, z, Math.max(1, Math.round(paid > 0 ? paid : hero.maxHp * P.BLOOD_FRACTION)), TUNE.BLOOD, 0.8, 0, -(slot * 4 + 3), false);
    hero.hitFlash(c[0], c[1], c[2], 0.55);
  }

  private charge(st: SlotState, slot: number, x: number, z: number): void {
    if (this.dup(st, 'resonance_engine', x, z)) return;
    this.link(LK.CHARGE, slot, x, z, x, z, 0.38, KEYSTONE_COLOR.resonance_engine, slot);
  }

  private leech(st: SlotState, slot: number, x: number, z: number, always: boolean): void {
    if (!always && this.time - st.leechAt < TUNE.LEECH_EVERY) return;
    st.leechAt = this.time;
    // another hero's leech is one mote in four on the quiet levels
    if (this.foreign(slot) && CL.outlines && Math.random() > 0.25) return;
    this.link(LK.LEECH, slot, x + (Math.random() - 0.5) * 0.6, z + (Math.random() - 0.5) * 0.6, x, z, 0.42 + Math.random() * 0.12, KEYSTONE_COLOR.sanguine, slot);
  }

  private shieldBurst(st: SlotState, slot: number, x: number, z: number, r: number): void {
    if (this.dup(st, 'ks_knight', x, z)) return;
    const vfx = this.vfx;
    const hex = PALETTE.shield;
    const d = r * 2;
    vfx.ring(x, z, 1.2, d * 1.03, 0.4, hex, 0.5, 2.1);
    vfx.groundFlash(x, z, d, 0.4, hex, 0.45);
    vfx.flash(x, 1.1, z, hex, r * 0.9, 0.2, 1);
    vfx.sparks(x, 1, z, PALETTE.holy, 10, 9);
    // the shield itself flies apart: plates thrown outwards in a ring
    const c = rgb(hex);
    const own = !this.foreign(slot);
    const plates = own ? 10 : CL.outlines ? 0 : 5;
    for (let i = 0; i < plates; i++) {
      const a = (i / plates) * Math.PI * 2 + 0.3;
      const sp = r / 0.34;
      vfx.particle(x + Math.sin(a) * 0.7, 1.1, z + Math.cos(a) * 0.7, Math.sin(a) * sp, 1.5, Math.cos(a) * sp, 0.42, 0.7, 0.35,
        c[0] * 1.5 + 0.2, c[1] * 1.5 + 0.2, c[2] * 1.5 + 0.2, 1, SPRITE.SHARD, 0.55, 6, 1.6, 7, 0.9, a);
    }
    if (own) this.trauma += 0.18;
  }

  private vortex(st: SlotState, x: number, z: number, r: number, dur: number, follow: boolean, delay: number): void {
    st.vortexLeft = dur; st.vortexTotal = dur; st.vortexX = x; st.vortexZ = z; st.vortexR = r; st.vortexFollow = follow; st.vortexDelay = delay;
  }

  /** Fan the Hammer: the fifth bolt takes a full fan of knives with it. */
  private fan(st: SlotState, slot: number, hero: HeroView | null): void {
    st.shots = 0;
    if (!hero || this.time - st.fanAt < 0.2) return;
    st.fanAt = this.time;
    const vfx = this.vfx;
    const hex = this.elementHex(slot, 'primary', KEYSTONE_COLOR.ks_rogue);
    const x = hero.x + hero.offX;
    const z = hero.z + hero.offZ;
    const fan = CLASSES.rogue.secondary;
    const spread = (fan.arc * Math.PI) / 180;
    for (let i = 0; i < P.FAN_KNIVES; i++) {
      const a = hero.rot + (P.FAN_KNIVES > 1 ? (i / (P.FAN_KNIVES - 1) - 0.5) * spread : 0);
      vfx.streak(x + Math.sin(a) * 0.8, z + Math.cos(a) * 0.8, a, 4.6, 0.5, 0.3, hex);
    }
    vfx.slash(x, z, hero.rot, 3.2, spread * 1.5, 0.24, hex, 1, 0, -1, 1.7);
    vfx.flash(x + Math.sin(hero.rot) * 0.9, 1.2, z + Math.cos(hero.rot) * 0.9, hex, 2.4, 0.14, 1.6);
    vfx.sparks(x + Math.sin(hero.rot) * 0.9, 1.2, z + Math.cos(hero.rot) * 0.9, hex, 10, 9, hero.rot, spread);
  }

  /** Blade Tempest: a crescent of force leaves with every cut (three with the finisher). */
  private waves(slot: number, x: number, z: number, rot: number, count: number, delay: number, hex: number): void {
    const vfx = this.vfx;
    for (let i = 0; i < count; i++) {
      const a = rot + (count > 1 ? (i - (count - 1) / 2) * 0.32 : 0);
      vfx.streak(x + Math.sin(a) * 1.2, z + Math.cos(a) * 1.2, a, 5.2, count > 1 ? 1 : 1.5, 0.34, hex, delay);
      vfx.slash(x + Math.sin(a) * 1.4, z + Math.cos(a) * 1.4, a, 2.3, 1.9, 0.3, hex, i % 2 === 0 ? 1 : -1, delay, -1, count > 1 ? 1.1 : 1.6);
    }
    vfx.ring(x + Math.sin(rot) * 1.4, z + Math.cos(rot) * 1.4, 0.6, 2.6 + count * 0.5, 0.26, hex, 0.3, 1.6, delay);
    if (count > 1 && !this.foreign(slot)) this.trauma += 0.08;
  }

  private bloom(slot: number, x: number, z: number, r: number, chained: boolean, tx: number, tz: number): void {
    const vfx = this.vfx;
    // colour: the status the corpse carried (the last kill seen there), else the hero's element, else pale
    let hex = 0;
    let best = 2.2;
    for (const c of this.corpses) {
      if (this.time - c.at > 1.2 || c.hex === 0) continue;
      const d = Math.hypot(c.x - x, c.z - z);
      if (d < best) { best = d; hex = c.hex; }
    }
    if (hex === 0) hex = this.elementHex(slot, 'primary', KEYSTONE_COLOR.corpse_bloom);
    // clarity: only the first few blooms of a chain are drawn in full
    let recent = 0;
    for (const t of this.bloomTimes) if (this.time - t < TUNE.BLOOM_WINDOW) recent++;
    const cap = this.foreign(slot) ? TUNE.BLOOM_ALLY : TUNE.BLOOM_OWN;
    const d = r * 2;
    if (chained) this.link(LK.BLOOM, slot, x, z, tx, tz, 0.4, hex);
    if (recent >= cap) {
      vfx.ring(x, z, d * 0.3, d, 0.35, hex, 0.12, 1.3);
      return;
    }
    this.bloomTimes[this.bloomCursor] = this.time;
    this.bloomCursor = (this.bloomCursor + 1) % this.bloomTimes.length;
    vfx.ring(x, z, 0.6, d * 1.02, 0.42, hex, 0.45, 1.9);
    vfx.groundFlash(x, z, d, 0.45, hex, 0.6);
    vfx.flash(x, 0.8, z, hex, r * 1.1, 0.18, 1.2);
    // petals: six tongues thrown out along the floor
    const c = rgb(hex);
    const petals = this.foreign(slot) && CL.outlines ? 0 : 6;
    const turn = Math.random() * 6.28;
    for (let i = 0; i < petals; i++) {
      const a = turn + (i / petals) * Math.PI * 2;
      const sp = r / 0.3;
      vfx.particle(x, 0.5, z, Math.sin(a) * sp, 0.6, Math.cos(a) * sp, 0.36, 1.1, 0.4, c[0] * 1.6, c[1] * 1.6, c[2] * 1.6, 0.9, SPRITE.GLOW, 1, 0, 2.4, 0, 0.8);
    }
    vfx.motes(x, 0.3, z, hex, 6, r * 0.5, 2.2, 0.8);
  }

  // ------------------------------------------------------------------ frame

  /**
   * Before Heroes.update(): writes this frame's size, veil and keystone light into the hero views and tracks what is
   * read from hero state (dash trail, shield loss).
   */
  pre(dt: number, time: number, serverTick: number): void {
    this.time = time;
    this.tick = serverTick;
    for (let s = 0; s < this.slots.length; s++) {
      const st = this.slots[s];
      const h = this.heroes.get(s);
      if (!h) { st.seen = false; st.famInit = false; continue; }
      const alive = h.state === 'alive';
      const own = !this.foreign(s);
      // size (Colossus) eases in so taking the keystone is a visible growth
      const size = st.held.includes('colossus') ? P.COLOSSUS_SIZE : 1;
      st.size += (size - st.size) * Math.min(1, dt * 3);
      if (Math.abs(st.size - size) < 0.002) st.size = size;
      h.size = st.size;
      // veil
      st.veilLeft = Math.max(0, st.veilLeft - dt);
      st.veilK += ((st.veilLeft > 0 && alive ? 1 : 0) - st.veilK) * Math.min(1, dt * 10);
      h.veil = 1 - st.veilK * (1 - (own ? TUNE.VEIL_OWN : TUNE.VEIL_ALLY));
      // light on the body
      let rr = 0; let rg = 0; let rb = 0;
      let gr = 0; let gg = 0; let gb = 0;
      st.phaseLeft = Math.max(0, st.phaseLeft - dt);
      if (st.phaseLeft > 0) {
        const c = rgb(KEYSTONE_COLOR.phase_walker);
        const k = (own ? 2.6 : 1.1) * (0.75 + 0.25 * Math.sin(time * 14));
        rr += c[0] * k; rg += c[1] * k; rb += c[2] * k;
        gr += c[0] * 0.08; gg += c[1] * 0.08; gb += c[2] * 0.1;
      }
      if (st.veilK > 0.01) {
        const c = rgb(PALETTE.mark);
        const k = st.veilK * (own ? 2.2 : 1.4);
        rr += c[0] * k; rg += c[1] * k; rb += c[2] * k;
      }
      st.bloodPulse = Math.max(0, st.bloodPulse - dt * 2.4);
      if (st.bloodPulse > 0) {
        const c = rgb(TUNE.BLOOD);
        rr += c[0] * 2.4 * st.bloodPulse; rg += c[1] * 2.4 * st.bloodPulse; rb += c[2] * 2.4 * st.bloodPulse;
      }
      if (st.stacks > 0) {
        const c = rgb(KEYSTONE_COLOR.momentum_engine);
        const k = (st.stacks / P.RUSH_MAX) * (own ? 1.5 : 0.6);
        rr += c[0] * k; rg += c[1] * k; rb += c[2] * k;
      }
      if (st.held.includes('glass_cannon')) {
        const c = rgb(KEYSTONE_COLOR.glass_cannon);
        const k = own ? 0.9 : 0.4;
        rr += c[0] * k; rg += c[1] * k; rb += c[2] * k;
      }
      if (st.stream > 0.01) {
        const c = rgb(this.elementHex(s, 'primary', PALETTE.arcane));
        rr += c[0] * 1.6 * st.stream; rg += c[1] * 1.6 * st.stream; rb += c[2] * 1.6 * st.stream;
      }
      h.keyRim[0] = rr; h.keyRim[1] = rg; h.keyRim[2] = rb;
      h.keyGlow[0] = gr; h.keyGlow[1] = gg; h.keyGlow[2] = gb;

      // movement of the drawn hero (speed lines, the familiar)
      const x = h.x + h.offX;
      const z = h.z + h.offZ;
      if (!st.seen) { st.seen = true; st.px = x; st.pz = z; st.vx = 0; st.vz = 0; st.shield = h.shield; st.lastUlt = h.ult; }
      if (dt > 0) {
        const k = Math.min(1, dt * 12);
        st.vx += ((x - st.px) / dt - st.vx) * k;
        st.vz += ((z - st.pz) / dt - st.vz) * k;
      }
      st.px = x; st.pz = z;

      // Arc Stream: the snapshot says when the mage is channelling
      const channel = alive && st.held.includes('ks_mage') && (h.flags & PF.CHANNELING) !== 0;
      st.streamHold = channel ? TUNE.STREAM_HOLD : Math.max(0, st.streamHold - dt);
      st.stream += ((st.streamHold > 0 ? 1 : 0) - st.stream) * Math.min(1, dt * 16);

      // Twin Cast: an echo nobody announced is replayed by the view
      if (st.echoAt >= 0 && time >= st.echoAt + TUNE.ECHO_LATE && this.replaySlot < 0) {
        st.echoAt = -1;
        this.replaySlot = s;
      }
    }
  }

  update(dt: number, time: number, decals: DecalBatch, fx: BillboardBatch, ui: BillboardBatch): void {
    this.time = time;
    const vfx = this.vfx;
    for (let s = 0; s < this.slots.length; s++) {
      const st = this.slots[s];
      const h = this.heroes.get(s);
      if (!h) continue;
      if (st.held.length === 0 && st.pillarAge < 0) continue;
      vfx.owner(this.foreign(s) ? OWNER.ALLY : OWNER.SELF);
      this.drawHero(st, s, h, dt, decals, fx, ui);
    }
    vfx.owner(OWNER.WORLD);
    this.drawWakes(dt, decals, fx);
    this.drawLinks(dt, decals, fx);
    this.drawGhosts(dt, fx);
  }

  private drawHero(st: SlotState, slot: number, h: HeroView, dt: number, decals: DecalBatch, fx: BillboardBatch, ui: BillboardBatch): void {
    const time = this.time;
    const vfx = this.vfx;
    const x = h.x + h.offX;
    const z = h.z + h.offZ;
    const alive = h.state === 'alive';
    const own = !this.foreign(slot);
    const lv = this.level(slot);
    const quiet = !own && CL.outlines;
    const ringD = HERO_VIS.RING_RADIUS * 2 * h.size;
    const tall = HERO_VIS.HEIGHT * (h.size - 1);

    // ---- the moment a keystone is taken: a pillar of light for a second
    if (st.pillarAge >= 0) {
      st.pillarAge += dt;
      const k = st.pillarAge / TUNE.PILLAR;
      if (k >= 1) st.pillarAge = -1;
      else {
        const c = rgb(st.pillarHex);
        const rise = Math.min(1, k * 5);
        const fade = k < 0.55 ? 1 : 1 - (k - 0.55) / 0.45;
        const a = (own ? 1 : quiet ? 0.3 : 0.5) * fade;
        const wide = (own ? 3.4 : 1.5) * (1.2 - 0.4 * k);
        fx.push(SPRITE.COLUMN, x, 0.05, z, wide, TUNE.PILLAR_HEIGHT * rise, c[0] * 1.5, c[1] * 1.5, c[2] * 1.5, a, 1, 1, 0, 0, TUNE.PILLAR_HEIGHT * rise * 0.5);
        if (own) fx.push(SPRITE.COLUMN, x, 0.05, z, wide * 0.4, TUNE.PILLAR_HEIGHT * rise * 1.1, 1.4, 1.4, 1.4, a * 0.8, 1, 1, 0, 0, TUNE.PILLAR_HEIGHT * rise * 0.55);
        decals.push(DECAL.RUNE, x, 0.048, z, time * 2.4, 3.2 + k * 1.2, 3.2 + k * 1.2, c[0] * 1.6, c[1] * 1.6, c[2] * 1.6, (own ? 0.9 : 0.4) * fade, 0.8, k);
      }
    }

    // ---- emblems: what this hero's build is, readable on anyone
    for (let i = 0; i < st.held.length; i++) {
      const id = st.held[i];
      st.takenAge[i] = Math.min(10, (st.takenAge[i] ?? 10) + dt);
      if (!alive) continue;
      const c = rgb(KEYSTONE_COLOR[id] ?? FALLBACK_COLOR);
      const side = i === 0 ? -1 : 1;
      const pop = 1 + Math.max(0, 1 - st.takenAge[i] / TUNE.BADGE_POP) * 0.9;
      const uv = this.atlas.emblems.get(id);
      const y = HERO_VIS.LABEL_Y + tall + h.lift;
      if (uv && h.root.visible) {
        const s = TUNE.BADGE * pop * (own ? 1 : 0.9);
        ui.push(SPRITE.GLOW, x, y, z, s * 1.4, s * 1.4, 0, 0, 0, 0.4, 0, 0.8, 0, side * TUNE.BADGE_X, TUNE.BADGE_Y);
        ui.push(SPRITE.ATLAS, x, y, z, s, s, Math.min(1.3, c[0] * 1.3 + 0.18), Math.min(1.3, c[1] * 1.3 + 0.18), Math.min(1.3, c[2] * 1.3 + 0.18), 1,
          0, 0, 0, side * TUNE.BADGE_X, TUNE.BADGE_Y, uv[0], uv[1], uv[2], uv[3]);
      }
      // and an arc of that colour on the hero's ring, left for the first keystone, right for the second
      decals.push(DECAL.PROGRESS, x, 0.049, z, h.rot + side * (Math.PI / 2) - TUNE.ARC_FRAC * Math.PI, ringD + TUNE.ARC_GROW, ringD + TUNE.ARC_GROW,
        c[0] * 1.5, c[1] * 1.5, c[2] * 1.5, own ? 0.95 : 0.6, 0.4, TUNE.ARC_FRAC);
    }
    if (!alive) return;

    for (const id of st.held) {
      switch (id) {
        case 'ember_wake': {
          // embers at the heels while running, so the dash's fire is promised before it is used
          if (own && h.speed > 2 && Math.random() < dt * 14 * vfx.density) {
            const c = rgb(this.elementHex(slot, 'dash', PALETTE.ember));
            vfx.particle(x + (Math.random() - 0.5) * 0.4, 0.15, z + (Math.random() - 0.5) * 0.4, 0, 1 + Math.random(), 0, 0.5, 0.12, 0.03,
              c[0] * 2.2, c[1] * 2.2, c[2] * 2.2, 1, SPRITE.SPARK, 1, -0.4, 0.5, 5);
          }
          break;
        }
        case 'phase_walker': {
          if (st.phaseLeft <= 0) break;
          // the empowered window: a ring that runs down, and a star at the weapon that is the promised crit
          const c = rgb(KEYSTONE_COLOR.phase_walker);
          const frac = st.phaseLeft / st.phaseTotal;
          decals.push(DECAL.PROGRESS, x, 0.05, z, h.rot, ringD + 0.95, ringD + 0.95, c[0] * 1.6, c[1] * 1.6, c[2] * 1.6, own ? 0.95 : 0.5, 0.6, frac);
          if (!quiet) fx.push(SPRITE.GLOW, x, h.lift + 1.15, z, 2.6, 3, c[0], c[1], c[2], 0.2 * lv, 1, 0);
          if (h.hand && h.root.visible) {
            const e = h.hand.matrixWorld.elements;
            const g = rgb(PALETTE.crit);
            const s = (own ? 0.7 : 0.4) * (0.8 + 0.3 * Math.sin(time * 16));
            fx.push(SPRITE.SPARK, e[12], e[13] + 0.15, e[14], s, s, g[0] * 2, g[1] * 2, g[2] * 2, 0.95, 1, 0, time * 5);
          }
          break;
        }
        case 'heavy_hitter':
        case 'chain_lightning':
        case 'ricochet': {
          // the weapon itself shows it: a heavy golden glow, crackling arcs, a second edge circling the hand
          if (!h.hand || !h.root.visible || quiet) break;
          const e = h.hand.matrixWorld.elements;
          if (id === 'heavy_hitter') {
            const c = rgb(KEYSTONE_COLOR.heavy_hitter);
            const beat = 0.75 + 0.25 * Math.sin(time * 3.2 + slot);
            fx.push(SPRITE.GLOW, e[12], e[13] + 0.25, e[14], 1.7, 1.7, c[0], c[1], c[2], 0.42 * beat * lv, 1, 0.3);
            decals.push(DECAL.DISC, e[12], 0.036, e[14], 0, 1.6, 1.6, c[0], c[1], c[2], 0.18 * lv, 1, 0);
          } else if (id === 'chain_lightning') {
            const c = rgb(this.elementHex(slot, 'primary', KEYSTONE_COLOR.chain_lightning));
            const step = Math.floor(time * 9 + slot * 3);
            if (hash1(step) < 0.55) {
              fx.push(SPRITE.ARC, e[12] + (hash1(step + 0.3) - 0.5) * 0.5, e[13] + 0.2, e[14], 0.5, 1.1, c[0] * 2 + 0.3, c[1] * 2 + 0.3, c[2] * 2 + 0.3, 0.9 * lv, 1, step * 1.7,
                (hash1(step + 0.7) - 0.5) * 2.4);
            }
            fx.push(SPRITE.GLOW, e[12], e[13] + 0.15, e[14], 0.9, 0.9, c[0], c[1], c[2], 0.3 * lv, 1, 0.4);
          } else {
            const c = rgb(this.elementHex(slot, 'primary', TUNE.STEEL));
            const a = time * 7 + slot;
            decals.push(DECAL.BLADE, e[12] + Math.sin(a) * 0.42, e[13] + 0.15, e[14] + Math.cos(a) * 0.42, a + Math.PI / 2, 0.24, 0.72,
              c[0] * 1.4, c[1] * 1.4, c[2] * 1.4, 0.9 * lv, 0.2, 1);
          }
          break;
        }
        case 'twin_cast': {
          // the twin: a faint second figure at the shoulder
          if (!own) break;
          const c = rgb(TUNE.GHOST);
          const gx = x - Math.cos(h.rot) * 0.55 - Math.sin(h.rot) * 0.35;
          const gz = z + Math.sin(h.rot) * 0.55 - Math.cos(h.rot) * 0.35;
          fx.push(SPRITE.FIGURE, gx, h.lift + 1.12 * h.size, gz, 1.15 * h.size, 2.25 * h.size, c[0], c[1], c[2], 0.2 + 0.05 * Math.sin(time * 2.2), 0.9, 0.7);
          break;
        }
        case 'blood_price': {
          // a slow drip while the price can be paid; brighter right after it was
          if (quiet) break;
          const c = rgb(TUNE.BLOOD);
          const beat = Math.max(0, Math.sin(time * 4.2 + slot)) ** 6;
          decals.push(DECAL.DISC, x, 0.033, z, 0, ringD + 1.1, ringD + 1.1, c[0], c[1], c[2], (0.1 + 0.14 * beat + 0.3 * st.bloodPulse) * lv, 0.6, 0.15);
          break;
        }
        case 'orbit_blades':
          this.drawBlades(slot, h, x, z, own, lv, decals, fx);
          break;
        case 'familiar':
          this.drawFamiliar(st, slot, h, x, z, dt, own, quiet, lv, decals, fx);
          break;
        case 'colossus': {
          // a heavier tread: the floor answers every stride
          const c = rgb(KEYSTONE_COLOR.colossus);
          decals.push(DECAL.RING, x, 0.044, z, h.rot, ringD + 0.7, ringD + 0.7, c[0] * 1.1, c[1] * 1.1, c[2] * 1.1, 0.5 * lv, 0, 0);
          if (h.speed < 1.5 || h.lift > 0.1) { st.stepAcc = 0.5; break; }
          st.stepAcc += (h.speed * dt) / TUNE.STEP_LENGTH;
          if (st.stepAcc < 1) break;
          st.stepAcc -= 1;
          vfx.puff(x, 0.2, z, TUNE.DUST, 4, 0.6, 0.34);
          vfx.ring(x, z, 0.8, 2.9, 0.3, KEYSTONE_COLOR.colossus, 0.22, 1.1);
          h.punch = 0.05;
          if (own) this.trauma += 0.035;
          break;
        }
        case 'resonance_engine': {
          // the ultimate's charge worn openly as an arc around the hero; each Resonance makes it jump
          const c = rgb(KEYSTONE_COLOR.resonance_engine);
          st.chargeFlash = Math.max(0, st.chargeFlash - dt * 2.2);
          const d = ringD + 1.5 + st.chargeFlash * 0.5;
          const f = st.chargeFlash;
          decals.push(DECAL.PROGRESS, x, 0.0495, z, h.rot + Math.PI, d, d, c[0] * (1.4 + f), c[1] * (1.4 + f), c[2] * (1.4 + f), (own ? 0.8 : 0.4) + 0.2 * f, 0.5 + 0.5 * f,
            Math.max(0.02, Math.min(1, h.ult)));
          if (f > 0 && !quiet) fx.push(SPRITE.GLOW, x, h.lift + 1.2, z, 2 + f * 2.4, 2 + f * 2.4, c[0], c[1], c[2], 0.5 * f * lv, 1, 0.2);
          break;
        }
        case 'glass_cannon': {
          // a cracked crystal plate under the hero and splinters turning around the body
          const c = rgb(KEYSTONE_COLOR.glass_cannon);
          const d = (ringD + 2.2);
          decals.push(DECAL.FRACTURE, x, 0.043, z, slot * 1.3, d, d, c[0] * 1.5, c[1] * 1.5, c[2] * 1.5, own ? 0.85 : quiet ? 0.3 : 0.5, 0.6, own ? 0.1 : 0, slot * 0.37);
          if (quiet) break;
          for (let n = 0; n < 3; n++) {
            const a = time * 1.3 + n * 2.094 + slot;
            const y = h.lift + 0.75 + 0.5 * n + 0.12 * Math.sin(time * 2 + n);
            fx.push(SPRITE.SHARD, x + Math.sin(a) * 0.78, y, z + Math.cos(a) * 0.78, 0.2, 0.42, c[0] * 1.5, c[1] * 1.5, c[2] * 1.6, 0.9 * lv, 0.5, 1, a * 0.6);
          }
          break;
        }
        case 'sanguine': {
          // overheal: the shield it becomes shimmers in the pact's colour
          if (h.shield <= 0) break;
          const c = rgb(KEYSTONE_COLOR.sanguine);
          const d = ringD + 0.85;
          decals.push(DECAL.PROGRESS, x, 0.051, z, -time * 2.1, d, d, c[0] * 1.6, c[1] * 1.6, c[2] * 1.6, own ? 0.9 : 0.45, 0.5, 0.3);
          decals.push(DECAL.PROGRESS, x, 0.051, z, -time * 2.1 + Math.PI, d, d, c[0] * 1.6, c[1] * 1.6, c[2] * 1.6, own ? 0.9 : 0.45, 0.5, 0.3);
          if (!quiet) fx.push(SPRITE.HOOP, x, h.lift + 1.15, z, 2.1, 2.7, c[0] * 1.3, c[1] * 1.3, c[2] * 1.3, (0.3 + 0.12 * Math.sin(time * 5)) * lv, 0.8, 0.035);
          break;
        }
        case 'momentum_engine':
          this.drawRush(st, slot, h, x, z, dt, own, quiet, ringD, decals, fx);
          break;
        case 'ks_barbarian':
          this.drawVortex(st, slot, x, z, dt, own, quiet, decals);
          break;
        case 'ks_mage':
          this.drawStream(st, slot, h, x, z, dt, own, quiet, decals, fx);
          break;
        case 'ks_rogue': {
          // the tell: after the fourth bolt the fan is loaded and hangs in front of the hero
          if (st.shots !== P.FAN_EVERY - 1) {
            if (!own || st.shots === 0) break;
            // pips: how many bolts until the fan
            const c = rgb(KEYSTONE_COLOR.ks_rogue);
            for (let n = 0; n < st.shots; n++) {
              const a = h.rot + Math.PI + (n - (P.FAN_EVERY - 2) / 2) * 0.32;
              decals.push(DECAL.DISC, x + Math.sin(a) * (ringD * 0.5 + 0.45), 0.05, z + Math.cos(a) * (ringD * 0.5 + 0.45), 0, 0.26, 0.26, c[0] * 1.5, c[1] * 1.5, c[2] * 1.5, 0.9, 0.6, 0.8);
            }
            break;
          }
          const c = rgb(this.elementHex(slot, 'primary', KEYSTONE_COLOR.ks_rogue));
          const fanDef = CLASSES.rogue.secondary;
          const spread = (fanDef.arc * Math.PI) / 180;
          const pulse = 0.7 + 0.3 * Math.sin(time * 14);
          for (let n = 0; n < P.FAN_KNIVES; n++) {
            const a = h.rot + (P.FAN_KNIVES > 1 ? (n / (P.FAN_KNIVES - 1) - 0.5) * spread : 0);
            const d = 1.55;
            decals.push(DECAL.BLADE, x + Math.sin(a) * d, 1.0, z + Math.cos(a) * d, a, 0.2, 0.8, c[0] * 1.5, c[1] * 1.5, c[2] * 1.5, (own ? 0.95 : 0.5) * pulse, 0.3, 1);
            if (own) decals.push(DECAL.THREAD, x + Math.sin(a) * 3.1, 0.05, z + Math.cos(a) * 3.1, a, 0.16, 2.2, c[0] * 1.4, c[1] * 1.4, c[2] * 1.4, 0.4 * pulse, 0.8, 5, -1);
          }
          break;
        }
        case 'ks_shade': {
          if (st.veilK <= 0.02) break;
          // veiled: a shimmer for the owner, a faint outline for everyone else
          const c = rgb(PALETTE.mark);
          const squash = 0.62;
          if (own) {
            decals.push(DECAL.PROGRESS, x, 0.05, z, h.rot, ringD + 0.95, ringD + 0.95, c[0] * 1.5, c[1] * 1.5, c[2] * 1.5, 0.9 * st.veilK, 0.5, st.veilLeft / st.veilTotal);
            if (Math.random() < dt * 9 * vfx.density) vfx.smoke(x, 0.3 + Math.random() * 1.2, z, PALETTE.shadow, 1, 0.5, 0.3, 0.6, 0.9);
            fx.push(SPRITE.GLOW, x, h.lift + 1.1, z, 2.2, 2.8, c[0] * 0.5, c[1] * 0.5, c[2] * 0.6, 0.22 * st.veilK, 1, 0);
          } else {
            fx.push(SPRITE.FIGURE, x, h.lift + 1.12, z, 1.1, 2.25, c[0], c[1], c[2], 0.16 * st.veilK, 0.8, 1);
            fx.push(SPRITE.HOOP, x, 0.06, z, ringD * 1.25, ringD * 1.25 * squash, c[0], c[1], c[2], 0.5 * st.veilK, 0.5, 0.03);
          }
          break;
        }
        default:
          break;
      }
    }
  }

  private drawBlades(slot: number, h: HeroView, x: number, z: number, own: boolean, lv: number, decals: DecalBatch, fx: BillboardBatch): void {
    const c = rgb(this.elementHex(slot, 'primary', TUNE.STEEL));
    const turn = (P.BLADE_RPM / 60) * Math.PI * 2;
    // the simulation's tick drives the angle when there is one, so the blades are where they cut
    const base = (this.tick > 0 ? this.tick * TICK_DT : this.time) * turn;
    const r = P.BLADE_RADIUS * this.areaMul(slot);
    const y = TUNE.BLADE_Y + h.lift;
    const a0 = own ? 1 : lv;
    if (own) decals.push(DECAL.SHOCK, x, 0.042, z, 0, r * 2 + 0.3, r * 2 + 0.3, c[0], c[1], c[2], 0.16, 1, 0.06);
    for (let i = 0; i < P.BLADES; i++) {
      const a = base + (i / P.BLADES) * Math.PI * 2;
      const bx = x + Math.sin(a) * r;
      const bz = z + Math.cos(a) * r;
      // the blade points along its path; a short arc of light trails it
      const along = a + Math.PI / 2;
      decals.push(DECAL.SHADOW, bx, 0.021, bz, along, 0.5, 1.3, 0, 0, 0, 0.3 * a0);
      if (own) {
        for (let k = 1; k <= 3; k++) {
          const ta = a - k * 0.16;
          decals.push(DECAL.STREAK, x + Math.sin(ta) * r, y - 0.02, z + Math.cos(ta) * r, ta + Math.PI / 2, 0.42 - k * 0.07, 0.95, c[0] * 1.5, c[1] * 1.5, c[2] * 1.5, 0.5 - k * 0.13, 1);
        }
        fx.push(SPRITE.GLOW, bx, y, bz, 0.9, 0.9, c[0], c[1], c[2], 0.3, 1, 0.3);
      }
      decals.push(DECAL.BLADE, bx, y, bz, along, TUNE.BLADE_W, TUNE.BLADE_LEN, c[0] * 1.5, c[1] * 1.5, c[2] * 1.5, own ? 1 : 0.5 + 0.4 * lv, 0.15, 1);
    }
  }

  private drawFamiliar(
    st: SlotState, slot: number, h: HeroView, x: number, z: number, dt: number, own: boolean, quiet: boolean, lv: number, decals: DecalBatch, fx: BillboardBatch,
  ): void {
    const F = TUNE.FAMILIAR;
    const time = this.time;
    // behind the left shoulder, drifting after the hero
    const wantX = x - Math.sin(h.rot) * F.BACK - Math.cos(h.rot) * F.SIDE;
    const wantZ = z - Math.cos(h.rot) * F.BACK + Math.sin(h.rot) * F.SIDE;
    if (!st.famInit) { st.famInit = true; st.famX = wantX; st.famZ = wantZ; }
    const k = 1 - Math.exp(-F.FOLLOW * dt);
    st.famX += (wantX - st.famX) * k;
    st.famZ += (wantZ - st.famZ) * k;
    st.famFlash = Math.max(0, st.famFlash - dt * 5);
    const c = rgb(this.elementHex(slot, 'primary', PALETTE.glimmer));
    const y = F.Y + h.lift * 0.5 + Math.sin(time * 2.6 + slot) * F.BOB;
    const s = F.SIZE * (1 + st.famFlash * 0.8);
    const fx0 = st.famX;
    const fz0 = st.famZ;
    if (!quiet) {
      decals.push(DECAL.DISC, fx0, 0.034, fz0, 0, 1.5, 1.5, c[0], c[1], c[2], 0.22 * lv, 1, 0);
      fx.push(SPRITE.GLOW, fx0, y, fz0, s * 2.6, s * 2.6, c[0], c[1], c[2], (0.3 + 0.4 * st.famFlash) * lv, 1, 0);
      // two motes circling it, and a tail when it moves
      for (let n = 0; n < 2; n++) {
        const a = time * 4.2 + n * Math.PI;
        fx.push(SPRITE.SPARK, fx0 + Math.sin(a) * 0.36, y + Math.cos(a * 0.7) * 0.2, fz0 + Math.cos(a) * 0.36, 0.13, 0.13, c[0] * 2, c[1] * 2, c[2] * 2, 0.9 * lv, 1, 0, a);
      }
      if (own && Math.random() < dt * 10 * this.vfx.density) {
        this.vfx.particle(fx0, y - 0.1, fz0, 0, -0.5, 0, 0.5, 0.2, 0.03, c[0] * 1.8, c[1] * 1.8, c[2] * 1.8, 0.8, SPRITE.GLOW, 1, 0, 0, 0, 1);
      }
    }
    // the wisp itself: a hard bright core everyone sees, on a breath of shade so it also reads over lit floor
    fx.push(SPRITE.GLOW, fx0, y, fz0, s * 2.1, s * 2.1, 0, 0.02, 0.02, 0.5, 0, 0.6);
    fx.push(SPRITE.HOOP, fx0, y, fz0, s * 1.9, s * 1.9, c[0] * 1.4, c[1] * 1.4, c[2] * 1.4, own ? 0.8 : 0.45, 0.6, 0.05);
    fx.push(SPRITE.GLOW, fx0, y, fz0, s, s, c[0] * 1.6 + 0.3, c[1] * 1.6 + 0.3, c[2] * 1.6 + 0.3, own ? 1 : 0.75, 1, 1.6);
    fx.push(SPRITE.SHARD, fx0, y - s * 0.75, fz0, s * 0.42, s * 0.8, c[0] * 1.3, c[1] * 1.3, c[2] * 1.3, own ? 0.85 : 0.5, 0.7, 1, Math.PI);
  }

  private drawRush(
    st: SlotState, slot: number, h: HeroView, x: number, z: number, dt: number, own: boolean, quiet: boolean, ringD: number, decals: DecalBatch, fx: BillboardBatch,
  ): void {
    if (st.stacks <= 0) return;
    st.stackLeft -= dt;
    if (st.stackLeft <= 0) { st.stacks = 0; st.stacksFromProc = false; return; }
    const c = rgb(KEYSTONE_COLOR.momentum_engine);
    const k = st.stacks / P.RUSH_MAX;
    // the stacks as a notched arc that runs down with the timer
    const d = ringD + 1.1;
    const blink = st.stackLeft < 1.2 ? 0.55 + 0.45 * Math.sin(this.time * 16) : 1;
    decals.push(DECAL.PROGRESS, x, 0.0485, z, h.rot, d, d, c[0] * 1.6, c[1] * 1.6, c[2] * 1.6, (own ? 0.95 : 0.45) * blink, 0.5, k);
    // speed: streaks behind the hero, longer and more of them with every stack, and after-images from half way up
    const sp = Math.hypot(st.vx, st.vz);
    if (sp < 1.5) return;
    const back = Math.atan2(-st.vx, -st.vz);
    const lines = quiet ? 1 : Math.max(1, Math.round(TUNE.RUSH_LINES * k));
    const len = 1.2 + 3.2 * k;
    for (let n = 0; n < lines; n++) {
      const off = lines > 1 ? (n / (lines - 1) - 0.5) * 1.3 : 0;
      const jitter = hash1(Math.floor(this.time * 20) + n * 7 + slot) * 0.5;
      const lx = x + Math.cos(back) * off + Math.sin(back) * (0.5 + jitter);
      const lz = z - Math.sin(back) * off + Math.cos(back) * (0.5 + jitter);
      decals.push(DECAL.STREAK, lx + Math.sin(back) * len * 0.5, 0.35 + (n % 3) * 0.5, lz + Math.cos(back) * len * 0.5, back + Math.PI, 0.16 + 0.1 * k, len,
        c[0] * 1.6, c[1] * 1.6, c[2] * 1.6, (own ? 0.75 : 0.35) * (0.5 + 0.5 * k), 1);
    }
    if (k < 0.4 || quiet) return;
    st.ghostAcc += dt * sp;
    if (st.ghostAcc >= 1.5) {
      st.ghostAcc = 0;
      this.ghost(slot, x, z, 0.3, KEYSTONE_COLOR.momentum_engine, (own ? 0.5 : 0.25) * k, h.size, 0.2);
    }
    void fx;
  }

  private drawVortex(st: SlotState, slot: number, x: number, z: number, dt: number, own: boolean, quiet: boolean, decals: DecalBatch): void {
    if (st.maelLeft > 0) {
      st.maelLeft -= dt;
      this.drawSpiral(slot, st.maelX, st.maelZ, st.maelR, Math.min(1, (st.maelTotal - st.maelLeft) * 6, st.maelLeft * 3), dt, own, quiet, decals);
    }
    if (st.vortexLeft <= 0) return;
    if (st.vortexDelay > 0) { st.vortexDelay -= dt; return; }
    st.vortexLeft -= dt;
    this.drawSpiral(slot, st.vortexFollow ? x : st.vortexX, st.vortexFollow ? z : st.vortexZ, st.vortexR, Math.min(1, (st.vortexTotal - st.vortexLeft) * 6, st.vortexLeft * 3),
      dt, own, quiet, decals);
  }

  private drawSpiral(slot: number, vx: number, vz: number, radius: number, k: number, dt: number, own: boolean, quiet: boolean, decals: DecalBatch): void {
    const c = rgb(this.elementHex(slot, 'secondary', KEYSTONE_COLOR.ks_barbarian));
    const d = radius * 2 * 1.08;
    // the drag: arms turning inwards, dust and sparks pulled to the middle
    decals.push(DECAL.VORTEX, vx, 0.046, vz, 0, d, d, c[0] * 1.5, c[1] * 1.5, c[2] * 1.5, (own ? 0.6 : quiet ? 0.3 : 0.4) * k, quiet ? 0.3 : 0.8, own ? 0.35 : 0.1, 7);
    if (quiet) return;
    const vfx = this.vfx;
    if (Math.random() < dt * 40 * vfx.density) {
      const a = Math.random() * Math.PI * 2;
      const r = radius * (0.9 + Math.random() * 0.3);
      const t = 0.32;
      vfx.particle(vx + Math.sin(a) * r, 0.3 + Math.random() * 0.8, vz + Math.cos(a) * r, (-Math.sin(a) * r) / t + Math.cos(a) * 4, 0.4, (-Math.cos(a) * r) / t - Math.sin(a) * 4,
        t, 0.2, 0.05, c[0] * 2, c[1] * 2, c[2] * 2, 0.95, SPRITE.SPARK, 1, 0, 0, 6);
    }
    if (Math.random() < dt * 12 * vfx.density) vfx.puff(vx + (Math.random() - 0.5) * radius * 1.6, 0.25, vz + (Math.random() - 0.5) * radius * 1.6, TUNE.DUST, 1, 0.3, 0.3);
  }

  private drawStream(
    st: SlotState, slot: number, h: HeroView, x: number, z: number, dt: number, own: boolean, quiet: boolean, decals: DecalBatch, fx: BillboardBatch,
  ): void {
    if (st.stream <= 0.02) return;
    const k = st.stream;
    const sin = Math.sin(h.rot);
    const cos = Math.cos(h.rot);
    const mx = x + sin * TUNE.STREAM_MUZZLE;
    const mz = z + cos * TUNE.STREAM_MUZZLE;
    // the stream ends at the chamber wall
    let len = P.STREAM_RANGE;
    if (this.halfW > 0) {
      if (sin > 1e-4) len = Math.min(len, (this.halfW - mx) / sin);
      else if (sin < -1e-4) len = Math.min(len, (-this.halfW - mx) / sin);
      if (cos > 1e-4) len = Math.min(len, (this.halfD - mz) / cos);
      else if (cos < -1e-4) len = Math.min(len, (-this.halfD - mz) / cos);
      len = Math.max(1, len);
    }
    const cx = mx + sin * len * 0.5;
    const cz = mz + cos * len * 0.5;
    const hex = this.elementHex(slot, 'primary', PALETTE.arcane);
    const c = rgb(hex);
    const y = TUNE.STREAM_Y + h.lift;
    const w = P.STREAM_WIDTH * this.heavyWide(slot);
    const flick = 0.85 + 0.15 * Math.sin(this.time * 38);
    if (!own) {
      // another mage's stream: the line of it, no light
      decals.push(DECAL.BEAM, cx, y, cz, h.rot, w * 1.3, len, c[0] * 1.4, c[1] * 1.4, c[2] * 1.4, (quiet ? 0.4 : 0.6) * k, 1, quiet ? 0.2 : 0.6);
      return;
    }
    decals.push(DECAL.STREAK, cx, 0.045, cz, h.rot + Math.PI, w * 4.5, len, c[0], c[1], c[2], 0.3 * k, 1);
    decals.push(DECAL.BEAM, cx, y, cz, h.rot, w * 3.4 * flick, len, c[0] * 1.6, c[1] * 1.6, c[2] * 1.6, 0.75 * k, 1, 0.4);
    decals.push(DECAL.BEAM, cx, y + 0.02, cz, h.rot, w * 1.3, len, c[0] * 0.8 + 1, c[1] * 0.8 + 1, c[2] * 0.8 + 1, 0.95 * k, 1, 1);
    fx.push(SPRITE.GLOW, mx, y, mz, 1.7 * flick, 1.7 * flick, c[0] * 1.5, c[1] * 1.5, c[2] * 1.5, 0.7 * k, 1, 0.8);
    fx.push(SPRITE.GLOW, mx + sin * len, y, mz + cos * len, 1.5, 1.5, c[0] * 1.4, c[1] * 1.4, c[2] * 1.4, 0.6 * k * flick, 1, 0.5);
    const vfx = this.vfx;
    if (Math.random() < dt * 34 * vfx.density) {
      const d = Math.random() * len;
      const side = (Math.random() - 0.5) * w;
      vfx.particle(mx + sin * d + cos * side, y + (Math.random() - 0.5) * 0.3, mz + cos * d - sin * side, sin * 5 + cos * side * 6, 0.6 + Math.random(), cos * 5 - sin * side * 6,
        0.3, 0.16, 0.03, c[0] * 2, c[1] * 2, c[2] * 2, 0.95, SPRITE.SPARK, 1, 0, 1, 6);
    }
    if (Math.random() < dt * 9 * vfx.density) vfx.arcs(mx + sin * Math.random() * len, y, mz + cos * Math.random() * len, hex, 1, 0.9);
  }

  private drawWakes(dt: number, decals: DecalBatch, fx: BillboardBatch): void {
    for (const w of this.wakes) {
      if (!w.active) continue;
      w.age += dt;
      if (w.age >= w.dur) { w.active = false; continue; }
      const k = w.age / w.dur;
      const c = rgb(w.hex);
      const fadeIn = Math.min(1, w.age * TUNE.WAKE_FADE_IN);
      const out = k > 0.8 ? 1 - (k - 0.8) / 0.2 : 1;
      const own = !this.foreign(w.slot);
      const quiet = !own && CL.outlines;
      const width = w.width;
      if (quiet) {
        // another hero's trail: where it burns, as an outline
        decals.push(DECAL.WAKE, w.x, 0.047, w.z, w.rot, width, w.len, c[0] * 1.4, c[1] * 1.4, c[2] * 1.4, 0.6 * fadeIn * out, 0.6, k * 0.5, w.seed, 1);
        continue;
      }
      const lv = own ? 1 : TUNE.ALLY_FULL;
      // scorched floor, the burning lane, and tongues of flame standing in it
      decals.push(DECAL.STREAK, w.x, 0.04, w.z, w.rot, width * 1.25, w.len * 1.1, 0.02, 0.01, 0.01, 0.4 * fadeIn * out * lv, 0);
      decals.push(DECAL.WAKE, w.x, 0.046, w.z, w.rot, width * 1.15, w.len, c[0] * 1.7, c[1] * 1.7, c[2] * 1.7, 0.9 * fadeIn * out * lv, 1, k, w.seed, 0);
      const sin = Math.sin(w.rot);
      const cos = Math.cos(w.rot);
      const flames = Math.max(1, Math.round(w.len * TUNE.WAKE_FLAMES * (own ? 1 : 0.5)));
      for (let n = 0; n < flames; n++) {
        const seed = w.seed * 31 + n * 1.7;
        const along = (hash1(seed) - 0.5) * w.len * 0.9;
        const side = (hash1(seed + 5) - 0.5) * width * 0.6;
        const flick = 0.7 + 0.5 * hash1(Math.floor(this.time * 9 + seed * 3));
        const hgt = (0.55 + 0.6 * hash1(seed + 9)) * flick * (1 - k * 0.6) * out;
        fx.push(SPRITE.FLAME, w.x + sin * along + cos * side, 0.1 + hgt * 0.5, w.z + cos * along - sin * side, hgt * 0.62, hgt, c[0] * 1.9, c[1] * 1.9, c[2] * 1.9, 0.9 * fadeIn * lv, 0.85, seed);
      }
      w.acc += dt * 3 * this.vfx.density * (own ? 1 : 0.4);
      if (w.acc >= 1) {
        w.acc -= 1;
        const along = (Math.random() - 0.5) * w.len;
        this.vfx.particle(w.x + sin * along, 0.3, w.z + cos * along, (Math.random() - 0.5) * 0.6, 1.4 + Math.random(), (Math.random() - 0.5) * 0.6, 0.6, 0.12, 0.03,
          c[0] * 2.2, c[1] * 2.2, c[2] * 2.2, 1, SPRITE.SPARK, 1, -0.4, 0.5, 5);
      }
    }
  }

  private drawLinks(dt: number, decals: DecalBatch, fx: BillboardBatch): void {
    for (const l of this.links) {
      if (!l.active) continue;
      l.age += dt;
      if (l.age >= l.dur) { l.active = false; continue; }
      const k = l.age / l.dur;
      const own = !this.foreign(l.slot);
      const quiet = !own && CL.outlines;
      const lv = own ? 1 : quiet ? TUNE.ALLY_QUIET : TUNE.ALLY_FULL;
      const c = rgb(l.hex);
      if (l.follow >= 0) {
        // ends at the hero, wherever it has moved to
        const h = this.heroes.get(l.follow);
        if (h) { l.x1 = h.x + h.offX; l.z1 = h.z + h.offZ; }
      }
      const dx = l.x1 - l.x0;
      const dz = l.z1 - l.z0;
      const len = Math.hypot(dx, dz);
      if (len < 0.05) continue;
      const rot = Math.atan2(dx, dz);
      const mx = (l.x0 + l.x1) / 2;
      const mz = (l.z0 + l.z1) / 2;
      switch (l.kind) {
        case LK.BOLT: {
          // re-struck a few times while it lasts
          const seed = l.seed + Math.floor(l.age * 22) * 7.3;
          const fade = 1 - k * k;
          decals.push(DECAL.BOLT, mx, 1.15, mz, rot, quiet ? 0.7 : 1.3, len, c[0] * 1.8 + 0.2, c[1] * 1.8 + 0.2, c[2] * 1.8 + 0.2, fade * (own ? 1 : quiet ? 0.5 : 0.7), 1, seed);
          if (!quiet) decals.push(DECAL.STREAK, mx, 0.045, mz, rot, 0.9, len, c[0], c[1], c[2], 0.3 * fade * lv, 1);
          break;
        }
        case LK.BOUNCE: {
          // a blade spinning along the line, the line staying a moment as the path it took
          const fly = Math.min(1, l.age / (l.dur * 0.45));
          const fade = k < 0.45 ? 1 : 1 - (k - 0.45) / 0.55;
          decals.push(DECAL.THREAD, mx, 1.0, mz, rot, quiet ? 0.22 : 0.5, len, c[0] * 1.6, c[1] * 1.6, c[2] * 1.6, fade * (own ? 0.95 : 0.5), 0.8, 0, -1);
          if (fly < 1) {
            const bx = l.x0 + dx * fly;
            const bz = l.z0 + dz * fly;
            decals.push(DECAL.BLADE, bx, 1.05, bz, this.time * 30 + l.seed, 0.42, 1.25, c[0] * 1.5, c[1] * 1.5, c[2] * 1.5, own ? 1 : 0.7, 0.2, 1);
            if (!quiet) fx.push(SPRITE.GLOW, bx, 1.05, bz, 1.1, 1.1, c[0], c[1], c[2], 0.35 * lv, 1, 0.3);
          } else if (!l.done) {
            l.done = true;
            this.vfx.owner(own ? OWNER.SELF : OWNER.ALLY);
            this.vfx.sparks(l.x1, 1.1, l.z1, l.hex, 6, 7);
            this.vfx.ring(l.x1, l.z1, 0.4, 1.8, 0.2, l.hex, 0.3, 1.5);
            this.vfx.owner(OWNER.WORLD);
          }
          break;
        }
        case LK.LEECH:
        case LK.CHARGE: {
          // a bead of light running into the hero
          const e = k * k;
          const bx = l.x0 + dx * e;
          const bz = l.z0 + dz * e;
          const y = l.kind === LK.CHARGE ? 1.2 : 0.9 + Math.sin(k * Math.PI) * 0.7;
          const big = l.kind === LK.CHARGE;
          if (big) decals.push(DECAL.THREAD, mx, 0.06, mz, rot, 0.9, len, c[0] * 1.6, c[1] * 1.6, c[2] * 1.6, (1 - k) * (own ? 0.9 : 0.45), 1, 7, e);
          if (!big && own) decals.push(DECAL.THREAD, mx, 0.055, mz, rot, 0.22, len, c[0] * 1.4, c[1] * 1.4, c[2] * 1.4, 0.5 * (1 - k), 0.6, 0, -1);
          fx.push(SPRITE.GLOW, bx, y, bz, big ? 1.1 : 0.62, big ? 1.1 : 0.62, c[0] * 1.6 + (big ? 0.3 : 0), c[1] * 1.6 + (big ? 0.3 : 0), c[2] * 1.6 + (big ? 0.3 : 0),
            (own ? 0.95 : 0.5), big ? 1 : 0.7, 1.2);
          if (!quiet) fx.push(SPRITE.GLOW, bx - (dx / len) * 0.35, y, bz - (dz / len) * 0.35, big ? 0.7 : 0.3, big ? 0.7 : 0.3, c[0], c[1], c[2], 0.5 * lv, big ? 1 : 0.7, 0.4);
          if (k > 0.86 && !l.done) {
            l.done = true;
            this.arrive(l, big);
          }
          break;
        }
        case LK.BLOOM: {
          const fade = 1 - k;
          decals.push(DECAL.THREAD, mx, 0.055, mz, rot, quiet ? 0.25 : 0.5, len, c[0] * 1.6, c[1] * 1.6, c[2] * 1.6, fade * (own ? 0.9 : 0.4), 1, 6, Math.min(1, k * 2.2));
          break;
        }
        default: {
          // the familiar's shot: a quick straight bolt
          const fade = 1 - k;
          decals.push(DECAL.THREAD, mx, 1.3, mz, rot, quiet ? 0.2 : 0.36, len, c[0] * 1.7 + 0.2, c[1] * 1.7 + 0.2, c[2] * 1.7 + 0.2, fade * (own ? 1 : 0.5), 1, 0, Math.min(1, k * 2.5));
          break;
        }
      }
    }
  }

  /** A leech mote or a charge reaches its hero. */
  private arrive(l: Link, charge: boolean): void {
    const st = this.slots[l.follow];
    const vfx = this.vfx;
    vfx.owner(this.foreign(l.slot) ? OWNER.ALLY : OWNER.SELF);
    if (charge) {
      if (st) st.chargeFlash = 1;
      vfx.ring(l.x1, l.z1, 0.8, 4, 0.35, l.hex, 0.35, 1.8);
      vfx.flash(l.x1, 1.3, l.z1, l.hex, 2.6, 0.22, 1.5);
      vfx.motes(l.x1, 0.3, l.z1, l.hex, 8, 0.7, 3.4, 0.8);
    } else {
      vfx.particle(l.x1, 1.1, l.z1, 0, 0.6, 0, 0.22, 0.5, 0.9, 0.9, 0.2, 0.4, 0.5 * (this.foreign(l.slot) ? 0.4 : 1), SPRITE.GLOW, 0.7, 0, 0, 0, 0.3);
    }
    vfx.owner(OWNER.WORLD);
  }

  private drawGhosts(dt: number, fx: BillboardBatch): void {
    for (const g of this.ghosts) {
      if (!g.active) continue;
      g.age += dt;
      if (g.age >= g.dur) { g.active = false; continue; }
      const k = g.age / g.dur;
      const c = rgb(g.hex);
      const a = g.alpha * Math.min(1, g.age * 14) * (1 - k * k);
      const h = HERO_VIS.HEIGHT * g.size;
      fx.push(SPRITE.GLOW, g.x, h * 0.5, g.z, 1.5 * g.size, h * 1.1, c[0], c[1], c[2], a * 0.22, 1, 0);
      fx.push(SPRITE.FIGURE, g.x, h * 0.5, g.z, 1.3 * g.size, h, c[0] * 1.4, c[1] * 1.4, c[2] * 1.4, a, 0.7, g.scan);
    }
  }

  /** New chamber: everything that lies in the world goes; what a hero carries stays. */
  clear(): void {
    for (const w of this.wakes) w.active = false;
    for (const l of this.links) l.active = false;
    for (const g of this.ghosts) g.active = false;
    for (const c of this.corpses) c.at = -100;
    for (const st of this.slots) {
      st.maelLeft = 0; st.seen = false; st.famInit = false; st.vortexLeft = 0; st.echoAt = -1; st.veilLeft = 0; st.phaseLeft = 0; st.stream = 0; st.streamHold = 0;
      st.lastT.fill(-100);
    }
    this.replaySlot = -1;
    this.trauma = 0;
  }

  /** Session over. */
  reset(): void {
    this.clear();
    // what a hero holds stays with the roster (setRoster); only what it built up during the session goes
    for (const st of this.slots) {
      st.stacks = 0; st.stackLeft = 0; st.stacksFromProc = false; st.shots = 0; st.size = 1; st.pillarAge = -1; st.bloodPulse = 0; st.chargeFlash = 0; st.veilK = 0;
    }
  }
}
