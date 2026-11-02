import type { PositionId } from '../config';
import type { Athlete } from './athlete';
import type { SetOption } from './contact';

/**
 * Where each position attacks from and where it starts its approach, for the
 * home side (+z). Mirror x and z for the far side. x: left (-) / right (+)
 * from the home team's view facing the net.
 */
export interface AttackLane {
  /** ball target xz at contact */
  x: number;
  z: number;
  /** apex of the set, metres above the contact height */
  apexAbove: number;
  /** approach start */
  sx: number;
  sz: number;
  label: string;
}

export const LANES: Record<PositionId, AttackLane> = {
  OH: { x: -3.45, z: 1.0, apexAbove: 1.35, sx: -4.35, sz: 4.6, label: 'Outside high ball (4)' },
  OPP: { x: 3.4, z: 1.0, apexAbove: 1.35, sx: 4.1, sz: 3.9, label: 'Opposite back set (red)' },
  MB: { x: 0.25, z: 0.8, apexAbove: 0.85, sx: 0.35, sz: 2.7, label: 'Middle quick (2)' },
  S: { x: 1.05, z: 0.55, apexAbove: 0.75, sx: 1.2, sz: 1.3, label: 'Setter attack on two' },
  L: { x: -0.4, z: 3.75, apexAbove: 1.2, sx: -0.4, sz: 7.3, label: 'Back-row pipe' },
};

/** the setter's home spot (right of centre, close to the net) */
export const SETTER_SPOT = { x: 1.1, z: 0.65 };
/** target for passes / free balls: where the setter wants the ball */
export const SETTER_TARGET = { x: 1.0, z: 0.9, height: 3.6 };

export function laneFor(pos: PositionId, side: 1 | -1): AttackLane {
  const l = LANES[pos];
  return { ...l, x: l.x * side, z: l.z * side, sx: l.sx * side, sz: l.sz * side };
}

/** height of the ball centre at the top of a good approach jump */
export function attackHeight(a: Athlete): number {
  return a.standReach - 0.16 + a.jumpMax * 0.95;
}

/** a typical hitter's contact height when no specific hitter is known */
export const GENERIC_ATTACK_HEIGHT = 3.15;

export function defaultPassTarget(a: Athlete): { x: number; y: number; z: number; apex: number } {
  const s = a.side;
  return { x: SETTER_TARGET.x * s, y: 2.35, z: SETTER_TARGET.z * s, apex: 4.1 };
}

/** front-row options for a setter on `a`'s side: outside, middle quick, opposite */
export function defaultSetOptions(a: Athlete, hitters: Partial<Record<'OH' | 'MB' | 'OPP', Athlete | null>> = {}): SetOption[] {
  const s = a.side;
  const mk = (pos: 'OH' | 'MB' | 'OPP', label: string): SetOption => {
    const l = laneFor(pos, s);
    const hitter = hitters[pos] ?? null;
    const y = hitter ? attackHeight(hitter) : GENERIC_ATTACK_HEIGHT;
    return { target: { x: l.x, y, z: l.z }, apex: y + l.apexAbove, hitter, label };
  };
  return [mk('OH', 'Outside'), mk('MB', 'Quick'), mk('OPP', 'Back set')];
}
