import { AI, CONTACT, COURT } from '../config';
import { makeBall, R, stepBall, type BallEnv, type V3 } from '../physics/ball';
import { shotFan, solveSpeedToFloor, type ShotFan } from '../physics/solve';

/** a player on the other side who could dig it: where they are, when they can start to move, how fast they run */
export interface Digger {
  x: number;
  z: number;
  /** s from the hit until they can move (a late start; a blocker in the air comes down first) */
  ready: number;
  /** top running speed (m/s) */
  speed: number;
}

/** a blocker's hands over the net: centre along the net (x), and how high they reach `t` s after the hit */
export interface BlockHands {
  x: number;
  top: (t: number) => number;
}

export interface OpenShot {
  /** the floor target */
  x: number;
  z: number;
  /** s the quickest digger misses it by (negative: someone could get there) */
  margin: number;
}

/** candidates across and along their court */
const GRID_X = 17;
const GRID_Z = 16;
/** this many of the fan's best are flown again exactly */
const VERIFY = 12;

/**
 * Off a perfect set the hitter sees the court and hits an open spot: a floor target where a
 * full-speed spike from `from` comes down with nobody able to get a platform under it, round
 * the block or over its hands. Candidates are a grid over their court (`opp` the sign of its
 * z). Each must clear the tape with the AI hitter's margin, pass inside the antennae, land in
 * and miss every blocker's hands wherever they reach (AI.blockReachBand either side of the
 * net); then each digger needs `ready` plus the run at `speed` to within AI.digReach of any
 * point of the ball's drop below AI.digTop. The grid is weighed on one fan of flights (shotFan); the best
 * are flown again exactly (the spike solver, the ball sim). Of those the quickest digger misses
 * by AI.openShotMargin or more, one is taken at random (`rand`), so the kills go to different
 * zones; if none is that open, the best. Null if no candidate is in play.
 */
export function openShot(
  from: V3,
  speed: number,
  spin: number,
  opp: 1 | -1,
  env: BallEnv,
  diggers: Digger[],
  blocks: BlockHands[],
  rand: () => number,
): OpenShot | null {
  const fan = shotFan(from.y, speed, spin);
  const hw = COURT.halfWidth - 0.35;
  const deep = COURT.halfLength - 0.35;
  const found: OpenShot[] = [];
  for (let i = 0; i < GRID_X; i++) {
    for (let j = 0; j < GRID_Z; j++) {
      const x = -hw + (2 * hw * i) / (GRID_X - 1);
      const z = opp * (1 + ((deep - 1) * j) / (GRID_Z - 1));
      const margin = fanMargin(fan, from, x, z, opp, env, diggers, blocks);
      if (margin !== null) found.push({ x, z, margin });
    }
  }
  found.sort((a, b) => b.margin - a.margin);
  const verified: OpenShot[] = [];
  for (const c of found.slice(0, VERIFY)) {
    const margin = exactMargin(from, speed, spin, c.x, c.z, opp, env, diggers, blocks);
    if (margin !== null) verified.push({ x: c.x, z: c.z, margin });
  }
  if (!verified.length) return null;
  const open = verified.filter((c) => c.margin >= AI.openShotMargin);
  if (open.length) return open[Math.min(open.length - 1, Math.floor(rand() * open.length))];
  return verified.reduce((a, b) => (b.margin > a.margin ? b : a));
}

/** the margin of a shot at (x, z) on the fan: the flight whose range is nearest, stretched to land there (null: not in play) */
function fanMargin(
  fan: ShotFan,
  from: V3,
  x: number,
  z: number,
  opp: 1 | -1,
  env: BallEnv,
  diggers: Digger[],
  blocks: BlockHands[],
): number | null {
  const dx = x - from.x;
  const dz = z - from.z;
  const d = Math.hypot(dx, dz);
  // the flights get longer as they rise: the first one that reaches is the nearest
  let k = fan.range.findIndex((r) => r >= d);
  if (k < 0) return null;
  if (k > 0 && d - fan.range[k - 1] < fan.range[k] - d) k--;
  const path = fan.paths[k];
  const stretch = d / fan.range[k];
  const ux = dx / d;
  const uz = dz / d;
  const p = { x: 0, y: 0, z: 0 };
  let prevZ = from.z;
  const st = { crossed: false, margin: Infinity };
  for (let n = 1; n < path.s.length; n++) {
    const s = path.s[n] * stretch;
    p.x = from.x + ux * s;
    p.y = path.y[n];
    p.z = from.z + uz * s;
    if (!sample(p, prevZ, n * fan.dt, opp, env, diggers, blocks, st)) return null;
    prevZ = p.z;
  }
  return st.crossed ? st.margin : null;
}

const _s = makeBall();
const _out = { x: 0, y: 0, z: 0 };
const _w = { x: 0, y: 0, z: 0 };
const _land = { x: 0, y: 0, z: 0 };

/** the margin of a shot at (x, z), flown exactly: the spike solver's velocity and the ball sim (null: not in play) */
function exactMargin(
  from: V3,
  speed: number,
  spin: number,
  x: number,
  z: number,
  opp: 1 | -1,
  env: BallEnv,
  diggers: Digger[],
  blocks: BlockHands[],
): number | null {
  solveSpeedToFloor(from, x, z, speed, spin, _out, _w, _land);
  // out of range at this speed: the solver's closest angle lands somewhere else
  if (Math.hypot(_land.x - x, _land.z - z) > 0.3) return null;
  const s = _s;
  Object.assign(s.p, from);
  Object.assign(s.v, _out);
  Object.assign(s.w, _w);
  s.rest = false;
  const dt = 1 / 240;
  let t = 0;
  const st = { crossed: false, margin: Infinity };
  while (s.p.y > R && t < 3) {
    const prevZ = s.p.z;
    stepBall(s, dt, env);
    t += dt;
    if (!sample(s.p, prevZ, t, opp, env, diggers, blocks, st)) return null;
  }
  if (Math.abs(s.p.x) > COURT.halfWidth - R || Math.abs(s.p.z) > COURT.halfLength - R) return null;
  return st.crossed ? st.margin : null;
}

/** one point of a flight at time t: the tape and antennae as it crosses, the block's hands, the diggers. False: not in play */
function sample(
  p: V3,
  prevZ: number,
  t: number,
  opp: 1 | -1,
  env: BallEnv,
  diggers: Digger[],
  blocks: BlockHands[],
  st: { crossed: boolean; margin: number },
): boolean {
  if (!st.crossed && Math.sign(p.z) === opp && Math.sign(prevZ) !== opp) {
    st.crossed = true;
    // the tape (the AI hitter's own margin), the antennae
    if (p.y < env.netTop + R + 0.12 || Math.abs(p.x) > COURT.halfWidth - R) return false;
  }
  // the block's hands, wherever they reach (over the net onto the hitter's side too)
  if (Math.abs(p.z) < AI.blockReachBand)
    for (const b of blocks) if (Math.abs(p.x - b.x) < CONTACT.blockHalfWidth + R + AI.openShotBlockGap && p.y < b.top(t) + R) return false;
  if (st.crossed && p.y < AI.digTop) {
    for (const d of diggers) {
      const run = Math.max(0, Math.hypot(p.x - d.x, p.z - d.z) - AI.digReach);
      st.margin = Math.min(st.margin, d.ready + run / d.speed - t);
    }
  }
  return true;
}
