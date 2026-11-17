// Performance probe: 4-player fight in a late chamber; measures main-thread frame cost without GPU work,
// render statistics, heap growth and network throughput. Usage: node tests/e2e/tools/perf-probe.mjs <clientUrl> <wsUrl> <seconds>
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
const [clientUrl, wsUrl, secondsArg] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tid = (id) => `[data-testid="${id}"]`;
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-background-networking', '--no-first-run', '--enable-precise-memory-info', '--js-flags=--expose-gc', '--window-size=1280,720'] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
const cdp = await page.createCDPSession();
await cdp.send('Network.enable');
let rx = 0, tx = 0, rxFrames = 0;
cdp.on('Network.webSocketFrameReceived', (e) => { rx += e.response.payloadData.length * (e.response.opcode === 2 ? 0.75 : 1); rxFrames++; });
cdp.on('Network.webSocketFrameSent', (e) => { tx += e.response.payloadData.length * (e.response.opcode === 2 ? 0.75 : 1); });
let bots;
try {
  await page.goto(clientUrl, { waitUntil: 'load' });
  await page.waitForFunction("document.body.dataset.screen === 'menu'", { timeout: 120000 });
  await page.type(tid('menu-name'), 'Perf');
  await page.click(tid('menu-host'));
  await page.waitForFunction("document.body.dataset.screen === 'lobby'");
  const code = await page.$eval(tid('lobby-code'), (el) => el.textContent.trim());
  bots = spawn('npx', ['tsx', 'server/src/tools/botClient.ts', '--url', wsUrl, '--code', code, '--bots', '3', '--cls', 'mage,rogue,barbarian'], { stdio: 'ignore', detached: true });
  await page.waitForFunction(() => document.querySelectorAll('[data-testid^="lobby-slot-"][data-connected="true"]').length === 4, { timeout: 30000 });
  await page.click(tid('lobby-ready'));
  await sleep(500);
  await page.click(tid('lobby-start'));
  await page.waitForFunction("document.body.dataset.screen === 'game'");
  await page.evaluate(() => { window.__game.renderEvery = 100000; window.gc?.(); });
  const heapStart = await page.evaluate(() => performance.memory.usedJSHeapSize / 1048576);
  rx = tx = rxFrames = 0;
  const t0 = Date.now();
  const rows = [];
  while (Date.now() - t0 < Number(secondsArg) * 1000) {
    await sleep(5000);
    const row = await page.evaluate(() => {
      const g = window.__game; const snap = g.latestSnapshot();
      return { screen: document.body.dataset.screen, fps: g.fps, logicMs: g.logicFrameMs, enemies: snap?.enemies.length ?? 0, proj: snap?.projectiles.length ?? 0, heap: performance.memory.usedJSHeapSize / 1048576, ...g.view.getDebug?.() };
    });
    rows.push(row);
    if (row.screen !== 'game') break;
  }
  const secs = (Date.now() - t0) / 1000;
  // One real draw to read the renderer statistics of the current (busy) frame.
  await page.evaluate(() => { window.__game.renderEvery = 1; });
  await sleep(2500);
  const stats = await page.evaluate(() => ({ ...window.__game.view.getStats(), drawMs: window.__game.drawFrameMs }));
  await page.evaluate(() => { window.gc?.(); });
  const heapEnd = await page.evaluate(() => performance.memory.usedJSHeapSize / 1048576);
  const game = rows.filter((r) => r.screen === 'game');
  const avg = (k) => game.reduce((s, r) => s + r[k], 0) / Math.max(1, game.length);
  const max = (k) => Math.max(...game.map((r) => r[k]));
  console.log(JSON.stringify({
    seconds: Math.round(secs), samples: game.length,
    loopFps: { avg: +avg('fps').toFixed(1), min: Math.min(...game.map((r) => r.fps)) },
    logicFrameMs: { avg: +avg('logicMs').toFixed(2), max: +max('logicMs').toFixed(2) },
    enemies: { avg: +avg('enemies').toFixed(1), max: max('enemies') }, projectilesMax: max('proj'),
    heapMB: { start: +heapStart.toFixed(1), end: +heapEnd.toFixed(1), peak: +max('heap').toFixed(1) },
    net: { downKBs: +(rx / 1024 / secs).toFixed(1), upKBs: +(tx / 1024 / secs).toFixed(2), framesPerSec: +(rxFrames / secs).toFixed(1) },
    render: stats, errors: errs.length,
  }));
} catch (e) { console.log('PERF ERROR', e.message); } finally {
  if (bots) { try { process.kill(-bots.pid, 'SIGTERM'); } catch { /* gone */ } }
  await browser.close();
}
