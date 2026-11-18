import type { SimulationHooks } from '../src/game/simulation';

/**
 * A simulation with nobody watching: no camera to aim with, no aim assist, and nobody told of a
 * touch, a bounce or the end of a rally. A test that wants to hear of one passes its own hook.
 */
export const NO_HOOKS: SimulationHooks = {
  aimAssist: () => 0,
  aimTargetFor: (_a, out) => out,
  userAimYaw: () => 0,
  contact: () => {},
  aiContact: () => {},
  ballEvent: () => {},
  floatBreak: () => {},
  outcome: () => {},
};
