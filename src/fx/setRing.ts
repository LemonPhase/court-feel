import * as THREE from 'three';
import { BALL, FX } from '../config';
import type { SetPreview } from '../game/contact';

/**
 * The set's catch cue, around the ball so your eyes stay on it: a thin ring closes onto the
 * ball, reaching the green band just outside it as the ball reaches your hands. Press while it
 * is in the green band for a clean catch; the faint band around it is where the catch starts to
 * cost you. Amber until you press, white once you have. Once caught, the bar (SetBar) takes over.
 * Translucent, never over the ball, never a flash.
 */
export class SetRing {
  readonly group = new THREE.Group();
  private closing: THREE.Mesh;
  private green: THREE.Mesh;
  private good: THREE.Mesh;
  private shown: [number, number] = [-1, -1];

  constructor(scene: THREE.Scene) {
    const mat = (color: number, opacity: number) =>
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
    this.good = new THREE.Mesh(new THREE.RingGeometry(0.5, 2, 48), mat(0xffffff, FX.setRing.goodOpacity));
    this.green = new THREE.Mesh(new THREE.RingGeometry(0.8, 1.25, 48), mat(0x3ddc84, FX.setRing.greenOpacity));
    this.closing = new THREE.Mesh(new THREE.RingGeometry(0.93, 1, 64), mat(0xffffff, 0.95));
    this.good.renderOrder = 10;
    this.green.renderOrder = 11;
    this.closing.renderOrder = 12;
    this.group.add(this.good, this.green, this.closing);
    this.group.visible = false;
    scene.add(this.group);
  }

  /** radius (in ball radii) of the ring `dt` seconds before the ball reaches the hands */
  static radius(dt: number): number {
    return FX.setRing.atContact * Math.exp(FX.setRing.perSecond * dt);
  }

  /** a band from `dt` early to `dt` late, kept off the ball itself */
  private static band(dt: number, R: number): THREE.RingGeometry {
    const inner = Math.max(1.05, SetRing.radius(-dt));
    return new THREE.RingGeometry(inner * R, Math.max(inner + 0.05, SetRing.radius(dt)) * R, 48);
  }

  update(p: SetPreview | null, ballPos: THREE.Vector3, simTime: number, camera: THREE.Camera, show: boolean): void {
    const until = p ? p.tIdeal - simTime : 0;
    this.group.visible = show && !!p && !p.absorbing && until < FX.setRing.showFor;
    if (!this.group.visible || !p) return;
    const R = BALL.radius;
    this.group.position.copy(ballPos);
    this.group.quaternion.copy(camera.quaternion);
    // the bands: rebuilt only when the catch window changes (the level)
    if (Math.abs(this.shown[0] - p.catchClean) > 0.001 || Math.abs(this.shown[1] - p.catchEdge) > 0.001) {
      this.shown = [p.catchClean, p.catchEdge];
      this.green.geometry.dispose();
      this.green.geometry = SetRing.band(p.catchClean, R);
      this.good.geometry.dispose();
      this.good.geometry = SetRing.band(p.catchEdge, R);
    }
    // past the moment it keeps closing onto the ball, never inside it
    this.closing.scale.setScalar(Math.max(1.05, SetRing.radius(until)) * R);
    (this.closing.material as THREE.MeshBasicMaterial).color.setHex(p.pressed ? 0xffffff : 0xffb54a);
  }

  hide(): void {
    this.group.visible = false;
  }
}
