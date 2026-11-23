import { afterEach, describe, expect, it } from 'vitest';
import { AI, ASSIST, BALL, CONTACT, LEVEL_IDS, LEVELS, POSITIONS, SET_LEVELS, SIM, TIMING, type LevelId } from '../src/config';
import type { Guess, MiddleBlocker } from '../src/ai/middle';
import { SLOT_ROLE, SLOTS } from '../src/ai/team';
import type { MiniRally } from '../src/game/modes/miniRally';
import { laneFor, SETTER_SPOT, SETTER_TARGET } from '../src/game/plays';
import type { V3 } from '../src/physics/ball';
import { solveApex } from '../src/physics/solve';
import { applyLevel, currentLevel } from '../src/core/level';
import { readSpots } from '../src/ai/defence';
import { Scout } from '../src/ai/scout';
import { serveAim } from '../src/ai/server';
import { Rng } from '../src/core/mathx';
import { Athlete } from '../src/game/athlete';
import type { Touch } from '../src/game/ballEntity';
import { headlessGame } from './headlessGame';
import { playLevel } from './levelProbe';

// Levels of play (issues #137 and #53, docs/adr/0012): a level is a league, a set of overrides of
// named config numbers. These are the facts a level has to keep.

afterEach(() => applyLevel('pro'));

/** what the game reads for `read()` at `level` */
function at<T>(level: LevelId, read: () => T): T {
  applyLevel(level);
  return read();
}

/** everything a level must never change, as one string */
const fixed = () =>
  JSON.stringify({
    TIMING,
    SET_LEVELS,
    ASSIST,
    BALL,
    POSITIONS,
    CONTACT: { ...CONTACT, userSpikeShank: 0, userToolEdge: 0, userToolEdgeP: 0 },
  });

describe('the levels table', () => {
  it('Pro is the config as written: it overrides nothing', () => {
    expect(LEVELS.pro.ai).toEqual({});
    expect(LEVELS.pro.contact).toEqual({});
  });

  it('every number a level overrides exists in AI, with the same type', () => {
    const pro = at('pro', () => structuredClone(AI)) as Record<string, unknown>;
    const check = (over: Record<string, unknown>, base: Record<string, unknown>, path: string) => {
      for (const [k, v] of Object.entries(over)) {
        expect(base, `${path}${k}`).toHaveProperty(k);
        const b = base[k];
        if (v && typeof v === 'object' && !Array.isArray(v))
          check(v as Record<string, unknown>, b as Record<string, unknown>, `${path}${k}.`);
        else expect(typeof v, `${path}${k}`).toBe(typeof b);
      }
    };
    for (const id of LEVEL_IDS) check(LEVELS[id].ai as Record<string, unknown>, pro, `${id}: AI.`);
  });

  it('a level never changes a timing window, the ball, a body of yours or an assist: only the opposition', () => {
    const pro = at('pro', fixed);
    for (const id of LEVEL_IDS) expect(at(id, fixed), id).toBe(pro);
  });

  it('putting a level on and Pro back leaves every number as config wrote it', () => {
    const pro = at('pro', () => JSON.stringify({ AI, CONTACT }));
    for (const id of LEVEL_IDS) applyLevel(id);
    expect(at('pro', () => JSON.stringify({ AI, CONTACT }))).toBe(pro);
    expect(currentLevel()).toBe('pro');
  });

  it('going up a level the AI is never slower, never reads worse and never has a smaller body', () => {
    // [what, how the game reads it, +1: higher is better, -1: lower is better]
    const better: [string, () => number, 1 | -1][] = [
      ['reaction', () => AI.reactionTime, -1],
      ['set read', () => AI.defence.react, -1],
      ['hit read', () => AI.defence.hitReact, -1],
      ['read error', () => AI.defence.readErr, -1],
      ['middle reaction', () => AI.middle.react, -1],
      ['middle read error', () => AI.middle.readErr, -1],
      ['blocker', () => AI.blockerSkill, 1],
      ['defender', () => AI.defenderSkill, 1],
      ['hitter', () => AI.hitterSkill, 1],
      ['hitting error', () => AI.attackErr, -1],
      ['setter error', () => AI.setterAccuracy, -1],
      ['jump', () => AI.body.jump, 1],
      ['power', () => AI.body.power, 1],
      ['speed', () => AI.body.speed, 1],
      ['stuff', () => AI.blockStuff.perfect, 1],
      ['open spot', () => AI.openShotIn, 1],
      ['scout', () => AI.wing.scout, 1],
      ['jump serves', () => AI.serve.jump, 1],
      ['fast sets', () => AI.tempo.share, 1],
      ['cover', () => AI.cover.share, 1],
      ['dives', () => AI.dive.anyway, 1],
    ];
    for (const [what, read, sign] of better)
      for (let i = 1; i < LEVEL_IDS.length; i++) {
        const lower = at(LEVEL_IDS[i - 1], read);
        const upper = at(LEVEL_IDS[i], read);
        expect(sign * (upper - lower), `${what}: ${LEVEL_IDS[i - 1]} to ${LEVEL_IDS[i]}`).toBeGreaterThanOrEqual(0);
      }
  });

  it('the bends toward you are off at Pro and grow as the level drops (a Rec team shanks your hard spike for real)', () => {
    const bends = () => [CONTACT.userSpikeShank, AI.userBlockMisread, -CONTACT.userToolEdge, CONTACT.userToolEdgeP];
    const pro = at('pro', bends);
    expect(pro).toEqual([0, 0, -CONTACT.toolEdge, CONTACT.toolEdgeP]);
    for (let i = 1; i < LEVEL_IDS.length; i++) {
      const lower = at(LEVEL_IDS[i - 1], bends);
      const upper = at(LEVEL_IDS[i], bends);
      lower.forEach((v, k) => expect(v, `${LEVEL_IDS[i - 1]} ${k}`).toBeGreaterThanOrEqual(upper[k]));
    }
  });
});

describe('a level is a league: what its players do', () => {
  const passers = [
    { x: -3, z: 6 },
    { x: 0, z: 6.5 },
    { x: 3, z: 6 },
  ];

  it('a Rec server just gets it in: mostly the middle of the court, never a seam, a corner or short', () => {
    applyLevel('rec');
    const rng = new Rng(5);
    let middle = 0;
    for (let i = 0; i < 400; i++) {
      const p = serveAim(passers, -1, rng, false, passers[2]);
      if (Math.abs(p.x) < 2.5 && Math.abs(-p.z - 4.5) < 2.5) middle++;
    }
    expect(middle / 400).toBeGreaterThan(0.6);
    expect([AI.serve.seam, AI.serve.deep, AI.serve.short, AI.serve.weakest]).toEqual([0, 0, 0, 0]);
  });

  it('a Pro server goes at the passer who has passed worst; a National one does not look', () => {
    const near = (p: { x: number; z: number }, q: { x: number; z: number }) => Math.hypot(p.x - q.x, -p.z - q.z) < 1.2;
    const count = (level: LevelId) => {
      applyLevel(level);
      const rng = new Rng(9);
      let worst = 0;
      let other = 0;
      for (let i = 0; i < 600; i++) {
        const p = serveAim(passers, -1, rng, false, passers[2]);
        if (near(p, passers[2])) worst++;
        if (near(p, passers[0])) other++;
      }
      return worst - other;
    };
    expect(count('pro')).toBeGreaterThan(60);
    expect(Math.abs(count('national'))).toBeLessThan(40);
  });

  it("the server's team scouts their passers: the one whose passes came down furthest off the setter's spot, once two passes are seen", () => {
    const scout = new Scout();
    const a = new Athlete('OH', -1);
    const b = new Athlete('L', -1);
    const pass = (who: Athlete, t: number): Touch => ({ athlete: who, kind: 'pass', t, side: -1 });
    scout.notePass(pass(a, 1), 2.4);
    expect(scout.weakest([a, b])).toBeNull();
    scout.notePass(pass(b, 2), 0.3);
    expect(scout.weakest([a, b])).toBe(a);
    // a pass nobody could set counts as the worst there is, not as infinitely far off
    scout.notePass(pass(b, 3), Infinity);
    expect(scout.weakest([a, b])).toBe(b);
    expect(scout.passes.get(b)!.off).toBeCloseTo(0.3 + AI.serve.worstPass, 6);
  });

  it('at Rec and Club the off-blocker stays at the net, so the tip behind the block is open; from National it drops to cover it', () => {
    const off = (level: LevelId) => at(level, () => readSpots({ x: 3.5, off: 0.5, kind: 'pin' }).OH1!.z);
    expect(off('rec')).toBeLessThan(1.5);
    expect(off('club')).toBeLessThan(1.5);
    expect(off('national')).toBeGreaterThan(2.5);
    expect(off('pro')).toBeGreaterThan(2.5);
  });

  it("an AI player plays with its level's body; yours is your own at every level", () => {
    const game = headlessGame('rally', 'OH', 2024, { level: 'rec' });
    const them = game.sim.athletes.filter((a) => a !== game.seat.athlete && a.role === 'OH');
    expect(them.length).toBeGreaterThan(0);
    for (const a of them) {
      expect(a.stats.jump).toBeCloseTo(POSITIONS.OH.jump * LEVELS.rec.ai.body!.jump!, 6);
      expect(a.stats.approachSpeed).toBeCloseTo(POSITIONS.OH.approachSpeed * LEVELS.rec.ai.body!.speed!, 6);
    }
    expect(game.seat.athlete.stats.jump).toBe(POSITIONS.OH.jump);
    expect(game.seat.athlete.stats.power).toBe(POSITIONS.OH.power);
    game.mode.teardown();
    expect(currentLevel()).toBe('pro');
  });
});

/**
 * An all-AI Mini Rally at `level`, stopped before the serve: our libero passes to the setter's
 * target and the ball flies (with our team reading it) until our setter would touch it.
 */
function passToOurSetter(level: LevelId) {
  const game = headlessGame('rally', 'L', 7, { level, autoUser: true });
  const { sim, host } = game;
  const mode = game.mode as MiniRally;
  const us = mode.home;
  const them = mode.away;
  const ball = sim.ball;
  us.place('receive');
  them.place('defense');
  const from: V3 = { x: 2.4, y: 0.85, z: 6.0 };
  const v: V3 = { x: 0, y: 0, z: 0 };
  solveApex(from, { x: SETTER_TARGET.x, y: 2.5, z: SETTER_TARGET.z }, 4.1, { x: 0, y: 0, z: 0 }, v);
  ball.launch(from, v, undefined, 0, sim.simTime);
  ball.lastTouch = { athlete: us.players.get('L')!, kind: 'pass', t: sim.simTime, side: 1 };
  const setter = us.players.get('S')!;
  const DT = 1 / SIM.hz;
  for (let i = 0; i < SIM.hz * 3; i++) {
    sim.simTime += DT;
    ball.step(DT, sim.env);
    us.step();
    if (ball.vel.y < 0 && ball.pos.y < setter.height + 0.62) break;
  }
  setter.place(SETTER_SPOT.x, SETTER_SPOT.z, 0);
  /** their middle shows `guess` on our pass, as their setter would see it */
  const middleShows = (guess: Guess) => {
    const m = them.brains.get(them.players.get('MB')!)!.blocker as MiddleBlocker;
    (m as unknown as { guessFor: unknown }).guessFor = ball.lastTouch;
    m.guess = guess;
  };
  /** who our setter sets, `n` times over from this pass: a share for each slot */
  const sets = (n = 400) => {
    const share: Record<string, number> = {};
    for (let i = 0; i < n; i++) {
      const to = us.callSet(host, setter).hitter;
      const slot = SLOTS.find((s) => us.players.get(s) === to) ?? 'none';
      share[slot] = (share[slot] ?? 0) + 1 / n;
    }
    return share;
  };
  return { us, them, middleShows, sets, pass: () => ball.lastTouch };
}

describe("the setter's look across the net", () => {
  it('a Pro setter sets away from a middle who has committed on the quick', () => {
    // (the stand-in's middle never gets up for a quick: the setter's weights, as it looks across)
    const t = passToOurSetter('pro');
    const weights = () => {
      const options = (['OH1', 'MB', 'OPP'] as const).map((slot) => ({ slot, a: t.us.players.get(slot)!, lane: SLOT_ROLE[slot], w: 1 }));
      (t.us as unknown as { lookAcross(p: unknown, o: typeof options): void }).lookAcross(t.pass(), options);
      return Object.fromEntries(options.map((o) => [o.slot, o.w]));
    };
    const reads = weights();
    t.middleShows('quick');
    const away = weights();
    expect(away.MB).toBeCloseTo(reads.MB * AI.setterSees.away, 6);
    expect(away.OH1).toBeCloseTo(reads.OH1, 6);
  });

  it('a Pro setter sets away from a middle leaning to the outside', () => {
    const reads = passToOurSetter('pro').sets();
    const leaning = passToOurSetter('pro');
    leaning.middleShows('outside');
    expect(leaning.sets().OH1).toBeLessThan(reads.OH1 * 0.6);
  });

  it('a Club setter does not look: the quick goes as often whatever their middle shows', () => {
    const reads = passToOurSetter('club').sets();
    const fooled = passToOurSetter('club');
    fooled.middleShows('quick');
    expect(fooled.sets()).toEqual(reads);
  });

  it('a Pro setter isolates the hitter in front of the lower block', () => {
    const share = (height: number) => {
      const t = passToOurSetter('pro');
      // their blocker across from our outside's attack
      const x = laneFor('OH', 1).x;
      const b = t.them.frontRow().reduce((p, q) => (Math.abs(q.pos.x - x) < Math.abs(p.pos.x - x) ? q : p));
      b.setBody({ height, jump: 0.6 });
      return t.sets().OH1;
    };
    expect(share(1.7)).toBeGreaterThan(share(2.1) * 1.3);
  });
});

// (150 s a level keeps the suite quick, and the rally is seeded, so it plays the same every run;
// the stuff rate is too rare to rank on so few attacks: `blockStuff` going up is held above)
describe('a league against itself (all-AI Mini Rally, 150 s a level)', () => {
  const rec = playLevel('rec', 150, 7);
  const pro = playLevel('pro', 150, 7);

  it('a Rec setter never sets a quick, and a Rec team never dives', () => {
    expect(rec.quicks).toBe(0);
    expect(rec.dives).toBe(0);
    expect(pro.quicks).toBeGreaterThan(0);
    expect(pro.dives).toBeGreaterThan(0);
  });

  it('a Rec hitter puts more balls out and into the net than a Pro one', () => {
    expect(rec.ends.error / rec.attacks).toBeGreaterThan(pro.ends.error / pro.attacks);
  });

  it('a Rec team digs far fewer attacks than a Pro one', () => {
    expect(rec.kinds.dig ?? 0).toBeLessThan((pro.kinds.dig ?? 0) / 2);
  });
});
