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

## Backend, update 3

Simulation and server for update 3 "The Endless Descent". Verified with `tsc -p shared`, `tsc -p server`,
`eslint shared server`, `vitest run`, both server builds and a bot smoke test against the built server (see
`/home/claude/reports/backend-update3.md` for the measured numbers and what could not be verified).

- New sim files: `sim/build.ts` (loadout -> `HeroBuild`, the `Mods` pipeline, abilities after class boons and
  `area`), `sim/zones.ts` (zone / trap shapes, sanctuary, smoke, delayed hostile blasts), `sim/loot.ts` (relic
  shard rolls). `sim/combat.ts` holds Wither, the six reactions, the ultimate charge, affix effects on damage.
- One `Mods` per hero (`hero.mods`): Armory (`metaMods`) + Ascension + `masteryMods` + talents + relics
  (`hero.perm`, uncapped) + active set tiers + boon mods (stoneskin, zealot), then `capMods`. Recomputed by
  `refreshHero` whenever a boon is picked. `MetaStats` keeps only what is not a mod (rerolls, attunement, resolve,
  foresight, tenacity). Training sessions use a plain hero (no permanent bonus of any kind).
- `World.addPlayer(slot, cls, name, loadout?)` takes a (partial) `Loadout` or, as before, the list of upgrade
  levels; `setLoadout`, `setClass(slot, cls, loadout?)`, `getBuild`. Everything is clamped again in the sim with
  `sanitizeLoadout`. A class change without a loadout keeps upgrades, Ascension and relics and resets mastery, art
  and talents. `Room` stores the clamped mastery / art in the session for the roster.
- Abilities: `hero.abil` = primary chain, equipped secondary (`secondaryOf`), ultimate. `leap` moves the hero as a
  dash (`SelfState.dashTime / dashDir`, DASH.SPEED) during the last `distance / DASH.SPEED` seconds of the windup
  and is rooted before and after, exactly like `lunge` after its windup; nothing new in `movement.ts`.
- Ultimate: `BTN.ULTIMATE` (buffered press) with `hero.ult >= ULTIMATE.MAX`; charge from strikes (not from the
  ultimate itself), damage taken and Resonances; kept between chambers and depths; `ultReady` once per fill.
- Descent: a dead final boss clears the chamber (draft), then doors `descend` (left) and `ascend` (right).
  `descend` -> `RunState.depth + 1`, `planDescent` (new final boss != the last one, herald, biomes), heal, `descend`
  event, `enterChamber(0, 'descend')`. `ascend` -> `victory`. Rewards exist only in `victory` / `defeat`.
- Rewards: `director.earnings` accumulates every payment with the depth bonus of the moment it is earned;
  `finishRun` applies Oath, compass and the hero's `glimmer` / `xp` mods. Relic shards: champion (DROP_ELITE),
  herald, final boss; rolled for every hero from `world.lootRng` (seeded from the run seed, separate stream).
- Affixes: elites (elite-flagged rank and file) and champions, when `depth >= AFFIX_FROM_DEPTH` or
  `oath >= AFFIX_FROM_OATH`; numbers in `AFFIX` (sim/tuning.ts). Talent numbers in `TALENT` (sim/tuning.ts).
- Extra `cast` ability ids: `voidarc` (one per leap, at the struck enemy), `storm_coil`, `phoenix`.
- Tuning changed while balancing: `ULTIMATE.PER_DAMAGE_DEALT` 0.04 (was 0.055), `PER_DAMAGE_TAKEN` 0.3 (0.35);
  `RUN.HP_GROWTH_PER_CHAMBER` 0.3 (0.22), `DAMAGE_GROWTH_PER_CHAMBER` 0.2 (0.12), `HP_PER_EXTRA_PLAYER` 0.85 (0.56),
  `RUN.DEPTH.HP_STEP` 1.4 (0.75), `DAMAGE_STEP` 0.8 (0.4); `ENEMY_TUNING.BOSS_HP_PER_EXTRA_PLAYER` 1.3 (1.0);
  `DIRECTOR.DAMAGE_PER_EXTRA_PLAYER` 0.15 (0); `BUFFS.bloodrage` 0.3 / 0.25 / 0.2 / 4; templar, spellblade, shade
  and the rogue ultimate (see the report). No exported shape, id or array order was changed.
- `BOONS` has 80 entries (the milestone text says 82).
- Balance tools: `npx tsx --tsconfig server/tsconfig.json shared/test/tools/soak3.ts [seeds] [solo|party|max|maxparty|depth]`.
- Bot client: `--cls` accepts all seven classes, `--meta max` also claims mastery 10 / art 1 / talents 1,
  `--descend [N]`, `--oath 0-20`; `BotClient.onEvents`.
- Known limits: a maxed hero wins depth 0 at Oath 0 every time (its challenge is depth and Oath); relic shards do
  not drop from elite-flagged rank and file (only champion, herald, final boss); Wither leech emits one `heal`
  event per hit; bots never choose a cursed door and do not pick talents or relics by themselves.
