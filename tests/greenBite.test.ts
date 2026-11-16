import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { AI, BALL, CONTACT, COURT, SIM } from '../src/config';
import { bendFor, planToPoint, runDir, simulateApproach } from '../src/ai/approach';
import { decoyFor, greenFools, userGreen } from '../src/ai/greenBite';
import { HitterBrain } from '../src/ai/hitter';
import { MiddleBlocker } from '../src/ai/middle';
import { Athlete } from '../src/game/athlete';
import type { Touch } from '../src/game/ballEntity';
import { syncRuns, type CallHitters } from '../src/game/callRuns';
import { blockHands, ContactSystem, type ContactHost, type SetResult } from '../src/game/contact';
import type { Game } from '../src/game/game';
import { attackHeight, laneFor, LANES, SETTER_PLAYS, SETTER_TARGET } from '../src/game/plays';
import { SetterCalls } from '../src/game/setterCalls';
import { makeBall, stepBall, type BallEnv, type V3 } from '../src/physics/ball';
import { BallPredictor } from '../src/physics/predict';
import { netClearance, solveApex, solveSpeedToFloor } from '../src/physics/solve';

const DT = 1 / SIM.hz;
const env: BallEnv = { netTop: COURT.netHeightMen };

/** a stand-in Game: the ball, the clock, a flat rng, everyone on court, and the user's last set */
function stage(set: Touch, green: boolean, athletes: Athlete[], setTo: Athlete | null) {
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
      lastSet: { hitter: setTo },
      tryBlock: () => false,
    },
  };
  return { g, ball };
}

/** our setter's high ball to the outside is in the air */
function pinSet(green: boolean, others: Athlete[]) {
  const setter = new Athlete('S', 1);
  const outside = new Athlete('OH', 1);
  outside.place(LANES.OH.sx, LANES.OH.sz, 0);
  const theirs = new Athlete('MB', -1);
  theirs.place(0, -0.5, Math.PI);
  const set: Touch = { athlete: setter, kind: 'set', t: 0, side: 1 };
  const { g, ball } = stage(set, green, [setter, outside, theirs, ...others], outside);
  const from = { x: SETTER_TARGET.x, y: 2.5, z: SETTER_TARGET.z };
  const out = { x: 0, y: 0, z: 0 };
  const lane = laneFor('OH', 1);
  solveApex(from, { x: lane.x, y: 3.2, z: lane.z }, 3.2 + lane.apexAbove, { x: 0, y: 0, z: 0 }, out);
  ball.touch(from, out);
  return { g, ball, theirs, set };
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

  /** their Mini Rally middle while your set to the outside flies: did it jump, and where is it when your hitter meets the ball */
  function middle(green: boolean, withQuick: boolean) {
    const quick = withQuick ? quickHitter() : null;
    const { g, ball, theirs } = pinSet(green, quick ? [quick] : []);
    const brain = new MiddleBlocker(theirs, 0, () => quick);
    let jumped = -1;
    for (let i = 0; i < SIM.hz * 1.6; i++) {
      g.simTime += DT;
      stepBall(ball.state, DT, env);
      if (quick) {
        if (quick.state === 'load' && quick.loadT > 0.2) quick.jumpRelease();
        quick.step(DT, g.simTime);
      }
      brain.step(DT, g as unknown as Game);
      theirs.step(DT, g.simTime);
      if (jumped < 0 && theirs.state === 'air') jumped = g.simTime;
      if (ball.state.v.y < 0 && ball.state.p.y < 3.2) break;
    }
    return { x: theirs.pos.x, jumped, state: theirs.state, tHit: g.simTime };
  }

  it('on a normal set to the outside their middle runs to close the block', () => {
    expect(middle(false, true).x).toBeLessThan(-1.5);
  });
  it('on your green set it goes up with your middle’s quick instead, and is down again when your outside hits', () => {
    const m = middle(true, true);
    // it jumped, early (with the quick, not with the outside), and never left the middle of the net
    expect(m.jumped).toBeGreaterThan(0);
    expect(m.jumped).toBeLessThan(m.tHit - 0.5);
    expect(Math.abs(m.x)).toBeLessThan(1);
    expect(m.state).not.toBe('air');
  });
  it('on your green set with no quick running it stays home: the pin blocker is on their own', () => {
    const m = middle(true, false);
    expect(Math.abs(m.x)).toBeLessThan(0.5);
    expect(m.jumped).toBe(-1);
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

  /** their middle, at the top of a block jump with the arms up, meets a hard spike in the middle of its hands */
  function block(green: boolean) {
    const b = new Athlete('MB', -1);
    b.place(0, -0.4, Math.PI);
    b.jumpPress();
    let t = 0;
    for (let i = 0; i < SIM.hz && !(b.state === 'air' && b.vel.y <= 0.4); i++) b.step(DT, (t += DT));
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
