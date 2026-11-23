import { AI, BALL, PLAYER } from '../config';
import { clamp } from '../core/mathx';
import type { Athlete } from '../game/athlete';
import type { Touch } from '../game/ballEntity';
import type { AiHost, Brain } from '../game/brains';
import { laneFor, quickSpot, SETTER_SPOT } from '../game/plays';
import type { V3 } from '../physics/ball';
import { predictJump } from '../game/approach';
import { atNet, moveTo, netYaw, stop } from './brain';
import { pinShade } from './defence';
import { decoyFor, dumpHeld, greenFools } from './greenBite';
import { BallRead } from './read';
import { Scout } from './scout';

/** what a middle expects before the set: nothing in particular (read it), the quick, or one of their pins */
export type Guess = 'read' | 'quick' | 'outside' | 'opposite';

/** how your green set fools a middle (`MiddleBlocker.foolFor`) */
interface Fooled {
  /** where its block belongs */
  spot: number;
  /** its wrong guess: where it goes up, or puts its hands (where `with` is going, when it watches them) */
  wrong: number;
  /** the hitter whose jump it goes up with (null: none) */
  with: Athlete | null;
  /** a guess of its own (it goes up on the set's timing too), not a hitter it is watching or a hold */
  own: boolean;
  /** when it has seen where the attack is going: it drops a guess not yet made, and its hands go for the attack */
  seeT: number;
  /** it has been up on its guess */
  spent: boolean;
  /** it has gone up again, for the attack */
  again: boolean;
}

/** how high a middle jumps to block (as `BlockerBrain`): a little over its standing jump */
export const blockJump = (a: Athlete): number => a.jumpMax * a.stats.standingJumpFrac * 1.1;

/**
 * The Mini Rally middle blocker. Before their set it lines up across from their middle, and off a
 * good pass with their middle coming it sometimes guesses: commits on the quick (jumps with their
 * middle) or cheats towards a pin. After the set it reacts a moment later with a read that sharpens
 * as the ball flies, and runs to close the block next to the pin blocker. Whether it gets there is
 * down to time and legs, never a coin flip (the old blocker closed half the time): on time it closes
 * the block, late it still goes up from where it is (a block with a gap), hopelessly far it stays down. It reads the ball and the bodies it can see,
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
  /** the user's green set fooled it (null: it reads the set) */
  private fooled: Fooled | null = null;
  private readonly b: V3 = { x: 0, y: 0, z: 0 };
  /** who their set is for, as our wings see the hitter go for it (null: it cannot tell) */
  setTo: () => Athlete | null = () => null;
  /** our team's scouting of their hitters, line or cross (`AI.wing.scout`; the team keeps it, the middle only reads it) */
  scout = new Scout();

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
    this.fooled = null;
  }

  step(dt: number, g: AiHost): void {
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
  private readPass(g: AiHost, lt: Touch): void {
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

  /**
   * What their setter sees of this middle on the pass `lt`: committed on the quick (standing in to
   * jump with their middle) or leaning to a pin, or nothing (`read`) before it has guessed on it.
   */
  shows(lt: unknown): Guess {
    return this.guessFor === lt ? this.guess : 'read';
  }

  private makeGuess(g: AiHost): Guess {
    const r = g.rng.next();
    if (r < AI.middle.commit) return 'quick';
    if (r < AI.middle.commit + AI.middle.cheat) return g.rng.next() < 0.5 ? 'outside' : 'opposite';
    return 'read';
  }

  /** will their setter take the pass near their spot (a quick is on)? */
  private passGood(g: AiHost): boolean {
    const now = g.simTime;
    const pred = g.ball.ensurePrediction(g.env, now);
    const t = pred.descendThrough(2.6, now);
    if (t < 0) return false;
    pred.posAt(t, this.b);
    const s = -this.athlete.side;
    return Math.hypot(this.b.x - SETTER_SPOT.x * s, this.b.z - SETTER_SPOT.z * s) <= AI.outOfSystem;
  }

  /** a commit block: up with their middle's quick, timed off their plant and take-off */
  private commit(g: AiHost): void {
    const a = this.athlete;
    const now = g.simTime;
    const them = this.theirMiddle();
    if (this.committedFor === this.guessFor || !them || !a.canJump() || !atNet(a) || Math.abs(them.pos.z) > 2.5) return;
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
  private readSet(g: AiHost, lt: Touch): void {
    const a = this.athlete;
    const now = g.simTime;
    if (this.setRead.look(lt, now, g.rng, dumpHeld(g, lt) ? AI.middle.dumpHold : 0)) {
      this.tc = -1;
      // your green set: it goes on what it sees, at once (there was nothing to read); not off a
      // pass out of system to a pin, which it reads and closes on like any set
      this.fooled = greenFools(g, lt) && this.attack(g) ? this.foolFor(g, lt) : null;
    }
    if (this.fooled) {
      this.playFooled(g, this.fooled);
      return;
    }
    // until it reacts, it carries on with the pass read (lined up, leaning, or in the air with their middle)
    if (!this.setRead.seen(now) || !this.attack(g)) return;
    const spot = this.blockSpot(this.setRead.x(this.attackX, now, this.tc));
    this.targetX = spot;
    this.handsTo = spot;
    if (this.blockedFor === lt || !a.canJump() || !atNet(a)) return;
    // on time it goes up where it is meant to be; late, from wherever it got to, if that is near enough
    if (now >= this.pressFor(this.tc + 0.12) && now <= this.tc && Math.abs(a.pos.x - spot) <= AI.middle.lateReach) {
      this.jump(now);
      this.blockedFor = lt;
    }
  }

  /** when and where their hitter meets the set (`tc`, `attackX`), re-read as it flies: false while it can't tell */
  private attack(g: AiHost): boolean {
    const now = g.simTime;
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
    return this.tc >= 0;
  }

  /** where its block goes for an attack at `bx`: in front of it, or on a pin set closed on our pin blocker */
  private blockSpot(bx: number): number {
    const M = AI.middle;
    if (Math.abs(bx) <= M.pinX) return bx;
    // close on our pin blocker, hands to hands: on the wing itself when it is at the net on that
    // side (wherever it read the set to), else where our pin blocker would line up on that hitter,
    // as our team has scouted them (the whole block plays the same report)
    const r = Math.sign(bx);
    const wing = this.ourWings().find((w) => Math.sign(w.pos.x) === r && Math.abs(w.pos.z) < 1.5);
    return (wing ? wing.pos.x : bx + r * pinShade(this.scout.crossOf(this.setTo()))) - r * M.closeGap;
  }

  /**
   * How your green set `lt` fools it, from where it is as the ball leaves your hands
   * (AI.greenFooled). It guesses wrong, without ever running away from where its block belongs:
   * - in the right place already, it guesses there: up with a hitter you did not set beside it;
   *   or up for the next route (on a push or a shoot, the quick in front of the setter; on that
   *   quick, the push); or on a pin set with its hands inside, off the line. It sees the attack
   *   only when it is hit;
   * - away from it, it goes up with a quick beside it (what a combination is for), or holds, until
   *   it sees where the set is going.
   * Then it does all it can, a beat behind (`goAfter`).
   */
  private foolFor(g: AiHost, lt: Touch): Fooled {
    const a = this.athlete;
    const now = g.simTime;
    const F = AI.greenFooled;
    // where the set is really going (it guessed: this only decides how it got it wrong)
    const at = g.contact.lastSet?.target.x ?? this.attackX;
    const spot = this.blockSpot(at);
    // a hitter you did not set, going beside it (it never runs across the court after one)
    const decoy = decoyFor(g, a, lt);
    const beside = decoy && Math.abs(decoy.pos.x - a.pos.x) <= F.near ? decoy : null;
    const f: Fooled = {
      spot,
      wrong: a.pos.x,
      with: beside,
      own: false,
      seeT: now + F.realise * Math.max(0, this.tc - now),
      // already up (its own commit on their middle, off the pass): that was its guess
      spent: a.state === 'air' || a.state === 'load',
      again: false,
    };
    if (beside || Math.abs(a.pos.x - spot) > F.near) return f;
    // in the right place: a guess of its own, on their hitter's jump or the set's timing
    f.own = true;
    f.with = g.contact.lastSet?.hitter ?? null;
    f.seeT = this.tc + AI.middle.react;
    if (Math.abs(at) > AI.middle.pinX) {
      f.wrong = spot - Math.sign(spot) * F.shift;
      return f;
    }
    const setX = g.ball.pos.x;
    const one = quickSpot(setX, a.side === 1 ? -1 : 1).x;
    f.wrong = Math.abs(at - one) > F.shift / 2 ? one : one + (Math.sign(one - setX) || 1) * F.shift;
    return f;
  }

  /** fooled by your green set (`foolFor`): it never gets to the ball, the pin blocker is on their own */
  private playFooled(g: AiHost, f: Fooled): void {
    const a = this.athlete;
    const now = g.simTime;
    if (f.spent || now >= f.seeT) this.goAfter(now, f);
    else this.guessWrong(now, f);
    // in the air, once it has seen the attack, its hands go for it
    if (a.state === 'air' && now >= f.seeT) this.handsTo = f.spot;
  }

  /** its wrong guess: up with the hitter it is watching (its own guess: on the set's timing too), or holding */
  private guessWrong(now: number, f: Fooled): void {
    const a = this.athlete;
    if (!f.own && f.with) f.wrong = f.with.pos.x + f.with.vel.x * AI.greenBite.lead;
    this.targetX = f.wrong;
    this.handsTo = f.wrong;
    if (!a.canJump() || !atNet(a) || now > this.tc || Math.abs(a.pos.x - f.wrong) > AI.middle.lateReach) return;
    const press = Math.min(this.pressWith(f.with, now), f.own ? this.pressFor(this.tc + 0.12) : Infinity);
    if (now < press) return;
    this.jump(now);
    f.spent = true;
  }

  /**
   * Its guess spent (it went up on it) or seen through: it goes after the attack and, while the
   * ball is still to be hit and it is near enough, up again, `AI.greenFooled.late` s after the
   * jump that would have blocked it: hands coming up as the ball goes by.
   */
  private goAfter(now: number, f: Fooled): void {
    const a = this.athlete;
    this.targetX = f.spot;
    if (f.again || !a.canJump() || !atNet(a) || now > this.tc || Math.abs(a.pos.x - f.spot) > AI.middle.lateReach) return;
    if (now < this.pressFor(this.tc + 0.12) + AI.greenFooled.late) return;
    this.handsTo = f.spot;
    this.jump(now);
    f.again = true;
  }

  /** when to press to go up with `who` (hands at the top as theirs are), once they plant or are in the air (else never) */
  private pressWith(who: Athlete | null, now: number): number {
    if (!who || !(who.state === 'air' || who.state === 'load')) return Infinity;
    const release = who.state === 'load' ? now + Math.max(0, PLAYER.loadMax - 0.02 - who.loadT) : now;
    const top = predictJump(who, now, release);
    return top ? this.pressFor(top.t + 0.05) : Infinity;
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
