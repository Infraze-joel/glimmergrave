// Browser end-to-end tests against the PRODUCTION build, a real game server and independent browser clients.
// Run with `npm run test:e2e` (builds first; set E2E_SKIP_BUILD=1 to reuse existing builds).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { readFileSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import {
  BASE, aimAt, build, eventually, gameText, host, join, launch, newClient, open, screen, sleep, startBackend, startBots, startLagProxy, tid, waitScreen,
} from './helpers.mjs';
import { startStatic } from '../../scripts/serve-dist.mjs';
import { PROXY_PORT, ROOT, SERVER_PORT, STATIC_PORT } from './helpers.mjs';

let backend, proxy, web, browser;
/** Clients shared by the session tests below (they build on each other, in order). */
let a, b, code, bots;

before(async () => {
  build();
  backend = await startBackend();
  proxy = startLagProxy();
  // Same origin for page and WebSocket, as on Netlify: /ws/* -> lag proxy -> game server.
  web = await startStatic(STATIC_PORT, PROXY_PORT, SERVER_PORT);
  browser = await launch();
}, { timeout: 300000 });

after(async () => {
  bots?.stop();
  await browser?.close();
  await web?.close();
  await proxy?.stop();
  await backend?.stop();
});

const selfOf = (text) => text.players.find((p) => p.slot === text.conn.slot);

test('boots to the menu without errors and with the Netlify security headers', async () => {
  const res = await fetch(BASE + '/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-security-policy') ?? '', /default-src 'self'/);
  const c = await newClient(browser);
  assert.equal(await screen(c.page), 'menu');
  assert.deepEqual(c.problems, []);
  await c.close();
});

test('models and sounds are requested by content version, so a release never mixes with older cached files', async () => {
  const c = await newClient(browser);
  // A click unlocks audio, which starts the sample downloads.
  await c.page.mouse.click(5, 5);
  const assetUrls = () => c.page.evaluate(() => performance.getEntriesByType('resource').map((e) => e.name).filter((n) => n.includes('/assets/')));
  const requested = (list, folder) => list.some((u) => u.includes(folder));
  await eventually(async () => {
    const list = await assetUrls();
    return requested(list, '/assets/models/') && requested(list, '/assets/audio/');
  }, 30000);
  const urls = await assetUrls();
  assert.ok(requested(urls, '/assets/models/'), 'no model was requested');
  assert.ok(requested(urls, '/assets/audio/'), 'no sound was requested');
  const versions = new Set();
  for (const url of urls) {
    const version = new URL(url).searchParams.get('v');
    assert.match(version ?? '', /^[0-9a-f]{10}$/, `unversioned asset request: ${url}`);
    versions.add(version);
  }
  assert.equal(versions.size, 1);
  // Versioned URLs may be cached for good; that header would be a bug on an unversioned URL.
  const res = await fetch(urls.find((u) => u.endsWith(`props.glb?v=${[...versions][0]}`)));
  assert.equal(res.status, 200);
  assert.match(res.headers.get('cache-control') ?? '', /immutable/);
  await c.close();
});

test('a browser that still holds an older model file in its cache loads the new release', async () => {
  // Regression: release 2 shipped a changed props.glb under its old name while browsers kept the old file for
  // a day, so the new code failed with "missing prop skel_quiver". This front server reproduces that browser
  // state: the unversioned URL answers with a different model and the old one-day cache header.
  const STALE_URL = '/assets/models/props.glb';
  const wrongModel = readFileSync(joinPath(ROOT, 'client/dist/assets/models/hero_knight.glb'));
  let unversionedHits = 0;
  const front = createServer((req, res) => {
    if (req.url === STALE_URL) {
      unversionedHits++;
      res.writeHead(200, { 'Content-Type': 'model/gltf-binary', 'Cache-Control': 'public, max-age=86400, must-revalidate' }).end(wrongModel);
      return;
    }
    const up = request({ host: '127.0.0.1', port: STATIC_PORT, path: req.url, method: req.method, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on('error', () => res.writeHead(502).end());
    req.pipe(up);
  });
  await new Promise((ok) => front.listen(0, '127.0.0.1', ok));
  const origin = `http://127.0.0.1:${front.address().port}`;
  const context = await browser.createBrowserContext();
  try {
    const page = await context.newPage();
    const problems = [];
    page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    await page.goto(`${origin}/404.html`);
    const sizeOf = () => page.evaluate(async (url) => (await (await fetch(url)).arrayBuffer()).byteLength, STALE_URL);
    assert.equal(await sizeOf(), wrongModel.length);
    await page.goto(`${origin}/`);
    await waitScreen(page, 'menu', 120000);
    assert.deepEqual(problems, []);
    // The cache really is poisoned: the old URL is answered from it without asking the server again.
    assert.equal(await sizeOf(), wrongModel.length);
    assert.equal(unversionedHits, 1);
  } finally {
    await context.close();
    await new Promise((ok) => { front.closeAllConnections(); front.close(ok); });
  }
});

test('the backend is reachable on the same origin under /ws', async () => {
  const res = await fetch(BASE + '/ws/health');
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
});

test('unknown paths get the 404 page, which returns to the game and keeps ?join=', async () => {
  const res = await fetch(BASE + '/some/deep/link');
  assert.equal(res.status, 404);
  assert.match(await res.text(), /404\.js/);
  const c = await newClient(browser, '/some/deep/link?join=abcde');
  assert.equal(await screen(c.page), 'menu');
  assert.equal(new URL(c.page.url()).pathname, '/');
  assert.equal(await c.page.$eval(tid('menu-join-code'), (el) => el.value), 'ABCDE');
  assert.deepEqual(c.problems.filter((p) => !/404/.test(p)), []);
  await c.close();
});

test('joining with an unknown session code shows an error and stays in the menu', async () => {
  const c = await newClient(browser);
  await join(c.page, 'Nobody', 'ZZZZZ');
  await c.page.waitForSelector(tid('error-dialog'), { timeout: 15000 });
  assert.equal(await c.page.$eval(tid('error-dialog'), (el) => el.dataset.error), 'room_not_found');
  assert.equal(await screen(c.page), 'menu');
  await c.close();
});

test('training starts from the menu, explains the first step and advances when it is done', async () => {
  const c = await newClient(browser);
  await c.page.click(tid('menu-name'), { clickCount: 3 });
  await c.page.type(tid('menu-name'), 'Novice');
  await c.page.click(tid('menu-training'));
  await waitScreen(c.page, 'game');
  await c.page.waitForSelector(`${tid('tutorial-panel')}[data-step="move"]`, { timeout: 15000 });
  const first = (await gameText(c.page)).run.tutorial;
  assert.equal(first.total, 10);
  assert.ok(first.marker, 'the move step has a ground marker');
  // Walk to the marker with real key presses until the server moves on to the next step.
  const deadline = Date.now() + 30000;
  let step = 'move';
  while (step === 'move' && Date.now() < deadline) {
    const t = await gameText(c.page);
    step = t.run.tutorial?.step ?? 'done';
    const me = t.players.find((p) => p.slot === t.conn.slot);
    if (step !== 'move' || !me || !t.run.tutorial.marker) continue;
    const dx = t.run.tutorial.marker.x - me.x;
    const dz = t.run.tutorial.marker.z - me.z;
    const keys = [];
    if (Math.abs(dx) > 0.4) keys.push(dx > 0 ? 'KeyD' : 'KeyA');
    if (Math.abs(dz) > 0.4) keys.push(dz > 0 ? 'KeyS' : 'KeyW');
    for (const k of keys) await c.page.keyboard.down(k);
    await sleep(250);
    for (const k of keys) await c.page.keyboard.up(k);
  }
  assert.equal(step, 'attack', 'reaching the marker starts the attack step');
  await c.page.waitForSelector(`${tid('tutorial-panel')}[data-step="attack"]`, { timeout: 10000 });
  assert.deepEqual(c.problems, []);
  await c.close();
});

test('Glimmer buys a permanent upgrade that survives a reload', async () => {
  const c = await newClient(browser, '/', { glimmer: 500 });
  await c.page.click(tid('menu-armory'));
  await c.page.waitForSelector(tid('armory-root'), { timeout: 10000 });
  assert.equal(await c.page.$eval(tid('armory-wallet'), (el) => el.dataset.glimmer), '500');
  await c.page.click(tid('armory-buy-vitality'));
  await c.page.waitForFunction(() => document.querySelector('[data-testid="armory-wallet"]')?.dataset.glimmer === '460', { timeout: 20000 });
  await open(c.page, '/');
  const profile = await c.page.evaluate(() => window.__game.state.profile);
  assert.equal(profile.glimmer, 460);
  assert.equal(profile.meta.vitality, 1);
  await c.close();
});

test('two independent clients create and join a session', async () => {
  a = await newClient(browser);
  b = await newClient(browser);
  // Alva dresses her knight in the wardrobe first; the look must reach the other client.
  await a.page.click(tid('menu-wardrobe'));
  await a.page.waitForSelector(tid('wardrobe-root'), { timeout: 10000 });
  await a.page.click(tid('wardrobe-color-3'));
  await a.page.click(tid('page-close'));
  code = await host(a.page, 'Alva', 'knight');
  assert.match(code, /^[A-Z2-9]{5}$/);
  await join(b.page, 'Bero', code.toLowerCase(), 'mage');
  await waitScreen(b.page, 'lobby');
  for (const c of [a, b]) {
    await c.page.waitForFunction(() => document.querySelectorAll('[data-testid^="lobby-slot-"][data-connected="true"]').length === 2, { timeout: 15000 });
  }
  const ta = await gameText(a.page);
  const tb = await gameText(b.page);
  assert.equal(ta.conn.slot, 0);
  assert.equal(tb.conn.slot, 1);
  assert.deepEqual(ta.roster.map((p) => [p.name, p.cls, p.host]), [['Alva', 'knight', true], ['Bero', 'mage', false]]);
  assert.deepEqual(tb.roster.map((p) => p.name), ['Alva', 'Bero']);
  assert.equal(tb.roster[0].look.color, 3, 'the host look chosen in the wardrobe is synced to the other client');
  // A scripted third player keeps the run going even if the test-driven heroes get knocked down.
  bots = startBots(code, 1, 'rogue');
  await a.page.waitForFunction(() => document.querySelectorAll('[data-testid^="lobby-slot-"][data-connected="true"]').length === 3, { timeout: 30000 });
});

test('ready states sync and only the host can start the run', async () => {
  const visible = await b.page.$eval(tid('lobby-start'), (el) => el.checkVisibility() && !el.disabled).catch(() => false);
  assert.equal(visible, false, 'non-host must not get a usable start button');
  await b.page.click(tid('lobby-ready'));
  await a.page.waitForSelector(`${tid('lobby-slot-1')}[data-ready="true"]`, { timeout: 10000 });
  await a.page.click(tid('lobby-ready'));
  await b.page.waitForSelector(`${tid('lobby-slot-0')}[data-ready="true"]`, { timeout: 10000 });
  // A forged start request from the non-host is rejected by the server.
  await b.page.evaluate(() => window.__game.bus.emit('ui:start'));
  await sleep(600);
  assert.equal((await gameText(a.page)).run.phase, 'lobby');
  await a.page.click(tid('lobby-start'));
  await Promise.all([waitScreen(a.page, 'game'), waitScreen(b.page, 'game')]);
  await a.page.waitForFunction(() => JSON.parse(window.render_game_to_text()).players.length === 3, { timeout: 15000 });
  const ta = await gameText(a.page);
  assert.equal(ta.run.phase, 'combat');
  assert.equal(ta.run.chamber, 0);
});

test('movement of one client is predicted locally and seen by the other client', async () => {
  const before = selfOf(await gameText(a.page));
  await a.page.keyboard.down('KeyA');
  await sleep(900);
  await a.page.keyboard.up('KeyA');
  await sleep(700);
  const mine = selfOf(await gameText(a.page));
  assert.ok(before.x - mine.x > 2, `hero should have moved west by > 2 m (moved ${(before.x - mine.x).toFixed(2)})`);
  const agreed = await eventually(async () => {
    const own = selfOf(await gameText(a.page));
    const seen = (await gameText(b.page)).players.find((p) => p.slot === 0);
    return Math.abs(seen.x - own.x) < 0.3 && Math.abs(seen.z - own.z) < 0.3;
  });
  assert.ok(agreed, 'other client sees the same authoritative position');
  const settled = await eventually(async () => {
    const t = await gameText(a.page);
    const own = selfOf(t);
    return Math.hypot(t.predicted.x - own.x, t.predicted.z - own.z) < 0.15;
  });
  assert.ok(settled, 'prediction converges on the server position at rest');
});

test('combat is authoritative and synchronised: damage dealt by one client shows up on the other', async () => {
  // Wait for an enemy that has finished spawning, aim at it and attack with the mage (client b).
  const deadline = Date.now() + 60000;
  let dealt = 0;
  await b.page.mouse.move(640, 300);
  while (Date.now() < deadline && dealt === 0) {
    const target = await b.page.evaluate(() => {
      const snap = window.__game.latestSnapshot();
      const me = snap?.players.find((p) => p.slot === window.__game.state.conn.slot);
      if (!snap || !me) return null;
      let best = null;
      for (const e of snap.enemies) {
        const d = Math.hypot(e.x - me.x, e.z - me.z);
        if (e.anim !== 'spawn' && e.hp > 0 && (!best || d < best.d)) best = { x: e.x, z: e.z, d };
      }
      return best;
    });
    if (target) {
      await aimAt(b.page, target.x, target.z);
      await b.page.mouse.down({ button: 'left' });
      await sleep(350);
      await b.page.mouse.up({ button: 'left' });
    } else {
      await sleep(250);
    }
    dealt = (await gameText(a.page)).run.stats.find((s) => s.slot === 1)?.damage ?? 0;
  }
  assert.ok(dealt > 0, 'client a must see damage dealt by client b');
  const same = await eventually(async () => {
    const ta = await gameText(a.page);
    const tb = await gameText(b.page);
    return ta.run.wave === tb.run.wave && Math.abs(ta.enemiesAlive - tb.enemiesAlive) <= 1;
  });
  assert.ok(same, 'both clients track the same wave and enemies');
});

test('reloading the page rejoins the same slot in the running game', async () => {
  await open(b.page, '/');
  await b.page.waitForFunction(() => window.__game.state.conn.status === 'online' && window.__game.state.run, { timeout: 30000 });
  const tb = await gameText(b.page);
  assert.ok(['game', 'summary'].includes(tb.screen), `rejoined client is back in the session (screen ${tb.screen})`);
  assert.equal(tb.conn.slot, 1);
  assert.equal(tb.conn.code, code);
  assert.equal(tb.conn.status, 'online');
  await a.page.waitForFunction(() => window.__game.state.roster.find((p) => p.slot === 1)?.connected === true, { timeout: 15000 });
});

test('the game stays playable with 150 ms of added latency', async () => {
  proxy.lag.oneWayMs = 75;
  proxy.lag.jitterMs = 20;
  // The displayed ping is smoothed over several 2 s samples, so give it time to climb.
  const lagged = await eventually(async () => (await gameText(a.page)).conn.pingMs > 120, 30000, 1000);
  const ping = (await gameText(a.page)).conn.pingMs;
  assert.ok(lagged, `ping should reflect the added latency (was ${ping.toFixed(0)} ms)`);
  let worst = 0;
  for (const key of ['KeyD', 'KeyS', 'KeyA', 'KeyW']) {
    await a.page.keyboard.down(key);
    for (let i = 0; i < 4; i++) {
      await sleep(150);
      const t = await gameText(a.page);
      const me = selfOf(t);
      if (me && me.state === 'alive') worst = Math.max(worst, Math.hypot(t.predicted.x - me.x, t.predicted.z - me.z));
    }
    await a.page.keyboard.up(key);
  }
  await sleep(1200);
  const t = await gameText(a.page);
  const me = selfOf(t);
  // While moving, the drawn position leads the (delayed) authoritative one by roughly speed x latency
  // (about 1.7 m here) plus at most 2.5 m of correction smoothing.
  assert.ok(worst < 4.5, `prediction lead while moving should stay bounded (worst ${worst.toFixed(2)} m)`);
  if (me && me.state === 'alive') assert.ok(Math.hypot(t.predicted.x - me.x, t.predicted.z - me.z) < 0.2, 'prediction settles on the server position');
  assert.equal(t.conn.status, 'online');
  proxy.lag.oneWayMs = 0;
  proxy.lag.jitterMs = 0;
});

test('a disconnecting client is flagged for the others and the run goes on', async () => {
  await b.close();
  await a.page.waitForFunction(() => window.__game.state.roster.find((p) => p.slot === 1)?.connected === false, { timeout: 20000 });
  const t1 = await a.page.evaluate(() => window.__game.latestSnapshot().tick);
  await sleep(1000);
  const t2 = await a.page.evaluate(() => window.__game.latestSnapshot().tick);
  if (await screen(a.page) === 'game') assert.ok(t2 > t1, 'server keeps simulating for the remaining players');
});

test('leaving the session returns to the main menu', async () => {
  // Through the pause menu while the run is on, or from the summary if the run has ended meanwhile
  // (the idle test heroes can be overrun). A screen change in between simply leads to another attempt.
  for (let attempt = 0; attempt < 4 && (await screen(a.page)) !== 'menu'; attempt++) {
    try {
      if (await screen(a.page) === 'game') {
        if (!(await a.page.$(tid('pause-leave')))) await a.page.keyboard.press('Escape');
        await a.page.waitForSelector(tid('pause-leave'), { timeout: 8000 });
        await a.page.click(tid('pause-leave'));
      } else {
        await a.page.click(tid('summary-leave'));
      }
      // The pause menu and the summary / lobby use two different confirmation dialogs.
      const confirm = `${tid('pause-leave-confirm')}, ${tid('leave-confirm')}`;
      await a.page.waitForSelector(confirm, { timeout: 8000 });
      await a.page.click(confirm);
      await sleep(500);
    } catch { /* screen changed under us: try again */ }
  }
  if (await screen(a.page) !== 'menu') {
    await a.page.screenshot({ path: '/tmp/e2e-leave-fail.png' });
    const ids = await a.page.evaluate(() => [...document.querySelectorAll('[data-testid]')].map((e) => e.dataset.testid).join(' '));
    assert.fail(`still on screen ${await screen(a.page)}; visible test ids: ${ids}; problems: ${a.problems.slice(-3).join(' | ')}`);
  }
  assert.equal((await gameText(a.page)).conn.status, 'offline');
  const fatal = a.problems.filter((p) => !/WebSocket connection|ERR_CONNECTION/.test(p));
  assert.deepEqual(fatal, [], 'no console errors during the whole session');
  await a.close();
});
