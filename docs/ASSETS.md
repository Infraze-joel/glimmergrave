# Assets and licences

All 3D models, textures and animations come from three packs by **Kay Lousberg (KayKit)**, released under
**Creative Commons Zero (CC0 1.0)** — free for personal, educational and commercial use, no attribution required.

| Pack | Source | Used for |
|---|---|---|
| KayKit Adventurers 1.0 | https://github.com/KayKit-Game-Assets/KayKit-Character-Pack-Adventures-1.0 | heroes incl. every gear variant in the files (looks), the hooded rogue head, hero animations, arrow, dagger, one- and two-handed sword, round shield, quiver |
| KayKit Skeletons 1.0 | https://github.com/KayKit-Game-Assets/KayKit-Character-Pack-Skeletons-1.0 | enemies and all three bosses, enemy animations, weapons, quiver, buckler |
| KayKit Dungeon Remastered 1.0 | https://github.com/KayKit-Game-Assets/KayKit-Dungeon-Remastered-1.0 | floors (stone, dirt), walls, props, biome dressing, wardrobe diorama |

The files in `client/public/assets/models` are produced by `tools/build-assets.mjs` (animation subsetting,
quantisation, meshopt compression). To rebuild: clone the three repositories into one folder and run
`npm run assets -- <folder>`.

Audio is synthesised at runtime with the Web Audio API; there are no audio files.

## Update 2 subset

Added to the pipeline (same three CC0 packs, no new sources); total model payload 4.78 MB (budget 6 MB):

- `hero_rogue_hooded.glb` — `Rogue_Hooded.glb`, used when a rogue's look shows the hood.
- `anims_skel.glb` — additional clips `Spellcasting`, `Jump_Start`, `Jump_Idle`, `Jump_Land`, `2H_Ranged_Shooting`.
- `dungeon.glb` — `floor_dirt_small_A..D`, `floor_dirt_small_weeds`, `floor_tile_grate`, `keg_decorated`,
  `barrel_large_decorated`, `table_long`, `trunk_small_A`, `chair`, `stairs_wide`, `wall_archedwindow_gated`,
  `banner_patternA_green`, `banner_blue`, `banner_patternB_red`, `banner_brown`, `banner_triple_yellow`,
  `coin_stack_small`, `candle_melted`, `plate_stack`, `shelf_small_candles`.
- `props.glb` — `Skeleton_Quiver`, `Skeleton_Shield_Small_B`.

Everything else that is new on screen is generated in code and has no external source: boss dressing (robe, mitre,
halo shards, antlers, trophy bones), sarcophagi, stalagmites, anvils, chains, the pedestal, hazard fixtures and
spikes, water and lava surfaces, and all VFX.

## Update 3 subset

Added to the pipeline (same three CC0 packs, no new sources); total model payload 4.94 MB (budget 6 MB). Only
`anims_hero.glb` (1.08 -> 1.17 MB) and `props.glb` (139 -> 182 KB) changed:

- `anims_hero.glb` — additional clips `Dualwield_Melee_Attack_Stab`, `Dualwield_Melee_Attack_Slice`,
  `Dualwield_Melee_Attack_Chop` (shade) and `PickUp` (rogue snare).
- `props.glb` — from the Adventurers pack `sword_1handed` (spellblade), `sword_2handed_color` (templar, ornate style),
  `shield_round_color` as `shield_round` (the knight's thrown shield) and `quiver` (shade, style 2).

The three new classes have no model files of their own. They are baked from the existing hero bodies:
templar = `hero_knight.glb` (meshes `2H_Sword`, `Rectangle_Shield`, helmet, cape), spellblade = `hero_mage.glb`
(`Spellbook_open`, `Spellbook`, `1H_Wand`, hat, cape), shade = `hero_rogue.glb` / `hero_rogue_hooded.glb` (`Knife`,
`Knife_Offhand`, `1H_Crossbow`, cape). The one-handed sword uses the knight palette; it is baked into the mage body by
reading that palette once per vertex.

Generated in code, no external source: the templar's pauldrons, tabard, belt and helmet crest, the spellblade's rune
shards, the shade's scarf, every new icon in the sprite atlas (wither, mark, descend, ascend, bell and the four affix
icons) and all new VFX (zones, traps, banner, falling star, reactions, door surfaces).

