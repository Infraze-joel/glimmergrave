// Session driver: hosts a game in a real browser, lets bots join, plays and screenshots.
// Usage: node tests/e2e/tools/play-session.mjs <clientUrl> <wsUrl> <outPrefix> [seconds] [bots] [cls]
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
const [clientUrl, wsUrl, out, secondsArg, botsArg, cls = 'knight', renderEvery = '10'] = process.argv.slice(2);
const seconds = Number(secondsArg ?? 40);
const bots = Number(botsArg ?? 2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', '--window-size=1280,720', '--disable-background-networking', '--disable-component-update', '--no-first-run'] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });
const errs = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errs.push(m.type() + ': ' + m.text().slice(0, 300)); });
page.on('pageerror', (e) => errs.push('pageerror: ' + String(e.stack ?? e).slice(0, 600)));
const tid = (id) => `[data-testid="${id}"]`;
let botProc = null;
try {
  await page.goto(clientUrl, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction("document.body.dataset.screen === 'menu'", { timeout: 120000 });
  await page.screenshot({ path: `${out}-1-menu.png` });
  await page.click(tid('menu-name'), { clickCount: 3 });
  await page.type(tid('menu-name'), 'Joel');
  await page.click(tid(`menu-class-${cls}`));
  await page.click(tid('menu-host'));
  await page.waitForFunction("document.body.dataset.screen === 'lobby'", { timeout: 20000 });
  const code = await page.$eval(tid('lobby-code'), (el) => el.textContent.trim());
  console.log('room code', code);
  if (bots > 0) {
    botProc = spawn('npx', ['tsx', 'server/src/tools/botClient.ts', '--url', wsUrl, '--code', code, '--bots', String(bots), '--cls', 'mage,rogue,barbarian'], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    botProc.stdout.on('data', (d) => process.stdout.write('[bot] ' + d));
    botProc.stderr.on('data', (d) => process.stdout.write('[bot!] ' + d));
    await page.waitForFunction((n) => document.querySelectorAll('[data-testid^="lobby-slot-"][data-connected="true"]').length >= n, { timeout: 30000 }, bots + 1);
  }
  await page.click(tid('lobby-ready'));
  await sleep(800);
  await page.screenshot({ path: `${out}-2-lobby.png` });
  await page.click(tid('lobby-start'));
  await page.waitForFunction("document.body.dataset.screen === 'game'", { timeout: 20000 });
  await page.evaluate((n) => { window.__game.renderEvery = n; }, Number(renderEvery));
  const auto = clientUrl.includes('autopilot');
  const shotEvery = Number(process.env.SHOT_EVERY ?? (seconds > 120 ? 16 : 6));
  const heap0 = await page.evaluate(() => Math.round(performance.memory.usedJSHeapSize / 1048576));
  console.log('heap at run start MB', heap0);
  const t0 = Date.now();
  let shot = 3;
  let phase = 0;
  await page.mouse.move(640, 250);
  while (Date.now() - t0 < seconds * 1000) {
    if (auto) { await sleep(1500); } else {
    const keys = [['KeyW', 'KeyD'], ['KeyD', 'KeyS'], ['KeyS', 'KeyA'], ['KeyA', 'KeyW']][phase % 4];
    for (const k of keys) await page.keyboard.down(k);
    await page.mouse.move(640 + Math.cos(phase) * 180, 300 + Math.sin(phase) * 120);
    await page.mouse.down({ button: 'left' });
    await sleep(700);
    if (phase % 3 === 0) { await page.mouse.down({ button: 'right' }); await sleep(60); await page.mouse.up({ button: 'right' }); }
    if (phase % 4 === 1) { await page.keyboard.down('Space'); await sleep(50); await page.keyboard.up('Space'); }
    await sleep(500);
    await page.mouse.up({ button: 'left' });
    for (const k of keys) await page.keyboard.up(k);
    }
    const card = await page.$(tid('draft-card-0'));
    if (card && !auto) { await page.screenshot({ path: `${out}-${shot++}-draft.png` }); await card.click(); await sleep(400); }
    if (phase % shotEvery === 3) await page.screenshot({ path: `${out}-${shot++}-game.png` });
    const screen = await page.evaluate('document.body.dataset.screen');
    if (screen !== 'game') { console.log('screen ->', screen, 'after', Math.round((Date.now() - t0) / 1000), 's'); await sleep(2500); break; }
    phase++;
  }
  await page.screenshot({ path: `${out}-${shot++}-end.png` });
  if (await page.$(tid('summary-to-lobby'))) {
    await page.click(tid('summary-to-lobby'));
    await page.waitForFunction("document.body.dataset.screen === 'lobby'", { timeout: 15000 });
    console.log('returned to lobby: ok');
    await page.evaluate(() => { window.__game.renderEvery = 1; });
    await sleep(1500);
    await page.screenshot({ path: `${out}-${shot++}-lobby-again.png` });
  }
  const text = JSON.parse(await page.evaluate('window.render_game_to_text()'));
  console.log('perf', JSON.stringify(await page.evaluate(() => ({ loopFps: window.__game.fps, logicFrameMs: +window.__game.logicFrameMs.toFixed(2), drawFrameMs: +window.__game.drawFrameMs.toFixed(1), heapMB: Math.round(performance.memory.usedJSHeapSize / 1048576) })))); console.log(JSON.stringify({ screen: text.screen, conn: text.conn, phase: text.run?.phase, chamber: text.run?.chamber, wave: text.run?.wave, enemies: text.enemiesAlive, self: text.players?.find((p) => p.slot === text.conn.slot), predicted: text.predicted, render: text.render, stats: text.run?.stats }));
} catch (e) {
  console.log('DRIVER ERROR', e.message);
  await page.screenshot({ path: `${out}-error.png` }).catch(() => {});
} finally {
  console.log('--- console issues:', errs.length);
  console.log([...new Set(errs)].slice(0, 15).join('\n'));
  if (botProc) { try { process.kill(-botProc.pid, 'SIGTERM'); } catch { /* gone */ } }
  await browser.close();
}
