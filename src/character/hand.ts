/**
 * The hand's layout, shared by the skeleton (rig.ts) and the surface (sculpt.ts). In the hand's
 * own frame at rest the fingers run along -y, the thumb points forward (-z) and the palm faces
 * the body. Every length is a fraction of standing height.
 */

export const DIGITS = ['index', 'middle', 'ring', 'little', 'thumb'] as const;
export type Digit = (typeof DIGITS)[number];

/**
 * The four fingers, from the thumb's side out: where each leaves the knuckle line (z), its length
 * and thickness, and how much of the hand's spread it takes (+ fans towards the thumb, - away).
 * The longest ends inside `RigDims.hand` (the reach the game is built on), which they do not change.
 */
export const FINGERS = [
  { name: 'index', z: -0.0162, len: 0.045, r: 0.0052, fan: 1 },
  { name: 'middle', z: -0.0054, len: 0.05, r: 0.0054, fan: 0.3 },
  { name: 'ring', z: 0.0054, len: 0.046, r: 0.005, fan: -0.4 },
  { name: 'little', z: 0.0158, len: 0.036, r: 0.0044, fan: -1 },
] as const;

/** a finger's surface starts this far above the knuckle line (inside the palm), and bends this far along its length */
export const FINGER_ROOT = 0.004;
export const FINGER_JOINT = 0.5;

/** thumb: thickness along its length; it bends at the ring `THUMB_JOINT` */
export const THUMB_RADII = [0.0078, 0.0076, 0.0072, 0.0068, 0.0064, 0.006, 0.004];
export const THUMB_JOINT = 3;

/**
 * The thumb's centre line at rest, for the hand on side `s` (-1 left, +1 right): from the heel of
 * the palm, down along the hand and forward, the tip turning back towards the fingers. Each entry
 * is a point and the direction the thumb runs there.
 */
export function thumbPath(s: number): { p: [number, number, number]; d: [number, number, number] }[] {
  const out: { p: [number, number, number]; d: [number, number, number] }[] = [];
  const p: [number, number, number] = [-s * 0.002, -0.014, -0.017];
  const norm = (v: [number, number, number]): [number, number, number] => {
    const l = Math.hypot(v[0], v[1], v[2]);
    return [v[0] / l, v[1] / l, v[2] / l];
  };
  let d = norm([-s * 0.28, -0.8, -0.53]);
  for (let k = 0; k < THUMB_RADII.length; k++) {
    out.push({ p: [p[0], p[1], p[2]], d: [d[0], d[1], d[2]] });
    const step = k >= THUMB_RADII.length - 2 ? 0.003 : 0.0062;
    p[0] += d[0] * step;
    p[1] += d[1] * step;
    p[2] += d[2] * step;
    d = norm([d[0] - s * 0.05, d[1] - 0.08, d[2] + 0.06]);
  }
  return out;
}
