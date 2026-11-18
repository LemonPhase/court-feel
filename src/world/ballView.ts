import * as THREE from 'three';
import { BALL_LOOK } from '../config';
import { clamp01, damp, lerp } from '../core/mathx';
import type { BallEntity } from '../game/ballEntity';
import { R, type BallEnv } from '../physics/ball';
import { makeBallTextures, makeBlobTexture, makeRingTexture } from './textures';

/**
 * The ball as it is drawn: the ball itself, the timing-cue shadow blob under it and the predicted
 * landing marker. It reads the simulation's ball (game/ballEntity.ts) and never changes it.
 */
export class BallView {
  readonly mesh: THREE.Mesh;
  private shadow: THREE.Mesh;
  private marker: THREE.Mesh;
  private markerInner: THREE.Mesh;
  /** dark outline under the ring and dot: keeps the marker readable on the bright wood */
  private markerBack: THREE.Mesh;
  private markerDotBack: THREE.Mesh;
  /** thin post standing on the landing spot: readable from low camera angles where a floor ring is foreshortened */
  private markerPin: THREE.Mesh;

  constructor(
    scene: THREE.Scene,
    private ball: BallEntity,
  ) {
    const { map: tex, bump } = makeBallTextures();
    this.mesh = new THREE.Mesh(
      new THREE.SphereGeometry(R, 48, 32),
      new THREE.MeshStandardMaterial({
        map: tex,
        bumpMap: bump,
        bumpScale: BALL_LOOK.seamDepth,
        roughness: 0.46,
        metalness: 0,
        envMapIntensity: 0.9,
        // a touch of self-illumination keeps the ball readable from below against the ceiling
        emissive: 0xffffff,
        emissiveMap: tex,
        emissiveIntensity: BALL_LOOK.glow,
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
      new THREE.MeshBasicMaterial({ map: ring, color: ball.markerColor, transparent: true, opacity: 0.9, depthWrite: false }),
      4,
    );
    this.markerDotBack = flat(
      new THREE.CircleGeometry(0.12, 24),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.45, depthWrite: false }),
      3,
    );
    this.markerInner = flat(
      new THREE.CircleGeometry(0.085, 24),
      new THREE.MeshBasicMaterial({ color: ball.markerColor, transparent: true, opacity: 0.9, depthWrite: false }),
      4,
    );
    // unit-height post, pivot at the floor; scaled in y per frame
    const pinGeo = new THREE.CylinderGeometry(0.022, 0.03, 1, 10, 1, true);
    pinGeo.translate(0, 0.5, 0);
    this.markerPin = new THREE.Mesh(
      pinGeo,
      new THREE.MeshBasicMaterial({ color: ball.markerColor, transparent: true, opacity: 0.7, depthWrite: false, side: THREE.DoubleSide }),
    );
    this.markerPin.renderOrder = 4;
    scene.add(this.markerPin);
    ball.onHide = () => this.hide();
  }

  /** each frame, after the ball's `interpolate`: the mesh goes where the ball is drawn */
  sync(): void {
    this.mesh.position.copy(this.ball.rpos);
    this.mesh.quaternion.copy(this.ball.rquat);
  }

  /** each frame, after `sync`: the shadow blob and the landing marker */
  update(dt: number, simT: number, env: BallEnv): void {
    const ball = this.ball;
    this.mesh.visible = ball.visible && ball.active;
    const h = Math.max(0, ball.rpos.y - R);
    const show = ball.visible && ball.active;
    this.shadow.visible = show;
    if (show) {
      // the timing cue: tight and dark when the ball is low, wide and faint when high
      const s = R * 2.2 + h * 0.07;
      this.shadow.scale.set(s, s, 1);
      this.shadow.position.set(ball.rpos.x, 0.006, ball.rpos.z);
      (this.shadow.material as THREE.MeshBasicMaterial).opacity = lerp(0.62, 0.16, clamp01(h / 9));
    }
    // landing marker
    const pred = ball.ensurePrediction(env, simT);
    const inFlight = show && !ball.state.rest && pred.landT > simT + 0.05 && ball.rpos.y > R + 0.2;
    const m = this.marker;
    const mat = m.material as THREE.MeshBasicMaterial;
    const target = ball.showMarker && inFlight ? 1 : 0;
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
      mat.color.copy(ball.markerColor);
      (this.markerInner.material as THREE.MeshBasicMaterial).color.copy(ball.markerColor);
      pinMat.color.copy(ball.markerColor);
    }
  }

  /** off the court at once (the ball was hidden): the next `update` would be a frame late */
  hide(): void {
    this.mesh.visible = false;
    this.shadow.visible = false;
    this.marker.visible = false;
    this.markerInner.visible = false;
    this.markerBack.visible = false;
    this.markerDotBack.visible = false;
    this.markerPin.visible = false;
  }
}
