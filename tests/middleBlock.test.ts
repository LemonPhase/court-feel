import { describe, expect, it } from 'vitest';
import { AI, CONTACT, COURT, PLAYER, SIM } from '../src/config';
import { Rng } from '../src/core/mathx';
import { Athlete } from '../src/game/athlete';
import type { Touch } from '../src/game/ballEntity';
import type { Game } from '../src/game/game';
import { attackHeight, laneFor, quickSpot, SETTER_SPOT, SETTER_TARGET } from '../src/game/plays';
import { makeBall, stepBall, type BallEnv, type V3 } from '../src/physics/ball';
import { BallPredictor } from '../src/physics/predict';
import { solveApex, solveFixedTime } from '../src/physics/solve';
import { BallRead } from '../src/ai/read';
import { MiddleBlocker, type Guess } from '../src/ai/middle';
import { shoulderToShoulder } from '../src/ai/giveWay';
import { blockHands } from '../src/game/contact';

const DT = 1 / SIM.hz;
/** the other team: we (the home side, +z) block their attack */
const THEM = -1 as const;
const NO_SPIN: V3 = { x: 0, y: 0, z: 0 };

type Set = 'outside' | 'opposite' | 'quick';

/**
 * Our middle against their pass and set, on a stand-in for the Game: the middle only needs the
 * ball (state and prediction), the clock, the rng and a block that never touches. Their middle is
 * scripted: it stands near the net, or plants and takes off with the setter's touch (a quick).
 */
function net(opts: { seed?: number; guess?: Guess | null; theirMiddleX?: number; quick?: boolean; wing?: boolean } = {}) {
  const state = makeBall();
  const predictor = new BallPredictor(DT, SIM.predictHorizon);
  let version = 0;
  let predicted = -1;
  const env: BallEnv = { netTop: COURT.netHeightMen };
  const ball = {
    state,
    active: true,
    lastTouch: null as Touch | null,
    get pos() {
      return state.p;
    },
    get vel() {
      return state.v;
    },
    speed: () => Math.hypot(state.v.x, state.v.y, state.v.z),
    ensurePrediction(e: BallEnv, t: number) {
      if (predicted !== version) {
        predictor.compute(state, e, t);
        predicted = version;
      }
      return predictor;
    },
    touch(from: V3, v: V3) {
      Object.assign(state.p, from);
      Object.assign(state.v, v);
      state.rest = false;
      version++;
    },
  };
  const g = { simTime: 0, env, rng: new Rng(opts.seed ?? 1), ball, contact: { tryBlock: () => false } };
  const game = g as unknown as Game;

  const me = new Athlete('MB', 1);
  me.place(0, 0.5, 0);
  const qx = quickSpot(SETTER_TARGET.x * THEM, THEM).x;
  const them = new Athlete('MB', THEM);
  them.place(opts.theirMiddleX ?? qx, -1.8, Math.PI);
  /** our pin blocker (opts.wing): stands at the net on the attack, shading the line, as the set goes up */
  const wing = new Athlete('OPP', 1);
  wing.place(3, 0.45, 0);
  const mb = new MiddleBlocker(
    me,
    0,
    () => them,
    () => (opts.wing ? [wing] : []),
  );
  if (opts.guess) mb.pinnedGuess = opts.guess;
  const passer = new Athlete('L', THEM);
  const setter = new Athlete('S', THEM);

  /** our middle's take-offs, and the top of each jump */
  const jumps: { t: number; x: number; peakT: number }[] = [];
  me.onTakeoff = (a) => jumps.push({ t: g.simTime, x: a.pos.x, peakT: -1 });
  /** their middle's quick: plant before the setter's touch, take off with it */
  let quickAt = -1;
  let theirTakeoff = -1;
  them.onTakeoff = () => (theirTakeoff = g.simTime);

  const tick = () => {
    g.simTime += DT;
    stepBall(state, DT, env, []);
    if (quickAt > 0 && theirTakeoff < 0 && them.state === 'ground' && g.simTime >= quickAt - PLAYER.loadMax + 0.02) them.jumpPress();
    if (quickAt > 0 && them.state === 'load' && g.simTime >= quickAt) them.jumpRelease();
    mb.step(DT, game);
    me.step(DT, g.simTime);
    them.step(DT, g.simTime);
    // team-mates at the net meet shoulder to shoulder (as TeamAI does every tick)
    if (opts.wing) shoulderToShoulder([me, wing]);
    const j = jumps[jumps.length - 1];
    if (j && j.peakT < 0 && me.state === 'air' && me.vel.y <= 0) j.peakT = g.simTime;
  };

  /** their first ball: from the back court to their setter (in system) or 2.6 m off the net (out) */
  const pass = (inSystem: boolean) => {
    const from = { x: -2.4, y: 0.85, z: -6.0 };
    const to = inSystem
      ? { x: SETTER_TARGET.x * THEM, y: 2.5, z: SETTER_TARGET.z * THEM }
      : { x: (SETTER_SPOT.x + 0.4) * THEM, y: 2.5, z: (SETTER_SPOT.z + 2.6) * THEM };
    const v = { x: 0, y: 0, z: 0 };
    solveApex(from, to, 4.1, NO_SPIN, v);
    ball.touch(from, v);
    ball.lastTouch = { athlete: passer, kind: 'pass', t: g.simTime, side: THEM };
    const hands = setter.height + 0.17 + 0.45;
    const tS = ball.ensurePrediction(env, g.simTime).descendThrough(hands, g.simTime);
    if (opts.quick) quickAt = tS;
    // to the setter's hands
    while (!(state.v.y < 0 && state.p.y < hands)) tick();
  };

  /** their set, and when their hitter meets it */
  const set = (to: Set, outOfSystem = false) => {
    const from = { x: state.p.x, y: state.p.y, z: state.p.z };
    const v = { x: 0, y: 0, z: 0 };
    let tc: number;
    let attackX: number;
    if (to === 'quick') {
      // met at the top of their middle's jump, a moment after the set
      const flight = 0.3;
      solveFixedTime(from, { x: them.pos.x, y: attackHeight(them), z: them.pos.z }, flight, NO_SPIN, v);
      tc = g.simTime + flight;
      attackX = them.pos.x;
    } else {
      const lane = laneFor(to === 'outside' ? 'OH' : 'OPP', THEM);
      const hitter = new Athlete(to === 'outside' ? 'OH' : 'OPP', THEM);
      const y = attackHeight(hitter);
      solveApex(from, { x: lane.x, y, z: lane.z }, y + lane.apexAbove + (outOfSystem ? AI.outOfSystemApex : 0), NO_SPIN, v);
      ball.touch(from, v);
      tc = ball.ensurePrediction(env, g.simTime).descendThrough(y, g.simTime);
      attackX = lane.x;
      wing.place(lane.x + Math.sign(lane.x) * AI.defence.shade, 0.45, 0);
    }
    ball.touch(from, v);
    ball.lastTouch = { athlete: setter, kind: 'set', t: g.simTime, side: THEM };
    const tSet = g.simTime;
    // where the middle closes the block on a pin set: next to the pin blocker, hands to hands
    const closeX = attackX + Math.sign(attackX) * (AI.defence.shade - AI.middle.closeGap);
    let atContact = { x: 0, y: 0, air: false, reach: 0 };
    let closest = Infinity;
    let landedX = NaN;
    while (g.simTime < tc + 0.6) {
      tick();
      if (g.simTime >= tc && g.simTime < tc + DT) atContact = { x: me.pos.x, y: me.pos.y, air: me.state === 'air', reach: me.reachX };
      if (opts.wing && me.state === 'air') closest = Math.min(closest, Math.abs(me.pos.x - wing.pos.x));
      if (me.state === 'land' && Number.isNaN(landedX)) landedX = me.pos.x;
    }
    return { tSet, tc, attackX, closeX, atContact, closest, landedX };
  };

  return { g, me, them, wing, mb, jumps, pass, set, tick, theirTakeoff: () => theirTakeoff };
}

describe("a player's read of a touch", () => {
  it('starts only after the reaction time, and only once per touch', () => {
    const r = new BallRead({ react: 0.2, reactSd: 0, err: 0.5 });
    const rng = new Rng(3);
    const touch = {};
    expect(r.look(touch, 1, rng)).toBe(true);
    expect(r.look(touch, 1.1, rng)).toBe(false);
    expect(r.seen(1.19)).toBe(false);
    expect(r.seen(1.2)).toBe(true);
  });

  it('is off at the touch and sharpens as the ball gets to the hitter, clear once the arc turns over', () => {
    const rng = new Rng(11);
    let sum = 0;
    for (let i = 0; i < 200; i++) {
      const r = new BallRead({ react: 0.2, reactSd: 0, err: 0.5 });
      r.look({}, 0, rng);
      // a high ball, met 1.2 s after the set: still rough a quarter of the way, nearly exact at the end
      const atTouch = Math.abs(r.x(4, 0, 1.2) - 4);
      sum += atTouch;
      expect(Math.abs(r.x(4, 0.3, 1.2) - 4)).toBeGreaterThan(atTouch * 0.5 - 1e-12);
      expect(Math.abs(r.x(4, 0.9, 1.2) - 4)).toBeLessThan(atTouch * 0.1 + 1e-12);
      expect(r.x(4, 1.2, 1.2)).toBe(4);
      // a quick, met 0.3 s after the set: by the time anyone reacts it is nearly there
      expect(Math.abs(r.x(-0.2, 0.25, 0.3) + 0.2)).toBeLessThan(atTouch * 0.2 + 1e-12);
    }
    // about 0.8 sd off on average (the mean of a normal's absolute value)
    expect(sum / 200).toBeGreaterThan(0.3);
    expect(sum / 200).toBeLessThan(0.5);
  });
});

describe('the middle blocker (Mini Rally)', () => {
  it('before the set it shades towards their middle but stays near the middle of the net (a spread block)', () => {
    const near = net({ guess: 'read', theirMiddleX: -0.2 });
    near.pass(true);
    expect(Math.abs(near.me.pos.x + 0.2)).toBeLessThan(0.15);
    const far = net({ guess: 'read', theirMiddleX: -1.2 });
    far.pass(true);
    expect(far.me.pos.x).toBeLessThan(-AI.middle.lineUpMax + 0.15);
    expect(far.me.pos.x).toBeGreaterThan(-AI.middle.lineUpMax - 0.15);
  });

  it('off a bad pass it closes the block next to the pin blocker on a high ball to either pin, in time', () => {
    for (const to of ['outside', 'opposite'] as const) {
      for (let seed = 1; seed <= 6; seed++) {
        const { me, jumps, pass, set } = net({ seed });
        pass(false);
        const s = set(to, true);
        expect(jumps, `${to} seed ${seed}`).toHaveLength(1);
        // in time: up in the air with the hands high as the hitter meets it ...
        expect(s.atContact.air, `${to} seed ${seed}`).toBe(true);
        // ... within half a metre of the spot next to the pin blocker: a double block
        expect(Math.abs(s.atContact.x - s.closeX), `${to} seed ${seed}`).toBeLessThan(0.5);
        expect(s.atContact.y, `${to} seed ${seed}`).toBeGreaterThan(me.jumpH * 0.6);
      }
    }
  });

  it('off a bad pass the block has no seam: the middle closes hands to hands with the pin blocker', () => {
    for (const to of ['outside', 'opposite'] as const) {
      for (let seed = 1; seed <= 6; seed++) {
        const { me, wing, pass, set } = net({ seed, wing: true });
        pass(false);
        const s = set(to, true);
        expect(s.atContact.air, `${to} seed ${seed}`).toBe(true);
        // a blocker's hands stop a ball centre within handHalf of them: the two cover one wall, or
        // leave a slit a few centimetres wide (a ball centre has to thread it exactly)
        expect(Math.abs(s.atContact.x - wing.pos.x), `${to} seed ${seed}`).toBeLessThanOrEqual(2 * AI.defence.handHalf + 0.05);
        expect(me.jumpH).toBeGreaterThan(0);
      }
    }
  });

  it('on an in-system high ball the seam is rare and thin: closed or under 10 cm', () => {
    let closed = 0;
    for (const to of ['outside', 'opposite'] as const) {
      for (let seed = 1; seed <= 6; seed++) {
        const { wing, pass, set } = net({ seed, wing: true, guess: 'read' });
        pass(true);
        const s = set(to);
        const seam = Math.abs(s.atContact.x - wing.pos.x) - 2 * AI.defence.handHalf;
        expect(seam, `${to} seed ${seed}`).toBeLessThan(0.1);
        if (seam <= 0) closed++;
      }
    }
    expect(closed).toBeGreaterThanOrEqual(6);
  });

  it("a late middle drifts into the seam on its jump and stops at the pin blocker's shoulder", () => {
    // cheated the wrong way: it goes up late, still moving towards the pin blocker
    const { me, wing, jumps, pass, set } = net({ guess: 'outside', wing: true });
    pass(true);
    const s = set('opposite');
    expect(jumps).toHaveLength(1);
    const takeoffGap = Math.abs(jumps[0].x - wing.pos.x);
    // it drifted towards the pin blocker in the air ...
    expect(Math.abs(s.landedX - wing.pos.x)).toBeLessThan(takeoffGap - 0.1);
    // ... and never through them: it stops at the shoulder
    expect(s.closest).toBeGreaterThanOrEqual(PLAYER.shoulder - 1e-6);
    expect(me.jumpH).toBeGreaterThan(0);
  });

  it('late on a quick it did not read, the middle stretches its hands sideways towards the ball', () => {
    const { me, pass, set } = net({ guess: 'outside', quick: true });
    pass(true);
    const s = set('quick');
    // its body is off to the side of their middle; the hands reach that way, up to an arm's length
    const side = Math.sign(s.attackX - s.atContact.x);
    expect(s.atContact.reach * side).toBeGreaterThan(0.15);
    expect(Math.abs(s.atContact.reach)).toBeLessThanOrEqual(AI.middle.reach + 1e-9);
    expect(Math.abs(s.atContact.x + s.atContact.reach - s.attackX)).toBeLessThan(Math.abs(s.atContact.x - s.attackX));
    void me;
  });

  it('a block reaching sideways has its hands there, and lower', () => {
    const a = new Athlete('MB', 1);
    a.place(1, 0.45, 0);
    const straight = blockHands(a);
    a.reachX = -0.4;
    const reached = blockHands(a);
    expect(reached.x).toBeCloseTo(0.6, 9);
    expect(reached.top).toBeCloseTo(straight.top - 0.4 * CONTACT.blockReachDrop, 9);
  });

  it('team-mates meet shoulder to shoulder at the net, but only at the net', () => {
    const mb = new Athlete('MB', 1);
    const opp = new Athlete('OPP', 1);
    mb.place(3.7, 0.45, 0);
    opp.place(4.0, 0.45, 0);
    mb.state = 'air';
    mb.vel.x = 2;
    shoulderToShoulder([mb, opp]);
    expect(opp.pos.x - mb.pos.x).toBeCloseTo(PLAYER.shoulder, 9);
    expect(opp.pos.x).toBe(4.0);
    expect(mb.vel.x).toBeLessThanOrEqual(0);
    // away from the net: no contact (giving way handles walkers)
    const l = new Athlete('L', 1);
    const s = new Athlete('S', 1);
    l.place(0, 6, 0);
    s.place(0.2, 6, 0);
    l.state = 'air';
    shoulderToShoulder([l, s]);
    expect(s.pos.x - l.pos.x).toBeCloseTo(0.2, 9);
  });

  it('committed on the quick, it jumps with their middle, then chases the set to the pin', () => {
    const { jumps, pass, set, theirTakeoff } = net({ guess: 'quick', quick: true });
    pass(true);
    const s = set('outside');
    const up = theirTakeoff();
    expect(up).toBeGreaterThan(0);
    // went up with their middle (a commit block), before the set's direction was even known
    expect(jumps.length).toBeGreaterThanOrEqual(1);
    expect(jumps[0].t).toBeGreaterThan(up - 0.15);
    expect(jumps[0].t).toBeLessThan(up + 0.3);
    // then ran for the pin instead of standing where it landed
    expect((s.atContact.x - jumps[0].x) * Math.sign(s.attackX)).toBeGreaterThan(1);
  });

  it('caught cheating towards the outside, it runs back to the opposite and blocks with a gap', () => {
    const { me, jumps, pass, set } = net({ guess: 'outside' });
    const lineUp = quickSpot(SETTER_TARGET.x * THEM, THEM).x;
    const outsideSide = Math.sign(laneFor('OH', THEM).x);
    pass(true);
    // leaned towards the outside before the set
    expect((me.pos.x - lineUp) * outsideSide).toBeGreaterThan(AI.middle.cheatShift * 0.75);
    const s = set('opposite');
    expect(jumps).toHaveLength(1);
    const gap = Math.abs(jumps[0].x - s.closeX);
    // it got most of the way back, but not all of it: a gap between it and the pin blocker
    expect(gap).toBeGreaterThan(0.25);
    expect(gap).toBeLessThanOrEqual(AI.middle.lateReach + 1e-6);
    expect((jumps[0].x - s.closeX) * Math.sign(s.attackX)).toBeLessThan(0);
  });

  it('reading a pin when the quick comes, it still jumps, late (a last-ditch block)', () => {
    const { jumps, pass, set } = net({ guess: 'outside', quick: true });
    pass(true);
    const s = set('quick');
    expect(jumps.length).toBeGreaterThanOrEqual(1);
    // it reacted to the set: up after it, near their middle, hands at the top after the hitter's contact
    expect(jumps[0].t).toBeGreaterThan(s.tSet);
    expect(Math.abs(jumps[0].x - s.attackX)).toBeLessThan(AI.middle.lateReach);
    expect(jumps[0].peakT).toBeGreaterThan(s.tc);
  });
});
