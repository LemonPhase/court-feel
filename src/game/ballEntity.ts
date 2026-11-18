import * as THREE from 'three';
import { BALL, SIM } from '../config';
import { lerp } from '../core/mathx';
import { copyBall, floatBreaking, makeBall, stepBall, type BallEnv, type BallState, type CollisionEvent } from '../physics/ball';
import { FloatRead } from '../physics/floatRead';
import { BallPredictor } from '../physics/predict';
import type { Athlete } from './athlete';

export type TouchKind = 'spike' | 'tip' | 'block' | 'pass' | 'dig' | 'set' | 'serve' | 'free' | 'feed';

export interface Touch {
  athlete: Athlete | null;
  kind: TouchKind;
  t: number;
  side: 1 | -1 | 0;
  /** an attack off the user's green set: the hitter hid the shot until the hand (their defence starts late) */
  green?: boolean;
  /** a block the ball came back off softly, to the hitter's side (recycled: `CONTACT.recycleP`) */
  recycle?: boolean;
}

/**
 * The live ball: physics state + previous state for interpolation, its rotation from the
 * angular velocity, the last touch and the prediction of where it lands. It has no meshes and
 * needs no renderer: world/ballView.ts draws it, with the timing-cue shadow and the landing marker.
 */
export class BallEntity {
  readonly state: BallState = makeBall();
  private prev: BallState = makeBall();
  /** where the ball is drawn this frame, and how it is turned (`interpolate`) */
  readonly rpos = new THREE.Vector3();
  readonly rquat = new THREE.Quaternion();
  private q = new THREE.Quaternion();
  private prevQ = new THREE.Quaternion();
  readonly predictor = new BallPredictor(1 / SIM.hz, Math.max(SIM.predictHorizon, SIM.predictHorizonOpenSky));
  /** bumped whenever someone changes the velocity (prediction invalidated) */
  version = 0;
  private predictedVersion = -1;
  readonly events: CollisionEvent[] = [];
  lastTouch: Touch | null = null;
  /** touches on the current side */
  touchesThisSide = 0;
  active = false;
  visible = true;
  showMarker = true;
  /** cool against the warm wood; modes recolour it (e.g. green for "your ball") */
  markerColor = new THREE.Color(0.3, 0.85, 1.0);
  /** sim time of the last launch / touch */
  lastLaunchT = 0;

  get pos() {
    return this.state.p;
  }

  get vel() {
    return this.state.v;
  }

  speed(): number {
    const v = this.state.v;
    return Math.hypot(v.x, v.y, v.z);
  }

  /** place the ball and give it a velocity (and spin) */
  launch(
    p: { x: number; y: number; z: number },
    v: { x: number; y: number; z: number },
    w = { x: 0, y: 0, z: 0 },
    knuckle = 0,
    t = 0,
    seed = 0,
  ): void {
    const s = this.state;
    s.p.x = p.x;
    s.p.y = p.y;
    s.p.z = p.z;
    s.v.x = v.x;
    s.v.y = v.y;
    s.v.z = v.z;
    s.w.x = w.x;
    s.w.y = w.y;
    s.w.z = w.z;
    s.knuckle = knuckle;
    s.seed = seed;
    s.kt = 0;
    s.rest = false;
    this.floatRead.reset();
    this.breaking = 0;
    copyBall(s, this.prev);
    this.prevQ.copy(this.q);
    this.version++;
    this.active = true;
    this.lastLaunchT = t;
  }

  /**
   * change velocity in place (contact), keeping interpolation continuous. `knuckle` and `seed`: a
   * ball hit without spin floats (`BALL.float`)
   */
  hit(v: { x: number; y: number; z: number }, w: { x: number; y: number; z: number }, knuckle = 0, t = 0, seed = 0): void {
    const s = this.state;
    s.v.x = v.x;
    s.v.y = v.y;
    s.v.z = v.z;
    s.w.x = w.x;
    s.w.y = w.y;
    s.w.z = w.z;
    s.knuckle = knuckle;
    s.seed = seed;
    s.kt = 0;
    s.rest = false;
    this.floatRead.reset();
    this.breaking = 0;
    this.version++;
    this.lastLaunchT = t;
  }

  /** how hard the float is breaking (0: flying true), and on the step a break starts, how hard that break is */
  private breaking = 0;
  broke = 0;
  /** what can be seen of a floating ball's path (`BALL.float`) */
  private floatRead = new FloatRead(1 / SIM.hz);
  private readAge = 0;

  /** the ball floats: its path cannot be read ahead */
  get floating(): boolean {
    return this.state.knuckle > 0 && !this.state.rest;
  }

  /**
   * Make sure the prediction reflects the current state. For a float it is a read, not the
   * truth: the path the ball was on `BALL.float.read` s ago (or at the hit, if that is more
   * recent) with no push to come, looked at again every `BALL.float.readSteps` steps.
   */
  ensurePrediction(env: BallEnv, t: number): BallPredictor {
    if (this.predictedVersion !== this.version) {
      if (this.floating) {
        const read = this.floatRead.from(this.state);
        this.predictor.compute(read.state, env, t - read.age);
      } else this.predictor.compute(this.state, env, t);
      this.predictedVersion = this.version;
    }
    return this.predictor;
  }

  step(dt: number, env: BallEnv): void {
    copyBall(this.state, this.prev);
    this.prevQ.copy(this.q);
    this.events.length = 0;
    if (!this.active) return;
    if (this.floating) {
      // remember where it was heading, and look again now and then
      this.floatRead.keep(this.state);
      if (++this.readAge >= BALL.float.readSteps) {
        this.readAge = 0;
        this.version++;
      }
    }
    stepBall(this.state, dt, env, this.events);
    // a float has just broken (it was flying true a step ago): the effects mark it
    const breaking = floatBreaking(this.state);
    this.broke = breaking > 0 && this.breaking === 0 ? breaking : 0;
    this.breaking = breaking;
    // integrate visual rotation
    const w = this.state.w;
    const wm = Math.hypot(w.x, w.y, w.z);
    if (wm > 1e-4) {
      _axis.set(w.x / wm, w.y / wm, w.z / wm);
      _dq.setFromAxisAngle(_axis, wm * dt);
      this.q.premultiply(_dq);
    }
    // collisions that change velocity invalidate the prediction only if they
    // were not part of it (they always are: the predictor uses the same step)
  }

  /**
   * Where the ball was touched, for the frame a hit-stop holds. A step resolves the contact and then
   * moves the ball at its new speed, so by the time the frame is drawn a spike is up to half a metre
   * down its line: the freeze showed the hand at the touch and the ball somewhere past it.
   */
  private held: THREE.Vector3 | null = null;

  /** draw the ball at this point for as long as the hit-stop holds the frame (the simulation is not touched) */
  holdDrawn(x: number, y: number, z: number): void {
    (this.held ??= new THREE.Vector3()).set(x, y, z);
  }

  /** `frozen`: a hit-stop is holding this frame */
  interpolate(alpha: number, frozen = false): void {
    if (!frozen) this.held = null;
    drawnBallPos(this.prev.p, this.state.p, alpha, this.held, this.rpos);
    this.rquat.slerpQuaternions(this.prevQ, this.q, alpha);
  }

  /** whoever draws the ball takes it off the court at once (world/ballView.ts) */
  onHide: (() => void) | null = null;

  hide(): void {
    this.active = false;
    this.onHide?.();
  }
}

/**
 * Where the ball is drawn: between its last two simulated positions, or, on a frame a hit-stop
 * holds, where it was touched (`held`).
 */
export function drawnBallPos(
  prev: { x: number; y: number; z: number },
  cur: { x: number; y: number; z: number },
  alpha: number,
  held: { x: number; y: number; z: number } | null,
  out: THREE.Vector3,
): THREE.Vector3 {
  if (held) return out.set(held.x, held.y, held.z);
  return out.set(lerp(prev.x, cur.x, alpha), lerp(prev.y, cur.y, alpha), lerp(prev.z, cur.z, alpha));
}

const _axis = new THREE.Vector3();
const _dq = new THREE.Quaternion();
export { BALL };
