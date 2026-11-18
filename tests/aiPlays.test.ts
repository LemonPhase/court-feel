import { afterEach, describe, expect, it } from 'vitest';
import { AI, COURT, SIM, type PositionId } from '../src/config';
import { Rng } from '../src/core/mathx';
import { Athlete } from '../src/game/athlete';
import type { Touch } from '../src/game/ballEntity';
import type { AiHost } from '../src/game/brains';
import { COMBOS } from '../src/game/combos';
import { SET_PLAYS, SETTER_SPOT, SETTER_TARGET } from '../src/game/plays';
import { clashes, hitX } from '../src/game/setterCalls';
import { makeBall, stepBall, type BallEnv, type V3 } from '../src/physics/ball';
import { BallPredictor } from '../src/physics/predict';
import { solveApex } from '../src/physics/solve';
import { SLOT_ROLE, SLOTS, TeamAI, USER_SLOT } from '../src/ai/team';

const DT = 1 / SIM.hz;
const PLAYS = { ...AI.plays };
afterEach(() => Object.assign(AI.plays, PLAYS));

/**
 * A Mini Rally team on `side` (the user in `pos`, or all AI), its setter running plays, on a
 * stand-in for the Game: the team only needs the ball, the clock and the rng.
 */
function team(side: 1 | -1, pos: PositionId | null) {
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
  const g = { simTime: 0, env, rng: new Rng(7), ballLive: false, ball, setBrain() {}, contact: { lastSet: null } };
  const t = new TeamAI(side, g as unknown as AiHost);
  t.playsOn = true;
  for (const slot of SLOTS) {
    const mine = !!pos && slot === USER_SLOT[pos];
    const a = new Athlete(SLOT_ROLE[slot], side);
    if (mine) a.isUser = true;
    t.add(slot, a, mine);
  }
  /** a new rally: we receive their serve (the ball dead until it is served) */
  const rally = () => {
    g.ballLive = false;
    t.place('receive');
    t.step();
  };
  /** the libero passes to (x, z) on our side (home-side numbers, mirrored for the far team) */
  const pass = (x: number, z: number) => {
    const from = { x: 2.4 * side, y: 0.85, z: 6.0 * side };
    const out = { x: 0, y: 0, z: 0 };
    solveApex(from, { x: x * side, y: 2.5, z: z * side }, 4.1, { x: 0, y: 0, z: 0 }, out);
    ball.touch(from, out);
    g.ballLive = true;
    ball.lastTouch = { athlete: t.players.get('L')!, kind: 'pass', t: g.simTime, side };
    g.simTime += DT;
    t.step();
  };
  /** their free ball coming over to the middle of our court */
  const theirFree = () => {
    const from = { x: 0, y: 2.6, z: -3 * side };
    const out = { x: 0, y: 0, z: 0 };
    solveApex(from, { x: 0, y: 0.5, z: 5 * side }, 5.5, { x: 0, y: 0, z: 0 }, out);
    ball.touch(from, out);
    g.ballLive = true;
    ball.lastTouch = { athlete: null, kind: 'free', t: g.simTime, side: -side as 1 | -1 } as unknown as Touch;
    g.simTime += DT;
    t.step();
  };
  const flight = () => {
    for (let i = 0; i < SIM.hz * 0.6; i++) {
      g.simTime += DT;
      stepBall(state, DT, env, []);
      t.step();
    }
  };
  return { g, team: t, rally, pass, theirFree, flight };
}

describe('AI setters run combination plays (Mini Rally)', () => {
  it('the setter signals a play before about a quarter of the serves, and calls one on most free balls', () => {
    const { team: t, rally, theirFree } = team(1, null);
    let receive = 0;
    let free = 0;
    const N = 600;
    for (let i = 0; i < N; i++) {
      rally();
      if (t.play) receive++;
      // (a free ball is the other team's possession: the serve-receive play is over by then)
      rally();
      t.play = null;
      theirFree();
      if (t.play) free++;
    }
    expect(receive / N).toBeGreaterThan(AI.plays.receive - 0.06);
    expect(receive / N).toBeLessThan(AI.plays.receive + 0.06);
    expect(free / N).toBeGreaterThan(AI.plays.free - 0.06);
    expect(free / N).toBeLessThan(AI.plays.free + 0.06);
  });

  it('a play signalled before the serve runs off a perfect pass', () => {
    AI.plays.receive = 1;
    const { team: t, rally, pass } = team(1, null);
    rally();
    expect(t.play?.state).toBe('signalled');
    pass(SETTER_TARGET.x, SETTER_TARGET.z);
    expect(t.play?.state).toBe('running');
  });

  it('off a pass that is in system but not perfect, the serve-receive play is off and the hitters go back to their own lanes', () => {
    AI.plays.receive = 1;
    const { team: t, rally, pass } = team(1, null);
    rally();
    pass(SETTER_SPOT.x, SETTER_SPOT.z + 1.2);
    expect(t.play?.state).toBe('off');
    const mb = t.brains.get(t.players.get('MB')!)!.hitter!;
    expect(mb.inFront).toBeUndefined();
    const oh = t.brains.get(t.players.get('OH1')!)!.hitter!;
    expect(oh.lane.label).toBe('Outside high ball (4)');
  });

  it('a free-ball play runs off any pass in system, not only a perfect one', () => {
    AI.plays.free = 1;
    const { team: t, theirFree, pass } = team(1, null);
    theirFree();
    expect(t.play?.on).toBe('free');
    pass(SETTER_SPOT.x, SETTER_SPOT.z + 1.2);
    expect(t.play?.state).toBe('running');
  });

  it('your call wins: the play is built around your route, and no two front-row hitters hit from one spot', () => {
    AI.plays.receive = 1;
    const { team: t, rally } = team(1, 'OPP');
    t.userPlay = SET_PLAYS.OPP!.find((p) => p.short === 'X')!;
    const names = new Set<string>();
    for (let i = 0; i < 200; i++) {
      rally();
      const v = t.playView()!;
      expect(v.calls.OPP).toBe('X');
      expect(clashes(v.calls)).toBe(false);
      names.add(v.name);
    }
    // the tandem sends the outside to the same spot as your X: it is never called round it
    expect(names.has('Tandem')).toBe(false);
    expect(names.size).toBeGreaterThan(3);
  });

  it("their setter's play is run on their side of the net: their opposite's X crosses on their court", () => {
    AI.plays.receive = 1;
    const { team: t, rally } = team(-1, null);
    t.playPool = () => COMBOS.filter((c) => c.name === 'X');
    rally();
    const opp = t.brains.get(t.players.get('OPP')!)!.hitter!;
    const x = SET_PLAYS.OPP!.find((p) => p.short === 'X')!;
    expect(opp.lane.z).toBeLessThan(0);
    expect(opp.lane.x).toBeCloseTo(-hitX(x), 6);
    expect(opp.lane.sx).toBeCloseTo(-x.lane.sx, 6);
  });

  it('a new rally ends the play: every hitter is back on their own lane', () => {
    AI.plays.receive = 1;
    const { team: t, rally, pass } = team(1, null);
    rally();
    pass(SETTER_TARGET.x, SETTER_TARGET.z);
    AI.plays.receive = 0;
    rally();
    expect(t.play).toBeNull();
    const opp = t.brains.get(t.players.get('OPP')!)!.hitter!;
    expect(opp.lane.label).toBe('Opposite back set (red)');
    expect(t.brains.get(t.players.get('MB')!)!.hitter!.inFront).toBeUndefined();
  });

  it("picking a play never shifts the game's own random draws", () => {
    AI.plays.receive = 1;
    const plays = team(1, null);
    const none = team(1, null);
    none.team.playsOn = false;
    plays.rally();
    none.rally();
    expect(plays.team.play).not.toBeNull();
    expect(plays.g.rng.next()).toBe(none.g.rng.next());
  });
});
