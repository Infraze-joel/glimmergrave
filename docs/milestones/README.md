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
| 7 | Client integration: prediction, interpolation, reconnect | two browsers play together | `tests/e2e/game.spec.mjs` (11 tests, production build) | done |
| 8 | Release: Netlify config, Dockerfile, docs | production build has no local URLs; headers and SPA fallback work | build scan, `scripts/serve-dist.mjs` emulation | done; real deployment open |

`npm test` runs 183 tests in total. Regression suite before any change is called done: `npm run typecheck && npm run lint && npm test && npm run test:e2e`.
