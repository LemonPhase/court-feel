import { describe, expect, it } from 'vitest';
import { AI, BALL, COURT, PLAYER, SIM } from '../src/config';
import { wrapAngle } from '../src/core/mathx';
import { Athlete } from '../src/game/athlete';
import { LANES, SETTER_TARGET } from '../src/game/plays';
import { Simulation } from '../src/game/simulation';
import type { V3 } from '../src/physics/ball';
import { solveApex, solveFixedTime } from '../src/physics/solve';
import { BlockerBrain, wingSpot } from '../src/ai/blocker';
import { NO_HOOKS } from './simHooks';

const DT = 1 / SIM.hz;
/** the other team: we (the home side, +z) block their attack */
const THEM = -1 as const;
const NO_SPIN: V3 = { x: 0, y: 0, z: 0 };
/** where their hitter meets a set: on its way down through this height */
const MEET = 3.25;

/**
 * Our Mini Rally pin blockers (`BlockerBrain.wing`, as TeamAI makes them) against their set, in a
 * real simulation built with no browser: they read its ball, its clock and its random stream. Each
 * wing starts at its base spot at the net (x = ±3); with `midX`, our middle stands at the net there
 * (it does not move along it, and jumps when a set's `midPresses` say). `pin(x)` is one of their pin
 * hitters, waiting at their pin; a set `by` them is theirs (the wings see who it is for).
 */
function net(seed = 1, midX: number | null = null) {
  const sim = new Simulation(NO_HOOKS);
  sim.rng.reseed(seed);
  const mid = new Athlete('MB', 1);
  mid.place(midX ?? 0, midX === null ? 3 : 0.45, 0);
  const reads = new Map<Athlete, number>();
  let by: Athlete | null = null;
  const wing = (x: number) => {
    const a = new Athlete(x > 0 ? 'OPP' : 'OH', 1);
    a.place(x, 0.45, 0);
    const brain = Object.assign(new BlockerBrain(a, x), { wing: true, mate: () => mid, setTo: () => by, reads });
    const presses: number[] = [];
    /**
     * how far it turned from facing the net while moving along it, its speed along the net as it
     * planted, and the moments in the air its hands went further away from the ball
     */
    const run = { turn: 0, pressVx: 0, away: 0 };
    return { a, brain, presses, run };
  };
  const wings = [wing(3), wing(-3)];
  const setter = new Athlete('S', THEM);
  const pin = (x: number) => {
    const h = new Athlete(x > 0 ? 'OPP' : 'OH', THEM);
    h.place(x, -3.5, Math.PI);
    return h;
  };

  /**
   * their set from their setter's hands to `to` (x along the net, z off it on their side), met on
   * the way down at MEET; `apexAbove` over it, or in `flight` s. Our middle presses for a jump at
   * each of `midPresses(onTime)`, given when it would press to block on time
   */
  const set = (
    to: { x: number; off: number; by?: Athlete },
    shape: { apexAbove?: number; flight?: number },
    midPresses: (onTime: number, setT: number) => number[] = () => [],
  ) => {
    by = to.by ?? null;
    for (const w of wings) {
      w.presses.length = 0;
      w.run.turn = 0;
      w.run.away = 0;
    }
    const from = { x: SETTER_TARGET.x * THEM, y: 2.5, z: SETTER_TARGET.z * THEM };
    const target = { x: to.x, y: MEET, z: to.off * THEM };
    const v = { x: 0, y: 0, z: 0 };
    if (shape.flight) solveFixedTime(from, target, shape.flight, NO_SPIN, v);
    else solveApex(from, target, MEET + (shape.apexAbove ?? 1.45), NO_SPIN, v);
    sim.ball.launch(from, v, NO_SPIN, 0, sim.simTime);
    sim.ball.lastTouch = { athlete: setter, kind: 'set', t: sim.simTime, side: THEM };
    const pred = sim.ball.ensurePrediction(sim.env, sim.simTime);
    let tc = pred.descendThrough(MEET, sim.simTime);
    if (tc < 0) tc = pred.apex().t;
    const at = new Map<Athlete, { state: string; x: number; reach: number; hands: number }>();
    const was = new Map<Athlete, string>();
    const startX = new Map(wings.map((w) => [w.a, w.a.pos.x]));
    // (as BlockerBrain times a block: the hands at the top 0.12 s after the hit)
    const vy = Math.sqrt(2 * BALL.gravity * mid.jumpMax * mid.stats.standingJumpFrac * 1.1);
    const onTime = tc + 0.12 - (vy / BALL.gravity + 0.05) - PLAYER.loadMin;
    const presses = midPresses(onTime, sim.simTime);
    while (sim.simTime < tc + 0.3) {
      sim.simTime += DT;
      sim.ball.step(DT, sim.env);
      if (presses.length && sim.simTime >= presses[0] && mid.canJump()) {
        presses.shift();
        mid.jumpPress();
        mid.jumpRelease();
      }
      mid.step(DT, sim.simTime);
      for (const w of wings) {
        const reach = w.a.reachX;
        w.brain.step(DT, sim);
        w.a.step(DT, sim.simTime);
        const toBall = to.x - w.a.pos.x;
        // (clearly past the ball's line: its read of it is good to a few cm)
        if (
          w.a.state === 'air' &&
          sim.simTime <= tc &&
          Math.abs(toBall) > 0.05 &&
          w.a.reachX * toBall < 0 &&
          (w.a.reachX - reach) * toBall < 0
        )
          w.run.away++;
        if (w.a.state === 'load' && was.get(w.a) !== 'load') {
          w.presses.push(sim.simTime);
          w.run.pressVx = w.a.vel.x;
        }
        if (w.a.state === 'ground' && Math.abs(w.a.vel.x) > 0.3) w.run.turn = Math.max(w.run.turn, Math.abs(wrapAngle(w.a.yaw)));
        was.set(w.a, w.a.state);
        if (sim.simTime >= tc && sim.simTime < tc + DT)
          at.set(w.a, { state: w.a.state, x: w.a.pos.x, reach: w.a.reachX, hands: w.a.pos.x + w.a.reachX });
      }
    }
    return { tc, at, startX, onTime };
  };
  /** the rally goes on (the ball passed on their side): our blockers come down and go back to their spots */
  const rest = () => {
    sim.ball.lastTouch = { athlete: setter, kind: 'pass', t: sim.simTime, side: THEM };
    for (let t = 0; t < 3; t += DT) {
      sim.simTime += DT;
      mid.step(DT, sim.simTime);
      for (const w of wings) {
        w.brain.step(DT, sim);
        w.a.step(DT, sim.simTime);
      }
    }
  };
  return { sim, wings, set, rest, pin, reads, right: wings[0], left: wings[1] };
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

describe('our pin blockers on their pin hitter going inside, and closing in (Mini Rally, AI.wing)', () => {
  /** their outside's 2: in from our right pin, met 0.75 m from the middle of the net, 1.75 m past their setter */
  const TWO = { x: 0.75, off: 0.8 };
  const TWO_SHAPE = { apexAbove: 0.8 };

  it('its own hitter going inside where it did not expect it: the pin follows them in and goes up, moving in, its hands reaching for the ball', () => {
    for (let seed = 1; seed <= 6; seed++) {
      const s = net(seed);
      const r = s.set({ ...TWO, by: s.pin(4.3) }, TWO_SHAPE);
      const at = r.at.get(s.right.a)!;
      // never left standing at its base: in after them (late: it reacts late), and up before the hit
      expect(r.startX.get(s.right.a)! - at.x).toBeGreaterThan(0.3);
      expect(s.right.presses.length).toBe(1);
      expect(s.right.presses[0]).toBeLessThan(r.tc);
      expect(s.right.run.pressVx).toBeLessThan(-1);
      expect(at.reach).toBeLessThanOrEqual(0);
      // the other pin has its own hitter to watch
      expect(s.left.presses.length).toBe(0);
    }
  });

  it('a pin blocker learns their hitter: the first inside ball after a run of pin sets beats it; after a few more it is there with them', () => {
    let first = 0;
    let learned = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const s = net(seed);
      const h = s.pin(4.3);
      for (let i = 0; i < 3; i++) {
        s.set({ x: 4.0, off: 0.9, by: h }, { apexAbove: 1.65 });
        s.rest();
      }
      expect(s.reads.get(h)).toBe(0);
      first += Math.abs(s.set({ ...TWO, by: h }, TWO_SHAPE).at.get(s.right.a)!.hands - TWO.x) / 6;
      s.rest();
      expect(s.reads.get(h)).toBeCloseTo(AI.wing.learn, 9);
      for (let i = 0; i < 3; i++) {
        s.set({ ...TWO, by: h }, TWO_SHAPE);
        s.rest();
      }
      expect(s.reads.get(h)!).toBeGreaterThan(0.8);
      learned += Math.abs(s.set({ ...TWO, by: h }, TWO_SHAPE).at.get(s.right.a)!.hands - TWO.x) / 6;
      // back at the pin, the read goes back the other way
      s.rest();
      const before = s.reads.get(h)!;
      s.set({ x: 4.0, off: 0.9, by: h }, { apexAbove: 1.65 });
      expect(s.reads.get(h)!).toBeCloseTo(before * (1 - AI.wing.learn), 9);
    }
    // its hands at the hit: well short of the ball the first time, on it (within a hand) once it knows
    expect(first).toBeGreaterThan(AI.defence.handHalf);
    expect(learned).toBeLessThan(first - 0.25);
  });

  it('their opposite crossing in front of the setter (an X): the pin blocker in front of them follows them across', () => {
    for (let seed = 1; seed <= 6; seed++) {
      const s = net(seed);
      // from our left pin to 0.6 m right of the middle of the net, past their setter
      const x = 0.6;
      const r = s.set({ x, off: 0.8, by: s.pin(-4.3) }, TWO_SHAPE);
      const at = r.at.get(s.left.a)!;
      expect(at.x - r.startX.get(s.left.a)!).toBeGreaterThan(0.8);
      expect(s.left.run.turn).toBeLessThanOrEqual(AI.wing.hips + 0.05);
      expect(at.reach).toBeGreaterThanOrEqual(0);
    }
  });

  it('in the air a pin blocker never reaches away from the ball (drifted past it, its hands come back to it)', () => {
    const sets = [
      { to: { x: 4.0, off: 0.9 }, shape: { apexAbove: 1.65 } },
      { to: { x: 2.1, off: 0.8 }, shape: { apexAbove: 0.75 } },
      { to: { x: 1.3, off: 0.8 }, shape: { flight: 0.75 } },
      { to: { x: 0.75, off: 0.8 }, shape: TWO_SHAPE },
      { to: { x: LANES.L.x, off: LANES.L.z }, shape: { apexAbove: LANES.L.apexAbove } },
    ];
    let up = 0;
    for (let seed = 1; seed <= 8; seed++)
      for (const own of [false, true])
        for (const { to, shape } of sets) {
          const s = net(seed, seed % 2 ? LANES.L.x : null);
          const r = s.set({ ...to, by: own ? s.pin(4.3) : undefined }, shape, (onTime) => [onTime]);
          for (const w of s.wings) {
            const at = r.at.get(w.a)!;
            if (at.state !== 'air') continue;
            up++;
            expect(w.run.away).toBe(0);
            expect(at.reach * (to.x - at.x)).toBeGreaterThan(-0.05);
          }
        }
    expect(up).toBeGreaterThan(80);
  });

  it('on a pipe the pin blockers face the net all the way in (never a turn and a run) and jump still moving in, their hands into the middle', () => {
    for (let seed = 1; seed <= 6; seed++) {
      const s = net(seed, LANES.L.x);
      const r = s.set({ x: LANES.L.x, off: LANES.L.z }, { apexAbove: LANES.L.apexAbove }, (onTime) => [onTime]);
      for (const w of s.wings) {
        const inward = -Math.sign(r.startX.get(w.a)!);
        expect(w.run.turn).toBeLessThanOrEqual(AI.wing.hips + 0.05);
        expect(w.run.pressVx * inward).toBeGreaterThan(1);
        expect(r.at.get(w.a)!.reach * inward).toBeGreaterThan(0);
      }
    }
  });
});
