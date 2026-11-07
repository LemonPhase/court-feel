import * as THREE from 'three';
import { CONTACT, FX } from '../config';
import { damp } from '../core/mathx';
import { makeRingTexture } from '../world/textures';

const OFF = new THREE.Color(0xffffff);
const ON = new THREE.Color(0x3ddc84);

/**
 * Where to stand for your set: a floor spot under where the ball comes down through your hands
 * (your feet, not where the ball would land). It fills green once your feet are on it, within
 * the touch's clean-centring distance (CONTACT.setCentreOk). Shown instead of the landing marker
 * while the ball is yours to set. A dark outline keeps it readable on the bright wood.
 */
export class SetSpot {
  private back: THREE.Mesh;
  private ring: THREE.Mesh;
  private disc: THREE.Mesh;
  private fade = 0;

  constructor(scene: THREE.Scene) {
    const r = FX.setSpot.radius;
    const tex = makeRingTexture(0.2);
    const flat = (geo: THREE.BufferGeometry, mat: THREE.MeshBasicMaterial, order: number) => {
      const m = new THREE.Mesh(geo, mat);
      m.rotation.x = -Math.PI / 2;
      m.renderOrder = order;
      m.visible = false;
      scene.add(m);
      return m;
    };
    // the court and its lines are pulled towards the camera with polygon offset: pull harder (as the landing marker does)
    const mat = (color: THREE.Color | number, map: THREE.Texture | null) =>
      new THREE.MeshBasicMaterial({
        map,
        color,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -4,
        polygonOffsetUnits: -4,
      });
    this.back = flat(new THREE.PlaneGeometry(r * 2.6, r * 2.6), mat(0x05070c, tex), 3);
    this.ring = flat(new THREE.PlaneGeometry(r * 2.4, r * 2.4), mat(OFF, tex), 4);
    this.disc = flat(new THREE.CircleGeometry(CONTACT.setCentreOk + 0.05, 32), mat(OFF, null), 4);
  }

  /** `spot` your feet's spot (null: hide), `feet` where they are now */
  update(spot: { x: number; z: number } | null, feet: THREE.Vector3, dt: number): void {
    this.fade += ((spot ? 1 : 0) - this.fade) * damp(10, dt);
    const show = this.fade > 0.02;
    for (const m of [this.back, this.ring, this.disc]) m.visible = show;
    if (!show) return;
    if (spot) {
      this.back.position.set(spot.x, 0.011, spot.z);
      this.ring.position.set(spot.x, 0.013, spot.z);
      this.disc.position.set(spot.x, 0.012, spot.z);
    }
    const on = spot ? Math.hypot(feet.x - spot.x, feet.z - spot.z) <= CONTACT.setCentreOk : false;
    const ringMat = this.ring.material as THREE.MeshBasicMaterial;
    const discMat = this.disc.material as THREE.MeshBasicMaterial;
    ringMat.color.copy(on ? ON : OFF);
    discMat.color.copy(on ? ON : OFF);
    ringMat.opacity = this.fade;
    (this.back.material as THREE.MeshBasicMaterial).opacity = 0.55 * this.fade;
    discMat.opacity = (on ? 0.55 : 0.2) * this.fade;
  }

  hide(): void {
    this.fade = 0;
    for (const m of [this.back, this.ring, this.disc]) m.visible = false;
  }
}
