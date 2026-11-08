import { describe, expect, it } from 'vitest';
import { AI, COURT, SIM } from '../src/config';
import { Rng } from '../src/core/mathx';
import { Athlete } from '../src/game/athlete';
import type { Touch, TouchKind } from '../src/game/ballEntity';
import type { Game } from '../src/game/game';
import { laneFor, SETTER_SPOT } from '../src/game/plays';
import { makeBall, stepBall, type BallEnv, type V3 } from '../src/physics/ball';
import { BallPredictor } from '../src/physics/predict';
import { solveApex } from '../src/physics/solve';
import { SLOT_ROLE, SLOTS, TeamAI, type Slot } from '../src/ai/team';

const DT = 1 / SIM.hz;
const NO_SPIN: V3 = { x: 0, y: 0, z: 0 };
const D = AI.defence;
const W = COURT.halfWidth;

/**
 * An all-AI home team (+z) on a stand-in for the Game: the ball (state and prediction), the clock,
 * the rng, and contacts that never happen. Every tick the players step, then the coordinator,
 * as in the game.
 */
function homeTeam() {
  const state = makeBall();
  const predictor = new BallPredictor(DT, SIM.predictHorizon);
  const env: BallEnv = { netTop: COURT.netHeightMen };
  let version = 0;
  let predicted = -1;
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
  };
  const g = {
    simTime: 0,
    env,
    rng: new Rng(3),
    ballLive: true,
    ball,
    setBrain() {},
    hud: { message() {} },
    contact: { lastSet: null, tryPass: () => false, tryBlock: () => false },
  };
  const game = g as unknown as Game;
  const team = new TeamAI(1, game);
  for (const slot of SLOTS) team.add(slot, new Athlete(SLOT_ROLE[slot], 1), false);
  team.place('defense');
  const theirs = new Athlete('OH', -1);
  /** a touch: the ball leaves `from` for `to` with this apex */
  const touch = (kind: TouchKind, side: 1 | -1, from: V3, to: V3, apex: number, athlete: Athlete | null = theirs) => {
    const v = { x: 0, y: 0, z: 0 };
    solveApex(from, to, apex, NO_SPIN, v);
    Object.assign(state.p, from);
    Object.assign(state.v, v);
    state.rest = false;
    version++;
    ball.lastTouch = { athlete, kind, t: g.simTime, side };
  };
  /** a hard spike from `from` straight at `to` (ball centre on the floor) at `speed` m/s */
  const spike = (from: V3, to: V3, speed: number) => {
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const flat = Math.hypot(dx, dz);
    const t = flat / speed;
    const vy = (to.y - from.y + 0.5 * 9.81 * t * t) / t;
    Object.assign(state.p, from);
    Object.assign(state.v, { x: dx / t, y: vy, z: dz / t });
    state.rest = false;
    version++;
    ball.lastTouch = { athlete: theirs, kind: 'spike', t: g.simTime, side: -1 };
  };
  const run = (seconds: number, each?: () => void) => {
    for (let i = 0; i < seconds * SIM.hz; i++) {
      g.simTime += DT;
      stepBall(state, DT, env, []);
      for (const b of team.brains.values()) b.step(DT, game);
      for (const a of team.players.values()) a.step(DT, g.simTime);
      team.step();
      each?.();
    }
  };
  const brain = (slot: Slot) => team.brains.get(team.players.get(slot)!)!;
  return { g, team, ball, touch, spike, run, brain };
}

/** their setter sets their outside high (our right) */
function setOutside(t: ReturnType<typeof homeTeam>) {
  const lane = laneFor('OH', -1);
  t.touch('set', -1, { x: -SETTER_SPOT.x, y: 2.6, z: -SETTER_SPOT.z }, { x: lane.x, y: 3.25, z: lane.z }, 3.25 + lane.apexAbove);
}

describe('the defence reads their set (Mini Rally, perimeter)', () => {
  it('a defender holds its base until it has read the set, then reads to its spot', () => {
    const t = homeTeam();
    setOutside(t);
    t.run(0.1);
    const S = t.brain('S');
    expect(S.job).toBe('base');
    expect(S.spot).toEqual(t.team.formSpot('defense', 'S'));
    expect(t.brain('OH1').job).toBe('block');
    t.run(0.7);
    // the setter at right back digs the line; the libero at left back digs cross; the back-row outside plays middle back
    expect(S.spot.x).toBeCloseTo(W - D.lineIn, 1);
    expect(S.spot.z).toBeCloseTo(D.digDepth, 1);
    expect(t.brain('L').spot.x).toBeLessThan(0);
    expect(t.brain('L').spot.z).toBeCloseTo(D.digDepth, 1);
    expect(t.brain('OH2').spot.z).toBeCloseTo(D.middleBack, 1);
    // the off-blocker leaves the net; the pin blocker stays to block
    expect(t.brain('OH1').job).toBe('base');
    expect(t.brain('OH1').spot.x).toBeCloseTo(-(W - D.offIn), 1);
    expect(t.brain('OH1').spot.z).toBeCloseTo(D.offOff, 1);
    expect(t.brain('OPP').job).toBe('block');
  });

  it('the defenders are on their way before the hit: the setter is most of the way to the line', () => {
    const t = homeTeam();
    const S = t.team.players.get('S')!;
    const startX = S.pos.x;
    setOutside(t);
    t.run(1.1);
    const target = W - D.lineIn;
    expect((S.pos.x - startX) / (target - startX)).toBeGreaterThan(0.6);
  });

  it('after the hit the defenders stay where they read to: nobody runs back to base', () => {
    const t = homeTeam();
    setOutside(t);
    t.run(1.1);
    const lane = laneFor('OH', -1);
    t.spike({ x: lane.x, y: 3.25, z: lane.z }, { x: -2.6, y: 0.1, z: 6.5 }, 22);
    t.run(0.2);
    const S = t.brain('S');
    expect(S.job).toBe('base');
    expect(S.spot.x).toBeCloseTo(W - D.lineIn, 1);
    expect(S.spot.z).toBeCloseTo(D.digDepth, 1);
  });

  it('a hard hit is chased only a reaction time after it', () => {
    const t = homeTeam();
    setOutside(t);
    t.run(1.1);
    const lane = laneFor('OH', -1);
    t.spike({ x: lane.x, y: 3.25, z: lane.z }, { x: -1.0, y: 0.1, z: 7.0 }, 20);
    const hitT = t.g.simTime;
    let firstMove = -1;
    let receiver: Athlete | null = null;
    t.run(0.6, () => {
      receiver ??= t.team.receiver;
      if (receiver && firstMove < 0 && receiver.speed > 0.5) firstMove = t.g.simTime - hitT;
    });
    expect(receiver).not.toBeNull();
    expect(firstMove).toBeGreaterThan(D.hitReact - 3 * D.hitReactSd);
    expect(firstMove).toBeLessThan(D.hitReact + 0.2);
  });
});

describe('early transition (Mini Rally)', () => {
  it('on their free ball the setter releases to the net and the front row leaves the net to approach', () => {
    const t = homeTeam();
    t.touch('pass', -1, { x: 0, y: 1.0, z: -5 }, { x: -1.5, y: 0.8, z: 5.5 }, 5.5);
    t.run(0.1 + AI.transition.read);
    const S = t.brain('S');
    expect(S.job).toBe('base');
    const target = t.team.formSpot('offense', 'S');
    expect(S.spot).toEqual(target);
    for (const slot of ['OH1', 'MB', 'OPP'] as const) expect(t.brain(slot).job, slot).toBe('attack');
  });

  it('on a soft block the passer can get to easily, the setter releases; on a hard hit nobody does', () => {
    const t = homeTeam();
    const mb = t.team.players.get('MB')!;
    // a soft block pops the ball up and back into our court
    t.touch('block', 1, { x: 0.3, y: 2.7, z: 0.3 }, { x: -1.5, y: 0.8, z: 5.0 }, 4.3, mb);
    t.run(0.1 + AI.transition.read);
    expect(t.brain('S').spot).toEqual(t.team.formSpot('offense', 'S'));

    const h = homeTeam();
    setOutside(h);
    h.run(1.1);
    const lane = laneFor('OH', -1);
    h.spike({ x: lane.x, y: 3.25, z: lane.z }, { x: -1.5, y: 0.1, z: 5.5 }, 22);
    h.run(0.1 + AI.transition.read);
    expect(h.brain('S').spot).not.toEqual(h.team.formSpot('offense', 'S'));
  });
});
