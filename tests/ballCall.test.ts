import { AI } from '../src/config';
import { describe, expect, it } from 'vitest';
import { Athlete } from '../src/game/athlete';
import { Simulation } from '../src/game/simulation';
import { SLOT_ROLE, SLOTS, TeamAI, USER_SLOT } from '../src/ai/team';
import type { V3 } from '../src/physics/ball';
import { solveApex } from '../src/physics/solve';
import { NO_HOOKS } from './simHooks';

/**
 * Our team on a real simulation, you the outside. A ball off their block (`side` -1; 1: off ours,
 * touched by our middle) drops at `at`, `apex` m above where it left the hands (low: down fast;
 * high: time to get there).
 */
function offTheirBlock(at: V3, apex: number, side: 1 | -1 = -1) {
  const sim = new Simulation(NO_HOOKS);
  sim.ballLive = true;
  const us = new TeamAI(1, sim, AI);
  const them = new TeamAI(-1, sim, AI);
  us.opponents = them;
  them.opponents = us;
  for (const slot of SLOTS) {
    const mine = slot === USER_SLOT.OH;
    const a = new Athlete(SLOT_ROLE[slot], 1);
    if (mine) {
      a.isUser = true;
      sim.me = a;
    }
    us.add(slot, a, mine);
    const b = new Athlete(SLOT_ROLE[slot], -1);
    them.add(slot, b, false);
    sim.athletes.push(a, b);
  }
  us.place('defense');
  them.place('defense');
  const from = { x: at.x + 0.2, y: 3.0, z: 0.3 };
  const v = { x: 0, y: 0, z: 0 };
  solveApex(from, at, from.y + apex, { x: 0, y: 0, z: 0 }, v);
  sim.ball.launch(from, v);
  const blocker = (side === 1 ? us : them).players.get('MB')!;
  sim.ball.lastTouch = { athlete: blocker, kind: 'block', t: 0, side };
  /** the game's frame: both teams decide, then the simulation steps, until someone plays the ball (or it is down) */
  const play = () => {
    for (let i = 0; i < 4 * 120; i++) {
      us.step();
      them.step();
      sim.step(1 / 120);
      const lt = sim.ball.lastTouch;
      if (lt && lt.kind !== 'block') return lt.athlete;
      if (!sim.ball.active || sim.ball.pos.y < 0.15) return null;
    }
    return null;
  };
  return { sim, us, them, me: sim.me, play };
}

/** a team-mate just up to block (or hit) at the net, beside where the ball comes down */
function upAtTheNet(a: Athlete, x: number, z: number) {
  a.place(x, z, 0);
  a.state = 'air';
  a.pos.y = 0.8;
  a.vel.set(0, 1.5, 0);
}

describe('"your ball" off the block goes to who gets there', () => {
  const AT = { x: -1.2, y: 0.75, z: 1.4 };

  it('a ball nobody gets to in time is not called yours from 3 m away, with the two players up at the net beside it', () => {
    const { us, me } = offTheirBlock(AT, 0.05);
    me.place(AT.x, AT.z + 3, 0);
    upAtTheNet(us.players.get('OPP')!, -1.0, 0.8);
    upAtTheNet(us.players.get('MB')!, -0.4, 0.8);
    us.step();
    expect(us.receiver).not.toBe(me);
    expect(us.receiver?.role).toBe('OPP');
  });

  it('a ball you get to as soon as a team-mate does (a seam) is still yours', () => {
    // a soft one, up high: time for both of you; you and the opposite the same distance away
    const { us, me } = offTheirBlock({ x: -1.5, y: 0.75, z: 3.0 }, 1.6);
    // (each 1.6 m from where it is played: 0.4 m on the net side of where it drops)
    me.place(-1.5, 4.2, 0);
    us.players.get('OPP')!.place(-1.5, 1.0, 0);
    // (the libero takes any ball off a block it gets to: here it is across the court)
    us.players.get('L')!.place(4.0, 8.5, 0);
    us.step();
    expect(us.receiver?.role).toBe(me.role);
    expect(us.receiver).toBe(me);
  });
});

describe("a ball off a block the libero gets to is the libero's (Mini Rally)", () => {
  // a soft block dropping 2 m off the net on our left, you (the outside) just down from the block
  // beside it; the libero at its base spot, left back, 4 m away
  const AT = { x: -1.6, y: 0.75, z: 2.6 };
  const soft = (apex: number, side: 1 | -1) => {
    const t = offTheirBlock(AT, apex, side);
    t.me.place(-2.6, 0.8, 0);
    t.us.step();
    return {
      ...t,
      touch: t.sim.ball.lastTouch,
      L: t.us.players.get('L')!,
      down: t.sim.ball.ensurePrediction(t.sim.env, 0).descendThrough(0.75, 0),
    };
  };

  for (const side of [1, -1] as const) {
    const whose = side === 1 ? 'our' : 'their';
    it(`off ${whose} block: one the libero gets its platform to in time is the libero's, with you nearer, and it plays it`, () => {
      const { us, me, L, down, play, touch } = soft(0.6, side);
      // it can't get its feet under the ball in time, but its platform gets there: a defender digs a
      // ball within AI.digReach of its feet
      expect(us.reachTime(L, AT)).toBeGreaterThan(down);
      expect(us.reachTime(me, AT)).toBeLessThan(down);
      expect(us.receiver).toBe(L);
      // and it calls you off it
      expect(us.liberoCall).toBe(touch);
      expect(play()).toBe(L);
    });

    it(`off ${whose} block: one the libero could only dive for is yours`, () => {
      const { us, me } = soft(0, side);
      expect(us.receiver).toBe(me);
      expect(us.liberoCall).toBeNull();
    });
  }
});

describe('their first ball is theirs (Mini Rally)', () => {
  it('a tight pass to their setter is never called ours, not even the frame before they count it', () => {
    const { sim, us, them } = offTheirBlock({ x: -0.5, y: 0.75, z: 2 }, 1);
    // their libero passes our tip up to their setter, tight: left alone it would drop just over the net
    const L = them.players.get('L')!;
    const from = { x: -1, y: 0.8, z: -6 };
    const v = { x: 0, y: 0, z: 0 };
    solveApex(from, { x: -1.1, y: 2.4, z: -0.6 }, 4.4, { x: 0, y: 0, z: 0 }, v);
    sim.ball.launch(from, v);
    sim.ball.lastTouch = { athlete: L, kind: 'pass', t: sim.simTime, side: -1 };
    const pred = sim.ball.ensurePrediction(sim.env, sim.simTime);
    const p = { x: 0, y: 0, z: 0 };
    pred.posAt(pred.descendThrough(0.75, sim.simTime), p);
    expect(p.z).toBeGreaterThan(0.05);
    // as in the game, we step before them
    us.step();
    expect(us.receiver).toBeNull();
    expect(us.liberoCall).toBeNull();
    them.step();
    us.step();
    expect(us.receiver).toBeNull();
  });
});
