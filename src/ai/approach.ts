import * as THREE from 'three';
import { AI, BALL, PLAYER, SIM } from '../config';
import { Athlete } from '../game/athlete';
import type { BallPredictor } from '../physics/predict';
import type { V3 } from '../physics/ball';

export interface ApproachPlan {
  /** absolute sim times */
  tStart: number;
  tPress: number;
  tc: number;
  hold: number;
  /** run direction (unit, xz): from where the run starts straight to the plant */
  dir: THREE.Vector3;
  /**
   * A curved run (see `bendFor`): where it starts, its length along `dir` (m), and the bend
   * (rad, signed): the run leaves `bend` to one side of `dir` and arrives `bend` to the other,
   * squarer to the net. 0: a straight run.
   */
  from: THREE.Vector3;
  total: number;
  bend: number;
  /** a pin hitter going inside (AI.insideRun): a broad jump along the run, and the swing goes with it */
  inside: boolean;
  /** fraction of the run's speed kept through the plant */
  carry: number;
  /** the turn of a curved run is done over this much of the way (the rest is the plant and the jump) */
  ground: number;
  /** body yaw during the run and in the air */
  runYaw: number;
  airYaw: number;
  /** ball centre at contact */
  contact: THREE.Vector3;
  /** simulated feet at contact */
  feet: THREE.Vector3;
  /** simulated miss distance (feet vs needed) */
  error: number;
}

const _sim = new Map<string, Athlete>();
const _b: V3 = { x: 0, y: 0, z: 0 };
const _d = new THREE.Vector3();

/**
 * How much a run along `dir` (unit) should curve for a hitter on `side`. A hitter crossing the
 * court (an X, a 2 inside, a shoot) does not run straight at the spot: they loop in, starting
 * along the net and turning towards it, so the last steps and the jump go into the court and
 * the shoulders are open to it. A run within `AI.approach.straight` rad of square to the net
 * stays straight; beyond that it bends by `share` of the excess, up to `maxBend`. Returns the
 * signed bend (rad): the run starts that much further from square and ends that much nearer.
 */
export function bendFor(dir: THREE.Vector3, side: 1 | -1, total: number): number {
  const A = AI.approach;
  if (total < A.minRun) return 0;
  // the angle from "straight at the net" (0, -side) to the run
  const alpha = Math.atan2(side * dir.x, -side * dir.z);
  const over = Math.abs(alpha) - A.straight;
  // never start the run heading away from the net
  const bend = Math.min(A.maxBend, over * A.share, Math.PI / 2 - 0.08 - Math.abs(alpha));
  return bend > 0 ? -Math.sign(alpha) * bend : 0;
}

/** is a run along `dir` (unit) a pin hitter's run inside? Far off square to the net, and long enough to be at speed */
export function isInsideRun(dir: THREE.Vector3, side: 1 | -1, total: number): boolean {
  const I = AI.insideRun;
  return total >= I.minRun && Math.abs(Math.atan2(side * dir.x, -side * dir.z)) > I.angle;
}

/** how much of a curved run is on the floor, where it turns: less when the jump is a broad jump (AI.insideRun) */
function groundFor(carry: number): number {
  return carry > PLAYER.plantCarry ? AI.insideRun.ground : AI.approach.ground;
}

/** the direction to run at `pos` on a plan's (curved) run: turns from one side of `dir` to the other as the run goes */
export function runDir(
  p: { dir: THREE.Vector3; from: THREE.Vector3; total: number; bend: number; ground?: number },
  pos: { x: number; z: number },
  out: THREE.Vector3,
): THREE.Vector3 {
  if (!p.bend || p.total <= 0) return out.copy(p.dir);
  // the turn is finished by the plant: the last part of the way to the ball is flown, straight
  const along = ((pos.x - p.from.x) * p.dir.x + (pos.z - p.from.z) * p.dir.z) / (p.total * (p.ground ?? AI.approach.ground));
  const phi = p.bend * (2 * Math.min(1, Math.max(0, along)) - 1);
  const c = Math.cos(phi);
  const s = Math.sin(phi);
  return out.set(p.dir.x * c - p.dir.z * s, 0, p.dir.x * s + p.dir.z * c);
}

/**
 * Forward-simulate an approach with the athlete's own kinematics: stand until
 * tStart, sprint along dir (curving by `bend` over `total` m: see runDir), plant at tPress,
 * hold the load, then fly until tc.
 */
export function simulateApproach(
  me: Athlete,
  now: number,
  tStart: number,
  tPress: number,
  hold: number,
  dir: THREE.Vector3,
  runYaw: number,
  airYaw: number,
  tc: number,
  bend = 0,
  total = 0,
  carry = me.plantCarry,
): Athlete {
  const key = me.role + me.side;
  let a = _sim.get(key);
  if (!a) {
    a = new Athlete(me.role, me.side);
    _sim.set(key, a);
  }
  a.pos.copy(me.pos);
  a.vel.copy(me.vel);
  a.yaw = me.yaw;
  a.state = me.state === 'air' ? 'air' : me.state === 'load' ? 'ground' : me.state;
  a.stateT = me.stateT;
  a.action = null;
  a.onStep = a.onLand = a.onTakeoff = null;
  a.airNudge.set(0, 0, 0);
  a.copyBody(me);
  a.plantCarry = carry;
  const dt = 1 / SIM.hz;
  let t = now;
  let pressed = false;
  let released = false;
  // (a broad jump leaves the floor sooner: the turn is done sooner too)
  const run = { dir, from: me.pos, total, bend, ground: groundFor(carry) };
  while (t < tc - 1e-9) {
    const running = t >= tStart && !pressed;
    if (running) runDir(run, a.pos, _d);
    a.cmd.moveX = running ? _d.x : 0;
    a.cmd.moveZ = running ? _d.z : 0;
    a.cmd.sprint = running;
    a.cmd.faceYaw = a.state === 'air' ? airYaw : runYaw;
    if (!pressed && t >= tPress - 1e-9) {
      a.jumpPress();
      pressed = true;
    }
    if (pressed && !released && t >= tPress + hold - 1e-9) {
      a.jumpRelease();
      released = true;
    }
    t += dt;
    a.step(dt, t);
  }
  return a;
}

/** rise time from takeoff to the top of a jump of height H (apex hang included) */
export function riseTime(H: number): number {
  const g0 = BALL.gravity;
  const b = PLAYER.apexBand;
  const sc = PLAYER.apexGravityScale;
  const vy = Math.sqrt(Math.max(2 * g0 * H + b * b * (1 - 1 / sc), b * b + 0.01));
  return (vy - b) / g0 + b / (g0 * sc);
}

/**
 * Shared approach solver: `target(H)` gives the contact point and time for a
 * jump of height H; plant so the jump peaks then, start running so the feet
 * arrive under it (binary search over simulated runs). Iterates because the
 * jump height depends on the run. `behind` > 0 (a back-row hitter): the feet leave the floor at
 * least that far (m) from the net, even if the ball is then met a little in front of the body.
 */
function planTo(
  me: Athlete,
  now: number,
  runYaw: number,
  airYaw: number,
  hold: number,
  target: (H: number) => { tc: number; contact: THREE.Vector3 } | null,
  behind = 0,
  curved = false,
): ApproachPlan | null {
  const off = new THREE.Vector3();
  const prevYaw = me.yaw;
  me.yaw = runYaw;
  me.idealContact(off, new THREE.Vector3(0, 0, 0));
  me.yaw = prevYaw;
  let H = me.jumpMax;
  let best: ApproachPlan | null = null;
  // (how far the feet are held back from under the ball, so the take-off stays behind the line)
  let back = 0;
  for (let iter = 0; iter < (behind > 0 ? 4 : 2); iter++) {
    const tg = target(H);
    if (!tg) return best;
    const { tc, contact } = tg;
    const feet = new THREE.Vector3(contact.x - off.x, 0, contact.z - off.z + me.side * back);
    const tPress = Math.max(now + 0.02, tc - riseTime(H) - hold);
    // where the run is aimed. A straight run is aimed at the feet. A curved one is flown off its
    // last heading, to one side of the line it started on: it is aimed a little to the other side,
    // corrected from the simulated miss until the feet come down where they must
    const aim = feet.clone();
    const dir = new THREE.Vector3();
    let total = 0;
    let bend = 0;
    let inside = false;
    let carry = PLAYER.plantCarry;
    let lo = now;
    let r = me;
    for (let k = 0; k < 4; k++) {
      dir.set(aim.x - me.pos.x, 0, aim.z - me.pos.z);
      total = dir.length();
      if (total > 1e-4) dir.normalize();
      else dir.set(0, 0, -me.side);
      bend = curved ? bendFor(dir, me.side, total) : 0;
      // (decided on the first line to the feet: the aim corrections must not flip it)
      if (k === 0) {
        inside = curved && isInsideRun(dir, me.side, total);
        carry = inside ? AI.insideRun.carry : PLAYER.plantCarry;
      }
      lo = now;
      let hi = tPress;
      for (let i = 0; i < 11; i++) {
        const mid = (lo + hi) / 2;
        const s = simulateApproach(me, now, mid, tPress, hold, dir, runYaw, airYaw, tc, bend, total, carry);
        const along = (s.pos.x - me.pos.x) * dir.x + (s.pos.z - me.pos.z) * dir.z;
        if (along > total) lo = mid;
        else hi = mid;
      }
      r = simulateApproach(me, now, lo, tPress, hold, dir, runYaw, airYaw, tc, bend, total, carry);
      const mx = r.pos.x - feet.x;
      const mz = r.pos.z - feet.z;
      if (!bend || Math.hypot(mx, mz) < 0.04) break;
      aim.x -= mx;
      aim.z -= mz;
    }
    best = {
      tStart: lo,
      tPress,
      tc,
      hold,
      dir,
      from: me.pos.clone(),
      total,
      bend,
      inside,
      carry,
      ground: groundFor(carry),
      runYaw,
      airYaw,
      contact,
      feet: r.pos.clone(),
      error: Math.hypot(r.pos.x - feet.x, r.pos.z - feet.z),
    };
    // a back-row hitter leaves the floor behind the line: if this run would not, plan it again
    // with the feet that much further back
    let short = 0;
    if (behind > 0) {
      const tk = simulateApproach(me, now, lo, tPress, hold, dir, runYaw, airYaw, tPress + hold, bend, total, carry);
      short = behind - tk.pos.z * me.side;
    }
    if (short > 0.01) back += short + 0.02;
    else if (Math.abs(r.jumpH - H) < 0.01) break;
    H = r.jumpH;
  }
  return best;
}

/**
 * Plan an attack approach onto a predicted ball: find when the ball drops
 * through this athlete's contact height, where the feet must be, when to
 * plant (so the jump peaks at contact) and when to start running. `curved`: a run across the
 * court loops in (bendFor); the AI hitters ask for it, the user's bots and lessons run straight.
 */
export function planApproach(
  me: Athlete,
  pred: BallPredictor,
  now: number,
  runYaw: number,
  airYaw: number,
  hold = PLAYER.loadMax - 0.02,
  behind = 0,
  curved = false,
): ApproachPlan | null {
  const reachY = me.standReach - 0.16;
  return planTo(
    me,
    now,
    runYaw,
    airYaw,
    hold,
    (H) => {
      const tc = pred.descendThrough(reachY + H * 0.97, now);
      if (tc < 0) return null;
      pred.posAt(tc, _b);
      return { tc, contact: new THREE.Vector3(_b.x, _b.y, _b.z) };
    },
    behind,
    curved,
  );
}

/**
 * Plan a first-tempo (quick) approach: leave the floor at `tTakeoff` (the
 * moment the setter touches the ball) and peak over `spot`, where the set
 * will meet the hand.
 */
export function planQuick(
  me: Athlete,
  now: number,
  spot: { x: number; z: number },
  tTakeoff: number,
  runYaw: number,
  airYaw: number,
  hold = PLAYER.loadMax - 0.02,
  curved = false,
): ApproachPlan | null {
  const reachY = me.standReach - 0.16;
  return planTo(
    me,
    now,
    runYaw,
    airYaw,
    hold,
    (H) => ({
      tc: tTakeoff + riseTime(H),
      contact: new THREE.Vector3(spot.x, reachY + H, spot.z),
    }),
    0,
    curved,
  );
}

/** plan to meet a ball that will be at `contact` at time `tc` (a set not yet made: tempo balls) */
export function planToPoint(
  me: Athlete,
  now: number,
  contact: THREE.Vector3,
  tc: number,
  runYaw: number,
  airYaw: number,
  hold = PLAYER.loadMax - 0.02,
  behind = 0,
  curved = false,
): ApproachPlan | null {
  return planTo(me, now, runYaw, airYaw, hold, () => ({ tc, contact }), behind, curved);
}

export interface JumpPrediction {
  /** absolute sim time of the predicted contact moment */
  t: number;
  /** ideal ball-centre contact point at that moment */
  contact: THREE.Vector3;
}

const _peak = new Map<string, Athlete>();

/**
 * Forward-simulate a hitter who is planting or airborne (no further input) to
 * the top of the jump, or to `now + minT` if the top comes sooner, and return
 * where the ball should be met then. Null if they are not jumping or land first.
 */
export function predictJump(me: Athlete, now: number, releaseAt = now, minT = 0): JumpPrediction | null {
  if (me.state !== 'air' && me.state !== 'load') return null;
  const key = me.role + me.side;
  let a = _peak.get(key);
  if (!a) {
    a = new Athlete(me.role, me.side);
    _peak.set(key, a);
  }
  a.pos.copy(me.pos);
  a.vel.copy(me.vel);
  a.yaw = me.yaw;
  a.state = me.state;
  a.stateT = me.stateT;
  a.loadT = me.loadT;
  a.loadApproach = me.loadApproach;
  a.loadRelease = me.loadRelease;
  a.jumpH = me.jumpH;
  a.copyBody(me);
  a.plantCarry = me.plantCarry;
  a.takeoffT = me.takeoffT;
  a.takeoffY = me.takeoffY;
  a.takeoffYaw = me.takeoffYaw;
  a.peakY = me.peakY;
  a.airT = me.airT;
  a.time = me.time;
  a.action = null;
  a.onStep = a.onLand = a.onTakeoff = null;
  a.airNudge.set(0, 0, 0);
  a.cmd.moveX = a.cmd.moveZ = 0;
  a.cmd.sprint = false;
  a.cmd.faceYaw = me.cmd.faceYaw;
  const dt = 1 / SIM.hz;
  let t = now;
  for (let i = 0; i < SIM.hz * 2; i++) {
    if (a.state === 'load' && t >= releaseAt - 1e-9) a.jumpRelease();
    if (a.state === 'air' && a.vel.y <= 0 && t >= now + minT - 1e-9) {
      return { t, contact: a.idealContact(new THREE.Vector3()) };
    }
    if (a.state !== 'air' && a.state !== 'load') return null;
    t += dt;
    a.step(dt, t);
  }
  return null;
}
