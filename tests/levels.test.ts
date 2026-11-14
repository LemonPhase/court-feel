import { describe, expect, it } from 'vitest';
import { AI, COURT, DEFAULT_SETTINGS, LEVEL_IDS, LEVELS, POSITIONS, SIM, type Level, type LevelId } from '../src/config';
import { sanitizeSettings } from '../src/core/settings';
import { Rng } from '../src/core/mathx';
import { Athlete } from '../src/game/athlete';
import type { Touch, TouchKind } from '../src/game/ballEntity';
import type { Game } from '../src/game/game';
import { laneFor, SETTER_SPOT } from '../src/game/plays';
import { makeBall, stepBall, type BallEnv, type V3 } from '../src/physics/ball';
import { BallPredictor } from '../src/physics/predict';
import { solveApex } from '../src/physics/solve';
import { serveAim } from '../src/ai/server';
import { SLOT_ROLE, SLOTS, TeamAI, type Slot } from '../src/ai/team';

const DT = 1 / SIM.hz;
const NO_SPIN: V3 = { x: 0, y: 0, z: 0 };
const W = COURT.halfWidth;
const ladder = <T>(pick: (l: Level) => T): T[] => LEVEL_IDS.map((id) => pick(LEVELS[id]));
/** each value is no bigger than the one before it */
const falls = (xs: number[]) => xs.every((x, i) => i === 0 || x <= xs[i - 1]);
const rises = (xs: number[]) => xs.every((x, i) => i === 0 || x >= xs[i - 1]);

/**
 * An all-AI home team (+z) of a level of play on a stand-in for the Game (as tests/teamDefence):
 * the ball, the clock, the rng, and contacts that never happen.
 */
function homeTeam(level: LevelId, seed = 3) {
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
    rng: new Rng(seed),
    ballLive: true,
    ball,
    setBrain() {},
    hud: { message() {} },
    contact: { lastSet: null, tryPass: () => false, tryBlock: () => false },
  };
  const game = g as unknown as Game;
  const team = new TeamAI(1, game, LEVELS[level]);
  for (const slot of SLOTS) team.add(slot, new Athlete(SLOT_ROLE[slot], 1), false);
  team.place('defense');
  const theirs = new Athlete('OH', -1);
  const touch = (kind: TouchKind, from: V3, to: V3, apex: number) => {
    const v = { x: 0, y: 0, z: 0 };
    solveApex(from, to, apex, NO_SPIN, v);
    Object.assign(state.p, from);
    Object.assign(state.v, v);
    state.rest = false;
    version++;
    ball.lastTouch = { athlete: theirs, kind, t: g.simTime, side: -1 };
  };
  /** a hard spike from `from` straight at `to` (on the floor) at `speed` m/s */
  const spike = (from: V3, to: V3, speed: number) => {
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const t = Math.hypot(dx, dz) / speed;
    Object.assign(state.p, from);
    Object.assign(state.v, { x: dx / t, y: (to.y - from.y + 0.5 * 9.81 * t * t) / t, z: dz / t });
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
  /** their setter sets their outside high (our right) */
  const setOutside = () => {
    const lane = laneFor('OH', -1);
    touch('set', { x: -SETTER_SPOT.x, y: 2.6, z: -SETTER_SPOT.z }, { x: lane.x, y: 3.25, z: lane.z }, 3.25 + lane.apexAbove);
  };
  return { g, team, touch, spike, run, brain, setOutside };
}

describe('levels of play: a level is a league', () => {
  it('Pro is the Mini Rally as it was before levels: its numbers are the AI numbers', () => {
    const P = LEVELS.pro;
    expect(P.body).toEqual({ jump: 1, power: 1, speed: 1, ballControl: 1 });
    expect(P.serve).toMatchObject({ jump: AI.serve.jump, floatErr: AI.serve.floatErr, jumpErr: AI.serve.jumpErr, spread: AI.serve.spread });
    expect(P.defence).toMatchObject({ react: AI.defence.react, readErr: AI.defence.readErr, hitReact: AI.defence.hitReact });
    expect(P.defence.pickReact).toBe(AI.reactionTime);
    expect(P.block.middle).toMatchObject({ react: AI.middle.react, lateReach: AI.middle.lateReach, closeGap: AI.middle.closeGap });
    // the pin blocker: what BlockerBrain makes of AI.blockerSkill (its reaction, its read, its jump timing)
    const s = 1 - AI.blockerSkill;
    expect(P.block.pin.react).toBeCloseTo(0.12 + s * 0.25, 9);
    expect(P.block.pin.readErr).toBeCloseTo(0.15 + s * 0.7, 9);
    expect(P.block.pin.jumpErr).toBeCloseTo(0.02 + s * 0.09, 9);
    expect(P.set).toMatchObject({ accuracy: AI.setterAccuracy, outOfSystem: AI.outOfSystem, tempo: AI.tempo.share });
    expect(P.attack).toMatchObject({ timingErr: AI.attackErr, openIn: 1, openOut: AI.openShotOut });
    expect(P.pass).toMatchObject({ pressure: AI.passPressure, outJudge: AI.outJudge, dive: 1, scramble: AI.scramble });
    // until the lower levels have been played, the game starts at Pro
    expect(DEFAULT_SETTINGS.level).toBe('pro');
  });

  it('every step up a level reacts sooner, reads better, times better, serves and hits harder', () => {
    expect(falls(ladder((l) => l.defence.hitReact))).toBe(true);
    expect(falls(ladder((l) => l.defence.react))).toBe(true);
    expect(falls(ladder((l) => l.block.middle.react))).toBe(true);
    expect(falls(ladder((l) => l.block.middle.closeGap))).toBe(true);
    expect(falls(ladder((l) => l.block.pin.react))).toBe(true);
    expect(falls(ladder((l) => l.pass.timingErr))).toBe(true);
    expect(falls(ladder((l) => l.attack.timingErr))).toBe(true);
    expect(falls(ladder((l) => l.set.accuracy))).toBe(true);
    expect(rises(ladder((l) => l.serve.jump))).toBe(true);
    expect(rises(ladder((l) => l.body.power))).toBe(true);
    expect(rises(ladder((l) => l.body.jump))).toBe(true);
    expect(rises(ladder((l) => l.attack.openIn))).toBe(true);
    expect(rises(ladder((l) => l.pass.dive))).toBe(true);
    expect(rises(ladder((l) => l.block.stuff.perfect))).toBe(true);
  });

  it('no level reacts to a hit faster than a trained player can (about 0.2 s)', () => {
    for (const id of LEVEL_IDS) expect(LEVELS[id].defence.hitReact, id).toBeGreaterThanOrEqual(0.2);
  });

  it('a Rec side has no jump serves, no fast sets, no pipe and no dives', () => {
    const R = LEVELS.rec;
    expect(R.serve.jump).toBe(0);
    expect(R.set.tempo).toBe(0);
    expect(R.set.pipeIn).toBe(0);
    expect(R.pass.dive).toBe(0);
  });
});

describe('levels of play: the body', () => {
  it("a level scales an AI player's jump, power, speed and ball control, never its height", () => {
    const a = new Athlete('OH', -1);
    const p = POSITIONS.OH;
    a.setLevel(LEVELS.rec);
    const b = LEVELS.rec.body;
    expect(a.stats.jump).toBeCloseTo(p.jump * b.jump, 9);
    expect(a.jumpMax).toBe(a.stats.jump);
    expect(a.stats.power).toBeCloseTo(p.power * b.power, 9);
    expect(a.stats.approachSpeed).toBeCloseTo(p.approachSpeed * b.speed, 9);
    expect(a.stats.ballControl).toBeCloseTo(p.ballControl * b.ballControl, 9);
    expect(a.height).toBe(p.height);
    // the shared position stats are never written to
    expect(POSITIONS.OH.jump).toBe(p.jump);
  });

  it('a Pro player is the position as it is, and the user is never given a level', () => {
    const a = new Athlete('MB', -1);
    a.setLevel(LEVELS.pro);
    expect(a.stats).toBe(POSITIONS.MB);
    // the user's body is their Athlete setting: applying it puts a probe's level back to Pro
    const me = new Athlete('OH', 1, { body: { height: 1.8, jump: 0.7, power: 0.9 } });
    me.setLevel(LEVELS.rec);
    me.setBody({ height: 1.8, jump: 0.7, power: 0.9 });
    expect(me.level).toBe(LEVELS.pro);
    expect(me.stats.jump).toBe(0.7);
    expect(me.stats.power).toBe(0.9);
  });

  it('both teams of a Mini Rally play at the level: every AI player a team adds takes it', () => {
    const t = homeTeam('club');
    for (const a of t.team.players.values()) expect(a.level).toBe(LEVELS.club);
    expect(t.team.players.get('L')!.stats.approachSpeed).toBeCloseTo(POSITIONS.L.approachSpeed * LEVELS.club.body.speed, 9);
  });
});

describe('levels of play: the defence', () => {
  it('a Pro defence reads their set and goes to its perimeter spots; a Rec defence holds its base', () => {
    const pro = homeTeam('pro');
    pro.setOutside();
    pro.run(0.9);
    expect(pro.brain('S').spot.x).toBeCloseTo(W - AI.defence.lineIn, 1);
    expect(pro.brain('OH1').job).toBe('base');

    const rec = homeTeam('rec');
    rec.setOutside();
    rec.run(0.9);
    // the back row stays where it stood, and the front-row player who isn't blocking stays at the net
    expect(rec.brain('S').spot).toEqual(rec.team.formSpot('defense', 'S'));
    expect(rec.brain('L').spot).toEqual(rec.team.formSpot('defense', 'L'));
    expect(rec.brain('OH1').job).toBe('block');
  });

  it('on a hard spike a Rec defender is still standing when a Pro defender has started for the ball', () => {
    const firstMove = (level: LevelId, seed: number) => {
      const t = homeTeam(level, seed);
      const lane = laneFor('OH', -1);
      t.spike({ x: lane.x, y: 3.25, z: lane.z }, { x: -1.0, y: 0.1, z: 7.0 }, 20);
      const hitT = t.g.simTime;
      let steers = Infinity;
      let receiver: Athlete | null = null;
      let ticks = 0;
      t.run(0.7, () => {
        if (receiver) ticks++;
        receiver ??= t.team.receiver;
        if (
          receiver &&
          ticks > 0 &&
          steers === Infinity &&
          (Math.hypot(receiver.cmd.moveX, receiver.cmd.moveZ) > 0.05 || receiver.state === 'dive')
        )
          steers = t.g.simTime - hitT;
      });
      return steers;
    };
    for (const seed of [1, 2, 3, 4, 5]) {
      const pro = firstMove('pro', seed);
      const rec = firstMove('rec', seed);
      expect(pro, `seed ${seed}`).toBeLessThan(LEVELS.pro.defence.hitReact + 3 * LEVELS.pro.defence.hitReactSd + 0.02);
      expect(rec, `seed ${seed}`).toBeGreaterThan(LEVELS.rec.defence.hitReact - 3 * LEVELS.rec.defence.hitReactSd);
      expect(rec, `seed ${seed}`).toBeGreaterThan(pro);
    }
  });

  it('a roll shot out of reach on foot: a Pro defender dives and a team-mate runs at it too, a Rec defender runs and nobody else comes', () => {
    const play = (level: LevelId) => {
      const t = homeTeam(level);
      t.setOutside();
      t.run(1.1);
      const lane = laneFor('OH', -1);
      const L = t.team.players.get('L')!;
      const to = { x: L.pos.x + 3.3 * Math.sin(1.2), y: 0.1, z: L.pos.z - 3.3 * Math.cos(1.2) };
      t.touch('spike', { x: lane.x, y: 3.25, z: lane.z }, to, 3.4);
      let dived = false;
      let two = 0;
      t.run(1.0, () => {
        dived ||= [...t.team.players.values()].some((a) => a.state === 'dive');
        const r = t.team.receiver;
        if (!r) return;
        const runners = [...t.team.brains.values()].filter(
          (b) => b.athlete !== r && b.job === 'base' && Math.hypot(b.spot.x - to.x, b.spot.z - to.z) < 1.5,
        );
        two = Math.max(two, runners.length);
      });
      return { dived, two };
    };
    expect(play('pro')).toEqual({ dived: true, two: 1 });
    expect(play('rec')).toEqual({ dived: false, two: 0 });
  });

  it('a ball landing half a metre out: a Rec side plays it, a Pro side lets it go', () => {
    const sent = (level: LevelId) => {
      const t = homeTeam(level);
      // a free ball dropping 0.5 m past our end line
      t.touch('free', { x: 0, y: 2.5, z: -5 }, { x: 0.5, y: 0, z: COURT.halfLength + 0.5 }, 6);
      t.run(0.5);
      return t.team.receiver !== null;
    };
    expect(sent('rec')).toBe(true);
    expect(sent('pro')).toBe(false);
  });
});

describe('levels of play: the block', () => {
  it('on a high ball to the pin a Pro middle closes the double block; a Rec middle is not there, so one blocker goes up', () => {
    /** who is in the air at the net when their hitter meets the set, and how far apart */
    const blockAt = (level: LevelId, seed: number) => {
      const t = homeTeam(level, seed);
      t.setOutside();
      const pred = t.g.ball.ensurePrediction(t.g.env, t.g.simTime);
      const tc = pred.descendThrough(3.25, t.g.simTime);
      t.run(tc - t.g.simTime);
      const wing = t.team.players.get('OPP')!;
      const mb = t.team.players.get('MB')!;
      return { wing: wing.airborne, middle: mb.airborne, gap: Math.abs(wing.pos.x - mb.pos.x) };
    };
    let proDoubles = 0;
    let recDoubles = 0;
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const pro = blockAt('pro', seed);
      if (pro.wing && pro.middle && pro.gap < 0.75) proDoubles++;
      const rec = blockAt('rec', seed);
      if (rec.middle && rec.gap < 0.75) recDoubles++;
    }
    expect(proDoubles).toBeGreaterThanOrEqual(5);
    expect(recDoubles).toBe(0);
  });
});

describe('levels of play: the serve', () => {
  it('a Rec server aims at a passer most of the time; a Pro server at the seams and the corners', () => {
    const passers = [
      { x: -3, z: 6 },
      { x: 0, z: 6.5 },
      { x: 3, z: 6 },
    ];
    /** share of serves aimed within a metre of where a passer stands (before the scatter: spread 0) */
    const atPasser = (level: LevelId) => {
      const rng = new Rng(11);
      const aim = { ...LEVELS[level].serve, spread: 0 };
      let n = 0;
      for (let i = 0; i < 400; i++) {
        const p = serveAim(passers, 1, rng, false, aim);
        if (passers.some((q) => Math.hypot(p.x - q.x, Math.abs(p.z) - q.z) < 1)) n++;
      }
      return n / 400;
    };
    expect(atPasser('rec')).toBeGreaterThan(0.7);
    expect(atPasser('pro')).toBeLessThan(0.35);
  });
});

describe('levels of play: the setting', () => {
  it('a stored level is kept, anything else falls back to the default', () => {
    expect(sanitizeSettings({ level: 'club' }).level).toBe('club');
    expect(sanitizeSettings({ level: 'legend' }).level).toBe(DEFAULT_SETTINGS.level);
    expect(sanitizeSettings({ level: 3 }).level).toBe(DEFAULT_SETTINGS.level);
    expect(sanitizeSettings({ level: 'constructor' }).level).toBe(DEFAULT_SETTINGS.level);
  });
});
