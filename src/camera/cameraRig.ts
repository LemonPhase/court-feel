import * as THREE from 'three';
import { CAMERA, COURT } from '../config';
import { clamp, damp, lerp, noise1 } from '../core/mathx';

export type CamMode = 'fp' | 'tp' | 'cine' | 'menu';

export interface FollowTarget {
  /** feet position (render-interpolated) */
  root: THREE.Vector3;
  /** first-person eye position (render-interpolated, stabilised) */
  eye: THREE.Vector3;
  /** 0..1 how hard the athlete is approaching (FOV boost) */
  sprint: number;
  /** athlete height, for TP pivot */
  height: number;
  /** team side sign: +1 user plays on +z */
  side: number;
}

const _q = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _ray = new THREE.Ray();
const _hit = new THREE.Vector3();
/** spring stiffness (rad/s) of the FOV punch and of the camera kick */
const FOV_W = 17;
const KICK_W = 24;

/**
 * First / third person camera with shared yaw+pitch so the aim direction is
 * preserved when toggling. Mouse rotation is applied directly (no smoothing);
 * only the TP pivot position is spring-smoothed.
 */
export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  mode: CamMode = 'tp';
  yaw = 0;
  pitch = -0.12;
  baseFov: number = CAMERA.fov;
  private fovBoost = 0;
  private pivot = new THREE.Vector3();
  private pivotInit = false;
  private tpDist: number = CAMERA.tpDistance;
  private trauma = 0;
  private shakeTime = 0;
  shakeScale = 1;
  /** TP: +1 over the right shoulder, -1 over the left (follows the user's hitting hand) */
  shoulderSide: 1 | -1 = 1;
  /** FOV punch (degrees, springs back to 0) and a directional kick (pitch rad, height m) */
  private fovKick = 0;
  private fovKickV = 0;
  private kickPitch = 0;
  private kickPitchV = 0;
  private kickY = 0;
  private kickYV = 0;
  /** set by the game during a hit-stop: the FOV punch holds on the freeze frame */
  frozen = false;
  /** TP camera keeps the ball in frame */
  ballPos: THREE.Vector3 | null = null;
  blockers: THREE.Box3[] = [];
  /** world-space distance from camera to TP pivot, used to fade our own athlete */
  tpCamToPivot = 10;
  /** cinematic */
  cinePos = new THREE.Vector3();
  cineTarget = new THREE.Vector3();
  cineFov = 50;
  menuTime = 0;
  netTop: number = COURT.netHeightMen;

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(CAMERA.fov, aspect, CAMERA.near, CAMERA.far);
    this.camera.rotation.order = 'YXZ';
  }

  look(dx: number, dy: number, sens: number, invertY: boolean): void {
    this.yaw -= dx * CAMERA.sensitivity * sens;
    this.pitch -= dy * CAMERA.sensitivity * sens * (invertY ? -1 : 1);
    this.clampPitch();
  }

  clampPitch(): void {
    if (this.mode === 'tp') this.pitch = clamp(this.pitch, CAMERA.tpPitchMin, CAMERA.tpPitchMax);
    else this.pitch = clamp(this.pitch, CAMERA.fpPitchMin, CAMERA.fpPitchMax);
  }

  setMode(m: CamMode): void {
    this.mode = m;
    if (m === 'tp') this.pivotInit = false;
    this.clampPitch();
  }

  /** jump straight to the target next update (after a teleport) */
  snap(): void {
    this.pivotInit = false;
    this.tpDist = CAMERA.tpDistance;
  }

  addTrauma(t: number): void {
    this.trauma = Math.min(1, this.trauma + t);
  }

  /** snap the FOV by `deg` (negative = punch in); it holds while frozen, then springs back */
  punchFov(deg: number): void {
    this.fovKick = deg * this.shakeScale;
    this.fovKickV = 0;
  }

  /** a jolt that springs back: `pitch` (rad, negative = nod down) and `y` (m) peak offsets */
  kick(pitch: number, y: number): void {
    // peak displacement of the spring below (damping 0.5) is ~0.55 * v0 / w
    this.kickPitchV += (pitch * this.shakeScale * KICK_W) / 0.55;
    this.kickYV += (y * this.shakeScale * KICK_W) / 0.55;
  }

  private springs(dt: number): void {
    let left = Math.min(dt, 0.1);
    while (left > 1e-6) {
      const h = Math.min(left, 1 / 240);
      left -= h;
      // semi-implicit Euler, under-damped (a small overshoot reads as a snap, not a drift)
      if (!this.frozen) {
        this.fovKickV += (-FOV_W * FOV_W * this.fovKick - 2 * 0.42 * FOV_W * this.fovKickV) * h;
        this.fovKick += this.fovKickV * h;
      }
      this.kickPitchV += (-KICK_W * KICK_W * this.kickPitch - 2 * 0.5 * KICK_W * this.kickPitchV) * h;
      this.kickPitch += this.kickPitchV * h;
      this.kickYV += (-KICK_W * KICK_W * this.kickY - 2 * 0.5 * KICK_W * this.kickYV) * h;
      this.kickY += this.kickYV * h;
    }
  }

  private applyKick(): void {
    if (Math.abs(this.kickPitch) < 1e-5 && Math.abs(this.kickY) < 1e-5) return;
    this.camera.rotation.x += this.kickPitch;
    this.camera.position.y += this.kickY;
  }

  /** world-space forward of the aim (camera) direction */
  aimDir(out = new THREE.Vector3()): THREE.Vector3 {
    _e.set(this.pitch, this.yaw, 0, 'YXZ');
    return out.set(0, 0, -1).applyEuler(_e);
  }

  update(dt: number, t: FollowTarget | null): void {
    const cam = this.camera;
    this.shakeTime += dt;
    this.trauma = Math.max(0, this.trauma - dt * CAMERA.shakeDecay * 0.5);
    this.springs(dt);

    if (this.mode === 'menu') {
      this.menuTime += dt;
      const a = this.menuTime * 0.06 + 0.6;
      cam.position.set(Math.sin(a) * 15, 5.2 + Math.sin(this.menuTime * 0.1) * 0.6, Math.cos(a) * 15);
      cam.lookAt(0, 1.6, 0);
      this.setFov(52, dt, true);
      return;
    }
    if (this.mode === 'cine') {
      cam.position.copy(this.cinePos);
      cam.lookAt(this.cineTarget);
      this.setFov(this.cineFov, dt, true);
      this.applyShake(0.4);
      return;
    }
    if (!t) return;

    const sprintTarget = t.sprint * CAMERA.fovApproachBoost;
    this.fovBoost = lerp(this.fovBoost, sprintTarget, damp(4, dt));

    if (this.mode === 'fp') {
      _dir.set(0, 0, -1).applyEuler(_e.set(0, this.yaw, 0, 'YXZ'));
      cam.position.copy(t.eye).addScaledVector(_dir, CAMERA.fpEyeForward);
      // standing (or blocking) right at the net, the lens would get closer to the net than the near
      // plane and the net would be clipped away: you would seem to see from their side. Hold it back.
      const minZ = CAMERA.fpNear + CAMERA.fpNetGap;
      if (Math.abs(cam.position.x) < COURT.postX + 0.5 && cam.position.z * t.side < minZ) cam.position.z = t.side * minZ;
      cam.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
      this.setFov(this.baseFov + this.fovBoost + this.fovKick, dt, false);
      this.applyShake(CAMERA.fpShakeScale);
      this.applyKick();
      this.tpCamToPivot = 0;
      return;
    }

    // ---------------- third person
    const pivotTarget = _v.set(t.root.x, t.root.y * 0.85 + CAMERA.tpHeight * (t.height / 1.95), t.root.z);
    if (!this.pivotInit) {
      this.pivot.copy(pivotTarget);
      this.pivotInit = true;
    } else {
      const k = damp(CAMERA.tpFollowStiffness, dt);
      this.pivot.x = lerp(this.pivot.x, pivotTarget.x, k);
      this.pivot.z = lerp(this.pivot.z, pivotTarget.z, k);
      this.pivot.y = lerp(this.pivot.y, pivotTarget.y, damp(CAMERA.tpFollowStiffness * 0.6, dt));
    }

    // frame the ball: dolly back when the ball is high above / far off-axis
    let want: number = CAMERA.tpDistance;
    if (this.ballPos) {
      _v2.copy(this.ballPos).sub(this.pivot);
      const horiz = Math.hypot(_v2.x, _v2.z);
      const elev = Math.atan2(_v2.y, Math.max(0.5, horiz));
      const camElev = this.pitch;
      const halfV = THREE.MathUtils.degToRad(cam.fov) * 0.5;
      const excess = elev - camElev - halfV * 0.72;
      if (excess > 0 && horiz < 14) want += clamp(excess * 6, 0, CAMERA.tpDistanceMax - CAMERA.tpDistance) * CAMERA.tpFrameBall;
    }
    this.tpDist = lerp(this.tpDist, want, damp(3, dt));

    _e.set(this.pitch, this.yaw, 0, 'YXZ');
    _q.setFromEuler(_e);
    const offset = _v2.set(CAMERA.tpShoulder * this.shoulderSide, 0.0, this.tpDist).applyQuaternion(_q);
    // obstacle test: ray from pivot to desired position
    let dist = offset.length();
    _dir.copy(offset).divideScalar(dist);
    _ray.set(this.pivot, _dir);
    for (const b of this.blockers) {
      if (_ray.intersectBox(b, _hit)) {
        const d = _hit.distanceTo(this.pivot);
        if (d < dist) dist = Math.max(0.35, d - 0.18);
      }
    }
    cam.position.copy(this.pivot).addScaledVector(_dir, dist);
    // never cross to the other side of the net plane under the tape
    const netTop = this.netTop;
    if (cam.position.y < netTop + 0.2 && Math.sign(cam.position.z) !== Math.sign(t.side) && Math.abs(cam.position.z) > 0) {
      cam.position.z = t.side * 0.18;
    }
    cam.position.y = Math.max(0.3, cam.position.y);
    cam.position.x = clamp(cam.position.x, -COURT.arenaHalfX + 1, COURT.arenaHalfX - 1);
    cam.position.z = clamp(cam.position.z, -COURT.arenaHalfZ + 1, COURT.arenaHalfZ - 1);
    cam.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
    this.tpCamToPivot = cam.position.distanceTo(this.pivot);
    this.setFov(this.baseFov + this.fovBoost * 0.6 + this.fovKick, dt, false);
    this.applyShake(1);
    this.applyKick();
  }

  private setFov(f: number, dt: number, smooth: boolean): void {
    const cam = this.camera;
    const nf = smooth ? lerp(cam.fov, f, damp(3, dt)) : f;
    const near = this.mode === 'fp' ? CAMERA.fpNear : CAMERA.near;
    if (Math.abs(nf - cam.fov) > 1e-3 || cam.near !== near) {
      cam.fov = nf;
      cam.near = near;
      cam.updateProjectionMatrix();
    }
  }

  private applyShake(scale: number): void {
    const s = this.trauma * this.trauma * scale * this.shakeScale;
    if (s <= 1e-4) return;
    const t = this.shakeTime * 28;
    const cam = this.camera;
    cam.rotation.x += noise1(t, 1) * CAMERA.shakeMaxAngle * s;
    cam.rotation.y += noise1(t, 2) * CAMERA.shakeMaxAngle * s;
    cam.rotation.z += noise1(t, 3) * CAMERA.shakeMaxAngle * 0.6 * s;
    cam.position.x += noise1(t, 4) * CAMERA.shakeMaxOffset * s;
    cam.position.y += noise1(t, 5) * CAMERA.shakeMaxOffset * s;
  }

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }
}
