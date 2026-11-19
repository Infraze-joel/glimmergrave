# Milestone 14 — Update 5: Keystones

Owner feedback after playing updates 3 and 4: "the sense of getting stronger is not there yet, the builds feel
like random numbers getting bigger, not 'wow, I feel strong and strategic'".

## Objective

A build must change how the hero plays and looks, be the result of a few deliberate decisions, and make the
player feel the difference between chamber 1 and chamber 8.

## Scope

1. **Keystones** (`shared/src/data/keystones.ts`): 23 boons that transform an ability or the hero (16 for
   everyone, one per class). Each is visible and audible in the world. A hero holds at most two.
2. **Keystone drafts**: after each elite chamber (champion, herald) every hero drafts 1 of 3 keystones instead
   of an ordinary boon. With both slots full: replace one, or skip for an ordinary rare-or-better draft.
   Protocol: `draft.keystone`, `pick.replace`, `RosterEntry.keystones`, events `keystone`, `keystoneProc`.
3. **Builds that follow from the keystone**: boons carry tags (`boonTags`); boons sharing a tag with a held
   keystone are rolled more often and marked "fits your build" (`BoonOffer.fits`); off-build common boons are
   rolled less. All keystones must combine sensibly with infusions, sets, talents and each other.
4. **Feeling it**: the HUD shows the held keystones and the build they suggest; the ability a keystone
   transforms is framed; a clear moment when a keystone is taken; the summary shows how damage per chamber
   grew over the run and names the build.
5. Protocol version 4. The training session is unchanged (no keystones).

## Acceptance criteria

- [ ] Every keystone behaves as its `summary` and `cost` say, with its `params` (one or more tests each).
- [ ] Keystone drafts appear after the champion and the herald, per hero, at every depth; max two held;
      replace and skip work; class keystones only for their class; determinism holds (tests).
- [ ] Tag weighting and `fits` work; off-build commons are rarer once a keystone is held (tests).
- [ ] Combinations do not break the simulation: every pair of generic keystones and every class keystone with
      each generic one survives a bot run without errors, runaway loops (Corpse Bloom chains, Twin Cast +
      Blood Price, Ricochet + Chain Lightning) or frame-time spikes (test with caps documented in data).
- [ ] Balance: fresh-hero win-rate bands hold; no keystone raises a fresh solo hero's win rate by more than
      25 points or lowers it (report the table); bots choose and use keystones.
- [ ] The client shows it: keystone draft screen with costs and replace flow, keystone effects for all 23,
      HUD build display, "fits your build" marks, summary with damage growth; sounds; English and German.
- [ ] Browser test: a run reaches a keystone draft, the pick shows on the HUD and reaches the other client.
- [ ] "Do I feel strong and strategic" — verified by user playtest (cannot be asserted).

## Exit condition

The owner finishes a run and can say in one sentence what the build was ("burning dash trail with chain
lightning"), and the last chambers played visibly differently from the first.
