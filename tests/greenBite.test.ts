import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { AI, BALL, CONTACT, COURT, SIM } from '../src/config';
import { bendFor, planToPoint, runDir, simulateApproach } from '../src/game/approach';
import { decoyFor, greenFools, userGreen } from '../src/ai/greenBite';
import { HitterBrain } from '../src/ai/hitter';
import { MiddleBlocker } from '../src/ai/middle';
import { Athlete } from '../src/game/athlete';
import type { Touch } from '../src/game/ballEntity';
import { syncRuns, type CallHitters } from '../src/game/callRuns';
import { blockHands, ContactSystem, type ContactHost, type SetResult } from '../src/game/contact';
import type { Game } from '../src/game/game';
import { attackHeight, laneFor, LANES, QUICK, quickSpot, SETTER_PLAYS, SETTER_TARGET } from '../src/game/plays';
import { SetterCalls } from '../src/game/setterCalls';
import { makeBall, stepBall, type BallEnv, type V3 } from '../src/physics/ball';
import { BallPredictor } from '../src/physics/predict';
import { netClearance, solveApex, solveFixedTime, solveSpeedToFloor } from '../src/physics/solve';

const DT = 1 / SIM.hz;
const env: BallEnv = { netTop: COURT.netHeightMen };

/** a stand-in Game: the ball, the clock, a flat rng, everyone on court, and the user's last set (to `setTo`, met at `target`) */
function stage(set: Touch, green: boolean, athletes: Athlete[], setTo: Athlete | null, target: V3) {
  const state = makeBall();
  const predictor = new BallPredictor(DT, SIM.predictHorizon);
  let version = 0;
  let predicted = -1;
  const ball = {
    state,
    active: true,
    lastTouch: set as Touch | null,
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
    touch(from: V3, v: V3) {
      Object.assign(state.p, from);
      Object.assign(state.v, v);
      state.rest = false;
      version++;
    },
  };
  const g = {
    ball,
    env,
    simTime: 0,
    athletes,
    rng: { next: () => 0.99, gauss: () => 0 },
    contact: {
      lastSetResult: { athlete: set.athlete, t: set.t, green },
      lastSet: { hitter: setTo, target },
      tryBlock: () => false,
    },
  };
  return { g, ball };
}

/** our setter's ball to `lane` (met at 3.2 m) is in the air (their middle at `theirX`) */
function laneSet(green: boolean, others: Athlete[], lane: { x: number; z: number; apexAbove: number }, theirX = 0) {
  const setter = new Athlete('S', 1);
  const hitter = new Athlete('OH', 1);
  hitter.place(lane.x, lane.z + 2.5, 0);
  const theirs = new Athlete('MB', -1);
  theirs.place(theirX, -0.5, Math.PI);
  const set: Touch = { athlete: setter, kind: 'set', t: 0, side: 1 };
  const target = { x: lane.x, y: 3.2, z: lane.z };
  const { g, ball } = stage(set, green, [setter, hitter, theirs, ...others], hitter, target);
  const from = { x: SETTER_TARGET.x, y: 2.5, z: SETTER_TARGET.z };
  const out = { x: 0, y: 0, z: 0 };
  solveApex(from, target, 3.2 + lane.apexAbove, { x: 0, y: 0, z: 0 }, out);
  ball.touch(from, out);
  return { g, ball, theirs, set };
}

/** our setter's high ball to the outside is in the air (their middle at `theirX`) */
function pinSet(green: boolean, others: Athlete[], theirX = 0) {
  return laneSet(green, others, laneFor('OH', 1), theirX);
}

/** the pipe, and the outside's inside 3 */
const PIPE = SETTER_PLAYS.PIPE[0].lane;
const INSIDE_3 = SETTER_PLAYS.OH.find((p) => p.short === '3')!.lane;

/** the quick's flight (s): our middle is up as the setter lets it go */
const QUICK_T = 0.3;

/** our setter's quick, `inFront` m along the net in front of them (the 1; the push at 1.55), is in the air, our middle up for it (their middle at `theirX`) */
function insideSet(green: boolean, inFront: number, theirX: number) {
  const setter = new Athlete('S', 1);
  const from = { x: SETTER_TARGET.x, y: 2.45, z: SETTER_TARGET.z };
  const spot = quickSpot(from.x, 1, inFront);
  const mb = new Athlete('MB', 1);
  mb.place(spot.x, spot.z + 0.3, 0);
  mb.jumpPress();
  const theirs = new Athlete('MB', -1);
  theirs.place(theirX, -0.5, Math.PI);
  const set: Touch = { athlete: setter, kind: 'set', t: 0, side: 1 };
  const target = { x: spot.x, y: 3.0, z: spot.z };
  const { g, ball } = stage(set, green, [setter, mb, theirs], mb, target);
  const out = { x: 0, y: 0, z: 0 };
  solveFixedTime(from, target, QUICK_T, { x: 0, y: 0, z: 0 }, out);
  ball.touch(from, out);
  return { g, ball, theirs, set, mb, spot };
}

/** our middle up for the quick as the set leaves the hands */
function quickHitter(): Athlete {
  const mb = new Athlete('MB', 1);
  mb.place(0.3, 1.0, 0);
  mb.jumpPress();
  return mb;
}

describe('your green set: their middle goes with a hitter you did not set', () => {
  it('a green set is the user setter’s last set, graded green', () => {
    const { g, set } = pinSet(true, []);
    expect(userGreen(g as unknown as Game, set)).toBe(true);
    expect(userGreen(pinSet(false, []).g as unknown as Game, set)).toBe(false);
  });
  it('it bites on the hitter who is up (the quick), never on the one you set', () => {
    const quick = quickHitter();
    const { g, theirs, set } = pinSet(true, [quick]);
    expect(decoyFor(g as unknown as Game, theirs, set)).toBe(quick);
  });
  it('a hitter up for a quick comes before one still running in, even a nearer one', () => {
    const quick = quickHitter();
    quick.place(2.3, 1.0, 0);
    quick.jumpPress();
    const runner = new Athlete('OPP', 1);
    runner.place(0.4, 3.0, 0);
    runner.vel.set(0, 0, -4.5);
    const { g, theirs, set } = pinSet(true, [quick, runner]);
    expect(decoyFor(g as unknown as Game, theirs, set)).toBe(quick);
  });
  it('with nobody else going there is nobody to bite on', () => {
    const waiting = new Athlete('OPP', 1);
    waiting.place(4.7, 3.4, 0);
    const { g, theirs, set } = pinSet(true, [waiting]);
    expect(decoyFor(g as unknown as Game, theirs, set)).toBeNull();
  });

  /**
   * Their Mini Rally middle while our set flies (and `hitters` jump): each jump (from its plant)
   * and where, how far it went either way, where it and its hands are when our hitter meets the
   * ball (the ball falling through 3.2 m, or `until` s), and where its hands are a moment later
   */
  function watch(
    s: { g: ReturnType<typeof stage>['g']; ball: ReturnType<typeof stage>['ball']; theirs: Athlete },
    hitters: Athlete[],
    until = 1.6,
  ) {
    const { g, ball, theirs } = s;
    const brain = new MiddleBlocker(theirs, 0, () => hitters[0] ?? null);
    const x0 = theirs.pos.x;
    const jumps: { t: number; x: number }[] = [];
    let maxX = x0;
    let minX = x0;
    let was = 'ground';
    let hit: { x: number; hands: number; vx: number; vy: number; state: string; t: number } | null = null;
    for (let i = 0; i < SIM.hz * 2.2; i++) {
      g.simTime += DT;
      stepBall(ball.state, DT, env);
      for (const h of hitters) {
        if (h.state === 'load' && h.loadT > 0.2) h.jumpRelease();
        h.step(DT, g.simTime);
      }
      brain.step(DT, g as unknown as Game);
      theirs.step(DT, g.simTime);
      if (theirs.state === 'load' && was !== 'load') jumps.push({ t: g.simTime, x: theirs.pos.x });
      was = theirs.state;
      if (!hit) {
        maxX = Math.max(maxX, theirs.pos.x);
        minX = Math.min(minX, theirs.pos.x);
      }
      if (!hit && (g.simTime >= until - 1e-9 || (ball.state.v.y < 0 && ball.state.p.y < 3.2))) {
        hit = {
          x: theirs.pos.x,
          hands: theirs.pos.x + theirs.reachX,
          vx: theirs.vel.x,
          vy: theirs.vel.y,
          state: theirs.state,
          t: g.simTime,
        };
      }
      // (and a moment after the hit: where its hands went)
      if (hit && g.simTime >= hit.t + 0.25 - 1e-9) break;
    }
    const h = hit!;
    return {
      ...h,
      x0,
      maxX,
      minX,
      jumps,
      jumped: jumps[0]?.t ?? -1,
      jumpX: jumps[0]?.x ?? NaN,
      handsAfter: theirs.pos.x + theirs.reachX,
      tHit: h.t,
    };
  }
  /** their middle while your set to the outside flies, with or without our middle up for the quick */
  function middle(green: boolean, withQuick: boolean, theirX = 0) {
    const quick = withQuick ? quickHitter() : null;
    return watch(pinSet(green, quick ? [quick] : [], theirX), quick ? [quick] : []);
  }

  it('on a normal set to the outside their middle runs to close the block', () => {
    expect(middle(false, true).x).toBeLessThan(-1.5);
  });
  it('on your green set it goes up with your middle’s quick instead, then goes after the set: down again, and still in the middle, when your outside hits', () => {
    const m = middle(true, true);
    // it jumped, early (with the quick, not with the outside), and is nowhere near the block when the outside hits
    expect(m.jumped).toBeGreaterThan(0);
    expect(m.jumped).toBeLessThan(m.tHit - 0.5);
    expect(Math.abs(m.x)).toBeLessThan(1);
    expect(m.state).not.toBe('air');
    // on its way out to the pin, too late
    expect(m.vx).toBeLessThan(-1);
  });
  it('on your green set with no quick running it holds, then goes after the set: the right way, too late to close the block', () => {
    const read = middle(false, false);
    const m = middle(true, false);
    // never a step the other way
    expect(m.maxX).toBeLessThan(m.x0 + 0.05);
    // after the outside, and up late from where it got to: its hands well short of the block it closes on a set it reads
    expect(m.x).toBeLessThan(-1);
    expect(m.jumped).toBeGreaterThan(0);
    expect(m.hands - read.hands).toBeGreaterThan(0.8);
  });
  it('on your green set to the outside with their middle already there, it stays and its hands go inside, off the line', () => {
    const read = middle(false, false, -3.3);
    const m = middle(true, false, -3.3);
    expect(m.jumped).toBeGreaterThan(0);
    // no further than a route's width from where it was
    expect(Math.max(m.maxX - m.x0, m.x0 - m.minX)).toBeLessThan(AI.greenFooled.shift + 0.1);
    expect(m.hands - read.hands).toBeGreaterThan(AI.greenFooled.shift - 0.2);
  });
  it('on your green push their middle, in front of your middle, goes up for the 1: its hands are on the setter’s side when the push is hit', () => {
    const s = insideSet(true, 1.55, -0.3);
    const m = watch(s, [s.mb], QUICK_T);
    const one = quickSpot(SETTER_TARGET.x, 1).x;
    expect(m.jumped).toBeGreaterThan(0);
    // it went up where it was: it never ran off
    expect(Math.max(m.maxX - m.x0, m.x0 - m.minX)).toBeLessThan(0.3);
    // its hands went towards the 1, clear of the push
    expect(m.hands - s.spot.x).toBeGreaterThan(0.45);
    expect(Math.abs(m.hands - one)).toBeLessThan(Math.abs(m.hands - s.spot.x));
  });
  it('on your green push its hands go for the push once it is hit, too late', () => {
    const s = insideSet(true, 1.55, -0.3);
    const m = watch(s, [s.mb], QUICK_T);
    expect(m.handsAfter - m.hands).toBeLessThan(-0.3);
    // one jump: by the time it lands the push is long gone
    expect(m.jumps.length).toBe(1);
  });
  it('on your green pipe it goes up with your middle’s quick, then up again for the pipe: late, hands still coming up as it is hit', () => {
    const quick = quickHitter();
    const s = laneSet(true, [quick], PIPE);
    const m = watch(s, [quick]);
    expect(m.jumps.length).toBe(2);
    // the first with the quick, the second as soon as it is down again, in front of the pipe and before it is hit
    expect(m.jumps[0].t).toBeLessThan(m.tHit - 0.5);
    expect(m.jumps[1].t).toBeLessThan(m.tHit);
    expect(Math.abs(m.jumps[1].x - PIPE.x)).toBeLessThan(AI.greenFooled.near);
    // a beat behind: still on the way up when the pipe is hit
    expect(m.state === 'load' || m.vy > 0).toBe(true);
  });
  it('on your green inside 3 it is still up with the quick when the 3 is hit: it reaches out for it, a long way short', () => {
    const run = (green: boolean) => {
      const quick = quickHitter();
      return watch(laneSet(green, [quick], INSIDE_3), [quick]);
    };
    const read = run(false);
    const m = run(true);
    // the 3 goes behind the quick: no time to come down and go again
    expect(m.jumps.length).toBe(1);
    expect(m.state).toBe('air');
    // its hands out towards it, a metre and more from the block it makes on a 3 it reads
    expect(m.hands - m.x).toBeLessThan(-0.3);
    expect(m.hands - read.hands).toBeGreaterThan(1);
  });
  it('already up on its own commit when you set, it goes after your green pipe once it lands', () => {
    const s = laneSet(true, [], PIPE);
    s.theirs.jumpPress();
    s.theirs.jumpRelease();
    const m = watch(s, []);
    expect(m.jumps.length).toBe(2);
    expect(m.jumps[1].t).toBeLessThan(m.tHit);
    expect(m.state === 'load' || m.vy > 0).toBe(true);
  });
  it('on your green 1 it goes up for the push: its hands are away from the setter when the quick is hit', () => {
    const one = quickSpot(SETTER_TARGET.x, 1).x;
    const s = insideSet(true, QUICK.inFront, one);
    const m = watch(s, [s.mb], QUICK_T);
    expect(m.jumped).toBeGreaterThan(0);
    expect(Math.max(m.maxX - m.x0, m.x0 - m.minX)).toBeLessThan(0.3);
    expect(s.spot.x - m.hands).toBeGreaterThan(0.3);
  });
});

describe('your green set: the hitter bounces it', () => {
  const green = { green: true, grade: 'Perfect', quality: 1 } as unknown as SetResult;
  /** the outside, in the air at the pin, choosing a shot off your green set against `blockers` */
  function shot(blockers: Athlete[]) {
    const oh = new Athlete('OH', 1);
    oh.place(LANES.OH.x, LANES.OH.z + 0.2, 0);
    const brain = new HitterBrain(oh, laneFor('OH', 1));
    brain.blockers = () => blockers;
    const g = { env, simTime: 0, rng: { next: () => 0.5, gauss: () => 0 } };
    const from = { x: LANES.OH.x, y: attackHeight(oh), z: LANES.OH.z };
    const aim = brain.chooseAim(g as unknown as Game, from.x, from, 0, green);
    // fly it at full speed
    const out = { x: 0, y: 0, z: 0 };
    const w = { x: 0, y: 0, z: 0 };
    const land = { x: 0, y: 0, z: 0 };
    solveSpeedToFloor(from, aim.x, aim.z, CONTACT.spikePerfect * oh.stats.power, CONTACT.spikeSpinPerfect, out, w, land);
    return { brain, aim, land, cross: netClearance(from, out, w)!, down: Math.atan2(-out.y, Math.hypot(out.x, out.z)) };
  }
  const pinBlocker = (x: number): Athlete => {
    const b = new Athlete('OPP', -1);
    b.place(x, -0.45, Math.PI);
    b.state = 'air';
    return b;
  };

  it('it is hit steeply down, inside the 3 m line or just behind it, and lands in', () => {
    const s = shot([]);
    expect(s.brain.lastShot).toBe('bounce');
    expect(Math.abs(s.land.z)).toBeLessThan(COURT.attackLine + 1.5);
    expect(s.land.z).toBeLessThan(0);
    expect(Math.abs(s.land.x)).toBeLessThan(COURT.halfWidth);
    // a real downward swing, not a deep drive
    expect(s.down).toBeGreaterThan(0.45);
    expect(s.cross.y).toBeGreaterThan(env.netTop + BALL.radius);
  });
  it('it goes where the block is not: clear of a pin blocker’s hands, whichever shot they took away', () => {
    const w0 = CONTACT.blockHalfWidth + BALL.radius;
    // a blocker outside the hitter (the line taken away) or well inside (the cross): there is a bounce past them
    for (const x of [-4.2, -3.0]) {
      const s = shot([pinBlocker(x)]);
      expect(s.brain.lastShot).toBe('bounce');
      expect(Math.abs(s.cross.x - x)).toBeGreaterThan(w0 + AI.greenBounce.hands - 1e-6);
    }
    // wherever the blocker is, the ball misses the hands at the tape and where they reach either
    // side of it (a sharp cross from the pin runs along the net, past the hands before the tape).
    // A blocker just inside the hitter leaves no bounce at all: the hitter takes another shot
    for (const x of [-4.2, -3.6, -3.0]) {
      const s = shot([pinBlocker(x)]);
      const k = AI.blockReachBand / LANES.OH.z;
      const along = (s.cross.x - LANES.OH.x) * k;
      for (const px of [s.cross.x, s.cross.x - along, s.cross.x + along]) expect(Math.abs(px - x), `blocker at ${x}`).toBeGreaterThan(w0);
    }
    expect(shot([pinBlocker(-3.6)]).brain.lastShot).not.toBe('bounce');
  });
  it('a blocker still standing at the net is no block: only hands that are up count', () => {
    const standing = new Athlete('MB', -1);
    standing.place(-3.4, -0.45, Math.PI);
    const free = shot([]);
    const s = shot([standing]);
    expect(s.aim.x).toBeCloseTo(free.aim.x, 6);
    expect(s.aim.z).toBeCloseTo(free.aim.z, 6);
  });
});

describe('out of system: a high ball to a pin fools nobody', () => {
  it('their middle reads your green high ball to a pin off a pass out of system, and is fooled by the same set in system', () => {
    const { g, set } = pinSet(true, []);
    const lane = laneFor('OH', 1);
    const contact = g.contact as { lastSet: object };
    contact.lastSet = { hitter: null, target: { x: lane.x, y: 3.2, z: lane.z }, outOfSystem: true };
    expect(greenFools(g as unknown as Game, set)).toBe(false);
    contact.lastSet = { hitter: null, target: { x: lane.x, y: 3.2, z: lane.z } };
    expect(greenFools(g as unknown as Game, set)).toBe(true);
    // off the net to the pipe, in the middle of the court, it still has to guess
    contact.lastSet = { hitter: null, target: { x: LANES.L.x, y: 3.2, z: LANES.L.z }, outOfSystem: true };
    expect(greenFools(g as unknown as Game, set)).toBe(true);
  });

  /**
   * their middle, at the top of a block jump with the arms up (or `late`: just off the floor, still
   * going up), meets a hard spike in the middle of its hands
   */
  function block(green: boolean, late = false) {
    const b = new Athlete('MB', -1);
    b.place(0, -0.4, Math.PI);
    b.jumpPress();
    let t = 0;
    const there = () => b.state === 'air' && (late ? b.pos.y > 0.05 : b.vel.y <= 0.4);
    for (let i = 0; i < SIM.hz && !there(); i++) b.step(DT, (t += DT));
    const hands = blockHands(b);
    const state = makeBall();
    Object.assign(state.p, { x: hands.x, y: hands.top - 0.12, z: -0.05 });
    Object.assign(state.v, { x: 0, y: -5, z: -21 });
    state.rest = false;
    const ball = {
      state,
      active: true,
      pos: state.p,
      vel: state.v,
      lastTouch: { athlete: new Athlete('OH', 1), kind: 'spike', t: 0, side: 1, green } as Touch,
      hit(v: V3) {
        Object.assign(state.v, v);
      },
    };
    // (the dice at their kindest to the block)
    const host = { ball, simTime: t, env, aimAssist: () => 0, rand: () => 0, emitContact: () => {} };
    const act = { kind: 'block', t0: t - 1, note: '', contactPoint: new THREE.Vector3() };
    const touched = new ContactSystem(host as unknown as ContactHost).tryBlock(b, act as never);
    return { touched, note: act.note, vz: state.v.z };
  }
  it('a block can touch an attack off your green set, not stuff it: it comes off the hands soft, into their court', () => {
    const usual = block(false);
    expect(usual.touched).toBe(true);
    expect(usual.note).toBe('Stuff!');
    // (driven back down onto the hitter's side)
    expect(usual.vz).toBeGreaterThan(0);
    const green = block(true);
    expect(green.touched).toBe(true);
    expect(green.note).not.toBe('Stuff!');
    expect(green.vz).toBeLessThan(0);
  });

  it('a late block, hands still coming up, does not soften an attack off your green set: it goes off the fingers and wide', () => {
    // (on any other set the same late hands, with the same dice, take the pace off it for their diggers)
    expect(block(false, true).note).toBe('Soft block');
    const green = block(true, true);
    expect(green.touched).toBe(true);
    expect(green.note).toBe('Tooled');
  });
});

describe('a run across the court loops in (AI hitters)', () => {
  const dir = (x: number, z: number) => new THREE.Vector3(x, 0, z).normalize();
  /** degrees off "straight at the net" for a home-side hitter */
  const offSquare = (v: { x: number; z: number }) => (Math.atan2(Math.abs(v.x), -v.z) * 180) / Math.PI;

  it('a run close to square to the net stays straight', () => {
    expect(bendFor(dir(-0.3, -1), 1, 4)).toBe(0);
    expect(bendFor(dir(0.25, -1), 1, 4)).toBe(0);
  });
  it('a run across the court bends, more the flatter it is, but never much', () => {
    const some = Math.abs(bendFor(dir(-1, -1), 1, 5));
    const more = Math.abs(bendFor(dir(-2, -1), 1, 5));
    expect(some).toBeGreaterThan(0.1);
    expect(more).toBeGreaterThan(some);
    expect(more).toBeLessThanOrEqual(AI.approach.maxBend);
  });
  it('a short step to the ball does not curve', () => {
    expect(bendFor(dir(-1, -1), 1, 1)).toBe(0);
  });
  it('it starts flatter along the net and arrives squarer to it, on both sides of the court', () => {
    for (const [x, side] of [
      [-1, 1],
      [1, 1],
      [-1, -1],
    ] as const) {
      const d = dir(x, -side);
      const p = { dir: d, from: new THREE.Vector3(0, 0, 0), total: 5, bend: bendFor(d, side, 5) };
      const start = runDir(p, { x: 0, z: 0 }, new THREE.Vector3()).clone();
      const end = runDir(p, { x: d.x * 5, z: d.z * 5 }, new THREE.Vector3()).clone();
      const sq = (v: THREE.Vector3) => offSquare({ x: v.x, z: v.z * side });
      expect(sq(start)).toBeGreaterThan(sq(d) + 5);
      expect(sq(end)).toBeLessThan(sq(d) - 5);
    }
  });
  it('the opposite’s X: the feet still come down under the ball, and the last step is squarer than a straight line at the spot', () => {
    const lane = SETTER_PLAYS.OPP.find((p) => p.short === 'X')!.lane;
    const opp = new Athlete('OPP', 1);
    opp.place(lane.sx, lane.sz, 0);
    const contact = new THREE.Vector3(lane.x, attackHeight(opp), lane.z);
    const curved = planToPoint(opp, 0, contact, 1.9, 0, 0, undefined, 0, true)!;
    const straight = planToPoint(opp, 0, contact, 1.9, 0, 0)!;
    expect(straight.bend).toBe(0);
    expect(Math.abs(curved.bend)).toBeGreaterThan(0.2);
    expect(curved.error).toBeLessThan(0.12);
    // run both: how square to the net is each when the feet leave the floor?
    const heading = (p: typeof curved) => {
      const a = simulateApproach(
        opp,
        0,
        p.tStart,
        p.tPress,
        p.hold,
        p.dir,
        p.runYaw,
        p.airYaw,
        p.tPress + p.hold + 0.03,
        p.bend,
        p.total,
        p.carry,
      );
      return offSquare(a.vel);
    };
    expect(heading(curved)).toBeLessThan(heading(straight) - 8);
    // (a run inside is a broad jump along the run, AI.insideRun: squarer than the line, not square)
    expect(heading(curved)).toBeLessThan(45);
  });
});

describe('a hitter who cannot make their called run waits for a high ball', () => {
  it('the setter is told: the call strip shows High and the set to them goes up high', () => {
    const calls = new SetterCalls();
    calls.press('OH');
    calls.press('OH');
    expect(calls.play('OH').short).toBe('Go');
    calls.lock();
    const a = new Athlete('OH', 1);
    const brain = new HitterBrain(a, calls.play('OH').lane);
    const hitters: CallHitters = new Map([['OH', { a, brain }]]);
    syncRuns(hitters, calls);
    expect(calls.isHigh('OH')).toBe(false);
    // still at the net after a block: the run could not be made
    brain.missedRun = true;
    syncRuns(hitters, calls);
    expect(calls.isHigh('OH')).toBe(true);
    expect(calls.label('OH')).toBe('High');
    expect(brain.lane).toBe(calls.highLane('OH'));
  });
  it('before the pass nothing is forced: the calls are still yours to change', () => {
    const calls = new SetterCalls();
    const a = new Athlete('OH', 1);
    const brain = new HitterBrain(a, calls.play('OH').lane);
    brain.missedRun = true;
    syncRuns(new Map([['OH', { a, brain }]]), calls);
    expect(calls.isHigh('OH')).toBe(false);
  });
});
