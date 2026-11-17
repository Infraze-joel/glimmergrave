/** Server-side entry of the simulation. The client must only import ./movement.ts (prediction). */
export { World } from './world.ts';
export { Rng } from './rng.ts';
export { BotBrain, viewFromWorld, type BotView } from './bot.ts';
export { SIM, AI, DIRECTOR, BIOME, META, TUTORIAL } from './tuning.ts';
export {
  generateRoom, composeWave, waveBudget, findSpawnPoint, doorPositions, biomeOfChamber, bossOfChamber, hasHazardFreeRoutes,
  type RunOverrides,
} from './director.ts';
export { computeMeta, maxMetaLevels, noMetaLevels, baseReward, heroReward } from './meta.ts';
export { MATRON_CD } from './matron.ts';
export { STALKER_CD } from './stalker.ts';
export { tutorialRoom } from './tutorial.ts';
export { HAZARD_PHASE } from './hazardFx.ts';
export { generateDraft, computeStats, applyBoon, isOfferable, boonLevel } from './boons.ts';
export { sanitizeInput } from './players.ts';
export type { Hero, Enemy, Projectile, BoonStats } from './state.ts';
export * from './movement.ts';
