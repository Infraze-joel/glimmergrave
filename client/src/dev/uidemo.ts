/**
 * UI + audio dev harness: http://localhost:5175/?uidemo
 *
 * Plays the role of the integrator with fake data: writes GameState, emits the bus events and reacts to
 * `ui:*` intents (which are logged to the console). No network, no Three.js.
 *
 *   Hash routes   #loading #loading-error #menu #menu-new #connecting #howto #settings #lobby #lobby-guest
 *                 #game #elite #boss #downed #solo #doors #draft #draft-cursed #draft-wait #tab #pause
 *                 #summary-win #summary-loss #error #reconnecting #toasts
 *   Update 2      #training-<step> #training-summary #armory-poor #armory-rich #armory-max #armory-lobby
 *                 #wardrobe #wardrobe-lobby #codex-<tab> #pause-codex #strip-0..3 #combo #tip-<id>
 *                 #draft-reroll #draft-tags #act-1..3 #boss-<kind> #herald-<kind>
 *   Query params  lang=en|de   bg=noisy (busy backdrop for contrast checks)   panel=0 (hide the dev panel)
 *                 freeze (stop the fake tickers)   tips=1 (leave all tips unseen)
 *   window.__uidemo  { go, fire, error, audio, nextStep, intents }  for scripted checks
 *
 * The 3D hero preview is replaced by a flat placeholder painted on the canvas wherever 'ui:showcase' asks.
 */
import { RUN } from '@shared/constants.ts';
import { BOON_TUNING } from '@shared/data/boons.ts';
import { CLASSES } from '@shared/data/classes.ts';
import { DEFAULT_LOOK, LOOK, META_UPGRADES, REWARDS, defaultLooks } from '@shared/data/meta.ts';
import { TUTORIAL_STEPS } from '@shared/data/tutorial.ts';
import { ERROR_CODES } from '@shared/protocol.ts';
import {
  BIOME_IDS, BOSS_KINDS, PF,
  type BiomeId, type BoonOffer, type BoonStack, type ClassId, type GameEvent, type Hazard, type Look, type PlayerSnap,
  type RoomLayout, type RosterEntry, type RunState,
} from '@shared/types.ts';
import { bus, type ConnError, type EventMap } from '../core/EventBus.ts';
import { resetSession, state, type Screen } from '../core/GameState.ts';
import { updateSettings } from '../core/Settings.ts';
import { initUI } from '../ui/index.ts';
import { markTipSeen, resetTips } from '../ui/prefs.ts';
import { ui, type CodexTab } from '../ui/store.ts';
import { TIP_IDS, type TipId } from '../ui/tips.ts';

const HUD_TICK_MS = 66;
const RUN_TICK_MS = 250;
const CONNECT_MS = 700;
const OWN_SLOT = 0;
const GUEST_SLOT = 1;
const CONN_ERRORS: ConnError[] = [...ERROR_CODES, 'unreachable', 'connection_lost'];

const params = new URLSearchParams(window.location.search);

// ------------------------------------------------------------------ fake data

const look = (color: number, style = 0, head = true, cape = true): Look => ({ color, style, head, cape });

function roster(): RosterEntry[] {
  return [
    {
      slot: 0, name: 'Aldric', cls: 'knight', look: look(2, 1), ready: true, connected: true, host: true,
      boons: [
        { id: 'infuse_ember_primary', level: 1 }, { id: 'keen_edge', level: 2 }, { id: 'barrier', level: 1 },
        { id: 'amplifier', level: 1 }, { id: 'spare_step', level: 1 }, { id: 'kindred_flame', level: 1 },
      ],
    },
    {
      slot: 1, name: 'Brunhild', cls: 'barbarian', look: look(0), ready: true, connected: true, host: false,
      boons: [{ id: 'infuse_storm_secondary', level: 1 }, { id: 'heavy_hand', level: 3 }, { id: 'iron_heart', level: 2 }],
    },
    {
      slot: 2, name: 'Mirelle', cls: 'mage', look: look(5, 2, true, false), ready: false, connected: true, host: false,
      boons: [
        { id: 'infuse_rime_primary', level: 2 }, { id: 'deep_frost', level: 1 }, { id: 'echo', level: 1 },
        { id: 'quick_wits', level: 2 },
      ],
    },
    {
      slot: 3, name: 'Schattenklinge99', cls: 'rogue', look: look(4, 1, false), ready: true, connected: false, host: false,
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

const HAZARDS: Record<BiomeId, Hazard[]> = {
  crypt: [{ x: -4, z: 2, r: 1.6, kind: 'spikes', period: 5, phase: 0 }, { x: 5, z: -3, r: 1.6, kind: 'spikes', period: 5, phase: 0.5 }],
  flooded: [{ x: 0, z: 0, r: 2.4, kind: 'frost', period: 7, phase: 0.2 }],
  forge: [{ x: 3, z: 3, r: 2, kind: 'vent', period: 6, phase: 0.1 }],
};

function room(biome: BiomeId, hazards = true): RoomLayout {
  return { seed: 7, biome, w: 40, d: 30, obstacles: [], hazards: hazards ? HAZARDS[biome] : [], spawns: [{ x: 0, z: 10 }] };
}

function run(patch: Partial<RunState> = {}): RunState {
  return {
    phase: 'combat', oath: 2, chamber: 4, chamberKind: 'combat', entered: 'cursed', wave: 2, waveCount: 3, room: room('flooded', false),
    bossKind: null, finalBoss: 'matron', rewards: [], tutorial: null,
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

const REROLLED: BoonOffer[][] = [
  [{ id: 'amplifier', level: 2 }, { id: 'infuse_storm_dash', level: 1 }, { id: 'barrier', level: 2 }],
  [{ id: 'deadeye', level: 1 }, { id: 'infuse_rime_dash', level: 1 }, { id: 'shared_vigor', level: 1 }],
];
const intentLog: string[] = [];
type AudioDebug = typeof import('../audio/index.ts').audioDebug;
let audioDebug: AudioDebug = () => null;

/**
 * Audio is owned by another module and may be mid-change while the UI is being worked on: load it lazily so
 * a broken audio build can never take the UI demo down with it. Only `initAudio` / `audioDebug` are used.
 */
function startAudio(): void {
  import('../audio/index.ts')
    .then((audio) => { audio.initAudio(); audioDebug = audio.audioDebug; })
    .catch((err: unknown) => console.warn('[uidemo] audio module unavailable', err));
}

let showcase: { cls: ClassId; screenX: number } | null = null;
let paint: (() => void) | null = null;

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
  // Leaving the game screen makes the HUD drop its transient state (combo, feed, banners, tips).
  if (state.screen === 'game') setScreen('menu');
  resetSession();
  ui.modal = null;
  ui.pause = false;
  ui.pauseConfirm = false;
  ui.tab = false;
  ui.fatal = null;
  ui.assetError = null;
  ui.picked = -1;
  ui.page = null;
  ui.codexTab = 'elements';
  ui.wardrobeCls = null;
  ui.biomes.clear();
  Object.assign(state.profile, {
    runs: 23, wins: 6, bestChamber: 8, oathUnlocked: 2, glimmer: 240, glimmerEarned: 1460, tutorialDone: true,
    meta: { vitality: 2, might: 1, insight: 0, swiftness: 3 },
    looks: { ...defaultLooks(), knight: look(2, 1), mage: look(5, 2, true, false) },
  });
  state.draftRerolls = 0;
  // Tips only appear on their own routes (or with ?tips=1), so other screenshots stay clean.
  resetTips();
  if (params.get('tips') !== '1') for (const id of TIP_IDS) markTipSeen(id);
}

/** Solo hero with the given boons (training, element strip and tag states). */
function solo(boons: BoonStack[], patch: Partial<RunState> = {}): void {
  inGame({ secondWinds: 1, oath: 0, entered: 'boon', chamber: 1, ...patch });
  state.roster = roster().slice(0, 1).map((p) => ({ ...p, boons }));
  state.players = players().slice(0, 1);
  state.players[0].hp = 104;
  state.enemiesAlive = 6;
  emitAll();
}

const TRAINING_BOONS: BoonStack[] = [
  { id: 'infuse_ember_primary', level: 1 }, { id: 'infuse_rime_secondary', level: 1 }, { id: 'infuse_storm_dash', level: 1 },
];
/** Infusions the training has handed out by the time a step starts. */
const TRAINING_INFUSIONS: Record<string, number> = { burn: 1, resonance: 2, storm: 3, hazard: 3, draft: 3, door: 3 };

function training(step: string, progress = 0): void {
  const index = Math.max(0, (TUTORIAL_STEPS as readonly string[]).indexOf(step));
  const marker = step === 'move' ? { x: 0, z: -4, r: 1.5 } : null;
  solo(TRAINING_BOONS.slice(0, TRAINING_INFUSIONS[step] ?? 0), {
    chamber: 0, wave: 1, waveCount: 1, elapsed: 30 + index * 18, secondWinds: 0,
    phase: step === 'draft' ? 'draft' : step === 'door' ? 'doors' : 'combat',
    draftPending: step === 'draft' ? [0] : [], draftTime: 40,
    doors: step === 'door' ? [{ x: 0, z: -12, type: 'boon' }] : [], doorProgress: step === 'door' ? [0.35] : [],
    room: room('crypt', step === 'hazard'),
    tutorial: { step, index, total: TUTORIAL_STEPS.length, progress, marker },
  });
  state.enemiesAlive = step === 'draft' || step === 'door' || step === 'move' ? 0 : 3;
  state.draft = step === 'draft' ? [{ id: 'infuse_ember_secondary', level: 1 }, { id: 'keen_edge', level: 1 }, { id: 'amplifier', level: 1 }] : [];
  emitAll();
}

function nextStep(): void {
  const tut = state.run?.tutorial;
  if (!tut) return;
  const next = TUTORIAL_STEPS[tut.index + 1];
  if (!next) {
    state.run = run({ phase: 'victory', chamber: 0, elapsed: 196, tutorial: { ...tut, progress: 1 }, rewards: [{ slot: OWN_SLOT, glimmer: REWARDS.TUTORIAL }] });
    Object.assign(state.profile, { glimmer: state.profile.glimmer + REWARDS.TUTORIAL, tutorialDone: true });
    setScreen('summary');
    emitAll();
    bus.emit('state:profile');
    return;
  }
  fire({ e: 'tutorialStep', step: next });
  window.setTimeout(() => training(next), 120);
}

function bossFight(kind: (typeof BOSS_KINDS)[number], herald: boolean): void {
  inGame({
    chamber: herald ? 6 : 7, chamberKind: herald ? 'elite' : 'boss', entered: herald ? 'boon' : 'boss', wave: 1, waveCount: 1,
    // The herald is always one of the bosses that is NOT waiting at the end of the run.
    bossKind: kind, finalBoss: herald ? BOSS_KINDS[(BOSS_KINDS.indexOf(kind) + 1) % BOSS_KINDS.length] : kind, bossId: 1,
    room: room('forge', false),
  });
  state.bossHp = herald ? 0.74 : 0.47;
  state.enemiesAlive = herald ? 3 : 5;
  emitAll();
}

function act(n: number): void {
  const biome = BIOME_IDS[n - 1] ?? 'crypt';
  if (n <= 1) { inGame({ chamber: 0, entered: 'boon', wave: 1, elapsed: 2, room: room(biome) }); return; }
  // Acts begin with the elite chambers (3 and 6); the chamber before is still in the previous biome.
  const before = BIOME_IDS[n - 2] ?? 'crypt';
  const chamber = n === 2 ? 2 : 5;
  inGame({ chamber, chamberKind: 'combat', entered: 'boon', room: room(before, false), phase: 'doors' });
  window.setTimeout(() => {
    setRun(run({
      chamber: chamber + 1, chamberKind: 'elite', entered: 'boon', wave: 1, waveCount: 1, room: room(biome),
      bossKind: n === 2 ? 'champion' : 'regent', bossId: 1,
    }));
    state.bossHp = 1;
    bus.emit('state:hud');
    fire({ e: 'wave', wave: 1, waveCount: 1 });
  }, 60);
}

function tip(id: TipId): void {
  resetTips();
  for (const other of TIP_IDS) if (other !== id) markTipSeen(other);
  const at2 = { x: 2, z: -1 };
  switch (id) {
    case 'status.ember':
    case 'status.rime':
    case 'status.storm': {
      const el = id.slice('status.'.length) as 'ember' | 'rime' | 'storm';
      solo([{ id: `infuse_${el}_primary`, level: 1 }]);
      fire({ e: 'hit', target: { t: 'e', id: 7 }, ...at2, dmg: 22, crit: false, el, by: 0 });
      break;
    }
    case 'resonance':
      inGame();
      fire({ e: 'resonance', ...at2, r: 3, a: 'ember', b: 'rime', by: 0 });
      break;
    case 'ally':
      inGame();
      fire({ e: 'hit', target: { t: 'e', id: 7 }, ...at2, dmg: 22, crit: false, el: 'rime', by: 2 });
      break;
    case 'hazard': inGame({ room: room('forge'), entered: 'boon' }); break;
    case 'cursed': ROUTES.doors(); break;
    case 'downed':
      ROUTES.solo();
      Object.assign(state.players[0], { hp: 0, state: 'downed' });
      fire({ e: 'down', slot: 0 });
      break;
    case 'elite': ROUTES.elite(); break;
    case 'boss': bossFight('stalker', false); break;
  }
  emitAll();
}

function profileState(patch: { glimmer: number; meta: Record<string, number> }): void {
  Object.assign(state.profile, patch);
}

const ROUTES: Record<string, () => void> = {
  loading: () => { setScreen('loading'); bus.emit('assets:progress', { loaded: 23, total: 37 }); },
  'loading-error': () => {
    setScreen('loading');
    bus.emit('assets:error', { message: 'GET /assets/models/knight.glb 404 (Not Found)' });
  },
  menu: () => { setScreen('menu'); emitAll(); },
  'menu-new': () => {
    Object.assign(state.profile, { runs: 0, wins: 0, bestChamber: 0, oathUnlocked: 0, glimmer: 0, glimmerEarned: 0, tutorialDone: false, meta: {} });
    setScreen('menu');
    emitAll();
  },
  connecting: () => { state.conn.status = 'connecting'; setScreen('menu'); emitAll(); },
  howto: () => { setScreen('menu'); ui.modal = 'howto'; emitAll(); },
  settings: () => { setScreen('menu'); ui.modal = 'settings'; emitAll(); },
  lobby: () => { session(); state.oath = 1; state.run = run({ phase: 'lobby' }); setScreen('lobby'); emitAll(); },
  'lobby-guest': () => { session(GUEST_SLOT); state.run = run({ phase: 'lobby' }); setScreen('lobby'); emitAll(); },
  game: () => inGame(),
  elite: () => {
    inGame({ chamber: 3, chamberKind: 'elite', entered: 'boon', wave: 1, waveCount: 1, bossKind: 'champion', bossId: 1, room: room('crypt', false) });
    state.bossHp = 0.58;
    state.enemiesAlive = 4;
    emitAll();
  },
  boss: () => bossFight('regent', false),
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
    state.profile.glimmer = 240 + 261;
    state.run = run({
      phase: 'victory', chamber: 7, chamberKind: 'boss', elapsed: 754, bossKind: 'matron',
      rewards: [{ slot: 0, glimmer: 261 }, { slot: 1, glimmer: 237 }, { slot: 2, glimmer: 237 }, { slot: 3, glimmer: 237 }],
    });
    setScreen('summary');
    emitAll();
  },
  'summary-loss': () => {
    session(GUEST_SLOT);
    state.profile.glimmer = 240 + 78;
    state.run = run({ phase: 'defeat', chamber: 5, elapsed: 512, rewards: [{ slot: 0, glimmer: 86 }, { slot: 1, glimmer: 78 }] });
    setScreen('summary');
    emitAll();
  },
  'summary-pending': () => {
    session();
    state.run = run({ phase: 'defeat', chamber: 2, elapsed: 201, rewards: [] });
    setScreen('summary');
    emitAll();
  },

  // ---- update 2
  ...Object.fromEntries(TUTORIAL_STEPS.map((step): [string, () => void] => [`training-${step}`, () => training(step, step === 'attack' ? 2 / 3 : 0)])),
  'training-summary': () => {
    session();
    state.roster = roster().slice(0, 1);
    state.profile.glimmer = REWARDS.TUTORIAL;
    state.run = run({
      phase: 'victory', chamber: 0, elapsed: 196, oath: 0, rewards: [{ slot: 0, glimmer: REWARDS.TUTORIAL }],
      tutorial: { step: 'door', index: TUTORIAL_STEPS.length - 1, total: TUTORIAL_STEPS.length, progress: 1, marker: null },
    });
    setScreen('summary');
    emitAll();
  },
  'armory-poor': () => { profileState({ glimmer: 35, meta: {} }); setScreen('menu'); ui.page = 'armory'; emitAll(); },
  'armory-rich': () => {
    profileState({ glimmer: 2400, meta: { vitality: 3, might: 2, swiftness: 1, insight: 1, fortune: 2 } });
    setScreen('menu');
    ui.page = 'armory';
    emitAll();
  },
  'armory-max': () => {
    profileState({ glimmer: 90, meta: Object.fromEntries(META_UPGRADES.map((def, i) => [def.id, i % 3 === 2 ? def.costs.length - 1 : def.costs.length])) });
    setScreen('menu');
    ui.page = 'armory';
    emitAll();
  },
  'armory-lobby': () => { ROUTES.lobby(); ui.page = 'armory'; emitAll(); },
  wardrobe: () => { setScreen('menu'); ui.wardrobeCls = state.profile.cls; ui.page = 'wardrobe'; emitAll(); },
  'wardrobe-mage': () => { setScreen('menu'); ui.wardrobeCls = 'mage'; ui.page = 'wardrobe'; emitAll(); },
  'wardrobe-lobby': () => { ROUTES.lobby(); ui.page = 'wardrobe'; emitAll(); },
  ...Object.fromEntries((['elements', 'combat', 'hazards', 'enemies', 'doors', 'boons'] as CodexTab[]).map((tab): [string, () => void] =>
    [`codex-${tab}`, () => { setScreen('menu'); ui.codexTab = tab; ui.page = 'codex'; emitAll(); }])),
  'pause-codex': () => { inGame(); ui.pause = true; ui.page = 'codex'; emitAll(); },
  'strip-0': () => solo([{ id: 'keen_edge', level: 1 }]),
  'strip-1': () => solo(TRAINING_BOONS.slice(0, 1)),
  'strip-2': () => solo(TRAINING_BOONS.slice(0, 2)),
  'strip-3': () => solo(TRAINING_BOONS),
  combo: () => {
    solo(TRAINING_BOONS.slice(0, 2));
    for (let i = 0; i < 3; i++) window.setTimeout(() => fire({ e: 'resonance', x: 2, z: -1, r: 3, a: 'ember', b: 'rime', by: 0 }), i * 120);
  },
  'combo-ally': () => { inGame(); fire({ e: 'resonance', x: 2, z: -1, r: 3, a: 'rime', b: 'storm', by: 2 }); },
  ...Object.fromEntries(TIP_IDS.map((id): [string, () => void] => [`tip-${id}`, () => tip(id)])),
  'draft-reroll': () => {
    state.profile.meta = { ...state.profile.meta, insight: 2 };
    inGame({ phase: 'draft', draftPending: [0, 1, 2], draftTime: 32, entered: 'boon' });
    state.enemiesAlive = 0;
    state.draft = [{ id: 'infuse_rime_secondary', level: 1 }, { id: 'infuse_storm_primary', level: 1 }, { id: 'wildfire', level: 1 }];
    state.draftRerolls = 2;
    emitAll();
  },
  'draft-tags': () => {
    solo([{ id: 'keen_edge', level: 1 }], { phase: 'draft', draftPending: [0], draftTime: 28 });
    state.enemiesAlive = 0;
    state.draft = [{ id: 'infuse_storm_dash', level: 1 }, { id: 'deep_frost', level: 1 }, { id: 'echo', level: 1 }];
    emitAll();
  },
  'act-1': () => act(1),
  'act-2': () => act(2),
  'act-3': () => act(3),
  ...Object.fromEntries(BOSS_KINDS.flatMap((kind): [string, () => void][] => [
    [`boss-${kind}`, () => bossFight(kind, false)],
    [`herald-${kind}`, () => bossFight(kind, true)],
  ])),
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
  ['res combo x4', () => { for (let i = 0; i < 4; i++) window.setTimeout(() => fire({ e: 'resonance', ...at, r: 3, a: 'ember', b: 'storm', by: 0 }), i * 350); }],
  ['tutorial next', () => nextStep()],
  ['hazard hit own', () => fire({ e: 'hazardHit', target: { t: 'p', id: 0 }, kind: 'vent' })],
  ['hazard hit foe', () => fire({ e: 'hazardHit', target: { t: 'e', id: 7 }, kind: 'spikes' })],
  ['matron beam', () => fire({ e: 'cast', who: { t: 'e', id: 1 }, ability: 'matron_beam', ...at, rot: 0 })],
  ['stalker leap', () => fire({ e: 'cast', who: { t: 'e', id: 1 }, ability: 'stalker_leap', ...at, rot: 0 })],
  ['boss windup', () => fire({ e: 'telegraph', shape: 'circle', ...at, rot: 0, r: 3, w: 0, dur: 2.5, src: state.run?.bossId ?? 1 })],
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
    'ui:create', 'ui:join', 'ui:lobby', 'ui:start', 'ui:pick', 'ui:reroll', 'ui:loadout', 'ui:showcase', 'ui:toLobby', 'ui:leave',
    'ui:overlay', 'ui:gesture',
  ];
  for (const name of intents) {
    bus.on(name, (payload: unknown) => {
      const line = `${name} ${payload === undefined ? '' : JSON.stringify(payload)}`.trim();
      intentLog.push(line);
      console.info(`[uidemo] ${line}`);
    });
  }

  const connect = (tutorial: boolean): void => {
    state.conn.status = 'connecting';
    bus.emit('net:status');
    window.setTimeout(() => {
      if (state.conn.status !== 'connecting') return;
      if (tutorial) { training(TUTORIAL_STEPS[0]); return; }
      session();
      state.roster = roster().slice(0, 1).map((p) => ({
        ...p, name: state.profile.name || 'Warden', cls: state.profile.cls, look: state.profile.looks[state.profile.cls], ready: false, boons: [],
      }));
      state.oath = 0;
      state.run = run({ phase: 'lobby' });
      setScreen('lobby');
      emitAll();
    }, CONNECT_MS);
  };
  bus.on('ui:create', (p) => connect(p.tutorial === true));
  bus.on('ui:join', () => connect(false));
  // Stand-in for net/: a look change in the lobby comes back through the roster.
  bus.on('ui:loadout', () => {
    const me = state.roster.find((p) => p.slot === state.conn.slot);
    if (!me || state.screen !== 'lobby') return;
    me.look = { ...(state.profile.looks[me.cls] ?? DEFAULT_LOOK) };
    bus.emit('state:roster');
  });
  bus.on('ui:reroll', () => {
    if (state.draftRerolls <= 0) return;
    window.setTimeout(() => {
      state.draftRerolls -= 1;
      state.draft = REROLLED[state.draftRerolls % REROLLED.length];
      bus.emit('state:draft');
    }, 180);
  });
  bus.on('ui:showcase', (request) => { showcase = request; paint?.(); });
  bus.on('state:profile', () => paint?.());
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
    drawShowcase(g, w, hgt);
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
  paint = draw;
  window.addEventListener('resize', draw);
}

const CLASS_TINT: Record<ClassId, string> = { knight: '#7fa9e6', barbarian: '#e2584b', mage: '#e391d8', rogue: '#86d06c' };

/** Flat stand-in for the 3D hero preview: a paper-doll at the requested screen position, tinted by the look. */
function drawShowcase(g: CanvasRenderingContext2D, w: number, hgt: number): void {
  if (!showcase || (state.screen !== 'menu' && state.screen !== 'lobby')) return;
  const cls = showcase.cls;
  const heroLook = state.profile.looks[cls] ?? DEFAULT_LOOK;
  const cloth = heroLook.color > 0 ? `#${(LOOK.COLORS[heroLook.color] ?? 0).toString(16).padStart(6, '0')}` : CLASS_TINT[cls];
  const cx = showcase.screenX * w;
  const s = hgt / 720;
  const foot = hgt * 0.72;
  g.save();
  g.translate(cx, foot);
  g.scale(s, s);
  const glow = g.createRadialGradient(0, -120, 20, 0, -120, 260);
  glow.addColorStop(0, 'rgba(255,190,120,.22)');
  glow.addColorStop(1, 'rgba(255,190,120,0)');
  g.fillStyle = glow;
  g.fillRect(-280, -400, 560, 460);
  g.fillStyle = 'rgba(0,0,0,.45)';
  g.beginPath(); g.ellipse(0, 6, 92, 20, 0, 0, Math.PI * 2); g.fill();
  if (heroLook.cape) { g.fillStyle = cloth; g.globalAlpha = 0.75; g.beginPath(); g.moveTo(-52, -196); g.lineTo(52, -196); g.lineTo(74, -20); g.lineTo(-74, -20); g.closePath(); g.fill(); g.globalAlpha = 1; }
  g.fillStyle = '#3a4258';
  g.fillRect(-34, -80, 28, 80); g.fillRect(6, -80, 28, 80);
  g.fillStyle = cloth;
  g.fillRect(-46, -200, 92, 124);
  g.fillStyle = '#d9b99a';
  g.beginPath(); g.arc(0, -238, 36, 0, Math.PI * 2); g.fill();
  if (heroLook.head) { g.fillStyle = '#8f98ad'; g.beginPath(); g.arc(0, -246, 40, Math.PI, 0); g.fill(); g.fillRect(-40, -248, 80, 10); }
  g.fillStyle = '#c9ced9';
  // gear style: 0 one long item, 1 item + offhand, 2 two items
  g.fillRect(58, -250 + heroLook.style * 30, 10, 190 - heroLook.style * 40);
  if (heroLook.style >= 1) { g.beginPath(); g.arc(-70, -140, heroLook.style === 1 ? 34 : 22, 0, Math.PI * 2); g.fill(); }
  g.restore();
  g.fillStyle = 'rgba(239,232,216,.55)';
  g.font = `${Math.round(11 * s)}px system-ui, sans-serif`;
  g.textAlign = 'center';
  g.fillText('3D preview placeholder (ui:showcase)', cx, foot + 44 * s);
  g.textAlign = 'start';
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

declare global {
  interface Window {
    __uidemo?: {
      go(route: string): void;
      fire(ev: GameEvent): void;
      fireAll(): void;
      error(error: ConnError, fatal: boolean): void;
      audio: AudioDebug;
      nextStep(): void;
      /** Forgets which tips were shown (all tips can appear again). */
      resetTips(): void;
      /** Every `ui:*` intent emitted so far, as "name payload". */
      intents: string[];
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
  startAudio();
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
    audio: () => audioDebug(),
    nextStep,
    resetTips,
    intents: intentLog,
    routes: Object.keys(ROUTES),
    errors: CONN_ERRORS,
  };
}

boot();
