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

/**
 * Plan an attack approach onto a predicted ball: find when the ball drops
 * through this athlete's contact height, where the feet must be, when to
 * plant (so the jump peaks at contact) and when to start running (binary
 * search over simulated runs).
 */
export function planApproach(
  me: Athlete, pred: BallPredictor, now: number, runYaw: number, airYaw: number,
  hold = PLAYER.loadMax - 0.02,
): ApproachPlan | null {
  const off = new THREE.Vector3();
  const prevYaw = me.yaw;
  me.yaw = runYaw;
  me.idealContact(off, new THREE.Vector3(0, 0, 0));
  me.yaw = prevYaw;
  const reachY = me.standReach - 0.16;
  let H = me.jumpMax;
  let best: ApproachPlan | null = null;
  for (let iter = 0; iter < 3; iter++) {
    const hc = reachY + H * 0.97;
    const tc = pred.descendThrough(hc, now);
    if (tc < 0) return best;
    pred.posAt(tc, _b);
    const contact = new THREE.Vector3(_b.x, _b.y, _b.z);
    const feet = new THREE.Vector3(contact.x - off.x, 0, contact.z - off.z);
    const dir = new THREE.Vector3(feet.x - me.pos.x, 0, feet.z - me.pos.z);
    const total = dir.length();
    if (total > 1e-4) dir.normalize();
    else dir.set(0, 0, -me.side);
    const g0 = BALL.gravity;
    const b = PLAYER.apexBand;
    const sc = PLAYER.apexGravityScale;
    const vy = Math.sqrt(Math.max(2 * g0 * H + b * b * (1 - 1 / sc), b * b + 0.01));
    const tUp = (vy - b) / g0 + b / (g0 * sc);
    const tPress = Math.max(now + 0.02, tc - tUp - hold);
    let lo = now;
    let hi = tPress;
    for (let i = 0; i < 14; i++) {
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
