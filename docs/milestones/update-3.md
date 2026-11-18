# Milestone 11 — Update 3: The Endless Descent

Owner request: "more classes, more synergies, more attacks, more upgrades — a feeling of never ending
progression and grinding". This file is the specification all four work streams build against. The data tables
in `shared/src/data/*` are the source of truth for numbers; this file explains the rules behind them.

## Objective

Turn the 15-minute run into a loop that never runs out of goals: seven classes with three abilities each,
four elements with six named reactions, set and duo boons, and five layers of permanent progression
(Armory, Ascension, class mastery with talents, relics, the Chronicle) on top of an endless descent.

## Scope

### 1. Classes and attacks (`data/classes.ts`)

- Seven classes: knight, barbarian, mage, rogue + **templar** (knight body, two-handed sword),
  **spellblade** (mage body, sword + spellbook), **shade** (rogue body, twin daggers).
- Every class has a primary chain, a secondary, one alternative secondary (**art**, unlocked at mastery
  level 2, chosen in the loadout: `Loadout.art`, shown to all as `RosterEntry.art`) and an **ultimate**.
- New input: `BTN.ULTIMATE` (Q, R or middle mouse). The ultimate needs a full charge (`ULTIMATE` table:
  charge from damage dealt, damage taken and Resonances; kept between chambers; `PlayerSnap.ult` 0..1;
  `ultReady` event when it fills).
- New ability shapes: `beam`, `leap`, `zone`, `trap`, `buff` (documented at `AbilityDef`). Lasting ground
  effects are announced with `zone` / `zoneEnd` events, timed hero effects with `buff`, the shade's marks with
  `mark`. Animations: `art`, `ultimate` (new `PlayerAnim` values). New projectiles: `shieldDisc`, `bladeWave`,
  `shadowDagger`.
- Ability ids are the keys for VFX, SFX, icons and texts (`ABILITY_BY_ID`).

### 2. Elements and synergies

- Fourth element **umbra** → status **Wither** (`STATUS.WITHER`, `EF.WITHER`): the enemy deals less damage and
  every hit on it heals the attacker a little. Colour: deep violet-black with a pale green rim (ember stays
  orange, rime cyan, storm yellow-violet as before).
- Every pair of elements has a **named reaction** (`data/reactions.ts`): Shatter, Conflagration, Superconduct,
  Soulfire, Entomb, Void Arc. The Resonance burst stays; each reaction adds its own effect. The existing
  `resonance` event already carries both elements; clients look the reaction up with `reactionOf(a, b)`.
- Boons grow from 33 to 80 (`data/boons.ts`): umbra and ultimate infusions, new boons in every category,
  the `ultimate` category, two **class boons** per class (generic `ability` field changes) and six legendary
  **duo boons** (one per reaction; offered only to a hero with infusions of both elements).
- **Set bonuses** (`SETS`, `setProgress()`): owning enough different boons of one element or category switches
  on a two-tier passive. Announced with the `set` event; the HUD shows progress.
- Draft rules: class boons only for that class; duo boons only when both infusions are owned; legendary weight
  from `BOON_TUNING.WEIGHTS`; a cursed draft still guarantees rare or better.

### 3. Permanent progression (all stored in the browser, clamped by the server)

All passive bonuses use one vocabulary, `Mods` (`data/mods.ts`). The simulation sums meta upgrades, Ascension,
mastery level, talents, relics and set bonuses into one `Mods` per hero and applies `capMods`.

- **Armory**: 18 upgrades (9 new; vitality and might have 8 levels now) — `META_UPGRADES`.
- **Ascension** (`PARAGON`): endless ranks for seven stats, open after the first win. Price grows
  quadratically, effect has diminishing returns past rank 25 (`paragonEffective`).
- **Class mastery** (`data/mastery.ts`): every run pays XP to the class played. Levels never end. Level 2
  unlocks the art; levels 3 / 6 / 10 unlock a talent tier (two options each, 42 talents); every level adds a
  small bonus for that class (`masteryMods`).
- **Relics** (`data/relics.ts`): 20 relics, found as shards from elites (12 %), heralds (40 %) and final bosses
  (100 %; two shards below depth 0). Chances grow with depth, Oath and upgrades. Shards of one relic raise its
  rank (1..10). 1–3 slots. The server rolls the drops per hero (seeded) and reports them in `RunReward.relics`.
- **Chronicle** (`data/feats.ts`): 16 lifetime counters, 16 feats with tiers that pay Glimmer when claimed.
  Client-side only, fed by `RunState.stats` (new: `elites`, `bosses`, `ultimates`), `cleared`,
  `chambersCleared`, rewards.
- Rewards at run end: `RunReward { glimmer, xp, relics }` per hero. Glimmer and XP are scaled by Oath and by
  the depth at which they were earned, then by the hero's own `glimmer` / `xp` mods (and the old `fortune`).

### 4. Endless descent

- After a final boss dies the run does not end: heroes draft, then two doors open — **descend** and **ascend**.
  Ascend ends the run as `victory`. Descend increases `RunState.depth`, heals (`RUN.DEPTH.HEAL_FRACTION`),
  restarts the chamber sequence (new seeded biomes, a different final boss) and multiplies enemies by
  `depthScale(depth)`. Boons, ultimate charge and stats carry over.
- `RunState.cleared` counts final bosses slain. A party that falls below depth 0 gets phase `defeat`, but the
  run counts as won for everything (`cleared > 0`): Oath unlock, feats, rewards.
- Elites carry an **affix** (`AFFIX_IDS`, in the `spawn` event) from depth 1 or Oath 4.
- Oath levels go up to 20 (`oathScale`); winning at level n unlocks n + 1.

## Acceptance criteria

- [ ] Every class, art and ultimate works in the authoritative simulation and is covered by a test
      (shape, damage, special behaviour, charge and spending of the ultimate).
- [ ] Umbra / Wither and all six reactions behave as their table says; each has a test.
- [ ] Every new boon, set tier, talent, relic special, Armory upgrade and Ascension stat changes the
      simulation as described; class and duo boons are only offered under their conditions (tests).
- [ ] Loadouts are clamped: art and talents by mastery, relics by slots/duplicates/rank, ranks by maximum (tests).
- [ ] Descend / ascend doors appear after a final boss; depth scales enemies; rewards (Glimmer, XP, relic
      shards) are reported per hero; a defeat below depth 0 counts as a won run (tests).
- [ ] Bots can play all seven classes including art and ultimate; a bot party finishes depth 0 and descends.
- [ ] The client shows all of it: seven classes in menu, lobby and wardrobe; ultimate on the HUD; set
      progress; named reactions; reward breakdown with XP, level-ups and relics; Armory, Ascension, Mastery,
      Reliquary and Chronicle pages in English and German (browser tests where a flow exists).
- [ ] Old profiles keep their Glimmer and upgrades (unit test on the profile loader or browser test).
- [ ] Feel, readability and sound of the new abilities — verified by user playtest (cannot be asserted).

## Exit condition

The owner plays a run with a new class, uses its ultimate, sees XP and a relic at the end, spends them
(talent, relic slot, Ascension rank) and starts a deeper or harder run that is noticeably different.
