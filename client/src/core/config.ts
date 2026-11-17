/** Build-time configuration. See .env.example. */
const fromEnv = (import.meta.env.VITE_SERVER_URL as string | undefined)?.trim() ?? '';

function sameOrigin(): string {
  const secure = window.location.protocol === 'https:';
  return `${secure ? 'wss' : 'ws'}://${window.location.host}/ws/game`;
}

/**
 * WebSocket URL of the multiplayer backend.
 *  - VITE_SERVER_URL set: an external backend (wss://…), e.g. the Docker container on another host.
 *  - unset in production: the backend lives on the same origin under /ws (Netlify Server, see netlify/server).
 *  - unset in `vite dev`: port 8787 on the host that served the page, so LAN devices can join a dev session.
 */
export const SERVER_URL: string =
  fromEnv !== '' ? fromEnv : import.meta.env.DEV ? `ws://${window.location.hostname}:8787` : sameOrigin();
