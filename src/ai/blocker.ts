import { AI, BALL, COURT, PLAYER } from '../config';
import { clamp } from '../core/mathx';
import type { Athlete } from '../game/athlete';
import type { Game } from '../game/game';
import type { V3 } from '../physics/ball';
import { atNet, moveTo, netYaw, stop, type Brain } from './brain';
import { attackKind } from './defence';
import { greenFools } from './greenBite';

/**
 * Where a Mini Rally pin blocker on our right (`r` = 1, world +x) or left (-1) goes up for an attack
 * met `x` along the net, `off` m off it (AI.wing): a pin set on its half, inside or out, on the
 * hitting shoulder taking the line, out to the antenna at most (`outMax`); an inside ball on its
 * half beside the middle; a back-row attack beside the middle, whichever half (all three block the
 * pipe). Beside the middle it closes on our middle itself when it is at the net, at `mateX` (hands
 * to hands, as the middle closes on a pin blocker); else on the attack. Null: not its block (the
 * other half: the other wing's, or the middle's alone).
 */
export function wingSpot(x: number, off: number, r: number, mateX: number | null = null): number | null {
  const kind = attackKind(x, off);
  if (kind !== 'back' && Math.sign(x) !== r) return null;
  if (kind !== 'pin') return (mateX ?? x) + r * AI.middle.closeGap;
  return r * Math.min(r * x + AI.defence.shade, AI.wing.outMax);
}

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
  /** a Mini Rally pin blocker (AI.wing): blocks anywhere on its half of the net and the pipe, goes up late, reaches in the air */
  wing = false;
  /** a wing's middle blocker, whom it closes on beside an inside ball or the pipe */
  mate: () => Athlete | null = () => null;
  /** where a wing's hands go in the air: the spot it was going for (null: straight up) */
  private handsTo: number | null = null;
  /** the set a wing decided on, and whether it helps on that inside ball (it can get there in time) */
  private helpFor: unknown = null;
  private helps = false;
  /** when our middle last pressed for a jump (a wing beside it goes up with it), and its state then */
  private midPressT = -1;
  private midWas = '';

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
    this.handsTo = null;
  }

  step(dt: number, g: Game): void {
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
      // A middle guesses wrong and commits a lane away. A pin blocker blocks it like any other set:
      // the hitter beats one block, not an empty net. (Off a pass out of system a high ball to a
      // pin fools nobody: greenFools.)
      this.wrongGuess = this.guessOnGreen && greenFools(g, lt);
    }
    // a wing's hands in the air keep going for its spot: late, a side block (as the middle's)
    if (this.wing) {
      const mid = this.mate();
      if (mid?.state === 'load' && this.midWas !== 'load') this.midPressT = now;
      this.midWas = mid?.state ?? '';
      const want =
        a.state === 'air' && a.action?.kind === 'block' && this.handsTo !== null
          ? clamp(this.handsTo - a.pos.x, -AI.middle.reach, AI.middle.reach)
          : 0;
      a.reachX += (want - a.reachX) * Math.min(1, dt / AI.middle.reachTime);
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
        if (this.wing && this.wingBlock(g, tc, quick)) return;
        const away = Math.abs(this.b.x - this.homeX);
        // only commit to attacks in (or near) my zone: no automatic triple blocks.
        // A middle also goes with pin sets, to close the block next to the wing.
        const inZone = away < this.lateralRange + 0.4;
        // a quick fools the middle now and then: hesitate and it is too late
        const fooled = quick && this.closer && this.fooled && !this.wrongGuess;
        if (!this.wing && Math.abs(this.b.z) < 4.5 && !fooled && (inZone || (this.closer && this.commit) || this.wrongGuess)) {
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
          this.tJump = this.jumpTime(tc, quick);
          const dx = Math.abs(a.pos.x - this.targetX);
          // on time and in position: go up. A middle still on the way gets its hands up
          // anyway when it is near enough to take the seam (a late, half-closed block
          // beats watching), but never from the far side of the court.
          const late = this.closer && now >= this.tJump + 0.06 && dx < 0.9;
          // (one caught off the net, after a transition, runs in first: it goes up late, from the
          // net, or not at all)
          if (a.canJump() && atNet(a) && ((now >= this.tJump && dx < 0.8) || late)) this.goUp(now);
          return;
        }
      }
    }
    if (!theirSet) this.jumped = false;
    if (!this.active) return;
    if (a.state === 'ground') moveTo(a, this.homeX, a.side * 0.5, { face, arrive: 0.4 });
    else stop(a, face);
  }

  /**
   * A wing's block on their attack at `b`, hit at `tc` (AI.wing): it runs along the net to its spot
   * (`wingSpot`, off by its read of its own hitter's set) and goes up on time, late from up to
   * `lateReach` m short of it, its hands still going for the spot. False: not its block (an inside
   * ball out of its reach is the middle's: it stays on its own hitter).
   */
  private wingBlock(g: Game, tc: number, quick: boolean): boolean {
    const a = this.athlete;
    const now = g.simTime;
    const off = Math.abs(this.b.z);
    // beside the middle it closes on the middle it can see, not on its read of the ball
    const mid = this.mate();
    const mateX = mid && atNet(mid) ? mid.pos.x : null;
    const spot = off < 4.5 ? wingSpot(this.b.x, off, Math.sign(this.homeX), mateX) : null;
    const misread = attackKind(this.b.x, off) === 'pin' || mateX === null ? this.readErr : 0;
    const want = spot === null ? null : clamp(spot + misread, -AI.wing.outMax, AI.wing.outMax);
    this.tJump = this.jumpTime(tc, quick);
    // an inside ball (a quick) is the middle's, unless this wing gets near enough to go up with it
    // in time: decided once, on its read (it never runs at a quick and gives up half way). Which
    // ball it is, a quick in front of the setter or one it can get to, is plain to see: its read
    // error only moves where it lines up
    if (spot !== null && this.helpFor !== this.setRef) {
      this.helpFor = this.setRef;
      const run = a.stats.shuffleSpeed * Math.max(0, this.tJump - now);
      this.helps = attackKind(this.b.x, off) !== 'middle' || Math.abs(spot - a.pos.x) - AI.wing.lateReach <= run;
    }
    if (want === null || !this.helps) {
      this.handsTo = null;
      return false;
    }
    this.targetX = this.handsTo = want;
    const d = Math.abs(this.targetX - a.pos.x);
    // a long way along the net is run (hips turned: a crossover), braking to stop on the spot,
    // squaring up to the net to jump
    const arrive = Math.max(0.3, (a.speed * a.speed) / (2 * PLAYER.decel));
    moveTo(a, this.targetX, a.side * 0.45, { face: d > 1.2 ? undefined : netYaw(a.side), arrive, sprintDist: 1.2 });
    // a block goes up together: beside our middle a wing goes up with it (its press for this ball,
    // near the wing's own time or later), waiting `wait` s for it at most, and never past the hit;
    // on its own hitter, and beside you, on its own time
    let go = now >= this.tJump;
    if (mid && mateX !== null && !mid.isUser && attackKind(this.b.x, off) !== 'pin') {
      go = this.midPressT >= this.tJump - AI.wing.together ? now >= this.midPressT : now >= Math.min(this.tJump + AI.wing.wait, tc);
    }
    // on time from wherever it got to, if near enough; never once the ball is hit
    if (a.canJump() && atNet(a) && go && d <= AI.wing.lateReach && (d < 0.8 || now <= tc)) this.goUp(now);
    return true;
  }

  /** when to press for a block on an attack hit at `tc`: the hands peak ~0.12 s after it */
  private jumpTime(tc: number, quick: boolean): number {
    const a = this.athlete;
    const H = a.jumpMax * a.stats.standingJumpFrac * 1.1;
    const vy = Math.sqrt(2 * BALL.gravity * H);
    const tUp = vy / BALL.gravity + 0.05;
    // a quick is hit the moment it is set: the block goes up with the hitter and is a
    // touch late more often than not (hands on it, rarely a stuff)
    const lateBias = quick ? 0.1 : 0;
    return tc + 0.12 - tUp - PLAYER.loadMin + this.jumpErr + lateBias;
  }

  private goUp(now: number): void {
    const a = this.athlete;
    a.jumpPress();
    a.jumpRelease();
    a.startAction('block', now);
    a.airIntent = 'block';
    this.jumped = true;
  }
}

export const BLOCK_NET_X = COURT.halfWidth;
