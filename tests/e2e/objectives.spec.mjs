// Update 4: a chamber with a special objective in a real session (production build, own server with the QA
// options that pin the start chamber and its objective).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { build, eventually, gameText, launch, sleep, startBackend, tid, waitScreen } from './helpers.mjs';
import { startStatic } from '../../scripts/serve-dist.mjs';

const WEB_PORT = 4198;
const GAME_PORT = 8798;
const ORIGIN = `http://127.0.0.1:${WEB_PORT}`;
let backend, web, browser;

before(async () => {
  build();
  backend = await startBackend(GAME_PORT, ORIGIN, { DEBUG_START_CHAMBER: '1', DEBUG_OBJECTIVE: 'survive' });
  web = await startStatic(WEB_PORT, GAME_PORT, GAME_PORT);
  browser = await launch();
}, { timeout: 300000 });

after(async () => {
  await browser?.close();
  await web?.close();
  await backend?.stop();
});

test('a "hold out" chamber shows its objective, counts down and reports the lost bonus', async () => {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  const problems = [];
  page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  await page.evaluateOnNewDocument(() => localStorage.setItem('glimmergrave.profile.v1', JSON.stringify({ tutorialDone: true })));
  await page.goto(`${ORIGIN}/`, { waitUntil: 'load', timeout: 60000 });
  await waitScreen(page, 'menu', 120000);
  await page.type(tid('menu-name'), 'Ona');
  await page.click(tid('menu-class-knight'));
  await page.click(tid('menu-host'));
  await waitScreen(page, 'lobby');
  await page.click(tid('lobby-ready'));
  await eventually(async () => (await gameText(page)).roster[0].ready);
  await page.click(tid('lobby-start'));
  await waitScreen(page, 'game');
  await page.evaluate(() => { window.__game.renderEvery = 30; });

  const started = await eventually(async () => {
    const run = (await gameText(page)).run;
    return run.phase === 'combat' && run.objective?.kind === 'survive' ? run : null;
  }, 60000, 500);
  assert.ok(started, 'the chamber starts with the pinned objective');
  assert.equal(started.objective.status, 'active');
  assert.equal(started.objective.bonus, true);
  assert.ok(started.objective.timeLeft > 30, `timer is running (${started.objective.timeLeft})`);

  await page.waitForSelector(tid('hud-objective'), { timeout: 20000 });
  const tracker = () => page.$eval(tid('hud-objective'), (el) => ({ ...el.dataset }));
  assert.equal((await tracker()).kind, 'survive');
  assert.equal((await tracker()).bonus, 'open');

  // The timer runs down on the server and in the state the HUD reads.
  await sleep(5000);
  const later = (await gameText(page)).run.objective;
  assert.ok(later.timeLeft < started.objective.timeLeft - 2, `time passed: ${started.objective.timeLeft} -> ${later.timeLeft}`);
  assert.ok(later.progress > started.objective.progress);

  // The idle knight is knocked down eventually: that loses the bonus (nobody may be downed), and the HUD says so.
  const lost = await eventually(async () => {
    const run = (await gameText(page)).run;
    return run.objective && run.objective.bonus === false ? run : null;
  }, 120000, 1000);
  assert.ok(lost, 'a downed hero loses the survive bonus');
  await eventually(async () => (await tracker()).bonus === 'lost', 15000);
  assert.equal((await tracker()).bonus, 'lost');
  assert.deepEqual(problems, []);
  await context.close();
});
