import * as THREE from 'three';
import { AI, BALL, CONTACT, TIMING } from '../config';
import { solveApex } from '../physics/solve';
import type { Athlete } from './athlete';
import type { SetOption } from './contact';
import type { AiHost } from './brains';
import {
  attackHeight,
  isQuick,
  LANES,
  needsGoodPass,
  quickSetFor,
  quickSpot,
  SETTER_SPOT,
  SETTER_TARGET,
  setterTouchY,
  type AttackLane,
} from './plays';
import { wheelPlays } from './playbook';
import { SET_PICKS, SETTER_KEYS, type SetPick, type SetterCalls, type SetterKey } from './setterCalls';

/**
 * Calls on the court: the hitters a setter sets run what was called. Shared by the Setter Drill and
 * the Mini Rally (your calls) and by an AI setter's play (TeamAI, either side of the net), so a
 * call works the same whoever makes it. Calls are written for the home side (+z) and mirrored for
 * a hitter on the far side (`sideLane`).
 */

/** a lane written for the home side, on `side`'s court */
export function sideLane(lane: AttackLane, side: 1 | -1): AttackLane {
  return side === 1 ? lane : { ...lane, x: -lane.x, z: -lane.z, sx: -lane.sx, sz: -lane.sz };
}

/**
 * What your calls need of a hitter's brain: where they run and hit, their read of the pass for a
 * quick, a called run to make or hold. HitterBrain (src/ai/hitter.ts) is one; the simulation
 * does not import the AI, so it names only this.
 */
export interface CallBrain {
  lane: AttackLane;
  inFront: number | undefined;
  passToSetter: ((g: AiHost) => { t: number; x: number } | null) | null;
  missedRun: boolean;
  readonly releaseAt: number | undefined;
  runTo(contact: THREE.Vector3, tc: number): void;
  holdRun(): boolean;
}

/** a hitter you can set: the athlete and the brain that runs their approach */
export interface CallHitter<B extends CallBrain = CallBrain> {
  a: Athlete;
  brain: B;
  /**
   * The pass on its way to you, for a hitter whose call is a quick: when the ball leaves your
   * hands and where (null: no quick off this pass). The mode's read; a quick runs on it.
   */
  read?: (g: AiHost) => { t: number; x: number } | null;
}
export type CallHitters<B extends CallBrain = CallBrain> = Map<SetterKey, CallHitter<B>>;

/** each hitter's colour on the floor and the call strip (the dump: white) */
export const CALL_COLOR: Record<SetPick, number> = { OH: 0xffc23a, MB: 0x6fe3ff, OPP: 0xff6fb0, PIPE: 0x6fd69a, DUMP: 0xffffff };

/** a hitter's colour for CSS ('#ffc23a'); no hitter: white */
export function callCss(k: SetPick | null | undefined): string {
  return `#${(k ? CALL_COLOR[k] : 0xffffff).toString(16).padStart(6, '0')}`;
}

/** a hitter's high ball (above their contact): what a call becomes off a bad pass, or when you ask for it */
const HIGH_APEX: Record<SetterKey, number> = {
  OH: LANES.OH.apexAbove,
  MB: LANES.OH.apexAbove,
  OPP: LANES.OPP.apexAbove,
  // the pipe's high ball is its High call: as high as the outside's
  PIPE: LANES.OH.apexAbove,
};

/** off a bad pass (`oos`) this hitter gets their high ball, unless you asked them for their fast set */
function goesHigh(calls: SetterCalls, k: SetterKey, oos: boolean): boolean {
  return oos && !calls.asksFast(k);
}

/** where a hitter attacks with their call; off a bad pass (`oos`), their high ball */
export function callLane(calls: SetterCalls, k: SetterKey, oos: boolean): AttackLane {
  return goesHigh(calls, k, oos) ? calls.highLane(k) : calls.play(k).lane;
}

/** where the set goes for a hitter's call (a quick's spot in front of the setter's target) */
export function callSpot(calls: SetterCalls, k: SetterKey, oos: boolean): { x: number; z: number } {
  const p = calls.play(k);
  return isQuick(p) && !goesHigh(calls, k, oos) ? quickSpot(SETTER_TARGET.x, 1, p.inFront) : callLane(calls, k, oos);
}

/**
 * The hitters line up for their calls: the start of each run, and a quick's spot and read of the
 * pass. Before the pass a run missed on an earlier ball of the rally is forgotten: this ball's
 * call is a new one (a quick never goes through HitterBrain.runTo, which clears it too).
 */
export function applyCalls(hitters: CallHitters, calls: SetterCalls, oos: boolean): void {
  for (const [k, h] of hitters) {
    if (!calls.locked) h.brain.missedRun = false;
    const p = calls.play(k);
    const quick = isQuick(p) && !goesHigh(calls, k, oos);
    h.brain.lane = sideLane(callLane(calls, k, oos), h.a.side);
    h.brain.inFront = quick ? p.inFront : undefined;
    // only a quick runs on the pass by itself: your pins run when you call it (runFast)
    h.brain.passToSetter = quick ? (h.read ?? null) : null;
  }
}

/**
 * After the pass: a hitter who could not make their called run (in transition, still at the net
 * from a block) waits for a high ball instead, and your call strip says so. Your set to them
 * then goes up high, where they can get to it, not to a spot they are not running to.
 */
export function syncRuns(hitters: CallHitters, calls: SetterCalls): void {
  if (!calls.locked) return;
  for (const [k, h] of hitters) {
    if (!h.brain.missedRun || calls.isHigh(k)) continue;
    calls.forceHigh(k);
    h.brain.lane = sideLane(calls.highLane(k), h.a.side);
  }
}

/** where and when `setter` will touch the ball now in flight (null: it never comes down onto their hands) */
function touchOf(g: AiHost, setter: Athlete): { t: number; at: { x: number; y: number; z: number } } | null {
  // a setter going up for it meets the ball higher and sooner
  const c = g.contact.setCatch(setter);
  if (c && c.feetY > 0) return { t: c.t, at: { x: c.at.x, y: c.at.y, z: c.at.z } };
  const pred = g.ball.ensurePrediction(g.env, g.simTime);
  const t = pred.descendThrough(setterTouchY(setter), g.simTime);
  if (t < 0) return null;
  const at = { x: 0, y: 0, z: 0 };
  pred.posAt(t, at);
  return { t, at };
}

/** a second-tempo run: the hitter is on the last steps as the ball leaves your hands (`tSet`, from `at`) */
function runFast(h: CallHitter, at: { x: number; y: number; z: number }, tSet: number): void {
  const lane = h.brain.lane;
  const y = attackHeight(h.a);
  const contact = new THREE.Vector3(lane.x, y, lane.z);
  const v = { x: 0, y: 0, z: 0 };
  const arc = solveApex({ ...at }, contact, y + lane.apexAbove, { x: 0, y: 0, z: 0 }, v);
  h.brain.runTo(contact, tSet + arc.T);
}

/**
 * The pass to `setter` is played: read it (in or out of system), lock the calls and start the
 * second-tempo runs (go, 3, fast back, back 2, the X, the bic), timed so the hitter is on the
 * last steps as the ball leaves the setter's hands: the catch plus the load (TIMING.setLoad). A
 * hitter still at the net backs off to their approach start first (HitterBrain.runTo). A quick
 * goes from the hitter's own read of the pass. Returns whether the pass is out of system: then
 * everyone waits for a high ball, until you ask one of them for their fast set (askFast).
 */
export function startCallRuns(g: AiHost, setter: Athlete, hitters: CallHitters, calls: SetterCalls): boolean {
  const touch = touchOf(g, setter);
  const s = setter.side;
  const oos = !touch || Math.hypot(touch.at.x - SETTER_SPOT.x * s, touch.at.z - SETTER_SPOT.z * s) > AI.outOfSystem;
  calls.lock(oos);
  applyCalls(hitters, calls, oos);
  if (oos || !touch) return true;
  runCalls(hitters, calls, touch.at, touch.t + TIMING.setLoad);
  return false;
}

/**
 * Start the second-tempo runs of the calls (in system: the calls are locked), for a set leaving the
 * setter's hands from `at` at `tSet`. A quick is not started here: it goes off the hitter's read.
 */
export function runCalls(hitters: CallHitters, calls: SetterCalls, at: { x: number; y: number; z: number }, tSet: number): void {
  for (const [k, h] of hitters) {
    const p = calls.play(k);
    if (!isQuick(p) && needsGoodPass(p)) runFast(h, at, tSet);
  }
}

/**
 * Out of system: can `k` still make their fast set if you ask now? A quick needs
 * `AI.oosAsk.quick` s before the ball leaves your hands (to load and jump), a second-tempo run
 * `AI.oosAsk.tempo` s (to get into their last steps).
 */
export function canAskFast(g: AiHost, setter: Athlete, calls: SetterCalls, k: SetterKey): boolean {
  const touch = touchOf(g, setter);
  const p = calls.fastPlay(k);
  if (!touch || !p) return false;
  return touch.t + TIMING.setLoad - g.simTime >= (isQuick(p) ? AI.oosAsk.quick : AI.oosAsk.tempo);
}

/** after the pass you asked `k` for their fast set (out of system, or back from a high ball): they line up for it and run it */
export function askFast(g: AiHost, setter: Athlete, hitters: CallHitters, calls: SetterCalls, k: SetterKey): void {
  applyCalls(hitters, calls, calls.oos);
  const h = hitters.get(k);
  const touch = touchOf(g, setter);
  const p = calls.play(k);
  if (h && touch && !isQuick(p) && needsGoodPass(p)) runFast(h, touch.at, touch.t + TIMING.setLoad);
}

/** in system you asked `k` for a high ball instead: they wait for it, if they have not started their run */
export function holdForHigh(hitters: CallHitters, k: SetterKey): boolean {
  return hitters.get(k)?.brain.holdRun() ?? true;
}

/** the pass on its way to the user setter: when the ball leaves their hands (the catch plus the load) and where */
export function passToUser(g: AiHost, setter: Athlete): { t: number; x: number } | null {
  const touch = touchOf(g, setter);
  return touch ? { t: touch.t + TIMING.setLoad, x: touch.at.x } : null;
}

/**
 * Your set options: each hitter at their call, or a high ball when you asked for one or the pass
 * is off the net (`oos`: then no middle, as nobody sets a middle a high ball, unless you asked
 * them for the quick).
 */
export function callOptions(g: AiHost, hitters: CallHitters, calls: SetterCalls, oos: boolean): SetOption[] {
  const W = CONTACT.setTouch.window;
  const out: SetOption[] = [];
  for (const [k, h] of hitters) {
    const asked = calls.canCall && calls.asksFast(k);
    if (k === 'MB' && oos && !asked) continue;
    const high = asked ? false : oos || calls.isHigh(k);
    const p = calls.play(k);
    const who = k === 'PIPE' ? 'Pipe' : k;
    const label = `${who} ${high ? 'High' : p.short}`;
    if (isQuick(p) && !high) {
      // a quick is met at the top of the hitter's jump when they are up with your touch
      const q = quickSetFor(h.a, g.simTime, g.ball.pos, h.brain.releaseAt, p.inFront);
      out.push({ ...q, label, key: k, fast: true, window: W[p.tier ?? 'quick'] });
      continue;
    }
    const lane = sideLane(callLane(calls, k, oos), h.a.side);
    const y = attackHeight(h.a);
    // a high ball: no faster than the position's high ball, a little higher off a bad pass
    const apexAbove = high ? Math.max(lane.apexAbove, HIGH_APEX[k]) + (oos ? AI.outOfSystemApex : 0) : lane.apexAbove;
    out.push({
      target: { x: lane.x, y, z: lane.z },
      apex: y + apexAbove,
      hitter: h.a,
      label,
      key: k,
      fast: !high && needsGoodPass(p),
      window: high ? W.high : W[p.tier ?? 'high'],
      outOfSystem: oos && high,
    });
  }
  return out;
}

/**
 * The dump: the setter's own attack on the second ball, over the net to the floor: short behind
 * the block, or deep to the far corner (`calls.dumpDeep`). Front row only (a back-row setter may
 * not attack a ball above the net), and only from within `CONTACT.dump.maxOff` m of the net.
 * Null when it is not on.
 */
export function dumpOption(calls: SetterCalls, setter: Athlete, netTop: number): SetOption | null {
  const D = CONTACT.dump;
  if (!calls.frontRow || Math.abs(setter.pos.z) > D.maxOff) return null;
  const s = setter.side;
  const spot = calls.dumpDeep ? D.deep : D.short;
  return {
    target: { x: spot.x * s, y: BALL.radius, z: spot.z * s },
    apex: netTop + (calls.dumpDeep ? D.apexDeep : D.apexShort),
    hitter: null,
    label: calls.dumpDeep ? 'Dump deep' : 'Dump short',
    key: 'DUMP',
    dump: true,
  };
}

/**
 * The call strip for the HUD: each hitter's key, call and colour, and which of their calls is on
 * (`step` of `steps`); front row, the dump too. `lit` is where the set goes (`shown`); `picked`
 * says you pressed that key (no key: the outside is lit, not picked). `off` ones can't be set
 * this ball.
 */
export function callSheet(calls: SetterCalls, keys: readonly SetPick[], shown: SetPick | null, off: readonly SetPick[] = []) {
  return {
    items: keys.map((k) => {
      const base = {
        id: k,
        key: String(SET_PICKS.indexOf(k) + 1),
        picked: calls.pick === k,
        lit: shown === k,
        off: off.includes(k),
        color: callCss(k),
      };
      if (k === 'DUMP') return { ...base, who: 'Dump', call: calls.dumpDeep ? 'Deep' : 'Short', step: calls.dumpDeep ? 1 : 0, steps: 2 };
      const s = calls.step(k);
      const label = calls.label(k);
      return {
        ...base,
        who: k === 'PIPE' ? 'Pipe' : k,
        call: label,
        step: s.i,
        // once the pass is played (or for a backup) the calls can't be stepped: no dots
        steps: calls.canCall ? s.n : 1,
      };
    }),
    locked: calls.locked,
    /** the combination the calls make, if they are one */
    play: calls.canCall ? (calls.combo(wheelPlays())?.name ?? '') : '',
  };
}
export type CallSheetView = ReturnType<typeof callSheet>;

/** the keys on the call strip: the hitters, and the dump when the setter is front row */
export function stripKeys(calls: SetterCalls): readonly SetPick[] {
  return calls.frontRow ? SET_PICKS : SETTER_KEYS;
}
