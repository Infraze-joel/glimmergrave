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
- [ ] Remove telegraph decals when an enemy is staggered out of its windup (a cancelled Matron beam still flashes).
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
- [ ] German settings row for the aim cursor only fits at a small font size.
