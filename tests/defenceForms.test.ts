import { describe, expect, it } from 'vitest';
import { AI, ASSIST, BALL, CONTACT, COURT, PLAYER, SIM, TIMING } from '../src/config';
import { BlockerBrain } from '../src/ai/blocker';
import { Athlete, type PassForm } from '../src/game/athlete';
import type { Brain } from '../src/game/brains';
import type { ContactEvent } from '../src/game/contact';
import contactSource from '../src/game/contact.ts?raw';
import { Rng, yawFromDir } from '../src/core/mathx';
import { makeBall, stepBall, type V3 } from '../src/physics/ball';
import { solveFixedTime } from '../src/physics/solve';
import { DT, scene } from './scene';

/** the defender's height (the platform and the forehead are where they are on this body) */
const H = new Athlete('L', 1).height;
const TARGET = { x: 1, y: 2.35, z: 0.9, apex: 4 };
/**
 * What a whole aim assist adds to the reach of a pass (m). In the source it is an inline number of
 * `ContactSystem.tryPass` (`assist * 0.25`) with no name in config, so it is copied here, and the
 * first dive test fails when the line it is copied from changes.
 */
const ASSIST_PASS_REACH = 0.25;
/**
 * How far from the middle of the arms a diving defender nobody plays still reaches the ball (m):
 * the pass radius, what the aim assist the game gives an AI player adds (`ASSIST.ai`), and the one
 * arm out of a dive.
 */
const DIVE_REACH = CONTACT.passRadius + ASSIST.ai * ASSIST_PASS_REACH + CONTACT.diveOut.reach;

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
  /** the test's own dice: a seeded stream that runs on through several plays */
  rand?: () => number;
  /** the simulation's own dice, from this seed: the play is one of many, and what the dice do is part of the fact */
  seed?: number;
  /** where the contact aims it (default: the setter's hands) */
  target?: { x: number; y: number; z: number; apex: number };
  /** the dive goes this way (default: at `to`), from a run at this speed along it */
  diveAt?: { x: number; z: number };
  run?: number;
  /** this is our third ball (the contact may only try to get it over) */
  third?: boolean;
}) {
  const s = scene({
    seed: opts.seed,
    // fixed dice, unless the play has a seed: every roll comes up a half, so the pass is graded on the
    // timing and the form alone, with the spread of the dice taken out. `rand` is a test's own seeded
    // stream instead, one that runs on through several plays
    dice: opts.seed === undefined ? { roll: opts.rand ?? 0.5 } : 'seeded',
    drill: { passTarget: () => opts.target ?? TARGET },
  });
  const { sim } = s;
  const state = sim.ball.state;
  const a = s.athlete('L', 1, { x: 0, z: 6 });
  s.send(
    { from: opts.from, to: opts.to, time: opts.T },
    opts.third
      ? { athlete: s.athlete('OH', 1, { x: 3, z: 3 }), kind: 'set', side: 1 }
      : { athlete: null, kind: opts.offTheirBlock ? 'block' : 'spike', side: -1, recycle: opts.recycle },
  );
  // the dive goes off from a run: the body is already moving that way when the ball is sent
  const to = opts.diveAt ?? opts.to;
  const dx = to.x - a.pos.x;
  const dz = to.z - a.pos.z;
  const d = Math.hypot(dx, dz);
  if (opts.dive) a.vel.set((dx / d) * (opts.run ?? 0), 0, (dz / d) * (opts.run ?? 0));
  // a step moves the clock first and the ball last: a brain sees the ball arrive at T + DT on the clock it reads
  const press = sim.simTime + DT + opts.T - opts.lead;
  let pressed = false;
  // the defender's brain: it dives at once or puts the pass up on time, and plays the ball as every
  // AI brain does (the contact system is asked each step, before the bodies and the ball move)
  const defender: Brain = {
    athlete: a,
    step: (_dt, g) => {
      if (!pressed && (opts.dive || g.simTime >= press - 1e-9)) {
        pressed = true;
        if (opts.dive) a.dive(yawFromDir(dx, dz));
        const act = a.startAction('pass', g.simTime);
        if (!opts.dive) act.form = opts.form ?? 'platform';
      }
      if (a.action?.kind === 'pass' && !a.action.resolved) g.contact.tryPass(a, a.action);
    },
  };
  sim.setBrain(a, defender);
  s.run(2, () => s.touches.length > 0);
  const e = s.touches[0]?.ev;
  const v = { ...state.v };
  const at = { ...state.p };
  // where it goes from there: how high above the contact it peaks, and whether it clears the net
  let top = state.p.y;
  let over = false;
  for (let i = 0; i < SIM.hz * 4 && e && !state.rest; i++) {
    const z0 = state.p.z;
    s.step();
    top = Math.max(top, state.p.y);
    if (z0 > 0 && state.p.z <= 0) {
      over = state.p.y > COURT.netHeightMen + BALL.radius && Math.abs(state.p.x) < COURT.halfWidth;
      break;
    }
    if (state.p.y <= BALL.radius + 0.01) break;
  }
  return { e, off: e ? Math.hypot(e.target.x - TARGET.x, e.target.z - TARGET.z) : NaN, vy: v.y, v, up: top - at.y, over };
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

/** where a diver's hands are `T` s into a dive along unit (dx, dz) from (0, 6), launched from a run at `run` m/s (PLAYER.dive*) */
function handsAt(T: number, dx: number, dz: number, run = 0): V3 {
  const v0 = Math.max(PLAYER.diveSpeed, run);
  const ts = Math.min(T, v0 / PLAYER.diveDecel);
  const p = Math.min(1, T / PLAYER.diveDown);
  const k = p * p * (3 - 2 * p);
  const along = v0 * ts - 0.5 * PLAYER.diveDecel * ts * ts + 0.45 + (PLAYER.diveArm - 0.45) * k;
  return { x: dx * along, y: H * 0.34 + (CONTACT.diveLow - H * 0.34) * k, z: 6 + dz * along };
}

const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
const spread = (xs: number[]) => Math.sqrt(mean(xs.map((x) => (x - mean(xs)) ** 2)));
/** a free ball over on our third contact: deep into their court */
const OVER = { x: 0, y: 0.5, z: -6.5, apex: 5.2 };

describe('a dive (PLAYER.dive*, CONTACT.diveOut)', () => {
  it('the reach these tests place the ball by is the reach the contact system gives a diving defender', () => {
    // (`ASSIST_PASS_REACH` is a copy of an inline number: when it moves, or gets a name, read it from there)
    expect(contactSource).toContain(
      `CONTACT.passRadius) + assist * ${ASSIST_PASS_REACH} + hard * CONTACT.digLunge + (diving ? CONTACT.diveOut.reach : 0);`,
    );
  });

  it('slides along the floor: from a sprint about 3 m on the chest, and the diver is up only once the slide has stopped', () => {
    const slide = (run: number) => {
      const a = new Athlete('L', 1);
      a.place(0, 6, 0);
      a.vel.set(0, 0, -run);
      a.dive(yawFromDir(0, -1));
      let t = 0;
      let stopped = -1;
      while (a.state === 'dive' && t < 5) {
        t += DT;
        a.step(DT, t);
        if (stopped < 0 && a.speed < 1e-3) stopped = t;
      }
      return { d: 6 - a.pos.z, down: t, stopped };
    };
    const sprint = slide(5);
    // a body sliding on a hardwood floor brakes at about 0.4 g
    expect(sprint.d).toBeGreaterThan(2.8);
    expect(sprint.d).toBeLessThan(3.6);
    expect(sprint.down).toBeGreaterThanOrEqual(sprint.stopped + PLAYER.diveGetUp - DT);
    // a longer slide keeps them down longer than a dive from a standstill
    const still = slide(0);
    expect(still.d).toBeGreaterThan(1.2);
    expect(sprint.down).toBeGreaterThan(still.down);
  });

  it('a ball on the middle of the arms goes up for a team-mate; one at full stretch barely gets up, and goes on the way the diver and the ball were going', () => {
    // a dive sideways (to our left, -x) at a roll shot coming down off the net
    const T = PLAYER.diveDown * 1.5;
    const hands = handsAt(T, -1, 0);
    const r = DIVE_REACH;
    const touch = (edge: number, seed: number) => {
      const to = { x: hands.x, y: hands.y, z: hands.z + edge * r };
      return play({
        from: { x: to.x + 0.5, y: 2.6, z: to.z - 2.5 },
        to,
        T,
        lead: 0,
        dive: true,
        diveAt: { x: -3, z: 6 },
        seed,
      });
    };
    const mid = Array.from({ length: 30 }, (_, i) => touch(0, i + 1));
    const rim = Array.from({ length: 30 }, (_, i) => touch(0.85, i + 1));
    for (const x of [...mid, ...rim]) expect(x.e?.form).toBe('dive');
    // (at full stretch is one arm out: past where both arms reach)
    expect(0.85 * r).toBeGreaterThan(CONTACT.passRadius);
    // in the middle of the arms: up high enough for a team-mate to get under it
    expect(mean(mid.map((x) => x.up))).toBeGreaterThan(1.5);
    // at full stretch: up, but barely
    for (const x of rim) expect(x.up).toBeGreaterThan(0.2);
    expect(mean(rim.map((x) => x.up))).toBeLessThan(1.2);
    // where it goes is the diver's run and the ball's bounce, not the aim (the setter is the other way, +x)
    expect(mean(rim.map((x) => x.v.x))).toBeLessThan(0);
    expect(mean(rim.map((x) => x.v.x))).toBeLessThan(mean(mid.map((x) => x.v.x)));
    // and no two go the same way
    const dir = (x: { v: V3 }) => Math.atan2(x.v.x, x.v.z);
    expect(spread(rim.map(dir))).toBeGreaterThan(spread(mid.map(dir)));
  });

  /** a sideways dive (to our left) meeting a roll shot `edge` of the way out on the arms, aimed at `target` */
  const diveAt = (edge: number, target?: { x: number; y: number; z: number; apex: number }) => {
    const T = PLAYER.diveDown * 1.5;
    const hands = handsAt(T, -1, 0);
    const to = { x: hands.x, y: hands.y, z: hands.z + edge * DIVE_REACH };
    return play({ from: { x: to.x + 0.5, y: 2.6, z: to.z - 2.5 }, to, T, lead: 0, dive: true, diveAt: { x: -3, z: 6 }, target });
  };

  it('reads Good only when the ball is mostly under control; a scrape that went where it went reads Late', () => {
    expect(diveAt(0).e.grade).toBe('Good');
    // (0.4 of the way out keeps about a third of it under control)
    expect(diveAt(0.4).e.grade).toBe('Late');
    expect(diveAt(0.85).e.grade).toBe('Late');
  });

  it('an AI dive is aimed no higher than a dive can send it: a clean one goes up as high as it was aimed (AI.diveUp, CONTACT.passPower.dive)', () => {
    const hands = handsAt(PLAYER.diveDown * 1.5, -1, 0);
    const high = AI.diveUp.apex[1];
    const x = diveAt(0, { x: hands.x + 1.5, y: 0.9, z: hands.z - 1.5, apex: hands.y + high });
    expect(x.up).toBeGreaterThan(high - 0.1);
  });
});

describe('getting it over on three (CONTACT.passPower, CONTACT.overControl)', () => {
  const tries = <R extends { over: boolean; e?: ContactEvent }>(f: (rand: () => number) => R) =>
    Array.from({ length: 20 }, (_, i) => {
      const rng = new Rng(i + 1);
      return f(() => rng.next());
    });
  const rate = (xs: { over: boolean; e?: ContactEvent }[]) => {
    for (const x of xs) expect(x.e).toBeDefined();
    return xs.filter((x) => x.over).length / xs.length;
  };

  it('a free ball on the platform from the back court goes over; dug from a dive there it does not', () => {
    const to = { x: 0, y: H * 0.34, z: 6 - 0.45 };
    const standing = tries((rand) =>
      play({ from: { x: 1, y: 3.6, z: 2 }, to, T: 1.0, lead: TIMING.passLead, target: OVER, third: true, rand }),
    );
    expect(rate(standing)).toBeGreaterThan(0.8);
    // a roll shot 6 m off the net dived for, off the floor: a dive can't put enough into it
    const T = PLAYER.diveDown * 1.5;
    const low = handsAt(T, -1, 0);
    const dived = tries((rand) =>
      play({
        from: { x: low.x + 0.5, y: 2.6, z: low.z - 2.5 },
        to: low,
        T,
        lead: 0,
        dive: true,
        diveAt: { x: -3, z: 6 },
        target: OVER,
        third: true,
        rand,
      }),
    );
    expect(rate(dived)).toBeLessThan(0.2);
  });

  it('a third ball coming in fast is hard to send over: it comes off the arms the way it bounces', () => {
    const to = { x: 0, y: H * 0.34, z: 6 - 0.45 };
    // a slow ball and a hard deflection flying across the court at the platform
    const slow = tries((rand) =>
      play({ from: { x: 1, y: 3.6, z: 2 }, to, T: 1.0, lead: TIMING.passLead, target: OVER, third: true, rand }),
    );
    const fast = tries((rand) =>
      play({ from: { x: 5, y: 1.4, z: 6.2 }, to, T: 0.27, lead: TIMING.digLead, target: OVER, third: true, rand }),
    );
    expect(rate(fast)).toBeLessThan(rate(slow) - 0.3);
  });

  it('a fast third ball already going toward the net (a team-mate shanked it on from behind) goes on up and toward the net, not into the floor', () => {
    // (about 20 m/s, nearly flat, from 4.5 m behind the defender)
    const to = { x: 0, y: H * 0.34, z: 6 - 0.45 };
    const behind = tries((rand) =>
      play({ from: { x: 0.3, y: 1.3, z: 10.5 }, to, T: 0.24, lead: TIMING.digLead, target: OVER, third: true, rand }),
    );
    // (a shank goes wherever it goes)
    const played = behind.filter((x) => x.e && x.e.note !== 'Shanked');
    expect(played.length).toBeGreaterThan(behind.length / 2);
    for (const x of played) {
      expect(x.v.y, 'up').toBeGreaterThan(0);
      expect(x.v.z, 'toward the net').toBeLessThan(0);
    }
  });

  it('a high ball coming down fast is no harder to send over: its speed is from its height, not a hard hit', () => {
    // a team-mate chased a shank far behind our end line and bumped it back high: it comes down
    // 6 m off the net from 10 m above the platform, still drifting toward the net
    const to = { x: 0, y: H * 0.34, z: 6 - 0.45 };
    const from = { x: 0.4, y: to.y + 10, z: to.z + 12 };
    const T = 1.54;
    const high = tries((rand) => play({ from, to, T, lead: TIMING.passLead, target: OVER, third: true, rand }));
    // (it comes down faster than `overControl.easy`, mostly falling)
    const b = makeBall();
    Object.assign(b.p, from);
    solveFixedTime(from, to, T, { x: 0, y: 0, z: 0 }, b.v);
    for (let t = 0; t < T - DT / 2; t += DT) stepBall(b, DT, { netTop: COURT.netHeightMen });
    expect(Math.hypot(b.v.x, b.v.y, b.v.z)).toBeGreaterThan(CONTACT.overControl.easy + 3);
    expect(-b.v.y).toBeGreaterThan(Math.hypot(b.v.x, b.v.z));
    expect(rate(high)).toBeGreaterThan(0.8);
  });
});

/**
 * A home blocker at the net jumps and puts the hands up; at the top of the jump their attack (side
 * -1) comes into the hands at `speed` m/s. Returns the block's contact and the ball's velocity off it.
 */
function blockAt(speed: number, opts: { at?: number; off?: number; user?: boolean } = {}) {
  // fixed dice: the block is graded on its timing and on where the ball meets the hands alone, with
  // the spread of the dice taken out
  const s = scene({ dice: { roll: 0.5 } });
  const { sim } = s;
  // (their hitter stands by the net; your spike is your seat's athlete's)
  const hitter = s.athlete('OH', -1, { x: opts.at ?? 0, z: -1 }, { user: opts.user });
  const a = s.athlete('MB', 1, { x: opts.at ?? 0, z: 0.45 });
  // the blocker's own brain, told only to block: it holds the hands to the ball (the contact system
  // is asked each step, before the bodies and the ball move), and the jump is this test's
  const hands = new BlockerBrain(a, a.pos.x);
  hands.active = false;
  sim.setBrain(a, hands);
  a.jumpPress();
  let act: ReturnType<Athlete['startAction']> | null = null;
  let fired = false;
  for (let i = 0; i < SIM.hz * 2 && !s.touches.length; i++) {
    if (a.state === 'load' && a.loadT >= PLAYER.loadMin) a.jumpRelease();
    s.step();
    if (a.state === 'air' && !act) act = a.startAction('block', sim.simTime);
    // at the top of the jump their attack arrives, a little down, into the middle of the hands
    if (act && !fired && a.vel.y <= 0) {
      fired = true;
      s.send(
        { from: { x: a.pos.x + (opts.off ?? 0), y: a.pos.y + a.standReach - 0.15, z: -0.25 }, v: { x: 0, y: -0.15 * speed, z: speed } },
        { athlete: hitter, kind: 'spike', side: -1 },
      );
    }
  }
  return { e: s.touches[0]?.ev, v: { ...sim.ball.vel } };
}

describe('the ball off the block', () => {
  it("a soft ball into a good block comes back to the hitter's side, slow: their cover can play it again", () => {
    const soft = blockAt(9);
    expect(soft.e?.kind).toBe('block');
    expect(soft.e.grade === 'Perfect' || soft.e.grade === 'Good').toBe(true);
    expect(soft.e.note).toBe('Off the block');
    // back towards their side (-z), slow
    expect(soft.v.z).toBeLessThan(0);
    expect(Math.hypot(soft.v.x, soft.v.y, soft.v.z)).toBeLessThan(6);
    // a hard spike into the same block is not handed back like that: it is driven down
    const hard = blockAt(22);
    expect(hard.e?.kind).toBe('block');
    expect(hard.e.note).not.toBe('Off the block');
    expect(hard.v.y).toBeLessThan(soft.v.y - 2);
  });

  it("your spike off the outside of an AI block's hands gets off it more often than an AI hitter's: stuffed less, off it more (playability)", () => {
    // an AI blocker at the pin; across its outside hand and past it, a ball at each spot
    const tally = (user: boolean) => {
      const n = { stuffed: 0, off: 0 };
      for (let off = 0; off <= CONTACT.blockHalfWidth + 0.1 + 1e-9; off += 0.02) {
        const note = blockAt(22, { at: 3, off, user }).e?.note;
        if (note === 'Stuff!') n.stuffed++;
        // off the hands and out, or on into their court
        if (note === 'Tooled' || note === 'Soft block') n.off++;
      }
      return n;
    };
    const yours = tally(true);
    const theirs = tally(false);
    expect(yours.stuffed).toBeLessThan(theirs.stuffed);
    expect(yours.off).toBeGreaterThan(theirs.off);
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
    const cs = scene().sim.contact;
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
