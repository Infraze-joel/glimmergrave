// Serves client/dist the way Netlify will: SPA fallback from netlify.toml [[redirects]] and the response
// headers from its [[headers]] blocks. Used by the e2e tests to verify routes and the CSP locally.
// Usage: node scripts/serve-dist.mjs [port]
import { createServer } from 'node:http';
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

export function startStatic(port = 4173) {
  const server = createServer((req, res) => {
    const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
    let file = normalize(join(dist, url));
    if (!file.startsWith(dist)) { res.writeHead(403).end(); return; }
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(dist, 'index.html'); // SPA fallback (status 200)
    const headers = { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' };
    for (const rule of rules) if (matches(rule.path, url)) Object.assign(headers, rule.values);
    res.writeHead(200, headers).end(readFileSync(file));
  });
  return new Promise((ok) => server.listen(port, () => ok({ port: server.address().port, close: () => new Promise((r) => server.close(r)) })));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { port } = await startStatic(Number(process.argv[2] ?? 4173));
  console.info(`serving client/dist with netlify.toml headers on http://localhost:${port}`);
}
