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
  /** a middle's call on this set: go and close on a pin set, or stay with the inside */
  private commit = true;
  /** a middle fooled by the quick: hesitates, and that is too late */
  private fooled = false;
  /** a middle on the user's green set: guesses wrong and commits a lane away (AI.greenBlockGuess) */
  private wrongGuess = false;
  /** reads the middle: on the user's green set this blocker guesses wrong (a team's middle; a drill's lone blocker) */
  guessOnGreen: boolean;
  /** when false the brain only blocks (no base movement) */
  active = true;
  /** also read a `feed` from the other side as the ball to block (drills where the user attacks a coach's toss) */
  readFeed = false;
  /** close this far inside (towards the court centre) of the attack point: a second blocker next to the pin blocker */
  closeInside = 0;

  /**
   * @param lateralRange how far from home this blocker will go along the net
   * @param closer a middle: reads faster and closes next to the wing blocker on pin sets
   */
  constructor(
    public athlete: Athlete,
    homeX: number,
    public lateralRange = 2.2,
    public closer = false,
  ) {
    this.homeX = homeX;
    this.guessOnGreen = closer;
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
    const theirSet = ball.active && lt && lt.side !== a.side && (lt.kind === 'set' || (this.readFeed && lt.kind === 'feed'));
    // block action housekeeping
    if (a.action?.kind === 'block') {
      g.contact.tryBlock(a, a.action);
      // hands come down once the feet are back on the floor, whatever happened to the set
      // (the ball is usually hit while we are still up, so `jumped` cannot be the gate)
      if (a.action.held && a.state !== 'air' && a.state !== 'load' && a.stateT > 0.15) {
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
      // a middle frozen by the quick, or just late on the read, stays with the inside
      this.commit = g.rng.next() < 0.3 + this.skill * 0.4;
      this.fooled = g.rng.next() < 0.35 - this.skill * 0.25;
      // a green set from the user's setter: exact, at the called tempo, nothing given away early.
      // The middle guesses wrong and commits a lane away; a wing starts its read late and reads it worse
      const us = g.contact.lastSetResult;
      const green = !!us?.green && lt.athlete === us.athlete && lt.t === us.t;
      this.wrongGuess = green && this.guessOnGreen;
      if (green && !this.guessOnGreen) {
        this.setT = now + AI.greenSetReadDelay;
        this.readErr *= AI.greenSetReadErr;
        this.jumpErr += AI.greenSetJumpLate;
      }
    }
    // the middle's whole job is the read: it reacts sooner than the wings
    const react = this.closer ? 0.08 + (1 - this.skill) * 0.15 : 0.12 + (1 - this.skill) * 0.25;
    const reacting = theirSet && now - this.setT > react;
    if (theirSet && !this.jumped && !reacting) {
      stop(a, face);
      return;
    }
    if (theirSet && !this.jumped) {
      const pred = ball.ensurePrediction(g.env, now);
      // the hitter meets the ball around 3.2 m on its way down; a quick or a shoot never
      // gets that high on the way down, it is hit at the top of its arc
      let tc = pred.descendThrough(3.25, now);
      let quick = false;
      if (tc < 0) {
        const apex = pred.apex();
        if (apex.t > now && apex.y > 2.4) {
          tc = apex.t;
          quick = true;
        }
      }
      if (tc > 0) {
        pred.posAt(tc, this.b);
        const away = Math.abs(this.b.x - this.homeX);
        // only commit to attacks in (or near) my zone: no automatic triple blocks.
        // A middle also goes with pin sets, to close the block next to the wing.
        const inZone = away < this.lateralRange + 0.4;
        // a quick fools the middle now and then: hesitate and it is too late
        const fooled = quick && this.closer && this.fooled && !this.wrongGuess;
        if (Math.abs(this.b.z) < 4.5 && !fooled && (inZone || (this.closer && this.commit) || this.wrongGuess)) {
          const reach = this.lateralRange;
          let want: number;
          if (this.wrongGuess) {
            // fooled by an exact set: committed to another hitter. A pin set: stayed home for the
            // quick; a set in the middle (the quick, the pipe): went with a pin
            if (away > AI.greenBlockGuess / 2) want = this.homeX;
            else want = this.homeX + (this.b.x >= this.homeX ? -1 : 1) * AI.greenBlockGuess;
          } else if (this.closer && away > 1.6) {
            // close next to the wing blocker, who takes the line; a middle arriving on the
            // run rarely seals the seam perfectly
            want = this.b.x - Math.sign(this.b.x) * 1.1 + this.readErr;
          } else {
            // take away the line a little: shade towards the sideline the hitter is near;
            // a drill's second blocker closes a fixed distance inside instead
            const shade = Math.sign(this.b.x) * 0.25;
            const inside = -Math.sign(this.b.x || 1) * this.closeInside;
            want = this.b.x + shade + inside + this.readErr;
          }
          this.targetX = clamp(want, this.homeX - reach, this.homeX + reach);
          moveTo(a, this.targetX, a.side * 0.45, { face, arrive: 0.3, sprintDist: 1.2 });
          // time the jump: hands peak ~0.12 s after the hitter's contact
          const H = a.jumpMax * a.stats.standingJumpFrac * 1.1;
          const vy = Math.sqrt(2 * BALL.gravity * H);
          const tUp = vy / BALL.gravity + 0.05;
          // a quick is hit the moment it is set: the block goes up with the hitter and is a
          // touch late more often than not (hands on it, rarely a stuff)
          const lateBias = quick ? 0.1 : 0;
          this.tJump = tc + 0.12 - tUp - PLAYER.loadMin + this.jumpErr + lateBias;
          const dx = Math.abs(a.pos.x - this.targetX);
          // on time and in position: go up. A middle still on the way gets its hands up
          // anyway when it is near enough to take the seam (a late, half-closed block
          // beats watching), but never from the far side of the court.
          const late = this.closer && now >= this.tJump + 0.06 && dx < 0.9;
          if (a.canJump() && ((now >= this.tJump && dx < 0.8) || late)) {
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
