import { describe, expect, it } from 'vitest';
import { CLOCK, createObjectiveClock } from '../../client/src/audio/objective-clock.ts';
import { hordeCast } from '../../client/src/audio/sfx-horde.ts';

const SPAN = 10;
const FRAME = 0.025;

/** Runs the clock like the audio scheduler does and returns every tick it handed out. */
function run(reports: (now: number) => number | null, from: number, to: number) {
  const clock = createObjectiveClock(SPAN);
  const ticks: { left: number; at: number }[] = [];
  for (let now = from; now <= to; now += FRAME) {
    const timeLeft = reports(now);
    if (timeLeft !== null) clock.sync(now, timeLeft, 'survive');
    for (const tick of clock.due(now)) ticks.push({ left: tick.left, at: tick.at });
  }
  return { ticks, clock };
}

describe('objective timer clock (audio)', () => {
  it('ticks the last ten seconds once each, exactly one second apart, ending one second before the deadline', () => {
    // true deadline at t = 30; reports every 0.25 s, each late by 40..110 ms (network), as the server would send them
    let n = 0;
    const { ticks, clock } = run((now) => {
      if (Math.abs(now / 0.25 - Math.round(now / 0.25)) > 1e-6) return null;
      const delay = 0.04 + 0.07 * ((n++ * 7919) % 13) / 13;
      const left = 30 - (now - delay);
      return left > 0 ? left : null; // the audio module stops syncing once the timer shows 0
    }, 5, 31);
    expect(ticks.map((t) => t.left)).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    for (let i = 1; i < ticks.length; i++) expect(ticks[i].at - ticks[i - 1].at).toBeGreaterThan(1 - 0.08);
    for (let i = 1; i < ticks.length; i++) expect(ticks[i].at - ticks[i - 1].at).toBeLessThan(1 + 0.001);
    // the clock settles on the least delayed report: never earlier than the truth, at most the smallest delay late
    const last = ticks[ticks.length - 1];
    expect(last.at).toBeGreaterThanOrEqual(29 - 1e-9);
    expect(last.at).toBeLessThan(29 + 0.05);
    expect(clock.resyncs()).toBe(0);
  });

  it('does not drift when reports stop: the deadline stays where it was anchored', () => {
    const { ticks } = run((now) => (now < 12.01 ? 20 - now : null), 9, 21);
    expect(ticks.map((t) => t.left)).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    ticks.forEach((t) => expect(t.at).toBeCloseTo(20 - t.left, 6));
  });

  it('starts in the middle when the timer is already below ten seconds, without playing missed ticks late', () => {
    const { ticks } = run((now) => (Math.abs(now - 0) < 1e-9 ? 4.3 : null), 0, 5);
    expect(ticks.map((t) => t.left)).toEqual([4, 3, 2, 1]);
    expect(ticks[0].at).toBeCloseTo(0.3, 6);
  });

  it('re-anchors when the timer jumps, and never ticks twice within MIN_GAP_S', () => {
    // at t = 5 the timer (deadline 10) is pushed back by 0.7 s
    const { ticks, clock } = run((now) => (now < 5 ? 10 - now : 10.7 - now), 0, 11);
    expect(clock.resyncs()).toBe(1);
    for (let i = 1; i < ticks.length; i++) expect(ticks[i].at - ticks[i - 1].at).toBeGreaterThanOrEqual(CLOCK.MIN_GAP_S);
    expect(ticks[ticks.length - 1].left).toBe(1);
    expect(ticks[ticks.length - 1].at).toBeCloseTo(9.7, 6);
  });

  it('is silent after stop()', () => {
    const clock = createObjectiveClock(SPAN);
    clock.sync(0, 3, 'hunt');
    expect(clock.due(0).map((t) => t.left)).toEqual([3]);
    clock.stop();
    expect(clock.due(5)).toEqual([]);
    expect(clock.left(5)).toBeNull();
  });
});

describe('enemy cast ids of the update 4 kinds (audio)', () => {
  it('maps the sim ids to their channels and leaves the older casts alone', () => {
    expect(hordeCast('mend')).toBe('mend');
    expect(hordeCast('raise')).toBe('raise');
    expect(hordeCast('fuse')).toBe('fuse');
    expect(hordeCast('reaver_leap')).toBe('leap');
    expect(hordeCast('shaman_mend')).toBe('mend');
    for (const id of ['leap', 'stalker_leap', 'regent_summon', 'blink', 'matron_beam', 'frenzy', '']) expect(hordeCast(id)).toBeNull();
  });
});
