/**
 * Dev-only render kit showcase (http://localhost:5174/?showcase). No network: a scripted loop feeds fake snapshot
 * rows and GameEvents through every feature of WorldView.
 *
 * Keys: 1/2/3 chamber kind · 4/5/6 biome · B boss · L random looks · M menu showcase (cycles class + looks) · T marker
 *       C old / new classes · X next depth of the endless descent
 *       Q quality · S stress mode · D doors · Z zoom · N damage numbers · F focus cycle · P pause
 * URL:  ?showcase&kind=boss&biome=forge&boss=stalker&quality=medium&mode=stress&focus=boss&freeze=4.5
 *       &looks=1 (varied looks) &same=knight (all four slots one class) &menu=mage&look=3,1,1,2&sx=0.7 &marker=0
 * Update 3:
 *       &classes=templar,spellblade,shade,knight (who stands in the four slots; default = the four old classes, &new=1 = the new ones)
 *       &depth=2 (endless descent mood) &focus=x,z,zoom (free camera, e.g. focus=0,3,0.5)
 *       &demo=NAME&at=1 (a calm stage where one thing happens at `at` seconds; combine with freeze= to capture it):
 *         art | ult | primary   every hero uses that ability at once
 *         zones                 consecrate, sanctuary, bolt storm, smoke, an armed and a sprung snare, the three buffs
 *         reactions             the six named reactions in two rows of three (REACTION_IDS order, top left first)
 *         umbra                 withered enemies, umbra-tinted projectiles, umbra infusions
 *         affix                 four elites with the four affixes; the volatile one dies and announces its blast
 *         doors                 a descend and an ascend door
 *         ready                 every hero with a full ultimate charge
 *         lineup                the four heroes shoulder to shoulder (use with face=south&focus=0,5.4,0.24)
 * Update 4:
 *       demo=horde      the nine rank-and-file kinds in a row (old four left, new five right), idle
 *       demo=hordeact   the five new kinds each do their thing at `at`: mend channel and heal, ward dome with a telegraph
 *                       inside, a bomber's fuse and a slain bomber's delayed burst, a raise with tethered minions, a leap
 *       demo=wards      four warded enemies (ember, rime, storm, umbra); at `at` each is hit with its own element
 *       demo=dome       an aegis with its dome up, enemies inside, hostile telegraphs across it; &drop=1 drops it at `at`
 *       demo=mend       a shaman mends four wounded enemies at `at`; &interrupt=1 staggers it (and a mage) mid-windup instead
 *       demo=objective&obj=defend|ritual|hunt|survive|vault&prog=0..1 [&objdone=1] [&bonus=0]
 *                       the objective in that state; defend: prog = shard health, heroes stand next to it;
 *                       ritual: prog 0.5 = one lit, one half filled, one untouched; hunt: bonus=0 = enraged
 *       demo=objdoors   doors with objective emblems (&set=1 for the second set)
 *       stress mode now includes the five new kinds, wards, a dome and (obj=) an objective; default obj=defend
 * Polish 1:
 *       mode=fight[&at=6]  the stress scene as a real brawl: the party in a knot at the shard, area hits on many enemies at
 *                       once, and at `at` four ultimates + a chain of ten reactions under hostile telegraphs
 *       seed=N          reproducible script (same moment before / after a rendering change) · local=0..3 own hero's slot
 */
import { AnimationMixer, Vector3 } from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { loadAssets, WorldView } from '../render/index.ts';
import type { Assets } from '../render/index.ts';
import { AFFIX_IDS, BIOME_IDS, BOSS_KINDS, CLASS_IDS, EF, ELEMENT_IDS, OBJECTIVE_KINDS, PF } from '@shared/types.ts';
import type {
  BiomeId, BossKind, ClassId, Door, ElementId, EnemyAnim, EnemyKind, EnemySnap, GameEvent, Hazard, Look, ObjectiveKind, ObjectiveState, Obstacle, PlayerAnim,
  PlayerSnap, ProjectileKind, ProjectileSnap, RoomLayout,
} from '@shared/types.ts';
import { OBJECTIVE_TUNING } from '@shared/data/objectives.ts';
import type { ChamberKind } from '@shared/constants.ts';
import { CLASSES, DASH, ULTIMATE } from '@shared/data/classes.ts';
import type { AbilityDef } from '@shared/data/classes.ts';
import { REACTIONS } from '@shared/data/reactions.ts';
import { ENEMY_TUNING, STATUS } from '@shared/data/enemies.ts';
import { DEFAULT_LOOK, LOOK } from '@shared/data/meta.ts';
import { NET, WORLD } from '@shared/constants.ts';
import { enemyDef } from '../render/config.ts';
import type { Quality } from '../core/Settings.ts';

const DEG = Math.PI / 180;
/**
 * The script's own random numbers (mulberry32). With &seed=N a run is reproducible whatever the render kit does with
 * Math.random, so the same moment can be captured before and after a rendering change.
 */
let rndState = (Date.now() ^ 0x9e3779b9) >>> 0;
function rnd(): number {
  rndState = (rndState + 0x6d2b79f5) >>> 0;
  let t = rndState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
let NORTH = Math.PI;
const QUALITIES: Quality[] = ['low', 'medium', 'high'];
const KINDS: ChamberKind[] = ['combat', 'elite', 'boss'];
const ROOM_SIZE: Record<ChamberKind, { w: number; d: number }> = {
  combat: { w: 28, d: 20 }, elite: { w: 30, d: 22 }, boss: { w: 36, d: 26 },
};
const NAMES = ['Aldric', 'Brunhild', 'Cyrene', 'Dax'];
const SLOTS = NET.MAX_PLAYERS;
const OLD_CLASSES: ClassId[] = ['knight', 'barbarian', 'mage', 'rogue'];
const NEW_CLASSES: ClassId[] = ['templar', 'spellblade', 'shade', 'mage'];
const DEMOS = ['art', 'ult', 'primary', 'zones', 'reactions', 'umbra', 'affix', 'doors', 'ready', 'lineup',
  'horde', 'hordeact', 'wards', 'dome', 'mend', 'objective', 'objdoors'] as const;
const HORDE_KINDS: EnemyKind[] = ['shaman', 'aegis', 'bomber', 'necromancer', 'reaver'];
const OLD_KINDS: EnemyKind[] = ['minion', 'warrior', 'archer', 'mage'];
const HT = ENEMY_TUNING;
type Demo = (typeof DEMOS)[number];
/** Zone / trap / buff line-up of the `zones` demo: [ability id, x]. */
const ZONE_DEMO: [string, number][] = [['templar_consecrate', -12], ['templar_sanctuary', -4.5], ['rogue_volley', 5], ['shade_smoke', 12.5]];

const BIOME_BOSS: Record<BiomeId, BossKind> = { crypt: 'regent', flooded: 'matron', forge: 'stalker' };
const HAZARD_KINDS: Hazard['kind'][] = ['spikes', 'vent', 'frost'];
/** Fixed, deliberately varied looks (one per slot) for screenshots; L randomises instead. */
const LOOK_SET: Look[] = [
  { color: 2, head: true, cape: true, style: 1 }, { color: 4, head: false, cape: true, style: 2 },
  { color: 6, head: true, cape: false, style: 1 }, { color: 9, head: true, cape: true, style: 2 },
];

function sampleRoom(kind: ChamberKind, biome: BiomeId): RoomLayout {
  const { w, d } = ROOM_SIZE[kind];
  const hw = w / 2;
  const hd = d / 2;
  const themed: Obstacle['kind'][] = biome === 'flooded' ? ['sarcophagus', 'stalagmite', 'crystal', 'column']
    : biome === 'forge' ? ['anvil', 'brazier', 'barrels', 'crystal'] : ['barrels', 'crates', 'rubble', 'column'];
  const obstacles: Obstacle[] = kind === 'boss'
    ? [
      { x: -hw + 6, z: -hd + 6, r: 0.9, kind: 'pillar' }, { x: hw - 6, z: -hd + 6, r: 0.9, kind: 'pillar' },
      { x: -hw + 6, z: hd - 6, r: 0.9, kind: biome === 'crypt' ? 'pillar' : themed[1] }, { x: hw - 6, z: hd - 6, r: 0.9, kind: biome === 'crypt' ? 'pillar' : themed[0] },
      { x: -hw + 3, z: 0, r: 0.7, kind: 'brazier' }, { x: hw - 3, z: 0, r: 0.7, kind: 'brazier' },
    ]
    : [
      { x: -hw + 5, z: -hd + 5, r: 0.9, kind: 'pillar' }, { x: hw - 5, z: -hd + 5, r: 0.9, kind: 'pillar' },
      { x: -hw + 3.2, z: 1.5, r: 1.1, kind: themed[0] }, { x: hw - 3.4, z: 2.5, r: 0.95, kind: themed[1] },
      { x: hw - 4.4, z: -1.5, r: 0.6, kind: biome === 'crypt' ? 'barrels' : themed[2] }, { x: -hw + 6.5, z: hd - 3.2, r: 1.25, kind: themed[2] },
      { x: hw - 7, z: hd - 3, r: 0.7, kind: 'brazier' }, { x: -3.5, z: hd - 2.6, r: 0.45, kind: 'column' },
      { x: 4.5, z: hd - 2.4, r: 1.2, kind: themed[biome === 'crypt' ? 1 : 0] }, { x: -hw + 2.6, z: -3.5, r: 0.8, kind: themed[3] },
      { x: hw - 2.6, z: -6, r: 1.0, kind: biome === 'crypt' ? 'crates' : 'crystal' },
    ];
  // eight hazards spread over the cycle, so idle, warn and active are all on screen at any moment
  const hazards: Hazard[] = [];
  for (let i = 0; i < 8; i++) {
    hazards.push({ x: -10.5 + i * 2.9, z: i % 2 === 0 ? 1.1 : 3.0, r: 1.15 + (i % 3) * 0.15, kind: HAZARD_KINDS[i % 3], period: 5.6, phase: i / 8 });
  }
  const spawns = [-3, -1, 1, 3].map((x) => ({ x, z: hd - 2 }));
  return { seed: (kind === 'combat' ? 1337 : kind === 'elite' ? 4242 : 9001) + BIOME_IDS.indexOf(biome) * 77, biome, w, d, obstacles, hazards, spawns };
}

// ------------------------------------------------------------------------------------------------ script state

interface HeroActor { snap: PlayerSnap; cls: ClassId; homeX: number; homeZ: number; step: number; t: number; offset: number }
interface EnemyActor {
  snap: EnemySnap; homeX: number; homeZ: number; step: number; t: number; cycle: number; gone: number;
  script: EnemyStep[]; statusDemo: boolean; slamCount: number;
  leapBack: boolean; fromX: number; fromZ: number; toX: number; toZ: number;
}
interface EnemyStep { anim: EnemyAnim; dur: number }
interface Shot { snap: ProjectileSnap; vx: number; vz: number; life: number; speed: number; seek: number }

const HERO_STEPS: { anim: PlayerAnim; dur: number }[] = [
  { anim: 'idle', dur: 1.0 }, { anim: 'run', dur: 1.7 }, { anim: 'primary1', dur: 0.55 }, { anim: 'primary2', dur: 0.55 },
  { anim: 'primary3', dur: 0.75 }, { anim: 'idle', dur: 0.35 }, { anim: 'secondary', dur: 1.45 }, { anim: 'idle', dur: 0.35 },
  { anim: 'art', dur: 1.5 }, { anim: 'idle', dur: 0.5 }, { anim: 'ultimate', dur: 2.2 }, { anim: 'idle', dur: 0.4 },
  { anim: 'dash', dur: 0.3 }, { anim: 'idle', dur: 0.45 }, { anim: 'hit', dur: 0.6 }, { anim: 'idle', dur: 0.3 },
  { anim: 'downed', dur: 3.4 }, { anim: 'cheer', dur: 1.7 },
];

const MT = ENEMY_TUNING.MATRON;
const ST = ENEMY_TUNING.STALKER;
const BEAM_STEPS = 3;
const FRENZY_SHOTS = 5;

function enemyScript(kind: EnemyKind): EnemyStep[] {
  const def = enemyDef(kind);
  if (kind === 'matron') {
    return [
      { anim: 'spawn', dur: def.spawnTime + 0.15 }, { anim: 'idle', dur: 0.8 }, { anim: 'move', dur: 2.2 },
      { anim: 'volley', dur: MT.RING_WINDUP + 1.0 }, { anim: 'attack', dur: 0.6 },
      { anim: 'beam', dur: (BEAM_STEPS - 1) * MT.BEAM_INTERVAL + MT.BEAM_WINDUP }, { anim: 'attack', dur: 0.7 },
      { anim: 'cast', dur: MT.WISP_WINDUP }, { anim: 'attack', dur: 0.8 }, { anim: 'summon', dur: 1.5 }, { anim: 'attack', dur: 0.5 },
      { anim: 'slam', dur: 1.0 }, { anim: 'idle', dur: 0.4 }, { anim: 'stun', dur: 1.2 }, { anim: 'idle', dur: 1.2 }, { anim: 'death', dur: 2.6 },
    ];
  }
  if (kind === 'stalker') {
    return [
      { anim: 'spawn', dur: def.spawnTime + 0.15 }, { anim: 'idle', dur: 0.8 }, { anim: 'move', dur: 2.0 },
      { anim: 'volley', dur: ST.FAN_WINDUP }, { anim: 'attack', dur: 0.6 }, { anim: 'windup', dur: ST.SPEAR_WINDUP }, { anim: 'attack', dur: 0.7 },
      { anim: 'leap', dur: ST.LEAP_AIR_TIME }, { anim: 'attack', dur: 0.7 }, { anim: 'volley', dur: (FRENZY_SHOTS - 1) * ST.FRENZY_INTERVAL + ST.FRENZY_WINDUP },
      { anim: 'attack', dur: 0.6 }, { anim: 'leap', dur: ST.LEAP_AIR_TIME }, { anim: 'attack', dur: 0.5 }, { anim: 'charge', dur: 1.5 }, { anim: 'cast', dur: 0.6 },
      { anim: 'idle', dur: 0.5 }, { anim: 'stun', dur: 1.2 }, { anim: 'idle', dur: 1.2 }, { anim: 'death', dur: 2.6 },
    ];
  }
  const spawn: EnemyStep = { anim: 'spawn', dur: def.spawnTime + 0.15 };
  const end: EnemyStep[] = [{ anim: 'stun', dur: 1.2 }, { anim: 'idle', dur: 0.8 }, { anim: 'death', dur: 2.6 }];
  if (kind === 'shaman') {
    // hex bolt, then the mend channel (announced as `cast` with the ability id `mend`)
    return [spawn, { anim: 'idle', dur: 0.8 }, { anim: 'move', dur: 1.8 }, { anim: 'windup', dur: def.windup }, { anim: 'attack', dur: 0.7 },
      { anim: 'idle', dur: 0.5 }, { anim: 'cast', dur: HT.SHAMAN.MEND_WINDUP }, { anim: 'attack', dur: 0.8 }, { anim: 'idle', dur: 0.6 }, ...end];
  }
  if (kind === 'aegis') {
    return [spawn, { anim: 'idle', dur: 1.6 }, { anim: 'move', dur: 2.2 }, { anim: 'windup', dur: def.windup }, { anim: 'attack', dur: 0.7 }, { anim: 'idle', dur: 1.2 }, ...end];
  }
  if (kind === 'bomber') {
    // odd cycles: slain on the run (delayed burst); even cycles: the fuse runs out
    return [spawn, { anim: 'idle', dur: 0.6 }, { anim: 'move', dur: 1.8 }, { anim: 'windup', dur: def.windup }, { anim: 'attack', dur: 0.05 }];
  }
  if (kind === 'necromancer') {
    return [spawn, { anim: 'idle', dur: 1.0 }, { anim: 'move', dur: 1.8 }, { anim: 'summon', dur: def.windup }, { anim: 'attack', dur: 0.6 }, { anim: 'idle', dur: 3.2 }, ...end];
  }
  if (kind === 'reaver') {
    return [spawn, { anim: 'idle', dur: 0.8 }, { anim: 'move', dur: 1.6 }, { anim: 'leap', dur: HT.REAVER.LEAP_AIR_TIME }, { anim: 'windup', dur: def.windup },
      { anim: 'attack', dur: 0.6 }, { anim: 'idle', dur: 0.4 }, { anim: 'leap', dur: HT.REAVER.LEAP_AIR_TIME }, { anim: 'idle', dur: 0.6 }, ...end];
  }
  const base: EnemyStep[] = [
    spawn, { anim: 'idle', dur: 0.8 }, { anim: 'move', dur: 1.8 },
    { anim: 'windup', dur: def.windup }, { anim: 'attack', dur: 0.7 }, { anim: 'idle', dur: 0.4 },
    { anim: 'windup', dur: def.windup }, { anim: 'cast', dur: 0.7 }, { anim: 'stun', dur: 1.3 },
  ];
  if (kind === 'champion' || kind === 'regent') {
    const t = kind === 'regent' ? ENEMY_TUNING.REGENT : ENEMY_TUNING.CHAMPION;
    base.push({ anim: 'sweep', dur: def.windup + 0.7 }, { anim: 'idle', dur: 0.3 }, { anim: 'charge', dur: t.CHARGE_WINDUP + 0.9 },
      { anim: 'idle', dur: 0.3 }, { anim: 'summon', dur: 2.0 });
  }
  if (kind === 'regent') {
    const r = ENEMY_TUNING.REGENT;
    base.push({ anim: 'volley', dur: r.VOLLEY_WINDUP + 0.8 }, { anim: 'slam', dur: r.SLAM_WINDUP }, { anim: 'slam', dur: r.SLAM_INTERVAL },
      { anim: 'slam', dur: r.SLAM_INTERVAL + 0.5 });
  }
  base.push({ anim: 'idle', dur: 0.5 }, { anim: 'death', dur: 2.6 });
  return base;
}

/** mode=fight: hero formation [x, z], volley rhythm and the hostile warnings laid across the climax [x, z, r]. */
const FIGHT = {
  HEROES: [[-1.6, 3.4], [1.8, 2.6], [-3.4, 1.2], [3.2, 0.6]],
  VOLLEY_EVERY: 0.16,
  VOLLEY_RADIUS: 4.2,
  DAMAGE: [13, 43, 243, 346],
  LEAD: 0.7,
  TELEGRAPH: 3.2,
  CIRCLES: [[-2.2, 2.6, 2.4], [3.6, -1.8, 2.8], [-5.5, -3, 2.2]],
  CHAIN: 10,
} as const;

const FLAG_DEMOS = [EF.BURN, EF.CHILL, EF.SHOCK, EF.WITHER, EF.STUNNED, EF.SHIELDED, EF.ENRAGED, EF.BURN | EF.SHIELDED, EF.CHILL | EF.SHOCK | EF.ENRAGED, EF.WITHER | EF.BURN, 0];
const STATUS_BIT: Record<ElementId, number> = { ember: EF.BURN, rime: EF.CHILL, storm: EF.SHOCK, umbra: EF.WITHER };
const ANY_STATUS = EF.BURN | EF.CHILL | EF.SHOCK | EF.WITHER;
const PROJECTILE_DEMO: { kind: ProjectileKind; hostile: boolean }[] = [
  { kind: 'arcBolt', hostile: false }, { kind: 'crossbowBolt', hostile: false }, { kind: 'knife', hostile: false },
  { kind: 'boneArrow', hostile: true }, { kind: 'hexOrb', hostile: true },
  { kind: 'boneSpear', hostile: true }, { kind: 'soulWisp', hostile: true },
  { kind: 'shieldDisc', hostile: false }, { kind: 'bladeWave', hostile: false }, { kind: 'shadowDagger', hostile: false },
];
/** One pair per named reaction, in REACTION_IDS order. */
const ELEMENT_PAIRS: [ElementId, ElementId][] = REACTIONS.map((r) => [r.pair[0], r.pair[1]]);

class Showcase {
  private readonly view: WorldView;
  private kind: ChamberKind = 'combat';
  private biome: BiomeId = 'crypt';
  private boss: BossKind | null = null;
  private looks: Look[] = OLD_CLASSES.map(() => ({ ...DEFAULT_LOOK }));
  private classes: ClassId[] = [...OLD_CLASSES];
  private demo: Demo | null = null;
  /** Update 4: objective shown by the objective demo / stress mode, its progress knob, and extra switches. */
  private obj: ObjectiveKind = 'defend';
  private objProg = 0.5;
  private objDone = false;
  private objBonus = true;
  private objective: ObjectiveState | null = null;
  private doorSet = 0;
  private drop = false;
  private interrupt = false;
  /** Minions raised by the scripted necromancers: [necromancer actor, minion actor]. */
  private raised: [EnemyActor, EnemyActor][] = [];
  private demoAt = 1;
  private demoDone = false;
  private depth = 0;
  private focusFree: { x: number; z: number; zoom: number } | null = null;
  private menu = false;
  private menuCls = 0;
  private menuLook: Look = { ...DEFAULT_LOOK };
  private menuAuto = true;
  private menuTimer = 0;
  private menuX = 0.7;
  private markerOn = true;
  /** No random chip damage (clean close-ups). */
  private calm = false;
  private quality: Quality = 'high';
  private stress = false;
  /** Polish 1: `mode=fight`, a four-hero brawl in a special-objective chamber with a scripted climax at `at`. */
  private fight = false;
  private fightDone = false;
  private fightHit = 0;
  /** Slot the view treats as the own hero. */
  private local = 0;
  private doorsOn = true;
  private paused = false;
  private zoom = 1;
  private numbers = true;
  private time = 0;
  private nextId = 1;
  private room: RoomLayout = sampleRoom('combat', 'crypt');
  private heroes: HeroActor[] = [];
  private enemies: EnemyActor[] = [];
  private shots: Shot[] = [];
  private pending: { at: number; fn: () => void }[] = [];
  private readonly playerRows: PlayerSnap[] = [];
  private readonly enemyRows: EnemySnap[] = [];
  private readonly projectileRows: ProjectileSnap[] = [];
  private doors: Door[] = [];
  private doorProgress: number[] = [];
  private timers = { tele: 0, reso: 0, shot: 0, event: 0, hit: 0, stressFx: 0 };
  private counters = { tele: 0, reso: 0, shot: 0, event: 0, flag: 0 };
  private focusIndex = -1;
  private focusName = '';
  private freezeAt = Infinity;
  frozen = false;
  private readonly overlay: HTMLDivElement;
  private jsMs = 0;
  private frameMs = 16;
  private last = performance.now();

  constructor(view: WorldView) {
    this.view = view;
    this.overlay = document.createElement('div');
    this.overlay.style.cssText = 'position:fixed;left:8px;top:8px;padding:6px 9px;font:12px/1.45 ui-monospace,Menlo,Consolas,monospace;'
      + 'color:#cfe;background:rgba(6,8,14,.72);border:1px solid rgba(125,255,180,.25);border-radius:4px;white-space:pre;pointer-events:none;z-index:10';
    document.body.appendChild(this.overlay);

    const params = new URLSearchParams(window.location.search);
    const kind = params.get('kind') as ChamberKind | null;
    if (kind && KINDS.includes(kind)) this.kind = kind;
    const quality = params.get('quality') as Quality | null;
    if (quality && QUALITIES.includes(quality)) this.quality = quality;
    this.fight = params.get('mode') === 'fight';
    this.stress = params.get('mode') === 'stress' || this.fight;
    if (params.has('seed')) rndState = Number(params.get('seed')) >>> 0;
    this.local = Math.max(0, Math.min(SLOTS - 1, Number(params.get('local') ?? 0) || 0));
    if (this.fight && !params.has('classes')) this.classes = ['mage', 'templar', 'spellblade', 'barbarian'];
    if (this.fight && !params.has('at')) this.demoAt = 6;
    if (params.has('freeze')) this.freezeAt = Number(params.get('freeze'));
    if (params.has('zoom')) this.zoom = Number(params.get('zoom'));
    if (params.get('doors') === '0') this.doorsOn = false;
    if (params.get('overlay') === '0') this.overlay.style.display = 'none';
    this.focusName = params.get('focus') ?? '';
    if (params.get('face') === 'south') NORTH = 0;
    const biome = params.get('biome') as BiomeId | null;
    if (biome && BIOME_IDS.includes(biome)) this.biome = biome;
    const boss = params.get('boss') as BossKind | null;
    if (boss && BOSS_KINDS.includes(boss)) this.boss = boss;
    if (params.has('looks')) this.looks = LOOK_SET.map((l) => ({ ...l }));
    const same = params.get('same') as ClassId | null;
    if (params.has('new')) this.classes = [...NEW_CLASSES];
    const list = (params.get('classes') ?? '').split(',').filter((c): c is ClassId => CLASS_IDS.includes(c as ClassId));
    if (list.length > 0) this.classes = OLD_CLASSES.map((_, i) => list[i % list.length]);
    const demo = params.get('demo') as Demo | null;
    if (demo && DEMOS.includes(demo)) { this.demo = demo; this.calm = true; this.markerOn = false; this.doorsOn = demo === 'doors' || demo === 'objdoors'; }
    const obj = params.get('obj') as ObjectiveKind | null;
    if (obj && OBJECTIVE_KINDS.includes(obj)) this.obj = obj;
    if (params.has('prog')) this.objProg = Number(params.get('prog'));
    this.objDone = params.get('objdone') === '1';
    this.objBonus = params.get('bonus') !== '0';
    this.doorSet = Number(params.get('set') ?? 0);
    this.drop = params.get('drop') === '1';
    this.interrupt = params.get('interrupt') === '1';
    if (params.has('at')) this.demoAt = Number(params.get('at'));
    if (params.has('depth')) this.depth = Number(params.get('depth'));
    const free = (params.get('focus') ?? '').split(',').map(Number);
    if (free.length === 3 && free.every(Number.isFinite)) { this.focusFree = { x: free[0], z: free[1], zoom: free[2] }; this.focusName = ''; }
    if (same && CLASS_IDS.includes(same)) {
      this.classes = OLD_CLASSES.map(() => same);
      // one class, four outfits: default, then the three gear styles with different colours / head / cape
      this.looks = [{ ...DEFAULT_LOOK }, { color: 2, head: true, cape: true, style: 1 }, { color: 4, head: false, cape: true, style: 2 }, { color: 7, head: true, cape: false, style: 0 }];
    }
    if (params.get('marker') === '0') this.markerOn = false;
    this.calm = params.has('calm') || this.demo !== null;
    if (params.has('sx')) this.menuX = Number(params.get('sx'));
    const menu = params.get('menu') as ClassId | null;
    if (menu !== null) {
      this.menu = true;
      if (CLASS_IDS.includes(menu)) { this.menuCls = CLASS_IDS.indexOf(menu); this.menuAuto = false; }
      const look = (params.get('look') ?? '').split(',').map(Number);
      if (look.length === 4 && look.every(Number.isFinite)) this.menuLook = { color: look[0], head: look[1] !== 0, cape: look[2] !== 0, style: look[3] };
    }

    view.setQuality(this.quality);
    view.setZoom(this.zoom);
    this.reset();
    if (Number.isFinite(this.freezeAt)) this.setFastForward(true);

    window.addEventListener('resize', () => view.resize());
    window.addEventListener('keydown', (e) => this.key(e.key.toLowerCase()));
    window.addEventListener('mousemove', (e) => { view.screenToGround(e.clientX, e.clientY, this.cursor); });
    requestAnimationFrame(this.frame);
  }

  private readonly cursor = { x: 0, z: 0 };

  private randomLook(): Look {
    return { color: Math.floor(rnd() * LOOK.COLORS.length), head: rnd() < 0.7, cape: rnd() < 0.7, style: Math.floor(rnd() * LOOK.STYLES) };
  }

  private applyRoster(): void {
    this.view.setRoster(this.classes.map((cls, slot) => ({ slot, cls, name: NAMES[slot], look: this.looks[slot], art: 1 })));
    if (this.demo === 'umbra') {
      for (let slot = 0; slot < SLOTS; slot++) this.view.setInfusions(slot, { primary: 'umbra', secondary: 'umbra', dash: 'umbra', ultimate: 'umbra' });
      return;
    }
    if (this.demo) {
      // the ability demos show every class in its own colours
      for (let slot = 0; slot < SLOTS; slot++) this.view.setInfusions(slot, { primary: null, secondary: null, dash: null, ultimate: null });
      return;
    }
    // infusion demo: ember blade, rime secondary, storm bolts + storm dash, ember dash + umbra ultimate
    this.view.setInfusions(0, { primary: 'ember', secondary: null, dash: null, ultimate: null });
    this.view.setInfusions(1, { primary: null, secondary: 'rime', dash: null, ultimate: null });
    this.view.setInfusions(2, { primary: 'storm', secondary: null, dash: 'storm', ultimate: null });
    this.view.setInfusions(3, { primary: 'umbra', secondary: null, dash: 'ember', ultimate: 'umbra' });
  }

  private applyMenu(): void {
    this.view.setShowcase(this.menu ? { cls: CLASS_IDS[this.menuCls], look: this.menuLook, screenX: this.menuX } : null);
  }

  private key(k: string): void {
    if (k === '1' || k === '2' || k === '3') { this.kind = KINDS[Number(k) - 1]; this.reset(); }
    else if (k === '4' || k === '5' || k === '6') { this.biome = BIOME_IDS[Number(k) - 4]; this.reset(); }
    else if (k === 'b') { this.boss = BOSS_KINDS[(BOSS_KINDS.indexOf(this.boss ?? BIOME_BOSS[this.biome]) + 1) % BOSS_KINDS.length]; this.reset(); }
    else if (k === 'c') { this.classes = this.classes[0] === OLD_CLASSES[0] ? [...NEW_CLASSES] : [...OLD_CLASSES]; this.reset(); }
    else if (k === 'x') { this.depth = (this.depth + 1) % 5; this.view.setDepth(this.depth); }
    else if (k === 'l') { this.looks = this.looks.map(() => this.randomLook()); this.applyRoster(); }
    else if (k === 'm') { this.menu = !this.menu; this.menuAuto = true; this.menuTimer = 0; this.reset(); }
    else if (k === 't') this.markerOn = !this.markerOn;
    else if (k === 'q') { this.quality = QUALITIES[(QUALITIES.indexOf(this.quality) + 1) % QUALITIES.length]; this.view.setQuality(this.quality); }
    else if (k === 's') { this.stress = !this.stress; this.reset(); }
    else if (k === 'd') this.doorsOn = !this.doorsOn;
    else if (k === 'p') this.paused = !this.paused;
    else if (k === 'z') { this.zoom = this.zoom >= 1.3 ? 0.8 : this.zoom + 0.25; this.view.setZoom(this.zoom); }
    else if (k === 'n') { this.numbers = !this.numbers; this.view.setDamageNumbers(this.numbers); }
    else if (k === 'f') { this.focusIndex = this.focusIndex >= 10 ? -1 : this.focusIndex + 1; this.focusName = this.focusIndex < 0 ? '' : this.focusIndex < 4 ? `hero${this.focusIndex}` : `enemy${this.focusIndex - 4}`; }
  }

  private reset(): void {
    this.room = sampleRoom(this.kind, this.biome);
    // demo stages are bare: no hazards, only the corner pillars
    if (this.demo) { this.room.hazards = []; this.room.obstacles = this.room.obstacles.filter((o) => o.kind === 'pillar'); }
    this.view.clearSession();
    this.view.setDepth(this.depth);
    this.demoDone = false;
    this.fightDone = false;
    this.fightHit = 0.3;
    this.applyRoster();
    this.applyMenu();
    this.view.setRoom(this.menu ? null : this.room, this.kind, KINDS.indexOf(this.kind) * 3);
    this.view.setMarker(this.markerOn && !this.stress ? { x: 0, z: this.room.d / 2 - 1.6, r: 1.4 } : null);
    this.time = 0;
    this.frozen = false;
    this.heroes = [];
    this.enemies = [];
    this.shots = [];
    this.pending = [];
    this.raised = [];
    this.objective = null;
    this.timers = { tele: 0.5, reso: 1.2, shot: 0.3, event: 2, hit: 0.4, stressFx: 0 };
    const hd = this.room.d / 2;
    this.classes.forEach((cls, slot) => {
      const homeX = this.fight ? FIGHT.HEROES[slot][0] : this.stress ? [-5, 5, -2, 2][slot] : -6 + slot * 4;
      const homeZ = this.fight ? FIGHT.HEROES[slot][1] : this.stress ? [2, 2, 5, 5][slot] : hd - 4.5;
      const maxHp = CLASSES[cls].maxHp;
      this.heroes.push({
        cls, homeX, homeZ, step: -1, t: 0, offset: slot * 0.95,
        snap: {
          slot, x: homeX, z: homeZ, rot: NORTH, hp: maxHp * (1 - slot * 0.18), maxHp, shield: slot === 0 ? 20 : 0, state: 'alive', anim: 'idle', animSeq: 0,
          cdSecondary: 0, cdDash: 0, ult: this.demo === 'ready' ? 1 : 0, dashCharges: 1, revive: 0,
          flags: PF.CONNECTED | (slot === 2 && !this.demo ? PF.KINDRED_AURA : 0),
        },
      });
    });
    if (this.demo) {
      for (const h of this.heroes) { h.snap.hp = h.snap.maxHp; h.snap.shield = 0; }
      this.setupDemo();
    } else if (this.stress) {
      // 44 enemies as before, a third of them the update 4 kinds; every fifth one warded
      const mix: EnemyKind[] = [];
      for (let i = 0; i < 12; i++) mix.push('minion');
      for (let i = 0; i < 6; i++) mix.push('warrior');
      for (let i = 0; i < 6; i++) mix.push('archer');
      for (let i = 0; i < 4; i++) mix.push('mage');
      mix.push('shaman', 'shaman', 'aegis', 'aegis', 'bomber', 'bomber', 'bomber', 'bomber', 'necromancer', 'necromancer', 'reaver', 'reaver', 'reaver', 'reaver');
      mix.push('champion', this.boss ?? BIOME_BOSS[this.biome]);
      // deterministic shuffle, so the kinds are spread around the ring
      const order = mix.map((kind, i) => ({ kind, key: (i * 17) % mix.length })).sort((a, b) => a.key - b.key).map((m) => m.kind);
      order.forEach((kind, i) => {
        const a = (i / order.length) * Math.PI * 2;
        const r = 5 + (i % 5) * 1.6;
        this.addEnemy(kind, Math.sin(a) * r * 1.3, Math.cos(a) * r * 0.8 - 1, i % 7 === 0, false);
        const actor = this.enemies[this.enemies.length - 1];
        const ward = i % 5 === 2 && OLD_KINDS.includes(kind) ? ELEMENT_IDS[i % ELEMENT_IDS.length] : undefined;
        this.emit({ e: 'spawn', id: actor.snap.id, kind, x: actor.snap.x, z: actor.snap.z, elite: false, ward });
        if (kind === 'aegis') this.later(0.3, () => this.emit({ e: 'dome', id: actor.snap.id, on: true, r: HT.AEGIS.DOME_RADIUS }));
      });
      this.objective = this.makeObjective(this.obj, this.objProg);
    } else {
      (['minion', 'warrior', 'archer', 'mage', 'champion'] as EnemyKind[]).forEach((kind, i) => this.addEnemy(kind, -11 + i * 3.6, -2.4, false, false));
      HORDE_KINDS.forEach((kind, i) => this.addEnemy(kind, -11.5 + i * 3.4, -4.9, false, false));
      this.addEnemy(this.boss ?? BIOME_BOSS[this.biome], 8.4, -4.4, false, false);
      (['minion', 'warrior', 'archer', 'mage'] as EnemyKind[]).forEach((kind, i) => this.addEnemy(kind, -8.5 + i * 2.6, -7, true, true));
    }
  }

  private addEnemy(kind: EnemyKind, x: number, z: number, elite: boolean, statusDemo: boolean): void {
    const actor: EnemyActor = {
      homeX: x, homeZ: z, step: -1, t: rnd() * 0.2, cycle: 0, gone: 0, script: enemyScript(kind), statusDemo, slamCount: 0,
      leapBack: false, fromX: x, fromZ: z, toX: x, toZ: z,
      snap: { id: this.nextId++, kind, x, z, rot: 0, hp: 1, anim: 'spawn', animSeq: 0, flags: elite ? EF.ELITE : 0 },
    };
    if (this.stress) { actor.step = 1 + Math.floor(rnd() * 3); actor.t = rnd(); actor.snap.anim = 'move'; }
    this.enemies.push(actor);
    if (!this.stress) this.emit({ e: 'spawn', id: actor.snap.id, kind, x, z, elite });
  }

  /** Scripted follow-up in simulation time (so pausing / fast-forwarding keeps everything in sync). */
  private later(delay: number, fn: () => void): void {
    this.pending.push({ at: this.time + delay, fn });
  }

  private emit(ev: GameEvent): void {
    this.view.handleEvent(ev);
  }

  private shoot(kind: ProjectileKind, x: number, z: number, rot: number, speed: number, range: number, element: number, hostile: boolean, seek = -1): void {
    if (this.shots.length >= WORLD.MAX_PROJECTILES) return;
    this.shots.push({
      snap: { id: this.nextId++, kind, x, z, rot, element, hostile },
      vx: Math.sin(rot) * speed, vz: Math.cos(rot) * speed, life: range / speed, speed, seek,
    });
  }

  private tele(e: EnemyActor, shape: 'circle' | 'arc' | 'line', x: number, z: number, rot: number, r: number, w: number, dur: number): void {
    this.emit({ e: 'telegraph', shape, x, z, rot, r, w, dur, src: e.snap.id });
  }

  /** Scripted versions of what sim/matron.ts and sim/stalker.ts announce and fire, so timings match the real fight. */
  private boss2Step(e: EnemyActor, anim: EnemyAnim, prev: EnemyAnim): void {
    const s = e.snap;
    const id = s.id;
    const alive = (): boolean => e.snap.id === id && e.gone <= 0;
    if (s.kind === 'matron') {
      if (anim === 'volley') {
        this.tele(e, 'circle', s.x, s.z, 0, 3, 0, MT.RING_WINDUP);
        this.emit({ e: 'cast', who: { t: 'e', id }, ability: 'volley', x: s.x, z: s.z, rot: s.rot });
        for (let wave = 0; wave < 2; wave++) {
          this.later(MT.RING_WINDUP + wave * 0.5, () => {
            if (!alive()) return;
            for (let i = 0; i < MT.RING_ORBS; i++) this.shoot('hexOrb', s.x, s.z, ((i + wave * 0.5) / MT.RING_ORBS) * Math.PI * 2, MT.RING_SPEED, 12, 0, true);
          });
        }
      } else if (anim === 'beam') {
        for (let step = 0; step < BEAM_STEPS; step++) {
          this.later(step * MT.BEAM_INTERVAL, () => {
            if (!alive()) return;
            for (let k = 0; k < 3; k++) {
              const rot = 0.4 + step * MT.BEAM_TURN_DEG * DEG + (k / 3) * Math.PI * 2;
              this.tele(e, 'line', s.x, s.z, rot, 13, MT.BEAM_WIDTH, MT.BEAM_WINDUP);
            }
          });
        }
      } else if (anim === 'cast') {
        this.later(MT.WISP_WINDUP, () => {
          if (!alive()) return;
          for (let i = 0; i < 2; i++) {
            const side = i === 0 ? -1 : 1;
            this.shoot('soulWisp', s.x + side * 1.6, s.z, side * 0.8, MT.WISP_SPEED, MT.WISP_SPEED * 7, 0, true, i);
          }
        });
        for (let i = 0; i < 3; i++) this.tele(e, 'circle', s.x - 6 + i * 3.4, s.z + 5.5 + (i % 2) * 1.5, 0, MT.BLAST_RADIUS, 0, MT.BLAST_WINDUP);
        for (let i = 0; i < 3; i++) this.later(MT.BLAST_WINDUP, () => this.emit({ e: 'aoe', x: s.x - 6 + i * 3.4, z: s.z + 5.5 + (i % 2) * 1.5, r: MT.BLAST_RADIUS, el: null, hostile: true }));
      } else if (anim === 'summon') {
        this.emit({ e: 'cast', who: { t: 'e', id }, ability: 'summon', x: s.x, z: s.z, rot: s.rot });
      } else if (anim === 'slam') {
        this.tele(e, 'circle', s.x, s.z + 3, 0, 2.6, 0, 0.9);
        this.later(0.9, () => this.emit({ e: 'aoe', x: s.x, z: s.z + 3, r: 2.6, el: null, hostile: true }));
      } else if (anim === 'idle' && prev === 'stun') {
        this.emit({ e: 'bossPhase', phase: 2 });
      } else if (anim === 'move') {
        this.later(1.2, () => { if (alive()) this.emit({ e: 'cast', who: { t: 'e', id }, ability: 'blink', x: s.x, z: s.z, rot: s.rot }); });
      }
      return;
    }
    if (anim === 'volley' && prev !== 'leap') {
      // arrow fan: one announced line per arrow
      const n = ST.FAN_ARROWS[1];
      for (let i = 0; i < n; i++) {
        const rot = (i / (n - 1) - 0.5) * ST.FAN_SPREAD_DEG[1] * DEG;
        this.tele(e, 'line', s.x, s.z, rot, 12, 0.5, ST.FAN_WINDUP);
        this.later(ST.FAN_WINDUP, () => { if (alive()) this.shoot('boneArrow', s.x, s.z, rot, ST.FAN_SPEED, 12, 0, true); });
      }
    } else if (anim === 'volley') {
      // frenzy: a quick aimed arrow per animSeq bump
      this.emit({ e: 'cast', who: { t: 'e', id }, ability: 'frenzy', x: s.x, z: s.z, rot: s.rot });
      for (let k = 0; k < FRENZY_SHOTS; k++) {
        this.later(k * ST.FRENZY_INTERVAL, () => {
          if (!alive()) return;
          const rot = (k - 2) * 0.22;
          if (k > 0) { s.animSeq++; s.rot = rot; }
          this.tele(e, 'line', s.x, s.z, rot, 12, 0.5, ST.FRENZY_WINDUP);
          this.later(ST.FRENZY_WINDUP, () => { if (e.snap.id === id) this.shoot('boneArrow', s.x, s.z, rot, ST.FAN_SPEED, 12, 0, true); });
        });
      }
    } else if (anim === 'windup') {
      this.tele(e, 'line', s.x, s.z, 0.15, 14, ST.SPEAR_WIDTH, ST.SPEAR_WINDUP);
      s.rot = 0.15;
      this.later(ST.SPEAR_WINDUP, () => { if (alive()) this.shoot('boneSpear', s.x, s.z, 0.15, ST.SPEAR_SPEED, 14, 0, true); });
    } else if (anim === 'leap') {
      const tx = e.leapBack ? e.homeX : e.homeX - 5.5;
      const tz = e.leapBack ? e.homeZ : e.homeZ + 4.5;
      e.leapBack = !e.leapBack;
      e.fromX = s.x; e.fromZ = s.z; e.toX = tx; e.toZ = tz;
      s.rot = Math.atan2(tx - s.x, tz - s.z);
      this.tele(e, 'circle', tx, tz, 0, ST.LEAP_RADIUS, 0, ST.LEAP_AIR_TIME);
      this.emit({ e: 'cast', who: { t: 'e', id }, ability: 'leap', x: tx, z: tz, rot: s.rot });
      this.later(ST.LEAP_AIR_TIME, () => { if (alive()) this.emit({ e: 'aoe', x: tx, z: tz, r: ST.LEAP_RADIUS, el: null, hostile: true }); });
    } else if (anim === 'charge') {
      this.tele(e, 'line', s.x, s.z, 0, 8, 2.4, 0.8);
    } else if (anim === 'cast') {
      for (let i = 0; i < 3; i++) this.tele(e, 'circle', s.x - 5 + i * 4, s.z + 6, 0, ST.TRAP_RADIUS, 0, ST.TRAP_ARM);
    } else if (anim === 'idle' && prev === 'stun') {
      this.emit({ e: 'bossPhase', phase: 2 });
    }
  }

  // ---------------------------------------------------------------------------------------------- update 4

  /** An objective state as the server would send it, for the given knob (0..1). */
  private makeObjective(kind: ObjectiveKind, prog: number): ObjectiveState | null {
    if (kind === 'slay') return null;
    const state: ObjectiveState = { kind, progress: prog, timeLeft: 0, bonus: this.objBonus, status: this.objDone ? 'done' : 'active', anchor: null, sites: [], targets: [] };
    const T = OBJECTIVE_TUNING;
    // bonus=0: the shard still stands (barely) until `at`, so the shatter itself can be captured
    if (kind === 'defend') state.anchor = { x: 0, z: -1, r: T.DEFEND.RADIUS, hp: this.objBonus ? prog : Math.max(0.12, prog) };
    else if (kind === 'vault') state.anchor = { x: 0, z: -2, r: 1.2, hp: 1 };
    else if (kind === 'survive') state.timeLeft = T.SURVIVE.SECONDS * (1 - prog);
    else if (kind === 'ritual') {
      // prog 0.5: one burning, one half way, one untouched
      const fill = [Math.min(1, prog * 2), Math.max(0, Math.min(1, prog * 2 - 0.5)) , Math.max(0, prog * 2 - 1.5)];
      [[-8, -2], [0, 2.5], [8, -2]].forEach(([x, z], i) => state.sites.push({ x, z, r: T.RITUAL.RADIUS, progress: fill[i], lit: fill[i] >= 1 }));
    } else if (kind === 'hunt') {
      state.timeLeft = this.objBonus ? T.HUNT.SECONDS * (1 - prog) : 0;
      state.targets = this.enemies.filter((e) => (e.snap.flags & EF.ELITE) !== 0 && e.gone <= 0).slice(0, T.HUNT.TARGETS).map((e) => e.snap.id);
    }
    return state;
  }

  /** What sim/enemies.ts would announce for the five kinds of update 4 (ability ids: mend, raise, fuse, reaver_leap). */
  private hordeStep(e: EnemyActor, anim: EnemyAnim, prev: EnemyAnim): void {
    const s = e.snap;
    const id = s.id;
    const def = enemyDef(s.kind);
    const alive = (): boolean => e.snap.id === id && e.gone <= 0;
    const cast = (ability: string, x = s.x, z = s.z): void => this.emit({ e: 'cast', who: { t: 'e', id }, ability, x, z, rot: s.rot });
    if (s.kind === 'shaman') {
      if (anim === 'windup') {
        this.tele(e, 'line', s.x + Math.sin(s.rot), s.z + Math.cos(s.rot), s.rot, 9, 0.6, def.windup);
      } else if (anim === 'attack' && prev === 'windup') {
        cast('shaman_bolt');
        this.shoot('hexOrb', s.x, s.z + 1, 0, HT.SHAMAN.BOLT_SPEED, 9, 0, true);
      } else if (anim === 'cast') {
        cast('mend');
      } else if (anim === 'attack' && prev === 'cast') {
        // everyone wounded within reach is mended
        const targets = this.enemies.filter((o) => o !== e && o.gone <= 0 && Math.hypot(o.snap.x - s.x, o.snap.z - s.z) <= HT.SHAMAN.MEND_RADIUS).map((o) => o.snap.id);
        for (const o of this.enemies) if (targets.includes(o.snap.id)) o.snap.hp = Math.min(1, o.snap.hp + HT.SHAMAN.MEND_FRACTION);
        this.emit({ e: 'mend', id, targets });
      }
    } else if (s.kind === 'aegis') {
      if (anim === 'idle' && (prev === 'spawn' || prev === 'stun')) this.later(prev === 'stun' ? 0.5 : 0.2, () => { if (alive()) this.emit({ e: 'dome', id, on: true, r: HT.AEGIS.DOME_RADIUS }); });
      else if (anim === 'stun' || anim === 'death') this.emit({ e: 'dome', id, on: false, r: HT.AEGIS.DOME_RADIUS });
      else if (anim === 'windup') this.emit({ e: 'telegraph', shape: 'arc', x: s.x, z: s.z, rot: s.rot, r: def.attackRange + 0.6, w: 110 * DEG, dur: def.windup, src: id });
      else if (anim === 'attack') cast('aegis_attack');
    } else if (s.kind === 'bomber') {
      const B = HT.BOMBER;
      if (anim === 'move' && e.cycle % 2 === 1) {
        // slain on the run: the charge lies there and goes off after the delay
        this.later(1.1, () => {
          if (!alive()) return;
          const x = s.x;
          const z = s.z;
          this.emit({ e: 'kill', id, kind: s.kind, x, z, by: 0 });
          this.emit({ e: 'telegraph', shape: 'circle', x, z, rot: 0, r: B.BLAST_RADIUS, w: 0, dur: B.DEATH_BLAST_DELAY });
          e.gone = 3.2;
          this.later(B.DEATH_BLAST_DELAY, () => this.emit({ e: 'aoe', x, z, r: B.BLAST_RADIUS, el: null, hostile: true }));
        });
      } else if (anim === 'windup') {
        this.tele(e, 'circle', s.x, s.z, 0, B.BLAST_RADIUS, 0, def.windup);
        cast('fuse');
      } else if (anim === 'attack') {
        this.emit({ e: 'aoe', x: s.x, z: s.z, r: B.BLAST_RADIUS, el: null, hostile: true });
        this.emit({ e: 'kill', id, kind: s.kind, x: s.x, z: s.z, by: -1 });
        e.gone = 3.2;
      }
    } else if (s.kind === 'necromancer') {
      if (anim === 'summon') cast('raise');
      else if (anim === 'attack') {
        for (let i = 0; i < HT.NECROMANCER.RAISE_COUNT; i++) {
          const minion = this.dummy('minion', s.x + (i === 0 ? -2.2 : 2.2), s.z + 2.2);
          minion.snap.anim = 'spawn';
          minion.script = [{ anim: 'spawn', dur: enemyDef('minion').spawnTime }, { anim: 'idle', dur: 1e9 }];
          minion.t = enemyDef('minion').spawnTime;
          this.emit({ e: 'spawn', id: minion.snap.id, kind: 'minion', x: minion.snap.x, z: minion.snap.z, elite: false });
          this.raised.push([e, minion]);
        }
      } else if (anim === 'death') {
        this.crumble(e);
      }
    } else if (s.kind === 'reaver') {
      const R = HT.REAVER;
      if (anim === 'leap') {
        const tx = e.leapBack ? e.homeX : e.homeX + 1.5;
        const tz = e.leapBack ? e.homeZ : e.homeZ + 7;
        e.leapBack = !e.leapBack;
        e.fromX = s.x; e.fromZ = s.z; e.toX = tx; e.toZ = tz;
        s.rot = Math.atan2(tx - s.x, tz - s.z);
        this.tele(e, 'circle', tx, tz, 0, R.LEAP_RADIUS, 0, R.LEAP_AIR_TIME);
        cast('reaver_leap', tx, tz);
        this.later(R.LEAP_AIR_TIME, () => { if (alive()) this.emit({ e: 'aoe', x: tx, z: tz, r: R.LEAP_RADIUS, el: null, hostile: true }); });
      } else if (anim === 'windup') {
        this.emit({ e: 'telegraph', shape: 'arc', x: s.x, z: s.z, rot: s.rot, r: def.attackRange + 0.6, w: 100 * DEG, dur: def.windup, src: id });
      } else if (anim === 'attack') cast('reaver_attack');
    }
  }

  /** A necromancer is gone: the minions it raised crumble with it. */
  private crumble(necro: EnemyActor): void {
    for (const [master, minion] of this.raised) {
      if (master !== necro || minion.gone > 0) continue;
      this.emit({ e: 'kill', id: minion.snap.id, kind: 'minion', x: minion.snap.x, z: minion.snap.z, by: -1 });
      minion.gone = 1e9;
    }
    this.raised = this.raised.filter(([master]) => master !== necro);
    this.enemies = this.enemies.filter((e) => e.gone < 1e8 || e.script.length !== 2);
  }

  // ---------------------------------------------------------------------------------------------- heroes

  private stepHero(h: HeroActor, dt: number): void {
    const s = h.snap;
    if (this.time < h.offset) return;
    h.t -= dt;
    if (h.t <= 0) {
      h.step = (h.step + 1) % HERO_STEPS.length;
      const step = HERO_STEPS[h.step];
      const prev = s.anim;
      h.t = step.dur;
      s.anim = step.anim;
      s.animSeq++;
      s.rot = NORTH;
      s.flags &= ~(PF.INVULNERABLE | PF.BEING_REVIVED);
      if (prev === 'downed') {
        s.state = 'alive'; s.hp = s.maxHp * WORLD.REVIVE_HP_FRACTION; s.revive = 0;
        this.emit({ e: 'revived', slot: s.slot, by: (s.slot + 1) % 4 });
        this.emit({ e: 'heal', slot: s.slot, amount: Math.round(s.hp) });
      }
      if (step.anim === 'primary1' || step.anim === 'primary2' || step.anim === 'primary3' || step.anim === 'secondary' || step.anim === 'art' || step.anim === 'ultimate') {
        if (step.anim === 'ultimate') s.ult = 0;
        this.perform(h, step.anim);
      } else if (step.anim === 'hit') {
        s.hp = Math.max(8, s.hp - 14);
        this.emit({ e: 'hit', target: { t: 'p', id: s.slot }, x: s.x, z: s.z, dmg: 14, crit: false, el: null, by: -1 });
      } else if (step.anim === 'downed') {
        s.state = 'downed'; s.hp = 0;
        this.emit({ e: 'down', slot: s.slot });
      } else if (step.anim === 'dash') {
        s.flags |= PF.INVULNERABLE;
        this.view.localAction('dash');
      } else if (step.anim === 'cheer') {
        this.emit({ e: 'boon', slot: s.slot, id: 'demo', level: 1 });
      }
    }
    const step = HERO_STEPS[Math.max(0, h.step)];
    const k = 1 - h.t / step.dur;
    if (step.anim === 'run') {
      const a = k * Math.PI * 2;
      s.x = h.homeX + Math.sin(a) * 1.6;
      s.z = h.homeZ + (1 - Math.cos(a)) * 1.6;
      s.rot = a + Math.PI / 2;
    } else if (step.anim === 'dash') {
      const d = Math.min(1, (step.dur - h.t) / DASH.DURATION) * DASH.SPEED * DASH.DURATION;
      s.x = h.homeX; s.z = h.homeZ - d;
    } else if (step.anim === 'idle' && Math.abs(s.z - h.homeZ) > 0.01) {
      s.z += (h.homeZ - s.z) * Math.min(1, dt * 12); s.x = h.homeX;
    } else if (step.anim === 'downed') {
      const el = step.dur - h.t;
      if (el > 0.8) { s.flags |= PF.BEING_REVIVED; s.revive = Math.min(1, (el - 0.8) / 2.4); }
    }
    s.cdSecondary = Math.max(0, s.cdSecondary - dt / 6);
    // the charge fills over the cycle and is spent by the ultimate step
    if (s.ult < 1 && s.state === 'alive') {
      s.ult = Math.min(1, s.ult + dt / 7);
      if (s.ult >= 1) this.emit({ e: 'ultReady', slot: s.slot });
    }
  }

  /** What the simulation would announce for one ability use: the cast, and the follow-up events of its shape. */
  private perform(h: HeroActor, anim: PlayerAnim): void {
    const s = h.snap;
    const cls = CLASSES[h.cls];
    const idx = anim === 'primary2' ? 1 : anim === 'primary3' ? 2 : 0;
    const a: AbilityDef = anim === 'ultimate' ? cls.ultimate : anim === 'art' ? cls.arts[0] ?? cls.secondary
      : anim === 'secondary' ? cls.secondary : cls.primary[Math.min(idx, cls.primary.length - 1)];
    const primary = a.anim === 'primary1' || a.anim === 'primary2' || a.anim === 'primary3';
    s.anim = primary ? (anim === 'secondary' || anim === 'art' || anim === 'ultimate' ? a.anim : anim) : a.anim;
    s.animSeq++;
    const sin = Math.sin(s.rot);
    const cos = Math.cos(s.rot);
    // ground-targeted shapes aim ahead of the hero; everything else is cast where it stands
    const reach = a.shape === 'leap' ? Math.min(a.range, 5.5) : a.shape === 'trap' ? 4 : a.range > 0 ? Math.min(a.range, 7) : 0;
    const aimed = a.shape === 'circle' || a.shape === 'leap' || a.shape === 'trap' || (a.shape === 'zone' && a.range > 0);
    const tx = aimed ? s.x + sin * reach : s.x;
    const tz = aimed ? s.z + cos * reach : s.z;
    const slot = s.slot;
    this.emit({ e: 'cast', who: { t: 'p', id: slot }, ability: a.id, x: a.shape === 'zone' || a.shape === 'trap' ? s.x : tx, z: a.shape === 'zone' || a.shape === 'trap' ? s.z : tz, rot: s.rot });
    if (anim === 'secondary' || anim === 'art') s.cdSecondary = 1;
    const el: ElementId | null = this.demo === 'umbra' ? 'umbra' : null;
    switch (a.shape) {
      case 'projectile': {
        if (!a.projectile) break;
        const code = this.demo === 'umbra' ? 4 : this.demo ? 0 : this.counters.shot++ % 5;
        const kind = a.projectile;
        this.later(a.windup, () => {
          for (let i = 0; i < a.count; i++) {
            const spread = a.count > 1 ? ((i / (a.count - 1)) - 0.5) * a.arc * DEG : 0;
            this.shoot(kind, s.x + Math.sin(s.rot) * 0.8, s.z + Math.cos(s.rot) * 0.8, s.rot + spread, a.speed, a.range, code, false);
          }
        });
        break;
      }
      case 'circle': {
        this.later(a.windup, () => {
          this.emit({ e: 'aoe', x: tx, z: tz, r: a.radius, el: el ?? (a.id === 'mage_nova' ? 'storm' : null), hostile: false });
          if (a.buff) this.emit({ e: 'buff', slot, id: a.buff, dur: a.duration });
          if (a.special === 'mark') this.markAround(tx, tz, a.radius, a.duration, s);
          if (a.special === 'allElements') {
            // the overload resonates with itself on everything it touches
            this.enemies.filter((e) => e.gone <= 0 && Math.hypot(e.snap.x - tx, e.snap.z - tz) < a.radius).slice(0, 3).forEach((e, i) => {
              const [ea, eb] = ELEMENT_PAIRS[(i * 2 + slot) % ELEMENT_PAIRS.length];
              this.later(0.1 + i * 0.12, () => this.emit({ e: 'resonance', x: e.snap.x, z: e.snap.z, r: STATUS.RESONANCE.RADIUS, a: ea, b: eb, by: slot }));
            });
          }
        });
        break;
      }
      case 'leap': {
        // the simulation teleports at landing in this script: the view has to carry the hero through the air itself
        this.later(a.windup, () => {
          s.x = tx; s.z = tz;
          this.emit({ e: 'aoe', x: tx, z: tz, r: a.radius, el, hostile: false });
        });
        break;
      }
      case 'zone':
        this.later(a.windup, () => this.emit({ e: 'zone', id: this.nextId++, kind: a.id, x: tx, z: tz, r: a.radius, dur: a.duration, el, by: slot }));
        break;
      case 'trap': {
        const id = this.nextId++;
        this.emit({ e: 'zone', id, kind: a.id, x: tx, z: tz, r: a.radius, dur: a.duration, el, by: slot });
        if (!this.demo) this.later(a.windup + 1.4, () => this.emit({ e: 'zoneEnd', id, x: tx, z: tz, sprung: true }));
        break;
      }
      case 'buff':
        this.later(a.windup, () => {
          if (!a.buff) return;
          const id = a.buff;
          if (a.radius > 0) for (const o of this.heroes) this.emit({ e: 'buff', slot: o.snap.slot, id, dur: a.duration });
          else this.emit({ e: 'buff', slot, id, dur: a.duration });
        });
        break;
      default:
        break;
    }
  }

  /** Death Mark: every enemy near the point is marked and a dagger flies at each. */
  private markAround(x: number, z: number, r: number, dur: number, from: PlayerSnap): void {
    let n = 0;
    for (const e of this.enemies) {
      if (e.gone > 0 || Math.hypot(e.snap.x - x, e.snap.z - z) > r || n >= ULTIMATE.MARK_MAX_TARGETS) continue;
      n++;
      this.emit({ e: 'mark', id: e.snap.id, dur });
      const rot = Math.atan2(e.snap.x - from.x, e.snap.z - from.z);
      this.shoot('shadowDagger', from.x, from.z, rot, 26, Math.hypot(e.snap.x - from.x, e.snap.z - from.z), 0, false);
    }
  }

  // ---------------------------------------------------------------------------------------------- demos (update 3)

  /** An enemy that idles until `at` and then runs `steps` once (the horde demos); it ends idling. */
  private scripted(kind: EnemyKind, x: number, z: number, steps: EnemyStep[]): EnemyActor {
    const actor = this.dummy(kind, x, z);
    actor.script = [{ anim: 'idle', dur: this.demoAt }, ...steps, { anim: 'idle', dur: 1e9 }];
    actor.step = 0;
    actor.t = this.demoAt;
    return actor;
  }

  private dummy(kind: EnemyKind, x: number, z: number, flags = 0, affix?: (typeof AFFIX_IDS)[number], ward?: ElementId): EnemyActor {
    const actor: EnemyActor = {
      homeX: x, homeZ: z, step: 0, t: 1e9, cycle: 0, gone: 0, script: [{ anim: 'idle', dur: 1e9 }], statusDemo: false, slamCount: 0,
      leapBack: false, fromX: x, fromZ: z, toX: x, toZ: z,
      snap: { id: this.nextId++, kind, x, z, rot: 0, hp: 1, anim: 'idle', animSeq: 0, flags },
    };
    this.enemies.push(actor);
    if (affix) this.emit({ e: 'spawn', id: actor.snap.id, kind, x, z, elite: true, affix });
    else if (ward) this.emit({ e: 'spawn', id: actor.snap.id, kind, x, z, elite: false, ward });
    return actor;
  }

  /** A calm stage for one feature: heroes in a row facing north, a few idle skeletons as targets. */
  private setupDemo(): void {
    const hd = this.room.d / 2;
    const demo = this.demo;
    const row: EnemyKind[] = ['minion', 'warrior', 'archer', 'mage'];
    this.heroes.forEach((h, i) => { h.homeX = -9 + i * 6; h.homeZ = hd - 3.5; h.snap.x = h.homeX; h.snap.z = h.homeZ; h.offset = 0; });
    if (demo === 'art' || demo === 'ult' || demo === 'primary') {
      // two targets in front of every hero
      this.heroes.forEach((h, i) => { this.dummy(row[i % 4], h.homeX - 1.1, h.homeZ - 5.2); this.dummy(row[(i + 1) % 4], h.homeX + 1.3, h.homeZ - 6.6); });
    } else if (demo === 'reactions') {
      // one victim per reaction and a few bystanders the Void Arc can jump to
      REACTIONS.forEach((_, i) => this.dummy(row[i % 4], -8.5 + (i % 3) * 8.5, i < 3 ? -4.6 : 2.2));
      for (let i = 0; i < 3; i++) this.dummy('minion', 11.2 + (i % 2) * 1.6, 5 - i * 2.6);
      this.heroes.forEach((h) => { h.snap.z = hd - 1.5; h.homeZ = hd - 1.5; });
    } else if (demo === 'umbra') {
      row.forEach((kind, i) => this.dummy(kind, -6 + i * 4, -1.5, EF.WITHER | (i === 3 ? EF.BURN : 0) | (i === 1 ? EF.ELITE : 0)));
      this.dummy('champion', 9, -3, EF.WITHER);
    } else if (demo === 'affix') {
      AFFIX_IDS.forEach((affix, i) => this.dummy(row[i % 4], -7.5 + i * 5, -0.5, EF.ELITE, affix));
    } else if (demo === 'lineup') {
      this.heroes.forEach((h, i) => { h.homeX = -3.6 + i * 2.4; h.snap.x = h.homeX; h.homeZ = 6; h.snap.z = 6; });
    } else if (demo === 'zones') {
      this.heroes.forEach((h, i) => { h.homeX = -12 + i * 4.5; h.snap.x = h.homeX; h.homeZ = hd - 2.2; h.snap.z = h.homeZ; });
      for (let i = 0; i < 4; i++) this.dummy(row[i], -12 + i * 8, -3.4);
    } else if (demo === 'horde') {
      [...OLD_KINDS, ...HORDE_KINDS].forEach((kind, i) => this.dummy(kind, -12 + i * 3, -1));
    } else if (demo === 'hordeact') {
      const def = (kind: EnemyKind): number => enemyDef(kind).windup;
      // shaman with two wounded allies in reach
      this.scripted('shaman', -11.5, -2.5, [{ anim: 'cast', dur: HT.SHAMAN.MEND_WINDUP }, { anim: 'attack', dur: 0.8 }]);
      this.dummy('warrior', -13.2, 0.8).snap.hp = 0.35;
      this.dummy('minion', -9.6, 1.2).snap.hp = 0.5;
      // aegis with its dome up, three enemies under it and an archer aiming out of it
      const aegis = this.dummy('aegis', -3.8, -1.5);
      this.later(0.2, () => this.emit({ e: 'dome', id: aegis.snap.id, on: true, r: HT.AEGIS.DOME_RADIUS }));
      this.dummy('minion', -5.6, 0.6);
      this.dummy('warrior', -2.2, 0.9);
      this.scripted('archer', -4.2, -4.2, [{ anim: 'windup', dur: def('archer') }, { anim: 'attack', dur: 0.6 }]);
      // one bomber whose fuse runs out, one that is slain (runDemo)
      this.scripted('bomber', 2.2, -1.5, [{ anim: 'windup', dur: def('bomber') }, { anim: 'attack', dur: 0.05 }]);
      this.dummy('bomber', 5.4, 2.2);
      this.scripted('necromancer', 8.6, -3.5, [{ anim: 'summon', dur: def('necromancer') }, { anim: 'attack', dur: 0.6 }]);
      this.scripted('reaver', 12.2, -6, [{ anim: 'leap', dur: HT.REAVER.LEAP_AIR_TIME }, { anim: 'windup', dur: def('reaver') }, { anim: 'attack', dur: 0.6 }]);
    } else if (demo === 'wards') {
      ELEMENT_IDS.forEach((el, i) => this.dummy(row[i], -7.5 + i * 5, -0.5, 0, undefined, el));
      this.dummy('reaver', 11.5, -3, 0, undefined, 'ember');
    } else if (demo === 'dome') {
      const steps: EnemyStep[] = this.drop ? [{ anim: 'stun', dur: 1.6 }] : [];
      const aegis = this.scripted('aegis', 0, -1.5, steps);
      this.later(0.2, () => this.emit({ e: 'dome', id: aegis.snap.id, on: true, r: HT.AEGIS.DOME_RADIUS }));
      this.dummy('minion', -2.2, 0.6);
      this.dummy('warrior', 2.4, 0.2);
      this.dummy('archer', 0.4, -4.2);
      this.dummy('mage', -2.8, -3);
      this.dummy('minion', 7.5, -1);
    } else if (demo === 'mend') {
      // &interrupt=1: the shaman is staggered half way through the channel, and a mage next to it in the middle of its windup
      this.scripted('shaman', 0, -4.5, this.interrupt ? [{ anim: 'cast', dur: 0.7 }, { anim: 'stun', dur: 1.4 }] : [{ anim: 'cast', dur: HT.SHAMAN.MEND_WINDUP }, { anim: 'attack', dur: 0.8 }]);
      ([['warrior', -3.2, -1.2], ['minion', 3, -1], ['archer', -4.4, -5.5]] as [EnemyKind, number, number][])
        .forEach(([kind, x, z]) => { this.dummy(kind, x, z).snap.hp = 0.35; });
      const mage = this.interrupt ? this.scripted('mage', 4.2, -5.8, [{ anim: 'windup', dur: 0.7 }, { anim: 'stun', dur: 1.4 }]) : this.dummy('mage', 4.2, -5.8);
      mage.snap.hp = 0.35;
    } else if (demo === 'objective') {
      const obj = this.obj;
      if (obj === 'defend') {
        // two heroes at the shard (they mend it), two further out; part of the horde is on it
        const spots = [[-2.2, 0.6], [2.4, -0.2], [-7, 4], [7, 4.5]];
        this.heroes.forEach((h, i) => { h.homeX = spots[i][0]; h.homeZ = spots[i][1]; h.snap.x = h.homeX; h.snap.z = h.homeZ; });
        this.dummy('minion', -1.2, -3.2);
        this.dummy('warrior', 1.6, -3.4);
        this.dummy('minion', 5.5, -5);
      } else if (obj === 'ritual') {
        const spots = [[-8.6, -0.6], [0.8, 3.4], [-0.9, 2.2], [9, 4]];
        this.heroes.forEach((h, i) => { h.homeX = spots[i][0]; h.homeZ = spots[i][1]; h.snap.x = h.homeX; h.snap.z = h.homeZ; });
        this.dummy('minion', 5, -3);
        this.dummy('archer', -3.5, -5.5);
      } else if (obj === 'hunt') {
        const flags = EF.ELITE | (this.objBonus ? 0 : EF.ENRAGED);
        this.dummy('warrior', -4, -2, flags);
        this.dummy('mage', 4.5, -3.5, flags);
        this.dummy('minion', -1, -0.5);
        this.dummy('minion', 1.5, -5);
        this.dummy('archer', 8, -6);
        // one more elite that is not a target, marked for death, to compare the markers
        const other = this.dummy('archer', -9, -4, EF.ELITE, 'swift');
        this.later(0.3, () => this.emit({ e: 'mark', id: other.snap.id, dur: 60 }));
      } else if (obj === 'survive') {
        for (let i = 0; i < 6; i++) this.dummy(row[i % 4], -9 + i * 3.6, -3 + (i % 2) * 2.4);
      } else if (obj === 'vault') {
        const spots = [[-2.6, 0.4], [2.8, 0.2], [-5, 4], [5, 4.5]];
        this.heroes.forEach((h, i) => { h.homeX = spots[i][0]; h.homeZ = spots[i][1]; h.snap.x = h.homeX; h.snap.z = h.homeZ; });
      }
      this.objective = this.makeObjective(obj, this.objProg);
      // the state says `done` only from `at` on, so the moment itself can be captured
      if (this.objective && this.objDone) this.objective.status = 'active';
      this.later(0.15, () => this.emit({ e: 'objective', kind: obj, what: 'start' }));
    }
  }

  /** The one thing a demo stage shows, fired once at `at`. */
  private runDemo(): void {
    const demo = this.demo;
    if (!demo || this.demoDone || this.time < this.demoAt) return;
    this.demoDone = true;
    if (demo === 'art' || demo === 'ult' || demo === 'primary') {
      for (const h of this.heroes) { this.perform(h, demo === 'ult' ? 'ultimate' : demo === 'art' ? 'art' : 'primary3'); h.t = 2.2; }
    } else if (demo === 'reactions') {
      REACTIONS.forEach((r, i) => {
        const e = this.enemies[i].snap;
        e.flags |= STATUS_BIT[r.pair[1]];
        this.emit({ e: 'resonance', x: e.x, z: e.z, r: STATUS.RESONANCE.RADIUS * r.radiusMul, a: r.pair[0], b: r.pair[1], by: 0 });
      });
    } else if (demo === 'umbra') {
      for (const e of this.enemies) this.emit({ e: 'status', id: e.snap.id, el: 'umbra' });
      for (const h of this.heroes) { this.perform(h, 'primary1'); h.t = 0.8; }
      PROJECTILE_DEMO.filter((d) => !d.hostile).forEach((d, i) => this.shoot(d.kind, -11, 3.2 + i * 0.9, Math.PI / 2, 6, 30, 4, false));
    } else if (demo === 'affix') {
      // the volatile elite dies; its blast is announced like any other hostile attack
      const v = this.enemies[AFFIX_IDS.indexOf('volatile')];
      this.later(0.9, () => {
        this.emit({ e: 'kill', id: v.snap.id, kind: v.snap.kind, x: v.snap.x, z: v.snap.z, by: 0 });
        this.emit({ e: 'telegraph', shape: 'circle', x: v.snap.x, z: v.snap.z, rot: 0, r: 3, w: 0, dur: 1.2 });
        v.gone = 1e9;
        this.later(1.2, () => this.emit({ e: 'aoe', x: v.snap.x, z: v.snap.z, r: 3, el: null, hostile: true }));
      });
      const armored = this.enemies[AFFIX_IDS.indexOf('armored')];
      this.later(3.2, () => this.emit({ e: 'shieldBreak', id: armored.snap.id }));
    } else if (demo === 'zones') {
      ZONE_DEMO.forEach(([kind, x]) => {
        const def = Object.values(CLASSES).flatMap((c) => [c.secondary, ...c.arts, c.ultimate]).find((a) => a.id === kind);
        if (def) this.emit({ e: 'zone', id: this.nextId++, kind, x, z: -2.2, r: def.radius, dur: 60, el: null, by: 0 });
      });
      // snares: one armed, one that goes off half a second later; a hostile telegraph across the smoke to prove it stays readable
      const trap = CLASSES.rogue.arts[0];
      const sprung = this.nextId++;
      this.emit({ e: 'zone', id: this.nextId++, kind: trap.id, x: -8.2, z: 3.4, r: trap.radius, dur: 60, el: null, by: 3 });
      this.emit({ e: 'zone', id: sprung, kind: trap.id, x: -2.6, z: 3.4, r: trap.radius, dur: 60, el: null, by: 3 });
      this.later(0.9, () => this.emit({ e: 'zoneEnd', id: sprung, x: -2.6, z: 3.4, sprung: true }));
      this.later(0.3, () => this.emit({ e: 'telegraph', shape: 'circle', x: 11.2, z: -1.4, rot: 0, r: 2.2, w: 0, dur: 3 }));
      this.later(0.3, () => this.emit({ e: 'telegraph', shape: 'line', x: -8, z: -6.5, rot: 0.2, r: 8, w: 1.4, dur: 3 }));
      this.emit({ e: 'buff', slot: 0, id: 'bloodrage', dur: 60 });
      this.emit({ e: 'buff', slot: 1, id: 'bulwark', dur: 60 });
      this.emit({ e: 'buff', slot: 2, id: 'overload', dur: 60 });
      this.emit({ e: 'cast', who: { t: 'p', id: 3 }, ability: 'knight_bulwark', x: this.heroes[3].snap.x, z: this.heroes[3].snap.z, rot: NORTH });
    } else if (demo === 'ready') {
      for (const h of this.heroes) this.emit({ e: 'ultReady', slot: h.snap.slot });
    } else if (demo === 'hordeact') {
      // the second bomber is slain: its charge lies there for the delay, announced like any hostile blast
      const b = this.enemies.find((e) => e.snap.kind === 'bomber' && e.script.length === 1);
      if (b) {
        const B = HT.BOMBER;
        const { x, z } = b.snap;
        this.emit({ e: 'kill', id: b.snap.id, kind: 'bomber', x, z, by: 0 });
        this.emit({ e: 'telegraph', shape: 'circle', x, z, rot: 0, r: B.BLAST_RADIUS, w: 0, dur: B.DEATH_BLAST_DELAY });
        b.gone = 1e9;
        this.later(B.DEATH_BLAST_DELAY, () => this.emit({ e: 'aoe', x, z, r: B.BLAST_RADIUS, el: null, hostile: true }));
      }
      // a blast announced inside the dome: it has to stay as readable as anywhere else
      this.emit({ e: 'telegraph', shape: 'circle', x: -2.6, z: -2.6, rot: 0, r: 2.2, w: 0, dur: 2.5 });
    } else if (demo === 'wards') {
      this.enemies.forEach((e, i) => {
        const el: ElementId = i < ELEMENT_IDS.length ? ELEMENT_IDS[i] : 'ember';
        this.emit({ e: 'hit', target: { t: 'e', id: e.snap.id }, x: e.snap.x, z: e.snap.z, dmg: 24, crit: false, el, by: 0 });
        this.emit({ e: 'warded', id: e.snap.id, el, x: e.snap.x, z: e.snap.z, by: 0 });
      });
    } else if (demo === 'dome') {
      this.emit({ e: 'telegraph', shape: 'circle', x: 1.4, z: 1.6, rot: 0, r: 2.2, w: 0, dur: 3 });
      this.emit({ e: 'telegraph', shape: 'line', x: -8, z: -2.6, rot: Math.PI / 2, r: 16, w: 1.4, dur: 3 });
      this.emit({ e: 'telegraph', shape: 'arc', x: 2.4, z: 0.2, rot: 0.3, r: 3.2, w: 110 * DEG, dur: 3 });
      // a hit on a guarded enemy
      const guarded = this.enemies[1];
      this.emit({ e: 'hit', target: { t: 'e', id: guarded.snap.id }, x: guarded.snap.x, z: guarded.snap.z, dmg: 6, crit: false, el: null, by: 0 });
    } else if (demo === 'objective') {
      const obj = this.obj;
      const state = this.objective;
      if (obj === 'defend') this.emit({ e: 'objective', kind: obj, what: 'anchorHit' });
      if (obj === 'defend' && !this.objBonus && state && state.anchor) { state.anchor.hp = 0; state.bonus = false; this.emit({ e: 'objective', kind: obj, what: 'bonusLost' }); }
      if (obj === 'ritual' && state && state.sites[0].lit) this.emit({ e: 'objective', kind: obj, what: 'site', index: 0 });
      if (obj === 'hunt' && !this.objBonus) this.emit({ e: 'objective', kind: obj, what: 'bonusLost' });
      if (this.objDone && state) {
        state.status = 'done';
        this.emit({ e: 'objective', kind: obj, what: 'done', bonus: this.objBonus });
        if (obj !== 'vault') this.emit({ e: 'chamberClear' });
      }
    }
  }

  private demoHero(h: HeroActor, dt: number): void {
    const s = h.snap;
    h.t -= dt;
    if (h.t <= 0 && s.anim !== 'idle') { s.anim = 'idle'; s.animSeq++; }
    if (s.anim === 'idle') { s.x += (h.homeX - s.x) * Math.min(1, dt * 3); s.z += (h.homeZ - s.z) * Math.min(1, dt * 3); }
  }

  private stressHero(h: HeroActor, dt: number): void {
    const s = h.snap;
    const cls = CLASSES[h.cls];
    const a = this.time * 0.55 + s.slot * 1.57;
    const px = s.x;
    const pz = s.z;
    s.x = Math.sin(a) * (4 + s.slot) * 1.2;
    s.z = Math.cos(a * 1.3) * 3.2 + 2;
    if (this.fight) {
      // the party holds a loose knot around the shard, as real groups do
      s.x = h.homeX + Math.sin(a * 1.7) * 0.9;
      s.z = h.homeZ + Math.cos(a * 1.3) * 0.7;
    }
    const moveRot = Math.atan2(s.x - px, s.z - pz);
    h.t -= dt;
    if (h.t <= 0) {
      h.step++;
      const attack = h.step % 3 !== 0;
      const secondary = h.step % 9 === 4;
      // update 3 load: every hero also keeps throwing its art and its ultimate (zones, buffs, the star, leaps)
      const special: PlayerAnim | null = h.step % 14 === 7 && !this.fight ? 'ultimate' : h.step % 9 === 1 ? 'art' : null;
      const ab = special === 'ultimate' ? cls.ultimate : special === 'art' ? cls.arts[0] : secondary ? cls.secondary : cls.primary[h.step % cls.primary.length];
      s.anim = attack ? ab.anim : 'run';
      s.animSeq++;
      h.t = attack ? Math.max(0.35, ab.lock + 0.1) : 0.5;
      if (attack && special) {
        s.rot = Math.atan2(-s.x, -1 - s.z);
        s.animSeq--;
        this.perform(h, special);
      } else if (attack) {
        s.rot = Math.atan2(-s.x, -1 - s.z);
        this.emit({ e: 'cast', who: { t: 'p', id: s.slot }, ability: ab.id, x: s.x, z: s.z, rot: s.rot });
        if (ab.projectile) for (let i = 0; i < ab.count; i++) this.shoot(ab.projectile, s.x, s.z, s.rot + (i - (ab.count - 1) / 2) * 0.2, ab.speed, ab.range, h.step % 5, false);
      }
    }
    if (s.anim === 'run') s.rot = moveRot;
  }

  /**
   * mode=fight: what a maxed four-hero party does to a special-objective chamber. Area abilities strike every enemy
   * in reach at once and again a moment later (the piles of numbers of the live captures), and at `at` all four
   * ultimates go off within half a second, followed by a chain of reactions, while hostile telegraphs lie across it.
   */
  private fightScript(dt: number): void {
    this.fightHit -= dt;
    while (this.fightHit <= 0) {
      this.fightHit += FIGHT.VOLLEY_EVERY;
      const by = Math.floor(rnd() * SLOTS);
      const h = this.heroes[by].snap;
      const cx = h.x * 0.5 + (rnd() - 0.5) * 5;
      const cz = h.z - 2.5 + (rnd() - 0.5) * 4;
      const el = rnd() < 0.7 ? ELEMENT_IDS[Math.floor(rnd() * ELEMENT_IDS.length)] : null;
      const dmg = FIGHT.DAMAGE[Math.floor(rnd() * FIGHT.DAMAGE.length)];
      for (const e of this.enemies) {
        if (e.gone > 0 || e.snap.anim === 'spawn' || Math.hypot(e.snap.x - cx, e.snap.z - cz) > FIGHT.VOLLEY_RADIUS) continue;
        const crit = rnd() < 0.2;
        this.emit({ e: 'hit', target: { t: 'e', id: e.snap.id }, x: e.snap.x, z: e.snap.z, dmg: crit ? dmg * 2 - 1 : dmg, crit, el, by });
      }
      if (rnd() < 0.3) this.emit({ e: 'heal', slot: Math.floor(rnd() * SLOTS), amount: 11 });
    }
    if (this.fightDone || this.time < this.demoAt - FIGHT.LEAD) return;
    this.fightDone = true;
    // warnings first: three circles, a lane and a cleave right where the party stands and where the ultimates will land
    FIGHT.CIRCLES.forEach(([x, z, r]) => this.emit({ e: 'telegraph', shape: 'circle', x, z, rot: 0, r, w: 0, dur: FIGHT.TELEGRAPH }));
    this.emit({ e: 'telegraph', shape: 'line', x: -11, z: 1.2, rot: Math.PI / 2 - 0.12, r: 22, w: 1.6, dur: FIGHT.TELEGRAPH });
    this.emit({ e: 'telegraph', shape: 'arc', x: 1.5, z: -3.2, rot: 0.2, r: 4.2, w: 130 * DEG, dur: FIGHT.TELEGRAPH });
    this.heroes.forEach((h, i) => this.later(FIGHT.LEAD + i * 0.12, () => {
      h.snap.rot = Math.atan2(-h.snap.x, -2 - h.snap.z);
      this.perform(h, 'ultimate');
      h.t = 1.6;
    }));
    // the chain: every reaction once, then twice more, from all four heroes, inside two thirds of a second
    for (let k = 0; k < FIGHT.CHAIN; k++) {
      this.later(FIGHT.LEAD + 0.5 + k * 0.07, () => {
        const [a, b] = ELEMENT_PAIRS[k % ELEMENT_PAIRS.length];
        const x = -5 + (k % 4) * 3.4 + (rnd() - 0.5);
        const z = -3.5 + Math.floor(k / 4) * 2.6 + (rnd() - 0.5);
        this.emit({ e: 'resonance', x, z, r: STATUS.RESONANCE.RADIUS * REACTIONS[k % REACTIONS.length].radiusMul, a, b, by: k % SLOTS });
        this.emit({ e: 'aoe', x, z, r: STATUS.RESONANCE.RADIUS, el: b, hostile: false });
      });
    }
  }

  // ---------------------------------------------------------------------------------------------- enemies

  private telegraphFor(e: EnemyActor, anim: EnemyAnim): void {
    const s = e.snap;
    const def = enemyDef(s.kind);
    const fx = s.x + Math.sin(s.rot);
    const fz = s.z + Math.cos(s.rot);
    const T = ENEMY_TUNING;
    const big = s.kind === 'regent' ? T.REGENT : T.CHAMPION;
    if (anim === 'windup') {
      // like the simulation, every basic attack names its source, so a stun or a kill can take the warning away
      const src = s.id;
      if (s.kind === 'minion') this.emit({ e: 'telegraph', shape: 'arc', x: s.x, z: s.z, rot: s.rot, r: def.attackRange + 0.6, w: T.MINION_ARC_DEG * DEG, dur: def.windup, src });
      else if (s.kind === 'warrior') this.emit({ e: 'telegraph', shape: 'arc', x: s.x, z: s.z, rot: s.rot, r: def.attackRange + 0.6, w: T.WARRIOR_ARC_DEG * DEG, dur: def.windup, src });
      else if (s.kind === 'archer') this.emit({ e: 'telegraph', shape: 'line', x: fx, z: fz, rot: s.rot, r: 9, w: 0.6, dur: def.windup, src });
      else if (s.kind === 'mage') this.emit({ e: 'telegraph', shape: 'circle', x: s.x + Math.sin(s.rot) * 5, z: s.z + Math.cos(s.rot) * 5, rot: 0, r: T.MAGE_BLAST_RADIUS, w: 0, dur: def.windup, src });
      else this.emit({ e: 'telegraph', shape: 'arc', x: s.x, z: s.z, rot: s.rot, r: def.attackRange, w: 120 * DEG, dur: def.windup, src });
    } else if (anim === 'sweep') {
      this.emit({ e: 'telegraph', shape: 'arc', x: s.x, z: s.z, rot: s.rot, r: big.SWEEP_REACH, w: big.SWEEP_ARC_DEG * DEG, dur: def.windup });
    } else if (anim === 'charge') {
      this.emit({ e: 'telegraph', shape: 'line', x: s.x, z: s.z, rot: s.rot, r: big.CHARGE_LENGTH * 0.7, w: big.CHARGE_WIDTH, dur: big.CHARGE_WINDUP });
    } else if (anim === 'slam') {
      const r = T.REGENT;
      this.emit({ e: 'telegraph', shape: 'circle', x: s.x + Math.sin(s.rot) * 3, z: s.z + Math.cos(s.rot) * 3, rot: 0, r: r.SLAM_RADIUS, w: 0, dur: e.slamCount === 0 ? r.SLAM_WINDUP : r.SLAM_INTERVAL });
    }
  }

  private stepEnemy(e: EnemyActor, dt: number): boolean {
    const s = e.snap;
    if (e.gone > 0) {
      e.gone -= dt;
      if (e.gone <= 0) {
        s.id = this.nextId++; s.hp = 1; s.x = e.homeX; s.z = e.homeZ; s.flags &= EF.ELITE; e.step = -1; e.t = 0; e.cycle++; e.slamCount = 0;
        this.emit({ e: 'spawn', id: s.id, kind: s.kind, x: s.x, z: s.z, elite: (s.flags & EF.ELITE) !== 0 });
      } else return false;
    }
    if (e.statusDemo) {
      s.anim = 'idle';
      s.rot = 0;
      const idx = Math.floor(this.time / 1.6 + s.id) % FLAG_DEMOS.length;
      const flags = EF.ELITE | FLAG_DEMOS[idx];
      if (flags !== s.flags) {
        if ((s.flags & EF.SHIELDED) && !(flags & EF.SHIELDED)) this.emit({ e: 'shieldBreak', id: s.id });
        for (const el of ELEMENT_IDS) {
          const bit = STATUS_BIT[el];
          if ((flags & bit) && !(s.flags & bit)) this.emit({ e: 'status', id: s.id, el });
        }
        s.flags = flags;
        s.anim = flags & EF.STUNNED ? 'stun' : 'idle';
        s.hp = 0.25 + ((idx * 37) % 70) / 100;
      } else if (s.flags & EF.STUNNED) s.anim = 'stun';
      return true;
    }
    e.t -= dt;
    if (e.t <= 0) {
      e.step++;
      if (e.step >= e.script.length) {
        // odd cycles: the row just disappears while showing `death` (no kill event)
        e.gone = 1.6;
        return false;
      }
      const step = e.script[e.step];
      const prevAnim = s.anim;
      e.t = step.dur;
      s.anim = step.anim;
      s.animSeq++;
      s.rot = 0;
      s.flags &= ~EF.STUNNED;
      if (step.anim === 'stun') s.flags |= EF.STUNNED;
      // a stun in the middle of a wind-up is announced, as the simulation does
      if (step.anim === 'stun' && (prevAnim === 'windup' || prevAnim === 'cast' || prevAnim === 'summon')) this.emit({ e: 'interrupt', id: s.id });
      const boss2 = s.kind === 'matron' || s.kind === 'stalker';
      if (HORDE_KINDS.includes(s.kind)) {
        this.hordeStep(e, step.anim, prevAnim);
        if (step.anim === 'death') {
          s.hp = 0;
          if (e.gone <= 0) { this.emit({ e: 'kill', id: s.id, kind: s.kind, x: s.x, z: s.z, by: 0 }); e.gone = 2.8; }
          return false;
        }
        if (e.gone > 0) return false;
      } else if (boss2 && step.anim !== 'death') {
        const before = e.step > 0 ? e.script[e.step - 1].anim : prevAnim;
        this.boss2Step(e, step.anim, e.step >= 2 && step.anim === 'volley' ? e.script[e.step - 2].anim : before);
      } else if (step.anim === 'slam') e.slamCount++; else e.slamCount = 0;
      const horde = HORDE_KINDS.includes(s.kind);
      if (!boss2 && !horde) this.telegraphFor(e, step.anim === 'slam' ? 'slam' : step.anim);
      if (step.anim === 'slam') e.slamCount = Math.max(1, e.slamCount);
      if ((boss2 && step.anim !== 'death') || horde) { /* scripted above */ } else if (step.anim === 'attack' || step.anim === 'cast') {
        this.emit({ e: 'cast', who: { t: 'e', id: s.id }, ability: `${s.kind}_${step.anim}`, x: s.x, z: s.z, rot: s.rot });
        if (s.kind === 'archer') this.shoot('boneArrow', s.x, s.z + 1, 0, ENEMY_TUNING.ARROW_SPEED, 9, 0, true);
        if (s.kind === 'mage') this.emit({ e: 'aoe', x: s.x, z: s.z + 5, r: ENEMY_TUNING.MAGE_BLAST_RADIUS, el: null, hostile: true });
      } else if (step.anim === 'summon') {
        this.emit({ e: 'cast', who: { t: 'e', id: s.id }, ability: `${s.kind}_summon`, x: s.x, z: s.z, rot: s.rot });
      } else if (step.anim === 'volley') {
        this.emit({ e: 'cast', who: { t: 'e', id: s.id }, ability: 'regent_volley', x: s.x, z: s.z, rot: s.rot });
        const n = ENEMY_TUNING.REGENT.VOLLEY_ORBS;
        this.later(ENEMY_TUNING.REGENT.VOLLEY_WINDUP, () => {
          for (let i = 0; i < n; i++) this.shoot('hexOrb', s.x, s.z, (i / n) * Math.PI * 2, ENEMY_TUNING.REGENT.VOLLEY_SPEED, 12, 0, true);
        });
      } else if (step.anim === 'death') {
        s.hp = 0;
        if (e.cycle % 2 === 0) {
          this.emit({ e: 'kill', id: s.id, kind: s.kind, x: s.x, z: s.z, by: 0 });
          e.gone = 2.8;
          return false;
        }
      } else if (step.anim === 'idle' && e.step > 2 && s.kind === 'regent' && e.script[e.step - 1].anim === 'slam') {
        this.emit({ e: 'bossPhase', phase: 2 });
      }
    }
    const step = e.script[Math.max(0, e.step)];
    const k = 1 - e.t / step.dur;
    if (step.anim === 'move') {
      const a = k * Math.PI * 2;
      s.x = e.homeX + Math.sin(a) * 1.3;
      s.z = e.homeZ + (1 - Math.cos(a)) * 1.3;
      s.rot = a + Math.PI / 2;
    } else if (step.anim === 'leap') {
      s.x = e.fromX + (e.toX - e.fromX) * Math.min(1, k);
      s.z = e.fromZ + (e.toZ - e.fromZ) * Math.min(1, k);
    } else if (s.kind === 'reaver' && step.anim !== 'idle') {
      // stays where it landed until it leaps back
    } else if (step.anim === 'charge' && s.kind === 'stalker') {
      s.z = e.homeZ + Math.max(0, Math.min(1, (step.dur - e.t - 0.8) / 0.4)) * 8;
    } else if (step.anim === 'charge') {
      const big = s.kind === 'regent' ? ENEMY_TUNING.REGENT : ENEMY_TUNING.CHAMPION;
      const el = step.dur - e.t - big.CHARGE_WINDUP;
      const len = big.CHARGE_LENGTH * 0.7;
      s.z = e.homeZ + Math.max(0, Math.min(1, el / (len / big.CHARGE_SPEED))) * len;
    } else if (step.anim === 'idle' && s.kind !== 'stalker' && s.kind !== 'reaver') {
      s.z += (e.homeZ - s.z) * Math.min(1, dt * 6);
      s.x = e.homeX;
    }
    if (step.anim !== 'spawn' && step.anim !== 'death') {
      // constant chip damage so health bars and numbers show
      if (!this.calm && rnd() < dt * 0.9) {
        const el = rnd() < 0.5 ? ELEMENT_IDS[Math.floor(rnd() * ELEMENT_IDS.length)] : null;
        const crit = rnd() < 0.2;
        s.hp = Math.max(0.12, s.hp - 0.07);
        this.emit({ e: 'hit', target: { t: 'e', id: s.id }, x: s.x, z: s.z, dmg: Math.round((crit ? 2 : 1) * (9 + rnd() * 30)), crit, el, by: 0 });
      }
    }
    return true;
  }

  private stressEnemy(e: EnemyActor, dt: number, i: number): boolean {
    const s = e.snap;
    if (e.gone > 0) {
      e.gone -= dt;
      if (e.gone > 0) return false;
      s.id = this.nextId++; s.hp = 1; s.anim = 'spawn'; s.animSeq++; e.t = enemyDef(s.kind).spawnTime; e.step = 0;
      this.emit({ e: 'spawn', id: s.id, kind: s.kind, x: s.x, z: s.z, elite: (s.flags & EF.ELITE) !== 0 });
      if (s.kind === 'aegis') {
        const id = s.id;
        this.later(enemyDef(s.kind).spawnTime, () => { if (e.snap.id === id) this.emit({ e: 'dome', id, on: true, r: HT.AEGIS.DOME_RADIUS }); });
      }
    }
    const target = this.heroes[i % this.heroes.length].snap;
    const dx = target.x - s.x;
    const dz = target.z - s.z;
    const dist = Math.hypot(dx, dz) || 1;
    const def = enemyDef(s.kind);
    s.rot = Math.atan2(dx, dz);
    e.t -= dt;
    if (s.anim === 'move') {
      const keep = s.kind === 'archer' || s.kind === 'mage' ? 7 : def.attackRange * 0.8;
      const swirl = 0.6;
      const dir = dist > keep ? 1 : -0.4;
      s.x += ((dx / dist) * dir - (dz / dist) * swirl) * def.speed * dt;
      s.z += ((dz / dist) * dir + (dx / dist) * swirl) * def.speed * dt;
    }
    if (e.t <= 0) {
      const next: EnemyAnim = s.anim === 'spawn' ? 'move' : s.anim === 'move' ? 'windup' : s.anim === 'windup' ? 'attack' : 'move';
      s.anim = next;
      s.animSeq++;
      e.t = next === 'move' ? 1.2 + rnd() * 2.5 : next === 'windup' ? def.windup : 0.5;
      if (next === 'windup' && s.kind === 'bomber') {
        this.tele(e, 'circle', s.x, s.z, 0, HT.BOMBER.BLAST_RADIUS, 0, def.windup);
        this.emit({ e: 'cast', who: { t: 'e', id: s.id }, ability: 'fuse', x: s.x, z: s.z, rot: s.rot });
      } else if (next === 'windup' && s.kind === 'shaman') {
        this.emit({ e: 'cast', who: { t: 'e', id: s.id }, ability: 'mend', x: s.x, z: s.z, rot: s.rot });
        e.t = HT.SHAMAN.MEND_WINDUP;
      } else if (next === 'windup' && s.kind === 'necromancer') {
        this.emit({ e: 'cast', who: { t: 'e', id: s.id }, ability: 'raise', x: s.x, z: s.z, rot: s.rot });
      } else if (next === 'windup') this.telegraphFor(e, 'windup');
      if (next === 'attack' && s.kind === 'shaman') {
        const targets = this.enemies.filter((o) => o !== e && o.gone <= 0 && Math.hypot(o.snap.x - s.x, o.snap.z - s.z) <= HT.SHAMAN.MEND_RADIUS).slice(0, 6).map((o) => o.snap.id);
        this.emit({ e: 'mend', id: s.id, targets });
      } else if (next === 'attack' && s.kind === 'bomber') {
        this.emit({ e: 'aoe', x: s.x, z: s.z, r: HT.BOMBER.BLAST_RADIUS, el: null, hostile: true });
        this.emit({ e: 'kill', id: s.id, kind: s.kind, x: s.x, z: s.z, by: -1 });
        e.gone = 1.2;
        return false;
      }
      if (next === 'attack') {
        if (s.kind === 'archer') this.shoot('boneArrow', s.x, s.z, s.rot, ENEMY_TUNING.ARROW_SPEED, 16, 0, true);
        if (s.kind === 'mage') this.emit({ e: 'aoe', x: s.x + Math.sin(s.rot) * 5, z: s.z + Math.cos(s.rot) * 5, r: ENEMY_TUNING.MAGE_BLAST_RADIUS, el: null, hostile: true });
        if (s.kind === 'regent') for (let k = 0; k < 16; k++) this.shoot('hexOrb', s.x, s.z, (k / 16) * Math.PI * 2, 9, 14, 0, true);
      }
    }
    return true;
  }

  // ---------------------------------------------------------------------------------------------- frame

  private simulateMenu(dt: number): void {
    this.time += dt;
    this.playerRows.length = 0;
    this.enemyRows.length = 0;
    this.projectileRows.length = 0;
    if (!this.menuAuto) return;
    // cycle: three looks per class (colour only, then outfit), then the next class
    this.menuTimer += dt;
    if (this.menuTimer < 2.6) return;
    this.menuTimer = 0;
    const n = this.counters.event++;
    if (n % 3 === 2) { this.menuCls = (this.menuCls + 1) % CLASS_IDS.length; this.menuLook = { ...DEFAULT_LOOK }; }
    else if (n % 3 === 0) this.menuLook = { ...this.menuLook, color: 1 + Math.floor(rnd() * (LOOK.COLORS.length - 1)) };
    else this.menuLook = this.randomLook();
    this.applyMenu();
  }

  private simulate(dt: number): void {
    if (this.menu) { this.simulateMenu(dt); return; }
    this.time += dt;
    // hazard demo: whoever stands on an active plate gets the matching impact once in a while
    if (this.room.hazards.length > 0 && rnd() < dt * 1.2) {
      const h = this.room.hazards[Math.floor(rnd() * this.room.hazards.length)];
      const victim = this.enemies.find((e) => e.gone <= 0 && Math.hypot(e.snap.x - h.x, e.snap.z - h.z) < h.r + 1.5);
      if (victim) this.emit({ e: 'hazardHit', target: { t: 'e', id: victim.snap.id }, kind: h.kind });
    }
    for (let i = this.pending.length - 1; i >= 0; i--) {
      if (this.pending[i].at > this.time) continue;
      const [due] = this.pending.splice(i, 1);
      due.fn();
    }
    const hw = this.room.w / 2;
    const hd = this.room.d / 2;

    this.playerRows.length = 0;
    for (const h of this.heroes) {
      if (this.demo) this.demoHero(h, dt); else if (this.stress) this.stressHero(h, dt); else this.stepHero(h, dt);
      this.playerRows.push(h.snap);
    }
    this.enemyRows.length = 0;
    this.enemies.forEach((e, i) => {
      const visible = this.stress ? this.stressEnemy(e, dt, i) : this.stepEnemy(e, dt);
      if (visible) this.enemyRows.push(e.snap);
    });

    const t = this.timers;
    const c = this.counters;
    this.runDemo();
    if (this.demo) {
      // a demo stage is quiet: nothing but what the demo itself fires
    } else if (this.stress) {
      // 44 enemies, ~60 projectiles in flight and constant combat VFX
      t.shot -= dt;
      while (this.shots.length < 60 && t.shot <= 0) {
        const demo = PROJECTILE_DEMO[c.shot++ % PROJECTILE_DEMO.length];
        const a = rnd() * Math.PI * 2;
        this.shoot(demo.kind, Math.sin(a) * 3, Math.cos(a) * 3, rnd() * Math.PI * 2, 9 + rnd() * 8, 14, demo.hostile ? 0 : c.shot % 4, demo.hostile);
        t.shot += 0.02;
      }
      if (t.shot <= 0) t.shot = 0.05;
      t.hit -= dt;
      while (t.hit <= 0) {
        t.hit += 0.05;
        const e = this.enemies[Math.floor(rnd() * this.enemies.length)];
        if (e.gone > 0 || e.snap.anim === 'spawn') continue;
        const el = rnd() < 0.6 ? ELEMENT_IDS[Math.floor(rnd() * ELEMENT_IDS.length)] : null;
        const crit = rnd() < 0.15;
        e.snap.hp -= e.snap.kind === 'regent' || e.snap.kind === 'champion' ? 0.004 : 0.09;
        this.emit({ e: 'hit', target: { t: 'e', id: e.snap.id }, x: e.snap.x, z: e.snap.z, dmg: Math.round(10 + rnd() * 40), crit, el, by: Math.floor(rnd() * 4) });
        if (el) {
          const bit = STATUS_BIT[el];
          const had = e.snap.flags & ANY_STATUS;
          if (had && !(had & bit)) {
            const prev: ElementId = had & EF.BURN ? 'ember' : had & EF.CHILL ? 'rime' : had & EF.SHOCK ? 'storm' : 'umbra';
            this.emit({ e: 'resonance', x: e.snap.x, z: e.snap.z, r: STATUS.RESONANCE.RADIUS, a: prev, b: el, by: 0 });
          }
          e.snap.flags = (e.snap.flags & ~ANY_STATUS) | bit;
          this.emit({ e: 'status', id: e.snap.id, el });
        }
        if (e.snap.hp <= 0) {
          this.emit({ e: 'kill', id: e.snap.id, kind: e.snap.kind, x: e.snap.x, z: e.snap.z, by: 0 });
          e.gone = 0.9;
          const a = rnd() * Math.PI * 2;
          e.snap.x = Math.sin(a) * (hw - 3) * rnd(); e.snap.z = Math.cos(a) * (hd - 3) * rnd();
          e.snap.flags &= EF.ELITE;
        }
      }
      if (this.fight) this.fightScript(dt);
      t.stressFx -= dt;
      if (t.stressFx <= 0) {
        t.stressFx = 0.7;
        const h = this.heroes[c.event++ % 4].snap;
        this.emit({ e: 'hit', target: { t: 'p', id: h.slot }, x: h.x, z: h.z, dmg: 12, crit: false, el: null, by: -1 });
        if (c.event % 4 === 0) this.emit({ e: 'heal', slot: h.slot, amount: 20 });
      }
    } else {
      // feature carousel around the demo rows
      t.tele -= dt;
      if (t.tele <= 0) {
        t.tele = 1.7;
        const n = c.tele++ % 3;
        const x = hw - 6;
        if (n === 0) this.emit({ e: 'telegraph', shape: 'circle', x, z: 4.5, rot: 0, r: 2.2, w: 0, dur: 1.3 });
        else if (n === 1) this.emit({ e: 'telegraph', shape: 'arc', x: x - 5, z: 6.5, rot: NORTH, r: 3.6, w: 140 * DEG, dur: 1.3 });
        else this.emit({ e: 'telegraph', shape: 'line', x: x + 2.5, z: 8, rot: NORTH + 0.25, r: 9, w: 1.6, dur: 1.3 });
      }
      t.reso -= dt;
      if (t.reso <= 0) {
        t.reso = 1.5;
        const [a, b] = ELEMENT_PAIRS[c.reso++ % ELEMENT_PAIRS.length];
        this.emit({ e: 'resonance', x: -hw + 4 + (c.reso % 3) * 2.2, z: hd - 2.4, r: STATUS.RESONANCE.RADIUS, a, b, by: 0 });
      }
      t.shot -= dt;
      if (t.shot <= 0) {
        t.shot = 0.42;
        const n = c.shot++;
        const demo = PROJECTILE_DEMO[n % PROJECTILE_DEMO.length];
        const lane = n % PROJECTILE_DEMO.length;
        const el = demo.hostile ? 0 : Math.floor(n / PROJECTILE_DEMO.length) % 4;
        if (demo.hostile) this.shoot(demo.kind, hw - 2, 0.6 + lane * 0.55, -Math.PI / 2, 10, this.room.w - 4, el, true);
        else this.shoot(demo.kind, -hw + 2, 0.6 + lane * 0.55, Math.PI / 2, 11, this.room.w - 4, el, false);
      }
      t.event -= dt;
      if (t.event <= 0) {
        t.event = 6;
        if (c.event++ % 2 === 0) this.emit({ e: 'chamberClear' });
        else if (this.doors.length > 0) this.emit({ e: 'doorChosen', type: this.doors[c.event % this.doors.length].type });
        this.emit({ e: 'wave', wave: 1, waveCount: 3 });
      }
    }

    // projectiles
    this.projectileRows.length = 0;
    for (let i = this.shots.length - 1; i >= 0; i--) {
      const p = this.shots[i];
      p.life -= dt;
      if (p.seek >= 0) {
        // homing wisp: turns towards its hero at a limited rate
        const h = this.heroes[p.seek % this.heroes.length].snap;
        const want = Math.atan2(h.x - p.snap.x, h.z - p.snap.z);
        let diff = want - p.snap.rot;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        const turn = MT.WISP_TURN_DEG * DEG * dt;
        p.snap.rot += Math.max(-turn, Math.min(turn, diff));
        p.vx = Math.sin(p.snap.rot) * p.speed;
        p.vz = Math.cos(p.snap.rot) * p.speed;
      }
      p.snap.x += p.vx * dt;
      p.snap.z += p.vz * dt;
      if (p.life <= 0 || Math.abs(p.snap.x) > hw - 0.5 || Math.abs(p.snap.z) > hd - 0.5) {
        this.shots[i] = this.shots[this.shots.length - 1];
        this.shots.pop();
        continue;
      }
      this.projectileRows.push(p.snap);
    }

    // doors
    if (this.doorsOn && !this.stress && this.time > 2.5) {
      if (this.doors.length === 0) {
        // after a final boss the two doors of the endless descent stand side by side
        const types: Door['type'][] = this.demo === 'doors' ? ['descend', 'ascend']
          : this.demo === 'objdoors' ? (this.doorSet === 1 ? ['boon', 'cursed', 'blessing'] : ['boon', 'blessing', 'cursed', 'boon'])
            : this.kind === 'combat' ? ['boon', 'blessing', 'cursed'] : this.kind === 'elite' ? ['boon', 'boss'] : ['descend', 'ascend'];
        // what the chamber behind each door asks for; the ordinary carousel shows two of them as well
        const goals: ObjectiveKind[] = this.demo === 'objdoors' ? (this.doorSet === 1 ? ['vault', 'ritual', 'slay'] : ['survive', 'defend', 'hunt', 'ritual'])
          : this.kind === 'combat' ? ['slay', 'defend', 'hunt'] : ['slay', 'slay'];
        const span = this.kind === 'boss' ? 26 : this.demo === 'objdoors' ? 20 : 16;
        this.doors = types.map((type, i) => ({ type, x: types.length === 1 ? 0 : -span / 2 + (i / (types.length - 1)) * span, z: -hd + 2.4, objective: goals[i] ?? 'slay' }));
        this.doorProgress = types.map(() => 0);
      }
      this.doors.forEach((_, i) => { this.doorProgress[i] = i === 0 ? Math.max(0, Math.sin(this.time * 0.9)) : i === 1 ? ((this.time * 0.25) % 1) : 0; });
      this.view.setDoors(this.doors, this.doorProgress);
    } else {
      this.doors = [];
      this.view.setDoors(this.doors, this.doorProgress);
    }
  }

  private applyFocus(): void {
    const name = this.focusName;
    if (this.focusFree) { this.view.debugFocus(this.focusFree); return; }
    if (!name) { this.view.debugFocus(null); return; }
    if (/^hero\d$/.test(name)) {
      const h = this.heroes[Number(name.slice(4)) % this.heroes.length];
      this.view.debugFocus({ x: h.snap.x, z: h.snap.z - 0.4, zoom: 0.3 });
    } else if (/^enemy\d+$/.test(name)) {
      const e = this.enemies[Number(name.slice(5)) % this.enemies.length];
      const s = enemyDef(e.snap.kind).scale;
      this.view.debugFocus({ x: e.snap.x, z: e.snap.z - 0.5 * s, zoom: 0.3 * Math.max(1, s * 0.8) });
    } else if (name === 'elites') this.view.debugFocus({ x: -4.6, z: -7.4, zoom: 0.42 });
    else if (name === 'heroes') this.view.debugFocus({ x: 0, z: this.room.d / 2 - 5, zoom: 0.5 });
    else if (name === 'enemies') this.view.debugFocus({ x: 0, z: -3, zoom: 0.62 });
    else if (name === 'telegraphs') this.view.debugFocus({ x: this.room.w / 2 - 7.5, z: 4, zoom: 0.5 });
    else if (name === 'doors') this.view.debugFocus({ x: 0, z: -this.room.d / 2 + 2.5, zoom: 0.62 });
    else if (name === 'throne') this.view.debugFocus({ x: 0, z: -this.room.d / 2 - 1, zoom: 0.6 });
    else if (name === 'resonance') this.view.debugFocus({ x: -this.room.w / 2 + 6.2, z: this.room.d / 2 - 3, zoom: 0.45 });
    else if (name === 'room') this.view.debugFocus({ x: 0, z: -1, zoom: 1.45 });
    else if (name === 'boss') {
      const e = this.enemies.find((x) => BOSS_KINDS.includes(x.snap.kind as BossKind));
      if (e) this.view.debugFocus({ x: e.snap.x, z: e.snap.z - 1.2, zoom: 0.46 });
    } else if (name === 'bossfight') {
      const e = this.enemies.find((x) => BOSS_KINDS.includes(x.snap.kind as BossKind));
      if (e) this.view.debugFocus({ x: e.homeX - 2.5, z: e.homeZ + 3, zoom: 0.68 });
    } else if (name === 'hazards') this.view.debugFocus({ x: -0.4, z: 2, zoom: 0.52 });
    else if (name === 'hazardsL') this.view.debugFocus({ x: -6.2, z: 2, zoom: 0.36 });
    else if (name === 'hazardsR') this.view.debugFocus({ x: 4, z: 2, zoom: 0.36 });
    else if (name === 'marker') this.view.debugFocus({ x: 0, z: this.room.d / 2 - 2.6, zoom: 0.4 });
    else if (name === 'south') this.view.debugFocus({ x: 0, z: this.room.d / 2 - 1, zoom: 0.7 });
  }

  private readonly frame = (now: number): void => {
    requestAnimationFrame(this.frame);
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.frameMs += (dt * 1000 - this.frameMs) * 0.1;
    if (this.time >= this.freezeAt && !this.frozen) {
      this.frozen = true;
      this.setFastForward(false);
    }
    const fast = Number.isFinite(this.freezeAt) && !this.frozen;
    const step = this.paused || this.frozen ? 0 : fast ? 1 / 30 : dt;
    const t0 = performance.now();
    for (let n = fast ? 30 : 1; n > 0; n--) {
      if (step > 0) this.simulate(step);
      this.view.setServerTick(this.time * NET.TICK_HZ);
      if (!this.menu) this.applyFocus();
      this.view.setObjective(this.menu ? null : this.objective);
      this.view.syncPlayers(this.playerRows, this.local);
      this.view.syncEnemies(this.enemyRows);
      this.view.syncProjectiles(this.projectileRows);
      this.view.update(step, !fast || n === 1);
      if (this.time >= this.freezeAt) break;
    }
    this.jsMs += (performance.now() - t0 - this.jsMs) * 0.1;
    const s = this.view.getStats();
    const d = this.view.getDebug();
    this.overlay.textContent = `${this.menu ? `MENU ${CLASS_IDS[this.menuCls]} ${JSON.stringify(this.menuLook)}` : `${this.biome} · ${this.kind}`} · ${d.quality}${this.stress ? ' · STRESS' : ''}${this.frozen ? ' · frozen' : ''}\n`
      + `draw calls ${s.drawCalls}   tris ${(s.triangles / 1000).toFixed(1)}k\n`
      + `frame JS ${this.jsMs.toFixed(1)} ms   ${(1000 / this.frameMs).toFixed(0)} fps\n`
      + `enemies ${d.enemies}  proj ${d.projectiles}  particles ${d.particles}\n`
      + `decals ${d.decals}  fx ${d.fxSprites}  ui ${d.uiSprites}  geo ${s.geometries} tex ${s.textures}\n`
      + `zones ${d.zones}  depth ${d.depth}  domes ${d.domes}  objective ${d.objective ?? '-'}${this.demo ? `  demo ${this.demo}` : ''}\n`
      + `hazards ${d.hazards}  hero bakes ${d.heroTemplates}  cursor ${this.cursor.x.toFixed(1)}, ${this.cursor.z.toFixed(1)}\n`
      + '[1/2/3] chamber [4/5/6] biome [B]oss [L]ooks [M]enu [T] marker [C]lasses de[X]cend\n'
      + '[Q]uality [S]tress [D]oors [Z]oom [N]umbers [F]ocus [P]ause';
  };

  /** While fast-forwarding to a `freeze=` time the canvas is tiny, so software WebGL does not slow the script down. */
  private setFastForward(on: boolean): void {
    const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
    canvas.style.width = on ? '128px' : '100vw';
    canvas.style.height = on ? '72px' : '100vh';
    this.view.resize();
  }

  /** Hook for automated screenshots. */
  snapshotInfo(): Record<string, unknown> {
    return { time: this.time, frozen: this.frozen, biome: this.biome, kind: this.kind, jsMs: this.jsMs, stats: { ...this.view.getStats() }, debug: this.view.getDebug() };
  }
}

/**
 * Dev helper for tuning HERO_ANIMS: samples a hero clip and reports when the weapon hand moves fastest (the visible
 * hit), so `impact` values do not have to be guessed. Returns [time of the peak, clip duration].
 */
function measureClip(assets: Assets, cls: ClassId, clipName: string): [number, number] | null {
  const clip = assets.heroClips.get(clipName);
  if (!clip) return null;
  const tpl = assets.heroTemplate(cls, DEFAULT_LOOK);
  const root = cloneSkinned(tpl.scene);
  const hand = root.getObjectByName('handslotr');
  const mixer = new AnimationMixer(root);
  mixer.clipAction(clip).play();
  const prev = new Vector3();
  const cur = new Vector3();
  let best = 0;
  let bestAt = 0;
  const step = 1 / 60;
  for (let t = 0; t <= clip.duration && hand; t += step) {
    mixer.setTime(t);
    root.updateMatrixWorld(true);
    cur.setFromMatrixPosition(hand.matrixWorld);
    const speed = t > 0 ? cur.distanceTo(prev) / step : 0;
    if (speed > best) { best = speed; bestAt = t; }
    prev.copy(cur);
  }
  mixer.stopAllAction();
  mixer.uncacheRoot(root);
  assets.releaseHero(tpl);
  return [Math.round(bestAt * 100) / 100, Math.round(clip.duration * 100) / 100];
}

async function main(): Promise<void> {
  document.body.style.cssText = 'margin:0;overflow:hidden;background:#05060b';
  const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
  canvas.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;display:block';
  const loading = document.createElement('div');
  loading.style.cssText = 'position:fixed;inset:0;display:grid;place-items:center;color:#7dffb4;font:16px ui-monospace,monospace';
  document.body.appendChild(loading);
  const assets = await loadAssets((loaded, total) => { loading.textContent = `loading ${loaded}/${total}`; });
  loading.remove();
  const view = new WorldView(canvas, assets);
  const showcase = new Showcase(view);
  (window as unknown as { __showcase: Showcase; __view: WorldView }).__showcase = showcase;
  (window as unknown as { __view: WorldView }).__view = view;
  (window as unknown as { __assets: Assets }).__assets = assets;
  (window as unknown as { __measure: (cls: ClassId, clip: string) => [number, number] | null }).__measure = (cls, clip) => measureClip(assets, cls, clip);
  document.title = 'ready';
}

main().catch((err: unknown) => {
  console.error('[showcase] failed to start', err);
});
