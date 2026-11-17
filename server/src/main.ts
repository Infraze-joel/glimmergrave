/** Process entry: reads the environment, starts the server, shuts down cleanly on SIGTERM / SIGINT. */
import { pathToFileURL } from 'node:url';
import { SERVER } from './config.ts';
import { consoleLogger } from './log.ts';
import { parseOrigins, startServer } from './server.ts';

export { startServer, parseOrigins, type RunningServer, type ServerOptions } from './server.ts';

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = raw === undefined ? NaN : Number.parseInt(raw, 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

async function main(): Promise<void> {
  const server = await startServer({
    port: envInt('PORT', SERVER.DEFAULT_PORT),
    allowedOrigins: parseOrigins(process.env.ALLOWED_ORIGINS),
    maxRooms: envInt('MAX_ROOMS', SERVER.DEFAULT_MAX_ROOMS),
    debugStartChamber: envInt('DEBUG_START_CHAMBER', 0),
  });
  let stopping = false;
  const stop = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    consoleLogger('info', 'shutdown', { signal });
    void server.close().then(() => process.exit(0));
    // Do not hang forever on a stuck socket.
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main().catch((err: unknown) => {
    consoleLogger('error', 'fatal', { error: err instanceof Error ? err.message : 'unknown' });
    process.exit(1);
  });
}
