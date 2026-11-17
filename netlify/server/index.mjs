// Netlify Server entry (https://docs.netlify.com/build/server/). Netlify imports this file in a long-lived
// Node.js process and sets PORT; the game server below starts its own HTTP + WebSocket server on that port.
//
// game-server.generated.mjs is the bundled game server (server/src/main.ts + shared simulation + ws).
// It is produced by `npm run build:netlify-server`, which the Netlify build command runs.
import './game-server.generated.mjs';

export const config = {
  // Frankfurt. The other region is "cmh" (US East).
  region: 'fra',
  size: 'small',
  // Rooms live in the memory of one process, so every player must reach the same instance.
  scale: { max: 1 },
  // Everything else on the site is the static game client. Client connects to /ws/game; /ws/health reports status.
  path: '/ws/*',
};
