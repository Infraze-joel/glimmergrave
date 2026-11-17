# ADR 0001: Engine, stack and multiplayer topology

## Status
Accepted (2026-11-17). The hosting part is amended by ADR 0002 (backend on Netlify Server).

## Decision
- Three.js + TypeScript + Vite static frontend, hosted on Netlify.
- Dedicated authoritative Node.js WebSocket server (`ws`), hosted separately (any container host).
- Simulation code shared between both in `shared/`; binary snapshots at 15 Hz, inputs at 30 Hz.
- Top-down camera, stylised low-poly CC0 art (KayKit), procedural audio.

## Why
- Netlify serves static files and short-lived functions only; it cannot hold WebSocket connections or run a
  30 Hz game loop, so the backend must live elsewhere and be configured through `VITE_SERVER_URL`.
- An authoritative server (instead of P2P/WebRTC or relay-only rooms) is required for validated combat,
  consistent enemy state and basic cheat resistance.
- Plain `ws` instead of Colyseus/PartyKit: the protocol is small, we need a custom binary snapshot format
  anyway, and no vendor lock-in or paid service is involved.
- Top-down keeps melee hit detection readable under latency and avoids pointer-lock UX problems.

## Consequences
- Two deployables (frontend, backend). Room state lives in memory of one server process: horizontal scaling
  needs sticky routing per room code (documented as a known limitation).
- TCP head-of-line blocking under packet loss is accepted; interpolation delay hides normal jitter.
