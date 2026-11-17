// TEMPORARY progress-preview harness (lead). Delete before release.
import { ACESFilmicToneMapping, Color, FogExp2, PerspectiveCamera, Scene, SRGBColorSpace, WebGLRenderer } from 'three';
import type { EnemySnap, PlayerSnap, RoomLayout } from '@shared/types.ts';
import { loadAssets } from '../render/assets.ts';
import { Atlas } from '../render/atlas.ts';
import { BillboardBatch, DecalBatch } from '../render/batches.ts';
import { Enemies, Heroes } from '../render/characters.ts';
import { CAMERA, QUALITY } from '../render/config.ts';
import { LevelView } from '../render/level.ts';

const params = new URLSearchParams(location.search);
const kind = (params.get('kind') ?? 'combat') as 'combat' | 'elite' | 'boss';
const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
canvas.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;display:block';
const renderer = new WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(1);
renderer.setSize(innerWidth, innerHeight, false);
renderer.outputColorSpace = SRGBColorSpace;
renderer.toneMapping = ACESFilmicToneMapping;
const scene = new Scene();
const assets = await loadAssets(() => {});
const level = new LevelView(assets);
scene.background = new Color(level.fogColor);
scene.fog = new FogExp2(level.fogColor.getHex(), 0.012);
const room: RoomLayout = {
  seed: 1337, w: 32, d: 24,
  obstacles: [
    { x: -8, z: -4, r: 1.1, kind: 'pillar' }, { x: 8, z: -4, r: 1.1, kind: 'pillar' },
    { x: -9, z: 5, r: 1.2, kind: 'barrels' }, { x: 9, z: 5, r: 1.2, kind: 'crates' },
    { x: 0, z: -7, r: 1.0, kind: 'brazier' }, { x: -3, z: 2, r: 0.9, kind: 'rubble' }, { x: 12, z: -8, r: 0.9, kind: 'column' },
  ],
  spawns: [{ x: -3, z: 9 }, { x: -1, z: 9 }, { x: 1, z: 9 }, { x: 3, z: 9 }],
};
level.setRoom(room, kind, kind === 'boss' ? 7 : 2);
level.applyQuality(QUALITY.medium);
scene.add(level.group, level.lights);
const atlas = new Atlas();
const decals = new DecalBatch(256);
const fx = new BillboardBatch(1024, atlas.texture, { depthTest: true, toneMapped: false, renderOrder: 5 });
const ui = new BillboardBatch(512, atlas.texture, { depthTest: false, toneMapped: false, renderOrder: 9 });
scene.add(decals.mesh, fx.mesh, ui.mesh);
const heroes = new Heroes(scene, assets, atlas);
const enemies = new Enemies(scene, assets, atlas);
heroes.setRoster([
  { slot: 0, cls: 'knight', name: 'Joel' }, { slot: 1, cls: 'mage', name: 'Mira' },
  { slot: 2, cls: 'rogue', name: 'Finn' }, { slot: 3, cls: 'barbarian', name: 'Bjorn' },
]);
const hero = (slot: number, x: number, z: number, rot: number, anim: PlayerSnap['anim']): PlayerSnap => ({
  slot, x, z, rot, hp: 100, maxHp: 120, shield: 0, state: 'alive', anim, animSeq: 1, cdSecondary: 0, cdDash: 0, dashCharges: 1, revive: 0, flags: 1,
});
const players = [hero(0, -1.5, 2.5, Math.PI, 'primary1'), hero(1, 3, 5, Math.PI * 0.9, 'primary1'), hero(2, -5, 5.5, Math.PI * 1.1, 'idle'), hero(3, 1.5, 1.5, Math.PI * 0.8, 'run')];
const foe = (id: number, k: EnemySnap['kind'], x: number, z: number, anim: EnemySnap['anim'], flags = 0, hp = 1): EnemySnap => ({ id, kind: k, x, z, rot: Math.atan2(-x, 3 - z), hp, anim, animSeq: 1, flags });
const foes: EnemySnap[] = kind === 'boss'
  ? [foe(1, 'regent', 0, -5, 'idle', 0, 0.8), foe(2, 'minion', -4, -2, 'move'), foe(3, 'minion', 4, -2, 'move'), foe(4, 'minion', -2, -1, 'attack')]
  : [foe(1, 'minion', -2.5, -0.5, 'attack', 0, 0.6), foe(2, 'minion', 0.5, -1.5, 'move'), foe(3, 'minion', 3.5, -0.5, 'move', 2, 0.7), foe(4, 'warrior', -0.5, -4, 'windup', 32),
     foe(5, 'archer', 7, -7, 'windup'), foe(6, 'archer', -7, -8, 'idle', 4), foe(7, 'mage', 2, -8, 'cast', 8), foe(8, 'warrior', 5, -3, 'move', 1), foe(9, kind === 'elite' ? 'champion' : 'minion', -5, -4, 'move')];
const camera = new PerspectiveCamera(CAMERA.FOV, innerWidth / innerHeight, CAMERA.NEAR, CAMERA.FAR);
const pitch = (CAMERA.PITCH_DEG * Math.PI) / 180;
const target = { x: 0, z: 0.5 };
camera.position.set(target.x, Math.sin(pitch) * CAMERA.DISTANCE, target.z + Math.cos(pitch) * CAMERA.DISTANCE);
camera.lookAt(target.x, 0, target.z);
let time = 0;
let frames = 0;
const loop = (): void => {
  const dt = 1 / 30;
  time += dt;
  heroes.sync(players, 0);
  enemies.sync(foes);
  decals.begin(); fx.begin(); ui.begin();
  level.emit(fx, decals, time);
  heroes.update(dt, time, decals, ui, fx, true);
  enemies.update(dt, time, decals, ui, fx, true);
  decals.end(time); fx.end(time); ui.end(time);
  renderer.render(scene, camera);
  frames++;
  (window as unknown as { __peekFrames: number }).__peekFrames = frames;
  requestAnimationFrame(loop);
};
loop();
