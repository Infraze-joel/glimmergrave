/** Helpers shared by the update 3 test files. */
import { expect } from 'vitest';
import { ULTIMATE } from '@shared/data/classes.ts';
import { MASTERY } from '@shared/data/mastery.ts';
import { META_INDEX, META_UPGRADES, PARAGON } from '@shared/data/meta.ts';
import { applyBoon, World, type Hero } from '@shared/sim/index.ts';
import { BTN, type ClassId, type GameEvent, type InputCmd, type Loadout } from '@shared/types.ts';
import { Pad, place, seconds } from './harness.ts';

export type Ev<K extends GameEvent['e']> = Extract<GameEvent, { e: K }>;
export const of = <K extends GameEvent['e']>(events: GameEvent[], kind: K): Ev<K>[] => events.filter((ev): ev is Ev<K> => ev.e === kind);

export const metaLevels = (levels: Record<string, number>): number[] => {
  const out = META_UPGRADES.map(() => 0);
  for (const [id, level] of Object.entries(levels)) {
    const index = META_INDEX.get(id);
    if (index === undefined) throw new Error(`unknown upgrade ${id}`);
    out[index] = level;
  }
  return out;
};

export const paragonRanks = (ranks: Record<string, number>): number[] => PARAGON.map((p) => ranks[p.id] ?? 0);

/** A mastered loadout: level 10 unlocks the art and every talent tier. */
export const mastered = (over: Partial<Loadout> = {}): Partial<Loadout> => ({ mastery: MASTERY.TALENT_LEVELS[2], ...over });

export interface Arena {
  w: World;
  h: Hero;
  pad: Pad;
}

/** Sandbox world (no director) with one hero at the origin; `loadout` as World.addPlayer takes it. */
export function arena(cls: ClassId, loadout?: unknown, seed = 1): Arena {
  const w = new World();
  expect(w.addPlayer(0, cls, 'T', loadout)).toBe(true);
  w.startSandbox(seed);
  place(w, 0, 0, 0);
  return { w, h: w.hero(0) as Hero, pad: new Pad(w) };
}

/** Sandbox world with several heroes (slot = index), each with its own loadout. */
export function party(classes: ClassId[], loadouts: unknown[] = [], seed = 1): World {
  const w = new World();
  classes.forEach((cls, slot) => expect(w.addPlayer(slot, cls, `H${slot}`, loadouts[slot])).toBe(true));
  w.startSandbox(seed);
  return w;
}

export const give = (h: Hero, ...ids: string[]): Hero => {
  for (const id of ids) expect(applyBoon(h, id), id).toBeGreaterThan(0);
  return h;
};

/** Presses `buttons` once (cooldowns and locks cleared first) and keeps stepping for `secs` seconds. */
export function use(a: Arena, buttons: number, secs: number, extra: Partial<InputCmd> = {}): GameEvent[] {
  const { h, pad } = a;
  h.primaryCd = 0;
  h.secondaryCd = 0;
  h.lockTime = 0;
  h.comboIndex = 0;
  h.body.rootTime = 0;
  if (buttons & BTN.ULTIMATE) h.ult = ULTIMATE.MAX;
  const ev = pad.hold({ aim: 0, ...extra, buttons }, 1);
  ev.push(...pad.hold({ aim: 0, ...extra }, seconds(secs)));
  return ev;
}

/** Total damage of the `hit` events on one enemy. */
export const damageOn = (events: GameEvent[], id: number): number =>
  of(events, 'hit').filter((x) => x.target.t === 'e' && x.target.id === id).reduce((sum, x) => sum + x.dmg, 0);
