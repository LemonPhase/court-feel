import { AI, CONTACT, SET_LEVELS, TIMING, type SetLevel } from '../config';
import { clamp01, lerp } from '../core/mathx';
import type { V3 } from '../physics/ball';
import type { Grade } from './athlete';
import { SETTER_SPOT } from './plays';

/**
 * The timed set (NBA 2K style): one press per ball. You press as the ball reaches your hands (the
 * catch), it loads in your hands while the bar fills, and you release at the top of the bar (the
 * push). The push is graded in a window whose size comes from your touch, the way a coach grades
 * a setter: feet stopped under the ball, a clean catch, the ball on the forehead window, and how
 * hard the set is; the level (SET_LEVELS) sets how big it is. Pure functions: no scene, no DOM.
 */

/** what makes a set hard to put exactly on the spot */
export interface SetShape {
  /** behind the setter (towards the right pin for the home side) */
  back: boolean;
  /** a quick or a second-tempo set (go, 3 ball, fast back, back 2, shoot, back quick) */
  fast: boolean;
  /** horizontal length of the set (m) */
  length: number;
  /** the setter took it far from their spot: a pass off the net */
  outOfSystem: boolean;
}

/** the setter's touch, each part 0..1 of the green window (1 = it costs nothing) */
export interface SetTouch {
  feet: number;
  catch: number;
  centre: number;
  difficulty: number;
  /** what shrank the window, in the player's words */
  reasons: string[];
}

export interface SetWindow {
  /** green (Perfect) half-window, s of game time */
  green: number;
  /** good (white) half-window */
  good: number;
}

/** the set's shape: from the hands (ball) to the target, for a setter standing at `feet` on `side` */
export function setShape(feet: { x: number; z: number }, from: V3, target: V3, side: 1 | -1, fast: boolean): SetShape {
  return {
    // the home setter faces -x (the outside): a back set goes to larger x
    back: (target.x - from.x) * side > 0.5,
    fast,
    length: Math.hypot(target.x - from.x, target.z - from.z),
    outOfSystem: Math.hypot(feet.x - SETTER_SPOT.x * side, feet.z - SETTER_SPOT.z * side) > AI.outOfSystem,
  };
}

/** 0..1 the catch: 1 within the level's clean catch of the ball reaching the hands (`err` s, + = late), down to catchMin */
export function catchQuality(err: number, level: SetLevel): number {
  const over = Math.abs(err) - SET_LEVELS[level].catch;
  if (over <= 0) return 1;
  return lerp(1, CONTACT.setTouch.catchMin, clamp01(over / (err < 0 ? TIMING.setCatchEarly : TIMING.setCatchLate)));
}

/**
 * The touch: `stillT` how long the feet were still, `catchErr` when you pressed against the ball
 * reaching the hands (s, + = late), `centreD` how far the ball passed from the hands point,
 * `reach` the hands' reach.
 */
export function setTouch(stillT: number, catchErr: number, centreD: number, reach: number, shape: SetShape, level: SetLevel): SetTouch {
  const T = CONTACT.setTouch;
  const reasons: string[] = [];
  const feet = lerp(T.feetMin, 1, clamp01(stillT / TIMING.setFeetReady));
  if (feet < 0.97) reasons.push('on the move');
  const caught = catchQuality(catchErr, level);
  if (caught < 0.97) reasons.push(catchErr < 0 ? 'caught early' : 'caught late');
  const off = clamp01((centreD - CONTACT.setCentreOk) / Math.max(0.01, reach - CONTACT.setCentreOk));
  const centre = 1 - (1 - T.centreMin) * off;
  if (centre < 0.97) reasons.push('off the hands');
  let difficulty = 1;
  if (shape.back) {
    difficulty *= T.backSet;
    reasons.push('back set');
  }
  if (shape.fast) {
    difficulty *= T.fastTempo;
    reasons.push('fast tempo');
  }
  const long = Math.max(T.longMin, 1 - T.longPerM * Math.max(0, shape.length - CONTACT.setLongFrom));
  if (long < 0.97) reasons.push('long set');
  difficulty *= long;
  if (shape.outOfSystem) {
    difficulty *= T.outOfSystem;
    reasons.push('off the net');
  }
  return { feet, catch: caught, centre, difficulty, reasons };
}

/** the green and good windows for a touch at a level: every part scales the level's best window, down to its worst */
export function setWindow(t: SetTouch, level: SetLevel): SetWindow {
  const L = SET_LEVELS[level];
  const k = t.feet * t.catch * t.centre * t.difficulty;
  const green = Math.max(L.green[1], L.green[0] * k);
  return { green, good: green * L.goodMul };
}

export interface SetGrade {
  grade: Grade;
  /** Good: 0 at the green edge .. 1 at the good edge. Early / Late: 0 at the good edge .. 1 a whole good window beyond */
  frac: number;
}

/** grade a release `err` seconds from the top of the bar (the ideal push, + = late) */
export function gradeRelease(err: number, w: SetWindow): SetGrade {
  const e = Math.abs(err);
  if (e <= w.green) return { grade: 'Perfect', frac: 0 };
  if (e <= w.good) return { grade: 'Good', frac: (e - w.green) / Math.max(1e-6, w.good - w.green) };
  return { grade: err < 0 ? 'Early' : 'Late', frac: clamp01((e - w.good) / w.good) };
}

/** how the set misses: `spread` (m, 1 sd along the net), `shift` along the set (- short, + long), `apexDrop` (m) */
export function setMiss(g: SetGrade): { spread: number; shift: number; apexDrop: number } {
  if (g.grade === 'Perfect') return { spread: CONTACT.setSpreadGreen, shift: 0, apexDrop: 0 };
  if (g.grade === 'Good') return { spread: lerp(CONTACT.setSpreadGood[0], CONTACT.setSpreadGood[1], g.frac), shift: 0, apexDrop: 0 };
  const k = 0.3 + 0.7 * g.frac;
  // early: pushed before the ball loaded into the hands, it comes up short; late: held low, flat and long
  return {
    spread: CONTACT.setMissSpread,
    shift: (g.grade === 'Early' ? -1 : 1) * CONTACT.setMissShift * k,
    apexDrop: CONTACT.setMissApexDrop * k,
  };
}

/** 0..1 how good the set is for the hitter: 1 green, a good set 0.5-0.9, early / late below 0.3 */
export function setQuality(g: SetGrade): number {
  if (g.grade === 'Perfect') return 1;
  if (g.grade === 'Good') return 0.9 - 0.4 * g.frac;
  return 0.3 * (1 - g.frac);
}

/** the HUD line under the grade: the timing in ms and what shrank the window */
export function setNote(err: number, g: SetGrade, t: SetTouch, label: string): string {
  const ms = Math.round(err * 1000);
  const timing = g.grade === 'Perfect' ? 'Green' : `${ms > 0 ? '+' : ''}${ms} ms`;
  const why = g.grade === 'Perfect' ? [] : t.reasons.slice(0, 2);
  return [timing, label, ...why].filter(Boolean).join(' · ');
}
