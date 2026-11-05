import { describe, expect, it } from 'vitest';
import { AI, COURT, SIM, type PositionId } from '../src/config';
import { Rng } from '../src/core/mathx';
import { Athlete } from '../src/game/athlete';
import type { Touch } from '../src/game/ballEntity';
import type { Game } from '../src/game/game';
import { attackHeight, LANES, needsGoodPass, SET_PLAYS, SETTER_SPOT, SETTER_TARGET } from '../src/game/plays';
import { makeBall, stepBall, type BallEnv, type V3 } from '../src/physics/ball';
import { BallPredictor } from '../src/physics/predict';
import { solveApex } from '../src/physics/solve';
import { SLOT_ROLE, SLOTS, TeamAI, USER_SLOT, type SetterRead } from '../src/ai/team';

const DT = 1 / SIM.hz;

/**
 * A Mini Rally home team with the user in `pos`, on a stand-in for the Game: the team
 * coordinator only needs the ball (state + prediction), the clock and the rng.
 */
function homeTeam(pos: PositionId) {
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
  const g = {
    simTime: 0,
    env,
    rng: new Rng(7),
    ballLive: true,
    ball,
    setBrain() {},
    hud: { message() {} },
    contact: { lastSet: null },
  };
  const team = new TeamAI(1, g as unknown as Game);
  const me = new Athlete(pos, 1);
  me.isUser = true;
  for (const slot of SLOTS) {
    const mine = slot === USER_SLOT[pos];
    team.add(slot, mine ? me : new Athlete(SLOT_ROLE[slot], 1), mine);
  }
  team.place('receive');
  const reads: { r: SetterRead; t: number }[] = [];
  team.onRead = (r) => reads.push({ r: { ...r }, t: g.simTime });
  /** the libero passes from the back court to (x, z) at the setter's hands height */
  const pass = (x: number, z: number) => {
    const libero = team.players.get('L')!;
    const from = { x: 2.4, y: 0.85, z: 6.0 };
    const out = { x: 0, y: 0, z: 0 };
    solveApex(from, { x, y: 2.5, z }, 4.1, { x: 0, y: 0, z: 0 }, out);
    ball.touch(from, out);
    ball.lastTouch = { athlete: libero, kind: 'pass', t: g.simTime, side: 1 };
  };
  /** run the team (and the ball) until the setter would touch it: the ball drops to their hands */
  const flight = () => {
    const setter = team.players.get('S')!;
    const hands = setter.height + 0.17 + 0.45;
    for (let i = 0; i < SIM.hz * 3; i++) {
      g.simTime += DT;
      stepBall(state, DT, env, []);
      team.step();
      if (state.v.y < 0 && state.p.y < hands) break;
    }
  };
  return { g, team, me, ball, reads, pass, flight };
}

describe("the setter's call on the pass (Mini Rally)", () => {
  it('a pass to the target is called in system, once, a moment after the pass', () => {
    const { team, reads, pass, flight } = homeTeam('OH');
    pass(SETTER_TARGET.x, SETTER_TARGET.z);
    flight();
    expect(reads).toHaveLength(1);
    expect(reads[0].r.call).toBe('in');
    expect(reads[0].t).toBeGreaterThanOrEqual(AI.setterRead - 1e-9);
    // in good time to change an approach: well before the setter touches it
    expect(reads[0].t).toBeLessThan(AI.setterRead + 0.05);
    expect(team.read?.off).toBeLessThan(0.5);
  });

  it('a pass well off the net is called out of system ("high")', () => {
    const { team, reads, pass, flight } = homeTeam('OH');
    pass(SETTER_SPOT.x + 0.4, SETTER_SPOT.z + 2.6);
    flight();
    expect(reads).toHaveLength(1);
    expect(reads[0].r.call).toBe('out');
    expect(team.read!.off).toBeGreaterThan(AI.outOfSystem);
  });

  it('the set follows the call: a called go is fast in system and a high ball out of system', () => {
    const go = SET_PLAYS.OH![1];
    expect(needsGoodPass(go)).toBe(true);
    for (const [z, out] of [
      [SETTER_TARGET.z, false],
      [SETTER_SPOT.z + 2.6, true],
    ] as const) {
      const { g, team, me, pass, flight } = homeTeam('OH');
      team.userPlay = go;
      team.userSetBias = 1;
      pass(SETTER_TARGET.x, z);
      flight();
      expect(team.read!.call).toBe(out ? 'out' : 'in');
      // the setter is wherever: the call decides, not where they ended up standing
      const setter = team.players.get('S')!;
      setter.place(SETTER_SPOT.x, SETTER_SPOT.z, 0);
      const set = team.callSet(g as unknown as Game, setter);
      expect(set.hitter).toBe(me);
      const above = set.apex - attackHeight(me);
      if (out) expect(above).toBeGreaterThanOrEqual(LANES.OH.apexAbove + 0.4 - 1e-6);
      else expect(above).toBeCloseTo(go.lane.apexAbove, 6);
    }
  });

  it('the setter running down a bad pass does not change the call that was made', () => {
    const { g, team, pass, flight } = homeTeam('OPP');
    team.userPlay = SET_PLAYS.OPP![1];
    team.userSetBias = 1;
    pass(SETTER_SPOT.x - 1.2, SETTER_SPOT.z + 2.4);
    flight();
    expect(team.read!.call).toBe('out');
    // even taken right on the setter's spot, the set is the high one that was called
    const setter = team.players.get('S')!;
    setter.place(SETTER_SPOT.x, SETTER_SPOT.z, 0);
    const set = team.callSet(g as unknown as Game, setter);
    expect(set.apex - attackHeight(team.user!)).toBeGreaterThan(LANES.OPP.apexAbove);
  });
});
