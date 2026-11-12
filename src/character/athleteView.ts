import * as THREE from 'three';
import { AI, BALL, CHARACTER, CONTACT, COURT, PLAYER, TIMING } from '../config';
import { clamp, clamp01, damp, easeOutCubic, lerp, rightFromYaw, smooth01, smoothstep, wrapAngle } from '../core/mathx';
import type { Athlete } from '../game/athlete';
import { DIGITS, FINGERS } from './hand';
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
  /** the hand's shape: how far the fingers curl at each joint, how far they are spread, where the thumb is */
  shape: HandShape;
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
  /** coming down after the hit: arms loose, a little ahead of the hips for balance */
  descend: { w: [0.045, -0.215, 0.085], pole: [0.7, -0.1, -0.75] },
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
  /** per hand (left, right): each finger's base and tip bone, then the thumb's */
  private digits: [THREE.Bone[], THREE.Bone[]];
  private gaitPhase = 0;
  private gaitW = 0;
  /** how far into the low covering stance the body is (eased from Athlete.low) */
  private lowW = 0;
  private lastPos = v3();
  /** how far the body moved since the last frame */
  private rootMove = v3();
  private velS = v3();
  /** the split step's hop this frame (m): the body and the feet leave the floor together */
  private hop = 0;
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
  /**
   * Where the simulation takes a pass and a set for this athlete (the ball's centre at the touch is the
   * point of its path nearest these). The game keeps them current; without them the arms' own pose is used.
   */
  passZone: V | null = null;
  setZone: V | null = null;
  /** speed (m/s) of the ball coming into the pass or set in hand, and the direction it left on */
  private ballIn = 0;
  private ballOut = v3(0, 1, 0);
  private touched: unknown = null;
  /** 0..1: the two-arm swing of this jump is up, and the arms may go on to the attack, the block or the set */
  private armsUp = 1;
  /** how far (m) the hips sit back from the net so the knees stay on their own side of it */
  private netSit = 0;
  /** next arm update copies targets directly (camera toggle) */
  private snapArms = false;
  private opacity = 1;
  onFootstep: ((a: Athlete, speed: number) => void) | null = null;
  /** height of the net's top edge (the game keeps it current): hands stay off the net below it */
  netTop: number = COURT.netHeightMen;
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
      shape: { ...CHARACTER.hand.relaxed },
    });
    this.arms = [mkArm(), mkArm()];
    const mkFoot = (): FootState => ({ plant: v3(), stepping: false, from: v3(), to: v3(), t: 0, dur: 0.16, cur: v3(), pitch: 0 });
    this.feet = [mkFoot(), mkFoot()];
    const digitsOf = (L: 'L' | 'R') => DIGITS.flatMap((d) => [this.rig.bones[`${d}${L}`], this.rig.bones[`${d}Tip${L}`]]);
    this.digits = [digitsOf('L'), digitsOf('R')];
  }

  setFirstPerson(fp: boolean): void {
    if (fp !== this.hideHead) {
      // your own arms dissolve close to the lens (it clips what passes it, and a clean cut shows inside the sleeve)
      const f = CHARACTER.fpFade;
      this.rig.material.nearFade.set(fp ? f.from : 0, fp ? f.to : 0);
    }
    this.hideHead = fp;
  }

  setOpacity(o: number): void {
    if (Math.abs(o - this.opacity) < 0.01) return;
    this.opacity = o;
    this.rig.setOpacity(o);
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
    // split step: after a short load the whole body leaves the floor, a ballistic hop that lands on
    // their hitter's contact (the feet go up with it, below)
    const SS = AI.splitStep;
    const ssT = tr - a.splitT - SS.dip;
    this.hop = a.state === 'ground' && ssT > 0 && ssT < SS.air ? 0.5 * BALL.gravity * ssT * (SS.air - ssT) : 0;
    this.root.position.y += this.hop;
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
    this.rootMove.subVectors(a.rpos, this.lastPos);
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
    // a pass or a set: how fast the ball came in (seen up to the touch), and which way it left
    const bv = a.ballVel;
    if (act && (act.kind === 'pass' || act.kind === 'set')) {
      if (!act.resolved) {
        if (bv) this.ballIn = Math.hypot(bv.x, bv.y, bv.z);
      } else if (act !== this.touched) {
        this.touched = act;
        if (bv && bv.x * bv.x + bv.y * bv.y + bv.z * bv.z > 1e-6) this.ballOut.set(bv.x, bv.y, bv.z).normalize();
        else this.ballOut.set(0, 1, 0);
      }
    }
    // the attack twists are authored for a righty: a lefty turns the other way
    const hs = a.hand;

    // ================================================== torso
    const bd = this.body;
    let drop = 0.06 * H;
    let spineX = -0.2;
    let chestX = -0.06;
    let chestY = 0;
    let hipsY = 0;
    let hipsX = 0;
    let chestZ = 0;
    let bodyRate = 10;

    const sprint = a.sprint;
    const gTarget = st === 'ground' || st === 'land' ? smoothstep(0.35, 1.3, speed) : 0;
    this.gaitW = lerp(this.gaitW, gTarget, damp(sprint > 0.5 ? 20 : 10, dt));
    const g = this.gaitW;

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
      // split step: a quick load before the hop, then landing into a deeper stance on the contact
      if (ssT > -SS.dip && ssT < 0) drop += 0.025 * H * Math.sin((Math.PI * (ssT + SS.dip)) / SS.dip);
      const settle = ssT - SS.air;
      if (settle > 0 && settle < SS.settle) {
        const k = Math.sin((Math.PI * settle) / SS.settle);
        drop += 0.045 * H * k;
        spineX -= 0.1 * k;
      }
      // covering the hitter: low, hips back, chest over the knees (eased; upright again on the run)
      this.lowW = lerp(this.lowW, a.low * (1 - g), damp(6, dt));
      drop += 0.13 * H * this.lowW;
      spineX -= 0.32 * this.lowW;
      // an approach is three steps from a standing start: the lean has to be there by the second
      if (sprint > 0.5) bodyRate = 20;
      // standing and waiting, nobody is a statue: the chest breathes and the weight shifts a little
      const I = CHARACTER.idle;
      const still = 1 - g;
      const ph = a.id * 1.7;
      chestX += Math.sin(tr * I.breath * Math.PI * 2 + ph) * I.chest * still;
      drop += Math.sin(tr * I.sway * Math.PI * 2 + ph * 1.3) * I.bob * H * still;
      chestZ += Math.sin(tr * I.sway * Math.PI * 2 + ph * 0.7) * I.lean * still;
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
      // the last of the drop: the hips sink a little as the feet reach for the floor (knees soft, not locked)
      if (a.vel.y < 0) drop = lerp(drop, 0.035 * H, 1 - smoothstep(0.06, 0.5, a.rpos.y));
      if (a.airIntent === 'attack' && !(act && act.kind === 'block')) {
        const cock = smooth01((tSinceTake - 0.1) / 0.22);
        spineX = lerp(spineX, 0.14, cock);
        chestX = lerp(chestX, 0.16, cock);
        chestY = lerp(chestY, -0.5 * hs, cock);
        hipsY = lerp(hipsY, -0.12 * hs, cock);
      }
    }
    // actions on the torso
    // a swing shapes the body until its follow-through is over, and for the rest of that jump
    const lastSwing = last && last.kind === 'swing' ? last : null;
    const swing =
      act && act.kind === 'swing'
        ? act
        : lastSwing && (tr - lastSwing.contactT < 0.5 || (st === 'air' && lastSwing.contactT > a.takeoffT))
          ? lastSwing
          : null;
    let swingS = -1; // 0..1 accel phase
    let swingF = -1; // 0..1 follow phase (stays at 1 once the arm has come through)
    /** 0..1: the follow-through is over and the body lets go of it, opening up for the landing */
    let recover = 0;
    if (swing) {
      const dur = Math.max(0.03, swing.contactT - swing.t0);
      const ch = swing.tip ? 0 : swing.charge;
      const followT = followTime(swing.tip, ch);
      if (tr < swing.contactT) swingS = clamp01((tr - swing.t0) / dur);
      else {
        swingF = clamp01((tr - swing.contactT) / followT);
        recover = smooth01((tr - swing.contactT - followT * 0.8) / 0.32);
      }
      const W = windupTorso(ch);
      if (swingS >= 0) {
        // kinetic chain: the hips open first, the chest follows, the arm whips last (see updateArms)
        const eh = easeOutCubic(swingS * 1.6);
        const ec = smooth01(swingS * 1.25);
        chestY = hs * lerp(W.chestY, 0.14 + 0.08 * ch, ec);
        spineX = lerp(W.spineX, -0.12 - 0.05 * ch, ec);
        chestX = lerp(W.chestX, -0.06, ec);
        hipsY = hs * lerp(W.hipsY, 0.08, eh);
        // the trunk bends away from the hitting arm, which lifts that shoulder: the reach is at its highest on the ball
        chestZ = hs * CHARACTER.reachTilt * ec;
        bodyRate = 90;
      } else if (swingF >= 0 && (swingF < 1 || st === 'air')) {
        // follow-through: a hard swing keeps going and folds the body (jackknife), held until landing
        // (close to the net the fold is smaller: the head stays on its own side)
        const e = easeOutCubic(swingF);
        const room = smoothstep(0.25, 0.8, a.rpos.z * a.side);
        const jk = swing.tip ? 0 : (0.55 + 0.45 * ch) * (0.4 + 0.6 * room);
        chestY = hs * lerp(0.14 + 0.08 * ch, swing.tip ? 0.1 : 0.3 + 0.12 * jk, e) * (1 - 0.7 * recover);
        spineX = lerp(lerp(-0.12 - 0.05 * ch, swing.tip ? -0.12 : -0.3 - 0.32 * jk, e), -0.2, recover);
        chestX = lerp(lerp(-0.06, -0.12 - 0.14 * jk, e), -0.04, recover);
        hipsY = hs * lerp(0.08, 0.16, e) * (1 - 0.7 * recover);
        chestZ = hs * CHARACTER.reachTilt * (1 - smooth01(swingF * 2));
        bodyRate = swingF < 1 ? 60 : 16;
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
    const passAct = act && act.kind === 'pass' && act.form !== 'hands' ? act : null;
    if (passAct && st !== 'air') {
      // low, with the chest up: the shoulders have to be close enough to a knee-high ball for the
      // arms to reach it at a slant, not hanging straight down
      const p = smooth01((tr - passAct.t0) / 0.1);
      drop = lerp(drop, CHARACTER.pass.crouch * H, p);
      spineX = lerp(spineX, CHARACTER.pass.lean, p);
      chestX = lerp(chestX, -0.1, p);
      chestY = lerp(chestY, 0, p);
      hipsY = lerp(hipsY, 0, p);
      // a ball going by to one side: lean out over the platform, lower
      const lat = this.ballSide();
      const side = passAct.resolved ? (passAct.form === 'side' ? lat : 0) : Math.abs(lat) > 0.3 ? lat : 0;
      chestZ = lerp(chestZ, clamp(-side * 0.45, -0.32, 0.32), p);
      drop += Math.min(0.05 * H, Math.abs(side) * 0.06 * H) * p;
      bodyRate = 25;
    }
    // a dive: down onto the floor hands-first, the body stretched out along it; then up again
    if (st === 'dive') {
      const p = this.diveP();
      drop = lerp(drop, this.rig.dims.hipY - 0.26, p);
      hipsX = lerp(hipsX, -1.35, p);
      spineX = lerp(spineX, 0.12, p);
      chestX = lerp(chestX, 0.08, p);
      chestY = lerp(chestY, 0, p);
      hipsY = lerp(hipsY, 0, p);
      chestZ = lerp(chestZ, 0, p);
      bodyRate = 30;
    }
    const setAct = act && (act.kind === 'set' || (act.kind === 'pass' && act.form === 'hands')) ? act : null;
    if (setAct) {
      // knees a little bent under the ball, then the legs straighten through the release
      const p = smooth01((tr - setAct.t0) / 0.12);
      const up = setAct.resolved && setAct.contactT > 0 ? smooth01((tr - setAct.contactT) / 0.15) : 0;
      if (st !== 'air') drop = lerp(drop, lerp(0.045, 0.012, up) * H, p);
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
      // leaning into a sideways reach
      chestZ = lerp(chestZ, clamp(-a.reachX * Math.cos(a.ryaw) * 0.4, -0.16, 0.16), p);
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
    // at the net the hips sit back so the knees stay on their own side (the amount is found in updateLegs)
    this.netSitApplied = 0;
    if (this.netSit > 1e-4) {
      const sd = a.side * this.netSit;
      B.hips.position.x += -Math.sin(a.ryaw) * sd;
      B.hips.position.z += Math.cos(a.ryaw) * sd;
      this.netSitApplied = this.netSit;
    }
    B.hips.rotation.set(bd.hipsX, bd.hipsY, 0);
    // at the net the lean is limited: a head below the tape stays on its own side
    let lean = bd.spineX;
    if (lean < 0 && a.rpos.y + CHARACTER.netClear.headHeight * H < this.netTop + CHARACTER.netClear.above) {
      const room = a.rpos.z * a.side - CHARACTER.netClear.head;
      const lever = CHARACTER.netClear.headLever * H;
      if (room < lever && Math.abs(a.rpos.x) < COURT.netHalfLength + CHARACTER.netClear.pastPost)
        lean = Math.max(lean, -Math.asin(clamp01(room / lever)));
    }
    B.spine.rotation.set(lean * 0.55, bd.chestY * 0.4, bd.chestZ * 0.5);
    B.chest.rotation.set(lean * 0.45 + bd.chestX, bd.chestY * 0.6, bd.chestZ * 0.5);
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
      'fingersL',
      'fingersR',
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
    this.updateArms(dt, tr, swingS, swingF, recover, swing);

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

    if (st === 'dive') {
      // stretched out behind along the floor, toes down
      const p = this.diveP();
      for (let i = 0; i < 2; i++) {
        const s = i === 0 ? -1 : 1;
        const f = this.feet[i];
        this.bodyToWorld(s * 0.09 * H, 0, -(d.thigh + d.shin) * 0.99 * p + 0.02 * H * (1 - p), _t3);
        _t4.set(a.rpos.x + _t3.x, ankleY + 0.06 * p, a.rpos.z + _t3.z);
        f.cur.lerp(_t4, damp(18, dt));
        f.pitch = lerp(f.pitch, 1.3 * p, damp(12, dt));
        f.plant.set(f.cur.x, ankleY, f.cur.z);
        f.stepping = false;
      }
    } else if (st === 'air') {
      // body-relative leg pose
      const tSince = tr - a.takeoffT;
      const rise = smooth01(tSince / 0.14);
      const attack = a.airIntent === 'attack' && !(a.action && a.action.kind === 'block');
      const tuck = attack ? smooth01((tSince - 0.12) / 0.25) : 0;
      // after the swing, legs come forward for landing
      const sw = a.action && a.action.kind === 'swing' ? a.action : a.lastAction && a.lastAction.kind === 'swing' ? a.lastAction : null;
      let kick = 0;
      if (sw && tr > sw.t0) kick = smooth01((tr - sw.t0) / 0.3) * (1 - 0.55 * smooth01((tr - sw.contactT - 0.12) / 0.3));
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
      // the last of the drop: the legs open and the feet reach down, so they meet the floor as the body arrives
      const reachDown = a.vel.y < 0 ? 1 - smoothstep(0.06, 0.5, a.rpos.y) : 0;
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
        up = lerp(up, d.ankleY + 0.012 * H, reachDown);
        fwd = lerp(fwd, (s === hs ? 0.015 : 0.04) * H, reachDown);
        this.bodyToWorld(lat, 0, fwd, _t3);
        const target = _t4.set(a.rpos.x + _t3.x, a.rpos.y + up, a.rpos.z + _t3.z);
        // the feet travel with the body and ease towards their pose from there (easing in the world
        // would leave them trailing a quarter of a metre above a falling body)
        f.cur.add(this.rootMove);
        f.cur.lerp(target, damp(rise < 1 ? 30 : 16, dt));
        f.pitch = lerp(f.pitch, lerp(lerp(0.9, 0.5, prep), 0.22, reachDown), damp(12, dt));
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
            f.cur.y = ankleY + Math.sin(Math.PI * p) * 0.045 * H + this.hop;
            if (p >= 1) {
              f.stepping = false;
              f.plant.copy(f.to);
              this.onFootstep?.(a, 0.5);
            }
          } else {
            f.cur.lerp(f.plant, damp(25, dt));
            f.cur.y = ankleY + this.hop;
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
          _t4.set(a.rpos.x + _t3.x, ankleY + lift + this.hop, a.rpos.z + _t3.z);
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

    // ---- at the net: the feet stay behind the centre line (toes and all)...
    const side = a.side;
    const atNet = Math.abs(a.rpos.x) < COURT.netHalfLength + CHARACTER.netClear.pastPost;
    if (atNet) {
      const toes = (d.footLen - d.heel) * Math.abs(Math.cos(a.ryaw)) + CHARACTER.netClear.toes;
      for (const f of this.feet) {
        if (f.cur.z * side < toes) f.cur.z = side * toes;
        if (f.plant.z * side < toes) f.plant.z = side * toes;
      }
    }

    // ---- solve legs
    const solve = () => {
      let worst = Infinity;
      for (let i = 0; i < 2; i++) {
        const s = i === 0 ? -1 : 1;
        const L = s < 0 ? 'L' : 'R';
        const thigh = B[`thigh${L}` as BoneName];
        const shin = B[`shin${L}` as BoneName];
        const foot = B[`foot${L}` as BoneName];
        const f = this.feet[i];
        thigh.quaternion.identity();
        shin.quaternion.identity();
        thigh.updateMatrixWorld(true);
        // knee points forward and slightly out
        // (stretched out in a dive, the knees point at the floor)
        const dp = st === 'dive' ? this.diveP() : 0;
        this.bodyToWorld(s * 0.25, lerp(0.05, 0.3, dp), lerp(1, -0.6, dp), _pole);
        twoBoneIK(thigh, shin, foot.position, f.cur, _pole);
        // foot orientation: yaw with body (+ slight toe-out), pitch from gait/air
        const yaw = this.athlete.ryaw - s * 0.12;
        _q.setFromEuler(_e.set(-f.pitch, yaw, 0, 'YXZ'));
        parentInv(foot, _pq);
        foot.quaternion.copy(_pq.multiply(_q));
        foot.updateMatrixWorld(true);
        worst = Math.min(worst, shin.getWorldPosition(_t3).z * side);
      }
      return worst;
    };
    const knee = solve();
    // ...and so do the knees: the hips sit back from the net as far as the bent knees need
    // (a blocker loads with the hips back, not with the knees under the net)
    const room = knee - CHARACTER.netClear.knee;
    const want = atNet ? Math.max(0, this.netSit - room) : 0;
    // back at once when the knees need it, forward again at leisure
    this.netSit = want > this.netSit ? want : lerp(this.netSit, want, damp(CHARACTER.netClear.sitRate, dt));
    if (this.netSit > 1e-4) {
      // the hips were already set back by last frame's amount (see update): take up the change and solve again
      const delta = this.netSit - this.netSitApplied;
      this.shiftHips(delta);
      this.netSitApplied = this.netSit;
      solve();
    }
  }

  private netSitApplied = 0;

  /** move the hips (and all they carry) `dist` metres straight back from the net */
  private shiftHips(dist: number): void {
    if (dist === 0) return;
    const hips = this.rig.bones.hips;
    // world +z * side, in the root's own frame
    const y = this.athlete.ryaw;
    const sd = this.athlete.side * dist;
    hips.position.x += -Math.sin(y) * sd;
    hips.position.z += Math.cos(y) * sd;
    this.root.updateMatrixWorld(true);
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

  private updateArms(dt: number, tr: number, swingS: number, swingF: number, recover: number, swing: Athlete['action']): void {
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
      const shape = setShape(_shape, SH.relaxed);
      // an exact hand placement (fingers and palm directions in the world), blended in by `handBlend`
      let handBlend = 0;

      // ---- base: ground locomotion / ready
      if (st === 'dive') {
        // on the floor: the arms stay stretched out ahead until the body is up again (the dig itself is the pass below)
        const dp = this.diveP();
        this.key('ready', w, pole);
        this.key('pass', _a, _b);
        _a.y = lerp(_a.y, -0.07 * H, dp);
        _a.z = lerp(_a.z, 0.36 * H, dp);
        w.lerp(_a, dp);
        pole.lerp(_b, dp);
      } else if (st === 'ground' || st === 'land') {
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
        // the plant: both arms go back, then start down past the hips and up in front
        this.jumpSwing(a.loadT, w, pole);
        rate = 55;
      } else {
        // air: the two-arm swing carries on up, then each arm goes to what the jump is for
        const up = this.jumpSwing(a.loadT + tSinceTake, w, pole);
        rate = 30;
        const intent = a.airIntent;
        const blending = Math.max(smooth01((up - 0.55) / 0.4), smooth01((tSinceTake - 0.24) / 0.16));
        this.armsUp = blending;
        if (intent === 'attack') {
          if (swing && swingF >= 0) this.key('descend', _a, _b);
          else if (hitting) this.key('cock', _a, _b);
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
      // after a hit the arm comes through, then lets go for the landing (it never re-cocks in the air)
      const afterFollow = !!swing && swingF >= 1 && st === 'air';
      if (swing && (swingS >= 0 || (swingF >= 0 && swingF < 1) || afterFollow)) {
        rate = afterFollow ? 14 : 80;
        const ch = swing.tip ? 0 : swing.charge;
        if (hitting) {
          // the palm meets the ball behind it and a little over the top, on the line the ball leaves along
          const shoulder = this.shoulderWorld(s, _f1);
          const contactW = this.palmOnBall(swing.contactPoint, swing.aim, shoulder, _d);
          const contactLocal = this.worldToBody(_f2.subVectors(contactW, shoulder), _f2);
          contactLocal.x *= s;
          if (swingS >= 0) {
            this.cockAt(swing.charge, _a, _b);
            this.key('over', _e1, _e2);
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
              handBlend = ikBlend;
            }
            palmFwd = 1;
            // flat and firm through the swing, wrapping the ball as the palm meets it
            mixShape(setShape(shape, SH.firm), SH.onBall, handBlend);
          } else {
            // follow-through: fastest off the ball and slowing all the way down, across the body;
            // a full-power swing finishes deeper, by the opposite hip
            this.key('followMid', _e1, _e2);
            if (swing.tip) this.key('airNeutral', _a, _b);
            else {
              this.key('follow', _a, _b);
              this.key('followDeep', _h1, _h2);
              _a.lerp(_h1, ch);
              _b.lerp(_h2, ch);
            }
            const e = 1 - Math.pow(1 - swingF, 2.2);
            bezier(contactLocal, _e1, _a, e, w);
            pole.set(1, 0.1, -0.6).lerp(_b, e);
            palmFwd = 1 - e;
            // the hand stays on the ball's line for an instant, then the wrist snaps over the top and relaxes
            handBlend = 1 - smooth01(swingF / 0.16);
            if (handBlend > 0) {
              ikWorld = _g.copy(contactW);
              ikBlend = handBlend;
            }
            if (!swing.tip)
              flex = (0.2 + 0.85 * easeOutCubic(swingF * 3.5)) * (1 - 0.55 * smooth01((swingF - 0.35) / 0.65)) * (0.6 + 0.4 * ch);
            mixShape(setShape(shape, SH.onBall), SH.relaxed, smooth01(swingF * 1.5));
            // then the arm lets go and hangs ready for the landing
            if (recover > 0) {
              this.key('descend', _h1, _h2);
              w.lerp(_h1, recover);
              pole.lerp(_h2, recover);
              flex *= 1 - recover;
            }
          }
        } else {
          // the off arm pulls down first: it leads the turn of the chest
          const e = swingS >= 0 ? smooth01(swingS * 1.4) : 1;
          this.key('offFollow', _a, _b);
          w.lerp(_a, e * 0.9);
          pole.lerp(_b, e);
          if (recover > 0) {
            this.key('descend', _h1, _h2);
            w.lerp(_h1, recover);
            pole.lerp(_h2, recover);
          }
        }
      }
      if (act && act.kind === 'block') {
        const p = act.held ? smooth01((tr - act.t0) / 0.1) : 1 - smooth01((tr - act.releaseT) / 0.2);
        this.key('block', _a, _b);
        if (st === 'air') _a.z += 0.06 * H * smooth01((tr - act.t0) / 0.18); // press over the net
        _a.x += 0.012 * H;
        // a late blocker stretches sideways for the seam: both hands go that way, a little lower
        _a.x += a.reachX * Math.cos(a.ryaw) * s;
        _a.y -= Math.abs(a.reachX) * CONTACT.blockReachDrop;
        w.lerp(_a, p);
        pole.lerp(_b, p);
        rate = 30;
        palmFwd = p;
        mixShape(shape, SH.firm, p);
        // the hands go to the ball as it arrives (a short way: the block is where it was set). They stay
        // on the blocker's side of the tape, where the block's contact zone is: pressing them over it
        // would be a change to the block, not to its look
        // (only for a ball hit at the block: a set drifting past is not followed)
        const bv = a.ballVel;
        if (act.held && bv && Math.hypot(bv.x, bv.y, bv.z) > CHARACTER.blockReach.minSpeed && bv.z * a.side > 0) {
          ikWorld = this.reachForBall(s, _a, CHARACTER.blockReach.near, CHARACTER.blockReach.pull, _g, 'block', null);
          if (ikWorld) ikBlend = handBlend = reachBlend * p;
        }
      }
      if (act && act.kind === 'pass' && act.form !== 'hands') {
        const p = smooth01((tr - act.t0) / 0.07);
        this.key('pass', _a, _b);
        // diving: the arms stretch out ahead, just off the floor
        if (st === 'dive') {
          const dp = this.diveP();
          _a.y = lerp(_a.y, -0.07 * H, dp);
          _a.z = lerp(_a.z, 0.36 * H, dp);
        }
        w.lerp(_a, p);
        pole.lerp(_b, p);
        rate = 35;
        if (!(act.resolved && act.contactT > 0)) {
          // the platform goes to where the ball will come down and waits there, still
          ikWorld = this.reachForBall(s, w, 0.7, 0.5, _g, 'platform', null);
          if (ikWorld) ikBlend = reachBlend;
        } else {
          // the touch: the platform stays where it met the ball. A hard-driven ball is taken on a firm
          // platform that gives a little; a slow one is lifted through. It never goes after the ball.
          const P = CHARACTER.pass;
          const ts = tr - act.contactT;
          const firm = smoothstep(P.firmFrom, P.firmTo, this.ballIn);
          const move = (1 - firm) * P.lift * easeOutCubic(ts / P.liftTime) - firm * P.give * Math.sin(Math.PI * clamp01(ts / P.giveTime));
          _n2.copy(this.ballOut).add(_up).normalize().multiplyScalar(move).add(act.contactPoint);
          ikWorld = this.reachForBall(s, w, 0.7, 0.5, _g, 'platform', _n2);
          if (ikWorld) ikBlend = 1 - smooth01((ts - P.hold) / P.release);
        }
        mixShape(shape, SH.fist, p);
      }
      if (act && (act.kind === 'set' || (act.kind === 'pass' && act.form === 'hands'))) {
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
          // the hands wait above the forehead where the ball will arrive: it drops into them
          ikWorld = this.reachForBall(s, w, 0.6, 0.6, _g, 'set', null);
          if (ikWorld) ikBlend = handBlend = reachBlend;
        } else {
          // the release: the arms extend along the line the ball left on, at arm speed (the ball is
          // gone at once: the hands push through where it was, they do not carry it), then open
          const F = CHARACTER.setFollow;
          const ts = tr - act.contactT;
          _n2
            .copy(this.ballOut)
            .multiplyScalar(Math.min(F.reach, F.speed * ts))
            .add(act.contactPoint);
          ikWorld = this.reachForBall(s, w, 0.6, 0.6, _g, 'set', _n2);
          if (ikWorld) ikBlend = handBlend = 1 - smooth01((ts - F.reach / F.speed) / F.time);
        }
        mixShape(shape, released ? SH.firm : SH.onBall, p);
      }
      // (during the plant the arms still swing back; the wind-up shows from takeoff)
      if (act && act.kind === 'windup' && st !== 'load') {
        // (off the floor the arm goes up with the jump first, then draws back: the bow comes out of the swing)
        const p = smooth01((tr - act.t0) / 0.12) * (st === 'air' ? this.armsUp : 1);
        if (hitting) {
          this.cockAt(windupCharge(act.t0, tr), _a, _b);
          w.lerp(_a, p);
          pole.lerp(_b, p);
          rate = 30;
          flex = -0.3 * p;
          mixShape(shape, SH.firm, p);
        } else if (st !== 'air') {
          // serving: the tossing arm stays up; otherwise it reaches forward for balance
          this.key(a.lastAction?.kind === 'toss' ? 'toss' : 'airNeutral', _a, _b);
          w.lerp(_a, p);
          pole.lerp(_b, p);
          rate = 25;
        }
      }
      // (a jump serve: once the feet plant, the arms leave the toss and swing through the jump like any other)
      const tossing = act && act.kind === 'toss' && st !== 'load' && st !== 'air';
      if (tossing && !hitting) {
        const p = smooth01((tr - act.t0) / 0.18);
        this.key('toss', _a, _b);
        w.lerp(_a, p);
        pole.lerp(_b, p);
        rate = 30;
      }
      if (tossing && hitting) {
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
      mixShape(arm.shape, shape, damp(CHARACTER.hand.rate, dt));
      if (rate >= 80 || this.snapArms) {
        // a swing is quicker than a hand can ease: the fingers are on the ball when the palm is
        arm.w.copy(w);
        arm.pole.copy(pole);
        arm.flex = flex;
        setShape(arm.shape, shape);
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
      this.clearNet(target, CHARACTER.netClear.wrist);
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
      if (handBlend > 0) {
        // on the ball: the hand takes the exact facing the contact asks for
        fore.lerp(_handFore, handBlend).normalize();
        _f2.lerp(_handPalm, handBlend).normalize();
      }
      // at the net the fingers bend back with the wrist: fingertips stay off it too. The hand turns
      // (it keeps its length): its reach towards the net is cut to what is allowed, the rest of its
      // direction takes up the slack
      hand.getWorldPosition(_n1);
      _n2.copy(_n1).addScaledVector(fore, this.rig.dims.hand);
      if (this.clearNet(_n2, CHARACTER.netClear.fingers)) {
        const fz = clamp((_n2.z - _n1.z) / this.rig.dims.hand, -1, 1);
        const flat = Math.hypot(fore.x, fore.y);
        const k = Math.sqrt(1 - fz * fz);
        if (flat > 1e-4) fore.set((fore.x / flat) * k, (fore.y / flat) * k, fz);
        else fore.set(0, k, fz);
      }
      // the hand's thin axis (local x) is the palm normal: +x = -palm for the right hand
      orientBone(hand, fore, _f2.multiplyScalar(-s), 1);
      // fingers: loosely curled at rest, spread and laid round the ball on it, closed for a pass.
      // They curl together at the knuckle line, then each fans out and bends at its own middle joint.
      const sh = arm.shape;
      const fingers = B[`fingers${L}` as BoneName];
      fingers.rotation.set(0, 0, -s * sh.knuckle);
      const dg = this.digits[i];
      for (let k = 0; k < FINGERS.length; k++) {
        const outer = Math.abs(FINGERS[k].fan) * sh.cup;
        dg[k * 2].rotation.set(sh.spread * FINGERS[k].fan, 0, -s * outer);
        dg[k * 2 + 1].rotation.set(0, 0, -s * (sh.mid - outer));
      }
      // the thumb opens away from the fingers (about the palm's normal) and bends in towards the palm
      const th = dg[FINGERS.length * 2];
      th.rotation.set(sh.thumbOut, s * sh.thumbCurl * 0.5, 0);
      dg[FINGERS.length * 2 + 1].rotation.set(0, s * sh.thumbCurl, -s * sh.thumbCurl * 0.5);
      fingers.updateMatrixWorld(true);
      th.updateMatrixWorld(true);
      ikBlend = 1;
    }
  }

  /**
   * The two-arm swing of a jump, `t` seconds after the plant began: the arms whip back and up behind
   * the hips as the feet plant, then swing down past the hips and up in front as the legs drive.
   * A run-up swings them further back than a standing jump. Returns how far up they are (0..1).
   */
  private jumpSwing(t: number, w: V, pole: V): number {
    const a = this.athlete;
    const J = CHARACTER.jumpSwing;
    const reach = J.radius * this.H;
    // a block's hands stay in front of the chest: they go straight up from there
    const blockJump = !!a.action && a.action.kind === 'block';
    const run = blockJump ? 0 : clamp01(a.loadApproach / J.fullRun);
    const back = smooth01(t / J.backTime);
    const up = smooth01((t - J.upStart) / J.upTime);
    // angle of the arm in the plane it swings in: 0 hangs straight down, negative is behind the body
    const th = lerp(-(J.backStanding + (J.backRun - J.backStanding) * run), J.top, up);
    this.key('ready', w, pole);
    _a.set((0.03 + 0.03 * up) * this.H, -Math.cos(th) * reach, Math.sin(th) * reach);
    // from where the hands were, down past the hip and back (not straight through the shoulder)
    if (blockJump) w.lerp(_a, up);
    else bezier(_ck1.copy(w), _ck2.set(0.04 * this.H, -0.92 * reach, 0.02 * this.H), _a, back, w);
    // the elbow trails the swing: behind the arm on the way back, under it on the way up
    pole.lerp(_b.set(0.5, lerp(0.6, -0.4, up), lerp(-0.4, -0.9, up)), back);
    return up;
  }

  /**
   * Keep a point of the arm off the net. Below the tape it stays `margin` on the athlete's own
   * side; above the tape it may reach across, further the higher it is, so a hand coming down
   * from over the net is drawn back before it gets to the tape. Returns true if it moved the point.
   *
   * This draws what a player does anyway (pull the hand back) and is all there is: the simulation
   * has no arm, so nothing here moves the ball or the body (docs/adr/0008).
   */
  private clearNet(p: V, margin: number): boolean {
    const side = this.athlete.side;
    if (Math.abs(p.x) > COURT.netHalfLength + CHARACTER.netClear.pastPost) return false;
    const over = Math.max(0, p.y - this.netTop - CHARACTER.netClear.above);
    const min = margin - over * CHARACTER.netClear.reachPerHeight;
    if (p.z * side >= min) return false;
    p.z = side * min;
    return true;
  }

  /**
   * Where the wrist goes for a spiking palm to lie on the ball (and, in `_handFore` / `_handPalm`,
   * the hand's facing). The palm meets the ball behind it, on the line it leaves along, and a
   * little over the top. A ball too high for that is met lower on its back: the arm is only so long.
   */
  private palmOnBall(ball: V, aim: V, shoulder: V, out: V): V {
    const d = this.rig.dims;
    const reach = (d.upperArm + d.foreArm) * 0.995;
    for (let i = 0; i <= PALM_TRIES; i++) {
      // from the ball's centre out to the palm; the last try faces the ball straight from the shoulder
      if (i < PALM_TRIES)
        _n1
          .copy(aim)
          .normalize()
          .negate()
          .addScaledVector(_up, CHARACTER.palmOverTop - i * 0.3)
          .normalize();
      else _n1.subVectors(shoulder, ball).normalize();
      const palmPoint = _n2.copy(ball).addScaledVector(_n1, BALL.radius + d.palmThick);
      // the fingers lie along the arm as far as the palm's facing allows
      _n3.subVectors(palmPoint, shoulder).normalize();
      _n3.addScaledVector(_n1, -_n3.dot(_n1));
      if (_n3.lengthSq() < 1e-6) _n3.copy(_up).addScaledVector(_n1, -_n1.y);
      _n3.normalize();
      out.copy(palmPoint).addScaledVector(_n3, -d.palm);
      if (out.distanceTo(shoulder) <= reach) break;
    }
    _handFore.copy(_n3);
    _handPalm.copy(_n1).negate();
    return out;
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

  /** 0..1 how far into a dive the body is: down onto the floor, held, then back up */
  private diveP(): number {
    const t = this.athlete.stateT;
    return smooth01(t / PLAYER.diveDown) * (1 - smooth01((t - (PLAYER.diveTime - 0.4)) / 0.4));
  }

  /** how far the ball is to the body's right (+) or left (-), m (0 without a ball) */
  private ballSide(): number {
    const a = this.athlete;
    const b = a.ballPos;
    if (!b) return 0;
    const r = rightFromYaw(a.ryaw, _f1);
    return (b.x - a.rpos.x) * r.x + (b.z - a.rpos.z) * r.z;
  }

  /**
   * Bring the arm to the ball when it is near, so the right part of it meets the ball's surface:
   * the forearms for a pass (the platform), the palms for a set or a block. Returns the wrist
   * target, or null with the ball out of range. For palms it also sets the hand's facing.
   */
  private reachForBall(
    s: number,
    wLocal: V,
    near: number,
    maxPull: number,
    out: V,
    kind: 'platform' | 'set' | 'block',
    /** the ball's centre to meet; null = where the live ball will be when it gets here */
    at: V | null,
  ): V | null {
    const d = this.rig.dims;
    const sh = this.shoulderWorld(s, _f1);
    this.bodyToWorld(wLocal.x * s, wLocal.y, wLocal.z, _f3);
    const base = _f2.copy(sh).add(_f3);
    let ball = at;
    let soon = 1;
    if (!ball) {
      if (!this.athlete.ballPos) return null;
      // players put their hands where the ball is going and let it arrive: they do not track it down.
      // The touch happens where the ball comes nearest the platform's or the hands' own spot.
      const zone = kind === 'platform' ? this.passZone : kind === 'set' ? this.setZone : null;
      const t = this.ballArrival(zone ?? base, _arrive);
      ball = _arrive;
      soon = 1 - smoothstep(CHARACTER.meet.by, CHARACTER.meet.from, t);
    }
    const dist = base.distanceTo(ball);
    if (dist > near + 0.6) return null;
    reachBlend = smooth01((near + 0.6 - dist) / 0.6) * soon;
    if (kind === 'platform') {
      // the ball comes down on the forearms, above the wrists; the two arms lie side by side under it
      const arm = _n3.subVectors(base, sh).normalize();
      const n = _n1.copy(_up).addScaledVector(arm, -arm.y).normalize();
      out
        .copy(ball)
        .addScaledVector(n, -(BALL.radius + CHARACTER.forearmRadius * this.H))
        .addScaledVector(arm, CHARACTER.platformContact * d.foreArm);
      // side by side under the ball, wrists together (one hand in the other)
      this.bodyToWorld(s * CHARACTER.pass.wristApart * this.H, 0, 0, _f3);
      out.add(_f3);
    } else {
      // a palm on the ball: where on the ball it sits (from the ball's centre), and which way the fingers lie
      const c = HAND_ON_BALL[kind];
      this.bodyToWorld(s * c.at[0], c.at[1], c.at[2], _n1).normalize();
      this.bodyToWorld(s * c.fingers[0], c.fingers[1], c.fingers[2], _n3);
      _n3.addScaledVector(_n1, -_n3.dot(_n1)).normalize();
      out
        .copy(ball)
        .addScaledVector(_n1, BALL.radius + d.palmThick)
        .addScaledVector(_n3, -d.palm);
      _handFore.copy(_n3);
      _handPalm.copy(_n1).negate();
    }
    // only so far from where the arm already is
    _f3.subVectors(out, base);
    const l = _f3.length();
    if (l > maxPull) out.copy(base).addScaledVector(_f3, maxPull / l);
    return out;
  }

  /**
   * Where the ball will be when it comes closest to `near`, flying on as it is (gravity only, which
   * is all that matters over the last half second). Returns how long until then (s).
   */
  private ballArrival(near: V, out: V): number {
    const p = this.athlete.ballPos!;
    const v = this.athlete.ballVel;
    out.copy(p);
    if (!v) return 0;
    const g = BALL.gravity;
    const at = (t: number, o: V) => o.set(p.x + v.x * t, p.y + v.y * t - 0.5 * g * t * t, p.z + v.z * t);
    let best = out.distanceToSquared(near);
    let bt = 0;
    const step = CHARACTER.meet.step;
    for (let t = step; t <= CHARACTER.meet.horizon; t += step) {
      const d2 = at(t, _t3).distanceToSquared(near);
      if (d2 > best) break;
      best = d2;
      bt = t;
    }
    // between two samples a fast ball travels a quarter of a metre: finish on the exact nearest point
    // (along the velocity there), or the hands would hop from sample to sample as the ball comes in
    at(bt, out);
    const vy = v.y - g * bt;
    const v2 = v.x * v.x + vy * vy + v.z * v.z;
    if (v2 > 1e-6) {
      const along = ((near.x - out.x) * v.x + (near.y - out.y) * vy + (near.z - out.z) * v.z) / v2;
      bt = Math.max(0, bt + clamp(along, -step, step));
      at(bt, out);
    }
    return bt;
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

type HandShape = { knuckle: number; mid: number; spread: number; cup: number; thumbOut: number; thumbCurl: number };
const SH = CHARACTER.hand;
const _shape: HandShape = { ...SH.relaxed };

function setShape(o: HandShape, a: HandShape): HandShape {
  o.knuckle = a.knuckle;
  o.mid = a.mid;
  o.spread = a.spread;
  o.cup = a.cup;
  o.thumbOut = a.thumbOut;
  o.thumbCurl = a.thumbCurl;
  return o;
}

/** move `o` a fraction `t` of the way to `b` */
function mixShape(o: HandShape, b: HandShape, t: number): HandShape {
  o.knuckle = lerp(o.knuckle, b.knuckle, t);
  o.mid = lerp(o.mid, b.mid, t);
  o.spread = lerp(o.spread, b.spread, t);
  o.cup = lerp(o.cup, b.cup, t);
  o.thumbOut = lerp(o.thumbOut, b.thumbOut, t);
  o.thumbCurl = lerp(o.thumbCurl, b.thumbCurl, t);
  return o;
}

let ikBlend = 1;
let reachBlend = 1;

/** how many lower spots on the ball a spiking palm tries before it faces the ball straight from the shoulder */
const PALM_TRIES = 4;

/**
 * A palm on the ball, in the body frame (lat towards the hand's own side, up, forward): where it
 * sits from the ball's centre, and which way the fingers lie. Setting: under and behind the ball,
 * fingers up and in. Blocking: behind the ball, fingers up.
 */
const HAND_ON_BALL = {
  set: { at: [0.58, -0.52, -0.63], fingers: [-0.35, 0.9, 0.1] },
  block: { at: [0.42, -0.08, -0.9], fingers: [0, 1, 0.2] },
} as const;

/**
 * How long the hitting arm takes to come through after the ball (s): a harder swing is quicker.
 * An estimate, not a measurement: a hand leaving the ball at 15 to 20 m/s on a 0.75 m arm turns at
 * 20 to 27 rad/s, and slowing evenly from there through the 2.6 rad down to the hip takes 0.2 to 0.26 s.
 */
function followTime(tip: boolean, charge: number): number {
  return tip ? 0.22 : 0.3 - 0.05 * charge;
}

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
const _n1 = v3();
const _n2 = v3();
const _n3 = v3();
const _arrive = v3();
const _handFore = v3();
const _handPalm = v3();
const _up = v3(0, 1, 0);
const _q = new THREE.Quaternion();
const _pq = new THREE.Quaternion();
const _e = new THREE.Euler();
