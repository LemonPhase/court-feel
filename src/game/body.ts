import { BODY, CONTACT, POSITIONS, type BodyOverride, type PositionId, type PositionStats } from '../config';
import { standingReach } from '../character/rig';
import { clamp } from '../core/mathx';

/**
 * The user's custom body: a position's height, vertical (approach) jump and
 * spike power, overridden from the settings. Everything else about the
 * position (speed, ball control, standing-jump fraction) stays as it is.
 */

export type CustomBody = Partial<BodyOverride> | null | undefined;
export type Bodies = Partial<Record<PositionId, BodyOverride>>;

const EPS = 1e-4;

function num(v: unknown, lim: { min: number; max: number }, def: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? clamp(v, lim.min, lim.max) : def;
}

/** height / jump / power a position plays with: its defaults, with any custom values applied (clamped to BODY) */
export function resolveBody(role: PositionId, custom?: CustomBody): BodyOverride {
  const p = POSITIONS[role];
  const c = custom && typeof custom === 'object' ? custom : {};
  return {
    height: num(c.height, BODY.height, p.height),
    jump: num(c.jump, BODY.jump, p.jump),
    power: num(c.power, BODY.power, p.power),
  };
}

/** does this custom body differ from the position's defaults? */
export function isCustomBody(role: PositionId, custom?: CustomBody): boolean {
  const p = POSITIONS[role];
  const b = resolveBody(role, custom);
  return Math.abs(b.height - p.height) > EPS || Math.abs(b.jump - p.jump) > EPS || Math.abs(b.power - p.power) > EPS;
}

/** position stats with the custom body applied (the shared defaults object when nothing is customised) */
export function bodyStats(role: PositionId, custom?: CustomBody): PositionStats {
  const p = POSITIONS[role];
  if (!isCustomBody(role, custom)) return p;
  const b = resolveBody(role, custom);
  return { ...p, height: b.height, jump: b.jump, power: b.power };
}

/** a stored bodies map made safe: known positions only, finite and clamped, defaults dropped */
export function sanitizeBodies(raw: unknown): Bodies {
  const out: Bodies = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const id of Object.keys(POSITIONS) as PositionId[]) {
    const c = (raw as Record<string, unknown>)[id];
    if (c && typeof c === 'object' && isCustomBody(id, c as CustomBody)) out[id] = resolveBody(id, c as CustomBody);
  }
  return out;
}

/** set one value of a position's custom body; the entry is dropped once it is back to the defaults */
export function setBodyValue(bodies: Bodies, role: PositionId, key: keyof BodyOverride, value: number): void {
  const b = resolveBody(role, bodies[role]);
  b[key] = value;
  if (isCustomBody(role, b)) bodies[role] = resolveBody(role, b);
  else delete bodies[role];
}

/** highest point of the hand at the top of a full approach jump (standing reach + vert) */
export function spikeReach(b: { height: number; jump: number }): number {
  return standingReach(b.height) + b.jump;
}

/** ball speed (km/h) of a Perfect, full-power spike met at the top of the jump */
export function topSpikeKmh(power: number): number {
  return CONTACT.spikePerfect * power * 3.6;
}
