import { BALL } from '../config';
import { aeroAccel, makeBall, R, type BallState, type V3 } from './ball';

/**
 * Trajectory solvers. They integrate the aerodynamic model only (no
 * collisions) with the same semi-implicit Euler as the live sim, then let the
 * real simulation decide whether the net gets in the way.
 */
const H = 1 / 240;
const tmp: BallState = makeBall();
const acc: V3 = { x: 0, y: 0, z: 0 };

function launch(p0: V3, v0: V3, w0: V3, knuckle = 0): BallState {
  tmp.p.x = p0.x;
  tmp.p.y = p0.y;
  tmp.p.z = p0.z;
  tmp.v.x = v0.x;
  tmp.v.y = v0.y;
  tmp.v.z = v0.z;
  tmp.w.x = w0.x;
  tmp.w.y = w0.y;
  tmp.w.z = w0.z;
  tmp.knuckle = knuckle;
  tmp.kt = 0;
  tmp.rest = false;
  return tmp;
}

function freeStep(s: BallState, h: number): void {
  aeroAccel(s, acc);
  s.v.x += acc.x * h;
  s.v.y += acc.y * h;
  s.v.z += acc.z * h;
  s.p.x += s.v.x * h;
  s.p.y += s.v.y * h;
  s.p.z += s.v.z * h;
  const d = Math.exp(-h / BALL.spinDecayTime);
  s.w.x *= d;
  s.w.y *= d;
  s.w.z *= d;
}

/** fly for exactly T seconds (no collisions); returns final position into out, and max height */
export function flyFor(p0: V3, v0: V3, w0: V3, T: number, out: V3): number {
  const s = launch(p0, v0, w0);
  let t = 0;
  let maxY = s.p.y;
  while (t < T - 1e-12) {
    const h = Math.min(H, T - t);
    freeStep(s, h);
    t += h;
    if (s.p.y > maxY) maxY = s.p.y;
  }
  out.x = s.p.x;
  out.y = s.p.y;
  out.z = s.p.z;
  return maxY;
}

/** a fixed-speed topspin shot's flights at many elevations (see shotFan) */
export interface ShotFan {
  /** elevations (rad), increasing */
  angles: number[];
  /** horizontal distance to the floor (ball at radius height) for each */
  range: number[];
  /** each flight every `dt`: horizontal distance and height, until it comes down to the floor */
  paths: { s: number[]; y: number[] }[];
  dt: number;
}

/**
 * A fixed-speed topspin shot struck from height `y0`, at `n` elevations from `minAngle` to
 * `maxAngle`: each flight in its own vertical plane (drag and the topspin's Magnus force stay
 * in it), so one fan serves every direction. For planners that weigh many targets at one
 * speed: look the elevation up by range instead of solving each target.
 */
export function shotFan(y0: number, speed: number, spinRate: number, n = 80, minAngle = -1.35, maxAngle = 0.62): ShotFan {
  const fan: ShotFan = { angles: [], range: [], paths: [], dt: H };
  const p0 = { x: 0, y: y0, z: 0 };
  const w0 = { x: spinRate, y: 0, z: 0 };
  for (let i = 0; i < n; i++) {
    const th = minAngle + ((maxAngle - minAngle) * i) / (n - 1);
    const s = launch(p0, { x: 0, y: Math.sin(th) * speed, z: Math.cos(th) * speed }, w0);
    const path = { s: [0], y: [y0] };
    let t = 0;
    while (s.p.y > R && t < 4) {
      freeStep(s, H);
      t += H;
      path.s.push(s.p.z);
      path.y.push(s.p.y);
    }
    fan.angles.push(th);
    fan.range.push(s.p.z);
    fan.paths.push(path);
  }
  return fan;
}

/** fly until the ball descends to height y (or maxT). Returns time, position into out. */
export function flyUntilY(p0: V3, v0: V3, w0: V3, y: number, out: V3, maxT = 4): number {
  const s = launch(p0, v0, w0);
  let t = 0;
  while (t < maxT) {
    const py = s.p.y;
    const px = s.p.x;
    const pz = s.p.z;
    freeStep(s, H);
    t += H;
    if (s.v.y < 0 && s.p.y <= y) {
      const f = (py - y) / (py - s.p.y || 1);
      out.x = px + (s.p.x - px) * f;
      out.y = y;
      out.z = pz + (s.p.z - pz) * f;
      return t - H + f * H;
    }
  }
  out.x = s.p.x;
  out.y = s.p.y;
  out.z = s.p.z;
  return maxT;
}

/** initial velocity so the ball is at `target` exactly T seconds after leaving p0 */
export function solveFixedTime(p0: V3, target: V3, T: number, w0: V3, out: V3, iterations = 12): V3 {
  const g = BALL.gravity;
  out.x = (target.x - p0.x) / T;
  out.y = (target.y - p0.y) / T + 0.5 * g * T;
  out.z = (target.z - p0.z) / T;
  const end: V3 = { x: 0, y: 0, z: 0 };
  for (let i = 0; i < iterations; i++) {
    flyFor(p0, out, w0, T, end);
    const ex = end.x - target.x;
    const ey = end.y - target.y;
    const ez = end.z - target.z;
    if (ex * ex + ey * ey + ez * ez < 1e-6) break;
    out.x -= ex / T;
    out.y -= ey / T;
    out.z -= ez / T;
  }
  return out;
}

/**
 * Initial velocity for an arc from p0 through `target` whose apex is at
 * height `apexY` (target must be on the descending branch).
 */
export function solveApex(p0: V3, target: V3, apexY: number, w0: V3, out: V3): { T: number; apex: number } {
  const g = BALL.gravity;
  const top = Math.max(apexY, p0.y + 0.05, target.y + 0.05);
  const tUp = Math.sqrt((2 * (top - p0.y)) / g);
  const tDown = Math.sqrt((2 * (top - target.y)) / g);
  let T0 = tUp + tDown;
  const end: V3 = { x: 0, y: 0, z: 0 };
  const apexFor = (T: number) => {
    solveFixedTime(p0, target, T, w0, out);
    return flyFor(p0, out, w0, T, end);
  };
  let a0 = apexFor(T0) - top;
  let T1 = T0 * 1.04;
  let a1 = apexFor(T1) - top;
  for (let i = 0; i < 6 && Math.abs(a1) > 0.005; i++) {
    const denom = a1 - a0;
    if (Math.abs(denom) < 1e-9) break;
    const T2 = Math.max(0.15, T1 - (a1 * (T1 - T0)) / denom);
    T0 = T1;
    a0 = a1;
    T1 = T2;
    a1 = apexFor(T1) - top;
  }
  return { T: T1, apex: a1 + top };
}

/**
 * Fixed-speed shot (spike/serve): find the elevation angle so the ball lands
 * at the target floor point. Returns the velocity into `out` and the landing
 * point into `land`. If the target is out of range the closest angle is used.
 */
export function solveSpeedToFloor(
  p0: V3,
  targetX: number,
  targetZ: number,
  speed: number,
  spinRate: number,
  out: V3,
  w: V3,
  land: V3,
  minAngle = -1.35,
  maxAngle = 0.62,
): number {
  const dx = targetX - p0.x;
  const dz = targetZ - p0.z;
  const dist = Math.hypot(dx, dz) || 1e-6;
  const ux = dx / dist;
  const uz = dz / dist;
  // topspin about (up x dir)
  w.x = uz * spinRate;
  w.y = 0;
  w.z = -ux * spinRate;
  const rangeAt = (th: number) => {
    out.x = Math.cos(th) * ux * speed;
    out.y = Math.sin(th) * speed;
    out.z = Math.cos(th) * uz * speed;
    flyUntilY(p0, out, w, R, land, 5);
    return (land.x - p0.x) * ux + (land.z - p0.z) * uz;
  };
  let lo = minAngle;
  let hi = maxAngle;
  if (rangeAt(lo) >= dist) {
    rangeAt(lo);
    return lo;
  }
  if (rangeAt(hi) <= dist) {
    rangeAt(hi);
    return hi;
  }
  for (let i = 0; i < 26; i++) {
    const mid = (lo + hi) / 2;
    if (rangeAt(mid) < dist) lo = mid;
    else hi = mid;
  }
  const th = (lo + hi) / 2;
  rangeAt(th);
  return th;
}

/** minimal y the ball has while crossing z = 0 for a free flight (or null if never crosses) */
export function netClearance(p0: V3, v0: V3, w0: V3): { y: number; x: number } | null {
  const s = launch(p0, v0, w0);
  let t = 0;
  while (t < 4) {
    const pz = s.p.z;
    const py = s.p.y;
    const px = s.p.x;
    freeStep(s, H);
    t += H;
    if (Math.sign(pz) !== Math.sign(s.p.z) && pz !== 0) {
      const f = pz / (pz - s.p.z);
      return { y: py + (s.p.y - py) * f, x: px + (s.p.x - px) * f };
    }
    if (s.p.y < R) return null;
  }
  return null;
}
