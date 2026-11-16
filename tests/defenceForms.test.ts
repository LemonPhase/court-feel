import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { AI, CONTACT, COURT, PLAYER, SIM, TIMING } from '../src/config';
import { Athlete, type PassForm } from '../src/game/athlete';
import { ContactSystem, type ContactEvent, type ContactHost } from '../src/game/contact';
import { Rng, yawFromDir } from '../src/core/mathx';
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
function play(opts: {
  from: V3;
  to: V3;
  T: number;
  lead: number;
  form?: PassForm;
  dive?: boolean;
  offTheirBlock?: boolean;
  /** the block it came off handed it back softly (a recycled ball) */
  recycle?: boolean;
  rand?: () => number;
}) {
  const state = makeBall();
  const predictor = new BallPredictor(DT, SIM.predictHorizon);
  let version = 0;
  let pv = -1;
  const ball = {
    state,
    active: true,
    lastTouch: { athlete: null, kind: opts.offTheirBlock ? 'block' : 'spike', t: -1, side: -1, recycle: opts.recycle } as any,
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
    rand: opts.rand ?? (() => 0.5),
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
  return { e, off: e ? Math.hypot(e.target.x - TARGET.x, e.target.z - TARGET.z) : NaN, vy: state.v.y, v: { ...state.v } };
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
function blockAt(speed: number, opts: { at?: number; off?: number; user?: boolean } = {}) {
  const state = makeBall();
  const hitter = new Athlete('OH', -1);
  hitter.isUser = opts.user ?? false;
  const ball = {
    state,
    active: true,
    lastTouch: { athlete: hitter, kind: 'spike', t: 0, side: -1 } as any,
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
  a.place(opts.at ?? 0, 0.45, 0);
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
      Object.assign(state.p, { x: a.pos.x + (opts.off ?? 0), y: a.pos.y + a.standReach - 0.15, z: -0.25 });
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

  it("your spike off the outside of an AI block's hands is wiped off it more often than an AI hitter's (playability)", () => {
    // an AI blocker at the pin; the ball meets the hands just over half their half-width out
    const off = (CONTACT.blockHalfWidth * (CONTACT.userToolEdge + CONTACT.toolEdge)) / 2;
    const yours = blockAt(22, { at: 3, off, user: true });
    const theirs = blockAt(22, { at: 3, off });
    expect(yours.e?.note).toBe('Tooled');
    expect(Math.abs(yours.v.x)).toBeGreaterThan(3);
    expect(theirs.e?.kind).toBe('block');
    expect(theirs.e.note).not.toBe('Tooled');
  });

  /** a ball off their block coming down onto our coverer's platform at (0, 5.55): `T` s from `from` */
  const cover = (from: V3, T: number, lead: number, rand?: () => number, offTheirBlock = true, recycle = false) =>
    play({ from, to: { x: 0, y: H * 0.34, z: 6 - 0.45 }, T, lead, offTheirBlock, recycle, rand });
  /** recycled: it drops slowly; stuffed: it is driven down */
  const SLOW = { from: { x: 0.3, y: 2.9, z: 4.0 }, T: 0.8, lead: TIMING.passLead };
  const HARD = { from: { x: 0.3, y: 2.9, z: 4.6 }, T: 0.22, lead: TIMING.digLead };

  it('a slow ball off their block is covered with control, most of the way to the setter; one stuffed down hard pops up by the coverer', () => {
    const slow = cover(SLOW.from, SLOW.T, SLOW.lead, undefined, true, true);
    const hard = cover(HARD.from, HARD.T, HARD.lead);
    expect(slow.e?.note).toBe('Covered');
    expect(hard.e?.note).toBe('Covered');
    expect(slow.e.grade).not.toBe('Perfect');
    // the slow one goes most of the way to the setter (the same ball after their attack goes all the way)
    const passed = cover(SLOW.from, SLOW.T, SLOW.lead, undefined, false);
    expect(passed.e?.note).not.toBe('Covered');
    expect(slow.off).toBeLessThan(hard.off);
    expect(slow.off).toBeGreaterThan(passed.off);
    expect(passed.off).toBeLessThan(AI.outOfSystem);
    // the stuff is out of the coverer's control: up, within a few metres of where it was dug
    const near = Math.hypot(hard.e.target.x - hard.e.point.x, hard.e.target.z - hard.e.point.z);
    expect(near).toBeLessThanOrEqual(CONTACT.covered.stuff.pop[1] + 0.01);
    expect(hard.off).toBeGreaterThan(AI.outOfSystem + 1);
  });

  it('a stuff kept up is mostly luck: low and flat or high, short or long, any direction; the recycled ball still goes up to the setter', () => {
    const rng = new Rng(11);
    // (a stuff that is not driven straight down: slow enough that the platform has some of it)
    const KEPT = { from: { x: 0.3, y: 2.9, z: 4.4 }, T: 0.45, lead: TIMING.passLead };
    const stuffs = Array.from({ length: 40 }, () => cover(KEPT.from, KEPT.T, KEPT.lead, () => rng.next()));
    const recycled = Array.from({ length: 40 }, () => cover(SLOW.from, SLOW.T, SLOW.lead, () => rng.next(), true, true));
    /** how high above the platform it goes, how fast it leaves, which way */
    const rise = (c: (typeof stuffs)[number]) => (c.v.y * c.v.y) / (2 * 9.81);
    const speed = (c: (typeof stuffs)[number]) => Math.hypot(c.v.x, c.v.y, c.v.z);
    const span = (cs: typeof stuffs, f: (c: (typeof stuffs)[number]) => number) => Math.max(...cs.map(f)) - Math.min(...cs.map(f));
    const mean = (cs: typeof stuffs, f: (c: (typeof stuffs)[number]) => number) => cs.reduce((t, c) => t + f(c), 0) / cs.length;
    for (const c of stuffs) expect(c.e?.note).toBe('Covered');
    // height, speed and direction all vary a lot
    expect(span(stuffs, rise)).toBeGreaterThan(2);
    expect(span(stuffs, speed)).toBeGreaterThan(3);
    expect(stuffs.some((c) => c.v.z > 0.5)).toBe(true);
    expect(stuffs.some((c) => c.v.z < -0.5)).toBe(true);
    expect(stuffs.some((c) => c.v.x > 0.5)).toBe(true);
    expect(stuffs.some((c) => c.v.x < -0.5)).toBe(true);
    // some barely leave the floor
    expect(Math.min(...stuffs.map(rise))).toBeLessThan(0.8);
    // lower than the recycled ball on the whole, and much further from the setter
    expect(mean(stuffs, rise)).toBeLessThan(mean(recycled, rise) - 0.5);
    expect(mean(stuffs, (c) => c.off)).toBeGreaterThan(mean(recycled, (c) => c.off) + 1);
    // few of them are a pass the setter can run an offence off
    expect(stuffs.filter((c) => c.off < AI.outOfSystem).length).toBeLessThan(8);
  });

  it('no two covers of a stuff come off the same: the ball goes up somewhere near the coverer', () => {
    const rng = new Rng(7);
    const spots = [0, 1, 2, 3, 4, 5].map(() => cover(HARD.from, HARD.T, HARD.lead, () => rng.next()).e.target);
    const xs = spots.map((p) => p.x);
    const zs = spots.map((p) => p.z);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(1.5);
    expect(Math.max(...zs) - Math.min(...zs)).toBeGreaterThan(1.5);
  });

  it('a coverer has less of the ball the harder it comes, off a late platform, off its edge, on the move, reaching', () => {
    const cs = new ContactSystem({} as ContactHost);
    const C = CONTACT.covered;
    const best = cs.coverControl(C.easy, 'Good', 0, 0, 'platform');
    expect(best).toBeCloseTo(C.best);
    expect(cs.coverControl(C.hard, 'Good', 0, 0, 'platform')).toBe(0);
    for (const worse of [
      cs.coverControl((C.easy + C.hard) / 2, 'Good', 0, 0, 'platform'),
      cs.coverControl(C.easy, 'Late', 0, 0, 'platform'),
      cs.coverControl(C.easy, 'Good', 1, 0, 'platform'),
      cs.coverControl(C.easy, 'Good', 0, 1, 'platform'),
      cs.coverControl(C.easy, 'Good', 0, 0, 'side'),
    ]) {
      expect(worse).toBeLessThan(best);
      expect(worse).toBeGreaterThan(0);
    }
  });
});
