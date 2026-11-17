import { describe, expect, it } from 'vitest';
import { TICK_DT, WORLD } from '@shared/constants.ts';
import { CLASSES, COMBO_WINDOW, DASH } from '@shared/data/classes.ts';
import { ENEMIES } from '@shared/data/enemies.ts';
import { SIM } from '@shared/sim/index.ts';
import { BTN, PF } from '@shared/types.ts';
import { casts, dummy, hits, live, Pad, place, sandbox, seconds, stepN } from './harness.ts';

const R = ENEMIES.minion.radius;
const deg = (d: number): number => (d * Math.PI) / 180;
const at = (angleDeg: number, dist: number): [number, number] => [Math.sin(deg(angleDeg)) * dist, Math.cos(deg(angleDeg)) * dist];

describe('arc (melee swing)', () => {
  it('hits inside reach + angle, including the target radius, and nothing else', () => {
    const w = sandbox(['knight']);
    place(w, 0, 0, 0);
    const slash = CLASSES.knight.primary[0]!;
    const front = dummy(w, 0, 2.5);
    const behind = dummy(w, 0, -2.5);
    const edge = dummy(w, ...at(0, slash.range + R - 0.05));
    const far = dummy(w, ...at(0, slash.range + R + 0.25));
    const side = dummy(w, ...at(slash.arc / 2 + 5, 2));
    const wide = dummy(w, ...at(slash.arc / 2 + 30, 2));
    const pad = new Pad(w);
    const ev = pad.hold({ buttons: BTN.PRIMARY, aim: 0 }, 1);
    ev.push(...pad.hold({ aim: 0 }, seconds(slash.windup) + 2));
    expect(casts(ev)).toEqual([slash.id]);
    const struck = new Set(hits(ev, 'e').map((h) => h.target.id));
    expect(struck).toEqual(new Set([front.id, edge.id, side.id]));
    expect(front.hp).toBe(front.maxHp - slash.damage);
    expect(behind.hp).toBe(behind.maxHp);
    expect(far.hp).toBe(far.maxHp);
    expect(wide.hp).toBe(wide.maxHp);
  });

  it('deals its damage only when the windup has elapsed', () => {
    const w = sandbox(['barbarian']);
    place(w, 0, 0, 0);
    const chop = CLASSES.barbarian.primary[0]!;
    const target = dummy(w, 0, 2);
    const pad = new Pad(w);
    const early = pad.hold({ buttons: BTN.PRIMARY }, 1);
    early.push(...pad.hold({}, seconds(chop.windup) - 2));
    expect(hits(early, 'e')).toHaveLength(0);
    const late = pad.hold({}, 3);
    expect(hits(late, 'e', target.id)).toHaveLength(1);
  });

  it('fires along the aim at activation time even if the aim changes during the windup', () => {
    const w = sandbox(['barbarian']);
    place(w, 0, 0, 0);
    const north = dummy(w, 0, 2);
    const south = dummy(w, 0, -2);
    const pad = new Pad(w);
    pad.hold({ buttons: BTN.PRIMARY, aim: 0 }, 1);
    pad.hold({ aim: Math.PI }, seconds(CLASSES.barbarian.primary[0]!.windup) + 2);
    expect(north.hp).toBeLessThan(north.maxHp);
    expect(south.hp).toBe(south.maxHp);
  });
});

describe('projectile', () => {
  it('flies along the aim, hits the first enemy and stops', () => {
    const w = sandbox(['mage']);
    place(w, 0, 0, 0);
    const bolt = CLASSES.mage.primary[0]!;
    const first = dummy(w, 0, 6);
    const second = dummy(w, 0, 9);
    const pad = new Pad(w);
    const ev = pad.hold({ buttons: BTN.PRIMARY, aim: 0 }, 1);
    ev.push(...pad.hold({}, seconds(1)));
    expect(first.hp).toBe(first.maxHp - bolt.damage);
    expect(second.hp).toBe(second.maxHp);
    expect(w.projectiles).toHaveLength(0);
  });

  it('pierces exactly `pierce` extra enemies', () => {
    const w = sandbox(['rogue']);
    place(w, 0, 0, 0);
    const bolt = CLASSES.rogue.primary[0]!;
    const targets = [4, 6, 8].map((z) => dummy(w, 0, z));
    const pad = new Pad(w);
    pad.hold({ buttons: BTN.PRIMARY, aim: 0 }, 1);
    pad.hold({}, seconds(1));
    const struck = targets.filter((t) => t.hp < t.maxHp);
    expect(struck).toHaveLength(bolt.pierce + 1);
    expect(struck).toEqual(targets.slice(0, bolt.pierce + 1));
  });

  it('never tunnels: a very fast bolt still hits a thin target (swept circle)', () => {
    const w = sandbox(['mage']);
    place(w, 0, 0, 0);
    const target = dummy(w, 0, 9.5);
    const pad = new Pad(w);
    pad.hold({ buttons: BTN.PRIMARY, aim: 0 }, 1);
    pad.hold({}, seconds(CLASSES.mage.primary[0]!.windup) + 1);
    expect(w.projectiles).toHaveLength(1);
    w.projectiles[0]!.speed = 400;
    w.projectiles[0]!.radius = 0.01;
    stepN(w, 2);
    expect(target.hp).toBeLessThan(target.maxHp);
  });

  it('stops at obstacles and walls and expires at max range', () => {
    const w = sandbox(['mage']);
    w.room.obstacles.push({ x: 0, z: 4, r: 1, kind: 'pillar' });
    place(w, 0, 0, 0);
    const hidden = dummy(w, 0, 7);
    const pad = new Pad(w);
    pad.hold({ buttons: BTN.PRIMARY, aim: 0 }, 1);
    pad.hold({}, seconds(1));
    expect(hidden.hp).toBe(hidden.maxHp);
    expect(w.projectiles).toHaveLength(0);
    // Towards a wall: must be gone before it could leave the room.
    pad.hold({ buttons: BTN.PRIMARY, aim: Math.PI / 2 }, 1);
    for (let i = 0; i < seconds(2); i++) {
      pad.hold({ aim: Math.PI / 2 }, 1);
      for (const p of w.projectiles) expect(Math.abs(p.x)).toBeLessThanOrEqual(w.room.w / 2 + 1e-6);
    }
    expect(w.projectiles).toHaveLength(0);
  });

  it('spreads `count` projectiles over the arc (knife fan)', () => {
    const w = sandbox(['rogue']);
    place(w, 0, 0, 0);
    const fan = CLASSES.rogue.secondary;
    const pad = new Pad(w);
    pad.hold({ buttons: BTN.SECONDARY, aim: 0 }, 1);
    pad.hold({}, seconds(fan.windup) + 1);
    expect(w.projectiles).toHaveLength(fan.count);
    const rots = w.projectiles.map((p) => Math.atan2(p.dirX, p.dirZ)).sort((a, b) => a - b);
    expect(rots[rots.length - 1]! - rots[0]!).toBeCloseTo(deg(fan.arc), 5);
    expect(w.projectiles.every((p) => p.kind === 'knife' && !p.hostile)).toBe(true);
  });

  it('never exceeds the projectile cap', () => {
    const w = sandbox(['rogue']);
    place(w, 0, 0, 0);
    for (let i = 0; i < 300; i++) {
      w.hero(0)!.secondaryCd = 0;
      w.hero(0)!.lockTime = 0;
      w.hero(0)!.pressSecondary = 1;
      w.step();
      expect(w.projectiles.length).toBeLessThanOrEqual(WORLD.MAX_PROJECTILES);
    }
  });
});

describe('circle (ground blast)', () => {
  it('lands at the cursor, clamped to the ability range, after the windup', () => {
    const w = sandbox(['mage']);
    place(w, 0, 0, -10);
    const nova = CLASSES.mage.secondary;
    const inRange = dummy(w, 0, -10 + nova.range);
    const beyond = dummy(w, 0, -10 + nova.range + nova.radius + R + 1.5);
    const pad = new Pad(w);
    const ev = pad.hold({ buttons: BTN.SECONDARY, aim: 0, aimDist: 25 }, 1);
    const cast = ev.find((e) => e.e === 'cast');
    expect(cast).toMatchObject({ ability: nova.id, x: 0 });
    expect((cast as { z: number }).z).toBeCloseTo(-10 + nova.range, 5);
    ev.push(...pad.hold({}, seconds(nova.windup) - 2));
    expect(inRange.hp).toBe(inRange.maxHp);
    const late = pad.hold({}, 4);
    expect(late.some((e) => e.e === 'aoe' && !e.hostile && e.r === nova.radius)).toBe(true);
    expect(inRange.hp).toBe(inRange.maxHp - nova.damage);
    expect(beyond.hp).toBe(beyond.maxHp);
  });
});

describe('spin (whirlwind)', () => {
  it('pulses duration / tick times around the moving hero', () => {
    const w = sandbox(['barbarian']);
    place(w, 0, 0, 0);
    const whirl = CLASSES.barbarian.secondary;
    const near = dummy(w, 0.5, 0);
    const far = dummy(w, 0, whirl.radius + R + 4);
    const pad = new Pad(w);
    const ev = pad.hold({ buttons: BTN.SECONDARY }, 1);
    ev.push(...pad.hold({}, seconds(whirl.duration + whirl.windup) + 4));
    const pulses = Math.round(whirl.duration / whirl.tick);
    expect(hits(ev, 'e', near.id)).toHaveLength(pulses);
    expect(near.hp).toBeCloseTo(near.maxHp - pulses * whirl.damage, 5);
    expect(far.hp).toBe(far.maxHp);
    expect(w.hero(0)!.spin).toBeNull();
  });
});

describe('lunge (shield bash)', () => {
  it('moves the hero along the aim, hits everything near the path once, stuns and shields', () => {
    const w = sandbox(['knight']);
    place(w, 0, 0, 0);
    const bash = CLASSES.knight.secondary;
    const onPath = dummy(w, 0, 3);
    const beside = dummy(w, bash.radius + R - 0.1, 2);
    const away = dummy(w, bash.radius + R + 1, 2);
    onPath.stunTime = 0;
    const pad = new Pad(w);
    const ev = pad.hold({ buttons: BTN.SECONDARY, aim: 0 }, 1);
    expect(w.hero(0)!.tempShield).toBe(bash.selfShield);
    expect(w.hero(0)!.body.rootTime).toBeGreaterThan(0);
    expect(w.getSelfState(0).moveSpeed).toBe(0);
    ev.push(...pad.hold({ moveX: 1 }, seconds(bash.lock) + 2));
    const h = w.hero(0)!;
    expect(h.body.z).toBeCloseTo(bash.range, 1);
    expect(h.body.x).toBeLessThan(0.5);
    expect(hits(ev, 'e', onPath.id)).toHaveLength(1);
    expect(hits(ev, 'e', beside.id)).toHaveLength(1);
    expect(hits(ev, 'e', away.id)).toHaveLength(0);
    expect(onPath.stunTime).toBeGreaterThan(0);
    expect(onPath.stunTime).toBeLessThanOrEqual(bash.stun);
  });

  it('reports the lunge through SelfState as a dash so the client can replay it', () => {
    const w = sandbox(['knight']);
    place(w, 0, 0, 0);
    const pad = new Pad(w);
    pad.hold({ buttons: BTN.SECONDARY, aim: Math.PI / 2 }, 1);
    let sawDash = false;
    for (let i = 0; i < seconds(0.3); i++) {
      pad.hold({ aim: 0 }, 1);
      const self = w.getSelfState(0);
      if (self.dashTime > 0) {
        sawDash = true;
        expect(self.dashDirX).toBeCloseTo(1, 5);
        // Facing follows the lunge, not the cursor.
        expect(w.getSnapshotBody().players[0]!.rot).toBeCloseTo(Math.PI / 2, 5);
      }
    }
    expect(sawDash).toBe(true);
  });

  it('stops at obstacles and walls', () => {
    const w = sandbox(['knight']);
    w.room.obstacles.push({ x: 0, z: 2.5, r: 0.9, kind: 'pillar' });
    place(w, 0, 0, 0);
    const pad = new Pad(w);
    pad.hold({ buttons: BTN.SECONDARY, aim: 0 }, 1);
    pad.hold({}, seconds(0.6));
    expect(w.hero(0)!.body.z).toBeLessThanOrEqual(2.5 - 0.9 - WORLD.PLAYER_RADIUS + 1e-6);
    place(w, 0, 0, w.room.d / 2 - 1);
    w.hero(0)!.secondaryCd = 0;
    pad.hold({ buttons: BTN.SECONDARY, aim: 0 }, 1);
    pad.hold({}, seconds(0.6));
    expect(w.hero(0)!.body.z).toBeCloseTo(w.room.d / 2 - WORLD.PLAYER_RADIUS, 5);
  });
});

describe('combo chain, cooldowns and buffering', () => {
  it('holding PRIMARY walks through the chain and loops', () => {
    const w = sandbox(['knight']);
    const pad = new Pad(w);
    const ev = pad.hold({ buttons: BTN.PRIMARY }, seconds(2.4));
    const ids = casts(ev);
    expect(ids.slice(0, 5)).toEqual(['knight_slash1', 'knight_slash2', 'knight_slash3', 'knight_slash1', 'knight_slash2']);
  });

  it('respects each attack\'s cooldown', () => {
    const w = sandbox(['knight']);
    const pad = new Pad(w);
    const first = CLASSES.knight.primary[0]!;
    let ticksBetween = 0;
    pad.hold({ buttons: BTN.PRIMARY }, 1);
    while (casts(pad.hold({ buttons: BTN.PRIMARY }, 1)).length === 0) ticksBetween++;
    expect((ticksBetween + 1) * TICK_DT).toBeGreaterThanOrEqual(first.cooldown - 1e-6);
    expect((ticksBetween + 1) * TICK_DT).toBeLessThan(first.cooldown + 2 * TICK_DT);
  });

  it('continues within COMBO_WINDOW after the lock and resets after it', () => {
    const w = sandbox(['knight']);
    const pad = new Pad(w);
    const first = CLASSES.knight.primary[0]!;
    expect(casts(pad.hold({ buttons: BTN.PRIMARY }, 1))).toEqual(['knight_slash1']);
    pad.hold({}, seconds(first.lock + COMBO_WINDOW) - 3);
    expect(casts(pad.hold({ buttons: BTN.PRIMARY }, 1))).toEqual(['knight_slash2']);
    pad.hold({}, seconds(CLASSES.knight.primary[1]!.lock + COMBO_WINDOW) + 2);
    expect(casts(pad.hold({ buttons: BTN.PRIMARY }, 1))).toEqual(['knight_slash1']);
  });

  it('SECONDARY triggers once per press and then waits for its cooldown', () => {
    const w = sandbox(['mage']);
    const pad = new Pad(w);
    const nova = CLASSES.mage.secondary;
    const ev = pad.hold({ buttons: BTN.SECONDARY }, seconds(nova.cooldown) + 30);
    expect(casts(ev)).toEqual([nova.id]);
    // Fresh press while on cooldown: nothing. Fresh press once ready: casts again.
    const w2 = sandbox(['mage']);
    const pad2 = new Pad(w2);
    pad2.hold({ buttons: BTN.SECONDARY }, 1);
    pad2.hold({}, 5);
    const snap = w2.getSnapshotBody().players[0]!;
    expect(snap.cdSecondary).toBeGreaterThan(0.8);
    expect(snap.cdSecondary).toBeLessThanOrEqual(1);
    expect(casts(pad2.hold({ buttons: BTN.SECONDARY }, 1))).toEqual([]);
    pad2.hold({}, seconds(nova.cooldown));
    expect(w2.getSnapshotBody().players[0]!.cdSecondary).toBe(0);
    expect(casts(pad2.hold({ buttons: BTN.SECONDARY }, 2))).toEqual([nova.id]);
  });

  it('buffers a press made shortly before the lock ends and drops one made too early', () => {
    const slash = CLASSES.knight.primary[0]!;
    const run = (pressAfter: number): string[] => {
      const w = sandbox(['knight']);
      const pad = new Pad(w);
      const ev = pad.hold({ buttons: BTN.PRIMARY }, 1);
      ev.push(...pad.hold({}, seconds(pressAfter) - 1));
      ev.push(...pad.hold({ buttons: BTN.SECONDARY }, 1));
      ev.push(...pad.hold({}, seconds(0.5)));
      return casts(ev);
    };
    expect(run(slash.lock - SIM.PRESS_BUFFER_SECONDS + 0.05)).toEqual([slash.id, 'knight_bash']);
    expect(run(slash.lock - SIM.PRESS_BUFFER_SECONDS - 0.1)).toEqual([slash.id]);
  });

  it('slows the hero by moveMul for exactly `lock` seconds and reports it in SelfState', () => {
    const w = sandbox(['barbarian']);
    place(w, 0, 0, 0);
    const chop = CLASSES.barbarian.primary[0]!;
    const base = CLASSES.barbarian.moveSpeed;
    const pad = new Pad(w);
    pad.hold({ moveX: 1 }, 1);
    expect(w.getSelfState(0).moveSpeed).toBeCloseTo(base, 6);
    let slowTicks = 0;
    pad.hold({ moveX: 1, buttons: BTN.PRIMARY }, 1);
    while (Math.abs(w.getSelfState(0).moveSpeed - base * chop.moveMul) < 1e-6) {
      slowTicks++;
      pad.hold({ moveX: 1 }, 1);
    }
    expect(slowTicks).toBe(Math.ceil(chop.lock / TICK_DT - 1e-6));
    expect(w.getSelfState(0).moveSpeed).toBeCloseTo(base, 6);
  });
});

describe('dash', () => {
  it('uses a charge, grants i-frames, and recharges after DASH.COOLDOWN', () => {
    const w = sandbox(['knight']);
    place(w, 0, 0, 0);
    const pad = new Pad(w);
    const ev = pad.hold({ buttons: BTN.DASH, moveX: 1 }, 1);
    expect(casts(ev)).toEqual(['dash']);
    let snap = w.getSnapshotBody().players[0]!;
    expect(snap.dashCharges).toBe(0);
    expect(snap.flags & PF.INVULNERABLE).toBeTruthy();
    expect(snap.anim).toBe('dash');
    expect(snap.rot).toBeCloseTo(Math.PI / 2, 5);
    expect(w.getSelfState(0).dashTime).toBeGreaterThan(0);
    pad.hold({ buttons: BTN.DASH, moveX: 1 }, seconds(DASH.DURATION) + 1);
    expect(w.hero(0)!.body.x).toBeGreaterThanOrEqual(DASH.SPEED * DASH.DURATION - 1e-6);
    expect(w.hero(0)!.body.x).toBeLessThan(DASH.SPEED * DASH.DURATION + 0.5);
    // Holding the button does not dash again, and neither does a fresh press without a charge.
    pad.hold({}, 1);
    expect(casts(pad.hold({ buttons: BTN.DASH }, 1))).toEqual([]);
    snap = w.getSnapshotBody().players[0]!;
    expect(snap.cdDash).toBeGreaterThan(0);
    pad.hold({}, seconds(DASH.COOLDOWN));
    snap = w.getSnapshotBody().players[0]!;
    expect(snap.dashCharges).toBe(1);
    expect(snap.cdDash).toBe(0);
    expect(casts(pad.hold({ buttons: BTN.DASH }, 1))).toEqual(['dash']);
  });

  it('gives the rogue two charges', () => {
    const w = sandbox(['rogue']);
    const pad = new Pad(w);
    expect(casts(pad.hold({ buttons: BTN.DASH, moveX: 1 }, 1))).toEqual(['dash']);
    pad.hold({ moveX: 1 }, seconds(DASH.DURATION) + 1);
    expect(casts(pad.hold({ buttons: BTN.DASH, moveX: 1 }, 1))).toEqual(['dash']);
    pad.hold({ moveX: 1 }, seconds(DASH.DURATION) + 1);
    expect(casts(pad.hold({ buttons: BTN.DASH, moveX: 1 }, 1))).toEqual([]);
  });

  it('i-frames avoid an attack that lands mid-dash, and end after DASH.IFRAMES', () => {
    const w = sandbox(['knight']);
    place(w, 0, 0, 0);
    const mage = live(w, 'mage', 0, 9);
    mage.blinkCd = 999;
    const pad = new Pad(w);
    // Wait for the blast telegraph, then dash on the spot-ish just before it lands (staying inside the circle).
    let lands = -1;
    for (let i = 0; i < seconds(3) && lands < 0; i++) {
      const tele = pad.hold({}, 1).find((e) => e.e === 'telegraph');
      if (tele && tele.e === 'telegraph') lands = w.tick + seconds(tele.dur);
    }
    expect(lands).toBeGreaterThan(0);
    pad.hold({}, lands - w.tick - 3);
    w.hero(0)!.body.x = 0; w.hero(0)!.body.z = 0;
    // A tiny room-edge trick keeps the dash inside the blast: dash into the wall-less centre and come back.
    const ev = pad.hold({ buttons: BTN.DASH, moveX: 1 }, 1);
    for (let i = 0; i < 6; i++) { w.hero(0)!.body.x = 0; ev.push(...pad.hold({}, 1)); }
    expect(hits(ev, 'p')).toHaveLength(0);
    expect(w.hero(0)!.hp).toBe(w.hero(0)!.maxHp);
    expect(ev.some((e) => e.e === 'aoe' && e.hostile)).toBe(true);
    // Control: without the dash the same blast hurts.
    const w2 = sandbox(['knight']);
    place(w2, 0, 0, 0);
    live(w2, 'mage', 0, 9).blinkCd = 999;
    const pad2 = new Pad(w2);
    const ev2 = pad2.hold({}, seconds(3));
    expect(hits(ev2, 'p').length).toBeGreaterThan(0);
  });

  it('cancels an ability root (a dash is always available as an escape)', () => {
    const w = sandbox(['knight']);
    place(w, 0, 0, 0);
    const pad = new Pad(w);
    pad.hold({ buttons: BTN.SECONDARY, aim: 0 }, 1);
    expect(w.hero(0)!.body.rootTime).toBeGreaterThan(0);
    pad.hold({ buttons: BTN.DASH, moveX: -1 }, 1);
    const self = w.getSelfState(0);
    expect(self.rootTime).toBe(0);
    expect(self.dashTime).toBeGreaterThan(0);
    expect(self.dashDirX).toBeCloseTo(-1, 5);
    expect(w.hero(0)!.body.x).toBeLessThan(0);
  });
});

describe('input queue', () => {
  it('consumes one input per tick and acknowledges its seq', () => {
    const w = sandbox(['knight']);
    const pad = new Pad(w);
    pad.send({ moveX: 1 });
    pad.send({ moveX: 1 });
    pad.send({ moveX: 1 });
    w.step();
    expect(w.getSelfState(0).ackSeq).toBe(1);
    w.step();
    expect(w.getSelfState(0).ackSeq).toBe(2);
  });

  it('keeps at most INPUT_BUFFER_MAX inputs and drops the oldest', () => {
    const w = sandbox(['knight']);
    const pad = new Pad(w);
    for (let i = 0; i < SIM.INPUT_BUFFER_MAX + 3; i++) pad.send({});
    w.step();
    expect(w.getSelfState(0).ackSeq).toBe(4);
    expect(w.hero(0)!.queue).toHaveLength(SIM.INPUT_BUFFER_MAX - 1);
  });

  it('reuses the last move when the queue is empty but creates no new button presses', () => {
    const w = sandbox(['rogue']);
    place(w, 0, 0, 0);
    const pad = new Pad(w);
    const ev = pad.hold({ moveX: 1, buttons: BTN.DASH | BTN.PRIMARY }, 1);
    const x1 = w.hero(0)!.body.x;
    ev.push(...stepN(w, seconds(6)));
    expect(w.hero(0)!.body.x).toBeGreaterThan(x1 + 5);
    expect(w.getSelfState(0).ackSeq).toBe(1);
    // DASH is edge-triggered (one dash although the button stays down); PRIMARY is a held state and keeps firing.
    expect(casts(ev).filter((c) => c === 'dash')).toHaveLength(1);
    expect(casts(ev).filter((c) => c === 'rogue_bolt').length).toBeGreaterThan(10);
  });

  it('sanitises hostile numbers', () => {
    const w = sandbox(['knight']);
    place(w, 0, 0, 0);
    w.applyInput(0, { seq: NaN, moveX: Infinity, moveZ: NaN, aim: NaN, aimDist: -Infinity, buttons: 1e9 });
    w.applyInput(0, { seq: 5, moveX: 1e9, moveZ: -1e9, aim: 1e12, aimDist: 1e9, buttons: -1 });
    w.applyInput(0, { seq: 6 } as never);
    stepN(w, 5);
    const h = w.hero(0)!;
    for (const v of [h.body.x, h.body.z, h.rot, h.hp, h.body.moveSpeed]) expect(Number.isFinite(v)).toBe(true);
    const speed = CLASSES.knight.moveSpeed;
    expect(Math.hypot(h.body.x, h.body.z)).toBeLessThanOrEqual(speed * 5 * TICK_DT + DASH.SPEED * DASH.DURATION + 1e-6);
  });
});
