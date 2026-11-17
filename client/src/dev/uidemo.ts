/**
 * UI + audio dev harness: http://localhost:5175/?uidemo
 *
 * Plays the role of the integrator with fake data: writes GameState, emits the bus events and reacts to
 * `ui:*` intents (which are logged to the console). No network, no Three.js.
 *
 *   Hash routes   #loading #loading-error #menu #connecting #howto #settings #lobby #lobby-guest
 *                 #game #elite #boss #downed #solo #doors #draft #draft-cursed #draft-wait #tab #pause
 *                 #summary-win #summary-loss #error #reconnecting #toasts
 *   Query params  lang=en|de   bg=noisy (busy backdrop for contrast checks)   panel=0 (hide the dev panel)
 *   window.__uidemo  { go, fire, error, audio, renderAudio }  for scripted checks
 */
import { RUN } from '@shared/constants.ts';
import { BOON_TUNING } from '@shared/data/boons.ts';
import { CLASSES } from '@shared/data/classes.ts';
import { ERROR_CODES } from '@shared/protocol.ts';
import { PF, type BoonOffer, type GameEvent, type PlayerSnap, type RosterEntry, type RunState } from '@shared/types.ts';
import { audioDebug, initAudio } from '../audio/index.ts';
import { renderMusic, renderSfx, renderStinger, renderStress, SFX_CASES, type RenderStats } from '../audio/offline.ts';
import { bus, type ConnError, type EventMap } from '../core/EventBus.ts';
import { resetSession, state, type Screen } from '../core/GameState.ts';
import { updateSettings } from '../core/Settings.ts';
import { initUI } from '../ui/index.ts';
import { ui } from '../ui/store.ts';

const HUD_TICK_MS = 66;
const RUN_TICK_MS = 250;
const CONNECT_MS = 700;
const OWN_SLOT = 0;
const GUEST_SLOT = 1;
const CONN_ERRORS: ConnError[] = [...ERROR_CODES, 'unreachable', 'connection_lost'];

const params = new URLSearchParams(window.location.search);

// ------------------------------------------------------------------ fake data

function roster(): RosterEntry[] {
  return [
    {
      slot: 0, name: 'Aldric', cls: 'knight', ready: true, connected: true, host: true,
      boons: [
        { id: 'infuse_ember_primary', level: 1 }, { id: 'keen_edge', level: 2 }, { id: 'barrier', level: 1 },
        { id: 'amplifier', level: 1 }, { id: 'spare_step', level: 1 }, { id: 'kindred_flame', level: 1 },
      ],
    },
    {
      slot: 1, name: 'Brunhild', cls: 'barbarian', ready: true, connected: true, host: false,
      boons: [{ id: 'infuse_storm_secondary', level: 1 }, { id: 'heavy_hand', level: 3 }, { id: 'iron_heart', level: 2 }],
    },
    {
      slot: 2, name: 'Mirelle', cls: 'mage', ready: false, connected: true, host: false,
      boons: [
        { id: 'infuse_rime_primary', level: 2 }, { id: 'deep_frost', level: 1 }, { id: 'echo', level: 1 },
        { id: 'quick_wits', level: 2 },
      ],
    },
    {
      slot: 3, name: 'Schattenklinge99', cls: 'rogue', ready: true, connected: false, host: false,
      boons: [{ id: 'deadeye', level: 1 }, { id: 'fleet_foot', level: 2 }],
    },
  ];
}

function players(): PlayerSnap[] {
  const base = { rot: 0, anim: 'idle' as const, animSeq: 0, revive: 0 };
  return [
    { ...base, slot: 0, x: 0, z: 0, hp: 87, maxHp: 130, shield: 22, state: 'alive', cdSecondary: 0.45, cdDash: 0.6, dashCharges: 1, flags: PF.CONNECTED },
    { ...base, slot: 1, x: 5, z: -3, hp: 96, maxHp: 160, shield: 0, state: 'alive', cdSecondary: 0, cdDash: 0, dashCharges: 1, flags: PF.CONNECTED },
    { ...base, slot: 2, x: 4, z: 3, hp: 0, maxHp: 85, shield: 0, state: 'downed', cdSecondary: 0, cdDash: 0, dashCharges: 1, revive: 0.4, flags: PF.CONNECTED },
    { ...base, slot: 3, x: -8, z: 6, hp: 28, maxHp: 95, shield: 0, state: 'alive', cdSecondary: 0, cdDash: 0, dashCharges: 2, flags: 0 },
  ];
}

function run(patch: Partial<RunState> = {}): RunState {
  return {
    phase: 'combat', oath: 2, chamber: 4, chamberKind: 'combat', entered: 'cursed', wave: 2, waveCount: 3, room: null,
    doors: [], doorProgress: [], bossId: -1, draftPending: [], draftTime: RUN.DRAFT_TIMEOUT_SECONDS, elapsed: 437,
    stats: [
      { slot: 0, damage: 12480, kills: 61, resonances: 14, revives: 2, downs: 1 },
      { slot: 1, damage: 15230, kills: 74, resonances: 9, revives: 1, downs: 0 },
      { slot: 2, damage: 9870, kills: 38, resonances: 21, revives: 0, downs: 3 },
      { slot: 3, damage: 4410, kills: 19, resonances: 2, revives: 0, downs: 2 },
    ],
    secondWinds: 0,
    ...patch,
  };
}

const DRAFT: BoonOffer[] = [{ id: 'keen_edge', level: 3 }, { id: 'infuse_rime_secondary', level: 1 }, { id: 'echo', level: 1 }];
const DRAFT_CURSED: BoonOffer[] = [
  { id: 'infuse_storm_dash', level: 2 }, { id: 'oathbond', level: 1 }, { id: 'iron_heart', level: 1 }, { id: 'deep_frost', level: 2 },
];

// ------------------------------------------------------------------ integrator stand-in

function emitAll(): void {
  bus.emit('net:status');
  bus.emit('state:roster');
  bus.emit('state:run', { previousPhase: null });
  bus.emit('state:draft');
  bus.emit('state:hud');
}

function setScreen(screen: Screen): void {
  state.screen = screen;
  bus.emit('state:screen');
}

function session(slot = OWN_SLOT): void {
  state.conn.status = 'online';
  state.conn.code = 'K7QXM';
  state.conn.slot = slot;
  state.conn.pingMs = 42;
  state.roster = roster();
  state.oath = 2;
}

function setRun(next: RunState): void {
  const previousPhase = state.run?.phase ?? null;
  state.run = next;
  bus.emit('state:run', { previousPhase });
}

function inGame(patch: Partial<RunState> = {}): void {
  session();
  state.players = players();
  state.enemiesAlive = 17;
  state.bossHp = null;
  state.draft = [];
  state.run = run(patch);
  setScreen('game');
  emitAll();
}

function baseline(): void {
  resetSession();
  ui.modal = null;
  ui.pause = false;
  ui.pauseConfirm = false;
  ui.tab = false;
  ui.fatal = null;
  ui.assetError = null;
  ui.picked = -1;
  Object.assign(state.profile, { runs: 23, wins: 6, bestChamber: 8, oathUnlocked: 2 });
}

const ROUTES: Record<string, () => void> = {
  loading: () => { setScreen('loading'); bus.emit('assets:progress', { loaded: 23, total: 37 }); },
  'loading-error': () => {
    setScreen('loading');
    bus.emit('assets:error', { message: 'GET /assets/models/knight.glb 404 (Not Found)' });
  },
  menu: () => { setScreen('menu'); emitAll(); },
  connecting: () => { state.conn.status = 'connecting'; setScreen('menu'); emitAll(); },
  howto: () => { setScreen('menu'); ui.modal = 'howto'; emitAll(); },
  settings: () => { setScreen('menu'); ui.modal = 'settings'; emitAll(); },
  lobby: () => { session(); state.oath = 1; state.run = run({ phase: 'lobby' }); setScreen('lobby'); emitAll(); },
  'lobby-guest': () => { session(GUEST_SLOT); state.run = run({ phase: 'lobby' }); setScreen('lobby'); emitAll(); },
  game: () => inGame(),
  elite: () => { inGame({ chamber: 3, chamberKind: 'elite', entered: 'boon', wave: 1, waveCount: 1 }); state.bossHp = 0.58; state.enemiesAlive = 4; emitAll(); },
  boss: () => { inGame({ chamber: 7, chamberKind: 'boss', entered: 'boss', wave: 1, waveCount: 1 }); state.bossHp = 0.47; state.enemiesAlive = 5; emitAll(); },
  downed: () => {
    inGame();
    const me = state.players[0];
    Object.assign(me, { hp: 0, state: 'downed', revive: 0.55, flags: PF.CONNECTED | PF.BEING_REVIVED });
    state.players[2] = { ...state.players[2], hp: 40, state: 'alive', revive: 0 };
    emitAll();
  },
  solo: () => {
    inGame({ secondWinds: 1, oath: 0, entered: 'boon', chamber: 1 });
    state.roster = roster().slice(0, 1);
    state.players = players().slice(0, 1);
    state.players[0].hp = 21;
    emitAll();
  },
  doors: () => {
    inGame({
      phase: 'doors', doors: [{ x: -6, z: -10, type: 'blessing' }, { x: 6, z: -10, type: 'cursed' }], doorProgress: [0.2, 0.65],
    });
    state.players[2] = { ...state.players[2], hp: 34, state: 'alive', revive: 0 };
    state.enemiesAlive = 0;
    emitAll();
  },
  draft: () => { inGame({ phase: 'draft', draftPending: [0, 1, 2], draftTime: 32 }); state.enemiesAlive = 0; state.draft = [...DRAFT]; emitAll(); },
  'draft-cursed': () => {
    inGame({ phase: 'draft', draftPending: [0, 2], draftTime: 4.4 });
    state.enemiesAlive = 0;
    state.draft = DRAFT_CURSED.slice(0, BOON_TUNING.CURSED_DRAFT_CHOICES);
    emitAll();
  },
  'draft-wait': () => { inGame({ phase: 'draft', draftPending: [1, 2], draftTime: 18 }); state.enemiesAlive = 0; emitAll(); },
  tab: () => { inGame(); ui.tab = true; emitAll(); },
  pause: () => { inGame(); ui.pause = true; emitAll(); },
  'summary-win': () => {
    session();
    ui.oathBaseline = 2;
    state.run = run({ phase: 'victory', chamber: 7, chamberKind: 'boss', elapsed: 754 });
    setScreen('summary');
    emitAll();
  },
  'summary-loss': () => {
    session(GUEST_SLOT);
    state.run = run({ phase: 'defeat', chamber: 5, elapsed: 512 });
    setScreen('summary');
    emitAll();
  },
  error: () => { setScreen('menu'); emitAll(); bus.emit('net:error', { error: 'room_not_found', fatal: true }); },
  reconnecting: () => { inGame(); state.conn.status = 'reconnecting'; state.conn.pingMs = 312; emitAll(); },
  toasts: () => {
    inGame();
    fire({ e: 'wave', wave: 2, waveCount: 3 });
    fire({ e: 'boon', slot: 1, id: 'heavy_hand', level: 3 });
    fire({ e: 'down', slot: 2 });
    fire({ e: 'revived', slot: 3, by: 1 });
    bus.emit('net:error', { error: 'rate_limited', fatal: false });
  },
};

function go(route: string): void {
  baseline();
  (ROUTES[route] ?? ROUTES.menu)();
}

function fire(ev: GameEvent): void {
  bus.emit('game:event', ev);
}

const at = { x: 2, z: -1 };
const EVENTS: [string, () => void][] = [
  ['hit', () => fire({ e: 'hit', target: { t: 'e', id: 7 }, ...at, dmg: 18, crit: false, el: null, by: 0 })],
  ['hit crit', () => fire({ e: 'hit', target: { t: 'e', id: 7 }, ...at, dmg: 62, crit: true, el: null, by: 0 })],
  ['hit ember', () => fire({ e: 'hit', target: { t: 'e', id: 7 }, ...at, dmg: 22, crit: false, el: 'ember', by: 0 })],
  ['hit rime', () => fire({ e: 'hit', target: { t: 'e', id: 7 }, ...at, dmg: 22, crit: false, el: 'rime', by: 0 })],
  ['hit storm', () => fire({ e: 'hit', target: { t: 'e', id: 7 }, ...at, dmg: 22, crit: false, el: 'storm', by: 0 })],
  ['hurt own', () => { state.players[0].hp = Math.max(1, state.players[0].hp - 14); bus.emit('state:hud'); fire({ e: 'hit', target: { t: 'p', id: 0 }, ...at, dmg: 14, crit: false, el: null, by: -1 }); }],
  ['hurt ally', () => fire({ e: 'hit', target: { t: 'p', id: 1 }, ...at, dmg: 14, crit: false, el: null, by: -1 })],
  ['kill', () => fire({ e: 'kill', id: 7, kind: 'minion', ...at, by: 0 })],
  ['kill boss', () => fire({ e: 'kill', id: 1, kind: 'regent', ...at, by: 0 })],
  ['res ember>rime', () => fire({ e: 'resonance', ...at, r: 3, a: 'ember', b: 'rime', by: 0 })],
  ['res storm>ember', () => fire({ e: 'resonance', ...at, r: 3, a: 'storm', b: 'ember', by: 0 })],
  ['res rime>storm', () => fire({ e: 'resonance', ...at, r: 3, a: 'rime', b: 'storm', by: 1 })],
  ['status', () => fire({ e: 'status', id: 7, el: 'rime' })],
  ['telegraph', () => fire({ e: 'telegraph', shape: 'circle', ...at, rot: 0, r: 2.4, w: 0, dur: 1.1 })],
  ...Object.values(CLASSES).flatMap((def): [string, () => void][] => [
    [`${def.id} primary`, () => fire({ e: 'cast', who: { t: 'p', id: 1 }, ability: def.primary[def.primary.length - 1].id, ...at, rot: 0 })],
    [`${def.id} secondary`, () => fire({ e: 'cast', who: { t: 'p', id: 1 }, ability: def.secondary.id, ...at, rot: 0 })],
  ]),
  ['enemy cast', () => fire({ e: 'cast', who: { t: 'e', id: 7 }, ability: 'sweep', ...at, rot: 0 })],
  ['aoe hostile', () => fire({ e: 'aoe', ...at, r: 2.4, el: null, hostile: true })],
  ['aoe ember', () => fire({ e: 'aoe', ...at, r: 3.2, el: 'ember', hostile: false })],
  ['heal', () => fire({ e: 'heal', slot: 0, amount: 12 })],
  ['down', () => fire({ e: 'down', slot: 2 })],
  ['revived', () => fire({ e: 'revived', slot: 2, by: 0 })],
  ['shield break', () => fire({ e: 'shieldBreak', id: 9 })],
  ['spawn', () => fire({ e: 'spawn', id: 12, kind: 'minion', ...at, elite: false })],
  ['spawn boss', () => fire({ e: 'spawn', id: 1, kind: 'regent', ...at, elite: false })],
  ['wave', () => fire({ e: 'wave', wave: 3, waveCount: 3 })],
  ['chamber clear', () => fire({ e: 'chamberClear' })],
  ['boss phase 2', () => fire({ e: 'bossPhase', phase: 2 })],
  ['boss phase 3', () => fire({ e: 'bossPhase', phase: 3 })],
  ['boon ally', () => fire({ e: 'boon', slot: 1, id: 'infuse_storm_secondary', level: 1 })],
  ['boon own', () => fire({ e: 'boon', slot: 0, id: 'echo', level: 1 })],
  ['door boon', () => fire({ e: 'doorChosen', type: 'boon' })],
  ['door blessing', () => fire({ e: 'doorChosen', type: 'blessing' })],
  ['door cursed', () => fire({ e: 'doorChosen', type: 'cursed' })],
  ['door boss', () => fire({ e: 'doorChosen', type: 'boss' })],
  ['local primary', () => bus.emit('game:localAction', { action: 'primary' })],
  ['local secondary', () => bus.emit('game:localAction', { action: 'secondary' })],
  ['local dash', () => bus.emit('game:localAction', { action: 'dash' })],
  ['local denied', () => bus.emit('game:localAction', { action: 'denied' })],
];

// ------------------------------------------------------------------ reactions to ui:* intents

function wireIntents(): void {
  const intents: (keyof EventMap)[] = [
    'ui:create', 'ui:join', 'ui:lobby', 'ui:start', 'ui:pick', 'ui:toLobby', 'ui:leave', 'ui:overlay', 'ui:gesture',
  ];
  for (const name of intents) bus.on(name, (payload: unknown) => console.info(`[uidemo] ${name} ${payload === undefined ? '' : JSON.stringify(payload)}`));

  const connect = (): void => {
    state.conn.status = 'connecting';
    bus.emit('net:status');
    window.setTimeout(() => {
      if (state.conn.status !== 'connecting') return;
      session();
      state.roster = roster().slice(0, 1).map((p) => ({ ...p, name: state.profile.name || 'Warden', cls: state.profile.cls, ready: false, boons: [] }));
      state.oath = 0;
      state.run = run({ phase: 'lobby' });
      setScreen('lobby');
      emitAll();
    }, CONNECT_MS);
  };
  bus.on('ui:create', connect);
  bus.on('ui:join', connect);
  bus.on('ui:lobby', (patch) => {
    const me = state.roster.find((p) => p.slot === state.conn.slot);
    if (!me) return;
    if (patch.cls) me.cls = patch.cls;
    if (patch.ready !== undefined) me.ready = patch.ready;
    if (patch.oath !== undefined && me.host) state.oath = patch.oath;
    bus.emit('state:roster');
  });
  bus.on('ui:start', () => {
    const slot = state.conn.slot;
    const kept = state.roster;
    inGame({ chamber: 0, wave: 1, entered: 'boon', oath: state.oath, elapsed: 0 });
    state.roster = kept;
    state.conn.slot = slot;
    state.players = players().filter((p) => kept.some((r) => r.slot === p.slot));
    emitAll();
    fire({ e: 'wave', wave: 1, waveCount: 3 });
  });
  bus.on('ui:pick', () => {
    window.setTimeout(() => {
      if (!state.run || state.run.phase !== 'draft') return;
      state.draft = [];
      state.run.draftPending = state.run.draftPending.filter((s) => s !== state.conn.slot);
      bus.emit('state:draft');
      setRun({ ...state.run });
    }, 200);
  });
  bus.on('ui:toLobby', () => { state.run = run({ phase: 'lobby' }); setScreen('lobby'); emitAll(); });
  bus.on('ui:leave', () => { baseline(); setScreen('menu'); emitAll(); });
  bus.on('ui:overlay', ({ open }) => { state.overlayOpen = open; });
}

/** Keeps the fake HUD alive: cooldowns sweep, timers count down, door progress fills. */
function startTickers(): void {
  window.setInterval(() => {
    if (state.screen !== 'game' || params.get('freeze') !== null) return;
    const me = state.players.find((p) => p.slot === state.conn.slot);
    if (me && me.state === 'alive') {
      me.cdSecondary = me.cdSecondary <= 0 ? 1 : Math.max(0, me.cdSecondary - 0.012);
      me.cdDash = me.cdDash <= 0 ? 1 : Math.max(0, me.cdDash - 0.03);
    }
    bus.emit('state:hud');
  }, HUD_TICK_MS);
  window.setInterval(() => {
    const r = state.run;
    if (state.screen !== 'game' || !r || params.get('freeze') !== null) return;
    r.elapsed += RUN_TICK_MS / 1000;
    if (r.phase === 'draft') r.draftTime = Math.max(0, r.draftTime - RUN_TICK_MS / 1000);
    if (r.phase === 'doors') r.doorProgress = r.doorProgress.map((p, i) => (i === 1 ? (p + 0.04) % 1 : p));
    if (r.phase === 'draft' || r.phase === 'doors') bus.emit('state:run', { previousPhase: r.phase });
  }, RUN_TICK_MS);
}

// ------------------------------------------------------------------ backdrop + dev panel

function paintBackdrop(): void {
  const canvas = document.getElementById('game-canvas') as HTMLCanvasElement | null;
  const g = canvas?.getContext('2d');
  if (!canvas || !g) return;
  const draw = (): void => {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    const { width: w, height: hgt } = canvas;
    const grad = g.createLinearGradient(0, 0, w, hgt);
    grad.addColorStop(0, '#1a1f2c');
    grad.addColorStop(1, '#0b0d13');
    g.fillStyle = grad;
    g.fillRect(0, 0, w, hgt);
    if (params.get('bg') !== 'noisy') return;
    // Deliberately busy: bright torch pools, element-coloured blobs and hard edges under every HUD corner.
    let seed = 7;
    const rand = (): number => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const colours = ['#ff7a2e', '#58d8ff', '#b07bff', '#f4e3b0', '#7a8296', '#d8434f', '#e9c46a', '#ffffff', '#2c3350'];
    for (let i = 0; i < 260; i++) {
      g.globalAlpha = 0.35 + rand() * 0.6;
      g.fillStyle = colours[Math.floor(rand() * colours.length)];
      const size = 20 + rand() * 120;
      if (i % 2 === 0) g.fillRect(rand() * w, rand() * hgt, size, size * (0.3 + rand()));
      else { g.beginPath(); g.arc(rand() * w, rand() * hgt, size / 2, 0, Math.PI * 2); g.fill(); }
    }
    g.globalAlpha = 1;
  };
  draw();
  window.addEventListener('resize', draw);
}

function buildPanel(): void {
  if (params.get('panel') === '0') return;
  const panel = document.createElement('details');
  panel.open = false;
  panel.style.cssText = 'position:fixed;right:8px;bottom:8px;z-index:9999;max-width:340px;max-height:70vh;overflow:auto;'
    + 'padding:6px 8px;background:rgba(0,0,0,.88);border:1px solid #555;border-radius:6px;color:#ddd;font:11px/1.3 system-ui,sans-serif;';
  const summary = document.createElement('summary');
  summary.textContent = 'uidemo';
  summary.style.cursor = 'pointer';
  panel.append(summary);
  const section = (title: string, entries: [string, () => void][]): void => {
    const head = document.createElement('div');
    head.textContent = title;
    head.style.cssText = 'margin:6px 0 3px;color:#e9c46a;font-weight:700;';
    const box = document.createElement('div');
    box.style.cssText = 'display:flex;flex-wrap:wrap;gap:3px;';
    for (const [label, action] of entries) {
      const btn = document.createElement('button');
      btn.textContent = label;
      btn.style.cssText = 'padding:2px 6px;background:#222;border:1px solid #555;border-radius:3px;color:#ddd;font:inherit;cursor:pointer;';
      btn.addEventListener('click', action);
      box.append(btn);
    }
    panel.append(head, box);
  };
  section('Screens', Object.keys(ROUTES).map((route): [string, () => void] => [route, () => { window.location.hash = route; }]));
  section('Language', [['EN', () => updateSettings({ lang: 'en' })], ['DE', () => updateSettings({ lang: 'de' })]]);
  section('Game events (audio + toasts)', EVENTS);
  section('Errors', CONN_ERRORS.flatMap((error): [string, () => void][] => [
    [error, () => bus.emit('net:error', { error, fatal: false })],
    [`${error} !`, () => bus.emit('net:error', { error, fatal: true })],
  ]));
  document.body.append(panel);
}

// ------------------------------------------------------------------ scripted audio checks

async function renderAudio(): Promise<RenderStats[]> {
  const results: RenderStats[] = [];
  for (const name of ['menu', 'calm', 'combat', 'elite'] as const) results.push(await renderMusic(name, 12));
  for (const phase of [1, 2, 3]) results.push(await renderMusic('boss', 10, phase));
  results.push(await renderStinger('victory'), await renderStinger('defeat'));
  for (const [name, play] of SFX_CASES) results.push(await renderSfx(name, play));
  results.push(await renderStress());
  return results;
}

declare global {
  interface Window {
    __uidemo?: {
      go(route: string): void;
      fire(ev: GameEvent): void;
      fireAll(): void;
      error(error: ConnError, fatal: boolean): void;
      audio: typeof audioDebug;
      renderAudio(): Promise<RenderStats[]>;
      routes: string[];
      errors: ConnError[];
    };
  }
}

function boot(): void {
  const root = document.getElementById('ui-root');
  if (!root) throw new Error('#ui-root missing');
  const lang = params.get('lang');
  if (lang === 'en' || lang === 'de') updateSettings({ lang });
  paintBackdrop();
  baseline();
  initUI(root);
  initAudio();
  wireIntents();
  startTickers();
  buildPanel();
  const route = (): void => go(window.location.hash.slice(1) || 'menu');
  window.addEventListener('hashchange', route);
  route();
  window.__uidemo = {
    go,
    fire,
    fireAll: () => { for (const [, action] of EVENTS) action(); },
    error: (error, fatal) => bus.emit('net:error', { error, fatal }),
    audio: audioDebug,
    renderAudio,
    routes: Object.keys(ROUTES),
    errors: CONN_ERRORS,
  };
}

boot();
