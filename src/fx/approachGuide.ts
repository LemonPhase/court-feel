import * as THREE from 'three';
import { FX } from '../config';
import { damp } from '../core/mathx';
import { makeChevronTexture, makeRingTexture } from '../world/textures';

const OFF = new THREE.Color(0xffffff);
const ON = new THREE.Color(0x3ddc84);

/**
 * The court and its lines are pulled towards the camera with a polygon offset, so a flat marker
 * on the floor has to be pulled further or the court draws over it (the landing marker and the
 * block shadow do the same).
 */
function floorMaterial(color: THREE.Color | number, map: THREE.Texture | null): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    map,
    color,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
  });
}

export interface ApproachGuideState {
  /** where the feet go for the plant (null: hide everything) */
  spot: { x: number; z: number } | null;
  /** where the run starts: the arrows lead from here towards the spot (null: the spot alone) */
  from: { x: number; z: number } | null;
  /** where the plant starts on that run (null: not known yet): the line to jump from */
  plant: { x: number; z: number } | null;
  /** the hitter's feet now */
  feet: { x: number; z: number };
  /** 0..1: the GO cue just fired */
  pulse: number;
  /** the ball is waiting for the run: the arrows call harder */
  urge: boolean;
}

/**
 * Where your feet go on an approach: the spot you hit from, which fills green once you are on
 * it. In the first-run lesson there is also the run: a row of arrows flowing from your start, and
 * the line to jump from. You plant on the line and the jump carries you forward onto the spot
 * (a spike approach is a broad jump), so the line is a good stride short of it.
 *
 * The spot is the Setter Drill's "where to stand" spot (SetSpot, by MatusGib, PR #33): a white
 * ring and disc over a dark outline, readable on the bright wood, green when your feet are on
 * it. Once that merges, both can share one class.
 */
export class ApproachGuide {
  readonly group = new THREE.Group();
  private back: THREE.Mesh;
  private ring: THREE.Mesh;
  private disc: THREE.Mesh;
  private arrows: THREE.Mesh[] = [];
  private lineBack: THREE.Mesh;
  private line: THREE.Mesh;
  private lineFade = 0;
  private fade = 0;
  private arrowFade = 0;
  private t = 0;

  constructor() {
    const r = FX.floorSpot.radius;
    const ringTex = makeRingTexture(0.2);
    const flat = (geo: THREE.BufferGeometry, mat: THREE.MeshBasicMaterial, order: number) => {
      const m = new THREE.Mesh(geo, mat);
      m.rotation.x = -Math.PI / 2;
      m.renderOrder = order;
      m.visible = false;
      this.group.add(m);
      return m;
    };
    this.back = flat(new THREE.PlaneGeometry(r * 2.6, r * 2.6), floorMaterial(0x05070c, ringTex), 3);
    this.ring = flat(new THREE.PlaneGeometry(r * 2.4, r * 2.4), floorMaterial(OFF, ringTex), 4);
    this.disc = flat(new THREE.CircleGeometry(r * 0.78, 32), floorMaterial(OFF, null), 4);
    const l = FX.floorSpot.line;
    this.lineBack = flat(new THREE.PlaneGeometry(l.width + 0.08, l.depth + 0.08), floorMaterial(0x05070c, null), 3);
    this.line = flat(new THREE.PlaneGeometry(l.width, l.depth), floorMaterial(OFF, null), 4);
    const chevron = makeChevronTexture();
    const a = FX.floorSpot.arrowSize;
    for (let i = 0; i < FX.floorSpot.arrows; i++) this.arrows.push(flat(new THREE.PlaneGeometry(a, a), floorMaterial(OFF, chevron), 4));
  }

  /** once per render frame; `dt` in real seconds */
  update(s: ApproachGuideState, dt: number): void {
    this.t += dt;
    this.fade += ((s.spot ? 1 : 0) - this.fade) * damp(10, dt);
    this.arrowFade += ((s.spot && s.from ? 1 : 0) - this.arrowFade) * damp(8, dt);
    const show = this.fade > 0.02;
    for (const m of [this.back, this.ring, this.disc]) m.visible = show;
    const spot = s.spot;
    if (spot) {
      this.back.position.set(spot.x, 0.011, spot.z);
      this.ring.position.set(spot.x, 0.013, spot.z);
      this.disc.position.set(spot.x, 0.012, spot.z);
    }
    const on = spot ? Math.hypot(s.feet.x - spot.x, s.feet.z - spot.z) <= FX.floorSpot.on : false;
    const ringMat = this.ring.material as THREE.MeshBasicMaterial;
    const discMat = this.disc.material as THREE.MeshBasicMaterial;
    ringMat.color.copy(on ? ON : OFF);
    discMat.color.copy(on ? ON : OFF);
    ringMat.opacity = this.fade;
    (this.back.material as THREE.MeshBasicMaterial).opacity = 0.55 * this.fade;
    discMat.opacity = (on ? 0.55 : 0.2 + 0.3 * s.pulse) * this.fade;
    const grow = 1 + s.pulse * 0.45;
    this.ring.scale.setScalar(grow);
    this.back.scale.setScalar(grow);

    // the line to jump from, square across the run: green while your feet are on it
    this.lineFade += ((spot && s.from && s.plant ? 1 : 0) - this.lineFade) * damp(8, dt);
    const showLine = this.lineFade > 0.02 && !!spot && !!s.from && !!s.plant;
    this.line.visible = this.lineBack.visible = showLine;
    if (showLine && spot && s.from && s.plant) {
      const heading = Math.atan2(-(spot.x - s.from.x), -(spot.z - s.from.z));
      const onLine = Math.hypot(s.feet.x - s.plant.x, s.feet.z - s.plant.z) <= FX.floorSpot.line.on;
      for (const m of [this.line, this.lineBack]) {
        m.position.set(s.plant.x, m === this.line ? 0.013 : 0.011, s.plant.z);
        m.rotation.z = heading;
      }
      const mat = this.line.material as THREE.MeshBasicMaterial;
      mat.color.copy(onLine ? ON : OFF);
      mat.opacity = this.lineFade * (onLine ? 1 : 0.85);
      (this.lineBack.material as THREE.MeshBasicMaterial).opacity = 0.55 * this.lineFade;
    }

    // the arrows: evenly spaced along the run, a wave of light running along them
    const showArrows = this.arrowFade > 0.02 && !!spot && !!s.from;
    for (const m of this.arrows) m.visible = showArrows;
    if (!showArrows || !spot || !s.from) return;
    const dx = spot.x - s.from.x;
    const dz = spot.z - s.from.z;
    const len = Math.hypot(dx, dz);
    if (len < 0.8) {
      for (const m of this.arrows) m.visible = false;
      return;
    }
    const ux = dx / len;
    const uz = dz / len;
    const heading = Math.atan2(-ux, -uz);
    const first = 0.4;
    const last = len - FX.floorSpot.radius - 0.3;
    const n = this.arrows.length;
    // how far along the path the feet are: arrows already behind them go out
    const along = (s.feet.x - s.from.x) * ux + (s.feet.z - s.from.z) * uz;
    for (let i = 0; i < n; i++) {
      const m = this.arrows[i];
      const d = first + ((last - first) * i) / Math.max(1, n - 1);
      m.position.set(s.from.x + ux * d, 0.012, s.from.z + uz * d);
      m.rotation.z = heading;
      const wave = 0.5 + 0.5 * Math.sin(this.t * (s.urge ? 9 : 5) - i * 1.1);
      const ahead = d > along + 0.25 ? 1 : 0;
      (m.material as THREE.MeshBasicMaterial).opacity = this.arrowFade * ahead * (s.urge ? 0.55 + 0.45 * wave : 0.3 + 0.5 * wave);
    }
  }
}
