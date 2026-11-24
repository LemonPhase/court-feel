import { afterEach, describe, expect, it } from 'vitest';
import { AI, SIM, type PositionId } from '../src/config';
import { Athlete } from '../src/game/athlete';
import { COMBOS } from '../src/game/combos';
import { SET_PLAYS, SETTER_SPOT, SETTER_TARGET } from '../src/game/plays';
import { clashes, hitX } from '../src/game/setterCalls';
import { Simulation } from '../src/game/simulation';
import { solveApex } from '../src/physics/solve';
import { SLOT_ROLE, SLOTS, TeamAI, USER_SLOT } from '../src/ai/team';
import { NO_HOOKS } from './simHooks';

const DT = 1 / SIM.hz;
const PLAYS = { ...AI.plays };
afterEach(() => Object.assign(AI.plays, PLAYS));

/**
 * A Mini Rally team on `side` (the user in `pos`, or all AI), its setter running plays, in a real
 * simulation built with no browser: the team reads its ball, its clock and its random stream.
 */
function team(side: 1 | -1, pos: PositionId | null) {
  const g = new Simulation(NO_HOOKS);
  g.rng.reseed(7);
  const ball = g.ball;
  const t = new TeamAI(side, g, AI);
  t.playsOn = true;
  for (const slot of SLOTS) {
    const mine = !!pos && slot === USER_SLOT[pos];
    const a = new Athlete(SLOT_ROLE[slot], side);
    if (mine) a.isUser = true;
    t.add(slot, a, mine);
  }
  /** a new rally: we receive their serve (the ball dead until it is served) */
  const rally = () => {
    g.ballLive = false;
    t.place('receive');
    t.step();
  };
  /** the libero passes to (x, z) on our side (home-side numbers, mirrored for the far team) */
  const pass = (x: number, z: number) => {
    const from = { x: 2.4 * side, y: 0.85, z: 6.0 * side };
    const out = { x: 0, y: 0, z: 0 };
    solveApex(from, { x: x * side, y: 2.5, z: z * side }, 4.1, { x: 0, y: 0, z: 0 }, out);
    ball.launch(from, out, undefined, 0, g.simTime);
    g.ballLive = true;
    ball.lastTouch = { athlete: t.players.get('L')!, kind: 'pass', t: g.simTime, side };
    g.simTime += DT;
    t.step();
  };
  /** their free ball coming over to the middle of our court */
  const theirFree = () => {
    const from = { x: 0, y: 2.6, z: -3 * side };
    const out = { x: 0, y: 0, z: 0 };
    solveApex(from, { x: 0, y: 0.5, z: 5 * side }, 5.5, { x: 0, y: 0, z: 0 }, out);
    ball.launch(from, out, undefined, 0, g.simTime);
    g.ballLive = true;
    ball.lastTouch = { athlete: null, kind: 'free', t: g.simTime, side: -side as 1 | -1 };
    g.simTime += DT;
    t.step();
  };
  const flight = () => {
    for (let i = 0; i < SIM.hz * 0.6; i++) {
      g.simTime += DT;
      ball.step(DT, g.env);
      t.step();
    }
  };
  return { g, team: t, rally, pass, theirFree, flight };
}

describe('AI setters run combination plays (Mini Rally)', () => {
  it('the setter signals a play before about a quarter of the serves, and calls one on most free balls', () => {
    const { team: t, rally, theirFree } = team(1, null);
    let receive = 0;
    let free = 0;
    const N = 600;
    for (let i = 0; i < N; i++) {
      rally();
      if (t.play) receive++;
      // (a free ball is the other team's possession: the serve-receive play is over by then)
      rally();
      t.play = null;
      theirFree();
      if (t.play) free++;
    }
    expect(receive / N).toBeGreaterThan(AI.plays.receive - 0.06);
    expect(receive / N).toBeLessThan(AI.plays.receive + 0.06);
    expect(free / N).toBeGreaterThan(AI.plays.free - 0.06);
    expect(free / N).toBeLessThan(AI.plays.free + 0.06);
  });

  it('a play signalled before the serve runs off a perfect pass', () => {
    AI.plays.receive = 1;
    const { team: t, rally, pass } = team(1, null);
    rally();
    expect(t.play?.state).toBe('signalled');
    pass(SETTER_TARGET.x, SETTER_TARGET.z);
    expect(t.play?.state).toBe('running');
  });

  it('off a pass that is in system but not perfect, the serve-receive play is off and the hitters go back to their own lanes', () => {
    AI.plays.receive = 1;
    const { team: t, rally, pass } = team(1, null);
    rally();
    pass(SETTER_SPOT.x, SETTER_SPOT.z + 1.2);
    expect(t.play?.state).toBe('off');
    const mb = t.brains.get(t.players.get('MB')!)!.hitter!;
    expect(mb.inFront).toBeUndefined();
    const oh = t.brains.get(t.players.get('OH1')!)!.hitter!;
    expect(oh.lane.label).toBe('Outside high ball (4)');
  });

  it('a free-ball play runs off any pass in system, not only a perfect one', () => {
    AI.plays.free = 1;
    const { team: t, theirFree, pass } = team(1, null);
    theirFree();
    expect(t.play?.on).toBe('free');
    pass(SETTER_SPOT.x, SETTER_SPOT.z + 1.2);
    expect(t.play?.state).toBe('running');
  });

  it('your call wins: the play is built around your route, and no two front-row hitters hit from one spot', () => {
    AI.plays.receive = 1;
    const { team: t, rally } = team(1, 'OPP');
    t.userPlay = SET_PLAYS.OPP!.find((p) => p.short === 'X')!;
    const names = new Set<string>();
    for (let i = 0; i < 200; i++) {
      rally();
      const v = t.playView()!;
      expect(v.calls.OPP).toBe('X');
      expect(clashes(v.calls)).toBe(false);
      names.add(v.name);
    }
    // the tandem sends the outside to the same spot as your X: it is never called round it
    expect(names.has('Tandem')).toBe(false);
    expect(names.size).toBeGreaterThan(3);
  });

  it('you change your route after the play is signalled: the setter calls one that fits round it', () => {
    AI.plays.receive = 1;
    const { team: t, rally } = team(1, 'OH');
    const X = COMBOS.find((c) => c.name === 'X')!;
    const tandem = COMBOS.find((c) => c.name === 'Tandem')!;
    t.playPool = () => [X];
    rally();
    expect(t.playView()?.name).toBe('X');
    // the 2 is hit where the opposite's X is: the X no longer fits, the tandem does
    t.playPool = () => [X, tandem];
    t.userPlay = SET_PLAYS.OH!.find((p) => p.short === '2')!;
    const v = t.playView()!;
    expect(v.name).toBe('Tandem');
    expect(v.state).toBe('signalled');
    expect(clashes(v.calls)).toBe(false);
    // and the opposite runs the tandem's route, not the X
    const opp = t.brains.get(t.players.get('OPP')!)!.hitter!;
    expect(opp.lane.label).toBe('Opposite back set (red)');
  });

  it('you change your route and no play fits round it: the setter drops the play, every hitter back on their own lane', () => {
    AI.plays.receive = 1;
    const { team: t, rally } = team(1, 'OH');
    t.playPool = () => COMBOS.filter((c) => c.name === 'X');
    rally();
    t.userPlay = SET_PLAYS.OH!.find((p) => p.short === '2')!;
    expect(t.play).toBeNull();
    const opp = t.brains.get(t.players.get('OPP')!)!.hitter!;
    expect(opp.lane.label).toBe('Opposite back set (red)');
  });

  it('you change your route once the play is running: the team-mate in your way gives way (no set to their spot)', () => {
    AI.plays.receive = 1;
    const { team: t, rally, pass } = team(1, 'OH');
    t.playPool = () => COMBOS.filter((c) => c.name === 'X');
    rally();
    pass(SETTER_TARGET.x, SETTER_TARGET.z);
    expect(t.play?.state).toBe('running');
    t.userPlay = SET_PLAYS.OH!.find((p) => p.short === '2')!;
    const v = t.playView()!;
    expect(v.calls.OH).toBe('2');
    expect(v.calls.OPP).not.toBe('X');
    expect(clashes(v.calls)).toBe(false);
    const x = SET_PLAYS.OPP!.find((p) => p.short === 'X')!;
    expect(t.brains.get(t.players.get('OPP')!)!.hitter!.lane.label).not.toBe(x.lane.label);
  });

  it('our first touch on their free ball is an attack (an overpass hit straight back): the play is off, and over at their touch', () => {
    AI.plays.free = 1;
    const { g, team: t, theirFree } = team(1, null);
    theirFree();
    expect(t.play?.state).toBe('signalled');
    g.ball.lastTouch = { athlete: t.players.get('OH1')!, kind: 'spike', t: g.simTime, side: 1 };
    g.simTime += DT;
    t.step();
    expect(t.play?.state).toBe('off');
    // (their attack back: a dig of theirs coming over would be a free ball, and a new play on it)
    g.ball.lastTouch = { athlete: null, kind: 'spike', t: g.simTime, side: -1 };
    g.simTime += DT;
    t.step();
    expect(t.play).toBeNull();
    // and their next free ball can bring a new play
    theirFree();
    expect(t.play?.state).toBe('signalled');
  });

  it('a running play with nobody left to set on it: the play is off, so the hitters are back on the lanes the base sets go to', () => {
    AI.plays.receive = 1;
    const { g, team: t, rally, pass } = team(1, null);
    t.playPool = () => COMBOS.filter((c) => c.name === 'X');
    rally();
    pass(SETTER_TARGET.x, SETTER_TARGET.z);
    expect(t.play?.state).toBe('running');
    const S = t.players.get('S')!;
    S.place(SETTER_SPOT.x, SETTER_SPOT.z, Math.PI / 2);
    for (const slot of ['OH1', 'MB', 'OPP', 'OH2'] as const) t.players.get(slot)!.state = 'dive';
    t.callSet(g, S);
    expect(t.play?.state).toBe('off');
    expect(t.brains.get(t.players.get('OPP')!)!.hitter!.lane.label).toBe('Opposite back set (red)');
  });

  it("their setter's play is run on their side of the net: their opposite's X crosses on their court", () => {
    AI.plays.receive = 1;
    const { team: t, rally } = team(-1, null);
    t.playPool = () => COMBOS.filter((c) => c.name === 'X');
    rally();
    const opp = t.brains.get(t.players.get('OPP')!)!.hitter!;
    const x = SET_PLAYS.OPP!.find((p) => p.short === 'X')!;
    expect(opp.lane.z).toBeLessThan(0);
    expect(opp.lane.x).toBeCloseTo(-hitX(x), 6);
    expect(opp.lane.sx).toBeCloseTo(-x.lane.sx, 6);
  });

  it('a new rally ends the play: every hitter is back on their own lane', () => {
    AI.plays.receive = 1;
    const { team: t, rally, pass } = team(1, null);
    rally();
    pass(SETTER_TARGET.x, SETTER_TARGET.z);
    AI.plays.receive = 0;
    rally();
    expect(t.play).toBeNull();
    const opp = t.brains.get(t.players.get('OPP')!)!.hitter!;
    expect(opp.lane.label).toBe('Opposite back set (red)');
    expect(t.brains.get(t.players.get('MB')!)!.hitter!.inFront).toBeUndefined();
  });

  it("picking a play never shifts the game's own random draws", () => {
    AI.plays.receive = 1;
    const plays = team(1, null);
    const none = team(1, null);
    none.team.playsOn = false;
    plays.rally();
    none.rally();
    expect(plays.team.play).not.toBeNull();
    expect(plays.g.rng.next()).toBe(none.g.rng.next());
  });
});
