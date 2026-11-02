import * as THREE from 'three';
import { BALL, PLAYER, SIM } from '../config';
import { Athlete } from '../game/athlete';
import type { BallPredictor } from '../physics/predict';
import type { V3 } from '../physics/ball';

export interface ApproachPlan {
  /** absolute sim times */
  tStart: number;
  tPress: number;
  tc: number;
  hold: number;
  /** run direction (unit, xz) */
  dir: THREE.Vector3;
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

/**
 * Forward-simulate an approach with the athlete's own kinematics: stand until
 * tStart, sprint along dir, plant at tPress, hold the load, then fly until tc.
 */
export function simulateApproach(
  me: Athlete, now: number, tStart: number, tPress: number, hold: number, dir: THREE.Vector3,
  runYaw: number, airYaw: number, tc: number,
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
  a.jumpMax = me.jumpMax;
  const dt = 1 / SIM.hz;
  let t = now;
  let pressed = false;
  let released = false;
  while (t < tc - 1e-9) {
    const running = t >= tStart && !pressed;
    a.cmd.moveX = running ? dir.x : 0;
    a.cmd.moveZ = running ? dir.z : 0;
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
 * jump height depends on the run.
 */
function planTo(
  me: Athlete, now: number, runYaw: number, airYaw: number, hold: number,
  target: (H: number) => { tc: number; contact: THREE.Vector3 } | null,
): ApproachPlan | null {
  const off = new THREE.Vector3();
  const prevYaw = me.yaw;
  me.yaw = runYaw;
  me.idealContact(off, new THREE.Vector3(0, 0, 0));
  me.yaw = prevYaw;
  let H = me.jumpMax;
  let best: ApproachPlan | null = null;
  for (let iter = 0; iter < 2; iter++) {
    const tg = target(H);
    if (!tg) return best;
    const { tc, contact } = tg;
    const feet = new THREE.Vector3(contact.x - off.x, 0, contact.z - off.z);
    const dir = new THREE.Vector3(feet.x - me.pos.x, 0, feet.z - me.pos.z);
    const total = dir.length();
    if (total > 1e-4) dir.normalize();
    else dir.set(0, 0, -me.side);
    const tPress = Math.max(now + 0.02, tc - riseTime(H) - hold);
    let lo = now;
    let hi = tPress;
    for (let i = 0; i < 11; i++) {
      const mid = (lo + hi) / 2;
      const r = simulateApproach(me, now, mid, tPress, hold, dir, runYaw, airYaw, tc);
      const along = (r.pos.x - me.pos.x) * dir.x + (r.pos.z - me.pos.z) * dir.z;
      if (along > total) lo = mid;
      else hi = mid;
    }
    const r = simulateApproach(me, now, lo, tPress, hold, dir, runYaw, airYaw, tc);
    best = {
      tStart: lo, tPress, tc, hold, dir, runYaw, airYaw, contact,
      feet: r.pos.clone(), error: Math.hypot(r.pos.x - feet.x, r.pos.z - feet.z),
    };
    if (Math.abs(r.jumpH - H) < 0.01) break;
    H = r.jumpH;
  }
  return best;
}

/**
 * Plan an attack approach onto a predicted ball: find when the ball drops
 * through this athlete's contact height, where the feet must be, when to
 * plant (so the jump peaks at contact) and when to start running.
 */
export function planApproach(
  me: Athlete, pred: BallPredictor, now: number, runYaw: number, airYaw: number,
  hold = PLAYER.loadMax - 0.02,
): ApproachPlan | null {
  const reachY = me.standReach - 0.16;
  return planTo(me, now, runYaw, airYaw, hold, (H) => {
    const tc = pred.descendThrough(reachY + H * 0.97, now);
    if (tc < 0) return null;
    pred.posAt(tc, _b);
    return { tc, contact: new THREE.Vector3(_b.x, _b.y, _b.z) };
  });
}

/**
 * Plan a first-tempo (quick) approach: leave the floor at `tTakeoff` (the
 * moment the setter touches the ball) and peak over `spot`, where the set
 * will meet the hand.
 */
export function planQuick(
  me: Athlete, now: number, spot: { x: number; z: number }, tTakeoff: number, runYaw: number, airYaw: number,
  hold = PLAYER.loadMax - 0.02,
): ApproachPlan | null {
  const reachY = me.standReach - 0.16;
  return planTo(me, now, runYaw, airYaw, hold, (H) => ({
    tc: tTakeoff + riseTime(H),
    contact: new THREE.Vector3(spot.x, reachY + H, spot.z),
  }));
}

/** plan to meet a ball that will be at `contact` at time `tc` (a set not yet made: tempo balls) */
export function planToPoint(
  me: Athlete, now: number, contact: THREE.Vector3, tc: number, runYaw: number, airYaw: number,
  hold = PLAYER.loadMax - 0.02,
): ApproachPlan | null {
  return planTo(me, now, runYaw, airYaw, hold, () => ({ tc, contact }));
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
  a.jumpMax = me.jumpMax;
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
