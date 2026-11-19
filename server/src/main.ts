/** Process entry: reads the environment, starts the server, shuts down cleanly on SIGTERM / SIGINT. */
import { pathToFileURL } from 'node:url';
import { SERVER } from './config.ts';
import { consoleLogger } from './log.ts';
import { KEYSTONE_BY_ID } from '../../shared/src/data/keystones.ts';
import { OBJECTIVE_KINDS, type ObjectiveKind } from '../../shared/src/types.ts';
import { parseOrigins, startServer } from './server.ts';

export { startServer, parseOrigins, type RunningServer, type ServerOptions } from './server.ts';

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = raw === undefined ? NaN : Number.parseInt(raw, 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** DEBUG_OBJECTIVE: one of OBJECTIVE_KINDS, anything else is ignored. */
function parseObjective(raw: string | undefined): ObjectiveKind | undefined {
  return OBJECTIVE_KINDS.find((k) => k === raw);
}

/** DEBUG_KEYSTONES: comma separated keystone ids; unknown ids are ignored. */
function parseKeystones(raw: string | undefined): string[] | undefined {
  const ids = (raw ?? '').split(',').map((id) => id.trim()).filter((id) => KEYSTONE_BY_ID.has(id));
  return ids.length > 0 ? ids : undefined;
}

export async function main(): Promise<void> {
  const server = await startServer({
    port: envInt('PORT', SERVER.DEFAULT_PORT),
    allowedOrigins: parseOrigins(process.env.ALLOWED_ORIGINS),
    maxRooms: envInt('MAX_ROOMS', SERVER.DEFAULT_MAX_ROOMS),
    debugStartChamber: envInt('DEBUG_START_CHAMBER', 0),
    debugObjective: parseObjective(process.env.DEBUG_OBJECTIVE),
    debugKeystones: parseKeystones(process.env.DEBUG_KEYSTONES),
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

export function run(): void {
  main().catch((err: unknown) => {
    consoleLogger('error', 'fatal', { error: err instanceof Error ? err.message : 'unknown' });
    process.exit(1);
  });
}

// Start only when executed directly (`node dist/server.js`), not when imported by tests or other entries.
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) run();
