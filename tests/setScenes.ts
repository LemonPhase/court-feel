import * as THREE from 'three';
import { BALL, SIM } from '../src/config';
import { Athlete } from '../src/game/athlete';
import { AthleteView } from '../src/character/athleteView';
import { makeKit } from '../src/character/kits';
import { dirFromYaw, rightFromYaw } from '../src/core/mathx';
import { HANDS_FWD, HANDS_UP } from '../src/game/setJump';

// A setter under a pass, setting it, with the body posed every frame: the scenes of setterBody.test.ts.

const DT = 1 / SIM.hz;
const world = (o: THREE.Object3D) => o.getWorldPosition(new THREE.Vector3());

/** the setter's spot, facing the left antenna (the home side's setter faces -x) */
export const SPOT = { x: 1.1, z: 0.65, yaw: Math.PI / 2 };

/** the ball's velocity off the hands, for the setter at SPOT (world) */
export const OUT = {
  /** a high ball to the outside, 5 m away */
  front: new THREE.Vector3(-4.4, 6.3, -0.1),
  /** a back set to the opposite, 3 m behind */
  back: new THREE.Vector3(3.2, 6.1, -0.1),
  /** a quick to the middle, a metre in front, there in 0.3 s */
  quick: new THREE.Vector3(-3.3, 4.5, -0.6),
};

export interface Frame {
  /** time from the touch (s) */
  t: number;
  wristL: THREE.Vector3;
  wristR: THREE.Vector3;
  /** the knuckle line of each hand */
  handL: THREE.Vector3;
  handR: THREE.Vector3;
  elbowL: THREE.Vector3;
  elbowR: THREE.Vector3;
  shoulderL: THREE.Vector3;
  shoulderR: THREE.Vector3;
  head: THREE.Vector3;
  eye: THREE.Vector3;
  hips: THREE.Vector3;
  chestUp: THREE.Vector3;
  ankleL: THREE.Vector3;
  ankleR: THREE.Vector3;
  /** which way each palm faces */
  palmL: THREE.Vector3;
  palmR: THREE.Vector3;
  /** each thumb, from its root to the tip of its first bone's child */
  thumbL: THREE.Vector3;
  thumbR: THREE.Vector3;
  /** every bone's rotation, to compare two runs */
  pose: number[];
}

export interface SetOpts {
  out: THREE.Vector3;
  /** your own set: the ball is caught, loads in the hands (TIMING.setLoad) and is pushed */
  absorb?: boolean;
  /** standing about this long before the pass is followed (moves the moment the set happens) */
  before?: number;
  /** how long after the touch to keep posing (s) */
  after?: number;
  /** the athlete's id (each setter has their own habits: the same id is the same setter) */
  id?: number;
}

/**
 * A setter standing on the spot under a pass dropping onto the hands (the ball followed for its
 * last 0.7 s), set the way the AI sets (the ball leaves at once) or the way you do (caught, held,
 * pushed). Returns the frames, each with its time from the touch.
 */
export function runSet(opts: SetOpts): { frames: Frame[]; a: Athlete; v: AthleteView } {
  const a = new Athlete('S', 1);
  // (an id of its own: the same setter in every run, so two runs can be compared)
  Object.defineProperty(a, 'id', { value: opts.id ?? 7 });
  a.place(SPOT.x, SPOT.z, SPOT.yaw);
  const v = new AthleteView(a, makeKit(0, false, 1));
  let t = 0;
  const step = () => {
    t += DT;
    a.step(DT, t);
    a.interpolate(1);
    v.update(DT, t);
  };
  for (let i = 0; i < Math.round(((opts.before ?? 0) + 0.4) * SIM.hz); i++) step();
  const f = dirFromYaw(a.yaw);
  const zone = new THREE.Vector3(a.pos.x + f.x * HANDS_FWD, a.height + HANDS_UP, a.pos.z + f.z * HANDS_FWD);
  v.setZone = zone;
  const ball = new THREE.Vector3();
  const vel = new THREE.Vector3();
  // a pass from the back court: it comes in at 2 m/s towards the net and drops onto the hands
  const vIn = { x: 0, z: -2, y0: -2.5 };
  const B = v.rig.bones;
  const frames: Frame[] = [];
  const sample = (tt: number) => {
    const palm = (side: 'L' | 'R') => {
      const q = B[`hand${side}`].getWorldQuaternion(new THREE.Quaternion());
      // the hand's thin axis (local x) is the palm normal: +x = -palm for the right hand, +palm for the left
      return new THREE.Vector3(side === 'R' ? -1 : 1, 0, 0).applyQuaternion(q);
    };
    const thumb = (side: 'L' | 'R') =>
      world(B[`thumbTip${side}`])
        .sub(world(B[`thumb${side}`]))
        .normalize();
    const pose: number[] = [];
    v.root.traverse((o) => pose.push(o.quaternion.x, o.quaternion.y, o.quaternion.z, o.position.x, o.position.y, o.position.z));
    frames.push({
      t: tt,
      wristL: world(B.handL),
      wristR: world(B.handR),
      handL: world(B.fingersL),
      handR: world(B.fingersR),
      elbowL: world(B.lowerArmL),
      elbowR: world(B.lowerArmR),
      shoulderL: world(B.upperArmL),
      shoulderR: world(B.upperArmR),
      head: world(B.head),
      eye: v.eyePos.clone(),
      hips: world(B.hips),
      chestUp: new THREE.Vector3(0, 1, 0).applyQuaternion(B.chest.getWorldQuaternion(new THREE.Quaternion())),
      ankleL: world(B.footL),
      ankleR: world(B.footR),
      palmL: palm('L'),
      palmR: palm('R'),
      thumbL: thumb('L'),
      thumbR: thumb('R'),
      pose,
    });
  };
  // the AI's set: the action starts 0.4 s before the ball reaches the hands (SetterBrain)
  let act: ReturnType<Athlete['startAction']> | null = null;
  for (let tau = 0.7; tau > DT / 2; tau -= DT) {
    ball.set(zone.x - vIn.x * tau, zone.y - vIn.y0 * tau + 0.5 * BALL.gravity * tau * tau, zone.z - vIn.z * tau);
    vel.set(vIn.x, vIn.y0 - BALL.gravity * tau, vIn.z);
    if (!act && tau <= 0.4 + 1e-9) act = a.startAction('set', t);
    a.ballPos = ball;
    a.ballVel = vel;
    a.lookAt.copy(ball);
    step();
    sample(-tau + DT);
  }
  act ??= a.startAction('set', t);
  // the ball reaches the hands
  ball.copy(zone);
  let tc = t;
  if (opts.absorb) {
    // caught: it loads in the hands for TIMING.setLoad, giving with them at TIMING.setAbsorbSpeed
    act.absorbing = true;
    act.arriveT = t;
    for (let i = 0; i < Math.round(0.15 * SIM.hz); i++) {
      ball.y -= 0.6 * DT;
      vel.set(0, -0.6, 0);
      a.ballPos = ball;
      a.ballVel = vel;
      step();
      sample(t - tc);
    }
    act.absorbing = false;
    tc = t;
    for (const fr of frames) fr.t -= tc - act.arriveT;
  }
  act.resolved = true;
  act.held = false;
  act.contactT = t;
  act.contactPoint.copy(ball);
  const from = ball.clone();
  const end = opts.after ?? 0.7;
  for (let ts = DT; ts < end; ts += DT) {
    ball.set(from.x + opts.out.x * ts, from.y + opts.out.y * ts - 0.5 * BALL.gravity * ts * ts, from.z + opts.out.z * ts);
    vel.set(opts.out.x, opts.out.y - BALL.gravity * ts, opts.out.z);
    a.ballPos = ball;
    a.ballVel = vel;
    a.lookAt.copy(ball);
    // the setter's action ends 0.4 s after the touch (SetterBrain)
    if (a.action && ts > 0.4) a.endAction();
    step();
    sample(ts);
  }
  return { frames, a, v };
}

/** the frame nearest `t` s from the touch */
export const at = (frames: Frame[], t: number) => frames.reduce((b, f) => (Math.abs(f.t - t) < Math.abs(b.t - t) ? f : b));
/** angle at the elbow (rad): pi is a straight arm */
export const elbowAngle = (sh: THREE.Vector3, el: THREE.Vector3, wr: THREE.Vector3) =>
  sh.clone().sub(el).normalize().angleTo(wr.clone().sub(el).normalize());
/** a world vector in the setter's own frame: forward (towards the target), up, right */
export const local = (v: THREE.Vector3) => {
  const f = dirFromYaw(SPOT.yaw);
  const r = rightFromYaw(SPOT.yaw);
  return { fwd: v.dot(f), up: v.y, right: v.dot(r) };
};
