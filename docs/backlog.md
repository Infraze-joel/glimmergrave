# Backlog

Deferred items. Promote one into a milestone before working on it.

- [ ] Deploy and run the two-machine internet check (README section 15). Needs hosting credentials.
- [ ] Performance pass on real GPUs (integrated and discrete), tune quality presets from measurements.
- [ ] Human playtest for feel and balance (bots tuned everything so far); listen to and mix the audio.
- [ ] Test Firefox and Edge.
- [ ] Browser e2e that plays a full run to victory (needs a faster-than-realtime server mode in the test).
- [ ] Gamepad support; touch controls.
- [ ] Joining a run in progress (currently lobby only; rejoin works).
- [ ] Horizontal scaling: route by room code (sticky) or move room directory to a shared store.
- [ ] Menu backdrop: show a slowly orbiting crypt diorama behind the main menu.
- [ ] More content: second boss, more enemy affixes, class-specific boons, daily seed.
- [ ] Narrower / fainter archer aim lines when many archers fire at once.
- [ ] Human playtest of update 2: boss readability from the game camera, hazard fairness, upgrade pacing
      (Glimmer per run vs. prices), training length.
- [ ] Listening pass on the new audio (`?audiodemo`): jingles and the sci-fi-derived bolt/zap layers were
      picked by analysis, not by ear; add positional panning and footsteps.
- [x] Remove telegraph decals when an enemy is staggered out of its windup. (update 4, `interrupt` event; bosses never send it)
- [ ] Tips: dismiss by click; coach texts should follow rebinding once key rebinding exists.
- [ ] Accounts or signed saves if progression ever needs to be tamper-proof.
- [ ] Update 3 playtest: feel of the three new classes, ultimate charge rate (maxed parties cast very often),
      readability of ultimates over hostile telegraphs, depth 2+ and Oath 4+ balance (only run for termination).
- [ ] Knight is the weakest fresh class (about 21 % solo wins against an average of 35 %): buff or rework.
- [ ] Relic shards drop from the champion, heralds and bosses only; decide whether elite-flagged rank and file
      should roll too (one line in `killEnemy`, would give 7–12 shards per cursed chamber).
- [ ] 3D reaction word mark: show the reaction's name instead of "RESONANCE" (needs localised atlas words).
- [ ] Umbra / smoke contrast on dark floors; spellblade silhouette versus mage from the game camera.
- [ ] Ground aim marker in the 3D scene to go with the reticle cursor.
- [ ] Other players' relic and talent counts on lobby cards (needs `RosterEntry` fields).
- [x] German settings row for the aim cursor only fits at a small font size. (update 4)
- [x] The dead final boss's empty health bar stays on screen while the descend / ascend doors are open. (update 4)
- [ ] Update 4 playtest: are objectives readable and fun; survive and ritual end runs about three times as often
      per chamber as slay; hunt bonus is hard for parties (34 %); a solo rogue rarely saves the shard (10 %).
- [ ] Screen clutter in four-hero fights (stacked damage numbers, additive flashes): cap or merge numbers,
      tone down friendly effects further.
- [ ] Shard, braziers and reliquary have no collision (would need a new `Obstacle.kind`).
- [ ] Late joiners / reloads do not learn wards and affixes of enemies that already spawned (only in `spawn`).
- [ ] Aegis silhouette without its dome versus the warrior; shaman size; deflect icon overlapping damage numbers.
- [ ] Five first-encounter tips can queue up in one wave (14 s each); the door card shows the bonus condition
      but not the reward.
- [ ] Next from the engagement list: in-run merchant and risk events, build-defining boons, daily seed and
      bounties, leaderboards (needs accounts).
- [x] A ritual chamber could go on without end for a party that never held a circle; the fire now spreads by itself in overtime (found in a live bot session with an idle hero).
