# State

- Phase: release candidate for update 4 "Objectives and the Horde" on branch `update-4`, which contains
  update 3 (`update-3`, spec `docs/milestones/update-3.md`). Spec: `docs/milestones/update-4.md`. Quality gate
  passed locally: typecheck, lint, 509 unit/integration tests, 20 browser tests on the production build.
- Last session: update 3 (seven classes, ultimates, umbra and reactions, mastery, Ascension, relics, Chronicle,
  endless descent, aim cursor), then update 4 (objectives, five enemy kinds, wards), each as a contract plus
  four work streams (sim/server, render, UI, audio) and an integration pass with live bot sessions.
- Contract changes of update 4 (all consumers updated): `ENEMY_KINDS` +5, `OBJECTIVE_KINDS`, `Door.objective`,
  `ObjectiveState`, `RunState.objective/objectivesDone/objectiveBonuses`, `spawn.ward/raisedBy`, events
  `objective`, `dome`, `mend`, `warded`, `interrupt`; new `data/objectives.ts`. Update 3's are listed in git
  history (`Contract for update 3`). Client core: `Settings.cursor`, `game:progress`, `game:localAction.slot`.
- QA aids: server env `DEBUG_START_CHAMBER`, `DEBUG_OBJECTIVE`; `botClient --objectives --descend --meta max`;
  dev client `?autopilot&descend=N`; `tests/e2e/tools/deep-run.mjs`.
- Polish 1 (branch `polish-1`, spec `docs/milestones/polish-1.md`) is integrated on top of update 4: clarity
  levels (`Settings.effects`, `allyNumbers`, `WorldView.setClarity/setLabels/setAim/setTraits`), contract
  additions `Obstacle.kind` shard/ritualBowl/reliquary, `RunState.traits`, `RosterEntry.relics/talents`,
  `ui:labels`. Gate: 529 unit/integration tests, 20 browser tests, one live bot session.
- Not done: human playtest of updates 3 and 4, listening pass, real GPUs, Firefox/Edge, deployment of both.
- Next concrete step: owner deploys `update-3` or `update-4` to a Netlify preview and plays.
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

## Backend, update 4

Simulation and server for update 4 "Objectives and the Horde" (spec: `docs/milestones/update-4.md`; measured numbers
and what could not be verified: `/home/claude/reports/backend-update4.md`). Verified with `tsc -p shared`,
`tsc -p server`, `eslint shared server`, `vitest run`, both server builds and a bot smoke test against the built
server in which a party that prefers special objectives plays a whole run.

- New sim files: `sim/objectives.ts` (door rolls, placement of shard / braziers / reliquary, the live
  `ObjectiveState`, bonus, counters) and `sim/horde.ts` (shaman, aegis, bomber, necromancer, reaver). The chamber
  flow stays in `sim/director.ts`: `enterChamber(w, index, door, objective)`, `director.obj` (bookkeeping),
  timed groups for survive / ritual (`sendGroup`), `queueGroup` (wards, siege share), `composeWave(..., standing)`.
- Objectives: slay and defend use waves; hunt is one wave (marked elites first); survive, ritual and vault have
  `waveCount 0` (`wave` counts the groups sent). Survive / ritual / vault end by themselves: everything crumbles,
  `objective done`, and the chamber is cleared `DIRECTOR.CLEAR_DELAY` later. The others emit `done` together with
  `chamberClear`. The survive bonus is lost the moment a hero is down. `ObjectiveState.timeLeft` also counts the
  ritual's bonus limit. The vault's reliquary is `ObjectiveState.anchor` with `hp 1`; `progress` is the hold.
  The training session has `objective: null`.
- The shard, the braziers and the reliquary are not obstacles (nothing collides with them).
- Run state: `World.objectiveLive` is true while a special objective is active; `Room` then re-sends `run` every
  `SERVER.RUN_BROADCAST_TICKS` (about 4 per second), as it already did during draft and doors.
- Wards: precise rule above `wardedAgainst` in `sim/combat.ts`. A share of every group from chamber 4 on, one random
  element per enemy, never the whole group, never bosses, champions or summoned minions. No snapshot flag is free:
  the ward is only in the `spawn` event (like affixes).
- Events without a world at hand: `interrupt` is sent by the enemy's next step (same tick for hero hits).
- Sim-only rules added while balancing (all in `sim/tuning.ts`): an enemy can be mended `AI.SHAMAN.MAX_MENDS` (2)
  times; shamans are capped alive like aegis and necromancers; support kinds take at most 40 % of a wave's budget;
  survive / ritual groups stop while more than `OBJECTIVE.MAX_ALIVE_BUDGET` wave budgets stand and count every
  capped kind that is alive; a brazier takes `1 + (party - 1)` times as long in a party; marked hunt elites have
  `OBJECTIVE.HUNT_HP_MUL` (3) times the health of an elite.
- Numbers changed in contract data (no shape, id or order changed): costs of shaman 4 -> 3, aegis 5 -> 4,
  necromancer 5 -> 4; `OBJECTIVE_TUNING` SURVIVE.BUDGET_FRACTION 0.45, DEFEND.HP 520 / ATTACKER_SHARE 0.3 /
  REPAIR_PER_SECOND 0.02, HUNT.SECONDS 45, RITUAL.BONUS_SECONDS 60 / BUDGET_FRACTION 0.4.
- Tools: `RunOverrides.objective` pins the first door's objective (`slay` pins every door: a classic run); server
  option `debugObjective` / env `DEBUG_OBJECTIVE`; bot option `preferObjectives` (`botClient --objectives`);
  balance soak `npx tsx --tsconfig server/tsconfig.json shared/test/tools/soak4.ts [seeds] [solo|party|max|maxparty] [mixed|prefer|classic]`.
- Known limits: bots do not repair the shard on purpose and a solo bot saves it in well under half of the
  chambers; ranged bots cannot shoot past the front line at a shaman; no reconnecting client learns wards or
  affixes of enemies that are already standing; the shard can be walked through.

## Backend, polish 1

Simulation and server for polish 1 (spec: `docs/milestones/polish-1.md`; numbers, before/after tables and what could
not be verified: `/home/claude/reports/backend-polish1.md`).

- **Fixtures are solid.** `beginObjective` (sim/objectives.ts) appends the bell shard (`shard`, r = `DEFEND.RADIUS`),
  one `ritualBowl` per brazier (r = `OBJECTIVE.RITUAL_BOWL_RADIUS` 0.6, in the centre of the 2.4 m circle) and the
  `reliquary` (r = `OBJECTIVE.VAULT_RADIUS`) to `room.obstacles`, after the generated obstacles, inside
  `enterChamber` — so the first `run` message of the chamber already carries them. They stay until the party
  leaves the room (also when the shard is shattered) and the next room starts without them. Everything that walks
  uses `resolveCollisions` of `sim/movement.ts` (unchanged), so prediction collides too. Shots do not: projectiles,
  lines of sight and arrow telegraph lengths skip fixture kinds (`sim/fixtures.ts`, `blocksShots`).
- Placement: a fixture is only put where every spawn still reaches every door and the ground around the fixture
  without touching an obstacle or hazard (`hasHazardFreeRoutes(room, around)`), and `OBJECTIVE.FIXTURE_LANE` (1.2 m)
  stays free to every obstacle and wall. Enemy steering does not avoid an obstacle that contains its destination
  (siege enemies walk up to the shard). Bots walk along an obstacle's edge when their way is blocked
  (`BotBrain.steerAround`; not while dodging a telegraph, not for the fixture they want to stand next to).
- **`RunState.traits`** is built in `World.getTraits()` from the living enemies every time a run state is
  published (no bookkeeping, no extra messages, `runVersion` is not bumped by spawns or deaths). A client that
  (re)joins gets the current list with its first `run` message; everyone else gets it with every `run` message
  (structural changes; about 4 per second in special objectives). Clients should merge it with what `spawn`
  announced, not wait for it.
- **`RosterEntry.relics` / `.talents`**: counted from the build the simulation applies (`Room.adoptBuild`).
- **Ultimate charge**: `ULTIMATE.PARTY_FALLOFF` 0.15 — charge from damage dealt, damage taken and Resonances is
  divided by `1 + 0.15 x (heroes in the chamber - 1)` (`partyChargeScale`, uses `World.partySize`). Solo unchanged.
- **Relic shards in cursed chambers**: `RELIC_TUNING.DROP_CURSED_ELITE` 0.02 per elite-flagged rank-and-file enemy
  slain by a hero (not summoned, not crumbled), every hero rolls, at most `CURSED_SHARDS_PER_CHAMBER` (1) per hero
  and chamber (`Hero.cursedShards`, `rollCursedShard` in sim/loot.ts, own loot stream as before).
- Numbers changed (no id or order changed; new keys are listed in the report): `OBJECTIVE_TUNING` SURVIVE
  SPAWN_INTERVAL 5 -> 6 and BUDGET_FRACTION 0.45 -> 0.4; RITUAL SPAWN_INTERVAL 6 -> 7 and DECAY 0.35 -> 0.25;
  DEFEND HP 520 -> 600 and new SOLO_HP_MUL 1.3; HUNT new SECONDS_PER_EXTRA_PLAYER 5 (`huntSeconds`); knight maxHp
  125 -> 135 and slashes 18 / 18 / 31 -> 19 / 19 / 33; `DIRECTOR.DAMAGE_PER_EXTRA_PLAYER` 0.15 -> 0.1 (sim/tuning.ts,
  offsets the charge falloff for fresh parties).
- Tools: `shared/test/tools/soakp1.ts [seeds] [solo|party|max|maxparty] [mixed|prefer|classic|cursed] [classes]`
  (win rate, ultimates per hero, shards per hero, objective table with the share of chambers that ended a run);
  bot option `preferCursed` (`RunOptions.preferCursed` in the test harness).
- Known limits: a reaver in the air and a boss charge fly in a straight line over obstacles as before (they land
  outside); bots still do not repair the shard on purpose; defend ends a party's run about 2.6 times as often per
  chamber as slay; a last hero standing against necromancers can take very long (438 s in one of 300 party runs);
  bots never choose talents or relics; depth 2+ and Oaths above 0 were not measured.
