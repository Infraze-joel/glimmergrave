/** Server-side entry of the simulation. The client must only import ./movement.ts (prediction). */
export { World } from './world.ts';
export { Rng } from './rng.ts';
export { BotBrain, viewFromWorld, type BotView } from './bot.ts';
export { SIM, AI, DIRECTOR } from './tuning.ts';
export { generateRoom, composeWave, waveBudget, findSpawnPoint, doorPositions } from './director.ts';
export { generateDraft, computeStats, applyBoon, isOfferable, boonLevel } from './boons.ts';
export { sanitizeInput } from './players.ts';
export type { Hero, Enemy, Projectile, BoonStats } from './state.ts';
export * from './movement.ts';
