import { describe, expect, it } from 'vitest';
import { RUN, TICK_DT, WORLD } from '@shared/constants.ts';
import { BOON_BY_ID } from '@shared/data/boons.ts';
import { CLASSES } from '@shared/data/classes.ts';
import { REWARDS } from '@shared/data/meta.ts';
import { TUTORIAL_STEPS, type TutorialStep } from '@shared/data/tutorial.ts';
import { killEnemy } from '@shared/sim/combat.ts';
import { BotBrain, maxMetaLevels, TUTORIAL, viewFromWorld, World } from '@shared/sim/index.ts';
import { BTN, CLASS_IDS, type ClassId, type GameEvent } from '@shared/types.ts';
import { hits, input, seconds } from './harness.ts';

interface Session {
  w: World;
  bot: BotBrain;
  events: GameEvent[];
  steps: { step: string; tick: number }[];
  seq: number;
}

function open(cls: ClassId, seed = 1, meta?: number[]): Session {
  const w = new World();
  expect(w.addPlayer(0, cls, 'Rookie', meta)).toBe(true);
  expect(w.startTutorial(seed)).toBe(true);
  const s: Session = { w, bot: new BotBrain(0, cls, seed), events: [], steps: [], seq: 0 };
  collect(s);
  return s;
}

function collect(s: Session): GameEvent[] {
  const ev = s.w.drainEvents();
  s.bot.observe(ev, s.w.tick);
  for (const e of ev) if (e.e === 'tutorialStep') s.steps.push({ step: e.step, tick: s.w.tick });
  s.events.push(...ev);
  return ev;
}

/** The scripted "good" player: the bot, which only uses what a client sees. */
function playTick(s: Session): GameEvent[] {
  const { w, bot } = s;
  if (w.run.phase === 'draft') {
    const offers = w.getDraft(0);
    if (offers.length > 0) w.pickBoon(0, bot.chooseBoon(offers, w.getBoons(0)));
  }
  const cmd = bot.think(viewFromWorld(w, 0));
  cmd.seq = ++s.seq;
  w.applyInput(0, cmd);
  w.step();
  return collect(s);
}

/** A player who does nothing at all. */
function idleTick(s: Session): GameEvent[] {
  s.w.applyInput(0, input(++s.seq));
  s.w.step();
  return collect(s);
}

const stepNow = (s: Session): TutorialStep => s.w.getRunState().tutorial!.step as TutorialStep;

function playUntil(s: Session, step: TutorialStep | 'victory', budget = seconds(240)): void {
  for (let i = 0; i < budget; i++) {
    if (step === 'victory' ? s.w.run.phase === 'victory' : stepNow(s) === step && s.steps.some((x) => x.step === step)) return;
    playTick(s);
  }
  throw new Error(`the good player did not reach "${step}" (stuck in "${stepNow(s)}")`);
}

describe('tutorial session', () => {
  it('starts at once for a single hero, ignores permanent upgrades, and cannot be started twice or with a party', () => {
    const party = new World();
    party.addPlayer(0, 'knight', 'A');
    party.addPlayer(1, 'mage', 'B');
    expect(party.startTutorial(1)).toBe(false);
    expect(new World().startTutorial(1)).toBe(false);

    const { w, steps } = open('knight', 3, maxMetaLevels());
    const run = w.getRunState();
    expect(run.phase).toBe('combat');
    expect(run.tutorial).toEqual({ step: 'move', index: 0, total: TUTORIAL_STEPS.length, progress: 0, marker: TUTORIAL.MOVE_MARKER });
    expect(steps).toEqual([{ step: 'move', tick: 0 }]);
    expect(run.room).toMatchObject({ biome: 'crypt', w: TUTORIAL.ROOM_W, d: TUTORIAL.ROOM_D });
    expect(run.room!.hazards).toHaveLength(1);
    expect(run).toMatchObject({ chamber: 0, chamberKind: 'combat', bossKind: null, bossId: -1, rewards: [], secondWinds: 0, wave: 0 });
    // No upgrades in training: plain class health, no attunement draft, no rerolls.
    expect(w.hero(0)!.maxHp).toBe(CLASSES.knight.maxHp);
    expect(w.getDraft(0)).toEqual([]);
    expect(w.getRerolls(0)).toBe(0);
    expect(w.startTutorial(1)).toBe(false);
    expect(w.start(0, 1)).toBe(false);
    expect(w.addPlayer(1, 'mage', 'Late')).toBe(false);
  });

  for (const cls of CLASS_IDS) {
    it(`a scripted good ${cls} completes every step in order, well inside three minutes`, () => {
      for (const seed of [1, 2, 3]) {
        const s = open(cls, seed);
        const { w } = s;
        const seen: Record<string, { boons: string[]; phase: string; enemies: number }> = {};
        let downs = 0;
        for (let i = 0; i < seconds(180) && w.run.phase !== 'victory'; i++) {
          const ev = playTick(s);
          downs += ev.filter((e) => e.e === 'down').length;
          const t = w.getRunState().tutorial!;
          expect(t.total).toBe(TUTORIAL_STEPS.length);
          expect(t.index).toBe(TUTORIAL_STEPS.indexOf(t.step as TutorialStep));
          expect(t.progress).toBeGreaterThanOrEqual(0);
          expect(t.progress).toBeLessThanOrEqual(1);
          if (!seen[t.step]) seen[t.step] = { boons: w.getBoons(0).map((b) => b.id), phase: w.run.phase, enemies: w.enemies.filter((e) => !e.dead).length };
          expect(w.hero(0)!.state).toBe('alive');
        }
        const state = w.getRunState();
        expect(state.phase, `${cls} seed ${seed} stuck in ${state.tutorial!.step}`).toBe('victory');
        expect(w.run.elapsed).toBeLessThan(120);
        // Every step began exactly once, in the order of TUTORIAL_STEPS.
        expect(s.steps.map((x) => x.step)).toEqual([...TUTORIAL_STEPS]);
        expect(downs).toBe(0);
        // The infusions arrive as real boons, exactly when their lesson starts.
        expect(seen.secondary!.boons).toEqual([]);
        expect(seen.burn!.boons).toEqual(['infuse_ember_primary']);
        expect(seen.resonance!.boons).toEqual(['infuse_ember_primary', 'infuse_rime_secondary']);
        expect(seen.storm!.boons).toEqual(['infuse_ember_primary', 'infuse_rime_secondary', 'infuse_storm_dash']);
        for (const id of ['infuse_ember_primary', 'infuse_rime_secondary', 'infuse_storm_dash']) {
          expect(s.events.filter((e) => e.e === 'boon' && e.id === id)).toEqual([{ e: 'boon', slot: 0, id, level: 1 }]);
        }
        // Training targets where they are needed, a real draft, a real door.
        expect(seen.attack!.enemies).toBe(TUTORIAL.ATTACK_DUMMIES.length);
        expect(seen.dash!.enemies).toBe(1);
        expect(seen.secondary!.enemies).toBe(TUTORIAL.GROUP_DUMMIES.length);
        expect(seen.hazard!.enemies).toBe(1);
        expect(seen.draft).toMatchObject({ phase: 'draft', enemies: 0 });
        expect(seen.door).toMatchObject({ phase: 'doors', enemies: 0 });
        // One boon more than the three grants: the draft pick.
        expect(w.getBoons(0)).toHaveLength(4);
        expect(s.events.some((e) => e.e === 'resonance')).toBe(true);
        expect(s.events.some((e) => e.e === 'hazardHit' && e.target.t === 'e')).toBe(true);
        expect(s.events).toContainEqual({ e: 'doorChosen', type: 'boon' });
        // Paid once: the fixed tutorial reward, and nothing changes afterwards.
        expect(state.rewards).toEqual([{ slot: 0, glimmer: REWARDS.TUTORIAL }]);
        expect(state.tutorial).toMatchObject({ step: 'door', index: TUTORIAL_STEPS.length - 1, progress: 1 });
        const version = w.runVersion;
        for (let i = 0; i < seconds(5); i++) playTick(s);
        expect(w.getRunState().rewards).toEqual([{ slot: 0, glimmer: REWARDS.TUTORIAL }]);
        expect(w.run.phase).toBe('victory');
        expect(w.runVersion).toBe(version);
        expect(s.steps).toHaveLength(TUTORIAL_STEPS.length);
        expect(w.startTutorial(1)).toBe(false);
      }
    });
  }

  it('the draft step is a real draft and the door step a real door', () => {
    const s = open('mage', 2);
    playUntil(s, 'draft');
    const { w } = s;
    expect(w.run.phase).toBe('draft');
    expect(w.getRunState().draftPending).toEqual([0]);
    expect(w.getRunState().draftTime).toBeGreaterThan(RUN.DRAFT_TIMEOUT_SECONDS - 1);
    const offers = w.getDraft(0);
    expect(offers).toHaveLength(RUN.DRAFT_CHOICES);
    for (const o of offers) expect(BOON_BY_ID.has(o.id)).toBe(true);
    expect(w.pickBoon(0, 2)).toBe(true);
    expect(w.getBoons(0).some((b) => b.id === offers[2]!.id)).toBe(true);
    for (let i = 0; i < seconds(TUTORIAL.STEP_LINGER) + 3; i++) idleTick(s);
    const run = w.getRunState();
    expect(run.tutorial!.step).toBe('door');
    expect(run.phase).toBe('doors');
    expect(run.doors).toHaveLength(1);
    expect(run.doors[0]!.type).toBe('boon');
    expect(run.tutorial!.marker).toEqual({ x: run.doors[0]!.x, z: run.doors[0]!.z, r: WORLD.DOOR_RADIUS });
    // Standing in the door for DOOR_HOLD_SECONDS finishes the session.
    w.hero(0)!.body.x = run.doors[0]!.x;
    w.hero(0)!.body.z = run.doors[0]!.z;
    for (let i = 0; i < seconds(WORLD.DOOR_HOLD_SECONDS) - 3; i++) idleTick(s);
    expect(w.run.phase).toBe('doors');
    expect(w.getRunState().doorProgress[0]).toBeGreaterThan(0.8);
    for (let i = 0; i < 6; i++) idleTick(s);
    expect(w.run.phase).toBe('victory');
    expect(w.getRunState().rewards).toEqual([{ slot: 0, glimmer: REWARDS.TUTORIAL }]);
  });

  it('a passive player cannot die or soft-lock: every step simply waits or repeats, and can still be finished', () => {
    for (const step of TUTORIAL_STEPS) {
      const s = open('knight', 4);
      const { w } = s;
      playUntil(s, step);
      const h = w.hero(0)!;
      const from = s.steps.length;
      let telegraphs = 0;
      let struck = 0;
      for (let i = 0; i < seconds(75); i++) {
        const ev = idleTick(s);
        telegraphs += ev.filter((e) => e.e === 'telegraph').length;
        struck += hits(ev, 'p').length;
        expect(h.state, step).toBe('alive');
        expect(h.hp, step).toBeGreaterThanOrEqual(1);
        expect(ev.filter((e) => e.e === 'down')).toHaveLength(0);
        expect(Number.isFinite(h.body.x) && Number.isFinite(h.body.z)).toBe(true);
      }
      expect(w.run.phase).not.toBe('defeat');
      if (step === 'draft') {
        // The one step that resolves itself: the draft times out with its first offer, like every draft.
        expect(stepNow(s)).toBe('door');
        expect(w.getBoons(0)).toHaveLength(4);
      } else if (step === 'hazard') {
        // The foe may blunder through the spikes on its way to a hero who just stands there: that passes the lesson.
        expect(['hazard', 'draft', 'door']).toContain(stepNow(s));
      } else {
        expect(stepNow(s), `passive player left "${step}"`).toBe(step);
        expect(s.steps).toHaveLength(from);
      }
      if (step === 'dash') {
        // The slow attack kept coming, kept hitting, and never killed.
        expect(telegraphs).toBeGreaterThanOrEqual(Math.floor(75 / (TUTORIAL.DASH_EVERY + TUTORIAL.DASH_WINDUP)) - 2);
        expect(struck).toBeGreaterThan(10);
        expect(h.hp).toBe(1);
      }
      // Waking up, the player finishes from wherever they stopped.
      playUntil(s, 'victory', seconds(200));
      expect(s.steps.map((x) => x.step)).toEqual([...TUTORIAL_STEPS]);
      expect(w.getRunState().rewards).toEqual([{ slot: 0, glimmer: REWARDS.TUTORIAL }]);
    }
  }, 60000);

  it('health floors at 1 whatever hits the hero, including the hazard', () => {
    const s = open('rogue', 5);
    playUntil(s, 'attack');
    const { w } = s;
    const h = w.hero(0)!;
    const hz = w.room.hazards[0]!;
    h.hp = 3;
    h.body.x = hz.x;
    h.body.z = hz.z;
    let hazard = 0;
    for (let i = 0; i < seconds(12); i++) {
      h.body.x = hz.x;
      h.body.z = hz.z;
      w.applyInput(0, input(++s.seq));
      w.step();
      hazard += collect(s).filter((e) => e.e === 'hazardHit' && e.target.t === 'p').length;
      expect(h.state).toBe('alive');
      expect(h.hp).toBeGreaterThanOrEqual(1);
    }
    expect(hazard).toBeGreaterThan(3);
    expect(h.hp).toBe(1);
  });

  it('dash lesson: being hit or merely walking out does not pass it; dashing does; after enough tries any dodge counts', () => {
    const s = open('knight', 6);
    playUntil(s, 'dash');
    const { w } = s;
    const h = w.hero(0)!;
    const attackOnce = (act: (lands: number, lane: Extract<GameEvent, { e: 'telegraph' }>) => void): void => {
      let lane: Extract<GameEvent, { e: 'telegraph' }> | null = null;
      for (let i = 0; i < seconds(TUTORIAL.DASH_EVERY + TUTORIAL.DASH_WINDUP + 2) && !lane; i++) lane = idleTick(s).find((e): e is Extract<GameEvent, { e: 'telegraph' }> => e.e === 'telegraph') ?? null;
      expect(lane, 'the training warrior stopped attacking').not.toBeNull();
      expect(lane).toMatchObject({ shape: 'line', dur: TUTORIAL.DASH_WINDUP, w: TUTORIAL.DASH_WIDTH });
      act(w.tick + seconds(TUTORIAL.DASH_WINDUP), lane!);
    };
    // 1: stand still -> hit, step repeats.
    attackOnce((lands) => { while (w.tick < lands + 2) idleTick(s); });
    expect(stepNow(s)).toBe('dash');
    expect(w.getRunState().tutorial!.progress).toBe(0);
    // 2 + 3: walk out of the lane -> not hit, but no dash: still repeats.
    for (let n = 0; n < 2; n++) {
      attackOnce((lands, lane) => {
        while (w.tick < lands + 2) { w.applyInput(0, input(++s.seq, { moveX: Math.cos(lane.rot), moveZ: -Math.sin(lane.rot) })); w.step(); collect(s); }
      });
      expect(stepNow(s)).toBe('dash');
    }
    expect(w.getRunState().tutorial!.progress).toBe(0);
    // 4: dash through at the last moment -> passed.
    const hp = h.hp;
    attackOnce((lands, lane) => {
      // Back into the lane first.
      h.body.x = lane.x + Math.sin(lane.rot) * 5;
      h.body.z = lane.z + Math.cos(lane.rot) * 5;
      while (w.tick < lands - 4) idleTick(s);
      w.applyInput(0, input(++s.seq, { moveX: Math.cos(lane.rot), moveZ: -Math.sin(lane.rot), buttons: BTN.DASH }));
      w.step();
      collect(s);
      while (w.tick < lands + 2) idleTick(s);
    });
    expect(h.hp).toBe(hp);
    expect(w.getRunState().tutorial!.progress).toBe(1);
    for (let i = 0; i < seconds(TUTORIAL.STEP_LINGER) + 2; i++) idleTick(s);
    expect(stepNow(s)).toBe('secondary');

    // Fallback: a player who never finds the dash key passes by dodging on foot after DASH_FALLBACK_ATTEMPTS tries.
    const f = open('mage', 7);
    playUntil(f, 'dash');
    let tries = 0;
    for (let i = 0; i < seconds((TUTORIAL.DASH_EVERY + TUTORIAL.DASH_WINDUP) * (TUTORIAL.DASH_FALLBACK_ATTEMPTS + 3)) && stepNow(f) === 'dash'; i++) {
      // Run in a wide circle: the lane (aimed at where the hero was) is always left on foot.
      const a = f.w.tick * TICK_DT * 1.4;
      f.w.applyInput(0, input(++f.seq, { moveX: Math.cos(a), moveZ: Math.sin(a) }));
      f.w.step();
      tries += collect(f).filter((e) => e.e === 'telegraph').length;
    }
    expect(stepNow(f)).toBe('secondary');
    expect(tries).toBeGreaterThanOrEqual(TUTORIAL.DASH_FALLBACK_ATTEMPTS);
  });

  it('targets destroyed the wrong way come back, so no lesson can be lost', () => {
    for (const step of ['secondary', 'burn', 'resonance', 'storm', 'hazard'] as const) {
      const s = open('barbarian', 8);
      playUntil(s, step);
      const { w } = s;
      const before = w.enemies.filter((e) => !e.dead).length;
      expect(before).toBeGreaterThan(0);
      for (let round = 0; round < 3; round++) {
        for (const e of w.enemies) if (!e.dead) killEnemy(w, e, 0);
        for (let i = 0; i < seconds(TUTORIAL.DUMMY_RESPAWN_SECONDS + 1.5); i++) idleTick(s);
        expect(w.enemies.filter((e) => !e.dead).length, step).toBe(before);
        expect(stepNow(s)).toBe(step);
      }
      playUntil(s, 'victory', seconds(200));
    }
  });

  it('reset() returns to a normal lobby', () => {
    const s = open('knight', 9);
    playUntil(s, 'burn');
    s.w.reset();
    const run = s.w.getRunState();
    expect(run).toMatchObject({ phase: 'lobby', tutorial: null, rewards: [], room: null });
    expect(s.w.getBoons(0)).toEqual([]);
    expect(s.w.start(0, 5)).toBe(true);
    expect(s.w.getRunState().tutorial).toBeNull();
  });
});
