/**
 * Applies floor hazards. Whether a hazard is idle, warning or active comes from hazardState() and the world tick
 * alone (the client draws from the same function), so nothing here is random. While a hazard is active it strikes
 * everything standing on it at a fixed rhythm, starting with the tick it turns active.
 */
import { TICK_DT } from '../constants.ts';
import { HAZARD } from '../data/enemies.ts';
import type { ElementId, Hazard } from '../types.ts';
import { damageHero, isTargetable, rawDamageEnemy, setStatus } from './combat.ts';
import { hazardState, type HazardState } from './hazards.ts';
import type { World } from './world.ts';

/** Codes stored in World.hazardPhase. */
export const HAZARD_PHASE = { IDLE: 0, WARN: 1, ACTIVE: 2 } as const;

const scratch: HazardState = { phase: 'idle', t: 0 };

function strike(w: World, hz: Hazard): void {
  const r2 = hz.r * hz.r;
  const cfg = hz.kind === 'spikes' ? HAZARD.SPIKES : hz.kind === 'vent' ? HAZARD.VENT : HAZARD.FROST;
  for (const h of w.heroes) {
    const dx = h.body.x - hz.x;
    const dz = h.body.z - hz.z;
    // damageHero refuses downed, disconnected and invulnerable (dashing) heroes.
    if (dx * dx + dz * dz > r2 || !damageHero(w, h, cfg.DAMAGE, -1)) continue;
    w.emit({ e: 'hazardHit', target: { t: 'p', id: h.slot }, kind: hz.kind });
    if (h.state !== 'alive') continue;
    if (hz.kind === 'vent') {
      if (h.burnTime <= 0) h.burnTimer = HAZARD.VENT.BURN_TICK;
      h.burnTime = HAZARD.VENT.BURN_SECONDS;
    } else if (hz.kind === 'frost') {
      h.chillTime = HAZARD.FROST.CHILL_SECONDS;
    }
  }
  const element: ElementId | null = hz.kind === 'vent' ? 'ember' : hz.kind === 'frost' ? 'rime' : null;
  const damage = cfg.DAMAGE * HAZARD.ENEMY_DAMAGE_MUL * w.hpMul;
  for (const e of w.enemies) {
    // Bosses and champions shrug hazards off entirely.
    if (e.boss || !isTargetable(e)) continue;
    const dx = e.x - hz.x;
    const dz = e.z - hz.z;
    if (dx * dx + dz * dz > r2) continue;
    w.emit({ e: 'hazardHit', target: { t: 'e', id: e.id }, kind: hz.kind });
    if (w.tutorial) w.tutorial.hazardHits++;
    rawDamageEnemy(w, e, damage, -1, element);
    // The hazard marks its victims (so a hero can detonate them) but never overwrites a hero's element.
    if (element && !e.dead && (e.status === null || e.status === element)) setStatus(w, e, element, null, 1);
  }
}

export function stepHazards(w: World): void {
  const hazards = w.room.hazards;
  if (w.hazardRoom !== w.room) {
    w.hazardRoom = w.room;
    w.hazardPhase.length = hazards.length;
    w.hazardTicks.length = hazards.length;
    w.hazardPhase.fill(0);
    w.hazardTicks.fill(0);
  }
  let live = 0;
  const combat = w.run.phase === 'combat';
  for (let i = 0; i < hazards.length; i++) {
    const hz = hazards[i] as Hazard;
    hazardState(hz, w.tick, scratch);
    if (scratch.phase === 'idle') {
      w.hazardPhase[i] = HAZARD_PHASE.IDLE;
      w.hazardTicks[i] = 0;
      continue;
    }
    live++;
    if (scratch.phase === 'warn') {
      w.hazardPhase[i] = HAZARD_PHASE.WARN;
      w.hazardTicks[i] = 0;
      continue;
    }
    w.hazardPhase[i] = HAZARD_PHASE.ACTIVE;
    const ticks = w.hazardTicks[i] as number;
    w.hazardTicks[i] = ticks + 1;
    const tick = hz.kind === 'spikes' ? HAZARD.SPIKES.TICK : hz.kind === 'vent' ? HAZARD.VENT.TICK : HAZARD.FROST.TICK;
    if (combat && ticks % Math.max(1, Math.round(tick / TICK_DT)) === 0) strike(w, hz);
  }
  w.hazardsLive = live;
}
