import { clamp01, type Rng } from '../core/mathx';

export interface ReadParams {
  /** reaction time to the touch (s) and its spread (1 sd) */
  react: number;
  reactSd: number;
  /** how far off the read of where the ball is going is at the touch (m along the net, 1 sd) */
  err: number;
}

/**
 * One player's read of one touch. They act on it a reaction time after it, and their idea of where
 * the ball is going starts off by a random error that shrinks as the ball gets there (none left
 * when it arrives). It reads the ball, never the other team's plan. One read per touch per player:
 * the middle blocker uses it now, the defence will (see AI-movement notes, slice 3).
 */
export class BallRead {
  private ref: unknown = null;
  /** the touch, and when the player starts acting on it */
  private cueT = 0;
  private at = Infinity;
  /** the error at the touch (m, along the net) */
  private ex = 0;

  constructor(private p: ReadParams) {}

  /** a touch was made: a new read if it is a new touch (true), else nothing changes */
  look(touch: unknown, now: number, rng: Rng): boolean {
    if (touch === this.ref) return false;
    this.ref = touch;
    this.cueT = now;
    this.at = now + Math.max(0.05, this.p.react + rng.gauss() * this.p.reactSd);
    this.ex = rng.gauss() * this.p.err;
    return true;
  }

  /** has the player reacted to it yet? */
  seen(now: number): boolean {
    return now >= this.at;
  }

  /**
   * Where along the net the player thinks a ball truly arriving at `trueX` at `tArrive` is going.
   * The error shrinks with the square of the flight still to go: rough off the hands, clear once
   * the arc turns over.
   */
  x(trueX: number, now: number, tArrive: number): number {
    const flight = tArrive - this.cueT;
    const left = flight > 1e-6 ? clamp01((tArrive - now) / flight) : 0;
    return trueX + this.ex * left * left;
  }

  reset(): void {
    this.ref = null;
    this.at = Infinity;
  }
}
