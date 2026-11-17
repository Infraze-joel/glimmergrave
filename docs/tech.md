# Tech stack

| Part | Choice | Why |
|---|---|---|
| Language | TypeScript 7 (strict, `erasableSyntaxOnly`) | one language for client, server and shared simulation |
| Rendering | Three.js r187, WebGLRenderer | broadest browser support; no WebGPU-only features needed |
| Build | Vite 8 (client), esbuild (server bundle) | fast, static output for Netlify |
| Server | Node 22 + `ws` | tiny authoritative WebSocket server, deployable anywhere that runs a container |
| Tests | Vitest (unit + integration), node:test + puppeteer-core (browser e2e) | |
| Assets | KayKit packs (CC0) optimised with glTF-Transform (meshopt) | see docs/ASSETS.md |
| Audio | Web Audio API, procedural | zero downloads, no licensing risk |

## Layout

```
shared/src        pure TypeScript shared by client and server (no DOM, no Node APIs)
  constants.ts    net + world tuning         types.ts    domain types, wire codes
  protocol.ts     JSON messages + binary codecs
  data/           balance tables: classes, enemies, boons
  sim/            authoritative simulation (World) + movement shared with client prediction
server/src        rooms, sessions, validation, tick loop (uses shared/sim)
client/src
  core/           EventBus, GameState, Settings, config   (contract — do not bypass)
  net/            WebSocket client, prediction, interpolation
  render/         Three.js scene, characters, level, VFX, camera
  game/           orchestrator, input
  ui/             DOM overlays (menu, lobby, HUD, draft, settings, summary), i18n
  audio/          procedural music + SFX
tools/            asset pipeline          tests/e2e   browser tests
```

## Architecture rules

1. **Server authority.** Clients send only inputs and intents. The server simulates everything at 30 Hz and
   validates every message (`parseClientMsg`, `decodeInput`). The client never decides damage, cooldowns or loot.
2. **Shared simulation.** `shared/src/sim` is deterministic TypeScript with a seeded RNG. The client imports only
   `sim/movement.ts` (prediction). Fixed timestep `TICK_DT` everywhere.
3. **Netcode.** Own hero: client-side prediction + reconciliation against `SelfState.ackSeq`. Everything else:
   snapshot interpolation `NET.INTERP_DELAY_MS` in the past. Events (`ev`) drive VFX/SFX only.
4. **Client modules talk through `core/EventBus.ts` and `core/GameState.ts` only.**
5. **No magic numbers** in logic: tuning lives in `shared/src/constants.ts`, `shared/src/data/*`, or a
   module-level `const CONFIG` block for purely visual values.
6. **No enums / parameter properties / namespaces** (`erasableSyntaxOnly`). Use `as const` objects and unions.
   Imports include the `.ts` extension. Shared code is imported as `@shared/...`.
7. **Restart-safe.** Leaving a session disposes all Three.js resources created for it and resets GameState.
8. **Test hooks.** `window.render_game_to_text()` returns a JSON string of the visible game state;
   `window.__game` exposes debug handles in dev/e2e builds.
