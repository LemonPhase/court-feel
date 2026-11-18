import { AI, CONTACT, SET_LEVELS, TIMING, type SetLevel } from '../config';
import { clamp01, lerp } from '../core/mathx';
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
  /** the kind of set: its share of a high ball's green (CONTACT.setTouch.window) */
  window: number;
  /** a quick or a second-tempo set (go, 3 ball, fast back, back 2, shoot, back quick) */
  fast: boolean;
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

/** a part of the touch at or above this is clean: it costs nothing worth telling the player about */
const CLEAN = 0.97;

/** the parts of the touch a coach grades, each done or not (the bar's pips); `catch` is null until the ball is caught */
export interface SetPips {
  feet: boolean;
  centre: boolean;
  catch: boolean | null;
}

export function setPips(t: SetTouch, caught: boolean): SetPips {
  return { feet: t.feet >= CLEAN, centre: t.centre >= CLEAN, catch: caught ? t.catch >= CLEAN : null };
}

export interface SetWindow {
  /** green (Perfect) half-window, s of game time */
  green: number;
  /** good (white) half-window */
  good: number;
}

/** the set's shape for a setter standing at `feet` on `side`: the kind of set (`share`, of a high ball's green) and where they took the pass */
export function setShape(feet: { x: number; z: number }, side: 1 | -1, fast: boolean, share = 1): SetShape {
  return {
    window: share,
    fast,
    outOfSystem: Math.hypot(feet.x - SETTER_SPOT.x * side, feet.z - SETTER_SPOT.z * side) > AI.outOfSystem,
  };
}

/**
 * 0..1 the catch: 1 within the level's clean catch of the ball reaching the hands (`err` s, + = late), down to
 * catchMin. On a level with `handsEarly` (Easy) hands up early are clean however early: only a late catch costs.
 * `wider` stretches the clean catch and the fall-off alike (a set by feel: ASSIST.setByFeel).
 */
export function catchQuality(err: number, level: SetLevel, wider = 1): number {
  const L = SET_LEVELS[level];
  const over = Math.abs(err) - L.catch * wider;
  if (over <= 0 || (err < 0 && L.handsEarly)) return 1;
  return lerp(1, CONTACT.setTouch.catchMin, clamp01(over / ((err < 0 ? TIMING.setCatchEarly : TIMING.setCatchLate) * wider)));
}

/**
 * The touch: `stillT` how long the feet were still, `catchErr` when you pressed against the ball
 * reaching the hands (s, + = late), `centreD` how far the ball passed from the hands point,
 * `reach` the hands' reach. A jump set (`air`) has its balance in place of still feet: how fast
 * the body drifts (`drift`, m/s) and how fast it is rising or falling (`vy`, m/s) at the catch.
 * `wider`: the catch is graded that much more kindly (a set by feel: ASSIST.setByFeel).
 */
export function setTouch(
  stillT: number,
  catchErr: number,
  centreD: number,
  reach: number,
  shape: SetShape,
  level: SetLevel,
  air?: { drift: number; vy: number },
  wider = 1,
): SetTouch {
  const T = CONTACT.setTouch;
  const reasons: string[] = [];
  let feet: number;
  if (air) {
    const drifting = clamp01((air.drift - TIMING.setStillSpeed) / (T.airDrift - TIMING.setStillSpeed));
    const offTop = clamp01((Math.abs(air.vy) - T.offTop[0]) / (T.offTop[1] - T.offTop[0]));
    feet = lerp(1, T.feetMin, Math.max(drifting, offTop));
    if (feet < CLEAN) reasons.push(drifting >= offTop ? 'drifting' : 'off the top of the jump');
  } else {
    feet = lerp(T.feetMin, 1, clamp01(stillT / TIMING.setFeetReady));
    if (feet < CLEAN) reasons.push('on the move');
  }
  const caught = catchQuality(catchErr, level, wider);
  if (caught < CLEAN) reasons.push(catchErr < 0 ? 'caught early' : 'caught late');
  const off = clamp01((centreD - CONTACT.setCentreOk) / Math.max(0.01, reach - CONTACT.setCentreOk));
  const centre = 1 - (1 - T.centreMin) * off;
  if (centre < CLEAN) reasons.push('off the hands');
  let difficulty = shape.window;
  if (difficulty < CLEAN) reasons.push('hard set');
  if (shape.outOfSystem) {
    difficulty *= T.outOfSystem;
    reasons.push('off the net');
    // a quick or a fast set from out there: possible, and very hard
    if (shape.fast) difficulty *= T.oosFast;
  }
  return { feet, catch: caught, centre, difficulty, reasons };
}

/**
 * The green and good windows for a touch at a level: every part scales the level's best window, down
 * to its worst. `wider` widens both (a set by feel: ASSIST.setByFeel).
 */
export function setWindow(t: SetTouch, level: SetLevel, wider = 1): SetWindow {
  const L = SET_LEVELS[level];
  const k = t.feet * t.catch * t.centre * t.difficulty;
  const green = Math.max(L.green[1], L.green[0] * k) * wider;
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
