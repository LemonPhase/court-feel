import { AI } from '../src/config';
import { SLOT_ROLE, SLOTS, TeamAI } from '../src/ai/team';
import { Athlete } from '../src/game/athlete';
import { Simulation } from '../src/game/simulation';
import { solveApex } from '../src/physics/solve';
import { NO_HOOKS } from './simHooks';

/** six brains on the home side, and a free ball coming over the net to them */
export function freeBallToATeam(seed: number) {
  const log: string[] = [];
  const sim = new Simulation({
    ...NO_HOOKS,
    contact: (ev) => log.push(`${sim.simTime.toFixed(4)} ${ev.athlete.role} ${ev.kind} ${ev.grade}`),
    aiContact: (a, kind) => log.push(`${sim.simTime.toFixed(4)} ${a.role} ${kind}`),
    ballEvent: (e) => log.push(`${sim.simTime.toFixed(4)} ball ${e.kind}`),
  });
  sim.rng.reseed(seed);
  sim.ballLive = true;
  const team = new TeamAI(1, sim, AI);
  for (const slot of SLOTS) {
    const a = new Athlete(SLOT_ROLE[slot], 1);
    sim.athletes.push(a);
    team.add(slot, a, false);
  }
  team.place('defense');
  // a player's athlete stands off the court and only watches
  sim.me = new Athlete('OH', 1);
  sim.me.place(-7, 11, 0);
  sim.drill = { step: () => team.step(), onOutcome: () => {} };
  const from = { x: 1, y: 2.2, z: -4 };
  const v = { x: 0, y: 0, z: 0 };
  solveApex(from, { x: -0.5, y: 1, z: 5 }, 5, { x: 0, y: 0, z: 0 }, v);
  sim.ball.launch(from, v);
  sim.ball.lastTouch = { athlete: null, kind: 'free', t: 0, side: -1 };
  return { sim, team, log };
}
