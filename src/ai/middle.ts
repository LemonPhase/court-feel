import { AI, BALL, PLAYER } from '../config';
import { clamp } from '../core/mathx';
import type { Athlete } from '../game/athlete';
import type { Touch } from '../game/ballEntity';
import type { Game } from '../game/game';
import { laneFor, SETTER_SPOT } from '../game/plays';
import type { V3 } from '../physics/ball';
import { predictJump } from './approach';
import { moveTo, netYaw, stop, type Brain } from './brain';
import { BallRead } from './read';

/** what a middle expects before the set: nothing in particular (read it), the quick, or one of their pins */
export type Guess = 'read' | 'quick' | 'outside' | 'opposite';

/** how high a middle jumps to block (as `BlockerBrain`): a little over its standing jump */
const blockJump = (a: Athlete): number => a.jumpMax * a.stats.standingJumpFrac * 1.1;

/**
 * The Mini Rally middle blocker. Before their set it lines up across from their middle, and off a
 * good pass with their middle coming it sometimes guesses: commits on the quick (jumps with their
 * middle) or cheats towards a pin. After the set it reacts a moment later with a read that sharpens
 * as the ball flies, and runs to close the block next to the pin blocker. Whether it gets there is
 * down to time and legs: on time it closes the block, late it still goes up from where it is (a
 * block with a gap), hopelessly far it stays down. It reads the ball and the bodies it can see,
 * never the other team's plan.
 */
export class MiddleBlocker implements Brain {
  /** drills and tests: always make this guess */
  pinnedGuess: Guess | null = null;
  /** the guess on their current pass */
  guess: Guess = 'read';
  private readonly passRead = new BallRead({ react: AI.middle.react, reactSd: AI.middle.reactSd, err: 0 });
  private readonly setRead = new BallRead({ react: AI.middle.react, reactSd: AI.middle.reactSd, err: AI.middle.readErr });
  private guessFor: unknown = null;
  /** their pass was good enough to run a quick off */
  private inSystem = false;
  /** the pass this middle commit-jumped on, and the set it blocked */
  private committedFor: unknown = null;
  private blockedFor: unknown = null;
  /** where it is heading along the net */
  private targetX: number;
  /** the attack the set is heading for: when and where the hitter meets it (tc < 0: not known yet) */
  private tc = -1;
  private attackX = 0;
  /** where the hands go in the air: the spot it was running for (null: straight up) */
  private handsTo: number | null = null;
  private readonly b: V3 = { x: 0, y: 0, z: 0 };

  constructor(
    public athlete: Athlete,
    public homeX: number,
    private theirMiddle: () => Athlete | null,
    /** our wing blockers: on a pin set the middle closes on the one there */
    private ourWings: () => Athlete[] = () => [],
  ) {
    this.targetX = homeX;
  }

  reset(): void {
    this.passRead.reset();
    this.setRead.reset();
    this.guessFor = this.committedFor = this.blockedFor = null;
    this.guess = 'read';
    this.targetX = this.homeX;
    this.tc = -1;
    this.handsTo = null;
  }

  step(dt: number, g: Game): void {
    const a = this.athlete;
    const now = g.simTime;
    const face = netYaw(a.side);
    // hands up: they play the ball while up, and come down once the feet are back on the floor
    if (a.action?.kind === 'block') {
      g.contact.tryBlock(a, a.action);
      if (a.action.held && a.state !== 'air' && a.state !== 'load' && a.stateT > 0.15) {
        a.action.held = false;
        a.action.releaseT = now;
      }
    }
    const lt = g.ball.lastTouch;
    const theirs = g.ball.active && lt && lt.side !== a.side;
    if (theirs && (lt.kind === 'pass' || lt.kind === 'dig')) this.readPass(g, lt);
    else if (theirs && lt.kind === 'set') this.readSet(g, lt);
    else this.targetX = this.homeX;
    // a commit block goes up with their middle, whatever the setter does
    if (theirs && (lt.kind === 'pass' || lt.kind === 'dig' || lt.kind === 'set') && this.guess === 'quick') this.commit(g);
    // in the air the hands keep going for the spot: a late middle stretches sideways for the seam
    // (a block on the quick it didn't read, a wrong guess still going for the pin); on time it is over the spot already
    const want =
      a.state === 'air' && a.action?.kind === 'block' && this.handsTo !== null
        ? clamp(this.handsTo - a.pos.x, -AI.middle.reach, AI.middle.reach)
        : 0;
    a.reachX += (want - a.reachX) * Math.min(1, dt / AI.middle.reachTime);
    if (a.state === 'ground' || a.state === 'land') {
      // a long way along the net is run (hips turned: a crossover), squaring up to the net to jump
      const d = Math.abs(this.targetX - a.pos.x);
      // brake from the stopping distance, so a run along the net ends on the spot, not in the pin blocker
      const arrive = Math.max(0.3, (a.speed * a.speed) / (2 * PLAYER.decel));
      moveTo(a, this.targetX, a.side * 0.45, { face: d > 1.2 ? undefined : face, arrive, sprintDist: 1.0 });
    } else stop(a, face);
  }

  /** their first ball: line up across from their middle, guess once it has been read */
  private readPass(g: Game, lt: Touch): void {
    const a = this.athlete;
    const now = g.simTime;
    this.passRead.look(lt, now, g.rng);
    // until it reacts, it carries on to where it was going
    if (!this.passRead.seen(now)) return;
    const them = this.theirMiddle();
    if (this.guessFor !== lt) {
      this.guessFor = lt;
      this.inSystem = this.passGood(g);
      // a quick needs a good pass and their middle near the net to run it
      const threat = this.inSystem && !!them && Math.abs(them.pos.z) < 4.5;
      this.guess = this.pinnedGuess ?? (threat ? this.makeGuess(g) : 'read');
    }
    const M = AI.middle;
    const lineX = this.inSystem && them && Math.abs(them.pos.z) < 4.5 ? clamp(them.pos.x, -M.lineUpMax, M.lineUpMax) : this.homeX;
    const theirSide = a.side === 1 ? -1 : 1;
    const pin = this.guess === 'outside' ? laneFor('OH', theirSide).x : this.guess === 'opposite' ? laneFor('OPP', theirSide).x : 0;
    this.targetX = lineX + Math.sign(pin) * M.cheatShift;
  }

  private makeGuess(g: Game): Guess {
    const r = g.rng.next();
    if (r < AI.middle.commit) return 'quick';
    if (r < AI.middle.commit + AI.middle.cheat) return g.rng.next() < 0.5 ? 'outside' : 'opposite';
    return 'read';
  }

  /** will their setter take the pass near their spot (a quick is on)? */
  private passGood(g: Game): boolean {
    const now = g.simTime;
    const pred = g.ball.ensurePrediction(g.env, now);
    const t = pred.descendThrough(2.6, now);
    if (t < 0) return false;
    pred.posAt(t, this.b);
    const s = -this.athlete.side;
    return Math.hypot(this.b.x - SETTER_SPOT.x * s, this.b.z - SETTER_SPOT.z * s) <= AI.outOfSystem;
  }

  /** a commit block: up with their middle's quick, timed off their plant and take-off */
  private commit(g: Game): void {
    const a = this.athlete;
    const now = g.simTime;
    const them = this.theirMiddle();
    if (this.committedFor === this.guessFor || !them || !a.canJump() || Math.abs(them.pos.z) > 2.5) return;
    // it sees the plant a reaction time after it starts, the take-off at once
    if (!(them.state === 'air' || (them.state === 'load' && them.stateT >= AI.middle.react))) return;
    // their hands meet the ball at the top of the jump (a planting hitter is taken to hold a full plant)
    const release = them.state === 'load' ? now + Math.max(0, PLAYER.loadMax - 0.02 - them.loadT) : now;
    const top = predictJump(them, now, release);
    if (!top || now < this.pressFor(top.t + 0.05)) return;
    this.handsTo = them.pos.x;
    this.jump(now);
    this.committedFor = this.guessFor;
  }

  /** their set: react, read where it is going, run to close the block, jump on time or late with a gap */
  private readSet(g: Game, lt: Touch): void {
    const a = this.athlete;
    const now = g.simTime;
    if (this.setRead.look(lt, now, g.rng)) this.tc = -1;
    // until it reacts, it carries on with the pass read (lined up, leaning, or in the air with their middle)
    if (!this.setRead.seen(now)) return;
    const pred = g.ball.ensurePrediction(g.env, now);
    // the hitter meets a set around 3.2 m on its way down; a quick never gets that high on the
    // way down, it is hit at the top of its arc
    let tc = pred.descendThrough(3.25, now);
    if (tc < 0) {
      const apex = pred.apex();
      if (apex.t > now && apex.y > 2.4) tc = apex.t;
    }
    if (tc > 0) {
      pred.posAt(tc, this.b);
      this.tc = tc;
      this.attackX = this.b.x;
    }
    if (this.tc < 0) return;
    const M = AI.middle;
    const bx = this.setRead.x(this.attackX, now, this.tc);
    // a pin set: close the block next to the pin blocker; an inside attack: block it in front
    let spot = bx;
    if (Math.abs(bx) > M.pinX) {
      // close on our pin blocker, hands to hands: on the wing itself when it is at the net on that
      // side (wherever it read the set to), else where a pin blocker shading the line would be
      const r = Math.sign(bx);
      const wing = this.ourWings().find((w) => Math.sign(w.pos.x) === r && Math.abs(w.pos.z) < 1.5);
      spot = (wing ? wing.pos.x : bx + r * AI.defence.shade) - r * M.closeGap;
    }
    this.targetX = spot;
    this.handsTo = spot;
    if (this.blockedFor === lt || !a.canJump()) return;
    // on time it goes up where it is meant to be; late, from wherever it got to, if that is near enough
    if (now >= this.pressFor(this.tc + 0.12) && now <= this.tc && Math.abs(a.pos.x - spot) <= M.lateReach) {
      this.jump(now);
      this.blockedFor = lt;
    }
  }

  /** when to press so the block's hands are at the top at `tHands` */
  private pressFor(tHands: number): number {
    const vy = Math.sqrt(2 * BALL.gravity * blockJump(this.athlete));
    return tHands - (vy / BALL.gravity + 0.05) - PLAYER.loadMin;
  }

  private jump(now: number): void {
    const a = this.athlete;
    a.jumpPress();
    a.jumpRelease();
    a.startAction('block', now);
    a.airIntent = 'block';
  }
}
