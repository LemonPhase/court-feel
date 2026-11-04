import * as THREE from 'three';
import { AI, CONTACT, TIMING } from '../config';
import { handSetAllowed } from '../game/plays';
import type { V3 } from '../physics/ball';
import { solveApex, solveFixedTime } from '../physics/solve';
import type { Athlete } from '../game/athlete';
import type { Game } from '../game/game';
import { moveTo, stop, type Brain } from './brain';

export interface SetCall {
  /** ball centre target (on the descending branch) */
  target: V3;
  apex: number;
  /** who the set is for (for the rally logic) */
  hitter: Athlete | null;
  /** fixed flight time (quick sets that must meet a hitter already in the air); else `apex` shapes the arc */
  time?: number;
}

/**
 * Setter: reads the incoming ball, gets under it (hands above the forehead),
 * and sets a solved arc to whatever `call()` asks for. Accuracy degrades with
 * how far the setter had to move and AI.setterAccuracy.
 */
export class SetterBrain implements Brain {
  enabled = true;
  /** whether this ball is ours to set */
  shouldPlay: (g: Game) => boolean = () => true;
  call: (g: Game) => SetCall | null = () => null;
  onSet: ((call: SetCall) => void) | null = null;
  private v = new THREE.Vector3();
  private p: V3 = { x: 0, y: 0, z: 0 };
  accuracy = AI.setterAccuracy;
  /** bump-set this ball (forearms) instead of hand-setting it: a libero in the front zone (see handSetAllowed) */
  private bump = false;
  private bumpFor: unknown = null;

  constructor(
    public athlete: Athlete,
    public base: { x: number; z: number },
    public faceYaw: number,
  ) {}

  reset(): void {
    this.athlete.endAction();
  }

  /** where the ball centre sits when the setter touches it */
  handsPoint(out: THREE.Vector3, at = this.athlete.pos): THREE.Vector3 {
    const a = this.athlete;
    const fx = -Math.sin(this.faceYaw);
    const fz = -Math.cos(this.faceYaw);
    return out.set(at.x + fx * 0.14, at.y + a.height + 0.17, at.z + fz * 0.14);
  }

  step(_dt: number, g: Game): void {
    const a = this.athlete;
    const ball = g.ball;
    if (!this.enabled) return;
    const mine = ball.active && ball.lastTouch?.athlete !== a && this.shouldPlay(g);
    // the action the last ball was played with (hands, or forearms for a bump set)
    const lastKind = this.bump ? 'pass' : 'set';
    if (!mine) {
      if (a.action?.kind === lastKind && a.action.resolved && g.simTime - a.action.contactT > 0.4) a.endAction();
      // hands that went up for a ball that never came: drop them, they must not block the next play
      else if (a.action?.kind === lastKind && !a.action.resolved && g.simTime - a.action.t0 > 0.8) a.endAction();
      moveTo(a, this.base.x, this.base.z, { face: this.faceYaw });
      return;
    }
    const pred = ball.ensurePrediction(g.env, g.simTime);
    const fx = -Math.sin(this.faceYaw);
    const fz = -Math.cos(this.faceYaw);
    if (this.bumpFor !== ball.lastTouch) {
      // where would we hand-set it? a libero standing in the front zone bump-sets instead
      this.bumpFor = ball.lastTouch;
      const th = pred.descendThrough(a.height + 0.17, g.simTime);
      if (th > 0) pred.posAt(th, this.p);
      this.bump = th > 0 && !handSetAllowed(a, this.p.z - fz * 0.14);
    }
    // hands above the forehead, or the platform (as in a forearm pass) for a bump set
    const contactH = this.bump ? a.height * 0.34 : a.height + 0.17;
    const reach = this.bump ? 0.45 : 0.14;
    const tc = pred.descendThrough(contactH, g.simTime);
    if (tc < 0) {
      stop(a, this.faceYaw);
      return;
    }
    pred.posAt(tc, this.p);
    // stand so the ball drops onto the hands (or the platform)
    const sx = this.p.x - fx * reach;
    const sz = this.p.z - fz * reach;
    moveTo(a, sx, sz, { face: this.faceYaw, arrive: 0.35, sprintDist: 1.5 });
    const until = tc - g.simTime;
    const kindNow = this.bump ? 'pass' : 'set';
    if (until < (this.bump ? TIMING.passLead : 0.4) && (!a.action || a.action.kind !== kindNow)) a.startAction(kindNow, g.simTime);
    // contact when the ball reaches the hands (or the platform)
    if (this.bump) this.v.set(a.pos.x + fx * reach, a.pos.y + contactH, a.pos.z + fz * reach);
    else this.handsPoint(this.v);
    const bp = ball.pos;
    const d = Math.hypot(bp.x - this.v.x, bp.y - this.v.y, bp.z - this.v.z);
    if (d < (this.bump ? CONTACT.passRadius : CONTACT.setRadius) && ball.vel.y < 0.5) this.doSet(g);
  }

  private doSet(g: Game): void {
    const a = this.athlete;
    const call = this.call(g);
    const ball = g.ball;
    if (!call) return;
    const kind = this.bump ? 'pass' : 'set';
    const act = a.action && a.action.kind === kind ? a.action : a.startAction(kind, g.simTime);
    act.resolved = true;
    act.contactT = g.simTime;
    const bp = ball.pos;
    // imprecision: grows when the setter was moving
    const err = this.accuracy * (0.4 + Math.min(1.5, a.speed) * 0.5);
    const t = { x: call.target.x + g.rng.gauss() * err * 0.5, y: call.target.y, z: call.target.z + g.rng.gauss() * err * 0.3 };
    const out = { x: 0, y: 0, z: 0 };
    const from = { x: bp.x, y: bp.y, z: bp.z };
    if (call.time) solveFixedTime(from, t, Math.max(0.15, call.time + g.rng.gauss() * err * 0.06), { x: 0, y: 0, z: 0 }, out);
    else solveApex(from, t, call.apex + g.rng.gauss() * err * 0.2, { x: 0, y: 0, z: 0 }, out);
    ball.hit(out, { x: 0, y: 0, z: 0 }, 0, g.simTime);
    ball.lastTouch = { athlete: a, kind: 'set', t: g.simTime, side: a.side };
    a.lastTouchT = g.simTime;
    g.onAiContact(a, this.bump ? 'pass' : 'set', Math.hypot(out.x, out.y, out.z));
    this.onSet?.(call);
  }
}
