# Render kit — Update 5 "Keystones" report

All 23 keystones have their own drawing, plus the keystone moment, emblems, three showcase modes. Built against the sim
engineer's client notes in `backend-update5.md` (the version dated Nov 18, "work in progress"). `npx tsc -p client --noEmit |
grep -E "src/render|src/dev/showcase"` prints nothing, `npx eslint client/src/render client/src/dev/showcase.ts` is clean,
no capture logged a console error or warning. **Nothing was run against the real simulation**: every event came from the
showcase script, written from those notes. Nothing committed by me.

## For the lead (boot.ts)
- `view.setRoster(entries)`: pass `keystones: entry.keystones` in each entry, and call it again whenever the roster is
  re-broadcast. Without it there are no emblems, blades, familiar, size, stream or walking sanctum (the one-shot effects and
  the pillar still work from the events; `keystone` also adds the id locally until the roster arrives).
- Everything else arrives through `handleEvent` (`keystone`, `keystoneProc`, `buff` ids `phase_walker` / `ks_shade`,
  `zone` kind `ks_barbarian`, `chamberClear`) and `syncPlayers` (`PF.CHANNELING`).

## API additions (existing calls unchanged)
- `RosterView.keystones?: readonly string[]`.
- `getDebug().keystones` (wakes + links + ghosts in play).
- Render-internal: new `render/keystones.ts` (`KeystoneFx`, `KEYSTONE_COLOR`); decal shapes `BLADE, WAKE, FRACTURE,
  VORTEX, BOLT, THREAD` (24–29), sprite modes `COLUMN, FIGURE` (10, 11); `Atlas.emblems` (23 glyphs in two free atlas
  rows, no size change); `Vfx.soften(f)`; `AbilityFx.sanctum[]`; `Heroes.primarySlow[]`; `HeroView.size / veil / keyRim /
  keyGlow / maxHp / outfitScale`.
- No new draw call, mesh, material or texture; no asset change (`docs/ASSETS.md` untouched). Pools are preallocated
  (20 trails, 48 links, 28 ghosts); no per-frame allocation.

## Per keystone: what is drawn, from what
Own hero = full; another hero on `clear` / `minimal` = the reduced version in brackets.

| Keystone | Source | Drawing |
|---|---|---|
| ember_wake | `keystoneProc {x,z → tx,tz, r}` | scorched lane with flames for 3.5 s in the dash element's colour, max 4 per hero, out on `chamberClear` (dashed outline of the lane); heel embers while running |
| shockstep | `keystoneProc {x,z,r}` | crackling shock ring, dust, in the dash element's colour (thin ring) |
| phase_walker | proc at the enemy + `buff phase_walker` | ghost figure at the enemy and half way; violet body rim, a ring that runs down with the window, a gold star at the weapon; a burst when the next crit `hit` of that hero lands |
| ricochet | proc per bounce | line between the two points with a spinning blade flying along it; a small blade circling the weapon hand |
| chain_lightning | proc per arc | jagged bolt between struck enemy and target in the primary element's colour (default pale violet); arcs crackling at the weapon hand |
| heavy_hitter | `cast` + `hit` (the proc itself draws nothing) | swing 20 % longer, 40 % wider, 1/0.55 slower (clip slowed too), a second gold crescent, dust; gold ring, cracks and rubble where its hits land; gold glow at the weapon |
| twin_cast | `cast` of a secondary, then proc (or 0.6 s timeout) | ghost figure steps out beside the hero for the delay, then the cast's own effect is drawn again in ghost blue at 65 % (never for leaps / lunges); a faint twin at the shoulder (own only) |
| blood_price | proc `n` | crimson pulse on the body, ring closing on the hero, drops, a chip off the health bar, the cost as a number (own) |
| orbit_blades | roster + snapshot tick | three flat swords at radius 2.6 (×1.4 with colossus), angle = the notes' formula, element-tinted, shadows, light trails and path ring (blades and shadows only) |
| familiar | roster; shots from proc | orb with halo, tail and motes at the shoulder; a bolt from the wisp to `tx,tz` (core only) |
| colossus | roster | body ×1.25 eased in, label / ring / marker follow, bronze ring, dust and a floor ring per stride, drawn swings and spins 40 % larger |
| corpse_bloom | proc `{x,z,r,n}` (+ `kill` memory for the colour) | burst with six petals in the colour of the status the corpse carried; at most 4 own / 2 ally full blooms per 0.4 s, the rest a thin ring |
| resonance_engine | `resonance` by the holder / proc | gold arc around the hero showing the ultimate charge; a bead runs from the burst to the hero, the arc flares |
| glass_cannon | roster + `hit` | cracked crystal plate under the hero, three splinters circling, pale rim; every hit throws shards and a hard white star |
| sanguine | `hit` by the holder; `PlayerSnap.shield` | motes with a thread from struck enemies into the hero; rose rings and hoop while a shield is up |
| momentum_engine | proc `n` = stacks | yellow arc = stacks (blinks before it runs out), speed streaks growing with stacks, after-images from 4 stacks, yellow rim |
| ks_knight | proc `{x,z,r}` | ring of shield plates thrown outwards, shock ring |
| ks_barbarian | proc (whirl) / `zone ks_barbarian` (leap) | spiral arms turning inwards with sparks pulled to the middle, following the hero / standing where the leap landed; whirl slashes run 50 % longer |
| ks_mage | `PF.CHANNELING` | beam along `rot`, 13 m, cut at the chamber's outer walls, element-tinted; no per-bolt muzzle flash (thin line) |
| ks_rogue | `cast` count + proc | pips behind the hero for bolts 1–3, after the 4th five knives hang in a fan in front of the hero; the fan flourish on the proc |
| ks_templar | roster + `zone templar_consecrate` | the zone is moved to the hero every frame, with a second counter-turning wheel and four rim lights |
| ks_spellblade | proc `n` | crescent and streak per extra wave, three fanned for the finisher |
| ks_shade | `buff ks_shade` + proc at the victim | body dithered to 42 % with a pale rim and a countdown ring for the owner; 16 % plus a faint figure and floor hoop for others; smoke from the victim to the shade; a burst on the next hit |

Silhouette: an emblem per held keystone left / right of the health bar (pops when taken) and an arc in the keystone's
colour on the hero's ring. Keystone moment: `keystone` → column of light for 1 s, rune, rings, motes, the emblem popping
above the head; for other heroes a thin column.

## Assumptions and deviations to confirm with the sim engineer
- Twin Cast: I replay the visual of the `cast` I saw when the `twin_cast` proc arrives (matched by slot only). If the
  proc comes without a preceding cast, only a ring at the proc position is drawn.
- Familiar: the notes fire the `arcBolt` from the hero's position; my bolt line starts at the wisp, so both are visible.
- Arc Stream is cut at the room's outer rectangle only, not at shot-blocking obstacles (the render kit has no collision data).
- Ricochet with Arc Stream (fork from the last enemy) uses the ordinary bounce line.
- Rogue tell counts `cast` events of the rogue's projectile primary and resets on the proc; a boon that changes bolts per
  cast would put it out of step until the next fan.
- Phase Walker's window ends visually on the first crit `hit` by that hero; Veil ends on the first hit.
- Heavy swing: length ×1.2 and angle ×1.4 as in the notes; the barbarian's held `secondary` animation for 2.1 s is NOT done
  (only the slash effects run longer).
- Sanguine's own proc only draws a small ring; `colossus` and `glass_cannon` need no events.
- `keystoneProc` ids I do not know are ignored.

## Budgets (high quality, SwiftShader)
| Scene | Draw calls | Decals | FX sprites | UI sprites | Near-white blocks / largest group |
|---|---|---|---|---|---|
| polish-1 fight, seed 7, 6.8 s / 7.15 s, no keystones | 140 / 141 | 412 / 433 | 1136 / 1127 | 168 / 147 | 4 / 1 and 3 / 1 |
| same, four heroes × two keystones (`ks=1`) | 140 / 141 | 446 / 473 | 1143 / – | 184 / – | 5 / 1 and 4 / 2 |
| stress crypt seed 7, 6 s, without / with keystones | 138 / 138 | 344 / 370 | 974 / 977 | 147 / 163 | 4 / 2 and 4 / 2 |
Budget 150. The fight pair was measured before the last tone-down of the shield burst and triple wave; the stress pair after.
Frame rate cannot be judged here.

## Showcase
`demo=keystone&id=ID[&id2=ID][&view=ally][&moment=1][&cls=][&infuse=]`, `demo=compare[&id=&id2=]`, `ks=1` with
`mode=stress|fight`. The keystone demo runs once at `at` (no loop).

## Screenshots (`/tmp/render5-*.png`)
I looked at every one of these, most as 640 px thumbnails on contact sheets; full size: ember_wake, orbit_blades,
chain_lightning, twin_cast-ghost (earlier version), fight-ks-a, compare-1-vs-8, stress-ks (version before the last tone-down).
- One per keystone: `ember_wake, shockstep, phase_walker, ricochet, chain_lightning, heavy_hitter, twin_cast-ghost,
  twin_cast-echo, blood_price, orbit_blades, familiar, colossus, corpse_bloom, resonance_engine, glass_cannon, sanguine,
  momentum_engine, ks_knight, ks_barbarian, ks_mage, ks_rogue-tell, ks_rogue-fan, ks_templar, ks_spellblade-1,
  ks_spellblade-3, ks_shade`.
- `moment-own`, `moment-ally`; ally views `ally-orbit-familiar, ally-wake-shockstep, ally-stream-chain, ally-veil-glass`;
  pairs `pair-wake-chain, pair-colossus-blades, pair-maelstrom-sanguine`; `compare-1-vs-8`;
  `fight-ks-a/b`, `fight-base-a`, `stress-ks`, `stress-base`.
- Not final versions: `ricochet` (taken before the line was widened and given a ring), `ember_wake`, `shockstep`,
  `heavy_hitter`, `blood_price`, `glass_cannon`, `ks_mage`, `ks_rogue-*`, `ks_templar`, `ks_shade`, `momentum_engine`,
  `colossus`, `corpse_bloom`, `twin_cast-echo` and all ally / pair shots except `pair-maelstrom-sanguine` were taken
  before the emblem was enlarged or later small tweaks (ghost head shape, pillar strength); their effects are unchanged.
  `moment-ally` shows the older, weaker pillar fade.

## My judgement: would a player notice and understand it?
- Clear at a glance: ember_wake, shockstep, chain_lightning, heavy_hitter, orbit_blades, corpse_bloom, glass_cannon,
  momentum_engine, ks_knight, ks_barbarian, ks_mage, ks_rogue (tell and fan), ks_spellblade, colossus, compare scene.
- Readable but quieter: phase_walker, twin_cast (ghost figure is plain), familiar, blood_price, ks_shade, ks_templar
  (captured during its birth flash; the following and the extra wheel were not looked at in a later frame).
- Weak: **sanguine** (the motes are small; the shield rings carry it), **resonance_engine** (the bead and arc are easy to
  miss next to the Resonance burst itself), **ricochet** (a thin line in the frame I saw; the widened version was not reopened).

## Weaknesses
- The maelstrom is 10 m across (the sim's pull reach of 5) and dominates the screen for the barbarian's owner.
- The emblems are 0.5 m glyphs; at normal zoom they tell "two keystones, these colours" more than "which ones".
- Ghost figures are a generic silhouette, not the hero's model.
- The ally stream ends in a bright flare at the wall; ally reduction of the stream is weaker than for other keystones.
- The colossus name label is partly covered by the find-yourself chevron.
- Crimson (blood_price, sanguine) is a rose red, kept non-telegraph by shape and hue but the closest friendly colour to hostile red.
- Clarity level changes apply to new effects only (as before).

## Not verified
- Real session, boot.ts wiring, real event timing and frequency, late join.
- `minimal` and `full` clarity with keystones, medium / low quality (a medium stress capture timed out and was not repeated).
- Motion: everything was judged from frozen frames (blade rotation, stream flicker, trail burn-out, vortex spin, veil fade).
- Trail removal on `chamberClear`, the 4-trail cap, keystone replace (`replaced`), `zone ks_barbarian`, Walking Sanctum
  following over time, Blood Price + Twin Cast together, leak check across sessions.
- `npm test`, `npm run build`, full lint (the full client typecheck printed 0 errors when I ran it). `docs/STATE.md` not touched.

Changed: `client/src/render/{keystones(new),index,batches,atlas,characters,abilityfx,vfx}.ts`, `client/src/dev/showcase.ts`.
