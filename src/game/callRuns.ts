import * as THREE from 'three';
import { AI, TIMING } from '../config';
import type { HitterBrain } from '../ai/hitter';
import { solveApex } from '../physics/solve';
import type { Athlete } from './athlete';
import type { SetOption } from './contact';
import type { Game } from './game';
import {
  attackHeight,
  LANES,
  laneFor,
  needsGoodPass,
  quickSetFor,
  quickSpot,
  SETTER_SPOT,
  SETTER_TARGET,
  setterTouchY,
  type AttackLane,
} from './plays';
import { SETTER_KEYS, type SetterCalls, type SetterKey } from './setterCalls';

/**
 * Your calls on the court: the hitters you set (home side) run what you called. Shared by the
 * Setter Drill and the Mini Rally, so a call works the same in both.
 */

/** a hitter you can set: the athlete and the brain that runs their approach */
export interface CallHitter {
  a: Athlete;
  brain: HitterBrain;
}
export type CallHitters = Map<SetterKey, CallHitter>;

/** each hitter's colour on the floor and the call sheet */
export const CALL_COLOR: Record<SetterKey, number> = { OH: 0xffc23a, MB: 0x6fe3ff, OPP: 0xff6fb0, PIPE: 0x6fd69a };

/** a hitter's high ball (above their contact): what a call becomes off a bad pass, or when you ask for it */
const HIGH_APEX: Record<SetterKey, number> = {
  OH: LANES.OH.apexAbove,
  MB: LANES.OH.apexAbove,
  OPP: LANES.OPP.apexAbove,
  PIPE: LANES.L.apexAbove,
};

/** where a hitter attacks with their call; off a bad pass (`oos`), their high ball to the pin */
export function callLane(calls: SetterCalls, k: SetterKey, oos: boolean): AttackLane {
  if (k === 'PIPE') return laneFor('L', 1);
  if (oos) return laneFor(k, 1);
  return calls.play(k).lane;
}

/** where the set goes for a hitter's call (the quick's spot in front of the setter's target) */
export function callSpot(calls: SetterCalls, k: SetterKey, oos: boolean): { x: number; z: number } {
  return k === 'MB' && !oos ? quickSpot(SETTER_TARGET.x, 1, calls.play('MB').inFront) : callLane(calls, k, oos);
}

/** the hitters line up for their calls: the start of each run, the middle's quick spot */
export function applyCalls(hitters: CallHitters, calls: SetterCalls, oos: boolean): void {
  for (const [k, h] of hitters) {
    h.brain.lane = callLane(calls, k, oos);
    if (k === 'MB') h.brain.inFront = calls.play('MB').inFront;
  }
}

/**
 * The pass to `setter` is played: read it (in or out of system) and start the second-tempo runs
 * (go, 3, fast back, back 2), timed so the hitter is on the last steps as the ball leaves the
 * setter's hands: the catch plus the load (TIMING.setLoad). A hitter still at the net backs off
 * to their approach start first (HitterBrain.runTo). The quick goes from the middle's own read
 * of the pass. Returns whether the pass is out of system.
 */
export function startCallRuns(g: Game, setter: Athlete, hitters: CallHitters, calls: SetterCalls): boolean {
  const pred = g.ball.ensurePrediction(g.env, g.simTime);
  const tTouch = pred.descendThrough(setterTouchY(setter), g.simTime);
  const at = { x: 0, y: 0, z: 0 };
  if (tTouch > 0) pred.posAt(tTouch, at);
  const oos = tTouch < 0 || Math.hypot(at.x - SETTER_SPOT.x, at.z - SETTER_SPOT.z) > AI.outOfSystem;
  applyCalls(hitters, calls, oos);
  if (oos) return true;
  const tSet = tTouch + TIMING.setLoad;
  for (const [k, h] of hitters) {
    if (k === 'MB' || k === 'PIPE' || !needsGoodPass(calls.play(k))) continue;
    const lane = h.brain.lane;
    const y = attackHeight(h.a);
    const contact = new THREE.Vector3(lane.x, y, lane.z);
    const v = { x: 0, y: 0, z: 0 };
    const arc = solveApex({ ...at }, contact, y + lane.apexAbove, { x: 0, y: 0, z: 0 }, v);
    h.brain.runTo(contact, tSet + arc.T);
  }
  return false;
}

/**
 * Your set options: each hitter at their call, or a high ball when you asked for one or the pass
 * is off the net (`oos`: then no middle, as nobody sets a middle a high ball).
 */
export function callOptions(g: Game, hitters: CallHitters, calls: SetterCalls, oos: boolean): SetOption[] {
  const out: SetOption[] = [];
  for (const [k, h] of hitters) {
    if (k === 'MB' && oos) continue;
    const high = oos || calls.isHigh(k);
    const label = k === 'PIPE' ? 'Pipe' : `${k} ${high ? 'High' : calls.play(k).short}`;
    if (k === 'MB' && !high) {
      // the quick is met at the top of the middle's jump when they are up with your touch
      const q = quickSetFor(h.a, g.simTime, g.ball.pos, h.brain.releaseAt, calls.play('MB').inFront);
      out.push({ ...q, label, key: k, fast: true });
      continue;
    }
    const lane = callLane(calls, k, oos);
    const y = attackHeight(h.a);
    // a high ball: no faster than the position's high ball, a little higher off a bad pass
    const apexAbove = high ? Math.max(lane.apexAbove, HIGH_APEX[k]) + (oos ? AI.outOfSystemApex : 0) : lane.apexAbove;
    out.push({
      target: { x: lane.x, y, z: lane.z },
      apex: y + apexAbove,
      hitter: h.a,
      label,
      key: k,
      fast: !high && k !== 'PIPE' && needsGoodPass(calls.play(k)),
    });
  }
  return out;
}

/** the call sheet row for the HUD: each hitter's key, call and colour, the pick lit */
export function callSheet(calls: SetterCalls, keys: readonly SetterKey[], shown: SetterKey | null) {
  return {
    items: keys.map((k) => ({
      key: String(SETTER_KEYS.indexOf(k) + 1),
      who: k === 'PIPE' ? 'Pipe' : k,
      call: k === 'PIPE' ? (calls.isHigh(k) ? 'High' : '') : calls.label(k),
      picked: calls.pick === k,
      lit: shown === k,
      color: `#${CALL_COLOR[k].toString(16).padStart(6, '0')}`,
    })),
    editing: calls.editing,
    locked: calls.locked,
  };
}
export type CallSheetView = ReturnType<typeof callSheet>;
