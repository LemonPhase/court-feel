import * as THREE from 'three';
import { ASSIST, BALL, CONTACT, COURT, TIMING } from '../config';
import { clamp, clamp01, dirFromYaw, lerp, rightFromYaw, smooth01, wrapAngle, yawFromDir } from '../core/mathx';
import { R, topspinFor, type V3 } from '../physics/ball';
import { netClearance, solveApex, solveFixedTime, solveSpeedToFloor } from '../physics/solve';
import { Athlete, type Action, type Grade } from './athlete';
import type { BallEntity, TouchKind } from './ballEntity';

export interface ContactEvent {
  athlete: Athlete;
  kind: TouchKind;
  grade: Grade | null;
  note: string;
  /** outgoing ball speed (m/s) */
  speed: number;
  point: THREE.Vector3;
  /** 0..1 how good it was (drives FX intensity) */
  quality: number;
  perfect: boolean;
  tip: boolean;
  /** intended target (floor) */
  target: THREE.Vector3;
  /** swing power 0..1 from the wind-up hold (spikes / serves) */
  power?: number;
}

export interface IdealInfo {
  /** absolute sim time of the best contact */
  t: number;
  /** distance between ball and ideal contact point at that time */
  d: number;
  /** ball position at that time */
  ball: THREE.Vector3;
  /** athlete's ideal contact point at that time */
  point: THREE.Vector3;
}

export interface ContactHost {
  ball: BallEntity;
  simTime: number;
  env: { netTop: number };
  aimAssist(a: Athlete): number;
  /** user aim target on the floor for this athlete (or null for AI-provided) */
  aimTargetFor(a: Athlete, out: THREE.Vector3): THREE.Vector3;
  emitContact(ev: ContactEvent): void;
  /** random number 0..1 */
  rand(): number;
  /** where a pass from this athlete should go (ball centre, apex) */
  passTarget(a: Athlete): { x: number; y: number; z: number; apex: number };
  /** set choices for a setter (the aim picks one) */
  setOptions(a: Athlete): SetOption[];
  /** can this athlete toss a serve now */
  canServe(a: Athlete): boolean;
}

export interface SetOption {
  target: V3;
  apex: number;
  hitter: Athlete | null;
  label: string;
  /** fixed flight time (a quick meeting a hitter already in the air) instead of an apex */
  time?: number;
}

const GRADE_RANK: Record<Grade, number> = { Perfect: 3, Good: 2, Early: 1, Late: 1, Miss: 0 };

/**
 * Timing + contact resolution for scheduled swings (spikes, serves, tips).
 * The swing begins on the input frame; its contact is scheduled at the
 * predicted best moment, clamped to what a real arm swing can stretch to, and
 * graded on how far the click was from ideal (plus jump timing and reach).
 */
export class ContactSystem {
  constructor(private host: ContactHost) {}

  private _a = new THREE.Vector3();
  private _p = new THREE.Vector3();
  private _b: V3 = { x: 0, y: 0, z: 0 };

  /** search the next `horizon` seconds for the moment the ball is closest to the athlete's ideal point */
  ideal(a: Athlete, from: number, horizon = TIMING.contactLookahead, out?: IdealInfo): IdealInfo | null {
    const h = this.host;
    if (!h.ball.active) return null;
    const pred = h.ball.ensurePrediction(h.env, h.simTime);
    const res = out ?? { t: 0, d: 1e9, ball: new THREE.Vector3(), point: new THREE.Vector3() };
    res.d = 1e9;
    const dt = pred.dt;
    // integrate the athlete's (ballistic) path incrementally alongside the samples: O(n)
    const airborne = a.state === 'air';
    let y = a.pos.y;
    let vy = a.vel.y;
    let tAth = h.simTime;
    const stepTo = (t: number) => {
      while (airborne && tAth < t - 1e-9) {
        const st = Math.min(1 / 240, t - tAth);
        vy -= Athlete.gravityAt(vy) * st;
        y = Math.max(0, y + vy * st);
        tAth += st;
      }
      tAth = Math.max(tAth, t);
    };
    for (let t = from; t <= from + horizon; t += dt) {
      if (pred.landT > 0 && t > pred.landT) break;
      pred.posAt(t, this._b);
      stepTo(t);
      const el = t - h.simTime;
      this._a.set(a.pos.x + a.vel.x * el, airborne ? y : a.pos.y, a.pos.z + a.vel.z * el);
      a.idealContact(this._p, this._a);
      const d = Math.hypot(this._b.x - this._p.x, this._b.y - this._p.y, this._b.z - this._p.z);
      if (d < res.d) {
        res.d = d;
        res.t = t;
        res.ball.set(this._b.x, this._b.y, this._b.z);
        res.point.copy(this._p);
      }
    }
    return res.d < 1e8 ? res : null;
  }

  reach(a: Athlete): number {
    return CONTACT.spikeReach + this.host.aimAssist(a) * ASSIST.reachBonus;
  }

  /** attack button down: draw the arm back; power builds while it is held */
  beginWindup(a: Athlete): Action {
    return a.startAction('windup', this.host.simTime);
  }

  /** release-to-contact swing time: a fully charged arm comes through a little faster */
  static swingLead(charge: number): number {
    return lerp(TIMING.swingNominal, TIMING.swingCharged, clamp01(charge));
  }

  /** 0..1 power a wind-up started at t0 has built by `now` (0 until it is longer than a tap) */
  static chargeFor(holdS: number): number {
    return clamp01((holdS - TIMING.tapThreshold) / (TIMING.chargeFull - TIMING.tapThreshold));
  }

  /**
   * Attack button up: the swing starts now and meets the ball at the best
   * moment it can still reach (graded on this release). A hold shorter than
   * a tap becomes a tip; longer holds hit harder up to full charge.
   */
  releaseWindup(a: Athlete, opts: { aiErr?: number; tip?: boolean } = {}): Action | null {
    const act = a.action;
    if (!act || act.kind !== 'windup') return null;
    const hold = this.host.simTime - act.t0;
    const tip = opts.tip ?? hold < TIMING.tapThreshold;
    // the closest approach the wind-up saw for this ball (it may already be behind a late release)
    const seen = act.idealFor === this.host.ball.lastTouch && act.idealT > 0 ? { t: act.idealT, d: act.idealD } : undefined;
    return this.startSwing(a, { aiErr: opts.aiErr, charge: tip ? 0 : ContactSystem.chargeFor(hold), tip, seen });
  }

  /** during a wind-up: remember the closest approach of the ball to the ideal contact point */
  private trackIdeal(a: Athlete, act: Action): void {
    const h = this.host;
    const lt = h.ball.lastTouch;
    if (act.idealFor !== lt) {
      act.idealFor = lt;
      act.idealT = -1;
      act.idealD = 1e9;
    }
    // only where the prediction is real: in the air, or standing under your own serve toss
    if (!h.ball.active || !(a.state === 'air' || (a.state === 'ground' && this.serving === a))) return;
    const info = this.ideal(a, h.simTime, 0.4, this._wi);
    if (info && info.d < act.idealD) {
      act.idealD = info.d;
      act.idealT = info.t;
    }
  }
  private _wi: IdealInfo = { t: 0, d: 1e9, ball: new THREE.Vector3(), point: new THREE.Vector3() };

  /** begin a spike/serve swing now (the release of the wind-up) */
  startSwing(a: Athlete, opts: { aiErr?: number; charge?: number; tip?: boolean; seen?: { t: number; d: number } } = {}): Action {
    const h = this.host;
    const t = h.simTime;
    const act = a.startAction('swing', t);
    act.charge = opts.charge ?? 1;
    act.tip = opts.tip ?? false;
    const lead = ContactSystem.swingLead(act.tip ? 0 : act.charge);
    const info = this.ideal(a, t + TIMING.swingMin * 0.5);
    let tStar = t + lead;
    if (info && info.d < CONTACT.spikeReachStretch + 0.8) tStar = info.t;
    // grade against the true best moment: on a late release it can already be behind us,
    // where the forward search would only find the edge of its window
    // (only when the forward search lands on the very start of its window: the ball is already past)
    let idealT = tStar;
    const seen = opts.seen;
    const pastBest = !info || info.t <= t + TIMING.swingMin * 0.5 + 0.02;
    if (pastBest && seen && seen.t < tStar - 1e-3 && seen.t > t - 0.3 && (!info || seen.d <= info.d + 0.02)) idealT = seen.t;
    // AI hitters "release" with a skill-based error instead of reading input
    const clickT = opts.aiErr !== undefined ? idealT - lead + opts.aiErr : t;
    act.err = clickT + lead - idealT;
    act.contactT = clamp(tStar, t + TIMING.swingMin, t + TIMING.swingMax);
    if (opts.aiErr !== undefined) act.contactT = clamp(tStar + opts.aiErr * 0.5, t + TIMING.swingMin, t + TIMING.swingMax + 0.1);
    // provisional contact point for the animator (refined every step)
    h.ball.ensurePrediction(h.env, t).posAt(act.contactT, this._b);
    act.contactPoint.set(this._b.x, this._b.y, this._b.z);
    h.aimTargetFor(a, this._a);
    act.aim.copy(this._a).sub(act.contactPoint).normalize();
    return act;
  }

  /** per fixed step: assist magnet, contact point tracking, resolution */
  step(athletes: Athlete[]): void {
    const h = this.host;
    const t = h.simTime;
    for (const a of athletes) {
      const act = a.action;
      if (act && act.kind === 'windup') {
        this.trackIdeal(a, act);
        continue;
      }
      if (!act || act.kind !== 'swing' || act.resolved) continue;
      // keep the animator's target on the real ball path
      const pred = h.ball.ensurePrediction(h.env, t);
      pred.posAt(act.contactT, this._b);
      act.contactPoint.set(this._b.x, this._b.y, this._b.z);
      h.aimTargetFor(a, this._a);
      act.aim.copy(this._a).sub(act.contactPoint).normalize();
      if (t + 1e-6 >= act.contactT) this.resolveSwing(a, act);
    }
  }

  /** air magnet: nudge an airborne hitter towards the ball's path (assist strength) */
  magnet(a: Athlete): void {
    const h = this.host;
    const assist = h.aimAssist(a);
    a.airNudge.set(0, 0, 0);
    if (assist <= 0 || a.state !== 'air' || !h.ball.active) return;
    if (a.action && a.action.resolved) return;
    const info = this.ideal(a, h.simTime, 0.5);
    if (!info || info.d > this.reach(a) + 0.7) return;
    const dt = Math.max(0.08, info.t - h.simTime);
    const ex = info.ball.x - info.point.x;
    const ez = info.ball.z - info.point.z;
    const max = ASSIST.airMagnet * assist;
    a.airNudge.set(clamp(ex / dt, -max, max), 0, clamp(ez / dt, -max, max));
  }

  private resolveSwing(a: Athlete, act: Action): void {
    const h = this.host;
    act.resolved = true;
    const ball = h.ball;
    const bp = ball.pos;
    a.idealContact(this._p);
    const dc = Math.hypot(bp.x - this._p.x, bp.y - this._p.y, bp.z - this._p.z);
    const reach = this.reach(a);
    const stretch = CONTACT.spikeReachStretch + h.aimAssist(a) * ASSIST.reachBonus;
    const lastTouchedBySelf = ball.lastTouch?.athlete === a && h.simTime - ball.lastTouch.t < 1.0;
    if (!ball.active || dc > stretch || lastTouchedBySelf) {
      act.miss = true;
      act.grade = 'Miss';
      act.note = dc > stretch ? (act.err < 0 ? 'Swung early' : 'Swung late') : '';
      act.contactPoint.copy(this._p);
      h.emitContact({
        athlete: a,
        kind: 'spike',
        grade: 'Miss',
        note: act.note,
        speed: 0,
        point: this._p.clone(),
        quality: 0,
        perfect: false,
        tip: false,
        target: new THREE.Vector3(),
      });
      return;
    }
    // ---- grade
    const err = act.err;
    let grade: Grade;
    let note = '';
    const ae = Math.abs(err);
    const late = err > 0;
    if (ae <= (late ? TIMING.spikePerfectLate : TIMING.spikePerfect)) grade = 'Perfect';
    else if (ae <= (late ? TIMING.spikeGoodLate : TIMING.spikeGood)) grade = 'Good';
    else grade = late ? 'Late' : 'Early';
    if (grade === 'Early') note = 'Swing early';
    if (grade === 'Late') note = 'Swing late';
    // jump timing: contact far below the jump peak = jumped too early/late
    if (a.state === 'air' && a.jumpH > 0.1) {
      const hf = a.pos.y / a.jumpH;
      if (hf < 0.72) {
        const early = a.vel.y < 0;
        grade = downgrade(grade, early);
        note = early ? 'Jumped early' : 'Jumped late';
      }
    }
    // stretch for the ball
    if (dc > reach) {
      grade = downgrade(grade, err < 0);
      note = note || 'Reaching';
    }
    act.grade = grade;
    act.note = note;
    act.contactPoint.set(bp.x, bp.y, bp.z);

    // a serve only if this is still the ball you tossed (nobody touched it since)
    const lt0 = ball.lastTouch;
    const serve = this.serving === a && !!lt0 && lt0.athlete === a && lt0.kind === 'feed';
    this.serving = null;
    // ---- tap vs wind-up (a serve is always a full swing)
    const tip = !serve && act.tip;
    act.tip = tip;
    // power from the wind-up: a short hold is a controlled roll-shot speed, full charge the full swing
    const charge = tip ? 0 : act.charge;
    const power = lerp(CONTACT.chargePowerMin, 1, 1 - (1 - charge) * (1 - charge));

    // ---- target with timing-dependent error
    const target = h.aimTargetFor(a, new THREE.Vector3());
    const rank = GRADE_RANK[grade];
    const side = -a.side; // the opponent court
    const spread = rank === 3 ? 0 : rank === 2 ? 0.45 : 1.3;
    target.x += (h.rand() * 2 - 1) * spread;
    target.z += (h.rand() * 2 - 1) * spread * 0.6;
    if (grade === 'Early') target.z += side * 2.2; // contact under the ball: sails long
    if (grade === 'Late') target.z -= side * 1.8; // over the top: drives down into the net
    const pos = a.stats;
    const hf = a.state === 'air' && a.jumpH > 0 ? clamp01(a.pos.y / a.jumpH) : 0.6;
    const out = { x: 0, y: 0, z: 0 };
    const w = { x: 0, y: 0, z: 0 };
    let speed: number;
    if (tip) {
      // tip / roll shot: short = tip over the block, deep = topspin roll
      const depth = Math.abs(target.z);
      const roll = depth > 4.5;
      const apex = bp.y + (roll ? 0.9 : 0.45);
      const dir = { x: target.x - bp.x, z: target.z - bp.z };
      if (roll) topspinFor(dir.x, dir.z, CONTACT.rollSpin, w);
      solveApex({ x: bp.x, y: bp.y, z: bp.z }, { x: target.x, y: R, z: target.z }, apex, w, out);
      speed = Math.hypot(out.x, out.y, out.z);
      ball.hit(out, w, 0, h.simTime);
    } else if (serve && a.state !== 'air') {
      // standing float serve: no spin, knuckles
      speed =
        CONTACT.serveFloatSpeed * (rank === 3 ? 1.08 : rank === 2 ? 1 : 0.88) * lerp(0.9, 1.05, pos.power - 0.75) * lerp(0.85, 1, power);
      const land = { x: 0, y: 0, z: 0 };
      const p0 = { x: bp.x, y: bp.y, z: bp.z };
      solveSpeedToFloor(p0, target.x, target.z, speed, 0, out, w, land, -0.6, 0.7);
      // floaters wobble: keep a margin over the tape (good serves skim it, bad ones may not)
      const margin = rank >= 2 ? 0.28 : 0.12;
      for (let k = 0; k < 4; k++) {
        const c = netClearance(p0, out, w);
        if (!c || c.y > h.env.netTop + R + margin) break;
        target.z += side * 0.8;
        solveSpeedToFloor(p0, target.x, target.z, speed, 0, out, w, land, -0.6, 0.7);
      }
      ball.hit(out, { x: 0, y: 0, z: 0 }, BALL.floatWobble * (rank === 3 ? 1.2 : 0.8), h.simTime);
    } else {
      const base = serve ? CONTACT.serveJumpSpeed : rank === 3 ? CONTACT.spikePerfect : rank === 2 ? CONTACT.spikeGood : CONTACT.spikeOk;
      const gradeK = serve ? (rank === 3 ? 1.1 : rank === 2 ? 1 : 0.8) : 1;
      speed = base * gradeK * pos.power * lerp(0.88, 1.0, hf) * (dc > reach ? 0.86 : 1) * power;
      const spin =
        (serve ? CONTACT.serveJumpSpin : rank === 3 ? CONTACT.spikeSpinPerfect : rank === 2 ? CONTACT.spikeSpinGood : CONTACT.spikeSpinOk) *
        lerp(0.75, 1, power);
      const land = { x: 0, y: 0, z: 0 };
      const p0 = { x: bp.x, y: bp.y, z: bp.z };
      solveSpeedToFloor(p0, target.x, target.z, speed, spin, out, w, land);
      if (!a.isUser) {
        // AI attackers read the net: from deep or low contacts they hit deeper / softer
        for (let k = 0; k < 6; k++) {
          const c = netClearance(p0, out, w);
          if (!c || c.y > h.env.netTop + R + 0.12) break;
          if (Math.abs(target.z) < COURT.halfLength - 0.8) target.z += side * 1.0;
          else speed *= 0.85;
          solveSpeedToFloor(p0, target.x, target.z, speed, spin * 0.8, out, w, land);
        }
      }
      ball.hit(out, w, 0, h.simTime);
    }
    ball.lastTouch = { athlete: a, kind: serve ? 'serve' : tip ? 'tip' : 'spike', t: h.simTime, side: a.side };
    a.lastTouchT = h.simTime;
    // FX intensity follows timing and power; the full Perfect package needs a real wind-up
    const quality = (rank === 3 ? 1 : rank === 2 ? 0.6 : 0.3) * lerp(0.55, 1, charge);
    h.emitContact({
      athlete: a,
      kind: serve ? 'serve' : tip ? 'tip' : 'spike',
      grade,
      note,
      speed,
      point: new THREE.Vector3(bp.x, bp.y, bp.z),
      quality: tip ? 0.2 : quality,
      perfect: grade === 'Perfect' && !tip && charge >= 0.5,
      tip,
      target,
      power: tip ? 0 : charge,
    });
  }

  // ================================================================ zone contacts

  private ballIncoming(a: Athlete): boolean {
    const h = this.host;
    const lt = h.ball.lastTouch;
    if (!h.ball.active || h.ball.state.rest) return false;
    if (lt && lt.athlete === a && h.simTime - lt.t < 0.6) return false;
    return true;
  }

  /** platform centre for a pass / dig */
  platformPoint(a: Athlete, out: THREE.Vector3): THREE.Vector3 {
    const f = dirFromYaw(a.yaw, _f);
    return out.set(a.pos.x + f.x * 0.45, a.pos.y + a.height * 0.34, a.pos.z + f.z * 0.45);
  }

  /** setter's hands point (ball centre at contact) */
  handsPoint(a: Athlete, out: THREE.Vector3): THREE.Vector3 {
    const f = dirFromYaw(a.yaw, _f);
    return out.set(a.pos.x + f.x * 0.14, a.pos.y + a.height + 0.17, a.pos.z + f.z * 0.14);
  }

  /** E held / tapped: resolve a forearm pass when the ball reaches the platform */
  tryPass(a: Athlete, act: Action): boolean {
    const h = this.host;
    if (!this.ballIncoming(a)) return false;
    const ball = h.ball;
    const bp = ball.pos;
    const P = this.platformPoint(a, this._p);
    const assist = h.aimAssist(a);
    // hard-driven balls: a little extra reach (lunge), more for AI defenders
    const hard = clamp01((ball.speed() - 14) / 10);
    const r = CONTACT.passRadius + assist * 0.25 + hard * (a.isUser ? 0.12 : 0.3);
    const dx = bp.x - P.x;
    const dy = bp.y - P.y;
    const dz = bp.z - P.z;
    // forgiving vertically for low digs
    const d = Math.hypot(dx, dy * (dy < 0 ? 0.6 : 1), dz);
    if (d > r || bp.y > a.pos.y + a.height * 0.75) {
      act.minD = 1e9;
      return false;
    }
    // resolve at the closest approach (or when it is basically centred)
    if (d < act.minD - 1e-4 && d > 0.08) {
      act.minD = d;
      return false;
    }
    const dBest = Math.min(d, act.minD);
    const t = h.simTime;
    const lead = t - act.t0;
    const incoming = ball.speed();
    let grade: Grade;
    let note = '';
    // hard-driven balls leave no time: the ideal platform lead shrinks for digs
    const fast = clamp01((incoming - 12) / 10);
    const idealLead = lerp(TIMING.passLead, TIMING.digLead, fast);
    const perfectW = lerp(TIMING.passPerfect, TIMING.digPerfect, fast);
    const goodW = lerp(TIMING.passGood, TIMING.digGood, fast);
    const diff = lead - idealLead;
    if (lead < 0.05) {
      grade = 'Late';
      note = 'Platform late';
    } else if (Math.abs(diff) <= perfectW) grade = 'Perfect';
    else if (Math.abs(diff) <= goodW) grade = 'Good';
    else {
      grade = diff < 0 ? 'Late' : 'Early';
      note = diff < 0 ? 'Platform late' : 'Platform early';
    }
    if (dBest > r * 0.6) {
      grade = downgrade(grade, false);
      note = note || 'Off the platform';
    }
    const dig = incoming > 14;
    if (dig && grade === 'Good' && incoming > 22) grade = 'Late';
    const skill = a.stats.ballControl;
    const errBase = grade === 'Perfect' ? CONTACT.passErrPerfect : grade === 'Good' ? CONTACT.passErrGood : CONTACT.passErrOk;
    const err = errBase * (1.3 - skill * 0.5) * (dig ? 1.3 : 1);
    const T = h.passTarget(a);
    const ang = h.rand() * Math.PI * 2;
    const rad = err * Math.sqrt(h.rand());
    const target = { x: T.x + Math.cos(ang) * rad, y: T.y, z: T.z + Math.sin(ang) * rad * 0.7 };
    // never pass it over our own end line: keep shanks wild but plausible
    if (grade !== 'Perfect' && grade !== 'Good' && h.rand() < 0.35) {
      target.x += (h.rand() * 2 - 1) * 3;
      target.z += a.side * (h.rand() * 3);
    }
    const out = { x: 0, y: 0, z: 0 };
    const apex = Math.max(T.apex + (grade === 'Perfect' ? 0 : (h.rand() - 0.3) * 1.2), bp.y + 0.6);
    solveApex({ x: bp.x, y: bp.y, z: bp.z }, target, apex, { x: 0, y: 0, z: 0 }, out);
    ball.hit(out, { x: (h.rand() - 0.5) * 6, y: 0, z: (h.rand() - 0.5) * 6 }, 0, t);
    ball.lastTouch = { athlete: a, kind: dig ? 'dig' : 'pass', t, side: a.side };
    a.lastTouchT = t;
    act.resolved = true;
    act.contactT = t;
    act.grade = grade;
    act.note = note;
    act.contactPoint.set(bp.x, bp.y, bp.z);
    h.emitContact({
      athlete: a,
      kind: dig ? 'dig' : 'pass',
      grade,
      note,
      speed: Math.hypot(out.x, out.y, out.z),
      point: new THREE.Vector3(bp.x, bp.y, bp.z),
      quality: GRADE_RANK[grade] / 3,
      perfect: grade === 'Perfect',
      tip: false,
      target: new THREE.Vector3(target.x, target.y, target.z),
    });
    return true;
  }

  /** should the right button set (ball dropping onto us from our own side) */
  wantsSet(a: Athlete): boolean {
    const h = this.host;
    if (!this.ballIncoming(a)) return a.role === 'S';
    const ball = h.ball;
    const pred = ball.ensurePrediction(h.env, h.simTime);
    const handsY = a.pos.y + a.height + 0.17;
    const tc = pred.descendThrough(handsY, h.simTime);
    if (tc < 0 || tc - h.simTime > 1.6) return false;
    pred.posAt(tc, this._b);
    if (this._b.z * a.side < 0.2) return false; // the ball will still be on their side: block
    const near = Math.hypot(this._b.x - a.pos.x, this._b.z - a.pos.z) < 2.5;
    const lt = ball.lastTouch;
    const friendly = !lt || lt.side === a.side || lt.kind === 'feed';
    return near && friendly;
  }

  /** RMB set: resolve when the ball drops onto the hands; aim picks the hitter */
  trySet(a: Athlete, act: Action): boolean {
    const h = this.host;
    if (!this.ballIncoming(a)) return false;
    const ball = h.ball;
    const bp = ball.pos;
    const P = this.handsPoint(a, this._p);
    const r = CONTACT.setRadius + h.aimAssist(a) * 0.2;
    const d = Math.hypot(bp.x - P.x, bp.y - P.y, bp.z - P.z);
    if (d > r || ball.vel.y > 0.5) {
      act.minD = 1e9;
      return false;
    }
    if (d < act.minD - 1e-4 && d > 0.07) {
      act.minD = d;
      return false;
    }
    const dBest = Math.min(d, act.minD);
    const t = h.simTime;
    const lead = t - act.t0;
    const diff = lead - TIMING.setLead;
    let grade: Grade;
    let note = '';
    if (lead < 0.05) {
      grade = 'Late';
      note = 'Hands late';
    } else if (Math.abs(diff) <= TIMING.setPerfect) grade = 'Perfect';
    else if (Math.abs(diff) <= TIMING.setGood) grade = 'Good';
    else {
      grade = diff < 0 ? 'Late' : 'Early';
      note = diff < 0 ? 'Hands late' : 'Hands early';
    }
    if (dBest > r * 0.65) {
      grade = downgrade(grade, false);
      note = note || 'Off the hands';
    }
    // choose the option closest to where the user is looking (AI: aiAim)
    const opts = h.setOptions(a);
    if (!opts.length) return false;
    const aimYaw = a.isUser ? this.userAimYaw() : yawFromDir(a.aiAim.x - bp.x, a.aiAim.z - bp.z);
    let best = opts[0];
    let bestD = 1e9;
    for (const o of opts) {
      const oy = yawFromDir(o.target.x - bp.x, o.target.z - bp.z);
      const dd = Math.abs(wrapAngle(oy - aimYaw));
      if (dd < bestD) {
        bestD = dd;
        best = o;
      }
    }
    const rank = GRADE_RANK[grade];
    const err = rank === 3 ? 0.08 : rank === 2 ? 0.3 : 0.85;
    const tgt = {
      x: best.target.x + (h.rand() * 2 - 1) * err,
      y: best.target.y + (h.rand() * 2 - 1) * err * 0.3,
      z: best.target.z + (h.rand() * 2 - 1) * err * 0.6,
    };
    const out = { x: 0, y: 0, z: 0 };
    const from = { x: bp.x, y: bp.y, z: bp.z };
    if (best.time)
      solveFixedTime(from, tgt, Math.max(0.15, best.time * (rank === 3 ? 1 : 1 + (h.rand() - 0.5) * 0.3)), { x: 0, y: 0, z: 0 }, out);
    else solveApex(from, tgt, best.apex + (rank === 3 ? 0 : (h.rand() - 0.5) * 0.6), { x: 0, y: 0, z: 0 }, out);
    ball.hit(out, { x: 0, y: 0, z: 0 }, 0, t);
    ball.lastTouch = { athlete: a, kind: 'set', t, side: a.side };
    a.lastTouchT = t;
    act.resolved = true;
    act.contactT = t;
    act.grade = grade;
    act.note = note || best.label;
    act.contactPoint.set(bp.x, bp.y, bp.z);
    this.lastSet = best;
    h.emitContact({
      athlete: a,
      kind: 'set',
      grade,
      note: note || best.label,
      speed: Math.hypot(out.x, out.y, out.z),
      point: new THREE.Vector3(bp.x, bp.y, bp.z),
      quality: rank / 3,
      perfect: rank === 3,
      tip: false,
      target: new THREE.Vector3(tgt.x, tgt.y, tgt.z),
    });
    return true;
  }
  lastSet: SetOption | null = null;
  userAimYaw: () => number = () => 0;

  /** RMB block: hands volume above / over the net */
  tryBlock(a: Athlete, act: Action): boolean {
    const h = this.host;
    const ball = h.ball;
    if (!ball.active || ball.state.rest) return false;
    const lt = ball.lastTouch;
    if (!lt || lt.side === a.side) return false; // only block the other team's attack
    if (lt.athlete === a) return false;
    const bp = ball.pos;
    const bv = ball.vel;
    if (bv.z * a.side <= 0) return false; // moving away from our court
    if (Math.abs(a.pos.z) > 1.3) return false; // must be at the net
    const t = h.simTime;
    const ext = smooth01((t - act.t0) / TIMING.blockArmTime);
    const assist = h.aimAssist(a);
    const halfW = CONTACT.blockHalfWidth + assist * 0.12;
    const top = a.pos.y + a.standReach + 0.04;
    const bottom = top - CONTACT.blockHeight;
    // hands reach over the net: from our side up to 0.3m into theirs
    const pen = (a.state === 'air' ? 0.32 : 0.12) * ext;
    const zNear = a.side * 0.22;
    const zFar = -a.side * pen;
    const zmin = Math.min(zNear, zFar) - R;
    const zmax = Math.max(zNear, zFar) + R;
    if (bp.y < bottom - R || bp.y > top + R) return false;
    if (Math.abs(bp.x - a.pos.x) > halfW + R) return false;
    if (bp.z < zmin || bp.z > zmax) return false;
    if (ext < 0.35) return false;
    // ---- grade
    let grade: Grade;
    let note = '';
    if (a.state === 'air' && a.jumpH > 0.1) {
      const hf = a.pos.y / a.jumpH;
      if (hf >= TIMING.blockPerfectHeight && ext > 0.85) grade = 'Perfect';
      else if (hf >= TIMING.blockGoodHeight) grade = 'Good';
      else {
        grade = a.vel.y < 0 ? 'Early' : 'Late';
        note = a.vel.y < 0 ? 'Jumped early' : 'Jumped late';
      }
    } else {
      grade = 'Late';
      note = 'Feet on the floor';
    }
    const incoming = Math.hypot(bv.x, bv.y, bv.z);
    const rank = GRADE_RANK[grade];
    const out = { x: 0, y: 0, z: 0 };
    let kind: 'stuff' | 'soft' | 'tool';
    const roll = h.rand();
    // AI blockers convert fewer of their good blocks into stuffs than the user
    const stuffP = a.isUser ? (rank === 3 ? 1 : 0.5) : rank === 3 ? 0.36 : 0.16;
    if (rank >= 2 && roll < stuffP) {
      // stuff: driven down into their court, close to the net
      kind = 'stuff';
      const sp = Math.max(9, incoming * (rank === 3 ? 0.62 : 0.45));
      const ang = -lerp(0.75, 1.05, h.rand());
      const lat = (h.rand() * 2 - 1) * 0.35;
      out.x = bv.x * 0.2 + Math.sin(lat) * sp * 0.4;
      out.y = Math.sin(ang) * sp;
      out.z = -a.side * Math.cos(ang) * sp;
    } else if (rank >= 2 || roll < 0.55) {
      // soft block: ball pops up, slowed, usually stays playable on our side
      kind = 'soft';
      out.x = bv.x * 0.3 + (h.rand() * 2 - 1) * 1.2;
      out.y = 3.2 + h.rand() * 2.5;
      out.z = bv.z * 0.18;
    } else {
      // tooled: off the fingers and wide
      kind = 'tool';
      const sgn = h.rand() < 0.5 ? -1 : 1;
      out.x = sgn * (4 + h.rand() * 4);
      out.y = 2 + h.rand() * 4;
      out.z = bv.z * 0.55;
    }
    ball.hit(out, { x: 0, y: 0, z: 0 }, 0, t);
    // pop the ball out of the hands volume so it doesn't re-collide
    ball.state.p.z = kind === 'stuff' ? -a.side * (R + 0.02) : ball.state.p.z;
    ball.lastTouch = { athlete: a, kind: 'block', t, side: a.side };
    a.lastTouchT = t;
    act.resolved = true;
    act.contactT = t;
    act.grade = grade;
    act.note = kind === 'stuff' ? 'Stuff!' : kind === 'soft' ? 'Soft block' : 'Tooled';
    act.contactPoint.set(bp.x, bp.y, bp.z);
    h.emitContact({
      athlete: a,
      kind: 'block',
      grade,
      note: note || act.note,
      speed: Math.hypot(out.x, out.y, out.z),
      point: new THREE.Vector3(bp.x, bp.y, bp.z),
      quality: kind === 'stuff' ? (rank === 3 ? 1 : 0.7) : 0.3,
      perfect: kind === 'stuff' && rank === 3,
      tip: false,
      target: new THREE.Vector3(),
    });
    return true;
  }

  /** Q: toss for a serve (ball appears in the tossing hand) */
  serveToss(a: Athlete): boolean {
    const h = this.host;
    if (!h.canServe(a)) return false;
    if (a.state !== 'ground') return false;
    const f = dirFromYaw(a.yaw, _f);
    const r = rightFromYaw(a.yaw, _r);
    const p = { x: a.pos.x + f.x * 0.3 + r.x * 0.12, y: a.pos.y + a.height * 0.82, z: a.pos.z + f.z * 0.3 + r.z * 0.12 };
    // toss to ~1.1 m above standing reach, drifting forward for a jump serve approach
    const apex = a.standReach + 1.15;
    const vy = Math.sqrt(2 * BALL.gravity * (apex - p.y));
    const tUp = vy / BALL.gravity;
    const fwd = 0.25 / (tUp * 2);
    h.ball.launch(p, { x: f.x * fwd + r.x * 0.05, y: vy, z: f.z * fwd + r.z * 0.05 }, { x: 0, y: 0, z: 0 }, 0, h.simTime);
    h.ball.lastTouch = { athlete: a, kind: 'feed', t: h.simTime - 1, side: a.side };
    a.startAction('toss', h.simTime);
    this.serving = a;
    return true;
  }
  /** the athlete whose toss is in the air (next swing is a serve) */
  serving: Athlete | null = null;
}

const _f = new THREE.Vector3();
const _r = new THREE.Vector3();

function downgrade(g: Grade, early: boolean): Grade {
  if (g === 'Perfect') return 'Good';
  if (g === 'Good') return early ? 'Early' : 'Late';
  return g;
}

/** pitch range (radians) that maps onto shallow..deep, per camera */
export function aimPitchRange(fp: boolean): [number, number] {
  // FP: looking at the ball (~+0.5 rad) is a mid-court shot, higher = deeper, lower = sharper.
  // TP looks down at the court from behind.
  return fp ? [-0.25, 1.15] : [-0.75, 0.05];
}
export const AIM_DEPTH: [number, number] = [1.0, 9.6];

/**
 * Map the camera look onto a floor target: yaw gives the direction, pitch
 * gives how deep into the opponent's court (works from the net or the end line).
 */
export function aimTargetFromLook(
  fromX: number,
  fromZ: number,
  yaw: number,
  pitch: number,
  fp: boolean,
  side: 1 | -1,
  out: THREE.Vector3,
): THREE.Vector3 {
  const [lo, hi] = aimPitchRange(fp);
  const t = clamp01((pitch - lo) / (hi - lo));
  const dx = -Math.sin(yaw);
  const dz = -Math.cos(yaw);
  const depth = lerp(AIM_DEPTH[0], AIM_DEPTH[1], t);
  const zT = -side * depth;
  if (dz * -side > 0.08 && (zT - fromZ) * dz > 0) {
    const s = (zT - fromZ) / dz;
    out.set(fromX + dx * s, R, zT);
  } else {
    // looking sideways or backwards: just along the look direction
    const dist = lerp(2.4, 11.5, t);
    out.set(fromX + dx * dist, R, fromZ + dz * dist);
  }
  out.x = clamp(out.x, -COURT.halfWidth - 3, COURT.halfWidth + 3);
  return out;
}
