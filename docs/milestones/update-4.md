# Milestone 12 — Update 4: Objectives and the Horde

Owner request (after update 3): the moment-to-moment game lacks variety — "Kammern mit eigenem Ziel" and
"mehr Gegnertypen". This file is the specification; numbers live in `shared/src/data/objectives.ts` and
`shared/src/data/enemies.ts`.

## Objective

A run should no longer be eight times "kill all waves" against four enemy types. Combat chambers get one of
six objectives, shown on the doors so the party chooses, and five new enemy kinds plus element-warded foes
force different tactics.

## Scope

### Chamber objectives (`ObjectiveKind`, `RunState.objective`, `Door.objective`, `objective` event)

- **slay** — the classic chamber.
- **survive** — enemies keep spawning until the timer ends; then the remaining ones crumble. Bonus: nobody is
  downed when the timer ends.
- **defend** — a bell shard (anchor with health) stands in the room; a share of each wave attacks it. The
  chamber is cleared like `slay`. If the shard shatters the bonus is lost and the fight simply goes on.
  Heroes standing next to it slowly repair it.
- **hunt** — marked elites with an escort; kill the marked ones before the timer runs out (bonus), otherwise
  they enrage. The chamber ends when the marked elites are dead and the escort is cleared.
- **ritual** — three braziers; heroes standing in a circle light it (faster with more heroes, decays when
  left). Enemies keep spawning until all burn; then the rest crumbles. Bonus: done within the time limit.
- **vault** — no fight: the party walks in, opens the reliquary (stand next to it), gets a small heal,
  Glimmer and a richer draft. At most one per depth.
- A met bonus upgrades that chamber's draft (+1 choice, rare or better guaranteed) and pays Glimmer.
- The director rolls objectives per door from the seed (weights and `minChamber` in `OBJECTIVES`); the two
  doors of a choice never show the same special objective. Chamber 0 of depth 0, elite and boss chambers are
  `slay`. Door types (boon / blessing / cursed) and objectives combine freely, except `vault` (never cursed).
- The training session is unchanged (always `slay`).

### Enemies (`ENEMY_KINDS` + 5, `spawn.ward`, events `dome`, `mend`)

- **shaman** (support), **aegis** (ward dome), **bomber** (suicide runner), **necromancer** (raises minions),
  **reaver** (leaps onto the backline) — behaviour in the comment above `ENEMIES`, numbers in `ENEMY_TUNING`.
- **Warded** enemies: immune to one element's status and bursts, from chamber 4 on.
- Every dangerous action stays telegraphed (existing `telegraph` event). All new kinds are staggerable or
  killable counters; none may create unavoidable damage.
- The wave director uses the new kinds by cost and `minChamber`, never more than one aegis and one
  necromancer alive per two heroes, and never a wave of only support enemies.

## Acceptance criteria

- [ ] Each objective runs start to finish in the simulation, with its bonus won and lost (tests).
- [ ] Each new enemy kind behaves as documented and can be countered as documented (tests): heal interrupted
      by stagger, dome drops on stun, bomber burst avoidable by dash and harmful to enemies, raised minions
      crumble with the necromancer, reaver's landing is telegraphed.
- [ ] Warded enemies ignore their element's status and bursts; never a whole wave (tests).
- [ ] Doors carry objectives; the two doors differ; at most one vault per depth; determinism holds (tests).
- [ ] Bots handle every objective (stand in circles, guard the shard, focus hunt targets, open the vault) and
      keep the fresh-hero win rates within the existing bands.
- [ ] The client shows it: objective banner and tracker on the HUD, timers, shard health, brazier progress,
      hunt markers, door icons and labels for objectives, the five new enemies with distinct silhouettes,
      dome, heal beam, ward tint, bomber fuse; sounds for all of it; English and German.
- [ ] Browser test: a run reaches a chamber with a special objective and its tracker is visible.
- [ ] Readability and fun of the new chambers and enemies — verified by user playtest (cannot be asserted).

## Exit condition

The owner plays a run in which at least three chambers ask for something other than killing waves, meets
all five new enemies, and can tell from the screen what to do in each case.
