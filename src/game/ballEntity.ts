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
  /** an attack off the user's green set: the hitter hid the shot until the hand (their defence starts late) */
  green?: boolean;
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
  /** dark outline under the ring and dot: keeps the marker readable on the bright wood */
  private markerBack: THREE.Mesh;
  private markerDotBack: THREE.Mesh;
  /** thin post standing on the landing spot: readable from low camera angles where a floor ring is foreshortened */
  private markerPin: THREE.Mesh;
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
  /** cool against the warm wood; modes recolour it (e.g. green for "your ball") */
  markerColor = new THREE.Color(0.3, 0.85, 1.0);
  /** sim time of the last launch / touch */
  lastLaunchT = 0;

  constructor(scene: THREE.Scene) {
    const tex = makeBallTexture();
    this.mesh = new THREE.Mesh(
      new THREE.SphereGeometry(R, 32, 20),
      new THREE.MeshStandardMaterial({
        map: tex,
        roughness: 0.42,
        metalness: 0,
        envMapIntensity: 0.9,
        // a touch of self-illumination keeps the ball readable from below against the ceiling
        emissive: 0xffffff,
        emissiveMap: tex,
        emissiveIntensity: 0.22,
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

    // Landing marker. Normal (not additive) blending: additive colour nearly vanishes on the
    // bright floor. A dark, slightly wider ring underneath outlines the coloured one.
    const ring = makeRingTexture(0.18);
    const flat = (geo: THREE.BufferGeometry, mat: THREE.Material, order: number): THREE.Mesh => {
      // the court and its lines are pulled towards the camera with polygon offset; pull harder
      // or they win the depth test and swallow the marker at grazing angles
      mat.polygonOffset = true;
      mat.polygonOffsetFactor = -4;
      mat.polygonOffsetUnits = -4;
      const m = new THREE.Mesh(geo, mat);
      m.rotation.x = -Math.PI / 2;
      m.renderOrder = order;
      scene.add(m);
      return m;
    };
    this.markerBack = flat(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: makeRingTexture(0.28), color: 0x000000, transparent: true, opacity: 0.6, depthWrite: false }),
      3,
    );
    this.marker = flat(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: ring, color: this.markerColor, transparent: true, opacity: 0.9, depthWrite: false }),
      4,
    );
    this.markerDotBack = flat(
      new THREE.CircleGeometry(0.12, 24),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.45, depthWrite: false }),
      3,
    );
    this.markerInner = flat(
      new THREE.CircleGeometry(0.085, 24),
      new THREE.MeshBasicMaterial({ color: this.markerColor, transparent: true, opacity: 0.9, depthWrite: false }),
      4,
    );
    // unit-height post, pivot at the floor; scaled in y per frame
    const pinGeo = new THREE.CylinderGeometry(0.022, 0.03, 1, 10, 1, true);
    pinGeo.translate(0, 0.5, 0);
    this.markerPin = new THREE.Mesh(
      pinGeo,
      new THREE.MeshBasicMaterial({ color: this.markerColor, transparent: true, opacity: 0.7, depthWrite: false, side: THREE.DoubleSide }),
    );
    this.markerPin.renderOrder = 4;
    scene.add(this.markerPin);
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
  launch(
    p: { x: number; y: number; z: number },
    v: { x: number; y: number; z: number },
    w = { x: 0, y: 0, z: 0 },
    knuckle = 0,
    t = 0,
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
    s.v.x = v.x;
    s.v.y = v.y;
    s.v.z = v.z;
    s.w.x = w.x;
    s.w.y = w.y;
    s.w.z = w.z;
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
    const fade = lerp(mat.opacity / 0.9, target, damp(10, dt)); // 0..1
    mat.opacity = fade * 0.9;
    m.visible = mat.opacity > 0.02;
    this.markerBack.visible = m.visible;
    this.markerInner.visible = m.visible;
    this.markerDotBack.visible = m.visible;
    this.markerPin.visible = m.visible;
    if (m.visible && pred.landT > 0) {
      const tl = Math.max(0, pred.landT - simT);
      const lx = pred.land.x;
      const lz = pred.land.z;
      // the ring closes in on the spot as the ball comes down: a size you can still read far out
      const sz = lerp(0.5, 1.5, clamp01(tl / 1.4));
      m.scale.set(sz, sz, 1);
      m.position.set(lx, 0.009, lz);
      this.markerBack.scale.set(sz * 1.08, sz * 1.08, 1);
      this.markerBack.position.set(lx, 0.008, lz);
      (this.markerBack.material as THREE.MeshBasicMaterial).opacity = fade * 0.6;
      this.markerInner.position.set(lx, 0.011, lz);
      (this.markerInner.material as THREE.MeshBasicMaterial).opacity = fade * 0.9;
      this.markerDotBack.position.set(lx, 0.01, lz);
      (this.markerDotBack.material as THREE.MeshBasicMaterial).opacity = fade * 0.45;
      // the pin stands tall while the ball is far off and sinks into the floor as it arrives,
      // so it never pokes up through the ball or the receiver's platform at contact
      const pinH = lerp(0, 1.1, clamp01((tl - 0.15) / 1.2));
      this.markerPin.scale.set(1, Math.max(pinH, 1e-3), 1);
      this.markerPin.position.set(lx, 0, lz);
      const pinMat = this.markerPin.material as THREE.MeshBasicMaterial;
      pinMat.opacity = fade * 0.7 * clamp01(pinH / 0.25);
      mat.color.copy(this.markerColor);
      (this.markerInner.material as THREE.MeshBasicMaterial).color.copy(this.markerColor);
      pinMat.color.copy(this.markerColor);
    }
  }

  hide(): void {
    this.active = false;
    this.mesh.visible = false;
    this.shadow.visible = false;
    this.marker.visible = false;
    this.markerInner.visible = false;
    this.markerBack.visible = false;
    this.markerDotBack.visible = false;
    this.markerPin.visible = false;
  }
}

const _axis = new THREE.Vector3();
const _dq = new THREE.Quaternion();
export { BALL };
