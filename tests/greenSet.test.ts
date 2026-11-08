import { describe, expect, it } from 'vitest';
import { AI, CONTACT, COURT, SIM } from '../src/config';
import { Athlete } from '../src/game/athlete';
import type { Touch } from '../src/game/ballEntity';
import type { Game } from '../src/game/game';
import { laneFor, LANES, SETTER_TARGET } from '../src/game/plays';
import { BlockerBrain } from '../src/ai/blocker';
import { HitterBrain } from '../src/ai/hitter';
import { openShot, type BlockHands, type Digger } from '../src/ai/openShot';
import { makeBall, R, stepBall, type BallEnv, type V3 } from '../src/physics/ball';
import { BallPredictor } from '../src/physics/predict';
import { solveApex, solveSpeedToFloor } from '../src/physics/solve';

const DT = 1 / SIM.hz;
const env: BallEnv = { netTop: COURT.netHeightMen };
const SPEED = CONTACT.spikePerfect;
const SPIN = CONTACT.spikeSpinPerfect;

/** their back row in base defence (the Mini Rally's zone 1, 6, 5), starting late on a green attack */
const backRow = (): Digger[] =>
  (
    [
      ['S', -2.8, -6.2],
      ['L', 0, -7.3],
      ['OH', 2.9, -6.2],
    ] as const
  ).map(([role, x, z]) => ({ x, z, ready: AI.greenSetDigDelay, speed: new Athlete(role, -1).stats.approachSpeed }));

/** fly the spike the hitter would hit at (x, z): every point of the flight, with its time */
function flight(from: V3, x: number, z: number): { p: V3; t: number }[] {
  const out = { x: 0, y: 0, z: 0 };
  const w = { x: 0, y: 0, z: 0 };
  const land = { x: 0, y: 0, z: 0 };
  solveSpeedToFloor(from, x, z, SPEED, SPIN, out, w, land);
  const s = makeBall();
  Object.assign(s.p, from);
  Object.assign(s.v, out);
  Object.assign(s.w, w);
  const pts: { p: V3; t: number }[] = [];
  let t = 0;
  while (s.p.y > R && t < 3) {
    stepBall(s, 1 / 240, env);
    t += 1 / 240;
    pts.push({ p: { ...s.p }, t });
  }
  return pts;
}

/** the hitter's pick among the open spots: the k-th of n even steps through 0..1 */
const seq =
  (k: number, n = 12) =>
  () =>
    (k - 0.5) / n;

describe('a green set is a point: the open spot', () => {
  const OH_HIT = { x: LANES.OH.x, y: 3.2, z: LANES.OH.z };

  it('off a green set the outside hits where no digger can get a platform under it in time', () => {
    const diggers = backRow();
    const shot = openShot(OH_HIT, SPEED, SPIN, -1, env, diggers, [], seq(3))!;
    expect(shot).not.toBeNull();
    expect(shot.margin).toBeGreaterThanOrEqual(AI.openShotMargin);
    // fly it: below platform height no digger is within reach of where it drops, even running from their late start
    for (const { p, t } of flight(OH_HIT, shot.x, shot.z)) {
      if (p.z > 0 || p.y > AI.digTop) continue;
      for (const d of diggers) {
        const reach = AI.digReach + Math.max(0, t - d.ready) * d.speed;
        expect(Math.hypot(p.x - d.x, p.z - d.z)).toBeGreaterThan(reach);
      }
    }
    // and it lands in their court
    expect(Math.abs(shot.x)).toBeLessThan(COURT.halfWidth);
    expect(shot.z).toBeLessThan(0);
    expect(shot.z).toBeGreaterThan(-COURT.halfLength);
  });

  it('the hitter varies the zone: different open spots, not one kill shot', () => {
    const spots = new Set<string>();
    for (let s = 1; s <= 12; s++) {
      const shot = openShot(OH_HIT, SPEED, SPIN, -1, env, backRow(), [], seq(s))!;
      spots.add(`${shot.x.toFixed(1)},${shot.z.toFixed(1)}`);
    }
    expect(spots.size).toBeGreaterThanOrEqual(3);
  });

  it('it goes round a single block with its hands up, never through them', () => {
    // a wing blocker on the line of the cross-court shot, at full reach
    const block: BlockHands = { x: -2.6, top: () => 2.45 + 0.04 + 0.8 };
    for (let s = 1; s <= 8; s++) {
      const shot = openShot(OH_HIT, SPEED, SPIN, -1, env, backRow(), [block], seq(s))!;
      for (const { p } of flight(OH_HIT, shot.x, shot.z)) {
        if (Math.abs(p.z) > AI.blockReachBand) continue;
        const clear = Math.abs(p.x - block.x) >= CONTACT.blockHalfWidth + R || p.y >= block.top(0) + R;
        expect(clear).toBe(true);
      }
    }
  });

  it('a pipe from behind the 3 m line finds an open spot too (their diggers start late)', () => {
    const pipe = { x: LANES.L.x, y: 3.2, z: LANES.L.z };
    const shot = openShot(pipe, SPEED, SPIN, -1, env, backRow(), [], seq(5))!;
    expect(shot.margin).toBeGreaterThanOrEqual(AI.openShotMargin);
  });
});

/** a stand-in Game for one brain: the ball (state + prediction), the clock, the rng, the user's last set */
function stage(lastTouch: Touch, green: boolean) {
  const state = makeBall();
  const predictor = new BallPredictor(DT, SIM.predictHorizon);
  let version = 0;
  let predicted = -1;
  const ball = {
    state,
    active: true,
    lastTouch: lastTouch as Touch | null,
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
    simTime: 0,
    env,
    ball,
    rng: { next: () => 0, gauss: () => 0 },
    contact: { lastSetResult: { athlete: lastTouch.athlete, t: lastTouch.t, green }, tryBlock: () => false },
  };
  return { g, ball };
}

describe('a green set is a point: their middle guesses wrong', () => {
  /** our setter sets the outside a high ball; their middle reads it. Where is the middle when our hitter meets it? */
  function middleOnPinSet(green: boolean): number {
    const setter = new Athlete('S', 1);
    const { g, ball } = stage({ athlete: setter, kind: 'set', t: 0, side: 1 }, green);
    const from = { x: SETTER_TARGET.x, y: 2.5, z: SETTER_TARGET.z };
    const out = { x: 0, y: 0, z: 0 };
    const lane = laneFor('OH', 1);
    solveApex(from, { x: lane.x, y: 3.2, z: lane.z }, 3.2 + lane.apexAbove, { x: 0, y: 0, z: 0 }, out);
    ball.touch(from, out);
    const mb = new Athlete('MB', -1);
    mb.place(0, -0.5, Math.PI);
    const brain = new BlockerBrain(mb, 0, 3.4, true);
    brain.skill = 1;
    for (let i = 0; i < SIM.hz * 1.6; i++) {
      g.simTime += DT;
      stepBall(ball.state, DT, env);
      brain.step(DT, g as unknown as Game);
      mb.step(DT, g.simTime);
      if (ball.state.v.y < 0 && ball.state.p.y < 3.2) break;
    }
    return mb.pos.x;
  }

  it('on a normal set to the outside the middle goes with it, to close the block', () => {
    expect(middleOnPinSet(false)).toBeLessThan(-2);
  });

  it('on your green set to the outside the middle stays home for the quick: one block to beat', () => {
    expect(Math.abs(middleOnPinSet(true))).toBeLessThan(0.5);
  });
});

describe('transition: the middle backs off the net before the quick', () => {
  /** our middle, at the net from a block, as a dig goes up to our setter who touches it in `left` s */
  function transition(left: number) {
    const mb = new Athlete('MB', 1);
    mb.place(0.2, 0.6, 0);
    const brain = new HitterBrain(mb, laneFor('MB', 1));
    const digger = new Athlete('L', 1);
    const g = {
      simTime: 0,
      env,
      ball: { active: true, lastTouch: { athlete: digger, kind: 'dig', t: 0, side: 1 } as Touch },
      rng: { next: () => 0.5, gauss: () => 0 },
      contact: { beginWindup() {} },
    };
    brain.passToSetter = () => ({ t: left, x: SETTER_TARGET.x });
    let zAtRun = -1;
    let leftFloor = -1;
    for (let i = 0; i < SIM.hz * (left + 0.6); i++) {
      g.simTime += DT;
      brain.step(DT, g as unknown as Game);
      mb.step(DT, g.simTime);
      if (zAtRun < 0 && brain.phase === 'approach') zAtRun = mb.pos.z;
      if (leftFloor < 0 && mb.state === 'air') leftFloor = g.simTime;
    }
    return { zAtRun, leftFloor };
  }

  it('with time, it gets to its approach start first, then runs, and is up as the setter touches it', () => {
    const r = transition(1.8);
    expect(r.zAtRun).toBeGreaterThan(LANES.MB.sz - AI.transitionReady - 0.1);
    expect(Math.abs(r.leftFloor - 1.8)).toBeLessThan(0.12);
  });

  it('with no time to back off, it goes from where it is', () => {
    const r = transition(AI.transitionLatest - 0.1);
    expect(r.zAtRun).toBeLessThan(1.2);
    expect(r.leftFloor).toBeGreaterThan(0);
  });
});
