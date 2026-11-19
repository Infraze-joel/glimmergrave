# UI report — Update 5 "Keystones"

Scope: `client/src/ui/**` and `client/src/dev/uidemo.ts` only. Nothing committed by me, no other folder touched,
`docs/STATE.md` left to the lead. The session was interrupted once (usage limit); everything below was re-run after
it. **Every state came from uidemo's fake data** — nothing was run against the real server, the sim or the 3D view.

## What was built

| Area | Files | Notes |
|---|---|---|
| Keystone draft | `draft.ts`, `keystoneDraft.ts` (new) | Shown when `state.draftKeystone` is set. Own gold-to-glimmer look, title "Choose a Keystone". Strip "Your keystones" (held ones, or "Your pick goes here" / "Free"). Three large cards: emblem, name, "Transforms your dash" + icon and name of that ability for the own class / art (or "Changes your whole hero"), the summary, the **cost on its own red line** (or a quiet "No downside"), tags, "Works with" = held boons / infusions / the other keystone that share a tag (max 3, then "+n more"; an infusion on the transformed ability is listed first). Class keystones wear the class colour and "Knight only". Hotkeys 1–3, reroll and timer as in ordinary drafts. |
| Replace flow | same | Slots full: picking a card (click or digit) does **not** emit; the cards give way to "Give up which keystone?" — the new keystone on the left, the two held ones as buttons with their summary and "2 of your boons stop fitting" / "None of your boons depend on it". Digits 1–2 choose, Esc or "Back" cancels (Esc does not open the pause menu then). Emits `ui:pick { index, replace }`. "Keep my build" (hotkey = `skip + 1`, i.e. 4) emits `ui:pick { index: skip }` and says an ordinary rare-or-better draft follows. Only offered with full slots. |
| Ordinary drafts | `draft.ts` | Offers with `fits`: gold band "Fits your build" + one line per keystone ("feeds Blazing Wake: Dash and Status"), gold card edge, header "2 of 3 fit your build"; cards that do not fit are slightly desaturated while something fits. Every boon card shows its tags in the footer (dim; lit gold when shared) — also before any keystone is held. Hidden in training. The server decides *whether* a boon fits; which keystone a tag feeds is worked out client-side from `boonTags` / keystone tags. |
| HUD | `hud5.ts` (new), `hud.ts`, `hud3.ts` | Two hex emblems left of the ability bar (`hud-keystones`), empty sockets shown faint, build name above them. The transformed ability gets a gold/glimmer frame and a keystone pip. Bloodrush: "×7" badge + draining bar from `keystoneProc n` (0 clears). Phase Walker / Veil: `buff` events open the window → buff chip with countdown, glowing emblem, pulsing dash icon. Blood Price: red "−10" on the secondary (cost = 8 % max health, never the last point; "!" at 1 health). Resonance Engine: ult ring cut into 14 % segments, "+14%" flash per own Resonance. Party frames show the ally's build name instead of the class word. |
| Acquired banner | `hud5.ts` | Own hero: "Keystone acquired" + emblem stamp, name, what it transforms, cost, and "Your build: …" with the second keystone / "Replaces …". 3.8 s; no burst with effects "minimal" or reduced motion. Allies: one feed line "<name> took <keystone>" (priority INFO, one line per ally). |
| Build identity | `keystones.ts` (new) | `buildInfo()` → Tab overview, party frames (short), HUD, banner, summary, lobby ("Last run: …" on the slot card after a run in the same room). |
| Tab overview | `scoreboard.ts` | Every hero's row: build name + keystone chips before the boon icons. Own "Your build" panel replaces the flat boon list: sets, the two keystones (summary, cost, tags, chamber taken), boons grouped by tag — groups that feed a keystone first with "Feeds Blazing Wake and Shockstep". Descriptions shrink to one line from 7 boons and vanish from 15 (the overlay cannot scroll). |
| Summary | `growth.ts` (new), `summary.ts`, `scoreboard.ts` | "Your damage per chamber": one bar per chamber (first = white, best = gold, elite / boss = violet, unfinished = hatched), keystone markers on the boundary where they were taken, headline "Your last chamber hit 6.3× as hard as your first" (or "Your best chamber (chamber 6) …", "held steady" below 1.15×, "One chamber is too few …"), plus "Damage per second: 25 → 81" when both fights were timed. "Builds": every hero's build name, keystones and the chamber each was taken in. |
| Codex | `codex.ts` | Tab "Keystones" (11th tab): "How builds work" (4 points, numbers from `KEYSTONE_TUNING`), filter All / Every class / 7 classes, all 23 with slot, summary, cost, tags. Tips tab lists the two new tips. |
| Tips | `tips.ts`, `draft.ts` | `keystone` (first keystone draft) and `fits` (first draft with a fitting boon). HUD tip cards never show over a draft, so these appear inside the draft overlay (bottom margin, right of the health bar) and count as read once the player answers. |
| Texts | `strings6.ts` (new), `i18n.ts`, `text.ts` | EN + DE for 23 keystones (EN built from the data table, DE written), 15 tags, build names, everything above. `missingTexts()` now checks keystone name / body / cost (incl. number drift), tags, slot words, `build.of.*` and a name for every pair of families. Empty in both languages. |
| Icons | `icons.ts` | 18 new: `keystone`, 16 keystone emblems, `growth`. Class keystones reuse their ability icons. |

## How growth is tracked (client-side)

`growth.ts` samples the own `run.stats` damage: `chamberClear` closes a chamber, the sample is taken from the first
run state that is no longer `combat` (so late totals are included); a run that ends mid-chamber gets a hatched
"unfinished" bar. Fights the client saw start are timed with `run.elapsed` for the DPS line. A mid-run join or reload
starts the chart at that chamber ("Counted from chamber 5, where you joined"); samples survive a reload in
sessionStorage. Keystone times come from the `keystone` event (unknown for keystones taken before the client
watched: no time shown). Tracking runs from `index.ts` regardless of the screen.

## Build-name rule table

1. **Two keystones** → the pair's own name, else the name of their two families; then the dominant element is
   appended ("of Ember" / "der Glut"; "of Resonance" when two elements tie). Element = most boons of an element
   the hero can apply.
2. **One keystone** → "<Keystone> <Class>" (DE "<Klasse>: <Schlussstein>"); short form = the keystone's name.
3. **None** → "<Element> <Class>" ("Glut-Ritter"), "<Class> of Resonance", or nothing.

Pairs: Blazing Wake+Shockstep **Stormrunner** · Blazing Wake+Chain Lightning Wildfire · Glass Cannon+Blood Price
Martyr · Corpse Bloom+Chain Lightning Plaguebringer · Colossus+Titan Grip Titan · Twin Cast+Blood Price Bloodcaster ·
Sanguine+Bloodrush Bloodhound · Resonance Engine+Corpse Bloom Resonator · Phase Walker+Glass Cannon Assassin ·
Ricochet+Chain Lightning Chainstriker · Orbiting Blades+Familiar Swarmlord · Colossus+Shockstep Juggernaut.

Families: step (ember_wake, shockstep, phase_walker, ks_shade) · strike (ricochet, chain_lightning, heavy_hitter,
ks_mage, ks_rogue, ks_spellblade) · cast (twin_cast, blood_price, ks_knight, ks_barbarian, ks_templar) · company
(orbit_blades, familiar) · body (colossus, glass_cannon, sanguine) · chain (corpse_bloom, resonance_engine,
momentum_engine).

| | step | strike | cast | company | body | chain |
|---|---|---|---|---|---|---|
| step | Windrunner | Skirmisher | Spellstrider | Pack Runner | Daredevil | Trailblazer |
| strike | | Blademaster | Battlemage | Bladestorm | Warbringer | Reaper |
| cast | | | Archcaster | Conjurer | Bloodmage | Doomcaller |
| company | | | | Swarmlord | Warlord | Harvester |
| body | | | | | Behemoth | Berserker |
| chain | | | | | | Cascade |

## Test ids

As requested: `keystone-draft` (`data-held`, also `data-step` pick|replace, `data-full`), `keystone-card-<index>`
(`data-id`, `data-slot`), `keystone-replace-<id>` (`data-lost`), `keystone-skip`, `hud-keystones` (`data-ids`,
`data-build`, `data-count`), `boon-fit-<index>` (`data-keystones`, `data-tags`), `summary-growth` (`data-chambers`,
`data-multiple`, `data-joined`), `codex-tab-keystones`.
Additional: `keystone-replace` (`data-for`), `keystone-replace-cancel`, `keystone-banner` (`data-id`), `draft-fits`
(`data-fits`), `draft-tip` (`data-tip`), `hud-blood-price` (`data-cost`), `tab-build`, `summary-growth-headline`,
`summary-builds`, `summary-build-<slot>` (`data-build`, `data-ids`), `lobby-build-<slot>`, `codex-builds`,
`codex-keystone-<id>`, `codex-keystone-filter-<all|generic|class>`, `codex-tip-keystone`, `codex-tip-fits`;
`draft-card-<i>` gained `data-fit`. Existing ids are unchanged; in a keystone draft there are no `draft-card-*`.
Bots pressing digits: in a full-slot keystone draft the first digit only opens the replace step, a second digit
(1 or 2) names the keystone to give up.

## Requested core / contract additions (none are required for what is built)

1. Per-chamber damage from the server, so the chart is exact after a reload and for late joiners. `growth.ts`
   already reads it when present and falls back to its own samples:
   ```ts
   // shared/src/types.ts, PlayerRunStats
   /** Damage dealt in each chamber entered so far, in order across depths (the last entry is the running one). */
   chamberDamage?: number[];
   ```
2. When a keystone was taken (the client only knows what it watched):
   ```ts
   // shared/src/types.ts, RosterEntry
   /** RunState.chambersCleared at the moment each keystone in `keystones` was taken (same order). */
   keystoneAt?: number[];
   ```
   Not read yet — one small change in `growth.ts` `keystoneTaken()` once it exists.
3. `game:localAction` still has no `slot` in `EventMap` (old request); unrelated to this update.

## Verification

- `npx tsc -p client --noEmit | grep -E "src/ui|src/dev/uidemo"`: empty. `npx eslint client/src/ui client/src/dev/uidemo.ts`: clean.
- `/tmp/ui5-interact.mjs` (EN + DE, 1280×720): **126 pass, 0 fail** — missing texts empty; free-slot pick by click
  and hotkey; full slots: first press does not emit, replace buttons, Esc and Back cancel without opening pause,
  `ui:pick {"index":0,"replace":"shockstep"}`, digits in step two, skip by button and key 4, consolation draft with
  fit marks; fit ids / tags / count; tags without keystone; Bloodrush stacks and n = 0; Blood Price cost; Phase Walker
  window opens and closes; no sockets in training; ally feed lines, no banner for allies; Tab panel; growth (long,
  join, none, event-driven tracker 5.78×); no growth in the training summary; codex 23 / filter 17 for the mage;
  lobby after a run vs. fresh lobby; no console errors.
- Overflow / overlap scan (`/tmp/ui5-shot.mjs`) on 32 new and 28 existing routes, EN + DE, at 1280×720 and
  1920×1080: no clipped or off-screen text. The scan does not judge vertical crowding; that was checked by eye on
  the screenshots listed as opened.
- uidemo routes: `#ks-draft` (free, class keystone) `#ks-draft-one` `#ks-draft-full` `#ks-draft-replace`
  `#ks-draft-tip` `#ks-draft-reroll` `#ks-draft-wait` `#draft-fits` `#draft-fits-2` `#draft-fits-tip` `#hud-ks-0|1|2`
  `#hud-ks-ind` `#hud-ks-ind-2` `#hud-ks-veil` `#ks-banner` `#ks-banner-2` `#ks-banner-replace` `#ks-ally`
  `#party-builds` `#tab-build` `#tab-build-one` `#tab-build-none` `#summary-growth` `-short` `-join` `-deep` `-none`
  `-live` `#lobby-after` `#codex-keystones`. The demo's `ui:pick` stand-in takes / replaces / skips like the server.

## Screenshots

All routes above exist as `/tmp/ui5-<route>-<en|de>.png` (1280×720) and `/tmp/ui5-hd-<route>-<en|de>.png`
(1920×1080); existing routes as `/tmp/ui5-old-…` / `/tmp/ui5-old-hd-…`.
**Opened and looked at**: ks-draft-en, ks-draft-full-de, ks-draft-replace-de (before the centring fix; re-measured
after), ks-draft-tip-de, ks-draft-wait-de, draft-fits-de, draft-fits-2-de, draft-fits-tip-en + de, old draft-5-de,
hud-ks-1-de, hud-ks-ind-en, hud-ks-ind-2-de, ks-banner-2-de, ks-ally-en, tab-build-en + de, tab-build-none-de,
summary-growth-en + de, summary-growth-deep-en, summary-growth-join-de, codex-keystones-de, lobby-after-en,
hd ks-draft-full-de, hd summary-growth-en. **Not opened** (scanned by script only): everything else, including
hud-ks-veil, party-builds, ks-banner-replace, summary-growth-short / -none / -live, ks-draft-reroll, tab-build-one,
all other 1080p images and the final state of ks-draft-replace and codex-keystones after their last CSS fix.

## Weaknesses

- Keystone names are not on the HUD emblems (the HUD is click-through, so there is no hover). With one keystone its
  name stands above the emblems, with two the build name; the names themselves are in the banner and the Tab panel.
- 1280×720 is tight: the summary of a deep run with an "oath unlocked" notice is taller than the screen and scrolls
  (buttons below the fold); the fits draft title sits about 10 px under the "Chamber cleared" banner while it shows;
  the HUD emblems touch the faded tail of the health panel.
- The "+14%" Resonance Engine flash and the Blood Price badge are small.
- Damage per chamber follows enemy health as much as hero power (boss chambers are tall); the DPS line is the
  fairer number but only appears when both fights were watched from the start.
- A keystone that was replaced keeps no marker in the chart.
- Build names by family are generic ("Battlemage" for any strike + cast pair); only 12 pairs have their own.
- Non-fitting cards are dimmed a little while a fitting one is on offer — a nudge the owner may or may not want.
- German: "Schlussstein" for keystone, "Build" kept as is; the codex tab row has 11 tabs and is full at 1280.
- Pre-existing demo artefact, not caused by this work: going `#busy` → `#sets` logs `state:hud` errors (timers of
  the busy route write into a shortened player list).

## Not verified

- Anything against the real server: that `draft.keystone`, `fits`, `keystone`, `keystoneProc`, the `buff` ids
  `phase_walker` / `ks_shade` arrive as `reports/backend-update5.md` describes (it is marked work in progress); the
  timeout wording ("a keystone is chosen for you" / "your build stays and a boon is chosen") follows that report.
- Whether `run.stats` is current when the phase leaves `combat` (the growth sampling relies on it), and the chart
  over a real run, reconnect or reload.
- Whether the roster already contains the new keystone when the `keystone` event arrives (the banner computes the
  build both ways).
- The repo e2e suite, `npm test`, `npm run build` — not run. Autopilot / bots in a full-slot keystone draft.
- Audio hooks (`data-sfx`) for the new buttons; effects level `minimal` was only read in code, not screenshotted.
