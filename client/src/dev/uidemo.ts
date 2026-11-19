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
 *   Update 3      #menu-<class> #menu-badge #lobby-oath #hud-<class> #hud-<class>-art #ult-0 #ult-half #ult-ready
 *                 #ult-infused #buffs #sets #set-toast #strip-4 #reaction-<id> #depth-2 #doors-deep #affix #party-ult
 *                 #draft-legendary #draft-class #draft-5 #draft-sets #summary-win #summary-levelup #summary-fell
 *                 #summary-ascended #summary-loss #hub-<tab>-<new|mid|end> #hub-mastery-<class> #codex-classes
 *                 #codex-progress #wardrobe-<class>
 *   Update 4      #obj-<kind>-<start|mid|lost|done|won> (kind: slay survive defend hunt ritual vault; also #obj-hunt-escort,
 *                 #obj-defend-low, #obj-ritual-late, #obj-vault-open, #obj-<kind>-solo) #obj-act (act banner, then objective)
 *                 #doors-obj #doors-obj-2 #doors-obj-vault #doors-obj-same #doors-obj-deep #draft-bonus #draft-bonus-event #draft-nobonus #draft-vault
 *                 #ward #ward-own #foes #summary-objectives #codex-bestiary #codex-objectives #tip-enemy.<kind> #tip-ward
 *                 #tip-objective #boss-doors (dead boss, descend / ascend doors: no boss bar)
 *   Polish 1      #busy #busy-down (burst of a four-hero fight: feed, callouts, tips) #obj-hunt-reload #obj-hunt-escort-reload
 *                 #codex-tips
 *   Update 5      #ks-draft (free slots, class keystone) #ks-draft-one #ks-draft-full #ks-draft-replace #ks-draft-tip #ks-draft-reroll
 *                 #ks-draft-wait #draft-fits #draft-fits-2 #draft-fits-tip #draft-tags (tags before any keystone) #hud-ks-0 #hud-ks-1 #hud-ks-2
 *                 #hud-ks-ind (Bloodrush stacks, Blood Price, Phase Walker window, Resonance Engine) #ks-banner #ks-banner-2
 *                 #ks-banner-replace #ks-ally #tab-build #tab-build-one #tab-build-none #summary-growth #summary-growth-short
 *                 #summary-growth-join #summary-growth-deep #summary-growth-none #summary-growth-live (tracked from events)
 *                 #lobby-after #codex-keystones #party-builds
 *   Query params  profile=new|mid|end (progression stage for every route; default mid)   lang=en|de   bg=noisy (busy backdrop for contrast checks)   panel=0 (hide the dev panel)
 *                 freeze (stop the fake tickers)   tips=1 (leave all tips unseen)
 *   window.__uidemo  { go, fire, patchRun, screen, error, audio, nextStep, intents, missing }  for scripted checks
 *                    missing() lists every data id without an English or German text (must be empty)
 *
 * The 3D hero preview is replaced by a flat placeholder painted on the canvas wherever 'ui:showcase' asks.
 */
import { RUN } from '@shared/constants.ts';
import { BOON_TUNING, SETS } from '@shared/data/boons.ts';
import { CLASSES } from '@shared/data/classes.ts';
import { FEATS, LIFETIME_STATS, featTier, type LifetimeStat } from '@shared/data/feats.ts';
import { TALENT_TIERS, levelFromXp, xpForLevel } from '@shared/data/mastery.ts';
import { DEFAULT_LOOK, LOOK, META_UPGRADES, PARAGON, REWARDS, defaultLooks } from '@shared/data/meta.ts';
import { REACTIONS } from '@shared/data/reactions.ts';
import { RELICS, rankFromShards, shardsForRank } from '@shared/data/relics.ts';
import { OBJECTIVE_TUNING } from '@shared/data/objectives.ts';
import { TUTORIAL_STEPS } from '@shared/data/tutorial.ts';
import { ERROR_CODES } from '@shared/protocol.ts';
import {
  AFFIX_IDS, BIOME_IDS, BOSS_KINDS, CLASS_IDS, ELEMENT_IDS, OBJECTIVE_KINDS, PF,
  type BiomeId, type BoonOffer, type BoonStack, type ClassId, type Door, type DoorType, type GameEvent, type Hazard, type Look,
  type ObjectiveKind, type ObjectiveState, type PlayerSnap, type RoomLayout, type RosterEntry, type RunReward, type RunState,
} from '@shared/types.ts';
import { bus, type ConnError, type EventMap } from '../core/EventBus.ts';
import { resetSession, state, type Screen } from '../core/GameState.ts';
import { updateSettings } from '../core/Settings.ts';
import { initUI } from '../ui/index.ts';
import { markTipSeen, resetMarks, resetTips, setMark } from '../ui/prefs.ts';
import { artMark } from '../ui/progress.ts';
import { resetGrowth, setGrowthForDemo, type ChamberSample, type KeystoneTaken } from '../ui/growth.ts';
import { HUB_TABS, ui, type CodexTab, type HubTab } from '../ui/store.ts';
import { missingTexts } from '../ui/text.ts';
import { NEW_FOES, TIP_IDS, type TipId } from '../ui/tips.ts';

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
      slot: 0, name: 'Aldric', cls: 'knight', look: look(2, 1), mastery: 7, art: 1, relics: 1, talents: 1, ready: true, connected: true, host: true, keystones: [],
      boons: [
        { id: 'infuse_ember_primary', level: 1 }, { id: 'keen_edge', level: 2 }, { id: 'barrier', level: 1 },
        { id: 'amplifier', level: 1 }, { id: 'spare_step', level: 1 }, { id: 'kindred_flame', level: 1 },
      ],
    },
    {
      slot: 1, name: 'Brunhild', cls: 'templar', look: look(0), mastery: 23, art: 0, relics: 2, talents: 3, ready: true, connected: true, host: false, keystones: [],
      boons: [{ id: 'infuse_storm_secondary', level: 1 }, { id: 'heavy_hand', level: 3 }, { id: 'iron_heart', level: 2 }],
    },
    {
      slot: 2, name: 'Mirelle', cls: 'spellblade', look: look(5, 2, true, false), mastery: 3, art: 0, relics: 0, talents: 0, ready: false, connected: true, host: false, keystones: [],
      boons: [
        { id: 'infuse_rime_primary', level: 2 }, { id: 'deep_frost', level: 1 }, { id: 'echo', level: 1 },
        { id: 'quick_wits', level: 2 },
      ],
    },
    {
      slot: 3, name: 'Schattenklinge99', cls: 'shade', look: look(4, 1, false), mastery: 112, art: 1, relics: 3, talents: 1, ready: true, connected: false, host: false, keystones: [],
      boons: [{ id: 'deadeye', level: 1 }, { id: 'fleet_foot', level: 2 }],
    },
  ];
}

function players(): PlayerSnap[] {
  const base = { rot: 0, anim: 'idle' as const, animSeq: 0, revive: 0, ult: 0 };
  return [
    { ...base, slot: 0, x: 0, z: 0, hp: 87, maxHp: 130, shield: 22, state: 'alive', cdSecondary: 0.45, cdDash: 0.6, dashCharges: 1, ult: 0.62, flags: PF.CONNECTED },
    { ...base, slot: 1, x: 5, z: -3, hp: 96, maxHp: 160, shield: 0, state: 'alive', cdSecondary: 0, cdDash: 0, dashCharges: 1, ult: 1, flags: PF.CONNECTED },
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
    bossKind: null, finalBoss: 'matron', rewards: [], tutorial: null, depth: 0, cleared: 0, chambersCleared: 4, objective: null, objectivesDone: 0, objectiveBonuses: 0,
    doors: [], doorProgress: [], bossId: -1, draftPending: [], draftTime: RUN.DRAFT_TIMEOUT_SECONDS, elapsed: 437,
    stats: [
      { slot: 0, damage: 12480, kills: 61, resonances: 14, revives: 2, downs: 1, elites: 3, bosses: 1, ultimates: 4 },
      { slot: 1, damage: 15230, kills: 74, resonances: 9, revives: 1, downs: 0, elites: 5, bosses: 0, ultimates: 6 },
      { slot: 2, damage: 9870, kills: 38, resonances: 21, revives: 0, downs: 3, elites: 1, bosses: 0, ultimates: 2 },
      { slot: 3, damage: 4410, kills: 19, resonances: 2, revives: 0, downs: 2, elites: 0, bosses: 0, ultimates: 1 },
    ],
    secondWinds: 0,
    ...patch,
    traits: patch.traits ?? [],
  };
}

const reward = (slot: number, glimmer: number, xp = 0, relics: string[] = []): RunReward => ({ slot, glimmer, xp, relics });

// ------------------------------------------------------------------ profiles at different stages of progression

type Stage = 'new' | 'mid' | 'end';
const stageParam = params.get('profile');
const DEFAULT_STAGE: Stage = stageParam === 'new' || stageParam === 'end' ? stageParam : 'mid';

/** Total experience that puts a class at `level` with `into` experience inside it. */
function xpAt(level: number, into = 0): number {
  let total = into;
  for (let l = 1; l < level; l++) total += xpForLevel(l);
  return total;
}

const perClass = <T>(make: (cls: ClassId) => T): Record<ClassId, T> =>
  Object.fromEntries(CLASS_IDS.map((cls) => [cls, make(cls)])) as Record<ClassId, T>;
const lifetimeOf = (values: Partial<Record<LifetimeStat, number>>): Record<LifetimeStat, number> =>
  Object.fromEntries(LIFETIME_STATS.map((key) => [key, values[key] ?? 0])) as Record<LifetimeStat, number>;

/** Feats claimed up to `behind` tiers short of what the counters have reached (so some are waiting). */
function featsClaimed(lifetime: Record<LifetimeStat, number>, behind: (id: string) => number): Record<string, number> {
  return Object.fromEntries(FEATS.map((feat) => [feat.id, Math.max(0, featTier(feat, lifetime[feat.stat]) - behind(feat.id))]));
}

function stageProfile(stage: Stage): void {
  const p = state.profile;
  if (stage === 'new') {
    Object.assign(p, {
      runs: 0, wins: 0, bestChamber: 0, oathUnlocked: 0, glimmer: 40, glimmerEarned: 40, tutorialDone: true, meta: {},
      xp: perClass(() => 0), arts: perClass(() => 0), talents: perClass(() => Array.from({ length: TALENT_TIERS }, () => 0)),
      paragon: {}, shards: {}, relics: [], lifetime: lifetimeOf({ glimmerEarned: 40 }), feats: {}, classWins: perClass(() => 0),
    });
    return;
  }
  if (stage === 'mid') {
    const xp = { ...perClass(() => 0), knight: xpAt(7, 310), mage: xpAt(4, 60), rogue: xpAt(3, 20), templar: xpAt(2, 140), shade: xpAt(1, 70) };
    const shards = { whetstone: shardsForRank(2) + 1, iron_reliquary: 1, storm_coil: shardsForRank(2), phoenix: 1, tome: shardsForRank(3) };
    const lifetime = lifetimeOf({
      runs: 23, wins: 6, kills: 1840, elites: 31, bosses: 7, resonances: 412, revives: 9, ultimates: 64, chambers: 131, damage: 412000,
      bestDepth: 2, bestOath: 3, glimmerEarned: 4460,
      masteryLevels: CLASS_IDS.reduce((sum, cls) => sum + levelFromXp(xp[cls]).level - 1, 0),
      relicRanks: Object.values(shards).reduce((sum, n) => sum + rankFromShards(n), 0), classesWon: 2,
    });
    Object.assign(p, {
      runs: 23, wins: 6, bestChamber: 8, oathUnlocked: 3, glimmer: 640, glimmerEarned: 4460, tutorialDone: true,
      meta: { vitality: 3, might: 2, swiftness: 3, insight: 1, fortune: 2, ferocity: 1, zeal: 1 },
      xp, arts: { ...perClass(() => 0), knight: 1 }, talents: { ...perClass(() => [0, 0, 0]), knight: [1, 0, 0], mage: [2, 0, 0] },
      paragon: { asc_might: 4, asc_vitality: 2, asc_fortune: 1 }, shards, relics: ['whetstone'],
      lifetime, feats: featsClaimed(lifetime, (id) => (id === 'gravedigger' || id === 'harmonist' || id === 'adept' ? 1 : 0)),
      classWins: { ...perClass(() => 0), knight: 4, mage: 2 },
    });
    return;
  }
  // Deep endgame: rank 60 Ascension, level 40 mastery, almost every relic, Oath XIV.
  const levels: Record<ClassId, number> = { knight: 40, barbarian: 18, mage: 31, rogue: 22, templar: 27, spellblade: 12, shade: 35 };
  const xp = perClass((cls) => xpAt(levels[cls], Math.round(xpForLevel(levels[cls]) * 0.63)));
  const shards = Object.fromEntries(RELICS.map((def, i) => [def.id, i === 7 || i === 15 ? 0 : shardsForRank(1 + ((i * 7) % 10)) + (i % 3)]));
  shards.whetstone = shardsForRank(10);
  const lifetime = lifetimeOf({
    runs: 412, wins: 187, kills: 61250, elites: 1480, bosses: 233, resonances: 18420, revives: 96, ultimates: 3110, chambers: 4870,
    damage: 28400000, bestDepth: 7, bestOath: 14, glimmerEarned: 386400,
    masteryLevels: CLASS_IDS.reduce((sum, cls) => sum + levels[cls] - 1, 0),
    relicRanks: Object.values(shards).reduce((sum, n) => sum + rankFromShards(n), 0), classesWon: 7,
  });
  Object.assign(p, {
    runs: 412, wins: 187, bestChamber: 8, oathUnlocked: 14, glimmer: 18450, glimmerEarned: 386400, tutorialDone: true,
    meta: Object.fromEntries(META_UPGRADES.map((def) => [def.id, def.costs.length])),
    xp, arts: { ...perClass(() => 1), barbarian: 0, mage: 0 }, talents: perClass((cls) => [1, 2, levels[cls] >= 10 ? 1 : 0]),
    paragon: Object.fromEntries(PARAGON.map((def, i) => [def.id, i === 0 ? 60 : [48, 31, 25, 40, 26, 12][i - 1] ?? 20])),
    shards, relics: ['whetstone', 'storm_coil', 'phoenix'],
    lifetime, feats: featsClaimed(lifetime, (id) => (id === 'ruin' || id === 'delver' ? 1 : 0)),
    classWins: perClass((cls) => levels[cls]),
  });
}

/** Opens the progression hub on a tab for a profile stage. */
function hub(tab: HubTab, stage: Stage, cls?: ClassId): void {
  stageProfile(stage);
  setScreen('menu');
  ui.hubTab = tab;
  ui.hubCls = cls ?? null;
  ui.hubRelic = null;
  ui.page = 'armory';
  emitAll();
  bus.emit('state:profile');
}

/** Own hero as a given class (HUD checks): bar icons, art, class boons. */
function heroAs(cls: ClassId, art: number, boons: BoonStack[], ult = 0.4): void {
  solo(boons);
  state.roster = state.roster.map((p) => ({ ...p, cls, art, mastery: art > 0 ? 12 : 1 }));
  state.players[0].ult = ult;
  emitAll();
}

const UMBRA_BOONS: BoonStack[] = [
  { id: 'infuse_ember_primary', level: 1 }, { id: 'infuse_rime_secondary', level: 1 }, { id: 'infuse_storm_dash', level: 1 },
  { id: 'infuse_umbra_ultimate', level: 1 },
];
/** A build with several sets in progress: ember tier 2, offense tier 1, resonance 1/2, defense 1/3. */
const SET_BOONS: BoonStack[] = [
  { id: 'infuse_ember_primary', level: 1 }, { id: 'infuse_ember_dash', level: 1 }, { id: 'wildfire', level: 2 }, { id: 'infuse_ember_ultimate', level: 1 },
  { id: 'keen_edge', level: 2 }, { id: 'deadeye', level: 1 }, { id: 'momentum', level: 1 }, { id: 'amplifier', level: 1 }, { id: 'thorns', level: 1 },
  { id: 'zealot', level: 1 }, { id: 'infuse_rime_secondary', level: 1 },
];

const REROLLED: BoonOffer[][] = [
  [{ id: 'amplifier', level: 2 }, { id: 'infuse_storm_dash', level: 1 }, { id: 'barrier', level: 2 }],
  [{ id: 'deadeye', level: 1 }, { id: 'infuse_rime_dash', level: 1 }, { id: 'shared_vigor', level: 1 }],
];
const intentLog: string[] = [];
const labelLog: EventMap['ui:labels'][] = [];
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
  ui.replacing = -1;
  ui.pickedKind = 'boon';
  ui.codexKeystones = 'all';
  ui.lastBuilds = { code: '', bySlot: new Map() };
  resetGrowth();
  ui.page = null;
  ui.codexTab = 'elements';
  ui.wardrobeCls = null;
  ui.biomes.clear();
  ui.hubTab = 'armory';
  ui.hubCls = null;
  ui.hubRelic = null;
  ui.progress = null;
  ui.oathBaseline = null;
  ui.lastObjective = null;
  stageProfile(DEFAULT_STAGE);
  Object.assign(state.profile, { cls: 'knight', looks: { ...defaultLooks(), knight: look(2, 1), mage: look(5, 2, true, false) } });
  // Badges for "new art" only show on the routes that are about them.
  resetMarks();
  for (const cls of CLASS_IDS) setMark(artMark(cls));
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
    doors: step === 'door' ? [{ x: 0, z: -12, type: 'boon', objective: 'slay' }] : [], doorProgress: step === 'door' ? [0.35] : [],
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
    state.run = run({ phase: 'victory', chamber: 0, elapsed: 196, tutorial: { ...tut, progress: 1 }, rewards: [reward(OWN_SLOT, REWARDS.TUTORIAL)] });
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
    case 'status.storm':
    case 'status.umbra': {
      const el = id.slice('status.'.length) as 'ember' | 'rime' | 'storm' | 'umbra';
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
    case 'ultimate': heroAs('mage', 0, TRAINING_BOONS.slice(0, 1), 1); fire({ e: 'ultReady', slot: 0 }); break;
    case 'descend': ROUTES['doors-deep'](); break;
    case 'affix': inGame({ entered: 'boon' }); fire({ e: 'spawn', id: 31, kind: 'warrior', ...at2, elite: true, affix: 'volatile' }); break;
    case 'set': solo(SET_BOONS); fire({ e: 'set', slot: 0, id: 'set_ember', tier: 2 }); break;
    case 'enemy.shaman':
    case 'enemy.aegis':
    case 'enemy.bomber':
    case 'enemy.necromancer':
    case 'enemy.reaver':
      inGame({ entered: 'boon', objective: objectiveState('slay', 'mid') });
      fire({ e: 'spawn', id: 61, kind: id.slice('enemy.'.length) as (typeof NEW_FOES)[number], ...at2, elite: false });
      break;
    case 'ward': inGame({ entered: 'boon', chamber: 5 }); fire({ e: 'spawn', id: 62, kind: 'warrior', ...at2, elite: false, ward: 'storm' }); break;
    case 'objective': ROUTES['doors-obj'](); break;
  }
  emitAll();
}

function profileState(patch: { glimmer: number; meta: Record<string, number> }): void {
  Object.assign(state.profile, patch);
}

/** Stand-in for core `bookRewards`: credits the own reward and announces it like the real client does. */
function bookDemo(cls: ClassId, own: RunReward | undefined): void {
  if (!own) return;
  const p = state.profile;
  const before = levelFromXp(p.xp[cls] ?? 0).level;
  const relics = own.relics.map((id) => {
    const had = rankFromShards(p.shards[id] ?? 0);
    p.shards[id] = (p.shards[id] ?? 0) + 1;
    const rank = rankFromShards(p.shards[id]);
    return { id, rank, rankUp: rank > had };
  });
  p.glimmer += own.glimmer;
  p.xp[cls] = (p.xp[cls] ?? 0) + own.xp;
  const level = levelFromXp(p.xp[cls]).level;
  bus.emit('game:progress', { cls, xp: own.xp, levelsGained: level - before, level, relics, featsReady: 0 });
}

function summary(
  patch: Partial<RunState>, rewards: RunReward[],
  opts: { cls?: ClassId; solo?: boolean; guests?: number; stage?: Stage; oathBaseline?: number } = {},
): void {
  session();
  if (opts.stage) stageProfile(opts.stage);
  if (opts.solo) state.roster = roster().slice(0, 1);
  else if (opts.guests) state.roster = roster().slice(0, opts.guests);
  const cls = opts.cls ?? state.roster[0].cls;
  state.roster[0] = { ...state.roster[0], cls, mastery: levelFromXp(state.profile.xp[cls] ?? 0).level };
  ui.oathBaseline = opts.oathBaseline ?? state.profile.oathUnlocked;
  state.run = run({ ...patch, rewards });
  state.run.stats = state.run.stats.filter((row) => state.roster.some((p) => p.slot === row.slot));
  setScreen('summary');
  bookDemo(cls, rewards.find((r) => r.slot === OWN_SLOT));
  emitAll();
  bus.emit('state:profile');
}


// ------------------------------------------------------------------ update 4: objectives

type ObjectiveStage = 'start' | 'mid' | 'lost' | 'done' | 'won';
const OBJECTIVE_STAGES: readonly ObjectiveStage[] = ['start', 'mid', 'lost', 'done', 'won'];

/** A plausible ObjectiveState for a kind at a stage (lost = bonus gone, done = complete without, won = with bonus). */
function objectiveState(kind: ObjectiveKind, stage: ObjectiveStage): ObjectiveState {
  const done = stage === 'done' || stage === 'won';
  const bonus = stage !== 'lost' && stage !== 'done';
  const k = stage === 'start' ? 0 : done ? 1 : stage === 'lost' ? 0.7 : 0.45;
  const base: ObjectiveState = { kind, progress: k, timeLeft: 0, bonus, status: done ? 'done' : 'active', anchor: null, sites: [], targets: [] };
  const tune = OBJECTIVE_TUNING;
  switch (kind) {
    case 'survive':
      return { ...base, timeLeft: done ? 0 : Math.round(tune.SURVIVE.SECONDS * (1 - k)) };
    case 'defend':
      return { ...base, anchor: { x: 0, z: 0, r: tune.DEFEND.RADIUS, hp: stage === 'start' ? 1 : stage === 'mid' ? 0.72 : stage === 'won' ? 0.31 : 0 } };
    case 'hunt':
      return {
        ...base, progress: stage === 'mid' ? 1 / 3 : stage === 'lost' ? 2 / 3 : k,
        timeLeft: stage === 'start' ? tune.HUNT.SECONDS : stage === 'mid' ? 23 : 0,
        targets: stage === 'start' ? [71, 72, 73] : stage === 'mid' ? [72, 73] : stage === 'lost' ? [73] : [],
      };
    case 'ritual': {
      const fill = stage === 'start' ? [0, 0, 0] : stage === 'mid' ? [1, 0.55, 0] : stage === 'lost' ? [1, 1, 0.3] : [1, 1, 1];
      return {
        ...base, timeLeft: stage === 'start' ? tune.RITUAL.BONUS_SECONDS : stage === 'mid' ? 38 : 0,
        sites: fill.map((progress, i) => ({ x: -8 + i * 8, z: i === 1 ? -6 : 4, r: tune.RITUAL.RADIUS, progress, lit: progress >= 1 })),
      };
    }
    case 'vault':
      return { ...base, bonus: false, progress: stage === 'start' ? 0 : done ? 1 : 0.6 };
    default:
      return { ...base, bonus: false };
  }
}

/** A chamber with this objective at this stage, plus the event that leads to it. */
function objectiveRoute(kind: ObjectiveKind, stage: ObjectiveStage, soloRun = false): void {
  const patch: Partial<RunState> = {
    chamber: kind === 'vault' ? 2 : 4, entered: kind === 'hunt' ? 'cursed' : 'boon', objective: objectiveState(kind, stage),
    wave: kind === 'defend' && stage !== 'start' ? 2 : 1, waveCount: kind === 'defend' ? 3 : 1, elapsed: 437,
  };
  if (soloRun) solo(TRAINING_BOONS.slice(0, 2), patch);
  else inGame(patch);
  state.enemiesAlive = kind === 'vault' ? 0 : stage === 'done' || stage === 'won' ? 0 : 14;
  state.players[0].hp = 87;
  emitAll();
  if (stage === 'start') fire({ e: 'objective', kind, what: 'start' });
  if (stage === 'lost') fire({ e: 'objective', kind, what: 'bonusLost' });
  if (stage === 'done' || stage === 'won') fire({ e: 'objective', kind, what: 'done', bonus: stage === 'won' });
}

/**
 * Polish 1: a realistic burst of a four-hero fight in a ritual chamber — five new foes in one wave, wards, affixes,
 * three allied ultimates, reactions of several kinds, downs and a revive — to judge feed, callouts and tips under
 * load. All tips are unseen. `ownDown` also drops the own hero two seconds in.
 */
const BUSY_MS = { STEP: 150, OWN_DOWN: 2000, REVIVE: 2300, LATE_FOE: 2700 } as const;
let busyTimers: number[] = [];

function busyFight(ownDown: boolean): void {
  for (const id of busyTimers) window.clearTimeout(id);
  busyTimers = [];
  inGame({ chamber: 5, entered: 'cursed', wave: 1, waveCount: 1, objective: objectiveState('ritual', 'mid'), room: room('forge', false) });
  state.players = players().map((p) => ({ ...p, state: 'alive', hp: Math.max(p.hp, 40), revive: 0, ult: p.slot === OWN_SLOT ? 0.97 : 0.9 }));
  state.roster = roster().map((p) => ({ ...p, connected: true }));
  state.enemiesAlive = 27;
  emitAll();
  resetTips();
  const p = { x: 2, z: -1 };
  const steps: (() => void)[] = [
    () => {
      // One wave brings all five new kinds, two wards and two affixed elites.
      NEW_FOES.forEach((kind, i) => fire({ e: 'spawn', id: 60 + i, kind, ...p, elite: false, ...(i === 1 ? { ward: 'rime' as const } : {}) }));
      fire({ e: 'spawn', id: 70, kind: 'warrior', ...p, elite: false, ward: 'umbra' });
      fire({ e: 'spawn', id: 71, kind: 'warrior', ...p, elite: true, affix: 'volatile' });
      fire({ e: 'spawn', id: 72, kind: 'archer', ...p, elite: true, affix: 'swift' });
    },
    () => fire({ e: 'ultReady', slot: 1 }),
    () => fire({ e: 'resonance', ...p, r: 3, a: 'storm', b: 'umbra', by: 2 }),
    () => { fire({ e: 'ultReady', slot: 2 }); fire({ e: 'hit', target: { t: 'e', id: 60 }, ...p, dmg: 22, crit: false, el: 'ember', by: OWN_SLOT }); },
    () => fire({ e: 'resonance', ...p, r: 3, a: 'rime', b: 'umbra', by: 1 }),
    () => { state.players[2] = { ...state.players[2], hp: 0, state: 'downed' }; bus.emit('state:hud'); fire({ e: 'down', slot: 2 }); },
    () => { state.players[0].ult = 1; bus.emit('state:hud'); fire({ e: 'ultReady', slot: OWN_SLOT }); },
    () => fire({ e: 'resonance', ...p, r: 3, a: 'storm', b: 'umbra', by: OWN_SLOT }),
    () => fire({ e: 'objective', kind: 'ritual', what: 'site', index: 0 }),
    () => { state.players[3] = { ...state.players[3], hp: 0, state: 'downed' }; bus.emit('state:hud'); fire({ e: 'down', slot: 3 }); },
    () => fire({ e: 'ultReady', slot: 3 }),
    () => fire({ e: 'resonance', ...p, r: 3, a: 'ember', b: 'rime', by: 3 }),
    () => fire({ e: 'resonance', ...p, r: 3, a: 'storm', b: 'umbra', by: 2 }),
  ];
  const later = (ms: number, step: () => void): void => {
    busyTimers.push(window.setTimeout(() => { if (state.screen === 'game') step(); }, ms));
  };
  steps.forEach((step, i) => later(i * BUSY_MS.STEP, step));
  if (ownDown) {
    later(BUSY_MS.OWN_DOWN, () => { state.players[0] = { ...state.players[0], hp: 0, state: 'downed' }; bus.emit('state:hud'); fire({ e: 'down', slot: OWN_SLOT }); });
  }
  later(BUSY_MS.REVIVE, () => {
    state.players[2] = { ...state.players[2], hp: 40, state: 'alive' };
    bus.emit('state:hud');
    fire({ e: 'revived', slot: 2, by: 1 });
    fire({ e: 'resonance', ...p, r: 3, a: 'rime', b: 'umbra', by: 1 });
  });
  // A late arrival of a kind that is already explained must not bring its tip back.
  later(BUSY_MS.LATE_FOE, () => { fire({ e: 'spawn', id: 80, kind: 'bomber', ...p, elite: false }); fire({ e: 'objective', kind: 'ritual', what: 'site', index: 1 }); });
}

const door = (x: number, type: DoorType, objective: ObjectiveKind): Door => ({ x, z: -10, type, objective });

function objectiveDoors(doors: Door[], patch: Partial<RunState> = {}): void {
  inGame({ phase: 'doors', chamber: 2, entered: 'boon', doors, doorProgress: doors.map((_, i) => (i === 0 ? 0.2 : 0.65)), ...patch });
  state.players[2] = { ...state.players[2], hp: 34, state: 'alive', revive: 0 };
  state.enemiesAlive = 0;
  emitAll();
}

/** A draft that follows a chamber whose objective ended with / without its bonus. */
function objectiveDraft(kind: ObjectiveKind, earned: boolean, offers: BoonOffer[]): void {
  inGame({ phase: 'draft', draftPending: [0, 1, 2], draftTime: 32, entered: 'boon', chamber: 4, objective: objectiveState(kind, earned ? 'won' : 'done') });
  state.enemiesAlive = 0;
  state.draft = offers;
  emitAll();
}

const OBJECTIVE_ROUTES: Record<string, () => void> = {
  ...Object.fromEntries(OBJECTIVE_KINDS.flatMap((kind) => OBJECTIVE_STAGES.flatMap((stage): [string, () => void][] => [
    [`obj-${kind}-${stage}`, () => objectiveRoute(kind, stage)],
  ]))),
  ...Object.fromEntries(OBJECTIVE_KINDS.map((kind): [string, () => void] => [`obj-${kind}-solo`, () => objectiveRoute(kind, 'mid', true)])),
  'obj-hunt-escort': () => {
    objectiveRoute('hunt', 'mid');
    if (state.run?.objective) { state.run.objective.targets = []; state.run.objective.progress = 0.8; }
    state.enemiesAlive = 5;
    emitAll();
  },
  'obj-defend-low': () => {
    objectiveRoute('defend', 'mid');
    if (state.run?.objective?.anchor) state.run.objective.anchor.hp = 0.18;
    emitAll();
    fire({ e: 'objective', kind: 'defend', what: 'anchorHit' });
  },
  'obj-ritual-late': () => {
    // An older server without a ritual timer: the HUD counts the bonus limit itself from the start event.
    objectiveRoute('ritual', 'mid');
    if (state.run?.objective) state.run.objective.timeLeft = 0;
    if (state.run) state.run.elapsed -= 20;
    fire({ e: 'objective', kind: 'ritual', what: 'start' });
    if (state.run) state.run.elapsed += 20;
    emitAll();
    fire({ e: 'objective', kind: 'ritual', what: 'site', index: 0 });
  },
  'obj-vault-open': () => objectiveRoute('vault', 'mid'),
  'obj-act': () => {
    // New act and a special objective at once: the act is announced first, the objective follows.
    inGame({ chamber: 0, depth: 1, cleared: 1, chambersCleared: 8, entered: 'descend', wave: 1, waveCount: 1, room: room('crypt'), objective: objectiveState('ritual', 'start') });
    fire({ e: 'objective', kind: 'ritual', what: 'start' });
    fire({ e: 'wave', wave: 1, waveCount: 1 });
  },
  'doors-obj': () => objectiveDoors([door(-6, 'boon', 'defend'), door(6, 'cursed', 'hunt')]),
  'doors-obj-2': () => objectiveDoors([door(-6, 'blessing', 'ritual'), door(6, 'boon', 'survive')]),
  'doors-obj-vault': () => objectiveDoors([door(-6, 'boon', 'vault'), door(6, 'cursed', 'slay')]),
  'doors-obj-same': () => objectiveDoors([door(6, 'boon', 'survive'), door(-6, 'boon', 'slay')]),
  'doors-obj-deep': () => objectiveDoors([door(-6, 'descend', 'ritual'), door(6, 'ascend', 'slay')],
    { chamber: 7, chamberKind: 'boss', cleared: 1, chambersCleared: 8, entered: 'boss', bossKind: 'matron' }),
  'boss-doors': () => {
    // The boss is dead but its last health value is still in the state: the bar must be gone.
    ROUTES['doors-deep']();
    if (state.run) state.run.bossKind = 'matron';
    state.bossHp = 0;
    emitAll();
  },
  'draft-bonus': () => objectiveDraft('hunt', true, [...DRAFT, { id: 'duo_shatter', level: 1 }]),
  'draft-nobonus': () => objectiveDraft('hunt', false, [...DRAFT]),
  'draft-bonus-event': () => {
    // A server that clears `run.objective` before the draft: the mark then rests on the `done` event alone.
    objectiveRoute('ritual', 'mid');
    fire({ e: 'objective', kind: 'ritual', what: 'done', bonus: true });
    setRun(run({ phase: 'draft', draftPending: [0, 1, 2], draftTime: 32, entered: 'boon', chamber: 4, objective: null }));
    state.enemiesAlive = 0;
    state.draft = [...DRAFT, { id: 'duo_shatter', level: 1 }];
    emitAll();
  },
  'draft-vault': () => objectiveDraft('vault', false, [{ id: 'encore', level: 1 }, { id: 'infuse_storm_dash', level: 1 }, { id: 'iron_heart', level: 2 }, { id: 'echo', level: 1 }]),
  // A hunt joined in mid-chamber: one of three marked elites is left, the two dead ones must still show as pips.
  'obj-hunt-reload': () => objectiveRoute('hunt', 'lost'),
  'obj-hunt-escort-reload': () => { objectiveRoute('hunt', 'lost'); if (state.run?.objective) { state.run.objective = { ...state.run.objective, targets: [], progress: 1 }; emitAll(); } },
  'codex-tips': () => { setScreen('menu'); ui.codexTab = 'tips'; ui.page = 'codex'; emitAll(); },
  busy: () => busyFight(false),
  'busy-down': () => busyFight(true),
  ward: () => { inGame({ entered: 'boon', chamber: 5, objective: objectiveState('slay', 'mid') }); ELEMENT_IDS.forEach((ward, i) => fire({ e: 'spawn', id: 80 + i, kind: 'warrior', x: 2, z: -1, elite: false, ward })); },
  'ward-own': () => { solo(TRAINING_BOONS.slice(0, 1), { chamber: 5, objective: objectiveState('slay', 'mid') }); fire({ e: 'spawn', id: 80, kind: 'minion', x: 2, z: -1, elite: false, ward: 'ember' }); },
  foes: () => {
    inGame({ entered: 'boon', chamber: 5, objective: objectiveState('slay', 'mid') });
    NEW_FOES.forEach((kind, i) => fire({ e: 'spawn', id: 90 + i, kind, x: 2, z: -1, elite: false }));
    fire({ e: 'dome', id: 91, on: true, r: 4.5 });
    fire({ e: 'mend', id: 90, targets: [12, 13] });
  },
  'summary-objectives': () => {
    summary({ phase: 'victory', chamber: 7, chamberKind: 'boss', elapsed: 754, bossKind: 'matron', cleared: 1, chambersCleared: 8, objectivesDone: 5, objectiveBonuses: 3 },
      [reward(0, 261, 372, ['storm_coil']), reward(1, 237, 340), reward(2, 237, 340, ['whetstone']), reward(3, 237, 340)], { oathBaseline: 2 });
  },
  'summary-objectives-fell': () => {
    summary({ phase: 'defeat', chamber: 3, chamberKind: 'elite', elapsed: 1722, depth: 1, cleared: 1, chambersCleared: 11, oath: 3, objectivesDone: 9, objectiveBonuses: 1 },
      [reward(0, 544, 910, ['whetstone', 'phoenix']), reward(1, 498, 860, ['tome']), reward(2, 498, 860), reward(3, 498, 860)], { oathBaseline: 3 });
  },
};

// ------------------------------------------------------------------ update 5: keystones, builds, growth

/** Gives the own hero keystones (and optionally other boons); allies get builds too with `party`. */
function hold(ids: string[], boons?: BoonStack[], party = false): void {
  state.roster = state.roster.map((p) => {
    if (p.slot === OWN_SLOT) return { ...p, keystones: ids, boons: boons ?? p.boons };
    if (!party) return p;
    return { ...p, keystones: p.slot === 1 ? ['twin_cast', 'ks_templar'] : p.slot === 2 ? ['ks_spellblade'] : [] };
  });
}

const DASH_BOONS: BoonStack[] = [
  { id: 'infuse_storm_dash', level: 1 }, { id: 'infuse_ember_primary', level: 2 }, { id: 'quick_step', level: 2 }, { id: 'afterimage', level: 1 },
  { id: 'keen_edge', level: 2 }, { id: 'barrier', level: 1 }, { id: 'catalyst', level: 1 }, { id: 'spare_step', level: 1 }, { id: 'overkill', level: 1 },
  { id: 'iron_heart', level: 2 },
];

function keystoneDraft(held: string[], offers: string[], patch: Partial<RunState> = {}): void {
  inGame({ phase: 'draft', chamber: 3, chamberKind: 'elite', entered: 'boon', bossKind: 'champion', draftPending: [0, 1, 2], draftTime: 41, ...patch });
  state.enemiesAlive = 0;
  hold(held, DASH_BOONS);
  state.draft = offers.map((id) => ({ id, level: 1 }));
  state.draftKeystone = { held, skip: offers.length };
  emitAll();
}

function fitsDraft(held: string[], offers: BoonOffer[]): void {
  inGame({ phase: 'draft', chamber: 4, entered: 'boon', draftPending: [0, 1, 2], draftTime: 33 });
  state.enemiesAlive = 0;
  hold(held, DASH_BOONS);
  state.draft = offers;
  emitAll();
}

function hudWith(ids: string[], party = false): void {
  inGame({ entered: 'boon' });
  hold(ids, DASH_BOONS, party);
  state.players[2] = { ...state.players[2], hp: 61, state: 'alive', revive: 0 };
  emitAll();
}

const sample = (chamber: number, damage: number, seconds: number | null = 60, depth = 0, partial = false): ChamberSample =>
  ({ chamber, depth, kind: RUN.CHAMBERS[chamber] ?? 'combat', damage, seconds, partial });
const took = (slot: number, id: string, chamber: number, at: number, depth = 0): KeystoneTaken => ({ slot, id, chamber, depth, at });

function growthSummary(
  patch: Partial<RunState>, samples: ChamberSample[], taken: KeystoneTaken[], joinedLate = false, guests = 4,
): void {
  summary(patch, [reward(0, 261, 372, ['storm_coil']), reward(1, 237, 340), reward(2, 237, 340), reward(3, 237, 340)].slice(0, guests), { guests, oathBaseline: 3 });
  hold(taken.filter((k) => k.slot === OWN_SLOT).map((k) => k.id).slice(-2), DASH_BOONS, true);
  setGrowthForDemo(samples, [...taken, took(1, 'twin_cast', 3, 4), took(1, 'ks_templar', 6, 7), took(2, 'ks_spellblade', 3, 4)], joinedLate);
  emitAll();
}

const LONG_RUN: ChamberSample[] = [
  sample(0, 1180, 48), sample(1, 1420, 51), sample(2, 1690, 55), sample(3, 2950, 71), sample(4, 2480, 44), sample(5, 3310, 47), sample(6, 5240, 66),
  sample(7, 7430, 92),
];

const KEYSTONE_ROUTES: Record<string, () => void> = {
  'ks-draft': () => keystoneDraft([], ['ember_wake', 'heavy_hitter', 'ks_knight']),
  'ks-draft-one': () => keystoneDraft(['ember_wake'], ['shockstep', 'blood_price', 'corpse_bloom'], { chamber: 6, depth: 0, bossKind: 'matron' }),
  'ks-draft-full': () => keystoneDraft(['ember_wake', 'shockstep'], ['glass_cannon', 'resonance_engine', 'momentum_engine'], { chamber: 3, depth: 1 }),
  'ks-draft-replace': () => { KEYSTONE_ROUTES['ks-draft-full'](); ui.replacing = 0; emitAll(); },
  'ks-draft-tip': () => { resetTips(); for (const id of TIP_IDS) if (id !== 'keystone') markTipSeen(id); KEYSTONE_ROUTES['ks-draft'](); },
  'ks-draft-reroll': () => {
    profileState({ glimmer: 400, meta: { insight: 2 } });
    state.draftRerolls = 2;
    keystoneDraft(['familiar'], ['orbit_blades', 'sanguine', 'twin_cast']);
    state.draftRerolls = 2;
    emitAll();
  },
  'ks-draft-wait': () => {
    inGame({ phase: 'draft', chamber: 3, chamberKind: 'elite', entered: 'boon', draftPending: [1, 2], draftTime: 18 });
    state.enemiesAlive = 0;
    hold(['ember_wake'], DASH_BOONS);
    ui.pickedKind = 'keystone';
    emitAll();
    fire({ e: 'keystone', slot: 0, id: 'ember_wake' });
  },
  'draft-fits': () => fitsDraft(['ember_wake'], [
    { id: 'quick_step', level: 3, fits: ['dash'] }, { id: 'infuse_rime_dash', level: 1, fits: ['dash', 'status'] }, { id: 'iron_heart', level: 3 },
  ]),
  'draft-fits-2': () => fitsDraft(['ember_wake', 'momentum_engine'], [
    { id: 'slipstream', level: 1, fits: ['dash', 'speed'] }, { id: 'executioner', level: 1, fits: ['kill'] }, { id: 'barrier', level: 2 },
    { id: 'wide_resonance', level: 1, fits: ['area'] },
  ]),
  'draft-fits-tip': () => { resetTips(); for (const id of TIP_IDS) if (id !== 'fits') markTipSeen(id); KEYSTONE_ROUTES['draft-fits'](); },
  'hud-ks-0': () => hudWith([]),
  'hud-ks-1': () => hudWith(['ember_wake']),
  'hud-ks-2': () => hudWith(['ember_wake', 'shockstep'], true),
  'party-builds': () => hudWith(['ks_knight', 'colossus'], true),
  'hud-ks-ind': () => {
    hudWith(['momentum_engine', 'blood_price']);
    fire({ e: 'keystoneProc', slot: 0, id: 'momentum_engine', x: 0, z: 0, n: 7 });
    fire({ e: 'keystoneProc', slot: 0, id: 'blood_price', x: 0, z: 0, n: 10 });
  },
  'hud-ks-ind-2': () => {
    hudWith(['phase_walker', 'resonance_engine']);
    fire({ e: 'buff', slot: 0, id: 'phase_walker', dur: 2 });
    fire({ e: 'keystoneProc', slot: 0, id: 'resonance_engine', x: 2, z: 1, n: 14 });
  },
  'hud-ks-veil': () => {
    heroAs('shade', 0, DASH_BOONS, 0.3);
    hold(['ks_shade', 'glass_cannon']);
    emitAll();
    fire({ e: 'buff', slot: 0, id: 'ks_shade', dur: 1.5 });
  },
  'ks-banner': () => { hudWith([]); hold(['ember_wake'], DASH_BOONS); emitAll(); fire({ e: 'keystone', slot: 0, id: 'ember_wake' }); },
  'ks-banner-2': () => { hudWith(['ember_wake']); hold(['ember_wake', 'shockstep'], DASH_BOONS); emitAll(); fire({ e: 'keystone', slot: 0, id: 'shockstep' }); },
  'ks-banner-replace': () => {
    hudWith(['ember_wake', 'shockstep']);
    hold(['shockstep', 'heavy_hitter'], DASH_BOONS);
    emitAll();
    fire({ e: 'keystone', slot: 0, id: 'heavy_hitter', replaced: 'ember_wake' });
  },
  'ks-ally': () => {
    hudWith(['ember_wake'], true);
    fire({ e: 'keystone', slot: 1, id: 'twin_cast' });
    fire({ e: 'keystone', slot: 2, id: 'ks_spellblade' });
  },
  'tab-build': () => { hudWith(['ember_wake', 'shockstep'], true); setGrowthForDemo([], [took(0, 'ember_wake', 3, 4), took(0, 'shockstep', 6, 7)], false); ui.tab = true; emitAll(); },
  'tab-build-one': () => { hudWith(['corpse_bloom'], true); ui.tab = true; emitAll(); },
  'tab-build-none': () => { hudWith([]); ui.tab = true; emitAll(); },
  'summary-growth': () => growthSummary({ phase: 'victory', chamber: 7, chamberKind: 'boss', elapsed: 754, bossKind: 'matron', cleared: 1, chambersCleared: 8 },
    LONG_RUN, [took(0, 'ember_wake', 3, 4), took(0, 'shockstep', 6, 7)]),
  'summary-growth-short': () => growthSummary({ phase: 'defeat', chamber: 2, chamberKind: 'combat', elapsed: 201, chambersCleared: 2 },
    [sample(0, 1040, 52), sample(1, 1210, 49), sample(2, 380, null, 0, true)], [], false, 1),
  'summary-growth-join': () => growthSummary({ phase: 'defeat', chamber: 6, chamberKind: 'elite', elapsed: 598, chambersCleared: 6 },
    [sample(4, 1620, null), sample(5, 3980, 58), sample(6, 2110, null, 0, true)], [took(0, 'chain_lightning', 3, 0)], true, 2),
  'summary-growth-deep': () => growthSummary({ phase: 'defeat', chamber: 4, chamberKind: 'combat', elapsed: 2410, depth: 2, cleared: 2, chambersCleared: 20, oath: 3 },
    [0, 1, 2].flatMap((depth) => LONG_RUN.slice(0, depth === 2 ? 5 : 8).map((s, i) => sample(s.chamber, Math.round(s.damage * (1 + depth * 1.3) * (i % 3 === 1 ? 0.9 : 1)), s.seconds, depth, depth === 2 && i === 4))),
    [took(0, 'ember_wake', 3, 4), took(0, 'corpse_bloom', 6, 7), took(0, 'chain_lightning', 3, 12, 1)]),
  'summary-growth-none': () => growthSummary({ phase: 'defeat', chamber: 0, chamberKind: 'combat', elapsed: 44, chambersCleared: 0 }, [], [], false, 1),
  // The tracker itself: a run played through events and run states, as the real client would feed it.
  'summary-growth-live': () => {
    inGame({ chamber: 0, entered: 'boon', elapsed: 0, chambersCleared: 0 });
    let total = run().stats.find((row) => row.slot === OWN_SLOT)?.damage ?? 0;
    const clear = (chamber: number, damage: number, elapsed: number): void => {
      const kind = RUN.CHAMBERS[chamber];
      setRun(run({ phase: 'combat', chamber, chamberKind: kind, entered: 'boon', elapsed: elapsed - 50, chambersCleared: chamber }));
      setRun(run({ phase: 'combat', chamber, chamberKind: kind, entered: 'boon', elapsed, chambersCleared: chamber }));
      total += damage;
      const stats = run().stats.map((row) => (row.slot === OWN_SLOT ? { ...row, damage: total } : row));
      // The clear arrives before the run state that carries the final totals.
      fire({ e: 'chamberClear' });
      setRun(run({ phase: 'draft', chamber, chamberKind: kind, entered: 'boon', elapsed, chambersCleared: chamber + 1, stats }));
      if (kind === 'elite') { hold([chamber === 3 ? 'ember_wake' : 'shockstep', ...(chamber === 3 ? [] : ['ember_wake'])].reverse()); fire({ e: 'keystone', slot: 0, id: chamber === 3 ? 'ember_wake' : 'shockstep' }); }
    };
    [900, 1100, 1500, 2600, 2400, 3900, 5200].forEach((damage, chamber) => clear(chamber, damage, (chamber + 1) * 80));
    const kept = state.roster;
    summary({ phase: 'defeat', chamber: 7, chamberKind: 'boss', elapsed: 640, chambersCleared: 7,
      stats: run().stats.map((row) => (row.slot === OWN_SLOT ? { ...row, damage: total + 1300 } : row)) }, [reward(0, 200, 300)]);
    state.roster = kept;
    emitAll();
  },
  'lobby-after': () => {
    growthSummary({ phase: 'victory', chamber: 7, chamberKind: 'boss', elapsed: 754, cleared: 1, chambersCleared: 8 }, LONG_RUN, [took(0, 'ember_wake', 3, 4), took(0, 'shockstep', 6, 7)]);
    bus.emit('state:run', { previousPhase: 'combat' });
    const kept = ui.lastBuilds;
    state.roster = roster();
    state.run = run({ phase: 'lobby' });
    ui.lastBuilds = kept;
    setScreen('lobby');
    emitAll();
    ui.lastBuilds = kept;
    bus.emit('state:roster');
  },
};

const ROUTES: Record<string, () => void> = {
  loading: () => { setScreen('loading'); bus.emit('assets:progress', { loaded: 23, total: 37 }); },
  'loading-error': () => {
    setScreen('loading');
    bus.emit('assets:error', { message: 'GET /assets/models/knight.glb 404 (Not Found)' });
  },
  menu: () => { setScreen('menu'); emitAll(); },
  'menu-new': () => {
    stageProfile('new');
    Object.assign(state.profile, { glimmer: 0, glimmerEarned: 0, tutorialDone: false });
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
      phase: 'doors', doors: [{ x: -6, z: -10, type: 'blessing', objective: 'slay' }, { x: 6, z: -10, type: 'cursed', objective: 'slay' }], doorProgress: [0.2, 0.65],
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
  'summary-win': () => summary({ phase: 'victory', chamber: 7, chamberKind: 'boss', elapsed: 754, bossKind: 'matron', cleared: 1, chambersCleared: 8 },
    [reward(0, 261, 372, ['storm_coil']), reward(1, 237, 340), reward(2, 237, 340, ['whetstone']), reward(3, 237, 340)], { oathBaseline: 2 }),
  'summary-levelup': () => {
    // A fresh Templar gains three levels at once: art at 2, the first talent tier at 3.
    stageProfile('new');
    state.profile.cls = 'templar';
    summary({ phase: 'victory', chamber: 7, chamberKind: 'boss', elapsed: 812, bossKind: 'regent', finalBoss: 'regent', cleared: 1, chambersCleared: 8, oath: 0 },
      [reward(0, 188, 760, ['iron_reliquary', 'iron_reliquary', 'bell'])], { cls: 'templar', solo: true, oathBaseline: 0 });
  },
  'summary-fell': () => summary({ phase: 'defeat', chamber: 3, chamberKind: 'elite', elapsed: 1722, depth: 1, cleared: 1, chambersCleared: 11, oath: 3 },
    [reward(0, 544, 910, ['whetstone', 'phoenix']), reward(1, 498, 860, ['tome']), reward(2, 498, 860), reward(3, 498, 860)], { oathBaseline: 3 }),
  'summary-ascended': () => summary({ phase: 'victory', chamber: 7, chamberKind: 'boss', elapsed: 2871, depth: 2, cleared: 3, chambersCleared: 24, oath: 5, finalBoss: 'stalker' },
    [reward(0, 1620, 2480, ['whetstone', 'whetstone', 'compass', 'ember_heart', 'ember_heart']), reward(1, 1490, 2300, ['bell', 'bell'])], { stage: 'end', guests: 2 }),
  'summary-loss': () => {
    session(GUEST_SLOT);
    stageProfile(DEFAULT_STAGE);
    state.run = run({ phase: 'defeat', chamber: 5, elapsed: 512, rewards: [reward(0, 86, 120), reward(1, 78, 104)] });
    bookDemo('templar', state.run.rewards[1]);
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
      phase: 'victory', chamber: 0, elapsed: 196, oath: 0, rewards: [reward(0, REWARDS.TUTORIAL)],
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
  ...Object.fromEntries((['elements', 'classes', 'combat', 'objectives', 'hazards', 'bestiary', 'doors', 'boons', 'keystones', 'progress'] as CodexTab[]).map((tab): [string, () => void] =>
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
  // ---- update 3
  ...Object.fromEntries(CLASS_IDS.flatMap((cls): [string, () => void][] => [
    [`menu-${cls}`, () => { state.profile.cls = cls; setScreen('menu'); emitAll(); }],
    [`wardrobe-${cls}`, () => { setScreen('menu'); ui.wardrobeCls = cls; ui.page = 'wardrobe'; emitAll(); }],
    [`hud-${cls}`, () => heroAs(cls, 0, [{ id: 'keen_edge', level: 1 }])],
    [`hud-${cls}-art`, () => heroAs(cls, 1, [{ id: 'infuse_storm_secondary', level: 1 }], 1)],
    [`hub-mastery-${cls}`, () => hub('mastery', DEFAULT_STAGE, cls)],
  ])),
  'menu-badge': () => {
    // Feat tiers waiting and a talent tier left open: the menu button carries a count.
    stageProfile('mid');
    resetMarks();
    setScreen('menu');
    emitAll();
  },
  'menu-end': () => { stageProfile('end'); state.profile.cls = 'shade'; setScreen('menu'); emitAll(); },
  'lobby-oath': () => {
    stageProfile('end');
    session();
    state.oath = 12;
    state.run = run({ phase: 'lobby' });
    setScreen('lobby');
    emitAll();
  },
  'lobby-new': () => { stageProfile('new'); session(); state.oath = 0; state.run = run({ phase: 'lobby' }); setScreen('lobby'); emitAll(); },
  'ult-0': () => { inGame(); state.players[0].ult = 0; emitAll(); },
  'ult-half': () => { inGame(); state.players[0].ult = 0.5; emitAll(); },
  'ult-ready': () => { inGame(); state.players[0].ult = 1; emitAll(); fire({ e: 'ultReady', slot: 0 }); },
  'ult-infused': () => { solo(UMBRA_BOONS); state.players[0].ult = 1; emitAll(); },
  'ult-denied': () => { inGame(); Object.assign(state.players[0], { ult: 0.3, cdSecondary: 0, cdDash: 0 }); emitAll(); bus.emit('game:localAction', { action: 'denied' }); },
  buffs: () => {
    heroAs('barbarian', 0, TRAINING_BOONS.slice(0, 1), 0.2);
    fire({ e: 'buff', slot: 0, id: 'bloodrage', dur: 8 });
    fire({ e: 'buff', slot: 0, id: 'bulwark', dur: 3.5 });
    fire({ e: 'buff', slot: 0, id: 'overload', dur: 1.6 });
  },
  sets: () => solo(SET_BOONS),
  'set-toast': () => { solo(SET_BOONS); fire({ e: 'set', slot: 0, id: 'set_ember', tier: 2 }); },
  'set-ally': () => { inGame(); fire({ e: 'set', slot: 1, id: 'set_defense', tier: 1 }); },
  'strip-4': () => solo(UMBRA_BOONS),
  'strip-umbra': () => solo([{ id: 'infuse_umbra_primary', level: 1 }, { id: 'infuse_rime_secondary', level: 1 }]),
  ...Object.fromEntries(REACTIONS.map((reaction): [string, () => void] => [`reaction-${reaction.id}`, () => {
    solo([{ id: `infuse_${reaction.pair[0]}_primary`, level: 1 }, { id: `infuse_${reaction.pair[1]}_secondary`, level: 1 }]);
    fire({ e: 'resonance', x: 2, z: -1, r: 3, a: reaction.pair[0], b: reaction.pair[1], by: 0 });
  }])),
  'depth-2': () => inGame({ depth: 1, cleared: 1, chamber: 2, chambersCleared: 10, entered: 'boon', oath: 4, finalBoss: 'stalker' }),
  'depth-7': () => inGame({ depth: 6, cleared: 6, chamber: 6, chamberKind: 'elite', chambersCleared: 54, entered: 'cursed', oath: 14, finalBoss: 'regent' }),
  descend: () => { inGame({ depth: 1, cleared: 1, chamber: 0, chambersCleared: 8, entered: 'descend', wave: 1, elapsed: 790 }); fire({ e: 'descend', depth: 1 }); },
  'doors-deep': () => {
    inGame({
      phase: 'doors', chamber: 7, chamberKind: 'boss', cleared: 1, chambersCleared: 8, entered: 'boss',
      doors: [{ x: -6, z: -10, type: 'descend', objective: 'slay' }, { x: 6, z: -10, type: 'ascend', objective: 'slay' }], doorProgress: [0.55, 0.1],
    });
    state.players[2] = { ...state.players[2], hp: 34, state: 'alive', revive: 0 };
    state.enemiesAlive = 0;
    emitAll();
  },
  affix: () => {
    inGame({ depth: 1, cleared: 1, chamber: 3, chamberKind: 'elite', entered: 'boon', bossKind: 'champion', bossId: 1 });
    state.bossHp = 1;
    emitAll();
    AFFIX_IDS.forEach((affix, i) => fire({ e: 'spawn', id: 40 + i, kind: 'warrior', x: 2, z: -1, elite: true, affix }));
  },
  'party-ult': () => { inGame(); state.players = state.players.map((p) => ({ ...p, ult: 1 })); emitAll(); fire({ e: 'ultReady', slot: 1 }); },
  'draft-legendary': () => {
    solo([{ id: 'infuse_ember_primary', level: 1 }, { id: 'infuse_rime_secondary', level: 1 }, { id: 'amplifier', level: 1 }],
      { phase: 'draft', draftPending: [0], draftTime: 31, chamber: 4 });
    state.enemiesAlive = 0;
    state.draft = [{ id: 'duo_shatter', level: 1 }, { id: 'encore', level: 1 }, { id: 'infuse_umbra_ultimate', level: 1 }];
    emitAll();
  },
  'draft-class': () => {
    heroAs('rogue', 1, [{ id: 'keen_edge', level: 1 }, { id: 'deadeye', level: 1 }]);
    setRun(run({ phase: 'draft', draftPending: [0], draftTime: 27, chamber: 2, oath: 0, entered: 'boon' }));
    state.enemiesAlive = 0;
    state.draft = [{ id: 'rogue_fan', level: 1 }, { id: 'rogue_pierce', level: 2 }, { id: 'momentum', level: 1 }];
    emitAll();
  },
  'draft-5': () => {
    // Cursed door + Foresight: five choices must fit.
    state.profile.meta = { ...state.profile.meta, foresight: 1, insight: 2 };
    solo(SET_BOONS, { phase: 'draft', draftPending: [0], draftTime: 38, chamber: 5, entered: 'cursed' });
    state.enemiesAlive = 0;
    state.draftRerolls = 1;
    state.draft = [
      { id: 'duo_conflagration', level: 1 }, { id: 'giant_slayer', level: 1 }, { id: 'infuse_umbra_secondary', level: 1 },
      { id: 'crescendo', level: 1 }, { id: 'knight_aegis', level: 1 },
    ];
    emitAll();
  },
  'draft-sets': () => {
    solo(SET_BOONS, { phase: 'draft', draftPending: [0], draftTime: 22, chamber: 3 });
    state.enemiesAlive = 0;
    state.draft = [{ id: 'first_blood', level: 1 }, { id: 'echo', level: 1 }, { id: 'keen_edge', level: 3 }, { id: 'opening_act', level: 1 }];
    emitAll();
  },
  ...Object.fromEntries(HUB_TABS.flatMap((tab) => (['new', 'mid', 'end'] as Stage[]).map((stage): [string, () => void] =>
    [`hub-${tab}-${stage}`, () => hub(tab, stage)]))),
  'hub-ascension-locked': () => hub('ascension', 'new'),
  'hub-reliquary-pick': () => { hub('reliquary', 'end'); ui.hubRelic = 'storm_coil'; bus.emit('state:profile'); },
  'hub-reliquary-unknown': () => { hub('reliquary', 'mid'); ui.hubRelic = 'compass'; bus.emit('state:profile'); },
  'hub-mastery-news': () => { stageProfile('mid'); resetMarks(); hub('mastery', 'mid', 'mage'); },
  'hub-lobby': () => { ROUTES.lobby(); ui.hubTab = 'mastery'; ui.page = 'armory'; emitAll(); },

  ...OBJECTIVE_ROUTES,
  ...KEYSTONE_ROUTES,

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
  ['local ultimate', () => { bus.emit('game:localAction', { action: 'ultimate' }); const me = state.players[0]; if (me) me.ult = 0; bus.emit('state:hud'); }],
  ['ult ready own', () => { const me = state.players[0]; if (me) me.ult = 1; bus.emit('state:hud'); fire({ e: 'ultReady', slot: 0 }); }],
  ['ult ready ally', () => fire({ e: 'ultReady', slot: 1 })],
  ['hit umbra', () => fire({ e: 'hit', target: { t: 'e', id: 7 }, ...at, dmg: 22, crit: false, el: 'umbra', by: 0 })],
  ...REACTIONS.map((reaction): [string, () => void] =>
    [`res ${reaction.id}`, () => fire({ e: 'resonance', ...at, r: 3, a: reaction.pair[0], b: reaction.pair[1], by: 0 })]),
  ['buff bloodrage', () => fire({ e: 'buff', slot: 0, id: 'bloodrage', dur: 8 })],
  ['buff bulwark', () => fire({ e: 'buff', slot: 0, id: 'bulwark', dur: 6 })],
  ['buff overload', () => fire({ e: 'buff', slot: 0, id: 'overload', dur: 6 })],
  ...SETS.slice(0, 3).map((set): [string, () => void] => [`set ${set.id}`, () => fire({ e: 'set', slot: 0, id: set.id, tier: 1 })]),
  ['set ally', () => fire({ e: 'set', slot: 1, id: 'set_kinship', tier: 2 })],
  ['descend', () => fire({ e: 'descend', depth: (state.run?.depth ?? 0) + 1 })],
  ...AFFIX_IDS.map((affix): [string, () => void] => [`elite ${affix}`, () => fire({ e: 'spawn', id: 50, kind: 'warrior', ...at, elite: true, affix })]),
  ['zone', () => fire({ e: 'zone', id: 3, kind: 'templar_consecrate', ...at, r: 3.6, dur: 5, el: null, by: 0 })],
  ['zone end', () => fire({ e: 'zoneEnd', id: 3, ...at, sprung: false })],
  ['mark', () => fire({ e: 'mark', id: 7, dur: 8 })],
  ['door descend', () => fire({ e: 'doorChosen', type: 'descend' })],
  ...OBJECTIVE_KINDS.flatMap((kind): [string, () => void][] => [
    [`obj ${kind} start`, () => fire({ e: 'objective', kind, what: 'start' })],
    [`obj ${kind} done+`, () => fire({ e: 'objective', kind, what: 'done', bonus: true })],
    [`obj ${kind} done`, () => fire({ e: 'objective', kind, what: 'done', bonus: false })],
  ]),
  ['obj bonus lost', () => fire({ e: 'objective', kind: state.run?.objective?.kind ?? 'defend', what: 'bonusLost' })],
  ['obj site', () => fire({ e: 'objective', kind: 'ritual', what: 'site', index: 1 })],
  ['obj anchor hit', () => fire({ e: 'objective', kind: 'defend', what: 'anchorHit' })],
  ...NEW_FOES.map((kind): [string, () => void] => [`spawn ${kind}`, () => fire({ e: 'spawn', id: 60, kind, ...at, elite: false })]),
  ...ELEMENT_IDS.map((ward): [string, () => void] => [`ward ${ward}`, () => fire({ e: 'spawn', id: 61, kind: 'warrior', ...at, elite: false, ward })]),
  ['dome on', () => fire({ e: 'dome', id: 60, on: true, r: 4.5 })],
  ['mend', () => fire({ e: 'mend', id: 60, targets: [7, 8] })],
  ['door ascend', () => fire({ e: 'doorChosen', type: 'ascend' })],
  ...Object.values(CLASSES).flatMap((def): [string, () => void][] => [
    [`${def.id} art`, () => fire({ e: 'cast', who: { t: 'p', id: 1 }, ability: def.arts[0]?.id ?? def.secondary.id, ...at, rot: 0 })],
    [`${def.id} ultimate`, () => fire({ e: 'cast', who: { t: 'p', id: 1 }, ability: def.ultimate.id, ...at, rot: 0 })],
  ]),
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
        mastery: levelFromXp(state.profile.xp[state.profile.cls] ?? 0).level, art: state.profile.arts[state.profile.cls] ?? 0,
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
    me.mastery = levelFromXp(state.profile.xp[me.cls] ?? 0).level;
    me.art = me.mastery >= 2 ? state.profile.arts[me.cls] ?? 0 : 0;
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
    if (patch.cls) {
      me.cls = patch.cls;
      me.mastery = levelFromXp(state.profile.xp[me.cls] ?? 0).level;
      me.art = me.mastery >= 2 ? state.profile.arts[me.cls] ?? 0 : 0;
    }
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
  bus.on('ui:pick', ({ index, replace }) => {
    window.setTimeout(() => {
      if (!state.run || state.run.phase !== 'draft') return;
      // Stand-in for the server's keystone draft: take / replace, or the consolation draft after "keep my build".
      const ks = state.draftKeystone;
      const me = state.roster.find((p) => p.slot === state.conn.slot);
      if (ks && index === ks.skip) {
        state.draftKeystone = null;
        state.draft = [{ id: 'afterimage', level: 1, fits: ['dash', 'area'] }, { id: 'deadeye', level: 2 }, { id: 'overkill', level: 1, fits: ['area'] }];
        bus.emit('state:draft');
        return;
      }
      if (ks && me && state.draft[index]) {
        const id = state.draft[index].id;
        me.keystones = [...me.keystones.filter((k) => k !== replace), id];
        state.draftKeystone = null;
        bus.emit('state:roster');
        fire({ e: 'keystone', slot: me.slot, id, ...(replace ? { replaced: replace } : {}) });
      }
      state.draftKeystone = null;
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
      if (me.ult < 1) me.ult = Math.min(1, me.ult + 0.004);
    }
    bus.emit('state:hud');
  }, HUD_TICK_MS);
  window.setInterval(() => {
    const r = state.run;
    if (state.screen !== 'game' || !r || params.get('freeze') !== null) return;
    r.elapsed += RUN_TICK_MS / 1000;
    if (r.phase === 'draft') r.draftTime = Math.max(0, r.draftTime - RUN_TICK_MS / 1000);
    const o = r.objective;
    if (r.phase === 'combat' && o && o.status === 'active') {
      // Objective timers run down and the measures creep, so the tracker can be watched live.
      if (o.timeLeft > 0) o.timeLeft = Math.max(0, o.timeLeft - RUN_TICK_MS / 1000);
      if (o.kind === 'survive' || o.kind === 'vault') o.progress = Math.min(1, o.progress + 0.004);
      for (const site of o.sites) if (!site.lit && site.progress > 0) site.progress = Math.min(0.98, site.progress + 0.006);
    }
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

const CLASS_TINT: Record<ClassId, string> = {
  knight: '#7fa9e6', barbarian: '#e2584b', mage: '#e391d8', rogue: '#86d06c', templar: '#f0dc9a', spellblade: '#8f9bff', shade: '#9db0cf',
};

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
      /** Data ids without an English or German text, and German texts whose numbers drifted. Must be empty. */
      missing(): string[];
      /** Changes fields of the fake run and announces it (scripted checks of live HUD states). */
      patchRun(patch: Partial<RunState>): void;
      /** Switches the screen without resetting the session (e.g. game -> summary at the end of a scripted run). */
      screen(screen: Screen): void;
      /** Every `ui:*` intent emitted so far, as "name payload". */
      intents: string[];
      labels: EventMap['ui:labels'][];
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
  // What the 3D view would receive: kept for scripted checks (`__uidemo.labels`).
  bus.on('ui:labels', (labels) => { labelLog.push(labels); });
  initUI(root);
  startAudio();
  wireIntents();
  startTickers();
  buildPanel();
  // Unit-like check: every class, boon, talent, relic, feat, set, reaction, affix, upgrade and Ascension stat has its texts.
  const missing = missingTexts();
  if (missing.length > 0) console.error(`[uidemo] ${missing.length} missing or drifted texts:\n${missing.join('\n')}`);
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
    missing: missingTexts,
    patchRun: (patch) => { if (state.run) { setRun({ ...state.run, ...patch }); bus.emit('state:hud'); } },
    screen: (screen) => { setScreen(screen); emitAll(); },
    intents: intentLog,
    labels: labelLog,
    routes: Object.keys(ROUTES),
    errors: CONN_ERRORS,
  };
}

boot();
