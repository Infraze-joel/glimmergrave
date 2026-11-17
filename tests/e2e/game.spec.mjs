// Browser end-to-end tests against the PRODUCTION build, a real game server and independent browser clients.
// Run with `npm run test:e2e` (builds first; set E2E_SKIP_BUILD=1 to reuse existing builds).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  BASE, aimAt, build, eventually, gameText, host, join, launch, newClient, open, screen, sleep, startBackend, startBots, startLagProxy, tid, waitScreen,
} from './helpers.mjs';
import { startStatic } from '../../scripts/serve-dist.mjs';
import { PROXY_PORT, STATIC_PORT } from './helpers.mjs';

let backend, proxy, web, browser;
/** Clients shared by the session tests below (they build on each other, in order). */
let a, b, code, bots;

before(async () => {
  build();
  backend = await startBackend();
  proxy = startLagProxy();
  web = await startStatic(STATIC_PORT, `ws://127.0.0.1:${PROXY_PORT}`);
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

test('unknown deep links fall back to the app and ?join= prefills the code', async () => {
  const res = await fetch(BASE + '/some/deep/link');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<canvas id="game-canvas"/);
  const c = await newClient(browser, '/some/deep/link?join=abcde');
  assert.equal(await screen(c.page), 'menu');
  assert.equal(await c.page.$eval(tid('menu-join-code'), (el) => el.value), 'ABCDE');
  assert.deepEqual(c.problems, []);
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

test('two independent clients create and join a session', async () => {
  a = await newClient(browser);
  b = await newClient(browser);
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
  await sleep(11000);
  const ping = (await gameText(a.page)).conn.pingMs;
  assert.ok(ping > 120, `ping should reflect the added latency (was ${ping.toFixed(0)} ms)`);
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
  if (await screen(a.page) === 'game') {
    await a.page.keyboard.press('Escape');
    await a.page.waitForSelector(tid('pause-leave'), { timeout: 5000 });
    await a.page.click(tid('pause-leave'));
    await a.page.waitForSelector(tid('pause-leave-confirm'), { timeout: 5000 });
    await a.page.click(tid('pause-leave-confirm'));
  } else {
    // The run already ended (the idle test heroes were overrun): leave from the summary instead.
    await a.page.click(tid('summary-leave'));
  }
  await waitScreen(a.page, 'menu');
  assert.equal((await gameText(a.page)).conn.status, 'offline');
  const fatal = a.problems.filter((p) => !/WebSocket connection|ERR_CONNECTION/.test(p));
  assert.deepEqual(fatal, [], 'no console errors during the whole session');
  await a.close();
});
