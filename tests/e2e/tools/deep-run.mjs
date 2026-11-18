// Full run with descent in the dev client: maxed templar on autopilot + 3 maxed bots that descend once.
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tid = (id) => `[data-testid="${id}"]`;
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', '--window-size=1280,720', '--disable-background-networking', '--disable-component-update', '--no-first-run'] });
const page = await browser.newPage(); await page.setViewport({ width: 1280, height: 720 });
const errs = []; page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 300)); }); page.on('pageerror', (e) => errs.push('pageerror: ' + String(e.stack ?? e).slice(0, 500)));
await page.evaluateOnNewDocument(() => {
  const meta = { vitality: 8, might: 8, swiftness: 3, celerity: 3, footwork: 3, insight: 3, attunement: 1, resolve: 2, fortune: 3, ferocity: 5, tempo: 3, zeal: 3, warding: 3, scholar: 3, reliquary: 2, salvage: 3, foresight: 1, tenacity: 1 };
  localStorage.setItem('glimmergrave.profile.v1', JSON.stringify({ name: 'Joel', cls: 'templar', wins: 5, runs: 9, glimmer: 120, tutorialDone: true, meta, xp: { templar: 9000 }, arts: { templar: 1 }, talents: { templar: [1, 2, 1] }, paragon: { asc_might: 10, asc_vitality: 10 }, shards: { whetstone: 3, bell: 1, censer: 6 }, relics: ['whetstone', 'bell', 'censer'] }));
});
await page.goto('http://127.0.0.1:5199/?autopilot&descend=1', { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction("document.body.dataset.screen === 'menu'", { timeout: 180000 });
await page.click(tid('menu-host'));
await page.waitForFunction("document.body.dataset.screen === 'lobby'", { timeout: 20000 });
const code = await page.$eval(tid('lobby-code'), (el) => el.textContent.trim());
const bot = spawn('npx', ['tsx', 'server/src/tools/botClient.ts', '--url', 'ws://127.0.0.1:8787', '--code', code, '--bots', '3', '--cls', 'spellblade,shade,mage', '--meta', 'max', '--descend', '1', '--quiet'], { cwd: '/home/claude/glimmergrave', stdio: 'ignore', detached: true });
await page.waitForFunction(() => document.querySelectorAll('[data-testid^="lobby-slot-"][data-connected="true"]').length >= 4, { timeout: 40000 });
await page.screenshot({ path: '/tmp/deep-lobby.png' });
await page.click(tid('lobby-ready')); await sleep(1000); await page.click(tid('lobby-start'));
await page.waitForFunction("document.body.dataset.screen === 'game'", { timeout: 20000 });
await page.evaluate(() => { window.__game.renderEvery = 30; });
const text = async () => JSON.parse(await page.evaluate('window.render_game_to_text()'));
const shot = async (name) => { try { await page.evaluate(() => { window.__game.renderEvery = 2; }); await sleep(1500); await page.screenshot({ path: `/tmp/deep-${name}.png` }); await page.evaluate(() => { window.__game.renderEvery = 30; }); console.log('shot', name); } catch (e) { console.log('  shot failed', name, String(e.message).slice(0, 120)); } };
const seen = new Set(); let last = ''; let maxUlt = 0; const start = Date.now();
while (Date.now() - start < 28 * 60000) {
  await sleep(2000);
  let t; try { await page.evaluate(() => { if (window.__game.renderEvery === 1) window.__game.renderEvery = 30; }); t = await text(); } catch (e) { console.log('  page hiccup:', String(e.message).slice(0, 120)); continue; }
  const run = t.run; if (!run) { console.log('  no run'); continue; }
  const me = t.players?.find((p) => p.slot === t.conn.slot); maxUlt = Math.max(maxUlt, me?.ult ?? 0);
  const key = `d${run.depth} c${run.chamber} ${run.phase}`; if (key !== last) { console.log(Math.round((Date.now() - start) / 1000) + 's', key, 'cleared', run.cleared, 'ult', (me?.ult ?? 0).toFixed(2)); last = key; }
  if (run.phase === 'doors' && Math.round((Date.now() - start) / 2000) % 8 === 0) console.log('  doors', JSON.stringify(run.doors), JSON.stringify(run.doorProgress), JSON.stringify(t.players.map((p) => [p.slot, p.state, Math.round(p.x), Math.round(p.z), p.flags])));
  const once = async (tag) => { if (!seen.has(tag)) { seen.add(tag); await shot(tag); } };
  if (run.depth === 0 && run.chamber === 2 && run.phase === 'combat') await once('d0-combat');
  if (run.chamberKind === 'boss' && run.phase === 'combat' && run.depth === 0) await once('d0-boss');
  if (run.phase === 'doors' && run.doors.some((d) => d.type === 'descend')) await once('descend-doors');
  if (run.depth === 1 && run.phase === 'combat' && run.chamber === 1) await once('d1-combat');
  if (run.depth === 1 && run.phase === 'draft') await once('d1-draft');
  if (run.phase === 'victory' || run.phase === 'defeat') { await sleep(6000); await page.evaluate(() => { window.__game.renderEvery = 1; }); await sleep(3000); await page.screenshot({ path: '/tmp/deep-summary.png' }); const f = await text(); console.log('END', run.phase, JSON.stringify({ depth: f.run.depth, cleared: f.run.cleared, rewards: f.run.rewards, stats: f.run.stats.find((s) => s.slot === f.conn.slot) })); break; }
}
console.log('maxUlt', maxUlt, 'profile', JSON.stringify(await page.evaluate(() => { const p = window.__game.state.profile; return { glimmer: p.glimmer, xp: p.xp.templar, shards: p.shards, lifetime: p.lifetime, oath: p.oathUnlocked }; })));
console.log('errors', errs.length, errs.slice(0, 6));
try { process.kill(-bot.pid, 'SIGTERM'); } catch {}
await browser.close();
