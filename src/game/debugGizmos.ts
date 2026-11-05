import * as THREE from 'three';
import type { BallPredictor } from '../physics/predict';

/** 3D debug helpers shown with F3: predicted path, contact point, reach sphere. */
export class DebugGizmos {
  readonly group = new THREE.Group();
  private path: THREE.Line;
  private pathGeo: THREE.BufferGeometry;
  readonly contact: THREE.Mesh;
  readonly reach: THREE.Mesh;
  readonly lastHit: THREE.Mesh;
  private max = 600;

  constructor(scene: THREE.Scene) {
    this.pathGeo = new THREE.BufferGeometry();
    this.pathGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.max * 3), 3));
    this.path = new THREE.Line(
      this.pathGeo,
      new THREE.LineBasicMaterial({ color: 0x66ccff, transparent: true, opacity: 0.7, depthTest: false }),
    );
    this.path.frustumCulled = false;
    this.contact = new THREE.Mesh(
      new THREE.SphereGeometry(0.05, 12, 8),
      new THREE.MeshBasicMaterial({ color: 0xffee44, depthTest: false }),
    );
    this.reach = new THREE.Mesh(
      new THREE.SphereGeometry(1, 16, 10),
      new THREE.MeshBasicMaterial({ color: 0x44ff88, wireframe: true, transparent: true, opacity: 0.35, depthTest: false }),
    );
    this.lastHit = new THREE.Mesh(new THREE.OctahedronGeometry(0.08), new THREE.MeshBasicMaterial({ color: 0xff3366, depthTest: false }));
    this.group.add(this.path, this.contact, this.reach, this.lastHit);
    this.group.renderOrder = 10;
    this.group.visible = false;
    this.contact.visible = this.reach.visible = this.lastHit.visible = false;
    scene.add(this.group);
  }

  setVisible(v: boolean): void {
    this.group.visible = v;
  }

  updatePath(pred: BallPredictor, fromT: number): void {
    if (!this.group.visible) return;
    const attr = this.pathGeo.attributes.position as THREE.BufferAttribute;
    const arr = attr.array as Float32Array;
    const start = Math.max(0, Math.floor((fromT - pred.t0) / pred.dt));
    let n = 0;
    for (let i = start; i < pred.count && n < this.max; i += 2) {
      arr[n * 3] = pred.pos[i * 3];
      arr[n * 3 + 1] = pred.pos[i * 3 + 1];
      arr[n * 3 + 2] = pred.pos[i * 3 + 2];
      n++;
    }
    this.pathGeo.setDrawRange(0, n);
    attr.needsUpdate = true;
  }
}
