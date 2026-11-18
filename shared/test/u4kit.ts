/** Helpers shared by the update 4 test files. */
import { killEnemy } from '@shared/sim/combat.ts';
import { isEndless } from '@shared/sim/objectives.ts';
import type { World } from '@shared/sim/index.ts';
import { seconds } from './harness.ts';

/**
 * Ends the current chamber by force whatever its objective is: heroes are untouchable, everything that stands is
 * slain every tick, and objectives that do not end by killing (survive, ritual, vault) are declared complete.
 */
export function finishChamber(w: World): void {
  for (let guard = 0; guard < seconds(120) && w.run.phase === 'combat'; guard++) {
    for (const h of w.heroes) h.invuln = 1;
    for (const e of w.enemies) if (!e.dead && e.spawnTime <= 0) killEnemy(w, e, 0);
    const obj = w.director.obj;
    if (obj && isEndless(obj.kind)) obj.complete = true;
    w.step();
  }
  w.drainEvents();
}
