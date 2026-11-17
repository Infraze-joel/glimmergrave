# Glimmergrave — rules for every agent working in this repository

Read `docs/gameplan.md` and `docs/tech.md` first. They are the source of truth; this file mirrors them.

- Run from the repo root: `npm run dev` (client :5173 + server :8787), `npm run typecheck`, `npm run lint`,
  `npm test`, `npm run build`. A change is not done until typecheck, lint and tests pass.
- The contract files are `shared/src/{constants,types,protocol}.ts`, `shared/src/data/*`,
  `shared/src/sim/movement.ts` and `client/src/core/*`. Do not change their exported shapes without updating
  every consumer and noting it in `docs/STATE.md`. Tuning numbers inside the data tables may be adjusted.
- Server authority: the client sends inputs/intents only. Validate everything that arrives from a socket.
- Client modules communicate only via `core/EventBus.ts` and `core/GameState.ts`.
- No magic numbers in logic; no `enum`, no parameter properties, no `any`; imports carry the `.ts` extension;
  shared code is imported via `@shared/...`.
- Animated GLB characters must be cloned with `SkeletonUtils.clone()`. Dispose geometries/materials/textures
  you create when a session ends. No per-frame allocations in hot loops (reuse temp vectors, pool objects).
- All user-visible text goes through `ui/i18n.ts` (English + German).
- Only CC0 / permissively licensed assets; record every source in `docs/ASSETS.md`.
- Load files under `/assets/` only through `assetUrl()` (`client/src/core/assetVersion.ts`). They are cached as
  immutable; an unversioned URL would serve old files to new code after a release.
- Load files under `/assets/` only through `assetUrl()` (`client/src/core/assetVersion.ts`). They are cached as
  immutable; an unversioned URL would serve old files to new code after a release.
- Never claim something works without running it. Write tests for gameplay rules before/with the code.
- Update `docs/STATE.md` at the end of every work session.
