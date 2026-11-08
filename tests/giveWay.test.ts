import { describe, expect, it } from 'vitest';
import { AI, COURT, SIM } from '../src/config';
import { Rng } from '../src/core/mathx';
import type { Touch } from '../src/game/ballEntity';
import type { Game } from '../src/game/game';
import { laneFor, SETTER_SPOT } from '../src/game/plays';
import { makeBall, type BallEnv } from '../src/physics/ball';
import { BallPredictor } from '../src/physics/predict';
import { solveApex } from '../src/physics/solve';
import { SLOT_ROLE, SLOTS, TeamAI } from '../src/ai/team';
import { Athlete } from '../src/game/athlete';
import { moveTo } from '../src/ai/brain';
import { giveWay, type Mate } from '../src/ai/giveWay';

const DT = 1 / SIM.hz;

/**
 * Players on one team walking to their spots: each tick every player steers to its spot, then
 * (unless it has right of way) gives way to the others. Returns the closest any two came and
 * where everyone ended up.
 */
function walk(players: { a: Athlete; to: { x: number; z: number }; firm?: boolean; still?: boolean }[], seconds: number) {
  let closest = Infinity;
  let t = 0;
  for (let i = 0; i < seconds * SIM.hz; i++) {
    for (const p of players) {
      if (p.still) p.a.cmd = { moveX: 0, moveZ: 0, sprint: false, faceYaw: 0 };
      else moveTo(p.a, p.to.x, p.to.z, { face: 0, arrive: 0.4 });
    }
    for (const p of players) {
      if (p.firm) continue;
      const mates: Mate[] = players.filter((q) => q !== p).map((q) => ({ athlete: q.a, firm: !!q.firm }));
      giveWay(p.a, mates);
    }
    t += DT;
    for (const p of players) p.a.step(DT, t);
    for (let x = 0; x < players.length; x++)
      for (let y = x + 1; y < players.length; y++) {
        const a = players[x].a.pos;
        const b = players[y].a.pos;
        closest = Math.min(closest, Math.hypot(a.x - b.x, a.z - b.z));
      }
  }
  return closest;
}

const at = (role: 'OH' | 'L' | 'S' | 'MB' | 'OPP', x: number, z: number) => {
  const a = new Athlete(role, 1);
  a.place(x, z, 0);
  return a;
};

describe('players give way to each other (Mini Rally)', () => {
  it('a player walking to their spot steps around a team-mate who is playing the ball, and still gets there', () => {
    const receiver = at('L', 0, 6);
    const walker = at('OH', -3, 6);
    const closest = walk(
      [
        { a: receiver, to: { x: 0, z: 6 }, firm: true, still: true },
        { a: walker, to: { x: 3, z: 6 } },
      ],
      4,
    );
    expect(closest).toBeGreaterThan(0.6);
    expect(Math.hypot(walker.pos.x - 3, walker.pos.z - 6)).toBeLessThan(0.3);
    // the receiver was never moved off the ball
    expect(Math.hypot(receiver.pos.x, receiver.pos.z - 6)).toBeLessThan(1e-6);
  });

  it('two players walking straight at each other pass without touching, and both get there', () => {
    const a = at('OH', -3, 5);
    const b = at('OPP', 3, 5);
    const closest = walk(
      [
        { a, to: { x: 3, z: 5 } },
        { a: b, to: { x: -3, z: 5 } },
      ],
      5,
    );
    expect(closest).toBeGreaterThan(0.6);
    expect(Math.hypot(a.pos.x - 3, a.pos.z - 5)).toBeLessThan(0.3);
    expect(Math.hypot(b.pos.x + 3, b.pos.z - 5)).toBeLessThan(0.3);
  });

  it('a player standing on their spot steps out of the way of a team-mate running through, then goes back', () => {
    const runner = at('S', -4, 6.05);
    const stander = at('L', 0, 6);
    const closest = walk(
      [
        { a: runner, to: { x: 4, z: 6.05 }, firm: true },
        { a: stander, to: { x: 0, z: 6 } },
      ],
      5,
    );
    expect(closest).toBeGreaterThan(0.5);
    expect(Math.hypot(stander.pos.x, stander.pos.z - 6)).toBeLessThan(0.2);
  });
  it('a setter running back to defence does not run through the middle who just landed beside them', () => {
    const middle = at('MB', 1.2, 1.55);
    const setter = at('S', 1.0, 1.0);
    const closest = walk(
      [
        { a: middle, to: { x: 1.2, z: 1.55 }, firm: true, still: true },
        { a: setter, to: { x: 2.8, z: 6.2 } },
      ],
      4,
    );
    expect(closest).toBeGreaterThan(0.5);
    expect(Math.hypot(setter.pos.x - 2.8, setter.pos.z - 6.2)).toBeLessThan(0.3);
  });
});

describe('the split step (Mini Rally)', () => {
  it("defenders time a split step to land as their hitter meets the set; the blockers don't", () => {
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
    const g = { simTime: 0, env, rng: new Rng(5), ballLive: true, ball, setBrain() {}, hud: { message() {} }, contact: { lastSet: null } };
    const team = new TeamAI(1, g as unknown as Game);
    for (const slot of SLOTS) team.add(slot, new Athlete(SLOT_ROLE[slot], 1), false);
    team.place('defense');
    // their setter sets their outside, high
    const lane = laneFor('OH', -1);
    const from = { x: -SETTER_SPOT.x, y: 2.6, z: -SETTER_SPOT.z };
    const v = { x: 0, y: 0, z: 0 };
    solveApex(from, { x: lane.x, y: 3.25, z: lane.z }, 3.25 + lane.apexAbove, { x: 0, y: 0, z: 0 }, v);
    Object.assign(state.p, from);
    Object.assign(state.v, v);
    version++;
    ball.lastTouch = { athlete: null, kind: 'set', t: 0, side: -1 };
    team.step();
    const tc = ball.ensurePrediction(env, 0).descendThrough(3.25, 0);
    for (const slot of SLOTS) {
      const a = team.players.get(slot)!;
      if (team.frontRow().includes(a)) expect(a.splitT, slot).toBeLessThan(0);
      else expect(a.splitT, slot).toBeCloseTo(tc - AI.splitStep.dip - AI.splitStep.air, 6);
    }
  });
});
