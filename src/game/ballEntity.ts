import * as THREE from 'three';
import { BALL, SIM } from '../config';
import { clamp01, damp, lerp } from '../core/mathx';
import { copyBall, makeBall, R, stepBall, type BallEnv, type BallState, type CollisionEvent } from '../physics/ball';
import { BallPredictor } from '../physics/predict';
import { makeBallTexture, makeBlobTexture, makeRingTexture } from '../world/textures';
import type { Athlete } from './athlete';

export type TouchKind = 'spike' | 'tip' | 'block' | 'pass' | 'dig' | 'set' | 'serve' | 'free' | 'feed';

export interface Touch {
  athlete: Athlete | null;
  kind: TouchKind;
  t: number;
  side: 1 | -1 | 0;
}

/**
 * The live ball: physics state + previous state for interpolation, visual
 * rotation from the angular velocity, the timing-cue shadow blob and the
 * predicted landing marker.
 */
export class BallEntity {
  readonly state: BallState = makeBall();
  private prev: BallState = makeBall();
  readonly rpos = new THREE.Vector3();
  readonly mesh: THREE.Mesh;
  private q = new THREE.Quaternion();
  private prevQ = new THREE.Quaternion();
  private shadow: THREE.Mesh;
  private marker: THREE.Mesh;
  private markerInner: THREE.Mesh;
  readonly predictor = new BallPredictor(1 / SIM.hz, SIM.predictHorizon);
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
  markerColor = new THREE.Color(0.85, 0.7, 0.22);
  /** sim time of the last launch / touch */
  lastLaunchT = 0;

  constructor(scene: THREE.Scene) {
    const tex = makeBallTexture();
    this.mesh = new THREE.Mesh(
      new THREE.SphereGeometry(R, 32, 20),
      new THREE.MeshStandardMaterial({
        map: tex, roughness: 0.42, metalness: 0, envMapIntensity: 0.9,
        // a touch of self-illumination keeps the ball readable from below against the ceiling
        emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.22,
      }),
    );
    this.mesh.castShadow = true;
    scene.add(this.mesh);

    const blob = makeBlobTexture(0, 0.4);
    this.shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: blob, color: 0x000000, transparent: true, opacity: 0.5, depthWrite: false }),
    );
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.renderOrder = 2;
    scene.add(this.shadow);

    const ring = makeRingTexture(0.14);
    this.marker = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        map: ring, color: this.markerColor, transparent: true, opacity: 0.8, depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.marker.rotation.x = -Math.PI / 2;
    this.marker.renderOrder = 3;
    scene.add(this.marker);
    this.markerInner = new THREE.Mesh(
      new THREE.CircleGeometry(0.09, 20),
      new THREE.MeshBasicMaterial({ color: this.markerColor, transparent: true, opacity: 0.7, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    this.markerInner.rotation.x = -Math.PI / 2;
    this.markerInner.renderOrder = 3;
    scene.add(this.markerInner);
  }

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
  launch(p: { x: number; y: number; z: number }, v: { x: number; y: number; z: number }, w = { x: 0, y: 0, z: 0 }, knuckle = 0, t = 0): void {
    const s = this.state;
    s.p.x = p.x; s.p.y = p.y; s.p.z = p.z;
    s.v.x = v.x; s.v.y = v.y; s.v.z = v.z;
    s.w.x = w.x; s.w.y = w.y; s.w.z = w.z;
    s.knuckle = knuckle;
    s.kt = 0;
    s.rest = false;
    copyBall(s, this.prev);
    this.prevQ.copy(this.q);
    this.version++;
    this.active = true;
    this.lastLaunchT = t;
  }

  /** change velocity in place (contact), keeping interpolation continuous */
  hit(v: { x: number; y: number; z: number }, w: { x: number; y: number; z: number }, knuckle = 0, t = 0): void {
    const s = this.state;
    s.v.x = v.x; s.v.y = v.y; s.v.z = v.z;
    s.w.x = w.x; s.w.y = w.y; s.w.z = w.z;
    s.knuckle = knuckle;
    s.kt = 0;
    s.rest = false;
    this.version++;
    this.lastLaunchT = t;
  }

  /** make sure the prediction reflects the current state */
  ensurePrediction(env: BallEnv, t: number): BallPredictor {
    if (this.predictedVersion !== this.version) {
      this.predictor.compute(this.state, env, t);
      this.predictedVersion = this.version;
    }
    return this.predictor;
  }

  step(dt: number, env: BallEnv): void {
    copyBall(this.state, this.prev);
    this.prevQ.copy(this.q);
    this.events.length = 0;
    if (!this.active) return;
    stepBall(this.state, dt, env, this.events);
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

  interpolate(alpha: number): void {
    const a = this.prev.p;
    const b = this.state.p;
    this.rpos.set(lerp(a.x, b.x, alpha), lerp(a.y, b.y, alpha), lerp(a.z, b.z, alpha));
    this.mesh.position.copy(this.rpos);
    this.mesh.quaternion.slerpQuaternions(this.prevQ, this.q, alpha);
  }

  /** visual helpers (shadow blob + landing marker) */
  updateVisuals(dt: number, simT: number, env: BallEnv): void {
    this.mesh.visible = this.visible && this.active;
    const h = Math.max(0, this.rpos.y - R);
    const show = this.visible && this.active;
    this.shadow.visible = show;
    if (show) {
      // the timing cue: tight and dark when the ball is low, wide and faint when high
      const s = R * 2.2 + h * 0.07;
      this.shadow.scale.set(s, s, 1);
      this.shadow.position.set(this.rpos.x, 0.006, this.rpos.z);
      (this.shadow.material as THREE.MeshBasicMaterial).opacity = lerp(0.62, 0.16, clamp01(h / 9));
    }
    // landing marker
    const pred = this.ensurePrediction(env, simT);
    const inFlight = show && !this.state.rest && pred.landT > simT + 0.05 && this.rpos.y > R + 0.2;
    const m = this.marker;
    const mat = m.material as THREE.MeshBasicMaterial;
    const target = this.showMarker && inFlight ? 1 : 0;
    mat.opacity = lerp(mat.opacity, target * 0.85, damp(10, dt));
    m.visible = mat.opacity > 0.02;
    this.markerInner.visible = m.visible;
    if (m.visible && pred.landT > 0) {
      const tl = Math.max(0, pred.landT - simT);
      const sz = lerp(0.42, 2.4, clamp01(tl / 1.6));
      m.scale.set(sz, sz, 1);
      m.position.set(pred.land.x, 0.008, pred.land.z);
      this.markerInner.position.set(pred.land.x, 0.009, pred.land.z);
      (this.markerInner.material as THREE.MeshBasicMaterial).opacity = mat.opacity * 0.8;
      mat.color.copy(this.markerColor);
      (this.markerInner.material as THREE.MeshBasicMaterial).color.copy(this.markerColor);
    }
  }

  hide(): void {
    this.active = false;
    this.mesh.visible = false;
    this.shadow.visible = false;
    this.marker.visible = false;
    this.markerInner.visible = false;
  }
}

const _axis = new THREE.Vector3();
const _dq = new THREE.Quaternion();
export { BALL };
