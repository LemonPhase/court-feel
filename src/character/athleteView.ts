import * as THREE from 'three';
import { TIMING } from '../config';
import { clamp, clamp01, damp, easeOutCubic, lerp, smooth01, smoothstep, wrapAngle } from '../core/mathx';
import type { Athlete } from '../game/athlete';
import { orientBone, twoBoneIK } from './ik';
import { buildRig, type BoneName, type Kit, type Rig } from './rig';

/**
 * Procedural animation for one athlete. Every frame:
 *  1. torso pose (crouch, lean, twist) from locomotion + state + action
 *  2. feet: planted world positions with stepping (idle), distance-driven
 *     gait cycle (moving), a two-step plant (jump load), body-relative in air
 *  3. arms: wrist targets authored relative to the shoulders and blended per
 *     situation; the hitting hand is IK'd onto the actual contact point
 *  4. head look-at towards the ball
 * Wrist/elbow/knee placement is all analytic two-bone IK. Arms are authored as
 * wrist positions, not joint angles: blends become arcs in space, and putting
 * the hand on the contact point is the same IK.
 */

type V = THREE.Vector3;
const v3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

interface ArmState {
  /** wrist offset from shoulder in body frame (lat, up, fwd), metres */
  w: V;
  pole: V;
  palm: V;
  rate: number;
  /** wrist flexion (rad): + snaps the fingers over towards the palm, - cocks the hand back */
  flex: number;
}

interface FootState {
  plant: V; // world
  stepping: boolean;
  from: V;
  to: V;
  t: number;
  dur: number;
  cur: V; // world, current target (ankle)
  pitch: number;
}

/** wind-up power 0..1 after holding since t0 (mirrors ContactSystem.chargeFor) */
function windupCharge(t0: number, now: number): number {
  return clamp01((now - t0 - TIMING.tapThreshold) / (TIMING.chargeFull - TIMING.tapThreshold));
}

/** drawn-bow torso for a wind-up of charge 0..1: chest turned away, back arched (the swing starts from here) */
const _wt = { chestY: 0, spineX: 0, chestX: 0, hipsY: 0 };
function windupTorso(ch: number): typeof _wt {
  _wt.chestY = -0.5 - 0.32 * ch;
  _wt.spineX = 0.14 + 0.15 * ch;
  _wt.chestX = 0.16 + 0.09 * ch;
  _wt.hipsY = -0.12 - 0.09 * ch;
  return _wt;
}
const _ck1 = new THREE.Vector3();
const _ck2 = new THREE.Vector3();

const ARM_KEYS = {
  ready: { w: [-0.025, -0.19, 0.17], pole: [0.8, -0.35, -0.6] },
  relaxed: { w: [0.02, -0.29, 0.03], pole: [0.2, 0, -1] },
  plantBack: { w: [0.03, -0.17, -0.21], pole: [0.3, 0, 1] },
  swingUp: { w: [0.04, 0.3, 0.1], pole: [0.6, -0.3, -0.8] },
  cock: { w: [-0.02, 0.105, -0.055], pole: [1, 0.6, -0.55] },
  /** fully drawn bow-and-arrow: elbow high and back (full wind-up charge) */
  cockDeep: { w: [-0.01, 0.15, -0.135], pole: [1, 0.85, -0.35] },
  /** start of the whip: the elbow drives up and forward while the hand trails behind the head */
  lag: { w: [-0.03, 0.06, -0.17], pole: [0.45, 1, 0.5] },
  over: { w: [0.06, 0.33, -0.06], pole: [1, 0.3, -0.6] },
  follow: { w: [-0.13, -0.2, 0.15], pole: [1, 0, -0.4] },
  /** a full-power swing finishes further across and down, by the opposite hip */
  followDeep: { w: [-0.19, -0.3, 0.09], pole: [1, 0.1, -0.3] },
  followMid: { w: [-0.02, 0.06, 0.3], pole: [1, 0, -0.5] },
  offFollow: { w: [0.03, -0.18, 0.07], pole: [0.6, 0, -1] },
  /** hands together over the net: wrists inside the shoulder line, under a ball-width apart */
  block: { w: [-0.04, 0.305, 0.07], pole: [1, -0.35, -0.6] },
  pass: { w: [-0.098, -0.24, 0.19], pole: [1, -0.8, 0.2] },
  setPrep: { w: [-0.055, 0.115, 0.09], pole: [1, -0.25, 0.25] },
  setRelease: { w: [-0.04, 0.28, 0.1], pole: [1, -0.2, 0.2] },
  toss: { w: [0.0, 0.31, 0.12], pole: [1, -0.3, -0.5] },
  land: { w: [0.04, -0.13, 0.13], pole: [0.6, -0.2, -0.8] },
  airNeutral: { w: [0.07, 0.12, 0.1], pole: [1, -0.2, -0.6] },
} as const;

type ArmKey = keyof typeof ARM_KEYS;

/**
 * First-person view-model overrides: the same motions, nudged forward/down so
 * the player's own hands are actually in view (block hands at the top of the
 * screen, the cocked hitting hand peeking in before the swing).
 */
const FP_KEYS: Partial<Record<ArmKey, { w: readonly number[]; pole: readonly number[] }>> = {
  block: { w: [-0.035, 0.2, 0.25], pole: [1, -0.45, -0.4] },
  cock: { w: [0.04, 0.17, 0.06], pole: [1, 0.4, -0.5] },
  cockDeep: { w: [0.075, 0.215, 0.015], pole: [1, 0.7, -0.4] },
  lag: { w: [0.05, 0.16, -0.05], pole: [0.5, 1, 0.4] },
  over: { w: [0.07, 0.28, 0.12], pole: [1, 0.3, -0.6] },
  pass: { w: [-0.09, -0.18, 0.25], pole: [1, -0.8, 0.2] },
  swingUp: { w: [0.05, 0.2, 0.22], pole: [0.6, -0.3, -0.8] },
  toss: { w: [0.02, 0.2, 0.24], pole: [1, -0.3, -0.5] },
  setPrep: { w: [-0.075, 0.165, 0.2], pole: [1, -0.4, 0.1] },
  setRelease: { w: [-0.06, 0.27, 0.22], pole: [1, -0.3, 0.1] },
};

export class AthleteView {
  readonly rig: Rig;
  readonly root: THREE.Group;
  private H: number;
  private arms: [ArmState, ArmState];
  private feet: [FootState, FootState];
  private gaitPhase = 0;
  private gaitW = 0;
  private lastPos = v3();
  private velS = v3();
  private body = { drop: 0, spineX: 0, chestX: 0, chestY: 0, hipsY: 0, hipsX: 0, chestZ: 0 };
  private headYaw = 0;
  private headPitch = 0;
  private initialized = false;
  private prevState = '';
  private landT = -10;
  private landImpact = 0;
  private loadFeetInit = false;
  private hideHead = false;
  private fpApplied = false;
  /** next arm update copies targets directly (camera toggle) */
  private snapArms = false;
  private opacity = 1;
  onFootstep: ((a: Athlete, speed: number) => void) | null = null;
  private stepToggle = 0;
  /** world position of each palm (for FX: hand flashes, contact) */
  readonly palmR = v3();
  readonly palmL = v3();
  readonly headPos = v3();
  readonly eyePos = v3();

  constructor(
    public athlete: Athlete,
    readonly kit: Kit,
  ) {
    this.H = athlete.height;
    this.rig = buildRig(this.H, kit);
    this.root = this.rig.root;
    const mkArm = (): ArmState => ({
      w: v3(...(ARM_KEYS.ready.w as unknown as [number, number, number])).multiplyScalar(this.H),
      pole: v3(0.8, -0.3, -0.6),
      palm: v3(0, 0, 1),
      rate: 12,
      flex: 0,
    });
    this.arms = [mkArm(), mkArm()];
    const mkFoot = (): FootState => ({ plant: v3(), stepping: false, from: v3(), to: v3(), t: 0, dur: 0.16, cur: v3(), pitch: 0 });
    this.feet = [mkFoot(), mkFoot()];
  }

  setFirstPerson(fp: boolean): void {
    this.hideHead = fp;
  }

  setOpacity(o: number): void {
    if (Math.abs(o - this.opacity) < 0.01) return;
    this.opacity = o;
    const m = this.rig.material;
    m.transparent = o < 0.99;
    m.opacity = o;
    m.depthWrite = o > 0.5;
    this.rig.mesh.castShadow = true;
  }

  // ------------------------------------------------------------ frames
  /** body frame (lat, up, fwd) offset -> world vector (direction only) */
  private bodyToWorld(lat: number, up: number, fwd: number, out: V): V {
    const y = this.athlete.ryaw;
    const c = Math.cos(y);
    const s = Math.sin(y);
    return out.set(lat * c - fwd * s, up, -lat * s - fwd * c);
  }

  private worldToBody(w: V, out: V): V {
    const y = this.athlete.ryaw;
    const c = Math.cos(y);
    const s = Math.sin(y);
    // inverse rotation
    const lat = w.x * c - w.z * s;
    const fwd = -w.x * s - w.z * c;
    return out.set(lat, w.y, fwd);
  }

  private resetFeet(): void {
    const a = this.athlete;
    for (let i = 0; i < 2; i++) {
      const s = i === 0 ? -1 : 1;
      const f = this.feet[i];
      this.stanceFoot(s, f.plant);
      f.cur.copy(f.plant);
      f.stepping = false;
    }
    this.lastPos.copy(a.rpos);
    this.velS.set(0, 0, 0);
  }

  /** idle stance position for a foot (world, at ankle height) */
  private stanceFoot(s: number, out: V): V {
    const a = this.athlete;
    const H = this.H;
    // shoulder-width stance, hitting-side foot slightly back (ready position)
    const lat = s * 0.13 * H;
    const fwd = s === a.hand ? -0.03 * H : 0.035 * H;
    this.bodyToWorld(lat, 0, fwd, out);
    out.x += a.rpos.x;
    out.z += a.rpos.z;
    out.y = this.rig.dims.ankleY;
    return out;
  }

  // ------------------------------------------------------------ update
  update(dt: number, tr: number): void {
    const a = this.athlete;
    const H = this.H;
    const rig = this.rig;
    const B = rig.bones;
    this.root.position.copy(a.rpos);
    this.root.rotation.y = a.ryaw;
    if (!this.initialized || this.lastPos.distanceToSquared(a.rpos) > 4) {
      this.initialized = true;
      this.resetFeet();
    }
    if (dt <= 0) {
      // frozen (hit-stop / pause): keep the last pose, but camera toggles still apply
      if (this.rig.bones.head.scale.x !== (this.hideHead ? 0.001 : 1)) {
        this.rig.bones.head.scale.setScalar(this.hideHead ? 0.001 : 1);
        this.root.updateMatrixWorld(true);
      }
      if (this.fpApplied === this.hideHead) return;
      // re-pose once so the FP view-model offsets take effect immediately
      dt = 1e-4;
    }
    if (this.fpApplied !== this.hideHead) this.snapArms = true;
    this.fpApplied = this.hideHead;
    // smoothed velocity from rendered motion
    const inst = _t1.subVectors(a.rpos, this.lastPos).divideScalar(Math.max(dt, 1e-4));
    inst.y = 0;
    this.velS.lerp(inst, damp(14, dt));
    this.lastPos.copy(a.rpos);
    const speed = Math.hypot(this.velS.x, this.velS.z);
    const vLocal = this.worldToBody(this.velS, _t2);

    // ---- state transitions
    const st = a.state;
    if (st !== this.prevState) {
      if (st === 'land') {
        this.landT = tr;
        this.landImpact = clamp01(a.landImpact / 4.5);
        // feet touch down where they are
        for (const f of this.feet) {
          f.plant.set(f.cur.x, rig.dims.ankleY, f.cur.z);
          f.stepping = false;
        }
      }
      if (st === 'load') this.loadFeetInit = false;
      this.prevState = st;
    }
    const act = a.action;
    const last = a.lastAction;
    const tSinceTake = tr - a.takeoffT;
    const tSinceLand = tr - this.landT;
    // the attack twists are authored for a righty: a lefty turns the other way
    const hs = a.hand;

    // ================================================== torso
    const bd = this.body;
    let drop = 0.06 * H;
    let spineX = -0.2;
    let chestX = -0.06;
    let chestY = 0;
    let hipsY = 0;
    const hipsX = 0;
    let chestZ = 0;
    let bodyRate = 10;

    const gTarget = st === 'ground' || st === 'land' ? smoothstep(0.35, 1.3, speed) : 0;
    this.gaitW = lerp(this.gaitW, gTarget, damp(10, dt));
    const g = this.gaitW;
    const sprint = a.sprint;

    // locomotion
    if (st === 'ground' || st === 'land') {
      const bob = Math.abs(Math.sin(this.gaitPhase * Math.PI * 2)) * 0.012 * H * clamp01(speed / 3);
      drop = lerp(0.065 * H, 0.035 * H + bob, g);
      const fwdLean = clamp(vLocal.z / 5, -0.6, 1);
      spineX = lerp(-0.22, -0.12 - 0.22 * fwdLean - 0.1 * sprint, g);
      chestX = lerp(-0.06, -0.04, g);
      const twist = Math.sin(this.gaitPhase * Math.PI * 2) * 0.16 * g * clamp01(speed / 4);
      hipsY = twist;
      chestY = -twist * 1.4;
      chestZ = clamp(-vLocal.x / 12, -0.12, 0.12) * g;
      // split step: up onto the toes as their hitter swings, landing into a deeper stance on the contact
      const ss = tr - a.splitT;
      if (ss >= 0 && ss < 0.45) {
        drop += ss < 0.12 ? -0.035 * H * Math.sin((Math.PI * ss) / 0.12) : 0.03 * H * Math.sin((Math.PI * (ss - 0.12)) / 0.33);
        spineX -= ss >= 0.12 ? 0.08 * Math.sin((Math.PI * (ss - 0.12)) / 0.33) : 0;
      }
    }
    // land absorb
    if (st === 'land' || (st === 'ground' && tSinceLand < 0.45)) {
      const k = Math.exp(-tSinceLand * 7) * (0.35 + this.landImpact * 0.65);
      drop += 0.14 * H * k;
      spineX -= 0.4 * k;
    }
    // jump load (plant)
    if (st === 'load') {
      const p = smooth01(a.loadT / 0.16);
      const depth = 0.55 + 0.45 * clamp01(a.loadApproach / 4);
      drop = lerp(drop, 0.17 * H * depth, p);
      spineX = lerp(spineX, -0.55 * depth, p);
      chestX = lerp(chestX, -0.12, p);
      chestY = 0;
      hipsY = 0;
      bodyRate = 30;
    }
    // airborne
    if (st === 'air') {
      bodyRate = 18;
      const rise = smooth01(tSinceTake / 0.16);
      drop = lerp(0.04 * H, -0.005 * H, rise);
      spineX = lerp(-0.25, 0.04, rise);
      chestX = lerp(-0.05, 0.08, rise);
      if (a.airIntent === 'attack' && !(act && act.kind === 'block')) {
        const cock = smooth01((tSinceTake - 0.1) / 0.22);
        spineX = lerp(spineX, 0.14, cock);
        chestX = lerp(chestX, 0.16, cock);
        chestY = lerp(chestY, -0.5 * hs, cock);
        hipsY = lerp(hipsY, -0.12 * hs, cock);
      }
    }
    // actions on the torso
    const swing = act && act.kind === 'swing' ? act : last && last.kind === 'swing' && tr - last.contactT < 0.5 ? last : null;
    let swingS = -1; // 0..1 accel phase
    let swingF = -1; // 0..1 follow phase (stays at 1 while the follow-through holds)
    if (swing) {
      const dur = Math.max(0.03, swing.contactT - swing.t0);
      if (tr < swing.contactT) swingS = clamp01((tr - swing.t0) / dur);
      else swingF = clamp01((tr - swing.contactT) / (swing.tip ? 0.2 : 0.3));
      const ch = swing.tip ? 0 : swing.charge;
      const W = windupTorso(ch);
      if (swingS >= 0) {
        // kinetic chain: the hips open first, the chest follows, the arm whips last (see updateArms)
        const eh = easeOutCubic(swingS * 1.6);
        const ec = smooth01(swingS * 1.25);
        chestY = hs * lerp(W.chestY, 0.14 + 0.08 * ch, ec);
        spineX = lerp(W.spineX, -0.12 - 0.05 * ch, ec);
        chestX = lerp(W.chestX, -0.06, ec);
        hipsY = hs * lerp(W.hipsY, 0.08, eh);
        bodyRate = 90;
      } else if (swingF >= 0 && (swingF < 1 || st === 'air')) {
        // follow-through: a hard swing keeps going and folds the body (jackknife), held until landing
        const e = easeOutCubic(swingF);
        const jk = swing.tip ? 0 : 0.55 + 0.45 * ch;
        chestY = hs * lerp(0.14 + 0.08 * ch, swing.tip ? 0.1 : 0.3 + 0.12 * jk, e);
        spineX = lerp(-0.12 - 0.05 * ch, swing.tip ? -0.12 : -0.3 - 0.32 * jk, e);
        chestX = lerp(-0.06, -0.12 - 0.14 * jk, e);
        hipsY = hs * lerp(0.08, 0.16, e);
        bodyRate = swingF < 1 ? 60 : 20;
      }
    }
    // wind-up: chest turns away and the back arches as the charge builds
    if (act && act.kind === 'windup' && st !== 'load') {
      const W = windupTorso(windupCharge(act.t0, tr));
      const p = smooth01((tr - act.t0) / 0.12);
      chestY = lerp(chestY, hs * W.chestY, p);
      spineX = lerp(spineX, W.spineX, p);
      chestX = lerp(chestX, W.chestX, p);
      hipsY = lerp(hipsY, hs * W.hipsY, p);
      bodyRate = Math.max(bodyRate, 22);
    }
    const passAct = act && act.kind === 'pass' ? act : null;
    if (passAct && st !== 'air') {
      const p = smooth01((tr - passAct.t0) / 0.1);
      drop = lerp(drop, 0.13 * H, p);
      spineX = lerp(spineX, -0.42, p);
      chestX = lerp(chestX, -0.1, p);
      chestY = lerp(chestY, 0, p);
      hipsY = lerp(hipsY, 0, p);
      bodyRate = 25;
    }
    const setAct = act && act.kind === 'set' ? act : null;
    if (setAct) {
      const p = smooth01((tr - setAct.t0) / 0.12);
      if (st !== 'air') drop = lerp(drop, 0.075 * H, p);
      spineX = lerp(spineX, -0.04, p);
      chestX = lerp(chestX, 0.12, p);
      chestY = lerp(chestY, 0, p);
      bodyRate = 22;
    }
    const blockAct = act && act.kind === 'block' ? act : null;
    if (blockAct) {
      const p = smooth01((tr - blockAct.t0) / 0.12);
      spineX = lerp(spineX, st === 'air' ? -0.06 : -0.08, p);
      chestX = lerp(chestX, 0.0, p);
      chestY = lerp(chestY, 0, p);
      hipsY = lerp(hipsY, 0, p);
      if (st !== 'air' && st !== 'load') drop = lerp(drop, 0.05 * H, p);
      bodyRate = 25;
    }
    const k = damp(bodyRate, dt);
    bd.drop = lerp(bd.drop, drop, k);
    bd.spineX = lerp(bd.spineX, spineX, k);
    bd.chestX = lerp(bd.chestX, chestX, k);
    bd.chestY = lerp(bd.chestY, chestY, k);
    bd.hipsY = lerp(bd.hipsY, hipsY, k);
    bd.hipsX = lerp(bd.hipsX, hipsX, k);
    bd.chestZ = lerp(bd.chestZ, chestZ, k);

    // apply torso
    const d = rig.dims;
    B.hips.position.set(0, d.hipY - bd.drop, 0);
    B.hips.rotation.set(bd.hipsX, bd.hipsY, 0);
    B.spine.rotation.set(bd.spineX * 0.55, bd.chestY * 0.4, bd.chestZ * 0.5);
    B.chest.rotation.set(bd.spineX * 0.45 + bd.chestX, bd.chestY * 0.6, bd.chestZ * 0.5);
    B.neck.rotation.set(0, 0, 0);
    B.head.rotation.set(0, 0, 0);
    for (const n of [
      'clavL',
      'clavR',
      'upperArmL',
      'upperArmR',
      'lowerArmL',
      'lowerArmR',
      'handL',
      'handR',
      'thighL',
      'thighR',
      'shinL',
      'shinR',
      'footL',
      'footR',
    ] as BoneName[]) {
      B[n].quaternion.identity();
    }
    B.head.scale.setScalar(this.hideHead ? 0.001 : 1);
    this.root.updateMatrixWorld(true);

    // ================================================== legs
    this.updateLegs(dt, tr, speed, vLocal, g);

    // ================================================== arms
    this.updateArms(dt, tr, swingS, swingF, swing);

    this.snapArms = false;

    // ================================================== head look
    this.updateHead(dt);

    this.updateFxAnchors();
  }

  /** FX anchors (palms, head) from the current pose; the replay calls it after posing a frame */
  updateFxAnchors(): void {
    const B = this.rig.bones;
    B.handR.getWorldPosition(this.palmR);
    B.handL.getWorldPosition(this.palmL);
    B.head.getWorldPosition(this.headPos);
  }

  // ------------------------------------------------------------ legs
  private updateLegs(dt: number, tr: number, speed: number, vLocal: V, g: number): void {
    const a = this.athlete;
    const H = this.H;
    const B = this.rig.bones;
    const d = this.rig.dims;
    const st = a.state;
    const ankleY = d.ankleY;
    // the hitting side's leg (right for a righty): plants first, tucks most in the air
    const hs = a.hand;

    if (st === 'air') {
      // body-relative leg pose
      const tSince = tr - a.takeoffT;
      const rise = smooth01(tSince / 0.14);
      const attack = a.airIntent === 'attack' && !(a.action && a.action.kind === 'block');
      const tuck = attack ? smooth01((tSince - 0.12) / 0.25) : 0;
      // after the swing, legs come forward for landing
      const sw = a.action && a.action.kind === 'swing' ? a.action : a.lastAction && a.lastAction.kind === 'swing' ? a.lastAction : null;
      let kick = 0;
      if (sw && tr > sw.t0) kick = smooth01((tr - sw.t0) / 0.3);
      // the bow: a charging wind-up pulls the heels further up and back
      const wu = a.action && a.action.kind === 'windup' ? a.action : null;
      const bow = attack ? (wu ? windupCharge(wu.t0, tr) : sw && !sw.tip && tr < sw.contactT ? sw.charge : 0) : 0;
      // the jackknife: right after a hard contact the knees snap up in front, then let go for the landing
      let pike = 0;
      if (sw && !sw.tip && tr >= sw.contactT) {
        const ts = tr - sw.contactT;
        pike = sw.charge * smooth01(ts / 0.07) * (1 - smooth01((ts - 0.1) / 0.25));
      }
      const descending = a.vel.y < -1.5 ? smooth01((-a.vel.y - 1.5) / 2) : 0;
      for (let i = 0; i < 2; i++) {
        const s = i === 0 ? -1 : 1;
        const f = this.feet[i];
        const hipH = d.hipY - this.body.drop;
        // extended: feet under the hips, toes pointed
        let lat = s * 0.06 * H;
        let up = hipH - (d.thigh + d.shin) * 0.985;
        let fwd = -0.02 * H;
        // tucked: knees bent, feet behind (spike air pose)
        const tk = Math.max(0, tuck - kick * 0.8) * (s === hs ? 1 : 0.8);
        up = lerp(up, hipH - (0.33 - 0.045 * bow) * H, tk);
        fwd = lerp(fwd, -(0.15 + 0.05 * bow) * H, tk);
        // prepare to land
        const prep = Math.max(descending * 0.7, kick * 0.6);
        up = lerp(up, hipH - 0.42 * H, prep);
        fwd = lerp(fwd, (s === hs ? 0.02 : 0.06) * H, prep);
        lat = lerp(lat, s * 0.1 * H, prep);
        // jackknife after the hit
        up = lerp(up, hipH - 0.35 * H, pike * 0.8);
        fwd = lerp(fwd, (s === hs ? 0.1 : 0.14) * H, pike * 0.8);
        this.bodyToWorld(lat, 0, fwd, _t3);
        const target = _t4.set(a.rpos.x + _t3.x, a.rpos.y + up, a.rpos.z + _t3.z);
        f.cur.lerp(target, damp(rise < 1 ? 30 : 16, dt));
        f.pitch = lerp(f.pitch, lerp(0.9, 0.5, prep), damp(12, dt));
        f.plant.copy(f.cur);
        f.stepping = false;
      }
    } else if (st === 'load') {
      // two-step plant: the hitting-side foot lands first (right for a righty), the other closes slightly ahead
      if (!this.loadFeetInit) {
        this.loadFeetInit = true;
        const lead = clamp(a.loadApproach * 0.1, 0, 0.45) + 0.05;
        for (let i = 0; i < 2; i++) {
          const s = i === 0 ? -1 : 1;
          const f = this.feet[i];
          f.from.copy(f.cur);
          const fwd = lead + (s !== hs ? 0.06 * H : -0.01 * H);
          this.bodyToWorld(s * 0.12 * H, 0, fwd, _t3);
          f.to.set(a.rpos.x + _t3.x, ankleY, a.rpos.z + _t3.z);
        }
      }
      for (let i = 0; i < 2; i++) {
        const s = i === 0 ? -1 : 1;
        const f = this.feet[i];
        const t0 = s === hs ? 0 : 0.035;
        const p = smooth01((a.loadT - t0) / 0.075);
        f.cur.lerpVectors(f.from, f.to, p);
        f.cur.y = ankleY + Math.sin(Math.PI * p) * 0.05 * H * (p < 1 ? 1 : 0);
        f.pitch = lerp(f.pitch, -0.15 * (1 - p), damp(20, dt));
        f.plant.copy(f.to);
        f.stepping = false;
      }
    } else {
      // ---- gait cycle
      const C = 2 * (0.42 + 0.16 * Math.min(speed, 6)); // cycle length (m)
      this.gaitPhase = (this.gaitPhase + (speed * dt) / C) % 1;
      const duty = lerp(0.62, 0.38, smoothstep(2, 4.5, speed));
      const ml = Math.hypot(vLocal.x, vLocal.z) || 1;
      const dirLat = vLocal.x / ml;
      const dirFwd = vLocal.z / ml;
      for (let i = 0; i < 2; i++) {
        const s = i === 0 ? -1 : 1;
        const f = this.feet[i];
        // ---- idle: planted with stepping
        if (g < 0.5) {
          const desired = this.stanceFoot(s, _t3);
          const other = this.feet[1 - i];
          const dist = Math.hypot(desired.x - f.plant.x, desired.z - f.plant.z);
          if (!f.stepping && !other.stepping && dist > 0.2) {
            f.stepping = true;
            f.from.copy(f.plant);
            f.to.copy(desired);
            f.t = 0;
            f.dur = clamp(0.1 + dist * 0.2, 0.12, 0.22);
          }
          if (f.stepping) {
            f.to.lerp(desired, damp(10, dt));
            f.t += dt;
            const p = smooth01(f.t / f.dur);
            f.cur.lerpVectors(f.from, f.to, p);
            f.cur.y = ankleY + Math.sin(Math.PI * p) * 0.045 * H;
            if (p >= 1) {
              f.stepping = false;
              f.plant.copy(f.to);
              this.onFootstep?.(a, 0.5);
            }
          } else {
            f.cur.lerp(f.plant, damp(25, dt));
            f.cur.y = ankleY;
          }
          f.pitch = lerp(f.pitch, 0, damp(10, dt));
        } else {
          // ---- moving: distance-driven foot trajectories (no sliding)
          const ph = (this.gaitPhase + (s > 0 ? 0 : 0.5)) % 1;
          let along: number;
          let lift = 0;
          let pitch: number;
          if (ph < duty) {
            const u = ph / duty;
            along = (0.5 - u) * duty * C;
            pitch = lerp(-0.12, 0.3, u);
          } else {
            const u = (ph - duty) / (1 - duty);
            along = lerp(-0.5, 0.5, smooth01(u)) * duty * C;
            lift = Math.sin(Math.PI * u) * (0.035 + 0.035 * clamp01(speed / 4)) * H;
            pitch = lerp(0.55, -0.15, u);
          }
          const baseLat = s * lerp(0.1, 0.075, clamp01(speed / 4)) * H;
          const lat = baseLat + dirLat * along;
          const fwd = dirFwd * along + 0.02 * H;
          this.bodyToWorld(lat, 0, fwd, _t3);
          _t4.set(a.rpos.x + _t3.x, ankleY + lift, a.rpos.z + _t3.z);
          f.cur.lerp(_t4, damp(lerp(12, 40, g), dt));
          f.pitch = lerp(f.pitch, pitch * clamp01(speed / 2.5), damp(15, dt));
          f.plant.set(f.cur.x, ankleY, f.cur.z);
          f.stepping = false;
          // footstep event when a foot enters stance
          const stepIdx = Math.floor((this.gaitPhase * 2) % 2);
          if (i === 0 && stepIdx !== this.stepToggle) {
            this.stepToggle = stepIdx;
            this.onFootstep?.(a, speed);
          }
        }
      }
    }

    // ---- solve legs
    for (let i = 0; i < 2; i++) {
      const s = i === 0 ? -1 : 1;
      const L = s < 0 ? 'L' : 'R';
      const thigh = B[`thigh${L}` as BoneName];
      const shin = B[`shin${L}` as BoneName];
      const foot = B[`foot${L}` as BoneName];
      const f = this.feet[i];
      // knee points forward and slightly out
      this.bodyToWorld(s * 0.25, 0.05, 1, _pole);
      twoBoneIK(thigh, shin, foot.position, f.cur, _pole);
      // foot orientation: yaw with body (+ slight toe-out), pitch from gait/air
      const yaw = this.athlete.ryaw - s * 0.12;
      _q.setFromEuler(_e.set(-f.pitch, yaw, 0, 'YXZ'));
      parentInv(foot, _pq);
      foot.quaternion.copy(_pq.multiply(_q));
      foot.updateMatrixWorld(true);
    }
  }

  // ------------------------------------------------------------ arms
  /** hitting-arm cock, drawn further back with the wind-up charge */
  private cockAt(charge: number, out: V, pole: V): void {
    this.key('cock', out, pole);
    if (charge <= 0) return;
    this.key('cockDeep', _ck1, _ck2);
    out.lerp(_ck1, charge);
    pole.lerp(_ck2, charge);
  }

  private key(name: ArmKey, out: V, pole: V): void {
    const k = (this.hideHead && FP_KEYS[name]) || ARM_KEYS[name];
    out.set(k.w[0], k.w[1], k.w[2]).multiplyScalar(this.H);
    pole.set(k.pole[0], k.pole[1], k.pole[2]);
  }

  private updateArms(dt: number, tr: number, swingS: number, swingF: number, swing: Athlete['action']): void {
    const a = this.athlete;
    const H = this.H;
    const B = this.rig.bones;
    const st = a.state;
    const act = a.action;
    const tSinceTake = tr - a.takeoffT;
    const tSinceLand = tr - this.landT;

    for (let i = 0; i < 2; i++) {
      // -1 left, +1 right. The keys are authored per arm (x * s mirrors them), so a lefty only swaps roles:
      // the left arm hits, the right arm tosses, points at the ball and pulls down
      const s = i === 0 ? -1 : 1;
      const hitting = s === a.hand;
      const arm = this.arms[i];
      const w = _w.set(0, 0, 0);
      const pole = _p.set(0, 0, 0);
      let rate = 14;
      let ikWorld: V | null = null; // explicit world-space wrist target (IK to ball)
      let palmFwd = 0.0;
      let flex = 0;

      // ---- base: ground locomotion / ready
      if (st === 'ground' || st === 'land') {
        this.key('ready', w, pole);
        const g = this.gaitW;
        if (g > 0.01) {
          // running arm swing opposite to the legs
          const ph = this.gaitPhase * Math.PI * 2 + (s > 0 ? Math.PI : 0);
          const amp = clamp01(this.velS.length() / 5);
          _a.set(0.005 * H, -0.17 * H + Math.max(0, Math.sin(ph)) * 0.06 * H * amp, Math.sin(ph) * 0.15 * H * amp + 0.03 * H);
          w.lerp(_a, g);
          pole.lerp(_b.set(0.25, -0.1, -1), g);
        }
        if (st === 'land' || tSinceLand < 0.35) {
          const k = Math.exp(-Math.max(0, tSinceLand) * 6);
          this.key('land', _a, _b);
          w.lerp(_a, k);
          pole.lerp(_b, k);
        }
      } else if (st === 'load') {
        // approach arms swing back on the plant
        const p = smooth01(a.loadT / 0.075);
        this.key('ready', w, pole);
        this.key('plantBack', _a, _b);
        w.lerp(_a, p);
        pole.lerp(_b, p);
        rate = 55;
      } else {
        // air: double-arm swing up, then intent pose
        this.key('swingUp', w, pole);
        rate = 26;
        const intent = a.airIntent;
        const blending = smooth01((tSinceTake - 0.08) / 0.2);
        if (intent === 'attack') {
          if (hitting) this.key('cock', _a, _b);
          else {
            // non-hitting arm points at the ball
            this.aimArmAtBall(s, _a, _b);
          }
        } else if (intent === 'set') {
          this.key('setPrep', _a, _b);
        } else if (intent === 'block') {
          this.key('block', _a, _b);
        } else {
          this.key('airNeutral', _a, _b);
        }
        w.lerp(_a, blending);
        pole.lerp(_b, blending);
        // coming down without a swing: arms drift down for the landing
        if (a.vel.y < -2.5 && !(act && act.kind !== 'swing')) {
          const k = smooth01((-a.vel.y - 2.5) / 2.5) * (swingF >= 0 || swingS >= 0 ? 0 : 1);
          this.key('land', _a, _b);
          w.lerp(_a, k * 0.7);
          pole.lerp(_b, k * 0.7);
        }
      }

      // ---- actions
      // after a hit the follow-through is held until the feet touch down (no re-cocking in the air)
      const holdFollow = !!swing && swingF >= 1 && st === 'air';
      if (swing && (swingS >= 0 || (swingF >= 0 && swingF < 1) || holdFollow)) {
        rate = holdFollow ? 20 : 80;
        const ch = swing.tip ? 0 : swing.charge;
        if (hitting) {
          const cp = swing.contactPoint;
          // wrist target at contact: hand behind the ball along the hit direction
          _c.copy(swing.aim).normalize();
          const contactW = _d
            .copy(cp)
            .addScaledVector(_c, -(0.105 + 0.01))
            .addScaledVector(_up, -0.03 * H);
          if (swingS >= 0) {
            this.cockAt(swing.charge, _a, _b);
            this.key('over', _e1, _e2);
            const shoulder = this.shoulderWorld(s, _f1);
            const contactLocal = this.worldToBody(_f2.subVectors(contactW, shoulder), _f2);
            contactLocal.x *= s;
            if (swing.tip) {
              const e = smooth01(swingS);
              bezier(_a, _e1, contactLocal, e, w);
              pole.copy(_b).lerp(_e2, e);
            } else {
              // the whip: the elbow drives up and forward while the hand still hangs back behind the
              // head, then the forearm and wrist snap through to the ball (cubic path, late ease)
              this.key('lag', _h1, _h2);
              const e = swingS * swingS * (0.3 + 0.7 * swingS);
              bezier3(_a, _h1, _e1, contactLocal, e, w);
              pole
                .copy(_b)
                .lerp(_h2, smooth01(swingS * 2))
                .lerp(_e2, smooth01((swingS - 0.45) / 0.55));
              flex = lerp(-0.45, 0.2, smooth01((swingS - 0.55) / 0.45));
            }
            if (swingS > 0.55) {
              // final 45%: lock onto the exact contact point in world space
              ikWorld = _g.copy(contactW);
              ikBlend = smooth01((swingS - 0.55) / 0.45);
            }
            palmFwd = 1;
          } else {
            // follow-through across the body; a full-power swing finishes deeper, by the opposite hip
            const shoulder = this.shoulderWorld(s, _f1);
            const contactLocal = this.worldToBody(_f2.subVectors(contactW, shoulder), _f2);
            contactLocal.x *= s;
            this.key('followMid', _e1, _e2);
            if (swing.tip) this.key('airNeutral', _a, _b);
            else {
              this.key('follow', _a, _b);
              this.key('followDeep', _h1, _h2);
              _a.lerp(_h1, ch);
              _b.lerp(_h2, ch);
            }
            const e = 1 - Math.pow(1 - swingF, 4);
            bezier(contactLocal, _e1, _a, e, w);
            pole.set(1, 0.1, -0.6).lerp(_b, e);
            palmFwd = 1 - e;
            // the wrist snaps over the top of the ball, then relaxes
            if (!swing.tip)
              flex = (0.2 + 0.85 * easeOutCubic(swingF * 3.5)) * (1 - 0.55 * smooth01((swingF - 0.35) / 0.65)) * (0.6 + 0.4 * ch);
          }
        } else {
          // the off arm pulls down first: it leads the turn of the chest
          const e = swingS >= 0 ? smooth01(swingS * 1.4) : 1;
          this.key('offFollow', _a, _b);
          w.lerp(_a, e * 0.9);
          pole.lerp(_b, e);
        }
      }
      if (act && act.kind === 'block') {
        const p = act.held ? smooth01((tr - act.t0) / 0.1) : 1 - smooth01((tr - act.releaseT) / 0.2);
        this.key('block', _a, _b);
        if (st === 'air') _a.z += 0.06 * H * smooth01((tr - act.t0) / 0.18); // press over the net
        _a.x += 0.012 * H;
        w.lerp(_a, p);
        pole.lerp(_b, p);
        rate = 30;
        palmFwd = p;
      }
      if (act && act.kind === 'pass') {
        const p = smooth01((tr - act.t0) / 0.07);
        this.key('pass', _a, _b);
        _a.x += 0.008 * H; // hands just apart
        // follow-through lift after contact
        if (act.resolved && act.contactT > 0) _a.y += 0.06 * H * smooth01((tr - act.contactT) / 0.2);
        w.lerp(_a, p);
        pole.lerp(_b, p);
        rate = 35;
        // reach towards the ball when it is close
        ikWorld = this.reachForBall(s, w, 0.7, 0.5, _g);
        if (ikWorld) ikBlend = reachBlend;
      }
      if (act && act.kind === 'set') {
        const released = act.resolved && act.contactT > 0;
        const p = smooth01((tr - act.t0) / 0.1);
        this.key('setPrep', _a, _b);
        if (released) {
          this.key('setRelease', _e1, _e2);
          const e = easeOutCubic((tr - act.contactT) / 0.16);
          _a.lerp(_e1, e);
          _b.lerp(_e2, e);
        }
        w.lerp(_a, p);
        pole.lerp(_b, p);
        rate = 40;
        if (!released) {
          ikWorld = this.reachForBall(s, w, 0.6, 0.6, _g);
          if (ikWorld) ikBlend = reachBlend;
        }
      }
      // (during the plant the arms still swing back; the wind-up shows from takeoff)
      if (act && act.kind === 'windup' && st !== 'load') {
        const p = smooth01((tr - act.t0) / 0.12);
        if (hitting) {
          this.cockAt(windupCharge(act.t0, tr), _a, _b);
          w.lerp(_a, p);
          pole.lerp(_b, p);
          rate = 30;
          flex = -0.3 * p;
        } else if (st !== 'air') {
          // serving: the tossing arm stays up; otherwise it reaches forward for balance
          this.key(a.lastAction?.kind === 'toss' ? 'toss' : 'airNeutral', _a, _b);
          w.lerp(_a, p);
          pole.lerp(_b, p);
          rate = 25;
        }
      }
      if (act && act.kind === 'toss' && !hitting) {
        const p = smooth01((tr - act.t0) / 0.18);
        this.key('toss', _a, _b);
        w.lerp(_a, p);
        pole.lerp(_b, p);
        rate = 30;
      }
      if (act && act.kind === 'toss' && hitting) {
        const p = smooth01((tr - act.t0 - 0.12) / 0.25);
        this.key('cock', _a, _b);
        w.lerp(_a, p);
        pole.lerp(_b, p);
        rate = 25;
      }

      // ---- smooth in body space
      const kk = damp(rate, dt);
      arm.w.lerp(w, kk);
      arm.pole.lerp(pole, kk);
      arm.flex = lerp(arm.flex, flex, kk);
      if (rate >= 80 || this.snapArms) {
        arm.w.copy(w);
        arm.pole.copy(pole);
        arm.flex = flex;
      }
      arm.palm.set(0, 0, palmFwd);

      // ---- shoulder shrug when the hand goes high
      const L = s < 0 ? 'L' : 'R';
      const clav = B[`clav${L}` as BoneName];
      const elev = clamp01((arm.w.y / H - 0.05) / 0.25);
      clav.rotation.set(0, 0, s * elev * 0.32);
      clav.updateMatrixWorld(true);

      // ---- solve
      const shoulder = this.shoulderWorld(s, _f1);
      this.bodyToWorld(arm.w.x * s, arm.w.y, arm.w.z, _t3);
      const target = _t4.copy(shoulder).add(_t3);
      if (ikWorld) target.lerp(ikWorld, ikBlend);
      // first person: keep the hand and forearm clear of the lens (a wrist sweeping past the
      // camera would fill the screen with a dark blur)
      if (this.hideHead) {
        _f3.subVectors(target, this.eyePos);
        const dl = _f3.length();
        const minD = 0.42;
        if (dl < minD) target.copy(this.eyePos).addScaledVector(dl > 1e-4 ? _f3.divideScalar(dl) : _f3.set(0, 0.3, 0), minD);
      }
      this.bodyToWorld(arm.pole.x * s, arm.pole.y, arm.pole.z, _pole);
      const upper = B[`upperArm${L}` as BoneName];
      const lower = B[`lowerArm${L}` as BoneName];
      const hand = B[`hand${L}` as BoneName];
      twoBoneIK(upper, lower, hand.position, target, _pole);
      // hand: fingers continue the forearm, palm faces forward when hitting/blocking
      lower.matrixWorld.decompose(_f2, _q, _f3);
      const fore = _f3.set(0, -1, 0).applyQuaternion(_q);
      this.bodyToWorld(-s, 0, 0, _f2); // palm normal at rest faces the body midline
      this.bodyToWorld(0, 0, 1, _a);
      _f2.lerp(_a, arm.palm.z).normalize();
      if (Math.abs(arm.flex) > 1e-3) {
        // wrist flexion: the fingers turn towards the palm side (and the palm with them)
        const c = Math.cos(arm.flex);
        const sn = Math.sin(arm.flex);
        _a.copy(fore).multiplyScalar(c).addScaledVector(_f2, sn);
        _f2.multiplyScalar(c).addScaledVector(fore, -sn);
        fore.copy(_a);
      }
      // the hand's thin axis (local x) is the palm normal: +x = -palm for the right hand
      orientBone(hand, fore, _f2.multiplyScalar(-s), 1);
      ikBlend = 1;
    }
  }

  private shoulderWorld(s: number, out: V): V {
    const B = this.rig.bones;
    return (s < 0 ? B.upperArmL : B.upperArmR).getWorldPosition(out);
  }

  /** non-hitting arm points at the ball (bow-and-arrow) */
  private aimArmAtBall(s: number, w: V, pole: V): void {
    const a = this.athlete;
    const H = this.H;
    const sh = this.shoulderWorld(s, _f1);
    _f2.subVectors(a.lookAt, sh);
    if (_f2.lengthSq() < 1e-6) _f2.set(0, 1, 0);
    this.worldToBody(_f2, _f2).normalize();
    _f2.x *= s;
    // keep it in the upper-front hemisphere
    _f2.y = Math.max(_f2.y, 0.45);
    _f2.z = Math.max(_f2.z, 0.15);
    _f2.normalize();
    w.copy(_f2).multiplyScalar(0.31 * H);
    pole.set(0.9, -0.5, -0.2);
  }

  /** pull the wrist target towards the ball when it is near */
  private reachForBall(s: number, wLocal: V, near: number, maxPull: number, out: V): V | null {
    const a = this.athlete;
    const ball = a.ballPos;
    if (!ball) return null;
    const sh = this.shoulderWorld(s, _f1);
    this.bodyToWorld(wLocal.x * s, wLocal.y, wLocal.z, _f3);
    const base = _f2.copy(sh).add(_f3);
    const dist = base.distanceTo(ball);
    if (dist > near + 0.6) return null;
    reachBlend = smooth01((near + 0.6 - dist) / 0.6);
    out.copy(ball).sub(base);
    const l = out.length();
    if (l > maxPull) out.multiplyScalar(maxPull / l);
    // keep the wrists slightly on their own side of the ball
    this.bodyToWorld(s * 0.03, -0.06, -0.06, _f3);
    out.add(base).add(_f3);
    return out;
  }

  // ------------------------------------------------------------ head
  private updateHead(dt: number): void {
    const a = this.athlete;
    const B = this.rig.bones;
    B.head.getWorldPosition(_f1);
    _f2.subVectors(a.lookAt, _f1);
    this.worldToBody(_f2, _f2);
    // account for the chest twist
    const yaw = wrapAngle(Math.atan2(-_f2.x, _f2.z) - this.body.chestY - this.body.hipsY);
    const pitch = Math.atan2(_f2.y, Math.hypot(_f2.x, _f2.z)) - (this.body.spineX + this.body.chestX);
    const ty = clamp(yaw, -1.2, 1.2);
    const tp = clamp(pitch, -0.8, 1.0);
    this.headYaw = lerp(this.headYaw, ty, damp(10, dt));
    this.headPitch = lerp(this.headPitch, tp, damp(10, dt));
    B.neck.rotation.set(this.headPitch * 0.4, this.headYaw * 0.4, 0, 'YXZ');
    B.head.rotation.set(this.headPitch * 0.6, this.headYaw * 0.6, 0, 'YXZ');
    B.neck.updateMatrixWorld(true);
    B.head.getWorldPosition(this.headPos);
    this.eyePos.copy(this.headPos);
    this.eyePos.y += 0.046 * this.H;
  }
}

let ikBlend = 1;
let reachBlend = 1;

function bezier(p0: V, p1: V, p2: V, t: number, out: V): V {
  const u = 1 - t;
  return out.set(
    u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x,
    u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y,
    u * u * p0.z + 2 * u * t * p1.z + t * t * p2.z,
  );
}

function bezier3(p0: V, p1: V, p2: V, p3: V, t: number, out: V): V {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return out.set(
    a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    a * p0.y + b * p1.y + c * p2.y + d * p3.y,
    a * p0.z + b * p1.z + c * p2.z + d * p3.z,
  );
}

const _ws = new THREE.Vector3();
function parentInv(bone: THREE.Object3D, out: THREE.Quaternion): THREE.Quaternion {
  if (bone.parent) bone.parent.matrixWorld.decompose(_ws, out, _ws);
  else out.identity();
  return out.invert();
}

const _t1 = v3();
const _t2 = v3();
const _t3 = v3();
const _t4 = v3();
const _w = v3();
const _p = v3();
const _a = v3();
const _b = v3();
const _c = v3();
const _d = v3();
const _e1 = v3();
const _e2 = v3();
const _f1 = v3();
const _f2 = v3();
const _f3 = v3();
const _g = v3();
const _h1 = v3();
const _h2 = v3();
const _pole = v3();
const _up = v3(0, 1, 0);
const _q = new THREE.Quaternion();
const _pq = new THREE.Quaternion();
const _e = new THREE.Euler();
