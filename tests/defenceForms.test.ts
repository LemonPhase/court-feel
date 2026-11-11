import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { AI, CONTACT, COURT, PLAYER, SIM, TIMING } from '../src/config';
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
function play(opts: { from: V3; to: V3; T: number; lead: number; form?: PassForm; dive?: boolean; offTheirBlock?: boolean }) {
  const state = makeBall();
  const predictor = new BallPredictor(DT, SIM.predictHorizon);
  let version = 0;
  let pv = -1;
  const ball = {
    state,
    active: true,
    lastTouch: { athlete: null, kind: opts.offTheirBlock ? 'block' : 'spike', t: -1, side: -1 } as any,
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

/**
 * A home blocker at the net jumps and puts the hands up; at the top of the jump their attack (side
 * -1) comes into the hands at `speed` m/s. Returns the block's contact and the ball's velocity off it.
 */
function blockAt(speed: number) {
  const state = makeBall();
  const ball = {
    state,
    active: true,
    lastTouch: { athlete: new Athlete('OH', -1), kind: 'spike', t: 0, side: -1 } as any,
    get pos() {
      return state.p;
    },
    get vel() {
      return state.v;
    },
    speed: () => Math.hypot(state.v.x, state.v.y, state.v.z),
    ensurePrediction: () => null as any,
    hit(v: V3, w: V3) {
      Object.assign(state.v, v);
      Object.assign(state.w, w);
    },
  };
  const events: ContactEvent[] = [];
  const host = {
    ball: ball as any,
    simTime: 0,
    env: { netTop: COURT.netHeightMen },
    aimAssist: () => 0,
    aimTargetFor: (_a: Athlete, out: THREE.Vector3) => out.set(0, 0, 0),
    emitContact: (e: ContactEvent) => events.push(e),
    rand: () => 0.5,
    passTarget: () => TARGET,
    setOptions: () => [],
    canServe: () => true,
  } satisfies ContactHost;
  const cs = new ContactSystem(host);
  const a = new Athlete('MB', 1);
  a.place(0, 0.45, 0);
  a.jumpPress();
  let act: ReturnType<Athlete['startAction']> | null = null;
  let fired = false;
  for (let i = 0; i < SIM.hz * 2 && !events.length; i++) {
    host.simTime += DT;
    if (a.state === 'load' && a.loadT >= PLAYER.loadMin) a.jumpRelease();
    a.step(DT, host.simTime);
    if (a.state === 'air' && !act) act = a.startAction('block', host.simTime);
    // at the top of the jump their attack arrives, a little down, into the middle of the hands
    if (act && !fired && a.vel.y <= 0) {
      fired = true;
      Object.assign(state.p, { x: 0, y: a.pos.y + a.standReach - 0.15, z: -0.25 });
      Object.assign(state.v, { x: 0, y: -0.15 * speed, z: speed });
    }
    if (fired) {
      cs.tryBlock(a, act!);
      stepBall(state, DT, host.env);
    }
  }
  return { e: events[0], v: { ...state.v } };
}

describe('the ball off the block', () => {
  it("a soft ball into a good block comes back to the hitter's side, slow and up: their cover can play it again", () => {
    const soft = blockAt(9);
    expect(soft.e?.kind).toBe('block');
    expect(soft.e.grade === 'Perfect' || soft.e.grade === 'Good').toBe(true);
    expect(soft.e.note).toBe('Off the block');
    // back towards their side (-z), going up, slow
    expect(soft.v.z).toBeLessThan(0);
    expect(soft.v.y).toBeGreaterThan(2);
    expect(Math.hypot(soft.v.x, soft.v.y, soft.v.z)).toBeLessThan(6);
    // a hard spike into the same block is not handed back like that
    const hard = blockAt(22);
    expect(hard.e?.kind).toBe('block');
    expect(hard.e.note).not.toBe('Off the block');
  });

  it('a ball off their block, dug by our cover, goes up high and well off the net: out of system, never Perfect', () => {
    const from = { x: 0.3, y: 2.9, z: -0.2 };
    const to = { x: 0, y: H * 0.34, z: 6 - 0.45 };
    const covered = play({ from, to, T: 1.0, lead: TIMING.passLead, offTheirBlock: true });
    const dug = play({ from, to, T: 1.0, lead: TIMING.passLead });
    expect(covered.e?.note).toBe('Covered');
    expect(covered.e.grade).not.toBe('Perfect');
    // the same ball after their attack (not off their block) goes to the setter as usual
    expect(dug.e?.note).not.toBe('Covered');
    expect(Math.abs(covered.e.target.z)).toBeGreaterThanOrEqual(CONTACT.covered.off);
    expect(covered.off).toBeGreaterThan(AI.outOfSystem + 1);
    expect(dug.off).toBeLessThan(AI.outOfSystem);
  });
});
