/**
 * Dev-only autopilot (`?autopilot` in `vite dev`): plays the own hero with the same scripted brain the bot
 * clients use, fed from decoded snapshots. Used for demos, soak runs and browser end-to-end tests.
 */
import { BotBrain } from '@shared/sim/bot.ts';
import type { InputCmd, Snapshot } from '@shared/types.ts';
import { bus } from '../core/EventBus.ts';
import { selfRoster, state } from '../core/GameState.ts';

const PICK_DELAY_MS = 700;

export interface Autopilot {
  think(snap: Snapshot): InputCmd | null;
}

export function createAutopilot(): Autopilot {
  let brain: BotBrain | null = null;
  let tick = 0;
  bus.on('game:event', (event) => brain?.observe([event], tick));
  bus.on('state:draft', () => {
    if (state.draft.length === 0 || !brain) return;
    const index = brain.chooseBoon(state.draft, selfRoster()?.boons ?? []);
    window.setTimeout(() => { if (state.draft.length > 0) bus.emit('ui:pick', { index }); }, PICK_DELAY_MS);
  });
  return {
    think(snap: Snapshot): InputCmd | null {
      const me = selfRoster();
      const run = state.run;
      if (!me || !run) return null;
      if (!brain || brain.slot !== me.slot) brain = new BotBrain(me.slot, me.cls, 7);
      brain.cls = me.cls;
      tick = snap.tick;
      return brain.think({ tick: snap.tick, slot: me.slot, cls: me.cls, players: snap.players, enemies: snap.enemies, projectiles: snap.projectiles, run });
    },
  };
}
