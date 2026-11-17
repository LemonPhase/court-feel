import { describe, expect, it } from 'vitest';
import { AI, BALL, COURT, PLAYER, SIM } from '../src/config';
import { Rng } from '../src/core/mathx';
import { Athlete } from '../src/game/athlete';
import type { Touch } from '../src/game/ballEntity';
import type { Game } from '../src/game/game';
import { LANES, SETTER_TARGET } from '../src/game/plays';
import { makeBall, stepBall, type BallEnv, type V3 } from '../src/physics/ball';
import { BallPredictor } from '../src/physics/predict';
import { solveApex, solveFixedTime } from '../src/physics/solve';
import { BlockerBrain, wingSpot } from '../src/ai/blocker';

const DT = 1 / SIM.hz;
/** the other team: we (the home side, +z) block their attack */
const THEM = -1 as const;
const NO_SPIN: V3 = { x: 0, y: 0, z: 0 };
/** where their hitter meets a set: on its way down through this height */
const MEET = 3.25;

/**
 * Our Mini Rally pin blockers (`BlockerBrain.wing`, as TeamAI makes them) against their set, on a
 * stand-in for the Game: the ball (state and prediction), the clock, the rng and a block that never
 * touches. Each wing starts at its base spot at the net (x = ±3); with `midX`, our middle stands at
 * the net there (it does not move along it, and jumps when a set's `midPresses` say).
 */
function net(seed = 1, midX: number | null = null) {
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
    ensurePrediction(e: BallEnv, t: number) {
      if (predicted !== version) {
        predictor.compute(state, e, t);
        predicted = version;
      }
      return predictor;
    },
  };
  const g = { simTime: 0, env, rng: new Rng(seed), ball, contact: { tryBlock: () => false } };
  const game = g as unknown as Game;
  const mid = new Athlete('MB', 1);
  mid.place(midX ?? 0, midX === null ? 3 : 0.45, 0);
  const wing = (x: number) => {
    const a = new Athlete(x > 0 ? 'OPP' : 'OH', 1);
    a.place(x, 0.45, 0);
    const brain = Object.assign(new BlockerBrain(a, x), { wing: true, mate: () => mid });
    const presses: number[] = [];
    return { a, brain, presses };
  };
  const wings = [wing(3), wing(-3)];
  const setter = new Athlete('S', THEM);

  /**
   * their set from their setter's hands to `to` (x along the net, z off it on their side), met on
   * the way down at MEET; `apexAbove` over it, or in `flight` s. Our middle presses for a jump at
   * each of `midPresses(onTime)`, given when it would press to block on time
   */
  const set = (
    to: { x: number; off: number },
    shape: { apexAbove?: number; flight?: number },
    midPresses: (onTime: number, setT: number) => number[] = () => [],
  ) => {
    const from = { x: SETTER_TARGET.x * THEM, y: 2.5, z: SETTER_TARGET.z * THEM };
    const target = { x: to.x, y: MEET, z: to.off * THEM };
    const v = { x: 0, y: 0, z: 0 };
    if (shape.flight) solveFixedTime(from, target, shape.flight, NO_SPIN, v);
    else solveApex(from, target, MEET + (shape.apexAbove ?? 1.45), NO_SPIN, v);
    Object.assign(state.p, from);
    Object.assign(state.v, v);
    state.rest = false;
    version++;
    ball.lastTouch = { athlete: setter, kind: 'set', t: g.simTime, side: THEM };
    const pred = ball.ensurePrediction(env, g.simTime);
    let tc = pred.descendThrough(MEET, g.simTime);
    if (tc < 0) tc = pred.apex().t;
    const at = new Map<Athlete, { state: string; x: number; reach: number; hands: number }>();
    const was = new Map<Athlete, string>();
    const startX = new Map(wings.map((w) => [w.a, w.a.pos.x]));
    // (as BlockerBrain times a block: the hands at the top 0.12 s after the hit)
    const vy = Math.sqrt(2 * BALL.gravity * mid.jumpMax * mid.stats.standingJumpFrac * 1.1);
    const onTime = tc + 0.12 - (vy / BALL.gravity + 0.05) - PLAYER.loadMin;
    const presses = midPresses(onTime, g.simTime);
    while (g.simTime < tc + 0.3) {
      g.simTime += DT;
      stepBall(state, DT, env, []);
      if (presses.length && g.simTime >= presses[0] && mid.canJump()) {
        presses.shift();
        mid.jumpPress();
        mid.jumpRelease();
      }
      mid.step(DT, g.simTime);
      for (const w of wings) {
        w.brain.step(DT, game);
        w.a.step(DT, g.simTime);
        if (w.a.state === 'load' && was.get(w.a) !== 'load') w.presses.push(g.simTime);
        was.set(w.a, w.a.state);
        if (g.simTime >= tc && g.simTime < tc + DT)
          at.set(w.a, { state: w.a.state, x: w.a.pos.x, reach: w.a.reachX, hands: w.a.pos.x + w.a.reachX });
      }
    }
    return { tc, at, startX, onTime };
  };
  return { g, wings, set, right: wings[0], left: wings[1] };
}

describe('where a pin blocker goes up (Mini Rally, AI.wing)', () => {
  it('on its hitter wherever it hits from, inside or out, taking the line, out to the antenna at most', () => {
    expect(wingSpot(4.0, 0.9, 1)).toBeCloseTo(4.0 + AI.defence.shade, 9);
    expect(wingSpot(-4.0, 0.9, -1)).toBeCloseTo(-4.0 - AI.defence.shade, 9);
    // a hitter 1.2 m inside the pin's base spot: the pin goes in with it
    expect(wingSpot(1.8, 0.9, 1)).toBeCloseTo(1.8 + AI.defence.shade, 9);
    // a set wide of the antenna: the ball has to come back inside it
    expect(wingSpot(5.2, 0.9, 1)).toBeCloseTo(AI.wing.outMax, 9);
    expect(AI.wing.outMax).toBeLessThan(COURT.halfWidth);
  });

  it('an inside ball on its half: beside the middle, a double block', () => {
    expect(wingSpot(1.0, 0.8, 1)).toBeCloseTo(1.0 + AI.middle.closeGap, 9);
  });

  it('the pipe: both wings close beside the middle, whichever half it is hit on', () => {
    const x = LANES.L.x;
    expect(wingSpot(x, LANES.L.z, 1)).toBeCloseTo(x + AI.middle.closeGap, 9);
    expect(wingSpot(x, LANES.L.z, -1)).toBeCloseTo(x - AI.middle.closeGap, 9);
  });

  it('beside the middle it closes on our middle where it is at the net, hands to hands, not on the ball', () => {
    expect(wingSpot(LANES.L.x, LANES.L.z, 1, 0.3)).toBeCloseTo(0.3 + AI.middle.closeGap, 9);
    expect(wingSpot(1.0, 0.8, 1, 0.7)).toBeCloseTo(0.7 + AI.middle.closeGap, 9);
    // its own hitter's pin set: on the hitter, wherever the middle is
    expect(wingSpot(4.0, 0.9, 1, 0.3)).toBeCloseTo(4.0 + AI.defence.shade, 9);
  });

  it('an attack on the other half of the net is not its block (the other wing, or the middle alone)', () => {
    expect(wingSpot(-4.0, 0.9, 1)).toBeNull();
    expect(wingSpot(-1.0, 0.8, 1)).toBeNull();
  });
});

describe('our pin blockers against their set (Mini Rally)', () => {
  it('on a pipe all three at the net go up: both wings close beside the middle and are in the air as it is hit', () => {
    for (let seed = 1; seed <= 6; seed++) {
      const s = net(seed);
      const r = s.set({ x: LANES.L.x, off: LANES.L.z }, { apexAbove: LANES.L.apexAbove });
      for (const w of s.wings) {
        const spot = wingSpot(LANES.L.x, LANES.L.z, Math.sign(r.startX.get(w.a)!))!;
        const at = r.at.get(w.a)!;
        expect(w.presses.length).toBe(1);
        expect(w.presses[0]).toBeLessThan(r.tc);
        expect(at.state).toBe('air');
        // in front of the pipe with the middle, the far wing a little late: its hands within an arm of the spot
        expect(Math.abs(at.hands - spot)).toBeLessThan(AI.wing.lateReach - AI.middle.reach + 0.3);
      }
    }
  });

  it('on a pipe the near wing closes on our middle, hands to hands, whatever its read of the set; the far one gets there late or near', () => {
    const midX = LANES.L.x;
    for (let seed = 1; seed <= 6; seed++) {
      const s = net(seed, midX);
      const r = s.set({ x: LANES.L.x, off: LANES.L.z }, { apexAbove: LANES.L.apexAbove }, (onTime) => [onTime]);
      // the pipe is a little to our right of the middle of the net: the left wing is nearer
      const near = r.at.get(s.left.a)!;
      const far = r.at.get(s.right.a)!;
      expect(near.state).toBe('air');
      expect(Math.abs(near.hands - (midX - AI.middle.closeGap))).toBeLessThan(AI.defence.handHalf);
      expect(far.state).toBe('air');
      expect(Math.abs(far.hands - (midX + AI.middle.closeGap))).toBeLessThan(AI.wing.lateReach - AI.middle.reach);
    }
  });

  it('a block goes up together: beside the middle the wings jump with it', () => {
    const midX = LANES.L.x;
    for (let seed = 1; seed <= 6; seed++) {
      const s = net(seed, midX);
      let midT = 0;
      s.set({ x: LANES.L.x, off: LANES.L.z }, { apexAbove: LANES.L.apexAbove }, (onTime) => [(midT = onTime)]);
      // the near wing is there in time: it goes with the middle (the far one with it, or as soon as it gets there)
      expect(Math.abs(s.left.presses[0] - midT)).toBeLessThan(2 * DT);
      expect(s.right.presses[0]).toBeGreaterThanOrEqual(midT - DT);
    }
  });

  it('a middle late on the pipe (up with another hitter first) takes the whole block up late: the wings wait for it, still rising at the hit', () => {
    const midX = LANES.L.x;
    for (let seed = 1; seed <= 6; seed++) {
      const s = net(seed, midX);
      let again = 0;
      const r = s.set({ x: LANES.L.x, off: LANES.L.z }, { apexAbove: LANES.L.apexAbove }, (onTime, setT) => [
        setT + 0.05,
        (again = onTime + 0.25),
      ]);
      for (const w of s.wings) {
        expect(w.presses.length).toBe(1);
        expect(w.presses[0]).toBeGreaterThanOrEqual(again - DT);
        expect(w.presses[0]).toBeLessThan(r.tc);
        // a beat behind: not at the top of the jump when the pipe is hit
        expect(r.at.get(w.a)!.state === 'load' || w.a.vel.y > 0 || r.at.get(w.a)!.state === 'air').toBe(true);
      }
    }
  });

  it('beside a middle that does not go, a wing waits a moment for it, then goes on its own before the hit', () => {
    const midX = LANES.L.x;
    for (let seed = 1; seed <= 6; seed++) {
      const s = net(seed, midX);
      const r = s.set({ x: LANES.L.x, off: LANES.L.z }, { apexAbove: LANES.L.apexAbove });
      expect(s.left.presses.length).toBe(1);
      expect(s.left.presses[0]).toBeGreaterThan(r.onTime + AI.wing.wait / 2);
      expect(s.left.presses[0]).toBeLessThanOrEqual(r.tc + DT);
    }
  });

  it('a high ball set well inside the pin blocker: it follows the hitter in and is up at the hit, over the spot', () => {
    // 1.8 m in from the right pin's base spot (it never went more than 1.3 m along the net before)
    const x = 1.2;
    const spot = wingSpot(x, 0.9, 1)!;
    let off = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const s = net(seed);
      const r = s.set({ x, off: 0.9 }, { apexAbove: 1.8 });
      const at = r.at.get(s.right.a)!;
      expect(s.right.presses.length).toBe(1);
      expect(at.state).toBe('air');
      expect(r.startX.get(s.right.a)! - at.x).toBeGreaterThan(0.6);
      off += Math.abs(at.hands - spot) / 6;
      // the left pin: not its half, it stays home and down
      expect(s.left.presses.length).toBe(0);
    }
    // over the spot, give or take its read of the set
    expect(off).toBeLessThan(0.45);
  });

  it('late on a fast set inside it, the pin still goes up from where it got to and reaches sideways for it (a side block)', () => {
    const x = 1.3;
    const spot = wingSpot(x, 0.8, 1)!;
    let reached = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const s = net(seed);
      const r = s.set({ x, off: 0.8 }, { flight: 0.75 });
      const at = r.at.get(s.right.a)!;
      // up before the hit, from short of the spot (it ran in, it is not there yet)
      expect(s.right.presses.length).toBe(1);
      expect(s.right.presses[0]).toBeLessThan(r.tc);
      expect(at.state).toBe('air');
      expect(at.x).toBeGreaterThan(spot);
      // the hands go in towards it, an arm's length at most
      expect(at.reach).toBeLessThanOrEqual(0);
      expect(at.reach).toBeGreaterThanOrEqual(-AI.middle.reach - 1e-9);
      if (at.reach < -0.15) reached++;
    }
    expect(reached).toBeGreaterThanOrEqual(4);
  });

  it('a quick in front of the setter is the middle alone: the pin stays with its own hitter, no run and no jump', () => {
    for (let seed = 1; seed <= 6; seed++) {
      const s = net(seed);
      // met at the top of its arc, just over the hitter's hand
      const r = s.set({ x: 0.4, off: 0.7 }, { apexAbove: 0.05 });
      for (const w of s.wings) {
        expect(w.presses.length).toBe(0);
        expect(Math.abs(r.at.get(w.a)!.x - r.startX.get(w.a)!)).toBeLessThan(0.15);
      }
    }
  });
});
