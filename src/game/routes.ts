import { isQuick, needsGoodPass, type SetPlay } from './plays';
import { hitX, type SetterKey } from './setterCalls';

/**
 * Your routes as a hitter (keys 1-5), as the route strip and the route panel show them: what each
 * one is on court (its tempo, where along the net it is hit, where the run starts) and the play your
 * setter has called. The words are the ones players use: a high ball is third tempo, a go or a 3 ball
 * second (running as the setter touches it), a quick first (in the air as the setter touches it).
 */

/** how fast a route's set is, by when the hitter goes */
export type RouteTempo = 'high' | 'medium' | 'fast' | 'quick';

/** the play our AI setter has called (TeamAI.playView), with your route in it */
export interface TeamPlayView {
  name: string;
  idea: string;
  calls: Record<SetterKey, string>;
  /** signalled before the serve (waits for a perfect pass), running, or off for this ball */
  state: 'signalled' | 'running' | 'off';
}

export interface RouteView {
  position: 'OH' | 'MB' | 'OPP';
  plays: readonly SetPlay[];
  /** the route you are calling (an index into `plays`) */
  on: number;
  /** the play your setter has called, if any */
  play: TeamPlayView | null;
  /** the setter called this pass out of system: every set goes up high */
  high: boolean;
}

/** a route's tempo: a quick is first tempo, anything flatter than a hut second, a hut between, the rest a high ball */
export function routeTempo(p: SetPlay): RouteTempo {
  if (isQuick(p)) return 'quick';
  if (needsGoodPass(p)) return 'fast';
  return p.lane.apexAbove < 1.4 ? 'medium' : 'high';
}

/** a route as drawn on the home side's court (+z, facing the net): where the run starts and where the ball is hit */
export function routeLine(p: SetPlay): { sx: number; sz: number; x: number; z: number } {
  return { sx: p.lane.sx, sz: p.lane.sz, x: hitX(p), z: p.lane.z };
}
