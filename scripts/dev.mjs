#!/usr/bin/env node
/**
 * Starts the game server (tsx watch, :8787) and the Vite client (:5173) together.
 * Output is prefixed per process; Ctrl+C (or either process exiting) stops both.
 */
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const isWindows = process.platform === 'win32';
const npm = isWindows ? 'npm.cmd' : 'npm';
const KILL_GRACE_MS = 3000;

const targets = [
  { name: 'server', color: '\x1b[36m', args: ['run', 'dev', '-w', 'server'] },
  { name: 'client', color: '\x1b[35m', args: ['run', 'dev', '-w', 'client'] },
];
const RESET = '\x1b[0m';
const children = [];
let stopping = false;
let exitCode = 0;

function prefixLines(stream, target, sink) {
  let pending = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? '';
    for (const line of lines) sink.write(`${target.color}[${target.name}]${RESET} ${line}\n`);
  });
  stream.on('end', () => {
    if (pending) sink.write(`${target.color}[${target.name}]${RESET} ${pending}\n`);
  });
}

function killTree(child, signal) {
  if (child.exitCode !== null || child.pid === undefined) return;
  try {
    if (isWindows) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-child.pid, signal); // negative pid = the whole process group (npm -> tsx/vite -> node)
  } catch {
    try { child.kill(signal); } catch { /* already gone */ }
  }
}

function stop(code) {
  if (stopping) return;
  stopping = true;
  exitCode = code;
  for (const child of children) killTree(child, 'SIGTERM');
  setTimeout(() => {
    for (const child of children) killTree(child, 'SIGKILL');
    process.exit(exitCode);
  }, KILL_GRACE_MS).unref();
}

for (const target of targets) {
  const child = spawn(npm, target.args, {
    cwd: root,
    env: { ...process.env, FORCE_COLOR: process.env.FORCE_COLOR ?? '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: !isWindows,
    shell: isWindows,
  });
  children.push(child);
  prefixLines(child.stdout, target, process.stdout);
  prefixLines(child.stderr, target, process.stderr);
  child.on('error', (err) => {
    process.stderr.write(`[dev] failed to start ${target.name}: ${err.message}\n`);
    stop(1);
  });
  child.on('exit', (code, signal) => {
    if (!stopping) process.stderr.write(`[dev] ${target.name} exited (${signal ?? code}); stopping the other process\n`);
    stop(code ?? 0);
    if (children.every((c) => c.exitCode !== null || c.signalCode !== null)) process.exit(exitCode);
  });
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => stop(0));
process.on('exit', () => {
  for (const child of children) killTree(child, 'SIGKILL');
});
