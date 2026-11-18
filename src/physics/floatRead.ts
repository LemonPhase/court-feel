import { BALL } from '../config';
import { copyBall, makeBall, type BallState } from './ball';

/**
 * What anyone watching knows of a floating ball's path (`BALL.float`): where it was heading
 * `BALL.float.read` s ago, or at the hit if that is more recent, with no push to come. It keeps
 * the ball's last states and hands back the one to read from. Nobody, an AI passer or the landing
 * marker, gets the path the float will really take.
 */
export class FloatRead {
  /** the ball's states before each of its last steps, in a ring */
  private past: BallState[];
  private held = 0;
  private at = 0;
  private out: BallState = makeBall();

  constructor(private readonly dt: number) {
    this.past = Array.from({ length: Math.max(1, Math.round(BALL.float.read / dt)) }, makeBall);
  }

  /** a new flight (a hit, a launch): nothing seen of it yet */
  reset(): void {
    this.held = 0;
  }

  /** remember the ball as it is, before it is stepped */
  keep(state: BallState): void {
    copyBall(state, this.past[this.at]);
    this.at = (this.at + 1) % this.past.length;
    this.held = Math.min(this.held + 1, this.past.length);
  }

  /**
   * The ball to read the path from, given the ball as it is now: its state `age` s ago (as far
   * back as `BALL.float.read`, or the start of the flight), with no float left in it.
   */
  from(now: BallState): { state: BallState; age: number } {
    const n = this.past.length;
    const src = this.held > 0 ? this.past[(this.at - this.held + 2 * n) % n] : now;
    copyBall(src, this.out).knuckle = 0;
    return { state: this.out, age: this.held * this.dt };
  }
}
