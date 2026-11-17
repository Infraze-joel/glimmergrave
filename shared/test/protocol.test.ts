import { describe, expect, it } from 'vitest';
import { NET, WORLD } from '@shared/constants.ts';
import { DEFAULT_LOOK, LOOK, META_UPGRADES, sanitizeLook, sanitizeMeta } from '@shared/data/meta.ts';
import {
  BIN, INPUT_BYTES, decodeInput, decodeSnapshot, encodeInput, encodeSnapshot, encodeSnapshotBody, normalizeRoomCode,
  parseClientMsg, sanitizeLoadout, sanitizeName, type SnapshotBody,
} from '@shared/protocol.ts';
import { BTN, EF, ENEMY_ANIMS, ENEMY_KINDS, PF, PROJECTILE_KINDS, type InputCmd, type SelfState } from '@shared/types.ts';

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
    { slot: 0, x: 3.25, z: -7.5, rot: 1.2, hp: 87, maxHp: 130, shield: 14, state: 'alive', anim: 'primary2', animSeq: 9, cdSecondary: 0.5, cdDash: 0.25, dashCharges: 2, revive: 0, flags: PF.CONNECTED | PF.KINDRED_AURA },
    { slot: 3, x: -12.02, z: 9.99, rot: 6.1, hp: 0, maxHp: 90, shield: 0, state: 'downed', anim: 'downed', animSeq: 255, cdSecondary: 1, cdDash: 0, dashCharges: 0, revive: 0.6, flags: PF.BEING_REVIVED },
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

describe('parseClientMsg', () => {
  const v = NET.PROTOCOL_VERSION;
  it('accepts every valid message type', () => {
    const loadout = { look: { color: 3, head: false, cape: true, style: 2 }, meta: [1, 2, 3, 0, 1, 2, 1, 2, 3] };
    const plain = { look: DEFAULT_LOOK, meta: META_UPGRADES.map(() => 0) };
    expect(parseClientMsg({ t: 'create', v, name: ' Ada  Lovelace ', cls: 'mage', loadout })).toEqual({ t: 'create', v, name: 'Ada Lovelace', cls: 'mage', loadout, tutorial: false });
    expect(parseClientMsg({ t: 'create', v, name: 'Ada', cls: 'mage', loadout, tutorial: true })).toEqual({ t: 'create', v, name: 'Ada', cls: 'mage', loadout, tutorial: true });
    // A missing loadout is the default one (no upgrades); `tutorial` must be exactly true.
    expect(parseClientMsg({ t: 'create', v, name: 'Ada', cls: 'mage', tutorial: 'yes' })).toEqual({ t: 'create', v, name: 'Ada', cls: 'mage', loadout: plain, tutorial: false });
    expect(parseClientMsg({ t: 'join', v, code: 'abcde', name: 'Bo', cls: 'rogue', loadout })).toEqual({ t: 'join', v, code: 'ABCDE', name: 'Bo', cls: 'rogue', loadout });
    expect(parseClientMsg({ t: 'lobby', loadout })).toEqual({ t: 'lobby', loadout });
    expect(parseClientMsg({ t: 'reroll', extra: 1 })).toEqual({ t: 'reroll' });
    expect(parseClientMsg({ t: 'rejoin', v, code: 'ABCDE', token: '0123456789abcdef' })).toEqual({ t: 'rejoin', v, code: 'ABCDE', token: '0123456789abcdef' });
    expect(parseClientMsg({ t: 'lobby', cls: 'knight', ready: true, oath: 3 })).toEqual({ t: 'lobby', cls: 'knight', ready: true, oath: 3 });
    expect(parseClientMsg({ t: 'lobby' })).toEqual({ t: 'lobby' });
    expect(parseClientMsg({ t: 'start' })).toEqual({ t: 'start' });
    expect(parseClientMsg({ t: 'pick', index: 2 })).toEqual({ t: 'pick', index: 2 });
    expect(parseClientMsg({ t: 'toLobby' })).toEqual({ t: 'toLobby' });
    expect(parseClientMsg({ t: 'leave' })).toEqual({ t: 'leave' });
    expect(parseClientMsg({ t: 'ping', c: 12.5 })).toEqual({ t: 'ping', c: 12.5 });
  });

  it('sanitises loadouts: garbage becomes the default, levels are clamped to 0..max, look indices to their range', () => {
    const max = META_UPGRADES.map((u) => u.costs.length);
    expect(sanitizeLoadout(undefined)).toEqual({ look: DEFAULT_LOOK, meta: max.map(() => 0) });
    for (const junk of [null, 7, 'x', [], { look: 'red', meta: 'all' }, { look: [], meta: {} }]) {
      expect(sanitizeLoadout(junk), JSON.stringify(junk)).toEqual({ look: DEFAULT_LOOK, meta: max.map(() => 0) });
    }
    const over = sanitizeLoadout({ look: { color: 99, head: 0, cape: false, style: -4, hat: 'crown' }, meta: [99, -3, 2.9, NaN, Infinity, '3', null, 1e9, 1, 5, 5, 5] });
    expect(over.look).toEqual({ color: LOOK.COLORS.length - 1, head: true, cape: false, style: 0 });
    expect(over.meta).toEqual([max[0], 0, 2, 0, 0, 0, 0, max[7], 1]);
    expect(over.meta).toHaveLength(META_UPGRADES.length);
    for (let i = 0; i < over.meta.length; i++) expect(Number.isInteger(over.meta[i]) && over.meta[i]! >= 0 && over.meta[i]! <= max[i]!).toBe(true);
    // The same clamping applies inside messages; a hostile loadout never makes a message invalid.
    const msg = parseClientMsg({ t: 'create', v, name: 'A', cls: 'mage', loadout: { look: { color: -1, style: 7.9 }, meta: [1e6] } });
    expect(msg).toEqual({ t: 'create', v, name: 'A', cls: 'mage', tutorial: false, loadout: { look: { color: 0, head: true, cape: true, style: LOOK.STYLES - 1 }, meta: [max[0], 0, 0, 0, 0, 0, 0, 0, 0] } });
    expect(sanitizeMeta([1, 1])).toEqual([1, 1, 0, 0, 0, 0, 0, 0, 0]);
    expect(sanitizeLook({ color: 2.7 }).color).toBe(2);
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
      { t: 'lobby', cls: 'nope' }, { t: 'lobby', ready: 'yes' }, { t: 'lobby', oath: 4 }, { t: 'lobby', oath: -1 }, { t: 'lobby', oath: 1.5 },
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
