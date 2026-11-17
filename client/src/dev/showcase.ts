/**
 * Dev-only render kit showcase (http://localhost:5174/?showcase). No network: a scripted loop feeds fake snapshot
 * rows and GameEvents through every feature of WorldView.
 *
 * Keys: 1/2/3 chamber kind · 4/5/6 biome · B boss · L random looks · M menu showcase (cycles class + looks) · T marker
 *       Q quality · S stress mode · D doors · Z zoom · N damage numbers · F focus cycle · P pause
 * URL:  ?showcase&kind=boss&biome=forge&boss=stalker&quality=medium&mode=stress&focus=boss&freeze=4.5
 *       &looks=1 (varied looks) &same=knight (all four slots one class) &menu=mage&look=3,1,1,2&sx=0.7 &marker=0
 */
import { loadAssets, WorldView } from '../render/index.ts';
import { BIOME_IDS, BOSS_KINDS, CLASS_IDS, EF, ELEMENT_IDS, PF } from '@shared/types.ts';
import type {
  BiomeId, BossKind, ClassId, Door, ElementId, EnemyAnim, EnemyKind, EnemySnap, GameEvent, Hazard, Look, Obstacle, PlayerAnim, PlayerSnap,
  ProjectileKind, ProjectileSnap, RoomLayout,
} from '@shared/types.ts';
import type { ChamberKind } from '@shared/constants.ts';
import { CLASSES, DASH } from '@shared/data/classes.ts';
import { ENEMY_TUNING, STATUS } from '@shared/data/enemies.ts';
import { DEFAULT_LOOK, LOOK } from '@shared/data/meta.ts';
import { NET, WORLD } from '@shared/constants.ts';
import { enemyDef } from '../render/config.ts';
import type { Quality } from '../core/Settings.ts';

const DEG = Math.PI / 180;
let NORTH = Math.PI;
const QUALITIES: Quality[] = ['low', 'medium', 'high'];
const KINDS: ChamberKind[] = ['combat', 'elite', 'boss'];
const ROOM_SIZE: Record<ChamberKind, { w: number; d: number }> = {
  combat: { w: 28, d: 20 }, elite: { w: 30, d: 22 }, boss: { w: 36, d: 26 },
};
const NAMES = ['Aldric', 'Brunhild', 'Cyrene', 'Dax'];

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
  const base: EnemyStep[] = [
    { anim: 'spawn', dur: def.spawnTime + 0.15 }, { anim: 'idle', dur: 0.8 }, { anim: 'move', dur: 1.8 },
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

const FLAG_DEMOS = [EF.BURN, EF.CHILL, EF.SHOCK, EF.STUNNED, EF.SHIELDED, EF.ENRAGED, EF.BURN | EF.SHIELDED, EF.CHILL | EF.SHOCK | EF.ENRAGED, 0];
const PROJECTILE_DEMO: { kind: ProjectileKind; hostile: boolean }[] = [
  { kind: 'arcBolt', hostile: false }, { kind: 'crossbowBolt', hostile: false }, { kind: 'knife', hostile: false },
  { kind: 'boneArrow', hostile: true }, { kind: 'hexOrb', hostile: true },
  { kind: 'boneSpear', hostile: true }, { kind: 'soulWisp', hostile: true },
];
const ELEMENT_PAIRS: [ElementId, ElementId][] = [
  ['ember', 'rime'], ['ember', 'storm'], ['rime', 'ember'], ['rime', 'storm'], ['storm', 'ember'], ['storm', 'rime'],
];

class Showcase {
  private readonly view: WorldView;
  private kind: ChamberKind = 'combat';
  private biome: BiomeId = 'crypt';
  private boss: BossKind | null = null;
  private looks: Look[] = CLASS_IDS.map(() => ({ ...DEFAULT_LOOK }));
  private classes: ClassId[] = [...CLASS_IDS];
  private menu = false;
  private menuCls = 0;
  private menuLook: Look = { ...DEFAULT_LOOK };
  private menuAuto = true;
  private menuTimer = 0;
  private menuX = 0.7;
  private markerOn = true;
  private quality: Quality = 'high';
  private stress = false;
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
    this.stress = params.get('mode') === 'stress';
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
    if (same && CLASS_IDS.includes(same)) {
      this.classes = CLASS_IDS.map(() => same);
      // one class, four outfits: default, then the three gear styles with different colours / head / cape
      this.looks = [{ ...DEFAULT_LOOK }, { color: 2, head: true, cape: true, style: 1 }, { color: 4, head: false, cape: true, style: 2 }, { color: 7, head: true, cape: false, style: 0 }];
    }
    if (params.get('marker') === '0') this.markerOn = false;
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
    return { color: Math.floor(Math.random() * LOOK.COLORS.length), head: Math.random() < 0.7, cape: Math.random() < 0.7, style: Math.floor(Math.random() * LOOK.STYLES) };
  }

  private applyRoster(): void {
    this.view.setRoster(this.classes.map((cls, slot) => ({ slot, cls, name: NAMES[slot], look: this.looks[slot] })));
    // infusion demo: ember blade, rime secondary, storm bolts + storm dash, ember dash
    this.view.setInfusions(0, { primary: 'ember', secondary: null, dash: null });
    this.view.setInfusions(1, { primary: null, secondary: 'rime', dash: null });
    this.view.setInfusions(2, { primary: 'storm', secondary: null, dash: 'storm' });
    this.view.setInfusions(3, { primary: null, secondary: null, dash: 'ember' });
  }

  private applyMenu(): void {
    this.view.setShowcase(this.menu ? { cls: CLASS_IDS[this.menuCls], look: this.menuLook, screenX: this.menuX } : null);
  }

  private key(k: string): void {
    if (k === '1' || k === '2' || k === '3') { this.kind = KINDS[Number(k) - 1]; this.reset(); }
    else if (k === '4' || k === '5' || k === '6') { this.biome = BIOME_IDS[Number(k) - 4]; this.reset(); }
    else if (k === 'b') { this.boss = BOSS_KINDS[(BOSS_KINDS.indexOf(this.boss ?? BIOME_BOSS[this.biome]) + 1) % BOSS_KINDS.length]; this.reset(); }
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
    this.view.clearSession();
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
    this.timers = { tele: 0.5, reso: 1.2, shot: 0.3, event: 2, hit: 0.4, stressFx: 0 };
    const hd = this.room.d / 2;
    this.classes.forEach((cls, slot) => {
      const homeX = this.stress ? [-5, 5, -2, 2][slot] : -6 + slot * 4;
      const homeZ = this.stress ? [2, 2, 5, 5][slot] : hd - 4.5;
      const maxHp = CLASSES[cls].maxHp;
      this.heroes.push({
        cls, homeX, homeZ, step: -1, t: 0, offset: slot * 0.95,
        snap: {
          slot, x: homeX, z: homeZ, rot: NORTH, hp: maxHp * (1 - slot * 0.18), maxHp, shield: slot === 0 ? 20 : 0, state: 'alive', anim: 'idle', animSeq: 0,
          cdSecondary: 0, cdDash: 0, dashCharges: 1, revive: 0, flags: PF.CONNECTED | (slot === 2 ? PF.KINDRED_AURA : 0),
        },
      });
    });
    if (this.stress) {
      const mix: EnemyKind[] = [];
      for (let i = 0; i < 20; i++) mix.push('minion');
      for (let i = 0; i < 8; i++) mix.push('warrior');
      for (let i = 0; i < 8; i++) mix.push('archer');
      for (let i = 0; i < 6; i++) mix.push('mage');
      mix.push('champion', this.boss ?? BIOME_BOSS[this.biome]);
      mix.forEach((kind, i) => {
        const a = (i / mix.length) * Math.PI * 2;
        const r = 5 + (i % 5) * 1.6;
        this.addEnemy(kind, Math.sin(a) * r * 1.3, Math.cos(a) * r * 0.8 - 1, i % 7 === 0, false);
      });
    } else {
      (['minion', 'warrior', 'archer', 'mage', 'champion'] as EnemyKind[]).forEach((kind, i) => this.addEnemy(kind, -11 + i * 3.6, -2.4, false, false));
      this.addEnemy(this.boss ?? BIOME_BOSS[this.biome], 8.4, -4.4, false, false);
      (['minion', 'warrior', 'archer', 'mage'] as EnemyKind[]).forEach((kind, i) => this.addEnemy(kind, -8.5 + i * 2.6, -7, true, true));
    }
  }

  private addEnemy(kind: EnemyKind, x: number, z: number, elite: boolean, statusDemo: boolean): void {
    const actor: EnemyActor = {
      homeX: x, homeZ: z, step: -1, t: Math.random() * 0.2, cycle: 0, gone: 0, script: enemyScript(kind), statusDemo, slamCount: 0,
      leapBack: false, fromX: x, fromZ: z, toX: x, toZ: z,
      snap: { id: this.nextId++, kind, x, z, rot: 0, hp: 1, anim: 'spawn', animSeq: 0, flags: elite ? EF.ELITE : 0 },
    };
    if (this.stress) { actor.step = 1 + Math.floor(Math.random() * 3); actor.t = Math.random(); actor.snap.anim = 'move'; }
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

  // ---------------------------------------------------------------------------------------------- heroes

  private stepHero(h: HeroActor, dt: number): void {
    const s = h.snap;
    const cls = CLASSES[h.cls];
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
      if (step.anim === 'primary1' || step.anim === 'primary2' || step.anim === 'primary3' || step.anim === 'secondary') {
        const idx = step.anim === 'primary2' ? 1 : step.anim === 'primary3' ? 2 : 0;
        const a = step.anim === 'secondary' ? cls.secondary : cls.primary[Math.min(idx, cls.primary.length - 1)];
        s.anim = a.anim === 'primary1' && step.anim !== 'secondary' ? step.anim : a.anim;
        this.emit({ e: 'cast', who: { t: 'p', id: s.slot }, ability: a.id, x: s.x, z: s.z, rot: s.rot });
        if (step.anim === 'secondary') s.cdSecondary = 1;
        if (a.shape === 'projectile' && a.projectile) {
          const el = (this.counters.shot++ % 4);
          for (let i = 0; i < a.count; i++) {
            const spread = a.count > 1 ? ((i / (a.count - 1)) - 0.5) * a.arc * DEG : 0;
            this.shoot(a.projectile, s.x + Math.sin(s.rot) * 0.8, s.z + Math.cos(s.rot) * 0.8, s.rot + spread, a.speed, a.range, el, false);
          }
        } else if (a.shape === 'circle') {
          const tx = s.x;
          const tz = s.z - 7;
          this.emit({ e: 'telegraph', shape: 'circle', x: tx, z: tz, rot: 0, r: a.radius, w: 0, dur: a.windup });
          this.later(a.windup, () => this.emit({ e: 'aoe', x: tx, z: tz, r: a.radius, el: 'storm', hostile: false }));
        }
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
  }

  private stressHero(h: HeroActor, dt: number): void {
    const s = h.snap;
    const cls = CLASSES[h.cls];
    const a = this.time * 0.55 + s.slot * 1.57;
    const px = s.x;
    const pz = s.z;
    s.x = Math.sin(a) * (4 + s.slot) * 1.2;
    s.z = Math.cos(a * 1.3) * 3.2 + 2;
    const moveRot = Math.atan2(s.x - px, s.z - pz);
    h.t -= dt;
    if (h.t <= 0) {
      h.step++;
      const attack = h.step % 3 !== 0;
      const secondary = h.step % 9 === 4;
      const ab = secondary ? cls.secondary : cls.primary[h.step % cls.primary.length];
      s.anim = attack ? ab.anim : 'run';
      s.animSeq++;
      h.t = attack ? Math.max(0.35, ab.lock + 0.1) : 0.5;
      if (attack) {
        s.rot = Math.atan2(-s.x, -1 - s.z);
        this.emit({ e: 'cast', who: { t: 'p', id: s.slot }, ability: ab.id, x: s.x, z: s.z, rot: s.rot });
        if (ab.projectile) for (let i = 0; i < ab.count; i++) this.shoot(ab.projectile, s.x, s.z, s.rot + (i - (ab.count - 1) / 2) * 0.2, ab.speed, ab.range, h.step % 4, false);
      }
    }
    if (s.anim === 'run') s.rot = moveRot;
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
      if (s.kind === 'minion') this.emit({ e: 'telegraph', shape: 'arc', x: s.x, z: s.z, rot: s.rot, r: def.attackRange + 0.6, w: T.MINION_ARC_DEG * DEG, dur: def.windup });
      else if (s.kind === 'warrior') this.emit({ e: 'telegraph', shape: 'arc', x: s.x, z: s.z, rot: s.rot, r: def.attackRange + 0.6, w: T.WARRIOR_ARC_DEG * DEG, dur: def.windup });
      else if (s.kind === 'archer') this.emit({ e: 'telegraph', shape: 'line', x: fx, z: fz, rot: s.rot, r: 9, w: 0.6, dur: def.windup });
      else if (s.kind === 'mage') this.emit({ e: 'telegraph', shape: 'circle', x: s.x + Math.sin(s.rot) * 5, z: s.z + Math.cos(s.rot) * 5, rot: 0, r: T.MAGE_BLAST_RADIUS, w: 0, dur: def.windup });
      else this.emit({ e: 'telegraph', shape: 'arc', x: s.x, z: s.z, rot: s.rot, r: def.attackRange, w: 120 * DEG, dur: def.windup });
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
          const bit = el === 'ember' ? EF.BURN : el === 'rime' ? EF.CHILL : EF.SHOCK;
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
      const boss2 = s.kind === 'matron' || s.kind === 'stalker';
      if (boss2 && step.anim !== 'death') {
        const before = e.step > 0 ? e.script[e.step - 1].anim : prevAnim;
        this.boss2Step(e, step.anim, e.step >= 2 && step.anim === 'volley' ? e.script[e.step - 2].anim : before);
      } else if (step.anim === 'slam') e.slamCount++; else e.slamCount = 0;
      if (!boss2) this.telegraphFor(e, step.anim === 'slam' ? 'slam' : step.anim);
      if (step.anim === 'slam') e.slamCount = Math.max(1, e.slamCount);
      if (boss2 && step.anim !== 'death') { /* scripted above */ } else if (step.anim === 'attack' || step.anim === 'cast') {
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
    } else if (step.anim === 'charge' && s.kind === 'stalker') {
      s.z = e.homeZ + Math.max(0, Math.min(1, (step.dur - e.t - 0.8) / 0.4)) * 8;
    } else if (step.anim === 'charge') {
      const big = s.kind === 'regent' ? ENEMY_TUNING.REGENT : ENEMY_TUNING.CHAMPION;
      const el = step.dur - e.t - big.CHARGE_WINDUP;
      const len = big.CHARGE_LENGTH * 0.7;
      s.z = e.homeZ + Math.max(0, Math.min(1, el / (len / big.CHARGE_SPEED))) * len;
    } else if (step.anim === 'idle' && s.kind !== 'stalker') {
      s.z += (e.homeZ - s.z) * Math.min(1, dt * 6);
      s.x = e.homeX;
    }
    if (step.anim !== 'spawn' && step.anim !== 'death') {
      // constant chip damage so health bars and numbers show
      if (Math.random() < dt * 0.9) {
        const el = Math.random() < 0.5 ? ELEMENT_IDS[Math.floor(Math.random() * 3)] : null;
        const crit = Math.random() < 0.2;
        s.hp = Math.max(0.12, s.hp - 0.07);
        this.emit({ e: 'hit', target: { t: 'e', id: s.id }, x: s.x, z: s.z, dmg: Math.round((crit ? 2 : 1) * (9 + Math.random() * 30)), crit, el, by: 0 });
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
      e.t = next === 'move' ? 1.2 + Math.random() * 2.5 : next === 'windup' ? def.windup : 0.5;
      if (next === 'windup') this.telegraphFor(e, 'windup');
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
    else if (n % 3 === 0) this.menuLook = { ...this.menuLook, color: 1 + Math.floor(Math.random() * (LOOK.COLORS.length - 1)) };
    else this.menuLook = this.randomLook();
    this.applyMenu();
  }

  private simulate(dt: number): void {
    if (this.menu) { this.simulateMenu(dt); return; }
    this.time += dt;
    // hazard demo: whoever stands on an active plate gets the matching impact once in a while
    if (this.room.hazards.length > 0 && Math.random() < dt * 1.2) {
      const h = this.room.hazards[Math.floor(Math.random() * this.room.hazards.length)];
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
      if (this.stress) this.stressHero(h, dt); else this.stepHero(h, dt);
      this.playerRows.push(h.snap);
    }
    this.enemyRows.length = 0;
    this.enemies.forEach((e, i) => {
      const visible = this.stress ? this.stressEnemy(e, dt, i) : this.stepEnemy(e, dt);
      if (visible) this.enemyRows.push(e.snap);
    });

    const t = this.timers;
    const c = this.counters;
    if (this.stress) {
      // 44 enemies, ~60 projectiles in flight and constant combat VFX
      t.shot -= dt;
      while (this.shots.length < 60 && t.shot <= 0) {
        const demo = PROJECTILE_DEMO[c.shot++ % PROJECTILE_DEMO.length];
        const a = Math.random() * Math.PI * 2;
        this.shoot(demo.kind, Math.sin(a) * 3, Math.cos(a) * 3, Math.random() * Math.PI * 2, 9 + Math.random() * 8, 14, demo.hostile ? 0 : c.shot % 4, demo.hostile);
        t.shot += 0.02;
      }
      if (t.shot <= 0) t.shot = 0.05;
      t.hit -= dt;
      while (t.hit <= 0) {
        t.hit += 0.05;
        const e = this.enemies[Math.floor(Math.random() * this.enemies.length)];
        if (e.gone > 0 || e.snap.anim === 'spawn') continue;
        const el = Math.random() < 0.6 ? ELEMENT_IDS[Math.floor(Math.random() * 3)] : null;
        const crit = Math.random() < 0.15;
        e.snap.hp -= e.snap.kind === 'regent' || e.snap.kind === 'champion' ? 0.004 : 0.09;
        this.emit({ e: 'hit', target: { t: 'e', id: e.snap.id }, x: e.snap.x, z: e.snap.z, dmg: Math.round(10 + Math.random() * 40), crit, el, by: Math.floor(Math.random() * 4) });
        if (el) {
          const bit = el === 'ember' ? EF.BURN : el === 'rime' ? EF.CHILL : EF.SHOCK;
          const had = e.snap.flags & (EF.BURN | EF.CHILL | EF.SHOCK);
          if (had && !(had & bit)) {
            const prev: ElementId = had & EF.BURN ? 'ember' : had & EF.CHILL ? 'rime' : 'storm';
            this.emit({ e: 'resonance', x: e.snap.x, z: e.snap.z, r: STATUS.RESONANCE.RADIUS, a: prev, b: el, by: 0 });
          }
          e.snap.flags = (e.snap.flags & ~(EF.BURN | EF.CHILL | EF.SHOCK)) | bit;
          this.emit({ e: 'status', id: e.snap.id, el });
        }
        if (e.snap.hp <= 0) {
          this.emit({ e: 'kill', id: e.snap.id, kind: e.snap.kind, x: e.snap.x, z: e.snap.z, by: 0 });
          e.gone = 0.9;
          const a = Math.random() * Math.PI * 2;
          e.snap.x = Math.sin(a) * (hw - 3) * Math.random(); e.snap.z = Math.cos(a) * (hd - 3) * Math.random();
          e.snap.flags &= EF.ELITE;
        }
      }
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
        this.emit({ e: 'resonance', x: -hw + 6 + (c.reso % 3) * 2.2, z: 2.5, r: STATUS.RESONANCE.RADIUS, a, b, by: 0 });
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
        const types: Door['type'][] = this.kind === 'combat' ? ['boon', 'blessing', 'cursed'] : this.kind === 'elite' ? ['boon', 'boss'] : ['blessing', 'cursed'];
        const span = this.kind === 'boss' ? 26 : 16;
        this.doors = types.map((type, i) => ({ type, x: types.length === 1 ? 0 : -span / 2 + (i / (types.length - 1)) * span, z: -hd + 2.4 }));
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
    else if (name === 'resonance') this.view.debugFocus({ x: -this.room.w / 2 + 8, z: 2.5, zoom: 0.45 });
    else if (name === 'room') this.view.debugFocus({ x: 0, z: -1, zoom: 1.45 });
    else if (name === 'boss') {
      const e = this.enemies.find((x) => BOSS_KINDS.includes(x.snap.kind as BossKind));
      if (e) this.view.debugFocus({ x: e.snap.x, z: e.snap.z - 1, zoom: 0.4 });
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
      this.view.syncPlayers(this.playerRows, 0);
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
      + `hazards ${d.hazards}  hero bakes ${d.heroTemplates}  cursor ${this.cursor.x.toFixed(1)}, ${this.cursor.z.toFixed(1)}\n`
      + '[1/2/3] chamber [4/5/6] biome [B]oss [L]ooks [M]enu [T] marker\n'
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
  document.title = 'ready';
}

main().catch((err: unknown) => {
  console.error('[showcase] failed to start', err);
});
