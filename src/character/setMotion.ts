import { CHARACTER } from '../config';
import { clamp01, easeOutCubic, lerp, smooth01, smoothstep } from '../core/mathx';

/**
 * The hand set's timing, as the body shows it (issue #132; the numbers are `CHARACTER.set`). Pure:
 * the animator (athleteView.ts) asks where in the set the body is, and how this set differs from the
 * last one, and puts the hands, the trunk and the legs there.
 *
 * A set, as a coach breaks it down:
 *  1. the hands come up into the window above the forehead, shaped round a ball that is not there yet;
 *  2. they go to where the ball will arrive and meet it a little above where it is played, and give
 *     with it: the ball sinks into the hands between the wrists, the hands close in round it, the
 *     wrists cock back, the elbows bend, the knees too;
 *  3. legs, arms and wrists extend together along the way the ball goes, the hands pushing out from
 *     each other and the palms turning to face it: forward and up for a front set, up over the head
 *     with the back arched and the palms up for a back set, short and sharp for a quick;
 *  4. the arms stay up a moment, then come down, the elbows bending first.
 */

/** how this set differs from every other: each value is a share (-1..1) of its range in `CHARACTER.set.vary` */
export interface SetStyle {
  raise: number;
  sit: number;
  hold: number;
  high: number;
  spread: number;
  wrist: number;
  /** which arm trails, and by how much (-1: the left by the whole of `vary.lag`, 1: the right) */
  lag: number;
  rise: number;
  lean: number;
  /** how far the arms go after the ball, and how quickly they come down */
  reach: number;
  relax: number;
  /** one hand finishing higher than the other (+: the right) */
  uneven: number;
  /** the arms' way down: wider or narrower, higher or lower than the book */
  downOut: number;
  downUp: number;
  /** the trunk at the finish: turned after the ball a little, tipped to one side */
  twist: number;
  tilt: number;
  /** this setter's window: higher or lower than the book (a habit, the same every set) */
  window: number;
  /** this setter's elbows: wider or narrower (a habit) */
  elbows: number;
}

/**
 * A number in [0, 1) from three integers, the same every time (the picture is traced: two runs of
 * the same play must be drawn the same, so no `Math.random` here).
 */
function hash01(a: number, b: number, k: number): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(k + 1, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** -1..1, leaning to the middle (the sum of two draws: most sets are near the book, few at the edges) */
function spread2(a: number, b: number, k: number): number {
  return hash01(a, b, k) + hash01(a, b, k + 101) - 1;
}

/**
 * The style of the set `athlete` starts at `t0` (s): a setter's habits (from their id alone) and
 * this set's own variation (from the moment too). Written into `out`.
 */
export function setStyle(athlete: number, t0: number, out: SetStyle): SetStyle {
  // a set started in the same frame is the same set: time in whole milliseconds
  const ms = Math.round(t0 * 1000);
  out.raise = spread2(athlete, ms, 1);
  out.sit = spread2(athlete, ms, 2);
  out.hold = hash01(athlete, ms, 3);
  out.high = spread2(athlete, ms, 4);
  out.spread = spread2(athlete, ms, 5);
  out.wrist = spread2(athlete, ms, 6);
  out.lag = spread2(athlete, ms, 7);
  out.rise = spread2(athlete, ms, 8);
  out.lean = spread2(athlete, ms, 9);
  out.reach = spread2(athlete, ms, 12);
  out.relax = spread2(athlete, ms, 13);
  out.uneven = spread2(athlete, ms, 14);
  out.downOut = spread2(athlete, ms, 15);
  out.downUp = spread2(athlete, ms, 16);
  out.twist = spread2(athlete, ms, 17);
  out.tilt = spread2(athlete, ms, 18);
  // habits: the same for every set this athlete makes
  out.window = spread2(athlete, 0, 10);
  out.elbows = spread2(athlete, 0, 11);
  return out;
}

export function newSetStyle(): SetStyle {
  return {
    raise: 0,
    sit: 0,
    hold: 0.5,
    high: 0,
    spread: 0,
    wrist: 0,
    lag: 0,
    rise: 0,
    lean: 0,
    reach: 0,
    relax: 0,
    uneven: 0,
    downOut: 0,
    downUp: 0,
    twist: 0,
    tilt: 0,
    window: 0,
    elbows: 0,
  };
}

/** what the way the ball left the hands says about the push */
export interface SetPush {
  /** 0..1 how far behind the setter the ball went (1: a back set straight back) */
  back: number;
  /** 0..1 how hard the push was: a quick's 0, a high ball to the outside's 1 */
  long: number;
  /** how far the hands go (m) and how long it takes them (s) */
  reach: number;
  time: number;
}

/**
 * The push for a ball that left the hands at `speed` m/s, `fwd` of its direction towards where the
 * setter faces (-1..1, negative behind).
 */
export function setPush(fwd: number, speed: number, style: SetStyle, out: SetPush): SetPush {
  const S = CHARACTER.set;
  out.back = smoothstep(0.05, 0.5, -fwd);
  out.long = clamp01((speed - S.slow) / (S.fast - S.slow));
  out.reach = lerp(S.reach[0], S.reach[1], out.long) * (1 + S.vary.reach * style.reach);
  out.time = lerp(S.push[0], S.push[1], out.long);
  return out;
}

/** where in the set the body is, after the ball has left the hands */
export interface SetAfter {
  /** 0..1 the push: the hands out along the ball's way (fast at the start, as an arm that throws) */
  push: number;
  /** 0..1 the arms coming down after the hold */
  relax: number;
  /** 0..1 the legs: straight with the push, and settling back as the arms come down */
  legs: number;
}

/** how long (s) the arms stay up after a push, for this set */
export function setHold(style: SetStyle): number {
  const h = CHARACTER.set.hold;
  return lerp(h[0], h[1], style.hold);
}

/** `ts` s after the ball left the hands (one arm `lagS` s behind the set's own time) */
export function setAfter(ts: number, push: SetPush, style: SetStyle, out: SetAfter, lagS = 0): SetAfter {
  const S = CHARACTER.set;
  const t = ts - lagS;
  out.push = t <= 0 ? 0 : easeOutCubic(t / push.time);
  const hold = setHold(style);
  out.relax = smooth01((t - push.time - hold) / (S.relax * (1 + S.vary.relax * style.relax)));
  // the legs finish their drive with the arms (a little after: they are slower), and let go with them
  const b = CHARACTER.set.driveShare;
  out.legs = lerp(b, 1, smooth01(t / (push.time * S.legsSlow))) * (1 - out.relax);
  return out;
}

/** 0..1 the legs' drive before the touch, `tArr` s before the ball arrives (`driveShare` of it is done by the touch) */
export function setDriveBefore(tArr: number): number {
  return CHARACTER.set.driveShare * smooth01(1 - tArr / CHARACTER.set.drive);
}

/** 0..1 how far the hands have come down with the ball (the give), `tArr` s before it arrives */
export function setGive(tArr: number): number {
  return smooth01(1 - tArr / CHARACTER.set.giveLead);
}

/**
 * 0..1 the hands up into the window, `since` s after the set was on (`style.raise` makes some setters
 * quicker); `yours`: your own, from your press
 */
export function setRaise(since: number, style: SetStyle, yours = false): number {
  const W = CHARACTER.set.window;
  return smooth01(since / ((yours ? W.raiseYours : W.raise) * (1 + CHARACTER.set.vary.raise * style.raise)));
}
