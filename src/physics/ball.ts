import { BALL, COURT } from '../config';

/**
 * Deterministic volleyball physics. Pure math on plain objects (no three.js)
 * so it runs identically in the game, the predictor, the solvers and tests.
 *
 * Forces: gravity, quadratic drag, Magnus lift (w x v), optional "float"
 * knuckle wobble. Collisions: floor (restitution + friction/spin coupling),
 * net body (a soft mesh the ball sinks into), top tape (cable: stiff from above, gives sideways), antennae, posts (+pads), LED
 * boards, walls and ceiling. Fast balls are sub-stepped so they never tunnel.
 */

export interface V3 {
  x: number;
  y: number;
  z: number;
}

export interface BallState {
  p: V3;
  v: V3;
  /** angular velocity (rad/s) */
  w: V3;
  /**
   * The float (`BALL.float`): how cleanly the ball was hit without spin, 0 (it does not float) to
   * 1, the clock since that hit (s), and the draw that decides which way and when it breaks
   */
  knuckle: number;
  kt: number;
  seed: number;
  /** ball resting / dead (no integration) */
  rest: boolean;
}

export interface BallEnv {
  netTop: number;
  /** height the ball is stopped at (m). Absent: the hall's `COURT.ceiling`. null: open sky, nothing stops it. */
  ceiling?: number | null;
}

export type CollisionKind = 'floor' | 'net' | 'tape' | 'antenna' | 'post' | 'board' | 'wall' | 'ceiling';

export interface CollisionEvent {
  kind: CollisionKind;
  x: number;
  y: number;
  z: number;
  /** impact speed along the contact normal */
  impact: number;
}

export const R = BALL.radius;
const AREA = Math.PI * R * R;
export const K_DRAG = (0.5 * BALL.airDensity * BALL.dragCoefficient * AREA) / BALL.mass;
export const K_MAGNUS = ((0.5 * BALL.airDensity * AREA * R) / BALL.mass) * BALL.magnusScale;
/** side force per unit coefficient and v^2 (the float) */
const K_SIDE = (0.5 * BALL.airDensity * AREA) / BALL.mass;
/** hollow sphere: I = 2/3 m r^2 */
const INV_I_TERM = (R * R) / ((2 / 3) * R * R); // r^2 * m / I  = 1.5

export const BOARD_X = COURT.halfWidth + COURT.freeZoneSide + 0.6;
export const BOARD_Z = COURT.halfLength + COURT.freeZoneEnd + 0.6;
export const BOARD_H = 0.9;
const PAD_R = 0.16;
const PAD_H = 1.9;
const POST_H = 2.6;

export function makeBall(): BallState {
  return { p: { x: 0, y: 1, z: 0 }, v: { x: 0, y: 0, z: 0 }, w: { x: 0, y: 0, z: 0 }, knuckle: 0, kt: 0, seed: 0, rest: false };
}

export function copyBall(src: BallState, dst: BallState): BallState {
  dst.p.x = src.p.x;
  dst.p.y = src.p.y;
  dst.p.z = src.p.z;
  dst.v.x = src.v.x;
  dst.v.y = src.v.y;
  dst.v.z = src.v.z;
  dst.w.x = src.w.x;
  dst.w.y = src.w.y;
  dst.w.z = src.w.z;
  dst.knuckle = src.knuckle;
  dst.kt = src.kt;
  dst.seed = src.seed;
  dst.rest = src.rest;
  return dst;
}

export function ballSpeed(s: BallState): number {
  return Math.hypot(s.v.x, s.v.y, s.v.z);
}

/** aerodynamic acceleration into out */
export function aeroAccel(s: BallState, out: V3): V3 {
  const { v, w } = s;
  const sp = Math.hypot(v.x, v.y, v.z);
  out.x = -K_DRAG * sp * v.x;
  out.y = -K_DRAG * sp * v.y - BALL.gravity;
  out.z = -K_DRAG * sp * v.z;
  // Magnus: k (w x v), with the lift coefficient capped (Cl <= 0.4)
  const wm = Math.hypot(w.x, w.y, w.z);
  if (wm > 1e-6 && sp > 1e-3) {
    let k = K_MAGNUS;
    const spinRatio = (R * wm) / sp;
    if (spinRatio > 0.4) k *= 0.4 / spinRatio;
    out.x += k * (w.y * v.z - w.z * v.y);
    out.y += k * (w.z * v.x - w.x * v.z);
    out.z += k * (w.x * v.y - w.y * v.x);
  }
  if (s.knuckle > 0 && sp > BALL.float.speedLo) floatAccel(s, sp, out);
  return out;
}

/** 0..1, eased */
function smooth01(x: number): number {
  const t = x < 0 ? 0 : x > 1 ? 1 : x;
  return t * t * (3 - 2 * t);
}

/** a number in 0..1 for the k-th draw of a float's seed: the same every time it is asked */
function draw(seed: number, k: number): number {
  const x = Math.sin(seed * 127.1 + k * 311.7 + 0.5) * 43758.5453;
  return x - Math.floor(x);
}

const _push = { lat: 0, up: 0 };

/** the k-th push of a float: sideways and up, each -1..1 */
function floatPush(seed: number, k: number, out: { lat: number; up: number }): void {
  const F = BALL.float;
  const angle = draw(seed, k * 3 + 1) * Math.PI * 2;
  const strength = F.strengthMin + (1 - F.strengthMin) * draw(seed, k * 3 + 2);
  out.lat = Math.cos(angle) * strength;
  out.up = Math.sin(angle) * strength * F.vertical;
}

/**
 * The float (see `BALL.float`): the seams' push across the flight, which breaks to a new
 * direction every fraction of a second, and the jump in drag once the ball is under its
 * critical speed. Added to `out`.
 */
function floatAccel(s: BallState, sp: number, out: V3): void {
  const F = BALL.float;
  const v = s.v;
  // which push the ball is in: they follow one another from the hit
  let k = 0;
  let t0 = 0;
  let hold = F.holdMin + (F.holdMax - F.holdMin) * draw(s.seed, 0);
  while (s.kt >= t0 + hold && k < 40) {
    t0 += hold;
    k++;
    hold = F.holdMin + (F.holdMax - F.holdMin) * draw(s.seed, k * 3);
  }
  floatPush(s.seed, k, _push);
  let lat = _push.lat;
  let up = _push.up;
  // a break is quick, not instant: the push turns from the last one over `blend`
  const b = smooth01((s.kt - t0) / F.blend);
  if (b < 1) {
    let lat0 = 0;
    let up0 = 0;
    if (k > 0) {
      floatPush(s.seed, k - 1, _push);
      lat0 = _push.lat;
      up0 = _push.up;
    }
    lat = lat0 + (lat - lat0) * b;
    up = up0 + (up - up0) * b;
  }
  const a = K_SIDE * F.cs * s.knuckle * smooth01((sp - F.speedLo) / (F.speedFull - F.speedLo)) * sp * sp;
  // across the flight: level and square to it (px, pz), and square to both (mostly up)
  const hl = Math.hypot(v.x, v.z) || 1;
  const px = -v.z / hl;
  const pz = v.x / hl;
  out.x += a * (lat * px - (up * pz * v.y) / sp);
  out.y += (a * up * hl) / sp;
  out.z += a * (lat * pz + (up * px * v.y) / sp);
  // under its critical speed the ball dies
  const critical = F.crisisLo + (F.crisisHi - F.crisisLo) * draw(s.seed, 97);
  const die = K_DRAG * F.dieDrag * s.knuckle * smooth01((critical - sp) / F.crisisWidth);
  out.x -= die * sp * v.x;
  out.y -= die * sp * v.y;
  out.z -= die * sp * v.z;
}

const _a: V3 = { x: 0, y: 0, z: 0 };

/**
 * Advance the ball by dt. Collision events are appended to `events` if given.
 */
export function stepBall(s: BallState, dt: number, env: BallEnv, events?: CollisionEvent[]): void {
  if (s.rest) return;
  const sp = Math.hypot(s.v.x, s.v.y, s.v.z);
  const n = Math.min(10, Math.max(1, Math.ceil((sp * dt) / (R * 0.45))));
  const h = dt / n;
  for (let i = 0; i < n; i++) subStep(s, h, env, events);
  // spin decay
  const decay = Math.exp(-dt / BALL.spinDecayTime);
  s.w.x *= decay;
  s.w.y *= decay;
  s.w.z *= decay;
  s.kt += dt;
}

function subStep(s: BallState, h: number, env: BallEnv, events?: CollisionEvent[]): void {
  const { p, v } = s;
  const prevZ = p.z;
  aeroAccel(s, _a);
  // semi-implicit Euler
  v.x += _a.x * h;
  v.y += _a.y * h;
  v.z += _a.z * h;
  p.x += v.x * h;
  p.y += v.y * h;
  p.z += v.z * h;
  collideNet(s, prevZ, h, env, events);
  collideAntennae(s, env, events);
  collidePosts(s, events);
  collideFloor(s, h, events);
  collideBounds(s, env, events);
}

function emit(events: CollisionEvent[] | undefined, kind: CollisionKind, p: V3, impact: number) {
  if (events) events.push({ kind, x: p.x, y: p.y, z: p.z, impact });
}

function collideFloor(s: BallState, h: number, events?: CollisionEvent[]): void {
  const { p, v, w } = s;
  if (p.y >= R) return;
  p.y = R;
  if (v.y < 0) {
    const vn = -v.y;
    const e = vn < 0.5 ? 0 : BALL.floorRestitution;
    v.y = vn * e;
    // friction impulse at the contact point (0,-R,0): slip = v + w x r
    // w x (0,-R,0) = (w.z*R, 0, -w.x*R)
    const sx = v.x + w.z * R;
    const sz = v.z - w.x * R;
    const slip = Math.hypot(sx, sz);
    if (slip > 1e-6) {
      const jn = (1 + e) * vn; // per unit mass
      const jStop = slip / (1 + INV_I_TERM); // impulse/m that stops slipping
      const j = Math.min(BALL.floorFriction * jn, jStop);
      const dx = -(sx / slip) * j;
      const dz = -(sz / slip) * j;
      v.x += dx;
      v.z += dz;
      // dw = (r x J) / I with r = (0,-R,0): r x d = (-R*dz, 0, R*dx); I/m = 2/3 R^2
      const k = 1 / ((2 / 3) * R);
      w.x += -dz * k;
      w.z += dx * k;
    }
    if (vn > 0.25) emit(events, 'floor', p, vn);
  }
  // rolling resistance when resting on the floor
  if (v.y <= 0.01) {
    const f = Math.exp(-1.2 * h);
    v.x *= f;
    v.z *= f;
    // roll without slipping: v + w x (0,-R,0) = 0
    w.x = v.z / R;
    w.z = -v.x / R;
    if (Math.hypot(v.x, v.z) < 0.05) {
      v.x = v.z = 0;
      v.y = 0;
      s.rest = true;
    }
  }
}

function collideNet(s: BallState, prevZ: number, h: number, env: BallEnv, events?: CollisionEvent[]): void {
  const { p, v } = s;
  const top = env.netTop;
  const bottom = top - COURT.netDepth;
  const hx = COURT.netHalfLength;
  if (Math.abs(p.x) > hx + R) return;
  // ---- top tape: cylinder along x at y = top - tapeR, z = 0
  const tr = BALL.tapeRadius;
  const cy = top - tr;
  const dy = p.y - cy;
  const dz = p.z;
  const d = Math.hypot(dy, dz);
  if (d < R + tr && Math.abs(p.x) <= hx && (p.y > cy || Math.abs(dz) < R + tr)) {
    if (p.y >= cy - 0.01) {
      // contact with the tape: push out radially in the y-z plane
      const ny = d > 1e-6 ? dy / d : 1;
      const nz = d > 1e-6 ? dz / d : Math.sign(prevZ) || 1;
      const vn = v.y * ny + v.z * nz;
      if (vn < 0) {
        // the cable is taut from above, but hit from the side the whole net swings back with it
        const e = BALL.netRestitution + (BALL.tapeRestitution - BALL.netRestitution) * ny * ny;
        v.y -= (1 + e) * vn * ny;
        v.z -= (1 + e) * vn * nz;
        v.x *= 0.85;
        // tape grabs the ball a little
        v.y *= 0.92;
        v.z *= 0.92;
        emit(events, 'tape', p, -vn);
      }
      p.y = cy + ny * (R + tr);
      p.z = nz * (R + tr);
      return;
    }
  }
  // ---- soft net body: a mesh the ball sinks into (up to netGive), held by an overdamped spring
  // and gripped by the mesh, so it dies there and drops down the net. The centre never crosses
  // the net plane (the judge reads a crossing as the ball going over or under).
  if (p.y > bottom - R * 0.5 && p.y < cy && Math.abs(p.x) <= hx) {
    const side = Math.sign(prevZ) || 1;
    const depth = R - p.z * side; // how far into the mesh
    if (depth > 0) {
      if (R - Math.abs(prevZ) <= 0 && -v.z * side > 0) emit(events, 'net', p, -v.z * side);
      const zMin = R - BALL.netGive;
      if (depth >= BALL.netGive) {
        // the mesh is taut: no more give
        p.z = side * zMin;
        const vn = -v.z * side;
        if (vn > 0) v.z = side * vn * BALL.netRestitution;
      }
      const k = BALL.netStiffness * BALL.netStiffness;
      const c = 2 * BALL.netDampingRatio * BALL.netStiffness;
      v.z = v.z * Math.exp(-c * (v.z * side < 0 ? 1 : BALL.netReturn) * h) + side * k * Math.min(depth, BALL.netGive) * h;
      const g = Math.exp(-BALL.netGrip * h);
      v.x *= g;
      if (v.y > 0) v.y *= g;
      s.w.x *= g;
      s.w.y *= g;
      s.w.z *= g;
    }
  }
}

function collideVerticalCylinder(
  s: BallState,
  cx: number,
  cz: number,
  rad: number,
  y0: number,
  y1: number,
  e: number,
  kind: CollisionKind,
  events?: CollisionEvent[],
): boolean {
  const { p, v } = s;
  if (p.y < y0 - R || p.y > y1 + R) return false;
  const dx = p.x - cx;
  const dz = p.z - cz;
  let nx: number, ny: number, nz: number, dist: number, minD: number;
  if (p.y > y1) {
    // rounded top cap
    const dy = p.y - y1;
    const hd = Math.hypot(dx, dz);
    const ex = hd > rad ? dx - (dx / hd) * rad : 0;
    const ez = hd > rad ? dz - (dz / hd) * rad : 0;
    dist = Math.hypot(ex, dy, ez);
    minD = R;
    if (dist >= minD) return false;
    nx = ex / (dist || 1);
    ny = dy / (dist || 1);
    nz = ez / (dist || 1);
    if (dist < 1e-6) {
      nx = 0;
      ny = 1;
      nz = 0;
    }
    p.x += nx * (minD - dist);
    p.y += ny * (minD - dist);
    p.z += nz * (minD - dist);
  } else {
    dist = Math.hypot(dx, dz);
    minD = R + rad;
    if (dist >= minD) return false;
    nx = dist > 1e-6 ? dx / dist : 1;
    nz = dist > 1e-6 ? dz / dist : 0;
    ny = 0;
    p.x = cx + nx * minD;
    p.z = cz + nz * minD;
  }
  const vn = v.x * nx + v.y * ny + v.z * nz;
  if (vn < 0) {
    v.x -= (1 + e) * vn * nx;
    v.y -= (1 + e) * vn * ny;
    v.z -= (1 + e) * vn * nz;
    emit(events, kind, p, -vn);
  }
  return true;
}

function collideAntennae(s: BallState, env: BallEnv, events?: CollisionEvent[]): void {
  if (Math.abs(s.p.z) > 0.3) return;
  const y0 = env.netTop - COURT.netDepth;
  const y1 = env.netTop + COURT.antennaAboveNet;
  for (const sx of [-1, 1]) {
    collideVerticalCylinder(s, sx * COURT.antennaX, 0, COURT.antennaRadius, y0, y1, BALL.antennaRestitution, 'antenna', events);
  }
}

function collidePosts(s: BallState, events?: CollisionEvent[]): void {
  if (Math.abs(s.p.z) > 0.5 || Math.abs(s.p.x) < COURT.postX - 0.5) return;
  for (const sx of [-1, 1]) {
    if (!collideVerticalCylinder(s, sx * COURT.postX, 0, PAD_R, 0, PAD_H, 0.3, 'post', events)) {
      collideVerticalCylinder(s, sx * COURT.postX, 0, COURT.postRadius, PAD_H, POST_H, BALL.postRestitution, 'post', events);
    }
  }
}

function collideBounds(s: BallState, env: BallEnv, events?: CollisionEvent[]): void {
  const { p, v } = s;
  // LED boards around the free zone
  if (p.y < BOARD_H + R) {
    if (Math.abs(p.x) > BOARD_X - R && Math.abs(p.x) < BOARD_X + 0.3 && Math.abs(p.z) < BOARD_Z) {
      const sx = Math.sign(p.x);
      if (v.x * sx > 0) {
        emit(events, 'board', p, Math.abs(v.x));
        v.x = -v.x * BALL.wallRestitution;
      }
      p.x = sx * (BOARD_X - R);
    }
    if (Math.abs(p.z) > BOARD_Z - R && Math.abs(p.z) < BOARD_Z + 0.3 && Math.abs(p.x) < BOARD_X) {
      const sz = Math.sign(p.z);
      if (v.z * sz > 0) {
        emit(events, 'board', p, Math.abs(v.z));
        v.z = -v.z * BALL.wallRestitution;
      }
      p.z = sz * (BOARD_Z - R);
    }
  }
  const X = COURT.arenaHalfX;
  const Z = COURT.arenaHalfZ;
  if (Math.abs(p.x) > X - R) {
    const sx = Math.sign(p.x);
    if (v.x * sx > 0) {
      emit(events, 'wall', p, Math.abs(v.x));
      v.x = -v.x * BALL.wallRestitution;
    }
    p.x = sx * (X - R);
  }
  if (Math.abs(p.z) > Z - R) {
    const sz = Math.sign(p.z);
    if (v.z * sz > 0) {
      emit(events, 'wall', p, Math.abs(v.z));
      v.z = -v.z * BALL.wallRestitution;
    }
    p.z = sz * (Z - R);
  }
  const ceiling = env.ceiling === undefined ? COURT.ceiling : env.ceiling;
  if (ceiling !== null && p.y > ceiling - R) {
    if (v.y > 0) {
      emit(events, 'ceiling', p, v.y);
      v.y = -v.y * 0.3;
    }
    p.y = ceiling - R;
  }
}

/** set a topspin of `rate` rad/s for horizontal travel direction (dx,dz) */
export function topspinFor(dx: number, dz: number, rate: number, out: V3): V3 {
  const l = Math.hypot(dx, dz) || 1;
  // up x dir = (dz, 0, -dx) for up=(0,1,0)... (0,1,0)x(dx,0,dz) = (1*dz-0, 0*dx-0*dz, 0-1*dx)
  out.x = (dz / l) * rate;
  out.y = 0;
  out.z = (-dx / l) * rate;
  return out;
}
