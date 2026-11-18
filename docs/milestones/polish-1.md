# Milestone 13 — Polish 1: readability and loose ends of updates 3 and 4

Owner request: fix the known problems of updates 3 and 4 that do not need a human playtest. No new content.

## Scope

1. **Calmer screen in big fights** (the main point): merge and cap damage numbers, dampen flashes of hero
   abilities further, draw allies' effects more quietly than the own hero's, never cover hostile telegraphs.
2. **Readability:** reaction name instead of "RESONANCE" in the 3D scene (localised via `ui:labels`); aegis and
   shaman silhouettes; spellblade versus mage from the game camera; umbra and smoke on dark floors; a ground
   aim marker under the reticle cursor.
3. **Loose ends:** objective fixtures block movement (`Obstacle.kind` shard / ritualBowl / reliquary); late
   joiners see wards, affixes and necromancer links (`RunState.traits`); tips no longer queue up for many
   seconds; door cards show the bonus reward; lobby cards show other players' relic and talent counts
   (`RosterEntry.relics/talents`).
4. **Balance where the bot numbers are clear:** knight (weakest fresh class), ultimate charge of fully
   upgraded parties, the shard for a solo hero, survive / ritual ending runs three times as often as slay,
   the hunt bonus for parties.

## Acceptance criteria

- [ ] Fixtures collide in the simulation and in client prediction; bots path around them (tests).
- [ ] `RunState.traits` lists exactly the living enemies with traits; a client that joins mid-chamber shows them (test).
- [ ] Balance bands hold; knight fresh solo within 8 points of the class average; maxed four-hero party casts
      clearly fewer ultimates than before (report numbers); survive / ritual run-ending rate at most twice slay's.
- [ ] Damage numbers on one target within a short window merge; a cap on simultaneous numbers; before/after
      screenshots of the same four-hero stress moment.
- [ ] Reaction names appear in the scene in English and German.
- [ ] Calmer screen, silhouettes and the ground marker — verified by user playtest (cannot be asserted).

## Exit condition

The owner can follow a four-hero fight in a special-objective chamber and tell enemies, telegraphs and own
effects apart.
