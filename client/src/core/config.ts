/** Build-time configuration. See .env.example. */
const fromEnv = (import.meta.env.VITE_SERVER_URL as string | undefined)?.trim() ?? '';

/**
 * WebSocket URL of the multiplayer backend.
 * Production builds REQUIRE VITE_SERVER_URL (wss://…). In `vite dev` it falls back to port 8787 on the
 * host that served the page, so LAN devices can join a dev session.
 */
export const SERVER_URL: string =
  fromEnv !== '' ? fromEnv : import.meta.env.DEV ? `ws://${window.location.hostname}:8787` : '';

export const SERVER_CONFIGURED = SERVER_URL !== '';
