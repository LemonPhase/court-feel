import { AI, BALL, COURT, PLAYER } from '../config';
import { clamp } from '../core/mathx';
import type { Athlete } from '../game/athlete';
import type { Game } from '../game/game';
import type { V3 } from '../physics/ball';
import { moveTo, netYaw, stop, type Brain } from './brain';

/**
 * AI blocker: when the other team sets, predicts where the hitter will meet
 * the ball, shuffles along the net to take away the line, and jumps so its
 * hands peak as the ball crosses. Hands volume is the same as the user's.
 */
export class BlockerBrain implements Brain {
  skill = AI.blockerSkill;
  /** home x along the net */
  homeX: number;
  enabled = true;
  private jumped = false;
  private tJump = -1;
  private targetX = 0;
  private b: V3 = { x: 0, y: 0, z: 0 };
  /** per-set read: reaction delay, misread and jump timing error */
  private setRef: unknown = null;
  private setT = 0;
  private readErr = 0;
  private jumpErr = 0;
  /** when false the brain only blocks (no base movement) */
  active = true;

  constructor(public athlete: Athlete, homeX: number, public lateralRange = 2.2) {
    this.homeX = homeX;
  }

  reset(): void {
    this.jumped = false;
    this.tJump = -1;
  }

  step(_dt: number, g: Game): void {
    const a = this.athlete;
    if (!this.enabled) return;
    const now = g.simTime;
    const face = netYaw(a.side);
    const ball = g.ball;
    const lt = ball.lastTouch;
    const theirSet = ball.active && lt && lt.side !== a.side && lt.kind === 'set';
    // block action housekeeping
    if (a.action?.kind === 'block') {
      g.contact.tryBlock(a, a.action);
      if (a.state === 'ground' && a.stateT > 0.15 && this.jumped) {
        a.action.held = false;
        a.action.releaseT = now;
      }
    }
    if (theirSet && lt !== this.setRef) {
      this.setRef = lt;
      this.setT = now;
      const s = 1 - this.skill;
      this.readErr = g.rng.gauss() * (0.15 + s * 0.7);
      this.jumpErr = g.rng.gauss() * (0.02 + s * 0.09);
    }
    const reacting = theirSet && now - this.setT > 0.12 + (1 - this.skill) * 0.25;
    if (theirSet && !this.jumped && !reacting) {
      stop(a, face);
      return;
    }
    if (theirSet && !this.jumped) {
      const pred = ball.ensurePrediction(g.env, now);
      // the hitter meets the ball around 3.2 m on its way down
      const tc = pred.descendThrough(3.25, now);
      if (tc > 0) {
        pred.posAt(tc, this.b);
        // only commit to attacks in (or near) my zone: no automatic triple blocks
        const inZone = Math.abs(this.b.x - this.homeX) < this.lateralRange + 0.4;
        if (Math.abs(this.b.z) < 4.5 && inZone) {
          // take away the line a little: shade towards the sideline the hitter is near
          const shade = Math.sign(this.b.x) * 0.25;
          const reach = this.lateralRange;
          this.targetX = clamp(this.b.x + shade + this.readErr, this.homeX - reach, this.homeX + reach);
          moveTo(a, this.targetX, a.side * 0.45, { face, arrive: 0.3, sprintDist: 1.2 });
          // time the jump: hands peak ~0.12 s after the hitter's contact
          const H = a.jumpMax * a.stats.standingJumpFrac * 1.1;
          const vy = Math.sqrt(2 * BALL.gravity * H);
          const tUp = vy / BALL.gravity + 0.05;
          this.tJump = tc + 0.12 - tUp - PLAYER.loadMin + this.jumpErr;
          if (now >= this.tJump && a.canJump() && Math.abs(a.pos.x - this.targetX) < 0.8) {
            a.jumpPress();
            a.jumpRelease();
            a.startAction('block', now);
            a.airIntent = 'block';
            this.jumped = true;
          }
          return;
        }
      }
    }
    if (!theirSet) this.jumped = false;
    if (!this.active) return;
    if (a.state === 'ground') moveTo(a, this.homeX, a.side * 0.5, { face, arrive: 0.4 });
    else stop(a, face);
  }
}

export const BLOCK_NET_X = COURT.halfWidth;
