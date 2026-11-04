import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CONTACT, COURT, PLAYER, SIM } from '../src/config';
import { planApproach } from '../src/ai/approach';
import { Athlete } from '../src/game/athlete';
import { attackHeight, LANES } from '../src/game/plays';
import { JUMP_GATE_LOAD, jumpFreezeAt, jumpLoadFrac } from '../src/game/tutorial';
import { makeBall, stepBall, type BallEnv } from '../src/physics/ball';
import { BallPredictor } from '../src/physics/predict';
import { solveApex } from '../src/physics/solve';

const DT = 1 / SIM.hz;
const ENV: BallEnv = { netTop: COURT.netHeightMen };
/** contact.ts downgrades a spike once the body is under this fraction of the jump */
const PERFECT_JUMP = 0.72;

function loadTForFrac(frac: number): number {
  const denom = PLAYER.loadMax - PLAYER.loadMin * 0.5;
  return frac * denom + PLAYER.loadMin * 0.5;
}

/** closest the standing plant's hand comes to the high ball, and the jump fraction there */
function meet(tTakeoff: number, loadT: number, from: { x: number; y: number; z: number }, v: { x: number; y: number; z: number }, feet: { x: number; z: number }) {
  const a = new Athlete('OH', 1);
  a.place(feet.x, feet.z, 0);
  const b = makeBall();
  b.p.x = from.x;
  b.p.y = from.y;
  b.p.z = from.z;
  b.v.x = v.x;
  b.v.y = v.y;
  b.v.z = v.z;
  let best = { d: 1e9, hf: 0, vy: 0 };
  let jumped = false;
  const ip = new THREE.Vector3();
  for (let i = 0; i < SIM.hz * 4; i++) {
    const t = (i + 1) * DT;
    if (!jumped && t >= tTakeoff) {
      a.jumpPress();
      a.loadT = loadT;
      a.loadApproach = 0;
      a.jumpRelease();
      jumped = true;
    }
    a.step(DT, t);
    stepBall(b, DT, ENV, []);
    if (a.state === 'air') {
      a.idealContact(ip);
      const d = Math.hypot(b.p.x - ip.x, b.p.y - ip.y, b.p.z - ip.z);
      if (d < best.d) best = { d, hf: a.pos.y / a.jumpH, vy: a.vel.y };
    }
    if (jumped && a.state === 'land') break;
  }
  return best;
}

describe('guided plant vs the high ball', () => {
  const me = new Athlete('OH', 1);
  const lane = LANES.OH;
  const off = new THREE.Vector3();
  me.yaw = 0;
  me.idealContact(off, new THREE.Vector3(0, 0, 0));
  const feet = { x: lane.x - off.x, z: lane.z - off.z };
  me.place(feet.x, feet.z, 0);
  const y = attackHeight(me);
  const from = { x: 1.1, y: 1.9 + 0.17, z: 0.65 };
  const v = { x: 0, y: 0, z: 0 };
  const ball = makeBall();
  solveApex(from, { x: lane.x, y, z: lane.z }, y + lane.apexAbove, { x: 0, y: 0, z: 0 }, v);
  ball.p.x = from.x;
  ball.p.y = from.y;
  ball.p.z = from.z;
  ball.v.x = v.x;
  ball.v.y = v.y;
  ball.v.z = v.z;
  const pred = new BallPredictor(DT, SIM.predictHorizon);
  pred.compute(ball, ENV, 0);
  const plan = planApproach(me, pred, 0, 0, 0);
  const gateLoad = loadTForFrac(JUMP_GATE_LOAD);
  const capLoad = PLAYER.loadMax - 0.02;

  it('plans a takeoff, and the freeze waits until that takeoff', () => {
    expect(plan).toBeTruthy();
    expect(plan!.hold).toBeCloseTo(capLoad, 5);
    expect(jumpFreezeAt(plan!.tPress, plan!.hold)).toBeCloseTo(plan!.tPress + plan!.hold, 5);
    expect(jumpFreezeAt(plan!.tPress, plan!.hold)).toBeGreaterThan(plan!.tPress);
    expect(jumpLoadFrac(gateLoad)).toBeCloseTo(JUMP_GATE_LOAD, 5);
  });

  it('leaving the floor at the freeze meets the ball inside the Perfect jump band', () => {
    const freeze = jumpFreezeAt(plan!.tPress, plan!.hold);
    for (const load of [gateLoad, capLoad]) {
      const hit = meet(freeze, load, from, v, feet);
      expect(hit.hf).toBeGreaterThanOrEqual(PERFECT_JUMP);
      expect(hit.d).toBeLessThanOrEqual(CONTACT.spikeReach);
    }
  });

  it('leaving the floor when the press was frozen meets the ball on the way down', () => {
    // the shipped bug: load fills during the freeze, so takeoff is the press
    const early = meet(plan!.tPress, capLoad, from, v, feet);
    expect(early.hf).toBeLessThan(PERFECT_JUMP);
    expect(early.vy).toBeLessThan(0);
  });
});
