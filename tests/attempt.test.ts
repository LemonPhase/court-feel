import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { COURT, FX } from '../src/config';
import { AttemptTracker, drillBall, type AttemptAction } from '../src/game/attempt';
import { TOUCH_KEY_LABELS } from '../src/ui/touchControls';
import { translateKeyMarkup } from '../src/ui/hud';

const DT = 1 / 120;
const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const act = (kind: string): AttemptAction => ({ kind, resolved: false });

/** the player stands at `feet` reaching for `reach`; the ball flies past along `ball(t)` while the action runs */
function fly(
  tr: AttemptTracker,
  a: AttemptAction | null,
  from: number,
  to: number,
  ball: (t: number) => THREE.Vector3,
  reach: THREE.Vector3,
  feet: THREE.Vector3,
  up = true,
  flight = 0,
  mine = true,
): number {
  let t = from;
  for (; t < to - 1e-9; t += DT) tr.step(t, a, { up, flight, mine: up && mine }, ball(t), reach, feet);
  return t;
}
const UP = { up: true, flight: 0, mine: true };
/** where the ball is when a contact event fires (only a Miss reads it) */
const BALL = { x: 0.4, y: 2.9, z: 2 };
const DOWN = { up: false, flight: 0, mine: false };

/** a ball crossing the player's reach at t = 1 (0.4 m off the hand at its closest) */
const pastTheHand = (t: number) => v(0.4, 2.9, 3 + (1 - t) * 8);
const REACH = v(0, 2.9, 3);
const FEET = v(0, 0, 3.2);
/** the user's court is +z */
const HOME = { side: 1 as const, touchT: 0, ownTouch: false, ownSide: false, userBall: true };

describe('the last attempt (what R replays)', () => {
  it('practice footage is for the rep you missed: a swing that finds no ball is the attempt on record', () => {
    const tr = new AttemptTracker();
    // an earlier Good spike
    tr.contact(0.2, 'spike', 'Good', v(0, 3, 1), FEET, BALL);
    expect(tr.last).toMatchObject({ kind: 'spike', contact: true, highlight: true });
    // wind up, release late, swing through air
    const wind = act('windup');
    let t = fly(tr, wind, 0.5, 1.1, pastTheHand, REACH, FEET);
    const swing = act('swing');
    t = fly(tr, swing, t, 1.3, pastTheHand, REACH, FEET);
    swing.resolved = true;
    tr.contact(t, 'spike', 'Miss', REACH, FEET, BALL);
    expect(tr.last).toMatchObject({ kind: 'whiff', contact: false, highlight: false });
    expect(tr.last!.t).toBeCloseTo(t, 6);
    expect(tr.last!.body!.distanceTo(FEET)).toBe(0);
    // where the ball was is kept: the camera stands so that both are in the frame
    expect(tr.last!.ball).toMatchObject(BALL);
  });

  it('a poor touch after a good one becomes the attempt (a shanked pass is worth a look too)', () => {
    const tr = new AttemptTracker();
    tr.contact(1, 'pass', 'Perfect', v(0, 1, 5), FEET, BALL);
    expect(tr.last!.highlight).toBe(true);
    tr.contact(3, 'pass', 'Late', v(1, 0.8, 6), FEET, BALL);
    expect(tr.last).toMatchObject({ t: 3, kind: 'pass', contact: true, highlight: false });
  });

  it('attacks, serves and blocks are highlights at any grade; a pass, set or dig only when Perfect or Good', () => {
    const tr = new AttemptTracker();
    for (const k of ['spike', 'serve', 'block'] as const) {
      tr.contact(1, k, 'Early', REACH, FEET, BALL);
      expect(tr.last!.highlight).toBe(true);
    }
    for (const k of ['pass', 'set', 'dig', 'tip'] as const) {
      tr.contact(1, k, 'Early', REACH, FEET, BALL);
      expect(tr.last!.highlight).toBe(false);
      tr.contact(1, k, 'Good', REACH, FEET, BALL);
      expect(tr.last!.highlight).toBe(true);
    }
  });

  it('a block that goes up and never touches the ball is an attempt, timed at the moment the ball went past the hands', () => {
    const tr = new AttemptTracker();
    const block = act('block');
    const t = fly(tr, block, 0.6, 1.5, pastTheHand, REACH, FEET);
    expect(tr.last).toBeNull(); // still up
    tr.step(t, null, UP, pastTheHand(t), REACH, FEET); // landed, hands down
    expect(tr.last).toMatchObject({ kind: 'whiff', contact: false });
    expect(tr.last!.t).toBeCloseTo(1, 2);
    expect(tr.last!.focus.distanceTo(REACH)).toBe(0);
    expect(tr.last!.ball!.distanceTo(pastTheHand(tr.last!.t))).toBeLessThan(1e-9);
  });

  it('a platform held out for a ball that never reaches it is an attempt; one that passes is not a miss', () => {
    const miss = new AttemptTracker();
    const a = act('pass');
    let t = fly(miss, a, 0.5, 1.4, pastTheHand, REACH, FEET);
    miss.step(t, null, UP, pastTheHand(t), REACH, FEET);
    expect(miss.last?.kind).toBe('whiff');

    const made = new AttemptTracker();
    const b = act('pass');
    t = fly(made, b, 0.5, 1.0, pastTheHand, REACH, FEET);
    b.resolved = true;
    made.contact(t, 'pass', 'Good', REACH, FEET, BALL);
    made.step(t + DT, b, UP, pastTheHand(t + DT), REACH, FEET);
    made.step(t + 0.5, null, UP, pastTheHand(t + 0.5), REACH, FEET);
    expect(made.last).toMatchObject({ kind: 'pass', contact: true });
  });

  it('a button pressed with the ball nowhere near, or with no ball up, is not a rep', () => {
    const tr = new AttemptTracker();
    tr.contact(0.2, 'spike', 'Good', REACH, FEET, BALL);
    const far = (t: number) => v(0, 2.5, -6 - t); // on the other side of the net
    expect(far(0).distanceTo(REACH)).toBeGreaterThan(FX.attemptRange);
    let t = fly(tr, act('pass'), 0.5, 1.2, far, REACH, FEET);
    tr.step(t, null, UP, far(t), REACH, FEET);
    // a swing at a ball that is already down (between reps)
    const swing = act('swing');
    t = fly(tr, swing, t, t + 0.3, pastTheHand, REACH, FEET, false);
    swing.resolved = true;
    tr.contact(t, 'spike', 'Miss', REACH, FEET, BALL);
    expect(tr.last).toMatchObject({ t: 0.2, kind: 'spike' });
  });

  it('jumping far too early and swinging under a set that is still metres away is a MISS, and a rep to review', () => {
    const tr = new AttemptTracker();
    const high = (t: number) => v(4 - t, 6, 0.8); // the set, still on its way
    const swing = act('swing');
    const t = fly(tr, swing, 0.5, 0.8, high, REACH, FEET);
    expect(high(t).distanceTo(REACH)).toBeGreaterThan(FX.attemptRange);
    swing.resolved = true;
    tr.contact(t, 'spike', 'Miss', REACH, FEET, BALL);
    expect(tr.last).toMatchObject({ kind: 'whiff' });
  });

  it('a serve that drops untouched in your court is your rep; out, or on their side, is rightly left alone', () => {
    const tr = new AttemptTracker();
    tr.ballDown(5, 0, -3, FEET, HOME); // their court
    tr.ballDown(5, COURT.halfWidth + 0.5, 3, FEET, HOME); // wide
    tr.ballDown(5, 0, COURT.halfLength + 0.5, FEET, HOME); // long
    expect(tr.last).toBeNull();
    tr.ballDown(5, 1, 6, FEET, HOME);
    expect(tr.last).toMatchObject({ t: 5, kind: 'untouched', contact: false, highlight: false });
    expect(tr.last!.focus.distanceTo(v(1, 0, 6))).toBe(0);
    expect(tr.last!.body!.distanceTo(FEET)).toBe(0);
  });

  it('a set to you that you never swing at is your rep even when it drifts wide of the sideline', () => {
    const tr = new AttemptTracker();
    const set = { ...HOME, ownSide: true };
    tr.ballDown(5, -COURT.halfWidth - 1, -0.5, FEET, set); // carried over the net: no longer yours
    expect(tr.last).toBeNull();
    tr.ballDown(5, -COURT.halfWidth - 1, 0.8, FEET, set);
    expect(tr.last).toMatchObject({ t: 5, kind: 'untouched' });
  });

  it("a ball that was a teammate's, or your own shank coming down, does not replace your attempt", () => {
    const tr = new AttemptTracker();
    tr.contact(4, 'pass', 'Late', REACH, FEET, BALL);
    tr.ballDown(5, 1, 6, FEET, { ...HOME, touchT: 4, ownTouch: true });
    tr.ballDown(5, 1, 6, FEET, { ...HOME, touchT: 4.5, userBall: false });
    expect(tr.last).toMatchObject({ t: 4, kind: 'pass' });
  });

  it('you swung and missed, then the ball drops: the swing is the rep, not the ball landing', () => {
    const tr = new AttemptTracker();
    const swing = act('swing');
    const t = fly(tr, swing, 0.8, 1.2, pastTheHand, REACH, FEET);
    swing.resolved = true;
    tr.contact(t, 'spike', 'Miss', REACH, FEET, BALL);
    tr.ballDown(t + 0.6, 0.4, 1.5, FEET, { ...HOME, touchT: 0.1 });
    expect(tr.last).toMatchObject({ kind: 'whiff' });
    expect(tr.last!.t).toBeCloseTo(t, 6);
    // the next ball (touched after that swing) drops with no attempt: now that is the rep
    tr.ballDown(9, 0.4, 1.5, FEET, { ...HOME, touchT: 8 });
    expect(tr.last).toMatchObject({ t: 9, kind: 'untouched' });
  });

  it('a block still held when the ball lands behind it is the miss on record (not "untouched")', () => {
    const tr = new AttemptTracker();
    const block = act('block');
    const t = fly(tr, block, 0.6, 1.4, pastTheHand, REACH, FEET);
    tr.ballDown(t, 0.4, 2, FEET, HOME);
    expect(tr.last?.kind).toBe('whiff');
    expect(tr.last!.t).toBeCloseTo(1, 2);
    // letting go later changes nothing
    tr.step(t + 1, null, DOWN, pastTheHand(t), REACH, FEET);
    expect(tr.last!.t).toBeCloseTo(1, 2);
  });

  it('a second tap right after your own pass is not a new rep: the ball you just played is not one to go for', () => {
    const tr = new AttemptTracker();
    tr.contact(1, 'pass', 'Perfect', REACH, FEET, BALL);
    // the effects director reports the player's own ball as not up for them
    const away = (t: number) => v(0, 1 + (t - 1) * 4, 3 - (t - 1) * 2);
    const t = fly(tr, act('pass'), 1.15, 2, away, REACH, FEET, false, 1);
    tr.step(t, null, DOWN, away(t), REACH, FEET);
    // nor is a double click after a spike
    const swing = act('swing');
    const t2 = fly(tr, swing, t, t + 0.3, away, REACH, FEET, false, 1);
    swing.resolved = true;
    tr.contact(t2, 'spike', 'Miss', REACH, FEET, BALL);
    expect(tr.last).toMatchObject({ t: 1, kind: 'pass', highlight: true });
  });

  it('a stray swing while your setter and hitter play the ball far away is not a rep (it is not your ball)', () => {
    const tr = new AttemptTracker();
    tr.contact(1, 'pass', 'Perfect', REACH, FEET, BALL);
    const theirs = (t: number) => v(2 + t, 5, 0.6); // the set, at the net
    const swing = act('swing');
    const t = fly(tr, swing, 2, 2.3, theirs, REACH, FEET, true, 2, false);
    expect(theirs(t).distanceTo(REACH)).toBeGreaterThan(FX.attemptRange);
    swing.resolved = true;
    tr.contact(t, 'spike', 'Miss', REACH, FEET, BALL);
    expect(tr.last).toMatchObject({ t: 1, kind: 'pass' });
  });

  it('a platform held through two balls: the one that got past is one attempt, the next ball dropping far away is its own rep', () => {
    const tr = new AttemptTracker();
    const hold = act('pass');
    // ball A passes close at t = 1 and goes out
    const t = fly(tr, hold, 0.5, 1.5, pastTheHand, REACH, FEET, true, 0);
    tr.ballDown(t, 0, COURT.halfLength + 1, FEET, { ...HOME, touchT: 0 });
    // still holding: ball B (touched at t = 8) never comes near and lands in at t = 9
    const far = (tt: number) => v(4, 2, 8 - (tt - 8));
    expect(far(8).distanceTo(REACH)).toBeGreaterThan(FX.attemptRange);
    fly(tr, hold, 8, 9, far, REACH, FEET, true, 8);
    expect(tr.last).toMatchObject({ kind: 'whiff' }); // ball A, on record once ball B is in the air
    expect(tr.last!.t).toBeCloseTo(1, 2);
    tr.ballDown(9, 4, 7, FEET, { ...HOME, touchT: 8 });
    expect(tr.last).toMatchObject({ t: 9, kind: 'untouched' });
    // letting go afterwards does not bring ball A back
    tr.step(9.5, null, DOWN, far(9), REACH, FEET);
    expect(tr.last).toMatchObject({ t: 9, kind: 'untouched' });
  });

  it('a wind-up held from the pass to the set is one swing, not a miss at the pass going by', () => {
    const tr = new AttemptTracker();
    const wind = act('windup');
    const t = fly(tr, wind, 0.5, 1.2, pastTheHand, REACH, FEET, true, 0);
    fly(tr, wind, t, t + 0.3, pastTheHand, REACH, FEET, true, 1.2); // the setter touches it
    expect(tr.last).toBeNull();
  });

  it('a new drill starts with nothing to replay', () => {
    const tr = new AttemptTracker();
    tr.contact(1, 'spike', 'Perfect', REACH, FEET, BALL);
    tr.reset();
    expect(tr.last).toBeNull();
  });
});

describe('whose ball it is in a drill', () => {
  it('a serve, an attack or a feed from the other side is yours; so is a set, a pass or your own toss', () => {
    expect(drillBall({ kind: 'serve', side: -1 }, 1)).toBe(true);
    expect(drillBall({ kind: 'spike', side: -1 }, 1)).toBe(true);
    expect(drillBall({ kind: 'feed', side: -1 }, 1)).toBe(true);
    expect(drillBall({ kind: 'set', side: 1 }, 1)).toBe(true);
    expect(drillBall({ kind: 'pass', side: 1 }, 1)).toBe(true);
    expect(drillBall({ kind: 'feed', side: 1 }, 1)).toBe(true);
    expect(drillBall(null, 1)).toBe(true);
  });

  it("a ball coming back off the block, or a teammate's attack dropping on your side, is not your rep", () => {
    expect(drillBall({ kind: 'block', side: -1 }, 1)).toBe(false);
    expect(drillBall({ kind: 'block', side: 1 }, 1)).toBe(false);
    expect(drillBall({ kind: 'spike', side: 1 }, 1)).toBe(false);
    expect(drillBall({ kind: 'tip', side: 1 }, 1)).toBe(false);
  });
});

describe('the replay hint', () => {
  it('names the key on a keyboard and reads "REPLAY last attempt" on touch (the button names itself)', () => {
    const hint = ' · <kbd>R</kbd> replay last attempt';
    expect(translateKeyMarkup(hint, TOUCH_KEY_LABELS)).toBe(' · <kbd>REPLAY</kbd> last attempt');
  });
});
