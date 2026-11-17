# State

- Phase: release candidate. All milestones in `docs/milestones/README.md` are done; quality gate passed locally.
- Last session: integrated backend, render kit, UI/audio; added browser e2e suite, QA start-chamber option,
  perf probe; wrote README.
- Hosting changed to single-origin Netlify Server (ADR 0002); verified with Netlify's bundler and local
  emulator only.
- Not done (needs credentials / hardware): deploy to Netlify, check `/ws/health`, then repeat README section 15
  with two machines over the internet; measure FPS on real GPUs; listen to the audio;
  test Firefox and Edge.
- Next concrete step: connect the repo to Netlify, deploy, run the two-client check.
- Deferred ideas live in `docs/backlog.md`.

## Backend notes

- `World` (shared/src/sim/world.ts) is stepped by `Room` (server/src/room.ts) at 30 Hz; snapshots every 2 ticks.
- `startServer(opts)` (server/src/server.ts) is what tests use in-process; `main.ts` reads the environment.
- `bossPhase.phase` is 1-based (2 and 3 are emitted at the thresholds).
- Reviving is proximity-based; `BTN.INTERACT` exists in the protocol but is unused.
