# Assets and licences

All 3D models, textures and animations come from three packs by **Kay Lousberg (KayKit)**, released under
**Creative Commons Zero (CC0 1.0)** — free for personal, educational and commercial use, no attribution required.

| Pack | Source | Used for |
|---|---|---|
| KayKit Adventurers 1.0 | https://github.com/KayKit-Game-Assets/KayKit-Character-Pack-Adventures-1.0 | heroes, hero animations, arrow, dagger |
| KayKit Skeletons 1.0 | https://github.com/KayKit-Game-Assets/KayKit-Character-Pack-Skeletons-1.0 | enemies, enemy animations and weapons |
| KayKit Dungeon Remastered 1.0 | https://github.com/KayKit-Game-Assets/KayKit-Dungeon-Remastered-1.0 | floors, walls, props |

The files in `client/public/assets/models` are produced by `tools/build-assets.mjs` (animation subsetting,
quantisation, meshopt compression). To rebuild: clone the three repositories into one folder and run
`npm run assets -- <folder>`.

Audio is synthesised at runtime with the Web Audio API; there are no audio files.
