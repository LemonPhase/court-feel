import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CONTACT, COURT, PLAYER, SIM, TIMING } from '../src/config';
import { Athlete, type PassForm } from '../src/game/athlete';
import { ContactSystem, type ContactEvent, type ContactHost } from '../src/game/contact';
import { yawFromDir } from '../src/core/mathx';
import { makeBall, stepBall, type V3 } from '../src/physics/ball';
import { BallPredictor } from '../src/physics/predict';
import { solveFixedTime } from '../src/physics/solve';

const DT = 1 / SIM.hz;
/** the defender's height (the platform and the forehead are where they are on this body) */
const H = new Athlete('L', 1).height;
const TARGET = { x: 1, y: 2.35, z: 0.9, apex: 4 };

/**
 * A home defender standing at (0, 6) facing the net. A ball from `from` reaches `to` `T` s from now;
 * `start` runs once at the start (to dive, say), and the pass goes up (form `form`) `lead` s before
 * the ball arrives. Returns the contact, or undefined if the ball got by.
 */
function play(opts: { from: V3; to: V3; T: number; lead: number; form?: PassForm; dive?: boolean }) {
  const state = makeBall();
  const predictor = new BallPredictor(DT, SIM.predictHorizon);
  let version = 0;
  let pv = -1;
  const ball = {
    state,
    active: true,
    lastTouch: { athlete: null, kind: 'spike', t: -1, side: -1 } as any,
    get pos() {
      return state.p;
    },
    get vel() {
      return state.v;
    },
    speed: () => Math.hypot(state.v.x, state.v.y, state.v.z),
    ensurePrediction(env: { netTop: number }, t: number) {
      if (pv !== version) {
        predictor.compute(state, env, t);
        pv = version;
      }
      return predictor;
    },
    hit(v: V3, w: V3) {
      Object.assign(state.v, v);
      Object.assign(state.w, w);
      version++;
    },
  };
  const events: ContactEvent[] = [];
  const host = {
    ball: ball as any,
    simTime: 0,
    env: { netTop: COURT.netHeightMen },
    aimAssist: () => 0,
    aimTargetFor: (_a: Athlete, out: THREE.Vector3) => out.set(1, 0.105, -6),
    emitContact: (e: ContactEvent) => events.push(e),
    rand: () => 0.5,
    passTarget: () => TARGET,
    setOptions: () => [],
    canServe: () => true,
  } satisfies ContactHost;
  const cs = new ContactSystem(host);
  const a = new Athlete('L', 1);
  a.place(0, 6, 0);
  solveFixedTime(opts.from, opts.to, opts.T, { x: 0, y: 0, z: 0 }, state.v);
  Object.assign(state.p, opts.from);
  version++;
  if (opts.dive) {
    a.dive(yawFromDir(opts.to.x - a.pos.x, opts.to.z - a.pos.z));
    a.startAction('pass', 0);
  }
  let act = a.action;
  for (let i = 0; i < SIM.hz * 2 && !events.length; i++) {
    if (!act && host.simTime >= opts.T - opts.lead - 1e-9) {
      act = a.startAction('pass', host.simTime);
      act.form = opts.form ?? 'platform';
    }
    if (act) cs.tryPass(a, act);
    host.simTime += DT;
    a.step(DT, host.simTime);
    stepBall(state, DT, host.env);
  }
  const e = events[0];
  return { e, off: e ? Math.hypot(e.target.x - TARGET.x, e.target.z - TARGET.z) : NaN, vy: state.v.y };
}

/** a spike from their outside at 20 m/s, met by our defender's platform `side` m to their right */
const dig = (side: number, form: PassForm = 'platform') => {
  const to = { x: side, y: H * 0.34, z: 6 - 0.3 };
  return play({ from: { x: -3, y: 3.2, z: -0.6 }, to, T: 0.4, lead: TIMING.digLead, form });
};

describe('how a defender plays the first ball', () => {
  it('a hard ball past the hip is dug with the platform swung out to that side: never Perfect', () => {
    const front = dig(0);
    expect(front.e.form).toBe('platform');
    const side = dig(0.85);
    expect(side.e?.form).toBe('side');
    expect(side.e.grade).not.toBe('Perfect');
    // and the side dig goes up less accurately than a dig straight in front
    expect(side.off).toBeGreaterThan(front.off);
    // a ball well wide of that is not reached standing
    expect(dig(0.85 + CONTACT.sideReach + 0.3).e).toBeUndefined();
  });

  it('a ball 2 m away coming down low is reached with a dive, and dug up high; standing, it drops', () => {
    // the ball comes down to just off the floor 2 m in front-left of the defender, 0.3 s from now
    const to = { x: -0.9, y: CONTACT.diveLow, z: 6 - 1.85 };
    const from = { x: 2.5, y: 3.3, z: -0.4 };
    const T = PLAYER.diveDown;
    const standing = play({ from, to, T, lead: TIMING.digLead });
    expect(standing.e).toBeUndefined();
    const dived = play({ from, to, T, lead: 0, dive: true });
    expect(dived.e?.form).toBe('dive');
    expect(dived.e.grade === 'Good' || dived.e.grade === 'Late').toBe(true);
    // a dive keeps it alive: the ball goes up
    expect(dived.vy).toBeGreaterThan(4);
  });

  it('a slow ball coming down at head height is passed overhand, more accurately than with the platform', () => {
    // a free ball: 8 m/s, coming down onto the forehead / the platform in front
    const T = 1.1;
    const from = { x: 0, y: 3.0, z: -3 };
    const hands = play({ from, to: { x: 0, y: H + 0.17 + 0.2, z: 6 - 0.14 }, T, lead: TIMING.setLead, form: 'hands' });
    const platform = play({ from, to: { x: 0, y: H * 0.34, z: 6 - 0.45 }, T: T + 0.12, lead: TIMING.passLead });
    expect(hands.e?.form).toBe('hands');
    expect(hands.e.note).toBe('Overhand');
    expect(platform.e?.form).toBe('platform');
    expect(hands.off).toBeLessThan(platform.off);
  });
});
