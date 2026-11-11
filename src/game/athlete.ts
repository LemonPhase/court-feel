import * as THREE from 'three';
import { BALL, COURT, PLAYER, type Hand, type PositionId, type PositionStats } from '../config';
import { standingReach } from '../character/rig';
import { bodyStats, type CustomBody } from './body';
import { angleLerp, clamp, clamp01, damp, dirFromYaw, lerp, rightFromYaw, wrapAngle } from '../core/mathx';

export type AState = 'ground' | 'load' | 'air' | 'land' | 'dive';
export type ActionKind = 'swing' | 'windup' | 'block' | 'pass' | 'set' | 'toss' | 'serve';
export type Grade = 'Perfect' | 'Good' | 'Early' | 'Late' | 'Miss';
/** how a first ball is played: the platform in front, the platform out to one side, overhand, or diving */
export type PassForm = 'platform' | 'side' | 'hands' | 'dive';

export interface Action {
  kind: ActionKind;
  t0: number;
  held: boolean;
  releaseT: number;
  /** scheduled contact time (swing) */
  contactT: number;
  /** world-space point the hand should meet */
  contactPoint: THREE.Vector3;
  resolved: boolean;
  grade: Grade | null;
  /** extra info (tip, power, etc.) */
  tip: boolean;
  /** a soft push straight into the block's hands, to play it off them (a tip with a flat arc) */
  push: boolean;
  /** whiffed swing */
  miss: boolean;
  /** 0..1 progress handled by the animator */
  hand: 'R' | 'L';
  /** aim snapshot */
  aim: THREE.Vector3;
  /** timing error for the grade (s), + = late */
  err: number;
  note: string;
  /** closest ball distance seen so far by a zone contact (pass/set) */
  minD: number;
  /** swing power 0..1 from how long the wind-up was held */
  charge: number;
  /** wind-up: the closest approach seen so far for the current ball (time, distance, which touch) */
  idealT: number;
  idealD: number;
  idealFor: unknown;
  /** a pass: the form it is played with (the AI picks overhand; the contact finds a side or diving touch) */
  form: PassForm;
}

export interface AthleteCmd {
  /** desired world-space move direction (length 0..1) */
  moveX: number;
  moveZ: number;
  sprint: boolean;
  faceYaw: number | null;
}

let nextId = 1;

/**
 * Shared athlete simulation used by the user and every AI player.
 * Pure kinematics (no physics engine): acceleration-limited ground movement,
 * a load -> takeoff -> airborne -> land jump cycle, and action timers that the
 * animator and contact system read.
 */
export class Athlete {
  readonly id = nextId++;
  readonly pos = new THREE.Vector3();
  readonly prevPos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  /** render-interpolated feet position */
  readonly rpos = new THREE.Vector3();
  yaw = 0;
  prevYaw = 0;
  ryaw = 0;
  state: AState = 'ground';
  stateT = 0;
  stats: PositionStats;
  role: PositionId;
  /** court side: +1 (user team, +z) or -1 */
  side: 1 | -1;
  team: 0 | 1;
  isUser = false;
  /** hitting hand: +1 right, -1 left (only the user's athlete can be a lefty) */
  hand: 1 | -1 = 1;
  height: number;
  standReach: number;
  jumpMax: number;
  cmd: AthleteCmd = { moveX: 0, moveZ: 0, sprint: false, faceYaw: null };
  // jump
  loadT = 0;
  loadApproach = 0;
  loadRelease = false;
  jumpH = 0;
  takeoffT = 0;
  takeoffY = 0;
  takeoffYaw = 0;
  peakY = 0;
  airT = 0;
  landImpact = 0;
  /** smoothed 0..1 sprint amount (FOV, animation) */
  sprint = 0;
  /** distance-driven gait phase */
  gaitPhase = 0;
  /** step events for sound / footprints */
  onStep: ((a: Athlete, plant: boolean) => void) | null = null;
  onLand: ((a: Athlete, impact: number) => void) | null = null;
  onTakeoff: ((a: Athlete) => void) | null = null;
  action: Action | null = null;
  /** last action for follow-through animation */
  lastAction: Action | null = null;
  /** time this athlete last touched the ball */
  lastTouchT = -10;
  /** a block's hands reaching sideways from the body (m along the net, world x): a late blocker stretching for the seam */
  reachX = 0;
  /** when the last split step started (the animator hops and lands into a deeper stance; no effect on movement) */
  splitT = -10;
  /** a low covering stance, 0..1 (set by the AI while it covers its hitter; the animator eases into it, no effect on movement) */
  low = 0;
  /** 'ready' body lean */
  readyAmount = 1;
  /** look target for head IK (set by game) */
  readonly lookAt = new THREE.Vector3(0, 2, 0);
  /** what the arms prepare for while airborne */
  airIntent: 'attack' | 'block' | 'set' | 'neutral' = 'attack';
  /** AI attack / pass target */
  readonly aiAim = new THREE.Vector3(0, 0, -6);
  /** live ball position for reaching (set by the game each frame) */
  ballPos: THREE.Vector3 | null = null;
  /** assist nudge velocity in air */
  readonly airNudge = new THREE.Vector3();
  jersey = 0;
  name = '';
  number = 0;
  time = 0;

  /** `body`: a custom height / vert / spike power for this position, `hand`: the hitting hand (the user's settings) */
  constructor(role: PositionId, side: 1 | -1, opts: { height?: number; body?: CustomBody; hand?: Hand } = {}) {
    this.role = role;
    this.stats = bodyStats(role, opts.body);
    this.side = side;
    this.team = side === 1 ? 0 : 1;
    this.hand = handSign(opts.hand);
    this.height = opts.height ?? this.stats.height;
    this.standReach = standingReach(this.height);
    this.jumpMax = this.stats.jump;
    this.yaw = side === 1 ? 0 : Math.PI;
    this.prevYaw = this.ryaw = this.yaw;
  }

  setRole(role: PositionId, body?: CustomBody): void {
    this.role = role;
    this.setBody(body);
  }

  /** apply a custom body (or the position's defaults): height, standing reach, jump and power */
  setBody(body?: CustomBody): void {
    this.stats = bodyStats(this.role, body);
    this.height = this.stats.height;
    this.standReach = standingReach(this.height);
    this.jumpMax = this.stats.jump;
  }

  /** take another athlete's body as is (forward-simulation copies must jump and reach like the real one, with the same hand) */
  copyBody(from: Athlete): void {
    this.stats = from.stats;
    this.height = from.height;
    this.standReach = from.standReach;
    this.jumpMax = from.jumpMax;
    this.hand = from.hand;
  }

  /** teleport (no interpolation streak) */
  place(x: number, z: number, yaw?: number): void {
    this.pos.set(x, 0, z);
    this.prevPos.copy(this.pos);
    this.rpos.copy(this.pos);
    this.vel.set(0, 0, 0);
    if (yaw !== undefined) this.yaw = this.prevYaw = this.ryaw = yaw;
    this.state = 'ground';
    this.stateT = 0;
    this.action = null;
    this.lastAction = null;
    this.airNudge.set(0, 0, 0);
    this.reachX = 0;
  }

  get grounded(): boolean {
    return this.state === 'ground' || this.state === 'land' || this.state === 'load';
  }

  get airborne(): boolean {
    return this.state === 'air';
  }

  /** current horizontal speed */
  get speed(): number {
    return Math.hypot(this.vel.x, this.vel.z);
  }

  /** can a jump start right now? */
  canJump(): boolean {
    if (this.state === 'ground') return true;
    if (this.state === 'land' && this.stateT > PLAYER.landRecover * 0.6) return true;
    return false;
  }

  /** Space pressed: start the plant / load. Returns false if not possible now. */
  jumpPress(): boolean {
    if (!this.canJump()) return false;
    this.state = 'load';
    this.stateT = 0;
    this.loadT = 0;
    this.loadRelease = false;
    this.loadApproach = this.speed;
    this.onStep?.(this, true);
    return true;
  }

  jumpRelease(): void {
    if (this.state === 'load') this.loadRelease = true;
  }

  /** standing jump height as a function of load and approach */
  computeJumpHeight(): number {
    const st = this.stats;
    const appr = clamp01(this.loadApproach / (st.approachSpeed * 0.85));
    const load = clamp01((this.loadT - PLAYER.loadMin) / (PLAYER.loadMax - PLAYER.loadMin));
    const f = st.standingJumpFrac + (1 - st.standingJumpFrac) * (PLAYER.jumpFromApproach * appr + PLAYER.jumpFromLoad * load);
    return this.jumpMax * clamp01(f);
  }

  private takeoff(): void {
    const H = this.computeJumpHeight();
    const g = BALL.gravity;
    const b = PLAYER.apexBand;
    const s = PLAYER.apexGravityScale;
    // solve takeoff speed so the peak (with apex hang) equals H
    const v2 = 2 * g * H + b * b * (1 - 1 / s);
    const vy = Math.sqrt(Math.max(v2, b * b + 0.01));
    this.vel.y = vy;
    this.jumpH = H;
    this.state = 'air';
    this.stateT = 0;
    this.takeoffT = this.time;
    this.takeoffYaw = this.yaw;
    this.takeoffY = this.pos.y;
    this.peakY = this.pos.y;
    this.airT = 0;
    this.onTakeoff?.(this);
  }

  /** current jump progress 0..1 relative to this jump's planned height */
  get jumpFrac(): number {
    if (this.state !== 'air' || this.jumpH <= 0) return 0;
    return clamp01(this.pos.y / this.jumpH);
  }

  /** gravity with a little apex hang */
  static gravityAt(vy: number): number {
    return Math.abs(vy) < PLAYER.apexBand ? BALL.gravity * PLAYER.apexGravityScale : BALL.gravity;
  }

  /** predict airborne feet position dt seconds ahead (ignores nudges) */
  predictAir(dt: number, out: THREE.Vector3): THREE.Vector3 {
    out.copy(this.pos);
    if (this.state !== 'air') {
      out.x += this.vel.x * dt;
      out.z += this.vel.z * dt;
      return out;
    }
    let vy = this.vel.y;
    let y = this.pos.y;
    const h = 1 / 240;
    let t = 0;
    while (t < dt - 1e-9) {
      const st = Math.min(h, dt - t);
      vy -= Athlete.gravityAt(vy) * st;
      y += vy * st;
      t += st;
      if (y <= 0) {
        y = 0;
        break;
      }
    }
    out.x += this.vel.x * dt;
    out.z += this.vel.z * dt;
    out.y = y;
    return out;
  }

  /** time (s from now) to the jump apex, or 0 */
  timeToApex(): number {
    if (this.state !== 'air' || this.vel.y <= 0) return 0;
    let vy = this.vel.y;
    let t = 0;
    while (vy > 0 && t < 2) {
      vy -= Athlete.gravityAt(vy) / 240;
      t += 1 / 240;
    }
    return t;
  }

  step(dt: number, time: number): void {
    this.time = time;
    this.prevPos.copy(this.pos);
    this.prevYaw = this.yaw;
    this.stateT += dt;
    const st = this.stats;
    const cmd = this.cmd;

    // ---- facing (in the air the body barely rotates: the arm aims, not the hips; a dive keeps its line)
    if (this.state !== 'dive' && cmd.faceYaw !== null && Number.isFinite(cmd.faceYaw)) {
      let want = cmd.faceYaw;
      let rate = PLAYER.bodyTurnRate;
      if (this.state === 'air') {
        const d = clamp(wrapAngle(want - this.takeoffYaw), -PLAYER.airTurnMax, PLAYER.airTurnMax);
        want = this.takeoffYaw + d;
        rate = PLAYER.airTurnRate;
      }
      this.yaw = wrapAngle(angleLerp(this.yaw, want, damp(rate, dt)));
    }

    // ---- horizontal movement
    if (this.state === 'ground' || this.state === 'land') {
      let mx = cmd.moveX;
      let mz = cmd.moveZ;
      const mlen = Math.hypot(mx, mz);
      if (mlen > 1) {
        mx /= mlen;
        mz /= mlen;
      }
      // direction-dependent top speed relative to facing
      const fwd = dirFromYaw(this.yaw, _f);
      const right = rightFromYaw(this.yaw, _r);
      const lf = mx * fwd.x + mz * fwd.z;
      const lr = mx * right.x + mz * right.z;
      const top = cmd.sprint ? st.approachSpeed : st.shuffleSpeed;
      const fwdScale = lf >= 0 ? 1 : PLAYER.backpedalScale;
      const ml = Math.hypot(lf, lr) || 1;
      const dirScale = (Math.abs(lf) / ml) * fwdScale + (Math.abs(lr) / ml) * PLAYER.sideScale;
      let topSpeed = top * dirScale;
      if (this.state === 'land') topSpeed *= 0.45 + 0.55 * clamp01(this.stateT / PLAYER.landRecover);
      const dvx = mx * topSpeed - this.vel.x;
      const dvz = mz * topSpeed - this.vel.z;
      const want = Math.hypot(mx * topSpeed, mz * topSpeed);
      const accel = want > this.speed + 0.05 ? st.accel : PLAYER.decel;
      const dl = Math.hypot(dvx, dvz);
      const maxD = accel * dt;
      if (dl > maxD) {
        this.vel.x += (dvx / dl) * maxD;
        this.vel.z += (dvz / dl) * maxD;
      } else {
        this.vel.x += dvx;
        this.vel.z += dvz;
      }
      if (this.state === 'land' && this.stateT >= PLAYER.landRecover) {
        this.state = 'ground';
        this.stateT = 0;
      }
    } else if (this.state === 'load') {
      this.loadT += dt;
      // plant: brake hard down to the carried fraction of approach speed
      const target = this.loadApproach * PLAYER.plantCarry;
      const sp = this.speed;
      if (sp > target) {
        const ns = Math.max(target, sp - 24 * dt);
        const k = sp > 1e-5 ? ns / sp : 0;
        this.vel.x *= k;
        this.vel.z *= k;
      }
      const ready = this.loadT >= PLAYER.loadMin;
      if ((this.loadRelease && ready) || this.loadT >= PLAYER.loadMax) this.takeoff();
    } else if (this.state === 'dive') {
      // hands-first along the floor: the slide brakes to a stop, then the player gets up
      const sp = this.speed;
      const k = sp > 1e-5 ? Math.max(0, sp - PLAYER.diveDecel * dt) / sp : 0;
      this.vel.x *= k;
      this.vel.z *= k;
      if (this.stateT >= PLAYER.diveTime) {
        this.state = 'land';
        this.stateT = 0;
      }
    } else if (this.state === 'air') {
      // tiny air control + assist nudge
      const ac = PLAYER.airControl * dt;
      this.vel.x += cmd.moveX * ac;
      this.vel.z += cmd.moveZ * ac;
      this.vel.x += this.airNudge.x * dt;
      this.vel.z += this.airNudge.z * dt;
    }

    // ---- vertical
    if (this.state === 'air') {
      this.airT += dt;
      this.vel.y -= Athlete.gravityAt(this.vel.y) * dt;
      this.pos.y += this.vel.y * dt;
      if (this.pos.y > this.peakY) this.peakY = this.pos.y;
      if (this.pos.y <= 0 && this.vel.y < 0) {
        this.landImpact = -this.vel.y;
        this.pos.y = 0;
        this.vel.y = 0;
        this.state = 'land';
        this.stateT = 0;
        // absorb some horizontal speed on landing
        this.vel.x *= 0.45;
        this.vel.z *= 0.45;
        this.airNudge.set(0, 0, 0);
        this.onLand?.(this, this.landImpact);
      }
    } else {
      this.pos.y = 0;
      this.vel.y = 0;
    }

    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;

    // ---- court constraints: stay on own side of the centre line (small allowance)
    const minZ = 0.22;
    if (this.side === 1 && this.pos.z < minZ) {
      this.pos.z = minZ;
      if (this.vel.z < 0) this.vel.z = 0;
    } else if (this.side === -1 && this.pos.z > -minZ) {
      this.pos.z = -minZ;
      if (this.vel.z > 0) this.vel.z = 0;
    }
    this.pos.x = clamp(this.pos.x, -COURT.arenaHalfX + 3.5, COURT.arenaHalfX - 3.5);
    this.pos.z = clamp(this.pos.z, -COURT.arenaHalfZ + 4.5, COURT.arenaHalfZ - 4.5);

    // ---- gait
    const sp = this.speed;
    if (this.state === 'ground' || this.state === 'land') {
      const stride = lerp(1.1, 2.1, clamp01((sp - 1) / 4));
      const prev = this.gaitPhase;
      this.gaitPhase += (sp * dt) / stride;
      if (Math.floor(prev * 2) !== Math.floor(this.gaitPhase * 2) && sp > 0.6) this.onStep?.(this, false);
    }
    const sprintTarget = cmd.sprint && sp > 2.5 ? clamp01(sp / st.approachSpeed) : 0;
    this.sprint = lerp(this.sprint, this.state === 'air' || this.state === 'load' ? this.sprint : sprintTarget, damp(5, dt));
  }

  /** compute render interpolation */
  interpolate(alpha: number): void {
    this.rpos.lerpVectors(this.prevPos, this.pos, alpha);
    this.ryaw = angleLerp(this.prevYaw, this.yaw, alpha);
  }

  /**
   * Throw the body at a ball out of reach (AI defenders): hands-first along `yaw`, at
   * `PLAYER.diveSpeed` at least, sliding on the floor; up again `PLAYER.diveTime` later.
   */
  dive(yaw: number): void {
    if (this.state !== 'ground' && this.state !== 'land') return;
    this.state = 'dive';
    this.stateT = 0;
    this.yaw = yaw;
    const d = dirFromYaw(yaw, _f);
    const along = Math.max(PLAYER.diveSpeed, this.vel.x * d.x + this.vel.z * d.z);
    this.vel.x = d.x * along;
    this.vel.z = d.z * along;
  }

  /** begin an action (animation + contact bookkeeping read it) */
  startAction(kind: ActionKind, t: number): Action {
    if (this.action) this.lastAction = this.action;
    const act: Action = {
      kind,
      t0: t,
      held: true,
      releaseT: -1,
      contactT: -1,
      contactPoint: new THREE.Vector3(),
      resolved: false,
      grade: null,
      tip: false,
      push: false,
      miss: false,
      hand: 'R',
      aim: new THREE.Vector3(0, 0, -1),
      err: 0,
      note: '',
      minD: 1e9,
      charge: 0,
      idealT: -1,
      idealD: 1e9,
      idealFor: null,
      form: 'platform',
    };
    this.action = act;
    return act;
  }

  endAction(): void {
    if (this.action) this.lastAction = this.action;
    this.action = null;
  }

  /** world position of the ideal spike contact point for the current body position */
  idealContact(out: THREE.Vector3, at?: THREE.Vector3): THREE.Vector3 {
    const p = at ?? this.pos;
    const f = dirFromYaw(this.yaw, _f);
    const r = this.hitSide(_r);
    const H = this.height;
    // ball centre in front of the hitting shoulder, a palm below full reach
    return out.set(p.x + r.x * 0.09 * H + f.x * 0.1 * H, p.y + this.standReach - 0.16, p.z + r.z * 0.09 * H + f.z * 0.1 * H);
  }

  /** right / hitting-hand side vector */
  forward(out = new THREE.Vector3()): THREE.Vector3 {
    return dirFromYaw(this.yaw, out);
  }

  right(out = new THREE.Vector3()): THREE.Vector3 {
    return rightFromYaw(this.yaw, out);
  }

  /** unit vector towards the hitting-hand side (the right for a righty, the left for a lefty) */
  hitSide(out = new THREE.Vector3()): THREE.Vector3 {
    return rightFromYaw(this.yaw, out).multiplyScalar(this.hand);
  }
}

/** +1 for a right-handed athlete, -1 for a lefty */
export function handSign(hand?: Hand): 1 | -1 {
  return hand === 'left' ? -1 : 1;
}

const _f = new THREE.Vector3();
const _r = new THREE.Vector3();
