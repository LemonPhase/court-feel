import { describe, expect, it } from 'vitest';
import { COURT, SIM } from '../src/config';
import { Rng } from '../src/core/mathx';
import { Athlete } from '../src/game/athlete';
import type { Touch, TouchKind } from '../src/game/ballEntity';
import type { Game } from '../src/game/game';
import { makeBall, stepBall, type BallEnv, type CollisionEvent, type V3 } from '../src/physics/ball';
import { BallPredictor } from '../src/physics/predict';
import { SLOT_ROLE, SLOTS, TeamAI, type Slot } from '../src/ai/team';

const DT = 1 / SIM.hz;

/**
 * An all-AI Mini Rally team on `side`, set up to serve, on a stand-in for the Game:
 * the team coordinator only needs the ball (state + prediction), the clock and the rng.
 */
function servingTeam(side: 1 | -1) {
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
  const team = new TeamAI(side, g as unknown as Game);
  for (const slot of SLOTS) team.add(slot, new Athlete(SLOT_ROLE[slot], side), false);
  team.serving = true;
  team.place('defense');
  let reads = 0;
  team.onRead = () => reads++;
  const touch = (athlete: Athlete, kind: TouchKind) => {
    ball.lastTouch = { athlete, kind, t: g.simTime, side: athlete.side };
  };
  /** OH2 serves from behind our end line: deep into their court, or (`net`) low into the net */
  const serve = (net = false) => {
    const v = net ? { y: 1.5, z: 15 } : { y: 4.5, z: 17 };
    ball.touch({ x: 1.5 * side, y: 2.9, z: side * (COURT.halfLength + 0.8) }, { x: -0.6 * side, y: v.y, z: -side * v.z });
    touch(team.players.get('OH2')!, 'serve');
  };
  /** step the ball and the team for up to `seconds`, calling `each` after every step */
  const run = (seconds: number, each: (ev: CollisionEvent[]) => boolean | void = () => {}) => {
    const ev: CollisionEvent[] = [];
    for (let i = 0; i < SIM.hz * seconds; i++) {
      g.simTime += DT;
      ev.length = 0;
      stepBall(state, DT, env, ev);
      team.step();
      if (each(ev)) break;
    }
  };
  const job = (slot: Slot) => team.brains.get(team.players.get(slot)!)!;
  return { g, ball, team, touch, serve, run, job, reads: () => reads };
}

describe.each([1, -1] as const)('our own serve (side %i)', (side) => {
  it('is not one of our touches and nobody plays it: the setter makes no call', () => {
    const { ball, team, serve, run, reads } = servingTeam(side);
    serve();
    run(1.2, () => ball.pos.z * side < -COURT.halfLength);
    expect(ball.pos.z * side).toBeLessThan(0);
    expect(team.touches).toBe(0);
    expect(team.read).toBeNull();
    expect(reads()).toBe(0);
  });

  it('the team settles into base defence while it flies: the front row stays at the net to block', () => {
    const { ball, team, serve, run, job } = servingTeam(side);
    serve();
    const jobs = new Set<string>();
    run(1.2, () => {
      for (const slot of SLOTS) {
        const b = job(slot);
        jobs.add(b.job);
        const spot = team.formSpot('defense', slot);
        expect(Math.hypot(b.spot.x - spot.x, b.spot.z - spot.z)).toBeLessThan(1e-9);
      }
      for (const slot of ['OH1', 'MB', 'OPP'] as const) expect(Math.abs(job(slot).spot.z)).toBeLessThan(1);
      return ball.pos.z * side < -COURT.halfLength;
    });
    // nobody goes off to an approach start, sets or chases our own serve
    expect([...jobs]).toEqual(['base']);
  });

  it('a serve into the net is left alone, and a touch on it by any of us is a service fault', () => {
    const { ball, team, touch, serve, run, job } = servingTeam(side);
    serve(true);
    let net = false;
    const jobs = new Set<string>();
    run(1.5, (ev) => {
      if (ev.some((e) => e.kind === 'net' || e.kind === 'tape')) net = true;
      for (const slot of SLOTS) jobs.add(job(slot).job);
      // dropping back on our side
      return net && ball.vel.y < 0 && ball.pos.y < 1.2;
    });
    expect(net).toBe(true);
    expect(ball.pos.z * side).toBeGreaterThan(0);
    expect([...jobs]).toEqual(['base']);
    expect(team.serveFault).toBe(false);
    // the user (or anyone of ours) digs it up anyway
    touch(team.players.get('L')!, 'dig');
    team.step();
    expect(team.serveFault).toBe(true);
  });

  it('once the other side has played it, our touches are ordinary ones', () => {
    const { team, touch, serve, run } = servingTeam(side);
    serve();
    run(0.6);
    touch(new Athlete('L', -side as 1 | -1), 'pass');
    team.step();
    touch(team.players.get('L')!, 'dig');
    team.step();
    expect(team.serveFault).toBe(false);
    expect(team.touches).toBe(1);
  });
});
