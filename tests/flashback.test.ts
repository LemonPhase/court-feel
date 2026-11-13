import { describe, expect, it } from 'vitest';
import { COURT, FLASHBACK, LEVELS, SIM, type LevelId } from '../src/config';
import { capture, restore, type Memento } from '../src/core/memento';
import { Rng } from '../src/core/mathx';
import { planScratch } from '../src/ai/approach';
import { SLOT_ROLE, SLOTS, TeamAI } from '../src/ai/team';
import { Athlete } from '../src/game/athlete';
import type { Touch, TouchKind } from '../src/game/ballEntity';
import { checkpointIndex, Flashback, isOwnMistake, SIM_RULES, type OwnContact } from '../src/game/flashback';
import type { Game } from '../src/game/game';
import { laneFor, SETTER_SPOT } from '../src/game/plays';
import { copyBall, makeBall, stepBall, type BallEnv, type V3 } from '../src/physics/ball';
import { BallPredictor } from '../src/physics/predict';
import { solveApex } from '../src/physics/solve';

const me = new Athlete('OH', 1);
const mate = new Athlete('S', 1);
const them = new Athlete('OH', -1);
let clock = 0;
const touch = (kind: TouchKind, athlete: Athlete): Touch => ({ athlete, kind, t: clock++, side: athlete.side });
const own = (t: Touch, grade: OwnContact['grade'], shanked = false): OwnContact => ({ touch: t, kind: t.kind, grade, shanked });
const save = (): Memento => capture({}, SIM_RULES);

describe('take that ball again: whose mistake ended the rally', () => {
  it('you hit it out or into the net: yours, however well you timed it', () => {
    const spike = touch('spike', me);
    expect(isOwnMistake(me, spike, own(spike, 'Good'), false)).toBe(true);
    expect(isOwnMistake(me, spike, own(spike, 'Perfect'), false)).toBe(true);
  });

  it('your own pass, dig or set came down: yours when you mistimed or shanked it, not when it was clean and nobody followed it up', () => {
    const dig = touch('dig', me);
    expect(isOwnMistake(me, dig, own(dig, 'Late'), false)).toBe(true);
    expect(isOwnMistake(me, dig, own(dig, 'Late', true), false)).toBe(true);
    expect(isOwnMistake(me, dig, own(dig, 'Good'), false)).toBe(false);
    const set = touch('set', me);
    expect(isOwnMistake(me, set, own(set, 'Perfect'), false)).toBe(false);
  });

  it('a ball that was yours to play dropped (their serve, their spike, the set to you): yours', () => {
    expect(isOwnMistake(me, touch('serve', them), null, true)).toBe(true);
    expect(isOwnMistake(me, touch('spike', them), null, true)).toBe(true);
    expect(isOwnMistake(me, touch('set', mate), null, true)).toBe(true);
  });

  it("a ball that was a team-mate's to play dropped: not yours", () => {
    expect(isOwnMistake(me, touch('spike', them), null, false)).toBe(false);
    expect(isOwnMistake(me, touch('dig', mate), null, false)).toBe(false);
  });

  it('you were stuffed, or your block did not stop the hit: the blocker or the hitter won it, not your mistake', () => {
    expect(isOwnMistake(me, touch('block', them), null, true)).toBe(false);
    const block = touch('block', me);
    expect(isOwnMistake(me, block, own(block, 'Late'), true)).toBe(false);
  });
});

describe('take that ball again: where the rally goes back to', () => {
  it('a set you mis-hit: back to your team’s first touch, so the setter’s call and your whole approach come again', () => {
    const rally = [touch('serve', them), touch('pass', mate), touch('set', mate)];
    expect(checkpointIndex(rally, 2, 1)).toBe(1);
  });

  it('a pass to you as the setter: that pass is your team’s first touch', () => {
    const rally = [touch('serve', them), touch('pass', mate)];
    expect(checkpointIndex(rally, 1, 1)).toBe(1);
  });

  it('their spike you could not dig: back to their set, so you can read the hitter', () => {
    const rally = [touch('serve', mate), touch('pass', them), touch('set', them), touch('spike', them)];
    expect(checkpointIndex(rally, 3, 1)).toBe(2);
  });

  it('their serve at you: back to the serve itself', () => {
    const rally = [touch('serve', them)];
    expect(checkpointIndex(rally, 0, 1)).toBe(0);
  });

  it('their attack on the first ball after our serve: back to that attack, never to our own serve', () => {
    const rally = [touch('serve', mate), touch('spike', them)];
    expect(checkpointIndex(rally, 1, 1)).toBe(1);
  });

  it('our own block does not start the play: back to the dig that followed it', () => {
    const rally = [touch('spike', them), touch('block', mate), touch('dig', mate), touch('set', mate)];
    expect(checkpointIndex(rally, 3, 1)).toBe(2);
  });
});

describe('take that ball again: the offer and its limits', () => {
  /** a rally up to a set to the user, who hits it out */
  const rallyLostOnMySpike = (f: Flashback) => {
    const touches = [touch('serve', them), touch('pass', mate), touch('set', mate)];
    for (const t of touches) f.observe(t, save, FLASHBACK.touches);
    const spike = touch('spike', me);
    f.observe(spike, save, FLASHBACK.touches);
    f.contact(spike, 'spike', 'Late', false);
    return { touches, spike };
  };

  it('a learner’s league gives the same toss again and a match does not: Rec every time, Club once a rally, National and Pro never', () => {
    expect(LEVELS.rec.again).toBe(Infinity);
    expect(LEVELS.club.again).toBe(1);
    expect(LEVELS.national.again).toBe(0);
    expect(LEVELS.pro.again).toBe(0);
  });

  it('the offer goes back to the start of the play and forgets the touches after it', () => {
    const f = new Flashback();
    const { touches, spike } = rallyLostOnMySpike(f);
    expect(f.lost(me, spike, false, 1)).toBe(true);
    expect(f.offered).toBe(true);
    expect(f.target).toBe(touches[1]);
    expect(f.take()).not.toBeNull();
    expect(f.offered).toBe(false);
    expect(f.used).toBe(1);
    // the same touch observed again after the flashback is not a new one
    f.observe(
      touches[1],
      () => {
        throw new Error('the checkpoint was saved twice');
      },
      FLASHBACK.touches,
    );
  });

  it('Club: once in a rally, then the point stands; a new rally starts the count again', () => {
    const f = new Flashback();
    const first = rallyLostOnMySpike(f);
    expect(f.lost(me, first.spike, false, LEVELS.club.again)).toBe(true);
    f.take();
    const again = touch('spike', me);
    f.observe(again, save, FLASHBACK.touches);
    f.contact(again, 'spike', 'Late', false);
    expect(f.lost(me, again, false, LEVELS.club.again)).toBe(false);
    f.reset();
    const next = rallyLostOnMySpike(f);
    expect(f.lost(me, next.spike, false, LEVELS.club.again)).toBe(true);
  });

  it('Rec: every time; Pro: never', () => {
    const f = new Flashback();
    let last = rallyLostOnMySpike(f).spike;
    for (let i = 0; i < 4; i++) {
      expect(f.lost(me, last, false, LEVELS.rec.again)).toBe(true);
      f.take();
      last = touch('spike', me);
      f.observe(last, save, FLASHBACK.touches);
      f.contact(last, 'spike', 'Late', false);
    }
    const g = new Flashback();
    expect(g.lost(me, rallyLostOnMySpike(g).spike, false, LEVELS.pro.again)).toBe(false);
  });

  it('a rally lost on a team-mate’s ball is not offered', () => {
    const f = new Flashback();
    const spike = touch('spike', them);
    f.observe(spike, save, FLASHBACK.touches);
    expect(f.lost(me, spike, false, Infinity)).toBe(false);
    expect(f.offered).toBe(false);
  });
});

describe('take that ball again: the same ball comes again', () => {
  const DT = 1 / SIM.hz;
  /** an all-AI team on a stand-in for the Game (as tests/teamDefence), with everything a flashback saves */
  function team(level: LevelId) {
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
      rng: new Rng(5),
      ballLive: true,
      ball,
      setBrain() {},
      hud: { message() {} },
      contact: { lastSet: null, tryPass: () => false, tryBlock: () => false },
    };
    const game = g as unknown as Game;
    const t = new TeamAI(1, game, LEVELS[level]);
    for (const slot of SLOTS) t.add(slot, new Athlete(SLOT_ROLE[slot], 1), false);
    t.place('defense');
    const athletes = [...t.players.values()];
    const theirs = new Athlete('OH', -1);
    const fly = (kind: TouchKind, from: V3, to: V3, apex: number) => {
      const v = { x: 0, y: 0, z: 0 };
      solveApex(from, to, apex, { x: 0, y: 0, z: 0 }, v);
      Object.assign(state.p, from);
      Object.assign(state.v, v);
      state.rest = false;
      version++;
      ball.lastTouch = { athlete: theirs, kind, t: g.simTime, side: -1 };
    };
    const run = (seconds: number) => {
      for (let i = 0; i < seconds * SIM.hz; i++) {
        g.simTime += DT;
        stepBall(state, DT, env, []);
        for (const b of t.brains.values()) b.step(DT, game);
        for (const a of athletes) a.step(DT, g.simTime);
        t.step();
      }
    };
    /** the stand-in's own ball and clock, saved beside what the rules save */
    const saveAll = () => {
      const m = capture({ athletes, brains: [...t.brains.values()], team: t, rng: g.rng, scratch: planScratch }, SIM_RULES);
      const b = {
        state: copyBall(state, makeBall()),
        lastTouch: ball.lastTouch,
        version,
        predicted,
        prediction: predictor.save(),
        t: g.simTime,
      };
      return () => {
        restore(m);
        copyBall(b.state, state);
        ball.lastTouch = b.lastTouch;
        version = b.version;
        predicted = b.predicted;
        predictor.load(b.prediction);
        g.simTime = b.t;
      };
    };
    const where = () => athletes.map((a) => `${a.pos.x},${a.pos.y},${a.pos.z},${a.yaw},${a.state}`).join('|') + `|${g.rng.next()}`;
    return { t, fly, run, saveAll, where };
  }

  for (const level of ['rec', 'pro'] as const) {
    it(`${level}: after going back to their set, every player moves exactly as they did the first time`, () => {
      const c = team(level);
      const lane = laneFor('OH', -1);
      c.fly('set', { x: -SETTER_SPOT.x, y: 2.6, z: -SETTER_SPOT.z }, { x: lane.x, y: 3.25, z: lane.z }, 3.25 + lane.apexAbove);
      c.run(0.2);
      const goBack = c.saveAll();
      // their hitter rolls it short into the court: the defence reads, runs, dives
      const play = () => {
        c.run(0.9);
        c.fly('spike', { x: lane.x, y: 3.25, z: lane.z }, { x: -1.5, y: 0.1, z: 4.5 }, 3.4);
        c.run(1.5);
        return c.where();
      };
      const first = play();
      goBack();
      expect(play()).toBe(first);
      // and again: a flashback can be taken more than once from the same touch
      goBack();
      expect(play()).toBe(first);
    });
  }
});
