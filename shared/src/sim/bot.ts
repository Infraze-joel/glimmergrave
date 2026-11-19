/**
 * Scripted bot that plays from the same information a client has: decoded snapshots, the run state and the
 * `telegraph` events. Used by tests, balance soaks and the WebSocket bot client.
 */
import { TICK_DT, WORLD } from '../constants.ts';
import { BOON_BY_ID } from '../data/boons.ts';
import { CLASSES, secondaryOf, type AbilityDef } from '../data/classes.ts';
import { ENEMIES, ENEMY_TUNING } from '../data/enemies.ts';
import { KEYSTONE_BY_ID, KEYSTONE_TUNING } from '../data/keystones.ts';
import {
  BTN, EF, PF,
  type BoonOffer, type BoonStack, type ClassId, type ElementId, type EnemySnap, type GameEvent, type Hazard, type InputCmd,
  type PlayerSnap, type ProjectileSnap, type RoomLayout, type RunState, type TutorialState,
} from '../types.ts';
import { blocksShots } from './fixtures.ts';
import { angleDiff, inArc, inLine, sweepHit } from './geom.ts';
import { HAZARD_TIMING, hazardState, type HazardState } from './hazards.ts';
import { Rng } from './rng.ts';
import type { World } from './world.ts';

export interface BotView {
  tick: number;
  slot: number;
  cls: ClassId;
  players: PlayerSnap[];
  enemies: EnemySnap[];
  projectiles: ProjectileSnap[];
  run: RunState;
  /** Secondary variant the hero has equipped (RosterEntry.art); 0 / missing = the standard one. */
  art?: number;
  /** Keystones the hero holds (RosterEntry.keystones); missing = none. */
  keystones?: readonly string[];
}

export interface BotOptions {
  /** Seconds before the bot reacts to a new telegraph. */
  reaction?: number;
  /** Chance (0..1) to overlook a telegraph. */
  missChance?: number;
  /** After a final boss: take the `descend` door while the depth is below this (default 0 = always ascend). */
  descendTo?: number;
  /**
   * Door choice: prefer a door with a special objective over the usual boon / blessing preference, even behind a
   * cursed door if that is the only one (tests, soaks).
   */
  preferObjectives?: boolean;
  /** Door choice: take a cursed door whenever one is offered (soaks that measure cursed chambers). */
  preferCursed?: boolean;
  /** Keystone drafts: take these ids whenever they are offered (tests, balance soaks); otherwise the usual choice. */
  keystones?: readonly string[];
  /** Keystone drafts: `only` = take nothing but the ids in `keystones` (else the consolation); `none` = always the consolation. */
  keystoneMode?: 'free' | 'only' | 'none';
}

const BOT = {
  REACTION_SECONDS: 0.25,
  /** Chance to overlook a telegraph entirely (bots are competent, not perfect). */
  MISS_CHANCE: 0.1,
  TELEGRAPH_MARGIN: 0.55,
  /** Assumed walking speed when judging whether a telegraph can be left on foot. */
  WALK_SPEED: 5,
  CHARGE_LINE_MIN_WIDTH: 1.5,
  CHARGE_LINGER_SECONDS: 0.7,
  PROJECTILE_SCAN_RADIUS: 7,
  PROJECTILE_HORIZON_SECONDS: 0.9,
  PROJECTILE_MISS_DISTANCE: 1.05,
  RANGED_MIN: 6.5,
  RANGED_MAX: 10.5,
  WALL_MARGIN: 3,
  REVIVE_STAND_DISTANCE: 0.9,
  LOW_PARTY_HP: 0.65,
  DOOR_STAND_DISTANCE: 0.8,
  STRAFE_SECONDS: 1.6,
  /** Hazards: melee bots that fight within LURE_RANGE of one stand LURE_STANDOFF outside its edge, the hazard between them and the pack. */
  HAZARD_LURE_RANGE: 7, HAZARD_LURE_STANDOFF: 0.8, HAZARD_LURE_TARGET_RANGE: 9,
  /** Soul wisps: ranged bots shoot them inside this range; everyone strikes them when they are in reach. */
  WISP_SHOOT_RANGE: 8, WISP_PRIORITY_RANGE: 4.5,
  /** Tutorial script. */
  /** Ultimates: a full bar counts from here (the wire value is quantised), group sizes worth spending it on. */
  ULT_READY: 0.995, ULT_PACK: 3, ULT_SELF_RANGE: 0.6, ULT_LOW_HP: 0.5, RAGE_RANGE: 4.5, BANNER_BOSS_RANGE: 8,
  /** Secondaries by shape: fractions of the ability's reach at which the bot uses it. */
  LUNGE_REACH: 0.8, FAN_REACH: 0.7, SHOT_REACH: 0.8, LEAP_MIN: 2.5, ZONE_REACH: 0.95, ZONE_HEAL_HP: 0.7, TRAP_MIN: 2,
  /**
   * Update 4. Target choice: an enemy of these kinds is preferred as if it stood this many metres closer; so are
   * hunt targets and whatever threatens the bell shard (within SHARD_THREAT of its edge).
   */
  FOCUS: { shaman: 5, necromancer: 6, aegis: 3, bomber: 1.5 }, HUNT_FOCUS: 8, SHARD_FOCUS: 6, SHARD_THREAT: 3.2,
  /** Without a target the bot waits this far from the shard's edge; it stands this close to a reliquary. */
  SHARD_STAND: 1.6, VAULT_STAND: 0.7,
  /** Ritual: the bot holds this fraction of its circle's radius and steps back in when it is pushed further out. */
  SITE_HOLD: 0.75, SITE_STEP: 0.6,
  /**
   * Obstacles (pillars and the solid objective fixtures): when the way ahead is blocked within LOOKAHEAD the bot
   * walks along the obstacle's edge instead of pushing into it, PAD outside the distance at which it collides.
   */
  AVOID_LOOKAHEAD: 1.6, AVOID_PAD: 0.12, AVOID_OUTWARD: 0.3, AVOID_DEAD_ON: 0.02,
  /**
   * Update 5, keystones. Blood Price: the secondary is used early (for health) only above this health fraction (lower
   * if it heals or shields), on PRICE_PACK enemies or a boss, and at most once per PRICE_EVERY seconds.
   * Phase Walker / Shockstep / Blazing Wake: dash through or into a target within DASH_IN range when no dodge is
   * due, keeping DASH_KEEP charges for dodging unless the bot has only one. Glass Cannon: wider safety margins.
   * Arc Stream: the stream's reach replaces the bolt's.
   */
  PRICE_HP: 0.65, PRICE_HEAL_HP: 0.5, PRICE_PACK: 2, PRICE_EVERY: 1.5, DASH_IN: 4.2, DASH_IN_MIN: 1.2, DASH_IN_SECONDS: 2.2, DASH_PACK: 2,
  GLASS_LOW_HP: 0.6, GLASS_RANGE: 1.5, GLASS_MARGIN: 0.25, STREAM_REACH: 12,
  TUTORIAL_DASH_LEAD_SECONDS: 0.2, TUTORIAL_STAND: { x: 0, z: 1.5 }, TUTORIAL_HAZARD_STANDOFF: 1.8, TUTORIAL_STORM_DASH_RANGE: 3.6, TUTORIAL_CLOSE_RANGE: 3,
} as const;

interface Tele {
  shape: 'circle' | 'arc' | 'line';
  x: number;
  z: number;
  rot: number;
  r: number;
  w: number;
  seen: number;
  lands: number;
  until: number;
  src: number;
}

/** Assumed speeds for a projectile seen for the first time; afterwards its velocity is measured between views. */
const PROJECTILE_SPEED: Record<string, number> = {
  boneArrow: ENEMY_TUNING.ARROW_SPEED, hexOrb: ENEMY_TUNING.REGENT.VOLLEY_SPEED, boneSpear: ENEMY_TUNING.STALKER.SPEAR_SPEED,
  soulWisp: ENEMY_TUNING.MATRON.WISP_SPEED,
};
const MELEE_KINDS: ReadonlySet<string> = new Set(['minion', 'warrior']);
const RANGED: ReadonlySet<ClassId> = new Set<ClassId>(['mage', 'rogue']);

const BOON_SCORE: Record<string, number> = {
  keen_edge: 7, swift_strikes: 7, iron_heart: 6.5, heavy_hand: 5, deadeye: 6.5, executioner: 5, barrier: 6.5, leech: 5,
  last_stand: 7, fleet_foot: 4.5, quick_step: 4, spare_step: 5, quick_wits: 5, wildfire: 5.5, deep_frost: 5, overcharge: 6,
  amplifier: 6.5, wide_resonance: 5, aftershock: 5, echo: 6, kindred_flame: 6, shared_vigor: 4.5, lifeline: 2, oathbond: 4,
  // update 3
  momentum: 6, giant_slayer: 5.5, overkill: 4.5, first_blood: 4, brutality: 4, thorns: 4, mending: 5.5, stoneskin: 6.5,
  crystal_ward: 4.5, slipstream: 3, afterimage: 3.5, catalyst: 3.5, chain_reaction: 4, zealot: 5.5, crescendo: 5, encore: 5.5,
  opening_act: 4.5, covenant: 4, rally: 5, creeping_dark: 5,
};
const CLASS_BOON_SCORE = 6;
/** Keystone drafts: base score of a generic keystone for a melee / a ranged class; the class keystone beats them. */
const KEYSTONE_SCORE: Record<string, readonly [number, number]> = {
  ember_wake: [5, 5], shockstep: [6.5, 5], phase_walker: [5.5, 3.5], ricochet: [5.5, 8], chain_lightning: [6.5, 8], heavy_hitter: [7, 5],
  twin_cast: [6.5, 6.5], blood_price: [4.5, 4.5], orbit_blades: [8, 4], familiar: [6, 6.5], colossus: [7.5, 4], corpse_bloom: [4, 4],
  resonance_engine: [3, 3], glass_cannon: [3.5, 6], sanguine: [7, 5], momentum_engine: [6.5, 6.5],
};
const CLASS_KEYSTONE_SCORE = 9;
/** A keystone that feeds on an infusion the hero has (or lacks) moves by this much. */
const KEYSTONE_INFUSION_BONUS = 2;
/** With full slots a new keystone must beat the weakest held one by this much to replace it. */
const KEYSTONE_REPLACE_MARGIN = 1.5;
const DUO_BOON_SCORE = 8;
const NEEDS_COMBO: ReadonlySet<string> = new Set(['shared_vigor', 'crystal_ward', 'covenant']);

function insideTele(t: Tele, x: number, z: number, margin: number): boolean {
  if (t.shape === 'circle') return Math.hypot(x - t.x, z - t.z) <= t.r + margin;
  if (t.shape === 'arc') return inArc(t.x, t.z, t.rot, t.r, t.w, x, z, margin);
  return inLine(t.x, t.z, t.rot, t.r, t.w, x, z, margin);
}

export class BotBrain {
  readonly slot: number;
  cls: ClassId;
  private seq = 0;
  private rng: Rng;
  private telegraphs: Tele[] = [];
  private reactionTicks: number;
  private missChance: number;
  private strafeDir = 1;
  private strafeUntil = 0;
  private lastButtons = 0;
  private aim = Math.PI;
  /** Projectile positions of the previous view (to measure velocities). */
  private prevX = new Map<number, number>();
  private prevZ = new Map<number, number>();
  private prevTick = -1;
  private hazardScratch: HazardState = { phase: 'idle', t: 0 };
  private hazardTele: Tele = { shape: 'circle', x: 0, z: 0, rot: 0, r: 0, w: 0, seen: -1e9, lands: 0, until: 0, src: -1 };
  private art = 0;
  private descendTo: number;
  private preferObjectives: boolean;
  private preferCursed: boolean;
  /** Centre of the objective fixture the bot is walking up to this tick (not steered around), or null. */
  private goal: { x: number; z: number } | null = null;
  /** The bot is leaving a telegraphed area this tick. */
  private dodging = false;
  private forceKeystones: readonly string[];
  private keystoneMode: 'free' | 'only' | 'none';
  private held: readonly string[] = [];
  /** Tick until which the bot does not dash at an enemy again (keystone dashes). */
  private dashInUntil = 0;
  /** Blood Price: tick before which the bot does not pay for another early cast; the tick it is thinking about. */
  private payUntil = 0;
  private tick = 0;

  constructor(slot: number, cls: ClassId, seed = 1, opts: BotOptions = {}) {
    this.slot = slot;
    this.cls = cls;
    this.rng = new Rng(seed * 7919 + slot * 104729 + 13);
    this.reactionTicks = Math.round((opts.reaction ?? BOT.REACTION_SECONDS) / TICK_DT);
    this.missChance = opts.missChance ?? BOT.MISS_CHANCE;
    this.descendTo = opts.descendTo ?? 0;
    this.preferObjectives = opts.preferObjectives === true;
    this.preferCursed = opts.preferCursed === true;
    this.forceKeystones = opts.keystones ?? [];
    this.keystoneMode = opts.keystoneMode ?? 'free';
    this.strafeDir = this.rng.chance(0.5) ? 1 : -1;
  }

  /** Feed every batch of game events (only telegraphs are remembered). */
  observe(events: readonly GameEvent[], tick: number): void {
    for (const ev of events) {
      if (ev.e !== 'telegraph' || this.rng.chance(this.missChance)) continue;
      const lands = tick + Math.round(ev.dur / TICK_DT);
      const charge = ev.shape === 'line' && ev.w >= BOT.CHARGE_LINE_MIN_WIDTH;
      this.telegraphs.push({
        shape: ev.shape, x: ev.x, z: ev.z, rot: ev.rot, r: ev.r, w: ev.w, seen: tick, lands,
        until: lands + (charge ? Math.round(BOT.CHARGE_LINGER_SECONDS / TICK_DT) : 1), src: ev.src ?? -1,
      });
    }
  }

  /** Highest scoring offer (index into `offers`). */
  chooseBoon(offers: readonly BoonOffer[], own: readonly BoonStack[]): number {
    const elements = new Set<ElementId>();
    const slotElement = new Map<string, ElementId>();
    for (const b of own) {
      const def = BOON_BY_ID.get(b.id);
      if (def && def.category === 'infusion' && def.element && def.slot) {
        elements.add(def.element);
        slotElement.set(def.slot, def.element);
      }
    }
    let best = 0;
    let bestScore = -Infinity;
    offers.forEach((offer, i) => {
      const def = BOON_BY_ID.get(offer.id);
      let score = 1;
      if (def && def.category === 'infusion' && def.element && def.slot) {
        const current = slotElement.get(def.slot);
        if (current === undefined) {
          score = def.slot === 'primary' ? 9 : def.slot === 'secondary' ? 8 : def.slot === 'dash' ? 5 : 4;
          if (elements.size >= 1) score += elements.has(def.element) ? -5 : 3;
        } else if (current === def.element) {
          score = 4;
        } else {
          score = elements.size === 1 && slotElement.size > 1 ? 6 : 1;
        }
      } else if (def) {
        score = def.category === 'class' ? CLASS_BOON_SCORE : def.category === 'duo' ? DUO_BOON_SCORE : BOON_SCORE[def.id] ?? 3;
        const needsCombo = def.category === 'resonance' || NEEDS_COMBO.has(def.id);
        if (needsCombo && elements.size < 2) score *= 0.5;
      }
      if (score > bestScore) { bestScore = score; best = i; }
    });
    return best;
  }

  /** How much the bot wants a keystone, given its class and the infusions it has. */
  private keystoneScore(id: string, own: readonly BoonStack[]): number {
    const def = KEYSTONE_BY_ID.get(id);
    if (!def) return 0;
    if (def.cls !== undefined) return CLASS_KEYSTONE_SCORE;
    const base = KEYSTONE_SCORE[id];
    let score = base ? base[RANGED.has(this.cls) ? 1 : 0] : 4;
    const slots = new Set<string>();
    const elements = new Set<ElementId>();
    for (const b of own) {
      const boon = BOON_BY_ID.get(b.id);
      if (boon && boon.category === 'infusion' && boon.element && boon.slot) { slots.add(boon.slot); elements.add(boon.element); }
    }
    // Keystones that carry an element want the infusion of their slot; the status keystones want any / two.
    if (def.slot === 'dash' && id !== 'phase_walker' && slots.has('dash')) score += KEYSTONE_INFUSION_BONUS;
    if ((id === 'chain_lightning' || id === 'orbit_blades' || id === 'familiar') && slots.has('primary')) score += KEYSTONE_INFUSION_BONUS;
    if (id === 'corpse_bloom') score += elements.size > 0 ? KEYSTONE_INFUSION_BONUS + elements.size : -KEYSTONE_INFUSION_BONUS;
    if (id === 'resonance_engine') score += elements.size >= 2 ? 2 * KEYSTONE_INFUSION_BONUS : -KEYSTONE_INFUSION_BONUS;
    return score;
  }

  /**
   * Choice in a keystone draft: the index to pick (`skip` = the consolation) and, with full slots, the keystone to
   * give up. The class keystone and keystones that match the hero's infusions come first; forced ids
   * (BotOptions.keystones) beat everything.
   */
  chooseKeystone(offers: readonly BoonOffer[], held: readonly string[], skip: number, own: readonly BoonStack[]): { index: number; replace?: string } {
    if (this.keystoneMode === 'none') return { index: skip };
    const full = held.length >= KEYSTONE_TUNING.MAX_HELD;
    const forced = offers.findIndex((o) => this.forceKeystones.includes(o.id));
    let weakest: string | undefined;
    let weakestScore = Infinity;
    for (const id of held) {
      const score = this.forceKeystones.includes(id) ? Infinity : this.keystoneScore(id, own);
      if (score < weakestScore) { weakestScore = score; weakest = id; }
    }
    if (forced >= 0) {
      if (!full) return { index: forced };
      return weakest !== undefined && weakestScore < Infinity ? { index: forced, replace: weakest } : { index: skip };
    }
    if (this.keystoneMode === 'only') return { index: skip };
    let best = 0;
    let bestScore = -Infinity;
    offers.forEach((o, i) => {
      const score = this.keystoneScore(o.id, own);
      if (score > bestScore) { bestScore = score; best = i; }
    });
    if (!full) return { index: best };
    if (weakest !== undefined && bestScore >= weakestScore + KEYSTONE_REPLACE_MARGIN) return { index: best, replace: weakest };
    return { index: skip };
  }

  /** Door the bot walks to: the door of the lowest-slot hero already standing in one, else a shared preference. */
  private chooseDoor(view: BotView): number {
    const doors = view.run.doors;
    if (doors.length <= 1) return 0;
    // After a final boss: deeper while the bot was told to, otherwise bank the run.
    const down = doors.findIndex((d) => d.type === 'descend');
    if (down >= 0) {
      const up = doors.findIndex((d) => d.type === 'ascend');
      return view.run.depth < this.descendTo || up < 0 ? down : up;
    }
    let leader: PlayerSnap | null = null;
    for (const p of view.players) {
      if (p.state !== 'alive' || (p.flags & PF.CONNECTED) === 0 || (p.flags & PF.IN_DOOR_ZONE) === 0) continue;
      if (!leader || p.slot < leader.slot) leader = p;
    }
    if (leader) {
      // Whoever (lowest slot) already stands in a door decides, including this bot itself: no dithering.
      let best = 0;
      let bestD = Infinity;
      const lx = leader.x;
      const lz = leader.z;
      doors.forEach((d, i) => {
        const dist = Math.hypot(d.x - lx, d.z - lz);
        if (dist < bestD) { bestD = dist; best = i; }
      });
      return best;
    }
    let hp = 0;
    let n = 0;
    for (const p of view.players) {
      if ((p.flags & PF.CONNECTED) === 0) continue;
      hp += p.maxHp > 0 ? p.hp / p.maxHp : 0;
      n++;
    }
    const want = n > 0 && hp / n < BOT.LOW_PARTY_HP ? 'blessing' : 'boon';
    if (this.preferCursed) {
      const cursed = doors.findIndex((d) => d.type === 'cursed');
      if (cursed >= 0) return cursed;
    }
    if (this.preferObjectives) {
      // A special objective first: of the wanted door type if both doors have one, behind a cursed door only if
      // there is no other.
      let special = doors.findIndex((d) => d.objective !== 'slay' && d.type === want);
      if (special < 0) special = doors.findIndex((d) => d.objective !== 'slay' && d.type !== 'cursed');
      if (special < 0) special = doors.findIndex((d) => d.objective !== 'slay');
      if (special >= 0) return special;
    }
    let index = doors.findIndex((d) => d.type === want);
    if (index < 0) index = doors.findIndex((d) => d.type !== 'cursed');
    return index < 0 ? 0 : index;
  }

  /**
   * Turns a move that runs into an obstacle within AVOID_LOOKAHEAD into a walk along its edge (on the side the
   * bot is already heading for; dead on, the slot decides). The obstacle the bot wants to stand next to
   * (`this.goal`: the shard, a brazier's bowl, the reliquary) is not walked around.
   */
  private steerAround(room: RoomLayout, me: PlayerSnap, cmd: InputCmd): void {
    const len = Math.hypot(cmd.moveX, cmd.moveZ);
    if (len < 0.01) return;
    const nx = cmd.moveX / len;
    const nz = cmd.moveZ / len;
    const goal = this.goal;
    let bestAlong = Infinity;
    let bx = 0;
    let bz = 0;
    let bReach = 0;
    for (const o of room.obstacles) {
      if (goal && o.x === goal.x && o.z === goal.z) continue;
      const cx = o.x - me.x;
      const cz = o.z - me.z;
      const reach = o.r + WORLD.PLAYER_RADIUS + BOT.AVOID_PAD;
      const along = cx * nx + cz * nz;
      if (along <= 0 || along >= bestAlong || along > BOT.AVOID_LOOKAHEAD + reach) continue;
      if (Math.abs(nx * cz - nz * cx) >= reach) continue;
      bestAlong = along;
      bx = cx;
      bz = cz;
      bReach = reach;
    }
    if (bestAlong === Infinity) return;
    const dc = Math.hypot(bx, bz);
    if (dc < 1e-6) return;
    const cross = nx * bz - nz * bx;
    const side = Math.abs(cross) > BOT.AVOID_DEAD_ON ? Math.sign(cross) : (this.slot & 1) === 0 ? 1 : -1;
    // Along the edge, away from the side the centre lies on; a little outwards while touching it.
    let tx = (bz / dc) * side;
    let tz = (-bx / dc) * side;
    if (dc < bReach) { tx -= (bx / dc) * BOT.AVOID_OUTWARD; tz -= (bz / dc) * BOT.AVOID_OUTWARD; }
    const tl = Math.hypot(tx, tz);
    const scale = Math.min(1, len) / tl;
    cmd.moveX = tx * scale;
    cmd.moveZ = tz * scale;
  }

  think(view: BotView): InputCmd {
    const cmd: InputCmd = { seq: ++this.seq, moveX: 0, moveZ: 0, aim: this.aim, aimDist: 6, buttons: 0 };
    this.goal = null;
    this.dodging = false;
    const me = view.players.find((p) => p.slot === this.slot);
    const room = view.run.room;
    this.art = view.art ?? 0;
    this.held = view.keystones ?? [];
    this.tick = view.tick;
    if (!me || !room || me.state !== 'alive') {
      this.lastButtons = 0;
      return cmd;
    }
    const phase = view.run.phase;
    if (phase === 'doors') {
      const door = view.run.doors[this.chooseDoor(view)];
      if (door) this.moveTo(cmd, me, door.x, door.z, BOT.DOOR_STAND_DISTANCE);
      this.steerAround(room, me, cmd);
      this.aim = cmd.aim = Math.atan2(cmd.moveX, cmd.moveZ) || this.aim;
      this.lastButtons = 0;
      return cmd;
    }
    if (phase !== 'combat') {
      this.lastButtons = 0;
      return cmd;
    }
    const tutorial = view.run.tutorial;
    if (tutorial) this.tutorial(view, me, room, cmd, tutorial);
    else {
      this.combat(view, me, room, cmd);
      if (!this.dodging) this.steerAround(room, me, cmd);
    }
    this.rememberProjectiles(view);
    this.lastButtons = cmd.buttons;
    this.aim = cmd.aim;
    return cmd;
  }

  private rememberProjectiles(view: BotView): void {
    this.prevX.clear();
    this.prevZ.clear();
    for (const p of view.projectiles) {
      if (!p.hostile) continue;
      this.prevX.set(p.id, p.x);
      this.prevZ.set(p.id, p.z);
    }
    this.prevTick = view.tick;
  }

  private moveTo(cmd: InputCmd, me: PlayerSnap, x: number, z: number, stop: number): void {
    const dx = x - me.x;
    const dz = z - me.z;
    const d = Math.hypot(dx, dz);
    if (d <= stop) return;
    cmd.moveX = dx / d;
    cmd.moveZ = dz / d;
  }

  private pruneTelegraphs(view: BotView): void {
    const keep: Tele[] = [];
    for (const t of this.telegraphs) {
      if (view.tick > t.until) continue;
      if (t.src >= 0 && view.tick <= t.lands) {
        const src = view.enemies.find((e) => e.id === t.src);
        if (!src || src.hp <= 0 || (src.flags & EF.STUNNED) !== 0) continue;
      }
      keep.push(t);
    }
    this.telegraphs = keep;
  }

  private dangerAt(view: BotView, x: number, z: number, margin: number): Tele | null {
    let worst: Tele | null = null;
    for (const t of this.telegraphs) {
      if (view.tick - t.seen < this.reactionTicks) continue;
      if (!insideTele(t, x, z, margin)) continue;
      if (!worst || t.lands < worst.lands) worst = t;
    }
    // Floor hazards that are warning or active count like a telegraph (their state is a pure function of the tick).
    const room = view.run.room;
    if (room) {
      for (const hz of room.hazards) {
        const dx = x - hz.x;
        const dz = z - hz.z;
        const reach = hz.r + margin;
        if (dx * dx + dz * dz > reach * reach) continue;
        const state = hazardState(hz, view.tick, this.hazardScratch);
        if (state.phase === 'idle') continue;
        const lands = state.phase === 'active' ? view.tick : view.tick + Math.round(((1 - state.t) * HAZARD_TIMING.WARN) / TICK_DT);
        if (worst && worst.lands <= lands) continue;
        const t = this.hazardTele;
        t.x = hz.x; t.z = hz.z; t.r = hz.r; t.lands = lands; t.until = lands;
        worst = t;
      }
    }
    return worst;
  }

  private inRoom(room: RoomLayout, x: number, z: number, margin: number): boolean {
    if (Math.abs(x) > room.w / 2 - margin || Math.abs(z) > room.d / 2 - margin) return false;
    for (const o of room.obstacles) if (Math.hypot(o.x - x, o.z - z) < o.r + WORLD.PLAYER_RADIUS) return false;
    return true;
  }

  /** Unit direction and distance of the shortest way out of a telegraph. */
  private escape(t: Tele, me: PlayerSnap, room: RoomLayout): { x: number; z: number; dist: number } {
    const m = BOT.TELEGRAPH_MARGIN + 0.15;
    const options: { x: number; z: number; dist: number }[] = [];
    if (t.shape === 'line') {
      const dirX = Math.sin(t.rot);
      const dirZ = Math.cos(t.rot);
      const side = (me.x - t.x) * dirZ - (me.z - t.z) * dirX;
      const sign = side >= 0 ? 1 : -1;
      options.push({ x: dirZ * sign, z: -dirX * sign, dist: t.w / 2 + m - Math.abs(side) });
      options.push({ x: -dirZ * sign, z: dirX * sign, dist: t.w / 2 + m + Math.abs(side) });
    } else {
      let dx = me.x - t.x;
      let dz = me.z - t.z;
      let d = Math.hypot(dx, dz);
      if (d < 0.05) { dx = -me.x; dz = -me.z; d = Math.hypot(dx, dz) || 1; dx /= d; dz /= d; d = 0; } else { dx /= d; dz /= d; }
      options.push({ x: dx, z: dz, dist: t.r + m - d });
      if (t.shape === 'arc' && d > 0.3) {
        // Sideways out of the sector.
        const off = angleDiff(Math.atan2(dx, dz), t.rot);
        const sign = off >= 0 ? 1 : -1;
        const arcDist = Math.max(0, t.w / 2 - Math.abs(off)) * d + m;
        options.push({ x: dz * sign, z: -dx * sign, dist: arcDist });
      } else {
        options.push({ x: dz, z: -dx, dist: t.r + m });
        options.push({ x: -dz, z: dx, dist: t.r + m });
      }
    }
    let best = options[0] as { x: number; z: number; dist: number };
    let bestCost = Infinity;
    for (const o of options) {
      const ex = me.x + o.x * o.dist;
      const ez = me.z + o.z * o.dist;
      const cost = o.dist + (this.inRoom(room, ex, ez, WORLD.PLAYER_RADIUS) ? 0 : 100);
      if (cost < bestCost) { bestCost = cost; best = o; }
    }
    return best;
  }

  private projectileThreat(view: BotView, me: PlayerSnap): { x: number; z: number; t: number } | null {
    let best: { x: number; z: number; t: number } | null = null;
    for (const p of view.projectiles as ProjectileSnap[]) {
      if (!p.hostile) continue;
      const rx = me.x - p.x;
      const rz = me.z - p.z;
      if (rx * rx + rz * rz > BOT.PROJECTILE_SCAN_RADIUS * BOT.PROJECTILE_SCAN_RADIUS) continue;
      let vx: number;
      let vz: number;
      const px = this.prevX.get(p.id);
      const pz = this.prevZ.get(p.id);
      const elapsed = (view.tick - this.prevTick) * TICK_DT;
      if (px !== undefined && pz !== undefined && elapsed > 0 && (p.x !== px || p.z !== pz)) {
        vx = (p.x - px) / elapsed;
        vz = (p.z - pz) / elapsed;
      } else {
        const assumed = PROJECTILE_SPEED[p.kind] ?? 10;
        vx = Math.sin(p.rot) * assumed;
        vz = Math.cos(p.rot) * assumed;
      }
      const speed = Math.hypot(vx, vz) || 1;
      const t = (rx * vx + rz * vz) / (speed * speed);
      if (t <= 0 || t > BOT.PROJECTILE_HORIZON_SECONDS) continue;
      const mx = rx - vx * t;
      const mz = rz - vz * t;
      const miss = Math.hypot(mx, mz);
      if (miss >= BOT.PROJECTILE_MISS_DISTANCE) continue;
      if (best && best.t <= t) continue;
      // Step further to the side we are already on (perpendicular to the projectile's path).
      const cross = vx * rz - vz * rx;
      const sign = cross >= 0 ? 1 : -1;
      best = { x: (-vz / speed) * sign, z: (vx / speed) * sign, t };
    }
    return best;
  }

  private lineOfFire(room: RoomLayout, ax: number, az: number, bx: number, bz: number): boolean {
    for (const o of room.obstacles) if (blocksShots(o) && sweepHit(ax, az, bx, bz, o.x, o.z, o.r + 0.3) >= 0) return false;
    return true;
  }

  private combat(view: BotView, me: PlayerSnap, room: RoomLayout, cmd: InputCmd): void {
    this.pruneTelegraphs(view);
    const def = CLASSES[this.cls];
    const ranged = RANGED.has(this.cls);
    const primary = def.primary[0];
    const held = this.held;
    const glass = held.includes('glass_cannon');
    // Arc Stream reaches less far than the bolt it replaces.
    const range = held.includes('ks_mage') ? BOT.STREAM_REACH + 1 : primary ? primary.range : 2.5;
    const sec = secondaryOf(def, this.art);
    const ult = def.ultimate;

    // Target: the nearest enemy that can be hit, with a head start for supports (shaman, necromancer, aegis),
    // marked hunt targets and whatever is hacking at the bell shard.
    const objective = view.run.objective;
    const shard = objective && objective.kind === 'defend' && objective.anchor && objective.anchor.hp > 0 ? objective.anchor : null;
    const marks = objective && objective.kind === 'hunt' ? objective.targets : null;
    const focus: Partial<Record<string, number>> = BOT.FOCUS;
    let target: EnemySnap | null = null;
    let targetD = Infinity;
    let targetScore = Infinity;
    let close = 0;
    let cx = 0;
    let cz = 0;
    for (const e of view.enemies) {
      if (e.hp <= 0 || e.anim === 'death') continue;
      const d = Math.hypot(e.x - me.x, e.z - me.z);
      if (d < 6) { close++; cx += e.x; cz += e.z; }
      if (e.anim === 'spawn') continue;
      let score = d - (focus[e.kind] ?? 0);
      if (marks && marks.includes(e.id)) score -= BOT.HUNT_FOCUS;
      if (shard && Math.hypot(e.x - shard.x, e.z - shard.z) <= shard.r + ENEMIES[e.kind].attackRange + BOT.SHARD_THREAT && ENEMIES[e.kind].attackRange < BOT.RANGED_MIN) score -= BOT.SHARD_FOCUS;
      if (score < targetScore) { targetScore = score; targetD = d; target = e; }
    }
    const lowHp = me.hp < me.maxHp * (glass ? BOT.GLASS_LOW_HP : 0.35);

    let mx = 0;
    let mz = 0;
    let wantPrimary = false;
    let wantSecondary = false;
    let wantDash = false;
    let wantUlt = false;

    if (target) {
      const er = ENEMIES[target.kind].radius;
      cmd.aim = Math.atan2(target.x - me.x, target.z - me.z);
      cmd.aimDist = Math.min(targetD, 25);
      const dirX = (target.x - me.x) / (targetD || 1);
      const dirZ = (target.z - me.z) / (targetD || 1);
      if (ranged) {
        const clear = this.lineOfFire(room, me.x, me.z, target.x, target.z);
        wantPrimary = targetD <= range - 1 && clear;
        const min = BOT.RANGED_MIN + (lowHp ? 1.5 : 0) + (glass ? BOT.GLASS_RANGE : 0);
        const max = BOT.RANGED_MAX;
        if (view.tick >= this.strafeUntil) {
          this.strafeUntil = view.tick + Math.round((BOT.STRAFE_SECONDS * (0.6 + this.rng.next() * 0.8)) / TICK_DT);
          this.strafeDir = -this.strafeDir;
        }
        if (close > 0 && targetD < min) {
          // Retreat from the centre of the nearby pack, with a sideways component so corners are not traps.
          const ax = me.x - cx / close;
          const az = me.z - cz / close;
          const ad = Math.hypot(ax, az) || 1;
          mx = ax / ad + (-az / ad) * this.strafeDir * 0.5;
          mz = az / ad + (ax / ad) * this.strafeDir * 0.5;
        } else if (targetD > max || !clear) {
          mx = dirX + (-dirZ) * this.strafeDir * (clear ? 0 : 0.9);
          mz = dirZ + dirX * this.strafeDir * (clear ? 0 : 0.9);
        } else {
          mx = -dirZ * this.strafeDir;
          mz = dirX * this.strafeDir;
        }
        wantSecondary = this.secondaryFits(sec, me, target, targetD, close, clear) && (me.cdSecondary <= 0 || this.payBlood(me, sec, target, close));
        if (close >= 3 && targetD < 2.5 && me.dashCharges >= 1) wantDash = true;
      } else {
        const hitRange = range + er;
        const stand = Math.max(1.4, hitRange - 0.55);
        wantPrimary = targetD <= hitRange + 0.1;
        if (targetD > stand) {
          mx = dirX;
          mz = dirZ;
        } else if (targetD < stand - 0.9) {
          mx = -dirX;
          mz = -dirZ;
        }
        wantSecondary = this.secondaryFits(sec, me, target, targetD, close, true) && (me.cdSecondary <= 0 || this.payBlood(me, sec, target, close));
      }
      if (me.ult >= BOT.ULT_READY) wantUlt = this.ultimateFits(ult, view, me, target, targetD, close);
    } else if (me.ult >= BOT.ULT_READY && ult.special === 'revive') {
      wantUlt = this.allyDownWithin(view, me, ult.radius);
    }

    // Soul wisps home in on heroes but pop when struck: strike one that is in reach, shoot one that is near.
    let wisp: ProjectileSnap | null = null;
    let wispD = Infinity;
    for (const p of view.projectiles) {
      if (!p.hostile || p.kind !== 'soulWisp') continue;
      const d = Math.hypot(p.x - me.x, p.z - me.z);
      if (d < wispD) { wispD = d; wisp = p; }
    }
    if (wisp) {
      const reach = ranged ? BOT.WISP_SHOOT_RANGE : range + 0.3;
      const urgent = wispD <= BOT.WISP_PRIORITY_RANGE || !target || wispD < targetD;
      if (wispD <= reach && urgent && (!ranged || this.lineOfFire(room, me.x, me.z, wisp.x, wisp.z))) {
        cmd.aim = Math.atan2(wisp.x - me.x, wisp.z - me.z);
        cmd.aimDist = wispD;
        wantPrimary = true;
        wantSecondary = false;
        wantUlt = false;
      }
    }

    // Fight next to a floor hazard when one is close: stand just outside it with the hazard between us and the pack.
    if (!ranged && target && MELEE_KINDS.has(target.kind) && targetD <= BOT.HAZARD_LURE_TARGET_RANGE && room.hazards.length > 0) {
      let best: Hazard | null = null;
      let bestD: number = BOT.HAZARD_LURE_RANGE;
      for (const hz of room.hazards) {
        const d = Math.hypot(hz.x - me.x, hz.z - me.z) - hz.r;
        if (d < bestD) { bestD = d; best = hz; }
      }
      if (best) {
        let ax = best.x - target.x;
        let az = best.z - target.z;
        const ad = Math.hypot(ax, az);
        if (ad > 0.5) {
          ax /= ad;
          az /= ad;
          const sx = best.x + ax * (best.r + BOT.HAZARD_LURE_STANDOFF);
          const sz = best.z + az * (best.r + BOT.HAZARD_LURE_STANDOFF);
          const sd = Math.hypot(sx - me.x, sz - me.z);
          // Only when the anchor is on our side already (never walk through the hazard to get there).
          const cross = sweepHit(me.x, me.z, sx, sz, best.x, best.z, best.r + BOT.TELEGRAPH_MARGIN) >= 0;
          if (!cross && this.inRoom(room, sx, sz, WORLD.PLAYER_RADIUS)) {
            if (sd > 0.4) { mx = (sx - me.x) / sd; mz = (sz - me.z) / sd; } else { mx = 0; mz = 0; }
          }
        }
      }
    }

    // Objectives: wait at the shard, hold a brazier circle, open the reliquary.
    if (objective && objective.status === 'active') {
      if (objective.kind === 'vault' && objective.anchor) {
        const a = objective.anchor;
        const d = Math.hypot(a.x - me.x, a.z - me.z);
        if (d > a.r + BOT.VAULT_STAND) { mx = (a.x - me.x) / d; mz = (a.z - me.z) / d; } else { mx = 0; mz = 0; }
        this.goal = a;
      } else if (shard && !target) {
        const d = Math.hypot(shard.x - me.x, shard.z - me.z);
        if (d > shard.r + BOT.SHARD_STAND) { mx = (shard.x - me.x) / d; mz = (shard.z - me.z) / d; }
        this.goal = shard;
      } else if (objective.kind === 'ritual') {
        const site = this.ritualSite(view, objective.sites);
        if (site) {
          const hold = site.r * BOT.SITE_HOLD;
          const d = Math.hypot(site.x - me.x, site.z - me.z);
          const len = Math.hypot(mx, mz);
          if (d > hold) {
            mx = (site.x - me.x) / d;
            mz = (site.z - me.z) / d;
            this.goal = site;
          } else if (len > 0.01 && Math.hypot(me.x + (mx / len) * BOT.SITE_STEP - site.x, me.z + (mz / len) * BOT.SITE_STEP - site.z) > hold) {
            mx = 0;
            mz = 0;
          }
        }
      }
    }

    // Revive a fallen ally when possible.
    let ally: PlayerSnap | null = null;
    let allyD = Infinity;
    for (const p of view.players) {
      if (p.slot === this.slot || p.state !== 'downed') continue;
      const d = Math.hypot(p.x - me.x, p.z - me.z);
      if (d < allyD) { allyD = d; ally = p; }
    }
    if (ally) {
      if (allyD > BOT.REVIVE_STAND_DISTANCE) {
        mx = (ally.x - me.x) / allyD;
        mz = (ally.z - me.z) / allyD;
      } else {
        mx = 0;
        mz = 0;
      }
    }

    // Stay off the walls (ranged heroes kite along them otherwise).
    if (ranged && !ally) {
      const hx = room.w / 2 - BOT.WALL_MARGIN;
      const hz = room.d / 2 - BOT.WALL_MARGIN;
      if (me.x > hx) mx -= (me.x - hx) / BOT.WALL_MARGIN * 1.5; else if (me.x < -hx) mx += (-hx - me.x) / BOT.WALL_MARGIN * 1.5;
      if (me.z > hz) mz -= (me.z - hz) / BOT.WALL_MARGIN * 1.5; else if (me.z < -hz) mz += (-hz - me.z) / BOT.WALL_MARGIN * 1.5;
    }

    // Dodge: telegraphs first, then projectiles.
    const margin = BOT.TELEGRAPH_MARGIN + (glass ? BOT.GLASS_MARGIN : 0);
    const danger = this.dangerAt(view, me.x, me.z, margin);
    if (danger) {
      // Getting out of a telegraph comes first: the way out is not bent around obstacles.
      this.dodging = true;
      const out = this.escape(danger, me, room);
      const left = (danger.lands - view.tick) * TICK_DT;
      const walk = out.dist / BOT.WALK_SPEED;
      mx = out.x;
      mz = out.z;
      if (left < walk * 2 + 0.25) { wantPrimary = false; wantSecondary = false; wantUlt = false; }
      if (left >= 0 && left < walk + 0.1 && me.dashCharges >= 1) wantDash = true;
    } else {
      const shot = this.projectileThreat(view, me);
      if (shot) {
        mx = shot.x + mx * 0.3;
        mz = shot.z + mz * 0.3;
        if (shot.t < 0.12 && me.dashCharges >= 1) wantDash = true;
      }
      // Do not walk into a marked area.
      const len = Math.hypot(mx, mz);
      if (len > 0.01) {
        const nx = mx / len;
        const nz = mz / len;
        if (this.dangerAt(view, me.x + nx * 1.1, me.z + nz * 1.1, BOT.TELEGRAPH_MARGIN * 0.6)) {
          let found = false;
          for (const turn of [1.05, -1.05, 2.1, -2.1]) {
            const c = Math.cos(turn);
            const s = Math.sin(turn);
            const tx = nx * c + nz * s;
            const tz = nz * c - nx * s;
            if (this.dangerAt(view, me.x + tx * 1.1, me.z + tz * 1.1, BOT.TELEGRAPH_MARGIN * 0.6)) continue;
            mx = tx;
            mz = tz;
            found = true;
            break;
          }
          if (!found) { mx = 0; mz = 0; }
        }
      }
    }

    // Dash keystones: dash through the target (Phase Walker) or into the pack (Shockstep, Blazing Wake) when nothing
    // has to be dodged; a second charge is kept for dodging.
    if (!danger && target && !wantDash && !lowHp && view.tick >= this.dashInUntil && targetD <= BOT.DASH_IN && targetD >= BOT.DASH_IN_MIN) {
      const phase = held.includes('phase_walker');
      const area = held.includes('shockstep') || held.includes('ember_wake');
      const spare = me.dashCharges >= 2 || (me.dashCharges >= 1 && CLASSES[this.cls].dashCharges === 1 && !held.includes('shockstep'));
      if ((phase || (area && close >= BOT.DASH_PACK)) && spare && (!ranged || phase && close <= 1)) {
        const tx = target.x - me.x;
        const tz = target.z - me.z;
        const ahead = this.dangerAt(view, me.x + (tx / targetD) * BOT.DASH_IN, me.z + (tz / targetD) * BOT.DASH_IN, margin);
        if (!ahead) {
          mx = tx / targetD;
          mz = tz / targetD;
          wantDash = true;
          this.dashInUntil = view.tick + Math.round(BOT.DASH_IN_SECONDS / TICK_DT);
        }
      }
    }

    const len = Math.hypot(mx, mz);
    if (len > 0.01) {
      cmd.moveX = mx / Math.max(1, len);
      cmd.moveZ = mz / Math.max(1, len);
    }
    if (wantPrimary) cmd.buttons |= BTN.PRIMARY;
    // SECONDARY and DASH trigger on a rising edge: pulse them.
    if (wantUlt && (this.lastButtons & BTN.ULTIMATE) === 0) cmd.buttons |= BTN.ULTIMATE;
    else if (wantSecondary && (this.lastButtons & BTN.SECONDARY) === 0) cmd.buttons |= BTN.SECONDARY;
    if (wantDash && (this.lastButtons & BTN.DASH) === 0) cmd.buttons |= BTN.DASH;
  }

  /**
   * The brazier this bot lights: the living heroes spread over the unlit circles in slot order, so a party lights
   * several at once and doubles up as circles are finished.
   */
  private ritualSite(view: BotView, sites: readonly { x: number; z: number; r: number; lit: boolean }[]): { x: number; z: number; r: number } | null {
    let rank = 0;
    for (const p of view.players) {
      if (p.slot < this.slot && p.state === 'alive' && (p.flags & PF.CONNECTED) !== 0) rank++;
    }
    let unlit = 0;
    for (const s of sites) if (!s.lit) unlit++;
    if (unlit === 0) return null;
    let want = rank % unlit;
    for (const s of sites) {
      if (s.lit) continue;
      if (want === 0) return s;
      want--;
    }
    return null;
  }

  /** Is this the moment for the equipped secondary? Decided by the ability's shape, so every variant is covered. */
  private secondaryFits(sec: AbilityDef, me: PlayerSnap, target: EnemySnap, targetD: number, close: number, clear: boolean): boolean {
    const bossy = ENEMIES[target.kind].cost === 0;
    switch (sec.shape) {
      case 'lunge': return targetD <= sec.range * BOT.LUNGE_REACH;
      case 'spin': return targetD <= sec.radius && (close >= 2 || bossy || target.hp > 0.5);
      case 'circle': return targetD <= sec.range;
      case 'projectile': return sec.count > 1 ? targetD <= sec.range * BOT.FAN_REACH : targetD <= sec.range * BOT.SHOT_REACH && clear;
      case 'beam': return targetD <= sec.range * BOT.SHOT_REACH;
      case 'leap': return targetD <= sec.range && targetD >= BOT.LEAP_MIN;
      case 'trap': return targetD <= sec.range && targetD >= BOT.TRAP_MIN;
      case 'zone':
        if (sec.range > 0) return targetD <= sec.range;
        return targetD <= sec.radius * BOT.ZONE_REACH && (close >= 2 || bossy || (sec.heal > 0 && me.hp < me.maxHp * BOT.ZONE_HEAL_HP));
      default: return false;
    }
  }

  /**
   * Blood Price: is it worth paying health to use the secondary before it has recharged? Only with plenty of
   * health (less for an ability that heals or shields), and only on a pack or a boss.
   */
  private payBlood(me: PlayerSnap, sec: AbilityDef, target: EnemySnap, close: number): boolean {
    if (!this.held.includes('blood_price')) return false;
    // Only a cast that does what a plain attack cannot (an area, a stun, a sure crit) is worth health; a spin or a
    // plain lunge repeated early only keeps the hero committed in the pack.
    const pays = sec.shape === 'circle' || sec.shape === 'zone' || sec.shape === 'projectile' || sec.shape === 'trap' || sec.shape === 'beam'
      || (sec.shape === 'lunge' && (sec.stun > 0 || sec.special === 'crit'));
    if (!pays) return false;
    const mends = sec.selfShield > 0 || (sec.heal > 0 && !this.held.includes('sanguine'));
    if (me.hp <= me.maxHp * (mends ? BOT.PRICE_HEAL_HP : BOT.PRICE_HP) || this.tick < this.payUntil) return false;
    if (close < BOT.PRICE_PACK && ENEMIES[target.kind].cost !== 0) return false;
    // Not in a row: every cast roots or commits the hero for a moment.
    this.payUntil = this.tick + Math.round(BOT.PRICE_EVERY / TICK_DT);
    return true;
  }

  private allyDownWithin(view: BotView, me: PlayerSnap, radius: number): boolean {
    for (const p of view.players) {
      if (p.slot !== this.slot && p.state === 'downed' && Math.hypot(p.x - me.x, p.z - me.z) <= radius) return true;
    }
    return false;
  }

  /** Is the full ultimate worth spending now? Area ultimates wait for a pack or a boss, buffs for pressure. */
  private ultimateFits(ult: AbilityDef, view: BotView, me: PlayerSnap, target: EnemySnap, targetD: number, close: number): boolean {
    const bossy = ENEMIES[target.kind].cost === 0;
    const low = me.hp < me.maxHp * BOT.ULT_LOW_HP;
    if (ult.shape === 'buff') {
      if (ult.radius > 0) return close >= BOT.ULT_PACK || (bossy && targetD <= BOT.BANNER_BOSS_RANGE) || (low && close >= 1);
      return targetD <= BOT.RAGE_RANGE && (close >= 2 || bossy);
    }
    if (ult.range <= 0) {
      // Centred on the hero (sanctuary, overload).
      if (ult.special === 'revive' && (this.allyDownWithin(view, me, ult.radius) || (low && close >= 1))) return true;
      return targetD <= ult.radius * BOT.ULT_SELF_RANGE && (close >= BOT.ULT_PACK || bossy);
    }
    if (targetD > ult.range) return false;
    let pack = 0;
    for (const e of view.enemies) {
      if (e.hp > 0 && e.anim !== 'death' && Math.hypot(e.x - target.x, e.z - target.z) <= ult.radius) pack++;
    }
    return bossy || pack >= BOT.ULT_PACK;
  }
  // ------------------------------------------------------------------ tutorial

  /** Plays the training session from what a client sees: the step id, the marker, telegraphs and the snapshot. */
  private tutorial(view: BotView, me: PlayerSnap, room: RoomLayout, cmd: InputCmd, tut: TutorialState): void {
    this.pruneTelegraphs(view);
    switch (tut.step) {
      case 'move':
        if (tut.marker) this.moveTo(cmd, me, tut.marker.x, tut.marker.z, 0.3);
        cmd.aim = Math.atan2(cmd.moveX, cmd.moveZ) || this.aim;
        break;
      case 'dash': {
        // Wait inside the announced lane and dash out of it at the last moment (i-frames carry us through).
        let lane: Tele | null = null;
        for (const t of this.telegraphs) if (t.shape === 'line' && insideTele(t, me.x, me.z, 0)) lane = t;
        if (!lane) {
          this.moveTo(cmd, me, BOT.TUTORIAL_STAND.x, BOT.TUTORIAL_STAND.z, 0.5);
          break;
        }
        cmd.aim = lane.rot + Math.PI;
        const left = (lane.lands - view.tick) * TICK_DT;
        if (left <= BOT.TUTORIAL_DASH_LEAD_SECONDS && me.dashCharges >= 1) {
          cmd.moveX = Math.cos(lane.rot);
          cmd.moveZ = -Math.sin(lane.rot);
          if ((this.lastButtons & BTN.DASH) === 0) cmd.buttons |= BTN.DASH;
        }
        break;
      }
      case 'hazard': {
        const hz = room.hazards[0];
        let foe: EnemySnap | null = null;
        for (const e of view.enemies) if (e.hp > 0 && e.anim !== 'death') foe = e;
        if (!hz) break;
        // Keep the hazard between us and the foe, circling around its edge instead of crossing it.
        const hold = hz.r + BOT.TUTORIAL_HAZARD_STANDOFF;
        let wx = tut.marker ? tut.marker.x - hz.x : hold;
        let wz = tut.marker ? tut.marker.z - hz.z : 0;
        if (foe && Math.hypot(foe.x - hz.x, foe.z - hz.z) > 0.5) { wx = hz.x - foe.x; wz = hz.z - foe.z; }
        const want = Math.atan2(wx, wz);
        const rx = me.x - hz.x;
        const rz = me.z - hz.z;
        const rd = Math.hypot(rx, rz) || 1;
        const at = Math.atan2(rx, rz);
        const diff = angleDiff(want, at);
        const radial = Math.max(-1, Math.min(1, hold - rd));
        const turn = Math.abs(diff) < 0.15 ? 0 : Math.sign(diff);
        cmd.moveX = (rx / rd) * radial + Math.cos(at) * turn;
        cmd.moveZ = (rz / rd) * radial - Math.sin(at) * turn;
        if (!this.inRoom(room, me.x + cmd.moveX, me.z + cmd.moveZ, WORLD.PLAYER_RADIUS)) { cmd.moveX = (rx / rd) * radial; cmd.moveZ = (rz / rd) * radial; }
        cmd.aim = Math.atan2(-rx, -rz);
        break;
      }
      case 'secondary':
      case 'storm': {
        this.combat(view, me, room, cmd);
        let foe: EnemySnap | null = null;
        let foeD = Infinity;
        for (const e of view.enemies) {
          if (e.hp <= 0 || e.anim === 'death' || e.anim === 'spawn') continue;
          const d = Math.hypot(e.x - me.x, e.z - me.z);
          if (d < foeD) { foeD = d; foe = e; }
        }
        if (!foe || foeD <= 0.5) break;
        const dirX = (foe.x - me.x) / foeD;
        const dirZ = (foe.z - me.z) / foeD;
        // The targets stand still: walk up to them (ranged classes would otherwise keep their distance).
        if (foeD > BOT.TUTORIAL_CLOSE_RANGE) { cmd.moveX = dirX; cmd.moveZ = dirZ; }
        if (tut.step === 'secondary') {
          cmd.aim = Math.atan2(dirX, dirZ);
          cmd.aimDist = foeD;
          if (foeD <= BOT.TUTORIAL_STORM_DASH_RANGE && me.cdSecondary <= 0 && (this.lastButtons & BTN.SECONDARY) === 0) cmd.buttons |= BTN.SECONDARY;
        } else if (foeD <= BOT.TUTORIAL_STORM_DASH_RANGE && me.dashCharges >= 1 && (foe.flags & EF.SHOCK) === 0) {
          // Dash straight through the foe so the infused dash marks it.
          cmd.moveX = dirX;
          cmd.moveZ = dirZ;
          if ((this.lastButtons & BTN.DASH) === 0) cmd.buttons |= BTN.DASH;
        }
        break;
      }
      default:
        this.combat(view, me, room, cmd);
        break;
    }
  }
}

/** Builds a bot's view straight from a World (no network, no quantisation). */
export function viewFromWorld(world: World, slot: number, shared?: Pick<BotView, 'players' | 'enemies' | 'projectiles' | 'run'>): BotView {
  const body = shared ?? { ...world.getSnapshotBody(), run: world.getRunState() };
  const hero = world.hero(slot);
  return {
    tick: world.tick, slot, cls: hero ? hero.cls : 'knight', players: body.players, enemies: body.enemies, projectiles: body.projectiles, run: body.run,
    art: hero ? hero.build.art : 0, keystones: hero ? hero.keystones : [],
  };
}
