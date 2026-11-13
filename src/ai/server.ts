import * as THREE from 'three';
import { AI, COURT } from '../config';
import type { Rng } from '../core/mathx';
import type { Athlete } from '../game/athlete';
import type { Game } from '../game/game';
import { ContactSystem } from '../game/contact';
import { planApproach, type ApproachPlan } from './approach';
import { moveTo, netYaw, stop, type Brain } from './brain';

/**
 * AI server: walks behind the end line, tosses, and serves at a target through the normal
 * contact system: a standing float, or (`AI.serve.jump` of the time) a jump serve, tossed
 * forward and met at the top of a short run-up and jump.
 */
export class ServerBrain implements Brain {
  phase: 'idle' | 'walk' | 'wait' | 'toss' | 'approach' | 'load' | 'air' | 'done' = 'idle';
  private t = 0;
  private err = 0;
  target = new THREE.Vector3();
  spotX = 0;
  /** this serve is a jump serve */
  jump = false;
  private plan: ApproachPlan | null = null;
  private swung = false;

  constructor(public athlete: Athlete) {}

  /** begin a serve sequence aimed at `target` (floor point) */
  serve(target: THREE.Vector3, spotX = this.spotX, jump = false): void {
    this.target.copy(target);
    this.spotX = spotX;
    this.jump = jump;
    this.phase = 'walk';
    this.t = 0;
    this.plan = null;
    this.swung = false;
  }

  get spot() {
    // a jump server starts further back: the run-up and the toss forward take them to the line
    return { x: this.spotX, z: this.athlete.side * (COURT.halfLength + (this.jump ? AI.serve.jumpBack : 1.1)) };
  }

  step(dt: number, g: Game): void {
    const a = this.athlete;
    const face = netYaw(a.side);
    const now = g.simTime;
    this.t += dt;
    switch (this.phase) {
      case 'idle':
        stop(a, face);
        break;
      case 'walk': {
        const s = this.spot;
        const d = moveTo(a, s.x, s.z, { face, arrive: 0.4 });
        if (d < 0.15 && a.speed < 0.3) {
          this.phase = 'wait';
          this.t = 0;
        }
        break;
      }
      case 'wait':
        stop(a, face);
        if (this.t > 0.7 && this.jump && Math.abs(this.spot.z) - Math.abs(a.pos.z) < AI.serve.jumpStep) {
          // a jump server walks into the toss: the first step of the run-up comes before the ball leaves the hand
          a.cmd.moveZ = -a.side;
          break;
        }
        if (this.t > 0.7) {
          if (this.jump ? g.contact.serveToss(a, AI.serve.jumpToss, AI.serve.jumpTossHigh) : g.contact.serveToss(a)) {
            this.phase = 'toss';
            const e = g.rng.gauss() * (this.jump ? AI.serve.jumpErr : AI.serve.floatErr);
            this.err = Math.max(-AI.serve.errMax, Math.min(AI.serve.errMax, e));
          }
        }
        break;
      case 'toss': {
        if (this.jump) {
          // run in under the toss and meet it at the top of the jump (as a hitter meets a set)
          stop(a, face);
          if (!this.plan) {
            this.plan = planApproach(a, g.ball.ensurePrediction(g.env, now), now, face, face);
            if (!this.plan) this.jump = false;
            else this.phase = 'approach';
          }
          if (this.jump) break;
        }
        stop(a, face);
        if (a.action?.kind === 'toss') this.swingAt(g, 0.8);
        break;
      }
      case 'approach': {
        const p = this.plan!;
        if (now >= p.tStart - 1e-6) {
          a.cmd.moveX = p.dir.x;
          a.cmd.moveZ = p.dir.z;
          a.cmd.sprint = true;
        } else stop(a);
        a.cmd.faceYaw = face;
        if (now >= p.tPress - 1e-6) {
          a.jumpPress();
          this.phase = 'load';
        }
        break;
      }
      case 'load': {
        const p = this.plan!;
        stop(a, face);
        if (now >= p.tPress + p.hold - 1e-6) {
          a.jumpRelease();
          this.phase = 'air';
        }
        break;
      }
      case 'air':
        stop(a, face);
        if (!this.swung && a.state === 'air') this.swingAt(g, 0.6);
        if (a.state !== 'air' && a.stateT > 0.1) this.phase = 'done';
        break;
      case 'done':
        stop(a, face);
        if (a.action?.kind === 'swing' && a.action.resolved && now - a.action.contactT > 0.4) a.endAction();
        break;
    }
  }

  /**
   * swing so the hand meets the ball at the ideal contact (looking `look` s ahead). The timing
   * error grades the contact (`aiErr`); a late arm still swings, at the last moment the hand can
   * reach the ball: a server never lets the toss drop past untouched.
   */
  private swingAt(g: Game, look: number): void {
    const a = this.athlete;
    const info = g.contact.ideal(a, g.simTime, look);
    if (info && g.simTime >= info.t - ContactSystem.swingLead(1) + Math.min(this.err, 0)) {
      a.aiAim.copy(this.target);
      g.contact.startSwing(a, { aiErr: this.err });
      this.swung = true;
      if (this.phase === 'toss') this.phase = 'done';
    }
  }
}

/**
 * Where a server aims (the floor of the other court, `recv` the receiving side): the seam
 * between two passers, deep in zone 1 or 5, short in front of the passers, or at one passer
 * (`passers` where the receivers stand), weighted by `AI.serve`; the server's own error comes on
 * top of it in the contact. Serving at the seams and the deep corners is how a serve makes the
 * passers move and talk.
 */
export function serveAim(passers: readonly { x: number; z: number }[], recv: 1 | -1, rng: Rng, jump: boolean): THREE.Vector3 {
  const S = AI.serve;
  const hw = COURT.halfWidth;
  const sorted = [...passers].sort((p, q) => p.x - q.x);
  const pick = <T>(xs: readonly T[]): T => xs[Math.min(xs.length - 1, Math.floor(rng.next() * xs.length))];
  const w = { seam: S.seam, deep: S.deep, short: jump ? 0 : S.short, body: S.body };
  let r = rng.next() * (w.seam + w.deep + w.short + w.body);
  let x: number;
  let z: number;
  if ((r -= w.seam) < 0 && sorted.length > 1) {
    const k = Math.floor(rng.next() * (sorted.length - 1));
    x = (sorted[k].x + sorted[k + 1].x) / 2;
    z = Math.abs(sorted[k].z + sorted[k + 1].z) / 2;
  } else if ((r -= w.deep) < 0) {
    x = (rng.next() < 0.5 ? -1 : 1) * (hw - S.deepIn);
    z = COURT.halfLength - S.deepIn;
  } else if (r < w.short) {
    x = (rng.next() * 2 - 1) * (hw - 1.5);
    z = S.shortZ;
  } else {
    const p = pick(sorted);
    x = p.x;
    z = Math.abs(p.z);
  }
  x += rng.gauss() * S.spread;
  z += rng.gauss() * S.spread;
  x = Math.max(-hw + 0.4, Math.min(hw - 0.4, x));
  z = Math.max(2.5, Math.min(COURT.halfLength - 0.4, z));
  return new THREE.Vector3(x, 0, z * recv);
}
