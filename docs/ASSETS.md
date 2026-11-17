# Assets and licences

All 3D models, textures and animations come from three packs by **Kay Lousberg (KayKit)**, released under
**Creative Commons Zero (CC0 1.0)** — free for personal, educational and commercial use, no attribution required.

| Pack | Source | Used for |
|---|---|---|
| KayKit Adventurers 1.0 | https://github.com/KayKit-Game-Assets/KayKit-Character-Pack-Adventures-1.0 | heroes incl. every gear variant in the files (looks), the hooded rogue head, hero animations, arrow, dagger |
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
