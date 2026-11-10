import { POSITIONS, type PositionId } from '../config';
import { resolveBody, topSpikeKmh, type Bodies } from '../game/body';

/**
 * The four stat bars on a position card. Each is written in its real unit and coloured by
 * how it compares: the colour is a second cue, the number is the fact.
 */

/** the top of each bar's scale */
export const STAT_MAX = { jump: 0.95, speed: 5.8, power: 1.1, control: 1 };
/** a stat at or above this share of its scale reads as strong */
export const STAT_STRONG = 0.85;

/** best: the highest of the five positions. strong: STAT_STRONG of the scale or more. base: below it. */
export type StatTier = 'best' | 'strong' | 'base';

export interface StatRow {
  label: string;
  /** the value in its real unit */
  value: string;
  /** 0..1 of the bar */
  frac: number;
  tier: StatTier;
}

const POSITION_IDS = Object.keys(POSITIONS) as PositionId[];
const EPS = 1e-6;

/** the four fractions (jump, speed, power, control) a position plays with, custom body applied */
function fractions(id: PositionId, bodies: Bodies): number[] {
  const p = POSITIONS[id];
  const b = resolveBody(id, bodies[id]);
  return [b.jump / STAT_MAX.jump, p.approachSpeed / STAT_MAX.speed, b.power / STAT_MAX.power, p.ballControl / STAT_MAX.control];
}

/** the stat rows of every position, with the player's custom bodies applied */
export function athleteStats(bodies: Bodies): Record<PositionId, StatRow[]> {
  const all = POSITION_IDS.map((id) => fractions(id, bodies));
  const best = [0, 1, 2, 3].map((i) => Math.max(...all.map((f) => f[i])));
  const out = {} as Record<PositionId, StatRow[]>;
  POSITION_IDS.forEach((id, n) => {
    const p = POSITIONS[id];
    const b = resolveBody(id, bodies[id]);
    const values = [
      `${Math.round(b.jump * 100)} cm`,
      `${p.approachSpeed.toFixed(1)} m/s`,
      `${Math.round(topSpikeKmh(b.power))} km/h`,
      `${Math.round(p.ballControl * 100)}`,
    ];
    out[id] = ['Jump', 'Speed', 'Power', 'Control'].map((label, i) => {
      const f = all[n][i];
      const tier: StatTier = f >= best[i] - EPS ? 'best' : f >= STAT_STRONG ? 'strong' : 'base';
      return { label, value: values[i], frac: Math.min(1, Math.max(0, f)), tier };
    });
  });
  return out;
}
