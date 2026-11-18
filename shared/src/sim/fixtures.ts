/**
 * Objective fixtures (polish 1): the bell shard, a ritual brazier's bowl and the vault's reliquary are part of
 * `RoomLayout.obstacles`, so everything that walks collides with them. They are low enough to shoot over:
 * projectiles, lines of sight and the length of announced shots ignore them (as before they were solid).
 */
import type { Obstacle } from '../types.ts';

export const FIXTURE_KINDS: ReadonlySet<Obstacle['kind']> = new Set<Obstacle['kind']>(['shard', 'ritualBowl', 'reliquary']);

/** Does this obstacle stop projectiles and block lines of sight? (Everything but the objective fixtures.) */
export const blocksShots = (o: Obstacle): boolean => !FIXTURE_KINDS.has(o.kind);
