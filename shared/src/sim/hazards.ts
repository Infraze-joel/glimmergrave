/**
 * Hazard cycle shared by server (applies effects) and client (draws them). Pure function of the tick.
 */
import { TICK_DT } from '../constants.ts';
import type { Hazard } from '../types.ts';

export const HAZARD_TIMING = {
  /** Seconds of ground warning before a hazard turns active. */
  WARN: 1.1,
  /** Seconds a hazard stays active (the rest of the period is idle). */
  ACTIVE: { spikes: 0.9, vent: 1.6, frost: 2.4 },
} as const;

export type HazardPhase = 'idle' | 'warn' | 'active';

export interface HazardState {
  phase: HazardPhase;
  /** 0..1 progress through the current phase. */
  t: number;
}

/** State of `hazard` at server tick `tick`. A cycle is: idle, then warn, then active (ending at the period). */
export function hazardState(hazard: Hazard, tick: number, out: HazardState = { phase: 'idle', t: 0 }): HazardState {
  const active = HAZARD_TIMING.ACTIVE[hazard.kind];
  const period = Math.max(hazard.period, active + HAZARD_TIMING.WARN + 0.5);
  const time = (((tick * TICK_DT) / period + hazard.phase) % 1) * period;
  const idle = period - active - HAZARD_TIMING.WARN;
  if (time < idle) { out.phase = 'idle'; out.t = time / idle; }
  else if (time < idle + HAZARD_TIMING.WARN) { out.phase = 'warn'; out.t = (time - idle) / HAZARD_TIMING.WARN; }
  else { out.phase = 'active'; out.t = (time - idle - HAZARD_TIMING.WARN) / active; }
  return out;
}
