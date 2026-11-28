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
  /** the antenna (-1, +1) the ball is touching right now, 0 for none (`BALL.antenna`) */
  rod: number;
  /** the ball has pushed on the net's top since it last came off it: the touch has been called (`BALL.tape`) */
  onTape: boolean;
  /**
   * The net's top, as the ball has moved it (`BALL.tape`): how far it is from its line, up (y, so
   * pressed down is negative) and along z (m), and how fast (m/s).
   *
   * The net and the antennae belong to the world, not to the ball, but there is one ball and they
   * move only when it hits them, so their state is kept here: a prediction or a planner that copies
   * the ball meets them where they will be, and the simulation stays one pure step. Turned down: a
   * net object of its own passed beside the ball to every `stepBall`, which every predictor, solver
   * and planner would have to carry and copy too. A second ball in play would need it.
   */
  tapeY: number;
  tapeZ: number;
  tapeVy: number;
  tapeVz: number;
  /**
   * The antennae and the net's sides they are strapped to, as they move (`BALL.antenna`): each rod's
   * bends and the side's swing. Carried with the ball so a prediction meets them where they will be.
   */
  ant: Float64Array;
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
export const INV_I_TERM = (R * R) / ((2 / 3) * R * R); // r^2 * m / I  = 1.5

export const BOARD_X = COURT.halfWidth + COURT.freeZoneSide + 0.6;
export const BOARD_Z = COURT.halfLength + COURT.freeZoneEnd + 0.6;
export const BOARD_H = 0.9;
const PAD_R = 0.16;
const PAD_H = 1.9;
const POST_H = 2.6;

export function makeBall(): BallState {
  return {
    p: { x: 0, y: 1, z: 0 },
    v: { x: 0, y: 0, z: 0 },
    w: { x: 0, y: 0, z: 0 },
    knuckle: 0,
    kt: 0,
    seed: 0,
    rest: false,
    rod: 0,
    onTape: false,
    tapeY: 0,
    tapeZ: 0,
    tapeVy: 0,
    tapeVz: 0,
    ant: new Float64Array(ANT_LEN),
  };
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
  dst.rod = src.rod;
  dst.onTape = src.onTape;
  dst.tapeY = src.tapeY;
  dst.tapeZ = src.tapeZ;
  dst.tapeVy = src.tapeVy;
  dst.tapeVz = src.tapeVz;
  dst.ant.set(src.ant);
  return dst;
}

/**
 * The net and the antennae at rest, as at the start of a rally: for a planner's ball that flies a
 * shot on its own, so what it finds does not depend on the shot it flew before.
 */
export function stillNet(s: BallState): BallState {
  s.rod = 0;
  s.onTape = false;
  s.tapeY = 0;
  s.tapeZ = 0;
  s.tapeVy = 0;
  s.tapeVz = 0;
  s.ant.fill(0);
  return s;
}

/**
 * The net's top and the antennae swing on over `dt` with the ball not being stepped (at rest, or
 * not in play): they are the world's and settle whatever the ball does.
 */
export function stepNet(s: BallState, dt: number): void {
  swingTape(s, dt);
  swingAntennae(s, dt);
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

const _push = { lat: 0, up: 0, full: 0 };

/**
 * The float's push at `t` s after the hit: sideways and up, each -1..1 (0, 0 while it flies
 * true). The ball flies true for a moment, then breaks, again and again, each on its own draw.
 */
function floatPush(seed: number, t: number, out: { lat: number; up: number; full: number }): void {
  const F = BALL.float;
  out.lat = 0;
  out.up = 0;
  out.full = 0;
  let t0 = 0;
  for (let k = 0; k < 24; k++) {
    // it flies true, then it breaks
    t0 += F.quietMin + (F.quietMax - F.quietMin) * draw(seed, k * 4);
    if (t < t0) return;
    const hold = F.breakMin + (F.breakMax - F.breakMin) * draw(seed, k * 4 + 1);
    if (t < t0 + hold) {
      // left, right, or straight down
      const way = draw(seed, k * 4 + 2);
      const strength = F.strengthMin + (1 - F.strengthMin) * draw(seed, k * 4 + 3);
      // a break comes on and lets go quickly, not in one step
      const push = strength * smooth01((t - t0) / F.edge) * smooth01((t0 + hold - t) / F.edge);
      if (way < F.down) out.up = -push;
      else out.lat = way < (1 + F.down) / 2 ? push : -push;
      out.full = strength;
      return;
    }
    t0 += hold;
  }
}

/**
 * How hard a floating ball is breaking right now, 0 (it is flying true, or it does not float) to
 * 1: the strength of the break it is in, times how cleanly it was hit. For the effects that show
 * a break; the flight itself is `aeroAccel`.
 */
export function floatBreaking(s: BallState): number {
  if (s.knuckle <= 0 || s.rest || Math.hypot(s.v.x, s.v.y, s.v.z) <= BALL.float.speedLo) return 0;
  floatPush(s.seed, s.kt, _push);
  return _push.full * s.knuckle;
}

/**
 * The float (see `BALL.float`): the breaks across the flight, and the jump in drag once the ball
 * is under its critical speed. Added to `out`.
 */
function floatAccel(s: BallState, sp: number, out: V3): void {
  const F = BALL.float;
  const v = s.v;
  floatPush(s.seed, s.kt, _push);
  if (_push.lat !== 0 || _push.up !== 0) {
    const a = K_SIDE * F.cs * s.knuckle * smooth01((sp - F.speedLo) / (F.speedFull - F.speedLo)) * sp * sp;
    // across the flight: level and square to it (px, pz), and square to both (mostly up)
    const hl = Math.hypot(v.x, v.z) || 1;
    const px = -v.z / hl;
    const pz = v.x / hl;
    out.x += a * (_push.lat * px - (_push.up * pz * v.y) / sp);
    out.y += (a * _push.up * hl) / sp;
    out.z += a * (_push.lat * pz + (_push.up * px * v.y) / sp);
  }
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
  if (s.rest) {
    stepNet(s, dt);
    return;
  }
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
  if (nearAntenna(s, h, env)) {
    // at an antenna the ball and the rod push on each other in short steps
    const k = Math.ceil(h / ANT.step);
    const hc = h / k;
    for (let i = 0; i < k; i++) {
      v.x += _a.x * hc;
      v.y += _a.y * hc;
      v.z += _a.z * hc;
      touchAntennae(s, hc, env, events);
      p.x += v.x * hc;
      p.y += v.y * hc;
      p.z += v.z * hc;
    }
  } else {
    // semi-implicit Euler
    v.x += _a.x * h;
    v.y += _a.y * h;
    v.z += _a.z * h;
    p.x += v.x * h;
    p.y += v.y * h;
    p.z += v.z * h;
    s.rod = 0;
    swingAntennae(s, h);
  }
  swingTape(s, h);
  collideNet(s, prevZ, h, env, events);
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
  if (Math.abs(p.x) > hx + R) {
    s.onTape = false;
    return;
  }
  // ---- the cable in the top band's hem (`BALL.tape`): a ball whose centre is above it rides on it
  const cy = top - BALL.tape.cable;
  if (Math.abs(p.x) <= hx && collideCable(s, cy, h, events)) return;
  s.onTape = false;
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

/** the net's top swings back to its line (`BALL.tape`), whether or not the ball is on it, and stops where the rods do */
function swingTape(s: BallState, h: number): void {
  if (s.tapeY === 0 && s.tapeVy === 0 && s.tapeZ === 0 && s.tapeVz === 0) return;
  const T = BALL.tape;
  s.tapeVy -= (T.swingUp * T.swingUp * s.tapeY + 2 * T.damping * T.swingUp * s.tapeVy) * h;
  s.tapeY += s.tapeVy * h;
  s.tapeVz -= (T.swing * T.swing * s.tapeZ + 2 * T.damping * T.swing * s.tapeVz) * h;
  s.tapeZ += s.tapeVz * h;
  const still = BALL.antenna.still;
  if (Math.abs(s.tapeY) <= still && Math.abs(s.tapeVy) <= still && Math.abs(s.tapeZ) <= still && Math.abs(s.tapeVz) <= still)
    s.tapeY = s.tapeVy = s.tapeZ = s.tapeVz = 0;
}

/**
 * The net's top (`BALL.tape`): the cable in the band's hem, at `cy`, moved by the ball. A ball whose
 * centre is over the cable meets it as one body meets another: the share of the net's top that moves
 * with it (`massUp` pressed down, `mass` along z), which the net then pulls back to its line. So a
 * ball driven into it moves the net and keeps some of its way instead of climbing a post, and how
 * much goes where depends on the angle, the speed and the spin. The lower part of a ball that sits
 * low on the cable is in the band, which grips it like the mesh does (`band`). False when the ball
 * is not on it.
 */
function collideCable(s: BallState, cy: number, h: number, events?: CollisionEvent[]): boolean {
  const { p, v, w } = s;
  const T = BALL.tape;
  const reach = R + T.cable;
  const ry = p.y - (cy + s.tapeY);
  const rz = p.z - s.tapeZ;
  const r = Math.hypot(ry, rz);
  if (ry < 0 || r >= reach) return false;
  const ny = r > 0 ? ry / r : 1;
  const nz = r > 0 ? rz / r : 0;
  p.y = cy + s.tapeY + ny * reach;
  p.z = s.tapeZ + nz * reach;
  const vn = (v.y - s.tapeVy) * ny + (v.z - s.tapeVz) * nz;
  // the band: the lower part of the ball presses it and it grips, more the lower the ball sits. A
  // ball sitting higher than its radius over the cable is clear of the band: nothing grips it (and
  // a grip can only take speed away, never give it)
  const g = Math.exp(-BALL.netGrip * T.band * Math.max(0, 1 - ry / R) * h);
  v.x *= g;
  v.z = s.tapeVz + (v.z - s.tapeVz) * g;
  if (v.y > 0) v.y *= g;
  if (vn >= 0) return true;
  // the push: ball against the net's top
  const J = (-(1 + T.restitution) * vn) / (1 / BALL.mass + (ny * ny) / T.massUp + (nz * nz) / T.mass);
  const dn = J / BALL.mass;
  v.y += dn * ny;
  v.z += dn * nz;
  s.tapeVy -= (J * ny) / T.massUp;
  s.tapeVz -= (J * nz) / T.mass;
  // called once, as it lands: not again on every step it sits there pressing down
  if (!s.onTape) emit(events, 'tape', p, -vn);
  s.onTape = true;
  // grip: the cover slides on the cable (contact point r = -R n) until friction stops it
  const sx = v.x + R * (w.z * ny - w.y * nz);
  const sy = v.y - s.tapeVy + R * w.x * nz;
  const sz = v.z - s.tapeVz - R * w.x * ny;
  const sn = sy * ny + sz * nz;
  const ty = sy - sn * ny;
  const tz = sz - sn * nz;
  const slip = Math.hypot(sx, ty, tz);
  if (slip <= 0) return true;
  const j = Math.min(T.grip * dn, slip / (1 + INV_I_TERM));
  const fx = (-sx / slip) * j;
  const fy = (-ty / slip) * j;
  const fz = (-tz / slip) * j;
  v.x += fx;
  v.y += fy;
  v.z += fz;
  // the spin it gives: dw = (r x f) / (I/m), r = -R n
  const kw = INV_I_TERM / R;
  w.x -= (ny * fz - nz * fy) * kw;
  w.y -= nz * fx * kw;
  w.z += ny * fx * kw;
  return true;
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

// The antennae (`BALL.antenna`). Each is a 10 mm fibreglass rod strapped along the side of the net,
// with 0.8 m standing free above it. The free rod bends: its motion is the sum of a clamped rod's
// first bends (`modes`), each a shape along the rod with its own mass, spring and damping. The rod is
// strapped to the net's side, which swings along z on the net's tension (`net`), so the net moves
// with it and the rod is carried along. The ball is soft against a 1 cm rod: it wraps around it
// (`contactTime`, `restitution`) and slides on it (`friction`), and it is pushed along the line from
// the rod to its centre: a ball off the rod's middle is turned aside, and the rod is driven away from
// the ball wherever it is touched. The rod cannot stretch: bent far, its tip comes down, and the ball
// can slide off over it. Where it is touched, how hard and at what angle decide how much of
// the rod and the net it moves, and so how much the ball is turned and slowed.

const ANT = BALL.antenna;
const NM = ANT.modes;
const ROD_R = COURT.antennaRadius;
const ROD_L = COURT.antennaAboveNet;
const ROD_AREA = Math.PI * ROD_R * ROD_R;
/** bending stiffness (N m^2): a solid round rod, I = area r^2 / 4 */
const ROD_EI = ANT.modulus * ROD_AREA * ROD_R * ROD_R * 0.5 * 0.5;
/** mass per metre (kg/m) */
const ROD_MU = ANT.density * ROD_AREA;
/** the ball's skin, pulled tight by the air in it: its tension (N/m) is the pressure times half the radius */
const SKIN = (ANT.pressure * R) / 2;
/** of the push the ball took going in, what it gives back coming out: restitution squared of the energy */
const GIVE_BACK = ANT.restitution * ANT.restitution;
/** the ball's centre is on the rod's line at this overlap */
const TOUCH_D = R + ROD_R;
/** the net's side, where the rod is strapped: the net's tension holds it, from the near post and the far one */
const SIDE_K = ANT.net.tension * (1 / (COURT.postX - COURT.antennaX) + 1 / (COURT.postX + COURT.antennaX));
const SIDE_C = 2 * ANT.net.damping * Math.sqrt(SIDE_K * ANT.net.mass);

/** the roots of cos x cosh x = -1, a clamped rod's bends (Newton's method from (n + 1/2) pi) */
const ROOTS = Array.from({ length: NM }, (_, n) => {
  let x = (n + 0.5) * Math.PI;
  for (;;) {
    const dx = (Math.cos(x) * Math.cosh(x) + 1) / (Math.cos(x) * Math.sinh(x) - Math.sin(x) * Math.cosh(x));
    x -= dx;
    if (Math.abs(dx) <= x * Math.sqrt(Number.EPSILON)) return x;
  }
});
const BEND = ROOTS.map((root) => {
  const beta = root / ROD_L;
  const sigma = (Math.cosh(root) + Math.cos(root)) / (Math.sinh(root) + Math.sin(root));
  const shape = (s: number) => Math.cosh(beta * s) - Math.cos(beta * s) - sigma * (Math.sinh(beta * s) - Math.sin(beta * s));
  // the shape's square adds up to the rod's length along it, so each bend's mass is the whole rod's
  const mass = ROD_MU * ROD_L;
  const w = beta * beta * Math.sqrt(ROD_EI / ROD_MU);
  return {
    mass,
    k: w * w * mass,
    c: 2 * ANT.damping * w * mass,
    /** how much of the rod's mass this bend carries when the net's side moves: mu times the shape's sum along the rod */
    carry: (ROD_MU * 2 * sigma) / beta,
    /** the shape at `samples` + 1 heights from the net's top to the tip */
    at: Array.from({ length: ANT.samples + 1 }, (_, i) => shape((ROD_L * i) / ANT.samples)),
  };
});
/** the rod left to itself is stepped no coarser than a radian of its fastest bend */
const ROD_DT = Math.sqrt(BEND[NM - 1].mass / BEND[NM - 1].k);
/** what moves with the net's side: its own mass and the free rod's, less what the bends carry */
const SIDE_MASS = ANT.net.mass + ROD_MU * ROD_L - BEND.reduce((m, b) => m + (b.carry * b.carry) / b.mass, 0);

/** where an antenna's numbers are in `BallState.ant`: its bends along x and z and their speeds, then the net side's z and speed */
const QX = 0;
const QZ = NM;
const VX = NM + NM;
const VZ = VX + NM;
const ZB = VZ + NM;
const VB = ZB + 1;
const ANT_STRIDE = VB + 1;
const ANT_LEN = ANT_STRIDE + ANT_STRIDE;

/** a bend's shape at height `at` (m above the net's top, 0 to the tip), read between the samples */
function shapeAt(b: (typeof BEND)[number], at: number): number {
  const f = Math.min(Math.max(at / ROD_L, 0), 1) * ANT.samples;
  const i = Math.min(Math.floor(f), ANT.samples - 1);
  return b.at[i] + (b.at[i + 1] - b.at[i]) * (f - i);
}

/** how far the antenna at `side` (-1, +1) is pushed at height `at` above the net's top (m), along x and z, the net's side included */
export function antennaBend(s: BallState, side: number, at: number, out: { x: number; z: number }): void {
  const a = s.ant;
  const o = side > 0 ? ANT_STRIDE : 0;
  out.x = 0;
  out.z = a[o + ZB];
  if (at <= 0) return;
  for (let n = 0; n < NM; n++) {
    const phi = shapeAt(BEND[n], at);
    out.x += a[o + QX + n] * phi;
    out.z += a[o + QZ + n] * phi;
  }
}

/**
 * The antenna at `side` (-1, +1) as it stands: its free rod as `samples` + 1 points from the net's
 * top to the tip, into `out`. Each piece keeps its length: bent far, the rod comes down.
 */
export function antennaShape(s: BallState, side: number, netTop: number, out: RodPoints): void {
  const seg = ROD_L / ANT.samples;
  let x = side * COURT.antennaX;
  let y = netTop;
  let z = s.ant[(side > 0 ? ANT_STRIDE : 0) + ZB];
  let bx = 0;
  let bz = z;
  out.x[0] = x;
  out.y[0] = y;
  out.z[0] = z;
  for (let i = 1; i <= ANT.samples; i++) {
    antennaBend(s, side, seg * i, _rod);
    let ex = _rod.x - bx;
    let ez = _rod.z - bz;
    bx = _rod.x;
    bz = _rod.z;
    const flat = Math.hypot(ex, ez);
    if (flat > seg) {
      ex *= seg / flat;
      ez *= seg / flat;
    }
    x += ex;
    z += ez;
    y += Math.sqrt(Math.max(0, seg * seg - ex * ex - ez * ez));
    out.x[i] = x;
    out.y[i] = y;
    out.z[i] = z;
  }
}

/** the ball's push on each bend along x and z (N) */
const _qx = new Float64Array(NM);
const _qz = new Float64Array(NM);
/** how far the rod's point where the ball is comes up for each bend along x and z (m per m) */
const _jx = new Float64Array(NM);
const _jz = new Float64Array(NM);

/**
 * How the height of the antenna's point at `at` (m along the free rod) changes with each of its
 * bends, along x and z, into `_jx`, `_jz`. The rod keeps its length: as a bend pushes a piece of it
 * aside the piece tips over, and the rod above it comes down. So the rod's bends move that point up
 * and down too, and a push up or down on it bends the rod: without this a bent rod would be as heavy
 * as the floor to a ball on top of it, and could throw one up without paying for it. A piece laid flat
 * comes down no further.
 */
function rodLift(a: Float64Array, o: number, at: number): void {
  _jx.fill(0);
  _jz.fill(0);
  const seg = ROD_L / ANT.samples;
  const f = (Math.min(Math.max(at, 0), ROD_L) / ROD_L) * ANT.samples;
  for (let i = 1; i <= ANT.samples && i - 1 < f; i++) {
    let ex = 0;
    let ez = 0;
    for (let n = 0; n < NM; n++) {
      const d = BEND[n].at[i] - BEND[n].at[i - 1];
      ex += a[o + QX + n] * d;
      ez += a[o + QZ + n] * d;
    }
    const up = seg * seg - ex * ex - ez * ez;
    if (up <= 0) continue;
    // the whole piece below the point, or the part of it up to the point
    const k = Math.min(f - (i - 1), 1) / Math.sqrt(up);
    for (let n = 0; n < NM; n++) {
      const d = BEND[n].at[i] - BEND[n].at[i - 1];
      _jx[n] -= ex * d * k;
      _jz[n] -= ez * d * k;
    }
  }
}
const _rod = { x: 0, z: 0 };
/** points along a rod */
export interface RodPoints {
  x: Float64Array;
  y: Float64Array;
  z: Float64Array;
}
export function makeRodPoints(): RodPoints {
  return { x: new Float64Array(ANT.samples + 1), y: new Float64Array(ANT.samples + 1), z: new Float64Array(ANT.samples + 1) };
}
const _pts = makeRodPoints();

/**
 * Step one antenna over `h` under the ball's push on its bends (`_qx`, `_qz`) and its push along z
 * (`fz`), on the free rod or the strapped part: either way it reaches the net's side. Along z the
 * net's side moves too, so it and the bends are solved together: the side carries the rod, and the
 * rod's push and pull move the side.
 */
function stepRod(a: Float64Array, o: number, fz: number, h: number): void {
  let carried = 0;
  for (let n = 0; n < NM; n++) {
    const b = BEND[n];
    a[o + VX + n] += ((_qx[n] - b.k * a[o + QX + n] - b.c * a[o + VX + n]) / b.mass) * h;
    carried += b.carry * ((_qz[n] - b.k * a[o + QZ + n] - b.c * a[o + VZ + n]) / b.mass);
  }
  const side = (-SIDE_K * a[o + ZB] - SIDE_C * a[o + VB] + fz - carried) / SIDE_MASS;
  for (let n = 0; n < NM; n++) {
    const b = BEND[n];
    a[o + VZ + n] += ((_qz[n] - b.k * a[o + QZ + n] - b.c * a[o + VZ + n]) / b.mass - (b.carry / b.mass) * side) * h;
    a[o + QX + n] += a[o + VX + n] * h;
    a[o + QZ + n] += a[o + VZ + n] * h;
  }
  a[o + VB] += side * h;
  a[o + ZB] += a[o + VB] * h;
}

/** nothing of this antenna moves more than `still` */
function rodStill(a: Float64Array, o: number): boolean {
  for (let i = o; i < o + ANT_STRIDE; i++) if (Math.abs(a[i]) > ANT.still) return false;
  return true;
}

/** the antennae and the net's sides swing on with nothing touching them */
function swingAntennae(s: BallState, h: number): void {
  const a = s.ant;
  _qx.fill(0);
  _qz.fill(0);
  for (let o = 0; o < ANT_LEN; o += ANT_STRIDE) {
    if (rodStill(a, o)) {
      a.fill(0, o, o + ANT_STRIDE);
      continue;
    }
    const k = Math.ceil(h / ROD_DT);
    for (let i = 0; i < k; i++) stepRod(a, o, 0, h / k);
  }
}

/**
 * The ball may touch the antenna at `o` within `h`: it is within reach of the farthest the rod can
 * be from its line by then, where it is bent now and as far again as it moves at its speed now. Each
 * bend's shape is at most 2, at the tip.
 */
function nearRod(s: BallState, o: number, h: number): boolean {
  const { p, v } = s;
  const a = s.ant;
  let bent = Math.abs(a[o + ZB]) + Math.abs(a[o + VB]) * h;
  for (let n = 0; n < NM; n++)
    bent += (Math.abs(a[o + QX + n]) + Math.abs(a[o + QZ + n]) + (Math.abs(a[o + VX + n]) + Math.abs(a[o + VZ + n])) * h) * 2;
  const sx = o > 0 ? 1 : -1;
  return Math.hypot(p.x - sx * COURT.antennaX, p.z) < TOUCH_D + Math.hypot(v.x, v.z) * h + bent;
}

/** the ball is near enough an antenna to touch it within `h` */
function nearAntenna(s: BallState, h: number, env: BallEnv): boolean {
  const { p } = s;
  if (p.y < env.netTop - COURT.netDepth - R || p.y > env.netTop + ROD_L + R) return false;
  for (let o = 0; o < ANT_LEN; o += ANT_STRIDE) if (nearRod(s, o, h)) return true;
  return false;
}

/**
 * The ball against the antennae over `h`: the push between them where they overlap, and the rods and
 * the net's sides moved by it. The ball's speed and spin change here, not where it is.
 */
function touchAntennae(s: BallState, h: number, env: BallEnv, events?: CollisionEvent[]): void {
  const { p, v, w } = s;
  const a = s.ant;
  const top = env.netTop;
  for (let o = 0; o < ANT_LEN; o += ANT_STRIDE) {
    const sx = o > 0 ? 1 : -1;
    const ax = sx * COURT.antennaX;
    _qx.fill(0);
    _qz.fill(0);
    // the far rod, out of the ball's reach: it only swings on
    if (!nearRod(s, o, h)) {
      if (!rodStill(a, o)) stepRod(a, o, 0, h);
      continue;
    }
    // the rod's nearest point: on its strapped part (straight, moving with the net's side) or on the
    // free rod, a line through its points
    let y = Math.min(Math.max(p.y, top - COURT.netDepth), top);
    let best = (p.x - ax) ** 2 + (p.y - y) ** 2 + (p.z - a[o + ZB]) ** 2;
    let at = y - top;
    let cx = ax;
    let cy = y;
    let cz = a[o + ZB];
    antennaShape(s, sx, top, _pts);
    const seg = ROD_L / ANT.samples;
    for (let i = 1; i <= ANT.samples; i++) {
      const x0 = _pts.x[i - 1];
      const y0 = _pts.y[i - 1];
      const z0 = _pts.z[i - 1];
      const ex = _pts.x[i] - x0;
      const ey = _pts.y[i] - y0;
      const ez = _pts.z[i] - z0;
      const t = Math.min(Math.max(((p.x - x0) * ex + (p.y - y0) * ey + (p.z - z0) * ez) / (ex * ex + ey * ey + ez * ez), 0), 1);
      const qx = x0 + ex * t;
      const qz = z0 + ez * t;
      y = y0 + ey * t;
      const d2 = (p.x - qx) ** 2 + (p.y - y) ** 2 + (p.z - qz) ** 2;
      if (d2 < best) {
        best = d2;
        // along the rod, where its bends are read
        at = seg * (i - 1 + t);
        cx = qx;
        cy = y;
        cz = qz;
      }
    }
    const dist = Math.sqrt(best);
    const overlap = TOUCH_D - dist;
    if (overlap <= 0) {
      if (!rodStill(a, o)) stepRod(a, o, 0, h);
      continue;
    }
    // the push is along the line from the rod to the ball's centre
    let nx = dist > 0 ? (p.x - cx) / dist : -v.x;
    let ny = dist > 0 ? (p.y - cy) / dist : 0;
    let nz = dist > 0 ? (p.z - cz) / dist : -v.z;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl;
    ny /= nl;
    nz /= nl;
    // how fast the rod moves there, up and down as it bends too (the strapped part only with the net's side)
    let rvx = 0;
    let rvy = 0;
    let rvz = a[o + VB];
    rodLift(a, o, at);
    if (at > 0)
      for (let n = 0; n < NM; n++) {
        const phi = shapeAt(BEND[n], at);
        rvx += a[o + VX + n] * phi;
        rvy += a[o + VX + n] * _jx[n] + a[o + VZ + n] * _jz[n];
        rvz += a[o + VZ + n] * phi;
      }
    const rx = v.x - rvx;
    const ry = v.y - rvy;
    const rz = v.z - rvz;
    const vn = rx * nx + ry * ny + rz * nz;
    if (s.rod !== sx) {
      // every touch is called, however light
      emit(events, 'antenna', p, Math.max(0, -vn));
      s.rod = sx;
    }
    // the ball wraps round the rod: its skin pulls on both sides of the rod along all it touches, a
    // push that soon stops growing (a thin rod sinks deep into a ball), until the rod nears its centre
    // and the air in it is squeezed; coming out it gives back only part of what it took
    const u = Math.min(overlap / TOUCH_D, ANT.wrapMax);
    const touching = 2 * Math.sqrt(Math.max(0, overlap * (R + R - overlap)));
    const fn = ((2 * SKIN * touching) / (1 - u)) * (vn < 0 ? 1 : GIVE_BACK);
    // the cover slides on the rod: friction against the slip of its surface, never more than stops it
    const slx = rx - R * (w.y * nz - w.z * ny);
    const sly = ry - R * (w.z * nx - w.x * nz);
    const slz = rz - R * (w.x * ny - w.y * nx);
    const sn = slx * nx + sly * ny + slz * nz;
    const tx = slx - sn * nx;
    const ty = sly - sn * ny;
    const tz = slz - sn * nz;
    const slip = Math.hypot(tx, ty, tz);
    const ft = slip > 0 ? Math.min(ANT.friction * fn, (slip * BALL.mass) / (h * (1 + INV_I_TERM))) / slip : 0;
    const fx = fn * nx - ft * tx;
    const fy = fn * ny - ft * ty;
    const fzb = fn * nz - ft * tz;
    v.x += (fx / BALL.mass) * h;
    v.y += (fy / BALL.mass) * h;
    v.z += (fzb / BALL.mass) * h;
    // the friction turns the ball: dw = (r x f) h / I, r = -R n
    const kw = INV_I_TERM / R;
    const gx = (-ft * tx * h) / BALL.mass;
    const gy = (-ft * ty * h) / BALL.mass;
    const gz = (-ft * tz * h) / BALL.mass;
    w.x -= (ny * gz - nz * gy) * kw;
    w.y -= (nz * gx - nx * gz) * kw;
    w.z -= (nx * gy - ny * gx) * kw;
    // the rod takes the opposite push: the free rod in its bends, the strapped part with the net
    if (at > 0) {
      for (let n = 0; n < NM; n++) {
        const phi = shapeAt(BEND[n], at);
        _qx[n] = -(fx * phi + fy * _jx[n]);
        _qz[n] = -(fzb * phi + fy * _jz[n]);
      }
    }
    stepRod(a, o, -fzb, h);
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
