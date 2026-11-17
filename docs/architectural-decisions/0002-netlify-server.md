# ADR 0002: Host the multiplayer backend on Netlify Server

## Status
Accepted (2026-11-17). Amends ADR 0001 ("backend must live elsewhere").

## Context
ADR 0001 separated frontend (Netlify) and backend (container host) because Netlify could not hold WebSocket
connections. On 2026-11-10 Netlify announced Netlify Server (Early Access): a long-lived Node.js process deployed
with the site that supports WebSockets, including servers built on `ws` that listen on `PORT`. The project owner
asked for a simpler setup than running a second service.

## Decision
- Default hosting is single-origin on Netlify: static client plus `netlify/server/index.mjs`, which imports the
  bundled game server. Config: region `fra`, size `small`, `scale.max = 1`, `path = /ws/*`.
- The client connects to `/ws/game` on its own origin unless `VITE_SERVER_URL` names an external backend.
- The Docker image stays as a supported alternative; server code is identical for both.
- The catch-all rewrite to `index.html` is removed (it would intercept `/ws/*`); a `404.html` returns to `/`.
- The "server not configured" UI state is removed: there is always a default address.

## Consequences
- One deploy, no environment variables, no CORS/origin setup.
- Platform limits now shape sessions: connections end after 30 min (auto-rejoin covers it), instances are
  replaced after 8 h and on every deploy (running rooms are lost), cold start after 5 min idle.
- `scale.max` must stay 1 while rooms live in process memory.
- Early Access: behaviour and pricing may change; not yet verified on the real platform, only with Netlify's
  bundler and local emulator.
- Netlify builds need Node 24.
