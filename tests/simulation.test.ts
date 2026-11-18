import { describe, expect, it } from 'vitest';
import { SIM } from '../src/config';
import { SLOT_ROLE, SLOTS, TeamAI } from '../src/ai/team';
import { Athlete } from '../src/game/athlete';
import { Simulation } from '../src/game/simulation';
import { solveApex } from '../src/physics/solve';
import { NO_HOOKS } from './simHooks';

// The simulation runs on its own (docs/adr/0010): these tests build a real one, with real brains,
// a real ball and the real contact system, in Node. There is no page, no canvas and no renderer.

const DT = 1 / SIM.hz;

/** six brains on the home side, and a free ball coming over the net to them */
function freeBallToATeam(seed: number) {
  const log: string[] = [];
  const sim = new Simulation({
    ...NO_HOOKS,
    contact: (ev) => log.push(`${sim.simTime.toFixed(4)} ${ev.athlete.role} ${ev.kind} ${ev.grade}`),
    aiContact: (a, kind) => log.push(`${sim.simTime.toFixed(4)} ${a.role} ${kind}`),
    ballEvent: (e) => log.push(`${sim.simTime.toFixed(4)} ball ${e.kind}`),
  });
  sim.rng.reseed(seed);
  sim.ballLive = true;
  const team = new TeamAI(1, sim);
  for (const slot of SLOTS) {
    const a = new Athlete(SLOT_ROLE[slot], 1);
    sim.athletes.push(a);
    team.add(slot, a, false);
  }
  team.place('defense');
  // the player's athlete stands off the court: the step needs one, and here it only watches
  sim.me = new Athlete('OH', 1);
  sim.me.isUser = true;
  sim.me.place(-7, 11, 0);
  sim.drill = { step: () => team.step(), onOutcome: () => {} };
  const from = { x: 1, y: 2.2, z: -4 };
  const v = { x: 0, y: 0, z: 0 };
  solveApex(from, { x: -0.5, y: 1, z: 5 }, 5, { x: 0, y: 0, z: 0 }, v);
  sim.ball.launch(from, v);
  sim.ball.lastTouch = { athlete: null, kind: 'free', t: 0, side: -1 };
  return { sim, team, log };
}

function play(seed: number, seconds: number) {
  const r = freeBallToATeam(seed);
  const path: number[] = [];
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    r.sim.step(DT);
    const p = r.sim.ball.state.p;
    path.push(p.x, p.y, p.z);
    for (const a of r.sim.athletes) path.push(a.pos.x, a.pos.y, a.pos.z);
  }
  return { ...r, path };
}

describe('the simulation runs on its own', () => {
  it('is built and stepped with no page and no renderer: the clock moves one fixed step at a time', () => {
    const { sim } = freeBallToATeam(1);
    for (let i = 0; i < 120; i++) sim.step(DT);
    expect(sim.simTime).toBeCloseTo(1, 9);
    expect(sim.ball.active).toBe(true);
  });

  it('brains running in it play a free ball: someone gets under it and the team touches it before it lands', () => {
    const { log, sim } = play(1, 6);
    const touches = log.filter((l) => !l.includes(' ball '));
    expect(touches.length, log.join('\n')).toBeGreaterThan(0);
    const firstTouch = Number(touches[0].split(' ')[0]);
    const firstBounce = log.find((l) => l.includes('ball floor'));
    if (firstBounce) expect(firstTouch).toBeLessThan(Number(firstBounce.split(' ')[0]));
    expect(sim.simTime).toBeCloseTo(6, 6);
  });

  it('the same start gives the same play, step for step: every position of the ball and of every athlete', () => {
    const a = play(7, 6);
    const b = play(7, 6);
    expect(a.log).toEqual(b.log);
    expect(a.path).toEqual(b.path);
  });

  it('a different random seed gives a different play: the brains draw their reads from the simulation’s own stream', () => {
    const a = play(7, 6);
    const b = play(8, 6);
    expect(a.path).not.toEqual(b.path);
  });
});
