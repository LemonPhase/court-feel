import { COURT } from '../config';
import { R, type CollisionEvent } from '../physics/ball';
import type { BallEntity } from './ballEntity';

export type OutcomeKind = 'in' | 'out' | 'antenna' | 'outside-antenna' | 'under-net';

export interface Outcome {
  kind: OutcomeKind;
  /** court side where the ball ended (+1 user side, -1 opponent side) */
  side: 1 | -1;
  x: number;
  z: number;
  /** the side that wins the point */
  winner: 1 | -1;
  /** did the ball touch the net on the way */
  netTouch: boolean;
}

/**
 * Line judge: watches the live ball and reports the first rally-ending event
 * (floor contact in/out, antenna touch, crossing outside the antennae).
 */
export class Judge {
  armed = false;
  private prevZ = 0;
  private prevX = 0;
  private prevY = 0;
  netTouch = false;
  crossings = 0;

  arm(ball: BallEntity): void {
    this.armed = true;
    this.prevZ = ball.pos.z;
    this.prevX = ball.pos.x;
    this.prevY = ball.pos.y;
    this.netTouch = false;
    this.crossings = 0;
  }

  disarm(): void {
    this.armed = false;
  }

  /** call after each ball step */
  step(ball: BallEntity, events: CollisionEvent[], netTop: number): Outcome | null {
    if (!this.armed || !ball.active) return null;
    const p = ball.pos;
    const lastSide: 1 | -1 = (ball.lastTouch?.side || (this.prevZ >= 0 ? 1 : -1)) as 1 | -1;
    let res: Outcome | null = null;
    // crossing the net plane
    if (this.prevZ !== 0 && Math.sign(p.z) !== Math.sign(this.prevZ)) {
      const f = this.prevZ / (this.prevZ - p.z);
      const cx = this.prevX + (p.x - this.prevX) * f;
      const cy = this.prevY + (p.y - this.prevY) * f;
      this.crossings++;
      if (cy < netTop - COURT.netDepth) {
        res = this.make('under-net', p.x, p.z, lastSide);
      } else if (Math.abs(cx) > COURT.antennaX - R * 0.5) {
        res = this.make('outside-antenna', p.x, p.z, lastSide);
      }
    }
    if (!res) {
      for (const e of events) {
        if (e.kind === 'net' || e.kind === 'tape') this.netTouch = true;
        if (e.kind === 'antenna') {
          res = this.make('antenna', e.x, e.z, lastSide);
          break;
        }
        if (e.kind === 'post' || e.kind === 'board' || e.kind === 'wall' || e.kind === 'ceiling') {
          res = this.make('out', e.x, e.z, lastSide);
          break;
        }
        if (e.kind === 'floor') {
          const inside = Math.abs(e.x) <= COURT.halfWidth && Math.abs(e.z) <= COURT.halfLength;
          const side: 1 | -1 = e.z >= 0 ? 1 : -1;
          if (inside) res = { kind: 'in', side, x: e.x, z: e.z, winner: -side as 1 | -1, netTouch: this.netTouch };
          else res = this.make('out', e.x, e.z, lastSide);
          break;
        }
      }
    }
    this.prevZ = p.z;
    this.prevX = p.x;
    this.prevY = p.y;
    if (res) this.armed = false;
    return res;
  }

  private make(kind: OutcomeKind, x: number, z: number, faultSide: 1 | -1): Outcome {
    return { kind, side: z >= 0 ? 1 : -1, x, z, winner: -faultSide as 1 | -1, netTouch: this.netTouch };
  }
}

export function outcomeLabel(o: Outcome, attackerSide: 1 | -1): string {
  switch (o.kind) {
    case 'in':
      return o.side === attackerSide ? (o.netTouch ? 'NET' : 'DOWN') : 'KILL';
    case 'out':
      return 'OUT';
    case 'antenna':
      return 'ANTENNA';
    case 'outside-antenna':
      return 'OUT (ANTENNA)';
    case 'under-net':
      return 'UNDER NET';
  }
}
