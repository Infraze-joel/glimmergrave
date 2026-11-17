import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { startServer, type RunningServer } from '../src/server.ts';

/** Resolves true if the WebSocket handshake succeeds, false if the server rejects it. */
function handshake(url: string, origin: string): Promise<boolean> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers: { origin } });
    ws.once('open', () => { ws.close(); resolve(true); });
    ws.once('error', () => resolve(false));
  });
}

describe('single-origin hosting (Netlify Server)', () => {
  let server: RunningServer | undefined;
  afterEach(async () => { await server?.close(); server = undefined; });

  it('accepts a page served from the same host even when it is not on the allow list, on /ws/game', async () => {
    server = await startServer({ port: 0, allowedOrigins: ['https://elsewhere.example'], log: false });
    const host = `127.0.0.1:${server.port}`;
    expect(await handshake(`ws://${host}/ws/game`, `http://${host}`)).toBe(true);
    expect(await handshake(`ws://${host}/ws/game`, 'https://elsewhere.example')).toBe(true);
    expect(await handshake(`ws://${host}/ws/game`, 'https://evil.example')).toBe(false);
    expect(await handshake(`ws://${host}/not-a-game-path`, `http://${host}`)).toBe(false);
  });

  it('serves the health report under the /ws prefix as well', async () => {
    server = await startServer({ port: 0, log: false });
    for (const path of ['/health', '/ws/health']) {
      const res = await fetch(`http://127.0.0.1:${server.port}${path}`);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
    }
  });
});
