import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { AI, ASSIST, COURT, SET_LEVEL_IDS, SET_LEVELS, SIM, TIMING, type SetLevel } from '../src/config';
import { Rng } from '../src/core/mathx';
import { Athlete } from '../src/game/athlete';
import { ContactSystem, type ContactEvent, type ContactHost, type SetOption } from '../src/game/contact';
import { SETTER_SPOT, SET_PLAYS } from '../src/game/plays';
import { SetterCalls, type SetterKey } from '../src/game/setterCalls';
import { catchQuality, gradeRelease, setMiss, setShape, setTouch, setWindow, type SetShape } from '../src/game/setTiming';
import { makeBall, stepBall, type BallState } from '../src/physics/ball';
import { BallPredictor } from '../src/physics/predict';
import { solveApex } from '../src/physics/solve';

const DT = 1 / SIM.hz;
const ENV = { netTop: COURT.netHeightMen };

/** a short front set from the setter's spot, standing, in system */
const easy: SetShape = { back: false, fast: false, length: 2.5, outOfSystem: false };
const win = (stillT: number, catchErr: number, centreD = 0, shape = easy, level: SetLevel = 'easy') =>
  setWindow(setTouch(stillT, catchErr, centreD, 0.48, shape, level), level);

describe('the set window: your touch and the level set its size', () => {
  it('a release at the top of the bar is green; a whole good window early or late is not', () => {
    const w = win(1, 0);
    expect(gradeRelease(0, w).grade).toBe('Perfect');
    expect(gradeRelease(-w.good * 1.01, w).grade).toBe('Early');
    expect(gradeRelease(w.good * 1.01, w).grade).toBe('Late');
  });
  it('Easy starts forgiving: the best touch gets ±15 ms of game time (±60 ms on screen), good three times that', () => {
    const w = win(1, 0);
    expect(w.green).toBeCloseTo(0.015, 5);
    expect(w.green / ASSIST.setSlowmoLoad).toBeCloseTo(0.06, 5);
    expect(w.good).toBeCloseTo(0.045, 5);
    expect(gradeRelease(0.014, w).grade).toBe('Perfect');
    expect(gradeRelease(-0.03, w).grade).toBe('Good');
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
    // on screen Elite's best green is about ±12 ms
    expect(SET_LEVELS.elite.green[0] / ASSIST.setSlowmoLoad).toBeLessThan(0.013);
  });
  it('a clean catch costs nothing; a catch early or late shrinks the window', () => {
    const clean = SET_LEVELS.easy.catch;
    expect(catchQuality(clean * 0.9, 'easy')).toBe(1);
    expect(catchQuality(-clean * 0.9, 'easy')).toBe(1);
    expect(win(1, -0.3).green).toBeLessThan(win(1, 0).green);
    expect(win(1, 0.12).green).toBeLessThan(win(1, 0).green);
    expect(setTouch(1, -0.3, 0, 0.48, easy, 'easy').reasons).toContain('caught early');
    expect(setTouch(1, 0.12, 0, 0.48, easy, 'easy').reasons).toContain('caught late');
  });
  it('a setter still running at the touch gets a smaller window than one who beat the ball to the spot', () => {
    expect(win(0, 0).green).toBeLessThan(win(TIMING.setFeetReady, 0).green);
    expect(setTouch(0, 0, 0, 0.48, easy, 'easy').reasons).toContain('on the move');
  });
  it('a ball off to one side of the hands shrinks the window', () => {
    expect(win(1, 0, 0.4).green).toBeLessThan(win(1, 0, 0.1).green);
  });
  it('from the same touch, a back set and a long set get a smaller window than a short front set', () => {
    expect(win(1, 0, 0, { ...easy, back: true }).green).toBeLessThan(win(1, 0).green);
    expect(win(1, 0, 0, { ...easy, length: 6 }).green).toBeLessThan(win(1, 0).green);
  });
  it("a fast tempo and a pass off the net shrink it too, and it never goes below the level's worst", () => {
    expect(win(1, 0, 0, { ...easy, fast: true }).green).toBeLessThan(win(1, 0).green);
    expect(win(1, 0, 0, { ...easy, outOfSystem: true }).green).toBeLessThan(win(1, 0).green);
    const hard: SetShape = { back: true, fast: true, length: 9, outOfSystem: true };
    for (const id of SET_LEVEL_IDS) expect(win(0, -1, 1, hard, id).green).toBe(SET_LEVELS[id].green[1]);
  });
  it('a back set is one that goes behind the setter, for either side', () => {
    const from = { x: 1, y: 2.1, z: 0.8 };
    expect(setShape(SETTER_SPOT, from, { x: 4, y: 3.3, z: 0.9 }, 1, false).back).toBe(true);
    expect(setShape(SETTER_SPOT, from, { x: -4, y: 3.3, z: 0.9 }, 1, false).back).toBe(false);
    const away = { x: -1, y: 2.1, z: -0.8 };
    expect(setShape({ x: -1.1, z: -0.65 }, away, { x: -4, y: 3.3, z: -0.9 }, -1, false).back).toBe(true);
  });
  it('a pass the setter takes far from their spot is out of system', () => {
    const from = { x: 1, y: 2.1, z: 3 };
    expect(setShape({ x: 1, z: 3 }, from, { x: -4, y: 3.3, z: 0.9 }, 1, false).outOfSystem).toBe(true);
    expect(AI.outOfSystem).toBeLessThan(3 - SETTER_SPOT.z);
  });
  it('early comes up short, late goes flat and long, and a green has the least spread', () => {
    const w = win(1, 0);
    const early = setMiss(gradeRelease(-0.1, w));
    const late = setMiss(gradeRelease(0.1, w));
    expect(early.shift).toBeLessThan(0);
    expect(late.shift).toBeGreaterThan(0);
    expect(late.apexDrop).toBeGreaterThan(0);
    expect(setMiss(gradeRelease(0, w)).spread).toBeLessThan(setMiss(gradeRelease(0.03, w)).spread);
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

describe('picking the hitter (1-4) and the call sheet (C)', () => {
  it('a key picks a hitter; the same key again asks them for a high ball (again: back to the call)', () => {
    const c = new SetterCalls();
    c.press('OH');
    expect(c.pick).toBe('OH');
    expect(c.label('OH')).toBe(SET_PLAYS.OH![0].short);
    c.press('OH');
    expect(c.isHigh('OH')).toBe(true);
    expect(c.label('OH')).toBe('High');
    c.press('OH');
    expect(c.isHigh('OH')).toBe(false);
  });
  it('with the call sheet open the keys change calls, not the pick; leave it alone and every call stays', () => {
    const c = new SetterCalls();
    c.press('OPP');
    expect(c.play('MB').short).toBe(SET_PLAYS.MB![0].short);
    c.toggleSheet();
    c.press('MB');
    c.press('OH');
    expect(c.pick).toBe('OPP');
    expect(c.play('MB').short).toBe('Shoot');
    expect(c.play('OH').short).toBe('Go');
    expect(c.play('OPP').short).toBe(SET_PLAYS.OPP![0].short);
  });
  it('the pass closes the sheet and locks the calls: the hitters are already running them', () => {
    const c = new SetterCalls();
    c.toggleSheet();
    c.lock();
    expect(c.editing).toBe(false);
    c.toggleSheet();
    expect(c.editing).toBe(false);
    c.press('OH');
    expect(c.pick).toBe('OH');
    expect(c.play('OH').short).toBe(SET_PLAYS.OH![0].short);
  });
  it('the calls stay for the next ball; the pick and a high ball do not', () => {
    const c = new SetterCalls();
    c.toggleSheet();
    c.press('OH');
    c.toggleSheet();
    c.press('OH');
    c.press('OH');
    c.lock();
    c.nextBall();
    expect(c.pick).toBeNull();
    expect(c.locked).toBe(false);
    expect(c.isHigh('OH')).toBe(false);
    expect(c.play('OH').short).toBe('Go');
  });
  it('the keys go through the input: C the sheet, Digit1 outside ... Digit4 pipe', () => {
    const c = new SetterCalls();
    const pressed = new Set(['Digit4']);
    c.readKeys({ consumePress: (code: string) => pressed.delete(code) });
    expect(c.pick).toBe<SetterKey>('PIPE');
    const sheet = new Set(['KeyC']);
    c.readKeys({ consumePress: (code: string) => sheet.delete(code) });
    expect(c.editing).toBe(true);
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
 * contact height, and the press's action.
 */
function setRep(o: {
  presses?: number[];
  releaseAt?: number | null;
  tapAt?: number;
  key?: SetterKey | null;
  lookAt?: 'OH' | 'OPP';
  runFor?: number;
  level?: SetLevel;
  seed?: number;
}) {
  const ball = new FakeBall();
  ball.lastTouch = { kind: 'pass' };
  const events: ContactEvent[] = [];
  const rng = new Rng(o.seed ?? 3);
  const options: SetOption[] = [
    { target: OH_TARGET, apex: OH_TARGET.y + 1.65, hitter: null, label: 'OH High', key: 'OH' },
    { target: OPP_TARGET, apex: OPP_TARGET.y + 1.55, hitter: null, label: 'OPP Back', key: 'OPP' },
  ];
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
  for (let i = 0; i < SIM.hz * 5; i++) {
    host.simTime += DT;
    const t = host.simTime;
    // shuffle on the spot (a few cm each way) until `runFor` before the ball arrives
    const running = o.runFor !== undefined && t < T - o.runFor;
    a.cmd = { moveX: running ? 0.5 * Math.sign(Math.sin(t * 12)) : 0, moveZ: 0, sprint: false, faceYaw: Math.PI / 2 };
    a.step(DT, t);
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
    stepBall(ball.state, DT, ENV);
    if (set) {
      apex = Math.max(apex, ball.state.p.y);
      const target = cs.lastSet!.target;
      if (ball.state.v.y < 0 && ball.state.p.y <= target.y) {
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
    const once = setRep({ key: 'OH', presses: [-0.6] });
    const spam = setRep({ key: 'OH', presses: [-0.6, -0.4, -0.2, -0.1, 0, 0.02] });
    expect(spam.act?.t0).toBeCloseTo(spam.T - 0.6, 6);
    expect(spam.act?.catchErr).toBeLessThan(-0.55);
    expect(spam.result?.window).toBe(once.result?.window);
    expect(spam.result!.window).toBeLessThan(setRep({ key: 'OH' }).result!.window);
  });
  it('spamming RMB cannot find the green: a tap releases before the catch, a push far too early', () => {
    const r = setRep({ key: 'OH', presses: [-0.3, -0.2, -0.1, 0], tapAt: -0.25 });
    expect(r.set.grade).toBe('Early');
    expect(r.result!.err).toBeLessThan(-TIMING.setLoad);
  });
  it('a catch well before the ball arrives shrinks the green; a clean one does not', () => {
    const clean = setRep({ key: 'OH' });
    const early = setRep({ key: 'OH', presses: [-0.4] });
    expect(early.result!.window).toBeLessThan(clean.result!.window);
  });
  it('pressed late, with the ball still at the chin, it is a late catch; much later the ball has gone', () => {
    // the pass drops ~6.6 m/s through the hands: the reach is gone in ~70 ms
    const late = setRep({ key: 'OH', presses: [0.05], level: 'elite' });
    expect(late.set).not.toBeNull();
    expect(late.act!.catchErr).toBeGreaterThan(0.03);
    expect(late.result!.window).toBeLessThan(setRep({ key: 'OH', level: 'elite' }).result!.window);
    expect(setRep({ key: 'OH', presses: [0.15] }).set).toBeNull();
  });
  it('held past the top of the bar it goes anyway, late', () => {
    expect(setRep({ releaseAt: null, key: 'OH' }).set.grade).toBe('Late');
  });
  it('a late push goes flat and long; an early one comes up short', () => {
    const good = setRep({ key: 'OH' });
    const late = setRep({ releaseAt: 0.09, key: 'OH' });
    const early = setRep({ releaseAt: -0.12, key: 'OH' });
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
  it('with no key the set goes to the hitter you look at', () => {
    const r = setRep({ key: null, lookAt: 'OPP' });
    expect(r.picked?.key).toBe('OPP');
    expect(r.landed.x).toBeGreaterThan(3);
  });
  it('setting on the move shrinks the window: a release green standing is only good when still shuffling', () => {
    const still = setRep({ key: 'OH' }).result!.window;
    const moving = setRep({ key: 'OH', runFor: 0.02 }).result!.window;
    expect(moving).toBeLessThan(still);
    const err = (still + moving) / 2;
    expect(setRep({ releaseAt: err, key: 'OH' }).set.grade).toBe('Perfect');
    expect(setRep({ releaseAt: err, key: 'OH', runFor: 0.02 }).set.grade).toBe('Good');
  });
  it('the back set is harder: the same release is green to the outside, not behind you', () => {
    const front = setRep({ key: 'OH' }).result!.window;
    const back = setRep({ key: 'OPP' }).result!.window;
    expect(back).toBeLessThan(front);
    const err = (front + back) / 2;
    expect(setRep({ releaseAt: err, key: 'OH' }).set.grade).toBe('Perfect');
    expect(setRep({ releaseAt: err, key: 'OPP' }).set.grade).toBe('Good');
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
  it('where to stand: the spot puts the ball onto your hands, not where it would land', () => {
    const r = setRep({ key: 'OH' });
    expect(r.spot).not.toBeNull();
    // the setter stands at their spot and the pass comes down through their hands point
    expect(Math.hypot(r.spot!.x - SETTER_SPOT.x, r.spot!.z - SETTER_SPOT.z)).toBeLessThan(0.03);
    expect(Math.hypot(r.land.x - r.spot!.x, r.land.z - r.spot!.z)).toBeGreaterThan(0.3);
  });
});
