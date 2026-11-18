# Milestones (compressed: one entry per milestone)

All milestones were delivered in one autonomous build; the user did not playtest. "Verified by" names the
evidence that exists. Feel and audio items that only a human can judge are marked as open.

| # | Milestone | Exit condition | Verified by | Status |
|---|---|---|---|---|
| 1 | Foundation: monorepo, contract, asset pipeline | `npm run dev` boots, assets load | scaffold smoke test, e2e "boots to the menu" | done |
| 2 | Authoritative simulation | bots finish runs deterministically | `shared/test/*` (bot runs, determinism, telegraph fairness, every ability and boon category) | done |
| 3 | Server: rooms, sessions, rejoin, validation | two socket clients complete a run | `server/test/*` (24 integration tests with real sockets, incl. a run at 150 ms latency) | done |
| 4 | Render kit | all entities, VFX and chamber moods render within budget | showcase harness, in-game screenshots, perf probe (137 draw calls / 245k tris at 47 enemies) | done; human visual pass open |
| 5 | UI flow + i18n | every screen reachable in EN and DE | uidemo screenshots, e2e flows | done |
| 6 | Audio | music states and SFX schedule without errors | offline renders (non-silent, no clipping) | done; listening pass open |
| 7 | Client integration: prediction, interpolation, reconnect | two browsers play together | `tests/e2e/game.spec.mjs` (12 tests, production build, same origin) | done |
| 8 | Release: Netlify config, Dockerfile, docs | production build has no local URLs; headers and 404 page work | build scan, `scripts/serve-dist.mjs` emulation | done; real deployment open |
| 9 | Single-origin hosting on Netlify Server (ADR 0002) | page and WebSocket on one address | Netlify bundler + `@netlify/dev` emulator probe, e2e over `/ws` | done; real deployment open |

| 10 | Update 2: permanent upgrades, wardrobe, three bosses + heralds, three biomes with hazards, training, codex, sample-based audio | a new player completes training; a run pays Glimmer that buys an upgrade | 311 unit/integration tests, 14 browser tests, showcase/uidemo/audiodemo harnesses | done; human playtest and listening pass open |

| 11 | Update 3: seven classes with arts and ultimates, umbra and six reactions, sets, mastery, Ascension, relics, Chronicle, endless descent ([spec](update-3.md)) | a run with a new class pays XP and relics that are spent on talents, slots and ranks; the party can descend | 435 unit/integration tests, 19 browser tests, bot run with descent in the browser, showcase/uidemo/audiodemo harnesses | done; human playtest and listening pass open |

| 12 | Update 4: six chamber objectives shown on the doors, five enemy kinds, warded enemies, interrupt event ([spec](update-4.md)) | a run asks for something other than killing waves in several chambers and the screen says what to do | 508 unit/integration tests, 20 browser tests (one on a pinned objective), live bot session per objective, showcase/uidemo/audiodemo harnesses | done; human playtest and listening pass open |

`npm test` runs 508 tests in total. Regression suite before any change is called done: `npm run typecheck && npm run lint && npm test && npm run test:e2e`.
