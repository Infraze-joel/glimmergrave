/**
 * The audio module's own clock for an objective timer (update 4).
 *
 * `RunState.objective.timeLeft` arrives a few times per second, late by the network delay and with jitter. Ticking
 * from those values directly would stutter. So the first value fixes a deadline on the audio clock and the ticks
 * are scheduled against that deadline, sample-accurately and a little ahead of time. Later values only move the
 * deadline when they must:
 *   - a value that puts the end *earlier* (by less than RESYNC_S) is adopted: every report is late by its delay,
 *     so the earliest estimate is the best one. This can only tighten, it cannot wander;
 *   - a value off by more than RESYNC_S in either direction (the timer was changed, the tab slept, the server
 *     stalled) re-anchors the clock;
 *   - anything else is ignored. Between reports nothing drifts: there is one deadline and one clock.
 * No tick is ever sounded twice or closer than MIN_GAP_S to the one before, whatever the reports do.
 */
import type { ObjectiveKind } from '@shared/types.ts';

export const CLOCK = {
  /** Disagreement between a report and the running clock beyond which the clock is re-anchored (s). */
  RESYNC_S: 0.4,
  /** Ticks are handed out this long before they sound (s); must exceed the scheduler period. */
  LOOKAHEAD_S: 0.2,
  /** A tick whose time passed longer ago than this is skipped, not played late (s). */
  LATE_S: 0.05,
  /** Two ticks never follow each other faster than this (s). */
  MIN_GAP_S: 0.5,
} as const;

export interface ClockTick {
  /** Whole seconds left when the tick sounds. */
  left: number;
  /** Audio time at which it sounds. */
  at: number;
  kind: ObjectiveKind;
}

export type ObjectiveClock = ReturnType<typeof createObjectiveClock>;

/** `span` = how many last seconds are ticked (ticks for `span`, `span - 1`, ... 1 seconds left). */
export function createObjectiveClock(span: number) {
  let deadline: number | null = null;
  let kind: ObjectiveKind = 'slay';
  /** Seconds-left value of the next tick to hand out. */
  let next = 0;
  let lastAt = -Infinity;
  let resyncs = 0;

  return {
    /** A report from the server: `timeLeft` seconds remain at audio time `now`. */
    sync(now: number, timeLeft: number, objective: ObjectiveKind): void {
      const estimate = now + timeLeft;
      if (deadline === null || objective !== kind || Math.abs(estimate - deadline) > CLOCK.RESYNC_S) {
        if (deadline !== null) resyncs++;
        deadline = estimate;
        kind = objective;
        next = Math.min(span, Math.floor(timeLeft + CLOCK.LATE_S));
      } else if (estimate < deadline) {
        deadline = estimate;
      }
    },
    /** The timer is gone (objective done, bonus lost, chamber left). */
    stop(): void {
      deadline = null;
      next = 0;
    },
    /** Ticks that are due before `now + LOOKAHEAD_S`, each exactly once. */
    due(now: number): ClockTick[] {
      const out: ClockTick[] = [];
      if (deadline === null) return out;
      while (next >= 1 && deadline - next < now + CLOCK.LOOKAHEAD_S) {
        const at = deadline - next;
        if (at >= now - CLOCK.LATE_S && at - lastAt >= CLOCK.MIN_GAP_S) {
          out.push({ left: next, at: Math.max(at, now), kind });
          lastAt = at;
        }
        next--;
      }
      return out;
    },
    /** Seconds left by this clock, or null when no timer runs. */
    left(now: number): number | null {
      return deadline === null ? null : Math.max(0, deadline - now);
    },
    resyncs: (): number => resyncs,
  };
}
