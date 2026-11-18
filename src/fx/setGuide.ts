import * as THREE from 'three';
import { FX } from '../config';
import type { Athlete } from '../game/athlete';
import { CALL_COLOR, callCss } from '../game/callRuns';
import type { SetPreview } from '../game/contact';
import { flyFor, solveApex, solveFixedTime } from '../physics/solve';
import { makeBlobTexture } from '../world/textures';

const ZERO = { x: 0, y: 0, z: 0 };

/**
 * Who your set goes to, shown on the court so your eyes stay up: a marker over the hitter with
 * their call, and the set you are about to give as a dotted arc from where you will catch the
 * ball to where they hit it (the same solver the set uses, so the arc is the set a green release
 * sends). Pressing the hitter's key again changes the call, and the arc with it. Once the ball
 * has left your hands the arc stays and fades, so a set that missed is seen leaving it. Small
 * dots in the hitter's colour, none near your hands (in first person the ball is there).
 */
export class SetGuide {
  private pts: THREE.Points;
  private pos: Float32Array;
  private mat: THREE.PointsMaterial;
  private label: HTMLDivElement;
  private text = '';
  private arcKey = '';
  private fade = 0;
  private hitter: Athlete | null = null;
  private v = new THREE.Vector3();
  private vel = { x: 0, y: 0, z: 0 };
  private p = { x: 0, y: 0, z: 0 };

  constructor(scene: THREE.Scene, hud: HTMLElement) {
    const G = FX.setGuide;
    this.pos = new Float32Array(G.points * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.mat = new THREE.PointsMaterial({
      size: G.size,
      sizeAttenuation: false,
      map: makeBlobTexture(0.2, 0.7),
      transparent: true,
      opacity: 0,
      depthTest: false,
      depthWrite: false,
    });
    this.pts = new THREE.Points(geo, this.mat);
    this.pts.frustumCulled = false;
    this.pts.renderOrder = 9;
    this.pts.visible = false;
    scene.add(this.pts);
    this.label = document.createElement('div');
    this.label.className = 'set-to';
    hud.appendChild(this.label);
  }

  /** the set's flight from the catch to the hitter, as the push solves it */
  private arc(p: SetPreview): void {
    const o = p.option!;
    const key = [p.at.x, p.at.y, p.at.z, o.target.x, o.target.y, o.target.z, o.apex, o.time ?? 0].map((n) => n.toFixed(2)).join();
    if (key === this.arcKey) return;
    this.arcKey = key;
    let T: number;
    if (o.time) {
      T = Math.max(0.15, o.time);
      solveFixedTime(p.at, o.target, T, ZERO, this.vel);
    } else T = solveApex(p.at, o.target, Math.max(p.at.y + 0.1, o.apex), ZERO, this.vel).T;
    const G = FX.setGuide;
    for (let i = 0; i < G.points; i++) {
      // from `skip` of the way (clear of your hands) to the hitter's contact
      flyFor(p.at, this.vel, ZERO, T * (G.skip + ((1 - G.skip) * i) / (G.points - 1)), this.p);
      this.pos.set([this.p.x, this.p.y, this.p.z], i * 3);
    }
    this.pts.geometry.attributes.position.needsUpdate = true;
  }

  /** `p` the set coming to you or loading in your hands (null: none), `show` the set cues are on */
  update(p: SetPreview | null, camera: THREE.PerspectiveCamera, realDt: number, show: boolean): void {
    const G = FX.setGuide;
    const o = show && p ? p.option : null;
    if (o && p) {
      this.arc(p);
      this.hitter = o.hitter;
      this.mat.color.setHex(o.key ? CALL_COLOR[o.key] : 0xffffff);
      if (o.label !== this.text) {
        this.text = o.label;
        this.label.textContent = o.label;
      }
      this.label.style.setProperty('--c', callCss(o.key));
      this.fade = Math.min(1, this.fade + realDt / G.fadeIn);
    } else this.fade = show ? Math.max(0, this.fade - realDt / G.fadeOut) : 0;
    const on = this.fade > 0.01;
    this.pts.visible = on;
    this.mat.opacity = G.opacity * this.fade;
    const h = this.hitter;
    if (!on || !h) {
      this.label.style.display = 'none';
      return;
    }
    // over the hitter's head, wherever their run has taken them
    const v = this.v.set(h.rpos.x, h.rpos.y + h.height + G.above, h.rpos.z).project(camera);
    if (v.z > 1) {
      this.label.style.display = 'none';
      return;
    }
    this.label.style.display = 'block';
    this.label.style.opacity = String(this.fade);
    const x = ((v.x + 1) / 2) * window.innerWidth;
    const y = ((1 - v.y) / 2) * window.innerHeight;
    this.label.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`;
  }

  hide(): void {
    this.fade = 0;
    this.arcKey = '';
    this.pts.visible = false;
    this.label.style.display = 'none';
  }
}
