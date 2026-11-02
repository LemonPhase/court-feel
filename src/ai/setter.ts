import * as THREE from 'three';
import { AI, CONTACT } from '../config';
import type { V3 } from '../physics/ball';
import { solveApex } from '../physics/solve';
import type { Athlete } from '../game/athlete';
import type { Game } from '../game/game';
import { moveTo, stop, type Brain } from './brain';

export interface SetCall {
  /** ball centre target (on the descending branch) */
  target: V3;
  apex: number;
  /** who the set is for (for the rally logic) */
  hitter: Athlete | null;
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

  constructor(public athlete: Athlete, public base: { x: number; z: number }, public faceYaw: number) {}

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
    if (!mine) {
      if (a.action?.kind === 'set' && a.action.resolved && g.simTime - a.action.contactT > 0.4) a.endAction();
      moveTo(a, this.base.x, this.base.z, { face: this.faceYaw });
      return;
    }
    const pred = ball.ensurePrediction(g.env, g.simTime);
    const handsH = a.height + 0.17;
    const tc = pred.descendThrough(handsH, g.simTime);
    if (tc < 0) {
      stop(a, this.faceYaw);
      return;
    }
    pred.posAt(tc, this.p);
    // stand so the ball drops onto the hands
    const fx = -Math.sin(this.faceYaw);
    const fz = -Math.cos(this.faceYaw);
    const sx = this.p.x - fx * 0.14;
    const sz = this.p.z - fz * 0.14;
    moveTo(a, sx, sz, { face: this.faceYaw, arrive: 0.35, sprintDist: 1.5 });
    const until = tc - g.simTime;
    if (until < 0.4 && (!a.action || a.action.kind !== 'set')) a.startAction('set', g.simTime);
    // contact when the ball reaches the hands
    this.handsPoint(this.v);
    const bp = ball.pos;
    const d = Math.hypot(bp.x - this.v.x, bp.y - this.v.y, bp.z - this.v.z);
    if (d < CONTACT.setRadius && ball.vel.y < 0.5) this.doSet(g);
  }

  private doSet(g: Game): void {
    const a = this.athlete;
    const call = this.call(g);
    const ball = g.ball;
    if (!call) return;
    const act = a.action && a.action.kind === 'set' ? a.action : a.startAction('set', g.simTime);
    act.resolved = true;
    act.contactT = g.simTime;
    const bp = ball.pos;
    // imprecision: grows when the setter was moving
    const err = this.accuracy * (0.4 + Math.min(1.5, a.speed) * 0.5);
    const t = { x: call.target.x + g.rng.gauss() * err * 0.5, y: call.target.y, z: call.target.z + g.rng.gauss() * err * 0.3 };
    const out = { x: 0, y: 0, z: 0 };
    solveApex({ x: bp.x, y: bp.y, z: bp.z }, t, call.apex + g.rng.gauss() * err * 0.2, { x: 0, y: 0, z: 0 }, out);
    ball.hit(out, { x: 0, y: 0, z: 0 }, 0, g.simTime);
    ball.lastTouch = { athlete: a, kind: 'set', t: g.simTime, side: a.side };
    a.lastTouchT = g.simTime;
    g.onAiContact(a, 'set', Math.hypot(out.x, out.y, out.z));
    this.onSet?.(call);
  }
}
