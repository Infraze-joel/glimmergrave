/**
 * Entry for hosting on Netlify Server: bundled into netlify/server/game-server.generated.mjs and imported by
 * netlify/server/index.mjs. Netlify sets PORT and expects an HTTP server listening on it shortly after import.
 */
import { run } from './main.ts';

run();
