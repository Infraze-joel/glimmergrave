/** Server-side entry of the simulation. The client must only import ./movement.ts (prediction). */
export { World } from './world.ts';
export { Rng } from './rng.ts';
export { BotBrain, viewFromWorld, type BotView, type BotOptions } from './bot.ts';
export { SIM, AI, DIRECTOR, BIOME, META, TUTORIAL, TALENT, AFFIX, OBJECTIVE } from './tuning.ts';
export {
  generateRoom, composeWave, waveBudget, findSpawnPoint, doorPositions, biomeOfChamber, bossOfChamber, hasHazardFreeRoutes,
  type RunOverrides,
} from './director.ts';
export {
  computeMeta, metaMods, maxMetaLevels, noMetaLevels, baseReward, heroReward, earn, emptyEarnings, glimmerReward, xpReward,
  type Earnings,
} from './meta.ts';
export { sanitizeBuild, permanentOf, buildAbilities, maxBuild, MAX_BUILD_MASTERY } from './build.ts';
export { dropChance } from './loot.ts';
export { MATRON_CD } from './matron.ts';
export { STALKER_CD } from './stalker.ts';
export { tutorialRoom } from './tutorial.ts';
export { HAZARD_PHASE } from './hazardFx.ts';
export { generateDraft, computeStats, applyBoon, isOfferable, boonLevel } from './boons.ts';
export { sanitizeInput } from './players.ts';
export type { Hero, Enemy, Projectile, BoonStats, HeroBuild, Zone } from './state.ts';
export * from './movement.ts';
