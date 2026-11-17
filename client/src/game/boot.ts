/**
 * Game orchestrator: loads assets, owns the frame loop and connects net <-> prediction <-> render.
 * UI and audio run on their own, driven by GameState and the EventBus.
 */
import { NET, TICK_DT } from '@shared/constants.ts';
import { ELEMENT_IDS, type AbilitySlot, type ClassId, type ElementId, type InputCmd, type PlayerSnap, type Snapshot } from '@shared/types.ts';
import { initAudio } from '../audio/index.ts';
import { bus } from '../core/EventBus.ts';
import { bookRewards, bookRunEnd, state } from '../core/GameState.ts';
import { settings } from '../core/Settings.ts';
import { applyCursor } from './Cursor.ts';
import { NetClient } from '../net/NetClient.ts';
import { Prediction } from '../net/Prediction.ts';
import { SnapshotBuffer } from '../net/SnapshotBuffer.ts';
import { loadAssets, WorldView } from '../render/index.ts';
import { initUI } from '../ui/index.ts';
import { Input, type InputSample } from './Input.ts';

/** Longest frame time fed into the simulation; longer stalls (tab switch) are dropped, not replayed. */
const MAX_FRAME_SECONDS = 0.1;
const MAX_TICKS_PER_FRAME = 4;
const FRAME_COST_SMOOTHING = 0.05;

async function boot(): Promise<void> {
  const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
  const uiRoot = document.getElementById('ui-root') as HTMLElement;
  initUI(uiRoot);
  initAudio();

  let assets;
  try {
    assets = await loadAssets((loaded, total) => bus.emit('assets:progress', { loaded, total }));
  } catch (err) {
    console.error('[boot] asset loading failed', err);
    bus.emit('assets:error', { message: err instanceof Error ? err.message : String(err) });
    return;
  }
  bus.emit('assets:ready');

  const view = new WorldView(canvas, assets);
  const net = new NetClient();
  const buffer = new SnapshotBuffer();
  const prediction = new Prediction();
  const input = new Input(canvas);
  const params = new URLSearchParams(window.location.search);
  const autopilot = import.meta.env.DEV && params.has('autopilot') ? (await import('../dev/autopilot.ts')).createAutopilot() : null;

  const applySettings = (): void => {
    view.setQuality(settings.quality);
    view.setShake(settings.shake);
    view.setZoom(settings.zoom);
    view.setDamageNumbers(settings.damageNumbers);
    applyCursor(canvas, settings.cursor, input.enabled);
  };
  applySettings();
  bus.on('settings:changed', applySettings);
  window.addEventListener('resize', () => view.resize());

  // ---- session / state wiring
  let seq = 0;
  let accumulator = 0;
  let lastSelf: PlayerSnap | null = null;
  /** The run just ended in front of this client and its Glimmer has not been credited yet. */
  let rewardPending = false;
  let endedClass: ClassId = state.profile.cls;
  const sample: InputSample = { moveX: 0, moveZ: 0, aim: 0, aimDist: 0, buttons: 0 };
  const toGround = (x: number, y: number, out: { x: number; z: number }): boolean => view.screenToGround(x, y, out);

  const resetWorld = (): void => {
    buffer.clear();
    prediction.reset();
    view.clearSession();
    lastSelf = null;
    accumulator = 0;
  };

  const syncRoom = (): void => {
    const run = state.run;
    const inRun = run !== null && run.phase !== 'lobby';
    view.setRoom(inRun ? run.room : null, run?.chamberKind ?? 'combat', run?.chamber ?? 0);
    view.setDoors(inRun && run.phase === 'doors' ? run.doors : [], inRun ? run.doorProgress : []);
  };

  const updateInputEnabled = (): void => {
    const enabled = state.screen === 'game' && !state.overlayOpen;
    if (input.enabled && !enabled) input.release();
    input.enabled = enabled;
    applyCursor(canvas, settings.cursor, enabled);
  };

  net.onSnapshot = (snap: Snapshot, receivedAt: number): void => {
    buffer.push(snap, receivedAt);
    lastSelf = snap.players.find((p) => p.slot === state.conn.slot) ?? null;
    prediction.reconcile(snap.self, state.run?.room ?? null, lastSelf);
    state.players = snap.players;
    state.enemiesAlive = snap.enemies.length;
    const bossId = state.run?.bossId ?? -1;
    const boss = bossId >= 0 ? snap.enemies.find((e) => e.id === bossId) : undefined;
    state.bossHp = boss ? boss.hp : null;
    bus.emit('state:hud');
  };

  const INFUSION_ID = /^infuse_([a-z]+)_(primary|secondary|dash|ultimate)$/;
  bus.on('state:roster', () => {
    view.setRoster(state.roster.map((p) => ({ slot: p.slot, cls: p.cls, name: p.name, look: p.look })));
    for (const p of state.roster) {
      const infusions: Record<AbilitySlot, ElementId | null> = { primary: null, secondary: null, dash: null, ultimate: null };
      for (const boon of p.boons) {
        const match = INFUSION_ID.exec(boon.id);
        if (match && (ELEMENT_IDS as readonly string[]).includes(match[1])) infusions[match[2] as AbilitySlot] = match[1] as ElementId;
      }
      view.setInfusions(p.slot, infusions);
    }
  });

  // Hero preview behind the wardrobe / class picker (only while no chamber is shown).
  let showcase: { cls: ClassId; screenX: number } | null = null;
  const applyShowcase = (): void => {
    const visible = showcase !== null && state.screen !== 'game' && state.screen !== 'summary';
    view.setShowcase(visible && showcase ? { cls: showcase.cls, look: state.profile.looks[showcase.cls], screenX: showcase.screenX } : null);
  };
  bus.on('ui:showcase', (request) => { showcase = request; applyShowcase(); });
  bus.on('state:profile', applyShowcase);
  bus.on('state:screen', applyShowcase);
  bus.on('state:screen', updateInputEnabled);
  bus.on('ui:overlay', ({ open }) => { state.overlayOpen = open; updateInputEnabled(); });
  bus.on('net:status', () => {
    if (state.conn.status === 'offline') resetWorld();
    updateInputEnabled();
  });
  bus.on('game:event', (event) => view.handleEvent(event));
  bus.on('state:run', ({ previousPhase }) => {
    const run = state.run;
    if (!run) return;
    if (run.phase === 'lobby' && previousPhase !== 'lobby') {
      resetWorld();
      state.players = [];
      state.enemiesAlive = 0;
      state.bossHp = null;
      bus.emit('state:hud');
    }
    syncRoom();
    view.setMarker(run.tutorial?.marker ?? null);
    const over = run.phase === 'victory' || run.phase === 'defeat';
    // Only count a run whose ending this client witnessed (not one found already over after a reload).
    const ended = over && previousPhase !== run.phase && previousPhase !== null;
    if (ended) {
      endedClass = state.roster.find((p) => p.slot === state.conn.slot)?.cls ?? state.profile.cls;
      bookRunEnd(run, endedClass);
      rewardPending = true;
    }
    if (!over) rewardPending = false;
    if (over && rewardPending && run.rewards.some((r) => r.slot === state.conn.slot)) {
      rewardPending = false;
      bookRewards(run, endedClass);
    }
  });

  // ---- frame loop
  const tick = (): void => {
    const run = state.run;
    const room = run?.room ?? null;
    if (!net.online || !room || !prediction.ready) return;
    const me = lastSelf;
    const own = state.roster.find((p) => p.slot === state.conn.slot);
    input.sample(prediction.renderX(1), prediction.renderZ(1), toGround, sample);
    const latest = autopilot ? buffer.latest() : null;
    const piloted = autopilot && latest && input.enabled ? autopilot.think(latest) : null;
    if (piloted) Object.assign(sample, { moveX: piloted.moveX, moveZ: piloted.moveZ, aim: piloted.aim, aimDist: piloted.aimDist, buttons: piloted.buttons });
    const cmd: InputCmd = { seq: ++seq, moveX: sample.moveX, moveZ: sample.moveZ, aim: sample.aim, aimDist: sample.aimDist, buttons: sample.buttons };
    net.sendInput(cmd);
    const action = prediction.step(cmd, room, me, own?.cls ?? 'knight', own?.art ?? 0);
    if (action) {
      bus.emit('game:localAction', { action });
      if (action !== 'denied') view.localAction(action);
    }
  };

  let last = performance.now();
  let frameIndex = 0;
  let fpsFrames = 0;
  let fpsSince = last;
  const frame = (now: number): void => {
    const elapsed = (now - last) / 1000;
    const dt = Math.min(MAX_FRAME_SECONDS, elapsed);
    last = now;
    fpsFrames++;
    if (now - fpsSince >= 1000) {
      debug.fps = Math.round((fpsFrames * 1000) / (now - fpsSince));
      fpsFrames = 0;
      fpsSince = now;
    }
    const playing = state.screen === 'game' || state.screen === 'summary';

    if (playing) {
      accumulator += dt;
      let steps = 0;
      while (accumulator >= TICK_DT && steps < MAX_TICKS_PER_FRAME) {
        tick();
        accumulator -= TICK_DT;
        steps++;
      }
      if (accumulator > TICK_DT) accumulator = 0;
      prediction.smooth(elapsed);

      view.setServerTick(buffer.renderTick(now));
      const interpolated = buffer.sample(now);
      if (prediction.ready) {
        const alpha = accumulator / TICK_DT;
        for (const p of interpolated.players) {
          if (p.slot !== state.conn.slot) continue;
          // The own hero is drawn at the predicted position with the freshest authoritative status.
          if (lastSelf) Object.assign(p, lastSelf);
          p.x = prediction.renderX(alpha);
          p.z = prediction.renderZ(alpha);
          if (p.state === 'alive') p.rot = prediction.dashing ? prediction.dashRot : sample.aim;
        }
      }
      view.syncPlayers(interpolated.players, state.conn.slot);
      view.syncEnemies(interpolated.enemies);
      view.syncProjectiles(interpolated.projectiles);
      if (state.run?.phase === 'doors') view.setDoors(state.run.doors, state.run.doorProgress);
    }
    // Tests on machines without a GPU may draw only every n-th frame so the game logic keeps real-time pace.
    const draw = frameIndex++ % debug.renderEvery === 0;
    view.update(dt, draw);
    const cost = performance.now() - now;
    if (draw) debug.drawFrameMs += (cost - debug.drawFrameMs) * FRAME_COST_SMOOTHING;
    else debug.logicFrameMs += (cost - debug.logicFrameMs) * FRAME_COST_SMOOTHING;
    requestAnimationFrame(frame);
  };

  // ---- test / debug hooks
  const debug = {
    state, bus, net, view, input, prediction,
    seq: () => seq,
    latestSnapshot: () => buffer.latest(),
    interpDelayMs: NET.INTERP_DELAY_MS,
    renderEvery: 1,
    fps: 0,
    /** Smoothed main-thread cost of a frame without / with the WebGL draw (ms). */
    logicFrameMs: 0,
    drawFrameMs: 0,
  };
  Object.assign(window, {
    __game: debug,
    render_game_to_text: (): string => JSON.stringify({
      screen: state.screen,
      conn: state.conn,
      roster: state.roster,
      run: state.run && { ...state.run, room: state.run.room && { w: state.run.room.w, d: state.run.room.d, obstacles: state.run.room.obstacles.length } },
      draft: state.draft,
      players: state.players,
      enemiesAlive: state.enemiesAlive,
      bossHp: state.bossHp,
      predicted: prediction.ready ? { x: prediction.renderX(1), z: prediction.renderZ(1) } : null,
      render: view.getStats(),
    }),
  });

  if (!net.resume()) {
    state.screen = 'menu';
    bus.emit('state:screen');
  }
  requestAnimationFrame(frame);
}

void boot();
