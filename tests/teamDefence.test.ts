import { describe, expect, it } from 'vitest';
import { AI, COURT, SIM } from '../src/config';
import { Rng } from '../src/core/mathx';
import { Athlete } from '../src/game/athlete';
import type { Touch, TouchKind } from '../src/game/ballEntity';
import type { Game } from '../src/game/game';
import { MiniRally } from '../src/game/modes/miniRally';
import { laneFor, SETTER_SPOT } from '../src/game/plays';
import { makeBall, stepBall, type BallEnv, type V3 } from '../src/physics/ball';
import { BallPredictor } from '../src/physics/predict';
import { solveApex } from '../src/physics/solve';
import { SetterBrain } from '../src/ai/setter';
import { SLOT_ROLE, SLOTS, TeamAI, type Slot } from '../src/ai/team';

const DT = 1 / SIM.hz;
const NO_SPIN: V3 = { x: 0, y: 0, z: 0 };
const D = AI.defence;
const W = COURT.halfWidth;

/**
 * An all-AI home team (+z) on a stand-in for the Game: the ball (state and prediction), the clock,
 * the rng, and contacts that never happen. Every tick the players step, then the coordinator,
 * as in the game.
 */
function homeTeam() {
  const state = makeBall();
  const predictor = new BallPredictor(DT, SIM.predictHorizon);
  const env: BallEnv = { netTop: COURT.netHeightMen };
  let version = 0;
  let predicted = -1;
  const ball = {
    state,
    active: true,
    lastTouch: null as Touch | null,
    get pos() {
      return state.p;
    },
    get vel() {
      return state.v;
    },
    speed: () => Math.hypot(state.v.x, state.v.y, state.v.z),
    hit(v: V3) {
      Object.assign(state.v, v);
      version++;
    },
    ensurePrediction(e: BallEnv, t: number) {
      if (predicted !== version) {
        predictor.compute(state, e, t);
        predicted = version;
      }
      return predictor;
    },
  };
  const g = {
    simTime: 0,
    env,
    rng: new Rng(3),
    athletes: [] as Athlete[],
    ballLive: true,
    ball,
    setBrain() {},
    onAiContact() {},
    hud: { message() {} },
    contact: { lastSet: null, tryPass: () => false, tryBlock: () => false },
  };
  const game = g as unknown as Game;
  const team = new TeamAI(1, game);
  for (const slot of SLOTS) team.add(slot, new Athlete(SLOT_ROLE[slot], 1), false);
  team.place('defense');
  const theirs = new Athlete('OH', -1);
  /** a touch: the ball leaves `from` for `to` with this apex */
  const touch = (kind: TouchKind, side: 1 | -1, from: V3, to: V3, apex: number, athlete: Athlete | null = theirs) => {
    const v = { x: 0, y: 0, z: 0 };
    solveApex(from, to, apex, NO_SPIN, v);
    Object.assign(state.p, from);
    Object.assign(state.v, v);
    state.rest = false;
    version++;
    ball.lastTouch = { athlete, kind, t: g.simTime, side };
  };
  /** the ball at `p` moving at `v`, just played by `athlete` */
  const put = (p: V3, v: V3, athlete: Athlete | null, kind: TouchKind = 'pass', side: 1 | -1 = 1) => {
    Object.assign(state.p, p);
    Object.assign(state.v, v);
    state.rest = false;
    version++;
    ball.lastTouch = { athlete, kind, t: g.simTime, side };
  };
  /** a hard spike from `from` straight at `to` (ball centre on the floor) at `speed` m/s */
  const spike = (from: V3, to: V3, speed: number) => {
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const flat = Math.hypot(dx, dz);
    const t = flat / speed;
    const vy = (to.y - from.y + 0.5 * 9.81 * t * t) / t;
    Object.assign(state.p, from);
    Object.assign(state.v, { x: dx / t, y: vy, z: dz / t });
    state.rest = false;
    version++;
    ball.lastTouch = { athlete: theirs, kind: 'spike', t: g.simTime, side: -1 };
  };
  const run = (seconds: number, each?: () => void) => {
    for (let i = 0; i < seconds * SIM.hz; i++) {
      g.simTime += DT;
      stepBall(state, DT, env, []);
      for (const b of team.brains.values()) b.step(DT, game);
      for (const a of team.players.values()) a.step(DT, g.simTime);
      team.step();
      each?.();
    }
  };
  const brain = (slot: Slot) => team.brains.get(team.players.get(slot)!)!;
  return { g, team, ball, touch, put, spike, run, brain, theirs };
}

/** their setter sets their outside high (our right) */
function setOutside(t: ReturnType<typeof homeTeam>) {
  const lane = laneFor('OH', -1);
  t.touch('set', -1, { x: -SETTER_SPOT.x, y: 2.6, z: -SETTER_SPOT.z }, { x: lane.x, y: 3.25, z: lane.z }, 3.25 + lane.apexAbove);
}

describe('the defence reads their set (Mini Rally, perimeter)', () => {
  it('a defender holds its base until it has read the set, then reads to its spot', () => {
    const t = homeTeam();
    setOutside(t);
    t.run(0.1);
    const S = t.brain('S');
    expect(S.job).toBe('base');
    expect(S.spot).toEqual(t.team.formSpot('defense', 'S'));
    expect(t.brain('OH1').job).toBe('block');
    t.run(0.6);
    // the setter at right back digs the line; the libero at left back digs cross; the back-row outside plays middle back
    expect(S.spot.x).toBeCloseTo(W - D.lineIn, 1);
    expect(S.spot.z).toBeCloseTo(D.digDepth, 1);
    expect(t.brain('L').spot.x).toBeLessThan(0);
    expect(t.brain('L').spot.z).toBeCloseTo(D.digDepth, 1);
    expect(t.brain('OH2').spot.z).toBeCloseTo(D.middleBack, 1);
    // the off-blocker leaves the net; the pin blocker stays to block
    expect(t.brain('OH1').job).toBe('base');
    expect(t.brain('OH1').spot.x).toBeCloseTo(-(W - D.offIn), 1);
    expect(t.brain('OH1').spot.z).toBeCloseTo(D.offOff, 1);
    expect(t.brain('OPP').job).toBe('block');
  });

  it('the defenders are on their way before the hit: the setter is most of the way to the line', () => {
    const t = homeTeam();
    const S = t.team.players.get('S')!;
    const startX = S.pos.x;
    setOutside(t);
    t.run(1.1);
    const target = W - D.lineIn;
    expect((S.pos.x - startX) / (target - startX)).toBeGreaterThan(0.6);
  });

  it('after the hit the defenders stay where they read to: nobody runs back to base', () => {
    const t = homeTeam();
    setOutside(t);
    t.run(1.1);
    const lane = laneFor('OH', -1);
    t.spike({ x: lane.x, y: 3.25, z: lane.z }, { x: -2.6, y: 0.1, z: 6.5 }, 22);
    t.run(0.2);
    const S = t.brain('S');
    expect(S.job).toBe('base');
    expect(S.spot.x).toBeCloseTo(W - D.lineIn, 1);
    expect(S.spot.z).toBeCloseTo(D.digDepth, 1);
  });

  it('a hard hit is chased only a reaction time after it', () => {
    const t = homeTeam();
    setOutside(t);
    t.run(1.1);
    const lane = laneFor('OH', -1);
    t.spike({ x: lane.x, y: 3.25, z: lane.z }, { x: -1.0, y: 0.1, z: 7.0 }, 20);
    const hitT = t.g.simTime;
    // the moment the digger steers for the ball, or dives for it (it may still be moving from its read when the hit comes)
    let steers = -1;
    let receiver: Athlete | null = null;
    let ticksSince = 0;
    t.run(0.6, () => {
      // (the players step before the coordinator picks the digger: judge from the tick after)
      if (receiver) ticksSince++;
      receiver ??= t.team.receiver;
      if (
        receiver &&
        ticksSince > 0 &&
        steers < 0 &&
        (Math.hypot(receiver.cmd.moveX, receiver.cmd.moveZ) > 0.05 || receiver.state === 'dive')
      )
        steers = t.g.simTime - hitT;
    });
    expect(receiver).not.toBeNull();
    expect(steers).toBeGreaterThan(D.hitReact - 3 * D.hitReactSd);
    expect(steers).toBeLessThan(D.hitReact + 0.2);
  });
});

describe('going for every ball (Mini Rally)', () => {
  it('a ball off our own block flying out over our side is still chased: out, it is their point', () => {
    const t = homeTeam();
    const mb = t.team.players.get('MB')!;
    // off the block's outside hand, wide of our sideline
    t.touch('block', 1, { x: 3.6, y: 3.0, z: 0.3 }, { x: W + 2.0, y: 0, z: 5.0 }, 4.2, mb);
    t.run(0.4);
    const r = t.team.receiver;
    expect(r).not.toBeNull();
    expect(r).not.toBe(mb);
    expect(t.team.brains.get(r!)!.job).toBe('receive');
  });

  it('a ball out of reach on foot: the defender sent runs at it and dives for it, and a team-mate runs with them, to where the dive pops it up (toward the middle)', () => {
    const t = homeTeam();
    setOutside(t);
    t.run(1.1);
    const lane = laneFor('OH', -1);
    // a roll shot over the block, dropping short into the open court 3.3 m from the cross digger, 1 s after the hit
    const L = t.team.players.get('L')!;
    const to = { x: L.pos.x + 3.3 * Math.sin(1.2), y: 0.1, z: L.pos.z - 3.3 * Math.cos(1.2) };
    t.touch('spike', -1, { x: lane.x, y: 3.25, z: lane.z }, to, 3.4);
    let dived: Athlete | null = null;
    let sentWhenDived: Athlete | null = null;
    let two = 0;
    let towardMiddle = false;
    const mid = { x: 0, z: COURT.halfLength / 2 };
    const fromMid = (q: { x: number; z: number }) => Math.hypot(q.x - mid.x, q.z - mid.z);
    t.run(1.0, () => {
      const r = t.team.receiver;
      if (!dived) {
        dived = [...t.team.players.values()].find((a) => a.state === 'dive') ?? null;
        sentWhenDived = r;
      }
      if (!r) return;
      const runners = [...t.team.brains.values()].filter(
        (b) => b.athlete !== r && b.job === 'base' && Math.hypot(b.spot.x - to.x, b.spot.z - to.z) < 1.5,
      );
      two = Math.max(two, runners.length);
      if (runners.some((b) => fromMid(b.spot) < fromMid(to) - 0.5)) towardMiddle = true;
    });
    expect(dived).not.toBeNull();
    expect(dived).toBe(sentWhenDived);
    expect(two).toBeGreaterThan(0);
    expect(towardMiddle).toBe(true);
  });
});

describe('who takes the ball (Mini Rally)', () => {
  /** our receive formation (or defence), `user` marked as the user, and their serve (or roll shot) down at `to` */
  const ballAt = (to: { x: number; z: number }, user: Slot | null, serve = true) => {
    const t = homeTeam();
    t.team.place(serve ? 'receive' : 'defense');
    if (user) t.team.players.get(user)!.isUser = true;
    if (serve) t.touch('serve', -1, { x: 0, y: 2.8, z: -10 }, { x: to.x, y: 0.75, z: to.z }, 4.0);
    else t.touch('spike', -1, { x: -4.0, y: 3.25, z: -0.9 }, { x: to.x, y: 0.75, z: to.z }, 3.6);
    t.run(0.05);
    return t;
  };

  it('a serve that drops next to the middle passer is theirs, even when you are the libero beside them', () => {
    // 0.6 m from the back-row outside, 1.9 m from the libero
    const t = ballAt({ x: 0.6, z: 6.4 }, 'L');
    expect(t.team.receiver).toBe(t.team.players.get('OH2'));
  });

  it("a serve in the seam between two passers is the libero's", () => {
    const t = ballAt({ x: 1.25, z: 6.35 }, null);
    expect(t.team.receiver).toBe(t.team.players.get('L'));
  });

  it("a roll shot dropping a metre from the deep defender is theirs, not the libero's 2.6 m away, even when you are the libero", () => {
    const t = ballAt({ x: -0.9, z: 8.3 }, 'L', false);
    expect(t.team.receiver).toBe(t.team.players.get('OH2'));
  });

  /** their block sends our attack back down at (-1.8, 3.0); you (our outside) 0.6 m from it, the libero at `L` */
  const offTheirBlock = (L: { x: number; z: number }) => {
    const t = homeTeam();
    t.team.place('defense');
    const you = t.team.players.get('OH1')!;
    you.isUser = true;
    you.place(-1.9, 2.4, 0);
    t.team.players.get('L')!.place(L.x, L.z, 0);
    t.touch('block', -1, { x: -1.5, y: 3.0, z: -0.2 }, { x: -1.8, y: 0.75, z: 3.0 }, 3.6);
    t.run(0.05);
    return { t, you, L: t.team.players.get('L')! };
  };

  it("a ball off their block that the libero, covering, gets to is the libero's, even with you nearer", () => {
    const { t, L } = offTheirBlock({ x: -0.6, z: 3.6 });
    expect(t.team.receiver).toBe(L);
  });

  it('the libero coming in to a ball off the block someone else was sent to calls it and takes it', () => {
    const { t, you, L } = offTheirBlock({ x: 2.5, z: 7.5 });
    expect(t.team.receiver).toBe(you);
    L.place(-0.6, 3.6, 0);
    t.run(0.05);
    expect(t.team.receiver).toBe(L);
  });
});

describe('the second ball (Mini Rally)', () => {
  it('our pass going over the net: the setter reads the overpass, stays, calls nothing; the front row waits at the net', () => {
    const t = homeTeam();
    t.team.place('offense');
    const L = t.team.players.get('L')!;
    // the libero's pass sails over the net, coming down 3 m into their court
    t.touch('pass', 1, { x: L.pos.x, y: 0.8, z: L.pos.z }, { x: 0.5, y: 0.5, z: -3 }, 4.6, L);
    t.run(AI.setterRead + 0.2);
    expect(t.team.overpass(t.g as unknown as Game)).toBe(true);
    expect(t.brain('S').job).not.toBe('set');
    expect(t.team.read).toBeNull();
    for (const slot of ['OH1', 'MB', 'OPP'] as const) expect(t.brain(slot).job).toBe('block');
  });

  it('the same pass to the setter is set as usual', () => {
    const t = homeTeam();
    t.team.place('offense');
    const L = t.team.players.get('L')!;
    t.touch('pass', 1, { x: L.pos.x, y: 0.8, z: L.pos.z }, { x: SETTER_SPOT.x, y: 2.4, z: SETTER_SPOT.z }, 4.6, L);
    t.run(AI.setterRead + 0.2);
    expect(t.team.overpass(t.g as unknown as Game)).toBe(false);
    expect(t.brain('S').job).toBe('set');
  });

  it('a pass the setter calls HELP on, nearest to you: it is your ball (someone always plays it)', () => {
    const t = homeTeam();
    t.team.place('offense');
    const L = t.team.players.get('L')!;
    const you = t.team.players.get('OH2')!;
    you.isUser = true;
    you.place(-3.4, 8.0, 0);
    // a shanked pass, deep into our left corner: the setter at the net can't get there
    t.touch('pass', 1, { x: L.pos.x, y: 0.8, z: L.pos.z }, { x: -3.8, y: 0.75, z: 8.2 }, 5.5, L);
    t.run(AI.setterRead + 0.2);
    expect(t.team.read?.call).toBe('help');
    expect(t.team.freeBall(t.g as unknown as Game)).toBe(you);
  });

  /** a pass from the back-row outside the setter (away right, at the net) can't get to, down at `to` */
  const helpBall = (to: { x: number; z: number }, apex: number) => {
    const t = homeTeam();
    t.team.place('offense');
    const oh2 = t.team.players.get('OH2')!;
    t.team.players.get('S')!.place(4.0, 0.8, 0);
    t.touch('pass', 1, { x: oh2.pos.x, y: 0.8, z: oh2.pos.z }, { x: to.x, y: 0.75, z: to.z }, apex, oh2);
    t.run(AI.setterRead + 0.2);
    return { t, L: t.team.players.get('L')! };
  };

  it('a pass the setter calls HELP on that the libero gets to a few metres off the net: the libero sets it, a high ball to a pin', () => {
    const { t, L } = helpBall({ x: -2.6, z: 4.0 }, 3.6);
    expect(t.team.read?.call).toBe('help');
    expect(t.brain('L').job).toBe('set');
    expect(t.team.secondBy).toBe(L);
    expect(t.team.freeBall(t.g as unknown as Game)).toBeNull();
  });

  it("a shanked pass the libero runs down by the end line is too hard to set: it doesn't try, it bumps it up high", () => {
    const { t, L } = helpBall({ x: -2.6, z: 8.3 }, 3.6);
    expect(t.team.read?.call).toBe('help');
    expect(t.brain('L').job).toBe('free');
    expect(t.team.freeBall(t.g as unknown as Game)).toBe(L);
  });

  it('a second ball nobody could set goes up high to the 3 m line, not to the net, for a free ball over from there', () => {
    const t = homeTeam();
    const you = t.team.players.get('OH2')!;
    t.team.touches = 1;
    const T = MiniRally.prototype.passTarget.call({ home: t.team, away: t.team, g: t.g }, you);
    expect(T.z).toBeGreaterThan(3);
    expect(T.z).toBeLessThan(4);
    expect(Math.abs(T.x)).toBeLessThan(1.5);
    expect(T.apex).toBeGreaterThan(5);
  });

  it("an AI free ball over goes where they aren't: short over the net when they are deep, to a deep corner when they are up", () => {
    const t = homeTeam();
    const mate = t.team.players.get('OH1')!;
    t.team.touches = 2;
    const target = () => MiniRally.prototype.passTarget.call({ home: t.team, away: t.team, g: t.g }, mate);
    const xs = [-3, -1.5, 0, 1.5, 3];
    const them = xs.map(() => new Athlete('OH', -1));
    t.g.athletes.push(...them);
    // all of them back, deep in their court
    them.forEach((a, i) => a.place(xs[i], -7.5, 0));
    for (let i = 0; i < 5; i++) {
      const T = target();
      expect(T.z).toBeGreaterThan(-3);
      expect(T.z).toBeLessThan(0);
    }
    // all of them up at the net
    them.forEach((a, i) => a.place(xs[i], -1.0, 0));
    for (let i = 0; i < 5; i++) {
      const T = target();
      expect(T.z).toBeLessThan(-6.5);
      expect(Math.abs(T.x)).toBeGreaterThan(2);
    }
  });
});

describe('a hard ball is played as well as it can be, and no better (Mini Rally)', () => {
  const avg = (m: number[]) => m.reduce((a, b) => a + b, 0) / m.length;
  /**
   * `n` sets by the libero from behind the 3 m line to the outside's pin, `sloppy` as hard as the
   * ball made it: how far each passes from where it was meant to meet the hitter's hand
   */
  const liberoSets = (sloppy: number, toUser: boolean, n = 30) => {
    const t = homeTeam();
    const L = t.team.players.get('L')!;
    const hitter = t.team.players.get('OH1')!;
    hitter.isUser = toUser;
    const sb = new SetterBrain(L, { x: 0, z: 4 }, Math.PI / 2);
    sb.sloppy = sloppy;
    const lane = laneFor('OH', 1);
    const target = { x: lane.x, y: 3.25, z: lane.z };
    sb.call = () => ({ target, apex: target.y + lane.apexAbove, hitter });
    const misses: number[] = [];
    for (let i = 0; i < n; i++) {
      L.place(0, 4);
      // the ball drops onto the libero's hands
      t.put({ x: -0.14, y: L.height + 0.22, z: 4 }, { x: 0, y: -2, z: 0 }, t.team.players.get('OH2')!);
      sb.step(DT, t.g as unknown as Game);
      expect(t.ball.lastTouch?.athlete).toBe(L);
      // where the set comes down through the hitter's contact height
      const b = makeBall();
      Object.assign(b.p, t.ball.state.p);
      Object.assign(b.v, t.ball.state.v);
      for (let k = 0; k < 4 * SIM.hz && !(b.v.y < 0 && b.p.y < target.y); k++) stepBall(b, DT, t.g.env, []);
      misses.push(Math.hypot(b.p.x - target.x, b.p.z - target.z));
    }
    return misses;
  };

  it("the libero's set off a hard ball misses its hitter: a hard ball can't be set perfectly", () => {
    expect(avg(liberoSets(0, false))).toBeLessThan(0.2);
    expect(avg(liberoSets(1, false))).toBeGreaterThan(0.6);
  });

  it('a set to the user is always clean, however hard the ball was', () => {
    const toYou = liberoSets(1, true);
    expect(toYou).toEqual(liberoSets(0, true));
    expect(avg(toYou)).toBeLessThan(0.2);
  });

  it('an AI dive keeps the ball alive and no more: it pops up a couple of metres toward the middle, not to the setter; your own dive still passes to the setter', () => {
    const t = homeTeam();
    const L = t.team.players.get('L')!;
    const at = { x: 4, y: 0.35, z: 8 };
    t.put(at, { x: 2, y: -4, z: 3 }, t.theirs, 'spike', -1);
    L.state = 'dive';
    const target = () => MiniRally.prototype.passTarget.call({ home: t.team, away: t.team, g: t.g }, L);
    const T = target();
    const fromMid = (q: { x: number; z: number }) => Math.hypot(q.x, q.z - COURT.halfLength / 2);
    expect(Math.hypot(T.x - at.x, T.z - at.z)).toBeCloseTo(AI.diveUp.carry, 5);
    expect(fromMid(T)).toBeCloseTo(fromMid(at) - AI.diveUp.carry, 5);
    expect(T.apex).toBeCloseTo(at.y + AI.diveUp.apex, 5);
    L.isUser = true;
    const yours = target();
    expect(yours.apex).toBeGreaterThan(T.apex + 1);
    expect(Math.abs(yours.z)).toBeLessThan(2.5);
  });

  it('a setter who gets there after the ball has dropped below their hands digs it up (platform or dive) instead of watching it drop', () => {
    const t = homeTeam();
    const S = t.team.players.get('S')!;
    const b = t.brain('S');
    S.place(2, 2.5, 0);
    // a pass that got away: 1.5 m beside the setter, already under the hands, going away
    t.put({ x: 3.5, y: S.height - 0.1, z: 2.5 }, { x: 1.2, y: 0, z: 0 }, t.team.players.get('OH2')!);
    // (seen a while ago)
    t.ball.lastTouch!.t -= 1;
    b.job = 'set';
    let dug = false;
    for (let i = 0; i < 0.6 * SIM.hz && !dug; i++) {
      t.g.simTime += DT;
      stepBall(t.ball.state, DT, t.g.env, []);
      b.step(DT, t.g as unknown as Game);
      S.step(DT, t.g.simTime);
      dug = S.action?.kind === 'pass' || S.state === 'dive';
    }
    expect(dug).toBe(true);
  });
});

describe('early transition (Mini Rally)', () => {
  it('on their free ball the setter releases to the net and the front row leaves the net to approach', () => {
    const t = homeTeam();
    t.touch('pass', -1, { x: 0, y: 1.0, z: -5 }, { x: -1.5, y: 0.8, z: 5.5 }, 5.5);
    t.run(0.1 + AI.transition.read);
    const S = t.brain('S');
    expect(S.job).toBe('base');
    const target = t.team.formSpot('offense', 'S');
    expect(S.spot).toEqual(target);
    for (const slot of ['OH1', 'MB', 'OPP'] as const) expect(t.brain(slot).job, slot).toBe('attack');
  });

  it('on a soft block the passer can get to easily, the setter releases; on a hard hit the setter releases and the front row leaves the net once it reads the hit', () => {
    const t = homeTeam();
    const mb = t.team.players.get('MB')!;
    // a soft block pops the ball up and back into our court
    t.touch('block', 1, { x: 0.3, y: 2.7, z: 0.3 }, { x: -1.5, y: 0.8, z: 5.0 }, 4.3, mb);
    t.run(0.1 + AI.transition.read);
    expect(t.brain('S').spot).toEqual(t.team.formSpot('offense', 'S'));

    const h = homeTeam();
    setOutside(h);
    h.run(1.1);
    const lane = laneFor('OH', -1);
    h.spike({ x: lane.x, y: 3.25, z: lane.z }, { x: -1.5, y: 0.1, z: 5.5 }, 22);
    h.run(D.hitReact - 3 * D.hitReactSd - 0.02);
    // nobody can leave before they have seen the hit
    for (const slot of ['OH1', 'MB', 'OPP'] as const) expect(h.brain(slot).job, slot).not.toBe('attack');
    h.run(6 * D.hitReactSd + 0.1);
    // the setter releases even on a hard hit (it reads the dig isn't its own)
    expect(h.brain('S').spot).toEqual(h.team.formSpot('offense', 'S'));
    // and the front row transitions off the net to approach (a blocker still in the air: as it lands)
    for (const slot of ['OH1', 'MB', 'OPP'] as const) {
      if (h.team.players.get(slot)!.airborne) continue;
      expect(h.brain(slot).job, slot).toBe('attack');
      expect(h.brain(slot).spot, slot).toEqual(h.team.formSpot('offense', slot));
    }
  });
});

describe('the front row transitions after every block (Mini Rally)', () => {
  it('blockers back on the floor after their hit got by leave the net for their approach starts', () => {
    const t = homeTeam();
    const front = ['OH1', 'MB', 'OPP'] as const;
    for (const slot of front) t.team.players.get(slot)!.place(t.team.formSpot('defense', slot).x, 0.7, 0);
    // their hit off our block's hands, dropping deep into our court
    const mb = t.team.players.get('MB')!;
    t.touch('block', 1, { x: 0.3, y: 3.0, z: 0.3 }, { x: 1.5, y: 0.1, z: 7.5 }, 3.4, mb);
    t.run(1.2);
    for (const slot of front) {
      const a = t.team.players.get(slot)!;
      if (a === t.team.receiver) continue;
      expect(t.brain(slot).job, slot).toBe('attack');
      // off the net, on the way to (or at) the approach start
      expect(Math.abs(a.pos.z), slot).toBeGreaterThan(1.8);
    }
  });

  it('a ball our block sends back over: the blockers stay at the net to block again', () => {
    const t = homeTeam();
    const front = ['OH1', 'MB', 'OPP'] as const;
    for (const slot of front) t.team.players.get(slot)!.place(t.team.formSpot('defense', slot).x, 0.7, 0);
    const mb = t.team.players.get('MB')!;
    t.touch('block', 1, { x: 0.3, y: 3.0, z: 0.1 }, { x: 0.5, y: 0.1, z: -4.0 }, 3.3, mb);
    t.run(0.8);
    for (const slot of front) {
      expect(t.brain(slot).job, slot).not.toBe('attack');
      expect(Math.abs(t.team.players.get(slot)!.pos.z), slot).toBeLessThan(1.2);
    }
  });

  it('a middle still at the net when the dig goes up backs off it before running the quick: no standing quick', () => {
    const t = homeTeam();
    const mb = t.team.players.get('MB')!;
    const L = t.team.players.get('L')!;
    mb.place(0, 0.7, 0);
    // our libero digs it high to the setter's spot: about 1.3 s in the air
    const at = { x: SETTER_SPOT.x, y: 2.4, z: SETTER_SPOT.z };
    t.touch('dig', 1, { x: L.pos.x, y: 0.7, z: L.pos.z }, at, 5.2, L);
    const hb = t.brain('MB').hitter!;
    let maxOff = 0;
    let started = -1;
    t.run(1.6, () => {
      if (hb.phase === 'ready') maxOff = Math.max(maxOff, Math.abs(mb.pos.z));
      if (started < 0 && hb.phase === 'approach' && mb.speed > 0.5) started = Math.abs(mb.pos.z);
      // (the harness has no contacts: stop before the jump)
      if (hb.phase === 'air') hb.enabled = false;
    });
    expect(maxOff).toBeGreaterThanOrEqual(AI.transition.approachOff);
    expect(started).toBeGreaterThan(AI.transition.approachOff - 0.3);
  });
});

describe('covering our hitter (Mini Rally)', () => {
  /** our pass, then the setter's high ball to `slot`; run until the cover is set up */
  const setTo = (slot: 'OH1' | 'OPP') => {
    const t = homeTeam();
    t.team.place('offense');
    // (the harness has no contacts: the hitters don't run their approaches here)
    for (const b of t.team.brains.values()) if (b.hitter) b.hitter.enabled = false;
    const S = t.team.players.get('S')!;
    const hitter = t.team.players.get(slot)!;
    const lane = laneFor(slot === 'OH1' ? 'OH' : 'OPP', 1);
    t.touch('pass', 1, { x: 0, y: 1, z: 6 }, { x: SETTER_SPOT.x, y: 2.4, z: SETTER_SPOT.z }, 4.5, t.team.players.get('L')!);
    t.run(0.05);
    t.touch('set', 1, { x: S.pos.x, y: 2.5, z: S.pos.z }, { x: lane.x, y: 3.25, z: lane.z }, 3.25 + lane.apexAbove, S);
    t.team.onSet(hitter);
    t.run(AI.cover.read - 0.04);
    // nobody covers before they have seen the set go
    expect([...t.team.brains.values()].filter((b) => b.job === 'cover')).toHaveLength(0);
    t.run(0.45);
    const covers = [...t.team.brains.values()].filter((b) => b.job === 'cover');
    expect(covers).toHaveLength(5);
    expect(covers.map((b) => b.athlete)).not.toContain(hitter);
    // everyone on the way there, and nobody in front of the middle at the net
    for (const b of covers) {
      expect(b.spot.z).toBeGreaterThanOrEqual(AI.cover.net - 0.01);
      const a = b.athlete;
      expect(Math.hypot(a.pos.x - b.spot.x, a.pos.z - b.spot.z) < 0.4 || a.speed > 1, t.team.slotOf(a)).toBe(true);
    }
    const spot = (s: Slot) => {
      expect(t.brain(s).job, s).toBe('cover');
      return t.brain(s).spot;
    };
    return { t, lane, spot };
  };

  it('on a set to the outside: the middle at the net inside the hitter, the setter on the 3 m line, the left back behind on the sideline, two deep', () => {
    const { lane, spot } = setTo('OH1');
    const mb = spot('MB');
    const s = spot('S');
    const l = spot('L');
    expect(mb.z).toBeLessThan(1.5);
    expect(mb.x).toBeGreaterThan(lane.x + 1);
    expect(s.z).toBeCloseTo(3, 0);
    expect(s.x).toBeGreaterThan(lane.x);
    expect(s.x).toBeLessThan(mb.x);
    expect(l.x).toBeLessThan(-COURT.halfWidth + 1.2);
    expect(l.z).toBeGreaterThan(2.5);
    expect(l.z).toBeLessThan(4.5);
    // the middle back down the line, the opposite cross court
    expect(spot('OH2').z).toBeGreaterThan(5.5);
    expect(spot('OPP').z).toBeGreaterThan(5.5);
    expect(spot('OH2').x).toBeLessThan(spot('OPP').x);
  });

  it('on a set to the opposite, the middle back comes over behind the hitter (the setter has left right back)', () => {
    const { lane, spot } = setTo('OPP');
    expect(spot('MB').x).toBeLessThan(lane.x - 1);
    expect(spot('S').z).toBeCloseTo(3, 0);
    const mbk = spot('OH2');
    expect(mbk.x).toBeGreaterThan(COURT.halfWidth - 1.2);
    expect(mbk.z).toBeGreaterThan(2.5);
    expect(mbk.z).toBeLessThan(4.5);
  });
});

describe('the back-row setter releases after their attack (Mini Rally)', () => {
  it('on their hard spike at our libero, the back-row setter is running to the net before the dig', () => {
    const t = homeTeam();
    const S = t.brain('S');
    const target = t.team.formSpot('offense', 'S');
    // a hard spike down the line at the libero (left back)
    t.spike({ x: -4.0, y: 3.25, z: -0.9 }, { x: -2.9, y: 0.1, z: 6.2 }, 22);
    t.run(0.05);
    expect(t.team.receiver).toBe(t.team.players.get('L'));
    // just before the release delay the setter is still defending
    t.run(D.hitReact - 3 * D.hitReactSd - 0.07);
    expect(S.spot).not.toEqual(target);
    // after the delay it releases to the net, while the ball is still unplayed
    t.run(6 * D.hitReactSd + 0.07);
    expect(S.job).toBe('base');
    expect(S.spot).toEqual(target);
    expect(t.g.ball.lastTouch?.kind).toBe('spike');
  });

  it('the release comes a reaction time after their hit, not on the hit', () => {
    const t = homeTeam();
    const S = t.brain('S');
    const target = t.team.formSpot('offense', 'S');
    t.spike({ x: -4.0, y: 3.25, z: -0.9 }, { x: -2.9, y: 0.1, z: 6.2 }, 22);
    t.run(D.hitReact - 3 * D.hitReactSd - 0.02);
    expect(S.spot).not.toEqual(target);
    t.run(6 * D.hitReactSd + 0.04);
    expect(S.spot).toEqual(target);
  });

  it('on their hard spike at the setter, the setter stays and digs', () => {
    const t = homeTeam();
    const S = t.brain('S');
    const target = t.team.formSpot('offense', 'S');
    t.spike({ x: 3.0, y: 3.25, z: -0.5 }, { x: 2.8, y: 0.1, z: 6.2 }, 22);
    t.run(0.05);
    expect(t.team.receiver).toBe(t.team.players.get('S'));
    t.run(D.hitReact + 3 * D.hitReactSd + 0.1);
    expect(S.job).toBe('receive');
    expect(S.spot).not.toEqual(target);
  });
});

describe('the middle back reads our block as it goes up (Mini Rally)', () => {
  /** their outside set to our right; from `upAt` s our pin blocker (OPP) and middle are held in the air at these x (hands: `reach`) */
  function blockUp(midX: number, reach = 0, upAt = 0.6) {
    const t = homeTeam();
    const pin = t.team.players.get('OPP')!;
    const mid = t.team.players.get('MB')!;
    const pinX = 3.5;
    let up = -1;
    setOutside(t);
    const hold = () => {
      if (t.g.simTime < upAt) return;
      if (up < 0) up = t.g.simTime;
      for (const [a, x, r] of [
        [pin, pinX, 0],
        [mid, midX, reach],
      ] as const) {
        a.state = 'air';
        a.pos.x = x;
        a.pos.y = 0.8;
        a.reachX = r;
      }
    };
    return { t, pinX, hold, upAt: () => up };
  }

  it('a late middle leaves a seam: the middle back steps up onto it before their hitter swings, a reaction time after the block goes up', () => {
    const { t, pinX, hold, upAt } = blockUp(3.5 - 1.2);
    const OH2 = t.brain('OH2');
    t.run(0.6 + D.react - 3 * D.reactSd - 0.02, hold);
    expect(upAt()).toBeGreaterThan(0);
    expect(OH2.spot.z).toBeCloseTo(D.middleBack, 1);
    t.run(0.5, hold);
    // still their set in the air: the step up comes before the hit
    expect(t.g.ball.lastTouch?.kind).toBe('set');
    expect(OH2.spot.z).toBeCloseTo(D.middleBackSeam, 1);
    // on the line from their hitter through the seam: cross of the pin blocker (within the middle back's range)
    expect(OH2.spot.x).toBeLessThan(pinX);
    expect(Math.abs(OH2.spot.x)).toBeLessThanOrEqual(D.middleBackMaxX + 1e-9);
  });

  it('a closed block: the middle back stays deep through the attack', () => {
    const { t, hold } = blockUp(3.5 - AI.middle.closeGap);
    t.run(1.1, hold);
    expect(t.brain('OH2').spot.z).toBeCloseTo(D.middleBack, 1);
    const lane = laneFor('OH', -1);
    t.spike({ x: lane.x, y: 3.25, z: lane.z }, { x: -2.6, y: 0.1, z: 6.5 }, 22);
    t.run(0.2);
    expect(t.brain('OH2').spot.z).toBeCloseTo(D.middleBack, 1);
  });

  it('a late middle whose reach closes the seam: the middle back reads the hands, not the bodies, and stays deep', () => {
    // the body 1.2 m inside the pin blocker, but the hands stretched 0.6 m towards it
    const { t, hold } = blockUp(3.5 - 1.2, 0.6);
    t.run(1.1, hold);
    expect(t.brain('OH2').spot.z).toBeCloseTo(D.middleBack, 1);
  });
});
