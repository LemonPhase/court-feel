import { describe, expect, it } from 'vitest';
import {
  AI,
  ASSIST,
  BALL,
  CONTACT,
  FACET_IDS,
  FACETS,
  LEVEL_IDS,
  LEVELS,
  POSITIONS,
  SET_LEVELS,
  SIM,
  TIMING,
  YOURS_AT_PRO,
  type LevelId,
} from '../src/config';
import type { Guess, MiddleBlocker } from '../src/ai/middle';
import { SLOT_ROLE, SLOTS } from '../src/ai/team';
import type { MiniRally } from '../src/game/modes/miniRally';
import { laneFor, SETTER_SPOT, SETTER_TARGET } from '../src/game/plays';
import type { V3 } from '../src/physics/ball';
import { solveApex } from '../src/physics/solve';
import { tuningFor } from '../src/core/level';
import { readSpots } from '../src/ai/defence';
import { Scout } from '../src/ai/scout';
import { serveAim } from '../src/ai/server';
import { Rng } from '../src/core/mathx';
import { Athlete } from '../src/game/athlete';
import type { Touch } from '../src/game/ballEntity';
import { headlessGame } from './headlessGame';
import { playLevel, type TeamCard } from './levelProbe';

// Levels of play (issues #137 and #53, docs/adr/0012 and 0013): a level is a league, written as
// overrides of the AI's named numbers, grouped by facet (body, serve, pass, set, attack, block, dig).
// Each team carries its own tuning: theirs plays the whole level, yours plays it too except for the
// facets that stay Pro (`YOURS_AT_PRO`: your team passes and digs like a Pro side at every level, so
// the points are yours to win). These are the facts a level has to keep.

type Tree = Record<string, unknown>;
const isTree = (v: unknown): v is Tree => !!v && typeof v === 'object' && !Array.isArray(v);
/** every leaf of a tree as `path -> value` */
function leaves(t: Tree, path = '', out = new Map<string, unknown>()): Map<string, unknown> {
  for (const [k, v] of Object.entries(t)) {
    if (isTree(v)) leaves(v, `${path}${k}.`, out);
    else out.set(`${path}${k}`, v);
  }
  return out;
}
const get = (t: unknown, path: string): unknown => path.split('.').reduce<unknown>((x, k) => (isTree(x) ? x[k] : undefined), t);

/** every number a level tunes, at any level, and the facet it is in */
const TUNED = new Map<string, string>();
for (const id of LEVEL_IDS)
  for (const [facet, over] of Object.entries(LEVELS[id].facets)) for (const path of leaves(over as Tree).keys()) TUNED.set(path, facet);

/**
 * Which way each tuned number goes as the league gets better: +1 it rises, -1 it falls, 0 it has no
 * order (and why). A new override has to be placed here, so its direction is a decision someone
 * made, and a change that turns a lower league into a better one somewhere fails here first.
 */
const LEVEL_ORDER: Record<string, 1 | -1 | 0> = {
  // body
  'body.jump': 1,
  'body.power': 1,
  // serve
  'serve.jump': 1,
  'serve.floatErr': -1,
  'serve.seam': 1,
  // (a Club server floats it deep; from National the serve goes at the seams and short instead)
  'serve.deep': 0,
  'serve.short': 1,
  'serve.body': -1,
  'serve.middle': -1,
  'serve.weakest': 1,
  'serve.spread': -1,
  // set
  setterAccuracy: -1,
  'setWeight.outside': -1,
  'quickWeight.good': 1,
  'quickWeight.perfect': 1,
  'tempo.share': 1,
  'pipe.inSystem': 1,
  'pipe.outOfSystem': 1,
  'plays.free': 1,
  'plays.receive': 1,
  jumpSet: 1,
  'setterSees.share': 1,
  'setterSees.isolate': 1,
  // attack: a lower league hits less hard, tips more and misses less (it plays it safe: the points are yours to win)
  hitterSkill: 1,
  attackErr: 1,
  tipChance: -1,
  openShotIn: 1,
  openShotOut: 1,
  blockAvoid: -1,
  seamShot: 1,
  toolShot: 1,
  rollShot: 1,
  recycleShot: 1,
  'offSpeed.adjust': 1,
  outOfSystemFree: -1,
  userBlockMisread: -1,
  // block
  'middle.react': -1,
  'middle.reactSd': -1,
  'middle.readErr': -1,
  'middle.commit': 1,
  'middle.cheat': 1,
  blockerSkill: 1,
  'blockStuff.perfect': 1,
  'blockStuff.good': 1,
  blockHands: 1,
  'middle.lateReach': 1,
  'wing.scout': 1,
  userToolEdge: 1,
  userToolEdgeP: -1,
  // dig
  reactionTime: -1,
  'defence.react': -1,
  'defence.reactSd': -1,
  'defence.readErr': -1,
  'defence.hitReact': -1,
  'defence.hitReactSd': -1,
  'defence.offOff': 1,
  'dive.minDist': -1,
  'dive.anyway': 1,
  digSkill: 1,
  passPressure: -1,
  'cover.share': 1,
  footSpeed: 1,
  userSpikeShank: -1,
};

/** everything outside the AI's tuning, which no level may change */
const fixed = () => JSON.stringify({ AI, TIMING, SET_LEVELS, ASSIST, BALL, POSITIONS, CONTACT });

describe('the levels table', () => {
  it('Pro is the AI table as written: it overrides nothing', () => {
    expect(LEVELS.pro.facets).toEqual({});
    for (const team of ['yours', 'theirs'] as const) expect(tuningFor('pro', team)).toEqual(AI);
  });

  it('every number belongs to one facet at most', () => {
    const keys = FACET_IDS.flatMap((f) => [...FACETS[f]]);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(AI, k).toHaveProperty(k);
  });

  it("a level's facet only overrides that facet's numbers, and each exists in AI with the same type", () => {
    for (const id of LEVEL_IDS)
      for (const [facet, over] of Object.entries(LEVELS[id].facets)) {
        for (const k of Object.keys(over as Tree))
          expect((FACETS as Record<string, readonly string[]>)[facet], `${id}.${facet}.${k}`).toContain(k);
        for (const [path, v] of leaves(over as Tree)) expect(typeof v, `${id}: ${path}`).toBe(typeof get(AI, path));
      }
  });

  it('every tuned number has a direction in LEVEL_ORDER, and LEVEL_ORDER names nothing a level does not tune', () => {
    expect(
      [...TUNED.keys()].filter((p) => !(p in LEVEL_ORDER)),
      'missing',
    ).toEqual([]);
    expect(
      Object.keys(LEVEL_ORDER).filter((p) => !TUNED.has(p)),
      'stale',
    ).toEqual([]);
  });

  it('going up a league every tuned number moves the way LEVEL_ORDER says, or stays', () => {
    const tunings = LEVEL_IDS.map((id) => tuningFor(id, 'theirs'));
    for (const [path, sign] of Object.entries(LEVEL_ORDER)) {
      if (!sign) continue;
      for (let i = 1; i < LEVEL_IDS.length; i++) {
        const lower = Number(get(tunings[i - 1], path));
        const upper = Number(get(tunings[i], path));
        expect(sign * (upper - lower), `${path}: ${LEVEL_IDS[i - 1]} to ${LEVEL_IDS[i]}`).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('the bends toward you are off at Pro: their diggers never shank your spike more than the sport does', () => {
    const pro = tuningFor('pro', 'theirs');
    expect([pro.userSpikeShank, pro.userBlockMisread, pro.userToolEdge, pro.userToolEdgeP]).toEqual([
      0,
      0,
      CONTACT.toolEdge,
      CONTACT.toolEdgeP,
    ]);
  });
});

describe('each team carries its own tuning', () => {
  it('a tuning is a new copy every time: changing one never changes AI, another team or another level', () => {
    const before = fixed();
    const a = tuningFor('rec', 'theirs');
    const b = tuningFor('rec', 'theirs');
    expect(a).not.toBe(b);
    a.serve.jump = 0.99;
    a.defence.react = 9;
    expect(b.serve.jump).toBe(0);
    expect(tuningFor('rec', 'yours').defence.react).toBe(AI.defence.react);
    expect(fixed()).toBe(before);
  });

  it('a Rec rally leaves every config table as it was written', () => {
    const before = fixed();
    const game = headlessGame('rally', 'OH', 7, { level: 'rec', autoUser: true });
    for (let i = 0; i < 60 * 20; i++) game.frame();
    game.mode.teardown();
    expect(fixed()).toBe(before);
    expect(game.host.me.ai).toBe(AI);
  });

  it('your team passes and digs like a Pro side at every level; theirs passes and digs at the level', () => {
    for (const id of LEVEL_IDS) {
      const yours = tuningFor(id, 'yours');
      const theirs = tuningFor(id, 'theirs');
      for (const f of YOURS_AT_PRO) for (const k of FACETS[f]) expect(yours[k], `${id} yours ${k}`).toEqual(AI[k]);
      for (const [path, f] of TUNED) {
        const over = get(LEVELS[id].facets[f as keyof typeof LEVELS.rec.facets], path);
        if (over === undefined) continue;
        expect(get(theirs, path), `${id} theirs ${path}`).toEqual(over);
        if (!YOURS_AT_PRO.includes(f as (typeof YOURS_AT_PRO)[number])) expect(get(yours, path), `${id} yours ${path}`).toEqual(over);
      }
    }
  });

  it('the Mini Rally gives each team its tuning, and every AI player its team’s', () => {
    const game = headlessGame('rally', 'OH', 2024, { level: 'rec' });
    const mode = game.mode as MiniRally;
    expect(mode.home.ai).toEqual(tuningFor('rec', 'yours'));
    expect(mode.away.ai).toEqual(tuningFor('rec', 'theirs'));
    for (const a of game.sim.athletes) expect(a.ai, `${a.role} ${a.side}`).toBe(a.side === 1 ? mode.home.ai : mode.away.ai);
    game.mode.teardown();
  });

  it("an AI player plays with its team's body: theirs at the level, your team's runs at Pro speed; yours is your own", () => {
    const game = headlessGame('rally', 'OH', 2024, { level: 'rec' });
    const rec = LEVELS.rec.facets;
    const ohs = (side: 1 | -1) => game.sim.athletes.filter((a) => a !== game.seat.athlete && a.role === 'OH' && a.side === side);
    expect(ohs(-1).length).toBeGreaterThan(0);
    expect(ohs(1).length).toBeGreaterThan(0);
    for (const a of ohs(-1)) {
      expect(a.stats.jump).toBeCloseTo(POSITIONS.OH.jump * rec.body!.body!.jump!, 6);
      expect(a.stats.approachSpeed).toBeCloseTo(POSITIONS.OH.approachSpeed * rec.dig!.footSpeed!, 6);
    }
    for (const a of ohs(1)) {
      expect(a.stats.jump).toBeCloseTo(POSITIONS.OH.jump * rec.body!.body!.jump!, 6);
      expect(a.stats.approachSpeed).toBeCloseTo(POSITIONS.OH.approachSpeed, 6);
    }
    expect(game.seat.athlete.stats.jump).toBe(POSITIONS.OH.jump);
    expect(game.seat.athlete.stats.power).toBe(POSITIONS.OH.power);
    game.mode.teardown();
  });
});

describe('a level is a league: what its players do', () => {
  const passers = [
    { x: -3, z: 6 },
    { x: 0, z: 6.5 },
    { x: 3, z: 6 },
  ];

  it('a Rec server just gets it in: mostly the middle of the court, never a seam, a corner or short', () => {
    const ai = tuningFor('rec', 'theirs');
    const rng = new Rng(5);
    let middle = 0;
    for (let i = 0; i < 400; i++) {
      const p = serveAim(ai, passers, -1, rng, false, passers[2]);
      if (Math.abs(p.x) < 2.5 && Math.abs(-p.z - 4.5) < 2.5) middle++;
    }
    expect(middle / 400).toBeGreaterThan(0.6);
    expect([ai.serve.seam, ai.serve.deep, ai.serve.short, ai.serve.weakest]).toEqual([0, 0, 0, 0]);
  });

  it('a Pro server goes at the passer who has passed worst; a National one does not look', () => {
    const near = (p: { x: number; z: number }, q: { x: number; z: number }) => Math.hypot(p.x - q.x, -p.z - q.z) < 1.2;
    const count = (level: LevelId) => {
      const ai = tuningFor(level, 'theirs');
      const rng = new Rng(9);
      let worst = 0;
      let other = 0;
      for (let i = 0; i < 600; i++) {
        const p = serveAim(ai, passers, -1, rng, false, passers[2]);
        if (near(p, passers[2])) worst++;
        if (near(p, passers[0])) other++;
      }
      return worst - other;
    };
    expect(count('pro')).toBeGreaterThan(60);
    expect(Math.abs(count('national'))).toBeLessThan(40);
  });

  it("the server's team scouts their passers: the one whose passes came down furthest off the setter's spot, once two passes are seen", () => {
    const scout = new Scout(AI);
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
    const off = (level: LevelId) => readSpots(tuningFor(level, 'theirs'), { x: 3.5, off: 0.5, kind: 'pin' }).OH1!.z;
    expect(off('rec')).toBeLessThan(1.5);
    expect(off('club')).toBeLessThan(1.5);
    expect(off('national')).toBeGreaterThan(2.5);
    expect(off('pro')).toBeGreaterThan(2.5);
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
    expect(away.MB).toBeCloseTo(reads.MB * t.us.ai.setterSees.away, 6);
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

// (400 s a level keeps the suite quick, and the rally is seeded, so it plays the same every run. One
// seed is a few dozen points: these are the facts that hold by a wide margin. `npm run levels` plays
// an hour a level on four seeds and prints the whole card, for tuning)
describe('a league against your team (all-AI Mini Rally, 400 s a level, your slot a Pro stand-in)', () => {
  const rec = playLevel('rec', 400, 7);
  const pro = playLevel('pro', 400, 7);
  const share = (n: number, of: number) => (of ? n / of : 0);
  const tips = (t: TeamCard) => share(t.tips, t.attacks);
  const kills = (t: TeamCard) => share(t.kills, t.attacks);

  it('a Rec side tips far more than a Pro one, and hardly ever hits out or into the net', () => {
    expect(tips(rec.theirs)).toBeGreaterThan(2 * tips(pro.theirs));
    expect(share(rec.theirs.errors, rec.theirs.attacks)).toBeLessThan(0.05);
  });

  it('a Rec side’s attack kills far less often than a Pro one’s: the points are yours to win', () => {
    expect(kills(rec.theirs)).toBeLessThan(0.7 * kills(pro.theirs));
  });

  it('against a Rec side a decent hit scores: their block is small and soft and their diggers shank it', () => {
    // (your slot is a Pro stand-in: it hits as well as it can)
    expect(share(rec.you.kills, rec.you.attacks)).toBeGreaterThan(0.6);
    expect(share(rec.you.kills, rec.you.attacks)).toBeGreaterThan(share(pro.you.kills, pro.you.attacks));
    expect(rec.you.stuffed).toBe(0);
  });

  it('at Rec both teams pass well: most sets are in system', () => {
    expect(share(rec.yours.inSystem, rec.yours.sets)).toBeGreaterThan(0.6);
    expect(share(rec.theirs.inSystem, rec.theirs.sets)).toBeGreaterThan(0.6);
  });

  it('a Rec setter never sets a quick and a Rec side never dives; at Pro both happen', () => {
    // (both setters set at the level; your team digs at Pro, so only theirs never dives)
    expect(rec.theirs.quicks + rec.yours.quicks).toBe(0);
    expect(rec.theirs.dives).toBe(0);
    expect(pro.theirs.quicks + pro.yours.quicks).toBeGreaterThan(0);
    expect(pro.theirs.dives).toBeGreaterThan(0);
  });

  it('a Rec hitter who cannot hit a ball sets it back over with the hands, and somebody plays it', () => {
    expect(rec.theirs.setOvers + rec.yours.setOvers).toBeGreaterThan(0);
    expect(rec.theirs.setOverDrops + rec.yours.setOverDrops).toBe(0);
  });
});
