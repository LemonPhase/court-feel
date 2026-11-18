import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { isInsideRun, planToPoint, simulateApproach } from '../src/game/approach';
import { AI, PLAYBOOK, PLAYER } from '../src/config';
import { Athlete } from '../src/game/athlete';
import { callSheet } from '../src/game/callRuns';
import { COMBOS } from '../src/game/combos';
import {
  callsOf,
  clashes,
  clashWith,
  hitX,
  playbook,
  sanitizePlaybook,
  savePlay,
  toCombo,
  usePlaybookStore,
  wheelPlays,
  type Playbook,
  type SavedPlay,
} from '../src/game/playbook';
import { attackHeight, SETTER_PLAYS, SETTER_SPOT } from '../src/game/plays';
import { SETTER_KEYS, SetterCalls } from '../src/game/setterCalls';

/** the X with the outside on a 3 and the bic behind it */
function myPlay(): SavedPlay {
  return { name: 'Inside out', calls: { ...callsOf(COMBOS.find((c) => c.name === 'X')!), OH: '3', PIPE: 'Bic' } };
}

describe('your own plays (start screen, Plays)', () => {
  it('a play is one set for each hitter, from the sets their key steps through: a built-in play read back is itself', () => {
    for (const c of COMBOS) expect(callsOf(c)).toEqual(c.calls);
    expect(toCombo(myPlay()).calls).toEqual({ OH: '3', MB: '1', OPP: 'X', PIPE: 'Bic' });
  });
  it('a saved play is called like any other: every hitter gets its set, and the strip names it', () => {
    const mine = toCombo(myPlay());
    const wheel = COMBOS.map((b, i) => (i === 1 ? mine : b));
    const c = new SetterCalls();
    expect(c.setCombo(mine)).toBe(true);
    expect(SETTER_KEYS.map((k) => c.play(k).short)).toEqual(['3', '1', 'X', 'Bic']);
    expect(c.combo(wheel)).toBe(mine);
    expect(callSheet(c, SETTER_KEYS, c.target()).items.find((i) => i.id === 'OH')).toMatchObject({ call: '3' });
    // the hitter's key again still steps through their sets, and then it is no longer that play
    c.press('OH');
    c.press('OH');
    expect(c.combo(wheel)).not.toBe(mine);
  });
  it('two front-row hitters are never sent to the same spot at the net: a back quick for the middle and the opposite, a 2 and an X', () => {
    const base = callsOf(COMBOS[0]);
    expect(clashWith({ ...base, MB: 'Back 1' }, 'OPP', 'Back 1')).toBe('MB');
    expect(clashWith({ ...base, MB: 'Back 1' }, 'OPP', 'Back 2')).toBe('MB');
    expect(clashWith({ ...base, OPP: 'X' }, 'OH', '2')).toBe('OPP');
    expect(clashWith({ ...base, OH: '2' }, 'MB', 'Push')).toBe('OH');
    expect(clashes({ ...base, MB: 'Back 1', OPP: 'Back 1' })).toBe(true);
    // with room between them it is a play: the opposite's back set behind the middle's back quick
    expect(clashWith({ ...base, MB: 'Back 1' }, 'OPP', 'Back')).toBeNull();
    // the pipe is hit 2 m off the net, behind them: a pipe behind the quick, along the net from
    // where the middle hits it, is a play
    const pipeBehind = (mb: string, pipe: string) => {
      const gap = Math.abs(hitX(SETTER_PLAYS.PIPE.find((p) => p.short === pipe)!) - hitX(SETTER_PLAYS.MB.find((p) => p.short === mb)!));
      expect(gap, `${pipe} behind the ${mb}`).toBeLessThan(PLAYBOOK.minGap);
      expect(clashWith({ ...base, MB: mb }, 'PIPE', pipe)).toBeNull();
      expect(clashes({ ...base, MB: mb, PIPE: pipe })).toBe(false);
    };
    pipeBehind('1', 'Bic');
    pipeBehind('Back 1', 'Behind');
  });
  it('every built-in play leaves each front-row hitter their own spot (the tandem and the X hit beside the quick, not on it)', () => {
    for (const c of COMBOS) expect(clashes(c.calls), c.name).toBe(false);
    const quick = hitX(SETTER_PLAYS.MB[0]);
    for (const [k, short] of [
      ['OH', '2'],
      ['OPP', 'X'],
    ] as const)
      expect(Math.abs(hitX(SETTER_PLAYS[k].find((p) => p.short === short)!) - quick)).toBeGreaterThanOrEqual(PLAYBOOK.minGap);
  });
  it('a play is saved to a place on the wheel, kept where the app keeps it, and nowhere that is not a place', () => {
    let kept: Playbook | null = null;
    usePlaybookStore({ load: () => null, save: (b) => (kept = b.slice()) });
    const play: SavedPlay = { name: 'Mine', calls: callsOf(COMBOS[2]) };
    for (const slot of [NaN, 1.5, -1, COMBOS.length]) expect(savePlay(slot, play), String(slot)).toBe(false);
    expect(kept).toBeNull();
    expect(savePlay(1, play)).toBe(true);
    expect(kept![1]?.name).toBe('Mine');
    expect(wheelPlays()[1].name).toBe('Mine');
    // what the app gave back is read again, and a store that throws leaves no saved plays
    usePlaybookStore({ load: () => kept, save: () => {} });
    expect(playbook()[1]?.name).toBe('Mine');
    usePlaybookStore({
      load: () => {
        throw new Error('blocked');
      },
      save: () => {},
    });
    expect(playbook().every((p) => p === null)).toBe(true);
    usePlaybookStore(null);
  });
  it('stored plays are untrusted: one per place on the wheel; no name, or two hitters on one spot, and it is dropped', () => {
    const book = sanitizePlaybook([
      null,
      { name: '   A   very long name for a play that goes on  ', calls: { OH: 'Go', MB: 'Warp', OPP: 7 } },
      { name: '', calls: myPlay().calls },
      { calls: myPlay().calls },
      { name: 'Crash', calls: { ...myPlay().calls, MB: 'Back 1', OPP: 'Back 1' } },
      'junk',
    ]);
    expect(book.length).toBe(COMBOS.length);
    expect(book.filter(Boolean).length).toBe(1);
    const p = book[1]!;
    expect(p.name.length).toBeLessThanOrEqual(PLAYBOOK.nameMax);
    expect(p.name.startsWith('A very')).toBe(true);
    // a set the hitter does not have: their first one
    expect(p.calls).toEqual({ OH: 'Go', MB: SETTER_PLAYS.MB[0].short, OPP: SETTER_PLAYS.OPP[0].short, PIPE: SETTER_PLAYS.PIPE[0].short });
    expect(sanitizePlaybook('nope').every((e) => e === null)).toBe(true);
  });
});

describe('a pin hitter going inside (AI.insideRun)', () => {
  const inside = [
    ['OH', '3'],
    ['OH', '2'],
    ['OPP', 'X'],
    ['OPP', 'Back 2'],
  ] as const;
  const plan = (k: 'OH' | 'OPP', short: string) => {
    const lane = SETTER_PLAYS[k].find((p) => p.short === short)!.lane;
    const a = new Athlete(k, 1);
    a.place(lane.sx, lane.sz, 0);
    const p = planToPoint(a, 0, new THREE.Vector3(lane.x, attackHeight(a), lane.z), 2.2, 0, 0, undefined, 0, true)!;
    const off = simulateApproach(
      a,
      0,
      p.tStart,
      p.tPress,
      p.hold,
      p.dir,
      p.runYaw,
      p.airYaw,
      p.tPress + p.hold + 0.03,
      p.bend,
      p.total,
      p.carry,
    );
    return { lane, p, speed: Math.hypot(off.vel.x, off.vel.z), run: Math.hypot(off.pos.x - p.feet.x, off.pos.z - p.feet.z) };
  };
  it('the 3, the 2, the X and the back 2 are runs inside; a go or a high ball to the pin is not', () => {
    for (const [k, short] of inside) expect(plan(k, short).p.inside, short).toBe(true);
    expect(plan('OH', 'Go').p.inside).toBe(false);
    expect(plan('OH', 'High').p.inside).toBe(false);
    expect(plan('OPP', 'Back').p.inside).toBe(false);
    // straight at the net is never one, however long
    expect(isInsideRun(new THREE.Vector3(0, 0, -1), 1, 6)).toBe(false);
  });
  it('they do not brake for the jump: they leave the floor faster than off a pin approach and fly further to the ball', () => {
    const go = plan('OH', 'Go');
    for (const [k, short] of inside) {
      const r = plan(k, short);
      expect(r.p.carry, short).toBe(AI.insideRun.carry);
      expect(r.speed, short).toBeGreaterThan(go.speed + 1);
      expect(r.run, short).toBeGreaterThan(go.run + 0.3);
      // and the feet still come down under the ball
      expect(r.p.error, short).toBeLessThan(0.12);
    }
    expect(go.p.carry).toBe(PLAYER.plantCarry);
  });
  it('nothing gives the play away: an inside call starts within 1.6 m of where that hitter’s pin sets start', () => {
    for (const [k, short] of inside) {
      const { lane } = plan(k, short);
      const pin = SETTER_PLAYS[k][0].lane;
      expect(Math.hypot(lane.sx - pin.sx, lane.sz - pin.sz), short).toBeLessThan(1.6);
      // still outside the setter (the run goes in from the pin)
      expect(Math.abs(lane.sx)).toBeGreaterThan(Math.abs(SETTER_SPOT.x) + 2);
    }
  });
});
