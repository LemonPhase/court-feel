import * as THREE from 'three';
import { capture, type Memento, type MementoRules } from '../core/memento';
import { Rng } from '../core/mathx';
import { BlockerBrain } from '../ai/blocker';
import { HitterBrain } from '../ai/hitter';
import { MiddleBlocker } from '../ai/middle';
import { BallRead } from '../ai/read';
import { ServerBrain } from '../ai/server';
import { SetterBrain } from '../ai/setter';
import { TeamAI, TeamPlayer } from '../ai/team';
import { Athlete, type Grade } from './athlete';
import { BallEntity, type Touch, type TouchKind } from './ballEntity';
import { Judge } from './judge';
import { Mode } from './modes/mode';

/**
 * Take that ball again (docs/adr/0009). When a rally ends on the user's own mistake, the lower
 * levels of play offer the same ball again: the rally goes back to the start of that play, as it
 * was, and the lost point is taken back. It is what a coach does in practice: the same toss again.
 *
 * The rally is saved at every touch (the whole simulation: athletes, AI brains, both teams, the
 * ball, the judge, the random stream), so the same ball comes exactly as it did until the user does
 * something different.
 */

/** a touch is a record that is never changed, and the AI compares touches by identity: it is shared, never copied */
const isTouch = (o: object): boolean => 'kind' in o && 'side' in o && 'athlete' in o && 't' in o;

/** an athlete's position stats and level never change in a rally (and the position's own table must stay the table) */
const ATHLETE_FIXED = new Set(['stats', 'baseStats', 'level']);

/** what is state in a rally (core/memento.ts): everything else is kept as the reference it is */
export const SIM_RULES: MementoRules = {
  stateful: [
    Athlete,
    TeamAI,
    TeamPlayer,
    HitterBrain,
    SetterBrain,
    BlockerBrain,
    MiddleBlocker,
    ServerBrain,
    BallRead,
    BallEntity,
    Judge,
    Rng,
    Mode,
  ],
  values: [THREE.Vector3, THREE.Vector2, THREE.Quaternion, THREE.Euler, THREE.Color],
  shared: isTouch,
  skip: (o, key) => o instanceof Athlete && ATHLETE_FIXED.has(key),
};

export const saveSim = (root: unknown): Memento => capture(root, SIM_RULES);

/** the user's last contact in the rally, as the contact system graded it */
export interface OwnContact {
  touch: Touch;
  kind: TouchKind;
  grade: Grade | null;
  shanked: boolean;
}

const ATTACKS: readonly TouchKind[] = ['spike', 'tip', 'free', 'serve'];

/**
 * Did the rally end on the user's own mistake? They hit it out or into the net, their own pass, dig
 * or set was mistimed or shanked and came down, or a ball that was theirs dropped (untouched, or
 * swung at and missed). Not their mistake: a ball a team-mate should have played, a clean first
 * ball nobody followed up, a spike that was stuffed or dug, a block that did not stop the hit.
 *
 * `last`: the ball's last touch when the point ended. `own`: the user's last contact this rally.
 * `theirBall`: the ball that came down was the user's to play (the mode's `userBall`).
 */
export function isOwnMistake(me: Athlete, last: Touch | null, own: OwnContact | null, theirBall: boolean): boolean {
  if (!last || last.kind === 'block') return false;
  if (last.athlete === me) {
    if (ATTACKS.includes(last.kind)) return true;
    // a first or second ball: only one they played badly (a clean one is the next player's to keep up)
    return !!own && own.touch === last && (own.shanked || (own.grade !== 'Perfect' && own.grade !== 'Good'));
  }
  return theirBall;
}

/**
 * Which touch the rally goes back to: the start of the play the mistake was in, so the same ball
 * comes with its whole cue. `touches`: the rally's touches in order. `at`: the index of the touch
 * that brought the ball to the user (the set they hit, the spike they dug, the serve they passed, or
 * the ball that dropped).
 *
 * - their ball at the user: their serve itself; for an attack or a free ball, their touch before it
 *   (the set), so the user can read the hitter;
 * - a team-mate's ball to the user (a set, a pass to set): our first touch of that play, so the
 *   setter's call and the whole approach come again. Our own block does not start a play.
 */
export function checkpointIndex(touches: readonly Touch[], at: number, side: 1 | -1): number {
  const t = touches[at];
  if (!t) return -1;
  if (t.side !== side) {
    const before = touches[at - 1];
    return t.kind !== 'serve' && before && before.side === t.side && before.kind !== 'serve' ? at - 1 : at;
  }
  let first = at;
  while (first > 0 && touches[first - 1].side === side && touches[first - 1].kind !== 'block' && touches[first - 1].kind !== 'serve')
    first--;
  return first;
}

/**
 * One rally's flashbacks: the touches so far with the simulation as it was at each, how many the
 * user has taken, and the one on offer once the rally has ended on their mistake. It is not part
 * of what a flashback puts back: the count survives it.
 */
export class Flashback {
  private touches: Touch[] = [];
  private saves: Memento[] = [];
  private own: OwnContact | null = null;
  /** flashbacks taken in this rally */
  used = 0;
  /** the touch on offer (an index into the rally's touches), or -1 */
  private offer = -1;

  /** a new rally */
  reset(): void {
    this.touches.length = 0;
    this.saves.length = 0;
    this.own = null;
    this.used = 0;
    this.offer = -1;
  }

  get offered(): boolean {
    return this.offer >= 0;
  }

  /** the touch a flashback would go back to, if one is on offer */
  get target(): Touch | null {
    return this.offer >= 0 ? this.touches[this.offer] : null;
  }

  /** at the end of a step: a new touch is remembered with the simulation as it stands (`save` takes it) */
  observe(last: Touch | null, save: () => Memento, max: number): void {
    if (!last || this.touches[this.touches.length - 1] === last) return;
    this.touches.push(last);
    this.saves.push(save());
    // a very long rally: the oldest touches are forgotten (a flashback never goes that far back)
    if (this.touches.length > max) {
      this.touches.shift();
      this.saves.shift();
    }
  }

  /** the user met the ball */
  contact(touch: Touch | null, kind: TouchKind, grade: Grade | null, shanked: boolean): void {
    if (touch) this.own = { touch, kind, grade, shanked };
  }

  /**
   * The rally was lost. If it was the user's own mistake and this level still gives them a
   * flashback (`allowed` a rally), put one on offer and return true.
   */
  lost(me: Athlete, last: Touch | null, theirBall: boolean, allowed: number): boolean {
    this.offer = -1;
    if (this.used >= allowed || !isOwnMistake(me, last, this.own, theirBall)) return false;
    // the touch that brought the ball to them: the one before their own contact, or the ball that dropped
    const mine = last && last.athlete === me ? this.touches.lastIndexOf(last) : -1;
    const at = mine >= 0 ? mine - 1 : this.touches.length - 1;
    this.offer = checkpointIndex(this.touches, at, me.side);
    return this.offer >= 0;
  }

  /** the offer was not taken (the next rally is starting) */
  decline(): void {
    this.offer = -1;
  }

  /** take the flashback on offer: returns the simulation to put back, and forgets the touches after it */
  take(): Memento | null {
    if (this.offer < 0) return null;
    const save = this.saves[this.offer];
    this.touches.length = this.offer + 1;
    this.saves.length = this.offer + 1;
    if (this.own && !this.touches.includes(this.own.touch)) this.own = null;
    this.used++;
    this.offer = -1;
    return save;
  }
}
