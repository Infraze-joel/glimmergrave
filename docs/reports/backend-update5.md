# Backend report — Update 5 "Keystones"

STATUS: **done** for points 1, 2, 4 and 5 (simulation, server, bots, tests, answers, verification). The Balance section holds my finished pass; the balance engineer extends it. Gate run on the final tree: `tsc -p shared`,
`tsc -p server`, `tsc -p client` clean; `eslint shared server client` clean; `vitest run` (whole repo) green —
counts in "Tests"; `npm run build -w server` and `npm run build:netlify -w server` succeed; one real-time 4-bot
smoke run against the built server (every bot took two keystones) — see "Smoke run".

The "Client notes" below are the design the render / UI / audio engineers built against. They are kept; every
place where the behaviour or a number differs from the version of Nov 18 is marked **CHANGED**. Numbers are given
as `params.<key>` with the current value: the client reads `params` at runtime, so later tuning needs no client
change.

## Client notes (events, state, derivation rules)

### General

- `RosterEntry.keystones` is current at all times (the roster is re-broadcast when a keystone is taken or replaced).
  `RosterEntry.keystoneAt[i]` = `RunState.chambersCleared` when `keystones[i]` was taken (same order; a replacement
  takes the new value and goes to the end of both lists).
- `keystone { slot, id, replaced? }` is emitted once when a hero takes a keystone (in the `draft` phase).
- `keystoneProc { slot, id, x, z, n?, r?, tx?, tz? }`: discrete triggers. Per hero and keystone at most one *burst*
  every `KEYSTONE_CAPS.PROC_SECONDS` (0.15 s); a burst is at most 3 events in the same tick (e.g. the three arcs
  of one chain lightning). Exception: events that carry state are never dropped (`momentum_engine` stacks and the
  procs listed as "always" below).
- Angles use the aim convention: `x = sin(a)`, `z = cos(a)`.
- **New snapshot flag** `PF.CHANNELING = 32` (PlayerSnap.flags, additive): the hero is channelling Arc Stream.
- **New `buff` ids** (event `buff { slot, id, dur }`, ids are not in BUFFS): `phase_walker` (`params.seconds`, 3 s),
  `ks_shade` (`params.stealth`, 3 s). A new `buff` with the same id restarts the window. **CHANGED** (numbers only:
  the notes said 2 s / 1.5 s).
- **New `zone` kind**: `ks_barbarian` (the stationary maelstrom a Skullsplitter leaves; ordinary `zone` / `zoneEnd`).
- No new projectile kinds. Reused: `shadowDagger` (Ricochet's thrown blade), `arcBolt` (familiar bolt), `knife`
  (Fan the Hammer), `bladeWave` (Blade Tempest).
- Keystone areas (trail width, shockwave, blade ring, bloom, shieldburst) are multiplied by 1 + `colossus.area`
  (1.4) when the hero also holds `colossus`; the `r` in the event is always the real radius.
- Everything is PvE only; nothing here damages heroes or the bell shard.
- `PlayerRunStats.chamberDamage`: damage per chamber entered, in order across depths, last entry = the current
  chamber (a new entry is pushed by `enterChamber`, so the first `run` message of a chamber already has it).

### Keystone drafts (protocol)

- After the champion chamber and the herald chamber (`chamberKind === 'elite'`, every depth) the `draft` message of
  every hero carries `keystone: { held, skip }`. `options` are keystone ids (`level` 1, no `fits`), normally 3, at
  most one class keystone, never one the hero holds. Corpse Bloom needs one infused element, Resonance Engine two
  (`KEYSTONE_NEEDS_ELEMENTS`); otherwise they are not offered.
- `pick { index }` takes it. If `held.length === KEYSTONE_TUNING.MAX_HELD` the pick must carry `replace` = one of
  `held`; otherwise the pick is ignored and the draft stays as it is. A `replace` sent while a slot is free is ignored.
- `pick { index: skip }` (skip = `options.length`) takes the consolation: the hero stays in `draftPending` and a
  new ordinary `draft` message follows (no `keystone` field) whose offers are all rare or better. Cursed /
  foresight extra choices apply to this consolation draft, not to the number of keystones. The draft clock keeps
  at least `KEYSTONE_TUNING.CONSOLATION_SECONDS` (20 s) after a skip.
- `reroll` works on a keystone draft (new keystones, same rules) and on the consolation draft.
- Timeout: a hero with a free slot gets the first keystone; a hero with full slots gets the consolation and its
  first offer.
- Ordinary drafts: `BoonOffer.fits` = tags shared with held keystones (absent when none).
- The training session has no keystone drafts.

### Per keystone

| id | events | continuous state / how to derive |
|---|---|---|
| `ember_wake` | `keystoneProc { x, z = dash start, tx, tz = dash end, r = half width }` when the dash ends (always) | The trail is the segment start→end, burns for `params.seconds` (3.5 s) from that event; ticks `hit`s every `params.tick` (0.5 s) (element = dash infusion, Ember without one). At most `KEYSTONE_CAPS.TRAILS_PER_HERO` (4) trails per hero (oldest goes). All trails vanish on `chamberClear`. Only real dashes leave trails (not lunges / leaps). |
| `shockstep` | when a dash ends: `aoe { x, z, r, el }` + `keystoneProc { x, z, r = params.radius }` (always) | `params.radius` is 3.6 (**CHANGED**, the notes said 3.2). +1 dash charge shows in `PlayerSnap.dashCharges`. |
| `phase_walker` | on dashing through an enemy: `keystoneProc { x, z = that enemy }` + `buff { id: 'phase_walker', dur: params.seconds }` (once per dash) | During the window the next direct hit (primary / secondary / ultimate; all enemies struck in that same tick) is a crit (`hit.crit`), and the dash recharges 1 + `params.haste` (2×) as fast. |
| `ricochet` | per bounce `keystoneProc { x, z = where it turned, tx, tz = next enemy, n = bounces left }` | The projectile itself turns (same projectile id, new `rot`). `params.bounces` is 3 now. Melee: every `params.every`-th swing spawns a `shadowDagger` projectile that bounces. With Arc Stream: the stream forks from the last enemy it hits (same proc, no projectile). |
| `chain_lightning` | per arc `keystoneProc { x, z = struck enemy, tx, tz = arc target }` (≤ 3 in one tick, bursts ≥ `KEYSTONE_CAPS.CHAIN_SECONDS` apart) + a `hit` on each arc target | Arcs deal `params.fraction` (1 = full damage now). |
| `heavy_hitter` | per primary release `keystoneProc { x, z = hero, r = reach (melee) }` | Melee: the proc is emitted in the tick of the release **before** the hits of that swing (same `ev` message). Projectiles: at the release, their hits come when they land. Primary wind-up / lock / cooldown are ×1/(1 − `params.slow`) = ×1/0.65 (**CHANGED**, notes: ×1/0.55); arcs are `params.area` (40 %) wider in angle and 20 % longer, projectiles and the stream 40 % wider. Arc Stream has no release, so no proc. |
| `twin_cast` | when the repeat goes off: `keystoneProc { x, z, r?, tx?, tz? }` (always) + the ability's usual `aoe` / `zone` / projectiles | See "Twin Cast per ability shape" below. No second `cast` event, no second animation. The repeat is at `params.fraction` = full strength (**CHANGED**, notes: 65 %), and the secondary recharges 1 + `params.recharge` (1.4×) as fast. |
| `blood_price` | per paid cast `keystoneProc { x, z = hero, n = health paid }` (always) | `cdSecondary` runs over the (shorter) recharge; a paid cast does not restart it. **CHANGED**: the secondary also recharges 1 + `params.recharge` (1.5×) as fast; a paid cast costs `params.hpFraction` (2 %) of max health. Health drops in the snapshot (no `hit` event). |
| `orbit_blades` | none (cuts are ordinary `hit`s) | `params.blades` (3) blades, ring radius `params.radius` (2.6, ×1.4 with colossus), blade i at angle `2π · (rpm / 60) · tick / 30 + i · 2π / 3` around the hero, `tick` = snapshot tick. Always on while the hero is alive. |
| `familiar` | per shot `keystoneProc { x, z = hero, tx, tz = target }` (always) + an `arcBolt` projectile from the hero's position | The wisp follows the hero; shots are every `params.interval` (0.75 s, **CHANGED**: notes 0.9 s) while an enemy is within `params.range` (12 m). |
| `colossus` | none | Scale the hero ×`params.size` (1.25) from the roster. Collision radius is unchanged. |
| `corpse_bloom` | per burst `aoe { x, z, r, el }` + `keystoneProc { x, z, r = params.radius, n = chain depth (1 = first) }` (always); chained bursts follow `KEYSTONE_CAPS.BLOOM_DELAY` (0.15 s) apart, at most `BLOOMS_PER_TICK` (4) per tick | `params.radius` is 4 now (**CHANGED**, notes: 3). |
| `resonance_engine` | per Resonance `keystoneProc { x, z = burst, n = params.perResonance }` (25, **CHANGED**: notes 14) | `resonance.r` is already `params.burstArea` (50 %, **CHANGED**: notes 30 %) larger. **CHANGED**: bursts also deal 1 + `params.burstDamage` (1.5×) damage (new key). Ultimate bar only moves on Resonances. |
| `glass_cannon` | none | `maxHp` in the snapshot is ×`params.hp` (0.6) (**CHANGED**, notes: halved). |
| `sanguine` | at most every `KEYSTONE_CAPS.LEECH_SECONDS` (0.5 s) `keystoneProc { x, z = hero, n = health + shield gained }` (always), plus the usual `heal` | The overheal shield is part of `PlayerSnap.shield`. Not every `heal` of a holder is the leech — see answers below. |
| `momentum_engine` | on every stack change and at expiry `keystoneProc { x, z = hero, n = stacks (0..params.max) }` (never dropped) | Stacks = `n` of the last event. |
| `ks_knight` | per burst `aoe` + `keystoneProc { x, z = knight, r = params.radius, n = damage }` (always) | `params.radius` 3.5 (**CHANGED**, notes: 3.2). |
| `ks_barbarian` | Whirlwind start: `keystoneProc { x, z, r = pull reach }` (always); Skullsplitter landing: `zone { kind: 'ks_barbarian', r, dur }` | Whirlwind lasts 1 + `params.duration` = 1.75× (**CHANGED**: 2.45 s instead of 2.1 s for the 1.4 s whirlwind). **CHANGED**: dragged enemies are also staggered (their wind-up breaks; they cannot act while the pull holds them + 0.1 s) — they show the ordinary stun. |
| `ks_mage` | none (pulses are `hit`s) | `PF.CHANNELING` set ⇒ draw the stream from the hero along `rot`, length `params.range` (13 m) cut at the first wall / shot-blocking obstacle, width `params.width` (0.6). |
| `ks_rogue` | per fan `keystoneProc { x, z = hero, n = knives }` + `knife` projectiles | — |
| `ks_templar` | none | A `zone` of kind `templar_consecrate` whose `by` holds `ks_templar` follows that hero (centre = hero position each frame). `dur` is already `params.duration` (35 %, **CHANGED**: notes 50 %) longer. A Judgement (art variant) leaves one where he lands. |
| `ks_spellblade` | per volley `keystoneProc { x, z = hero, n = extra waves }` + `bladeWave` projectiles | Waves at `params.fraction` (45 %). |
| `ks_shade` | on a veil `keystoneProc { x, z = victim }` + `buff { id: 'ks_shade', dur: params.stealth }` | Veiled for the window: enemies do not target the shade. **CHANGED (trigger)**: a veil comes from a backstab kill, a kill by Shadowstep (it strikes from behind), and a kill by the empowered first hit out of the veil (so the loop can go on; the new `buff` restarts the window). Several kills in one tick veil once. The bonus (+`params.damage` = double damage) belongs to the first direct hit after the tick of the veil; everything struck in that tick shares it. |

### Twin Cast / Blood Price / class keystones per ability shape

Twin Cast repeats the *effect* `params.delay` (0.45 s) later at `params.fraction`; it never moves the hero a second
time and never repeats a `buff` secondary. At most `KEYSTONE_CAPS.TWINS_PENDING` repeats wait per hero; a repeat
never repeats itself.

| shape | repeat (`keystoneProc twin_cast` fields) |
|---|---|
| arc / projectile / beam | again from where the hero stands now, along the original aim (`x, z` = hero) |
| circle | again at the same target spot (`x, z` = spot, `r`) |
| zone | laid again: a targeted zone at the same spot, a zone around the hero where the hero stands now (`r`); counts towards `ZONES_PER_HERO` |
| trap | a second trap at the same spot, armed after 0.2 s (`r`) |
| spin | a second spin runs alongside the first around the hero (`r`), same pulses |
| lunge | an afterimage repeats the charge along the original path (`x, z` = start, `tx, tz` = end, `r`); the hero stays put and gets no second shield |
| leap | a second blast where the hero landed (`x, z`, `r`) |

Blood Price works with every secondary shape (also `buff`): the cast simply happens early. Class keystones:
Shieldburst reacts to any shield of the knight (temporary shields and the barrier); Maelstrom changes the `spin`
secondary (Whirlwind) and, with the Skullsplitter (leap) variant, leaves the `ks_barbarian` zone; Walking Sanctum
changes the `zone` secondary (Consecrate) and the Judgement art; Arc Stream replaces the projectile primary; Fan the
Hammer counts the rogue's bolts (Arcane Echo-style repeats are not counted); Blade Tempest adds waves to every cut and
two side waves to the finisher; Veil of Knives counts the primary's backstabs and Shadowstep (a Twin Cast afterimage
of Shadowstep counts too).

## What changed since the notes of Nov 18

Behaviour (all marked in the table above):

1. **Veil of Knives** (`ks_shade`): Shadowstep kills and kills by the empowered hit out of the veil also veil; one veil
   per tick; the victims of the blow that veiled no longer spend its bonus. Reason: as specified it triggered about
   3 times per fresh solo run (enemies face their only target, so solo backstabs are rare) and lowered the win rate.
2. **Blood Price**: the secondary also recharges 50 % faster; the price is 2 % instead of 5 %.
3. **Resonance Engine**: bursts also deal 50 % more damage (new param key `burstDamage`).
4. **Maelstrom** (previous engineer, unreported until now): the pull staggers the dragged enemies (`KS.PULL_STAGGER`).
5. **Sanguine Pact**: another hero's Rally (healing on its ultimate) no longer heals the holder — the cost text already
   said "other heroes no longer heal you"; the code only refused shared vigour, soulfire and void lantern before.
6. **Titan Grip**: the melee proc now comes before the swing's hits in the same tick (it came after them).
7. Twin Cast's repeat is at full strength and the secondary recharges faster (previous engineer, unreported).

Numbers only: see "Contract / data changes".

## Contract / data changes

No exported shape, id, event, field or order changed. In `shared/src/data/keystones.ts` (texts updated with them):

| keystone | HEAD (Nov 18 commit) | now | by |
|---|---|---|---|
| ricochet | bounces 2, falloff 0.8 | bounces 3, falloff 0.85 | previous engineer |
| chain_lightning | fraction 0.8 | fraction 1 | me |
| twin_cast | delay 0.45, fraction 1 | + new key `recharge` 0.4 | previous (0.25) + me (0.4) |
| blood_price | hpFraction 0.05 | hpFraction 0.02, + new key `recharge` 0.5 | me |
| corpse_bloom | radius 3.5, damage 45 | radius 4, damage 120 | previous (55) + me |
| resonance_engine | perResonance 25, burstArea 0.5 | + new key `burstDamage` 0.5 | me |
| sanguine | leech 0.02, overheal 20 | leech 0.015, overheal 15 | previous engineer |
| momentum_engine | perKill 0.06, seconds 6 | perKill 0.07, seconds 8 | previous engineer |
| ks_barbarian | duration 0.5 | duration 0.75 | me |
| ks_templar | duration 0.5 | duration 0.35 | previous engineer |
| ks_spellblade | fraction 0.5 | fraction 0.45 | me |
| ks_shade | stealth 1.5, damage 0.5 | stealth 3, damage 1 | previous (2, 1) + me (3) |

Other files: `client/src/ui/strings6.ts` — the German keystone texts still carried the numbers of an early draft
(e.g. Glass Cannon "+60 %", Sanguine "3 % / 30", Bloodrush "5 s / 4 %", Familiar "0,9 s / 60 %", Shieldburst
"150 %"); all 23 now match `params` (English is built from `summary` and needed nothing). Sim-internal:
`KeystoneState.veilAt`; `KS.PULL_STAGGER`; `BotBrain` Blood Price rules. Tools: `botClient.ts` exports `parseArgs`;
`shared/test/tools/soak5.ts` gained `--by-class`, `--blind`, procs and ultimates per run. Telemetry only (no
gameplay effect): `ks.dealt` now also counts the Skullsplitter maelstrom (`ks_barbarian`), the Arc Stream
(`ks_mage`), the Veil bonus (`ks_shade`) and the extra Resonance damage (`resonance_engine`).

## Balance

_The balance engineer adds to this section below (point 3 was handed over by the lead after my pass was done). The
lead decided to keep my `params` and `soak5.ts` changes. They are the ones marked "me" under "Contract / data changes",
and the numbers below were measured on exactly that tree._

### Backend pass (before the hand-over)

#### Method

`npx tsx --tsconfig server/tsconfig.json shared/test/tools/soak5.ts 10 generic` and `… soak5.ts 10 class 60`:
fresh solo heroes, oath 0, the seeds of `botruns.test.ts`, every boss. Baseline `none`: the bot takes the
consolation (a rare-or-better boon) in every keystone draft. Keystone row: the bot takes that keystone in its first
keystone draft (champion) and the consolation in the second (herald). Generic keystones: all seven classes × 3 bosses
× 10 seeds = **210 runs per row**; class keystones: their class × 3 bosses × 60 seeds = **180 runs per row**, against
that class's own baseline. "Own share" = damage the keystone dealt itself / all damage dealt after it was taken
(— = a modifier with no damage of its own; Blood Price = secondary damage of the paid casts).

Noise: one row's win rate has a binomial standard error of about 3.3 points (210 runs) / 3.5 (180); the difference
to the baseline about 4–5 points (the rows share seeds and are identical up to the champion, which helps a little).
Differences of ±5 are therefore not distinguishable from zero.

Calibration: the baseline is not "nothing" — it is a rare-or-better boon. A keystone that does nothing (Blood Price
with a bot that is not told it holds it, `--blind`) measured **−7 points**. A keystone has to beat that boon.

#### Fresh solo win rate with the keystone forced (final numbers)

Generic, baseline 36 % (210 runs):

| keystone | win | vs baseline | own share | taken | note |
|---|---|---|---|---|---|
| ember_wake | 41 % | +5 | 17 % | 96 % | |
| shockstep | 39 % | +3 | 10 % | 96 % | below target, not changed (within noise) |
| phase_walker | 45 % | +9 | — | 96 % | |
| ricochet | 41 % | +5 | 17 % | 96 % | |
| chain_lightning | 39 % | +3 | 28 % | 96 % | was −0 → fraction 0.8 → 1 |
| heavy_hitter | 48 % | +11 | 46 % | 96 % | |
| twin_cast | 43 % | +7 | 11 % | 96 % | was +1 → recharge 0.25 → 0.4 |
| blood_price | 34 % | −2 | 7 % | 96 % | was −11; see below |
| orbit_blades | 50 % | +14 | 29 % | 96 % | |
| familiar | 50 % | +14 | 27 % | 96 % | |
| colossus | 45 % | +9 | — | 96 % | |
| corpse_bloom | 39 % | +3 | 27 % | 91 % | was −4 → damage 55 → 120, radius 3.5 → 4 |
| resonance_engine | 33 % | −3 | 8 % | 70 % | was −5; only 70 % of the heroes have two elements at the champion (the rest take the consolation, i.e. play the baseline) |
| glass_cannon | 40 % | +4 | 50 % | 96 % | below target, not changed (within noise); clears chambers 5–8 38 % faster |
| sanguine | 52 % | +16 | — | 96 % | |
| momentum_engine | 38 % | +2 | — | 96 % | below target, not changed (within noise) |

Class keystones (180 runs each, against the class's baseline):

| keystone | baseline → win | vs baseline | own share | note |
|---|---|---|---|---|
| ks_knight | 30 % → 36 % | +6 | 16 % | |
| ks_barbarian | 35 % → 41 % | +6 | — | was +0 (120 runs) → duration 0.5 → 0.75 |
| ks_mage | 25 % → 31 % | +6 | 66 % (the whole stream) | |
| ks_rogue | 46 % → 55 % | +9 | 21 % | |
| ks_templar | 22 % → 36 % | +13 | — | |
| ks_spellblade | 32 % → 46 % | +14 | 37 % | was +25 (120 runs) → fraction 0.5 → 0.45 |
| ks_shade | 34 % → 33 % | −1 | 2 % | was −5 (120 runs) → trigger widened, stealth 3; still about 15 veils per run |

Nothing is above +25. **Four keystones sit at −3…+3 (blood_price −2, resonance_engine −3, ks_shade −1, and
corpse_bloom / chain_lightning +3) — not measurably negative, but below the +5 target.** I stopped tuning there
because the last rounds moved them by less than the noise:

- Blood Price: free early casts (price 0) still measured only −2: bots gain little from casting their secondary more
  often (spins and plain lunges keep the hero committed in the pack). The bot now pays only for casts that do what a
  plain attack cannot (area shapes, stuns, sure crits), on ≥ 2 enemies or a boss, above 65 % health, once per 1.5 s.
  The recharge bonus is what lifts it from −11 to −2.
- Resonance Engine: doubling the burst damage (tried) measured the same as +50 %, so +50 % stayed.
- Veil of Knives: its value is in parties (enemies turn to other heroes, so backstabs happen); solo it fires about 15
  times per run. A bot that plays the veil (stays out of the line the lost enemies walk) would show more.

#### Bands of `shared/test/botruns.test.ts` (unchanged test, passing)

Final tree, free keystone choice: fresh solo ALL 46 % (band 20–50; it was 40 % before this pass), fresh 4-bot ALL
73 % (40–80; was 80 %), maxed solo 100 %, maxed 4-bot 100 %; per boss fresh solo 26 / 60 / 52 %, fresh 4-bot
60 / 80 / 80 %; per class fresh solo knight 50, barbarian 50, mage 33, rogue 44, templar 44, spellblade 67, shade 33 %
(18 runs each); old / new class groups 44 % / 48 % (≤ 55). Fresh solo is now close to its upper bound of 50 %.

### Balance, second pass (balance engineer)

#### Method

Same tool, same rows, same definitions as above. The tree above is deterministic: re-running seeds 0–9 reproduced
every number in the tables exactly (none 36 %, ember_wake 41 %, … familiar 50 %), so instead of re-running them I
added an **independent second sample, seeds 10–19** (`--from=10`; class keystones seeds 60–119, `--from=60`) for every
row that was out of range or near the edge, and pool both: **420 runs per generic row, 360 for Veil of Knives**.
Pooled, the standard error of a row's difference to its baseline is about 3 points, so ±3 is still noise.
Candidates were tried with the new `--set=id.key=value,...` (applied before the simulation copies `params`); the
final numbers were then written to the data table and re-run from it — identical results (deterministic).
Baselines: seeds 0–9 none 36 %, seeds 10–19 none 33 %; shade-only none 34 % / 35 %.

Tool changes (`shared/test/tools/soak5.ts`, only file under tools touched): `--from=N` (seed offset) and `--set=…`
(param override); the harness is loaded by dynamic import after the overrides. `tsc -p shared`, `eslint` clean.

#### Rows that were out of range or near the edge (seeds 0–9 / 10–19 → pooled, points vs `none`)

| keystone | before | after | change | own share | ch5–8 (wins) vs none |
|---|---|---|---|---|---|
| shockstep | +3 / +3 → **+3** | +9 / +9 → **+9** | `damage` 38 → 60 | 10 % → 13 % | −4 % / −3 % |
| ricochet (after the fix) | +5 / +1 → **+3** | +10 / +8 → **+9** | `falloff` 0.85 → 1, `range` 7 → 9 | 17 % → 20 % | −13 % / −13 % |
| chain_lightning | +3 / +0 → **+1.5** | +5 / +9 → **+7** | `range` 6 → 8 | 28 % → 33 % | −15 % / −15 % |
| momentum_engine | +2 / +1 → **+1.5** | +4 / +8 → **+6** | `perKill` 0.07 → 0.1 | — | −10 % / −15 % |
| blood_price | −2 / +1 → **−0.5** | +3 / +4 → **+3.5** | `recharge` 0.5 → 0.8 | 6 % | −7 % / −8 % |
| resonance_engine | −3 / −3 → **−3** | +3 / +3 → **+3** | `perResonance` 25 → 50, `burstDamage` 0.5 → 1 | 8 % → 15 % | −17 % / −21 % |
| ks_shade (shade only) | −1 / −3 → **−2** | +2 / +6 → **+4** | `stealth` 3 → 5 | 2 % → 3 % | −7 % / −8 % |
| corpse_bloom | +3 / +5 → **+4** | unchanged | — | 26 % | −10 % (seeds 10–19) |
| glass_cannon | +4 / +6 → **+5** | unchanged | — | 50 % | −40 % (seeds 10–19) |

Tried and rejected (pooled): blood_price `recharge` 1.0 → +3.5 (no better than 0.8); resonance_engine
`perResonance` 35 → −1.5, `perResonance` 40 + `burstDamage` 1 → −1.5. Resonance Engine only moves once two
Resonances fill the bar: with 50 its holders fire about 25 ultimates per run instead of 13 (the row's −16…−21 %
chamber time). Only 70 % of the heroes have the two elements it needs at the champion; per holder the gain is ≈ +4.
Ricochet: on seeds 0–9 the bug fix did not change its row (41 %, 17 %, 96 % both before and after).

Rows not re-measured (in range in the 210/180-run tables above, untouched): ember_wake +5, phase_walker +9,
heavy_hitter +11, twin_cast +7, orbit_blades +14, familiar +14, colossus +9, sanguine +16; class keystones knight +6,
barbarian +6, mage +6, rogue +9, templar +13, spellblade +14. Changing one keystone's params cannot change another's
row (a row holds one keystone), so these stand.

**Result:** pooled, no keystone is negative and none is above +25 (highest: sanguine +16). Four are still a little
under +5 but within noise of it: resonance_engine +3, blood_price +3.5, corpse_bloom +4, ks_shade +4.

#### Free choice and the bands

`free` (bots choose): seeds 0–9 44 % → 46 % (+10 vs none), seeds 10–19 42 % (+9). `npx vitest run
shared/test/botruns.test.ts` on the final table: passes; fresh solo ALL 46 % (band ≤ 50, unchanged), fresh 4-bot
ALL 69 % (was 73 %), maxed solo / 4-bot 100 % / 100 %; per class fresh solo knight 56, barbarian 44, mage 28, rogue 44,
templar 39, spellblade 72, shade 39 % (18 runs each). `update5-keystones`, `update5-safety`, `update5-bots`,
`update5-drafts`, `determinism` pass on the final table (88 tests together with botruns).

#### Costs

- Glass Cannon: downs per run 1.46 against 1.49 for `none` (seeds 10–19) — the 40 % health loss does **not** show as
  more downs, because the holder kills twice as fast (chambers 5–8 40 % faster); it shows as more deaths in chamber 6
  (43 vs 38 of 210). The cost is felt as risk, not as downs; I left it, since the row is only +5.
- Blood Price: about 17 paid casts per run × 2 % ≈ a third of maximum health over a whole run — a mild cost.

#### Params changed in this pass (`shared/src/data/keystones.ts`, numbers only; English `summary` updated with them)

| keystone | old → new | in the texts |
|---|---|---|
| shockstep | `damage` 38 → 60 | no |
| ricochet | `falloff` 0.85 → 1, `range` 7 → 9 | no (bounces no longer lose damage; the test reads `falloff`) |
| chain_lightning | `range` 6 → 8 | no |
| blood_price | `recharge` 0.5 → 0.8 | "50%" → "80% faster" |
| momentum_engine | `perKill` 0.07 → 0.1 | "+7%" → "+10%" |
| resonance_engine | `perResonance` 25 → 50, `burstDamage` 0.5 → 1 | "25%" → "50%", "50% more damage" → "100% more damage" |
| ks_shade | `stealth` 3 → 5 | "3 s" → "5 s" |

**Not done by me (not my files):** the German texts in `client/src/ui/strings6.ts` still carry the old numbers —
`keystone.blood_price.body` (line ~389: 50 % → 80 %), `keystone.resonance_engine.body` (~401: 25 % → 50 %, 50 % mehr →
100 % mehr / doppelten Schaden), `keystone.momentum_engine.body` (~410: +7 % → +10 %), `keystone.ks_shade.body` (~425:
3 s → 5 s). In the client notes above, `resonance_engine` `n` is now 50 and the `ks_shade` buff `dur` 5 s (both are
read from `params`, so no code change).

#### Not covered

Parties, depth ≥ 1, Oath > 0 per keystone; the in-range rows on the second seed sample; Ricochet's melee path on its
own (the row mixes all classes); how the ultimate rate of Resonance Engine (≈ 25 per run) looks and sounds in play.

## Tests

Final `vitest run` (whole repo, final tree): **38 files, 609 tests, all passing** (the run before my last safety-test
fix: 608 / 609). Update 5 files: `update5-keystones` 35 tests, `update5-drafts` 16, `update5-bots` 10,
`update5-safety` 8, `server/test/update5` 3 — 72 tests (I added 6, the rest were already there). There is also a new
case in `determinism.test.ts`. Safety timing in the final run: 120 generic pair fights, 0.038 ms mean per tick, 311 of
714 258 steps over 8 ms. The slowest was 835 ms, a stall of the shared machine (other work was running), far under
the 3 % slow-share bound. Most events in one tick: 41. Update 5 tests added or changed in this pass:

- `update5-keystones.test.ts`: Ricochet's test is driven by `params.bounces` (a chain of `bounces + 2` enemies; it
  failed because the test hard-coded two bounces after the tuning); Titan Grip's proc precedes the swing's hits;
  Sanguine refuses another hero's Rally and keeps its own; Twin Cast and Blood Price recharge (and both together);
  Blood Price's health limit with any `hpFraction`; Resonance Engine burst damage; Veil of Knives via Shadowstep, one
  veil per tick, the veil loop and its end; test names state params instead of stale numbers.
- `update5-safety.test.ts`: the Ricochet + Chain Lightning + Fan the Hammer cap uses `params.bounces` (failed for the
  same reason); the Twin Cast + Blood Price test derives its time limit and cooldown floor from params (it assumed a
  5 % price).
- `determinism.test.ts`: a four-hero party holding eight keystones (blooms, bounces, arcs, twin casts, companions,
  trails, leech) and drafting replays identically (snapshot bytes, every `keystone` / `keystoneProc`, run state).
- `server/test/update5.test.ts`: `botClient --keystone id[,id]` parsing (and refusal of unknown ids).
- Already present and passing (previous engineer): drafts (timing after champion and herald at every depth for every
  hero, class filter, max two, replace required with full slots, skip → rare-or-better consolation, foresight,
  consolation clock, timeouts, rerolls, determinism of offers and pins), tags / `fits` / weights, safety (all 120
  generic pairs and 112 class × generic pairs through a bot fight: no NaN, caps, events per tick, slow-step share;
  a four-hero party with eight keystones; proc rate limits; Corpse Bloom queue; nothing touches heroes / shard /
  non-combat phases), bots (choose class keystone and build, replace / consolation, forced keystones, Blood Price,
  Phase Walker, Arc Stream, dash keystones, Glass Cannon distance), protocol round-trips (`draft.keystone`,
  `pick.replace`, version 4, the new events and fields), `chamberDamage`, `keystoneAt` (sim and over sockets).

## Answers

- **Is `run.stats` current in the run-state message that leaves `combat`?** Yes. `Room.tick` steps the world and, when
  `runVersion` changed (the phase change does), broadcasts `getRunState()` built at that moment, so `stats` (and
  `chamberDamage`, last entry = the chamber just cleared) include the last tick of the fight. Tested in the sim
  (`update5-drafts`) and over sockets (`server/test/update5.test.ts`: the `run` message with `phase: 'draft'` has
  `chamberDamage[0] === damage > 0`). Note: during combat `run` messages go out only on structural changes (and about
  4 per second in special objectives), so `stats` inside combat may be seconds old.
- **Which reaches clients first, the roster or the `keystone` event?** The roster. A `pick` is handled outside the
  tick and `afterWorldChange` broadcasts the roster at once, while the `keystone` event waits in the world's queue for
  the next snapshot tick. A timeout pick happens inside `world.step()`; `Room.tick` then sends `run`, then `roster`,
  then (on a snapshot tick) the `ev` message. Asserted over sockets for the pick path.
- **Audio: does the `heavy_hitter` proc come at the swing release before its hits?** For melee arcs: now yes, in the
  tick of the release and before that swing's `hit`s in the same `ev` message (it used to come right after them).
  For projectile primaries the proc is at the release; the hits come when the projectile lands. Arcane Echo repeats
  proc too; Arc Stream never procs (no release).
- **Audio: are all `heal` events for a Sanguine holder its own leech?** No. A holder refuses blessing doors, hallowed
  ground (also its own), other heroes' healing (Rally now included, shared vigour, soulfire, void lantern from an
  ally), but still gets `heal` events from its own sources: the `leech` boon on kills, Wither (umbra) leech, Mending
  at chamber start, its own Rally / shared vigour / soulfire / void lantern, the heal on descending a depth and the
  vault's reward. The leech itself is exactly the `heal` that comes with a `keystoneProc sanguine` in the same tick
  (if the gain was ≥ 1; a pure shield gain has the proc but no `heal`). Silencing every heal of the holder mutes those
  other sources too.
- **Audio: what `n` does `resonance_engine` send?** `n = params.perResonance` = 25 (percent of the bar, which is also
  charge points since `ULTIMATE.MAX` is 100). It is the nominal value: near a full bar the real gain is smaller, so
  reading the fill from the own snapshot's `ult` is right.
- Render assumption "Veil ends on the first hit": still true for a hit that does not kill; if that hit kills, a new
  `buff ks_shade` follows in the same tick and restarts the window.

## Smoke run

Built server (`node server/dist/server.js`, PORT 8931, `DEBUG_START_CHAMBER=3`,
`DEBUG_KEYSTONES=blood_price,chain_lightning`) at real time (time scale 1) and
`botClient --create --bots 4 --meta max --keystone blood_price,chain_lightning --once` (knight, barbarian, mage,
rogue). Result: **victory** vs the Matron after 398 game s. All four bots report `keystones: blood_price,chain_lightning
(2 keystone drafts)`, there are no bot errors, and the server log has no `warn` / `error` lines (join, run_start,
run_end, leave, room_closed). Logs: `/tmp/smoke5-server.txt`, `/tmp/smoke5-bots.txt`.

## Not verified / known limits

- No browser, render or audio check of the CHANGED behaviours (Veil loop, Resonance damage, faster recharges), no
  human playtest ("do I feel strong and strategic").
- Balance is measured for fresh solo heroes at oath 0, depth 0 only; keystones in parties only through the botruns
  bands; depth ≥ 1 and higher oaths not measured per keystone. Bots choose keystones by a fixed score table and never
  skip a keystone draft for the consolation while a slot is free.
- Four keystones remain below the +5 target (see Balance). Fresh solo free-choice win rate is 46 %, near the 50 %
  upper bound of its band — further keystone buffs should be checked against it.
- Wall-clock step times are not asserted (shared machine); the safety test bounds the share of slow steps.
