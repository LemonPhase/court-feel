import { describe, expect, it } from 'vitest';
import { AI, COURT, SIM, type PositionId } from '../src/config';
import { Rng } from '../src/core/mathx';
import { Athlete } from '../src/game/athlete';
import type { Touch } from '../src/game/ballEntity';
import type { Game } from '../src/game/game';
import { attackHeight, handSetAllowed, laneFor, LANES, needsGoodPass, SET_PLAYS, SETTER_SPOT, SETTER_TARGET } from '../src/game/plays';
import { planApproach } from '../src/ai/approach';
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
  /** our setter digs the first ball from his defence spot, aimed where a first ball by him goes */
  const setterDigs = () => {
    const setter = team.players.get('S')!;
    const d = team.formSpot('defense', 'S');
    setter.place(d.x, d.z, 0);
    const T = team.firstBallTarget(setter);
    const from = { x: d.x, y: 0.75, z: d.z };
    const out = { x: 0, y: 0, z: 0 };
    solveApex(from, T, T.apex, { x: 0, y: 0, z: 0 }, out);
    ball.touch(from, out);
    ball.lastTouch = { athlete: setter, kind: 'dig', t: g.simTime, side: 1 };
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
  return { g, team, me, ball, reads, pass, setterDigs, flight };
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

describe('when our setter plays the first ball (Mini Rally)', () => {
  it('he digs it high to the middle of the court, just behind the 3 m line', () => {
    const { team } = homeTeam('OH');
    const dig = team.firstBallTarget(team.players.get('S')!);
    const pass = team.firstBallTarget(team.players.get('L')!);
    // anyone else passes to the setter target at the net
    expect(pass.z).toBeCloseTo(SETTER_TARGET.z, 6);
    expect(dig.z).toBeGreaterThan(COURT.attackLine);
    expect(dig.z).toBeLessThan(COURT.attackLine + 1);
    expect(Math.abs(dig.x)).toBeLessThan(1.5);
    expect(dig.apex).toBeGreaterThan(pass.apex);
  });

  it('he does not go to set the second ball: he goes back to defend, and the libero sets it', () => {
    const { team, setterDigs, flight } = homeTeam('OH');
    setterDigs();
    flight();
    const setter = team.brains.get(team.players.get('S')!)!;
    const d = team.formSpot('defense', 'S');
    expect(setter.job).toBe('base');
    expect(Math.hypot(setter.spot.x - d.x, setter.spot.z - d.z)).toBeLessThan(1e-9);
    expect(team.brains.get(team.players.get('L')!)!.job).toBe('set');
    expect(team.secondBy).toBe(team.players.get('L'));
  });

  it('the second ball is out of system: the libero calls HIGH! and a called go goes up high', () => {
    const { g, team, me, reads, setterDigs, flight } = homeTeam('OH');
    team.userPlay = SET_PLAYS.OH![1];
    team.userSetBias = 1;
    setterDigs();
    flight();
    expect(reads).toHaveLength(1);
    expect(reads[0].r.setter).toBe(team.players.get('L'));
    expect(reads[0].r.call).toBe('out');
    const set = team.callSet(g as unknown as Game, team.players.get('L')!);
    expect(set.hitter).toBe(me);
    expect((set as { time?: number }).time).toBeUndefined();
    expect(set.apex - attackHeight(me)).toBeGreaterThanOrEqual(LANES.OH.apexAbove + 0.4 - 1e-6);
  });

  it('the libero only sets high balls to the pins: no quick, no pipe', () => {
    const { g, team, setterDigs, flight } = homeTeam('OH');
    team.userSetBias = 0;
    setterDigs();
    flight();
    const libero = team.players.get('L')!;
    const pins = new Set([team.players.get('OH1'), team.players.get('OPP')]);
    for (let i = 0; i < 40; i++) {
      const set = team.callSet(g as unknown as Game, libero);
      expect(pins.has(set.hitter!)).toBe(true);
      expect((set as { time?: number }).time).toBeUndefined();
    }
  });

  it('a libero hand-sets only from behind the 3 m line (in front of it they bump-set)', () => {
    const libero = new Athlete('L', 1);
    const setter = new Athlete('S', 1);
    expect(handSetAllowed(libero, COURT.attackLine + 0.3)).toBe(true);
    expect(handSetAllowed(libero, -(COURT.attackLine + 0.3))).toBe(true);
    expect(handSetAllowed(libero, COURT.attackLine - 0.3)).toBe(false);
    expect(handSetAllowed(libero, 0.7)).toBe(false);
    // on the line is the front zone
    expect(handSetAllowed(libero, COURT.attackLine)).toBe(false);
    expect(handSetAllowed(setter, 0.7)).toBe(true);
  });

  it('when the user is the libero, the second ball is theirs: no AI is sent to play it', () => {
    const { team, me, setterDigs, flight } = homeTeam('L');
    setterDigs();
    flight();
    expect(team.secondBy).toBe(me);
    for (const b of team.brains.values()) {
      expect(b.job).not.toBe('set');
      expect(b.job).not.toBe('free');
    }
  });
});

describe('the pipe (back-row attack, Mini Rally and the libero in the Spike Drill)', () => {
  it('in system it is met 2 m off the net, and the hitter leaves the floor behind the 3 m line', () => {
    const lane = laneFor('L', 1);
    const hitter = new Athlete('OH', 1);
    hitter.place(lane.sx, lane.sz, 0);
    // the setter's set from their spot, as `callSet` makes it in system
    const y = attackHeight(hitter);
    const from = { x: SETTER_SPOT.x, y: 2.6, z: SETTER_SPOT.z };
    const v = { x: 0, y: 0, z: 0 };
    solveApex(from, { x: lane.x, y, z: lane.z }, y + lane.apexAbove, { x: 0, y: 0, z: 0 }, v);
    const state = makeBall();
    Object.assign(state.p, from);
    Object.assign(state.v, v);
    const env: BallEnv = { netTop: COURT.netHeightMen };
    const pred = new BallPredictor(DT, SIM.predictHorizon);
    pred.compute(state, env, 0);
    // the AI hitter's approach, run on the athlete's own kinematics (as HitterBrain does)
    const plan = planApproach(hitter, pred, 0, 0, 0)!;
    expect(plan).not.toBeNull();
    let takeoffZ = -1;
    hitter.onTakeoff = (a) => (takeoffZ = a.pos.z);
    for (let t = 0; t < plan.tc;) {
      const running = t >= plan.tStart && t < plan.tPress;
      hitter.cmd = { moveX: running ? plan.dir.x : 0, moveZ: running ? plan.dir.z : 0, sprint: running, faceYaw: plan.runYaw };
      if (t >= plan.tPress && hitter.state === 'ground') hitter.jumpPress();
      if (t >= plan.tPress + plan.hold) hitter.jumpRelease();
      t += DT;
      hitter.step(DT, t);
    }
    expect(plan.contact.z).toBeCloseTo(2.0, 1);
    expect(plan.error).toBeLessThan(0.3);
    expect(takeoffZ).toBeGreaterThan(COURT.attackLine);
  });

  it('in system about one ball in five goes to the pipe; out of system fewer', () => {
    const share = (inSystem: boolean) => {
      const { g, team, pass, flight } = homeTeam('L');
      if (inSystem) pass(SETTER_TARGET.x, SETTER_TARGET.z);
      else pass(SETTER_SPOT.x + 0.4, SETTER_SPOT.z + 2.6);
      flight();
      const setter = team.players.get('S')!;
      const pipe = team.players.get('OH2')!;
      let n = 0;
      for (let i = 0; i < 2000; i++) if (team.callSet(g as unknown as Game, setter).hitter === pipe) n++;
      return n / 2000;
    };
    const inSys = share(true);
    const out = share(false);
    expect(inSys).toBeGreaterThan(0.15);
    expect(inSys).toBeLessThan(0.25);
    expect(out).toBeLessThan(inSys);
  });

  it('out of system the back-row set stays behind the 3 m line', () => {
    const { g, team, pass, flight } = homeTeam('L');
    pass(SETTER_SPOT.x + 0.4, SETTER_SPOT.z + 2.6);
    flight();
    expect(team.read!.call).toBe('out');
    const setter = team.players.get('S')!;
    const pipe = team.players.get('OH2')!;
    let seen = 0;
    for (let i = 0; i < 60; i++) {
      const set = team.callSet(g as unknown as Game, setter);
      if (set.hitter !== pipe) continue;
      seen++;
      expect(set.target.z).toBeGreaterThan(COURT.attackLine + 0.5);
    }
    expect(seen).toBeGreaterThan(0);
  });
});
