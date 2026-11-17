# State

- Phase: release candidate for update 2 (meta upgrades, wardrobe, three bosses, biomes + hazards, training,
  codex, sample-based audio). All milestones in `docs/milestones/README.md` are done; quality gate passed locally.
- Last session: integrated backend, render kit, UI/audio; added browser e2e suite, QA start-chamber option,
  perf probe; wrote README.
- Hosting changed to single-origin Netlify Server (ADR 0002); verified with Netlify's bundler and local
  emulator only.
- Not done (needs credentials / hardware): deploy to Netlify, check `/ws/health`, then repeat README section 15
  with two machines over the internet; measure FPS on real GPUs; listen to the audio;
  test Firefox and Edge.
- Next concrete step: deploy the cache fix (branch `update-2`), reload the Netlify preview, run the two-client check.
- Deferred ideas live in `docs/backlog.md`.

## Fix after the first deploy of update 2: stale model cache

- Symptom on the deployed game: loading screen stops with `missing prop skel_quiver`.
- Cause: update 2 changed `props.glb`, `dungeon.glb` and `anims_skel.glb` under unchanged names while
  `netlify.toml` let browsers reuse `/assets/*` for a day without asking. A browser that had loaded release 1
  on the same address within that day combined the new code with the old `props.glb` (which has no quiver).
- Fix: every model and sound URL carries a content version (`?v=<hash>`), see rule 9 in `docs/tech.md`.
  New contract file `client/src/core/assetVersion.ts` (`ASSET_VERSION`, `assetUrl()`); consumers are
  `render/assets.ts` and `audio/samples.ts`. `/assets/*` is now `immutable`.
- Verified locally only: unit tests for the hash, an e2e test that every asset request is versioned, and an e2e
  test that primes a browser cache with a wrong `props.glb` under the old URL (fails without the fix, passes
  with it). Not yet confirmed on the Netlify deployment.

## Backend notes

- `World` (shared/src/sim/world.ts) is stepped by `Room` (server/src/room.ts) at 30 Hz; snapshots every 2 ticks.
- `startServer(opts)` (server/src/server.ts) is what tests use in-process; `main.ts` reads the environment.
- `bossPhase.phase` is 1-based (2 and 3 are emitted at the thresholds).
- Reviving is proximity-based; `BTN.INTERACT` exists in the protocol but is unused.

## Backend, update 2

Simulation and server for update 2 (permanent upgrades, three final bosses + herald, biomes and hazards, tutorial).
Verified with `tsc -p shared`, `tsc -p server`, `eslint shared server`, `vitest run`, both server builds and a bot
smoke test (run + tutorial) against the built server.

- New sim files: `sim/meta.ts` (upgrade levels -> stats, reward maths), `sim/matron.ts`, `sim/stalker.ts`,
  `sim/hazardFx.ts` (applies hazards; state still comes from the contract's `hazardState()`), `sim/tutorial.ts`.
  `sim/boss.ts` keeps Champion + Regent and what all bosses share (phases, announced ground attacks).
- Run plan: `World.start(oath, seed, startChamber?, overrides?)` draws final boss, herald and biome order from the
  seed first (`overrides` pins them for tests / the soak). `World.startTutorial(seed)` for training sessions.
- `World.addPlayer(slot, cls, name, meta?)`, `setMeta`, `getMeta`, `getRerolls`, `rerollDraft`. Upgrade levels
  are clamped again inside the sim. Training sessions ignore permanent upgrades.
- Attunement draft = phase `draft` in chamber 0 before the first wave (`director.preDraft`), then `combat`.
- Traps and beams are `telegraph` (+ `aoe` / `cast`) events and boss state only; soul wisps are ordinary projectile
  rows (`soulWisp`). Extra `cast` ability ids for the client: `matron_beam`, `leap`, `frenzy`, `wisp_pop`, `blink`.
- Hazard numbers are generated with at most 2 decimals so the JSON-rounded layout on the client is identical.
- Tuning changed while balancing (all in data tables): `RUN.HP_PER_EXTRA_PLAYER` 0.56, `COUNT_PER_EXTRA_PLAYER`
  0.3, `HP_GROWTH_PER_CHAMBER` 0.22, `DAMAGE_GROWTH_PER_CHAMBER` 0.12; wave budget 15 + 2.1 per chamber; rank and
  file health +10 %; Regent 2300 hp and slightly lower damage; bosses use `ENEMY_TUNING.BOSS_HP_PER_EXTRA_PLAYER`;
  **`META_UPGRADES` values of `vitality` (now 5..25) and `might` (now 3..15 %) were lowered** so that a fully
  upgraded solo hero wins about 80 % instead of nearly always.
- Balance soak: `npx tsx --tsconfig server/tsconfig.json shared/test/tools/soak.ts [seeds] [oath]`.
- Bot client: `--meta max`, `--tutorial`.
- Known limits: hero burn / chill from hazards has no snapshot flag (clients infer it from `hazardHit` and
  `HAZARD`); one solo Regent fight in the balance set lasted 190 s; ranged bots avoid hazards but only melee bots
  deliberately fight next to them.
