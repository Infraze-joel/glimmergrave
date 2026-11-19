# Audio, Update 5 "Keystones" — report

All six parts of the brief are implemented and measured in headless Chrome. **Nothing was judged by ear**: I cannot listen. Levels, brightness, envelopes, "no clipping" and "these two sounds differ in register or gesture" are measured; whether a keystone sounds satisfying, whether the moment feels like a moment and whether the score's new voices read as progress is unverified.

Checks: `npx tsc -p client --noEmit | grep -E "src/audio|src/dev/audiodemo"` prints nothing; `npx eslint client/src/audio client/src/dev/audiodemo.ts` is clean; the audio unit tests pass (`tests/unit/audioKeystones.test.ts`, 6 new tests; 16 with the two older files). I started the full `npm test` once and stopped it after five minutes without a result (the sim's bot tests were still running), so the full suite and the build are **not** verified by me. I committed nothing; the lead's checkpoints already contain most of it, and `client/src/dev/audiodemo.ts` and `docs/AUDIO.md` have later, uncommitted changes.

The sim's notes (`backend-update5.md`, no `CHANGED` marks when I finished) were read twice and the emit sites in `shared/src/sim/keystones.ts` / `abilities.ts` match them. The data table's tuning numbers changed after my measurements (Phase Walker's window is 3 s now, Shockstep's radius 3.6); the code reads them from `params`, the measured figures below are from the earlier values.

## Mapping per keystone

Own hero: full sound. Allies: about 9 dB quieter, no tail, at most half as often.

| Keystone | Sound | Trigger |
|---|---|---|
| ember_wake | air catching fire, then 3.5 s of crackle | `keystoneProc` at dash end |
| shockstep | dull boom, ring of air; `r` scales it | `keystoneProc` |
| phase_walker | backwards glass swell, two notes up, trembling high note for the window | `keystoneProc`; its `buff` is silent |
| ricochet | struck edge bending upwards, higher per bounce | `keystoneProc`, `n` = bounces left |
| chain_lightning | one zap per arc, 48 ms apart, left / right | one `keystoneProc` per arc |
| heavy_hitter | **cost:** slow low sweep and groan of iron; then iron on bone and the floor | swing: own press or `keystoneProc`; blow: first `hit` by that hero within 0.9 s |
| twin_cast | the same plucked note twice, the second further away, an octave up | `keystoneProc` |
| blood_price | **cost:** a heart's double beat, something wet, a sinking note, short muffle | `keystoneProc` per paid cast |
| orbit_blades | loop: three soft swishes a second, own hero only, −40 dBFS; a thin edge per cut | loop: roster + own hero fighting and alive; cut: guessed (see weaknesses) |
| familiar | small falling chirp with a bell | `keystoneProc` per shot |
| colossus | the lowest sound in the game | derived: own dash and own secondary, half level |
| corpse_bloom | wet pop, three-note bloom, a scale step higher per burst of a chain | `keystoneProc`, `n` = chain depth |
| resonance_engine | dynamo spinning up into a struck note, higher the fuller the ultimate bar | `keystoneProc`; pitch from own `ult` |
| glass_cannon | cannon pop with a ring of glass; **cost:** crack and shards on every blow taken | pop: own primary / secondary, half level; brittle: `hit` on a holder |
| sanguine | breath in, warm third, swallow | `keystoneProc`; the holder's `heal` is silent |
| momentum_engine | drum a whole tone higher per stack; own: heartbeat 84 → 165 bpm | `keystoneProc`, `n` = stacks, `n = 0` ends it |
| ks_knight | plate, glass, bright ringing fifth | `keystoneProc` |
| ks_barbarian | air dragged inwards in four turns | `keystoneProc`; `zone` kind `ks_barbarian` |
| ks_mage | loop: buzzing beam while channelling; replaces the bolt sound | `PF.CHANNELING` in the snapshot; own press starts it early |
| ks_rogue | ratchet and five knives left to right | `keystoneProc` |
| ks_templar | swelling chime; hum a fifth above the hallowed bed, swaying at walking pace | `zone` `templar_consecrate` by a holder, until `zoneEnd` |
| ks_spellblade | wave of edge and air, three rising for the finisher | `keystoneProc`, `n` = waves |
| ks_shade | air drawn in, dark breath, whisper for the veil | `keystoneProc`; its `buff` is silent |

**Moment** (`keystone`, own hero): 0.42 s build, impact, 2.2 s tail in the family's timbre (movement = air and a run up the open chord, primary = struck steel in fifths, secondary = low bell and hummed chord, companion = glass notes answering left and right, win = horn call and drum, class = open voices, horn, bell). Replaced: two falling notes and a thud first. Allies: drum tap and the family's two notes.

**Draft**: own keystone draft opening plays a stinger (bell, suspended chord, one note left hanging; three weighing notes when both slots are full); while open, the calm interlude is replaced by a held, unresolved piece (`keydraft`). Hover and select use the existing interface sounds. A picked boon with `fits` adds a warm fifth and a glint to the pick sound.

**Power in the mix**: own primary / secondary gain a weight layer with one keystone, a sparkle layer with two.

**Score**: one voice per held keystone by family, on every fighting piece (combat, elite, three bosses, five objective pieces), from the next bar, transposed with the depth. A second keystone of the same family plays a denser variant.

The audio does not follow the `effects` setting (it never did), so allies are reduced by fixed gain as the brief's fallback says.

## Files

New: `client/src/audio/sfx-keystones.ts`, `client/src/audio/keystone-map.ts`, `tests/unit/audioKeystones.test.ts`.
Changed: `index.ts`, `music.ts`, `offline.ts`, `sfx.ts`, `sfx-kit.ts`, `manifest.ts` (generated), `client/src/dev/audiodemo.ts`, `tools/build-audio.mjs`, `docs/AUDIO.md` (new section 11), `credits.json`.

Samples: 175 files, 731,880 bytes (was 167 / 681,802; budget 900 kB). The old files are unchanged. Eight new files, 50,078 bytes, all from Kenney packs already in use (CC0 1.0, licence gate unchanged, no download):

| File | Bytes | Source |
|---|---|---|
| `zap.rise.1` | 9,083 | Digital Audio `zap_three_tone_up` |
| `zap.two.1/2` | 10,073 / 9,421 | Digital Audio `zap_two_tone`, `_2` |
| `pew.1/2` | 3,727 / 3,364 | Sci-Fi Sounds `laser_retro_000/002` |
| `tex.hum.1` | 9,049 | Sci-Fi Sounds `space_engine_small_000` (segment) |
| `question.1/2` | 2,888 / 2,473 | Interface Sounds `question_001/003` |

## Measurements

130 offline renders with samples and 93 with an empty bank (synth fallbacks): none silent, largest DC offset 2·10⁻⁴, highest peak −2.3 dBFS (the update 4 worst case).

**Signatures** (own hero; loudest 400 ms dBFS / centroid Hz):
ember_wake −16.9 / 3670 · shockstep −16.2 / 450 · phase_walker −16.6 / 6550 · ricochet −24.6 / 4960 · chain_lightning −26.2 / 4040 · heavy_hitter −15.0 / 600 · twin_cast −18.7 / 1370 · blood_price −17.7 / 700 · orbit_blades cut −32.4 / 11700 · familiar −27.6 / 4920 · colossus −14.2 / 210 · corpse_bloom −18.8 / 860 · resonance_engine −19.3 / 2930 · glass_cannon −21.6 / 1830 · sanguine −24.9 / 1560 · momentum_engine −23.3 / 720 · ks_knight −16.4 / 4580 · ks_barbarian −16.4 / 1500 · ks_mage tick −35.1 / 4870 · ks_rogue −23.6 / 6610 · ks_templar −20.0 / 1200 · ks_spellblade −18.8 / 3700 · ks_shade −15.9 / 1940.
For scale: own attacks −27 … −21, own hurt −16.3, Resonance about −13. Ally versions: ember_wake −27.7, shockstep −28.7, corpse_bloom −33.8, chain_lightning −38.8, ks_knight −23.6 (the loudest ally version).

**Closest pairs** (distance from centroid, attack time, sounding time and onset count; below 1 = same register and same gesture): ricochet ~ familiar 0.86, glass_cannon ~ sanguine 1.05, ricochet ~ ks_knight 1.10, ks_knight ~ ks_spellblade 1.12, chain_lightning ~ familiar 1.15, shockstep ~ heavy_hitter 1.24. Onset counts vary by ±1 between renders, so values near 1 move by about ±0.3. Ricochet and familiar differ in pitch direction (up vs down), which this measure does not see. All other pairs are further apart.

**Bloodrush** at 1 / 5 / 10 stacks: 18 / 24 / 41 onsets in 6 s, centroid 620 / 900 / 1350 Hz.

**Costs**: brittle hit −21.8 (centroid 3950); own hurt alone has a centroid of 590 Hz, hurt + brittle 2530 Hz. Titan swing −18.7, 0.14 s rise, 0.6 s long; swing + blow −14.2.

**Moment**: −12.8 … −13.7 across the six families; level-up fanfare −12.2 … −12.6; objective done with bonus −17.1; boon pick −23.1. Ally cue −25.8. Draft stinger −14.2 (full slots −15.0). Draft bed: RMS −22.2 (calm −22.6), centroid 700 vs 590 Hz, 5 vs 9 onsets in 14 s.

**Pick**: plain −26.5, fits one tag −24.8, three tags −23.5.

**Power layers** (0 / 1 / 2 keystones): knight primary −26.5 / −23.3 / −22.1; mage primary −24.9 / −22.5 / −21.7; shade primary −28.7 / −23.9 / −23.7; knight secondary −18.8 / −17.5 / −17.6 (centroid 1720 / 1810 / 2360 Hz). The mage's nova (−13.4) does not get louder.

**Loops**: blades' whirr −40.1 (RMS −43.1); own stream RMS −28.2, ally −38.9, and it fades 0.34 s after the last feed; sanctum hum RMS −28.0.

**Score**, level between 700 and 5000 Hz over 16 s of the combat piece: no keystone −35.9; one: companion −31.7, class −32.6, secondary −33.6, movement −33.8, win −33.9, primary −35.1; two: class + companion −29.8, secondary twice −30.0, movement + win −32.5, primary twice −33.7. Whole-mix RMS changes by at most +0.7 dB. With two voices the elite, Regent, Matron, depth 5 and all five objective pieces render within 0.6 dB RMS of their plain versions, peaks −2.8 … −4.8 dBFS.

**Worst case** (four heroes × two keystones at the sim's caps, corpse-bloom chains, chain lightning, ricochets, blade cuts and whirr, Bloodrush at ten stacks, both power layers, on top of the whole update 4 worst case, survive piece at full pressure, depth 5, two voices): peak −2.6 dBFS, loudest 400 ms −9.7. The update 4 worst case alone in the same run: −2.3 / −9.1. Live in Chrome: peak −3.2 dBFS. No clipping.

**Warnings against the keystone bed** (level in the cue's own band while it sounds, mean of three renders):

| | cue alone | fight without keystones | with the keystone layer | cue above bed, before → after | lift when the cue joins |
|---|---|---|---|---|---|
| bomber fuse, 5–12 kHz | −21.0 | −29.8 | −30.3 | +8.8 → +9.3 dB | +6.9 dB |
| reaver leap, 2–8 kHz | −27.2 | −24.1 | −24.7 | −3.1 → −2.5 dB | +1.1 dB |

The keystone layer does not move either bed. The fuse stands clear. The leap's whoosh was already below a fight this dense before update 5 and still is; that is an update 4 weakness this measurement exposed, not something keystones added.

**Live page** (headless Chrome, real `AudioContext`): 175 of 175 files decoded, every request carried `?v=`. A scripted run (combat → keystone draft → pick → combat → second draft → pick → survive → draft with full slots → replace → Matron) showed the piece, the voices and the loops switching as designed (`keydraft` while the draft is open, voices `companion` → `companion,win` → `win,class`, whirr on only in combat). All 23 keystones were triggered for the own hero and an ally with the sim's event shapes and the logged calls match the table above. 801 workbench events (267 per scene, 58 new, three scenes) fired; afterwards no loop, voice or enemy channel was left sounding. 0 console errors or warnings.

## Assumptions about the sim to confirm

- `keystoneProc` for `heavy_hitter` comes at the release of the swing, before its hits.
- A `heal` event for a Sanguine holder is always the pact's own leech (I silence all of that hero's heal sounds).
- The roster carries `keystones` before or right after the `keystone` event; I apply the event locally either way.
- `resonance_engine` sends `n` = 14 (charge gained), so I read the fill from the own snapshot's `ult`.
- `ks_barbarian` zones need no `zoneEnd` sound.

## Requested core additions

None required. Two would remove guesses, both for the sim engineer and the lead:

- A marker on hits dealt by an orbiting blade (or a `keystoneProc` for `orbit_blades` per cut, rate-limited like the rest).
- A `keystoneProc` for `colossus` (e.g. on its knock-back) and for `glass_cannon`, so allies' versions exist and the own hero's are tied to the effect instead of the button.

## For the lead, outside my files

- `docs/STATE.md` has no entry from me. Contract-relevant facts, all inside `client/src/audio`: new sfx methods (`keystoneProc`, `keystoneTaken`, `keystoneDraftOpen`, `fitsPick`, `powerLayer`, `brittleHit`, `titanSwing`, `orbitWhirr`, `stream`, `sanctumWalk` / `sanctumEnd`, `rushEnd`, `keystoneReset`); `Music.setKeystones` / `setKeystoneDraft`; `AudioDebug` gained `keystoneVoices`, `keystoneDraft`, `keystoneLoops`; `sfx.context`.
- `client/src/dev/uidemo.ts` currently fails the typecheck (`keystoneAt`, `chamberDamage` missing in its fixtures).

## Weaknesses

- A blade cut is guessed: any own hit more than 0.5 s after the last button press. Late projectiles, trail ticks and the familiar's bolts also count; cuts while attacking are not marked.
- Titan Grip's blow is the first hit by that hero within 0.9 s of the swing; a blade or familiar hit in that window takes its sound.
- Colossus and Glass Cannon ride on the own hero's actions only; allies holding them are silent apart from the brittle hits.
- The primary family's score voice is the weakest by measurement (+0.8 dB in its band with one keystone).
- Ricochet and familiar are the closest pair by the measure.
- The reaver's leap sits below a very dense fight in its band (see the table).
- Nothing is positioned in stereo from `x / z / tx / tz`. The sanctum hum is capped at 10 s.
- New samples were chosen by file name and measurement.

## Not verified

- Anything by ear. Only Chrome was run.
- A real server: all checks used the workbench's scripted events and simulated roster, draft and snapshot states.
- The full `npm test` and the build.
- Timing against the renderer's effects and the UI's draft animation.

Audition at `http://localhost:5177/?audiodemo` (`cd client && npx vite --port 5177 --strictPort`): section "Keystones (update 5)" (take / own / ally per keystone, drafts, picks), the keystone entries in "Game events on the bus", "KEYSTONE STRESS", and `window.__audiodemo.renderUpdate5()`, `.renderSignatures()`, `.renderMasking()`.
