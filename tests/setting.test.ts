import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { AI, ASSIST, BALL, CONTACT, COURT, SET_LEVEL_IDS, SET_LEVELS, SIM, TIMING, type SetLevel } from '../src/config';
import { Rng } from '../src/core/mathx';
import { Athlete } from '../src/game/athlete';
import { ContactSystem, type ContactEvent, type ContactHost, type SetOption, type SetPreview } from '../src/game/contact';
import { D_PLAY, isQuick, needsGoodPass, SETTER_PLAYS, SETTER_SPOT } from '../src/game/plays';
import { callSheet, dumpOption } from '../src/game/callRuns';
import { COMBOS } from '../src/game/combos';
import { clashes, SETTER_KEYS, SetterCalls, type SetPick, type SetterKey } from '../src/game/setterCalls';
import { wheelSlice } from '../src/ui/playWheel';
import { catchQuality, gradeRelease, setMiss, setShape, setTouch, setWindow, type SetShape } from '../src/game/setTiming';
import { makeBall, stepBall, type BallState } from '../src/physics/ball';
import { BallPredictor } from '../src/physics/predict';
import { solveApex } from '../src/physics/solve';

const DT = 1 / SIM.hz;
const ENV = { netTop: COURT.netHeightMen };

/** a high ball from the setter's spot, standing, in system */
const easy: SetShape = { window: 1, fast: false, outOfSystem: false };
const W = CONTACT.setTouch.window;
const win = (stillT: number, catchErr: number, centreD = 0, shape = easy, level: SetLevel = 'easy') =>
  setWindow(setTouch(stillT, catchErr, centreD, 0.48, shape, level), level);

describe('the set window: your touch and the level set its size', () => {
  it('a release at the top of the bar is green; a whole good window early or late is not', () => {
    const w = win(1, 0);
    expect(gradeRelease(0, w).grade).toBe('Perfect');
    expect(gradeRelease(-w.good * 1.01, w).grade).toBe('Early');
    expect(gradeRelease(w.good * 1.01, w).grade).toBe('Late');
  });
  it('Easy starts forgiving: the best touch on a high ball gets ±60 ms of game time (±240 ms on screen), good twice that', () => {
    const w = win(1, 0);
    expect(w.green).toBeCloseTo(0.06, 5);
    expect(w.green / ASSIST.setSlowmoLoad).toBeCloseTo(0.24, 5);
    expect(w.good).toBeCloseTo(0.12, 5);
    expect(gradeRelease(0.059, w).grade).toBe('Perfect');
    expect(gradeRelease(-0.09, w).grade).toBe('Good');
  });
  it('holding the ball until it is a lift is never a good set, on any level, with the set cues on or off', () => {
    for (const id of SET_LEVEL_IDS) {
      expect(SET_LEVELS[id].green[0] * SET_LEVELS[id].goodMul).toBeLessThan(TIMING.setHoldMax);
      // by feel the good band and the hold are both ASSIST.setByFeel wider
      const w = setWindow(setTouch(1, 0, 0, 0.48, easy, id, undefined, ASSIST.setByFeel), id, ASSIST.setByFeel);
      expect(w.good).toBeLessThan(TIMING.setHoldMax * ASSIST.setByFeel);
    }
  });
  it('on every level the bar takes about 0.6 s on screen (the ball is in the hands 0.15 s of game time, at quarter speed)', () => {
    expect(TIMING.setLoad / ASSIST.setSlowmoLoad).toBeCloseTo(0.6, 5);
  });
  it('each level is harder than the one before: a smaller green, good window and clean catch', () => {
    for (let i = 1; i < SET_LEVEL_IDS.length; i++) {
      const a = SET_LEVELS[SET_LEVEL_IDS[i - 1]];
      const b = SET_LEVELS[SET_LEVEL_IDS[i]];
      expect(b.green[0]).toBeLessThan(a.green[0]);
      expect(b.green[1]).toBeLessThan(a.green[1]);
      expect(b.green[0] * b.goodMul).toBeLessThan(a.green[0] * a.goodMul);
      expect(b.catch).toBeLessThan(a.catch);
    }
  });
  it('Elite is very hard but never luck: even its smallest green spans a 60 fps frame of game time', () => {
    for (const id of SET_LEVEL_IDS) expect(SET_LEVELS[id].green[1] * 2).toBeGreaterThanOrEqual(ASSIST.setSlowmoLoad / 60);
    // on screen Elite's best green is about ±54 ms: still shorter than a real set touch (about 55-75 ms)
    expect(SET_LEVELS.elite.green[0] / ASSIST.setSlowmoLoad).toBeLessThan(0.055);
  });
  it('a clean catch costs nothing; a catch early or late shrinks the window', () => {
    const clean = SET_LEVELS.easy.catch;
    expect(catchQuality(clean * 0.9, 'easy')).toBe(1);
    expect(catchQuality(-clean * 0.9, 'easy')).toBe(1);
    expect(win(1, -0.3, 0, easy, 'normal').green).toBeLessThan(win(1, 0, 0, easy, 'normal').green);
    expect(win(1, 0.12).green).toBeLessThan(win(1, 0).green);
    expect(setTouch(1, -0.3, 0, 0.48, easy, 'normal').reasons).toContain('caught early');
    expect(setTouch(1, 0.12, 0, 0.48, easy, 'easy').reasons).toContain('caught late');
  });
  it('set by feel every window is 20% wider: the green, the good band and the clean catch', () => {
    const t = setTouch(1, 0, 0, 0.48, easy, 'normal');
    for (const level of SET_LEVEL_IDS) {
      const cued = setWindow(t, level);
      const felt = setWindow(t, level, ASSIST.setByFeel);
      expect(felt.green / cued.green).toBeCloseTo(1.2, 6);
      expect(felt.good / cued.good).toBeCloseTo(1.2, 6);
      // a catch a little past the clean one: it costs with the ring, not by feel
      const late = SET_LEVELS[level].catch * 1.1;
      expect(catchQuality(late, level)).toBeLessThan(1);
      expect(catchQuality(late, level, ASSIST.setByFeel)).toBe(1);
    }
  });
  it('on Easy, hands up early cost nothing (a beginner times the release only); from Normal up the catch is timed', () => {
    expect(catchQuality(-0.6, 'easy')).toBe(1);
    expect(win(1, -0.6).green).toBe(win(1, 0).green);
    expect(setTouch(1, -0.6, 0, 0.48, easy, 'easy').reasons).not.toContain('caught early');
    // a late catch still costs on Easy
    expect(catchQuality(0.12, 'easy')).toBeLessThan(1);
    for (const id of SET_LEVEL_IDS.filter((l) => l !== 'easy')) expect(catchQuality(-0.6, id)).toBeLessThan(1);
  });
  it('a setter still running at the touch gets a smaller window than one who beat the ball to the spot', () => {
    expect(win(0, 0).green).toBeLessThan(win(TIMING.setFeetReady, 0).green);
    expect(setTouch(0, 0, 0, 0.48, easy, 'easy').reasons).toContain('on the move');
  });
  it('a ball off to one side of the hands shrinks the window', () => {
    expect(win(1, 0, 0.4).green).toBeLessThan(win(1, 0, 0.1).green);
  });
  it('the kind of set sizes the green: a high ball and the 1 get all of it, the faster and flatter the set the less', () => {
    expect(W.high).toBe(1);
    expect(W.quick).toBe(1);
    expect(W.hut).toBeLessThan(W.high);
    // behind the setter the quick is harder, and harder still to an opposite coming in from the pin
    expect(W.backQuick).toBeLessThan(W.quick);
    expect(W.backQuickOpp).toBeLessThan(W.backQuick);
    // second tempo to a pin, and the middle's quick pushed along the net
    expect(W.tempo).toBeLessThan(W.hut);
    expect(W.push).toBeLessThan(W.backQuick);
    // the inside combination balls are the hardest in system
    expect(W.inside).toBeLessThan(W.tempo);
    expect(win(1, 0, 0, { ...easy, window: W.inside }).green).toBeCloseTo(win(1, 0).green * W.inside, 6);
    expect(setTouch(1, 0, 0, 0.48, { ...easy, window: W.tempo }, 'easy').reasons).toContain('hard set');
    expect(setTouch(1, 0, 0, 0.48, easy, 'easy').reasons).toEqual([]);
  });
  it('every call says how hard it is: only the high balls and the 1 keep the whole green', () => {
    const tier = (k: 'OH' | 'MB' | 'OPP' | 'PIPE', short: string) => SETTER_PLAYS[k].find((p) => p.short === short)!.tier;
    expect(tier('MB', '1')).toBe('quick');
    expect(tier('MB', 'Back 1')).toBe('backQuick');
    expect(tier('OPP', 'Back 1')).toBe('backQuickOpp');
    expect(tier('MB', 'Push')).toBe('push');
    expect(tier('MB', 'Shoot')).toBe('push');
    for (const p of [...Object.values(SETTER_PLAYS).flat(), D_PLAY]) {
      const share = W[p.tier ?? 'high'];
      if (['High', '1', 'Back', 'D'].includes(p.short)) expect(share, p.name).toBe(1);
      else expect(share, p.name).toBeLessThan(1);
    }
  });
  it("a pass off the net shrinks it too, and it never goes below the level's worst", () => {
    expect(win(1, 0, 0, { ...easy, outOfSystem: true }).green).toBeLessThan(win(1, 0).green);
    const hard: SetShape = { window: W.inside, fast: true, outOfSystem: true };
    for (const id of SET_LEVEL_IDS) expect(win(0, -1, 1, hard, id).green).toBe(SET_LEVELS[id].green[1]);
  });
  it('a pass the setter takes far from their spot is out of system', () => {
    expect(setShape({ x: 1, z: 3 }, 1, false).outOfSystem).toBe(true);
    expect(setShape(SETTER_SPOT, 1, false).outOfSystem).toBe(false);
    expect(AI.outOfSystem).toBeLessThan(3 - SETTER_SPOT.z);
  });
  it('early comes up short, late goes flat and long, and a green has the least spread', () => {
    const w = win(1, 0);
    const early = setMiss(gradeRelease(-0.13, w));
    const late = setMiss(gradeRelease(0.13, w));
    expect(early.shift).toBeLessThan(0);
    expect(late.shift).toBeGreaterThan(0);
    expect(late.apexDrop).toBeGreaterThan(0);
    expect(setMiss(gradeRelease(0, w)).spread).toBeLessThan(setMiss(gradeRelease(0.09, w)).spread);
  });
  it('missing the good band costs the hitter: just past it the set is almost two balls short or long, a good window past it over a metre', () => {
    const w = win(1, 0);
    const ball = 0.21;
    expect(Math.abs(setMiss(gradeRelease(-w.good * 1.01, w)).shift)).toBeGreaterThan(1.8 * ball);
    expect(setMiss(gradeRelease(w.good * 2.01, w)).shift).toBeGreaterThan(1);
    // and a set at the edge of the good band already spreads ~0.4 m along the net
    expect(setMiss(gradeRelease(w.good * 0.99, w)).spread).toBeGreaterThan(0.35);
  });
});

describe('the Setter Drill gives you time to choose, not time to wait', () => {
  const D = TIMING.setterDrill;
  it('from the end of a rep to the next pass there are at least two seconds to pick a hitter and their set', () => {
    expect(D.resultMiss + D.feed).toBeGreaterThanOrEqual(2);
    expect(D.result + D.feed).toBeGreaterThanOrEqual(2.5);
  });
  it('a ball nobody played costs less waiting than a rally: the next pass is on its way within two seconds', () => {
    expect(D.resultMiss).toBeLessThan(D.result);
    expect(D.resultMiss + D.feed).toBeLessThanOrEqual(2);
    expect(D.result + D.feed).toBeLessThan(3);
  });
  it('after the play wheel closes the pass still gives you a moment, never the whole wait again', () => {
    expect(D.settle).toBeGreaterThan(D.wind);
    expect(D.settle).toBeLessThan(D.feed);
  });
});

describe('picking the hitter (1-4) and their set (the same key again)', () => {
  it('with no key the set goes to the outside', () => {
    const c = new SetterCalls();
    expect(c.pick).toBeNull();
    expect(c.target()).toBe<SetPick>('OH');
    c.press('OPP');
    expect(c.target()).toBe<SetPick>('OPP');
  });
  it('a key picks a hitter without changing their call', () => {
    const c = new SetterCalls();
    c.press('OH');
    expect(c.pick).toBe('OH');
    expect(c.label('OH')).toBe(SETTER_PLAYS.OH[0].short);
    c.press('MB');
    expect(c.pick).toBe('MB');
    expect(c.label('OH')).toBe(SETTER_PLAYS.OH[0].short);
    expect(c.label('MB')).toBe(SETTER_PLAYS.MB[0].short);
  });
  it("before the pass, the picked key again steps through that hitter's calls and round to the first", () => {
    const c = new SetterCalls();
    c.press('OH');
    const seen: string[] = [];
    for (let i = 0; i < SETTER_PLAYS.OH.length; i++) {
      c.press('OH');
      seen.push(c.play('OH').short);
    }
    expect(seen).toEqual(['Hut', 'Go', '3', '2', 'High']);
    expect(c.step('OH')).toEqual({ i: 0, n: SETTER_PLAYS.OH.length });
    // the others keep theirs
    expect(c.play('MB').short).toBe(SETTER_PLAYS.MB[0].short);
    expect(c.play('OPP').short).toBe(SETTER_PLAYS.OPP[0].short);
  });
  it('the pipe has four: called High, the bic, the back bic and the pipe right behind the setter', () => {
    const c = new SetterCalls();
    c.press('PIPE');
    expect(c.label('PIPE')).toBe('High');
    c.press('PIPE');
    expect(c.label('PIPE')).toBe('Bic');
    expect(c.step('PIPE')).toEqual({ i: 1, n: 4 });
    const bic = c.play('PIPE').lane;
    expect(bic.apexAbove).toBeLessThan(SETTER_PLAYS.PIPE[0].lane.apexAbove);
    c.press('PIPE');
    expect(c.label('PIPE')).toBe('Back bic');
    // the same quick ball, behind the setter's back (they face the outside), met as far off the net
    expect(c.play('PIPE').lane.apexAbove).toBe(bic.apexAbove);
    expect(c.play('PIPE').lane.x).toBeGreaterThan(SETTER_SPOT.x);
    expect(c.play('PIPE').lane.z).toBe(bic.z);
    c.press('PIPE');
    expect(c.label('PIPE')).toBe('Behind');
    // behind the setter's back, and a back-row ball like the pipe
    expect(c.play('PIPE').lane.x).toBeGreaterThan(SETTER_SPOT.x);
    expect(c.play('PIPE').lane.z).toBe(SETTER_PLAYS.PIPE[0].lane.z);
  });
  it('the same key steps through the calls from the slowest ball to the pin, then the inside and behind ones', () => {
    const order = (k: SetterKey) => SETTER_PLAYS[k].map((p) => p.short);
    expect(order('OH')).toEqual(['High', 'Hut', 'Go', '3', '2']);
    expect(order('MB')).toEqual(['1', 'Push', 'Shoot', 'Back 1']);
    expect(order('OPP')).toEqual(['Back', 'Fast', 'Back 2', 'Back 1', 'X']);
    expect(order('PIPE')).toEqual(['High', 'Bic', 'Back bic', 'Behind']);
  });
  it('the high pipe is as slow as a high ball to the outside; the bic is quicker than a go', () => {
    // in the air from the setter's hands (a set from the floor at the pass target) to the hitter's contact
    const from = { x: SETTER_SPOT.x, y: 2.45, z: SETTER_SPOT.z };
    const flight = (k: SetterKey, short: string) => {
      const l = SETTER_PLAYS[k].find((p) => p.short === short)!.lane;
      const to = { x: l.x, y: 3.15, z: l.z };
      return solveApex(from, to, to.y + l.apexAbove, { x: 0, y: 0, z: 0 }, new THREE.Vector3()).T;
    };
    const high = flight('PIPE', 'High');
    const bic = flight('PIPE', 'Bic');
    expect(high).toBeGreaterThan(1.2);
    expect(Math.abs(high - flight('OH', 'High'))).toBeLessThan(0.05);
    expect(bic).toBeLessThan(0.75);
    expect(bic).toBeLessThan(flight('OH', 'Go'));
    expect(flight('PIPE', 'Back bic')).toBeLessThan(0.75);
    // the two pipes are half a second apart (they were a quarter: 1.20 s and 0.96 s)
    expect(high - bic).toBeGreaterThan(0.5);
  });
  it('once the pass is played the calls are locked: the picked key again only asks for a high ball (again: back to the call)', () => {
    const c = new SetterCalls();
    c.press('OH');
    c.press('OH');
    c.lock();
    c.press('OH');
    expect(c.play('OH').short).toBe('Hut');
    expect(c.isHigh('OH')).toBe(true);
    expect(c.label('OH')).toBe('High');
    c.press('OH');
    expect(c.isHigh('OH')).toBe(false);
    expect(c.label('OH')).toBe('Hut');
  });
  it("picking another hitter after the pass changes nobody's call", () => {
    const c = new SetterCalls();
    c.lock();
    c.press('OPP');
    c.press('MB');
    expect(c.pick).toBe('MB');
    expect(c.isHigh('OPP')).toBe(false);
    expect(c.play('OPP').short).toBe(SETTER_PLAYS.OPP[0].short);
  });
  it('a backup setting for the setter calls nothing: the keys pick, and again is a high ball', () => {
    const c = new SetterCalls();
    c.canCall = false;
    c.press('OH');
    c.press('OH');
    expect(c.play('OH').short).toBe(SETTER_PLAYS.OH[0].short);
    expect(c.isHigh('OH')).toBe(true);
  });
  it('the calls stay for the next ball; the pick and a high ball do not', () => {
    const c = new SetterCalls();
    c.press('OH');
    c.press('OH');
    c.lock();
    c.press('OH');
    c.nextBall();
    expect(c.pick).toBeNull();
    expect(c.locked).toBe(false);
    expect(c.isHigh('OH')).toBe(false);
    expect(c.play('OH').short).toBe('Hut');
  });
  it('with "keep my pick" the hitter you picked stays picked for the next ball', () => {
    const c = new SetterCalls();
    c.press('OPP');
    c.lock();
    c.nextBall(true);
    expect(c.pick).toBe('OPP');
    expect(c.locked).toBe(false);
    // already picked, so one press now steps their call
    c.press('OPP');
    expect(c.play('OPP').short).toBe(SETTER_PLAYS.OPP[1].short);
  });
  it('the call strip shows each call and how many a hitter has; the outside is lit, not picked, until a key is pressed', () => {
    const c = new SetterCalls();
    c.press('MB');
    c.press('MB');
    c.nextBall();
    const strip = callSheet(c, SETTER_KEYS, c.target(), ['MB']);
    const row = (k: SetterKey) => strip.items.find((i) => i.id === k)!;
    expect(row('OH')).toMatchObject({ lit: true, picked: false, step: 0, steps: SETTER_PLAYS.OH.length });
    expect(row('MB')).toMatchObject({ call: 'Push', step: 1, off: true, lit: false });
    expect(row('PIPE')).toMatchObject({ call: 'High', steps: 4 });
    c.press('OPP');
    expect(callSheet(c, SETTER_KEYS, c.target()).items.find((i) => i.id === 'OPP')).toMatchObject({ lit: true, picked: true });
  });
  it('stepping a call never sends two front-row hitters to one spot: with the middle on a back 1 the opposite skips the back 1 and the back 2', () => {
    const c = new SetterCalls();
    for (let i = 0; i < 10 && c.play('MB').short !== 'Back 1'; i++) c.press('MB');
    expect(c.play('MB').short).toBe('Back 1');
    const seen = new Set<string>();
    c.press('OPP');
    for (let i = 0; i < 12; i++) {
      c.press('OPP');
      seen.add(c.play('OPP').short);
    }
    expect([...seen].sort()).toEqual(
      SETTER_PLAYS.OPP.map((p) => p.short)
        .filter((s) => s !== 'Back 1' && s !== 'Back 2')
        .sort(),
    );
  });
  it('whatever keys you press before the pass, every front-row hitter keeps their own spot', () => {
    const c = new SetterCalls();
    const rng = new Rng(11);
    const shorts = () => Object.fromEntries(SETTER_KEYS.map((k) => [k, c.play(k).short])) as Record<SetterKey, string>;
    for (let i = 0; i < 400; i++) {
      c.press(SETTER_KEYS[Math.floor(rng.next() * SETTER_KEYS.length)]);
      expect(clashes(shorts()), JSON.stringify(shorts())).toBe(false);
    }
  });
  it('a team-mate sets the ball (your help key, the libero): once they play it, the next pass is a new ball', () => {
    const c = new SetterCalls();
    c.press('OPP');
    expect(c.touched({ mine: false, kind: 'pass', ours: true }, 1)).toBe(true);
    c.press('OPP'); // a high ball for the opposite, this ball
    expect(c.isHigh('OPP')).toBe(true);
    // the libero sets, our hitter attacks: still locked
    expect(c.touched({ mine: false, kind: 'set', ours: true }, 2)).toBe(false);
    expect(c.touched({ mine: false, kind: 'spike', ours: true }, 3)).toBe(false);
    expect(c.locked).toBe(true);
    // they dig it: open again, nothing asked, the pick back to the outside
    c.touched({ mine: false, kind: 'dig', ours: false }, 0);
    expect(c.locked).toBe(false);
    expect(c.isHigh('OPP')).toBe(false);
    expect(c.pick).toBe(null);
    // a pick you make during their attack stays for your next pass
    c.press('MB');
    c.touched({ mine: false, kind: 'spike', ours: false }, 0);
    expect(c.pick).toBe<SetPick>('MB');
  });
  it('your own set is the end of your ball: the calls open for the next one', () => {
    const c = new SetterCalls();
    c.touched({ mine: false, kind: 'pass', ours: true }, 1);
    c.touched({ mine: true, kind: 'set', ours: true }, 2);
    expect(c.locked).toBe(false);
  });
  it('the keys go through the input: Digit1 outside ... Digit4 pipe', () => {
    const c = new SetterCalls();
    const pressed = new Set(['Digit4']);
    c.readKeys({ consumePress: (code: string) => pressed.delete(code) });
    expect(c.pick).toBe<SetPick>('PIPE');
  });
});

describe('combination plays (the play wheel)', () => {
  it('every play calls a set each hitter really has', () => {
    for (const combo of COMBOS)
      for (const k of SETTER_KEYS)
        expect(
          SETTER_PLAYS[k].map((p) => p.short),
          `${combo.name} ${k}`,
        ).toContain(combo.calls[k]);
    expect(new Set(COMBOS.map((c) => c.name)).size).toBe(COMBOS.length);
  });
  it('calling a play sets every hitter at once, and the strip names it', () => {
    const c = new SetterCalls();
    const x = COMBOS.find((p) => p.name === 'X')!;
    expect(c.setCombo(x)).toBe(true);
    expect(SETTER_KEYS.map((k) => c.play(k).short)).toEqual(['Go', '1', 'X', 'High']);
    expect(c.combo()?.name).toBe('X');
    expect(callSheet(c, SETTER_KEYS, c.target()).play).toBe('X');
    // change one hitter and it is no longer that play
    c.press('OH');
    c.press('OH');
    expect(c.combo()?.name).not.toBe('X');
  });
  it('the X crosses: the opposite starts on the right and hits left of the middle’s quick', () => {
    const x = SETTER_PLAYS.OPP.find((p) => p.short === 'X')!.lane;
    const one = SETTER_PLAYS.MB[0].lane;
    expect(x.sx).toBeGreaterThan(SETTER_SPOT.x);
    expect(x.x).toBeLessThan(one.x);
    // second tempo behind a first-tempo quick: the same blocker has to choose
    expect(needsGoodPass(SETTER_PLAYS.OPP.find((p) => p.short === 'X')!)).toBe(true);
    expect(isQuick(SETTER_PLAYS.MB[0])).toBe(true);
  });
  it('the double quick is a quick in front of the setter and one behind', () => {
    const d = COMBOS.find((p) => p.name === 'Double quick')!;
    const mb = SETTER_PLAYS.MB.find((p) => p.short === d.calls.MB)!;
    const opp = SETTER_PLAYS.OPP.find((p) => p.short === d.calls.OPP)!;
    expect(isQuick(mb) && isQuick(opp)).toBe(true);
    expect(mb.inFront!).toBeGreaterThan(0);
    expect(opp.inFront!).toBeLessThan(0);
  });
  it('a play is called before the pass: once it is played the hitters are already running', () => {
    const c = new SetterCalls();
    c.lock();
    expect(c.setCombo(COMBOS[1])).toBe(false);
    expect(c.play('OH').short).toBe(SETTER_PLAYS.OH[0].short);
  });
  it('the wheel: the mouse picks the slice it moves towards, the top one first, then clockwise', () => {
    const n = COMBOS.length;
    expect(wheelSlice(0, 0, n, 24)).toBe(-1);
    expect(wheelSlice(3, -5, n, 24)).toBe(-1);
    expect(wheelSlice(0, -60, n, 24)).toBe(0);
    expect(wheelSlice(60, 0, n, 24)).toBe(n / 4);
    expect(wheelSlice(0, 60, n, 24)).toBe(n / 2);
    expect(wheelSlice(-60, 0, n, 24)).toBe((3 * n) / 4);
    expect(wheelSlice(-40, -40, n, 24)).toBe(n - 1);
  });
});

describe('out of system: high balls, unless you ask a hitter for their fast set', () => {
  const oos = () => {
    const c = new SetterCalls();
    c.lock(true);
    return c;
  };
  it('off a bad pass everyone gets a high ball', () => {
    const c = oos();
    for (const k of ['OH', 'OPP', 'PIPE'] as SetterKey[]) expect(c.isHigh(k)).toBe(true);
    c.press('OH');
    expect(c.label('OH')).toBe('High');
    expect(c.asksFast('OH')).toBe(false);
  });
  it('the key again asks for their fast set: the go for the outside, the fast back for the opposite', () => {
    const c = oos();
    c.press('OH');
    c.press('OH');
    expect(c.asksFast('OH')).toBe(true);
    expect(c.play('OH').short).toBe('Go');
    expect(c.isHigh('OH')).toBe(false);
    c.press('OPP');
    c.press('OPP');
    expect(c.play('OPP').short).toBe('Fast');
  });
  it('a hitter whose call was already fast is asked for that one', () => {
    const c = new SetterCalls();
    c.press('OH');
    c.press('OH');
    c.press('OH');
    c.press('OH');
    expect(c.play('OH').short).toBe('3');
    c.lock(true);
    c.press('OH');
    expect(c.play('OH').short).toBe('3');
    expect(c.asksFast('OH')).toBe(true);
  });
  it('nobody sets a middle a high ball: picking them is asking for the quick', () => {
    const c = oos();
    c.press('MB');
    expect(c.asksFast('MB')).toBe(true);
    expect(c.play('MB').short).toBe(SETTER_PLAYS.MB[0].short);
  });
  it('they have to hear it in time: asked too late they stay for the high ball', () => {
    const c = oos();
    c.canAsk = () => false;
    c.press('OH');
    c.press('OH');
    expect(c.asksFast('OH')).toBe(false);
    expect(c.isHigh('OH')).toBe(true);
    expect(c.takeLate()).toBe('OH');
    expect(c.takeLate()).toBeNull();
  });
  it('once asked they are running: asking again changes nothing, and the mode is told once', () => {
    const c = oos();
    const asked: SetterKey[] = [];
    c.onAsk = (k) => asked.push(k);
    c.press('OH');
    c.press('OH');
    c.press('OH');
    expect(c.asksFast('OH')).toBe(true);
    expect(asked).toEqual(['OH']);
  });
  it("it is very hard: even with a perfect touch, a fast set off the net gets the level's smallest green", () => {
    for (const id of SET_LEVEL_IDS) {
      const high = win(1, 0, 0, { ...easy, outOfSystem: true }, id);
      const fast = win(1, 0, 0, { ...easy, outOfSystem: true, fast: true }, id);
      expect(fast.green).toBeLessThanOrEqual(high.green);
      expect(fast.green).toBe(SET_LEVELS[id].green[1]);
    }
  });
  it('the next ball starts in system again, nothing asked', () => {
    const c = oos();
    c.press('MB');
    c.nextBall();
    expect(c.oos).toBe(false);
    expect(c.asksFast('MB')).toBe(false);
  });
});

describe('the setter front row: the D and the dump', () => {
  const setter = (z: number) => {
    const a = new Athlete('S', 1);
    a.place(SETTER_SPOT.x, z, Math.PI / 2);
    return a;
  };
  it('a back-row setter has no dump: key 5 does nothing', () => {
    const c = new SetterCalls();
    c.press('DUMP');
    expect(c.pick).toBeNull();
    expect(dumpOption(c, setter(0.7), ENV.netTop)).toBeNull();
  });
  it('front row, the opposite is in the back row: their one call is the D, hit from behind the 3 m line', () => {
    const c = new SetterCalls();
    c.frontRow = true;
    expect(c.play('OPP').short).toBe('D');
    expect(c.step('OPP').n).toBe(1);
    expect(D_PLAY.lane.sz).toBeGreaterThan(COURT.attackLine);
  });
  it('front row, 5 picks the dump: short behind the block, again for the deep corner', () => {
    const c = new SetterCalls();
    c.frontRow = true;
    c.press('DUMP');
    expect(c.target()).toBe<SetPick>('DUMP');
    const short = dumpOption(c, setter(0.7), ENV.netTop)!;
    expect(short.dump).toBe(true);
    expect(short.target.z).toBeLessThan(0);
    c.press('DUMP');
    const deep = dumpOption(c, setter(0.7), ENV.netTop)!;
    expect(deep.target.z).toBeLessThan(short.target.z - 4);
    expect(deep.label).toBe('Dump deep');
  });
  it('only from near the net: off a pass further out the dump is off', () => {
    const c = new SetterCalls();
    c.frontRow = true;
    expect(dumpOption(c, setter(2.5), ENV.netTop)).toBeNull();
  });
});

// ------------------------------------------------------------------ the set through the real contact system
class FakeBall {
  state: BallState = makeBall();
  predictor = new BallPredictor(DT, SIM.predictHorizon);
  version = 0;
  private pv = -1;
  lastTouch: unknown = null;
  active = true;
  get pos() {
    return this.state.p;
  }
  get vel() {
    return this.state.v;
  }
  speed() {
    const v = this.state.v;
    return Math.hypot(v.x, v.y, v.z);
  }
  ensurePrediction(env: { netTop: number }, t: number) {
    if (this.pv !== this.version) {
      this.predictor.compute(this.state, env, t);
      this.pv = this.version;
    }
    return this.predictor;
  }
  hit(v: { x: number; y: number; z: number }, w: { x: number; y: number; z: number }) {
    Object.assign(this.state.v, v);
    Object.assign(this.state.w, w);
    this.version++;
  }
}

const OH_TARGET = { x: -4.05, y: 3.25, z: 0.9 };
const OPP_TARGET = { x: 4.0, y: 3.34, z: 0.9 };

/**
 * A pass dropping onto a home setter at their spot (the ball reaches the hands at T). RMB is
 * pressed at T + each of `presses` (default: at T, a clean catch); the release is `releaseAt` s
 * from the top of the bar (null: never), or `tapAt` s from T (a release before the catch).
 * `key` picks the hitter, `lookAt` is where the camera looks; `runFor` keeps the setter
 * shuffling until that long before T. Returns the set, where it came down at the hitter's
 * contact height, the press's action, and what the bar showed 0.2 s before the ball arrived (`pre`).
 */
function setRep(o: {
  presses?: number[];
  releaseAt?: number | null;
  tapAt?: number;
  key?: SetPick | null;
  /** the outside's set is this kind (its share of a high ball's green) instead of a high ball */
  window?: number;
  /** the setter is front row: the dump is an option (key 'DUMP') */
  dump?: boolean;
  lookAt?: 'OH' | 'OPP';
  runFor?: number;
  level?: SetLevel;
  seed?: number;
  /** the set ring and bar are off: you set by feel */
  byFeel?: boolean;
}) {
  const ball = new FakeBall();
  ball.lastTouch = { kind: 'pass', side: 1 };
  const events: ContactEvent[] = [];
  const rng = new Rng(o.seed ?? 3);
  const options: SetOption[] = [
    { target: OH_TARGET, apex: OH_TARGET.y + 1.65, hitter: null, label: 'OH High', key: 'OH', window: o.window },
    { target: OPP_TARGET, apex: OPP_TARGET.y + 1.55, hitter: null, label: 'OPP Back', key: 'OPP' },
  ];
  if (o.dump) {
    const calls = new SetterCalls();
    calls.frontRow = true;
    const s = new Athlete('S', 1);
    s.place(SETTER_SPOT.x, SETTER_SPOT.z, Math.PI / 2);
    options.push(dumpOption(calls, s, ENV.netTop)!);
  }
  const host = {
    ball: ball as unknown as ContactHost['ball'],
    simTime: 0,
    env: ENV,
    aimAssist: () => 0,
    aimTargetFor: (_a: Athlete, out: THREE.Vector3) => out,
    emitContact: (e: ContactEvent) => events.push(e),
    rand: () => rng.next(),
    passTarget: () => ({ x: 1, y: 2.35, z: 0.9, apex: 4 }),
    setOptions: () => options,
    setPick: () => o.key ?? null,
    setLevel: () => o.level ?? 'easy',
    setByFeel: () => o.byFeel ?? false,
    canServe: () => false,
  } satisfies ContactHost;
  const cs = new ContactSystem(host);
  const a = new Athlete('S', 1);
  a.isUser = true;
  // facing the outside (-x), as a setter stands
  a.place(SETTER_SPOT.x, SETTER_SPOT.z, Math.PI / 2);
  const look = o.lookAt === 'OPP' ? OPP_TARGET : OH_TARGET;
  cs.userAimYaw = () => Math.atan2(-(look.x - a.pos.x), -(look.z - a.pos.z));
  // the pass: through the hands point, coming down
  const P = cs.handsPoint(a, new THREE.Vector3());
  const from = { x: -1, y: 0.85, z: 6.4 };
  const v = { x: 0, y: 0, z: 0 };
  const arc = solveApex(from, { x: P.x, y: P.y, z: P.z }, 4.4, { x: 0, y: 0, z: 0 }, v);
  Object.assign(ball.state.p, from);
  Object.assign(ball.state.v, v);
  ball.version++;
  const T = arc.T;
  const spot = cs.setSpot(a, { x: 0, y: 0, z: 0 });
  const land = { ...ball.ensurePrediction(ENV, 0).land };
  const presses = (o.presses ?? [0]).map((p) => T + p);
  let set: ContactEvent | null = null;
  let setT = -1;
  let landed: THREE.Vector3 | null = null;
  let apex = 0;
  let pressAct: ReturnType<Athlete['startAction']> | null = null;
  let pre: SetPreview | null = null;
  let crossY = -1;
  for (let i = 0; i < SIM.hz * 5; i++) {
    host.simTime += DT;
    const t = host.simTime;
    // shuffle on the spot (a few cm each way) until `runFor` before the ball arrives
    const running = o.runFor !== undefined && t < T - o.runFor;
    a.cmd = { moveX: running ? 0.5 * Math.sign(Math.sin(t * 12)) : 0, moveZ: 0, sprint: false, faceYaw: Math.PI / 2 };
    a.step(DT, t);
    if (!pre && t >= T - 0.2) pre = cs.setPreview(a);
    while (presses.length && t >= presses[0]) {
      // a press lands on the frame's time (exactly when asked, here)
      cs.pressSet(a, presses.shift()!);
      pressAct ??= a.action;
    }
    const act = a.action;
    if (act && act.kind === 'set' && act.held) {
      // the release, stamped at the exact moment asked for
      const rel =
        o.tapAt !== undefined
          ? T + o.tapAt
          : act.absorbing && o.releaseAt !== null
            ? act.arriveT + TIMING.setLoad + (o.releaseAt ?? 0)
            : Infinity;
      if (t >= rel) {
        act.held = false;
        act.releaseT = rel;
      }
    }
    if (act && !act.resolved && act.kind === 'set') cs.trySet(a, act);
    if (!set && events.length) {
      set = events[0];
      setT = t;
    }
    const zBefore = ball.state.p.z;
    stepBall(ball.state, DT, ENV);
    if (set && crossY < 0 && zBefore > 0 && ball.state.p.z <= 0) crossY = ball.state.p.y;
    if (set) {
      apex = Math.max(apex, ball.state.p.y);
      // down to the hitter's contact height (a dump: down to their floor; a lift: no set went, to the floor)
      const downTo = cs.lastSet?.target.y ?? 0;
      if ((ball.state.v.y < 0 && ball.state.p.y <= downTo) || ball.state.p.y <= BALL.radius + 0.03) {
        landed = new THREE.Vector3(ball.state.p.x, ball.state.p.y, ball.state.p.z);
        break;
      }
    }
  }
  return {
    set: set as ContactEvent,
    setT,
    landed: landed as THREE.Vector3,
    apex,
    picked: cs.lastSet,
    result: cs.lastSetResult,
    act: pressAct,
    pre,
    crossY,
    lastTouch: ball.lastTouch as { kind: string } | null,
    T,
    P,
    spot,
    land,
  };
}

describe('the timed set (real contact system)', () => {
  it('a clean catch and a release at the top of the bar is a green that lands on the spot', () => {
    const r = setRep({ key: 'OH' });
    expect(r.set.grade).toBe('Perfect');
    expect(r.result?.green).toBe(true);
    expect(r.set.note.startsWith('Green')).toBe(true);
    expect(Math.hypot(r.landed.x - OH_TARGET.x, r.landed.z - OH_TARGET.z)).toBeLessThan(0.2);
  });
  it('the ball sits in the hands while the bar fills: the set leaves setLoad after the ball reaches them', () => {
    const r = setRep({ key: 'OH' });
    expect(r.setT - r.T).toBeGreaterThan(TIMING.setLoad - 2 * DT);
    expect(r.setT - r.T).toBeLessThan(TIMING.setLoad + 2 * DT);
  });
  it('one press per ball: pressing again does not restart the catch', () => {
    const once = setRep({ key: 'OH', presses: [-0.6], level: 'normal' });
    const spam = setRep({ key: 'OH', presses: [-0.6, -0.4, -0.2, -0.1, 0, 0.02], level: 'normal' });
    expect(spam.act?.t0).toBeCloseTo(spam.T - 0.6, 6);
    expect(spam.act?.catchErr).toBeLessThan(-0.55);
    expect(spam.result?.window).toBe(once.result?.window);
    expect(spam.result!.window).toBeLessThan(setRep({ key: 'OH', level: 'normal' }).result!.window);
  });
  it('spamming RMB cannot find the green: a tap releases before the catch, a push far too early', () => {
    const r = setRep({ key: 'OH', presses: [-0.3, -0.2, -0.1, 0], tapAt: -0.25 });
    expect(r.set.grade).toBe('Early');
    expect(r.result!.err).toBeLessThan(-TIMING.setLoad);
  });
  it('a catch well before the ball arrives shrinks the green; a clean one does not', () => {
    const clean = setRep({ key: 'OH', level: 'normal' });
    const early = setRep({ key: 'OH', presses: [-0.4], level: 'normal' });
    expect(early.result!.window).toBeLessThan(clean.result!.window);
    // on Easy the same early hands are a clean catch
    expect(setRep({ key: 'OH', presses: [-0.4] }).result!.window).toBeCloseTo(setRep({ key: 'OH' }).result!.window, 4);
  });
  it('pressed late, with the ball still at the chin, it is a late catch; much later the ball has gone', () => {
    // the pass drops ~6.6 m/s through the hands: the reach is gone in ~70 ms
    const late = setRep({ key: 'OH', presses: [0.05], level: 'elite' });
    expect(late.set).not.toBeNull();
    expect(late.act!.catchErr).toBeGreaterThan(0.03);
    expect(late.result!.window).toBeLessThan(setRep({ key: 'OH', level: 'elite' }).result!.window);
    expect(setRep({ key: 'OH', presses: [0.15] }).set).toBeNull();
  });
  it('held on past the top of the bar it is a lift: no set goes, the ball drops at the setter', () => {
    const r = setRep({ releaseAt: null, key: 'OH' });
    expect(r.set.fault).toBe('lift');
    expect(r.set.grade).toBe('Miss');
    expect(r.picked).toBeNull();
    // the whole bar and then some in the hands
    expect(r.setT - r.T).toBeGreaterThan(TIMING.setLoad + TIMING.setHoldMax - 2 * DT);
    // nothing went anywhere: down at the setter's hands, never higher than where it was held
    expect(Math.hypot(r.landed.x - r.P.x, r.landed.z - r.P.z)).toBeLessThan(0.3);
    expect(r.apex).toBeLessThan(r.P.y + 0.1);
  });
  it('set by feel (no ring and bar), the same touch earns a 20% wider green: a release just outside the cued green is green', () => {
    expect(ASSIST.setByFeel).toBe(1.2);
    for (const level of SET_LEVEL_IDS) {
      const cued = setRep({ key: 'OH', level }).result!.window;
      const felt = setRep({ key: 'OH', level, byFeel: true }).result!.window;
      expect(felt, level).toBeCloseTo(cued * ASSIST.setByFeel, 6);
      const err = cued * 1.1;
      expect(setRep({ releaseAt: err, key: 'OH', level }).set.grade, level).toBe('Good');
      expect(setRep({ releaseAt: err, key: 'OH', level, byFeel: true }).set.grade, level).toBe('Perfect');
    }
  });
  it('a push just before the lift is still a set, a late one', () => {
    const r = setRep({ releaseAt: TIMING.setHoldMax - 0.01, key: 'OH' });
    expect(r.set.fault).toBeUndefined();
    expect(r.set.grade).toBe('Late');
  });
  it('setting by feel on Easy, a late good release is a good set, not a lift: the hold is wider too', () => {
    const r = setRep({ releaseAt: TIMING.setHoldMax + 0.005, key: 'OH', byFeel: true });
    expect(r.set.fault).toBeUndefined();
    expect(r.set.grade).toBe('Good');
    // the same release with the cues on is held too long
    expect(setRep({ releaseAt: TIMING.setHoldMax + 0.005, key: 'OH' }).set.fault).toBe('lift');
  });
  it('a late push goes flat and long; an early one comes up short', () => {
    const good = setRep({ key: 'OH' });
    // (on Normal: Easy's good band reaches almost to where the push goes by itself)
    const late = setRep({ releaseAt: 0.125, key: 'OH', level: 'normal' });
    const early = setRep({ releaseAt: -0.14, key: 'OH' });
    expect(late.set.grade).toBe('Late');
    expect(early.set.grade).toBe('Early');
    // along the set (towards -x): long = further out, short = nearer the setter
    expect(late.landed.x).toBeLessThan(OH_TARGET.x - 0.2);
    expect(early.landed.x).toBeGreaterThan(OH_TARGET.x + 0.2);
    expect(late.apex).toBeLessThan(good.apex);
  });
  it('a set picked with a key goes to that hitter wherever the camera looks', () => {
    const r = setRep({ key: 'OH', lookAt: 'OPP' });
    expect(r.picked?.key).toBe('OH');
    expect(r.landed.x).toBeLessThan(-3);
  });
  it('with no key the set goes to the outside, wherever the camera looks', () => {
    const r = setRep({ key: null, lookAt: 'OPP' });
    expect(r.picked?.key).toBe('OH');
    expect(r.landed.x).toBeLessThan(-3);
  });
  it('a pick that is off this ball (the quick off a bad pass) goes to the outside too', () => {
    const r = setRep({ key: 'MB', lookAt: 'OPP' });
    expect(r.picked?.key).toBe('OH');
  });
  it('setting on the move shrinks the window: a release green standing is only good when still shuffling', () => {
    const still = setRep({ key: 'OH' }).result!.window;
    const moving = setRep({ key: 'OH', runFor: 0.02 }).result!.window;
    expect(moving).toBeLessThan(still);
    const err = (still + moving) / 2;
    expect(setRep({ releaseAt: err, key: 'OH' }).set.grade).toBe('Perfect');
    expect(setRep({ releaseAt: err, key: 'OH', runFor: 0.02 }).set.grade).toBe('Good');
  });
  it('a fast set to the pin is harder: the same release is green on the high ball, only good on the go', () => {
    const high = setRep({ key: 'OH' }).result!.window;
    const go = setRep({ key: 'OH', window: W.tempo }).result!.window;
    expect(go).toBeCloseTo(high * W.tempo, 6);
    const err = (high + go) / 2;
    expect(setRep({ releaseAt: err, key: 'OH' }).set.grade).toBe('Perfect');
    expect(setRep({ releaseAt: err, key: 'OH', window: W.tempo }).set.grade).toBe('Good');
  });
  it('a high back set gets the whole green, like the outside high ball', () => {
    expect(setRep({ key: 'OPP' }).result!.window).toBe(setRep({ key: 'OH' }).result!.window);
  });
  it('every level has the same top of the bar: the same catch and release leave at the same moment', () => {
    const easyRep = setRep({ key: 'OH' });
    for (const level of SET_LEVEL_IDS) {
      const r = setRep({ key: 'OH', level });
      expect(r.setT).toBe(easyRep.setT);
      expect(r.result!.err).toBe(easyRep.result!.err);
      expect(r.set.grade).toBe('Perfect');
    }
  });
  it('the same release that is green on Easy is only good on Elite', () => {
    const elite = setRep({ key: 'OH', level: 'elite' }).result!.window;
    const err = elite * 1.3;
    expect(setRep({ releaseAt: err, key: 'OH' }).set.grade).toBe('Perfect');
    expect(setRep({ releaseAt: err, key: 'OH', level: 'elite' }).set.grade).toBe('Good');
  });
  it('a dump is not a set: timed the same, it goes over the net to their floor, and their defence reads a tip', () => {
    const r = setRep({ key: 'DUMP', dump: true });
    expect(r.set.kind).toBe('tip');
    expect(r.set.tip).toBe(true);
    expect(r.lastTouch?.kind).toBe('tip');
    expect(r.set.grade).toBe('Perfect');
    // a green one clears the tape and comes down short on their side, behind where a block stands
    expect(r.crossY).toBeGreaterThan(ENV.netTop + 0.105);
    expect(r.landed.z).toBeLessThan(-0.8);
    expect(r.landed.z).toBeGreaterThan(-3);
  });
  it('with no dump on, key 5 sends the ball to the outside like any pick that is off', () => {
    const r = setRep({ key: 'DUMP' });
    expect(r.picked?.key).toBe('OH');
    expect(r.set.kind).toBe('set');
  });
  it('the bar is there before the catch: it shows the set your pick makes and the window your touch has earned so far', () => {
    const r = setRep({ key: 'OPP' });
    expect(r.pre).not.toBeNull();
    expect(r.pre!.absorbing).toBe(false);
    expect(r.pre!.option?.key).toBe('OPP');
    // standing on the spot, the ball coming onto the hands: feet and centring are done, the catch is still to come
    expect(r.pre!.pips).toEqual({ feet: true, centre: true, catch: null });
    // with a clean catch the window the bar showed is the window the set was graded in
    expect(r.pre!.green).toBeCloseTo(r.result!.window, 3);
    expect(r.result!.pips).toEqual({ feet: true, centre: true, catch: true });
  });
  it('the green on the bar grows as the feet stop: still shuffling it is smaller and the feet pip is not lit', () => {
    const still = setRep({ key: 'OH' }).pre!;
    const moving = setRep({ key: 'OH', runFor: 0.02 }).pre!;
    expect(moving.pips.feet).toBe(false);
    expect(still.pips.feet).toBe(true);
    expect(moving.green).toBeLessThan(still.green);
  });
  it('a late catch shows on the bar after the set: the catch pip is missed', () => {
    const late = setRep({ key: 'OH', presses: [0.05], level: 'elite' });
    expect(late.result!.pips.catch).toBe(false);
    expect(late.result!.pips.feet).toBe(true);
  });
  it('where to stand: the spot puts the ball onto your hands, not where it would land', () => {
    const r = setRep({ key: 'OH' });
    expect(r.spot).not.toBeNull();
    // the setter stands at their spot and the pass comes down through their hands point
    expect(Math.hypot(r.spot!.x - SETTER_SPOT.x, r.spot!.z - SETTER_SPOT.z)).toBeLessThan(0.03);
    expect(Math.hypot(r.land.x - r.spot!.x, r.land.z - r.spot!.z)).toBeGreaterThan(0.3);
  });
});
