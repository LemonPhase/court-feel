import { AI, COURT, PLAYER, type PositionId, type SetTier } from '../config';
import { clamp } from '../core/mathx';
import type { V3 } from '../physics/ball';
import { predictJump } from './approach';
import type { Athlete } from './athlete';
import type { SetOption } from './contact';

/**
 * Where each position attacks from and where it starts its approach, for the
 * home side (+z). Mirror x and z for the far side. x: left (-) / right (+)
 * from the home team's view facing the net.
 */
export interface AttackLane {
  /** ball target xz at contact */
  x: number;
  z: number;
  /** apex of the set, metres above the contact height */
  apexAbove: number;
  /** approach start */
  sx: number;
  sz: number;
  label: string;
  /** first tempo: the hitter is already in the air when the setter touches the ball */
  quick?: boolean;
}

export const LANES: Record<PositionId, AttackLane> = {
  // pin sets: met about half a metre inside the antenna, approach from outside the court
  OH: { x: -4.05, z: 0.9, apexAbove: 1.65, sx: -4.85, sz: 3.7, label: 'Outside high ball (4)' },
  // the back set is a little higher than elite tempo, so it is reachable when you react to the set
  OPP: { x: 4.0, z: 0.9, apexAbove: 1.55, sx: 4.7, sz: 3.4, label: 'Opposite back set (red)' },
  // first-tempo quick, a true "1": in the air as the setter touches it, and the set adapts to the
  // hitter (see QUICK). A quick timed off the set is unhittable at real tempo. (x is a default; see quickSpot)
  MB: { x: 0.2, z: 0.75, apexAbove: 0.5, sx: 0.35, sz: 2.8, label: 'Middle quick (1)', quick: true },
  S: { x: 1.05, z: 0.55, apexAbove: 0.75, sx: 1.2, sz: 1.3, label: 'Setter attack on two' },
  // in system the pipe is met a little over 2 m off the net: the hitter takes off behind the 3 m
  // line, their feet clear of it (AI.backRow), and broad-jumps in (the approach starts close enough
  // to make it at the set's tempo)
  L: { x: -0.4, z: 2.25, apexAbove: 1.45, sx: -0.4, sz: 5.5, label: 'Back-row pipe' },
};

/** out of system a back-row set stays well behind the 3 m line, this far (m) off the net */
export const PIPE_HIGH_Z = 3.75;

/** the setter's home spot (right of centre, close to the net) */
export const SETTER_SPOT = { x: 1.1, z: 0.65 };
/** target for passes / free balls: where the setter wants the ball */
export const SETTER_TARGET = { x: 1.0, z: 0.9, height: 3.6 };
/**
 * Target for a dig by the setter himself: high to the middle of the court, behind the 3 m line
 * with room to spare, so the backup (the libero) has time to get there and may hand-set it with
 * its feet clear of the line. (The user's second ball nobody could set goes there too.)
 */
export const BACKUP_TARGET = { x: 0.5, y: 2.35, z: 3.8, apex: 5.2 };

/**
 * May `a` hand-set a ball while standing at z? A libero's overhand set from the front zone (the
 * line included) can't be attacked above the net, so a libero hand-sets only from behind the
 * 3 m line, its feet clear of it (`AI.backRow.clear`: a foot on the line is in the front zone),
 * and bump-sets from anywhere nearer the net.
 */
export function handSetAllowed(a: Athlete, z: number): boolean {
  return a.role !== 'L' || Math.abs(z) > COURT.attackLine + AI.backRow.clear;
}

export function laneFor(pos: PositionId, side: 1 | -1): AttackLane {
  const l = LANES[pos];
  return { ...l, x: l.x * side, z: l.z * side, sx: l.sx * side, sz: l.sz * side };
}

/**
 * first-tempo set timing (seconds of ball flight from the setter's hands). The set goes to
 * where the hitter's hand will be at the top of the jump, in a fixed flight time.
 */
export const QUICK = {
  /** shortest / longest flight the setter will send to meet a jumping hitter */
  minT: 0.24,
  maxT: 0.8,
  /** flight when the hitter is not up yet (they are late) */
  lateT: 0.6,
  /** how far in front of the setter the quick is hit, along the net */
  inFront: 0.85,
};

/**
 * Ball-centre height where the setter touches a dropping pass. AI setters
 * take it as it enters their hands (CONTACT.setRadius above the hands point);
 * a user's set resolves at the closest approach, right at the hands.
 */
export function setterTouchY(setter: Athlete | null | undefined): number {
  const hands = (setter ? setter.height : 1.9) + 0.17;
  return setter?.isUser ? hands + 0.05 : hands + 0.45;
}

/**
 * Where a quick is hit for a setter touching the ball at x: `inFront` metres
 * along the net in front of them (negative = behind the setter's back).
 */
export function quickSpot(setterX: number, side: 1 | -1, inFront = QUICK.inFront): { x: number; z: number } {
  return { x: clamp(setterX - side * inFront, -3.2, 3.6), z: LANES.MB.z * side };
}

export interface QuickSet extends SetOption {
  time: number;
  /** the hitter is up: the ball meets their hand at the top of the jump */
  onTime: boolean;
}

/**
 * The quick set for a middle. If they are planting or already in the air
 * (they jumped with the setter's touch), the ball is sent to where their
 * hitting hand will be at the top of the jump, arriving exactly then: the set
 * meets the hitter, not the other way round. Otherwise it goes to the usual
 * spot on a default tempo, and they will be late.
 */
export function quickSetFor(hitter: Athlete, now: number, from: V3, releaseAt?: number, inFront = QUICK.inFront): QuickSet {
  // still in the plant with no known release: expect a full load (what the load meter teaches)
  const rel = releaseAt ?? (hitter.state === 'load' ? now + Math.max(0, PLAYER.loadMax - 0.02 - hitter.loadT) : now);
  const j = predictJump(hitter, now, rel, QUICK.minT);
  if (j && j.t - now <= QUICK.maxT) {
    const c = j.contact;
    return { target: { x: c.x, y: c.y, z: c.z }, apex: c.y, hitter, label: 'Quick', time: j.t - now, onTime: true };
  }
  const q = quickSpot(from.x, hitter.side, inFront);
  const y = attackHeight(hitter);
  return { target: { x: q.x, y, z: q.z }, apex: y + LANES.MB.apexAbove, hitter, label: 'Quick', time: QUICK.lateT, onTime: false };
}

/**
 * Set calls a hitter can ask for in the spike drill (keys 1-3). Each is a
 * lane: where the ball is met, how high the set goes above the contact (the
 * tempo) and where the approach starts. Quicks give `inFront` instead: the
 * hitter is up with the setter's touch and the set meets them that far along
 * the net from the setter (negative = behind the setter).
 */
export interface SetPlay {
  name: string;
  /** the call as shouted on court (the Mini Rally setter calls it back when it is on) */
  short: string;
  lane: AttackLane;
  inFront?: number;
  /** how hard the set is to put on the spot (CONTACT.setTouch.window); a high ball when not given */
  tier?: SetTier;
}

/**
 * A call that only runs off a good pass: a quick, or anything faster than a high ball
 * (you are already running when the setter touches it). Out of system it goes up high.
 */
export function needsGoodPass(play: SetPlay): boolean {
  return play.inFront !== undefined || play.lane.apexAbove < 1.0;
}

export const SET_PLAYS: Partial<Record<PositionId, SetPlay[]>> = {
  OH: [
    { name: 'High ball', short: 'High', lane: LANES.OH },
    // second tempo: a flat fast set to the pin, you are already running when it leaves the hands
    {
      name: 'Go (fast to the pin)',
      short: 'Go',
      lane: { ...LANES.OH, x: -4.0, z: 0.85, apexAbove: 0.45, sx: -4.85, sz: 3.5, label: 'Outside go' },
      tier: 'tempo',
    },
    // run in from outside and hit between the middle and the pin
    {
      name: '3 ball (inside)',
      short: '3',
      lane: { ...LANES.OH, x: -2.1, z: 0.8, apexAbove: 0.75, sx: -4.6, sz: 3.7, label: 'Inside 3 ball' },
      tier: 'inside',
    },
  ],
  MB: [
    { name: '1 (quick in front)', short: '1', lane: LANES.MB, inFront: QUICK.inFront, tier: 'quick' },
    // shoot ("31"): the middle runs out towards the outside and the setter fires it flat to them
    {
      name: 'Shoot (31)',
      short: 'Shoot',
      lane: { ...LANES.MB, x: -1.4, sx: 0.0, sz: 2.9, label: 'Middle shoot (31)' },
      inFront: 2.4,
      tier: 'push',
    },
    // back quick: up behind the setter's back
    {
      name: 'Back quick',
      short: 'Back 1',
      lane: { ...LANES.MB, x: 2.3, sx: 1.0, sz: 2.9, label: 'Middle back quick' },
      inFront: -1.2,
      tier: 'backQuick',
    },
  ],
  OPP: [
    { name: 'Back set (pin)', short: 'Back', lane: LANES.OPP },
    // fast back set: low and flat to the right pin
    {
      name: 'Fast back',
      short: 'Fast',
      lane: { ...LANES.OPP, x: 3.95, z: 0.85, apexAbove: 0.45, sx: 4.7, sz: 3.3, label: 'Opposite fast back' },
      tier: 'tempo',
    },
    // close behind the setter
    {
      name: 'Back 2 (behind the setter)',
      short: 'Back 2',
      lane: { ...LANES.OPP, x: 2.45, z: 0.8, apexAbove: 0.6, sx: 4.4, sz: 3.4, label: 'Opposite back 2' },
      tier: 'inside',
    },
  ],
};

/** a first-tempo call: the hitter is in the air as the setter touches the ball, and the set meets them */
export function isQuick(play: SetPlay): boolean {
  return play.inFront !== undefined;
}

/**
 * Back-row attack from the right (the "D"): what the opposite hits when the setter is front row.
 * As the pipe, met 2 m off the net after a take-off behind the 3 m line.
 */
export const D_PLAY: SetPlay = {
  name: 'D (back row, right)',
  short: 'D',
  lane: { x: 3.1, z: 2.0, apexAbove: 1.45, sx: 3.1, sz: 5.5, label: 'Back-row D' },
};

/**
 * What a setter can call for each hitter (keys 1 outside, 2 middle, 3 opposite, 4 pipe): the
 * calls hitters make for themselves (SET_PLAYS), then the ones only a setter's plays use. They
 * come from coaching glossaries; names differ between teams, these are the common ones:
 * - Outside: the hut (lower and quicker than the high ball, still hit off the set), and the 2
 *   inside, right behind the middle's quick (the tandem's ball).
 * - Middle: the push 1, a quick pushed a little further along the net than the 1.
 * - Opposite: the X (crossing in front of the setter to hit a 2 behind the middle's quick) and
 *   the back 1 (a quick behind the setter: with the middle's 1 it is the double quick).
 * - Pipe: the bic, the fast pipe, and the pipe behind the setter (the "C": a back set to the back row).
 * A pin hitter's inside calls (the 3, the 2, the X, the back 2) start where their pin sets start,
 * or as near as the run allows: nothing gives the play away before they break inside (AI.insideRun).
 * A slide is not here: it needs a one-foot take-off off a curved run, which hitters can't do yet.
 */
export const SETTER_PLAYS: Record<'OH' | 'MB' | 'OPP' | 'PIPE', SetPlay[]> = {
  OH: [
    ...SET_PLAYS.OH!,
    { name: 'Hut (lower outside)', short: 'Hut', lane: { ...LANES.OH, apexAbove: 1.15, label: 'Outside hut' }, tier: 'hut' },
    {
      name: '2 (inside, behind the quick)',
      short: '2',
      lane: { ...LANES.OH, x: -0.75, z: 0.8, apexAbove: 0.8, sx: -4.3, sz: 4.0, label: 'Outside 2 (tandem)' },
      tier: 'inside',
    },
  ],
  MB: [
    ...SET_PLAYS.MB!,
    {
      name: 'Push 1',
      short: 'Push',
      lane: { ...LANES.MB, x: -0.5, sx: 0.2, sz: 2.85, label: 'Middle push 1' },
      inFront: 1.55,
      tier: 'push',
    },
  ],
  OPP: [
    ...SET_PLAYS.OPP!,
    {
      name: 'X (crossing for a 2)',
      short: 'X',
      // from a step behind the pin approach's start, so the loop in ends squarer to the net (AI.approach)
      lane: { ...LANES.OPP, x: -0.6, z: 0.8, apexAbove: 0.8, sx: 3.8, sz: 4.6, label: 'Opposite X' },
      tier: 'inside',
    },
    {
      name: 'Back 1 (quick behind)',
      short: 'Back 1',
      lane: { ...LANES.MB, x: 2.3, sx: 3.0, sz: 2.9, label: 'Opposite back quick' },
      inFront: -1.2,
      tier: 'backQuickOpp',
    },
  ],
  PIPE: [
    { name: 'Pipe', short: 'Pipe', lane: LANES.L },
    { name: 'Bic (fast pipe)', short: 'Bic', lane: { ...LANES.L, apexAbove: 0.8, label: 'Back-row bic' }, tier: 'tempo' },
    // right behind the setter's back: a short back set, met 2 m off the net like the pipe
    {
      name: 'Pipe behind you (C)',
      short: 'Behind',
      lane: { ...LANES.L, x: 1.7, sx: 1.7, label: 'Back-row pipe behind the setter' },
      tier: 'inside',
    },
  ],
};

/** height of the ball centre at the top of a good approach jump */
export function attackHeight(a: Athlete): number {
  return a.standReach - 0.16 + a.jumpMax * 0.95;
}

/** a typical hitter's contact height when no specific hitter is known */
export const GENERIC_ATTACK_HEIGHT = 3.15;

export function defaultPassTarget(a: Athlete): { x: number; y: number; z: number; apex: number } {
  const s = a.side;
  return { x: SETTER_TARGET.x * s, y: 2.35, z: SETTER_TARGET.z * s, apex: 4.1 };
}

/** front-row options for a setter on `a`'s side: outside, middle quick, opposite */
export function defaultSetOptions(a: Athlete, hitters: Partial<Record<'OH' | 'MB' | 'OPP', Athlete | null>> = {}): SetOption[] {
  const s = a.side;
  const mk = (pos: 'OH' | 'MB' | 'OPP', label: string): SetOption => {
    const l = laneFor(pos, s);
    const hitter = hitters[pos] ?? null;
    const y = hitter ? attackHeight(hitter) : GENERIC_ATTACK_HEIGHT;
    return { target: { x: l.x, y, z: l.z }, apex: y + l.apexAbove, hitter, label };
  };
  return [mk('OH', 'Outside'), mk('MB', 'Quick'), mk('OPP', 'Back set')];
}
