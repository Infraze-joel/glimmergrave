// Shared helpers for the browser end-to-end tests: production build, real server, lag proxy, Chrome.
import puppeteer from 'puppeteer-core';
import { WebSocketServer, WebSocket } from 'ws';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStatic } from '../../scripts/serve-dist.mjs';

export const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const SERVER_PORT = 8791;
export const PROXY_PORT = 8792;
export const STATIC_PORT = 4188;
export const BASE = `http://127.0.0.1:${STATIC_PORT}`;
const CHROME = process.env.CHROME_BIN ?? ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => existsSync(p));

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const tid = (id) => `[data-testid="${id}"]`;

/**
 * Builds the client exactly as Netlify does (no VITE_SERVER_URL: the backend is expected on the same origin
 * under /ws) plus the server bundle, unless E2E_SKIP_BUILD=1.
 */
export function build() {
  if (process.env.E2E_SKIP_BUILD === '1') return;
  const env = { ...process.env };
  delete env.VITE_SERVER_URL;
  execFileSync('npm', ['run', 'build'], { cwd: ROOT, env, stdio: 'pipe' });
}

/** `port` / `origin` / `env` let a spec run its own differently configured server next to the shared one. */
export async function startBackend(port = SERVER_PORT, origin = BASE, env = {}) {
  const proc = spawn('node', ['server/dist/server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(port), ALLOWED_ORIGINS: origin, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const logs = [];
  proc.stdout.on('data', (d) => logs.push(String(d)));
  proc.stderr.on('data', (d) => logs.push(String(d)));
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* not up yet */ }
    await sleep(100);
  }
  return { logs, stop: () => new Promise((r) => { proc.once('exit', r); proc.kill('SIGTERM'); }) };
}

/**
 * WebSocket proxy in front of the game server that delays every frame in both directions.
 * `lag.oneWayMs` / `lag.jitterMs` can be changed while connections are open. Order is preserved.
 */
export function startLagProxy() {
  const lag = { oneWayMs: 0, jitterMs: 0 };
  const wss = new WebSocketServer({ port: PROXY_PORT });
  wss.on('connection', (client, req) => {
    const upstream = new WebSocket(`ws://127.0.0.1:${SERVER_PORT}`, { headers: { origin: req.headers.origin ?? BASE } });
    const pipe = (from, to) => {
      let last = 0;
      const pending = [];
      from.on('message', (data, isBinary) => {
        const send = () => { if (to.readyState === WebSocket.OPEN) to.send(data, { binary: isBinary }); };
        if (to.readyState === WebSocket.CONNECTING) { pending.push(send); return; }
        if (lag.oneWayMs <= 0) { send(); return; }
        const at = Math.max(last, Date.now() + lag.oneWayMs + Math.random() * lag.jitterMs);
        last = at;
        setTimeout(send, at - Date.now());
      });
      to.on('open', () => { for (const send of pending.splice(0)) send(); });
      from.on('close', () => to.close());
      from.on('error', () => to.close());
    };
    pipe(client, upstream);
    pipe(upstream, client);
  });
  return { lag, stop: () => new Promise((r) => { for (const c of wss.clients) c.terminate(); wss.close(r); }) };
}

export async function launch() {
  if (!CHROME) throw new Error('Chrome not found; set CHROME_BIN');
  return puppeteer.launch({
    executablePath: CHROME, headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
      '--autoplay-policy=no-user-gesture-required', '--disable-background-networking', '--disable-component-update', '--no-first-run', '--window-size=1280,720'],
  });
}

/** An independent client: its own browser context (separate storage), page, and captured console problems. */
/** `profile` (optional) is merged into the stored player profile before the game loads (e.g. { glimmer: 500 }). */
export async function newClient(browser, path = '/', profile = null) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  if (profile) {
    await page.evaluateOnNewDocument((patch) => {
      const key = 'glimmergrave.profile.v1';
      if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(patch));
    }, profile);
  }
  await page.setViewport({ width: 1280, height: 720 });
  const problems = [];
  page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  await open(page, path);
  return { context, page, problems, close: () => context.close() };
}

export async function open(page, path = '/') {
  await page.goto(BASE + path, { waitUntil: 'load', timeout: 60000 });
  // The 404 page redirects to '/', which destroys the first execution context: retry until the game is up.
  const deadline = Date.now() + 120000;
  for (;;) {
    try {
      await page.waitForFunction("document.body?.dataset.screen && document.body.dataset.screen !== 'loading' && window.__game", { timeout: 5000 });
      break;
    } catch (err) {
      if (Date.now() > deadline) throw err;
    }
  }
  // Software GL is slow: draw only every 30th frame so game logic and input keep real-time pace.
  await page.evaluate(() => { window.__game.renderEvery = 30; });
}

export const screen = (page) => page.evaluate('document.body.dataset.screen');
export const waitScreen = (page, name, timeout = 30000) => page.waitForFunction((n) => document.body.dataset.screen === n, { timeout }, name);
export const gameText = async (page) => JSON.parse(await page.evaluate('window.render_game_to_text()'));

export async function enterName(page, name, cls) {
  await page.click(tid('menu-name'), { clickCount: 3 });
  await page.type(tid('menu-name'), name);
  if (cls) await page.click(tid(`menu-class-${cls}`));
}

export async function host(page, name, cls) {
  await enterName(page, name, cls);
  await page.click(tid('menu-host'));
  await waitScreen(page, 'lobby');
  return page.$eval(tid('lobby-code'), (el) => el.textContent.trim());
}

export async function join(page, name, code, cls) {
  await enterName(page, name, cls);
  await page.click(tid('menu-join-code'), { clickCount: 3 });
  await page.type(tid('menu-join-code'), code);
  await page.click(tid('menu-join'));
}

/** Finds the screen position whose ground projection is closest to world (x, z) and moves the mouse there. */
export async function aimAt(page, x, z) {
  const point = await page.evaluate((tx, tz) => {
    const view = window.__game.view;
    const out = { x: 0, z: 0 };
    let best = null;
    for (let sy = 10; sy < window.innerHeight; sy += 10) {
      for (let sx = 10; sx < window.innerWidth; sx += 10) {
        if (!view.screenToGround(sx, sy, out)) continue;
        const d = (out.x - tx) ** 2 + (out.z - tz) ** 2;
        if (!best || d < best.d) best = { sx, sy, d };
      }
    }
    return best;
  }, x, z);
  if (point) await page.mouse.move(point.sx, point.sy);
  return point;
}

/** Starts scripted bot players (real WebSocket clients) that join `code`. They keep a run alive while the tests poke at it. */
export function startBots(code, count = 1, cls = 'rogue') {
  const proc = spawn('npx', ['tsx', 'server/src/tools/botClient.ts', '--url', `ws://127.0.0.1:${SERVER_PORT}`, '--code', code, '--bots', String(count), '--cls', cls],
    { cwd: ROOT, stdio: 'ignore', detached: true });
  return { stop: () => { try { process.kill(-proc.pid, 'SIGTERM'); } catch { /* already gone */ } } };
}

/**
 * Polls `check` until it returns a truthy value or the timeout passes; returns the last value.
 * Two pages never process the same snapshot at the same instant (and software rendering stalls them for
 * hundreds of milliseconds), so cross-client comparisons must wait for convergence instead of sampling once.
 */
export async function eventually(check, timeout = 10000, interval = 200) {
  const deadline = Date.now() + timeout;
  let value = await check();
  while (!value && Date.now() < deadline) {
    await sleep(interval);
    value = await check();
  }
  return value;
}
