import * as THREE from 'three';
import { COURT, FX } from '../config';
import type { Grade } from './athlete';
import type { TouchKind } from './ballEntity';
import type { V3 } from '../physics/ball';

/**
 * - a touch kind: the player met the ball (any grade)
 * - `whiff`: the player went for the ball (a swing, a platform, hands, a block) and never met it
 * - `untouched`: a ball that was theirs came down in their court with no attempt at it
 */
export type AttemptKind = TouchKind | 'whiff' | 'untouched';

/** the player's last go at the ball: what R (REPLAY on touch) shows once the ball is dead */
export interface Attempt {
  /** the moment the clip is built around: the contact, the swing, the ball's closest pass, or the ball landing */
  t: number;
  kind: AttemptKind;
  /** the contact point, the point the player was reaching for, or where the ball landed */
  focus: THREE.Vector3;
  /** the ball was met */
  contact: boolean;
  /** worth the "Nice" cue: an attack, a serve, a block, or a Perfect / Good touch */
  highlight: boolean;
  /** where the player stood (their feet) at a `whiff` or an `untouched` ball; null for a contact */
  body: THREE.Vector3 | null;
  /** where the ball was at that moment of a `whiff` or an `untouched` ball; null for a contact */
  ball: THREE.Vector3 | null;
  /** where (and when) the ball hit the floor after this contact, once known */
  impact: THREE.Vector3 | null;
  impactT: number;
  /** the "R to replay" cue was shown for this one */
  cued: boolean;
}

/** the part of an athlete's action the tracker reads */
export interface AttemptAction {
  kind: string;
  resolved: boolean;
}

/**
 * In a drill, is the ball in the air the player's to play? From the other side, yes, unless it is
 * coming back off their block (nobody covers the hitter in a drill). From the player's own side
 * only a ball played to someone (a feed, a pass, a set): a teammate's attack into the net is not theirs.
 */
export function drillBall(touch: { kind: TouchKind; side: 1 | -1 | 0 } | null, side: 1 | -1): boolean {
  if (!touch) return true;
  if (touch.kind === 'block') return false;
  if (touch.side !== side) return true;
  return touch.kind === 'feed' || touch.kind === 'free' || touch.kind === 'pass' || touch.kind === 'dig' || touch.kind === 'set';
}

/** the actions that go for the ball */
const REACHING = new Set(['windup', 'swing', 'pass', 'set', 'block']);

/**
 * Remembers the player's most recent attempt at the ball, including the ones that went wrong:
 * practice footage is most useful for the rep you missed. Pure bookkeeping (no scene, no DOM):
 * the effects director feeds it contacts, the player's action each fixed step and the ball landing.
 */
export class AttemptTracker {
  last: Attempt | null = null;
  /** an action in progress that has not met the ball, and the closest pass by it of the ball now in the air */
  private open: {
    act: AttemptAction;
    /** which flight of the ball `d` and `t` belong to (the time of its last touch) */
    flight: number;
    t: number;
    d: number;
    /** that ball was the player's to play at some point of the action */
    mine: boolean;
    point: THREE.Vector3;
    body: THREE.Vector3;
    ball: THREE.Vector3;
  } | null = null;

  reset(): void {
    this.last = null;
    this.open = null;
  }

  /** the player's contact event. A `Miss` is a swing that found no ball (`ball`: where the ball is now). */
  contact(t: number, kind: TouchKind, grade: Grade | null, point: THREE.Vector3, body: THREE.Vector3, ball: V3): void {
    const o = this.open;
    this.open = null;
    if (grade === 'Miss') {
      // the game graded it a MISS: a rep if the ball was theirs to hit (however far off the swing
      // was), or anyone's ball within a step and a reach. A click with no ball up, at their own
      // ball just played, or while teammates play it far away is not
      if (o && (o.d <= FX.attemptRange || (o.mine && o.d < Infinity))) this.set(t, 'whiff', point, body, _b.set(ball.x, ball.y, ball.z));
      return;
    }
    const good = grade === 'Perfect' || grade === 'Good';
    this.set(t, kind, point, null, null, good || kind === 'spike' || kind === 'serve' || kind === 'block');
  }

  /**
   * Each fixed step: the player's action, the ball's flight (`up`: in the air, not yet down since
   * its last touch, and not just played by the player themselves; `flight`: the time of that touch;
   * `mine`: the drill says it is theirs to play), the ball, the point this action meets it at, and
   * the player's feet.
   * A platform, hands or a block that ends without meeting a ball that came within a step and
   * a reach of it is an attempt (a swing reports its own Miss).
   */
  step(
    t: number,
    act: AttemptAction | null,
    flight: { up: boolean; flight: number; mine: boolean },
    ball: V3,
    point: THREE.Vector3,
    body: THREE.Vector3,
  ): void {
    const now = act && !act.resolved && REACHING.has(act.kind) ? act : null;
    let o = this.open;
    if (o && o.act !== now) {
      if (now && o.act.kind === 'windup' && now.kind === 'swing') {
        // the wind-up was released: the same attempt, now a swing (it reports its own contact or Miss)
        o.act = now;
      } else {
        this.open = null;
        if (!o.act.resolved) this.missed(o);
        o = null;
      }
    }
    if (!now || !flight.up) return;
    if (!o) {
      o = this.open = {
        act: now,
        flight: flight.flight,
        t,
        d: Infinity,
        mine: false,
        point: new THREE.Vector3(),
        body: new THREE.Vector3(),
        ball: new THREE.Vector3(),
      };
    } else if (o.flight !== flight.flight) {
      // a button held through to the next ball: the ball that got past it is one attempt, this is another
      // (a wind-up or a swing has not ended: it reports itself)
      if (o.act.kind !== 'swing' && o.act.kind !== 'windup') this.missed(o);
      o.flight = flight.flight;
      o.d = Infinity;
      o.mine = false;
    }
    if (flight.mine) o.mine = true;
    const d = Math.hypot(ball.x - point.x, ball.y - point.y, ball.z - point.z);
    if (d < o.d) {
      o.d = d;
      o.t = t;
      o.point.copy(point);
      o.body.copy(body);
      o.ball.set(ball.x, ball.y, ball.z);
    }
  }

  /**
   * The ball's first floor contact since its last touch.
   * `side`: the player's side of the net. `touchT`: when the ball was last touched.
   * `ownTouch`: the player was the last to play it (their own shank is already the attempt).
   * `ownSide`: it came from the player's side of the net (a set, a pass, their own toss).
   * `userBall`: the drill says this ball was the player's to play.
   */
  ballDown(
    t: number,
    x: number,
    z: number,
    body: THREE.Vector3,
    ctx: { side: 1 | -1; touchT: number; ownTouch: boolean; ownSide: boolean; userBall: boolean },
  ): void {
    if (!ctx.userBall || ctx.ownTouch) return;
    if (z * ctx.side <= 0) return;
    // from the other side, only a ball landing in was theirs to keep up: one going out is rightly left alone.
    // A set or a pass from their own side is theirs wherever it comes down (an unhit set to the pin drifts wide)
    if (!ctx.ownSide && (Math.abs(x) > COURT.halfWidth || Math.abs(z) > COURT.halfLength)) return;
    // they already went for this ball: that attempt is the one to review
    const o = this.open;
    if (o && o.act.kind !== 'swing' && o.t >= ctx.touchT && this.missed(o)) {
      // still holding the button of an action this ball got past: that is over (the hold may go on)
      o.d = Infinity;
      return;
    }
    if (this.last && this.last.t >= ctx.touchT) return;
    this.set(t, 'untouched', _v.set(x, 0, z), body, _v);
  }

  /** a platform, hands or a block the ball came close to and never met: on record, unless something newer is */
  private missed(o: { t: number; d: number; point: THREE.Vector3; body: THREE.Vector3; ball: THREE.Vector3 }): boolean {
    if (o.d > FX.attemptRange || (this.last && o.t < this.last.t)) return false;
    this.set(o.t, 'whiff', o.point, o.body, o.ball);
    return true;
  }

  private set(
    t: number,
    kind: AttemptKind,
    focus: THREE.Vector3,
    body: THREE.Vector3 | null,
    ball: THREE.Vector3 | null,
    highlight = false,
  ): void {
    this.last = {
      t,
      kind,
      focus: focus.clone(),
      contact: body === null,
      highlight,
      body: body ? body.clone() : null,
      ball: ball ? ball.clone() : null,
      impact: null,
      impactT: -1,
      cued: false,
    };
  }
}

const _v = new THREE.Vector3();
const _b = new THREE.Vector3();
