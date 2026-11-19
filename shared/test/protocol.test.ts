import { describe, expect, it } from 'vitest';
import { NET, WORLD } from '@shared/constants.ts';
import { RUN } from '@shared/constants.ts';
import { MASTERY } from '@shared/data/mastery.ts';
import { DEFAULT_LOOK, LOOK, META_INDEX, META_UPGRADES, PARAGON, PARAGON_TUNING, sanitizeLook, sanitizeMeta } from '@shared/data/meta.ts';
import { RELIC_TUNING } from '@shared/data/relics.ts';
import {
  BIN, INPUT_BYTES, decodeInput, decodeSnapshot, encodeInput, encodeSnapshot, encodeSnapshotBody, normalizeRoomCode,
  parseClientMsg, sanitizeLoadout, sanitizeName, type ServerMsg, type SnapshotBody,
} from '@shared/protocol.ts';
import { World } from '@shared/sim/index.ts';
import {
  BTN, EF, ELEMENT_IDS, ENEMY_ANIMS, ENEMY_KINDS, OBJECTIVE_KINDS, PF, PLAYER_ANIMS, PROJECTILE_KINDS,
  type ClassId, type GameEvent, type InputCmd, type Loadout, type ObjectiveKind, type RunState, type SelfState,
} from '@shared/types.ts';
import { finishChamber } from './u4kit.ts';

const TAU = Math.PI * 2;
const angleErr = (a: number, b: number): number => Math.abs(((a - b + Math.PI * 3) % TAU) - Math.PI);

describe('input codec', () => {
  it('round-trips within quantisation tolerance', () => {
    const cmd: InputCmd = { seq: 123456, moveX: -0.5, moveZ: 1, aim: 2.5, aimDist: 12.34, buttons: BTN.PRIMARY | BTN.DASH };
    const buf = encodeInput(cmd);
    expect(buf.byteLength).toBe(INPUT_BYTES);
    const out = decodeInput(buf);
    expect(out).not.toBeNull();
    expect(out?.seq).toBe(cmd.seq);
    expect(out?.moveX).toBeCloseTo(cmd.moveX, 2);
    expect(out?.moveZ).toBeCloseTo(cmd.moveZ, 2);
    expect(angleErr(out?.aim ?? 0, cmd.aim)).toBeLessThan(TAU / 65535 + 1e-9);
    expect(out?.aimDist).toBeCloseTo(cmd.aimDist, 1);
    expect(out?.buttons).toBe(cmd.buttons);
  });

  it('clamps out-of-range fields and wraps the aim angle', () => {
    const out = decodeInput(encodeInput({ seq: 1, moveX: 9, moveZ: -9, aim: -Math.PI / 2, aimDist: 999, buttons: 0xfff }));
    expect(out?.moveX).toBe(1);
    expect(out?.moveZ).toBe(-1);
    expect(angleErr(out?.aim ?? 0, (3 * Math.PI) / 2)).toBeLessThan(1e-3);
    expect(out?.aimDist).toBeLessThanOrEqual(25.5);
    expect(out?.buttons).toBe(0xff);
  });

  it('accepts a Uint8Array view with an offset', () => {
    const raw = new Uint8Array(encodeInput({ seq: 7, moveX: 1, moveZ: 0, aim: 1, aimDist: 3, buttons: 1 }));
    const padded = new Uint8Array(INPUT_BYTES + 5);
    padded.set(raw, 5);
    expect(decodeInput(padded.subarray(5))?.seq).toBe(7);
  });

  it('returns null for truncated, oversized, mistagged or garbage frames', () => {
    const good = new Uint8Array(encodeInput({ seq: 1, moveX: 0, moveZ: 0, aim: 0, aimDist: 0, buttons: 0 }));
    expect(decodeInput(good.subarray(0, INPUT_BYTES - 1))).toBeNull();
    expect(decodeInput(new Uint8Array(INPUT_BYTES + 1))).toBeNull();
    expect(decodeInput(new Uint8Array(0))).toBeNull();
    const wrongTag = good.slice();
    wrongTag[0] = BIN.SNAPSHOT;
    expect(decodeInput(wrongTag)).toBeNull();
    for (let i = 0; i < 200; i++) {
      const junk = new Uint8Array((i * 7) % 40).map((_, j) => (i * 31 + j * 17) & 0xff);
      expect(() => decodeInput(junk)).not.toThrow();
    }
  });
});

const body: SnapshotBody = {
  tick: 4242,
  players: [
    { slot: 0, x: 3.25, z: -7.5, rot: 1.2, hp: 87, maxHp: 130, shield: 14, state: 'alive', anim: 'primary2', animSeq: 9, cdSecondary: 0.5, cdDash: 0.25, ult: 0.4, dashCharges: 2, revive: 0, flags: PF.CONNECTED | PF.KINDRED_AURA },
    { slot: 3, x: -12.02, z: 9.99, rot: 6.1, hp: 0, maxHp: 90, shield: 0, state: 'downed', anim: 'downed', animSeq: 255, cdSecondary: 1, cdDash: 0, ult: 1, dashCharges: 0, revive: 0.6, flags: PF.BEING_REVIVED },
  ],
  enemies: [
    { id: 17, kind: 'warrior', x: 1.5, z: 2.5, rot: 3.3, hp: 0.5, anim: 'windup', animSeq: 3, flags: EF.SHIELDED | EF.CHILL },
    { id: 65535, kind: 'regent', x: -19, z: -14, rot: 0, hp: 0.001, anim: 'slam', animSeq: 1, flags: EF.ENRAGED },
    { id: 4, kind: 'minion', x: 0, z: 0, rot: 0, hp: 0, anim: 'death', animSeq: 2, flags: 0 },
  ],
  projectiles: [
    { id: 300, kind: 'hexOrb', x: 4.5, z: 4.25, rot: 4, element: 0, hostile: true },
    { id: 301, kind: 'knife', x: -4.5, z: 0.5, rot: 1, element: 3, hostile: false },
  ],
};
const self: SelfState = { ackSeq: 99, x: 3.2512, z: -7.4987, dashTime: 0.12, dashDirX: 0.6, dashDirZ: -0.8, rootTime: 0.3, moveSpeed: 5.6 };

describe('snapshot codec', () => {
  it('round-trips players, enemies and projectiles within tolerance', () => {
    const frame = encodeSnapshot(body.tick, self, encodeSnapshotBody(body));
    const out = decodeSnapshot(frame);
    expect(out).not.toBeNull();
    if (!out) return;
    const posTol = 0.5 / WORLD.POS_SCALE + 1e-9;
    const rotTol = TAU / 255;
    expect(out.tick).toBe(body.tick);
    expect(out.self.ackSeq).toBe(self.ackSeq);
    expect(out.self.x).toBeCloseTo(self.x, 4);
    expect(out.self.z).toBeCloseTo(self.z, 4);
    expect(out.self.dashTime).toBeCloseTo(self.dashTime, 2);
    expect(out.self.dashDirX).toBeCloseTo(self.dashDirX, 2);
    expect(out.self.dashDirZ).toBeCloseTo(self.dashDirZ, 2);
    expect(out.self.rootTime).toBeCloseTo(self.rootTime, 2);
    expect(out.self.moveSpeed).toBeCloseTo(self.moveSpeed, 2);
    expect(out.players).toHaveLength(2);
    out.players.forEach((p, i) => {
      const src = body.players[i]!;
      expect(p.slot).toBe(src.slot);
      expect(Math.abs(p.x - src.x)).toBeLessThanOrEqual(posTol);
      expect(Math.abs(p.z - src.z)).toBeLessThanOrEqual(posTol);
      expect(angleErr(p.rot, src.rot)).toBeLessThanOrEqual(rotTol);
      expect(p.hp).toBe(src.hp);
      expect(p.maxHp).toBe(src.maxHp);
      expect(p.shield).toBe(src.shield);
      expect(p.state).toBe(src.state);
      expect(p.anim).toBe(src.anim);
      expect(p.animSeq).toBe(src.animSeq);
      expect(p.cdSecondary).toBeCloseTo(src.cdSecondary, 2);
      expect(p.cdDash).toBeCloseTo(src.cdDash, 2);
      expect(Math.abs(p.ult - src.ult)).toBeLessThanOrEqual(0.5 / 255 + 1e-9);
      expect(p.dashCharges).toBe(src.dashCharges);
      expect(Math.abs(p.revive - src.revive)).toBeLessThanOrEqual(1 / 15);
      expect(p.flags).toBe(src.flags);
    });
    expect(out.enemies).toHaveLength(3);
    out.enemies.forEach((e, i) => {
      const src = body.enemies[i]!;
      expect(e.id).toBe(src.id);
      expect(e.kind).toBe(src.kind);
      expect(Math.abs(e.x - src.x)).toBeLessThanOrEqual(posTol);
      expect(Math.abs(e.z - src.z)).toBeLessThanOrEqual(posTol);
      expect(angleErr(e.rot, src.rot)).toBeLessThanOrEqual(rotTol);
      expect(Math.abs(e.hp - src.hp)).toBeLessThanOrEqual(1 / 255);
      expect(e.anim).toBe(src.anim);
      expect(e.flags).toBe(src.flags);
    });
    // A living enemy never decodes as dead and a dead one never as alive.
    expect(out.enemies[1]!.hp).toBeGreaterThan(0);
    expect(out.enemies[2]!.hp).toBe(0);
    expect(out.projectiles).toHaveLength(2);
    out.projectiles.forEach((p, i) => {
      const src = body.projectiles[i]!;
      expect(p.id).toBe(src.id);
      expect(p.kind).toBe(src.kind);
      expect(p.element).toBe(src.element);
      expect(p.hostile).toBe(src.hostile);
      expect(Math.abs(p.x - src.x)).toBeLessThanOrEqual(posTol);
      expect(angleErr(p.rot, src.rot)).toBeLessThanOrEqual(rotTol);
    });
  });

  it('round-trips every enemy kind, enemy animation and projectile kind (incl. the update 2 additions)', () => {
    const self: SelfState = { ackSeq: 1, x: 0, z: 0, dashTime: 0, dashDirX: 0, dashDirZ: 1, rootTime: 0, moveSpeed: 5 };
    const body: SnapshotBody = {
      tick: 9, players: [],
      enemies: ENEMY_KINDS.flatMap((kind, k) => ENEMY_ANIMS.map((anim, a) => ({ id: k * 100 + a, kind, x: k, z: -a, rot: 0, hp: 1, anim, animSeq: a, flags: 0 }))).slice(0, 255),
      projectiles: PROJECTILE_KINDS.map((kind, i) => ({ id: i + 1, kind, x: i, z: 2, rot: 0, element: i % 4, hostile: i % 2 === 0 })),
    };
    const snap = decodeSnapshot(encodeSnapshot(9, self, encodeSnapshotBody(body)))!;
    expect(snap.enemies.map((e) => [e.kind, e.anim])).toEqual(body.enemies.map((e) => [e.kind, e.anim]));
    expect(snap.projectiles.map((p) => [p.kind, p.element, p.hostile])).toEqual(body.projectiles.map((p) => [p.kind, p.element, p.hostile]));
    expect(new Set(snap.enemies.map((e) => e.kind))).toEqual(new Set(ENEMY_KINDS));
    expect(snap.projectiles.map((p) => p.kind)).toContain('soulWisp');
    expect(snap.projectiles.map((p) => p.kind)).toContain('boneSpear');
  });

  it('round-trips an empty world', () => {
    const out = decodeSnapshot(encodeSnapshot(1, self, encodeSnapshotBody({ tick: 1, players: [], enemies: [], projectiles: [] })));
    expect(out?.players).toEqual([]);
    expect(out?.enemies).toEqual([]);
    expect(out?.projectiles).toEqual([]);
  });

  it('returns null for every truncation of a valid frame and never throws on garbage', () => {
    const frame = encodeSnapshot(body.tick, self, encodeSnapshotBody(body));
    for (let len = 0; len < frame.byteLength; len++) expect(decodeSnapshot(frame.subarray(0, len))).toBeNull();
    const longer = new Uint8Array(frame.byteLength + 3);
    longer.set(frame);
    expect(decodeSnapshot(longer)).toBeNull();
    const wrongTag = frame.slice();
    wrongTag[0] = BIN.INPUT;
    expect(decodeSnapshot(wrongTag)).toBeNull();
    let seed = 12345;
    for (let i = 0; i < 300; i++) {
      const junk = new Uint8Array(i % 120).map(() => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed & 0xff; });
      if (junk.length > 0 && i % 2 === 0) junk[0] = BIN.SNAPSHOT;
      expect(() => decodeSnapshot(junk)).not.toThrow();
    }
  });
});

describe('update 3 on the wire', () => {
  it('speaks protocol version 4', () => {
    expect(NET.PROTOCOL_VERSION).toBe(4);
  });

  it('the ultimate button survives the input codec next to the others', () => {
    const all = BTN.PRIMARY | BTN.SECONDARY | BTN.DASH | BTN.INTERACT | BTN.ULTIMATE;
    expect(decodeInput(encodeInput({ seq: 1, moveX: 0, moveZ: 0, aim: 0, aimDist: 0, buttons: BTN.ULTIMATE }))?.buttons).toBe(BTN.ULTIMATE);
    expect(decodeInput(encodeInput({ seq: 2, moveX: 0, moveZ: 0, aim: 0, aimDist: 0, buttons: all }))?.buttons).toBe(all);
  });

  it('the `ult` byte: 0, a full bar and everything between round-trip; a full bar decodes as exactly 1', () => {
    for (const ult of [0, 0.01, 0.25, 0.5, 0.999, 1, 7, -3]) {
      const players = [{ ...body.players[0]!, ult }];
      const out = decodeSnapshot(encodeSnapshot(1, self, encodeSnapshotBody({ ...body, players })));
      const want = Math.max(0, Math.min(1, ult));
      expect(Math.abs(out!.players[0]!.ult - want)).toBeLessThanOrEqual(0.5 / 255 + 1e-9);
      if (ult >= 1) expect(out!.players[0]!.ult).toBe(1);
      if (ult <= 0) expect(out!.players[0]!.ult).toBe(0);
    }
  });

  it('the new animations and the Wither flag round-trip', () => {
    for (const anim of ['art', 'ultimate'] as const) {
      expect(PLAYER_ANIMS).toContain(anim);
      const out = decodeSnapshot(encodeSnapshot(1, self, encodeSnapshotBody({ ...body, players: [{ ...body.players[0]!, anim }] })));
      expect(out!.players[0]!.anim).toBe(anim);
    }
    const enemies = [{ ...body.enemies[0]!, flags: EF.WITHER | EF.ELITE }];
    const out = decodeSnapshot(encodeSnapshot(1, self, encodeSnapshotBody({ ...body, enemies })));
    expect(out!.enemies[0]!.flags).toBe(EF.WITHER | EF.ELITE);
  });

  it('projectiles: every kind x every element code (3 bits) x the hostile bit (0x80) round-trips', () => {
    expect(PROJECTILE_KINDS.length).toBeLessThanOrEqual(16);
    expect(ELEMENT_IDS).toHaveLength(4);
    let id = 1;
    const projectiles = [];
    for (const kind of PROJECTILE_KINDS) {
      for (let element = 0; element <= ELEMENT_IDS.length; element++) {
        for (const hostile of [false, true]) projectiles.push({ id: id++, kind, x: 1, z: -1, rot: 1, element, hostile });
      }
    }
    const encoded = encodeSnapshotBody({ ...body, projectiles });
    const out = decodeSnapshot(encodeSnapshot(1, self, encoded));
    expect(out!.projectiles).toHaveLength(projectiles.length);
    out!.projectiles.forEach((p, i) => {
      expect(p).toMatchObject({ id: projectiles[i]!.id, kind: projectiles[i]!.kind, element: projectiles[i]!.element, hostile: projectiles[i]!.hostile });
    });
    // The hostile flag is the top bit of the kind / element byte.
    const one = encodeSnapshotBody({ ...body, players: [], enemies: [], projectiles: [{ id: 1, kind: 'shadowDagger', x: 0, z: 0, rot: 0, element: 4, hostile: true }] });
    const kindByte = one[3 + 2]!;
    expect(kindByte & 0x80).toBe(0x80);
    expect((kindByte >> 4) & 7).toBe(4);
    expect(kindByte & 0x0f).toBe(PROJECTILE_KINDS.indexOf('shadowDagger'));
  });
});

const fullLoadout = (over: Partial<Loadout> = {}): Loadout => ({
  look: { ...DEFAULT_LOOK }, meta: META_UPGRADES.map(() => 0), paragon: PARAGON.map(() => 0), mastery: 1, art: 0, talents: MASTERY.TALENT_LEVELS.map(() => 0),
  relics: [], ...over,
});

describe('parseClientMsg', () => {
  const v = NET.PROTOCOL_VERSION;
  it('accepts every valid message type', () => {
    const meta = META_UPGRADES.map((u, i) => Math.min(u.costs.length, i % 3));
    const loadout = fullLoadout({
      look: { color: 3, head: false, cape: true, style: 2 }, meta, paragon: PARAGON.map((_, i) => i * 3), mastery: 12, art: 1, talents: [1, 2, 1],
      relics: [{ id: 'whetstone', rank: 3 }],
    });
    const plain = fullLoadout();
    expect(parseClientMsg({ t: 'create', v, name: ' Ada  Lovelace ', cls: 'mage', loadout })).toEqual({ t: 'create', v, name: 'Ada Lovelace', cls: 'mage', loadout, tutorial: false });
    expect(parseClientMsg({ t: 'create', v, name: 'Ada', cls: 'mage', loadout, tutorial: true })).toEqual({ t: 'create', v, name: 'Ada', cls: 'mage', loadout, tutorial: true });
    // A missing loadout is the default one (no upgrades); `tutorial` must be exactly true.
    expect(parseClientMsg({ t: 'create', v, name: 'Ada', cls: 'mage', tutorial: 'yes' })).toEqual({ t: 'create', v, name: 'Ada', cls: 'mage', loadout: plain, tutorial: false });
    expect(parseClientMsg({ t: 'join', v, code: 'abcde', name: 'Bo', cls: 'rogue', loadout })).toEqual({ t: 'join', v, code: 'ABCDE', name: 'Bo', cls: 'rogue', loadout });
    // A lobby loadout belongs to a class: it is only valid together with `cls`.
    expect(parseClientMsg({ t: 'lobby', cls: 'mage', loadout })).toEqual({ t: 'lobby', cls: 'mage', loadout });
    expect(parseClientMsg({ t: 'lobby', loadout })).toBeNull();
    for (const oath of [0, 4, RUN.OATH_MAX]) expect(parseClientMsg({ t: 'lobby', oath })).toEqual({ t: 'lobby', oath });
    for (const cls of ['templar', 'spellblade', 'shade']) expect(parseClientMsg({ t: 'lobby', cls })).toEqual({ t: 'lobby', cls });
    expect(parseClientMsg({ t: 'reroll', extra: 1 })).toEqual({ t: 'reroll' });
    expect(parseClientMsg({ t: 'rejoin', v, code: 'ABCDE', token: '0123456789abcdef' })).toEqual({ t: 'rejoin', v, code: 'ABCDE', token: '0123456789abcdef' });
    expect(parseClientMsg({ t: 'lobby', cls: 'knight', ready: true, oath: 3 })).toEqual({ t: 'lobby', cls: 'knight', ready: true, oath: 3 });
    expect(parseClientMsg({ t: 'lobby' })).toEqual({ t: 'lobby' });
    expect(parseClientMsg({ t: 'start' })).toEqual({ t: 'start' });
    expect(parseClientMsg({ t: 'pick', index: 2 })).toEqual({ t: 'pick', index: 2 });
    // Update 5: `replace` names the keystone to give up; it is only checked for shape here (the simulation validates it).
    expect(parseClientMsg({ t: 'pick', index: 1, replace: 'colossus', junk: 1 })).toEqual({ t: 'pick', index: 1, replace: 'colossus' });
    expect(parseClientMsg({ t: 'pick', index: 3, replace: '' })).toEqual({ t: 'pick', index: 3, replace: '' });
    expect(parseClientMsg({ t: 'toLobby' })).toEqual({ t: 'toLobby' });
    expect(parseClientMsg({ t: 'leave' })).toEqual({ t: 'leave' });
    expect(parseClientMsg({ t: 'ping', c: 12.5 })).toEqual({ t: 'ping', c: 12.5 });
  });

  it('sanitises loadouts: garbage becomes the default, levels are clamped to 0..max, look indices to their range', () => {
    const max = META_UPGRADES.map((u) => u.costs.length);
    const zero = max.map(() => 0);
    expect(sanitizeLoadout(undefined, 'knight')).toEqual(fullLoadout());
    for (const junk of [null, 7, 'x', [], { look: 'red', meta: 'all', paragon: 3, mastery: 'max', art: [], talents: 'yes', relics: {} }, { look: [], meta: {} }]) {
      expect(sanitizeLoadout(junk, 'mage'), JSON.stringify(junk)).toEqual(fullLoadout());
    }
    const over = sanitizeLoadout({ look: { color: 99, head: 0, cape: false, style: -4, hat: 'crown' }, meta: [99, -3, 2.9, NaN, Infinity, '3', null, 1e9, 1] }, 'knight');
    expect(over.look).toEqual({ color: LOOK.COLORS.length - 1, head: true, cape: false, style: 0 });
    expect(over.meta).toEqual([max[0], 0, 2, 0, 0, 0, 0, max[7], 1, ...zero.slice(9)]);
    expect(over.meta).toHaveLength(META_UPGRADES.length);
    for (let i = 0; i < over.meta.length; i++) expect(Number.isInteger(over.meta[i]) && over.meta[i]! >= 0 && over.meta[i]! <= max[i]!).toBe(true);
    // The same clamping applies inside messages; a hostile loadout never makes a message invalid.
    const msg = parseClientMsg({ t: 'create', v, name: 'A', cls: 'mage', loadout: { look: { color: -1, style: 7.9 }, meta: [1e6] } });
    expect(msg).toEqual({
      t: 'create', v, name: 'A', cls: 'mage', tutorial: false,
      loadout: fullLoadout({ look: { color: 0, head: true, cape: true, style: LOOK.STYLES - 1 }, meta: [max[0]!, ...zero.slice(1)] }),
    });
    expect(sanitizeMeta([1, 1])).toEqual([1, 1, ...zero.slice(2)]);
    expect(sanitizeLook({ color: 2.7 }).color).toBe(2);
  });

  it('clamps the update 3 loadout: art and talents by mastery, relics by slots / duplicates / rank, ranks by maximum', () => {
    const wish = { mastery: 1, art: 1, talents: [1, 2, 2], paragon: [5, -2, 1e9, 2.9, NaN], relics: [{ id: 'whetstone', rank: 99 }, { id: 'whetstone', rank: 2 }, { id: 'nope', rank: 1 }, { id: 'phoenix', rank: 0 }, { id: 'bell', rank: 4 }, { id: 'tome', rank: 2 }] };
    // Mastery 1: no art, no talents. One relic slot without the reliquary upgrade; rank capped; unknown ids dropped.
    const fresh = sanitizeLoadout(wish, 'knight');
    expect(fresh).toMatchObject({ mastery: 1, art: 0, talents: [0, 0, 0] });
    expect(fresh.relics).toEqual([{ id: 'whetstone', rank: RELIC_TUNING.MAX_RANK }]);
    expect(fresh.paragon).toEqual([5, 0, PARAGON_TUNING.MAX_RANK, 2, 0, 0, 0]);
    expect(fresh.paragon).toHaveLength(PARAGON.length);
    // The art opens at mastery 2, the talent tiers at 3 / 6 / 10.
    expect(sanitizeLoadout({ ...wish, mastery: MASTERY.ART_LEVEL }, 'knight')).toMatchObject({ art: 1, talents: [0, 0, 0] });
    expect(sanitizeLoadout({ ...wish, mastery: MASTERY.TALENT_LEVELS[0] }, 'knight').talents).toEqual([1, 0, 0]);
    expect(sanitizeLoadout({ ...wish, mastery: MASTERY.TALENT_LEVELS[1] }, 'knight').talents).toEqual([1, 2, 0]);
    expect(sanitizeLoadout({ ...wish, mastery: MASTERY.TALENT_LEVELS[2] }, 'knight').talents).toEqual([1, 2, 2]);
    expect(sanitizeLoadout({ mastery: 50, art: 2, talents: [3, -1, 1.5] }, 'knight')).toMatchObject({ art: 0, talents: [0, 0, 0] });
    expect(sanitizeLoadout({ mastery: 1e9 }, 'knight').mastery).toBe(MASTERY.MAX_LEVEL);
    expect(sanitizeLoadout({ mastery: -4 }, 'knight').mastery).toBe(1);
    // Each reliquary level adds a slot (duplicates never count); a rank below 1 becomes 1.
    const meta = META_UPGRADES.map(() => 0);
    meta[META_INDEX.get('reliquary')!] = 1;
    expect(sanitizeLoadout({ ...wish, meta }, 'knight').relics).toEqual([{ id: 'whetstone', rank: RELIC_TUNING.MAX_RANK }, { id: 'phoenix', rank: 1 }]);
    meta[META_INDEX.get('reliquary')!] = 99;
    const full = sanitizeLoadout({ ...wish, meta }, 'knight').relics;
    expect(full).toEqual([{ id: 'whetstone', rank: RELIC_TUNING.MAX_RANK }, { id: 'phoenix', rank: 1 }, { id: 'bell', rank: 4 }]);
    expect(full).toHaveLength(RELIC_TUNING.MAX_SLOTS);
  });

  it('drops unknown extra fields', () => {
    expect(parseClientMsg({ t: 'start', hp: 9999, admin: true })).toEqual({ t: 'start' });
  });

  it('rejects malformed messages', () => {
    const bad: unknown[] = [
      null, undefined, 42, 'start', [], [{ t: 'start' }], {}, { t: 5 }, { t: 'nope' }, { t: 'damage', amount: 999 },
      { t: 'create', v, name: '', cls: 'mage' }, { t: 'create', v, name: 'A', cls: 'wizard' }, { t: 'create', name: 'A', cls: 'mage' },
      { t: 'create', v: 1.5, name: 'A', cls: 'mage' }, { t: 'create', v, name: 7, cls: 'mage' }, { t: 'create', v, name: '\u0000\u0007', cls: 'mage' },
      { t: 'join', v, code: 'ABCD', name: 'A', cls: 'mage' }, { t: 'join', v, code: 'ABCDO', name: 'A', cls: 'mage' }, { t: 'join', v, code: 12345, name: 'A', cls: 'mage' },
      { t: 'rejoin', v, code: 'ABCDE', token: 'short' }, { t: 'rejoin', v, code: 'ABCDE', token: 'x'.repeat(65) }, { t: 'rejoin', v, code: 'ABCDE' },
      { t: 'lobby', cls: 'nope' }, { t: 'lobby', ready: 'yes' }, { t: 'lobby', loadout: {} }, { t: 'lobby', cls: 'paladin', loadout: {} }, { t: 'lobby', oath: RUN.OATH_MAX + 1 }, { t: 'lobby', oath: -1 }, { t: 'lobby', oath: 1.5 },
      { t: 'pick', index: 0, replace: 5 }, { t: 'pick', index: 0, replace: null }, { t: 'pick', index: 0, replace: ['colossus'] }, { t: 'pick', index: 0, replace: 'x'.repeat(33) },
      { t: 'pick' }, { t: 'pick', index: -1 }, { t: 'pick', index: 8 }, { t: 'pick', index: '1' }, { t: 'pick', index: NaN },
      { t: 'ping' }, { t: 'ping', c: Infinity }, { t: 'ping', c: '1' },
    ];
    for (const msg of bad) expect(parseClientMsg(msg), JSON.stringify(msg)).toBeNull();
  });
});

describe('sanitizeName / normalizeRoomCode', () => {
  it('trims, collapses whitespace, strips control characters and angle brackets, caps the length', () => {
    expect(sanitizeName('  Sir   Lancelot \n')).toBe('Sir Lancelot');
    expect(sanitizeName('<b>Eve</b>')).toBe('bEve/b');
    expect(sanitizeName('a\u0000b\u001fc\u007fd')).toBe('abcd');
    expect(sanitizeName('x'.repeat(50))).toHaveLength(NET.MAX_NAME_LENGTH);
    expect(sanitizeName('   ')).toBeNull();
    expect(sanitizeName('\u0001\u0002')).toBeNull();
    expect(sanitizeName(undefined)).toBeNull();
    expect(sanitizeName({ toString: () => 'x' })).toBeNull();
  });

  it('upper-cases valid codes and rejects everything else', () => {
    expect(normalizeRoomCode(' abcde ')).toBe('ABCDE');
    expect(normalizeRoomCode('Qw2e9')).toBe('QW2E9');
    expect(normalizeRoomCode('ABCD')).toBeNull();
    expect(normalizeRoomCode('ABCDEF')).toBeNull();
    expect(normalizeRoomCode('ABCD0')).toBeNull();
    expect(normalizeRoomCode('ABCDI')).toBeNull();
    expect(normalizeRoomCode('AB DE')).toBeNull();
    expect(normalizeRoomCode(null)).toBeNull();
    expect(normalizeRoomCode(12345)).toBeNull();
  });
});

describe('update 4 on the wire', () => {
  const live = (kind: ObjectiveKind, classes: ClassId[] = ['knight', 'mage']): World => {
    const w = new World();
    classes.forEach((cls, slot) => w.addPlayer(slot, cls, `P${slot}`));
    w.start(0, 5, 2, { objective: kind });
    for (let i = 0; i < 240; i++) { for (const h of w.heroes) h.invuln = 1; w.step(); }
    return w;
  };

  it('RunState.objective survives the JSON round trip of a `run` message for every objective kind', () => {
    for (const kind of OBJECTIVE_KINDS) {
      const w = live(kind);
      const state = w.getRunState();
      expect(state.objective!.kind).toBe(kind);
      const msg: ServerMsg = { t: 'run', state };
      const back = JSON.parse(JSON.stringify(msg)) as Extract<ServerMsg, { t: 'run' }>;
      expect(back.state.objective).toEqual(state.objective);
      expect(back.state.doors).toEqual(state.doors);
      expect(back.state).toMatchObject({ objectivesDone: 0, objectiveBonuses: 0 });
      // Plain data only: numbers are finite, nothing is undefined (JSON would drop or null it).
      const o = state.objective!;
      for (const v of [o.progress, o.timeLeft, ...(o.anchor ? [o.anchor.x, o.anchor.z, o.anchor.r, o.anchor.hp] : []), ...o.sites.flatMap((s) => [s.x, s.z, s.r, s.progress]), ...o.targets]) {
        expect(Number.isFinite(v), kind).toBe(true);
      }
      if (kind === 'hunt') expect(o.targets.length).toBeGreaterThan(0);
      if (kind === 'ritual') expect(o.sites).toHaveLength(3);
      if (kind === 'defend' || kind === 'vault') expect(o.anchor).not.toBeNull();
    }
  });

  it('doors carry their objective; the new events and the five enemy kinds round-trip', () => {
    const w = live('slay', ['knight']);
    finishChamber(w);
    for (const slot of w.getRunState().draftPending) w.pickBoon(slot, 0);
    for (let i = 0; i < 5; i++) w.step();
    const doors = (JSON.parse(JSON.stringify(w.getRunState())) as RunState).doors;
    expect(doors.length).toBeGreaterThan(0);
    for (const d of doors) expect(OBJECTIVE_KINDS).toContain(d.objective);
    const events: GameEvent[] = [
      { e: 'objective', kind: 'ritual', what: 'site', index: 2 }, { e: 'objective', kind: 'hunt', what: 'done', bonus: true },
      { e: 'objective', kind: 'defend', what: 'anchorHit' }, { e: 'dome', id: 7, on: true, r: 4.5 }, { e: 'mend', id: 3, targets: [1, 2] },
      { e: 'warded', id: 9, el: 'umbra', x: 1.5, z: -2, by: 0 }, { e: 'spawn', id: 4, kind: 'reaver', x: 0, z: 0, elite: false, ward: 'storm' },
    ];
    const msg: ServerMsg = { t: 'ev', tick: 12, events };
    expect(JSON.parse(JSON.stringify(msg))).toEqual(msg);
    const kinds = ENEMY_KINDS.slice(8);
    const self: SelfState = { ackSeq: 0, x: 0, z: 0, dashTime: 0, dashDirX: 0, dashDirZ: 0, rootTime: 0, moveSpeed: 5 };
    const snap = decodeSnapshot(encodeSnapshot(1, self, encodeSnapshotBody({
      tick: 1, players: [], projectiles: [],
      enemies: kinds.map((kind, i) => ({ id: i + 1, kind, x: i, z: 0, rot: 0, hp: 1, anim: 'leap' as const, animSeq: 0, flags: EF.ENRAGED })),
    })))!;
    expect(snap.enemies.map((e) => e.kind)).toEqual(['shaman', 'aegis', 'bomber', 'necromancer', 'reaver']);
    expect(snap.enemies.every((e) => e.flags === EF.ENRAGED && e.anim === 'leap')).toBe(true);
  });
});

describe('update 5 on the wire', () => {
  it('pick.replace and draft.keystone survive JSON; a pick message stays far below the message size limit', () => {
    const pick = { t: 'pick', index: 2, replace: 'resonance_engine' } as const;
    const text = JSON.stringify(pick);
    expect(text.length).toBeLessThan(NET.MAX_MESSAGE_BYTES);
    expect(parseClientMsg(JSON.parse(text))).toEqual(pick);
    const draft: ServerMsg = {
      t: 'draft', rerolls: 1, options: [{ id: 'colossus', level: 1 }, { id: 'ks_knight', level: 1 }, { id: 'familiar', level: 1 }],
      keystone: { held: ['sanguine', 'ember_wake'], skip: 3 },
    };
    expect(JSON.parse(JSON.stringify(draft))).toEqual(draft);
    const ordinary: ServerMsg = { t: 'draft', rerolls: 0, options: [{ id: 'quick_step', level: 2, fits: ['dash'] }, { id: 'keen_edge', level: 1 }] };
    const back = JSON.parse(JSON.stringify(ordinary)) as Extract<ServerMsg, { t: 'draft' }>;
    expect(back).toEqual(ordinary);
    expect('keystone' in back).toBe(false);
    expect('fits' in back.options[1]!).toBe(false);
  });

  it('the keystone events and the new roster / stats fields are plain JSON', () => {
    const events: GameEvent[] = [
      { e: 'keystone', slot: 1, id: 'colossus' }, { e: 'keystone', slot: 0, id: 'familiar', replaced: 'colossus' },
      { e: 'keystoneProc', slot: 2, id: 'ricochet', x: 1.5, z: -2, tx: 3, tz: 4, n: 1 }, { e: 'keystoneProc', slot: 0, id: 'shockstep', x: 0, z: 0, r: 3.6 },
      { e: 'buff', slot: 0, id: 'phase_walker', dur: 3 },
    ];
    expect(JSON.parse(JSON.stringify(events))).toEqual(events);
    const w = new World();
    w.addPlayer(0, 'mage', 'A');
    w.start(0, 4, 3);
    w.grantKeystone(0, 'ks_mage');
    const state = JSON.parse(JSON.stringify(w.getRunState())) as RunState;
    expect(state.stats[0]!.chamberDamage).toEqual([0]);
    expect(w.getKeystones(0)).toEqual(['ks_mage']);
    expect(w.getKeystoneAt(0)).toEqual([0]);
  });

  it('PF.CHANNELING survives the snapshot codec next to the other player flags', () => {
    const w = new World();
    w.addPlayer(0, 'mage', 'A');
    w.startSandbox(1);
    w.grantKeystone(0, 'ks_mage');
    w.spawnEnemy('minion', 0, -3);
    for (let i = 1; i <= 6; i++) { w.applyInput(0, { seq: i, moveX: 0, moveZ: 0, aim: Math.PI, aimDist: 5, buttons: BTN.PRIMARY }); w.step(); }
    const body = w.getSnapshotBody();
    expect(body.players[0]!.flags & PF.CHANNELING).toBe(PF.CHANNELING);
    const snap = decodeSnapshot(encodeSnapshot(w.tick, w.getSelfState(0), encodeSnapshotBody(body)))!;
    expect(snap.players[0]!.flags).toBe(body.players[0]!.flags);
    expect(snap.players[0]!.flags & PF.CHANNELING).toBe(PF.CHANNELING);
    expect(PF.CHANNELING).toBe(32);
    // The predicted move speed is the slowed one.
    expect(snap.self.moveSpeed).toBeCloseTo(w.hero(0)!.body.moveSpeed, 2);
    expect(w.hero(0)!.body.moveSpeed).toBeLessThan(w.hero(0)!.def.moveSpeed);
  });
});
