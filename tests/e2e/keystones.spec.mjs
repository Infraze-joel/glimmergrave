// Update 5: a keystone draft in a real session (production build, own server that starts the run in the
// champion's chamber; three upgraded bots clear it so the browser hero reaches the keystone draft).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { build, eventually, gameText, launch, startBackend, startBots, sleep, tid, waitScreen } from './helpers.mjs';
import { startStatic } from '../../scripts/serve-dist.mjs';

const WEB_PORT = 4199;
const GAME_PORT = 8799;
const ORIGIN = `http://127.0.0.1:${WEB_PORT}`;
/** Index of the first elite chamber (champion) in RUN.CHAMBERS. */
const CHAMPION_CHAMBER = '3';
let backend, web, browser, bots;

before(async () => {
  build();
  backend = await startBackend(GAME_PORT, ORIGIN, { DEBUG_START_CHAMBER: CHAMPION_CHAMBER, DEBUG_OBJECTIVE: 'slay' });
  web = await startStatic(WEB_PORT, GAME_PORT, GAME_PORT);
  browser = await launch();
}, { timeout: 300000 });

after(async () => {
  bots?.stop();
  await browser?.close();
  await web?.close();
  await backend?.stop();
});

test('after the champion every hero drafts a keystone; the pick shows on the HUD and in every roster', async () => {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  const problems = [];
  page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  await page.evaluateOnNewDocument(() => localStorage.setItem('glimmergrave.profile.v1', JSON.stringify({ tutorialDone: true })));
  await page.goto(`${ORIGIN}/`, { waitUntil: 'load', timeout: 60000 });
  await waitScreen(page, 'menu', 120000);
  await page.type(tid('menu-name'), 'Kai');
  await page.click(tid('menu-class-mage'));
  await page.click(tid('menu-host'));
  await waitScreen(page, 'lobby');
  const code = await page.$eval(tid('lobby-code'), (el) => el.textContent.trim());
  bots = startBots(code, 3, 'knight,templar,rogue', ['--meta', 'max'], GAME_PORT);
  await page.waitForFunction(() => document.querySelectorAll('[data-testid^="lobby-slot-"][data-connected="true"]').length === 4, { timeout: 40000 });
  await page.click(tid('lobby-ready'));
  await eventually(async () => (await gameText(page)).roster.find((p) => p.name === 'Kai')?.ready);
  await page.click(tid('lobby-start'));
  await waitScreen(page, 'game');
  await page.evaluate(() => { window.__game.renderEvery = 30; });

  // The champion falls to the bots; then the browser hero gets a keystone draft (not an ordinary one).
  await page.waitForSelector(tid('keystone-draft'), { timeout: 240000 });
  const draft = await page.evaluate(() => window.__game.state.draftKeystone);
  assert.ok(draft, 'the draft message carries the keystone part');
  assert.deepEqual(draft.held, []);
  const offered = await page.$$eval('[data-testid^="keystone-card-"]', (els) => els.map((el) => el.dataset.id));
  assert.equal(offered.length, 3);
  assert.equal(new Set(offered).size, 3, 'three different keystones');

  await page.click(tid('keystone-card-0'));
  const mine = await eventually(async () => {
    const me = (await gameText(page)).roster.find((p) => p.name === 'Kai');
    return me && me.keystones.length === 1 ? me : null;
  }, 20000);
  assert.ok(mine, 'the server took the pick');
  assert.equal(mine.keystones[0], offered[0]);
  await page.waitForFunction((id) => document.querySelector('[data-testid="hud-keystones"]')?.dataset.ids?.split(',').includes(id), { timeout: 20000 }, offered[0]);

  // The bots draft too, and their picks reach this client.
  const others = await eventually(async () => {
    const roster = (await gameText(page)).roster.filter((p) => p.name !== 'Kai');
    return roster.length === 3 && roster.every((p) => p.keystones.length === 1) ? roster : null;
  }, 60000, 500);
  assert.ok(others, 'every bot holds a keystone and this client sees it');

  await sleep(1000);
  assert.deepEqual(problems, []);
  await context.close();
});
