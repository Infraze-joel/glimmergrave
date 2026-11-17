// Serves client/dist roughly the way Netlify will: response headers from the [[headers]] blocks of netlify.toml,
// 404.html for unknown paths, and /ws/* forwarded to a game server (standing in for Netlify Server).
// Used by the e2e tests to verify routes, the CSP and same-origin WebSockets locally.
// Usage: node scripts/serve-dist.mjs [port] [gameServerPort]
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const dist = join(root, 'client/dist');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.glb': 'model/gltf-binary',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.wasm': 'application/wasm', '.ico': 'image/x-icon',
};

/** Minimal reader for the [[headers]] blocks of netlify.toml. */
function readHeaderRules() {
  const text = readFileSync(join(root, 'netlify.toml'), 'utf8');
  const rules = [];
  for (const block of text.split('[[headers]]').slice(1)) {
    const body = block.split(/\n\[\[/)[0];
    const path = /for\s*=\s*"([^"]+)"/.exec(body)?.[1];
    if (!path) continue;
    const values = {};
    for (const m of body.matchAll(/^\s*([A-Za-z-]+)\s*=\s*"((?:[^"\\]|\\.)*)"\s*$/gm)) if (m[1] !== 'for') values[m[1]] = m[2];
    rules.push({ path, values });
  }
  return rules;
}

const rules = readHeaderRules();
const matches = (pattern, url) => (pattern.endsWith('/*') ? url.startsWith(pattern.slice(0, -1)) : pattern === url);

/**
 * `upstreamPort`: port of a game server on 127.0.0.1 that receives everything under /ws/ (HTTP and WebSocket
 * upgrades), like the `path: '/ws/*'` setting of the Netlify Server entry. 0 = no backend (those paths 404).
 * `httpUpstreamPort` lets tests send plain HTTP to the server directly while WebSockets pass a lag proxy.
 */
export function startStatic(port = 4173, upstreamPort = 0, httpUpstreamPort = upstreamPort) {
  const isServerPath = (url) => url === '/ws' || url.startsWith('/ws/');
  const server = createServer((req, res) => {
    const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
    if (upstreamPort && isServerPath(url)) {
      const proxied = request({ host: '127.0.0.1', port: httpUpstreamPort, path: req.url, method: req.method, headers: req.headers }, (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      });
      proxied.on('error', () => res.writeHead(502).end());
      req.pipe(proxied);
      return;
    }
    let file = normalize(join(dist, url));
    if (!file.startsWith(dist)) { res.writeHead(403).end(); return; }
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    let status = 200;
    if (!existsSync(file)) { status = 404; file = join(dist, '404.html'); }
    const headers = { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' };
    for (const rule of rules) if (matches(rule.path, url)) Object.assign(headers, rule.values);
    res.writeHead(status, headers).end(readFileSync(file));
  });
  server.on('upgrade', (req, socket, head) => {
    if (!upstreamPort || !isServerPath((req.url ?? '/').split('?')[0])) { socket.destroy(); return; }
    const up = connect(upstreamPort, '127.0.0.1', () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      up.write(lines.join('\r\n') + '\r\n\r\n');
      if (head.length > 0) up.write(head);
      socket.pipe(up);
      up.pipe(socket);
    });
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
  });
  return new Promise((ok) => server.listen(port, () => ok({ port: server.address().port, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) })));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { port } = await startStatic(Number(process.argv[2] ?? 4173), Number(process.argv[3] ?? 0));
  console.info(`serving client/dist with netlify.toml headers on http://localhost:${port}`);
}
